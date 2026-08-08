/**
 * epub-reader.js — epub.js wrapper exposing close to the same surface as reader.js's
 * `Reader`, so app.js doesn't fork into two parallel code paths. Where PDF has a fixed
 * page rendered to a canvas, EPUB has none of that:
 *
 *   - Rendered scrolled/continuous (`flow: 'scrolled-doc'`, `manager: 'continuous'`),
 *     one iframe per spine item. epub.js's continuous manager mounts/unmounts nearby
 *     sections itself — there's no PDF-style virtualization to hand-roll here, and for
 *     a normal (tens-of-chapters) book there's no memory pressure that would demand it
 *     even if it didn't.
 *   - Position is a CFI, not a page. `percentFor`/`percent` (via `book.locations`, a
 *     one-time full-book character-index walk) is what the spine rail and "how far
 *     apart are we" actually read — see app.js's renderSpine.
 *   - Highlights anchor on a CFI. Rects for painting are resolved fresh from that CFI
 *     on every render (`rectsForCfi`), never stored: a chapter's laid-out geometry
 *     changes with font-size and viewport width in a way a PDF page's never does at a
 *     fixed zoom, so a stored rect would go stale.
 *   - No ink. See README "known gaps" — freehand strokes have no fixed geometry to stay
 *     anchored to on reflowable text, so `getInkState`/`onInkCommit` are simply never
 *     invoked; `attachInk` is never called.
 *
 * Known simplification: `book.locations.generate()` re-walks the whole book on every
 * open rather than caching `book.locations.save()` on the document record
 * (`documents.epub_locations` exists in schema.sql for exactly this, unused for now) —
 * fine for a book this size, worth revisiting if opening ever feels slow.
 */

import { readEpubSelection } from './epub-anchors.js';
import { SELECTION_SETTLE_MS } from './anchors.js';
import { rectToPage, mergeLineRects, quantize } from './geometry.js';

const READ_WIDTH = 760; // px — capped for readability, centered like a PDF page

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export class EpubReader {
  kind = 'epub';
  // "Zoom" here is font size, whose sane range is narrower than pixel zoom's.
  minScale = 0.7;
  maxScale = 2.2;

  constructor(container, ePub) {
    this.container = container;
    this.ePub = ePub;
    this.book = null;
    this.rendition = null;
    this.scale = 1;
    this.pages = []; // {num: spineIndex, el: <chapter's iframe body>} — mounted only
    this.pageCount = 0;
    this._contentsByIndex = new Map();
    this._currentCfi = null;
    this._selectionTimer = null;
    // The touch selection path's own debounce, and what opened the gesture it belongs
    // to. Held on the instance rather than per-chapter: only one selection can exist
    // across the whole book at a time, so a new one in another chapter should cancel
    // whatever the last one had pending.
    this._selectionSettleTimer = null;
    this._lastPointerType = 'mouse';
    this._restoring = false;
    this._progressTimer = null;

    this.onProgress = () => {};
    this.onSelectionChange = () => {};
    this.getInkState = () => ({ inkMode: false, color: '#000' });
    this.onInkCommit = () => {};
    this.renderAnnotations = null;
  }

  async load(source) {
    // Always hand epub.js bytes, never a URL. Unlike pdf.js there's no streaming to
    // gain — the whole archive must download before unzipping either way — and
    // epub.js's type-sniffing misreads a signed URL's `.epub?token=...` as an
    // *unpacked directory*, then starts requesting META-INF/container.xml and
    // friends as siblings of the signed path. Fetching ourselves sidesteps its URL
    // parsing entirely and makes hosted identical to the (verified) local path.
    let bytes;
    if (source.url) {
      const res = await fetch(source.url);
      if (!res.ok) throw new Error(`The book failed to download (${res.status}).`);
      bytes = await res.arrayBuffer();
    } else {
      bytes = source.data.slice(0);
    }
    this.book = this.ePub(bytes);
    await this.book.ready;
    this.pageCount = this.book.spine.length;

    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText =
      `width:min(${READ_WIDTH}px, 100%);margin:0 auto;background:#fff;` +
      `min-height:100%;box-shadow:0 1px 2px rgba(0,0,0,.5), 0 10px 34px rgba(0,0,0,.42);`;
    this.container.appendChild(wrap);

    const stylesheet = new URL('./highlight.css', import.meta.url).href;
    this.rendition = this.book.renderTo(wrap, {
      width: '100%',
      height: this.container.parentElement.clientHeight,
      flow: 'scrolled-doc',
      manager: 'continuous',
      stylesheet,
    });
    this.rendition.themes.fontSize(Math.round(this.scale * 100) + '%');
    this.rendition.hooks.content.register((contents) => this._onContent(contents));
    this.rendition.hooks.unloaded.register((view) => this._onUnloaded(view));
    this.rendition.on('relocated', (loc) => this._onRelocated(loc));

    this._onResize = debounce(() => this._reflow(), 300);
    window.addEventListener('resize', this._onResize);

    await this.book.locations.generate(1024);
    await this.rendition.display();

    // reportLocation() runs on its own queue; give it a moment to land before this
    // resolves, since app.js reads position() immediately after load() to seed a
    // first-open progress row.
    for (let i = 0; i < 20 && !this._currentCfi; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    return this.pageCount;
  }

  _onContent(contents) {
    const spineIndex = contents.sectionIndex;
    const doc = contents.document;

    doc.body.style.position = 'relative';
    let hl = doc.querySelector('.hl-layer');
    if (!hl) {
      hl = doc.createElement('div');
      hl.className = 'hl-layer';
      doc.body.appendChild(hl);
    }

    this._contentsByIndex.set(spineIndex, contents);
    const existing = this.pages.find((p) => p.num === spineIndex);
    if (existing) existing.el = doc.body;
    else this.pages.push({ num: spineIndex, el: doc.body });

    // Events inside the chapter iframe never reach the host document's listeners, so
    // popover dismissal (click-away, Escape) has to be replicated in here.
    doc.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'pen') return;
      clearTimeout(this._selectionTimer);
      this._selectionTimer = setTimeout(() => {
        const iframeEl = contents.window.frameElement;
        if (!iframeEl) return;
        const sel = readEpubSelection(contents, iframeEl, spineIndex);
        // On touch, a real selection belongs to the selectionchange path below, which
        // sees the final range rather than whatever the handles were around at lift-off.
        if (sel && e.pointerType === 'touch') return;
        // Null (a collapsed click) goes through on every pointer type: that's what tells
        // app.js the reader clicked away, and the popover closes just like it does over a
        // PDF. It stays on this path rather than the debounced one below because a tap
        // that dismisses something should not have to wait for a selection to settle —
        // and a tap inside this iframe never reaches app.js's own click-away listener.
        this.onSelectionChange(sel);
      }, 0);
    });

    /* The touch path, for the same reason app.js has one: a long press on text is
       claimed by the browser's own selection gesture, so the pointerup above never
       arrives and the handle-dragging that follows raises no pointer events here at
       all. selectionchange is what survives it, debounced to its trailing edge so the
       popover waits for the selection to settle rather than chasing every handle move.

       Bound to the chapter's own document because that is where the selection lives —
       a selection inside an iframe fires selectionchange on the iframe's document, not
       on the host page's, which is why app.js's listener can never see this one. */
    doc.addEventListener('pointerdown', (e) => {
      this._lastPointerType = e.pointerType;
    });
    doc.addEventListener('selectionchange', () => {
      if (this._lastPointerType !== 'touch') return;
      clearTimeout(this._selectionSettleTimer);
      this._selectionSettleTimer = setTimeout(() => {
        const iframeEl = contents.window.frameElement;
        if (!iframeEl) return;
        const sel = readEpubSelection(contents, iframeEl, spineIndex);
        // Only a real selection: dismissal is the pointerup path's job above, and it
        // does it without the debounce this one owes to the handles.
        if (sel) this.onSelectionChange(sel, { touch: true });
      }, SELECTION_SETTLE_MS);
    });

    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.onSelectionChange(null);
    });

    this.renderAnnotations?.(spineIndex);
  }

  _onUnloaded(view) {
    const idx = view?.section?.index;
    if (idx == null) return;
    this._contentsByIndex.delete(idx);
    this.pages = this.pages.filter((p) => p.num !== idx);
  }

  _onRelocated(loc) {
    this._currentCfi = loc.start.cfi;
    if (this._restoring) return;
    clearTimeout(this._progressTimer);
    // Same trailing-debounce shape as reader.js's scroll handler: write once the
    // reader settles, not on every intermediate relocation.
    this._progressTimer = setTimeout(() => this.onProgress(this.position()), 800);
  }

  async _reflow() {
    if (!this.rendition) return;
    this.rendition.resize('100%', this.container.parentElement.clientHeight);
    this.renderAnnotations?.();
  }

  /** Where the reader currently is: a cfi plus how far through the book that is. */
  position() {
    const cfi = this._currentCfi;
    return { cfi, percent: cfi ? this.percentFor({ cfi }) : 0 };
  }

  /**
   * Always null, and deliberately: EPUB has no page to be "already on."
   *
   * The honest unit here is a spine index, and a chapter is not a page — it can run
   * for thousands of words. Answering "same chapter" to a caller asking "am I already
   * looking at this?" would strand you at the top of a chapter with the highlight
   * still far below, which is worse than a redundant jump. So it declines to answer,
   * and callers (see app.js's margin panel) jump every time.
   */
  currentUnit() {
    return null;
  }

  /** Where a `{cfi}` (a progress row, an annotation, a position()) sits in the book. */
  percentFor(locator) {
    if (!locator.cfi || !this.book?.locations?.total) return 0;
    return this.book.locations.percentageFromCfi(locator.cfi);
  }

  async goTo(locator) {
    if (!locator?.cfi || !this.rendition) return;
    this._restoring = true;
    await this.rendition.display(locator.cfi);
    // Let the relocated event from this jump land and get ignored before re-arming
    // progress writes, or the restore itself gets recorded as new progress.
    setTimeout(() => (this._restoring = false), 300);
  }

  async setScale(n) {
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, n));
    this.rendition.themes.fontSize(Math.round(this.scale * 100) + '%');
    const cfi = this._currentCfi;
    if (cfi) await this.goTo({ cfi });
  }

  /**
   * The box a chapter's normalized rects are fractions of: the chapter <body>'s padding
   * box, because that is what `.hl-layer { position:absolute; inset:0 }` resolves
   * against once _onContent makes body the containing block. Not <html> — a chapter's
   * body margin (this book's stylesheet sets `body { margin-top: 1em }`) collapses out
   * to the root, so body sits ~30px below documentElement and is ~30px shorter.
   * Normalizing against one box and painting into the other slides every highlight down
   * by most of a line near the chapter top.
   */
  _frameRect(contents) {
    const body = contents.document.body;
    const r = body.getBoundingClientRect();
    return {
      left: r.left + body.clientLeft,
      top: r.top + body.clientTop,
      width: body.clientWidth,
      height: body.clientHeight,
    };
  }

  /** Live rects for a highlight's cfi, resolved against however this chapter is laid
   * out right now. Not cached — see the file header for why. */
  rectsForCfi(spineIndex, cfi) {
    const contents = this._contentsByIndex.get(spineIndex);
    if (!contents || !cfi) return [];
    let range;
    try {
      range = contents.range(cfi);
    } catch {
      return [];
    }
    if (!range) return [];

    const frame = this._frameRect(contents);
    const raw = Array.from(range.getClientRects())
      .map((r) => rectToPage(r, frame))
      .filter((r) => r.w > 0.0005 && r.h > 0.0005);
    return mergeLineRects(raw).map((r) => ({
      x: quantize(r.x),
      y: quantize(r.y),
      w: quantize(r.w),
      h: quantize(r.h),
    }));
  }

  pageEl(n) {
    return this.pages.find((p) => p.num === n)?.el ?? null;
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    clearTimeout(this._progressTimer);
    clearTimeout(this._selectionTimer);
    clearTimeout(this._selectionSettleTimer);
    this.rendition?.destroy();
    this.container.innerHTML = '';
    this.pages = [];
    this._contentsByIndex.clear();
  }
}
