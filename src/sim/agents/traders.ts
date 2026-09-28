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
//                       + oil price × OIL_PER_TILE × tiles × 2
//                       + WAGON_WEAR_DAY × round-trip days × tools price
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
// absorb (TRADE_DEST_ABSORB × its daily volume + shortage, less stock already
// there or on the way) and by any shipment quota.
//
// Home stock (goods bought for a trip, not yet loaded) lives in firm.inv, with its
// average cost in trade.basis[home] and waiting time in trade.age[home]; stock in
// other towns lives in trade.stock[town] and is sold there by an ask ladder that
// drifts down (to below landed cost) as the stock ages.
// ============================================================================
import * as CFG from '../config';
import { newShipment } from '../factory';
import { G, GOODS, N_GOODS } from '../goods';
import { pay } from '../ledger';
import { addAsk, addBid, bookFor, expectedGross, expectedNet, marketOf, type Books } from '../market/markets';
import { chargeLevy, levyAmount, type LevyCtx } from '../policy/levies';
import { noteBinding, quota } from '../policy/limits';
import { rt, type Route } from '../runtime';
import { FIRM_BASE, STATE } from '../types';
import type { ActionResult, Firm, GoodId, Order, SimState, TownId, TraderState } from '../types';
import { clamp, ema, fin } from '../util';
import { routeBetweenTowns } from '../world/paths';
import { debtOf, quoteRate, requestLoan } from './bank';

const {
  WAGON_CAPACITY,
  OIL_PER_TILE,
  TOOLS_PER_WAGON,
  WAGON_WEAR_DAY,
  TRADE_MIN_MARGIN_PCT,
  TRADE_MIN_MARGIN_ABS,
  TRADE_DEST_ABSORB,
  STOCK_AGE_DISCOUNT_DAYS,
  TRADE_PENDING_DAYS,
  TRADE_MIN_ABSORB,
  TRADE_HOLD_DAYS,
  TRADE_MIN_LOAD,
  TRADE_HOME_SELL_DAYS,
  TRADE_MAX_ROUTE_DAYS,
  TRADE_ASK_RUNGS,
  TRADE_ASK_WEIGHTS,
  TRADE_AGE_MAX_DISCOUNT,
  TRADER_OIL_TRIPS,
  TRADER_OIL_BID_MULT,
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

/** Wage used for freight: the trader's posted wage, else the town average, else the founding wage. */
function carterWage(s: SimState, town: TownId, f: Firm | undefined): number {
  if (f && f.wage > 0 && Number.isFinite(f.wage)) return f.wage;
  const t = s.towns[town];
  if (t && t.avgWage > 0) return t.avgWage;
  const bw = fin(s.stats.baseWage);
  return bw > 0 ? bw : BASE_WAGE;
}

/** Cost of one full wagon round trip on a route, priced in the origin town (¤). */
export function tripCost(s: SimState, from: TownId, r: Route, wage: number): number {
  const days2 = 2 * r.days;
  const oil = expectedGross(s, from, G.oil);
  const tools = expectedGross(s, from, G.tools);
  return fin(wage * days2 + oil * OIL_PER_TILE * r.length * 2 + WAGON_WEAR_DAY * days2 * tools);
}

/** Oil burnt by one wagon on a round trip. */
function tripFuel(r: Route): number {
  return OIL_PER_TILE * r.length * 2;
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
  return tripCost(s, a, r, carterWage(s, a, traderOf(s, a))) / WAGON_CAPACITY;
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

interface PlannedTrip {
  firm: number;
  good: GoodId;
  dest: TownId;
  homeUse: number; // units of existing home stock committed to this trip
  orders: Order[]; // merchandise bids (ladder)
}

interface TraderScratch {
  day: number;
  trips: PlannedTrip[];
  fuel: Order[]; // oil bids (fuel), by firm
  tools: Order[]; // wagon (tools) bids
  toolsPlan: Record<number, [number, number]>; // firm id → [qty, limit] set in tradersBeginDay
  pend: number[]; // [town * N_GOODS + good]: traders' stock there + in transit
  shipped: Record<string, number>; // quota bookkeeping: `${g}>${from}>${to}` → units dispatched today
}

function scratch(s: SimState): TraderScratch {
  const bag = rt(s).bag;
  let c = bag.traders as TraderScratch | undefined;
  if (!c) {
    c = { day: -1, trips: [], fuel: [], tools: [], toolsPlan: {}, pend: [], shipped: {} };
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
function deliver(s: SimState, sh: { owner: number; to: TownId; good: GoodId; qty: number; basis: number }): void {
  const q = sh.qty;
  if (!(q > 0) || sh.to < 0 || sh.to >= s.towns.length) return;
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
  for (let i = 0; i < list.length; i++) {
    const sh = list[i];
    if (sh.arrive <= s.day + 1) deliver(s, sh);
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
  const limit = expectedGross(s, f.town, G.tools) * TRADER_TOOLS_BID_MULT;
  c.toolsPlan[f.id] = [qty, limit];
  // Finance the fleet with an investment loan when short of cash (throttled).
  const cost = qty * limit;
  const reserve = TRADER_CASH_RESERVE_DAYS * carterWage(s, f.town, f) * Math.max(1, f.workers.length);
  if (profitable && !young && f.cash < cost + reserve && (s.day + f.id) % 10 === 0) {
    const ref = FIRM_BASE + f.id;
    const ask = Math.max(cost, gap * limit);
    if (debtOf(s, ref) < 4 * ask && quoteRate(s, ref, ask) >= 0) {
      requestLoan(s, { borrower: ref, amount: ask, term: INVEST_LOAN_TERM, purpose: 'invest', project: -1 });
    }
  }
}

// ---------------------------------------------------------------------------
// Market phase
// ---------------------------------------------------------------------------

interface Opp {
  good: GoodId;
  dest: TownId;
  qty: number;
  wagons: number;
  limit: number;
  pBuy: number;
  score: number; // profit per wagon-day
  r: Route;
  trip: number;
  keep: number;
  pSell: number;
  minM: number;
}

const _ctx: LevyCtx = {};

/** Destination allowance for a good (units): TRADE_DEST_ABSORB × (volume EMA + shortage), less pending stock. */
function room(s: SimState, pend: number[], dest: TownId, g: GoodId): number {
  const m = marketOf(s, dest, g);
  const daily = Math.max(TRADE_MIN_ABSORB, TRADE_DEST_ABSORB * (Math.max(0, fin(m.volEma)) + Math.max(0, fin(m.shortage))));
  const p = pend[dest * N_GOODS + g] || 0;
  return Math.max(0, Math.min(daily, daily * TRADE_PENDING_DAYS - p));
}

/** Per-unit break-even bid for `q` units on a route (after freight at that load, levies, min margin). */
function limitFor(s: SimState, o: Opp, home: TownId, q: number, shipLevies: boolean): number {
  const wagons = Math.max(1, Math.ceil(q / WAGON_CAPACITY - 1e-9));
  const freightU = (o.trip * wagons) / Math.max(1e-9, q);
  let levyU = 0;
  if (shipLevies) {
    _ctx.town = home;
    _ctx.toTown = o.dest;
    _ctx.good = o.good;
    levyU = levyAmount(s, 'shipment', 'owner', _ctx, o.pBuy * q, q) / Math.max(1e-9, q);
  }
  return o.pSell * o.keep - freightU - levyU - o.minM;
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
  const pNet = expectedNet(s, town, g);
  if (dump) {
    addAsk(book, ref, pNet * 0.5, qty);
    return;
  }
  const spoil = GOODS[g].spoil;
  // Perishables are sold at once; durables hold out for a price near landed cost, less over time.
  const ageEff = spoil > 0 ? age + 3 + 20 * spoil * (age + 1) : age;
  const disc = TRADE_AGE_MAX_DISCOUNT * clamp(ageEff / STOCK_AGE_DISCOUNT_DAYS, 0, 1);
  const floor = Math.max(0, fin(basis)) * (1 - disc);
  for (let i = 0; i < TRADE_ASK_RUNGS.length; i++) {
    const q = qty * TRADE_ASK_WEIGHTS[i];
    if (q > 1e-6) addAsk(book, ref, Math.max(floor, pNet * TRADE_ASK_RUNGS[i]), q);
  }
}

/** Fuel the trader wants on hand (oil units). */
function fuelTarget(s: SimState, f: Firm, tr: TraderState): number {
  let n = 0;
  let sum = 0;
  for (let d = 0; d < s.towns.length; d++) {
    const r = usableRoute(s, f.town, d);
    if (!r) continue;
    n++;
    sum += tripFuel(r);
  }
  if (!n) return 0;
  return (sum / n) * Math.max(TRADER_OIL_TRIPS, 2 * Math.max(0, fin(tr.wantEma)));
}

/**
 * For each trader (home town h) with free wagons AND free drivers AND oil for the trip:
 * rank (good, destination) by expected margin per unit =
 *   expectedNet(dest) − expectedGross(h) − freightPerUnit(h, dest) − shipment levies
 *   − max(TRADE_MIN_MARGIN_ABS, TRADE_MIN_MARGIN_PCT·price)
 * cap each by TRADE_DEST_ABSORB × destination volume EMA (+ shortage) and any shipMax quota,
 * and bid in h's book at limit = expected dest net − freight − levies − min margin
 * (tag = destination town). Also: asks for stock held in each non-home town
 * (above landed basis, discounted with age), and an oil bid to keep ~10 trips of fuel.
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
  let nTraders = 0;
  for (const f of s.firms) {
    if (!isTrader(f) || f.status === 'closed') continue;
    nTraders++;
    const tr = f.trade;
    for (let t = 0; t < nT && t < tr.stock.length; t++) {
      if (t === f.town) continue;
      const st = tr.stock[t];
      for (let g = 0; g < N_GOODS; g++) if (st[g] > 0) pend[t * N_GOODS + g] += st[g];
    }
  }
  for (const sh of s.shipments) if (sh.owner !== STATE && sh.to >= 0 && sh.to < nT) pend[sh.to * N_GOODS + sh.good] += Math.max(0, sh.qty);
  if (!nTraders) return;
  const shipLevies = s.policy.levies.length > 0 && hasLevy(s, 'shipment');
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

    // ---- fuel ----
    const fuelWant = fuelTarget(s, f, tr);
    const fuelHave = Math.max(0, f.inv[G.oil]);
    let fuelBid = 0;
    if (fuelWant > fuelHave + 0.01 && cash > 0) {
      const lim = expectedGross(s, home, G.oil) * TRADER_OIL_BID_MULT;
      const q = Math.min(fuelWant - fuelHave, cash / Math.max(1e-9, lim));
      if (q > 0.01) {
        c.fuel.push(addBid(bookFor(books, home, G.oil), ref, lim, q));
        cash -= q * lim;
        fuelBid = q;
      }
    }

    // ---- wagons (tools) ----
    const tp = c.toolsPlan[f.id];
    if (tp && cash > 0) {
      const q = Math.min(tp[0], cash / Math.max(1e-9, tp[1]));
      if (q > 0.01) {
        c.tools.push(addBid(bookFor(books, home, G.tools), ref, tp[1], q));
        cash -= q * tp[1];
      }
    }

    // ---- opportunities ----
    const opps: Opp[] = [];
    let myFreight = 0;
    let myN = 0;
    for (let d = 0; d < nT; d++) {
      const r = usableRoute(s, home, d);
      if (!r) continue;
      const trip = tripCost(s, home, r, wage);
      const perTile = trip / (WAGON_CAPACITY * r.length);
      myFreight += perTile;
      myN++;
      freightSum += perTile;
      freightN++;
      const keep0 = r.days + 1;
      for (let g = 0; g < N_GOODS; g++) {
        const pSell = expectedNet(s, d, g);
        const pBuy = expectedGross(s, home, g);
        if (!(pSell > 0) || !(pBuy > 0)) continue;
        const keep = keepFactor(g, keep0);
        const minM = Math.max(TRADE_MIN_MARGIN_ABS, TRADE_MIN_MARGIN_PCT * pSell);
        // Cheap pre-check at full-load freight.
        if (pSell * keep - trip / WAGON_CAPACITY - minM <= pBuy) continue;
        let q = room(s, pend, d, g);
        const ql = quotaLeft(s, c, g, home, d);
        if (ql < q) {
          if (q > 0.5) noteBinding(s, 'shipMax', g, home);
          q = ql;
        }
        if (!(q > 0.5)) continue;
        const o: Opp = { good: g, dest: d, qty: q, wagons: 0, limit: 0, pBuy, score: 0, r, trip, keep, pSell, minM };
        // A part-full last wagon may not pay: fall back to whole wagons if that is better.
        let lim = limitFor(s, o, home, q, shipLevies);
        if (q > WAGON_CAPACITY && lim <= pBuy) {
          const qFull = Math.floor(q / WAGON_CAPACITY) * WAGON_CAPACITY;
          const l2 = limitFor(s, o, home, qFull, shipLevies);
          if (l2 > lim) {
            q = qFull;
            lim = l2;
          }
        }
        if (!(lim > pBuy * 1.005)) continue;
        o.qty = q;
        o.limit = lim;
        o.wagons = Math.max(1, Math.ceil(q / WAGON_CAPACITY - 1e-9));
        o.score = ((lim - pBuy) * q) / (o.wagons * 2 * r.days);
        opps.push(o);
      }
    }
    opps.sort((a, b) => b.score - a.score);
    if (myN > 0) {
      const v = myFreight / myN;
      tr.freightEma = tr.freightEma > 0 ? ema(tr.freightEma, v, FREIGHT_EMA) : v;
    }

    // ---- allocate free wagons, drivers and fuel ----
    let wagonsLeft = Math.max(0, Math.min(tr.wagons - tr.busy.length, f.workers.length - tr.busy.length));
    let fuelLeft = fuelHave + fuelBid;
    let wanted = 0;
    const merch = f.inv; // home stock waiting for a trip
    const homeLeft: number[] = new Array(N_GOODS).fill(0);
    for (let g = 0; g < N_GOODS; g++) homeLeft[g] = Math.max(0, merch[g] - (g === G.oil ? fuelWant : 0));
    for (const o of opps) {
      wanted += o.wagons;
      if (wagonsLeft <= 0) continue;
      const tf = tripFuel(o.r);
      const byFuel = tf > 0 ? Math.floor(fuelLeft / tf + 1e-9) : wagonsLeft;
      const w = Math.min(o.wagons, wagonsLeft, byFuel);
      if (w <= 0) continue;
      let q = Math.min(o.qty, w * WAGON_CAPACITY);
      const lim = q < o.qty ? limitFor(s, o, home, q, shipLevies) : o.limit;
      if (!(lim > o.pBuy * 1.005)) continue;
      const homeUse = Math.min(homeLeft[o.good], q);
      homeLeft[o.good] -= homeUse;
      let bidQ = q - homeUse;
      if (bidQ * lim > cash) bidQ = Math.max(0, cash / lim);
      q = homeUse + bidQ;
      if (!(q > 0.5)) continue;
      const trip: PlannedTrip = { firm: f.id, good: o.good, dest: o.dest, homeUse, orders: [] };
      if (bidQ > 0.01) {
        const book = bookFor(books, home, o.good);
        for (const [pos, share] of BID_LADDER) {
          const price = o.pBuy + pos * (lim - o.pBuy);
          trip.orders.push(addBid(book, ref, price, bidQ * share, { tag: o.dest }));
        }
        cash -= bidQ * lim;
      }
      c.trips.push(trip);
      wagonsLeft -= w;
      fuelLeft -= w * tf;
      pend[o.dest * N_GOODS + o.good] += q;
    }
    tr.wantEma = ema(fin(tr.wantEma), tr.busy.length + wanted, TRADER_USE_EMA);

    // ---- home stock no route pays for: sell it back locally after a while ----
    for (let g = 0; g < N_GOODS; g++) {
      const q = homeLeft[g];
      if (!(q > 1e-6) || g === G.tools) continue;
      const age = fin(tr.age[home][g]);
      if (age < TRADE_HOME_SELL_DAYS && GOODS[g].spoil === 0) continue;
      let used = false;
      for (const o of opps) if (o.good === g) used = true;
      if (used) continue;
      stockAsks(s, books, ref, home, g, q, tr.basis[home][g], age, false);
    }
  }
  // Shipping index: full-load freight per unit per tile, averaged over all traders' routes.
  if (freightN > 0) s.stats.acc.freight_per_unit_tile = freightSum / freightN;
}

/** Book the day's purchases into the trader's home stock basis. */
function bookPurchase(f: Firm, tr: TraderState, g: GoodId, o: Order): void {
  if (!(o.filled > 0)) return;
  const home = f.town;
  const after = Math.max(0, f.inv[g]);
  const before = Math.max(0, after - o.filled);
  mergeBasis(tr, home, g, before, o.filled, o.paid / o.filled);
}

/**
 * After clearing: for each filled trade bid, load wagons (ceil(qty / WAGON_CAPACITY)),
 * burn oil (OIL_PER_TILE × tiles × wagons, both legs), charge 'shipment' levies (payer 'owner'),
 * create Shipment(s) with depart = day + 0.5, arrive = depart + route.days,
 * mark wagons busy until day + 2·route.days. stats.acc: shipped_units, freight_cost.
 * A durable load below TRADE_MIN_LOAD of a wagon may wait at home up to TRADE_HOLD_DAYS
 * for more. Filled wagon (tools) bids become wagons (inv → firm.tools).
 */
export function tradersDispatch(s: SimState, books: Books): void {
  void books;
  const c = scratch(s);
  // ---- fuel & wagons bought today ----
  for (const o of c.fuel) {
    const f = s.firms[o.ref - FIRM_BASE];
    if (isTrader(f)) bookPurchase(f, f.trade, G.oil, o);
  }
  for (const o of c.tools) {
    const f = s.firms[o.ref - FIRM_BASE];
    if (!isTrader(f) || !(o.filled > 0)) continue;
    const q = Math.min(o.filled, Math.max(0, f.inv[G.tools]));
    f.inv[G.tools] -= q;
    f.tools += q;
    f.trade.wagons = Math.floor(f.tools / TOOLS_PER_WAGON + 1e-9);
  }
  // ---- merchandise purchases → home basis ----
  for (const t of c.trips) {
    const f = s.firms[t.firm];
    if (!isTrader(f)) continue;
    for (const o of t.orders) bookPurchase(f, f.trade, t.good, o);
  }
  const shipLevies = s.policy.levies.length > 0 && hasLevy(s, 'shipment');
  // ---- load and send ----
  for (const t of c.trips) {
    const f = s.firms[t.firm];
    if (!isTrader(f) || f.status !== 'active') continue;
    const tr = f.trade;
    const home = f.town;
    const g = t.good;
    const r = usableRoute(s, home, t.dest);
    if (!r) continue;
    let filled = 0;
    for (const o of t.orders) filled += o.filled;
    const tf = tripFuel(r);
    const fuelOnHand = Math.max(0, f.inv[G.oil]);
    let avail = Math.max(0, f.inv[g]);
    if (g === G.oil) avail = Math.max(0, avail - tf); // keep at least one trip of fuel
    let q = Math.min(avail, t.homeUse + filled, quotaLeft(s, c, g, home, t.dest));
    if (!(q > 1e-3)) continue;
    if (GOODS[g].spoil === 0 && q < TRADE_MIN_LOAD * WAGON_CAPACITY && fin(tr.age[home][g]) < TRADE_HOLD_DAYS) continue; // wait for a fuller wagon
    const free = Math.max(0, Math.min(tr.wagons - tr.busy.length, f.workers.length - tr.busy.length));
    const fuelFree = g === G.oil ? Math.max(0, fuelOnHand - q) : fuelOnHand;
    const byFuel = tf > 0 ? Math.floor(fuelFree / tf + 1e-9) : free;
    const w = Math.min(Math.max(1, Math.ceil(q / WAGON_CAPACITY - 1e-9)), free, byFuel);
    if (w <= 0) continue;
    q = Math.min(q, w * WAGON_CAPACITY);
    // fuel for both legs
    f.inv[G.oil] = Math.max(0, f.inv[G.oil] - w * tf);
    bump(s, 'oil_burned', w * tf);
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
    const wage = carterWage(s, home, f);
    const trip = tripCost(s, home, r, wage) * w;
    const basis = basisHome + trip / q + lev / q;
    f.inv[g] = Math.max(0, f.inv[g] - q);
    if (f.inv[g] <= 1e-9) tr.age[home][g] = 0;
    newShipment(s, FIRM_BASE + f.id, home, t.dest, g, q, basis, s.day + 0.5, s.day + 0.5 + r.days, w);
    for (let i = 0; i < w; i++) tr.busy.push(s.day + 2 * r.days);
    tr.shippedToday += q;
    c.shipped[quotaKey(g, home, t.dest)] = (c.shipped[quotaKey(g, home, t.dest)] || 0) + q;
    bump(s, 'shipped_units', q);
    bump(s, 'freight_cost', trip);
    bump(s, 'wagons_sent', w);
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
  const nT = s.towns.length;
  if (!(from >= 0 && from < nT) || !(to >= 0 && to < nT)) return { ok: false, message: 'Unknown town.' };
  if (from === to) return { ok: false, message: 'Choose two different towns.' };
  if (!(good >= 0 && good < N_GOODS)) return { ok: false, message: 'Unknown good.' };
  if (!(qty > 0) || !Number.isFinite(qty)) return { ok: false, message: 'The quantity must be a positive number.' };
  const tg = s.treasury.goods[from];
  const have = tg ? Math.max(0, tg[good]) : 0;
  const q = Math.min(qty, have);
  if (!(q > 1e-9)) return { ok: false, message: `The Treasury holds no ${GOODS[good].name.toLowerCase()} in ${s.towns[from].name}.` };
  const r = usableRoute(s, from, to);
  if (!r) return { ok: false, message: `No wagon road links ${s.towns[from].name} and ${s.towns[to].name}.` };
  const f = traderOf(s, from);
  if (!f) return { ok: false, message: `There is no trading house in ${s.towns[from].name} to carry the goods.` };
  const tr = f.trade!;
  const wagons = Math.max(1, Math.ceil(q / WAGON_CAPACITY - 1e-9));
  const fee = tripCost(s, from, r, carterWage(s, from, f)) * wagons * (1 + TREASURY_FREIGHT_PREMIUM);
  const t = s.treasury;
  if (!t.autoMint && t.purse < fee) return { ok: false, message: `The Purse cannot cover the freight (¤${Math.ceil(fee)}).` };
  const paid = pay(s, STATE, FIRM_BASE + f.id, fee, 'freight');
  f.revenue += paid;
  // Use the house's own wagons, drivers and fuel where it has them free.
  const free = Math.max(0, Math.min(tr.wagons - tr.busy.length, f.workers.length - tr.busy.length));
  const tf = tripFuel(r);
  const own = Math.min(wagons, free, tf > 0 ? Math.floor(Math.max(0, f.inv[G.oil]) / tf + 1e-9) : free);
  for (let i = 0; i < own; i++) tr.busy.push(s.day + 2 * r.days);
  if (own > 0) f.inv[G.oil] = Math.max(0, f.inv[G.oil] - own * tf);
  tg[good] -= q;
  if (tg[good] < 1e-9) tg[good] = 0;
  const sh = newShipment(s, STATE, from, to, good, q, paid / q, s.day + 0.5, s.day + 0.5 + r.days, wagons);
  bump(s, 'shipped_units', q);
  bump(s, 'freight_cost', paid);
  const days = Math.max(1, Math.ceil(r.days));
  return {
    ok: true,
    message: `${fmtQty(q)} ${GOODS[good].unit}${q === 1 ? '' : 's'} of ${GOODS[good].name.toLowerCase()} leave ${s.towns[from].name} for ${s.towns[to].name}, arriving in about ${days} day${days > 1 ? 's' : ''}. Freight paid: ¤${Math.round(paid)}.`,
    id: sh.id,
  };
}

function fmtQty(q: number): string {
  return q >= 100 ? String(Math.round(q)) : q >= 10 ? q.toFixed(1) : q.toFixed(2);
}
