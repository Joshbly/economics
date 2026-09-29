// Treasury carry rules (policy/carry.ts): move the Treasury's goods between its stores by
// wagon. A supply line is three primitives — buy in A, carry A → B, sell in B. Built from
// record factories with the roads injected into the runtime cache (as in traders.test.ts);
// the save/load round trips use a generated world.
import { describe, expect, it } from 'vitest';
import { freightPerUnit, tradersBeginDay, tradersDispatch } from '../src/sim/agents/traders';
import { CARRY_FULL_SHARE, TOOLS_PER_WAGON, TREASURY_FREIGHT_PREMIUM, WAGON_CAPACITY } from '../src/sim/config';
import { spoilage } from '../src/sim/engine';
import { newFirm, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { Game } from '../src/sim/game';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger, mint, reconcileBank } from '../src/sim/ledger';
import { addAsk, addBid, bookFor, clearAll, marketOf, openBooks, type Books } from '../src/sim/market/markets';
import { dispatch, playerAfterClear, playerOrders, policyBeginDay, playerAfterSession, playerBeforeSession } from '../src/sim/policy/player';
import { carryHoldDays, carryLoadNow, carryOnRoad } from '../src/sim/policy/carry';
import { rt, type Route } from '../src/sim/runtime';
import { deserialize, serialize } from '../src/sim/save';
import { FIRM_BASE, STATE, type CarryRule, type Firm, type MapData, type SimState } from '../src/sim/types';

const FORBIDDEN = /\b(tax|taxes|subsid\w*|tariff\w*|quota\w*|stimulus|bailout|minimum wage|UBI|QE|quantitative)\b/i;
const PRICES = [2.6, 3.0, 2.6, 2.6, 2.6, 3.2, 13, 20, 4, 2.8, 22];

function tinyMap(): MapData {
  const w = 60;
  const h = 10;
  const n = w * h;
  const z = () => new Array(n).fill(0);
  return { w, h, terrain: new Array(n).fill(3), elev: z(), fert: z(), deposit: z(), river: z(), road: new Array(n).fill(1), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

function setRoute(s: SimState, a: number, b: number, length: number, days: number): void {
  const r = rt(s);
  const mk = (from: number, to: number): Route => ({ from, to, tiles: [], length, paved: 0, dirt: length, offroad: 0, days });
  r.routes.set(a + '>' + b, mk(a, b));
  r.routes.set(b + '>' + a, mk(b, a));
}

interface World {
  s: SimState;
  trader: Firm;
  bakery: Firm;
}

/** Millbrook (0) → Kingsbridge (1): 40 tiles, 2 days; a trading house and a bakery in Millbrook. Hollow (2) is out of wagon reach. */
function world(): World {
  const s = newSimState(5, tinyMap());
  s.towns.push(newTown(0, 'Millbrook', 'farm', 5, 5, 3));
  s.towns.push(newTown(1, 'Kingsbridge', 'capital', 45, 5, 3));
  s.towns.push(newTown(2, 'Hollow', 'mining', 55, 5, 3));
  s.treasury = newTreasury(3);
  for (let t = 0; t < 3; t++) for (let g = 0; g < N_GOODS; g++) s.markets.push(newMarket(t, g, PRICES[g]));
  setRoute(s, 0, 1, 40, 2);
  setRoute(s, 0, 2, 400, 50); // too slow for wagons
  setRoute(s, 1, 2, 400, 50);
  const owner = newPerson(s, 0, 'Owner');
  const trader = newFirm(s, 'trader', 0, -1, owner.id, 'Trading House');
  trader.wage = 10;
  trader.cash = 5000;
  trader.tools = 6.5 * TOOLS_PER_WAGON;
  trader.inv[G.oil] = 60;
  trader.capacity = 24;
  for (let i = 0; i < 6; i++) {
    const p = newPerson(s, 0, 'Carter' + i);
    p.job = trader.id;
    trader.workers.push(p.id);
  }
  const bakery = newFirm(s, 'bakery', 0, -1, owner.id, 'Bakery');
  s.bank.reserves = 1e5;
  reconcileBank(s);
  return { s, trader, bakery };
}

/** One market day by hand (the engine's order for the parts that matter here), then the evening's spoilage and day += 1. */
function marketDay(s: SimState, orders?: (books: Books) => void, spoil = false): void {
  policyBeginDay(s);
  tradersBeginDay(s);
  const books = openBooks(s);
  orders?.(books);
  playerOrders(s, books);
  // the engine's three market sessions, with the Treasury's steps between them
  clearAll(s, books, { before: (k) => playerBeforeSession(s, books, k), after: (k) => playerAfterSession(s, k) });
  tradersDispatch(s, books);
  playerAfterClear(s, books);
  if (spoil) spoilage(s);
  s.day += 1;
}

const breadIn = (town: number) => ({ kind: 'good' as const, town, good: G.bread });
const rule = (s: SimState, id: number): CarryRule => s.policy.carries.find((c) => c.id === id)!;
const fee1 = (s: SimState) => freightPerUnit(s, 0, 1) * WAGON_CAPACITY * (1 + TREASURY_FREIGHT_PREMIUM);

describe('carry — placing', () => {
  it('validates the towns, the good and the amount, and describes the rule neutrally', () => {
    const { s } = world();
    const base = { type: 'carry' as const, from: 0, to: 1, good: G.bread, qty: -1 };
    expect(dispatch(s, { ...base, to: 0 }).ok).toBe(false);
    expect(dispatch(s, { ...base, to: 7 }).ok).toBe(false);
    expect(dispatch(s, { ...base, to: 2 }).ok).toBe(false); // no wagon road
    expect(dispatch(s, { ...base, good: 99 }).ok).toBe(false);
    expect(dispatch(s, { ...base, qty: 0 }).ok).toBe(false);
    expect(dispatch(s, { ...base, qty: -3 }).ok).toBe(false);
    expect(dispatch(s, { ...base, wagons: 'slow' as never }).ok).toBe(false);
    expect(s.policy.carries.length).toBe(0);

    const r = dispatch(s, base);
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/^The Treasury will carry all the bread it holds in Millbrook to its store in Kingsbridge, in full wagons \(or after 2 days of waiting\)\./);
    expect(r.message).toMatch(/holds no bread in Millbrook yet/);
    expect(rule(s, r.id!)).toMatchObject({ from: 0, to: 1, good: G.bread, qty: -1, wagons: 'full', until: -1, carried: 0, freight: 0, heldSince: -1 });
    expect(rule(s, r.id!).label).toBe('Carry bread · Millbrook → Kingsbridge · all');
    const r2 = dispatch(s, { ...base, qty: 20, wagons: 'now', days: 5 });
    expect(r2.message).toMatch(/carry up to 20 loaves a day of the bread it holds in Millbrook to its store in Kingsbridge, as soon as a market session ends until/);
    expect(rule(s, r2.id!).until).toBe(s.day + 4);
    for (const x of [r, r2]) expect(x.message).not.toMatch(FORBIDDEN);
    for (const n of s.news) expect(n.text).not.toMatch(FORBIDDEN);
  });

  it('once: sends what is held now and keeps no rule', () => {
    const { s, trader } = world();
    s.treasury.autoMint = true;
    expect(dispatch(s, { type: 'carry', from: 0, to: 1, good: G.tools, qty: 4, once: true }).ok).toBe(false); // nothing held
    s.treasury.goods[0][G.tools] = 10;
    const cash0 = trader.cash;
    const r = dispatch(s, { type: 'carry', from: 0, to: 1, good: G.tools, qty: 4, once: true });
    expect(r.ok, r.message).toBe(true);
    expect(s.policy.carries.length).toBe(0);
    expect(s.shipments.length).toBe(1);
    expect(s.shipments[0].order).toBe(-1);
    expect(s.shipments[0].qty).toBeCloseTo(4);
    expect(s.treasury.goods[0][G.tools]).toBeCloseTo(6);
    expect(trader.cash - cash0).toBeCloseTo(fee1(s), 6);
    const all = dispatch(s, { type: 'carry', from: 0, to: 1, good: G.tools, qty: -1, once: true });
    expect(all.ok).toBe(true);
    expect(s.treasury.goods[0][G.tools]).toBe(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });
});

describe('carry — buy, carry, sell as three primitives', () => {
  it('a purchase at the opening leaves after it, lands in the store at the destination and a sell order offers it there', () => {
    const { s, trader, bakery } = world();
    s.treasury.autoMint = true;
    bakery.inv[G.bread] = 60;
    const buy = dispatch(s, { type: 'placeOrder', market: breadIn(0), side: 'buy', price: 4, qty: 60, session: 0 }).id!;
    const cid = dispatch(s, { type: 'carry', from: 0, to: 1, good: G.bread, qty: -1, wagons: 'now' }).id!;
    const sell = dispatch(s, { type: 'placeOrder', market: breadIn(1), side: 'sell', price: 3.5, qty: 100 }).id!;
    const c = rule(s, cid);
    const cash0 = trader.cash;
    marketDay(s, (b) => addAsk(bookFor(b, 0, G.bread), FIRM_BASE + bakery.id, 3, 60, { session: 0 }));
    const p0 = marketOf(s, 0, G.bread).price;
    const o = s.policy.orders.find((x) => x.id === buy)!;
    expect(o.filled).toBeCloseTo(60);
    expect(o.value).toBeCloseTo(60 * p0);
    // loaded after the opening (half a wagon, but "right away")
    const sh = s.shipments.find((x) => x.owner === STATE)!;
    expect(sh.order).toBe(cid);
    expect(sh.qty).toBeCloseTo(60);
    expect(sh.depart).toBeCloseTo(0.5, 9); // wagons leave at noon
    expect(c.carried).toBeCloseTo(60);
    expect(c.carriedToday).toBeCloseTo(60);
    expect(c.freight).toBeCloseTo(fee1(s), 6);
    expect(trader.cash - cash0).toBeCloseTo(fee1(s), 6);
    expect(carryOnRoad(s, cid)).toBeCloseTo(60);
    expect(s.treasury.goods[0][G.bread]).toBe(0);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);

    marketDay(s); // on the road
    expect(s.treasury.goods[1][G.bread]).toBe(0);
    // arrives on day 2 at 2.5: before the midday session, where the sell order offers it
    marketDay(s);
    expect(s.treasury.goods[1][G.bread]).toBeCloseTo(60);
    expect(carryOnRoad(s, cid)).toBe(0);
    const st = marketOf(s, 1, G.bread).curve!.state;
    expect(st[0]).toBe(1); // the Treasury's ask was in the book
    // a buyer takes 30 at up to ¤10
    const buyer = newPerson(s, 1, 'Buyer');
    buyer.cash = 1000;
    reconcileBank(s);
    marketDay(s, (b) => addBid(bookFor(b, 1, G.bread), buyer.id, 10, 30));
    const so = s.policy.orders.find((x) => x.id === sell)!;
    expect(so.filled).toBeCloseTo(30);
    expect(s.treasury.goods[1][G.bread]).toBeCloseTo(30);
    expect(buyer.pantry[G.bread]).toBeCloseTo(30);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('full wagons: a part load waits as long as the good keeps; a full one leaves at once', () => {
    const { s } = world();
    s.treasury.autoMint = true;
    const cid = dispatch(s, { type: 'carry', from: 0, to: 1, good: G.bread, qty: -1 }).id!;
    s.treasury.goods[0][G.bread] = 30;
    marketDay(s);
    expect(s.shipments.length).toBe(0); // collecting (day 0 of 2)
    expect(rule(s, cid).heldSince).toBe(0);
    marketDay(s);
    expect(s.shipments.length).toBe(0); // day 1
    marketDay(s);
    expect(s.shipments.length).toBe(1); // waited 2 days: bread will not keep longer
    expect(s.shipments[0].qty).toBeCloseTo(30);
    expect(rule(s, cid).heldSince).toBe(-1);
    s.treasury.goods[0][G.bread] = WAGON_CAPACITY * 2.5;
    marketDay(s);
    expect(s.shipments.length).toBe(2);
    expect(s.shipments[1].qty).toBeCloseTo(2 * WAGON_CAPACITY); // two full wagons; the half waits
    expect(s.treasury.goods[0][G.bread]).toBeCloseTo(0.5 * WAGON_CAPACITY);
    // rush it: everything leaves after the next session
    expect(dispatch(s, { type: 'updateCarry', id: cid, patch: { wagons: 'now' } }).ok).toBe(true);
    marketDay(s);
    expect(s.treasury.goods[0][G.bread]).toBe(0);
  });

  it('a daily amount: at most that much a day (banked while the goods wait for a fuller wagon)', () => {
    const { s } = world();
    s.treasury.autoMint = true;
    const cid = dispatch(s, { type: 'carry', from: 0, to: 1, good: G.tools, qty: 20, wagons: 'now' }).id!;
    s.treasury.goods[0][G.tools] = 100;
    marketDay(s);
    expect(rule(s, cid).carried).toBeCloseTo(20);
    marketDay(s);
    expect(rule(s, cid).carried).toBeCloseTo(40);
    expect(s.treasury.goods[0][G.tools]).toBeCloseTo(60);
    // full wagons: 20 a day banks until the tools have waited a week (or a wagon fills)
    dispatch(s, { type: 'updateCarry', id: cid, patch: { wagons: 'full' } });
    for (let d = 0; d < 3; d++) marketDay(s);
    expect(rule(s, cid).carried).toBeCloseTo(40);
    expect(rule(s, cid).allow).toBeGreaterThan(20);
  });

  it('waits in the store while the Purse cannot pay the freight, then sends it', () => {
    const { s } = world();
    s.treasury.autoMint = false;
    const cid = dispatch(s, { type: 'carry', from: 0, to: 1, good: G.tools, qty: -1, wagons: 'now' }).id!;
    s.treasury.goods[0][G.tools] = 50;
    marketDay(s);
    marketDay(s);
    expect(s.shipments.length).toBe(0);
    expect(s.news.filter((n) => /wait in Millbrook: the Purse cannot cover the freight/.test(n.text)).length).toBe(1); // once per spell
    mint(s, 10_000);
    marketDay(s);
    expect(s.shipments.length).toBe(1);
    expect(s.shipments[0].order).toBe(cid);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a rule for N days lapses with a note; its cargo on the road still lands', () => {
    const { s } = world();
    s.treasury.autoMint = true;
    dispatch(s, { type: 'carry', from: 0, to: 1, good: G.tools, qty: -1, days: 1 });
    s.treasury.goods[0][G.tools] = 30;
    marketDay(s); // its last day: at the close everything held leaves, full or not
    expect(s.shipments.length).toBe(1);
    marketDay(s);
    expect(s.policy.carries.length).toBe(0);
    expect(s.news.some((n) => /has stopped carrying tools from Millbrook to Kingsbridge/.test(n.text))).toBe(true);
    marketDay(s);
    marketDay(s);
    expect(s.treasury.goods[1][G.tools]).toBeCloseTo(30);
  });

  it('changes and removal', () => {
    const { s } = world();
    const cid = dispatch(s, { type: 'carry', from: 0, to: 1, good: G.bread, qty: 30 }).id!;
    expect(dispatch(s, { type: 'updateCarry', id: cid, patch: { qty: 0 } }).ok).toBe(false);
    expect(dispatch(s, { type: 'updateCarry', id: cid, patch: { wagons: 'x' as never } }).ok).toBe(false);
    expect(dispatch(s, { type: 'updateCarry', id: cid, patch: { until: -5 } }).ok).toBe(false);
    expect(dispatch(s, { type: 'updateCarry', id: 999, patch: { qty: 3 } }).ok).toBe(false);
    expect(dispatch(s, { type: 'updateCarry', id: cid, patch: { qty: -1 } }).ok).toBe(true);
    expect(rule(s, cid).label).toBe('Carry bread · Millbrook → Kingsbridge · all');
    expect(dispatch(s, { type: 'updateCarry', id: cid, patch: { enabled: false } }).message).toMatch(/paused/);
    const r = dispatch(s, { type: 'removeCarry', id: cid });
    expect(r.ok).toBe(true);
    expect(s.policy.carries.length).toBe(0);
    expect(dispatch(s, { type: 'removeCarry', id: cid }).ok).toBe(false);
  });
});

describe('carry — saving and loading', () => {
  it('a game saved mid-carry continues exactly as the original', () => {
    const g = Game.create({ seed: 2, warmup: false });
    g.dispatch({ type: 'setEvents', value: false });
    g.dispatch({ type: 'setAutoMint', value: true });
    g.step(15);
    const s = g.s;
    const farm = s.towns.find((t) => t.kind === 'farm')!.id;
    const harbor = s.towns.find((t) => t.kind === 'harbor')!.id;
    expect(g.dispatch({ type: 'placeOrder', market: breadIn(farm), side: 'buy', priceMode: 'follow', band: 0.2, price: 0, qty: 60 }).ok).toBe(true);
    const c = g.dispatch({ type: 'carry', from: farm, to: harbor, good: G.bread, qty: -1 });
    expect(c.ok, c.message).toBe(true);
    expect(g.dispatch({ type: 'placeOrder', market: breadIn(harbor), side: 'sell', priceMode: 'any', price: 0, qty: 60 }).ok).toBe(true);
    g.step(4);
    expect(s.policy.carries[0].carried).toBeGreaterThan(0);
    const json = g.save();
    const copy = Game.load(json);
    copy.step(12);
    g.step(12);
    expect(copy.save()).toBe(g.save());
    expect(Math.abs(checkLedger(copy.s))).toBeLessThan(1e-6 * Math.max(1, s.bank.reserves));
    expect(copy.s.policy.orders[1].filled).toBeGreaterThan(0);
  });

  it('a save with a supply route (from before carry rules) loads as its three primitives', () => {
    const g = Game.create({ seed: 2, warmup: false });
    const s = g.s;
    const farm = s.towns.find((t) => t.kind === 'farm')!.id;
    const harbor = s.towns.find((t) => t.kind === 'harbor')!.id;
    const raw = JSON.parse(g.save());
    const id = raw.ids.policy++;
    raw.policy.orders.push({
      id, label: 'old route', enabled: true, market: { kind: 'good', town: farm, good: G.bread }, side: 'buy', price: 4, qty: 25, total: -1, until: -1, once: false,
      filled: 100, value: 300, filledToday: 0, created: 0, priceMode: 'fixed', band: 0,
      route: { to: harbor, sell: 'cost', sellPrice: 0, sellMargin: 0.1, inTransit: 10, waiting: 5, landed: 3.5, shippedToday: 0, soldToday: 0, shippedTotal: 90, soldTotal: 80, freightPaid: 12, revenue: 290, dispatch: 'daily' },
    });
    delete raw.policy.carries;
    raw.shipments.push({ ...(raw.shipments[0] ?? {}), id: 9999, owner: STATE, from: farm, to: harbor, good: G.bread, qty: 10, basis: 3.5, depart: 0.5, arrive: 3, wagons: 1, order: id, line: -1 });
    const t = deserialize(JSON.stringify(raw));
    const buy = t.policy.orders.find((o) => o.id === id)!;
    expect((buy as unknown as { route?: unknown }).route).toBeUndefined();
    expect(buy.market).toEqual({ kind: 'good', town: farm, good: G.bread });
    expect(t.policy.carries.length).toBe(1);
    const c = t.policy.carries[0];
    expect(c).toMatchObject({ from: farm, to: harbor, good: G.bread, qty: -1, wagons: 'now', carried: 90, freight: 12 });
    const sell = t.policy.orders.find((o) => o.side === 'sell' && o.market.kind === 'good' && o.market.town === harbor)!;
    expect(sell.qty).toBe(25);
    expect(sell.priceMode).toBe('fixed');
    expect(sell.price).toBeCloseTo(3.85, 6); // landed cost + 10 %
    expect(t.shipments.find((x) => x.id === 9999)!.order).toBe(c.id);
    expect(serialize(t).length).toBeGreaterThan(0);
    // a save from before any of it: no carries list, no Shipment.order
    const raw2 = JSON.parse(g.save());
    delete raw2.policy.carries;
    for (const sh of raw2.shipments) delete sh.order;
    const old = deserialize(JSON.stringify(raw2));
    expect(old.policy.carries).toEqual([]);
    expect(old.shipments.every((x) => x.order === -1)).toBe(true);
  });
});

describe('carry — full wagons (pure)', () => {
  it('holds a part load within what the good keeps, sends whole wagons, and rushes on request', () => {
    expect(carryHoldDays(G.bread)).toBe(2); // 5 % a day: ~10 % lost after 2 days
    expect(carryHoldDays(G.tools)).toBe(7); // durable: at most a week
    const full = CARRY_FULL_SHARE * WAGON_CAPACITY;
    expect(carryLoadNow(30, 'full', true, 0, G.tools, 0)).toBe(0);
    expect(carryLoadNow(full, 'full', true, 0, G.tools, 0)).toBeCloseTo(full, 9);
    expect(carryLoadNow(2.5 * WAGON_CAPACITY, 'full', true, 0, G.tools, 0)).toBeCloseTo(2 * WAGON_CAPACITY, 9);
    expect(carryLoadNow(30, 'full', true, 2, G.bread, 0)).toBe(30);
    expect(carryLoadNow(30, 'full', true, 0, G.tools, 50)).toBe(30); // a freight line with room
    expect(carryLoadNow(30, 'now', true, 0, G.tools, 0)).toBe(30);
    expect(carryLoadNow(30, 'full', false, 0, G.tools, 0)).toBe(30); // the rule's last close
  });
});
