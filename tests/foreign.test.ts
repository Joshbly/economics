// The outside world: port orders, duties, quotas, gold dealers, world prices, ship capacity.
import { beforeEach, describe, expect, it } from 'vitest';
import { dealerCentre, deskTargetCoin, foreignEndDay, foreignOrders, importPrice } from '../src/sim/agents/foreign';
import { DEALER_BANDS, DEALER_DEPTH, EXPORT_DISCOUNT, IMPORT_MARKUP, PIER_CAP_BONUS } from '../src/sim/config';
import { newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger, reconcileBank } from '../src/sim/ledger';
import { addBid, bookFor, clearAll, openBooks } from '../src/sim/market/markets';
import { FOREIGN, GOLD_GOOD, type Levy, type MapData, type SimState } from '../src/sim/types';

function tinyMap(): MapData {
  const n = 16;
  const z = () => new Array(n).fill(0);
  return { w: 4, h: 4, terrain: new Array(n).fill(3), elev: z(), fert: z(), deposit: z(), river: z(), road: z(), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

const PRICES = [2.6, 3.0, 2.6, 2.6, 2.6, 3.2, 13, 20, 4, 2.8, 22];
let s: SimState;

beforeEach(() => {
  s = newSimState(9, tinyMap());
  s.towns.push(newTown(0, 'Kingsbridge', 'capital', 1, 1, 2));
  s.towns.push(newTown(1, 'Saltmere', 'harbor', 3, 3, 2));
  s.treasury = newTreasury(2);
  for (let t = 0; t < 2; t++) for (let g = 0; g < N_GOODS; g++) s.markets.push(newMarket(t, g, PRICES[g]));
  for (const t of s.towns) {
    t.avgWage = 10; // (derived by stats in the game)
    t.employed = 100;
  }
  const fo = s.foreign;
  for (const g of [G.grain, G.coal, G.iron, G.tools]) {
    fo.world[g] = fo.world0[g] = PRICES[g] / 100;
    fo.shipCap[g] = 20;
    for (let t = 0; t < 2; t++) s.markets[t * N_GOODS + g].volEma = 250; // national use 500/day → capacity 20
  }
  fo.coin = 20_000;
  s.goldMarket.ema = 100;
  s.bank.reserves = 1e5;
  reconcileBank(s);
});

function levy(over: Partial<Levy>): Levy {
  return { id: 60, label: 't', enabled: true, dir: 1, base: 'import', unit: 'pct', rate: 0.25, payer: 'buyer', threshold: 0, good: -1, town: -1, toTown: -1, sector: 'any', group: 'all', buildingKind: 'any', created: 0, until: -1, today: 0, month: 0, lastMonth: 0, total: 0, ...over };
}

describe('foreign ships at the port', () => {
  it('ask at E·w·(1+markup) and bid at E·w·(1−discount), up to ship capacity, only in the port town', () => {
    const books = openBooks(s);
    foreignOrders(s, books);
    const asks = bookFor(books, 1, G.iron).asks.filter((o) => o.ref === FOREIGN);
    const bids = bookFor(books, 1, G.iron).bids.filter((o) => o.ref === FOREIGN);
    expect(Math.min(...asks.map((o) => o.limit))).toBeCloseTo(13 * (1 + IMPORT_MARKUP), 8);
    expect(Math.max(...bids.map((o) => o.limit))).toBeCloseTo(13 * (1 - EXPORT_DISCOUNT), 8);
    expect(asks.reduce((a, o) => a + o.qty, 0)).toBeCloseTo(20, 8);
    expect(bids.reduce((a, o) => a + o.qty, 0)).toBeCloseTo(20, 8);
    expect(bookFor(books, 0, G.iron).asks.length).toBe(0); // not at an inland town
    expect(bookFor(books, 1, G.bread).asks.length).toBe(0); // not tradable abroad
  });

  it('export bids are limited by the desk’s coin', () => {
    s.foreign.coin = 100;
    const books = openBooks(s);
    foreignOrders(s, books);
    let committed = 0;
    for (let g = 0; g < N_GOODS; g++) for (const o of bookFor(books, 1, g).bids) if (o.ref === FOREIGN) committed += o.limit * o.qty;
    expect(committed).toBeLessThanOrEqual(100 + 1e-9);
    expect(committed).toBeGreaterThan(0);
  });

  it('import duties ride on the foreign asks; a ban removes them', () => {
    s.policy.levies.push(levy({ good: G.iron }));
    let books = openBooks(s);
    foreignOrders(s, books);
    const a = bookFor(books, 1, G.iron).asks.find((o) => o.ref === FOREIGN)!;
    expect(a.xPct).toBeCloseTo(0.25, 10);

    // A domestic buyer pays the duty-inclusive price; the Treasury collects the duty.
    const buyer = newPerson(s, 1, 'Smith');
    buyer.cash = 1000;
    reconcileBank(s);
    addBid(bookFor(books, 1, G.iron), buyer.id, 40, 5);
    const coin0 = s.foreign.coin;
    const purse0 = s.treasury.purse;
    clearAll(s, books);
    expect(buyer.pantry[G.iron]).toBeCloseTo(5, 8);
    const base = (13 * (1 + IMPORT_MARKUP)) / (1 - 0.25);
    expect(s.markets[1 * N_GOODS + G.iron].price).toBeCloseTo(base, 6);
    expect(s.treasury.purse - purse0).toBeCloseTo(0.25 * base * 5, 6);
    expect(s.foreign.coin - coin0).toBeCloseTo(13 * (1 + IMPORT_MARKUP) * 5, 6);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);

    s.policy.limits.push({ id: 61, label: 'ban', enabled: true, kind: 'importMax', good: G.iron, town: -1, toTown: -1, value: 0, created: 0, until: -1, binding: 0 });
    books = openBooks(s);
    foreignOrders(s, books);
    expect(bookFor(books, 1, G.iron).asks.filter((o) => o.ref === FOREIGN).length).toBe(0);
    expect(bookFor(books, 1, G.iron).bids.filter((o) => o.ref === FOREIGN).length).toBeGreaterThan(0);
  });
});

describe('gold market dealers', () => {
  it('quote DEALER_DEPTH oz per 1 % band around the dealer centre', () => {
    const books = openBooks(s);
    foreignOrders(s, books);
    const gb = bookFor(books, -1, GOLD_GOOD);
    const V = dealerCentre(s);
    expect(gb.asks.length).toBe(DEALER_BANDS);
    expect(gb.asks[0].limit).toBeCloseTo(V * 1.01, 8);
    expect(gb.asks[0].qty).toBeCloseTo(DEALER_DEPTH, 8);
    expect(gb.bids[0].limit).toBeCloseTo(V * 0.99, 8);
  });

  it('a desk flush with coin values gold higher; a higher deposit rate firms the coin (interest parity)', () => {
    s.foreign.coin = deskTargetCoin(s);
    const v0 = dealerCentre(s);
    expect(v0).toBeCloseTo(s.foreign.dealerValue, 6);
    s.foreign.coin *= 3;
    expect(dealerCentre(s)).toBeGreaterThan(v0 * 1.1);
    s.foreign.coin /= 3;
    s.bank.depositRate = 0.08;
    expect(dealerCentre(s)).toBeLessThan(v0 * 0.95);
  });
});

describe('evening: world prices, parity, capacity', () => {
  it('world prices drift within bounds and follow shocks, which expire', () => {
    s.foreign.shocks.push({ good: G.coal, factor: 1.8, until: 60 });
    for (let d = 0; d < 60; d++) {
      foreignEndDay(s);
      s.day++;
    }
    expect(s.foreign.world[G.coal] / s.foreign.world0[G.coal]).toBeGreaterThan(1.5);
    for (let d = 0; d < 5; d++) {
      foreignEndDay(s);
      s.day++;
    }
    expect(s.foreign.shocks.length).toBe(0);
    for (let g = 0; g < N_GOODS; g++) {
      expect(Number.isFinite(s.foreign.world[g])).toBe(true);
      if (s.foreign.world0[g] === 0) expect(s.foreign.world[g]).toBe(0);
    }
    expect(importPrice(s, G.bread)).toBe(0);
  });

  it('domestic inflation raises the parity estimate and pulls the dealers’ value up', () => {
    for (let t = 0; t < 2; t++) for (let g = 0; g < N_GOODS; g++) s.markets[t * N_GOODS + g].ema = PRICES[g] * 2;
    for (const t of s.towns) t.avgWage = 20; // prices and wages both doubled
    const dv0 = s.foreign.dealerValue;
    for (let d = 0; d < 100; d++) {
      foreignEndDay(s);
      s.day++;
    }
    expect(s.foreign.ppp).toBeGreaterThan(150);
    expect(s.foreign.dealerValue).toBeGreaterThan(dv0);
    expect(Number.isFinite(s.foreign.goldEma)).toBe(true);
  });

  it('ship capacity follows national use monthly; a new pier applies at once', () => {
    s.markets[0 * N_GOODS + G.grain].volEma = 1000;
    s.markets[1 * N_GOODS + G.grain].volEma = 1000;
    s.day = 30; // month start
    foreignEndDay(s);
    expect(s.foreign.shipCap[G.grain]).toBeGreaterThan(20);
    const c0 = s.foreign.shipCap[G.iron];
    s.day = 31;
    s.foreign.piers = 1;
    foreignEndDay(s);
    expect(s.foreign.shipCap[G.iron]).toBeCloseTo(c0 * (1 + PIER_CAP_BONUS), 8);
    expect(s.stats.acc.desk_target).toBeGreaterThan(0);
  });
});

describe('balance of payments', () => {
  it('a persistent import surplus fills the desk with coin and weakens the coin against gold (bounded)', () => {
    const buyer = newPerson(s, 1, 'Importer');
    buyer.cash = 5e6;
    s.foreign.coin = deskTargetCoin(s); // start in balance
    reconcileBank(s);
    const g0 = s.goldMarket.ema;
    const coin0 = s.foreign.coin;
    const path: number[] = [];
    for (let d = 0; d < 240; d++) {
      const books = openBooks(s);
      foreignOrders(s, books);
      addBid(bookFor(books, 1, G.iron), buyer.id, 40, 20); // the realm buys iron abroad every day
      addBid(bookFor(books, 1, G.tools), buyer.id, 60, 20);
      clearAll(s, books);
      foreignEndDay(s);
      buyer.pantry[G.iron] = 0;
      buyer.pantry[G.tools] = 0;
      s.day++;
      path.push(s.goldMarket.ema);
      expect(Number.isFinite(s.goldMarket.ema)).toBe(true);
    }
    expect(s.foreign.coin).toBeGreaterThan(coin0 * 1.5);
    expect(s.goldMarket.ema).toBeGreaterThan(g0 * 1.03); // the coin weakened
    expect(s.goldMarket.ema).toBeLessThan(g0 * 1.8); // …within the dealers' premium and parity
    expect(path[239] / path[199]).toBeLessThan(1.06); // …and levelling off, not spiralling
    // dearer gold → dearer imports in coin
    expect(importPrice(s, G.iron)).toBeGreaterThan(13 * (1 + IMPORT_MARKUP) * 1.02);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-4);
  });

  it('households hoarding gold drain the dealers’ asks and raise the gold price', () => {
    const hoarder = newPerson(s, 0, 'Hoarder');
    hoarder.cash = 1e6;
    s.foreign.coin = deskTargetCoin(s);
    reconcileBank(s);
    const g0 = s.goldMarket.ema;
    for (let d = 0; d < 60; d++) {
      const books = openBooks(s);
      foreignOrders(s, books);
      addBid(bookFor(books, -1, GOLD_GOOD), hoarder.id, s.goldMarket.ema * 1.05, 20);
      clearAll(s, books);
      foreignEndDay(s);
      s.day++;
    }
    expect(hoarder.gold).toBeGreaterThan(100);
    expect(s.goldMarket.ema).toBeGreaterThan(g0 * 1.02);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-4);
  });
});
