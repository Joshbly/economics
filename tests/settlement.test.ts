import { describe, expect, it } from 'vitest';
import { newFirm, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger, deposits, mint, reconcileBank } from '../src/sim/ledger';
import { addAsk, addBid, bookFor, clearAll, expectedGross, expectedNet, inventoryOf, marketOf, openBooks } from '../src/sim/market/markets';
import { dispatch, playerAfterClear, playerOrders, policyBeginDay } from '../src/sim/policy/player';
import { FIRM_BASE, FOREIGN, GOLD_GOOD, IOU_GOOD, STATE, type MapData, type SimState } from '../src/sim/types';

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

/** One farm town (0) and one harbour town (1), all goods priced at 2. */
function tinyState(): SimState {
  const s = newSimState(1, tinyMap());
  s.towns.push(newTown(0, 'Millbrook', 'farm', 0, 0, 3));
  s.towns.push(newTown(1, 'Saltmere', 'harbor', 1, 1, 3));
  s.treasury = newTreasury(2);
  for (let t = 0; t < 2; t++) for (let g = 0; g < N_GOODS; g++) s.markets.push(newMarket(t, g, 2));
  return s;
}

describe('settlement of a goods market', () => {
  it('person buys bread from a firm and the Treasury under a 20% buyer-side levy', () => {
    const s = tinyState();
    const p = newPerson(s, 0, 'Ann');
    p.cash = 100;
    const owner = newPerson(s, 0, 'Owner');
    const f = newFirm(s, 'bakery', 0, -1, owner.id, 'Millbrook Bakery');
    f.inv[G.bread] = 50;
    f.cash = 10;
    s.treasury.goods[0][G.bread] = 20;
    reconcileBank(s);
    mint(s, 1000);
    const purse0 = s.treasury.purse;

    const r1 = dispatch(s, { type: 'addLevy', levy: { label: '', enabled: true, dir: 1, base: 'sale', unit: 'pct', rate: 0.2, payer: 'buyer', threshold: 0, good: G.bread, town: 0, toTown: -1, sector: 'any', group: 'all', buildingKind: 'any', until: -1 } });
    expect(r1.ok).toBe(true);
    expect(r1.message).not.toMatch(/tax|subsid/i);
    const r2 = dispatch(s, { type: 'placeOrder', market: { kind: 'good', town: 0, good: G.bread }, side: 'sell', price: 1.5, qty: 10 });
    expect(r2.ok).toBe(true);

    policyBeginDay(s);
    const books = openBooks(s);
    const book = bookFor(books, 0, G.bread);
    expect(book.wedge.bPct).toBeCloseTo(0.2);
    const bid = addBid(book, p.id, 3.0, 30); // gross limit 3.0 → base 2.5
    const ask = addAsk(book, FIRM_BASE + f.id, 1.8, 50);
    playerOrders(s, books);
    clearAll(s, books);
    playerAfterClear(s, books);

    // Max volume 30 at 1.8 and 2.5 with excess supply → lowest → 1.8
    const m = marketOf(s, 0, G.bread);
    expect(m.price).toBeCloseTo(1.8);
    expect(m.gross).toBeCloseTo(2.16);
    expect(m.volume).toBeCloseTo(30);
    expect(m.surplus).toBeCloseTo(30);
    expect(bid.filled).toBeCloseTo(30);
    expect(bid.paid).toBeCloseTo(64.8);
    expect(ask.filled).toBeCloseTo(20); // the Treasury's cheaper 10 went first
    expect(ask.paid).toBeCloseTo(36);

    expect(p.cash).toBeCloseTo(100 - 64.8);
    expect(p.pantry[G.bread]).toBeCloseTo(30);
    expect(p.spent).toBeCloseTo(64.8);
    expect(f.inv[G.bread]).toBeCloseTo(30);
    expect(f.cash).toBeCloseTo(46);
    expect(f.revenue).toBeCloseTo(36);
    expect(f.soldToday).toBeCloseTo(20);
    expect(s.treasury.goods[0][G.bread]).toBeCloseTo(10);
    // Purse: 10 loaves × 1.8 base + levy 0.36 × 30
    expect(s.treasury.purse - purse0).toBeCloseTo(18 + 10.8);
    expect(s.treasury.flows.levy).toBeCloseTo(10.8);

    const levy = s.policy.levies[0];
    expect(levy.today).toBeCloseTo(10.8);
    expect(levy.month).toBeCloseTo(10.8);
    expect(levy.total).toBeCloseTo(10.8);
    expect(s.stats.acc.levy_take).toBeCloseTo(10.8);
    expect(s.stats.acc['vol_' + G.bread]).toBeCloseTo(30);
    expect(s.stats.acc['cons_' + G.bread]).toBeCloseTo(30);
    expect(s.stats.acc.consval).toBeCloseTo(64.8);

    const po = s.policy.orders[0];
    expect(po.filledToday).toBeCloseTo(10);
    expect(po.filled).toBeCloseTo(10);
    expect(po.value).toBeCloseTo(-18);
    expect(m.curve).not.toBeNull();
    expect(m.curve!.state).toEqual([1, 1.5, 10]);
    expect(m.hist.length).toBe(1);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('never delivers goods a seller does not hold, never charges more than a buyer has', () => {
    const s = tinyState();
    const rich = newPerson(s, 0, 'Rich');
    rich.cash = 1000;
    const poor = newPerson(s, 0, 'Poor');
    poor.cash = 3;
    const f = newFirm(s, 'bakery', 0, -1, rich.id, 'Bakery');
    f.inv[G.bread] = 12; // offers 40 but holds 12
    reconcileBank(s);
    const books = openBooks(s);
    const book = bookFor(books, 0, G.bread);
    const bRich = addBid(book, rich.id, 3, 20);
    const bPoor = addBid(book, poor.id, 3, 20);
    const a = addAsk(book, FIRM_BASE + f.id, 1, 40);
    clearAll(s, books);
    const m = marketOf(s, 0, G.bread);
    // demand 40 ≥ supply 40 at candidate prices; zero imbalance, reference 2 → price 2
    expect(m.price).toBeCloseTo(2);
    expect(poor.cash).toBeGreaterThanOrEqual(-1e-12);
    expect(bPoor.filled).toBeLessThanOrEqual(1.5 + 1e-9); // 3 / 2
    expect(a.filled).toBeCloseTo(bRich.filled + bPoor.filled);
    expect(f.inv[G.bread]).toBeGreaterThanOrEqual(0);
    expect(a.filled).toBeLessThanOrEqual(12 + 1e-9);
    expect(rich.pantry[G.bread] + poor.pantry[G.bread] + f.inv[G.bread]).toBeCloseTo(12);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a buyer-side give lets a household buy with only the gross price in hand', () => {
    const s = tinyState();
    const p = newPerson(s, 0, 'Ann');
    p.cash = 7.5; // exactly 10 loaves at gross 0.75 × 1.0
    const o = newPerson(s, 0, 'Owner');
    const f = newFirm(s, 'bakery', 0, -1, o.id, 'Bakery');
    f.inv[G.bread] = 100;
    reconcileBank(s);
    mint(s, 100);
    dispatch(s, { type: 'addLevy', levy: { label: '', enabled: true, dir: -1, base: 'sale', unit: 'pct', rate: 0.25, payer: 'buyer', threshold: 0, good: G.bread, town: -1, toTown: -1, sector: 'any', group: 'all', buildingKind: 'any', until: -1 } });
    policyBeginDay(s);
    s.markets[G.bread].ema = 1;
    const books = openBooks(s);
    const book = bookFor(books, 0, G.bread);
    expect(book.wedge.bPct).toBeCloseTo(-0.25);
    expect(expectedGross(s, 0, G.bread)).toBeCloseTo(0.75);
    const bid = addBid(book, p.id, 0.75, 10); // base 1.0
    addAsk(book, FIRM_BASE + f.id, 1.0, 100);
    clearAll(s, books);
    expect(marketOf(s, 0, G.bread).price).toBeCloseTo(1);
    expect(bid.filled).toBeCloseTo(10);
    expect(p.cash).toBeCloseTo(0);
    expect(f.cash).toBeCloseTo(10);
    expect(s.treasury.purse).toBeCloseTo(97.5);
    expect(s.policy.levies[0].today).toBeCloseTo(-2.5);
    expect(s.stats.acc.levy_give).toBeCloseTo(2.5);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('seller-side levies reduce the net received and are attributed per rule', () => {
    const s = tinyState();
    const p = newPerson(s, 0, 'Ann');
    p.cash = 100;
    const o = newPerson(s, 0, 'Owner');
    const f = newFirm(s, 'farm', 0, -1, o.id, 'Farm');
    f.inv[G.grain] = 10;
    reconcileBank(s);
    const lv = { label: '', enabled: true, dir: 1 as const, base: 'sale' as const, unit: 'perUnit' as const, rate: 0.5, payer: 'seller' as const, threshold: 0, good: G.grain, town: 0, toTown: -1, sector: 'any' as const, group: 'all' as const, buildingKind: 'any' as const, until: -1 };
    dispatch(s, { type: 'addLevy', levy: lv });
    dispatch(s, { type: 'addLevy', levy: { ...lv, unit: 'pct', rate: 0.1 } });
    policyBeginDay(s);
    const books = openBooks(s);
    const book = bookFor(books, 0, G.grain);
    addBid(book, p.id, 4, 10);
    const ask = addAsk(book, FIRM_BASE + f.id, 1, 10); // base = (1 + 0.5)/0.9
    clearAll(s, books);
    const price = marketOf(s, 0, G.grain).price;
    expect(ask.filled).toBeCloseTo(10);
    expect(ask.paid).toBeCloseTo(10 * (price * 0.9 - 0.5));
    expect(expectedNet(s, 0, G.grain)).toBeCloseTo(Math.max(1e-6, marketOf(s, 0, G.grain).ema * 0.9 - 0.5));
    const [a, b] = s.policy.levies;
    expect(a.today).toBeCloseTo(5);
    expect(b.today).toBeCloseTo(0.1 * price * 10);
    expect(s.treasury.purse).toBeCloseTo(a.today + b.today);
    expect(f.soldToday).toBeCloseTo(10); // grain is the farm's own output
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('port trades with FOREIGN move goods to/from the outside world and settle extras', () => {
    const s = tinyState();
    const p = newPerson(s, 1, 'Sailor');
    p.cash = 100;
    reconcileBank(s);
    s.foreign.coin = 0;
    dispatch(s, { type: 'addLevy', levy: { label: '', enabled: true, dir: 1, base: 'import', unit: 'pct', rate: 0.25, payer: 'buyer', threshold: 0, good: G.iron, town: -1, toTown: -1, sector: 'any', group: 'all', buildingKind: 'any', until: -1 } });
    policyBeginDay(s);
    const books = openBooks(s);
    const book = bookFor(books, 1, G.iron);
    addBid(book, p.id, 10, 5);
    const imp = addAsk(book, FOREIGN, 4, 5, { xPct: 0.2 }); // base 5
    clearAll(s, books);
    const price = marketOf(s, 1, G.iron).price;
    expect(imp.filled).toBeCloseTo(5);
    expect(p.pantry[G.iron]).toBeCloseTo(5);
    expect(s.stats.acc['imp_' + G.iron]).toBeCloseTo(5);
    expect(s.foreign.importsQty[G.iron]).toBeCloseTo(5);
    // FOREIGN receives base, pays 20 % of base to the Treasury
    expect(s.foreign.coin).toBeCloseTo(price * 5 * 0.8);
    expect(s.treasury.purse).toBeCloseTo(price * 5 * 0.2);
    expect(s.policy.levies[0].today).toBeCloseTo(price * 5 * 0.2);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('Treasury buy orders are capped by the Purse and deliver into Treasury holdings', () => {
    const s = tinyState();
    const o = newPerson(s, 0, 'Owner');
    const f = newFirm(s, 'toolworks', 0, -1, o.id, 'Toolworks');
    f.inv[G.tools] = 100;
    reconcileBank(s);
    mint(s, 30);
    dispatch(s, { type: 'placeOrder', market: { kind: 'good', town: 0, good: G.tools }, side: 'buy', price: 10, qty: 50 });
    policyBeginDay(s);
    const books = openBooks(s);
    addAsk(bookFor(books, 0, G.tools), FIRM_BASE + f.id, 1, 100);
    playerOrders(s, books);
    clearAll(s, books);
    playerAfterClear(s, books);
    // Purse ¤30 at limit 10 → at most 3 units submitted; clears at the lowest (excess supply) → 1 each
    const po = s.policy.orders[0];
    expect(po.filledToday).toBeCloseTo(3);
    expect(s.treasury.goods[0][G.tools]).toBeCloseTo(3);
    expect(s.treasury.purse).toBeGreaterThanOrEqual(-1e-9);
    expect(s.stats.acc.gov_goods).toBeCloseTo(po.value);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('traders sell from their stock in other towns; inventoryOf routes holdings', () => {
    const s = tinyState();
    const o = newPerson(s, 0, 'Owner');
    const tr = newFirm(s, 'trader', 0, -1, o.id, 'Trading House');
    tr.trade!.stock[1][G.grain] = 7;
    expect(inventoryOf(s, FIRM_BASE + tr.id, 1)).toBe(tr.trade!.stock[1]);
    expect(inventoryOf(s, FIRM_BASE + tr.id, 0)).toBe(tr.inv);
    expect(inventoryOf(s, STATE, 1)).toBe(s.treasury.goods[1]);
    expect(inventoryOf(s, FOREIGN, 1)[G.grain]).toBeGreaterThan(1e9);
    const buyer = newPerson(s, 1, 'Buyer');
    buyer.cash = 50;
    reconcileBank(s);
    const books = openBooks(s);
    addBid(bookFor(books, 1, G.grain), buyer.id, 5, 10);
    const a = addAsk(bookFor(books, 1, G.grain), FIRM_BASE + tr.id, 1, 10);
    clearAll(s, books);
    expect(a.filled).toBeCloseTo(7);
    expect(tr.trade!.stock[1][G.grain]).toBeCloseTo(0);
    expect(tr.revenue).toBeCloseTo(a.paid);
    expect(tr.soldToday).toBe(0); // not its own output
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('reuses books and orders from day to day without leaking state', () => {
    const s = tinyState();
    const b1 = openBooks(s);
    const o1 = addBid(bookFor(b1, 0, G.fish), 1, 1, 1);
    const b2 = openBooks(s);
    expect(b2).toBe(b1);
    expect(bookFor(b2, 0, G.fish).bids.length).toBe(0);
    const o2 = addBid(bookFor(b2, 0, G.fish), 2, 3, 4);
    expect(o2).toBe(o1); // recycled
    expect(o2.ref).toBe(2);
    expect(o2.filled).toBe(0);
  });
});

describe('settlement of the IOU and gold markets', () => {
  it('Treasury IOU sales are issuance; buyers hold IOUs; ledger stays balanced', () => {
    const s = tinyState();
    const p = newPerson(s, 0, 'Saver');
    p.cash = 1000;
    reconcileBank(s);
    const r = dispatch(s, { type: 'placeOrder', market: { kind: 'iou' }, side: 'sell', price: 90, qty: 10 });
    expect(r.ok).toBe(true);
    policyBeginDay(s);
    const books = openBooks(s);
    const bid = addBid(books.iou, p.id, 100, 5);
    const bankBid = addBid(books.iou, -2, 95, 3);
    playerOrders(s, books);
    clearAll(s, books);
    playerAfterClear(s, books);
    const m = marketOf(s, -1, IOU_GOOD);
    expect(m.price).toBeCloseTo(90); // excess supply → lowest candidate
    expect(bid.filled).toBeCloseTo(5);
    expect(bankBid.filled).toBeCloseTo(3);
    expect(p.iou).toBeCloseTo(5);
    expect(p.cash).toBeCloseTo(550);
    expect(s.bank.iou).toBeCloseTo(3);
    expect(s.bank.iouBook).toBeCloseTo(270);
    expect(s.treasury.iouOutstanding).toBeCloseTo(8);
    expect(s.treasury.purse).toBeCloseTo(720);
    expect(s.stats.acc.iou_issued).toBeCloseTo(8);
    expect(s.policy.orders[0].filled).toBeCloseTo(8);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a bank IOU sale below book cost realises the loss in equity and keeps the identity', () => {
    const s = tinyState();
    const p = newPerson(s, 0, 'Saver');
    p.cash = 1000;
    s.bank.iou = 10;
    s.bank.iouBook = 1000; // bought at 100
    s.treasury.iouOutstanding = 10;
    s.bank.reserves = 500;
    reconcileBank(s);
    const eq0 = s.bank.equity;
    const books = openBooks(s);
    addBid(books.iou, p.id, 80, 10);
    const ask = addAsk(books.iou, -2, 70, 10);
    clearAll(s, books);
    const price = marketOf(s, -1, IOU_GOOD).price;
    expect(price).toBeCloseTo(80); // zero imbalance on [70, 80], reference 100 → 80
    expect(ask.filled).toBeCloseTo(10);
    expect(s.bank.iou).toBeCloseTo(0);
    expect(s.bank.iouBook).toBeCloseTo(0);
    expect(s.bank.equity - eq0).toBeCloseTo(-200);
    expect(p.iou).toBeCloseTo(10);
    expect(s.treasury.iouOutstanding).toBeCloseTo(10);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('the Treasury retiring IOUs from the bank reduces the outstanding stock', () => {
    const s = tinyState();
    s.bank.iou = 10;
    s.bank.iouBook = 900;
    s.treasury.iouOutstanding = 10;
    reconcileBank(s);
    mint(s, 5000);
    dispatch(s, { type: 'placeOrder', market: { kind: 'iou' }, side: 'buy', price: 120, qty: 4 });
    policyBeginDay(s);
    const books = openBooks(s);
    addAsk(books.iou, -2, 110, 10);
    playerOrders(s, books);
    clearAll(s, books);
    const price = marketOf(s, -1, IOU_GOOD).price;
    expect(price).toBeCloseTo(110);
    expect(s.treasury.iouOutstanding).toBeCloseTo(6);
    expect(s.bank.iou).toBeCloseTo(6);
    expect(s.bank.iouBook).toBeCloseTo(540);
    expect(s.bank.reserves).toBeCloseTo(440);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('gold moves between people, the Treasury and the outside world', () => {
    const s = tinyState();
    const p = newPerson(s, 0, 'Hoarder');
    p.cash = 500;
    s.foreign.coin = 0;
    s.treasury.gold = 3;
    reconcileBank(s);
    dispatch(s, { type: 'placeOrder', market: { kind: 'gold' }, side: 'sell', price: 90, qty: 10 });
    policyBeginDay(s);
    const books = openBooks(s);
    addBid(books.gold, p.id, 110, 4);
    addAsk(books.gold, FOREIGN, 100, 10);
    playerOrders(s, books);
    clearAll(s, books);
    const price = marketOf(s, -1, GOLD_GOOD).price;
    expect(p.gold).toBeCloseTo(4);
    expect(s.treasury.gold).toBeCloseTo(0); // sold its 3 oz first (cheapest ask)
    expect(p.cash).toBeCloseTo(500 - 4 * price);
    expect(s.foreign.coin).toBeCloseTo(price);
    expect(deposits(s)).toBeCloseTo(500 - 3 * price);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------------------
// Directional market experiments (DESIGN §9, at the level of one market):
// 40 households post elastic bid ladders around the expected gross price,
// 5 producers post an upward-sloping ask ladder (restocked daily).
// ---------------------------------------------------------------------------
function runMarket(days: number, setup: (s: SimState) => void): { price: number; gross: number; volume: number; shortage: number; s: SimState } {
  const s = tinyState();
  const people = Array.from({ length: 40 }, (_, i) => newPerson(s, 0, 'H' + i));
  const owner = newPerson(s, 0, 'Owner');
  const firms = Array.from({ length: 5 }, (_, i) => newFirm(s, 'toolworks', 0, -1, owner.id, 'F' + i));
  for (const p of people) p.cash = 500;
  reconcileBank(s);
  mint(s, 1e6);
  s.markets[G.tools].ema = 2;
  setup(s);
  let acc = { price: 0, gross: 0, volume: 0, shortage: 0 };
  const rungs = [2.5, 1.6, 1.25, 1.1, 1.0, 0.9, 0.8, 0.65];
  for (let d = 0; d < days; d++) {
    policyBeginDay(s);
    const books = openBooks(s);
    const book = bookFor(books, 0, G.tools);
    const pe = expectedGross(s, 0, G.tools);
    for (const p of people) {
      p.pantry[G.tools] = 0; // consumed
      let prev = 0;
      for (const m of rungs) {
        const cum = (2 / pe) * Math.pow(1 / m, 1.0); // a ¤2/day budget: unit-elastic demand around the expected gross price
        if (cum > prev) addBid(book, p.id, pe * m, cum - prev);
        prev = cum;
      }
    }
    firms.forEach((f, i) => {
      f.inv[G.tools] = 100;
      for (let k = 0; k < 5; k++) addAsk(book, FIRM_BASE + f.id, 1 + 0.25 * k + 0.05 * i, 2);
    });
    playerOrders(s, books);
    clearAll(s, books);
    playerAfterClear(s, books);
    const m = marketOf(s, 0, G.tools);
    if (d >= days - 10) {
      acc.price += m.price / 10;
      acc.gross += m.gross / 10;
      acc.volume += m.volume / 10;
      acc.shortage += m.shortage / 10;
    }
    s.day++;
  }
  expect(Math.abs(checkLedger(s))).toBeLessThan(1e-5);
  return { ...acc, s };
}

describe('directional market experiments', () => {
  const base = runMarket(60, () => {});

  it('baseline settles to a stable interior price', () => {
    expect(base.price).toBeGreaterThan(1);
    expect(base.price).toBeLessThan(3);
    expect(base.volume).toBeGreaterThan(10);
  });

  it('a big Treasury buy order raises the price; a big sale below market lowers it', () => {
    const buy = runMarket(60, (s) => {
      dispatch(s, { type: 'placeOrder', market: { kind: 'good', town: 0, good: G.tools }, side: 'buy', price: 5, qty: 20 });
    });
    expect(buy.price).toBeGreaterThan(base.price * 1.1);
    const sell = runMarket(60, (s) => {
      s.treasury.goods[0][G.tools] = 1e5;
      dispatch(s, { type: 'placeOrder', market: { kind: 'good', town: 0, good: G.tools }, side: 'sell', price: 0.8, qty: 30 });
    });
    expect(sell.price).toBeLessThan(base.price * 0.9);
  });

  it('a 30 % buyer-side levy raises what buyers pay, lowers what sellers get, and cuts volume', () => {
    const lv = runMarket(60, (s) => {
      dispatch(s, { type: 'addLevy', levy: { label: '', enabled: true, dir: 1, base: 'sale', unit: 'pct', rate: 0.3, payer: 'buyer', threshold: 0, good: G.tools, town: -1, toTown: -1, sector: 'any', group: 'all', buildingKind: 'any', until: -1 } });
    });
    expect(lv.gross).toBeGreaterThan(base.gross);
    expect(lv.price).toBeLessThan(base.price);
    expect(lv.volume).toBeLessThan(base.volume);
    expect(lv.s.policy.levies[0].total).toBeGreaterThan(0);
  });

  it('a price ceiling well below the market creates a persistent shortage', () => {
    const cap = runMarket(60, (s) => {
      dispatch(s, { type: 'addLimit', limit: { label: '', enabled: true, kind: 'priceMax', good: G.tools, town: 0, toTown: -1, value: base.price * 0.7, until: -1 } });
    });
    expect(cap.price).toBeCloseTo(base.price * 0.7, 5);
    expect(cap.volume).toBeLessThan(base.volume);
    expect(cap.shortage).toBeGreaterThan(5);
    expect(cap.s.policy.limits[0].binding).toBeGreaterThan(20);
  });
});
