// Town councils (agents/council.ts): a purse and a mayor for every town; the town's land sold to
// whoever builds on it; empty buildings bought for their plots by a bargain; houses and roads.
import { describe, expect, it } from 'vitest';
import { chooseMayor, councilHousePlan, councilRoadPlan, councilStep, landTilePrice, plotDeal, plotPrice } from '../src/sim/agents/council';
import { COUNCIL_DAY, LAND_MUL_MAX, LAND_MUL_MIN, MAYOR_MIN_AGE, MAYOR_TERM_DAYS } from '../src/sim/config';
import { stepDay } from '../src/sim/engine';
import { Game } from '../src/sim/game';
import { cashOf, checkLedger, councilRef, deposits, mint, pay } from '../src/sim/ledger';
import { dispatch } from '../src/sim/policy/player';
import { deserialize, serialize } from '../src/sim/save';
import { STATE, type Building, type SimState } from '../src/sim/types';

function world(seed = 1): SimState {
  const g = Game.create({ seed, warmup: false });
  g.s.settings.events = false;
  return g.s;
}

/** Move the clock to the next day the councils meet. */
function toCouncilDay(s: SimState): void {
  while ((s.day % 30) + 1 !== COUNCIL_DAY) s.day++;
}

/** The Treasury creates the money and hands it to a council. */
function fund(s: SimState, town: number, amount: number): void {
  mint(s, amount);
  pay(s, STATE, councilRef(town), amount, 'transfer');
}

const balanced = (s: SimState) => expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6 * Math.max(1, s.bank.reserves));

describe('councils and mayors', () => {
  it('every town has a council with a purse (a deposit at the bank) and, from the first day, a mayor who lives there', () => {
    const s = world();
    for (const t of s.towns) {
      expect(t.council).toBeDefined();
      expect(t.council!.purse).toBeGreaterThan(0);
    }
    const d0 = deposits(s);
    const k = s.towns[0].council!.purse;
    expect(cashOf(s, councilRef(0))).toBeCloseTo(k, 9);
    stepDay(s);
    for (const t of s.towns) {
      const m = t.council!.mayor;
      expect(m).toBeGreaterThanOrEqual(0);
      expect(s.people[m].alive && s.people[m].town === t.id && s.people[m].age >= MAYOR_MIN_AGE).toBe(true);
    }
    expect(d0).toBeGreaterThan(0);
    balanced(s);
  });

  it('a mayor serves a term; then the town chooses again (the sitting mayor may stay)', () => {
    const s = world();
    stepDay(s);
    const c = s.towns[0].council!;
    const first = c.mayor;
    chooseMayor(s, 0);
    expect(c.mayor).toBe(first); // mid-term: nothing changes
    c.since = s.day - MAYOR_TERM_DAYS;
    chooseMayor(s, 0);
    expect(c.since).toBe(s.day);
    expect(s.people[c.mayor].town).toBe(0);
  });
});

describe('the town’s land', () => {
  it('is dearer at the centre than at the edge of the core, and nobody’s beyond it', () => {
    const s = world();
    const t = s.towns[0];
    const R = Math.max(3, t.radius) + 1.5;
    const centre = landTilePrice(s, 0, t.x, t.y);
    const edge = landTilePrice(s, 0, t.x + 0.95 * R, t.y);
    expect(centre).toBeGreaterThan(edge);
    expect(edge).toBeGreaterThan(0);
    expect(landTilePrice(s, 0, t.x + R + 3, t.y)).toBe(0);
    // far from every town: nobody's land
    const far = s.towns.every((u) => Math.hypot(1 - u.x, 1 - u.y) > Math.max(3, u.radius) + 2);
    if (far) expect(plotPrice(s, 0, 0, 1, 1).town).toBe(-1);
  });

  it('whoever builds in a town’s core buys the plot from its council (the Treasury too)', () => {
    const s = world();
    const c = s.towns[0].council!;
    const p0 = c.purse;
    const r = dispatch(s, { type: 'build', kind: 'house', town: 0 });
    expect(r.ok, r.message).toBe(true);
    const pr = s.projects[s.projects.length - 1];
    const b = s.buildings[pr.building];
    const { town, price } = plotPrice(s, b.x, b.y, b.w, b.h);
    if (town === 0) {
      expect(price).toBeGreaterThan(0);
      expect(c.purse - p0).toBeGreaterThan(0.5 * price);
      expect(c.year.plots).toBe(1);
    }
    balanced(s);
  });

  it('a mayor with many jobless asks less for the land; never outside the bounds', () => {
    const s = world();
    toCouncilDay(s);
    const t = s.towns[0];
    const before = t.council!.landMul;
    t.unemployed = Math.ceil(0.3 * Math.max(10, t.pop));
    councilStep(s);
    expect(t.council!.landMul).toBeLessThan(before);
    for (let k = 0; k < 40; k++) {
      s.day += 30;
      t.unemployed = Math.ceil(0.3 * Math.max(10, t.pop));
      councilStep(s);
    }
    expect(t.council!.landMul).toBeGreaterThanOrEqual(LAND_MUL_MIN);
    expect(t.council!.landMul).toBeLessThanOrEqual(LAND_MUL_MAX);
  });
});

describe('buying empty buildings for their plots', () => {
  /** An occupied house in the core of town 0, emptied and left standing for years. */
  function emptyHouse(s: SimState): Building | null {
    const owner = s.people.find((p) => p.alive && p.town === 0)!;
    for (const b of s.buildings) {
      if (!b || b.kind !== 'house' || b.town !== 0 || b.status !== 'active' || b.project >= 0) continue;
      const pl = plotPrice(s, b.x, b.y, b.w, b.h);
      if (pl.town !== 0 || !(pl.price > 300)) continue;
      for (const id of b.residents) s.people[id].home = -1;
      b.residents = [];
      b.vacantDays = 2000;
      b.owner = owner.id;
      return b;
    }
    return null;
  }

  it('a deal is struck between what the owner asks and what the plot is worth to the council', () => {
    const s = world();
    stepDay(s);
    const b = emptyHouse(s);
    expect(b).not.toBeNull();
    s.towns[0].council!.year.plots = 1; // the town sells plots: the council expects to sell this one again
    const d = plotDeal(s, b!, 0)!;
    expect(d).not.toBeNull();
    if (d.price > 0) {
      expect(d.price).toBeGreaterThanOrEqual(d.ask - 1e-9);
      expect(d.price).toBeLessThanOrEqual(d.value + 1e-9);
    } else expect(d.value).toBeLessThanOrEqual(d.ask);
  });

  it('the council pays the owner, the plot is cleared, and the books still balance', () => {
    const s = world();
    stepDay(s);
    const b = emptyHouse(s)!;
    const c = s.towns[0].council!;
    c.year.plots = 1;
    fund(s, 0, 1e5);
    const d = plotDeal(s, b, 0)!;
    if (!(d.price > 0)) return; // (this owner holds out: the mayor would not pay that much)
    const owner = b.owner;
    const cash0 = s.people[owner].cash;
    toCouncilDay(s);
    councilStep(s);
    if (b.status === 'ruin') {
      expect(s.people[owner].cash).toBeGreaterThan(cash0);
      expect(c.year.deals).toBe(1);
      expect(s.map.occ[b.y * s.map.w + b.x]).toBe(-1);
    } else expect(c.year.deals).toBe(1); // (it bought an emptier plot of the town's first)
    balanced(s);
  });

  it('never deals for a building the Treasury owns, nor one that is not empty', () => {
    const s = world();
    stepDay(s);
    const b = emptyHouse(s)!;
    b.owner = STATE;
    expect(plotDeal(s, b, 0)).toBeNull();
    b.owner = s.people.find((p) => p.alive)!.id;
    b.vacantDays = 10;
    expect(plotDeal(s, b, 0)).toBeNull();
  });
});

describe('the Treasury and the councils', () => {
  it('Transfer hands money to every council, or takes it back from one', () => {
    const s = world();
    const p0 = s.towns.map((t) => t.council!.purse);
    const r = dispatch(s, { type: 'transfer', group: 'councils', town: -1, amount: 100, dir: 1 });
    expect(r.ok, r.message).toBe(true);
    s.towns.forEach((t, i) => {
      expect(t.council!.purse - p0[i]).toBeCloseTo(100, 6);
      expect(t.council!.year.received).toBeCloseTo(100, 6);
    });
    const r2 = dispatch(s, { type: 'transfer', group: 'councils', town: 1, amount: 50, dir: -1 });
    expect(r2.ok, r2.message).toBe(true);
    expect(s.towns[1].council!.purse - p0[1]).toBeCloseTo(50, 6);
    expect(dispatch(s, { type: 'transfer', group: 'councils', town: 0, amount: 1, dir: 1, good: 8 }).ok).toBe(false);
    balanced(s);
  });
});

describe('what councils build', () => {
  it('a council with money builds houses when its town has no roof for several households and nobody is building any', () => {
    const s = world();
    stepDay(s);
    const t = s.towns[0];
    for (const p of s.projects) if (p.kind === 'house' && p.town === 0) p.status = 'cancelled';
    t.homeless = 12;
    fund(s, 0, 1e6);
    const plan = councilHousePlan(s, 0);
    expect(plan).not.toBeNull();
    toCouncilDay(s);
    t.homeless = 12;
    councilStep(s);
    const mine = s.projects.filter((p) => p.kind === 'house' && p.owner === councilRef(0) && p.status !== 'cancelled');
    if (plan!.npv > 0) expect(mine.length).toBe(1);
    else expect(mine.length).toBe(0);
    balanced(s);
  });

  it('the rent of a house the council lets goes to its purse', () => {
    const s = world();
    stepDay(s);
    const b = s.buildings.find((x) => x && x.kind === 'house' && x.town === 0 && x.status === 'active' && x.residents.length >= 2)!;
    for (const id of b.residents) s.people[id].cash += 0; // (their own money pays)
    b.owner = councilRef(0);
    const k0 = s.towns[0].council!.purse;
    stepDay(s);
    expect(s.towns[0].council!.purse).toBeGreaterThan(k0);
    balanced(s);
  });

  it('a council with money commissions the road that pays its town best, when one does', () => {
    const s = world();
    for (let d = 0; d < 40; d++) stepDay(s);
    for (let t = 0; t < s.towns.length; t++) fund(s, t, 1e6);
    toCouncilDay(s);
    const plans = s.towns.map((t) => councilRoadPlan(s, t.id));
    expect(plans.some((p) => p !== null)).toBe(true); // (early on the roads between towns are still unpaved)
    councilStep(s);
    s.towns.forEach((t, i) => {
      const mine = s.projects.filter((p) => p.kind === 'road' && p.owner === councilRef(t.id) && p.status !== 'cancelled');
      if (plans[i]) expect(mine.length).toBe(1);
    });
    balanced(s);
  });
});

describe('saving', () => {
  it('councils survive a save; a save from before councils loads with empty ones and balanced books', () => {
    const s = world();
    stepDay(s);
    dispatch(s, { type: 'transfer', group: 'councils', town: 2, amount: 70, dir: 1 });
    const t = deserialize(serialize(s));
    expect(t.towns[2].council).toEqual(s.towns[2].council);
    const raw = JSON.parse(serialize(s));
    for (const tw of raw.towns) delete tw.council;
    const old = deserialize(JSON.stringify(raw));
    for (const tw of old.towns) expect(tw.council?.purse).toBe(0);
    expect(Math.abs(checkLedger(old))).toBeLessThan(1e-6 * Math.max(1, old.bank.reserves));
    stepDay(old);
    for (const tw of old.towns) expect(tw.council!.mayor).toBeGreaterThanOrEqual(0);
  });
});
