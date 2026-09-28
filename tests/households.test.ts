import { beforeEach, describe, expect, it, vi } from 'vitest';

// Markets are owned by another module: replace them with a tiny in-memory
// implementation so these tests exercise only household behaviour.
vi.mock('../src/sim/market/markets', () => {
  const order = (ref: number, side: 0 | 1, limit: number, qty: number) => ({ ref, side, limit, qty, exempt: false, xPct: 0, xUnit: 0, tag: 0, base: 0, filled: 0, price: 0, paid: 0 });
  return {
    addBid: (book: any, ref: number, limit: number, qty: number) => {
      const o = order(ref, 0, limit, qty);
      book.bids.push(o);
      return o;
    },
    addAsk: (book: any, ref: number, limit: number, qty: number) => {
      const o = order(ref, 1, limit, qty);
      book.asks.push(o);
      return o;
    },
    bookFor: (books: any, town: number, good: number) => (good === 100 ? books.iou : good === 101 ? books.gold : books.goods[town * 11 + good]),
    expectedGross: (s: any, town: number, good: number) => s.markets[town * 11 + good].ema,
    expectedNet: (s: any, town: number, good: number) => s.markets[town * 11 + good].ema,
    marketOf: (s: any, town: number, good: number) => s.markets[town * 11 + good],
  };
});

import { householdCache, householdOrders, householdPortfolioOrders, householdsBeginDay, householdsConsume, healthTarget } from '../src/sim/agents/households';
import { planDemand } from '../src/sim/agents/demandModel';
import { heatNeed } from '../src/sim/calendar';
import { FOOD_MAX, FOOD_NEED, HUNGRY_BELOW } from '../src/sim/config';
import { CONSUMER_GOODS, G } from '../src/sim/goods';
import type { SimState } from '../src/sim/types';
import { addHouse, addPerson, fakeBooks, tinyWorld } from './households.fixture';

/**
 * Worst-case cost per person and good of their bid ladder under uniform-price
 * clearing: at a clearing price P every rung with limit ≥ P fills and pays P,
 * so the worst case is max over rungs of limit_k × cumulative qty_k.
 */
function spendByPerson(books: ReturnType<typeof fakeBooks>): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const b of books.goods) {
    const cum = new Map<number, number>();
    for (const o of b.bids) {
      const row = m.get(o.ref) ?? new Array(11).fill(0);
      const c = (cum.get(o.ref) ?? 0) + o.qty;
      cum.set(o.ref, c);
      row[b.good] = Math.max(row[b.good], o.limit * c);
      m.set(o.ref, row);
    }
  }
  return m;
}

describe('household budgets and bids', () => {
  let s: SimState;
  beforeEach(() => {
    s = tinyWorld();
    s.day = 200; // late autumn: heat matters
  });

  it('budget never exceeds cash, and is 0 with no cash', () => {
    const poor = addPerson(s, 0, 3, { income: 10 });
    const broke = addPerson(s, 0, 0, { income: 10 });
    const rich = addPerson(s, 0, 5000, { income: 10 });
    const jobless = addPerson(s, 0, 50, { income: 0 });
    householdsBeginDay(s);
    expect(poor.budget).toBeLessThanOrEqual(3 + 1e-9);
    expect(broke.budget).toBe(0);
    expect(jobless.budget).toBeGreaterThan(0);
    expect(jobless.budget).toBeLessThanOrEqual(50);
    // The rich spend down part of their surplus: well above a worker's budget.
    expect(rich.budget).toBeGreaterThan(poor.budget);
    expect(rich.budget).toBeGreaterThan(10);
  });

  it('total worst-case bid spend ≤ cash and per-good spend ≤ maxSpend', () => {
    const ps = [addPerson(s, 0, 2), addPerson(s, 0, 40), addPerson(s, 0, 400), addPerson(s, 0, 4000, { foodSat: 0.3 })];
    ps[1].pantry[G.bread] = 1;
    householdsBeginDay(s);
    const c = householdCache(s);
    // Reconstruct each plan with the same inputs to know maxSpend.
    const plans = ps.map((p) =>
      planDemand({
        budget: p.budget,
        cash: p.cash,
        prices: c.prices[0],
        pantry: p.pantry.slice(),
        heat: c.heat,
        heatAhead: c.heatAhead,
        hungry: p.foodSat < HUNGRY_BELOW,
      }),
    );
    const books = fakeBooks(s);
    householdOrders(s, books as any);
    const spend = spendByPerson(books);
    ps.forEach((p, i) => {
      const row = spend.get(p.id) ?? new Array(11).fill(0);
      const total = row.reduce((a, b) => a + b, 0);
      expect(total).toBeLessThanOrEqual(p.cash + 1e-6);
      for (const g of CONSUMER_GOODS) expect(row[g]).toBeLessThanOrEqual(plans[i].maxSpend[g] + 1e-6);
      expect(c.committed[p.id]).toBeCloseTo(total, 6);
    });
    // Bids are ladders: several descending price rungs for bread.
    const breadBids = books.goods[G.bread].bids.filter((o) => o.ref === ps[2].id);
    expect(breadBids.length).toBeGreaterThan(3);
    for (let k = 1; k < breadBids.length; k++) expect(breadBids[k].limit).toBeLessThan(breadBids[k - 1].limit);
  });

  it('a higher real deposit rate lowers spending (bigger buffers)', () => {
    const a = addPerson(s, 0, 600);
    householdsBeginDay(s);
    const low = a.budget;
    s.bank.depositRate = 0.12;
    a.earned = 10; // same income as the EMA so it stays put
    householdsBeginDay(s);
    expect(a.budget).toBeLessThan(low);
  });

  it('rent reduces the goods budget', () => {
    const a = addPerson(s, 0, 400);
    const b = addPerson(s, 0, 400);
    const h = addHouse(s, 0, 5, 5, 2, -1);
    h.residents.push(a.id);
    a.home = h.id;
    householdsBeginDay(s);
    expect(a.budget).toBeLessThan(b.budget);
  });
});

describe('portfolio orders', () => {
  it('rich savers buy IOUs when the yield beats deposits, and gold when inflation outruns rates', () => {
    const s = tinyWorld();
    s.iouMarket.ema = 80; // 6.25 % yield
    s.bank.depositRate = 0.01;
    const saver = addPerson(s, 0, 20000);
    const worker = addPerson(s, 0, 300);
    householdsBeginDay(s);
    let books = fakeBooks(s);
    householdOrders(s, books as any);
    householdPortfolioOrders(s, books as any);
    const iouBids = books.iou.bids.filter((o) => o.ref === saver.id);
    expect(iouBids.length).toBe(1);
    expect(iouBids[0].limit * iouBids[0].qty).toBeLessThan(0.1 * saver.cash); // modest
    expect(books.iou.bids.some((o) => o.ref === worker.id)).toBe(false);
    expect(books.gold.bids.length).toBe(0);

    saver.expInfl = 0.2;
    s.stats.latest.infl30 = 0.2;
    householdsBeginDay(s);
    books = fakeBooks(s);
    householdOrders(s, books as any);
    householdPortfolioOrders(s, books as any);
    expect(books.gold.bids.some((o) => o.ref === saver.id)).toBe(true);
  });

  it('people short of cash offer their gold and IOUs for sale', () => {
    const s = tinyWorld();
    const p = addPerson(s, 0, 1, { gold: 3, iou: 2 });
    householdsBeginDay(s);
    const books = fakeBooks(s);
    householdOrders(s, books as any);
    householdPortfolioOrders(s, books as any);
    const asks = [...books.gold.asks, ...books.iou.asks].filter((o) => o.ref === p.id);
    expect(asks.length).toBe(1);
    expect(asks[0].qty).toBeGreaterThan(0);
    expect(asks[0].qty).toBeLessThanOrEqual(3);
  });
});

describe('consumption', () => {
  it('eats from the pantry, burns coal, and health follows food', () => {
    const s = tinyWorld();
    s.day = 300; // winter
    const fed = addPerson(s, 0, 300, { health: 0.7 });
    fed.pantry[G.bread] = 4;
    fed.pantry[G.fish] = 1;
    fed.pantry[G.coal] = 10;
    fed.pantry[G.ale] = 1;
    fed.pantry[G.furniture] = 10;
    const starving = addPerson(s, 0, 0, { health: 0.7 });
    householdsBeginDay(s);
    householdOrders(s, fakeBooks(s) as any);
    const plan = householdCache(s).foodPlan[fed.id];
    householdsConsume(s);

    const eaten = 4 - fed.pantry[G.bread] + (1 - fed.pantry[G.fish]);
    expect(eaten).toBeCloseTo(plan, 6);
    expect(eaten).toBeGreaterThanOrEqual(FOOD_NEED);
    expect(eaten).toBeLessThanOrEqual(FOOD_MAX);
    expect(fed.foodSat).toBeGreaterThanOrEqual(1);
    expect(fed.pantry[G.coal]).toBeLessThan(10 - heatNeed(300) + 1e-9);
    expect(fed.heatSat).toBe(1);
    expect(fed.pantry[G.furniture]).toBeLessThan(10);
    expect(fed.health).toBeGreaterThan(0.7);

    expect(starving.foodSat).toBe(0);
    expect(starving.heatSat).toBe(0);
    expect(starving.health).toBeLessThan(0.7);
    expect(s.stats.acc.hungry).toBe(1);
    expect(s.stats.acc.cold).toBe(1);
    expect(s.stats.acc.eaten_bread + s.stats.acc.eaten_fish).toBeCloseTo(eaten, 6);
    for (const p of [fed, starving]) for (const q of p.pantry) expect(q).toBeGreaterThanOrEqual(0);
  });

  it('substitutes fish when bread runs out', () => {
    const s = tinyWorld();
    const p = addPerson(s, 0, 100);
    p.pantry[G.fish] = 3;
    householdsBeginDay(s);
    householdOrders(s, fakeBooks(s) as any);
    householdsConsume(s);
    expect(p.foodSat).toBeGreaterThanOrEqual(1);
    expect(p.pantry[G.fish]).toBeLessThan(2 + 1e-9);
  });

  it('health target: starvation → 0, full food and warmth → 1, cold hurts in winter only', () => {
    expect(healthTarget(0, 1, 0.5, true, 30)).toBe(0);
    expect(healthTarget(1.2, 1, 0.5, true, 30)).toBeCloseTo(1, 6);
    const winterCold = healthTarget(1, 0, heatNeed(315), true, 30);
    const summerCold = healthTarget(1, 0, heatNeed(135), true, 30);
    expect(winterCold).toBeLessThan(summerCold);
    expect(healthTarget(1, 1, 0.3, false, 30)).toBeLessThan(1);
  });

  it('contentment reacts to unemployment and homelessness', () => {
    const s = tinyWorld();
    const h = addHouse(s, 0, 5, 5, 1, -1);
    const good = addPerson(s, 0, 300, { job: 0, contentment: 0.5 });
    h.residents.push(good.id);
    good.home = h.id;
    const bad = addPerson(s, 0, 300, { income: 0, contentment: 0.5 });
    for (const p of [good, bad]) {
      p.pantry[G.bread] = 50;
      p.pantry[G.coal] = 20;
    }
    for (let d = 0; d < 60; d++) {
      householdsBeginDay(s);
      good.earned = 10;
      householdOrders(s, fakeBooks(s) as any);
      householdsConsume(s);
      s.day++;
    }
    expect(good.contentment).toBeGreaterThan(bad.contentment + 0.1);
    for (const p of [good, bad]) {
      expect(Number.isFinite(p.contentment)).toBe(true);
      expect(Number.isFinite(p.health)).toBe(true);
    }
  });
});
