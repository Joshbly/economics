// Price brackets (policy/brackets.ts): the Treasury buys a good below a floor and sells it above a ceiling, town by
// town, every day — fixed prices, each town's own going price, or the realm's; one price a side or a ladder.
import { describe, expect, it } from 'vitest';
import { bracketBand, bracketLegs, bracketRef, checkBracket, describeBracket } from '../src/sim/policy/brackets';
import { stepDay } from '../src/sim/engine';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger } from '../src/sim/ledger';
import { dispatch } from '../src/sim/policy/player';
import { deserialize, serialize } from '../src/sim/save';
import type { Bracket, SimState } from '../src/sim/types';
import { createWorld } from '../src/sim/world/init';

const BANNED = /tax|subsid|bailout|stimulus|QE|quantitative|tariff|UBI|minimum wage/i;

function grown(): SimState {
  const s = createWorld({ seed: 2 });
  s.settings.events = false;
  s.treasury.autoMint = true;
  for (let d = 0; d < 20; d++) stepDay(s);
  return s;
}

function add(s: SimState, b: Parameters<typeof checkBracket>[1]): Bracket {
  const r = dispatch(s, { type: 'addBracket', bracket: b as never });
  expect(r.ok, r.message).toBe(true);
  expect(r.message).not.toMatch(BANNED);
  return s.policy.brackets!.find((x) => x.id === r.id)!;
}

const price = (s: SimState, town: number, g: number) => s.markets[town * N_GOODS + g].ema;
const ledgerOk = (s: SimState) => expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6 * Math.max(1, s.bank.reserves) + 1e-3);

describe('brackets: the band', () => {
  it('fixed, local and realm floors and ceilings', () => {
    const s = grown();
    const fixed = add(s, { good: G.grain, mode: 'fixed', low: 2, high: 5, buyQty: 10, sellQty: 10 });
    for (const t of s.towns) expect(bracketBand(s, fixed, t.id)).toMatchObject({ floor: 2, ceiling: 5 });
    const local = add(s, { good: G.grain, mode: 'local', low: 0.1, high: 0.2, buyQty: 10, sellQty: 10 });
    for (const t of s.towns) {
      const b = bracketBand(s, local, t.id);
      expect(b.floor).toBeCloseTo(b.ref * 0.9, 6);
      expect(b.ceiling).toBeCloseTo(b.ref * 1.2, 6);
    }
    const realm = add(s, { good: G.grain, mode: 'realm', low: 0.1, high: 0.2, buyQty: 10, sellQty: 10 });
    const floors = s.towns.map((t) => bracketBand(s, realm, t.id).floor);
    for (const f of floors) expect(f).toBeCloseTo(floors[0], 9);
  });

  it('a ladder bids further below the floor (and offers further above the ceiling) for more at each rung', () => {
    const s = grown();
    const b = add(s, { good: G.bread, mode: 'fixed', low: 3, high: 6, buyQty: 5, sellQty: 4, rungs: 3, step: 0.1, towns: [0] });
    const legs = bracketLegs(s).filter((L) => L.b === b);
    const buys = legs.filter((L) => L.side === 'buy');
    const sells = legs.filter((L) => L.side === 'sell');
    expect(buys.map((L) => L.po.price)).toEqual([3, 2.7, 2.4]);
    expect(buys.map((L) => L.po.qty)).toEqual([5, 10, 15]);
    expect(sells.map((L) => L.po.price.toFixed(2))).toEqual(['6.00', '6.60', '7.20']);
    expect(sells.map((L) => L.po.qty)).toEqual([4, 8, 12]);
    for (const L of legs) expect(L.town).toBe(0);
  });

  it('the going price is the median of recent days: a spike does not drag the band after it', () => {
    const s = grown();
    const m = s.markets[0 * N_GOODS + G.grain];
    m.hist = [...Array(170).fill(2), ...Array(10).fill(10)]; // half a year at ¤2, then ten days at ¤10
    const b = add(s, { good: G.grain, mode: 'local', low: 0.1, high: 0.15, buyQty: 10, sellQty: 10, towns: [0] });
    expect(bracketRef(s, b, 0)).toBeCloseTo(2, 6);
    expect(bracketBand(s, b, 0).ceiling).toBeCloseTo(2.3, 6);
  });

  it('refuses nonsense', () => {
    const s = grown();
    expect(checkBracket(s, { good: 99, mode: 'fixed', low: 1, high: 2, buyQty: 1, sellQty: 1 }).ok).toBe(false);
    expect(checkBracket(s, { good: G.grain, mode: 'fixed', low: 5, high: 2, buyQty: 1, sellQty: 1 }).ok).toBe(false);
    expect(checkBracket(s, { good: G.grain, mode: 'local', low: 0.1, high: 0.1, buyQty: 0, sellQty: 0 }).ok).toBe(false);
    expect(checkBracket(s, { good: G.grain, mode: 'local', low: 2, high: 0.1, buyQty: 1, sellQty: 0 }).ok).toBe(false);
  });
});

describe('brackets: trading', () => {
  it('buys when the price is below the floor, up to its stock cap, and the ledger holds', () => {
    const s = grown();
    const p0 = price(s, 0, G.grain);
    const b = add(s, { good: G.grain, mode: 'fixed', low: p0 * 1.5, high: p0 * 3, buyQty: 30, sellQty: 30, maxStock: 100, towns: [0] });
    for (let d = 0; d < 20; d++) stepDay(s);
    expect(b.bought).toBeGreaterThan(0);
    expect(b.spent).toBeGreaterThan(0);
    const held = s.treasury.goods[0][G.grain];
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThanOrEqual(100 + 30 + 1e-6); // (one day's buying past the cap at most)
    ledgerOk(s);
  });

  it('sells what the store holds when the price is above the ceiling, never more', () => {
    const s = grown();
    s.treasury.goods[0][G.grain] = 50; // (a test endowment of stock)
    const p0 = price(s, 0, G.grain);
    // a standing sell order and a bracket in the same market share the store
    expect(dispatch(s, { type: 'placeOrder', market: { kind: 'good', town: 0, good: G.grain }, side: 'sell', price: p0 * 0.5, qty: 40 }).ok).toBe(true);
    const b = add(s, { good: G.grain, mode: 'fixed', low: p0 * 0.1, high: p0 * 0.6, buyQty: 0, sellQty: 40, towns: [0] });
    for (let d = 0; d < 5; d++) {
      stepDay(s);
      expect(s.treasury.goods[0][G.grain]).toBeGreaterThanOrEqual(-1e-9);
    }
    expect(b.sold + s.policy.orders[0].filled).toBeLessThanOrEqual(50 + 1e-6);
    expect(s.treasury.goods[0][G.grain]).toBeLessThan(50);
    ledgerOk(s);
  });

  it('a local bracket in every town lives through a year with the ledger exact, and a save goes on as the original', () => {
    const s = grown();
    add(s, { good: G.grain, mode: 'local', low: 0.08, high: 0.12, buyQty: 25, sellQty: 25, maxStock: 1500, rungs: 2, step: 0.08 });
    for (let d = 0; d < 120; d++) stepDay(s);
    ledgerOk(s);
    const t = deserialize(serialize(s));
    expect(t.policy.brackets).toEqual(s.policy.brackets);
    for (let d = 0; d < 20; d++) {
      stepDay(s);
      stepDay(t);
    }
    expect(JSON.stringify({ ...t, news: [] })).toBe(JSON.stringify({ ...s, news: [] }));
    expect(describeBracket(s, s.policy.brackets![0])).not.toMatch(BANNED);
  }, 120_000);

  it('pauses, lapses and is removed; what it bought stays in the stores', () => {
    const s = grown();
    const p0 = price(s, 0, G.grain);
    const b = add(s, { good: G.grain, mode: 'fixed', low: p0 * 1.5, high: p0 * 3, buyQty: 10, sellQty: 0, towns: [0], days: 5 });
    expect(dispatch(s, { type: 'updateBracket', id: b.id, patch: { enabled: false } }).ok).toBe(true);
    stepDay(s);
    expect(b.bought).toBe(0);
    expect(dispatch(s, { type: 'updateBracket', id: b.id, patch: { enabled: true } }).ok).toBe(true);
    for (let d = 0; d < 8; d++) stepDay(s);
    expect(s.policy.brackets!.find((x) => x.id === b.id)).toBeUndefined(); // lapsed
    const held = s.treasury.goods[0][G.grain];
    expect(held).toBeGreaterThan(0);
    const c = add(s, { good: G.grain, mode: 'local', low: 0.1, high: 0.1, buyQty: 1, sellQty: 1 });
    const r = dispatch(s, { type: 'removeBracket', id: c.id });
    expect(r.ok).toBe(true);
    expect(r.message).not.toMatch(BANNED);
    expect(s.treasury.goods[0][G.grain]).toBe(held);
    // a damaged bracket in a save is dropped
    const raw = JSON.parse(serialize(s));
    raw.policy.brackets = [{ id: 1, good: 'grain' }];
    expect(deserialize(JSON.stringify(raw)).policy.brackets).toEqual([]);
  });
});
