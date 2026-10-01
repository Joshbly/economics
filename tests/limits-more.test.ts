// More limits: the Bank's capital rule replaced by a Limit (below the standing 8 % too),
// how far a price may move in a day (priceMove), a floor under loan rates (rateMin), price
// limits on the IOU and gold markets — and the wording of every kind.
// Built from record factories only (no world generation).
import { describe, expect, it } from 'vitest';
import { bankBeginDay, bankEndDay, capitalRuleSource, lastLoanDecisions, loansOf, minCapital, quoted, quoteRate, requestLoan } from '../src/sim/agents/bank';
import { BANK_MIN_CAPITAL, BANK_OWN_MIN_CAPITAL, LIMIT_MOVE_MAX } from '../src/sim/config';
import { newFirm, newLoan, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger, mint, reconcileBank } from '../src/sim/ledger';
import { addAsk, addBid, bookFor, clearAll, openBooks } from '../src/sim/market/markets';
import { auctionBounds, capitalMin, minLoanRate, priceMoveLimit, type AuctionBounds } from '../src/sim/policy/limits';
import { describeLimit, dispatch } from '../src/sim/policy/player';
import { ALMANAC } from '../src/ui/panels/almanacContent';
import { FIRM_BASE, GOLD_GOOD, IOU_GOOD, type Limit, type LimitKind, type MapData, type SimState } from '../src/sim/types';

const FORBIDDEN = /\b(tax|taxes|subsid\w*|tariff\w*|quota\w*|stimulus|bailout|minimum wage|UBI|QE|quantitative|price control\w*|freeze)\b/i;

function tinyMap(): MapData {
  const n = 16;
  const z = () => new Array(n).fill(0);
  return { w: 4, h: 4, terrain: new Array(n).fill(3), elev: z(), fert: z(), deposit: z(), river: z(), road: z(), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

/** Two towns, every good priced at 2; window rates 2 % / 5 %. */
function world(): SimState {
  const s = newSimState(5, tinyMap());
  s.towns.push(newTown(0, 'Kingsbridge', 'capital', 1, 1, 3));
  s.towns.push(newTown(1, 'Saltmere', 'harbor', 2, 2, 3));
  s.treasury = newTreasury(2);
  for (let t = 0; t < 2; t++) for (let g = 0; g < N_GOODS; g++) s.markets.push(newMarket(t, g, 2));
  s.treasury.reserveRate = 0.02;
  s.treasury.lendRate = 0.05;
  return s;
}

let nextId = 5000;
function limit(s: SimState, over: Partial<Limit>): Limit {
  const l: Limit = { id: nextId++, label: 'test', enabled: true, kind: 'priceMax', good: -1, town: -1, toTown: -1, value: 0, created: 0, until: -1, binding: 0, ...over };
  s.policy.limits.push(l);
  return l;
}

function firm(s: SimState, cash: number, profit: number) {
  const owner = newPerson(s, 0, 'Owner ' + s.ids.person);
  owner.cash = 100;
  const f = newFirm(s, 'bakery', 0, -1, owner.id, 'Bakery ' + s.ids.firm);
  f.cash = cash;
  f.profit = profit;
  f.tools = 50;
  f.founded = -1000;
  owner.owns.push(f.id);
  return f;
}

/**
 * A bank whose own capital is `ratio` of its loans: a 10 000 loan to a wealthy household,
 * reserves set so that equity = ratio × loans (the balance sheet identity then holds exactly).
 */
function thinBank(s: SimState, ratio: number): void {
  const rich = newPerson(s, 0, 'Rich');
  rich.cash = 20_000;
  rich.income = 400;
  newLoan(s, rich.id, 10_000, 0.01, 0.05, 3600, 'house');
  let dep = s.foreign.coin;
  for (const p of s.people) dep += p.cash;
  for (const f of s.firms) dep += f.cash;
  s.bank.reserves = dep + ratio * 10_000 - 10_000;
  reconcileBank(s);
  expect(s.bank.equity / 10_000).toBeCloseTo(ratio, 9);
  expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
}

describe('capital rule: a Limit replaces the standing 8 %', () => {
  it('no Limit → the standing rule; a Limit in its place, higher or lower, floored at the Bank’s own minimum', () => {
    const s = world();
    expect(capitalMin(s)).toBe(-1);
    expect(minCapital(s)).toBeCloseTo(BANK_MIN_CAPITAL, 12);
    expect(capitalRuleSource(s)).toBe('standing');
    const l = limit(s, { kind: 'capitalMin', value: 0.03 });
    expect(minCapital(s)).toBeCloseTo(0.03, 12); // below 8 %: it takes effect
    expect(capitalRuleSource(s)).toBe('limit');
    l.value = 0.12;
    expect(minCapital(s)).toBeCloseTo(0.12, 12);
    l.value = 0.005;
    expect(minCapital(s)).toBeCloseTo(BANK_OWN_MIN_CAPITAL, 12); // never below the Bank's own prudence
    expect(capitalRuleSource(s)).toBe('own');
    l.value = 0;
    expect(minCapital(s)).toBeCloseTo(BANK_OWN_MIN_CAPITAL, 12);
    l.enabled = false;
    expect(minCapital(s)).toBeCloseTo(BANK_MIN_CAPITAL, 12); // a paused Limit: the standing rule again
  });

  it('a bank with 5 % capital refuses under the standing rule, lends under a 3 % rule', () => {
    const run = (rule: number) => {
      const s = world();
      const f = firm(s, 400, 30);
      thinBank(s, 0.05);
      mint(s, 1e5);
      const lim = rule >= 0 ? limit(s, { kind: 'capitalMin', value: rule }) : null;
      requestLoan(s, { borrower: FIRM_BASE + f.id, amount: 300, term: 30, purpose: 'working', project: -1 });
      bankEndDay(s);
      expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
      return { s, f, lim, reason: lastLoanDecisions(s).items[0]?.reason };
    };
    const standing = run(-1);
    expect(standing.reason).toBe('capital');
    expect(loansOf(standing.s, FIRM_BASE + standing.f.id).length).toBe(0);
    const low = run(0.03);
    expect(low.reason).toBe('');
    expect(loansOf(low.s, FIRM_BASE + low.f.id).length).toBe(1);
    // quotes follow the rule too (firms and landlords plan their borrowing on them)
    expect(quoted(quoteRate(standing.s, FIRM_BASE + standing.f.id, 300))).toBe(false);
    expect(quoteRate(low.s, FIRM_BASE + low.f.id, 300)).toBeGreaterThan(0);
    // a rule the bank falls short of binds, and is counted
    const tight = run(0.07);
    expect(tight.reason).toBe('capital');
    expect(tight.lim?.binding).toBe(1);
  });

  it('a 2 % rule keeps the balance sheet exact through a month of lending and servicing', () => {
    const s = world();
    const fs = [firm(s, 400, 30), firm(s, 600, 40), firm(s, 300, 25)];
    thinBank(s, 0.04);
    mint(s, 1e5);
    limit(s, { kind: 'capitalMin', value: 0.02 });
    for (let d = 0; d < 30; d++) {
      s.day++;
      bankBeginDay(s);
      for (const f of fs) requestLoan(s, { borrower: FIRM_BASE + f.id, amount: 150, term: 60, purpose: 'working', project: -1 });
      bankEndDay(s);
      expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
      expect(Number.isFinite(s.bank.equity)).toBe(true);
    }
    expect(fs.some((f) => loansOf(s, FIRM_BASE + f.id).length > 0)).toBe(true);
  });
});

describe('loan-rate floor (rateMin)', () => {
  it('raises credit lines and new loans to the floor, not fixed-rate loans already made; a cap below it wins', () => {
    const s = world();
    const f = firm(s, 400, 30);
    thinBank(s, 0.2);
    mint(s, 1e5);
    const house = s.loans[0]; // a fixed-rate mortgage at 5 %
    // a working credit line (floats with the base rate), made before the floor
    requestLoan(s, { borrower: FIRM_BASE + f.id, amount: 300, term: 30, purpose: 'working', project: -1 });
    bankEndDay(s);
    const line = loansOf(s, FIRM_BASE + f.id)[0];
    expect(line.fixed).toBe(false);
    s.day++;
    bankBeginDay(s);
    expect(line.rate).toBeLessThan(0.08);
    const fl = limit(s, { kind: 'rateMin', value: 0.09 });
    expect(minLoanRate(s)).toBeCloseTo(0.09, 12);
    s.day++;
    bankBeginDay(s);
    expect(line.rate).toBeCloseTo(0.09, 12);
    expect(house.rate).toBeCloseTo(0.05, 12); // the contract rate holds
    expect(fl.binding).toBe(1);
    // quotes and new loans are priced at the floor or above
    expect(quoteRate(s, FIRM_BASE + f.id, 300)).toBeGreaterThanOrEqual(0.09 - 1e-12);
    requestLoan(s, { borrower: FIRM_BASE + f.id, amount: 300, term: 30, purpose: 'invest', project: -1 });
    bankEndDay(s);
    const mine = loansOf(s, FIRM_BASE + f.id);
    expect(mine.length).toBe(2);
    expect(mine[1].rate).toBeGreaterThanOrEqual(0.09 - 1e-12);
    // a lower cap wins over the floor (for the floating line; the fixed loans keep their rates,
    // and the new one is not a point above the capped terms, so it does not refinance)
    limit(s, { kind: 'rateMax', value: 0.07 });
    s.day++;
    bankBeginDay(s);
    expect(line.rate).toBeCloseTo(0.07, 12);
    expect(house.rate).toBeCloseTo(0.05, 12);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });
});

describe('priceMove: how far a price may move in a day', () => {
  const B: AuctionBounds = { ceiling: -1, floor: -1, ceilKind: 'priceMax', floorKind: 'priceMin' };

  it('sets a band around yesterday’s price, combined with fixed bounds (the tightest; a fixed bound prevails)', () => {
    const s = world();
    const mv = limit(s, { kind: 'priceMove', good: G.bread, value: 0.05 });
    expect(priceMoveLimit(s, 0, G.bread)).toBeCloseTo(0.05, 12);
    expect(auctionBounds(s, 0, G.bread, 2, B)).toMatchObject({ ceiling: 2.1, floor: 1.9, ceilKind: 'priceMove', floorKind: 'priceMove' });
    expect(auctionBounds(s, 1, G.bread, 2, B).ceiling).toBeCloseTo(2.1, 12); // every town
    expect(auctionBounds(s, 0, G.fish, 2, B)).toMatchObject({ ceiling: -1, floor: -1 }); // another good
    // a fixed ceiling inside the band is the tighter one
    const cap = limit(s, { kind: 'priceMax', good: G.bread, value: 2.05 });
    expect(auctionBounds(s, 0, G.bread, 2, B)).toMatchObject({ ceiling: 2.05, floor: 1.9, ceilKind: 'priceMax', floorKind: 'priceMove' });
    // the band wholly above the fixed ceiling: held at the ceiling (the move limit holds it from falling further)
    cap.value = 1.5;
    expect(auctionBounds(s, 0, G.bread, 2, B)).toMatchObject({ ceiling: 1.5, floor: 1.5, ceilKind: 'priceMax', floorKind: 'priceMove' });
    // the band wholly below a fixed floor: held at the floor
    cap.enabled = false;
    limit(s, { kind: 'priceMin', good: G.bread, value: 3 });
    expect(auctionBounds(s, 0, G.bread, 2, B)).toMatchObject({ ceiling: 3, floor: 3, ceilKind: 'priceMove', floorKind: 'priceMin' });
    // the tightest move limit wins; a town's own limit only applies there
    s.policy.limits = [mv];
    limit(s, { kind: 'priceMove', good: -1, town: 1, value: 0.01 });
    expect(auctionBounds(s, 1, G.bread, 2, B).ceiling).toBeCloseTo(2.02, 12);
    expect(auctionBounds(s, 1, G.coal, 2, B).ceiling).toBeCloseTo(2.02, 12); // every good in Saltmere
    expect(auctionBounds(s, 0, G.coal, 2, B).ceiling).toBe(-1);
    // "every good" never reaches the IOU and gold markets
    expect(auctionBounds(s, -1, GOLD_GOOD, 80, B).ceiling).toBe(-1);
  });

  it('holds the price back under a demand shock: at most X a day, a shortage reported, the limit counted binding', () => {
    const s = world();
    const buyer = newPerson(s, 0, 'Crowd');
    buyer.cash = 1e6;
    const f = firm(s, 100, 10);
    f.inv[G.bread] = 1e6;
    reconcileBank(s);
    const lim = limit(s, { kind: 'priceMove', good: G.bread, town: 0, value: 0.02 });
    const m = s.markets[G.bread];
    const prices: number[] = [];
    for (let d = 0; d < 5; d++) {
      s.day = d;
      const prev = m.price;
      const books = openBooks(s);
      const b = bookFor(books, 0, G.bread);
      expect(b.ceiling).toBeCloseTo(prev * 1.02, 9);
      expect(b.floor).toBeCloseTo(prev * 0.98, 9);
      // the shock: buyers want 150 loaves at up to ¤10, sellers offer 100 at ¤1 or more
      addBid(b, buyer.id, 10, 150);
      addAsk(b, FIRM_BASE + f.id, 1, 100);
      clearAll(s, books);
      expect(m.price).toBeLessThanOrEqual(prev * 1.02 + 1e-9);
      expect(m.price).toBeCloseTo(prev * 1.02, 9);
      expect(m.shortage).toBeGreaterThan(40); // demand at the bound beyond what sellers offer
      expect(lim.binding).toBe(d + 1); // once a day
      prices.push(m.price);
      expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
    }
    expect(prices[4]).toBeCloseTo(2 * 1.02 ** 5, 9);
    // without the limit the same book jumps at once
    s.policy.limits.length = 0;
    const books = openBooks(s);
    const b = bookFor(books, 0, G.bread);
    addBid(b, buyer.id, 10, 150);
    addAsk(b, FIRM_BASE + f.id, 1, 100);
    const before = m.price;
    clearAll(s, books);
    expect(m.price).toBeGreaterThan(before * 2);
  });

  it('holds an indicative (no-trade) price too, and counts it as binding', () => {
    const s = world();
    const buyer = newPerson(s, 0, 'Crowd');
    buyer.cash = 1e6;
    reconcileBank(s);
    const lim = limit(s, { kind: 'priceMove', good: G.fish, town: 0, value: 0.03 });
    const m = s.markets[G.fish];
    const books = openBooks(s);
    addBid(bookFor(books, 0, G.fish), buyer.id, 5, 10); // buyers, nobody selling: the quote would rise 25 %
    clearAll(s, books);
    expect(m.volume).toBe(0);
    expect(m.price).toBeCloseTo(2 * 1.03, 9);
    expect(lim.binding).toBe(1);
  });
});

describe('price limits on the IOU and gold markets', () => {
  it('bind in the national books only when they name them', () => {
    const s = world();
    s.goldMarket.price = 80;
    s.iouMarket.price = 120;
    limit(s, { kind: 'priceMax', good: G.bread, value: 1.5 });
    let books = openBooks(s);
    expect(books.gold.ceiling).toBe(-1);
    expect(books.iou.ceiling).toBe(-1);
    limit(s, { kind: 'priceMax', good: GOLD_GOOD, value: 70 });
    limit(s, { kind: 'priceMove', good: IOU_GOOD, value: 0.01 });
    books = openBooks(s);
    expect(books.gold.ceiling).toBe(70);
    expect(books.iou.ceiling).toBeCloseTo(121.2, 9);
    expect(books.iou.floor).toBeCloseTo(118.8, 9);
  });

  it('validation: instruments only for price limits, and always national', () => {
    const s = world();
    const r = dispatch(s, { type: 'addLimit', limit: { label: '', enabled: true, kind: 'priceMin', good: IOU_GOOD, town: 1, toTown: -1, value: 110, until: -1 } });
    expect(r.ok).toBe(true);
    expect(s.policy.limits[0].town).toBe(-1);
    expect(r.message).toMatch(/IOUs below ¤110 each/);
    const bad = dispatch(s, { type: 'addLimit', limit: { label: '', enabled: true, kind: 'importMax', good: GOLD_GOOD, town: -1, toTown: -1, value: 10, until: -1 } });
    expect(bad.ok).toBe(false);
    const far = dispatch(s, { type: 'addLimit', limit: { label: '', enabled: true, kind: 'priceMove', good: -1, town: -1, toTown: -1, value: LIMIT_MOVE_MAX + 0.1, until: -1 } });
    expect(far.ok).toBe(false);
    const every = dispatch(s, { type: 'addLimit', limit: { label: '', enabled: true, kind: 'priceMove', good: -1, town: -1, toTown: -1, value: 0.05, until: -1 } });
    expect(every.ok).toBe(true);
  });
});

describe('wording', () => {
  it('describes every kind neutrally, with no modern policy names', () => {
    const s = world();
    const cases: [LimitKind, number, number, number][] = [
      ['priceMax', G.bread, 0, 2.5],
      ['priceMin', GOLD_GOOD, -1, 90],
      ['priceMove', G.bread, -1, 0.02],
      ['priceMove', -1, 1, 0.05],
      ['priceMove', G.fish, 0, 0],
      ['priceMove', IOU_GOOD, -1, 0.01],
      ['priceMove', GOLD_GOOD, -1, 0.01],
      ['wageMin', -1, 0, 12],
      ['wageMax', -1, -1, 30],
      ['rentMax', -1, 1, 2],
      ['rentMin', -1, -1, 1],
      ['rateMax', -1, -1, 0.07],
      ['rateMin', -1, -1, 0.04],
      ['importMax', G.iron, -1, 0],
      ['exportMax', -1, -1, 5],
      ['shipMax', G.grain, 0, 10],
      ['reserveMin', -1, -1, 0.1],
      ['capitalMin', -1, -1, 0.03],
      ['capitalMin', -1, -1, 0.01],
    ];
    const texts: string[] = [];
    for (const [kind, good, town, value] of cases) {
      const r = dispatch(s, { type: 'addLimit', limit: { label: '', enabled: true, kind, good, town, toTown: -1, value, until: -1 } });
      expect(r.ok, `${kind}: ${r.message}`).toBe(true);
      texts.push(r.message);
    }
    for (const l of s.policy.limits) texts.push(describeLimit(s, l), l.label);
    for (const t of texts) expect(t).not.toMatch(FORBIDDEN);
    const all = texts.join('\n');
    expect(all).toMatch(/The price of bread in every town may move at most 2% a day/);
    expect(all).toMatch(/The price of every good in Saltmere may move at most 5% a day/);
    expect(all).toMatch(/fish in Kingsbridge is held where it stands/);
    expect(all).toMatch(/The gold price may move at most 1% a day/);
    expect(all).toMatch(/may not charge less than 4% a year/);
    expect(all).toMatch(/above 3% of its loans, in place of the standing 8%/);
    expect(all).toMatch(/never lets it fall below 2%/);
    // the Almanac too
    const almanac = ALMANAC.flatMap((c) => c.sections.map((x) => x.title + '\n' + x.body)).join('\n');
    expect(almanac).not.toMatch(FORBIDDEN);
    expect(almanac).toMatch(/move in a day/);
    expect(almanac).toMatch(/replaces it, higher or lower/);
  });
});
