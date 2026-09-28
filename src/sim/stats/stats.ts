// ============================================================================
// Statistics: indicators, daily & monthly series, national accounts, CPI.
// OWNER: stats agent. See DESIGN §7.
//
// Series keys (daily and monthly) — the UI depends on these names:
//   cpi, infl30 (annualised 30-day CPI change), inflYoY, cpi_<town>,
//   price_<good> (national volume-weighted base price), gross_<good>,
//   gdpReal, gdpNominal, cons (household goods spending ¤), inv (tools + construction ¤),
//   gov (Treasury purchases + stateworks wages + Treasury construction ¤), netExports,
//   unemp (rate), employed, vacancies, wage (avg posted), realWage, pop, births, deaths,
//   immigrants, emigrants, hunger (share hungry), homeless, health, content,
//   money (Σ deposits), reserves, credit (loans), bankEquity, capRatio, loanRate, depRate,
//   iouPrice, iouYield, iouOut, goldPrice, purse, minted, levyTake, levyGive, levyNet,
//   treasurySpend, freight (shipping rate: ¤ per unit per 10 tiles), tradeBal,
//   imports, exports, prod_<good>, cons_<good>, firms, bankrupt, gini (monthly),
//   giniIncome (monthly), top10 (monthly), rent, output_<sector>? (optional)
// stats.latest mirrors the newest value of every daily key plus convenience keys.
// ============================================================================
import type { SimState } from '../types';

/** Reset stats.acc and daily scratch fields (person.spent/earned are reset by households). */
export function beginDayStats(s: SimState): void {
  // TODO(stats): stats.acc = {}; treasury.flows = {}; bank.approved/rejected/interestIn/Out = 0;
  //   firm.revenue/spent/wageBill/otherCosts/producedToday/soldToday/hired/fired = 0;
  //   foreign import/export counters = 0; policy order filledToday = 0; levy.today = 0.
}

/** Compute today's indicators, push to daily series; on month end push monthly series. Updates town derived fields. */
export function statsStep(s: SimState): void {
  // TODO(stats)
}

/**
 * Initialise stats at world creation: CPI basket from steady-state household demand
 * (demandModel.steadyStateDemand at base prices) + rent weight, base prices, base wage,
 * base rent, base freight. Empty series.
 */
export function initStats(s: SimState): void {
  // TODO(stats)
}

/** After warm-up: re-base CPI (=100) to current prices, clear series, s.startDay = s.day. */
export function rebaseStats(s: SimState): void {
  // TODO(stats)
}

/** Read a series ('daily' or 'monthly'); returns [] if missing. */
export function series(s: SimState, key: string, freq: 'daily' | 'monthly' = 'daily'): number[] {
  return (freq === 'daily' ? s.stats.daily[key] : s.stats.monthly[key]) ?? [];
}

/** Latest value of an indicator (0 if missing). */
export function latest(s: SimState, key: string): number {
  return s.stats.latest[key] ?? 0;
}
