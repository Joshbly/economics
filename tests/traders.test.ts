// Trading houses: freight formula, arbitrage bids, dispatch, delivery, Treasury cargo, quotas.
// Built from record factories; routes are injected into the runtime cache so the test
// does not depend on map generation.
import { beforeEach, describe, expect, it } from 'vitest';
import { freightPerUnit, shipTreasuryGoods, traderOrders, tradersBeginDay, tradersDispatch } from '../src/sim/agents/traders';
import { OIL_PER_TILE, TOOLS_PER_WAGON, WAGON_CAPACITY, WAGON_WEAR_DAY } from '../src/sim/config';
import { newFirm, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger, mint, reconcileBank } from '../src/sim/ledger';
import { addAsk, bookFor, clearAll, openBooks } from '../src/sim/market/markets';
import { rt, type Route } from '../src/sim/runtime';
import { FIRM_BASE, STATE, type Firm, type Levy, type Limit, type MapData, type SimState } from '../src/sim/types';
import { routeBetweenTowns } from '../src/sim/world/paths';

function tinyMap(): MapData {
  const w = 60;
  const h = 10;
  const n = w * h;
  const z = () => new Array(n).fill(0);
  return { w, h, terrain: new Array(n).fill(3), elev: z(), fert: z(), deposit: z(), river: z(), road: new Array(n).fill(1), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

const PRICES = [2.6, 3.0, 2.6, 2.6, 2.6, 3.2, 13, 20, 4, 2.8, 22];

function setRoute(s: SimState, a: number, b: number, length: number, days: number): void {
  const r = rt(s);
  const mk = (from: number, to: number): Route => ({ from, to, tiles: [], length, paved: 0, dirt: length, offroad: 0, days });
  r.routes.set(a + '>' + b, mk(a, b));
  r.routes.set(b + '>' + a, mk(b, a));
}

let s: SimState;
let trader: Firm;

function world(): SimState {
  const st = newSimState(5, tinyMap());
  st.towns.push(newTown(0, 'Millbrook', 'farm', 5, 5, 3));
  st.towns.push(newTown(1, 'Kingsbridge', 'capital', 45, 5, 3));
  st.treasury = newTreasury(2);
  for (let t = 0; t < 2; t++) for (let g = 0; g < N_GOODS; g++) st.markets.push(newMarket(t, g, PRICES[g]));
  setRoute(st, 0, 1, 40, 2);
  return st;
}

function makeTrader(st: SimState, town: number, wagons: number): Firm {
  const owner = newPerson(st, town, 'Owner');
  const f = newFirm(st, 'trader', town, -1, owner.id, 'Trading House');
  f.wage = 10;
  f.cash = 5000;
  f.tools = (wagons + 0.5) * TOOLS_PER_WAGON;
  f.inv[G.oil] = 60;
  f.capacity = 24;
  for (let i = 0; i < wagons; i++) {
    const p = newPerson(st, town, 'Carter' + i);
    p.job = f.id;
    f.workers.push(p.id);
  }
  return f;
}

function levy(over: Partial<Levy>): Levy {
  return {
    id: 700,
    label: 'test',
    enabled: true,
    dir: 1,
    base: 'sale',
    unit: 'pct',
    rate: 0.5,
    payer: 'buyer',
    threshold: 0,
    good: -1,
    town: -1,
    toTown: -1,
    sector: 'any',
    group: 'all',
    buildingKind: 'any',
    created: 0,
    until: -1,
    today: 0,
    month: 0,
    lastMonth: 0,
    total: 0,
    ...over,
  };
}

beforeEach(() => {
  s = world();
  trader = makeTrader(s, 0, 6);
  s.bank.reserves = 1e5;
  reconcileBank(s);
});

describe('freight', () => {
  it('follows (wage × round-trip days + oil × fuel + wagon wear) / capacity', () => {
    const r = routeBetweenTowns(s, 0, 1);
    const expected = (10 * 2 * r.days + PRICES[G.oil] * OIL_PER_TILE * r.length * 2 + WAGON_WEAR_DAY * 2 * r.days * PRICES[G.tools]) / WAGON_CAPACITY;
    expect(freightPerUnit(s, 0, 1)).toBeCloseTo(expected, 10);
  });

  it('rises with an oil levy and falls with a faster road', () => {
    const f0 = freightPerUnit(s, 0, 1);
    s.policy.levies.push(levy({ good: G.oil, town: 0 }));
    const f1 = freightPerUnit(s, 0, 1);
    const r = routeBetweenTowns(s, 0, 1);
    expect(f1 - f0).toBeCloseTo((0.5 * PRICES[G.oil] * OIL_PER_TILE * r.length * 2) / WAGON_CAPACITY, 10);
    s.policy.levies.length = 0;
    rt(s).routes.clear();
    setRoute(s, 0, 1, 40, 0.9); // paved: under half the days
    expect(freightPerUnit(s, 0, 1)).toBeLessThan(f0 * 0.6);
  });
});

describe('arbitrage', () => {
  function spread(): void {
    s.markets[0 * N_GOODS + G.grain].ema = 1.0; // cheap at home
    s.markets[1 * N_GOODS + G.grain].ema = 6.0; // dear in the capital
    s.markets[1 * N_GOODS + G.grain].volEma = 200;
  }

  it('a profitable spread creates a destination-tagged bid, a shipment, fuel burn and busy wagons', () => {
    spread();
    tradersBeginDay(s);
    expect(trader.trade!.wagons).toBe(6);
    expect(trader.target).toBeGreaterThanOrEqual(1);
    const books = openBooks(s);
    traderOrders(s, books);
    const ref = FIRM_BASE + trader.id;
    const bids = bookFor(books, 0, G.grain).bids.filter((o) => o.ref === ref);
    expect(bids.length).toBeGreaterThan(0);
    expect(bids.every((o) => o.tag === 1)).toBe(true);
    const planned = bids.reduce((a, o) => a + o.qty, 0);
    expect(planned).toBeCloseTo(0.35 * 200, 6); // TRADE_DEST_ABSORB × destination volume
    const top = Math.max(...bids.map((o) => o.limit));
    expect(top).toBeLessThan(6.0);
    expect(top).toBeGreaterThan(1.0);

    // A farm sells grain at home.
    const owner = newPerson(s, 0, 'Farmer');
    const farm = newFirm(s, 'farm', 0, -1, owner.id, 'Farm');
    farm.inv[G.grain] = 500;
    addAsk(bookFor(books, 0, G.grain), FIRM_BASE + farm.id, 1.0, 500);
    const cash0 = trader.cash;
    clearAll(s, books);
    expect(trader.inv[G.grain]).toBeCloseTo(planned, 6);
    expect(trader.cash).toBeCloseTo(cash0 - planned * 1.0, 6);

    const oil0 = trader.inv[G.oil];
    tradersDispatch(s, books);
    expect(s.shipments.length).toBe(1);
    const sh = s.shipments[0];
    expect(sh.owner).toBe(ref);
    expect(sh.from).toBe(0);
    expect(sh.to).toBe(1);
    expect(sh.good).toBe(G.grain);
    expect(sh.qty).toBeCloseTo(planned, 6);
    expect(sh.wagons).toBe(Math.ceil(planned / WAGON_CAPACITY));
    expect(sh.arrive).toBeCloseTo(s.day + 0.5 + 2, 10);
    // landed cost = purchase price + freight for the wagons used
    const tripCost = freightPerUnit(s, 0, 1) * WAGON_CAPACITY * sh.wagons;
    expect(sh.basis).toBeCloseTo(1.0 + tripCost / sh.qty, 6);
    expect(trader.inv[G.grain]).toBeCloseTo(0, 6);
    expect(oil0 - trader.inv[G.oil]).toBeCloseTo(sh.wagons * OIL_PER_TILE * 40 * 2, 6);
    expect(trader.trade!.busy.length).toBe(sh.wagons);
    expect(trader.trade!.busy[0]).toBeCloseTo(s.day + 4, 10);
    expect(s.stats.acc.shipped_units).toBeCloseTo(planned, 6);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('delivery lands in the trader’s stock at the destination, which it then offers there', () => {
    spread();
    tradersBeginDay(s);
    const books = openBooks(s);
    traderOrders(s, books);
    const owner = newPerson(s, 0, 'Farmer');
    const farm = newFirm(s, 'farm', 0, -1, owner.id, 'Farm');
    farm.inv[G.grain] = 500;
    addAsk(bookFor(books, 0, G.grain), FIRM_BASE + farm.id, 1.0, 500);
    clearAll(s, books);
    tradersDispatch(s, books);
    const sh = { ...s.shipments[0] };

    s.day += 1; // not yet
    tradersBeginDay(s);
    expect(s.shipments.length).toBe(1);
    s.day += 1; // arrive (day+2.5) ≤ day + 1
    tradersBeginDay(s);
    expect(s.shipments.length).toBe(0);
    const tr = trader.trade!;
    expect(tr.stock[1][G.grain]).toBeCloseTo(sh.qty, 6);
    expect(tr.basis[1][G.grain]).toBeCloseTo(sh.basis, 6);
    expect(tr.busy.length).toBe(sh.wagons); // still on the way home
    expect(s.stats.acc.delivered_units).toBeCloseTo(sh.qty, 6);

    const books2 = openBooks(s);
    traderOrders(s, books2);
    const asks = bookFor(books2, 1, G.grain).asks.filter((o) => o.ref === FIRM_BASE + trader.id);
    expect(asks.reduce((a, o) => a + o.qty, 0)).toBeCloseTo(sh.qty, 6);
    expect(Math.min(...asks.map((o) => o.limit))).toBeGreaterThan(sh.basis * 0.9);

    s.day += 2; // wagons back
    tradersBeginDay(s);
    expect(tr.busy.length).toBe(0);
  });

  it('no bid when the spread does not cover freight, or when shipments are banned', () => {
    s.markets[0 * N_GOODS + G.grain].ema = 2.6;
    s.markets[1 * N_GOODS + G.grain].ema = 3.4; // gap 0.8 < freight ≈ 1.2
    s.markets[1 * N_GOODS + G.grain].volEma = 200;
    tradersBeginDay(s);
    let books = openBooks(s);
    traderOrders(s, books);
    expect(bookFor(books, 0, G.grain).bids.filter((o) => o.ref === FIRM_BASE + trader.id).length).toBe(0);

    s.markets[1 * N_GOODS + G.grain].ema = 6.0;
    const ban: Limit = { id: 5, label: 'ban', enabled: true, kind: 'shipMax', good: G.grain, town: 0, toTown: 1, value: 0, created: 0, until: -1, binding: 0 };
    s.policy.limits.push(ban);
    books = openBooks(s);
    traderOrders(s, books);
    expect(bookFor(books, 0, G.grain).bids.filter((o) => o.ref === FIRM_BASE + trader.id).length).toBe(0);
    expect(ban.binding).toBe(1);
  });

  it('shipment levies are charged to the trader at dispatch', () => {
    spread();
    s.policy.levies.push(levy({ base: 'shipment', unit: 'perUnit', rate: 0.2, payer: 'owner', good: G.grain }));
    tradersBeginDay(s);
    const books = openBooks(s);
    traderOrders(s, books);
    const owner = newPerson(s, 0, 'Farmer');
    const farm = newFirm(s, 'farm', 0, -1, owner.id, 'Farm');
    farm.inv[G.grain] = 500;
    addAsk(bookFor(books, 0, G.grain), FIRM_BASE + farm.id, 1.0, 500);
    clearAll(s, books);
    const purse0 = s.treasury.purse;
    tradersDispatch(s, books);
    const sh = s.shipments[0];
    expect(s.treasury.purse - purse0).toBeCloseTo(0.2 * sh.qty, 6);
    expect(trader.otherCosts).toBeCloseTo(0.2 * sh.qty, 6);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('wagons wear on the road; worn tools cost wagons', () => {
    const tr = trader.trade!;
    trader.tools = 6 * TOOLS_PER_WAGON; // no spare
    tr.busy.push(s.day + 10);
    tradersBeginDay(s);
    expect(trader.tools).toBeLessThan(6 * TOOLS_PER_WAGON);
    expect(tr.wagons).toBe(5);
  });
});

describe('Treasury cargo', () => {
  it('pays freight to the trading house of the origin town and arrives in the Treasury’s holdings', () => {
    s.treasury.goods[0][G.bread] = 50;
    mint(s, 1000);
    const cash0 = trader.cash;
    const purse0 = s.treasury.purse;
    const r = shipTreasuryGoods(s, 0, 1, G.bread, 80);
    expect(r.ok).toBe(true);
    expect(r.message).not.toMatch(/tax|subsid|tariff/i);
    expect(s.treasury.goods[0][G.bread]).toBe(0);
    const sh = s.shipments.find((x) => x.owner === STATE)!;
    expect(sh.qty).toBe(50);
    const fee = purse0 - s.treasury.purse;
    expect(fee).toBeGreaterThan(0);
    expect(trader.cash - cash0).toBeCloseTo(fee, 8);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
    s.day += 2;
    tradersBeginDay(s);
    expect(s.treasury.goods[1][G.bread]).toBeCloseTo(50, 8);

    expect(shipTreasuryGoods(s, 0, 1, G.bread, 10).ok).toBe(false); // nothing left
    s.treasury.goods[0][G.iron] = 10;
    s.treasury.autoMint = false;
    s.treasury.purse = 0;
    expect(shipTreasuryGoods(s, 0, 1, G.iron, 10).ok).toBe(false); // cannot pay
  });
});
