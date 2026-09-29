// ============================================================================
// Levies: signed rates attached to flows. dir 1 = the Treasury takes,
// dir −1 = the Treasury gives. See DESIGN §5.3 for bases/payers/units.
// OWNER: market-policy agent.
//
// Rate semantics by unit:
//   pct     : fraction of the flow's ¤ value above `threshold`
//             (for the STOCK bases 'money', 'goods' and 'building' the rate is
//              per YEAR, charged daily as rate/360 on the balance / stock value /
//              book value above threshold)
//   perUnit : ¤ per unit (sale/shipment/import/export/goods: per unit of good;
//             wage: per worker-day; rent: per slot-day). With a threshold > 0 it
//             applies only when the flow's value exceeds the threshold
//             ('goods': per unit held ABOVE `threshold` units).
//   flat    : ¤ per agent per day (head, building, money) or per event (estate),
//             applied only when the value exceeds `threshold` (if threshold > 0).
// Gives are skipped (not queued) while treasury.givesSuspended is true.
//
// Filters: a levy's town/good/toTown/sector/buildingKind must match the flow's
// context when set. Group filters apply to `ctx.person` (the person paying or
// receiving); flows without a person (firms, the bank...) match only the groups
// 'all' and 'firms'. Sale and port levies are market-wide wedges, so they ignore
// thresholds and groups.
//
// Per-rule accounting (levy.today/month/lastMonth/total) is signed:
// + collected by the Treasury, − paid out by it. Every ¤ is also summed into
// stats.acc: levy_take, levy_give (both positive) and levyb_<base> (signed net).
//
// Callers of chargeLevy own any agent bookkeeping (person.earned,
// firm.wageBill/otherCosts); stockLevies (owned here) does its own.
// ============================================================================
import {
  DAYS_PER_YEAR,
  HUNGRY_BELOW,
  WEDGE_BPCT_MAX,
  WEDGE_BPCT_MIN,
  WEDGE_SPCT_MAX,
  WEDGE_SPCT_MIN,
} from '../config';
import { N_GOODS } from '../goods';
import { BANK, FIRM_BASE, STATE } from '../types';
import { pay } from '../ledger';
import type { BuildingKind, Group, Levy, LevyBase, LevyPayer, Person, Ref, Sector, SimState, TownId, Wedge } from '../types';

export interface LevyCtx {
  town?: number; // where the flow happens
  good?: number;
  sector?: Sector;
  toTown?: number; // shipment destination
  kind?: BuildingKind; // building levies
  person?: Person; // for group filters (leave undefined when the payer is not a person)
}

/** Bases whose rules distinguish payer roles (the payer filter matters only for these). */
const MULTI_PAYER: Partial<Record<LevyBase, true>> = { sale: true, wage: true, rent: true };

/** Is the levy switched on and not expired today (and does it have a rate)? */
export function levyActive(s: SimState, l: Levy): boolean {
  return l.enabled && (l.until < 0 || s.day <= l.until) && l.rate > 0 && Number.isFinite(l.rate);
}

/** Is this person in the group? (all, employed, unemployed, homeless, owners, nonowners, hungry, persons; 'firms' → false) */
export function inGroup(s: SimState, p: Person, group: Group): boolean {
  if (!p || !p.alive) return false;
  switch (group) {
    case 'all':
    case 'persons':
      return true;
    case 'employed':
      return p.job >= 0;
    case 'unemployed':
      return p.job < 0;
    case 'homeless':
      return p.home < 0;
    case 'owners':
      return p.owns.length > 0 || p.houses.length > 0;
    case 'nonowners':
      return p.owns.length === 0 && p.houses.length === 0;
    case 'hungry':
      return p.foodSat < HUNGRY_BELOW;
    case 'firms':
      return false;
    default:
      return false;
  }
}

function groupMatches(s: SimState, l: Levy, ctx: LevyCtx): boolean {
  const g = l.group;
  if (!g || g === 'all') return true;
  if (ctx.person) return inGroup(s, ctx.person, g);
  return g === 'firms';
}

/** Do the levy's filters (town, good, toTown, sector, building kind, group) match the flow? */
function filtersMatch(s: SimState, l: Levy, ctx: LevyCtx): boolean {
  if (l.town >= 0 && ctx.town !== l.town) return false;
  if (l.good >= 0 && ctx.good !== l.good) return false;
  if (l.toTown >= 0 && ctx.toTown !== l.toTown) return false;
  if (l.sector && l.sector !== 'any' && ctx.sector !== l.sector) return false;
  if (l.buildingKind && l.buildingKind !== 'any' && ctx.kind !== l.buildingKind) return false;
  return groupMatches(s, l, ctx);
}

function payerMatches(l: Levy, payer: LevyPayer | null): boolean {
  return payer === null || !MULTI_PAYER[l.base] || l.payer === payer;
}

/** Unsigned amount one rule levies on a flow of ¤ `value` and `qty` units. */
function ruleAmount(l: Levy, value: number, qty: number): number {
  const thr = l.threshold > 0 ? l.threshold : 0;
  let a = 0;
  if (l.unit === 'pct') a = l.rate * Math.max(0, value - thr);
  else if (thr > 0 && !(value > thr)) a = 0;
  else if (l.unit === 'perUnit') a = l.rate * Math.max(0, qty);
  else a = l.rate; // flat
  return Number.isFinite(a) && a > 0 ? a : 0;
}

/** Record `signed` ¤ against a rule (+ collected, − paid) and the daily levy accumulators. */
export function noteRule(s: SimState, l: Levy, signed: number): void {
  if (!signed || !Number.isFinite(signed)) return;
  l.today += signed;
  l.month += signed;
  l.total += signed;
  const acc = s.stats.acc;
  if (signed > 0) acc.levy_take = (acc.levy_take || 0) + signed;
  else acc.levy_give = (acc.levy_give || 0) - signed;
  const k = 'levyb_' + l.base;
  acc[k] = (acc[k] || 0) + signed;
}

/** Enabled levies of `base` whose filters match ctx (and payer role if given). */
export function matchLevies(s: SimState, base: LevyBase, payer: LevyPayer | null, ctx: LevyCtx): Levy[] {
  const out: Levy[] = [];
  for (const l of s.policy.levies) {
    if (l.base !== base || !levyActive(s, l)) continue;
    if (!payerMatches(l, payer) || !filtersMatch(s, l, ctx)) continue;
    out.push(l);
  }
  return out;
}

/** Fill `out` with the combined 'sale' wedge of a goods market (allocation-free version of saleWedge). */
export function saleWedgeInto(s: SimState, town: TownId, good: number, out: Wedge): Wedge {
  let bPct = 0;
  let bUnit = 0;
  let sPct = 0;
  let sUnit = 0;
  const susp = s.treasury.givesSuspended;
  for (const l of s.policy.levies) {
    if (l.base !== 'sale' || !levyActive(s, l)) continue;
    if (susp && l.dir < 0) continue;
    if (l.town >= 0 && l.town !== town) continue;
    if (l.good >= 0 && l.good !== good) continue;
    const r = l.dir * l.rate;
    if (l.payer === 'buyer') {
      if (l.unit === 'pct') bPct += r;
      else if (l.unit === 'perUnit') bUnit += r;
    } else if (l.payer === 'seller') {
      if (l.unit === 'pct') sPct += r;
      else if (l.unit === 'perUnit') sUnit += r;
    }
  }
  out.bPct = clampNum(bPct, WEDGE_BPCT_MIN, WEDGE_BPCT_MAX);
  out.bUnit = Number.isFinite(bUnit) ? bUnit : 0;
  out.sPct = clampNum(sPct, WEDGE_SPCT_MIN, WEDGE_SPCT_MAX);
  out.sUnit = Number.isFinite(sUnit) ? sUnit : 0;
  return out;
}

function clampNum(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < lo ? lo : x > hi ? hi : x;
}

/** Combined 'sale' wedge for a goods market (signed: gives make it negative). */
export function saleWedge(s: SimState, town: TownId, good: number): Wedge {
  return saleWedgeInto(s, town, good, { bPct: 0, bUnit: 0, sPct: 0, sUnit: 0 });
}

/** Theoretical signed amount one sale rule levies on `qty` units at `basePrice`. */
function saleRuleAmount(l: Levy, basePrice: number, qty: number): number {
  if (l.unit === 'pct') return l.dir * l.rate * basePrice * qty;
  if (l.unit === 'perUnit') return l.dir * l.rate * qty;
  return 0;
}

function saleRuleMatches(s: SimState, l: Levy, town: TownId, good: number): boolean {
  if (l.base !== 'sale' || !levyActive(s, l)) return false;
  if (s.treasury.givesSuspended && l.dir < 0) return false;
  if (l.town >= 0 && l.town !== town) return false;
  if (l.good >= 0 && l.good !== good) return false;
  return true;
}

/**
 * Attribute sale-levy ¤ that actually moved to the individual rules. `buyQty` /
 * `sellQty` are the non-exempt quantities on each side; `buyerTotal` /
 * `sellerTotal` the signed ¤ that actually moved on each side (+ taken). Each
 * rule gets its theoretical share, scaled so the rules sum to what moved (this
 * absorbs wedge clamps and payers who could not pay in full). Pass NaN for a
 * total to record the theoretical amounts unscaled.
 */
export function attributeSaleActual(
  s: SimState,
  town: TownId,
  good: number,
  basePrice: number,
  buyQty: number,
  sellQty: number,
  buyerTotal: number,
  sellerTotal: number,
): void {
  if (!(basePrice > 0)) return;
  let thB = 0;
  let thS = 0;
  let any = false;
  for (const l of s.policy.levies) {
    if (!saleRuleMatches(s, l, town, good)) continue;
    any = true;
    if (l.payer === 'buyer') thB += saleRuleAmount(l, basePrice, buyQty);
    else if (l.payer === 'seller') thS += saleRuleAmount(l, basePrice, sellQty);
  }
  if (!any) return;
  const kB = Number.isNaN(buyerTotal) ? 1 : Math.abs(thB) > 1e-12 ? buyerTotal / thB : 1;
  const kS = Number.isNaN(sellerTotal) ? 1 : Math.abs(thS) > 1e-12 ? sellerTotal / thS : 1;
  for (const l of s.policy.levies) {
    if (!saleRuleMatches(s, l, town, good)) continue;
    if (l.payer === 'buyer') noteRule(s, l, saleRuleAmount(l, basePrice, buyQty) * kB);
    else if (l.payer === 'seller') noteRule(s, l, saleRuleAmount(l, basePrice, sellQty) * kS);
  }
}

/**
 * After settlement, attribute sale-levy ¤ to each matching rule's accounting (money already moved).
 * `exemptQty` is the part of `qty` traded by exempt (Treasury) orders; by default it
 * applies to both sides, pass `exemptSellQty` when the sell side differs.
 */
export function attributeSaleLevies(
  s: SimState,
  town: TownId,
  good: number,
  qty: number,
  basePrice: number,
  exemptQty: number,
  exemptSellQty: number = exemptQty,
): void {
  const bq = Math.max(0, qty - Math.max(0, exemptQty));
  const sq = Math.max(0, qty - Math.max(0, exemptSellQty));
  attributeSaleActual(s, town, good, basePrice, bq, sq, NaN, NaN);
}

/**
 * Compute (without charging) the net levy on a flow for a payer role:
 * Σ dir·amount over matching rules. Positive = payer owes the Treasury.
 * Gives are left out while they are suspended.
 */
export function levyAmount(s: SimState, base: LevyBase, payer: LevyPayer, ctx: LevyCtx, value: number, qty: number): number {
  let net = 0;
  const susp = s.treasury.givesSuspended;
  for (const l of s.policy.levies) {
    if (l.base !== base || !levyActive(s, l)) continue;
    if (susp && l.dir < 0) continue;
    if (!payerMatches(l, payer) || !filtersMatch(s, l, ctx)) continue;
    net += l.dir * ruleAmount(l, value, qty);
  }
  return net;
}

/**
 * Most the Bank can hand the Treasury on a claim (levy, seizure): its own capital, and
 * no more than the reserves it holds. The ledger treats the Bank as never short of cash
 * (it can always create deposits), so without this cap a large claim would push its
 * capital below zero, fail it and bail in every depositor — and the excess would reach
 * the Purse via window borrowing, i.e. unrecorded money creation.
 */
export function bankClaimRoom(s: SimState): number {
  const b = s.bank;
  const room = Math.min(b.equity, b.reserves);
  return room > 0 && Number.isFinite(room) ? room : 0;
}

/**
 * Charge all matching levies on a flow: takes → pay(payerRef → STATE, 'levy'),
 * gives → pay(STATE → payerRef, 'give'). Records per-rule today/month/total
 * and stats.acc.levy_take / levy_give. Returns net ¤ taken (negative if net given).
 * Takes are capped by what the payer holds; gives by the Purse (unless auto-mint).
 * Does NOT touch person.earned or firm accounts — the caller books those.
 */
export function chargeLevy(s: SimState, base: LevyBase, payerRef: Ref, payer: LevyPayer, ctx: LevyCtx, value: number, qty: number): number {
  const levies = s.policy.levies;
  if (levies.length === 0 || payerRef === STATE) return 0;
  let net = 0;
  const susp = s.treasury.givesSuspended;
  for (const l of levies) {
    if (l.base !== base || !levyActive(s, l)) continue;
    if (!payerMatches(l, payer) || !filtersMatch(s, l, ctx)) continue;
    let a = ruleAmount(l, value, qty);
    if (!(a > 0)) continue;
    if (l.dir === 1) {
      if (payerRef === BANK) a = Math.min(a, bankClaimRoom(s)); // never beyond the Bank's capital
      const paid = pay(s, payerRef, STATE, a, 'levy');
      noteRule(s, l, paid);
      net += paid;
    } else {
      if (susp) continue;
      const paid = pay(s, STATE, payerRef, a, 'give');
      noteRule(s, l, -paid);
      net -= paid;
    }
  }
  return net;
}

/**
 * Wage levy rates for planning (firms' effective wage, workers' net wage).
 * Only rules without a group restriction (or 'employed'/'persons') are included.
 * Thresholds are evaluated at `wage` (default: the town's average wage): a pct
 * rule with a threshold becomes its average rate at that wage, a per-unit rule
 * with a threshold counts only if the wage exceeds it.
 */
export function wageLevyRates(
  s: SimState,
  town: TownId,
  sector: Sector | '',
  wage?: number,
): { workerPct: number; workerUnit: number; employerPct: number; employerUnit: number } {
  const r = { workerPct: 0, workerUnit: 0, employerPct: 0, employerUnit: 0 };
  const levies = s.policy.levies;
  if (levies.length === 0) return r;
  const w = wage !== undefined && wage > 0 ? wage : (s.towns[town]?.avgWage ?? 0);
  const susp = s.treasury.givesSuspended;
  for (const l of levies) {
    if (l.base !== 'wage' || !levyActive(s, l)) continue;
    if (susp && l.dir < 0) continue;
    if (l.town >= 0 && l.town !== town) continue;
    if (l.sector && l.sector !== 'any' && l.sector !== sector) continue;
    if (l.group && l.group !== 'all' && l.group !== 'employed' && l.group !== 'persons') continue;
    const thr = l.threshold > 0 ? l.threshold : 0;
    let pct = 0;
    let unit = 0;
    if (l.unit === 'pct') {
      if (thr <= 0) pct = l.rate;
      else if (w > thr) pct = (l.rate * (w - thr)) / w;
    } else if (l.unit === 'perUnit' || l.unit === 'flat') {
      if (thr <= 0 || w > thr) unit = l.rate;
    }
    if (l.payer === 'worker') {
      r.workerPct += l.dir * pct;
      r.workerUnit += l.dir * unit;
    } else if (l.payer === 'employer') {
      r.employerPct += l.dir * pct;
      r.employerUnit += l.dir * unit;
    }
  }
  return r;
}

/**
 * Employer's cost of one worker-day at gross wage `w`: the wage plus any employer-side wage
 * levies (a give lowers it). Every labour-COST decision (hiring, pricing, entry, freight,
 * valuation) uses this; every take-home decision (job search, migration) uses the worker
 * side. `sector` '' = only rules that apply to every sector (town-wide measures).
 */
export function employerWageCost(s: SimState, town: TownId, sector: Sector | '', w: number): number {
  if (s.policy.levies.length === 0 || !(w > 0)) return Math.max(0, w);
  const r = wageLevyRates(s, town, sector, w);
  const c = w * (1 + r.employerPct) + r.employerUnit;
  return Number.isFinite(c) ? Math.max(0, c) : w;
}

// ---- stock levies -------------------------------------------------------------
const sMoney: Levy[] = [];
const sGoods: Levy[] = [];
const sHead: Levy[] = [];
const sBuilding: Levy[] = [];
const sGoodsPersons: Levy[] = [];

/** Charge one stock-levy rule on one agent; books the rule, person.earned / firm.otherCosts. */
function chargeStock(s: SimState, l: Levy, ref: Ref, amount: number, person: Person | null, firmIdx: number): void {
  if (!(amount > 0) || ref === STATE) return;
  let signed: number;
  // A claim on the Bank (e.g. a levy on its own building) is capped at its capital.
  if (l.dir === 1) signed = pay(s, ref, STATE, ref === BANK ? Math.min(amount, bankClaimRoom(s)) : amount, 'levy');
  else signed = -pay(s, STATE, ref, amount, 'give');
  if (!signed) return;
  noteRule(s, l, signed);
  // Disposable income / costs: a take lowers what the agent earned today, a give raises it.
  if (person) person.earned -= signed;
  if (firmIdx >= 0) {
    const f = s.firms[firmIdx];
    if (f) f.otherCosts += signed;
  }
}

function priceIn(s: SimState, town: number, good: number): number {
  const m = s.markets[town * N_GOODS + good];
  return m && m.ema > 0 ? m.ema : 0;
}

/** Levy on an inventory array held in `town` by `ref`. */
function chargeGoods(s: SimState, levies: Levy[], inv: number[], town: number, ref: Ref, ctx: LevyCtx, person: Person | null, firmIdx: number): void {
  for (const l of levies) {
    if (l.town >= 0 && l.town !== town) continue;
    ctx.town = town;
    ctx.good = undefined;
    // group / sector check here; the good filter is applied per good below
    if (l.sector && l.sector !== 'any' && ctx.sector !== l.sector) continue;
    if (!groupMatches(s, l, ctx)) continue;
    let amt = 0;
    const g0 = l.good >= 0 ? l.good : 0;
    const g1 = l.good >= 0 ? l.good + 1 : N_GOODS;
    for (let g = g0; g < g1; g++) {
      const q = inv[g];
      if (!(q > 0)) continue;
      const thr = l.threshold > 0 ? l.threshold : 0;
      if (l.unit === 'perUnit') amt += l.rate * Math.max(0, q - thr);
      else if (l.unit === 'pct') amt += (l.rate / DAYS_PER_YEAR) * Math.max(0, q * priceIn(s, town, g) - thr);
      else if (q > thr) amt += l.rate; // flat: per good held above the threshold
    }
    chargeStock(s, l, ref, amt, person, firmIdx);
  }
}

/**
 * Daily stock levies: 'money' (every person/firm balance; group filter applies to
 * persons, 'firms' group to firms), 'goods' (inventories of firms, traders,
 * people; not the Treasury), 'head' (every living person matching group/town),
 * 'building' (owners of active buildings matching kind/sector/town).
 * Each base is only iterated if an enabled levy of that base exists.
 * Books person.earned (takes −, gives +) and firm.otherCosts (takes +, gives −).
 * Buildings used by an active firm are charged to that firm; others to the owner.
 */
export function stockLevies(s: SimState): void {
  const levies = s.policy.levies;
  if (levies.length === 0) return;
  sMoney.length = 0;
  sGoods.length = 0;
  sHead.length = 0;
  sBuilding.length = 0;
  sGoodsPersons.length = 0;
  const susp = s.treasury.givesSuspended;
  for (const l of levies) {
    if (!levyActive(s, l)) continue;
    if (susp && l.dir < 0) continue;
    if (l.base === 'money') sMoney.push(l);
    else if (l.base === 'goods') sGoods.push(l);
    else if (l.base === 'head') sHead.push(l);
    else if (l.base === 'building') sBuilding.push(l);
  }
  for (const l of sGoods) if (l.group !== 'firms' && (!l.sector || l.sector === 'any')) sGoodsPersons.push(l);
  const ctx: LevyCtx = {};

  // ---- people ----
  if (sMoney.length || sGoods.length || sHead.length) {
    for (const p of s.people) {
      if (!p || !p.alive) continue;
      ctx.person = p;
      ctx.town = p.town;
      ctx.sector = undefined;
      ctx.good = undefined;
      ctx.kind = undefined;
      for (const l of sMoney) {
        if (l.town >= 0 && l.town !== p.town) continue;
        if (l.sector && l.sector !== 'any') continue; // sector-specific money levies are for firms
        if (!groupMatches(s, l, ctx) || l.group === 'firms') continue;
        chargeStock(s, l, p.id, moneyAmount(l, p.cash), p, -1);
      }
      for (const l of sHead) {
        if (l.town >= 0 && l.town !== p.town) continue;
        if (!groupMatches(s, l, ctx) || l.group === 'firms') continue;
        const thr = l.threshold > 0 ? l.threshold : 0;
        if (thr > 0 && !(p.cash > thr)) continue;
        chargeStock(s, l, p.id, l.rate, p, -1);
      }
      if (sGoodsPersons.length) chargeGoods(s, sGoodsPersons, p.pantry, p.town, p.id, ctx, p, -1);
    }
  }

  // ---- firms ----
  if (sMoney.length || sGoods.length) {
    ctx.person = undefined;
    ctx.kind = undefined;
    for (const f of s.firms) {
      if (!f || !f.alive || f.status === 'closed' || f.sector === 'stateworks') continue;
      const ref = FIRM_BASE + f.id;
      ctx.town = f.town;
      ctx.sector = f.sector;
      ctx.good = undefined;
      for (const l of sMoney) {
        if (l.town >= 0 && l.town !== f.town) continue;
        if (l.sector && l.sector !== 'any' && l.sector !== f.sector) continue;
        if (l.group && l.group !== 'all' && l.group !== 'firms') continue;
        chargeStock(s, l, ref, moneyAmount(l, f.cash), null, f.id);
      }
      if (sGoods.length) {
        chargeGoods(s, sGoods, f.inv, f.town, ref, ctx, null, f.id);
        if (f.trade) {
          for (let t = 0; t < f.trade.stock.length; t++) {
            if (t === f.town) continue;
            chargeGoods(s, sGoods, f.trade.stock[t], t, ref, ctx, null, f.id);
          }
        }
      }
    }
  }

  // ---- buildings ----
  if (sBuilding.length) {
    for (const b of s.buildings) {
      if (!b || b.status !== 'active') continue;
      let ref: Ref = b.owner;
      let firmIdx = -1;
      let person: Person | null = null;
      if (b.firm >= 0) {
        const f = s.firms[b.firm];
        if (f && f.alive && f.status !== 'closed') {
          ref = FIRM_BASE + f.id;
          firmIdx = f.id;
        }
      }
      if (ref === STATE) continue;
      if (ref >= FIRM_BASE && firmIdx < 0) {
        const f = s.firms[ref - FIRM_BASE];
        if (!f || !f.alive) continue;
        firmIdx = f.id;
      } else if (ref >= 0 && ref < FIRM_BASE) {
        person = s.people[ref] ?? null;
        if (!person || !person.alive) continue;
      }
      for (const l of sBuilding) {
        if (l.town >= 0 && l.town !== b.town) continue;
        if (l.buildingKind && l.buildingKind !== 'any' && l.buildingKind !== b.kind) continue;
        if (l.sector && l.sector !== 'any' && l.sector !== b.sector) continue;
        const thr = l.threshold > 0 ? l.threshold : 0;
        let amt: number;
        if (l.unit === 'pct') amt = (l.rate / DAYS_PER_YEAR) * Math.max(0, (b.cost || 0) - thr);
        else amt = thr > 0 && !((b.cost || 0) > thr) ? 0 : l.rate;
        chargeStock(s, l, ref, amt, person, firmIdx);
      }
    }
  }
}

/** Daily 'money' levy on a balance: pct = annual rate/360 above the threshold; flat/perUnit = ¤/day if above. */
function moneyAmount(l: Levy, cash: number): number {
  const thr = l.threshold > 0 ? l.threshold : 0;
  if (!(cash > 0)) return 0;
  if (l.unit === 'pct') return (l.rate / DAYS_PER_YEAR) * Math.max(0, cash - thr);
  return cash > thr ? l.rate : 0;
}

/** Month start: lastMonth = month, month = 0 for every levy; treasury flowsLastMonth/flowsMonth roll over; limit.binding reset. */
export function levyMonthRollover(s: SimState): void {
  for (const l of s.policy.levies) {
    l.lastMonth = l.month;
    l.month = 0;
  }
  const t = s.treasury;
  t.flowsLastMonth = t.flowsMonth || {};
  t.flowsMonth = {};
  for (const lim of s.policy.limits) lim.binding = 0;
}

/** The town that hosts the port (-1 if none). */
export function portTown(s: SimState): number {
  for (const t of s.towns) if (t.hasPort) return t.id;
  return -1;
}

function portRuleMatches(s: SimState, l: Levy, base: LevyBase, good: number, port: number): boolean {
  if (l.base !== base || !levyActive(s, l)) return false;
  if (s.treasury.givesSuspended && l.dir < 0) return false;
  if (l.good >= 0 && l.good !== good) return false;
  if (l.town >= 0 && port >= 0 && l.town !== port) return false;
  return true;
}

/**
 * Combined port duty for foreign orders on a good (used by foreign.ts to set
 * per-order xPct/xUnit): 'import' levies apply to foreign SELL orders (payer: the
 * domestic buyer), 'export' levies to foreign BUY orders (payer: the domestic
 * seller). Signed like levies (gives negative).
 * Settlement (markets.ts) collects the extras from the foreign order's owner and
 * attributes them to these rules (asks → 'import', bids → 'export').
 */
export function portDuty(s: SimState, side: 'import' | 'export', good: number): { pct: number; unit: number } {
  let pct = 0;
  let unit = 0;
  const port = portTown(s);
  for (const l of s.policy.levies) {
    if (!portRuleMatches(s, l, side, good, port)) continue;
    if (l.unit === 'pct') pct += l.dir * l.rate;
    else if (l.unit === 'perUnit') unit += l.dir * l.rate;
  }
  return { pct: clampNum(pct, WEDGE_BPCT_MIN, WEDGE_SPCT_MAX), unit: Number.isFinite(unit) ? unit : 0 };
}

/**
 * Attribute port-duty ¤ that actually moved (signed, + taken) on `qty` units at
 * `basePrice` to the matching 'import' / 'export' rules, pro rata to their
 * theoretical amounts.
 */
export function attributePortActual(s: SimState, side: 'import' | 'export', good: number, basePrice: number, qty: number, total: number): void {
  if (!(qty > 0)) return;
  const port = portTown(s);
  let th = 0;
  let any = false;
  for (const l of s.policy.levies) {
    if (!portRuleMatches(s, l, side, good, port)) continue;
    any = true;
    th += saleRuleAmount(l, basePrice, qty);
  }
  if (!any) return;
  const k = Math.abs(th) > 1e-12 ? total / th : 1;
  for (const l of s.policy.levies) {
    if (!portRuleMatches(s, l, side, good, port)) continue;
    noteRule(s, l, saleRuleAmount(l, basePrice, qty) * k);
  }
}
