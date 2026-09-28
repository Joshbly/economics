// ============================================================================
// Statistics: indicators, daily & monthly series, national accounts, CPI.
// OWNER: stats agent. See DESIGN §7.
//
// Naming: <good> is the numeric GoodId (e.g. price_8 = bread), <town> the numeric
// TownId, <sector> the sector key (firms_bakery). ¤ flows are per day.
//
// Series keys (daily and monthly) — the UI depends on these names:
//   Prices   cpi (national CPI, base 100), cpi_<town>, infl30 (annualised change of
//            the CPI over 30 days), inflYoY (change over 360 days), price_<good>
//            (national base price, weighted by smoothed volume), gross_<good> (the
//            same for the price buyers pay incl. levies), rent (avg rent per occupied
//            slot per day), deflator (gdpNominal / gdpReal × 100)
//   Output   gdpReal (production approach at stats.basePrices: goods value added +
//            construction labour + transport + housing services + Treasury workers),
//            gdpNominal (expenditure: cons + rentPaid + imputed owner rent + inv + gov
//            + netExports), cons (household goods spending, gross), rentPaid,
//            inv (tools bought by firms other than builders + construction billed to
//            private owners), gov (Treasury goods bought − sold + Treasury workers'
//            wages + Treasury construction), netExports, prod_<good> (units made),
//            cons_<good> (units bought by households), vol_<good> (units traded),
//            shortage_<good> (units of demand rationed away), imp_<good>, exp_<good>
//            (port trade, tradable goods only), imports, exports, tradeBal (¤ at base)
//   Labour   unemp (rate: jobless / population — every household is a worker),
//            employed, unemployed, vacancies, wage (employment-weighted posted wage),
//            realWage (wage / CPI × 100), hires, fires, quits
//   People   pop, births, deaths, starved, immigrants, emigrants, hunger (share with
//            food satisfaction < HUNGRY_BELOW), cold (share with heat < COLD_BELOW),
//            homeless (count), homelessRate, evictions, health, content (means)
//   Money    money (Σ deposits), reserves, credit (loans), bankEquity, capRatio
//            (equity / loans), loanRate (principal-weighted, else bank base rate),
//            baseRate, depRate, windowDebt, reserveRate, lendRate (the window),
//            writeoffs, iouPrice, iouYield, iouOut, goldPrice, treasuryGold
//   Treasury purse, minted (cumulative), mintDay (created today), levyTake, levyGive,
//            levyNet, transferGive, transferTake, treasuryIncome, treasurySpend
//            (Σ positive / negative categories of treasury.flows today)
//   Firms    firms (active, excl. Treasury works), firms_<sector>, bankrupt (firms
//            that stopped trading today: bankruptcy or exit), newFirms,
//            freight (shipping rate: ¤ per unit per 10 tiles), strikes (towns on strike)
//   Monthly only: gini (wealth: cash + IOUs + gold + owned firms' and houses' book
//            value − debts), giniIncome (disposable income EMA), top10 (wealth share
//            of the richest STATS_TOP_SHARE).
// Monthly values: the month's mean of the daily values, except stocks (money,
// reserves, credit, bankEquity, windowDebt, iouOut, purse, minted, treasuryGold,
// pop, firms, firms_<sector>: end of month) and event counts (births, deaths,
// starved, immigrants, emigrants, bankrupt, newFirms, hires, fires, quits,
// evictions: month total).
// stats.latest mirrors the newest value of every daily key plus: day, year, month,
// and the monthly-only keys. `infl30Carry` / `inflYoYCarry` hold the inflation
// carried across a re-base (used until enough history exists).
//
// stats.acc keys read (all optional, missing = 0): prod_<good>, realva (value added
// at base prices, if firms record it), event_va, build_labor, build_labor_state
// (Treasury workers' labour on projects, if construction records it), freight_cost,
// consval, cons_<good>, vol_<good>, shortage_<good>, imp_<good>, exp_<good>, impval,
// expval, gov_goods, gov_goods_sold, flow_rent, flow_build, inv_tools (tools
// investment ¤, if firms record it; otherwise read from today's tools books),
// levy_take, levy_give, transfer_give, transfer_take, writeoffs, births, deaths,
// starved, immigrants, emigrants, hires, fires, quits, evictions.
// ============================================================================
import {
  BASE_RENT_SHARE,
  BASE_WAGE,
  COLD_BELOW,
  DAYS_PER_MONTH,
  DAYS_PER_YEAR,
  HUNGRY_BELOW,
  INIT_GOLD_PRICE,
  INIT_UNEMPLOYMENT,
  IOU_COUPON,
  IOU_PAR,
  OIL_PER_TILE,
  SPEED_DIRT,
  STATS_DAILY_CAP,
  STATS_INFL_MIN_SPAN,
  STATS_INFL_WINDOW,
  STATS_SIG_DIGITS,
  STATS_TOP_SHARE,
  WAGON_CAPACITY,
  WAGON_WEAR_DAY,
} from '../config';
import { ALL_SECTORS, CONSUMER_GOODS, G, N_GOODS, PRODUCER_OF, SECTORS, TRADABLE_GOODS } from '../goods';
import { deposits } from '../ledger';
import { steadyStateDemand } from '../agents/demandModel';
import { basePrices as foundingPrices } from '../agents/production';
import { freightPerUnit } from '../agents/traders';
import { routeBetweenTowns } from '../world/paths';
import { expectedGross, type Books } from '../market/markets';
import { isMonthEnd, monthOf, yearOf } from '../calendar';
import { rt } from '../runtime';
import { FIRM_BASE, type SimState, type Stats } from '../types';
import { clamp, fin, gini } from '../util';

// ---------------------------------------------------------------------------
// Keys (precomputed: no string building in the daily path)
// ---------------------------------------------------------------------------
const perGood = (p: string): string[] => Array.from({ length: N_GOODS }, (_, g) => p + g);
const K_PROD = perGood('prod_');
const K_CONS = perGood('cons_');
const K_VOL = perGood('vol_');
const K_SHORT = perGood('shortage_');
const K_IMP = perGood('imp_');
const K_EXP = perGood('exp_');
const K_PRICE = perGood('price_');
const K_GROSS = perGood('gross_');
const FIRM_SECTORS = ALL_SECTORS.filter((k) => k !== 'stateworks');
const K_FIRMS = FIRM_SECTORS.map((k) => 'firms_' + k);

type Mode = 'avg' | 'sum' | 'end';
const END_KEYS = new Set(['money', 'reserves', 'credit', 'bankEquity', 'windowDebt', 'iouOut', 'purse', 'minted', 'treasuryGold', 'pop', 'firms', ...K_FIRMS]);
const SUM_KEYS = new Set(['births', 'deaths', 'starved', 'immigrants', 'emigrants', 'bankrupt', 'newFirms', 'hires', 'fires', 'quits', 'evictions']);

/** How a daily key is folded into its monthly value. */
export function monthMode(key: string): Mode {
  if (END_KEYS.has(key)) return 'end';
  if (SUM_KEYS.has(key)) return 'sum';
  return 'avg';
}

const MACC_DAYS = '_days';

// ---------------------------------------------------------------------------
// Runtime cache (rebuildable; never serialised)
// ---------------------------------------------------------------------------
interface StatsCache {
  /** Per firm id: 1 trading last statsStep, 0 not, −1 unknown (bankruptcy detection). */
  prevActive: Int8Array;
  prevDay: number;
  /** acc / treasury.flows as they stood at the end of the last statsStep (carry of between-day flows). */
  snapDay: number;
  snapAcc: Record<string, number> | null;
  snapFlows: Record<string, number> | null;
  // per-town scratch
  pop: Float64Array;
  employed: Float64Array;
  homeless: Float64Array;
  content: Float64Array;
  health: Float64Array;
  vac: Float64Array;
  wageSum: Float64Array;
  wageN: Float64Array;
  slots: Float64Array;
  vacSlots: Float64Array;
  occRent: Float64Array;
  occN: Float64Array;
  askRent: Float64Array;
  prices: number[];
}

function statsCache(s: SimState): StatsCache {
  const bag = rt(s).bag;
  let c = bag.stats as StatsCache | undefined;
  const nT = s.towns.length;
  if (!c || c.pop.length !== nT) {
    const z = () => new Float64Array(nT);
    c = {
      prevActive: new Int8Array(0),
      prevDay: -2,
      snapDay: -2,
      snapAcc: null,
      snapFlows: null,
      pop: z(),
      employed: z(),
      homeless: z(),
      content: z(),
      health: z(),
      vac: z(),
      wageSum: z(),
      wageN: z(),
      slots: z(),
      vacSlots: z(),
      occRent: z(),
      occN: z(),
      askRent: z(),
      prices: new Array(N_GOODS).fill(0),
    };
    bag.stats = c;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Small pure helpers (exported for tests and other modules)
// ---------------------------------------------------------------------------

/** Round to STATS_SIG_DIGITS significant digits (compact JSON). Non-finite → 0. */
export function roundSig(x: number, digits = STATS_SIG_DIGITS): number {
  if (!Number.isFinite(x) || x === 0) return 0;
  const a = Math.abs(x);
  const e = Math.floor(Math.log10(a));
  const d = digits - 1 - e;
  if (d <= 0) return Math.round(x);
  const m = Math.pow(10, Math.min(d, 15));
  return Math.round(x * m) / m;
}

/** Annualised rate from a price ratio over `days` days (compounded; 360-day year). Clamped to [−0.99, 50]. */
export function annualise(ratio: number, days: number): number {
  if (!(ratio > 0) || !(days > 0) || !Number.isFinite(ratio)) return 0;
  const lr = (DAYS_PER_YEAR / days) * Math.log(ratio); // log space: no overflow
  if (lr > Math.log(51)) return 50;
  return clamp(Math.exp(lr) - 1, -0.99, 50);
}

function meanRange(a: readonly number[], from: number, to: number): number {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, from); i <= to && i < a.length; i++) {
    sum += a[i];
    n++;
  }
  return n > 0 ? sum / n : 0;
}

/**
 * Annual inflation from a daily index history (`hist`, oldest first, today last)
 * over `lag` days, comparing trailing means of `win` values at both ends (damps
 * day-to-day auction noise). With less than `lag` days of history the rate over
 * the available span is blended with `carry` in proportion span/lag; below
 * `minSpan` days only `carry` is returned.
 */
export function inflationRate(hist: readonly number[], lag: number, win = STATS_INFL_WINDOW, carry = 0, minSpan = STATS_INFL_MIN_SPAN): number {
  const n = hist.length;
  const last = n - 1;
  const w = Math.max(1, Math.floor(win));
  if (last >= lag + w - 1) {
    const a = meanRange(hist, last - w + 1, last);
    const b = meanRange(hist, last - lag - w + 1, last - lag);
    return b > 0 ? annualise(a / b, lag) : carry;
  }
  // partial history: compare the newest and oldest windows
  const ww = Math.max(1, Math.min(w, Math.floor(n / 3)));
  const span = last - (ww - 1);
  if (span < minSpan) return carry;
  const a = meanRange(hist, last - ww + 1, last);
  const b = meanRange(hist, 0, ww - 1);
  if (!(b > 0)) return carry;
  const partial = annualise(a / b, span);
  const k = clamp(span / lag, 0, 1);
  return carry + k * (partial - carry);
}

/** Share of the total held by the top `share` of values (negatives count as 0). */
export function topShare(values: readonly number[], share = STATS_TOP_SHARE): number {
  const v = values.map((x) => (x > 0 ? x : 0)).sort((a, b) => b - a);
  let tot = 0;
  for (const x of v) tot += x;
  if (!(tot > 0)) return 0;
  const k = Math.max(1, Math.round(v.length * share));
  let top = 0;
  for (let i = 0; i < k && i < v.length; i++) top += v[i];
  return top / tot;
}

/** Price a consumer in town `t` expects to pay for good `g` (smoothed market price incl. buyer levies). */
export function consumerPrice(s: SimState, t: number, g: number): number {
  const m = s.markets[t * N_GOODS + g];
  if (!m) return fin(s.stats.basePrices[g], 1) || 1;
  const e = fin(expectedGross(s, t, g));
  if (e > 0) return e;
  const gr = fin(m.gross);
  return gr > 0 ? gr : m.ema > 0 ? m.ema : 1;
}

/** Cost of the CPI basket in town t at consumer prices, with `rent` per slot per day. */
export function basketCost(s: SimState, t: number, rent: number): number {
  const st = s.stats;
  let c = fin(st.basketRent) * Math.max(0, fin(rent));
  for (const g of CONSUMER_GOODS) c += fin(st.basket[g]) * consumerPrice(s, t, g);
  return c;
}

/**
 * National price vector: each good's town prices weighted by the markets' smoothed
 * volume (equal weights when nothing has traded). `field` picks the market price.
 */
export function nationalPrices(s: SimState, field: 'ema' | 'price' | 'gross', out: number[] = new Array(N_GOODS).fill(0)): number[] {
  const nT = s.towns.length;
  for (let g = 0; g < N_GOODS; g++) {
    let num = 0;
    let den = 0;
    let sum = 0;
    let cnt = 0;
    for (let t = 0; t < nT; t++) {
      const m = s.markets[t * N_GOODS + g];
      if (!m) continue;
      let v = fin(m[field]);
      if (!(v > 0)) v = fin(m.ema);
      if (!(v > 0)) continue;
      const w = fin(m.volEma);
      if (w > 0) {
        num += w * v;
        den += w;
      }
      sum += v;
      cnt++;
    }
    out[g] = den > 1e-9 ? num / den : cnt > 0 ? sum / cnt : fin(s.stats.basePrices[g]);
  }
  return out;
}

/** Value added per unit of each good at the given prices (output − materials). */
export function unitValueAdded(prices: readonly number[]): number[] {
  const out = new Array(N_GOODS).fill(0);
  for (let g = 0; g < N_GOODS; g++) {
    const k = PRODUCER_OF[g];
    let v = fin(prices[g]);
    if (k) for (const [j, a] of SECTORS[k].inputs) v -= a * fin(prices[j]);
    out[g] = v;
  }
  return out;
}

/**
 * Freight index: ¤ per unit per 10 tiles. Wagon-weighted mean of the trading houses'
 * freight EMAs; if none has shipped yet, the average quote (traders.freightPerUnit
 * per tile of route) over all town pairs; failing that, a cost estimate from
 * wages, oil and wagon wear on a dirt track.
 */
export function freightIndex(s: SimState): number {
  let w = 0;
  let sum = 0;
  for (const f of s.firms) {
    if (!f || !f.alive || !f.trade) continue;
    const e = fin(f.trade.freightEma);
    const n = Math.max(1, fin(f.trade.wagons));
    if (e > 0) {
      sum += e * n;
      w += n;
    }
  }
  if (w > 0) return (10 * sum) / w;
  const q = routeQuote(s);
  if (q > 0) return q;
  return costFreight(s);
}

function routeQuote(s: SimState): number {
  const nT = s.towns.length;
  let sum = 0;
  let n = 0;
  try {
    for (let a = 0; a < nT; a++) {
      for (let b = 0; b < nT; b++) {
        if (a === b) continue;
        const f = fin(freightPerUnit(s, a, b));
        const len = fin(routeBetweenTowns(s, a, b)?.length);
        if (f > 0 && len > 0) {
          sum += (10 * f) / len;
          n++;
        }
      }
    }
  } catch {
    return 0;
  }
  return n > 0 ? sum / n : 0;
}

/** Round-trip cost of one wagon per tile on a dirt track, per unit carried, × 10 tiles. */
function costFreight(s: SimState): number {
  const p = nationalPrices(s, 'ema');
  const wage = fin(s.stats.baseWage) > 0 ? s.stats.baseWage : BASE_WAGE;
  const daysPerTile = 2 / SPEED_DIRT;
  const perTile = wage * daysPerTile + 2 * OIL_PER_TILE * fin(p[G.oil], 1) + WAGON_WEAR_DAY * daysPerTile * fin(p[G.tools], 1);
  return (10 * perTile) / Math.max(1, WAGON_CAPACITY);
}

/**
 * Tools investment today (¤): what firms other than builders (whose tools are mostly
 * project materials, counted in construction) paid for tools. Uses acc.inv_tools
 * when a module records it; otherwise reads today's settled tools books (the pooled
 * books of market/markets.ts keep today's fills until the next openBooks). A book is
 * used only if its fills add up to the market's recorded volume (i.e. it is today's).
 */
export function toolsInvestment(s: SimState): number {
  const recorded = s.stats.acc.inv_tools;
  if (typeof recorded === 'number' && Number.isFinite(recorded)) return Math.max(0, recorded);
  const books = rt(s).bag.marketBooks as Books | undefined;
  if (!books || !books.goods) return 0;
  let inv = 0;
  for (let t = 0; t < s.towns.length; t++) {
    const m = s.markets[t * N_GOODS + G.tools];
    const b = books.goods[t * N_GOODS + G.tools];
    if (!m || !b || !(m.volume > 0)) continue;
    let filled = 0;
    let firmPaid = 0;
    for (const o of b.bids) {
      if (!(o.filled > 0)) continue;
      filled += o.filled;
      if (o.ref >= FIRM_BASE) {
        const f = s.firms[o.ref - FIRM_BASE];
        if (f && f.sector !== 'builder') firmPaid += fin(o.paid);
      }
    }
    if (Math.abs(filled - m.volume) <= 1e-6 * Math.max(1, m.volume)) inv += firmPaid;
  }
  return inv;
}

// ---------------------------------------------------------------------------
// Town derived fields
// ---------------------------------------------------------------------------
interface Tally {
  pop: number;
  employed: number;
  homeless: number;
  hungry: number;
  cold: number;
  health: number;
  content: number;
  vacancies: number;
  wageSum: number;
  wageN: number;
  stateWorkers: number;
  firms: number;
  bySector: number[];
  closures: number;
  newFirms: number;
  occupied: number;
  occRent: number;
  imputedRent: number;
  townCost: number[];
}

/**
 * One pass over people, firms and houses: sets every town's derived fields (pop,
 * employed, unemployed, vacancies, homeless, vacantSlots, avgWage, avgRent,
 * contentment, health — cpi is set by statsStep/initStats) and returns national tallies.
 */
function tallyTowns(s: SimState, c: StatsCache, detectClosures: boolean): Tally {
  const nT = s.towns.length;
  for (const a of [c.pop, c.employed, c.homeless, c.content, c.health, c.vac, c.wageSum, c.wageN, c.slots, c.vacSlots, c.occRent, c.occN, c.askRent]) a.fill(0);
  const tl: Tally = {
    pop: 0,
    employed: 0,
    homeless: 0,
    hungry: 0,
    cold: 0,
    health: 0,
    content: 0,
    vacancies: 0,
    wageSum: 0,
    wageN: 0,
    stateWorkers: 0,
    firms: 0,
    bySector: new Array(FIRM_SECTORS.length).fill(0),
    closures: 0,
    newFirms: 0,
    occupied: 0,
    occRent: 0,
    imputedRent: 0,
    townCost: new Array(nT).fill(0),
  };

  // ---- people ----
  const people = s.people;
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    if (!p || !p.alive) continue;
    const t = p.town;
    tl.pop++;
    const h = fin(p.health);
    const ct = fin(p.contentment);
    tl.health += h;
    tl.content += ct;
    if (p.job >= 0) tl.employed++;
    if (p.home < 0) tl.homeless++;
    if (p.foodSat < HUNGRY_BELOW) tl.hungry++;
    if (p.heatSat < COLD_BELOW) tl.cold++;
    if (t < 0 || t >= nT) continue;
    c.pop[t]++;
    if (p.job >= 0) c.employed[t]++;
    if (p.home < 0) c.homeless[t]++;
    c.content[t] += ct;
    c.health[t] += h;
  }

  // ---- firms ----
  const firms = s.firms;
  if (detectClosures && c.prevActive.length < firms.length) {
    const grown = new Int8Array(Math.max(firms.length + 32, c.prevActive.length * 2)).fill(-1);
    grown.set(c.prevActive);
    c.prevActive = grown;
  }
  const secIndex = sectorIndex();
  for (let i = 0; i < firms.length; i++) {
    const f = firms[i];
    const active = !!f && f.alive && f.status === 'active';
    if (detectClosures) {
      if (c.prevActive[i] === 1 && !active && f && f.sector !== 'stateworks') tl.closures++;
      c.prevActive[i] = active ? 1 : 0;
    }
    if (!f || !f.alive) continue;
    const t = f.town;
    const nW = f.workers.length;
    const inTown = t >= 0 && t < nT;
    if (nW > 0) {
      const w = fin(f.wage) * nW;
      tl.wageSum += w;
      tl.wageN += nW;
      if (inTown) {
        c.wageSum[t] += w;
        c.wageN[t] += nW;
      }
    }
    if (active) {
      const want = Math.max(0, Math.floor(fin(f.target) + 0.5));
      const cap = f.sector === 'stateworks' ? want : Math.max(0, f.capacity);
      const open = Math.max(0, Math.min(want, cap) - nW);
      tl.vacancies += open;
      if (inTown) c.vac[t] += open;
    }
    if (f.sector === 'stateworks') {
      tl.stateWorkers += nW;
      continue;
    }
    if (active) {
      tl.firms++;
      const k = secIndex[f.sector];
      if (k !== undefined) tl.bySector[k]++;
      if (f.founded === s.day && s.day > 0) tl.newFirms++;
    }
  }

  // ---- houses ----
  for (const b of s.buildings) {
    if (!b || b.kind !== 'house' || b.status !== 'active') continue;
    const t = b.town;
    const slots = Math.max(0, fin(b.slots));
    const occ = Math.min(slots, b.residents.length);
    const rent = Math.max(0, fin(b.rent));
    tl.occupied += occ;
    tl.occRent += rent * occ;
    if (occ > 0 && b.owner >= 0 && b.owner < FIRM_BASE && b.residents.indexOf(b.owner) >= 0) tl.imputedRent += rent; // owner-occupier: imputed rent
    if (t < 0 || t >= nT) continue;
    c.slots[t] += slots;
    c.vacSlots[t] += slots - occ;
    c.occRent[t] += rent * occ;
    c.occN[t] += occ;
    c.askRent[t] += rent * slots;
  }

  // ---- write town fields ----
  const baseRent = fin(s.stats.baseRent) > 0 ? s.stats.baseRent : BASE_RENT_SHARE * BASE_WAGE;
  for (let t = 0; t < nT; t++) {
    const town = s.towns[t];
    const pop = c.pop[t];
    town.pop = pop;
    town.employed = c.employed[t];
    town.unemployed = pop - c.employed[t];
    town.vacancies = c.vac[t];
    town.homeless = c.homeless[t];
    town.vacantSlots = c.vacSlots[t];
    town.avgWage = c.wageN[t] > 0 ? c.wageSum[t] / c.wageN[t] : fin(town.avgWage) > 0 ? town.avgWage : fin(s.stats.baseWage) > 0 ? s.stats.baseWage : BASE_WAGE;
    town.avgRent = c.occN[t] > 0 ? c.occRent[t] / c.occN[t] : c.slots[t] > 0 ? c.askRent[t] / c.slots[t] : fin(town.avgRent) > 0 ? town.avgRent : baseRent;
    town.contentment = pop > 0 ? c.content[t] / pop : fin(town.contentment, 0.6);
    town.health = pop > 0 ? c.health[t] / pop : fin(town.health, 0.9);
  }
  return tl;
}

let SECTOR_INDEX: Record<string, number> | null = null;
function sectorIndex(): Record<string, number> {
  if (!SECTOR_INDEX) {
    SECTOR_INDEX = {};
    FIRM_SECTORS.forEach((k, i) => (SECTOR_INDEX![k] = i));
  }
  return SECTOR_INDEX;
}

/** Set town.cpi for every town and return the population-weighted national CPI (and per-town costs in `tl`). */
function updateCpi(s: SimState, tl: Tally): number {
  const st = s.stats;
  const base = fin(st.baseCost) > 0 ? st.baseCost : 1;
  let num = 0;
  let den = 0;
  let sum = 0;
  for (let t = 0; t < s.towns.length; t++) {
    const town = s.towns[t];
    const cost = basketCost(s, t, town.avgRent);
    tl.townCost[t] = cost;
    const cpi = fin((100 * cost) / base, 100);
    town.cpi = cpi;
    num += cpi * town.pop;
    den += town.pop;
    sum += cpi;
  }
  return den > 0 ? num / den : s.towns.length > 0 ? sum / s.towns.length : 100;
}

// ---------------------------------------------------------------------------
// Base period (founding / re-base)
// ---------------------------------------------------------------------------
function meanIncome(s: SimState): number {
  let sum = 0;
  let n = 0;
  for (const p of s.people) {
    if (!p || !p.alive) continue;
    sum += fin(p.income);
    n++;
  }
  const w = fin(s.stats.baseWage) > 0 ? s.stats.baseWage : BASE_WAGE;
  const m = n > 0 ? sum / n : 0;
  return m > 0.05 * w ? m : w * (1 - INIT_UNEMPLOYMENT);
}

/**
 * Set the base period at the current state: base prices (national, smoothed),
 * base wage and rent, the CPI basket (steady-state per-person demand at current
 * consumer prices and mean income; one rent slot per household), base cost so the
 * national CPI is 100, and base freight.
 */
function setBase(s: SimState): void {
  const st = s.stats;
  const c = statsCache(s);
  // prices
  const bp = nationalPrices(s, 'ema');
  const fp = foundingPrices();
  for (let g = 0; g < N_GOODS; g++) if (!(bp[g] > 0)) bp[g] = fp[g];
  st.basePrices = bp.map((x) => roundSig(x, 8));
  // wage & rent from the agents (tallyTowns also refreshes the town fields)
  const tl = tallyTowns(s, c, false);
  st.baseWage = tl.wageN > 0 ? tl.wageSum / tl.wageN : fin(st.baseWage) > 1 ? st.baseWage : BASE_WAGE;
  let slots = 0;
  let rentSum = 0;
  for (const t of s.towns) {
    slots += t.pop;
    rentSum += t.avgRent * t.pop;
  }
  st.baseRent = tl.occupied > 0 ? tl.occRent / tl.occupied : slots > 0 ? rentSum / slots : BASE_RENT_SHARE * st.baseWage;
  if (!(st.baseRent > 0)) st.baseRent = BASE_RENT_SHARE * st.baseWage;
  // basket at national consumer prices
  const cp = new Array(N_GOODS).fill(1);
  const nT = s.towns.length;
  for (const g of CONSUMER_GOODS) {
    let num = 0;
    let den = 0;
    for (let t = 0; t < nT; t++) {
      const w = Math.max(1, s.towns[t].pop);
      num += w * consumerPrice(s, t, g);
      den += w;
    }
    cp[g] = den > 0 ? num / den : bp[g];
  }
  const q = steadyStateDemand(cp, meanIncome(s), st.baseRent);
  st.basket = new Array(N_GOODS).fill(0);
  for (const g of CONSUMER_GOODS) st.basket[g] = roundSig(Math.max(0, fin(q[g])), 8);
  st.basketRent = 1;
  // base cost: population-weighted basket cost across towns → national CPI = 100
  let num = 0;
  let den = 0;
  let sum = 0;
  for (let t = 0; t < nT; t++) {
    const cost = basketCost(s, t, s.towns[t].avgRent);
    num += cost * s.towns[t].pop;
    den += s.towns[t].pop;
    sum += cost;
  }
  const bc = den > 0 ? num / den : nT > 0 ? sum / nT : 1;
  st.baseCost = bc > 0 ? bc : 1;
  const fr = freightIndex(s);
  st.baseFreight = fr > 0 ? fr : 1;
  updateCpi(s, tl);
}

/**
 * Initialise stats at world creation: CPI basket from steady-state household demand
 * (demandModel.steadyStateDemand at base prices) + rent weight, base prices, base wage,
 * base rent, base freight. Empty series. Also sets every town's derived fields and a
 * first `latest` snapshot (so agents and the UI have values on day 0).
 */
export function initStats(s: SimState): void {
  const st = s.stats;
  st.daily = {};
  st.monthly = {};
  st.acc = {};
  st.macc = {};
  st.latest = {};
  st.dailyStart = s.day;
  st.monthlyStart = Math.floor(s.day / DAYS_PER_MONTH);
  setBase(s);
  const c = statsCache(s);
  const vals = computeDaily(s, c);
  writeLatest(s, vals);
  st.latest.infl30Carry = 0;
  st.latest.inflYoYCarry = 0;
}

/** After warm-up: re-base CPI (=100) to current prices, clear series, s.startDay = s.day. */
export function rebaseStats(s: SimState): void {
  const st = s.stats;
  const lat = st.latest;
  const carry30 = fin(lat.infl30);
  const carryYoY = fin(lat.inflYoY);
  setBase(s);
  st.daily = {};
  st.monthly = {};
  st.macc = {};
  st.dailyStart = s.day;
  st.monthlyStart = Math.floor(s.day / DAYS_PER_MONTH);
  s.startDay = s.day;
  // latest keeps yesterday's indicators, re-expressed in the new base.
  lat.cpi = 100;
  for (let t = 0; t < s.towns.length; t++) lat['cpi_' + t] = roundSig(s.towns[t].cpi);
  lat.infl30 = carry30;
  lat.inflYoY = carryYoY;
  lat.infl30Carry = carry30;
  lat.inflYoYCarry = carryYoY;
  lat.realWage = roundSig(st.baseWage);
  lat.deflator = 100;
  lat.freight = roundSig(st.baseFreight);
  lat.day = s.day;
}

/** Make sure the base period exists (a state built without initStats). */
function ensureBase(s: SimState): void {
  const st = s.stats;
  let q = 0;
  for (const g of CONSUMER_GOODS) q += fin(st.basket[g]);
  if (!(q > 0) || !(st.baseCost > 0)) {
    const daily = st.daily;
    const monthly = st.monthly;
    const hasSeries = Object.keys(daily).length > 0;
    setBase(s);
    if (!hasSeries) {
      st.dailyStart = s.day;
      st.monthlyStart = Math.floor(s.day / DAYS_PER_MONTH);
    }
    st.daily = daily;
    st.monthly = monthly;
  }
  if (!st.acc) st.acc = {};
  if (!st.macc) st.macc = {};
  if (!st.latest) st.latest = {};
}

// ---------------------------------------------------------------------------
// Daily indicators
// ---------------------------------------------------------------------------
const num = (x: number | undefined): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

function computeDaily(s: SimState, c: StatsCache): Record<string, number> {
  const st = s.stats;
  const acc = st.acc;
  const lat = st.latest;
  const t = s.treasury;
  const b = s.bank;
  const v: Record<string, number> = {};
  const nT = s.towns.length;

  const detect = c.prevDay === s.day - 1;
  const tl = tallyTowns(s, c, true);
  if (!detect) tl.closures = 0;
  c.prevDay = s.day;

  // ---- prices ----
  const cpi = updateCpi(s, tl);
  v.cpi = cpi;
  for (let k = 0; k < nT; k++) v['cpi_' + k] = s.towns[k].cpi;
  const hist = st.daily.cpi ?? [];
  // Inflation needs today's CPI at the end of the history (without mutating the series yet).
  hist.push(cpi);
  v.infl30 = inflationRate(hist, DAYS_PER_MONTH, STATS_INFL_WINDOW, num(lat.infl30Carry));
  v.inflYoY = inflationRate(hist, DAYS_PER_YEAR, STATS_INFL_WINDOW, num(lat.inflYoYCarry), DAYS_PER_MONTH);
  hist.pop();
  const price = nationalPrices(s, 'price', c.prices);
  for (let g = 0; g < N_GOODS; g++) v[K_PRICE[g]] = price[g];
  const gross = nationalPrices(s, 'gross');
  for (let g = 0; g < N_GOODS; g++) v[K_GROSS[g]] = gross[g];
  v.rent = tl.occupied > 0 ? tl.occRent / tl.occupied : num(lat.rent) || st.baseRent;

  // ---- labour & people ----
  const pop = tl.pop;
  v.pop = pop;
  v.employed = tl.employed;
  v.unemployed = pop - tl.employed;
  v.unemp = pop > 0 ? (pop - tl.employed) / pop : 0;
  v.vacancies = tl.vacancies;
  const wage = tl.wageN > 0 ? tl.wageSum / tl.wageN : num(lat.wage) || st.baseWage;
  v.wage = wage;
  v.realWage = cpi > 0 ? (wage * 100) / cpi : wage;
  v.hires = num(acc.hires);
  v.fires = num(acc.fires);
  v.quits = num(acc.quits);
  v.births = num(acc.births);
  v.deaths = num(acc.deaths);
  v.starved = num(acc.starved);
  v.immigrants = num(acc.immigrants);
  v.emigrants = num(acc.emigrants);
  v.hunger = pop > 0 ? tl.hungry / pop : 0;
  v.cold = pop > 0 ? tl.cold / pop : 0;
  v.homeless = tl.homeless;
  v.homelessRate = pop > 0 ? tl.homeless / pop : 0;
  v.evictions = num(acc.evictions);
  v.health = pop > 0 ? tl.health / pop : 0;
  v.content = pop > 0 ? tl.content / pop : 0;

  // ---- goods ----
  const impval = num(acc.impval);
  const expval = num(acc.expval);
  for (let g = 0; g < N_GOODS; g++) {
    v[K_PROD[g]] = num(acc[K_PROD[g]]);
    v[K_CONS[g]] = num(acc[K_CONS[g]]);
    v[K_VOL[g]] = num(acc[K_VOL[g]]);
    v[K_SHORT[g]] = num(acc[K_SHORT[g]]);
  }
  for (const g of TRADABLE_GOODS) {
    v[K_IMP[g]] = num(acc[K_IMP[g]]);
    v[K_EXP[g]] = num(acc[K_EXP[g]]);
  }
  v.imports = impval;
  v.exports = expval;
  v.tradeBal = expval - impval;

  // ---- freight ----
  const freight = freightIndex(s);
  v.freight = freight > 0 ? freight : num(lat.freight) || st.baseFreight;

  // ---- real GDP (production approach at base prices) ----
  const bp = st.basePrices;
  let goodsVA = 0;
  if (typeof acc.realva === 'number' && Number.isFinite(acc.realva)) goodsVA = acc.realva + num(acc.event_va);
  else {
    const uva = unitValueAdded(bp);
    for (let g = 0; g < N_GOODS; g++) goodsVA += num(acc[K_PROD[g]]) * uva[g];
  }
  const bw = st.baseWage > 0 ? st.baseWage : BASE_WAGE;
  const construction = num(acc.build_labor) * bw;
  const freightNow = v.freight;
  const transport = freightNow > 0 && st.baseFreight > 0 ? (num(acc.freight_cost) * st.baseFreight) / freightNow : 0;
  const housing = tl.occupied * (st.baseRent > 0 ? st.baseRent : 0);
  const govServices = Math.max(0, tl.stateWorkers - num(acc.build_labor_state)) * bw;
  v.gdpReal = goodsVA + construction + transport + housing + govServices;

  // ---- nominal GDP (expenditure approach) ----
  const flows = t.flows || {};
  const cons = num(acc.consval);
  const rentPaid = num(acc.flow_rent);
  const govBuild = Math.max(0, -num(flows.build));
  const privBuild = Math.max(0, num(acc.flow_build) - govBuild);
  const inv = toolsInvestment(s) + privBuild;
  const gov = num(acc.gov_goods) - num(acc.gov_goods_sold) + Math.max(0, -num(flows.wage)) + govBuild;
  const nx = expval - impval;
  v.cons = cons;
  v.rentPaid = rentPaid;
  v.inv = inv;
  v.gov = gov;
  v.netExports = nx;
  v.gdpNominal = cons + rentPaid + tl.imputedRent + inv + gov + nx;
  v.deflator = v.gdpReal > 1e-9 ? (100 * v.gdpNominal) / v.gdpReal : num(lat.deflator) || 100;

  // ---- money & credit ----
  let credit = 0;
  let rateW = 0;
  for (const ln of s.loans) {
    if (!ln || !ln.active) continue;
    const pr = Math.max(0, fin(ln.principal));
    credit += pr;
    rateW += pr * fin(ln.rate);
  }
  v.money = deposits(s);
  v.reserves = fin(b.reserves);
  v.credit = credit;
  v.bankEquity = fin(b.equity);
  v.capRatio = credit > 1 ? clamp(fin(b.equity) / credit, -1, 5) : b.equity > 0 ? 1 : 0;
  v.loanRate = credit > 1 ? rateW / credit : fin(b.baseRate);
  v.baseRate = fin(b.baseRate);
  v.depRate = fin(b.depositRate);
  v.windowDebt = fin(b.windowDebt);
  v.reserveRate = fin(t.reserveRate);
  v.lendRate = fin(t.lendRate);
  v.writeoffs = num(acc.writeoffs);
  const iouPrice = s.iouMarket && s.iouMarket.price > 0 ? s.iouMarket.price : IOU_PAR;
  v.iouPrice = iouPrice;
  v.iouYield = IOU_COUPON / iouPrice;
  v.iouOut = fin(t.iouOutstanding);
  const gp = s.goldMarket && s.goldMarket.price > 0 ? s.goldMarket.price : fin(s.foreign.goldPrice) > 0 ? s.foreign.goldPrice : INIT_GOLD_PRICE;
  v.goldPrice = gp;
  v.treasuryGold = fin(t.gold);

  // ---- Treasury ----
  v.purse = fin(t.purse);
  v.minted = fin(t.minted);
  const prevMinted = typeof lat.minted === 'number' ? lat.minted : v.minted;
  v.mintDay = Math.max(0, v.minted - prevMinted);
  v.levyTake = num(acc.levy_take);
  v.levyGive = num(acc.levy_give);
  v.levyNet = v.levyTake - v.levyGive;
  v.transferGive = num(acc.transfer_give);
  v.transferTake = num(acc.transfer_take);
  let income = 0;
  let spend = 0;
  for (const k in flows) {
    const x = num(flows[k]);
    if (x > 0) income += x;
    else spend -= x;
  }
  v.treasuryIncome = income;
  v.treasurySpend = spend;

  // ---- firms ----
  v.firms = tl.firms;
  for (let k = 0; k < FIRM_SECTORS.length; k++) v[K_FIRMS[k]] = tl.bySector[k];
  v.bankrupt = tl.closures;
  v.newFirms = tl.newFirms;
  let strikes = 0;
  for (const town of s.towns) if (town.strikeDays > 0) strikes++;
  v.strikes = strikes;

  for (const k in v) if (!Number.isFinite(v[k])) v[k] = 0;
  return v;
}

// ---------------------------------------------------------------------------
// Series plumbing
// ---------------------------------------------------------------------------
function writeLatest(s: SimState, vals: Record<string, number>): void {
  const lat = s.stats.latest;
  for (const k in vals) lat[k] = roundSig(vals[k]);
  // Keep full precision where agents read it back.
  lat.infl30 = vals.infl30;
  lat.inflYoY = vals.inflYoY;
  lat.minted = vals.minted;
  lat.day = s.day;
  lat.year = yearOf(s.day);
  lat.month = monthOf(s.day);
}

/** Append one value per key to the daily series (all series stay aligned; capped at STATS_DAILY_CAP). */
function pushDaily(st: Stats, vals: Record<string, number>, day: number): void {
  const d = st.daily;
  let len = -1;
  for (const k in d) {
    len = d[k].length;
    break;
  }
  if (len <= 0) {
    st.dailyStart = day;
    len = 0;
  }
  for (const k in vals) {
    const x = roundSig(vals[k]);
    let a = d[k];
    if (!a) {
      a = d[k] = new Array(len).fill(x); // a key that appears late is back-filled flat
    }
    a.push(x);
  }
  // keys not reported today carry their last value
  for (const k in d) {
    const a = d[k];
    if (a.length === len) a.push(a.length > 0 ? a[a.length - 1] : 0);
  }
  const n = len + 1;
  if (n > STATS_DAILY_CAP) {
    const cut = n - STATS_DAILY_CAP;
    for (const k in d) d[k].splice(0, cut);
    st.dailyStart += cut;
  }
}

function pushMonthly(st: Stats, vals: Record<string, number>, day: number): void {
  const m = st.monthly;
  let len = -1;
  for (const k in m) {
    len = m[k].length;
    break;
  }
  if (len <= 0) {
    st.monthlyStart = Math.floor(day / DAYS_PER_MONTH);
    len = 0;
  }
  for (const k in vals) {
    const x = roundSig(vals[k]);
    let a = m[k];
    if (!a) a = m[k] = new Array(len).fill(x);
    a.push(x);
  }
  for (const k in m) {
    const a = m[k];
    if (a.length === len) a.push(a.length > 0 ? a[a.length - 1] : 0);
  }
}

function accumulateMonth(st: Stats, vals: Record<string, number>): void {
  const m = st.macc;
  m[MACC_DAYS] = (m[MACC_DAYS] || 0) + 1;
  for (const k in vals) {
    if (END_KEYS.has(k)) continue;
    m[k] = (m[k] || 0) + vals[k];
  }
}

function closeMonth(s: SimState, vals: Record<string, number>): void {
  const st = s.stats;
  const m = st.macc;
  const n = Math.max(1, m[MACC_DAYS] || 1);
  const out: Record<string, number> = {};
  for (const k in vals) {
    const mode = monthMode(k);
    out[k] = mode === 'end' ? vals[k] : mode === 'sum' ? m[k] || 0 : (m[k] || 0) / n;
  }
  const d = distributionStats(s);
  out.gini = d.gini;
  out.giniIncome = d.giniIncome;
  out.top10 = d.top10;
  st.latest.gini = roundSig(d.gini);
  st.latest.giniIncome = roundSig(d.giniIncome);
  st.latest.top10 = roundSig(d.top10);
  pushMonthly(st, out, s.day);
  st.macc = {};
}

// ---------------------------------------------------------------------------
// Distribution (monthly)
// ---------------------------------------------------------------------------
/**
 * Wealth and income distribution across living households. Wealth = cash + IOUs
 * (at the IOU price) + gold (at the gold price) + owned firms (cash + tools +
 * stock at local prices + building book value − the firm's debts, floored at 0) +
 * owned houses (book value) − personal debts.
 */
export function distributionStats(s: SimState): { gini: number; giniIncome: number; top10: number; wealth: number[]; income: number[] } {
  const iouP = s.iouMarket && s.iouMarket.price > 0 ? s.iouMarket.price : IOU_PAR;
  const goldP = s.goldMarket && s.goldMarket.price > 0 ? s.goldMarket.price : fin(s.foreign.goldPrice, INIT_GOLD_PRICE);
  const personDebt = new Float64Array(s.people.length);
  const firmDebt = new Float64Array(s.firms.length);
  for (const ln of s.loans) {
    if (!ln || !ln.active) continue;
    const r = ln.borrower;
    const pr = Math.max(0, fin(ln.principal));
    if (r >= FIRM_BASE) {
      const i = r - FIRM_BASE;
      if (i < firmDebt.length) firmDebt[i] += pr;
    } else if (r >= 0 && r < personDebt.length) personDebt[r] += pr;
  }
  const firmValue = (id: number, owner: number): number => {
    const f = s.firms[id];
    if (!f || !f.alive || f.owner !== owner) return 0;
    let v = Math.max(0, fin(f.cash));
    const t = f.town;
    const priceAt = (town: number, g: number): number => {
      const m = s.markets[town * N_GOODS + g];
      return m && m.ema > 0 ? m.ema : fin(s.stats.basePrices[g]);
    };
    if (t >= 0 && t < s.towns.length) {
      v += Math.max(0, fin(f.tools)) * priceAt(t, G.tools);
      for (let g = 0; g < N_GOODS; g++) if (f.inv[g] > 0) v += f.inv[g] * priceAt(t, g);
      if (f.trade) {
        for (let u = 0; u < f.trade.stock.length; u++) {
          const row = f.trade.stock[u];
          if (!row) continue;
          for (let g = 0; g < N_GOODS; g++) if (row[g] > 0) v += row[g] * priceAt(u, g);
        }
      }
    }
    const bld = f.building >= 0 ? s.buildings[f.building] : undefined;
    if (bld) v += Math.max(0, fin(bld.cost));
    return Math.max(0, v - firmDebt[id]);
  };
  const wealth: number[] = [];
  const income: number[] = [];
  for (const p of s.people) {
    if (!p || !p.alive) continue;
    let w = Math.max(0, fin(p.cash)) + Math.max(0, fin(p.iou)) * iouP + Math.max(0, fin(p.gold)) * goldP;
    for (const id of p.owns) w += firmValue(id, p.id);
    for (const hid of p.houses) {
      const h = s.buildings[hid];
      if (h && h.owner === p.id && h.status !== 'ruin') w += Math.max(0, fin(h.cost));
    }
    w -= personDebt[p.id] || 0;
    wealth.push(w);
    income.push(Math.max(0, fin(p.income)));
  }
  return { gini: gini(wealth), giniIncome: gini(income), top10: topShare(wealth, STATS_TOP_SHARE), wealth, income };
}

// ---------------------------------------------------------------------------
// Daily entry points
// ---------------------------------------------------------------------------
/**
 * Reset stats.acc and daily scratch fields (person.spent/earned are reset by households):
 * treasury.flows; firm revenue/spent/wageBill/otherCosts/producedToday/soldToday/hired/
 * fired and trader shippedToday; bank approved/rejected/interestIn/interestOut; foreign
 * import/export counters; levy.today; player order filledToday.
 * Flows booked between yesterday's statsStep and now (e.g. a Mint or Transfer the
 * player dispatched between days) are carried into today's acc / treasury.flows
 * instead of being lost.
 */
export function beginDayStats(s: SimState): void {
  const st = s.stats;
  const c = statsCache(s);
  const t = s.treasury;
  const carry = c.snapDay === s.day - 1 && c.snapAcc !== null && c.snapFlows !== null;
  const acc: Record<string, number> = {};
  const flows: Record<string, number> = {};
  if (carry) {
    const oldAcc = st.acc || {};
    const sa = c.snapAcc!;
    for (const k in oldAcc) {
      const d = num(oldAcc[k]) - (sa[k] || 0);
      if (Math.abs(d) > 1e-12) acc[k] = d;
    }
    const oldFlows = t.flows || {};
    const sf = c.snapFlows!;
    for (const k in oldFlows) {
      const d = num(oldFlows[k]) - (sf[k] || 0);
      if (Math.abs(d) > 1e-12) flows[k] = d;
    }
  }
  st.acc = acc;
  t.flows = flows;
  c.snapAcc = null;
  c.snapFlows = null;
  c.snapDay = -2;

  for (const f of s.firms) {
    if (!f) continue;
    f.revenue = 0;
    f.spent = 0;
    f.wageBill = 0;
    f.otherCosts = 0;
    f.producedToday = 0;
    f.soldToday = 0;
    f.hired = 0;
    f.fired = 0;
    if (f.trade) f.trade.shippedToday = 0;
  }
  const b = s.bank;
  b.approved = 0;
  b.rejected = 0;
  b.interestIn = 0;
  b.interestOut = 0;
  const fo = s.foreign;
  if (fo) {
    if (fo.importsQty) fo.importsQty.fill(0);
    if (fo.exportsQty) fo.exportsQty.fill(0);
    fo.importValue = 0;
    fo.exportValue = 0;
  }
  for (const l of s.policy.levies) l.today = 0;
  for (const o of s.policy.orders) o.filledToday = 0;
}

/** Compute today's indicators, push to daily series; on month end push monthly series. Updates town derived fields. */
export function statsStep(s: SimState): void {
  ensureBase(s);
  const st = s.stats;
  const c = statsCache(s);
  const vals = computeDaily(s, c);
  pushDaily(st, vals, s.day);
  writeLatest(s, vals);
  accumulateMonth(st, vals);
  if (isMonthEnd(s.day)) closeMonth(s, vals);
  // Snapshot for the between-day carry (see beginDayStats).
  c.snapDay = s.day;
  c.snapAcc = { ...st.acc };
  c.snapFlows = { ...(s.treasury.flows || {}) };
}

/** Read a series ('daily' or 'monthly'); returns [] if missing. */
export function series(s: SimState, key: string, freq: 'daily' | 'monthly' = 'daily'): number[] {
  return (freq === 'daily' ? s.stats.daily[key] : s.stats.monthly[key]) ?? [];
}

/** Latest value of an indicator (0 if missing). */
export function latest(s: SimState, key: string): number {
  return s.stats.latest[key] ?? 0;
}

/** Day index of element i of a daily series. */
export function dailyDay(s: SimState, i: number): number {
  return s.stats.dailyStart + i;
}

/** Month index (days / 30) of element i of a monthly series. */
export function monthlyMonth(s: SimState, i: number): number {
  return s.stats.monthlyStart + i;
}

/** Mean of the last `n` values of a daily series (0 if empty). */
export function recentMean(s: SimState, key: string, n: number): number {
  const a = series(s, key);
  if (a.length === 0) return 0;
  return meanRange(a, a.length - Math.max(1, n), a.length - 1);
}
