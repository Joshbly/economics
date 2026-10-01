// ============================================================================
// Range resolution and series transforms for the Charts panel.
//
//   const v = resolveView(s, 'y1');           // daily or monthly, from/to days
//   const r = seriesData(s, 'gdpReal', v, { smooth: 7, index: true });
//   chart.set([{ label, data: r.data, x0: r.x0, xStep: r.xStep }]);
//
// Rule: a range that fits in the daily history (≤ 4 years, the daily cap) is
// drawn from daily figures; anything longer from monthly figures.
// ============================================================================
import { DAYS_PER_MONTH, DAYS_PER_YEAR } from '../../../sim/config';
import type { SimState } from '../../../sim/types';

export type RangeId = 'y1' | 'y5' | 'all';

export const RANGE_DAYS: Record<RangeId, number> = { y1: DAYS_PER_YEAR, y5: DAYS_PER_YEAR * 5, all: Infinity };

export interface View {
  monthly: boolean;
  /** First and last day shown. */
  from: number;
  to: number;
}

/** Days the daily series cover (they share one start). */
function dailyCoverage(s: SimState): { start: number; len: number } {
  const st = s.stats;
  const start = st?.dailyStart ?? 0;
  let len = 0;
  const d = st?.daily ?? {};
  const probe = d.cpi ?? d.pop ?? Object.values(d)[0];
  if (probe) len = probe.length;
  return { start, len };
}

export function resolveView(s: SimState, range: RangeId): View {
  const { start, len } = dailyCoverage(s);
  const lastDaily = len > 0 ? start + len - 1 : s.day;
  const to = Math.max(lastDaily, start);
  const origin = Math.min(s.startDay ?? start, start);
  const span = RANGE_DAYS[range];
  const from = Number.isFinite(span) ? Math.max(origin, to - span + 1) : origin;
  // daily if the whole range is inside the daily history
  const monthly = from < start && len > 0;
  return { monthly, from, to };
}

export interface SeriesData {
  data: number[];
  x0: number;
  xStep: number;
  /** True when indexing was requested but could not be applied (rates, no positive base). */
  notIndexed: boolean;
  /** Base value used for indexing (NaN if none). */
  base: number;
}

export interface Transform {
  /** Trailing mean (daily only). */
  smooth?: number;
  /** Rolling total (daily only). */
  total?: number;
  /** Divide monthly values by 30 (month totals → per day), for custom charts. */
  perDayMonthly?: boolean;
  /** Index to 100 at the first finite positive value of the range. */
  index?: boolean;
  /** Series is a rate/share — never indexed. */
  noIndex?: boolean;
  /** Only monthly data exists. */
  monthlyOnly?: boolean;
}

const finite = (v: number) => typeof v === 'number' && Number.isFinite(v);

/** Extract, transform and slice one series for a view. Missing series → empty data. */
export function seriesData(s: SimState, key: string, v: View, t: Transform = {}): SeriesData {
  const st = s.stats;
  const useMonthly = v.monthly || !!t.monthlyOnly || !(st?.daily && key in st.daily);
  const raw: ArrayLike<number> | undefined = useMonthly ? st?.monthly?.[key] : st?.daily?.[key];
  const x0Full = useMonthly ? (st?.monthlyStart ?? 0) * DAYS_PER_MONTH : (st?.dailyStart ?? 0);
  const step = useMonthly ? DAYS_PER_MONTH : 1;
  const out: SeriesData = { data: [], x0: x0Full, xStep: step, notIndexed: false, base: NaN };
  if (!raw || raw.length === 0) return out;

  // first index inside the range (monthly points sit at their month start; include the month containing `from`)
  const i0 = Math.max(0, Math.ceil((v.from - x0Full - (useMonthly ? DAYS_PER_MONTH - 1 : 0)) / step));
  const i1 = Math.min(raw.length - 1, Math.floor((v.to - x0Full) / step));
  if (i1 < i0) return out;

  let data: number[];
  const n = i1 - i0 + 1;
  if (!useMonthly && (t.smooth || t.total)) {
    const w = Math.max(1, Math.round(t.smooth || t.total || 1));
    // rolling window over the full series (so the range start already has history), then slice
    data = new Array(n);
    let sum = 0;
    let cnt = 0;
    const lo = Math.max(0, i0 - w + 1);
    const q: number[] = [];
    for (let i = lo; i <= i1; i++) {
      const x = raw[i];
      q.push(x);
      if (finite(x)) {
        sum += x;
        cnt++;
      }
      if (q.length > w) {
        const y = q.shift()!;
        if (finite(y)) {
          sum -= y;
          cnt--;
        }
      }
      if (i >= i0) {
        if (!cnt) data[i - i0] = NaN;
        else if (t.total) data[i - i0] = (sum / cnt) * w; // partial windows scaled to a full window
        else data[i - i0] = sum / cnt;
      }
    }
  } else {
    data = new Array(n);
    const div = useMonthly && t.perDayMonthly ? DAYS_PER_MONTH : 1;
    for (let i = 0; i < n; i++) {
      const x = raw[i0 + i];
      data[i] = finite(x) ? x / div : NaN;
    }
  }

  if (t.index) {
    if (t.noIndex) out.notIndexed = true;
    else {
      let base = NaN;
      for (const x of data) {
        if (finite(x) && x > 0) {
          base = x;
          break;
        }
      }
      const anyNeg = data.some((x) => finite(x) && x < 0);
      if (finite(base) && !anyNeg) {
        out.base = base;
        for (let i = 0; i < data.length; i++) data[i] = finite(data[i]) ? (data[i] / base) * 100 : NaN;
      } else out.notIndexed = true;
    }
  }
  out.data = data;
  out.x0 = x0Full + i0 * step;
  return out;
}

/** First finite positive value when the whole series can be indexed (no negatives), else NaN. */
export function indexBase(data: ArrayLike<number>): number {
  let base = NaN;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    if (!finite(x)) continue;
    if (x < 0) return NaN;
    if (!finite(base) && x > 0) base = x;
  }
  return base;
}

/** Copy of `data` divided by `base` × 100. */
export function indexTo(data: ArrayLike<number>, base: number): number[] {
  const out = new Array<number>(data.length);
  for (let i = 0; i < data.length; i++) out[i] = finite(data[i]) ? (data[i] / base) * 100 : NaN;
  return out;
}

export interface Summary {
  first: number;
  last: number;
  min: number;
  max: number;
}

export function summarize(data: ArrayLike<number>): Summary {
  const r: Summary = { first: NaN, last: NaN, min: NaN, max: NaN };
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    if (!finite(x)) continue;
    if (!finite(r.first)) r.first = x;
    r.last = x;
    if (!finite(r.min) || x < r.min) r.min = x;
    if (!finite(r.max) || x > r.max) r.max = x;
  }
  return r;
}
