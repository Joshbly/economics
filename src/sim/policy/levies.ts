// ============================================================================
// Levies: signed rates attached to flows. dir 1 = the Treasury takes,
// dir −1 = the Treasury gives. See DESIGN §5.3 for bases/payers/units.
// OWNER: market-policy agent.
//
// Rate semantics by unit:
//   pct     : fraction of the flow's ¤ value above `threshold`
//             (for base 'money' the rate is per YEAR, charged daily as rate/360
//              on the balance above threshold)
//   perUnit : ¤ per unit (sale/shipment/import/export/goods: per unit of good;
//             wage: per worker-day; rent: per slot-day)
//   flat    : ¤ per agent per day (head, building) or per event (estate)
// Gives are skipped (not queued) while treasury.givesSuspended is true.
// ============================================================================
import type { BuildingKind, Group, Levy, LevyBase, LevyPayer, Person, Ref, Sector, SimState, TownId, Wedge } from '../types';

export interface LevyCtx {
  town?: number; // where the flow happens
  good?: number;
  sector?: Sector;
  toTown?: number; // shipment destination
  kind?: BuildingKind; // building levies
  person?: Person; // for group filters
}

/** Is this person in the group? (all, employed, unemployed, homeless, owners, nonowners, hungry, persons; 'firms' → false) */
export function inGroup(s: SimState, p: Person, group: Group): boolean {
  // TODO(market-policy)
  return group === 'all' || group === 'persons';
}

/** Enabled levies of `base` whose filters match ctx (and payer role if given). */
export function matchLevies(s: SimState, base: LevyBase, payer: LevyPayer | null, ctx: LevyCtx): Levy[] {
  // TODO(market-policy)
  return [];
}

/** Combined 'sale' wedge for a goods market (signed: gives make it negative). */
export function saleWedge(s: SimState, town: TownId, good: number): Wedge {
  // TODO(market-policy)
  return { bPct: 0, bUnit: 0, sPct: 0, sUnit: 0 };
}

/** After settlement, attribute sale-levy ¤ to each matching rule's accounting (money already moved). */
export function attributeSaleLevies(s: SimState, town: TownId, good: number, qty: number, basePrice: number, exemptQty: number): void {
  // TODO(market-policy)
}

/**
 * Compute (without charging) the net levy on a flow for a payer role:
 * Σ dir·amount over matching rules. Positive = payer owes the Treasury.
 */
export function levyAmount(s: SimState, base: LevyBase, payer: LevyPayer, ctx: LevyCtx, value: number, qty: number): number {
  // TODO(market-policy)
  return 0;
}

/**
 * Charge all matching levies on a flow: takes → pay(payerRef → STATE, 'levy'),
 * gives → pay(STATE → payerRef, 'give'). Records per-rule today/month/total
 * and stats.acc.levy_take / levy_give. Returns net ¤ taken (negative if net given).
 */
export function chargeLevy(s: SimState, base: LevyBase, payerRef: Ref, payer: LevyPayer, ctx: LevyCtx, value: number, qty: number): number {
  // TODO(market-policy)
  return 0;
}

/** Wage levy rates for planning (firms' effective wage, workers' net wage). */
export function wageLevyRates(s: SimState, town: TownId, sector: Sector): { workerPct: number; workerUnit: number; employerPct: number; employerUnit: number } {
  // TODO(market-policy)
  return { workerPct: 0, workerUnit: 0, employerPct: 0, employerUnit: 0 };
}

/**
 * Daily stock levies: 'money' (every person/firm balance; group filter applies to
 * persons, 'firms' group to firms), 'goods' (inventories of firms, traders,
 * people; not the Treasury), 'head' (every living person matching group/town),
 * 'building' (owners of active buildings matching kind/sector/town).
 */
export function stockLevies(s: SimState): void {
  // TODO(market-policy)
}

/** Month start: lastMonth = month, month = 0 for every levy; treasury flowsLastMonth/flowsMonth roll over; limit.binding reset. */
export function levyMonthRollover(s: SimState): void {
  // TODO(market-policy)
}

/**
 * Combined port duty for foreign orders on a good (used by foreign.ts to set
 * per-order xPct/xUnit): 'import' levies apply to foreign SELL orders (payer: the
 * domestic buyer), 'export' levies to foreign BUY orders (payer: the domestic
 * seller). Signed like levies (gives negative).
 */
export function portDuty(s: SimState, side: 'import' | 'export', good: number): { pct: number; unit: number } {
  // TODO(market-policy)
  return { pct: 0, unit: 0 };
}
