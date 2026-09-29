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
  it('an eager following buy re-sets its limit daily to the going price + band', () => {
    const { g, s, town } = setup();
    const r = g.dispatch({ type: 'placeOrder', market: { kind: 'good', town, good: G.tools }, side: 'buy', price: 0, qty: 3, priceMode: 'follow', band: 0.1, pace: 'eager' });
    expect(r.ok).toBe(true);
    const o = s.policy.orders.find((x) => x.id === r.id)!;
    expect(o.priceMode).toBe('follow');
    expect(r.message).toMatch(/10% above the going price/);
    for (let d = 0; d < 20; d++) {
      g.step(1);
      const ref = s.markets[town * N_GOODS + G.tools].ownEma!;
      // Limit set this morning from yesterday's going price (the market's own): within the band of today's.
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

  it('a patient buy opens near the going price, bids higher within the day only when short, and learns where to open', () => {
    const { g, s, town } = setup();
    const r = g.dispatch({ type: 'placeOrder', market: { kind: 'good', town, good: G.tools }, side: 'buy', price: 0, qty: 3, priceMode: 'follow', band: 0.05 });
    expect(r.ok, r.message).toBe(true);
    const o = s.policy.orders.find((x) => x.id === r.id)!;
    expect(o.pace).toBe('patient'); // the default for new following orders
    expect(o.offset).toBe(0);
    expect(r.message).toMatch(/bidding as low as it can — it opens near the going price .* bids higher at midday and the close only when a session leaves it short, never more than 5% above the going price/);
    const m = s.markets[town * N_GOODS + G.tools];
    let ups = 0;
    let downs = 0;
    let bought = 0;
    for (let d = 0; d < 40; d++) {
      const open = o.offset ?? 0;
      // today's opening limit = the market's own going price × (1 + step)
      expect(effectiveOrderLimit(s, o)).toBeCloseTo((m.ownEma ?? m.ema) * (1 + open), 6);
      g.step(1);
      const reached = o.reached ?? open;
      expect(reached).toBeGreaterThanOrEqual(open - 1e-12); // within the day it only ever bids higher
      expect(reached).toBeLessThanOrEqual(0.05 + 1e-12);
      expect(o.offset!).toBeGreaterThanOrEqual(-0.05 - 1e-12);
      expect(o.offset!).toBeLessThanOrEqual(0.05 + 1e-12);
      if (o.offset! > open + 1e-12) ups++;
      else if (o.offset! < open - 1e-12) downs++;
      bought += o.filledToday;
    }
    expect(ups + downs).toBeGreaterThan(0);
    expect(downs).toBeGreaterThan(0); // it keeps probing for a lower opening
    expect(bought).toBeGreaterThan(0.8 * 3 * 40); // and still gets its quantity
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a patient buy far larger than the market bids the band’s edge by the close, never beyond', () => {
    const { g, s, town } = setup();
    const m = s.markets[town * N_GOODS + G.bread];
    const r = g.dispatch({ type: 'placeOrder', market: { kind: 'good', town, good: G.bread }, side: 'buy', price: 0, qty: Math.max(50, 5 * m.volEma), priceMode: 'follow', band: 0.1 });
    const o = s.policy.orders.find((x) => x.id === r.id)!;
    g.step(1);
    expect(o.reached).toBeCloseTo(0.1, 9); // short at the opening and at midday: the close at the edge
    expect(o.price).toBeLessThanOrEqual((m.ownEma ?? m.ema) * 1.1 * 1.05); // today's last limit, near own × 1.1
    expect(o.offset).toBeCloseTo(0.025, 9); // no session filled: tomorrow opens a step higher
  });

  it('the market’s own price leaves out the Treasury: a big purchase raises the auction price, not its own', () => {
    const { g, s, town } = setup();
    const m = s.markets[town * N_GOODS + G.tools];
    g.dispatch({ type: 'placeOrder', market: { kind: 'good', town, good: G.tools }, side: 'buy', price: m.ema * 3, qty: Math.max(5, m.volEma * 0.6) });
    g.step(1);
    expect(m.own).toBeGreaterThan(0);
    expect(m.price).toBeGreaterThan(m.own! * 1.01); // the Treasury's buying lifted today's price
    expect(m.ema).toBeGreaterThan(m.ownEma!); // … and the smoothed price, but not the market's own
  });
});

describe('the Treasury never trades with itself', () => {
  it('crossing buy and sell orders in one market cancel; only the difference goes to market', () => {
    const { g, s, town } = setup();
    g.dispatch({ type: 'placeOrder', market: { kind: 'good', town, good: G.bread }, side: 'buy', price: 99, qty: 60, once: true });
    g.step(1);
    const held = s.treasury.goods[town][G.bread];
    expect(held).toBeGreaterThan(30);
    const b = g.dispatch({ type: 'placeOrder', market: { kind: 'good', town, good: G.bread }, side: 'buy', price: 50, qty: 20 });
    const a = g.dispatch({ type: 'placeOrder', market: { kind: 'good', town, good: G.bread }, side: 'sell', price: 0.5, qty: 30 });
    g.step(1);
    const ob = s.policy.orders.find((x) => x.id === b.id)!;
    const oa = s.policy.orders.find((x) => x.id === a.id)!;
    expect(ob.nettedToday).toBeCloseTo(20, 9);
    expect(oa.nettedToday).toBeCloseTo(20, 9);
    expect(ob.filledToday).toBe(0); // it did not buy its own bread
    expect(oa.filledToday).toBeLessThanOrEqual(10 + 1e-9); // only the net 10 went to market
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });
});
