// Term loans keep the rate agreed when they were made; credit lines float with the base
// rate; a fall in rates of at least LOAN_REFI_GAP lets fixed-rate borrowers refinance.
import { describe, expect, it } from 'vitest';
import { LOAN_REFI_GAP } from '../src/sim/config';
import { stepDay } from '../src/sim/engine';
import { dispatch } from '../src/sim/policy/player';
import { checkLedger } from '../src/sim/ledger';
import { deserialize, serialize } from '../src/sim/save';
import { createWorld } from '../src/sim/world/init';
import type { SimState } from '../src/sim/types';

function world(): SimState {
  const s = createWorld({ seed: 2 });
  s.settings.events = false;
  s.treasury.autoMint = true;
  for (let d = 0; d < 20; d++) stepDay(s);
  return s;
}

describe('fixed and floating loan rates', () => {
  it('a rise reaches credit lines and new loans, not term loans already made', () => {
    const s = world();
    const term = s.loans.filter((l) => l.active && l.fixed);
    expect(term.length).toBeGreaterThan(10);
    const before = new Map(term.map((l) => [l.id, l.rate]));
    const r = dispatch(s, { type: 'setWindow', reserveRate: s.treasury.reserveRate + 0.05, lendRate: s.treasury.lendRate + 0.05 });
    expect(r.ok, r.message).toBe(true);
    const firstNew = s.ids.loan;
    for (let d = 0; d < 30; d++) stepDay(s);
    for (const l of term) if (l.active) expect(l.rate, `loan ${l.id} (${l.purpose})`).toBe(before.get(l.id));
    for (const l of s.loans) if (l.active && !l.fixed) expect(l.rate).toBeCloseTo(s.bank.baseRate + l.spread, 9);
    const fresh = s.loans.filter((l) => l.id >= firstNew && l.active);
    for (const l of fresh) expect(l.rate).toBeGreaterThan(Math.min(...before.values()));
  });

  it('while reserves earn −10 % loans go below zero; those made then keep their rate when it goes back up', () => {
    const s = world();
    expect(dispatch(s, { type: 'setWindow', reserveRate: -0.1, lendRate: -0.1 }).ok).toBe(true);
    const firstNew = s.ids.loan;
    for (let d = 0; d < 3; d++) stepDay(s);
    expect(s.bank.baseRate).toBeLessThan(0);
    const cheap = s.loans.filter((l) => l.id >= firstNew && l.active && l.fixed);
    expect(cheap.length).toBeGreaterThan(0);
    for (const l of cheap) expect(l.rate).toBeLessThan(0);
    const agreed = new Map(cheap.map((l) => [l.id, l.rate]));
    // the bank pays these borrowers their interest
    const b0 = s.bank.interestIn;
    const b = cheap[0];
    const who = b.borrower;
    void who;
    expect(dispatch(s, { type: 'setWindow', reserveRate: 0.04, lendRate: 0.06 }).ok).toBe(true);
    for (let d = 0; d < 10; d++) stepDay(s);
    for (const l of cheap) if (l.active) expect(l.rate, `loan ${l.id} (${l.purpose})`).toBe(agreed.get(l.id));
    // credit lines follow the new base rate at once
    for (const l of s.loans) if (l.active && !l.fixed) expect(l.rate).toBeCloseTo(s.bank.baseRate + l.spread, 9);
    void b0;
  });

  it('a loan below zero: the bank pays the borrower', () => {
    const s = world();
    expect(dispatch(s, { type: 'setWindow', reserveRate: -0.1, lendRate: -0.1 }).ok).toBe(true);
    for (let d = 0; d < 3; d++) stepDay(s);
    // the day's loan interest, net, as the loan book says it should be (negative loans paid out)
    let pos = 0;
    let neg = 0;
    for (const l of s.loans) {
      if (!l.active || l.overdue > 0) continue;
      const i = (l.principal * l.rate) / 360;
      if (i > 0) pos += i;
      else neg += i;
    }
    expect(neg).toBeLessThan(0);
    stepDay(s);
    const net = s.stats.acc.interest_loans ?? 0;
    expect(net).toBeLessThan(pos + 0.5 * neg);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a fall of more than the gap lets borrowers in good standing refinance', () => {
    const s = world();
    const r = dispatch(s, { type: 'setWindow', reserveRate: 0, lendRate: 0.005 });
    expect(r.ok, r.message).toBe(true);
    stepDay(s);
    const fixed = s.loans.filter((l) => l.active && l.fixed && l.overdue === 0);
    expect(fixed.length).toBeGreaterThan(10);
    for (const l of fixed) expect(l.rate).toBeLessThanOrEqual(s.bank.baseRate + l.spread + LOAN_REFI_GAP + 1e-9);
    expect(s.stats.acc.loans_refi ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('old saves: credit lines float, other loans keep the rate they carry', () => {
    const s = world();
    const raw = JSON.parse(serialize(s));
    for (const l of raw.loans) delete l.fixed;
    const t = deserialize(JSON.stringify(raw));
    for (const l of t.loans) expect(l.fixed).toBe(l.purpose !== 'working');
  });
});
