// Credit: pricing on the reserve interest the Purse can pay, landlords' mortgages, the warm-up top-up.
// Built from record factories only (no world generation).
import { describe, expect, it } from 'vitest';
import { bankBeginDay } from '../src/sim/agents/bank';
import { desiredHouseDebt } from '../src/sim/agents/housing';
import { BANK_BASE_SPREAD, CREDIT_RATE_REF, CREDIT_RATE_SCALE, HOUSE_DEBT_LTV, INIT_PURSE } from '../src/sim/config';
import { newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { N_GOODS } from '../src/sim/goods';
import { checkLedger, reconcileBank } from '../src/sim/ledger';
import { initStats, rebaseStats } from '../src/sim/stats/stats';
import type { MapData, SimState } from '../src/sim/types';

function tinyMap(): MapData {
  const n = 16;
  const z = () => new Array(n).fill(0);
  return { w: 4, h: 4, terrain: new Array(n).fill(3), elev: z(), fert: z(), deposit: z(), river: z(), road: z(), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

function world(): SimState {
  const s = newSimState(5, tinyMap());
  s.towns.push(newTown(0, 'Kingsbridge', 'capital', 1, 1, 3));
  s.treasury = newTreasury(1);
  for (let g = 0; g < N_GOODS; g++) s.markets.push(newMarket(0, g, 3));
  s.treasury.reserveRate = 0.04;
  s.treasury.lendRate = 0.06;
  const p = newPerson(s, 0, 'Saver');
  p.cash = 50_000;
  p.income = 10;
  s.bank.reserves = 50_000;
  reconcileBank(s);
  return s;
}

describe('reserve interest the Purse can pay', () => {
  it('prices deposits and loans on the full reserve rate while the Purse can pay it', () => {
    const s = world();
    s.treasury.autoMint = false;
    s.treasury.purse = 10_000;
    bankBeginDay(s);
    expect(s.bank.depositRate).toBeCloseTo(0.03, 6);
    expect(s.bank.baseRate).toBeCloseTo(0.04 + BANK_BASE_SPREAD, 6);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('with auto-mint off and an empty Purse, reserves earn nothing and the bank pays depositors nothing', () => {
    const s = world();
    s.treasury.autoMint = false;
    s.treasury.purse = 0;
    const eq = s.bank.equity;
    bankBeginDay(s);
    expect(s.bank.depositRate).toBeCloseTo(0, 9);
    expect(s.bank.baseRate).toBeCloseTo(BANK_BASE_SPREAD, 6);
    expect(s.bank.equity).toBeCloseTo(eq, 6); // no interest paid out that was never received
  });

  it('with auto-mint on the Purse always pays, so the full rate applies', () => {
    const s = world();
    s.treasury.autoMint = true;
    s.treasury.purse = 0;
    bankBeginDay(s);
    expect(s.bank.depositRate).toBeCloseTo(0.03, 6);
  });
});

describe('landlords’ mortgages', () => {
  const value = 20_000;
  const rent = 5; // ¤/day → 9 % yield
  it('carry HOUSE_DEBT_LTV of the value at the reference rate', () => {
    expect(desiredHouseDebt(value, rent, CREDIT_RATE_REF, 7200)).toBeCloseTo(HOUSE_DEBT_LTV * value, 6);
  });
  it('borrow more when money is cheaper and less when dearer; nothing when it is very dear or above the rent yield', () => {
    const cheap = desiredHouseDebt(value, rent, 0.02, 7200);
    const normal = desiredHouseDebt(value, rent, CREDIT_RATE_REF, 7200);
    const dear = desiredHouseDebt(value, rent, 0.12, 7200);
    expect(cheap).toBeGreaterThan(normal);
    expect(dear).toBeLessThan(normal);
    expect(desiredHouseDebt(value, rent, CREDIT_RATE_REF + CREDIT_RATE_SCALE, 7200)).toBe(0);
    expect(desiredHouseDebt(value, rent, 0.095, 7200)).toBe(0); // 9 % rent yield
    expect(desiredHouseDebt(value, 0, 0.02, 7200)).toBe(0);
  });
  it('keep debt service within a share of the rent', () => {
    const d = desiredHouseDebt(1e7, 1, 0.02, 7200); // a huge value, tiny rent: the service cap binds
    expect(d * (1 / 7200 + 0.02 / 360)).toBeLessThanOrEqual(1);
  });
});

describe('end of the warm-up', () => {
  it('tops the Purse back up to INIT_PURSE and starts the Treasury books clean', () => {
    const s = world();
    initStats(s);
    s.treasury.purse = 1234;
    s.treasury.minted = 999;
    s.treasury.burned = 5;
    s.treasury.flows = { interest: -40 };
    s.treasury.flowsMonth = { interest: -400 };
    s.treasury.flowsLastMonth = { interest: -1200 };
    s.treasury.givesSuspended = true;
    rebaseStats(s);
    expect(s.treasury.purse).toBeCloseTo(INIT_PURSE, 6);
    expect(s.treasury.minted).toBe(0);
    expect(s.treasury.burned).toBe(0);
    expect(s.treasury.flows).toEqual({});
    expect(s.treasury.flowsMonth).toEqual({});
    expect(s.treasury.flowsLastMonth).toEqual({});
    expect(s.treasury.givesSuspended).toBe(false);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });
  it('leaves a fuller Purse as it is', () => {
    const s = world();
    initStats(s);
    s.treasury.purse = INIT_PURSE + 500;
    rebaseStats(s);
    expect(s.treasury.purse).toBeCloseTo(INIT_PURSE + 500, 6);
  });
});
