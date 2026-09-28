import { describe, expect, it } from 'vitest';
import { aggregateCurve, clearBook } from '../src/sim/market/auction';
import { addAsk, addBid } from '../src/sim/market/markets';
import type { Book, Wedge } from '../src/sim/types';

function mkBook(w: Partial<Wedge> = {}, ceiling = -1, floor = -1): Book {
  return { town: 0, good: 8, bids: [], asks: [], wedge: { bPct: 0, bUnit: 0, sPct: 0, sUnit: 0, ...w }, ceiling, floor };
}

describe('clearBook — price discovery', () => {
  it('maximises executed volume and stays at the reference inside the indifference range', () => {
    const b = mkBook();
    const b12 = addBid(b, 1, 12, 10);
    const b10 = addBid(b, 2, 10, 10);
    const b8 = addBid(b, 3, 8, 10);
    const a7 = addAsk(b, 4, 7, 10);
    const a9 = addAsk(b, 5, 9, 10);
    const a11 = addAsk(b, 6, 11, 10);
    const r = clearBook(b, 9.5);
    expect(r.volume).toBeCloseTo(20);
    expect(r.price).toBeCloseTo(9.5); // any price in [9, 10] clears 20 with zero imbalance → reference
    expect(r.crossed).toBe(true);
    expect(b12.filled).toBeCloseTo(10);
    expect(b10.filled).toBeCloseTo(10);
    expect(b8.filled).toBe(0);
    expect(a7.filled).toBeCloseTo(10);
    expect(a9.filled).toBeCloseTo(10);
    expect(a11.filled).toBe(0);
    expect(r.bestBid).toBeCloseTo(12);
    expect(r.bestAsk).toBeCloseTo(7);
    // the reference outside the range is clamped to its ends
    expect(clearBook(b, 50).price).toBeCloseTo(10);
    expect(clearBook(b, 1).price).toBeCloseTo(9);
  });

  it('breaks ties by market pressure: excess demand → highest, excess supply → lowest', () => {
    const d = mkBook();
    addBid(d, 1, 12, 10);
    addAsk(d, 2, 10, 5);
    const rd = clearBook(d, 11);
    expect(rd.volume).toBeCloseTo(5);
    expect(rd.price).toBeCloseTo(12);
    expect(rd.rationed).toBe('buyers');

    const sup = mkBook();
    addBid(sup, 1, 12, 5);
    addAsk(sup, 2, 10, 10);
    const rs = clearBook(sup, 11);
    expect(rs.volume).toBeCloseTo(5);
    expect(rs.price).toBeCloseTo(10);
    expect(rs.rationed).toBe('sellers');
  });

  it('prefers the candidate with the smallest imbalance among equal volumes', () => {
    const b = mkBook();
    addBid(b, 1, 10, 10);
    addBid(b, 2, 8, 4);
    addAsk(b, 3, 7, 10);
    addAsk(b, 4, 9, 4);
    // V = 10 at 7 (D=14,S=10), 8 (D=14,S=10), 9 (D=10,S=14), 10 (D=10,S=14): imbalance 4 everywhere, mixed signs → reference within [7,10]
    const r = clearBook(b, 8.5);
    expect(r.volume).toBeCloseTo(10);
    expect(r.price).toBeCloseTo(8.5);
  });

  it('shares the marginal price level pro rata', () => {
    const b = mkBook();
    const x = addBid(b, 1, 10, 10);
    const y = addBid(b, 2, 10, 30);
    addAsk(b, 3, 9, 20);
    const r = clearBook(b, 9);
    expect(r.volume).toBeCloseTo(20);
    expect(r.price).toBeCloseTo(10);
    expect(x.filled).toBeCloseTo(5);
    expect(y.filled).toBeCloseTo(15);
  });

  it('records no trade and an indicative mid price when the book does not cross', () => {
    const b = mkBook();
    const bid = addBid(b, 1, 8, 5);
    const ask = addAsk(b, 2, 10, 5);
    const r = clearBook(b, 3);
    expect(r.crossed).toBe(false);
    expect(r.volume).toBe(0);
    expect(r.price).toBeCloseTo(9);
    expect(bid.filled).toBe(0);
    expect(ask.filled).toBe(0);
    // one-sided book → reference price
    const one = mkBook();
    addBid(one, 1, 8, 5);
    expect(clearBook(one, 3).price).toBeCloseTo(3);
    // indicative price is clamped into limits
    const lim = mkBook({}, 7);
    addBid(lim, 1, 8, 5);
    addAsk(lim, 2, 10, 5);
    expect(clearBook(lim, 3).price).toBeCloseTo(7);
  });

  it('ignores empty and invalid orders', () => {
    const b = mkBook();
    addBid(b, 1, Number.NaN, 5);
    addBid(b, 1, 10, 0);
    addBid(b, 1, -3, 5);
    expect(b.bids.length).toBe(1); // only the negative-limit bid is stored; it cannot trade
    addAsk(b, 2, 5, 5);
    const r = clearBook(b, 5);
    expect(r.volume).toBe(0);
    expect(b.bids[0].base).toBe(-1);
  });
});

describe('clearBook — levy wedge and per-order extras', () => {
  it('converts gross / net limits into base terms', () => {
    const b = mkBook({ bPct: 0.25, sPct: 0.2 });
    const bid = addBid(b, 1, 12.5, 5); // pays gross 12.5 = base·1.25 → base 10
    const ask = addAsk(b, 2, 8, 5); // wants net 8 = base·0.8 → base 10
    const r = clearBook(b, 10);
    expect(bid.base).toBeCloseTo(10);
    expect(ask.base).toBeCloseTo(10);
    expect(r.price).toBeCloseTo(10);
    expect(r.volume).toBeCloseTo(5);

    const u = mkBook({ bUnit: 1, sUnit: 2 });
    const bu = addBid(u, 1, 11, 1);
    const au = addAsk(u, 2, 8, 1);
    clearBook(u, 10);
    expect(bu.base).toBeCloseTo(10);
    expect(au.base).toBeCloseTo(10);
  });

  it('a buyer levy shifts demand down: the base price falls, the gross price rises', () => {
    // Same orders with and without a 50 % buyer levy.
    const make = (bPct: number) => {
      const b = mkBook({ bPct });
      for (const [p, q] of [[20, 5], [15, 5], [12, 5], [10, 5]]) addBid(b, 1, p, q);
      for (const [p, q] of [[6, 5], [8, 5], [11, 5], [14, 5]]) addAsk(b, 2, p, q);
      return clearBook(b, 10);
    };
    const r0 = make(0);
    const r1 = make(0.5);
    expect(r1.price).toBeLessThan(r0.price);
    expect(r1.price * 1.5).toBeGreaterThan(r0.price);
    expect(r1.volume).toBeLessThanOrEqual(r0.volume);
  });

  it('exempt orders skip the wedge but keep their own extras', () => {
    const b = mkBook({ bPct: 0.5, sPct: 0.5 });
    const ex = addBid(b, -1, 10, 1, { exempt: true });
    const non = addBid(b, 1, 15, 1);
    const exAsk = addAsk(b, -1, 9, 1, { exempt: true });
    clearBook(b, 10);
    expect(ex.base).toBeCloseTo(10);
    expect(non.base).toBeCloseTo(10);
    expect(exAsk.base).toBeCloseTo(9);

    const x = mkBook();
    const xa = addAsk(x, -3, 8, 1, { xPct: 0.2 }); // port duty on a foreign seller
    const xb = addBid(x, -3, 11, 1, { xUnit: 1 });
    clearBook(x, 10);
    expect(xa.base).toBeCloseTo(10);
    expect(xb.base).toBeCloseTo(10);
  });
});

describe('clearBook — legal price limits', () => {
  it('a binding ceiling rations buyers pro rata among ALL eligible bids', () => {
    const b = mkBook({}, 8);
    const A = addBid(b, 1, 12, 10);
    const B = addBid(b, 2, 9, 30);
    const C = addBid(b, 3, 7, 10);
    const s1 = addAsk(b, 4, 5, 10);
    const s2 = addAsk(b, 5, 7.5, 10);
    const r = clearBook(b, 8);
    expect(r.bound).toBe('ceiling');
    expect(r.price).toBeCloseTo(8);
    expect(r.volume).toBeCloseTo(20);
    expect(r.rationed).toBe('buyers');
    expect(r.demandAtPrice).toBeCloseTo(40);
    expect(A.filled).toBeCloseTo(5); // 10 × 20/40 — no price priority under the ceiling
    expect(B.filled).toBeCloseTo(15);
    expect(C.filled).toBe(0);
    expect(s1.filled).toBeCloseTo(10);
    expect(s2.filled).toBeCloseTo(10);
  });

  it('a binding floor leaves a surplus and rations sellers pro rata', () => {
    const b = mkBook({}, -1, 10);
    addBid(b, 1, 12, 5);
    addBid(b, 2, 11, 5);
    const a1 = addAsk(b, 3, 6, 10);
    const a2 = addAsk(b, 4, 8, 10);
    const r = clearBook(b, 7);
    expect(r.bound).toBe('floor');
    expect(r.price).toBeCloseTo(10);
    expect(r.volume).toBeCloseTo(10);
    expect(r.supplyAtPrice).toBeCloseTo(20);
    expect(r.rationed).toBe('sellers');
    expect(a1.filled).toBeCloseTo(5);
    expect(a2.filled).toBeCloseTo(5);
  });

  it('a ceiling below every ask stops trade but reports the unmet demand', () => {
    const b = mkBook({}, 3);
    addBid(b, 1, 10, 7);
    addAsk(b, 2, 5, 7);
    const r = clearBook(b, 5);
    expect(r.volume).toBe(0);
    expect(r.price).toBeCloseTo(3);
    expect(r.bound).toBe('ceiling');
    expect(r.demandAtPrice).toBeCloseTo(7);
  });
});

describe('aggregateCurve', () => {
  it('builds cumulative curves (bids descending, asks ascending) and downsamples', () => {
    const b = mkBook();
    addBid(b, 1, 10, 1);
    addBid(b, 2, 10, 2);
    addBid(b, 3, 8, 3);
    addAsk(b, 4, 5, 4);
    addAsk(b, 5, 9, 1);
    clearBook(b, 7);
    const c = aggregateCurve(b, 40);
    expect(c.bids).toEqual([10, 3, 8, 6]);
    expect(c.asks).toEqual([5, 4, 9, 5]);

    const big = mkBook();
    for (let i = 0; i < 200; i++) addBid(big, i, 1 + i * 0.01, 1);
    for (let i = 0; i < 150; i++) addAsk(big, 1000 + i, 0.5 + i * 0.02, 1);
    clearBook(big, 1);
    const cb = aggregateCurve(big, 40);
    expect(cb.bids.length / 2).toBeLessThanOrEqual(40);
    expect(cb.asks.length / 2).toBeLessThanOrEqual(40);
    // first bid point = highest price with qty 1, last = lowest price with all 200 units
    expect(cb.bids[0]).toBeCloseTo(2.99);
    expect(cb.bids[cb.bids.length - 1]).toBe(200);
    expect(cb.asks[cb.asks.length - 1]).toBe(150);
    for (let i = 2; i < cb.bids.length; i += 2) expect(cb.bids[i]).toBeLessThan(cb.bids[i - 2]);
  });
});

describe('clearBook — scale', () => {
  it('clears a large book quickly and consistently', () => {
    const b = mkBook();
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 3000; i++) addBid(b, i, 1 + rnd() * 2, 0.5 + rnd());
    for (let i = 0; i < 300; i++) addAsk(b, 5000 + i, 0.8 + rnd() * 2, 2 + rnd() * 5);
    const t0 = performance.now();
    let r = clearBook(b, 1.5);
    for (let k = 0; k < 20; k++) r = clearBook(b, 1.5);
    const ms = (performance.now() - t0) / 21;
    let fb = 0;
    let fa = 0;
    for (const o of b.bids) {
      fb += o.filled;
      expect(o.filled).toBeLessThanOrEqual(o.qty + 1e-9);
      if (o.filled > 0) expect(o.base).toBeGreaterThanOrEqual(r.price * (1 - 1e-9));
    }
    for (const o of b.asks) {
      fa += o.filled;
      if (o.filled > 0) expect(o.base).toBeLessThanOrEqual(r.price * (1 + 1e-9));
    }
    expect(fb).toBeCloseTo(r.volume, 6);
    expect(fa).toBeCloseTo(r.volume, 6);
    expect(ms).toBeLessThan(5);
  });
});
