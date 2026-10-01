// ============================================================================
// Road and river networks as smooth polylines (pure, DOM-free, tested).
//
// The simulation stores roads per tile (0 none, 1 dirt, 2 paved) laid along
// 4-neighbour paths, so drawn tile-to-tile they look like staircases. Here the
// road tiles become a graph (4-neighbour links, plus a diagonal link where two
// tracks touch only at a corner), the graph is cut into chains between
// junctions (a tile whose degree is not 2, or where the surface changes), and
// each chain is smoothed with Chaikin corner cutting (ends pinned, so chains
// still meet exactly at junctions). The river — a 4-connected chain of tiles
// from a spring to the sea — is ordered spring → mouth the same way.
// ============================================================================

/** A smoothed road chain in tile coordinates (tile centres at +0.5). */
export interface Chain {
  /** 1 dirt, 2 paved. */
  level: number;
  /** Interleaved x, y. */
  pts: number[];
  /** True if the chain is a closed loop (first point = last point). */
  closed: boolean;
  /** Bounding box (tiles). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Directions: 0 E, 1 W, 2 S, 3 N, 4 SE, 5 NE, 6 SW, 7 NW
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const OPP = [1, 0, 3, 2, 7, 6, 5, 4];

function popcount8(m: number): number {
  let c = 0;
  for (let k = 0; k < 8; k++) if (m & (1 << k)) c++;
  return c;
}

/**
 * Chaikin corner cutting. `closed` loops are smoothed all round; open chains
 * keep their end points. Returns a new array.
 */
export function chaikin(pts: readonly number[], iterations: number, closed = false): number[] {
  let cur = pts.slice();
  for (let it = 0; it < iterations; it++) {
    const n = cur.length / 2;
    if (n < 3) return cur;
    const out: number[] = [];
    if (closed) {
      // treat as a cycle over n-1 unique points (last = first)
      const m = n - 1;
      for (let k = 0; k < m; k++) {
        const ax = cur[2 * k];
        const ay = cur[2 * k + 1];
        const b = (k + 1) % m;
        const bx = cur[2 * b];
        const by = cur[2 * b + 1];
        out.push(0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by, 0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by);
      }
      out.push(out[0], out[1]);
    } else {
      out.push(cur[0], cur[1]);
      for (let k = 0; k < n - 1; k++) {
        const ax = cur[2 * k];
        const ay = cur[2 * k + 1];
        const bx = cur[2 * k + 2];
        const by = cur[2 * k + 3];
        if (k > 0) out.push(0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by);
        if (k < n - 2) out.push(0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by);
      }
      out.push(cur[2 * n - 2], cur[2 * n - 1]);
    }
    cur = out;
  }
  return cur;
}

function bbox(pts: number[]): [number, number, number, number] {
  let x0 = 1e9;
  let y0 = 1e9;
  let x1 = -1e9;
  let y1 = -1e9;
  for (let k = 0; k < pts.length; k += 2) {
    const x = pts[k];
    const y = pts[k + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/**
 * Road network → smoothed chains. Tiles with `road[i] ≥ minLevel` form the
 * network (so minLevel 1 = every track, paved ones included; minLevel 2 = the
 * paved network alone, drawn on top — paving follows the travel route, which
 * cuts the corners of staircase tracks diagonally, so the paved graph must be
 * linked on its own); tiles for which `skip(i)` is true (e.g. under a market
 * hall) are left out. Chains break at junctions (degree ≠ 2).
 */
export function roadChains(w: number, h: number, road: ArrayLike<number>, skip?: (i: number) => boolean, smooth = 2, minLevel = 1): Chain[] {
  const n = w * h;
  const lvl = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = road[i];
    if (r >= minLevel && !(skip && skip(i))) lvl[i] = 1;
  }
  const mask = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!lvl[i]) continue;
      let m = 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (lvl[ny * w + nx]) m |= 1 << d;
      }
      for (let d = 4; d < 8; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (!lvl[ny * w + nx]) continue;
        // corner touch only: neither orthogonal step between them is road
        if (lvl[y * w + nx] || lvl[ny * w + x]) continue;
        m |= 1 << d;
      }
      mask[i] = m;
    }
  }
  const isJunction = (i: number): boolean => popcount8(mask[i]) !== 2;
  const junction = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (lvl[i] && isJunction(i)) junction[i] = 1;
  const seen = new Uint8Array(n); // visited-edge bits per tile
  const chains: Chain[] = [];

  const walk = (start: number, dir: number): void => {
    const pts: number[] = [];
    let cur = start;
    let d = dir;
    let guard = 0;
    pts.push((cur % w) + 0.5, Math.floor(cur / w) + 0.5);
    for (;;) {
      const x = cur % w;
      const y = (cur - x) / w;
      const nxt = (y + DY[d]) * w + (x + DX[d]);
      seen[cur] |= 1 << d;
      seen[nxt] |= 1 << OPP[d];
      pts.push((nxt % w) + 0.5, Math.floor(nxt / w) + 0.5);
      cur = nxt;
      if (junction[cur] || cur === start || guard++ > n) break;
      // degree-2 tile: continue along the other link
      const m = mask[cur] & ~(1 << OPP[d]);
      let nd = -1;
      for (let k = 0; k < 8; k++) if (m & (1 << k)) {
        nd = k;
        break;
      }
      if (nd < 0 || seen[cur] & (1 << nd)) break;
      d = nd;
    }
    const closed = cur === start && !junction[start];
    const level = minLevel;
    const sm = chaikin(pts, smooth, closed);
    const [x0, y0, x1, y1] = bbox(sm);
    chains.push({ level, pts: sm, closed, x0, y0, x1, y1 });
  };

  for (let i = 0; i < n; i++) {
    if (!junction[i]) continue;
    const m = mask[i];
    for (let d = 0; d < 8; d++) if (m & (1 << d) && !(seen[i] & (1 << d))) walk(i, d);
  }
  // loops without any junction
  for (let i = 0; i < n; i++) {
    if (!lvl[i] || junction[i]) continue;
    const m = mask[i];
    for (let d = 0; d < 8; d++) if (m & (1 << d) && !(seen[i] & (1 << d))) walk(i, d);
  }
  // isolated single tiles: a dot-sized chain so they still draw
  for (let i = 0; i < n; i++) {
    if (lvl[i] && mask[i] === 0) {
      const x = (i % w) + 0.5;
      const y = Math.floor(i / w) + 0.5;
      chains.push({ level: minLevel, pts: [x - 0.2, y, x + 0.2, y], closed: false, x0: x - 0.2, y0: y, x1: x + 0.2, y1: y });
    }
  }
  return chains;
}

/** River course, spring → mouth, with a width profile. */
export interface River {
  pts: number[];
  /** Width (tiles) at each point. */
  width: number[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Order river tiles into courses. Each course starts at its highest end (the
 * spring) and, where it reaches open water, is extended half a tile into it so
 * the mouth meets the sea. `water(i)` tells open water tiles.
 */
export function riverCourses(w: number, h: number, river: ArrayLike<number>, elev: ArrayLike<number>, water: (i: number) => boolean, smooth = 2): River[] {
  const n = w * h;
  const isR = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && !!river[y * w + x];
  const deg = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!river[y * w + x]) continue;
    let d = 0;
    for (let k = 0; k < 4; k++) if (isR(x + DX[k], y + DY[k])) d++;
    deg[y * w + x] = d;
  }
  const used = new Uint8Array(n);
  const out: River[] = [];
  const course = (start: number): void => {
    const tiles: number[] = [start];
    used[start] = 1;
    let cur = start;
    for (let guard = 0; guard < n; guard++) {
      const x = cur % w;
      const y = (cur - x) / w;
      let nxt = -1;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (!isR(nx, ny)) continue;
        const j = ny * w + nx;
        if (used[j]) continue;
        nxt = j;
        break;
      }
      if (nxt < 0) break;
      used[nxt] = 1;
      tiles.push(nxt);
      cur = nxt;
    }
    if (tiles.length < 2) return;
    // orient spring (higher) → mouth
    if ((elev[tiles[0]] ?? 0) < (elev[tiles[tiles.length - 1]] ?? 0)) tiles.reverse();
    const pts: number[] = [];
    for (const i of tiles) pts.push((i % w) + 0.5, Math.floor(i / w) + 0.5);
    const last = tiles[tiles.length - 1];
    const lx = last % w;
    const ly = (last - lx) / w;
    for (let k = 0; k < 4; k++) {
      const nx = lx + DX[k];
      const ny = ly + DY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (water(ny * w + nx)) {
        pts.push(lx + 0.5 + DX[k] * 0.9, ly + 0.5 + DY[k] * 0.9);
        break;
      }
    }
    const sm = chaikin(pts, smooth, false);
    const m = sm.length / 2;
    const width: number[] = [];
    for (let k = 0; k < m; k++) {
      const t = m > 1 ? k / (m - 1) : 1;
      width.push(0.2 + 0.36 * Math.pow(t, 0.8));
    }
    const [x0, y0, x1, y1] = bbox(sm);
    out.push({ pts: sm, width, x0, y0, x1, y1 });
  };
  // start from ends (degree ≤ 1), highest first so each course runs downhill
  const ends: number[] = [];
  for (let i = 0; i < n; i++) if (river[i] && deg[i] <= 1) ends.push(i);
  ends.sort((a, b) => (elev[b] ?? 0) - (elev[a] ?? 0));
  for (const e of ends) if (!used[e]) course(e);
  // any remaining (loops)
  for (let i = 0; i < n; i++) if (river[i] && !used[i]) course(i);
  return out;
}
