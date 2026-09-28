// ============================================================================
// Axis maths shared by the chart widgets (pure, unit-tested):
//   niceTicks   — "nice" linear ticks (1 / 2 / 2.5 / 5 × 10^k)
//   logTicks    — log-scale ticks (1-2-5 per decade, thinned when wide)
//   dayTicks    — calendar ticks for day-indexed x axes (years, months, days)
//   fmtTick     — tick label with just enough decimals for the step
// ============================================================================
import { DAYS_PER_MONTH, DAYS_PER_YEAR } from '../../sim/config';
import { MINUS } from '../format';

export interface Ticks {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

/** A nice step close to range/count. */
export function niceStep(range: number, count: number): number {
  if (!(range > 0) || !Number.isFinite(range)) return 1;
  const raw = range / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * mag;
}

/** Remove float noise from a tick value (0.30000000000000004 → 0.3). */
function clean(v: number, step: number): number {
  const d = Math.max(0, Math.min(12, -Math.floor(Math.log10(step)) + 2));
  return Number(v.toFixed(d));
}

/**
 * Nice ticks covering [min, max] with about `count` intervals. The returned
 * domain [min, max] is expanded to whole steps. Degenerate ranges are padded.
 */
export function niceTicks(min: number, max: number, count = 5): Ticks {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (min > max) [min, max] = [max, min];
  if (max - min < 1e-12 * Math.max(1, Math.abs(max))) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    if (min === 0) max = 1;
    else {
      min -= pad;
      max += pad;
    }
  }
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  const n = Math.min(60, Math.round((hi - lo) / step));
  for (let i = 0; i <= n; i++) ticks.push(clean(lo + i * step, step));
  return { min: clean(lo, step), max: clean(hi, step), step, ticks };
}

/**
 * Log-scale ticks for positive ranges. Uses 1-2-5 per decade for narrow
 * ranges, only powers of ten for wide ones. Domain snaps to the enclosing ticks.
 */
export function logTicks(min: number, max: number, count = 5): Ticks {
  if (!(min > 0) || !Number.isFinite(min)) min = Math.max(1e-6, max / 100 || 1e-6);
  if (!(max > min) || !Number.isFinite(max)) max = min * 10;
  const k0 = Math.floor(Math.log10(min));
  const k1 = Math.ceil(Math.log10(max));
  const decades = k1 - k0;
  const mults = decades <= 1 ? [1, 1.5, 2, 3, 5, 7] : decades <= 3 ? [1, 2, 5] : [1];
  const cand: number[] = [];
  for (let k = k0; k <= k1; k++) for (const m of mults) cand.push(Number((m * Math.pow(10, k)).toPrecision(6)));
  let lo = cand[0];
  let hi = cand[cand.length - 1];
  for (const c of cand) if (c <= min) lo = c;
  for (let i = cand.length - 1; i >= 0; i--) if (cand[i] >= max) hi = cand[i];
  let ticks = cand.filter((c) => c >= lo && c <= hi);
  // Thin to roughly `count` ticks by keeping every n-th (always keep ends).
  if (ticks.length > count * 1.8) {
    const every = Math.ceil(ticks.length / count);
    ticks = ticks.filter((_, i) => i % every === 0 || i === ticks.length - 1);
  }
  return { min: lo, max: hi, step: 0, ticks };
}

/** Tick label with decimals matched to the step; compact above 10k ("12k", "1.5M"). */
export function fmtTick(v: number, step: number): string {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  const sign = v < 0 ? MINUS : '';
  if (a >= 1e9) return sign + trim((a / 1e9).toFixed(stepDecimals(step / 1e9))) + 'B';
  if (a >= 1e6) return sign + trim((a / 1e6).toFixed(stepDecimals(step / 1e6))) + 'M';
  if (a >= 1e4) return sign + trim((a / 1e3).toFixed(stepDecimals(step / 1e3))) + 'k';
  const d = step > 0 ? stepDecimals(step) : a >= 100 ? 0 : a >= 1 ? 1 : 2;
  const t = a.toFixed(d);
  if (Number(t) === 0) return '0';
  return sign + (a >= 1000 ? Number(t).toLocaleString('en-US', { maximumFractionDigits: d }) : t);
}

function stepDecimals(step: number): number {
  if (!(step > 0)) return 0;
  const d = -Math.floor(Math.log10(step) + 1e-9);
  const mant = step / Math.pow(10, Math.floor(Math.log10(step) + 1e-9));
  return Math.max(0, Math.min(6, d + (Math.abs(mant - 2.5) < 1e-6 || Math.abs(mant - 1.5) < 1e-6 ? 1 : 0)));
}

function trim(t: string): string {
  return t.indexOf('.') >= 0 ? t.replace(/\.?0+$/, '') : t;
}

// ---------------------------------------------------------------------------
// Calendar ticks
// ---------------------------------------------------------------------------

export interface DayTick {
  x: number; // day index
  label: string;
  major: boolean; // year start
}

const DAY_STEPS = [1, 2, 5, 10, 15, 30, 60, 90, 180, 360, 720, 1080, 1800, 3600, 7200, 18000];

/**
 * Calendar ticks between day indices x0..x1 for an axis `widthPx` wide, at
 * least `minPx` apart. Years start on multiples of 360 (day 0 = Y1 Thaw 1).
 * Labels: "Y3" at year starts, "M6" at months, "D11" at days; the first tick
 * carries enough context ("Y3 M6") to anchor the reader.
 */
export function dayTicks(x0: number, x1: number, widthPx: number, minPx = 64): DayTick[] {
  if (!(x1 > x0) || !(widthPx > 0) || !Number.isFinite(x0) || !Number.isFinite(x1)) return [];
  const need = ((x1 - x0) * minPx) / widthPx;
  let step = DAY_STEPS[DAY_STEPS.length - 1];
  for (const s of DAY_STEPS) {
    if (s >= need) {
      step = s;
      break;
    }
  }
  const out: DayTick[] = [];
  const start = Math.ceil(x0 - 1e-9);
  const end = Math.floor(x1 + 1e-9);
  const Y = DAYS_PER_YEAR;
  const M = DAYS_PER_MONTH;
  const push = (d: number) => {
    const doy = ((d % Y) + Y) % Y;
    const y = Math.floor(d / Y) + 1;
    const m = Math.floor(doy / M) + 1;
    const dd = (doy % M) + 1;
    const major = doy === 0;
    let label: string;
    if (step >= Y) label = `Y${y}`;
    else if (step >= M) label = major ? `Y${y}` : out.length === 0 ? `Y${y} M${m}` : `M${m}`;
    else if (dd === 1) label = major ? `Y${y}` : out.length === 0 ? `Y${y} M${m}` : `M${m}`;
    else label = out.length === 0 ? `M${m} D${dd}` : `D${dd}`;
    out.push({ x: d, label, major });
  };
  if (step >= Y) {
    const k = step / Y;
    let yr = Math.ceil(start / Y);
    while (yr % k !== 0) yr++;
    for (let d = yr * Y; d <= end && out.length < 200; d += step) push(d);
  } else if (step >= M) {
    const k = step / M;
    let mi = Math.ceil(start / M); // absolute month index
    while (((mi % 12) + 12) % 12 % k !== 0) mi++;
    for (; mi * M <= end && out.length < 200; mi += k) push(mi * M);
  } else {
    // day steps: within each month, days 1, 1+step, … (never crossing into the next month's day 1)
    let mi = Math.floor(start / M);
    for (; mi * M <= end && out.length < 400; mi++) {
      for (let dd = 0; dd < M; dd += step) {
        if (dd > 0 && M - dd < step * 0.6) break; // keep the gap before next month's tick
        const d = mi * M + dd;
        if (d >= start && d <= end) push(d);
      }
    }
  }
  return out;
}

/** Linear map helper: value → pixel. */
export function scaleLinear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const span = d1 - d0 || 1;
  const k = (r1 - r0) / span;
  return (v: number) => r0 + (v - d0) * k;
}

/** Log map helper (positive domain): value → pixel. Non-positive values map to NaN. */
export function scaleLog(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const l0 = Math.log(Math.max(1e-12, d0));
  const l1 = Math.log(Math.max(1e-12, d1));
  const span = l1 - l0 || 1;
  const k = (r1 - r0) / span;
  return (v: number) => (v > 0 ? r0 + (Math.log(v) - l0) * k : NaN);
}
