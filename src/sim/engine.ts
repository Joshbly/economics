// ============================================================================
// The daily sequence. See DESIGN.md §6. Each call is owned by one module; the
// order here is part of the contract (e.g. wages are paid before markets so
// households can spend today's income; consumption happens after markets).
// ============================================================================
import { GOODS, N_GOODS } from './goods';
import type { SimState } from './types';
import { isMonthStart } from './calendar';

import { openBooks, clearAll } from './market/markets';
import { policyBeginDay, playerOrders, playerAfterClear, playerBeforeSession, playerAfterSession } from './policy/player';
import { stockLevies, levyMonthRollover } from './policy/levies';
import { householdsBeginDay, householdOrders, householdPortfolioOrders, householdsConsume } from './agents/households';
import { laborMarket } from './agents/labor';
import { housingStep } from './agents/housing';
import { demographyStep } from './agents/demography';
import { firmsPlan, firmsProduce, firmsPayWages, firmOrders, firmsEndDay } from './agents/firms';
import { entryStep } from './agents/entry';
import { constructionPlan, constructionProgress, builderOrders } from './agents/construction';
import { tradersBeginDay, traderOrders, tradersDispatch } from './agents/traders';
import { foreignOrders, foreignEndDay } from './agents/foreign';
import { bankBeginDay, bankOrders, bankEndDay } from './agents/bank';
import { beginDayStats, statsStep } from './stats/stats';
import { beginDayEvents, eventsStep } from './stats/events';

export function stepDay(s: SimState): void {
  // --- morning ---
  beginDayStats(s); // reset daily accumulators (stats.acc, treasury.flows, per-agent scratch)
  if (isMonthStart(s.day)) levyMonthRollover(s);
  beginDayEvents(s); // random events, droughts, strikes countdown, world shocks
  policyBeginDay(s); // expire levies/limits/orders, Treasury workforce targets
  bankBeginDay(s); // rates, interest, amortisation, window
  tradersBeginDay(s); // arrivals, wagons return

  // --- work ---
  firmsPlan(s); // employment targets, wages, vacancies
  constructionPlan(s); // builders' workforce targets
  laborMarket(s); // layoffs, search, matching
  firmsProduce(s); // production, tool wear
  constructionProgress(s); // projects advance, completions
  firmsPayWages(s); // wages (+ wage levies)

  // --- market ---
  householdsBeginDay(s); // income EMA, expectations, budgets
  const books = openBooks(s);
  householdOrders(s, books);
  householdPortfolioOrders(s, books);
  firmOrders(s, books);
  builderOrders(s, books);
  traderOrders(s, books);
  foreignOrders(s, books);
  bankOrders(s, books);
  playerOrders(s, books);
  // three market sessions — opening, midday, close — with the Treasury's cargo landing, its
  // fills credited and its wagons leaving between them
  clearAll(s, books, { before: (k) => playerBeforeSession(s, books, k), after: (k) => playerAfterSession(s, k) });
  tradersDispatch(s, books);
  playerAfterClear(s, books);

  // --- evening ---
  householdsConsume(s);
  housingStep(s);
  firmsEndDay(s);
  bankEndDay(s);
  stockLevies(s);
  entryStep(s);
  demographyStep(s);
  foreignEndDay(s);
  spoilage(s);
  statsStep(s);
  eventsStep(s);

  s.day += 1;
}

/** Perishable goods decay wherever they are stored (including wagons). */
export function spoilage(s: SimState): void {
  const rates: number[] = [];
  let any = false;
  for (let g = 0; g < N_GOODS; g++) {
    rates.push(1 - GOODS[g].spoil);
    if (GOODS[g].spoil > 0) any = true;
  }
  if (!any) return;
  const acc = s.stats.acc;
  const decay = (inv: number[]) => {
    for (let g = 0; g < N_GOODS; g++) {
      const r = rates[g];
      if (r < 1 && inv[g] > 0) {
        const lost = inv[g] * (1 - r);
        inv[g] -= lost;
        acc['spoiled_' + g] = (acc['spoiled_' + g] || 0) + lost;
      }
    }
  };
  for (const p of s.people) if (p.alive) decay(p.pantry);
  for (const f of s.firms) {
    if (!f.alive) continue;
    decay(f.inv);
    if (f.trade) for (const st of f.trade.stock) decay(st);
  }
  for (const tg of s.treasury.goods) decay(tg);
  for (const sh of s.shipments) {
    const r = rates[sh.good];
    if (r < 1) sh.qty *= r;
  }
}

/** Run `n` days. */
export function runDays(s: SimState, n: number): void {
  for (let i = 0; i < n; i++) stepDay(s);
}
