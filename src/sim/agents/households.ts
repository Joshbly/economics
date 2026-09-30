// ============================================================================
// Households: budgets, bidding for consumer goods, portfolio (IOUs, gold),
// consumption, health, contentment. Uses the pure model in demandModel.ts.
// OWNER: households agent. See DESIGN §3.1.
//
// Transmission channels that live here:
//  * interest rates → consumption: the money buffer households want to hold rises
//    with the REAL after-levy deposit rate (deposit rate − interest levies − levies
//    on money held − expected inflation). Dearer money → bigger buffers → less spending.
//  * prices & levies → demand: bids are placed in gross (levy-inclusive) prices, so a
//    buyer-side sale levy shifts the demand curve down in base terms; bread and fish
//    substitute through the CES food nest. A sale rule aimed at a group of people
//    (levies.isTargetedSale, e.g. a share of the price of bread paid for hungry
//    households) rides on their own bids, and they plan at their own expected price.
//  * income → consumption: spending tracks an EMA of disposable income (net wages,
//    dividends, rent received, interest, Treasury payments, net of per-head and other
//    stock levies — everything the paying modules book into person.earned).
//  * inflation → portfolio: when expected inflation outruns the deposit rate, savers
//    buy gold; when IOU yields beat deposits they buy IOUs.
//  * living standards → health (productivity, mortality) and contentment (unrest,
//    emigration).
// ============================================================================
import * as CFG from '../config';
import * as CAL from '../calendar';
import * as GOODS_M from '../goods';
import * as LEDGER from '../ledger';
import { addAsk, addBid, bookFor, expectedGross, expectedGrossFor, type Books } from '../market/markets';
import { matchLevies, peopleSaleRules, targetMatches } from '../policy/levies';
import { rt } from '../runtime';
import type { Book, Levy, Person, SimState } from '../types';
import * as TYPES from '../types';
import * as UTIL from '../util';
import { bufferTarget, foodIndex, goodsBudget } from './demandModel';
import { hasLevyBase, netWage, wageCtx } from './labor';
import { flowIndex, flowTally, FLOW_USED } from '../stats/flows';
import { householdIouYield, postIouSchedule } from './bonds';
import { goldTarget } from './gold';

// Leaf-module constants and helpers (config, goods, util, calendar, types, rng, ledger — no
// import cycles back into agents) bound once at load: hot loops then read locals instead of
// live import bindings (which cost a getter call per read under tsx/vitest).
const { personRef } = LEDGER;
const { INFL_EXP_MIN, INFL_EXP_MAX } = CFG;
const { ALE_JOY_SCALE, ALE_MAX_PER_DAY, BASE_WAGE, BID_RUNGS, COAL_COMFORT_DAYS, COAL_SHOP_DAYS, COLD_BELOW, COMFORT_HALF, CONTENT_EMA, CONTENT_W_COMFORT, CONTENT_W_FOOD, CONTENT_W_HEALTH, CONTENT_W_HOME, CONTENT_W_INCOME, CONTENT_W_JOY, CONTENT_W_WORK, ELASTICITY, FOOD_FLEX, FOOD_MAX, FOOD_NEED, FURNITURE_SHOP_DAYS, FURNITURE_WEAR_DAY, GOLD_BAND, GOLD_REBAL_SPEED, HEALTH_EMA, HEALTH_FOOD_POW, HEALTH_W_HEAT, HEAT_AHEAD_DAYS, HEAT_AMP, HEAT_MEAN, HEAT_RESERVE_DAYS, HH_RUNGS, HOMELESS_HEALTH, HUNGRY_BELOW, INCOME_EMA, INFL_EXP_EMA, INFL_PAIN_SPAN, INFL_PAIN_START, INFL_PAIN_W, IOU_BUY_SPEED, IOU_FULL_SPREAD, IOU_SELL_SPEED, JOY_EMA, MIN_BID_SPEND, OLD_AGE_MAX_LOSS, OLD_AGE_SPAN, OLD_AGE_START, PANTRY_DAYS_BREAD, PANTRY_DAYS_COAL, PANTRY_DAYS_FISH, PORTFOLIO_MAX_GOLD_SHARE, PORTFOLIO_MAX_IOU_SHARE, PORTFOLIO_MIN_ORDER, PORTFOLIO_SURPLUS_MULT, SHARE_ALE, SHARE_COAL, SHARE_FOOD, SHARE_FURNITURE } = CFG;
const { CONSUMER_GOODS, G, N_GOODS } = GOODS_M;
const { clamp, ema, fin } = UTIL;
const { heatNeed } = CAL;
const { GOLD_GOOD, IOU_GOOD } = TYPES;

/** Bread share of food units when no plan exists (CES weight at equal prices). */
const FOOD_W_BREAD_FALLBACK = 0.68;

function bump(s: SimState, key: string, v = 1): void {
  const acc = s.stats.acc;
  acc[key] = (acc[key] || 0) + v;
}

// ---------------------------------------------------------------------------
// Runtime cache (rebuildable; never serialised). Holds today's plan per person
// so that consumption in the evening follows the plan made in the morning.
// ---------------------------------------------------------------------------
export interface HouseholdCache {
  day: number; // day the plan below belongs to (-1 none)
  ordersDay: number; // day householdOrders filled foodPlan/alePlan/coalExtra/committed
  size: number;
  buf: Float64Array; // money buffer target m*
  foodPlan: Float64Array; // food units to eat today
  alePlan: Float64Array; // ale to drink today
  coalExtra: Float64Array; // comfort coal (beyond heat need) to burn today
  committed: Float64Array; // worst-case ¤ today's goods bids can cost (uniform-price clearing)
  subsist: Float64Array; // subsistence cost at expected prices
  prices: number[][]; // [town][good] expected gross prices (consumer goods; others 1)
  breadShare: number[]; // [town] planned bread share of food units
  fiIndex: number[]; // [town] CES food price index
  fiBread: number[]; // [town] bread expenditure share in the food nest
  fiFish: number[]; // [town] fish expenditure share
  subsistTown: number[]; // [town] subsistence cost (food + today's heat) at expected prices
  realIncome: number[]; // [town] mean real income (for relative standing)
  unemp: number[]; // [town] local unemployment rate used for buffers
  heat: number;
  heatAhead: number;
}

function newArr(n: number): Float64Array {
  return new Float64Array(n);
}

/** Get (and size) the households runtime cache. */
export function householdCache(s: SimState): HouseholdCache {
  const r = rt(s);
  let c = r.bag.households as HouseholdCache | undefined;
  const need = s.people.length;
  if (!c) {
    const n = need + 64;
    c = {
      day: -1,
      ordersDay: -1,
      size: n,
      buf: newArr(n),
      foodPlan: newArr(n),
      alePlan: newArr(n),
      coalExtra: newArr(n),
      committed: newArr(n),
      subsist: newArr(n),
      prices: [],
      breadShare: [],
      fiIndex: [],
      fiBread: [],
      fiFish: [],
      subsistTown: [],
      realIncome: [],
      unemp: [],
      heat: HEAT_MEAN,
      heatAhead: HEAT_MEAN,
    };
    r.bag.households = c;
  } else if (c.size < need) {
    const n = Math.ceil(need * 1.25) + 64;
    const grow = (a: Float64Array) => {
      const b = newArr(n);
      b.set(a);
      return b;
    };
    c.buf = grow(c.buf);
    c.foodPlan = grow(c.foodPlan);
    c.alePlan = grow(c.alePlan);
    c.coalExtra = grow(c.coalExtra);
    c.committed = grow(c.committed);
    c.subsist = grow(c.subsist);
    c.size = n;
  }
  return c;
}

/** Mean heat need over the next `n` days (for stocking coal ahead of winter). */
export function heatAheadMean(day: number, n = HEAT_AHEAD_DAYS): number {
  let t = 0;
  for (let k = 1; k <= n; k++) t += heatNeed(day + k);
  return t / Math.max(1, n);
}

function safePrice(x: number): number {
  const v = fin(x, 1);
  return v > 0.01 ? v : 0.01;
}

/** Rent the person pays per day for their slot (0 if homeless or owner-occupier). */
export function rentOf(s: SimState, p: Person): number {
  if (p.home < 0) return 0;
  const b = s.buildings[p.home];
  if (!b || b.owner === personRef(p.id)) return 0;
  return Math.max(0, fin(b.rent));
}

/**
 * Effective annual return on holding deposits for this person: the bank's deposit
 * rate, minus interest levies on it (a negative levy adds), minus any levy on money
 * held (an annual % on balances above a threshold the person is near or above).
 */
export function effectiveDepositRate(s: SimState, p: Person, interestLevies: boolean, moneyLevies: boolean, buffer: number): number {
  let r = fin(s.bank.depositRate);
  const ctx = { person: p, town: p.town };
  if (interestLevies && r > 0) {
    let pct = 0;
    for (const l of matchLevies(s, 'interest', 'receiver', ctx)) if (l.unit === 'pct') pct += l.dir * l.rate;
    r *= 1 - clamp(pct, -1, 1);
  }
  if (moneyLevies) {
    const bal = Math.max(p.cash, buffer);
    for (const l of matchLevies(s, 'money', 'holder', ctx)) if (l.unit === 'pct' && bal > l.threshold) r -= l.dir * l.rate;
  }
  return r;
}

/**
 * Before markets (after wages are paid):
 *  - income EMA from yesterday's person.earned (INCOME_EMA) — every module that pays a
 *    person books it there (levies.stockLevies books takes negative); lastWage tracking;
 *  - expected inflation EMA toward stats.latest.inflYoY (INFL_EXP_EMA);
 *  - today's goods budget via demandModel.bufferTarget / goodsBudget, stored in person.budget
 *    (rent = their slot's rent if housed);
 *  - reset person.spent / person.earned scratch AFTER using earned.
 */
export function householdsBeginDay(s: SimState): void {
  const c = householdCache(s);
  const nT = s.towns.length;
  c.day = s.day;
  c.heat = heatNeed(s.day);
  c.heatAhead = heatAheadMean(s.day);

  // Per-town expected gross prices, food split and local unemployment.
  for (const a of [c.prices, c.breadShare, c.unemp, c.fiIndex, c.fiBread, c.fiFish, c.subsistTown]) a.length = nT;
  for (let t = 0; t < nT; t++) {
    const row = c.prices[t] ?? (c.prices[t] = new Array(N_GOODS).fill(1));
    for (let g = 0; g < N_GOODS; g++) row[g] = 1;
    for (const g of CONSUMER_GOODS) row[g] = safePrice(expectedGross(s, t, g));
    // Same for everyone in town: the CES food index and subsistence cost
    // (identical to demandModel.foodIndex / subsistenceCost).
    const fi = foodIndex(row[G.bread], row[G.fish]);
    c.fiIndex[t] = fi.index;
    c.fiBread[t] = fi.shareBread;
    c.fiFish[t] = fi.shareFish;
    c.subsistTown[t] = FOOD_NEED * fi.index + c.heat * row[G.coal];
    const qb = fi.shareBread / row[G.bread];
    const qf = fi.shareFish / row[G.fish];
    c.breadShare[t] = qb + qf > 0 ? qb / (qb + qf) : FOOD_W_BREAD_FALLBACK;
    const town = s.towns[t];
    c.unemp[t] = town.pop > 0 ? clamp(fin(town.unemployed) / Math.max(1, town.pop), 0, 1) : 0.05;
  }

  const lat = s.stats.latest;
  // Households read inflation off the change in prices over the last year, and do not
  // extrapolate it into a runaway expectation (INFL_EXP_MIN..MAX). A month's change, annualised,
  // is mostly the season (coal is cheap in summer, grain after the harvest): read as a real
  // interest rate it would raise every buffer target by weeks of income each summer
  // (bufferTarget) and turn the season's cheap months into a hoarding slump.
  const infl = clamp(fin(lat.inflYoY ?? 0), INFL_EXP_MIN, INFL_EXP_MAX);
  const interestLevies = hasLevyBase(s, 'interest');
  const moneyLevies = hasLevyBase(s, 'money');
  const wc = wageCtx(s);
  // Take-home wage per firm (one levy/limit lookup per firm, not per worker).
  const firmNet = new Float64Array(s.firms.length);
  for (let i = 0; i < s.firms.length; i++) {
    const f = s.firms[i];
    if (f && f.alive) firmNet[i] = netWage(s, wc, f);
  }
  const depositRate = fin(s.bank.depositRate);

  const incSum = new Array(nT).fill(0);
  const incN = new Array(nT).fill(0);
  for (let i = 0; i < s.people.length; i++) {
    const p = s.people[i];
    if (!p || !p.alive) continue;
    // Disposable income: net of everything booked into `earned` over the last day
    // (net wages, dividends, rent received, interest, Treasury payments; stock levies
    // such as per-head takes are booked negative by levies.stockLevies).
    p.income = Math.max(0, ema(fin(p.income), fin(p.earned), INCOME_EMA));
    if (p.job >= 0 && p.job < firmNet.length && s.firms[p.job]?.alive) p.lastWage = firmNet[p.job];
    p.expInfl = clamp(ema(fin(p.expInfl), infl, INFL_EXP_EMA), -0.5, 1.5);

    const t = p.town >= 0 && p.town < nT ? p.town : 0;
    const unemp = c.unemp[t] ?? 0.05;
    // Buffer: first pass with the plain deposit rate to know which balance levies apply to.
    let m = bufferTarget(p.income, depositRate - p.expInfl, unemp);
    if (interestLevies || moneyLevies) {
      const dep = effectiveDepositRate(s, p, interestLevies, moneyLevies, m);
      m = bufferTarget(p.income, dep - p.expInfl, unemp);
    }
    const sub = c.subsistTown[t] ?? 0;
    p.budget = fin(goodsBudget(p.income, Math.max(0, p.cash), m, rentOf(s, p), sub));
    c.buf[p.id] = m;
    c.subsist[p.id] = sub;

    if (nT > 0) {
      const cpi = s.towns[t].cpi > 1 ? s.towns[t].cpi : 100;
      incSum[t] += p.income / (cpi / 100);
      incN[t] += 1;
    }
    p.earned = 0;
    p.spent = 0;
  }
  c.realIncome.length = nT;
  for (let t = 0; t < nT; t++) c.realIncome[t] = incN[t] > 0 ? incSum[t] / incN[t] : baseIncome(s);
}

/** The founding standard of living (¤/day of income) used as the absolute anchor for contentment. */
function baseIncome(s: SimState): number {
  const w = fin(s.stats.baseWage);
  return (w > 2 ? w : BASE_WAGE) * 0.9;
}

// ---------------------------------------------------------------------------
// Allocation-free demand planning. `planInto` and `ladderInto` reproduce
// demandModel.planDemand / bidLadder exactly (tests/households.test.ts pins them
// to the shared model); they exist because they run ~1 000 × per day and the
// per-town parts (food index, subsistence) and the rung powers can be hoisted.
// ---------------------------------------------------------------------------

/** Output of planInto (reused). */
export interface PlanScratch {
  qty: number[];
  spend: number[];
  maxSpend: number[];
  foodPlan: number;
  alePlan: number;
  coalExtra: number;
  subsistence: number;
}

export function newPlanScratch(): PlanScratch {
  return { qty: new Array(N_GOODS).fill(0), spend: new Array(N_GOODS).fill(0), maxSpend: new Array(N_GOODS).fill(0), foodPlan: 0, alePlan: 0, coalExtra: 0, subsistence: 0 };
}

/**
 * demandModel.planDemand without allocation, given the town's CES food index
 * (`fiIndex`, `shB`, `shF` from demandModel.foodIndex at the same prices).
 */
export function planInto(
  out: PlanScratch,
  budget: number,
  cash: number,
  p: readonly number[],
  pantry: readonly number[],
  heat: number,
  heatAhead: number,
  hungry: boolean,
  fiIndex: number,
  shB: number,
  shF: number,
): PlanScratch {
  const qty = out.qty;
  const spend = out.spend;
  const maxSpend = out.maxSpend;
  for (let g = 0; g < N_GOODS; g++) qty[g] = spend[g] = maxSpend[g] = 0;
  const sub = FOOD_NEED * fiIndex + heat * p[G.coal];
  // Heating is budgeted at its annual mean cost (demandModel.planDemand): the supernumerary
  // budget does not shrink every winter and swell every summer — the cash buffer carries the fuel bill.
  const S = Math.max(0, budget - (FOOD_NEED * fiIndex + HEAT_MEAN * p[G.coal]));

  const foodPlan = Math.min(FOOD_MAX, FOOD_NEED + (SHARE_FOOD * S) / fiIndex);
  const breadEat = (foodPlan * fiIndex * shB) / p[G.bread];
  const fishEat = (foodPlan * fiIndex * shF) / p[G.fish];
  const alePlan = Math.min(ALE_MAX_PER_DAY, (SHARE_ALE * S) / p[G.ale]);
  const coalExtra = (SHARE_COAL * S) / p[G.coal];
  // Shares a sated household cannot use (food and ale have a ceiling) go to furniture, the
  // good without one (demandModel.satedSpillover), so the supernumerary budget is spent in full.
  const spill = SHARE_FOOD * S - (foodPlan - FOOD_NEED) * fiIndex + SHARE_ALE * S - alePlan * p[G.ale];

  qty[G.bread] = Math.max(0, breadEat * (1 + PANTRY_DAYS_BREAD) - pantry[G.bread]);
  qty[G.fish] = Math.max(0, fishEat * (1 + PANTRY_DAYS_FISH) - pantry[G.fish]);
  const coalTarget = heat + PANTRY_DAYS_COAL * Math.max(heat, heatAhead) + coalExtra;
  qty[G.coal] = Math.max(0, coalTarget - pantry[G.coal]);
  qty[G.ale] = Math.max(0, alePlan - pantry[G.ale]);
  qty[G.furniture] = (SHARE_FURNITURE * S + Math.max(0, spill)) / p[G.furniture];
  for (const g of CONSUMER_GOODS) spend[g] = qty[g] * p[g];

  // Essentials first: if today's essentials exceed the budget, luxuries go to zero. Only what is
  // eaten and burnt today counts (demandModel.planDemand): topping up the larder and the coal
  // store is a use of the cash buffer, not a reason to go without ale that day.
  const essentialUse = breadEat * p[G.bread] + fishEat * p[G.fish] + (heat + coalExtra) * p[G.coal];
  const essential = Math.min(spend[G.bread] + spend[G.fish] + spend[G.coal], essentialUse);
  // The winter's fuel above its mean comes out of the buffer, not the luxuries (demandModel.planDemand).
  const room = Math.max(0, budget + Math.max(0, heat - HEAT_MEAN) * p[G.coal] - essential);
  const lux = spend[G.ale] + spend[G.furniture];
  if (lux > room) {
    const k = lux > 0 ? room / lux : 0;
    qty[G.ale] *= k;
    spend[G.ale] *= k;
    qty[G.furniture] *= k;
    spend[G.furniture] *= k;
  }

  const foodFlex = hungry ? FOOD_FLEX : 1.35;
  maxSpend[G.bread] = spend[G.bread] * foodFlex;
  maxSpend[G.fish] = spend[G.fish] * foodFlex;
  maxSpend[G.coal] = spend[G.coal] * (heat > HEAT_MEAN ? 1.6 : 1.25);
  maxSpend[G.ale] = spend[G.ale] * 1.1;
  maxSpend[G.furniture] = spend[G.furniture] * 1.1;
  capToCash(maxSpend, cash);

  out.foodPlan = foodPlan;
  out.alePlan = alePlan;
  out.coalExtra = coalExtra;
  out.subsistence = sub;
  return out;
}

/** Never commit more than cash: shrink luxuries first (furniture, then ale), then essentials pro rata. */
function capToCash(maxSpend: number[], cash: number): void {
  let total = 0;
  for (let g = 0; g < N_GOODS; g++) total += maxSpend[g];
  if (!(total > cash)) return;
  let over = total - cash;
  for (const g of LUX_CUT_ORDER) {
    const cut = Math.min(maxSpend[g], over);
    maxSpend[g] -= cut;
    over -= cut;
  }
  if (over > 0) {
    const rest = maxSpend[G.bread] + maxSpend[G.fish] + maxSpend[G.coal];
    const k = rest > 0 ? Math.max(0, (rest - over) / rest) : 0;
    maxSpend[G.bread] *= k;
    maxSpend[G.fish] *= k;
    maxSpend[G.coal] *= k;
  }
}
const LUX_CUT_ORDER = [G.furniture, G.ale];

/** RUNG_POW[g][k] = (1/BID_RUNGS[k])^ELASTICITY[g] (the iso-elastic quantity multipliers). */
const RUNG_POW: number[][] = Array.from({ length: N_GOODS }, (_, g) => BID_RUNGS.map((m) => Math.pow(1 / m, ELASTICITY[g] ?? 0.8)));
const ALL_RUNGS = BID_RUNGS.map((_, k) => k);
/** Index of the rung closest to 1.0× the expected price. */
const UNIT_RUNG = ALL_RUNGS.reduce((best, k) => (Math.abs(BID_RUNGS[k] - 1) < Math.abs(BID_RUNGS[best] - 1) ? k : best), 0);
/**
 * rungSets(n): strided subsets of the rung indices with about n rungs each,
 * {r, r+stride, r+2·stride, …} for r < stride = ceil(len/n). Their union is every
 * rung, and each subset holds a rung at or below 1.0× (the 1.0× rung is added
 * to any subset that would otherwise lack one).
 */
export function rungSets(n: number): number[][] {
  const len = BID_RUNGS.length;
  const stride = Math.max(1, Math.ceil(len / Math.max(1, Math.min(len, n))));
  const sets: number[][] = [];
  for (let r = 0; r < stride; r++) {
    const set: number[] = [];
    for (let k = r; k < len; k += stride) set.push(k);
    // Every household must be able to buy at the expected price.
    if (!set.some((k) => BID_RUNGS[k] <= 1) && set.indexOf(UNIT_RUNG) < 0) set.push(UNIT_RUNG);
    set.sort((a, b) => BID_RUNGS[b] - BID_RUNGS[a]); // prices descending
    sets.push(set);
  }
  return sets;
}
/** Rung subsets per consumer good (from config HH_RUNGS). */
const RUNG_SETS: number[][][] = Array.from({ length: N_GOODS }, (_, g) => rungSets(HH_RUNGS[g] ?? BID_RUNGS.length));

/**
 * demandModel.bidLadder without allocation and with the rung powers precomputed,
 * restricted to the rung indices in `rungs` (all rungs → identical output).
 * Cumulative quantity at rung price P is min(qty·(1/m)^ε, maxSpend/P), so under
 * uniform-price clearing the ladder never costs more than maxSpend.
 */
export function ladderInto(qty: number, pExp: number, maxSpend: number, good: number, rungs: readonly number[], out: number[]): number[] {
  out.length = 0;
  if (!(qty > 1e-6) || !(pExp > 0) || !(maxSpend > 0)) return out;
  const pw = RUNG_POW[good];
  let prevCum = 0;
  for (let i = 0; i < rungs.length; i++) {
    const k = rungs[i];
    const price = pExp * BID_RUNGS[k];
    let cum = qty * pw[k];
    cum = Math.min(cum, maxSpend / price);
    if (cum > prevCum + 1e-9) {
      out.push(price, cum - prevCum);
      prevCum = cum;
    }
  }
  return out;
}

// Scratch reused across people.
const _ladder: number[] = [];
const _plan: PlanScratch = newPlanScratch();
const _want: PlanScratch = newPlanScratch();

/**
 * What a household would take today of each consumer good (units in `out`, by good): its plan at the
 * going prices of its town (planInto), with at least 1.5 × its subsistence to spend — what it needs,
 * whatever it can pay. Used by the Treasury's free handouts (policy/player.treasuryHandouts), before
 * the market meets: what it is given, it no longer buys.
 */
export function householdWants(s: SimState, p: Person, out: number[]): number[] {
  const c = householdCache(s);
  if (c.day !== s.day) householdsBeginDay(s);
  for (let g = 0; g < N_GOODS; g++) out[g] = 0;
  const t = p.town >= 0 && p.town < s.towns.length ? p.town : 0;
  const prices = c.prices[t];
  if (!prices) return out;
  const base = Math.max(0, fin(p.budget), 1.5 * (c.subsist[p.id] || 0));
  const plan = planInto(_want, base, Math.max(fin(p.cash), base), prices, p.pantry, c.heat, c.heatAhead, p.foodSat < HUNGRY_BELOW, c.fiIndex[t], c.fiBread[t], c.fiFish[t]);
  for (const g of CONSUMER_GOODS) out[g] = Math.max(0, fin(plan.qty[g]));
  return out;
}
const _ownPrices: number[] = new Array(N_GOODS).fill(1);
const _peopleRules: Levy[][] = [];

/**
 * A person's own expected gross prices when a sale rule aimed at their group applies to them
 * (levies.peopleSaleRules): the town row with those goods re-priced (markets.expectedGrossFor).
 * Null when no rule names them (the common case).
 */
function ownPrices(s: SimState, p: Person, t: number, row: readonly number[], rules: readonly Levy[]): number[] | null {
  let named = false;
  for (let i = 0; i < rules.length && !named; i++) if (targetMatches(s, rules[i], personRef(p.id))) named = true;
  if (!named) return null;
  for (let g = 0; g < N_GOODS; g++) _ownPrices[g] = row[g];
  for (const g of CONSUMER_GOODS) _ownPrices[g] = safePrice(expectedGrossFor(s, t, g, personRef(p.id)));
  return _ownPrices;
}

/**
 * For each living person: the demandModel plan (planDemand semantics, see planInto)
 * with expected GROSS prices of their home town (markets.expectedGross), then a bid
 * ladder per consumer good (bidLadder semantics with config ELASTICITY), added to the
 * home-town books. Order-load control (config): each household bids on a rotating
 * strided subset of the rungs (HH_RUNGS per good) — all households of a town share
 * the same price levels, so the aggregate curve keeps every level; furniture is
 * bought every FURNITURE_SHOP_DAYS in larger lots; a comfortable coal store is
 * topped up every COAL_SHOP_DAYS.
 */
export function householdOrders(s: SimState, books: Books): void {
  const c = householdCache(s);
  if (c.day !== s.day) householdsBeginDay(s); // defensive: plan must exist
  const nT = s.towns.length;
  if (nT === 0) return;
  // Book lookup per town × consumer good.
  const bk: (Book | undefined)[][] = [];
  for (let t = 0; t < nT; t++) {
    const row: (Book | undefined)[] = new Array(N_GOODS);
    for (const g of CONSUMER_GOODS) row[g] = bookFor(books, t, g) ?? undefined;
    bk.push(row);
  }
  const heat = c.heat;
  const heatAhead = c.heatAhead;
  const coalComfort = heat + COAL_COMFORT_DAYS * heatAhead;
  const bid = addBid; // one binding read per call, not per order
  const day = s.day;
  // Sale rules aimed at groups of people, per town (usually none).
  let targeted = false;
  _peopleRules.length = nT;
  for (let t = 0; t < nT; t++) {
    const r = _peopleRules[t] ?? (_peopleRules[t] = []);
    r.length = 0;
    if (s.policy.levies.length) peopleSaleRules(s, t, r);
    if (r.length) targeted = true;
  }
  for (let i = 0; i < s.people.length; i++) {
    const p = s.people[i];
    if (!p || !p.alive) continue;
    const t = p.town >= 0 && p.town < nT ? p.town : 0;
    let prices = c.prices[t];
    let fiI = c.fiIndex[t];
    let fiB = c.fiBread[t];
    let fiF = c.fiFish[t];
    if (targeted && _peopleRules[t].length) {
      const own = ownPrices(s, p, t, prices, _peopleRules[t]);
      if (own) {
        prices = own;
        const fi = foodIndex(own[G.bread], own[G.fish]);
        fiI = fi.index;
        fiB = fi.shareBread;
        fiF = fi.shareFish;
      }
    }
    const cash = Math.max(0, p.cash);
    const budget = Math.min(Math.max(0, p.budget), cash);
    const plan = planInto(_plan, budget, cash, prices, p.pantry, heat, heatAhead, p.foodSat < HUNGRY_BELOW, fiI, fiB, fiF);
    c.foodPlan[p.id] = clamp(fin(plan.foodPlan, FOOD_NEED), 0, FOOD_MAX);
    c.alePlan[p.id] = Math.max(0, fin(plan.alePlan));
    c.coalExtra[p.id] = Math.max(0, fin(plan.coalExtra));

    // ---- staggered shopping for storable goods ----
    const ms = plan.maxSpend;
    const q = plan.qty;
    if (FURNITURE_SHOP_DAYS > 1) {
      if ((p.id + day) % FURNITURE_SHOP_DAYS === 0) {
        q[G.furniture] *= FURNITURE_SHOP_DAYS;
        ms[G.furniture] *= FURNITURE_SHOP_DAYS;
        let other = 0;
        for (const g of CONSUMER_GOODS) if (g !== G.furniture) other += ms[g];
        ms[G.furniture] = Math.max(0, Math.min(ms[G.furniture], cash - other));
      } else {
        q[G.furniture] = 0;
        ms[G.furniture] = 0;
      }
    }
    if (COAL_SHOP_DAYS > 1 && p.pantry[G.coal] >= coalComfort && (p.id + day) % COAL_SHOP_DAYS !== 0) {
      q[G.coal] = 0;
      ms[G.coal] = 0;
    }

    let committed = 0;
    const ref = personRef(p.id);
    const row = bk[t];
    for (const g of CONSUMER_GOODS) {
      const qg = q[g];
      const mg = ms[g];
      if (!(qg > 1e-5) || !(mg >= MIN_BID_SPEND)) continue;
      const book = row[g];
      if (!book) continue;
      const sets = RUNG_SETS[g];
      ladderInto(qg, prices[g], mg, g, sets[(p.id + day) % sets.length], _ladder);
      // Uniform-price clearing: every filled unit pays the same price P, and at most
      // the rungs with limit ≥ P fill, so the worst case is max_k P_k · cum_k (≤ maxSpend).
      let cum = 0;
      let worst = 0;
      for (let k = 0; k + 1 < _ladder.length; k += 2) {
        const price = _ladder[k];
        const qty = _ladder[k + 1];
        if (!(qty > 0) || !(price > 0)) continue;
        bid(book, ref, price, qty);
        cum += qty;
        if (price * cum > worst) worst = price * cum;
      }
      committed += worst;
    }
    c.committed[p.id] = committed;
  }
  c.ordersDay = s.day;
}

/**
 * The portfolio: IOUs and gold, out of savings (wealth beyond PORTFOLIO_SURPLUS_MULT × the buffer).
 *  · People short of liquidity (cash < buffer/2) offer IOUs / gold slightly below the market.
 *  · IOUs (agents/bonds.ts): the share of its savings a household wants in IOUs grows with how
 *    far their yield beats what it asks (its worth: none; PORTFOLIO_MAX_IOU_SHARE at
 *    IOU_FULL_SPREAD more); it moves IOU_BUY_SPEED / IOU_SELL_SPEED of the way there a day, as a
 *    ladder of bids and asks — and sells at once to a buyer paying well over its worth.
 *  · Gold (agents/gold.ts): each household wants a share of its wealth in gold (a base taste,
 *    an inflation hedge, fear for the bank, fear of the coin's fall); more than GOLD_BAND off
 *    it, it moves GOLD_REBAL_SPEED of the gap a day — buying with cash to spare, selling what
 *    it holds beyond.
 */
export function householdPortfolioOrders(s: SimState, books: Books): void {
  const c = householdCache(s);
  const iouBook = books.iou ?? bookFor(books, -1, IOU_GOOD);
  const goldBook = books.gold ?? bookFor(books, -1, GOLD_GOOD);
  const pIou = Math.max(1, fin(s.iouMarket?.ema, 100));
  const pGold = Math.max(0.01, fin(s.goldMarket?.ema, 100));
  const plan = c.ordersDay === s.day;

  for (let i = 0; i < s.people.length; i++) {
    const p = s.people[i];
    if (!p || !p.alive) continue;
    const ref = personRef(p.id);
    const m = c.buf[p.id] || 0;
    const iouVal = p.iou * pIou;
    const goldVal = p.gold * pGold;
    const wealth = Math.max(0, p.cash) + iouVal + goldVal;

    // ---- liquidity: sell assets when cash falls below half the buffer ----
    const floor = Math.max(0.5 * m, 5 * (c.subsist[p.id] || 0));
    if (p.cash < floor && (p.iou > 0 || p.gold > 0)) {
      const short = floor - Math.max(0, p.cash);
      // Sell the larger holding first.
      if (goldVal >= iouVal && p.gold > 0 && goldBook) {
        const q = Math.min(p.gold, short / pGold + 0.02 * p.gold);
        if (q * pGold >= PORTFOLIO_MIN_ORDER || q >= p.gold) addAsk(goldBook, ref, pGold * 0.97, q);
      } else if (p.iou > 0 && iouBook) {
        const q = Math.min(p.iou, short / pIou + 0.02 * p.iou);
        if (q * pIou >= PORTFOLIO_MIN_ORDER || q >= p.iou) addAsk(iouBook, ref, pIou * 0.97, q);
      }
      continue;
    }

    // Cash to spare: beyond the buffer, and not already committed to today's goods bids or tonight's rent.
    const savings = Math.max(0, wealth - PORTFOLIO_SURPLUS_MULT * m);
    let free = m > 0 ? Math.min(p.cash - PORTFOLIO_SURPLUS_MULT * m, p.cash - (plan ? c.committed[p.id] : p.budget) - 3 * rentOf(s, p)) : 0;
    if (!(free > 0)) free = 0;

    // ---- gold: a share of wealth (agents/gold.ts); beyond it, sell ----
    const gShare = wealth > 0 ? goldVal / wealth : 0;
    const gTarget = goldBook ? goldTarget(s, p) : 0;
    let soldGold = false;
    if (p.gold > 0 && goldBook && gShare > gTarget + GOLD_BAND) {
      const q = goldVal < 5 ? p.gold : Math.min(p.gold, ((gShare - gTarget) * wealth * GOLD_REBAL_SPEED) / pGold);
      if (q > 1e-9) addAsk(goldBook, ref, pGold * 0.99, q);
      soldGold = true;
    }

    // ---- IOUs: toward the holding it wants at each price (agents/bonds.ts) ----
    if (iouBook && (p.iou > 0 || free > PORTFOLIO_MIN_ORDER)) {
      const spent = postIouSchedule(
        iouBook,
        ref,
        { held: p.iou, funds: PORTFOLIO_MAX_IOU_SHARE * savings, cash: free, ask: householdIouYield(s, p.id), full: IOU_FULL_SPREAD, buySpeed: IOU_BUY_SPEED, sellSpeed: IOU_SELL_SPEED },
        pIou,
      );
      free -= spent;
    }

    // ---- gold: buy up to the share it wants with what cash is left ----
    if (!soldGold && goldBook && free > PORTFOLIO_MIN_ORDER && gShare < gTarget - GOLD_BAND) {
      const amt = Math.min(free, (gTarget - gShare) * wealth * GOLD_REBAL_SPEED);
      const lim = pGold * 1.03;
      if (amt >= PORTFOLIO_MIN_ORDER) addBid(goldBook, ref, lim, amt / lim);
    }
  }
}

/** Ale enjoyment of drinking `x` casks today (0..1, concave). */
export function aleJoy(x: number): number {
  return 1 - Math.exp(-ALE_JOY_SCALE * Math.max(0, x));
}

/** Comfort from a furniture stock (0..1, saturating). */
export function comfortOf(stock: number): number {
  const f = Math.max(0, stock);
  return f / (f + COMFORT_HALF);
}

/**
 * Health target from today's food and heat, housing and age. Food dominates
 * (a starving person's target is ~0); cold matters in proportion to how much
 * heat the season demands.
 */
export function healthTarget(foodSat: number, heatSat: number, heat: number, housed: boolean, age: number): number {
  const fs = clamp(foodSat, 0, 1);
  const food = fs >= 1 ? 1 : Math.pow(fs, HEALTH_FOOD_POW);
  const wHeat = HEALTH_W_HEAT * clamp(heat / (HEAT_MEAN * (1 + HEAT_AMP)), 0, 1);
  const warmth = 1 - wHeat * (1 - clamp(heatSat, 0, 1));
  const home = housed ? 1 : HOMELESS_HEALTH;
  const old = 1 - clamp((age - OLD_AGE_START) / OLD_AGE_SPAN, 0, OLD_AGE_MAX_LOSS);
  return clamp(food * warmth * home * old, 0, 1);
}

/**
 * After markets: eat bread/fish from the pantry (up to the planned food, max FOOD_MAX),
 * burn coal for heat, drink ale, furniture wears (FURNITURE_WEAR_DAY);
 * set foodSat/heatSat; update health (HEALTH_EMA) and contentment (CONTENT_EMA)
 * from food, heat, housing, employment, comfort (furniture stock), joy (ale),
 * and inflation pain; accumulate stats: acc.hungry, acc.eaten_<good>, acc.cold.
 */
export function householdsConsume(s: SimState): void {
  const c = householdCache(s);
  const planned = c.ordersDay === s.day;
  const heat = heatNeed(s.day);
  const heatAhead = planned ? c.heatAhead : heatAheadMean(s.day);
  const base = baseIncome(s);
  let hungry = 0;
  let cold = 0;
  let eatenBread = 0;
  let eatenFish = 0;
  let aleDrunk = 0;
  let coalBurned = 0;
  let furnWorn = 0;
  const flows = flowTally(s); // what each town uses up (stats/flows.ts)

  for (let i = 0; i < s.people.length; i++) {
    const p = s.people[i];
    if (!p || !p.alive) continue;
    const pan = p.pantry;
    const t = p.town;

    // ---- food: planned split, topped up from whichever food is at hand ----
    // A plan is always ≥ FOOD_NEED; 0 means this person had no plan today (created late).
    const foodPlan = planned && c.foodPlan[p.id] > 0 ? c.foodPlan[p.id] : FOOD_NEED;
    const want = clamp(foodPlan, 0, FOOD_MAX);
    const phi = planned ? (c.breadShare[t] ?? FOOD_W_BREAD_FALLBACK) : FOOD_W_BREAD_FALLBACK;
    const hb = Math.max(0, pan[G.bread]);
    const hf = Math.max(0, pan[G.fish]);
    let eatB = Math.min(hb, want * phi);
    let eatF = Math.min(hf, want - want * phi);
    let short = want - eatB - eatF;
    if (short > 1e-12) {
      const x = Math.min(hb - eatB, short);
      eatB += x;
      short -= x;
      const y = Math.min(hf - eatF, short);
      eatF += y;
    }
    pan[G.bread] = Math.max(0, hb - eatB);
    pan[G.fish] = Math.max(0, hf - eatF);
    p.foodSat = clamp((eatB + eatF) / FOOD_NEED, 0, FOOD_MAX);
    eatenBread += eatB;
    eatenFish += eatF;
    if (t >= 0 && t < s.towns.length) {
      flows[flowIndex(t, G.bread, FLOW_USED)] += eatB;
      flows[flowIndex(t, G.fish, FLOW_USED)] += eatF;
    }

    // ---- heat: burn today's need, plus comfort coal only above a winter reserve ----
    const hc = Math.max(0, pan[G.coal]);
    const burn = Math.min(hc, heat);
    let left = hc - burn;
    const extraWanted = planned ? c.coalExtra[p.id] : 0;
    const extra = Math.min(extraWanted, Math.max(0, left - HEAT_RESERVE_DAYS * heatAhead));
    left -= extra;
    pan[G.coal] = Math.max(0, left);
    p.heatSat = heat > 0 ? clamp(burn / heat, 0, 1) : 1;
    coalBurned += burn + extra;
    if (t >= 0 && t < s.towns.length) flows[flowIndex(t, G.coal, FLOW_USED)] += burn + extra;

    // ---- ale ----
    const ha = Math.max(0, pan[G.ale]);
    const drink = Math.min(ha, planned ? c.alePlan[p.id] : 0);
    pan[G.ale] = ha - drink;
    aleDrunk += drink;
    if (t >= 0 && t < s.towns.length) flows[flowIndex(t, G.ale, FLOW_USED)] += drink;
    p.joy = clamp(ema(fin(p.joy), aleJoy(drink), JOY_EMA), 0, 1);

    // ---- furniture: a durable stock that wears at home ----
    const hfu = Math.max(0, pan[G.furniture]);
    const worn = hfu * FURNITURE_WEAR_DAY;
    pan[G.furniture] = hfu - worn;
    furnWorn += worn;
    if (t >= 0 && t < s.towns.length) flows[flowIndex(t, G.furniture, FLOW_USED)] += worn;

    // ---- health ----
    const housed = p.home >= 0;
    const ht = healthTarget(p.foodSat, p.heatSat, heat, housed, p.age);
    p.health = clamp(ema(fin(p.health, 0.8), ht, HEALTH_EMA), 0, 1);

    // ---- contentment ----
    const working = p.job >= 0 || p.owns.length > 0 || p.houses.length > 0;
    const cpi = t >= 0 && t < s.towns.length && s.towns[t].cpi > 1 ? s.towns[t].cpi : 100;
    const real = Math.max(1e-6, p.income / (cpi / 100));
    const peer = c.realIncome[t] > 0 ? c.realIncome[t] : base;
    const ref = 0.5 * base + 0.5 * peer; // absolute standard of living and keeping up with the neighbours
    const incomeScore = clamp(0.6 + 0.4 * Math.log2(real / Math.max(1e-6, ref)), 0, 1);
    const pain = INFL_PAIN_W * clamp((p.expInfl - INFL_PAIN_START) / INFL_PAIN_SPAN, 0, 1);
    const target =
      CONTENT_W_HEALTH * p.health +
      CONTENT_W_WORK * (working ? 1 : 0) +
      CONTENT_W_HOME * (housed ? 1 : 0) +
      CONTENT_W_FOOD * clamp(p.foodSat, 0, 1) +
      CONTENT_W_COMFORT * comfortOf(pan[G.furniture]) +
      CONTENT_W_JOY * p.joy +
      CONTENT_W_INCOME * incomeScore -
      pain;
    p.contentment = clamp(ema(fin(p.contentment, 0.5), clamp(target, 0, 1), CONTENT_EMA), 0, 1);

    if (p.foodSat < HUNGRY_BELOW) hungry++;
    if (p.heatSat < COLD_BELOW) cold++;
  }

  bump(s, 'hungry', hungry);
  bump(s, 'cold', cold);
  bump(s, 'eaten_bread', eatenBread);
  bump(s, 'eaten_fish', eatenFish);
  bump(s, 'ale_drunk', aleDrunk);
  bump(s, 'coal_burned', coalBurned);
  bump(s, 'furniture_worn', furnWorn);
}

