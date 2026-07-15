/**
 * anchors.js — turn a live DOM Selection over the pdf.js text layer into something
 * storable, and describe it well enough to survive a re-render at any zoom.
 *
 * Two anchors are produced for every highlight:
 *   rects      — normalized line rects. What we actually draw.
 *   textAnchor — {itemStart, offsetStart, itemEnd, offsetEnd} into the page's text
 *                content, plus the quoted string. Not needed to render, but it makes
 *                the annotation searchable, exportable, and repairable if the PDF is
 *                ever replaced with a different scan of the same book.
 */

import { rectToPage, mergeLineRects, quantize } from './geometry.js';

/**
 * Read the current selection, if it lies inside exactly one page's text layer.
 * Returns null for collapsed selections, selections outside a page, and selections
 * that span two pages (which we reject rather than half-handle).
 */
export function readSelection(root) {
  const sel = root.getSelection ? root.getSelection() : window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  const startPage = closestPage(range.startContainer);
  const endPage = closestPage(range.endContainer);
  if (!startPage || !endPage) return null;
  if (startPage !== endPage) return { crossPage: true };

  const pageEl = startPage;
  const pageRect = pageEl.getBoundingClientRect();

  const raw = Array.from(range.getClientRects())
    .map((r) => rectToPage(r, pageRect))
    // Empty spans and collapsed runs produce degenerate rects. Drop them before merging
    // or a single stray zero-height rect drags a whole line's bounding box upward.
    .filter((r) => r.w > 0.0005 && r.h > 0.0005);

  const rects = mergeLineRects(raw).map((r) => ({
    x: quantize(r.x),
    y: quantize(r.y),
    w: quantize(r.w),
    h: quantize(r.h),
  }));
  if (!rects.length) return null;

  return {
    pageNumber: Number(pageEl.dataset.page),
    rects,
    text: normalizeText(sel.toString()),
    textAnchor: describeRange(range, pageEl),
    // Anchor the popover to the end of the selection, where the cursor lifted.
    caret: caretPoint(range, pageRect),
  };
}

function closestPage(node) {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return el?.closest?.('[data-page]') ?? null;
}

/**
 * pdf.js emits one <span> per text item, in reading order, each tagged with its index.
 * That gives a stable (itemIndex, charOffset) address into the page's text content.
 */
function describeRange(range, pageEl) {
  const spans = Array.from(pageEl.querySelectorAll('.text-layer span[data-idx]'));
  const startSpan = spanOf(range.startContainer, spans);
  const endSpan = spanOf(range.endContainer, spans);
  if (!startSpan || !endSpan) return null;
  return {
    itemStart: Number(startSpan.dataset.idx),
    offsetStart: range.startOffset,
    itemEnd: Number(endSpan.dataset.idx),
    offsetEnd: range.endOffset,
  };
}

function spanOf(node, spans) {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return spans.includes(el) ? el : el?.closest?.('span[data-idx]') ?? null;
}

function caretPoint(range, pageRect) {
  const rects = range.getClientRects();
  const last = rects[rects.length - 1];
  if (!last) return null;
  return {
    x: (last.right - pageRect.left) / pageRect.width,
    y: (last.bottom - pageRect.top) / pageRect.height,
  };
}

/**
 * PDF text extraction is full of soft hyphens, ligatures, and line-break newlines.
 * Collapse them so the stored quote reads like the sentence a person selected.
 */
export function normalizeText(s) {
  return s
    .replace(/\u00AD/g, '')
    .replace(/-\n\s*/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Find which highlight, if any, sits under a click. Topmost (newest) wins. */
export function hitTest(annotations, pageNumber, pt, pad = 0.004) {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (a.pageNumber !== pageNumber || a.type !== 'highlight') continue;
    for (const r of a.rects) {
      if (
        pt.x >= r.x - pad && pt.x <= r.x + r.w + pad &&
        pt.y >= r.y - pad && pt.y <= r.y + r.h + pad
      ) {
        return a;
      }
    }
  }
  return null;
}
