// Treasury freight lines (s.policy.lines): Treasury wagons, driven by Treasury workers of the
// depot town and burning oil bought there, carry the trading houses' goods between two towns for
// a fare. Built from record factories with the roads injected into the runtime cache (as in
// traders.test.ts); the save/load round trip uses a generated world.
import { describe, expect, it } from 'vitest';
import { firmsPayWages } from '../src/sim/agents/firms';
import { laborMarket } from '../src/sim/agents/labor';
import { freightPerUnit, traderOrders, tradersBeginDay, tradersDispatch } from '../src/sim/agents/traders';
import { LINE_WEAR_BUFFER, OIL_PER_TILE, TOOLS_PER_WAGON, WAGON_CAPACITY } from '../src/sim/config';
import { newFirm, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { Game } from '../src/sim/game';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger, reconcileBank } from '../src/sim/ledger';
import { addAsk, bookFor, clearAll, marketOf, openBooks, type Books } from '../src/sim/market/markets';
import { describeLine, dispatch, playerAfterClear, playerOrders, policyBeginDay } from '../src/sim/policy/player';
import { costPerUnit, crewOf, lineById, lineRoom, staffLines } from '../src/sim/policy/lines';
import { rt, type Route } from '../src/sim/runtime';
import { deserialize } from '../src/sim/save';
import { activeLines, routeLabel } from '../src/ui/map/routes';
import { FIRM_BASE, STATE, type Firm, type FreightLine, type MapData, type SimState } from '../src/sim/types';

const FORBIDDEN = /\b(tax|taxes|subsid\w*|tariff\w*|quota\w*|stimulus|bailout|minimum wage|UBI|QE|quantitative|public transit|nationali[sz]ed|state[- ]owned)\b/i;
const PRICES = [2.6, 3.0, 2.6, 2.6, 2.6, 3.2, 13, 20, 4, 2.8, 22];

function tinyMap(): MapData {
  const w = 60;
  const h = 10;
  const n = w * h;
  const z = () => new Array(n).fill(0);
  return { w, h, terrain: new Array(n).fill(3), elev: z(), fert: z(), deposit: z(), river: z(), road: new Array(n).fill(1), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

function setRoute(s: SimState, a: number, b: number, length: number, days: number): void {
  const r = rt(s);
  const mk = (from: number, to: number): Route => ({ from, to, tiles: [], length, paved: 0, dirt: length, offroad: 0, days });
  r.routes.set(a + '>' + b, mk(a, b));
  r.routes.set(b + '>' + a, mk(b, a));
}

interface World {
  s: SimState;
  trader: Firm;
  farm: Firm;
  crew: Firm;
}

/**
 * Millbrook (0) ↔ Kingsbridge (1): 40 tiles, 2 days. Millbrook has a trading house (6 wagons),
 * a farm with grain to sell and a Treasury workforce of 6. Grain is cheap in Millbrook (¤1) and
 * dear in Kingsbridge (¤6). Hollow (2) is out of wagon reach.
 */
function world(): World {
  const s = newSimState(5, tinyMap());
  s.towns.push(newTown(0, 'Millbrook', 'farm', 5, 5, 3));
  s.towns.push(newTown(1, 'Kingsbridge', 'capital', 45, 5, 3));
  s.towns.push(newTown(2, 'Hollow', 'mining', 55, 5, 3));
  s.treasury = newTreasury(3);
  for (let t = 0; t < 3; t++) for (let g = 0; g < N_GOODS; g++) s.markets.push(newMarket(t, g, PRICES[g]));
  setRoute(s, 0, 1, 40, 2);
  setRoute(s, 0, 2, 400, 50); // too slow for wagons
  setRoute(s, 1, 2, 400, 50);
  const owner = newPerson(s, 0, 'Owner');
  const trader = newFirm(s, 'trader', 0, -1, owner.id, 'Trading House');
  trader.wage = 10;
  trader.cash = 5000;
  trader.tools = 6.5 * TOOLS_PER_WAGON;
  trader.inv[G.oil] = 60;
  trader.capacity = 24;
  for (let i = 0; i < 6; i++) {
    const p = newPerson(s, 0, 'Carter' + i);
    p.job = trader.id;
    trader.workers.push(p.id);
  }
  const farm = newFirm(s, 'farm', 0, -1, owner.id, 'Farm');
  farm.inv[G.grain] = 2000;
  const crew = newFirm(s, 'stateworks', 0, -1, STATE, 'Millbrook Treasury Works');
  crew.capacity = 100000;
  crew.wage = 9;
  for (let i = 0; i < 6; i++) {
    const p = newPerson(s, 0, 'Driver' + i);
    p.job = crew.id;
    p.wage = 9;
    crew.workers.push(p.id);
  }
  s.markets[0 * N_GOODS + G.grain].ema = 1.0;
  s.markets[1 * N_GOODS + G.grain].ema = 6.0;
  s.markets[0 * N_GOODS + G.grain].volEma = 200;
  s.markets[1 * N_GOODS + G.grain].volEma = 200;
  s.treasury.autoMint = true;
  s.bank.reserves = 1e5;
  reconcileBank(s);
  return { s, trader, farm, crew };
}

/** One day by hand: the engine's order for the parts that matter here, then day += 1. */
function day(w: World, orders?: (books: Books) => void): void {
  const { s, farm } = w;
  policyBeginDay(s);
  staffLines(s); // drivers posted from the crew (the engine: after the labour market)
  tradersBeginDay(s);
  firmsPayWages(s);
  const books = openBooks(s);
  // the farm offers grain at home every day
  addAsk(bookFor(books, 0, G.grain), FIRM_BASE + farm.id, 1.0, Math.min(200, farm.inv[G.grain]));
  traderOrders(s, books);
  orders?.(books);
  playerOrders(s, books);
  clearAll(s, books);
  tradersDispatch(s, books);
  playerAfterClear(s, books);
  s.day += 1;
}

const line = (s: SimState, id: number): FreightLine => lineById(s, id)!;
const onLine = (s: SimState, id: number) => s.shipments.filter((x) => x.line === id);
const ledgerOk = (s: SimState) => expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);

/** Open a Millbrook ⇄ Kingsbridge line with its wagons from the Treasury's stores and a store of fuel. */
function openStocked(w: World, fare: 'fixed' | 'cost' | 'free', farePrice?: number, wagons = 2): FreightLine {
  w.s.treasury.goods[0][G.tools] = 100;
  const r = dispatch(w.s, { type: 'openLine', a: 0, b: 1, wagons, fare, farePrice });
  expect(r.ok, r.message).toBe(true);
  const L = line(w.s, r.id!);
  L.oil = 20; // a store of fuel (a line normally buys it in its depot's market)
  L.oilBasis = PRICES[G.oil];
  return L;
}

describe('freight lines — opening', () => {
  it('validates the line and describes it neutrally', () => {
    const w = world();
    const { s } = w;
    const ok = { type: 'openLine' as const, a: 0, b: 1, wagons: 3, fare: 'free' as const };
    expect(dispatch(s, { ...ok, a: 0, b: 0 }).ok).toBe(false);
    expect(dispatch(s, { ...ok, b: 7 }).ok).toBe(false);
    expect(dispatch(s, { ...ok, b: 2 }).ok).toBe(false); // no wagon road
    expect(dispatch(s, { ...ok, wagons: 0 }).ok).toBe(false);
    expect(dispatch(s, { ...ok, wagons: 1.5 }).ok).toBe(false);
    expect(dispatch(s, { ...ok, wagons: 61 }).ok).toBe(false);
    expect(dispatch(s, { ...ok, fare: 'cheap' as never }).ok).toBe(false);
    expect(dispatch(s, { ...ok, fare: 'fixed' }).ok).toBe(false); // no fare given
    expect(dispatch(s, { ...ok, fare: 'fixed', farePrice: -1 }).ok).toBe(false);
    expect(s.policy.lines.length).toBe(0);

    s.treasury.goods[0][G.tools] = 5;
    const r = dispatch(s, { ...ok, fare: 'fixed', farePrice: 0.4 });
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/^The Treasury runs a freight line between Millbrook and Kingsbridge: 3 wagons kept in Millbrook, driven by Treasury workers hired there as the loads need them, burning oil bought there\. Trading houses of both towns may load their goods onto it and pay ¤0\.40 a unit carried/);
    expect(r.message).toMatch(/takes 5 sets of tools from the Treasury's stores in Millbrook/);
    const L = line(s, r.id!);
    expect(L).toMatchObject({ a: 0, b: 1, wagonsWanted: 3, fare: 'fixed', farePrice: 0.4, enabled: true, tools: 5, wagons: 1, carried: 0, fares: 0 });
    expect(s.treasury.goods[0][G.tools]).toBe(0);
    expect(L.label).toBe('Freight line Millbrook ⇄ Kingsbridge');
    // one line per pair of towns, whichever way round
    expect(dispatch(s, { ...ok, a: 1, b: 0 }).ok).toBe(false);
    for (const x of [r.message, describeLine(s, { ...L, fare: 'cost' }), describeLine(s, { ...L, fare: 'free', enabled: false })]) expect(x).not.toMatch(FORBIDDEN);
    for (const n of s.news) expect(n.text).not.toMatch(FORBIDDEN);
    expect(describeLine(s, { ...L, fare: 'free' })).toMatch(/pay nothing/);
    expect(describeLine(s, { ...L, fare: 'cost' })).toMatch(/pay what the line costs to run per unit carried/);
  });

  it('buys its wagons and fuel in the depot town with exempt Treasury bids, and hires its drivers from the Treasury crew there', () => {
    const w = world();
    const { s, crew, farm } = w;
    const id = dispatch(s, { type: 'openLine', a: 0, b: 1, wagons: 2, fare: 'free' }).id!;
    const L = line(s, id);
    expect(L.tools).toBe(0);
    farm.inv[G.tools] = 50;
    farm.inv[G.oil] = 50;
    const purse0 = s.treasury.purse - s.treasury.minted;
    const crewPay = crew.workers.length * crew.wage; // the crew is paid in the morning (no labour order: idle)
    day(w, (b) => {
      addAsk(bookFor(b, 0, G.tools), FIRM_BASE + farm.id, 15, 50);
      addAsk(bookFor(b, 0, G.oil), FIRM_BASE + farm.id, 2, 50);
      const tb = bookFor(b, 0, G.tools).bids.filter((o) => o.ref === STATE);
      expect(tb.length).toBe(0); // placed in playerOrders, after this hook
    });
    // the bids cleared in Millbrook's markets and the goods went to the line, not to the Treasury's stores
    expect(L.tools).toBeCloseTo(2 * TOOLS_PER_WAGON, 6); // LINE_TOOLS_DAY wagons' worth a day
    expect(L.wagons).toBe(2);
    expect(L.oil).toBeGreaterThan(0);
    expect(s.treasury.goods[0][G.tools]).toBe(0);
    expect(s.treasury.goods[0][G.oil]).toBe(0);
    const pT = marketOf(s, 0, G.tools).price;
    expect(L.toolsSpent).toBeCloseTo(2 * TOOLS_PER_WAGON * pT, 6);
    expect(s.treasury.purse - s.treasury.minted - purse0).toBeCloseTo(-(L.toolsSpent + L.oilSpent + crewPay), 6);
    ledgerOk(s);
    // the next morning it wants drivers: the depot's crew is asked for them, at the line's wage at least
    policyBeginDay(s);
    expect(L.drivers).toBeGreaterThanOrEqual(1);
    expect(L.drivers).toBeLessThanOrEqual(L.wagons);
    expect(crew.target).toBe(L.drivers);
    expect(crew.wage).toBeCloseTo(Math.max(9, L.wage), 9);
    staffLines(s);
    expect(crewOf(s, L)).toBe(L.drivers);
    expect(L.staff.length).toBe(L.drivers);
    // the rest of the wagons' tools come on the following days (a spare half wagon against wear)
    for (let i = 0; i < 3; i++) day(w, (b) => addAsk(bookFor(b, 0, G.tools), FIRM_BASE + farm.id, 15, 50));
    expect(L.tools).toBeCloseTo((2 + LINE_WEAR_BUFFER) * TOOLS_PER_WAGON, 1);
    ledgerOk(s);
  });

  it('its drivers are posted first and kept: a labour order gets the rest, and a smaller works crew never costs the line its drivers', () => {
    const w = world();
    const { s, crew } = w;
    const L = openStocked(w, 'free', undefined, 4);
    const oid = dispatch(s, { type: 'placeOrder', market: { kind: 'labor', town: 0 }, side: 'buy', price: 12, qty: 5 }).id!;
    policyBeginDay(s);
    expect(crew.target).toBe(5 + L.drivers);
    expect(crew.wage).toBe(12); // one wage for the crew: the highest offered
    staffLines(s);
    expect(crewOf(s, L)).toBe(L.drivers); // 6 workers: the line's drivers first, the rest on the works
    const drivers = L.staff.slice();
    // the same people stay posted day after day
    policyBeginDay(s);
    staffLines(s);
    expect(L.staff).toEqual(drivers);
    // the works crew is withdrawn: the crew shrinks to the line's drivers, and they are the ones kept
    dispatch(s, { type: 'cancelOrder', id: oid });
    policyBeginDay(s);
    laborMarket(s);
    staffLines(s);
    expect(crew.workers.length).toBe(L.drivers);
    expect(L.staff.slice().sort()).toEqual(drivers.slice().sort());
  });

  it('permanent drivers: one a wagon, kept while the line is paused', () => {
    const w = world();
    const { s } = w;
    w.s.treasury.goods[0][G.tools] = 100;
    expect(dispatch(s, { type: 'openLine', a: 0, b: 1, wagons: 3, fare: 'free', staffing: 'sometimes' as never }).ok).toBe(false);
    const r = dispatch(s, { type: 'openLine', a: 0, b: 1, wagons: 3, fare: 'free', staffing: 'permanent' });
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/each with its own driver, a Treasury worker hired there and kept on/);
    const L = line(s, r.id!);
    policyBeginDay(s);
    staffLines(s);
    expect(L.drivers).toBe(3);
    expect(L.staff.length).toBe(3);
    dispatch(s, { type: 'updateLine', id: L.id, patch: { enabled: false } });
    policyBeginDay(s);
    staffLines(s);
    expect(L.staff.length).toBe(3); // paused, still kept on
    expect(dispatch(s, { type: 'updateLine', id: L.id, patch: { staffing: 'asNeeded', enabled: true } }).ok).toBe(true);
    policyBeginDay(s);
    staffLines(s);
    expect(L.staff.length).toBe(L.drivers);
    expect(L.drivers).toBeLessThanOrEqual(3);
    // closing lets its posts go
    dispatch(s, { type: 'closeLine', id: L.id });
    expect(L.staff).toEqual([]);
  });
});

describe('freight lines — carrying', () => {
  it('a trading house puts its goods on the line when the fare is below its own freight, and pays the fare to the Purse', () => {
    const w = world();
    const { s, trader } = w;
    const own = freightPerUnit(s, 0, 1);
    const L = openStocked(w, 'fixed', 0.05);
    expect(0.05).toBeLessThan(own);
    const cash0 = trader.cash;
    const fares0 = s.treasury.flows.fare ?? 0;
    const carters = trader.workers.length * trader.wage; // its carters are paid in the morning
    day(w);
    const sh = onLine(s, L.id);
    expect(sh.length).toBeGreaterThan(0);
    const q = sh.reduce((a, x) => a + x.qty, 0);
    expect(q).toBeGreaterThan(10);
    for (const x of sh) {
      expect(x.owner).toBe(FIRM_BASE + trader.id); // the goods stay the house's
      expect(x.from).toBe(0);
      expect(x.to).toBe(1);
      expect(x.good).toBe(G.grain);
    }
    // the fare: from the house to the Purse, booked to the line
    expect(L.fares).toBeCloseTo(0.05 * q, 6);
    expect(L.faresToday).toBeCloseTo(0.05 * q, 6);
    expect((s.treasury.flows.fare ?? 0) - fares0).toBeCloseTo(0.05 * q, 6);
    const paidGrain = marketOf(s, 0, G.grain).price * q;
    expect(cash0 - trader.cash).toBeCloseTo(paidGrain + 0.05 * q + carters, 4);
    expect(sh[0].basis).toBeCloseTo(marketOf(s, 0, G.grain).price + 0.05, 6);
    // the line's wagons left (whole wagons, one leg each way: out loaded, back empty), its fuel was burnt
    const legs = Math.ceil(q / WAGON_CAPACITY - 1e-9);
    expect(L.legsToday).toBe(legs);
    expect(L.carriedToday).toBeCloseTo(q, 6);
    expect(L.busy.length).toBe(legs);
    expect(L.oil).toBeCloseTo(20 - legs * OIL_PER_TILE * 40, 9);
    expect(L.fuelCost).toBeCloseTo(legs * OIL_PER_TILE * 40 * PRICES[G.oil], 6);
    // the house's own wagons stayed at home
    expect(trader.trade!.busy.length).toBe(0);
    ledgerOk(s);
    // two days later the goods land in the house's stock at Kingsbridge
    day(w);
    day(w);
    expect(trader.trade!.stock[1][G.grain]).toBeGreaterThan(q - 1e-6);
    expect(L.carried).toBeGreaterThan(q);
    ledgerOk(s);
  });

  it('a house keeps to its own wagons when the fare is above its own freight', () => {
    const w = world();
    const { s, trader } = w;
    const own = freightPerUnit(s, 0, 1);
    const L = openStocked(w, 'fixed', 3 * own + 1);
    day(w);
    expect(onLine(s, L.id).length).toBe(0);
    expect(L.fares).toBe(0);
    expect(s.shipments.filter((x) => x.owner === FIRM_BASE + trader.id).length).toBeGreaterThan(0);
    expect(trader.trade!.busy.length).toBeGreaterThan(0);
    // …and switches to the line once the fare comes down
    dispatch(s, { type: 'updateLine', id: L.id, patch: { fare: 'free' } });
    for (let i = 0; i < 4 && onLine(s, L.id).length === 0; i++) day(w);
    expect(onLine(s, L.id).length).toBeGreaterThan(0);
    expect(L.fares).toBe(0);
    ledgerOk(s);
  });

  it('never loads more than its room: free wagons, drivers and fuel', () => {
    const w = world();
    const { s } = w;
    const L = openStocked(w, 'free', undefined, 1);
    L.oil = 1.6; // fuel for one leg (40 tiles)
    policyBeginDay(s);
    staffLines(s);
    expect(lineRoom(s, L, 0)).toBeCloseTo(WAGON_CAPACITY, 9);
    L.oil = 1.5;
    expect(lineRoom(s, L, 0)).toBe(0);
    L.oil = 1.6;
    // a busy trader: the line fills its one wagon and no more
    s.markets[1 * N_GOODS + G.grain].volEma = 2000;
    s.markets[0 * N_GOODS + G.grain].volEma = 2000;
    s.day -= 0; // (same day)
    const books = openBooks(s);
    addAsk(bookFor(books, 0, G.grain), FIRM_BASE + w.farm.id, 1.0, 1000);
    tradersBeginDay(s);
    traderOrders(s, books);
    playerOrders(s, books);
    clearAll(s, books);
    tradersDispatch(s, books);
    playerAfterClear(s, books);
    const q = onLine(s, L.id).reduce((a, x) => a + x.qty, 0);
    expect(q).toBeGreaterThan(0);
    expect(q).toBeLessThanOrEqual(WAGON_CAPACITY + 1e-6);
    expect(L.legsToday).toBe(1);
    expect(L.oil).toBeCloseTo(0, 9);
    ledgerOk(s);
  });

  it('carries the Treasury’s own goods without a fare (a carry, once)', () => {
    const w = world();
    const { s, trader } = w;
    const L = openStocked(w, 'fixed', 0.5);
    policyBeginDay(s); // wagons, drivers
    staffLines(s);
    s.treasury.goods[0][G.bread] = 50;
    const cash0 = trader.cash;
    const purse0 = s.treasury.purse - s.treasury.minted;
    const r = dispatch(s, { type: 'carry', from: 0, to: 1, good: G.bread, qty: 50, once: true });
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/on the Treasury's freight line/);
    expect(r.message).not.toMatch(FORBIDDEN);
    const sh = onLine(s, L.id);
    expect(sh.length).toBe(1);
    expect(sh[0].owner).toBe(STATE);
    expect(sh[0].qty).toBeCloseTo(50);
    expect(sh[0].basis).toBeCloseTo(costPerUnit(s, L), 9); // a carry keeps no purchase cost: the cargo's basis is the line's cost per unit
    expect(costPerUnit(s, L)).toBeGreaterThan(0);
    expect(trader.cash).toBe(cash0); // the trading house was not paid
    expect(s.treasury.purse - s.treasury.minted).toBeCloseTo(purse0, 9);
    ledgerOk(s);
  });
});

describe('freight lines — pausing and closing', () => {
  it('a paused line takes no loads; closing hands its wagons and fuel to the Treasury’s stores', () => {
    const w = world();
    const { s, crew } = w;
    const L = openStocked(w, 'free');
    day(w);
    expect(onLine(s, L.id).length).toBeGreaterThan(0);
    expect(dispatch(s, { type: 'updateLine', id: L.id, patch: { enabled: false } }).message).toBe('Line paused.');
    const n = onLine(s, L.id).length;
    day(w);
    expect(onLine(s, L.id).length).toBeLessThanOrEqual(n); // nothing new loaded
    expect(L.carriedToday).toBe(0);
    expect(lineRoom(s, L, 0)).toBe(0);
    // shrinking the fleet hands back the spare tools at once
    expect(dispatch(s, { type: 'updateLine', id: L.id, patch: { enabled: true } }).ok).toBe(true);
    const upd = dispatch(s, { type: 'updateLine', id: L.id, patch: { wagons: 1 } });
    expect(upd.ok, upd.message).toBe(true);
    expect(L.tools).toBeLessThanOrEqual(Math.max(1, L.busy.length) * TOOLS_PER_WAGON + LINE_WEAR_BUFFER * TOOLS_PER_WAGON + 1e-9);
    expect(dispatch(s, { type: 'updateLine', id: L.id, patch: { wagons: 0 } }).ok).toBe(false);
    const heldTools = s.treasury.goods[0][G.tools];
    const lineTools = L.tools;
    const lineOil = L.oil;
    const oil0 = s.treasury.goods[0][G.oil];
    const r = dispatch(s, { type: 'closeLine', id: L.id });
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/has closed its freight line between Millbrook and Kingsbridge/);
    expect(r.message).not.toMatch(FORBIDDEN);
    expect(s.policy.lines.length).toBe(0);
    expect(s.treasury.goods[0][G.tools]).toBeCloseTo(heldTools + lineTools, 9);
    expect(s.treasury.goods[0][G.oil]).toBeCloseTo(oil0 + lineOil, 9);
    // every tool the line had comes back, less what wore out on the road
    expect(s.treasury.goods[0][G.tools]).toBeLessThan(100);
    expect(s.treasury.goods[0][G.tools]).toBeGreaterThan(99);
    // the crew no longer keeps drivers for it
    policyBeginDay(s);
    expect(crew.target).toBe(0);
    expect(dispatch(s, { type: 'closeLine', id: L.id }).ok).toBe(false);
    // goods already on the road still arrive
    for (let i = 0; i < 3; i++) day(w);
    expect(s.shipments.filter((x) => x.line === L.id).length).toBe(0);
    ledgerOk(s);
  });
});

describe('freight lines — on the map', () => {
  it('draws a running line both ways on the next free lanes, with one pill', () => {
    const w = world();
    const { s } = w;
    expect(activeLines(s)).toEqual([]);
    const L = openStocked(w, 'free', undefined, 3);
    day(w);
    const lanes = new Map<string, number>([['0>1', 1]]); // a carry rule already on the road 0 → 1
    const r = activeLines(s, lanes);
    expect(r.length).toBe(2);
    expect(r.map((x) => [x.from, x.to, x.lane, x.pill, x.order])).toEqual([
      [0, 1, 1, true, L.id],
      [1, 0, 0, false, L.id],
    ]);
    expect(r[0].line).toBe(true);
    expect(routeLabel(r[0], 'Kingsbridge')).toBe(`freight line ⇄ Kingsbridge · ${r[0].out}/${L.wagons} out`);
    // closed: nothing to draw
    dispatch(s, { type: 'closeLine', id: L.id });
    expect(activeLines(s)).toEqual([]);
  });
});

describe('freight lines — saving and loading', () => {
  it('a game saved with a line running continues exactly as the original; older saves load without lines', () => {
    const g = Game.create({ seed: 2, warmup: false });
    g.dispatch({ type: 'setEvents', value: false });
    g.dispatch({ type: 'setAutoMint', value: true });
    g.step(10);
    const s = g.s;
    const cap = s.towns.find((t) => t.kind === 'capital')!.id;
    const farm = s.towns.find((t) => t.kind === 'farm')!.id;
    const r = g.dispatch({ type: 'openLine', a: cap, b: farm, wagons: 4, fare: 'cost' });
    expect(r.ok, r.message).toBe(true);
    // (saved and compared within one month: housing reports a month's evictions from a runtime tally)
    g.step(5);
    const L = s.policy.lines.find((x) => x.id === r.id)!;
    expect(L.wagons).toBeGreaterThan(0);
    const json = g.save();
    const copy = Game.load(json);
    copy.step(12);
    g.step(12);
    expect(copy.save()).toBe(g.save());
    expect(Math.abs(checkLedger(copy.s))).toBeLessThan(1e-6 * Math.max(1, s.bank.reserves));
    expect(copy.s.policy.lines[0].id).toBe(r.id);

    // A save from before freight lines: no policy.lines, no Shipment.line.
    const raw = JSON.parse(json);
    delete raw.policy.lines;
    for (const sh of raw.shipments) delete sh.line;
    const old = deserialize(JSON.stringify(raw));
    expect(old.policy.lines).toEqual([]);
    expect(old.shipments.every((x) => x.line === -1)).toBe(true);
    // A damaged line is repaired, or dropped with its wagons handed to the Treasury's stores
    const raw2 = JSON.parse(json);
    raw2.policy.lines[0].fares = null;
    raw2.policy.lines[0].fare = 'nonsense';
    const fixed = deserialize(JSON.stringify(raw2));
    expect(fixed.policy.lines[0].fares).toBe(0);
    expect(fixed.policy.lines[0].fare).toBe('cost');
    const tools = raw2.policy.lines[0].tools as number;
    const held = raw2.treasury.goods[cap][G.tools] as number;
    raw2.policy.lines[0].b = 99;
    const dropped = deserialize(JSON.stringify(raw2));
    expect(dropped.policy.lines.length).toBe(0);
    expect(dropped.treasury.goods[cap][G.tools]).toBeCloseTo(held + tools, 9);
  });
});
