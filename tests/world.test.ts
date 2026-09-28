// World generation, layout, pathfinding and founding calibration.
import { beforeAll, describe, expect, it } from 'vitest';
import { INIT_UNEMPLOYMENT, OWNER_SHARE, SPEED_DIRT } from '../src/sim/config';
import { G, N_GOODS, PRODUCER_SECTORS, SECTORS } from '../src/sim/goods';
import { checkLedger, deposits, loansOutstanding } from '../src/sim/ledger';
import { rt } from '../src/sim/runtime';
import { Terrain, STATE, type SimState } from '../src/sim/types';
import { createWorld, foundingCurve, householdSteady, stationaryPlan } from '../src/sim/world/init';
import { findSite, footprintOf, isValidSite, placeBuilding, removeBuilding, siteMultiplier } from '../src/sim/world/layout';
import { generateMap, tileResource } from '../src/sim/world/mapgen';
import { commutePath, deliveryPath, findPath, pathDays, roadPlan, routeBetweenTowns } from '../src/sim/world/paths';
import { firmName, personName, townName } from '../src/sim/world/names';
import { SCENARIOS } from '../src/sim/world/scenarios';

/** Every number finite; only plain objects/arrays/strings/booleans/null. */
function scanPlain(v: unknown, path: string, out: string[]): void {
  if (out.length > 10) return;
  if (v === null) return;
  const t = typeof v;
  if (t === 'number') {
    if (!Number.isFinite(v as number)) out.push(`${path} = ${v}`);
    return;
  }
  if (t === 'string' || t === 'boolean') return;
  if (t === 'undefined') {
    out.push(`${path} is undefined`);
    return;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) scanPlain(v[i], `${path}[${i}]`, out);
    return;
  }
  if (t === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      out.push(`${path} is a ${proto?.constructor?.name ?? 'non-plain object'}`);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) scanPlain(x, `${path}.${k}`, out);
    return;
  }
  out.push(`${path} has type ${t}`);
}

let s: SimState;
beforeAll(() => {
  s = createWorld({ seed: 1 });
});

describe('createWorld', () => {
  it('is deterministic for a seed', () => {
    const a = JSON.stringify(createWorld({ seed: 7 }));
    const b = JSON.stringify(createWorld({ seed: 7 }));
    expect(a).toBe(b);
    expect(JSON.stringify(createWorld({ seed: 8 }))).not.toBe(a);
  });

  it('contains only plain, finite JSON data', () => {
    const bad: string[] = [];
    scanPlain(s, 's', bad);
    expect(bad).toEqual([]);
    // Round trip keeps everything.
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('keeps the bank balance sheet exact', () => {
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
    expect(s.bank.equity).toBeGreaterThan(0);
    const L = loansOutstanding(s);
    expect(L).toBeGreaterThan(0);
    // equity ≈ max(min, ratio × loans)
    expect(s.bank.equity).toBeGreaterThanOrEqual(7999);
    expect(s.bank.reserves).toBeGreaterThan(0);
    expect(deposits(s)).toBeGreaterThan(0);
    for (const p of s.people) expect(p.cash).toBeGreaterThanOrEqual(0);
    for (const f of s.firms) expect(f.cash).toBeGreaterThanOrEqual(0);
  });

  it('has four towns of each kind with a market for every good', () => {
    expect(s.towns.map((t) => t.kind).sort()).toEqual(['capital', 'farm', 'harbor', 'mining']);
    expect(s.towns.filter((t) => t.hasPort).length).toBe(1);
    expect(s.markets.length).toBe(s.towns.length * N_GOODS);
    for (const t of s.towns) {
      for (let g = 0; g < N_GOODS; g++) {
        const m = s.markets[t.id * N_GOODS + g];
        expect(m).toBeDefined();
        expect(m.town).toBe(t.id);
        expect(m.good).toBe(g);
        expect(m.price).toBeGreaterThan(0);
        expect(m.ema).toBe(m.price);
      }
      const hall = s.buildings[t.market];
      expect(hall.kind).toBe('market');
      expect(hall.town).toBe(t.id);
    }
    const kinds = s.buildings.map((b) => b.kind);
    expect(kinds.filter((k) => k === 'palace').length).toBe(1);
    expect(kinds.filter((k) => k === 'bank').length).toBe(1);
    expect(kinds.filter((k) => k === 'port').length).toBe(1);
  });

  it('connects every pair of towns by a finite route over tracks', () => {
    for (let a = 0; a < s.towns.length; a++) {
      for (let b = 0; b < s.towns.length; b++) {
        const r = routeBetweenTowns(s, a, b);
        expect(Number.isFinite(r.days)).toBe(true);
        if (a === b) continue;
        expect(r.tiles.length).toBeGreaterThan(2);
        expect(r.days).toBeGreaterThan(0);
        expect(r.days).toBeLessThan(6);
        // Founding tracks: essentially the whole way on dirt.
        expect(r.dirt).toBeGreaterThan(0.8 * r.length);
        expect(Math.abs(r.days - pathDays(s, r.tiles))).toBeLessThan(1e-3);
      }
    }
  });

  it('houses (almost) everyone and employs 1 − INIT_UNEMPLOYMENT', () => {
    const alive = s.people.filter((p) => p.alive);
    const housed = alive.filter((p) => p.home >= 0).length;
    expect(housed / alive.length).toBeGreaterThanOrEqual(0.9);
    const employed = alive.filter((p) => p.job >= 0).length;
    expect(Math.abs(employed / alive.length - (1 - INIT_UNEMPLOYMENT))).toBeLessThan(0.015);
    // Houses and residents agree.
    for (const b of s.buildings) {
      if (b.kind !== 'house') continue;
      expect(b.residents.length).toBeLessThanOrEqual(b.slots);
      for (const id of b.residents) expect(s.people[id].home).toBe(b.id);
    }
    // Jobs and workers agree.
    for (const f of s.firms) for (const id of f.workers) expect(s.people[id].job).toBe(f.id);
    for (const p of alive) if (p.job >= 0) expect(s.firms[p.job].workers).toContain(p.id);
    // Town derived fields match.
    for (const t of s.towns) {
      const ppl = alive.filter((p) => p.town === t.id);
      expect(t.pop).toBe(ppl.length);
      expect(t.employed).toBe(ppl.filter((p) => p.job >= 0).length);
    }
  });

  it('has every producer sector somewhere, with workers and tools', () => {
    for (const sec of PRODUCER_SECTORS) {
      const fs = s.firms.filter((f) => f.alive && f.sector === sec);
      expect(fs.length, sec).toBeGreaterThan(0);
      for (const f of fs) {
        expect(f.workers.length, f.name).toBeGreaterThan(0);
        expect(f.tools, f.name).toBeGreaterThan(0);
        expect(f.wage).toBeGreaterThan(0);
        expect(f.pExp).toBeGreaterThan(0);
        expect(f.output).toBeGreaterThan(0);
        expect(f.capacity).toBeGreaterThanOrEqual(f.workers.length);
        expect(f.target).toBe(f.workers.length);
        const b = s.buildings[f.building];
        expect(b.firm).toBe(f.id);
        expect(b.sector).toBe(sec);
        expect(b.owner).toBe(f.owner);
      }
    }
    for (const t of s.towns) {
      const here = s.firms.filter((f) => f.town === t.id);
      expect(here.filter((f) => f.sector === 'bakery').length).toBeGreaterThan(0);
      expect(here.filter((f) => f.sector === 'builder').length).toBe(1);
      expect(here.filter((f) => f.sector === 'trader').length).toBe(1);
      const sw = here.filter((f) => f.sector === 'stateworks');
      expect(sw.length).toBe(1);
      expect(sw[0].building).toBe(-1);
      expect(sw[0].owner).toBe(STATE);
      expect(sw[0].target).toBe(0);
      const tr = here.find((f) => f.sector === 'trader')!;
      expect(tr.trade!.wagons).toBeGreaterThanOrEqual(tr.trade!.busy.length);
      expect(tr.workers.length).toBeGreaterThan(0);
    }
  });

  it('gives OWNER_SHARE of people firms or houses; the bank owner lives in the capital', () => {
    const alive = s.people.filter((p) => p.alive);
    const owners = alive.filter((p) => p.owns.length > 0 || p.houses.length > 0);
    expect(Math.abs(owners.length / alive.length - OWNER_SHARE)).toBeLessThan(0.02);
    for (const f of s.firms) {
      if (f.sector === 'stateworks') continue;
      expect(s.people[f.owner].owns).toContain(f.id);
    }
    const bo = s.people[s.bank.owner];
    expect(s.towns[bo.town].kind).toBe('capital');
  });

  it('starts shipments in transit toward importing towns and prices imports higher', () => {
    expect(s.shipments.length).toBeGreaterThan(0);
    for (const sh of s.shipments) {
      expect(sh.arrive).toBeGreaterThan(0);
      expect(sh.qty).toBeGreaterThan(0);
      expect(sh.from).not.toBe(sh.to);
    }
    const farm = s.towns.find((t) => t.kind === 'farm')!;
    const cap = s.towns.find((t) => t.kind === 'capital')!;
    expect(s.markets[cap.id * N_GOODS + G.grain].price).toBeGreaterThan(s.markets[farm.id * N_GOODS + G.grain].price);
  });

  it('runs fast', () => {
    const t0 = performance.now();
    createWorld({ seed: 3 });
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('has a founding news item', () => {
    expect(s.news.length).toBeGreaterThan(0);
    expect(s.news[s.news.length - 1].text).toContain('founded');
  });
});

describe('mapgen', () => {
  it('puts sea along the south and east and resources near each town', () => {
    for (const seed of [1, 2, 5, 11]) {
      const { map, sites } = generateMap(seed);
      expect(sites.map((x) => x.kind)).toEqual(['capital', 'farm', 'mining', 'harbor']);
      const at = (x: number, y: number) => map.terrain[y * map.w + x];
      expect([Terrain.Water, Terrain.DeepWater]).toContain(at(map.w - 1, map.h - 1));
      expect([Terrain.Water, Terrain.DeepWater]).not.toContain(at(0, 0));
      const near = (sx: number, sy: number, good: number, r = 11) => {
        let n = 0;
        for (let y = Math.max(0, sy - r); y <= Math.min(map.h - 1, sy + r); y++)
          for (let x = Math.max(0, sx - r); x <= Math.min(map.w - 1, sx + r); x++) if (tileResource(map, y * map.w + x) === good && map.deposit[y * map.w + x] > 0.3) n++;
        return n;
      };
      const mining = sites[2];
      expect(near(mining.x, mining.y, G.coal)).toBeGreaterThan(2);
      expect(near(mining.x, mining.y, G.ore)).toBeGreaterThan(2);
      expect(near(mining.x, mining.y, G.wood)).toBeGreaterThan(3);
      const harbor = sites[3];
      expect(near(harbor.x, harbor.y, G.oil)).toBeGreaterThan(1);
      expect(near(harbor.x, harbor.y, G.fish)).toBeGreaterThan(4);
      // One river, 4-connected, reaching the sea.
      const riv: number[] = [];
      for (let i = 0; i < map.river.length; i++) if (map.river[i]) riv.push(i);
      expect(riv.length).toBeGreaterThan(20);
      let touchesSea = false;
      for (const i of riv) {
        const x = i % map.w;
        const y = (i - x) / map.w;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const t = at(x + dx, y + dy);
          if (t === Terrain.Water || t === Terrain.DeepWater) touchesSea = true;
        }
      }
      expect(touchesSea).toBe(true);
      // Plain arrays of finite numbers.
      for (const k of ['terrain', 'elev', 'fert', 'deposit', 'river', 'road', 'occ', 'district'] as const) {
        expect(Array.isArray(map[k])).toBe(true);
        expect(map[k].length).toBe(map.w * map.h);
        expect(map[k].every((v) => Number.isFinite(v))).toBe(true);
      }
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(generateMap(42))).toBe(JSON.stringify(generateMap(42)));
  });
});

describe('paths', () => {
  it('finds nothing into open water and routes around it', () => {
    const m = s.map;
    let water = -1;
    let land = -1;
    for (let i = 0; i < m.terrain.length; i++) {
      if (water < 0 && m.terrain[i] === Terrain.DeepWater) water = i;
      if (land < 0 && m.terrain[i] === Terrain.Grass && m.road[i] === 0 && m.occ[i] < 0 && !m.river[i]) land = i;
    }
    expect(water).toBeGreaterThanOrEqual(0);
    // A water goal is entered only as an endpoint; a deep-sea tile surrounded by water is unreachable.
    let deep = -1;
    for (let i = 0; i < m.terrain.length && deep < 0; i++) {
      const x = i % m.w;
      const y = (i - x) / m.w;
      if (x < 2 || y < 2 || x > m.w - 3 || y > m.h - 3) continue;
      let all = true;
      for (let dy = -2; dy <= 2 && all; dy++) for (let dx = -2; dx <= 2; dx++) if (m.terrain[(y + dy) * m.w + x + dx] !== Terrain.DeepWater) all = false;
      if (all) deep = i;
    }
    expect(deep).toBeGreaterThanOrEqual(0);
    expect(findPath(s, land, deep)).toEqual([]);
    // Every step of a found path is on passable land (or the endpoints).
    const cap = s.towns.find((t) => t.kind === 'capital')!;
    const har = s.towns.find((t) => t.kind === 'harbor')!;
    const p = findPath(s, cap.y * m.w + cap.x, har.y * m.w + har.x);
    expect(p.length).toBeGreaterThan(2);
    for (let k = 1; k < p.length - 1; k++) {
      const t = m.terrain[p[k]];
      expect(t === Terrain.Water || t === Terrain.DeepWater).toBe(false);
      if (m.river[p[k]]) expect(m.road[p[k]]).toBeGreaterThan(0); // only bridges
    }
    // Steps are 8-neighbour moves.
    for (let k = 1; k < p.length; k++) {
      const a = p[k - 1];
      const b = p[k];
      expect(Math.abs((a % m.w) - (b % m.w))).toBeLessThanOrEqual(1);
      expect(Math.abs(Math.floor(a / m.w) - Math.floor(b / m.w))).toBeLessThanOrEqual(1);
    }
  });

  it('crosses the river only at bridges', () => {
    const m = s.map;
    // Find a bridge and the land tiles on either side of it.
    let bridge = -1;
    for (let i = 0; i < m.river.length; i++) if (m.river[i] && m.road[i] > 0) bridge = i;
    expect(bridge).toBeGreaterThanOrEqual(0);
    const bx = bridge % m.w;
    const by = (bridge - bx) / m.w;
    const horiz = !m.river[bridge - 1] && !m.river[bridge + 1];
    const a = horiz ? bridge - 1 : bridge - m.w;
    const b = horiz ? bridge + 1 : bridge + m.w;
    const p = findPath(s, a, b);
    expect(p.length).toBeGreaterThan(1);
    expect(p).toContain(bridge);
    // Remove the bridge: the crossing gets longer (another bridge) or impossible.
    const saved = m.road[bridge];
    m.road[bridge] = 0;
    rt(s).roadVersion++;
    rt(s).paths.clear();
    rt(s).routes.clear();
    const p2 = findPath(s, a, b);
    expect(p2.includes(bridge)).toBe(false);
    if (p2.length) expect(pathDays(s, p2)).toBeGreaterThan(pathDays(s, p));
    m.road[bridge] = saved;
    rt(s).roadVersion++;
    rt(s).paths.clear();
    rt(s).routes.clear();
    void bx;
    void by;
  });

  it('caches paths and routes, and plans roads over unpaved tiles', () => {
    const r1 = routeBetweenTowns(s, 0, 1);
    expect(routeBetweenTowns(s, 0, 1)).toBe(r1);
    const plan = roadPlan(s, 0, 1);
    expect(plan.length).toBeGreaterThan(5);
    for (const i of plan) {
      expect(s.map.road[i]).toBeLessThan(2);
      expect(s.map.occ[i]).toBe(-1);
    }
    // Paving the plan speeds the route up (after invalidation).
    const before = r1.days;
    const saved = plan.map((i) => s.map.road[i]);
    for (const i of plan) s.map.road[i] = 2;
    rt(s).paths.clear();
    rt(s).routes.clear();
    rt(s).roadVersion++;
    const r2 = routeBetweenTowns(s, 0, 1);
    expect(r2.days).toBeLessThan(before * 0.6);
    expect(r2.paved).toBeGreaterThan(0);
    plan.forEach((i, k) => (s.map.road[i] = saved[k]));
    rt(s).paths.clear();
    rt(s).routes.clear();
    rt(s).roadVersion++;
    expect(routeBetweenTowns(s, 0, 1).days).toBeCloseTo(before, 6);
  });

  it('gives commute and delivery paths', () => {
    const worker = s.people.find((p) => p.job >= 0 && p.home >= 0 && s.firms[p.job].building >= 0)!;
    const cp = commutePath(s, worker.id);
    expect(cp.length).toBeGreaterThan(0);
    const home = s.buildings[worker.home];
    const hx = cp[0] % s.map.w;
    const hy = Math.floor(cp[0] / s.map.w);
    expect(hx).toBe(home.x);
    expect(hy).toBe(home.y);
    const idle = s.people.find((p) => p.job < 0);
    if (idle) expect(commutePath(s, idle.id)).toEqual([]);
    const f = s.firms.find((x) => x.sector === 'bakery')!;
    const dp = deliveryPath(s, f.building);
    expect(dp.length).toBeGreaterThan(0);
    const last = dp[dp.length - 1];
    const t = s.towns[f.town];
    expect(last).toBe(t.y * s.map.w + t.x);
  });
});

describe('layout', () => {
  it('findSite returns valid sites; placeBuilding marks occupancy and lays a track; removeBuilding frees it', () => {
    const w = createWorld({ seed: 2 });
    const farm = w.towns.find((t) => t.kind === 'farm')!;
    for (const what of ['house', 'bakery', 'farm', 'furniture'] as const) {
      const p = findSite(w, what, farm.id);
      expect(p, what).not.toBeNull();
      expect(isValidSite(w, what, p!.x, p!.y, farm.id)).toBe(true);
    }
    const p = findSite(w, 'bakery', farm.id)!;
    const b = placeBuilding(w, 'firm', 'bakery', farm.id, p.x, p.y, 'construction');
    expect(w.buildings[b.id]).toBe(b);
    expect(w.map.occ[p.y * w.map.w + p.x]).toBe(b.id);
    expect(isValidSite(w, 'bakery', p.x, p.y, farm.id)).toBe(false);
    // Reachable from the market over the network.
    const dp = deliveryPath(w, b.id);
    expect(dp.length).toBeGreaterThan(0);
    removeBuilding(w, b);
    expect(w.map.occ[p.y * w.map.w + p.x]).toBe(-1);
    expect(b.status).toBe('ruin');
    // Water is never valid for land buildings; a pier needs the harbour's shallows.
    const m = w.map;
    const wi = m.terrain.findIndex((t) => t === Terrain.DeepWater);
    expect(isValidSite(w, 'house', wi % m.w, Math.floor(wi / m.w))).toBe(false);
    const har = w.towns.find((t) => t.hasPort)!;
    const pier = findSite(w, 'pier', har.id);
    expect(pier).not.toBeNull();
    const [pw, ph] = footprintOf('port', '');
    for (let y = pier!.y; y < pier!.y + ph; y++) for (let x = pier!.x; x < pier!.x + pw; x++) expect(m.terrain[y * m.w + x]).toBe(Terrain.Water);
    expect(findSite(w, 'pier', farm.id)).toBeNull();
  });

  it('puts resource firms on their resource and scores sites by it', () => {
    for (const f of s.firms) {
      if (!f.alive || f.building < 0) continue;
      const b = s.buildings[f.building];
      const i = b.y * s.map.w + b.x;
      const t = s.map.terrain[i];
      switch (f.sector) {
        case 'farm':
          expect(t).toBe(Terrain.Grass);
          break;
        case 'lumber':
          expect(t).toBe(Terrain.Forest);
          break;
        case 'coalmine':
          expect(tileResource(s.map, i)).toBe(G.coal);
          break;
        case 'oremine':
          expect(tileResource(s.map, i)).toBe(G.ore);
          break;
        case 'oilwell':
          expect(t).toBe(Terrain.Marsh);
          break;
        case 'fishery':
          expect(tileResource(s.map, i)).toBe(G.fish);
          break;
        default:
          expect(siteMultiplier(s, b)).toBe(1);
      }
      if (['farm', 'lumber', 'coalmine', 'oremine', 'oilwell', 'fishery'].includes(f.sector)) {
        const m = siteMultiplier(s, b);
        expect(m).toBeGreaterThan(0.6);
        expect(m).toBeLessThanOrEqual(1.4);
      }
    }
  });

  it('assigns districts to every building footprint', () => {
    for (const b of s.buildings) {
      if (b.status === 'ruin') continue;
      expect(s.map.district[b.y * s.map.w + b.x]).toBe(b.town);
    }
  });
});

describe('founding state helpers', () => {
  it('seeds every market with an order-book snapshot at its price', () => {
    for (const m of s.markets) {
      expect(m.curve).not.toBeNull();
      const c = m.curve!;
      expect(c.price).toBe(m.price);
      // bids descending in price with rising cumulative quantity; asks ascending
      for (let i = 2; i + 1 < c.bids.length; i += 2) {
        expect(c.bids[i]).toBeLessThan(c.bids[i - 2]);
        expect(c.bids[i + 1]).toBeGreaterThanOrEqual(c.bids[i - 1]);
      }
      for (let i = 2; i + 1 < c.asks.length; i += 2) {
        expect(c.asks[i]).toBeGreaterThan(c.asks[i - 2]);
        expect(c.asks[i + 1]).toBeGreaterThanOrEqual(c.asks[i - 1]);
      }
    }
    const c = foundingCurve(10, 50, 40, 1);
    expect(c.bids.length).toBe(16);
    expect(c.bids[0]).toBeCloseTo(25);
    expect(c.asks[c.asks.length - 1]).toBeCloseTo(40);
  });

  it('household mini-simulation reaches the stationary point of the buffer rule', () => {
    const P = [3.7, 6.8, 3.4, 3.4, 3.1, 3.7, 13.7, 25, 5.2, 3.5, 25];
    const w = householdSteady(P, 9.5, 1.6, 400);
    // Over the year a household spends what it earns (net of rent).
    expect(w.spend).toBeGreaterThan(0.95 * (9.5 - 1.6));
    expect(w.spend).toBeLessThan(1.05 * (9.5 - 1.6));
    expect(w.cash.length).toBe(20);
    for (const c of w.cash) expect(c).toBeGreaterThan(0);
    for (const pan of w.pantry) for (const x of pan) expect(Number.isFinite(x) && x >= 0).toBe(true);
    // Everyone eats: bread + fish ≥ subsistence; well-off owners buy more luxuries.
    expect(w.q[G.bread] + w.q[G.fish]).toBeGreaterThan(1);
    const o = householdSteady(P, 40, 0, 2500);
    expect(o.q[G.furniture]).toBeGreaterThan(w.q[G.furniture]);
    expect(o.q[G.ale]).toBeGreaterThan(w.q[G.ale]);
    // The analytic plan is the upper envelope of what the rules buy for luxuries.
    const plan = stationaryPlan(P, 9.5, 1.6).q;
    expect(w.q[G.furniture]).toBeLessThanOrEqual(plan[G.furniture] * 1.05);
    // Founding households hold cash at that stationary point (scaled to income).
    const worker = s.people.find((p) => p.job >= 0 && p.owns.length === 0 && p.houses.length === 0)!;
    expect(worker.cash).toBeGreaterThan(50);
    expect(worker.pantry[G.bread]).toBeGreaterThan(0);
  });
});

describe('names', () => {
  it('generates varied names', () => {
    const h = { rng: [1, 2, 3, 4] };
    const people = new Set<string>();
    for (let i = 0; i < 300; i++) people.add(personName(h));
    expect(people.size).toBeGreaterThan(250);
    for (const n of people) expect(n.split(' ').length).toBe(2);
    const towns = new Set<string>();
    for (let i = 0; i < 60; i++) towns.add(townName(h, 'mining'));
    expect(towns.size).toBeGreaterThan(10);
    expect(firmName(h, 'Bakery', 'Millbrook')).toMatch(/Bakery$/);
  });
});

describe('scenarios', () => {
  it('lists presets with neutral wording and applies them', () => {
    expect(SCENARIOS.map((x) => x.id)).toEqual(['founding', 'longwinter', 'creditboom', 'isolated']);
    const banned = /subsid|tax|tariff|stimul|bailout|quota|minimum wage|\bqe\b|\bubi\b/i;
    for (const sc of SCENARIOS) expect(banned.test(sc.name + ' ' + sc.description)).toBe(false);

    const iso = createWorld({ seed: 4, scenario: 'isolated' });
    expect(iso.settings.scenario).toBe('isolated');
    expect(iso.foreign.shipCap.every((x) => x === 0)).toBe(true);
    expect(iso.foreign.world.every((x) => x === 0)).toBe(true);
    expect(Math.abs(checkLedger(iso))).toBeLessThan(1e-6);

    const lw = createWorld({ seed: 4, scenario: 'longwinter' });
    expect(lw.towns.find((t) => t.kind === 'farm')!.droughtDays).toBeGreaterThan(0);
    expect(lw.foreign.shocks.some((k) => k.good === G.grain && k.factor > 1)).toBe(true);

    const base = createWorld({ seed: 4 });
    const cb = createWorld({ seed: 4, scenario: 'creditboom' });
    expect(cb.loans.length).toBeGreaterThan(base.loans.length);
    expect(loansOutstanding(cb)).toBeGreaterThan(loansOutstanding(base));
    expect(cb.treasury.lendRate).toBeLessThan(base.treasury.lendRate);
    expect(Math.abs(checkLedger(cb))).toBeLessThan(1e-6);
    for (const w of [iso, lw, cb]) for (const n of w.news) expect(banned.test(n.text)).toBe(false);
  });
});

describe('calibration', () => {
  it('sizes production near household demand and keeps prices plausible', () => {
    // National output of bread + fish ≈ food need × population (founding is fed).
    const pop = s.people.length;
    let bread = 0;
    let fish = 0;
    for (const f of s.firms) {
      if (f.sector === 'bakery') bread += f.output;
      if (f.sector === 'fishery') fish += f.output;
    }
    const food = bread + fish * 0.85; // some fish spoils on the way inland
    expect(food / pop).toBeGreaterThan(0.95);
    expect(food / pop).toBeLessThan(1.45);
    // Local prices stay within a sane band of each other.
    for (let g = 0; g < N_GOODS; g++) {
      const ps = s.towns.map((t) => s.markets[t.id * N_GOODS + g].price);
      expect(Math.max(...ps) / Math.min(...ps)).toBeLessThan(2.6);
    }
    // Everyone can afford subsistence on a wage.
    const cap = s.towns.find((t) => t.kind === 'capital')!;
    const pb = s.markets[cap.id * N_GOODS + G.bread].price;
    expect(pb).toBeLessThan(10 * 0.8);
    // Firms at founding are not losing money.
    for (const f of s.firms) if (SECTORS[f.sector].producer) expect(f.profit, f.name).toBeGreaterThan(0);
    void SPEED_DIRT;
  });
});
