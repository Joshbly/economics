// ============================================================================
// Terrain generation. OWNER: world agent. See DESIGN §1.1.
// ============================================================================
import type { MapData, TownKind } from '../types';

export interface TownSite {
  kind: TownKind;
  x: number;
  y: number;
}

/**
 * Generate a MAP_W × MAP_H map from a seed (own local RNG seeded from `seed`):
 * fractal value noise elevation + moisture; sea along the south/east; one river
 * from the mountains to the sea; forest in moist areas, hills/mountains in a
 * northern range, marsh with oil seeps near the coast; deposits (0..1) for
 * timber/coal/ore/oil/fish; fertility for grassland (river bonus).
 * Also chooses 4 town sites (capital central on the river, farm town in western
 * grassland, mining town by the hills/mountains, harbor town on the coast next to
 * marsh), guaranteeing each has the terrain its industries need within ~10 tiles.
 * road/occ/district arrays initialised (0 / -1 / -1).
 */
export function generateMap(seed: number): { map: MapData; sites: TownSite[] } {
  // TODO(world)
  return { map: null as unknown as MapData, sites: [] };
}
