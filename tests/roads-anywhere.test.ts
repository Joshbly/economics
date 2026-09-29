// The Treasury builds roads anywhere (Build → Road): between two towns or two tiles, paved or a
// dirt track. Costs follow the ground (clearing, bridges); tracks join the road network the
// wagons and walkers use.
import { describe, expect, it } from 'vitest';
import { needCost, roadNeed, roadTileNeed } from '../src/sim/agents/construction';
import { TRACK_CLEAR_FACTOR } from '../src/sim/config';
import { Game } from '../src/sim/game';
import { BRIDGE_TILE_COST, ROAD_TILE_COST, TRACK_TILE_COST } from '../src/sim/goods';
import { checkLedger } from '../src/sim/ledger';
import { dispatch } from '../src/sim/policy/player';
import { deserialize, serialize } from '../src/sim/save';
import { Terrain, type SimState } from '../src/sim/types';
import { nearestTown } from '../src/sim/world/layout';
import { findPath, trackPlan } from '../src/sim/world/paths';

/** Two open tiles some way from any road, `d` apart on one row (null if the map has none). */
function openStretch(s: SimState, d: number): { a: number; b: number } | null {
  const m = s.map;
  const open = (i: number) => m.road[i] === 0 && m.occ[i] < 0 && m.river[i] === 0 && (m.terrain[i] === Terrain.Grass || m.terrain[i] === Terrain.Sand);
  for (let y = 3; y < m.h - 3; y++)
    for (let x = 3; x + d < m.w - 3; x++) {
      let ok = true;
      for (let k = 0; k <= d && ok; k++) {
        const i = y * m.w + x + k;
        if (!open(i) || m.road[i - m.w] > 0 || m.road[i + m.w] > 0) ok = false;
      }
      if (ok) return { a: y * m.w + x, b: y * m.w + x + d };
    }
  return null;
}

describe('road costs follow the ground', () => {
  it('clearing, bridges and paving add up per tile', () => {
    const g = Game.create({ seed: 1, warmup: false });
    const m = g.s.map;
    const find = (pred: (i: number) => boolean) => m.terrain.findIndex((_, i) => pred(i));
    const grass = find((i) => m.terrain[i] === Terrain.Grass && m.road[i] === 0 && !m.river[i]);
    const forest = find((i) => m.terrain[i] === Terrain.Forest && m.road[i] === 0 && !m.river[i]);
    const dirt = find((i) => m.road[i] === 1 && !m.river[i]);
    const river = find((i) => m.river[i] === 1 && m.road[i] === 0);
    const water = find((i) => m.terrain[i] === Terrain.DeepWater);
    expect(Math.min(grass, forest, dirt, river, water)).toBeGreaterThanOrEqual(0);
    expect(roadTileNeed(m, grass, 1).labor).toBeCloseTo(TRACK_TILE_COST.labor, 9);
    expect(roadTileNeed(m, forest, 1).labor).toBeCloseTo(TRACK_TILE_COST.labor * TRACK_CLEAR_FACTOR[Terrain.Forest], 9);
    expect(roadTileNeed(m, river, 1).wood).toBeCloseTo(BRIDGE_TILE_COST.wood, 9);
    // paving an existing dirt track costs what paving always cost
    expect(roadTileNeed(m, dirt, 2)).toEqual(ROAD_TILE_COST);
    expect(roadTileNeed(m, dirt, 1).labor).toBe(0);
    expect(roadTileNeed(m, grass, 2).labor).toBeCloseTo(TRACK_TILE_COST.labor + ROAD_TILE_COST.labor, 9);
    expect(roadTileNeed(m, water, 1).labor).toBe(0);
    expect(roadNeed(g.s, [grass, forest], 1).labor).toBeCloseTo(roadTileNeed(m, grass, 1).labor + roadTileNeed(m, forest, 1).labor, 9);
  });
});

describe('a Treasury road between any two places', () => {
  it('plans, commissions, builds and joins the network', () => {
    const g = Game.create({ seed: 1, warmup: false });
    const s = g.s;
    s.treasury.autoMint = true;
    const st = openStretch(s, 8);
    expect(st).not.toBeNull();
    const { a, b } = st!;
    const plan = trackPlan(s, a, b, 1);
    expect(plan.path[0]).toBe(a);
    expect(plan.path[plan.path.length - 1]).toBe(b);
    expect(plan.tiles.length).toBe(9);
    const r = dispatch(s, { type: 'build', kind: 'track', a, b, grade: 1 });
    expect(r.ok, r.message).toBe(true);
    const p = s.projects.find((x) => x.id === r.id)!;
    expect(p.kind).toBe('road');
    expect(p.grade).toBe(1);
    expect(p.town).toBe(nearestTown(s, a % s.map.w, Math.floor(a / s.map.w)));
    expect(p.need.labor).toBeCloseTo(roadNeed(s, plan.tiles, 1).labor, 6);
    expect(needCost(s, p.town, p.need)).toBeGreaterThan(0);
    // the same road again: already under way
    expect(dispatch(s, { type: 'build', kind: 'track', a, b, grade: 1 }).ok).toBe(false);
    // it survives a save
    const s2 = deserialize(serialize(s));
    expect(s2.projects.find((x) => x.id === r.id)?.grade).toBe(1);
    // a Treasury crew in that town, as Build's automatic crew hires
    expect(dispatch(s, { type: 'placeOrder', market: { kind: 'labor', town: p.town }, side: 'buy', price: 0, qty: 20, priceMode: 'follow', band: 0.1, staff: 'projects' }).ok).toBe(true);
    for (let d = 0; d < 150 && p.status !== 'done'; d++) g.step();
    expect(p.status).toBe('done');
    for (const i of plan.tiles) expect(s.map.road[i]).toBe(1);
    // walkers now take the track: a path along it uses no off-road tile
    const path = findPath(s, a, b);
    expect(path.every((i) => s.map.road[i] >= 1)).toBe(true);
    // a second time: nothing to do
    const again = dispatch(s, { type: 'build', kind: 'track', a, b, grade: 1 });
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/already runs/);
    // paving it now costs paving alone
    const pv = dispatch(s, { type: 'build', kind: 'track', a, b, grade: 2 });
    expect(pv.ok, pv.message).toBe(true);
    const pp = s.projects.find((x) => x.id === pv.id)!;
    expect(pp.grade).toBeUndefined();
    expect(pp.need.labor).toBeCloseTo(ROAD_TILE_COST.labor * pp.tiles.length, 6);
    expect(Math.abs(checkLedger(s))).toBeLessThan(1e-6);
  });

  it('refuses nonsense and open water', () => {
    const g = Game.create({ seed: 1, warmup: false });
    const s = g.s;
    const n = s.map.w * s.map.h;
    expect(dispatch(s, { type: 'build', kind: 'track', a: 5, b: 5 }).ok).toBe(false);
    expect(dispatch(s, { type: 'build', kind: 'track', a: -1, b: 5 }).ok).toBe(false);
    expect(dispatch(s, { type: 'build', kind: 'track', a: 5, b: n }).ok).toBe(false);
    expect(dispatch(s, { type: 'build', kind: 'track', a: 5, b: 6, grade: 3 as 1 }).ok).toBe(false);
    const deep = s.map.terrain.findIndex((t) => t === Terrain.DeepWater);
    const land = s.map.terrain.findIndex((t, i) => t === Terrain.Grass && s.map.occ[i] < 0);
    const r = dispatch(s, { type: 'build', kind: 'track', a: land, b: deep, grade: 1 });
    expect(r.ok).toBe(false);
  });

  it('a dirt track between two towns takes new ground only', () => {
    const g = Game.create({ seed: 1, warmup: false });
    const s = g.s;
    const r = dispatch(s, { type: 'build', kind: 'road', from: 0, to: 1, grade: 1 });
    if (r.ok) {
      const p = s.projects.find((x) => x.id === r.id)!;
      expect(p.grade).toBe(1);
      for (const i of p.tiles) expect(s.map.road[i]).toBe(0);
    } else expect(r.message).toMatch(/already runs/);
    // paving between towns is as before
    const pv = dispatch(s, { type: 'build', kind: 'road', from: 0, to: 1 });
    expect(pv.ok, pv.message).toBe(true);
  });
});
