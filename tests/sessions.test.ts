// Three market sessions a day (opening, midday, close): left alone they clear at one price;
// what the Treasury does in one session shows in that session; buying at the opening and
// selling at the close are two trades (not cancelled as self-trade).
import { describe, expect, it } from 'vitest';
import { stepDay } from '../src/sim/engine';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger } from '../src/sim/ledger';
import { dispatch } from '../src/sim/policy/player';
import { createWorld } from '../src/sim/world/init';
import type { SimState } from '../src/sim/types';

function world(): SimState {
  const s = createWorld({ seed: 2 });
  s.settings.events = false;
  s.treasury.autoMint = true;
  for (let d = 0; d < 8; d++) stepDay(s);
  return s;
}

describe('market sessions', () => {
  it('a day left alone clears at one price in all three sessions', () => {
    const s = world();
    stepDay(s);
    let n = 0;
    for (const m of s.markets) {
      if (!m.traded || !m.sess) continue;
      n++;
      expect(m.sess.length).toBe(3);
      expect(Math.max(...m.sess) / Math.min(...m.sess) - 1).toBeLessThan(1e-3);
      // the day's volume is the sessions' sum; its price their volume-weighted mean
      expect(m.volume).toBeCloseTo(m.sessVol!.reduce((a, b) => a + b, 0), 2);
    }
    expect(n).toBeGreaterThan(10);
  });

  it('a big purchase at the opening lifts the opening price, not the close', () => {
    const s = world();
    const m = s.markets[0 * N_GOODS + G.bread];
    const r = dispatch(s, { type: 'placeOrder', market: { kind: 'good', town: 0, good: G.bread }, side: 'buy', price: m.ema * 3, qty: Math.max(10, m.volEma * 0.5), session: 0, once: true });
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/a day at the opening in /);
    stepDay(s);
    expect(m.sess![0]).toBeGreaterThan(m.sess![2] * 1.02);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('buying at the opening and selling at the close are two trades, not a self-trade', () => {
    const s = world();
    const m = s.markets[0 * N_GOODS + G.bread];
    const b = dispatch(s, { type: 'placeOrder', market: { kind: 'good', town: 0, good: G.bread }, side: 'buy', price: m.ema * 3, qty: 20, session: 0 });
    // the Treasury holds nothing yet: the evening sale can only sell what the morning bought
    stepDay(s);
    const held = s.treasury.goods[0][G.bread];
    expect(held).toBeGreaterThan(18.9); // 20 bought, less a night of staleness (5 %)
    const a = dispatch(s, { type: 'placeOrder', market: { kind: 'good', town: 0, good: G.bread }, side: 'sell', price: 0.01, qty: 20, session: 2 });
    stepDay(s);
    const ob = s.policy.orders.find((x) => x.id === b.id)!;
    const oa = s.policy.orders.find((x) => x.id === a.id)!;
    expect(ob.nettedToday ?? 0).toBe(0);
    expect(oa.nettedToday ?? 0).toBe(0);
    expect(ob.filledToday).toBeCloseTo(20, 6);
    expect(oa.filledToday).toBeGreaterThan(19);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('validates the session', () => {
    const s = world();
    const base = { type: 'placeOrder' as const, market: { kind: 'good' as const, town: 0, good: G.bread }, side: 'buy' as const, price: 5, qty: 2 };
    expect(dispatch(s, { ...base, session: 3 }).ok).toBe(false);
    expect(dispatch(s, { ...base, session: 1.5 }).ok).toBe(false);
    expect(dispatch(s, { type: 'placeOrder', market: { kind: 'labor', town: 0 }, side: 'buy', price: 9, qty: 2, session: 1 }).ok).toBe(false);
    const r = dispatch(s, { ...base, session: 2 });
    expect(r.ok).toBe(true);
    const o = s.policy.orders.find((x) => x.id === r.id)!;
    expect(o.session).toBe(2);
    expect(dispatch(s, { type: 'updateOrder', id: o.id, patch: { session: -1 } }).ok).toBe(true);
    expect(o.session).toBeUndefined();
  });
});
