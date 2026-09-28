// ============================================================================
// Producer firms (and shared firm plumbing for builders/traders/stateworks):
// planning, production, wages, orders, accounting, finance, dividends,
// bankruptcy. Uses the pure model in production.ts.
// OWNER: firms agent. See DESIGN §3.2.
//
// Economics in brief:
//  * Labour demand. Each morning a producer compares the profit-maximising
//    workforce (production.optimalLabor: marginal revenue product of labour = the
//    effective wage, employer-side wage levies included) with the workforce that
//    expected sales plus an inventory correction require, and plans the smaller of
//    the two (never above building capacity). Prices above marginal cost make
//    firms grow until they meet demand; prices below it make them shrink, so the
//    market supply curve is the sum of rising marginal-cost curves. Targets move
//    with hysteresis and smoothing, so noise does not cause hire-fire churn.
//  * Seasons. Farms plan labour at the average season (they keep their hands
//    through winter) and carry the harvest in store: their inventory target
//    follows the cumulative seasonal surplus, so grain is stored in autumn and
//    drawn down in spring, and grain prices stay smooth.
//  * Wages. One posted wage per firm: up while vacancies go unfilled, slowly down
//    only when the firm loses money and local labour is slack (downward nominal
//    rigidity), partly indexed to expected inflation, clamped to legal bounds.
//    A legal minimum above the market therefore raises the effective wage in the
//    firm's plan and shows up as smaller targets (unemployment).
//  * Selling. The ask ladder offers roughly the planned daily sales at or below
//    the expected price, more at higher prices, and the rest held back (durables);
//    the whole ladder shifts down when stock is above target and up when it is
//    short. Perishable overstock is priced to clear. Asks never go below a cost
//    floor unless the firm is distressed or the stock would rot.
//  * Buying. Inputs to keep INPUT_BUFFER_DAYS of production (limit prices capped
//    at short-run break-even); tools to equip the planned workforce, bidding up to
//    TOOLS_MAX_BID_MULT × the expected price when badly short (tools are
//    complements). All bids are capped by cash; a shortfall triggers a request
//    for a working-capital loan.
//  * Accounting. Output inventory is valued at weighted-average production cost;
//    profit = revenue − cost of goods sold − idle production cost − other costs
//    (interest and levies, booked by their modules) − expected spoilage.
//  * Finance. Working-capital loans when cash runs low, early repayment when
//    flush, monthly dividends of half the excess cash to the owner (a person or
//    the Treasury's Purse), monthly 'profit' levies, distress (unpaid wages or
//    overdue loans) → bankruptcy → liquidation (fire sale) → closure (debts
//    written off against bank equity, building vacant).
// ============================================================================
import {
  ASK_COST_FLOOR,
  ASK_COMPETE_STEP,
  ASK_INV_ELASTICITY,
  ASK_QS_MAX,
  ASK_QS_MIN,
  ASK_RUNGS,
  ASK_SHIFT_MAX,
  ASK_SHIFT_MIN,
  ASK_TOP_RUNG,
  ASK_WEIGHTS,
  BASE_WAGE,
  CASH_LOW_DAYS,
  COAL_HEAT_SHARE,
  CASH_TARGET_DAYS,
  DAYS_PER_YEAR,
  DEMAND_SLACK,
  DISTRESS_ASK_SHIFT,
  DISTRESS_BANKRUPT_DAYS,
  DISTRESS_RECOVER,
  DIVIDEND_SHARE,
  DROUGHT_FACTOR,
  FIRE_SALE,
  HEAT_MEAN,
  INPUT_BID_RUNGS,
  INPUT_BID_WEIGHTS,
  INPUT_BUFFER_DAYS,
  INV_ADJUST_DAYS,
  INV_ADJUST_DAYS_PERISHABLE,
  INV_MAX_DAYS,
  INV_TARGET_DAYS,
  INV_TARGET_DAYS_PERISHABLE,
  LIQUIDATION_DAYS,
  NEW_FIRM_DAYS,
  NEW_FIRM_SCALE,
  NEW_FIRM_WC_DAYS,
  PERISH_CLEAR_K,
  PERISH_CLEAR_MIN,
  PREPAY_CASH_DAYS,
  PRICE_EXP_EMA,
  PROFIT_EMA,
  SALES_EMA,
  SHORTAGE_WEIGHT,
  STRIKE_FACTOR,
  TARGET_HYSTERESIS,
  TARGET_MAX_STEP,
  TARGET_MAX_STEP_ABS,
  TARGET_SMOOTH,
  TOOLS_BUFFER_DAYS,
  TOOLS_GAP_CLOSE,
  TOOLS_IDLE_WEAR_DAY,
  TOOLS_MAX_BID_MULT,
  WAGE_CUT_UNEMP,
  WAGE_DOWN_DAY,
  WAGE_INDEXATION,
  WAGE_MIN_ABS,
  WAGE_RESERVE_DAYS,
  WAGE_UP_DAY,
  WAGE_VACANCY_DAYS,
  WAGON_CAPACITY,
  WORKING_DEBT_MAX_DAYS,
  WORKING_LOAN_RETRY_DAYS,
  WORKING_LOAN_TERM,
} from '../config';
import { dayOfYear, farmSeason, heatNeed, isMonthEnd, seasonFactor } from '../calendar';
import { newFirm } from '../factory';
import { G, GOODS, N_GOODS, PRODUCER_OF, SECTORS, type SectorDef } from '../goods';
import { cashOf, firmRef, isFirm, isPerson, pay, refId, repayPrincipal, writeOff } from '../ledger';
import { addAsk, addBid, bookFor, expectedGross, expectedNet, marketOf, type Books } from '../market/markets';
import { chargeLevy, wageLevyRates } from '../policy/levies';
import { wageBounds } from '../policy/limits';
import { rt, touchBuildings } from '../runtime';
import { news } from '../stats/events';
import type { Book, Firm, MarketState, Person, Ref, Sector, SimState, TownId } from '../types';
import { STATE } from '../types';
import { clamp, ema, fin } from '../util';
import { siteMultiplier as layoutSiteMultiplier } from '../world/layout';
import { firmName } from '../world/names';
import { requestLoan } from './bank';
import { cancelProject } from './construction';
import { fire, hasLevyBase } from './labor';
import {
  laborForOutput,
  materialCap,
  materialCostPerUnit,
  optimalLabor,
  potentialOutput,
  toolCostPerUnit,
  toolFactor,
  unitVariableCost,
} from './production';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Goods losing at least this share per day count as perishable (bread, fish, ale). */
const PERISHABLE_SPOIL = 0.01;
const K_PROD = Array.from({ length: N_GOODS }, (_, g) => 'prod_' + g);
const K_USE = Array.from({ length: N_GOODS }, (_, g) => 'use_' + g);
const K_WAGES: Partial<Record<Sector, string>> = {};

function bump(s: SimState, key: string, v = 1): void {
  if (!v || !Number.isFinite(v)) return;
  const acc = s.stats.acc;
  acc[key] = (acc[key] || 0) + v;
}

function wagesKey(sector: Sector): string {
  let k = K_WAGES[sector];
  if (!k) K_WAGES[sector] = k = 'wages_' + sector;
  return k;
}

export function isPerishable(good: number): boolean {
  return (GOODS[good]?.spoil ?? 0) >= PERISHABLE_SPOIL;
}

/** Wage a new firm posts in a town: the town's average wage, else the founding wage. */
export function defaultWage(s: SimState, town: TownId): number {
  const t = s.towns[town];
  if (t && t.avgWage > 0 && Number.isFinite(t.avgWage)) return t.avgWage;
  const bw = fin(s.stats?.baseWage, 0);
  return bw > 2 ? bw : BASE_WAGE;
}

/** Firm is open for business and its building (if any) is in use. */
function operating(s: SimState, f: Firm): boolean {
  if (!f.alive || f.status !== 'active') return false;
  if (f.building < 0) return true;
  const b = s.buildings[f.building];
  return !b || b.status === 'active';
}

/** Σ over workers of (0.5 + 0.5·health) × skill: effective labour before strikes. */
export function workforceEff(s: SimState, f: Firm): number {
  let e = 0;
  const w = f.workers;
  for (let i = 0; i < w.length; i++) {
    const p = s.people[w[i]];
    if (!p || !p.alive) continue;
    const h = clamp(fin(p.health, 0.9), 0, 1);
    const sk = p.skill > 0 && Number.isFinite(p.skill) ? p.skill : 1;
    e += (0.5 + 0.5 * h) * sk;
  }
  return e;
}

/** Strike factor of a town (STRIKE_FACTOR while a strike is on). */
export function strikeFactor(s: SimState, town: TownId): number {
  const t = s.towns[town];
  return t && t.strikeDays > 0 ? STRIKE_FACTOR : 1;
}

/**
 * Site multiplier of a firm's building: resource sectors 0.6 + 0.8 × site quality
 * (farms: fertility, others: deposit richness) over the footprint; town sectors 1.
 * Delegates to world/layout.siteMultiplier so production uses exactly the quality
 * measure that site selection and calibration use (the footprint mean); falls back
 * to the best footprint tile if the layout module is unavailable.
 */
export function siteMultiplier(s: SimState, f: Firm): number {
  const d = SECTORS[f.sector];
  if (!d || !d.producer || d.site === 'town') return 1;
  const b = f.building >= 0 ? s.buildings[f.building] : undefined;
  if (!b) return 1;
  try {
    const m = layoutSiteMultiplier(s, b);
    if (Number.isFinite(m) && m > 0) return m;
  } catch {
    /* fall through */
  }
  const map = s.map;
  const arr = f.sector === 'farm' ? map.fert : map.deposit;
  let best = 0;
  const w = Math.max(1, b.w || 1);
  const h = Math.max(1, b.h || 1);
  for (let y = b.y; y < b.y + h; y++) {
    if (y < 0 || y >= map.h) continue;
    for (let x = b.x; x < b.x + w; x++) {
      if (x < 0 || x >= map.w) continue;
      const v = fin(arr[y * map.w + x], 0);
      if (v > best) best = v;
    }
  }
  return 0.6 + 0.8 * clamp(best, 0, 1);
}

/** Seasonal factor used for PLANNING labour: farms plan at the annual mean (they carry stock); others use today's. */
function planSeason(d: SectorDef, day: number): number {
  return d.season === 'farm' ? 1 : seasonFactor(d.season, day);
}

// ---- Seasonality ------------------------------------------------------------
// Two goods have strong seasons: grain SUPPLY (harvests) and coal DEMAND (heating).
// In both cases producers keep a steady workforce and let stocks absorb the season:
// farms carry the harvest into spring, coal mines build stock through summer for the
// winter. The carry is the cumulative seasonal surplus (supply above its mean, or
// demand below its mean), in days of mean flow: ~0 when the lean/peak season has just
// ended, largest just before it starts.

/** Seasonal factor of the DEMAND for a good (mean ≈ 1): part of all coal is burnt for heat. */
export function demandSeason(good: number, day: number): number {
  if (good !== G.coal) return 1;
  return 1 - COAL_HEAT_SHARE + (COAL_HEAT_SHARE * heatNeed(day)) / Math.max(1e-6, HEAT_MEAN);
}

function buildCarry(f: (day: number) => number, sign: 1 | -1): { table: number[]; max: number } {
  const n = DAYS_PER_YEAR;
  const v: number[] = [];
  let mean = 0;
  for (let d = 0; d < n; d++) {
    v.push(f(d));
    mean += v[d];
  }
  mean /= n;
  const cum: number[] = [];
  let c = 0;
  let lo = Infinity;
  for (let d = 0; d < n; d++) {
    c += sign * (v[d] - mean);
    cum.push(c);
    if (c < lo) lo = c;
  }
  const table = cum.map((x) => (x - lo) / Math.max(1e-9, mean));
  return { table, max: Math.max(...table) };
}

let FARM_CARRY: { table: number[]; max: number } | null = null;
let COAL_CARRY: { table: number[]; max: number } | null = null;
function farmCarry() {
  return FARM_CARRY ?? (FARM_CARRY = buildCarry(farmSeason, 1));
}
function coalCarry() {
  return COAL_CARRY ?? (COAL_CARRY = buildCarry((d) => demandSeason(G.coal, d), -1));
}

/** Extra stock (days of mean sales) a farm carries today to ride out the lean season. */
export function seasonalCarryDays(day: number): number {
  return farmCarry().table[dayOfYear(day)] ?? 0;
}

/** Extra stock (days of mean sales) a producer of `good` holds today ahead of seasonal demand (coal). */
export function demandCarryDays(good: number, day: number): number {
  return good === G.coal ? coalCarry().table[dayOfYear(day)] ?? 0 : 0;
}

/** Sales with the demand season taken out (what the firm sells on average over the year). */
export function meanSales(good: number, sales: number, day: number): number {
  return Math.max(0, sales) / Math.max(0.05, demandSeason(good, day));
}

/** Output inventory target of a producer (units) for expected daily sales. */
export function inventoryTarget(sector: Sector, sales: number, day: number): number {
  const d = SECTORS[sector];
  if (!d || d.out < 0) return 0;
  const mean = meanSales(d.out, sales, day);
  let days = isPerishable(d.out) ? INV_TARGET_DAYS_PERISHABLE : INV_TARGET_DAYS;
  if (d.season === 'farm') days += seasonalCarryDays(day);
  days += demandCarryDays(d.out, day);
  return days * mean;
}

function inventoryMaxDays(sector: Sector): number {
  const d = SECTORS[sector];
  let days = INV_MAX_DAYS;
  if (d && d.season === 'farm') days += farmCarry().max;
  if (d && d.out === G.coal) days += coalCarry().max;
  return days;
}

/**
 * Daily sales a firm plans its selling around. A young firm without a sales history
 * assumes it can sell what it makes (or that its stock is at target); a mature firm
 * uses its sales EMA, with a small floor so that stock it cannot sell is still
 * offered (and, being far above target, discounted).
 */
function salesRef(s: SimState, f: Firm, stock: number): number {
  const sales = Math.max(0, fin(f.sales));
  const out = Math.max(0, fin(f.output));
  const young = s.day - f.founded < NEW_FIRM_DAYS;
  if (young && !(sales > 0.2 * out && sales > 1e-6)) {
    if (out > 1e-6) return Math.max(sales, out);
    return Math.max(sales, stock / Math.max(1, INV_TARGET_DAYS));
  }
  return Math.max(sales, stock / Math.max(1, 4 * INV_TARGET_DAYS));
}

// ---------------------------------------------------------------------------
// Per-day scratch (runtime only; every value is rebuilt within the day)
// ---------------------------------------------------------------------------
interface FirmScratch {
  day: number;
  n: number;
  matUsed: Float64Array; // ¤ of materials used in production / construction today
  toolWear: Float64Array; // ¤ of tools worn today
  unpaid: Float64Array; // ¤ of wages the firm could not pay today
  short: Float64Array; // ¤ of wanted purchases the firm could not fund today
  shade: Float64Array; // today's competitive ask adjustment (multiplier on pExp; 0 = none)
}

function scratch(s: SimState): FirmScratch {
  const bag = rt(s).bag;
  let c = bag.firms as FirmScratch | undefined;
  const need = s.firms.length;
  if (!c || c.n < need) {
    const n = need + 32;
    const grow = (a?: Float64Array) => {
      const b = new Float64Array(n);
      if (a && c && c.day === s.day) b.set(a.subarray(0, Math.min(a.length, n)));
      return b;
    };
    c = { day: c ? c.day : s.day, n, matUsed: grow(c?.matUsed), toolWear: grow(c?.toolWear), unpaid: grow(c?.unpaid), short: grow(c?.short), shade: grow(c?.shade) };
    bag.firms = c;
  }
  if (c.day !== s.day) {
    c.matUsed.fill(0);
    c.toolWear.fill(0);
    c.unpaid.fill(0);
    c.short.fill(0);
    c.shade.fill(0);
    c.day = s.day;
  }
  return c;
}

/** Book costs a module incurred for a firm today (builders' materials and tool wear, used by firmsEndDay). */
export function noteFirmCosts(s: SimState, firmId: number, materials: number, toolWear: number): void {
  const c = scratch(s);
  if (firmId < 0 || firmId >= c.n) return;
  if (materials > 0 && Number.isFinite(materials)) c.matUsed[firmId] += materials;
  if (toolWear > 0 && Number.isFinite(toolWear)) c.toolWear[firmId] += toolWear;
}

/** Record purchases a firm wanted today but could not fund (drives working-capital requests). */
export function noteShortfall(s: SimState, firmId: number, amount: number): void {
  const c = scratch(s);
  if (firmId < 0 || firmId >= c.n || !(amount > 0) || !Number.isFinite(amount)) return;
  c.short[firmId] += amount;
}

// ---------------------------------------------------------------------------
// Price table (expected net / gross prices per town × good, filled per phase)
// ---------------------------------------------------------------------------
interface PriceTable {
  net: number[][];
  gross: number[][];
}

function priceTable(s: SimState): PriceTable {
  const bag = rt(s).bag;
  let pt = bag.firmPrices as PriceTable | undefined;
  const nT = s.towns.length;
  if (!pt || pt.net.length !== nT) {
    pt = { net: [], gross: [] };
    for (let t = 0; t < nT; t++) {
      pt.net.push(new Array(N_GOODS).fill(1));
      pt.gross.push(new Array(N_GOODS).fill(1));
    }
    bag.firmPrices = pt;
  }
  for (let t = 0; t < nT; t++) {
    const n = pt.net[t];
    const g = pt.gross[t];
    for (let k = 0; k < N_GOODS; k++) {
      n[k] = fin(expectedNet(s, t, k), 1e-6);
      g[k] = fin(expectedGross(s, t, k), 1e-4);
    }
  }
  return pt;
}

/** Expected gross prices (length N_GOODS) in a town, for other modules' cost estimates. */
export function townGrossPrices(s: SimState, town: TownId): number[] {
  const out = new Array(N_GOODS).fill(1);
  for (let g = 0; g < N_GOODS; g++) out[g] = fin(expectedGross(s, town, g), 1e-4);
  return out;
}

/**
 * What a good costs to make here and now: materials at local expected prices + tool
 * wear + the local wage per unit at the calibrated productivity, divided by α (price =
 * marginal cost at a typical firm's optimum; the founding-price formula at today's costs).
 * Buyers anchor their "pay anything" bids to it, so that bids at a multiple of the market
 * price cannot ratchet the price up day after day in a shortage. Goods nobody makes → ema.
 */
export function fairPrice(s: SimState, town: TownId, good: number, prices?: readonly number[]): number {
  const k = PRODUCER_OF[good];
  const d = k ? SECTORS[k] : undefined;
  const ema = Math.max(1e-6, fin(marketOf(s, town, good).ema, 1));
  if (!d) return ema;
  const pr = prices ?? townGrossPrices(s, town);
  const w = defaultWage(s, town);
  const mat = materialCostPerUnit(k, pr);
  const tool = good === G.tools ? 0 : toolCostPerUnit(k, pr[G.tools], d.prodPerWorker, carryRate(s));
  const c = mat + tool + w / (d.alpha * d.prodPerWorker);
  return c > 0 && Number.isFinite(c) ? c : ema;
}

/** Annual rate firms use to price the carrying cost of tools. */
function carryRate(s: SimState): number {
  const r = fin(s.bank?.baseRate, 0.045);
  return clamp(r, 0, 1);
}

/** Employer's cost of one worker-day at gross wage w (employer-side wage levies included). */
function employerCost(s: SimState, f: Firm, w: number, levies: boolean): number {
  if (!levies) return w;
  const r = wageLevyRates(s, f.town, f.sector, w);
  return Math.max(0, fin(w * (1 + r.employerPct) + r.employerUnit, w));
}

// ---------------------------------------------------------------------------
// Loans of firms (scanned directly so the module works with any bank implementation)
// ---------------------------------------------------------------------------
interface FirmDebt {
  debt: Float64Array; // all principal
  working: Float64Array; // working-capital principal
  overdue: Float64Array; // max overdue days
}

function firmDebts(s: SimState): FirmDebt {
  const n = s.firms.length;
  const d: FirmDebt = { debt: new Float64Array(n), working: new Float64Array(n), overdue: new Float64Array(n) };
  for (const ln of s.loans) {
    if (!ln.active || !isFirm(ln.borrower)) continue;
    const id = refId(ln.borrower);
    if (id < 0 || id >= n) continue;
    const pr = Math.max(0, fin(ln.principal));
    d.debt[id] += pr;
    if (ln.purpose === 'working') d.working[id] += pr;
    if (ln.overdue > d.overdue[id]) d.overdue[id] = ln.overdue;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

/**
 * Typical daily cash costs of a firm (¤): wages of its planned workforce plus the
 * materials of its usual output (producers), plus a margin for builders' materials
 * and traders' fuel. Used for cash targets, loan sizes and dividends.
 */
export function firmDailyCost(s: SimState, f: Firm): number {
  const d = SECTORS[f.sector];
  const n = Math.max(f.workers.length, fin(f.target));
  const w = Math.max(0, fin(f.wage));
  let c = n * w;
  if (d && d.producer) {
    let mc = 0;
    for (const [g, a] of d.inputs) mc += a * Math.max(0, fin(marketOf(s, f.town, g).ema));
    c += mc * Math.max(fin(f.output), fin(f.sales));
  } else if (f.sector === 'builder') c *= 1.4;
  else if (f.sector === 'trader') {
    // Fuel and wear on top of wages, plus the merchandise a fleet turns over: about a
    // quarter of its wagon capacity a day at a middling price (grain as the yardstick).
    c *= 1.5;
    const wagons = Math.max(0, fin(f.trade?.wagons ?? 0));
    c += 0.25 * wagons * WAGON_CAPACITY * Math.max(0, fin(marketOf(s, f.town, G.grain).ema, 1));
  }
  return Math.max(1, fin(c, 1));
}

/** Typical daily costs of a new firm of a sector in a town (for start-up working capital). */
export function typicalDailyCost(s: SimState, sector: Sector, town: TownId): number {
  const d = SECTORS[sector];
  if (!d) return 1;
  const n = Math.max(1, Math.min(d.capacityPerLevel, d.typicalSize));
  const w = defaultWage(s, town);
  let c = n * w;
  if (d.producer) {
    let mc = 0;
    for (const [g, a] of d.inputs) mc += a * Math.max(0, fin(expectedGross(s, town, g)));
    c += mc * d.prodPerWorker * n;
    c += d.toolsPerWorker * n * Math.max(0, fin(expectedGross(s, town, G.tools))) / Math.max(1, NEW_FIRM_WC_DAYS); // first tools
  }
  return Math.max(1, fin(c, 1));
}

// ---------------------------------------------------------------------------
// Morning: plans and wages
// ---------------------------------------------------------------------------

function meanExpectedInflation(s: SimState): number {
  let sum = 0;
  let n = 0;
  for (const p of s.people) {
    if (!p || !p.alive) continue;
    sum += fin(p.expInfl);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

/** Posted-wage adjustment (all firm sectors except stateworks). */
function adjustWage(s: SimState, f: Firm, index: number, unemp: number, lo: number, hi: number): void {
  const base = defaultWage(s, f.town);
  let w = f.wage > 0 && Number.isFinite(f.wage) ? f.wage : base;
  w *= index;
  const open = fin(f.target) - f.workers.length;
  // Raise pay only when vacancies stay open for want of willing applicants (a firm held back
  // by its daily hiring pace while plenty of people would take the job has no reason to).
  if (f.vacancyDays > WAGE_VACANCY_DAYS && open > 0.5 && f.applicants < open) w *= 1 + WAGE_UP_DAY;
  else if (open <= 0.5 && (f.distress > 0 || (f.profit < 0 && unemp > WAGE_CUT_UNEMP))) w *= 1 - WAGE_DOWN_DAY;
  w = Math.max(WAGE_MIN_ABS, fin(w, base));
  if (lo >= 0 && w < lo) w = lo;
  if (hi >= 0 && w > hi) w = hi;
  f.wage = fin(w, base);
}

/**
 * Price (net of seller levies) at which yesterday's buyers in the firm's market would
 * have taken `qty` units: read off the aggregated demand curve of the order book.
 * Used by firms that have nothing to sell to judge whether coming back is worth it.
 * 0 if the book had no bids.
 */
function demandPriceFor(m: MarketState | undefined, qty: number, expNet: number): number {
  const c = m?.curve;
  if (!m || !c || c.bids.length < 2) return m && m.bestBid > 0 ? 0 : 0;
  const ref = m.ema > 0 && Number.isFinite(m.ema) ? m.ema : m.price;
  const toNet = ref > 0 ? expNet / ref : 1;
  const b = c.bids;
  let p = 0;
  for (let i = 0; i + 1 < b.length; i += 2) {
    p = b[i];
    if (b[i + 1] >= qty) return Math.max(0, p * toNet);
  }
  return 0; // the whole book would not take one worker's output
}

/** Producer workforce target (see the header). */
function planTarget(s: SimState, f: Firm, pt: PriceTable, salesByTG: Float64Array, levies: boolean, sc: FirmScratch): void {
  const d = SECTORS[f.sector];
  const k = f.sector;
  const t = f.town;
  const g = d.out;
  const cap = Math.max(0, f.capacity);
  const nW = f.workers.length;
  const es = workforceEff(s, f);
  const eff = nW > 0 ? clamp(es / nW, 0.3, 3) : 0.95;
  const site = siteMultiplier(s, f);
  const sPlan = planSeason(d, s.day);
  const gross = pt.gross[t];
  const m = s.markets[t * N_GOODS + g];
  const pNet = f.pExp > 0 && Number.isFinite(f.pExp) ? f.pExp : pt.net[t][g];
  const mc = materialCostPerUnit(k, gross);
  const tc = toolCostPerUnit(k, gross[G.tools], d.prodPerWorker * site * sPlan * eff, carryRate(s));
  const margin = pNet - mc - tc;
  const wEff = Math.max(0.01, employerCost(s, f, f.wage, levies));
  // Profit-maximising effective labour, in workers of today's average efficiency.
  const lOpt = margin > 0 ? optimalLabor(k, margin, wEff / eff, sPlan, site) / eff : 0;

  // Demand side: expected sales (+ a share of the market's unmet demand) and the stock gap.
  let sales = Math.max(0, fin(f.sales));
  if (m && m.shortage > 0 && Number.isFinite(m.shortage)) {
    const tot = salesByTG[t * N_GOODS + g];
    const share = tot > 1e-9 ? sales / tot : 1;
    sales += SHORTAGE_WEIGHT * m.shortage * share;
  }
  const perish = isPerishable(g);
  const tgt = inventoryTarget(k, sales, s.day);
  const adj = perish ? INV_ADJUST_DAYS_PERISHABLE : INV_ADJUST_DAYS;
  // Production follows mean (de-seasonalised) sales; the stock target absorbs the season.
  const qWant = Math.max(0, meanSales(g, sales, s.day) * (1 + DEMAND_SLACK) + (tgt - Math.max(0, f.inv[g])) / adj);
  let lDem = laborForOutput(k, qWant, sPlan, site) / eff;
  // Without a sales history the firm keeps (or builds up to) a capacity-based workforce.
  const young = s.day - f.founded < NEW_FIRM_DAYS;
  const noHistory = !(f.sales > 1e-6) || f.sales < 0.2 * fin(f.output);
  if (young && noHistory) lDem = Math.max(lDem, nW, NEW_FIRM_SCALE * Math.min(cap, d.typicalSize));
  const profitBound = lOpt < lDem;
  let raw = Math.min(lOpt, lDem);
  if (!(margin > 0)) raw = 0;
  raw = clamp(fin(raw), 0, cap);
  if (margin > 0 && lOpt > 0.3 && lDem > 0.05 && raw < 1) raw = Math.min(1, cap);
  // Probing: a firm that has stopped (nothing in stock, nothing sold) comes back with one
  // worker when yesterday's buyers would have paid more than it costs one worker to make
  // their output — otherwise a firm that stopped would never learn that demand came back.
  let probe = 0;
  if (cap >= 1 && !(f.sales > 1) && f.inv[g] < 1) {
    const q1 = potentialOutput(k, eff, d.toolsPerWorker * eff, sPlan, site);
    const pp = demandPriceFor(m, q1, pt.net[t][g]);
    if (q1 > 0 && pp > mc + tc + wEff / q1) {
      raw = Math.max(raw, 1);
      probe = pp;
    }
  }

  // Competitive pricing: the net price at which the optimal workforce would equal the
  // workforce demand calls for — marginal cost at the quantity demanded. Asks move toward
  // it (at most ASK_COMPETE_STEP a day): fat margins with idle capacity are competed away,
  // cost increases are passed on instead of simply cutting output.
  let shade = 1;
  if (probe > 0) shade = probe / Math.max(1e-6, pNet);
  else if (lDem > 1e-6 && lOpt > 1e-6 && margin > 0) {
    const pStar = mc + tc + margin * Math.pow(lDem / lOpt, 1 - d.alpha);
    shade = pStar / Math.max(1e-6, pNet);
  } else if (!(margin > 0) && lDem > 0.05) shade = (mc + tc + wEff / Math.max(1e-6, d.prodPerWorker * site * sPlan * eff)) / Math.max(1e-6, pNet);
  if (f.id < sc.n) sc.shade[f.id] = clamp(fin(shade, 1), 1 - ASK_COMPETE_STEP, 1 + ASK_COMPETE_STEP);

  // Smoothing with hysteresis. When the margin (not demand) binds, the daily step is also
  // bounded: with α near 1 the optimum reacts to margins with an elasticity of 1/(1−α), so
  // firms feel their way toward it; what they cannot sell they stop making at once.
  const cur = clamp(fin(f.target), 0, cap);
  let next = cur;
  if (Math.abs(raw - cur) > TARGET_HYSTERESIS * cur + 0.1) {
    let step = TARGET_SMOOTH * (raw - cur);
    if (profitBound && margin > 0) {
      const stepCap = TARGET_MAX_STEP * Math.max(cur, 1) + TARGET_MAX_STEP_ABS;
      step = clamp(step, -stepCap, stepCap);
    }
    next = cur + step;
  }
  if (raw <= 0 && next < 0.3) next = 0;
  f.target = clamp(fin(next), 0, cap);
  const dbg = rt(s).bag.firmDebug as Record<number, unknown> | undefined;
  if (dbg) dbg[f.id] = { pNet, mc, tc, margin, lOpt, lDem, raw, sales, tgt, stock: f.inv[g], shade: f.id < sc.n ? sc.shade[f.id] : 0 };
}

/**
 * Morning, for active producer firms (builders' and traders' targets are set by
 * their own modules; stateworks by policy): expected net price (markets.expectedNet)
 * vs material & tool cost → production.optimalLabor; demand-based labour from
 * sales EMA and inventory gap; target = min(capacity, max(0/1, ...)), smoothed
 * (TARGET_SMOOTH). Wage adjustment: +WAGE_UP_DAY while vacancyDays > WAGE_VACANCY_DAYS,
 * −WAGE_DOWN_DAY when losing money and local unemployment is high, + partial
 * indexation (WAGE_INDEXATION × expected inflation / 360); clamp to limits.wageBounds.
 * Applies to ALL firm sectors except stateworks (builders/traders also adjust wages here).
 */
export function firmsPlan(s: SimState): void {
  const sc = scratch(s);
  const pt = priceTable(s);
  const nT = s.towns.length;
  const infl = meanExpectedInflation(s);
  const index = 1 + (WAGE_INDEXATION * clamp(infl, -0.2, 0.5)) / DAYS_PER_YEAR;
  const unemp: number[] = [];
  const lo: number[] = [];
  const hi: number[] = [];
  for (let t = 0; t < nT; t++) {
    const town = s.towns[t];
    unemp.push(town && town.pop > 0 ? clamp(fin(town.unemployed) / town.pop, 0, 1) : 0);
    const b = wageBounds(s, t);
    lo.push(b && b.min >= 0 ? b.min : -1);
    hi.push(b && b.max >= 0 ? b.max : -1);
  }
  const levies = hasLevyBase(s, 'wage');
  const salesByTG = new Float64Array(nT * N_GOODS);
  for (const f of s.firms) {
    if (!f || !operating(s, f)) continue;
    const d = SECTORS[f.sector];
    if (d && d.producer && f.town >= 0 && f.town < nT) salesByTG[f.town * N_GOODS + d.out] += Math.max(0, fin(f.sales));
  }
  for (const f of s.firms) {
    if (!f || !f.alive || f.status !== 'active' || f.sector === 'stateworks') continue;
    const d = SECTORS[f.sector];
    if (!d) continue;
    const t = f.town >= 0 && f.town < nT ? f.town : 0;
    adjustWage(s, f, index, unemp[t] ?? 0, lo[t] ?? -1, hi[t] ?? -1);
    if (!d.producer) continue;
    if (!operating(s, f)) {
      f.target = 0;
      continue;
    }
    planTarget(s, f, pt, salesByTG, levies, sc);
  }
}

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------

/**
 * Production for producer firms: Leff = Σ (0.5 + 0.5·health) × strike factor
 * (town.strikeDays > 0 → STRIKE_FACTOR); Q = potentialOutput(...) capped by
 * materialCap and INV_MAX_DAYS; consume inputs; add output to inv; tools wear
 * (toolUse × Leff + TOOLS_IDLE_WEAR_DAY × tools). Farms use drought (town.droughtDays)
 * as ×0.5. Site multiplier from the building's tile deposit/fertility (0.6 + 0.8·x).
 * stats.acc: prod_<good>, realva (value added at stats.basePrices), inputs used.
 */
export function firmsProduce(s: SimState): void {
  const sc = scratch(s);
  const pt = priceTable(s);
  const bp = s.stats.basePrices ?? [];
  const acc = s.stats.acc;
  let realva = 0;
  let wearTotal = 0;
  for (const f of s.firms) {
    if (!f || !operating(s, f)) continue;
    const d = SECTORS[f.sector];
    if (!d || !d.producer) continue;
    const k = f.sector;
    const g = d.out;
    const t = f.town;
    const leff = workforceEff(s, f) * strikeFactor(s, t);
    const tools = Math.max(0, fin(f.tools));
    let q = 0;
    let wear = TOOLS_IDLE_WEAR_DAY * tools;
    if (leff > 0) {
      let season = seasonFactor(d.season, s.day);
      if (d.season === 'farm' && (s.towns[t]?.droughtDays ?? 0) > 0) season *= DROUGHT_FACTOR;
      const site = siteMultiplier(s, f);
      const qPot = potentialOutput(k, leff, tools, season, site);
      const cap = materialCap(k, f.inv);
      const ref = Math.max(fin(f.sales), 0.2 * qPot);
      const room = Math.max(0, inventoryMaxDays(k) * ref - Math.max(0, f.inv[g]));
      q = Math.max(0, Math.min(qPot, cap, room));
      if (!(q > 1e-9)) q = 0;
      // Wear with use: only the tools actually in use, only while working.
      const util = qPot > 0 ? q / qPot : 0;
      const inUse = d.toolsPerWorker > 0 ? Math.min(1, tools / (d.toolsPerWorker * leff)) : 0;
      wear += d.toolUse * leff * util * inUse;
    }
    wear = Math.min(tools, Math.max(0, wear));
    f.tools = Math.max(0, tools - wear);
    let matVal = 0;
    if (q > 0) {
      let vaIn = 0;
      for (const [j, a] of d.inputs) {
        const use = Math.min(Math.max(0, f.inv[j]), a * q);
        f.inv[j] = Math.max(0, f.inv[j] - use);
        matVal += use * pt.gross[t][j];
        vaIn += use * fin(bp[j]);
        acc[K_USE[j]] = (acc[K_USE[j]] || 0) + use;
      }
      f.inv[g] += q;
      f.producedToday += q;
      acc[K_PROD[g]] = (acc[K_PROD[g]] || 0) + q;
      realva += q * fin(bp[g]) - vaIn;
    }
    wearTotal += wear;
    if (f.id < sc.n) {
      sc.matUsed[f.id] += matVal;
      sc.toolWear[f.id] += wear * pt.gross[t][G.tools];
    }
  }
  bump(s, 'realva', realva);
  bump(s, 'toolwear', wearTotal);
}

// ---------------------------------------------------------------------------
// Wages
// ---------------------------------------------------------------------------

/**
 * Pay every worker of every active firm its wage (all sectors incl. builders,
 * traders; stateworks are paid by the Treasury: pay(STATE → worker)).
 * Wage levies: worker-side (deducted: pay firm→worker net, firm→STATE levy via
 * chargeLevy with payer 'worker'… implement so the worker's net = gross − levy)
 * and employer-side (extra, payer 'employer'). If the firm cannot pay in full,
 * pay pro-rata and mark distress. Adds to person.earned; firm.wageBill;
 * stats.acc wages, wages_<sector>.
 *
 * Implementation: the gross wage is paid to the worker, then worker-side levies are
 * charged on the worker (chargeLevy payer 'worker', a give adds to take-home), then
 * employer-side levies on the firm (payer 'employer'). Group filters see the worker.
 * A firm short of cash pays every worker the same fraction of the gross wage.
 */
export function firmsPayWages(s: SimState): void {
  const sc = scratch(s);
  const levies = hasLevyBase(s, 'wage');
  const people = s.people;
  const nT = s.towns.length;
  const maxW: number[] = [];
  for (let t = 0; t < nT; t++) {
    const b = wageBounds(s, t);
    maxW.push(b && b.max >= 0 ? b.max : -1);
  }
  let total = 0;
  let stateTotal = 0;
  for (const f of s.firms) {
    if (!f || !f.alive || f.workers.length === 0) continue;
    if (f.status !== 'active' && f.status !== 'liquidating') continue;
    const mx = maxW[f.town] ?? -1;
    let gross = Math.max(0, fin(f.wage));
    if (mx >= 0 && gross > mx) gross = mx;
    if (!(gross > 0)) continue;
    const state = f.sector === 'stateworks';
    const payer: Ref = state ? STATE : firmRef(f.id);
    let k = 1;
    let empPer = 0;
    if (!state) {
      if (levies) {
        const r = wageLevyRates(s, f.town, f.sector, gross);
        empPer = fin(gross * r.employerPct + r.employerUnit);
      }
      const due = f.workers.length * (gross + Math.max(0, empPer));
      const cash = Math.max(0, f.cash);
      if (due > cash + 1e-9) {
        k = due > 0 ? cash / due : 0;
        if (f.id < sc.n) sc.unpaid[f.id] += due - cash;
      }
    }
    const w = gross * k;
    let paidFirm = 0;
    for (let i = 0; i < f.workers.length; i++) {
      const pid = f.workers[i];
      const p = people[pid];
      if (!p || !p.alive) continue;
      const paid = w > 0 ? pay(s, payer, pid, w, 'wage') : 0;
      let net = paid;
      if (levies && paid > 0) {
        const ctx = { town: f.town, sector: f.sector, person: p };
        net -= chargeLevy(s, 'wage', pid, 'worker', ctx, paid, 1);
        if (!state) f.wageBill += chargeLevy(s, 'wage', payer, 'employer', ctx, paid, 1);
      }
      p.earned += net;
      paidFirm += paid;
    }
    f.wageBill += paidFirm;
    total += paidFirm;
    if (state) stateTotal += paidFirm;
    bump(s, wagesKey(f.sector), paidFirm);
  }
  bump(s, 'wages', total);
  bump(s, 'wages_state', stateTotal);
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

// Pending bid scratch (flat, reused): book index, price, qty, class (0 inputs, 1 tools).
const pBook: Book[] = [];
const pPrice: number[] = [];
const pQty: number[] = [];
const pClass: number[] = [];

function pushBid(book: Book, price: number, qty: number, cls: number): void {
  if (!(qty > 1e-9) || !(price > 0) || !Number.isFinite(price) || !Number.isFinite(qty)) return;
  pBook.push(book);
  pPrice.push(price);
  pQty.push(qty);
  pClass.push(cls);
}

const ASK_CUM_AT_1 = (() => {
  let c = 0;
  for (let i = 0; i < ASK_RUNGS.length; i++) if (ASK_RUNGS[i] <= 1 + 1e-9) c += ASK_WEIGHTS[i];
  return c > 0 ? c : 0.5;
})();

/** Ask ladder for a producer's own output. */
function askOutput(s: SimState, books: Books, f: Firm, pt: PriceTable, sc: FirmScratch): void {
  const d = SECTORS[f.sector];
  const g = d.out;
  const stock = Math.max(0, f.inv[g]);
  if (!(stock > 1e-6)) return;
  const ref = firmRef(f.id);
  const t = f.town;
  const book = bookFor(books, t, g);
  const pExp = f.pExp > 0 && Number.isFinite(f.pExp) ? f.pExp : pt.net[t][g];
  const sales = salesRef(s, f, stock);
  const target = Math.max(1e-6, inventoryTarget(f.sector, sales, s.day));
  let shift = clamp(Math.pow(stock / target, -ASK_INV_ELASTICITY), ASK_SHIFT_MIN, ASK_SHIFT_MAX);
  const sh = f.id < sc.n ? sc.shade[f.id] : 0;
  if (sh > 0) shift *= sh;
  const distressed = f.distress > 0;
  if (distressed) shift *= DISTRESS_ASK_SHIFT;
  const base = pExp * shift;
  // Cost floor: a share of unit variable cost at the current wage and output per worker.
  let floor = 0;
  if (!distressed) {
    const nW = f.workers.length;
    // Output per worker: realised, but never below half the calibrated norm (a firm idled by
    // missing inputs must not price itself out of the market on a freak cost figure).
    const norm = d.prodPerWorker * siteMultiplier(s, f) * seasonFactor(d.season, s.day);
    const apl = Math.max(nW > 0 ? fin(f.output) / nW : 0, 0.5 * norm);
    floor = ASK_COST_FLOOR * fin(unitVariableCost(f.sector, f.wage, apl, pt.gross[t]), 0);
  }
  const perish = isPerishable(g);
  const adj = perish ? INV_ADJUST_DAYS_PERISHABLE : INV_ADJUST_DAYS;
  let left = stock;
  // Planned sales at ≤ pExp: expected sales, corrected toward the stock target (bounded, so a
  // firm short of its target — a farm before the harvest — still sells, just less and dearer).
  let qs = clamp(sales + (stock - target) / adj, ASK_QS_MIN * sales, ASK_QS_MAX * sales);
  qs = clamp(qs, 0, stock);
  if (perish && stock > target) {
    // Overstock of a perishable is priced to clear: it rots if held.
    const excess = stock - target;
    const exDays = excess / Math.max(1e-6, sales);
    const k = PERISH_CLEAR_K * ((GOODS[g]?.spoil ?? 0.05) / 0.05);
    const m = clamp(1 - k * exDays, PERISH_CLEAR_MIN, 0.95);
    // Salvage floor: never below half of what the stock cost to make (the price spiral of
    // clearing at a share of an expectation that itself follows the clearing price stops here).
    const salvage = 0.5 * Math.max(0, fin(f.unitCost));
    addAsk(book, ref, Math.max(base * m, Math.min(salvage, base)), excess);
    left -= excess;
    qs = Math.min(sales, left);
  }
  if (!(left > 1e-6)) return;
  const qo = Math.min(left, qs / ASK_CUM_AT_1);
  if (qo > 1e-6) {
    for (let i = 0; i < ASK_RUNGS.length; i++) {
      const q = qo * ASK_WEIGHTS[i];
      if (q > 1e-6) addAsk(book, ref, Math.max(floor, base * ASK_RUNGS[i]), q);
    }
    left -= qo;
  }
  if (left > 1e-6) addAsk(book, ref, Math.max(floor, base * ASK_TOP_RUNG), left);
}

/** Input and tool bid ladders for a producer, capped by cash. */
function bidInputsAndTools(s: SimState, books: Books, f: Firm, pt: PriceTable, sc: FirmScratch, levies: boolean): void {
  const d = SECTORS[f.sector];
  const k = f.sector;
  const t = f.town;
  const gross = pt.gross[t];
  const nW = f.workers.length;
  const tgtW = Math.max(0, fin(f.target));
  if (!(tgtW > 0) && nW === 0) return;
  const es = workforceEff(s, f);
  const eff = nW > 0 ? clamp(es / nW, 0.3, 3) : 0.95;
  const planW = Math.max(tgtW, nW);
  const site = siteMultiplier(s, f);
  const season = seasonFactor(d.season, s.day);
  pBook.length = pPrice.length = pQty.length = pClass.length = 0;

  // ---- inputs: keep INPUT_BUFFER_DAYS of planned production ----
  if (d.inputs.length && tgtW > 0) {
    const qPlan = Math.max(fin(f.output), potentialOutput(k, tgtW * eff, d.toolsPerWorker * tgtW * eff, season, site));
    const pNet = f.pExp > 0 && Number.isFinite(f.pExp) ? f.pExp : pt.net[t][d.out];
    const mc = materialCostPerUnit(k, gross);
    const tc = toolCostPerUnit(k, gross[G.tools], Math.max(1e-6, qPlan / Math.max(1, planW)), carryRate(s));
    for (const [j, a] of d.inputs) {
      const want = a * qPlan * INPUT_BUFFER_DAYS;
      const have = Math.max(0, f.inv[j]);
      const gap = want - have;
      if (!(gap > 1e-6)) continue;
      const u = clamp(1 - have / Math.max(1e-9, want), 0, 1);
      const pj = gross[j];
      // Short-run break-even: the most this input can cost while output still covers materials and tool wear.
      const beMax = (pNet - (mc - a * pj) - tc) / a;
      if (!(beMax > 0)) continue;
      const book = bookFor(books, t, j);
      for (let i = 0; i < INPUT_BID_RUNGS.length; i++) {
        const r = INPUT_BID_RUNGS[i];
        const m = r > 1 ? 1 + (r - 1) * (1 + u) : r;
        pushBid(book, Math.min(pj * m, beMax), gap * INPUT_BID_WEIGHTS[i], 0);
      }
    }
  }

  // ---- tools: equip the planned workforce plus a wear buffer ----
  let sh = 0;
  if (d.toolsPerWorker > 0 && f.sector !== 'toolworks' && planW > 0) {
    const effW = planW * eff;
    const want = d.toolsPerWorker * effW + TOOLS_BUFFER_DAYS * d.toolUse * effW;
    const have = Math.max(0, fin(f.tools)) + Math.max(0, f.inv[G.tools]);
    const gap = want - have;
    if (gap > 1e-6) {
      sh = clamp(1 - have / Math.max(1e-9, d.toolsPerWorker * Math.max(1, nW) * eff), 0, 1);
      const qty = gap * (TOOLS_GAP_CLOSE + (1 - TOOLS_GAP_CLOSE) * sh);
      const top = 1.1 + (TOOLS_MAX_BID_MULT - 1.1) * sh;
      const pT = gross[G.tools];
      // Never above TOOLS_MAX_BID_MULT × what tools cost to make (see fairPrice).
      const lim = TOOLS_MAX_BID_MULT * fairPrice(s, t, G.tools, gross);
      const book = bookFor(books, t, G.tools);
      pushBid(book, Math.min(pT * top, lim), qty * 0.25, 1);
      pushBid(book, Math.min(pT * (1 + top) * 0.5, lim), qty * 0.25, 1);
      pushBid(book, Math.min(pT, lim), qty * 0.3, 1);
      pushBid(book, Math.min(pT * 0.92, lim), qty * 0.2, 1);
    }
  }
  if (pBook.length === 0) return;

  // ---- budget: cash less tomorrow's payroll ----
  const wageDay = Math.max(nW, tgtW) * employerCost(s, f, f.wage, levies);
  const budget = Math.max(0, fin(f.cash) - WAGE_RESERVE_DAYS * wageDay);
  let costIn = 0;
  let costT = 0;
  for (let i = 0; i < pBook.length; i++) {
    const c = pPrice[i] * pQty[i];
    if (pClass[i] === 0) costIn += c;
    else costT += c;
  }
  let kIn = 1;
  let kT = 1;
  if (costIn + costT > budget) {
    const wIn = costIn;
    const wT = costT * (1 + 2 * sh);
    let aIn = wIn + wT > 0 ? (budget * wIn) / (wIn + wT) : 0;
    let aT = budget - aIn;
    if (aIn > costIn) {
      aT += aIn - costIn;
      aIn = costIn;
    }
    if (aT > costT) {
      aIn = Math.min(costIn, aIn + aT - costT);
      aT = costT;
    }
    kIn = costIn > 0 ? clamp(aIn / costIn, 0, 1) : 0;
    kT = costT > 0 ? clamp(aT / costT, 0, 1) : 0;
    if (f.id < sc.n) sc.short[f.id] += costIn + costT - budget;
  }
  const fref = firmRef(f.id);
  for (let i = 0; i < pBook.length; i++) {
    const q = pQty[i] * (pClass[i] === 0 ? kIn : kT);
    if (q > 1e-6) addBid(pBook[i], fref, pPrice[i], q);
  }
  pBook.length = 0;
}

/** Liquidating firms dump everything they hold at fire-sale prices. */
function fireSale(books: Books, f: Firm, pt: PriceTable): void {
  const ref = firmRef(f.id);
  const t = f.town;
  if (t < 0 || t >= pt.net.length) return;
  for (let g = 0; g < N_GOODS; g++) {
    const q = f.inv[g];
    if (!(q > 1e-6)) continue;
    addAsk(bookFor(books, t, g), ref, FIRE_SALE * pt.net[t][g], q);
  }
}

/**
 * Orders for producer firms: ask ladder for output (ASK_RUNGS/ASK_WEIGHTS around
 * pExp, shifted by inventory ratio, floored at ASK_COST_FLOOR × unit variable cost
 * except when distressed/liquidating/perishable overstock); bid ladders for inputs
 * (INPUT_BUFFER_DAYS) and tools (toolsPerWorker × target + TOOLS_BUFFER_DAYS of wear,
 * TOOLS_GAP_CLOSE of the gap per day) within cash + expected credit. Liquidating
 * firms dump everything at fire-sale prices.
 */
export function firmOrders(s: SimState, books: Books): void {
  const sc = scratch(s);
  const pt = priceTable(s);
  const levies = hasLevyBase(s, 'wage');
  for (const f of s.firms) {
    if (!f || !f.alive) continue;
    if (f.status === 'liquidating') {
      if (f.sector !== 'stateworks') fireSale(books, f, pt);
      continue;
    }
    const d = SECTORS[f.sector];
    if (!d || !d.producer || !operating(s, f)) continue;
    askOutput(s, books, f, pt, sc);
    bidInputsAndTools(s, books, f, pt, sc, levies);
  }
}

// ---------------------------------------------------------------------------
// Evening: accounting, finance, distress
// ---------------------------------------------------------------------------

/** Bought tools join the capital stock (toolworks equip themselves from their own output). */
function absorbTools(s: SimState, f: Firm, pt: PriceTable): void {
  const d = SECTORS[f.sector];
  if (!d || !d.producer) return;
  if (f.sector === 'toolworks') {
    const effW = Math.max(f.workers.length, fin(f.target)) * 0.95;
    const want = d.toolsPerWorker * effW + TOOLS_BUFFER_DAYS * d.toolUse * effW - Math.max(0, f.tools);
    const take = Math.min(Math.max(0, want), Math.max(0, f.inv[G.tools]));
    if (take > 1e-9) {
      f.inv[G.tools] -= take;
      f.tools += take;
      bump(s, 'tools_selfsupply', take);
    }
    return;
  }
  const q = f.inv[G.tools];
  if (q > 0) {
    f.tools = Math.max(0, fin(f.tools)) + q;
    f.inv[G.tools] = 0;
    bump(s, 'tools_absorbed', q);
    bump(s, 'tools_absorbed_value', q * pt.gross[f.town][G.tools]);
  }
}

/** Today's profit (¤) by the firm's accounting rules; updates the unit cost (weighted average cost of stock). */
function accountDay(s: SimState, f: Firm, sc: FirmScratch): number {
  const d = SECTORS[f.sector];
  const id = f.id;
  const mat = id < sc.n ? sc.matUsed[id] : 0;
  const wear = id < sc.n ? sc.toolWear[id] : 0;
  if (d && d.producer) {
    const g = d.out;
    const sold = Math.max(0, fin(f.soldToday));
    const prod = Math.max(0, fin(f.producedToday));
    const stock = Math.max(0, f.inv[g]);
    const prodCost = fin(f.wageBill) + mat + wear;
    const s0 = Math.max(0, stock + sold - prod);
    let uc = f.unitCost > 0 && Number.isFinite(f.unitCost) ? f.unitCost : 0;
    let idle = 0;
    if (prod > 1e-9) {
      const s1 = s0 + prod;
      uc = (uc * s0 + prodCost) / Math.max(1e-9, s1);
    } else idle = prodCost;
    uc = fin(uc, 0);
    f.unitCost = uc;
    const cogs = uc * sold;
    const spoilLoss = uc * stock * (GOODS[g]?.spoil ?? 0);
    return fin(f.revenue - cogs - idle - f.otherCosts - spoilLoss);
  }
  if (f.sector === 'builder') return fin(f.revenue - f.wageBill - f.otherCosts - mat - wear);
  // Traders (and anything else): cash basis.
  return fin(f.revenue - f.spent - f.wageBill - f.otherCosts);
}

/** Pay a dividend from a firm to its owner. Returns the amount paid. */
function payDividend(s: SimState, f: Firm, amount: number): number {
  if (!(amount > 0.01)) return 0;
  const fref = firmRef(f.id);
  let to: Ref = f.owner;
  let person: Person | undefined;
  if (isPerson(to)) {
    person = s.people[to];
    if (!person || !person.alive) {
      to = STATE;
      person = undefined;
    }
  } else if (isFirm(to)) {
    const o = s.firms[refId(to)];
    if (!o || !o.alive || o.id === f.id) to = STATE;
  } else if (to !== STATE) to = STATE;
  const paid = pay(s, fref, to, amount, 'dividend');
  if (person) person.earned += paid;
  else if (isFirm(to)) {
    const o = s.firms[refId(to)];
    if (o) o.otherCosts -= paid;
  }
  bump(s, 'dividends', paid);
  if (to === STATE) bump(s, 'dividends_state', paid);
  return paid;
}

/** Month end: repay working loans early when flush, then pay out half the excess cash. */
function monthEndFinance(s: SimState, f: Firm, costDay: number, working: number): void {
  const fref = firmRef(f.id);
  let reserve = CASH_TARGET_DAYS * costDay;
  if (f.build) reserve += builderAdvances(s, f);
  // Early repayment of working-capital loans (destroys deposits: credit contracts when firms are flush).
  if (working > 0 && f.cash > reserve + (PREPAY_CASH_DAYS - CASH_TARGET_DAYS) * costDay) {
    let room = f.cash - reserve;
    for (const ln of s.loans) {
      if (!(room > 0.01)) break;
      if (!ln.active || ln.borrower !== fref || ln.purpose !== 'working' || !(ln.principal > 0)) continue;
      const a = repayPrincipal(s, fref, Math.min(room, ln.principal));
      ln.principal -= a;
      room -= a;
      bump(s, 'loans_prepaid', a);
      if (ln.principal <= 1e-6) {
        if (ln.principal > 0) writeOff(s, ln.principal);
        ln.principal = 0;
        ln.active = false;
      }
    }
  }
  const excess = f.cash - reserve;
  if (excess > 0 && (f.monthProfit > 0 || excess > CASH_TARGET_DAYS * costDay)) payDividend(s, f, DIVIDEND_SHARE * excess);
}

/** Advances builders hold for their customers' projects (a liability, excluded from dividends). */
function builderAdvances(s: SimState, f: Firm): number {
  let a = 0;
  for (const p of s.projects) if (p.builder === f.id && p.status !== 'done' && p.status !== 'cancelled') a += Math.max(0, fin(p.prepaid));
  return a;
}

/** A builder or trader that is the last of its kind in its town is never closed (the town would lose the service). */
export function isEssentialFirm(s: SimState, f: Firm): boolean {
  if (f.sector !== 'builder' && f.sector !== 'trader') return false;
  for (const o of s.firms) {
    if (!o || o === f || !o.alive || o.status !== 'active') continue;
    if (o.sector === f.sector && o.town === f.town) return false;
  }
  return true;
}

/**
 * Evening: accounting (profit = revenue − spent − wageBill − otherCosts; EMAs of
 * sales, output, unit cost, profit, pExp from realised net price); monthly profit
 * levies (chargeLevy 'profit', payer 'owner'); finance: working-capital loan
 * requests when cash < CASH_LOW_DAYS of costs (bank.requestLoan); monthly dividends
 * (DIVIDEND_SHARE of cash above CASH_TARGET_DAYS × costs → owner, flow 'dividend');
 * distress counting & bankruptcy (closeFirm) after DISTRESS_BANKRUPT_DAYS;
 * liquidation countdown. Applies to all firms except stateworks.
 *
 * Accounting detail: producers value output stock at weighted-average production
 * cost (wages + materials used + tool wear); profit = revenue − cost of goods sold −
 * idle production cost − other costs − tonight's expected spoilage. Builders:
 * billed revenue − wages − materials and tool wear used. Traders: cash basis.
 */
export function firmsEndDay(s: SimState): void {
  const sc = scratch(s);
  const pt = priceTable(s);
  const debts = firmDebts(s);
  const monthEnd = isMonthEnd(s.day);
  const profitLevies = monthEnd && hasLevyBase(s, 'profit');
  const pending = new Set<number>();
  for (const r of s.bank.requests ?? []) if (isFirm(r.borrower)) pending.add(r.borrower);
  const n = s.firms.length;
  for (let i = 0; i < n; i++) {
    const f = s.firms[i];
    if (!f || !f.alive || f.sector === 'stateworks') continue;
    if (f.status === 'liquidating') {
      f.liquidationDays += 1;
      if (f.liquidationDays >= LIQUIDATION_DAYS) finalizeClosure(s, f);
      continue;
    }
    if (f.status !== 'active') continue;
    const d = SECTORS[f.sector];
    if (!d) continue;
    const fref = firmRef(f.id);
    absorbTools(s, f, pt);

    // ---- accounting ----
    let profit = accountDay(s, f, sc);
    if (profitLevies) {
      const mp = f.monthProfit + profit;
      if (mp > 0) {
        const net = chargeLevy(s, 'profit', fref, 'owner', { town: f.town, sector: f.sector }, mp, 1);
        if (net) {
          f.otherCosts += net;
          profit -= net;
        }
      }
    }
    f.sales = Math.max(0, ema(fin(f.sales), Math.max(0, fin(f.soldToday)), SALES_EMA));
    f.output = Math.max(0, ema(fin(f.output), Math.max(0, fin(f.producedToday)), SALES_EMA));
    f.profit = fin(ema(fin(f.profit), profit, PROFIT_EMA));
    f.monthProfit = fin(f.monthProfit) + profit;
    f.lossDays = f.profit < 0 ? fin(f.lossDays) + 1 : 0;
    if (d.producer) {
      const g = d.out;
      const expNet = pt.net[f.town]?.[g] ?? f.pExp;
      let x = expNet;
      if (f.soldToday > Math.max(1e-6, 0.05 * f.sales) && f.revenue > 0) x = 0.5 * (f.revenue / f.soldToday) + 0.5 * expNet;
      else if (!(f.inv[g] > 1)) {
        // Nothing to sell: expect what yesterday's buyers would pay for a worker's output.
        const q1 = potentialOutput(f.sector, 0.95, d.toolsPerWorker, planSeason(d, s.day), siteMultiplier(s, f));
        x = Math.max(x, demandPriceFor(s.markets[f.town * N_GOODS + g], q1, expNet));
      }
      f.pExp = f.pExp > 0 && Number.isFinite(f.pExp) ? Math.max(1e-6, ema(f.pExp, x, PRICE_EXP_EMA)) : Math.max(1e-6, fin(x, 1));
    }

    // ---- finance ----
    const costDay = firmDailyCost(s, f);
    const working = debts.working[i] ?? 0;
    if (monthEnd) {
      monthEndFinance(s, f, costDay, working);
      f.monthProfit = 0;
    }
    const unpaid = i < sc.n ? sc.unpaid[i] : 0;
    const short = i < sc.n ? sc.short[i] : 0;
    const low = f.cash < CASH_LOW_DAYS * costDay;
    const wantMore = short > 0 && f.cash < CASH_TARGET_DAYS * costDay;
    if ((low || unpaid > 0 || wantMore) && !pending.has(fref)) {
      const retry = unpaid > 0 || (s.day + f.id) % WORKING_LOAN_RETRY_DAYS === 0;
      const room = WORKING_DEBT_MAX_DAYS * costDay - working;
      if (retry && room > 1) {
        let amount = CASH_TARGET_DAYS * costDay - Math.max(0, f.cash) + unpaid + Math.min(short, CASH_TARGET_DAYS * costDay);
        amount = Math.min(amount, room);
        if (amount > 1) requestLoan(s, { borrower: fref, amount, term: WORKING_LOAN_TERM, purpose: 'working', project: -1 });
      }
    }

    // ---- distress & bankruptcy ----
    const was = fin(f.distress);
    const distressed = unpaid > 1e-6 || (debts.overdue[i] ?? 0) > 0;
    f.distress = distressed ? was + 1 : Math.max(0, was - DISTRESS_RECOVER);
    if (Math.max(was, f.distress) >= DISTRESS_BANKRUPT_DAYS) {
      if (!isEssentialFirm(s, f)) {
        bump(s, 'bankruptcies');
        closeFirm(s, f, 'bankrupt');
      } else f.distress = Math.min(f.distress, DISTRESS_BANKRUPT_DAYS - 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Life cycle
// ---------------------------------------------------------------------------

/** Create a firm record (and link it to its building). Uses s.ids.firm. */
export function createFirm(s: SimState, sector: Sector, town: TownId, building: number, owner: Ref): Firm {
  const d = SECTORS[sector];
  const tname = s.towns[town]?.name ?? '';
  let name = d ? d.name : sector;
  try {
    name = firmName(s, d ? d.name : sector, tname) || name;
  } catch {
    /* names module unavailable: keep the sector name */
  }
  const f = newFirm(s, sector, town, building, owner, name);
  const b = building >= 0 ? s.buildings[building] : undefined;
  if (b) {
    b.firm = f.id;
    b.sector = sector;
    b.owner = owner;
    if (d) f.capacity = d.capacityPerLevel * Math.max(1, b.level || 1);
    touchBuildings(s);
  }
  f.wage = defaultWage(s, town);
  if (d && d.producer) {
    f.pExp = Math.max(1e-6, fin(expectedNet(s, town, d.out), 1));
    f.unitCost = fin(unitVariableCost(sector, f.wage, d.prodPerWorker, townGrossPrices(s, town)), 0);
  }
  if (isPerson(owner)) {
    const p = s.people[owner];
    if (p && p.owns.indexOf(f.id) < 0) p.owns.push(f.id);
  }
  return f;
}

const CLOSE_REASON: Record<string, string> = {
  bankrupt: 'it could no longer pay its workers and creditors',
  unprofitable: 'after months of losses its owner gave up',
};

/**
 * Bankruptcy / closure: lay off all workers, status 'liquidating' (dumps stock for
 * LIQUIDATION_DAYS), then 'closed': remaining debts written off (ledger.writeOff),
 * remaining cash to the owner, building status 'vacant', firm.alive = false.
 * Its tools are put up for sale with the rest of its stock; construction projects
 * it commissioned (or, for a builder, has queued) are cancelled.
 */
export function closeFirm(s: SimState, f: Firm, reason: string): void {
  if (!f || !f.alive || f.status !== 'active') return;
  for (const pid of f.workers.slice()) {
    const p = s.people[pid];
    if (p) fire(s, f, p);
  }
  f.workers.length = 0;
  f.status = 'liquidating';
  f.liquidationDays = 0;
  f.target = 0;
  f.vacancyDays = 0;
  if (f.tools > 0) {
    f.inv[G.tools] += f.tools;
    f.tools = 0;
  }
  const fref = firmRef(f.id);
  for (const p of s.projects) {
    if (p.status === 'done' || p.status === 'cancelled') continue;
    if (p.owner === fref || (f.build && p.builder === f.id)) cancelProject(s, p.id);
  }
  bump(s, 'closures');
  const town = s.towns[f.town]?.name ?? '';
  const why = CLOSE_REASON[reason] ?? reason;
  news(s, `${f.name}${town ? ' in ' + town : ''} has shut its doors${why ? ': ' + why : ''}.`, 'bad', f.town);
}

/** End of liquidation: creditors first, the owner gets what is left, the building stands vacant. */
function finalizeClosure(s: SimState, f: Firm): void {
  const fref = firmRef(f.id);
  let lost = 0;
  for (const ln of s.loans) {
    if (!ln.active || ln.borrower !== fref) continue;
    const a = repayPrincipal(s, fref, Math.max(0, ln.principal));
    ln.principal = Math.max(0, ln.principal - a);
    if (ln.principal > 0) {
      writeOff(s, ln.principal);
      lost += ln.principal;
    }
    ln.principal = 0;
    ln.active = false;
  }
  if (lost > 0) bump(s, 'bankrupt_writeoffs', lost);
  const rq = s.bank.requests;
  if (rq && rq.length) {
    let k = 0;
    for (let i = 0; i < rq.length; i++) if (rq[i].borrower !== fref) rq[k++] = rq[i];
    rq.length = k;
  }
  // Remaining cash to the owner (a return of capital, not income).
  if (f.cash > 0) {
    let to: Ref = f.owner;
    if (isPerson(to)) {
      const p = s.people[to];
      if (!p || !p.alive) to = STATE;
    } else if (isFirm(to)) {
      const o = s.firms[refId(to)];
      if (!o || !o.alive || o.id === f.id) to = STATE;
    } else to = STATE;
    pay(s, fref, to, f.cash, 'transfer');
  }
  // Unsold stock stays in the vacant building; a firm that reopens it takes it over.
  const b = f.building >= 0 ? s.buildings[f.building] : undefined;
  if (b && b.firm === f.id) {
    b.status = 'vacant';
    b.project = -1;
    b.vacantDays = 0;
    touchBuildings(s);
  }
  if (isPerson(f.owner)) {
    const p = s.people[f.owner];
    if (p) {
      const k = p.owns.indexOf(f.id);
      if (k >= 0) p.owns.splice(k, 1);
    }
  }
  f.workers.length = 0;
  f.target = 0;
  f.status = 'closed';
  f.alive = false;
}

/** Value of a firm's assets (cash + inventory + tools at market prices + building book value) — collateral. */
export function firmAssets(s: SimState, f: Firm): number {
  if (!f) return 0;
  let v = Math.max(0, fin(f.cash));
  const t = f.town;
  for (let g = 0; g < N_GOODS; g++) {
    const q = f.inv[g];
    if (q > 0) v += q * Math.max(0, fin(marketOf(s, t, g).ema));
  }
  v += Math.max(0, fin(f.tools)) * Math.max(0, fin(marketOf(s, t, G.tools).ema));
  if (f.trade) {
    for (let u = 0; u < f.trade.stock.length; u++) {
      if (u === t) continue;
      const st = f.trade.stock[u];
      if (!st) continue;
      for (let g = 0; g < N_GOODS; g++) if (st[g] > 0) v += st[g] * Math.max(0, fin(marketOf(s, u, g).ema));
    }
  }
  const b = f.building >= 0 ? s.buildings[f.building] : undefined;
  if (b && b.firm === f.id) v += Math.max(0, fin(b.cost));
  return fin(v);
}

/** Tool factor of a firm right now (for the UI / inspector). */
export function firmToolFactor(s: SimState, f: Firm): number {
  const d = SECTORS[f.sector];
  if (!d) return 1;
  return toolFactor(d, Math.max(0, f.tools), workforceEff(s, f));
}

/** Cash a firm could spend today without touching tomorrow's payroll (for other modules). */
export function firmFreeCash(s: SimState, f: Firm): number {
  const w = Math.max(f.workers.length, fin(f.target)) * Math.max(0, fin(f.wage));
  return Math.max(0, fin(cashOf(s, firmRef(f.id))) - WAGE_RESERVE_DAYS * w);
}
