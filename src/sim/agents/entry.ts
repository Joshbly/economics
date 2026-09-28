// ============================================================================
// Entrepreneurship: new firms, reopenings, expansions, house building.
// OWNER: firms agent. See DESIGN §3.2 (Entry & expansion).
//
// Economics:
//  * Entry follows returns on capital (Tobin's q): each month, for every town and
//    trade, the expected annual profit of one more workshop (the mean profit of the
//    town's mature firms of that trade, or — where there are none yet — an estimate
//    at a typical size and today's prices and wages) is set against its replacement
//    cost (the building at today's prices + tools + start-up working capital).
//    Only when that return beats the bank's lending rate + ENTRY_HURDLE does anyone
//    build, and the probability grows with the margin. Dearer money therefore
//    shuts entry down quickly; cheap money and rising prices open it up.
//  * Capital is scarce: an entrepreneur must be a person with savings to spare for
//    the equity (ENTRY_OWNER_EQUITY, more if the bank asks for it), the rest comes
//    from a start-up loan the bank may refuse; at most ENTRY_MAX_PER_TOWN new
//    private jobs per town per month, and none while the builder has a backlog.
//  * Cheapest capacity first: reopen a vacant building of the trade, else enlarge a
//    profitable firm that is at capacity (the firm borrows to invest), else build new.
//  * Developers build houses when a town is short of homes (vacancy under
//    HOUSE_VACANCY_TRIGGER, or more homeless than empty slots) and the rent yield
//    beats the loan rate + HOUSE_HURDLE.
//  * Exit: firms whose profit EMA has been negative for EXIT_LOSS_DAYS close.
//
// Financing flow (the bank decides requests in bankEndDay, which runs before this
// step): on decision day the project is created (status 'queued', loanWanted > 0,
// no work starts) and a loan is requested with the project id; the entrepreneur's
// equity stays in their account so the bank sees it as collateral. When the loan is
// granted (bank sets project.loan), the owner advances equity + loan proceeds to the
// builder in the same evening (project.prepaid) — the money never sits idle in a
// household account where it would be spent. A refusal (or no answer within
// FINANCING_WAIT_DAYS) cancels the plan. Owners rich enough fund everything at once.
// ============================================================================
import {
  ENTRY_DAY,
  ENTRY_HURDLE,
  ENTRY_MAX_OWNED,
  ENTRY_MAX_PER_TOWN,
  ENTRY_MAX_PROB,
  ENTRY_MIN_AGE,
  ENTRY_NEW_SECTOR_DISCOUNT,
  ENTRY_OWNER_EQUITY,
  ENTRY_OWNER_RESERVE_DAYS,
  ENTRY_PROB_SLOPE,
  ENTRY_SCREEN_SPREAD,
  ENTRY_SHORTAGE_BONUS,
  BUILDER_MAX_PRIVATE_QUEUE,
  CASH_TARGET_DAYS,
  DAYS_PER_YEAR,
  EXIT_LOSS_DAYS,
  EXIT_MAX_PER_TRADE,
  EXIT_MIN_AGE,
  EXIT_PATIENT_CASH_DAYS,
  EXIT_PROB,
  FINANCING_WAIT_DAYS,
  HOUSE_HURDLE,
  HOUSE_LOAN_TERM,
  HOUSE_VACANCY_TRIGGER,
  INVEST_LOAN_TERM,
  MAX_BUILDING_LEVEL,
  NEW_FIRM_WC_DAYS,
  STARTUP_LOAN_TERM,
  BASE_RENT_SHARE,
} from '../config';
import { dayOfMonth } from '../calendar';
import { G, HOUSE_SLOTS, PRODUCER_SECTORS, SECTORS } from '../goods';
import { cashOf, firmRef, isFirm, isPerson, pay, refId } from '../ledger';
import { expectedGross, expectedNet, marketOf } from '../market/markets';
import { chance, rand } from '../rng';
import { news } from '../stats/events';
import type { Building, Firm, LoanPurpose, Project, Ref, Sector, SimState, TownId } from '../types';
import { STATE } from '../types';
import { fin } from '../util';
import { findSite } from '../world/layout';
import { quoteRate, requestLoan } from './bank';
import { builderFor, estimateCost, startProject, cancelProject, type ProjectSpec } from './construction';
import { closeFirm, defaultWage, firmDailyCost, isEssentialFirm, typicalDailyCost } from './firms';
import { materialCostPerUnit, potentialOutput, toolCostPerUnit } from './production';

// ---------------------------------------------------------------------------
// Money of would-be investors
// ---------------------------------------------------------------------------

/** Cash an owner can put into a project without going short. */
export function investableCash(s: SimState, ref: Ref): number {
  if (isPerson(ref)) {
    const p = s.people[ref];
    if (!p || !p.alive) return 0;
    const keep = ENTRY_OWNER_RESERVE_DAYS * Math.max(fin(p.income), 0.5 * defaultWage(s, p.town));
    return Math.max(0, p.cash - keep);
  }
  if (isFirm(ref)) {
    const f = s.firms[refId(ref)];
    if (!f || !f.alive || f.status !== 'active') return 0;
    return Math.max(0, f.cash - CASH_TARGET_DAYS * firmDailyCost(s, f));
  }
  return 0;
}

/** Loan purpose and term for a project owned by `owner`. */
function financing(kind: Project['kind'], owner: Ref): { purpose: LoanPurpose; term: number } {
  if (kind === 'house') return { purpose: 'house', term: HOUSE_LOAN_TERM };
  if (isFirm(owner)) return { purpose: 'invest', term: INVEST_LOAN_TERM };
  return { purpose: 'startup', term: STARTUP_LOAN_TERM };
}

/** Annual rate used to screen investments before a borrower is chosen. */
function screenRate(s: SimState): number {
  const q = quoteRate(s, -1, 0);
  const base = fin(s.bank.baseRate, 0.045) + ENTRY_SCREEN_SPREAD;
  return q >= 0 ? Math.max(q, fin(s.bank.depositRate, 0)) : base;
}

/** Total money a project needs: the works plus, for a new workshop, its tools and start-up working capital. */
function projectTotal(s: SimState, kind: Project['kind'], town: TownId, sector?: Sector | ''): number {
  let c = estimateCost(s, kind, town, sector || undefined);
  if ((kind === 'firm' || kind === 'reopen') && sector && SECTORS[sector]) {
    const d = SECTORS[sector];
    const n = Math.min(d.capacityPerLevel, d.typicalSize);
    c += NEW_FIRM_WC_DAYS * typicalDailyCost(s, sector, town);
    c += d.toolsPerWorker * n * Math.max(0, fin(expectedGross(s, town, G.tools)));
  }
  return Math.max(0, fin(c));
}

// ---------------------------------------------------------------------------
// Daily: financing follow-up
// ---------------------------------------------------------------------------

/**
 * Projects waiting for their loan: once the bank has granted it (project.loan set),
 * the owner advances equity + proceeds to the builder; a refused or unanswered
 * request cancels the plan.
 */
export function settleFinancing(s: SimState): void {
  const pending = new Set<number>();
  for (const r of s.bank.requests ?? []) if (r.project >= 0) pending.add(r.project);
  const waiting: Project[] = [];
  for (const p of s.projects) if (fin(p.loanWanted) > 0 && p.status !== 'done' && p.status !== 'cancelled') waiting.push(p);
  for (const p of waiting) {
    if (p.loan >= 0) {
      const b = s.firms[p.builder];
      if (!b || !b.alive) {
        cancelProject(s, p.id);
        continue;
      }
      // Advance everything the owner can spare, at least the loan itself, up to the project's needs.
      const total = Math.max(projectTotal(s, p.kind, p.town, p.sector), fin(p.loanWanted));
      const avail = p.owner === STATE ? cashOf(s, STATE) : Math.max(investableCash(s, p.owner), Math.min(fin(p.loanWanted), cashOf(s, p.owner)));
      const amt = Math.min(total, avail);
      const paid = amt > 0 ? pay(s, p.owner, firmRef(b.id), amt, 'asset') : 0;
      p.prepaid = fin(p.prepaid) + paid;
      p.loanWanted = 0;
      continue;
    }
    const age = s.day - p.created;
    if ((age >= 1 && !pending.has(p.id)) || age > FINANCING_WAIT_DAYS) {
      const what = p.kind === 'house' ? 'new houses' : p.sector ? `a ${SECTORS[p.sector as Sector]?.name ?? 'workshop'}` : 'a building';
      const tn = s.towns[p.town]?.name ?? 'town';
      cancelProject(s, p.id);
      news(s, `Plans for ${what} in ${tn} were shelved: the Bank would not lend for them.`, 'info', p.town);
    }
  }
}

// ---------------------------------------------------------------------------
// Monthly: signals
// ---------------------------------------------------------------------------

interface SectorSignal {
  roc: number; // expected annual return on replacement capital
  capFirm: Firm | null; // profitable firm at capacity (expansion candidate)
  vacant: Building | null; // vacant building of the trade (reopening candidate)
}

/** Annual profit of a typical new workshop at today's prices and wages (average site, average season). */
export function typicalAnnualProfit(s: SimState, town: TownId, sector: Sector): number {
  const d = SECTORS[sector];
  if (!d || !d.producer) return 0;
  const n = Math.min(d.capacityPerLevel, d.typicalSize);
  const leff = n * 0.95;
  const q = potentialOutput(sector, leff, d.toolsPerWorker * leff, 1, 1);
  const prices: number[] = [];
  for (let g = 0; g < 11; g++) prices.push(fin(expectedGross(s, town, g), 1));
  const pNet = fin(expectedNet(s, town, d.out), 0);
  const mc = materialCostPerUnit(sector, prices);
  const tc = toolCostPerUnit(sector, prices[G.tools], q / Math.max(1, n), fin(s.bank.baseRate, 0.045));
  const w = defaultWage(s, town);
  return (q * (pNet - mc - tc) - n * w) * DAYS_PER_YEAR;
}

function sectorSignal(s: SimState, town: TownId, sector: Sector): SectorSignal | null {
  const d = SECTORS[sector];
  const capital = projectTotal(s, 'firm', town, sector);
  if (!(capital > 0)) return null;
  let n = 0;
  let sum = 0;
  let any = false;
  let capFirm: Firm | null = null;
  for (const f of s.firms) {
    if (!f || !f.alive || f.status !== 'active' || f.sector !== sector || f.town !== town) continue;
    const b = f.building >= 0 ? s.buildings[f.building] : undefined;
    if (!b || b.status !== 'active') continue;
    any = true;
    if (s.day - f.founded >= ENTRY_MIN_AGE) {
      n++;
      sum += fin(f.profit);
    }
    const atCap = f.capacity > 0 && f.target >= f.capacity - 0.5 && f.workers.length >= 0.9 * f.capacity;
    if (atCap && f.profit > 0 && b.project < 0 && (b.level || 1) < MAX_BUILDING_LEVEL && (!capFirm || f.profit > capFirm.profit)) capFirm = f;
  }
  const m = marketOf(s, town, d.out);
  let annual: number;
  if (n > 0) annual = (sum / n) * DAYS_PER_YEAR;
  else if (any) return null; // only young firms: wait for evidence
  else {
    // A trade new to (or gone from) the town: there must be buyers here already — trade,
    // unmet demand, or at least bids standing in the order book with nobody to sell.
    const bids = (m.curve?.bids.length ?? 0) > 0 || m.bestBid > 0;
    if (!(fin(m.volEma) > 1e-6 || fin(m.shortage) > 1e-6 || bids)) return null;
    annual = typicalAnnualProfit(s, town, sector) * ENTRY_NEW_SECTOR_DISCOUNT;
  }
  let roc = annual / capital;
  if (fin(m.volEma) > 1e-6) roc += ENTRY_SHORTAGE_BONUS * Math.min(1, fin(m.shortage) / m.volEma);
  let vacant: Building | null = null;
  for (const b of s.buildings) {
    if (b && b.kind === 'firm' && b.status === 'vacant' && b.sector === sector && b.town === town && b.project < 0) {
      vacant = b;
      break;
    }
  }
  return { roc: fin(roc), capFirm, vacant };
}

/** Rent yield of a new house if the town is short of homes, else null. */
function houseSignal(s: SimState, town: TownId): number | null {
  let slots = 0;
  let occupied = 0;
  for (const b of s.buildings) {
    if (!b || b.kind !== 'house' || b.town !== town || b.status !== 'active') continue;
    slots += Math.max(0, b.slots);
    occupied += Math.min(Math.max(0, b.slots), b.residents.length);
  }
  let pipeline = 0;
  for (const p of s.projects) if (p.kind === 'house' && p.town === town && p.status !== 'done' && p.status !== 'cancelled') pipeline += HOUSE_SLOTS;
  let homeless = 0;
  for (const p of s.people) if (p && p.alive && p.town === town && p.home < 0) homeless++;
  const empty = Math.max(0, slots - occupied) + pipeline;
  const vacancy = slots > 0 ? empty / slots : 0;
  if (!(vacancy < HOUSE_VACANCY_TRIGGER || homeless > empty + 1)) return null;
  const t = s.towns[town];
  const bw = fin(s.stats?.baseWage, 0);
  const rent = t && t.avgRent > 0 ? t.avgRent : BASE_RENT_SHARE * (bw > 2 ? bw : defaultWage(s, town));
  const cost = estimateCost(s, 'house', town);
  if (!(cost > 0)) return null;
  return (rent * HOUSE_SLOTS * DAYS_PER_YEAR) / cost;
}

// ---------------------------------------------------------------------------
// Monthly: launching projects
// ---------------------------------------------------------------------------

/** A person with at least `minFree` to invest, weighted by wealth (same town counts double). */
function pickEntrepreneur(s: SimState, town: TownId, minFree: number): Ref | null {
  // One venture at a time: whoever still has a project under way (or awaiting its loan)
  // keeps their means for it — it may cost more than planned.
  const busy = new Set<number>();
  for (const pr of s.projects) if (pr.status !== 'done' && pr.status !== 'cancelled' && isPerson(pr.owner)) busy.add(pr.owner);
  let total = 0;
  const cands: number[] = [];
  const weights: number[] = [];
  for (const p of s.people) {
    if (!p || !p.alive || p.owns.length >= ENTRY_MAX_OWNED || busy.has(p.id)) continue;
    const free = investableCash(s, p.id);
    if (free < minFree) continue;
    const w = free * (p.town === town ? 2 : 1);
    cands.push(p.id);
    weights.push(w);
    total += w;
  }
  if (!cands.length || !(total > 0)) return null;
  let r = rand(s) * total;
  for (let i = 0; i < cands.length; i++) {
    r -= weights[i];
    if (r <= 0) return cands[i];
  }
  return cands[cands.length - 1];
}

/**
 * Fund and start a private project: self-funded if the owner can, else equity +
 * a loan request sized so the bank's quote is positive; the expected return must
 * beat the owner's actual borrowing rate + hurdle. Returns true if started.
 */
function launch(s: SimState, spec: ProjectSpec, total: number, roc: number, hurdle: number): boolean {
  const owner = spec.owner;
  const free = investableCash(s, owner);
  if (!(total > 0)) return false;
  let loan = 0;
  if (free < total) {
    let equity = ENTRY_OWNER_EQUITY * total;
    if (free < equity) return false;
    loan = total - equity;
    let q = quoteRate(s, owner, loan);
    while (q < 0 && equity < free - 1e-6) {
      equity = Math.min(free, equity + 0.1 * total);
      loan = total - equity;
      q = loan > 1 ? quoteRate(s, owner, loan) : 0;
    }
    if (q < 0) return false;
    if (loan > 1 && roc < q + hurdle) return false; // this borrower's money is too dear
    if (loan <= 1) loan = 0;
  }
  const r = startProject(s, spec);
  if (typeof r === 'string') return false;
  const { purpose, term } = financing(spec.kind, owner);
  if (loan > 0) {
    r.loanWanted = loan;
    requestLoan(s, { borrower: owner, amount: loan, term, purpose, project: r.id });
  } else {
    const paid = pay(s, owner, firmRef(r.builder), Math.min(total, free), 'asset');
    r.prepaid = fin(r.prepaid) + paid;
  }
  return true;
}

interface Candidate {
  sector: Sector | null; // null = houses
  roc: number;
  req: number;
  rel: number;
  sig: SectorSignal | null;
}

function tryCandidate(s: SimState, town: TownId, c: Candidate): boolean {
  const tn = s.towns[town]?.name ?? '';
  if (!c.sector) {
    const total = estimateCost(s, 'house', town);
    const owner = pickEntrepreneur(s, town, ENTRY_OWNER_EQUITY * total);
    if (owner === null) return false;
    return launch(s, { kind: 'house', town, owner, label: `Houses in ${tn}` }, total, c.roc, HOUSE_HURDLE);
  }
  const sector = c.sector;
  const d = SECTORS[sector];
  const sig = c.sig!;
  if (sig.vacant) {
    const total = projectTotal(s, 'reopen', town, sector);
    const owner = pickEntrepreneur(s, town, ENTRY_OWNER_EQUITY * total);
    if (owner === null) return false;
    // A reopening costs a fraction of a new building: the return on its own cost is higher.
    const roc = c.roc * (projectTotal(s, 'firm', town, sector) / Math.max(1, total));
    return launch(s, { kind: 'reopen', town, owner, sector, building: sig.vacant.id, label: `Reopening a ${d.name} in ${tn}` }, total, roc, ENTRY_HURDLE);
  }
  if (sig.capFirm) {
    const f = sig.capFirm;
    const total = estimateCost(s, 'expand', town, sector);
    let owner: Ref = firmRef(f.id);
    if (investableCash(s, owner) < ENTRY_OWNER_EQUITY * total) {
      if (isPerson(f.owner) && investableCash(s, f.owner) >= ENTRY_OWNER_EQUITY * total) owner = f.owner;
      else owner = -1;
    }
    if (owner !== -1) {
      const roc = c.roc * (projectTotal(s, 'firm', town, sector) / Math.max(1, total));
      if (launch(s, { kind: 'expand', town, owner, sector, building: f.building, label: `Enlarging ${f.name}` }, total, roc, ENTRY_HURDLE)) return true;
    }
  }
  let site: { x: number; y: number } | null = null;
  try {
    site = findSite(s, sector, town);
  } catch {
    site = null;
  }
  if (!site) return false;
  const total = projectTotal(s, 'firm', town, sector);
  const owner = pickEntrepreneur(s, town, ENTRY_OWNER_EQUITY * total);
  if (owner === null) return false;
  return launch(s, { kind: 'firm', town, owner, sector, x: site.x, y: site.y, label: `New ${d.name} in ${tn}` }, total, c.roc, ENTRY_HURDLE);
}

/**
 * Close firms that have been losing money for a long time — one owner at a time, not a
 * whole trade at once: the worst eligible loss-maker of each trade and town leaves with
 * probability EXIT_PROB a month (at most EXIT_MAX_PER_TRADE a month); the last active firm of a trade in a town never leaves voluntarily (it can shrink to no
 * workers and wait for demand to return); seasonal trades (farms, coal) must have lost
 * money for twice as long (a lean winter is not a reason to sell up); and an owner with
 * EXIT_PATIENT_CASH_DAYS of costs still in the till waits another season.
 */
function voluntaryExit(s: SimState): void {
  const active = new Map<string, number>();
  for (const f of s.firms) {
    if (!f || !f.alive || f.status !== 'active') continue;
    const key = f.sector + '@' + f.town;
    active.set(key, (active.get(key) ?? 0) + 1);
  }
  // The worst loss-maker of each trade and town is the candidate (at most EXIT_MAX_PER_TRADE a month).
  const worst = new Map<string, Firm[]>();
  for (const f of s.firms) {
    if (!f || !f.alive || f.status !== 'active' || f.sector === 'stateworks') continue;
    if (s.day - f.founded < EXIT_MIN_AGE) continue;
    const d = SECTORS[f.sector];
    const seasonal = d && (d.season === 'farm' || d.out === G.coal);
    const need = seasonal ? 2 * EXIT_LOSS_DAYS : EXIT_LOSS_DAYS;
    if (fin(f.lossDays) < need) continue;
    if (fin(f.lossDays) < 2 * need && f.cash > EXIT_PATIENT_CASH_DAYS * firmDailyCost(s, f)) continue;
    if (isEssentialFirm(s, f)) continue;
    const key = f.sector + '@' + f.town;
    let list = worst.get(key);
    if (!list) worst.set(key, (list = []));
    list.push(f);
  }
  for (const [key, list] of worst) {
    list.sort((a, b) => fin(a.profit) - fin(b.profit) || a.id - b.id);
    let n = 0;
    for (const f of list) {
      if (n >= EXIT_MAX_PER_TRADE) break;
      if ((active.get(key) ?? 0) <= 1) break;
      if (!chance(s, EXIT_PROB)) continue;
      active.set(key, (active.get(key) ?? 1) - 1);
      n++;
      bump(s, 'exits');
      closeFirm(s, f, 'unprofitable');
    }
  }
}

function bump(s: SimState, key: string, v = 1): void {
  const acc = s.stats.acc;
  acc[key] = (acc[key] || 0) + v;
}

/**
 * Runs on day-of-month 15 only. For each town × producer sector:
 * signal = mean over existing firms of annualised profit / (building cost + tools value)
 * (or, with no firms, an estimate from expected price vs unit cost at typical size,
 * plus market shortage). If signal > bank loan rate + ENTRY_HURDLE, with probability
 * ≤ ENTRY_MAX_PROB: (a) reopen a vacant building of that sector, else (b) expand a
 * firm at capacity, else (c) a new building at world/layout.findSite. Owner: a wealthy
 * person able to fund ENTRY_OWNER_EQUITY (rest via bank.requestLoan 'startup'), paid
 * into the project as it is billed. Houses: when a town has homeless people or vacancy
 * < 3 % and rent yield (rent × slots × 360 / house cost) > loan rate + HOUSE_HURDLE,
 * a developer commissions a house (loan purpose 'house').
 * Also: voluntary exit of chronically unprofitable firms (profit < 0 for 90+ days).
 *
 * Every day (not only on the 15th) it also settles the financing of projects waiting
 * for their loan (see settleFinancing and the header).
 */
export function entryStep(s: SimState): void {
  settleFinancing(s);
  if (dayOfMonth(s.day) !== ENTRY_DAY) return;
  voluntaryExit(s);
  const r = screenRate(s);
  for (let t = 0; t < s.towns.length; t++) {
    const b = builderFor(s, t);
    if (!b || !b.build) continue;
    let privQ = 0;
    for (const id of b.build.queue) {
      const p = s.projects.find((x) => x.id === id);
      if (p && p.owner !== STATE && p.status !== 'done' && p.status !== 'cancelled') privQ++;
    }
    let budget = Math.min(ENTRY_MAX_PER_TOWN, BUILDER_MAX_PRIVATE_QUEUE - privQ);
    if (budget <= 0) continue;
    const cands: Candidate[] = [];
    for (const k of PRODUCER_SECTORS) {
      const sig = sectorSignal(s, t, k);
      if (!sig) continue;
      const req = r + ENTRY_HURDLE;
      if (sig.roc > req) cands.push({ sector: k, roc: sig.roc, req, rel: (sig.roc - req) / Math.max(0.01, req), sig });
    }
    const hy = houseSignal(s, t);
    if (hy !== null) {
      const req = r + HOUSE_HURDLE;
      if (hy > req) cands.push({ sector: null, roc: hy, req, rel: (hy - req) / Math.max(0.01, req), sig: null });
    }
    cands.sort((a, c) => c.rel - a.rel);
    for (const c of cands) {
      if (budget <= 0) break;
      const prob = Math.min(ENTRY_MAX_PROB, ENTRY_PROB_SLOPE * c.rel);
      if (!chance(s, prob)) continue;
      if (tryCandidate(s, t, c)) {
        budget--;
        bump(s, 'entry_projects');
      }
    }
  }
}
