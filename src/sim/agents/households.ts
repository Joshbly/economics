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
//    substitute through the CES food nest.
//  * income → consumption: spending tracks an EMA of disposable income (net wages,
//    dividends, rent received, interest, Treasury payments) minus per-head levies.
//  * inflation → portfolio: when expected inflation outruns the deposit rate, savers
//    buy gold; when IOU yields beat deposits they buy IOUs.
//  * living standards → health (productivity, mortality) and contentment (unrest,
//    emigration).
// ============================================================================
import {
  ALE_JOY_SCALE,
  BASE_WAGE,
  COLD_BELOW,
  COMFORT_HALF,
  CONTENT_EMA,
  CONTENT_W_COMFORT,
  CONTENT_W_FOOD,
  CONTENT_W_HEALTH,
  CONTENT_W_HOME,
  CONTENT_W_INCOME,
  CONTENT_W_JOY,
  CONTENT_W_WORK,
  ELASTICITY,
  FOOD_MAX,
  FOOD_NEED,
  FURNITURE_WEAR_DAY,
  GOLD_HEDGE_TRIGGER,
  HEALTH_EMA,
  HEALTH_FOOD_POW,
  HEALTH_W_HEAT,
  HEAT_AHEAD_DAYS,
  HEAT_AMP,
  HEAT_MEAN,
  HEAT_RESERVE_DAYS,
  HOMELESS_HEALTH,
  HUNGRY_BELOW,
  INCOME_EMA,
  INFL_EXP_EMA,
  INFL_PAIN_SPAN,
  INFL_PAIN_START,
  INFL_PAIN_W,
  IOU_COUPON,
  IOU_MARGIN,
  JOY_EMA,
  MIN_BID_SPEND,
  OLD_AGE_MAX_LOSS,
  OLD_AGE_SPAN,
  OLD_AGE_START,
  PORTFOLIO_DAILY_FRACTION,
  PORTFOLIO_MAX_GOLD_SHARE,
  PORTFOLIO_MAX_IOU_SHARE,
  PORTFOLIO_MIN_ORDER,
  PORTFOLIO_SURPLUS_MULT,
  SHARE_COAL,
} from '../config';
import { heatNeed } from '../calendar';
import { CONSUMER_GOODS, G, N_GOODS } from '../goods';
import { personRef } from '../ledger';
import { addAsk, addBid, bookFor, expectedGross, type Books } from '../market/markets';
import { levyAmount, matchLevies } from '../policy/levies';
import { rt } from '../runtime';
import type { Book, Person, SimState } from '../types';
import { GOLD_GOOD, IOU_GOOD } from '../types';
import { clamp, ema, fin } from '../util';
import { bidLadder, bufferTarget, foodIndex, goodsBudget, planDemand, subsistenceCost, type DemandInput } from './demandModel';
import { hasLevyBase, netWage, wageCtx } from './labor';

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
 *  - income EMA from yesterday's person.earned (INCOME_EMA); lastWage tracking;
 *  - expected inflation EMA toward stats.latest.infl30 (INFL_EXP_EMA);
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
  c.prices.length = nT;
  c.breadShare.length = nT;
  c.unemp.length = nT;
  for (let t = 0; t < nT; t++) {
    const row = c.prices[t] ?? (c.prices[t] = new Array(N_GOODS).fill(1));
    for (let g = 0; g < N_GOODS; g++) row[g] = 1;
    for (const g of CONSUMER_GOODS) row[g] = safePrice(expectedGross(s, t, g));
    const fi = foodIndex(row[G.bread], row[G.fish]);
    const qb = fi.shareBread / row[G.bread];
    const qf = fi.shareFish / row[G.fish];
    c.breadShare[t] = qb + qf > 0 ? qb / (qb + qf) : 0.68;
    const town = s.towns[t];
    c.unemp[t] = town.pop > 0 ? clamp(fin(town.unemployed) / Math.max(1, town.pop), 0, 1) : 0.05;
  }

  const lat = s.stats.latest;
  const infl = clamp(fin(lat.infl30 ?? lat.inflation30 ?? 0), -0.5, 1.5);
  const heads = hasLevyBase(s, 'head');
  const interestLevies = hasLevyBase(s, 'interest');
  const moneyLevies = hasLevyBase(s, 'money');
  const wc = wageCtx(s);

  const incSum = new Array(nT).fill(0);
  const incN = new Array(nT).fill(0);
  for (let i = 0; i < s.people.length; i++) {
    const p = s.people[i];
    if (!p || !p.alive) continue;
    // Disposable income: what came in over the last day, less per-head levies owed.
    let earned = fin(p.earned);
    if (heads) earned -= Math.max(0, fin(levyAmount(s, 'head', 'receiver', { person: p, town: p.town }, 0, 0)));
    p.income = Math.max(0, ema(fin(p.income), Math.max(0, earned), INCOME_EMA));
    if (p.job >= 0) {
      const f = s.firms[p.job];
      if (f && f.alive) p.lastWage = netWage(s, wc, f);
    }
    p.expInfl = clamp(ema(fin(p.expInfl), infl, INFL_EXP_EMA), -0.5, 1.5);

    const t = p.town;
    const prices = c.prices[t] ?? c.prices[0];
    const unemp = c.unemp[t] ?? 0.05;
    // Buffer: first pass with the plain deposit rate to know which balance levies apply to.
    let m = bufferTarget(p.income, fin(s.bank.depositRate) - p.expInfl, unemp);
    if (interestLevies || moneyLevies) {
      const dep = effectiveDepositRate(s, p, interestLevies, moneyLevies, m);
      m = bufferTarget(p.income, dep - p.expInfl, unemp);
    }
    const sub = subsistenceCost(prices, c.heat);
    p.budget = fin(goodsBudget(p.income, Math.max(0, p.cash), m, rentOf(s, p), sub));
    c.buf[p.id] = m;
    c.subsist[p.id] = sub;

    if (t >= 0 && t < nT) {
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

// Scratch reused across people (no per-person allocation beyond planDemand's own arrays).
const _ladder: number[] = [];
const _inp: DemandInput = { budget: 0, cash: 0, prices: [], pantry: [], heat: 0, heatAhead: 0, hungry: false };

/**
 * For each living person: demandModel.planDemand with expected GROSS prices of
 * their home town (markets.expectedGross), then demandModel.bidLadder per consumer
 * good with config ELASTICITY, adding bids to the home-town books.
 */
export function householdOrders(s: SimState, books: Books): void {
  const c = householdCache(s);
  if (c.day !== s.day) householdsBeginDay(s); // defensive: plan must exist
  const nT = s.towns.length;
  // Book lookup per town × consumer good.
  const bk: (Book | undefined)[][] = [];
  for (let t = 0; t < nT; t++) {
    const row: (Book | undefined)[] = new Array(N_GOODS);
    for (const g of CONSUMER_GOODS) row[g] = bookFor(books, t, g) ?? undefined;
    bk.push(row);
  }
  _inp.heat = c.heat;
  _inp.heatAhead = c.heatAhead;
  for (let i = 0; i < s.people.length; i++) {
    const p = s.people[i];
    if (!p || !p.alive) continue;
    const t = p.town;
    const prices = c.prices[t] ?? c.prices[0];
    const cash = Math.max(0, p.cash);
    _inp.budget = Math.min(Math.max(0, p.budget), cash);
    _inp.cash = cash;
    _inp.prices = prices;
    _inp.pantry = p.pantry;
    _inp.hungry = p.foodSat < HUNGRY_BELOW;
    const plan = planDemand(_inp);
    c.foodPlan[p.id] = clamp(fin(plan.foodPlan, FOOD_NEED), 0, FOOD_MAX);
    c.alePlan[p.id] = Math.max(0, fin(plan.alePlan));
    c.coalExtra[p.id] = Math.max(0, fin((SHARE_COAL * Math.max(0, _inp.budget - plan.subsistence)) / prices[G.coal]));
    let committed = 0;
    const ref = personRef(p.id);
    const row = bk[t];
    if (row) {
      for (const g of CONSUMER_GOODS) {
        const q = plan.qty[g];
        const ms = plan.maxSpend[g];
        if (!(q > 1e-5) || !(ms >= MIN_BID_SPEND)) continue;
        const book = row[g];
        if (!book) continue;
        const el = ELASTICITY[g] ?? 0.8;
        bidLadder(q, prices[g], ms, el, _ladder);
        // Uniform-price clearing: every filled unit pays the same price P, and at most
        // the rungs with limit ≥ P fill, so the worst case is max_k P_k · cum_k (≤ maxSpend).
        let cum = 0;
        let worst = 0;
        for (let k = 0; k + 1 < _ladder.length; k += 2) {
          const price = _ladder[k];
          const qty = _ladder[k + 1];
          if (!(qty > 0) || !(price > 0)) continue;
          addBid(book, ref, price, qty);
          cum += qty;
          if (price * cum > worst) worst = price * cum;
        }
        committed += worst;
      }
    }
    c.committed[p.id] = committed;
  }
  c.ordersDay = s.day;
}

/**
 * Savers with cash > PORTFOLIO_SURPLUS_MULT × buffer: bid for IOUs when
 * yield (IOU_COUPON / price) > deposit rate + IOU_MARGIN; bid for gold when
 * expected inflation − deposit rate > GOLD_HEDGE_TRIGGER. People short of
 * liquidity (cash < buffer/2) offer IOUs / gold for sale slightly below market.
 * Holders also unwind: gold when the inflation hedge is no longer needed, IOUs
 * when their yield has fallen below the deposit rate. Orders are modest
 * (PORTFOLIO_DAILY_FRACTION of the surplus per day) and concentration-capped.
 */
export function householdPortfolioOrders(s: SimState, books: Books): void {
  const c = householdCache(s);
  const iouBook = books.iou ?? bookFor(books, -1, IOU_GOOD);
  const goldBook = books.gold ?? bookFor(books, -1, GOLD_GOOD);
  const pIou = Math.max(1, fin(s.iouMarket?.ema, 100));
  const pGold = Math.max(0.01, fin(s.goldMarket?.ema, 100));
  const dep = fin(s.bank.depositRate);
  const iouYield = IOU_COUPON / pIou;
  const iouAttr = clamp((iouYield - dep - IOU_MARGIN) / 0.02, 0, 1);
  // Highest price at which the IOU still beats deposits by the margin.
  const pIouMax = IOU_COUPON / Math.max(0.002, dep + IOU_MARGIN);
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

    // ---- rebalancing sells ----
    const hedgeGap = p.expInfl - dep - GOLD_HEDGE_TRIGGER;
    let soldGold = false;
    let soldIou = false;
    if (p.gold > 0 && goldBook && hedgeGap < -0.02) {
      const q = goldVal < 5 ? p.gold : p.gold * PORTFOLIO_DAILY_FRACTION;
      addAsk(goldBook, ref, pGold * 0.99, q);
      soldGold = true;
    }
    if (p.iou > 0 && iouBook && iouYield < dep) {
      const q = iouVal < 5 ? p.iou : p.iou * PORTFOLIO_DAILY_FRACTION;
      addAsk(iouBook, ref, pIou * 0.99, q);
      soldIou = true;
    }

    // ---- purchases from surplus savings ----
    const surplus = p.cash - PORTFOLIO_SURPLUS_MULT * m;
    if (!(surplus > 0) || m <= 0) continue;
    // Cash not already committed to today's goods bids or tonight's rent.
    let free = p.cash - (plan ? c.committed[p.id] : p.budget) - 3 * rentOf(s, p);
    if (!(free > PORTFOLIO_MIN_ORDER)) continue;
    if (!soldIou && iouBook && iouAttr > 0 && iouVal < PORTFOLIO_MAX_IOU_SHARE * wealth) {
      const amt = Math.min(free, PORTFOLIO_DAILY_FRACTION * surplus * iouAttr);
      const lim = Math.min(pIouMax, pIou * 1.02);
      if (amt >= PORTFOLIO_MIN_ORDER && lim > 0) {
        addBid(iouBook, ref, lim, amt / lim);
        free -= amt;
      }
    }
    if (!soldGold && goldBook && hedgeGap > 0 && goldVal < PORTFOLIO_MAX_GOLD_SHARE * wealth) {
      const attr = clamp(hedgeGap / 0.05, 0, 1);
      const amt = Math.min(free, PORTFOLIO_DAILY_FRACTION * surplus * attr);
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
  const food = Math.pow(clamp(foodSat / 1, 0, 1), HEALTH_FOOD_POW);
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

  for (let i = 0; i < s.people.length; i++) {
    const p = s.people[i];
    if (!p || !p.alive) continue;
    const pan = p.pantry;
    const t = p.town;

    // ---- food: planned split, topped up from whichever food is at hand ----
    const foodPlan = planned ? c.foodPlan[p.id] : FOOD_NEED;
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

    // ---- ale ----
    const ha = Math.max(0, pan[G.ale]);
    const drink = Math.min(ha, planned ? c.alePlan[p.id] : 0);
    pan[G.ale] = ha - drink;
    aleDrunk += drink;
    p.joy = clamp(ema(fin(p.joy), aleJoy(drink), JOY_EMA), 0, 1);

    // ---- furniture: a durable stock that wears at home ----
    const hfu = Math.max(0, pan[G.furniture]);
    const worn = hfu * FURNITURE_WEAR_DAY;
    pan[G.furniture] = hfu - worn;
    furnWorn += worn;

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

