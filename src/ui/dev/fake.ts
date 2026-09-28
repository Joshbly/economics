// ============================================================================
// DEV ONLY: synthetic data for the widget gallery and the shell preview.
// Deterministic (own tiny LCG) so screenshots are comparable run to run.
// Never imported by the game itself.
// ============================================================================
import { newMarket, newSimState, newTown } from '../../sim/factory';
import { N_GOODS } from '../../sim/goods';
import type { CurveSnapshot, MapData, NewsItem, SimState, TownKind } from '../../sim/types';

export function lcg(seed = 1): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

/** Gaussian-ish noise from an LCG. */
export function noise(r: () => number): number {
  return (r() + r() + r() - 1.5) / 1.5;
}

/** A random walk with drift, seasonality and noise. */
export function walk(n: number, start: number, opts: { drift?: number; vol?: number; season?: number; seed?: number; floor?: number } = {}): number[] {
  const r = lcg(opts.seed ?? 7);
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    v *= 1 + (opts.drift ?? 0) + (opts.vol ?? 0.004) * noise(r);
    const seas = opts.season ? 1 + opts.season * Math.sin((2 * Math.PI * (i - 45)) / 360) : 1;
    out.push(Math.max(opts.floor ?? -Infinity, v * seas));
  }
  return out;
}

/** A flat map (grass with a coast) — enough for a renderer not to crash. */
export function fakeMap(w = 112, h = 76): MapData {
  const n = w * h;
  const terrain = new Array(n).fill(3);
  const elev = new Array(n).fill(0.4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const coast = x + y * 1.3 > w + h * 0.95;
      terrain[i] = coast ? (x + y * 1.3 > w + h * 1.1 ? 0 : 1) : (x * 7 + y * 13) % 29 === 0 ? 4 : y < 14 && x < 40 ? 5 : 3;
      elev[i] = coast ? 0.1 : 0.35 + 0.3 * Math.sin(x / 9) * Math.cos(y / 7);
    }
  const z = () => new Array(n).fill(0);
  return { w, h, terrain, elev, fert: new Array(n).fill(0.6), deposit: z(), river: z(), road: z(), occ: new Array(n).fill(-1), district: new Array(n).fill(-1) };
}

const NEWS: [string, NewsItem['kind'], number][] = [
  ['A good harvest in Millbrook: grain is plentiful and cheap.', 'good', 1],
  ['The Treasury now takes 10% of every bread sale in Millbrook.', 'policy', 1],
  ['Bread ran short in Kingsbridge: 140 loaves wanted went unsold-for.', 'market', 0],
  ['Coalridge miners walk out after weeks of hunger.', 'crisis', 2],
  ['A new bakery opens in Saltmere.', 'info', 3],
  ['The bank tightens its lending after two defaults.', 'bad', -1],
  ['Foreign ships bring cheap iron to Saltmere.', 'market', 3],
  ['The price of gold rose 6% this month.', 'market', -1],
  ['The Treasury paid ¤12 to every jobless household in Coalridge.', 'policy', 2],
  ['Fish is scarce off the coast this season.', 'bad', 3],
  ['The Kingsbridge brewery went bankrupt; 7 brewers lost their jobs.', 'bad', 0],
  ['The road to Coalridge is now paved.', 'good', 2],
];

/** A plausible-looking SimState for UI previews (not simulatable). */
export function fakeState(): SimState {
  const s = newSimState(42, fakeMap());
  const names: [string, TownKind, number, number][] = [
    ['Kingsbridge', 'capital', 40, 34],
    ['Millbrook', 'farm', 20, 50],
    ['Coalridge', 'mining', 30, 12],
    ['Saltmere', 'harbor', 78, 52],
  ];
  names.forEach(([n, k, x, y], i) => s.towns.push(newTown(i, n, k, x, y, 6)));
  const prices = [2.6, 3.0, 2.6, 2.6, 2.6, 3.2, 13, 20, 4, 2.8, 22];
  for (let t = 0; t < 4; t++) for (let g = 0; g < N_GOODS; g++) s.markets[t * N_GOODS + g] = newMarket(t, g, prices[g] * (1 + 0.05 * t));
  s.settings.realmName = 'Aldermoor';
  const days = 360 + 137;
  s.day = 360 + days;
  s.startDay = 360;
  const st = s.stats;
  st.dailyStart = s.day - days;
  const D = st.daily;
  D.cpi = walk(days, 100, { drift: 0.00012, vol: 0.003, season: 0.012, seed: 3 });
  D.infl30 = D.cpi.map((v, i) => (i >= 30 ? Math.pow(v / D.cpi[i - 30], 12) - 1 : 0.03));
  D.inflYoY = D.cpi.map((v, i) => (i >= 360 ? v / D.cpi[i - 360] - 1 : 0.02));
  D.unemp = walk(days, 0.05, { vol: 0.02, seed: 5 }).map((v, i) => Math.min(0.3, v * (1 + 0.4 * Math.max(0, (i - 300) / 200))));
  D.gdpReal = walk(days, 5200, { drift: 0.0001, vol: 0.006, season: 0.12, seed: 9 });
  D.gdpNominal = D.gdpReal.map((v, i) => (v * D.cpi[i]) / 100);
  D.money = walk(days, 182000, { drift: 0.0004, vol: 0.002, seed: 11 });
  D.credit = walk(days, 96000, { drift: 0.0006, vol: 0.003, seed: 12 });
  D.reserves = walk(days, 21000, { vol: 0.01, seed: 13 });
  D.purse = walk(days, 12000, { drift: -0.001, vol: 0.02, seed: 14 });
  D.goldPrice = walk(days, 100, { drift: 0.0003, vol: 0.006, seed: 15 });
  D.pop = walk(days, 640, { drift: 0.00005, vol: 0.001, seed: 16 }).map(Math.round);
  D.wage = walk(days, 10, { drift: 0.0001, vol: 0.002, seed: 17 });
  D.loanRate = walk(days, 0.075, { vol: 0.004, seed: 18 });
  D.hunger = walk(days, 0.04, { vol: 0.03, seed: 19 });
  D.health = walk(days, 0.88, { vol: 0.002, seed: 20 });
  for (const k of Object.keys(D)) st.latest[k] = D[k][D[k].length - 1];
  Object.assign(st.latest, { unemployed: 41, vacancies: 18, homeless: 6, treasuryGold: 150, tradeBal: -120, treasuryIncome: 340, treasurySpend: 910, minted: 5000 });
  const r = lcg(4);
  let d = s.day - 200;
  for (const [text, kind, town] of NEWS) {
    d += Math.floor(4 + r() * 22);
    s.news.push({ day: Math.min(d, s.day), text, kind, town });
  }
  return s;
}

/**
 * A synthetic auction snapshot around price `p` with `n` households bidding
 * and a few sellers asking; optionally with a levy wedge / limits / Treasury orders.
 */
export function fakeCurve(p: number, opts: Partial<CurveSnapshot> & { depth?: number } = {}): CurveSnapshot {
  const depth = opts.depth ?? 600;
  const bids: number[] = [];
  const rungs = [2.5, 1.6, 1.25, 1.1, 1.0, 0.9, 0.8, 0.65];
  let cum = 0;
  rungs.forEach((m, i) => {
    cum += depth * [0.06, 0.08, 0.12, 0.16, 0.2, 0.16, 0.12, 0.1][i];
    bids.push(Number((p * m).toFixed(4)), Math.round(cum));
  });
  const asks: number[] = [];
  const am = [0.62, 0.72, 0.85, 0.95, 1.0, 1.08, 1.2, 1.35];
  cum = 0;
  am.forEach((m, i) => {
    cum += depth * [0.05, 0.08, 0.14, 0.18, 0.2, 0.15, 0.12, 0.08][i];
    asks.push(Number((p * m).toFixed(4)), Math.round(cum));
  });
  const w = { bPct: 0, bUnit: 0, sPct: 0, sUnit: 0, ...(opts.wedge ?? {}) };
  // Traders' limits are in their own terms; the auction works in base terms.
  for (let i = 0; i < bids.length; i += 2) bids[i] = Number(((bids[i] - w.bUnit) / (1 + w.bPct)).toFixed(4));
  for (let i = 0; i < asks.length; i += 2) asks[i] = Number(((asks[i] + w.sUnit) / (1 - w.sPct)).toFixed(4));
  const D = (x: number) => {
    let q = 0;
    for (let i = 0; i < bids.length; i += 2) if (bids[i] >= x) q = bids[i + 1];
    return q;
  };
  const S = (x: number) => {
    let q = 0;
    for (let i = 0; i < asks.length; i += 2) if (asks[i] <= x) q = asks[i + 1];
    return q;
  };
  let best = p;
  let bestV = -1;
  for (let i = 0; i < bids.length + asks.length; i += 2) {
    const x = i < bids.length ? bids[i] : asks[i - bids.length];
    const v = Math.min(D(x), S(x));
    if (v > bestV || (v === bestV && Math.abs(x - p) < Math.abs(best - p))) {
      bestV = v;
      best = x;
    }
  }
  let price = best;
  if (opts.ceiling !== undefined && opts.ceiling > 0 && price > opts.ceiling) price = opts.ceiling;
  if (opts.floor !== undefined && opts.floor > 0 && price < opts.floor) price = opts.floor;
  return {
    bids,
    asks,
    state: opts.state ?? [],
    price,
    volume: opts.volume ?? Math.min(D(price), S(price)),
    wedge: w,
    ceiling: opts.ceiling ?? -1,
    floor: opts.floor ?? -1,
  };
}
