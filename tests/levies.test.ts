import { describe, expect, it } from 'vitest';
import { newFirm, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger, mint, reconcileBank } from '../src/sim/ledger';
import {
  chargeLevy,
  inGroup,
  levyAmount,
  levyMonthRollover,
  matchLevies,
  portDuty,
  saleWedge,
  stockLevies,
  wageLevyRates,
} from '../src/sim/policy/levies';
import { capitalMin, maxLoanRate, noteBinding, priceBounds, quota, rentBounds, reserveRatio, wageBounds } from '../src/sim/policy/limits';
import { FIRM_BASE, STATE, type Levy, type Limit, type MapData, type SimState } from '../src/sim/types';

function tinyMap(): MapData {
  const n = 4;
  return {
    w: 2,
    h: 2,
    terrain: new Array(n).fill(3),
    elev: new Array(n).fill(0.5),
    fert: new Array(n).fill(0.5),
    deposit: new Array(n).fill(0),
    river: new Array(n).fill(0),
    road: new Array(n).fill(0),
    occ: new Array(n).fill(-1),
    district: new Array(n).fill(0),
  };
}

function tinyState(): SimState {
  const s = newSimState(1, tinyMap());
  s.towns.push(newTown(0, 'Millbrook', 'farm', 0, 0, 3));
  s.towns.push(newTown(1, 'Saltmere', 'harbor', 1, 1, 3));
  s.treasury = newTreasury(2);
  for (let t = 0; t < 2; t++) for (let g = 0; g < N_GOODS; g++) s.markets.push(newMarket(t, g, 2));
  return s;
}

let nextId = 1;
function levy(s: SimState, l: Partial<Levy>): Levy {
  const full: Levy = {
    id: nextId++,
    label: 'test',
    enabled: true,
    dir: 1,
    base: 'sale',
    unit: 'pct',
    rate: 0.1,
    payer: 'buyer',
    threshold: 0,
    good: -1,
    town: -1,
    toTown: -1,
    sector: 'any',
    group: 'all',
    buildingKind: 'any',
    created: 0,
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

function limit(s: SimState, l: Partial<Limit>): Limit {
  const full: Limit = { id: nextId++, label: 't', enabled: true, kind: 'priceMax', good: -1, town: -1, toTown: -1, value: 1, created: 0, until: -1, binding: 0, ...l };
  s.policy.limits.push(full);
  return full;
}

describe('chargeLevy', () => {
  it('takes from the payer into the Purse and books the rule', () => {
    const s = tinyState();
    const p = newPerson(s, 0, 'Worker');
    p.cash = 50;
    p.job = 0;
    reconcileBank(s);
    const l = levy(s, { base: 'wage', payer: 'worker', rate: 0.1 });
    const net = chargeLevy(s, 'wage', p.id, 'worker', { town: 0, sector: 'farm', person: p }, 10, 1);
    expect(net).toBeCloseTo(1);
    expect(p.cash).toBeCloseTo(49);
    expect(s.treasury.purse).toBeCloseTo(1);
    expect(l.today).toBeCloseTo(1);
    expect(l.month).toBeCloseTo(1);
    expect(l.total).toBeCloseTo(1);
    expect(s.stats.acc.levy_take).toBeCloseTo(1);
    expect(s.stats.acc.levyb_wage).toBeCloseTo(1);
    // the employer role is not charged by a worker rule
    expect(chargeLevy(s, 'wage', FIRM_BASE, 'employer', { town: 0, sector: 'farm', person: p }, 10, 1)).toBe(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-9);
  });

  it('gives from the Purse, signed negative, and skips gives while suspended', () => {
    const s = tinyState();
    const p = newPerson(s, 0, 'Saver');
    reconcileBank(s);
    mint(s, 10);
    const l = levy(s, { base: 'interest', payer: 'receiver', dir: -1, rate: 0.5 });
    expect(chargeLevy(s, 'interest', p.id, 'receiver', { town: 0, person: p }, 4, 0)).toBeCloseTo(-2);
    expect(p.cash).toBeCloseTo(2);
    expect(s.treasury.purse).toBeCloseTo(8);
    expect(l.today).toBeCloseTo(-2);
    expect(s.stats.acc.levy_give).toBeCloseTo(2);
    s.treasury.givesSuspended = true;
    expect(chargeLevy(s, 'interest', p.id, 'receiver', { town: 0, person: p }, 4, 0)).toBe(0);
    expect(levyAmount(s, 'interest', 'receiver', { town: 0, person: p }, 4, 0)).toBe(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-9);
  });

  it('applies thresholds: pct on the part above, per-unit and flat only above', () => {
    const s = tinyState();
    const p = newPerson(s, 0, 'Tenant');
    p.cash = 100;
    reconcileBank(s);
    levy(s, { base: 'rent', payer: 'tenant', unit: 'pct', rate: 0.5, threshold: 1.5 });
    expect(levyAmount(s, 'rent', 'tenant', { town: 0, person: p }, 2, 1)).toBeCloseTo(0.25);
    expect(levyAmount(s, 'rent', 'tenant', { town: 0, person: p }, 1, 1)).toBe(0);
    s.policy.levies.length = 0;
    levy(s, { base: 'rent', payer: 'tenant', unit: 'perUnit', rate: 0.3, threshold: 1.5 });
    expect(levyAmount(s, 'rent', 'tenant', { town: 0, person: p }, 2, 1)).toBeCloseTo(0.3);
    expect(levyAmount(s, 'rent', 'tenant', { town: 0, person: p }, 1.4, 1)).toBe(0);
    // landlord role not charged by a tenant rule
    expect(levyAmount(s, 'rent', 'landlord', { town: 0 }, 2, 1)).toBe(0);
  });

  it('filters by town, sector, good and group', () => {
    const s = tinyState();
    const emp = newPerson(s, 0, 'A');
    emp.job = 3;
    const unemp = newPerson(s, 0, 'B');
    const hungry = newPerson(s, 1, 'C');
    hungry.foodSat = 0.3;
    hungry.owns = [1];
    expect(inGroup(s, emp, 'employed')).toBe(true);
    expect(inGroup(s, unemp, 'unemployed')).toBe(true);
    expect(inGroup(s, hungry, 'hungry')).toBe(true);
    expect(inGroup(s, hungry, 'owners')).toBe(true);
    expect(inGroup(s, unemp, 'nonowners')).toBe(true);
    expect(inGroup(s, unemp, 'homeless')).toBe(true);
    expect(inGroup(s, emp, 'firms')).toBe(false);
    levy(s, { base: 'wage', payer: 'worker', town: 0, sector: 'farm', group: 'employed' });
    expect(matchLevies(s, 'wage', 'worker', { town: 0, sector: 'farm', person: emp }).length).toBe(1);
    expect(matchLevies(s, 'wage', 'worker', { town: 1, sector: 'farm', person: emp }).length).toBe(0);
    expect(matchLevies(s, 'wage', 'worker', { town: 0, sector: 'bakery', person: emp }).length).toBe(0);
    expect(matchLevies(s, 'wage', 'worker', { town: 0, sector: 'farm', person: unemp }).length).toBe(0);
    levy(s, { base: 'shipment', payer: 'owner', unit: 'perUnit', good: G.grain, town: 0, toTown: 1 });
    expect(matchLevies(s, 'shipment', 'owner', { town: 0, toTown: 1, good: G.grain }).length).toBe(1);
    expect(matchLevies(s, 'shipment', 'owner', { town: 0, toTown: 1, good: G.coal }).length).toBe(0);
    expect(matchLevies(s, 'shipment', 'owner', { town: 1, toTown: 0, good: G.grain }).length).toBe(0);
    // non-person flows match only 'all' / 'firms'
    levy(s, { base: 'profit', payer: 'owner', group: 'firms' });
    expect(matchLevies(s, 'profit', 'owner', { town: 0, sector: 'farm' }).length).toBe(1);
  });

  it('ignores disabled and expired rules', () => {
    const s = tinyState();
    s.day = 10;
    levy(s, { base: 'wage', payer: 'worker', enabled: false });
    levy(s, { base: 'wage', payer: 'worker', until: 9 });
    const live = levy(s, { base: 'wage', payer: 'worker', until: 10 });
    const m = matchLevies(s, 'wage', 'worker', { town: 0 });
    expect(m).toEqual([live]);
  });
});

describe('sale wedge, wage rates and port duties', () => {
  it('combines signed rules into one wedge per market', () => {
    const s = tinyState();
    levy(s, { base: 'sale', payer: 'buyer', rate: 0.1, good: G.bread });
    levy(s, { base: 'sale', payer: 'buyer', rate: 0.05, dir: -1 });
    levy(s, { base: 'sale', payer: 'seller', unit: 'perUnit', rate: 0.5, town: 0 });
    const w = saleWedge(s, 0, G.bread);
    expect(w.bPct).toBeCloseTo(0.05);
    expect(w.sUnit).toBeCloseTo(0.5);
    const w2 = saleWedge(s, 1, G.fish);
    expect(w2.bPct).toBeCloseTo(-0.05);
    expect(w2.sUnit).toBe(0);
    s.treasury.givesSuspended = true;
    expect(saleWedge(s, 1, G.fish).bPct).toBe(0);
    // extreme rates are clamped so orders still convert
    levy(s, { base: 'sale', payer: 'seller', rate: 5 });
    expect(saleWedge(s, 0, G.bread).sPct).toBeLessThanOrEqual(0.95);
  });

  it('reports wage levy rates for planning, evaluating thresholds at the wage', () => {
    const s = tinyState();
    levy(s, { base: 'wage', payer: 'worker', rate: 0.2, threshold: 5 });
    levy(s, { base: 'wage', payer: 'employer', unit: 'perUnit', rate: 1, dir: -1, sector: 'farm' });
    const r = wageLevyRates(s, 0, 'farm', 10);
    expect(r.workerPct).toBeCloseTo(0.1); // 20 % of the part above 5, at a wage of 10
    expect(r.employerUnit).toBeCloseTo(-1);
    expect(wageLevyRates(s, 0, 'bakery', 10).employerUnit).toBe(0);
  });

  it('port duty sums import / export rules for a good', () => {
    const s = tinyState();
    levy(s, { base: 'import', payer: 'buyer', rate: 0.3, good: G.iron });
    levy(s, { base: 'import', payer: 'buyer', unit: 'perUnit', rate: 0.4 });
    levy(s, { base: 'export', payer: 'seller', rate: 0.1, dir: -1, good: G.grain });
    expect(portDuty(s, 'import', G.iron)).toEqual({ pct: 0.3, unit: 0.4 });
    expect(portDuty(s, 'import', G.coal)).toEqual({ pct: 0, unit: 0.4 });
    expect(portDuty(s, 'export', G.grain).pct).toBeCloseTo(-0.1);
  });
});

describe('stockLevies', () => {
  it('money levy: annual rate on balances above the threshold, charged daily', () => {
    const s = tinyState();
    const p = newPerson(s, 0, 'Rich');
    p.cash = 1100;
    const q = newPerson(s, 0, 'Poor');
    q.cash = 50;
    const o = newPerson(s, 0, 'Owner');
    const f = newFirm(s, 'farm', 0, -1, o.id, 'Farm');
    f.cash = 460;
    reconcileBank(s);
    const lp = levy(s, { base: 'money', payer: 'holder', rate: 0.36, threshold: 100, group: 'persons' });
    const lf = levy(s, { base: 'money', payer: 'holder', rate: 0.36, threshold: 100, group: 'firms' });
    stockLevies(s);
    expect(p.cash).toBeCloseTo(1099); // 0.36/360 × 1000
    expect(p.earned).toBeCloseTo(-1);
    expect(q.cash).toBeCloseTo(50);
    expect(f.cash).toBeCloseTo(459.64);
    expect(f.otherCosts).toBeCloseTo(0.36);
    expect(lp.today).toBeCloseTo(1);
    expect(lf.today).toBeCloseTo(0.36);
    expect(s.treasury.purse).toBeCloseTo(1.36);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-9);
  });

  it('head levy: a daily payment to every member of a group counts as income', () => {
    const s = tinyState();
    const a = newPerson(s, 0, 'Jobless');
    const b = newPerson(s, 0, 'Worker');
    b.job = 1;
    const c = newPerson(s, 1, 'Elsewhere');
    reconcileBank(s);
    mint(s, 100);
    const l = levy(s, { base: 'head', payer: 'receiver', unit: 'flat', rate: 2, dir: -1, group: 'unemployed', town: 0 });
    stockLevies(s);
    expect(a.cash).toBeCloseTo(2);
    expect(a.earned).toBeCloseTo(2);
    expect(b.cash).toBe(0);
    expect(c.cash).toBe(0);
    expect(l.today).toBeCloseTo(-2);
    expect(s.treasury.purse).toBeCloseTo(98);
    s.treasury.givesSuspended = true;
    stockLevies(s);
    expect(a.cash).toBeCloseTo(2);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-9);
  });

  it('goods levy charges inventories per unit beyond the allowance; building levy charges the occupant', () => {
    const s = tinyState();
    const o = newPerson(s, 0, 'Owner');
    o.cash = 100;
    o.pantry[G.bread] = 7;
    const f = newFirm(s, 'bakery', 0, -1, o.id, 'Bakery');
    f.cash = 100;
    f.inv[G.bread] = 30;
    reconcileBank(s);
    const lg = levy(s, { base: 'goods', payer: 'holder', unit: 'perUnit', rate: 0.1, good: G.bread, threshold: 5 });
    stockLevies(s);
    expect(o.cash).toBeCloseTo(99.8); // (7 − 5) × 0.1
    expect(f.cash).toBeCloseTo(97.5); // (30 − 5) × 0.1
    expect(lg.today).toBeCloseTo(2.7);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-9);
  });
});

describe('month rollover', () => {
  it('rolls levy months, Treasury flows and limit binding counters', () => {
    const s = tinyState();
    const l = levy(s, { month: 12, total: 30 });
    const lim = limit(s, { binding: 4 });
    s.treasury.flowsMonth = { levy: 12 };
    levyMonthRollover(s);
    expect(l.lastMonth).toBe(12);
    expect(l.month).toBe(0);
    expect(l.total).toBe(30);
    expect(s.treasury.flowsLastMonth).toEqual({ levy: 12 });
    expect(s.treasury.flowsMonth).toEqual({});
    expect(lim.binding).toBe(0);
  });
});

describe('limits', () => {
  it('the tightest matching limit wins', () => {
    const s = tinyState();
    limit(s, { kind: 'priceMax', good: G.bread, value: 3 });
    limit(s, { kind: 'priceMax', good: G.bread, town: 0, value: 2.5 });
    limit(s, { kind: 'priceMin', good: G.bread, value: 1 });
    limit(s, { kind: 'priceMin', good: G.bread, value: 1.2, enabled: false });
    expect(priceBounds(s, 0, G.bread)).toEqual({ max: 2.5, min: 1 });
    expect(priceBounds(s, 1, G.bread)).toEqual({ max: 3, min: 1 });
    expect(priceBounds(s, 1, G.fish)).toEqual({ max: -1, min: -1 });
    limit(s, { kind: 'wageMin', value: 8 });
    limit(s, { kind: 'wageMin', town: 1, value: 11 });
    expect(wageBounds(s, 1)).toEqual({ min: 11, max: -1 });
    expect(wageBounds(s, 0)).toEqual({ min: 8, max: -1 });
    limit(s, { kind: 'rentMax', town: 0, value: 1.5 });
    expect(rentBounds(s, 0).max).toBe(1.5);
    expect(rentBounds(s, 1).max).toBe(-1);
    limit(s, { kind: 'rateMax', value: 0.09 });
    limit(s, { kind: 'rateMax', value: 0.07 });
    expect(maxLoanRate(s)).toBeCloseTo(0.07);
    limit(s, { kind: 'reserveMin', value: 0.1 });
    limit(s, { kind: 'capitalMin', value: 0.12 });
    expect(reserveRatio(s)).toBeCloseTo(0.1);
    expect(capitalMin(s)).toBeCloseTo(0.12);
    limit(s, { kind: 'importMax', good: G.iron, value: 0 });
    limit(s, { kind: 'shipMax', good: -1, town: 0, toTown: 1, value: 40 });
    expect(quota(s, 'importMax', G.iron, -1, -1)).toBe(0);
    expect(quota(s, 'importMax', G.coal, -1, -1)).toBe(-1);
    expect(quota(s, 'shipMax', G.grain, 0, 1)).toBe(40);
    expect(quota(s, 'shipMax', G.grain, 1, 0)).toBe(-1);
  });

  it('noteBinding counts each limit at most once a day', () => {
    const s = tinyState();
    const a = limit(s, { kind: 'priceMax', good: G.bread, value: 3 });
    const b = limit(s, { kind: 'priceMax', good: G.bread, value: 2 });
    noteBinding(s, 'priceMax', G.bread, 0);
    noteBinding(s, 'priceMax', G.bread, 0);
    expect(b.binding).toBe(1);
    expect(a.binding).toBe(0);
    s.day += 1;
    noteBinding(s, 'priceMax', G.bread, 0);
    expect(b.binding).toBe(2);
  });
});

describe('robustness', () => {
  it('never produces NaN from odd inputs', () => {
    const s = tinyState();
    const p = newPerson(s, 0, 'X');
    reconcileBank(s);
    levy(s, { base: 'wage', payer: 'worker', rate: 0.1 });
    expect(chargeLevy(s, 'wage', p.id, 'worker', { town: 0, person: p }, Number.NaN, 1)).toBe(0);
    expect(chargeLevy(s, 'wage', STATE, 'worker', { town: 0 }, 10, 1)).toBe(0);
    expect(Number.isFinite(p.cash)).toBe(true);
  });
});
