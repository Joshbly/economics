// ============================================================================
// Gold as a store of wealth: how much of it a household wants to hold. OWNER:
// finance agent. See DESIGN §3.1 (portfolio) and §3.6 (the gold market).
//
// Gold earns nothing; a household holds it for safety, as a share of its wealth:
//
//   GOLD_BASE_SHARE × its taste                        a store it keeps anyway (the
//                                                      cautious more: 2 × (1 − nerve))
//   + GOLD_HEDGE_SLOPE × (expected inflation − the deposit rate − GOLD_HEDGE_FREE)
//                                                      coin that loses its worth faster
//                                                      than the bank pays on it
//   + GOLD_FEAR_SHARE × fear for the bank              deposits in a bank short of capital
//                                                      (its IOUs valued at the market's
//                                                      price) may be cut to save it
//   + GOLD_FALL_SLOPE × (the coin's expected fall a year − GOLD_FALL_FREE)
//                                                      the gold price is up on a year ago
//                                                      (seasons cancel out): the coin is
//                                                      expected to keep falling
//
// at most PORTFOLIO_MAX_GOLD_SHARE. So gold is bought when real interest rates turn
// negative, when the bank looks weak and when the coin is falling — and since the
// realm's gold comes from the foreign dealers, the coin paid for it goes abroad: flight
// into gold weakens the coin, which feeds the fear of its fall (a run on the currency),
// until the dealers' valuation, higher rates or a stronger bank stop it.
// ============================================================================
import {
  DAYS_PER_YEAR,
  GOLD_BASE_SHARE,
  GOLD_FALL_DAYS,
  GOLD_FALL_FREE,
  GOLD_FALL_SLOPE,
  GOLD_FEAR_SOUND,
  GOLD_FEAR_WEAK,
  GOLD_FEAR_SHARE,
  GOLD_HEDGE_FREE,
  GOLD_HEDGE_SLOPE,
  PORTFOLIO_MAX_GOLD_SHARE,
} from '../config';
import { loansOutstanding } from '../ledger';
import { rt } from '../runtime';
import type { Person, SimState } from '../types';
import { clamp, fin } from '../util';
import { temperament } from './temperament';

export interface GoldView {
  day: number;
  /** Fear for the bank (0 … 1). */
  fear: number;
  /** The coin's expected fall a year (the gold price's recent rise, annualised). */
  fall: number;
}

/** The bank's capital ratio with its IOUs at the market's price (equity + the gain or loss not yet taken, over loans). */
export function bankMarketCapital(s: SimState): number {
  const b = s.bank;
  const unreal = b.iou > 0 ? b.iou * Math.max(0, fin(s.iouMarket.ema)) - fin(b.iouBook) : 0;
  return (fin(b.equity) + unreal) / Math.max(1, loansOutstanding(s));
}

function compute(s: SimState): GoldView {
  let fear = 0;
  if (s.bank.failed) fear = 1;
  else {
    // the bank itself, not the rule in force: a lowered rule does not make a thin bank safer
    const ratio = bankMarketCapital(s);
    fear = clamp((GOLD_FEAR_SOUND - ratio) / (GOLD_FEAR_SOUND - GOLD_FEAR_WEAK), 0, 1);
  }
  // the gold price against a year before (seasons cancel out), a year's worth
  const h = s.goldMarket.hist ?? [];
  let fall = 0;
  if (h.length >= GOLD_FALL_DAYS) {
    const i = h.length - GOLD_FALL_DAYS;
    const then = fin(h[i]);
    const now = fin(s.goldMarket.ema);
    const span = h.length - 1 - i;
    if (then > 0 && now > 0 && span > 0) fall = (now / then - 1) * (DAYS_PER_YEAR / span);
  }
  return { day: s.day, fear, fall };
}

/** Morning (after the bank's day begins): today's view, taken at the same point of every day (whoever reads it later). */
export function goldBeginDay(s: SimState): void {
  rt(s).bag.goldView = compute(s);
}

/** Today's view (once a day). */
export function goldView(s: SimState): GoldView {
  const bag = rt(s).bag;
  const v = bag.goldView as GoldView | undefined;
  if (v && v.day === s.day) return v;
  const nv = compute(s);
  bag.goldView = nv;
  return nv;
}

/** A household's taste for gold (0.2 … 1.4): the cautious hold more. */
export function goldTaste(s: SimState, pid: number): number {
  return 2 * (1 - temperament(s, pid).nerve);
}

/** The share of its wealth a household wants in gold today (see the header). */
export function goldTarget(s: SimState, p: Person): number {
  const v = goldView(s);
  const dep = fin(s.bank.depositRate);
  const hedge = GOLD_HEDGE_SLOPE * Math.max(0, fin(p.expInfl) - dep - GOLD_HEDGE_FREE);
  const run = GOLD_FALL_SLOPE * Math.max(0, v.fall - GOLD_FALL_FREE);
  return clamp(GOLD_BASE_SHARE * goldTaste(s, p.id) + hedge + GOLD_FEAR_SHARE * v.fear + run, 0, PORTFOLIO_MAX_GOLD_SHARE);
}

/** Why households hold gold today, realm-wide (for the UI): the average target share and its parts. */
export function goldMotives(s: SimState): { base: number; hedge: number; fear: number; run: number; target: number } {
  const v = goldView(s);
  const dep = fin(s.bank.depositRate);
  let base = 0;
  let hedge = 0;
  let n = 0;
  for (const p of s.people) {
    if (!p || !p.alive) continue;
    base += GOLD_BASE_SHARE * goldTaste(s, p.id);
    hedge += GOLD_HEDGE_SLOPE * Math.max(0, fin(p.expInfl) - dep - GOLD_HEDGE_FREE);
    n++;
  }
  base = n > 0 ? base / n : 0;
  hedge = n > 0 ? hedge / n : 0;
  const fear = GOLD_FEAR_SHARE * v.fear;
  const run = GOLD_FALL_SLOPE * Math.max(0, v.fall - GOLD_FALL_FREE);
  return { base, hedge, fear, run, target: Math.min(PORTFOLIO_MAX_GOLD_SHARE, base + hedge + fear + run) };
}
