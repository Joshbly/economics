// ============================================================================
// Housing: rent, arrears, evictions, moving, landlords' rent setting.
// OWNER: households agent. See DESIGN §3.1.
// ============================================================================
import type { Person, SimState, TownId } from '../types';

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
  // TODO(households)
}

/** Try to house a person in a town. Returns true on success. */
export function findHome(s: SimState, p: Person, town: TownId): boolean {
  // TODO(households)
  return false;
}

/** Remove a person from their home (eviction, death, emigration, moving). */
export function leaveHome(s: SimState, p: Person): void {
  // TODO(households)
}
