/**
 * ink.js — stylus capture and stroke rendering.
 *
 * The device matrix this has to survive:
 *   iPad + Apple Pencil    pointerType 'pen', real pressure, palm arrives as 'touch'
 *   Surface + Slim Pen     pointerType 'pen', real pressure, has a barrel button
 *   Any laptop + trackpad  pointerType 'mouse', pressure is a constant 0.5
 *   Finger on a phone      pointerType 'touch', pressure 0 or 1, must still scroll
 *
 * Three rules keep those from fighting each other:
 *   1. A pen always draws, whatever mode the toolbar is in. Nobody picks up a stylus
 *      to scroll.
 *   2. Touch never draws. It scrolls, always. Ink mode doesn't change this, which is
 *      what makes palm rejection fall out for free — the palm is a touch.
 *   3. Mouse draws only in ink mode, because a mouse is also how you select text.
 */

import { toPage, simplify, smoothPath, quantize } from './geometry.js';

const MIN_WIDTH = 0.0008; // fraction of page width
const MAX_WIDTH = 0.0042;

export function strokeWidthFor(pressure, base) {
  // Pressure-to-width is deliberately not linear. Light contact should still leave a
  // visible line, so the curve is steep at the bottom and flattens out under pressure.
  const p = Math.max(0, Math.min(1, pressure || 0.5));
  const eased = Math.pow(p, 0.6);
  return (MIN_WIDTH + (MAX_WIDTH - MIN_WIDTH) * eased) * base;
}

export function shouldDraw(event, inkMode) {
  if (event.pointerType === 'pen') return true;
  if (event.pointerType === 'touch') return false;
  return inkMode; // mouse
}

/**
 * Attach ink capture to one page's canvas.
 *
 * `getState()` returns {inkMode, color, docId, userId} fresh on every event, so the
 * toolbar can change under a page without re-binding listeners.
 */
export function attachInk(canvas, pageNumber, getState, onCommit) {
  let active = null;

  canvas.addEventListener('pointerdown', (e) => {
    const state = getState();
    if (!shouldDraw(e, state.inkMode)) return;
    // The barrel button turns the pen into an eraser on hardware that reports it.
    if (e.button === 5 || e.buttons === 32) return;

    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const pt = toPage(e.clientX, e.clientY, rect);
    active = {
      pointerId: e.pointerId,
      color: state.color,
      points: [[pt.x, pt.y, e.pressure || 0.5]],
    };
    // Only steal touch-action while a stroke is actually in flight. Leaving it off
    // permanently kills scrolling on the page underneath.
    canvas.style.touchAction = 'none';
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== active.pointerId) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();

    // Pointer events are throttled to the frame rate; the pen samples far faster than
    // that. Coalesced events recover the samples the browser batched up, which is the
    // difference between a smooth curve and a polygon on fast strokes.
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const pt = toPage(ev.clientX, ev.clientY, rect);
      active.points.push([pt.x, pt.y, ev.pressure || 0.5]);
    }
    drawLive(canvas, active);
  });

  const finish = (e) => {
    if (!active || e.pointerId !== active.pointerId) return;
    canvas.style.touchAction = '';
    const points = simplify(active.points).map(([x, y, p]) => [
      quantize(x),
      quantize(y),
      Math.round(p * 100) / 100,
    ]);
    const stroke = { color: active.color, points };
    active = null;
    // A dot is a legitimate mark; a stray single-sample event from a resting palm is
    // not. One point with no movement gets dropped.
    if (points.length >= 2) onCommit(pageNumber, stroke);
    else redraw(canvas, canvas._strokes ?? []);
  };

  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('pointerleave', finish);
}

function drawLive(canvas, active) {
  redraw(canvas, canvas._strokes ?? []);
  const ctx = canvas.getContext('2d');
  paintStroke(ctx, canvas, { color: active.color, points: active.points });
}

/** Repaint every committed stroke on this page. Called on load, resize, and zoom. */
export function redraw(canvas, strokes) {
  canvas._strokes = strokes;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const s of strokes) paintStroke(ctx, canvas, s);
}

function paintStroke(ctx, canvas, stroke) {
  const pts = stroke.points;
  if (!pts || pts.length < 2) return;

  const w = canvas.width;
  const h = canvas.height;
  const X = (p) => p[0] * w;
  const Y = (p) => p[1] * h;

  ctx.strokeStyle = stroke.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const segments = smoothPath(pts);
  // Each segment is stroked separately so width can track pressure along the line.
  // One path with one lineWidth would flatten the whole stroke to a constant weight.
  let prev = pts[0];
  for (const seg of segments) {
    ctx.beginPath();
    ctx.moveTo(X(prev), Y(prev));
    ctx.bezierCurveTo(
      seg.c1[0] * w, seg.c1[1] * h,
      seg.c2[0] * w, seg.c2[1] * h,
      seg.to[0] * w, seg.to[1] * h
    );
    ctx.lineWidth = Math.max(1, strokeWidthFor(seg.pressure, w));
    ctx.stroke();
    prev = seg.to;
  }
}

/** Distance from a point to a stroke, for eraser hit-testing. Normalized units. */
export function distanceToStroke(pt, stroke) {
  let min = Infinity;
  const p = stroke.points;
  for (let i = 0; i < p.length - 1; i++) {
    min = Math.min(min, distToSegment(pt, p[i], p[i + 1]));
  }
  return min;
}

function distToSegment(pt, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(pt.x - a[0], pt.y - a[1]);
  let t = ((pt.x - a[0]) * dx + (pt.y - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(pt.x - (a[0] + t * dx), pt.y - (a[1] + t * dy));
}
