// ============================================================================
// Town layout: market halls, houses, firm sites, local tracks, districts, and
// finding sites for new buildings later in the game. OWNER: world agent.
//
// Site rules (shared by findSite, isValidSite and world init):
//  * every footprint tile is on the map (1-tile margin), free (occ = -1), not a
//    river and not a road (tracks stay open), on terrain the building needs:
//      farm      Grass (2×2; quality = mean fertility)
//      fishery   coastal Sand/Grass fronting shallow Water (quality = the fishing
//                grounds' richness, which mapgen stores on those coastal tiles)
//      lumber    Forest · coalmine Hills (not touching a Mountain) · oremine Mountain
//                or Hills touching one · oilwell Marsh   (quality = deposit)
//      pier      shallow Water (2×1), touching land
//      others    Grass, Sand, Forest or Hills (town buildings, houses)
//    resource sites need deposit/fertility > 0.05;
//  * at least one 4-neighbour is open land or road, so a track can reach the door;
//  * within reach of the town centre: resource sites ≤ 16 tiles, town buildings and
//    houses ≤ town.radius + 10, piers ≤ radius + 8 (and nearer this town than any other).
// Farms keep out of the town core (distance > radius + 1) so the town can grow.
// ============================================================================
import { HOUSE_SLOTS, SECTORS } from '../goods';
import { newBuilding } from '../factory';
import { invalidateRoutes, touchBuildings } from '../runtime';
import { Terrain, type Building, type BuildingKind, type MapData, type Sector, type SimState, type TownId } from '../types';
import { frontsWater, hash2, isWaterT, nearMountain } from './mapgen';
import { planTrack } from './paths';
import { heldIn } from './plots';
import { LAND_HELD_SITE_PENALTY } from '../config';

export type SiteWhat = Sector | 'house' | 'pier';

/** Maximum distance (tiles) from the town centre for resource sites. */
export const RESOURCE_REACH = 16;
/** Extra reach beyond the settlement radius for town buildings / houses. */
export const TOWN_REACH = 10;
const PIER_REACH = 8;
/** Minimum deposit / fertility for a resource site. */
const MIN_QUALITY = 0.05;

const RESOURCE_SECTORS: ReadonlySet<string> = new Set(['farm', 'fishery', 'lumber', 'coalmine', 'oremine', 'oilwell']);

/** True for sectors that stand on a natural resource (their output scales with site quality). */
export function isResourceSector(what: string): boolean {
  return RESOURCE_SECTORS.has(what);
}

/** Footprint [w, h] of a building kind (firms: their sector's footprint). */
export function footprintOf(kind: BuildingKind | 'pier', sector: Sector | ''): [number, number] {
  switch (kind) {
    case 'house':
      return [1, 1];
    case 'market':
    case 'palace':
      return [2, 2];
    case 'bank':
    case 'port':
    case 'pier':
      return [2, 1];
    case 'firm': {
      const d = sector ? SECTORS[sector] : undefined;
      return d ? [d.footprint[0], d.footprint[1]] : [1, 1];
    }
    default:
      return [1, 1];
  }
}

function footprintForWhat(what: SiteWhat): [number, number] {
  if (what === 'house') return [1, 1];
  if (what === 'pier') return [2, 1];
  return footprintOf('firm', what);
}

/** Terrain / resource rule for one footprint tile (occupancy, roads and rivers checked by the caller). */
function tileFits(m: MapData, what: SiteWhat, i: number): boolean {
  const t = m.terrain[i];
  switch (what) {
    case 'farm':
      return t === Terrain.Grass && m.fert[i] > MIN_QUALITY;
    case 'fishery':
      return (t === Terrain.Sand || t === Terrain.Grass) && m.deposit[i] > MIN_QUALITY && frontsWater(m, i);
    case 'lumber':
      return t === Terrain.Forest && m.deposit[i] > MIN_QUALITY;
    case 'coalmine':
      return t === Terrain.Hills && m.deposit[i] > MIN_QUALITY && !nearMountain(m, i);
    case 'oremine':
      return (t === Terrain.Mountain || (t === Terrain.Hills && nearMountain(m, i))) && m.deposit[i] > MIN_QUALITY;
    case 'oilwell':
      return t === Terrain.Marsh && m.deposit[i] > MIN_QUALITY;
    case 'pier':
      return t === Terrain.Water;
    default:
      return t === Terrain.Grass || t === Terrain.Sand || t === Terrain.Forest || t === Terrain.Hills;
  }
}

/**
 * Natural quality (0..1) of a site for a sector: mean fertility of a farm's
 * footprint, the deposit richness for mines, camps, wells and fisheries, 1 for
 * everything else. Firms turn it into a productivity multiplier 0.6 + 0.8·q.
 */
export function siteQuality(m: MapData, sector: Sector | '', x: number, y: number, w = 1, h = 1): number {
  if (!sector || !isResourceSector(sector)) return 1;
  let sum = 0;
  let cnt = 0;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= m.w || yy >= m.h) continue;
      const i = yy * m.w + xx;
      sum += sector === 'farm' ? m.fert[i] : m.deposit[i];
      cnt++;
    }
  }
  const q = cnt > 0 ? sum / cnt : 0;
  return q < 0 ? 0 : q > 1 ? 1 : q;
}

/**
 * Productivity multiplier of a building's site (DESIGN §2.2): 0.6 + 0.8·quality for
 * resource sectors (farms by fertility), 1 for town sectors. Firms should use this
 * rather than reading one tile, so multi-tile farms and coastal fisheries are right.
 */
export function siteMultiplier(s: SimState, b: Building): number {
  if (!b || b.kind !== 'firm' || !b.sector || !isResourceSector(b.sector)) return 1;
  return 0.6 + 0.8 * siteQuality(s.map, b.sector, b.x, b.y, b.w, b.h);
}

/** Index of the town whose centre is nearest to (x, y), or -1 if there are no towns. */
export function nearestTown(s: SimState, x: number, y: number): TownId {
  let best = -1;
  let bd = 1e18;
  for (const t of s.towns) {
    const d = (t.x - x) * (t.x - x) + (t.y - y) * (t.y - y);
    if (d < bd) {
      bd = d;
      best = t.id;
    }
  }
  return best;
}

function reachOf(s: SimState, what: SiteWhat, town: TownId): number {
  const t = s.towns[town];
  const r = t ? Math.max(3, t.radius) : 3;
  if (what === 'pier') return r + PIER_REACH;
  if (isResourceSector(what)) return RESOURCE_REACH;
  return r + TOWN_REACH;
}

/** Footprint-level checks without distance limits. */
function footprintOk(s: SimState, what: SiteWhat, x: number, y: number): boolean {
  const m = s.map;
  const [w, h] = footprintForWhat(what);
  if (x < 1 || y < 1 || x + w > m.w - 1 || y + h > m.h - 1) return false;
  let touchesLand = what !== 'pier';
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = yy * m.w + xx;
      if (m.occ[i] >= 0 || m.river[i] || m.road[i] >= 1) return false;
      if (!tileFits(m, what, i)) return false;
    }
  }
  // Access: an open 4-neighbour of the footprint (land that a track can use, or a road).
  let access = false;
  for (let yy = y - 1; yy <= y + h && !access; yy++) {
    for (let xx = x - 1; xx <= x + w; xx++) {
      const inside = xx >= x && xx < x + w && yy >= y && yy < y + h;
      const corner = (xx === x - 1 || xx === x + w) && (yy === y - 1 || yy === y + h);
      if (inside || corner) continue;
      if (xx < 0 || yy < 0 || xx >= m.w || yy >= m.h) continue;
      const i = yy * m.w + xx;
      const t = m.terrain[i];
      if (!isWaterT(t)) touchesLand = true;
      if (m.occ[i] >= 0) continue;
      if (isWaterT(t) || t === Terrain.Mountain) continue;
      if (m.river[i] && m.road[i] < 1) continue;
      access = true;
      break;
    }
  }
  return access && touchesLand;
}

/** The footprint rules alone (free, the right ground, a way in), wherever it is: for sites chosen on their merits (agents/sites.ts). */
export function siteFits(s: SimState, what: SiteWhat, x: number, y: number): boolean {
  return footprintOk(s, what, x, y);
}

/** Distance from the town centre to the footprint centre. */
function distTo(s: SimState, what: SiteWhat, town: TownId, x: number, y: number): number {
  const t = s.towns[town];
  if (!t) return 1e9;
  const [w, h] = footprintForWhat(what);
  return Math.hypot(x + w / 2 - (t.x + 0.0), y + h / 2 - (t.y + 0.0));
}

function withinReach(s: SimState, what: SiteWhat, town: TownId, x: number, y: number): boolean {
  const t = s.towns[town];
  if (!t) return false;
  const d = distTo(s, what, town, x, y);
  if (d > reachOf(s, what, town)) return false;
  if (what === 'farm' && d < Math.max(3, t.radius) + 1.5) return false;
  const [w, h] = footprintForWhat(what);
  if (nearestTown(s, x + w / 2, y + h / 2) !== town) return false;
  if (what === 'pier' && !t.hasPort) return false;
  return true;
}

/**
 * True if a building for `what` may stand with its top-left tile at (x, y): the same
 * rules as findSite. `town` defaults to the town nearest the site.
 */
export function isValidSite(s: SimState, what: SiteWhat, x: number, y: number, town?: TownId): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (!s.towns.length) return false;
  const tw = town !== undefined && town >= 0 ? town : nearestTown(s, x, y);
  if (!s.towns[tw]) return false;
  if (!footprintOk(s, what, x, y)) return false;
  return withinReach(s, what, tw, x, y);
}

/** Deterministic per-tile jitter in [0, 1) (keeps rings of houses from looking circular). */
function jitter(s: SimState, x: number, y: number): number {
  return hash2(s.seed ^ 0x51ab, x, y);
}

function roadAdjacent(m: MapData, x: number, y: number, w: number, h: number): boolean {
  for (let yy = y - 1; yy <= y + h; yy++) {
    for (let xx = x - 1; xx <= x + w; xx++) {
      const inside = xx >= x && xx < x + w && yy >= y && yy < y + h;
      if (inside || xx < 0 || yy < 0 || xx >= m.w || yy >= m.h) continue;
      const corner = (xx === x - 1 || xx === x + w) && (yy === y - 1 || yy === y + h);
      if (corner) continue;
      if (m.road[yy * m.w + xx] >= 1) return true;
    }
  }
  return false;
}

/** Occupied tiles in the ring around a footprint. */
function crowding(m: MapData, x: number, y: number, w: number, h: number): number {
  let c = 0;
  for (let yy = y - 1; yy <= y + h; yy++) {
    for (let xx = x - 1; xx <= x + w; xx++) {
      const inside = xx >= x && xx < x + w && yy >= y && yy < y + h;
      if (inside || xx < 0 || yy < 0 || xx >= m.w || yy >= m.h) continue;
      if (m.occ[yy * m.w + xx] >= 0) c++;
    }
  }
  return c;
}

/** Score a candidate site (higher is better). */
function siteScore(s: SimState, what: SiteWhat, town: TownId, x: number, y: number): number {
  const m = s.map;
  const [w, h] = footprintForWhat(what);
  const d = distTo(s, what, town, x, y);
  const j = jitter(s, x, y);
  if (isResourceSector(what)) {
    const q = siteQuality(m, what as Sector, x, y, w, h);
    // Richness dominates; distance matters a little (commutes, hauling); neighbours
    // crowd a site (fields and pits spread out rather than lining up wall to wall).
    return q * 10 - 0.22 * d + 0.3 * j + (roadAdjacent(m, x, y, w, h) ? 0.4 : 0) - 0.45 * crowding(m, x, y, w, h);
  }
  if (what === 'pier') {
    // Next to the Port if there is one.
    let pd = d;
    for (const b of s.buildings) {
      if (b && b.kind === 'port' && b.town === town && b.status !== 'ruin') pd = Math.min(pd, Math.hypot(b.x - x, b.y - y));
    }
    return -pd + 0.2 * j;
  }
  // Town buildings: close to the centre, along roads, on open grass.
  const i = y * m.w + x;
  const t = m.terrain[i];
  const terrainPen = t === Terrain.Grass ? 0 : t === Terrain.Sand ? 0.4 : t === Terrain.Forest ? 1.2 : 1.6;
  const road = roadAdjacent(m, x, y, w, h) ? 1.4 : 0;
  // land held to sell dearer costs more than the council's (agents/land.ts): only a clearly better site is worth it
  const held = heldIn(s, x, y, w, h) * LAND_HELD_SITE_PENALTY;
  return -d + road - terrainPen + 1.3 * j - held;
}

/**
 * Find a free site for a new building of `what` near a town, on suitable terrain:
 * farms on Grass (prefer high fertility), fisheries on Sand/Grass adjacent to Water with fish,
 * lumber on Forest, coal mines on Hills with coal deposit, ore mines on Hills/Mountain with
 * ore deposit, oil wells on Marsh with oil deposit, town sectors/houses/piers near the centre
 * (piers: coast tile of the harbor town). Footprint must be free (occ = -1), within
 * ~town.radius+10 tiles (resource sites up to 16), not water. Returns null if none.
 * `maxReach` (optional) narrows the search radius (world init fills towns outward).
 */
export function findSite(s: SimState, what: SiteWhat, town: TownId, maxReach?: number): { x: number; y: number } | null {
  const t = s.towns[town];
  if (!t) return null;
  const m = s.map;
  const fullReach = reachOf(s, what, town);
  const lim = maxReach !== undefined && maxReach > 0 ? Math.min(maxReach, fullReach) : fullReach;
  const reach = Math.ceil(lim) + 2;
  const x0 = Math.max(1, t.x - reach);
  const x1 = Math.min(m.w - 2, t.x + reach);
  const y0 = Math.max(1, t.y - reach);
  const y1 = Math.min(m.h - 2, t.y + reach);
  let best: { x: number; y: number } | null = null;
  let bestScore = -1e18;
  const [fw, fh] = footprintForWhat(what);
  const maxD2 = lim * lim;
  for (let y = y0; y <= y1; y++) {
    const dy = y + fh / 2 - t.y;
    for (let x = x0; x <= x1; x++) {
      const dx = x + fw / 2 - t.x;
      if (dx * dx + dy * dy > maxD2) continue; // cheap reach test first
      if (!footprintOk(s, what, x, y)) continue;
      if (!withinReach(s, what, town, x, y)) continue;
      const sc = siteScore(s, what, town, x, y);
      if (sc > bestScore) {
        bestScore = sc;
        best = { x, y };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

/** Set road ≥ 1 on the given tiles (never on buildings or open water). Returns tiles changed. */
export function layTrack(s: SimState, tiles: readonly number[]): number {
  const m = s.map;
  let changed = 0;
  for (const i of tiles) {
    if (i < 0 || i >= m.road.length) continue;
    if (m.occ[i] >= 0) continue;
    if (isWaterT(m.terrain[i])) continue;
    if (m.road[i] < 1) {
      m.road[i] = 1;
      changed++;
    }
  }
  return changed;
}

/** The open tile next to a building (or a planned footprint) from which its track starts ("the door"), or -1. */
export function doorTile(s: SimState, b: Pick<Building, 'x' | 'y' | 'w' | 'h' | 'town'>): number {
  const m = s.map;
  const t = s.towns[b.town];
  const tx = t ? t.x : b.x;
  const ty = t ? t.y : b.y;
  let best = -1;
  let bestScore = 1e18;
  for (let yy = b.y - 1; yy <= b.y + b.h; yy++) {
    for (let xx = b.x - 1; xx <= b.x + b.w; xx++) {
      const inside = xx >= b.x && xx < b.x + b.w && yy >= b.y && yy < b.y + b.h;
      const corner = (xx === b.x - 1 || xx === b.x + b.w) && (yy === b.y - 1 || yy === b.y + b.h);
      if (inside || corner || xx < 0 || yy < 0 || xx >= m.w || yy >= m.h) continue;
      const i = yy * m.w + xx;
      if (m.occ[i] >= 0) continue;
      const ter = m.terrain[i];
      if (isWaterT(ter) || ter === Terrain.Mountain) continue;
      if (m.river[i] && m.road[i] < 1) continue;
      // Prefer a tile that is already road, then the side facing the town centre.
      const sc = (m.road[i] >= 1 ? -1000 : 0) + Math.hypot(xx - tx, yy - ty);
      if (sc < bestScore) {
        bestScore = sc;
        best = i;
      }
    }
  }
  return best;
}

/**
 * The dirt track a building (or a planned footprint) needs to reach the road network: the
 * tiles from its door to the nearest existing road that are not road yet ([] when the door
 * is on a road; just the door when no way is found within reach).
 */
export function accessTrack(s: SimState, b: Pick<Building, 'x' | 'y' | 'w' | 'h' | 'town'>): number[] {
  const door = doorTile(s, b);
  if (door < 0) return [];
  const m = s.map;
  if (m.road[door] >= 1) return [];
  const path = planTrack(s, door, -1, 600);
  const tiles = (path.length ? path : [door]).filter((i) => m.road[i] < 1 && m.occ[i] < 0 && !isWaterT(m.terrain[i]));
  return tiles;
}

/**
 * Connect a building to the road network with a dirt track from its door to the
 * nearest existing road (which leads to its town centre). Returns tiles laid.
 */
export function connectBuilding(s: SimState, b: Building): number {
  const door = doorTile(s, b);
  if (door < 0) return 0;
  const m = s.map;
  if (m.road[door] >= 1) return 0;
  const path = planTrack(s, door, -1, 600);
  if (path.length === 0) return layTrack(s, [door]);
  return layTrack(s, path);
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

/**
 * Create a building record, mark its footprint in map.occ, connect it to the town
 * centre with a dirt track (paths.findPath + set road ≥ 1), bump runtime.touchBuildings.
 * Status as given ('construction' for new projects). Uses s.ids.building.
 * Houses get HOUSE_SLOTS slots when placed active (0 while under construction;
 * construction sets them on completion). Rent, owner and cost are the caller's.
 * `opts.connect = false` skips the track (world init places a batch, then connects
 * them all with connectBuilding so no track cuts across a site chosen for the batch).
 */
export function placeBuilding(
  s: SimState,
  kind: BuildingKind,
  sector: Sector | '',
  town: TownId,
  x: number,
  y: number,
  status: Building['status'],
  opts?: { connect?: boolean },
): Building {
  const m = s.map;
  const [w, h] = footprintOf(kind, kind === 'firm' ? sector : '');
  const b = newBuilding(s, kind, kind === 'firm' ? sector : '', town, x, y, w, h, status);
  if (kind === 'house') b.slots = status === 'active' ? HOUSE_SLOTS : 0;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= m.w || yy >= m.h) continue;
      const i = yy * m.w + xx;
      m.occ[i] = b.id;
      m.district[i] = town;
    }
  }
  let laid = 0;
  if (kind !== 'market' && opts?.connect !== false) laid = connectBuilding(s, b);
  touchBuildings(s);
  // A building on a former route tile or a new track can change travel routes.
  if (laid > 0 || kind !== 'house') invalidateRoutes(s);
  return b;
}

/**
 * Remove a building from the map (e.g. cancelled construction): its footprint is
 * freed and the record becomes a 'ruin' with no residents or slots (records are
 * indexed by id, so they are never deleted). Its track stays.
 */
export function removeBuilding(s: SimState, b: Building): void {
  if (!b) return;
  const m = s.map;
  for (let yy = b.y; yy < b.y + b.h; yy++) {
    for (let xx = b.x; xx < b.x + b.w; xx++) {
      if (xx < 0 || yy < 0 || xx >= m.w || yy >= m.h) continue;
      const i = yy * m.w + xx;
      if (m.occ[i] === b.id) m.occ[i] = -1;
    }
  }
  b.status = 'ruin';
  b.residents = [];
  b.slots = 0;
  b.project = -1;
  touchBuildings(s);
  invalidateRoutes(s);
}

/** Reach (tiles) of a town's market district. */
export const DISTRICT_REACH = 20;

/**
 * Recompute map.district (nearest town within reach) — after placing towns.
 * Each tile belongs to the nearest town centre within max(DISTRICT_REACH, radius + 12)
 * tiles, else -1; a building's footprint always belongs to its own town.
 */
export function computeDistricts(s: SimState): void {
  const m = s.map;
  const w = m.w;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < w; x++) {
      let best = -1;
      let bd = 1e18;
      for (const t of s.towns) {
        const d = (t.x - x) * (t.x - x) + (t.y - y) * (t.y - y);
        const reach = Math.max(DISTRICT_REACH, t.radius + 12);
        if (d <= reach * reach && d < bd) {
          bd = d;
          best = t.id;
        }
      }
      m.district[y * w + x] = best;
    }
  }
  for (const b of s.buildings) {
    if (!b || b.status === 'ruin') continue;
    for (let yy = b.y; yy < b.y + b.h; yy++) {
      for (let xx = b.x; xx < b.x + b.w; xx++) {
        if (xx >= 0 && yy >= 0 && xx < w && yy < m.h) m.district[yy * w + xx] = b.town;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// World-init helpers
// ---------------------------------------------------------------------------

/** Market hall (2×2, bottom-right tile at the town centre) and a market-square ring of track around it. */
export function placeMarketHall(s: SimState, town: TownId): Building {
  const t = s.towns[town];
  const m = s.map;
  const b = placeBuilding(s, 'market', '', town, t.x - 1, t.y - 1, 'active');
  b.owner = -1; // STATE
  t.market = b.id;
  // The hall stands on the market square: its tiles count as track for travel (hidden under the hall).
  for (let y = t.y - 1; y <= t.y; y++) for (let x = t.x - 1; x <= t.x; x++) if (x >= 0 && y >= 0 && x < m.w && y < m.h) m.road[y * m.w + x] = 1;
  const ring: number[] = [];
  for (let y = t.y - 2; y <= t.y + 1; y++) {
    for (let x = t.x - 2; x <= t.x + 1; x++) {
      if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
      const i = y * m.w + x;
      if (m.occ[i] >= 0 || m.river[i] || isWaterT(m.terrain[i]) || m.terrain[i] === Terrain.Mountain) continue;
      ring.push(i);
    }
  }
  if (layTrack(s, ring) > 0) invalidateRoutes(s);
  return b;
}

/**
 * A site for a special town building (palace, bank, port) of size w×h near the centre.
 * `coastal`: at least one footprint tile must front shallow water (the Port).
 */
export function findCoreSite(s: SimState, town: TownId, w: number, h: number, coastal: boolean, minDist = 2.5): { x: number; y: number } | null {
  const t = s.towns[town];
  if (!t) return null;
  const m = s.map;
  let best: { x: number; y: number } | null = null;
  let bs = -1e18;
  const R = coastal ? 12 : 9;
  for (let y = Math.max(1, t.y - R); y <= Math.min(m.h - 2 - h, t.y + R); y++) {
    for (let x = Math.max(1, t.x - R); x <= Math.min(m.w - 2 - w, t.x + R); x++) {
      let ok = true;
      let fronts = false;
      for (let yy = y; yy < y + h && ok; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const i = yy * m.w + xx;
          const ter = m.terrain[i];
          if (m.occ[i] >= 0 || m.river[i] || m.road[i] >= 1 || !(ter === Terrain.Grass || ter === Terrain.Sand)) {
            ok = false;
            break;
          }
          if (frontsWater(m, i)) fronts = true;
        }
      }
      if (!ok || (coastal && !fronts)) continue;
      const d = Math.hypot(x + w / 2 - t.x, y + h / 2 - t.y);
      if (d < minDist) continue;
      if (nearestTown(s, x, y) !== town) continue;
      const sc = -d + (roadAdjacent(m, x, y, w, h) ? 1.5 : 0) + 0.3 * jitter(s, x, y);
      if (sc > bs) {
        bs = sc;
        best = { x, y };
      }
    }
  }
  return best;
}

/** Town centre tile index. */
export function townCentreTile(s: SimState, town: TownId): number {
  const t = s.towns[town];
  return t ? t.y * s.map.w + t.x : -1;
}

/** Recompute a town's settlement radius from its houses and town-sector buildings. */
export function updateTownRadius(s: SimState, town: TownId): number {
  const t = s.towns[town];
  if (!t) return 3;
  let r = 3;
  for (const b of s.buildings) {
    if (!b || b.town !== town || b.status === 'ruin') continue;
    if (b.kind === 'firm' && isResourceSector(b.sector)) continue;
    const d = Math.hypot(b.x + b.w / 2 - t.x, b.y + b.h / 2 - t.y);
    if (d > r) r = d;
  }
  t.radius = Math.round(r * 10) / 10;
  return t.radius;
}
