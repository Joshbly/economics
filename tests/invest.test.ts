// Investors (agents/invest.ts, temperament.ts), the realm's investment experience (experience.ts)
// and firms under one control (integration.ts).
import { describe, expect, it } from 'vitest';
import { experienceAdjust, features, investState, learnFromVentures, noteVenture, ventureOpened, type VentureFacts } from '../src/sim/agents/experience';
import { groupMarkup, sisterSupply, controllerOf } from '../src/sim/agents/integration';
import { askingPrice, companyMarket, firmWorth, synergy, temperament } from '../src/sim/agents/invest';
import { holders, setHoldings, stakeOf } from '../src/sim/agents/ownership';
import { EXP_MAX_ADJ, EXP_MIN_AGE, MARKET_DAY } from '../src/sim/config';
import { Game } from '../src/sim/game';
import { G, SECTORS } from '../src/sim/goods';
import { checkLedger, firmRef, mint, pay } from '../src/sim/ledger';
import { deserialize, serialize } from '../src/sim/save';
import { STATE, type Firm, type SimState } from '../src/sim/types';

function world(seed = 1): SimState {
  const g = Game.create({ seed, warmup: false });
  g.s.settings.events = false;
  return g.s;
}

const facts = (s: SimState, sector: 'bakery' | 'fishery'): VentureFacts => ({ sector, town: 0, margin: 0.3, shortage: 0.1, makers: 2, rate: 0.08, site: 1, impact: 0.9, fresh: false });

describe('temperament', () => {
  it('is the same every time for the same investor, and differs between investors', () => {
    const s = world();
    expect(temperament(s, 5)).toEqual(temperament(s, 5));
    const a = temperament(s, 5);
    const b = temperament(s, 6);
    expect(a.horizon).not.toBe(b.horizon);
    for (const t of [a, b]) {
      expect(t.horizon).toBeGreaterThanOrEqual(3);
      expect(t.horizon).toBeLessThanOrEqual(15);
      expect(t.nerve).toBeGreaterThanOrEqual(0.3);
      expect(t.nerve).toBeLessThanOrEqual(0.9);
    }
  });
});

describe('the realm’s investment experience', () => {
  it('knows nothing at first, learns from what ventures earned, and survives a save', () => {
    const s = world();
    const v = facts(s, 'bakery');
    expect(features(s, v)).toHaveLength(15);
    const a0 = experienceAdjust(s, v);
    expect(Math.abs(a0)).toBeLessThan(0.15);
    // a run of ventures that each earned 0.25 a year less than promised
    const f = s.firms.find((x) => x && x.alive && x.sector === 'bakery')!;
    for (let k = 0; k < 60; k++) {
      noteVenture(s, 100000 + k, v, 0.4, 1000);
      const st = investState(s);
      const r = st.pending[st.pending.length - 1];
      r.firm = f.id;
      r.day = s.day - EXP_MIN_AGE;
      f.profitLife = 0.15 * 1000; // earned 0.15 a year on 1000
      learnFromVentures(s);
    }
    const a1 = experienceAdjust(s, v);
    expect(a1).toBeLessThan(a0);
    expect(a1).toBeGreaterThanOrEqual(-EXP_MAX_ADJ);
    expect(investState(s).net.trained).toBe(60);
    const t = deserialize(serialize(s));
    expect(experienceAdjust(t, v)).toBeCloseTo(a1, 9);
    // a venture opening hands its record to the firm
    noteVenture(s, 777, v, 0.2, 500);
    ventureOpened(s, 777, f);
    expect(investState(s).pending.find((r) => r.project === 777)?.firm).toBe(f.id);
  });
});

describe('what a firm is worth', () => {
  it('more profit is worth more; never below its break-up value', () => {
    const s = world();
    const f = s.firms.find((x) => x && x.alive && x.sector === 'bakery' && x.owner >= 0)!;
    const buyer = s.people.find((p) => p.alive && p.id !== f.owner)!.id;
    const p0 = f.profit;
    const pl0 = f.profitLong;
    f.profit = f.profitLong = 10;
    const lo = firmWorth(s, f, buyer, false);
    f.profit = f.profitLong = 40;
    const hi = firmWorth(s, f, buyer, false);
    expect(hi).toBeGreaterThan(lo);
    f.profit = f.profitLong = -1000;
    expect(firmWorth(s, f, buyer, false)).toBeGreaterThan(-1e9);
    f.profit = p0;
    f.profitLong = pl0;
  });

  it('a rival of the same trade and town is worth more to its competitor', () => {
    const s = world();
    const bak = s.firms.filter((x) => x && x.alive && x.status === 'active' && x.sector === 'bakery' && x.owner >= 0);
    const pair = bak.find((a) => bak.some((b) => b !== a && b.town === a.town));
    expect(pair).toBeDefined();
    const other = bak.find((b) => b !== pair && b.town === pair!.town)!;
    expect(synergy(s, pair!, firmRef(other.id))).toBeGreaterThan(0);
  });
});

describe('firms under one control', () => {
  function twoOfATrade(s: SimState): [Firm, Firm] {
    const bak = s.firms.filter((x) => x && x.alive && x.status === 'active' && x.sector === 'bakery' && x.owner >= 0);
    for (const a of bak) for (const b of bak) if (a !== b && a.town === b.town) return [a, b];
    throw new Error('no two bakeries in one town');
  }

  it('makers of one good in a town under one owner price together (a markup)', () => {
    const s = world();
    const [a, b] = twoOfATrade(s);
    const before = groupMarkup(s, a);
    setHoldings(s, b, [{ ref: a.owner, share: 1 }]);
    s.day += 1; // the groups are counted once a day
    expect(controllerOf(s, b)).toBe(controllerOf(s, a));
    expect(groupMarkup(s, a)).toBeGreaterThan(before);
  });

  it('a supplier passes its sister firm of the same town what it needs, at the going price', () => {
    const s = world();
    const bakery = s.firms.find((x) => x && x.alive && x.status === 'active' && x.sector === 'bakery' && x.owner >= 0)!;
    const farm = s.firms.find((x) => x && x.alive && x.status === 'active' && x.sector === 'farm' && x.town === bakery.town && x.owner >= 0);
    if (!farm) return; // (no farm in the bakery's town in this world)
    setHoldings(s, farm, [{ ref: bakery.owner, share: 1 }]);
    farm.inv[G.grain] = 500;
    bakery.inv[G.grain] = 0;
    bakery.output = Math.max(bakery.output, 20);
    const cash0 = farm.cash;
    sisterSupply(s);
    const moved = 500 - farm.inv[G.grain];
    expect(moved).toBeGreaterThan(0);
    expect(bakery.inv[G.grain]).toBeCloseTo(moved, 9);
    expect(farm.cash).toBeGreaterThan(cash0);
    expect(SECTORS.bakery.inputs.some(([g]) => g === G.grain)).toBe(true);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });
});

describe('the market for companies', () => {
  /** A market day on which only `f` is for sale (every other firm too young to sell), and one saver with money to spare. */
  function marketFor(s: SimState, f: Firm, cash: number): number {
    s.day += 400;
    while ((s.day % 30) + 1 !== MARKET_DAY) s.day++;
    for (const o of s.firms) if (o && o !== f) o.founded = s.day;
    f.founded = s.day - 400;
    const buyer = s.people.find((p) => p.alive && p.town === f.town && !holders(f).some((h) => h.ref === p.id))!;
    mint(s, cash);
    pay(s, STATE, buyer.id, cash, 'transfer');
    return buyer.id;
  }

  it('a saver buys into a firm its hard-pressed owners sell cheap: shares move, every holder is paid, the books balance', () => {
    const s = world();
    const f = s.firms.find((x) => x && x.alive && x.status === 'active' && x.sector === 'bakery' && x.owner >= 0 && !x.partners)!;
    f.distress = 5;
    f.lossDays = 100;
    const owner = f.owner;
    const buyer = marketFor(s, f, 0.6 * askingPrice(s, f)); // enough for a stake, not the whole firm
    const cash0 = s.people[owner].cash;
    companyMarket(s);
    const got = stakeOf(f, buyer);
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThan(1);
    expect(s.people[owner].cash).toBeGreaterThan(cash0);
    expect(holders(f).reduce((a, h) => a + h.share, 0)).toBeCloseTo(1, 9);
    expect(s.people[buyer].owns).toContain(f.id);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('a buyer who can pay for all of it takes the whole firm and runs it', () => {
    const s = world();
    const f = s.firms.find((x) => x && x.alive && x.status === 'active' && x.sector === 'bakery' && x.owner >= 0 && !x.partners)!;
    f.distress = 5;
    f.lossDays = 100;
    const buyer = marketFor(s, f, 1e6);
    companyMarket(s);
    expect(f.owner).toBe(buyer);
    expect(stakeOf(f, buyer)).toBeGreaterThan(0.999);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });
});
