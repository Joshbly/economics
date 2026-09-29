// Orders for Treasury workers that staff the town's Treasury projects automatically, the
// going wage, and the Works panel's account of who is where (policy/crews.treasuryCrew).
import { describe, expect, it } from 'vitest';
import { stepDay } from '../src/sim/engine';
import { checkLedger } from '../src/sim/ledger';
import { treasuryCrew } from '../src/sim/policy/crews';
import { dispatch, goingWage } from '../src/sim/policy/player';
import { createWorld } from '../src/sim/world/init';
import type { SimState } from '../src/sim/types';

const FORBIDDEN = /\b(tax|taxes|subsid\w*|public works|jobs program\w*|stimulus|nationali[sz]\w*)\b/i;

function world(): SimState {
  const s = createWorld({ seed: 1 });
  s.settings.events = false;
  s.treasury.autoMint = true;
  for (let d = 0; d < 10; d++) stepDay(s);
  return s;
}

const staffOrder = (town: number, extra: Record<string, unknown> = {}) =>
  ({ type: 'placeOrder', market: { kind: 'labor', town }, side: 'buy', price: 0, qty: 40, priceMode: 'follow', band: 0.1, staff: 'projects', ...extra }) as const;

describe('orders for Treasury workers', () => {
  it('validate: staffing only for workers; the going wage allowed, "any price" not', () => {
    const s = world();
    expect(dispatch(s, { type: 'placeOrder', market: { kind: 'good', town: 0, good: 8 }, side: 'buy', price: 3, qty: 5, staff: 'projects' }).ok).toBe(false);
    expect(dispatch(s, { type: 'placeOrder', market: { kind: 'labor', town: 0 }, side: 'buy', price: 0, qty: 5, priceMode: 'any' }).ok).toBe(false);
    const r = dispatch(s, staffOrder(0));
    expect(r.ok, r.message).toBe(true);
    const o = s.policy.orders.find((x) => x.id === r.id)!;
    expect(o.price).toBeCloseTo(goingWage(s, 0) * 1.1, 6);
    expect(o.staffToday).toBe(0); // nothing to build yet
    expect(r.message).toMatch(/as many people in .* as its building projects there can use/);
    expect(r.message).not.toMatch(FORBIDDEN);
  });

  it('hire for a project, work on it, and let people go when it is done', () => {
    const s = world();
    const road = dispatch(s, { type: 'build', kind: 'road', from: 0, to: 1 });
    expect(road.ok, road.message).toBe(true);
    const r = dispatch(s, staffOrder(0));
    const o = s.policy.orders.find((x) => x.id === r.id)!;
    let peak = 0;
    let worked = 0;
    let done = -1;
    for (let d = 1; d <= 200 && done < 0; d++) {
      stepDay(s);
      const c = treasuryCrew(s, 0);
      peak = Math.max(peak, c.workers.length);
      worked += c.sites.reduce((a, x) => a + x.people.length, 0);
      // everyone is accounted for exactly once
      expect(c.drivers.length + c.sites.reduce((a, x) => a + x.people.length, 0) + c.idle.length).toBe(c.workers.length);
      if (!s.projects.some((p) => p.id === road.id && p.status !== 'done')) done = d;
    }
    expect(done).toBeGreaterThan(0);
    expect(peak).toBeGreaterThan(3);
    expect(worked).toBeGreaterThan(20);
    expect(o.price).toBeGreaterThan(0);
    for (let d = 0; d < 5; d++) stepDay(s);
    expect(o.staffToday).toBe(0);
    expect(treasuryCrew(s, 0).workers.length).toBe(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-3);
  });

  it('switches between a set number and automatic staffing', () => {
    const s = world();
    const r = dispatch(s, { type: 'placeOrder', market: { kind: 'labor', town: 1 }, side: 'buy', price: 9, qty: 4 });
    const o = s.policy.orders.find((x) => x.id === r.id)!;
    expect(o.staff).toBeUndefined();
    expect(dispatch(s, { type: 'updateOrder', id: o.id, patch: { staff: 'projects', priceMode: 'follow', band: 0.25 } }).ok).toBe(true);
    expect(o.staff).toBe('projects');
    expect(o.label).toMatch(/^Staff projects · /);
    expect(dispatch(s, { type: 'updateOrder', id: o.id, patch: { staff: 'fixed', qty: 2 } }).ok).toBe(true);
    expect(o.staff).toBeUndefined();
    expect(o.qty).toBe(2);
  });
});
