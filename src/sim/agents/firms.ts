// ============================================================================
// Producer firms (and shared firm plumbing for builders/traders/stateworks):
// planning, production, wages, orders, accounting, finance, dividends,
// bankruptcy. Uses the pure model in production.ts.
// OWNER: firms agent. See DESIGN §3.2.
// ============================================================================
import type { Firm, Ref, Sector, SimState, TownId } from '../types';
import type { Books } from '../market/markets';

/**
 * Morning, for active producer firms (builders' and traders' targets are set by
 * their own modules; stateworks by policy): expected net price (markets.expectedNet)
 * vs material & tool cost → production.optimalLabor; demand-based labour from
 * sales EMA and inventory gap; target = min(capacity, max(0/1, ...)), smoothed
 * (TARGET_SMOOTH). Wage adjustment: +WAGE_UP_DAY while vacancyDays > WAGE_VACANCY_DAYS,
 * −WAGE_DOWN_DAY when losing money and local unemployment is high, + partial
 * indexation (WAGE_INDEXATION × expected inflation / 360); clamp to limits.wageBounds.
 * Applies to ALL firm sectors except stateworks (builders/traders also adjust wages here).
 */
export function firmsPlan(s: SimState): void {
  // TODO(firms)
}

/**
 * Production for producer firms: Leff = Σ (0.5 + 0.5·health) × strike factor
 * (town.strikeDays > 0 → STRIKE_FACTOR); Q = potentialOutput(...) capped by
 * materialCap and INV_MAX_DAYS; consume inputs; add output to inv; tools wear
 * (toolUse × Leff + TOOLS_IDLE_WEAR_DAY × tools). Farms use drought (town.droughtDays)
 * as ×0.5. Site multiplier from the building's tile deposit/fertility (0.6 + 0.8·x).
 * stats.acc: prod_<good>, realva (value added at stats.basePrices), inputs used.
 */
export function firmsProduce(s: SimState): void {
  // TODO(firms)
}

/**
 * Pay every worker of every active firm its wage (all sectors incl. builders,
 * traders; stateworks are paid by the Treasury: pay(STATE → worker)).
 * Wage levies: worker-side (deducted: pay firm→worker net, firm→STATE levy via
 * chargeLevy with payer 'worker'… implement so the worker's net = gross − levy)
 * and employer-side (extra, payer 'employer'). If the firm cannot pay in full,
 * pay pro-rata and mark distress. Adds to person.earned; firm.wageBill;
 * stats.acc wages, wages_<sector>.
 */
export function firmsPayWages(s: SimState): void {
  // TODO(firms)
}

/**
 * Orders for producer firms: ask ladder for output (ASK_RUNGS/ASK_WEIGHTS around
 * pExp, shifted by inventory ratio, floored at ASK_COST_FLOOR × unit variable cost
 * except when distressed/liquidating/perishable overstock); bid ladders for inputs
 * (INPUT_BUFFER_DAYS) and tools (toolsPerWorker × target + TOOLS_BUFFER_DAYS of wear,
 * TOOLS_GAP_CLOSE of the gap per day) within cash + expected credit. Liquidating
 * firms dump everything at fire-sale prices.
 */
export function firmOrders(s: SimState, books: Books): void {
  // TODO(firms)
}

/**
 * Evening: accounting (profit = revenue − spent − wageBill − otherCosts; EMAs of
 * sales, output, unit cost, profit, pExp from realised net price); monthly profit
 * levies (chargeLevy 'profit', payer 'owner'); finance: working-capital loan
 * requests when cash < CASH_LOW_DAYS of costs (bank.requestLoan); monthly dividends
 * (DIVIDEND_SHARE of cash above CASH_TARGET_DAYS × costs → owner, flow 'dividend');
 * distress counting & bankruptcy (closeFirm) after DISTRESS_BANKRUPT_DAYS;
 * liquidation countdown. Applies to all firms except stateworks.
 */
export function firmsEndDay(s: SimState): void {
  // TODO(firms)
}

/** Create a firm record (and link it to its building). Uses s.ids.firm. */
export function createFirm(s: SimState, sector: Sector, town: TownId, building: number, owner: Ref): Firm {
  // TODO(firms)
  return null as unknown as Firm;
}

/**
 * Bankruptcy / closure: lay off all workers, status 'liquidating' (dumps stock for
 * LIQUIDATION_DAYS), then 'closed': remaining debts written off (ledger.writeOff),
 * remaining cash to the owner, building status 'vacant', firm.alive = false.
 */
export function closeFirm(s: SimState, f: Firm, reason: string): void {
  // TODO(firms)
}

/** Value of a firm's assets (cash + inventory + tools at market prices + building book value) — collateral. */
export function firmAssets(s: SimState, f: Firm): number {
  // TODO(firms)
  return 0;
}
