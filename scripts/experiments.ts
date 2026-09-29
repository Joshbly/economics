// ============================================================================
// Policy experiments (DESIGN §9): same world, same RNG state, baseline vs
// treatment. The directional results below define what "accurate" means.
//
//   npm run experiments -- [--only <id|substr>] [--days N] [--seed N] [--pre N] [--verbose]
//   (--only 7 runs 7a and 7b; --only road runs the experiments whose name mentions it)
//
// Procedure: build the world and run the warm-up once (Game.create), switch random
// events off (they would add noise that differs between arms) and let the Purse
// mint on demand (so high window rates or large payments never stall), run a short
// observation period (--pre, default 60 days) from which each experiment sizes its
// actions, then serialise that state. Every arm — the baseline and each treatment —
// starts from a deserialised copy of the same JSON (identical RNG state), applies
// its actions on day 0 (plus optional per-day hooks) and runs for the experiment's
// length. Checks compare arm means over an evaluation window (default: the last
// 90 days). The baseline is simulated once, for the longest experiment, and every
// experiment reads its own window from it (a baseline has no actions, so its first
// N days are the same whatever its length).
//
// This is a report: the exit code is 0 even when checks fail (1 only on a crash).
// ============================================================================
import { WARMUP_DAYS } from '../src/sim/config';
import { G, GOODS, N_GOODS, TRADABLE_GOODS } from '../src/sim/goods';
import { Game } from '../src/sim/game';
import { takeHomeWage } from '../src/sim/stats/stats';
import { expectedGrossFor } from '../src/sim/market/markets';
import { roadPlan } from '../src/sim/world/paths';
import type { Levy, Limit, PlayerAction, SimState, TownKind } from '../src/sim/types';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
interface Opts {
  only: string;
  days: number;
  seed: number;
  pre: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { only: '', days: 360, seed: 1, pre: 60, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`experiments: missing value after ${a}`);
        process.exit(1);
      }
      return v;
    };
    if (a === '--only') o.only = val().toLowerCase();
    else if (a === '--days') o.days = Math.max(30, Math.floor(Number(val()) || 360));
    else if (a === '--seed') o.seed = Math.floor(Number(val()) || 1);
    else if (a === '--pre') o.pre = Math.max(0, Math.floor(Number(val()) || 0));
    else if (a === '--verbose' || a === '-v') o.verbose = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: npm run experiments -- [--only <substr>] [--days N] [--seed N] [--pre N] [--verbose]');
      process.exit(0);
    } else {
      console.error(`experiments: unknown option ${a}`);
      process.exit(1);
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// Context observed on the base state (used to size the actions)
// ---------------------------------------------------------------------------
interface Ctx {
  capital: number;
  farm: number;
  mining: number;
  harbor: number;
  pop: number;
  wage: number;
  /** Smoothed base price per [town][good]. */
  price: number[][];
  /** Smoothed volume per [town][good]. */
  vol: number[][];
  /** National smoothed volume per good. */
  natVol: number[];
  /** National price per good (volume-weighted). */
  natPrice: number[];
  /** The good most imported through the port during the observation period. */
  importGood: number;
  importNote: string;
}

function townOfKind(s: SimState, kind: TownKind, fallback: number): number {
  const t = s.towns.find((x) => x.kind === kind);
  return t ? t.id : Math.min(fallback, s.towns.length - 1);
}

function mean(a: readonly number[]): number {
  let x = 0;
  for (const v of a) x += v;
  return a.length ? x / a.length : 0;
}

function observe(s: SimState): Ctx {
  const nT = s.towns.length;
  const price: number[][] = [];
  const vol: number[][] = [];
  const natVol = new Array(N_GOODS).fill(0);
  const natPrice = new Array(N_GOODS).fill(0);
  for (let t = 0; t < nT; t++) {
    price.push([]);
    vol.push([]);
    for (let g = 0; g < N_GOODS; g++) {
      const m = s.markets[t * N_GOODS + g];
      price[t][g] = m && m.ema > 0 ? m.ema : 1;
      vol[t][g] = m ? Math.max(0, m.volEma) : 0;
      natVol[g] += vol[t][g];
    }
  }
  for (let g = 0; g < N_GOODS; g++) {
    let num = 0;
    let den = 0;
    for (let t = 0; t < nT; t++) {
      num += price[t][g] * (vol[t][g] + 1e-6);
      den += vol[t][g] + 1e-6;
    }
    natPrice[g] = den > 0 ? num / den : 1;
  }
  // most imported good (by value) over the observation period
  let importGood = -1;
  let best = 0;
  for (const g of TRADABLE_GOODS) {
    const q = mean(s.stats.daily['imp_' + g] ?? []);
    const v = q * natPrice[g];
    if (v > best) {
      best = v;
      importGood = g;
    }
  }
  let importNote = importGood >= 0 ? `most imported: ${GOODS[importGood].name.toLowerCase()} (${(best / Math.max(1e-9, natPrice[importGood])).toFixed(1)}/day)` : '';
  if (importGood < 0) {
    // Nothing imported yet: the tradable good that is dearest at home relative to abroad.
    const E = s.goldMarket.ema > 0 ? s.goldMarket.ema : 100;
    let ratio = -1;
    for (const g of TRADABLE_GOODS) {
      const w = s.foreign.world[g];
      if (!(w > 0)) continue;
      const r = natPrice[g] / (E * w);
      if (r > ratio) {
        ratio = r;
        importGood = g;
      }
    }
    if (importGood < 0) importGood = G.iron;
    importNote = `no imports observed; using ${GOODS[importGood].name.toLowerCase()} (dearest at home vs abroad)`;
  }
  return {
    capital: townOfKind(s, 'capital', 0),
    farm: townOfKind(s, 'farm', 1),
    mining: townOfKind(s, 'mining', 2),
    harbor: townOfKind(s, 'harbor', 3),
    pop: s.people.filter((p) => p && p.alive).length,
    wage: s.stats.latest.wage > 0 ? s.stats.latest.wage : 10,
    price,
    vol,
    natVol,
    natPrice,
    importGood,
    importNote,
  };
}

// ---------------------------------------------------------------------------
// Metrics (evaluated every day in every arm)
// ---------------------------------------------------------------------------
type MetricFn = (s: SimState, c: Ctx) => number;
const L = (s: SimState, k: string): number => s.stats.latest[k] ?? 0;
const mkt = (s: SimState, t: number, g: number) => s.markets[t * N_GOODS + g];

const METRICS: Record<string, { label: string; fn: MetricFn }> = {
  cpi: { label: 'CPI', fn: (s) => L(s, 'cpi') },
  money: { label: 'money (Σ deposits)', fn: (s) => L(s, 'money') },
  breadGross: { label: 'bread price paid (national)', fn: (s) => L(s, 'gross_' + G.bread) },
  // The levy's revenue is withdrawn from circulation (it piles up in the Purse), which lowers
  // every price a little; incidence is about bread's price RELATIVE to everything else.
  breadRel: { label: 'bread price paid ÷ CPI', fn: (s) => L(s, 'gross_' + G.bread) / Math.max(1e-9, L(s, 'cpi') / 100) },
  breadQty: { label: 'bread bought by households/day', fn: (s) => L(s, 'cons_' + G.bread) },
  fishQty: { label: 'fish bought by households/day', fn: (s) => L(s, 'cons_' + G.fish) },
  levyTake: { label: 'levy revenue ¤/day', fn: (s) => L(s, 'levyTake') },
  breadShort: { label: 'bread demand turned away/day', fn: (s) => L(s, 'shortage_' + G.bread) },
  breadMove: { label: 'bread price move from the day before (mean over towns, |Δ|/p)', fn: (s) => meanOver(s.towns.map((t) => dayMove(mkt(s, t.id, G.bread)))) },
  breadMoveMax: { label: 'largest bread price move from the day before (any town)', fn: (s) => Math.max(0, ...s.towns.map((t) => dayMove(mkt(s, t.id, G.bread)))) },
  hunger: { label: 'share of households hungry', fn: (s) => L(s, 'hunger') },
  unemp: { label: 'unemployment rate', fn: (s) => L(s, 'unemp') },
  credit: { label: 'bank credit', fn: (s) => L(s, 'credit') },
  bankStance: { label: 'bank lending standards (stance, 0 loose … 1 tight)', fn: (s) => s.bank.stance },
  capRatio: { label: 'bank capital ÷ loans', fn: (s) => L(s, 'capRatio') },
  loanRate: { label: 'average loan rate', fn: (s) => L(s, 'loanRate') },
  inv: { label: 'investment ¤/day', fn: (s) => L(s, 'inv') },
  toolsPrice: { label: 'tools price (capital)', fn: (s, c) => mkt(s, c.capital, G.tools)?.ema ?? 0 },
  grainGap: { label: 'grain price gap farm↔capital', fn: (s, c) => Math.abs((mkt(s, c.capital, G.grain)?.ema ?? 0) - (mkt(s, c.farm, G.grain)?.ema ?? 0)) },
  roadLeft: { label: 'unpaved tiles farm→capital', fn: (s, c) => safe(() => roadPlan(s, c.farm, c.capital).length) },
  freight: { label: 'shipping rate', fn: (s) => L(s, 'freight') },
  importPrice: { label: 'port price paid for the imported good', fn: (s, c) => mkt(s, c.harbor, c.importGood)?.gross ?? 0 },
  importQty: { label: 'imports of that good/day', fn: (s, c) => L(s, 'imp_' + c.importGood) },
  takeHome: { label: 'take-home wage (employment-weighted)', fn: (s) => takeHomeWage(s) },
  takeHomeReal: { label: 'take-home wage ÷ CPI (what it buys)', fn: (s) => takeHomeWage(s) / Math.max(1e-9, L(s, 'cpi') / 100) },
  employed: { label: 'people employed', fn: (s) => L(s, 'employed') },
  harborBread: { label: 'bread price at the harbour', fn: (s, c) => mkt(s, c.harbor, G.bread)?.ema ?? 0 },
  farmBread: { label: 'bread price in the farm town', fn: (s, c) => mkt(s, c.farm, G.bread)?.ema ?? 0 },
  routeSold: { label: 'supply route: units sold at the harbour/day', fn: (s) => s.policy.orders.reduce((a, o) => a + (o.route ? o.route.soldToday : 0), 0) },
  coalTools: { label: 'tools held by coal mines', fn: (s) => sumFirms(s, 'coalmine', -1, (f) => f.tools + f.inv[G.tools]) },
  coalWorkers: { label: 'coal miners employed', fn: (s) => sumFirms(s, 'coalmine', -1, (f) => f.workers.length) },
  coalProd: { label: 'coal dug/day', fn: (s) => L(s, 'prod_' + G.coal) },
  miningCoalTools: { label: 'tools held by the mining town’s coal mines', fn: (s, c) => sumFirms(s, 'coalmine', c.mining, (f) => f.tools + f.inv[G.tools]) },
  miningCoalOut: { label: 'the mining town’s coal mines’ output/day (EMA)', fn: (s, c) => sumFirms(s, 'coalmine', c.mining, (f) => f.output) },
  miningCoalSpend: { label: 'the mining town’s coal mines’ market spending ¤/day (their tools)', fn: (s, c) => sumFirms(s, 'coalmine', c.mining, (f) => f.spent) },
  toolsElsewhere: { label: 'tools price outside the mining town (mean)', fn: (s, c) => meanOver(s.towns.filter((t) => t.id !== c.mining).map((t) => mkt(s, t.id, G.tools)?.ema ?? 0)) },
  giveSpend: { label: 'Treasury payments on levies ¤/day', fn: (s) => L(s, 'levyGive') },
  loansNew: { label: 'new bank lending ¤/day', fn: (s) => L(s, 'loansNew') },
  newLoanRate: { label: 'rate on loans made in the last 90 days (and credit lines)', fn: (s) => recentLoanRate(s) },
  hhBreadRel: { label: 'bread price households pay ÷ CPI (mean of towns)', fn: (s) => meanOver(hhBreadPaid(s)) / Math.max(1e-9, L(s, 'cpi') / 100) },
  hhBreadSpread: { label: 'bread price households pay: spread across towns (max−min ÷ mean)', fn: (s) => spread(hhBreadPaid(s)) },
  lineUnits: { label: 'freight line: units carried/day', fn: (s) => (s.policy.lines ?? []).reduce((a, l) => a + l.carriedToday, 0) },
  lineCost: { label: 'freight line: running cost ¤/day (drivers, fuel, wear)', fn: (s) => (s.policy.lines ?? []).reduce((a, l) => a + l.costToday, 0) },
  lineGap: { label: 'freight line: running cost less fares ¤/day (paid by the Purse)', fn: (s) => (s.policy.lines ?? []).reduce((a, l) => a + l.costToday - l.faresToday, 0) },
  carters: { label: 'carters employed by trading houses', fn: (s) => sumFirms(s, 'trader', -1, (f) => f.workers.length) },
  capitalGrain: { label: 'grain price in the capital', fn: (s, c) => mkt(s, c.capital, G.grain)?.ema ?? 0 },
  farmGrain: { label: 'grain price in the farm town', fn: (s, c) => mkt(s, c.farm, G.grain)?.ema ?? 0 },
};

/** What a household pays for bread in each town (smoothed auction price with every rule that reaches its purchases). */
function hhBreadPaid(s: SimState): number[] {
  const out: number[] = [];
  for (let t = 0; t < s.towns.length; t++) {
    const p = s.people.find((x) => x && x.alive && x.town === t);
    out.push(p ? expectedGrossFor(s, t, G.bread, p.id) : mkt(s, t, G.bread)?.ema ?? 0);
  }
  return out;
}

function spread(a: readonly number[]): number {
  const m = meanOver(a);
  return m > 0 ? (Math.max(...a) - Math.min(...a)) / m : 0;
}

/** Principal-weighted rate of the loans made in the last 90 days plus the floating credit lines (the base rate if none). */
function recentLoanRate(s: SimState): number {
  let p = 0;
  let r = 0;
  for (const l of s.loans) {
    if (!l.active || !(l.principal > 0) || (l.fixed !== false && l.start < s.day - 90)) continue;
    p += l.principal;
    r += l.principal * l.rate;
  }
  return p > 0 ? r / p : s.bank.baseRate;
}

/** Σ over the living, active firms of a trade (in a town, or −1 everywhere) of fn(firm). */
function sumFirms(s: SimState, sector: string, town: number, fn: (f: SimState['firms'][number]) => number): number {
  let x = 0;
  for (const f of s.firms) if (f && f.alive && f.status === 'active' && f.sector === sector && (town < 0 || f.town === town)) x += fn(f);
  return x;
}

function meanOver(a: readonly number[]): number {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

/** |p_today / p_yesterday − 1| of a market's recorded daily (base) price. */
function dayMove(m: SimState['markets'][number] | undefined): number {
  const hs = m?.hist;
  if (!hs || hs.length < 2) return 0;
  const a = hs[hs.length - 2];
  const b = hs[hs.length - 1];
  return a > 0 && b > 0 ? Math.abs(b / a - 1) : 0;
}

function safe(f: () => number): number {
  try {
    const v = f();
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}


// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------
type Act = (g: Game, c: Ctx) => void;

interface Arm {
  name: string;
  /** Actions on day 0 (before the first simulated day). */
  setup?: Act;
  /** Called before each simulated day (d = 0 .. days−1), after setup. */
  hook?: (g: Game, c: Ctx, d: number) => void;
}

type CheckKind = 'up' | 'down' | 'notDown' | 'similar' | 'positive' | 'persistent' | 'atMost';

interface Check {
  label: string;
  metric: string;
  kind: CheckKind;
  /** Arm evaluated (default: the first treatment arm). */
  arm?: string;
  /** Reference arm (default 'baseline'). */
  vs?: string;
  /** Relative threshold (up/down: minimum |Δ|/ref; similar: maximum; notDown: largest fall allowed). Default 0.01. */
  tol?: number;
  /** Absolute threshold on |Δ| for up/down (either this or tol must be met; used when the reference is ~0). */
  minAbs?: number;
  /** persistent: share of days the metric exceeds `level` (default 0.8 of days, level 0); atMost: every day ≤ level. */
  level?: number;
  /** Evaluation window for this check only (default: the experiment's). */
  window?: (days: number) => [number, number];
}

interface Experiment {
  id: string;
  name: string;
  days?: (o: Opts) => number;
  /** Evaluation window [from, to) in day indices; default the last 90 days. */
  window?: (days: number) => [number, number];
  arms: Arm[];
  checks: Check[];
  /** Extra metrics shown with --verbose. */
  show?: string[];
  note?: (res: Results, c: Ctx) => string;
}

const act = (g: Game, a: PlayerAction, what: string): number => {
  const r = g.dispatch(a);
  if (!r.ok) throw new Error(`${what}: ${r.message}`);
  return r.id ?? -1;
};

type LevyDraft = Omit<Levy, 'id' | 'created' | 'today' | 'month' | 'lastMonth' | 'total'>;
function levy(p: Partial<LevyDraft>): LevyDraft {
  return {
    label: '',
    enabled: true,
    dir: 1,
    base: 'sale',
    unit: 'pct',
    rate: 0,
    payer: 'buyer',
    threshold: 0,
    good: -1,
    town: -1,
    toTown: -1,
    sector: 'any',
    group: 'all',
    buildingKind: 'any',
    until: -1,
    ...p,
  };
}
type LimitDraft = Omit<Limit, 'id' | 'created' | 'binding'>;
function limit(p: Partial<LimitDraft>): LimitDraft {
  return { label: '', enabled: true, kind: 'priceMax', good: -1, town: -1, toTown: -1, value: 0, until: -1, ...p };
}
/** Take 60 % of the bank's own capital into the Purse (experiment 16, both arms). */
function thinBank(g: Game): void {
  const take = Math.round(0.6 * Math.max(0, g.s.bank.equity));
  act(g, { type: 'transfer', group: 'bank', town: -1, amount: take, dir: -1 }, 'thin the bank');
}

const EXPERIMENTS: Experiment[] = [
  {
    id: '1',
    name: 'Mint + per-head payment → prices rise',
    arms: [
      {
        name: 'per-head payment',
        setup: (g, c) => {
          act(g, { type: 'mint', amount: Math.round(30 * c.pop * c.wage) }, 'mint');
          act(g, { type: 'addLevy', levy: levy({ base: 'head', unit: 'flat', dir: -1, rate: Math.round(0.3 * c.wage * 100) / 100, payer: 'receiver', group: 'all' }) }, 'per-head payment');
        },
      },
    ],
    checks: [
      { label: 'CPI higher', metric: 'cpi', kind: 'up', tol: 0.01 },
      { label: 'money stock higher', metric: 'money', kind: 'up', tol: 0.05 },
    ],
  },
  {
    id: '2',
    name: '30 % levy on bread sales',
    arms: [{ name: 'bread levy', setup: (g) => act(g, { type: 'addLevy', levy: levy({ base: 'sale', unit: 'pct', rate: 0.3, payer: 'seller', good: G.bread }) }, 'bread levy') }],
    checks: [
      { label: 'consumer bread price up (relative to CPI)', metric: 'breadRel', kind: 'up', tol: 0.02 },
      { label: 'bread bought down', metric: 'breadQty', kind: 'down', tol: 0.01 },
      { label: 'fish bought up (substitution)', metric: 'fishQty', kind: 'up', tol: 0.01 },
      { label: 'Purse revenue > 0', metric: 'levyTake', kind: 'positive' },
    ],
  },
  {
    id: '3',
    name: 'Bread price ceiling well below market',
    arms: [{ name: 'ceiling 60 %', setup: (g, c) => act(g, { type: 'addLimit', limit: limit({ kind: 'priceMax', good: G.bread, value: Math.round(0.6 * c.natPrice[G.bread] * 1000) / 1000 }) }, 'ceiling') }],
    checks: [
      { label: 'persistent shortage (≥ 80 % of days)', metric: 'breadShort', kind: 'persistent', level: 1 },
      { label: 'shortage larger than baseline', metric: 'breadShort', kind: 'up', minAbs: 1 },
      { label: 'hunger up', metric: 'hunger', kind: 'up', minAbs: 0.005 },
    ],
  },
  {
    id: '16',
    name: 'Bread price may move at most 2 % a day',
    arms: [{ name: 'bread moves ≤ 2 %', setup: (g) => act(g, { type: 'addLimit', limit: limit({ kind: 'priceMove', good: G.bread, value: 0.02 }) }, 'move limit') }],
    checks: [
      { label: 'day-to-day bread price moves smaller', metric: 'breadMove', kind: 'down', tol: 0.15 },
      { label: 'no move above 2 % on any day (whole run)', metric: 'breadMoveMax', kind: 'atMost', level: 0.02, window: (d) => [0, d] },
      { label: 'shortages when it holds the price', metric: 'breadShort', kind: 'up', minAbs: 1 },
    ],
    show: ['breadGross', 'hunger'],
  },
  {
    id: '4',
    name: 'Wage floor far above market',
    arms: [{ name: 'floor 150 %', setup: (g, c) => act(g, { type: 'addLimit', limit: limit({ kind: 'wageMin', value: Math.round(1.5 * c.wage * 100) / 100 }) }, 'wage floor') }],
    checks: [{ label: 'unemployment up', metric: 'unemp', kind: 'up', minAbs: 0.02 }],
    show: ['takeHome', 'employed'],
  },
  {
    id: '5',
    name: 'Window rates to 15 %',
    arms: [{ name: 'window 15 %', setup: (g) => act(g, { type: 'setWindow', reserveRate: 0.15, lendRate: 0.16 }, 'window') }],
    checks: [
      { label: 'credit down', metric: 'credit', kind: 'down', tol: 0.03 },
      { label: 'investment down', metric: 'inv', kind: 'down', tol: 0.03 },
      { label: 'prices lower (less inflation)', metric: 'cpi', kind: 'down', tol: 0.005 },
    ],
    show: ['money', 'unemp'],
  },
  {
    id: '5b',
    name: 'Window rates to 0 %',
    arms: [{ name: 'window 0 %', setup: (g) => act(g, { type: 'setWindow', reserveRate: 0, lendRate: 0.01 }, 'window') }],
    checks: [
      { label: 'credit up', metric: 'credit', kind: 'up', tol: 0.03 },
      { label: 'investment up', metric: 'inv', kind: 'up', tol: 0.03 },
    ],
    show: ['money', 'cpi', 'unemp'],
  },
  {
    id: '17',
    name: 'Capital requirement 3 % (the bank’s capital thinned)',
    // A capital Limit replaces the standing 8 % rule. The founding bank holds some 15 % of its
    // loans and lends as much as its borrowers can carry, so the rule only matters once its capital
    // is scarce: both arms take 60 % of the bank's equity into the Purse on day 0 (to about 7 % of
    // its loans, below the standing rule plus the headroom its standards demand). Under the standing
    // rule it tightens its standards and lends less until retained profit rebuilds its capital; with
    // a 3 % rule in its place it carries on lending.
    arms: [
      { name: 'capital thinned', setup: (g) => thinBank(g) },
      {
        name: 'thinned, 3 % rule',
        setup: (g) => {
          thinBank(g);
          act(g, { type: 'addLimit', limit: limit({ kind: 'capitalMin', value: 0.03 }) }, 'capital rule');
        },
      },
    ],
    checks: [
      { label: 'credit up', metric: 'credit', kind: 'up', tol: 0.02, arm: 'thinned, 3 % rule', vs: 'capital thinned' },
      { label: 'lending standards looser', metric: 'bankStance', kind: 'down', tol: 0.1, arm: 'thinned, 3 % rule', vs: 'capital thinned' },
      { label: 'credit not below the untouched bank’s', metric: 'credit', kind: 'notDown', tol: 0.02, arm: 'thinned, 3 % rule' },
    ],
    show: ['capRatio', 'inv', 'unemp'],
  },
  {
    id: '18',
    name: 'A floor under loan rates 3 points above today’s',
    arms: [
      {
        name: 'loan-rate floor',
        setup: (g) => {
          const r = Math.round(((g.s.stats.latest.loanRate ?? 0.07) + 0.03) * 1000) / 1000;
          act(g, { type: 'addLimit', limit: limit({ kind: 'rateMin', value: r }) }, 'loan-rate floor');
        },
      },
    ],
    checks: [
      // Term loans already made keep their agreed rates: the floor reaches credit lines and new loans.
      { label: 'rates on new loans up', metric: 'newLoanRate', kind: 'up', tol: 0.1 },
      // Dearer new credit: workshops invest less (they judge tools and new workshops against the
      // rate they would borrow at). The stock of credit moves only as the long fixed-rate loans
      // are repaid — far slower than this year-long run.
      { label: 'investment down', metric: 'inv', kind: 'down', tol: 0.05 },
    ],
    show: ['credit', 'loansNew', 'money'],
  },
  {
    id: '6',
    name: 'Paved road farm town ↔ capital',
    days: (o) => Math.max(o.days, 540),
    arms: [{ name: 'paved road', setup: (g, c) => act(g, { type: 'build', kind: 'road', from: c.farm, to: c.capital }, 'road') }],
    checks: [{ label: 'grain price gap narrows', metric: 'grainGap', kind: 'down', tol: 0.05 }],
    show: ['roadLeft', 'freight'],
    note: (r) => {
      const left = r.arms['paved road']?.roadLeft;
      return left && left.length ? `unpaved tiles left at the end: ${left[left.length - 1].toFixed(0)} (of ${r.arms.baseline?.roadLeft?.[0]?.toFixed(0) ?? '?'})` : '';
    },
  },
  {
    id: '7a',
    name: 'Big Treasury buy order for tools',
    arms: [
      {
        name: 'Treasury buys tools',
        setup: (g, c) =>
          act(g, { type: 'placeOrder', market: { kind: 'good', town: c.capital, good: G.tools }, side: 'buy', price: Math.round(2 * c.price[c.capital][G.tools] * 100) / 100, qty: Math.max(1, 0.5 * c.natVol[G.tools]) }, 'buy order'),
      },
    ],
    checks: [{ label: 'tools price up', metric: 'toolsPrice', kind: 'up', tol: 0.03 }],
  },
  {
    id: '7b',
    name: 'Big Treasury sale of tools below market',
    // Stock up for 30 days, wait, then sell at 60 % of the pre-experiment price from day 120.
    window: () => [150, 240],
    arms: [
      {
        name: 'Treasury sells tools',
        setup: (g, c) =>
          act(g, { type: 'placeOrder', market: { kind: 'good', town: c.capital, good: G.tools }, side: 'buy', price: Math.round(1.5 * c.price[c.capital][G.tools] * 100) / 100, qty: Math.max(1, 0.6 * c.natVol[G.tools]), days: 30 }, 'stock-up order'),
        hook: (g, c, d) => {
          if (d !== 120) return;
          const have = g.s.treasury.goods[c.capital]?.[G.tools] ?? 0;
          if (!(have > 0)) return;
          act(g, { type: 'placeOrder', market: { kind: 'good', town: c.capital, good: G.tools }, side: 'sell', price: Math.round(0.6 * c.price[c.capital][G.tools] * 100) / 100, qty: have / 120 }, 'sell order');
        },
      },
    ],
    checks: [{ label: 'tools price down while selling', metric: 'toolsPrice', kind: 'down', tol: 0.03 }],
  },
  {
    id: '8',
    name: 'Levy on oil → dearer shipping',
    arms: [{ name: 'oil levy 100 %', setup: (g) => act(g, { type: 'addLevy', levy: levy({ base: 'sale', unit: 'pct', rate: 1, payer: 'buyer', good: G.oil }) }, 'oil levy') }],
    checks: [{ label: 'shipping rate up', metric: 'freight', kind: 'up', tol: 0.03 }],
  },
  {
    id: '9',
    name: 'Import levy → dearer imports at the port',
    arms: [{ name: 'import levy 50 %', setup: (g, c) => act(g, { type: 'addLevy', levy: levy({ base: 'import', unit: 'pct', rate: 0.5, payer: 'buyer', good: c.importGood }) }, 'import levy') }],
    checks: [{ label: 'port price of the imported good up', metric: 'importPrice', kind: 'up', tol: 0.03 }],
    show: ['importQty'],
    note: (_r, c) => c.importNote,
  },
  {
    id: '10',
    name: 'Wage levy on workers vs on employers (incidence)',
    // Long-run equivalence: wages are slow to fall, so give them several years.
    days: (o) => Math.max(o.days, 1440),
    arms: [
      // Both arms hand the revenue back as the same per-head payment, so the only
      // difference between them is who hands the levy over (not how much money leaves circulation).
      {
        name: 'worker pays 20 %',
        setup: (g, c) => {
          act(g, { type: 'addLevy', levy: levy({ base: 'wage', unit: 'pct', rate: 0.2, payer: 'worker' }) }, 'worker-side wage levy');
          act(g, { type: 'addLevy', levy: levy({ base: 'head', unit: 'flat', dir: -1, rate: Math.round(0.2 * c.wage * 0.9 * 100) / 100, payer: 'receiver' }) }, 'per-head payment');
        },
      },
      {
        name: 'employer pays 20 %',
        setup: (g, c) => {
          act(g, { type: 'addLevy', levy: levy({ base: 'wage', unit: 'pct', rate: 0.2, payer: 'employer' }) }, 'employer-side wage levy');
          act(g, { type: 'addLevy', levy: levy({ base: 'head', unit: 'flat', dir: -1, rate: Math.round(0.2 * c.wage * 0.9 * 100) / 100, payer: 'receiver' }) }, 'per-head payment');
        },
      },
    ],
    checks: [
      { label: 'similar real take-home pay', metric: 'takeHomeReal', kind: 'similar', arm: 'worker pays 20 %', vs: 'employer pays 20 %', tol: 0.05 },
      { label: 'similar employment', metric: 'employed', kind: 'similar', arm: 'worker pays 20 %', vs: 'employer pays 20 %', tol: 0.05 },
    ],
    show: ['takeHome', 'cpi', 'employed'],
  },
  {
    id: '11',
    name: 'Supply route: bread from the farm town to the harbor at landed cost',
    // The Treasury buys about the harbour's daily bread trade in the farm town (at up to 25 %
    // over the going price there: headroom as prices drift through the year), carries it on its
    // wagons and offers it at the harbour at what it cost to buy and carry: the harbour's bread
    // price falls toward that landed cost. Judged over the whole run: the harbour has one bakery
    // or none, which the Treasury's bread can crowd out and which may reopen later, so the last
    // months alone depend on when that happens.
    window: (d) => [30, d],
    arms: [
      {
        name: 'supply route',
        setup: (g, c) =>
          act(
            g,
            {
              type: 'placeOrder',
              market: { kind: 'good', town: c.farm, good: G.bread },
              side: 'buy',
              price: Math.round(1.25 * c.price[c.farm][G.bread] * 100) / 100,
              qty: Math.max(10, Math.round(c.vol[c.harbor][G.bread])),
              route: { to: c.harbor, sell: 'cost' },
            },
            'supply route',
          ),
      },
    ],
    checks: [{ label: 'harbour bread price down (whole run)', metric: 'harborBread', kind: 'down', tol: 0.01 }],
    show: ['farmBread', 'routeSold'],
  },
  {
    id: '12',
    name: 'Pay 40% of the price of tools bought by coal mines',
    // A targeted sale rule: only the coal mines' own purchases of tools carry it. Cheaper tools
    // lower the mines' costs, so they plan more output (more hands, and the tools to equip them).
    arms: [
      {
        name: 'tools for coal mines',
        setup: (g) => act(g, { type: 'addLevy', levy: levy({ base: 'sale', unit: 'pct', dir: -1, rate: 0.4, payer: 'buyer', good: G.tools, sector: 'coalmine' }) }, 'targeted payment'),
      },
    ],
    checks: [
      { label: "coal mines' tools up", metric: 'coalTools', kind: 'up', tol: 0.01 },
      { label: 'coal output up', metric: 'coalProd', kind: 'up', tol: 0.01 },
      // Other towns' tools prices swing ±5 % from month to month in both arms (the trade is
      // cyclical and toolworks open and close at different times), so this is judged over the
      // whole run: the payment reaches only the mines' own purchases, it must not cheapen tools for others.
      { label: 'tools price elsewhere not lower (whole run)', metric: 'toolsElsewhere', kind: 'notDown', tol: 0.02, window: (d) => [30, d] },
    ],
    show: ['coalWorkers', 'giveSpend'],
  },
  {
    id: '13',
    name: 'Hand 3 tools to every coal mine in the mining town',
    // The Treasury buys the tools where they are made (the capital; the mining town's own tools
    // market is too thin to fill the order without taking them from the mines), carries them to
    // the mining town and hands 3 sets to every coal mine there the day they arrive.
    // The mines already hold all the tools their hands can use (tools are complements to labour
    // and no firm in this economy runs short of them), so the gift raises their stock of tools
    // and displaces their own purchases for a while; it does not change what they dig — unlike
    // experiment 12, which lowers the cost of every tool they use and so their marginal cost.
    window: () => [2, 92],
    arms: [
      {
        name: 'tools handed out',
        setup: (g, c) => {
          const mines = g.s.firms.filter((f) => f && f.alive && f.status === 'active' && f.sector === 'coalmine' && f.town === c.mining).length;
          act(g, { type: 'placeOrder', market: { kind: 'good', town: c.capital, good: G.tools }, side: 'buy', price: Math.round(1.5 * c.price[c.capital][G.tools] * 100) / 100, qty: 3 * Math.max(1, mines), once: true }, 'buy tools');
        },
        hook: (g, c, d) => {
          const tg = g.s.treasury.goods;
          if (d === 1 && tg[c.capital][G.tools] > 0) act(g, { type: 'moveGoods', from: c.capital, to: c.mining, good: G.tools, qty: tg[c.capital][G.tools] }, 'carry tools');
          if (d >= 2 && tg[c.mining][G.tools] > 0.5 && !g.s.shipments.some((sh) => sh.owner === -1 && sh.to === c.mining && sh.good === G.tools))
            act(g, { type: 'transfer', group: 'firms', town: c.mining, amount: 3, dir: 1, good: G.tools, sector: 'coalmine' }, 'hand out tools');
        },
      },
    ],
    checks: [
      // The handout lands on day 2; the mines then skip buying until wear brings their stock back
      // to what their hands can use (a few days for 3 sets each).
      { label: "coal mines' tools up (days 2–5)", metric: 'miningCoalTools', kind: 'up', tol: 0.02, window: () => [2, 5] },
      { label: 'their own tools purchases down (month)', metric: 'miningCoalSpend', kind: 'down', tol: 0.05, window: () => [2, 32] },
      { label: 'coal output unchanged (±2 %: not short of tools)', metric: 'miningCoalOut', kind: 'similar', tol: 0.02 },
    ],
  },
  {
    id: '14',
    name: 'Aim what households pay for bread at 90% of today’s price, town by town',
    // An aimed sale rule: each morning its rate re-sets in each town so that households pay about
    // the aim there (the dearer the town, the higher its rate). Bread gets cheaper for households
    // relative to everything else, and the price they pay converges across towns. The payments are
    // minted (auto-mint), so every price drifts up and the rates follow it to their ceiling.
    arms: [
      {
        name: 'aimed bread rule',
        setup: (g, c) => {
          const avg = meanOver(c.price.map((row) => row[G.bread]));
          act(g, { type: 'addLevy', levy: { ...levy({ base: 'sale', unit: 'pct', dir: -1, rate: 0, payer: 'buyer', good: G.bread, group: 'persons' }), aim: Math.round(avg * 0.9 * 100) / 100, aimMax: 0.3 } }, 'aimed bread rule');
        },
      },
    ],
    checks: [
      { label: 'bread cheaper for households (÷ CPI)', metric: 'hhBreadRel', kind: 'down', tol: 0.05 },
      // Judged over the first months: later the minted payments lift every price and the rates
      // reach their 30 % ceiling in every town, where one rate for all no longer closes the gaps.
      { label: 'bread price households pay closer across towns (days 15–120)', metric: 'hhBreadSpread', kind: 'down', tol: 0.05, window: () => [15, 120] },
    ],
    show: ['giveSpend', 'cpi'],
  },
  {
    id: '15',
    name: 'Treasury freight line farm town ↔ capital, free fares',
    // The Treasury keeps wagons in the capital, drives them with its own workers and buys their
    // oil, and carries the trading houses' goods between the two towns for nothing. Their freight
    // on that road falls to zero (up to the line's room), so they buy grain in the farm town and
    // sell it in the capital down to a smaller gap: the gap narrows through their arbitrage.
    // The Purse pays the drivers, the fuel and the wagons' wear.
    days: (o) => Math.max(o.days, 360),
    arms: [
      {
        name: 'free freight line',
        setup: (g, c) => {
          // Room for about twice the grain the capital buys a day (whole wagons, round trips of a day or so).
          const wagons = Math.max(3, Math.min(12, Math.round((2 * c.vol[c.capital][G.grain]) / 120) + 2));
          act(g, { type: 'openLine', a: c.capital, b: c.farm, wagons, fare: 'free' }, 'freight line');
        },
      },
    ],
    checks: [
      { label: 'grain price gap narrows', metric: 'grainGap', kind: 'down', tol: 0.05 },
      { label: 'the line carries goods', metric: 'lineUnits', kind: 'persistent', level: 1 },
      { label: 'the Purse pays its running costs', metric: 'lineGap', kind: 'positive' },
    ],
    show: ['capitalGrain', 'farmGrain', 'lineCost', 'carters', 'unemp', 'freight'],
  },
];

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------
interface Results {
  days: number;
  window: [number, number];
  arms: Record<string, Record<string, number[]>>;
}

function runArm(json: string, c: Ctx, arm: Arm | null, days: number, metrics: string[], label: string, verbose: boolean): Record<string, number[]> {
  const g = Game.load(json);
  const out: Record<string, number[]> = {};
  for (const k of metrics) out[k] = [];
  const t0 = performance.now();
  if (arm?.setup) arm.setup(g, c);
  for (let d = 0; d < days; d++) {
    if (arm?.hook) arm.hook(g, c, d);
    g.step(1);
    for (const k of metrics) {
      const v = METRICS[k].fn(g.s, c);
      out[k].push(Number.isFinite(v) ? v : 0);
    }
  }
  if (verbose) console.error(`  ${label}: ${days} days in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return out;
}

function windowMean(a: readonly number[] | undefined, w: [number, number]): number {
  if (!a || a.length === 0) return 0;
  const from = Math.max(0, Math.min(w[0], a.length - 1));
  const to = Math.max(from + 1, Math.min(w[1], a.length));
  let x = 0;
  for (let i = from; i < to; i++) x += a[i];
  return x / (to - from);
}

interface Verdict {
  exp: Experiment;
  check: Check;
  ref: number;
  val: number;
  delta: number; // relative
  pass: boolean;
  refName: string;
  armName: string;
}

function judge(exp: Experiment, check: Check, res: Results): Verdict {
  const armName = check.arm ?? exp.arms[0].name;
  const refName = check.vs ?? 'baseline';
  const A = res.arms[armName]?.[check.metric];
  const B = res.arms[refName]?.[check.metric];
  const win = check.window ? check.window(res.days) : res.window;
  const val = windowMean(A, win);
  const ref = windowMean(B, win);
  const scale = Math.max(Math.abs(ref), 1e-9);
  const delta = (val - ref) / scale;
  // up/down: the move must beat the relative threshold, or the absolute one when given
  // (a check with only `minAbs` is judged on the absolute move alone).
  const tolRel = check.tol ?? (check.minAbs === undefined ? 0.01 : Infinity);
  const meets = (d: number): boolean => d > 0 && (d / scale >= tolRel || (check.minAbs !== undefined && d >= check.minAbs));
  let pass = false;
  switch (check.kind) {
    case 'up':
      pass = meets(val - ref);
      break;
    case 'down':
      pass = meets(ref - val);
      break;
    case 'notDown':
      pass = (val - ref) / scale >= -(check.tol ?? 0.01);
      break;
    case 'similar':
      pass = Math.abs(val - ref) / Math.max(Math.abs(val), Math.abs(ref), 1e-9) <= (check.tol ?? 0.05);
      break;
    case 'positive':
      pass = val > 1e-9;
      break;
    case 'persistent': {
      const lvl = check.level ?? 0;
      let n = 0;
      let hit = 0;
      if (A) {
        const from = Math.max(0, win[0]);
        const to = Math.min(A.length, win[1]);
        for (let i = from; i < to; i++) {
          n++;
          if (A[i] > lvl) hit++;
        }
      }
      pass = n > 0 && hit / n >= 0.8;
      break;
    }
    case 'atMost': {
      // every day of the window at or below the level (the reported value is the window's largest)
      const lvl = check.level ?? 0;
      const top = (x: readonly number[] | undefined): number => {
        let t = -Infinity;
        if (x) for (let i = Math.max(0, win[0]); i < Math.min(x.length, win[1]); i++) t = Math.max(t, x[i]);
        return t;
      };
      const tA = top(A);
      const tB = top(B);
      pass = Number.isFinite(tA) && tA <= lvl + 1e-9;
      const r0 = Number.isFinite(tB) ? tB : 0;
      const v0 = Number.isFinite(tA) ? tA : 0;
      return { exp, check, ref: r0, val: v0, delta: (v0 - r0) / Math.max(Math.abs(r0), 1e-9), pass, refName, armName };
    }
  }
  return { exp, check, ref, val, delta, pass, refName, armName };
}

function fmt(x: number): string {
  const a = Math.abs(x);
  if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (x / 1e3).toFixed(1) + 'k';
  if (a >= 100) return x.toFixed(1);
  if (a >= 1) return x.toFixed(3);
  return x.toFixed(4);
}

function pad(s: string, w: number, right = false): string {
  if (s.length > w) return s.slice(0, w - 1) + '…';
  return right ? s.padStart(w) : s.padEnd(w);
}

function main(): void {
  const o = parseArgs(process.argv.slice(2));
  // --only: exact ids first (e.g. "7a"), then id prefixes ("7" → 7a, 7b), then name substrings.
  const byId = EXPERIMENTS.filter((e) => e.id.toLowerCase() === o.only);
  const byPrefix = EXPERIMENTS.filter((e) => /^\d+$/.test(o.only) && e.id.toLowerCase().replace(/[a-z]+$/, '') === o.only);
  const selected = !o.only ? EXPERIMENTS : byId.length ? byId : byPrefix.length ? byPrefix : EXPERIMENTS.filter((e) => e.name.toLowerCase().includes(o.only));
  if (selected.length === 0) {
    console.error(`experiments: nothing matches "${o.only}"`);
    process.exit(1);
  }
  const t0 = performance.now();
  console.error(`Building the realm (seed ${o.seed}) and running the ${WARMUP_DAYS}-day warm-up…`);
  const game = Game.create({ seed: o.seed });
  act(game, { type: 'setEvents', value: false }, 'events off');
  act(game, { type: 'setAutoMint', value: true }, 'auto-mint');
  game.step(o.pre);
  const json = game.save();
  const ctx = observe(game.s);
  console.error(`base state ready on day ${game.s.day} in ${((performance.now() - t0) / 1000).toFixed(1)} s (${(json.length / 1e6).toFixed(1)} MB); ${ctx.importNote}`);

  // Baseline: once, as long as the longest experiment, with every metric any experiment needs.
  const lengths = selected.map((e) => (e.days ? e.days(o) : o.days));
  const maxDays = Math.max(...lengths);
  const allMetrics = new Set<string>();
  for (const e of selected) {
    for (const c of e.checks) allMetrics.add(c.metric);
    for (const m of e.show ?? []) allMetrics.add(m);
  }
  const metricList = [...allMetrics];
  console.error(`baseline: ${maxDays} days…`);
  const baseline = runArm(json, ctx, null, maxDays, metricList, 'baseline', true);

  const verdicts: Verdict[] = [];
  const notes: string[] = [];
  for (const exp of selected) {
    const days = exp.days ? exp.days(o) : o.days;
    const window = exp.window ? exp.window(days) : ([Math.max(0, days - 90), days] as [number, number]);
    const metrics = [...new Set([...exp.checks.map((c) => c.metric), ...(exp.show ?? [])])];
    const res: Results = { days, window, arms: { baseline: {} } };
    for (const k of metrics) res.arms.baseline[k] = baseline[k].slice(0, days);
    console.error(`[${exp.id}] ${exp.name}`);
    for (const arm of exp.arms) {
      try {
        res.arms[arm.name] = runArm(json, ctx, arm, days, metrics, arm.name, true);
      } catch (e) {
        console.error(`  ${arm.name}: FAILED TO RUN — ${e instanceof Error ? e.message : String(e)}`);
        res.arms[arm.name] = {};
      }
    }
    for (const c of exp.checks) verdicts.push(judge(exp, c, res));
    if (o.verbose && exp.show) {
      for (const m of exp.show) {
        const parts = Object.keys(res.arms).map((a) => `${a} ${fmt(windowMean(res.arms[a][m], window))}`);
        notes.push(`[${exp.id}] ${METRICS[m].label}: ${parts.join(' · ')}`);
      }
    }
    const n = exp.note?.(res, ctx);
    if (n) notes.push(`[${exp.id}] ${n}`);
  }

  // ---- report ----
  const W = { id: 4, name: 34, check: 36, ref: 11, val: 11, d: 8, r: 5 };
  const line = (cols: string[]) => console.log(cols.join('  '));
  console.log('');
  line([pad('#', W.id), pad('experiment', W.name), pad('check', W.check), pad('reference', W.ref, true), pad('treatment', W.val, true), pad('Δ %', W.d, true), pad('', W.r)]);
  line(['-'.repeat(W.id), '-'.repeat(W.name), '-'.repeat(W.check), '-'.repeat(W.ref), '-'.repeat(W.val), '-'.repeat(W.d), '-'.repeat(W.r)]);
  let last = '';
  for (const v of verdicts) {
    const first = v.exp.id !== last;
    last = v.exp.id;
    const d = Math.abs(v.ref) > 1e-9 ? (100 * v.delta).toFixed(1) : v.val > 0 ? '+∞' : '0.0';
    const lbl = v.refName === 'baseline' ? v.check.label : `${v.check.label} (${v.armName} vs ${v.refName})`;
    line([pad(first ? v.exp.id : '', W.id), pad(first ? v.exp.name : '', W.name), pad(lbl, W.check), pad(fmt(v.ref), W.ref, true), pad(fmt(v.val), W.val, true), pad(d, W.d, true), v.pass ? 'PASS' : 'FAIL']);
  }
  if (notes.length) {
    console.log('');
    for (const n of notes) console.log(n);
  }
  const passed = verdicts.filter((v) => v.pass).length;
  const expPassed = selected.filter((e) => verdicts.filter((v) => v.exp === e).every((v) => v.pass)).length;
  console.log('');
  console.log(`${passed}/${verdicts.length} checks passed; ${expPassed}/${selected.length} experiments fully passed (seed ${o.seed}, window = last 90 days unless noted, ${((performance.now() - t0) / 1000).toFixed(0)} s).`);
}

try {
  main();
} catch (e) {
  console.error(`experiments: crashed — ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
}
