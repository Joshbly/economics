// ============================================================================
// Limits: legal bounds. All queries return -1 when no limit applies.
// When several limits match, the tightest wins. Town -1 = applies everywhere.
// OWNER: market-policy agent.
// ============================================================================
import type { LimitKind, SimState, TownId } from '../types';

/** Price ceiling/floor (base price) for a goods market. */
export function priceBounds(s: SimState, town: TownId, good: number): { max: number; min: number } {
  // TODO(market-policy)
  return { max: -1, min: -1 };
}

/** Legal wage bounds in a town (gross ¤/day). */
export function wageBounds(s: SimState, town: TownId): { min: number; max: number } {
  // TODO(market-policy)
  return { min: -1, max: -1 };
}

/** Legal rent bounds in a town (¤ per slot per day). */
export function rentBounds(s: SimState, town: TownId): { min: number; max: number } {
  // TODO(market-policy)
  return { min: -1, max: -1 };
}

/** Maximum annual loan rate the bank may charge, or -1. */
export function maxLoanRate(s: SimState): number {
  // TODO(market-policy)
  return -1;
}

/** Quantity quota per day: importMax/exportMax (good), shipMax (good, from town, to town). -1 = none, 0 = ban. */
export function quota(s: SimState, kind: 'importMax' | 'exportMax' | 'shipMax', good: number, town: TownId, toTown: TownId): number {
  // TODO(market-policy)
  return -1;
}

/** Minimum reserve ratio (reserves / deposits) the bank must keep; 0 if none. */
export function reserveRatio(s: SimState): number {
  // TODO(market-policy)
  return 0;
}

/** Minimum capital ratio set by the player; 0 if none. */
export function capitalMin(s: SimState): number {
  // TODO(market-policy)
  return 0;
}

/** Record that a limit of this kind bound today (increments limit.binding once per day). */
export function noteBinding(s: SimState, kind: LimitKind, good: number, town: TownId): void {
  // TODO(market-policy)
}
