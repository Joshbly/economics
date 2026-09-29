// ============================================================================
// Pathfinding on the tile grid (A*, road-preferring) with runtime caches.
// OWNER: world agent.
// Movement cost per tile: paved 1/SPEED_PAVED, dirt 1/SPEED_DIRT, off-road
// 1/SPEED_OFFROAD × terrain factor (Forest 1.5, Hills 1.8, Mountain 4, Marsh 2.5,
// Sand 1.2); Water/DeepWater and river tiles without a road are impassable
// (bridges: road ≥ 1 on a river tile).
//
// Two searches share one binary-heap A* engine (typed-array scratch kept in the
// runtime bag, so a search allocates nothing but its result):
//  * travel   — 8-neighbour moves (diagonals cost √2 and may not cut a corner past
//               an impassable tile, so a 1-tile river is a true barrier), step cost
//               = length × mean of the two tiles' costs, a mild penalty for walking
//               through other buildings. Used for routes, commutes, deliveries.
//  * planning — 4-neighbour moves over *construction* costs (existing roads cheap,
//               rough terrain dear, rivers crossable only straight across as a
//               one-tile bridge, buildings impassable, a small turn penalty so
//               tracks run straight). Used to lay tracks (layout.ts).
// Caches: runtime.paths (tile paths) and runtime.routes (town routes); both are
// cleared by runtime.invalidateRoutes, which every road change must call.
// ============================================================================
import { SPEED_DIRT, SPEED_OFFROAD, SPEED_PAVED } from '../config';
import { rt, type Route } from '../runtime';
import { Terrain, type MapData, type SimState, type TownId } from '../types';

const SQRT2 = Math.SQRT2;

/** Off-road travel-time multipliers by terrain (index = Terrain id); ≤ 0 = impassable. */
export const OFFROAD_FACTOR: readonly number[] = [0, 0, 1.2, 1, 1.5, 1.8, 4, 2.5];
/** Multiplier on the cost of stepping through another building's tile. */
const BUILDING_PENALTY = 2.5;
/** Construction-cost factors for laying a new track (index = Terrain id); 0 = impossible. */
const PLAN_FACTOR: readonly number[] = [0, 0, 1.25, 1, 1.4, 2.0, 9, 2.6];
const PLAN_ROAD_DIRT = 0.22;
const PLAN_ROAD_PAVED = 0.15;
const PLAN_BRIDGE = 14;
/** Tie-breaker: cost per tile of distance from the straight start→goal line (roads follow the line as a staircase, which travellers cut diagonally). */
const PLAN_LINE = 0.015;
/** Keep the tile-path cache bounded (commutes change as people move). */
const PATH_CACHE_MAX = 25000;

// ---------------------------------------------------------------------------
// Scratch & per-tile cost tables (runtime only)
// ---------------------------------------------------------------------------
interface Scratch {
  n: number;
  w: number;
  g: Float64Array;
  from: Int32Array;
  seen: Int32Array;
  closed: Int32Array;
  stamp: number;
  hk: Float64Array; // heap keys
  hv: Int32Array; // heap values (tile)
  hs: number;
  /** Travel cost per tile unit (days per tile), -1 impassable. Rebuilt on roadVersion change. */
  move: Float64Array;
  moveVer: number;
  movePaved: boolean; // any paved tile (tightens the heuristic)
}

function scratch(s: SimState): Scratch {
  const bag = rt(s).bag;
  const n = s.map.w * s.map.h;
  let c = bag.paths as Scratch | undefined;
  if (!c || c.n !== n) {
    const cap = n * 8 + 16;
    c = {
      n,
      w: s.map.w,
      g: new Float64Array(n),
      from: new Int32Array(n),
      seen: new Int32Array(n),
      closed: new Int32Array(n),
      stamp: 0,
      hk: new Float64Array(cap),
      hv: new Int32Array(cap),
      hs: 0,
      move: new Float64Array(n),
      moveVer: -1,
      movePaved: false,
    };
    bag.paths = c;
  }
  const ver = rt(s).roadVersion;
  if (c.moveVer !== ver) {
    const m = s.map;
    let paved = false;
    for (let i = 0; i < n; i++) {
      c.move[i] = tileMoveCost(m, i);
      if (m.road[i] >= 2) paved = true;
    }
    c.movePaved = paved;
    c.moveVer = ver;
  }
  return c;
}

/** Travel time (days) to cross one tile, or -1 if impassable. */
export function tileMoveCost(m: MapData, i: number): number {
  const r = m.road[i];
  const t = m.terrain[i];
  if (r >= 2) return 1 / SPEED_PAVED;
  if (r >= 1) return t === Terrain.DeepWater ? -1 : 1 / SPEED_DIRT;
  if (t === Terrain.Water || t === Terrain.DeepWater) return -1;
  if (m.river[i]) return -1;
  const f = OFFROAD_FACTOR[t] ?? 1;
  return f > 0 ? f / SPEED_OFFROAD : -1;
}

/** True if a traveller can stand on / cross this tile. */
export function passable(s: SimState, i: number): boolean {
  return tileMoveCost(s.map, i) > 0;
}

// ---- binary heap on the scratch (lazy deletion) ----
function hpush(c: Scratch, key: number, v: number): void {
  const hk = c.hk;
  const hv = c.hv;
  let i = c.hs++;
  if (i >= hk.length) {
    // should not happen (capacity 8n); degrade gracefully by dropping the push
    c.hs--;
    return;
  }
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (hk[p] <= key) break;
    hk[i] = hk[p];
    hv[i] = hv[p];
    i = p;
  }
  hk[i] = key;
  hv[i] = v;
}

function hpop(c: Scratch): number {
  const hk = c.hk;
  const hv = c.hv;
  const top = hv[0];
  const n = --c.hs;
  if (n > 0) {
    const lk = hk[n];
    const lv = hv[n];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const ch = r < n && hk[r] < hk[l] ? r : l;
      if (hk[ch] >= lk) break;
      hk[i] = hk[ch];
      hv[i] = hv[ch];
      i = ch;
    }
    hk[i] = lk;
    hv[i] = lv;
  }
  return top;
}

function newStamp(c: Scratch): number {
  c.stamp++;
  if (c.stamp > 2_000_000_000) {
    c.seen.fill(0);
    c.closed.fill(0);
    c.stamp = 1;
  }
  c.hs = 0;
  return c.stamp;
}

function reconstruct(c: Scratch, start: number, goal: number): number[] {
  const out: number[] = [];
  let i = goal;
  let guard = 0;
  while (i !== start && guard++ < c.n) {
    out.push(i);
    i = c.from[i];
    if (i < 0) return [];
  }
  out.push(start);
  out.reverse();
  return out;
}

const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];

/** Travel A* (8-neighbour, no corner cutting). Returns [] if unreachable. */
function travelSearch(s: SimState, start: number, goal: number): number[] {
  const m = s.map;
  const w = m.w;
  const h = m.h;
  const n = w * h;
  if (!(start >= 0 && start < n && goal >= 0 && goal < n)) return [];
  if (start === goal) return [start];
  const c = scratch(s);
  const st = newStamp(c);
  const move = c.move;
  const occ = m.occ;
  const g = c.g;
  const from = c.from;
  const seen = c.seen;
  const closed = c.closed;
  const hmin = c.movePaved ? 1 / SPEED_PAVED : 1 / SPEED_DIRT;
  const gx = goal % w;
  const gy = (goal - gx) / w;
  // Start and goal may be buildings (or even water-side docks): always enterable.
  const costAt = (i: number): number => {
    if (i === goal || i === start) {
      const v = move[i];
      return v > 0 ? v : 1 / SPEED_DIRT;
    }
    const v = move[i];
    if (v <= 0) return -1;
    return occ[i] >= 0 ? v * BUILDING_PENALTY : v;
  };
  const heur = (x: number, y: number): number => {
    const dx = Math.abs(x - gx);
    const dy = Math.abs(y - gy);
    return hmin * (dx > dy ? dx + (SQRT2 - 1) * dy : dy + (SQRT2 - 1) * dx);
  };
  g[start] = 0;
  seen[start] = st;
  from[start] = -1;
  const sx = start % w;
  hpush(c, heur(sx, (start - sx) / w), start);
  let found = false;
  while (c.hs > 0) {
    const cur = hpop(c);
    if (closed[cur] === st) continue;
    closed[cur] = st;
    if (cur === goal) {
      found = true;
      break;
    }
    const cx = cur % w;
    const cy = (cur - cx) / w;
    const cc = costAt(cur);
    const gc = g[cur];
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX8[k];
      const ny = cy + DY8[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (closed[ni] === st) continue;
      const nc = costAt(ni);
      if (nc <= 0) continue;
      let len = 1;
      if (k >= 4) {
        // no corner cutting: both orthogonal neighbours must be passable
        if (move[cy * w + nx] <= 0 || move[ny * w + cx] <= 0) continue;
        len = SQRT2;
      }
      const ng = gc + len * 0.5 * (cc + nc);
      if (seen[ni] !== st || ng < g[ni]) {
        g[ni] = ng;
        from[ni] = cur;
        seen[ni] = st;
        hpush(c, ng + heur(nx, ny), ni);
      }
    }
  }
  return found ? reconstruct(c, start, goal) : [];
}

/** Construction cost of laying track on a tile (planning), or -1 if impossible. */
function planCost(m: MapData, i: number, onDirt = PLAN_ROAD_DIRT, onPaved = PLAN_ROAD_PAVED): number {
  const t = m.terrain[i];
  if (t === Terrain.Water || t === Terrain.DeepWater) return -1;
  const r = m.road[i];
  if (r >= 2) return onPaved;
  if (r >= 1) return onDirt;
  if (m.river[i]) return PLAN_BRIDGE;
  const f = PLAN_FACTOR[t] ?? 1;
  return f > 0 ? f : -1;
}

/** Planning costs of tiles that already carry a road (new grass = 1). */
export interface PlanOpts {
  onDirt?: number;
  onPaved?: number;
}

/**
 * Planning search (4-neighbour) for a new track from `start` to `goal`, or — when
 * `goal` < 0 — to the nearest existing road tile (Dijkstra). Buildings are
 * impassable except start/goal; rivers are crossed straight over (one-tile bridge).
 * Returns the tile path (start … end) or [].
 */
export function planTrack(s: SimState, start: number, goal: number, maxCost = 1e9, opts?: PlanOpts): number[] {
  const onDirt = opts?.onDirt ?? PLAN_ROAD_DIRT;
  const onPaved = opts?.onPaved ?? PLAN_ROAD_PAVED;
  const m = s.map;
  const w = m.w;
  const h = m.h;
  const n = w * h;
  if (!(start >= 0 && start < n) || goal >= n) return [];
  if (start === goal) return [start];
  const c = scratch(s);
  const st = newStamp(c);
  const occ = m.occ;
  const road = m.road;
  const river = m.river;
  const g = c.g;
  const from = c.from;
  const seen = c.seen;
  const closed = c.closed;
  const toRoad = goal < 0;
  const gx = toRoad ? 0 : goal % w;
  const gy = toRoad ? 0 : (goal - gx) / w;
  const sx = start % w;
  const sy = (start - sx) / w;
  const lx = gx - sx;
  const ly = gy - sy;
  const ll = Math.hypot(lx, ly) || 1;
  const hmin = Math.min(onDirt, onPaved);
  const heur = (x: number, y: number) => (toRoad ? 0 : hmin * (Math.abs(x - gx) + Math.abs(y - gy)));
  const lineOff = (x: number, y: number) => (toRoad ? 0 : (PLAN_LINE * Math.abs((x - sx) * ly - (y - sy) * lx)) / ll);
  g[start] = 0;
  seen[start] = st;
  from[start] = -1;
  hpush(c, heur(sx, sy), start);
  let end = -1;
  while (c.hs > 0) {
    const cur = hpop(c);
    if (closed[cur] === st) continue;
    closed[cur] = st;
    if (g[cur] > maxCost) break;
    if (toRoad ? cur !== start && road[cur] >= 1 : cur === goal) {
      end = cur;
      break;
    }
    const cx = cur % w;
    const cy = (cur - cx) / w;
    const prev = from[cur];
    const pdx = prev >= 0 ? cx - (prev % w) : 0;
    const pdy = prev >= 0 ? cy - ((prev - (prev % w)) / w) : 0;
    const onNewBridge = river[cur] === 1 && road[cur] < 1;
    for (let k = 0; k < 4; k++) {
      const dx = DX8[k];
      const dy = DY8[k];
      // A new bridge continues straight across.
      if (onNewBridge && (dx !== pdx || dy !== pdy)) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (closed[ni] === st) continue;
      if (occ[ni] >= 0 && ni !== goal) continue;
      let pc = planCost(m, ni, onDirt, onPaved);
      if (pc <= 0) continue;
      // Never lay track along the river: a new bridge must land on the far bank.
      if (onNewBridge && river[ni] === 1 && road[ni] < 1) continue;
      if (road[ni] < 1) pc += lineOff(nx, ny);
      const ng = g[cur] + pc;
      if (seen[ni] !== st || ng < g[ni]) {
        g[ni] = ng;
        from[ni] = cur;
        seen[ni] = st;
        hpush(c, ng + heur(nx, ny), ni);
      }
    }
  }
  if (end < 0) return [];
  return reconstruct(c, start, end);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function cachePut(s: SimState, key: string, path: number[]): void {
  const cache = rt(s).paths;
  if (cache.size >= PATH_CACHE_MAX) cache.clear();
  cache.set(key, path);
}

/** Tile-index path from a to b (inclusive). Cached in runtime.paths. [] if unreachable. */
export function findPath(s: SimState, fromTile: number, toTile: number): number[] {
  const key = fromTile + '>' + toTile;
  const cache = rt(s).paths;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = travelSearch(s, fromTile, toTile);
  cachePut(s, key, p);
  return p;
}

/** Travel time (days) of one step between adjacent tiles a → b. */
function stepDays(s: SimState, a: number, b: number): number {
  const m = s.map;
  const w = m.w;
  const ax = a % w;
  const bx = b % w;
  const diag = ax !== bx && Math.abs(a - b) !== 1;
  let ca = tileMoveCost(m, a);
  let cb = tileMoveCost(m, b);
  if (ca <= 0) ca = 1 / SPEED_DIRT; // endpoints inside buildings / docks
  if (cb <= 0) cb = 1 / SPEED_DIRT;
  return (diag ? SQRT2 : 1) * 0.5 * (ca + cb);
}

/** Travel time in days along a tile path. */
export function pathDays(s: SimState, tiles: readonly number[]): number {
  let d = 0;
  for (let k = 1; k < tiles.length; k++) d += stepDays(s, tiles[k - 1], tiles[k]);
  return d;
}

function townTile(s: SimState, t: TownId): number {
  const town = s.towns[t];
  if (!town) return 0;
  const x = Math.max(0, Math.min(s.map.w - 1, town.x));
  const y = Math.max(0, Math.min(s.map.h - 1, town.y));
  return y * s.map.w + x;
}

/** Summarise a tile path as a Route. */
export function routeFromTiles(s: SimState, a: TownId, b: TownId, tiles: number[]): Route {
  const m = s.map;
  const w = m.w;
  let paved = 0;
  let dirt = 0;
  let offroad = 0;
  let days = 0;
  for (let k = 1; k < tiles.length; k++) {
    const p = tiles[k - 1];
    const q = tiles[k];
    const diag = p % w !== q % w && Math.abs(p - q) !== 1;
    const len = diag ? SQRT2 : 1;
    const rp = m.road[p];
    const rq = m.road[q];
    if (rp >= 2 && rq >= 2) paved += len;
    else if (rp >= 1 && rq >= 1) dirt += len;
    else offroad += len;
    days += stepDays(s, p, q);
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { from: a, to: b, tiles, length: r3(paved + dirt + offroad), paved: r3(paved), dirt: r3(dirt), offroad: r3(offroad), days: r3(days) };
}

/**
 * Route between two town centres (cached in runtime.routes, invalidated when roads change).
 * Same town: a zero-length route. Unreachable (should never happen on a generated map):
 * a straight-line cross-country estimate at half off-road speed, so callers always get
 * finite numbers.
 */
export function routeBetweenTowns(s: SimState, a: TownId, b: TownId): Route {
  const key = a + '>' + b;
  const r = rt(s);
  const hit = r.routes.get(key);
  if (hit) return hit;
  let route: Route;
  if (a === b) {
    const t = townTile(s, a);
    route = { from: a, to: b, tiles: [t], length: 0, paved: 0, dirt: 0, offroad: 0, days: 0 };
  } else {
    const ta = townTile(s, a);
    const tb = townTile(s, b);
    const tiles = findPath(s, ta, tb);
    if (tiles.length >= 2) route = routeFromTiles(s, a, b, tiles);
    else {
      const A = s.towns[a];
      const B = s.towns[b];
      const d = A && B ? Math.hypot(A.x - B.x, A.y - B.y) : 1;
      const len = Math.max(1, Math.round(d * 1000) / 1000);
      route = { from: a, to: b, tiles: [ta, tb], length: len, paved: 0, dirt: 0, offroad: len, days: Math.round(((2 * len) / SPEED_OFFROAD) * 1000) / 1000 };
    }
  }
  r.routes.set(key, route);
  return route;
}

/**
 * Plan a road: the tile path between two towns that a paving project would cover
 * (existing route tiles not yet paved). Used by Build → road.
 * Tiles inside buildings (e.g. the market halls at either end) are left out.
 */
export function roadPlan(s: SimState, a: TownId, b: TownId): number[] {
  if (a === b) return [];
  const route = routeBetweenTowns(s, a, b);
  if (route.tiles.length < 2) return [];
  const m = s.map;
  const out: number[] = [];
  for (const i of route.tiles) {
    if (m.road[i] >= 2) continue;
    if (m.occ[i] >= 0) continue;
    const t = m.terrain[i];
    if (t === Terrain.Water || t === Terrain.DeepWater) continue;
    out.push(i);
  }
  return out;
}

/**
 * A road from tile `a` to tile `b` at `grade` (1 a dirt track, 2 paving): the way a road-builder
 * would lay it (planTrack; an existing road is reused when it lies roughly on the way — it costs
 * half as much to follow as new ground), and of that way the tiles that still need work (below
 * the grade, not under a building, not open water), in order. [] when there is no way.
 */
export function trackPlan(s: SimState, a: number, b: number, grade: 1 | 2): { path: number[]; tiles: number[] } {
  const m = s.map;
  const n = m.w * m.h;
  if (!(a >= 0 && a < n && b >= 0 && b < n) || a === b) return { path: [], tiles: [] };
  const path = planTrack(s, a, b, 1e9, { onDirt: grade >= 2 ? 0.8 : 0.5, onPaved: 0.35 });
  const tiles: number[] = [];
  for (const i of path) {
    if (m.road[i] >= grade || m.occ[i] >= 0) continue;
    const t = m.terrain[i];
    if (t === Terrain.Water || t === Terrain.DeepWater) continue;
    tiles.push(i);
  }
  return { path, tiles };
}

/** Tile a building is reached at: its footprint tile nearest to its town centre. */
export function buildingTile(s: SimState, buildingId: number): number {
  const b = s.buildings[buildingId];
  if (!b) return -1;
  const m = s.map;
  const t = s.towns[b.town];
  const tx = t ? t.x : b.x;
  const ty = t ? t.y : b.y;
  let best = b.y * m.w + b.x;
  let bd = 1e9;
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      const d = (x - tx) * (x - tx) + (y - ty) * (y - ty);
      if (d < bd) {
        bd = d;
        best = y * m.w + x;
      }
    }
  }
  return best;
}

/** Commute path for a person (home tile → job building tile); [] if none. Cached. */
export function commutePath(s: SimState, personId: number): number[] {
  const p = s.people[personId];
  if (!p || !p.alive || p.job < 0) return [];
  const f = s.firms[p.job];
  if (!f || !f.alive) return [];
  const from = p.home >= 0 ? buildingTile(s, p.home) : townTile(s, p.town);
  const to = f.building >= 0 ? buildingTile(s, f.building) : townTile(s, f.town);
  if (from < 0 || to < 0) return [];
  return findPath(s, from, to);
}

/** Path from a building to its town's market hall (for delivery animation). Cached. */
export function deliveryPath(s: SimState, buildingId: number): number[] {
  const b = s.buildings[buildingId];
  if (!b) return [];
  const from = buildingTile(s, buildingId);
  const to = townTile(s, b.town);
  if (from < 0) return [];
  return findPath(s, from, to);
}
