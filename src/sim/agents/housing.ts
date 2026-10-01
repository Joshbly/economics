// ============================================================================
// Housing: rent, arrears, evictions, moving, landlords' rent setting.
// OWNER: households agent. See DESIGN §3.1.
//
// Housing is a matching market with sticky, landlord-set prices:
//  * every tenant pays its slot's daily rent to the landlord (a person, or the
//    Treasury for Treasury-built houses); 'rent' levies attach to that flow on
//    either side (a negative tenant-side levy is the Treasury paying part of the rent);
//  * tenants who cannot pay fall into arrears and are turned out after
//    EVICT_ARREARS_DAYS;
//  * the homeless take the cheapest acceptable vacant slot (rent + commuting cost);
//    long commuters occasionally move closer to work (possibly to another town);
//  * once a month landlords raise rents when their houses are full and there is
//    effective unmet demand (homeless who could pay, or a very tight market), cut
//    them when slots stay empty, and index to expected inflation — all clamped by
//    any legal rent bounds. A binding ceiling therefore shows up as persistent
//    homelessness and weaker incentives to build.
// ============================================================================
import * as CFG from '../config';
import * as CAL from '../calendar';
import * as LEDGER from '../ledger';
import { chargeLevy } from '../policy/levies';
import { noteBinding, rentBounds } from '../policy/limits';
import * as RNG from '../rng';
import { rt } from '../runtime';
import { news } from '../stats/events';
import type { Building, Firm, Person, Ref, SimState, TownId } from '../types';
import * as TYPES from '../types';
import * as UTIL from '../util';
import { commuteTiles, hasLevyBase, workX, workY } from './labor';
import { creditAppetite, quoted, quoteRate, requestLoan } from './bank';
import { noteCapitalIncome } from './means';

// Leaf-module constants and helpers (config, goods, util, calendar, types, rng, ledger — no
// import cycles back into agents) bound once at load: hot loops then read locals instead of
// live import bindings (which cost a getter call per read under tsx/vitest).
const { rand } = RNG;
const { councilTown, isCouncil, isFirm, isPerson, pay, personRef, refId } = LEDGER;
const { COMMUTE_COST_PER_TILE, EVICT_ARREARS_DAYS, MAX_RENT_SHARE, MIN_RENT, MOVE_CLOSER_PROB_DAY, MOVE_COMMUTE_TILES, MOVE_MIN_SAVING, RENT_CASH_COVER_DAYS, RENT_CUT_VACANT_DAYS, RENT_DEPOSIT_DAYS, RENT_DOWN, RENT_UP, VACANCY_TIGHT } = CFG;
const { clamp, dist, fin } = UTIL;
const { isMonthStart } = CAL;
const { STATE } = TYPES;

function bump(s: SimState, key: string, v = 1): void {
  const acc = s.stats.acc;
  acc[key] = (acc[key] || 0) + v;
}

// ---------------------------------------------------------------------------
// Runtime cache: house ids per town (rebuilt when buildings change)
// ---------------------------------------------------------------------------
interface HousingCache {
  version: number;
  count: number;
  byTown: number[][];
}

function cache(s: SimState): HousingCache {
  const r = rt(s);
  let c = r.bag.housing as HousingCache | undefined;
  if (!c) {
    c = { version: -1, count: -1, byTown: [] };
    r.bag.housing = c;
  }
  if (c.version !== r.buildingVersion || c.count !== s.buildings.length || c.byTown.length !== s.towns.length) {
    const byTown: number[][] = s.towns.map(() => []);
    for (const b of s.buildings) {
      if (b && b.kind === 'house' && byTown[b.town]) byTown[b.town].push(b.id);
    }
    c.byTown = byTown;
    c.version = r.buildingVersion;
    c.count = s.buildings.length;
  }
  return c;
}

/** House building ids in a town (any status; callers check status). */
export function housesInTown(s: SimState, town: TownId): number[] {
  return cache(s).byTown[town] ?? [];
}

function liveHouse(b: Building | undefined): b is Building {
  return !!b && b.kind === 'house' && b.status === 'active';
}

/** Valid landlord ref for rent payments: a living person, a firm that is alive, a town council, or the Treasury. */
function landlordOf(s: SimState, b: Building): Ref {
  const o = b.owner;
  if (o === STATE) return STATE;
  if (isCouncil(o)) return s.towns[councilTown(o)] ? o : STATE;
  if (isPerson(o)) {
    const q = s.people[o];
    return q && q.alive ? o : STATE;
  }
  if (isFirm(o)) {
    const f = s.firms[refId(o)];
    return f && f.alive ? o : STATE;
  }
  return STATE;
}

/** Rent a person would pay for a slot in b (owner-occupiers pay nothing). */
function rentFor(p: Person, b: Building): number {
  return b.owner === personRef(p.id) ? 0 : Math.max(0, fin(b.rent));
}

/** Most rent per day this person is willing and able to commit to. */
export function rentCapacity(p: Person): number {
  const inc = Math.max(fin(p.income), p.job >= 0 ? fin(p.wage) * 0.9 : 0, 0);
  return Math.max(MAX_RENT_SHARE * inc, Math.max(0, p.cash) / RENT_CASH_COVER_DAYS);
}

/** Housing cost of living in b: rent plus commuting cost to the current job (¤/day). */
function livingCost(s: SimState, p: Person, b: Building, job: Firm | null): number {
  let c = rentFor(p, b);
  if (job) {
    const d = dist(b.x + b.w / 2, b.y + b.h / 2, workX(s, job), workY(s, job));
    c += Math.max(0, fin(p.wage)) * COMMUTE_COST_PER_TILE * d;
  }
  return c;
}

function moveIn(s: SimState, p: Person, b: Building): void {
  if (p.home >= 0) leaveHome(s, p);
  b.residents.push(p.id);
  p.home = b.id;
  p.town = b.town;
  p.arrears = 0;
  if (p.job >= 0) {
    const f = s.firms[p.job];
    if (f) p.commute = commuteTiles(s, p, f);
  }
}

/**
 * Best vacant slot for p in a town, or -1. Owner-occupation of one's own house wins;
 * otherwise the lowest rent + commuting cost among affordable slots (unless `force`).
 */
function bestSlot(s: SimState, p: Person, town: TownId, force: boolean, exclude = -1): { id: number; cost: number } {
  const list = housesInTown(s, town);
  const job = p.job >= 0 ? s.firms[p.job] ?? null : null;
  const capacity = rentCapacity(p);
  const me = personRef(p.id);
  let best = -1;
  let bestCost = Number.MAX_VALUE;
  for (let i = 0; i < list.length; i++) {
    const b = s.buildings[list[i]];
    if (!liveHouse(b) || b.id === exclude || b.residents.length >= b.slots) continue;
    const rent = rentFor(p, b);
    if (!force && (rent > capacity || p.cash < RENT_DEPOSIT_DAYS * rent)) continue;
    let cost = livingCost(s, p, b, job);
    if (b.owner === me) cost -= 1e6; // live in your own house if you can
    if (cost < bestCost) {
      bestCost = cost;
      best = b.id;
    }
  }
  return { id: best, cost: bestCost };
}

/**
 * Try to house a person in a town. Returns true on success. Picks the cheapest
 * acceptable vacant slot (rent + commuting cost, rent ≤ what the person can
 * afford — MAX_RENT_SHARE of income, or a cash cushion of RENT_CASH_COVER_DAYS —
 * and cash for RENT_DEPOSIT_DAYS of rent up front).
 * Moving in changes the person's residence town to `town`.
 * `opts.force` skips the affordability test (world initialisation).
 */
export function findHome(s: SimState, p: Person, town: TownId, opts?: { force?: boolean }): boolean {
  if (!p || !p.alive || !s.towns[town]) return false;
  const r = bestSlot(s, p, town, !!opts?.force);
  if (r.id < 0) return false;
  moveIn(s, p, s.buildings[r.id]);
  return true;
}

/** Remove a person from their home (eviction, death, emigration, moving). */
export function leaveHome(s: SimState, p: Person): void {
  if (p.home >= 0) {
    const b = s.buildings[p.home];
    if (b) {
      const r = b.residents;
      const i = r.indexOf(p.id);
      if (i >= 0) r.splice(i, 1);
    }
  }
  p.home = -1;
  p.arrears = 0;
  if (p.job >= 0) {
    const f = s.firms[p.job];
    if (f) p.commute = commuteTiles(s, p, f);
  }
}

/** Pay one day of rent (with rent levies on both sides). Returns false if the tenant could not pay. */
function payRent(s: SimState, p: Person, b: Building, levies: boolean): boolean {
  const rent = rentFor(p, b);
  if (rent <= 0) return true;
  if (p.cash < rent) return false;
  const to = landlordOf(s, b);
  const me = personRef(p.id);
  const paid = pay(s, me, to, rent, 'rent');
  if (isPerson(to)) {
    s.people[to].earned += paid;
    noteCapitalIncome(s.people[to], paid); // rents received (agents/means.ts)
  }
  if (levies && paid > 0) {
    // chargeLevy leaves agent bookkeeping to the caller: a take lowers what the payer
    // earned today, a give (the Treasury paying part of the rent) raises it.
    const ctx = { town: b.town, person: p, kind: b.kind };
    const netT = chargeLevy(s, 'rent', me, 'tenant', ctx, paid, 1);
    p.earned -= netT;
    if (to !== STATE) {
      const lp = isPerson(to) ? s.people[to] : undefined;
      const lctx = lp ? { town: b.town, person: lp, kind: b.kind } : { town: b.town, kind: b.kind };
      const netL = chargeLevy(s, 'rent', to, 'landlord', lctx, paid, 1);
      if (lp) {
        lp.earned -= netL;
        noteCapitalIncome(lp, -netL);
      }
      else if (isFirm(to)) {
        const f = s.firms[refId(to)];
        if (f) f.otherCosts += netL;
      }
    }
  }
  return paid >= rent - 1e-9;
}

/**
 * Daily: tenants pay rent (building.rent per slot) to the landlord via ledger.pay
 * (flow 'rent'), with 'rent' levies (payer tenant or landlord). Unpaid → arrears;
 * EVICT_ARREARS_DAYS → eviction (homeless). Homeless people take the best vacant slot
 * in their town (rent ≤ MAX_RENT_SHARE × income, lowest rent + commute).
 * Long commuters (> MOVE_COMMUTE_TILES) move closer with MOVE_CLOSER_PROB_DAY.
 * Monthly (month start): landlords adjust rent (RENT_UP when full and people are
 * homeless in town, RENT_DOWN when vacant ≥ 30 days, plus inflation expectation),
 * clamped by rent Limits. Updates building.vacantDays, town.homeless/vacantSlots.
 */
export function housingStep(s: SimState): void {
  housingDay(s);
  landlordFinance(s);
}

function housingDay(s: SimState): void {
  const c = cache(s);
  const people = s.people;
  const nT = s.towns.length;
  if (CAL.dayOfMonth(s.day) === 1) {
    // Report last month's eviction waves, then reset.
    for (let t = 0; t < nT; t++) {
      const n = s.towns[t].evictions || 0;
      if (n >= 5) news(s, `Landlords in ${s.towns[t].name} turned out ${n} households for unpaid rent last month.`, 'bad', t);
      s.towns[t].evictions = 0;
    }
  }

  // ---- legal rent bounds (apply immediately) + resident list hygiene -----------
  const bounds = s.towns.map((t) => rentBounds(s, t.id));
  for (let t = 0; t < nT; t++) {
    const bd = bounds[t];
    let ceilBinds = false;
    let floorBinds = false;
    for (const id of c.byTown[t] ?? []) {
      const b = s.buildings[id];
      if (!b) continue;
      if (b.status !== 'active') {
        // Condemned or not yet finished: nobody can live here.
        for (const pid of b.residents.slice()) {
          const p = people[pid];
          if (p && p.home === b.id) leaveHome(s, p);
        }
        b.residents.length = 0;
        continue;
      }
      // Drop stale entries (dead, moved) and duplicates.
      const r = b.residents;
      let k = 0;
      for (let j = 0; j < r.length; j++) {
        const p = people[r[j]];
        if (p && p.alive && p.home === b.id && r.indexOf(r[j]) === j) r[k++] = r[j];
      }
      r.length = k;
      b.rent = clampRent(s, b.rent, bd, t);
      // A ceiling binds when a full house sits at it; a floor binds when an empty slot sits at it.
      if (bd && bd.max >= 0 && b.rent >= bd.max - 1e-9 && r.length >= b.slots) ceilBinds = true;
      if (bd && bd.min >= 0 && b.rent <= bd.min + 1e-9 && r.length < b.slots) floorBinds = true;
    }
    if (ceilBinds) noteBinding(s, 'rentMax', -1, t);
    if (floorBinds) noteBinding(s, 'rentMin', -1, t);
  }

  // ---- rent, arrears, eviction ----------------------------------------------------
  const levies = hasLevyBase(s, 'rent');
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    if (!p || !p.alive || p.home < 0) continue;
    const b = s.buildings[p.home];
    if (!liveHouse(b) || b.residents.indexOf(p.id) < 0) {
      p.home = -1;
      p.arrears = 0;
      continue;
    }
    if (payRent(s, p, b, levies)) {
      // Catch up on one day of arrears when there is a cushion.
      if (p.arrears > 0 && p.cash >= 3 * rentFor(p, b) && payRent(s, p, b, levies)) p.arrears -= 1;
      else if (p.arrears > 0 && rentFor(p, b) <= 0) p.arrears = 0;
    } else {
      p.arrears += 1;
      if (p.arrears >= EVICT_ARREARS_DAYS) {
        leaveHome(s, p);
        bump(s, 'evictions');
        const tw = s.towns[b.town];
        if (tw) tw.evictions = (tw.evictions || 0) + 1;
      }
    }
  }

  // ---- vacancy clocks -----------------------------------------------------------
  for (let t = 0; t < nT; t++) {
    for (const id of c.byTown[t] ?? []) {
      const b = s.buildings[id];
      if (!liveHouse(b)) continue;
      b.vacantDays = b.residents.length < b.slots ? b.vacantDays + 1 : 0;
    }
  }

  // ---- the homeless look for a place (own town, or the town where they work) -----
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    if (!p || !p.alive || p.home >= 0) continue;
    let best = bestSlot(s, p, p.town, false);
    let town = p.town;
    if (p.job >= 0) {
      const f = s.firms[p.job];
      if (f && f.town !== p.town) {
        const alt = bestSlot(s, p, f.town, false);
        if (alt.id >= 0 && (best.id < 0 || alt.cost < best.cost)) {
          best = alt;
          town = f.town;
        }
      }
    }
    if (best.id >= 0) {
      moveIn(s, p, s.buildings[best.id]); // moves residence to the house's town
      if (town !== p.town) p.town = town;
    }
  }

  // ---- long commuters move closer to work -------------------------------------------
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    if (!p || !p.alive || p.job < 0 || p.home < 0 || p.commute <= MOVE_COMMUTE_TILES) continue;
    if (rand(s) >= MOVE_CLOSER_PROB_DAY) continue;
    const f = s.firms[p.job];
    const cur = s.buildings[p.home];
    if (!f || !liveHouse(cur)) continue;
    if (cur.owner === personRef(p.id)) continue; // owner-occupiers stay put
    const curCost = livingCost(s, p, cur, f);
    let best = bestSlot(s, p, f.town, false, cur.id);
    if (f.town !== p.town) {
      const alt = bestSlot(s, p, p.town, false, cur.id);
      if (alt.id >= 0 && (best.id < 0 || alt.cost < best.cost)) best = alt;
    }
    if (best.id < 0) continue;
    const nb = s.buildings[best.id];
    const d = dist(nb.x + nb.w / 2, nb.y + nb.h / 2, workX(s, f), workY(s, f));
    if (d >= p.commute - 1 || best.cost > curCost * (1 - MOVE_MIN_SAVING)) continue;
    moveIn(s, p, nb);
    bump(s, 'moves');
  }

  // ---- tallies ------------------------------------------------------------------------
  const homeless = new Array(nT).fill(0);
  const homelessDemand = new Array(nT).fill(0); // homeless who could pay the town's average rent
  const vacantSlots = new Array(nT).fill(0);
  const totalSlots = new Array(nT).fill(0);
  const rentSum = new Array(nT).fill(0);
  const rentN = new Array(nT).fill(0);
  for (let t = 0; t < nT; t++) {
    for (const id of c.byTown[t] ?? []) {
      const b = s.buildings[id];
      if (!liveHouse(b)) continue;
      totalSlots[t] += b.slots;
      vacantSlots[t] += Math.max(0, b.slots - b.residents.length);
      rentSum[t] += b.rent * b.slots;
      rentN[t] += b.slots;
    }
  }
  let expInfl = 0;
  let alive = 0;
  let homelessAll = 0;
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    if (!p || !p.alive) continue;
    alive++;
    expInfl += fin(p.expInfl);
    if (p.home >= 0) continue;
    homelessAll++;
    const t = p.town;
    if (t < 0 || t >= nT) continue;
    homeless[t]++;
    const avgRent = rentN[t] > 0 ? rentSum[t] / rentN[t] : 0;
    if (rentCapacity(p) >= avgRent) homelessDemand[t]++;
  }
  for (let t = 0; t < nT; t++) {
    s.towns[t].homeless = homeless[t];
    s.towns[t].vacantSlots = vacantSlots[t];
  }
  bump(s, 'homeless', homelessAll);

  // ---- monthly rent setting -----------------------------------------------------------
  if (isMonthStart(s.day)) {
    const infl = clamp(alive > 0 ? expInfl / alive : 0, -0.1, 0.5);
    for (let t = 0; t < nT; t++) {
      const vacRate = totalSlots[t] > 0 ? vacantSlots[t] / totalSlots[t] : 0;
      for (const id of c.byTown[t] ?? []) {
        const b = s.buildings[id];
        if (!liveHouse(b) || b.slots <= 0) continue;
        const full = b.residents.length >= b.slots;
        let m = 1;
        // A full house has pricing power only while the town has hardly any room left: with
        // empty slots elsewhere in town, the homeless who could pay would simply move there.
        // (Raising rents on full houses whenever someone is homeless ratchets rents far above
        // what wages pay while whole houses stand empty — and leaves people on the street.)
        const tight = vacRate < 2 * VACANCY_TIGHT;
        if (full && homelessDemand[t] > 0 && tight) m += RENT_UP;
        else if (full && vacRate < VACANCY_TIGHT) m += RENT_UP / 2;
        // An empty room earns nothing: the longer it has stood empty, the deeper the cut
        // (RENT_DOWN a month after RENT_CUT_VACANT_DAYS, up to three times that after three such spells).
        else if (!full && b.vacantDays >= RENT_CUT_VACANT_DAYS) m -= RENT_DOWN * Math.min(3, b.vacantDays / RENT_CUT_VACANT_DAYS);
        // Only a landlord whose rooms are let passes expected inflation on (and a falling price
        // level lowers every rent).
        if (full || infl < 0) m *= 1 + infl / 12;
        b.rent = clampRent(s, b.rent * m, bounds[t], t);
      }
    }
  }
}

/** Clamp a rent to the legal bounds of its town and the MIN_RENT floor (a legal maximum below the floor wins). */
function clampRent(s: SimState, rent: number, bd: { min: number; max: number } | undefined, town: TownId): number {
  let r = Math.max(MIN_RENT, fin(rent, MIN_RENT));
  if (bd) {
    if (bd.max >= 0 && r > bd.max) r = Math.max(0, bd.max);
    if (bd.min >= 0 && r < bd.min) r = bd.min;
  }
  return r;
}

// ---------------------------------------------------------------------------
// Landlords' mortgages
// ---------------------------------------------------------------------------

/**
 * The mortgage a landlord carries on houses of book value `value` that bring in `rentDay` ¤/day,
 * at loan rate `rate`: HOUSE_DEBT_LTV of the value × bank.creditAppetite (more when money is
 * cheaper, less when dearer), nothing once the rate reaches the rent yield; interest + amortisation over `term` days within HOUSE_DEBT_MAX_SERVICE of the rent.
 * Shared by world/init (the founding mortgages) and landlordFinance (the steady state).
 */
export function desiredHouseDebt(value: number, rentDay: number, rate: number, term: number): number {
  if (!(value > 0) || !(rentDay > 0)) return 0;
  const { HOUSE_DEBT_LTV, HOUSE_DEBT_MAX_SERVICE, DAYS_PER_YEAR } = CFG;
  const r = fin(rate);
  if ((rentDay * DAYS_PER_YEAR) / value <= r) return 0; // nobody borrows against houses at more than they yield
  const m = creditAppetite(r);
  const cap = (HOUSE_DEBT_MAX_SERVICE * rentDay) / Math.max(1e-9, 1 / Math.max(1, term) + r / DAYS_PER_YEAR);
  return Math.max(0, Math.min(HOUSE_DEBT_LTV * m * value, cap));
}

/**
 * Each landlord reviews their mortgage once a month (staggered by id): on the houses' book value
 * and the rent they bring in, at the rate the bank would charge them.
 * Below HOUSE_DEBT_TOPUP of the desired debt they borrow the rest (a 'house' loan against the
 * houses they own — mortgages roll over as they amortise, so the credit stock keeps pace with the
 * housing stock); above HOUSE_DEBT_PAYDOWN of it they pay down (≤ HOUSE_DEBT_PAYDOWN_MONTH of the
 * debt a month) with cash beyond HOUSE_DEBT_KEEP_DAYS of income. Dearer money → less mortgage credit, cheaper → more.
 */
function landlordFinance(s: SimState): void {
  const { DAYS_PER_MONTH, HOUSE_DEBT_TOPUP, HOUSE_DEBT_PAYDOWN, HOUSE_DEBT_KEEP_DAYS, HOUSE_DEBT_PAYDOWN_MONTH, HOUSE_LOAN_TERM, BANK_MIN_LOAN } = CFG;
  if (s.bank.failed) return;
  const slot = s.day % DAYS_PER_MONTH;
  for (const p of s.people) {
    if (!p || !p.alive || !p.houses.length || p.id % DAYS_PER_MONTH !== slot) continue;
    let value = 0;
    let rentIn = 0;
    for (const hid of p.houses) {
      const b = s.buildings[hid];
      if (!b || b.status !== 'active') continue;
      value += Math.max(0, fin(b.cost));
      for (const rid of b.residents) if (rid !== p.id) rentIn += Math.max(0, fin(b.rent));
    }
    if (!(value > 0)) continue;
    const ref = personRef(p.id);
    let debt = 0;
    for (const ln of s.loans) if (ln.active && ln.borrower === ref && ln.purpose === 'house') debt += ln.principal;
    const r = quoteRate(s, ref, 0);
    if (!quoted(r) && !(debt > 0)) continue;
    const want = !quoted(r) ? debt : desiredHouseDebt(value, rentIn, r, HOUSE_LOAN_TERM);
    if (debt < HOUSE_DEBT_TOPUP * want) {
      const amount = want - debt;
      if (amount >= Math.max(BANK_MIN_LOAN, 0.02 * value) && quoted(quoteRate(s, ref, amount))) {
        requestLoan(s, { borrower: ref, amount, term: HOUSE_LOAN_TERM, purpose: 'house', project: -1 });
      }
    } else if (debt > HOUSE_DEBT_PAYDOWN * want) {
      let room = Math.min(debt - want, HOUSE_DEBT_PAYDOWN_MONTH * debt, Math.max(0, p.cash) - HOUSE_DEBT_KEEP_DAYS * Math.max(0, fin(p.income)));
      if (!(room > 1)) continue;
      for (const ln of s.loans) {
        if (!(room > 0.01)) break;
        if (!ln.active || ln.borrower !== ref || ln.purpose !== 'house' || !(ln.principal > 0)) continue;
        const a = LEDGER.repayPrincipal(s, ref, Math.min(room, ln.principal));
        ln.principal -= a;
        room -= a;
        s.stats.acc.loans_prepaid = (s.stats.acc.loans_prepaid || 0) + a;
        if (ln.principal <= 1e-6) {
          if (ln.principal > 0) LEDGER.writeOff(s, ln.principal);
          ln.principal = 0;
          ln.active = false;
        }
      }
    }
  }
}
