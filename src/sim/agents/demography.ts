// ============================================================================
// Demography: births, deaths (estates), immigration, emigration (capital
// flight), internal migration. OWNER: households agent. See DESIGN §3.1.
//
// A Person is a household with one potential worker, so a "birth" is a grown
// child forming a new household (age ADULT_AGE, seeded with a gift from the
// parent). Mortality rises with age (Gompertz-like) and with poor health; the
// starving die fast. People leave the realm when long unemployed, hungry or
// miserable — taking their deposits abroad (the foreign desk ends up holding the
// coin: capital flight) — and arrive when jobs outnumber job seekers and there is
// housing, bringing foreign coin with them.
// Estates pass whole to one heir (cash via the ledger, IOUs, gold, pantry, firms,
// houses, loans, projects), after any estate levy. The levy is assessed on the whole
// estate but paid from its coin first, then its IOUs and gold (at market prices);
// buildings and firms are never taken — whatever is still owed then lapses.
// ============================================================================
import { passStakes } from './ownership';
import * as CFG from '../config';
import * as CAL from '../calendar';
import { newPerson } from '../factory';
import * as GOODS_M from '../goods';
import * as LEDGER from '../ledger';
import { chargeLevy, levyAmount, matchLevies, noteRule } from '../policy/levies';
import * as RNG from '../rng';
import { rt } from '../runtime';
import { news } from '../stats/events';
import type { Person, Ref, SimState, TownId } from '../types';
import * as TYPES from '../types';
import * as UTIL from '../util';
import { personName } from '../world/names';
import { debtOf } from './bank';
import { noteLoss } from './credit';
import { firmAssets } from './firms';
import { findHome, leaveHome } from './housing';
import { hasLevyBase, leaveJob, netWage, wageCtx } from './labor';
import { landWealth, passPlots } from './land';

// Leaf-module constants and helpers (config, goods, util, calendar, types, rng, ledger — no
// import cycles back into agents) bound once at load: hot loops then read locals instead of
// live import bindings (which cost a getter call per read under tsx/vitest).
const { lognormal, rand, randInt, randRange } = RNG;
const { firmRef, pay, personRef, writeOff } = LEDGER;
const { ADULT_AGE, BASE_WAGE, BIRTH_GIFT_MAX_DAYS, BIRTH_GIFT_SHARE, BIRTH_MIN_HEALTH, BIRTH_RATE, DAYS_PER_MONTH, DAYS_PER_YEAR, DEATH_AGE_BASE, DEATH_AGE_PIVOT, DEATH_AGE_SCALE, DEATH_RATE, EMIGRATE_PROB_DAY, EMIGRATE_UNEMP_DAYS, HUNGER_DEATH_DAY, HUNGRY_BELOW, IMMIGRANT_CASH_DAYS, IMMIGRANT_COIN_SHARE, IMMIGRATION_DAY, IMMIGRATION_MAX_SHARE, IMMIGRATION_QUEUE_SHARE, IMMIGRATION_WAGE_FLOOR, MIGRATE_MIN_GAIN, MIGRATE_PROB_DAY, MIGRATE_UNEMP_DAYS, OWNER_EMIGRATE_MULT, POOR_HEALTH_MORT, STARVING_HEALTH, UNREST_CONTENT } = CFG;
const { HOUSE_SLOTS, N_GOODS } = GOODS_M;
const { clamp, fin } = UTIL;
const { dayOfMonth } = CAL;
const { FOREIGN, STATE } = TYPES;

function bump(s: SimState, key: string, v = 1): void {
  const acc = s.stats.acc;
  acc[key] = (acc[key] || 0) + v;
}

// Month-level counters for news (runtime only).
interface DemoCache {
  month: number;
  emigrants: number[];
}
function demoCache(s: SimState): DemoCache {
  const r = rt(s);
  let c = r.bag.demography as DemoCache | undefined;
  if (!c) {
    c = { month: Math.floor(s.day / DAYS_PER_MONTH), emigrants: [] };
    r.bag.demography = c;
  }
  return c;
}

/** Annual mortality multiplier by age (≈1 averaged over ages 18–80). */
export function ageMortality(age: number): number {
  return DEATH_AGE_BASE + (1 - DEATH_AGE_BASE) * Math.exp((fin(age, 40) - DEATH_AGE_PIVOT) / DEATH_AGE_SCALE);
}

/** Daily probability of death for a person. */
export function deathHazard(p: Person): number {
  const base = (DEATH_RATE / DAYS_PER_YEAR) * ageMortality(p.age) * (1 + POOR_HEALTH_MORT * Math.max(0, 0.6 - p.health));
  const starving = p.health < STARVING_HEALTH ? HUNGER_DEATH_DAY * (1 + (STARVING_HEALTH - p.health) / Math.max(0.01, STARVING_HEALTH)) : 0;
  return clamp(base + starving, 0, 0.5);
}

/** Per-town labour and housing tallies computed from agents (independent of stats' derived fields). */
interface Tallies {
  pop: number[];
  unemployed: number[];
  vacancies: number[];
  vacantSlots: number[];
  content: number[];
  /** Employment-weighted take-home wage (after worker-side wage levies). */
  wage: number[];
  /** Per-head payments (net of per-head takes) an employed resident receives, ¤/day (town mean). */
  head: number[];
}

function tallies(s: SimState): Tallies {
  const nT = s.towns.length;
  const z = () => new Array(nT).fill(0);
  const t: Tallies = { pop: z(), unemployed: z(), vacancies: z(), vacantSlots: z(), content: z(), wage: z(), head: z() };
  const heads = hasLevyBase(s, 'head');
  const hn = z();
  for (const p of s.people) {
    if (!p || !p.alive || p.town < 0 || p.town >= nT) continue;
    t.pop[p.town]++;
    if (p.job < 0 && !p.means) t.unemployed[p.town]++; // (people of means are out of the labour force)
    else if (heads) {
      t.head[p.town] -= fin(levyAmount(s, 'head', 'receiver', { person: p, town: p.town }, 0, 0));
      hn[p.town]++;
    }
    t.content[p.town] += p.contentment;
  }
  const wn = z();
  const wc = wageCtx(s);
  for (const f of s.firms) {
    if (!f || !f.alive || f.status !== 'active' || f.town < 0 || f.town >= nT) continue;
    const want = Math.max(0, Math.floor(fin(f.target) + 0.5));
    const cap = f.sector === 'stateworks' ? want : Math.max(0, f.capacity);
    t.vacancies[f.town] += Math.max(0, Math.min(want, cap) - f.workers.length);
    if (f.workers.length > 0) {
      t.wage[f.town] += netWage(s, wc, f) * f.workers.length;
      wn[f.town] += f.workers.length;
    }
  }
  for (const b of s.buildings) {
    if (!b || b.kind !== 'house' || b.status !== 'active' || b.town < 0 || b.town >= nT) continue;
    t.vacantSlots[b.town] += Math.max(0, b.slots - b.residents.length);
  }
  for (let i = 0; i < nT; i++) {
    t.content[i] = t.pop[i] > 0 ? t.content[i] / t.pop[i] : 0.6;
    t.wage[i] = wn[i] > 0 ? t.wage[i] / wn[i] : BASE_WAGE;
    t.head[i] = hn[i] > 0 ? t.head[i] / hn[i] : 0;
  }
  return t;
}

/** Labour-market pull of a town: (vacancies − unemployed) per head. */
function pull(t: Tallies, town: number): number {
  return (t.vacancies[town] - t.unemployed[town]) / Math.max(1, t.pop[town]);
}

/**
 * Daily: births (BIRTH_RATE/360 per healthy housed person), deaths (DEATH_RATE/360
 * + HUNGER_DEATH_DAY when health < STARVING_HEALTH), emigration
 * (EMIGRATE_PROB_DAY for long unemployed / miserable), internal migration
 * (MIGRATE_PROB_DAY for unemployed > 30 days toward towns with vacancies & housing).
 * Monthly: immigration while a town is hiring and its job seekers number fewer than its
 * vacancies + IMMIGRATION_QUEUE_SHARE of its people (Harris–Todaro), and vacant slots exist
 * (≤ IMMIGRATION_MAX_SHARE × town pop; those turned away for want of a home are kept in
 * town.housingWait, which house builders count as demand), arriving with small savings (minted? NO —
 * immigrants bring coin from abroad: pay(FOREIGN → person) capped by foreign.coin).
 * Accumulates stats.acc births/deaths/immigrants/emigrants.
 */
export function demographyStep(s: SimState): void {
  const dc = demoCache(s);
  const month = Math.floor(s.day / DAYS_PER_MONTH);
  if (dc.month !== month) {
    for (let t = 0; t < s.towns.length; t++) {
      const n = dc.emigrants[t] || 0;
      if (n >= 4) news(s, `${n} households left ${s.towns[t].name} for foreign shores last month, taking their savings with them.`, 'bad', t);
    }
    dc.month = month;
    dc.emigrants = [];
  }

  const dAge = 1 / DAYS_PER_YEAR;
  const n0 = s.people.length; // people created today are not processed today
  let tl: Tallies | null = null;
  for (let i = 0; i < n0; i++) {
    const p = s.people[i];
    if (!p || !p.alive) continue;
    p.age = fin(p.age, 30) + dAge;

    // ---- death ----
    if (rand(s) < deathHazard(p)) {
      killPerson(s, p, p.health < STARVING_HEALTH ? 'hunger' : p.age >= DEATH_AGE_PIVOT ? 'age' : 'other');
      continue;
    }

    // ---- emigration: push factors ----
    let push = 0;
    if (p.job < 0 && !p.means && p.unempDays > EMIGRATE_UNEMP_DAYS) push += 1;
    if (p.contentment < UNREST_CONTENT) push += 1;
    if (p.foodSat < HUNGRY_BELOW && p.health < 0.5) push += 1;
    if (push > 0) {
      if (p.owns.length > 0 || p.houses.length > 0) push *= OWNER_EMIGRATE_MULT;
      if (rand(s) < EMIGRATE_PROB_DAY * push) {
        emigrate(s, p);
        continue;
      }
    }

    // ---- internal migration of the long unemployed ----
    if (p.job < 0 && !p.means && p.unempDays > MIGRATE_UNEMP_DAYS && rand(s) < MIGRATE_PROB_DAY) {
      if (!tl) tl = tallies(s);
      let best = -1;
      let bestPull = pull(tl, p.town) + MIGRATE_MIN_GAIN;
      for (let t = 0; t < s.towns.length; t++) {
        if (t === p.town || tl.vacantSlots[t] <= 0) continue;
        const v = pull(tl, t);
        if (v > bestPull) {
          bestPull = v;
          best = t;
        }
      }
      if (best >= 0) {
        const from = p.town;
        if (findHome(s, p, best)) {
          p.town = best;
          bump(s, 'moves');
          tl.pop[from]--;
          tl.unemployed[from]--;
          tl.pop[best]++;
          tl.unemployed[best]++;
          tl.vacantSlots[best]--;
        }
      }
    }

    // ---- births: a grown child forms a household ----
    if (p.home >= 0 && p.health > BIRTH_MIN_HEALTH && p.foodSat >= HUNGRY_BELOW) {
      const prosperity = clamp((0.4 + p.contentment) / 1.2, 0.4, 1.2);
      if (rand(s) < (BIRTH_RATE / DAYS_PER_YEAR) * prosperity) birth(s, p);
    }
  }

  if (dayOfMonth(s.day) === IMMIGRATION_DAY) immigration(s);
}

function birth(s: SimState, parent: Person): void {
  const skill = clamp(0.5 * parent.skill + 0.5 * lognormal(s, 1, 0.15), 0.6, 1.6);
  const child = createPerson(s, parent.town, { age: ADULT_AGE, skill });
  child.expInfl = parent.expInfl;
  const gift = Math.min(Math.max(0, parent.cash) * BIRTH_GIFT_SHARE, BIRTH_GIFT_MAX_DAYS * Math.max(0, parent.income));
  if (gift > 0) pay(s, personRef(parent.id), personRef(child.id), gift, 'misc');
  findHome(s, child, parent.town);
  bump(s, 'births');
}

function immigration(s: SimState): void {
  const tl = tallies(s);
  for (let t = 0; t < s.towns.length; t++) {
    const gap = tl.vacancies[t] - tl.unemployed[t] + IMMIGRATION_QUEUE_SHARE * Math.max(tl.pop[t], 10);
    const slots = tl.vacantSlots[t];
    const town = s.towns[t];
    delete town.housingWait;
    let attract = clamp((tl.content[t] - 0.3) / 0.3, 0, 1);
    const cpi = s.towns[t].cpi > 1 ? s.towns[t].cpi : 100;
    const base = fin(s.stats.baseWage) > 0.5 ? s.stats.baseWage : BASE_WAGE;
    // What a working newcomer would live on here: take-home pay plus per-head payments. The
    // posted gross would make the statutory side of a wage levy decide who comes (a levy the
    // worker hands over leaves the posted wage high; one the employer pays lowers it).
    const rel = (tl.wage[t] + tl.head[t]) / (cpi / 100) / base;
    attract *= clamp((rel - IMMIGRATION_WAGE_FLOOR) / Math.max(0.01, 1 - IMMIGRATION_WAGE_FLOOR), 0, 1);
    town.pull = Math.round(fin(attract) * 1000) / 1000; // (entrepreneurs read it: likelyNewcomers)
    if (!(tl.vacancies[t] >= 1) || gap <= 0) continue;
    const cap = IMMIGRATION_MAX_SHARE * Math.max(tl.pop[t], 10);
    // those who would have come for the work but found no free home (house builders count them: entry.houseSignal)
    const turned = Math.max(0, Math.min(gap, cap) - Math.max(0, slots)) * attract;
    if (turned > 1e-6) town.housingWait = Math.round(turned * 100) / 100;
    if (slots <= 0) continue;
    const x = Math.min(gap, slots, cap) * attract;
    const n = Math.floor(x + rand(s));
    let arrived = 0;
    for (let k = 0; k < n; k++) {
      const p = createPerson(s, t, { age: randRange(s, 19, 40) });
      const want = lognormal(s, IMMIGRANT_CASH_DAYS * tl.wage[t], 0.4);
      const coin = Math.max(0, fin(s.foreign.coin)) * IMMIGRANT_COIN_SHARE;
      pay(s, FOREIGN, personRef(p.id), Math.min(want, coin), 'migrate');
      findHome(s, p, t);
      arrived++;
    }
    if (arrived > 0) bump(s, 'immigrants', arrived);
    if (arrived >= 3) news(s, `${arrived} newcomers arrived in ${s.towns[t].name} from abroad, drawn by work.`, 'good', t);
  }
}

/**
 * Newcomers a town could draw over the next `months` if it took on hands: at most IMMIGRATION_MAX_SHARE of its
 * people a month, as far as there are homes for them (free slots and houses being built), times how strongly it
 * drew them at the last arrivals (town.pull). Entrepreneurs count them among the hands they can hire.
 */
export function likelyNewcomers(s: SimState, town: number, months: number): number {
  const t = s.towns[town];
  if (!t || !(months > 0)) return 0;
  let homes = Math.max(0, fin(t.vacantSlots));
  for (const p of s.projects) if (p.kind === 'house' && p.town === town && p.status !== 'done' && p.status !== 'cancelled') homes += HOUSE_SLOTS;
  const cap = IMMIGRATION_MAX_SHARE * Math.max(fin(t.pop), 10) * months;
  return Math.min(homes, cap) * clamp(fin(t.pull ?? 0), 0, 1);
}

/**
 * Create a new living person in a town (not yet housed/employed). Uses s.ids.person.
 * `opts.cash` is an initial endowment written directly to the deposit — for world
 * initialisation only (which must call ledger.reconcileBank afterwards). During the
 * simulation, create the person without cash and fund them with ledger.pay.
 */
export function createPerson(s: SimState, town: TownId, opts?: { cash?: number; age?: number; skill?: number; name?: string }): Person {
  const p = newPerson(s, town, opts?.name ?? personName(s));
  p.age = opts?.age !== undefined ? fin(opts.age, 30) : randRange(s, ADULT_AGE, 75);
  p.skill = opts?.skill !== undefined ? clamp(fin(opts.skill, 1), 0.3, 2) : clamp(lognormal(s, 1, 0.15), 0.6, 1.6);
  if (opts?.cash !== undefined && opts.cash > 0) p.cash = fin(opts.cash);
  const infl = s.stats?.latest?.infl30;
  p.expInfl = clamp(fin(infl ?? 0), -0.2, 0.5);
  return p;
}

/** A random living heir, preferably in the same town; null if nobody is left. */
function pickHeir(s: SimState, p: Person): Person | null {
  const n = s.people.length;
  if (n > 1) {
    for (let k = 0; k < 40; k++) {
      const q = s.people[randInt(s, n)];
      if (q && q.alive && q.id !== p.id && q.town === p.town) return q;
    }
  }
  const local: Person[] = [];
  const any: Person[] = [];
  for (const q of s.people) {
    if (!q || !q.alive || q.id === p.id) continue;
    if (q.town === p.town) local.push(q);
    else any.push(q);
  }
  if (local.length) return local[randInt(s, local.length)];
  if (any.length) return any[randInt(s, any.length)];
  return null;
}

/** Market value of everything a person owns (for estate levies). */
export function estateValue(s: SimState, p: Person): number {
  const pIou = Math.max(0, fin(s.iouMarket?.ema, 0));
  const pGold = Math.max(0, fin(s.goldMarket?.ema, 0));
  let v = Math.max(0, p.cash) + p.iou * pIou + p.gold * pGold;
  const me = personRef(p.id);
  for (const b of s.buildings) if (b && b.owner === me && b.status !== 'ruin') v += Math.max(0, fin(b.cost));
  for (const f of s.firms) {
    if (!f || !f.alive || f.owner !== me) continue;
    const assets = fin(firmAssets(s, f));
    const gross = assets > 0 ? assets : Math.max(0, f.cash) + (f.building >= 0 ? Math.max(0, fin(s.buildings[f.building]?.cost ?? 0)) : 0);
    v += Math.max(0, gross - Math.max(0, fin(debtOf(s, firmRef(f.id)))));
  }
  v += landWealth(s, me); // land held unbuilt, at today's price (agents/land.ts)
  return fin(v);
}

/**
 * Pass every non-cash asset and claim of `p` to `heir` (or the Treasury if null):
 * IOUs, gold, pantry goods, firms, buildings, the bank's ownership, loans (written
 * off if the Treasury is the heir), construction projects and pending loan requests.
 */
function passAssets(s: SimState, p: Person, heir: Person | null): void {
  const me = personRef(p.id);
  const to: Ref = heir ? personRef(heir.id) : STATE;
  // IOUs & gold (not money: no ledger movement needed).
  if (p.iou > 0) {
    if (heir) heir.iou += p.iou;
    else s.treasury.iouOutstanding = Math.max(0, s.treasury.iouOutstanding - p.iou); // retired
  }
  p.iou = 0;
  if (p.gold > 0) {
    if (heir) heir.gold += p.gold;
    else s.treasury.gold += p.gold;
  }
  p.gold = 0;
  // Goods at home.
  const tg = s.treasury.goods[p.town];
  for (let g = 0; g < N_GOODS; g++) {
    const q = p.pantry[g];
    if (q > 0) {
      if (heir) heir.pantry[g] += q;
      else if (tg) tg[g] += q;
    }
    p.pantry[g] = 0;
  }
  // Firms: every stake (whole or part) passes to the heir (agents/ownership.ts; scans all firms).
  passStakes(s, me, to);
  // Land held unbuilt: to the heir, or back to its councils (agents/land.ts).
  passPlots(s, me, to);
  for (const f of s.firms) if (f && !f.alive && f.owner === me) f.owner = to; // closed firms' records
  // Buildings (houses and any other building the person held).
  for (const b of s.buildings) {
    if (!b || b.owner !== me) continue;
    b.owner = to;
    if (heir && b.kind === 'house' && heir.houses.indexOf(b.id) < 0) heir.houses.push(b.id);
  }
  if (s.bank.owner === p.id) s.bank.owner = heir ? heir.id : -1;
  // Debts follow the estate; with no heir they are uncollectable.
  for (const ln of s.loans) {
    if (!ln.active || ln.borrower !== me) continue;
    if (heir) ln.borrower = to;
    else {
      writeOff(s, ln.principal);
      noteLoss(s, ln, ln.principal);
      ln.principal = 0;
      ln.active = false;
    }
  }
  for (const pr of s.projects) {
    if (pr.owner === me) pr.owner = to;
    if (pr.partners) for (const q of pr.partners) if (q.ref === me) q.ref = to; // a stake in a venture being built
  }
  const rq = s.bank.requests;
  if (rq && rq.length) {
    let k = 0;
    for (let i = 0; i < rq.length; i++) if (rq[i].borrower !== me) rq[k++] = rq[i];
    rq.length = k;
  }
  p.owns = [];
  p.houses = [];
}

function retire(p: Person): void {
  p.alive = false;
  p.job = -1;
  p.home = -1;
  p.wage = 0;
  p.commute = 0;
  p.arrears = 0;
  p.budget = 0;
}

/** Unsigned amount one estate rule claims on an estate of `value` (same formula as levies.ruleAmount, qty 1). */
function estateRuleOwed(l: TYPES.Levy, value: number): number {
  const thr = l.threshold > 0 ? l.threshold : 0;
  let a = 0;
  if (l.unit === 'pct') a = l.rate * Math.max(0, value - thr);
  else if (thr > 0 && !(value > thr)) a = 0;
  else a = l.rate; // flat / per unit (one estate)
  return Number.isFinite(a) && a > 0 ? a : 0;
}

/**
 * Charge 'estate' levies (payer 'receiver') on the estate value before it passes on.
 * Fix: the claim is assessed on everything (cash, IOUs, gold, buildings, firms) but
 * chargeLevy can only take coin, so a 40 % rule on a firm owner collected ~4 % and all
 * the coin. Now each take rule's shortfall is collected in kind, still before the heir
 * inherits: IOUs pass to the Treasury (and are retired: iouOutstanding −= q), then gold,
 * both at market prices (the prices estateValue uses). If still short, nothing more is
 * taken — buildings and firms stay with the heir. No money moves in kind, so the
 * ledger is untouched; the rule's record counts the value collected in kind as well.
 */
function chargeEstate(s: SimState, p: Person): void {
  const me = personRef(p.id);
  const ctx = { town: p.town, person: p };
  const value = estateValue(s, p);
  const takes = matchLevies(s, 'estate', 'receiver', ctx).filter((l) => l.dir === 1);
  const before = takes.map((l) => l.today);
  chargeLevy(s, 'estate', me, 'receiver', ctx, value, 1);
  const pIou = Math.max(0, fin(s.iouMarket?.ema, 0));
  const pGold = Math.max(0, fin(s.goldMarket?.ema, 0));
  const t = s.treasury;
  for (let i = 0; i < takes.length; i++) {
    const l = takes[i];
    let short = estateRuleOwed(l, value) - (l.today - before[i]);
    if (!(short > 1e-9)) continue;
    let got = 0;
    if (p.iou > 1e-12 && pIou > 0) {
      const q = Math.min(p.iou, short / pIou);
      p.iou -= q;
      t.iouOutstanding = Math.max(0, t.iouOutstanding - q); // retired
      got += q * pIou;
      short -= q * pIou;
      bump(s, 'estate_iou', q);
    }
    if (short > 1e-9 && p.gold > 1e-12 && pGold > 0) {
      const q = Math.min(p.gold, short / pGold);
      p.gold -= q;
      t.gold += q;
      got += q * pGold;
      bump(s, 'estate_gold', q);
    }
    if (got > 0) noteRule(s, l, got);
  }
}

/**
 * A person dies: leave job and home; estate = cash, IOUs, gold, owned firms and
 * houses. Charge 'estate' levies (payer 'receiver' on the estate value, taken from
 * the estate's cash, then IOUs and gold — see chargeEstate), then pass everything to an heir (a
 * random living person, preferably in the same town) — cash via ledger.pay
 * (flow 'estate'); ownership refs updated (firm.owner, building.owner,
 * person.owns/houses). With no heir, everything goes to the Treasury.
 */
export function killPerson(s: SimState, p: Person, cause: 'age' | 'hunger' | 'other'): void {
  if (!p || !p.alive) return;
  const me = personRef(p.id);
  const town = p.town;
  const heir = pickHeir(s, p);
  const ownedFirm = s.firms.find((f) => f && f.alive && f.owner === me);
  leaveJob(s, p);
  leaveHome(s, p);
  if (hasLevyBase(s, 'estate')) chargeEstate(s, p);
  if (p.cash > 0) pay(s, me, heir ? personRef(heir.id) : STATE, p.cash, 'estate');
  passAssets(s, p, heir);
  retire(p);
  bump(s, 'deaths');
  if (cause === 'hunger') bump(s, 'starved');
  if (ownedFirm) {
    const who = heir ? heir.name : 'the Treasury';
    news(s, `${p.name}, owner of ${ownedFirm.name}, has died${cause === 'hunger' ? ' of hunger' : ''}; the estate passes to ${who}.`, 'info', town);
  }
}

/**
 * A person leaves the realm: cash → FOREIGN (pay flow 'migrate' — capital flight);
 * IOUs, gold, goods, firms and houses pass to an heir like an estate (no estate levy).
 */
export function emigrate(s: SimState, p: Person): void {
  if (!p || !p.alive) return;
  const me = personRef(p.id);
  const town = p.town;
  const heir = pickHeir(s, p);
  leaveJob(s, p);
  leaveHome(s, p);
  if (p.cash > 0) pay(s, me, FOREIGN, p.cash, 'migrate');
  passAssets(s, p, heir);
  retire(p);
  bump(s, 'emigrants');
  const dc = demoCache(s);
  if (town >= 0) dc.emigrants[town] = (dc.emigrants[town] || 0) + 1;
}
