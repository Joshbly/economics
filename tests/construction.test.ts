// Construction: project progress, materials, billing, completion, cancellation, financing.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/sim/world/layout', async () => {
  const factory = await import('../src/sim/factory');
  return {
    findSite: () => ({ x: 30, y: 20 }),
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

import { cancelProject, constructionPlan, constructionProgress, estimateCost, startProject } from '../src/sim/agents/construction';
import { settleFinancing } from '../src/sim/agents/entry';
import { createFirm, firmsEndDay, firmsPayWages } from '../src/sim/agents/firms';
import { BUILD_MARGIN, BUILDER_TOOLLESS_HANDS, LABOR_AHEAD_MAX } from '../src/sim/config';
import { newBuilding, newLoan, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { G, HOUSE_COST, HOUSE_SLOTS, N_GOODS, SECTORS } from '../src/sim/goods';
import { checkLedger, disburse, firmRef, reconcileBank } from '../src/sim/ledger';
import type { Firm, MapData, Person, Project, SimState } from '../src/sim/types';
import { STATE } from '../src/sim/types';

const PRICES = [2.67, 3.38, 2.69, 2.71, 2.26, 3.39, 13.6, 24.5, 4.08, 2.88, 23.4];

function tinyMap(w = 48, h = 32): MapData {
  const n = w * h;
  const z = () => new Array(n).fill(0);
  return { w, h, terrain: new Array(n).fill(3), elev: z(), fert: new Array(n).fill(0.5), deposit: new Array(n).fill(0.5), river: z(), road: z(), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

function world(): SimState {
  const s = newSimState(5, tinyMap());
  s.towns.push(newTown(0, 'Kingsbridge', 'capital', 10, 10, 5));
  for (let g = 0; g < N_GOODS; g++) s.markets[g] = newMarket(0, g, PRICES[g]);
  s.treasury = newTreasury(1);
  s.stats.baseWage = 10;
  s.bank.baseRate = 0.045;
  s.day = 400;
  return s;
}

function person(s: SimState, cash: number, opts: Partial<Person> = {}): Person {
  const p = newPerson(s, 0, 'P' + s.ids.person);
  p.cash = cash;
  p.health = 1;
  p.income = 10;
  Object.assign(p, opts);
  return p;
}

function builder(s: SimState, crew: number, cash = 5000): Firm {
  const b = newBuilding(s, 'firm', 'builder', 0, 14, 14, 1, 1, 'active');
  const f = createFirm(s, 'builder', 0, b.id, STATE);
  f.founded = s.day - 1000;
  f.wage = 10;
  f.cash = cash;
  f.tools = SECTORS.builder.toolsPerWorker * crew; // fully equipped crew
  for (let i = 0; i < crew; i++) {
    const p = person(s, 20);
    p.job = f.id;
    p.wage = 10;
    f.workers.push(p.id);
  }
  f.target = crew;
  return f;
}

function reconcile(s: SimState): void {
  s.bank.reserves = 1e6;
  reconcileBank(s);
}

function newDay(s: SimState): void {
  s.stats.acc = {};
  s.treasury.flows = {};
  for (const f of s.firms) {
    if (!f) continue;
    f.revenue = f.spent = f.wageBill = f.otherCosts = 0;
    f.producedToday = f.soldToday = 0;
  }
}

function day(s: SimState): void {
  newDay(s);
  constructionPlan(s);
  constructionProgress(s);
  firmsPayWages(s);
  firmsEndDay(s);
  s.day++;
}

describe('construction projects', () => {
  it('a house project progresses with labour and materials, bills the owner and completes', () => {
    const s = world();
    const b = builder(s, 20, 5000);
    b.tools = 30; // equipment with a wear buffer (builderOrders would normally buy more)
    b.inv[G.wood] = HOUSE_COST.wood;
    b.inv[G.iron] = HOUSE_COST.iron;
    b.inv[G.tools] = HOUSE_COST.tools;
    const owner = person(s, 60000);
    reconcile(s);
    const r = startProject(s, { kind: 'house', town: 0, owner: owner.id });
    expect(typeof r).not.toBe('string');
    const p = r as Project;
    expect(p.need.labor).toBe(HOUSE_COST.labor);
    expect(s.buildings[p.building].status).toBe('construction');
    const cash0 = owner.cash;

    day(s);
    expect(p.done.labor).toBeCloseTo(20, 6); // 20 fully equipped, healthy builders
    expect(p.done.wood).toBeCloseTo((HOUSE_COST.wood * 20) / HOUSE_COST.labor, 6); // materials keep pace
    // Billing: (labour at the crew's cost per labour-day + materials at price) × margin.
    const expected = (20 * 10 + p.done.wood * PRICES[G.wood] + p.done.iron * PRICES[G.iron] + p.done.tools * PRICES[G.tools]) * BUILD_MARGIN;
    expect(cash0 - owner.cash).toBeCloseTo(expected, 4);
    expect(p.billed).toBeCloseTo(expected, 4);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);

    let days = 1;
    while (p.status !== 'done' && days < 200) {
      day(s);
      days++;
    }
    expect(p.status).toBe('done');
    expect(days).toBeGreaterThan(60);
    expect(days).toBeLessThan(80);
    const h = s.buildings[p.building];
    expect(h.status).toBe('active');
    expect(h.slots).toBe(HOUSE_SLOTS);
    expect(h.rent).toBeGreaterThan(0);
    expect(h.owner).toBe(owner.id);
    expect(owner.houses).toContain(h.id);
    expect(h.cost).toBeCloseTo(p.billed, 6);
    expect(cash0 - owner.cash).toBeCloseTo(p.billed, 4);
    expect(b.inv[G.wood]).toBeCloseTo(0, 6);
    expect(b.build!.queue.length).toBe(0);
    expect(s.news.some((n) => n.text.includes('new homes'))).toBe(true);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('labour cannot run more than 10 % ahead of the scarcest material', () => {
    const s = world();
    const b = builder(s, 20);
    b.inv[G.wood] = HOUSE_COST.wood * 0.3; // only 30 % of the wood
    b.inv[G.iron] = HOUSE_COST.iron;
    b.inv[G.tools] = HOUSE_COST.tools;
    const owner = person(s, 60000);
    reconcile(s);
    const p = startProject(s, { kind: 'house', town: 0, owner: owner.id }) as Project;
    for (let d = 0; d < 60; d++) day(s);
    expect(p.done.labor / p.need.labor).toBeCloseTo(0.3 + LABOR_AHEAD_MAX, 6);
    expect(p.status).toBe('stalled');
    expect(p.stalledDays).toBeGreaterThan(0);
    // the builder plans a smaller crew while blocked
    expect(b.target).toBeLessThan(20);
  });

  it('a builder arms its crew from stock first and hires no more hands than it can equip', () => {
    const s = world();
    const b = builder(s, 20);
    b.tools = 0; // an unequipped crew …
    b.inv[G.wood] = HOUSE_COST.wood;
    b.inv[G.iron] = HOUSE_COST.iron;
    b.inv[G.tools] = 6; // … and a few tools in store
    const owner = person(s, 60000);
    reconcile(s);
    const p = startProject(s, { kind: 'house', town: 0, owner: owner.id }) as Project;
    day(s);
    // the crew took the tools the house does not need yet (it needs ~10 % of its tools per 10 % of work)
    expect(b.tools).toBeGreaterThan(4);
    expect(b.inv[G.tools]).toBeLessThan(2);
    expect(p.done.labor).toBeGreaterThan(0);
    // with tools for ~12 workers, the plan shrinks toward that (+ BUILDER_TOOLLESS_HANDS)
    for (let d = 0; d < 20; d++) constructionPlan(s);
    const equip = (b.tools + b.inv[G.tools]) / (0.95 * SECTORS.builder.toolsPerWorker);
    expect(b.target).toBeLessThan(equip + BUILDER_TOOLLESS_HANDS + 1);
    expect(b.target).toBeGreaterThan(1);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('an advance is billed first; the owner pays only beyond it', () => {
    const s = world();
    const b = builder(s, 10);
    b.inv[G.wood] = 100;
    b.inv[G.iron] = 10;
    b.inv[G.tools] = 5;
    const owner = person(s, 20000);
    reconcile(s);
    const p = startProject(s, { kind: 'house', town: 0, owner: owner.id }) as Project;
    p.prepaid = 1e6; // pretend the advance is huge (only its bookkeeping matters here)
    const c0 = owner.cash;
    const bc0 = b.cash;
    day(s);
    expect(owner.cash).toBe(c0);
    expect(p.billed).toBeGreaterThan(0);
    expect(p.prepaid).toBeCloseTo(1e6 - p.billed, 6);
    expect(b.revenue).toBeCloseTo(p.billed, 6); // billed revenue, though no money moved today
    expect(b.cash).toBeCloseTo(bc0 - 10 * 10, 6); // only wages left the builder
  });

  it('Treasury projects get Treasury labour for free and pay materials from the Purse', () => {
    const s = world();
    const b = builder(s, 0); // no builders' crew at all
    b.inv[G.wood] = 1000;
    b.inv[G.iron] = 1000;
    b.inv[G.tools] = 1000;
    s.treasury.purse = 1e5;
    const sw = createFirm(s, 'stateworks', 0, -1, STATE);
    sw.wage = 8;
    for (let i = 0; i < 10; i++) {
      const p = person(s, 0);
      p.job = sw.id;
      sw.workers.push(p.id);
    }
    reconcile(s);
    const tiles = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    for (const i of tiles) s.map.road[i] = 1; // paving an existing dirt track: ROAD_TILE_COST a tile
    const p = startProject(s, { kind: 'road', town: 0, owner: STATE, tiles }) as Project;
    expect(p.need.labor).toBe(300);
    const purse0 = s.treasury.purse;
    newDay(s);
    constructionProgress(s);
    expect(p.done.labor).toBeCloseTo(10 * 0.8, 6); // STATEWORKS_BUILD_EFF
    const mat = (p.done.wood * PRICES[G.wood] + p.done.iron * PRICES[G.iron] + p.done.tools * PRICES[G.tools]) * BUILD_MARGIN;
    expect(purse0 - s.treasury.purse).toBeCloseTo(mat, 6);
    expect(s.stats.acc.build_labor_state).toBeCloseTo(10, 6);
    let d = 0;
    while (p.status !== 'done' && d < 100) {
      newDay(s);
      constructionProgress(s);
      d++;
    }
    expect(p.status).toBe('done');
    for (const t of tiles) expect(s.map.road[t]).toBe(2);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('cancelling refunds the advance (paying down the loan) and removes the unfinished building', () => {
    const s = world();
    const b = builder(s, 5, 20000);
    const owner = person(s, 1000);
    reconcile(s);
    const p = startProject(s, { kind: 'firm', town: 0, owner: owner.id, sector: 'bakery' }) as Project;
    const ln = newLoan(s, owner.id, 8000, 0.03, 0.08, 1440, 'startup');
    disburse(s, owner.id, 8000);
    p.loan = ln.id;
    p.prepaid = 5000; // held by the builder
    reconcile(s);
    const bc0 = b.cash;
    expect(cancelProject(s, p.id)).toBe(true);
    expect(p.status).toBe('cancelled');
    expect(s.buildings[p.building].status).toBe('ruin');
    expect(b.cash).toBeCloseTo(bc0 - 5000, 6);
    expect(ln.principal).toBeCloseTo(3000, 6);
    expect(p.prepaid).toBe(0);
    expect(cancelProject(s, p.id)).toBe(false);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a financed workshop opens as a firm that owns the loan and gets the unspent advance', () => {
    const s = world();
    const b = builder(s, 30, 5000);
    b.tools = 30; // equipment with a wear buffer (no tools market in this test)
    const need = SECTORS.bakery.buildCost;
    b.inv[G.wood] = need.wood;
    b.inv[G.iron] = need.iron;
    b.inv[G.tools] = need.tools;
    const owner = person(s, 6000);
    reconcile(s);
    const p = startProject(s, { kind: 'firm', town: 0, owner: owner.id, sector: 'bakery' }) as Project;
    // The bank grants a start-up loan (as bankEndDay would) and the entry step advances the money.
    p.loanWanted = 15000;
    const ln = newLoan(s, owner.id, 15000, 0.03, 0.08, 1440, 'startup');
    disburse(s, owner.id, 15000);
    p.loan = ln.id;
    settleFinancing(s);
    expect(p.loanWanted).toBe(0);
    expect(p.prepaid).toBeGreaterThan(15000);
    let d = 0;
    while (p.status !== 'done' && d < 200) {
      day(s);
      d++;
    }
    expect(p.status).toBe('done');
    const bld = s.buildings[p.building];
    const f = s.firms[bld.firm];
    expect(f.alive).toBe(true);
    expect(f.sector).toBe('bakery');
    expect(f.owner).toBe(owner.id);
    expect(owner.owns).toContain(f.id);
    expect(ln.borrower).toBe(firmRef(f.id));
    expect(f.cash).toBeGreaterThan(0); // working capital from the unspent advance
    expect(bld.cost).toBeCloseTo(p.billed, 6);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a refused loan shelves the plan', () => {
    const s = world();
    builder(s, 5);
    const owner = person(s, 6000);
    reconcile(s);
    const p = startProject(s, { kind: 'house', town: 0, owner: owner.id }) as Project;
    p.loanWanted = 12000;
    s.day++; // next evening: the bank has answered (no loan, no pending request)
    settleFinancing(s);
    expect(p.status).toBe('cancelled');
    expect(s.news.some((n) => n.text.includes('shelved'))).toBe(true);
  });

  it('estimateCost prices labour at the builder wage and materials at market, with the margin', () => {
    const s = world();
    builder(s, 5);
    const c = estimateCost(s, 'house', 0);
    const direct = (HOUSE_COST.labor * 10) / 0.9 + HOUSE_COST.wood * PRICES[G.wood] + HOUSE_COST.iron * PRICES[G.iron] + HOUSE_COST.tools * PRICES[G.tools];
    expect(c).toBeCloseTo(direct * BUILD_MARGIN, 6);
  });
});
