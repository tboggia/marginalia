/**
 * geometry.js — everything that converts between screen pixels and stored coordinates.
 *
 * The contract: stored coordinates are fractions of the unrotated page at scale 1,
 * origin top-left, both axes in [0,1]. Nothing else in the app is allowed to store
 * a pixel value. If a highlight ever drifts on zoom, the bug is in this file.
 */

/** Screen point -> normalized page point. `rect` is the page element's bounding box. */
export function toPage(clientX, clientY, rect) {
  return {
    x: (clientX - rect.left) / rect.width,
    y: (clientY - rect.top) / rect.height,
  };
}

/** Normalized page point -> pixel offset within the page element (not the viewport). */
export function toPixels(pt, rect) {
  return { x: pt.x * rect.width, y: pt.y * rect.height };
}

/** DOMRect (viewport space) -> normalized {x,y,w,h} within the page. */
export function rectToPage(r, pageRect) {
  return {
    x: (r.left - pageRect.left) / pageRect.width,
    y: (r.top - pageRect.top) / pageRect.height,
    w: r.width / pageRect.width,
    h: r.height / pageRect.height,
  };
}

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clampRect(r) {
  const x = clamp01(r.x);
  const y = clamp01(r.y);
  return { x, y, w: clamp01(r.x + r.w) - x, h: clamp01(r.y + r.h) - y };
}

/**
 * Merge the raw rects from Range.getClientRects() into one rect per line of text.
 *
 * getClientRects() returns a rect per text run, so a single highlighted sentence
 * comes back as a dozen slivers with hairline gaps between them. Rects belong to the
 * same line when their vertical centers are within half a line height of each other.
 */
export function mergeLineRects(rects, tolerance = 0.5) {
  const usable = rects.filter((r) => r.w > 0 && r.h > 0);
  if (!usable.length) return [];

  const lines = [];
  for (const r of usable) {
    const center = r.y + r.h / 2;
    const line = lines.find((l) => {
      const lCenter = l.y + l.h / 2;
      return Math.abs(lCenter - center) < Math.max(l.h, r.h) * tolerance;
    });
    if (line) {
      const right = Math.max(line.x + line.w, r.x + r.w);
      const bottom = Math.max(line.y + line.h, r.y + r.h);
      line.x = Math.min(line.x, r.x);
      line.y = Math.min(line.y, r.y);
      line.w = right - line.x;
      line.h = bottom - line.y;
    } else {
      lines.push({ ...r });
    }
  }
  return lines.sort((a, b) => a.y - b.y || a.x - b.x).map(clampRect);
}

/** Is a normalized point inside a normalized rect, with a little slop for fingers? */
export function hitRect(pt, r, pad = 0) {
  return (
    pt.x >= r.x - pad &&
    pt.x <= r.x + r.w + pad &&
    pt.y >= r.y - pad &&
    pt.y <= r.y + r.h + pad
  );
}

/**
 * Ramer–Douglas–Peucker. Points are [x, y, pressure] in normalized space.
 * Epsilon is in normalized units, so it scales with the page rather than the screen.
 * A 3s stroke drops from ~400 points to ~40 with no visible change.
 */
export function simplify(points, epsilon = 0.0015) {
  if (points.length < 3) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > epsilon && index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function perpendicularDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  // Cross product magnitude over segment length = distance to the infinite line.
  return Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / Math.sqrt(lenSq);
}

/**
 * Catmull-Rom through the sampled points, emitted as cubic beziers.
 * Simplification throws away points; this puts the curve back on render.
 */
export function smoothPath(pts) {
  if (pts.length < 2) return [];
  const segments = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    segments.push({
      c1: [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      c2: [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      to: [p2[0], p2[1]],
      pressure: p2[2] ?? 0.5,
    });
  }
  return segments;
}

/** Round-trip a fraction to a fixed precision. 5 decimals ≈ sub-pixel on a 4K page. */
export function quantize(n) {
  return Math.round(n * 1e5) / 1e5;
}
