// ============================================================================
// Which town a building belongs to — whose market its workshop trades in and its
// households shop in, whose builders and officials look after it — and the town
// districts (borders) that follow from it. See DESIGN §1.2.
//
// A hierarchy of rules:
//   1. Inside a town's built-up core (within its settlement radius + BELONG_CORE
//      tiles): that town, however the roads run (the nearer, if two cores overlap).
//      A workshop right by a town belongs to it even if its track first leads away.
//   2. Otherwise a score for every town, and the best wins:
//        BELONG_W_NEAR    × closeness     exp(−(d − radius)/BELONG_NEAR_TILES)
//      + BELONG_W_ROAD    × road link     exp(−days/BELONG_ROAD_DAYS), days of travel
//                                          from its door to the centre along the roads
//      + BELONG_W_WORKERS × its people    share of a workshop's workers living there
//                                          (a house: of its residents working there)
//      + BELONG_W_OWNER   × its owner     1 if the owner lives there (a firm owner: its town)
//      The town it belongs to now keeps BELONG_STICK in hand, so a building half-way
//      between two towns does not change sides every month.
// A bit further out, then, the connections decide: a site whose road runs to one town,
// whose workers live there and whose owner lives there becomes that town's.
//
// Monthly (townsStep): every town's settlement radius is measured again from its
// houses and town buildings, buildings are reassigned, and the districts are redrawn:
// a tile belongs to a town's core, else to the town of the nearest building within
// DISTRICT_BUILDING_REACH tiles, else to the nearest centre within DISTRICT_REACH —
// so borders grow outward with the buildings.
// ============================================================================
import {
  BELONG_CORE,
  BELONG_NEAR_TILES,
  BELONG_ROAD_DAYS,
  BELONG_STICK,
  BELONG_W_NEAR,
  BELONG_W_OWNER,
  BELONG_W_ROAD,
  BELONG_W_WORKERS,
  DISTRICT_BUILDING_REACH,
} from '../config';
import { isMonthStart } from '../calendar';
import { isFirm, isPerson, refId } from '../ledger';
import { expectedNetFor } from '../market/markets';
import { rt, touchBuildings } from '../runtime';
import { news } from '../stats/events';
import type { Building, Ref, SimState, TownId } from '../types';
import { SECTORS } from '../goods';
import { fin } from '../util';
import { DISTRICT_REACH, doorTile, updateTownRadius } from './layout';
import { tileMoveCost } from './paths';

const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];

// ---------------------------------------------------------------------------
// Travel days to each town centre (Dijkstra over the roads and open country)
// ---------------------------------------------------------------------------

interface ReachCache {
  key: string;
  days: Float64Array[]; // [town][tile] travel days to the town centre (Infinity: unreachable)
}

/** For every town, the travel days from each tile to its centre (cached until roads or towns change). */
export function townReach(s: SimState): Float64Array[] {
  const r = rt(s);
  const key = `${r.roadVersion}|${s.towns.map((t) => t.x + ',' + t.y).join(';')}|${s.map.w}x${s.map.h}`;
  let c = r.bag.townReach as ReachCache | undefined;
  if (c && c.key === key) return c.days;
  const m = s.map;
  const n = m.w * m.h;
  const cost = new Float64Array(n);
  for (let i = 0; i < n; i++) cost[i] = tileMoveCost(m, i);
  const days = s.towns.map((t) => dijkstra(m.w, m.h, cost, t.y * m.w + t.x));
  c = { key, days };
  r.bag.townReach = c;
  return days;
}

function dijkstra(w: number, h: number, cost: Float64Array, src: number): Float64Array {
  const n = w * h;
  const d = new Float64Array(n).fill(Infinity);
  const heapK: number[] = [];
  const heapV: number[] = [];
  const push = (k: number, v: number) => {
    heapK.push(k);
    heapV.push(v);
    let i = heapK.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapK[p] <= heapK[i]) break;
      [heapK[p], heapK[i]] = [heapK[i], heapK[p]];
      [heapV[p], heapV[i]] = [heapV[i], heapV[p]];
      i = p;
    }
  };
  const pop = (): number => {
    const top = heapV[0];
    const lk = heapK.pop()!;
    const lv = heapV.pop()!;
    if (heapK.length) {
      heapK[0] = lk;
      heapV[0] = lv;
      let i = 0;
      for (;;) {
        const a = 2 * i + 1;
        const b = a + 1;
        let m = i;
        if (a < heapK.length && heapK[a] < heapK[m]) m = a;
        if (b < heapK.length && heapK[b] < heapK[m]) m = b;
        if (m === i) break;
        [heapK[m], heapK[i]] = [heapK[i], heapK[m]];
        [heapV[m], heapV[i]] = [heapV[i], heapV[m]];
        i = m;
      }
    }
    return top;
  };
  if (!(src >= 0 && src < n)) return d;
  d[src] = 0;
  push(0, src);
  while (heapK.length) {
    const k = heapK[0];
    const cur = pop();
    if (k > d[cur]) continue;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    const cc = cost[cur] > 0 ? cost[cur] : 0.05; // the centre (market square) and other endpoints
    for (let j = 0; j < 8; j++) {
      const nx = cx + DX8[j];
      const ny = cy + DY8[j];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      const nc = cost[ni];
      if (!(nc > 0)) continue;
      const step = (j < 4 ? 1 : Math.SQRT2) * 0.5 * (cc + nc);
      const nd = d[cur] + step;
      if (nd < d[ni]) {
        d[ni] = nd;
        push(nd, ni);
      }
    }
  }
  return d;
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/** What is known about a (planned) building: its footprint, its door, and where its people and owner live. */
export interface Place {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The open tile its track starts from (-1: the footprint's first tile). */
  door: number;
  /** Share of its people in each town (length = towns), or null if it has none. */
  people: number[] | null;
  /** The town its owner lives in, or -1. */
  ownerTown: TownId;
  /** The town it belongs to now (kept by BELONG_STICK), or -1. */
  now: TownId;
}

/** The town inside whose built-up core (radius + BELONG_CORE) a footprint centre lies, or -1 (the nearer if two). */
export function coreTown(s: SimState, cx: number, cy: number): TownId {
  let best = -1;
  let bd = Infinity;
  for (const t of s.towns) {
    const d = Math.hypot(cx - t.x, cy - t.y);
    if (d <= Math.max(3, t.radius) + BELONG_CORE && d < bd) {
      bd = d;
      best = t.id;
    }
  }
  return best;
}

/** Each town's score for a place (rule 2 of the header), without the stickiness. */
export function belongScores(s: SimState, p: Place): number[] {
  const reach = townReach(s);
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  const at = p.door >= 0 ? p.door : p.y * s.map.w + p.x;
  return s.towns.map((t, k) => {
    const d = Math.hypot(cx - t.x, cy - t.y);
    const near = Math.exp(-Math.max(0, d - Math.max(3, t.radius)) / BELONG_NEAR_TILES);
    const days = reach[k]?.[at] ?? Infinity;
    const road = Number.isFinite(days) ? Math.exp(-days / BELONG_ROAD_DAYS) : 0;
    const people = p.people ? fin(p.people[k]) : 0;
    const owner = p.ownerTown === k ? 1 : 0;
    return BELONG_W_NEAR * near + BELONG_W_ROAD * road + BELONG_W_WORKERS * people + BELONG_W_OWNER * owner;
  });
}

/** The town a place belongs to by the hierarchy (core first, then the scores with stickiness). */
export function belongingOfPlace(s: SimState, p: Place): TownId {
  if (!s.towns.length) return -1;
  const core = coreTown(s, p.x + p.w / 2, p.y + p.h / 2);
  if (core >= 0) return core;
  const sc = belongScores(s, p);
  let best = 0;
  for (let k = 0; k < sc.length; k++) {
    const v = sc[k] + (k === p.now ? BELONG_STICK : 0);
    const b = sc[best] + (best === p.now ? BELONG_STICK : 0);
    if (v > b) best = k;
  }
  return best;
}

/** Where an owner lives: a person's town, a firm's town; -1 for the Treasury and others. */
export function ownerTown(s: SimState, owner: Ref): TownId {
  if (isPerson(owner)) return s.people[owner]?.alive ? s.people[owner].town : -1;
  if (isFirm(owner)) return s.firms[refId(owner)]?.town ?? -1;
  return -1;
}

/** A building as a Place: its people are a workshop's workers (their homes' towns) or a house's residents (their workplaces' towns). */
export function placeOf(s: SimState, b: Building): Place {
  const nT = s.towns.length;
  let people: number[] | null = null;
  const tally = (town: number) => {
    if (!(town >= 0 && town < nT)) return;
    if (!people) people = new Array(nT).fill(0);
    people[town]++;
  };
  if (b.kind === 'firm' && b.firm >= 0) {
    const f = s.firms[b.firm];
    if (f) for (const id of f.workers) tally(s.people[id]?.town ?? -1);
  } else if (b.kind === 'house') {
    for (const id of b.residents) {
      const j = s.people[id]?.job ?? -1;
      tally(j >= 0 ? (s.firms[j]?.town ?? -1) : -1);
    }
  }
  if (people) {
    const tot = (people as number[]).reduce((a, x) => a + x, 0);
    if (tot > 0) people = (people as number[]).map((x) => x / tot);
  }
  const owner = b.kind === 'firm' && b.firm >= 0 ? (s.firms[b.firm]?.owner ?? b.owner) : b.owner;
  return { x: b.x, y: b.y, w: b.w, h: b.h, door: doorTile(s, b), people, ownerTown: ownerTown(s, owner), now: b.town };
}

/** The town a building belongs to by the rules (it may differ from `b.town` until the month turns). */
export function belongingOf(s: SimState, b: Building): TownId {
  return belongingOfPlace(s, placeOf(s, b));
}

/** Why a building belongs where the rules put it, in a few words (for the inspector). */
export function belongingReason(s: SimState, b: Building): string {
  const pl = placeOf(s, b);
  const t = belongingOfPlace(s, pl);
  const tn = s.towns[t]?.name ?? 'its town';
  if (coreTown(s, b.x + b.w / 2, b.y + b.h / 2) === t) return `It stands within ${tn} itself.`;
  const sc = belongScores(s, pl);
  const k = t;
  const reach = townReach(s);
  const bits: string[] = [];
  const closest = s.towns.reduce((a, x) => (Math.hypot(b.x - x.x, b.y - x.y) < Math.hypot(b.x - a.x, b.y - a.y) ? x : a), s.towns[0]);
  if (closest.id === k) bits.push(`it is nearest ${tn}`);
  const at = pl.door >= 0 ? pl.door : b.y * s.map.w + b.x;
  const fastest = reach.reduce((a, d, i) => (d[at] < reach[a][at] ? i : a), 0);
  if (fastest === k && Number.isFinite(reach[k][at])) bits.push(`its road reaches ${tn} soonest (${reach[k][at].toFixed(2)} days)`);
  if (pl.people && pl.people[k] >= 0.5) bits.push(b.kind === 'house' ? `most who live here work in ${tn}` : `most of its workers live in ${tn}`);
  if (pl.ownerTown === k) bits.push(`its owner lives in ${tn}`);
  if (!bits.length) bits.push(`it scores best for ${tn} on distance, roads, people and owner together`);
  void sc;
  return `It belongs to ${tn}: ${bits.join('; ')}.`;
}

// ---------------------------------------------------------------------------
// Monthly
// ---------------------------------------------------------------------------

/** Move a building (and its workshop or its households) to another town. */
function moveBuilding(s: SimState, b: Building, to: TownId): void {
  b.town = to;
  const m = s.map;
  for (let yy = b.y; yy < b.y + b.h; yy++) for (let xx = b.x; xx < b.x + b.w; xx++) if (xx >= 0 && yy >= 0 && xx < m.w && yy < m.h) m.district[yy * m.w + xx] = to;
  if (b.kind === 'firm' && b.firm >= 0) {
    const f = s.firms[b.firm];
    if (f && f.alive) {
      f.town = to;
      // its price expectation starts from the new market's (and learns from there)
      const d = SECTORS[f.sector];
      if (d && d.producer) {
        const pe = fin(expectedNetFor(s, to, d.out, f.sector), f.pExp);
        if (pe > 0) f.pExp = 0.5 * f.pExp + 0.5 * pe;
      }
    }
  } else if (b.kind === 'house') {
    for (const id of b.residents) {
      const p = s.people[id];
      if (p && p.alive && p.home === b.id) p.town = to;
    }
  }
}

/**
 * Redraw the districts: a town's core (radius + BELONG_CORE), else the town of the nearest
 * standing building within DISTRICT_BUILDING_REACH steps, else the nearest centre within reach;
 * a building's footprint is always its own town's.
 */
export function redrawDistricts(s: SimState): void {
  const m = s.map;
  const w = m.w;
  const n = w * m.h;
  const out = new Array<number>(n).fill(-1);
  const dist = new Int32Array(n).fill(-1);
  const q: number[] = [];
  for (const b of s.buildings) {
    if (!b || b.status === 'ruin' || !(b.town >= 0)) continue;
    for (let yy = b.y; yy < b.y + b.h; yy++)
      for (let xx = b.x; xx < b.x + b.w; xx++) {
        if (xx < 0 || yy < 0 || xx >= w || yy >= m.h) continue;
        const i = yy * w + xx;
        if (dist[i] === 0) continue;
        dist[i] = 0;
        out[i] = b.town;
        q.push(i);
      }
  }
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    if (dist[cur] >= DISTRICT_BUILDING_REACH) continue;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (let j = 0; j < 8; j++) {
      const nx = cx + DX8[j];
      const ny = cy + DY8[j];
      if (nx < 0 || ny < 0 || nx >= w || ny >= m.h) continue;
      const ni = ny * w + nx;
      if (dist[ni] >= 0) continue;
      dist[ni] = dist[cur] + 1;
      out[ni] = out[cur];
      q.push(ni);
    }
  }
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dist[i] === 0) continue; // footprints: their own town
      const core = coreTown(s, x + 0.5, y + 0.5);
      if (core >= 0) {
        out[i] = core;
        continue;
      }
      if (out[i] >= 0) continue;
      let best = -1;
      let bd = Infinity;
      for (const t of s.towns) {
        const d = (t.x - x) * (t.x - x) + (t.y - y) * (t.y - y);
        const reach = Math.max(DISTRICT_REACH, t.radius + 12);
        if (d <= reach * reach && d < bd) {
          bd = d;
          best = t.id;
        }
      }
      out[i] = best;
    }
  for (let i = 0; i < n; i++) m.district[i] = out[i];
  rt(s).bag.districtVersion = ((rt(s).bag.districtVersion as number) ?? 0) + 1;
}

/**
 * Settle every building's town by the rules, quietly (no news): once the world is made, so the
 * realm starts consistent. Returns how many moved.
 */
export function settleTowns(s: SimState): number {
  if (!s.towns.length) return 0;
  for (const t of s.towns) updateTownRadius(s, t.id);
  let n = 0;
  for (const b of s.buildings) {
    if (!b || b.status === 'ruin' || (b.kind !== 'firm' && b.kind !== 'house')) continue;
    const to = belongingOf(s, b);
    if (to >= 0 && to !== b.town) {
      moveBuilding(s, b, to);
      n++;
    }
  }
  if (n) {
    touchBuildings(s);
    for (const t of s.towns) updateTownRadius(s, t.id);
  }
  redrawDistricts(s);
  return n;
}

/**
 * Monthly, at the turn of the month: settlement radii, every workshop's and house's town by
 * the rules, and the districts. A workshop that changes town trades in its new town's market
 * from the next day; a house's households shop there.
 */
export function townsStep(s: SimState): void {
  if (!isMonthStart(s.day) || !s.towns.length) return;
  for (const t of s.towns) updateTownRadius(s, t.id);
  const moved: { b: Building; from: TownId; to: TownId }[] = [];
  for (const b of s.buildings) {
    if (!b || b.status === 'ruin' || (b.kind !== 'firm' && b.kind !== 'house')) continue;
    const to = belongingOf(s, b);
    if (to >= 0 && to !== b.town) {
      moved.push({ b, from: b.town, to });
      moveBuilding(s, b, to);
    }
  }
  if (moved.length) {
    touchBuildings(s);
    for (const t of s.towns) updateTownRadius(s, t.id);
    const acc = s.stats.acc;
    acc.belong_moves = (acc.belong_moves || 0) + moved.length;
    const shops = moved.filter((x) => x.b.kind === 'firm' && x.b.firm >= 0);
    for (const x of shops.slice(0, 3)) {
      const f = s.firms[x.b.firm];
      if (f) news(s, `${f.name} now counts as part of ${s.towns[x.to].name} rather than ${s.towns[x.from]?.name ?? 'the wilds'}: it sells in ${s.towns[x.to].name}’s market.`, 'info', x.to);
    }
  }
  redrawDistricts(s);
}
