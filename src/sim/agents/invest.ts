// ============================================================================
// Investors and the market for companies. OWNER: firms agent. See DESIGN §3.2.
//
// Every would-be investor — a person, or a firm with money to spare — has a
// temperament of their own (drawn from the realm's seed and who they are, so it
// never changes and needs no record): how many years ahead they look (horizon), what
// they ask over the bank's rate for their trouble (premium), how rosy they see things
// (optimism), and how much of their spare cash they will risk (nerve).
//
// What a firm is worth to someone (firmWorth): its expected profit a year — the
// recent profit and the slow one blended, coloured by their optimism — over their
// horizon, discounted at the bank's rate + their premium, plus what it holds (cash,
// stock, tools) less what it owes; never less than what it would fetch broken up
// (cash, 70 % of its stock and tools, 30 % of its building, less its debts). To a
// buyer who already runs firms in the same town, it is worth more (synergy):
//   · a rival of the same trade — its customers come too: the buyer's share of the
//     market grows and with it the margin it can keep (INTEGRATION_HORIZONTAL of the
//     firm's sales value a year);
//   · a supplier or a customer — goods pass between them at the going price without
//     the market hall's risk of going short (INTEGRATION_VERTICAL of the trade between
//     them a year).
//
// Monthly (MARKET_DAY) the market for companies meets: COMPANY_OFFERS firms are looked
// at (firms in distress or long losing money three times as likely), and for each
// COMPANY_BIDDERS would-be buyers who could pay for it (people and firms, weighted by
// their spare cash; the town's own twice as likely). The holders' reservation is
// what the firm is worth to them, less a discount when it is in trouble (they need to
// get out); a buyer to whom it is worth more than that by COMPANY_DEAL_GAIN buys it
// whole, at the reservation plus half the gap — every holder paid by their share. The
// buyer runs it from then on (a firm bought by a firm is its subsidiary: its profits
// flow up). So firms pass to those who value them most: to the optimistic from the
// gloomy, to the patient from the hard-pressed, to rivals and to suppliers.
// ============================================================================
import {
  COMPANY_BIDDERS,
  COMPANY_DEAL_GAIN,
  COMPANY_DISTRESS_DISCOUNT,
  COMPANY_OFFERS,
  DAYS_PER_YEAR,
  INTEGRATION_HORIZONTAL,
  INTEGRATION_VERTICAL,
  MARKET_DAY,
} from '../config';
import { dayOfMonth } from '../calendar';
import { G, N_GOODS, SECTORS } from '../goods';
import { firmRef, isFirm, isPerson, pay, refId, refName } from '../ledger';
import { marketOf } from '../market/markets';
import { decisionRand } from '../rng';
import { news } from '../stats/events';
import type { Firm, Ref, SimState } from '../types';
import { STATE } from '../types';
import { clamp, fin } from '../util';
import { debtOf } from './bank';
import { investableCash, screenRate } from './entry';
import { temperament } from './temperament';
import { holders, setHoldings } from './ownership';

export { temperament, type Temperament } from './temperament';

/** The present value of 1 a year for `years` at `rate`. */
function annuity(rate: number, years: number): number {
  const r = Math.max(0.005, rate);
  return (1 - Math.pow(1 + r, -years)) / r;
}

/** Cash, stock and tools of a firm at today's prices, and its building's book value. */
function holdings(s: SimState, f: Firm): { liquid: number; goods: number; building: number } {
  let goods = 0;
  for (let g = 0; g < N_GOODS; g++) if (f.inv[g] > 0) goods += f.inv[g] * Math.max(0, fin(marketOf(s, f.town, g).ema));
  goods += Math.max(0, fin(f.tools)) * Math.max(0, fin(marketOf(s, f.town, G.tools).ema));
  const b = f.building >= 0 ? s.buildings[f.building] : undefined;
  return { liquid: Math.max(0, fin(f.cash)), goods, building: b && b.firm === f.id ? Math.max(0, fin(b.cost)) : 0 };
}

/** Firms `ref` runs (holds the largest share of), including itself if it is a firm. */
function runBy(s: SimState, ref: Ref): Firm[] {
  const out: Firm[] = [];
  if (isFirm(ref)) {
    const me = s.firms[refId(ref)];
    if (me && me.alive) out.push(me);
  }
  for (const f of s.firms) if (f && f.alive && f.status === 'active' && f.owner === ref) out.push(f);
  return out;
}

/** What owning `f` would add to the buyer's other firms in its town a year (see the header). */
export function synergy(s: SimState, f: Firm, buyer: Ref): number {
  const d = SECTORS[f.sector];
  if (!d || !d.producer) return 0;
  const price = Math.max(0, fin(marketOf(s, f.town, d.out).ema));
  const salesValue = Math.max(0, fin(f.salesLong > 0 ? f.salesLong : f.sales)) * price * DAYS_PER_YEAR;
  let v = 0;
  for (const o of runBy(s, buyer)) {
    if (o.id === f.id || o.town !== f.town) continue;
    const od = SECTORS[o.sector];
    if (!od) continue;
    if (o.sector === f.sector) v += INTEGRATION_HORIZONTAL * salesValue;
    // a customer: o uses what f makes; a supplier: f uses what o makes
    for (const [g, a] of od.inputs) {
      if (g !== d.out) continue;
      v += INTEGRATION_VERTICAL * Math.min(salesValue, a * Math.max(0, fin(o.output)) * price * DAYS_PER_YEAR);
    }
    if (od.producer) {
      for (const [g, a] of d.inputs) {
        if (g !== od.out) continue;
        const p2 = Math.max(0, fin(marketOf(s, f.town, g).ema));
        v += INTEGRATION_VERTICAL * a * Math.max(0, fin(f.output)) * p2 * DAYS_PER_YEAR;
      }
    }
  }
  return v;
}

/** What `f` is worth to `ref` (see the header): as a going concern over their horizon, never below its break-up value. */
export function firmWorth(s: SimState, f: Firm, ref: Ref, withSynergy = true): number {
  const T = temperament(s, ref);
  const h = holdings(s, f);
  const debt = debtOf(s, firmRef(f.id));
  const perYear = (0.5 * fin(f.profit) + 0.5 * fin(f.profitLong)) * DAYS_PER_YEAR * (1 + T.optimism) + (withSynergy ? synergy(s, f, ref) : 0);
  const rate = Math.max(0.01, screenRate(s) + T.premium);
  const going = perYear * annuity(rate, T.horizon) + h.liquid + h.goods - debt;
  const breakUp = h.liquid + 0.7 * h.goods + 0.3 * h.building - debt;
  return Math.max(going, breakUp);
}

/** The holders' reservation for the whole firm: its worth to each by share, less a discount when it is in trouble. */
function reservation(s: SimState, f: Firm): number {
  let v = 0;
  for (const h of holders(f)) v += h.share * firmWorth(s, f, h.ref, false);
  const trouble = f.distress > 0 || f.lossDays > 60;
  return v * (1 - (trouble ? COMPANY_DISTRESS_DISCOUNT : 0));
}

/** Would-be buyers of a firm: people and firms who could pay `price` (weighted by their spare cash, the town's own twice as likely), not its holders. */
function bidders(s: SimState, f: Firm, price: number, n: number): Ref[] {
  const held = new Set(holders(f).map((h) => h.ref));
  const cands: Ref[] = [];
  const w: number[] = [];
  const consider = (ref: Ref, town: number) => {
    if (held.has(ref)) return;
    const spare = investableCash(s, ref) * temperament(s, ref).nerve;
    if (!(spare >= price)) return;
    cands.push(ref);
    w.push(spare * (town === f.town ? 2 : 1));
  };
  for (const p of s.people) if (p && p.alive) consider(p.id, p.town);
  for (const o of s.firms) if (o && o.alive && o.status === 'active' && o.owner !== STATE && o.sector !== 'stateworks' && o.id !== f.id && fin(o.profit) > 0) consider(firmRef(o.id), o.town);
  const out: Ref[] = [];
  for (let draw = 0; out.length < n && cands.length; draw++) {
    let tot = 0;
    for (const x of w) tot += x;
    let r = decisionRand(s.seed, s.day, f.id, 400 + draw) * tot;
    let k = 0;
    for (; k < w.length - 1; k++) {
      r -= w[k];
      if (r <= 0) break;
    }
    out.push(cands[k]);
    cands.splice(k, 1);
    w.splice(k, 1);
  }
  return out;
}

/** Monthly: the market for companies (see the header). */
export function companyMarket(s: SimState): void {
  if (dayOfMonth(s.day) !== MARKET_DAY) return;
  const pool: Firm[] = [];
  const weight: number[] = [];
  for (const f of s.firms) {
    if (!f || !f.alive || f.status !== 'active' || f.owner === STATE || f.sector === 'stateworks' || f.building < 0) continue;
    if (s.day - f.founded < DAYS_PER_YEAR / 2) continue;
    pool.push(f);
    weight.push(f.distress > 0 || f.lossDays > 60 ? 3 : 1);
  }
  let deals = 0;
  for (let n = 0; n < COMPANY_OFFERS && pool.length; n++) {
    let tot = 0;
    for (const x of weight) tot += x;
    let r = decisionRand(s.seed, s.day, 300 + n) * tot;
    let k = 0;
    for (; k < weight.length - 1; k++) {
      r -= weight[k];
      if (r <= 0) break;
    }
    const f = pool[k];
    pool.splice(k, 1);
    weight.splice(k, 1);
    const ask = Math.max(1, reservation(s, f));
    let best: Ref = -1;
    let bestV = ask * (1 + COMPANY_DEAL_GAIN);
    for (const b of bidders(s, f, ask, COMPANY_BIDDERS)) {
      const v = firmWorth(s, f, b);
      if (v > bestV) {
        bestV = v;
        best = b;
      }
    }
    if (best === -1) continue;
    const price = ask + 0.5 * (bestV - ask);
    if (!(investableCash(s, best) >= price)) continue;
    const from = f.owner;
    let paid = 0;
    for (const h of holders(f)) paid += pay(s, best, validPayee(s, f, h.ref), price * h.share, 'asset');
    if (!(paid > 0.5 * price)) continue;
    setHoldings(s, f, [{ ref: best, share: 1 }]);
    deals++;
    bump(s, 'company_sales', 1);
    bump(s, 'company_sales_value', paid);
    const tn = s.towns[f.town]?.name ?? '';
    const why = f.distress > 0 || f.lossDays > 60 ? ' from its hard-pressed owners' : '';
    const how = isFirm(best) ? ` — it is now part of ${refName(s, best)}` : '';
    news(s, `${refName(s, best)} has bought ${f.name} in ${tn}${why} for ${Math.round(paid).toLocaleString('en-GB')} ¤${how}.`, 'info', f.town);
    void from;
  }
  void deals;
}

function validPayee(s: SimState, f: Firm, ref: Ref): Ref {
  if (isPerson(ref)) return s.people[ref]?.alive ? ref : STATE;
  if (isFirm(ref)) {
    const o = s.firms[refId(ref)];
    return o && o.alive && o.id !== f.id ? ref : STATE;
  }
  return STATE;
}

function bump(s: SimState, key: string, v: number): void {
  const acc = s.stats.acc;
  acc[key] = (acc[key] || 0) + v;
}

/** (for the UI) The going worth of a firm to its own holders, as the market would ask. */
export function askingPrice(s: SimState, f: Firm): number {
  return clamp(reservation(s, f), 0, 1e12);
}
