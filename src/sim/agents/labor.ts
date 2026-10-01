// ============================================================================
// Labour market (matching, not an auction). See DESIGN §3.1/§3.2.
// OWNER: households agent.
//
// Each morning, after firms have posted a target workforce and a wage:
//   1. consistency pass (worker lists ↔ person.job), tenure clock, wage sync;
//   2. layoffs where workforce > target (last in, first out);
//   3. per-town vacancy lists (sampling weight ∝ open slots);
//   4. the unemployed search (mostly at home, sometimes in towns within commuting
//      range) and take the best offer whose NET value beats their reservation wage;
//   5. a few employed people search on the job and switch for a clearly better offer.
//
// Economics:
//  * Offers are compared in take-home terms: gross wage minus any worker-side wage
//    levy (a negative levy — the Treasury topping up wages — raises the offer),
//    minus commuting cost. Employer-side levies do not enter here; they reach
//    workers only through firms' labour demand and wage setting, which is why the
//    statutory side of a wage levy matters little for its long-run incidence.
//  * The reservation wage anchors on the last wage earned, decays with the length
//    of unemployment, and rises by whatever per-head payments a person would lose
//    by taking a job (and falls by any per-head payments only workers receive).
//  * A legal wage floor does not raise offers here: a firm whose posted wage is
//    below the legal minimum simply cannot hire (firms.ts clamps posted wages, so
//    a binding floor shows up as lower targets and layoffs, i.e. unemployment).
// ============================================================================
import * as CFG from '../config';
import * as GOODS_M from '../goods';
import { levyAmount, wageLevyRates } from '../policy/levies';
import { wageBounds } from '../policy/limits';
import * as RNG from '../rng';
import type { Firm, Person, SimState } from '../types';
import * as UTIL from '../util';
import { decideMeans } from './means';

// Leaf-module constants and helpers (config, goods, util, calendar, types, rng, ledger — no
// import cycles back into agents) bound once at load: hot loops then read locals instead of
// live import bindings (which cost a getter call per read under tsx/vitest).
const { rand, randInt, shuffle } = RNG;
const { BROKE_DAYS, COMMUTE_COST_PER_TILE, FIRE_RATE, FOOD_NEED, HIRE_RATE, HUNGRY_BELOW, JOB_SAMPLE, MAX_COMMUTE_TILES, OTJ_SEARCH_PROB, OTJ_SWITCH_GAIN, OWN_TOWN_SEARCH_SHARE, RES_WAGE_BROKE_MULT, RES_WAGE_DECAY_DAYS, RES_WAGE_FLOOR, RES_WAGE_HUNGRY_MULT, RES_WAGE_START, BASE_WAGE, VACANCY_SAMPLE_CAP } = CFG;
const { G, N_GOODS } = GOODS_M;
const { clamp, dist, fin } = UTIL;

// ---------------------------------------------------------------------------
// Small shared helpers (also used by households/housing/demography)
// ---------------------------------------------------------------------------

function bump(s: SimState, key: string, v = 1): void {
  const acc = s.stats.acc;
  acc[key] = (acc[key] || 0) + v;
}

/** True if any enabled, unexpired levy of this base exists (cheap pre-check before per-person levy queries). */
export function hasLevyBase(s: SimState, base: string): boolean {
  const ls = s.policy?.levies;
  if (!ls) return false;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (l.enabled && l.base === base && (l.until < 0 || l.until >= s.day)) return true;
  }
  return false;
}

/**
 * Per-call cache of worker-side wage levy rates and legal wage bounds.
 * Levies/limits only change between days (player actions), so one context per
 * pass is exact.
 */
export interface WageCtx {
  /** Per-firm take-home wage cache (−1 = not computed yet). */
  net: Float64Array;
  /** True if any wage levy is active (otherwise take-home = legal gross). */
  levies: boolean;
  min: number[]; // per town, -1 none
  max: number[];
}

export function wageCtx(s: SimState): WageCtx {
  const min: number[] = [];
  const max: number[] = [];
  for (const t of s.towns) {
    const b = wageBounds(s, t.id);
    min.push(b && b.min >= 0 ? b.min : -1);
    max.push(b && b.max >= 0 ? b.max : -1);
  }
  const net = new Float64Array(s.firms.length).fill(-1);
  return { net, levies: hasLevyBase(s, 'wage'), min, max };
}

/** Gross wage the firm can legally pay (posted wage, capped by any wage maximum). */
function legalGross(c: WageCtx, f: Firm): number {
  const mx = c.max[f.town] ?? -1;
  const w = Math.max(0, fin(f.wage));
  return mx >= 0 ? Math.min(w, mx) : w;
}

/** Take-home wage per day at firm f (after worker-side wage levies; gives raise it). Cached per firm in `c`. */
export function netWage(s: SimState, c: WageCtx, f: Firm): number {
  const cached = f.id < c.net.length ? c.net[f.id] : -1;
  if (cached >= 0) return cached;
  const g = legalGross(c, f);
  let n = g;
  if (c.levies) {
    const w = wageLevyRates(s, f.town, f.sector, g);
    n = g * (1 - fin(w?.workerPct ?? 0)) - fin(w?.workerUnit ?? 0);
  }
  n = Math.max(0, fin(n));
  if (f.id < c.net.length) c.net[f.id] = n;
  return n;
}

/** Net offer of a firm to a job seeker, or -1 if it cannot legally hire (posted wage below the legal minimum). */
export function netOffer(s: SimState, c: WageCtx, f: Firm): number {
  const mn = c.min[f.town] ?? -1;
  if (mn >= 0 && f.wage < mn - 1e-9) return -1;
  return netWage(s, c, f);
}

/** Tile coordinates (centre) of a person's home, or their town centre if homeless. */
function homeX(s: SimState, p: Person): number {
  const b = p.home >= 0 ? s.buildings[p.home] : undefined;
  if (b) return b.x + b.w / 2;
  const t = s.towns[p.town];
  return t ? t.x + 0.5 : 0;
}
function homeY(s: SimState, p: Person): number {
  const b = p.home >= 0 ? s.buildings[p.home] : undefined;
  if (b) return b.y + b.h / 2;
  const t = s.towns[p.town];
  return t ? t.y + 0.5 : 0;
}

/** Tile coordinates (centre) of a firm's workplace (its building, or the town centre for Treasury Works). */
export function workX(s: SimState, f: Firm): number {
  const b = f.building >= 0 ? s.buildings[f.building] : undefined;
  if (b) return b.x + b.w / 2;
  const t = s.towns[f.town];
  return t ? t.x + 0.5 : 0;
}
export function workY(s: SimState, f: Firm): number {
  const b = f.building >= 0 ? s.buildings[f.building] : undefined;
  if (b) return b.y + b.h / 2;
  const t = s.towns[f.town];
  return t ? t.y + 0.5 : 0;
}

/** Commute distance in tiles between a person's home (or town centre if homeless) and a firm's building. */
export function commuteTiles(s: SimState, p: Person, f: Firm): number {
  const d = dist(homeX(s, p), homeY(s, p), workX(s, f), workY(s, f));
  return Math.round(fin(d) * 10) / 10;
}

/** Share of a wage kept after commuting `tiles`. */
export function commuteKeep(tiles: number): number {
  return clamp(1 - COMMUTE_COST_PER_TILE * Math.max(0, tiles), 0, 1);
}

// ---------------------------------------------------------------------------
// Job transitions
// ---------------------------------------------------------------------------

function removeWorker(f: Firm, pid: number): void {
  const w = f.workers;
  const i = w.indexOf(pid);
  if (i >= 0) {
    w[i] = w[w.length - 1];
    w.pop();
  }
}

/**
 * Remove a person from their job without counting it as a layoff (quits, deaths,
 * emigration, moving away). Keeps lastWage as the reservation-wage anchor.
 */
export function leaveJob(s: SimState, p: Person): void {
  if (p.job >= 0) {
    const f = s.firms[p.job];
    if (f) removeWorker(f, p.id);
  }
  p.job = -1;
  p.wage = 0;
  p.commute = 0;
  p.tenure = 0;
  p.unempDays = 0;
}

/** Put a person into a firm (removing them from any current job). */
export function hire(s: SimState, f: Firm, p: Person): void {
  if (!p.alive || !f) return;
  if (p.job === f.id) return;
  if (p.job >= 0) leaveJob(s, p);
  if (f.workers.indexOf(p.id) < 0) f.workers.push(p.id);
  p.job = f.id;
  p.wage = Math.max(0, fin(f.wage));
  p.tenure = 0;
  p.unempDays = 0;
  p.commute = commuteTiles(s, p, f);
  f.hired += 1;
  bump(s, 'hires');
}

/** Remove a person from their job (a layoff: counted in firm.fired and stats.acc.fires). */
export function fire(s: SimState, f: Firm, p: Person): void {
  if (!f || !p) return;
  const listed = f.workers.indexOf(p.id) >= 0;
  removeWorker(f, p.id);
  if (!listed && p.job !== f.id) return; // not employed here: nothing to do
  if (p.job === f.id) {
    // Anchor the reservation wage on what the job paid (gross; refined to net next morning if re-hired).
    if (p.wage > 0 && !(p.lastWage > 0)) p.lastWage = p.wage;
    p.job = -1;
    p.wage = 0;
    p.commute = 0;
    p.tenure = 0;
    p.unempDays = 0;
  }
  f.fired += 1;
  bump(s, 'fires');
}

// ---------------------------------------------------------------------------
// Daily matching
// ---------------------------------------------------------------------------

/**
 * Whole-number workforce the firm wants to reach: the target rounded (firms smooth their
 * targets, so there is no need for a further band; a band between round and ceil kept a
 * five-worker shop at five hands for any target above 4.05 — 20 % over its plan for months).
 */
function wantUpper(f: Firm): number {
  return Math.max(0, Math.floor(fin(f.target) + 0.5));
}
function wantLower(f: Firm): number {
  return Math.max(0, Math.floor(fin(f.target) + 0.5));
}

/** Person ids posted as drivers to the Treasury freight lines based in a town. */
function postedDrivers(s: SimState, town: number): Set<number> {
  const out = new Set<number>();
  for (const L of s.policy.lines) if (L.a === town) for (const pid of L.staff ?? []) out.add(pid);
  return out;
}

/** Max hires per firm per day. Treasury Works (huge nominal capacity) scale with their target instead. */
function hireCap(f: Firm): number {
  const base = f.sector === 'stateworks' ? Math.max(20, fin(f.target)) : Math.max(1, f.capacity);
  return Math.max(1, Math.floor(HIRE_RATE * base));
}

function firmOpen(f: Firm): boolean {
  return f.alive && f.status === 'active';
}

// Module scratch for bestOffer (avoids per-call allocation).
let _bestFirm = -1;
let _bestValue = -1;

/**
 * Daily, after firmsPlan set firm.target and firm.wage:
 *  1. Layoffs: firms with workers > target fire up to max(1, FIRE_RATE·workers) (lowest tenure first).
 *     Stateworks with target below workers release the excess at once, freight-line drivers last.
 *  2. Vacancies = target − workers for active firms (incl. builders, traders, stateworks).
 *  3. Unemployed people sample JOB_SAMPLE vacancies (weighted to their own town; other
 *     towns within MAX_COMMUTE_TILES of their home) and accept the best offer by
 *     net wage (after worker wage levies) × (1 − COMMUTE_COST_PER_TILE·tiles) if it
 *     beats their reservation wage (RES_WAGE_START → RES_WAGE_FLOOR of lastWage over
 *     RES_WAGE_DECAY_DAYS, raised by any per-head gives they receive as unemployed).
 *  4. OTJ_SEARCH_PROB of employed people search; switch for ≥ OTJ_SWITCH_GAIN.
 *  5. Respect hiring caps (max(1, HIRE_RATE·capacity) per firm per day).
 *  6. Wage Limits: a firm whose posted wage is below the legal minimum cannot hire
 *     (firms.ts clamps posted wages to the bounds); offers are capped at any legal maximum.
 * Updates firm.hired/fired/applicants/vacancyDays, person.job/wage/tenure/unempDays/commute,
 * and stats.acc hires/fires/quits.
 */
export function laborMarket(s: SimState): void {
  const people = s.people;
  const firms = s.firms;
  const nP = people.length;
  const nF = firms.length;
  const nT = s.towns.length;
  const wc = wageCtx(s);

  // ---- 1. consistency pass -------------------------------------------------
  // listed[pid] = firm id + 1 of the (first) list the person appears on.
  const listed = new Int32Array(nP);
  for (let i = 0; i < nF; i++) {
    const f = firms[i];
    if (!f) continue;
    f.applicants = 0;
    const w = f.workers;
    let k = 0;
    for (let j = 0; j < w.length; j++) {
      const pid = w[j];
      const p = people[pid];
      if (!p || !p.alive || p.job !== f.id || listed[pid] !== 0) continue;
      listed[pid] = f.id + 1;
      w[k++] = pid;
    }
    w.length = k;
  }
  for (let i = 0; i < nP; i++) {
    const p = people[i];
    if (!p || !p.alive || p.job < 0) continue;
    const f = firms[p.job];
    if (!f || !f.alive || f.status === 'closed') {
      leaveJob(s, p);
      continue;
    }
    if (listed[i] !== p.job + 1) {
      // Person claims a job the firm does not list: re-list if there is room, else release.
      if (f.workers.length < Math.max(1, f.capacity)) f.workers.push(p.id);
      else {
        leaveJob(s, p);
        continue;
      }
    }
    p.tenure += 1;
    p.wage = Math.max(0, fin(f.wage));
  }

  // ---- 1b. people of independent means leave (or rejoin) the labour force (agents/means.ts) ----
  const typical = typicalNet(s, wc);
  for (const p of decideMeans(s, typical)) {
    p.lastWage = p.wage > 0 ? netWage(s, wc, firms[p.job]) : p.lastWage;
    leaveJob(s, p);
    bump(s, 'quits_means');
  }

  // ---- 2. layoffs ------------------------------------------------------------
  for (let i = 0; i < nF; i++) {
    const f = firms[i];
    if (!f || f.workers.length === 0) continue;
    const n = f.workers.length;
    let excess: number;
    if (!firmOpen(f)) excess = n; // liquidating: everyone goes
    else {
      const cap = f.sector === 'stateworks' ? n : Math.max(0, f.capacity);
      const keep = Math.min(wantUpper(f), cap);
      excess = n - keep;
      if (excess <= 0) continue;
      // Over capacity is resolved at once; ordinary downsizing is gradual. The Treasury crew
      // releases its excess at once: its target is what labour orders (and the Purse) will pay
      // for, and workers kept past an order's end would be paid outside any order's cap.
      const overCap = Math.max(0, n - cap);
      if (f.sector !== 'stateworks') excess = Math.max(overCap, Math.min(excess, Math.max(1, Math.floor(FIRE_RATE * n))));
    }
    if (excess <= 0) continue;
    // Last in, first out — except that the Treasury crew lets its freight-line drivers go last
    // (they are posted to a line: FreightLine.staff; a smaller works crew never costs a line its drivers).
    const posted = f.sector === 'stateworks' && s.policy.lines?.length ? postedDrivers(s, f.town) : null;
    const order = f.workers.slice().sort((a, b) => (posted ? Number(posted.has(a)) - Number(posted.has(b)) : 0) || (people[a].tenure - people[b].tenure) || (a - b));
    for (let j = 0; j < excess && j < order.length; j++) fire(s, f, people[order[j]]);
  }

  // ---- 3. vacancy lists ----------------------------------------------------
  const slots = new Int32Array(nF); // hires still allowed today
  const offer = new Float64Array(nF); // net offer (−1 = cannot hire)
  const vac: number[][] = [];
  for (let t = 0; t < nT; t++) vac.push([]);
  let anyVacancy = false;
  for (let i = 0; i < nF; i++) {
    const f = firms[i];
    if (!f || !firmOpen(f)) continue;
    const cap = f.sector === 'stateworks' ? Number.MAX_SAFE_INTEGER : Math.max(0, f.capacity);
    const open = Math.min(wantLower(f), cap) - f.workers.length;
    if (open <= 0) continue;
    const o = netOffer(s, wc, f);
    offer[i] = o;
    if (o <= 0) continue; // illegal (below the legal minimum) or worthless offer
    const n = Math.min(open, hireCap(f));
    slots[i] = n;
    const list = vac[f.town];
    if (!list) continue;
    const entries = Math.min(n, VACANCY_SAMPLE_CAP);
    for (let k = 0; k < entries; k++) list.push(i);
    anyVacancy = true;
  }

  // Towns within commuting range of each town (centre distance, generous margin).
  const near: number[][] = [];
  for (let t = 0; t < nT; t++) {
    const a = s.towns[t];
    const row: number[] = [];
    for (let u = 0; u < nT; u++) {
      if (u === t) continue;
      const b = s.towns[u];
      if (dist(a.x, a.y, b.x, b.y) <= MAX_COMMUTE_TILES + a.radius + b.radius) row.push(u);
    }
    near.push(row);
  }

  const headLevies = hasLevyBase(s, 'head');

  // Sample JOB_SAMPLE vacancies for p; result in _bestFirm/_bestValue. Counts applicants whose
  // reservation value (resW) the offer meets.
  const bestOffer = (p: Person, exclude: number, resW: number): void => {
    _bestFirm = -1;
    _bestValue = -1;
    const own = vac[p.town] ?? [];
    const nearTowns = near[p.town] ?? [];
    let nearCount = 0;
    for (const u of nearTowns) nearCount += vac[u].length;
    if (own.length === 0 && nearCount === 0) return;
    for (let k = 0; k < JOB_SAMPLE; k++) {
      let list: number[];
      if (own.length > 0 && (nearCount === 0 || rand(s) < OWN_TOWN_SEARCH_SHARE)) list = own;
      else {
        // pick a nearby town weighted by its vacancy entries
        let r = randInt(s, nearCount);
        list = own;
        for (const u of nearTowns) {
          const l = vac[u];
          if (r < l.length) {
            list = l;
            break;
          }
          r -= l.length;
        }
        if (list.length === 0) continue;
      }
      const fid = list[randInt(s, list.length)];
      if (fid === exclude || slots[fid] <= 0) continue;
      const f = firms[fid];
      const tiles = commuteTiles(s, p, f);
      if (tiles > MAX_COMMUTE_TILES) continue;
      const v = offer[fid] * commuteKeep(tiles);
      if (v >= resW) f.applicants += 1;
      if (v > _bestValue) {
        _bestValue = v;
        _bestFirm = fid;
      }
    }
  };

  // ---- 4. the unemployed search ---------------------------------------------
  const seekers: number[] = [];
  for (let i = 0; i < nP; i++) {
    const p = people[i];
    if (p && p.alive && p.job < 0 && !p.means) seekers.push(i);
  }
  if (anyVacancy && seekers.length > 0) {
    shuffle(s, seekers);
    for (const pid of seekers) {
      const p = people[pid];
      const resW = reservationWage(s, p, typical[p.town] ?? BASE_WAGE);
      bestOffer(p, -1, resW);
      if (_bestFirm < 0) continue;
      let need = resW;
      if (headLevies) need = Math.max(0, need + headLevyDiff(s, p, _bestFirm));
      if (_bestValue >= need && _bestValue > 0) {
        const f = firms[_bestFirm];
        hire(s, f, p);
        slots[_bestFirm] -= 1;
      }
    }
  }

  // ---- 5. on-the-job search --------------------------------------------------
  if (anyVacancy) {
    for (let i = 0; i < nP; i++) {
      const p = people[i];
      if (!p || !p.alive || p.job < 0 || p.tenure <= 0) continue;
      if (rand(s) >= OTJ_SEARCH_PROB) continue;
      const cur = firms[p.job];
      if (!cur) continue;
      const curValue = netWage(s, wc, cur) * commuteKeep(p.commute);
      const need = curValue * (1 + OTJ_SWITCH_GAIN);
      bestOffer(p, p.job, need);
      if (_bestFirm < 0 || _bestValue < need || _bestValue <= 0) continue;
      p.lastWage = netWage(s, wc, cur);
      leaveJob(s, p);
      bump(s, 'quits');
      hire(s, firms[_bestFirm], p);
      slots[_bestFirm] -= 1;
    }
  }

  // ---- 6. clocks -----------------------------------------------------------------
  for (let i = 0; i < nF; i++) {
    const f = firms[i];
    if (!f) continue;
    if (!firmOpen(f)) {
      f.vacancyDays = 0;
      continue;
    }
    const cap = f.sector === 'stateworks' ? Number.MAX_SAFE_INTEGER : Math.max(0, f.capacity);
    const open = Math.min(wantLower(f), cap) - f.workers.length;
    f.vacancyDays = open > 0 ? f.vacancyDays + 1 : 0;
  }
  for (let i = 0; i < nP; i++) {
    const p = people[i];
    if (p && p.alive && p.job < 0 && !p.means) p.unempDays += 1;
  }
}

/**
 * Typical take-home wage per town (employment-weighted mean over firms), used as
 * the reservation anchor for people who have never worked (newcomers, new households).
 */
function typicalNet(s: SimState, wc: WageCtx): number[] {
  const sum = new Array(s.towns.length).fill(0);
  const n = new Array(s.towns.length).fill(0);
  for (const f of s.firms) {
    if (!f || !firmOpen(f) || f.workers.length === 0) continue;
    const w = netWage(s, wc, f);
    sum[f.town] += w * f.workers.length;
    n[f.town] += f.workers.length;
  }
  return sum.map((x, t) => (n[t] > 0 ? x / n[t] : BASE_WAGE));
}

/**
 * Reservation wage (take-home ¤/day, before any per-head adjustment): the last
 * wage earned (or the town's typical wage for someone who never worked), scaled
 * from RES_WAGE_START down to RES_WAGE_FLOOR as unemployment drags on, and lower
 * still for the hungry or nearly broke.
 */
export function reservationWage(s: SimState, p: Person, typical: number): number {
  const anchor = p.lastWage > 0 ? p.lastWage : Math.max(0, typical);
  const t = clamp(p.unempDays / Math.max(1, RES_WAGE_DECAY_DAYS), 0, 1);
  let r = anchor * (RES_WAGE_START + (RES_WAGE_FLOOR - RES_WAGE_START) * t);
  if (p.foodSat < HUNGRY_BELOW) r *= RES_WAGE_HUNGRY_MULT;
  // "Nearly broke": cash covers fewer than BROKE_DAYS of basic food at a rough price.
  const pBread = s.markets[p.town * N_GOODS + G.bread]?.ema ?? 1;
  if (p.cash < BROKE_DAYS * FOOD_NEED * Math.max(0.01, fin(pBread, 1))) r *= RES_WAGE_BROKE_MULT;
  return Math.max(0, fin(r));
}

/**
 * Change in per-head levies a person faces by taking a job at firm `fid`
 * (positive = working makes them pay more / receive less, e.g. a per-head
 * payment only the jobless receive). Computed by evaluating the person's
 * per-head levies as jobless and as employed.
 */
export function headLevyDiff(s: SimState, p: Person, fid: number): number {
  const saved = p.job;
  const ctx = { person: p, town: p.town };
  p.job = -1;
  const asJobless = fin(levyAmount(s, 'head', 'receiver', ctx, 0, 0));
  p.job = fid;
  const asWorker = fin(levyAmount(s, 'head', 'receiver', ctx, 0, 0));
  p.job = saved;
  return asWorker - asJobless;
}
