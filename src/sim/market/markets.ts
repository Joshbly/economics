// ============================================================================
// Market plumbing: open books for every market each day, let agents add
// orders, clear them all and SETTLE (money through ledger.pay, goods between
// inventories), update MarketState and stats accumulators.
// OWNER: market-policy agent. See DESIGN §4.
// ============================================================================
import type { Book, MarketState, Order, Ref, SimState, TownId } from '../types';

export interface Books {
  goods: Book[]; // index = town * N_GOODS + good
  iou: Book; // national IOU market (s.iouMarket)
  gold: Book; // national gold market (s.goldMarket)
}

export interface OrderOpts {
  exempt?: boolean; // Treasury orders
  xPct?: number; // per-order extra levy (fraction of base) — e.g. port duties
  xUnit?: number; // per-order extra levy (¤/unit)
  tag?: number;
}

/**
 * Create one Book per goods market (with wedge from levies.saleWedge and
 * ceiling/floor from limits.priceBounds) plus the IOU and gold books
 * (no wedge; limits do not apply to them).
 */
export function openBooks(s: SimState): Books {
  // TODO(market-policy)
  return { goods: [], iou: null as unknown as Book, gold: null as unknown as Book };
}

export function bookFor(books: Books, town: TownId, good: number): Book {
  // TODO(market-policy): goods index, IOU_GOOD → books.iou, GOLD_GOOD → books.gold
  return books.goods[0];
}

/** Add a bid. `limit` = max GROSS ¤ per unit the buyer will pay (incl. levies). Returns the order (read .filled after clearAll). */
export function addBid(book: Book, ref: Ref, limit: number, qty: number, opts?: OrderOpts): Order {
  // TODO(market-policy)
  return null as unknown as Order;
}

/** Add an ask. `limit` = min NET ¤ per unit the seller will accept (after levies). */
export function addAsk(book: Book, ref: Ref, limit: number, qty: number, opts?: OrderOpts): Order {
  // TODO(market-policy)
  return null as unknown as Order;
}

/**
 * Clear every book (auction.clearBook with refPrice = market.ema) and settle:
 *  - goods: seller inventory −= filled (never below 0: scale the fill down if the
 *    seller no longer holds the goods), buyer inventory += filled
 *    (inventoryOf); IOUs → person.iou / bank.iou+iouBook / treasury.iouOutstanding;
 *    gold → person.gold / treasury.gold / FOREIGN (unbounded).
 *  - money: pay(buyer → seller, base·q, 'buy' or 'asset'), then levy legs:
 *    buyer pays base·(bPct+xPct?)+bUnit per unit to STATE (or receives if negative),
 *    seller pays base·sPct+sUnit to STATE (or receives). Exempt orders skip levies.
 *    If the buyer cannot pay in full, shrink the fill proportionally (goods not delivered).
 *    Bank IOU sales book realised gain/loss to bank.equity; iouBook reduced at average cost.
 *  - order.paid = gross paid (buyers) / net received (sellers).
 *  - firm.revenue/soldToday (seller of its output), firm.spent, person.spent updated.
 *  - levies.attributeSaleLevies for per-rule accounting.
 *  - MarketState: price, gross, net, ema (k = 0.15 when traded, 0.03 indicative),
 *    volume, volEma, shortage, surplus, bestBid, bestAsk, hist/volHist (capped
 *    MARKET_HIST_DAYS), curve snapshot (aggregateCurve, ≤ 40 points, + Treasury orders).
 *  - stats.acc: `vol_<good>`, `val_<good>` (base value), `cons_<good>` (qty bought by
 *    people), `consval` (¤ households spent on goods), `gov_goods` (¤ Treasury bought),
 *    `imp_<good>`, `exp_<good>` (port trades with FOREIGN), `shortage_<good>`.
 */
export function clearAll(s: SimState, books: Books): void {
  // TODO(market-policy)
}

export function marketOf(s: SimState, town: TownId, good: number): MarketState {
  // TODO(market-policy): goods → s.markets[town*N_GOODS+good]; IOU_GOOD → s.iouMarket; GOLD_GOOD → s.goldMarket
  return s.markets[0];
}

/** Expected gross price a buyer pays (market ema grossed up with the current wedge). */
export function expectedGross(s: SimState, town: TownId, good: number): number {
  // TODO(market-policy)
  return 1;
}

/** Expected net price a seller receives (market ema net of the current wedge). */
export function expectedNet(s: SimState, town: TownId, good: number): number {
  // TODO(market-policy)
  return 1;
}

/**
 * The inventory array (length N_GOODS) where `ref`'s goods live in `town`:
 * person → pantry (their residence town), firm → inv (its own town) or, for
 * traders in other towns, trade.stock[town]; STATE → treasury.goods[town];
 * FOREIGN → a scratch array with effectively unlimited stock.
 */
export function inventoryOf(s: SimState, ref: Ref, town: TownId): number[] {
  // TODO(market-policy)
  return [];
}
