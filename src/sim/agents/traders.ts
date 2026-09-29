// ============================================================================
// Trading houses: inter-town arbitrage by wagon. OWNER: finance-trade agent.
// See DESIGN §3.4. Routes & travel times from world/paths.routeBetweenTowns.
//
// A trader is a firm (sector 'trader') with firm.trade state. Its capital is its
// wagons: wagons = floor(tools / TOOLS_PER_WAGON). Each trip needs a free wagon,
// a driver (one of its workers, away for the round trip) and oil for the road.
//
// Economics — freight is a real resource cost:
//   trip cost per wagon = driver wage × round-trip days
//                       + oil price × OIL_PER_TILE × tiles        (burnt on the loaded leg)
//                       + WAGON_WEAR_DAY × round-trip days × tools price
//                       + the wagon's capital cost (idle wear + interest) while away
//   freight per unit    = trip cost / WAGON_CAPACITY           (full wagon)
// so dearer oil (scarcity or an oil levy), dearer labour, or slower roads all
// raise freight, and paving a road cuts it (fewer days on the road).
// Every day each trader compares expected prices at home with every other town:
//   margin = p̂_dest·(1 − dest seller levies)·(1 − spoilage en route)
//          − p̂_home·(1 + home buyer levies) − freight − shipment levies − min margin
// and bids at home up to break-even (tag = destination). Its own buying raises the
// home price and its selling lowers the destination price, so arbitrage narrows
// price gaps between towns down to the cost of moving goods — the law of one price
// net of transport costs. How much it ships is capped by what the destination can
// absorb — read off yesterday's order book there (TRADE_CURVE_SHARE of the demand
// other sellers leave unmet at the break-even price, or TRADE_DEST_ABSORB × volume +
// shortage), less stock already there or on the way — and by any shipment quota.
// Fuel is a derived demand: a house pays for oil at most what its best trip can bear.
//
// Home stock (goods bought for a trip, not yet loaded) lives in firm.inv, with its
// average cost in trade.basis[home] and waiting time in trade.age[home]; stock in
// other towns lives in trade.stock[town] and is sold there by an ask ladder that
// drifts down (to below landed cost) as the stock ages.
//
// A house prices what it uses (fuel, wagons) and what it sells at its own expected prices
// (markets.expectedGrossFor / expectedNetFor): a sale rule aimed at trading houses
// (levies.isTargetedSale — e.g. a share of the price of the oil they buy) enters their trip
// cost, their fuel and wagon bids and the net price they expect at a destination. Merchandise
// is bought for resale: buyer-side rules do not apply to it (OrderOpts.resale), so it is
// priced at the market's. Without such rules all of these are the market's prices.
//
// Treasury freight lines (policy/lines.ts) are a second carrier on their road: for a trip
// between a line's towns the house also plans the load on the line at its fare per unit
// (planLine; room today from lineOffer), carries the rest in its own wagons if that still
// pays (afterLine + planRoute), and takes whichever plan earns more — against nothing when
// none of its own wagons, drivers or fuel is free. The lowest freight a unit can bear
// (pre-check, destination floor, home-supply cap) is then the lesser of its own full wagon
// and the fare. Line loads need no wagon, driver or fuel of the house's; at dispatch
// (dispatchOnLine) it pays the fare to the Purse and its cargo is tagged Shipment.line. The
// Treasury's own cargo rides a line first, without a fare (sendTreasuryCargo).
// ============================================================================
import * as CFG from '../config';
import { newShipment } from '../factory';
import { G, GOODS, N_GOODS } from '../goods';
import { pay } from '../ledger';
import { addAsk, addBid, bookFor, expectedGross, expectedGrossFor, expectedNetFor, marketOf, type Books } from '../market/markets';
import { chargeLevy, employerWageCost, levyAmount, saleWedgeInto, targetedExtrasFor, type Extras, type LevyCtx } from '../policy/levies';
import { noteBinding, priceBounds, quota } from '../policy/limits';
import { askLine, clearLineReservations, costPerUnit, lineById, lineOffer, lineRoom, noteFare, reserveLine, serves, type LineOffer } from '../policy/lines';
import { rt, type Route } from '../runtime';
import { FIRM_BASE, STATE } from '../types';
import type { ActionResult, Firm, GoodId, Order, Ref, Sector, Shipment, SimState, TownId, TraderState, Wedge } from '../types';
import { clamp, ema, fin } from '../util';
import { routeBetweenTowns } from '../world/paths';
import { debtOf, quoted, quoteRate, requestLoan } from './bank';
import { fairPrice } from './firms';
import { FLOW_IN, FLOW_USED, noteFlow } from '../stats/flows';

const {
  SESSION_TIMES,
  WAGON_CAPACITY,
  OIL_PER_TILE,
  TOOLS_PER_WAGON,
  WAGON_WEAR_DAY,
  TRADE_MIN_MARGIN_PCT,
  TRADE_MIN_MARGIN_ABS,
  TRADE_DEST_ABSORB,
  STOCK_AGE_DISCOUNT_DAYS,
  TRADE_PENDING_DAYS,
  TRADE_PENDING_DAYS_DURABLE,
  TRADE_MIN_ABSORB,
  TRADE_CURVE_SHARE,
  TRADE_FAIR_MULT,
  TRADE_SUPPLY_VOL_MULT,
  TRADE_AGE_CUT_DAY,
  TRADE_AGE_MAX_CUT,
  TRADE_HOLD_DAYS,
  TRADE_MIN_LOAD,
  TRADE_HOME_SELL_DAYS,
  TRADE_MAX_ROUTE_DAYS,
  TRADE_ASK_RUNGS,
  TRADE_ASK_WEIGHTS,
  TRADE_AGE_MAX_DISCOUNT,
  TRADER_OIL_TRIPS,
  TRADER_FUEL_DAYS,
  TRADER_OIL_BID_MULT,
  TRADER_OIL_BID_EXTRA,
  TRADER_USE_EMA,
  TRADER_DRIVER_SLACK,
  TRADER_WAGON_SLACK,
  TRADER_WEAR_BUFFER,
  TRADER_INVEST_WAGONS_DAY,
  TRADER_TOOLS_BID_MULT,
  TRADER_CASH_RESERVE_DAYS,
  FREIGHT_EMA,
  TREASURY_FREIGHT_PREMIUM,
  TOOLS_IDLE_WEAR_DAY,
  INVEST_LOAN_TERM,
  BASE_WAGE,
  DAYS_PER_YEAR,
} = CFG;

/** Shares and price positions (0 = home price, 1 = break-even limit) of the merchandise bid ladder. */
const BID_LADDER: [number, number][] = [
  [1, 0.4],
  [0.5, 0.3],
  [0, 0.3],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bump(s: SimState, key: string, v: number): void {
  if (!v || !Number.isFinite(v)) return;
  const acc = s.stats.acc;
  acc[key] = (acc[key] || 0) + v;
}

function hasLevy(s: SimState, base: string): boolean {
  const ls = s.policy.levies;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (l.enabled && l.base === base && l.rate > 0 && (l.until < 0 || s.day <= l.until)) return true;
  }
  return false;
}

function isTrader(f: Firm | undefined): f is Firm & { trade: TraderState } {
  return !!f && f.alive && f.sector === 'trader' && !!f.trade;
}

/** Keep a trader's grids the right size (towns may be added by a scenario) and its fields finite. */
function ensureGrids(s: SimState, tr: TraderState): void {
  const nT = s.towns.length;
  for (const key of ['stock', 'basis', 'age'] as const) {
    const grid = tr[key];
    for (let t = grid.length; t < nT; t++) grid.push(new Array(N_GOODS).fill(0));
  }
  if (!Array.isArray(tr.busy)) tr.busy = [];
  if (!Number.isFinite(tr.wantEma)) tr.wantEma = tr.busy.length; // saves from before this field existed
  if (!Number.isFinite(tr.freightEma)) tr.freightEma = 0;
}

/** Route a→b if it is usable by wagons (reachable, not absurdly slow). */
function usableRoute(s: SimState, a: TownId, b: TownId): Route | null {
  if (a === b || a < 0 || b < 0 || a >= s.towns.length || b >= s.towns.length) return null;
  const r = routeBetweenTowns(s, a, b);
  if (!r || !(r.length > 0) || !(r.days > 0) || !Number.isFinite(r.days) || r.days > TRADE_MAX_ROUTE_DAYS) return null;
  return r;
}

/**
 * Driver cost per day used for freight: the trader's posted wage (else the town average, else
 * the founding wage) plus any employer-side wage levies — what a driver-day costs the house.
 */
function carterWage(s: SimState, town: TownId, f: Firm | undefined): number {
  const t = s.towns[town];
  const bw = fin(s.stats.baseWage);
  const w = f && f.wage > 0 && Number.isFinite(f.wage) ? f.wage : t && t.avgWage > 0 ? t.avgWage : bw > 0 ? bw : BASE_WAGE;
  return employerWageCost(s, town, 'trader', w);
}

/**
 * Cost of one wagon trip on a route (out and back), priced in the origin town (¤):
 * the driver's wage for the round trip, fuel (OIL_PER_TILE per tile, burnt on the way out —
 * DESIGN §3.4 and the world calibration count one leg), road wear and the wagon's capital
 * (idle wear + interest on its tools) for the days it is away.
 */
export function tripCost(s: SimState, from: TownId, r: Route, wage: number, who?: Ref | Sector): number {
  const days2 = 2 * r.days;
  // Oil and wagons at the house's own prices (`who`: the house, or the trade) when given.
  const oil = who === undefined ? expectedGross(s, from, G.oil) : expectedGrossFor(s, from, G.oil, who);
  const tools = who === undefined ? expectedGross(s, from, G.tools) : expectedGrossFor(s, from, G.tools, who);
  const capital = TOOLS_PER_WAGON * tools * (TOOLS_IDLE_WEAR_DAY + Math.max(0, fin(s.bank.baseRate)) / DAYS_PER_YEAR) * days2;
  return fin(wage * days2 + oil * tripFuel(r) + WAGON_WEAR_DAY * days2 * tools + capital);
}

/** Oil burnt by one wagon on a trip (the loaded leg). */
function tripFuel(r: Route): number {
  return OIL_PER_TILE * r.length;
}

/** The trading house of a town (first living one), or undefined. Cached per day. */
export function traderOf(s: SimState, town: TownId): Firm | undefined {
  const bag = rt(s).bag;
  let c = bag.traderIdx as { day: number; n: number; idx: number[] } | undefined;
  if (!c || c.day !== s.day || c.n !== s.firms.length) {
    const idx = new Array(s.towns.length).fill(-1);
    for (const f of s.firms) if (isTrader(f) && f.status === 'active' && f.town >= 0 && idx[f.town] < 0) idx[f.town] = f.id;
    c = { day: s.day, n: s.firms.length, idx };
    bag.traderIdx = c;
  }
  const id = c.idx[town] ?? -1;
  const f = id >= 0 ? s.firms[id] : undefined;
  return isTrader(f) ? f : undefined;
}

/** Current freight cost per unit from town a to b (¤, full wagon), used by traders and the shipping index. */
export function freightPerUnit(s: SimState, a: TownId, b: TownId): number {
  const r = usableRoute(s, a, b);
  if (!r) return a === b ? 0 : -1;
  const f = traderOf(s, a);
  return tripCost(s, a, r, carterWage(s, a, f), f ? FIRM_BASE + f.id : 'trader') / WAGON_CAPACITY;
}

/** Share of a good that survives `days` of storage/travel. */
function keepFactor(g: GoodId, days: number): number {
  const sp = GOODS[g].spoil;
  return sp > 0 ? Math.pow(1 - sp, Math.max(0, days)) : 1;
}

/** Merge `q` units at unit cost `cost` into a (qty, basis, age) cell. */
function mergeBasis(tr: TraderState, town: TownId, g: GoodId, oldQty: number, q: number, cost: number): void {
  const tot = oldQty + q;
  if (!(tot > 1e-12)) return;
  const b0 = oldQty > 0 ? fin(tr.basis[town][g]) : 0;
  tr.basis[town][g] = fin((b0 * Math.max(0, oldQty) + cost * q) / tot);
  tr.age[town][g] = fin((fin(tr.age[town][g]) * Math.max(0, oldQty)) / tot);
}

// ---------------------------------------------------------------------------
// Daily scratch (runtime; rebuilt every day, never serialised)
// ---------------------------------------------------------------------------

/** One good of a planned trip. */
interface TripItem {
  good: GoodId;
  homeUse: number; // units of existing home stock committed to this trip
  orders: Order[]; // merchandise bids (ladder)
}

/** A planned trip to one destination: every good bound there shares the wagons (mixed loads). */
interface PlannedTrip {
  firm: number;
  dest: TownId;
  items: TripItem[];
  /** Treasury freight line carrying the trip (its id), or −1: the house's own wagons. */
  line: number;
  fare: number; // ¤ per unit on the line
}

interface TraderScratch {
  day: number;
  trips: PlannedTrip[];
  fuel: Order[]; // oil bids (fuel), by firm
  tools: Order[]; // wagon (tools) bids
  toolsPlan: Record<number, [number, number]>; // firm id → [qty, limit] set in tradersBeginDay
  pend: number[]; // [town * N_GOODS + good]: traders' stock there + in transit
  stockAt: number[]; // [town * N_GOODS + good]: traders' stock there (offered in that market)
  shipped: Record<string, number>; // quota bookkeeping: `${g}>${from}>${to}` → units dispatched today
}

function scratch(s: SimState): TraderScratch {
  const bag = rt(s).bag;
  let c = bag.traders as TraderScratch | undefined;
  if (!c) {
    c = { day: -1, trips: [], fuel: [], tools: [], toolsPlan: {}, pend: [], stockAt: [], shipped: {} };
    bag.traders = c;
  }
  if (c.day !== s.day) {
    c.day = s.day;
    c.trips.length = 0;
    c.fuel.length = 0;
    c.tools.length = 0;
    c.toolsPlan = {};
    c.shipped = {};
  }
  return c;
}

// ---------------------------------------------------------------------------
// Morning
// ---------------------------------------------------------------------------

/** Land a shipment at its destination. */
function deliver(s: SimState, sh: Shipment): void {
  const q = sh.qty;
  if (!(q > 0) || sh.to < 0 || sh.to >= s.towns.length) return;
  noteFlow(s, sh.to, sh.good, FLOW_IN, q); // the town brings it in (stats/flows.ts)
  if (sh.owner === STATE) {
    const tg = s.treasury.goods;
    for (let t = tg.length; t <= sh.to; t++) tg.push(new Array(N_GOODS).fill(0));
    tg[sh.to][sh.good] += q;
    bump(s, 'delivered_units', q);
    return;
  }
  const f = sh.owner >= FIRM_BASE ? s.firms[sh.owner - FIRM_BASE] : undefined;
  if (!f || !f.alive || !f.trade) {
    // Nobody left to claim the cargo: it falls to the Treasury where it lands.
    const tg = s.treasury.goods;
    for (let t = tg.length; t <= sh.to; t++) tg.push(new Array(N_GOODS).fill(0));
    tg[sh.to][sh.good] += q;
    return;
  }
  const tr = f.trade;
  ensureGrids(s, tr);
  if (sh.to === f.town) {
    mergeBasis(tr, f.town, sh.good, Math.max(0, f.inv[sh.good]), q, fin(sh.basis));
    f.inv[sh.good] += q;
  } else {
    const st = tr.stock[sh.to];
    mergeBasis(tr, sh.to, sh.good, Math.max(0, st[sh.good]), q, fin(sh.basis));
    st[sh.good] += q;
  }
  bump(s, 'delivered_units', q);
}

/**
 * Morning: shipments whose arrive ≤ day+1 are delivered (trader stock at the destination,
 * basis updated as weighted average; Treasury shipments to treasury.goods); busy wagons
 * whose return day has passed become free; stock age += 1. Trader workforce target
 * (drivers = wagons in use EMA × 1.2, ≤ wagons, ≤ capacity) and wagon investment
 * (buy tools when utilisation is high and trade is profitable) are decided here.
 * Also: wagon wear (WAGON_WEAR_DAY per wagon on the road, a little idle wear),
 * trade.wagons = floor(tools / TOOLS_PER_WAGON), and remote stock of closed traders
 * passes to the Treasury.
 */
export function tradersBeginDay(s: SimState): void {
  const c = scratch(s);
  // ---- deliveries ----
  const list = s.shipments;
  let k = 0;
  // Traders' cargo due today lands in the morning; the Treasury's lands by the market session it
  // reaches in time for (the opening's now, the rest before midday and the close: deliverTreasuryDue).
  const openAt = s.day + SESSION_TIMES[0];
  for (let i = 0; i < list.length; i++) {
    const sh = list[i];
    if (sh.owner === STATE ? sh.arrive <= openAt + 1e-9 : sh.arrive <= s.day + 1) deliver(s, sh);
    else list[k++] = sh;
  }
  list.length = k;

  for (const f of s.firms) {
    if (!f || f.sector !== 'trader' || !f.trade) continue;
    const tr = f.trade;
    ensureGrids(s, tr);
    if (!f.alive || f.status === 'closed') {
      sweepClosed(s, f, tr);
      continue;
    }
    tr.shippedToday = 0;
    // ---- wagons come home ----
    let b = 0;
    for (let i = 0; i < tr.busy.length; i++) if (tr.busy[i] > s.day) tr.busy[b++] = tr.busy[i];
    tr.busy.length = b;
    // ---- wear ----
    const wear = tr.busy.length * WAGON_WEAR_DAY + TOOLS_IDLE_WEAR_DAY * Math.max(0, f.tools);
    f.tools = Math.max(0, fin(f.tools) - wear);
    tr.wagons = Math.floor(f.tools / TOOLS_PER_WAGON + 1e-9);
    // ---- stock ages ----
    for (let t = 0; t < tr.stock.length; t++) {
      const st = t === f.town ? f.inv : tr.stock[t];
      const ag = tr.age[t];
      for (let g = 0; g < N_GOODS; g++) {
        if (st[g] > 1e-9) ag[g] += 1;
        else {
          if (t !== f.town) st[g] = 0;
          ag[g] = 0;
        }
      }
    }
    if (f.status !== 'active') continue;
    planFleet(s, f, tr, c);
  }
}

/** The Treasury's cargo that has arrived by `until` (a day's fraction: a market session) lands now. */
export function deliverTreasuryDue(s: SimState, until: number): void {
  const list = s.shipments;
  let k = 0;
  for (let i = 0; i < list.length; i++) {
    const sh = list[i];
    if (sh.owner === STATE && sh.arrive <= until + 1e-9) deliver(s, sh);
    else list[k++] = sh;
  }
  list.length = k;
}

/** A closed trader's goods in other towns pass to the Treasury (goods are never destroyed silently). */
function sweepClosed(s: SimState, f: Firm, tr: TraderState): void {
  const tg = s.treasury.goods;
  for (let t = 0; t < tr.stock.length; t++) {
    if (t === f.town || t >= tg.length) continue;
    const st = tr.stock[t];
    for (let g = 0; g < N_GOODS; g++) {
      if (st[g] > 0) {
        tg[t][g] += st[g];
        st[g] = 0;
      }
    }
  }
}

/** Drivers to employ and wagons to buy, from the EMA of wagons wanted on the road. */
function planFleet(s: SimState, f: Firm, tr: TraderState, c: TraderScratch): void {
  // A brand-new house starts expecting to use half its fleet (so it hires drivers at once).
  if (!(tr.wantEma > 0) && s.day <= f.founded + 1 && tr.wagons > 0) tr.wantEma = 0.5 * tr.wagons;
  const want = Math.max(0, fin(tr.wantEma));
  const onRoad = tr.busy.length;
  // ---- drivers ----
  let drivers = Math.ceil(want * TRADER_DRIVER_SLACK - 0.05);
  drivers = Math.min(drivers, tr.wagons);
  drivers = Math.max(drivers, onRoad, tr.wagons > 0 ? 1 : 0);
  f.target = clamp(drivers, 0, Math.max(0, f.capacity));

  // ---- wagons ----
  const young = s.day - f.founded < 60;
  const profitable = fin(f.profit) > 0 || young;
  let desired = Math.ceil(want * TRADER_WAGON_SLACK - 0.05);
  if (!profitable) desired = Math.min(desired, tr.wagons);
  // Lightly used fleets let one wagon wear out rather than replacing it.
  if (tr.wagons > 1 && want < 0.5 * tr.wagons) desired = Math.min(desired, tr.wagons - 1);
  desired = clamp(desired, 0, Math.max(1, f.capacity));
  if (desired <= 0) return;
  const toolsWanted = (desired + TRADER_WEAR_BUFFER) * TOOLS_PER_WAGON;
  const gap = toolsWanted - Math.max(0, f.tools);
  if (!(gap > 0.05)) return;
  const qty = Math.min(gap, TRADER_INVEST_WAGONS_DAY * TOOLS_PER_WAGON);
  const limit = expectedGrossFor(s, f.town, G.tools, FIRM_BASE + f.id) * TRADER_TOOLS_BID_MULT;
  c.toolsPlan[f.id] = [qty, limit];
  // Finance the fleet with an investment loan when short of cash (throttled).
  const cost = qty * limit;
  const reserve = TRADER_CASH_RESERVE_DAYS * carterWage(s, f.town, f) * Math.max(1, f.workers.length);
  if (profitable && !young && f.cash < cost + reserve && (s.day + f.id) % 10 === 0) {
    const ref = FIRM_BASE + f.id;
    const ask = Math.max(cost, gap * limit);
    if (debtOf(s, ref) < 4 * ask && quoted(quoteRate(s, ref, ask))) {
      requestLoan(s, { borrower: ref, amount: ask, term: INVEST_LOAN_TERM, purpose: 'invest', project: -1 });
    }
  }
}

// ---------------------------------------------------------------------------
// Market phase
// ---------------------------------------------------------------------------

/** A good that could go to a destination. */
interface Item {
  good: GoodId;
  qty: number; // units available to load (new purchases + merchandise waiting at home)
  qNew: number; // of which new purchases (the destination's allowance)
  pBuy: number; // expected gross price at home
  pSell: number; // expected net price at the destination
  keep: number; // share surviving the trip (perishables)
  minM: number; // minimum margin per unit
  levyU: number; // shipment levies per unit
  load: number; // set by settleRoute: units planned on this trip
  limit: number; // set by settleRoute: break-even bid at the route's freight
}

/** A destination with the goods that pay to send there; they share the wagons (mixed loads). */
interface Opp {
  dest: TownId;
  r: Route;
  trip: number; // cost of one wagon's round trip
  items: Item[];
  load: number; // units loaded
  wagons: number; // wagons the load needs
  profit: number; // Σ (limit − pBuy) × load
  score: number; // profit per wagon-day
  /** A Treasury freight line carries the load (its id; it needs none of the house's wagons), or −1. */
  line: number;
  fare: number; // ¤ per unit on the line
}

const _ctx: LevyCtx = {};

function wagonsFor(q: number): number {
  return Math.max(1, Math.ceil(q / WAGON_CAPACITY - 1e-9));
}

/** Unit margin of an item before freight. */
function itemMargin(it: Item): number {
  return it.pSell * it.keep - it.levyU - it.minM - it.pBuy;
}

/**
 * Settle a route's load within `cap` units: goods with the best margin before freight load
 * first; freight (whole wagons: a part-full wagon costs as much as a full one) is shared
 * over the whole load, and goods whose margin does not cover their share are dropped until
 * the rest pays. A load of durables only may wait TRADE_HOLD_DAYS at home for company, so its
 * freight is judged at that fuller load (DESIGN §3.4: freight = trip cost / load).
 * Returns a fresh plan (items copied), load 0 when nothing pays.
 */
function settleRoute(o: Opp, cap: number): Opp {
  let items = o.items.filter((it) => it.qty > 0.5 && itemMargin(it) > 0).map((it) => ({ ...it }));
  items.sort((a, b) => itemMargin(b) - itemMargin(a));
  const out: Opp = { ...o, items: [], load: 0, wagons: 0, profit: 0, score: 0 };
  for (let iter = 0; iter < 12 && items.length; iter++) {
    let left = cap;
    let load = 0;
    let durable = true;
    let newDur = 0;
    for (const it of items) {
      it.load = Math.max(0, Math.min(it.qty, left));
      left -= it.load;
      load += it.load;
      if (GOODS[it.good].spoil > 0) durable = false;
      else newDur += Math.min(it.load, it.qNew);
    }
    if (!(load > 0.5)) break;
    const eff = durable ? Math.max(load, Math.min(WAGON_CAPACITY, load + newDur * TRADE_HOLD_DAYS)) : load;
    const wag = wagonsFor(eff);
    const fu = (o.trip * wag) / Math.max(1e-9, eff);
    const pays = items.filter((it) => it.load > 0.5 && itemMargin(it) - fu > it.pBuy * 0.005);
    if (pays.length === items.length) {
      let profit = 0;
      for (const it of items) {
        it.limit = it.pSell * it.keep - it.levyU - it.minM - fu;
        profit += (it.limit - it.pBuy) * it.load;
      }
      out.items = items;
      out.load = load;
      out.wagons = wagonsFor(load);
      out.profit = profit;
      out.score = profit / (wag * 2 * Math.max(0.05, o.r.days));
      return out;
    }
    items = pays;
  }
  return out;
}

/** The better of the route's full load and a load trimmed to whole wagons (a last part-full wagon may not pay). */
function planRoute(o: Opp, cap: number): Opp {
  const a = settleRoute(o, cap);
  const whole = Math.floor(Math.min(cap, a.load > 0 ? a.load : cap) / WAGON_CAPACITY) * WAGON_CAPACITY;
  if (whole >= WAGON_CAPACITY && (a.load <= 0 || whole < a.load - 0.5)) {
    const b = settleRoute(o, whole);
    if (b.profit > a.profit) return b;
  }
  return a;
}

/**
 * A route's load on a Treasury freight line, within `cap` units: the fare is paid per unit
 * (the line's wagons are shared, so a part load costs no more a unit than a full one); goods
 * whose margin before freight covers the fare load best-margin first. Items copied; load 0
 * when nothing pays.
 */
function planLine(o: Opp, lo: LineOffer, cap: number): Opp {
  const fare = lo.fare;
  const items = o.items.filter((it) => it.qty > 0.5 && itemMargin(it) - fare > it.pBuy * 0.005).map((it) => ({ ...it }));
  items.sort((a, b) => itemMargin(b) - itemMargin(a));
  let left = cap;
  let load = 0;
  let profit = 0;
  const kept: Item[] = [];
  for (const it of items) {
    it.load = Math.max(0, Math.min(it.qty, left));
    if (!(it.load > 0.5)) continue;
    left -= it.load;
    load += it.load;
    it.limit = it.pSell * it.keep - it.levyU - it.minM - fare;
    profit += (it.limit - it.pBuy) * it.load;
    kept.push(it);
  }
  // Line loads need none of the house's wagons: they are planned first.
  return { ...o, items: kept, load, wagons: 0, profit, score: 1e9 + profit, line: lo.line.id, fare };
}

/** The route's goods left once `lp` (a line load) has taken its share: its home stock first, then new purchases. */
function afterLine(o: Opp, lp: Opp): Opp {
  const rest: Item[] = [];
  for (const it of o.items) {
    const used = lp.items.find((x) => x.good === it.good)?.load ?? 0;
    if (!(used > 0)) {
      rest.push(it);
      continue;
    }
    const home = Math.max(0, it.qty - it.qNew);
    const qty = it.qty - used;
    if (!(qty > 0.5)) continue;
    rest.push({ ...it, qty, qNew: Math.max(0, it.qNew - Math.max(0, used - home)) });
  }
  return { ...o, items: rest };
}

/** Cumulative quantity of a curve snapshot side at prices ≥ p (bids, descending) or ≤ p (asks, ascending). */
function curveCum(flat: readonly number[], p: number, bids: boolean): number {
  let cum = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const price = flat[i];
    if (bids ? price >= p : price <= p) cum = flat[i + 1];
    else break;
  }
  return cum;
}

/**
 * Daily allowance for new purchases bound for a destination (units):
 *   max(TRADE_DEST_ABSORB × (volume EMA + shortage),
 *       TRADE_CURVE_SHARE × (demand at the break-even price − other sellers' supply there))
 * read from the destination's order-book snapshot of yesterday, less stock already there
 * or on the way beyond (travel days + TRADE_PENDING_DAYS) days of the allowance.
 */
function room(s: SimState, pend: number[], stockAt: number[], dest: TownId, g: GoodId, days: number, floorNet: number): number {
  const m = marketOf(s, dest, g);
  const k = dest * N_GOODS + g;
  let daily = TRADE_DEST_ABSORB * (Math.max(0, fin(m.volEma)) + Math.max(0, fin(m.shortage)));
  const c = m.curve;
  if (c && c.bids.length >= 2 && floorNet > 0) {
    const w = c.wedge;
    const floorBase = (floorNet + (w.sUnit || 0)) / Math.max(0.05, 1 - (w.sPct || 0));
    const demand = curveCum(c.bids, floorBase, true);
    const others = Math.max(0, curveCum(c.asks, floorBase, false) - (stockAt[k] || 0));
    daily = Math.max(daily, TRADE_CURVE_SHARE * Math.max(0, demand - others));
  }
  daily = Math.max(TRADE_MIN_ABSORB, fin(daily));
  // Durables keep a shop's worth of stock at the destination (TRADE_PENDING_DAYS_DURABLE): they
  // do not rot, households buy them in lumps, and they travel in part-full wagons only every
  // few days — a two-day pipeline would leave the town without any most of the week.
  const hold = GOODS[g].spoil > 0 ? TRADE_PENDING_DAYS : TRADE_PENDING_DAYS_DURABLE;
  return Math.max(0, Math.min(daily, daily * (days + hold) - (pend[k] || 0)));
}

const _w: Wedge = { bPct: 0, bUnit: 0, sPct: 0, sUnit: 0 };

/**
 * Units the home market offered yesterday at a gross price up to `limitGross` (the asks of its
 * order-book snapshot), at least TRADE_MIN_ABSORB; without a snapshot, TRADE_SUPPLY_VOL_MULT ×
 * its traded volume.
 */
function homeSupply(s: SimState, home: TownId, g: GoodId, limitGross: number): number {
  const m = marketOf(s, home, g);
  const c = m.curve;
  if (!c || !(limitGross > 0)) return Math.max(TRADE_MIN_ABSORB, TRADE_SUPPLY_VOL_MULT * Math.max(0, fin(m.volEma)));
  const w = c.wedge;
  const base = (limitGross - (w.bUnit || 0)) / Math.max(0.05, 1 + (w.bPct || 0));
  return Math.max(TRADE_MIN_ABSORB, curveCum(c.asks, base, false));
}

/**
 * Net price a seller can expect at `dest` for about `q` more units: the market reference
 * price, or — when buyers went unserved there yesterday (a stale reference, e.g. nobody was
 * selling) — the bid of the marginal unserved buyer on yesterday's demand curve, capped by
 * any legal price ceiling.
 */
function destPrice(s: SimState, dest: TownId, g: GoodId, q: number, who: Ref): number {
  const ref = expectedNetFor(s, dest, g, who);
  const m = marketOf(s, dest, g);
  const c = m.curve;
  if (!(m.shortage > 0.5) || !c || c.bids.length < 2) return ref;
  const target = Math.max(0, fin(m.volume)) + Math.min(Math.max(1, q), m.shortage);
  let pb = -1;
  for (let i = 0; i + 1 < c.bids.length; i += 2) {
    if (c.bids[i + 1] >= target) {
      pb = c.bids[i];
      break;
    }
  }
  if (!(pb > 0)) return ref;
  if (s.policy.limits.length) {
    const ceil = priceBounds(s, dest, g).max;
    if (ceil >= 0 && pb > ceil) pb = ceil;
  }
  const w = saleWedgeInto(s, dest, g, _w);
  const x = targetedExtrasFor(s, dest, g, 'seller', who, _xs);
  return Math.max(ref, pb * (1 - w.sPct - x.pct) - w.sUnit - x.unit);
}

const _xs: Extras = { pct: 0, unit: 0 };

/** Shipment levies per unit on `q` units of a good bought at `pBuy` sent home → dest. */
function shipLevyUnit(s: SimState, home: TownId, dest: TownId, g: GoodId, pBuy: number, q: number): number {
  _ctx.town = home;
  _ctx.toTown = dest;
  _ctx.good = g;
  return levyAmount(s, 'shipment', 'owner', _ctx, pBuy * Math.max(1, q), Math.max(1, q)) / Math.max(1, q);
}

function quotaKey(g: GoodId, from: TownId, to: TownId): string {
  return g + '>' + from + '>' + to;
}

/** Remaining shipment quota today (units), or Infinity-like 1e12 when none applies. */
function quotaLeft(s: SimState, c: TraderScratch, g: GoodId, from: TownId, to: TownId): number {
  if (s.policy.limits.length === 0) return 1e12;
  const q = quota(s, 'shipMax', g, from, to);
  if (q < 0) return 1e12;
  return Math.max(0, q - (c.shipped[quotaKey(g, from, to)] || 0));
}

/** Ask ladder for stock held in a town (net limits; floor falls below landed cost with age). */
function stockAsks(s: SimState, books: Books, ref: number, town: TownId, g: GoodId, qty: number, basis: number, age: number, dump: boolean): void {
  if (!(qty > 1e-6)) return;
  const book = bookFor(books, town, g);
  const pNet = expectedNetFor(s, town, g, ref);
  if (dump) {
    addAsk(book, ref, pNet * 0.5, qty);
    return;
  }
  const spoil = GOODS[g].spoil;
  // Average age ≈ days of inventory on hand (Little's law): stock that is not moving is
  // offered cheaper, and the floor sinks below landed cost with time. Perishables age faster.
  const ageEff = spoil > 0 ? age + 1 + 10 * spoil * (age + 1) : age;
  const cut = clamp((ageEff - 1) * TRADE_AGE_CUT_DAY, 0, TRADE_AGE_MAX_CUT);
  // After 2×STOCK_AGE_DISCOUNT_DAYS the landed cost is treated as sunk: the floor falls away.
  const disc =
    TRADE_AGE_MAX_DISCOUNT * clamp(ageEff / STOCK_AGE_DISCOUNT_DAYS, 0, 1) +
    (0.95 - TRADE_AGE_MAX_DISCOUNT) * clamp((ageEff - 2 * STOCK_AGE_DISCOUNT_DAYS) / STOCK_AGE_DISCOUNT_DAYS, 0, 1);
  const floor = Math.max(0, fin(basis)) * (1 - disc);
  // Carters compete: stock is offered at no more than its landed cost plus the minimum margin,
  // so a destination whose price runs above the landed cost is undercut down to it (competitive
  // arbitrage). Pricing at the destination's going rate instead would let the gap persist as a
  // rent for the carter, with the stock that does not sell there slowly ageing down.
  const b = Math.max(0, fin(basis));
  const comp = b > 0 ? b * (1 + TRADE_MIN_MARGIN_PCT) + TRADE_MIN_MARGIN_ABS : pNet;
  const pRef = Math.min(pNet, comp);
  for (let i = 0; i < TRADE_ASK_RUNGS.length; i++) {
    const q = qty * TRADE_ASK_WEIGHTS[i];
    if (q > 1e-6) addAsk(book, ref, Math.max(floor, pRef * TRADE_ASK_RUNGS[i] * (1 - cut)), q);
  }
}

/** Mean oil burnt by one wagon's round trip over a town's usable routes (0 if none). */
function tripsFuelMean(s: SimState, home: TownId): number {
  let n = 0;
  let sum = 0;
  for (let d = 0; d < s.towns.length; d++) {
    const r = usableRoute(s, home, d);
    if (!r) continue;
    n++;
    sum += tripFuel(r);
  }
  return n ? sum / n : 0;
}

/** Mean one-way travel days over a town's usable routes (0 if none). */
function routeDaysMean(s: SimState, home: TownId): number {
  let n = 0;
  let sum = 0;
  for (let d = 0; d < s.towns.length; d++) {
    const r = usableRoute(s, home, d);
    if (!r) continue;
    n++;
    sum += r.days;
  }
  return n ? sum / n : 0;
}

/**
 * Fuel the trader wants on hand (oil units): TRADER_FUEL_DAYS of expected use (wagons it
 * wants on the road × fuel per trip ÷ round-trip days), at least TRADER_OIL_TRIPS trips.
 */
function fuelTarget(s: SimState, f: Firm, tr: TraderState): number {
  const fuel = tripsFuelMean(s, f.town);
  if (!(fuel > 0)) return 0;
  const days2 = Math.max(0.5, 2 * routeDaysMean(s, f.town));
  const daily = (Math.max(0, fin(tr.wantEma)) * fuel) / days2;
  return Math.max(TRADER_OIL_TRIPS * fuel, TRADER_FUEL_DAYS * daily);
}

/**
 * What oil is fundamentally worth at home: the home market price, or — if that has run
 * above it (a town without wells whose price went stale) — the landed cost from the
 * cheapest town where oil actually trades (its price + freight).
 */
function oilAnchor(s: SimState, home: TownId, who: Ref): number {
  let best = expectedGrossFor(s, home, G.oil, who);
  for (let t = 0; t < s.towns.length; t++) {
    if (t === home) continue;
    const m = marketOf(s, t, G.oil);
    if (!(m.volEma > 1)) continue;
    const fr = freightPerUnit(s, t, home);
    if (!(fr >= 0)) continue;
    const landed = expectedGrossFor(s, t, G.oil, who) + fr;
    if (landed < best) best = landed;
  }
  return best;
}

/**
 * For each trader (home town h) with free wagons AND free drivers AND oil for the trip:
 * rank (good, destination) by expected margin per unit =
 *   expectedNet(dest) − expectedGross(h) − freightPerUnit(h, dest) − shipment levies
 *   − max(TRADE_MIN_MARGIN_ABS, TRADE_MIN_MARGIN_PCT·price)
 * cap each by TRADE_DEST_ABSORB × destination volume EMA (+ shortage) and any shipMax quota,
 * and bid in h's book at limit = expected dest net − freight − levies − min margin
 * (tag = destination town). Also: asks for stock held in each non-home town
 * (above landed basis, discounted with age), and an oil bid for a store of fuel
 * (TRADER_FUEL_DAYS of use; limit anchored on oil's landed value, capped by what the best
 * trip can bear). Destination demand is read from yesterday's order book there (room, destPrice).
 * Details: the dest price is discounted for spoilage en route; freight is taken at the
 * planned load (a part-full wagon costs as much as a full one); opportunities are
 * ranked by profit per wagon-day; the bid is a small ladder between the home price and
 * break-even; merchandise already waiting at home is loaded first. Also bids for tools
 * (wagons) planned in tradersBeginDay, sells home stock no route pays for, and a
 * liquidating trader dumps all its stock. stats.acc.freight_per_unit_tile = mean full-
 * load freight per unit per tile (updates trade.freightEma).
 */
export function traderOrders(s: SimState, books: Books): void {
  const c = scratch(s);
  const nT = s.towns.length;
  const pend = c.pend;
  pend.length = nT * N_GOODS;
  pend.fill(0);
  const stockAt = c.stockAt;
  stockAt.length = nT * N_GOODS;
  stockAt.fill(0);
  let nTraders = 0;
  for (const f of s.firms) {
    if (!isTrader(f) || f.status === 'closed') continue;
    nTraders++;
    const tr = f.trade;
    for (let t = 0; t < nT && t < tr.stock.length; t++) {
      if (t === f.town) continue;
      const st = tr.stock[t];
      for (let g = 0; g < N_GOODS; g++) {
        if (st[g] > 0) {
          pend[t * N_GOODS + g] += st[g];
          stockAt[t * N_GOODS + g] += st[g];
        }
      }
    }
  }
  for (const sh of s.shipments) if (sh.owner !== STATE && sh.to >= 0 && sh.to < nT) pend[sh.to * N_GOODS + sh.good] += Math.max(0, sh.qty);
  if (!nTraders) return;
  const shipLevies = s.policy.levies.length > 0 && hasLevy(s, 'shipment');
  const lines = !!s.policy.lines && s.policy.lines.length > 0;
  let freightSum = 0;
  let freightN = 0;

  for (const f of s.firms) {
    if (!isTrader(f) || f.status === 'closed') continue;
    const tr = f.trade;
    ensureGrids(s, tr);
    const home = f.town;
    const ref = FIRM_BASE + f.id;

    // ---- a liquidating trader sells everything it holds ----
    if (f.status === 'liquidating') {
      for (let t = 0; t < nT; t++) {
        const st = t === home ? f.inv : tr.stock[t];
        for (let g = 0; g < N_GOODS; g++) if (st[g] > 1e-6) stockAsks(s, books, ref, t, g, st[g], tr.basis[t][g], tr.age[t][g], true);
      }
      continue;
    }

    // ---- stock held in other towns ----
    for (let t = 0; t < nT; t++) {
      if (t === home) continue;
      const st = tr.stock[t];
      for (let g = 0; g < N_GOODS; g++) if (st[g] > 1e-6) stockAsks(s, books, ref, t, g, st[g], tr.basis[t][g], tr.age[t][g], false);
    }

    const wage = carterWage(s, home, f);
    let cash = Math.max(0, f.cash - TRADER_CASH_RESERVE_DAYS * wage * Math.max(1, f.workers.length));

    // ---- fuel (bid placed after the opportunities are known, see below) ----
    const fuelWant = fuelTarget(s, f, tr);
    const fuelHave = Math.max(0, f.inv[G.oil]);
    let fuelBid = 0;

    // ---- wagons (tools) ----
    const tp = c.toolsPlan[f.id];
    if (tp && cash > 0) {
      const q = Math.min(tp[0], cash / Math.max(1e-9, tp[1]));
      if (q > 0.01) {
        c.tools.push(addBid(bookFor(books, home, G.tools), ref, tp[1], q));
        cash -= q * tp[1];
      }
    }

    // ---- opportunities: per destination, every good that pays shares the wagons ----
    const homeStock: number[] = new Array(N_GOODS).fill(0); // merchandise waiting at home
    for (let g = 0; g < N_GOODS; g++) homeStock[g] = Math.max(0, f.inv[g] - (g === G.oil ? fuelWant : 0));
    const opps: Opp[] = [];
    let myFreight = 0;
    let myN = 0;
    // A house with no wagon (or driver, or fuel) free today weighs a freight line against nothing.
    const ownFree = Math.min(tr.wagons - tr.busy.length, f.workers.length - tr.busy.length) > 0 && fuelHave + 1e-9 >= Math.min(1, tripsFuelMean(s, home));
    for (let d = 0; d < nT; d++) {
      const r = usableRoute(s, home, d);
      if (!r) continue;
      const trip = tripCost(s, home, r, wage, ref);
      const perTile = trip / (WAGON_CAPACITY * r.length);
      myFreight += perTile;
      myN++;
      freightSum += perTile;
      freightN++;
      const keep0 = r.days + 1;
      // A Treasury freight line on this road with room today: the lowest freight a unit can bear
      // is the lesser of a full wagon of the house's own and the line's fare (policy/lines.ts).
      const lo = lines ? lineOffer(s, home, d) : null;
      const fr0 = lo && lo.room > 0.5 ? Math.min(trip / WAGON_CAPACITY, lo.fare) : trip / WAGON_CAPACITY;
      const items: Item[] = [];
      for (let g = 0; g < N_GOODS; g++) {
        const pSell = destPrice(s, d, g, WAGON_CAPACITY, ref);
        // What the good should cost at home: the market's reference, but never more than
        // TRADE_FAIR_MULT × what it costs to make there (firms.fairPrice). A home market whose
        // makers have stopped quotes a stale, drifting price; judged on it no carter would bid,
        // and without bids the makers would never learn that it pays to start again.
        // (Merchandise: market prices — buyer-side targeted rules do not apply to resale.)
        const pBuy = Math.min(expectedGross(s, home, g), TRADE_FAIR_MULT * fairPrice(s, home, g));
        if (!(pSell > 0) || !(pBuy > 0)) continue;
        const keep = keepFactor(g, keep0);
        const minM = Math.max(TRADE_MIN_MARGIN_ABS, TRADE_MIN_MARGIN_PCT * pSell);
        // Cheap pre-check at full-load freight (the lowest freight a unit can bear).
        if (pSell * keep - fr0 - minM <= pBuy) continue;
        // New purchases the destination can take, plus merchandise already waiting at home.
        const floorNet = (pBuy + fr0 + minM) / Math.max(1e-6, keep);
        // …but no more than the home market offers at the price the trip can bear: yesterday's
        // asks there (a carter cannot buy what nobody sells, and cash committed to bids that
        // cannot fill would starve the trips that can).
        let qNew = Math.min(room(s, pend, stockAt, d, g, r.days, floorNet), homeSupply(s, home, g, pSell * keep - fr0 - minM));
        let qLoad = qNew + homeStock[g];
        const ql = quotaLeft(s, c, g, home, d);
        if (ql < qLoad) {
          if (qLoad > 0.5) noteBinding(s, 'shipMax', g, home);
          qLoad = ql;
          qNew = Math.min(qNew, ql);
        }
        if (!(qLoad > 0.5)) continue;
        const levyU = shipLevies ? shipLevyUnit(s, home, d, g, pBuy, qLoad) : 0;
        items.push({ good: g, qty: qLoad, qNew, pBuy, pSell, keep, minM, levyU, load: 0, limit: 0 });
      }
      if (!items.length) continue;
      const o = planRoute({ dest: d, r, trip, items, load: 0, wagons: 0, profit: 0, score: 0, line: -1, fare: 0 }, 1e12);
      if (lo) {
        // Put on the line what fits (fare per unit), carry the rest in the house's own wagons if
        // that pays — whichever plan earns more. What would have gone on the line beyond its
        // room today is the line's unmet demand (it hires drivers for it).
        const base: Opp = { dest: d, r, trip, items, load: 0, wagons: 0, profit: 0, score: 0, line: -1, fare: 0 };
        const all = planLine(base, lo, 1e12);
        const lp = lo.room > 0.5 ? planLine(base, lo, lo.room) : null;
        const rest = lp && lp.load > 0.5 ? planRoute(afterLine(base, lp), 1e12) : null;
        const split = lp && lp.load > 0.5 ? lp.profit + (rest && rest.load > 0.5 && ownFree ? rest.profit : 0) : -Infinity;
        const ownBest = ownFree && o.load > 0.5 ? o.profit : 0;
        if (all.load > 0.5 && all.profit > ownBest) askLine(s, lo.line, Math.max(0, all.load - (lp ? lp.load : 0)));
        if (lp && split > ownBest + 1e-9) {
          opps.push(lp);
          if (rest && rest.load > 0.5) opps.push(rest);
          continue;
        }
      }
      if (o.load > 0.5) opps.push(o);
    }
    opps.sort((a, b) => b.score - a.score);

    // ---- fuel: a derived demand ----
    // The most a house will pay for oil is the price at which its best trip only just breaks
    // even (P* = oil price + that trip's margin per wagon / oil per trip). P* does not depend
    // on today's oil price, so fuel bids cannot ratchet the price up on themselves. Within that
    // cap, the emptier the store the more urgently it bids. With no trip worth making it only
    // keeps a minimal store, bidding below the market.
    if (fuelWant > fuelHave + 0.01 && cash > 0) {
      const pOil = oilAnchor(s, home, ref);
      const lack = clamp(1 - fuelHave / Math.max(1e-9, fuelWant), 0, 1);
      let lim = 0;
      const own = opps.find((x) => x.line < 0); // the best trip in the house's own wagons
      if (own) {
        const o = own;
        const tf = tripFuel(o.r);
        const perWagon = o.profit / Math.max(1, o.wagons);
        const pStar = tf > 0 ? pOil + perWagon / tf : pOil;
        lim = Math.min(pOil * (TRADER_OIL_BID_MULT + TRADER_OIL_BID_EXTRA * lack), pStar);
      } else if (lack > 0.5) lim = pOil * 0.98;
      const q = lim > 0 ? Math.min(Math.max(0.5 * (fuelWant - fuelHave), Math.min(fuelWant - fuelHave, 2 * tripsFuelMean(s, home))), cash / lim) : 0;
      if (q > 0.01) {
        c.fuel.push(addBid(bookFor(books, home, G.oil), ref, lim, q));
        cash -= q * lim;
        fuelBid = q;
      }
    }

    if (myN > 0) {
      const v = myFreight / myN;
      tr.freightEma = tr.freightEma > 0 ? ema(tr.freightEma, v, FREIGHT_EMA) : v;
    }

    // ---- allocate free wagons, drivers and fuel ----
    let wagonsLeft = Math.max(0, Math.min(tr.wagons - tr.busy.length, f.workers.length - tr.busy.length));
    // Fuel bought today only counts as far as oil actually traded at home yesterday.
    const oilM = marketOf(s, home, G.oil);
    let fuelLeft = fuelHave + Math.min(fuelBid, oilM.traded ? Math.max(0, fin(oilM.volume)) : 0);
    const avgFuel = tripsFuelMean(s, home);
    // The fleet the house can actually use today (drives the wagons-wanted signal).
    const wantCap = tr.busy.length + Math.min(Math.max(0, tr.wagons - tr.busy.length) + Math.max(2, Math.ceil(0.25 * tr.wagons)), avgFuel > 0 ? Math.floor(Math.max(fuelLeft, fuelWant) / avgFuel) : 1e9);
    let wanted = 0;
    const homeLeft = homeStock; // consumed as trips are planned
    for (const o0 of opps) {
      if (o0.line >= 0) {
        // ---- a load on a Treasury freight line: no wagon, driver or fuel of the house's own ----
        const L = lineById(s, o0.line);
        if (!L) continue;
        const trip: PlannedTrip = { firm: f.id, dest: o0.dest, items: [], line: L.id, fare: o0.fare };
        let loaded = 0;
        for (const it of o0.items) {
          const lim = it.limit;
          if (!(lim > it.pBuy * 1.005)) continue;
          let homeUse = Math.min(homeLeft[it.good], it.load);
          if (o0.fare > 0 && homeUse * o0.fare > cash) homeUse = Math.max(0, cash / o0.fare);
          let bidQ = Math.min(it.load - homeUse, it.qNew);
          const per = lim + o0.fare; // the goods and their fare
          if (homeUse * o0.fare + bidQ * per > cash) bidQ = Math.max(0, (cash - homeUse * o0.fare) / per);
          const q = homeUse + bidQ;
          if (!(q > 0.5)) continue;
          homeLeft[it.good] -= homeUse;
          const item: TripItem = { good: it.good, homeUse, orders: [] };
          if (bidQ > 0.01) {
            const book = bookFor(books, home, it.good);
            for (const [pos, share] of BID_LADDER) {
              const price = it.pBuy + pos * (lim - it.pBuy);
              item.orders.push(addBid(book, ref, price, bidQ * share, { tag: o0.dest, resale: true }));
            }
          }
          cash -= homeUse * o0.fare + bidQ * per;
          trip.items.push(item);
          loaded += q;
          pend[o0.dest * N_GOODS + it.good] += q;
        }
        if (!trip.items.length) continue;
        c.trips.push(trip);
        reserveLine(s, L, home, loaded);
        continue;
      }
      wanted += o0.wagons;
      if (wagonsLeft <= 0) continue;
      const tf = tripFuel(o0.r);
      const byFuel = tf > 0 ? Math.floor(fuelLeft / tf + 1e-9) : wagonsLeft;
      const w = Math.min(o0.wagons, wagonsLeft, byFuel);
      if (w <= 0) continue;
      // Fewer wagons than the load wants: re-plan the load for the wagons there are.
      const o = w < o0.wagons ? planRoute(o0, w * WAGON_CAPACITY) : o0;
      if (!(o.load > 0.5)) continue;
      const trip: PlannedTrip = { firm: f.id, dest: o.dest, items: [], line: -1, fare: 0 };
      let loaded = 0;
      for (const it of o.items) {
        const lim = it.limit;
        if (!(lim > it.pBuy * 1.005)) continue;
        const homeUse = Math.min(homeLeft[it.good], it.load);
        homeLeft[it.good] -= homeUse;
        let bidQ = Math.min(it.load - homeUse, it.qNew);
        if (bidQ * lim > cash) bidQ = Math.max(0, cash / lim);
        const q = homeUse + bidQ;
        if (!(q > 0.5)) continue;
        const item: TripItem = { good: it.good, homeUse, orders: [] };
        if (bidQ > 0.01) {
          const book = bookFor(books, home, it.good);
          for (const [pos, share] of BID_LADDER) {
            const price = it.pBuy + pos * (lim - it.pBuy);
            item.orders.push(addBid(book, ref, price, bidQ * share, { tag: o.dest, resale: true }));
          }
          cash -= bidQ * lim;
        }
        trip.items.push(item);
        loaded += q;
        pend[o.dest * N_GOODS + it.good] += q;
      }
      if (!trip.items.length) continue;
      c.trips.push(trip);
      const used = Math.min(w, wagonsFor(loaded));
      wagonsLeft -= used;
      fuelLeft -= used * tf;
    }
    tr.wantEma = ema(fin(tr.wantEma), Math.min(wantCap, tr.busy.length + wanted), TRADER_USE_EMA);

    // ---- home stock that is not going anywhere (no route pays, no wagon, no fuel): sell it locally ----
    for (let g = 0; g < N_GOODS; g++) {
      const q = homeLeft[g];
      if (!(q > 1e-6)) continue;
      const age = fin(tr.age[home][g]);
      if (age < (GOODS[g].spoil > 0 ? 1 : TRADE_HOME_SELL_DAYS)) continue;
      stockAsks(s, books, ref, home, g, q, tr.basis[home][g], age - TRADE_HOME_SELL_DAYS, false);
    }
  }
  // Shipping index: full-load freight per unit per tile, averaged over all traders' routes.
  if (freightN > 0) s.stats.acc.freight_per_unit_tile = freightSum / freightN;
}

/** Today's fills per trader: firm id → [filled per good, paid per good]. */
type Fills = Map<number, [number[], number[]]>;

function noteFill(fills: Fills, firm: number, g: GoodId, o: Order): void {
  if (!(o.filled > 0)) return;
  let e = fills.get(firm);
  if (!e) {
    e = [new Array(N_GOODS).fill(0), new Array(N_GOODS).fill(0)];
    fills.set(firm, e);
  }
  e[0][g] += o.filled;
  e[1][g] += Math.max(0, o.paid);
}

/** Book the day's purchases (all orders of a good together) into the trader's home stock basis. */
function bookPurchases(s: SimState, fills: Fills): void {
  for (const [id, [q, paid]] of fills) {
    const f = s.firms[id];
    if (!isTrader(f)) continue;
    for (let g = 0; g < N_GOODS; g++) {
      if (!(q[g] > 0)) continue;
      const after = Math.max(0, f.inv[g]);
      const before = Math.max(0, after - q[g]);
      mergeBasis(f.trade, f.town, g, before, q[g], paid[g] / q[g]);
    }
  }
}

/**
 * After clearing: for each planned trip (one destination, possibly several goods), load what
 * was bought plus the home stock committed to it into shared wagons (ceil(total / WAGON_CAPACITY)),
 * burn oil (OIL_PER_TILE × tiles × wagons), charge 'shipment' levies (payer 'owner'), create one
 * Shipment per good with depart = day + 0.5, arrive = depart + route.days (the trip's freight is
 * shared over its units in the landed cost), and mark the wagons busy until day + 2·route.days.
 * stats.acc: shipped_units, freight_cost. A load of durables only below TRADE_MIN_LOAD of a
 * wagon may wait at home up to TRADE_HOLD_DAYS for more. Filled wagon (tools) bids become
 * wagons (inv → firm.tools).
 */
export function tradersDispatch(s: SimState, books: Books): void {
  void books;
  const c = scratch(s);
  // ---- fuel & wagons bought today ----
  const fills: Fills = new Map();
  for (const o of c.fuel) noteFill(fills, o.ref - FIRM_BASE, G.oil, o);
  for (const o of c.tools) {
    const f = s.firms[o.ref - FIRM_BASE];
    if (!isTrader(f) || !(o.filled > 0)) continue;
    const q = Math.min(o.filled, Math.max(0, f.inv[G.tools]));
    f.inv[G.tools] -= q;
    f.tools += q;
    f.trade.wagons = Math.floor(f.tools / TOOLS_PER_WAGON + 1e-9);
  }
  // ---- merchandise purchases → home basis ----
  for (const t of c.trips) for (const it of t.items) for (const o of it.orders) noteFill(fills, t.firm, it.good, o);
  bookPurchases(s, fills);
  const shipLevies = s.policy.levies.length > 0 && hasLevy(s, 'shipment');
  const qs: number[] = [];
  // Freight lines: planned room becomes actual loads, counted from the cargo loaded below.
  if (s.policy.lines?.length) clearLineReservations(s);
  // ---- load and send ----
  for (const t of c.trips) {
    const f = s.firms[t.firm];
    if (!isTrader(f) || f.status !== 'active') continue;
    const tr = f.trade;
    const home = f.town;
    const r = usableRoute(s, home, t.dest);
    if (!r) continue;
    if (t.line >= 0) {
      dispatchOnLine(s, f, t, r, qs, shipLevies);
      continue;
    }
    const tf = tripFuel(r);
    // What each good contributes to the load.
    qs.length = 0;
    let total = 0;
    let oilQ = 0;
    let durable = true;
    let oldest = 0;
    for (const it of t.items) {
      const g = it.good;
      let filled = 0;
      for (const o of it.orders) filled += o.filled;
      let avail = Math.max(0, f.inv[g]);
      if (g === G.oil) avail = Math.max(0, avail - Math.max(tf, fuelTarget(s, f, tr))); // the fuel store is not merchandise
      const q = Math.max(0, Math.min(avail, it.homeUse + filled, quotaLeft(s, c, g, home, t.dest)));
      qs.push(q);
      if (!(q > 1e-3)) continue;
      total += q;
      if (g === G.oil) oilQ += q;
      if (GOODS[g].spoil > 0) durable = false;
      oldest = Math.max(oldest, fin(tr.age[home][g]));
    }
    if (!(total > 1e-3)) continue;
    if (durable && total < TRADE_MIN_LOAD * WAGON_CAPACITY && oldest < TRADE_HOLD_DAYS) continue; // wait for a fuller wagon
    const free = Math.max(0, Math.min(tr.wagons - tr.busy.length, f.workers.length - tr.busy.length));
    const fuelOnHand = Math.max(0, f.inv[G.oil]);
    const fuelFree = Math.max(0, fuelOnHand - oilQ);
    const byFuel = tf > 0 ? Math.floor(fuelFree / tf + 1e-9) : free;
    const w = Math.min(wagonsFor(total), free, byFuel);
    if (w <= 0) continue;
    // Not enough wagons: every good is loaded pro rata (the rest waits at home).
    const k = Math.min(1, (w * WAGON_CAPACITY) / total);
    const load = total * k;
    // fuel for the trip
    noteFlow(s, f.town, G.oil, FLOW_USED, Math.min(Math.max(0, f.inv[G.oil]), w * tf));
    f.inv[G.oil] = Math.max(0, f.inv[G.oil] - w * tf);
    bump(s, 'oil_burned', w * tf);
    const wage = carterWage(s, home, f);
    const trip = tripCost(s, home, r, wage, FIRM_BASE + f.id) * w;
    const tripU = trip / Math.max(1e-9, load);
    for (let i = 0; i < t.items.length; i++) {
      const g = t.items[i].good;
      const q = qs[i] * k;
      if (!(q > 1e-3)) continue;
      // shipment levies (payer: the owner of the goods)
      const basisHome = Math.max(0, fin(tr.basis[home][g]));
      let lev = 0;
      if (shipLevies) {
        _ctx.town = home;
        _ctx.toTown = t.dest;
        _ctx.good = g;
        lev = chargeLevy(s, 'shipment', FIRM_BASE + f.id, 'owner', _ctx, q * basisHome, q);
        f.otherCosts += lev;
      }
      const basis = basisHome + tripU + lev / q;
      f.inv[g] = Math.max(0, f.inv[g] - q);
      if (f.inv[g] <= 1e-9) tr.age[home][g] = 0;
      newShipment(s, FIRM_BASE + f.id, home, t.dest, g, q, basis, s.day + 0.5, s.day + 0.5 + r.days, (w * q) / load);
      tr.shippedToday += q;
      c.shipped[quotaKey(g, home, t.dest)] = (c.shipped[quotaKey(g, home, t.dest)] || 0) + q;
      bump(s, 'shipped_units', q);
    }
    for (let i = 0; i < w; i++) tr.busy.push(s.day + 2 * r.days);
    bump(s, 'freight_cost', trip);
    bump(s, 'wagons_sent', w);
  }
}

/**
 * Load a trip planned on a Treasury freight line: what was bought plus the home stock committed
 * to it (within the line's room left and any shipment quota), the fare paid to the Purse
 * (pay(), flow 'fare'; a house short of cash sends what its payment covers), shipment levies as
 * for any cargo, one Shipment per good tagged with the line (Shipment.line; the house keeps the
 * goods, their basis = home cost + fare + levies per unit). The line's wagons, drivers and fuel
 * are booked when its loads leave (lines.linesAfterClear).
 */
function dispatchOnLine(s: SimState, f: Firm & { trade: TraderState }, t: PlannedTrip, r: Route, qs: number[], shipLevies: boolean): void {
  const c = scratch(s);
  const tr = f.trade;
  const home = f.town;
  const L = lineById(s, t.line);
  if (!L || !serves(L, home, t.dest)) return;
  qs.length = 0;
  let total = 0;
  for (const it of t.items) {
    const g = it.good;
    let filled = 0;
    for (const o of it.orders) filled += o.filled;
    let avail = Math.max(0, f.inv[g]);
    if (g === G.oil) avail = Math.max(0, avail - fuelTarget(s, f, tr)); // the fuel store is not merchandise
    const q = Math.max(0, Math.min(avail, it.homeUse + filled, quotaLeft(s, c, g, home, t.dest)));
    qs.push(q);
    if (q > 1e-3) total += q;
  }
  if (!(total > 1e-3)) return;
  let k = Math.min(1, lineRoom(s, L, home) / total);
  const ref = FIRM_BASE + f.id;
  const fare = Math.max(0, fin(t.fare));
  let paid = 0;
  if (fare > 0 && k > 0) {
    const fee = fare * total * k;
    paid = pay(s, ref, STATE, fee, 'fare');
    if (paid < fee - 1e-9) k *= paid / fee;
    noteFare(L, paid);
    f.otherCosts += paid;
  }
  if (!(k * total > 1e-3)) return;
  for (let i = 0; i < t.items.length; i++) {
    const g = t.items[i].good;
    const q = qs[i] * k;
    if (!(q > 1e-3)) continue;
    const basisHome = Math.max(0, fin(tr.basis[home][g]));
    let lev = 0;
    if (shipLevies) {
      _ctx.town = home;
      _ctx.toTown = t.dest;
      _ctx.good = g;
      lev = chargeLevy(s, 'shipment', ref, 'owner', _ctx, q * basisHome, q);
      f.otherCosts += lev;
    }
    f.inv[g] = Math.max(0, f.inv[g] - q);
    if (f.inv[g] <= 1e-9) tr.age[home][g] = 0;
    const sh = newShipment(s, ref, home, t.dest, g, q, basisHome + fare + lev / q, s.day + 0.5, s.day + 0.5 + r.days, q / WAGON_CAPACITY);
    sh.line = L.id;
    tr.shippedToday += q;
    c.shipped[quotaKey(g, home, t.dest)] = (c.shipped[quotaKey(g, home, t.dest)] || 0) + q;
    bump(s, 'shipped_units', q);
  }
}

/**
 * Move Treasury goods between towns (paid freight from the Purse to the home trader of `from`).
 * The Treasury pays the full-wagon trip cost for the wagons it needs plus
 * TREASURY_FREIGHT_PREMIUM (pay STATE → trader, flow 'freight'); the trader's free wagons
 * and fuel are used where available (hired carts otherwise). Treasury cargo is exempt from
 * shipment levies and quotas. Arrives in treasury.goods[to].
 */
export function shipTreasuryGoods(s: SimState, from: TownId, to: TownId, good: GoodId, qty: number): ActionResult {
  const r = sendTreasuryCargo(s, from, to, good, qty);
  return r.ok ? { ok: true, message: r.message, id: r.id } : { ok: false, message: r.message };
}

/** Outcome of sendTreasuryCargo: the ActionResult plus what was loaded and the freight paid. */
export interface CargoResult extends ActionResult {
  qty: number; // units loaded (0 on failure)
  paid: number; // ¤ freight paid to the trading house
  days: number; // travel days (whole, ≥ 1)
}

/**
 * shipTreasuryGoods with the details: loads min(qty, holdings) of the Treasury's `good` in
 * `from` and sends it to `to`. `unitCost` (¤/unit, default 0) is what the goods cost the
 * Treasury before carriage: the shipment's basis (landed cost per unit) is unitCost + freight
 * per unit. `order` tags the cargo with the carry rule that loads it (Shipment.order, default −1).
 * Fails (nothing moves, nothing is paid) without a usable road, a trading house in `from`, or —
 * with auto-mint off — a Purse that covers the freight.
 */
export function sendTreasuryCargo(s: SimState, from: TownId, to: TownId, good: GoodId, qty: number, opts?: { unitCost?: number; order?: number; depart?: number }): CargoResult {
  const no = (message: string): CargoResult => ({ ok: false, message, qty: 0, paid: 0, days: 0 });
  const nT = s.towns.length;
  if (!(from >= 0 && from < nT) || !(to >= 0 && to < nT)) return no('Unknown town.');
  if (from === to) return no('Choose two different towns.');
  if (!(good >= 0 && good < N_GOODS)) return no('Unknown good.');
  if (!(qty > 0) || !Number.isFinite(qty)) return no('The quantity must be a positive number.');
  const tg = s.treasury.goods[from];
  const have = tg ? Math.max(0, tg[good]) : 0;
  const q = Math.min(qty, have);
  if (!(q > 1e-9)) return no(`The Treasury holds no ${GOODS[good].name.toLowerCase()} in ${s.towns[from].name}.`);
  const r = usableRoute(s, from, to);
  if (!r) return no(`No wagon road links ${s.towns[from].name} and ${s.towns[to].name}.`);
  const unitCost = opts?.unitCost !== undefined && Number.isFinite(opts.unitCost) ? Math.max(0, opts.unitCost) : 0;
  const order = opts?.order !== undefined && opts.order >= 0 ? opts.order : -1;
  // Treasury wagons leave at noon (or after a later market session: opts.depart).
  const dep = opts?.depart !== undefined && opts.depart >= s.day + 0.5 && opts.depart < s.day + 1 ? opts.depart : s.day + 0.5;
  const days = Math.max(1, Math.ceil(r.days));
  const A = s.towns[from].name;
  const B = s.towns[to].name;
  const what = (x: number) => `${fmtQty(x)} ${unitName(good, x)} of ${GOODS[good].name.toLowerCase()}`;
  const arriving = `arriving in about ${days} day${days > 1 ? 's' : ''}`;

  // ---- a Treasury freight line on this road carries what it has room for (no fare: its
  // drivers, fuel and wagons are the Treasury's own; the landed cost counts its running cost per unit) ----
  let onLine = 0;
  let firstId = -1;
  const lo = s.policy.lines?.length ? lineOffer(s, from, to) : null;
  if (lo && lo.room > 0.5) {
    onLine = Math.min(q, lo.room);
    tg[good] -= onLine;
    if (tg[good] < 1e-9) tg[good] = 0;
    const sh = newShipment(s, STATE, from, to, good, onLine, unitCost + costPerUnit(s, lo.line), dep, dep + r.days, onLine / WAGON_CAPACITY);
    sh.line = lo.line.id;
    sh.order = order;
    firstId = sh.id;
    bump(s, 'shipped_units', onLine);
  }
  const lineText = onLine > 0 ? `${what(onLine)} leave ${A} for ${B} on the Treasury's freight line, ${arriving}.` : '';
  const partial = (why: string): CargoResult => ({ ok: true, message: `${lineText} The rest waits in ${A}: ${why}`, id: firstId, qty: onLine, paid: 0, days });
  const rest = q - onLine;
  if (!(rest > 1e-9)) return { ok: true, message: lineText, id: firstId, qty: onLine, paid: 0, days };

  // ---- the rest (or everything) with the town's trading house, for freight from the Purse ----
  const f = traderOf(s, from);
  if (!f) return onLine > 0 ? partial('the line is full today and there is no trading house to carry it.') : no(`There is no trading house in ${A} to carry the goods.`);
  const tr = f.trade!;
  const wagons = Math.max(1, Math.ceil(rest / WAGON_CAPACITY - 1e-9));
  const fee = tripCost(s, from, r, carterWage(s, from, f), FIRM_BASE + f.id) * wagons * (1 + TREASURY_FREIGHT_PREMIUM);
  const t = s.treasury;
  if (!t.autoMint && t.purse < fee)
    return onLine > 0 ? partial(`the line is full today and the Purse cannot cover the trading house's freight (¤${Math.ceil(fee)}).`) : no(`The Purse cannot cover the freight (¤${Math.ceil(fee)}).`);
  const paid = pay(s, STATE, FIRM_BASE + f.id, fee, 'freight');
  f.revenue += paid;
  // Use the house's own wagons, drivers and fuel where it has them free.
  const free = Math.max(0, Math.min(tr.wagons - tr.busy.length, f.workers.length - tr.busy.length));
  const tf = tripFuel(r);
  const own = Math.min(wagons, free, tf > 0 ? Math.floor(Math.max(0, f.inv[G.oil]) / tf + 1e-9) : free);
  for (let i = 0; i < own; i++) tr.busy.push(s.day + 2 * r.days);
  if (own > 0) {
    noteFlow(s, f.town, G.oil, FLOW_USED, Math.min(Math.max(0, f.inv[G.oil]), own * tf));
    f.inv[G.oil] = Math.max(0, f.inv[G.oil] - own * tf);
  }
  tg[good] -= rest;
  if (tg[good] < 1e-9) tg[good] = 0;
  const sh = newShipment(s, STATE, from, to, good, rest, unitCost + paid / rest, dep, dep + r.days, wagons);
  sh.order = order;
  bump(s, 'shipped_units', rest);
  bump(s, 'freight_cost', paid);
  const houseText = `${what(rest)} leave ${A} for ${B}${onLine > 0 ? ' with the trading house' : ''}, ${arriving}. Freight paid: ¤${Math.round(paid)}.`;
  return {
    ok: true,
    message: onLine > 0 ? `${lineText} ${houseText}` : houseText,
    id: firstId >= 0 ? firstId : sh.id,
    qty: onLine + rest,
    paid,
    days,
  };
}

/** A good's unit, pluralised ("loaf" → "loaves"). */
function unitName(g: GoodId, q: number): string {
  const u = GOODS[g].unit;
  if (Math.abs(q - 1) < 1e-9) return u;
  return u.endsWith('f') ? u.slice(0, -1) + 'ves' : u.endsWith('s') ? u + 'es' : u + 's';
}

function fmtQty(q: number): string {
  return q >= 100 ? String(Math.round(q)) : q >= 10 ? q.toFixed(1) : q.toFixed(2);
}
