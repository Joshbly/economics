// ============================================================================
// The commercial bank. OWNER: finance-trade agent. See DESIGN §3.5.
// All money movements via ledger.ts (pay, disburse, repayPrincipal, writeOff,
// windowBorrow/windowRepay, bailIn).
//
// Balance sheet (ledger.ts keeps it exact):
//   assets      = reserves (at the Treasury) + loans + IOUs (book)
//   liabilities = deposits (every private balance) + window debt
//   equity      = assets − liabilities
//
// Economics:
//  * Lending creates deposits (money creation); repayment destroys them.
//  * The bank's marginal funding cost is the Treasury's reserve rate while it has
//    spare reserves and slides to the window rate as it comes to rely on window
//    borrowing (or falls short of a reserve requirement). Loan rates float daily at
//    funding + base spread + each loan's own risk spread, so the window rates reach
//    every borrower — the interest-rate channel.
//  * Lending standards (debt-service coverage, leverage, the bank's own capital)
//    tighten after losses and with thin capital and loosen only slowly: credit is
//    pro-cyclical. A legal ceiling on loan rates does not make risky credit cheap —
//    loans the bank would price above it are simply refused (rationing).
//  * Depositors are paid interest daily (the deposit rate tracks the reserve rate);
//    the Treasury pays coupons on IOUs to whoever holds them. Levies on 'interest'
//    (payer 'receiver') apply to people's and firms' deposit interest and to
//    people's coupons.
//  * If equity turns negative the bank stops lending; after BANK_FAIL_GRACE_DAYS
//    without new capital every deposit is cut pro rata to restore it.
// ============================================================================
import * as CFG from '../config';
import { isMonthEnd } from '../calendar';
import { newLoan } from '../factory';
import { G, HOUSE_SLOTS, N_GOODS } from '../goods';
import {
  bailIn,
  cashOf,
  deposits,
  disburse,
  isFirm,
  isPerson,
  loansOutstanding,
  pay,
  repayPrincipal,
  windowBorrow,
  windowRepay,
  writeOff,
} from '../ledger';
import { addAsk, addBid, bookFor, marketOf, type Books } from '../market/markets';
import { chargeLevy, type LevyCtx } from '../policy/levies';
import { capitalMin, maxLoanRate, minLoanRate, noteBinding, reserveRatio } from '../policy/limits';
import { rt } from '../runtime';
import { news } from '../stats/events';
import { BANK, FIRM_BASE, FOREIGN, IOU_GOOD, STATE } from '../types';
import type { Firm, Loan, LoanPurpose, LoanRequest, Person, Ref, SimState } from '../types';
import { clamp, ema, fin } from '../util';
import { materialsValue } from './production';
import { firmAssets } from './firms';

// Local copies of constants read in hot loops (imported bindings may be getters under some loaders).
const {
  DAYS_PER_YEAR,
  BANK_BASE_SPREAD,
  BANK_DEPOSIT_SPREAD,
  BANK_MIN_CAPITAL,
  BANK_OWN_MIN_CAPITAL,
  BANK_RISK_PREMIUM,
  BANK_DSCR,
  BANK_MAX_LEVERAGE,
  BANK_IOU_MARGIN,
  BANK_DIVIDEND_SHARE,
  BANK_FAIL_GRACE_DAYS,
  LOAN_DEFAULT_OVERDUE_DAYS,
  IOU_COUPON,
  BANK_RESERVE_BUFFER,
  BANK_REPAY_HYST,
  BANK_TIGHT_SCALE,
  BANK_STANCE_BASE,
  BANK_STANCE_LOSS_SENS,
  BANK_STANCE_CAP_SENS,
  BANK_STANCE_UP,
  BANK_STANCE_DOWN,
  BANK_STANCE_SPREAD,
  BANK_STANCE_DSCR,
  BANK_STANCE_LEVERAGE,
  BANK_STANCE_CAPITAL,
  BANK_DEFAULT_EMA,
  BANK_STARTUP_PREMIUM,
  BANK_PERSON_PREMIUM,
  BANK_INCOME_DEBT_SHARE,
  BANK_PROJECT_YIELD,
  BANK_WORKING_YIELD,
  BANK_YOUNG_FIRM_DAYS,
  BANK_MIN_LOAN,
  BANK_PARTIAL_MIN,
  BANK_PAY_TOLERANCE,
  BANK_DEFAULT_KEEP_DAYS,
  BANK_DIVIDEND_BOOK_SHARE,
  BANK_DIVIDEND_CAPITAL,
  BANK_BAILIN_TARGET,
  BANK_IOU_TERM_PREMIUM,
  BANK_IOU_MAX_SHARE,
  BANK_IOU_BUY_FRACTION,
  BANK_MIN_LOAN_RATE,
  BANK_NEWS_GAP_DAYS,
  BANK_LATE_REFUSE_DAYS,
  BANK_MAX_TERM,
  BANK_TERM_CAPITAL_EXTRA,
  DISTRESS_BANKRUPT_DAYS,
  ENTRY_OWNER_EQUITY,
  BUILD_MARGIN,
  BASE_WAGE,
  BASE_RENT_SHARE,
  INIT_BANK_EQUITY_MIN,
  WORKING_LOAN_TERM,
  BANK_RESERVE_PAY_DAYS,
} = CFG;

/** The most requests kept in the daily queue (protects against a runaway requester). */
const MAX_REQUESTS = 1000;
/** Equity within this of zero counts as zero (floating-point dust must not flip failure). */
const EQUITY_EPS = 1e-6;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function bump(s: SimState, key: string, v: number): void {
  if (!v || !Number.isFinite(v)) return;
  const acc = s.stats.acc;
  acc[key] = (acc[key] || 0) + v;
}

/** Any enabled, unexpired levy of this base with a positive rate? (cheap pre-check before per-holder levy calls) */
function hasLevy(s: SimState, base: string): boolean {
  const ls = s.policy.levies;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (l.enabled && l.base === base && l.rate > 0 && (l.until < 0 || s.day <= l.until)) return true;
  }
  return false;
}

function firmOf(s: SimState, r: Ref): Firm | undefined {
  return r >= FIRM_BASE ? s.firms[r - FIRM_BASE] : undefined;
}

function personOf(s: SimState, r: Ref): Person | undefined {
  return r >= 0 && r < FIRM_BASE ? s.people[r] : undefined;
}

/** Can this agent still service (or take) a loan? */
function borrowerAlive(s: SimState, r: Ref): boolean {
  if (isFirm(r)) {
    const f = firmOf(s, r);
    return !!f && f.alive && f.status !== 'closed';
  }
  if (isPerson(r)) {
    const p = personOf(s, r);
    return !!p && p.alive;
  }
  return false;
}

/** Rate-limited news (one item of a kind per BANK_NEWS_GAP_DAYS). */
function newsOnce(s: SimState, key: string, text: string, kind: 'crisis' | 'bad' | 'good' | 'info'): void {
  const bag = rt(s).bag;
  let seen = bag.bankNewsDay as Record<string, number> | undefined;
  if (!seen) bag.bankNewsDay = seen = {};
  const last = seen[key];
  if (last !== undefined && s.day - last < BANK_NEWS_GAP_DAYS && s.day >= last) return;
  seen[key] = s.day;
  news(s, text, kind);
}

function money(x: number): string {
  const a = Math.abs(x);
  const t = a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e4 ? Math.round(a / 1000) + 'k' : String(Math.round(a));
  return (x < 0 ? '−¤' : '¤') + t;
}

function pctText(x: number): string {
  const v = x * 100;
  return (Math.abs(v) < 10 ? v.toFixed(1) : String(Math.round(v))) + '%';
}

/**
 * Minimum capital ratio in force: the realm's standing rule (BANK_MIN_CAPITAL) — or, while a Limit on
 * bank capital is in force, the Limit instead (higher or lower), never below the bank's own prudence
 * (BANK_OWN_MIN_CAPITAL).
 */
export function minCapital(s: SimState): number {
  const lim = capitalMin(s);
  return lim >= 0 ? Math.max(BANK_OWN_MIN_CAPITAL, lim) : BANK_MIN_CAPITAL;
}

/** Where the capital rule in force comes from: the standing rule, the player's Limit, or the bank's own floor (a Limit below it). */
export function capitalRuleSource(s: SimState): 'standing' | 'limit' | 'own' {
  const lim = capitalMin(s);
  if (lim < 0) return 'standing';
  return lim < BANK_OWN_MIN_CAPITAL ? 'own' : 'limit';
}

/**
 * The legal range of loan rates today: `cap` (rateMax, −1 none) and `floor` (rateMin, −1 none).
 * A floor above the cap is cut to it (the maximum wins, as for prices).
 */
function rateLimits(s: SimState): { cap: number; floor: number } {
  const cap = maxLoanRate(s);
  let floor = minLoanRate(s);
  if (cap >= 0 && floor > cap) floor = cap;
  return { cap, floor };
}

/** Reserves the bank must hold by law (Limit reserveMin × deposits). */
export function requiredReserves(s: SimState, dep = deposits(s)): number {
  return reserveRatio(s) * Math.max(0, dep);
}

/** Reserves the bank aims to hold: the requirement plus a small operating buffer. */
function reserveTarget(s: SimState, dep: number): number {
  const d = Math.max(0, dep);
  return reserveRatio(s) * d + BANK_RESERVE_BUFFER * d;
}

/** Annual rate for a spread over today's base rate, raised to a rate floor and capped by a rate Limit (< 0 = none). */
function rateFor(base: number, spread: number, cap: number, floor = -1): number {
  let r = base + spread;
  if (floor >= 0 && r < floor) r = floor;
  if (cap >= 0 && r > cap) r = cap;
  r = fin(r, base);
  return r < BANK_MIN_LOAN_RATE ? BANK_MIN_LOAN_RATE : r;
}

/** Risk spread from post-loan leverage (0..1+). */
function riskSpread(leverage: number): number {
  const l = clamp(fin(leverage), 0, 1.5);
  return BANK_RISK_PREMIUM * l * l;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Capital ratio = equity / risk-weighted assets (loans 100 %, IOUs and reserves 0 %). Clamped to ±10. */
export function capitalRatio(s: SimState): number {
  const L = loansOutstanding(s);
  return clamp(fin(s.bank.equity) / Math.max(1, L), -10, 10);
}

/** Outstanding debt of an agent. */
export function debtOf(s: SimState, ref: Ref): number {
  let d = 0;
  const ls = s.loans;
  for (let i = 0; i < ls.length; i++) {
    const ln = ls[i];
    if (ln.active && ln.borrower === ref) d += ln.principal;
  }
  return d;
}

/** Active loans of an agent. */
export function loansOf(s: SimState, ref: Ref): Loan[] {
  const out: Loan[] = [];
  for (const ln of s.loans) if (ln.active && ln.borrower === ref) out.push(ln);
  return out;
}

/** Longest run of missed payments among an agent's loans (0 = all current). Firms may count this as distress. */
export function overdueOf(s: SimState, ref: Ref): number {
  let o = 0;
  for (const ln of s.loans) if (ln.active && ln.borrower === ref && ln.overdue > o) o = ln.overdue;
  return o;
}

/** Scheduled daily debt service of an agent at current rates: interest + amortisation (¤/day). */
export function debtServiceOf(s: SimState, ref: Ref): number {
  let d = 0;
  for (const ln of s.loans) {
    if (!ln.active || ln.borrower !== ref) continue;
    d += (ln.principal * Math.max(0, ln.rate)) / DAYS_PER_YEAR + ln.principal / Math.max(1, ln.left);
  }
  return d;
}

/** Market value of a firm's assets; falls back to a local estimate while firms.firmAssets is unavailable. */
function assetsOfFirm(s: SimState, f: Firm): number {
  let v = 0;
  try {
    v = fin(firmAssets(s, f));
  } catch {
    v = 0;
  }
  if (v > 0) return v;
  let a = Math.max(0, f.cash);
  for (let g = 0; g < N_GOODS; g++) if (f.inv[g] > 0) a += f.inv[g] * fin(marketOf(s, f.town, g).ema);
  a += Math.max(0, f.tools) * fin(marketOf(s, f.town, G.tools).ema);
  if (f.trade) {
    for (let t = 0; t < f.trade.stock.length; t++) {
      if (t === f.town) continue;
      const st = f.trade.stock[t];
      for (let g = 0; g < N_GOODS; g++) if (st[g] > 0) a += st[g] * fin(marketOf(s, t, g).ema);
    }
  }
  const b = f.building >= 0 ? s.buildings[f.building] : undefined;
  if (b) a += Math.max(0, fin(b.cost));
  return a;
}

/** Wealth of a household the bank can see: deposit, IOUs, gold, houses, and equity in its firms. */
function assetsOfPerson(s: SimState, p: Person): number {
  let a = Math.max(0, p.cash);
  a += Math.max(0, p.iou) * Math.max(0, fin(s.iouMarket.ema));
  a += Math.max(0, p.gold) * Math.max(0, fin(s.goldMarket.ema));
  for (const h of p.houses) {
    const b = s.buildings[h];
    if (b) a += Math.max(0, fin(b.cost));
  }
  for (const id of p.owns) {
    const f = s.firms[id];
    if (!f || !f.alive) continue;
    a += Math.max(0, assetsOfFirm(s, f) - debtOf(s, FIRM_BASE + f.id));
  }
  return a;
}

function assetsOf(s: SimState, r: Ref): number {
  const f = firmOf(s, r);
  if (f) return assetsOfFirm(s, f);
  const p = personOf(s, r);
  return p ? assetsOfPerson(s, p) : 0;
}

/**
 * Borrowers' appetite for long debt against capital already in place, as a multiple of their normal
 * leverage: 1 at a loan rate of CREDIT_RATE_REF, less when dearer (0 at REF + SCALE), more when
 * cheaper (≤ CREDIT_MAX_MULT). Landlords (housing.ts) and firms (firms.ts) size their debt with it.
 */
export function creditAppetite(rate: number): number {
  return clamp(1 + (CFG.CREDIT_RATE_REF - Math.max(0, fin(rate))) / CFG.CREDIT_RATE_SCALE, 0, CFG.CREDIT_MAX_MULT);
}

/** Typical leverage assumed when a caller asks for a quote without a borrower. */
const TYPICAL_LEVERAGE = 0.4;

/**
 * Annual loan rate the bank would charge this borrower now (for planning); -1 if it would refuse.
 * `extraDebt` is the size of the loan being considered (assumed to finance assets of the same value).
 * borrower < 0 → the rate for a typical sound borrower (e.g. for sector-wide entry decisions).
 */
export function quoteRate(s: SimState, borrower: Ref, extraDebt: number): number {
  const b = s.bank;
  if (b.failed) return -1;
  const extra = Math.max(0, fin(extraDebt));
  const stance = clamp(fin(b.stance, 0.3), 0, 1);
  const L = loansOutstanding(s);
  const capNeed = minCapital(s) + BANK_STANCE_CAPITAL * stance;
  if (fin(b.equity) / Math.max(1, L + extra) < capNeed) return -1;
  let lev = TYPICAL_LEVERAGE;
  let premium = 0;
  if (borrower >= 0) {
    if (!borrowerAlive(s, borrower)) return -1;
    const debt = debtOf(s, borrower) + extra;
    const assets = assetsOf(s, borrower) + extra;
    lev = assets > 0 ? debt / assets : debt > 0 ? 9 : 0;
    const maxLev = BANK_MAX_LEVERAGE * (1 - BANK_STANCE_LEVERAGE * stance);
    if (lev > maxLev) return -1;
    if (isPerson(borrower)) premium += BANK_PERSON_PREMIUM;
  }
  const spread = riskSpread(lev) + BANK_STANCE_SPREAD * stance + premium;
  const raw = fin(b.baseRate) + spread;
  const { cap, floor } = rateLimits(s);
  if (cap >= 0 && raw > cap) return -1;
  return Math.max(BANK_MIN_LOAN_RATE, raw, floor);
}

// ---------------------------------------------------------------------------
// Morning
// ---------------------------------------------------------------------------

/** Set baseRate / depositRate from the window rates and the bank's funding position. */
function setRates(s: SimState, dep: number): void {
  const b = s.bank;
  const t = s.treasury;
  const rr0 = fin(t.reserveRate);
  const lr = fin(t.lendRate, rr0);
  // The bank prices deposits and loans on what its reserves actually earn. Reserve interest comes
  // out of the Purse: with auto-mint off and less than BANK_RESERVE_PAY_DAYS of it left there,
  // reserves earn proportionally less (nothing once the Purse is dry), and the bank does not go on
  // paying depositors interest it never receives (which would bleed its capital and choke credit).
  let rr = rr0;
  if (rr0 > 0 && !t.autoMint) {
    const due = (BANK_RESERVE_PAY_DAYS * Math.max(0, b.reserves) * rr0) / DAYS_PER_YEAR;
    if (due > 0) rr = rr0 * clamp(Math.max(0, fin(t.purse)) / due, 0, 1);
  }
  const req = reserveRatio(s) * Math.max(0, dep);
  const short = Math.max(0, req - b.reserves);
  // How much the bank relies on the window at the margin (0 = spare reserves, 1 = fully).
  const tight = clamp((Math.max(0, b.windowDebt) + short) / Math.max(1, BANK_TIGHT_SCALE * Math.max(0, dep)), 0, 1);
  const funding = rr + tight * (lr - rr);
  b.baseRate = fin(funding + BANK_BASE_SPREAD, BANK_BASE_SPREAD);
  b.depositRate = fin(Math.max(Math.min(0, rr), rr - BANK_DEPOSIT_SPREAD));
}

/** Default: seize what the borrower holds, write off the rest, flag the borrower. */
function defaultLoan(s: SimState, ln: Loan): number {
  const who = ln.borrower;
  let keep = 0;
  const p = personOf(s, who);
  if (p) keep = BANK_DEFAULT_KEEP_DAYS * Math.max(0, fin(p.income));
  const avail = Math.max(0, cashOf(s, who) - keep);
  const rec = avail > 0 ? repayPrincipal(s, who, Math.min(ln.principal, avail)) : 0;
  ln.principal = Math.max(0, ln.principal - rec);
  const loss = ln.principal;
  if (loss > 0) writeOff(s, loss);
  ln.principal = 0;
  ln.active = false;
  const f = firmOf(s, who);
  if (f && f.alive) {
    // A firm that cannot pay its bank is pushed into bankruptcy (firms.ts closes it).
    f.distress = Math.max(fin(f.distress), DISTRESS_BANKRUPT_DAYS);
    if (loss >= 200) news(s, `${f.name} has stopped paying its bank loan; the Bank wrote off ${money(loss)}.`, 'bad', f.town);
  }
  bump(s, 'defaults', loss);
  bump(s, 'defaults_n', 1);
  return loss;
}

/** Reprice, collect interest and amortisation, count missed payments, default. */
function serviceLoans(s: SimState, cap: number, floor: number): void {
  const b = s.bank;
  const base = fin(b.baseRate);
  let interestIn = 0;
  let repaid = 0;
  let capped = false;
  let raised = false;
  for (const ln of s.loans) {
    if (!ln.active) continue;
    const who = ln.borrower;
    if (!(ln.principal > 1e-6) || !Number.isFinite(ln.principal)) {
      if (ln.principal > 0 && Number.isFinite(ln.principal)) writeOff(s, ln.principal);
      ln.principal = 0;
      ln.active = false;
      continue;
    }
    if (!borrowerAlive(s, who)) {
      // Nobody left to collect from (estates normally pass debts on first).
      writeOff(s, ln.principal);
      bump(s, 'defaults', ln.principal);
      ln.principal = 0;
      ln.active = false;
      continue;
    }
    const r = rateFor(base, fin(ln.spread), cap, floor);
    if (cap >= 0 || floor >= 0) {
      const free = base + fin(ln.spread);
      if (cap >= 0 && free > cap + 1e-12) capped = true;
      else if (floor >= 0 && free < floor - 1e-12) raised = true;
    }
    ln.rate = r;
    const interest = (ln.principal * r) / DAYS_PER_YEAR;
    const amort = ln.left > 1 ? ln.principal / ln.left : ln.principal;
    const paidI = interest > 0 ? pay(s, who, BANK, interest, 'interest') : 0;
    const paidP = repayPrincipal(s, who, amort);
    ln.principal -= paidP;
    if (ln.principal < 1e-9) ln.principal = 0;
    if (ln.left > 0) ln.left -= 1;
    interestIn += paidI;
    repaid += paidP;
    const f = firmOf(s, who);
    if (f) f.otherCosts += paidI;
    else {
      const p = personOf(s, who);
      if (p) p.earned -= paidI;
    }
    const due = interest + amort;
    if (paidI + paidP >= BANK_PAY_TOLERANCE * due - 1e-9) ln.overdue = 0;
    else ln.overdue += 1;
    if (ln.principal <= 1e-6) {
      if (ln.principal > 0) writeOff(s, ln.principal);
      ln.principal = 0;
      ln.active = false;
    } else if (ln.overdue > LOAN_DEFAULT_OVERDUE_DAYS) defaultLoan(s, ln);
  }
  b.interestIn += interestIn;
  bump(s, 'interest_loans', interestIn);
  bump(s, 'loans_repaid', repaid);
  if (capped) noteBinding(s, 'rateMax', -1, -1);
  if (raised) noteBinding(s, 'rateMin', -1, -1);
}

const _ctx: LevyCtx = {};

/**
 * Deposit interest on every private balance (people, firms, the foreign desk) and IOU
 * coupons to every holder (people in the same pass, and the bank), with 'interest' levies.
 */
function payHolders(s: SimState): void {
  const b = s.bank;
  const t = s.treasury;
  const rDay = fin(b.depositRate) / DAYS_PER_YEAR;
  const cDay = IOU_COUPON / DAYS_PER_YEAR;
  const levies = s.policy.levies.length > 0 && hasLevy(s, 'interest');
  let depInt = 0; // net ¤ the bank paid depositors (negative if they paid it)
  let coupons = 0;

  // Coupons: if the Purse cannot cover them in full (auto-mint off), every holder gets the same share.
  // (Holdings are only counted when the Purse might fall short.)
  let couponFrac = 1;
  if (!t.autoMint && t.purse < 2 * cDay * (Math.max(0, t.iouOutstanding) + Math.max(0, b.iou)) + 1) {
    let holders = Math.max(0, b.iou);
    for (const p of s.people) if (p && p.alive && p.iou > 0) holders += p.iou;
    const due = holders * cDay;
    const avail = Math.max(0, t.purse);
    if (due > 0 && avail < due) {
      couponFrac = avail / due;
      newsOnce(s, 'coupon', `The Purse could not cover today's IOU coupons: holders received ${pctText(couponFrac)} of what they are owed.`, 'crisis');
    }
  }
  if (b.iou > 0 && couponFrac > 0) {
    const c = pay(s, STATE, BANK, b.iou * cDay * couponFrac, 'coupon');
    b.interestIn += c;
    coupons += c;
  }

  for (let i = 0; i < s.people.length; i++) {
    const p = s.people[i];
    if (!p || !p.alive) continue;
    let net = 0;
    // coupons (paid by the Treasury)
    if (p.iou > 0 && couponFrac > 0) {
      const c = pay(s, STATE, p.id, p.iou * cDay * couponFrac, 'coupon');
      coupons += c;
      net += c;
      if (levies && c > 0) {
        _ctx.town = p.town;
        _ctx.person = p;
        _ctx.sector = undefined;
        net -= chargeLevy(s, 'interest', p.id, 'receiver', _ctx, c, 1);
      }
    }
    // deposit interest
    const cash = p.cash;
    if (cash > 0 && rDay !== 0) {
      if (rDay > 0) {
        const a = pay(s, BANK, p.id, cash * rDay, 'interest');
        depInt += a;
        net += a;
        if (levies && a > 0) {
          _ctx.town = p.town;
          _ctx.person = p;
          _ctx.sector = undefined;
          net -= chargeLevy(s, 'interest', p.id, 'receiver', _ctx, a, 1);
        }
      } else {
        const a = pay(s, p.id, BANK, -cash * rDay, 'interest');
        depInt -= a;
        net -= a;
      }
    }
    if (net) p.earned += net;
  }

  if (rDay !== 0) {
    for (let i = 0; i < s.firms.length; i++) {
      const f = s.firms[i];
      if (!f || !f.alive || f.status === 'closed' || !(f.cash > 0)) continue;
      const ref = FIRM_BASE + f.id;
      if (rDay > 0) {
        const a = pay(s, BANK, ref, f.cash * rDay, 'interest');
        depInt += a;
        let net = a;
        if (levies && a > 0) {
          _ctx.town = f.town;
          _ctx.person = undefined;
          _ctx.sector = f.sector;
          net -= chargeLevy(s, 'interest', ref, 'receiver', _ctx, a, 1);
        }
        f.otherCosts -= net; // interest income lowers the firm's net other costs
      } else {
        const a = pay(s, ref, BANK, -f.cash * rDay, 'interest');
        depInt -= a;
        f.otherCosts += a;
      }
    }
    // The foreign desk's coin is a deposit like any other.
    const coin = s.foreign.coin;
    if (coin > 0) {
      if (rDay > 0) {
        const a = pay(s, BANK, FOREIGN, coin * rDay, 'interest');
        depInt += a;
        if (levies && a > 0) {
          _ctx.town = -1;
          _ctx.person = undefined;
          _ctx.sector = undefined;
          chargeLevy(s, 'interest', FOREIGN, 'receiver', _ctx, a, 1);
        }
      } else {
        depInt -= pay(s, FOREIGN, BANK, -coin * rDay, 'interest');
      }
    }
  }
  _ctx.person = undefined;
  if (depInt >= 0) b.interestOut += depInt;
  else b.interestIn -= depInt;
  bump(s, 'interest_deposits', depInt);
  bump(s, 'coupons', coupons);
}

/** Interest between the Treasury and the bank: on reserves (Treasury pays) and on window debt (bank pays). */
function payWindowInterest(s: SimState): void {
  const b = s.bank;
  const t = s.treasury;
  const rr = fin(t.reserveRate);
  const lr = fin(t.lendRate);
  if (b.reserves > 0 && rr !== 0) {
    const a = (b.reserves * Math.abs(rr)) / DAYS_PER_YEAR;
    if (rr > 0) {
      const paid = pay(s, STATE, BANK, a, 'interest');
      b.interestIn += paid;
      bump(s, 'reserve_interest', paid);
    } else {
      const paid = pay(s, BANK, STATE, a, 'interest');
      b.interestOut += paid;
      bump(s, 'reserve_interest', -paid);
    }
  }
  if (b.windowDebt > 0 && lr !== 0) {
    const a = (b.windowDebt * Math.abs(lr)) / DAYS_PER_YEAR;
    if (lr > 0) {
      const paid = pay(s, BANK, STATE, a, 'interest');
      b.interestOut += paid;
      bump(s, 'window_interest', paid);
    } else {
      const paid = pay(s, STATE, BANK, a, 'interest');
      b.interestIn += paid;
      bump(s, 'window_interest', -paid);
    }
  }
}

/** Keep reserves at the target: borrow the gap at the window, repay window debt from a comfortable excess. */
function manageReserves(s: SimState, dep: number): void {
  const b = s.bank;
  const target = reserveTarget(s, dep);
  if (s.policy.limits.length && b.reserves < requiredReserves(s, dep) - 1e-9) noteBinding(s, 'reserveMin', -1, -1);
  if (b.reserves < target) {
    const need = target - b.reserves;
    if (need > 0 && Number.isFinite(need)) {
      windowBorrow(s, need);
      bump(s, 'window_borrow', need);
    }
  } else if (b.windowDebt > 0 && b.reserves > target + BANK_REPAY_HYST * Math.max(0, dep)) {
    const x = windowRepay(s, Math.min(b.windowDebt, b.reserves - target));
    bump(s, 'window_repay', x);
  }
}

/** Repair any non-finite bank field (defensive; a corrupted save must not spread NaN). */
function sanitize(s: SimState): void {
  const b = s.bank;
  if (!Number.isFinite(b.reserves)) b.reserves = 0;
  if (!Number.isFinite(b.windowDebt) || b.windowDebt < 0) b.windowDebt = 0;
  if (!Number.isFinite(b.iou) || b.iou < 0) b.iou = 0;
  if (!Number.isFinite(b.iouBook) || b.iouBook < 0) b.iouBook = 0;
  if (!Number.isFinite(b.stance)) b.stance = 0.3;
  if (!Number.isFinite(b.defaultEma) || b.defaultEma < 0) b.defaultEma = 0;
  if (!Number.isFinite(b.profitMonth)) b.profitMonth = 0;
  if (!Number.isFinite(b.failedDays)) b.failedDays = 0;
  if (!Array.isArray(b.requests)) b.requests = [];
}

/**
 * Morning:
 *  - funding cost = treasury.reserveRate if reserves ≥ required (limits.reserveRatio ×
 *    deposits) else treasury.lendRate; baseRate = funding + BANK_BASE_SPREAD;
 *    depositRate = max(min(0, reserveRate), reserveRate − BANK_DEPOSIT_SPREAD);
 *    (implemented smoothly: the funding cost slides from the reserve rate to the window
 *    rate as window debt + any reserve shortfall grows to BANK_TIGHT_SCALE of deposits)
 *  - every active loan reprices (rate = baseRate + spread, raised to limits.minLoanRate and
 *    capped by limits.maxLoanRate — the cap wins a conflict);
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
 *  - stats.acc: interest_loans, interest_deposits, coupons, defaults (¤ written off),
 *    defaults_n, loans_repaid, reserve_interest, window_interest, window_borrow, window_repay.
 * Interest paid by firms is booked to firm.otherCosts (deposit interest received lowers it);
 * people's interest received/paid and coupons go to person.earned (net of levies).
 */
export function bankBeginDay(s: SimState): void {
  sanitize(s);
  const b = s.bank;
  b.interestIn = 0;
  b.interestOut = 0;
  b.approved = 0;
  b.rejected = 0;
  const dep0 = deposits(s);
  setRates(s, dep0);
  const lim = rateLimits(s);
  serviceLoans(s, lim.cap, lim.floor);
  payHolders(s);
  payWindowInterest(s);
  manageReserves(s, dep0); // (morning deposits: today's interest moves them by a hair)
}

/** Queue a loan request (processed in bankEndDay). A repeated request (same borrower, purpose and project) replaces the earlier one. */
export function requestLoan(s: SimState, req: LoanRequest): void {
  if (!req || !(req.amount > 0) || !Number.isFinite(req.amount)) return;
  if (!isFirm(req.borrower) && !isPerson(req.borrower)) return;
  const b = s.bank;
  if (!Array.isArray(b.requests)) b.requests = [];
  const rq = b.requests;
  for (const r of rq) {
    if (r.borrower === req.borrower && r.purpose === req.purpose && r.project === req.project) {
      r.amount = Math.max(r.amount, req.amount);
      r.term = req.term > 0 ? clamp(Math.round(req.term), 1, BANK_MAX_TERM) : r.term;
      return;
    }
  }
  if (rq.length >= MAX_REQUESTS) return;
  rq.push({
    borrower: req.borrower,
    amount: req.amount,
    term: clamp(Math.round(fin(req.term, WORKING_LOAN_TERM)), 1, BANK_MAX_TERM),
    purpose: req.purpose,
    project: Number.isFinite(req.project) ? req.project : -1,
  });
}

// ---------------------------------------------------------------------------
// Market phase: the IOU portfolio
// ---------------------------------------------------------------------------

/**
 * IOU portfolio: buy with excess reserves when yield > reserveRate + BANK_IOU_MARGIN
 * (+ BANK_IOU_TERM_PREMIUM: IOUs are perpetual, so the bank wants a term premium);
 * sell when reserves are short of requirement or it is borrowing at the window at a
 * rate above the IOU yield (cheaper to sell than to borrow), or when the yield has
 * fallen below the reserve rate (take the gain). Adds orders to books.iou.
 */
export function bankOrders(s: SimState, books: Books): void {
  const b = s.bank;
  const book = books.iou ?? bookFor(books, -1, IOU_GOOD);
  if (!book) return;
  const p = Math.max(1, fin(s.iouMarket.ema, CFG.IOU_PAR));
  const y = IOU_COUPON / p;
  const rr = fin(s.treasury.reserveRate);
  const lr = fin(s.treasury.lendRate);
  const dep = Math.max(0, deposits(s));
  const target = reserveTarget(s, dep);
  const shortfall = Math.max(0, b.windowDebt) + Math.max(0, target - b.reserves);

  // ---- sells ----
  let sold = false;
  if (b.iou > 1e-9) {
    let q = 0;
    let lim = p;
    if (shortfall > 0 && y < lr + BANK_IOU_MARGIN) {
      // Raise reserves by selling IOUs rather than paying the window rate on them.
      q = Math.min(b.iou, (0.5 * shortfall) / p);
      lim = p * 0.98;
    } else if (y < rr) {
      q = b.iou * 0.05;
      lim = p * 0.99;
    }
    if (q > 1e-6) {
      addAsk(book, BANK, lim, q);
      sold = true;
    }
  }

  // ---- buys ----
  if (sold || b.failed) return;
  const excess = b.reserves - target - Math.max(0, b.windowDebt);
  if (!(excess > 0)) return;
  const hurdle = rr + BANK_IOU_MARGIN + BANK_IOU_TERM_PREMIUM;
  if (!(y > hurdle)) return;
  const room = BANK_IOU_MAX_SHARE * dep - Math.max(0, b.iouBook);
  const amount = Math.min(excess * BANK_IOU_BUY_FRACTION, room);
  if (!(amount > 1)) return;
  const pMax = IOU_COUPON / Math.max(0.005, hurdle);
  const lim = Math.min(pMax, p * 1.02);
  if (lim > 0) addBid(book, BANK, lim, amount / lim);
}

// ---------------------------------------------------------------------------
// Evening: loan decisions, stance, dividends, failure
// ---------------------------------------------------------------------------

interface Decision {
  amount: number;
  rate: number;
  spread: number;
  reason: string;
}
const _dec: Decision = { amount: 0, rate: 0, spread: 0, reason: '' };

/** Estimated value of a construction project at today's prices in its town (collateral). */
function projectValue(s: SimState, projectId: number): number {
  if (projectId < 0) return 0;
  for (const pr of s.projects) {
    if (pr.id !== projectId) continue;
    const prices: number[] = [];
    for (let g = 0; g < N_GOODS; g++) prices.push(Math.max(0, fin(marketOf(s, pr.town, g).ema)));
    const town = s.towns[pr.town];
    const wage = town && town.avgWage > 0 ? town.avgWage : fin(s.stats.baseWage, BASE_WAGE) || BASE_WAGE;
    return fin(materialsValue(pr.need, prices, wage, BUILD_MARGIN));
  }
  return 0;
}

/** Annual cash yield the bank expects on the capital a loan finances. */
function projectYield(s: SimState, req: LoanRequest): number {
  if (req.purpose !== 'house') return BANK_PROJECT_YIELD;
  let town = -1;
  for (const pr of s.projects) if (pr.id === req.project) town = pr.town;
  const p = personOf(s, req.borrower);
  if (town < 0 && p) town = p.town;
  const t = town >= 0 ? s.towns[town] : undefined;
  const rent = t && t.avgRent > 0 ? t.avgRent : BASE_RENT_SHARE * (fin(s.stats.baseWage, BASE_WAGE) || BASE_WAGE);
  let value = projectValue(s, req.project);
  if (!(value > 0)) value = req.amount / Math.max(0.05, 1 - ENTRY_OWNER_EQUITY);
  return clamp((rent * HOUSE_SLOTS * DAYS_PER_YEAR) / Math.max(1, value), 0.02, 0.3);
}

/**
 * Decide one request. Criteria (all tighten with the stance):
 *  - capital: equity / (loans + amount) ≥ minCapital + BANK_STANCE_CAPITAL·stance;
 *  - leverage: (debt + amount) / (assets + amount) ≤ BANK_MAX_LEVERAGE·(1 − BANK_STANCE_LEVERAGE·stance);
 *  - coverage ≥ BANK_DSCR·(1 + BANK_STANCE_DSCR·stance), where for working capital
 *    coverage = cash flow / full debt service (interest + amortisation), and for loans
 *    that finance new capital (invest, startup, house, project) = (cash flow + the
 *    capital's assumed yield) / interest — asset-backed term credit leans on collateral;
 *  - the risk-adjusted rate must not exceed a legal rate ceiling (else: rationed).
 * Working-capital requests may be approved in part (down to BANK_PARTIAL_MIN).
 */
function decide(s: SimState, req: LoanRequest, loansNow: number, cap: number, floor: number): Decision {
  const b = s.bank;
  const d = _dec;
  d.amount = 0;
  d.rate = 0;
  d.spread = 0;
  d.reason = '';
  const who = req.borrower;
  if (!borrowerAlive(s, who)) {
    d.reason = 'gone';
    return d;
  }
  const stance = clamp(fin(b.stance, 0.3), 0, 1);
  const term = Math.max(1, req.term);
  const asset = req.purpose !== 'working';
  const f = firmOf(s, who);
  const p = f ? undefined : personOf(s, who);

  // capital headroom (term credit must leave room for working capital)
  const capNeed = minCapital(s) + BANK_STANCE_CAPITAL * stance + (asset ? BANK_TERM_CAPITAL_EXTRA : 0);
  const capRoom = fin(b.equity) / Math.max(1e-6, capNeed) - loansNow;
  // existing obligations
  let debt0 = 0;
  let interest0 = 0;
  let service0 = 0;
  let late = 0;
  for (const ln of s.loans) {
    if (!ln.active || ln.borrower !== who) continue;
    if (ln.overdue > late) late = ln.overdue;
    debt0 += ln.principal;
    const i = (ln.principal * Math.max(0, ln.rate)) / DAYS_PER_YEAR;
    interest0 += i;
    service0 += i + ln.principal / Math.max(1, ln.left);
  }
  // A borrower already behind on its payments gets no new credit.
  if (late > BANK_LATE_REFUSE_DAYS) {
    d.reason = 'overdue';
    return d;
  }
  const assets0 = assetsOf(s, who);
  // cash flow available for debt service (¤/day)
  let cf = 0;
  if (f) {
    cf = fin(f.profit) + interest0; // profit is after interest; add it back
    // Term credit leans on the capital it finances; a working-capital line must also cover
    // the firm's running losses — lending to fund a loss only defers the default.
    if (asset) cf = Math.max(0, cf);
    if (s.day - f.founded < BANK_YOUNG_FIRM_DAYS) cf = Math.max(cf, (assets0 * BANK_PROJECT_YIELD) / DAYS_PER_YEAR);
  } else if (p) {
    cf = BANK_INCOME_DEBT_SHARE * Math.max(0, fin(p.income));
  }
  // (a mortgage against houses already built finances no new capital: judged on the borrower's own income)
  const yieldNew = asset && !(req.purpose === 'house' && req.project < 0) ? projectYield(s, req) : 0;
  const dscrNeed = BANK_DSCR * (1 + BANK_STANCE_DSCR * stance);
  const maxLev = BANK_MAX_LEVERAGE * (1 - BANK_STANCE_LEVERAGE * stance);
  const premium = (p ? BANK_PERSON_PREMIUM : 0) + (req.purpose === 'startup' ? BANK_STARTUP_PREMIUM : 0) + BANK_STANCE_SPREAD * stance;
  const base = fin(b.baseRate);

  const test = (a: number): string => {
    if (a > capRoom) return 'capital';
    const lev = (debt0 + a) / Math.max(1e-6, assets0 + a);
    if (lev > maxLev) return 'leverage';
    const spread = riskSpread(lev) + premium;
    const raw = base + spread;
    if (cap >= 0 && raw > cap) return 'ratecap';
    const r = Math.max(BANK_MIN_LOAN_RATE, raw, floor);
    // Coverage is judged on interest, with the yield the new money earns counted in: term credit
    // finances capital (BANK_PROJECT_YIELD or the rent yield), working capital finances the
    // stock and payroll a firm turns over — it pays for itself as the goods are sold. Judging a
    // working-capital line on full amortisation within its term would refuse a sound firm the
    // day its profit dips, which is exactly when a firm needs to bridge. Leverage and capital
    // still bound every loan.
    const interest = interest0 + (a * r) / DAYS_PER_YEAR;
    const cov = interest > 1e-12 ? (cf + (a * (asset ? yieldNew : BANK_WORKING_YIELD)) / DAYS_PER_YEAR) / interest : 99;
    void service0;
    void term;
    if (cov < dscrNeed) return 'coverage';
    d.spread = spread;
    d.rate = r;
    return '';
  };

  const full = req.amount;
  const why = test(full);
  if (!why) {
    d.amount = full;
    return d;
  }
  d.reason = why;
  if (asset || why === 'ratecap') return d;
  // Working capital: find the largest acceptable amount (all criteria are monotone in a).
  let lo = BANK_PARTIAL_MIN * full;
  if (test(lo)) return d;
  let hi = full;
  for (let k = 0; k < 12; k++) {
    const mid = 0.5 * (lo + hi);
    if (test(mid)) hi = mid;
    else lo = mid;
  }
  if (test(lo) === '' && lo >= BANK_MIN_LOAN) {
    d.amount = lo;
    d.reason = 'partial';
  }
  return d;
}

/** Outcome of one loan request (see lastLoanDecisions). */
export interface LoanDecision {
  borrower: Ref;
  purpose: LoanPurpose;
  project: number;
  requested: number;
  /** ¤ lent (0 = refused). */
  amount: number;
  /** Loan id, or -1 if refused. */
  loan: number;
  /** '' approved in full, 'partial', or why it was refused: 'failed' | 'capital' | 'leverage' | 'coverage' | 'ratecap' | 'overdue' | 'gone' | 'small'. */
  reason: string;
}

/**
 * The decisions of the most recent evening the bank processed requests (day stamped).
 * Approved project loans also set project.loan (if unset). Runtime data: rebuilt daily, not saved.
 */
export function lastLoanDecisions(s: SimState): { day: number; items: LoanDecision[] } {
  const d = rt(s).bag.bankDecisions as { day: number; items: LoanDecision[] } | undefined;
  return d ?? { day: -1, items: [] };
}

function processRequests(s: SimState): void {
  const b = s.bank;
  const rq = b.requests;
  if (!rq.length) return;
  const log: { day: number; items: LoanDecision[] } = { day: s.day, items: [] };
  rt(s).bag.bankDecisions = log;
  const { cap, floor } = rateLimits(s);
  let loansNow = loansOutstanding(s);
  let lent = 0;
  let rationed = 0;
  let capitalShort = 0;
  for (const req of rq) {
    const item: LoanDecision = { borrower: req.borrower, purpose: req.purpose, project: req.project, requested: req.amount, amount: 0, loan: -1, reason: '' };
    log.items.push(item);
    if (b.failed || !(req.amount >= BANK_MIN_LOAN) || !Number.isFinite(req.amount)) {
      item.reason = b.failed ? 'failed' : 'small';
      b.rejected++;
      continue;
    }
    const d = decide(s, req, loansNow, cap, floor);
    item.reason = d.reason;
    if (d.reason === 'ratecap') rationed++;
    if (d.reason === 'capital') capitalShort++;
    if (!(d.amount >= BANK_MIN_LOAN)) {
      if (!item.reason) item.reason = 'small';
      b.rejected++;
      continue;
    }
    const a = d.amount;
    const ln = newLoan(s, req.borrower, a, d.spread, d.rate, Math.max(1, req.term), req.purpose as LoanPurpose);
    disburse(s, req.borrower, a);
    item.amount = a;
    item.loan = ln.id;
    if (req.project >= 0) {
      for (const pr of s.projects) if (pr.id === req.project && pr.loan < 0) pr.loan = ln.id;
    }
    loansNow += a;
    lent += a;
    b.approved++;
  }
  rq.length = 0;
  bump(s, 'loans_new', lent);
  bump(s, 'loans_rationed', rationed);
  if (rationed > 0) noteBinding(s, 'rateMax', -1, -1);
  if (capitalShort > 0) noteBinding(s, 'capitalMin', -1, -1);
  if (rationed > 0 && cap >= 0) {
    newsOnce(s, 'ratecap', `The Bank turned away ${rationed} borrower${rationed > 1 ? 's' : ''} it would only lend to above the legal maximum rate.`, 'info');
  }
}

/** Stance drifts toward a target set by recent losses and capital headroom: tightens fast, loosens slowly. */
function updateStance(s: SimState): void {
  const b = s.bank;
  const lossAnnual = Math.max(0, fin(b.defaultEma)) * DAYS_PER_YEAR;
  const cr = capitalRatio(s);
  let target = BANK_STANCE_BASE + BANK_STANCE_LOSS_SENS * lossAnnual + BANK_STANCE_CAP_SENS * Math.max(0, minCapital(s) + 0.04 - cr);
  if (b.failed) target = 1;
  target = clamp(target, 0, 1);
  const st = clamp(fin(b.stance, 0.3), 0, 1);
  const diff = target - st;
  b.stance = clamp(st + (diff > 0 ? Math.min(diff, BANK_STANCE_UP) : Math.max(diff, -BANK_STANCE_DOWN)), 0, 1);
}

/** Today's write-offs from every source (bank defaults, bankruptcies, estates): delta of the cumulative counter. */
function todaysWriteoffs(s: SimState): number {
  const bag = rt(s).bag;
  const mem = bag.bankWriteoffs as { day: number; total: number } | undefined;
  const total = fin(s.bank.writeoffs);
  let wo: number;
  if (mem && mem.day === s.day - 1 && total >= mem.total) wo = total - mem.total;
  else wo = Math.max(0, fin(s.stats.acc.writeoffs)); // first day (or after a load)
  bag.bankWriteoffs = { day: s.day, total };
  return wo;
}

/** Month end: pay the owner a share of the month's profit while capital is comfortable. */
function payDividends(s: SimState): void {
  const b = s.bank;
  const profit = fin(b.profitMonth);
  b.profitMonth = 0;
  if (b.failed) return;
  // Capital is judged against the loan book the bank should be able to carry, not only the one it has.
  const L = Math.max(loansOutstanding(s), BANK_DIVIDEND_BOOK_SHARE * Math.max(0, deposits(s)));
  const cr = fin(b.equity) / Math.max(1, L);
  if (!(cr > BANK_DIVIDEND_CAPITAL)) return;
  // Payout share rises from BANK_DIVIDEND_SHARE to 1 as capital goes from 1× to 2× the dividend floor;
  // a bank with far more capital than it needs also hands back part of the excess.
  const share = BANK_DIVIDEND_SHARE + (1 - BANK_DIVIDEND_SHARE) * clamp((cr - BANK_DIVIDEND_CAPITAL) / BANK_DIVIDEND_CAPITAL, 0, 1);
  let div = share * Math.max(0, profit);
  const ample = Math.max(2 * BANK_DIVIDEND_CAPITAL * L, INIT_BANK_EQUITY_MIN);
  if (b.equity > ample) div += 0.05 * (b.equity - ample);
  div = Math.min(div, b.equity - BANK_DIVIDEND_CAPITAL * L);
  if (!(div > 0.5)) return;
  const owner = s.bank.owner;
  const op = owner >= 0 ? s.people[owner] : undefined;
  if (op && op.alive) {
    const paid = pay(s, BANK, op.id, div, 'dividend');
    op.earned += paid;
    bump(s, 'bank_dividends', paid);
  } else {
    bump(s, 'bank_dividends', pay(s, BANK, STATE, div, 'dividend')); // no owner: the Treasury holds the bank
  }
}

/** Failure, recovery and bail-in. */
function failureStep(s: SimState): void {
  const b = s.bank;
  if (!b.failed) {
    if (b.equity < -EQUITY_EPS) {
      b.failed = true;
      b.failedDays = 0;
      news(s, `The Bank's losses now exceed its own capital (${money(b.equity)}). It has stopped making new loans; its depositors are uneasy.`, 'crisis');
    }
    return;
  }
  if (b.equity >= -EQUITY_EPS) {
    b.failed = false;
    b.failedDays = 0;
    news(s, 'The Bank\'s own capital is positive again and it has resumed lending.', 'good');
    return;
  }
  b.failedDays += 1;
  if (b.failedDays < BANK_FAIL_GRACE_DAYS) return;
  // No new capital arrived: depositors absorb the loss, and enough of their balances is
  // converted into the bank's capital for it to meet its minimum again (and lend).
  const L = loansOutstanding(s);
  // (above the stance buffer too: after heavy losses the stance is tight for a long while)
  const need = Math.max(1, (minCapital(s) + BANK_STANCE_CAPITAL + BANK_BAILIN_TARGET) * Math.max(0, L)) - b.equity;
  const dep = deposits(s);
  const frac = dep > 0 ? clamp(need / dep, 0, 1) : 0;
  const cut = frac > 0 ? bailIn(s, frac) : 0;
  b.failed = b.equity < -EQUITY_EPS;
  b.failedDays = 0;
  b.stance = 1;
  news(
    s,
    `With no new capital, every balance at the Bank was cut by ${pctText(frac)} (${money(cut)} in all) to cover its losses.` +
      (b.failed ? ' It is still short of capital.' : ' It has reopened for lending.'),
    'crisis',
  );
}

/**
 * Evening: decide queued loan requests (DSCR ≥ BANK_DSCR, leverage ≤ BANK_MAX_LEVERAGE,
 * capital ratio after loan ≥ minCapital (BANK_MIN_CAPITAL, or a capitalMin Limit in its place,
 * never below BANK_OWN_MIN_CAPITAL), stance; a rate cap below the risk-adjusted rate → reject;
 * a rate floor raises the rate the borrower's coverage is judged at); approved → Loan record + ledger.disburse.
 * Stance tightens with defaultEma, loosens slowly. Monthly dividends to the owner when
 * capital ratio > 12 %. Failure: equity < 0 → failed (no new loans, news 'crisis');
 * after BANK_FAIL_GRACE_DAYS still < 0 → bailIn to restore capital (to the minimum ratio +
 * the full stance buffer + BANK_BAILIN_TARGET, so the bank can lend again), news.
 * Recovery when equity > 0 (e.g. the player transfers to the bank).
 * Also: overnight reserve management at the window and pruning of inactive loans.
 * stats.acc: loans_new (¤ lent today), loans_rationed, bank_dividends.
 */
export function bankEndDay(s: SimState): void {
  sanitize(s);
  const b = s.bank;
  const wo = todaysWriteoffs(s);
  const L = loansOutstanding(s);
  b.defaultEma = ema(fin(b.defaultEma), wo / Math.max(1, L + wo), BANK_DEFAULT_EMA); // share of the book lost today
  b.profitMonth = fin(b.profitMonth) + b.interestIn - b.interestOut - wo;
  failureStep(s);
  updateStance(s);
  processRequests(s);
  if (isMonthEnd(s.day)) payDividends(s);
  manageReserves(s, deposits(s));
  pruneLoans(s);
  // IOUs are carried at cost; report the unrealised gain (+) / loss (−) at today's price.
  if (b.iou > 0) s.stats.acc.bank_iou_unrealised = b.iou * Math.max(0, fin(s.iouMarket.ema)) - b.iouBook;
}

/** Drop inactive loans from s.loans (in place). */
function pruneLoans(s: SimState): void {
  const ls = s.loans;
  let k = 0;
  for (let i = 0; i < ls.length; i++) if (ls[i].active) ls[k++] = ls[i];
  ls.length = k;
}
