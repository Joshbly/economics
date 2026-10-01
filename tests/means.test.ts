// People of independent means (agents/means.ts): who lives on what their capital brings in leaves the labour
// force; they are not jobless, do not look for work or drift away for want of it, and come back when it falls.
import { describe, expect, it } from 'vitest';
import { decayCapitalIncome, decideMeans, noteCapitalIncome, townJobless } from '../src/sim/agents/means';
import { MEANS_LEAVE, MEANS_RETURN } from '../src/sim/config';
import { stepDay } from '../src/sim/engine';
import { newPerson, newSimState, newTown } from '../src/sim/factory';
import { inGroup } from '../src/sim/policy/levies';
import { deserialize, serialize } from '../src/sim/save';
import type { MapData, SimState } from '../src/sim/types';
import { createWorld } from '../src/sim/world/init';

function tinyMap(): MapData {
  const n = 16;
  const z = () => new Array(n).fill(0);
  return { w: 4, h: 4, terrain: new Array(n).fill(3), elev: z(), fert: z(), deposit: z(), river: z(), road: z(), occ: new Array(n).fill(-1), district: new Array(n).fill(0) };
}

function tiny(): SimState {
  const s = newSimState(3, tinyMap());
  s.towns.push(newTown(0, 'Kingsbridge', 'capital', 1, 1, 3));
  return s;
}

describe('capital income', () => {
  it('is a running average of what capital brings in a day', () => {
    const s = tiny();
    const p = newPerson(s, 0, 'Saver');
    for (let d = 0; d < 1500; d++) {
      decayCapitalIncome(p);
      noteCapitalIncome(p, 40); // e.g. a rent and some interest, every day
    }
    expect(p.capInc).toBeCloseTo(40, 3);
    // a monthly dividend of 30 days' worth averages out to about the same
    const q = newPerson(s, 0, 'Holder');
    for (let d = 0; d < 1500; d++) {
      decayCapitalIncome(q);
      if (d % 30 === 0) noteCapitalIncome(q, 1200);
    }
    expect(q.capInc!).toBeGreaterThan(25);
    expect(q.capInc!).toBeLessThan(60);
    // and it fades once the income stops
    for (let d = 0; d < 400; d++) decayCapitalIncome(p);
    expect(p.capInc ?? 0).toBeLessThan(2);
  });
});

describe('who lives on their means', () => {
  it('leaves work at MEANS_LEAVE × a wage and comes back below MEANS_RETURN × it (and not in between)', () => {
    const s = tiny();
    const p = newPerson(s, 0, 'Heir');
    p.job = 0; // (a post; the caller frees it)
    const wage = 10;
    p.capInc = (MEANS_LEAVE - 0.1) * wage;
    expect(decideMeans(s, [wage])).toEqual([]);
    expect(p.means).toBeUndefined();
    p.capInc = MEANS_LEAVE * wage;
    expect(decideMeans(s, [wage])).toEqual([p]);
    expect(p.means).toBe(true);
    // in between: stays a person of means
    p.job = -1;
    p.capInc = ((MEANS_LEAVE + MEANS_RETURN) / 2) * wage;
    decideMeans(s, [wage]);
    expect(p.means).toBe(true);
    // below the lower mark: looks for work again, a fresh search
    p.capInc = (MEANS_RETURN - 0.1) * wage;
    p.unempDays = 99;
    decideMeans(s, [wage]);
    expect(p.means).toBeUndefined();
    expect(p.unempDays).toBe(0);
  });

  it('are not jobless: the rate is over the labour force, and a levy for people without work passes them by', () => {
    const s = tiny();
    const t = s.towns[0];
    t.pop = 100;
    t.unemployed = 5;
    t.ofMeans = 10;
    expect(townJobless(t)).toBeCloseTo(5 / 90, 9);
    const p = newPerson(s, 0, 'Gentleman');
    p.job = -1;
    expect(inGroup(s, p, 'unemployed')).toBe(true);
    p.means = true;
    expect(inGroup(s, p, 'unemployed')).toBe(false);
  });
});

describe('in a running realm', () => {
  function grown(): SimState {
    const s = createWorld({ seed: 3 });
    s.settings.events = false;
    for (let d = 0; d < 20; d++) stepDay(s);
    return s;
  }

  it('a worker whose capital comes to bring in a fortune quits, looks for no work, and is not counted jobless', () => {
    const s = grown();
    const p = s.people.find((x) => x.alive && x.job >= 0 && s.firms[x.job]?.sector !== 'stateworks')!;
    const firm = s.firms[p.job];
    p.capInc = 50 * Math.max(1, s.towns[p.town].avgWage);
    stepDay(s);
    expect(p.means).toBe(true);
    expect(p.job).toBe(-1);
    expect(firm.workers).not.toContain(p.id);
    // not among the jobless of the town, and the realm's rate is over the labour force
    const town = s.towns[p.town];
    expect(town.ofMeans).toBeGreaterThanOrEqual(1);
    expect(town.unemployed).toBe(town.pop - town.employed - (town.ofMeans ?? 0));
    const L = s.stats.latest as Record<string, number>;
    const force = L.pop - L.ofMeans;
    expect(L.unemp).toBeCloseTo(L.unemployed / force, 9);
    // a month on (their income kept up): still no job, no days counted out of work, still here
    for (let d = 0; d < 30; d++) {
      p.capInc = 50 * Math.max(1, s.towns[p.town].avgWage);
      stepDay(s);
    }
    expect(p.alive).toBe(true);
    expect(p.job).toBe(-1);
    expect(p.unempDays).toBe(0);
    expect(p.means).toBe(true);
    // the fortune gone: back to the labour market
    p.capInc = 0;
    stepDay(s);
    expect(p.means).toBeUndefined();
  });

  it('a save keeps who lives on their means; damaged fields are dropped', () => {
    const s = grown();
    const p = s.people.find((x) => x.alive)!;
    p.capInc = 123.5;
    p.means = true;
    const t = deserialize(serialize(s));
    expect(t.people[p.id].capInc).toBe(123.5);
    expect(t.people[p.id].means).toBe(true);
    const raw = JSON.parse(serialize(s));
    raw.people[p.id].capInc = 'lots';
    raw.people[p.id].means = 'yes';
    const u = deserialize(JSON.stringify(raw));
    expect(u.people[p.id].capInc).toBeUndefined();
    expect(u.people[p.id].means).toBeUndefined();
  });

  it('over a year, some of the richest live on their means and the ledger holds', () => {
    const s = createWorld({ seed: 1 });
    s.settings.events = false;
    for (let d = 0; d < 360; d++) stepDay(s);
    const means = s.people.filter((p) => p.alive && p.means);
    expect(means.length).toBeGreaterThan(0);
    expect(means.length).toBeLessThan(0.15 * s.people.filter((p) => p.alive).length);
    for (const p of means) expect(p.job).toBe(-1);
    expect((s.stats.latest as Record<string, number>).ofMeans).toBe(means.length);
  }, 120_000);
});
