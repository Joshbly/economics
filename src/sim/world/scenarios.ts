// ============================================================================
// Scenario presets applied after world creation (before warm-up). OWNER: world agent.
// Each preset only changes state through documented fields (town drought days,
// world price shocks, bank stance, window rates, loans + matching deposits,
// foreign ship capacity) and keeps the bank's balance sheet reconciled.
// Wording is neutral: describe what is so, never name a policy.
// ============================================================================
import {
  BANK_BASE_SPREAD,
  SCEN_CREDIT_LEND_RATE,
  SCEN_CREDIT_LOAN_SHARE,
  SCEN_CREDIT_LOAN_TO_CAPITAL,
  SCEN_CREDIT_RESERVE_RATE,
  SCEN_WINTER_DROUGHT_DAYS,
  SCEN_WINTER_GRAIN_FACTOR,
  SCEN_WINTER_SHOCK_DAYS,
  STARTUP_LOAN_TERM,
} from '../config';
import { newLoan } from '../factory';
import { G, N_GOODS, SECTORS } from '../goods';
import { firmRef, reconcileBank } from '../ledger';
import { news } from '../stats/events';
import type { SimState } from '../types';

export interface ScenarioDef {
  id: string;
  name: string;
  description: string;
}

export const SCENARIOS: ScenarioDef[] = [
  { id: 'founding', name: 'A Quiet Founding', description: 'A balanced young realm. No levies, no limits, modest credit.' },
  {
    id: 'longwinter',
    name: 'The Long Winter',
    description: 'Drought has parched the fields of the farming town and grain is dear across the sea. Stores are thin and the harvest is months away.',
  },
  {
    id: 'creditboom',
    name: 'Easy Money',
    description: 'The bank lends freely and the Treasury window charges almost nothing. Most workshops start with fresh loans and full coffers.',
  },
  {
    id: 'isolated',
    name: 'Closed Seas',
    description: 'No foreign ships call at the harbour. The realm must make everything it uses, and its gold cannot buy grain abroad.',
  },
];

/** Look up a scenario (falls back to the founding preset). */
export function scenarioDef(id: string): ScenarioDef {
  return SCENARIOS.find((x) => x.id === id) ?? SCENARIOS[0];
}

/** Apply a scenario's modifications to a freshly created world (before warm-up). */
export function applyScenario(s: SimState, id: string): void {
  const def = scenarioDef(id);
  s.settings.scenario = def.id;
  switch (def.id) {
    case 'longwinter': {
      const farm = s.towns.find((t) => t.kind === 'farm');
      if (farm) farm.droughtDays = Math.max(farm.droughtDays, SCEN_WINTER_DROUGHT_DAYS);
      const until = s.day + SCEN_WINTER_SHOCK_DAYS;
      s.foreign.shocks = s.foreign.shocks.filter((k) => k.good !== G.grain);
      s.foreign.shocks.push({ good: G.grain, factor: SCEN_WINTER_GRAIN_FACTOR, until });
      if (s.foreign.world[G.grain] > 0) s.foreign.world[G.grain] *= SCEN_WINTER_GRAIN_FACTOR;
      news(s, `Drought grips the fields around ${farm ? farm.name : 'the farming town'}; grain abroad fetches ${Math.round((SCEN_WINTER_GRAIN_FACTOR - 1) * 100)}% more than usual.`, 'bad', farm ? farm.id : -1);
      break;
    }
    case 'creditboom': {
      s.treasury.reserveRate = SCEN_CREDIT_RESERVE_RATE;
      s.treasury.lendRate = SCEN_CREDIT_LEND_RATE;
      s.bank.stance = 0;
      s.bank.baseRate = SCEN_CREDIT_RESERVE_RATE + BANK_BASE_SPREAD;
      s.bank.depositRate = Math.max(0, SCEN_CREDIT_RESERVE_RATE - 0.01);
      // Fresh loans (on top of their mortgages) for most producing firms; the proceeds sit in their accounts (new money).
      const producers = s.firms.filter((f) => f && f.alive && SECTORS[f.sector].producer);
      const want = Math.round(producers.length * SCEN_CREDIT_LOAN_SHARE);
      let have = 0;
      for (const f of producers) {
        if (have >= want) break;
        const ref = firmRef(f.id);
        const b = s.buildings[f.building];
        let toolsValue = 0;
        const m = s.markets[f.town * N_GOODS + G.tools];
        if (m) toolsValue = f.tools * m.price;
        const capital = (b ? b.cost : 0) + toolsValue;
        const principal = Math.round(SCEN_CREDIT_LOAN_TO_CAPITAL * capital);
        if (!(principal > 0)) continue;
        const spread = 0.006;
        newLoan(s, ref, principal, spread, s.bank.baseRate + spread, STARTUP_LOAN_TERM, 'invest');
        f.cash += principal; // world-init endowment (the loan's deposit), reconciled below
        have++;
      }
      reconcileBank(s);
      news(s, 'Credit is cheap and plentiful: the Treasury window asks only ' + (SCEN_CREDIT_LEND_RATE * 100).toFixed(1) + '% a year.', 'info', -1);
      break;
    }
    case 'isolated': {
      for (let g = 0; g < N_GOODS; g++) {
        s.foreign.shipCap[g] = 0;
        s.foreign.world[g] = 0;
        s.foreign.world0[g] = 0;
      }
      news(s, 'No foreign ships are expected at the harbour this year or any other.', 'info', -1);
      break;
    }
    default:
      break;
  }
}
