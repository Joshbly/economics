// ============================================================================
// Labour market (matching, not an auction). See DESIGN §3.1/§3.2.
// OWNER: households agent.
// ============================================================================
import type { Firm, Person, SimState } from '../types';

/**
 * Daily, after firmsPlan set firm.target and firm.wage:
 *  1. Layoffs: firms with workers > target fire up to max(1, FIRE_RATE·workers) (lowest tenure first).
 *     Stateworks with target below workers release them the same way.
 *  2. Vacancies = target − workers for active firms (incl. builders, traders, stateworks).
 *  3. Unemployed people sample JOB_SAMPLE vacancies (weighted to their own town; other
 *     towns within MAX_COMMUTE_TILES of their home) and accept the best offer by
 *     net wage (after worker wage levies) × (1 − COMMUTE_COST_PER_TILE·tiles) if it
 *     beats their reservation wage (RES_WAGE_START → RES_WAGE_FLOOR of lastWage over
 *     RES_WAGE_DECAY_DAYS, raised by any per-head gives they receive as unemployed).
 *  4. OTJ_SEARCH_PROB of employed people search; switch for ≥ OTJ_SWITCH_GAIN.
 *  5. Respect hiring caps (max(1, HIRE_RATE·capacity) per firm per day).
 *  6. Wage Limits: offers below the legal minimum are raised to it (firms.ts also clamps).
 * Updates firm.hired/fired/applicants/vacancyDays, person.job/wage/tenure/unempDays/commute,
 * and stats.acc hires/fires/quits.
 */
export function laborMarket(s: SimState): void {
  // TODO(households)
}

/** Put a person into a firm (removing them from any current job). */
export function hire(s: SimState, f: Firm, p: Person): void {
  // TODO(households)
}

/** Remove a person from their job. */
export function fire(s: SimState, f: Firm, p: Person): void {
  // TODO(households)
}

/** Commute distance in tiles between a person's home (or town centre if homeless) and a firm's building. */
export function commuteTiles(s: SimState, p: Person, f: Firm): number {
  // TODO(households)
  return 0;
}
