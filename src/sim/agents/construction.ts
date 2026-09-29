// ============================================================================
// Builders' yards and construction projects. OWNER: firms agent. See DESIGN §3.3.
//
// A project needs labour-days, wood, iron and tools (goods.ts: buildCost,
// expandCost, HOUSE_COST, PIER_COST, ROAD_TILE_COST per tile). The town's
// builder works on up to MAX_ACTIVE_PROJECTS projects in queue order, putting its
// crew on the first until materials or the work run out, then the next. Labour
// may run at most LABOR_AHEAD_MAX ahead of the least-supplied material, so a
// shortage of iron or wood in the town's market halts building sites — private
// and Treasury projects compete for the same crews and the same materials, which
// is how crowding out appears.
//
// Billing: every day the owner is billed (labour at the builder's cost per
// labour-day + materials used at today's prices) × BUILD_MARGIN. Private owners
// advance their money (equity and any loan proceeds) to the builder when the
// project is financed; bills are drawn from that advance first (project.prepaid,
// a liability of the builder), then from the owner's own cash. The Treasury pays
// its bills from the Purse as they come; Treasury workers in the town add their
// labour to Treasury projects for free (the Treasury pays them directly). An owner
// who cannot pay stops the work (stalled); STALL_CANCEL_DAYS without progress
// cancels the project.
//
// Completion activates the building: a new or reopened firm (owner = project
// owner; the start-up loan passes to the firm; any unspent advance becomes its
// working capital), a house (HOUSE_SLOTS slots at the town's going rent), a pier
// (more foreign ship capacity), a larger building, or paved road tiles (paved
// progressively as the work advances).
// ============================================================================
import {
  BASE_RENT_SHARE,
  BUILD_MARGIN,
  BUILD_TARGET_DAYS,
  BUILDER_BID_CLOSE,
  BUILDER_BID_RUNGS,
  BUILDER_BID_WEIGHTS,
  BUILDER_BLOCKED_SHARE,
  BUILDER_MAX_BID_MULT,
  BUILDER_STOCK_SHARE,
  BUILDER_TOOLLESS_HANDS,
  CASH_TARGET_DAYS,
  LABOR_AHEAD_MAX,
  MAX_ACTIVE_PROJECTS,
  STATE_PARALLEL_MAX,
  NEW_FIRM_WC_DAYS,
  PROJECT_KEEP_DONE,
  REOPEN_COST_SHARE,
  ROAD_INVALIDATE_TILES,
  STALL_CANCEL_DAYS,
  STATEWORKS_BUILD_EFF,
  AUTO_CREW_DAYS,
  TARGET_HYSTERESIS,
  TARGET_SMOOTH,
  TOOLS_BUFFER_DAYS,
  TOOLS_IDLE_WEAR_DAY,
  TRACK_CLEAR_FACTOR,
  WAGE_RESERVE_DAYS,
} from '../config';
import { newProject as newProjectRecord } from '../factory';
import { BRIDGE_TILE_COST, G, HOUSE_COST, HOUSE_SLOTS, PIER_COST, ROAD_TILE_COST, SECTORS, TRACK_TILE_COST } from '../goods';
import { cashOf, firmRef, isFirm, isPerson, pay, refId, refName, repayPrincipal, writeOff } from '../ledger';
import { addBid, bookFor, type Books } from '../market/markets';
import { wageLevyRates } from '../policy/levies';
import { lineCrewIn } from '../policy/lines';
import { invalidateRoutes, rt, touchBuildings } from '../runtime';
import { news } from '../stats/events';
import type { Building, Firm, MapData, Materials, Project, ProjectKind, Ref, Sector, SimState, TownId } from '../types';
import { STATE, Terrain } from '../types';
import { clamp, fin, shareOut } from '../util';
import { findSite, isValidSite, placeBuilding, removeBuilding } from '../world/layout';
import { createFirm, defaultWage, fairPrice, firmDailyCost, noteFirmCosts, noteShortfall, strikeFactor, townGrossPrices, typicalDailyCost, workforceEff } from './firms';
import { hasLevyBase } from './labor';
import { materialsValue, toolFactor } from './production';
import { FLOW_USED, noteFlow } from '../stats/flows';

export interface ProjectSpec {
  kind: ProjectKind;
  town: TownId;
  owner: Ref;
  sector?: Sector; // firm / reopen
  x?: number; // site (firm/house/pier); found automatically if omitted
  y?: number;
  building?: number; // expand / reopen target building
  tiles?: number[]; // road tiles
  /** Road: 1 = a dirt track, 2 = paving (the default). */
  grade?: 1 | 2;
  loan?: number;
  label?: string;
}

type MatKey = 'wood' | 'iron' | 'tools';
const MATS: MatKey[] = ['wood', 'iron', 'tools'];
const MAT_GOOD: Record<MatKey, number> = { wood: G.wood, iron: G.iron, tools: G.tools };
const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scaleM(m: Materials, k: number): Materials {
  return { labor: m.labor * k, wood: m.wood * k, iron: m.iron * k, tools: m.tools * k };
}

/** Materials a project of this kind needs. */
export function projectNeed(kind: ProjectKind, sector: Sector | '' | undefined, tiles: number): Materials {
  const d = sector ? SECTORS[sector] : undefined;
  switch (kind) {
    case 'firm':
      return d ? { ...d.buildCost } : scaleM(HOUSE_COST, 1);
    case 'reopen':
      return d ? scaleM(d.buildCost, REOPEN_COST_SHARE) : scaleM(HOUSE_COST, REOPEN_COST_SHARE);
    case 'expand':
      return d ? { ...d.expandCost } : scaleM(HOUSE_COST, 0.5);
    case 'house':
      return { ...HOUSE_COST };
    case 'pier':
      return { ...PIER_COST };
    case 'road':
      return scaleM(ROAD_TILE_COST, Math.max(0, tiles));
    default:
      return { labor: 0, wood: 0, iron: 0, tools: 0 };
  }
}

/**
 * Materials to bring one tile up to `grade` (1 a dirt track, 2 paving): new ground is cleared
 * for a track first (TRACK_TILE_COST × TRACK_CLEAR_FACTOR of its terrain; a river tile takes a
 * timber bridge, BRIDGE_TILE_COST), and paving adds ROAD_TILE_COST. Nothing for a tile already
 * at that grade or better; open water cannot take a road.
 */
export function roadTileNeed(m: MapData, i: number, grade: 1 | 2): Materials {
  const out = { labor: 0, wood: 0, iron: 0, tools: 0 };
  const r = m.road[i] ?? 0;
  if (r >= grade || !(i >= 0 && i < m.road.length)) return out;
  const t = m.terrain[i];
  if (t === Terrain.Water || t === Terrain.DeepWater) return out;
  const add = (x: Materials, k: number) => {
    out.labor += x.labor * k;
    out.wood += x.wood * k;
    out.iron += x.iron * k;
    out.tools += x.tools * k;
  };
  if (r < 1) {
    if (m.river[i]) add(BRIDGE_TILE_COST, 1);
    else add(TRACK_TILE_COST, TRACK_CLEAR_FACTOR[t] ?? 1);
  }
  if (grade >= 2) add(ROAD_TILE_COST, 1);
  return out;
}

/** Materials for a road along `tiles` at `grade` (the sum of roadTileNeed). */
export function roadNeed(s: SimState, tiles: readonly number[], grade: 1 | 2): Materials {
  const out = { labor: 0, wood: 0, iron: 0, tools: 0 };
  for (const i of tiles) {
    const x = roadTileNeed(s.map, i, grade);
    out.labor += x.labor;
    out.wood += x.wood;
    out.iron += x.iron;
    out.tools += x.tools;
  }
  return out;
}

function isBuilder(f: Firm | undefined): f is Firm {
  return !!f && f.alive && f.status === 'active' && f.sector === 'builder' && !!f.build;
}

/** The builder that takes new work in a town: the active builders' yard with the shortest queue. */
export function builderFor(s: SimState, town: TownId): Firm | null {
  let best: Firm | null = null;
  for (const f of s.firms) {
    if (!isBuilder(f) || f.town !== town) continue;
    if (f.building >= 0 && s.buildings[f.building] && s.buildings[f.building].status !== 'active') continue;
    if (!best || f.build!.queue.length < best.build!.queue.length) best = f;
  }
  return best;
}

function projectById(s: SimState, id: number): Project | undefined {
  for (const p of s.projects) if (p.id === id) return p;
  return undefined;
}

function finished(p: Project): boolean {
  return p.status === 'done' || p.status === 'cancelled';
}

/** Share of a project's work done (labour), 0..1. */
export function projectProgress(p: Project): number {
  if (p.status === 'done') return 1;
  return p.need.labor > 0 ? clamp(p.done.labor / p.need.labor, 0, 1) : 0;
}

/** Drop finished / missing projects from a builder's queue. */
function cleanQueue(s: SimState, b: Firm): void {
  const q = b.build!.queue;
  let k = 0;
  for (let i = 0; i < q.length; i++) {
    const p = projectById(s, q[i]);
    if (p && !finished(p) && p.builder === b.id) q[k++] = q[i];
  }
  q.length = k;
}

/** Projects the builder can work on now: queue order, financed, at most `max`. */
function eligible(s: SimState, b: Firm, max: number): Project[] {
  const out: Project[] = [];
  for (const id of b.build!.queue) {
    if (out.length >= max) break;
    const p = projectById(s, id);
    if (!p || finished(p) || fin(p.loanWanted) > 0) continue;
    out.push(p);
  }
  return out;
}

/**
 * What a builder works on today: its first MAX_ACTIVE_PROJECTS financed projects (`slots`: its own
 * hands work only on these) and — when the town has Treasury workers (`crewed`) — the Treasury's
 * other financed projects in its queue as well, up to STATE_PARALLEL_MAX in all: Treasury crews
 * work on every Treasury project in their town at once.
 */
function workList(s: SimState, b: Firm, crewed: boolean): { list: Project[]; slots: number } {
  const list = eligible(s, b, MAX_ACTIVE_PROJECTS);
  const slots = list.length;
  if (!crewed || list.length >= STATE_PARALLEL_MAX) return { list, slots };
  const seen = new Set(list.map((p) => p.id));
  for (const id of b.build!.queue) {
    if (list.length >= STATE_PARALLEL_MAX) break;
    if (seen.has(id)) continue;
    const p = projectById(s, id);
    if (!p || p.owner !== STATE || finished(p) || fin(p.loanWanted) > 0) continue;
    list.push(p);
  }
  return { list, slots };
}

/** Labour a project could take today: what remains, no further ahead of its materials on hand than LABOR_AHEAD_MAX. */
function usableLabor(p: Project, inv: number[]): number {
  const need = p.need.labor;
  if (!(need > EPS)) return 0;
  const rem = Math.max(0, need - p.done.labor);
  const capL = Math.max(0, Math.min(1, materialReach(p, inv) + LABOR_AHEAD_MAX) * need - p.done.labor);
  return Math.min(rem, capL);
}

export { shareOut } from '../util';

/**
 * Today's Treasury labour for each Treasury project (project id → labour-days): each town's
 * Treasury labour shared equally among all its Treasury projects under way (workList), each
 * taking no more than it can use today (usableLabor); what one site cannot use goes to the others.
 */
function stateShares(s: SimState, sw: Float64Array): Map<number, number> {
  const out = new Map<number, number>();
  const byTown = new Map<number, { ids: number[]; caps: number[] }>();
  for (const b of s.firms) {
    if (!isBuilder(b)) continue;
    if (b.building >= 0 && s.buildings[b.building] && s.buildings[b.building].status !== 'active') continue;
    const t = b.town;
    if (!(t >= 0 && t < sw.length) || !(sw[t] > EPS)) continue;
    let e = byTown.get(t);
    if (!e) byTown.set(t, (e = { ids: [], caps: [] }));
    for (const p of workList(s, b, true).list) {
      if (p.owner !== STATE) continue;
      e.ids.push(p.id);
      e.caps.push(usableLabor(p, b.inv));
    }
  }
  for (const [t, e] of byTown) {
    const got = shareOut(sw[t], e.caps);
    e.ids.forEach((id, i) => out.set(id, got[i]));
  }
  return out;
}

/** Least-supplied material fraction a project could reach with the builder's stock. */
function materialReach(p: Project, inv: number[]): number {
  let f = 1;
  for (const m of MATS) {
    const need = p.need[m];
    if (!(need > EPS)) continue;
    f = Math.min(f, (p.done[m] + Math.max(0, inv[MAT_GOOD[m]])) / need);
  }
  return f;
}

/** Builder's cost of one effective labour-day (wages incl. employer levies, per unit of labour its crew delivers). */
function laborDayCost(s: SimState, b: Firm, laborToday: number): number {
  let w = Math.max(0, fin(b.wage));
  if (hasLevyBase(s, 'wage')) {
    const r = wageLevyRates(s, b.town, b.sector, w);
    w = Math.max(0, fin(w * (1 + r.employerPct) + r.employerUnit, w));
  }
  const n = b.workers.length;
  if (n > 0 && laborToday > EPS) return (n * w) / laborToday;
  return w / 0.9;
}

/** What the owner can pay today (¤): the advance plus spare cash. */
function billingCapacity(s: SimState, p: Project): number {
  const pre = Math.max(0, fin(p.prepaid));
  const o = p.owner;
  if (o === STATE) return pre + cashOf(s, STATE);
  if (isPerson(o)) {
    const q = s.people[o];
    if (!q || !q.alive) return pre;
    const keep = 10 * Math.max(fin(q.income), 1);
    return pre + Math.max(0, q.cash - keep);
  }
  if (isFirm(o)) {
    const f = s.firms[refId(o)];
    if (!f || !f.alive) return pre;
    const keep = WAGE_RESERVE_DAYS * f.workers.length * Math.max(0, fin(f.wage));
    return pre + Math.max(0, f.cash - keep);
  }
  return pre;
}

function townName(s: SimState, t: TownId): string {
  return s.towns[t]?.name ?? 'the town';
}

function bump(s: SimState, key: string, v = 1): void {
  if (!v || !Number.isFinite(v)) return;
  const acc = s.stats.acc;
  acc[key] = (acc[key] || 0) + v;
}

/** Treasury labour (effective labour-days) available for construction today, per town, and the headcount behind it. */
function stateLabor(s: SimState): { labor: Float64Array; heads: Float64Array } {
  const n = s.towns.length;
  const labor = new Float64Array(n);
  const heads = new Float64Array(n);
  for (const f of s.firms) {
    if (!f || !f.alive || f.status !== 'active' || f.sector !== 'stateworks' || f.workers.length === 0) continue;
    if (f.town < 0 || f.town >= n) continue;
    // Workers driving the Treasury's freight lines are not on the building sites.
    const drivers = s.policy.lines?.length ? Math.min(f.workers.length, lineCrewIn(s, f.town)) : 0;
    const share = (f.workers.length - drivers) / f.workers.length;
    labor[f.town] += workforceEff(s, f) * share * STATEWORKS_BUILD_EFF * strikeFactor(s, f.town);
    heads[f.town] += f.workers.length - drivers;
  }
  return { labor, heads };
}

/**
 * People the Treasury's building projects in `town` can use: enough to put in each unfinished
 * project's remaining labour in about AUTO_CREW_DAYS, counting every financed, unstalled Treasury
 * project the town's crews can work on at once (workList: up to STATE_PARALLEL_MAX a builder).
 * Materials still to arrive may leave some of them idle for a while. 0 when there is nothing to build.
 */
export function treasuryCrewWanted(s: SimState, town: TownId): number {
  let perDay = 0;
  for (const b of s.firms) {
    if (!isBuilder(b) || b.town !== town || !b.build) continue;
    for (const p of workList(s, b, true).list) {
      if (p.owner !== STATE || p.status === 'stalled') continue;
      const rem = Math.max(0, fin(p.need.labor) - fin(p.done.labor));
      if (!(rem > EPS)) continue;
      // Labour cannot run more than LABOR_AHEAD_MAX ahead of the materials on hand: while they
      // are short, hire only for the work they allow (plus a little, for what is arriving).
      const reach = materialReach(p, b.inv);
      const capL = Math.max(0, Math.min(1, reach + LABOR_AHEAD_MAX) * fin(p.need.labor) - fin(p.done.labor));
      const pace = Math.max(rem / AUTO_CREW_DAYS, Math.min(rem, 1));
      perDay += Math.min(pace, Math.max(capL, Math.min(pace, 1)));
    }
  }
  return perDay > EPS ? Math.ceil(perDay / STATEWORKS_BUILD_EFF - 1e-9) : 0;
}

// ---------------------------------------------------------------------------
// Workforce plan
// ---------------------------------------------------------------------------

/**
 * Morning: each builder's target workforce = remaining labour of its active
 * projects / BUILD_TARGET_DAYS (capped by capacity; ≥ 0).
 * Treasury projects count net of the share the town's Treasury crews will cover (they work on
 * all its Treasury projects at once), and a project waiting for materials counts only
 * BUILDER_BLOCKED_SHARE of its labour.
 */
export function constructionPlan(s: SimState): void {
  const sw = stateLabor(s).labor;
  for (const b of s.firms) {
    if (!isBuilder(b)) continue;
    cleanQueue(s, b);
    const active = eligible(s, b, MAX_ACTIVE_PROJECTS);
    let rem = 0;
    // The Treasury crews share their labour among all the town's Treasury projects at once: the
    // share of each Treasury project's remaining labour they will cover over BUILD_TARGET_DAYS.
    const swDays = b.town >= 0 && b.town < sw.length ? sw[b.town] * BUILD_TARGET_DAYS : 0;
    let cover = 0;
    if (swDays > EPS) {
      let stateRem = 0;
      for (const p of workList(s, b, true).list) if (p.owner === STATE) stateRem += Math.max(0, p.need.labor - p.done.labor);
      cover = stateRem > EPS ? Math.min(1, swDays / stateRem) : 0;
    }
    const prices = active.length ? townGrossPrices(s, b.town) : undefined;
    const wDay = Math.max(0, fin(b.wage)) / 0.9;
    for (const p of active) {
      let r = Math.max(0, p.need.labor - p.done.labor);
      if (!(r > EPS)) continue;
      if (p.owner === STATE && cover > 0) r -= r * cover;
      const fl = p.need.labor > 0 ? p.done.labor / p.need.labor : 1;
      const blocked = materialReach(p, b.inv) < fl + 0.5 * LABOR_AHEAD_MAX;
      // Only the work its owner can pay for keeps a crew busy.
      if (prices) {
        const left = {
          labor: Math.max(0, p.need.labor - p.done.labor),
          wood: Math.max(0, p.need.wood - p.done.wood),
          iron: Math.max(0, p.need.iron - p.done.iron),
          tools: Math.max(0, p.need.tools - p.done.tools),
        };
        const value = materialsValue(left, prices, wDay, BUILD_MARGIN);
        if (value > EPS) r *= clamp(billingCapacity(s, p) / value, 0, 1);
      }
      rem += blocked ? r * BUILDER_BLOCKED_SHARE : r;
    }
    const nW = b.workers.length;
    const eff = nW > 0 ? clamp(workforceEff(s, b) / nW, 0.3, 3) : 0.95;
    const cap = Math.max(0, b.capacity);
    let raw = rem / BUILD_TARGET_DAYS / eff;
    if (rem > EPS && raw < 1) raw = 1;
    // No more hands than the crew has tools for (plus a few): toolless labour costs the
    // owners about three times as much. The builder bids for the tools it lacks.
    const tpw = SECTORS.builder.toolsPerWorker;
    if (tpw > 0) {
      const equip = (Math.max(0, fin(b.tools)) + Math.max(0, b.inv[G.tools] - projectToolsSoon(active))) / (0.95 * tpw);
      raw = Math.min(raw, equip + BUILDER_TOOLLESS_HANDS);
    }
    raw = clamp(fin(raw), 0, cap);
    const cur = clamp(fin(b.target), 0, cap);
    let next = cur;
    if (Math.abs(raw - cur) > TARGET_HYSTERESIS * cur + 0.1) next = cur + TARGET_SMOOTH * (raw - cur);
    if (raw <= 0 && next < 0.3) next = 0;
    b.target = clamp(fin(next), 0, cap);
  }
}

// ---------------------------------------------------------------------------
// Daily progress
// ---------------------------------------------------------------------------

interface Step {
  builderLabor: number;
  stateLabor: number;
  matValue: number;
}
const STEP: Step = { builderLabor: 0, stateLabor: 0, matValue: 0 };

/** Builders move tools beyond what their projects still need into their own equipment. */
function equipBuilder(s: SimState, b: Firm, active: Project[]): void {
  const d = SECTORS.builder;
  const n = Math.max(b.workers.length, fin(b.target));
  const want = d.toolsPerWorker * n * 0.95 + TOOLS_BUFFER_DAYS * d.toolUse * n;
  const gap = want - Math.max(0, fin(b.tools));
  if (!(gap > EPS)) return;
  // The crew's own tools come first (a crew without tools does a third of the work for the
  // same wages, and the owners pay for it); stock is held back only for the tools the
  // active projects will build in over their next stretch of work.
  const spare = Math.max(0, b.inv[G.tools] - projectToolsSoon(active));
  const take = Math.min(gap, spare);
  if (take > EPS) {
    b.inv[G.tools] -= take;
    b.tools = Math.max(0, fin(b.tools)) + take;
  }
}

/** Tools the active projects will build in over their next LABOR_AHEAD_MAX of progress. */
function projectToolsSoon(active: Project[]): number {
  let r = 0;
  for (const p of active) {
    const need = p.need.tools;
    if (!(need > EPS)) continue;
    const fl = p.need.labor > EPS ? clamp(p.done.labor / p.need.labor, 0, 1) : 1;
    r += clamp(need * Math.min(1, fl + LABOR_AHEAD_MAX) - p.done.tools, 0, Math.max(0, need - p.done.tools));
  }
  return r;
}

/** Build the first `frac` of a road project's tiles (to its grade); recompute routes every few tiles. */
function pave(s: SimState, p: Project, frac: number): void {
  const map = s.map;
  const n = p.tiles.length;
  const grade = p.grade === 1 ? 1 : 2;
  const upto = frac >= 1 - EPS ? n : Math.floor(clamp(frac, 0, 1) * n);
  let newly = 0;
  for (let i = 0; i < upto; i++) {
    const t = p.tiles[i];
    if (t >= 0 && t < map.road.length && map.road[t] < grade && map.occ[t] < 0) {
      map.road[t] = grade;
      newly++;
    }
  }
  if (!newly && upto < n) return;
  const bag = rt(s).bag;
  let pend = bag.roadPending as Record<number, number> | undefined;
  if (!pend) bag.roadPending = pend = {};
  const c = (pend[p.id] || 0) + newly;
  if (c >= ROAD_INVALIDATE_TILES || upto >= n) {
    if (c > 0 || upto >= n) invalidateRoutes(s);
    delete pend[p.id];
  } else pend[p.id] = c;
}

/** Advance one project with the labour on offer; bill the owner. */
function advance(s: SimState, b: Firm, p: Project, labor: number, swAvail: number, costLD: number, prices: number[]): Step {
  const st = STEP;
  st.builderLabor = 0;
  st.stateLabor = 0;
  st.matValue = 0;
  const need = p.need;
  const done = p.done;
  const remL = Math.max(0, need.labor - done.labor);
  let dSw = 0;
  let dB = 0;
  if (need.labor > EPS) {
    const reach = materialReach(p, b.inv);
    const capL = Math.max(0, Math.min(1, reach + LABOR_AHEAD_MAX) * need.labor - done.labor);
    dSw = p.owner === STATE ? Math.max(0, Math.min(swAvail, remL, capL)) : 0;
    dB = Math.max(0, Math.min(labor, remL - dSw, capL - dSw));
  }
  // Materials keep pace with the labour fraction (and catch up when they arrive late).
  const fl = need.labor > EPS ? Math.min(1, (done.labor + dSw + dB) / need.labor) : 1;
  const draw = { wood: 0, iron: 0, tools: 0 };
  let matCost = 0;
  for (const m of MATS) {
    const g = MAT_GOOD[m];
    const q = clamp(need[m] * fl - done[m], 0, Math.max(0, b.inv[g]));
    draw[m] = q;
    matCost += q * prices[g];
  }
  let bill = (dB * costLD + matCost) * BUILD_MARGIN;
  if (bill > EPS) {
    const cap = billingCapacity(s, p);
    if (bill > cap) {
      const k = cap > 0 ? clamp(cap / bill, 0, 1) : 0;
      dSw *= k;
      dB *= k;
      matCost *= k;
      for (const m of MATS) draw[m] *= k;
      bill *= k;
    }
  }
  const progressed = dSw + dB + draw.wood + draw.iron + draw.tools > EPS;
  if (progressed) {
    done.labor += dSw + dB;
    for (const m of MATS) {
      done[m] += draw[m];
      const g = MAT_GOOD[m];
      b.inv[g] = Math.max(0, b.inv[g] - draw[m]);
      if (draw[m] > 0) {
        bump(s, 'buildmat_' + g, draw[m]);
        noteFlow(s, b.town, g, FLOW_USED, draw[m]);
      }
    }
    // ---- billing: the advance first, then the owner's cash ----
    if (bill > EPS) {
      const fromPre = Math.min(Math.max(0, fin(p.prepaid)), bill);
      p.prepaid = Math.max(0, fin(p.prepaid) - fromPre);
      const rest = bill - fromPre;
      const paid = rest > EPS ? pay(s, p.owner, firmRef(b.id), rest, 'build') : 0;
      const billed = fromPre + paid;
      p.billed += billed;
      b.revenue += billed;
      // An advance moved no money today, but the work it paid for is today's construction spending.
      if (fromPre > 0) bump(s, 'flow_build', fromPre);
      bump(s, 'build_value', billed);
      if (p.owner === STATE) bump(s, 'build_state', billed);
      else bump(s, 'build_private', billed);
    }
    p.status = 'active';
    p.stalledDays = 0;
    if (p.kind === 'road') pave(s, p, fl);
  } else {
    p.stalledDays += 1;
    p.status = 'stalled';
  }
  st.builderLabor = dB;
  st.stateLabor = dSw;
  st.matValue = matCost;
  return st;
}

function isComplete(p: Project): boolean {
  if (p.done.labor < p.need.labor - EPS) return false;
  for (const m of MATS) if (p.done[m] < p.need[m] - EPS) return false;
  return true;
}

/** Hand the unspent advance to `to` (the new firm, or back to the owner). */
function handOver(s: SimState, b: Firm | undefined, p: Project, to: Ref): number {
  const pre = Math.max(0, fin(p.prepaid));
  p.prepaid = 0;
  if (!b || !(pre > EPS) || to === firmRef(b.id)) return 0;
  return pay(s, firmRef(b.id), to, pre, 'asset');
}

/** Top up a new firm's working capital from its owner (the Treasury pays from the Purse). */
function startingCapital(s: SimState, owner: Ref, f: Firm): void {
  const want = NEW_FIRM_WC_DAYS * typicalDailyCost(s, f.sector, f.town) - Math.max(0, f.cash);
  if (!(want > 1)) return;
  const fref = firmRef(f.id);
  if (owner === STATE) {
    pay(s, STATE, fref, want, 'transfer');
    return;
  }
  if (isPerson(owner)) {
    const q = s.people[owner];
    if (!q || !q.alive) return;
    const spare = Math.max(0, q.cash - 30 * Math.max(fin(q.income), 1));
    pay(s, owner, fref, Math.min(want, 0.5 * spare), 'asset');
    return;
  }
  if (isFirm(owner)) {
    const o = s.firms[refId(owner)];
    if (!o || !o.alive) return;
    const spare = Math.max(0, o.cash - CASH_TARGET_DAYS * firmDailyCost(s, o));
    pay(s, owner, fref, Math.min(want, 0.5 * spare), 'asset');
  }
}

/** Rent a new house asks: the town's going rent, else the founding rent. */
function newHouseRent(s: SimState, town: TownId): number {
  const t = s.towns[town];
  if (t && t.avgRent > 0 && Number.isFinite(t.avgRent)) return t.avgRent;
  const bw = fin(s.stats?.baseWage, 0);
  return BASE_RENT_SHARE * (bw > 2 ? bw : defaultWage(s, town));
}

function ownerLabel(s: SimState, owner: Ref): string {
  return owner === STATE ? 'the Treasury' : refName(s, owner);
}

/** Completion: activate what was built. */
function complete(s: SimState, b: Firm | undefined, p: Project): void {
  p.status = 'done';
  p.stalledDays = 0;
  p.loanWanted = 0;
  if (b && b.build) {
    const q = b.build.queue;
    const i = q.indexOf(p.id);
    if (i >= 0) q.splice(i, 1);
  }
  const bld: Building | undefined = p.building >= 0 ? s.buildings[p.building] : undefined;
  const tn = townName(s, p.town);
  switch (p.kind) {
    case 'firm':
    case 'reopen': {
      if (!bld) break;
      const sector = (p.sector || bld.sector) as Sector;
      if (!sector || !SECTORS[sector]) break;
      const old = p.kind === 'reopen' && bld.firm >= 0 ? s.firms[bld.firm] : undefined;
      bld.status = 'active';
      bld.built = s.day;
      bld.project = -1;
      bld.owner = p.owner;
      bld.cost = p.kind === 'firm' ? p.billed : 0.5 * Math.max(0, fin(bld.cost)) + p.billed;
      const f = createFirm(s, sector, p.town, bld.id, p.owner);
      // A reopened building comes with whatever its last occupant left behind.
      if (old && !old.alive && old.id !== f.id) {
        for (let g = 0; g < f.inv.length; g++) {
          if (old.inv[g] > 0) {
            f.inv[g] += old.inv[g];
            old.inv[g] = 0;
          }
        }
        if (old.tools > 0) {
          f.tools += old.tools;
          old.tools = 0;
        }
      }
      // The start-up loan is the firm's debt now; the unspent advance its working capital.
      if (p.loan >= 0 && p.owner !== STATE) {
        for (const ln of s.loans) {
          if (ln.id === p.loan && ln.active && ln.borrower === p.owner && ln.purpose !== 'house') ln.borrower = firmRef(f.id);
        }
      }
      handOver(s, b, p, firmRef(f.id));
      startingCapital(s, p.owner, f);
      const nm = SECTORS[sector].name;
      if (p.owner === STATE) news(s, p.kind === 'firm' ? `The Treasury's new ${nm} in ${tn} has opened; its profits will go to the Purse.` : `The Treasury has reopened a ${nm} in ${tn}.`, 'good', p.town);
      else news(s, p.kind === 'firm' ? `A new ${nm} has opened in ${tn}, set up by ${ownerLabel(s, p.owner)}.` : `A ${nm} in ${tn} has reopened under ${ownerLabel(s, p.owner)}.`, 'good', p.town);
      break;
    }
    case 'expand': {
      if (!bld) break;
      bld.level = Math.max(1, bld.level || 1) + 1;
      bld.cost = Math.max(0, fin(bld.cost)) + p.billed;
      bld.project = -1;
      const f = bld.firm >= 0 ? s.firms[bld.firm] : undefined;
      if (f && f.alive && SECTORS[f.sector]) f.capacity = SECTORS[f.sector].capacityPerLevel * bld.level;
      handOver(s, b, p, p.owner);
      news(s, `${f ? f.name : 'A workshop'} in ${tn} has been enlarged and can take on more hands.`, 'good', p.town);
      break;
    }
    case 'house': {
      if (!bld) break;
      bld.status = 'active';
      bld.built = s.day;
      bld.project = -1;
      bld.slots = HOUSE_SLOTS;
      bld.rent = newHouseRent(s, p.town);
      bld.owner = p.owner;
      bld.cost = p.billed;
      bld.vacantDays = 0;
      if (isPerson(p.owner)) {
        const q = s.people[p.owner];
        if (q && q.houses.indexOf(bld.id) < 0) q.houses.push(bld.id);
      }
      handOver(s, b, p, p.owner);
      news(s, p.owner === STATE ? `${HOUSE_SLOTS} new homes let by the Treasury are ready in ${tn}.` : `${HOUSE_SLOTS} new homes are ready to let in ${tn}.`, 'good', p.town);
      break;
    }
    case 'pier': {
      if (bld) {
        bld.status = 'active';
        bld.built = s.day;
        bld.project = -1;
        bld.owner = p.owner;
        bld.cost = p.billed;
      }
      s.foreign.piers = Math.max(0, fin(s.foreign.piers)) + 1;
      handOver(s, b, p, p.owner);
      news(s, `A new pier is finished at ${tn}; more foreign ships can now call.`, 'good', p.town);
      break;
    }
    case 'road': {
      pave(s, p, 1);
      invalidateRoutes(s);
      handOver(s, b, p, p.owner);
      news(s, p.label ? `${p.label} is finished.` : p.grade === 1 ? `A new track out of ${tn} is finished.` : `A paved road out of ${tn} is finished.`, 'good', p.town);
      break;
    }
  }
  touchBuildings(s);
  bump(s, 'built_' + p.kind);
}

/** Keep only the most recent PROJECT_KEEP_DONE finished projects. */
function pruneProjects(s: SimState): void {
  let nDone = 0;
  for (const p of s.projects) if (finished(p)) nDone++;
  if (nDone <= PROJECT_KEEP_DONE) return;
  let drop = nDone - PROJECT_KEEP_DONE;
  const keep: Project[] = [];
  for (const p of s.projects) {
    if (drop > 0 && finished(p)) {
      drop--;
      continue;
    }
    keep.push(p);
  }
  s.projects = keep;
}

/**
 * Each builder advances up to MAX_ACTIVE_PROJECTS projects in queue order with its own
 * hands (labour-days = Σ worker productivity); the town's Treasury workers work on all of its
 * Treasury projects at once (workList, stateShares: equal shares, what a site cannot use passes
 * on) — a Treasury project beyond the builder's slots moves only with them; materials drawn from the builder's inv proportionally (labour cannot run
 * more than 10 % ahead of materials). Bill the owner daily (cost × BUILD_MARGIN, flow
 * 'build'); owner unable to pay → stalled (STALL_CANCEL_DAYS → cancelled; building
 * removed or reverted). Completion: building active (new firm via firms.createFirm with
 * owner, houses get slots/rent, roads set map.road = 2 + runtime.invalidateRoutes,
 * piers raise foreign.piers), news item. stats.acc: build_value, build_labor.
 * Also: build_labor_state (Treasury worker-days on projects), build_state / build_private
 * (¤ billed), buildmat_<good>, built_<kind>; flow_build gains the part of bills paid
 * from advances (no money moves then).
 */
export function constructionProgress(s: SimState): void {
  const { labor: sw, heads } = stateLabor(s);
  // Treasury crews: equal shares on every Treasury project of their town; what a site cannot use
  // passes to the next one (carry, per town).
  const shares = stateShares(s, sw);
  const carry = new Float64Array(sw.length);
  const dBuilder = SECTORS.builder;
  let laborTotal = 0;
  let stateLaborTotal = 0;
  let stateHeads = 0;
  const cancelled: Project[] = [];
  const prices: number[][] = [];
  for (const p of s.projects) {
    if (p && p.owner === STATE) {
      p.crewToday = 0;
      p.crewHeads = 0;
    }
  }
  for (const b of s.firms) {
    if (!isBuilder(b)) continue;
    if (b.building >= 0 && s.buildings[b.building] && s.buildings[b.building].status !== 'active') continue;
    const t = b.town;
    cleanQueue(s, b);
    const inTown = t >= 0 && t < sw.length;
    const { list: active, slots } = workList(s, b, inTown && sw[t] > EPS);
    equipBuilder(s, b, active);
    const leff = workforceEff(s, b) * strikeFactor(s, t);
    const tf = toolFactor(dBuilder, Math.max(0, fin(b.tools)), leff);
    const labor0 = leff * tf;
    let labor = labor0;
    const costLD = laborDayCost(s, b, labor0);
    const pr = prices[t] ?? (prices[t] = townGrossPrices(s, t));
    let used = 0;
    let matVal = 0;
    for (let i = 0; i < active.length; i++) {
      const p = active[i];
      const own = i < slots; // the builder's own hands work only on its first projects
      const give = p.owner === STATE && inTown ? (shares.get(p.id) ?? 0) + carry[t] : 0;
      if (!own && !(give > EPS)) continue; // a Treasury project beyond the builder's slots waits for a crew
      const st = advance(s, b, p, own ? labor : 0, give, costLD, pr);
      labor = Math.max(0, labor - st.builderLabor);
      if (p.owner === STATE && inTown) carry[t] = Math.max(0, give - st.stateLabor);
      used += st.builderLabor;
      stateLaborTotal += st.stateLabor;
      if (st.stateLabor > 0 && t >= 0 && t < sw.length && sw[t] > 0) {
        const h = (st.stateLabor / sw[t]) * heads[t];
        stateHeads += h;
        p.crewToday = (p.crewToday ?? 0) + st.stateLabor;
        p.crewHeads = (p.crewHeads ?? 0) + h;
      }
      matVal += st.matValue;
      if (isComplete(p)) complete(s, b, p);
      else if (p.stalledDays >= STALL_CANCEL_DAYS) cancelled.push(p);
    }
    // Tool wear of the builder's own equipment.
    const tools = Math.max(0, fin(b.tools));
    const util = labor0 > EPS ? used / labor0 : 0;
    const inUse = leff > EPS && dBuilder.toolsPerWorker > 0 ? Math.min(1, tools / (dBuilder.toolsPerWorker * leff)) : 0;
    const wear = Math.min(tools, TOOLS_IDLE_WEAR_DAY * tools + dBuilder.toolUse * leff * util * inUse);
    b.tools = tools - wear;
    noteFlow(s, b.town, G.tools, FLOW_USED, wear);
    b.producedToday += used;
    noteFirmCosts(s, b.id, matVal, wear * pr[G.tools]);
    laborTotal += used;
    bump(s, 'toolwear', wear);
  }
  for (const p of cancelled) {
    if (finished(p)) continue;
    const label = p.label || 'a building project';
    if (cancelProject(s, p.id)) news(s, `Work on “${label}” in ${townName(s, p.town)} was abandoned after ${STALL_CANCEL_DAYS} days without progress.`, 'bad', p.town);
  }
  bump(s, 'build_labor', laborTotal + stateLaborTotal);
  bump(s, 'build_labor_state', stateHeads);
  pruneProjects(s);
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/**
 * Builders bid for wood/iron/tools needed by their active projects (+ small buffer).
 * They keep up to BUILDER_STOCK_SHARE of each active project's needs in stock (or
 * whatever remains), plus tools for their own crew; they bid for BUILDER_BID_CLOSE
 * of the gap a day on a short ladder above the expected price (cost-plus contracts
 * make builders price-insensitive: their customers pay). Bids are capped by cash
 * less tomorrow's payroll and less advances held for projects not yet started; a
 * shortfall is noted for a working-capital loan.
 */
export function builderOrders(s: SimState, books: Books): void {
  const dB = SECTORS.builder;
  const crewedTowns = stateLabor(s).labor;
  for (const b of s.firms) {
    if (!isBuilder(b)) continue;
    if (b.building >= 0 && s.buildings[b.building] && s.buildings[b.building].status !== 'active') continue;
    const t = b.town;
    const active = eligible(s, b, MAX_ACTIVE_PROJECTS + 1);
    // …and the Treasury projects its town's Treasury crews work on at once
    if (t >= 0 && t < crewedTowns.length && crewedTowns[t] > EPS) {
      const ids = new Set(active.map((p) => p.id));
      for (const p of workList(s, b, true).list) if (!ids.has(p.id)) active.push(p);
    }
    const want = { wood: 0, iron: 0, tools: 0 };
    for (const p of active) {
      for (const m of MATS) {
        const rem = Math.max(0, p.need[m] - p.done[m]);
        want[m] += Math.min(rem, Math.max(p.need[m] * BUILDER_STOCK_SHARE, 0));
      }
    }
    const crew = Math.max(b.workers.length, fin(b.target) + (active.length ? BUILDER_TOOLLESS_HANDS : 0));
    if (crew > 0) want.tools += Math.max(0, dB.toolsPerWorker * crew * 0.95 + TOOLS_BUFFER_DAYS * dB.toolUse * crew - Math.max(0, fin(b.tools)));
    const prices = townGrossPrices(s, t);
    // Advances for queued projects the builder is not working on yet stay untouched.
    const activeIds = new Set(active.map((p) => p.id));
    let held = 0;
    for (const id of b.build!.queue) {
      if (activeIds.has(id)) continue;
      const p = projectById(s, id);
      if (p) held += Math.max(0, fin(p.prepaid));
    }
    const payroll = WAGE_RESERVE_DAYS * b.workers.length * Math.max(0, fin(b.wage));
    const budget = Math.max(0, fin(b.cash) - payroll - held);
    const orders: [number, number, number][] = [];
    let cost = 0;
    for (const m of MATS) {
      const g = MAT_GOOD[m];
      const gap = want[m] - Math.max(0, b.inv[g]);
      if (!(gap > EPS)) continue;
      const qty = gap < 5 ? gap : gap * BUILDER_BID_CLOSE;
      // Cost-plus buyers are price-insensitive: anchor the ladder to what the material costs
      // to make, so that a shortage cannot ratchet the price up by the ladder's top rung daily.
      const lim = BUILDER_MAX_BID_MULT * fairPrice(s, t, g, prices);
      for (let i = 0; i < BUILDER_BID_RUNGS.length; i++) {
        const price = Math.min(prices[g] * BUILDER_BID_RUNGS[i], lim);
        const q = qty * BUILDER_BID_WEIGHTS[i];
        if (!(q > EPS) || !(price > 0)) continue;
        orders.push([g, price, q]);
        cost += price * q;
      }
    }
    if (!orders.length) continue;
    let k = 1;
    if (cost > budget) {
      k = cost > 0 ? clamp(budget / cost, 0, 1) : 0;
      noteShortfall(s, b.id, cost - budget);
    }
    const ref = firmRef(b.id);
    for (const [g, price, q] of orders) {
      const qq = q * k;
      if (qq > EPS) addBid(bookFor(books, t, g), ref, price, qq);
    }
  }
}

// ---------------------------------------------------------------------------
// Starting and cancelling
// ---------------------------------------------------------------------------

/** Is an explicit site acceptable? Uses the layout's shared site rules; falls back to a free-footprint check. */
function siteOk(s: SimState, what: Sector | 'house' | 'pier', x: number, y: number, town: TownId, w: number, h: number): boolean {
  try {
    return !!isValidSite(s, what, x, y, town);
  } catch {
    return footprintFree(s, x, y, w, h, what === 'pier');
  }
}

function footprintFree(s: SimState, x: number, y: number, w: number, h: number, allowWater: boolean): boolean {
  const map = s.map;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= map.w || yy >= map.h) return false;
      const i = yy * map.w + xx;
      if (map.occ[i] >= 0) return false;
      const tr = map.terrain[i];
      if (!allowWater && (tr === Terrain.Water || tr === Terrain.DeepWater)) return false;
    }
  }
  return true;
}

function defaultLabel(s: SimState, spec: ProjectSpec): string {
  const tn = townName(s, spec.town);
  const nm = spec.sector ? SECTORS[spec.sector]?.name ?? 'workshop' : 'workshop';
  switch (spec.kind) {
    case 'firm':
      return `New ${nm} in ${tn}`;
    case 'reopen':
      return `Reopening a ${nm} in ${tn}`;
    case 'expand': {
      const b = spec.building !== undefined ? s.buildings[spec.building] : undefined;
      const f = b && b.firm >= 0 ? s.firms[b.firm] : undefined;
      return `Enlarging ${f ? f.name : 'a ' + nm} in ${tn}`;
    }
    case 'house':
      return `Houses in ${tn}`;
    case 'pier':
      return `Pier at ${tn}`;
    case 'road':
      return spec.grade === 1 ? `Track out of ${tn}` : `Paved road out of ${tn}`;
    default:
      return 'Building work';
  }
}

function ownerValid(s: SimState, o: Ref): boolean {
  if (o === STATE) return true;
  if (isPerson(o)) return !!s.people[o]?.alive;
  if (isFirm(o)) return !!s.firms[refId(o)]?.alive;
  return false;
}

/**
 * Validate and enqueue a project with the town's builder. Creates the target
 * building in 'construction' status for new builds (world/layout.placeBuilding).
 * Returns the project, or an error string.
 * Reopening marks the vacant building 'construction'; expansion leaves the firm
 * working. The project starts 'queued'; private owners' money is advanced by the
 * caller (entry.ts) through `prepaid` / `loanWanted`.
 */
export function startProject(s: SimState, spec: ProjectSpec): Project | string {
  const town = spec.town;
  if (!(town >= 0 && town < s.towns.length)) return 'Unknown town.';
  if (!ownerValid(s, spec.owner)) return 'Nobody to pay for it.';
  const b = builderFor(s, town);
  if (!b) return `There is no working builders' yard in ${townName(s, town)}.`;
  let building = -1;
  let tiles: number[] = [];
  let sector: Sector | '' = '';
  const kind = spec.kind;
  switch (kind) {
    case 'firm': {
      const sec = spec.sector;
      if (!sec || !SECTORS[sec] || sec === 'stateworks') return 'Unknown kind of workplace.';
      sector = sec;
      const [w, h] = SECTORS[sec].footprint;
      let xy: { x: number; y: number } | null = null;
      if (spec.x !== undefined && spec.y !== undefined) {
        if (!siteOk(s, sec, spec.x, spec.y, town, w, h)) return `A ${SECTORS[sec].name} cannot be built on that spot.`;
        xy = { x: spec.x, y: spec.y };
      } else xy = safeFindSite(s, sec, town);
      if (!xy) return `No free site for a ${SECTORS[sec].name} near ${townName(s, town)}.`;
      const bld = safePlace(s, 'firm', sec, town, xy.x, xy.y);
      if (!bld) return 'The building could not be placed there.';
      building = bld.id;
      break;
    }
    case 'house':
    case 'pier': {
      if (kind === 'pier' && !s.towns[town].hasPort) return `${townName(s, town)} has no harbour for a pier.`;
      let xy: { x: number; y: number } | null = null;
      if (spec.x !== undefined && spec.y !== undefined) {
        if (!siteOk(s, kind, spec.x, spec.y, town, kind === 'pier' ? 2 : 1, 1)) return kind === 'house' ? 'Houses cannot be built on that spot.' : 'A pier needs free shallow water by the shore there.';
        xy = { x: spec.x, y: spec.y };
      } else xy = safeFindSite(s, kind, town);
      if (!xy) return kind === 'house' ? `No free land for houses near ${townName(s, town)}.` : `No free stretch of shore for a pier at ${townName(s, town)}.`;
      const bld = safePlace(s, kind === 'house' ? 'house' : 'port', '', town, xy.x, xy.y);
      if (!bld) return 'The building could not be placed there.';
      building = bld.id;
      break;
    }
    case 'expand': {
      const bld = spec.building !== undefined ? s.buildings[spec.building] : undefined;
      if (!bld || bld.kind !== 'firm' || bld.status !== 'active') return 'There is no working building to enlarge.';
      if (bld.project >= 0) return 'That building already has builders at work.';
      const f = bld.firm >= 0 ? s.firms[bld.firm] : undefined;
      if (!f || !f.alive) return 'Nobody works in that building.';
      sector = f.sector;
      building = bld.id;
      break;
    }
    case 'reopen': {
      const bld = spec.building !== undefined ? s.buildings[spec.building] : undefined;
      if (!bld || bld.kind !== 'firm' || bld.status !== 'vacant') return 'There is no empty workshop to reopen.';
      if (bld.project >= 0) return 'That building already has builders at work.';
      const sec = (spec.sector || bld.sector) as Sector;
      if (!sec || !SECTORS[sec] || sec === 'stateworks') return 'Unknown kind of workplace.';
      sector = sec;
      building = bld.id;
      break;
    }
    case 'road': {
      const map = s.map;
      const g = spec.grade === 1 ? 1 : 2;
      tiles = (spec.tiles ?? []).filter(
        (t) => Number.isInteger(t) && t >= 0 && t < map.road.length && map.road[t] < g && map.occ[t] < 0 && map.terrain[t] !== Terrain.Water && map.terrain[t] !== Terrain.DeepWater,
      );
      if (tiles.length === 0) return g === 1 ? 'There is a road there already.' : 'There is nothing left to pave.';
      break;
    }
    default:
      return 'Unknown kind of construction.';
  }
  const label = spec.label || defaultLabel(s, spec);
  const need = kind === 'road' ? roadNeed(s, tiles, spec.grade === 1 ? 1 : 2) : projectNeed(kind, sector, tiles.length);
  const p = newProjectRecord(s, kind, town, spec.owner, b.id, label);
  if (kind === 'road' && spec.grade === 1) p.grade = 1;
  p.sector = sector;
  p.building = building;
  p.tiles = tiles;
  p.need = need;
  p.loan = spec.loan !== undefined && spec.loan >= 0 ? spec.loan : -1;
  const bld = building >= 0 ? s.buildings[building] : undefined;
  if (bld) {
    bld.project = p.id;
    if (kind === 'firm' || kind === 'house' || kind === 'pier') {
      bld.owner = spec.owner;
      bld.status = 'construction';
      bld.cost = 0;
    } else if (kind === 'reopen') bld.status = 'construction';
  }
  b.build!.queue.push(p.id);
  touchBuildings(s);
  return p;
}

function safeFindSite(s: SimState, what: Sector | 'house' | 'pier', town: TownId): { x: number; y: number } | null {
  try {
    const r = findSite(s, what, town);
    return r && Number.isFinite(r.x) && Number.isFinite(r.y) ? r : null;
  } catch {
    return null;
  }
}

function safePlace(s: SimState, kind: Building['kind'], sector: Sector | '', town: TownId, x: number, y: number): Building | null {
  try {
    const b = placeBuilding(s, kind, sector, town, x, y, 'construction');
    return b && b.id >= 0 && s.buildings[b.id] === b ? b : null;
  } catch {
    return null;
  }
}

/**
 * Cancel a project (removes an unfinished new building).
 * A reopening reverts the building to 'vacant'; an expansion leaves the building as it
 * was; road tiles already paved stay paved. The builder refunds the unspent advance —
 * used first to pay down the project's loan — and any pending loan request is dropped.
 */
export function cancelProject(s: SimState, id: number): boolean {
  const p = projectById(s, id);
  if (!p || finished(p)) return false;
  p.status = 'cancelled';
  const b = p.builder >= 0 ? s.firms[p.builder] : undefined;
  if (b && b.build) {
    const i = b.build.queue.indexOf(p.id);
    if (i >= 0) b.build.queue.splice(i, 1);
  }
  const bld = p.building >= 0 ? s.buildings[p.building] : undefined;
  if (bld && bld.project === p.id) {
    if (p.kind === 'firm' || p.kind === 'house' || p.kind === 'pier') {
      if (bld.status === 'construction') {
        try {
          removeBuilding(s, bld);
        } catch {
          /* layout unavailable */
        }
        const still = s.buildings[bld.id];
        if (still && still.status === 'construction') still.status = 'ruin';
        if (still) still.project = -1;
      }
    } else {
      if (p.kind === 'reopen' && bld.status === 'construction') bld.status = 'vacant';
      bld.project = -1;
    }
  }
  // Refund the unspent advance; it pays down the project's loan first.
  const refund = handOver(s, b, p, p.owner);
  if (refund > 0 && p.loan >= 0 && p.owner !== STATE) {
    let left = refund;
    for (const ln of s.loans) {
      if (!(left > EPS)) break;
      if (ln.id !== p.loan || !ln.active || ln.borrower !== p.owner) continue;
      const a = repayPrincipal(s, p.owner, Math.min(left, ln.principal));
      ln.principal -= a;
      left -= a;
      if (ln.principal <= 1e-6) {
        if (ln.principal > 0) writeOff(s, ln.principal);
        ln.principal = 0;
        ln.active = false;
      }
    }
  }
  const rq = s.bank.requests;
  if (rq && rq.length) {
    let k = 0;
    for (let i = 0; i < rq.length; i++) if (rq[i].project !== p.id) rq[k++] = rq[i];
    rq.length = k;
  }
  p.loanWanted = 0;
  p.prepaid = 0;
  if (p.kind === 'road') invalidateRoutes(s);
  touchBuildings(s);
  return true;
}

/**
 * Estimated total ¤ cost of a project at current prices and wages (for UI & entry decisions).
 * Labour at the town builder's wage (employer wage levies included) per effective
 * labour-day, materials at expected gross prices, × BUILD_MARGIN. Treasury labour
 * that would help on Treasury projects is not deducted.
 */
export function estimateCost(s: SimState, kind: ProjectKind, town: TownId, sector?: Sector, tiles?: number): number {
  if (!(town >= 0 && town < s.towns.length)) return 0;
  return needCost(s, town, projectNeed(kind, sector ?? '', tiles ?? 0));
}

/** What `need` would cost built by `town`'s builders at today's prices and wages. */
export function needCost(s: SimState, town: TownId, need: Materials): number {
  if (!(town >= 0 && town < s.towns.length)) return 0;
  const b = builderFor(s, town);
  let w = b && b.wage > 0 ? b.wage : defaultWage(s, town);
  if (hasLevyBase(s, 'wage')) {
    const r = wageLevyRates(s, town, 'builder', w);
    w = Math.max(0, fin(w * (1 + r.employerPct) + r.employerUnit, w));
  }
  return fin(materialsValue(need, townGrossPrices(s, town), w / 0.9, BUILD_MARGIN), 0);
}
