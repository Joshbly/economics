// Editing a supply route's selling rule in place (updateOrder with patch.route).
import { describe, expect, it } from 'vitest';
import { Game } from '../src/sim/game';
import { G } from '../src/sim/goods';
import { checkLedger } from '../src/sim/ledger';

describe('updateOrder: a route’s selling rule can be changed in place', () => {
  it('switches from a fixed floor to landed cost and to any price, keeping the pipeline', () => {
    const g = Game.create({ seed: 3, warmup: false });
    const s = g.s;
    g.dispatch({ type: 'mint', amount: 50_000 });
    const farm = s.towns.find((t) => t.kind === 'farm')!.id;
    const harbor = s.towns.find((t) => t.kind === 'harbor')!.id;
    const p = s.markets[farm * 11 + G.grain].ema;
    const r = g.dispatch({ type: 'placeOrder', market: { kind: 'good', town: farm, good: G.grain }, side: 'buy', price: p * 1.2, qty: 30, route: { to: harbor, sell: 'fixed', sellPrice: 99 } });
    expect(r.ok).toBe(true);
    g.step(12);
    const o = s.policy.orders.find((x) => x.id === r.id)!;
    expect(o.route).not.toBeNull();
    const before = { shipped: o.route!.shippedTotal, waiting: o.route!.waiting, landed: o.route!.landed };

    const a = g.dispatch({ type: 'updateOrder', id: o.id, patch: { route: { sell: 'cost', sellMargin: 0.05 } } });
    expect(a.ok).toBe(true);
    expect(o.route!.sell).toBe('cost');
    expect(o.route!.sellMargin).toBeCloseTo(0.05);
    expect(o.route!.shippedTotal).toBe(before.shipped);
    expect(o.route!.waiting).toBe(before.waiting);
    expect(o.route!.landed).toBe(before.landed);

    const b = g.dispatch({ type: 'updateOrder', id: o.id, patch: { route: { sell: 'market' } } });
    expect(b.ok).toBe(true);
    expect(o.route!.sell).toBe('market');
    g.step(10);
    expect(o.route!.soldTotal).toBeGreaterThan(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('refuses invalid rules and non-route orders', () => {
    const g = Game.create({ seed: 3, warmup: false });
    const s = g.s;
    const farm = s.towns.find((t) => t.kind === 'farm')!.id;
    const plain = g.dispatch({ type: 'placeOrder', market: { kind: 'good', town: farm, good: G.grain }, side: 'buy', price: 3, qty: 5 });
    expect(g.dispatch({ type: 'updateOrder', id: plain.id!, patch: { route: { sell: 'market' } } }).ok).toBe(false);
    const harbor = s.towns.find((t) => t.kind === 'harbor')!.id;
    const route = g.dispatch({ type: 'placeOrder', market: { kind: 'good', town: farm, good: G.grain }, side: 'buy', price: 3, qty: 5, route: { to: harbor, sell: 'market' } });
    expect(g.dispatch({ type: 'updateOrder', id: route.id!, patch: { route: { sell: 'fixed', sellPrice: -1 } } }).ok).toBe(false);
  });
});
