// ============================================================================
// The Bank's credit judgement: how likely a borrower is to default, learned from its own loans.
// OWNER: finance agent. See DESIGN §3.5.
//
// A loan officer's rule of thumb gives the first view (priorPd, a yearly default probability): debt
// against assets — for a house being built, the loan's share of the house's cost — the cover the
// borrower's cash flow gives the interest, a firm's youth and distress, and how far behind with its
// payments a loan already is. A small neural network learns, from what the bank's loans actually did,
// how far off that rule is for this realm, its trades, its towns and its times:
//
//   logit(monthly default probability) = logit(prior, monthly) + net(features), the net softly bounded
//   to ±CREDIT_MAX_ADJ.
//
// Learning: at each month's end the bank looks back on the loans it held when the month began (their
// features then, s.bank.credit.watch): a loan that has since ended in a loss defaulted (1), every other
// did not (0). Per loan-month, the direct weight on each fact takes a Bayesian step (online logistic
// regression: its covariance shares the surprise among the facts by how much is known of each) and the
// hidden units, which learn how facts combine, a step of gradient descent. The net starts at ≈ 0 — it
// knows nothing until loans have run — so a young realm is judged by the rule of thumb alone. What a
// default cost (the share of the principal lost) is learned the same way (lgd, lgdHouse).
//
// The bank prices new credit on the expected loss (PD × LGD) and refuses borrowers it thinks too likely
// to default (bank.decide); the same view gives the expected loss on the whole book, which its mood
// compares with what it actually loses (bank.updateStance): losses it did not expect, against its
// capital, make it wary; losses it expected — and charged for — do not.
//
// State (plain JSON, s.bank.credit): the net's weights, the watch list, losses noted this month, the
// learned loss rates, the bank's wariness. The net's starting weights are small stateless draws
// (rng.decisionRand), so creating it leaves the realm's random stream untouched.
// ============================================================================
import {
  CREDIT_COVER_SAFE,
  CREDIT_HIDDEN,
  CREDIT_LEARN_RATE,
  CREDIT_LGD0,
  CREDIT_LGD_EMA,
  CREDIT_LGD_HOUSE0,
  CREDIT_MAX_ADJ,
  CREDIT_PRIOR_BASE,
  CREDIT_PRIOR_COVER,
  CREDIT_PRIOR_DISTRESS,
  CREDIT_PRIOR_HOUSE,
  CREDIT_PRIOR_LATE,
  CREDIT_PRIOR_LEV,
  CREDIT_PRIOR_VAR,
  CREDIT_DRIFT_VAR,
  CREDIT_PRIOR_YOUNG,
  LOAN_DEFAULT_OVERDUE_DAYS,
} from '../config';
import { decisionRand } from '../rng';
import type { BankCredit, Loan, LoanPurpose, SimState } from '../types';
import { clamp, fin } from '../util';

/** Inputs of the net: bias, person, young firm, purpose (5), leverage, LTV, cover, overdue, distress, margin, unemployment, inflation. */
export const CREDIT_INPUTS = 16;

const PURPOSES: LoanPurpose[] = ['working', 'invest', 'startup', 'house', 'project'];

/** What the bank knows of a borrower and a loan when it judges it. */
export interface CreditFacts {
  person: boolean;
  /** A firm younger than BANK_YOUNG_FIRM_DAYS. */
  young: boolean;
  purpose: LoanPurpose;
  /** Debt / assets, the loan included. */
  leverage: number;
  /** A house being built: the loan's share of its cost (works and plot); else 0. */
  ltv: number;
  /** (Cash flow + what the new capital earns) / interest, a day. */
  cover: number;
  /** Days behind with payments (0 for a new loan). */
  overdue: number;
  /** A firm's distress days / DISTRESS_BANKRUPT_DAYS (0 for a person). */
  distress: number;
  /** A firm's profit against its costs; a person's income against a wage, less 1. */
  margin: number;
  /** Unemployment in the borrower's town. */
  unemp: number;
  /** The realm's inflation, a year. */
  infl: number;
}

/** The credit state (created on first use, repaired if malformed). */
export function creditState(s: SimState): BankCredit {
  const b = s.bank;
  let c = b.credit;
  const n = CREDIT_INPUTS * CREDIT_HIDDEN;
  if (!c || !c.net || !Array.isArray(c.net.w1) || c.net.w1.length !== n || !Array.isArray(c.net.w2) || c.net.w2.length !== CREDIT_HIDDEN) {
    const seed = (fin(s.seed) | 0) ^ 0x5bd1e995;
    const w1: number[] = [];
    for (let k = 0; k < n; k++) w1.push(Math.round((decisionRand(seed, 71, k) - 0.5) * 0.2 * 1e6) / 1e6);
    const w2: number[] = [];
    for (let k = 0; k < CREDIT_HIDDEN; k++) w2.push(Math.round((decisionRand(seed, 72, k) - 0.5) * 0.02 * 1e6) / 1e6);
    c = {
      net: { v: new Array(CREDIT_INPUTS).fill(0), P: priorCov(), w1, b1: new Array(CREDIT_HIDDEN).fill(0), w2, b2: 0 },
      watch: c && Array.isArray(c.watch) ? c.watch : [],
      lost: c && Array.isArray(c.lost) ? c.lost : [],
      seen: fin(c?.seen ?? 0),
      defaults: fin(c?.defaults ?? 0),
      lgd: fin(c?.lgd ?? CREDIT_LGD0, CREDIT_LGD0),
      lgdHouse: fin(c?.lgdHouse ?? CREDIT_LGD_HOUSE0, CREDIT_LGD_HOUSE0),
      fear: fin(c?.fear ?? 0),
      expLoss: fin(c?.expLoss ?? 0),
      lossDaily: fin(c?.lossDaily ?? 0),
      woSeen: c?.woSeen,
      err: fin(c?.err ?? 0),
      capShortDay: fin(c?.capShortDay ?? -9999, -9999),
    };
    b.credit = c;
  }
  if (!Array.isArray(c.net.v) || c.net.v.length !== CREDIT_INPUTS) c.net.v = new Array(CREDIT_INPUTS).fill(0);
  if (!Array.isArray(c.net.P) || c.net.P.length !== CREDIT_INPUTS * CREDIT_INPUTS) c.net.P = priorCov();
  return c;
}

/** The direct weights' covariance before any loan is seen: CREDIT_PRIOR_VAR on each, independent. */
function priorCov(): number[] {
  const n = CREDIT_INPUTS;
  const P = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) P[i * n + i] = CREDIT_PRIOR_VAR;
  return P;
}

/** The loan officer's rule of thumb: a yearly default probability. */
export function priorPd(c: CreditFacts): number {
  let p = CREDIT_PRIOR_BASE;
  if (c.purpose === 'house' && c.ltv > 0) p += CREDIT_PRIOR_HOUSE * c.ltv * c.ltv;
  else p += CREDIT_PRIOR_LEV * clamp(c.leverage, 0, 1.5) ** 2;
  p += CREDIT_PRIOR_COVER * clamp((CREDIT_COVER_SAFE - fin(c.cover, CREDIT_COVER_SAFE)) / CREDIT_COVER_SAFE, 0, 1);
  if (c.young) p += CREDIT_PRIOR_YOUNG;
  p += CREDIT_PRIOR_DISTRESS * clamp(c.distress, 0, 1);
  p += CREDIT_PRIOR_LATE * clamp(c.overdue / Math.max(1, LOAN_DEFAULT_OVERDUE_DAYS), 0, 1);
  return clamp(p, 0.001, 0.95);
}

/** The net's inputs for a judgement (continuous facts centred on a typical sound loan, so the bias carries the level). */
export function creditFeatures(c: CreditFacts): number[] {
  const x = new Array(CREDIT_INPUTS).fill(0);
  x[0] = 1;
  x[1] = c.person ? 1 : 0;
  x[2] = c.young ? 1 : 0;
  const k = PURPOSES.indexOf(c.purpose);
  if (k >= 0) x[3 + k] = 1;
  x[8] = clamp(fin(c.leverage), 0, 1.5) - 0.4;
  x[9] = clamp(fin(c.ltv), 0, 1.2);
  x[10] = clamp((Math.log(Math.max(0.05, fin(c.cover, CREDIT_COVER_SAFE))) - Math.log(CREDIT_COVER_SAFE)) / 2, -2, 2);
  x[11] = clamp(fin(c.overdue) / Math.max(1, LOAN_DEFAULT_OVERDUE_DAYS), 0, 1.5);
  x[12] = clamp(fin(c.distress), 0, 1);
  x[13] = clamp(fin(c.margin), -1, 1);
  x[14] = clamp(5 * (fin(c.unemp) - 0.05), -0.25, 2);
  x[15] = clamp(fin(c.infl), -0.5, 1);
  return x;
}

const monthly = (annual: number): number => 1 - Math.pow(1 - clamp(annual, 0, 0.999), 1 / 12);
const yearly = (month: number): number => 1 - Math.pow(1 - clamp(month, 0, 0.999), 12);
const logit = (p: number): number => {
  const q = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(q / (1 - q));
};
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-clamp(z, -30, 30)));

/** The net's correction (a direct term per fact plus the hidden units, which learn how facts combine), softly bounded to ±CREDIT_MAX_ADJ (MAX·tanh(raw/MAX)); `grad` gets d(correction)/d(raw). */
function forward(net: BankCredit['net'], x: readonly number[], h: number[], grad?: { d: number }): number {
  let y = net.b2;
  for (let i = 0; i < CREDIT_INPUTS; i++) y += net.v[i] * x[i];
  for (let j = 0; j < CREDIT_HIDDEN; j++) {
    let a = net.b1[j];
    for (let i = 0; i < CREDIT_INPUTS; i++) a += net.w1[j * CREDIT_INPUTS + i] * x[i];
    h[j] = Math.tanh(a);
    y += net.w2[j] * h[j];
  }
  const u = Math.tanh(fin(y) / CREDIT_MAX_ADJ);
  if (grad) grad.d = 1 - u * u;
  return CREDIT_MAX_ADJ * u;
}

const _h: number[] = new Array(CREDIT_HIDDEN).fill(0);

/** The monthly default probability for these facts (prior corrected by experience). */
function monthlyPd(s: SimState, c: CreditFacts, x = creditFeatures(c)): number {
  const net = creditState(s).net;
  return sigmoid(logit(monthly(priorPd(c))) + forward(net, x, _h));
}

/** The yearly default probability the bank now reckons for these facts. */
export function creditPd(s: SimState, c: CreditFacts): number {
  return yearly(monthlyPd(s, c));
}

/** Share of the principal the bank expects to lose if this loan defaults. */
export function creditLgd(s: SimState, purpose: LoanPurpose): number {
  const c = creditState(s);
  return clamp(purpose === 'house' ? c.lgdHouse : c.lgd, 0.05, 1);
}

/**
 * Learn from one loan-month (y: 1 defaulted, 0 not). The direct weights take a Bayesian step (the Laplace / extended
 * Kalman update of a logistic regression: the covariance P apportions the surprise among the facts by how much is
 * already known about each, so losses among startups do not also make it doubt established firms); the hidden units a
 * step of gradient descent on the same error. The soft bound flattens both near ±CREDIT_MAX_ADJ.
 */
const _g = { d: 1 };
const _ph: number[] = new Array(CREDIT_INPUTS).fill(0);
function train(s: SimState, x: readonly number[], prior: number, y: number): number {
  const net = creditState(s).net;
  const n = CREDIT_INPUTS;
  const h = _h;
  const z = logit(monthly(prior)) + forward(net, x, h, _g);
  const p = sigmoid(z);
  const err = p - y;
  const g = _g.d;
  // direct weights: P ← P − w·(P g x)(P g x)ᵀ / (1 + w·g²·xᵀPx), v ← v − (P_new g x)·err, w = p(1 − p)
  const P = net.P;
  let xPx = 0;
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (let k = 0; k < n; k++) a += P[i * n + k] * x[k];
    _ph[i] = g * a;
    xPx += g * x[i] * _ph[i];
  }
  const w = Math.max(1e-6, p * (1 - p));
  const denom = 1 + w * Math.max(0, xPx);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) P[i * n + k] = fin(P[i * n + k] - (w * _ph[i] * _ph[k]) / denom);
    net.v[i] = fin(net.v[i] - (_ph[i] / denom) * clamp(err, -1, 1));
  }
  // hidden units
  const e = clamp(err, -1, 1) * g;
  const lr = CREDIT_LEARN_RATE;
  for (let j = 0; j < CREDIT_HIDDEN; j++) {
    const back = e * net.w2[j] * (1 - h[j] * h[j]);
    net.w2[j] = fin(net.w2[j] - lr * e * h[j]);
    net.b1[j] = fin(net.b1[j] - lr * back);
    for (let i = 0; i < n; i++) net.w1[j * n + i] = fin(net.w1[j * n + i] - lr * back * x[i]);
  }
  return Math.abs(err);
}

/** Month's end: some doubt returns (times change), never more than before any loan was seen; P kept symmetric. */
function drift(net: BankCredit['net']): void {
  const n = CREDIT_INPUTS;
  const P = net.P;
  for (let i = 0; i < n; i++) {
    const d = P[i * n + i];
    P[i * n + i] = d < CREDIT_PRIOR_VAR ? Math.min(CREDIT_PRIOR_VAR, d + CREDIT_DRIFT_VAR) : d;
    for (let k = i + 1; k < n; k++) {
      const m = 0.5 * (P[i * n + k] + P[k * n + i]);
      P[i * n + k] = m;
      P[k * n + i] = m;
    }
  }
}

/** A loan ended in a loss of `lost` ¤ (bank default, a borrower gone, a firm wound up, an estate without heir). */
export function noteLoss(s: SimState, ln: Loan, lost: number): void {
  if (!(lost > 1e-6) || !ln) return;
  const c = creditState(s);
  c.lost.push({ loan: ln.id, lost: Math.round(lost * 100) / 100 });
  if (c.lost.length > 2000) c.lost.splice(0, c.lost.length - 2000);
}

/**
 * Month's end: learn from the loans watched since the month began, then watch the loans now held
 * (their facts today, from `factsOf`) and reckon the book's expected yearly loss (c.expLoss, ¤).
 */
export function creditMonthEnd(s: SimState, factsOf: (ln: Loan) => CreditFacts | null): void {
  const c = creditState(s);
  const lostBy = new Map<number, number>();
  for (const l of c.lost) lostBy.set(l.loan, (lostBy.get(l.loan) ?? 0) + l.lost);
  let err = 0;
  let n = 0;
  for (const w of c.watch) {
    const lost = lostBy.get(w.loan) ?? 0;
    const y = lost > 0 ? 1 : 0;
    err += train(s, w.x, w.prior, y);
    n++;
    if (y) {
      c.defaults += 1;
      const share = clamp(lost / Math.max(1e-6, w.principal), 0, 1);
      if (w.house) c.lgdHouse = fin(c.lgdHouse + CREDIT_LGD_EMA * (share - c.lgdHouse), CREDIT_LGD_HOUSE0);
      else c.lgd = fin(c.lgd + CREDIT_LGD_EMA * (share - c.lgd), CREDIT_LGD0);
    }
  }
  c.seen += n;
  drift(c.net);
  if (n > 0) c.err = fin(0.8 * c.err + 0.2 * (err / n));
  c.lost = [];
  // the new month's watch, and what the book is expected to lose a year
  const watch: BankCredit['watch'] = [];
  let expLoss = 0;
  for (const ln of s.loans) {
    if (!ln.active || !(ln.principal > 0)) continue;
    const f = factsOf(ln);
    if (!f) continue;
    const x = creditFeatures(f);
    const prior = priorPd(f);
    const pd = yearly(sigmoid(logit(monthly(prior)) + forward(c.net, x, _h)));
    expLoss += pd * creditLgd(s, ln.purpose) * ln.principal;
    watch.push({ loan: ln.id, x: x.map((v) => Math.round(v * 1e5) / 1e5), prior: Math.round(prior * 1e6) / 1e6, principal: Math.round(ln.principal * 100) / 100, house: ln.purpose === 'house' });
  }
  c.watch = watch;
  c.expLoss = fin(expLoss);
}
