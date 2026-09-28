// ============================================================================
// Terrain generation. OWNER: world agent. See DESIGN §1.1.
//
// Pipeline (all seeded, deterministic, own local RNG — never touches s.rng):
//   1. coast   : an L-shaped sea along the south and east edges (a soft max of
//                the two edge distances, so the SE corner is rounded), broken up
//                by two octaves of fractal value noise into bays and headlands;
//   2. relief  : a mountain range along a noisy curve across the north (ridged
//                noise on the crest), a wide apron of hills around it, gentle
//                rolling land rising inland from the coast;
//   3. river   : a priority-flood from the sea gives every land tile a downhill
//                drainage path (depressions filled); the river follows that path
//                from a spring on the range's southern flank to the sea. It is
//                4-connected and one tile wide, so it is a true barrier to
//                movement except where a road bridges it;
//   4. moisture: fractal noise + river + foothill rain + sea spray → forests;
//                low wet coastland (and the river delta) → marsh;
//   5. deposits: timber (forest), coal (outer hills), ore (mountains and the hills
//                touching them), oil (marsh seeps), fish (shallow coastal water —
//                and the coastal land tiles fronting it carry the richness of the
//                grounds they face, which is where fisheries stand);
//   6. fertility for grassland (river bonus, upland and salt penalties);
//   7. town sites satisfying each town's resource needs; if a seed cannot satisfy
//      them the whole map is regenerated from a perturbed seed, and as a last
//      resort the missing terrain is planted next to the best site.
// ============================================================================
import { MAP_H, MAP_W } from '../config';
import { G } from '../goods';
import { seedRng, rand, randRange, type RngHolder } from '../rng';
import { Terrain, type MapData, type TownKind } from '../types';

export interface TownSite {
  kind: TownKind;
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

/** Integer lattice hash → [0, 1). */
export function hash2(seed: number, x: number, y: number): number {
  let h = (seed | 0) ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Smooth value noise in [0, 1). */
export function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const a = hash2(seed, x0, y0);
  const b = hash2(seed, x0 + 1, y0);
  const c = hash2(seed, x0, y0 + 1);
  const d = hash2(seed, x0 + 1, y0 + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Fractal (fBm) value noise, normalised to [0, 1) with mean ≈ 0.5. */
export function fbm(seed: number, x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(seed + o * 1013, x * freq + o * 17.3, y * freq - o * 9.1);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** fBm stretched to roughly [0, 1] (value-noise fBm has a narrow spread). */
function fbmS(seed: number, x: number, y: number, octaves = 4): number {
  const v = (fbm(seed, x, y, octaves) - 0.5) * 2.2 + 0.5;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// ---------------------------------------------------------------------------
// Terrain helpers (also used by layout.ts and the renderer)
// ---------------------------------------------------------------------------

export function isWaterT(t: number): boolean {
  return t === Terrain.Water || t === Terrain.DeepWater;
}

/** True for any land tile (river tiles included). */
export function isLand(map: MapData, i: number): boolean {
  return !isWaterT(map.terrain[i]);
}

const N8X = [1, -1, 0, 0, 1, 1, -1, -1];
const N8Y = [0, 0, 1, -1, 1, -1, 1, -1];

/** True if any of the 8 neighbours is a Mountain tile. */
export function nearMountain(map: MapData, i: number): boolean {
  const w = map.w;
  const x = i % w;
  const y = (i - x) / w;
  for (let k = 0; k < 8; k++) {
    const nx = x + N8X[k];
    const ny = y + N8Y[k];
    if (nx < 0 || ny < 0 || nx >= w || ny >= map.h) continue;
    if (map.terrain[ny * w + nx] === Terrain.Mountain) return true;
  }
  return false;
}

/** True if a 4-neighbour is shallow coastal water. */
export function frontsWater(map: MapData, i: number): boolean {
  const w = map.w;
  const x = i % w;
  const y = (i - x) / w;
  for (let k = 0; k < 4; k++) {
    const nx = x + N8X[k];
    const ny = y + N8Y[k];
    if (nx < 0 || ny < 0 || nx >= w || ny >= map.h) continue;
    if (map.terrain[ny * w + nx] === Terrain.Water) return true;
  }
  return false;
}

/**
 * The natural resource a tile's `deposit` measures, or -1:
 * Forest → wood, Mountain and Hills touching a Mountain → ore, other Hills → coal,
 * Marsh → oil, shallow Water → fish, and coastal Sand/Grass fronting shallow water
 * → fish (the fishing grounds it faces; fisheries stand there).
 */
export function tileResource(map: MapData, i: number): number {
  if (!(map.deposit[i] > 0)) return -1;
  switch (map.terrain[i]) {
    case Terrain.Forest:
      return G.wood;
    case Terrain.Mountain:
      return G.ore;
    case Terrain.Hills:
      return nearMountain(map, i) ? G.ore : G.coal;
    case Terrain.Marsh:
      return G.oil;
    case Terrain.Water:
      return G.fish;
    case Terrain.Sand:
    case Terrain.Grass:
      return G.fish;
    default:
      return -1;
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

interface Fields {
  w: number;
  h: number;
  terrain: number[];
  elev: number[];
  fert: number[];
  deposit: number[];
  river: number[];
  seaDist: Int32Array; // land: 4-steps to nearest sea; sea: steps to nearest land
  riverDist: Int32Array; // steps to nearest river tile (large if none)
  riverPath: number[]; // river tiles from the spring to the mouth
  mouth: number; // river mouth tile (last land tile) or -1
}

/** Soft maximum of a and b with smoothing radius r. */
function softmax(a: number, b: number, r: number): number {
  const m = Math.max(a, b);
  return m + r * Math.log(Math.exp((a - m) / r) + Math.exp((b - m) / r));
}

/** Multi-source BFS (4-neighbour) distance from every tile where `src(i)` is true. */
function bfsDist(w: number, h: number, src: (i: number) => boolean): Int32Array {
  const n = w * h;
  const d = new Int32Array(n).fill(1 << 20);
  const q = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  for (let i = 0; i < n; i++) if (src(i)) {
    d[i] = 0;
    q[qt++] = i;
  }
  while (qh < qt) {
    const i = q[qh++];
    const x = i % w;
    const y = (i - x) / w;
    const nd = d[i] + 1;
    if (x > 0 && d[i - 1] > nd) { d[i - 1] = nd; q[qt++] = i - 1; }
    if (x < w - 1 && d[i + 1] > nd) { d[i + 1] = nd; q[qt++] = i + 1; }
    if (y > 0 && d[i - w] > nd) { d[i - w] = nd; q[qt++] = i - w; }
    if (y < h - 1 && d[i + w] > nd) { d[i + w] = nd; q[qt++] = i + w; }
  }
  return d;
}

/** Tiny binary min-heap on (key, value) for the priority flood. */
class MinHeap {
  k: number[] = [];
  v: number[] = [];
  get size(): number {
    return this.k.length;
  }
  push(key: number, val: number): void {
    const k = this.k;
    const v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const k = this.k;
    const v = this.v;
    const top = v[0];
    const lk = k.pop() as number;
    const lv = v.pop() as number;
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && k[r] < k[l] ? r : l;
        if (k[c] >= lk) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
}

function generateFields(seed: number): Fields {
  const w = MAP_W;
  const h = MAP_H;
  const n = w * h;
  const R: RngHolder = { rng: seedRng((seed ^ 0x3c6ef372) >>> 0) };
  const sub = (k: number) => (Math.imul(seed | 0, 0x9e3779b1) + Math.imul(k, 0x85ebca77)) | 0;

  // ---- 1. coast ----------------------------------------------------------------
  const southY0 = h * randRange(R, 0.76, 0.83);
  const southTilt = randRange(R, -0.1, 0.1) * h; // coast rises/falls from west to east
  const eastX0 = w * randRange(R, 0.73, 0.81);
  const eastTilt = randRange(R, -0.08, 0.08) * w;
  const cornerR = randRange(R, 7, 12);
  const coastAmp = randRange(R, 7, 10);
  const sea = new Float64Array(n); // > 0 = sea (tiles beyond the shore)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dS = y - (southY0 + southTilt * (x / w - 0.5));
      const dE = x - (eastX0 + eastTilt * (y / h - 0.5));
      let c = softmax(dS, dE, cornerR);
      c += (fbm(sub(1), x / 22, y / 22, 4) - 0.5) * 2.6 * coastAmp;
      c += (fbm(sub(21), x / 11, y / 11, 3) - 0.5) * 2 * 4;
      c += (fbm(sub(2), x / 5, y / 5, 3) - 0.5) * 2 * 1.8;
      sea[y * w + x] = c;
    }
  }

  // ---- 2. relief ---------------------------------------------------------------
  // Ridge polyline across the north (west → east), displaced by noise.
  const ax = w * randRange(R, 0.05, 0.16);
  const ay = h * randRange(R, 0.12, 0.3);
  const bx = w * randRange(R, 0.56, 0.74);
  const by = h * randRange(R, 0.08, 0.22);
  const bulge = randRange(R, -0.1, 0.1) * h;
  const ridgePts: number[] = [];
  const NR = 48;
  for (let k = 0; k <= NR; k++) {
    const t = k / NR;
    const px = ax + (bx - ax) * t;
    const py = ay + (by - ay) * t + bulge * Math.sin(Math.PI * t) + (fbm(sub(3), t * 3.2, 0.37, 3) - 0.5) * 12;
    ridgePts.push(px, py);
  }
  const ridgeW = randRange(R, 3.4, 4.4);
  const ridgeD = new Float64Array(n); // distance to the crest
  const ridgeT = new Float64Array(n); // 0..1 position along the range (for tapering)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = 1e9;
      let bt = 0;
      for (let k = 0; k < NR; k++) {
        const x1 = ridgePts[2 * k];
        const y1 = ridgePts[2 * k + 1];
        const x2 = ridgePts[2 * k + 2];
        const y2 = ridgePts[2 * k + 3];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const ll = dx * dx + dy * dy || 1;
        const u = Math.min(1, Math.max(0, ((x - x1) * dx + (y - y1) * dy) / ll));
        const qx = x1 + u * dx - x;
        const qy = y1 + u * dy - y;
        const d2 = qx * qx + qy * qy;
        if (d2 < best) {
          best = d2;
          bt = (k + u) / NR;
        }
      }
      ridgeD[y * w + x] = Math.sqrt(best);
      ridgeT[y * w + x] = bt;
    }
  }

  const elev = new Array<number>(n).fill(0);
  const range = new Float64Array(n); // 0..1 "how mountainous" (for moisture/hills)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = ridgeT[i];
      const taper = smoothstep(0, 0.12, t) * smoothstep(1, 0.86, t);
      const wr = ridgeW * (0.75 + 0.6 * fbm(sub(4), x / 10, y / 10, 2));
      const d = ridgeD[i];
      const crest = Math.exp(-(d * d) / (wr * wr)) * taper;
      const aw = 3.3 * wr;
      const apron = Math.exp(-(d * d) / (aw * aw)) * (0.3 + 0.7 * taper);
      const nearRange = d < 4 * wr;
      const ridged = nearRange ? 1 - Math.abs(2 * fbm(sub(5), x / 5, y / 5, 4) - 1) : 0.5;
      const peaks = ridged * ridged;
      const inland = clamp01(-sea[i] / 28);
      let e = 0.24 + 0.2 * inland + 0.22 * (fbm(sub(6), x / 15, y / 15, 4) - 0.5);
      e += crest * (0.2 + 0.62 * peaks);
      e += nearRange || apron > 0.02 ? 0.27 * apron * (0.45 + 0.9 * fbm(sub(7), x / 7, y / 7, 3)) : 0;
      // Scattered upland knolls away from the range (small coal-bearing hills).
      const knoll = fbm(sub(8), x / 8, y / 8, 3);
      e += 0.24 * smoothstep(0.6, 0.78, knoll) * inland;
      elev[i] = e;
      range[i] = Math.max(crest, apron * 0.6);
    }
  }

  const terrain = new Array<number>(n).fill(Terrain.Grass);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // A little high-frequency roughness on the thresholds breaks the range into peaks and passes.
      const rough = 0.09 * (valueNoise(sub(22), x / 2.2, y / 2.2) - 0.5);
      if (sea[i] > 0) terrain[i] = Terrain.DeepWater;
      else if (elev[i] + rough > 0.8) terrain[i] = Terrain.Mountain;
      else if (elev[i] + rough * 0.6 > 0.6) terrain[i] = Terrain.Hills;
    }
  }
  // Remove specks: sea tiles with ≥ 3 land 4-neighbours become land, and vice versa.
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const nb = [i - 1, i + 1, i - w, i + w];
        let landN = 0;
        for (const j of nb) if (!isWaterT(terrain[j])) landN++;
        if (isWaterT(terrain[i]) && landN >= 3) {
          terrain[i] = Terrain.Grass;
          sea[i] = -0.5;
        } else if (!isWaterT(terrain[i]) && landN <= 1) {
          terrain[i] = Terrain.DeepWater;
          sea[i] = 0.5;
        }
      }
    }
  }

  let seaDist = bfsDist(w, h, (i) => isWaterT(terrain[i]));
  const landDist = bfsDist(w, h, (i) => !isWaterT(terrain[i]));

  // ---- 3. river ------------------------------------------------------------------
  // Priority flood from the shore: parent[] points one step downhill toward the sea.
  const parent = new Int32Array(n).fill(-1);
  const floodKey = new Float64Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap();
  for (let i = 0; i < n; i++) {
    if (!isWaterT(terrain[i])) continue;
    if (landDist[i] === 1) {
      heap.push(0, i);
      floodKey[i] = 0;
    }
  }
  const jitter = new Float64Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) jitter[y * w + x] = 0.16 * fbm(sub(9), x / 4, y / 4, 3);
  while (heap.size > 0) {
    const i = heap.pop();
    if (done[i]) continue;
    done[i] = 1;
    const x = i % w;
    const y = (i - x) / w;
    const ki = floodKey[i];
    const nbs = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nbs) {
      if (j < 0 || done[j] || isWaterT(terrain[j])) continue;
      const kj = Math.max(ki + 1e-4, elev[j] + jitter[j]);
      if (floodKey[j] < 0 || kj < floodKey[j]) {
        floodKey[j] = kj;
        parent[j] = i;
        heap.push(kj, j);
      }
    }
  }

  const river = new Array<number>(n).fill(0);
  let mouth = -1;
  // Candidate springs: southern flank of the range.
  const cx0 = w * 0.45;
  const cy0 = h * 0.5;
  let bestScore = -1e9;
  let bestPath: number[] = [];
  for (let tries = 0; tries < 160; tries++) {
    const x = Math.floor(randRange(R, w * 0.12, w * 0.7));
    const y = Math.floor(randRange(R, 2, h * 0.5));
    const i = y * w + x;
    if (isWaterT(terrain[i]) || parent[i] < 0) continue;
    if (!(elev[i] > 0.66 && elev[i] < 1.2)) continue;
    // must lie south of the crest (the river runs toward the southern/eastern sea)
    const path: number[] = [];
    let j = i;
    let guard = 0;
    while (j >= 0 && !isWaterT(terrain[j]) && guard++ < n) {
      path.push(j);
      j = parent[j];
    }
    if (path.length < 34) continue;
    let minC = 1e9;
    for (const p of path) {
      const px = p % w;
      const py = (p - px) / w;
      minC = Math.min(minC, Math.hypot(px - cx0, py - cy0));
    }
    // Long rivers that pass near the centre of the land; not too long (≤ 95).
    const len = path.length;
    const spring = terrain[i] === Terrain.Mountain ? 6 : 0;
    const score = Math.min(len, 80) - 1.4 * minC - (len > 100 ? (len - 100) * 2 : 0) + spring + 0.4 * rand(R);
    if (score > bestScore) {
      bestScore = score;
      bestPath = path;
    }
  }
  for (const p of bestPath) river[p] = 1;
  if (bestPath.length > 0) mouth = bestPath[bestPath.length - 1];
  const riverDist = bfsDist(w, h, (i) => river[i] === 1);
  // Carve a gentle valley along the river (visual; also keeps hills off the banks).
  for (let i = 0; i < n; i++) {
    if (isWaterT(terrain[i])) continue;
    const rd = riverDist[i];
    if (rd <= 3) {
      const k = rd === 0 ? 0.09 : rd === 1 ? 0.06 : rd === 2 ? 0.035 : 0.015;
      elev[i] -= k * (0.6 + range[i]);
      if (terrain[i] === Terrain.Hills && elev[i] <= 0.6) terrain[i] = Terrain.Grass;
      if (terrain[i] === Terrain.Mountain && elev[i] <= 0.8) terrain[i] = elev[i] > 0.6 ? Terrain.Hills : Terrain.Grass;
    }
  }

  // ---- 4. moisture: forest & marsh ------------------------------------------------
  const moist = new Float64Array(n);
  const landIdx: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (isWaterT(terrain[i])) continue;
      landIdx.push(i);
      let m = fbm(sub(10), x / 14, y / 14, 4);
      m += 0.16 * Math.exp(-riverDist[i] / 4);
      m += 0.2 * range[i]; // rain on the flanks
      m += 0.06 * Math.exp(-seaDist[i] / 5);
      moist[i] = m;
    }
  }
  // Forest covers roughly the wettest 30 % of low land.
  const lowMoist = landIdx.filter((i) => terrain[i] === Terrain.Grass).map((i) => moist[i]).sort((a, b) => a - b);
  const forestCut = lowMoist.length ? lowMoist[Math.floor(lowMoist.length * 0.68)] : 1;
  for (const i of landIdx) {
    if (terrain[i] !== Terrain.Grass) continue;
    if (moist[i] >= forestCut && seaDist[i] > 1) terrain[i] = Terrain.Forest;
  }
  // Marsh: low, wet coastland and the river delta.
  let marshCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (terrain[i] !== Terrain.Grass && terrain[i] !== Terrain.Forest) continue;
      const sd = seaDist[i];
      if (sd > 7 || elev[i] > 0.42) continue;
      const mn = fbm(sub(11), x / 7, y / 7, 3);
      let md = 0;
      if (mouth >= 0) {
        const mx = mouth % w;
        const my = (mouth - mx) / w;
        md = Math.hypot(x - mx, y - my);
      }
      const delta = mouth >= 0 ? Math.exp(-md / 5.5) : 0;
      const score = mn + 0.45 * delta - 0.03 * sd + 0.1 * Math.exp(-riverDist[i] / 3);
      if (score > 0.68) {
        terrain[i] = Terrain.Marsh;
        marshCount++;
      }
    }
  }
  if (marshCount < 14 && mouth >= 0) {
    // Guarantee a delta marsh at the river mouth.
    const mx = mouth % w;
    const my = (mouth - mx) / w;
    for (let y = Math.max(0, my - 5); y <= Math.min(h - 1, my + 5); y++) {
      for (let x = Math.max(0, mx - 5); x <= Math.min(w - 1, mx + 5); x++) {
        const i = y * w + x;
        if (isWaterT(terrain[i]) || terrain[i] === Terrain.Mountain || terrain[i] === Terrain.Hills) continue;
        if (Math.hypot(x - mx, y - my) <= 3.2 + 1.8 * hash2(sub(12), x, y)) terrain[i] = Terrain.Marsh;
      }
    }
  }

  // ---- beaches and shallows ---------------------------------------------------------
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = terrain[i];
      if (t !== Terrain.Grass && t !== Terrain.Forest) continue;
      if (river[i]) continue;
      if (seaDist[i] === 1 || (seaDist[i] === 2 && fbm(sub(13), x / 5, y / 5, 2) > 0.62)) terrain[i] = Terrain.Sand;
    }
  }
  seaDist = bfsDist(w, h, (i) => isWaterT(terrain[i]));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!isWaterT(terrain[i])) continue;
      const ld = landDist[i];
      const shelf = fbm(sub(14), x / 9, y / 9, 3);
      terrain[i] = ld <= 2 || (ld <= 4 && shelf > 0.58) ? Terrain.Water : Terrain.DeepWater;
      elev[i] = Math.max(0, 0.18 - 0.025 * ld);
    }
  }

  // ---- 5. deposits ------------------------------------------------------------------
  const deposit = new Array<number>(n).fill(0);
  const tmp: MapData = { w, h, terrain, elev, fert: [], deposit, river, road: [], occ: [], district: [] };
  let mX = -1;
  let mY = -1;
  if (mouth >= 0) {
    mX = mouth % w;
    mY = (mouth - mX) / w;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = terrain[i];
      let d = 0;
      if (t === Terrain.Forest) {
        let fn = 0;
        for (let k = 0; k < 8; k++) {
          const nx = x + N8X[k];
          const ny = y + N8Y[k];
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && terrain[ny * w + nx] === Terrain.Forest) fn++;
        }
        d = 0.2 + 0.55 * fbmS(sub(15), x / 6, y / 6, 3) + 0.25 * (fn / 8);
      } else if (t === Terrain.Mountain || (t === Terrain.Hills && nearMountain(tmp, i))) {
        d = (fbmS(sub(16), x / 5, y / 5, 3) - 0.25) * 1.5;
      } else if (t === Terrain.Hills) {
        d = (fbmS(sub(17), x / 5.5, y / 5.5, 3) - 0.22) * 1.45;
      } else if (t === Terrain.Marsh) {
        d = (fbmS(sub(18), x / 3.5, y / 3.5, 3) - 0.42) * 2.2;
      } else if (t === Terrain.Water) {
        const md = mX >= 0 ? Math.hypot(x - mX, y - mY) : 99;
        d = 0.2 + 0.55 * fbmS(sub(19), x / 7, y / 7, 3) + 0.3 * Math.exp(-md / 9) - 0.06 * (landDist[i] - 1);
      }
      deposit[i] = Math.round(clamp01(d) * 1000) / 1000;
    }
  }
  // Coastal land carries the richness of the fishing grounds it fronts.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = terrain[i];
      if ((t !== Terrain.Sand && t !== Terrain.Grass) || river[i]) continue;
      let best = 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + N8X[k];
        const ny = y + N8Y[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (terrain[j] === Terrain.Water) best = Math.max(best, deposit[j]);
      }
      deposit[i] = Math.round(best * 0.95 * 1000) / 1000;
    }
  }

  // ---- 6. fertility -------------------------------------------------------------------
  const fert = new Array<number>(n).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = terrain[i];
      if (isWaterT(t)) continue;
      const base = 0.3 + 0.5 * fbmS(sub(20), x / 11, y / 11, 4);
      const riverB = 0.32 * Math.exp(-riverDist[i] / 3.5);
      const upland = 0.3 * smoothstep(0.44, 0.6, elev[i]);
      const salt = 0.18 * Math.exp(-(seaDist[i] - 1) / 1.5);
      let f = base + riverB - upland - salt;
      if (t === Terrain.Forest) f *= 0.45;
      else if (t === Terrain.Marsh) f = 0.12;
      else if (t === Terrain.Sand) f = 0.06;
      else if (t === Terrain.Hills) f *= 0.3;
      else if (t === Terrain.Mountain) f = 0;
      fert[i] = Math.round(clamp01(f) * 1000) / 1000;
    }
  }
  for (let i = 0; i < n; i++) elev[i] = Math.round(clamp01(elev[i]) * 1000) / 1000;

  return { w, h, terrain, elev, fert, deposit, river, seaDist, riverDist, riverPath: bestPath, mouth };
}

// ---------------------------------------------------------------------------
// Town sites
// ---------------------------------------------------------------------------

/** Summed-area table for O(1) square-window sums. */
function sat(w: number, h: number, v: (i: number) => number): Float64Array {
  const t = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += v(y * w + x);
      t[(y + 1) * (w + 1) + (x + 1)] = t[y * (w + 1) + (x + 1)] + row;
    }
  }
  return t;
}

function boxSum(t: Float64Array, w: number, h: number, cx: number, cy: number, r: number): number {
  const x0 = Math.max(0, cx - r);
  const y0 = Math.max(0, cy - r);
  const x1 = Math.min(w, cx + r + 1);
  const y1 = Math.min(h, cy + r + 1);
  const W1 = w + 1;
  return t[y1 * W1 + x1] - t[y0 * W1 + x1] - t[y1 * W1 + x0] + t[y0 * W1 + x0];
}

/** Town-core buildability: land that houses and workshops can stand on. */
function buildableT(t: number): boolean {
  return t === Terrain.Grass || t === Terrain.Sand || t === Terrain.Forest || t === Terrain.Hills;
}

/** The 2×2 market hall whose bottom-right tile is (x, y) must stand on dry, flat-ish, river-free land. */
function hallOk(F: Fields, x: number, y: number): boolean {
  const { w, h, terrain, river } = F;
  if (x < 3 || y < 3 || x > w - 4 || y > h - 4) return false;
  for (let dy = -1; dy <= 0; dy++) {
    for (let dx = -1; dx <= 0; dx++) {
      const i = (y + dy) * w + (x + dx);
      if (river[i] || !(terrain[i] === Terrain.Grass || terrain[i] === Terrain.Sand)) return false;
    }
  }
  return true;
}

interface SiteTables {
  grass: Float64Array;
  build: Float64Array;
  fertile: Float64Array;
  coal: Float64Array;
  ore: Float64Array;
  forest: Float64Array;
  fish: Float64Array;
  oil: Float64Array;
  river: Float64Array;
}

function siteTables(F: Fields): SiteTables {
  const { w, h, terrain, deposit, fert, river } = F;
  const tmp = { w, h, terrain, deposit } as unknown as MapData;
  return {
    grass: sat(w, h, (i) => (terrain[i] === Terrain.Grass && !river[i] ? 1 : 0)),
    build: sat(w, h, (i) => (buildableT(terrain[i]) && !river[i] ? 1 : 0)),
    fertile: sat(w, h, (i) => (terrain[i] === Terrain.Grass && !river[i] && fert[i] > 0.5 ? fert[i] : 0)),
    coal: sat(w, h, (i) => (terrain[i] === Terrain.Hills && deposit[i] > 0.3 && !nearMountain(tmp, i) ? 1 : 0)),
    ore: sat(w, h, (i) => ((terrain[i] === Terrain.Mountain || terrain[i] === Terrain.Hills) && deposit[i] > 0.3 && (terrain[i] === Terrain.Mountain || nearMountain(tmp, i)) ? 1 : 0)),
    forest: sat(w, h, (i) => (terrain[i] === Terrain.Forest && deposit[i] > 0.4 ? 1 : 0)),
    fish: sat(w, h, (i) => (terrain[i] === Terrain.Water && deposit[i] > 0.35 ? 1 : 0)),
    oil: sat(w, h, (i) => (terrain[i] === Terrain.Marsh && deposit[i] > 0.3 ? 1 : 0)),
    river: sat(w, h, (i) => river[i]),
  };
}

/** True if a path over land (rivers crossable: bridges will be built) joins a and b. */
function landConnected(F: Fields, a: number, b: number): boolean {
  const { w, h, terrain } = F;
  const n = w * h;
  const seen = new Uint8Array(n);
  const q = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  q[qt++] = a;
  seen[a] = 1;
  while (qh < qt) {
    const i = q[qh++];
    if (i === b) return true;
    const x = i % w;
    const y = (i - x) / w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) {
      if (j < 0 || seen[j] || isWaterT(terrain[j]) || terrain[j] === Terrain.Mountain) continue;
      seen[j] = 1;
      q[qt++] = j;
    }
  }
  return false;
}

const RES_R = 9; // resource search half-window (≈ 10-tile reach)

interface Pick {
  x: number;
  y: number;
  score: number;
}

/**
 * Choose the four town sites. Returns null if any constraint cannot be met.
 * `relax` (0..1) lowers the resource thresholds (used for the final attempts).
 */
function chooseSites(F: Fields, relax: number): TownSite[] | null {
  const { w, h, terrain, river, seaDist, riverDist } = F;
  const T = siteTables(F);
  const k = 1 - 0.5 * relax;
  const need = { fertile: 22 * k, coal: 6 * k, ore: 5 * k, forest: 8 * k, fish: 10 * k, oil: 3 * k };
  const far = (x: number, y: number, list: TownSite[], dmin: number) => list.every((s) => Math.hypot(s.x - x, s.y - y) >= dmin);
  const sites: TownSite[] = [];

  // --- capital: on the middle reaches of the river, central, on open grassland ---
  // Position of each river tile along the river (0 = spring, 1 = mouth).
  const along = new Float64Array(w * h).fill(-1);
  const rp = F.riverPath;
  for (let k = 0; k < rp.length; k++) along[rp[k]] = rp.length > 1 ? k / (rp.length - 1) : 0.5;
  const mountainT = sat(w, h, (i) => (terrain[i] === Terrain.Mountain ? 1 : 0));
  let best: Pick | null = null;
  for (let y = 4; y < h - 4; y++) {
    for (let x = 4; x < w - 4; x++) {
      if (!hallOk(F, x, y)) continue;
      const i = y * w + x;
      // the hall (x-1..x, y-1..y) must touch the river
      let pos = -1;
      for (let dy = -2; dy <= 1 && pos < 0; dy++) {
        for (let dx = -2; dx <= 1; dx++) {
          const j = (y + dy) * w + (x + dx);
          if (along[j] >= 0 && (dx === -2 || dx === 1 || dy === -2 || dy === 1) && !((dx === -2 || dx === 1) && (dy === -2 || dy === 1))) {
            pos = along[j];
            break;
          }
        }
      }
      if (pos < 0) continue;
      if (seaDist[i] < 7) continue;
      const grass = boxSum(T.grass, w, h, x, y, 6);
      if (grass < 70) continue;
      const cd = Math.hypot(x - w * 0.46, y - h * 0.5);
      const mid = 1 - Math.abs(pos - 0.55) * 2; // 1 at mid-river
      const score = grass * 0.25 - cd * 0.8 + mid * 14 + boxSum(T.build, w, h, x, y, 8) * 0.05 - boxSum(mountainT, w, h, x, y, 7) * 1.5;
      if (!best || score > best.score) best = { x, y, score };
    }
  }
  if (!best) return null;
  sites.push({ kind: 'capital', x: best.x, y: best.y });
  const cap = sites[0];

  // --- harbor: on the coast, fish in the water, oil in a nearby marsh ---
  best = null;
  for (let y = 4; y < h - 4; y++) {
    for (let x = 4; x < w - 4; x++) {
      const i = y * w + x;
      const sd = seaDist[i];
      if (sd < 2 || sd > 4) continue;
      if (!hallOk(F, x, y)) continue;
      if (!far(x, y, sites, 18)) continue;
      const fish = boxSum(T.fish, w, h, x, y, RES_R);
      const oil = boxSum(T.oil, w, h, x, y, RES_R);
      if (fish < need.fish || oil < need.oil) continue;
      const dc = Math.hypot(x - cap.x, y - cap.y);
      if (dc > 42) continue;
      const score = Math.min(fish, 30) * 0.4 + Math.min(oil, 12) * 1.2 - Math.abs(dc - 26) * 0.6 + boxSum(T.build, w, h, x, y, 5) * 0.08;
      if (!best || score > best.score) best = { x, y, score };
    }
  }
  if (!best) return null;
  sites.push({ kind: 'harbor', x: best.x, y: best.y });

  // --- mining: coal, ore and timber within reach, by the mountains ---
  best = null;
  for (let y = 3; y < h - 3; y++) {
    for (let x = 3; x < w - 3; x++) {
      if (!hallOk(F, x, y)) continue;
      if (!far(x, y, sites, 18)) continue;
      const coal = boxSum(T.coal, w, h, x, y, RES_R);
      const ore = boxSum(T.ore, w, h, x, y, RES_R);
      const forest = boxSum(T.forest, w, h, x, y, RES_R);
      if (coal < need.coal || ore < need.ore || forest < need.forest) continue;
      if (boxSum(T.build, w, h, x, y, 4) < 45) continue;
      const dc = Math.hypot(x - cap.x, y - cap.y);
      if (dc > 40) continue;
      const score = Math.min(coal / 6, 3) * 3 + Math.min(ore / 5, 3) * 3 + Math.min(forest / 8, 3) * 2 - Math.abs(dc - 24) * 0.5;
      if (!best || score > best.score) best = { x, y, score };
    }
  }
  if (!best) return null;
  sites.push({ kind: 'mining', x: best.x, y: best.y });

  // --- farm town: the most fertile open grassland, preferably west ---
  best = null;
  for (let y = 4; y < h - 4; y++) {
    for (let x = 4; x < w - 4; x++) {
      if (!hallOk(F, x, y)) continue;
      if (!far(x, y, sites, 18)) continue;
      const fertile = boxSum(T.fertile, w, h, x, y, RES_R + 3) - boxSum(T.fertile, w, h, x, y, 3);
      if (fertile < need.fertile * 0.6) continue;
      const dc = Math.hypot(x - cap.x, y - cap.y);
      if (dc > 36) continue;
      // Grain goes to every town: stay within reach of the others too.
      let others = 0;
      let tooFar = false;
      for (const o of sites) {
        if (o === cap) continue;
        const d = Math.hypot(x - o.x, y - o.y);
        others += d;
        if (d > 46) tooFar = true;
      }
      if (tooFar) continue;
      const west = x < cap.x ? 5 : 0;
      const score = Math.min(fertile, 60) * 0.5 + west - Math.abs(dc - 24) * 0.5 - 0.25 * others - (seaDist[y * w + x] < 5 ? 6 : 0);
      if (!best || score > best.score) best = { x, y, score };
    }
  }
  if (!best) return null;
  sites.push({ kind: 'farm', x: best.x, y: best.y });

  // All towns reachable over land from the capital.
  for (const s of sites) {
    if (s === cap) continue;
    if (!landConnected(F, cap.y * w + cap.x, s.y * w + s.x)) return null;
  }
  void terrain;
  // Order: capital, farm, mining, harbor.
  const order: TownKind[] = ['capital', 'farm', 'mining', 'harbor'];
  return order.map((kd) => sites.find((s) => s.kind === kd) as TownSite);
}

/**
 * Last resort for a stubborn seed: plant the terrain a town lacks next to the
 * best available site (a marsh with seeps, a copse, a coal outcrop).
 */
function forceSites(F: Fields): TownSite[] {
  const { w, h, terrain, deposit } = F;
  const plant = (cx: number, cy: number, t: number, dep: number, r: number, ok: (i: number) => boolean) => {
    for (let y = Math.max(1, cy - r); y <= Math.min(h - 2, cy + r); y++) {
      for (let x = Math.max(1, cx - r); x <= Math.min(w - 2, cx + r); x++) {
        const i = y * w + x;
        if (F.river[i] || !ok(i)) continue;
        if (Math.hypot(x - cx, y - cy) > r) continue;
        terrain[i] = t;
        deposit[i] = dep * (0.7 + 0.3 * hash2(77, x, y));
      }
    }
  };
  // Capital: nearest hall-ok tile to the centre by the river (or anywhere).
  const pickNear = (tx: number, ty: number, pred: (x: number, y: number) => boolean): { x: number; y: number } => {
    let bx = Math.round(tx);
    let by = Math.round(ty);
    let bd = 1e9;
    for (let y = 4; y < h - 4; y++) {
      for (let x = 4; x < w - 4; x++) {
        if (!pred(x, y)) continue;
        const d = Math.hypot(x - tx, y - ty);
        if (d < bd) {
          bd = d;
          bx = x;
          by = y;
        }
      }
    }
    return { x: bx, y: by };
  };
  const landOk = (x: number, y: number) => hallOk(F, x, y);
  const cap = pickNear(w * 0.46, h * 0.5, (x, y) => landOk(x, y) && F.riverDist[y * w + x] <= 2);
  const har = pickNear(w * 0.7, h * 0.72, (x, y) => landOk(x, y) && F.seaDist[y * w + x] >= 2 && F.seaDist[y * w + x] <= 4 && Math.hypot(x - cap.x, y - cap.y) > 20);
  const min = pickNear(w * 0.4, h * 0.25, (x, y) => landOk(x, y) && Math.hypot(x - cap.x, y - cap.y) > 20 && Math.hypot(x - har.x, y - har.y) > 20);
  const frm = pickNear(w * 0.2, h * 0.5, (x, y) => landOk(x, y) && Math.hypot(x - cap.x, y - cap.y) > 20 && Math.hypot(x - min.x, y - min.y) > 20 && Math.hypot(x - har.x, y - har.y) > 20);
  const lowLand = (i: number) => terrain[i] === Terrain.Grass || terrain[i] === Terrain.Sand || terrain[i] === Terrain.Forest;
  // Harbor: marsh with seeps, 5–7 tiles away along the coast.
  plant(har.x + 5, har.y + 1, Terrain.Marsh, 0.75, 2.5, lowLand);
  // Mining: hills with coal, a mountain spur with ore, a copse.
  plant(min.x - 6, min.y - 3, Terrain.Hills, 0.7, 2.5, lowLand);
  plant(min.x + 5, min.y - 5, Terrain.Mountain, 0.75, 1.8, (i) => lowLand(i) || terrain[i] === Terrain.Hills);
  plant(min.x + 1, min.y + 6, Terrain.Forest, 0.7, 2.8, (i) => terrain[i] === Terrain.Grass);
  return [
    { kind: 'capital', x: cap.x, y: cap.y },
    { kind: 'farm', x: frm.x, y: frm.y },
    { kind: 'mining', x: min.x, y: min.y },
    { kind: 'harbor', x: har.x, y: har.y },
  ];
}

/**
 * Land far from every town was never cleared: grassland more than ~22 tiles from
 * the nearest town turns to wildwood where the noise says so (denser with distance),
 * so the settled country reads as open fields and the frontier as forest.
 */
function wildwood(F: Fields, sites: readonly TownSite[], seed: number): void {
  const { w, h, terrain, deposit, fert, river } = F;
  const k = (Math.imul(seed | 0, 0x7feb352d) ^ 0x2545f491) | 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (terrain[i] !== Terrain.Grass || river[i] || F.seaDist[i] <= 1) continue;
      let dmin = 1e9;
      for (const s of sites) dmin = Math.min(dmin, Math.hypot(x - s.x, y - s.y));
      if (dmin < 22) continue;
      const cut = 0.64 - 0.22 * smoothstep(22, 42, dmin);
      if (fbm(k, x / 9, y / 9, 3) < cut) continue;
      terrain[i] = Terrain.Forest;
      deposit[i] = Math.round(clamp01(0.3 + 0.55 * fbmS(k + 7, x / 6, y / 6, 3)) * 1000) / 1000;
      fert[i] = Math.round(fert[i] * 0.45 * 1000) / 1000;
    }
  }
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
 * Sites are returned in the order capital, farm, mining, harbor.
 */
export function generateMap(seed: number): { map: MapData; sites: TownSite[] } {
  let F: Fields | null = null;
  let sites: TownSite[] | null = null;
  const MAX_TRIES = 10;
  for (let attempt = 0; attempt < MAX_TRIES && !sites; attempt++) {
    const s2 = attempt === 0 ? seed : (Math.imul(seed | 0, 0x2c1b3c6d) ^ Math.imul(attempt, 0x297a2d39)) >>> 0;
    F = generateFields(s2);
    sites = chooseSites(F, attempt >= MAX_TRIES - 3 ? 1 : 0);
  }
  if (!F) F = generateFields(seed);
  if (!sites) sites = forceSites(F);
  wildwood(F, sites, seed);
  const n = F.w * F.h;
  const map: MapData = {
    w: F.w,
    h: F.h,
    terrain: F.terrain,
    elev: F.elev,
    fert: F.fert,
    deposit: F.deposit,
    river: F.river,
    road: new Array<number>(n).fill(0),
    occ: new Array<number>(n).fill(-1),
    district: new Array<number>(n).fill(-1),
  };
  return { map, sites };
}
