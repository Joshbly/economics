// Firms: production, wages & wage levies, planning, orders, finance, bankruptcy.
// Builds tiny states with the record factories only (no world generation).
import { describe, expect, it, vi } from 'vitest';

// Isolate from the world layout module (site rules, tracks): a plain placement stub.
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
    },
    siteMultiplier: () => 1,
  };
});

import { closeFirm, createFirm, firmAssets, firmOrders, firmsEndDay, firmsPayWages, firmsPlan, firmsProduce, inventoryTarget, seasonalCarryDays } from '../src/sim/agents/firms';
import { potentialOutput } from '../src/sim/agents/production';
import { DISTRESS_BANKRUPT_DAYS, LIQUIDATION_DAYS, TOOLLESS, TOOLS_MAX_BID_MULT } from '../src/sim/config';
import { newBuilding, newLoan, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { G, N_GOODS, SECTORS } from '../src/sim/goods';
import { checkLedger, firmRef, reconcileBank } from '../src/sim/ledger';
import { openBooks } from '../src/sim/market/markets';
import type { Firm, Levy, MapData, Person, Sector, SimState } from '../src/sim/types';
import { STATE } from '../src/sim/types';

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------
const PRICES = [2.67, 3.38, 2.69, 2.71, 2.26, 3.39, 13.6, 24.5, 4.08, 2.88, 23.4];

function tinyMap(w = 48, h = 32): MapData {
  const n = w * h;
  const z = () => new Array(n).fill(0);
  return { w, h, terrain: new Array(n).fill(3), elev: z(), fert: new Array(n).fill(0.5), deposit: new Array(n).fill(0.5), river: z(), road: z(), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

function world(nTowns = 1): SimState {
  const s = newSimState(11, tinyMap());
  for (let t = 0; t < nTowns; t++) {
    s.towns.push(newTown(t, 'Town' + t, t === 0 ? 'capital' : 'farm', 10 + 14 * t, 10, 5));
    for (let g = 0; g < N_GOODS; g++) s.markets[t * N_GOODS + g] = newMarket(t, g, PRICES[g]);
  }
  s.treasury = newTreasury(nTowns);
  s.stats.baseWage = 10;
  s.bank.baseRate = 0.045;
  s.day = 400;
  return s;
}

function person(s: SimState, cash = 100, opts: Partial<Person> = {}): Person {
  const p = newPerson(s, 0, 'P' + s.ids.person);
  p.cash = cash; // endowment (tests only; reconcile afterwards)
  p.health = 1;
  p.income = 10;
  Object.assign(p, opts);
  return p;
}

function firm(s: SimState, sector: Sector, opts: { workers?: number; cash?: number; wage?: number; owner?: number; x?: number } = {}): Firm {
  const b = newBuilding(s, 'firm', sector, 0, opts.x ?? 12 + s.ids.building, 12, 1, 1, 'active');
  const f = createFirm(s, sector, 0, b.id, opts.owner ?? STATE);
  f.founded = s.day - 1000;
  f.wage = opts.wage ?? 10;
  f.cash = opts.cash ?? 5000;
  for (let i = 0; i < (opts.workers ?? 0); i++) {
    const p = person(s, 50);
    p.job = f.id;
    p.wage = f.wage;
    f.workers.push(p.id);
  }
  f.target = f.workers.length;
  return f;
}

function reconcile(s: SimState): void {
  s.bank.reserves = 1e6;
  reconcileBank(s);
}

/** What stats.beginDayStats does to firm scratch fields each morning. */
function newDay(s: SimState): void {
  s.stats.acc = {};
  s.treasury.flows = {};
  for (const f of s.firms) {
    if (!f) continue;
    f.revenue = f.spent = f.wageBill = f.otherCosts = 0;
    f.producedToday = f.soldToday = f.hired = f.fired = 0;
  }
  for (const l of s.policy.levies) l.today = 0;
}

function levy(s: SimState, l: Partial<Levy>): Levy {
  const full: Levy = {
    id: s.ids.policy++,
    label: 'test',
    enabled: true,
    dir: 1,
    base: 'wage',
    unit: 'pct',
    rate: 0,
    payer: 'worker',
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

// ---------------------------------------------------------------------------
// production
// ---------------------------------------------------------------------------
describe('production', () => {
  it('is capped by the scarcest input (Leontief) and consumes exactly the recipe', () => {
    const s = world();
    const f = firm(s, 'bakery', { workers: 5 });
    f.tools = 10;
    f.inv[G.grain] = 1000;
    f.inv[G.coal] = 3; // 0.2 coal per loaf → at most 15 loaves
    f.sales = 70;
    reconcile(s);
    firmsProduce(s);
    expect(f.producedToday).toBeCloseTo(15, 6);
    expect(f.inv[G.bread]).toBeCloseTo(15, 6);
    expect(f.inv[G.coal]).toBeCloseTo(0, 6);
    expect(f.inv[G.grain]).toBeCloseTo(1000 - 15, 6);
    expect(s.stats.acc['prod_' + G.bread]).toBeCloseTo(15, 6);
  });

  it('without tools output falls to TOOLLESS of full output; tools wear with use', () => {
    const s = world();
    const a = firm(s, 'lumber', { workers: 5 });
    const b = firm(s, 'lumber', { workers: 5 });
    a.tools = 0;
    b.tools = SECTORS.lumber.toolsPerWorker * 5; // fully equipped
    a.sales = b.sales = 25;
    reconcile(s);
    firmsProduce(s);
    const full = potentialOutput('lumber', 5, 5, 1, 1);
    expect(b.producedToday).toBeCloseTo(full, 6);
    expect(a.producedToday).toBeCloseTo(full * TOOLLESS, 6);
    expect(b.tools).toBeLessThan(5);
    expect(5 - b.tools).toBeCloseTo(SECTORS.lumber.toolUse * 5 + 0.0005 * 5, 6);
    expect(a.tools).toBe(0);
  });

  it('stops producing when output stock is far above what it sells', () => {
    const s = world();
    const f = firm(s, 'coalmine', { workers: 8 });
    f.tools = 20;
    f.sales = 1;
    f.inv[G.coal] = 1000; // > INV_MAX_DAYS × max(sales, 0.2·potential)
    reconcile(s);
    firmsProduce(s);
    expect(f.producedToday).toBe(0);
  });

  it('farms carry a seasonal stock: the target peaks after the harvest and is ~0 in spring', () => {
    const autumn = seasonalCarryDays(225);
    const spring = seasonalCarryDays(45);
    expect(autumn).toBeGreaterThan(50);
    expect(spring).toBeLessThan(2);
    expect(inventoryTarget('farm', 10, 225)).toBeGreaterThan(inventoryTarget('farm', 10, 45) * 5);
  });
});

// ---------------------------------------------------------------------------
// wages
// ---------------------------------------------------------------------------
describe('wages and wage levies', () => {
  it('pays gross wages; worker- and employer-side levies keep the ledger exact', () => {
    const s = world();
    const f = firm(s, 'bakery', { workers: 3, cash: 1000, wage: 10 });
    const lw = levy(s, { payer: 'worker', unit: 'pct', rate: 0.1 });
    const le = levy(s, { payer: 'employer', unit: 'perUnit', rate: 1 });
    reconcile(s);
    const purse0 = s.treasury.purse;
    const w0 = s.people[f.workers[0]].cash;
    firmsPayWages(s);
    const p = s.people[f.workers[0]];
    expect(p.cash - w0).toBeCloseTo(9, 9); // 10 gross − 10 %
    expect(p.earned).toBeCloseTo(9, 9);
    expect(f.cash).toBeCloseTo(1000 - 3 * 10 - 3 * 1, 9);
    expect(f.wageBill).toBeCloseTo(33, 9);
    expect(s.treasury.purse - purse0).toBeCloseTo(3 * 1 + 3 * 1, 9);
    expect(lw.today).toBeCloseTo(3, 9);
    expect(le.today).toBeCloseTo(3, 9);
    expect(s.stats.acc.wages).toBeCloseTo(30, 9);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a wage give from the Treasury adds to take-home pay', () => {
    const s = world();
    s.treasury.autoMint = true;
    const f = firm(s, 'brewery', { workers: 2, cash: 500, wage: 10 });
    levy(s, { payer: 'worker', unit: 'perUnit', rate: 2, dir: -1 });
    reconcile(s);
    firmsPayWages(s);
    const p = s.people[f.workers[0]];
    expect(p.earned).toBeCloseTo(12, 9);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a firm short of cash pays pro rata and falls into distress', () => {
    const s = world();
    const f = firm(s, 'bakery', { workers: 4, cash: 20, wage: 10 });
    reconcile(s);
    firmsPayWages(s);
    for (const pid of f.workers) expect(s.people[pid].earned).toBeCloseTo(5, 9);
    expect(f.cash).toBeCloseTo(0, 9);
    firmsEndDay(s);
    expect(f.distress).toBe(1);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('Treasury workers are paid from the Purse', () => {
    const s = world();
    s.treasury.purse = 100;
    const sw = createFirm(s, 'stateworks', 0, -1, STATE);
    sw.wage = 8;
    const p = person(s, 0);
    p.job = sw.id;
    sw.workers.push(p.id);
    reconcile(s);
    firmsPayWages(s);
    expect(p.cash).toBeCloseTo(8, 9);
    expect(s.treasury.purse).toBeCloseTo(92, 9);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('wages rise while vacancies stay open and respect a legal minimum', () => {
    const s = world();
    const f = firm(s, 'bakery', { workers: 2, wage: 10 });
    f.target = 5;
    f.vacancyDays = 10;
    f.sales = 30;
    f.pExp = 6; // very profitable → keeps wanting workers
    reconcile(s);
    firmsPlan(s);
    expect(f.wage).toBeGreaterThan(10);
    s.policy.limits.push({ id: 99, label: 'min', enabled: true, kind: 'wageMin', good: -1, town: -1, toTown: -1, value: 14, created: s.day, until: -1, binding: 0 });
    firmsPlan(s);
    expect(f.wage).toBeCloseTo(14, 9);
  });
});

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------
describe('workforce planning', () => {
  it('a firm with no demand shrinks its workforce target', () => {
    const s = world();
    const f = firm(s, 'bakery', { workers: 8 });
    f.capacity = 8;
    f.target = 8;
    f.sales = 0;
    f.output = 50;
    f.inv[G.bread] = 400;
    f.pExp = PRICES[G.bread];
    reconcile(s);
    for (let d = 0; d < 30; d++) {
      firmsPlan(s);
      s.day++;
    }
    expect(f.target).toBeLessThan(2);
  });

  it('a profitable firm with buyers keeps (or grows) its workforce', () => {
    const s = world();
    const f = firm(s, 'bakery', { workers: 5 });
    f.capacity = 8;
    f.target = 5;
    f.sales = 70;
    f.output = 70;
    f.inv[G.bread] = 50;
    f.pExp = PRICES[G.bread] * 1.05;
    reconcile(s);
    for (let d = 0; d < 20; d++) firmsPlan(s);
    expect(f.target).toBeGreaterThanOrEqual(5);
  });

  it('a price that no longer covers materials sends the target to zero', () => {
    const s = world();
    const f = firm(s, 'bakery', { workers: 5 });
    f.sales = 70;
    f.pExp = 2.0; // below grain + coal cost per loaf
    reconcile(s);
    for (let d = 0; d < 40; d++) firmsPlan(s);
    expect(f.target).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------
describe('orders', () => {
  it('perishable overstock is offered cheaply; durables hold stock back at a high ask', () => {
    const s = world();
    const bak = firm(s, 'bakery', { workers: 5 });
    bak.sales = 50;
    bak.output = 50;
    bak.pExp = 4;
    bak.inv[G.bread] = 300; // 6 days of sales, target 1.5
    const fur = firm(s, 'furniture', { workers: 5 });
    fur.sales = 4;
    fur.output = 4;
    fur.pExp = 23;
    fur.inv[G.furniture] = 28; // at target (7 days)
    reconcile(s);
    const books = openBooks(s);
    firmOrders(s, books);
    const bread = books.goods[G.bread].asks.filter((o) => o.ref === firmRef(bak.id));
    const cheap = bread.filter((o) => o.limit < 4 * 0.8).reduce((a, o) => a + o.qty, 0);
    expect(cheap).toBeGreaterThan(150); // the excess is priced to clear
    expect(bread.reduce((a, o) => a + o.qty, 0)).toBeCloseTo(300, 6);
    const furn = books.goods[G.furniture].asks.filter((o) => o.ref === firmRef(fur.id));
    const atOrBelow = furn.filter((o) => o.limit <= 23 * 1.0001).reduce((a, o) => a + o.qty, 0);
    expect(atOrBelow).toBeCloseTo(4, 1); // ≈ planned daily sales at or below pExp
    expect(Math.max(...furn.map((o) => o.limit))).toBeGreaterThan(23 * 1.4); // the rest waits
  });

  it('input and tool bids are capped by cash; a firm short of tools bids high', () => {
    const s = world();
    const f = firm(s, 'bakery', { workers: 5, cash: 10000 });
    f.target = 5;
    f.output = 70;
    f.sales = 70;
    f.pExp = 4.2;
    f.tools = 0;
    reconcile(s);
    const books = openBooks(s);
    firmOrders(s, books);
    const tools = books.goods[G.tools].bids.filter((o) => o.ref === firmRef(f.id));
    expect(tools.length).toBeGreaterThan(0);
    const top = Math.max(...tools.map((o) => o.limit));
    expect(top).toBeCloseTo(PRICES[G.tools] * TOOLS_MAX_BID_MULT, 1);
    const grain = books.goods[G.grain].bids.filter((o) => o.ref === firmRef(f.id));
    expect(grain.reduce((a, o) => a + o.qty, 0)).toBeGreaterThan(300);

    // Same firm, almost no cash: worst-case cost of all bids ≤ cash less a day's payroll.
    const s2 = world();
    const g = firm(s2, 'bakery', { workers: 5, cash: 200 });
    g.target = 5;
    g.output = 70;
    g.pExp = 4.2;
    reconcile(s2);
    const b2 = openBooks(s2);
    firmOrders(s2, b2);
    let worst = 0;
    for (const bk of b2.goods) for (const o of bk.bids) if (o.ref === firmRef(g.id)) worst += o.limit * o.qty;
    expect(worst).toBeLessThanOrEqual(200 - 5 * 10 + 1e-6);
  });
});

// ---------------------------------------------------------------------------
// finance & life cycle
// ---------------------------------------------------------------------------
describe('finance and bankruptcy', () => {
  it('month end: profit levy on the month and a dividend to the owner', () => {
    const s = world();
    const owner = person(s, 100);
    const f = firm(s, 'brewery', { workers: 0, cash: 50000, owner: owner.id });
    const pl = levy(s, { base: 'profit', payer: 'owner', unit: 'pct', rate: 0.2 });
    f.monthProfit = 1000;
    s.day = 29; // last day of a month
    reconcile(s);
    newDay(s);
    firmsEndDay(s);
    expect(pl.today).toBeCloseTo(200, 6);
    expect(owner.cash).toBeGreaterThan(100 + 1000);
    expect(owner.earned).toBeCloseTo(owner.cash - 100, 6);
    expect(f.monthProfit).toBe(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('bankruptcy lays off workers, sells off, then writes the unpaid loan off against bank equity', () => {
    const s = world();
    const owner = person(s, 100);
    const f = firm(s, 'bakery', { workers: 3, cash: 100, owner: owner.id });
    f.inv[G.grain] = 50;
    f.tools = 4;
    const ln = newLoan(s, firmRef(f.id), 1000, 0.02, 0.07, 720, 'invest');
    reconcile(s);
    const eq0 = s.bank.equity;
    f.distress = DISTRESS_BANKRUPT_DAYS;
    newDay(s);
    firmsEndDay(s);
    expect(f.status).toBe('liquidating');
    expect(f.workers.length).toBe(0);
    expect(f.inv[G.tools]).toBe(4); // tools put up for sale
    // fire sale orders
    const books = openBooks(s);
    firmOrders(s, books);
    expect(books.goods[G.grain].asks.some((o) => o.ref === firmRef(f.id))).toBe(true);
    for (let d = 0; d < LIQUIDATION_DAYS; d++) {
      newDay(s);
      firmsEndDay(s);
    }
    expect(f.status).toBe('closed');
    expect(f.alive).toBe(false);
    expect(ln.active).toBe(false);
    expect(s.bank.equity).toBeCloseTo(eq0 - 900, 6); // 100 recovered from the firm's cash
    expect(f.cash).toBeCloseTo(0, 9);
    expect(s.buildings[f.building].status).toBe('vacant');
    expect(owner.owns.includes(f.id)).toBe(false);
    expect(s.news.some((n) => n.text.includes('shut its doors'))).toBe(true);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a cash-starved firm asks the bank for working capital', () => {
    const s = world();
    const f = firm(s, 'bakery', { workers: 4, cash: 10 });
    f.output = 50;
    reconcile(s);
    newDay(s);
    firmsPayWages(s); // cannot pay in full
    firmsEndDay(s);
    const rq = s.bank.requests.filter((r) => r.borrower === firmRef(f.id));
    expect(rq.length).toBe(1);
    expect(rq[0].purpose).toBe('working');
    expect(rq[0].amount).toBeGreaterThan(100);
  });

  it('closeFirm refuses a firm that is already liquidating; firmAssets values stock', () => {
    const s = world();
    const f = firm(s, 'bakery', { workers: 0, cash: 100 });
    f.inv[G.bread] = 10;
    reconcile(s);
    expect(firmAssets(s, f)).toBeCloseTo(100 + 10 * PRICES[G.bread], 6);
    closeFirm(s, f, 'test');
    expect(f.status).toBe('liquidating');
    closeFirm(s, f, 'test');
    expect(f.status).toBe('liquidating');
  });

  it('a few hundred days of a closed loop keep numbers finite and the ledger exact', () => {
    const s = world();
    const f = firm(s, 'bakery', { workers: 5, cash: 3000 });
    f.tools = 3;
    f.inv[G.grain] = 200;
    f.inv[G.coal] = 40;
    reconcile(s);
    for (let d = 0; d < 200; d++) {
      newDay(s);
      firmsPlan(s);
      firmsProduce(s);
      firmsPayWages(s);
      const books = openBooks(s);
      firmOrders(s, books);
      firmsEndDay(s);
      s.day++;
    }
    for (const k of ['cash', 'tools', 'pExp', 'unitCost', 'profit', 'target', 'wage', 'sales', 'output'] as const) expect(Number.isFinite(f[k] as number)).toBe(true);
    for (const q of f.inv) expect(q).toBeGreaterThanOrEqual(0);
    expect(f.cash).toBeGreaterThanOrEqual(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });
});
