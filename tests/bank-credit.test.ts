// The bank's credit judgement (agents/credit.ts): a rule of thumb corrected by a small net that learns from
// the bank's own loans; what it expects to lose and what it actually loses; house loans judged on their
// share of the house's cost; the state survives save/load.
import { describe, expect, it } from 'vitest';
import { bankEndDay, houseMaxLtv, pdLimit, quoted, quoteRate } from '../src/sim/agents/bank';
import { creditFeatures, creditLgd, creditMonthEnd, creditPd, creditState, type CreditFacts, priorPd } from '../src/sim/agents/credit';
import { stepDay } from '../src/sim/engine';
import { CREDIT_LGD0, CREDIT_LGD_HOUSE0 } from '../src/sim/config';
import { newFirm, newLoan, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { N_GOODS } from '../src/sim/goods';
import { checkLedger, reconcileBank, writeOff } from '../src/sim/ledger';
import { deserialize, serialize } from '../src/sim/save';
import { createWorld } from '../src/sim/world/init';
import { FIRM_BASE, type MapData, type SimState } from '../src/sim/types';

function tinyMap(): MapData {
  const n = 16;
  const z = () => new Array(n).fill(0);
  return { w: 4, h: 4, terrain: new Array(n).fill(3), elev: z(), fert: z(), deposit: z(), river: z(), road: z(), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

const PRICES = [2.6, 3.0, 2.6, 2.6, 2.6, 3.2, 13, 20, 4, 2.8, 22];

function world(): SimState {
  const s = newSimState(3, tinyMap());
  s.towns.push(newTown(0, 'Kingsbridge', 'capital', 1, 1, 3));
  s.treasury = newTreasury(1);
  for (let g = 0; g < N_GOODS; g++) s.markets.push(newMarket(0, g, PRICES[g]));
  s.treasury.reserveRate = 0.02;
  s.treasury.lendRate = 0.05;
  return s;
}

function person(s: SimState, cash: number, income = 10) {
  const p = newPerson(s, 0, 'P' + s.ids.person);
  p.cash = cash;
  p.income = income;
  return p;
}

function firm(s: SimState, cash: number, profit: number) {
  const owner = person(s, 100);
  const f = newFirm(s, 'bakery', 0, -1, owner.id, 'Bakery ' + s.ids.firm);
  f.cash = cash;
  f.profit = profit;
  f.tools = 50;
  f.founded = -1000;
  owner.owns.push(f.id);
  return f;
}

function settle(s: SimState, reserves = 50_000): void {
  s.bank.reserves = reserves;
  reconcileBank(s);
  expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
}

const SOUND: CreditFacts = { person: false, young: false, purpose: 'invest', leverage: 0.3, ltv: 0, cover: 3, overdue: 0, distress: 0, margin: 0.1, unemp: 0.04, infl: 0.02 };

describe('credit: the rule of thumb', () => {
  it('rises with leverage, a thin cover, youth, distress and payments missed', () => {
    const base = priorPd(SOUND);
    expect(base).toBeGreaterThan(0);
    expect(base).toBeLessThan(0.05);
    expect(priorPd({ ...SOUND, leverage: 0.9 })).toBeGreaterThan(base);
    expect(priorPd({ ...SOUND, cover: 0.8 })).toBeGreaterThan(base);
    expect(priorPd({ ...SOUND, young: true })).toBeGreaterThan(base);
    expect(priorPd({ ...SOUND, distress: 0.8 })).toBeGreaterThan(base);
    expect(priorPd({ ...SOUND, overdue: 45 })).toBeGreaterThan(priorPd({ ...SOUND, overdue: 10 }));
  });

  it('a house being built is judged on the loan’s share of its cost', () => {
    const h = (ltv: number) => priorPd({ ...SOUND, person: true, purpose: 'house', leverage: 0.95, ltv });
    expect(h(0.6)).toBeLessThan(h(0.85));
    // a well-covered mortgage at 85 % of the house is not treated like an 85 %-levered firm
    expect(h(0.85)).toBeLessThan(priorPd({ ...SOUND, leverage: 0.85 }));
  });

  it('the stance lowers the most risk the bank takes and the most it lends against a house', () => {
    expect(pdLimit(1)).toBeLessThan(pdLimit(0));
    expect(houseMaxLtv(1)).toBeLessThan(houseMaxLtv(0));
    expect(houseMaxLtv(0.2)).toBeGreaterThan(0.85);
  });
});

describe('credit: the net', () => {
  it('starts close to the rule of thumb and does not touch the realm’s random stream', () => {
    const s = world();
    const rng = JSON.stringify(s.rng);
    const c = creditState(s);
    expect(JSON.stringify(s.rng)).toBe(rng);
    expect(c.seen).toBe(0);
    for (const f of [SOUND, { ...SOUND, young: true }, { ...SOUND, leverage: 0.8, cover: 1 }]) {
      const r = creditPd(s, f) / priorPd(f);
      expect(r).toBeGreaterThan(0.85);
      expect(r).toBeLessThan(1.15);
    }
    // the same seed gives the same starting weights
    expect(JSON.stringify(creditState(world()).net)).toBe(JSON.stringify(c.net));
  });

  it('learns from what its loans did: a kind of borrower that keeps defaulting is judged riskier, apart from the rest', () => {
    const s = world();
    const c = creditState(s);
    const young: CreditFacts = { ...SOUND, young: true };
    const old: CreditFacts = { ...SOUND };
    const pYoung0 = creditPd(s, young);
    let id = 1;
    let oldMid = 0;
    // a book like a realm's: three established firms' loans to each young one; young ones default 1 in 15 a month
    // (about 56 % a year, against the rule's 5 %), losing 80 % of what is owed; established ones never
    for (let m = 0; m < 60; m++) {
      c.watch = [];
      c.lost = [];
      for (let k = 0; k < 40; k++) {
        const f = k % 4 === 0 ? young : old;
        const loan = id++;
        c.watch.push({ loan, x: creditFeatures(f), prior: priorPd(f), principal: 100, house: false });
        if (f === young && (m * 10 + k / 4) % 15 === 0) c.lost.push({ loan, lost: 80 });
      }
      creditMonthEnd(s, () => null);
      if (m === 20) oldMid = creditPd(s, old);
    }
    expect(c.seen).toBe(60 * 40);
    expect(c.defaults).toBe(40);
    const pYoung = creditPd(s, young);
    expect(pYoung).toBeGreaterThan(5 * pYoung0);
    expect(pYoung).toBeGreaterThan(0.35);
    expect(pYoung).toBeLessThan(0.8);
    // established firms: far safer than young ones, and ever more so as their record grows
    const pOld = creditPd(s, old);
    expect(pOld).toBeLessThan(pYoung / 8);
    expect(pOld).toBeLessThan(oldMid);
    // the loss when a loan defaults is learned too (houses apart)
    expect(creditLgd(s, 'invest')).toBeGreaterThan(CREDIT_LGD0 + 0.2);
    expect(creditLgd(s, 'house')).toBeCloseTo(CREDIT_LGD_HOUSE0, 9);
    for (const w of [...c.net.v, ...c.net.P, ...c.net.w1, ...c.net.b1, ...c.net.w2, c.net.b2]) expect(Number.isFinite(w)).toBe(true);
  });

  it('borrowers the rule calls risky who keep paying are judged safer', () => {
    const s = world();
    const c = creditState(s);
    const risky: CreditFacts = { ...SOUND, person: true, purpose: 'startup', leverage: 0.9, cover: 0.9 };
    const p0 = creditPd(s, risky);
    let id = 1;
    for (let m = 0; m < 60; m++) {
      c.watch = [];
      c.lost = [];
      for (let k = 0; k < 40; k++) c.watch.push({ loan: id++, x: creditFeatures(risky), prior: priorPd(risky), principal: 100, house: false });
      creditMonthEnd(s, () => null);
    }
    // the rule expected about 34 defaults in these 2400 loan-months; there were none
    expect(creditPd(s, risky)).toBeLessThan(0.5 * p0);
    expect(c.defaults).toBe(0);
  });

  it('reckons what the book should lose a year from the loans it holds', () => {
    const s = world();
    person(s, 20_000);
    settle(s);
    const f = firm(s, 0, 5);
    newLoan(s, FIRM_BASE + f.id, 3000, 0.05, 0.03, 1440, 'invest');
    reconcileBank(s);
    creditMonthEnd(s, () => SOUND);
    const c = creditState(s);
    expect(c.watch.length).toBe(1);
    expect(c.expLoss).toBeCloseTo(creditPd(s, SOUND) * creditLgd(s, 'invest') * 3000, 6);
  });
});

describe('bank: wariness follows losses it did not expect', () => {
  function lossWorld(expected: number): SimState {
    const s = world();
    person(s, 20_000);
    settle(s);
    const f = firm(s, 0, 0);
    newLoan(s, FIRM_BASE + f.id, 3000, 0.03, 0.05, 360, 'invest');
    reconcileBank(s);
    creditState(s).expLoss = expected;
    writeOff(s, 3000);
    s.loans[0].active = false;
    s.loans[0].principal = 0;
    for (let d = 0; d < 20; d++) {
      s.day++;
      bankEndDay(s);
    }
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
    return s;
  }

  it('a loss it had not expected makes it wary (even when it wipes out the whole book)', () => {
    const s = lossWorld(0);
    expect(creditState(s).fear).toBeGreaterThan(0.2);
    expect(creditState(s).lossDaily).toBeGreaterThan(0);
  });

  it('a loss it expected — and charged for — does not', () => {
    const s = lossWorld(15_000); // a year's worth: about the 3000 lost in three months
    expect(creditState(s).fear).toBe(0);
    const t = lossWorld(0);
    expect(s.bank.stance).toBeLessThan(t.bank.stance);
  });

  it('wariness fades once losses are back to what was expected', () => {
    const s = lossWorld(0);
    const f0 = creditState(s).fear;
    for (let d = 0; d < 400; d++) {
      s.day++;
      bankEndDay(s);
    }
    expect(creditState(s).fear).toBeLessThan(f0 / 2);
  });
});

describe('bank: house loans are judged on the house', () => {
  it('lends up to its LTV limit against a house being built, not past it', () => {
    const s = world();
    person(s, 30_000);
    settle(s);
    const dev = person(s, 2_000, 12);
    s.bank.stance = 0.2;
    const cost = 10_000;
    const max = houseMaxLtv(0.2);
    expect(quoted(quoteRate(s, dev.id, (max - 0.05) * cost, 0, cost))).toBe(true);
    expect(quoted(quoteRate(s, dev.id, (max + 0.05) * cost, 0, cost))).toBe(false);
    // at the same share, a frightened bank does not
    s.bank.stance = 1;
    expect(quoted(quoteRate(s, dev.id, (max - 0.05) * cost, 0, cost))).toBe(false);
  });

  it('prices a long mortgage above a short loan when rates are expected to rise', () => {
    const s = world();
    person(s, 30_000);
    settle(s);
    const dev = person(s, 2_000, 12);
    s.bank.stance = 0.2;
    s.treasury.reserveRate = -0.05;
    s.day++;
    bankEndDay(s);
    // a house loan (twenty years) is priced mostly on where rates should settle, not on today's −5 %
    const r = quoteRate(s, dev.id, 0.7 * 10_000, 0, 10_000);
    expect(quoted(r)).toBe(true);
    expect(r).toBeGreaterThan(s.treasury.reserveRate + 0.03);
  });
});

describe('credit: save and load', () => {
  function grown(): SimState {
    const s = createWorld({ seed: 5 });
    s.settings.events = false;
    for (let d = 0; d < 62; d++) stepDay(s);
    return s;
  }

  it('the net, its watch list and the bank’s wariness survive a save', () => {
    const s = grown();
    const c = creditState(s);
    expect(c.watch.length).toBeGreaterThan(0);
    const t = deserialize(serialize(s));
    expect(JSON.stringify(t.bank.credit)).toBe(JSON.stringify(s.bank.credit));
    // and the loaded realm goes on exactly as the original
    for (let d = 0; d < 5; d++) {
      stepDay(s);
      stepDay(t);
    }
    expect(JSON.stringify(t.bank.credit)).toBe(JSON.stringify(s.bank.credit));
    expect(t.bank.stance).toBe(s.bank.stance);
  });

  it('a malformed credit record is dropped and rebuilt; an older save without the loss rate loads', () => {
    const s = grown();
    const raw = JSON.parse(serialize(s));
    raw.bank.credit.net.w1 = 'garbage';
    const t = deserialize(JSON.stringify(raw));
    expect(t.bank.credit).toBeUndefined();
    stepDay(t);
    expect(creditState(t).net.w1.length).toBeGreaterThan(0);
    const old = JSON.parse(serialize(s));
    delete old.bank.credit.lossDaily;
    const u = deserialize(JSON.stringify(old));
    expect(u.bank.credit?.lossDaily).toBe(0);
    expect(u.bank.credit?.net.w1).toEqual(s.bank.credit?.net.w1);
  });

  it('town and harbour fields survive a save', () => {
    const s = grown();
    expect(Array.isArray(s.foreign.pullIn)).toBe(true);
    expect(s.foreign.pullIn?.length).toBe(N_GOODS);
    for (const v of [...(s.foreign.pullIn ?? []), ...(s.foreign.pullOut ?? [])]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(v)).toBe(true);
    }
    const t = deserialize(serialize(s));
    expect(t.foreign.pullIn).toEqual(s.foreign.pullIn);
    expect(t.foreign.pullOut).toEqual(s.foreign.pullOut);
    for (let i = 0; i < s.towns.length; i++) {
      expect(t.towns[i].pull).toBe(s.towns[i].pull);
      expect(t.towns[i].housingWait).toBe(s.towns[i].housingWait);
    }
    const raw = JSON.parse(serialize(s));
    raw.foreign.pullIn = [1, 'x'];
    raw.towns[0].housingWait = -5;
    const u = deserialize(JSON.stringify(raw));
    expect(u.towns[0].housingWait === undefined || u.towns[0].housingWait >= 0).toBe(true);
    stepDay(u);
    expect(u.foreign.pullIn?.length).toBe(N_GOODS);
  });
});
