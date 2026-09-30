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
// COMPANY_BIDDERS would-be buyers who could pay for at least COMPANY_MIN_STAKE of it
// (people and firms, weighted by their spare cash; the town's own twice as likely). The
// holders' reservation is what the whole firm is worth to them, less a discount when it
// is in trouble (they need to get out). A buyer to whom it is worth more than that by
// COMPANY_DEAL_GAIN buys as large a stake as their spare cash allows (all of it, if they
// can), at the reservation plus half the gap for the whole — bought from the other
// holders in proportion to what each holds, each paid for their part. Whoever then holds
// the largest share runs the firm (a firm controlled by a firm is its subsidiary: its
// profits flow up); what owning a rival or a supplier adds (synergy) counts only for a
// buyer who would then control it. So shares pass to those who value them most — to the
// optimistic from the gloomy, to the patient from the hard-pressed, to rivals and
// suppliers — and control of a firm can change hands a stake at a time. (Whole firms cost
// far more than most savers hold: a market in whole firms alone would hardly ever meet.)
// A firm has at most COMPANY_MAX_HOLDERS holders; no firm buys into a firm that controls it.
//
// The Treasury trades stakes only through its orders (treasuryShareDeals, first at every meeting):
//   · selling: its stake goes to the would-be buyers (as above) to whom the firm is worth at least
//     COMPANY_DEAL_GAIN over its price for the whole firm — the keenest first, each taking what its
//     spare cash buys (COMPANY_MIN_STAKE at least) — at that price; "at any price": at what the
//     keenest would pay, less the gain it asks. Selling any part of a Treasury works ends it as one
//     (works.releaseWorks): it runs as an ordinary company from then;
//   · buying: the other holders sell to it, in proportion to what each holds, if its price for the
//     whole firm is at least their reservation (their worth, less a discount when it is in trouble);
//     "at any price": it pays that reservation and half the deal gain over it. All of it bought, the
//     firm is wholly the Treasury's — a Treasury works from the next morning.
// The firms the Treasury controls are not offered to other buyers.
// ============================================================================
import {
  COMPANY_BIDDERS,
  COMPANY_DEAL_GAIN,
  COMPANY_DISTRESS_DISCOUNT,
  COMPANY_MAX_HOLDERS,
  COMPANY_MIN_STAKE,
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
import { decisionRand, decisionSeed } from '../rng';
import { news } from '../stats/events';
import type { Firm, Ref, SimState } from '../types';
import { STATE } from '../types';
import { clamp, fin } from '../util';
import { debtOf } from './bank';
import { investableCash, screenRate } from './entry';
import { temperament } from './temperament';
import { holders, isWorks, setHoldings, stakeOf, transferStake, type Holding } from './ownership';
import { releaseWorks } from './works';
import type { PlayerOrder } from '../types';

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

/** True if firm `o` is `f` or is controlled, up the chain of owners, by `f` (it may not buy into `f`). */
function ownedBy(s: SimState, o: Firm, f: Firm): boolean {
  let cur: Firm | undefined = o;
  for (let k = 0; k < 8 && cur; k++) {
    if (cur.id === f.id) return true;
    if (!isFirm(cur.owner)) return false;
    cur = s.firms[refId(cur.owner)];
  }
  return false;
}

/** What a would-be buyer can spare for a stake: their free cash × their nerve. */
function spareFor(s: SimState, ref: Ref): number {
  return investableCash(s, ref) * temperament(s, ref).nerve;
}

/** Would-be buyers of a stake in a firm: people and firms who could pay `price` for the least stake (weighted by their spare cash, the town's own twice as likely); its controlling owner is not among them. */
function bidders(s: SimState, f: Firm, price: number, n: number): Ref[] {
  const cands: Ref[] = [];
  const w: number[] = [];
  const full = holders(f).length >= COMPANY_MAX_HOLDERS;
  const consider = (ref: Ref, town: number) => {
    if (ref === f.owner) return;
    if (full && !(stakeOf(f, ref) > 0)) return;
    const spare = spareFor(s, ref);
    if (!(spare >= price)) return;
    cands.push(ref);
    w.push(spare * (town === f.town ? 2 : 1));
  };
  for (const p of s.people) if (p && p.alive) consider(p.id, p.town);
  for (const o of s.firms) if (o && o.alive && o.status === 'active' && o.owner !== STATE && o.sector !== 'stateworks' && fin(o.profit) > 0 && !ownedBy(s, o, f)) consider(firmRef(o.id), o.town);
  const out: Ref[] = [];
  for (let draw = 0; out.length < n && cands.length; draw++) {
    let tot = 0;
    for (const x of w) tot += x;
    let r = decisionRand(decisionSeed(s), s.day, f.id, 400 + draw) * tot;
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
  treasuryShareDeals(s);
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
    let r = decisionRand(decisionSeed(s), s.day, 300 + n) * tot;
    let k = 0;
    for (; k < weight.length - 1; k++) {
      r -= weight[k];
      if (r <= 0) break;
    }
    const f = pool[k];
    pool.splice(k, 1);
    weight.splice(k, 1);
    const ask = Math.max(1, reservation(s, f));
    const bid = bestBid(s, f, ask);
    if (!bid) continue;
    const { ref: best, q, price } = bid;
    const before = f.owner;
    const hs = holders(f);
    const own = stakeOf(f, best);
    const others = Math.max(1e-9, 1 - own);
    // bought from the other holders in proportion to what each holds
    let paid = 0;
    const list: Holding[] = [];
    for (const h of hs) {
      if (h.ref === best) continue;
      const part = (q * h.share) / others;
      const got = pay(s, best, validPayee(s, f, h.ref), price * part, 'asset');
      paid += got;
      const sold = price > 0 ? Math.min(part, got / price) : part;
      list.push({ ref: h.ref, share: h.share - sold });
    }
    if (!(paid > 0.01)) continue;
    list.push({ ref: best, share: own + paid / price });
    setHoldings(s, f, list);
    deals++;
    bump(s, 'company_stakes', 1);
    bump(s, 'company_stakes_value', paid);
    if (f.owner === before) continue;
    bump(s, 'company_sales', 1);
    bump(s, 'company_sales_value', paid);
    const tn = s.towns[f.town]?.name ?? '';
    const why = f.distress > 0 || f.lossDays > 60 ? ' from its hard-pressed owners' : '';
    const how = isFirm(best) ? ` — it is now part of ${refName(s, best)}` : '';
    const what = f.owner === best && stakeOf(f, best) > 0.999 ? `has bought ${f.name} in ${tn}${why}` : `has taken control of ${f.name} in ${tn}${why}, buying ${Math.round(100 * (paid / price))} % of it`;
    news(s, `${refName(s, best)} ${what} for ${Math.round(paid).toLocaleString('en-GB')} ¤${how}.`, 'info', f.town);
  }
  void deals;
}

/** The Treasury's orders for shares (see the header), in the order they were placed. */
export function treasuryShareDeals(s: SimState): void {
  for (const o of s.policy.orders) {
    if (!o.enabled || o.market.kind !== 'company') continue;
    if (o.until >= 0 && o.until < s.day) continue;
    const f = s.firms[o.market.firm];
    if (!f || !f.alive || f.status !== 'active' || f.sector === 'stateworks' || f.building < 0) {
      o.enabled = false;
      continue;
    }
    o.filledToday = 0;
    if (o.side === 'sell') sellStake(s, o, f);
    else buyStake(s, o, f);
    if (o.filled >= o.total - 1e-6) o.enabled = false;
  }
}

function sellStake(s: SimState, o: PlayerOrder, f: Firm): void {
  let left = Math.min(o.total - o.filled, stakeOf(f, STATE));
  if (!(left > 1e-6)) {
    o.enabled = false;
    return;
  }
  const ask = o.priceMode === 'any' ? 0 : Math.max(0, fin(o.price));
  // would-be buyers, keenest first: what the whole firm is worth to each (control, and what it adds to theirs, if they would run it)
  const offers: { ref: Ref; v: number }[] = [];
  for (const b of bidders(s, f, COMPANY_MIN_STAKE * Math.max(1, ask), COMPANY_BIDDERS * 2)) {
    if (b === STATE) continue;
    const own = stakeOf(f, b);
    const q0 = Math.min(left, spareFor(s, b) / Math.max(1, ask));
    const top = Math.max(stakeOf(f, STATE) - q0, ...holders(f).filter((h) => h.ref !== b && h.ref !== STATE).map((h) => h.share));
    const v = firmWorth(s, f, b, own + q0 > top);
    if (v >= Math.max(1, ask) * (1 + COMPANY_DEAL_GAIN)) offers.push({ ref: b, v });
  }
  offers.sort((a, b) => b.v - a.v || a.ref - b.ref);
  const tn = s.towns[f.town]?.name ?? '';
  for (const { ref: b, v } of offers) {
    if (!(left > 1e-6)) break;
    const price = ask > 0 ? ask : v / (1 + COMPANY_DEAL_GAIN);
    if (!(price > 0)) continue;
    let q = Math.min(left, spareFor(s, b) / price, 1 - stakeOf(f, b));
    if (!(q >= COMPANY_MIN_STAKE) && q < left - 1e-9) continue;
    if (!(q > 1e-6)) continue;
    const paid = pay(s, b, STATE, price * q, 'asset');
    q = Math.min(q, paid / price);
    if (!(q > 1e-6)) continue;
    // a Treasury works becomes a company as the first of it changes hands
    if (f.works) releaseWorks(s, f);
    transferStake(s, f, STATE, b, q);
    left -= q;
    o.filled += q;
    o.filledToday += q;
    o.value -= paid;
    bump(s, 'company_stakes', 1);
    bump(s, 'company_stakes_value', paid);
    bump(s, 'treasury_stakes_sold', paid);
    news(s, `The Treasury has sold ${Math.round(100 * q)} % of ${f.name} in ${tn} to ${refName(s, b)} for ${Math.round(paid).toLocaleString('en-GB')} ¤${f.owner === b ? ` — ${refName(s, b)} now runs it` : ''}.`, 'policy', f.town);
  }
}

function buyStake(s: SimState, o: PlayerOrder, f: Firm): void {
  const own = stakeOf(f, STATE);
  let left = Math.min(o.total - o.filled, 1 - own);
  if (!(left > 1e-6)) {
    o.enabled = false;
    return;
  }
  // the other holders' reservation for the whole firm
  const hs = holders(f).filter((h) => h.ref !== STATE && h.share > 1e-9);
  let others = 0;
  let res = 0;
  for (const h of hs) {
    others += h.share;
    res += h.share * firmWorth(s, f, h.ref, false);
  }
  if (!(others > 1e-9)) return;
  res = (res / others) * (1 - (f.distress > 0 || f.lossDays > 60 ? COMPANY_DISTRESS_DISCOUNT : 0));
  const price = o.priceMode === 'any' ? Math.max(1, res) * (1 + 0.5 * COMPANY_DEAL_GAIN) : Math.max(0, fin(o.price));
  if (!(price > 0) || price < res) return; // they will not sell at that price this month
  const t = s.treasury;
  const budget = t.autoMint ? Infinity : Math.max(0, t.purse);
  left = Math.min(left, budget / price);
  if (!(left > 1e-6) || (left < COMPANY_MIN_STAKE && left < Math.min(o.total - o.filled, 1 - own) - 1e-9)) return;
  // bought from the other holders in proportion to what each holds
  const list: Holding[] = [];
  let paid = 0;
  let got = 0;
  for (const h of holders(f)) {
    if (h.ref === STATE) {
      list.push(h);
      continue;
    }
    const part = (left * h.share) / others;
    const a = pay(s, STATE, validPayee(s, f, h.ref), price * part, 'asset');
    const sold = Math.min(part, a / price);
    paid += a;
    got += sold;
    list.push({ ref: h.ref, share: h.share - sold });
  }
  if (!(got > 1e-6)) return;
  list.push({ ref: STATE, share: own + got });
  const before = f.owner;
  setHoldings(s, f, list);
  o.filled += got;
  o.filledToday += got;
  o.value += paid;
  bump(s, 'company_stakes', 1);
  bump(s, 'company_stakes_value', paid);
  bump(s, 'treasury_stakes_bought', paid);
  const tn = s.towns[f.town]?.name ?? '';
  const all = stakeOf(f, STATE) > 1 - 1e-6;
  const what = all ? `all of ${f.name} in ${tn}` : `${Math.round(100 * got)} % of ${f.name} in ${tn}`;
  const tail = all ? ' — the Treasury runs it as its own from tomorrow' : f.owner === STATE && before !== STATE ? ' — the Treasury now holds the largest share and controls it' : '';
  news(s, `The Treasury has bought ${what} for ${Math.round(paid).toLocaleString('en-GB')} ¤${tail}.`, 'policy', f.town);
  void isWorks;
}

/**
 * The best bid for a stake in `f` against the holders' reservation `ask` (for the whole firm): among
 * the would-be buyers, whoever gains most — (their worth − price) × the stake — with their worth at
 * least COMPANY_DEAL_GAIN over the ask; the stake is what their spare cash buys at the price (all
 * the others hold, at most). Null if nobody bids.
 */
function bestBid(s: SimState, f: Firm, ask: number): { ref: Ref; q: number; price: number } | null {
  let best: { ref: Ref; q: number; price: number; gain: number } | null = null;
  const hs = holders(f);
  for (const b of bidders(s, f, COMPANY_MIN_STAKE * ask, COMPANY_BIDDERS)) {
    const own = stakeOf(f, b);
    const room = 1 - own;
    if (!(room > COMPANY_MIN_STAKE * 0.5)) continue;
    const spare = spareFor(s, b);
    // would this stake give them control? (then what they own besides adds to it: synergy)
    const q0 = Math.min(room, spare / ask);
    let top = 0;
    for (const h of hs) if (h.ref !== b) top = Math.max(top, (h.share * (room - q0)) / Math.max(1e-9, room));
    const v = firmWorth(s, f, b, own + q0 > top);
    if (!(v >= ask * (1 + COMPANY_DEAL_GAIN))) continue;
    const price = ask + 0.5 * (v - ask);
    const q = Math.min(room, spare / price);
    if (!(q >= COMPANY_MIN_STAKE) && q < room - 1e-9) continue;
    const gain = (v - price) * q;
    if (!best || gain > best.gain) best = { ref: b, q, price, gain };
  }
  return best ? { ref: best.ref, q: best.q, price: best.price } : null;
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
