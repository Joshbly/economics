// Which town a building belongs to (world/belonging.ts), borders that grow with the towns,
// and ventures that choose their sites on their merits with the access track in the works.
import { describe, expect, it } from 'vitest';
import { roadNeed, startProject } from '../src/sim/agents/construction';
import { ventureSite } from '../src/sim/agents/sites';
import { BELONG_CORE, VENTURE_REACH } from '../src/sim/config';
import { stepDay } from '../src/sim/engine';
import { Game } from '../src/sim/game';
import { SECTORS } from '../src/sim/goods';
import { belongingOf, belongingOfPlace, belongingReason, coreTown, redrawDistricts, settleTowns, townReach, townsStep } from '../src/sim/world/belonging';
import { doorTile, isResourceSector } from '../src/sim/world/layout';
import type { Building, SimState } from '../src/sim/types';

function world(seed = 1): SimState {
  const g = Game.create({ seed, warmup: false });
  g.s.settings.events = false;
  return g.s;
}

const oneHot = (s: SimState, t: number) => s.towns.map((_, k) => (k === t ? 1 : 0));

describe('belonging: the hierarchy of rules', () => {
  it('inside a town’s core: that town, whatever the roads, workers or owner', () => {
    const s = world();
    const [a, b] = s.towns;
    const x = a.x + 1;
    const y = a.y + 1;
    expect(coreTown(s, x + 0.5, y + 0.5)).toBe(a.id);
    const t = belongingOfPlace(s, { x, y, w: 1, h: 1, door: -1, people: oneHot(s, b.id), ownerTown: b.id, now: b.id });
    expect(t).toBe(a.id);
  });

  it('further out, people, owner and roads decide; the current town keeps a little in hand', () => {
    const s = world();
    const [a, b] = s.towns;
    // half-way between two towns, just outside both cores
    const x = Math.round((a.x + b.x) / 2);
    const y = Math.round((a.y + b.y) / 2);
    expect(coreTown(s, x + 0.5, y + 0.5)).toBe(-1);
    const door = y * s.map.w + x;
    const toA = belongingOfPlace(s, { x, y, w: 1, h: 1, door, people: oneHot(s, a.id), ownerTown: a.id, now: a.id });
    const toB = belongingOfPlace(s, { x, y, w: 1, h: 1, door, people: oneHot(s, b.id), ownerTown: b.id, now: b.id });
    expect(toA).toBe(a.id);
    expect(toB).toBe(b.id);
    // the road reach is finite from the realm's roads
    expect(Number.isFinite(townReach(s)[a.id][a.y * s.map.w + a.x])).toBe(true);
  });

  it('a new world starts settled; every building has a reason in words', () => {
    const s = world();
    for (const bl of s.buildings) {
      if (!bl || bl.status === 'ruin' || (bl.kind !== 'firm' && bl.kind !== 'house')) continue;
      expect(belongingOf(s, bl), bl.id + '').toBe(bl.town);
    }
    const f = s.buildings.find((x) => x && x.kind === 'firm' && isResourceSector(x.sector))!;
    expect(belongingReason(s, f)).toMatch(/belongs to|stands within/);
    expect(settleTowns(s)).toBe(0);
  });

  it('at the turn of the month a workshop that belongs elsewhere moves, with its market and district', () => {
    const s = world();
    // a resource workshop outside every core
    const b = s.buildings.find((x): x is Building => !!x && x.kind === 'firm' && x.firm >= 0 && isResourceSector(x.sector) && coreTown(s, x.x + x.w / 2, x.y + x.h / 2) < 0);
    expect(b).toBeDefined();
    const f = s.firms[b!.firm];
    const other = s.towns.find((t) => t.id !== b!.town)!;
    // its workers and owner now live in the other town, and it is relabelled nowhere else
    for (const id of f.workers) s.people[id].town = other.id;
    if (f.owner >= 0 && s.people[f.owner]) s.people[f.owner].town = other.id;
    const want = belongingOf(s, b!);
    while (s.day % 30 !== 0) s.day++;
    townsStep(s);
    expect(b!.town).toBe(want);
    expect(f.town).toBe(want);
    const i = b!.y * s.map.w + b!.x;
    expect(s.map.district[i]).toBe(want);
  });

  it('districts grow out from a town’s outermost buildings', () => {
    const s = world();
    const t = s.towns[0];
    // count tiles a few steps beyond a lone building placed outside the town
    const far = s.buildings.filter((x) => x && x.town === t.id && Math.hypot(x.x - t.x, x.y - t.y) > Math.max(3, t.radius) + BELONG_CORE + 3);
    redrawDistricts(s);
    for (const bl of far) {
      const i = bl.y * s.map.w + bl.x;
      expect(s.map.district[i]).toBe(t.id);
      // its neighbourhood is the town's too
      const j = Math.min(s.map.w - 1, bl.x + 2) + bl.y * s.map.w;
      expect(s.map.district[j] === t.id || s.map.occ[j] >= 0).toBe(true);
    }
  });
});

describe('ventures choose their sites on their merits', () => {
  it('a resource site within reach that counts as the town’s own, its track in the works', () => {
    const s = world(1);
    const cap = s.towns.find((t) => t.kind === 'capital')!;
    const vs = ventureSite(s, 'fishery', cap.id);
    expect(vs).not.toBeNull();
    const [w, h] = SECTORS.fishery.footprint;
    expect(Math.hypot(vs!.x + w / 2 - cap.x, vs!.y + h / 2 - cap.y)).toBeLessThanOrEqual(VENTURE_REACH + 1e-9);
    const door = doorTile(s, { x: vs!.x, y: vs!.y, w, h, town: cap.id });
    expect(belongingOfPlace(s, { x: vs!.x, y: vs!.y, w, h, door, people: oneHot(s, cap.id), ownerTown: cap.id, now: -1 })).toBe(cap.id);
    expect(vs!.rel).toBeGreaterThanOrEqual(0.3);
    expect(vs!.rel).toBeLessThanOrEqual(2);
    // the project includes the track to the road, laid when it is finished
    const owner = s.people.find((p) => p.alive)!.id;
    const p = startProject(s, { kind: 'firm', town: cap.id, owner, sector: 'fishery', x: vs!.x, y: vs!.y, anywhere: true });
    expect(typeof p).not.toBe('string');
    if (typeof p === 'string' || !p) return;
    expect(p.tiles.length).toBe(vs!.access.length);
    const track = roadNeed(s, p.tiles, 1).labor;
    expect(p.need.labor).toBeCloseTo(SECTORS.fishery.buildCost.labor + track, 6);
    for (const i of p.tiles) expect(s.map.road[i]).toBe(0);
  });

  it('runs a couple of years with ventures and monthly belonging without breaking the books', () => {
    const s = world(2);
    for (let d = 0; d < 400; d++) stepDay(s);
    for (const bl of s.buildings) if (bl && bl.kind === 'firm' && bl.firm >= 0 && s.firms[bl.firm]?.alive) expect(s.firms[bl.firm].town).toBe(bl.town);
    for (const p of s.people) if (p.alive && p.home >= 0) expect(p.town).toBe(s.buildings[p.home].town);
  }, 90000); // 400 days of a whole realm
});

describe('trading houses build the roads that pay them', () => {
  it('a house with heavy traffic on an unpaved lane has it paved, and pays for it', async () => {
    const { roadVentures } = await import('../src/sim/agents/entry');
    const { roadPlan } = await import('../src/sim/world/paths');
    const { freightPerUnit } = await import('../src/sim/agents/traders');
    const s = world(1);
    const f = s.firms.find((x) => x && x.alive && x.trade && x.owner !== -1)!;
    const a = f.town;
    const b = s.towns.map((t) => t.id).find((t) => t !== a && roadPlan(s, a, t).length > 5 && freightPerUnit(s, a, t) > 0)!;
    expect(b).toBeDefined();
    f.trade!.lane = s.towns.map((_, k) => (k === b ? 400 : 0));
    f.founded = s.day - 1000;
    f.cash += 50000;
    let p;
    for (let k = 0; k < 20 && !p; k++) {
      roadVentures(s);
      p = s.projects.find((x) => x.kind === 'road' && x.owner === 1_000_000 + f.id);
    }
    expect(p).toBeDefined();
    expect(p!.label).toMatch(new RegExp(s.towns[b].name));
    expect(p!.tiles.length).toBeGreaterThan(0);
    // one road at a time
    const n = s.projects.filter((x) => x.kind === 'road' && x.owner === 1_000_000 + f.id).length;
    roadVentures(s);
    expect(s.projects.filter((x) => x.kind === 'road' && x.owner === 1_000_000 + f.id).length).toBe(n);
  });

  it('no traffic, no road', async () => {
    const { roadVentures } = await import('../src/sim/agents/entry');
    const s = world(1);
    for (const f of s.firms) if (f && f.trade) f.trade.lane = s.towns.map(() => 0);
    for (let k = 0; k < 10; k++) roadVentures(s);
    expect(s.projects.some((x) => x.kind === 'road' && x.owner !== -1)).toBe(false);
  });
});
