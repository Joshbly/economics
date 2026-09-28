// ============================================================================
// Uniform-price call auction for ONE book. Pure: sets order.base / filled /
// price on the orders, but moves no money or goods (markets.ts settles).
// OWNER: market-policy agent. See DESIGN §4.
//
// Every order carries a limit in its owner's own terms (buyers: the most GROSS
// ¤ per unit they will pay including levies; sellers: the least NET ¤ per unit
// they will accept after levies). The book's levy wedge converts both into the
// common "base" price the auction clears on, so a levy on buyers shifts the
// demand curve down and a levy on sellers shifts the supply curve up — the
// textbook incidence diagram, emerging from the order flow itself.
//
// Implementation notes (performance): books can hold thousands of orders
// (every household posts an 8-rung ladder per consumer good). Orders are
// ranked with a native Float64Array sort on packed keys (quantised log price ×
// 2^17 + index) instead of a comparator sort, and all scratch buffers are
// module-level and reused, so clearing allocates almost nothing.
// ============================================================================
import { PRICE_MAX, PRICE_MIN } from '../config';
import type { Book, Order, Wedge } from '../types';

export interface ClearResult {
  price: number; // base clearing price (or indicative price if !crossed)
  volume: number; // units executed
  demandAtPrice: number; // total bid qty with base >= price
  supplyAtPrice: number; // total ask qty with base <= price
  bestBid: number; // highest bid base (-1 none)
  bestAsk: number; // lowest ask base (-1 none)
  crossed: boolean; // true if any trade happened
  rationed: 'none' | 'buyers' | 'sellers';
  bound: 'none' | 'ceiling' | 'floor'; // a price limit determined the price
}

// ---- wedge helpers (shared with markets.ts settlement so both agree exactly) ----

/** Combined buyer-side percentage (book wedge unless exempt, plus the order's own extra), clamped so 1 + pct ≥ 0.05. */
export function buyerPct(o: Order, w: Wedge): number {
  const p = (o.exempt ? 0 : w.bPct) + (o.xPct || 0);
  return p < -0.95 ? -0.95 : p;
}
/** Combined buyer-side ¤ per unit (book wedge unless exempt, plus the order's own extra). */
export function buyerUnit(o: Order, w: Wedge): number {
  return (o.exempt ? 0 : w.bUnit) + (o.xUnit || 0);
}
/** Combined seller-side percentage, clamped so 1 − pct ≥ 0.05. */
export function sellerPct(o: Order, w: Wedge): number {
  const p = (o.exempt ? 0 : w.sPct) + (o.xPct || 0);
  return p > 0.95 ? 0.95 : p;
}
/** Combined seller-side ¤ per unit. */
export function sellerUnit(o: Order, w: Wedge): number {
  return (o.exempt ? 0 : w.sUnit) + (o.xUnit || 0);
}
/** Gross ¤ per unit a buyer pays at base price p (never negative: the Treasury pays at most the whole price). */
export function grossPerUnit(o: Order, w: Wedge, p: number): number {
  const g = p * (1 + buyerPct(o, w)) + buyerUnit(o, w);
  return g > 0 ? g : 0;
}
/** Net ¤ per unit a seller receives at base price p (may be negative only for orders that were not eligible). */
export function netPerUnit(o: Order, w: Wedge, p: number): number {
  return p * (1 - sellerPct(o, w)) - sellerUnit(o, w);
}
/** A bid's limit converted to base-price terms. */
export function bidBase(o: Order, w: Wedge): number {
  return (o.limit - buyerUnit(o, w)) / (1 + buyerPct(o, w));
}
/** An ask's limit converted to base-price terms (negative limits are treated as 0: "sell at any price"). */
export function askBase(o: Order, w: Wedge): number {
  const lim = o.limit > 0 ? o.limit : 0;
  return (lim + sellerUnit(o, w)) / (1 - sellerPct(o, w));
}

// ---- scratch buffers ----------------------------------------------------------
const IDX = 131072; // 2^17: max orders per side packed into a sort key
const LEVEL_MAX = 68719476735; // 2^36 − 1 quantisation levels of log price (≈ 4e-10 relative resolution)
const LN_MIN = Math.log(PRICE_MIN);
const LN_SPAN = Math.log(PRICE_MAX) - LN_MIN;
const REL_EPS = 1e-9; // price comparisons within this relative tolerance count as equal

let keyB = new Float64Array(2048);
let keyA = new Float64Array(2048);
let lvB = new Float64Array(2048);
let lvA = new Float64Array(2048);
const vb: Order[] = []; // valid bids (unsorted)
const va: Order[] = [];
const sb: Order[] = []; // valid bids sorted ascending by base
const sa: Order[] = []; // valid asks sorted ascending by base
let sortedBook: Book | null = null; // the book whose sorted scratch is valid
let nbS = 0;
let naS = 0;

function ensureCap(n: number): void {
  if (keyB.length >= n && keyA.length >= n) return;
  let c = keyB.length;
  while (c < n) c *= 2;
  keyB = new Float64Array(c);
  keyA = new Float64Array(c);
  lvB = new Float64Array(c);
  lvA = new Float64Array(c);
}

/** Quantised log-price level (monotone in base). */
function levelOf(base: number): number {
  const b = base < PRICE_MIN ? PRICE_MIN : base > PRICE_MAX ? PRICE_MAX : base;
  const l = Math.floor(((Math.log(b) - LN_MIN) / LN_SPAN) * LEVEL_MAX);
  return l < 0 ? 0 : l > LEVEL_MAX ? LEVEL_MAX : l;
}

/** Sort `src[0..n)` ascending by base into `dst`, levels into `lv`. */
function sortSide(src: Order[], n: number, key: Float64Array, lv: Float64Array, dst: Order[]): void {
  dst.length = n;
  if (n <= IDX) {
    for (let i = 0; i < n; i++) key[i] = levelOf(src[i].base) * IDX + i;
    const view = key.subarray(0, n);
    view.sort();
    for (let i = 0; i < n; i++) {
      const k = view[i];
      const l = Math.floor(k / IDX);
      dst[i] = src[k - l * IDX];
      lv[i] = l;
    }
  } else {
    // Pathologically large book: comparator sort fallback.
    const tmp = src.slice(0, n).sort((a, b) => a.base - b.base);
    for (let i = 0; i < n; i++) {
      dst[i] = tmp[i];
      lv[i] = levelOf(tmp[i].base);
    }
  }
}

/** Collect valid orders (base already set, −1 = invalid) of `book` into the sorted scratch. */
function prepareSorted(book: Book): void {
  vb.length = 0;
  va.length = 0;
  for (const o of book.bids) if (o.base > 0 && o.qty > 0) vb.push(o);
  for (const o of book.asks) if (o.base > 0 && o.qty > 0) va.push(o);
  ensureCap(Math.max(vb.length, va.length));
  sortSide(vb, vb.length, keyB, lvB, sb);
  sortSide(va, va.length, keyA, lvA, sa);
  nbS = vb.length;
  naS = va.length;
  sortedBook = book;
}

function validRef(ref: number, fallback: number): number {
  if (ref > 0 && Number.isFinite(ref)) return ref;
  return fallback > 0 && Number.isFinite(fallback) ? fallback : 1;
}

function clampPrice(p: number): number {
  return p < PRICE_MIN ? PRICE_MIN : p > PRICE_MAX ? PRICE_MAX : p;
}

/**
 * Clear a book.
 * 1. For every order compute `order.base` from its limit using book.wedge
 *    (skip the wedge if order.exempt) and the order's own xPct/xUnit:
 *      bid:  base = (limit − bUnit − xUnit) / (1 + bPct + xPct)
 *      ask:  base = (limit + sUnit + xUnit) / (1 − sPct − xPct)   (denominator floored at 0.05)
 *    Orders with qty ≤ 0 or non-finite base are ignored (their base is set to −1).
 * 2. Clearing price: maximise executable volume; tie-break by minimum
 *    |D − S| imbalance; then market pressure (excess demand → highest candidate,
 *    excess supply → lowest); then closest to `refPrice` (anywhere inside the
 *    range of equally good prices, so a calm market keeps its reference price).
 * 3. Apply book.ceiling / book.floor (≥ 0 means active): if the unconstrained
 *    price is above the ceiling, price = ceiling and volume = min(D, S) at the
 *    ceiling with BUYERS rationed pro-rata among all bids with base ≥ ceiling;
 *    symmetric for the floor (sellers rationed pro-rata).
 * 4. Without a binding limit, allocate by price priority (highest bids / lowest
 *    asks first); orders at exactly the marginal price share pro-rata.
 * 5. Set order.filled and order.price (= clearing base price) for every order.
 * If no bid ≥ ask: volume 0, price = mid of best bid/ask if both exist, else
 * refPrice (clamped into any active limits).
 * Side effect: book.bids / book.asks array order is left untouched.
 */
export function clearBook(book: Book, refPrice: number): ClearResult {
  const w = book.wedge;
  let totalBid = 0;
  let totalAsk = 0;
  let bestBid = -1;
  let bestAsk = -1;
  vb.length = 0;
  va.length = 0;

  // ---- 1. convert limits to base terms ----
  for (const o of book.bids) {
    o.filled = 0;
    o.paid = 0;
    const q = o.qty;
    let b = q > 0 && q < 1e15 && o.limit > 0 ? bidBase(o, w) : NaN;
    if (!(b >= PRICE_MIN)) {
      o.base = -1; // NaN / unaffordable → ignored
      continue;
    }
    if (b > PRICE_MAX) b = PRICE_MAX;
    o.base = b;
    vb.push(o);
    totalBid += q;
    if (b > bestBid) bestBid = b;
  }
  for (const o of book.asks) {
    o.filled = 0;
    o.paid = 0;
    const q = o.qty;
    let b = q > 0 && q < 1e15 && Number.isFinite(o.limit) ? askBase(o, w) : NaN;
    if (!(b <= PRICE_MAX)) {
      o.base = -1;
      continue;
    }
    if (b < PRICE_MIN) b = PRICE_MIN;
    o.base = b;
    va.push(o);
    totalAsk += q;
    if (bestAsk < 0 || b < bestAsk) bestAsk = b;
  }
  const nb = vb.length;
  const na = va.length;

  let ceil = book.ceiling >= 0 && Number.isFinite(book.ceiling) ? clampPrice(book.ceiling) : -1;
  let floor = book.floor >= 0 && Number.isFinite(book.floor) ? clampPrice(book.floor) : -1;
  if (ceil >= 0 && floor >= 0 && floor > ceil) floor = ceil; // conflicting limits: the ceiling wins

  const finish = (price: number, bound: ClearResult['bound'], crossedPossible: boolean): ClearResult => {
    const p = clampPrice(price);
    // demand & supply at the final price (tolerant comparisons)
    const pLo = p * (1 - REL_EPS);
    const pHi = p * (1 + REL_EPS);
    let D = 0;
    let S = 0;
    for (let i = 0; i < nb; i++) if (vb[i].base >= pLo) D += vb[i].qty;
    for (let i = 0; i < na; i++) if (va[i].base <= pHi) S += va[i].qty;
    const V = crossedPossible ? Math.min(D, S) : 0;
    let rationed: ClearResult['rationed'] = 'none';
    const eps = 1e-9 * Math.max(1, D, S);
    if (V > 0) {
      if (bound !== 'none') {
        // Legal price: the long side is rationed pro-rata among ALL eligible orders.
        const fb = D > 0 ? Math.min(1, V / D) : 0;
        const fa = S > 0 ? Math.min(1, V / S) : 0;
        for (let i = 0; i < nb; i++) if (vb[i].base >= pLo) vb[i].filled = vb[i].qty * fb;
        for (let i = 0; i < na; i++) if (va[i].base <= pHi) va[i].filled = va[i].qty * fa;
      } else {
        allocatePriority(sb, lvB, nb, V, true, pLo, pHi);
        allocatePriority(sa, lvA, na, V, false, pLo, pHi);
      }
    }
    if (D > S + eps) rationed = 'buyers';
    else if (S > D + eps) rationed = 'sellers';
    for (const o of book.bids) o.price = p;
    for (const o of book.asks) o.price = p;
    return {
      price: p,
      volume: V,
      demandAtPrice: D,
      supplyAtPrice: S,
      bestBid,
      bestAsk,
      crossed: V > 0,
      rationed,
      bound,
    };
  };

  const clampLimits = (p: number): number => {
    let x = p;
    if (ceil >= 0 && x > ceil) x = ceil;
    if (floor >= 0 && x < floor) x = floor;
    return x;
  };

  // ---- no cross: indicative price ----
  if (nb === 0 || na === 0 || bestBid < bestAsk) {
    sortedBook = null;
    const ind = nb > 0 && na > 0 ? (bestBid + bestAsk) / 2 : validRef(refPrice, bestBid > 0 ? bestBid : bestAsk);
    return finish(clampLimits(ind), 'none', false);
  }

  // ---- 2. sort & scan candidate prices (ascending) ----
  ensureCap(Math.max(nb, na));
  sortSide(vb, nb, keyB, lvB, sb);
  sortSide(va, na, keyA, lvA, sa);
  nbS = nb;
  naS = na;
  sortedBook = book;

  let bestV = 0;
  let bestImb = Infinity;
  let tLo = -1;
  let tHi = -1;
  let nPos = 0;
  let nNeg = 0;
  let nZero = 0;
  const epsQ = 1e-9 * Math.max(1, totalBid, totalAsk);
  let i = 0;
  let j = 0;
  let bidBelow = 0; // Σ qty of bids with level < L
  let askUpTo = 0; // Σ qty of asks with level ≤ L
  while (i < nb || j < na) {
    const lb = i < nb ? lvB[i] : Infinity;
    const la = j < na ? lvA[j] : Infinity;
    const L = lb < la ? lb : la;
    const price = lb <= la ? sb[i].base : sa[j].base;
    while (j < na && lvA[j] === L) askUpTo += sa[j++].qty;
    const D = totalBid - bidBelow;
    const S = askUpTo;
    const V = D < S ? D : S;
    if (V > epsQ) {
      const imb = D - S;
      const a = imb < 0 ? -imb : imb;
      const sign = imb > epsQ ? 1 : imb < -epsQ ? -1 : 0;
      if (V > bestV + epsQ || (V >= bestV - epsQ && a < bestImb - epsQ)) {
        if (V > bestV) bestV = V;
        bestImb = a;
        tLo = tHi = price;
        nPos = sign > 0 ? 1 : 0;
        nNeg = sign < 0 ? 1 : 0;
        nZero = sign === 0 ? 1 : 0;
      } else if (V >= bestV - epsQ && a <= bestImb + epsQ) {
        tHi = price;
        if (sign > 0) nPos++;
        else if (sign < 0) nNeg++;
        else nZero++;
      }
    }
    while (i < nb && lvB[i] === L) bidBelow += sb[i++].qty;
    if (totalBid - bidBelow <= epsQ) break; // no demand left at higher prices
  }

  if (!(bestV > 0) || tLo < 0) {
    const ind = (bestBid + bestAsk) / 2;
    return finish(clampLimits(ind), 'none', false);
  }

  let p: number;
  if (nZero > 0 || (nPos > 0 && nNeg > 0)) {
    // No pressure either way: stay as close to the reference price as the book allows.
    const r = validRef(refPrice, (tLo + tHi) / 2);
    p = r < tLo ? tLo : r > tHi ? tHi : r;
  } else if (nPos > 0) p = tHi; // excess demand → highest candidate
  else p = tLo; // excess supply → lowest candidate

  // ---- 3. legal limits ----
  let bound: ClearResult['bound'] = 'none';
  if (ceil >= 0 && p > ceil) {
    p = ceil;
    bound = 'ceiling';
  } else if (floor >= 0 && p < floor) {
    p = floor;
    bound = 'floor';
  }
  return finish(p, bound, true);
}

/**
 * Price-priority allocation of `V` units over sorted orders (ascending by base):
 * bids are served from the top, asks from the bottom; each group of orders at
 * the same price level shares pro-rata when it straddles the marginal unit.
 */
function allocatePriority(
  sorted: Order[],
  lv: Float64Array,
  n: number,
  V: number,
  isBid: boolean,
  pLo: number,
  pHi: number,
): void {
  let rem = V;
  let k = isBid ? n - 1 : 0;
  const step = isBid ? -1 : 1;
  while (rem > 1e-12 && k >= 0 && k < n) {
    const L = lv[k];
    // group [k, e) at level L
    let e = k;
    let gq = 0;
    while (e >= 0 && e < n && lv[e] === L) {
      const o = sorted[e];
      if (isBid ? o.base >= pLo : o.base <= pHi) gq += o.qty;
      e += step;
    }
    if (gq > 0) {
      const f = gq <= rem ? 1 : rem / gq;
      for (let x = k; x !== e; x += step) {
        const o = sorted[x];
        if (isBid ? o.base >= pLo : o.base <= pHi) o.filled = o.qty * f;
      }
      rem -= Math.min(gq, rem);
    } else {
      // first group already ineligible: nothing further can trade
      break;
    }
    k = e;
  }
}

/** Write downsampled cumulative curve points of the sorted scratch into `out`. */
function curveSide(sorted: Order[], lv: Float64Array, n: number, descending: boolean, maxPoints: number, out: number[]): void {
  out.length = 0;
  if (n === 0 || maxPoints <= 0) return;
  // aggregate by level
  const px: number[] = [];
  const cq: number[] = [];
  let cum = 0;
  let k = descending ? n - 1 : 0;
  const step = descending ? -1 : 1;
  while (k >= 0 && k < n) {
    const L = lv[k];
    const price = sorted[k].base;
    while (k >= 0 && k < n && lv[k] === L) {
      cum += sorted[k].qty;
      k += step;
    }
    px.push(price);
    cq.push(cum);
  }
  const m = px.length;
  if (m <= maxPoints) {
    for (let x = 0; x < m; x++) out.push(r4(px[x]), r4(cq[x]));
    return;
  }
  let last = -1;
  for (let x = 0; x < maxPoints; x++) {
    const idx = maxPoints === 1 ? m - 1 : Math.round((x * (m - 1)) / (maxPoints - 1));
    if (idx === last) continue;
    last = idx;
    out.push(r4(px[idx]), r4(cq[idx]));
  }
}

/** Round for compact snapshots (4 decimals). */
function r4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/**
 * Write the aggregated curves of `book` into the given arrays (cleared first).
 * Uses the sorted scratch left by clearBook when `book` was the last book cleared.
 */
export function curveInto(book: Book, maxPoints: number, bidsOut: number[], asksOut: number[]): void {
  if (sortedBook !== book) prepareSorted(book);
  curveSide(sb, lvB, nbS, true, maxPoints, bidsOut);
  curveSide(sa, lvA, naS, false, maxPoints, asksOut);
}

/**
 * Aggregated demand and supply curves for UI snapshots, in base prices.
 * Returns flattened arrays [price, cumQty, ...]: bids descending, asks ascending,
 * downsampled to at most `maxPoints` points each. Requires order.base to be set.
 */
export function aggregateCurve(book: Book, maxPoints: number): { bids: number[]; asks: number[] } {
  const bids: number[] = [];
  const asks: number[] = [];
  curveInto(book, maxPoints, bids, asks);
  return { bids, asks };
}
