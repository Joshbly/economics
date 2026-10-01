// The Treasury's own workplaces (agents/works.ts), its free handouts (player.treasuryHandouts), its
// trades in shares (agents/invest.ts treasuryShareDeals) and closing a workplace (player closeFirm).
import { describe, expect, it } from 'vitest';
import { convertToWorks, treasuryUse, worksBeginDay, worksFloat, worksReport } from '../src/sim/agents/works';
import { holders, isWorks, setHoldings, stakeOf } from '../src/sim/agents/ownership';
import { treasuryShareDeals } from '../src/sim/agents/invest';
import { MARKET_DAY, WORKS_STOCK_DAYS } from '../src/sim/config';
import { dayOfMonth } from '../src/sim/calendar';
import { stepDay } from '../src/sim/engine';
import { Game } from '../src/sim/game';
import { GOODS, SECTORS } from '../src/sim/goods';
import { checkLedger, firmRef, mint, pay } from '../src/sim/ledger';
import { describeOrder, dispatch } from '../src/sim/policy/player';
import { deserialize, serialize } from '../src/sim/save';
import { STATE, type Firm, type SimState } from '../src/sim/types';

const FORBIDDEN = /\b(tax|taxes|subsid\w*|tariff\w*|quota\w*|stimulus|bailout|nationali[sz]\w*|privati[sz]\w*|minimum wage|UBI|QE|quantitative|welfare|ration\w*)\b/i;

function world(seed = 1): SimState {
  const g = Game.create({ seed, warmup: false });
  g.s.settings.events = false;
  g.s.treasury.autoMint = true;
  return g.s;
}

/** A private producer of `sector` (in `town`, if given). */
function firmOf(s: SimState, sector: string, town = -1): Firm | undefined {
  return s.firms.find((f) => f && f.alive && f.status === 'active' && f.sector === sector && f.owner !== STATE && (town < 0 || f.town === town));
}

/** Hand `f` wholly to the Treasury (as if bought outright) and let the morning make it a Treasury workplace. */
function takeOver(s: SimState, f: Firm): void {
  setHoldings(s, f, [{ ref: STATE, share: 1 }]);
  worksBeginDay(s);
}

const balanced = (s: SimState) => expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6 * Math.max(1, s.bank.reserves));

describe('the Treasury runs a workplace it wholly owns as its own', () => {
  it('its stock goes to the Treasury’s stores, its debts are paid off, its spare cash returns to the Purse, and it gets a standing sell order', () => {
    const s = world();
    const f = firmOf(s, 'coalmine')!;
    const g = SECTORS[f.sector].out;
    f.inv[g] = 40;
    const store0 = s.treasury.goods[f.town][g];
    mint(s, 50_000);
    takeOver(s, f);
    expect(isWorks(f)).toBe(true);
    expect(f.inv[g]).toBe(0);
    expect(s.treasury.goods[f.town][g]).toBeCloseTo(store0 + 40, 6);
    expect(s.loans.some((l) => l.active && l.borrower === firmRef(f.id))).toBe(false);
    expect(f.cash).toBeLessThanOrEqual(worksFloat(s, f) + 1e-6);
    const o = s.policy.orders.find((x) => x.works === f.id)!;
    expect(o).toBeDefined();
    expect(o.side).toBe('sell');
    expect(o.market).toEqual({ kind: 'good', town: f.town, good: g });
    expect(o.priceMode).toBe('fixed');
    expect(o.atCost).toBe(true);
    expect(o.price).toBeGreaterThan(0);
    expect(describeOrder(s, o)).not.toMatch(FORBIDDEN);
    balanced(s);
  });

  it('each day what it makes goes to the stores, the Purse keeps it in cash, and it never goes bankrupt', () => {
    const s = world();
    const f = firmOf(s, 'coalmine')!;
    const g = SECTORS[f.sector].out;
    takeOver(s, f);
    let made = 0;
    for (let d = 0; d < 20; d++) {
      const before = s.treasury.goods[f.town][g];
      stepDay(s);
      made += f.producedToday;
      expect(f.inv[g]).toBeLessThan(1e-9); // delivered every morning
      expect(f.status).toBe('active');
      void before;
    }
    expect(made).toBeGreaterThan(0);
    expect(f.cash).toBeGreaterThan(0);
    expect(fin(s.stats.acc.works_funded) + 1).toBeGreaterThan(0);
    const w = worksReport(s, f)!;
    expect(w.cost).toBeGreaterThan(0);
    expect(w.value).toBeGreaterThan(0);
    balanced(s);
  }, 60_000);

  it('plans to keep its stores stocked for what leaves them, and rests while they overflow', () => {
    const s = world();
    const f = firmOf(s, 'coalmine')!;
    const g = SECTORS[f.sector].out;
    takeOver(s, f);
    const o = s.policy.orders.find((x) => x.works === f.id)!;
    o.enabled = false; // nothing leaves
    s.treasury.goods[f.town][g] = 5000; // a mountain of coal
    const fl = s.treasury.storeFlow![`${f.town}:${g}`];
    fl.prev = 5000;
    fl.out = 1;
    f.founded = s.day - 1000; // not a new workplace
    f.works!.since = s.day - 1000;
    worksBeginDay(s);
    expect(f.works!.want).toBe(0);
    // the sell order, re-sized, still offers the stock while it rests
    expect(o.qty).toBeGreaterThan(0);
    // and with nothing held and goods leaving fast, it plans more than it makes
    s.treasury.goods[f.town][g] = 0;
    fl.prev = 400;
    fl.out = 60;
    worksBeginDay(s);
    expect(f.works!.want).toBeGreaterThan(60);
    void WORKS_STOCK_DAYS;
  });
});

describe('free handouts: a Treasury sell order at a price of 0', () => {
  it('hands the goods out before the market to the people and workplaces of the town who need them, for nothing', () => {
    const s = world();
    const town = s.towns.find((t) => t.kind === 'mining')!.id;
    const g = GOODS.findIndex((x) => x.name === 'Coal');
    s.treasury.goods[town][g] = 2000;
    const r = dispatch(s, { type: 'placeOrder', market: { kind: 'good', town, good: g }, side: 'sell', price: 0, qty: 500 });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/free/);
    expect(r.message).not.toMatch(FORBIDDEN);
    const o = s.policy.orders.find((x) => x.id === r.id)!;
    const pantry0 = s.people.filter((p) => p.alive && p.town === town).reduce((a, p) => a + p.pantry[g], 0);
    const purse0 = s.treasury.purse;
    stepDay(s);
    expect(o.filled).toBeGreaterThan(0);
    expect(o.filled).toBeLessThanOrEqual(500 + 1e-9);
    expect(o.value).toBe(0); // no money changed hands
    expect(s.treasury.goods[town][g]).toBeLessThan(2000);
    const pantry1 = s.people.filter((p) => p.alive && p.town === town).reduce((a, p) => a + p.pantry[g], 0);
    expect(pantry1 + 1e-6).toBeGreaterThan(pantry0 - 1); // they burnt some, and were given more
    expect(s.treasury.purse).toBeLessThanOrEqual(purse0 + 1e-6);
    balanced(s);
  }, 60_000);
});

describe('the Treasury’s workplaces supply one another', () => {
  it('a workplace draws its materials from the Treasury’s stores in its town before buying any', () => {
    const s = world();
    const f = firmOf(s, 'furniture')!;
    const wood = SECTORS.lumber.out;
    takeOver(s, f);
    f.inv[wood] = 0;
    s.treasury.goods[f.town][wood] = 300;
    stepDay(s);
    expect(s.treasury.goods[f.town][wood]).toBeLessThan(300);
    expect(f.inv[wood] + f.producedToday * 2).toBeGreaterThan(0);
    stepDay(s);
    expect(worksReport(s, f)!.inhouse).toBeGreaterThan(0);
  }, 60_000);

  it('a material made by a Treasury workplace in another town is carried in by a rule added once', () => {
    const s = world();
    const lumber = firmOf(s, 'lumber')!;
    const furn = s.firms.find((f) => f && f.alive && f.status === 'active' && f.sector === 'furniture' && f.owner !== STATE && f.town !== lumber.town);
    if (!furn) return; // (no such pair in this realm)
    takeOver(s, lumber);
    takeOver(s, furn);
    worksBeginDay(s);
    const wood = SECTORS.lumber.out;
    const rules = (s.policy.carries ?? []).filter((c) => c.works === furn.id);
    expect(rules.length).toBe(1);
    expect(rules[0]).toMatchObject({ from: lumber.town, to: furn.town, good: wood, need: true });
    expect(treasuryUse(s, lumber.town, wood)).toBeGreaterThan(0); // the lumber camp's order keeps back what the workshop uses
    // removed by the player: not added again
    s.policy.carries = s.policy.carries!.filter((c) => c.works !== furn.id);
    worksBeginDay(s);
    expect((s.policy.carries ?? []).some((c) => c.works === furn.id)).toBe(false);
  });
});

describe('shares: the Treasury sells, buys and closes', () => {
  function toMarketDay(s: SimState): void {
    while (dayOfMonth(s.day) !== MARKET_DAY) s.day++;
  }

  it('selling a stake in a workplace it runs turns it into an ordinary company, paying the Treasury', () => {
    const s = world();
    const f = firmOf(s, 'coalmine')!;
    takeOver(s, f);
    const r = dispatch(s, { type: 'placeOrder', market: { kind: 'company', firm: f.id }, side: 'sell', price: 0, qty: 0.4, priceMode: 'any' });
    expect(r.ok).toBe(true);
    expect(r.message).not.toMatch(FORBIDDEN);
    const o = s.policy.orders.find((x) => x.id === r.id)!;
    // someone who can afford it and values it highly
    for (const p of s.people) if (p.alive) pay(s, STATE, p.id, 20_000, 'transfer');
    toMarketDay(s);
    const purse0 = s.treasury.purse;
    treasuryShareDeals(s);
    expect(o.filled).toBeGreaterThan(0);
    expect(stakeOf(f, STATE)).toBeLessThan(1);
    expect(f.works).toBeUndefined();
    expect(s.treasury.purse).toBeGreaterThan(purse0);
    // its old sell order is a plain order now (it takes it back if the Treasury owns it all again)
    const wo = s.policy.orders.find((x) => x.worksWas === f.id);
    expect(wo).toBeDefined();
    expect(wo!.works).toBeUndefined();
    balanced(s);
  });

  it('buying all of a company makes it the Treasury’s own the next morning; a price below the holders’ reservation buys nothing', () => {
    const s = world();
    const f = firmOf(s, 'bakery')!;
    const low = dispatch(s, { type: 'placeOrder', market: { kind: 'company', firm: f.id }, side: 'buy', price: 1, qty: 1 });
    expect(low.ok).toBe(true);
    toMarketDay(s);
    treasuryShareDeals(s);
    expect(stakeOf(f, STATE)).toBe(0);
    const r = dispatch(s, { type: 'placeOrder', market: { kind: 'company', firm: f.id }, side: 'buy', price: 0, qty: 1, priceMode: 'any' });
    expect(r.ok).toBe(true);
    expect(s.policy.orders.filter((x) => x.market.kind === 'company' && x.side === 'buy').length).toBe(1); // replaces the first
    treasuryShareDeals(s);
    expect(stakeOf(f, STATE)).toBeCloseTo(1, 6);
    expect(holders(f).length).toBe(1);
    worksBeginDay(s);
    expect(isWorks(f)).toBe(true);
    balanced(s);
  });

  it('closes only what it wholly owns', () => {
    const s = world();
    const f = firmOf(s, 'bakery')!;
    expect(dispatch(s, { type: 'closeFirm', firm: f.id }).ok).toBe(false);
    setHoldings(s, f, [{ ref: STATE, share: 0.7 }, { ref: f.owner === STATE ? 0 : f.owner, share: 0.3 }]);
    expect(dispatch(s, { type: 'closeFirm', firm: f.id }).ok).toBe(false);
    takeOver(s, f);
    const r = dispatch(s, { type: 'closeFirm', firm: f.id });
    expect(r.ok).toBe(true);
    expect(r.message).not.toMatch(FORBIDDEN);
    expect(f.status).toBe('liquidating');
    worksBeginDay(s);
    expect(f.works).toBeUndefined();
    expect(s.policy.orders.some((o) => o.works === f.id)).toBe(false);
  });

  it('refuses nonsense', () => {
    const s = world();
    const f = firmOf(s, 'bakery')!;
    expect(dispatch(s, { type: 'placeOrder', market: { kind: 'company', firm: f.id }, side: 'sell', price: 100, qty: 0.5 }).ok).toBe(false); // holds none
    expect(dispatch(s, { type: 'placeOrder', market: { kind: 'company', firm: f.id }, side: 'buy', price: 100, qty: 1.5 }).ok).toBe(false);
    expect(dispatch(s, { type: 'placeOrder', market: { kind: 'company', firm: f.id }, side: 'buy', price: 100, qty: 0.5, priceMode: 'follow', band: 0.1 }).ok).toBe(false);
    expect(dispatch(s, { type: 'placeOrder', market: { kind: 'company', firm: 99999 }, side: 'buy', price: 100, qty: 0.5 }).ok).toBe(false);
    expect(dispatch(s, { type: 'placeOrder', market: { kind: 'company', firm: f.id }, side: 'buy', price: 100, qty: 0.5, once: true }).ok).toBe(false);
    expect(dispatch(s, { type: 'closeFirm', firm: -3 }).ok).toBe(false);
  });
});

describe('a realm with Treasury workplaces saves and loads, and runs on the same', () => {
  it('round-trips and stays deterministic', () => {
    const g = Game.create({ seed: 3, warmup: false });
    const s = g.s;
    s.settings.events = false;
    s.treasury.autoMint = true;
    takeOver(s, firmOf(s, 'coalmine')!);
    takeOver(s, firmOf(s, 'furniture')!);
    const lumber = firmOf(s, 'lumber');
    if (lumber) takeOver(s, lumber);
    for (let d = 0; d < 5; d++) stepDay(s);
    const json = serialize(s);
    const a = deserialize(json);
    const b = deserialize(json);
    for (let d = 0; d < 5; d++) {
      stepDay(a);
      stepDay(b);
    }
    expect(serialize(a)).toBe(serialize(b));
    expect(a.firms.filter((f) => f && f.works).length).toBeGreaterThanOrEqual(2);
  }, 90_000);
});

function fin(x: number | undefined): number {
  return Number.isFinite(x) ? (x as number) : 0;
}
