// ============================================================================
// Trading houses: inter-town arbitrage by wagon. OWNER: finance-trade agent.
// See DESIGN §3.4. Routes & travel times from world/paths.routeBetweenTowns.
// ============================================================================
import type { ActionResult, GoodId, SimState, TownId } from '../types';
import type { Books } from '../market/markets';

/**
 * Morning: shipments whose arrive ≤ day+1 are delivered (trader stock at the destination,
 * basis updated as weighted average; Treasury shipments to treasury.goods); busy wagons
 * whose return day has passed become free; stock age += 1. Trader workforce target
 * (drivers = wagons in use EMA × 1.2, ≤ wagons, ≤ capacity) and wagon investment
 * (buy tools when utilisation is high and trade is profitable) are decided here.
 */
export function tradersBeginDay(s: SimState): void {
  // TODO(finance-trade)
}

/**
 * For each trader (home town h) with free wagons AND free drivers AND oil for the trip:
 * rank (good, destination) by expected margin per unit =
 *   expectedNet(dest) − expectedGross(h) − freightPerUnit(h, dest) − shipment levies
 *   − max(TRADE_MIN_MARGIN_ABS, TRADE_MIN_MARGIN_PCT·price)
 * cap each by TRADE_DEST_ABSORB × destination volume EMA (+ shortage) and any shipMax quota,
 * and bid in h's book at limit = expected dest net − freight − levies − min margin
 * (tag = destination town). Also: asks for stock held in each non-home town
 * (above landed basis, discounted with age), and an oil bid to keep ~10 trips of fuel.
 */
export function traderOrders(s: SimState, books: Books): void {
  // TODO(finance-trade)
}

/**
 * After clearing: for each filled trade bid, load wagons (ceil(qty / WAGON_CAPACITY)),
 * burn oil (OIL_PER_TILE × tiles × wagons), charge 'shipment' levies (payer 'owner'),
 * create Shipment(s) with depart = day + 0.5, arrive = depart + route.days,
 * mark wagons busy until day + 2·route.days. stats.acc: shipped_units, freight_cost.
 */
export function tradersDispatch(s: SimState, books: Books): void {
  // TODO(finance-trade)
}

/** Current freight cost per unit from town a to b (¤), used by traders and the shipping index. */
export function freightPerUnit(s: SimState, a: TownId, b: TownId): number {
  // TODO(finance-trade)
  return 1;
}

/** Move Treasury goods between towns (paid freight from the Purse to the home trader of `from`). */
export function shipTreasuryGoods(s: SimState, from: TownId, to: TownId, good: GoodId, qty: number): ActionResult {
  // TODO(finance-trade)
  return { ok: false, message: 'not implemented' };
}
