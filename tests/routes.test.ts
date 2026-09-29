// Treasury supply routes (PlayerOrder.route): buy in one town, carry on the Treasury's
// wagons, offer in another. Built from record factories with the route injected into the
// runtime cache (as in traders.test.ts); the save/load round trip uses a generated world.
import { describe, expect, it } from 'vitest';
import { freightPerUnit, tradersBeginDay, tradersDispatch } from '../src/sim/agents/traders';
import { ROUTE_MARKET_FLOOR_SHARE, TOOLS_PER_WAGON, TREASURY_FREIGHT_PREMIUM, WAGON_CAPACITY } from '../src/sim/config';
import { spoilage } from '../src/sim/engine';
import { newFirm, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { Game } from '../src/sim/game';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger, mint, reconcileBank } from '../src/sim/ledger';
import { addAsk, addBid, bookFor, clearAll, marketOf, openBooks, type Books } from '../src/sim/market/markets';
import { dispatch, playerAfterClear, playerOrders, policyBeginDay } from '../src/sim/policy/player';
import { heldAtOrigin } from '../src/sim/policy/routes';
import { rt, type Route } from '../src/sim/runtime';
import { deserialize, serialize } from '../src/sim/save';
import { FIRM_BASE, STATE, type Firm, type MapData, type PlayerOrder, type SimState } from '../src/sim/types';

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
  clearAll(s, books);
  tradersDispatch(s, books);
  playerAfterClear(s, books);
  if (spoil) spoilage(s);
  s.day += 1;
}

const breadIn = (town: number) => ({ kind: 'good' as const, town, good: G.bread });
const route = (s: SimState, id: number): PlayerOrder => s.policy.orders.find((o) => o.id === id)!;

describe('supply routes — placing', () => {
  it('validates the route and describes it neutrally', () => {
    const { s } = world();
    const buy = { type: 'placeOrder' as const, market: breadIn(0), side: 'buy' as const, price: 4.5, qty: 20 };
    expect(dispatch(s, { ...buy, side: 'sell', route: { to: 1, sell: 'cost' } }).ok).toBe(false);
    expect(dispatch(s, { ...buy, market: { kind: 'labor', town: 0 }, route: { to: 1, sell: 'cost' } }).ok).toBe(false);
    expect(dispatch(s, { ...buy, route: { to: 0, sell: 'cost' } }).ok).toBe(false);
    expect(dispatch(s, { ...buy, route: { to: 7, sell: 'cost' } }).ok).toBe(false);
    expect(dispatch(s, { ...buy, route: { to: 2, sell: 'cost' } }).ok).toBe(false); // no wagon road
    expect(dispatch(s, { ...buy, route: { to: 1, sell: 'nonsense' as never } }).ok).toBe(false);
    expect(dispatch(s, { ...buy, route: { to: 1, sell: 'fixed' } }).ok).toBe(false); // no price
    expect(dispatch(s, { ...buy, route: { to: 1, sell: 'fixed', sellPrice: -1 } }).ok).toBe(false);
    expect(dispatch(s, { ...buy, route: { to: 1, sell: 'cost', sellMargin: 11 } }).ok).toBe(false);
    expect(dispatch(s, { ...buy, route: { to: 1, sell: 'cost', sellMargin: -0.95 } }).ok).toBe(false);
    expect(s.policy.orders.length).toBe(0);

    const r = dispatch(s, { ...buy, route: { to: 1, sell: 'cost' } });
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/^The Treasury will buy up to 20 loaves of bread a day in Millbrook at up to ¤4\.50, carry it to Kingsbridge and offer it there at landed cost\./);
    const o = route(s, r.id!);
    expect(o.route).toMatchObject({ to: 1, sell: 'cost', sellMargin: 0, inTransit: 0, waiting: 0, landed: 0, shippedTotal: 0, soldTotal: 0, freightPaid: 0, revenue: 0 });
    expect(o.label).toMatch(/→ Kingsbridge$/);
    const r2 = dispatch(s, { ...buy, route: { to: 1, sell: 'cost', sellMargin: 0.1 } });
    expect(r2.message).toMatch(/at landed cost plus 10%/);
    const r3 = dispatch(s, { ...buy, route: { to: 1, sell: 'fixed', sellPrice: 3.2 } });
    expect(r3.message).toMatch(/offer it there for no less than ¤3\.20 each/);
    expect(route(s, r3.id!).route!.sellPrice).toBe(3.2);
    const r4 = dispatch(s, { ...buy, route: { to: 1, sell: 'market' } });
    expect(r4.message).toMatch(/for whatever it fetches/);
    for (const x of [r, r2, r3, r4]) expect(x.message).not.toMatch(FORBIDDEN);
    for (const n of s.news) expect(n.text).not.toMatch(FORBIDDEN);
    // ordinary orders are unchanged: route null
    const plain = dispatch(s, buy);
    expect(route(s, plain.id!).route).toBeNull();
  });
});

describe('supply routes — buy, carry, sell', () => {
  it('ships the day’s purchase at landed cost, lands it as waiting stock and sells it at the destination', () => {
    const { s, trader, bakery } = world();
    s.treasury.autoMint = true;
    bakery.inv[G.bread] = 60;
    const id = dispatch(s, { type: 'placeOrder', market: breadIn(0), side: 'buy', price: 4, qty: 60, route: { to: 1, sell: 'cost', sellMargin: 0.1 } }).id!;
    const o = route(s, id);
    const cash0 = trader.cash;
    const purse0 = s.treasury.purse;
    const minted0 = s.treasury.minted;
    marketDay(s, (b) => addAsk(bookFor(b, 0, G.bread), FIRM_BASE + bakery.id, 3, 60));
    const p0 = marketOf(s, 0, G.bread).price;
    expect(o.filled).toBeCloseTo(60);
    expect(o.value).toBeCloseTo(60 * p0);
    // loaded at once (a full day's purchase is half a wagon)
    const sh = s.shipments.find((x) => x.owner === STATE)!;
    expect(sh).toBeTruthy();
    expect(sh.order).toBe(id);
    expect(sh.qty).toBeCloseTo(60);
    expect(sh.wagons).toBe(1);
    const fee = freightPerUnit(s, 0, 1) * WAGON_CAPACITY * (1 + TREASURY_FREIGHT_PREMIUM);
    expect(o.route!.freightPaid).toBeCloseTo(fee, 6);
    expect(trader.cash - cash0).toBeCloseTo(fee, 6);
    expect(sh.basis).toBeCloseTo(p0 + fee / 60, 6);
    expect(o.route!.inTransit).toBeCloseTo(60);
    expect(o.route!.shippedToday).toBeCloseTo(60);
    expect(o.route!.shippedTotal).toBeCloseTo(60);
    expect(heldAtOrigin(s, o)).toBe(0);
    expect(s.treasury.goods[0][G.bread]).toBe(0);
    expect(s.treasury.purse - purse0 - (s.treasury.minted - minted0)).toBeCloseTo(-(60 * p0 + fee), 6);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);

    marketDay(s); // on the road
    expect(o.route!.inTransit).toBeCloseTo(60);
    expect(o.route!.waiting).toBe(0);
    // arrives (depart day 0.5 + 2 days): waiting at landed cost, offered at landed × 1.1
    marketDay(s, () => {
      expect(o.route!.waiting).toBeCloseTo(60);
      expect(o.route!.inTransit).toBe(0);
      expect(o.route!.landed).toBeCloseTo(p0 + fee / 60, 6);
      expect(s.treasury.goods[1][G.bread]).toBeCloseTo(60);
    });
    // nobody bought: the ask was there (the curve's Treasury orders show it) and the stock waits
    const st = marketOf(s, 1, G.bread).curve!.state;
    expect(st[0]).toBe(1);
    expect(st[1]).toBeCloseTo((p0 + fee / 60) * 1.1, 3);
    expect(st[2]).toBeCloseTo(60, 3);
    expect(o.route!.waiting).toBeCloseTo(60);

    // a buyer takes 30 at up to ¤10
    const buyer = newPerson(s, 1, 'Buyer');
    buyer.cash = 1000;
    reconcileBank(s);
    marketDay(s, (b) => addBid(bookFor(b, 1, G.bread), buyer.id, 10, 30));
    const p1 = marketOf(s, 1, G.bread).price;
    expect(p1).toBeGreaterThanOrEqual((p0 + fee / 60) * 1.1 - 1e-9);
    expect(o.route!.soldToday).toBeCloseTo(30);
    expect(o.route!.soldTotal).toBeCloseTo(30);
    expect(o.route!.revenue).toBeCloseTo(30 * p1, 6);
    expect(o.route!.waiting).toBeCloseTo(30);
    expect(s.treasury.goods[1][G.bread]).toBeCloseTo(30);
    expect(buyer.pantry[G.bread]).toBeCloseTo(30);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);

    // bread goes stale in store, and the route's count with it; never offered beyond what is held
    spoilage(s);
    expect(o.route!.waiting).toBeCloseTo(s.treasury.goods[1][G.bread], 9);
    s.treasury.goods[1][G.bread] = 10; // e.g. another order sold some
    policyBeginDay(s);
    const books = openBooks(s);
    playerOrders(s, books);
    const asks = bookFor(books, 1, G.bread).asks.filter((a) => a.ref === STATE);
    expect(asks.length).toBe(1);
    expect(asks[0].qty).toBeCloseTo(10);
    expect(o.route!.waiting).toBeCloseTo(10);
  });

  it('keeps what a route holds at its origin from the Treasury’s other sell orders there', () => {
    const { s } = world();
    s.treasury.autoMint = true;
    const id = dispatch(s, { type: 'placeOrder', market: breadIn(0), side: 'buy', price: 4, qty: 100, route: { to: 1, sell: 'cost' } }).id!;
    const o = route(s, id);
    o.filled = 30; // bought 30, none loaded yet (e.g. the Purse could not pay the freight)
    s.treasury.goods[0][G.bread] = 50;
    dispatch(s, { type: 'placeOrder', market: breadIn(0), side: 'sell', price: 1, qty: 100 });
    expect(heldAtOrigin(s, o)).toBeCloseTo(30);
    policyBeginDay(s);
    const books = openBooks(s);
    playerOrders(s, books);
    const asks = bookFor(books, 0, G.bread).asks.filter((a) => a.ref === STATE);
    expect(asks.length).toBe(1);
    expect(asks[0].qty).toBeCloseTo(20);
  });

  it('offers at a fixed floor or for whatever it fetches', () => {
    const { s } = world();
    s.treasury.autoMint = true;
    const a = dispatch(s, { type: 'placeOrder', market: breadIn(0), side: 'buy', price: 4, qty: 5, route: { to: 1, sell: 'fixed', sellPrice: 3.3 } }).id!;
    const b = dispatch(s, { type: 'placeOrder', market: breadIn(0), side: 'buy', price: 4, qty: 5, route: { to: 1, sell: 'market' } }).id!;
    s.treasury.goods[1][G.bread] = 20;
    route(s, a).route!.waiting = 8;
    route(s, b).route!.waiting = 12;
    policyBeginDay(s);
    const books = openBooks(s);
    playerOrders(s, books);
    const asks = bookFor(books, 1, G.bread).asks;
    const fa = asks.find((x) => x.tag === a)!;
    const fb = asks.find((x) => x.tag === b)!;
    expect(fa.limit).toBeCloseTo(3.3);
    expect(fa.qty).toBeCloseTo(8);
    expect(fb.limit).toBeCloseTo(ROUTE_MARKET_FLOOR_SHARE * marketOf(s, 1, G.bread).ema);
    expect(fb.qty).toBeCloseTo(12);
    expect(fa.exempt && fb.exempt).toBe(true);
  });

  it('keeps selling after the buy side ends, and lapses only when nothing is left', () => {
    const { s, bakery } = world();
    s.treasury.autoMint = true;
    bakery.inv[G.bread] = 40;
    const id = dispatch(s, { type: 'placeOrder', market: breadIn(0), side: 'buy', price: 4, qty: 40, once: true, route: { to: 1, sell: 'market' } }).id!;
    const o = route(s, id);
    marketDay(s, (b) => addAsk(bookFor(b, 0, G.bread), FIRM_BASE + bakery.id, 3, 40));
    // a once-order ships everything at once (the buying is over), then pauses
    expect(o.route!.shippedTotal).toBeCloseTo(40);
    expect(o.enabled).toBe(false);
    marketDay(s); // expired, but the goods are on the road: kept
    expect(s.policy.orders.includes(o)).toBe(true);
    const buyer = newPerson(s, 1, 'Buyer');
    buyer.cash = 1000;
    reconcileBank(s);
    marketDay(s, (b) => addBid(bookFor(b, 1, G.bread), buyer.id, 10, 100));
    expect(o.route!.soldTotal).toBeCloseTo(40);
    expect(o.route!.waiting).toBe(0);
    expect(s.policy.orders.includes(o)).toBe(true);
    marketDay(s); // nothing held, carried or waiting: lapses, with a summary
    expect(s.policy.orders.includes(o)).toBe(false);
    expect(s.news.some((n) => /has run its course/.test(n.text))).toBe(true);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('waits at the origin while the Purse cannot pay the freight, then sends it', () => {
    const { s, bakery } = world();
    s.treasury.autoMint = false;
    bakery.inv[G.bread] = 100;
    mint(s, 300 + 1); // the bread (100 at ¤3) and a coin: not the freight
    const id = dispatch(s, { type: 'placeOrder', market: breadIn(0), side: 'buy', price: 3, qty: 100, route: { to: 1, sell: 'cost' } }).id!;
    const o = route(s, id);
    marketDay(s, (b) => addAsk(bookFor(b, 0, G.bread), FIRM_BASE + bakery.id, 3, 100), true);
    expect(o.filled).toBeCloseTo(100);
    expect(s.shipments.length).toBe(0);
    expect(o.route!.shippedTotal).toBe(0);
    expect(heldAtOrigin(s, o)).toBeCloseTo(95); // a day stale
    expect(s.news.some((n) => /waits there: the Purse cannot cover the freight/.test(n.text))).toBe(true);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
    mint(s, 1000);
    marketDay(s);
    expect(s.shipments.length).toBe(1);
    expect(s.shipments[0].order).toBe(id);
    expect(o.route!.shippedTotal).toBeCloseTo(95);
    expect(heldAtOrigin(s, o)).toBe(0);
    expect(s.news.filter((n) => /waits there/.test(n.text)).length).toBe(1);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('cancelling stops the buying; what was bought stays in the Treasury’s stores as ordinary holdings', () => {
    const { s, bakery } = world();
    s.treasury.autoMint = true;
    bakery.inv[G.bread] = 120;
    const id = dispatch(s, { type: 'placeOrder', market: breadIn(0), side: 'buy', price: 4, qty: 60, route: { to: 1, sell: 'cost' } }).id!;
    const o = route(s, id);
    marketDay(s, (b) => addAsk(bookFor(b, 0, G.bread), FIRM_BASE + bakery.id, 3, 60));
    marketDay(s);
    marketDay(s, (b) => addAsk(bookFor(b, 0, G.bread), FIRM_BASE + bakery.id, 3, 60)); // first cargo lands, a second leaves
    expect(o.route!.waiting).toBeCloseTo(60);
    expect(o.route!.inTransit).toBeCloseTo(60);
    const r = dispatch(s, { type: 'cancelOrder', id });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/stays in the Treasury's stores as ordinary holdings: 60 loaves of bread unsold in Kingsbridge, 60 loaves of bread on the road there/);
    expect(o.route!.waiting).toBe(0);
    expect(s.policy.orders.length).toBe(0);
    marketDay(s);
    marketDay(s); // the second cargo lands as ordinary holdings
    expect(s.shipments.length).toBe(0);
    expect(s.treasury.goods[1][G.bread]).toBeCloseTo(120);
  });
});

describe('moving goods with a sale on arrival', () => {
  it('creates an ordinary sell order for the quantity moved, at the requested floor', () => {
    const { s } = world();
    s.treasury.autoMint = true;
    s.treasury.goods[0][G.tools] = 10;
    expect(dispatch(s, { type: 'moveGoods', from: 0, to: 1, good: G.tools, qty: 4, sell: { mode: 'fixed' } }).ok).toBe(false);
    expect(dispatch(s, { type: 'moveGoods', from: 0, to: 1, good: G.tools, qty: 4, sell: { mode: 'cost', margin: 20 } }).ok).toBe(false);
    expect(s.shipments.length).toBe(0);
    expect(s.treasury.goods[0][G.tools]).toBe(10);

    const purse0 = s.treasury.purse - s.treasury.minted;
    const r = dispatch(s, { type: 'moveGoods', from: 0, to: 1, good: G.tools, qty: 4, sell: { mode: 'cost', margin: 0.2 } });
    expect(r.ok, r.message).toBe(true);
    expect(r.message).not.toMatch(FORBIDDEN);
    const fee = -(s.treasury.purse - s.treasury.minted - purse0);
    const o = s.policy.orders[0];
    expect(o.market).toEqual({ kind: 'good', town: 1, good: G.tools });
    expect(o.side).toBe('sell');
    expect(o.total).toBeCloseTo(4);
    expect(o.qty).toBeCloseTo(4);
    expect(o.route).toBeNull();
    expect(o.price).toBeCloseTo((marketOf(s, 0, G.tools).ema + fee / 4) * 1.2, 6);
    expect(r.message).toMatch(/will offer them there at landed cost plus 20%/);

    const r2 = dispatch(s, { type: 'moveGoods', from: 0, to: 1, good: G.tools, qty: 3, sell: { mode: 'fixed', price: 25 } });
    expect(r2.ok).toBe(true);
    expect(s.policy.orders[1].price).toBe(25);
    const r3 = dispatch(s, { type: 'moveGoods', from: 0, to: 1, good: G.tools, qty: 3, sell: { mode: 'market' } });
    expect(r3.ok).toBe(true);
    expect(s.policy.orders[2].price).toBeCloseTo(ROUTE_MARKET_FLOOR_SHARE * marketOf(s, 1, G.tools).ema);
    // nothing is offered before the goods arrive
    policyBeginDay(s);
    const books = openBooks(s);
    playerOrders(s, books);
    expect(bookFor(books, 1, G.tools).asks.length).toBe(0);
    // a plain move still works as before
    s.treasury.goods[0][G.iron] = 5;
    const r4 = dispatch(s, { type: 'moveGoods', from: 0, to: 1, good: G.iron, qty: 5 });
    expect(r4.ok).toBe(true);
    expect(s.policy.orders.length).toBe(3);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });
});

describe('supply routes — saving and loading', () => {
  it('a game saved mid-route continues exactly as the original', () => {
    const g = Game.create({ seed: 2, warmup: false });
    g.dispatch({ type: 'setEvents', value: false });
    g.dispatch({ type: 'setAutoMint', value: true });
    g.step(15);
    const s = g.s;
    const farm = s.towns.find((t) => t.kind === 'farm')!.id;
    const harbor = s.towns.find((t) => t.kind === 'harbor')!.id;
    const pf = marketOf(s, farm, G.bread).ema;
    const r = g.dispatch({ type: 'placeOrder', market: breadIn(farm), side: 'buy', price: 1.3 * pf, qty: 60, route: { to: harbor, sell: 'market' } });
    expect(r.ok, r.message).toBe(true);
    g.step(3);
    const o = s.policy.orders.find((x) => x.id === r.id)!;
    expect(o.route!.shippedTotal).toBeGreaterThan(0);
    expect(s.shipments.some((x) => x.order === r.id) || o.route!.waiting > 0).toBe(true);
    const json = g.save();
    const copy = Game.load(json);
    copy.step(12);
    g.step(12);
    expect(copy.save()).toBe(g.save());
    expect(Math.abs(checkLedger(copy.s))).toBeLessThan(1e-6 * Math.max(1, s.bank.reserves));
    expect(copy.s.policy.orders.find((x) => x.id === r.id)!.route!.soldTotal).toBeGreaterThan(0);

    // A save from before routes (no Order.route, no Shipment.order) loads with the defaults.
    const raw = JSON.parse(json);
    for (const po of raw.policy.orders) delete po.route;
    for (const sh of raw.shipments) delete sh.order;
    const old = deserialize(JSON.stringify(raw));
    expect(old.policy.orders.every((x) => x.route === null)).toBe(true);
    expect(old.shipments.every((x) => x.order === -1)).toBe(true);
    // A damaged route record is repaired or dropped
    const raw2 = JSON.parse(json);
    raw2.policy.orders[0].route.waiting = null;
    const fixed = deserialize(JSON.stringify(raw2));
    expect(fixed.policy.orders[0].route!.waiting).toBe(0);
    raw2.policy.orders[0].route.to = 99;
    expect(deserialize(JSON.stringify(raw2)).policy.orders[0].route).toBeNull();
    expect(serialize(old).length).toBeGreaterThan(0);
  });
});
