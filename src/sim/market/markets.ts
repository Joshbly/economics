// ============================================================================
// Market plumbing: open books for every market each day, let agents add
// orders, clear them all and SETTLE (money through ledger.pay, goods between
// inventories), update MarketState and stats accumulators.
// OWNER: market-policy agent. See DESIGN §4.
//
// Settlement is a central clearing: sellers first reserve what they actually
// hold (a fill is scaled down if the goods are gone), buyers then pay and take
// delivery in turn (a fill is scaled down if they cannot afford the gross cost),
// and whatever the buyers could not take is returned to the last sellers in
// price priority. Money legs:
//   base leg   buyer → seller   base·q          ('buy' for goods, 'asset' for IOUs/gold)
//   buyer leg  buyer ↔ STATE_REF    (base·(bPct+xPct) + bUnit + xUnit)·q   (take: 'levy', give: 'give')
//   seller leg seller ↔ STATE_REF   (base·(sPct+xPct) + sUnit + xUnit)·q
// A buyer-side give is paid to the buyer BEFORE the base leg, so a household
// never needs more cash than the gross price it bid. Exempt (Treasury) orders
// skip the book wedge. Goods and money are conserved exactly.
// Consecutive bids of the same buyer with identical terms (a household's bid
// ladder) are settled as one group — one affordability check and one payment
// per leg — and the group's result is spread over its orders in proportion to
// their auction fills (so each order's `paid` is at the group's average cost).
// Per-order extras come from port duties (foreign merchants' orders, credited to
// 'import'/'export' rules) or from targeted sale rules (levies.isTargetedSale:
// added in addBid/addAsk to the orders of the firms / people a rule names, and
// credited back to those rules at settlement).
//
// Books and orders are pooled per state (runtime bag) and reused every day:
// orders are transient and must not be held past the day's market phase.
// ============================================================================
import {
  CURVE_POINTS,
  MARKET_EMA_INDICATIVE,
  MARKET_EMA_TRADED,
  MARKET_SESSIONS,
  SESSION_RELEASE,
  MARKET_HIST_DAYS,
  MARKET_BALANCE_DAYS,
  MARKET_VOL_EMA,
  PRICE_MIN,
  WEDGE_BPCT_MIN,
  WEDGE_SPCT_MAX,
} from '../config';
import { N_GOODS, SECTORS } from '../goods';
import { cashOf, pay, type Flow } from '../ledger';
import { rt } from '../runtime';
import { BANK, FIRM_BASE, FOREIGN, GOLD_GOOD, IOU_GOOD, STATE } from '../types';
import type { Book, Levy, LimitKind, MarketState, Order, Ref, Sector, SimState, TownId, Wedge } from '../types';
import { pushCapped } from '../util';

// Local copies of hot constants (imported bindings may be getters under some loaders).
const STATE_REF = STATE;
const BANK_REF = BANK;
const FOREIGN_REF = FOREIGN;
const FIRM_REF_BASE = FIRM_BASE;
import {
  attributePortActual,
  attributeSaleActual,
  attributeTargetedActual,
  hasTargetedSale,
  saleWedgeInto,
  targetedExtrasFor,
  targetedExtrasFrom,
  targetedSaleRules,
  type Extras,
} from '../policy/levies';
import { auctionBounds, noteBinding, type AuctionBounds } from '../policy/limits';
import { buyerPct, buyerUnit, clearBook, curveInto, sellerPct, sellerUnit, type ClearResult } from './auction';
import { FLOW_IN, FLOW_OUT, noteFlow } from '../stats/flows';

export interface Books {
  goods: Book[]; // index = town * N_GOODS + good
  iou: Book; // national IOU market (s.iouMarket)
  gold: Book; // national gold market (s.goldMarket)
}

export interface OrderOpts {
  /** Trade only in this session (0 opening, 1 midday, 2 close); default: spread over the day. */
  session?: number;
  exempt?: boolean; // Treasury orders
  xPct?: number; // per-order extra levy (fraction of base) — e.g. port duties
  xUnit?: number; // per-order extra levy (¤/unit)
  tag?: number;
  /**
   * Bought to be sold again elsewhere (a trading house's merchandise): targeted buyer-side sale
   * rules do not ride on it. A share of the price paid on a trade's purchases is for what it uses;
   * on goods bought for resale it would be collected again on every round trip between towns, the
   * resellers outbidding one another for ever more of it.
   */
  resale?: boolean;
}

/** A book with a private pool of recycled orders, the list of Treasury orders on it and today's targeted sale rules. */
interface PooledBook extends Book {
  spare: Order[];
  stateOrders: Order[];
  /** Targeted sale rules in force today on this market's bids / asks (levies.targetedSaleRules); empty = none. */
  tBuy: Levy[];
  tSell: Levy[];
  /** The state the rules belong to (set by openBooks while any targeted rule is in force), else null. */
  sim: SimState | null;
  /** Which kind of limit set today's ceiling / floor (limits.auctionBounds), credited when it binds. */
  ceilKind: LimitKind;
  floorKind: LimitKind;
}

function makeOrder(): Order {
  return { ref: 0, side: 0, limit: 0, qty: 0, exempt: false, xPct: 0, xUnit: 0, tag: -1, base: 0, filled: 0, price: 0, paid: 0 };
}

function makeBook(town: TownId, good: number): PooledBook {
  return {
    town,
    good,
    bids: [],
    asks: [],
    wedge: { bPct: 0, bUnit: 0, sPct: 0, sUnit: 0 },
    ceiling: -1,
    floor: -1,
    spare: [],
    stateOrders: [],
    tBuy: [],
    tSell: [],
    sim: null,
    ceilKind: 'priceMax',
    floorKind: 'priceMin',
  };
}

function recycle(b: Book): void {
  const pb = b as PooledBook;
  if (pb.spare) {
    for (let i = 0; i < b.bids.length; i++) pb.spare.push(b.bids[i]);
    for (let i = 0; i < b.asks.length; i++) pb.spare.push(b.asks[i]);
  }
  b.bids.length = 0;
  b.asks.length = 0;
  if (pb.stateOrders) pb.stateOrders.length = 0;
}

/**
 * Create one Book per goods market (with wedge from levies.saleWedge and
 * ceiling/floor from limits.auctionBounds: fixed price limits, tightened by any
 * limit on how far the price may move from yesterday's) plus the IOU and gold
 * books (no wedge; only the price limits that name them). Targeted sale rules in force today are
 * listed per book (bids / asks) so addBid/addAsk can put them on the matching
 * orders; with none in force this costs one scan of the rule list.
 * The Books object (and its orders) is reused from the previous call on the same
 * state: calling openBooks again invalidates yesterday's books and orders.
 */
export function openBooks(s: SimState): Books {
  const nT = s.towns.length;
  const n = nT * N_GOODS;
  const bag = rt(s).bag;
  let books = bag.marketBooks as Books | undefined;
  if (!books || books.goods.length !== n) {
    books = { goods: [], iou: makeBook(-1, IOU_GOOD), gold: makeBook(-1, GOLD_GOOD) };
    for (let t = 0; t < nT; t++) for (let g = 0; g < N_GOODS; g++) books.goods.push(makeBook(t, g));
    bag.marketBooks = books;
  } else {
    for (const b of books.goods) recycle(b);
    recycle(books.iou);
    recycle(books.gold);
  }
  const hasLimits = s.policy.limits.length > 0;
  const targeted = s.policy.levies.length > 0 && hasTargetedSale(s);
  for (let t = 0; t < nT; t++) {
    for (let g = 0; g < N_GOODS; g++) {
      const b = books.goods[t * N_GOODS + g];
      saleWedgeInto(s, t, g, b.wedge);
      const pb = b as PooledBook;
      if (!pb.tBuy) pb.tBuy = [];
      if (!pb.tSell) pb.tSell = [];
      pb.tBuy.length = 0;
      pb.tSell.length = 0;
      pb.sim = null;
      if (targeted) {
        targetedSaleRules(s, t, g, 'buyer', pb.tBuy);
        targetedSaleRules(s, t, g, 'seller', pb.tSell);
        if (pb.tBuy.length || pb.tSell.length) pb.sim = s;
      }
      setBounds(s, pb, hasLimits, s.markets[t * N_GOODS + g]);
    }
  }
  for (const b of [books.iou, books.gold]) {
    b.wedge.bPct = b.wedge.bUnit = b.wedge.sPct = b.wedge.sUnit = 0;
    (b as PooledBook).sim = null;
    setBounds(s, b as PooledBook, hasLimits, b === books.iou ? s.iouMarket : s.goldMarket);
  }
  return books;
}

const _bounds: AuctionBounds = { ceiling: -1, floor: -1, ceilKind: 'priceMax', floorKind: 'priceMin' };

/** A book's legal ceiling / floor for today (yesterday's price anchors any limit on daily moves). */
function setBounds(s: SimState, b: PooledBook, hasLimits: boolean, m: MarketState | undefined): void {
  if (!hasLimits) {
    b.ceiling = -1;
    b.floor = -1;
    b.ceilKind = 'priceMax';
    b.floorKind = 'priceMin';
    return;
  }
  const prev = m && m.price > 0 && Number.isFinite(m.price) ? m.price : m && m.ema > 0 && Number.isFinite(m.ema) ? m.ema : -1;
  const r = auctionBounds(s, b.town, b.good, prev, _bounds);
  b.ceiling = r.ceiling;
  b.floor = r.floor;
  b.ceilKind = r.ceilKind;
  b.floorKind = r.floorKind;
}

const VOID_BOOK: PooledBook = makeBook(-1, -1);
const _xo: Extras = { pct: 0, unit: 0 };

/** The book of a market: goods by town, IOU_GOOD → books.iou, GOLD_GOOD → books.gold. Invalid → a detached book that never clears. */
/**
 * Self-trade prevention: in each book, the Treasury's own bids and asks that would cross
 * (a bid at or above an ask) cancel each other before the auction — the Treasury does not
 * buy from itself. Highest bids meet lowest asks first; both lose the matched quantity, and
 * only what is left goes to market. Returns the quantity cancelled (all books).
 */
export function netStateOrders(books: Books): number {
  let total = 0;
  const all: Book[] = [...books.goods, books.iou, books.gold];
  for (const book of all) {
    const so = (book as PooledBook | undefined)?.stateOrders;
    if (!so || so.length < 2) continue;
    const bids: Order[] = [];
    const asks: Order[] = [];
    for (const o of so) if (o.qty > 1e-12) (o.side === 0 ? bids : asks).push(o);
    if (!bids.length || !asks.length) continue;
    bids.sort((a, b) => b.limit - a.limit);
    asks.sort((a, b) => a.limit - b.limit);
    let i = 0;
    let j = 0;
    while (i < bids.length && j < asks.length && bids[i].limit >= asks[j].limit) {
      const n = Math.min(bids[i].qty, asks[j].qty);
      bids[i].qty -= n;
      asks[j].qty -= n;
      // what cancelled is done for the day (a session's release is a share of what is left)
      if (bids[i].left !== undefined) bids[i].left = Math.max(0, (bids[i].left as number) - n);
      if (asks[j].left !== undefined) asks[j].left = Math.max(0, (asks[j].left as number) - n);
      total += n;
      if (bids[i].qty <= 1e-12) {
        bids[i].qty = 0;
        i++;
      }
      if (asks[j].qty <= 1e-12) {
        asks[j].qty = 0;
        j++;
      }
    }
  }
  return total;
}

/** A market's shortage and surplus over its last MARKET_BALANCE_DAYS days (units a day), and the volume over the same days. */
export interface Balance {
  days: number; // days averaged (fewer early in a game)
  shortage: number; // demand left unmet a day
  surplus: number; // supply left unsold a day
  volume: number; // traded a day
  /** Signed: + short (unmet ÷ what buyers wanted), − surplus (unsold ÷ what sellers offered); 0 balanced. */
  net: number;
  /** What the Treasury's own asks sold a day over the same days. */
  treasury: number;
}

export function recentBalance(m: Pick<MarketState, 'shortHist' | 'surplusHist' | 'volHist' | 'shortage' | 'surplus' | 'volume' | 'stateHist'> | undefined | null): Balance {
  if (!m) return { days: 0, shortage: 0, surplus: 0, volume: 0, net: 0, treasury: 0 };
  const sh = m.shortHist ?? [];
  const su = m.surplusHist ?? [];
  const n = Math.min(sh.length, su.length);
  if (n === 0) return withNet(1, Math.max(0, m.shortage), Math.max(0, m.surplus), Math.max(0, m.volume), 0);
  const vh = m.volHist ?? [];
  const th = m.stateHist ?? [];
  let a = 0;
  let b = 0;
  let v = 0;
  let tr = 0;
  for (let i = 0; i < n; i++) {
    a += Math.max(0, sh[sh.length - 1 - i]);
    b += Math.max(0, su[su.length - 1 - i]);
    const x = vh[vh.length - 1 - i];
    v += x > 0 && Number.isFinite(x) ? x : 0;
    const y = th[th.length - 1 - i];
    tr += y > 0 && Number.isFinite(y) ? y : 0;
  }
  return withNet(n, a / n, b / n, v / n, tr / n);
}

function withNet(days: number, shortage: number, surplus: number, volume: number, treasury: number): Balance {
  const net = shortage >= surplus ? (shortage > 0 ? (shortage - surplus) / (volume + shortage) : 0) : -(surplus - shortage) / (volume + surplus);
  return { days, shortage, surplus, volume, net: Number.isFinite(net) ? net : 0, treasury };
}

export function bookFor(books: Books, town: TownId, good: number): Book {
  if (good === IOU_GOOD) return books.iou;
  if (good === GOLD_GOOD) return books.gold;
  const b = good >= 0 && good < N_GOODS && town >= 0 ? books.goods[town * N_GOODS + good] : undefined;
  if (b) return b;
  VOID_BOOK.bids.length = 0;
  VOID_BOOK.asks.length = 0;
  return VOID_BOOK;
}

function addOrder(book: Book, side: 0 | 1, ref: Ref, limit: number, qty: number, opts?: OrderOpts): Order {
  const valid = qty > 0 && Number.isFinite(qty) && Number.isFinite(limit);
  const pb = book as PooledBook;
  const o = valid && pb.spare && pb.spare.length ? pb.spare.pop()! : makeOrder();
  const national = book.good === IOU_GOOD || book.good === GOLD_GOOD;
  o.ref = ref;
  o.side = side;
  o.limit = Number.isFinite(limit) ? limit : 0;
  o.qty = valid ? qty : 0;
  o.exempt = !!opts?.exempt;
  o.xPct = !national && opts?.xPct && Number.isFinite(opts.xPct) ? opts.xPct : 0;
  o.xUnit = !national && opts?.xUnit && Number.isFinite(opts.xUnit) ? opts.xUnit : 0;
  o.tag = opts?.tag ?? -1;
  o.session = opts?.session !== undefined && opts.session >= 0 ? opts.session : -1;
  o.base = 0;
  o.filled = 0;
  o.price = 0;
  o.paid = 0;
  // Targeted sale rules ride on the orders of the traders they name (never on Treasury orders).
  const sim = pb.sim;
  if (sim && !o.exempt && ref !== STATE_REF && !(side === 0 && opts?.resale)) {
    const rules = side === 0 ? pb.tBuy : pb.tSell;
    if (rules.length) {
      targetedExtrasFrom(sim, rules, ref, _xo, book.town);
      if (_xo.pct) o.xPct += _xo.pct;
      if (_xo.unit) o.xUnit += _xo.unit;
    }
  }
  if (valid) {
    (side === 0 ? book.bids : book.asks).push(o);
    if (ref === STATE_REF && pb.stateOrders) pb.stateOrders.push(o);
  }
  return o;
}

/** Add a bid. `limit` = max GROSS ¤ per unit the buyer will pay (incl. levies). Returns the order (read .filled after clearAll). */
export function addBid(book: Book, ref: Ref, limit: number, qty: number, opts?: OrderOpts): Order {
  return addOrder(book, 0, ref, limit, qty, opts);
}

/** Add an ask. `limit` = min NET ¤ per unit the seller will accept (after levies). */
export function addAsk(book: Book, ref: Ref, limit: number, qty: number, opts?: OrderOpts): Order {
  return addOrder(book, 1, ref, limit, qty, opts);
}

// ---- holdings -------------------------------------------------------------------
type Kind = 0 | 1 | 2; // goods, iou, gold
const K_GOODS: Kind = 0;
const K_IOU: Kind = 1;
const K_GOLD: Kind = 2;
const UNLIMITED = 1e12;

const FOREIGN_SCRATCH: number[] = new Array(N_GOODS).fill(UNLIMITED);
const ZERO_SCRATCH: number[] = new Array(N_GOODS).fill(0);

/**
 * The inventory array (length N_GOODS) where `ref`'s goods live in `town`:
 * person → pantry (their residence town), firm → inv (its own town) or, for
 * traders in other towns, trade.stock[town]; STATE_REF → treasury.goods[town];
 * FOREIGN_REF → a scratch array with effectively unlimited stock.
 * Unknown refs (and the bank) get a zeroed scratch array.
 */
export function inventoryOf(s: SimState, ref: Ref, town: TownId): number[] {
  if (ref >= FIRM_REF_BASE) {
    const f = s.firms[ref - FIRM_REF_BASE];
    if (!f) return zeroScratch();
    if (f.trade && town !== f.town && town >= 0 && f.trade.stock[town]) return f.trade.stock[town];
    return f.inv;
  }
  if (ref >= 0) {
    const p = s.people[ref];
    return p ? p.pantry : zeroScratch();
  }
  if (ref === STATE_REF) {
    const tg = s.treasury.goods;
    if (!tg[town]) {
      if (town >= 0 && town < s.towns.length) {
        for (let t = tg.length; t <= town; t++) tg[t] = new Array(N_GOODS).fill(0);
      } else return zeroScratch();
    }
    return tg[town];
  }
  if (ref === FOREIGN_REF) {
    for (let g = 0; g < N_GOODS; g++) FOREIGN_SCRATCH[g] = UNLIMITED;
    return FOREIGN_SCRATCH;
  }
  return zeroScratch();
}

function zeroScratch(): number[] {
  for (let g = 0; g < N_GOODS; g++) ZERO_SCRATCH[g] = 0;
  return ZERO_SCRATCH;
}

function canHold(ref: Ref, kind: Kind): boolean {
  if (kind === K_GOODS) return ref !== BANK_REF;
  if (kind === K_IOU) return ref === STATE_REF || ref === BANK_REF || (ref >= 0 && ref < FIRM_REF_BASE);
  return ref === STATE_REF || ref === FOREIGN_REF || (ref >= 0 && ref < FIRM_REF_BASE);
}

function holding(s: SimState, ref: Ref, book: Book, kind: Kind): number {
  if (kind === K_GOODS) {
    if (ref === FOREIGN_REF) return UNLIMITED;
    if (ref === BANK_REF) return 0;
    const v = inventoryOf(s, ref, book.town)[book.good];
    return v > 0 ? v : 0;
  }
  if (kind === K_IOU) {
    if (ref === STATE_REF) return UNLIMITED; // selling = issuing new IOUs
    if (ref === BANK_REF) return Math.max(0, s.bank.iou);
    if (ref >= 0 && ref < FIRM_REF_BASE) return Math.max(0, s.people[ref]?.iou ?? 0);
    return 0;
  }
  if (ref === STATE_REF) return Math.max(0, s.treasury.gold);
  if (ref === FOREIGN_REF) return UNLIMITED;
  if (ref >= 0 && ref < FIRM_REF_BASE) return Math.max(0, s.people[ref]?.gold ?? 0);
  return 0;
}

/** Add `q` units (negative: remove) to `ref`'s holding. The Treasury's IOU "holding" is −iouOutstanding. */
function addHolding(s: SimState, ref: Ref, book: Book, kind: Kind, q: number): void {
  if (!q) return;
  if (kind === K_GOODS) {
    if (ref === FOREIGN_REF || ref === BANK_REF) return;
    const inv = inventoryOf(s, ref, book.town);
    const v = inv[book.good] + q;
    inv[book.good] = v > 0 ? v : 0;
    return;
  }
  if (kind === K_IOU) {
    if (ref === STATE_REF) {
      const v = s.treasury.iouOutstanding - q;
      s.treasury.iouOutstanding = v > 0 ? v : 0;
    } else if (ref === BANK_REF) s.bank.iou = Math.max(0, s.bank.iou + q);
    else if (ref >= 0 && ref < FIRM_REF_BASE) {
      const p = s.people[ref];
      if (p) p.iou = Math.max(0, p.iou + q);
    }
    return;
  }
  if (ref === STATE_REF) s.treasury.gold = Math.max(0, s.treasury.gold + q);
  else if (ref >= 0 && ref < FIRM_REF_BASE) {
    const p = s.people[ref];
    if (p) p.gold = Math.max(0, p.gold + q);
  }
}

// ---- per-good stats keys (precomputed to avoid string building in the hot path) ----
const K_VOL = Array.from({ length: N_GOODS }, (_, g) => 'vol_' + g);
const K_VAL = Array.from({ length: N_GOODS }, (_, g) => 'val_' + g);
const K_CONS = Array.from({ length: N_GOODS }, (_, g) => 'cons_' + g);
const K_IMP = Array.from({ length: N_GOODS }, (_, g) => 'imp_' + g);
const K_EXP = Array.from({ length: N_GOODS }, (_, g) => 'exp_' + g);
const K_SHORT = Array.from({ length: N_GOODS }, (_, g) => 'shortage_' + g);

function addAcc(acc: Record<string, number>, k: string, v: number): void {
  if (v) acc[k] = (acc[k] || 0) + v;
}

// ---- settlement -------------------------------------------------------------------
const sellers: Order[] = [];
const res: number[] = []; // reserved units per seller
const cons: number[] = []; // units delivered per seller
const recv: number[] = []; // base ¤ received per seller

interface SettleOut {
  volume: number;
  undelivered: number; // units sellers could not deliver (no stock)
}

const settleOut: SettleOut = { volume: 0, undelivered: 0 };

const byBase = (a: Order, b: Order): number => a.base - b.base;

function zeroFills(orders: Order[], from: number, to: number): void {
  for (let k = from; k < to; k++) orders[k].filled = 0;
}

function settle(s: SimState, book: Book, p: number, kind: Kind): SettleOut {
  const w = book.wedge;
  const pbk = book as PooledBook;
  const tBuy = pbk.sim ? pbk.tBuy : null; // targeted sale rules on bids / asks (null: none)
  const tSell = pbk.sim ? pbk.tSell : null;
  const flow: Flow = kind === K_GOODS ? 'buy' : 'asset';
  const good = book.good;
  const town = book.town;
  const acc = s.stats.acc;
  const isGoods = kind === K_GOODS;
  const bankAvg = s.bank.iou > 0 ? s.bank.iouBook / s.bank.iou : p;

  // levy tallies for attribution
  let buyQtyNE = 0; // non-exempt quantity bought
  let sellQtyNE = 0;
  let saleBuyer = 0; // signed ¤ moved attributable to sale levies (buyers)
  let saleSeller = 0;
  let impQty = 0; // quantity sold by orders carrying extras (→ 'import' rules)
  let impTotal = 0;
  let expQty = 0;
  let expTotal = 0;

  // ---- pass 1: sellers reserve what they actually hold ----
  sellers.length = 0;
  res.length = 0;
  cons.length = 0;
  recv.length = 0;
  let totalRes = 0;
  let undelivered = 0;
  for (const o of book.asks) if (o.filled > 0) sellers.push(o);
  // Price priority: cheapest asks deliver first, so any shortfall of paying
  // buyers falls on the dearest sellers. (Few filled sellers per book.)
  if (sellers.length > 1) sellers.sort(byBase);
  let nS = 0;
  for (let k = 0; k < sellers.length; k++) {
    const o = sellers[k];
    const f = o.filled;
    const q = Math.min(f, holding(s, o.ref, book, kind));
    if (q < f) undelivered += f - q;
    o.filled = 0;
    if (!(q > 1e-12)) continue;
    addHolding(s, o.ref, book, kind, -q);
    sellers[nS++] = o;
    res.push(q);
    cons.push(0);
    recv.push(0);
    totalRes += q;
  }
  sellers.length = nS;

  // ---- pass 2: buyers pay and take delivery ----
  // Consecutive orders of the same buyer with the same terms (a household's bid
  // ladder) settle as ONE group: one affordability check and one payment per leg.
  const bids = book.bids;
  const nb = bids.length;
  let demand = 0;
  for (let k = 0; k < nb; k++) if (bids[k].filled > 0) demand += bids[k].filled;
  const scaleB = demand > totalRes && demand > 0 ? totalRes / demand : 1;
  let si = 0;
  let delivered = 0;
  let consQty = 0; // bought by people (goods)
  let consVal = 0;
  let i = 0;
  while (i < nb) {
    const o = bids[i];
    const ref = o.ref;
    let j = i + 1;
    while (j < nb && bids[j].ref === ref && bids[j].exempt === o.exempt && bids[j].xPct === o.xPct && bids[j].xUnit === o.xUnit) j++;
    const i0 = i;
    i = j;
    let want = 0;
    for (let k = i0; k < j; k++) {
      const f = bids[k].filled * scaleB;
      bids[k].filled = f > 0 ? f : 0; // provisional: scaled auction fill
      want += bids[k].filled;
    }
    if (!(want > 1e-12) || delivered >= totalRes - 1e-12 || !canHold(ref, kind)) {
      zeroFills(bids, i0, j);
      continue;
    }
    const pct = isGoods ? buyerPct(o, w) : 0;
    const unit = isGoods ? buyerUnit(o, w) : 0;
    let grossU = p * (1 + pct) + unit;
    if (!(grossU > 0)) grossU = 0;
    const levyU = grossU - p; // + the buyer owes the Treasury, − the Treasury pays
    const cash = cashOf(s, ref);
    let q = grossU > 0 ? Math.min(want, cash / grossU) : want;
    let give = 0;
    if (levyU < 0) {
      const giveU = -levyU;
      const stateCash = cashOf(s, STATE_REF);
      if (giveU * q > stateCash) {
        // The Purse cannot fund the whole give: it pays what it has, the buyer the rest.
        give = stateCash;
        q = Math.min(want, (cash + give) / p);
        give = Math.min(give, giveU * q);
      } else give = giveU * q;
    }
    if (q > totalRes - delivered) q = totalRes - delivered;
    if (!(q > 1e-12)) {
      zeroFills(bids, i0, j);
      continue;
    }
    let gotGive = 0;
    if (give > 0) gotGive = pay(s, STATE_REF, ref, give, 'give');
    // base legs, consuming the seller queue in price-priority order
    let left = q;
    let paidBase = 0;
    while (left > 1e-12 && si < sellers.length) {
      const room = res[si] - cons[si];
      if (room <= 1e-12) {
        si++;
        continue;
      }
      const seg = left < room ? left : room;
      const sref = sellers[si].ref;
      const a = sref === ref ? p * seg : pay(s, ref, sref, p * seg, flow);
      recv[si] += a;
      cons[si] += seg;
      paidBase += a;
      left -= seg;
      if (room - seg <= 1e-12) si++;
    }
    const got = q - left;
    if (!(got > 0)) {
      zeroFills(bids, i0, j);
      continue;
    }
    delivered += got;
    addHolding(s, ref, book, kind, got);
    if (kind === K_IOU && ref === BANK_REF) s.bank.iouBook += paidBase;
    let taken = 0;
    if (levyU > 0) taken = pay(s, ref, STATE_REF, levyU * got, 'levy');
    const paid = paidBase + taken - gotGive;
    // spread the group's result over its orders in proportion to their fills
    const fr = got / want;
    const pu = paid / got;
    for (let k = i0; k < j; k++) {
      const b = bids[k];
      b.filled *= fr;
      b.paid = b.filled * pu;
    }

    // attribution of the buyer leg: sale part vs per-order extras (foreign bids → export
    // rules; anyone else's → the targeted sale rules that put them there)
    if (isGoods && (taken || gotGive)) {
      const moved = taken - gotGive;
      const salePart = o.exempt ? 0 : p * w.bPct + w.bUnit;
      const extraPart = p * (o.xPct || 0) + (o.xUnit || 0);
      const th = salePart + extraPart;
      const kk = Math.abs(th) > 1e-12 ? moved / (th * got) : 0;
      saleBuyer += salePart * got * kk;
      if (extraPart) {
        if (ref === FOREIGN_REF) {
          expTotal += extraPart * got * kk;
          expQty += got;
        } else if (tBuy && tBuy.length) attributeTargetedActual(s, tBuy, ref, p, got, extraPart * got * kk, town);
      }
    }
    if (isGoods && !o.exempt) buyQtyNE += got;

    // agent accounting & stats
    if (ref >= FIRM_REF_BASE) {
      const f = s.firms[ref - FIRM_REF_BASE];
      if (f) f.spent += paid;
    } else if (ref >= 0) {
      if (isGoods) {
        const pp = s.people[ref];
        if (pp) pp.spent += paid;
        consQty += got;
        consVal += paid;
      }
    } else if (ref === STATE_REF) {
      if (isGoods) addAcc(acc, 'gov_goods', paid);
      else if (kind === K_IOU) {
        addAcc(acc, 'iou_retired', got);
        addAcc(acc, 'gov_iou', paid);
      } else addAcc(acc, 'gold_state_bought', got);
    } else if (ref === FOREIGN_REF && isGoods) {
      noteFlow(s, town, good, FLOW_OUT, got); // sold to foreign ships: leaves the town
      addAcc(acc, K_EXP[good], got);
      addAcc(acc, 'expval', p * got);
      s.foreign.exportsQty[good] = (s.foreign.exportsQty[good] || 0) + got;
      s.foreign.exportValue += p * got;
    }
  }
  if (consQty > 0) {
    addAcc(acc, K_CONS[good], consQty);
    addAcc(acc, 'consval', consVal);
  }

  // ---- pass 3: sellers — return what was not taken, settle seller legs ----
  let volume = 0;
  for (let k = 0; k < sellers.length; k++) {
    const o = sellers[k];
    const c = cons[k];
    const unused = res[k] - c;
    if (unused > 1e-12) addHolding(s, o.ref, book, kind, unused);
    if (!(c > 1e-12)) continue;
    volume += c;
    if (kind === K_IOU && o.ref === BANK_REF) {
      // realise the gain/loss against the average book cost
      const cost = Math.min(s.bank.iouBook, bankAvg * c);
      s.bank.iouBook = Math.max(0, s.bank.iouBook - cost);
      s.bank.equity += recv[k] - cost;
    }
    let taken = 0;
    let gotGive = 0;
    if (isGoods) {
      const levyU = p * sellerPct(o, w) + sellerUnit(o, w); // + seller owes, − Treasury pays
      if (levyU > 0) taken = pay(s, o.ref, STATE_REF, levyU * c, 'levy');
      else if (levyU < 0) gotGive = pay(s, STATE_REF, o.ref, -levyU * c, 'give');
      if (taken || gotGive) {
        const moved = taken - gotGive;
        const salePart = o.exempt ? 0 : p * w.sPct + w.sUnit;
        const extraPart = p * (o.xPct || 0) + (o.xUnit || 0);
        const th = salePart + extraPart;
        const kk = Math.abs(th) > 1e-12 ? moved / (th * c) : 0;
        saleSeller += salePart * c * kk;
        if (extraPart) {
          if (o.ref === FOREIGN_REF) {
            impTotal += extraPart * c * kk;
            impQty += c;
          } else if (tSell && tSell.length) attributeTargetedActual(s, tSell, o.ref, p, c, extraPart * c * kk, town);
        }
      }
      if (!o.exempt) sellQtyNE += c;
    }
    o.filled = c;
    const got = recv[k] - taken + gotGive;
    o.paid = got;

    const r = o.ref;
    if (r >= FIRM_REF_BASE) {
      const f = s.firms[r - FIRM_REF_BASE];
      if (f) {
        f.revenue += got;
        if (isGoods && SECTORS[f.sector]?.out === good) f.soldToday += c;
      }
    } else if (r === STATE_REF) {
      if (kind === K_IOU) {
        addAcc(acc, 'iou_issued', c);
        addAcc(acc, 'gov_iou', -recv[k]);
      } else if (kind === K_GOLD) addAcc(acc, 'gold_state_sold', c);
      else addAcc(acc, 'gov_goods_sold', recv[k]);
    } else if (r === FOREIGN_REF && isGoods) {
      noteFlow(s, town, good, FLOW_IN, c); // bought from foreign ships: lands in the town
      addAcc(acc, K_IMP[good], c);
      addAcc(acc, 'impval', p * c);
      s.foreign.importsQty[good] = (s.foreign.importsQty[good] || 0) + c;
      s.foreign.importValue += p * c;
    }
  }

  // ---- per-rule levy accounting ----
  if (isGoods && s.policy.levies.length) {
    if (buyQtyNE > 0 || sellQtyNE > 0) attributeSaleActual(s, town, good, p, buyQtyNE, sellQtyNE, saleBuyer, saleSeller);
    if (impQty > 0) attributePortActual(s, 'import', good, p, impQty, impTotal);
    if (expQty > 0) attributePortActual(s, 'export', good, p, expQty, expTotal);
  }

  settleOut.volume = volume;
  settleOut.undelivered = undelivered;
  return settleOut;
}

function snapshot(m: MarketState, book: Book, p: number, vol: number, hasOrders: boolean): void {
  let c = m.curve;
  if (!c) {
    c = { bids: [], asks: [], state: [], price: 0, volume: 0, wedge: { bPct: 0, bUnit: 0, sPct: 0, sUnit: 0 }, ceiling: -1, floor: -1 };
    m.curve = c;
  }
  if (hasOrders) curveInto(book, CURVE_POINTS, c.bids, c.asks);
  else {
    c.bids.length = 0;
    c.asks.length = 0;
  }
  const st = c.state;
  st.length = 0;
  const pb = book as PooledBook;
  if (pb.stateOrders) {
    for (const o of pb.stateOrders) if (o.qty > 0) st.push(o.side, r4(o.base > 0 ? o.base : o.limit), r4(o.qty));
  } else {
    for (const o of book.bids) if (o.ref === STATE_REF && o.qty > 0) st.push(0, r4(o.base > 0 ? o.base : o.limit), r4(o.qty));
    for (const o of book.asks) if (o.ref === STATE_REF && o.qty > 0) st.push(1, r4(o.base > 0 ? o.base : o.limit), r4(o.qty));
  }
  c.price = p;
  c.volume = vol;
  c.wedge.bPct = book.wedge.bPct;
  c.wedge.bUnit = book.wedge.bUnit;
  c.wedge.sPct = book.wedge.sPct;
  c.wedge.sUnit = book.wedge.sUnit;
  c.ceiling = book.ceiling;
  c.floor = book.floor;
}

function r4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/** One market's tally over the day's sessions. */
interface DayTally {
  ref: number;
  vol: number;
  val: number;
  sess: number[];
  sessVol: number[];
  shortage: number;
  surplus: number;
  bestBid: number;
  bestAsk: number;
  bound: ClearResult['bound'];
}

interface DayMarket {
  book: Book;
  m: MarketState;
  kind: Kind;
  t: DayTally;
}

const _day: DayMarket[] = [];

function dayMarkets(s: SimState, books: Books): DayMarket[] {
  _day.length = 0;
  const n = Math.min(books.goods.length, s.markets.length);
  const push = (book: Book | undefined, m: MarketState | undefined, kind: Kind) => {
    if (!book || !m) return;
    const ref = m.ema > 0 && Number.isFinite(m.ema) ? m.ema : m.price > 0 && Number.isFinite(m.price) ? m.price : 1;
    _day.push({ book, m, kind, t: { ref, vol: 0, val: 0, sess: [], sessVol: [], shortage: 0, surplus: 0, bestBid: -1, bestAsk: -1, bound: 'none' } });
  };
  for (let i = 0; i < n; i++) push(books.goods[i], s.markets[i], K_GOODS);
  push(books.iou, s.iouMarket, K_IOU);
  push(books.gold, s.goldMarket, K_GOLD);
  return _day;
}

/** What each order puts into session k: its share of what is still to trade (or all of it in its own session). */
function release(book: Book, k: number): boolean {
  let any = false;
  const last = MARKET_SESSIONS - 1;
  const share = SESSION_RELEASE[k] ?? 1;
  for (const side of [book.bids, book.asks]) {
    for (let i = 0; i < side.length; i++) {
      const o = side[i];
      const left = o.left ?? 0;
      const own = o.session ?? -1;
      const q = !(left > 1e-12) ? 0 : own >= 0 ? (own === k || (own > last && k === last) ? left : 0) : k >= last ? left : left * share;
      o.qty = q;
      o.released = q;
      o.filled = 0; // this session's fills (the auction is skipped when nothing is released)
      o.paid = 0;
      if (q > 0) any = true;
    }
  }
  return any;
}

/** Clear one market's session: auction, settlement, the day's tally. */
function clearSession(s: SimState, d: DayMarket, k: number, any: boolean): void {
  const { book, kind, t } = d;
  let r: ClearResult;
  let vol = 0;
  let undelivered = 0;
  if (!any) {
    // Nobody came: the reference price stands, within the day's legal bounds (a limit on daily moves too).
    let p0 = t.ref;
    if (book.ceiling >= 0 && p0 > book.ceiling) p0 = book.ceiling;
    if (book.floor >= 0 && p0 < book.floor) p0 = book.floor;
    r = EMPTY_RESULT;
    r.price = p0;
    r.demandAtPrice = 0;
    r.supplyAtPrice = 0;
    r.bestBid = -1;
    r.bestAsk = -1;
    r.bound = 'none';
  } else {
    r = clearBook(book, t.ref); // leaves every fill at 0 when nothing trades
    if (r.volume > 0) {
      const out = settle(s, book, r.price, kind);
      vol = out.volume;
      undelivered = out.undelivered;
    }
  }
  const p = r.price > 0 && Number.isFinite(r.price) ? r.price : t.ref;
  t.sess[k] = p;
  t.sessVol[k] = vol;
  if (vol > 1e-9) {
    t.vol += vol;
    t.val += p * vol;
  }
  // What is left unmet / unsold is what the last session (which releases everything left) reports.
  t.shortage = Math.max(0, r.demandAtPrice - vol);
  t.surplus = Math.max(0, r.supplyAtPrice - undelivered - vol);
  t.bestBid = r.bestBid;
  t.bestAsk = r.bestAsk;
  if (r.bound !== 'none') t.bound = r.bound;
  for (const side of [book.bids, book.asks]) {
    for (let i = 0; i < side.length; i++) {
      const o = side[i];
      const f = o.filled > 0 ? o.filled : 0;
      o.filledDay = (o.filledDay ?? 0) + f;
      o.paidDay = (o.paidDay ?? 0) + (o.paid > 0 ? o.paid : 0);
      o.left = Math.max(0, (o.left ?? 0) - f);
    }
  }
}

const _ownQty: number[] = [];

/** After the last session: the day's price (volume-weighted over the sessions), smoothed prices, the market's own price, history, curve. */
function finalizeDay(s: SimState, d: DayMarket): void {
  const { book, m, kind, t } = d;
  const last = t.sess.length ? t.sess[t.sess.length - 1] : t.ref;
  const traded = t.vol > 1e-9;
  const p = traded ? t.val / t.vol : last;
  const hasOrders = book.bids.length > 0 || book.asks.length > 0;
  // the day's book as placed (for the market's own price and the curve)
  for (const side of [book.bids, book.asks]) for (let i = 0; i < side.length; i++) side[i].qty = side[i].dayQty ?? side[i].qty;
  let pOwn = NaN;
  let ownTraded = false;
  if (hasOrders) {
    const so = (book as PooledBook).stateOrders;
    let anyState = false;
    if (so && so.length) {
      for (let i = 0; i < so.length; i++) {
        _ownQty[i] = so[i].qty;
        if (so[i].qty > 0) anyState = true;
        so[i].qty = 0;
      }
      if (anyState) {
        // The market's own price: the day's book cleared without the Treasury's orders.
        const rx = clearBook(book, t.ref);
        pOwn = rx.price > 0 && Number.isFinite(rx.price) ? rx.price : NaN;
        ownTraded = rx.volume > 0;
      }
      for (let i = 0; i < so.length; i++) so[i].qty = _ownQty[i];
    }
    clearBook(book, t.ref); // converts every limit of the day's book to base terms for the curve (no money moves)
  }
  const w = book.wedge;
  m.price = p;
  if (kind === K_GOODS) {
    const g = p * (1 + w.bPct) + w.bUnit;
    const n = p * (1 - w.sPct) - w.sUnit;
    m.gross = g > 0 ? g : 0;
    m.net = n > 0 ? n : 0;
  } else {
    m.gross = p;
    m.net = p;
  }
  const base = m.ema > 0 && Number.isFinite(m.ema) ? m.ema : p;
  const hadState = Number.isFinite(pOwn);
  const own = hadState ? pOwn : p;
  const ob = (m.ownEma ?? 0) > 0 && Number.isFinite(m.ownEma) ? (m.ownEma as number) : base;
  m.own = own;
  m.ownEma = Math.max(PRICE_MIN, ob + ((hadState ? ownTraded : traded) ? MARKET_EMA_TRADED : MARKET_EMA_INDICATIVE) * (own - ob));
  m.ema = Math.max(PRICE_MIN, base + (traded ? MARKET_EMA_TRADED : MARKET_EMA_INDICATIVE) * (p - base));
  m.volume = t.vol;
  m.volEma = (Number.isFinite(m.volEma) ? m.volEma : 0) + MARKET_VOL_EMA * (t.vol - (Number.isFinite(m.volEma) ? m.volEma : 0));
  m.traded = traded;
  m.shortage = t.shortage;
  m.surplus = t.surplus;
  pushCapped((m.shortHist ??= []), t.shortage, MARKET_BALANCE_DAYS);
  pushCapped((m.surplusHist ??= []), t.surplus, MARKET_BALANCE_DAYS);
  if (kind === K_GOODS) {
    let sold = 0;
    for (const o of book.asks) if (o.ref === STATE) sold += Math.max(0, o.filledDay ?? o.filled);
    pushCapped((m.stateHist ??= []), sold, MARKET_BALANCE_DAYS);
  }
  m.bestBid = t.bestBid;
  m.bestAsk = t.bestAsk;
  m.sess = t.sess.map(r4);
  m.sessVol = t.sessVol.map(r4);
  pushCapped(m.hist, p, MARKET_HIST_DAYS);
  pushCapped(m.volHist, t.vol, MARKET_HIST_DAYS);
  snapshot(m, book, p, t.vol, hasOrders);
  // the day's fills stay on the orders for the evening (traders' dispatch, Treasury bookkeeping)
  for (const side of [book.bids, book.asks]) {
    for (let i = 0; i < side.length; i++) {
      const o = side[i];
      o.filled = o.filledDay ?? o.filled;
      o.paid = o.paidDay ?? o.paid;
      o.price = p;
    }
  }

  const acc = s.stats.acc;
  if (kind === K_GOODS) {
    const good = book.good;
    if (traded) {
      addAcc(acc, K_VOL[good], t.vol);
      addAcc(acc, K_VAL[good], t.val);
    }
    if (m.shortage > 0) addAcc(acc, K_SHORT[good], m.shortage);
  } else if (traded) {
    const tag = kind === K_IOU ? 'iou' : 'gold';
    addAcc(acc, 'vol_' + tag, t.vol);
    addAcc(acc, 'val_' + tag, t.val);
  }
  if (t.bound !== 'none') {
    const pb = book as PooledBook;
    noteBinding(s, t.bound === 'ceiling' ? (pb.ceilKind ?? 'priceMax') : (pb.floorKind ?? 'priceMin'), book.good, book.town);
  }
}

const EMPTY_RESULT: ClearResult = {
  price: 1,
  volume: 0,
  demandAtPrice: 0,
  supplyAtPrice: 0,
  bestBid: -1,
  bestAsk: -1,
  crossed: false,
  rationed: 'none',
  bound: 'none',
};

/**
 * Clear every book (auction.clearBook with refPrice = market.ema) and settle:
 *  - goods: seller inventory −= filled (never below 0: scale the fill down if the
 *    seller no longer holds the goods), buyer inventory += filled
 *    (inventoryOf); IOUs → person.iou / bank.iou+iouBook / treasury.iouOutstanding;
 *    gold → person.gold / treasury.gold / FOREIGN_REF (unbounded).
 *  - money: pay(buyer → seller, base·q, 'buy' or 'asset'), then levy legs:
 *    buyer pays base·(bPct+xPct?)+bUnit per unit to STATE_REF (or receives if negative),
 *    seller pays base·sPct+sUnit to STATE_REF (or receives). Exempt orders skip levies.
 *    If the buyer cannot pay in full, shrink the fill proportionally (goods not delivered).
 *    Bank IOU sales book realised gain/loss to bank.equity; iouBook reduced at average cost.
 *  - order.filled = units actually executed; order.paid = gross paid (buyers) / net received (sellers).
 *  - firm.revenue (net, any sale) / soldToday (own output only), firm.spent (gross, any purchase);
 *    person.spent += gross paid for GOODS only (IOU/gold purchases are saving, not spending).
 *  - levies.attributeSaleActual / attributePortActual for per-rule accounting.
 *  - MarketState: price, gross, net, ema (k = 0.15 when traded, 0.03 indicative),
 *    volume, volEma, shortage, surplus, bestBid, bestAsk, hist/volHist (capped
 *    MARKET_HIST_DAYS), curve snapshot (aggregateCurve, ≤ 40 points, + Treasury orders).
 *  - stats.acc: `vol_<good>`, `val_<good>` (base value), `cons_<good>` (qty bought by
 *    people), `consval` (¤ households spent on goods), `gov_goods` (¤ Treasury bought),
 *    `gov_goods_sold` (¤ Treasury received for goods), `imp_<good>`, `exp_<good>`,
 *    `impval`, `expval` (port trades with FOREIGN_REF, base value), `shortage_<good>`,
 *    `vol_iou`, `val_iou`, `iou_issued`, `iou_retired`, `gov_iou` (net ¤ the Treasury
 *    paid in the IOU market), `vol_gold`, `val_gold`, `gold_state_bought`, `gold_state_sold`,
 *    plus levy_take / levy_give / levyb_<base> from the levy legs.
 *    foreign.importsQty/exportsQty/importValue/exportValue are incremented here too.
 */
/** Between-session hooks (the Treasury's: cargo landing, its orders' fills, its wagons leaving). */
export interface SessionHooks {
  /** Before session k (0 = the opening) is released. */
  before?(k: number): void;
  /** After session k has settled (orders' `filled` / `paid` are that session's). */
  after?(k: number): void;
}

/**
 * The day's market: every book clears MARKET_SESSIONS times (opening, midday, close). Each
 * session releases SESSION_RELEASE of what every order still has to trade (orders aimed at one
 * session: all of it there, nothing elsewhere); the Treasury's own crossing orders cancel
 * before each session (netStateOrders); fills settle as each session clears (money and goods
 * move then). After the close each market records the day: volume-weighted price, smoothed
 * prices, its own price without the Treasury, history, the day's curve — and every order is left
 * holding its whole day (qty, filled, paid) for the evening.
 */
export function clearAll(s: SimState, books: Books, hooks?: SessionHooks): void {
  const day = dayMarkets(s, books);
  for (const d of day) {
    for (const side of [d.book.bids, d.book.asks]) {
      for (let i = 0; i < side.length; i++) {
        const o = side[i];
        o.dayQty = o.qty;
        o.left = o.qty;
        o.filledDay = 0;
        o.paidDay = 0;
      }
    }
  }
  const anyIn: boolean[] = [];
  for (let k = 0; k < MARKET_SESSIONS; k++) {
    hooks?.before?.(k);
    for (let i = 0; i < day.length; i++) anyIn[i] = release(day[i].book, k);
    netStateOrders(books);
    for (let i = 0; i < day.length; i++) clearSession(s, day[i], k, anyIn[i]);
    hooks?.after?.(k);
  }
  for (const d of day) finalizeDay(s, d);
}

const VOID_MARKET: MarketState = {
  town: -1,
  good: -1,
  price: 1,
  gross: 1,
  net: 1,
  ema: 1,
  volume: 0,
  volEma: 0,
  shortage: 0,
  surplus: 0,
  traded: false,
  bestBid: -1,
  bestAsk: -1,
  hist: [],
  volHist: [],
  curve: null,
};

/** Market state: goods → s.markets[town*N_GOODS+good]; IOU_GOOD → s.iouMarket; GOLD_GOOD → s.goldMarket. */
export function marketOf(s: SimState, town: TownId, good: number): MarketState {
  if (good === IOU_GOOD) return s.iouMarket;
  if (good === GOLD_GOOD) return s.goldMarket;
  const m = good >= 0 && good < N_GOODS && town >= 0 ? s.markets[town * N_GOODS + good] : undefined;
  return m ?? VOID_MARKET;
}

const W_SCRATCH: Wedge = { bPct: 0, bUnit: 0, sPct: 0, sUnit: 0 };

function refPrice(m: MarketState): number {
  return m.ema > 0 && Number.isFinite(m.ema) ? m.ema : m.price > 0 && Number.isFinite(m.price) ? m.price : 1;
}

/** Expected gross price a buyer pays (market ema grossed up with the current wedge). Always > 0. */
export function expectedGross(s: SimState, town: TownId, good: number): number {
  const m = marketOf(s, town, good);
  const e = refPrice(m);
  if (good === IOU_GOOD || good === GOLD_GOOD) return e;
  const w = saleWedgeInto(s, town, good, W_SCRATCH);
  const g = e * (1 + w.bPct) + w.bUnit;
  return Math.max(0.01 * e, PRICE_MIN, g);
}

/** Expected net price a seller receives (market ema net of the current wedge). Always > 0 (tiny when levies eat the price). */
export function expectedNet(s: SimState, town: TownId, good: number): number {
  const m = marketOf(s, town, good);
  const e = refPrice(m);
  if (good === IOU_GOOD || good === GOLD_GOOD) return e;
  const w = saleWedgeInto(s, town, good, W_SCRATCH);
  const n = e * (1 - w.sPct) - w.sUnit;
  return Math.max(1e-6, n);
}

const X_SCRATCH: Extras = { pct: 0, unit: 0 };

/**
 * expectedGross for one buyer: the market-wide wedge plus the targeted sale rules that name
 * `who` (a trader's ref: its trade or its group; or a trade, for a firm that is only planned —
 * levies.targetedExtrasFor), clamped as the auction clamps (buyerPct ≥ WEDGE_BPCT_MIN).
 * Equals expectedGross when no such rule applies.
 */
export function expectedGrossFor(s: SimState, town: TownId, good: number, who: Ref | Sector): number {
  if (good === IOU_GOOD || good === GOLD_GOOD) return expectedGross(s, town, good);
  const x = targetedExtrasFor(s, town, good, 'buyer', who, X_SCRATCH);
  if (!x.pct && !x.unit) return expectedGross(s, town, good);
  const e = refPrice(marketOf(s, town, good));
  const w = saleWedgeInto(s, town, good, W_SCRATCH);
  const pct = Math.max(WEDGE_BPCT_MIN, w.bPct + x.pct);
  const g = e * (1 + pct) + w.bUnit + x.unit;
  return Math.max(0.01 * e, PRICE_MIN, g);
}

/** expectedNet for one seller (a trader's ref, or a trade): the market-wide wedge plus the targeted sale rules that name it (clamped as the auction clamps). */
export function expectedNetFor(s: SimState, town: TownId, good: number, who: Ref | Sector): number {
  if (good === IOU_GOOD || good === GOLD_GOOD) return expectedNet(s, town, good);
  const x = targetedExtrasFor(s, town, good, 'seller', who, X_SCRATCH);
  if (!x.pct && !x.unit) return expectedNet(s, town, good);
  const e = refPrice(marketOf(s, town, good));
  const w = saleWedgeInto(s, town, good, W_SCRATCH);
  const pct = Math.min(WEDGE_SPCT_MAX, w.sPct + x.pct);
  const n = e * (1 - pct) - w.sUnit - x.unit;
  return Math.max(1e-6, n);
}
