/**
 * reader.js — pdf.js rendering, the four-layer page stack, virtualization, progress.
 *
 * Page stack, bottom to top:
 *   canvas.pdf        the rendered page
 *   div.hl-layer      highlight rects, mix-blend-mode: multiply
 *   div.text-layer    transparent text, the only thing that receives selection
 *   canvas.ink        everyone's strokes; pointer-events only while a pen is down
 *
 * All four are absolutely positioned at 0,0 and sized identically, so a normalized
 * coordinate means the same thing in every one of them.
 */

import { attachInk, redraw } from './ink.js';

const RENDER_MARGIN = 2; // pages either side of the viewport kept live

export class Reader {
  kind = 'pdf';

  constructor(container, pdfjsLib) {
    this.container = container;
    this.pdfjsLib = pdfjsLib;
    this.pdf = null;
    this.scale = 1.2;
    this.pages = []; // {num, el, size:{w,h}, rendered, task}
    this.onProgress = () => {};
    this.onSelectionChange = () => {};
    this.getInkState = () => ({ inkMode: false, color: '#000' });
    this.onInkCommit = () => {};
    this._progressTimer = null;
    this._restoring = false;
  }

  /**
   * `source` is whatever the store handed back: {data: ArrayBuffer} from a local
   * library, or {url} from remote storage. The url form matters — pdf.js issues HTTP
   * range requests against it, so a 400MB book streams the pages you're looking at
   * instead of downloading whole before the first render.
   */
  async load(source) {
    const opts = source.url
      ? { url: source.url, rangeChunkSize: 65536 }
      // pdf.js takes ownership of the buffer and detaches it, so hand over a copy or
      // the caller's bytes are dead the second time they open the same book.
      : { data: source.data.slice(0) };
    this.pdf = await this.pdfjsLib.getDocument(opts).promise;
    this.pageCount = this.pdf.numPages;

    // Sizing every page upfront means the scrollbar is honest immediately, but it
    // costs one getPage per page. Page 1's size is the right guess for ~99% of books;
    // each page corrects itself when it renders.
    const first = await this.pdf.getPage(1);
    const base = first.getViewport({ scale: 1 });
    this.defaultSize = { w: base.width, h: base.height };

    this.container.innerHTML = '';
    this.pages = [];
    for (let n = 1; n <= this.pageCount; n++) {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.page = String(n);
      const size = { ...this.defaultSize };
      el.style.width = size.w * this.scale + 'px';
      el.style.height = size.h * this.scale + 'px';
      el.innerHTML =
        '<canvas class="pdf"></canvas>' +
        '<div class="hl-layer"></div>' +
        '<div class="text-layer"></div>' +
        '<canvas class="ink"></canvas>' +
        '<div class="page-num">' + n + '</div>';
      this.container.appendChild(el);
      this.pages.push({ num: n, el, size, rendered: false, sized: n === 1 });

      attachInk(
        el.querySelector('canvas.ink'),
        n,
        () => this.getInkState(),
        (page, stroke) => this.onInkCommit(page, stroke)
      );
    }
    this.pages[0].size = { ...base, w: base.width, h: base.height };

    this._observe();
    this._bindScroll();
    await this._sync();
    return this.pageCount;
  }

  _observe() {
    this._io?.disconnect();
    this._io = new IntersectionObserver(
      () => this._sync(),
      { root: this.container.parentElement, rootMargin: '200% 0px' }
    );
    for (const p of this.pages) this._io.observe(p.el);
  }

  _bindScroll() {
    const scroller = this.container.parentElement;
    scroller.removeEventListener('scroll', this._onScroll);
    this._onScroll = () => {
      this._sync();
      if (this._restoring) return;
      clearTimeout(this._progressTimer);
      // Trailing debounce. Writing on every scroll event would be ~60 writes a
      // second; writing once when the reader settles is what "my place" means.
      this._progressTimer = setTimeout(() => this.onProgress(this.position()), 800);
    };
    scroller.addEventListener('scroll', this._onScroll, { passive: true });
  }

  /**
   * Tear down observers, listeners, and render tasks. Needed now that a session can
   * open a PDF, close it, and open an EPUB (or another PDF) without a page reload —
   * previously `load()` only ever ran once per page load, so nothing accumulated.
   */
  destroy() {
    this._io?.disconnect();
    this.container.parentElement?.removeEventListener('scroll', this._onScroll);
    clearTimeout(this._progressTimer);
    for (const p of this.pages) p.task?.cancel();
    this.container.innerHTML = '';
    this.pages = [];
  }

  /** Which page is at the top of the viewport, and how far into it are we? */
  position() {
    const scroller = this.container.parentElement;
    const top = scroller.getBoundingClientRect().top;
    for (const p of this.pages) {
      const r = p.el.getBoundingClientRect();
      if (r.bottom > top + 1) {
        const page = p.num;
        const yFrac = Math.max(0, Math.min(1, (top - r.top) / r.height));
        return { page, yFrac, percent: this.percentFor({ page }) };
      }
    }
    return { page: this.pageCount, yFrac: 0, percent: 1 };
  }

  /** Where a `{page}` (or a record that has one, like an annotation) sits in the book. */
  percentFor(locator) {
    const page = locator.page ?? locator.pageNumber ?? 1;
    return this.pageCount > 1 ? (page - 1) / (this.pageCount - 1) : 0;
  }

  /** `locator` is anything with `{page, yFrac}` — a progress row, an annotation, a position(). */
  async goTo(locator, smooth = false) {
    const { page, yFrac = 0 } = locator;
    const p = this.pages[Math.max(0, Math.min(this.pageCount, page) - 1)];
    if (!p) return;
    this._restoring = true;
    const scroller = this.container.parentElement;
    const target =
      p.el.offsetTop + yFrac * p.el.offsetHeight - this.container.offsetTop;
    scroller.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'auto' });
    await this._sync();
    // Let the smooth scroll settle before re-arming progress writes, or the restore
    // itself gets recorded as the reader's new position.
    setTimeout(() => (this._restoring = false), smooth ? 600 : 60);
  }

  async setScale(scale) {
    const pos = this.position();
    this.scale = Math.max(0.5, Math.min(3, scale));
    for (const p of this.pages) {
      p.el.style.width = p.size.w * this.scale + 'px';
      p.el.style.height = p.size.h * this.scale + 'px';
      p.rendered = false;
      p.task?.cancel();
      p.task = null;
    }
    await this._sync();
    await this.goTo(pos);
    this.renderAnnotations?.();
  }

  _visibleRange() {
    const scroller = this.container.parentElement;
    const vTop = scroller.scrollTop;
    const vBottom = vTop + scroller.clientHeight;
    let first = this.pageCount;
    let last = 1;
    for (const p of this.pages) {
      const top = p.el.offsetTop - this.container.offsetTop;
      const bottom = top + p.el.offsetHeight;
      if (bottom > vTop && top < vBottom) {
        first = Math.min(first, p.num);
        last = Math.max(last, p.num);
      }
    }
    if (first > last) return [1, 1];
    return [
      Math.max(1, first - RENDER_MARGIN),
      Math.min(this.pageCount, last + RENDER_MARGIN),
    ];
  }

  async _sync() {
    const [lo, hi] = this._visibleRange();
    const jobs = [];
    for (const p of this.pages) {
      const wanted = p.num >= lo && p.num <= hi;
      if (wanted && !p.rendered) jobs.push(this._renderPage(p));
      else if (!wanted && p.rendered) this._releasePage(p);
    }
    await Promise.all(jobs);
  }

  _releasePage(p) {
    // Canvases are the memory hog — a 900 page book at 1.2x is gigabytes if you keep
    // them all. Zero the size to actually free the backing store; the placeholder div
    // keeps its dimensions so the scrollbar doesn't jump.
    p.task?.cancel();
    p.task = null;
    const c = p.el.querySelector('canvas.pdf');
    c.width = c.height = 0;
    p.el.querySelector('.text-layer').innerHTML = '';
    p.rendered = false;
  }

  async _renderPage(p) {
    p.rendered = true;
    let page;
    try {
      page = await this.pdf.getPage(p.num);
    } catch {
      p.rendered = false;
      return;
    }

    const base = page.getViewport({ scale: 1 });
    if (!p.sized) {
      p.size = { w: base.width, h: base.height };
      p.sized = true;
      p.el.style.width = base.width * this.scale + 'px';
      p.el.style.height = base.height * this.scale + 'px';
    }

    const viewport = page.getViewport({ scale: this.scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = p.el.querySelector('canvas.pdf');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';

    const ink = p.el.querySelector('canvas.ink');
    ink.width = Math.floor(viewport.width * dpr);
    ink.height = Math.floor(viewport.height * dpr);
    ink.style.width = viewport.width + 'px';
    ink.style.height = viewport.height + 'px';

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    p.task = page.render({ canvasContext: ctx, viewport });
    try {
      await p.task.promise;
    } catch {
      return; // cancelled by a zoom or a fast scroll; nothing to clean up
    }

    await this._renderTextLayer(page, viewport, p.el.querySelector('.text-layer'));
    redraw(ink, ink._strokes ?? []);
    this.renderAnnotations?.(p.num);
  }

  /**
   * Hand-rolled text layer rather than pdf.js's TextLayer helper, for two reasons:
   * the helper's API has moved between majors, and we need a stable data-idx on every
   * span so anchors.js can address a selection by (item index, char offset).
   */
  async _renderTextLayer(page, viewport, layer) {
    const content = await page.getTextContent();
    layer.innerHTML = '';
    if (!content.items.length) {
      layer.dataset.empty = 'true';
      return;
    }
    delete layer.dataset.empty;

    const frag = document.createDocumentFragment();
    const measures = [];
    content.items.forEach((item, idx) => {
      if (!item.str) return;
      const tx = this.pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      const angle = Math.atan2(tx[1], tx[0]);

      const span = document.createElement('span');
      span.dataset.idx = String(idx);
      span.textContent = item.str;
      span.style.left = tx[4] + 'px';
      span.style.top = tx[5] - fontHeight + 'px';
      span.style.fontSize = fontHeight + 'px';
      span.style.fontFamily = content.styles[item.fontName]?.fontFamily ?? 'sans-serif';
      if (angle) span.style.transform = `rotate(${angle}rad)`;
      frag.appendChild(span);
      measures.push({ span, target: item.width * viewport.scale });
    });
    layer.appendChild(frag);

    // The browser's font is never the PDF's font, so every span is the wrong width.
    // Measure once, then scaleX each span onto its true width — otherwise selection
    // rects drift further from the glyphs the longer the line is.
    for (const m of measures) {
      const actual = m.span.getBoundingClientRect().width;
      if (actual > 0 && m.target > 0) {
        m.span.style.transform =
          (m.span.style.transform ? m.span.style.transform + ' ' : '') +
          `scaleX(${m.target / actual})`;
        m.span.style.transformOrigin = '0% 0%';
      }
    }
  }

  pageEl(n) {
    return this.pages[n - 1]?.el ?? null;
  }
}
