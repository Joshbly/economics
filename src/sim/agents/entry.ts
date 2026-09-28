// ============================================================================
// Entrepreneurship: new firms, reopenings, expansions, house building.
// OWNER: firms agent. See DESIGN §3.2 (Entry & expansion).
// ============================================================================
import type { SimState } from '../types';

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
 */
export function entryStep(s: SimState): void {
  // TODO(firms)
}
