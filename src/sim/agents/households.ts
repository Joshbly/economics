// ============================================================================
// Households: budgets, bidding for consumer goods, portfolio (IOUs, gold),
// consumption, health, contentment. Uses the pure model in demandModel.ts.
// OWNER: households agent. See DESIGN §3.1.
// ============================================================================
import type { SimState } from '../types';
import type { Books } from '../market/markets';

/**
 * Before markets (after wages are paid):
 *  - income EMA from yesterday's person.earned (INCOME_EMA); lastWage tracking;
 *  - expected inflation EMA toward stats.latest.inflation30 (INFL_EXP_EMA);
 *  - today's goods budget via demandModel.bufferTarget / goodsBudget, stored in person.budget
 *    (rent = their slot's rent if housed);
 *  - reset person.spent / person.earned scratch AFTER using earned.
 */
export function householdsBeginDay(s: SimState): void {
  // TODO(households)
}

/**
 * For each living person: demandModel.planDemand with expected GROSS prices of
 * their home town (markets.expectedGross), then demandModel.bidLadder per consumer
 * good with config ELASTICITY, adding bids to the home-town books.
 */
export function householdOrders(s: SimState, books: Books): void {
  // TODO(households)
}

/**
 * Savers with cash > PORTFOLIO_SURPLUS_MULT × buffer: bid for IOUs when
 * yield (IOU_COUPON / price) > deposit rate + IOU_MARGIN; bid for gold when
 * expected inflation − deposit rate > GOLD_HEDGE_TRIGGER. People short of
 * liquidity (cash < buffer/2) offer IOUs / gold for sale slightly below market.
 */
export function householdPortfolioOrders(s: SimState, books: Books): void {
  // TODO(households)
}

/**
 * After markets: eat bread/fish from the pantry (up to the planned food, max FOOD_MAX),
 * burn coal for heat, drink ale, furniture wears (FURNITURE_WEAR_DAY);
 * set foodSat/heatSat; update health (HEALTH_EMA) and contentment (CONTENT_EMA)
 * from food, heat, housing, employment, comfort (furniture stock), joy (ale),
 * and inflation pain; accumulate stats: acc.hungry, acc.eaten_<good>, acc.cold.
 */
export function householdsConsume(s: SimState): void {
  // TODO(households)
}
