// ============================================================================
// World creation & calibration: builds a SimState close to a steady state.
// OWNER: world agent. See DESIGN §1 and the calibration notes below.
//
// Algorithm:
//  1. generateMap(seed); the 4 towns (names from names.ts), market halls with a
//     market-square ring, inter-town dirt tracks (capital to every town + shortcuts
//     that save ≥ 25 %), the Palace and the Bank (capital), the Port (harbor).
//  2. Prices start from production.basePrices(); rent0 = BASE_RENT_SHARE × BASE_WAGE.
//  3. Calibration fixed point (`calibrate`, two passes):
//       * local prices: a host town sells a good at its own unit cost (materials at
//         local prices + tool cost as firms reckon it + the sector's equilibrium margin
//         M); other towns pay the cheapest landed price from a host — the lowest price
//         at which the traders' own rule would ship it (spoilage over the trip + a day,
//         freight incl. idle drivers, the minimum margin on the selling price);
//       * household demand: demandModel.steadyStateDemand at each class's stationary
//         budget (workers: income − rent; owners: wages + profits + rents), corrected in
//         the second pass by realised ÷ planned ratios from `householdSteady`, a
//         mini-simulation of the household module's own rules (rotating bid rungs,
//         lumpy coal/furniture shopping, pantry spoilage, essentials first); plus
//         intermediate demand through recipes (Leontief), tool replacement, trader oil
//         and wagon wear, and foreign trade at the port;
//       * each (sector, host town) is served by n firms on the best sites; n puts the
//         equilibrium margin nearest M0 = w_e/(α·prodPerWorker), and every firm sits at
//         its profit-maximising size L_i = (α·M·A·S·m_i/w_e)^(1/(1−α)) (w_e = wage per
//         effective worker, effective labour (0.5 + 0.5·health)·skill as firms count it;
//         S = the season firms plan with: annual mean for farms, founding day otherwise);
//       * traders' wagons/drivers follow the inter-town flows; town populations follow
//         the jobs, the realm's total fixed at Σ TOWN_POP, and an income-scale factor κ
//         (≈ 1) pins employment at 1 − INIT_UNEMPLOYMENT.
//     Deviations from the first sketch (economics, not taste): no smelter in the capital
//     (importing 3 units of ore+coal per unit of iron cannot compete with the mining
//     town's smelter) and no farms in the capital (the farm town is the breadbasket;
//     entry may add capital farms if grain freight makes them pay).
//  4. Buildings: resource firms on the calibrated sites (their tracks laid only after
//     all are placed, so no track cuts across a chosen site), town workshops, levels so
//     capacity ≈ INIT_CAPACITY_HEADROOM × workers; per town one builder (with a nearly
//     finished house as its founding project), one trader, one stateworks (building -1,
//     owner STATE, target 0). Firms are founded years before day 0.
//  5. Houses for pop × (1 + INIT_HOUSING_VACANCY), all private; OWNER_SHARE of people own
//     the firms and houses (weighted by rank); owners live in their own houses, everyone
//     else in the free slot nearest their work.
//  6. Jobs: exactly the calibrated workforce per firm; owners work in their own shops;
//     the employed are dealt to firms so each gets a representative efficiency mix.
//  7. Money: households hold the cash of their shopping phase at the stationary point of
//     the household rules (scaled to their income, small spread); firms
//     INIT_FIRM_CASH_DAYS of costs; loans (principal only: the historical proceeds paid
//     for the capital stock and now sit in deposits across the realm) for INIT_LOAN_SHARE
//     of producers, sized to their profit; bank reserves so that equity ≈
//     max(INIT_BANK_EQUITY_MIN, INIT_BANK_EQUITY_RATIO × loans), then ledger.reconcileBank;
//     Treasury purse, gold and rates; foreign coin ≈ INIT_FOREIGN_COIN_DAYS of port trade.
//  8. Stocks: firms at their own inventory targets (+ the seasonal carry: it is early
//     spring, farms still hold last year's harvest), INPUT_BUFFER_DAYS of inputs, tools
//     for full productivity + TOOLS_BUFFER_DAYS of wear; pantries from householdSteady;
//     wagons in transit and a little stock already waiting at the destinations.
//  9. Markets: every town × good at its calibrated price, volEma = expected purchases,
//     and a founding order-book snapshot (traders read destination demand from
//     yesterday's book); IOU at par; gold at INIT_GOLD_PRICE.
// 10. Foreign: world prices = harbour price / gold price × a seeded factor (a few goods
//     cheap abroad, a few dear), shipCap = SHIP_CAP_SHARE × national use, world0, tradeEma.
// 11. stats.initStats(s); scenarios.applyScenario; a founding news item.
// ============================================================================
import {
  ALE_JOY_SCALE,
  ASK_RUNGS,
  ASK_WEIGHTS,
  BANK_RISK_PREMIUM,
  BASE_MARKUP,
  BASE_RENT_SHARE,
  BASE_WAGE,
  BID_RUNGS,
  BUILD_MARGIN,
  BUILD_TARGET_DAYS,
  COAL_COMFORT_DAYS,
  COAL_HEAT_SHARE,
  COAL_SHOP_DAYS,
  DAYS_PER_MONTH,
  DAYS_PER_YEAR,
  DESK_WORKING_COIN,
  ELASTICITY,
  EXPORT_DISCOUNT,
  FOOD_MAX,
  FOOD_NEED,
  FURNITURE_SHOP_DAYS,
  FURNITURE_WEAR_DAY,
  HEAT_MEAN,
  HEAT_RESERVE_DAYS,
  HH_RUNGS,
  HUNGRY_BELOW,
  IMPORT_MARKUP,
  INIT_BANK_EQUITY_MIN,
  INIT_BANK_EQUITY_RATIO,
  INIT_BUILDERS,
  INIT_CAPACITY_HEADROOM,
  INIT_CASH_SIGMA,
  INIT_DRIVER_SLACK,
  INIT_FARM_CAPACITY_HEADROOM,
  INIT_FIRM_CASH_DAYS,
  INIT_FOREIGN_COIN_DAYS,
  INIT_GOLD_PRICE,
  INIT_HOUSING_VACANCY,
  INIT_LEND_RATE,
  INIT_LOAN_LEFT_MIN,
  INIT_LOAN_MAX_SERVICE,
  INIT_LOAN_SHARE,
  INIT_LOAN_TO_CAPITAL,
  INIT_MAX_LEVEL,
  INIT_OWNER_CASH_DAYS,
  INIT_PURSE,
  INIT_RENT_SPREAD,
  INIT_RESERVE_MIN_SHARE,
  INIT_RESERVE_RATE,
  INIT_SKILL_SIGMA,
  INIT_TRADER_WC_DAYS,
  INIT_TRADE_EDGE,
  INIT_TREASURY_GOLD,
  INIT_UNEMPLOYMENT,
  INIT_WAGON_SLACK,
  INIT_WORLD_CHEAP,
  INIT_WORLD_DEAR,
  INIT_WORLD_NEUTRAL,
  INIT_WORLD_N_CHEAP,
  INIT_WORLD_N_DEAR,
  INPUT_BUFFER_DAYS,
  INV_TARGET_DAYS,
  INV_TARGET_DAYS_PERISHABLE,
  JOY_EMA,
  MIN_BID_SPEND,
  OIL_PER_TILE,
  OWNER_SHARE,
  SHIP_CAP_SHARE,
  INIT_LOAN_TERM,
  TOOLS_BUFFER_DAYS,
  TOOLS_IDLE_WEAR_DAY,
  TOOLS_PER_WAGON,
  TOWN_POP,
  TRADE_HOLD_DAYS,
  TRADE_MIN_LOAD,
  TRADE_MIN_MARGIN_ABS,
  TRADE_MIN_MARGIN_PCT,
  WAGON_CAPACITY,
  WAGON_WEAR_DAY,
} from '../config';
import { farmSeason, heatNeed, seasonFactor } from '../calendar';
import { newFirm, newLoan, newMarket, newPerson, newProject, newShipment, newSimState, newTown, newTreasury } from '../factory';
import { CONSUMER_GOODS, G, GOODS, HOUSE_COST, HOUSE_SLOTS, N_GOODS, PRODUCER_OF, SECTORS, TRADABLE_GOODS, type SectorDef } from '../goods';
import { deposits, firmRef, loansOutstanding, personRef, reconcileBank } from '../ledger';
import { bufferTarget, foodIndex, goodsBudget, steadyStateDemand } from '../agents/demandModel';
import { basePrices, materialCostPerUnit, materialsValue, tfp, toolCostPerUnit, unitVariableCost } from '../agents/production';
import { heatAheadMean, healthTarget, ladderInto, newPlanScratch, planInto, rungSets } from '../agents/households';
import { commuteTiles } from '../agents/labor';
import { invalidateRoutes, rt } from '../runtime';
import { lognormal, rand, randRange, shuffle, type RngHolder } from '../rng';
import { news } from '../stats/events';
import { initStats } from '../stats/stats';
import { STATE, BANK, type Building, type CurveSnapshot, type Firm, type Person, type Sector, type SimState, type TownId, type TownKind } from '../types';
import { clamp, ema, fin } from '../util';
import { generateMap, type TownSite } from './mapgen';
import {
  computeDistricts,
  connectBuilding,
  findCoreSite,
  findSite,
  footprintOf,
  isResourceSector,
  isValidSite,
  layTrack,
  placeBuilding,
  placeMarketHall,
  siteQuality,
  updateTownRadius,
} from './layout';
import { planTrack, routeBetweenTowns } from './paths';
import { firmName, personName, realmName, townName } from './names';
import { applyScenario, scenarioDef } from './scenarios';

export interface WorldOptions {
  seed: number;
  realmName?: string;
  scenario?: string;
}

// ---------------------------------------------------------------------------
// Calibration types
// ---------------------------------------------------------------------------
type Mat = number[][]; // [town][good]

interface Site {
  x: number;
  y: number;
  q: number; // site quality 0..1
}

/** One producing sector in one host town. */
interface Host {
  sector: Sector;
  town: TownId;
  sites: Site[]; // candidate sites, best first (resource sectors); [] for town sectors
  n: number; // number of firms
  M: number; // equilibrium margin ¤/unit (price − materials − tool cost)
  X: number; // required output per day
  leff: number[]; // effective labour per firm
  workers: number[]; // workers per firm
  q: number[]; // output per firm per day (at the annual-mean season)
  mult: number[]; // site multipliers
}

interface FlowRec {
  from: TownId;
  to: TownId;
  good: number;
  qty: number; // units dispatched per day (arrivals = qty × survival)
}

interface Cal {
  P: Mat; // local prices
  src: number[][]; // [town][good] town the good comes from (itself if produced locally, -1 none)
  N: number[]; // population per town
  hosts: Host[];
  flows: FlowRec[];
  D: Mat; // local market purchases per day (everything bought in that town's market)
  HH: Mat; // household purchases per day
  drivers: number[];
  wagonsInUse: number[];
  traderOil: number[];
  traderProfit: number[];
  profitTown: number[]; // producers + traders per town
  yW: number; // worker income per day (average incl. unemployed spells)
  yO: number[]; // owner income per day by town
  kappa: number;
  imports: number[];
  exports: number[];
  shipCap: number[];
  world: number[]; // world prices (gold), 0 = not traded
  healthEff: number;
  wageEff: number;
  days: Mat; // [a][b] route days
  len: Mat; // [a][b] route length
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const RENT0 = BASE_RENT_SHARE * BASE_WAGE;
const W = BASE_WAGE;

/** Consumer spending per day at a budget, from the steady-state demand model. */
function spendAt(P: readonly number[], budget: number): number {
  const q = steadyStateDemand(P, budget, 0);
  let sp = 0;
  for (let g = 0; g < N_GOODS; g++) sp += q[g] * P[g];
  return sp;
}

/**
 * Stationary plan of a household with `income` and `rent`: the goods budget B at which
 * planned spending equals income − rent (caps on food and ale leave well-off households
 * spending less than B, so they hold more cash than m*). Returns quantities and B.
 */
export function stationaryPlan(P: readonly number[], income: number, rent: number): { q: number[]; budget: number } {
  const target = Math.max(0, income - rent);
  const base = steadyStateDemand(P, target + rent, rent);
  let sp0 = 0;
  for (let g = 0; g < N_GOODS; g++) sp0 += base[g] * P[g];
  if (sp0 >= target - 1e-9) return { q: base, budget: target };
  let lo = target;
  let hi = Math.max(target * 2, target + 10);
  for (let k = 0; k < 30 && spendAt(P, hi) < target; k++) hi *= 2;
  for (let k = 0; k < 50; k++) {
    const mid = 0.5 * (lo + hi);
    if (spendAt(P, mid) < target) lo = mid;
    else hi = mid;
  }
  const B = 0.5 * (lo + hi);
  return { q: steadyStateDemand(P, B, 0), budget: B };
}

// ---------------------------------------------------------------------------
// Household steady state: a mini-simulation of the household rules
// ---------------------------------------------------------------------------
// The analytic plan (stationaryPlan) is what a household would like to buy. What the
// household module actually buys at a given expected price is less, for two reasons
// that are part of its design: each household bids on a rotating subset of the price
// rungs, so at the expected price it fills only down to the lowest rung at or above it;
// and coal and furniture are bought in lumps (every COAL_SHOP_DAYS / FURNITURE_SHOP_DAYS),
// with luxuries cut on days when essentials take the budget — until the household holds
// enough cash above m* to smooth them. This runs the module's own planning code
// (households.planInto / ladderInto / rungSets) for a set of households over a full
// seasonal year at fixed prices and income, and reports the realised annual demand and
// the cash and pantries each shopping phase holds on the first day of the year.

/** Households simulated per type: every combination of the coal (4) and furniture (5) shopping phases. */
const HH_SIM_PHASES = 20;
/** Burn-in before the recorded year (days); cash converges on the spend-down time scale. */
const HH_SIM_BURN = 150;

interface HouseholdSteady {
  q: number[]; // mean purchases per household per day over the year (length N_GOODS)
  spend: number; // mean spending per day on goods
  cash: number[]; // by phase: cash at the start of the year (day 0)
  pantry: number[][]; // by phase: pantry at the start of day 0
  joy: number; // mean ale enjoyment EMA at day 0
}

const RUNG_SETS_INIT: number[][][] = Array.from({ length: N_GOODS }, (_, g) => rungSets(HH_RUNGS[g] ?? BID_RUNGS.length));
const simPlan = newPlanScratch();
const simLadder: number[] = [];

/**
 * Simulate `phases` households (ids 0..phases-1, or the single id `onlyId`) with daily
 * disposable income `income`, rent `rent`, facing gross prices P, from 150 days before
 * the start of a year to its end. Returns the year's mean purchases and the state on day 0.
 */
export function householdSteady(P: readonly number[], income: number, rent: number, cash0: number, onlyId = -1): HouseholdSteady {
  const ids = onlyId >= 0 ? [onlyId] : Array.from({ length: HH_SIM_PHASES }, (_, k) => k);
  const K = ids.length;
  const fi = foodIndex(P[G.bread], P[G.fish]);
  const qb = fi.shareBread / P[G.bread];
  const qf = fi.shareFish / P[G.fish];
  const phi = qb + qf > 0 ? qb / (qb + qf) : 0.68;
  const m = bufferTarget(income, Math.max(0, INIT_RESERVE_RATE - 0.01), INIT_UNEMPLOYMENT);
  const cash = new Array<number>(K).fill(Math.max(0, cash0));
  const pantry: number[][] = Array.from({ length: K }, () => new Array<number>(N_GOODS).fill(0));
  const hungry = new Array<boolean>(K).fill(false);
  const joy = new Array<number>(K).fill(0.4);
  const qSum = new Array<number>(N_GOODS).fill(0);
  let spendSum = 0;
  const start = 2 * DAYS_PER_YEAR - DAYS_PER_YEAR - HH_SIM_BURN;
  const end = 2 * DAYS_PER_YEAR; // the state after the last day is that of day 0 of a year
  let recDays = 0;
  for (let d = start; d < end; d++) {
    const heat = heatNeed(d);
    const ahead = heatAheadMean(d);
    const sub = FOOD_NEED * fi.index + heat * P[G.coal];
    const comfort = heat + COAL_COMFORT_DAYS * ahead;
    const rec = d >= end - DAYS_PER_YEAR;
    if (rec) recDays++;
    for (let k = 0; k < K; k++) {
      const id = ids[k];
      const pan = pantry[k];
      let c = cash[k] + income; // wages and other income arrive before the markets
      const budget = Math.min(Math.max(0, goodsBudget(income, c, m, rent, sub)), c);
      const plan = planInto(simPlan, budget, c, P, pan, heat, ahead, hungry[k], fi.index, fi.shareBread, fi.shareFish);
      const q = plan.qty;
      const ms = plan.maxSpend;
      if (FURNITURE_SHOP_DAYS > 1) {
        if ((id + d) % FURNITURE_SHOP_DAYS === 0) {
          q[G.furniture] *= FURNITURE_SHOP_DAYS;
          ms[G.furniture] *= FURNITURE_SHOP_DAYS;
          let other = 0;
          for (const g of CONSUMER_GOODS) if (g !== G.furniture) other += ms[g];
          ms[G.furniture] = Math.max(0, Math.min(ms[G.furniture], c - other));
        } else {
          q[G.furniture] = 0;
          ms[G.furniture] = 0;
        }
      }
      if (COAL_SHOP_DAYS > 1 && pan[G.coal] >= comfort && (id + d) % COAL_SHOP_DAYS !== 0) {
        q[G.coal] = 0;
        ms[G.coal] = 0;
      }
      // Uniform-price clearing at the expected price: every rung at or above it fills.
      let spent = 0;
      for (const g of CONSUMER_GOODS) {
        if (!(q[g] > 1e-5) || !(ms[g] >= MIN_BID_SPEND)) continue;
        const sets = RUNG_SETS_INIT[g];
        ladderInto(q[g], P[g], ms[g], g, sets[(id + d) % sets.length], simLadder);
        let fill = 0;
        for (let j = 0; j + 1 < simLadder.length; j += 2) if (simLadder[j] >= P[g] * (1 - 1e-9)) fill += simLadder[j + 1];
        fill = Math.max(0, Math.min(fill, (c - spent) / P[g]));
        pan[g] += fill;
        spent += fill * P[g];
        if (rec) qSum[g] += fill;
      }
      c -= spent + rent;
      cash[k] = Math.max(0, c);
      if (rec) spendSum += spent;
      // ---- consumption (households.householdsConsume) ----
      const want = clamp(plan.foodPlan, 0, FOOD_MAX);
      let eatB = Math.min(pan[G.bread], want * phi);
      let eatF = Math.min(pan[G.fish], want - want * phi);
      let short = want - eatB - eatF;
      if (short > 1e-12) {
        const x = Math.min(pan[G.bread] - eatB, short);
        eatB += x;
        short -= x;
        eatF += Math.min(pan[G.fish] - eatF, short);
      }
      pan[G.bread] -= eatB;
      pan[G.fish] -= eatF;
      hungry[k] = (eatB + eatF) / FOOD_NEED < HUNGRY_BELOW;
      const burn = Math.min(pan[G.coal], heat);
      let left = pan[G.coal] - burn;
      left -= Math.min(plan.coalExtra, Math.max(0, left - HEAT_RESERVE_DAYS * ahead));
      pan[G.coal] = Math.max(0, left);
      const drink = Math.min(pan[G.ale], plan.alePlan);
      pan[G.ale] -= drink;
      joy[k] = ema(joy[k], 1 - Math.exp(-ALE_JOY_SCALE * drink), JOY_EMA);
      pan[G.furniture] *= 1 - FURNITURE_WEAR_DAY;
      for (let g = 0; g < N_GOODS; g++) if (GOODS[g].spoil > 0 && pan[g] > 0) pan[g] *= 1 - GOODS[g].spoil;
    }
  }
  const n = Math.max(1, recDays * K);
  return {
    q: qSum.map((x) => x / n),
    spend: spendSum / n,
    cash: cash.slice(),
    pantry: pantry.map((r) => r.slice()),
    joy: joy.reduce((a, x) => a + x, 0) / Math.max(1, K),
  };
}

/** Output per day of a firm with effective labour L on a site with multiplier m (annual-mean season, full tools). */
function outputOf(d: SectorDef, L: number, m: number): number {
  return L > 0 ? tfp(d.key) * m * Math.pow(L, d.alpha) : 0;
}

/** Profit-maximising effective labour at margin M. */
function optLabor(d: SectorDef, M: number, m: number, wEff: number): number {
  if (M <= 0) return 0;
  return Math.pow((d.alpha * M * tfp(d.key) * m) / wEff, 1 / (1 - d.alpha));
}

/**
 * Equilibrium margin at which firms with site multipliers `mult` (each at its optimum)
 * jointly produce X: Σ Q_i(M) = X with Q_i = A^{1/(1−α)} m_i^{1/(1−α)} (αM/w_e)^{α/(1−α)}.
 */
function marginFor(d: SectorDef, X: number, mult: readonly number[], wEff: number): number {
  let sm = 0;
  for (const m of mult) sm += Math.pow(m, 1 / (1 - d.alpha));
  return marginForSum(d, X, sm, wEff);
}

/** marginFor with the precomputed Σ m_i^{1/(1−α)}. */
function marginForSum(d: SectorDef, X: number, sm: number, wEff: number): number {
  const a = d.alpha;
  if (!(sm > 0) || !(X > 0)) return wEff / (a * d.prodPerWorker);
  const k = Math.pow(tfp(d.key), 1 / (1 - a)) * sm;
  return (wEff / a) * Math.pow(X / k, (1 - a) / a);
}

// ---------------------------------------------------------------------------
// Sector hosting (which towns make what) — DESIGN §1.2
// ---------------------------------------------------------------------------
const HOSTING: Record<Sector, TownKind[]> = {
  farm: ['farm'],
  fishery: ['harbor'],
  lumber: ['mining'],
  coalmine: ['mining'],
  oremine: ['mining'],
  oilwell: ['harbor'],
  smelter: ['mining'],
  toolworks: ['capital'],
  furniture: ['capital'],
  bakery: ['capital', 'farm', 'mining', 'harbor'],
  brewery: ['capital', 'farm'],
  builder: [],
  trader: [],
  stateworks: [],
};

const PRODUCERS: Sector[] = ['farm', 'fishery', 'lumber', 'coalmine', 'oremine', 'oilwell', 'smelter', 'toolworks', 'furniture', 'bakery', 'brewery'];

const TEMP_OCC = 2_000_000_000;
/** Candidate sites examined per resource sector and host town. */
const CANDIDATE_SITES = 18;

/** Greedy best non-overlapping sites for a resource sector near a town (occupancy restored afterwards). */
function candidateSites(s: SimState, sector: Sector, town: TownId, k: number): Site[] {
  const out: Site[] = [];
  const marked: number[] = [];
  const [w, h] = footprintOf('firm', sector);
  const m = s.map;
  for (let n = 0; n < k; n++) {
    const p = findSite(s, sector, town);
    if (!p) break;
    out.push({ x: p.x, y: p.y, q: siteQuality(m, sector, p.x, p.y, w, h) });
    for (let yy = p.y; yy < p.y + h; yy++) {
      for (let xx = p.x; xx < p.x + w; xx++) {
        const i = yy * m.w + xx;
        m.occ[i] = TEMP_OCC;
        marked.push(i);
      }
    }
  }
  for (const i of marked) m.occ[i] = -1;
  return out;
}

/** Host towns of a sector on this map (resource sectors fall back to the town with the best sites). */
function hostTowns(s: SimState, sector: Sector, cands: Map<string, Site[]>): TownId[] {
  const kinds = HOSTING[sector];
  const list = s.towns.filter((t) => kinds.includes(t.kind)).map((t) => t.id);
  if (!isResourceSector(sector)) return list;
  const ok = list.filter((t) => (cands.get(sector + ':' + t) ?? []).some((c) => c.q > 0.3));
  if (ok.length > 0) return ok;
  // Fallback: the town with the richest candidate sites for this resource.
  let best = -1;
  let bq = 0;
  for (const t of s.towns) {
    const cs = cands.get(sector + ':' + t.id) ?? [];
    const q = cs.slice(0, 4).reduce((a, c) => a + c.q, 0);
    if (q > bq) {
      bq = q;
      best = t.id;
    }
  }
  return best >= 0 ? [best] : list;
}

/** Cost of one wagon's round trip (¤) from town a to b at prices P (drivers both ways, oil one way, wagon wear). */
function tripCostInit(P: Mat, days: Mat, len: Mat, a: number, b: number): number {
  const rd = 2 * days[a][b];
  const driver = W * rd * INIT_DRIVER_SLACK;
  const oil = P[a][G.oil] * OIL_PER_TILE * len[a][b];
  const wear = P[a][G.tools] * (WAGON_WEAR_DAY * rd + TOOLS_PER_WAGON * (TOOLS_IDLE_WEAR_DAY + INIT_LEND_RATE / DAYS_PER_YEAR) * rd);
  return driver + oil + wear;
}

/**
 * Freight cost per unit (¤) from town a to b: the trip cost shared over the average wagon
 * load on that route. Traders load every good bound for a town into the same wagons, so the
 * load is set by the route's total flow (routeLoad; a full wagon when unknown).
 */
function freightUnit(P: Mat, days: Mat, len: Mat, a: number, b: number, load = WAGON_CAPACITY): number {
  return tripCostInit(P, days, len, a, b) / Math.max(1e-6, Math.min(WAGON_CAPACITY, load));
}

/** Price elasticity assumed for firms' input demand in founding curve snapshots. */
const INTERMEDIATE_ELASTICITY = 0.4;

/**
 * A founding order-book snapshot: demand `buy` at price P spread over the household bid
 * rungs with an iso-elastic shape, and local supply `supply` over the firms' ask rungs.
 * Flattened [price, cumulative qty, …]: bids descending, asks ascending (base prices).
 */
export function foundingCurve(P: number, buy: number, supply: number, elasticity: number): CurveSnapshot {
  const bids: number[] = [];
  const asks: number[] = [];
  if (buy > 1e-6 && P > 0) for (const r of BID_RUNGS) bids.push(round4(P * r), round4(buy * Math.pow(1 / r, elasticity)));
  if (supply > 1e-6 && P > 0) {
    let cum = 0;
    ASK_RUNGS.forEach((r, i) => {
      cum += supply * (ASK_WEIGHTS[i] ?? 0);
      asks.push(round4(P * r), round4(cum));
    });
  }
  return { bids, asks, state: [], price: round4(P), volume: round4(buy), wedge: { bPct: 0, bUnit: 0, sPct: 0, sUnit: 0 }, ceiling: -1, floor: -1 };
}

/**
 * Typical load of a wagon on a flow of `q` units/day, as traders consolidate: full wagons
 * for big flows; a wagon leaves at once when at least TRADE_MIN_LOAD full, otherwise the
 * goods wait up to TRADE_HOLD_DAYS for company.
 */
function wagonLoad(q: number, perishable = false): number {
  if (q >= WAGON_CAPACITY) return WAGON_CAPACITY;
  // A load with perishables leaves every day, part-full if need be (traders.tradersDispatch).
  if (perishable || q >= TRADE_MIN_LOAD * WAGON_CAPACITY) return Math.max(1e-6, q);
  return Math.max(1e-6, Math.min(WAGON_CAPACITY, q * (1 + TRADE_HOLD_DAYS)));
}

/** Wagons loaded on the way out of a flow of `q` units/day over `d` days (each at most one wagonload). */
function loadsOnRoad(q: number, d: number, perishable = false): number {
  const inTransit = q * d;
  return Math.max(1, Math.round((q / wagonLoad(q, perishable)) * d), Math.ceil(inTransit / WAGON_CAPACITY - 1e-9));
}

/** Units per day dispatched on each route a → b ([a][b]) and whether they include perishables. */
function routeFlows(flows: readonly FlowRec[], NT: number): { q: Mat; perish: boolean[][] } {
  const q: Mat = Array.from({ length: NT }, () => new Array(NT).fill(0));
  const perish: boolean[][] = Array.from({ length: NT }, () => new Array(NT).fill(false));
  for (const f of flows) {
    q[f.from][f.to] += f.qty;
    if (GOODS[f.good].spoil > 0) perish[f.from][f.to] = true;
  }
  return { q, perish };
}

/** Share of a shipment that survives the journey (perishables spoil on the wagon). */
function survival(g: number, d: number): number {
  return Math.pow(1 - GOODS[g].spoil, Math.max(0, d));
}

/**
 * Lowest destination price at which a trader ships a good bought at `pa` over a route of
 * `d` days with freight `F` per unit — the traders' own rule: the destination price, kept
 * for spoilage over the trip plus a day, less freight and the minimum margin (the larger of
 * TRADE_MIN_MARGIN_ABS and TRADE_MIN_MARGIN_PCT of the selling price) must cover the purchase.
 */
function landedPrice(g: number, pa: number, F: number, d: number): number {
  const keep = Math.max(0.1, survival(g, d + 1));
  const byAbs = (pa + F + TRADE_MIN_MARGIN_ABS) / keep;
  const byPct = (pa + F) / Math.max(0.05, keep - TRADE_MIN_MARGIN_PCT);
  return Math.max(byAbs, byPct) * (1 + INIT_TRADE_EDGE);
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

interface CalOpts {
  foreign: boolean;
  world: number[] | null; // fixed world prices (gold); null = decide from harbour prices
  R: RngHolder;
  /** Realised ÷ planned household demand, [town][0 worker | 1 owner][good] (from householdSteady); null = 1. */
  hhRatio: number[][][] | null;
}

function calibrate(s: SimState, cands: Map<string, Site[]>, opts: CalOpts): Cal {
  const NT = s.towns.length;
  const o = OWNER_SHARE;
  const u = INIT_UNEMPLOYMENT;
  const Ntot = s.towns.reduce((a, t) => a + (TOWN_POP[t.kind] ?? 100), 0);
  const harbor = s.towns.findIndex((t) => t.hasPort);

  // Steady-state health (full food, warm, housed) → effective labour per worker.
  let hsum = 0;
  for (let age = 18; age <= 76; age++) hsum += healthTarget(1, 1, HEAT_MEAN, true, age);
  const health = 0.995 * (hsum / 59);
  // Effective labour per worker as firms count it: (0.5 + 0.5·health) × skill.
  const healthEff = (0.5 + 0.5 * health) * Math.exp((INIT_SKILL_SIGMA * INIT_SKILL_SIGMA) / 2);
  const wEff = W / healthEff;

  // Routes (days, lengths) between towns along the founding tracks.
  const days: Mat = [];
  const len: Mat = [];
  for (let a = 0; a < NT; a++) {
    days.push([]);
    len.push([]);
    for (let b = 0; b < NT; b++) {
      const r = routeBetweenTowns(s, a, b);
      days[a].push(a === b ? 0 : Math.max(0.1, r.days));
      len[a].push(a === b ? 0 : Math.max(1, r.length));
    }
  }

  // Hosts.
  const hosts: Host[] = [];
  const hostsOf = new Map<Sector, TownId[]>();
  for (const sec of PRODUCERS) {
    const towns = hostTowns(s, sec, cands);
    hostsOf.set(sec, towns);
    const d = SECTORS[sec];
    for (const t of towns) {
      hosts.push({
        sector: sec,
        town: t,
        sites: isResourceSector(sec) ? cands.get(sec + ':' + t) ?? [] : [],
        n: 0,
        M: wEff / (d.alpha * d.prodPerWorker),
        X: 0,
        leff: [],
        workers: [],
        q: [],
        mult: [],
      });
    }
  }
  const hostAt = (sec: Sector, t: number) => hosts.find((h) => h.sector === sec && h.town === t);

  const p0 = basePrices(W);
  let P: Mat = s.towns.map(() => p0.slice());
  const src: number[][] = s.towns.map(() => new Array(N_GOODS).fill(-1));
  let N = s.towns.map((t) => TOWN_POP[t.kind] ?? 100);
  let kappa = 1;
  let yO = s.towns.map(() => W * (1 - u) * 3.5);
  let yW = W * (1 - u);
  let flows: FlowRec[] = [];
  let D: Mat = s.towns.map(() => new Array(N_GOODS).fill(0));
  let HH: Mat = s.towns.map(() => new Array(N_GOODS).fill(0));
  let drivers = new Array(NT).fill(1);
  let wagonsInUse = new Array(NT).fill(0);
  let traderOil = new Array(NT).fill(0);
  let traderProfit = new Array(NT).fill(0);
  let profitTown = new Array(NT).fill(0);
  let imports = new Array(N_GOODS).fill(0);
  let exports = new Array(N_GOODS).fill(0);
  let shipCap = new Array(N_GOODS).fill(0);
  let world: number[] = opts.world ? opts.world.slice() : new Array(N_GOODS).fill(0);
  // Average wagon load per route (units), from the previous iteration's flows (full wagons at first).
  let RL: Mat = s.towns.map(() => new Array(NT).fill(WAGON_CAPACITY));
  const ITER = 48;
  const FREEZE = 26;
  const FOREIGN_FROM = 12;

  for (let it = 0; it < ITER; it++) {
    // ---- 1. prices -------------------------------------------------------------
    const Pn: Mat = P.map((r) => r.slice());
    for (let g = 0; g < N_GOODS; g++) {
      const sec = PRODUCER_OF[g];
      const hs = hostsOf.get(sec) ?? [];
      for (let t = 0; t < NT; t++) {
        let best = Infinity;
        let from = -1;
        if (hs.includes(t)) {
          const h = hostAt(sec, t) as Host;
          const d = SECTORS[sec];
          // Tool cost per unit as firms reckon it (typical output per worker on this site, at the bank's base rate).
          const opw = d.prodPerWorker * meanMult(h) * healthEff;
          // Firms also count the stock that spoils while it waits to be sold (firms.planTarget:
          // spoil × stock days × price), so the price covers it: P = (materials + tools + M) / (1 − that share).
          const spoilShare = GOODS[g].spoil * (GOODS[g].spoil >= 0.01 ? INV_TARGET_DAYS_PERISHABLE : INV_TARGET_DAYS);
          // Firms price at marginal cost × BASE_MARKUP (firms.planTarget).
          best = ((materialCostPerUnit(sec, P[t]) + toolCostPerUnit(sec, P[t][G.tools], opw, s.bank.baseRate) + h.M) * BASE_MARKUP) / Math.max(0.5, 1 - spoilShare);
          from = t;
        }
        for (const hh of hs) {
          if (hh === t) continue;
          const landed = landedPrice(g, P[hh][g], freightUnit(P, days, len, hh, t, RL[hh][t]), days[hh][t]);
          if (landed < best) {
            best = landed;
            from = hh;
          }
        }
        if (from >= 0 && Number.isFinite(best)) {
          Pn[t][g] = best;
          src[t][g] = from;
        } else {
          Pn[t][g] = p0[g];
          src[t][g] = -1;
        }
      }
    }
    // Foreign competition caps the harbour price of a good it imports (ships undercut
    // the landed domestic price) only when imports cover the harbour's whole use; we
    // keep domestic pricing and let imports displace part of the supply.
    const damp = it < 6 ? 0.7 : 0.5;
    P = P.map((row, t) => row.map((v, g) => fin(v + damp * (Pn[t][g] - v), p0[g])));

    // ---- 2. demand ----------------------------------------------------------------
    HH = s.towns.map(() => new Array(N_GOODS).fill(0));
    for (let t = 0; t < NT; t++) {
      const qW = stationaryPlan(P[t], yW * kappa, RENT0).q;
      const qO = stationaryPlan(P[t], yO[t] * kappa, 0).q;
      const rr = opts.hhRatio ? opts.hhRatio[t] : null;
      for (let g = 0; g < N_GOODS; g++) HH[t][g] = N[t] * ((1 - o) * qW[g] * (rr ? rr[0][g] : 1) + o * qO[g] * (rr ? rr[1][g] : 1));
    }
    D = HH.map((r) => r.slice());
    for (const h of hosts) {
      const d = SECTORS[h.sector];
      for (const [g, a] of d.inputs) D[h.town][g] += a * h.X;
      let le = 0;
      for (const l of h.leff) le += l;
      const K = d.toolsPerWorker * le;
      D[h.town][G.tools] += d.toolUse * le + TOOLS_IDLE_WEAR_DAY * K;
    }
    for (let t = 0; t < NT; t++) {
      D[t][G.oil] += traderOil[t];
      const wg = wagonsInUse[t] * INIT_WAGON_SLACK + 1;
      D[t][G.tools] += WAGON_WEAR_DAY * wagonsInUse[t] + TOOLS_IDLE_WEAR_DAY * wg * TOOLS_PER_WAGON;
      // builders' equipment wear
      D[t][G.tools] += SECTORS.builder.toolUse * INIT_BUILDERS * healthEff;
    }
    // Foreign trade at the port (fixed from FOREIGN_FROM on).
    imports = new Array(N_GOODS).fill(0);
    exports = new Array(N_GOODS).fill(0);
    if (opts.foreign && harbor >= 0 && it >= FOREIGN_FROM) {
      if (it === FOREIGN_FROM) {
        const use = new Array(N_GOODS).fill(0);
        for (let t = 0; t < NT; t++) for (let g = 0; g < N_GOODS; g++) use[g] += D[t][g];
        shipCap = use.map((x, g) => (GOODS[g].tradable ? Math.round(SHIP_CAP_SHARE * x * 100) / 100 : 0));
        if (!opts.world) world = chooseWorldPrices(P[harbor], shipCap, opts.R);
      }
      const E = INIT_GOLD_PRICE;
      for (const g of TRADABLE_GOODS) {
        if (!(world[g] > 0)) continue;
        const ask = E * world[g] * (1 + IMPORT_MARKUP);
        const bid = E * world[g] * (1 - EXPORT_DISCOUNT);
        const ph = P[harbor][g];
        if (ask < ph * 0.99) imports[g] = Math.min(shipCap[g], D[harbor][g]);
        else if (bid > ph * 1.01) exports[g] = shipCap[g];
        D[harbor][g] += exports[g] - imports[g];
      }
    }

    // ---- 3. sourcing: who makes what for whom ----------------------------------------
    for (const h of hosts) h.X = 0;
    flows = [];
    for (let g = 0; g < N_GOODS; g++) {
      const sec = PRODUCER_OF[g];
      for (let t = 0; t < NT; t++) {
        const need = D[t][g];
        if (!(need > 1e-6)) continue;
        const from = src[t][g];
        if (from < 0) continue;
        const h = hostAt(sec, from);
        if (!h) continue;
        if (from === t) h.X += need;
        else {
          const qty = need / Math.max(0.05, survival(g, days[from][t]));
          h.X += qty;
          flows.push({ from, to: t, good: g, qty });
        }
      }
    }

    // ---- 4. firms ----------------------------------------------------------------------
    for (const h of hosts) solveHost(h, wEff, healthEff, it < FREEZE);

    // ---- 5. traders ----------------------------------------------------------------------
    wagonsInUse = new Array(NT).fill(0);
    traderOil = new Array(NT).fill(0);
    traderProfit = new Array(NT).fill(0);
    const busyEst = new Array(NT).fill(0);
    // Every good bound for a town shares the wagons (mixed loads): fleet, fuel and freight per route.
    const rf = routeFlows(flows, NT);
    for (let a = 0; a < NT; a++) {
      for (let b = 0; b < NT; b++) {
        const q = rf.q[a][b];
        if (!(q > 1e-9) || a === b) {
          RL[a][b] = RL[a][b] + 0.5 * (WAGON_CAPACITY - RL[a][b]);
          continue;
        }
        const load = wagonLoad(q, rf.perish[a][b]);
        RL[a][b] = RL[a][b] + 0.5 * (load - RL[a][b]);
        const trips = q / load; // wagons dispatched per day
        wagonsInUse[a] += trips * 2 * days[a][b];
        busyEst[a] += 2 * loadsOnRoad(q, days[a][b], rf.perish[a][b]);
        traderOil[a] += trips * len[a][b] * OIL_PER_TILE;
      }
    }
    for (const f of flows) {
      // Sales of what arrives, less purchases and the house's own costs (drivers, oil, wear).
      const fu = freightUnit(P, days, len, f.from, f.to, wagonLoad(rf.q[f.from][f.to], rf.perish[f.from][f.to]));
      traderProfit[f.from] += f.qty * (survival(f.good, days[f.from][f.to]) * P[f.to][f.good] - P[f.from][f.good] - fu);
    }
    // One driver per wagon on the road (both legs), with slack; never fewer than the founding fleet in use.
    drivers = wagonsInUse.map((x, t) => Math.max(1, Math.round(x * INIT_DRIVER_SLACK), busyEst[t] + 1));

    // ---- 6. jobs → population ------------------------------------------------------------
    const J = new Array(NT).fill(0);
    for (const h of hosts) for (const w of h.workers) J[h.town] += w;
    for (let t = 0; t < NT; t++) J[t] += drivers[t] + INIT_BUILDERS;
    const Jt = J.reduce((a, b) => a + b, 0);
    const Nn = J.map((j) => (Ntot * j) / Math.max(1, Jt));
    N = N.map((v, t) => v + 0.6 * (Nn[t] - v));
    const e = Jt / Ntot;
    kappa = clamp(kappa * Math.pow((1 - u) / Math.max(0.2, e), 0.6), 0.5, 2);

    // ---- 7. incomes ---------------------------------------------------------------------
    profitTown = new Array(NT).fill(0);
    for (const h of hosts) profitTown[h.town] += hostProfit(h, P[h.town], wEff, healthEff);
    for (let t = 0; t < NT; t++) profitTown[t] += traderProfit[t];
    yW = W * (1 - u);
    yO = s.towns.map((_, t) => {
      const owners = Math.max(1, o * N[t]);
      const rents = RENT0 * N[t] * (1 - o);
      return W * (1 - u) + Math.max(0, profitTown[t] + rents) / owners;
    });
  }

  return {
    P,
    src,
    N,
    hosts,
    flows,
    D,
    HH,
    drivers,
    wagonsInUse,
    traderOil,
    traderProfit,
    profitTown,
    yW,
    yO,
    kappa,
    imports,
    exports,
    shipCap,
    world,
    healthEff,
    wageEff: wEff,
    days,
    len,
  };
}

/** Output-weighted site multiplier of a host's firms (1 before any are sized). */
function meanMult(h: Host): number {
  let q = 0;
  let qm = 0;
  for (let i = 0; i < h.q.length; i++) {
    q += h.q[i];
    qm += h.q[i] * (h.mult[i] ?? 1);
  }
  return q > 0 ? qm / q : h.sites.length ? 0.6 + 0.8 * h.sites[0].q : 1;
}

/**
 * Seasonal stock a producer carries on `day` (days of mean flow): the cumulative
 * surplus of a mean-1 seasonal profile above its lowest point — farms carry the
 * harvest into spring, coal mines stock up through summer for the winter
 * (mirrors firms.seasonalCarryDays / demandCarryDays).
 */
export function seasonalCarry(profile: (d: number) => number, sign: 1 | -1, day: number): number {
  const n = DAYS_PER_YEAR;
  let mean = 0;
  for (let d = 0; d < n; d++) mean += profile(d);
  mean /= n;
  let c = 0;
  let lo = Infinity;
  const cum: number[] = [];
  for (let d = 0; d < n; d++) {
    c += sign * (profile(d) - mean);
    cum.push(c);
    if (c < lo) lo = c;
  }
  const i = ((Math.floor(day) % n) + n) % n;
  return Math.max(0, (cum[i] - lo) / Math.max(1e-9, mean));
}

/** Seasonal factor of coal demand (part of all coal is burnt for heat; mean ≈ 1). */
function coalDemandSeason(day: number): number {
  return 1 - COAL_HEAT_SHARE + (COAL_HEAT_SHARE * heatNeed(day)) / Math.max(1e-6, HEAT_MEAN);
}

/** Number of firms, margin and per-firm labour for a host producing h.X. */
function solveHost(h: Host, wEff: number, healthEff: number, chooseN: boolean): void {
  const d = SECTORS[h.sector];
  const M0 = wEff / (d.alpha * d.prodPerWorker);
  const res = isResourceSector(h.sector);
  // The season scales output like the site does. Firms plan farms at the annual mean
  // (they carry stock) but other seasonal sectors (fisheries) at today's season, so
  // those are sized for the founding day.
  const S = d.season === 'farm' ? 1 : seasonFactor(d.season, 0);
  const multOf = (i: number) => S * (res ? 0.6 + 0.8 * (h.sites[i]?.q ?? 0) : 1);
  const maxN = res ? h.sites.length : 80;
  if (!(h.X > 1e-6) || maxN === 0) {
    h.n = 0;
    h.leff = [];
    h.workers = [];
    h.q = [];
    h.mult = [];
    h.M = M0;
    return;
  }
  const capMax = d.capacityPerLevel * INIT_MAX_LEVEL / (h.sector === 'farm' ? INIT_FARM_CAPACITY_HEADROOM : INIT_CAPACITY_HEADROOM);
  if (chooseN || h.n === 0 || h.n > maxN) {
    // Firms are optimally sized at margin M; the largest/smallest site bound their size.
    let bestN = 1;
    let bestErr = Infinity;
    let sm = 0;
    let mMax = 0;
    let mMin = Infinity;
    const ex = 1 / (1 - d.alpha);
    for (let n = 1; n <= maxN; n++) {
      const mn = multOf(n - 1);
      sm += Math.pow(mn, ex);
      if (mn > mMax) mMax = mn;
      if (mn < mMin) mMin = mn;
      const M = marginForSum(d, h.X, sm, wEff);
      const big = optLabor(d, M, mMax, wEff) / healthEff;
      const small = optLabor(d, M, mMin, wEff) / healthEff;
      let err = Math.abs(Math.log(M / M0));
      if (big > capMax) err += 5;
      if (small < 1.5 && n > 1) err += 3;
      if (err < bestErr) {
        bestErr = err;
        bestN = n;
      }
      if (M < 0.6 * M0) break; // more firms only lowers the margin further
    }
    h.n = bestN;
  }
  h.mult = [];
  for (let i = 0; i < h.n; i++) h.mult.push(multOf(i));
  const Mc = marginFor(d, h.X, h.mult, wEff);
  const lc = h.mult.map((m) => optLabor(d, Mc, m, wEff) / healthEff); // workers, continuous
  // Whole workers: round down, then add workers where the remainder is largest until the
  // host makes at least what is bought (a small surplus is benign; a shortfall drains stocks).
  const wk = lc.map((l) => Math.max(1, Math.floor(l)));
  const qOf = () => wk.reduce((a, w, i) => a + outputOf(d, w * healthEff, h.mult[i]), 0);
  for (let guard = 0; guard < 200 && qOf() < h.X * (1 - 1e-6); guard++) {
    let best = 0;
    let bestRem = -Infinity;
    for (let i = 0; i < wk.length; i++) {
      const rem = lc[i] - wk[i];
      if (rem > bestRem) {
        bestRem = rem;
        best = i;
      }
    }
    wk[best] += 1;
  }
  h.workers = wk;
  h.leff = wk.map((w) => w * healthEff);
  h.q = wk.map((w, i) => outputOf(d, w * healthEff, h.mult[i]));
  // The margin at which the host's aggregate optimal labour equals its actual workforce:
  // Σ L_i(M) = Σ w_i·e  →  M = (w_e/(α·A)) · (ΣL / Σ m_i^{1/(1−α)})^{1−α}.
  const ex = 1 / (1 - d.alpha);
  let sm = 0;
  let sl = 0;
  for (let i = 0; i < wk.length; i++) {
    sm += Math.pow(h.mult[i], ex);
    sl += h.leff[i];
  }
  h.M = sm > 0 && sl > 0 ? (wEff / (d.alpha * tfp(d.key))) * Math.pow(sl / sm, 1 - d.alpha) : Mc;
}

/** Daily profit of a host's firms at local prices (revenue − materials − tool wear − wages). */
function hostProfit(h: Host, P: readonly number[], wEff: number, healthEff: number): number {
  const d = SECTORS[h.sector];
  let pr = 0;
  const price = P[d.out];
  for (let i = 0; i < h.n; i++) {
    const q = h.q[i];
    const le = h.leff[i];
    const K = d.toolsPerWorker * le;
    const tools = (d.toolUse * le + TOOLS_IDLE_WEAR_DAY * K) * P[G.tools];
    pr += price * q - materialCostPerUnit(h.sector, P) * q - tools - W * h.workers[i];
  }
  void wEff;
  void healthEff;
  return pr;
}

/**
 * Seeded comparative advantage: a few tradable goods are cheap abroad (the port imports
 * them), a few dear (the port exports them), the rest near parity. Tries a handful of
 * draws and keeps the one whose import and export values are closest.
 */
function chooseWorldPrices(pHarbor: readonly number[], shipCap: readonly number[], R: RngHolder): number[] {
  let best: number[] = [];
  let bestGap = Infinity;
  for (let k = 0; k < 16; k++) {
    const goods = shuffle(R, TRADABLE_GOODS.slice());
    const f = new Array(N_GOODS).fill(0);
    let imp = 0;
    let exp = 0;
    goods.forEach((g, idx) => {
      let lo: number;
      let hi: number;
      if (idx < INIT_WORLD_N_CHEAP) [lo, hi] = INIT_WORLD_CHEAP;
      else if (idx < INIT_WORLD_N_CHEAP + INIT_WORLD_N_DEAR) [lo, hi] = INIT_WORLD_DEAR;
      else [lo, hi] = INIT_WORLD_NEUTRAL;
      f[g] = randRange(R, lo, hi);
      const v = pHarbor[g] * shipCap[g];
      if (idx < INIT_WORLD_N_CHEAP) imp += v;
      else if (idx < INIT_WORLD_N_CHEAP + INIT_WORLD_N_DEAR) exp += v;
    });
    const gap = Math.abs(imp - exp) / Math.max(1, imp + exp);
    if (gap < bestGap) {
      bestGap = gap;
      best = f;
    }
  }
  return best.map((fg, g) => (GOODS[g].tradable && fg > 0 ? Math.round(((pHarbor[g] * fg) / INIT_GOLD_PRICE) * 1e5) / 1e5 : 0));
}

// ---------------------------------------------------------------------------
// Layout of the founding towns
// ---------------------------------------------------------------------------

/** Build the inter-town tracks: capital to every town, plus shortcuts that save ≥ 25 %. */
function buildTownRoads(s: SimState): void {
  const cap = s.towns.find((t) => t.kind === 'capital') ?? s.towns[0];
  const w = s.map.w;
  const connect = (a: number, b: number): number[] => {
    const A = s.towns[a];
    const B = s.towns[b];
    // Start from the market-square ring tile of A nearest to B.
    let start = A.y * w + A.x;
    let bd = 1e9;
    for (let y = A.y - 2; y <= A.y + 1; y++) {
      for (let x = A.x - 2; x <= A.x + 1; x++) {
        const i = y * w + x;
        if (s.map.road[i] < 1) continue;
        const d = Math.hypot(x - B.x, y - B.y);
        if (d < bd) {
          bd = d;
          start = i;
        }
      }
    }
    return planTrack(s, start, B.y * w + B.x);
  };
  const others = s.towns.filter((t) => t.id !== cap.id).sort((a, b) => Math.hypot(a.x - cap.x, a.y - cap.y) - Math.hypot(b.x - cap.x, b.y - cap.y));
  for (const t of others) {
    const p = connect(cap.id, t.id);
    if (layTrack(s, p) > 0) invalidateRoutes(s);
  }
  // Shortcuts between the other towns.
  const pairs: [number, number][] = [];
  for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) pairs.push([others[i].id, others[j].id]);
  pairs.sort((p, q) => {
    const a = s.towns;
    return Math.hypot(a[p[0]].x - a[p[1]].x, a[p[0]].y - a[p[1]].y) - Math.hypot(a[q[0]].x - a[q[1]].x, a[q[0]].y - a[q[1]].y);
  });
  for (const [a, b] of pairs) {
    const cur = routeBetweenTowns(s, a, b);
    const p = connect(a, b);
    if (p.length < 2) continue;
    let fresh = 0;
    for (const i of p) if (s.map.road[i] < 1 && s.map.occ[i] < 0) fresh++;
    if (fresh >= 4 && p.length < 0.75 * cur.length) {
      if (layTrack(s, p) > 0) invalidateRoutes(s);
    }
  }
}

// ---------------------------------------------------------------------------
// createWorld
// ---------------------------------------------------------------------------

export function createWorld(opts: WorldOptions): SimState {
  const seed = (opts.seed ?? 1) | 0;
  const { map, sites } = generateMap(seed);
  const s = newSimState(seed, map);
  const R: RngHolder = s; // world init draws from the state's own RNG (deterministic per seed)
  const projectFunds = new Map<number, number>(); // owner id → deposits set aside for a founding project
  const scen = scenarioDef(opts.scenario ?? 'founding');
  s.settings.scenario = scen.id;
  s.settings.realmName = opts.realmName && opts.realmName.trim() ? opts.realmName.trim() : realmName(R);

  // ---- 1. towns, cores, tracks -----------------------------------------------------------
  const used = new Set<string>();
  sites.forEach((site: TownSite, id: number) => {
    let name = townName(R, site.kind);
    for (let k = 0; k < 5 && used.has(name); k++) name = townName(R, site.kind);
    used.add(name);
    s.towns.push(newTown(id, name, site.kind, site.x, site.y, 3));
  });
  s.treasury = newTreasury(s.towns.length);
  for (const t of s.towns) placeMarketHall(s, t.id);
  const capital = s.towns.find((t) => t.kind === 'capital') ?? s.towns[0];
  const harbor = s.towns.find((t) => t.hasPort) ?? null;
  buildTownRoads(s);
  const special: Building[] = [];
  {
    const p = findCoreSite(s, capital.id, 2, 2, false, 3);
    if (p) {
      const b = placeBuilding(s, 'palace', '', capital.id, p.x, p.y, 'active');
      b.owner = STATE;
      special.push(b);
    }
    const q = findCoreSite(s, capital.id, 2, 1, false, 2.5);
    if (q) {
      const b = placeBuilding(s, 'bank', '', capital.id, q.x, q.y, 'active');
      b.owner = BANK;
      special.push(b);
    }
    if (harbor) {
      const r = findCoreSite(s, harbor.id, 2, 1, true, 1.5);
      if (r) {
        const b = placeBuilding(s, 'port', '', harbor.id, r.x, r.y, 'active');
        b.owner = STATE;
        special.push(b);
      }
    }
  }

  // ---- 2–3. calibration --------------------------------------------------------------------
  // Core radius from the expected number of town buildings (farms keep outside it).
  const coreRadius = (pop: number, firms: number) => Math.sqrt(((pop * (1 + INIT_HOUSING_VACANCY)) / HOUSE_SLOTS + 2.5 * firms + 16) * 2.1 / Math.PI) + 1;
  for (const t of s.towns) t.radius = Math.round(coreRadius(TOWN_POP[t.kind] ?? 100, 6) * 10) / 10;
  const withForeign = scen.id !== 'isolated';
  const candFor = (): Map<string, Site[]> => {
    const c = new Map<string, Site[]>();
    for (const sec of PRODUCERS) {
      if (!isResourceSector(sec)) continue;
      // Sites near the designated host towns; other towns only as a fallback.
      const home = s.towns.filter((t) => HOSTING[sec].includes(t.kind));
      let good = false;
      for (const t of home) {
        const cs = candidateSites(s, sec, t.id, CANDIDATE_SITES);
        c.set(sec + ':' + t.id, cs);
        if (cs.some((x) => x.q > 0.3)) good = true;
      }
      if (!good) for (const t of s.towns) if (!c.has(sec + ':' + t.id)) c.set(sec + ':' + t.id, candidateSites(s, sec, t.id, CANDIDATE_SITES));
    }
    return c;
  };
  let cands = candFor();
  const rngSnapshot = s.rng.slice();
  let cal = calibrate(s, cands, { foreign: withForeign, world: null, R, hhRatio: null });
  // Realised household demand under the household module's own rules (see householdSteady).
  const steadyOf = (c: Cal) =>
    s.towns.map((t) => [
      householdSteady(c.P[t.id], c.yW * c.kappa, RENT0, bufferTarget(c.yW * c.kappa, 0.01, INIT_UNEMPLOYMENT)),
      householdSteady(c.P[t.id], c.yO[t.id] * c.kappa, 0, bufferTarget(c.yO[t.id] * c.kappa, 0.01, INIT_UNEMPLOYMENT) * 1.6),
    ]);
  const ratioOf = (c: Cal, st: HouseholdSteady[][]): number[][][] =>
    s.towns.map((t) => {
      const a = stationaryPlan(c.P[t.id], c.yW * c.kappa, RENT0).q;
      const b = stationaryPlan(c.P[t.id], c.yO[t.id] * c.kappa, 0).q;
      const r = (sim: number[], plan: number[]) => plan.map((x, g) => (x > 1e-9 ? clamp(sim[g] / x, 0, 3) : 1));
      return [r(st[t.id][0].q, a), r(st[t.id][1].q, b)];
    });
  // (The same simulations seed people's cash and pantries below: incomes are rescaled per person.)
  const steady = steadyOf(cal);
  const ratios = ratioOf(cal, steady);
  // Second pass with core radii from the calibrated populations (same world prices).
  for (const t of s.towns) {
    const nf = cal.hosts.filter((h) => h.town === t.id && !isResourceSector(h.sector)).reduce((a, h) => a + h.n, 0) + 2;
    t.radius = Math.round(coreRadius(cal.N[t.id], nf) * 10) / 10;
  }
  cands = candFor();
  s.rng = rngSnapshot.slice();
  const cal1 = cal;
  cal = calibrate(s, cands, { foreign: withForeign, world: cal.world, R, hhRatio: ratios });

  // ---- 4. firms -------------------------------------------------------------------------------
  const P = cal.P;
  const NT = s.towns.length;
  // Markets at the calibrated local prices. Each gets a founding order-book snapshot (as if
  // yesterday had cleared at those prices): local buyers' demand around the price and local
  // producers' daily supply. Traders read destination demand from yesterday's book, so
  // without it no wagon would leave on the first day and export trades would stall.
  const exportBuy: Mat = s.towns.map(() => new Array(N_GOODS).fill(0));
  const localSupply: Mat = s.towns.map(() => new Array(N_GOODS).fill(0));
  for (const fl of cal.flows) exportBuy[fl.from][fl.good] += fl.qty;
  for (const h of cal.hosts) {
    const out = SECTORS[h.sector].out;
    if (out >= 0) localSupply[h.town][out] += h.q.reduce((a, x) => a + x, 0);
  }
  for (let t = 0; t < NT; t++) {
    for (let g = 0; g < N_GOODS; g++) {
      const m = newMarket(t, g, round4(P[t][g]));
      const buy = Math.max(0, cal.D[t][g]) + exportBuy[t][g];
      m.volEma = round4(buy);
      m.curve = foundingCurve(P[t][g], buy, localSupply[t][g], ELASTICITY[g] ?? INTERMEDIATE_ELASTICITY);
      s.markets[t * N_GOODS + g] = m;
    }
  }

  const firmPlan: { firm: Firm; q: number; leff: number; workers: number }[] = [];
  const makeFirm = (sec: Sector, town: TownId, x: number, y: number, workers: number, q: number, leff: number, connect = true): Firm => {
    const d = SECTORS[sec];
    const b = placeBuilding(s, 'firm', sec, town, x, y, 'active', { connect });
    const head = sec === 'farm' ? INIT_FARM_CAPACITY_HEADROOM : INIT_CAPACITY_HEADROOM;
    b.level = clamp(Math.ceil((workers * head) / d.capacityPerLevel), 1, INIT_MAX_LEVEL);
    const f = newFirm(s, sec, town, b.id, STATE, firmName(R, d.name, s.towns[town].name));
    f.founded = -Math.round(randRange(R, 400, 3600)); // established long before the founding of the Treasury
    b.firm = f.id;
    f.capacity = d.capacityPerLevel * b.level;
    b.cost = round2(materialsValue(d.buildCost, P[town], W, BUILD_MARGIN) + (b.level - 1) * materialsValue(d.expandCost, P[town], W, BUILD_MARGIN));
    firmPlan.push({ firm: f, q, leff, workers });
    return f;
  };
  const unplaced: string[] = [];
  const pendingTracks: Building[] = [];
  // Resource firms first (the calibrated sites), then town workshops.
  const order = cal.hosts.slice().sort((a, b) => Number(isResourceSector(b.sector)) - Number(isResourceSector(a.sector)));
  for (const h of order) {
    for (let i = 0; i < h.n; i++) {
      let site: { x: number; y: number } | null = null;
      if (isResourceSector(h.sector)) {
        const c = h.sites[i];
        if (c && isValidSite(s, h.sector, c.x, c.y, h.town)) site = c;
      }
      if (!site) site = findSite(s, h.sector, h.town);
      if (!site) {
        unplaced.push(`${h.sector}@${h.town}`);
        continue;
      }
      const res = isResourceSector(h.sector);
      const f = makeFirm(h.sector, h.town, site.x, site.y, h.workers[i], h.q[i], h.leff[i], !res);
      if (res) pendingTracks.push(s.buildings[f.building]);
    }
    // Once every resource site is taken, lay their tracks, nearest the town first.
    const next = order[order.indexOf(h) + 1];
    if (isResourceSector(h.sector) && (!next || !isResourceSector(next.sector))) {
      pendingTracks.sort((a, b) => {
        const ta = s.towns[a.town];
        const tb = s.towns[b.town];
        return Math.hypot(a.x - ta.x, a.y - ta.y) - Math.hypot(b.x - tb.x, b.y - tb.y) || a.id - b.id;
      });
      for (const b of pendingTracks) if (connectBuilding(s, b) > 0) invalidateRoutes(s);
      pendingTracks.length = 0;
    }
  }
  // Traders' and builders' yards.
  const traders: Firm[] = [];
  const builders: Firm[] = [];
  for (const t of s.towns) {
    const pt = findSite(s, 'trader', t.id);
    if (pt) {
      const f = makeFirm('trader', t.id, pt.x, pt.y, cal.drivers[t.id], 0, cal.drivers[t.id] * cal.healthEff);
      const b = s.buildings[f.building];
      b.level = clamp(Math.ceil((cal.drivers[t.id] * INIT_CAPACITY_HEADROOM) / SECTORS.trader.capacityPerLevel), 1, INIT_MAX_LEVEL);
      f.capacity = SECTORS.trader.capacityPerLevel * b.level;
      traders[t.id] = f;
    }
    const pb = findSite(s, 'builder', t.id);
    if (pb) builders[t.id] = makeFirm('builder', t.id, pb.x, pb.y, INIT_BUILDERS, 0, INIT_BUILDERS * cal.healthEff);
    const sw = newFirm(s, 'stateworks', t.id, -1, STATE, `${t.name} ${SECTORS.stateworks.name}`);
    sw.wage = W;
    sw.target = 0;
    sw.capacity = SECTORS.stateworks.capacityPerLevel;
  }

  // ---- 5. people & houses -------------------------------------------------------------------------
  const townPop: number[] = [];
  const jobsAt: number[] = new Array(NT).fill(0);
  for (const fp of firmPlan) jobsAt[fp.firm.town] += fp.workers;
  for (let t = 0; t < NT; t++) townPop.push(Math.max(jobsAt[t] + 1, Math.round(jobsAt[t] / (1 - INIT_UNEMPLOYMENT))));
  for (let t = 0; t < NT; t++) {
    for (let k = 0; k < townPop[t]; k++) {
      const p = newPerson(s, t, personName(R));
      p.age = Math.round(18 + 58 * Math.pow(rand(R), 1.15));
      p.skill = round3(clamp(lognormal(R, 1, INIT_SKILL_SIGMA), 0.7, 1.4));
      p.health = round3(clamp(healthTarget(1, 1, HEAT_MEAN, true, p.age) * randRange(R, 0.99, 1), 0.3, 1));
      p.contentment = round3(randRange(R, 0.58, 0.7));
      p.joy = round3(randRange(R, 0.35, 0.55));
      p.foodSat = 1;
      p.heatSat = 1;
      p.born = 0;
    }
  }
  const peopleOf: number[][] = s.towns.map(() => []);
  for (const p of s.people) peopleOf[p.town].push(p.id);

  // Houses near each centre.
  const houses: Building[][] = s.towns.map(() => []);
  for (const t of s.towns) {
    const need = Math.ceil((townPop[t.id] * (1 + INIT_HOUSING_VACANCY)) / HOUSE_SLOTS);
    for (let k = 0; k < need; k++) {
      // Houses fill the town outward from the market: look just beyond the built-up area first.
      const site = findSite(s, 'house', t.id, t.radius + 4) ?? findSite(s, 'house', t.id);
      if (!site) {
        t.radius += 2; // grow the settlement outward and retry once
        const s2 = findSite(s, 'house', t.id);
        if (!s2) break;
        houses[t.id].push(placeBuilding(s, 'house', '', t.id, s2.x, s2.y, 'active'));
        continue;
      }
      houses[t.id].push(placeBuilding(s, 'house', '', t.id, site.x, site.y, 'active'));
      updateTownRadius(s, t.id);
    }
  }

  // ---- ownership -----------------------------------------------------------------------------------
  const ownersOf: number[][] = s.towns.map(() => []);
  const weightOf = new Map<number, number>();
  for (let t = 0; t < NT; t++) {
    const ids = shuffle(R, peopleOf[t].slice());
    const n = clamp(Math.round(OWNER_SHARE * ids.length), 1, ids.length);
    ownersOf[t] = ids.slice(0, n);
    ownersOf[t].forEach((pid, rank) => weightOf.set(pid, 1 / Math.pow(rank + 1, 0.8)));
  }
  const pickOwner = (t: number): number => {
    const list = ownersOf[t];
    let tot = 0;
    for (const pid of list) tot += weightOf.get(pid) ?? 1;
    let r = rand(R) * tot;
    for (const pid of list) {
      r -= weightOf.get(pid) ?? 1;
      if (r <= 0) return pid;
    }
    return list[list.length - 1];
  };
  const firmsByTown: Firm[][] = s.towns.map(() => []);
  for (const fp of firmPlan) firmsByTown[fp.firm.town].push(fp.firm);
  for (let t = 0; t < NT; t++) {
    const fs = shuffle(R, firmsByTown[t].slice());
    const owners = ownersOf[t];
    fs.forEach((f, idx) => {
      // Round-robin first so every owner has a stake, then weighted by wealth rank.
      const pid = idx < owners.length ? owners[idx] : pickOwner(t);
      setOwner(s, f, pid);
    });
    const hs = shuffle(R, houses[t].slice());
    const noFirm = owners.filter((pid) => s.people[pid].owns.length === 0);
    hs.forEach((b, idx) => {
      const pid = idx < noFirm.length ? noFirm[idx] : pickOwner(t);
      b.owner = personRef(pid);
      s.people[pid].houses.push(b.id);
    });
  }
  // The Bank's owner: the capital owner of highest standing.
  const capOwners = ownersOf[capital.id];
  s.bank.owner = capOwners.length ? capOwners[0] : 0;

  // ---- homes: owners in their own houses, then workers nearest their work -------------------------
  const slotsLeft = new Map<number, number>();
  for (const hs of houses) for (const b of hs) slotsLeft.set(b.id, b.slots);
  const moveIn = (p: Person, b: Building) => {
    b.residents.push(p.id);
    p.home = b.id;
    slotsLeft.set(b.id, (slotsLeft.get(b.id) ?? 0) - 1);
  };
  for (let t = 0; t < NT; t++) {
    for (const pid of ownersOf[t]) {
      const p = s.people[pid];
      const own = p.houses.map((id) => s.buildings[id]).find((b) => b && b.town === t && (slotsLeft.get(b.id) ?? 0) > 0);
      if (own) moveIn(p, own);
    }
  }

  // ---- 6. jobs ------------------------------------------------------------------------------------
  // Firms count effective labour Σ(0.5 + 0.5·health)·skill, and their optimal size reacts
  // several-fold to it, so every firm gets a representative mix of workers: the employed are
  // chosen at random, then dealt best-first to whichever firm has the largest share of its
  // need still open (owners first take a place in their own shop).
  const effOf = (p: Person) => (0.5 + 0.5 * p.health) * p.skill;
  for (let t = 0; t < NT; t++) {
    const fs = firmPlan.filter((fp) => fp.firm.town === t && fp.workers > 0);
    for (const fp of fs) {
      const f = fp.firm;
      const owner = f.owner >= 0 ? s.people[f.owner] : undefined;
      if (owner && owner.town === t && owner.job < 0 && f.workers.length < fp.workers) employ(s, f, owner);
    }
    let need = 0;
    for (const fp of fs) need += Math.max(0, fp.workers - fp.firm.workers.length);
    const pool = shuffle(R, peopleOf[t].filter((pid) => s.people[pid].job < 0)).slice(0, need);
    pool.sort((a, b) => effOf(s.people[b]) - effOf(s.people[a]) || a - b);
    for (const pid of pool) {
      let best: (typeof fs)[number] | null = null;
      let bestOpen = 0;
      for (const fp of fs) {
        const open = (fp.workers - fp.firm.workers.length) / fp.workers;
        if (open > bestOpen + 1e-12) {
          bestOpen = open;
          best = fp;
        }
      }
      if (!best) break;
      employ(s, best.firm, s.people[pid]);
    }
  }
  // Remaining homes: employed people nearest their work, the rest anywhere in town.
  for (let t = 0; t < NT; t++) {
    const list = peopleOf[t].map((id) => s.people[id]).filter((p) => p.home < 0);
    list.sort((a, b) => (a.job >= 0 ? 0 : 1) - (b.job >= 0 ? 0 : 1));
    for (const p of list) {
      const f = p.job >= 0 ? s.firms[p.job] : null;
      const wb = f && f.building >= 0 ? s.buildings[f.building] : null;
      const tx = wb ? wb.x + wb.w / 2 : s.towns[t].x;
      const ty = wb ? wb.y + wb.h / 2 : s.towns[t].y;
      let best: Building | null = null;
      let bd = 1e18;
      for (const b of houses[t]) {
        if ((slotsLeft.get(b.id) ?? 0) <= 0) continue;
        const d = Math.hypot(b.x + 0.5 - tx, b.y + 0.5 - ty);
        if (d < bd) {
          bd = d;
          best = b;
        }
      }
      if (best) moveIn(p, best);
    }
  }
  for (const p of s.people) {
    if (p.job >= 0) p.commute = commuteTiles(s, p, s.firms[p.job]);
  }

  // Rents: a little dearer near the centre.
  for (let t = 0; t < NT; t++) {
    const town = s.towns[t];
    const r = Math.max(3, town.radius);
    for (const b of houses[t]) {
      const d = Math.hypot(b.x + 0.5 - town.x, b.y + 0.5 - town.y);
      b.rent = round3(RENT0 * (1 + INIT_RENT_SPREAD * (1 - (2 * clamp(d / r, 0, 1)))));
      b.cost = round2(materialsValue(HOUSE_COST, P[t], W, BUILD_MARGIN));
      b.vacantDays = (slotsLeft.get(b.id) ?? 0) > 0 ? 1 : 0;
    }
  }

  // ---- 7–8. firm state, inventories, money ----------------------------------------------------------
  const setupProducer = (fp: { firm: Firm; q: number; leff: number; workers: number }) => {
    const f = fp.firm;
    const d = SECTORS[f.sector];
    const Pt = P[f.town];
    f.wage = W;
    f.target = f.workers.length;
    const leff = f.workers.length * cal.healthEff;
    f.tools = round3(d.toolsPerWorker * leff * 1.02 + TOOLS_BUFFER_DAYS * d.toolUse * leff);
    if (d.producer) {
      // Scale planned output to the workforce actually hired (normally identical).
      const q = fp.workers > 0 ? fp.q * Math.pow(f.workers.length / fp.workers, d.alpha) : 0;
      const out = d.out;
      f.pExp = round4(Pt[out]);
      // Sales EMA as realised today: coal sells above its annual mean while homes are heated.
      f.sales = round4(out === G.coal ? q * coalDemandSeason(0) : q);
      f.salesLong = round4(q); // the firm is sized for its annual mean sales
      // A year of sales by month as the founding plan expects them (the season learnt from them, firms.salesSeason).
      f.salesMonths = Array.from({ length: 12 }, (_, m) => round4(out === G.coal ? q * coalDemandSeason(m * DAYS_PER_MONTH + DAYS_PER_MONTH / 2) : q));
      f.output = round4(q);
      f.unitCost = round4(fin(unitVariableCost(f.sector, W, Math.max(1e-6, q / Math.max(1, f.workers.length)), Pt), Pt[out]));
      // Stock at the firms' own target: INV_TARGET days (perishables less) plus the seasonal carry.
      const perish = GOODS[out].spoil >= 0.01;
      let stockDays = perish ? INV_TARGET_DAYS_PERISHABLE : INV_TARGET_DAYS;
      if (d.season === 'farm') stockDays += seasonalCarry(farmSeason, 1, 0);
      if (out === G.coal) stockDays += seasonalCarry(coalDemandSeason, -1, 0);
      f.inv[out] = round3(q * stockDays);
      for (const [g, a] of d.inputs) f.inv[g] = round3(a * q * INPUT_BUFFER_DAYS);
      const matCost = materialCostPerUnit(f.sector, Pt) * q;
      const toolWear = (d.toolUse * leff + TOOLS_IDLE_WEAR_DAY * f.tools) * Pt[G.tools];
      const costs = W * f.workers.length + matCost + toolWear;
      f.profit = round4(Pt[out] * q - costs);
      f.profitLong = f.profit;
      f.cash = round2(INIT_FIRM_CASH_DAYS * costs);
    }
  };
  for (const fp of firmPlan) setupProducer(fp);

  // Traders: wagons, oil, shipments in transit, a little stock already delivered.
  for (let t = 0; t < NT; t++) {
    const f = traders[t];
    if (!f || !f.trade) continue;
    const tr = f.trade;
    const outFlows = cal.flows.filter((fl) => fl.from === t);
    const busy: number[] = [];
    let freightSum = 0;
    let unitsTiles = 0;
    const rf = routeFlows(outFlows, NT);
    for (let to = 0; to < NT; to++) {
      const Q = rf.q[t][to];
      if (to === t || !(Q > 1e-9)) continue;
      const flowsTo = outFlows.filter((fl) => fl.to === to);
      const d = cal.days[t][to];
      const L = cal.len[t][to];
      // Every good bound for `to` shares the wagons (mixed loads, traders.tradersDispatch).
      const fu = freightUnit(P, cal.days, cal.len, t, to, wagonLoad(Q, rf.perish[t][to]));
      for (const fl of flowsTo) {
        const surv = survival(fl.good, d);
        tr.basis[to][fl.good] = round4((P[t][fl.good] + fu) / Math.max(0.05, surv));
        freightSum += fu * fl.qty;
        unitsTiles += fl.qty * L;
        // Stock left over at the destination (a quarter of a day of arrivals).
        tr.stock[to][fl.good] = round3(tr.stock[to][fl.good] + 0.25 * fl.qty * surv);
      }
      // The recent past of the traders' own rule (traders.tradersDispatch): a load leaves each
      // day at noon (every few days for a thin route of durables, which waits to fill a wagon),
      // arrives `d` days later and its wagons are busy until day + 2d. Departures whose goods
      // are still on the way, or whose wagons are not yet home, are in progress on day 0.
      const load = wagonLoad(Q, rf.perish[t][to]);
      const perDay = Q / load; // wagons dispatched per day (may be fractional)
      let acc = 0.5;
      for (let k = -1; k >= -Math.ceil(2 * d + 2); k--) {
        acc += perDay;
        const wag = Math.floor(acc + 1e-9);
        if (wag <= 0) continue;
        acc -= wag;
        const arrive = k + 0.5 + d;
        if (arrive > 0) {
          for (const fl of flowsTo) {
            const qty = round3((fl.qty / Q) * wag * load);
            if (!(qty > 0.01)) continue;
            newShipment(s, firmRef(f.id), t, to, fl.good, qty, tr.basis[to][fl.good], round3(k + 0.5), round3(arrive), round3((wag * fl.qty) / Q));
          }
        }
        if (k + 2 * d > 0) for (let w = 0; w < wag; w++) busy.push(round3(k + 2 * d));
      }
    }
    const inUse = cal.wagonsInUse[t];
    tr.wagons = Math.max(busy.length + 2, Math.ceil(inUse * INIT_WAGON_SLACK) + 1);
    tr.busy = busy;
    // Wagons the house keeps on the road in steady state (drives its drivers, fuel store and fleet).
    (tr as { wantEma?: number }).wantEma = round3(Math.max(busy.length, inUse));
    tr.freightEma = round4(unitsTiles > 0 ? freightSum / unitsTiles : 0.03);
    f.tools = round3(tr.wagons * TOOLS_PER_WAGON);
    f.wage = W;
    f.target = f.workers.length;
    const tripOil = outFlows.length ? cal.traderOil[t] / Math.max(1e-6, outFlows.reduce((a, fl) => a + fl.qty / WAGON_CAPACITY, 0)) : OIL_PER_TILE * 30;
    f.inv[G.oil] = round3(Math.max(cal.traderOil[t] * 6, tripOil * 10));
    const costs = W * f.workers.length + cal.traderOil[t] * P[t][G.oil] + (WAGON_WEAR_DAY * inUse) * P[t][G.tools];
    let purchases = 0;
    for (const fl of outFlows) purchases += fl.qty * P[t][fl.good];
    f.profit = round4(cal.traderProfit[t]);
    // Operating cash plus working capital for merchandise bought, on the road and on sale.
    f.cash = round2(INIT_FIRM_CASH_DAYS * costs + INIT_TRADER_WC_DAYS * purchases);
    f.pExp = 0;
  }

  // Builders: a nearly finished house as the founding project.
  for (let t = 0; t < NT; t++) {
    const f = builders[t];
    if (!f) continue;
    f.wage = W;
    f.target = f.workers.length;
    const site = findSite(s, 'house', t);
    const owners = ownersOf[t];
    const ownerId = owners.length ? owners[owners.length - 1] : -1;
    if (site && ownerId >= 0 && f.build) {
      const b = placeBuilding(s, 'house', '', t, site.x, site.y, 'construction');
      b.owner = personRef(ownerId);
      b.rent = round3(RENT0);
      b.cost = round2(materialsValue(HOUSE_COST, P[t], W, BUILD_MARGIN));
      const pr = newProject(s, 'house', t, personRef(ownerId), f.id, `Houses in ${s.towns[t].name}`);
      const remainLabor = Math.min(HOUSE_COST.labor * 0.6, INIT_BUILDERS * BUILD_TARGET_DAYS);
      const doneShare = 1 - remainLabor / HOUSE_COST.labor;
      pr.building = b.id;
      pr.need = { ...HOUSE_COST };
      pr.done = {
        labor: round2(HOUSE_COST.labor * doneShare),
        wood: round2(HOUSE_COST.wood * doneShare),
        iron: round2(HOUSE_COST.iron * doneShare),
        tools: round2(HOUSE_COST.tools * doneShare),
      };
      pr.billed = round2(materialsValue(pr.done, P[t], W, BUILD_MARGIN));
      pr.status = 'active';
      b.project = pr.id;
      f.build.queue.push(pr.id);
      s.people[ownerId].houses.push(b.id);
      // Materials for the rest are already in the yard.
      f.inv[G.wood] = round3(HOUSE_COST.wood - pr.done.wood);
      f.inv[G.iron] = round3(HOUSE_COST.iron - pr.done.iron);
      f.inv[G.tools] = round3(HOUSE_COST.tools - pr.done.tools);
      const remainValue = materialsValue(
        { labor: HOUSE_COST.labor - pr.done.labor, wood: HOUSE_COST.wood - pr.done.wood, iron: HOUSE_COST.iron - pr.done.iron, tools: HOUSE_COST.tools - pr.done.tools },
        P[t],
        W,
        BUILD_MARGIN,
      );
      projectFunds.set(ownerId, (projectFunds.get(ownerId) ?? 0) + remainValue);
    }
    f.tools = round3(SECTORS.builder.toolsPerWorker * f.workers.length * 1.2);
    f.cash = round2(INIT_FIRM_CASH_DAYS * W * Math.max(1, f.workers.length));
    f.profit = 0;
  }

  // ---- household money, pantries, incomes ------------------------------------------------------------
  const firmProfitDay = (f: Firm) => Math.max(0, f.profit);
  const depRate = s.bank.depositRate;
  for (const p of s.people) {
    const t = p.town;
    let rentIn = 0;
    for (const hid of p.houses) {
      const b = s.buildings[hid];
      if (!b || b.status !== 'active') continue;
      for (const rid of b.residents) if (rid !== p.id) rentIn += b.rent;
    }
    let div = 0;
    for (const fid of p.owns) div += firmProfitDay(s.firms[fid]);
    const wage = p.job >= 0 ? W : 0;
    if (p.job < 0) {
      p.unempDays = Math.floor(randRange(R, 0, 50));
      p.lastWage = round3(W * randRange(R, 0.92, 1.0));
    } else {
      p.lastWage = W;
      p.tenure = Math.floor(randRange(R, 20, 2400));
    }
    // Unemployed people's income EMA is still decaying from their last job.
    const wageInc = p.job >= 0 ? wage : p.lastWage * Math.pow(0.95, p.unempDays);
    const income = wageInc + div + rentIn;
    p.income = round4(income);
    // Cash and pantry at the stationary point of the household rules for this person's
    // shopping phase (householdSteady), scaled to their own income, with a little spread.
    const owner = p.owns.length > 0 || p.houses.length > 0;
    const sim = steady[t][owner ? 1 : 0];
    const simIncome = Math.max(1e-6, (owner ? cal1.yO[t] : cal1.yW) * cal1.kappa);
    const scale = clamp(income / simIncome, 0.05, 20);
    const phase = p.id % HH_SIM_PHASES;
    const sig = INIT_CASH_SIGMA * 0.5;
    let cash = (sim.cash[phase] ?? 0) * scale * lognormal(R, Math.exp((-sig * sig) / 2), sig);
    if (owner) cash = Math.min(cash, bufferTarget(income, depRate, INIT_UNEMPLOYMENT) + INIT_OWNER_CASH_DAYS * W);
    cash += projectFunds.get(p.id) ?? 0;
    p.cash = round2(Math.max(0, cash));
    const pan = sim.pantry[phase] ?? new Array(N_GOODS).fill(0);
    for (const g of CONSUMER_GOODS) p.pantry[g] = round3(Math.max(0, pan[g] * (g === G.furniture ? scale : 1)));
    p.joy = round3(clamp(sim.joy, 0, 1));
    p.foodSat = 1;
    p.heatSat = 1;
  }

  // ---- loans --------------------------------------------------------------------------------------------
  const producers = firmPlan.map((fp) => fp.firm).filter((f) => SECTORS[f.sector].producer);
  const nLoans = Math.round(producers.length * INIT_LOAN_SHARE);
  const borrowers = shuffle(R, producers.slice()).slice(0, nLoans);
  for (const f of borrowers) {
    const b = s.buildings[f.building];
    const capital = (b ? b.cost : 0) + f.tools * P[f.town][G.tools];
    const left = Math.round(INIT_LOAN_TERM * randRange(R, INIT_LOAN_LEFT_MIN, 1));
    const lev = INIT_LOAN_TO_CAPITAL * randRange(R, 0.6, 1);
    const spread = round4(BANK_RISK_PREMIUM * lev * lev);
    const rate = s.bank.baseRate + spread;
    let principal = lev * capital;
    // Keep debt service within reach of expected profit.
    const service = (pr: number) => pr / left + (pr * rate) / DAYS_PER_YEAR;
    const cap = INIT_LOAN_MAX_SERVICE * Math.max(0, f.profit);
    if (service(principal) > cap) principal = cap / (1 / left + rate / DAYS_PER_YEAR);
    principal = Math.round(principal);
    if (principal < 200) continue;
    const loan = newLoan(s, firmRef(f.id), principal, spread, rate, INIT_LOAN_TERM, 'invest');
    loan.left = left;
    loan.start = 0;
  }

  // ---- foreign ---------------------------------------------------------------------------------------------
  const fo = s.foreign;
  for (let g = 0; g < N_GOODS; g++) {
    fo.world[g] = withForeign ? cal.world[g] : 0;
    fo.world0[g] = fo.world[g];
    fo.shipCap[g] = withForeign ? cal.shipCap[g] : 0;
  }
  let tradeVal = 0;
  if (harbor) for (let g = 0; g < N_GOODS; g++) tradeVal += (cal.imports[g] + cal.exports[g]) * P[harbor.id][g];
  fo.coin = round2(Math.max(DESK_WORKING_COIN, INIT_FOREIGN_COIN_DAYS * tradeVal * 0.5));
  (fo as { tradeEma?: number }).tradeEma = round3(tradeVal * 0.5); // daily port trade, (imports + exports) / 2

  // ---- bank, Treasury ---------------------------------------------------------------------------------------
  s.treasury.purse = INIT_PURSE;
  s.treasury.gold = INIT_TREASURY_GOLD;
  s.treasury.reserveRate = INIT_RESERVE_RATE;
  const L = loansOutstanding(s);
  const Dp = deposits(s);
  const E = Math.max(INIT_BANK_EQUITY_MIN, INIT_BANK_EQUITY_RATIO * L);
  let reserves = Dp + E - L;
  const minRes = INIT_RESERVE_MIN_SHARE * Dp;
  s.bank.windowDebt = 0;
  if (reserves < minRes) {
    s.bank.windowDebt = round2(minRes - reserves);
    reserves = minRes;
  }
  s.bank.reserves = round2(reserves);
  reconcileBank(s);

  // ---- towns' derived fields, districts ------------------------------------------------------------------
  for (const t of s.towns) updateTownRadius(s, t.id);
  computeDistricts(s);
  for (const t of s.towns) {
    const ppl = s.people.filter((p) => p.town === t.id);
    t.pop = ppl.length;
    t.employed = ppl.filter((p) => p.job >= 0).length;
    t.unemployed = t.pop - t.employed;
    t.homeless = ppl.filter((p) => p.home < 0).length;
    let vacant = 0;
    let rentSum = 0;
    let occ = 0;
    for (const b of houses[t.id]) {
      vacant += Math.max(0, b.slots - b.residents.length);
      rentSum += b.rent * b.residents.length;
      occ += b.residents.length;
    }
    t.vacantSlots = vacant;
    t.avgRent = round3(occ > 0 ? rentSum / occ : RENT0);
    t.avgWage = W;
    t.vacancies = 0;
    t.cpi = 100;
    t.health = round3(ppl.reduce((a, p) => a + p.health, 0) / Math.max(1, ppl.length));
    t.contentment = round3(ppl.reduce((a, p) => a + p.contentment, 0) / Math.max(1, ppl.length));
  }

  // ---- stats, scenario, news ----------------------------------------------------------------------------------
  const nat = new Array(N_GOODS).fill(0);
  for (let g = 0; g < N_GOODS; g++) {
    let v = 0;
    let pv = 0;
    for (let t = 0; t < NT; t++) {
      v += cal.D[t][g];
      pv += cal.D[t][g] * P[t][g];
    }
    nat[g] = round4(v > 0 ? pv / v : P[0][g]);
  }
  s.stats.basePrices = nat;
  s.stats.baseWage = W;
  s.stats.baseRent = RENT0;
  initStats(s);
  rt(s).bag.worldCalibration = { ...summarizeCalibration(cal), unplaced };
  applyScenario(s, scen.id);
  const names = s.towns.map((t) => t.name);
  news(
    s,
    `${s.settings.realmName} is founded. The market halls of ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} open their doors; the Treasury holds ${INIT_PURSE.toLocaleString('en-US')} ¤ and ${INIT_TREASURY_GOLD} oz of gold.`,
    'info',
    -1,
  );
  return s;
}

function setOwner(s: SimState, f: Firm, pid: number): void {
  f.owner = personRef(pid);
  const b = f.building >= 0 ? s.buildings[f.building] : undefined;
  if (b) b.owner = personRef(pid);
  s.people[pid].owns.push(f.id);
}

function employ(s: SimState, f: Firm, p: Person): void {
  f.workers.push(p.id);
  p.job = f.id;
  p.wage = f.wage > 0 ? f.wage : BASE_WAGE;
}

/** Compact calibration summary kept in the runtime bag (for scripts/worldinfo.ts and tests). */
export interface CalibrationSummary {
  kappa: number;
  prices: number[][];
  households: number[][];
  purchases: number[][];
  flows: FlowRec[];
  imports: number[];
  exports: number[];
  profitTown: number[];
  ownerIncome: number[];
  workerIncome: number;
  /** Planned firms that found no site ("sector@town"); normally empty. */
  unplaced?: string[];
}

function summarizeCalibration(cal: Cal): CalibrationSummary {
  return {
    kappa: cal.kappa,
    prices: cal.P.map((r) => r.slice()),
    households: cal.HH.map((r) => r.slice()),
    purchases: cal.D.map((r) => r.slice()),
    flows: cal.flows.map((f) => ({ ...f })),
    imports: cal.imports.slice(),
    exports: cal.exports.slice(),
    profitTown: cal.profitTown.slice(),
    ownerIncome: cal.yO.slice(),
    workerIncome: cal.yW,
  };
}

/** The calibration summary of a world created in this session (undefined after a load). */
export function calibrationOf(s: SimState): CalibrationSummary | undefined {
  return rt(s).bag.worldCalibration as CalibrationSummary | undefined;
}

function round2(x: number): number {
  return Math.round(fin(x) * 100) / 100;
}
function round3(x: number): number {
  return Math.round(fin(x) * 1000) / 1000;
}
function round4(x: number): number {
  return Math.round(fin(x) * 10000) / 10000;
}
