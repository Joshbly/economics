// ============================================================================
// Household demand model — pure math shared by households.ts (bidding) and
// world/init.ts (calibration). No state mutation here.
//
// Budget: buffer-stock rule (see DESIGN §3.1).
// Allocation: Linear Expenditure System. Subsistence food (CES nest of bread
// and fish, σ = FOOD_SIGMA) and heat (coal) first; the supernumerary budget is
// split by SHARE_* into extra food, ale, furniture and extra coal.
// Bids: an 8-rung ladder per good around the expected gross price, shaped by an
// iso-elastic curve and capped so rung price × cumulative qty ≤ maxSpend.
// ============================================================================
import {
  ALE_MAX_PER_DAY,
  BID_RUNGS,
  BUF_BASE_DAYS,
  BUF_RATE_DAYS,
  BUF_REAL_RATE_MAX,
  BUF_REAL_RATE_MIN,
  BUF_UNEMP_DAYS,
  FOOD_FLEX,
  FOOD_MAX,
  FOOD_NEED,
  FOOD_SIGMA,
  FOOD_W_BREAD,
  FOOD_W_FISH,
  HEAT_MEAN,
  PANTRY_DAYS_BREAD,
  PANTRY_DAYS_COAL,
  PANTRY_DAYS_FISH,
  SHARE_ALE,
  SHARE_COAL,
  SHARE_FOOD,
  SHARE_FURNITURE,
  SPEND_DOWN_DAYS,
} from '../config';
import { G, N_GOODS } from '../goods';
import { clamp } from '../util';

/** CES food price index and expenditure shares of bread and fish. */
export function foodIndex(pBread: number, pFish: number): { index: number; shareBread: number; shareFish: number } {
  const e = 1 - FOOD_SIGMA; // negative
  const b = FOOD_W_BREAD * Math.pow(Math.max(1e-6, pBread), e);
  const f = FOOD_W_FISH * Math.pow(Math.max(1e-6, pFish), e);
  const tot = b + f;
  return { index: Math.pow(tot, 1 / e), shareBread: b / tot, shareFish: f / tot };
}

/** Target money buffer m* (¤). */
export function bufferTarget(income: number, realDepositRate: number, localUnemployment: number): number {
  const days = BUF_BASE_DAYS + BUF_RATE_DAYS * clamp(realDepositRate, BUF_REAL_RATE_MIN, BUF_REAL_RATE_MAX) + BUF_UNEMP_DAYS * clamp(localUnemployment, 0, 0.5);
  return Math.max(0, income) * Math.max(5, days);
}

/**
 * Goods budget for today (¤), excluding rent (rent is paid separately).
 * Never below the cost of subsistence (if cash allows), never above cash.
 */
export function goodsBudget(income: number, cash: number, bufTarget: number, rent: number, subsistenceCost: number): number {
  const b = income + (cash - bufTarget) / SPEND_DOWN_DAYS - rent;
  return clamp(Math.max(b, subsistenceCost), 0, Math.max(0, cash));
}

export interface DemandInput {
  budget: number; // goods budget today (¤)
  cash: number; // hard cap on total bids
  prices: readonly number[]; // expected GROSS prices in the home market, length N_GOODS
  pantry: readonly number[]; // goods at home
  heat: number; // today's heat need (coal)
  heatAhead: number; // average heat need over the next ~20 days (for stocking)
  hungry: boolean; // yesterday's food satisfaction was low
}

export interface DemandPlan {
  /** Desired purchase quantity today per good (consumer goods only, others 0). */
  qty: number[];
  /** Planned spend at expected prices. */
  spend: number[];
  /** Bid cap per good (ladder never commits more than this). */
  maxSpend: number[];
  /** Food units the household intends to eat today (bread+fish). */
  foodPlan: number;
  /** Ale it intends to drink today. */
  alePlan: number;
  /** Subsistence cost at expected prices (food + heat). */
  subsistence: number;
}

/**
 * The part of the supernumerary budget S that the food and ale shares cannot use because
 * those goods have a ceiling (FOOD_MAX, ALE_MAX_PER_DAY): a sated household spends it on
 * furniture, the good without one. Without this, well-off households would spend less than
 * their budget and their savings would pile up out of circulation.
 */
export function satedSpillover(S: number, foodPlan: number, foodIndexP: number, alePlan: number, pAle: number): number {
  const unusedFood = SHARE_FOOD * S - (foodPlan - FOOD_NEED) * foodIndexP;
  const unusedAle = SHARE_ALE * S - alePlan * pAle;
  return Math.max(0, unusedFood + unusedAle);
}

/** Subsistence cost (food + today's heat) at expected prices. */
export function subsistenceCost(prices: readonly number[], heat: number): number {
  return FOOD_NEED * foodIndex(prices[G.bread], prices[G.fish]).index + heat * prices[G.coal];
}

export function planDemand(inp: DemandInput): DemandPlan {
  const p = inp.prices;
  const qty = new Array(N_GOODS).fill(0);
  const spend = new Array(N_GOODS).fill(0);
  const maxSpend = new Array(N_GOODS).fill(0);
  const fi = foodIndex(p[G.bread], p[G.fish]);
  const sub = FOOD_NEED * fi.index + inp.heat * p[G.coal];
  // Heating is budgeted at its annual mean cost: households save on fuel in summer for the
  // winter (their cash buffer carries the seasonal bill), so the supernumerary budget — and
  // with it the demand for ale and furniture — does not swing with the seasons. Today's
  // actual essentials still come first (below).
  const S = Math.max(0, inp.budget - (FOOD_NEED * fi.index + HEAT_MEAN * p[G.coal]));

  // ---- consumption plan ----
  const foodPlan = Math.min(FOOD_MAX, FOOD_NEED + (SHARE_FOOD * S) / fi.index);
  const breadEat = (foodPlan * fi.index * fi.shareBread) / p[G.bread];
  const fishEat = (foodPlan * fi.index * fi.shareFish) / p[G.fish];
  const alePlan = Math.min(ALE_MAX_PER_DAY, (SHARE_ALE * S) / p[G.ale]);
  const coalExtra = (SHARE_COAL * S) / p[G.coal];
  const spill = satedSpillover(S, foodPlan, fi.index, alePlan, p[G.ale]);

  // ---- purchases: today's use + pantry top-up ----
  qty[G.bread] = Math.max(0, breadEat * (1 + PANTRY_DAYS_BREAD) - inp.pantry[G.bread]);
  qty[G.fish] = Math.max(0, fishEat * (1 + PANTRY_DAYS_FISH) - inp.pantry[G.fish]);
  const coalTarget = inp.heat + PANTRY_DAYS_COAL * Math.max(inp.heat, inp.heatAhead) + coalExtra;
  qty[G.coal] = Math.max(0, coalTarget - inp.pantry[G.coal]);
  qty[G.ale] = Math.max(0, alePlan - inp.pantry[G.ale]);
  qty[G.furniture] = (SHARE_FURNITURE * S + spill) / p[G.furniture];

  for (const g of [G.bread, G.fish, G.coal, G.ale, G.furniture]) spend[g] = qty[g] * p[g];

  // Essentials first: if today's essentials exceed the budget, luxuries go to zero. Only what is
  // eaten and burnt today counts: topping up the larder and the coal store (pantry targets) is
  // a use of the cash buffer, not a reason to go without ale that day — otherwise every coal
  // stocking day ahead of winter would empty the ale and furniture markets.
  // The winter's fuel above its annual mean is paid from the savings the summer's cheap heating
  // left in the buffer (heating is budgeted at its mean, above): it does not squeeze ale and
  // furniture out of the winter budget.
  const essentialUse = breadEat * p[G.bread] + fishEat * p[G.fish] + (inp.heat + coalExtra) * p[G.coal];
  const essential = Math.min(spend[G.bread] + spend[G.fish] + spend[G.coal], essentialUse);
  const room = Math.max(0, inp.budget + Math.max(0, inp.heat - HEAT_MEAN) * p[G.coal] - essential);
  const lux = spend[G.ale] + spend[G.furniture];
  if (lux > room) {
    const k = lux > 0 ? room / lux : 0;
    for (const g of [G.ale, G.furniture]) {
      qty[g] *= k;
      spend[g] *= k;
    }
  }

  // ---- bid caps ----
  const foodFlex = inp.hungry ? FOOD_FLEX : 1.35;
  maxSpend[G.bread] = spend[G.bread] * foodFlex;
  maxSpend[G.fish] = spend[G.fish] * foodFlex;
  maxSpend[G.coal] = spend[G.coal] * (inp.heat > HEAT_MEAN ? 1.6 : 1.25);
  maxSpend[G.ale] = spend[G.ale] * 1.1;
  maxSpend[G.furniture] = spend[G.furniture] * 1.1;
  // Never commit more than cash: shrink luxuries first, then everything.
  let total = 0;
  for (let g = 0; g < N_GOODS; g++) total += maxSpend[g];
  if (total > inp.cash) {
    let over = total - inp.cash;
    for (const g of [G.furniture, G.ale]) {
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
  return { qty, spend, maxSpend, foodPlan, alePlan, subsistence: sub };
}

/**
 * Build a bid ladder for one good. Returns tranches as a flat array
 * [price0, qty0, price1, qty1, ...] (prices descending). The cumulative
 * quantity at rung price P is min(qty·(1/m)^ε, maxSpend/P), non-decreasing as
 * P falls, so the worst-case cost of the whole ladder is ≤ maxSpend.
 */
export function bidLadder(qty: number, pExp: number, maxSpend: number, elasticity: number, out: number[] = []): number[] {
  out.length = 0;
  if (!(qty > 1e-6) || !(pExp > 0) || !(maxSpend > 0)) return out;
  let prevCum = 0;
  for (const m of BID_RUNGS) {
    const price = pExp * m;
    let cum = qty * Math.pow(1 / m, elasticity);
    cum = Math.min(cum, maxSpend / price);
    if (cum > prevCum + 1e-9) {
      out.push(price, cum - prevCum);
      prevCum = cum;
    }
  }
  return out;
}

/**
 * Steady-state consumption per person per day at the given gross prices, for
 * calibration. `income` is disposable income per day, `rent` rent per day.
 * Heat uses the annual mean. Returns quantities per good (length N_GOODS).
 */
export function steadyStateDemand(prices: readonly number[], income: number, rent: number): number[] {
  const out = new Array(N_GOODS).fill(0);
  const fi = foodIndex(prices[G.bread], prices[G.fish]);
  const heat = HEAT_MEAN;
  const sub = FOOD_NEED * fi.index + heat * prices[G.coal];
  const budget = Math.max(sub, income - rent);
  const S = Math.max(0, budget - sub);
  const food = Math.min(FOOD_MAX, FOOD_NEED + (SHARE_FOOD * S) / fi.index);
  out[G.bread] = (food * fi.index * fi.shareBread) / prices[G.bread];
  out[G.fish] = (food * fi.index * fi.shareFish) / prices[G.fish];
  out[G.coal] = heat + (SHARE_COAL * S) / prices[G.coal];
  out[G.ale] = Math.min(ALE_MAX_PER_DAY, (SHARE_ALE * S) / prices[G.ale]);
  out[G.furniture] = (SHARE_FURNITURE * S + satedSpillover(S, food, fi.index, out[G.ale], prices[G.ale])) / prices[G.furniture];
  return out;
}
