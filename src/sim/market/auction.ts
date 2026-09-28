// ============================================================================
// Uniform-price call auction for ONE book. Pure: sets order.base / filled /
// price on the orders, but moves no money or goods (markets.ts settles).
// OWNER: market-policy agent. See DESIGN §4.
// ============================================================================
import type { Book } from '../types';

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

/**
 * Clear a book.
 * 1. For every order compute `order.base` from its limit using book.wedge
 *    (skip the wedge if order.exempt) and the order's own xPct/xUnit:
 *      bid:  base = (limit − bUnit − xUnit) / (1 + bPct + xPct)
 *      ask:  base = (limit + sUnit + xUnit) / (1 − sPct − xPct)   (denominator floored at 0.05)
 *    Orders with qty ≤ 0 or non-finite base are ignored.
 * 2. Clearing price: maximise executable volume; tie-break by minimum
 *    |D − S| imbalance; then market pressure (excess demand → highest candidate,
 *    excess supply → lowest); then closest to `refPrice`.
 * 3. Apply book.ceiling / book.floor (≥ 0 means active): if the unconstrained
 *    price is above the ceiling, price = ceiling and volume = min(D, S) at the
 *    ceiling with BUYERS rationed pro-rata among all bids with base ≥ ceiling;
 *    symmetric for the floor (sellers rationed pro-rata).
 * 4. Without a binding limit, allocate by price priority (highest bids / lowest
 *    asks first); orders at exactly the marginal price share pro-rata.
 * 5. Set order.filled and order.price (= clearing base price) for every order.
 * If no bid ≥ ask: volume 0, price = mid of best bid/ask if both exist, else
 * refPrice (clamped into any active limits).
 */
export function clearBook(book: Book, refPrice: number): ClearResult {
  // TODO(market-policy)
  return { price: refPrice, volume: 0, demandAtPrice: 0, supplyAtPrice: 0, bestBid: -1, bestAsk: -1, crossed: false, rationed: 'none', bound: 'none' };
}

/**
 * Aggregated demand and supply curves for UI snapshots, in base prices.
 * Returns flattened arrays [price, cumQty, ...]: bids descending, asks ascending,
 * downsampled to at most `maxPoints` points each. Requires order.base to be set.
 */
export function aggregateCurve(book: Book, maxPoints: number): { bids: number[]; asks: number[] } {
  // TODO(market-policy)
  return { bids: [], asks: [] };
}
