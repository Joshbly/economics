// ============================================================================
// Where a private venture goes: a site chosen on its merits. OWNER: firms agent.
// See DESIGN §3.2 (Entry & expansion).
//
// A workshop that works a natural resource (farm, fishery, lumber camp, mine,
// well) looks at every free site of the right ground within VENTURE_REACH of its
// town's centre and values each one a year ahead, at today's prices and wages:
//
//   value = output at the site × (net price − materials − tool cost)   the ground
//         − hands × wage × COMMUTE_COST_PER_TILE × tiles beyond the town   the walk
//         − track to the road × (rate + 1/TRACK_LIFE_YEARS)                the road
//         − the plot, within a town's core, × rate                        the land
//
// Output follows the site's richness (0.6 + 0.8 · quality, as in production); its
// workers walk from the town, and it must pay them for the walk to hire them; the
// dirt track from its door to the nearest road is part of the works and is paid for
// like the building (clearing forest, hills and marsh costs more; rivers need a
// bridge). The best site wins, with a little of the investor's judgement in it (a
// jitter of a few per cent). Only sites that would count as the town's own by the
// rules of world/belonging.ts are looked at: a fishery on the shore next to another
// town would be that town's, trading in its market.
//
// `rel` compares the site with an average one close to town without a track: the
// return an investor expects scales with it (a rich seam near a road beats the
// trade's average; a thin one far off does worse) — and the venture is only worth
// it if that return still beats the hurdle.
// Town trades (bakeries, workshops, …) keep the sites near the centre (layout.findSite).
// The plot of a site within a town's core is bought from its council (agents/council.ts:
// dearer the nearer the centre and the more crowded the town); land beyond is free — land
// does not wear out, so a plot costs the interest on its price a year.
// ============================================================================
import { COMMUTE_COST_PER_TILE, ENTRY_SCREEN_SPREAD, TRACK_CLEAR_FACTOR, TRACK_LIFE_YEARS, VENTURE_REACH } from '../config';
import { G, SECTORS, BRIDGE_TILE_COST, TRACK_TILE_COST } from '../goods';
import { expectedGrossFor, expectedNetFor } from '../market/markets';
import { employerWageCost } from '../policy/levies';
import { rt } from '../runtime';
import { Terrain, type Ref, type Sector, type SimState, type TownId } from '../types';
import { fin } from '../util';
import { belongingOfPlace, ownerTown } from '../world/belonging';
import { accessTrack, doorTile, findSite, isResourceSector, siteFits, siteQuality } from '../world/layout';
import { hash2 } from '../world/mapgen';
import { needCost, roadNeed } from './construction';
import { plotPrice } from './council';
import { defaultWage } from './firms';
import { materialCostPerUnit, potentialOutput, toolCostPerUnit } from './production';

export interface VentureSite {
  x: number;
  y: number;
  /** The dirt track the works include (tiles, door to road). */
  access: number[];
  /** Its cost at today's prices. */
  accessCost: number;
  /** The plot's price (the council's land within a town's core; 0 beyond). */
  land: number;
  /** Productivity multiplier of the site (0.6 + 0.8 · quality). */
  richness: number;
  /** Tiles its workers walk beyond the town. */
  walk: number;
  /** The site's value a year (¤). */
  value: number;
  /** Value against an average site close to town (0.3 … 2). */
  rel: number;
}

const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];

/**
 * Clearing work from every tile to the nearest road, in grass-tile units (TRACK_CLEAR_FACTOR of
 * each tile crossed; a river tile counts as a bridge): cached until roads or buildings change.
 */
function accessField(s: SimState): Float64Array {
  const r = rt(s);
  const key = `${r.roadVersion}|${r.buildingVersion}`;
  const c = r.bag.accessField as { key: string; f: Float64Array } | undefined;
  if (c && c.key === key) return c.f;
  const m = s.map;
  const w = m.w;
  const n = w * m.h;
  const bridge = BRIDGE_TILE_COST.labor / Math.max(1e-9, TRACK_TILE_COST.labor);
  const cost = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = m.terrain[i];
    if (t === Terrain.Water || t === Terrain.DeepWater || m.occ[i] >= 0) cost[i] = -1;
    else if (m.river[i] && m.road[i] < 1) cost[i] = bridge;
    else cost[i] = TRACK_CLEAR_FACTOR[t] ?? 1;
  }
  const f = new Float64Array(n).fill(Infinity);
  // Dijkstra from every road tile (4-neighbour, like a track is laid)
  const hk: number[] = [];
  const hv: number[] = [];
  const push = (k: number, v: number) => {
    hk.push(k);
    hv.push(v);
    let i = hk.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= hk[i]) break;
      [hk[p], hk[i]] = [hk[i], hk[p]];
      [hv[p], hv[i]] = [hv[i], hv[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = hv[0];
    const lk = hk.pop()!;
    const lv = hv.pop()!;
    if (hk.length) {
      hk[0] = lk;
      hv[0] = lv;
      let i = 0;
      for (;;) {
        const a = 2 * i + 1;
        const b = a + 1;
        let mm = i;
        if (a < hk.length && hk[a] < hk[mm]) mm = a;
        if (b < hk.length && hk[b] < hk[mm]) mm = b;
        if (mm === i) break;
        [hk[mm], hk[i]] = [hk[i], hk[mm]];
        [hv[mm], hv[i]] = [hv[i], hv[mm]];
        i = mm;
      }
    }
    return top;
  };
  for (let i = 0; i < n; i++)
    if (m.road[i] >= 1) {
      f[i] = 0;
      push(0, i);
    }
  while (hk.length) {
    const k = hk[0];
    const cur = pop();
    if (k > f[cur]) continue;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (let j = 0; j < 4; j++) {
      const nx = cx + DX8[j];
      const ny = cy + DY8[j];
      if (nx < 0 || ny < 0 || nx >= w || ny >= m.h) continue;
      const ni = ny * w + nx;
      if (!(cost[ni] > 0)) continue;
      const nd = f[cur] + cost[ni];
      if (nd < f[ni]) {
        f[ni] = nd;
        push(nd, ni);
      }
    }
  }
  r.bag.accessField = { key, f };
  return f;
}

/** The yearly margin of an average site of the trade at typical size, and what it takes to run it. */
function tradeTerms(s: SimState, sector: Sector, town: TownId): { q0: number; margin: number; hands: number; wage: number; rate: number } | null {
  const d = SECTORS[sector];
  if (!d || !d.producer) return null;
  const hands = Math.max(1, Math.min(d.capacityPerLevel, d.typicalSize));
  const leff = hands * 0.95;
  const q0 = potentialOutput(sector, leff, d.toolsPerWorker * leff, 1, 1);
  if (!(q0 > 0)) return null;
  const prices: number[] = [];
  for (let g = 0; g < 11; g++) prices.push(fin(expectedGrossFor(s, town, g, sector), 1));
  const pNet = fin(expectedNetFor(s, town, d.out, sector), 0);
  const rate = fin(s.bank.baseRate, 0.045) + ENTRY_SCREEN_SPREAD;
  let margin = pNet - materialCostPerUnit(sector, prices) - toolCostPerUnit(sector, prices[G.tools], q0 / hands, rate);
  // (even a trade that loses money today ranks its sites by what they would yield)
  if (!(margin > 0.05 * pNet)) margin = 0.05 * Math.max(pNet, 0.01);
  const wage = employerWageCost(s, town, sector, defaultWage(s, town));
  return { q0, margin, hands, wage, rate };
}

/**
 * The site a venture of `sector` for `town` would choose (see the header), or null if none.
 * `owner` (optional) is who would own it: where they live counts toward belonging.
 */
export function ventureSite(s: SimState, sector: Sector, town: TownId, owner: Ref = -1): VentureSite | null {
  const t = s.towns[town];
  const d = SECTORS[sector];
  if (!t || !d) return null;
  const [fw, fh] = d.footprint;
  if (!isResourceSector(sector)) {
    let xy: { x: number; y: number } | null = null;
    try {
      xy = findSite(s, sector, town);
    } catch {
      xy = null;
    }
    if (!xy) return null;
    const access = accessTrack(s, { x: xy.x, y: xy.y, w: fw, h: fh, town });
    const land = plotPrice(s, xy.x, xy.y, fw, fh).price;
    return { x: xy.x, y: xy.y, access, accessCost: access.length ? needCost(s, town, roadNeed(s, access, 1)) : 0, land, richness: 1, walk: 0, value: 0, rel: 1 };
  }
  const terms = tradeTerms(s, sector, town);
  if (!terms) return null;
  const { q0, margin, hands, wage, rate } = terms;
  const m = s.map;
  const field = accessField(s);
  const unitTrack = needCost(s, town, TRACK_TILE_COST);
  const crf = Math.max(0.02, rate + 1 / TRACK_LIFE_YEARS);
  const walkCost = hands * wage * COMMUTE_COST_PER_TILE * 360;
  const ownT = owner !== -1 ? ownerTown(s, owner) : town;
  const people = s.towns.map((_, k) => (k === town ? 1 : 0));
  const radius = Math.max(3, t.radius);
  const R = VENTURE_REACH;
  let best: VentureSite | null = null;
  for (let y = Math.max(1, Math.floor(t.y - R)); y <= Math.min(m.h - 2, Math.ceil(t.y + R)); y++) {
    for (let x = Math.max(1, Math.floor(t.x - R)); x <= Math.min(m.w - 2, Math.ceil(t.x + R)); x++) {
      const cx = x + fw / 2;
      const cy = y + fh / 2;
      const dist = Math.hypot(cx - t.x, cy - t.y);
      if (dist > R) continue;
      if (sector === 'farm' && dist < radius + 1.5) continue; // fields lie outside the town
      if (!siteFits(s, sector, x, y)) continue;
      const door = doorTile(s, { x, y, w: fw, h: fh, town });
      if (door < 0) continue;
      const units = field[door];
      if (!Number.isFinite(units)) continue;
      if (belongingOfPlace(s, { x, y, w: fw, h: fh, door, people, ownerTown: ownT >= 0 ? ownT : town, now: -1 }) !== town) continue;
      const richness = 0.6 + 0.8 * siteQuality(m, sector, x, y, fw, fh);
      const walk = Math.max(0, dist - radius);
      const accessCost = units * unitTrack;
      const land = plotPrice(s, x, y, fw, fh).price;
      let value = q0 * richness * margin * 360 - walkCost * walk - accessCost * crf - land * Math.max(0.01, rate);
      // a little of the investor's own judgement
      value += 0.04 * Math.abs(value) * (hash2(s.seed ^ (s.day * 7919), x, y) - 0.5);
      if (!best || value > best.value) best = { x, y, access: [], accessCost, land, richness, walk, value, rel: 1 };
    }
  }
  if (!best) return null;
  best.access = accessTrack(s, { x: best.x, y: best.y, w: fw, h: fh, town });
  best.accessCost = best.access.length ? needCost(s, town, roadNeed(s, best.access, 1)) : 0;
  const ref = q0 * margin * 360 - walkCost * 3;
  best.rel = ref > 0 ? Math.min(2, Math.max(0.3, (best.value + best.accessCost * crf + best.land * Math.max(0.01, rate)) / ref)) : 1;
  return best;
}
