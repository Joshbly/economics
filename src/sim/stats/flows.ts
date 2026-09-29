// ============================================================================
// Goods flows, town by town: what each town makes, uses, brings in and sends out
// of every good each day — the counterpart of its market's volume (what changed
// hands there). OWNER: stats engineer. See DESIGN §8.
//
//   made  — produced by the workshops of the town (firms.firmsProduce);
//   used  — used up there: eaten, burnt, drunk and worn out at home
//           (households.householdsConsume), inputs and tool wear of its workshops
//           (firms), materials built into its projects (construction), fuel its
//           wagons burn (traders, freight lines);
//   in    — landed there from elsewhere: wagons arriving (traders.deliver) and
//           goods bought from foreign ships at its port (markets settlement);
//   out   — left for elsewhere: wagons departing (factory.newShipment) and goods
//           sold to foreign ships.
// Spoilage is not counted as use. The day's tally lives in the runtime cache and
// is folded at the end of the day (engine, before statsStep) into each market's
// last MARKET_BALANCE_DAYS days (MarketState.madeHist / usedHist / inHist /
// outHist); recentFlows averages them.
// ============================================================================
import { MARKET_BALANCE_DAYS } from '../config';
import { N_GOODS } from '../goods';
import { rt } from '../runtime';
import type { MarketState, SimState } from '../types';

export const FLOW_MADE = 0;
export const FLOW_USED = 1;
export const FLOW_IN = 2;
export const FLOW_OUT = 3;
const KINDS = 4;

/** Today's tally, [(town × N_GOODS + good) × 4 + kind]; fresh each day. */
export function flowTally(s: SimState): Float64Array {
  const bag = rt(s).bag;
  const n = s.towns.length * N_GOODS * KINDS;
  let t = bag.flowTally as Float64Array | undefined;
  if (!t || t.length !== n || bag.flowDay !== s.day) {
    if (!t || t.length !== n) bag.flowTally = t = new Float64Array(n);
    else t.fill(0);
    bag.flowDay = s.day;
  }
  return t;
}

/** Add `q` units of good `g` to today's `kind` flow of town `town`. */
export function noteFlow(s: SimState, town: number, g: number, kind: number, q: number): void {
  if (!(q > 0) || !(town >= 0 && town < s.towns.length) || !(g >= 0 && g < N_GOODS)) return;
  flowTally(s)[(town * N_GOODS + g) * KINDS + kind] += q;
}

/** Index into a tally for fast loops: (town × N_GOODS + good) × 4 + kind. */
export function flowIndex(town: number, g: number, kind: number): number {
  return (town * N_GOODS + g) * KINDS + kind;
}

function pushCapped(a: number[], v: number, cap: number): void {
  a.push(Math.round(v * 1e4) / 1e4);
  if (a.length > cap) a.splice(0, a.length - cap);
}

/** End of the day: each town's goods markets keep today's flows among their last days. */
export function foldFlows(s: SimState): void {
  const t = flowTally(s);
  const nT = s.towns.length;
  for (let town = 0; town < nT; town++)
    for (let g = 0; g < N_GOODS; g++) {
      const m = s.markets[town * N_GOODS + g];
      if (!m) continue;
      const i = (town * N_GOODS + g) * KINDS;
      pushCapped((m.madeHist ??= []), t[i + FLOW_MADE], MARKET_BALANCE_DAYS);
      pushCapped((m.usedHist ??= []), t[i + FLOW_USED], MARKET_BALANCE_DAYS);
      pushCapped((m.inHist ??= []), t[i + FLOW_IN], MARKET_BALANCE_DAYS);
      pushCapped((m.outHist ??= []), t[i + FLOW_OUT], MARKET_BALANCE_DAYS);
    }
}

/** A town's flows of one good, a day, over its last days (and the market's volume over the same days). */
export interface Flows {
  days: number;
  made: number;
  used: number;
  in: number;
  out: number;
  traded: number;
  /** made − used: what the town makes beyond its own use (+), or lacks (−). */
  net: number;
}

function mean(a: number[] | undefined, n: number): number {
  if (!a || !a.length || n <= 0) return 0;
  let s = 0;
  const k = Math.min(n, a.length);
  for (let i = a.length - k; i < a.length; i++) s += a[i] > 0 && Number.isFinite(a[i]) ? a[i] : 0;
  return s / k;
}

export function recentFlows(m: Pick<MarketState, 'madeHist' | 'usedHist' | 'inHist' | 'outHist' | 'volHist'> | undefined | null): Flows {
  const n = m?.madeHist?.length ?? 0;
  if (!m || n === 0) return { days: 0, made: 0, used: 0, in: 0, out: 0, traded: 0, net: 0 };
  const made = mean(m.madeHist, n);
  const used = mean(m.usedHist, n);
  return { days: n, made, used, in: mean(m.inHist, n), out: mean(m.outHist, n), traded: mean(m.volHist, n), net: made - used };
}
