// ============================================================================
// World creation & calibration: builds a SimState close to a steady state.
// OWNER: world agent. See DESIGN §1 and the calibration notes below.
//
// Algorithm:
//  1. generateMap(seed); create the 4 towns (names from names.ts), market halls,
//     the Palace (capital), the Bank building (capital), the Port (harbor).
//  2. Prices: production.basePrices(); rent0 = BASE_RENT_SHARE × BASE_WAGE.
//  3. Demand: demandModel.steadyStateDemand at base prices and income ≈
//     BASE_WAGE·(1−INIT_UNEMPLOYMENT)·(1 + profit share) per person → national
//     final demand; add intermediate demand through recipes (Leontief, iterate),
//     tool replacement (toolUse × workers), and a little construction/foreign use.
//  4. Firms per (sector, town): resource sectors in towns that have the terrain
//     (farm town/capital grassland farms; mining town coal, ore, lumber; harbor fish,
//     oil); processing: bakeries in every town sized to local bread demand, breweries
//     in capital & farm town, smelter + toolworks + furniture in the capital (a smelter
//     also in the mining town). Count = ceil(required workers / typicalSize); place via
//     layout.findSite/placeBuilding; firms.createFirm with level so capacity ≈ 1.3×need.
//     One builder, one trader (wagons sized to expected flows), one stateworks
//     (building -1) per town.
//  5. Houses: enough 4-slot houses for pop × (1 + INIT_HOUSING_VACANCY), owned by owners
//     (OWNER_SHARE of people) or a few by the Treasury? (no: all private). Assign homes.
//  6. Jobs: assign ~(1−INIT_UNEMPLOYMENT) of people to firms (same town first), wage BASE_WAGE.
//  7. Money: people cash ≈ lognormal(INIT_CASH_DAYS × income); owners extra; firms
//     INIT_FIRM_CASH_DAYS of costs; initial loans for INIT_LOAN_SHARE of firms; bank
//     reserves so that equity ≈ max(INIT_BANK_EQUITY_MIN, ratio × loans), then
//     ledger.reconcileBank; Treasury purse INIT_PURSE, gold INIT_TREASURY_GOLD,
//     rates INIT_RESERVE_RATE / INIT_LEND_RATE; foreign coin ≈ 30 days of port trade.
//  8. Inventories: firms 5 days of output & inputs, tools = toolsPerWorker × workers × 1.1;
//     people pantries 1–2 days; trader stock empty.
//  9. Markets: every MarketState with price/ema/gross/net = base price (towns that must
//     import a good start ~10 % higher); IOU market at IOU_PAR; gold at INIT_GOLD_PRICE.
// 10. Foreign: world prices w_g = base/INIT_GOLD_PRICE × factor in [0.85, 1.25]
//     (seeded; gives comparative advantage), shipCap, world0.
// 11. stats.initStats(s). Treasury flows empty. policy empty. news: founding message.
// ============================================================================
import type { SimState } from '../types';

export interface WorldOptions {
  seed: number;
  realmName?: string;
  scenario?: string;
}

export function createWorld(opts: WorldOptions): SimState {
  // TODO(world)
  return null as unknown as SimState;
}
