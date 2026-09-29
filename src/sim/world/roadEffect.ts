// ============================================================================
// What paving a planned set of tiles would do to trips between towns (Build → road
// preview): for every pair of towns whose route crosses the plan, the travel days now
// and along the same tiles once they are paved (an upper bound — a faster path may
// open up), and the freight per unit a trading house would face (fuel is per tile and
// stays; the driver's time, wear and the wagon's capital scale with the days away).
// Read-only.
// ============================================================================
import { OIL_PER_TILE, SPEED_DIRT, SPEED_PAVED, WAGON_CAPACITY } from '../config';
import { G } from '../goods';
import { expectedGross } from '../market/markets';
import { freightPerUnit } from '../agents/traders';
import type { SimState, TownId } from '../types';
import { routeBetweenTowns, tileMoveCost } from './paths';

export interface PaveEffect {
  a: TownId;
  b: TownId;
  /** Towns the route passes through on the way (besides a and b). */
  via: TownId[];
  daysNow: number;
  daysPaved: number;
  freightNow: number; // ¤ per unit a → b, full wagon (-1 unknown)
  freightPaved: number;
}

const SQRT2 = Math.SQRT2;

function stepCost(s: SimState, i: number, paved: Set<number>): number {
  if (paved.has(i)) return 1 / SPEED_PAVED;
  const c = tileMoveCost(s.map, i);
  return c > 0 ? c : 1 / SPEED_DIRT; // endpoints inside buildings / docks
}

/** Trips that paving `plan` would speed up, most days saved first. */
export function paveEffect(s: SimState, plan: readonly number[]): PaveEffect[] {
  const out: PaveEffect[] = [];
  if (!plan.length) return out;
  const set = new Set(plan);
  const w = s.map.w;
  const nt = s.towns.length;
  for (let a = 0; a < nt; a++) {
    for (let b = a + 1; b < nt; b++) {
      const r = routeBetweenTowns(s, a, b);
      const tiles = r.tiles;
      if (!tiles.some((i) => set.has(i))) continue;
      let days = 0;
      for (let k = 1; k < tiles.length; k++) {
        const p = tiles[k - 1];
        const q = tiles[k];
        const diag = p % w !== q % w && Math.abs(p - q) !== 1;
        days += (diag ? SQRT2 : 1) * 0.5 * (stepCost(s, p, set) + stepCost(s, q, set));
      }
      const daysPaved = Math.min(r.days, days);
      if (!(r.days - daysPaved > 1e-3)) continue;
      // towns passed on the way (their centre within 3 tiles of the route)
      const via: TownId[] = [];
      for (let t = 0; t < nt; t++) {
        if (t === a || t === b) continue;
        const T = s.towns[t];
        if (tiles.some((i) => Math.abs((i % w) - T.x) <= 3 && Math.abs(Math.floor(i / w) - T.y) <= 3)) via.push(t);
      }
      const fN = freightPerUnit(s, a, b);
      let fP = -1;
      if (fN >= 0 && r.days > 0) {
        const fuel = (expectedGross(s, a, G.oil) * OIL_PER_TILE * r.length) / WAGON_CAPACITY;
        const time = Math.max(0, fN - fuel);
        fP = Math.min(fN, fuel + (time * daysPaved) / r.days);
      }
      out.push({ a, b, via, daysNow: r.days, daysPaved, freightNow: fN, freightPaved: fP });
    }
  }
  out.sort((x, y) => y.daysNow - y.daysPaved - (x.daysNow - x.daysPaved));
  return out;
}

/**
 * Freight per unit a → b (a full wagon, the house of `a`) if the trip took `daysAfter` days over
 * `tilesAfter` tiles instead of today's route: fuel is per tile, the drivers' time, wear and the
 * wagon's capital scale with the days away. -1 if unknown.
 */
export function freightAfter(s: SimState, a: TownId, b: TownId, daysAfter: number, tilesAfter: number): number {
  const r = routeBetweenTowns(s, a, b);
  const fN = freightPerUnit(s, a, b);
  if (!(fN >= 0) || !(r.days > 0)) return -1;
  const fuelPerTile = (expectedGross(s, a, G.oil) * OIL_PER_TILE) / WAGON_CAPACITY;
  const time = Math.max(0, fN - fuelPerTile * r.length);
  return Math.max(0, fuelPerTile * tilesAfter + (time * daysAfter) / r.days);
}

/** Travel days along `path` if the tiles in `laid` were a road of `grade` (1 dirt, 2 paved). */
export function daysAlong(s: SimState, path: readonly number[], laid: ReadonlySet<number>, grade: 1 | 2): number {
  const w = s.map.w;
  const speed = grade >= 2 ? SPEED_PAVED : SPEED_DIRT;
  const cost = (i: number) => {
    if (laid.has(i)) return Math.min(1 / speed, tileMoveCost(s.map, i) > 0 ? tileMoveCost(s.map, i) : Infinity);
    const c = tileMoveCost(s.map, i);
    return c > 0 ? c : 1 / SPEED_DIRT; // endpoints inside buildings / on the market square
  };
  let days = 0;
  for (let k = 1; k < path.length; k++) {
    const p = path[k - 1];
    const q = path[k];
    const diag = p % w !== q % w && Math.abs(p - q) !== 1;
    days += (diag ? SQRT2 : 1) * 0.5 * (cost(p) + cost(q));
  }
  return days;
}
