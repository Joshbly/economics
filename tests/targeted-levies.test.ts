// Targeted sale levies: a 'sale' rule with a trade or a group rides on the orders of the
// traders it names (per-order extras), is credited back to its own accounting, and reaches
// the plans of the firms and households it names. Built from record factories.
import { describe, expect, it } from 'vitest';
import { householdOrders, householdsBeginDay } from '../src/sim/agents/households';
import { BID_RUNGS, OIL_PER_TILE } from '../src/sim/config';
import { tripCost } from '../src/sim/agents/traders';
import type { Route } from '../src/sim/runtime';
import { newFirm, newMarket, newPerson, newSimState, newTown, newTreasury } from '../src/sim/factory';
import { G, N_GOODS } from '../src/sim/goods';
import { checkLedger, mint, reconcileBank } from '../src/sim/ledger';
import { addAsk, addBid, bookFor, clearAll, expectedGross, expectedGrossFor, expectedNet, expectedNetFor, marketOf, openBooks } from '../src/sim/market/markets';
import { hasTargetedSale, isTargetedSale, portDuty, saleWedge, targetedExtrasFor } from '../src/sim/policy/levies';
import { dispatch, playerAfterClear, playerOrders, policyBeginDay } from '../src/sim/policy/player';
import { FIRM_BASE, FOREIGN, STATE, type Levy, type MapData, type PlayerAction, type SimState } from '../src/sim/types';

const FORBIDDEN = /\b(tax|taxes|subsid\w*|tariff\w*|quota\w*|stimulus|bailout|minimum wage|UBI|QE|quantitative)\b/i;

function tinyMap(): MapData {
  const n = 4;
  return { w: 2, h: 2, terrain: new Array(n).fill(3), elev: new Array(n).fill(0.5), fert: new Array(n).fill(0.5), deposit: new Array(n).fill(0), river: new Array(n).fill(0), road: new Array(n).fill(0), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

/** Millbrook (0, farm) and Saltmere (1, harbour with the port); every good priced at 10. */
function tinyState(): SimState {
  const s = newSimState(1, tinyMap());
  s.towns.push(newTown(0, 'Millbrook', 'farm', 0, 0, 3));
  s.towns.push(newTown(1, 'Saltmere', 'harbor', 1, 1, 3));
  s.towns[1].hasPort = true;
  s.treasury = newTreasury(2);
  for (let t = 0; t < 2; t++) for (let g = 0; g < N_GOODS; g++) s.markets.push(newMarket(t, g, 10));
  return s;
}

type LevyIn = Extract<PlayerAction, { type: 'addLevy' }>['levy'];
const sale = (p: Partial<LevyIn>): LevyIn => ({ label: '', enabled: true, dir: -1, base: 'sale', unit: 'pct', rate: 0.4, payer: 'buyer', threshold: 0, good: G.tools, town: 0, toTown: -1, sector: 'any', group: 'all', buildingKind: 'any', until: -1, ...p });

function add(s: SimState, l: LevyIn): Levy {
  const r = dispatch(s, { type: 'addLevy', levy: l });
  expect(r.ok, r.message).toBe(true);
  return s.policy.levies.find((x) => x.id === r.id)!;
}

describe('targeted sale levies — validation and wording', () => {
  it('accepts a trade or a group, describes them neutrally, and refuses what cannot apply', () => {
    const s = tinyState();
    const r1 = dispatch(s, { type: 'addLevy', levy: sale({ sector: 'coalmine' }) });
    expect(r1.ok, r1.message).toBe(true);
    expect(r1.message).toBe('The Treasury now pays 40% of the price of tools bought by coal mines in Millbrook.');
    const l1 = s.policy.levies[0];
    expect(l1.sector).toBe('coalmine');
    expect(isTargetedSale(l1)).toBe(true);
    expect(l1.label).toBe('Give 40% · tools bought by coal mines · Millbrook');

    const r2 = dispatch(s, { type: 'addLevy', levy: sale({ good: G.bread, rate: 0.3, group: 'hungry', town: -1 }) });
    expect(r2.ok, r2.message).toBe(true);
    expect(r2.message).toBe('The Treasury now pays 30% of the price of bread bought by hungry households.');

    const r3 = dispatch(s, { type: 'addLevy', levy: sale({ good: G.grain, payer: 'seller', sector: 'farm', rate: 0.2 }) });
    expect(r3.ok, r3.message).toBe(true);
    expect(r3.message).toMatch(/pays farms an extra 20% of the price of the grain they sell in Millbrook/);

    const r4 = dispatch(s, { type: 'addLevy', levy: sale({ dir: 1, good: G.ale, unit: 'perUnit', rate: 0.5, group: 'owners' }) });
    expect(r4.ok, r4.message).toBe(true);
    expect(r4.message).toMatch(/takes ¤0\.50 on top of the price of every cask of ale bought by property owners/);

    // a trade with 'firms' is just the trade
    const r5 = dispatch(s, { type: 'addLevy', levy: sale({ sector: 'smelter', group: 'firms' }) });
    expect(r5.ok).toBe(true);
    expect(s.policy.levies.find((l) => l.id === r5.id)!.group).toBe('all');

    for (const r of [r1, r2, r3, r4, r5]) expect(r.message).not.toMatch(FORBIDDEN);
    for (const l of s.policy.levies) expect(l.label).not.toMatch(FORBIDDEN);

    // refused: people do not sell goods; a trade and a group of people at once; the Treasury's own works
    expect(dispatch(s, { type: 'addLevy', levy: sale({ payer: 'seller', group: 'unemployed' }) }).ok).toBe(false);
    expect(dispatch(s, { type: 'addLevy', levy: sale({ sector: 'bakery', group: 'hungry' }) }).ok).toBe(false);
    expect(dispatch(s, { type: 'addLevy', levy: sale({ sector: 'stateworks' }) }).ok).toBe(false);
    expect(dispatch(s, { type: 'addLevy', levy: sale({ sector: 'nonsense' as never }) }).ok).toBe(false);

    // editing keeps the targeting valid
    expect(dispatch(s, { type: 'updateLevy', id: r1.id!, patch: { group: 'hungry' } }).ok).toBe(false);
    expect(dispatch(s, { type: 'updateLevy', id: r1.id!, patch: { rate: 0.5 } }).ok).toBe(true);
    expect(s.policy.levies[0].rate).toBe(0.5);
  });

  it('keeps targeted rules out of the market-wide wedge', () => {
    const s = tinyState();
    add(s, sale({ sector: 'coalmine' }));
    add(s, sale({ dir: 1, rate: 0.1, sector: 'any' })); // an ordinary 10 % take on tools buyers
    expect(saleWedge(s, 0, G.tools).bPct).toBeCloseTo(0.1);
    expect(hasTargetedSale(s)).toBe(true);
    const books = openBooks(s);
    expect(bookFor(books, 0, G.tools).wedge.bPct).toBeCloseTo(0.1);
  });
});

describe('targeted sale levies — orders, settlement and accounting', () => {
  it('a share of the price of tools paid for coal mines only: extras on their bids, money and accounting exact', () => {
    const s = tinyState();
    const owner = newPerson(s, 0, 'Owner');
    const mine = newFirm(s, 'coalmine', 0, -1, owner.id, 'Deep Mine');
    const bakery = newFirm(s, 'bakery', 0, -1, owner.id, 'Bakery');
    const smith = newFirm(s, 'toolworks', 0, -1, owner.id, 'Smithy');
    mine.cash = 1000;
    bakery.cash = 1000;
    smith.inv[G.tools] = 100;
    reconcileBank(s);
    mint(s, 1000);
    const purse0 = s.treasury.purse;
    const rule = add(s, sale({ sector: 'coalmine' }));

    policyBeginDay(s);
    const books = openBooks(s);
    const book = bookFor(books, 0, G.tools);
    expect(book.wedge.bPct).toBe(0);
    const bm = addBid(book, FIRM_BASE + mine.id, 6.6, 10); // gross 6.6 at 40 % off → base 11
    const bb = addBid(book, FIRM_BASE + bakery.id, 11, 10);
    const person = newPerson(s, 0, 'Walker');
    const bp = addBid(book, person.id, 11, 0); // qty 0: ignored, but no extras for people
    const as = addAsk(book, FIRM_BASE + smith.id, 10, 30);
    expect(bm.xPct).toBeCloseTo(-0.4);
    expect(bb.xPct).toBe(0);
    expect(bp.xPct).toBe(0);
    expect(as.xPct).toBe(0);
    playerOrders(s, books);
    clearAll(s, books);
    playerAfterClear(s, books);

    const m = marketOf(s, 0, G.tools);
    expect(m.volume).toBeCloseTo(20);
    const p = m.price;
    expect(p).toBeGreaterThanOrEqual(10);
    expect(p).toBeLessThanOrEqual(11);
    // the mine pays 60 % of the base, the bakery all of it, the smithy receives the base for all
    expect(bm.filled).toBeCloseTo(10);
    expect(bm.paid).toBeCloseTo(0.6 * p * 10);
    expect(mine.cash).toBeCloseTo(1000 - 0.6 * p * 10);
    expect(bb.paid).toBeCloseTo(p * 10);
    expect(smith.cash).toBeCloseTo(p * 20);
    expect(s.treasury.purse).toBeCloseTo(purse0 - 0.4 * p * 10);
    // the rule's accounting and the Treasury's flows agree
    expect(rule.today).toBeCloseTo(-0.4 * p * 10);
    expect(rule.total).toBeCloseTo(-0.4 * p * 10);
    expect(s.treasury.flows.give).toBeCloseTo(-0.4 * p * 10);
    expect(s.stats.acc.levy_give).toBeCloseTo(0.4 * p * 10);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a targeted give and a market-wide take on the same market are each credited to their own rule', () => {
    const s = tinyState();
    const owner = newPerson(s, 0, 'Owner');
    const mine = newFirm(s, 'coalmine', 0, -1, owner.id, 'Mine');
    const bakery = newFirm(s, 'bakery', 0, -1, owner.id, 'Bakery');
    const smith = newFirm(s, 'toolworks', 0, -1, owner.id, 'Smithy');
    mine.cash = bakery.cash = 1000;
    smith.inv[G.tools] = 100;
    reconcileBank(s);
    mint(s, 1000);
    const give = add(s, sale({ sector: 'coalmine', rate: 0.3 }));
    const take = add(s, sale({ dir: 1, rate: 0.1 }));
    policyBeginDay(s);
    const books = openBooks(s);
    const book = bookFor(books, 0, G.tools);
    const bm = addBid(book, FIRM_BASE + mine.id, 100, 5);
    const bb = addBid(book, FIRM_BASE + bakery.id, 100, 5);
    addAsk(book, FIRM_BASE + smith.id, 10, 10);
    clearAll(s, books);
    const p = marketOf(s, 0, G.tools).price;
    expect(bm.paid).toBeCloseTo(5 * p * (1 + 0.1 - 0.3));
    expect(bb.paid).toBeCloseTo(5 * p * 1.1);
    expect(take.today).toBeCloseTo(0.1 * p * 10);
    expect(give.today).toBeCloseTo(-0.3 * p * 5);
    const net = (s.treasury.flows.levy || 0) + (s.treasury.flows.give || 0);
    expect(net).toBeCloseTo(take.today + give.today);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a group of people: only the households in it get the share of the price', () => {
    const s = tinyState();
    const idle = newPerson(s, 0, 'Idle');
    const busy = newPerson(s, 0, 'Busy');
    busy.job = 99;
    idle.cash = busy.cash = 100;
    const owner = newPerson(s, 0, 'Owner');
    const baker = newFirm(s, 'bakery', 0, -1, owner.id, 'Bakery');
    baker.inv[G.bread] = 50;
    reconcileBank(s);
    mint(s, 1000);
    const rule = add(s, sale({ good: G.bread, rate: 0.5, group: 'unemployed' }));
    const books = openBooks(s);
    const book = bookFor(books, 0, G.bread);
    const bi = addBid(book, idle.id, 20, 4);
    const bb = addBid(book, busy.id, 20, 4);
    addAsk(book, FIRM_BASE + baker.id, 10, 50);
    expect(bi.xPct).toBeCloseTo(-0.5);
    expect(bb.xPct).toBe(0);
    clearAll(s, books);
    const p = marketOf(s, 0, G.bread).price;
    expect(idle.cash).toBeCloseTo(100 - 0.5 * p * 4);
    expect(busy.cash).toBeCloseTo(100 - p * 4);
    expect(idle.spent).toBeCloseTo(0.5 * p * 4);
    expect(rule.today).toBeCloseTo(-0.5 * p * 4);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('seller side: a take on grain sold by farms is paid by farms only; foreign merchants and port duties are untouched', () => {
    const s = tinyState();
    const owner = newPerson(s, 1, 'Owner');
    owner.cash = 1000;
    const farm = newFirm(s, 'farm', 1, -1, owner.id, 'Farm');
    const trader = newFirm(s, 'trader', 1, -1, owner.id, 'Carters');
    farm.inv[G.grain] = 20;
    trader.inv[G.grain] = 20;
    s.foreign.coin = 0;
    reconcileBank(s);
    const cut = add(s, sale({ dir: 1, good: G.grain, payer: 'seller', sector: 'farm', rate: 0.2, town: 1 }));
    const duty = add(s, { ...sale({ dir: 1, good: G.grain, rate: 0.5, town: -1 }), base: 'import', payer: 'buyer' });
    expect(portDuty(s, 'import', G.grain).pct).toBeCloseTo(0.5);
    const books = openBooks(s);
    const book = bookFor(books, 1, G.grain);
    const af = addAsk(book, FIRM_BASE + farm.id, 8, 10);
    const at = addAsk(book, FIRM_BASE + trader.id, 8, 10);
    const ax = addAsk(book, FOREIGN, 5, 10, { xPct: 0.5 }); // an import tranche with its duty
    expect(af.xPct).toBeCloseTo(0.2);
    expect(at.xPct).toBe(0);
    expect(ax.xPct).toBeCloseTo(0.5);
    const buyer = addBid(book, owner.id, 20, 30);
    clearAll(s, books);
    const p = marketOf(s, 1, G.grain).price;
    expect(buyer.filled).toBeCloseTo(30);
    expect(af.paid).toBeCloseTo(0.8 * p * 10);
    expect(at.paid).toBeCloseTo(p * 10);
    expect(cut.today).toBeCloseTo(0.2 * p * 10);
    expect(duty.today).toBeCloseTo(0.5 * p * 10);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it("a trading house's merchandise (bought for resale) does not carry a rule on its purchases; its fuel does", () => {
    const s = tinyState();
    const owner = newPerson(s, 0, 'Owner');
    const carters = newFirm(s, 'trader', 0, -1, owner.id, 'Carters');
    mint(s, 10);
    add(s, sale({ good: G.oil, sector: 'trader', rate: 0.5 }));
    const books = openBooks(s);
    const book = bookFor(books, 0, G.oil);
    expect(addBid(book, FIRM_BASE + carters.id, 3, 5).xPct).toBeCloseTo(-0.5); // fuel for its wagons
    expect(addBid(book, FIRM_BASE + carters.id, 3, 5, { tag: 1, resale: true }).xPct).toBe(0); // merchandise for town 1
    // the seller side still applies to what it sells
    add(s, sale({ good: G.grain, payer: 'seller', sector: 'trader', rate: 0.2 }));
    const b2 = openBooks(s);
    expect(addAsk(bookFor(b2, 0, G.grain), FIRM_BASE + carters.id, 3, 5).xPct).toBeCloseTo(-0.2);
  });

  it('Treasury orders are exempt, and a give is suspended while the Purse is empty', () => {
    const s = tinyState();
    const owner = newPerson(s, 0, 'Owner');
    const mine = newFirm(s, 'coalmine', 0, -1, owner.id, 'Mine');
    reconcileBank(s);
    add(s, sale({ sector: 'coalmine' }));
    // auto-mint off, Purse empty → gives are on hold
    policyBeginDay(s);
    expect(s.treasury.givesSuspended).toBe(true);
    let books = openBooks(s);
    expect(addBid(bookFor(books, 0, G.tools), FIRM_BASE + mine.id, 10, 1).xPct).toBe(0);
    mint(s, 100);
    policyBeginDay(s);
    books = openBooks(s);
    expect(addBid(bookFor(books, 0, G.tools), FIRM_BASE + mine.id, 10, 1).xPct).toBeCloseTo(-0.4);
    expect(addBid(bookFor(books, 0, G.tools), STATE, 10, 1, { exempt: true }).xPct).toBe(0);
    // other towns, other goods: untouched
    expect(addBid(bookFor(books, 1, G.tools), FIRM_BASE + mine.id, 10, 1).xPct).toBe(0);
    expect(addBid(bookFor(books, 0, G.wood), FIRM_BASE + mine.id, 10, 1).xPct).toBe(0);
  });
});

describe('targeted sale levies — planning', () => {
  it('firms, entrants and households read their own expected prices', () => {
    const s = tinyState();
    const owner = newPerson(s, 0, 'Owner');
    const mine = newFirm(s, 'coalmine', 0, -1, owner.id, 'Mine');
    const farm = newFirm(s, 'farm', 0, -1, owner.id, 'Farm');
    mint(s, 10);
    add(s, sale({ sector: 'coalmine' }));
    add(s, sale({ good: G.grain, payer: 'seller', sector: 'farm', rate: 0.25 }));
    const g0 = expectedGross(s, 0, G.tools);
    expect(expectedGrossFor(s, 0, G.tools, FIRM_BASE + mine.id)).toBeCloseTo(0.6 * g0);
    expect(expectedGrossFor(s, 0, G.tools, FIRM_BASE + farm.id)).toBeCloseTo(g0);
    expect(expectedGrossFor(s, 0, G.tools, 'coalmine')).toBeCloseTo(0.6 * g0); // an entrant of the trade
    expect(expectedGrossFor(s, 1, G.tools, FIRM_BASE + mine.id)).toBeCloseTo(expectedGross(s, 1, G.tools));
    expect(expectedNetFor(s, 0, G.grain, FIRM_BASE + farm.id)).toBeCloseTo(1.25 * expectedNet(s, 0, G.grain));
    expect(targetedExtrasFor(s, 0, G.grain, 'seller', 'farm').pct).toBeCloseTo(-0.25);
  });

  it('trading houses price their trips with the share of their oil the Treasury pays', () => {
    const s = tinyState();
    const owner = newPerson(s, 0, 'Owner');
    const carters = newFirm(s, 'trader', 0, -1, owner.id, 'Carters');
    const route: Route = { from: 0, to: 1, tiles: [], length: 40, paved: 0, dirt: 40, offroad: 0, days: 2 };
    mint(s, 10);
    const ref = FIRM_BASE + carters.id;
    const c0 = tripCost(s, 0, route, 10, ref);
    expect(c0).toBeCloseTo(tripCost(s, 0, route, 10)); // no rule: the market's prices
    add(s, sale({ good: G.oil, sector: 'trader', rate: 0.5 }));
    const c1 = tripCost(s, 0, route, 10, ref);
    expect(c0 - c1).toBeCloseTo(0.5 * expectedGross(s, 0, G.oil) * OIL_PER_TILE * 40, 9);
    expect(tripCost(s, 0, route, 10, 'trader')).toBeCloseTo(c1, 9);
    expect(tripCost(s, 0, route, 10)).toBeCloseTo(c0, 9);
  });

  it('households named by a rule plan at their own price: they bid for more at the same base prices', () => {
    const s = tinyState();
    for (let g = 0; g < N_GOODS; g++) s.markets[g].ema = s.markets[g].price = 3;
    const idle = newPerson(s, 0, 'Idle');
    const busy = newPerson(s, 0, 'Busy');
    busy.job = 99;
    for (const p of [idle, busy]) {
      p.cash = 60;
      p.income = 10;
      p.earned = 10;
    }
    reconcileBank(s);
    mint(s, 100);
    add(s, sale({ good: G.bread, rate: 0.5, group: 'unemployed' }));
    policyBeginDay(s);
    householdsBeginDay(s);
    const books = openBooks(s);
    householdOrders(s, books);
    const bids = bookFor(books, 0, G.bread).bids;
    const qty = (id: number) => bids.filter((o) => o.ref === id).reduce((a, o) => a + o.qty, 0);
    const bases = (id: number) => bids.filter((o) => o.ref === id).map((o) => o.limit / (1 + o.xPct));
    expect(qty(idle.id)).toBeGreaterThan(qty(busy.id));
    // Both ladders sit on rungs of the same base prices (3 × BID_RUNGS): the named household's
    // on its own halved gross price, which the rule's extras convert back to the market's base.
    const onRung = (b: number) => BID_RUNGS.some((r) => Math.abs(b - 3 * r) < 1e-6);
    expect(bases(idle.id).length).toBeGreaterThan(0);
    for (const b of bases(idle.id)) expect(onRung(b)).toBe(true);
    for (const b of bases(busy.id)) expect(onRung(b)).toBe(true);
    for (const o of bids.filter((x) => x.ref === idle.id)) expect(BID_RUNGS.some((r) => Math.abs(o.limit - 1.5 * r) < 1e-6)).toBe(true);
  });
});
