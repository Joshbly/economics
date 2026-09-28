// ============================================================================
// Building layer: cached sprites per building and level of detail, drawn in
// depth order (by the footprint's southern edge) every frame.
//
// A sprite is rebuilt only when its look changes (kind, sector, status, level,
// Treasury ownership, farm season) or the level of detail changes; rebuilding
// is time-budgeted and the previous sprite (any level) stands in meanwhile.
// Construction: a ghost of the finished building fades in with the project's
// progress under scaffolding, with a progress bar. Vacant: desaturated and
// boarded up. Status visuals that change every frame (smoke, lit windows,
// selection) are drawn by other layers from each sprite's SpriteMeta.
// ============================================================================
import { seasonOf } from '../../sim/calendar';
import { rt } from '../../sim/runtime';
import { STATE, Terrain, type Building, type SimState, type TownKind } from '../../sim/types';
import { SPRITE_BUDGET_MS, SPRITE_CACHE_MAX, SPRITE_MBOT, SPRITE_MTOP, SPRITE_MX } from './constants';
import { paintBoards, paintBuilding, paintScaffold, type Look, type SpriteMeta } from './sprites';

export type Variant = 'a' | 'v' | 'c';

interface Entry {
  key: string;
  sig: string;
  L: number;
  canvas: HTMLCanvasElement;
  meta: SpriteMeta;
  used: number;
}

/** Per-building info refreshed when buildings change or a day passes. */
export interface BInfo {
  b: Building;
  look: Look;
  sig: string;
  variant: Variant;
  /** 0..1 progress of an active project on this building, or -1. */
  progress: number;
  /** An enlargement is under way (building stays active). */
  expanding: boolean;
  /** Meta of the active look (for windows/smoke even when drawn from another level). */
  meta: SpriteMeta | null;
}

export interface BuildingLayer {
  sync(s: SimState): void;
  /** Buildings in draw order. */
  list(): BInfo[];
  info(id: number): BInfo | undefined;
  /** Draw all visible buildings. ctx is in device pixels; k = device px per tile; (ox, oy) = device px of world (0,0). */
  draw(ctx: CanvasRenderingContext2D, L: number, k: number, ox: number, oy: number, vw: number, vh: number, time: number): void;
  work(budgetMs?: number): number;
  /** Draw a ghost (placement preview) of a would-be building. */
  ghost(ctx: CanvasRenderingContext2D, look: Look, L: number, k: number, ox: number, oy: number, x: number, y: number, alpha: number): void;
  reset(): void;
}

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

function spriteSize(look: Look, L: number): [number, number] {
  return [(look.w + 2 * SPRITE_MX) * L, (look.h + SPRITE_MTOP + SPRITE_MBOT) * L];
}

/** Direction of shallow/deep water beside a footprint (0 E, 1 W, 2 S, 3 N), or -1. */
function waterSide(s: SimState, b: Building): number {
  const m = s.map;
  const water = (x: number, y: number) => x >= 0 && y >= 0 && x < m.w && y < m.h && (m.terrain[y * m.w + x] === Terrain.Water || m.terrain[y * m.w + x] === Terrain.DeepWater);
  const score = [0, 0, 0, 0];
  for (let y = b.y; y < b.y + b.h; y++) {
    if (water(b.x + b.w, y)) score[0]++;
    if (water(b.x - 1, y)) score[1]++;
  }
  for (let x = b.x; x < b.x + b.w; x++) {
    if (water(x, b.y + b.h)) score[2]++;
    if (water(x, b.y - 1)) score[3]++;
  }
  let best = -1;
  let bs = 0;
  // prefer south, then east (the sea lies south-east), then the rest
  for (const d of [2, 0, 1, 3]) if (score[d] > bs) {
    bs = score[d];
    best = d;
  }
  return best;
}

export function lookOf(s: SimState, b: Building): Look {
  const t = s.towns[b.town];
  const f = b.firm >= 0 ? s.firms[b.firm] : undefined;
  const treasury = b.kind === 'house' || b.kind === 'firm' ? b.owner === STATE || (!!f && f.alive && f.owner === STATE) : false;
  const m = s.map;
  const i0 = b.y * m.w + b.x;
  const onWater = i0 >= 0 && i0 < m.terrain.length && (m.terrain[i0] === Terrain.Water || m.terrain[i0] === Terrain.DeepWater);
  const needsWater = b.kind === 'port' || (b.kind === 'firm' && b.sector === 'fishery');
  return {
    id: b.id,
    kind: b.kind,
    sector: b.sector,
    w: b.w,
    h: b.h,
    level: b.level,
    townKind: (t?.kind ?? 'capital') as TownKind,
    town: b.town,
    treasury,
    season: b.kind === 'firm' && b.sector === 'farm' ? seasonOf(s.day) : 0,
    waterDir: needsWater ? waterSide(s, b) : -1,
    onWater,
  };
}

function sigOf(look: Look, variant: Variant): string {
  return `${look.kind}|${look.sector}|${variant}|${look.level}|${look.treasury ? 1 : 0}|${look.season}|${look.w}x${look.h}|${look.waterDir}|${look.onWater ? 1 : 0}`;
}

/** Fraction of a project's work done (labour and materials pooled by quantity). */
export function projectProgress(s: SimState, pid: number): number {
  if (pid < 0) return -1;
  const p = s.projects.find((q) => q && q.id === pid);
  if (!p) return -1;
  const need = p.need;
  const done = p.done;
  let n = 0;
  let d = 0;
  for (const k of ['labor', 'wood', 'iron', 'tools'] as const) {
    const a = Math.max(0, need[k] || 0);
    n += a;
    d += Math.min(a, Math.max(0, done[k] || 0));
  }
  if (!(n > 0)) return 0;
  const f = d / n;
  return Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0;
}

export function createBuildingLayer(): BuildingLayer {
  const cache = new Map<string, Entry>();
  let infos: BInfo[] = [];
  const byId = new Map<number, BInfo>();
  let ver = -1;
  let day = -1;
  let S: SimState | null = null;
  let frame = 0;
  let pixels = 0;
  const queue: { info: BInfo; variant: Variant; L: number; key: string }[] = [];
  const queued = new Set<string>();
  let tmp: HTMLCanvasElement | null = null;

  function sync(s: SimState): void {
    const v = rt(s).buildingVersion;
    if (s === S && v === ver && s.day === day) {
      // projects progress daily; refresh progress cheaply every frame is unnecessary
      return;
    }
    S = s;
    ver = v;
    day = s.day;
    const list: BInfo[] = [];
    byId.clear();
    for (const b of s.buildings) {
      if (!b || b.status === 'ruin') continue;
      const look = lookOf(s, b);
      const variant: Variant = b.status === 'construction' ? 'c' : b.status === 'vacant' ? 'v' : 'a';
      const progress = b.project >= 0 ? projectProgress(s, b.project) : -1;
      const info: BInfo = { b, look, sig: sigOf(look, variant), variant, progress, expanding: b.status === 'active' && b.project >= 0, meta: null };
      const act = cache.get(b.id + ':a');
      if (act) info.meta = act.meta;
      list.push(info);
      byId.set(b.id, info);
    }
    list.sort((p, q) => p.b.y + p.b.h - (q.b.y + q.b.h) || p.b.x - q.b.x);
    infos = list;
  }

  function build(info: BInfo, variant: Variant, L: number): Entry {
    const look = info.look;
    const [cw, ch] = spriteSize(look, L);
    const canvas = newCanvas(cw, ch);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(L, 0, 0, L, SPRITE_MX * L, SPRITE_MTOP * L);
    let meta: SpriteMeta;
    if (variant === 'c') {
      meta = paintScaffold(ctx, look, L);
    } else if (variant === 'v') {
      // paint, then desaturate & dim only where something was painted, then board up
      if (!tmp || tmp.width < canvas.width || tmp.height < canvas.height) tmp = newCanvas(Math.max(canvas.width, tmp?.width ?? 0), Math.max(canvas.height, tmp?.height ?? 0));
      const t = tmp.getContext('2d')!;
      t.setTransform(1, 0, 0, 1, 0, 0);
      t.clearRect(0, 0, tmp.width, tmp.height);
      t.setTransform(L, 0, 0, L, SPRITE_MX * L, SPRITE_MTOP * L);
      meta = paintBuilding(t, look, L);
      t.setTransform(1, 0, 0, 1, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'saturation';
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = 'rgba(46,48,54,0.32)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.setTransform(L, 0, 0, L, SPRITE_MX * L, SPRITE_MTOP * L);
      paintBoards(ctx, look, meta, L);
    } else {
      meta = paintBuilding(ctx, look, L);
    }
    const key = look.id + ':' + variant;
    const old = cache.get(key);
    if (old) pixels -= old.canvas.width * old.canvas.height;
    const e: Entry = { key, sig: sigOf(look, variant), L, canvas, meta, used: frame };
    cache.set(key, e);
    pixels += canvas.width * canvas.height;
    if (variant === 'a') info.meta = meta;
    evict();
    return e;
  }

  function evict(): void {
    // keep the cache within a count and ~48M pixels (~190 MB) budget; least recently drawn first
    if (cache.size <= SPRITE_CACHE_MAX && pixels <= 48e6) return;
    const arr = [...cache.values()].sort((a, b) => a.used - b.used);
    let k = 0;
    while ((cache.size > SPRITE_CACHE_MAX || pixels > 36e6) && k < arr.length) {
      const e = arr[k++];
      if (e.used === frame) break;
      cache.delete(e.key);
      pixels -= e.canvas.width * e.canvas.height;
    }
  }

  /** Current sprite for a building variant; queues a rebuild when stale. */
  function sprite(info: BInfo, variant: Variant, L: number): Entry | null {
    const key = info.look.id + ':' + variant;
    const e = cache.get(key);
    const sig = variant === info.variant ? info.sig : sigOf(info.look, variant);
    if (e && e.sig === sig && e.L === L) {
      e.used = frame;
      return e;
    }
    const qk = key + '@' + L;
    if (!queued.has(qk)) {
      queued.add(qk);
      queue.push({ info, variant, L, key: qk });
    }
    if (e && e.sig === sig) {
      e.used = frame;
      return e; // other level of detail: fine as a stand-in
    }
    return null;
  }

  function blit(ctx: CanvasRenderingContext2D, e: Entry, look: Look, x: number, y: number, k: number, ox: number, oy: number): void {
    const dx = ox + (x - SPRITE_MX) * k;
    const dy = oy + (y - SPRITE_MTOP) * k;
    const dw = (look.w + 2 * SPRITE_MX) * k;
    const dh = (look.h + SPRITE_MTOP + SPRITE_MBOT) * k;
    ctx.drawImage(e.canvas, dx, dy, dw, dh);
  }

  function draw(ctx: CanvasRenderingContext2D, L: number, k: number, ox: number, oy: number, vw: number, vh: number): void {
    frame++;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (const info of infos) {
      const b = info.b;
      const x0 = ox + (b.x - SPRITE_MX) * k;
      const y0 = oy + (b.y - SPRITE_MTOP) * k;
      const x1 = ox + (b.x + b.w + SPRITE_MX) * k;
      const y1 = oy + (b.y + b.h + SPRITE_MBOT) * k;
      if (x1 < 0 || y1 < 0 || x0 > vw || y0 > vh) continue;
      if (info.variant === 'c') {
        // the finished building fades in as work proceeds, under scaffolding
        const act = sprite(info, 'a', L);
        const p = info.progress >= 0 ? info.progress : 0;
        if (act) {
          ctx.globalAlpha = 0.12 + 0.7 * p;
          blit(ctx, act, info.look, b.x, b.y, k, ox, oy);
          ctx.globalAlpha = 1;
        }
        const sc = sprite(info, 'c', L);
        if (sc) {
          ctx.globalAlpha = 0.95 - 0.35 * p;
          blit(ctx, sc, info.look, b.x, b.y, k, ox, oy);
          ctx.globalAlpha = 1;
        }
      } else {
        const e = sprite(info, info.variant, L);
        if (e) blit(ctx, e, info.look, b.x, b.y, k, ox, oy);
        if (info.expanding) {
          const sc = sprite(info, 'c', L);
          if (sc) {
            ctx.globalAlpha = 0.55;
            blit(ctx, sc, info.look, b.x + b.w * 0.35, b.y, k, ox, oy);
            ctx.globalAlpha = 1;
          }
        }
      }
    }
  }

  function work(budgetMs = SPRITE_BUDGET_MS): number {
    const t0 = performance.now();
    let n = 0;
    // most recently requested first (what is on screen now)
    while (queue.length) {
      const q = queue.pop()!;
      queued.delete(q.key);
      const e = cache.get(q.info.look.id + ':' + q.variant);
      const sig = q.variant === q.info.variant ? q.info.sig : sigOf(q.info.look, q.variant);
      if (e && e.sig === sig && e.L === q.L) continue;
      if (!byId.has(q.info.look.id)) continue;
      build(q.info, q.variant, q.L);
      n++;
      if (performance.now() - t0 >= budgetMs) break;
    }
    return n;
  }

  function ghost(ctx: CanvasRenderingContext2D, look: Look, L: number, k: number, ox: number, oy: number, x: number, y: number, alpha: number): void {
    const [cw, ch] = spriteSize(look, L);
    const canvas = newCanvas(cw, ch);
    const c = canvas.getContext('2d')!;
    c.setTransform(L, 0, 0, L, SPRITE_MX * L, SPRITE_MTOP * L);
    paintBuilding(c, look, L);
    ctx.globalAlpha = alpha;
    ctx.drawImage(canvas, ox + (x - SPRITE_MX) * k, oy + (y - SPRITE_MTOP) * k, (look.w + 2 * SPRITE_MX) * k, (look.h + SPRITE_MTOP + SPRITE_MBOT) * k);
    ctx.globalAlpha = 1;
  }

  return {
    sync,
    list: () => infos,
    info: (id) => byId.get(id),
    draw,
    work,
    ghost,
    reset() {
      cache.clear();
      queue.length = 0;
      queued.clear();
      infos = [];
      byId.clear();
      pixels = 0;
      ver = -1;
      day = -1;
      S = null;
    },
  };
}
