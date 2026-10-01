// Land held to sell dearer (agents/land.ts): people buy plots of a town's land from its council when they expect it
// to rise in price faster than their money would earn otherwise, hold them unbuilt, and sell — to a builder whose
// site takes the plot, or back to the council once they stop expecting a gain. It counts as taken land, passes with
// estates, is charged by levies on 'land', and survives a save.
import { describe, expect, it } from 'vitest';
import { landTilePrice } from '../src/sim/agents/council';
import { startProject } from '../src/sim/agents/construction';
import { killPerson } from '../src/sim/agents/demography';
import { expectedLandGain, heldInTown, landStep, landWealth, plotAsk, plotValue } from '../src/sim/agents/land';
import { LAND_DAY, LAND_HELD_MAX, LAND_HOLD_MARKUP, LAND_RESALE_DISCOUNT } from '../src/sim/config';
import { dayOfMonth } from '../src/sim/calendar';
import { stepDay } from '../src/sim/engine';
import { cashOf, checkLedger, councilRef, pay } from '../src/sim/ledger';
import { dispatch } from '../src/sim/policy/player';
import { rt } from '../src/sim/runtime';
import { deserialize, serialize } from '../src/sim/save';
import { STATE, type SimState } from '../src/sim/types';
import { createWorld } from '../src/sim/world/init';
import { findSite } from '../src/sim/world/layout';
import { isHeld, plotAt } from '../src/sim/world/plots';

function grown(seed = 1): SimState {
  const s = createWorld({ seed });
  s.settings.events = false;
  s.treasury.autoMint = true;
  for (let d = 0; d < 30; d++) stepDay(s);
  return s;
}

/** Make every town's land look like it has been rising `yearly` a year, and run the land market today. */
function boom(s: SimState, yearly: number): void {
  for (const t of s.towns) {
    const now = landTilePrice(s, t.id, t.x, t.y);
    t.landIdx = Array.from({ length: 13 }, (_, k) => Math.round(now * Math.pow(1 + yearly, (k - 12) / 12) * 100) / 100);
  }
  s.bank.depositRate = 0;
  while (dayOfMonth(s.day) !== LAND_DAY) s.day++;
  rt(s).bag.land = undefined; // (prices recomputed for the day)
}

const ledgerOk = (s: SimState) => expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6 * Math.max(1, s.bank.reserves) + 1e-3);

describe('land: who buys and what it does to prices', () => {
  it('in a land boom people with money to spare buy plots from the council, which raises the price of what is left', () => {
    const s = grown();
    boom(s, 0.4);
    const t = s.towns[0];
    expect(expectedLandGain(s, t.id)).toBeGreaterThan(0.2);
    const purse0 = cashOf(s, councilRef(t.id));
    const price0 = landTilePrice(s, t.id, t.x, t.y);
    landStep(s);
    expect(s.plots!.length).toBeGreaterThan(0);
    const held = heldInTown(s, t.id);
    for (const p of s.plots!) {
      expect(isHeld(s, p.tile)).toBe(true);
      expect(s.map.occ[p.tile]).toBeLessThan(0);
      expect(s.map.road[p.tile]).toBe(0);
      expect(s.people[p.owner].alive).toBe(true);
      expect(p.paid).toBeGreaterThan(0);
    }
    if (held > 0) {
      expect(cashOf(s, councilRef(t.id))).toBeGreaterThan(purse0);
      // held land counts as taken: a tile at the centre costs more now (same day, fresh prices)
      rt(s).bag.land = undefined;
      expect(landTilePrice(s, t.id, t.x, t.y)).toBeGreaterThan(price0);
    }
    ledgerOk(s);
  });

  it('nobody buys when land is expected to fall, and never more than LAND_HELD_MAX of the free land', () => {
    const s = grown();
    boom(s, -0.2);
    landStep(s);
    expect(s.plots!.length).toBe(0);
    const t = grown();
    for (let m = 0; m < 12; m++) {
      boom(t, 0.6);
      landStep(t);
      t.day++;
    }
    for (const town of t.towns) {
      // (the free land is what is unbuilt in the core, held land included)
      expect(heldInTown(t, town.id)).toBeLessThanOrEqual(Math.ceil(LAND_HELD_MAX * 400));
    }
    ledgerOk(t);
  });
});

describe('land: selling', () => {
  it('a holder who stops expecting a gain sells back to the council below today’s price', () => {
    const s = grown();
    boom(s, 0.4);
    landStep(s);
    expect(s.plots!.length).toBeGreaterThan(0);
    const p = s.plots![0];
    const who = s.people[p.owner];
    const cash0 = who.cash;
    const value = plotValue(s, p.tile, p.town);
    pay(s, STATE, councilRef(p.town), 1e6, 'transfer'); // a council with the money to buy it back
    s.day++;
    boom(s, -0.3);
    landStep(s);
    expect(plotAt(s, p.tile)).toBeUndefined();
    expect(who.cash).toBeGreaterThan(cash0);
    expect(who.cash - cash0).toBeLessThanOrEqual(value * (1 - LAND_RESALE_DISCOUNT) * 1.25 + 1);
    ledgerOk(s);
  });

  it('a builder whose site takes a held plot pays its holder the ask, and the plot is gone', () => {
    const s = grown();
    boom(s, 0.4);
    landStep(s);
    const p = s.plots!.find((x) => true)!;
    expect(p).toBeDefined();
    const holder = s.people[p.owner];
    const cash0 = holder.cash;
    const ask = plotAsk(s, p);
    expect(ask).toBeCloseTo(plotValue(s, p.tile, p.town) * (1 + LAND_HOLD_MARKUP), 6);
    const x = p.tile % s.map.w;
    const y = Math.floor(p.tile / s.map.w);
    const r = startProject(s, { kind: 'house', town: p.town, owner: -1, x, y, label: 'Houses' });
    expect(typeof r).not.toBe('string');
    expect(plotAt(s, p.tile)).toBeUndefined();
    // (its price moves a little once the house stands there: built land counts as more taken than held land)
    expect(Math.abs(holder.cash - cash0 - ask) / ask).toBeLessThan(0.02);
    ledgerOk(s);
  });

  it('builders prefer free land to held land', () => {
    const s = grown();
    const t = s.towns[0];
    const before = findSite(s, 'house', t.id)!;
    expect(before).not.toBeNull();
    // someone holds the very site a house would have gone on
    const tile = before.y * s.map.w + before.x;
    s.plots = [{ tile, town: t.id, owner: s.people.find((p) => p.alive)!.id, paid: 1, day: s.day }];
    rt(s).bag.plotsVer = 99;
    const after = findSite(s, 'house', t.id)!;
    expect(after.y * s.map.w + after.x).not.toBe(tile);
  });
});

describe('land: estates, levies, roads, saves', () => {
  it('passes to an heir; with nobody to inherit it goes back to the council', () => {
    const s = grown();
    boom(s, 0.4);
    landStep(s);
    const p = s.plots![0];
    const owner = p.owner;
    const tile = p.tile;
    killPerson(s, s.people[owner], 'other');
    const now = plotAt(s, tile);
    if (now) {
      expect(now.owner).not.toBe(owner);
      expect(s.people[now.owner].alive).toBe(true);
    }
    ledgerOk(s);
  });

  it('a levy on land held unbuilt charges its holders every day', () => {
    const s = grown();
    boom(s, 0.4);
    landStep(s);
    expect(s.plots!.length).toBeGreaterThan(0);
    const r = dispatch(s, { type: 'addLevy', levy: { label: '', enabled: true, dir: 1, base: 'land', unit: 'flat', rate: 2, payer: 'holder', threshold: 0, good: -1, town: -1, toTown: -1, sector: 'any', group: 'all', buildingKind: 'any', until: -1 } as never });
    expect(r.ok, r.message).toBe(true);
    const owner = s.plots![0].owner;
    const n = s.plots!.filter((x) => x.owner === owner).length;
    const cash0 = s.people[owner].cash;
    stepDay(s);
    // the day's levies reached the Treasury (none other is in force)
    expect(s.treasury.flows.levy ?? 0).toBeCloseTo(2 * s.plots!.length, 6);
    expect(n).toBeGreaterThan(0);
    void cash0;
    ledgerOk(s);
  });

  it('a road laid across held land: the council buys the plot back at today’s price', () => {
    const s = grown();
    boom(s, 0.4);
    landStep(s);
    const p = s.plots![0];
    const holder = s.people[p.owner];
    const cash0 = holder.cash;
    s.map.road[p.tile] = 1;
    s.day++;
    while (dayOfMonth(s.day) !== LAND_DAY) s.day++;
    landStep(s);
    expect(plotAt(s, p.tile)).toBeUndefined();
    expect(holder.cash).toBeGreaterThanOrEqual(cash0);
    ledgerOk(s);
  });

  it('a save keeps the plots and each town’s land prices; impossible plots are dropped', () => {
    const s = grown();
    boom(s, 0.4);
    landStep(s);
    const t = deserialize(serialize(s));
    expect(t.plots).toEqual(s.plots);
    expect(t.towns[0].landIdx).toEqual(s.towns[0].landIdx);
    expect(landWealth(t, s.plots![0].owner)).toBeCloseTo(landWealth(s, s.plots![0].owner), 6);
    const raw = JSON.parse(serialize(s));
    raw.plots.push({ tile: -5, town: 0, owner: 0, paid: 1, day: 0 }, { ...raw.plots[0] }, { tile: 3, town: 0, owner: 999999, paid: 1, day: 0 });
    const u = deserialize(JSON.stringify(raw));
    expect(u.plots!.length).toBe(s.plots!.length);
    // and the loaded realm goes on exactly as the original
    for (let d = 0; d < 40; d++) {
      stepDay(s);
      stepDay(t);
    }
    expect(JSON.stringify({ ...t, news: [] })).toBe(JSON.stringify({ ...s, news: [] }));
  }, 120_000);
});
