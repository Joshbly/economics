// Rebuildable, non-serialised caches keyed by the state object (paths, route
// tables, spatial indices…). Anything here must be reconstructible from
// SimState alone, so a loaded save works without it.
import type { SimState } from './types';

export interface Route {
  from: number; // town id
  to: number;
  tiles: number[]; // tile indices along the path, from → to
  length: number; // tiles
  paved: number; // tiles with road 2
  dirt: number; // tiles with road 1
  offroad: number; // tiles without road
  days: number; // travel time one way
}

export interface Runtime {
  /** Tile path cache: key `${fromTile}>${toTile}` → tile indices. */
  paths: Map<string, number[]>;
  /** Town-to-town routes: key `${a}>${b}`. */
  routes: Map<string, Route>;
  /** Bumped whenever roads change so caches and the renderer can refresh. */
  roadVersion: number;
  /** Bumped whenever buildings are added/removed/change status. */
  buildingVersion: number;
  /** Free-form per-module caches (module name → anything rebuildable). */
  bag: Record<string, unknown>;
}

const RT = new WeakMap<SimState, Runtime>();

export function rt(s: SimState): Runtime {
  let r = RT.get(s);
  if (!r) {
    r = { paths: new Map(), routes: new Map(), roadVersion: 0, buildingVersion: 0, bag: {} };
    RT.set(s, r);
  }
  return r;
}

/** Call after any road tile changes. */
export function invalidateRoutes(s: SimState): void {
  const r = rt(s);
  r.paths.clear();
  r.routes.clear();
  r.roadVersion++;
}

/** Call after buildings are added, removed or change status. */
export function touchBuildings(s: SimState): void {
  rt(s).buildingVersion++;
}
