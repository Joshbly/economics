// ============================================================================
// Terrain layer: the map ground pre-rendered into cached chunk canvases.
//
// A chunk is at most CHUNK_PX² device pixels and covers CHUNK_PX / L tiles at
// level of detail L (device px per tile, see constants.LODS). Chunks are
// rendered lazily — the ones in view first, within a per-frame time budget —
// and drawn scaled to the camera; while a chunk is missing, the best cached
// chunk of another level stands in (the coarsest level of the whole map is
// rendered up front, so there is never a hole).
//
// Each chunk: per-pixel ground (fields.fillGround), market plazas, the river,
// roads (smoothed chains) and bridges, then terrain features row by row so
// southern trees and peaks overlap northern ones: forests as clusters of
// little trees, hills as shaded mounds, mountains as lit/shaded peaks with
// snow, marsh pools and reeds, stippled sand, bushes and flowers on grass.
// Neighbouring tiles within CHUNK_MARGIN are drawn too (their features
// overhang), with deterministic jitter, so chunk seams are invisible.
//
// Invalidation: the map's road and occupancy arrays are diffed against a
// snapshot whenever runtime roadVersion / buildingVersion move; only chunks
// near changed tiles are dropped.
// ============================================================================
import { rt } from '../../sim/runtime';
import { Terrain, type MapData, type SimState } from '../../sim/types';
import type { Camera } from './camera';
import { CHUNK_BUDGET_MS, CHUNK_CACHE_MAX, CHUNK_MARGIN, CHUNK_PX, GROUND_MAX_PX, LODS, TILE_PX } from './constants';
import { buildFields, fillGround, ihash, setUrban, type Fields } from './fields';
import { BRIDGE, HILL, MARSH_F, PEAK, RIVER, ROAD, TREE } from './palette';
import { riverCourses, roadChains, type Chain, type River } from './roads';

interface Chunk {
  key: string;
  L: number;
  cx: number;
  cy: number;
  canvas: HTMLCanvasElement;
  /** Tile rectangle covered. */
  tx0: number;
  ty0: number;
  tw: number;
  th: number;
  used: number;
}

/** Per-building data the terrain needs (footprint, door stub). */
interface Site {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Door stub: from a road tile centre to the footprint edge (tile coords), or null. */
  stub: [number, number, number, number] | null;
  market: boolean;
}

export interface TerrainLayer {
  /** Sync with the state (detect road/building changes). Returns true if anything was invalidated. */
  sync(s: SimState): boolean;
  /** Draw the terrain for the camera; queues missing chunks. `ctx` is in device pixels (identity transform). */
  draw(ctx: CanvasRenderingContext2D, cam: Camera, L: number): void;
  /** Render queued chunks for up to `budgetMs`. Returns the number rendered. */
  work(budgetMs?: number): number;
  /** Render every chunk the camera needs now (screenshots, first frame). */
  flush(cam: Camera, L: number): void;
  /** Forget everything (new game). */
  reset(s: SimState): void;
  /** Number of chunks waiting. */
  pending(): number;
  fields(): Fields | null;
  chains(): Chain[];
}

function chunkTiles(L: number): number {
  return Math.max(1, Math.floor(CHUNK_PX / L));
}

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export function createTerrainLayer(): TerrainLayer {
  let S: SimState | null = null;
  let F: Fields | null = null;
  let roads: Chain[] = [];
  let rivers: River[] = [];
  let sites: Site[] = [];
  let bridges: { x: number; y: number; horiz: boolean; paved: boolean }[] = [];
  let plazas: { x: number; y: number }[] = [];
  const cache = new Map<string, Chunk>();
  const queue: { L: number; cx: number; cy: number; key: string }[] = [];
  const queued = new Set<string>();
  let roadSnap: Int8Array = new Int8Array(0);
  let occSnap: Int32Array = new Int32Array(0);
  let roadVer = -1;
  let bldVer = -1;
  let frame = 0;
  let scratch: HTMLCanvasElement | null = null;
  let scratchCtx: CanvasRenderingContext2D | null = null;

  function derive(s: SimState): void {
    const m = s.map;
    const w = m.w;
    const h = m.h;
    // sites & settlement density from buildings
    sites = [];
    plazas = [];
    const urban = new Float32Array(w * h);
    for (const b of s.buildings) {
      if (!b || b.status === 'ruin') continue;
      const resource = b.kind === 'firm' && (b.sector === 'farm' || b.sector === 'fishery' || b.sector === 'lumber' || b.sector === 'coalmine' || b.sector === 'oremine' || b.sector === 'oilwell');
      const water = isWaterTile(m, b.y * w + b.x);
      if (!resource && !water) {
        for (let yy = b.y - 1; yy <= b.y + b.h; yy++) {
          for (let xx = b.x - 1; xx <= b.x + b.w; xx++) {
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const inside = xx >= b.x && xx < b.x + b.w && yy >= b.y && yy < b.y + b.h;
            urban[yy * w + xx] += inside ? 0.7 : 0.16;
          }
        }
      }
      if (b.kind === 'market') plazas.push({ x: b.x, y: b.y });
      sites.push({ x: b.x, y: b.y, w: b.w, h: b.h, stub: b.kind === 'market' ? null : doorStub(s, b.x, b.y, b.w, b.h, b.town), market: b.kind === 'market' });
    }
    for (let i = 0; i < urban.length; i++) urban[i] = Math.min(1, urban[i]);
    if (!F || F.w !== w || F.h !== h) F = buildFields(m, s.seed ^ 0x5eed, urban);
    else setUrban(F, m, urban);
  }

  function deriveRoads(s: SimState): void {
    const m = s.map;
    const w = m.w;
    const hallTile = (i: number) => {
      const o = m.occ[i];
      return o >= 0 && s.buildings[o]?.kind === 'market';
    };
    roads = roadChains(w, m.h, m.road, hallTile, 2);
    rivers = riverCourses(w, m.h, m.river, m.elev, (i) => isWaterTile(m, i), 2);
    bridges = [];
    for (let i = 0; i < w * m.h; i++) {
      if (!m.river[i] || m.road[i] < 1) continue;
      const x = i % w;
      const y = (i - x) / w;
      const rl = (x > 0 && m.road[i - 1] >= 1 ? 1 : 0) + (x < w - 1 && m.road[i + 1] >= 1 ? 1 : 0);
      const rv = (y > 0 && m.road[i - w] >= 1 ? 1 : 0) + (y < m.h - 1 && m.road[i + w] >= 1 ? 1 : 0);
      bridges.push({ x, y, horiz: rl >= rv, paved: m.road[i] >= 2 });
    }
  }

  function snapshot(s: SimState): void {
    const m = s.map;
    roadSnap = Int8Array.from(m.road);
    occSnap = Int32Array.from(m.occ);
    roadVer = rt(s).roadVersion;
    bldVer = rt(s).buildingVersion;
  }

  function invalidateTiles(tiles: number[], w: number): void {
    if (!tiles.length) return;
    // bounding boxes per LOD: drop chunks within CHUNK_MARGIN + 2 of any changed tile
    const pad = CHUNK_MARGIN + 2;
    for (const [key, ch] of cache) {
      let hit = false;
      for (const i of tiles) {
        const x = i % w;
        const y = (i - x) / w;
        if (x >= ch.tx0 - pad && x < ch.tx0 + ch.tw + pad && y >= ch.ty0 - pad && y < ch.ty0 + ch.th + pad) {
          hit = true;
          break;
        }
      }
      if (hit) cache.delete(key);
    }
  }

  function reset(s: SimState): void {
    S = s;
    F = null;
    cache.clear();
    queue.length = 0;
    queued.clear();
    derive(s);
    deriveRoads(s);
    snapshot(s);
    // the whole map at the coarsest level, so there is always something to show
    const L = LODS[0];
    const n = chunkTiles(L);
    for (let cy = 0; cy * n < s.map.h; cy++) for (let cx = 0; cx * n < s.map.w; cx++) render(L, cx, cy);
  }

  function sync(s: SimState): boolean {
    if (s !== S || s.map.w * s.map.h !== roadSnap.length) {
      reset(s);
      return true;
    }
    const r = rt(s);
    if (r.roadVersion === roadVer && r.buildingVersion === bldVer) return false;
    const m = s.map;
    const changed: number[] = [];
    let roadChanged = false;
    let occChanged = false;
    for (let i = 0; i < roadSnap.length; i++) {
      if (m.road[i] !== roadSnap[i]) {
        changed.push(i);
        roadChanged = true;
      } else if (m.occ[i] !== occSnap[i]) {
        changed.push(i);
        occChanged = true;
      }
    }
    snapshot(s);
    if (!changed.length) return false;
    derive(s);
    if (roadChanged || occChanged) deriveRoads(s);
    invalidateTiles(changed, m.w);
    return true;
  }

  function evict(): void {
    if (cache.size <= CHUNK_CACHE_MAX) return;
    const arr = [...cache.values()].filter((c) => c.L !== LODS[0]).sort((a, b) => a.used - b.used);
    let k = 0;
    while (cache.size > CHUNK_CACHE_MAX && k < arr.length) cache.delete(arr[k++].key);
  }

  function getScratch(w: number, h: number): CanvasRenderingContext2D {
    if (!scratch || scratch.width < w || scratch.height < h) {
      scratch = newCanvas(Math.max(w, scratch?.width ?? 0), Math.max(h, scratch?.height ?? 0));
      scratchCtx = scratch.getContext('2d')!;
    }
    return scratchCtx!;
  }

  function render(L: number, cx: number, cy: number): Chunk | null {
    const s = S;
    const fl = F;
    if (!s || !fl) return null;
    const m = s.map;
    const n = chunkTiles(L);
    const tx0 = cx * n;
    const ty0 = cy * n;
    if (tx0 >= m.w || ty0 >= m.h) return null;
    const tw = Math.min(n, m.w - tx0);
    const th = Math.min(n, m.h - ty0);
    const canvas = newCanvas(tw * L, th * L);
    const ctx = canvas.getContext('2d')!;
    // ---- ground ----
    const g = Math.min(L, GROUND_MAX_PX);
    const pw = tw * g;
    const ph = th * g;
    const img = ctx.createImageData(pw, ph);
    fillGround(fl, img.data, pw, ph, tx0, ty0, g);
    if (g === L) ctx.putImageData(img, 0, 0);
    else {
      const sc = getScratch(pw, ph);
      sc.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(scratch!, 0, 0, pw, ph, 0, 0, tw * L, th * L);
    }
    // ---- vector layers in tile units ----
    ctx.setTransform(L, 0, 0, L, -tx0 * L, -ty0 * L);
    const M = CHUNK_MARGIN;
    const vx0 = tx0 - M;
    const vy0 = ty0 - M;
    const vx1 = tx0 + tw + M;
    const vy1 = ty0 + th + M;
    const px = 1 / L; // one device pixel in tile units
    drawPlazas(ctx, vx0, vy0, vx1, vy1);
    drawRivers(ctx, rivers, vx0, vy0, vx1, vy1, px);
    drawRoads(ctx, roads, sites, vx0, vy0, vx1, vy1, px, L);
    drawBridges(ctx, bridges, vx0, vy0, vx1, vy1, px, L);
    drawFeatures(ctx, m, fl.seed, Math.max(0, vx0), Math.max(0, vy0), Math.min(m.w, vx1), Math.min(m.h, vy1), L, px);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const key = L + ':' + cx + ':' + cy;
    const ch: Chunk = { key, L, cx, cy, canvas, tx0, ty0, tw, th, used: frame };
    cache.set(key, ch);
    evict();
    return ch;
  }

  function drawPlazas(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
    for (const p of plazas) {
      // the market square: hall (2×2 at p) plus the ring of track around it
      const px0 = p.x - 1;
      const py0 = p.y - 1;
      if (px0 > x1 || py0 > y1 || px0 + 4 < x0 || py0 + 4 < y0) continue;
      ctx.fillStyle = ROAD.plazaEdge;
      roundRect(ctx, px0 + 0.08, py0 + 0.1, 3.9, 3.9, 0.7);
      ctx.fill();
      ctx.fillStyle = ROAD.plaza;
      roundRect(ctx, px0 + 0.12, py0 + 0.12, 3.76, 3.76, 0.65);
      ctx.fill();
      // a hint of cobbles
      ctx.fillStyle = 'rgba(90,76,56,0.16)';
      for (let yy = 0; yy < 7; yy++) for (let xx = 0; xx < 7; xx++) {
        if ((xx + yy) % 2) continue;
        ctx.fillRect(px0 + 0.3 + xx * 0.5, py0 + 0.3 + yy * 0.5, 0.22, 0.22);
      }
    }
  }

  function draw(ctx: CanvasRenderingContext2D, cam: Camera, L: number): void {
    const s = S;
    if (!s) return;
    frame++;
    const m = s.map;
    const n = chunkTiles(L);
    const k = TILE_PX * cam.z * cam.dpr; // device px per tile
    const ox = cam.vw * cam.dpr / 2 - cam.x * k;
    const oy = cam.vh * cam.dpr / 2 - cam.y * k;
    const x0 = Math.max(0, Math.floor(-ox / k));
    const y0 = Math.max(0, Math.floor(-oy / k));
    const x1 = Math.min(m.w, Math.ceil((cam.vw * cam.dpr - ox) / k));
    const y1 = Math.min(m.h, Math.ceil((cam.vh * cam.dpr - oy) / k));
    if (x1 <= x0 || y1 <= y0) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = k < L * 0.8 ? 'medium' : 'high';
    const cx0 = Math.floor(x0 / n);
    const cy0 = Math.floor(y0 / n);
    const cx1 = Math.floor((x1 - 1) / n);
    const cy1 = Math.floor((y1 - 1) / n);
    // centre-out ordering for the queue
    const want: { cx: number; cy: number; d: number }[] = [];
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = L + ':' + cx + ':' + cy;
        const ch = cache.get(key);
        if (ch) {
          ch.used = frame;
          blit(ctx, ch, ox, oy, k);
        } else {
          fallback(ctx, L, cx, cy, n, ox, oy, k, m.w, m.h);
          const ccx = (cx + 0.5) * n;
          const ccy = (cy + 0.5) * n;
          want.push({ cx, cy, d: (ccx - cam.x) ** 2 + (ccy - cam.y) ** 2 });
        }
      }
    }
    // re-prioritise the queue to what is in view now
    if (want.length) {
      want.sort((a, b) => a.d - b.d);
      const fresh = want.map((w) => ({ L, cx: w.cx, cy: w.cy, key: L + ':' + w.cx + ':' + w.cy }));
      queue.length = 0;
      queued.clear();
      for (const q of fresh) {
        queue.push(q);
        queued.add(q.key);
      }
    } else if (queue.length && queue[0].L !== L) {
      queue.length = 0;
      queued.clear();
    }
  }

  function blit(ctx: CanvasRenderingContext2D, ch: Chunk, ox: number, oy: number, k: number): void {
    // integer device-pixel edges shared by neighbours → no hairline seams
    const dx0 = Math.round(ox + ch.tx0 * k);
    const dy0 = Math.round(oy + ch.ty0 * k);
    const dx1 = Math.round(ox + (ch.tx0 + ch.tw) * k);
    const dy1 = Math.round(oy + (ch.ty0 + ch.th) * k);
    if (dx1 <= dx0 || dy1 <= dy0) return;
    ctx.drawImage(ch.canvas, dx0, dy0, dx1 - dx0, dy1 - dy0);
  }

  /** Draw the area of a missing chunk from cached chunks of other levels. */
  function fallback(ctx: CanvasRenderingContext2D, L: number, cx: number, cy: number, n: number, ox: number, oy: number, k: number, mw: number, mh: number): void {
    const tx0 = cx * n;
    const ty0 = cy * n;
    const tx1 = Math.min(mw, tx0 + n);
    const ty1 = Math.min(mh, ty0 + n);
    // prefer the nearest finer level, then coarser
    const order = [...LODS].filter((x) => x !== L).sort((a, b) => Math.abs(Math.log(a / L)) - Math.abs(Math.log(b / L)) || b - a);
    for (const L2 of order) {
      const n2 = chunkTiles(L2);
      const c0 = Math.floor(tx0 / n2);
      const c1 = Math.floor((tx1 - 1) / n2);
      const r0 = Math.floor(ty0 / n2);
      const r1 = Math.floor((ty1 - 1) / n2);
      let all = true;
      for (let r = r0; r <= r1 && all; r++) for (let c = c0; c <= c1; c++) if (!cache.has(L2 + ':' + c + ':' + r)) {
        all = false;
        break;
      }
      if (!all) continue;
      ctx.save();
      ctx.beginPath();
      const dx0 = Math.round(ox + tx0 * k);
      const dy0 = Math.round(oy + ty0 * k);
      ctx.rect(dx0, dy0, Math.round(ox + tx1 * k) - dx0, Math.round(oy + ty1 * k) - dy0);
      ctx.clip();
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const ch = cache.get(L2 + ':' + c + ':' + r)!;
        ch.used = frame;
        blit(ctx, ch, ox, oy, k);
      }
      ctx.restore();
      return;
    }
  }

  function work(budgetMs = CHUNK_BUDGET_MS): number {
    let done = 0;
    const t0 = performance.now();
    while (queue.length) {
      const q = queue.shift()!;
      queued.delete(q.key);
      if (cache.has(q.key)) continue;
      render(q.L, q.cx, q.cy);
      done++;
      if (performance.now() - t0 >= budgetMs) break;
    }
    return done;
  }

  function flush(cam: Camera, L: number): void {
    const s = S;
    if (!s) return;
    const n = chunkTiles(L);
    const k = TILE_PX * cam.z * cam.dpr;
    const ox = cam.vw * cam.dpr / 2 - cam.x * k;
    const oy = cam.vh * cam.dpr / 2 - cam.y * k;
    const x0 = Math.max(0, Math.floor(-ox / k));
    const y0 = Math.max(0, Math.floor(-oy / k));
    const x1 = Math.min(s.map.w, Math.ceil((cam.vw * cam.dpr - ox) / k));
    const y1 = Math.min(s.map.h, Math.ceil((cam.vh * cam.dpr - oy) / k));
    for (let cy = Math.floor(y0 / n); cy * n < y1; cy++) for (let cx = Math.floor(x0 / n); cx * n < x1; cx++) {
      if (!cache.has(L + ':' + cx + ':' + cy)) render(L, cx, cy);
    }
    queue.length = 0;
    queued.clear();
  }

  return {
    sync,
    draw,
    work,
    flush,
    reset,
    pending: () => queue.length,
    fields: () => F,
    chains: () => roads,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isWaterTile(m: MapData, i: number): boolean {
  const t = m.terrain[i];
  return t === Terrain.Water || t === Terrain.DeepWater;
}

export function roundRect(ctx: CanvasRenderingContext2D | Path2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (ctx instanceof Path2D) {
    ctx.moveTo(x + rr, y);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
  }
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** Short track from the nearest road tile beside a footprint to the footprint's edge. */
function doorStub(s: SimState, bx: number, by: number, bw: number, bh: number, town: number): [number, number, number, number] | null {
  const m = s.map;
  const t = s.towns[town];
  const tx = t ? t.x : bx;
  const ty = t ? t.y : by;
  let best: [number, number, number, number] | null = null;
  let bd = 1e9;
  const test = (x: number, y: number, ex: number, ey: number) => {
    if (x < 0 || y < 0 || x >= m.w || y >= m.h) return;
    if (m.road[y * m.w + x] < 1) return;
    const o = m.occ[y * m.w + x];
    if (o >= 0) return;
    const d = Math.hypot(x - tx, y - ty);
    if (d < bd) {
      bd = d;
      best = [x + 0.5, y + 0.5, ex, ey];
    }
  };
  for (let x = bx; x < bx + bw; x++) {
    test(x, by - 1, x + 0.5, by + 0.15);
    test(x, by + bh, x + 0.5, by + bh - 0.1);
  }
  for (let y = by; y < by + bh; y++) {
    test(bx - 1, y, bx + 0.12, y + 0.55);
    test(bx + bw, y, bx + bw - 0.12, y + 0.55);
  }
  return best;
}

function inBox(c: { x0: number; y0: number; x1: number; y1: number }, x0: number, y0: number, x1: number, y1: number): boolean {
  return !(c.x1 < x0 - 1 || c.y1 < y0 - 1 || c.x0 > x1 + 1 || c.y0 > y1 + 1);
}

function strokeChain(ctx: CanvasRenderingContext2D, pts: number[]): void {
  ctx.moveTo(pts[0], pts[1]);
  for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
}

function drawRivers(ctx: CanvasRenderingContext2D, rivers: River[], x0: number, y0: number, x1: number, y1: number, px: number): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const r of rivers) {
    if (!inBox(r, x0, y0, x1, y1)) continue;
    const n = r.pts.length / 2;
    // three passes, in segments so the width can grow downstream
    for (let pass = 0; pass < 3; pass++) {
      ctx.strokeStyle = pass === 0 ? RIVER.bank : pass === 1 ? RIVER.water : RIVER.light;
      const SEG = 4;
      for (let k = 0; k < n - 1; k += SEG) {
        const e = Math.min(n - 1, k + SEG);
        const wv = r.width[Math.min(n - 1, (k + e) >> 1)];
        const w = pass === 0 ? wv + 0.16 : pass === 1 ? wv : Math.max(px, wv * 0.18);
        ctx.lineWidth = Math.max(w, pass === 2 ? px : 1.4 * px);
        ctx.beginPath();
        const off = pass === 2 ? -wv * 0.18 : 0;
        ctx.moveTo(r.pts[2 * k] + off, r.pts[2 * k + 1] + off);
        for (let j = k + 1; j <= e; j++) ctx.lineTo(r.pts[2 * j] + off, r.pts[2 * j + 1] + off);
        ctx.stroke();
      }
    }
  }
}

function drawRoads(ctx: CanvasRenderingContext2D, chains: Chain[], sites: Site[], x0: number, y0: number, x1: number, y1: number, px: number, L: number): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const vis = chains.filter((c) => inBox(c, x0, y0, x1, y1));
  const stubs = sites.filter((st) => st.stub && st.x + st.w >= x0 - 1 && st.x <= x1 + 1 && st.y + st.h >= y0 - 1 && st.y <= y1 + 1).map((st) => st.stub!);
  const dirt = vis.filter((c) => c.level < 2);
  const paved = vis.filter((c) => c.level >= 2);
  const path = (list: Chain[], withStubs: boolean) => {
    ctx.beginPath();
    for (const c of list) strokeChain(ctx, c.pts);
    if (withStubs) for (const s of stubs) {
      ctx.moveTo(s[0], s[1]);
      ctx.lineTo(s[2], s[3]);
    }
  };
  const W = (tiles: number, minPx: number) => Math.max(tiles, minPx * px);
  // dirt tracks: soft brown edge, core, faint ruts when close
  path(dirt, true);
  ctx.strokeStyle = ROAD.dirtEdge;
  ctx.lineWidth = W(0.4, 2.6);
  ctx.stroke();
  ctx.strokeStyle = ROAD.dirt;
  ctx.lineWidth = W(0.27, 1.6);
  ctx.stroke();
  if (L >= 32) {
    ctx.strokeStyle = ROAD.dirtRut;
    ctx.lineWidth = W(0.035, 0.8);
    ctx.setLineDash([0.22, 0.12]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (paved.length) {
    path(paved, false);
    ctx.strokeStyle = ROAD.pavedEdge;
    ctx.lineWidth = W(0.5, 3);
    ctx.stroke();
    ctx.strokeStyle = ROAD.pavedLine;
    ctx.lineWidth = W(0.42, 2.2);
    ctx.stroke();
    ctx.strokeStyle = ROAD.paved;
    ctx.lineWidth = W(0.33, 1.4);
    ctx.stroke();
    if (L >= 32) {
      ctx.strokeStyle = 'rgba(80,78,72,0.35)';
      ctx.lineWidth = W(0.3, 1);
      ctx.setLineDash([0.035, 0.13]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function drawBridges(ctx: CanvasRenderingContext2D, list: { x: number; y: number; horiz: boolean; paved: boolean }[], x0: number, y0: number, x1: number, y1: number, px: number, L: number): void {
  for (const b of list) {
    if (b.x < x0 - 1 || b.x > x1 || b.y < y0 - 1 || b.y > y1) continue;
    const cx = b.x + 0.5;
    const cy = b.y + 0.5;
    ctx.save();
    ctx.translate(cx, cy);
    if (!b.horiz) ctx.rotate(Math.PI / 2);
    // along x: length 1.25, width 0.5
    const len = 1.3;
    const wd = b.paved ? 0.56 : 0.46;
    ctx.fillStyle = 'rgba(20,30,30,0.35)';
    ctx.fillRect(-len / 2 + 0.05, -wd / 2 + 0.08, len, wd);
    ctx.fillStyle = b.paved ? BRIDGE.stone : BRIDGE.wood;
    ctx.fillRect(-len / 2, -wd / 2, len, wd);
    ctx.fillStyle = b.paved ? BRIDGE.stoneDark : BRIDGE.woodDark;
    const rail = Math.max(0.06, 1.2 * px);
    ctx.fillRect(-len / 2, -wd / 2, len, rail);
    ctx.fillRect(-len / 2, wd / 2 - rail, len, rail);
    if (L >= 32) {
      ctx.strokeStyle = b.paved ? 'rgba(80,76,70,0.5)' : 'rgba(70,50,32,0.55)';
      ctx.lineWidth = Math.max(px, 0.02);
      ctx.beginPath();
      if (b.paved) {
        ctx.moveTo(-len / 2 + 0.1, 0);
        ctx.lineTo(len / 2 - 0.1, 0);
      } else {
        for (let k = -len / 2 + 0.12; k < len / 2 - 0.05; k += 0.12) {
          ctx.moveTo(k, -wd / 2 + rail);
          ctx.lineTo(k, wd / 2 - rail);
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Terrain features (trees, peaks, hills, marsh, sand, grass)
// ---------------------------------------------------------------------------

const TREE_SPOTS: Record<number, [number, number][]> = {
  2: [
    [0.32, 0.34],
    [0.7, 0.72],
  ],
  3: [
    [0.28, 0.3],
    [0.74, 0.42],
    [0.36, 0.78],
  ],
  5: [
    [0.24, 0.22],
    [0.72, 0.2],
    [0.48, 0.52],
    [0.2, 0.8],
    [0.78, 0.78],
  ],
};

function drawFeatures(ctx: CanvasRenderingContext2D, m: MapData, seed: number, x0: number, y0: number, x1: number, y1: number, L: number, px: number): void {
  const w = m.w;
  const nTrees = L >= 32 ? 5 : L >= 16 ? 3 : 2;
  const spots = TREE_SPOTS[nTrees];
  const rScale = L >= 32 ? 1 : L >= 16 ? 1.18 : 1.45;
  // reusable per-row paths
  for (let y = y0; y < y1; y++) {
    const shadow = new Path2D();
    const dark: Path2D[] = [new Path2D(), new Path2D(), new Path2D()];
    const mid: Path2D[] = [new Path2D(), new Path2D(), new Path2D()];
    const light: Path2D[] = [new Path2D(), new Path2D(), new Path2D()];
    const conD = new Path2D();
    const conM = new Path2D();
    const conL = new Path2D();
    let anyTree = false;
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      const t = m.terrain[i];
      if (m.occ[i] >= 0 || m.road[i] >= 1 || m.river[i]) {
        continue;
      }
      if (t === Terrain.Forest) {
        const e = m.elev[i] ?? 0.3;
        // fewer trees on the forest's edge so woods have soft outlines
        let edge = 0;
        if (x > 0 && m.terrain[i - 1] !== Terrain.Forest) edge++;
        if (x < w - 1 && m.terrain[i + 1] !== Terrain.Forest) edge++;
        if (y > 0 && m.terrain[i - w] !== Terrain.Forest) edge++;
        if (y < m.h - 1 && m.terrain[i + w] !== Terrain.Forest) edge++;
        for (let k = 0; k < spots.length; k++) {
          const h1 = ihash(seed + k * 101, x, y);
          const h2 = ihash(seed + k * 211 + 7, x, y);
          const h3 = ihash(seed + k * 307 + 13, x, y);
          if (edge >= 2 && h3 < 0.35) continue;
          const tx = x + spots[k][0] + (h1 - 0.5) * 0.26;
          const ty = y + spots[k][1] + (h2 - 0.5) * 0.24;
          const r = (0.2 + 0.1 * h3) * rScale * (edge ? 0.9 : 1);
          const conifer = e > 0.5 ? h3 < 0.75 : h3 < 0.18;
          anyTree = true;
          shadow.moveTo(tx + 0.08 + r, ty + 0.1);
          shadow.ellipse(tx + 0.08, ty + 0.1, r * 1.02, r * 0.78, 0, 0, Math.PI * 2);
          if (conifer) {
            const hgt = r * 2.3;
            conD.moveTo(tx, ty - hgt * 0.62);
            conD.lineTo(tx + r * 0.95, ty + hgt * 0.38);
            conD.lineTo(tx - r * 0.95, ty + hgt * 0.38);
            conD.closePath();
            conM.moveTo(tx, ty - hgt * 0.62);
            conM.lineTo(tx + r * 0.1, ty + hgt * 0.36);
            conM.lineTo(tx - r * 0.95, ty + hgt * 0.38);
            conM.closePath();
            if (L >= 16) {
              conL.moveTo(tx, ty - hgt * 0.6);
              conL.lineTo(tx - r * 0.12, ty - hgt * 0.05);
              conL.lineTo(tx - r * 0.55, ty + hgt * 0.1);
              conL.closePath();
            }
          } else {
            const b = Math.floor(h1 * 3) % 3;
            dark[b].moveTo(tx + r, ty);
            dark[b].arc(tx, ty, r, 0, Math.PI * 2);
            mid[b].moveTo(tx - r * 0.1 + r * 0.8, ty - r * 0.12);
            mid[b].arc(tx - r * 0.1, ty - r * 0.12, r * 0.8, 0, Math.PI * 2);
            if (L >= 16) {
              light[b].moveTo(tx - r * 0.3 + r * 0.36, ty - r * 0.34);
              light[b].arc(tx - r * 0.3, ty - r * 0.34, r * 0.36, 0, Math.PI * 2);
            }
          }
        }
      } else if (t === Terrain.Grass) {
        const h1 = ihash(seed ^ 0xb005, x, y);
        let nearForest = false;
        if ((x > 0 && m.terrain[i - 1] === Terrain.Forest) || (x < w - 1 && m.terrain[i + 1] === Terrain.Forest) || (y > 0 && m.terrain[i - w] === Terrain.Forest) || (y < m.h - 1 && m.terrain[i + w] === Terrain.Forest)) nearForest = true;
        if (h1 < (nearForest ? 0.22 : 0.035)) {
          // a lone tree or bush
          const tx = x + 0.25 + 0.5 * ihash(seed ^ 0x11, x, y);
          const ty = y + 0.25 + 0.5 * ihash(seed ^ 0x22, x, y);
          const r = (0.14 + 0.1 * ihash(seed ^ 0x33, x, y)) * rScale;
          const b = Math.floor(ihash(seed ^ 0x44, x, y) * 3) % 3;
          anyTree = true;
          shadow.moveTo(tx + 0.06 + r, ty + 0.08);
          shadow.ellipse(tx + 0.06, ty + 0.08, r, r * 0.75, 0, 0, Math.PI * 2);
          dark[b].moveTo(tx + r, ty);
          dark[b].arc(tx, ty, r, 0, Math.PI * 2);
          mid[b].moveTo(tx - r * 0.1 + r * 0.8, ty - r * 0.12);
          mid[b].arc(tx - r * 0.1, ty - r * 0.12, r * 0.8, 0, Math.PI * 2);
          if (L >= 16) {
            light[b].moveTo(tx - r * 0.3 + r * 0.36, ty - r * 0.34);
            light[b].arc(tx - r * 0.3, ty - r * 0.34, r * 0.36, 0, Math.PI * 2);
          }
        }
      }
    }
    // per-row non-tree features (drawn first: they sit on the ground)
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (m.occ[i] >= 0 || m.road[i] >= 1 || m.river[i]) continue;
      const t = m.terrain[i];
      if (t === Terrain.Hills && L >= 16) drawHill(ctx, seed, x, y, m.elev[i] ?? 0.6, px);
      else if (t === Terrain.Marsh) drawMarsh(ctx, seed, x, y, L, px);
      else if (t === Terrain.Sand && L >= 32) drawSand(ctx, seed, x, y);
      else if (t === Terrain.Grass && L >= 32) drawGrass(ctx, seed, x, y, L, m.fert[i] ?? 0.5);
    }
    if (anyTree) {
      ctx.fillStyle = TREE.shadow;
      ctx.fill(shadow);
      for (let b = 0; b < 3; b++) {
        ctx.fillStyle = TREE.dark[b];
        ctx.fill(dark[b]);
        ctx.fillStyle = TREE.mid[b];
        ctx.fill(mid[b]);
        if (L >= 16) {
          ctx.fillStyle = TREE.light[b];
          ctx.fill(light[b]);
        }
      }
      ctx.fillStyle = TREE.conDark;
      ctx.fill(conD);
      ctx.fillStyle = TREE.conMid;
      ctx.fill(conM);
      if (L >= 16) {
        ctx.fillStyle = TREE.conLight;
        ctx.fill(conL);
      }
    }
    // mountains after trees of the same row (they tower)
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (m.terrain[i] !== Terrain.Mountain || m.occ[i] >= 0 || m.road[i] >= 1) continue;
      drawPeak(ctx, seed, x, y, m.elev[i] ?? 0.85, L, px);
    }
  }
}

function drawHill(ctx: CanvasRenderingContext2D, seed: number, x: number, y: number, e: number, px: number): void {
  const n = ihash(seed ^ 0x4a11, x, y) < 0.45 ? 2 : 1;
  for (let k = 0; k < n; k++) {
    const h1 = ihash(seed + 31 * k, x, y);
    const h2 = ihash(seed + 57 * k + 3, x, y);
    const cx = x + (n === 1 ? 0.5 : k === 0 ? 0.32 : 0.7) + (h1 - 0.5) * 0.2;
    const cy = y + (n === 1 ? 0.66 : k === 0 ? 0.5 : 0.82) + (h2 - 0.5) * 0.14;
    const rx = (n === 1 ? 0.44 : 0.32) * (0.85 + 0.3 * h2);
    const ry = rx * (0.5 + 0.25 * Math.min(1, (e - 0.55) * 3));
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, Math.PI, 2 * Math.PI);
    ctx.closePath();
    ctx.fillStyle = HILL.lit;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx + rx * 0.05, cy - ry);
    ctx.ellipse(cx, cy, rx, ry, 0, 1.52 * Math.PI, 2 * Math.PI);
    ctx.lineTo(cx + rx * 0.05, cy);
    ctx.closePath();
    ctx.fillStyle = HILL.shade;
    ctx.fill();
  }
}

function drawPeak(ctx: CanvasRenderingContext2D, seed: number, x: number, y: number, e: number, L: number, px: number): void {
  const h1 = ihash(seed ^ 0x9ea1, x, y);
  const h2 = ihash(seed ^ 0x9ea2, x, y);
  const h3 = ihash(seed ^ 0x9ea3, x, y);
  const hi = Math.max(0, Math.min(1, (e - 0.76) / 0.24));
  const cx = x + 0.5 + (h1 - 0.5) * 0.3;
  const by = y + 0.86 + (h2 - 0.5) * 0.12;
  const bw = 0.62 + 0.16 * h3;
  const hgt = (0.72 + 0.62 * hi) * (0.85 + 0.3 * h2);
  const ax = cx + (h1 - 0.5) * 0.25;
  const ay = by - hgt;
  const mx = cx + (ax - cx) * 0.4 + 0.08;
  // shadow at the foot
  ctx.fillStyle = 'rgba(40,36,32,0.22)';
  ctx.beginPath();
  ctx.ellipse(cx + 0.12, by + 0.02, bw * 1.05, 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  // lit (west) face
  ctx.fillStyle = PEAK.lit;
  ctx.beginPath();
  ctx.moveTo(cx - bw, by);
  ctx.lineTo(ax, ay);
  ctx.lineTo(mx, by);
  ctx.closePath();
  ctx.fill();
  // shaded (east) face
  ctx.fillStyle = hi > 0.5 ? PEAK.shade : PEAK.deep;
  ctx.beginPath();
  ctx.moveTo(mx, by);
  ctx.lineTo(ax, ay);
  ctx.lineTo(cx + bw, by);
  ctx.closePath();
  ctx.fill();
  if (L >= 16) {
    // a ridge line down the lit face
    ctx.strokeStyle = PEAK.line;
    ctx.lineWidth = Math.max(px, 0.025);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - (ax - (cx - bw)) * 0.35 + 0.02, ay + hgt * 0.45);
    ctx.stroke();
  }
  // snow on the higher peaks
  if (hi > 0.18) {
    const f = 0.28 + 0.2 * hi;
    const sy = ay + hgt * f;
    const lx = ax + ((cx - bw) - ax) * f;
    const rx = ax + ((cx + bw) - ax) * f;
    const mxs = ax + (mx - ax) * f;
    ctx.fillStyle = PEAK.snow;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(lx, sy);
    ctx.lineTo(lx + (mxs - lx) * 0.35, sy - hgt * 0.06);
    ctx.lineTo(lx + (mxs - lx) * 0.7, sy + hgt * 0.03);
    ctx.lineTo(mxs, sy - hgt * 0.02);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = PEAK.snowShade;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(mxs, sy - hgt * 0.02);
    ctx.lineTo(mxs + (rx - mxs) * 0.5, sy - hgt * 0.07);
    ctx.lineTo(rx, sy);
    ctx.closePath();
    ctx.fill();
  }
}

function drawMarsh(ctx: CanvasRenderingContext2D, seed: number, x: number, y: number, L: number, px: number): void {
  const h1 = ihash(seed ^ 0x3a01, x, y);
  const h2 = ihash(seed ^ 0x3a02, x, y);
  // pools
  const nPools = h1 < 0.55 ? 2 : 1;
  for (let k = 0; k < nPools; k++) {
    const a = ihash(seed + 71 * k, x, y);
    const b = ihash(seed + 89 * k + 5, x, y);
    const cx = x + 0.25 + 0.5 * a;
    const cy = y + 0.25 + 0.5 * b;
    const rx = 0.13 + 0.12 * h2;
    const ry = rx * 0.55;
    ctx.fillStyle = MARSH_F.pool;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    if (L >= 16) {
      ctx.strokeStyle = MARSH_F.poolRim;
      ctx.lineWidth = Math.max(px, 0.025);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, Math.PI * 1.05, Math.PI * 1.7);
      ctx.stroke();
    }
  }
  if (L < 16) return;
  // reeds
  ctx.lineCap = 'round';
  const clusters = L >= 32 ? 3 : 2;
  for (let c = 0; c < clusters; c++) {
    const a = ihash(seed + 131 * c + 1, x, y);
    const b = ihash(seed + 151 * c + 2, x, y);
    const cx = x + 0.15 + 0.7 * a;
    const cy = y + 0.3 + 0.6 * b;
    ctx.strokeStyle = c % 2 ? MARSH_F.reedLight : MARSH_F.reed;
    ctx.lineWidth = Math.max(px, 0.03);
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const dx = (k - 1.5) * 0.045;
      const hgt = 0.14 + 0.1 * ihash(seed + k * 7 + c * 3, x, y);
      ctx.moveTo(cx + dx, cy);
      ctx.lineTo(cx + dx * 1.8, cy - hgt);
    }
    ctx.stroke();
    if (L >= 32 && a < 0.5) {
      ctx.fillStyle = MARSH_F.cattail;
      ctx.fillRect(cx + 0.02, cy - 0.24, 0.035, 0.07);
    }
  }
}

function drawSand(ctx: CanvasRenderingContext2D, seed: number, x: number, y: number): void {
  ctx.fillStyle = 'rgba(150,126,84,0.28)';
  for (let k = 0; k < 7; k++) {
    const a = ihash(seed + 17 * k, x, y);
    const b = ihash(seed + 29 * k + 1, x, y);
    ctx.fillRect(x + a * 0.95, y + b * 0.95, 0.035, 0.035);
  }
}

function drawGrass(ctx: CanvasRenderingContext2D, seed: number, x: number, y: number, L: number, fert: number): void {
  ctx.strokeStyle = 'rgba(58,92,40,0.35)';
  ctx.lineWidth = 0.022;
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const a = ihash(seed + 41 * k + 9, x, y);
    const b = ihash(seed + 43 * k + 11, x, y);
    const cx = x + 0.1 + 0.8 * a;
    const cy = y + 0.15 + 0.8 * b;
    ctx.moveTo(cx - 0.04, cy);
    ctx.lineTo(cx - 0.06, cy - 0.07);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - 0.09);
    ctx.moveTo(cx + 0.04, cy);
    ctx.lineTo(cx + 0.06, cy - 0.07);
  }
  ctx.stroke();
  if (L >= 64 && fert > 0.35) {
    const cols = ['#f1e7c7', '#e9c85a', '#d98fa0', '#c9d4f0'];
    for (let k = 0; k < 3; k++) {
      const a = ihash(seed + 61 * k + 3, x, y);
      if (a > 0.45) continue;
      const b = ihash(seed + 67 * k + 5, x, y);
      const c2 = ihash(seed + 71 * k + 7, x, y);
      ctx.fillStyle = cols[Math.floor(c2 * cols.length) % cols.length];
      ctx.beginPath();
      ctx.arc(x + 0.1 + 0.8 * b, y + 0.1 + 0.8 * c2, 0.022, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
