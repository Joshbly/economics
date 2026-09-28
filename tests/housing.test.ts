import { describe, expect, it, vi } from 'vitest';

// Legal rent bounds come from the policy module (another engineer's); control them here.
const lim = vi.hoisted(() => ({ min: -1, max: -1 }));
vi.mock('../src/sim/policy/limits', async (orig) => {
  const real = await orig<typeof import('../src/sim/policy/limits')>();
  return { ...real, rentBounds: () => ({ min: lim.min, max: lim.max }) };
});

import { findHome, housingStep, leaveHome } from '../src/sim/agents/housing';
import { hire } from '../src/sim/agents/labor';
import { EVICT_ARREARS_DAYS, RENT_UP } from '../src/sim/config';
import { checkLedger } from '../src/sim/ledger';
import { STATE } from '../src/sim/types';
import { addFirm, addHouse, addPerson, reconcile, tinyWorld } from './households.fixture';

describe('housing', () => {
  it('tenants pay rent to landlords (people and the Treasury); ledger balanced', () => {
    const s = tinyWorld();
    const landlord = addPerson(s, 0, 100);
    const h1 = addHouse(s, 0, 5, 5, 2, landlord.id);
    const h2 = addHouse(s, 0, 6, 5, 1.5, STATE);
    const a = addPerson(s, 0, 50);
    const b = addPerson(s, 0, 50);
    expect(findHome(s, a, 0)).toBe(true);
    expect(findHome(s, b, 0)).toBe(true);
    // Both pick the cheaper Treasury house.
    expect(a.home).toBe(h2.id);
    expect(h2.residents).toEqual([a.id, b.id]);
    // Move b into the landlord's house to test private rent.
    leaveHome(s, b);
    h1.residents.push(b.id);
    b.home = h1.id;
    reconcile(s);
    const purse = s.treasury.purse;
    housingStep(s);
    expect(a.cash).toBeCloseTo(48.5, 9);
    expect(b.cash).toBeCloseTo(48, 9);
    expect(landlord.cash).toBeCloseTo(102, 9);
    expect(landlord.earned).toBeCloseTo(2, 9);
    expect(s.treasury.purse).toBeCloseTo(purse + 1.5, 9);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('arrears lead to eviction; owner-occupiers pay nothing', () => {
    const s = tinyWorld();
    const owner = addPerson(s, 0, 0);
    const h = addHouse(s, 0, 5, 5, 2, owner.id);
    owner.houses.push(h.id);
    const broke = addPerson(s, 0, 0); // income EMA still 10: lost their pay, cannot pay today
    h.residents.push(owner.id, broke.id);
    owner.home = broke.home = h.id;
    reconcile(s);
    for (let d = 0; d < EVICT_ARREARS_DAYS - 1; d++) housingStep(s);
    expect(broke.home).toBe(h.id);
    expect(broke.arrears).toBe(EVICT_ARREARS_DAYS - 1);
    housingStep(s);
    expect(broke.home).toBe(-1);
    expect(h.residents).toEqual([owner.id]);
    expect(s.stats.acc.evictions).toBe(1);
    expect(owner.home).toBe(h.id);
    expect(owner.arrears).toBe(0);
    // Without a deposit they cannot move straight back in.
    housingStep(s);
    expect(broke.home).toBe(-1);
  });

  it('the homeless take affordable slots only; vacancy and homeless tallies', () => {
    const s = tinyWorld();
    addHouse(s, 0, 5, 5, 8, STATE, 2);
    const rich = addPerson(s, 0, 1000, { income: 30 });
    const poor = addPerson(s, 0, 5, { income: 2 });
    reconcile(s);
    housingStep(s);
    expect(rich.home).toBeGreaterThanOrEqual(0);
    expect(poor.home).toBe(-1);
    expect(s.towns[0].homeless).toBe(1);
    expect(s.towns[0].vacantSlots).toBe(1);
    expect(s.stats.acc.homeless).toBe(1);
    expect(findHome(s, poor, 0, { force: true })).toBe(true);
  });

  it('long commuters move closer to work', () => {
    const s = tinyWorld(2);
    const far = addHouse(s, 0, 2, 10, 1, STATE);
    addHouse(s, 1, 30, 10, 1, STATE);
    const f = addFirm(s, 'bakery', 1, 31, 10, 10, 1);
    const p = addPerson(s, 0, 500, { income: 10 });
    far.residents.push(p.id);
    p.home = far.id;
    hire(s, f, p);
    expect(p.commute).toBeGreaterThan(20);
    reconcile(s);
    for (let d = 0; d < 1500 && p.town === 0; d++) {
      housingStep(s);
      s.day++;
    }
    expect(p.town).toBe(1);
    expect(p.commute).toBeLessThan(5);
    expect(s.stats.acc.moves).toBeGreaterThanOrEqual(1);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('monthly rents rise when full with paying homeless, fall when empty, obey legal bounds', () => {
    const s = tinyWorld();
    const full = addHouse(s, 0, 5, 5, 2, STATE, 1);
    const empty = addHouse(s, 1 - 1, 7, 5, 2, STATE, 1);
    const t = addPerson(s, 0, 1000, { income: 20 });
    full.residents.push(t.id);
    t.home = full.id;
    empty.vacantDays = 40;
    addPerson(s, 0, 1000, { income: 1 }); // homeless who could pay (cash cushion) but empty house too dear? rent 2 ≤ 1000/30
    reconcile(s);
    s.day = 30; // month start
    lim.max = -1;
    housingStep(s);
    // The homeless person took the empty house today, so it is now full too.
    expect(full.rent).toBeGreaterThan(2);
    expect(full.rent).toBeLessThanOrEqual(2 * (1 + RENT_UP) * 1.01 + 1e-9);

    const s2 = tinyWorld();
    const e2 = addHouse(s2, 0, 7, 5, 2, STATE, 1);
    e2.vacantDays = 40;
    s2.day = 60;
    housingStep(s2);
    expect(e2.rent).toBeLessThan(2);

    lim.max = 1.2;
    housingStep(s2);
    expect(e2.rent).toBeLessThanOrEqual(1.2);
    lim.max = -1;
    lim.min = 3;
    housingStep(s2);
    expect(e2.rent).toBeGreaterThanOrEqual(3);
    lim.min = -1;
  });
});
