// ============================================================================
// Terrain colour fields and the per-pixel ground painter (pure, DOM-free).
//
// Each tile gets a land colour (terrain base, fertility, elevation tint,
// hill-shading from the elevation gradient, gentle per-tile variation, trodden
// earth around settlements) and a water colour (a depth gradient from a
// distance-to-land transform). `fillGround` then paints any rectangle of the
// map at any resolution by bilinear interpolation between tile centres:
//   * a land/water field L (1 on land tiles, 0 on water) is interpolated and
//     perturbed with value noise near the shore; L = 0.5 is the coastline, so
//     coasts are organic curves at every zoom, not tile edges;
//   * land pixels blend only land tiles' colours, water pixels only water
//     tiles' colours — no muddy shoreline;
//   * a foam band on the water side of the coast, a faint second wave line
//     further out, a darker wet-sand band on the land side;
//   * fine grain at a fixed world frequency (so every level of detail agrees).
// ============================================================================
import { Terrain, type MapData } from '../../sim/types';
import { FOAM, FOREST_FLOOR, GRASS_DRY, GRASS_LUSH, HILLS_HI, HILLS_LO, MARSH, MOUNTAIN, SAND, TOWN_GROUND, waterAt, type RGB } from './palette';

export interface Fields {
  w: number;
  h: number;
  seed: number;
  /** 1 land (river tiles included), 0 open water. */
  land: Float32Array;
  /** Land colour per tile. */
  lr: Float32Array;
  lg: Float32Array;
  lb: Float32Array;
  /** Water colour per tile. */
  wr: Float32Array;
  wg: Float32Array;
  wb: Float32Array;
  /** Distance (tiles) from each water tile to the nearest land (0 on land). */
  depth: Float32Array;
  /** Distance (tiles) from each land tile to open water (0 on water). */
  shore: Float32Array;
  /** 0..1 settlement density (trodden ground). */
  urban: Float32Array;
}

function isWater(t: number): boolean {
  return t === Terrain.Water || t === Terrain.DeepWater;
}

/** Integer lattice hash → [0, 1). */
export function ihash(seed: number, x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + (seed | 0);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1). */
export function vnoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  let fx = x - x0;
  let fy = y - y0;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = ihash(seed, x0, y0);
  const b = ihash(seed, x0 + 1, y0);
  const c = ihash(seed, x0, y0 + 1);
  const d = ihash(seed, x0 + 1, y0 + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Two-pass chamfer distance transform: distance from every `src` tile (8-neighbour, √2 diagonals). */
export function chamfer(w: number, h: number, isSrc: (i: number) => boolean): Float32Array {
  const n = w * h;
  const d = new Float32Array(n);
  const BIG = 1e6;
  for (let i = 0; i < n; i++) d[i] = isSrc(i) ? 0 : BIG;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < n; i++) if (d[i] >= BIG) d[i] = 30;
  return d;
}

/** Build the fields for a map. `urban` (optional, per tile 0..1) tints ground around towns. */
export function buildFields(m: MapData, seed: number, urban?: ArrayLike<number>): Fields {
  const w = m.w;
  const h = m.h;
  const n = w * h;
  const F: Fields = {
    w,
    h,
    seed: seed | 0,
    land: new Float32Array(n),
    lr: new Float32Array(n),
    lg: new Float32Array(n),
    lb: new Float32Array(n),
    wr: new Float32Array(n),
    wg: new Float32Array(n),
    wb: new Float32Array(n),
    depth: new Float32Array(n),
    shore: new Float32Array(n),
    urban: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) F.land[i] = isWater(m.terrain[i]) ? 0 : 1;
  F.depth = chamfer(w, h, (i) => F.land[i] > 0.5);
  F.shore = chamfer(w, h, (i) => F.land[i] < 0.5);
  if (urban) for (let i = 0; i < n; i++) F.urban[i] = Math.max(0, Math.min(1, urban[i] || 0));
  paintWater(F, m);
  paintLand(F, m);
  return F;
}

/** Recompute land colours with a new settlement-density field (after buildings change). */
export function setUrban(F: Fields, m: MapData, urban: ArrayLike<number>): void {
  const n = F.w * F.h;
  for (let i = 0; i < n; i++) F.urban[i] = Math.max(0, Math.min(1, urban[i] || 0));
  paintLand(F, m);
}

function paintWater(F: Fields, m: MapData): void {
  const w = F.w;
  const c = [0, 0, 0];
  for (let i = 0; i < w * F.h; i++) {
    const t = m.terrain[i];
    let d = F.depth[i];
    if (t === Terrain.Water) d = Math.min(d, 2.4);
    else if (t === Terrain.DeepWater) d = Math.max(d, 2.8) + 0.6 * (d > 4 ? 1 : 0);
    else d = 0;
    waterAt(d, c);
    const x = i % w;
    const y = (i - x) / w;
    const v = 0.97 + 0.06 * ihash(F.seed ^ 0x77, x, y);
    F.wr[i] = c[0] * v;
    F.wg[i] = c[1] * v;
    F.wb[i] = c[2] * v;
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function paintLand(F: Fields, m: MapData): void {
  const w = F.w;
  const h = F.h;
  const el = m.elev;
  const col: RGB = [0, 0, 0];
  const set = (c: RGB) => {
    col[0] = c[0];
    col[1] = c[1];
    col[2] = c[2];
  };
  const mix = (c: RGB, t: number) => {
    col[0] += (c[0] - col[0]) * t;
    col[1] += (c[1] - col[1]) * t;
    col[2] += (c[2] - col[2]) * t;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = m.terrain[i];
      const e = el[i] ?? 0.3;
      const fert = m.fert[i] ?? 0.5;
      // broad colour patches (two octaves of value noise over tiles)
      const broad = 0.65 * vnoise(F.seed ^ 0x1234, x / 7, y / 7) + 0.35 * vnoise(F.seed ^ 0x4321, x / 3, y / 3);
      let k = 2.4; // hill-shading strength
      switch (t) {
        case Terrain.Sand:
          set(SAND);
          k = 2;
          break;
        case Terrain.Grass: {
          set(GRASS_DRY);
          mix(GRASS_LUSH, clamp01(0.3 + fert * 0.85 + (broad - 0.5) * 0.3));
          // uplands a touch drier and browner
          mix(HILLS_LO, clamp01((e - 0.45) * 1.6) * 0.3);
          break;
        }
        case Terrain.Forest:
          set(FOREST_FLOOR);
          mix(GRASS_LUSH, 0.12 + (broad - 0.5) * 0.2);
          break;
        case Terrain.Hills:
          set(HILLS_LO);
          mix(HILLS_HI, clamp01((e - 0.58) / 0.25 + (broad - 0.5) * 0.4));
          k = 3.2;
          break;
        case Terrain.Mountain:
          set(MOUNTAIN);
          mix([150, 144, 134], clamp01((e - 0.8) / 0.2) * 0.4);
          k = 5.5;
          break;
        case Terrain.Marsh:
          set(MARSH);
          mix(GRASS_LUSH, (broad - 0.3) * 0.3);
          k = 2;
          break;
        default:
          set(SAND);
          k = 0;
      }
      // hill-shading: light from the north-west
      const xl = x > 0 ? x - 1 : x;
      const xr = x < w - 1 ? x + 1 : x;
      const yu = y > 0 ? y - 1 : y;
      const yd = y < h - 1 ? y + 1 : y;
      const dzdx = ((el[y * w + xr] ?? e) - (el[y * w + xl] ?? e)) / Math.max(1, xr - xl);
      const dzdy = ((el[yd * w + x] ?? e) - (el[yu * w + x] ?? e)) / Math.max(1, yd - yu);
      let sh = 1 + k * (dzdx + dzdy);
      sh = sh < 0.78 ? 0.78 : sh > 1.16 ? 1.16 : sh;
      // settlement ground
      const u = F.urban[i];
      if (u > 0 && t !== Terrain.Mountain && t !== Terrain.Marsh) mix(TOWN_GROUND, u * 0.55);
      const v = 0.955 + 0.09 * ihash(F.seed ^ 0x99, x, y);
      const hue = 0.985 + 0.03 * ihash(F.seed ^ 0x5a, x, y);
      F.lr[i] = col[0] * sh * v;
      F.lg[i] = col[1] * sh * v * hue;
      F.lb[i] = col[2] * sh * v;
    }
  }
}

/**
 * Paint the ground for tiles [tx0, tx0 + pw/g) × [ty0, ty0 + ph/g) into an
 * RGBA buffer `out` (pw × ph pixels, g pixels per tile). Fully opaque.
 */
export function fillGround(F: Fields, out: Uint8ClampedArray, pw: number, ph: number, tx0: number, ty0: number, g: number): void {
  const w = F.w;
  const h = F.h;
  const land = F.land;
  const lr = F.lr;
  const lg = F.lg;
  const lb = F.lb;
  const wr = F.wr;
  const wg = F.wg;
  const wb = F.wb;
  const seed = F.seed;
  const inv = 1 / g;
  const foamR = FOAM[0];
  const foamG = FOAM[1];
  const foamB = FOAM[2];
  let k = 0;
  for (let py = 0; py < ph; py++) {
    const v = ty0 + (py + 0.5) * inv;
    const fy = v - 0.5;
    let j0 = Math.floor(fy);
    const ty = fy - j0;
    let j1 = j0 + 1;
    if (j0 < 0) j0 = 0;
    if (j0 > h - 1) j0 = h - 1;
    if (j1 < 0) j1 = 0;
    if (j1 > h - 1) j1 = h - 1;
    const r0 = j0 * w;
    const r1 = j1 * w;
    const gy = Math.floor(v * 11);
    for (let px = 0; px < pw; px++) {
      const u = tx0 + (px + 0.5) * inv;
      const fx = u - 0.5;
      let i0 = Math.floor(fx);
      const tx = fx - i0;
      let i1 = i0 + 1;
      if (i0 < 0) i0 = 0;
      if (i0 > w - 1) i0 = w - 1;
      if (i1 < 0) i1 = 0;
      if (i1 > w - 1) i1 = w - 1;
      const a = r0 + i0;
      const b = r0 + i1;
      const c = r1 + i0;
      const d = r1 + i1;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const la = land[a];
      const lbb = land[b];
      const lc = land[c];
      const ld = land[d];
      let L = la * w00 + lbb * w10 + lc * w01 + ld * w11;
      let R: number;
      let G: number;
      let B: number;
      if (L > 0.02 && L < 0.98) {
        // shoreline: perturb the field so the coast meanders within tiles
        L += (vnoise(seed ^ 0x2468, u * 1.9, v * 1.9) - 0.5) * 0.34 + (vnoise(seed ^ 0x1357, u * 5.1, v * 5.1) - 0.5) * 0.1;
      }
      if (L >= 0.5) {
        const sa = w00 * la;
        const sb = w10 * lbb;
        const sc = w01 * lc;
        const sd = w11 * ld;
        const sum = sa + sb + sc + sd;
        const q = sum > 1e-6 ? 1 / sum : 0;
        if (q > 0) {
          R = (lr[a] * sa + lr[b] * sb + lr[c] * sc + lr[d] * sd) * q;
          G = (lg[a] * sa + lg[b] * sb + lg[c] * sc + lg[d] * sd) * q;
          B = (lb[a] * sa + lb[b] * sb + lb[c] * sc + lb[d] * sd) * q;
        } else {
          R = lr[a];
          G = lg[a];
          B = lb[a];
        }
        if (L < 0.6) {
          // wet sand / damp bank just above the waterline
          const f = 1 - (L - 0.5) / 0.1;
          const m = 1 - 0.16 * f;
          R *= m;
          G *= m;
          B *= m * 0.98;
        }
      } else {
        const sa = w00 * (1 - la);
        const sb = w10 * (1 - lbb);
        const sc = w01 * (1 - lc);
        const sd = w11 * (1 - ld);
        const sum = sa + sb + sc + sd;
        const q = sum > 1e-6 ? 1 / sum : 0;
        if (q > 0) {
          R = (wr[a] * sa + wr[b] * sb + wr[c] * sc + wr[d] * sd) * q;
          G = (wg[a] * sa + wg[b] * sb + wg[c] * sc + wg[d] * sd) * q;
          B = (wb[a] * sa + wb[b] * sb + wb[c] * sc + wb[d] * sd) * q;
        } else {
          R = wr[a];
          G = wg[a];
          B = wb[a];
        }
        if (L > 0.05) {
          // foam hugging the shore, and a faint swell line further out
          let f = (L - 0.4) / 0.1;
          f = f < 0 ? 0 : f > 1 ? 1 : f;
          f = f * f * 0.85;
          const s = 1 - Math.abs(L - 0.24) / 0.045;
          if (s > 0) f += s * 0.22;
          if (f > 0) {
            R += (foamR - R) * f;
            G += (foamG - G) * f;
            B += (foamB - B) * f;
          }
        }
      }
      // fine grain, fixed to the world so every zoom level matches
      const gr = 0.975 + 0.05 * ihash(seed, Math.floor(u * 11), gy);
      out[k] = R * gr;
      out[k + 1] = G * gr;
      out[k + 2] = B * gr;
      out[k + 3] = 255;
      k += 4;
    }
  }
}
