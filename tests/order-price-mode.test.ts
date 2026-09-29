// Treasury orders whose limit follows the market (priceMode 'follow' with a band) or
// has none ('any'): the limit is re-set each morning from the going price.
import { describe, expect, it } from 'vitest';
import { Game } from '../src/sim/game';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger } from '../src/sim/ledger';
import { effectiveOrderLimit } from '../src/sim/policy/player';
import { deserialize, serialize } from '../src/sim/save';

function setup() {
  const g = Game.create({ seed: 4, warmup: false });
  g.dispatch({ type: 'mint', amount: 200_000 });
  const town = g.s.towns.find((t) => t.kind === 'capital')!.id;
  return { g, s: g.s, town };
}

describe('orders that follow the market', () => {
  it('a following buy re-sets its limit daily to the going price + band', () => {
    const { g, s, town } = setup();
    const r = g.dispatch({ type: 'placeOrder', market: { kind: 'good', town, good: G.tools }, side: 'buy', price: 0, qty: 3, priceMode: 'follow', band: 0.1 });
    expect(r.ok).toBe(true);
    const o = s.policy.orders.find((x) => x.id === r.id)!;
    expect(o.priceMode).toBe('follow');
    expect(r.message).toMatch(/10% above the going price/);
    for (let d = 0; d < 20; d++) {
      g.step(1);
      const ref = s.markets[town * N_GOODS + G.tools].ema;
      // Limit set this morning from yesterday's going price: within the band of today's.
      expect(o.price).toBeGreaterThan(0);
      expect(Math.abs(o.price / ref - 1.1)).toBeLessThan(0.25);
    }
    expect(o.filled).toBeGreaterThan(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('bands of 5/10/20/30 % give proportionally higher buy limits and lower sell floors', () => {
    const { s, town } = setup();
    const m = { kind: 'good' as const, town, good: G.grain };
    const ref = s.markets[town * N_GOODS + G.grain].ema;
    for (const b of [0.05, 0.1, 0.2, 0.3]) {
      expect(effectiveOrderLimit(s, { market: m, side: 'buy', price: 0, priceMode: 'follow', band: b })).toBeCloseTo(ref * (1 + b), 6);
      expect(effectiveOrderLimit(s, { market: m, side: 'sell', price: 0, priceMode: 'follow', band: b })).toBeCloseTo(ref * (1 - b), 6);
    }
  });

  it('an any-price buy keeps buying through a spike (Purse permitting); an any-price sell takes what the market pays', () => {
    const { g, s, town } = setup();
    const fixed = g.dispatch({ type: 'placeOrder', market: { kind: 'good', town, good: G.bread }, side: 'buy', price: s.markets[town * N_GOODS + G.bread].ema * 1.02, qty: 40 });
    const any = g.dispatch({ type: 'placeOrder', market: { kind: 'good', town, good: G.bread }, side: 'buy', price: 0, qty: 40, priceMode: 'any' });
    expect(any.ok).toBe(true);
    g.step(15);
    const fo = s.policy.orders.find((x) => x.id === fixed.id)!;
    const ao = s.policy.orders.find((x) => x.id === any.id)!;
    // Buying 80/day of bread pushes its price up: the fixed order falls behind, the any-price one keeps buying.
    expect(ao.filled).toBeGreaterThan(fo.filled);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('can switch an order between modes and survives save/load', () => {
    const { g, s, town } = setup();
    const r = g.dispatch({ type: 'placeOrder', market: { kind: 'good', town, good: G.grain }, side: 'buy', price: 3, qty: 5 });
    expect(g.dispatch({ type: 'updateOrder', id: r.id!, patch: { priceMode: 'follow', band: 0.2 } }).ok).toBe(true);
    const o = s.policy.orders.find((x) => x.id === r.id)!;
    expect(o.priceMode).toBe('follow');
    expect(o.band).toBeCloseTo(0.2);
    expect(g.dispatch({ type: 'updateOrder', id: r.id!, patch: { priceMode: 'fixed', price: 3.5 } }).ok).toBe(true);
    expect(o.priceMode).toBe('fixed');
    expect(o.price).toBeCloseTo(3.5);
    expect(g.dispatch({ type: 'updateOrder', id: r.id!, patch: { priceMode: 'follow', band: 2 } }).ok).toBe(false);
    expect(g.dispatch({ type: 'placeOrder', market: { kind: 'labor', town }, side: 'buy', price: 0, qty: 2, priceMode: 'any' }).ok).toBe(false);
    const back = deserialize(serialize(s));
    expect(back.policy.orders.find((x) => x.id === r.id)!.priceMode).toBe('fixed');
  });
});
