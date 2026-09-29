// Entrepreneurship (entry.ts): interest-rate-sensitive entry, one venture per owner, staggered exit.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/sim/world/layout', async () => {
  const factory = await import('../src/sim/factory');
  const actual = await vi.importActual<typeof import('../src/sim/world/layout')>('../src/sim/world/layout');
  let nx = 20;
  return {
    ...actual,
    accessTrack: () => [],
    siteFits: () => true,
    findSite: () => ({ x: nx++, y: 20 }),
    isValidSite: () => true,
    placeBuilding: (s: any, kind: any, sector: any, town: number, x: number, y: number, status: any) => {
      const b = factory.newBuilding(s, kind, sector, town, x, y, 1, 1, status);
      s.map.occ[y * s.map.w + x] = b.id;
      return b;
    },
    removeBuilding: (s: any, b: any) => {
      b.status = 'ruin';
      b.project = -1;
      s.map.occ[b.y * s.map.w + b.x] = -1;
    },
    siteMultiplier: () => 1,
  };
});

import { entryStep } from '../src/sim/agents/entry';
import { createFirm } from '../src/sim/agents/firms';
import { DAYS_PER_MONTH, ENTRY_DAY, EXIT_LOSS_DAYS } from '../src/sim/config';
import { newBuilding, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { G, N_GOODS, SECTORS } from '../src/sim/goods';
import { reconcileBank } from '../src/sim/ledger';
import type { Firm, MapData, Person, Sector, SimState } from '../src/sim/types';
import { STATE } from '../src/sim/types';

const PRICES = [2.67, 3.38, 2.69, 2.71, 2.26, 3.39, 13.6, 24.5, 4.08, 2.88, 23.4];

function tinyMap(w = 48, h = 32): MapData {
  const n = w * h;
  const z = () => new Array(n).fill(0);
  return { w, h, terrain: new Array(n).fill(3), elev: z(), fert: new Array(n).fill(0.5), deposit: new Array(n).fill(0.5), river: z(), road: z(), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

/** One town with a builder and plenty of empty homes (so no house-building signal). */
function world(seed = 7): SimState {
  const s = newSimState(seed, tinyMap());
  s.towns.push(newTown(0, 'Kingsbridge', 'capital', 10, 10, 5));
  for (let g = 0; g < N_GOODS; g++) s.markets[g] = newMarket(0, g, PRICES[g]);
  s.treasury = newTreasury(1);
  s.stats.baseWage = 10;
  s.bank.baseRate = 0.045;
  s.day = 400;
  const bb = newBuilding(s, 'firm', 'builder', 0, 2, 2, 1, 1, 'active');
  const b = createFirm(s, 'builder', 0, bb.id, STATE);
  b.founded = s.day - 1000;
  const h = newBuilding(s, 'house', '', 0, 4, 4, 1, 1, 'active');
  h.slots = 100;
  return s;
}

function person(s: SimState, cash: number, opts: Partial<Person> = {}): Person {
  const p = newPerson(s, 0, 'P' + s.ids.person);
  p.cash = cash;
  p.health = 1;
  p.income = 10;
  p.home = 1; // the house above (not homeless)
  Object.assign(p, opts);
  return p;
}

function firm(s: SimState, sector: Sector, x: number, opts: Partial<Firm> = {}): Firm {
  const b = newBuilding(s, 'firm', sector, 0, x, 8, 1, 1, 'active');
  const f = createFirm(s, sector, 0, b.id, STATE);
  f.founded = s.day - 1000;
  f.wage = 10;
  Object.assign(f, opts);
  return f;
}

/** Run entryStep on the entry day of the next `months` months. */
function months(s: SimState, n: number, each?: () => void): void {
  for (let m = 0; m < n; m++) {
    while ((s.day % DAYS_PER_MONTH) + 1 !== ENTRY_DAY) s.day++;
    entryStep(s);
    each?.();
    s.day++;
  }
}

function newBakeryProjects(s: SimState): number {
  return s.projects.filter((p) => p.kind === 'firm' && p.sector === 'bakery' && p.status !== 'cancelled').length;
}

describe('entry', () => {
  /** Two mature bakeries earning a moderate return on the cost of a new one, in a market with room for a third. */
  function profitableTown(rate: number): { s: SimState; owner: Person } {
    const s = world();
    s.bank.baseRate = rate;
    s.markets[G.bread].ema = 5; // a margin over grain and coal that pays a newcomer's hands at its share of the trade
    for (let i = 0; i < 2; i++) firm(s, 'bakery', 10 + i, { profit: 25, capacity: 8, target: 4, sales: 100, salesLong: 100 });
    const owner = person(s, 200000); // can pay for a workshop outright
    s.bank.reserves = 1e6;
    reconcileBank(s);
    return { s, owner };
  }

  it('is interest-rate sensitive: the same prospects attract a venture at low rates, none at high rates', () => {
    const lo = profitableTown(0.02);
    months(lo.s, 12);
    expect(newBakeryProjects(lo.s)).toBeGreaterThanOrEqual(1);

    const hi = profitableTown(0.6);
    months(hi.s, 12);
    expect(newBakeryProjects(hi.s)).toBe(0);
  });

  it('a self-funded venture pays its advance to the builder; one owner runs one venture at a time', () => {
    const { s, owner } = profitableTown(0.02);
    const cash0 = owner.cash;
    months(s, 12);
    const mine = s.projects.filter((p) => p.owner === owner.id && p.status !== 'cancelled');
    expect(mine.length).toBe(1); // the only entrepreneur waits for the first project to finish
    expect(mine[0].prepaid).toBeGreaterThan(0);
    expect(owner.cash).toBeCloseTo(cash0 - mine[0].prepaid, 6);
    const b = s.firms[mine[0].builder];
    expect(b.cash).toBeCloseTo(mine[0].prepaid, 6);
  });

  it('a newcomer must pay its way at its share of the trade: a thin market gets no second workshop', () => {
    const { s } = profitableTown(0.02);
    for (const f of s.firms) if (f.sector === 'bakery') f.sales = f.salesLong = 8; // the town buys 16 loaves a day
    months(s, 12);
    expect(newBakeryProjects(s)).toBe(0);
  });

  it('chronic loss-makers leave one at a time, and the last firm of a trade in a town stays', () => {
    const s = world();
    const fs: Firm[] = [];
    for (let i = 0; i < 4; i++) fs.push(firm(s, 'furniture', 10 + i, { profit: -5 - i, lossDays: 4 * EXIT_LOSS_DAYS, cash: 10 }));
    s.bank.reserves = 1e6;
    reconcileBank(s);
    const activeCount = () => fs.filter((f) => f.status === 'active').length;
    let prev = activeCount();
    months(s, 36, () => {
      const now = activeCount();
      expect(prev - now).toBeLessThanOrEqual(1);
      prev = now;
    });
    expect(activeCount()).toBe(1);
    expect(SECTORS.furniture).toBeDefined();
  });
});
