import { describe, expect, it } from 'vitest';
import { newFirm, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger, reconcileBank } from '../src/sim/ledger';
import { openBooks } from '../src/sim/market/markets';
import { dispatch, executeTransfer, playerAfterClear, playerOrders, policyBeginDay } from '../src/sim/policy/player';
import { STATE, type Levy, type MapData, type PlayerAction, type SimState } from '../src/sim/types';

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

type LevyIn = Extract<PlayerAction, { type: 'addLevy' }>['levy'];
const baseLevy: LevyIn = { label: '', enabled: true, dir: 1, base: 'sale', unit: 'pct', rate: 0.1, payer: 'buyer', threshold: 0, good: G.bread, town: 0, toTown: -1, sector: 'any', group: 'all', buildingKind: 'any', until: -1 };

const FORBIDDEN = /\b(tax|taxes|subsid\w*|tariff\w*|quota\w*|stimulus|bailout|minimum wage|UBI|QE|quantitative)\b/i;

describe('dispatch — validation and neutral wording', () => {
  it('mints and burns', () => {
    const s = tinyState();
    expect(dispatch(s, { type: 'mint', amount: -5 }).ok).toBe(false);
    expect(dispatch(s, { type: 'mint', amount: Number.NaN }).ok).toBe(false);
    expect(dispatch(s, { type: 'mint', amount: 500 }).ok).toBe(true);
    expect(s.treasury.purse).toBe(500);
    expect(s.treasury.minted).toBe(500);
    const b = dispatch(s, { type: 'burn', amount: 800 });
    expect(b.ok).toBe(true);
    expect(s.treasury.purse).toBe(0);
    expect(dispatch(s, { type: 'burn', amount: 1 }).ok).toBe(false);
    expect(s.news.some((n) => n.kind === 'policy')).toBe(true);
  });

  it('validates levies and describes them without policy names', () => {
    const s = tinyState();
    expect(dispatch(s, { type: 'addLevy', levy: { ...baseLevy, rate: -0.1 } }).ok).toBe(false);
    expect(dispatch(s, { type: 'addLevy', levy: { ...baseLevy, rate: Number.POSITIVE_INFINITY } }).ok).toBe(false);
    expect(dispatch(s, { type: 'addLevy', levy: { ...baseLevy, base: 'nonsense' as never } }).ok).toBe(false);
    expect(dispatch(s, { type: 'addLevy', levy: { ...baseLevy, payer: 'worker' } }).ok).toBe(false);
    expect(dispatch(s, { type: 'addLevy', levy: { ...baseLevy, good: 99 } }).ok).toBe(false);
    expect(dispatch(s, { type: 'addLevy', levy: { ...baseLevy, town: 7 } }).ok).toBe(false);
    expect(dispatch(s, { type: 'addLevy', levy: { ...baseLevy, dir: 0 as never } }).ok).toBe(false);
    expect(dispatch(s, { type: 'addLevy', levy: { ...baseLevy, base: 'profit', unit: 'flat', payer: 'owner' } }).ok).toBe(false);

    const bases: LevyIn[] = [
      baseLevy,
      { ...baseLevy, base: 'wage', payer: 'employer', unit: 'perUnit', rate: 1, dir: -1, good: -1 },
      { ...baseLevy, base: 'profit', payer: 'owner', good: -1 },
      { ...baseLevy, base: 'money', payer: 'holder', threshold: 500, good: -1 },
      { ...baseLevy, base: 'goods', payer: 'holder', unit: 'perUnit', rate: 0.05 },
      { ...baseLevy, base: 'head', payer: 'receiver', unit: 'flat', rate: 2, dir: -1, group: 'unemployed', good: -1 },
      { ...baseLevy, base: 'rent', payer: 'landlord', good: -1 },
      { ...baseLevy, base: 'interest', payer: 'receiver', good: -1 },
      { ...baseLevy, base: 'shipment', payer: 'owner', unit: 'perUnit', rate: 0.2, toTown: 1 },
      { ...baseLevy, base: 'import', payer: 'buyer', good: G.iron },
      { ...baseLevy, base: 'export', payer: 'seller', dir: -1, good: G.grain },
      { ...baseLevy, base: 'building', payer: 'owner', unit: 'flat', rate: 1, buildingKind: 'house', good: -1 },
      { ...baseLevy, base: 'estate', payer: 'receiver', rate: 0.3, threshold: 1000, good: -1 },
    ];
    for (const l of bases) {
      const r = dispatch(s, { type: 'addLevy', levy: l });
      expect(r.ok, r.message).toBe(true);
      expect(r.message).not.toMatch(FORBIDDEN);
    }
    expect(s.policy.levies.length).toBe(bases.length);
    // irrelevant filters are normalised
    const imp = s.policy.levies.find((l) => l.base === 'import')!;
    expect(imp.town).toBe(-1);
    const sale = s.policy.levies[0];
    expect(sale.group).toBe('all');
    for (const n of s.news) expect(n.text).not.toMatch(FORBIDDEN);
    for (const l of s.policy.levies) expect(l.label).not.toMatch(FORBIDDEN);
  });

  it('updates, suspends and removes levies', () => {
    const s = tinyState();
    const id = dispatch(s, { type: 'addLevy', levy: baseLevy }).id!;
    expect(dispatch(s, { type: 'updateLevy', id, patch: { rate: 0.3 } }).ok).toBe(true);
    const l = s.policy.levies[0] as Levy;
    expect(l.rate).toBe(0.3);
    expect(dispatch(s, { type: 'updateLevy', id, patch: { rate: -1 } }).ok).toBe(false);
    expect(l.rate).toBe(0.3);
    expect(dispatch(s, { type: 'updateLevy', id, patch: { enabled: false } }).ok).toBe(true);
    expect(l.enabled).toBe(false);
    expect(dispatch(s, { type: 'removeLevy', id }).ok).toBe(true);
    expect(s.policy.levies.length).toBe(0);
    expect(dispatch(s, { type: 'removeLevy', id }).ok).toBe(false);
  });

  it('validates limits and the window', () => {
    const s = tinyState();
    const lim = (limit: object) => dispatch(s, { type: 'addLimit', limit: { label: '', enabled: true, good: -1, town: -1, toTown: -1, until: -1, ...limit } as never });
    expect(lim({ kind: 'priceMax', value: 2 }).ok).toBe(false); // needs a good
    expect(lim({ kind: 'priceMax', good: G.bread, value: -1 }).ok).toBe(false);
    expect(lim({ kind: 'rateMax', value: 3 }).ok).toBe(false);
    expect(lim({ kind: 'reserveMin', value: 1.5 }).ok).toBe(false);
    for (const l of [
      { kind: 'priceMax', good: G.bread, town: 0, value: 1.5 },
      { kind: 'priceMin', good: G.grain, value: 1 },
      { kind: 'wageMin', town: 1, value: 12 },
      { kind: 'rentMax', value: 1 },
      { kind: 'rateMax', value: 0.08 },
      { kind: 'importMax', good: G.iron, value: 0 },
      { kind: 'exportMax', good: G.grain, value: 10 },
      { kind: 'shipMax', good: G.grain, town: 0, toTown: 1, value: 0 },
      { kind: 'reserveMin', value: 0.1 },
      { kind: 'capitalMin', value: 0.12 },
    ]) {
      const r = lim(l);
      expect(r.ok, r.message).toBe(true);
      expect(r.message).not.toMatch(FORBIDDEN);
    }
    expect(dispatch(s, { type: 'setWindow', reserveRate: 0.04, lendRate: 0.02 }).ok).toBe(true);
    expect(s.treasury.lendRate).toBeCloseTo(0.04);
    expect(dispatch(s, { type: 'setWindow', reserveRate: 5, lendRate: 6 }).ok).toBe(false);
    expect(dispatch(s, { type: 'setWindow', reserveRate: 0.01, lendRate: Number.NaN }).ok).toBe(false);
  });

  it('validates orders', () => {
    const s = tinyState();
    const good = { kind: 'good' as const, town: 0, good: G.tools };
    expect(dispatch(s, { type: 'placeOrder', market: good, side: 'buy', price: 0, qty: 5 }).ok).toBe(false);
    expect(dispatch(s, { type: 'placeOrder', market: good, side: 'buy', price: 5, qty: -5 }).ok).toBe(false);
    expect(dispatch(s, { type: 'placeOrder', market: { kind: 'good', town: 9, good: 1 }, side: 'buy', price: 5, qty: 5 }).ok).toBe(false);
    expect(dispatch(s, { type: 'placeOrder', market: { kind: 'labor', town: 0 }, side: 'sell', price: 5, qty: 5 }).ok).toBe(false);
    const r = dispatch(s, { type: 'placeOrder', market: good, side: 'sell', price: 0, qty: 5, days: 3 });
    expect(r.ok).toBe(true);
    expect(s.policy.orders[0].until).toBe(s.day + 2);
    expect(dispatch(s, { type: 'updateOrder', id: r.id!, patch: { qty: 0 } }).ok).toBe(false);
    expect(dispatch(s, { type: 'updateOrder', id: r.id!, patch: { qty: 9, price: 2 } }).ok).toBe(true);
    expect(s.policy.orders[0].qty).toBe(9);
    expect(dispatch(s, { type: 'cancelOrder', id: r.id! }).ok).toBe(true);
    expect(s.policy.orders.length).toBe(0);
    expect(dispatch(s, { type: 'nope' } as never).ok).toBe(false);
    expect(dispatch(s, null as never).ok).toBe(false);
  });
});

describe('daily hooks', () => {
  it('expires rules, suspends gives when the Purse is empty, drives the Treasury workforce', () => {
    const s = tinyState();
    const sw = newFirm(s, 'stateworks', 0, -1, STATE, 'Treasury Works');
    dispatch(s, { type: 'addLevy', levy: { ...baseLevy, until: s.day + 1 } });
    dispatch(s, { type: 'placeOrder', market: { kind: 'labor', town: 0 }, side: 'buy', price: 11, qty: 3 });
    dispatch(s, { type: 'placeOrder', market: { kind: 'labor', town: 0 }, side: 'buy', price: 12, qty: 2 });
    policyBeginDay(s);
    expect(s.treasury.givesSuspended).toBe(true);
    expect(sw.target).toBe(0); // payments on hold: the crew is not kept on unpaid (fixes-A)
    s.treasury.autoMint = true;
    policyBeginDay(s);
    expect(sw.target).toBe(5);
    expect(sw.wage).toBe(12);
    s.treasury.autoMint = false;
    s.day += 2;
    policyBeginDay(s);
    expect(s.policy.levies.length).toBe(0);
    expect(s.news.some((n) => /lapsed/.test(n.text))).toBe(true);
    // workers present → labour orders record their fill in order
    sw.workers = [1, 2, 3, 4];
    const books = openBooks(s);
    playerOrders(s, books);
    playerAfterClear(s, books);
    expect(s.policy.orders[0].filledToday).toBe(3);
    expect(s.policy.orders[1].filledToday).toBe(1);
    // cancel all → target 0
    for (const o of [...s.policy.orders]) dispatch(s, { type: 'cancelOrder', id: o.id });
    policyBeginDay(s);
    expect(sw.target).toBe(0);
  });

  it('caps sell orders by holdings and disables once-orders after their day', () => {
    const s = tinyState();
    s.treasury.goods[0][G.coal] = 4;
    dispatch(s, { type: 'placeOrder', market: { kind: 'good', town: 0, good: G.coal }, side: 'sell', price: 1, qty: 3, once: true });
    dispatch(s, { type: 'placeOrder', market: { kind: 'good', town: 0, good: G.coal }, side: 'sell', price: 1, qty: 3 });
    policyBeginDay(s);
    const books = openBooks(s);
    playerOrders(s, books);
    const asks = books.goods[0 * N_GOODS + G.coal].asks;
    expect(asks.length).toBe(2);
    expect(asks[0].qty + asks[1].qty).toBeCloseTo(4);
    playerAfterClear(s, books);
    expect(s.policy.orders[0].enabled).toBe(false);
    expect(s.policy.orders[1].enabled).toBe(true);
  });
});

describe('transfers', () => {
  it('pays each member of a group, counts it as income, and scales down to the Purse', () => {
    const s = tinyState();
    const a = newPerson(s, 0, 'A');
    const b = newPerson(s, 0, 'B');
    const c = newPerson(s, 1, 'C');
    b.job = 2;
    reconcileBank(s);
    expect(dispatch(s, { type: 'transfer', group: 'unemployed', town: -1, amount: 10, dir: 1 }).ok).toBe(false); // empty Purse
    dispatch(s, { type: 'mint', amount: 15 });
    const r = dispatch(s, { type: 'transfer', group: 'unemployed', town: -1, amount: 10, dir: 1 });
    expect(r.ok).toBe(true);
    expect(r.message).not.toMatch(FORBIDDEN);
    expect(a.cash).toBeCloseTo(7.5); // ¤15 shared by the 2 unemployed
    expect(c.cash).toBeCloseTo(7.5);
    expect(b.cash).toBe(0);
    expect(a.earned).toBeCloseTo(7.5);
    const took = executeTransfer(s, 'all', 0, 5, -1);
    expect(took).toBeCloseTo(5); // A had 7.5, B had 0
    expect(a.cash).toBeCloseTo(2.5);
    expect(dispatch(s, { type: 'transfer', group: 'homeless', town: 7, amount: 1, dir: 1 }).ok).toBe(false);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-9);
  });

  it('recapitalises the bank', () => {
    const s = tinyState();
    reconcileBank(s);
    dispatch(s, { type: 'mint', amount: 1000 });
    const eq0 = s.bank.equity;
    const r = dispatch(s, { type: 'transfer', group: 'bank', town: -1, amount: 400, dir: 1 });
    expect(r.ok).toBe(true);
    expect(s.bank.equity - eq0).toBeCloseTo(400);
    expect(s.bank.reserves).toBeCloseTo(400);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-9);
  });
});
