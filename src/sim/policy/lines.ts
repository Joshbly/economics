// ============================================================================
// Treasury freight lines (s.policy.lines): the Treasury runs its own wagons
// between two towns and carries other people's goods for a fare. OWNER:
// market-policy agent. See DESIGN §5 (Build) and §3.4 (traders).
//
// Every step is a real flow — nothing here discounts freight by decree:
//   wagons  = tools the line holds (TOOLS_PER_WAGON each), taken from the Treasury's
//             stores in the depot town `a` when the line opens or grows, and bought there
//             (an exempt Treasury bid, visible in the market) as they wear out;
//   drivers = Treasury workers of `a` (the town's stateworks crew: policyBeginDay adds the
//             line's drivers to the crew's target and offers at least the line's wage;
//             workers go to the Treasury's labour orders first, the rest drive), paid from
//             the Purse with the rest of the crew (firms.firmsPayWages);
//   fuel    = oil bought in `a`'s market (an exempt Treasury bid) into the line's own store
//             and burnt per loaded leg (OIL_PER_TILE × tiles), like any wagon;
//   wear    = WAGON_WEAR_DAY per wagon-day on the road + idle wear, like any wagon.
// Who uses it: the trading houses of `a` and `b` (traders.traderOrders). For a trip on
// a→b (or b→a) a house compares its own wagons' freight with the line's fare and puts
// the goods it can on the line when that pays better; it pays the fare to the Purse
// (pay(), flow 'fare') and its goods ride a Treasury wagon (Shipment.line = the line id;
// the cargo stays the house's). Cheaper freight enters the houses' break-even bids, so
// they buy more at home and sell more at the destination: price gaps between the towns
// narrow through the ordinary arbitrage. The Treasury's own cargo between the two towns
// (supply routes, Move goods) rides the line too, without a fare
// (traders.sendTreasuryCargo).
//
// A day on the line:
//   policyBeginDay → linesBeginDay: wagons come home, wear, fleet size, today's fare,
//        drivers wanted (from the EMA of wagons asked for);
//   traderOrders:   houses read lineOffer (fare, room left today) and reserve room;
//   playerOrders → lineOrders: bids for the line's tools and oil in `a`;
//   tradersDispatch: houses load their cargo onto the line and pay the fare;
//   playerAfterClear → linesAfterClear: purchases join the line's stores, and the day's
//        loads leave: loaded legs a→b and b→a fill whole wagons (goods of several houses
//        share a wagon), a wagon meeting a load coming the other way returns loaded (both
//        are away one leg and swap ends), the others come back empty (away two legs);
//        fuel is burnt per loaded leg; costs, the carried units and the EMAs are booked.
// Room on a given day = (free wagons, drivers not on the road, fuel for a leg: the least
// of the three) × WAGON_CAPACITY, less what is already loaded or reserved.
// ============================================================================
import {
  LINE_BUY_BAND,
  LINE_COST_CAP_MULT,
  LINE_COST_EMA,
  LINE_COST_FLOOR_MULT,
  LINE_COST_MIN_UNITS,
  LINE_DRIVER_SLACK,
  LINE_FUEL_DAYS,
  LINE_FUEL_MIN_LEGS,
  LINE_TOOLS_DAY,
  LINE_USE_EMA,
  LINE_WAGE_PREMIUM,
  LINE_WEAR_BUFFER,
  OIL_PER_TILE,
  TOOLS_IDLE_WEAR_DAY,
  TOOLS_PER_WAGON,
  TRADE_MAX_ROUTE_DAYS,
  WAGON_CAPACITY,
  WAGON_WEAR_DAY,
  BASE_WAGE,
} from '../config';
import { G, N_GOODS } from '../goods';
import { addBid, bookFor, marketOf, type Books } from '../market/markets';
import { rt, type Route } from '../runtime';
import { STATE } from '../types';
import type { Firm, FreightLine, LineFare, Order, PlayerOrder, SimState, TownId } from '../types';
import { clamp, ema, fin } from '../util';
import { routeBetweenTowns } from '../world/paths';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** A fresh line record (no wagons yet, all counters zero). */
export function newLine(id: number, a: TownId, b: TownId, wagons: number, fare: LineFare, farePrice: number, day: number, label: string): FreightLine {
  return {
    id,
    label,
    enabled: true,
    a,
    b,
    wagonsWanted: wagons,
    fare,
    farePrice: fare === 'fixed' ? farePrice : 0,
    fareToday: fare === 'fixed' ? farePrice : 0,
    wage: 0,
    created: day,
    tools: 0,
    wagons: 0,
    oil: 0,
    oilBasis: 0,
    busy: [],
    drivers: 0,
    crew: 0,
    // A new line expects half its fleet to be asked for (so it hires drivers at once).
    useEma: 0.5 * wagons,
    costEma: 0,
    unitsEma: 0,
    carriedToday: 0,
    legsToday: 0,
    faresToday: 0,
    costToday: 0,
    carried: 0,
    legs: 0,
    fares: 0,
    wages: 0,
    fuelCost: 0,
    wear: 0,
    oilSpent: 0,
    toolsSpent: 0,
  };
}

/** The line with this id, or undefined. */
export function lineById(s: SimState, id: number): FreightLine | undefined {
  const ls = s.policy.lines;
  if (!ls) return undefined;
  for (let i = 0; i < ls.length; i++) if (ls[i].id === id) return ls[i];
  return undefined;
}

/** The line between two towns (either way round), or undefined. */
export function lineBetween(s: SimState, x: TownId, y: TownId): FreightLine | undefined {
  const ls = s.policy.lines;
  if (!ls) return undefined;
  for (const L of ls) if ((L.a === x && L.b === y) || (L.a === y && L.b === x)) return L;
  return undefined;
}

/** Does the line run between these two towns (in this direction or the other)? */
export function serves(L: FreightLine, from: TownId, to: TownId): boolean {
  return (L.a === from && L.b === to) || (L.b === from && L.a === to);
}

/** The line's road from `from` (a or b) to the other end, if wagons can use it. */
export function lineRoute(s: SimState, L: FreightLine, from: TownId = L.a): Route | null {
  const to = from === L.a ? L.b : L.a;
  return usableRoute(s, from, to);
}

/** Road a→b if wagons can use it (reachable, not absurdly slow), as the trading houses judge it. */
export function usableRoute(s: SimState, a: TownId, b: TownId): Route | null {
  if (a === b || a < 0 || b < 0 || a >= s.towns.length || b >= s.towns.length) return null;
  const r = routeBetweenTowns(s, a, b);
  if (!r || !(r.length > 0) || !(r.days > 0) || !Number.isFinite(r.days) || r.days > TRADE_MAX_ROUTE_DAYS) return null;
  return r;
}

/** Oil one loaded leg burns. */
export function legFuel(r: Route): number {
  return OIL_PER_TILE * r.length;
}

/** Wagons on the road now. */
export function wagonsOut(s: SimState, L: FreightLine): number {
  let n = 0;
  for (const d of L.busy) if (d > s.day) n++;
  return n;
}

/** Whole wagons needed for q units (0 for nothing). */
function legsFor(q: number): number {
  return q > 1e-6 ? Math.ceil(q / WAGON_CAPACITY - 1e-9) : 0;
}

/** A town's going price of a good (its smoothed clearing price; base terms: Treasury orders are exempt). */
function goingPrice(s: SimState, town: TownId, g: number): number {
  const m = marketOf(s, town, g);
  const p = m && m.ema > 0 && Number.isFinite(m.ema) ? m.ema : m ? m.price : 0;
  return p > 0 && Number.isFinite(p) ? p : 0;
}

// ---------------------------------------------------------------------------
// Drivers (Treasury workers of the depot town)
// ---------------------------------------------------------------------------

/** The Treasury workforce of a town, or undefined. */
export function stateworksIn(s: SimState, town: TownId): Firm | undefined {
  for (const f of s.firms) if (f && f.alive && f.sector === 'stateworks' && f.town === town) return f;
  return undefined;
}

/** Workers the Treasury's labour orders in a town ask for (they have the first claim on the crew). */
function labourHeads(s: SimState, town: TownId): number {
  let n = 0;
  for (const o of s.policy.orders) {
    if (!o.enabled || o.market.kind !== 'labor' || o.market.town !== town || o.side !== 'buy') continue;
    if (o.total >= 0 && o.filled >= o.total - 1e-9) continue;
    const want = o.staff === 'projects' ? (o.staffToday ?? 0) : o.qty; // an order staffing projects: today's number
    n += o.total >= 0 ? Math.min(want, Math.max(0, Math.ceil(o.total - o.filled - 1e-9))) : want;
  }
  return n;
}

/** Drivers the line has right now: its share of the depot's crew beyond the labour orders (lines in list order). */
export function crewOf(s: SimState, L: FreightLine): number {
  const sw = stateworksIn(s, L.a);
  if (!sw || sw.status !== 'active') return 0;
  let free = Math.max(0, sw.workers.length - labourHeads(s, L.a));
  for (const x of s.policy.lines) {
    if (x.a !== L.a) continue;
    const c = Math.min(Math.max(0, x.drivers), free);
    if (x === L) return c;
    free -= c;
  }
  return 0;
}

/** Treasury workers of a town driving for its lines today (not available for construction). */
export function lineCrewIn(s: SimState, town: TownId): number {
  const ls = s.policy.lines;
  if (!ls || !ls.length) return 0;
  let n = 0;
  for (const L of ls) if (L.a === town) n += crewOf(s, L);
  return n;
}

/** Drivers the lines based in a town want today, and the highest wage they offer (policyBeginDay). */
export function lineDriversWanted(s: SimState, town: TownId): { n: number; wage: number } {
  let n = 0;
  let wage = 0;
  for (const L of s.policy.lines ?? []) {
    if (L.a !== town || !(L.drivers > 0)) continue;
    n += L.drivers;
    if (L.wage > wage) wage = L.wage;
  }
  return { n, wage };
}

/** Wage a line offers its drivers: the going carters' wage in its depot town (the trading house's), plus LINE_WAGE_PREMIUM. */
export function driverWage(s: SimState, town: TownId): number {
  let w = 0;
  for (const f of s.firms) {
    if (f && f.alive && f.status === 'active' && f.sector === 'trader' && f.town === town && f.wage > 0 && Number.isFinite(f.wage)) {
      w = f.wage;
      break;
    }
  }
  if (!(w > 0)) {
    const t = s.towns[town];
    w = t && t.avgWage > 0 ? t.avgWage : fin(s.stats.baseWage) > 0 ? s.stats.baseWage : BASE_WAGE;
  }
  return w * (1 + LINE_WAGE_PREMIUM);
}

// ---------------------------------------------------------------------------
// Costs and fares
// ---------------------------------------------------------------------------

/** What one wagon's round trip a↔b costs the line at today's prices (drivers, fuel for the loaded leg, road wear). */
export function roundTripCost(s: SimState, a: TownId, r: Route, wage: number): number {
  const days2 = 2 * r.days;
  return fin(wage * days2 + goingPrice(s, a, G.oil) * legFuel(r) + WAGON_WEAR_DAY * days2 * goingPrice(s, a, G.tools));
}

/** A full wagon's round-trip cost per unit carried (the line's cost per unit when its wagons leave full and come back empty). */
export function fullWagonUnitCost(s: SimState, L: FreightLine): number {
  const r = lineRoute(s, L);
  if (!r) return 0;
  const w = L.wage > 0 ? L.wage : driverWage(s, L.a);
  return roundTripCost(s, L.a, r, w) / WAGON_CAPACITY;
}

/**
 * The line's own running cost per unit carried, from its recent trips: the cost of the trips it
 * ran (drivers' days on the road, fuel burnt, road wear) over the units they carried (EMAs over
 * about a month) — part-full wagons raise it, loads that meet a load coming back lower it; a full
 * wagon's round trip per unit until it has carried LINE_COST_MIN_UNITS a day; kept within
 * LINE_COST_FLOOR_MULT … LINE_COST_CAP_MULT of that. Drivers waiting for loads and the wagons'
 * idle wear are the Treasury's standing cost: they are in the line's accounts, not in its fare.
 */
export function costPerUnit(s: SimState, L: FreightLine): number {
  const full = fullWagonUnitCost(s, L);
  if (!(full > 0)) return 0;
  // Units short of LINE_COST_MIN_UNITS a day count at a full wagon's cost, so a quiet line's
  // fare moves smoothly from that estimate to what its trips actually cost.
  const u = Math.max(0, fin(L.unitsEma));
  const c = (Math.max(0, fin(L.costEma)) + Math.max(0, LINE_COST_MIN_UNITS - u) * full) / Math.max(LINE_COST_MIN_UNITS, u);
  return clamp(fin(c, full), LINE_COST_FLOOR_MULT * full, LINE_COST_CAP_MULT * full);
}

/** The fare the rule sets today (¤ per unit). */
export function fareFor(s: SimState, L: FreightLine): number {
  if (L.fare === 'free') return 0;
  if (L.fare === 'fixed') return Math.max(0, fin(L.farePrice));
  return costPerUnit(s, L);
}

/** Estimate for a line not yet opened (the composer's preview). */
export interface LineEstimate {
  ok: boolean;
  days: number; // one way
  tiles: number;
  wage: number; // offered to each driver
  perUnit: number; // a full wagon's round trip per unit
  perDay: number; // running cost a day with every wagon on the road (one loaded leg per round trip)
  idleDay: number; // running cost a day with the wagons standing (drivers kept for half of them, idle wear)
  wagonCost: number; // tools for one wagon at today's price in `a`
  fuelLeg: number; // oil one loaded leg burns
}

export function estimateLine(s: SimState, a: TownId, b: TownId, wagons: number): LineEstimate {
  const r = usableRoute(s, a, b);
  const none: LineEstimate = { ok: false, days: 0, tiles: 0, wage: 0, perUnit: 0, perDay: 0, idleDay: 0, wagonCost: 0, fuelLeg: 0 };
  if (!r) return none;
  const wage = driverWage(s, a);
  const trip = roundTripCost(s, a, r, wage);
  const tools = goingPrice(s, a, G.tools);
  const n = Math.max(0, wagons);
  return {
    ok: true,
    days: r.days,
    tiles: r.length,
    wage,
    perUnit: trip / WAGON_CAPACITY,
    perDay: (n * trip) / Math.max(1e-9, 2 * r.days) + n * TOOLS_PER_WAGON * TOOLS_IDLE_WEAR_DAY * tools,
    idleDay: Math.ceil(0.5 * n * LINE_DRIVER_SLACK - 0.05) * wage + n * TOOLS_PER_WAGON * TOOLS_IDLE_WEAR_DAY * tools,
    wagonCost: TOOLS_PER_WAGON * tools,
    fuelLeg: legFuel(r),
  };
}

// ---------------------------------------------------------------------------
// Daily scratch (runtime; rebuilt every day, never serialised)
// ---------------------------------------------------------------------------
interface LineSub {
  line: number;
  good: number;
  ord: Order;
}

interface LineScratch {
  day: number;
  /** Room reserved by trading houses while planning (line id → [a→b, b→a] units); cleared at dispatch. */
  res: Record<number, [number, number]>;
  /** Units houses would have put on the line beyond its room (line id → units): the demand signal. */
  ask: Record<number, number>;
  /** The lines' own bids (tools, oil) placed today. */
  subs: LineSub[];
}

function scratch(s: SimState): LineScratch {
  const bag = rt(s).bag;
  let c = bag.lines as LineScratch | undefined;
  if (!c) {
    c = { day: -1, res: {}, ask: {}, subs: [] };
    bag.lines = c;
  }
  if (c.day !== s.day) {
    c.day = s.day;
    c.res = {};
    c.ask = {};
    c.subs = [];
  }
  return c;
}

const departsToday = (s: SimState, depart: number) => Math.abs(depart - (s.day + 0.5)) < 1e-6;

/** Units loaded onto the line today so far, [a→b, b→a] (cargo leaving today, from the shipments). */
function loadedToday(s: SimState, L: FreightLine): [number, number] {
  let ab = 0;
  let ba = 0;
  for (const sh of s.shipments) {
    if (sh.line !== L.id || !departsToday(s, sh.depart)) continue;
    if (sh.from === L.a) ab += Math.max(0, sh.qty);
    else ba += Math.max(0, sh.qty);
  }
  return [ab, ba];
}

/**
 * Units the line can still take today from `from` (its a or b end): legs it can still send
 * (free wagons, drivers not on the road and fuel — the least of the three) less the legs
 * today's loads and reservations already fill, in whole wagons, plus the spare room in the
 * last wagon leaving from `from`. 0 when paused or without a usable road.
 */
export function lineRoom(s: SimState, L: FreightLine, from: TownId): number {
  if (!L.enabled || (from !== L.a && from !== L.b)) return 0;
  const r = lineRoute(s, L);
  if (!r) return 0;
  const out = wagonsOut(s, L);
  const fuel = legFuel(r);
  const legs = Math.min(L.wagons - out, crewOf(s, L) - out, fuel > 0 ? Math.floor(Math.max(0, L.oil) / fuel + 1e-9) : 1e9);
  if (!(legs > 0)) return 0;
  const c = scratch(s);
  const [lab, lba] = loadedToday(s, L);
  const res = c.res[L.id];
  const ab = lab + (res ? res[0] : 0);
  const ba = lba + (res ? res[1] : 0);
  const mine = from === L.a ? ab : ba;
  const spare = legsFor(mine) * WAGON_CAPACITY - mine;
  return Math.max(0, (legs - legsFor(ab) - legsFor(ba)) * WAGON_CAPACITY + spare);
}

/** What a line offers a shipper from `from` to `to` today. */
export interface LineOffer {
  line: FreightLine;
  fare: number; // ¤ per unit
  room: number; // units it can still take today
}

/**
 * The running line between `from` and `to` (either direction) with its fare and its room left
 * today — the cheapest with room, else one that is full (room 0: shippers still tell it what
 * they would have loaded, see askLine) — or null when none runs there.
 */
export function lineOffer(s: SimState, from: TownId, to: TownId): LineOffer | null {
  const ls = s.policy.lines;
  if (!ls || !ls.length) return null;
  let best: LineOffer | null = null;
  for (const L of ls) {
    if (!L.enabled || !serves(L, from, to)) continue;
    const room = lineRoom(s, L, from);
    const fare = Math.max(0, fin(L.fareToday));
    const open = room > 0.5;
    if (!best || (open && !(best.room > 0.5)) || (open === best.room > 0.5 && fare < best.fare)) best = { line: L, fare, room: open ? room : 0 };
  }
  return best;
}

/** A house plans to put `q` units on the line today from `from` (keeps other houses from counting the same room). */
export function reserveLine(s: SimState, L: FreightLine, from: TownId, q: number): void {
  if (!(q > 0)) return;
  const c = scratch(s);
  const r = (c.res[L.id] ??= [0, 0]);
  r[from === L.a ? 0 : 1] += q;
}

/** Houses wanted to put `q` more units on the line than it had room for (drives its drivers). */
export function askLine(s: SimState, L: FreightLine, q: number): void {
  if (!(q > 0)) return;
  const c = scratch(s);
  c.ask[L.id] = (c.ask[L.id] || 0) + q;
}

/** Dispatch begins: planned loads become actual loads (loaded cargo is counted from the shipments). */
export function clearLineReservations(s: SimState): void {
  scratch(s).res = {};
}

/** A fare was paid to the Purse for carriage on the line. */
export function noteFare(L: FreightLine, paid: number): void {
  if (!(paid > 0)) return;
  L.fares += paid;
  L.faresToday += paid;
}

// ---------------------------------------------------------------------------
// Morning
// ---------------------------------------------------------------------------

/**
 * Morning (policyBeginDay, before the Treasury crews are set): wagons whose trip is over are
 * free; wear (WAGON_WEAR_DAY per wagon on the road + idle wear on the tools, valued at the
 * tools price in `a`); fleet = floor(tools / TOOLS_PER_WAGON); the drivers' wage; today's
 * fare; drivers wanted = wagons asked for (EMA) × LINE_DRIVER_SLACK, within [1, wagons]
 * (only those on the road while paused), never fewer than the wagons on the road.
 */
export function linesBeginDay(s: SimState): void {
  const ls = s.policy.lines;
  if (!ls || !ls.length) return;
  for (const L of ls) {
    L.carriedToday = 0;
    L.legsToday = 0;
    L.faresToday = 0;
    L.costToday = 0;
    let k = 0;
    for (let i = 0; i < L.busy.length; i++) if (L.busy[i] > s.day) L.busy[k++] = L.busy[i];
    L.busy.length = k;
    const worn = Math.min(Math.max(0, L.tools), L.busy.length * WAGON_WEAR_DAY + TOOLS_IDLE_WEAR_DAY * Math.max(0, L.tools));
    if (worn > 0) {
      L.tools -= worn;
      const v = worn * goingPrice(s, L.a, G.tools);
      L.wear += v;
      L.costToday += v;
      const acc = s.stats.acc;
      acc.line_wear = (acc.line_wear || 0) + worn;
    }
    L.wagons = Math.floor(Math.max(0, L.tools) / TOOLS_PER_WAGON + 1e-9);
    L.wage = driverWage(s, L.a);
    L.fareToday = fareFor(s, L);
    const onRoad = L.busy.length;
    let want = 0;
    if (L.enabled && L.wagons > 0) want = clamp(Math.ceil(Math.max(0, fin(L.useEma)) * LINE_DRIVER_SLACK - 0.05), 1, L.wagons);
    L.drivers = Math.max(want, onRoad);
  }
}

// ---------------------------------------------------------------------------
// Market phase: the lines' own purchases (wagons, fuel)
// ---------------------------------------------------------------------------

/** Tools the line still wants for its fleet (with a spare half wagon against wear). */
export function toolsWanted(L: FreightLine): number {
  return Math.max(0, (L.wagonsWanted + LINE_WEAR_BUFFER) * TOOLS_PER_WAGON - Math.max(0, L.tools));
}

/** Oil the line wants in store: LINE_FUEL_DAYS of expected legs, at least LINE_FUEL_MIN_LEGS per wagon. */
export function fuelWanted(s: SimState, L: FreightLine): number {
  const r = lineRoute(s, L);
  if (!r) return 0;
  const fuel = legFuel(r);
  const legsPerDay = Math.max(0, fin(L.useEma)) / Math.max(0.5, r.days);
  return Math.max(LINE_FUEL_MIN_LEGS * Math.max(L.wagons, L.wagonsWanted) * fuel, LINE_FUEL_DAYS * legsPerDay * fuel);
}

/**
 * Treasury bids (exempt, in `a`) for the tools a line's fleet lacks (at most LINE_TOOLS_DAY
 * wagons' worth a day) and the oil its store lacks, at the going price × (1 + LINE_BUY_BAND),
 * within the Purse's `budget` (auto-mint off). Returns what is left of the budget.
 */
export function lineOrders(s: SimState, books: Books, budget: number): number {
  const c = scratch(s);
  c.subs.length = 0;
  const ls = s.policy.lines;
  if (!ls || !ls.length) return budget;
  for (const L of ls) {
    if (!L.enabled || !lineRoute(s, L)) continue;
    const buy = (g: number, want: number): void => {
      const p = goingPrice(s, L.a, g) * (1 + LINE_BUY_BAND);
      if (!(p > 0) || !(want > 0.01)) return;
      const q = Math.min(want, budget / p);
      if (!(q > 0.01)) return;
      const ord = addBid(bookFor(books, L.a, g), STATE, p, q, { exempt: true, tag: L.id });
      c.subs.push({ line: L.id, good: g, ord });
      budget -= q * p;
    };
    buy(G.tools, Math.min(toolsWanted(L), LINE_TOOLS_DAY * TOOLS_PER_WAGON));
    buy(G.oil, fuelWanted(s, L) - Math.max(0, L.oil));
  }
  return budget;
}

// ---------------------------------------------------------------------------
// After clearing: stores, departures, accounts
// ---------------------------------------------------------------------------

/**
 * After clearing (end of playerAfterClear): the lines' purchases move from the Treasury's
 * stores in `a` into the lines' own (tools → wagons, oil → fuel store at its average cost);
 * then every line sends today's loads: legs a→b and b→a in whole wagons; paired legs
 * (a wagon meeting a load the other way) keep their wagons one leg, the rest two (they come
 * back empty); fuel for every loaded leg; the day's drivers' wages, fuel and wear are its
 * running cost; the EMAs of cost, units and wagons asked for move on.
 */
export function linesAfterClear(s: SimState): void {
  const ls = s.policy.lines;
  if (!ls || !ls.length) return;
  const c = scratch(s);
  const tg = s.treasury.goods;
  // ---- purchases ----
  for (const sub of c.subs) {
    const L = lineById(s, sub.line);
    const o = sub.ord;
    if (!L || !(o.filled > 0)) continue;
    const held = tg[L.a];
    if (!held) continue;
    const q = Math.min(o.filled, Math.max(0, held[sub.good]));
    if (!(q > 0)) continue;
    const paid = Math.max(0, o.paid) * (q / o.filled);
    held[sub.good] -= q;
    if (held[sub.good] < 1e-9) held[sub.good] = 0;
    if (sub.good === G.tools) {
      L.tools += q;
      L.toolsSpent += paid;
      L.wagons = Math.floor(L.tools / TOOLS_PER_WAGON + 1e-9);
    } else {
      L.oilBasis = (Math.max(0, L.oil) * fin(L.oilBasis) + paid) / Math.max(1e-9, Math.max(0, L.oil) + q);
      L.oil += q;
      L.oilSpent += paid;
    }
  }
  c.subs.length = 0;
  // ---- departures ----
  const byLine: Record<number, [number, number]> = {};
  for (const sh of s.shipments) {
    if (!(sh.line >= 0) || !departsToday(s, sh.depart)) continue;
    const L = lineById(s, sh.line);
    if (!L) continue;
    const e = (byLine[L.id] ??= [0, 0]);
    e[sh.from === L.a ? 0 : 1] += Math.max(0, sh.qty);
  }
  const acc = s.stats.acc;
  for (const L of ls) {
    const r = lineRoute(s, L);
    const [ab, ba] = byLine[L.id] ?? [0, 0];
    const lab = legsFor(ab);
    const lba = legsFor(ba);
    const legs = lab + lba;
    const out0 = L.busy.length;
    let trips = 0; // cost of today's trips (drivers' days on the road, fuel, road wear) — the 'at cost' fare
    if (r && legs > 0) {
      // fuel for every loaded leg
      const need = legs * legFuel(r);
      const burn = Math.min(need, Math.max(0, L.oil));
      L.oil = Math.max(0, L.oil - burn);
      const fc = burn * fin(L.oilBasis);
      L.fuelCost += fc;
      L.costToday += fc;
      acc.oil_burned = (acc.oil_burned || 0) + burn;
      // wagons: paired legs swap ends (one leg away), the rest return empty (two legs)
      const pairs = Math.min(lab, lba);
      for (let i = 0; i < 2 * pairs; i++) L.busy.push(s.day + r.days);
      for (let i = 0; i < legs - 2 * pairs; i++) L.busy.push(s.day + 2 * r.days);
      const wagonDays = 2 * pairs * r.days + (legs - 2 * pairs) * 2 * r.days;
      trips = fc + wagonDays * (Math.max(0, L.wage) + WAGON_WEAR_DAY * goingPrice(s, L.a, G.tools));
      // the wagons each cargo rides (for the map's convoys)
      for (const sh of s.shipments) {
        if (sh.line !== L.id || !departsToday(s, sh.depart)) continue;
        const dirQ = sh.from === L.a ? ab : ba;
        const dirL = sh.from === L.a ? lab : lba;
        sh.wagons = dirQ > 0 ? (dirL * Math.max(0, sh.qty)) / dirQ : 1;
      }
      acc.wagons_sent = (acc.wagons_sent || 0) + legs;
    }
    L.legsToday = legs;
    L.legs += legs;
    L.carriedToday = ab + ba;
    L.carried += ab + ba;
    acc.line_units = (acc.line_units || 0) + ab + ba;
    // drivers: the line's share of the depot crew, at what the crew was paid today
    const crew = crewOf(s, L);
    L.crew = crew;
    const sw = crew > 0 ? stateworksIn(s, L.a) : undefined;
    const perHead = sw && sw.workers.length > 0 ? Math.max(0, fin(sw.wageBill)) / sw.workers.length : 0;
    const wages = crew * perHead;
    L.wages += wages;
    L.costToday += wages;
    acc.line_crew = (acc.line_crew || 0) + crew;
    // the line's transport service (real output: its running cost)
    acc.freight_cost = (acc.freight_cost || 0) + L.costToday;
    // EMAs
    L.costEma = ema(fin(L.costEma), trips, LINE_COST_EMA);
    L.unitsEma = ema(fin(L.unitsEma), L.carriedToday, LINE_COST_EMA);
    const asked = legs + (c.ask[L.id] || 0) / WAGON_CAPACITY;
    L.useEma = ema(fin(L.useEma), Math.min(L.wagons + 2, out0 + asked), LINE_USE_EMA);
  }
}

// ---------------------------------------------------------------------------
// Opening, resizing, closing (player.ts validates and calls these)
// ---------------------------------------------------------------------------

/** Move tools the Treasury holds in `a` into the line, up to what its fleet wants. Returns units taken. */
export function takeStoredTools(s: SimState, L: FreightLine): number {
  const held = s.treasury.goods[L.a];
  if (!held) return 0;
  const q = Math.min(toolsWanted(L), Math.max(0, held[G.tools]) - reservedByRoutes(s, L.a));
  if (!(q > 1e-9)) return 0;
  held[G.tools] -= q;
  if (held[G.tools] < 1e-9) held[G.tools] = 0;
  L.tools += q;
  L.wagons = Math.floor(L.tools / TOOLS_PER_WAGON + 1e-9);
  return q;
}

/** Tools in a town's stores that a Treasury supply route bought and still has to carry away. */
function reservedByRoutes(s: SimState, town: TownId): number {
  let n = 0;
  for (const o of s.policy.orders as PlayerOrder[]) {
    if (!o.route || o.market.kind !== 'good' || o.market.town !== town || o.market.good !== G.tools) continue;
    n += Math.max(0, o.filled - o.route.shippedTotal);
  }
  return n;
}

/**
 * Hand back to the Treasury's stores in `a` the tools beyond what the fleet wants (wagons on
 * the road excepted: they come back first). Returns units handed back.
 */
export function returnSpareTools(s: SimState, L: FreightLine): number {
  const keep = (Math.max(L.wagonsWanted, L.busy.length) + LINE_WEAR_BUFFER) * TOOLS_PER_WAGON;
  const q = Math.max(0, L.tools - keep);
  if (!(q > 1e-9)) return 0;
  L.tools -= q;
  L.wagons = Math.floor(L.tools / TOOLS_PER_WAGON + 1e-9);
  addStore(s, L.a, G.tools, q);
  return q;
}

/** Close the line: its tools and fuel go to the Treasury's stores in `a`. Returns [tools, oil] handed back. */
export function windUpLine(s: SimState, L: FreightLine): [number, number] {
  const tools = Math.max(0, L.tools);
  const oil = Math.max(0, L.oil);
  addStore(s, L.a, G.tools, tools);
  addStore(s, L.a, G.oil, oil);
  L.tools = 0;
  L.oil = 0;
  L.wagons = 0;
  L.busy = [];
  L.drivers = 0;
  L.enabled = false;
  return [tools, oil];
}

function addStore(s: SimState, town: TownId, g: number, q: number): void {
  if (!(q > 0)) return;
  const tg = s.treasury.goods;
  while (tg.length <= town) tg.push(new Array(N_GOODS).fill(0));
  tg[town][g] += q;
}

/** Lifetime running cost (drivers, fuel burnt, wear) and result (fares less that cost). */
export function lineResult(L: FreightLine): { cost: number; result: number } {
  const cost = fin(L.wages) + fin(L.fuelCost) + fin(L.wear);
  return { cost, result: fin(L.fares) - cost };
}
