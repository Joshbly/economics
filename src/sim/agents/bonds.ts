// ============================================================================
// The IOU market: what an IOU is worth to whoever might hold it. OWNER: finance
// agent. See DESIGN §3.5.
//
// An IOU pays IOU_COUPON a year for ever (a perpetual). To a holder it is worth the
// coupon over the yield it asks of it — IOU_COUPON / y (never below IOU_MIN_YIELD) — and
// the share of its savings it wants in IOUs grows with how far the yield on offer beats
// that (a portfolio: none at its worth, all it would ever hold once they yield `full` more;
// iouWanted). Each day it moves part of the way to the holding it wants at each price, as a
// ladder of bids and asks (postIouSchedule) — so the market's price is where everyone's
// wanted holdings add up to the IOUs there are. The Treasury selling more pushes the price
// down until savers want them; buying them back pushes it up until holders let them go, and
// offered well over their worth, holders sell at once. The yield asked is made of:
//
//   · the short rate expected over the years ahead:
//       (1 − IOU_TAYLOR_WEIGHT) · [IOU_NOW_WEIGHT · today's reserve rate
//                                  + (1 − IOU_NOW_WEIGHT) · its average over IOU_RATE_MEMORY_DAYS]
//       + IOU_TAYLOR_WEIGHT · (IOU_NEUTRAL_REAL + expected inflation)
//     — rates that have stayed low for long are expected to stay low; a cut expected to last
//     lifts prices at once, a brief one little; and holders expect rates to follow inflation
//     even while the Treasury holds them down;
//   · a term premium (a perpetual's price swings with every change in rates);
//   · the sovereign premium: IOU_DEBT_SLOPE per year's output of debt (at par) beyond
//     IOU_DEBT_FREE of a year's output; + the memory of coupons cut (DebtMemory.stress —
//     every day coupons are cut adds IOU_CUT_STRESS × the share withheld, fading by
//     IOU_STRESS_FADE a day); + with auto-mint off, up to IOU_CASH_PREMIUM while the Purse
//     holds less than IOU_CASH_DAYS of coupons;
//   · an inflation-risk premium: IOU_INFL_RISK × (expected inflation − IOU_INFL_COMFORT).
//
// With no IOUs in anyone's hands there is no market to quote: its price is what a few would
// fetch from the day's bids (bondsAfterMarket), so the Treasury's first issue meets the buyers
// there are.
//
// The bank measures the expected rate against reserves (its alternative) and asks
// BANK_IOU_MARGIN + BANK_IOU_TERM_PREMIUM − BANK_IOU_LIQUIDITY over it (IOUs are the liquid
// asset it can always sell); households measure it against the deposit rate that rate would
// bring, and ask IOU_MARGIN + IOU_TERM_PREMIUM + a taste of their own (their temperament's
// premium × IOU_TASTE_SHARE) over it.
// ============================================================================
import {
  BANK_DEPOSIT_SPREAD,
  IOU_LADDER_RUNGS,
  IOU_LADDER_STEP,
  IOU_QUOTE_LOT,
  IOU_TENDER_GAP,
  PORTFOLIO_MIN_ORDER,
  BANK_IOU_LIQUIDITY,
  BANK_IOU_MARGIN,
  BANK_IOU_TERM_PREMIUM,
  DAYS_PER_YEAR,
  IOU_CASH_DAYS,
  IOU_CASH_PREMIUM,
  IOU_COUPON,
  IOU_CUT_STRESS,
  IOU_DEBT_FREE,
  IOU_DEBT_SLOPE,
  IOU_INFL_COMFORT,
  IOU_INFL_RISK,
  IOU_MARGIN,
  IOU_MIN_YIELD,
  IOU_NEUTRAL_REAL,
  IOU_NOW_WEIGHT,
  IOU_PAR,
  IOU_RATE_MEMORY_DAYS,
  IOU_STRESS_FADE,
  IOU_STRESS_MAX,
  IOU_TASTE_SHARE,
  IOU_TAYLOR_WEIGHT,
  IOU_TERM_PREMIUM,
} from '../config';
import { addAsk, addBid } from '../market/markets';
import { rt } from '../runtime';
import { STATE } from '../types';
import type { Book, DebtMemory, Order, Ref, SimState } from '../types';
import { clamp, fin } from '../util';
import { temperament } from './temperament';

/** The memory (created on first use: the reserve rate as it stands, no stress). */
export function debtMemory(s: SimState): DebtMemory {
  const t = s.treasury;
  if (!t.debt || !Number.isFinite(t.debt.rateEma)) t.debt = { rateEma: fin(t.reserveRate, 0.02), stress: 0, lastCut: -1 };
  return t.debt;
}

/** The memory as it stands, without creating it (readers such as the UI never write the state). */
function readDebt(s: SimState): DebtMemory {
  const d = s.treasury.debt;
  return d && Number.isFinite(d.rateEma) ? d : { rateEma: fin(s.treasury.reserveRate, 0.02), stress: 0, lastCut: -1 };
}

/** What the IOU market sees today (see the header). */
export interface BondView {
  day: number;
  /** Mean expected inflation among households. */
  inflation: number;
  /** The short (reserve) rate expected over the years ahead, and the deposit rate it would bring. */
  expRate: number;
  expDeposit: number;
  /** Debt at par ÷ a year's output (0 when output is not yet measured). */
  debtRatio: number;
  /** Sovereign premium (debt + coupons cut + a short Purse) and inflation-risk premium; the sovereign premium's parts. */
  sovereign: number;
  debtPremium: number;
  cutPremium: number;
  cashPremium: number;
  inflationRisk: number;
  /** Yield the bank asks; households ask householdYield (this + their own taste). */
  bankYield: number;
  householdYield: number;
}

function compute(s: SimState): BondView {
  const t = s.treasury;
  const mem = readDebt(s);
  let inf = 0;
  let n = 0;
  for (const p of s.people) {
    if (!p || !p.alive) continue;
    inf += fin(p.expInfl);
    n++;
  }
  const inflation = n > 0 ? inf / n : 0;
  const rr = fin(t.reserveRate);
  const expRate = (1 - IOU_TAYLOR_WEIGHT) * (IOU_NOW_WEIGHT * rr + (1 - IOU_NOW_WEIGHT) * fin(mem.rateEma, rr)) + IOU_TAYLOR_WEIGHT * (IOU_NEUTRAL_REAL + inflation);
  // the deposit rate that reserve rate would bring (bank.ts: max(min(0, rr), rr − spread))
  const expDeposit = Math.max(Math.min(0, expRate), expRate - BANK_DEPOSIT_SPREAD);
  const gdpYear = Math.max(0, fin(s.stats?.latest?.gdpNominal)) * DAYS_PER_YEAR;
  const debt = Math.max(0, fin(t.iouOutstanding)) * IOU_PAR;
  const debtRatio = gdpYear > 1 ? debt / gdpYear : 0;
  const debtPremium = IOU_DEBT_SLOPE * Math.max(0, debtRatio - IOU_DEBT_FREE);
  const cutPremium = clamp(fin(mem.stress), 0, IOU_STRESS_MAX);
  let cashPremium = 0;
  if (!t.autoMint && t.iouOutstanding > 1e-9) {
    const season = (t.iouOutstanding * IOU_COUPON * IOU_CASH_DAYS) / DAYS_PER_YEAR;
    const cover = season > 0 ? Math.max(0, fin(t.purse)) / season : 1;
    cashPremium = IOU_CASH_PREMIUM * clamp(1 - cover, 0, 1);
  }
  const sovereign = debtPremium + cutPremium + cashPremium;
  const inflationRisk = IOU_INFL_RISK * Math.max(0, inflation - IOU_INFL_COMFORT);
  const bankYield = expRate + BANK_IOU_MARGIN + BANK_IOU_TERM_PREMIUM - BANK_IOU_LIQUIDITY + sovereign + inflationRisk;
  const householdYield = expDeposit + IOU_MARGIN + IOU_TERM_PREMIUM + sovereign + inflationRisk;
  return { day: s.day, inflation, expRate, expDeposit, debtRatio, sovereign, debtPremium, cutPremium, cashPremium, inflationRisk, bankYield, householdYield };
}

/** Today's view (computed once a day, cached). */
export function bondView(s: SimState): BondView {
  const bag = rt(s).bag;
  const v = bag.bondView as BondView | undefined;
  if (v && v.day === s.day) return v;
  const nv = compute(s);
  bag.bondView = nv;
  return nv;
}

/** What an IOU is worth to someone asking yield `y`. */
export function iouWorth(y: number): number {
  return IOU_COUPON / Math.max(IOU_MIN_YIELD, fin(y, IOU_MIN_YIELD));
}

/** The yield a household asks of an IOU (the market's household yield + its own taste). */
export function householdIouYield(s: SimState, pid: number): number {
  return bondView(s).householdYield + IOU_TASTE_SHARE * temperament(s, pid).premium;
}

/** What an IOU is worth to the bank, and to a household. */
export function bankIouWorth(s: SimState): number {
  return iouWorth(bondView(s).bankYield);
}
export function householdIouWorth(s: SimState, pid: number): number {
  return iouWorth(householdIouYield(s, pid));
}

/** A first guess at what an IOU would fetch (before any bids are seen): its worth to the bank, the buyer with the deepest pockets. */
export function fairIouPrice(s: SimState): number {
  return iouWorth(bondView(s).bankYield);
}

/** IOUs a holder wants at price `price`: `funds` (the most it would ever put in IOUs) × how far their yield beats `ask`, over `full`. */
export function iouWanted(price: number, funds: number, ask: number, full: number): number {
  if (!(price > 0) || !(funds > 0) || !(full > 0)) return 0;
  return (funds * clamp((IOU_COUPON / price - ask) / full, 0, 1)) / price;
}

/** One holder's (or would-be holder's) IOU position, for postIouSchedule. */
export interface IouPosition {
  /** IOUs held. */
  held: number;
  /** The most it would ever put in IOUs (¤). */
  funds: number;
  /** Cash it may spend on IOUs today. */
  cash: number;
  /** The yield it asks, and how much more makes it put in all of `funds`. */
  ask: number;
  full: number;
  /** Share of the way to the holding it wants it moves a day. */
  buySpeed: number;
  sellSpeed: number;
}

/**
 * A holder's orders for the day: at each price of a ladder around `pRef` (IOU_LADDER_RUNGS of
 * IOU_LADDER_STEP each side) it bids for buySpeed of what it wants beyond what it holds (never
 * above its worth, never more than its cash), and asks for sellSpeed of what it holds beyond
 * what it wants — faster the more a buyer pays over its worth, everything at IOU_TENDER_GAP over
 * it. Returns the most the bids could cost.
 */
export function postIouSchedule(book: Book, ref: Ref, h: IouPosition, pRef: number): number {
  if (!(pRef > 0)) return 0;
  const worth = iouWorth(h.ask);
  let spend = 0;
  // bids, from the highest price down: a stack whose total at price P is what it would buy at P
  if (h.cash > PORTFOLIO_MIN_ORDER) {
    let cum = 0;
    for (let k = IOU_LADDER_RUNGS; k >= -IOU_LADDER_RUNGS; k--) {
      const price = pRef * (1 + IOU_LADDER_STEP * k);
      if (!(price > 0) || price >= worth) continue;
      const want = Math.min(h.buySpeed * Math.max(0, iouWanted(price, h.funds, h.ask, h.full) - h.held), h.cash / price);
      if ((want - cum) * price < PORTFOLIO_MIN_ORDER) continue;
      addBid(book, ref, price, want - cum);
      cum = want;
      spend = Math.max(spend, cum * price);
    }
  }
  // asks, from the lowest price up: the ladder, then its worth and the tender prices above it
  if (h.held > 1e-9) {
    const pts = _pts;
    pts.length = 0;
    for (let k = -IOU_LADDER_RUNGS; k <= IOU_LADDER_RUNGS; k++) pts.push(pRef * (1 + IOU_LADDER_STEP * k));
    pts.push(worth, worth * (1 + 0.5 * IOU_TENDER_GAP), worth * (1 + IOU_TENDER_GAP));
    pts.sort((a, b) => a - b);
    let cum = 0;
    for (let i = 0; i < pts.length; i++) {
      const price = pts[i];
      if (!(price > 0)) continue;
      const speed = clamp(h.sellSpeed + (price / worth - 1) / IOU_TENDER_GAP, h.sellSpeed, 1);
      const give = Math.min(h.held, speed * Math.max(0, h.held - iouWanted(price, h.funds, h.ask, h.full)));
      const q = give - cum;
      if (!(q > 1e-9) || (q * price < PORTFOLIO_MIN_ORDER && give < h.held - 1e-9)) continue;
      addAsk(book, ref, price, q);
      cum = give;
    }
  }
  return spend;
}
const _pts: number[] = [];

/** Morning (after the bank sets its rates): the rate memory moves, stress fades, and the day's view is taken. */
export function bondsBeginDay(s: SimState): void {
  const mem = debtMemory(s);
  const rr = fin(s.treasury.reserveRate);
  mem.rateEma = fin(mem.rateEma + (rr - mem.rateEma) / IOU_RATE_MEMORY_DAYS, rr);
  mem.stress = Math.max(0, fin(mem.stress) * (1 - IOU_STRESS_FADE));
  if (mem.stress < 1e-6) mem.stress = 0;
  const bag = rt(s).bag;
  bag.bondView = compute(s);
}

/**
 * After the markets. With no IOUs in anyone's hands there is nothing to trade and no price: the
 * quote is what IOU_QUOTE_LOT of them would fetch from today's bids (the Treasury's own aside) —
 * or, with no bids that deep, the lowest price anyone was asked to consider, so it walks down to
 * where there are buyers.
 */
export function bondsAfterMarket(s: SimState, book: Book | undefined): void {
  if (s.treasury.iouOutstanding > 1e-6 || !book) return;
  const m = s.iouMarket;
  const ref = m.ema > 0 && Number.isFinite(m.ema) ? m.ema : fairIouPrice(s);
  const bids = _bids;
  bids.length = 0;
  for (const o of book.bids) if (o.ref !== STATE && !o.market && o.qty > 0 && o.limit > 0) bids.push(o);
  bids.sort((a, b) => b.limit - a.limit);
  let cum = 0;
  let quote = ref * (1 - IOU_LADDER_STEP * IOU_LADDER_RUNGS);
  for (const o of bids) {
    cum += o.qty;
    if (cum >= IOU_QUOTE_LOT) {
      quote = o.limit;
      break;
    }
  }
  bids.length = 0;
  quote = clamp(quote, ref * (1 - IOU_LADDER_STEP * IOU_LADDER_RUNGS), ref * (1 + IOU_LADDER_STEP * IOU_LADDER_RUNGS));
  m.price = quote;
  m.ema = quote;
  if (m.ownEma !== undefined) m.ownEma = quote;
  if (!(m.volume > 0) && m.hist.length) m.hist[m.hist.length - 1] = quote;
}
const _bids: Order[] = [];

/** Coupons were cut today: holders remember (see the header). `paidShare` = the share of what was owed that was paid. */
export function noteCouponCut(s: SimState, paidShare: number): void {
  const mem = debtMemory(s);
  const cut = clamp(1 - fin(paidShare, 1), 0, 1);
  if (!(cut > 0)) return;
  mem.stress = Math.min(IOU_STRESS_MAX, fin(mem.stress) + IOU_CUT_STRESS * cut);
  mem.lastCut = s.day;
}
