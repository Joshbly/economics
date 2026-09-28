// Household-side responses to levies, using the real levies module.
import { describe, expect, it } from 'vitest';
import { killPerson } from '../src/sim/agents/demography';
import { householdsBeginDay } from '../src/sim/agents/households';
import { housingStep } from '../src/sim/agents/housing';
import { headLevyDiff, laborMarket, netWage, wageCtx } from '../src/sim/agents/labor';
import { checkLedger } from '../src/sim/ledger';
import type { Levy, SimState } from '../src/sim/types';
import { STATE } from '../src/sim/types';
import { addFirm, addHouse, addPerson, reconcile, tinyWorld } from './households.fixture';

function levy(s: SimState, l: Partial<Levy>): Levy {
  const full: Levy = {
    id: s.ids.policy++,
    label: 'test',
    enabled: true,
    dir: 1,
    base: 'sale',
    unit: 'pct',
    rate: 0,
    payer: 'buyer',
    threshold: 0,
    good: -1,
    town: -1,
    toTown: -1,
    sector: 'any',
    group: 'all',
    buildingKind: 'any',
    created: s.day,
    until: -1,
    today: 0,
    month: 0,
    lastMonth: 0,
    total: 0,
    ...l,
  };
  s.policy.levies.push(full);
  return full;
}

describe('levies seen from the household side', () => {
  it('a worker-side wage levy lowers take-home offers; a wage give raises them', () => {
    const s = tinyWorld();
    const f = addFirm(s, 'bakery', 0, 12, 10, 10, 1);
    expect(netWage(s, wageCtx(s), f)).toBeCloseTo(10, 9);
    const l = levy(s, { base: 'wage', payer: 'worker', rate: 0.2 });
    expect(netWage(s, wageCtx(s), f)).toBeCloseTo(8, 9);
    l.dir = -1;
    expect(netWage(s, wageCtx(s), f)).toBeCloseTo(12, 9);
    // Employer-side levies do not change what the worker takes home.
    l.dir = 1;
    l.payer = 'employer';
    expect(netWage(s, wageCtx(s), f)).toBeCloseTo(10, 9);
  });

  it('a worker levy can price a job below a seeker’s reservation wage', () => {
    const s = tinyWorld();
    const f = addFirm(s, 'bakery', 0, 12, 10, 10, 1);
    const p = addPerson(s, 0, 500, { lastWage: 10 }); // reservation 9
    levy(s, { base: 'wage', payer: 'worker', rate: 0.2 });
    laborMarket(s);
    expect(p.job).toBe(-1);
    s.policy.levies.length = 0;
    laborMarket(s);
    expect(p.job).toBe(f.id);
  });

  it('a per-head payment only the jobless receive raises the bar for taking a job', () => {
    const s = tinyWorld();
    const f = addFirm(s, 'bakery', 0, 12, 10, 10, 1);
    const p = addPerson(s, 0, 500, { lastWage: 10 });
    s.treasury.autoMint = true;
    levy(s, { base: 'head', dir: -1, unit: 'flat', rate: 3, payer: 'receiver', group: 'unemployed' });
    expect(headLevyDiff(s, p, f.id)).toBeCloseTo(3, 9);
    expect(p.job).toBe(-1); // helper restores the person's state
    laborMarket(s); // 10 < 9 + 3
    expect(p.job).toBe(-1);
    // A payment to everyone does not change the calculus.
    s.policy.levies[0].group = 'all';
    expect(headLevyDiff(s, p, f.id)).toBeCloseTo(0, 9);
    laborMarket(s);
    expect(p.job).toBe(f.id);
  });

  it('rent levies: tenant-side give is paid by the Treasury and booked as income', () => {
    const s = tinyWorld();
    s.treasury.autoMint = true;
    const landlord = addPerson(s, 0, 0);
    const h = addHouse(s, 0, 5, 5, 2, landlord.id);
    const t = addPerson(s, 0, 50);
    h.residents.push(t.id);
    t.home = h.id;
    levy(s, { base: 'rent', dir: -1, unit: 'pct', rate: 0.5, payer: 'tenant' });
    levy(s, { base: 'rent', dir: 1, unit: 'pct', rate: 0.1, payer: 'landlord' });
    reconcile(s);
    housingStep(s);
    expect(t.cash).toBeCloseTo(50 - 2 + 1, 9);
    expect(t.earned).toBeCloseTo(1, 9);
    expect(landlord.cash).toBeCloseTo(2 - 0.2, 9);
    expect(landlord.earned).toBeCloseTo(2 - 0.2, 9);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('estate levies take their share before the heir inherits', () => {
    const s = tinyWorld();
    const dead = addPerson(s, 0, 1000);
    const heir = addPerson(s, 0, 0);
    levy(s, { base: 'estate', unit: 'pct', rate: 0.2, payer: 'receiver', threshold: 500 });
    reconcile(s);
    const purse = s.treasury.purse;
    killPerson(s, dead, 'age');
    expect(s.treasury.purse).toBeCloseTo(purse + 100, 9);
    expect(heir.cash).toBeCloseTo(900, 9);
    expect(dead.cash).toBe(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a levy on money held shrinks desired buffers, so people spend more', () => {
    const s = tinyWorld();
    const p = addPerson(s, 0, 800);
    householdsBeginDay(s);
    const before = p.budget;
    levy(s, { base: 'money', unit: 'pct', rate: 0.1, payer: 'holder' });
    p.earned = 10;
    householdsBeginDay(s);
    expect(p.budget).toBeGreaterThan(before);
    expect(STATE).toBe(-1);
  });
});
