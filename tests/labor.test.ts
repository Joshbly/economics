import { beforeEach, describe, expect, it, vi } from 'vitest';

// Legal wage bounds come from the policy module (another engineer's); control them here.
const lim = vi.hoisted(() => ({ min: -1, max: -1 }));
vi.mock('../src/sim/policy/limits', async (orig) => {
  const real = await orig<typeof import('../src/sim/policy/limits')>();
  return { ...real, wageBounds: () => ({ min: lim.min, max: lim.max }) };
});

import { commuteTiles, fire, hire, laborMarket, reservationWage } from '../src/sim/agents/labor';
import type { SimState } from '../src/sim/types';
import { addFirm, addHouse, addPerson, tinyWorld } from './households.fixture';

function consistent(s: SimState): void {
  for (const f of s.firms) {
    for (const w of f.workers) expect(s.people[w].job).toBe(f.id);
    expect(new Set(f.workers).size).toBe(f.workers.length);
  }
  for (const p of s.people) {
    if (p.alive && p.job >= 0) expect(s.firms[p.job].workers).toContain(p.id);
  }
}

describe('labour market matching', () => {
  let s: SimState;
  beforeEach(() => {
    s = tinyWorld();
    lim.min = -1;
    lim.max = -1;
  });

  it('fills vacancies up to target, within the daily hiring cap', () => {
    const f = addFirm(s, 'bakery', 0, 12, 10, 10, 5);
    f.capacity = 50; // hiring cap = 10 % of capacity = 5/day
    const people = Array.from({ length: 8 }, () => addPerson(s, 0, 100, { lastWage: 9 }));
    laborMarket(s);
    expect(f.workers.length).toBe(5);
    expect(s.stats.acc.hires).toBe(5);
    expect(f.hired).toBe(5);
    expect(f.vacancyDays).toBe(0);
    const employed = people.filter((p) => p.job === f.id);
    expect(employed.length).toBe(5);
    for (const p of employed) {
      expect(p.wage).toBe(10);
      expect(p.tenure).toBe(0);
      expect(p.commute).toBeCloseTo(commuteTiles(s, p, f), 6);
    }
    for (const p of people.filter((q) => q.job < 0)) expect(p.unempDays).toBe(1);
    consistent(s);
  });

  it('small firms hire at most one per day; vacancy clock runs while unfilled', () => {
    const f = addFirm(s, 'bakery', 0, 12, 10, 10, 4);
    f.capacity = 8;
    for (let i = 0; i < 6; i++) addPerson(s, 0, 100, { lastWage: 9 });
    laborMarket(s);
    expect(f.workers.length).toBe(1);
    expect(f.vacancyDays).toBe(1);
    for (let d = 0; d < 5; d++) laborMarket(s);
    expect(f.workers.length).toBe(4);
    expect(f.vacancyDays).toBe(0);
    consistent(s);
  });

  it('a firm whose wage is below the legal minimum cannot hire', () => {
    const low = addFirm(s, 'bakery', 0, 12, 10, 10, 5);
    low.capacity = 50;
    for (let i = 0; i < 5; i++) addPerson(s, 0, 100, { lastWage: 5 });
    lim.min = 12;
    laborMarket(s);
    expect(low.workers.length).toBe(0);
    expect(low.vacancyDays).toBe(1);
    low.wage = 12;
    laborMarket(s);
    expect(low.workers.length).toBe(5);
  });

  it('offers are capped at a legal maximum wage', () => {
    const a = addFirm(s, 'bakery', 0, 12, 10, 30, 1);
    const p = addPerson(s, 0, 100, { lastWage: 25 }); // reservation 22.5
    lim.max = 20;
    laborMarket(s);
    expect(p.job).toBe(-1);
    lim.max = -1;
    laborMarket(s);
    expect(p.job).toBe(a.id);
  });

  it('prefers the better net offer', () => {
    const cheap = addFirm(s, 'bakery', 0, 11, 10, 9, 1);
    const good = addFirm(s, 'brewery', 0, 11, 11, 14, 1);
    cheap.capacity = good.capacity = 10;
    const p = addPerson(s, 0, 100, { lastWage: 8 });
    // Sampling is random; over a few seekers the better firm must win the first.
    laborMarket(s);
    expect(p.job).toBe(good.id);
  });

  it('reservation wage decays with unemployment and hunger', () => {
    const p = addPerson(s, 0, 1000, { lastWage: 20 });
    const fresh = reservationWage(s, p, 10);
    p.unempDays = 200;
    const stale = reservationWage(s, p, 10);
    expect(stale).toBeLessThan(fresh);
    expect(stale).toBeCloseTo(20 * 0.55, 6);
    p.foodSat = 0.2;
    expect(reservationWage(s, p, 10)).toBeLessThan(stale);
    const newcomer = addPerson(s, 0, 1000, { lastWage: 0 });
    expect(reservationWage(s, newcomer, 10)).toBeCloseTo(9, 6);
  });

  it('the long unemployed eventually accept a lower wage', () => {
    const f = addFirm(s, 'bakery', 0, 12, 10, 12, 1);
    const p = addPerson(s, 0, 1000, { lastWage: 20 });
    laborMarket(s);
    expect(p.job).toBe(-1);
    p.unempDays = 150;
    laborMarket(s);
    expect(p.job).toBe(f.id);
  });

  it('layoffs: gradual, lowest tenure first; liquidating firms release everyone', () => {
    const f = addFirm(s, 'bakery', 0, 12, 10, 10, 10);
    f.capacity = 20;
    const ws = Array.from({ length: 10 }, (_, i) => {
      const p = addPerson(s, 0, 100);
      hire(s, f, p);
      p.tenure = 100 + i * 10;
      return p;
    });
    ws[7].tenure = 1; // newest hire
    f.target = 4;
    laborMarket(s);
    expect(f.workers.length).toBe(9); // max(1, 5 % of 10)
    expect(ws[7].job).toBe(-1);
    expect(s.stats.acc.fires).toBe(1);
    expect(f.fired).toBe(1);
    expect(ws[7].lastWage).toBeGreaterThan(0);
    consistent(s);

    const g = addFirm(s, 'brewery', 0, 14, 10, 10, 3);
    const gw = Array.from({ length: 3 }, () => {
      const p = addPerson(s, 0, 100);
      hire(s, g, p);
      return p;
    });
    g.status = 'liquidating';
    laborMarket(s);
    expect(g.workers.length).toBe(0);
    for (const p of gw) expect(p.job).toBe(-1);
    consistent(s);
  });

  it('Treasury Works hire like any employer at their posted wage and release when the target falls', () => {
    const sw = addFirm(s, 'stateworks', 0, 10, 10, 11, 30);
    const ps = Array.from({ length: 30 }, () => addPerson(s, 0, 100, { lastWage: 10 }));
    laborMarket(s);
    const n1 = sw.workers.length;
    expect(n1).toBeGreaterThan(0);
    expect(n1).toBeLessThanOrEqual(30);
    for (let d = 0; d < 20; d++) laborMarket(s);
    expect(sw.workers.length).toBe(30);
    sw.target = 0;
    laborMarket(s);
    expect(sw.workers.length).toBeLessThan(30);
    expect(ps.some((p) => p.job < 0)).toBe(true);
    consistent(s);
  });

  it('on-the-job search moves workers to much better offers (and counts quits)', () => {
    const bad = addFirm(s, 'bakery', 0, 12, 10, 8, 20);
    bad.capacity = 20;
    const ws = Array.from({ length: 20 }, () => {
      const p = addPerson(s, 0, 100);
      hire(s, bad, p);
      p.tenure = 50;
      return p;
    });
    const great = addFirm(s, 'brewery', 0, 12, 11, 16, 20);
    great.capacity = 200;
    for (let d = 0; d < 200; d++) laborMarket(s);
    expect(great.workers.length).toBeGreaterThan(0);
    expect(s.stats.acc.quits).toBeGreaterThan(0);
    expect(ws.filter((p) => p.job === great.id).length).toBe(great.workers.length);
    consistent(s);
  });

  it('repairs inconsistent worker lists (dead workers, stale refs)', () => {
    const f = addFirm(s, 'bakery', 0, 12, 10, 10, 3);
    const a = addPerson(s, 0, 100);
    const b = addPerson(s, 0, 100);
    hire(s, f, a);
    hire(s, f, b);
    b.alive = false; // died without leaving
    f.workers.push(a.id); // duplicate
    const c = addPerson(s, 0, 100);
    c.job = f.id; // claims the job, not listed
    laborMarket(s);
    expect(f.workers).not.toContain(b.id);
    expect(f.workers.filter((x) => x === a.id).length).toBe(1);
    expect(f.workers).toContain(c.id);
    consistent(s);
  });

  it('commute is measured from home (or town centre) to the workplace', () => {
    const f = addFirm(s, 'bakery', 0, 20, 10, 10, 1);
    const p = addPerson(s, 0, 100);
    const h = addHouse(s, 0, 2, 10, 1, -1);
    expect(commuteTiles(s, p, f)).toBeCloseTo(10, 1); // town centre (10.5) → (20.5)
    p.home = h.id;
    h.residents.push(p.id);
    expect(commuteTiles(s, p, f)).toBeCloseTo(18, 1);
    fire(s, f, p); // no-op for a non-worker, must not throw or count
    expect(p.job).toBe(-1);
    expect(f.fired).toBe(0);
  });
});
