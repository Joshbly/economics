// ============================================================================
// The player's primitives: validation + execution of PlayerActions, Treasury
// orders in markets, Treasury workforce, transfers. See DESIGN §5.
// OWNER: market-policy agent.
// ============================================================================
import type { ActionResult, PlayerAction, SimState, TownId, TransferGroup } from '../types';
import type { Books } from '../market/markets';

/**
 * Validate and apply an action. Must never throw; returns {ok:false, message}
 * for invalid input. Emits a 'policy' news item for notable actions.
 *  mint/burn            → ledger.mint / ledger.burn
 *  placeOrder/update/cancel → s.policy.orders (ids from s.ids.policy)
 *  moveGoods            → traders.shipTreasuryGoods
 *  add/update/removeLevy, add/update/removeLimit → s.policy.*
 *  setWindow            → treasury.reserveRate/lendRate (lendRate ≥ reserveRate enforced)
 *  build                → construction.startProject (owner STATE; road via world/paths route)
 *  cancelProject        → construction.cancelProject
 *  transfer             → executeTransfer
 *  setAutoMint/setEvents
 */
export function dispatch(s: SimState, a: PlayerAction): ActionResult {
  // TODO(market-policy)
  return { ok: false, message: 'not implemented' };
}

/**
 * Morning: drop expired levies/limits/orders; reset order.filledToday;
 * set treasury.givesSuspended = !autoMint && purse <= 0;
 * apply labour orders: for each town, the stateworks firm's target = Σ qty of
 * enabled 'labor' buy orders there and its wage = the highest such price
 * (target 0 → it releases its workers gradually via labor.ts).
 */
export function policyBeginDay(s: SimState): void {
  // TODO(market-policy)
}

/**
 * Submit enabled Treasury orders for goods / IOU / gold markets (exempt from
 * levies, tag = order id). Buy qty is capped by what the Purse can afford at the
 * limit (unless autoMint); sell qty by holdings (IOU sells are issuance: no cap
 * except the order's own). Respect order.total.
 */
export function playerOrders(s: SimState, books: Books): void {
  // TODO(market-policy)
}

/** After clearing: update order.filled/filledToday/value; disable once-orders and exhausted totals. */
export function playerAfterClear(s: SimState, books: Books): void {
  // TODO(market-policy)
}

/**
 * One-off transfer: dir 1 = give `amount` to every member of the group (in
 * `town`, or all towns if -1); dir −1 = take up to `amount` from each.
 * 'bank' group → pay to/from BANK (a recapitalisation / levy on the bank).
 * Returns total ¤ moved.
 */
export function executeTransfer(s: SimState, group: TransferGroup, town: TownId, amount: number, dir: 1 | -1): number {
  // TODO(market-policy)
  return 0;
}
