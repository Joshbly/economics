// ============================================================================
// Daily rhythms of the map's little people and carts (pure, DOM-free, tested).
//
// The simulation works in whole days; the map animates the fraction of the
// day `ui.dayFrac` (0 = midnight, 0.5 = noon). Each walker has a timetable
// derived deterministically from its id, so the same person always leaves at
// the same minute and a crowd spreads out naturally:
//   worker     home → work  leave 0.24–0.30, arrive 0.33–0.38
//              work → home  leave 0.70–0.75, home by ~0.82
//   unemployed (about two in three) walk to the market square late morning,
//              idle there, and walk home early afternoon.
// Polylines along tile paths are sampled by arc length.
// ============================================================================
import {
  COMMUTE_ARRIVE,
  COMMUTE_BACK,
  COMMUTE_HOME_BY,
  COMMUTE_LEAVE,
  COMMUTE_MIN_WALK,
  STROLL_BACK,
  STROLL_OUT,
  STROLL_SHARE,
} from './constants';

/** Deterministic hash of (a, b) → [0, 1). */
export function hash01(a: number, b: number): number {
  let h = Math.imul((a | 0) ^ 0x3c6ef372, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Four times of a round trip: leave A, reach B, leave B, reach A (fractions of the day). */
export interface Trip {
  d0: number;
  a0: number;
  d1: number;
  a1: number;
}

/** Where a walker is at a moment of its trip. */
export const Leg = {
  AtA: 0, // at the origin (home) — not drawn
  Out: 1, // on the way A → B
  AtB: 2, // at the destination
  Back: 3, // on the way B → A
} as const;
export type Leg = (typeof Leg)[keyof typeof Leg];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Commute timetable of worker `id` whose path is `len` tiles long. Longer
 * commutes set out earlier (within the window) so arrivals stay in 0.33–0.38.
 */
export function commuteTrip(id: number, len: number, out?: Trip): Trip {
  const t = out ?? { d0: 0, a0: 0, d1: 0, a1: 0 };
  const h1 = hash01(id, 11);
  const h2 = hash01(id, 23);
  const h3 = hash01(id, 37);
  const L = Number.isFinite(len) && len > 0 ? len : 0;
  // Walking time grows with distance (so dots move at a plausible, similar pace).
  const walk = Math.min(0.14, Math.max(COMMUTE_MIN_WALK + 0.01, 0.035 + 0.004 * L));
  t.a0 = lerp(COMMUTE_ARRIVE[0], COMMUTE_ARRIVE[1], h2);
  // Leave early enough to arrive on time, but not before first light.
  t.d0 = Math.max(COMMUTE_LEAVE[0] - 0.05, t.a0 - walk);
  t.d1 = lerp(COMMUTE_BACK[0], COMMUTE_BACK[1], h3);
  t.a1 = Math.max(t.d1 + COMMUTE_MIN_WALK, Math.min(COMMUTE_HOME_BY, t.d1 + walk * (1 + 0.15 * h1)));
  return t;
}

/**
 * Midday stroll of an unemployed person to the market square, or null for the
 * third who stay in. (Deterministic by id, so the same people go every day.)
 */
export function strollTrip(id: number, len: number, out?: Trip): Trip | null {
  if (hash01(id, 5) >= STROLL_SHARE) return null;
  const t = out ?? { d0: 0, a0: 0, d1: 0, a1: 0 };
  const walk = Math.min(0.1, Math.max(COMMUTE_MIN_WALK, 0.02 + 0.005 * (Number.isFinite(len) ? len : 0)));
  t.d0 = lerp(STROLL_OUT[0], STROLL_OUT[1], hash01(id, 7));
  t.a0 = t.d0 + walk;
  t.d1 = Math.max(t.a0 + 0.02, lerp(STROLL_BACK[0], STROLL_BACK[1], hash01(id, 13)));
  t.a1 = t.d1 + walk;
  return t;
}

/** Small ease so walkers start and stop gently rather than teleporting to full speed. */
function ease(f: number): number {
  const e = 0.12;
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  // linear in the middle, quadratic ramps over the first/last e
  if (f < e) return (f * f) / (2 * e * (1 - e));
  if (f > 1 - e) return 1 - ((1 - f) * (1 - f)) / (2 * e * (1 - e));
  return (f - e / 2) / (1 - e);
}

/** Leg and progress (0..1 along the path from A to B) at day fraction `t`. */
export function tripAt(trip: Trip, t: number, out: { leg: Leg; f: number }): { leg: Leg; f: number } {
  if (t < trip.d0 || t >= trip.a1) {
    out.leg = Leg.AtA;
    out.f = 0;
  } else if (t < trip.a0) {
    out.leg = Leg.Out;
    out.f = ease((t - trip.d0) / Math.max(1e-6, trip.a0 - trip.d0));
  } else if (t < trip.d1) {
    out.leg = Leg.AtB;
    out.f = 1;
  } else {
    out.leg = Leg.Back;
    out.f = 1 - ease((t - trip.d1) / Math.max(1e-6, trip.a1 - trip.d1));
  }
  return out;
}

/**
 * Progress of a shipment along its route: (now − depart) / (arrive − depart),
 * clamped to [0, 1]; 1 if the times are degenerate.
 */
export function shipmentProgress(day: number, dayFrac: number, depart: number, arrive: number): number {
  const span = arrive - depart;
  if (!(span > 1e-6) || !Number.isFinite(span)) return 1;
  const f = (day + dayFrac - depart) / span;
  if (!Number.isFinite(f)) return 1;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

// ---------------------------------------------------------------------------
// Polylines
// ---------------------------------------------------------------------------

export interface Poly {
  /** Interleaved x, y (tile coordinates of tile centres). */
  xy: Float32Array;
  /** Cumulative arc length at each vertex. */
  cum: Float32Array;
  /** Total length (tiles). */
  len: number;
}

export const EMPTY_POLY: Poly = { xy: new Float32Array(0), cum: new Float32Array(0), len: 0 };

/** Polyline through the centres of `tiles` (indices on a map `w` wide). */
export function polyFromTiles(tiles: readonly number[], w: number): Poly {
  const n = tiles.length;
  if (!n || !(w > 0)) return EMPTY_POLY;
  const xy = new Float32Array(n * 2);
  const cum = new Float32Array(n);
  let len = 0;
  for (let k = 0; k < n; k++) {
    const i = tiles[k];
    const x = (i % w) + 0.5;
    const y = Math.floor(i / w) + 0.5;
    xy[2 * k] = x;
    xy[2 * k + 1] = y;
    if (k > 0) len += Math.hypot(x - xy[2 * k - 2], y - xy[2 * k - 1]);
    cum[k] = len;
  }
  return { xy, cum, len };
}

/** Polyline through explicit points [x0, y0, x1, y1, ...]. */
export function polyFromPoints(pts: ArrayLike<number>): Poly {
  const n = Math.floor(pts.length / 2);
  if (!n) return EMPTY_POLY;
  const xy = new Float32Array(n * 2);
  const cum = new Float32Array(n);
  let len = 0;
  for (let k = 0; k < n; k++) {
    xy[2 * k] = pts[2 * k];
    xy[2 * k + 1] = pts[2 * k + 1];
    if (k > 0) len += Math.hypot(xy[2 * k] - xy[2 * k - 2], xy[2 * k + 1] - xy[2 * k - 1]);
    cum[k] = len;
  }
  return { xy, cum, len };
}

export interface PolySample {
  x: number;
  y: number;
  /** Unit direction of travel (A → B). */
  dx: number;
  dy: number;
}

/**
 * Point at arc length `d` along a polyline (clamped to its ends) and the unit
 * direction there. Binary search: O(log n).
 */
export function samplePoly(p: Poly, d: number, out: PolySample): PolySample {
  const n = p.cum.length;
  if (n === 0) {
    out.x = 0;
    out.y = 0;
    out.dx = 1;
    out.dy = 0;
    return out;
  }
  if (n === 1 || !(p.len > 0)) {
    out.x = p.xy[0];
    out.y = p.xy[1];
    out.dx = 1;
    out.dy = 0;
    return out;
  }
  const dd = d <= 0 ? 0 : d >= p.len ? p.len : d;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p.cum[mid] <= dd) lo = mid;
    else hi = mid;
  }
  const ax = p.xy[2 * lo];
  const ay = p.xy[2 * lo + 1];
  const bx = p.xy[2 * hi];
  const by = p.xy[2 * hi + 1];
  const seg = p.cum[hi] - p.cum[lo];
  const t = seg > 1e-9 ? (dd - p.cum[lo]) / seg : 0;
  out.x = ax + (bx - ax) * t;
  out.y = ay + (by - ay) * t;
  const l = Math.hypot(bx - ax, by - ay);
  if (l > 1e-9) {
    out.dx = (bx - ax) / l;
    out.dy = (by - ay) / l;
  } else {
    out.dx = 1;
    out.dy = 0;
  }
  return out;
}
