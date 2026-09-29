// ============================================================================
// Life on the map: walkers, wagons, delivery carts, smoke and night lights.
//
// Walkers — every household is a dot. Workers walk home → work in the morning
// and back in the evening along world/paths.commutePath; the jobless (about
// two in three) stroll to the market square late in the morning and idle
// there; the homeless loiter around the square all day. Dots are coloured by
// the sector of the workplace (gold for Treasury workers, grey for the
// jobless), drawn in one batch per colour, with per-person timetables and a
// small sideways offset so a stream of commuters reads as a crowd. Paths are
// cached per person and recomputed (time-budgeted) when home, job or roads
// change.
//
// Wagons — each shipment in s.shipments rides routeBetweenTowns(from, to) at
// progress (day + dayFrac − depart) / (arrive − depart), as a convoy of up to
// CONVOY_MAX carts carrying the good's colour, keeping to the right of the
// road; Treasury shipments fly a gold pennant and ride in a soft gold glow.
// Delivery carts (purely visual) run from producers to their market hall once
// or twice a day.
//
// Smoke — a pooled particle system; each chimney/stack/vent in a building's
// SpriteMeta emits at a rate proportional to today's output relative to the
// firm's usual output (firm.producedToday / firm.output); house chimneys smoke
// in the cold months. Night — lit windows (households at home), furnace
// glows (while producing) and lamps, added after the night tint.
// ============================================================================
import { seasonOf } from '../../sim/calendar';
import { GOODS, SECTORS } from '../../sim/goods';
import { rt } from '../../sim/runtime';
import { STATE, type SimState } from '../../sim/types';
import { commutePath, deliveryPath, routeBetweenTowns } from '../../sim/world/paths';
import type { BInfo } from './buildings';
import {
  CONVOY_MAX,
  DELIVERY_MIN_PATH,
  DOT_MAX_PX,
  DOT_MIN_PX,
  DOT_R,
  PATH_BUDGET_MS,
  HOMELESS_COLOR,
  SECTOR_DOT,
  SMOKE_MAX,
  SMOKE_RATE,
  TREASURY_COLOR,
  TREASURY_GLOW_ALPHA,
  TREASURY_GLOW_MIN_PX,
  TREASURY_GLOW_R,
  UNEMPLOYED_COLOR,
} from './constants';
import { commuteTrip, EMPTY_POLY, hash01, Leg, polyFromTiles, samplePoly, shipmentProgress, strollTrip, tripAt, type Poly, type PolySample, type Trip } from './schedule';

/** Frame parameters shared by the drawing functions. */
export interface View {
  /** Device px per tile. */
  k: number;
  /** Device px of world (0, 0). */
  ox: number;
  oy: number;
  /** Canvas size in device px. */
  vw: number;
  vh: number;
  dpr: number;
  /** CSS px per tile. */
  scale: number;
}

interface Walker {
  home: number;
  job: number;
  gen: number;
  mode: 0 | 1 | 2; // 0 commute, 1 stroll, 2 idle (homeless / no path)
  poly: Poly;
  trip: Trip;
  color: number; // bucket index
}

export interface LifeLayer {
  sync(s: SimState): void;
  /** Advance particles (real seconds) and emit from producing buildings in view. */
  update(dt: number, s: SimState, infos: readonly BInfo[], v: View, time: number, speed: number): void;
  drawWalkers(ctx: CanvasRenderingContext2D, s: SimState, v: View, dayFrac: number, alpha: number): void;
  drawCarts(ctx: CanvasRenderingContext2D, s: SimState, v: View, dayFrac: number, showDeliveries: boolean): void;
  drawSmoke(ctx: CanvasRenderingContext2D, v: View): void;
  drawLights(ctx: CanvasRenderingContext2D, s: SimState, infos: readonly BInfo[], v: View, night: number, time: number): void;
  /** Foreign ships riding at anchor off the port (more when port trade is brisk). */
  drawShips(ctx: CanvasRenderingContext2D, s: SimState, infos: readonly BInfo[], v: View, time: number): void;
  /** Person dot nearest to a device-px point within `r`, or -1. */
  hitPerson(x: number, y: number, r: number): number;
  /** Shipment (id) nearest to a device-px point within `r`, or -1. */
  hitWagon(x: number, y: number, r: number): number;
  /** World position of a person drawn this frame (or null). */
  personAt(id: number): { x: number; y: number } | null;
  /** The polyline a person walks today (commute or stroll), or null. */
  personPath(s: SimState, id: number): Poly | null;
  reset(): void;
  stats(): { walkers: number; carts: number; particles: number; pending: number };
}

// bucket colours: one per sector, then unemployed / homeless
const SECTOR_KEYS = Object.keys(SECTORS);
const BUCKET_COLORS: string[] = SECTOR_KEYS.map((k) => (k === 'stateworks' ? TREASURY_COLOR : SECTOR_DOT[k] ?? liftColor(SECTORS[k as keyof typeof SECTORS].color)));
const B_UNEMP = BUCKET_COLORS.length;
BUCKET_COLORS.push(UNEMPLOYED_COLOR);
const B_HOMELESS = BUCKET_COLORS.length;
BUCKET_COLORS.push(HOMELESS_COLOR);
const SECTOR_BUCKET: Record<string, number> = Object.fromEntries(SECTOR_KEYS.map((k, i) => [k, i]));

/** Lighten dark sector colours so dots stay visible on the map. */
function liftColor(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum < 120) {
    const t = (120 - lum) / 160;
    r = Math.round(r + (235 - r) * t);
    g = Math.round(g + (225 - g) * t);
    b = Math.round(b + (210 - b) * t);
  }
  return `rgb(${r},${g},${b})`;
}

function puff(color: [number, number, number], soft: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},1)`);
  grd.addColorStop(soft, `rgba(${color[0]},${color[1]},${color[2]},0.55)`);
  grd.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
  g.fillStyle = grd;
  g.fillRect(0, 0, 32, 32);
  return c;
}

export function createLifeLayer(): LifeLayer {
  let walkers: (Walker | undefined)[] = [];
  let gen = 0;
  let roadVer = -1;
  let S: SimState | null = null;
  const routes = new Map<string, Poly>();
  const deliveries = new Map<number, Poly>(); // building id → path
  let pendingPaths = 0;
  // per-frame hit records
  let hitN = 0;
  let hitX = new Float32Array(2048);
  let hitY = new Float32Array(2048);
  let hitId = new Int32Array(2048);
  let hitWX = new Float32Array(2048); // world position of each drawn walker
  let hitWY = new Float32Array(2048);
  let wagN = 0;
  const wagX = new Float32Array(1024);
  const wagY = new Float32Array(1024);
  const wagId = new Int32Array(1024);
  let cartsDrawn = 0;
  // buckets
  const NB = BUCKET_COLORS.length;
  let bx: Float32Array[] = Array.from({ length: NB }, () => new Float32Array(512));
  let bn = new Int32Array(NB);
  const smp: PolySample = { x: 0, y: 0, dx: 1, dy: 0 };
  const leg = { leg: Leg.AtA as Leg, f: 0 };
  // particles
  const P = {
    x: new Float32Array(SMOKE_MAX),
    y: new Float32Array(SMOKE_MAX),
    vx: new Float32Array(SMOKE_MAX),
    vy: new Float32Array(SMOKE_MAX),
    age: new Float32Array(SMOKE_MAX),
    life: new Float32Array(SMOKE_MAX),
    size: new Float32Array(SMOKE_MAX),
    kind: new Uint8Array(SMOKE_MAX),
    alive: new Uint8Array(SMOKE_MAX),
  };
  let pCount = 0;
  let pNext = 0;
  const emitAcc = new Map<number, number>();
  let puffs: HTMLCanvasElement[] | null = null;
  let glowSprite: HTMLCanvasElement | null = null;
  let goldGlow: HTMLCanvasElement | null = null;

  function ensureSprites(): void {
    if (puffs) return;
    puffs = [puff([96, 92, 90], 0.5), puff([206, 204, 198], 0.5), puff([244, 246, 248], 0.42)];
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,214,140,0.9)');
    grd.addColorStop(0.25, 'rgba(255,170,90,0.45)');
    grd.addColorStop(1, 'rgba(255,140,60,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    glowSprite = c;
    // soft gold halo under the Treasury's wagons
    const c2 = document.createElement('canvas');
    c2.width = c2.height = 64;
    const g2 = c2.getContext('2d')!;
    const grd2 = g2.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd2.addColorStop(0, 'rgba(255,218,120,0.9)');
    grd2.addColorStop(0.42, 'rgba(244,194,84,0.5)');
    grd2.addColorStop(1, 'rgba(232,170,60,0)');
    g2.fillStyle = grd2;
    g2.fillRect(0, 0, 64, 64);
    goldGlow = c2;
  }

  /** The Treasury's soft gold glow centred on a device-px point. */
  function treasuryGlow(ctx: CanvasRenderingContext2D, v: View, dx: number, dy: number): void {
    ensureSprites();
    const r = Math.max(TREASURY_GLOW_MIN_PX * v.dpr, TREASURY_GLOW_R * v.k);
    ctx.globalAlpha = TREASURY_GLOW_ALPHA;
    ctx.drawImage(goldGlow!, dx - r, dy - r, 2 * r, 2 * r);
    ctx.globalAlpha = 1;
  }

  function sync(s: SimState): void {
    const r = rt(s);
    if (s !== S) {
      S = s;
      walkers = [];
      routes.clear();
      deliveries.clear();
      roadVer = r.roadVersion;
      gen++;
      return;
    }
    if (r.roadVersion !== roadVer) {
      roadVer = r.roadVersion;
      routes.clear();
      deliveries.clear();
      gen++; // every walker's path is stale
    }
  }

  function routePoly(s: SimState, a: number, b: number): Poly {
    const key = a + '>' + b;
    let p = routes.get(key);
    if (!p) {
      let tiles: number[] = [];
      try {
        tiles = routeBetweenTowns(s, a, b).tiles;
      } catch {
        tiles = [];
      }
      p = polyFromTiles(tiles, s.map.w);
      routes.set(key, p);
    }
    return p;
  }

  function deliveryPoly(s: SimState, bid: number): Poly {
    let p = deliveries.get(bid);
    if (!p) {
      let tiles: number[] = [];
      try {
        tiles = deliveryPath(s, bid);
      } catch {
        tiles = [];
      }
      p = polyFromTiles(tiles, s.map.w);
      deliveries.set(bid, p);
    }
    return p;
  }

  function bucketOf(s: SimState, job: number, home: number): number {
    if (job < 0) return home < 0 ? B_HOMELESS : B_UNEMP;
    const f = s.firms[job];
    if (!f) return B_UNEMP;
    return SECTOR_BUCKET[f.sector] ?? B_UNEMP;
  }

  /** (Re)compute a walker's path and timetable. */
  function prepare(s: SimState, id: number, home: number, job: number): Walker {
    let w = walkers[id];
    if (!w) {
      w = { home, job, gen, mode: 2, poly: EMPTY_POLY, trip: { d0: 0, a0: 0, d1: 0, a1: 0 }, color: B_UNEMP };
      walkers[id] = w;
    }
    w.home = home;
    w.job = job;
    w.gen = gen;
    w.color = bucketOf(s, job, home);
    w.poly = EMPTY_POLY;
    w.mode = 2;
    try {
      if (job >= 0) {
        const tiles = commutePath(s, id);
        if (tiles.length >= 2) {
          w.poly = polyFromTiles(tiles, s.map.w);
          w.mode = 0;
          commuteTrip(id, w.poly.len, w.trip);
        }
      } else if (home >= 0) {
        const t = strollTrip(id, 0, w.trip);
        if (t) {
          const b = s.buildings[home];
          const town = b ? s.towns[b.town] : undefined;
          if (town && b) {
            const tiles = deliveryPath(s, home);
            if (tiles.length >= 2) {
              w.poly = polyFromTiles(tiles, s.map.w);
              strollTrip(id, w.poly.len, w.trip);
              w.mode = 1;
            }
          }
        }
      }
    } catch {
      w.mode = 2;
    }
    return w;
  }

  function pushDot(b: number, x: number, y: number): void {
    let arr = bx[b];
    const n = bn[b];
    if (2 * n + 2 > arr.length) {
      const bigger = new Float32Array(arr.length * 2);
      bigger.set(arr);
      bx[b] = arr = bigger;
    }
    arr[2 * n] = x;
    arr[2 * n + 1] = y;
    bn[b] = n + 1;
  }

  function recordHit(id: number, x: number, y: number, wx: number, wy: number): void {
    if (hitN >= hitX.length) {
      const a = new Float32Array(hitWX.length * 2);
      a.set(hitWX);
      hitWX = a;
      const b = new Float32Array(hitWY.length * 2);
      b.set(hitWY);
      hitWY = b;
      const nx = new Float32Array(hitX.length * 2);
      nx.set(hitX);
      hitX = nx;
      const ny = new Float32Array(hitY.length * 2);
      ny.set(hitY);
      hitY = ny;
      const ni = new Int32Array(hitId.length * 2);
      ni.set(hitId);
      hitId = ni;
    }
    hitX[hitN] = x;
    hitY[hitN] = y;
    hitId[hitN] = id;
    hitWX[hitN] = wx;
    hitWY[hitN] = wy;
    hitN++;
  }

  function drawWalkers(ctx: CanvasRenderingContext2D, s: SimState, v: View, dayFrac: number, alpha: number): void {
    hitN = 0;
    bn.fill(0);
    if (alpha <= 0) return;
    const t0 = performance.now();
    pendingPaths = 0;
    const people = s.people;
    const k = v.k;
    const margin = 2 * k;
    for (let id = 0; id < people.length; id++) {
      const p = people[id];
      if (!p || !p.alive) continue;
      let w = walkers[id];
      if (!w || w.gen !== gen || w.home !== p.home || w.job !== p.job) {
        if (performance.now() - t0 > PATH_BUDGET_MS) {
          pendingPaths++;
          continue;
        }
        w = prepare(s, id, p.home, p.job);
      }
      let wxp: number;
      let wyp: number;
      if (w.mode === 2) {
        // idle around the market square (homeless all day; others only if no path)
        if (p.home >= 0) continue;
        const town = s.towns[p.town];
        if (!town) continue;
        if (p.job >= 0) {
          // homeless worker: at work in working hours
          if (dayFrac > 0.34 && dayFrac < 0.72) continue;
        }
        const a = hash01(id, 91) * Math.PI * 2 + Math.sin(dayFrac * 6.28 * 3 + id) * 0.05;
        const rad = 1.55 + 0.45 * hash01(id, 92);
        wxp = town.x + Math.cos(a) * rad;
        wyp = town.y + Math.sin(a) * rad * 0.9;
      } else {
        tripAt(w.trip, dayFrac, leg);
        if (leg.leg === Leg.AtA) continue;
        if (leg.leg === Leg.AtB) {
          if (w.mode !== 1) continue; // at work: indoors
          // idle on the square
          const town = s.towns[p.town];
          if (!town) continue;
          const a = hash01(id, 93) * Math.PI * 2 + Math.sin(dayFrac * 40 + id) * 0.04;
          const rad = 1.45 + 0.5 * hash01(id, 94);
          wxp = town.x + Math.cos(a) * rad;
          wyp = town.y + Math.sin(a) * rad * 0.9;
        } else {
          samplePoly(w.poly, leg.f * w.poly.len, smp);
          // keep to one side of the track (by person), so crowds spread out
          const off = (hash01(id, 97) - 0.5) * 0.3;
          wxp = smp.x - smp.dy * off;
          wyp = smp.y + smp.dx * off;
        }
      }
      const dx = v.ox + wxp * k;
      const dy = v.oy + wyp * k;
      if (dx < -margin || dy < -margin || dx > v.vw + margin || dy > v.vh + margin) continue;
      pushDot(w.color, dx, dy);
      recordHit(id, dx, dy, wxp, wyp);
    }
    // draw: dark halo pass, then colours
    const r = Math.max(DOT_MIN_PX, Math.min(DOT_MAX_PX, DOT_R * v.scale)) * v.dpr;
    const round = r >= 1.7;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(16,14,12,0.6)';
    ctx.beginPath();
    const ro = r + 0.8 * v.dpr;
    for (let b = 0; b < NB; b++) {
      const arr = bx[b];
      for (let i = 0; i < bn[b]; i++) {
        const x = arr[2 * i];
        const y = arr[2 * i + 1] + 0.35 * v.dpr;
        if (round) {
          ctx.moveTo(x + ro, y);
          ctx.arc(x, y, ro, 0, Math.PI * 2);
        } else ctx.rect(x - ro, y - ro, ro * 2, ro * 2);
      }
    }
    ctx.fill();
    for (let b = 0; b < NB; b++) {
      if (!bn[b]) continue;
      const arr = bx[b];
      ctx.fillStyle = BUCKET_COLORS[b];
      ctx.beginPath();
      for (let i = 0; i < bn[b]; i++) {
        const x = arr[2 * i];
        const y = arr[2 * i + 1];
        if (round) {
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        } else ctx.rect(x - r, y - r, r * 2, r * 2);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** One cart in tile units at (x, y) heading (dx, dy). */
  function cart(ctx: CanvasRenderingContext2D, v: View, x: number, y: number, dx: number, dy: number, cargo: string | null, treasury: boolean, small: boolean, bob: number): void {
    const k = v.k;
    const sx = v.ox + x * k;
    const sy = v.oy + y * k;
    const sc = k * (small ? 0.72 : 1);
    ctx.setTransform(sc * dx, sc * dy, -sc * dy, sc * dx, sx, sy);
    // shadow
    ctx.fillStyle = 'rgba(12,14,10,0.35)';
    ctx.fillRect(-0.2 + 0.03, -0.1 + 0.06, 0.62, 0.22);
    // draught animal ahead (not for handcarts)
    if (!small) {
      ctx.fillStyle = '#6a4a32';
      ctx.fillRect(0.2, -0.055 + bob, 0.2, 0.11);
      ctx.fillStyle = '#5a3e2a';
      ctx.fillRect(0.38, -0.04 + bob, 0.08, 0.08);
      ctx.fillStyle = '#3c2a1c';
      ctx.fillRect(0.16, -0.02, 0.06, 0.04);
    }
    // wheels
    ctx.fillStyle = '#2a211a';
    ctx.fillRect(-0.14, -0.13, 0.12, 0.04);
    ctx.fillRect(-0.14, 0.09, 0.12, 0.04);
    // bed
    ctx.fillStyle = '#8a643e';
    ctx.fillRect(-0.22, -0.1, 0.38, 0.2);
    if (cargo) {
      ctx.fillStyle = cargo;
      ctx.fillRect(-0.19, -0.075, 0.32, 0.15);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(-0.19, -0.075, 0.32, 0.04);
    }
    if (treasury) {
      ctx.fillStyle = '#3b3228';
      ctx.fillRect(-0.21, -0.14, 0.025, 0.1);
      ctx.fillStyle = '#e8bd55';
      ctx.fillRect(-0.3, -0.2, 0.12, 0.07);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function drawCarts(ctx: CanvasRenderingContext2D, s: SimState, v: View, dayFrac: number, showDeliveries: boolean): void {
    wagN = 0;
    cartsDrawn = 0;
    const k = v.k;
    const detailed = v.scale >= 11;
    const margin = 2 * k;
    const dots: number[] = [];
    // ---- wagons on the roads between towns ----
    for (const sh of s.shipments) {
      if (!sh || sh.from === sh.to) continue;
      const poly = routePoly(s, sh.from, sh.to);
      if (poly.len <= 0) continue;
      const prog = shipmentProgress(s.day, dayFrac, sh.depart, sh.arrive);
      // not yet on the road, or already in town (unloaded at the next dawn): not drawn
      if (prog <= 0.002 || prog >= 0.998) continue;
      const n = Math.max(1, Math.min(CONVOY_MAX, Math.round(sh.wagons) || 1));
      const cargo = GOODS[sh.good]?.color ?? '#999';
      const treasury = sh.owner === STATE;
      for (let j = 0; j < n; j++) {
        const d = prog * poly.len - j * 0.75;
        if (d < 0.6 || d > poly.len - 0.6) continue; // inside the town square
        samplePoly(poly, Math.max(0, d), smp);
        const off = 0.17; // keep right
        const x = smp.x - smp.dy * off;
        const y = smp.y + smp.dx * off;
        const dx = v.ox + x * k;
        const dy = v.oy + y * k;
        if (dx < -margin || dy < -margin || dx > v.vw + margin || dy > v.vh + margin) continue;
        if (detailed) {
          if (treasury) treasuryGlow(ctx, v, dx, dy);
          cart(ctx, v, x, y, smp.dx, smp.dy, cargo, treasury && j === 0, false, Math.sin((s.day + dayFrac) * 60 + sh.id) * 0.01);
        } else dots.push(dx, dy, sh.good, treasury ? 1 : 0);
        if (j === 0 && wagN < wagX.length) {
          wagX[wagN] = dx;
          wagY[wagN] = dy;
          wagId[wagN] = sh.id;
          wagN++;
        }
        cartsDrawn++;
      }
    }
    // ---- delivery handcarts from producers to their market hall ----
    if (showDeliveries && detailed) {
      for (const f of s.firms) {
        if (!f || !f.alive || f.building < 0) continue;
        const def = SECTORS[f.sector];
        if (!def || def.out < 0) continue;
        if (!(f.producedToday > 0) && !(f.output > 0)) continue;
        const poly = deliveryPoly(s, f.building);
        if (poly.cum.length < DELIVERY_MIN_PATH) continue;
        const trips = f.output > 25 ? 2 : 1;
        for (let tr = 0; tr < trips; tr++) {
          const walk = Math.min(0.1, 0.03 + 0.004 * poly.len);
          const d0 = 0.38 + 0.16 * hash01(f.id, 51 + tr) + tr * 0.2;
          const a0 = d0 + walk;
          const d1 = a0 + 0.015;
          const a1 = d1 + walk;
          let f01: number;
          let loaded: boolean;
          if (dayFrac < d0 || dayFrac > a1) continue;
          if (dayFrac < a0) {
            f01 = (dayFrac - d0) / walk;
            loaded = true;
          } else if (dayFrac < d1) continue;
          else {
            f01 = 1 - (dayFrac - d1) / walk;
            loaded = false;
          }
          samplePoly(poly, f01 * poly.len, smp);
          const dir = loaded ? 1 : -1;
          const x = smp.x - smp.dy * 0.14 * dir;
          const y = smp.y + smp.dx * 0.14 * dir;
          const sx = v.ox + x * k;
          const sy = v.oy + y * k;
          if (sx < -margin || sy < -margin || sx > v.vw + margin || sy > v.vh + margin) continue;
          cart(ctx, v, x, y, smp.dx * dir, smp.dy * dir, loaded ? GOODS[def.out]?.color ?? null : null, false, true, 0);
          cartsDrawn++;
        }
      }
    }
    if (dots.length) {
      for (let i = 0; i < dots.length; i += 4) if (dots[i + 3]) treasuryGlow(ctx, v, dots[i], dots[i + 1]);
      const r = Math.max(1.6, 0.2 * v.scale) * v.dpr;
      ctx.fillStyle = 'rgba(16,14,12,0.7)';
      ctx.beginPath();
      for (let i = 0; i < dots.length; i += 4) ctx.rect(dots[i] - r - v.dpr, dots[i + 1] - r - v.dpr, 2 * r + 2 * v.dpr, 2 * r + 2 * v.dpr);
      ctx.fill();
      for (let i = 0; i < dots.length; i += 4) {
        ctx.fillStyle = dots[i + 3] ? '#e8bd55' : GOODS[dots[i + 2]]?.color ?? '#999';
        ctx.fillRect(dots[i] - r, dots[i + 1] - r, 2 * r, 2 * r);
      }
    }
  }

  function emit(x: number, y: number, kind: number, size: number): void {
    // reuse the next slot (oldest particles are overwritten when the pool is full)
    const i = pNext;
    pNext = (pNext + 1) % SMOKE_MAX;
    if (!P.alive[i]) pCount++;
    P.alive[i] = 1;
    P.x[i] = x + (Math.random() - 0.5) * 0.05;
    P.y[i] = y;
    P.vx[i] = (Math.random() - 0.5) * 0.05;
    P.vy[i] = -(0.32 + Math.random() * 0.18);
    P.age[i] = 0;
    P.life[i] = kind === 2 ? 1.8 + Math.random() : 3 + Math.random() * 1.8;
    P.size[i] = size * (0.8 + Math.random() * 0.4);
    P.kind[i] = kind;
  }

  function update(dt: number, s: SimState, infos: readonly BInfo[], v: View, time: number, speed: number): void {
    const d = Math.min(0.1, Math.max(0, dt));
    // advance
    const windX = 0.16 + 0.1 * Math.sin(time * 0.07);
    const windY = -0.02;
    if (pCount > 0) {
      for (let i = 0; i < SMOKE_MAX; i++) {
        if (!P.alive[i]) continue;
        const a = (P.age[i] += d);
        if (a >= P.life[i]) {
          P.alive[i] = 0;
          pCount--;
          continue;
        }
        const f = a / P.life[i];
        P.x[i] += (P.vx[i] + windX * f * 1.4) * d;
        P.y[i] += (P.vy[i] * (1 - 0.55 * f) + windY) * d;
      }
    }
    if (d <= 0) return;
    // emit from buildings in view
    const k = v.k;
    const cold = seasonOf(s.day);
    const houseRate = cold === 3 ? 0.35 : cold === 2 ? 0.1 : cold === 0 ? 0.06 : 0;
    const x0 = -v.ox / k - 2;
    const y0 = -v.oy / k - 3;
    const x1 = (v.vw - v.ox) / k + 2;
    const y1 = (v.vh - v.oy) / k + 3;
    const fewer = v.scale < 9 ? 0.4 : 1;
    for (const info of infos) {
      const meta = info.meta;
      if (!meta || !meta.smoke.length) continue;
      const b = info.b;
      if (b.x > x1 || b.x + b.w < x0 || b.y > y1 || b.y + b.h < y0) continue;
      if (b.status !== 'active') continue;
      let rate = 0;
      if (b.kind === 'house') {
        if (!b.residents || b.residents.length === 0) continue;
        rate = houseRate;
      } else if (b.kind === 'firm') {
        const f = b.firm >= 0 ? s.firms[b.firm] : undefined;
        if (!f || !f.alive || f.status !== 'active' || f.workers.length === 0) continue;
        const usual = f.output > 1e-6 ? f.output : f.producedToday;
        const ratio = usual > 1e-9 ? f.producedToday / usual : 0;
        rate = SMOKE_RATE * Math.max(0, Math.min(1.6, Number.isFinite(ratio) ? ratio : 0));
      }
      if (rate <= 0) continue;
      for (let e = 0; e + 2 < meta.smoke.length; e += 3) {
        const key = b.id * 16 + e / 3;
        let acc = (emitAcc.get(key) ?? Math.random()) + rate * fewer * d;
        while (acc >= 1) {
          acc -= 1;
          const kind = meta.smoke[e + 2];
          emit(b.x + meta.smoke[e], b.y + meta.smoke[e + 1], kind, b.kind === 'house' ? 0.16 : kind === 0 ? 0.3 : 0.24);
        }
        emitAcc.set(key, acc);
      }
    }
  }

  function drawSmoke(ctx: CanvasRenderingContext2D, v: View): void {
    if (pCount <= 0) return;
    ensureSprites();
    const k = v.k;
    for (let i = 0; i < SMOKE_MAX; i++) {
      if (!P.alive[i]) continue;
      const f = P.age[i] / P.life[i];
      const size = P.size[i] * (0.7 + 2.3 * f) * k;
      const x = v.ox + P.x[i] * k;
      const y = v.oy + P.y[i] * k;
      if (x < -size || y < -size || x > v.vw + size || y > v.vh + size) continue;
      const kind = P.kind[i];
      const a = (kind === 0 ? 0.62 : kind === 1 ? 0.55 : 0.6) * (f < 0.1 ? f / 0.1 : 1 - (f - 0.1) / 0.9);
      if (a <= 0.01) continue;
      ctx.globalAlpha = a;
      ctx.drawImage(puffs![kind] ?? puffs![1], x - size / 2, y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  function drawLights(ctx: CanvasRenderingContext2D, s: SimState, infos: readonly BInfo[], v: View, night: number, time: number): void {
    ensureSprites();
    const k = v.k;
    const glow = glowSprite!;
    const late = night > 0.5 ? 1 : 0;
    ctx.save();
    for (const info of infos) {
      const meta = info.meta;
      if (!meta) continue;
      const b = info.b;
      const sx0 = v.ox + (b.x - 1) * k;
      const sy0 = v.oy + (b.y - 2) * k;
      if (sx0 > v.vw || sy0 > v.vh || v.ox + (b.x + b.w + 1) * k < 0 || v.oy + (b.y + b.h + 1) * k < 0) continue;
      if (b.status !== 'active') continue;
      const f = b.kind === 'firm' && b.firm >= 0 ? s.firms[b.firm] : undefined;
      const producing = !!f && f.alive && f.producedToday > 0 && f.workers.length > 0;
      // furnace / oven glow (day and night, flickering)
      if (producing && meta.glow.length) {
        ctx.globalCompositeOperation = 'lighter';
        for (let g = 0; g + 2 < meta.glow.length; g += 3) {
          const fl = 0.75 + 0.25 * Math.sin(time * 9 + b.id * 1.7 + g) * Math.sin(time * 5.3 + g);
          const r = meta.glow[g + 2] * k * (1.4 + 1.2 * night);
          ctx.globalAlpha = (0.25 + 0.6 * night) * fl;
          ctx.drawImage(glow, v.ox + (b.x + meta.glow[g]) * k - r, v.oy + (b.y + meta.glow[g + 1]) * k - r, 2 * r, 2 * r);
        }
        ctx.globalCompositeOperation = 'source-over';
      }
      if (night <= 0.02) continue;
      // windows
      let litShare = 0;
      if (b.kind === 'house') litShare = b.slots > 0 ? Math.min(1, (b.residents?.length ?? 0) / b.slots) * (late ? 0.55 : 0.95) : 0;
      else if (b.kind === 'palace' || b.kind === 'bank') litShare = 0.8;
      else if (f && f.alive && f.workers.length > 0) litShare = late ? 0.15 : 0.45;
      const w = meta.windows;
      if (litShare > 0 && w.length) {
        for (let q = 0; q + 3 < w.length; q += 4) {
          if (hash01(b.id * 31 + q, 7) >= litShare) continue;
          const x = v.ox + (b.x + w[q]) * k;
          const y = v.oy + (b.y + w[q + 1]) * k;
          ctx.globalAlpha = night * 0.95;
          ctx.fillStyle = '#ffd98a';
          ctx.fillRect(x, y, Math.max(1, w[q + 2] * k), Math.max(1, w[q + 3] * k));
          ctx.globalCompositeOperation = 'lighter';
          const r = Math.max(3 * v.dpr, 0.26 * k);
          ctx.globalAlpha = night * 0.35;
          ctx.drawImage(glow, x + (w[q + 2] * k) / 2 - r, y + (w[q + 3] * k) / 2 - r, 2 * r, 2 * r);
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      // lamps
      const lm = meta.lamps;
      if (lm.length) {
        ctx.globalCompositeOperation = 'lighter';
        for (let q = 0; q + 1 < lm.length; q += 2) {
          const x = v.ox + (b.x + lm[q]) * k;
          const y = v.oy + (b.y + lm[q + 1]) * k;
          const r = Math.max(4 * v.dpr, 0.4 * k);
          ctx.globalAlpha = night * 0.55;
          ctx.drawImage(glow, x - r, y - r, 2 * r, 2 * r);
          ctx.globalAlpha = night;
          ctx.fillStyle = '#fff1c4';
          ctx.fillRect(x - Math.max(1, 0.03 * k), y - Math.max(1, 0.03 * k), Math.max(2, 0.06 * k), Math.max(2, 0.06 * k));
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    ctx.restore();
  }

  function drawShips(ctx: CanvasRenderingContext2D, s: SimState, infos: readonly BInfo[], v: View, time: number): void {
    const fo = s.foreign;
    if (!fo) return;
    let cap = 0;
    for (const c of fo.shipCap ?? []) cap += c > 0 ? c : 0;
    if (!(cap > 0)) return; // no trade with the outside world
    const trade = Math.max(fo.tradeEma || 0, ((fo.importValue || 0) + (fo.exportValue || 0)) / 2);
    const n = Math.max(1, Math.min(3, 1 + Math.floor(trade / 120)));
    const m = s.map;
    const k = v.k;
    const WDX = [1, -1, 0, 0];
    const WDY = [0, 0, 1, -1];
    for (const info of infos) {
      const b = info.b;
      if (b.kind !== 'port' || info.look.onWater || b.status !== 'active') continue;
      const d = info.look.waterDir >= 0 ? info.look.waterDir : 2;
      const dx = WDX[d];
      const dy = WDY[d];
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      for (let j = 0; j < n; j++) {
        const along = 2.2 + 1.3 * (j % 2) + 0.4 * j;
        const side = (j - (n - 1) / 2) * 1.6;
        const x = cx + dx * along - dy * side;
        const y = cy + dy * along + dx * side;
        const tx = Math.floor(x);
        const ty = Math.floor(y);
        if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) continue;
        const t = m.terrain[ty * m.w + tx];
        if (t !== 0 && t !== 1) continue; // must ride on water
        const bob = Math.sin(time * 1.3 + j * 2.1) * 0.035;
        const sx = v.ox + x * k;
        const sy = v.oy + (y + bob) * k;
        if (sx < -2 * k || sy < -2 * k || sx > v.vw + 2 * k || sy > v.vh + 2 * k) continue;
        const rot = Math.sin(time * 0.9 + j) * 0.035 + (dx !== 0 ? 0 : 0.0);
        const c = Math.cos(rot) * k;
        const sn = Math.sin(rot) * k;
        ctx.setTransform(c, sn, -sn, c, sx, sy);
        // reflection / shadow on the water
        ctx.fillStyle = 'rgba(8,24,40,0.35)';
        ctx.beginPath();
        ctx.ellipse(0.06, 0.12, 0.5, 0.12, 0, 0, Math.PI * 2);
        ctx.fill();
        // hull
        ctx.fillStyle = '#5a3c26';
        ctx.beginPath();
        ctx.moveTo(-0.48, -0.06);
        ctx.lineTo(0.4, -0.06);
        ctx.quadraticCurveTo(0.56, -0.02, 0.44, 0.08);
        ctx.lineTo(-0.42, 0.08);
        ctx.quadraticCurveTo(-0.52, 0.02, -0.48, -0.06);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#8b6440';
        ctx.fillRect(-0.4, -0.06, 0.8, 0.05);
        // masts and sails
        ctx.fillStyle = '#3a2a1c';
        ctx.fillRect(-0.16, -0.62, 0.025, 0.58);
        ctx.fillRect(0.14, -0.54, 0.025, 0.5);
        ctx.fillStyle = '#efe6d2';
        ctx.fillRect(-0.3, -0.56, 0.3, 0.2);
        ctx.fillRect(-0.28, -0.32, 0.26, 0.18);
        ctx.fillRect(0.02, -0.48, 0.26, 0.18);
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ctx.fillRect(-0.15, -0.56, 0.15, 0.2);
        ctx.fillRect(0.15, -0.48, 0.13, 0.18);
        // a foreign pennant
        ctx.fillStyle = '#3aa0a8';
        ctx.beginPath();
        ctx.moveTo(-0.14, -0.62);
        ctx.lineTo(0.02, -0.59);
        ctx.lineTo(-0.14, -0.56);
        ctx.closePath();
        ctx.fill();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
  }

  function nearest(xs: Float32Array, ys: Float32Array, ids: Int32Array, n: number, x: number, y: number, r: number): number {
    let best = -1;
    let bd = r * r;
    for (let i = 0; i < n; i++) {
      const d = (xs[i] - x) ** 2 + (ys[i] - y) ** 2;
      if (d <= bd) {
        bd = d;
        best = ids[i];
      }
    }
    return best;
  }

  return {
    sync,
    update,
    drawWalkers,
    drawCarts,
    drawSmoke,
    drawLights,
    drawShips,
    hitPerson: (x, y, r) => nearest(hitX, hitY, hitId, hitN, x, y, r),
    hitWagon: (x, y, r) => nearest(wagX, wagY, wagId, wagN, x, y, r),
    personAt(id) {
      for (let i = 0; i < hitN; i++) if (hitId[i] === id) return { x: hitWX[i], y: hitWY[i] };
      return null;
    },
    personPath(s, id) {
      const p = s.people[id];
      if (!p || !p.alive) return null;
      let w = walkers[id];
      if (!w || w.gen !== gen || w.home !== p.home || w.job !== p.job) w = prepare(s, id, p.home, p.job);
      return w.mode === 2 ? null : w.poly;
    },
    reset() {
      walkers = [];
      routes.clear();
      deliveries.clear();
      gen++;
      S = null;
      P.alive.fill(0);
      pCount = 0;
      emitAcc.clear();
    },
    stats: () => ({ walkers: hitN, carts: cartsDrawn, particles: pCount, pending: pendingPaths }),
  };
}
