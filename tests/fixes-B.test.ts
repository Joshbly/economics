// Final bug-fix pass, batch B: port levies that match their labels, capped export payments,
// estate levies collected in kind, and the between-day stats carry after loading a save.
import { beforeEach, describe, expect, it } from 'vitest';
import { estateValue, killPerson } from '../src/sim/agents/demography';
import { foreignOrders } from '../src/sim/agents/foreign';
import { EXPORT_DISCOUNT, IMPORT_MARKUP } from '../src/sim/config';
import { newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { Game } from '../src/sim/game';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger, reconcileBank } from '../src/sim/ledger';
import { askBase, bidBase } from '../src/sim/market/auction';
import { addAsk, addBid, bookFor, clearAll, openBooks, type Books } from '../src/sim/market/markets';
import { FOREIGN, type Levy, type MapData, type SimState } from '../src/sim/types';
import { addHouse, addPerson, reconcile, tinyWorld } from './households.fixture';

function levy(over: Partial<Levy>): Levy {
  return { id: 70, label: 't', enabled: true, dir: 1, base: 'import', unit: 'pct', rate: 0.25, payer: 'buyer', threshold: 0, good: -1, town: -1, toTown: -1, sector: 'any', group: 'all', buildingKind: 'any', created: 0, until: -1, today: 0, month: 0, lastMonth: 0, total: 0, ...over };
}

// ---- a two-town world with a port (as in foreign.test.ts) ----
const PRICES = [2.6, 3.0, 2.6, 2.6, 2.6, 3.2, 13, 20, 4, 2.8, 22];
let s: SimState;
function portWorld(): SimState {
  const n = 16;
  const z = () => new Array(n).fill(0);
  const map: MapData = { w: 4, h: 4, terrain: new Array(n).fill(3), elev: z(), fert: z(), deposit: z(), river: z(), road: z(), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
  const w = newSimState(9, map);
  w.towns.push(newTown(0, 'Kingsbridge', 'capital', 1, 1, 2));
  w.towns.push(newTown(1, 'Saltmere', 'harbor', 3, 3, 2));
  w.treasury = newTreasury(2);
  for (let t = 0; t < 2; t++) for (let g = 0; g < N_GOODS; g++) w.markets.push(newMarket(t, g, PRICES[g]));
  for (const t of w.towns) {
    t.avgWage = 10;
    t.employed = 100;
  }
  const fo = w.foreign;
  for (const g of [G.grain, G.coal, G.iron, G.tools]) {
    fo.world[g] = fo.world0[g] = PRICES[g] / 100;
    fo.shipCap[g] = 20;
  }
  fo.coin = 20_000;
  w.goldMarket.ema = 100;
  w.bank.reserves = 1e5;
  reconcileBank(w);
  return w;
}

/** Lowest foreign ask base (what a buyer pays) and its limit (what the ships receive). */
function bestAsk(books: Books, g: number): { base: number; limit: number } {
  const b = bookFor(books, 1, g);
  let best = { base: Infinity, limit: 0 };
  for (const o of b.asks) if (o.ref === FOREIGN && askBase(o, b.wedge) < best.base) best = { base: askBase(o, b.wedge), limit: o.limit };
  return best;
}
/** Highest foreign bid base (what a seller receives) and its limit (what the ships pay). */
function bestBid(books: Books, g: number): { base: number; limit: number } {
  const b = bookFor(books, 1, g);
  let best = { base: -Infinity, limit: 0 };
  for (const o of b.bids) if (o.ref === FOREIGN && bidBase(o, b.wedge) > best.base) best = { base: bidBase(o, b.wedge), limit: o.limit };
  return best;
}

describe('port levies charge the named payer the stated share', () => {
  beforeEach(() => {
    s = portWorld();
  });

  it('a rule on imports makes buyers pay the ships’ price × (1 + r), linearly', () => {
    for (const r of [0.25, 0.5, 0.9, 2]) {
      s.policy.levies = [levy({ good: G.iron, rate: r })];
      const books = openBooks(s);
      foreignOrders(s, books);
      const a = bestAsk(books, G.iron);
      expect(a.limit).toBeCloseTo(13 * (1 + IMPORT_MARKUP), 8);
      expect(a.base / a.limit).toBeCloseTo(1 + r, 8); // was 1/(1 − r): ×2 at 50 %, ×10 at 90 %
    }
  });

  it('a 90 % rule on imports collects 90 % of what the ships receive', () => {
    s.policy.levies = [levy({ good: G.iron, rate: 0.9 })];
    const books = openBooks(s);
    foreignOrders(s, books);
    const buyer = newPerson(s, 1, 'Smith');
    buyer.cash = 1000;
    reconcileBank(s);
    addBid(bookFor(books, 1, G.iron), buyer.id, 40, 5);
    const coin0 = s.foreign.coin;
    const purse0 = s.treasury.purse;
    clearAll(s, books);
    const lim = 13 * (1 + IMPORT_MARKUP);
    expect(buyer.pantry[G.iron]).toBeCloseTo(5, 8);
    expect(s.foreign.coin - coin0).toBeCloseTo(lim * 5, 6);
    expect(s.treasury.purse - purse0).toBeCloseTo(0.9 * lim * 5, 6);
    expect(s.policy.levies[0].today).toBeCloseTo(0.9 * lim * 5, 6);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a rule on exports leaves sellers the ships’ price × (1 − r), at least 5 %', () => {
    for (const [r, keep] of [[0.5, 0.5], [0.9, 0.1], [5, 0.05]]) {
      s.policy.levies = [levy({ base: 'export', payer: 'seller', good: G.iron, rate: r })];
      const books = openBooks(s);
      foreignOrders(s, books);
      const b = bestBid(books, G.iron);
      expect(b.limit).toBeCloseTo(13 * (1 - EXPORT_DISCOUNT), 8);
      expect(b.base / b.limit).toBeCloseTo(keep, 8); // was 1/(1 + r): 500 % still kept 51 %
    }
  });

  it('a 50 % rule on exports: the seller nets half, the Treasury the other half', () => {
    s.policy.levies = [levy({ base: 'export', payer: 'seller', good: G.iron, rate: 0.5 })];
    const books = openBooks(s);
    foreignOrders(s, books);
    const seller = newPerson(s, 1, 'Miner');
    seller.pantry[G.iron] = 3;
    addAsk(bookFor(books, 1, G.iron), seller.id, 0.5, 3);
    const purse0 = s.treasury.purse;
    clearAll(s, books);
    const lim = 13 * (1 - EXPORT_DISCOUNT);
    expect(seller.pantry[G.iron]).toBeCloseTo(0, 8);
    expect(seller.cash).toBeCloseTo(0.5 * lim * 3, 6);
    expect(s.treasury.purse - purse0).toBeCloseTo(0.5 * lim * 3, 6);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });
});

describe('paying out on exports is capped at break-even, never a cliff', () => {
  beforeEach(() => {
    s = portWorld();
  });

  it('small payments pass in full; large ones stop just below the landed import price', () => {
    const importBase = 13 * (1 + IMPORT_MARKUP);
    const lim = 13 * (1 - EXPORT_DISCOUNT);
    for (const r of [0.1, 0.3, 0.5, 2]) {
      s.policy.levies = [levy({ dir: -1, base: 'export', payer: 'seller', good: G.iron, rate: r })];
      const books = openBooks(s);
      foreignOrders(s, books);
      const b = bestBid(books, G.iron);
      expect(b.limit).toBeGreaterThan(0); // exports never switch off (used to at ~27 %)
      expect(b.base).toBeLessThan(bestAsk(books, G.iron).base * 0.999); // no round trip with the ships
      expect(b.base).toBeCloseTo(Math.min(lim * (1 + r), importBase * 0.998), 6);
    }
  });

  it('a capped payment moves only the capped amount, no phantom flows', () => {
    s.policy.levies = [levy({ dir: -1, base: 'export', payer: 'seller', good: G.iron, rate: 1 })];
    s.treasury.autoMint = true; // (the test Purse is empty)
    const books = openBooks(s);
    foreignOrders(s, books);
    const seller = newPerson(s, 1, 'Miner');
    seller.pantry[G.iron] = 2;
    addAsk(bookFor(books, 1, G.iron), seller.id, 0.5, 2);
    const coin0 = s.foreign.coin;
    const minted0 = s.treasury.minted;
    clearAll(s, books);
    const cap = 13 * (1 + IMPORT_MARKUP) * 0.998;
    const lim = 13 * (1 - EXPORT_DISCOUNT);
    expect(seller.cash).toBeCloseTo(cap * 2, 6);
    expect(coin0 - s.foreign.coin).toBeCloseTo(lim * 2, 6);
    expect(s.treasury.minted - minted0).toBeCloseTo((cap - lim) * 2, 6);
    expect(s.policy.levies[0].today).toBeCloseTo(-(cap - lim) * 2, 6);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a payment on imports that undercuts the ships’ bid still removes that bid', () => {
    s.policy.levies = [levy({ dir: -1, good: G.iron, rate: 0.5 })];
    const books = openBooks(s);
    foreignOrders(s, books);
    expect(bookFor(books, 1, G.iron).bids.filter((o) => o.ref === FOREIGN).length).toBe(0);
  });
});

describe('estate levies are collected in kind when the coin runs short', () => {
  function setup(rate: number) {
    const w = tinyWorld();
    w.iouMarket.ema = 90;
    w.goldMarket.ema = 110;
    const dead = addPerson(w, 0, 100, { iou: 2, gold: 1 });
    const heir = addPerson(w, 0, 50);
    const h = addHouse(w, 0, 5, 5, 1, dead.id);
    h.cost = 1000;
    dead.houses.push(h.id);
    w.treasury.iouOutstanding = 2;
    w.policy.levies.push(levy({ base: 'estate', payer: 'receiver', rate }));
    reconcile(w);
    return { w, dead, heir, h, L: w.policy.levies[0] };
  }

  it('coin first, then IOUs (retired) and gold; buildings pass to the heir untouched', () => {
    const { w, dead, heir, h, L } = setup(0.4);
    expect(estateValue(w, dead)).toBeCloseTo(1390, 6); // 40 % → 556 owed
    const purse0 = w.treasury.purse;
    killPerson(w, dead, 'age');
    expect(w.treasury.purse - purse0).toBeCloseTo(100, 6); // all the coin
    expect(w.treasury.iouOutstanding).toBeCloseTo(0, 9); // both IOUs retired
    expect(w.treasury.gold).toBeCloseTo(1, 9);
    expect(L.today).toBeCloseTo(100 + 180 + 110, 6); // was 100 (7 % of the estate)
    expect(heir.iou).toBeCloseTo(0, 9);
    expect(heir.gold).toBeCloseTo(0, 9);
    expect(h.owner).toBe(heir.id); // the rest lapses: the house is not taken
    expect(heir.cash).toBeCloseTo(50, 6);
    expect(Math.abs(checkLedger(w))).toBeLessThan(1e-6);
  });

  it('takes only what is owed: the heir keeps the remaining IOUs and gold', () => {
    const { w, dead, heir, L } = setup(0.1); // owes 139: 100 coin + 39 in IOUs
    killPerson(w, dead, 'age');
    expect(L.today).toBeCloseTo(139, 6);
    expect(w.treasury.iouOutstanding).toBeCloseTo(2 - 39 / 90, 9);
    expect(heir.iou).toBeCloseTo(2 - 39 / 90, 9);
    expect(heir.gold).toBeCloseTo(1, 9);
    expect(w.treasury.gold).toBeCloseTo(0, 9);
    expect(Math.abs(checkLedger(w))).toBeLessThan(1e-6);
  });

  it('an estate with enough coin pays in coin only', () => {
    const { w, dead, heir, L } = setup(0.4);
    dead.cash = 5000;
    reconcile(w);
    const v = estateValue(w, dead);
    killPerson(w, dead, 'age');
    expect(L.today).toBeCloseTo(0.4 * v, 6);
    expect(heir.iou).toBe(2);
    expect(heir.gold).toBe(1);
    expect(Math.abs(checkLedger(w))).toBeLessThan(1e-6);
  });
});

describe('between-day stats survive a save/load; Bank transfers are counted', () => {
  it('a transfer made right after loading a save shows in the next day’s figures', () => {
    const g0 = Game.create({ seed: 3, warmup: false });
    g0.step(2);
    const g = Game.load(g0.save());
    g.dispatch({ type: 'setAutoMint', value: true });
    const before = g.s.stats.acc.transfer_give || 0;
    const r = g.dispatch({ type: 'transfer', group: 'all', town: -1, amount: 10, dir: 1 });
    expect(r.ok).toBe(true);
    const moved = (g.s.stats.acc.transfer_give || 0) - before;
    expect(moved).toBeGreaterThan(0);
    g.step(1);
    expect(g.s.stats.latest.transferGive).toBeCloseTo(moved, 6); // was 0 after a load
  });

  it('without any action, the carry adds nothing after a load', () => {
    const g0 = Game.create({ seed: 3, warmup: false });
    g0.step(2);
    const g = Game.load(g0.save());
    g.step(1);
    expect(g.s.stats.latest.transferGive).toBe(0);
    expect(g.s.stats.latest.mintDay).toBeGreaterThanOrEqual(0);
  });

  it('a payment to the Bank counts once in the day’s transfers', () => {
    const g = Game.create({ seed: 3, warmup: false });
    g.step(1);
    g.dispatch({ type: 'setAutoMint', value: true });
    const r = g.dispatch({ type: 'transfer', group: 'bank', town: -1, amount: 5000, dir: 1 });
    expect(r.ok).toBe(true);
    g.step(1);
    expect(g.s.stats.latest.transferGive).toBeCloseTo(5000, 6);
  });
});
