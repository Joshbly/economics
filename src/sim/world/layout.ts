// ============================================================================
// Town layout: market halls, houses, firm sites, local tracks, districts, and
// finding sites for new buildings later in the game. OWNER: world agent.
// ============================================================================
import type { Building, BuildingKind, Sector, SimState, TownId } from '../types';

/**
 * Find a free site for a new building of `what` near a town, on suitable terrain:
 * farms on Grass (prefer high fertility), fisheries on Sand/Grass adjacent to Water with fish,
 * lumber on Forest, coal mines on Hills with coal deposit, ore mines on Hills/Mountain with
 * ore deposit, oil wells on Marsh with oil deposit, town sectors/houses/piers near the centre
 * (piers: coast tile of the harbor town). Footprint must be free (occ = -1), within
 * ~town.radius+10 tiles (resource sites up to 16), not water. Returns null if none.
 */
export function findSite(s: SimState, what: Sector | 'house' | 'pier', town: TownId): { x: number; y: number } | null {
  // TODO(world)
  return null;
}

/**
 * Create a building record, mark its footprint in map.occ, connect it to the town
 * centre with a dirt track (paths.findPath + set road ≥ 1), bump runtime.touchBuildings.
 * Status as given ('construction' for new projects). Uses s.ids.building.
 */
export function placeBuilding(
  s: SimState,
  kind: BuildingKind,
  sector: Sector | '',
  town: TownId,
  x: number,
  y: number,
  status: Building['status'],
): Building {
  // TODO(world)
  return null as unknown as Building;
}

/** Remove a building from the map (e.g. cancelled construction). */
export function removeBuilding(s: SimState, b: Building): void {
  // TODO(world)
}

/** Recompute map.district (nearest town within reach) — after placing towns. */
export function computeDistricts(s: SimState): void {
  // TODO(world)
}
