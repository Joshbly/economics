// ============================================================================
// Treasury supply routes (PlayerOrder.route): buy in one town → carry → offer in
// another. Shared bookkeeping: traders.ts calls routeArrived when a tagged cargo
// lands; player.ts places the orders, ships each day's purchases and credits the
// sales. OWNER: market-policy agent. See DESIGN §5 (Trade).
//
// Nothing here is a shortcut: the purchase clears in the origin's auction like any
// Treasury bid, freight is paid from the Purse to the origin's trading house
// (traders.sendTreasuryCargo, TREASURY_FREIGHT_PREMIUM, its free wagons and fuel),
// the goods ride real wagons (Shipment.order = the order id) and spoil on the way
// like any cargo, and they are sold through the destination's auction as an exempt
// Treasury ask whose floor follows the route's selling rule.
//
// Where a route's units are at any moment:
//   held at the origin (bought, not yet loaded) = min(order.filled − route.shippedTotal,
//       the Treasury's holdings of the good there). It is the difference, not a stored
//       field: it is shipped as soon as the freight can be paid (retried every day).
//       Caveat of keeping it as a difference: units that spoil while held keep the
//       difference positive, so a later purchase of the same good in that town by
//       another Treasury order may be carried by the route (up to that amount).
//   on the road = route.inTransit (Σ qty of the Treasury shipments tagged with the order;
//       resynced after arrivals, decayed by spoilage with the cargo);
//   at the destination, unsold = route.waiting (never more than the Treasury holds there;
//       decayed by spoilage with the store). route.landed is its average landed cost.
// ============================================================================
import { GOODS, N_GOODS } from '../goods';
import { STATE } from '../types';
import type { OrderRoute, PlayerOrder, Shipment, SimState } from '../types';
import { ROUTE_FULL_SHARE, ROUTE_MARKET_FLOOR_SHARE, ROUTE_MAX_HOLD_DAYS, ROUTE_SPOIL_BUDGET, WAGON_CAPACITY } from '../config';

/**
 * Days a route's purchases may wait at the origin for a fuller wagon: until waiting longer would
 * cost the good more than ROUTE_SPOIL_BUDGET to spoilage (bread 2, ale 3), at most ROUTE_MAX_HOLD_DAYS.
 */
export function routeHoldDays(good: number): number {
  const sp = GOODS[good]?.spoil ?? 0;
  if (!(sp > 0)) return ROUTE_MAX_HOLD_DAYS;
  const d = Math.floor(Math.log(1 - ROUTE_SPOIL_BUDGET) / Math.log(1 - sp) + 1e-9);
  return Math.max(1, Math.min(ROUTE_MAX_HOLD_DAYS, d));
}

/**
 * How much of what a route holds at its origin leaves today ('full' routes: whole wagons at least
 * ROUTE_FULL_SHARE full, or everything once it has waited routeHoldDays or a freight line has room;
 * 'daily' routes, and routes whose buying is over: everything). 0 = keep collecting.
 */
export function routeLoadToday(held: number, dispatch: 'full' | 'daily', buying: boolean, age: number, good: number, lineRoom: number): number {
  if (!(held > 1e-6)) return 0;
  if (dispatch === 'daily' || !buying) return held;
  if (lineRoom > 0.5 || age >= routeHoldDays(good)) return held;
  const perWagon = ROUTE_FULL_SHARE * WAGON_CAPACITY;
  if (held < perWagon - 1e-6) return 0;
  // whole wagons only: the last one at least ROUTE_FULL_SHARE full
  const wagons = Math.floor(held / WAGON_CAPACITY);
  const rest = held - wagons * WAGON_CAPACITY;
  return rest >= perWagon - 1e-6 ? held : Math.max(perWagon, wagons * WAGON_CAPACITY);
}

/** A fresh route record (all counters zero). */
export function newRoute(to: number, sell: OrderRoute['sell'], sellPrice: number, sellMargin: number): OrderRoute {
  return {
    to,
    sell,
    sellPrice: sell === 'fixed' ? sellPrice : 0,
    sellMargin: sell === 'cost' ? sellMargin : 0,
    inTransit: 0,
    waiting: 0,
    landed: 0,
    shippedToday: 0,
    soldToday: 0,
    shippedTotal: 0,
    soldTotal: 0,
    freightPaid: 0,
    revenue: 0,
  };
}

/** The player order with this id, or undefined. */
export function orderById(s: SimState, id: number): PlayerOrder | undefined {
  const os = s.policy.orders;
  for (let i = 0; i < os.length; i++) if (os[i].id === id) return os[i];
  return undefined;
}

/** A route order on a goods market (the only kind that can carry a route). */
export function isRouteOrder(o: PlayerOrder): o is PlayerOrder & { route: OrderRoute; market: { kind: 'good'; town: number; good: number } } {
  return !!o.route && o.market.kind === 'good';
}

/** Units the route bought that still wait at the origin for freight (see the header). */
export function heldAtOrigin(s: SimState, o: PlayerOrder): number {
  if (!isRouteOrder(o)) return 0;
  const owed = o.filled - o.route.shippedTotal;
  if (!(owed > 1e-9)) return 0;
  const have = s.treasury.goods[o.market.town]?.[o.market.good] ?? 0;
  return Math.max(0, Math.min(owed, have));
}

/** Is the route still carrying or selling anything (held at the origin, on the road, waiting at the destination)? */
export function routeBusy(s: SimState, o: PlayerOrder): boolean {
  if (!isRouteOrder(o)) return false;
  return o.route.inTransit > 1e-6 || o.route.waiting > 1e-6 || heldAtOrigin(s, o) > 1e-6;
}

/**
 * Floor (base ¤ per unit, the Treasury's asks are exempt) at which a route offers its
 * waiting goods: 'fixed' → sellPrice; 'cost' → landed cost × (1 + sellMargin); 'market' →
 * a token ROUTE_MARKET_FLOOR_SHARE of the destination's reference price, so the auction sets it.
 */
export function routeFloor(s: SimState, o: PlayerOrder): number {
  if (!isRouteOrder(o)) return 0;
  const r = o.route;
  if (r.sell === 'fixed') return Math.max(0, r.sellPrice);
  if (r.sell === 'cost') return Math.max(0, r.landed * (1 + r.sellMargin));
  return marketFloor(s, r.to, o.market.good);
}

/** The token floor of a "whatever it fetches" sale in a market. */
export function marketFloor(s: SimState, town: number, good: number): number {
  const m = s.markets[town * N_GOODS + good];
  const ref = m ? (m.ema > 0 && Number.isFinite(m.ema) ? m.ema : m.price) : 0;
  return ref > 0 && Number.isFinite(ref) ? ROUTE_MARKET_FLOOR_SHARE * ref : 0;
}

/**
 * A Treasury cargo has landed (traders.tradersBeginDay → deliver, after the goods were added
 * to treasury.goods[to]): if it belongs to a route that still exists and ends here, its units
 * join the route's waiting stock at their landed cost (weighted average).
 */
export function routeArrived(s: SimState, sh: Shipment): void {
  if (!(sh.order >= 0) || sh.owner !== STATE) return;
  const o = orderById(s, sh.order);
  if (!o || !isRouteOrder(o) || o.route.to !== sh.to || o.market.good !== sh.good) return;
  const r = o.route;
  const q = Math.max(0, sh.qty);
  if (!(q > 0)) return;
  const w0 = Math.max(0, r.waiting);
  const basis = Number.isFinite(sh.basis) ? Math.max(0, sh.basis) : r.landed;
  r.landed = (r.landed * w0 + basis * q) / (w0 + q);
  r.waiting = w0 + q;
  r.inTransit = Math.max(0, r.inTransit - q);
}

/** Recount every route's units on the road from the shipments tagged with it (after arrivals). */
export function syncRouteTransit(s: SimState): void {
  const os = s.policy.orders;
  let any = false;
  for (let i = 0; i < os.length; i++) if (os[i].route) any = true;
  if (!any) return;
  const sum: Record<number, number> = {};
  for (const sh of s.shipments) if (sh.owner === STATE && sh.order >= 0) sum[sh.order] = (sum[sh.order] || 0) + Math.max(0, sh.qty);
  for (const o of os) if (o.route) o.route.inTransit = sum[o.id] || 0;
}

/** Spoilage (engine.spoilage): a route's goods on the road and in store decay like the cargo and the store they sit in. */
export function spoilRoutes(s: SimState): void {
  for (const o of s.policy.orders) {
    if (!isRouteOrder(o)) continue;
    const sp = GOODS[o.market.good]?.spoil ?? 0;
    if (!(sp > 0)) continue;
    const r = o.route;
    if (r.waiting > 0) r.waiting *= 1 - sp;
    if (r.inTransit > 0) r.inTransit *= 1 - sp;
  }
}
