// ============================================================================
// People of independent means: those who live on what their capital brings in.
// OWNER: households agent. See DESIGN §3.1.
//
// Every person keeps a running average of their capital income (Person.capInc, ¤ a
// day): deposit interest and IOU coupons (bank.ts), dividends (ownership.payHolders,
// the bank's own), and rents received (housing.ts) — net of any levies on them. It is
// an EMA over about 1/MEANS_EMA days, so a firm's monthly dividend counts as a steady
// income, not a windfall.
//
// Once it reaches MEANS_LEAVE × what a worker takes home in their town, a person stops
// working (Person.means): they quit their post — their own workshop's included, which
// hires a hand in their place — and look for none. It is the income effect: a wage
// adds a few per cent to what they already have. They come back to the labour market
// when it falls below MEANS_RETURN × that wage (a firm's losses, dividends cut, rents
// falling, interest below zero): the gap between the two keeps a person from going in
// and out of work with every dividend.
//
// They are not unemployed: the labour force is everyone else (stats unemp = jobless
// seekers / labour force; Town.ofMeans). They do not look for work, do not drift away
// for want of it (demography), are not counted as hands a venture could hire, and are
// not in a levy's 'people without work'. Their contentment counts them as occupied.
// ============================================================================
import { MEANS_EMA, MEANS_LEAVE, MEANS_RETURN } from '../config';
import type { Person, SimState, Town } from '../types';
import { fin } from '../util';

/** Book `amount` ¤ of today's capital income (net; negative for interest paid on deposits or levies on it). */
export function noteCapitalIncome(p: Person | undefined, amount: number): void {
  if (!p || !Number.isFinite(amount) || amount === 0) return;
  p.capInc = fin(p.capInc ?? 0) + MEANS_EMA * amount;
}

/** Each morning: the running average decays a day (today's income is added as it is paid). */
export function decayCapitalIncome(p: Person): void {
  const v = fin(p.capInc ?? 0) * (1 - MEANS_EMA);
  if (Math.abs(v) < 1e-6) delete p.capInc;
  else p.capInc = Math.round(v * 1e6) / 1e6;
}

/**
 * Who leaves the labour force today, and who comes back to it (`typical`: the take-home wage of each town).
 * Returns the people who now live on their means and still hold a post (the caller frees it).
 */
export function decideMeans(s: SimState, typical: readonly number[]): Person[] {
  const quit: Person[] = [];
  for (const p of s.people) {
    if (!p || !p.alive) continue;
    const w = Math.max(0.5, fin(typical[p.town], 0));
    const cap = fin(p.capInc ?? 0);
    if (p.means) {
      if (cap < MEANS_RETURN * w) {
        delete p.means;
        p.unempDays = 0; // a fresh search, anchored on the last wage they took
      }
    } else if (cap >= MEANS_LEAVE * w) {
      p.means = true;
      if (p.job >= 0) quit.push(p);
    }
  }
  return quit;
}

/** Share of a town's labour force (its people less those of means) without work. */
export function townJobless(t: Town | undefined): number {
  if (!t) return 0;
  const force = Math.max(1, fin(t.pop) - Math.max(0, fin(t.ofMeans ?? 0)));
  return Math.min(1, Math.max(0, fin(t.unemployed) / force));
}
