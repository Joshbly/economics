import { expect, it, vi } from 'vitest';
vi.mock('../src/sim/market/markets', () => {
  const order = (ref: number, side: 0 | 1, limit: number, qty: number) => ({ ref, side, limit, qty, exempt: false, xPct: 0, xUnit: 0, tag: 0, base: 0, filled: 0, price: 0, paid: 0 });
  return {
    addBid: (book: any, ref: number, limit: number, qty: number) => { const o = order(ref, 0, limit, qty); book.bids.push(o); return o; },
    addAsk: (book: any, ref: number, limit: number, qty: number) => { const o = order(ref, 1, limit, qty); book.asks.push(o); return o; },
    bookFor: (books: any, town: number, good: number) => (good === 100 ? books.iou : good === 101 ? books.gold : books.goods[town * 11 + good]),
    expectedGross: (s: any, town: number, good: number) => s.markets[town * 11 + good].ema,
  };
});
import { householdOrders, householdPortfolioOrders, householdsBeginDay, householdsConsume } from '../src/sim/agents/households';
import { laborMarket, hire } from '../src/sim/agents/labor';
import { housingStep, findHome } from '../src/sim/agents/housing';
import { demographyStep } from '../src/sim/agents/demography';
import { G } from '../src/sim/goods';
import { addFirm, addHouse, addPerson, fakeBooks, reconcile, tinyWorld } from './households.fixture';

it('perf', () => {
  const s = tinyWorld(4);
  const sectors = ['farm', 'bakery', 'brewery', 'coalmine', 'lumber', 'smelter'] as const;
  for (let t = 0; t < 4; t++) {
    for (let i = 0; i < 65; i++) addHouse(s, t, 2 + (i % 30), 2 + Math.floor(i / 30) + t * 6, 1.6, -1);
    for (let i = 0; i < 25; i++) { const f = addFirm(s, sectors[i % 6], t, 3 + i, 20 + t, 10, 9); f.capacity = 12; }
  }
  for (let i = 0; i < 1000; i++) {
    const t = i % 4;
    const p = addPerson(s, t, 300, { income: 10, age: 18 + (i % 60) });
    p.pantry[G.bread] = 2; p.pantry[G.coal] = 5; p.pantry[G.furniture] = 10;
    findHome(s, p, t, { force: true });
  }
  const firms = s.firms;
  let k = 0;
  for (const p of s.people) { if (k >= 900) break; const f = firms[k % firms.length]; if (f.town === p.town || true) { hire(s, f, p); k++; } }
  s.foreign.coin = 20000;
  reconcile(s);
  const T: Record<string, number> = { begin: 0, orders: 0, portf: 0, consume: 0, labor: 0, housing: 0, demo: 0 };
  const N = 200;
  let nOrders = 0;
  for (let d = 0; d < N; d++) {
    let t0 = performance.now();
    laborMarket(s); T.labor += performance.now() - t0; t0 = performance.now();
    for (const p of s.people) if (p.alive && p.job >= 0) p.earned += 10;
    householdsBeginDay(s); T.begin += performance.now() - t0; t0 = performance.now();
    const books = fakeBooks(s);
    householdOrders(s, books as any); T.orders += performance.now() - t0; t0 = performance.now();
    householdPortfolioOrders(s, books as any); T.portf += performance.now() - t0; t0 = performance.now();
    nOrders = books.goods.reduce((a, b) => a + b.bids.length, 0);
    // crude fills: everyone receives their plan's first two rungs
    for (const b of books.goods) for (const o of b.bids) if (o.limit >= s.markets[b.town * 11 + b.good].ema * 1.1) s.people[o.ref].pantry[b.good] += o.qty;
    householdsConsume(s); T.consume += performance.now() - t0; t0 = performance.now();
    housingStep(s); T.housing += performance.now() - t0; t0 = performance.now();
    demographyStep(s); T.demo += performance.now() - t0;
    s.day++;
  }
  const per = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, +(v / N).toFixed(3)]));
  const alive = s.people.filter((p) => p.alive);
  console.log('ms/day', per, 'orders/day', nOrders, 'alive', alive.length,
    'health', (alive.reduce((a, p) => a + p.health, 0) / alive.length).toFixed(3),
    'content', (alive.reduce((a, p) => a + p.contentment, 0) / alive.length).toFixed(3),
    'homeless', alive.filter((p) => p.home < 0).length, 'unemp', alive.filter((p) => p.job < 0).length, s.stats.acc);
  expect(alive.length).toBeGreaterThan(800);
});
