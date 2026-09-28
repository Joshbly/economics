// Bank: interest, coupons, window, loan lifecycle, default, rationing, failure & bail-in.
// Built from record factories only (no world generation).
import { describe, expect, it } from 'vitest';
import { bankBeginDay, bankEndDay, bankOrders, capitalRatio, debtOf, lastLoanDecisions, loansOf, quoteRate, requestLoan } from '../src/sim/agents/bank';
import { DISTRESS_BANKRUPT_DAYS, IOU_COUPON, LOAN_DEFAULT_OVERDUE_DAYS } from '../src/sim/config';
import { newFirm, newLoan, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger, deposits, disburse, mint, pay, reconcileBank, writeOff } from '../src/sim/ledger';
import { bookFor, openBooks } from '../src/sim/market/markets';
import { BANK, FIRM_BASE, STATE, type Levy, type Limit, type MapData, type SimState } from '../src/sim/types';

const BANNED = /tax|subsid|bailout|bail-out|stimulus|QE|quantitative|tariff|UBI|minimum wage/i;

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

function firm(s: SimState, cash: number, profit: number, tools = 50) {
  const owner = person(s, 100);
  const f = newFirm(s, 'bakery', 0, -1, owner.id, 'Bakery ' + s.ids.firm);
  f.cash = cash;
  f.profit = profit;
  f.tools = tools;
  f.founded = -1000; // an established firm with a profit history
  owner.owns.push(f.id);
  return f;
}

/** Endow the bank and make the balance sheet identity hold exactly. */
function settle(s: SimState, reserves = 50_000): void {
  s.bank.reserves = reserves;
  reconcileBank(s);
  expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
}

let nextId = 900;
function levy(over: Partial<Levy>): Levy {
  return {
    id: nextId++,
    label: 'test',
    enabled: true,
    dir: 1,
    base: 'interest',
    unit: 'pct',
    rate: 0.2,
    payer: 'receiver',
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
    ...over,
  };
}

function limit(over: Partial<Limit>): Limit {
  return { id: 800, label: 'test', enabled: true, kind: 'rateMax', good: -1, town: -1, toTown: -1, value: 0, created: 0, until: -1, binding: 0, ...over };
}

describe('bank: daily interest flows keep the balance sheet exact', () => {
  it('pays deposit interest, reserve interest and window interest through the ledger', () => {
    const s = world();
    const a = person(s, 3600);
    const f = firm(s, 7200, 5);
    s.foreign.coin = 1800;
    settle(s, 20_000);
    s.bank.windowDebt = 1000; // pre-existing window debt (booked as liability via reconcile below)
    s.bank.reserves += 1000;
    reconcileBank(s);
    mint(s, 10_000);
    const purse0 = s.treasury.purse;
    const eq0 = s.bank.equity;

    bankBeginDay(s);
    // deposit rate = reserve rate − 1 % = 1 %
    expect(s.bank.depositRate).toBeCloseTo(0.01, 10);
    expect(a.cash).toBeCloseTo(3600 * (1 + 0.01 / 360), 8);
    expect(a.earned).toBeCloseTo(3600 * 0.01 / 360, 8);
    expect(f.cash).toBeCloseTo(7200 * (1 + 0.01 / 360), 8);
    expect(s.foreign.coin).toBeCloseTo(1800 * (1 + 0.01 / 360), 8);
    // the Treasury paid reserve interest and received window interest
    expect(s.treasury.purse).toBeLessThan(purse0);
    expect(s.bank.interestIn).toBeGreaterThan(0);
    expect(s.bank.interestOut).toBeGreaterThan(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
    // equity moved by exactly interest in − out
    expect(s.bank.equity - eq0).toBeCloseTo(s.bank.interestIn - s.bank.interestOut, 8);
  });

  it('negative reserve rate: depositors pay the bank', () => {
    const s = world();
    s.treasury.reserveRate = -0.02;
    const a = person(s, 3600);
    settle(s);
    mint(s, 1000);
    bankBeginDay(s);
    expect(s.bank.depositRate).toBeCloseTo(-0.02, 10); // max(min(0, rr), rr − 1 %)
    expect(a.cash).toBeLessThan(3600);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('pays IOU coupons to the bank and to holders, with interest levies on people’s coupons', () => {
    const s = world();
    const a = person(s, 0);
    a.iou = 36; // 36 × 5/360 = 0.5 ¤ per day
    s.bank.iou = 72;
    s.bank.iouBook = 7200;
    s.treasury.iouOutstanding = 108;
    s.treasury.reserveRate = 0; // isolate coupons
    s.treasury.lendRate = 0;
    settle(s);
    mint(s, 1000);
    s.policy.levies.push(levy({ rate: 0.2 }));
    const purse0 = s.treasury.purse;
    const eq0 = s.bank.equity;
    bankBeginDay(s);
    const personCoupon = (36 * IOU_COUPON) / 360;
    const bankCoupon = (72 * IOU_COUPON) / 360;
    expect(a.cash).toBeCloseTo(personCoupon * 0.8, 10);
    expect(a.earned).toBeCloseTo(personCoupon * 0.8, 10);
    expect(s.bank.equity - eq0).toBeCloseTo(bankCoupon, 10);
    expect(purse0 - s.treasury.purse).toBeCloseTo(personCoupon * 0.8 + bankCoupon, 10);
    expect(s.stats.acc.coupons).toBeCloseTo(personCoupon + bankCoupon, 10);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('coupons are paid pro rata when the Purse runs short (auto-mint off)', () => {
    const s = world();
    const a = person(s, 0);
    a.iou = 72;
    s.treasury.iouOutstanding = 72;
    s.treasury.reserveRate = 0;
    s.treasury.lendRate = 0;
    settle(s);
    mint(s, 0.5); // coupon due is 1.0
    bankBeginDay(s);
    expect(a.cash).toBeCloseTo(0.5, 8);
    expect(s.treasury.purse).toBeCloseTo(0, 8);
    expect(s.news.some((n) => n.kind === 'crisis' && !BANNED.test(n.text))).toBe(true);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('borrows at the window when reserves fall below a legal requirement, and the window rate becomes the funding cost', () => {
    const s = world();
    person(s, 100_000);
    settle(s, 1000); // reserves 1 % of deposits
    s.policy.limits.push(limit({ kind: 'reserveMin', value: 0.1 }));
    mint(s, 1e5);
    bankBeginDay(s);
    const dep = deposits(s);
    expect(s.bank.windowDebt).toBeGreaterThan(0);
    expect(s.bank.reserves).toBeGreaterThanOrEqual(0.1 * dep - 1e-6);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
    bankBeginDay(s); // next morning: reprices with window debt outstanding
    expect(s.bank.baseRate).toBeCloseTo(0.05 + 0.025, 6);
    // excess later → repays
    s.policy.limits.length = 0;
    bankEndDay(s);
    expect(s.bank.windowDebt).toBeLessThan(50);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });
});

describe('bank: loan lifecycle', () => {
  it('approves a sound working-capital loan (money creation), collects interest & amortisation, repays in full', () => {
    const s = world();
    const f = firm(s, 400, 30);
    person(s, 20_000);
    settle(s);
    mint(s, 1e5);
    const ref = FIRM_BASE + f.id;
    expect(quoteRate(s, ref, 300)).toBeGreaterThan(0);
    const m0 = deposits(s);
    requestLoan(s, { borrower: ref, amount: 300, term: 30, purpose: 'working', project: -1 });
    requestLoan(s, { borrower: ref, amount: 300, term: 30, purpose: 'working', project: -1 }); // duplicate merges
    bankEndDay(s);
    expect(s.bank.approved).toBe(1);
    expect(loansOf(s, ref).length).toBe(1);
    expect(debtOf(s, ref)).toBeCloseTo(300, 8);
    expect(f.cash).toBeCloseTo(700, 8);
    expect(deposits(s) - m0).toBeCloseTo(300, 8); // lending creates deposits
    const dec = lastLoanDecisions(s);
    expect(dec.day).toBe(s.day);
    expect(dec.items[0].amount).toBeCloseTo(300, 8);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);

    for (let d = 0; d < 40; d++) {
      s.day++;
      bankBeginDay(s);
      bankEndDay(s);
      expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
    }
    expect(debtOf(s, ref)).toBe(0);
    expect(s.loans.length).toBe(0); // pruned
    expect(s.stats.acc.interest_loans).toBeGreaterThan(0);
    expect(s.stats.acc.loans_repaid).toBeCloseTo(300, 6);
  });

  it('refuses a firm that is losing money, and rations under a rate ceiling', () => {
    const s = world();
    const bad = firm(s, 50, -20);
    const good = firm(s, 400, 30);
    settle(s);
    requestLoan(s, { borrower: FIRM_BASE + bad.id, amount: 300, term: 180, purpose: 'working', project: -1 });
    bankEndDay(s);
    expect(s.bank.rejected).toBe(1);
    expect(debtOf(s, FIRM_BASE + bad.id)).toBe(0);
    expect(lastLoanDecisions(s).items[0].reason).toBe('coverage');

    // A legal ceiling below the bank's risk-adjusted rate: credit is refused, not cheapened.
    s.policy.limits.push(limit({ kind: 'rateMax', value: 0.01 }));
    s.bank.rejected = 0;
    expect(quoteRate(s, FIRM_BASE + good.id, 300)).toBe(-1);
    requestLoan(s, { borrower: FIRM_BASE + good.id, amount: 300, term: 180, purpose: 'working', project: -1 });
    bankEndDay(s);
    expect(s.bank.rejected).toBe(1);
    expect(lastLoanDecisions(s).items[0].reason).toBe('ratecap');
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a loan that is never serviced defaults: the deposit is seized, the rest written off against equity', () => {
    const s = world();
    const f = firm(s, 0, 5);
    person(s, 20_000);
    s.treasury.reserveRate = 0;
    s.treasury.lendRate = 0;
    const ln = newLoan(s, FIRM_BASE + f.id, 1000, 0.03, 0.05, 360, 'invest');
    settle(s);
    const eq0 = s.bank.equity;
    for (let d = 0; d <= LOAN_DEFAULT_OVERDUE_DAYS; d++) {
      s.day++;
      bankBeginDay(s);
      expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
    }
    expect(ln.active).toBe(false);
    expect(s.bank.writeoffs).toBeGreaterThan(900);
    expect(s.bank.equity).toBeLessThan(eq0 - 900);
    expect(f.distress).toBeGreaterThanOrEqual(DISTRESS_BANKRUPT_DAYS);
    expect(s.stats.acc.defaults).toBeGreaterThan(900);
    bankEndDay(s);
    expect(s.loans.length).toBe(0);
    expect(s.bank.defaultEma).toBeGreaterThan(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('stance tightens after losses', () => {
    const s = world();
    person(s, 20_000);
    settle(s);
    const st0 = s.bank.stance;
    const f = firm(s, 0, 0);
    newLoan(s, FIRM_BASE + f.id, 3000, 0.03, 0.05, 360, 'invest');
    reconcileBank(s);
    writeOff(s, 3000);
    s.loans[0].active = false;
    s.loans[0].principal = 0;
    for (let d = 0; d < 5; d++) {
      s.day++;
      bankEndDay(s);
    }
    expect(s.bank.stance).toBeGreaterThan(st0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });
});

/** A loan that is lent out, spent (to `sink`) and lost: equity falls by `amount`, the identity holds. */
function badLoss(s: SimState, amount: number, sinkId: number): void {
  const g = firm(s, 0, 0);
  s.people[g.owner].cash = 0; // (test endowment only; keeps the identity exact)
  const ref = FIRM_BASE + g.id;
  const ln = newLoan(s, ref, amount, 0.03, 0.05, 360, 'invest');
  disburse(s, ref, amount);
  pay(s, ref, sinkId, amount, 'misc');
  writeOff(s, amount);
  ln.principal = 0;
  ln.active = false;
  expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
}

describe('bank: failure and bail-in', () => {
  it('negative equity stops lending; after the grace period deposits are cut to restore its minimum capital', () => {
    const s = world();
    const a = person(s, 10_000);
    const f = firm(s, 5_000, 30);
    s.treasury.reserveRate = 0;
    s.treasury.lendRate = 0;
    const big = newLoan(s, FIRM_BASE + f.id, 5_000, 0.03, 0.05, 3600, 'invest');
    settle(s, 20_000);
    badLoss(s, s.bank.equity + 3_000, a.id); // a large loss wipes out the bank's equity
    expect(s.bank.equity).toBeCloseTo(-3_000, 6);
    bankEndDay(s);
    expect(s.bank.failed).toBe(true);
    expect(s.news[s.news.length - 1].kind).toBe('crisis');
    requestLoan(s, { borrower: FIRM_BASE + f.id, amount: 100, term: 180, purpose: 'working', project: -1 });
    bankEndDay(s);
    expect(loansOf(s, FIRM_BASE + f.id).length).toBe(1); // no new loan
    expect(lastLoanDecisions(s).items[0].reason).toBe('failed');
    expect(quoteRate(s, FIRM_BASE + f.id, 100)).toBe(-1);

    const cash0 = a.cash;
    const dep0 = deposits(s);
    for (let d = 0; d < 40 && s.bank.failed; d++) {
      s.day++;
      bankEndDay(s);
      expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
    }
    expect(s.bank.failed).toBe(false);
    // every balance cut by the same fraction
    const frac = 1 - deposits(s) / dep0;
    expect(frac).toBeGreaterThan(0);
    expect(a.cash).toBeCloseTo(cash0 * (1 - frac), 6);
    expect(s.bank.equity).toBeGreaterThan(0);
    expect(capitalRatio(s)).toBeCloseTo(0.08 + 0.03 + 0.02, 6); // minimum + stance buffer + BANK_BAILIN_TARGET
    expect(big.active).toBe(true);
    const texts = s.news.map((n) => n.text).join('\n');
    expect(texts).not.toMatch(BANNED);
  });

  it('recovers without cutting deposits when the Treasury pays into its capital', () => {
    const s = world();
    const a = person(s, 10_000);
    settle(s, 12_000); // equity 2 000
    badLoss(s, 2_500, a.id);
    bankEndDay(s);
    expect(s.bank.failed).toBe(true);
    mint(s, 5000);
    // policy/player's 'transfer' to the bank: pay(STATE → BANK, 'recap') raises reserves and equity
    pay(s, STATE, BANK, 1000, 'recap');
    const dep0 = deposits(s);
    bankEndDay(s);
    expect(s.bank.failed).toBe(false);
    expect(deposits(s)).toBeCloseTo(dep0, 8);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });
});

describe('bank: IOU portfolio', () => {
  it('bids for IOUs with excess reserves when their yield beats the reserve rate', () => {
    const s = world();
    person(s, 10_000);
    settle(s, 20_000);
    s.iouMarket.ema = 100; // 5 % yield vs 2 % reserve rate
    const books = openBooks(s);
    bankOrders(s, books);
    const bids = bookFor(books, -1, 100).bids.filter((o) => o.ref === BANK);
    expect(bids.length).toBe(1);
    expect(bids[0].limit).toBeLessThanOrEqual(102 + 1e-9);
    // yield below the hurdle → no bid
    s.iouMarket.ema = 400;
    const books2 = openBooks(s);
    bankOrders(s, books2);
    expect(bookFor(books2, -1, 100).bids.filter((o) => o.ref === BANK).length).toBe(0);
  });
});

void G;
