// ============================================================================
// Limits: legal bounds. All queries return -1 when no limit applies.
// When several limits match, the tightest wins. Town -1 = applies everywhere.
// OWNER: market-policy agent.
//
// Matching: a limit with good −1 applies to every good, town −1 to every town,
// toTown −1 (shipMax) to every destination. Disabled or expired limits never
// match (expired ones are also pruned each morning by policyBeginDay).
// Values: prices are BASE prices (before levies); wages gross ¤/day; rents ¤ per
// slot per day; rates annual fractions; quotas units per day; ratios fractions.
// ============================================================================
import { rt } from '../runtime';
import type { Limit, LimitKind, SimState, TownId } from '../types';

function active(s: SimState, l: Limit): boolean {
  return l.enabled && (l.until < 0 || s.day <= l.until) && Number.isFinite(l.value) && l.value >= 0;
}

function matches(l: Limit, kind: LimitKind, good: number, town: TownId, toTown: TownId): boolean {
  if (l.kind !== kind) return false;
  if (l.good >= 0 && good >= 0 && l.good !== good) return false;
  if (l.good >= 0 && good < 0) return false;
  if (l.town >= 0 && l.town !== town) return false;
  if (l.toTown >= 0 && l.toTown !== toTown) return false;
  return true;
}

/** Tightest matching limit of a kind: the smallest value for upper bounds, the largest for lower bounds. Null if none. */
function tightest(s: SimState, kind: LimitKind, upper: boolean, good: number, town: TownId, toTown: TownId): Limit | null {
  let best: Limit | null = null;
  for (const l of s.policy.limits) {
    if (!active(s, l) || !matches(l, kind, good, town, toTown)) continue;
    if (!best || (upper ? l.value < best.value : l.value > best.value)) best = l;
  }
  return best;
}

function valueOf(l: Limit | null): number {
  return l ? l.value : -1;
}

/** Price ceiling/floor (base price) for a goods market. */
export function priceBounds(s: SimState, town: TownId, good: number): { max: number; min: number } {
  if (s.policy.limits.length === 0) return { max: -1, min: -1 };
  return {
    max: valueOf(tightest(s, 'priceMax', true, good, town, -1)),
    min: valueOf(tightest(s, 'priceMin', false, good, town, -1)),
  };
}

/** Legal wage bounds in a town (gross ¤/day). */
export function wageBounds(s: SimState, town: TownId): { min: number; max: number } {
  if (s.policy.limits.length === 0) return { min: -1, max: -1 };
  return {
    min: valueOf(tightest(s, 'wageMin', false, -1, town, -1)),
    max: valueOf(tightest(s, 'wageMax', true, -1, town, -1)),
  };
}

/** Legal rent bounds in a town (¤ per slot per day). */
export function rentBounds(s: SimState, town: TownId): { min: number; max: number } {
  if (s.policy.limits.length === 0) return { min: -1, max: -1 };
  return {
    min: valueOf(tightest(s, 'rentMin', false, -1, town, -1)),
    max: valueOf(tightest(s, 'rentMax', true, -1, town, -1)),
  };
}

/** Maximum annual loan rate the bank may charge, or -1. */
export function maxLoanRate(s: SimState): number {
  if (s.policy.limits.length === 0) return -1;
  return valueOf(tightest(s, 'rateMax', true, -1, -1, -1));
}

/** Quantity quota per day: importMax/exportMax (good), shipMax (good, from town, to town). -1 = none, 0 = ban. */
export function quota(s: SimState, kind: 'importMax' | 'exportMax' | 'shipMax', good: number, town: TownId, toTown: TownId): number {
  if (s.policy.limits.length === 0) return -1;
  if (kind === 'shipMax') return valueOf(tightest(s, kind, true, good, town, toTown));
  // Port quotas: any town filter must be the port town (callers may pass −1).
  let best: Limit | null = null;
  for (const l of s.policy.limits) {
    if (!active(s, l) || l.kind !== kind) continue;
    if (l.good >= 0 && l.good !== good) continue;
    if (l.town >= 0 && town >= 0 && l.town !== town) continue;
    if (!best || l.value < best.value) best = l;
  }
  return valueOf(best);
}

/** Minimum reserve ratio (reserves / deposits) the bank must keep; 0 if none. */
export function reserveRatio(s: SimState): number {
  const l = tightest(s, 'reserveMin', false, -1, -1, -1);
  return l ? Math.min(1, l.value) : 0;
}

/** Minimum capital ratio set by the player; 0 if none. */
export function capitalMin(s: SimState): number {
  const l = tightest(s, 'capitalMin', false, -1, -1, -1);
  return l ? Math.min(1, l.value) : 0;
}

/** Upper-bound kinds (the smallest value binds); the rest are lower bounds. */
const UPPER: Record<LimitKind, boolean> = {
  priceMax: true,
  priceMin: false,
  wageMin: false,
  wageMax: true,
  rentMax: true,
  rentMin: false,
  rateMax: true,
  importMax: true,
  exportMax: true,
  shipMax: true,
  reserveMin: false,
  capitalMin: false,
};

/**
 * Record that a limit of this kind bound today (increments limit.binding once per day).
 * The tightest matching limit is the one credited. For shipMax pass the origin as
 * `town`; the destination is not distinguished here (any matching route counts).
 */
export function noteBinding(s: SimState, kind: LimitKind, good: number, town: TownId): void {
  if (s.policy.limits.length === 0) return;
  let best: Limit | null = null;
  const upper = UPPER[kind];
  for (const l of s.policy.limits) {
    if (!active(s, l) || l.kind !== kind) continue;
    if (l.good >= 0 && good >= 0 && l.good !== good) continue;
    if (l.town >= 0 && town >= 0 && l.town !== town) continue;
    if (!best || (upper ? l.value < best.value : l.value > best.value)) best = l;
  }
  if (!best) return;
  const bag = rt(s).bag;
  let seen = bag.limitBoundDay as Record<number, number> | undefined;
  if (!seen) bag.limitBoundDay = seen = {};
  if (seen[best.id] === s.day) return;
  seen[best.id] = s.day;
  best.binding += 1;
}
