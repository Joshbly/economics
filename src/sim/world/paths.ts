// ============================================================================
// Pathfinding on the tile grid (A*, road-preferring) with runtime caches.
// OWNER: world agent.
// Movement cost per tile: paved 1/SPEED_PAVED, dirt 1/SPEED_DIRT, off-road
// 1/SPEED_OFFROAD × terrain factor (Forest 1.5, Hills 1.8, Mountain 4, Marsh 2.5,
// Sand 1.2); Water/DeepWater and river tiles without a road are impassable
// (bridges: road ≥ 1 on a river tile).
// ============================================================================
import type { Route } from '../runtime';
import type { SimState, TownId } from '../types';

/** Tile-index path from a to b (inclusive). Cached in runtime.paths. [] if unreachable. */
export function findPath(s: SimState, fromTile: number, toTile: number): number[] {
  // TODO(world)
  return [];
}

/** Travel time in days along a tile path. */
export function pathDays(s: SimState, tiles: readonly number[]): number {
  // TODO(world)
  return 1;
}

/** Route between two town centres (cached in runtime.routes, invalidated when roads change). */
export function routeBetweenTowns(s: SimState, a: TownId, b: TownId): Route {
  // TODO(world)
  return { from: a, to: b, tiles: [], length: 1, paved: 0, dirt: 0, offroad: 1, days: 1 };
}

/**
 * Plan a road: the tile path between two towns that a paving project would cover
 * (existing route tiles not yet paved). Used by Build → road.
 */
export function roadPlan(s: SimState, a: TownId, b: TownId): number[] {
  // TODO(world)
  return [];
}

/** Commute path for a person (home tile → job building tile); [] if none. Cached. */
export function commutePath(s: SimState, personId: number): number[] {
  // TODO(world)
  return [];
}

/** Path from a building to its town's market hall (for delivery animation). Cached. */
export function deliveryPath(s: SimState, buildingId: number): number[] {
  // TODO(world)
  return [];
}
