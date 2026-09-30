// Final bug-fix pass, batch A: Treasury claims on the Bank, duplicate roads, the
// Treasury crew (unpaid workers, orders' lifetime caps) and player-facing wording.
import { describe, expect, it } from 'vitest';
import { newFirm, newMarket, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { firmsPayWages } from '../src/sim/agents/firms';
import { laborMarket } from '../src/sim/agents/labor';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger, deposits } from '../src/sim/ledger';
import { stockLevies } from '../src/sim/policy/levies';
import { describeLevy, describeLimit, dispatch, levyShortLabel, policyBeginDay } from '../src/sim/policy/player';
import { STATE, type Firm, type Levy, type Limit, type MapData, type PlayerAction, type SimState } from '../src/sim/types';
import { createWorld } from '../src/sim/world/init';

const FORBIDDEN = /\b(tax|taxes|subsid\w*|tariff\w*|quota\w*|stimulus|bailout|minimum wage|UBI|QE|quantitative)\b/i;

function tinyState(): SimState {
  const n = 4;
  const map: MapData = {
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
  const s = newSimState(1, map);
  s.towns.push(newTown(0, 'Millbrook', 'farm', 0, 0, 3));
  s.towns.push(newTown(1, 'Saltmere', 'harbor', 1, 1, 3));
  s.treasury = newTreasury(2);
  for (let t = 0; t < 2; t++) for (let g = 0; g < N_GOODS; g++) s.markets.push(newMarket(t, g, 2));
  return s;
}

type LevyIn = Extract<PlayerAction, { type: 'addLevy' }>['levy'];
const baseLevy: LevyIn = { label: '', enabled: true, dir: 1, base: 'sale', unit: 'pct', rate: 0.1, payer: 'buyer', threshold: 0, good: -1, town: -1, toTown: -1, sector: 'any', group: 'all', buildingKind: 'any', until: -1 };

const crewOf = (s: SimState, town: number): Firm => s.firms.find((f) => f && f.alive && f.sector === 'stateworks' && f.town === town)!;

describe('Treasury claims on the Bank never exceed its capital', () => {
  it('a seizure takes at most the Bank’s capital and reports what it took', () => {
    const s = createWorld({ seed: 1 });
    const eq0 = s.bank.equity;
    const purse0 = s.treasury.purse;
    expect(eq0).toBeGreaterThan(0);
    const r = dispatch(s, { type: 'transfer', group: 'bank', town: -1, amount: 1e10, dir: -1 });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/all the capital the Bank could spare/);
    expect(r.message).not.toMatch(/10,000,000,000/);
    expect(s.bank.equity).toBeGreaterThanOrEqual(-1e-6);
    expect(s.treasury.purse - purse0).toBeLessThanOrEqual(eq0 + 1e-6);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6 * Math.max(1, deposits(s)));
    // Nothing left to take: refused.
    const again = dispatch(s, { type: 'transfer', group: 'bank', town: -1, amount: 100, dir: -1 });
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/no capital/);
  });

  it('a levy on the Bank’s own building stops at its capital', () => {
    const s = createWorld({ seed: 1 });
    const eq0 = s.bank.equity;
    const r = dispatch(s, { type: 'addLevy', levy: { ...baseLevy, base: 'building', unit: 'flat', rate: 20000, payer: 'owner', buildingKind: 'bank' } });
    expect(r.ok).toBe(true);
    const levy = s.policy.levies[0];
    let taken = 0;
    for (let d = 0; d < 10; d++) {
      levy.today = 0;
      stockLevies(s);
      taken += levy.today;
      expect(s.bank.equity).toBeGreaterThanOrEqual(-1e-6);
    }
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThanOrEqual(eq0 + 1e-6);
    expect(s.bank.windowDebt).toBe(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6 * Math.max(1, deposits(s)));
  });
});

describe('roads are not commissioned twice', () => {
  it('refuses a road already being paved, and allows it again once called off', () => {
    const s = createWorld({ seed: 1 });
    s.treasury.autoMint = true;
    const a = dispatch(s, { type: 'build', kind: 'road', from: 0, to: 1 });
    expect(a.ok).toBe(true);
    for (let i = 0; i < 2; i++) {
      const b = dispatch(s, { type: 'build', kind: 'road', from: 0, to: 1 });
      expect(b.ok).toBe(false);
      expect(b.message).toMatch(/Already under way/);
      expect(b.message).not.toMatch(FORBIDDEN);
    }
    // The reverse direction is the same road.
    expect(dispatch(s, { type: 'build', kind: 'road', from: 1, to: 0 }).ok).toBe(false);
    const roads = () => s.projects.filter((p) => p.kind === 'road' && p.owner === STATE && p.status !== 'cancelled');
    expect(roads().length).toBe(1);
    expect(dispatch(s, { type: 'cancelProject', id: a.id! }).ok).toBe(true);
    expect(dispatch(s, { type: 'build', kind: 'road', from: 0, to: 1 }).ok).toBe(true);
    expect(roads().length).toBe(1);
  });
});

describe('the Treasury crew', () => {
  it('with auto-mint off, hires only what the Purse can pay (none while payments are on hold)', () => {
    const s = tinyState();
    const sw = newFirm(s, 'stateworks', 0, -1, STATE, 'Treasury Works');
    s.treasury.autoMint = false;
    s.treasury.purse = 100;
    const r = dispatch(s, { type: 'placeOrder', market: { kind: 'labor', town: 0 }, side: 'buy', price: 20, qty: 150 });
    expect(r.ok).toBe(true);
    policyBeginDay(s);
    expect(sw.target).toBe(5); // ¤100 / ¤20
    s.treasury.purse = 0;
    policyBeginDay(s);
    expect(s.treasury.givesSuspended).toBe(true);
    expect(sw.target).toBe(0);
    s.treasury.autoMint = true;
    policyBeginDay(s);
    expect(sw.target).toBe(150);
  });

  it('never targets more workers than an order’s remaining worker-days', () => {
    const s = tinyState();
    const sw = newFirm(s, 'stateworks', 0, -1, STATE, 'Treasury Works');
    s.treasury.autoMint = true;
    const r = dispatch(s, { type: 'placeOrder', market: { kind: 'labor', town: 0 }, side: 'buy', price: 15, qty: 60, total: 600 });
    s.policy.orders.find((o) => o.id === r.id)!.filled = 580;
    policyBeginDay(s);
    expect(sw.target).toBe(20);
  });

  it('releases all its excess workers at once when orders end, and pays a short Purse pro rata', () => {
    const s = createWorld({ seed: 1 });
    const sw = crewOf(s, 0);
    const idle = s.people.filter((p) => p && p.alive && p.job < 0 && p.town === 0).slice(0, 10);
    expect(idle.length).toBe(10);
    for (const p of idle) {
      p.job = sw.id;
      p.tenure = 5;
      sw.workers.push(p.id);
    }
    sw.wage = 20;
    // Short Purse: ¤50 for a ¤200 wage bill → everyone gets the same ¤5.
    s.treasury.autoMint = false;
    s.treasury.purse = 50;
    const cash0 = idle.map((p) => p.cash);
    firmsPayWages(s);
    idle.forEach((p, i) => expect(p.cash - cash0[i]).toBeCloseTo(5, 9));
    expect(s.treasury.purse).toBeCloseTo(0, 9);
    // Order gone (target 0): the whole crew leaves the same day.
    sw.target = 0;
    laborMarket(s);
    expect(sw.workers.length).toBe(0);
    for (const p of idle) expect(p.job).toBe(-1);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6 * Math.max(1, deposits(s)));
  });
});

describe('orders that would give things away', () => {
  it('refuses new IOUs with no real floor, and warns on a sell floor far below the market', () => {
    const s = tinyState();
    const iou = dispatch(s, { type: 'placeOrder', market: { kind: 'iou' }, side: 'sell', price: 0, qty: 1e6 });
    expect(iou.ok).toBe(false);
    expect(iou.message).toMatch(/lowest price of at least/);
    expect(iou.message).not.toMatch(FORBIDDEN);
    const ref = s.iouMarket.ema > 0 ? s.iouMarket.ema : s.iouMarket.price > 0 ? s.iouMarket.price : 100;
    const ok = dispatch(s, { type: 'placeOrder', market: { kind: 'iou' }, side: 'sell', price: ref * 0.9, qty: 10 });
    expect(ok.ok).toBe(true);
    // Lowering it to nothing later is refused too.
    expect(dispatch(s, { type: 'updateOrder', id: ok.id!, patch: { price: 0 } }).ok).toBe(false);
    s.markets[0 * N_GOODS + G.bread].ema = 2;
    const cheap = dispatch(s, { type: 'placeOrder', market: { kind: 'good', town: 0, good: G.bread }, side: 'sell', price: 0.2, qty: 50 });
    expect(cheap.ok).toBe(true);
    expect(cheap.message).toMatch(/far below today's price/);
    expect(cheap.message).not.toMatch(FORBIDDEN);
    // at 0 the goods are handed out free (player.treasuryHandouts), not sold for nothing
    const free = dispatch(s, { type: 'placeOrder', market: { kind: 'good', town: 0, good: G.bread }, side: 'sell', price: 0, qty: 50 });
    expect(free.ok).toBe(true);
    expect(free.message).toMatch(/free/);
    expect(free.message).not.toMatch(/far below today's price/);
    expect(free.message).not.toMatch(FORBIDDEN);
  });
});

describe('wording', () => {
  const levy = (p: Partial<Levy>): Levy => ({ ...(baseLevy as Levy), id: 1, created: 0, today: 0, month: 0, lastMonth: 0, total: 0, ...p });
  const limit = (p: Partial<Limit>): Limit => ({ id: 1, created: 0, binding: 0, label: '', enabled: true, kind: 'importMax', good: -1, town: -1, toTown: -1, value: 0, until: -1, ...p });

  it('money and goods levies name the trade they are limited to', () => {
    const s = tinyState();
    const m = levy({ base: 'money', unit: 'pct', payer: 'holder', rate: 0.02, sector: 'bakery' });
    expect(describeLevy(s, m)).toMatch(/money held at bakeries/);
    expect(levyShortLabel(s, m)).toMatch(/money held at bakeries/);
    const f = levy({ base: 'money', unit: 'flat', payer: 'holder', rate: 1, sector: 'bakery' });
    expect(describeLevy(s, f)).toMatch(/at bakeries/);
    const g = levy({ base: 'goods', unit: 'perUnit', payer: 'holder', rate: 0.1, good: G.grain, sector: 'bakery' });
    expect(describeLevy(s, g)).toMatch(/kept in store at bakeries/);
    expect(levyShortLabel(s, g)).toMatch(/in store at bakeries/);
    expect(levyShortLabel(s, levy({ base: 'wage', payer: 'worker', sector: 'bakery' }))).toMatch(/wages at bakeries/);
    // No trade: unchanged.
    expect(describeLevy(s, levy({ base: 'money', unit: 'pct', payer: 'holder', rate: 0.02 }))).not.toMatch(/ at /);
  });

  it('transfers to a whole group read as plain English', () => {
    const s = createWorld({ seed: 1 });
    s.treasury.autoMint = true;
    const r = dispatch(s, { type: 'transfer', group: 'all', town: -1, amount: 1, dir: 1 });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/to each of [\d,]+ people \(/);
    expect(r.message).not.toMatch(/everyone/);
    const w = dispatch(s, { type: 'transfer', group: 'owners', town: -1, amount: 1, dir: -1 });
    if (w.ok) expect(w.message).toMatch(/from each of [\d,]+ property owners/);
  });

  it('quantity limits on every good say "each good" and "each route"', () => {
    const s = tinyState();
    expect(describeLimit(s, limit({ kind: 'importMax', value: 0 }))).toBe('No goods may come in through the port.');
    expect(describeLimit(s, limit({ kind: 'exportMax', value: 0 }))).toBe('No goods may leave through the port.');
    expect(describeLimit(s, limit({ kind: 'importMax', value: 5 }))).toBe('At most 5 units of each good may come in through the port each day.');
    expect(describeLimit(s, limit({ kind: 'shipMax', value: 5 }))).toBe('At most 5 units of each good may be carried between towns on each route each day.');
    expect(describeLimit(s, limit({ kind: 'shipMax', value: 0 }))).toBe('No goods may be carried between towns.');
    // One good, one route: unchanged.
    expect(describeLimit(s, limit({ kind: 'shipMax', value: 5, good: G.bread, town: 0, toTown: 1 }))).toBe('At most 5 units of bread may be carried from Millbrook to Saltmere each day.');
    for (const k of ['importMax', 'exportMax', 'shipMax'] as const) expect(describeLimit(s, limit({ kind: k, value: 3 }))).not.toMatch(/any good/);
  });
});
