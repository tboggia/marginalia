/**
 * epub-anchors.js — turn a live DOM Selection inside a rendered epub.js chapter into
 * something storable. EPUB's analog of anchors.js, with two things simpler and one
 * thing different:
 *
 *   - No cross-chapter rejection needed: each spine item is its own iframe/document,
 *     so a Selection can never span two of them the way it can span two PDF pages.
 *   - No per-page text-item index to address into (there is no fixed page), so instead
 *     of a textAnchor this produces a CFI (epub.js's own stable, reflow-proof anchor).
 *   - Rects aren't computed here at all. A chapter's layout changes with font-size and
 *     viewport width, so a rect computed at selection time would go stale the moment
 *     either changes — epub-reader.js resolves the cfi to a live Range and recomputes
 *     rects fresh on every render instead.
 */

import { normalizeText } from './anchors.js';

/**
 * `contents` is the epub.js Contents for one rendered spine item. `iframeEl` is that
 * section's host-page <iframe>, needed only to translate the caret into host-page
 * pixels for popover placement — a Selection read from inside an iframe reports
 * coordinates relative to the iframe's own viewport, not the host page's.
 */
export function readEpubSelection(contents, iframeEl, spineIndex) {
  const win = contents.window;
  const sel = win?.getSelection ? win.getSelection() : null;
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  const text = normalizeText(range.toString());
  if (!text) return null;

  const cfi = contents.cfiFromRange(range);
  if (!cfi) return null;

  const iframeRect = iframeEl.getBoundingClientRect();
  const rects = range.getClientRects();
  const last = rects[rects.length - 1];
  const client = last
    ? { x: iframeRect.left + last.right, y: iframeRect.top + last.bottom }
    : { x: iframeRect.left, y: iframeRect.top };

  return { spineIndex, cfi, text, client };
}
