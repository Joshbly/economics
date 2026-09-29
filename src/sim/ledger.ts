// ============================================================================
// The ledger: the ONLY place money moves. Keeps the bank's balance sheet exact.
//
//   Private accounts (people, firms, the foreign desk) hold deposits at the bank.
//   The Treasury holds the Purse. The bank holds reserves at the Treasury.
//
//   Bank:  assets = reserves + Σ loans + iouBook
//          liabilities = Σ deposits + windowDebt
//          equity = assets − liabilities   (tracked explicitly; see checkLedger)
//
// Rules implemented by pay():
//   private → private : deposits move between accounts.
//   private → STATE   : deposit ↓, Purse ↑, reserves ↓.
//   STATE   → private : Purse ↓, deposit ↑, reserves ↑.
//   private → BANK    : deposit ↓; income flows raise equity, 'asset' flows don't
//                       (caller books the asset change, e.g. bank sold an IOU).
//   BANK    → private : deposit ↑; expense flows lower equity, 'asset' flows don't.
//   STATE   → BANK    : Purse ↓, reserves ↑ (+equity unless 'asset').
//   BANK    → STATE   : reserves ↓, Purse ↑ (−equity unless 'asset').
// ============================================================================
import { BANK, FIRM_BASE, FOREIGN, STATE, type Ref, type SimState } from './types';

export type Flow =
  | 'wage'
  | 'buy' // market purchases (base value)
  | 'levy' // levies collected / paid (sign via direction)
  | 'give'
  | 'interest'
  | 'coupon'
  | 'dividend'
  | 'rent'
  | 'transfer'
  | 'build'
  | 'freight'
  | 'fare' // fares paid to the Treasury for carriage on its freight lines
  | 'estate'
  | 'migrate'
  | 'bailin'
  | 'recap'
  | 'fee'
  | 'asset' // exchange of assets (IOUs, gold) — no income for the bank
  | 'misc';

// ---- refs ------------------------------------------------------------------
export const personRef = (id: number): Ref => id;
export const firmRef = (id: number): Ref => FIRM_BASE + id;
export const isPerson = (r: Ref): boolean => r >= 0 && r < FIRM_BASE;
export const isFirm = (r: Ref): boolean => r >= FIRM_BASE;
export const isPrivate = (r: Ref): boolean => r >= 0 || r === FOREIGN;
export const refId = (r: Ref): number => (r >= FIRM_BASE ? r - FIRM_BASE : r);

export function refName(s: SimState, r: Ref): string {
  if (r === STATE) return 'the Treasury';
  if (r === BANK) return 'the Bank';
  if (r === FOREIGN) return 'foreign merchants';
  if (isFirm(r)) return s.firms[refId(r)]?.name ?? 'a firm';
  return s.people[r]?.name ?? 'someone';
}

// ---- balances --------------------------------------------------------------
/** Money an agent can spend right now. The bank can always create deposits. */
export function cashOf(s: SimState, r: Ref): number {
  if (r >= FIRM_BASE) return s.firms[r - FIRM_BASE].cash;
  if (r >= 0) return s.people[r].cash;
  if (r === STATE) return s.treasury.autoMint ? 1e15 : Math.max(0, s.treasury.purse);
  if (r === FOREIGN) return s.foreign.coin;
  return 1e15; // BANK
}

function debit(s: SimState, r: Ref, a: number): void {
  if (r >= FIRM_BASE) s.firms[r - FIRM_BASE].cash -= a;
  else if (r >= 0) s.people[r].cash -= a;
  else if (r === STATE) s.treasury.purse -= a;
  else if (r === FOREIGN) s.foreign.coin -= a;
}

function credit(s: SimState, r: Ref, a: number): void {
  if (r >= FIRM_BASE) s.firms[r - FIRM_BASE].cash += a;
  else if (r >= 0) {
    const p = s.people[r];
    p.cash += a;
  } else if (r === STATE) s.treasury.purse += a;
  else if (r === FOREIGN) s.foreign.coin += a;
}

/** Precomputed stats keys (avoids a string concat on every payment — this is a hot path). */
const FLOW_KEY: Record<Flow, string> = {
  wage: 'flow_wage', buy: 'flow_buy', levy: 'flow_levy', give: 'flow_give', interest: 'flow_interest',
  coupon: 'flow_coupon', dividend: 'flow_dividend', rent: 'flow_rent', transfer: 'flow_transfer',
  build: 'flow_build', freight: 'flow_freight', fare: 'flow_fare', estate: 'flow_estate', migrate: 'flow_migrate',
  bailin: 'flow_bailin', recap: 'flow_recap', fee: 'flow_fee', asset: 'flow_asset', misc: 'flow_misc',
};

function recordFlow(s: SimState, from: Ref, to: Ref, a: number, flow: Flow): void {
  const acc = s.stats.acc;
  const k = FLOW_KEY[flow] ?? 'flow_' + flow;
  acc[k] = (acc[k] || 0) + a;
  const t = s.treasury;
  if (to === STATE) {
    t.flows[flow] = (t.flows[flow] || 0) + a;
    t.flowsMonth[flow] = (t.flowsMonth[flow] || 0) + a;
  } else if (from === STATE) {
    t.flows[flow] = (t.flows[flow] || 0) - a;
    t.flowsMonth[flow] = (t.flowsMonth[flow] || 0) - a;
  }
}

/**
 * Move `amount` ¤ from one agent to another. Pays at most what the payer has
 * (the Treasury mints the shortfall when auto-mint is on). Returns the amount
 * actually paid. Never throws.
 */
export function pay(s: SimState, from: Ref, to: Ref, amount: number, flow: Flow): number {
  if (!(amount > 0) || from === to) return 0;
  let a = amount;
  if (from === STATE) {
    const t = s.treasury;
    if (t.purse < a) {
      if (t.autoMint) mint(s, a - t.purse);
      else a = Math.max(0, t.purse);
    }
  } else if (from !== BANK) {
    const c = cashOf(s, from);
    if (c < a) a = Math.max(0, c);
  }
  if (!(a > 0)) return 0;

  const b = s.bank;
  const asset = flow === 'asset';
  if (isPrivate(from) && isPrivate(to)) {
    debit(s, from, a);
    credit(s, to, a);
  } else if (isPrivate(from) && to === STATE) {
    debit(s, from, a);
    credit(s, STATE, a);
    b.reserves -= a;
  } else if (from === STATE && isPrivate(to)) {
    debit(s, STATE, a);
    credit(s, to, a);
    b.reserves += a;
  } else if (isPrivate(from) && to === BANK) {
    debit(s, from, a);
    if (!asset) b.equity += a;
  } else if (from === BANK && isPrivate(to)) {
    credit(s, to, a);
    if (!asset) b.equity -= a;
  } else if (from === STATE && to === BANK) {
    debit(s, STATE, a);
    b.reserves += a;
    if (!asset) b.equity += a;
  } else if (from === BANK && to === STATE) {
    credit(s, STATE, a);
    b.reserves -= a;
    if (!asset) b.equity -= a;
  } else {
    return 0;
  }
  recordFlow(s, from, to, a, flow);
  return a;
}

// ---- Treasury money creation ----------------------------------------------
export function mint(s: SimState, amount: number): number {
  if (!(amount > 0)) return 0;
  s.treasury.purse += amount;
  s.treasury.minted += amount;
  s.stats.acc.minted = (s.stats.acc.minted || 0) + amount;
  return amount;
}

export function burn(s: SimState, amount: number): number {
  const a = Math.min(Math.max(0, amount), Math.max(0, s.treasury.purse));
  if (!(a > 0)) return 0;
  s.treasury.purse -= a;
  s.treasury.burned += a;
  s.stats.acc.burned = (s.stats.acc.burned || 0) + a;
  return a;
}

// ---- Bank credit (money creation by lending) ----------------------------------
/** Credit a new loan's proceeds to the borrower's deposit. Caller creates the Loan record. */
export function disburse(s: SimState, borrower: Ref, amount: number): void {
  if (!(amount > 0)) return;
  credit(s, borrower, amount);
  s.stats.acc.flow_loan = (s.stats.acc.flow_loan || 0) + amount;
}

/** Take up to `amount` from the borrower's deposit to repay principal. Returns amount repaid; caller reduces loan.principal. */
export function repayPrincipal(s: SimState, borrower: Ref, amount: number): number {
  const a = Math.min(Math.max(0, amount), Math.max(0, cashOf(s, borrower)));
  if (!(a > 0)) return 0;
  debit(s, borrower, a);
  s.stats.acc.flow_repay = (s.stats.acc.flow_repay || 0) + a;
  return a;
}

/** Book a loan loss against bank equity (caller deactivates the loan). */
export function writeOff(s: SimState, amount: number): void {
  if (!(amount > 0)) return;
  s.bank.equity -= amount;
  s.bank.writeoffs += amount;
  s.stats.acc.writeoffs = (s.stats.acc.writeoffs || 0) + amount;
}

// ---- The Treasury window ----------------------------------------------------
/** The bank borrows reserves from the Treasury. */
export function windowBorrow(s: SimState, amount: number): void {
  if (!(amount > 0)) return;
  s.bank.windowDebt += amount;
  s.bank.reserves += amount;
}

/** The bank repays window debt with reserves. Returns amount repaid. */
export function windowRepay(s: SimState, amount: number): number {
  const a = Math.min(Math.max(0, amount), s.bank.windowDebt);
  if (!(a > 0)) return 0;
  s.bank.windowDebt -= a;
  s.bank.reserves -= a;
  return a;
}

/**
 * Bail-in: cut every private deposit by `fraction` (0..1) to recapitalise the
 * failed bank. Deposits are liabilities, so equity rises by the total cut.
 */
export function bailIn(s: SimState, fraction: number): number {
  const f = Math.min(1, Math.max(0, fraction));
  let total = 0;
  for (const p of s.people) {
    if (!p.alive || p.cash <= 0) continue;
    const c = p.cash * f;
    p.cash -= c;
    total += c;
  }
  for (const fm of s.firms) {
    if (!fm.alive || fm.cash <= 0) continue;
    const c = fm.cash * f;
    fm.cash -= c;
    total += c;
  }
  if (s.foreign.coin > 0) {
    const c = s.foreign.coin * f;
    s.foreign.coin -= c;
    total += c;
  }
  s.bank.equity += total;
  s.stats.acc.flow_bailin = (s.stats.acc.flow_bailin || 0) + total;
  return total;
}

// ---- Aggregates & invariants --------------------------------------------------
/** Σ of all private deposits = the money supply. */
export function deposits(s: SimState): number {
  let d = s.foreign.coin;
  for (const p of s.people) if (p.alive) d += p.cash;
  for (const f of s.firms) if (f.alive) d += f.cash;
  return d;
}

export function loansOutstanding(s: SimState): number {
  let l = 0;
  for (const ln of s.loans) if (ln.active) l += ln.principal;
  return l;
}

/**
 * Balance-sheet discrepancy (should be ~0): reserves + loans + iouBook
 * − deposits − windowDebt − equity. Dead agents must hold no cash (their money
 * is moved on death/emigration via pay()).
 */
export function checkLedger(s: SimState): number {
  let deadCash = 0;
  for (const p of s.people) if (!p.alive) deadCash += p.cash;
  for (const f of s.firms) if (!f.alive) deadCash += f.cash;
  const b = s.bank;
  return b.reserves + loansOutstanding(s) + b.iouBook - (deposits(s) + deadCash) - b.windowDebt - b.equity;
}

/** Set bank equity so the identity holds. Only for world initialisation / load repair. */
export function reconcileBank(s: SimState): void {
  const b = s.bank;
  b.equity = b.reserves + loansOutstanding(s) + b.iouBook - deposits(s) - b.windowDebt;
}
