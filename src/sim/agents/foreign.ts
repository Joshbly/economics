// ============================================================================
// The outside world: foreign ships at the port and the gold market.
// OWNER: finance-trade agent. See DESIGN §3.6.
// ============================================================================
import type { SimState } from '../types';
import type { Books } from '../market/markets';

/**
 * Port (the harbor town's books), for each tradable good with foreign.world[g] > 0:
 *   foreign sell (imports):  ask at limit E·w·(1+IMPORT_MARKUP), qty = shipCap (× import quota),
 *                            import levies as per-order xPct/xUnit (payer: buyer side)
 *   foreign buy  (exports):  bid at limit E·w·(1−EXPORT_DISCOUNT), qty = shipCap (× export quota),
 *                            limited by foreign.coin; export levies as per-order extras
 * where E = s.goldMarket.ema (¤ per oz). Ref = FOREIGN.
 * Gold market (books.gold), ref FOREIGN: dealers quote around
 *   V' = dealerValue · (1 + k·(coin − target)/target)   (target = desk working coin,
 *   raised when the deposit rate is high — interest parity)
 * selling DEALER_DEPTH oz per 1 % above V' and buying the same per 1 % below V'
 * (buying limited by foreign.coin), over ±10 %.
 */
export function foreignOrders(s: SimState, books: Books): void {
  // TODO(finance-trade)
}

/**
 * Evening: world prices drift (log random walk WORLD_DRIFT_SIGMA, mean-reverting to
 * world0, times active shocks); expire shocks; ppp = INIT_GOLD_PRICE × (CPI/100) /
 * (world index); dealerValue += DEALER_PPP_PULL·(ppp − dealerValue) + 0.2·(last gold
 * price − dealerValue)·0.1; goldEma; shipCap from national use × SHIP_CAP_SHARE ×
 * (1 + piers·PIER_CAP_BONUS). stats.acc: imports/exports value.
 */
export function foreignEndDay(s: SimState): void {
  // TODO(finance-trade)
}
