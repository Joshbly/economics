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
// (every household posts an 8-rung ladder per consumer good) but only a few
// distinct prices. Orders are aggregated per price level (a 36-bit key taken
// from the float's bit pattern, ~1e-9 relative resolution) in a typed-array
// hash table; only the distinct levels are sorted (native Float64Array sort on
// packed keys), and fills are decided per level, so clearing is O(n + d·log d).
// All scratch buffers are module-level and reused: clearing allocates almost
// nothing. Orders on the same level are treated as the same price.
// ============================================================================
import { PRICE_MAX as CFG_PRICE_MAX, PRICE_MIN as CFG_PRICE_MIN, WEDGE_BPCT_MIN, WEDGE_SPCT_MAX } from '../config';
import type { Book, Order, Wedge } from '../types';

// Local copies (imported bindings can be getters under some loaders; these are read in hot loops).
const PRICE_MIN = CFG_PRICE_MIN;
const PRICE_MAX = CFG_PRICE_MAX;
const B_PCT_MIN = WEDGE_BPCT_MIN; // 1 + buyer pct ≥ 0.05
const S_PCT_MAX = WEDGE_SPCT_MAX; // 1 − seller pct ≥ 0.05

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
  return p < B_PCT_MIN ? B_PCT_MIN : p;
}
/** Combined buyer-side ¤ per unit (book wedge unless exempt, plus the order's own extra). */
export function buyerUnit(o: Order, w: Wedge): number {
  return (o.exempt ? 0 : w.bUnit) + (o.xUnit || 0);
}
/** Combined seller-side percentage, clamped so 1 − pct ≥ 0.05. */
export function sellerPct(o: Order, w: Wedge): number {
  const p = (o.exempt ? 0 : w.sPct) + (o.xPct || 0);
  return p > S_PCT_MAX ? S_PCT_MAX : p;
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

// ---- level aggregation scratch -------------------------------------------------
// Books hold many orders but few distinct prices (every household in a town
// ladders around the same expected price), so orders are aggregated by price
// LEVEL with an O(n) typed-array hash table; only the distinct levels are
// sorted, and fills are decided per level. Clearing is O(n + d·log d).
const IDX = 131072; // 2^17: max distinct levels packed into a sort key
const REL_EPS = 1e-9; // price comparisons within this relative tolerance count as equal

// Price levels come straight from the IEEE-754 bit pattern: for positive doubles
// it is monotone in the value, so (high word − high word of PRICE_MIN) · 2^10 +
// top 10 bits of the low word is a 36-bit integer level with ~1e-9 relative
// resolution — no logarithm needed. Level · 2^17 + index fits in 53 bits.
const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
F64[0] = 1;
const HI = U32[1] === 0x3ff00000 ? 1 : 0; // little-endian → high word is [1]
const LO = 1 - HI;
F64[0] = PRICE_MIN;
const HI_MIN = U32[HI];

/** Quantised price level (monotone in base). */
function levelOf(base: number): number {
  F64[0] = base < PRICE_MIN ? PRICE_MIN : base > PRICE_MAX ? PRICE_MAX : base;
  return (U32[HI] - HI_MIN) * 1024 + (U32[LO] >>> 22);
}

/** One side of a book, aggregated by price level. */
interface Side {
  n: number; // valid orders
  ord: Order[]; // valid orders
  lvIdx: Int32Array; // valid order k → its distinct level index
  nd: number; // distinct levels
  dLevel: Float64Array;
  dPrice: Float64Array; // representative base price of the level
  dQty: Float64Array; // total quantity at the level
  dFrac: Float64Array; // fill fraction decided for the level
  rank: Int32Array; // rank r (ascending price) → level index
  keys: Float64Array; // sort scratch
  hKey: Float64Array; // hash table: level
  hVal: Int32Array; // hash table: level index
  hGen: Int32Array; // hash table: generation stamp (slot used iff === gen)
  gen: number;
  mask: number;
}

function newSide(): Side {
  return {
    n: 0,
    ord: [],
    lvIdx: new Int32Array(256),
    nd: 0,
    dLevel: new Float64Array(256),
    dPrice: new Float64Array(256),
    dQty: new Float64Array(256),
    dFrac: new Float64Array(256),
    rank: new Int32Array(256),
    keys: new Float64Array(256),
    hKey: new Float64Array(512),
    hVal: new Int32Array(512),
    hGen: new Int32Array(512),
    gen: 0,
    mask: 511,
  };
}

const SB = newSide();
const SA = newSide();
let sortedBook: Book | null = null; // the book whose aggregated scratch is valid

/** Prepare a side for up to `nMax` orders. */
function sideReset(sd: Side, nMax: number): void {
  sd.n = 0;
  sd.nd = 0;
  if (sd.ord.length > nMax) sd.ord.length = nMax; // stale refs beyond n are never read
  if (sd.lvIdx.length < nMax) {
    let c = sd.lvIdx.length;
    while (c < nMax) c *= 2;
    sd.lvIdx = new Int32Array(c);
    sd.dLevel = new Float64Array(c);
    sd.dPrice = new Float64Array(c);
    sd.dQty = new Float64Array(c);
    sd.dFrac = new Float64Array(c);
    sd.rank = new Int32Array(c);
    sd.keys = new Float64Array(c);
  }
  if (sd.hKey.length < nMax * 2) {
    let c = sd.hKey.length;
    while (c < nMax * 2) c *= 2;
    sd.hKey = new Float64Array(c);
    sd.hVal = new Int32Array(c);
    sd.hGen = new Int32Array(c);
    sd.mask = c - 1;
    sd.gen = 0;
  }
  sd.gen++;
  if (sd.gen > 2000000000) {
    sd.hGen.fill(0);
    sd.gen = 1;
  }
}

/** Add a valid order with its base price to a side. */
function sideAdd(sd: Side, o: Order, base: number): void {
  const L = levelOf(base);
  const mask = sd.mask;
  let h = Math.imul((L >>> 0) ^ ((L / 4294967296) | 0), 0x9e3779b1) & mask;
  let d = -1;
  while (sd.hGen[h] === sd.gen) {
    if (sd.hKey[h] === L) {
      d = sd.hVal[h];
      break;
    }
    h = (h + 1) & mask;
  }
  if (d < 0) {
    d = sd.nd++;
    sd.hGen[h] = sd.gen;
    sd.hKey[h] = L;
    sd.hVal[h] = d;
    sd.dLevel[d] = L;
    sd.dPrice[d] = base;
    sd.dQty[d] = 0;
  }
  sd.dQty[d] += o.qty;
  sd.lvIdx[sd.n] = d;
  sd.ord[sd.n++] = o;
}

/** Rank the distinct levels of a side by price (ascending). */
function sideSort(sd: Side): void {
  const nd = sd.nd;
  if (nd <= IDX) {
    const keys = sd.keys;
    for (let d = 0; d < nd; d++) keys[d] = sd.dLevel[d] * IDX + d;
    const view = keys.subarray(0, nd);
    view.sort();
    for (let r = 0; r < nd; r++) {
      const k = view[r];
      sd.rank[r] = k - Math.floor(k / IDX) * IDX;
    }
  } else {
    // Pathologically many distinct prices: comparator sort fallback.
    const idx = Array.from({ length: nd }, (_, d) => d).sort((a, b) => sd.dLevel[a] - sd.dLevel[b]);
    for (let r = 0; r < nd; r++) sd.rank[r] = idx[r];
  }
}

/** Rebuild the aggregated scratch of `book` from order.base (−1 = invalid). */
function prepareSorted(book: Book): void {
  sideReset(SB, book.bids.length);
  sideReset(SA, book.asks.length);
  for (const o of book.bids) if (o.base > 0 && o.qty > 0) sideAdd(SB, o, o.base);
  for (const o of book.asks) if (o.base > 0 && o.qty > 0) sideAdd(SA, o, o.base);
  sideSort(SB);
  sideSort(SA);
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
  const bids = book.bids;
  const asks = book.asks;
  sideReset(SB, bids.length);
  sideReset(SA, asks.length);

  // ---- 1. convert limits to base terms (same formulas as bidBase / askBase, inlined) ----
  const wbP = w.bPct;
  const wbU = w.bUnit;
  const wsP = w.sPct;
  const wsU = w.sUnit;
  for (let k = 0; k < bids.length; k++) {
    const o = bids[k];
    o.filled = 0;
    o.paid = 0;
    const q = o.qty;
    let b = NaN;
    if (q > 0 && q < 1e15 && o.limit > 0) {
      let pct = (o.exempt ? 0 : wbP) + (o.xPct || 0);
      if (pct < B_PCT_MIN) pct = B_PCT_MIN;
      b = (o.limit - (o.exempt ? 0 : wbU) - (o.xUnit || 0)) / (1 + pct);
    }
    if (!(b >= PRICE_MIN)) {
      o.base = -1; // NaN / unaffordable → ignored
      continue;
    }
    if (b > PRICE_MAX) b = PRICE_MAX;
    o.base = b;
    sideAdd(SB, o, b);
    totalBid += q;
    if (b > bestBid) bestBid = b;
  }
  for (let k = 0; k < asks.length; k++) {
    const o = asks[k];
    o.filled = 0;
    o.paid = 0;
    const q = o.qty;
    let b = NaN;
    if (q > 0 && q < 1e15 && o.limit === o.limit && o.limit < Infinity) {
      let pct = (o.exempt ? 0 : wsP) + (o.xPct || 0);
      if (pct > S_PCT_MAX) pct = S_PCT_MAX;
      b = ((o.limit > 0 ? o.limit : 0) + (o.exempt ? 0 : wsU) + (o.xUnit || 0)) / (1 - pct);
    }
    if (!(b <= PRICE_MAX)) {
      o.base = -1;
      continue;
    }
    if (b < PRICE_MIN) b = PRICE_MIN;
    o.base = b;
    sideAdd(SA, o, b);
    totalAsk += q;
    if (bestAsk < 0 || b < bestAsk) bestAsk = b;
  }
  sideSort(SB);
  sideSort(SA);
  sortedBook = book;
  const ndB = SB.nd;
  const ndA = SA.nd;

  let ceil = book.ceiling >= 0 && Number.isFinite(book.ceiling) ? clampPrice(book.ceiling) : -1;
  let floor = book.floor >= 0 && Number.isFinite(book.floor) ? clampPrice(book.floor) : -1;
  if (ceil >= 0 && floor >= 0 && floor > ceil) floor = ceil; // conflicting limits: the ceiling wins

  const clampLimits = (p: number): number => {
    let x = p;
    if (ceil >= 0 && x > ceil) x = ceil;
    if (floor >= 0 && x < floor) x = floor;
    return x;
  };

  // ---- no cross: indicative price ----
  if (ndB === 0 || ndA === 0 || bestBid < bestAsk) {
    const ind = ndB > 0 && ndA > 0 ? (bestBid + bestAsk) / 2 : validRef(refPrice, bestBid > 0 ? bestBid : bestAsk);
    return finish(book, clampLimits(ind), 'none', false, bestBid, bestAsk);
  }

  // ---- 2. scan candidate price levels (ascending) ----
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
  let bidBelow = 0; // Σ qty of bid levels below L
  let askUpTo = 0; // Σ qty of ask levels at or below L
  while (i < ndB || j < ndA) {
    const db = i < ndB ? SB.rank[i] : -1;
    const da = j < ndA ? SA.rank[j] : -1;
    const lb = db >= 0 ? SB.dLevel[db] : Infinity;
    const la = da >= 0 ? SA.dLevel[da] : Infinity;
    const L = lb < la ? lb : la;
    const price = lb <= la ? SB.dPrice[db] : SA.dPrice[da];
    if (la === L) {
      askUpTo += SA.dQty[da];
      j++;
    }
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
    if (lb === L) {
      bidBelow += SB.dQty[db];
      i++;
    }
    if (totalBid - bidBelow <= epsQ) break; // no demand left at higher prices
  }

  if (!(bestV > 0) || tLo < 0) return finish(book, clampLimits((bestBid + bestAsk) / 2), 'none', false, bestBid, bestAsk);

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
  return finish(book, p, bound, true, bestBid, bestAsk);
}

/** Final price → demand/supply at it, per-level fill fractions (steps 3–5), order fills. */
function finish(book: Book, price: number, bound: ClearResult['bound'], crossedPossible: boolean, bestBid: number, bestAsk: number): ClearResult {
  const p = clampPrice(price);
  const pLo = p * (1 - REL_EPS);
  const pHi = p * (1 + REL_EPS);
  let D = 0;
  let S = 0;
  for (let d = 0; d < SB.nd; d++) if (SB.dPrice[d] >= pLo) D += SB.dQty[d];
  for (let d = 0; d < SA.nd; d++) if (SA.dPrice[d] <= pHi) S += SA.dQty[d];
  const V = crossedPossible ? Math.min(D, S) : 0;
  const eps = 1e-9 * Math.max(1, D, S);
  SB.dFrac.fill(0, 0, SB.nd);
  SA.dFrac.fill(0, 0, SA.nd);
  if (V > 0) {
    if (bound !== 'none') {
      // Legal price: the long side is rationed pro-rata among ALL eligible orders.
      const fb = D > 0 ? Math.min(1, V / D) : 0;
      const fa = S > 0 ? Math.min(1, V / S) : 0;
      for (let d = 0; d < SB.nd; d++) if (SB.dPrice[d] >= pLo) SB.dFrac[d] = fb;
      for (let d = 0; d < SA.nd; d++) if (SA.dPrice[d] <= pHi) SA.dFrac[d] = fa;
    } else {
      // Price priority: best levels first, the marginal level shares pro-rata.
      let rem = V;
      for (let r = SB.nd - 1; r >= 0 && rem > 1e-12; r--) {
        const d = SB.rank[r];
        if (!(SB.dPrice[d] >= pLo)) break;
        const q = SB.dQty[d];
        const f = q <= rem ? 1 : rem / q;
        SB.dFrac[d] = f;
        rem -= q * f;
      }
      rem = V;
      for (let r = 0; r < SA.nd && rem > 1e-12; r++) {
        const d = SA.rank[r];
        if (!(SA.dPrice[d] <= pHi)) break;
        const q = SA.dQty[d];
        const f = q <= rem ? 1 : rem / q;
        SA.dFrac[d] = f;
        rem -= q * f;
      }
    }
    const fB = SB.dFrac;
    const iB = SB.lvIdx;
    const oB = SB.ord;
    for (let k = 0; k < SB.n; k++) {
      const o = oB[k];
      o.filled = o.qty * fB[iB[k]];
    }
    const fA = SA.dFrac;
    const iA = SA.lvIdx;
    const oA = SA.ord;
    for (let k = 0; k < SA.n; k++) {
      const o = oA[k];
      o.filled = o.qty * fA[iA[k]];
    }
  }
  let rationed: ClearResult['rationed'] = 'none';
  if (D > S + eps) rationed = 'buyers';
  else if (S > D + eps) rationed = 'sellers';
  const bids = book.bids;
  const asks = book.asks;
  for (let k = 0; k < bids.length; k++) bids[k].price = p;
  for (let k = 0; k < asks.length; k++) asks[k].price = p;
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
}

/** Write downsampled cumulative curve points of an aggregated side into `out`. */
function curveSide(sd: Side, descending: boolean, maxPoints: number, out: number[]): void {
  out.length = 0;
  const m = sd.nd;
  if (m === 0 || maxPoints <= 0) return;
  // cumulative quantity per rank, in curve order
  const px = sd.keys; // reuse sort scratch: [0..m) prices, [m..2m) cumulative qty (grown if needed)
  if (px.length < 2 * m) sd.keys = new Float64Array(2 * m);
  const buf = sd.keys;
  let cum = 0;
  for (let x = 0; x < m; x++) {
    const d = sd.rank[descending ? m - 1 - x : x];
    cum += sd.dQty[d];
    buf[x] = sd.dPrice[d];
    buf[m + x] = cum;
  }
  if (m <= maxPoints) {
    for (let x = 0; x < m; x++) out.push(r4(buf[x]), r4(buf[m + x]));
    return;
  }
  let last = -1;
  for (let x = 0; x < maxPoints; x++) {
    const idx = maxPoints === 1 ? m - 1 : Math.round((x * (m - 1)) / (maxPoints - 1));
    if (idx === last) continue;
    last = idx;
    out.push(r4(buf[idx]), r4(buf[m + idx]));
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
  curveSide(SB, true, maxPoints, bidsOut);
  curveSide(SA, false, maxPoints, asksOut);
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
