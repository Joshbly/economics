// ============================================================================
// The commercial bank. OWNER: finance-trade agent. See DESIGN §3.5.
// All money movements via ledger.ts (pay, disburse, repayPrincipal, writeOff,
// windowBorrow/windowRepay, bailIn).
// ============================================================================
import type { Loan, LoanRequest, Ref, SimState } from '../types';
import type { Books } from '../market/markets';

/**
 * Morning:
 *  - funding cost = treasury.reserveRate if reserves ≥ required (limits.reserveRatio ×
 *    deposits) else treasury.lendRate; baseRate = funding + BANK_BASE_SPREAD;
 *    depositRate = max(min(0, reserveRate), reserveRate − BANK_DEPOSIT_SPREAD);
 *  - every active loan reprices (rate = baseRate + spread, capped by limits.maxLoanRate);
 *    borrower pays interest principal·rate/360 (pay → BANK, flow 'interest') and
 *    amortisation principal/left (repayPrincipal); shortfall → overdue++;
 *    overdue > LOAN_DEFAULT_OVERDUE_DAYS → default: writeOff, loan inactive, borrower distress;
 *  - deposit interest to every private balance (pay BANK → holder, 'interest'; if the
 *    rate is negative, holder → BANK) with 'interest' levies (payer 'receiver');
 *  - Treasury pays interest on positive reserves (pay STATE → BANK, 'interest');
 *    bank pays window interest (pay BANK → STATE, 'interest');
 *  - IOU coupons: STATE pays IOU_COUPON/360 per IOU to the bank and every holder
 *    (flow 'coupon'; 'interest' levies apply to people's coupons);
 *  - reserves below requirement (or negative) → windowBorrow; comfortable excess → windowRepay.
 *  - stats.acc: interest_loans, interest_deposits, coupons, defaults.
 */
export function bankBeginDay(s: SimState): void {
  // TODO(finance-trade)
}

/** Queue a loan request (processed in bankEndDay). */
export function requestLoan(s: SimState, req: LoanRequest): void {
  // TODO(finance-trade)
}

/**
 * IOU portfolio: buy with excess reserves when yield > reserveRate + BANK_IOU_MARGIN;
 * sell when reserves are short of requirement (before borrowing at the window) or
 * yield < reserveRate. Adds orders to books.iou.
 */
export function bankOrders(s: SimState, books: Books): void {
  // TODO(finance-trade)
}

/**
 * Evening: decide queued loan requests (DSCR ≥ BANK_DSCR, leverage ≤ BANK_MAX_LEVERAGE,
 * capital ratio after loan ≥ max(BANK_MIN_CAPITAL, limits.capitalMin), stance; a rate
 * cap below the risk-adjusted rate → reject); approved → Loan record + ledger.disburse.
 * Stance tightens with defaultEma, loosens slowly. Monthly dividends to the owner when
 * capital ratio > 12 %. Failure: equity < 0 → failed (no new loans, news 'crisis');
 * after BANK_FAIL_GRACE_DAYS still < 0 → bailIn to restore 2 % capital, news.
 * Recovery when equity > 0 (e.g. the player transfers to the bank).
 */
export function bankEndDay(s: SimState): void {
  // TODO(finance-trade)
}

/** Annual loan rate the bank would charge this borrower now (for planning); -1 if it would refuse. */
export function quoteRate(s: SimState, borrower: Ref, extraDebt: number): number {
  // TODO(finance-trade)
  return 0.08;
}

/** Outstanding debt of an agent. */
export function debtOf(s: SimState, ref: Ref): number {
  // TODO(finance-trade)
  return 0;
}

/** Active loans of an agent. */
export function loansOf(s: SimState, ref: Ref): Loan[] {
  // TODO(finance-trade)
  return [];
}

/** Capital ratio = equity / risk-weighted assets (loans 100 %, IOUs 0 %). */
export function capitalRatio(s: SimState): number {
  // TODO(finance-trade)
  return 0.15;
}
