import { describe, expect, it } from 'vitest';
import { createPerson, deathHazard, demographyStep, emigrate, estateValue, killPerson } from '../src/sim/agents/demography';
import { hire } from '../src/sim/agents/labor';
import { checkLedger } from '../src/sim/ledger';
import { newLoan } from '../src/sim/factory';
import { G } from '../src/sim/goods';
import { FOREIGN, STATE } from '../src/sim/types';
import { addFirm, addHouse, addPerson, reconcile, tinyWorld } from './households.fixture';

describe('death and estates', () => {
  it('killPerson moves all money and assets to the heir; ledger stays balanced', () => {
    const s = tinyWorld();
    const dead = addPerson(s, 0, 500, { iou: 3, gold: 2 });
    const heir = addPerson(s, 0, 50);
    const f = addFirm(s, 'bakery', 0, 12, 10, 10, 2, dead.id);
    dead.owns.push(f.id);
    const house = addHouse(s, 0, 5, 5, 1.5, dead.id);
    dead.houses.push(house.id);
    const tenant = addPerson(s, 0, 80);
    house.residents.push(tenant.id, dead.id);
    tenant.home = dead.home = house.id;
    hire(s, f, dead);
    dead.pantry[G.bread] = 2;
    dead.pantry[G.furniture] = 7;
    const loan = newLoan(s, dead.id, 300, 0.02, 0.07, 720, 'house');
    s.bank.owner = dead.id;
    reconcile(s);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
    const heirCash = heir.cash;
    const checkHeir = (h: typeof heir) => {
      expect(h.iou).toBe(3);
      expect(h.gold).toBe(2);
      expect(h.pantry[G.bread]).toBe(2);
      expect(h.pantry[G.furniture]).toBe(7);
      expect(f.owner).toBe(h.id);
      expect(h.owns).toContain(f.id);
      expect(house.owner).toBe(h.id);
      expect(h.houses).toContain(house.id);
      expect(loan.borrower).toBe(h.id);
      expect(s.bank.owner).toBe(h.id);
      expect(s.stats.acc.deaths).toBe(1);
      expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
    };

    killPerson(s, dead, 'age');

    expect(dead.alive).toBe(false);
    expect(dead.cash).toBe(0);
    expect(dead.iou).toBe(0);
    expect(dead.gold).toBe(0);
    expect(dead.pantry.every((q) => q === 0)).toBe(true);
    expect(dead.owns).toEqual([]);
    expect(dead.houses).toEqual([]);
    expect(dead.job).toBe(-1);
    expect(dead.home).toBe(-1);
    expect(f.workers).not.toContain(dead.id);
    expect(house.residents).toEqual([tenant.id]);

    // The heir is a random living person in the same town: whoever got the IOUs got everything.
    const got = [heir, tenant].find((q) => q.iou === 3)!;
    expect(got).toBeDefined();
    const other = got === heir ? tenant : heir;
    expect(got.cash).toBeCloseTo((got === heir ? heirCash : 80) + 500, 9);
    expect(other.cash).toBe(got === heir ? 80 : heirCash);
    checkHeir(got);
  });

  it('with no heir the Treasury inherits; debts are written off', () => {
    const s = tinyWorld();
    const last = addPerson(s, 0, 200, { iou: 4, gold: 1 });
    const house = addHouse(s, 0, 5, 5, 1, last.id);
    last.houses.push(house.id);
    const loan = newLoan(s, last.id, 100, 0.02, 0.07, 720, 'house');
    s.treasury.iouOutstanding = 10;
    reconcile(s);
    const purse = s.treasury.purse;
    const equity = s.bank.equity;

    killPerson(s, last, 'hunger');

    expect(last.cash).toBe(0);
    expect(s.treasury.purse).toBeCloseTo(purse + 200, 9);
    expect(s.treasury.gold).toBe(1);
    expect(s.treasury.iouOutstanding).toBe(6);
    expect(house.owner).toBe(STATE);
    expect(loan.active).toBe(false);
    expect(s.bank.equity).toBeCloseTo(equity - 100, 9);
    expect(s.stats.acc.starved).toBe(1);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('emigrants take their cash abroad; other assets stay with an heir', () => {
    const s = tinyWorld();
    const leaver = addPerson(s, 0, 300, { gold: 5 });
    const heir = addPerson(s, 0, 10);
    const f = addFirm(s, 'farm', 0, 12, 10, 10, 2, leaver.id);
    leaver.owns.push(f.id);
    reconcile(s);
    emigrate(s, leaver);
    expect(leaver.alive).toBe(false);
    expect(leaver.cash).toBe(0);
    expect(s.foreign.coin).toBeCloseTo(300, 9);
    expect(heir.gold).toBe(5);
    expect(f.owner).toBe(heir.id);
    expect(s.stats.acc.emigrants).toBe(1);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('estate value counts cash, IOUs, gold and property', () => {
    const s = tinyWorld();
    s.iouMarket.ema = 90;
    s.goldMarket.ema = 110;
    const p = addPerson(s, 0, 100, { iou: 2, gold: 1 });
    const h = addHouse(s, 0, 5, 5, 1, p.id);
    h.cost = 1000;
    expect(estateValue(s, p)).toBeCloseTo(100 + 180 + 110 + 1000, 6);
  });
});

describe('population dynamics', () => {
  it('createPerson makes a living adult record with a fresh id', () => {
    const s = tinyWorld();
    const n = s.ids.person;
    const p = createPerson(s, 0, { age: 20 });
    expect(p.id).toBe(n);
    expect(s.people[p.id]).toBe(p);
    expect(p.alive).toBe(true);
    expect(p.age).toBe(20);
    expect(p.cash).toBe(0);
    expect(p.home).toBe(-1);
    expect(p.job).toBe(-1);
    const q = createPerson(s, 0);
    expect(q.age).toBeGreaterThanOrEqual(18);
    expect(q.skill).toBeGreaterThan(0.5);
  });

  it('mortality rises with age and starvation', () => {
    const s = tinyWorld();
    const young = addPerson(s, 0, 0, { age: 25, health: 0.9 });
    const old = addPerson(s, 0, 0, { age: 85, health: 0.9 });
    const starving = addPerson(s, 0, 0, { age: 25, health: 0.1 });
    expect(deathHazard(old)).toBeGreaterThan(5 * deathHazard(young));
    expect(deathHazard(starving)).toBeGreaterThan(10 * deathHazard(young));
  });

  it('years of demography keep the ledger balanced and records clean', () => {
    const s = tinyWorld(2);
    for (let i = 0; i < 12; i++) addHouse(s, i % 2, 4 + i, 4, 1, i < 6 ? -1 : 0);
    const f = addFirm(s, 'bakery', 0, 12, 10, 10, 40);
    f.capacity = 60;
    for (let i = 0; i < 60; i++) {
      const p = addPerson(s, i % 2, 100 + i, { age: 20 + i, health: i % 7 === 0 ? 0.15 : 0.9, contentment: i % 5 === 0 ? 0.2 : 0.7, foodSat: 1 });
      if (i < 30) hire(s, f, p);
      else p.unempDays = 100;
    }
    s.foreign.coin = 5000;
    reconcile(s);
    for (let d = 0; d < 720; d++) {
      demographyStep(s);
      s.day++;
    }
    const acc = s.stats.acc;
    expect((acc.deaths || 0) + (acc.emigrants || 0)).toBeGreaterThan(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
    for (const p of s.people) {
      if (p.alive) continue;
      expect(p.cash).toBe(0);
      expect(p.iou).toBe(0);
      expect(p.gold).toBe(0);
    }
    for (const fm of s.firms) for (const w of fm.workers) expect(s.people[w].alive).toBe(true);
    for (const b of s.buildings) for (const r of b.residents) expect(s.people[r].alive).toBe(true);
    // Firm owner refs never point at a departed person.
    for (const fm of s.firms) if (fm.owner >= 0) expect(s.people[fm.owner].alive).toBe(true);
    for (const b of s.buildings) if (b.owner >= 0) expect(s.people[b.owner].alive).toBe(true);
  });

  it('immigrants arrive when jobs outnumber job seekers, with coin from abroad', () => {
    const s = tinyWorld();
    for (let i = 0; i < 10; i++) addHouse(s, 0, 4 + i, 4, 1, -1);
    const f = addFirm(s, 'bakery', 0, 12, 10, 10, 30);
    f.capacity = 40;
    for (let i = 0; i < 20; i++) {
      const p = addPerson(s, 0, 200, { contentment: 0.8 });
      hire(s, f, p);
    }
    s.foreign.coin = 10000;
    reconcile(s);
    s.day = 4; // day-of-month 5 = immigration day
    const before = s.people.length;
    demographyStep(s);
    const arrived = s.stats.acc.immigrants || 0;
    expect(arrived).toBeGreaterThan(0);
    expect(s.people.length).toBeGreaterThanOrEqual(before + arrived);
    expect(s.foreign.coin).toBeLessThan(10000);
    const newcomers = s.people.slice(before).filter((p) => p.born === 4 && p.age >= 19 && p.age <= 40);
    expect(newcomers.length).toBeGreaterThan(0);
    expect(newcomers.some((p) => p.cash > 0 && p.home >= 0)).toBe(true);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
    expect(FOREIGN).toBe(-3);
  });
});
