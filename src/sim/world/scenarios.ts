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
  SCEN_GOLDEN_HEAD_ALL,
  SCEN_GOLDEN_HEAD_HUNGRY,
  SCEN_GOLDEN_PIERS,
  SCEN_GOLDEN_RESERVE_BUY,
  SCEN_GOLDEN_RESERVE_BUY_QTY,
  SCEN_GOLDEN_RESERVE_DAYS,
  SCEN_GOLDEN_RESERVE_SELL,
  SCEN_GOLDEN_RESERVE_SELL_QTY,
  SCEN_GOLDEN_ROOM,
  SCEN_GOLDEN_VACANCY,
  SCEN_WINTER_DROUGHT_DAYS,
  SCEN_WINTER_GRAIN_FACTOR,
  SCEN_WINTER_SHOCK_DAYS,
  STARTUP_LOAN_TERM,
} from '../config';
import { newLoan } from '../factory';
import { G, GOODS, N_GOODS, SECTORS } from '../goods';
import { firmRef, reconcileBank } from '../ledger';
import { dispatch } from '../policy/player';
import { invalidateRoutes } from '../runtime';
import { news } from '../stats/events';
import type { GoodId, LevyInput, SimState } from '../types';
import { fin } from '../util';
import { roadPlan } from './paths';

/** How the world is founded under a scenario (read by world/init.ts while it builds the realm). */
export interface ScenarioFounding {
  /** Spare homes at founding, as a share of the people (default INIT_HOUSING_VACANCY). */
  housingVacancy?: number;
  /** Every town-to-town road paved before the realm's prices are worked out (default false). */
  paved?: boolean;
  /** Workshops are built this many times roomier than usual (room to hire before they must enlarge; default 1). */
  room?: number;
  /** Piers already standing at the harbour (each lets more foreign ships call; default 0). */
  piers?: number;
}

export interface ScenarioDef {
  id: string;
  name: string;
  description: string;
  found?: ScenarioFounding;
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
    id: 'golden',
    name: 'A Golden Age',
    description:
      'Everything set up for a realm that thrives: paved roads between the towns, homes to spare for newcomers, roomy workshops and a busy harbour, with no droughts, fires or fevers in store. The Treasury starts with a month of grain, coal, oil and furniture in its stores (bought when cheap, sold when dear), pays a little coin to every household and more to anyone who goes hungry, and can always create the money it pays.',
    found: { housingVacancy: SCEN_GOLDEN_VACANCY, paved: true, room: SCEN_GOLDEN_ROOM, piers: SCEN_GOLDEN_PIERS },
  },
  {
    id: 'isolated',
    name: 'Closed Seas',
    description: 'No foreign ships call at the harbour. The realm must make everything it uses, and its gold cannot buy grain abroad.',
  },
];

/** Pave every town-to-town road (world init, before the realm's prices are worked out). */
export function paveTownRoads(s: SimState): void {
  for (let a = 0; a < s.towns.length; a++) {
    for (let b = a + 1; b < s.towns.length; b++) {
      let laid = 0;
      for (const i of roadPlan(s, a, b)) {
        if (s.map.occ[i] >= 0 || s.map.road[i] >= 2) continue;
        s.map.road[i] = 2;
        laid++;
      }
      if (laid > 0) invalidateRoutes(s);
    }
  }
}

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
    case 'golden': {
      s.settings.events = false; // no droughts, fires, fevers or storms (nor bumper seasons)
      news(s, 'Paved roads join every town, there are homes to spare for newcomers and the harbour has room for many ships.', 'good', -1);
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

/** Goods the 'golden' Treasury keeps a reserve of: storable, and what bread, ale, warmth, freight and furnished homes rest on. */
const GOLDEN_RESERVE: GoodId[] = [G.grain, G.coal, G.oil, G.furniture];

/**
 * When the player takes charge (after the warm-up and stats.rebaseStats; Game.create and the UI's foundRealm): the
 * standing arrangements a scenario starts the Treasury with. They are ordinary orders and rules, listed in force and
 * changed or cancelled like any other. The policy news of setting them up is folded into one item.
 */
export function startScenario(s: SimState): void {
  if (s.settings.scenario !== 'golden') return;
  const t = s.treasury;
  const before = new Set(s.news);
  t.autoMint = true;
  t.givesSuspended = false;
  for (const g of GOLDEN_RESERVE) {
    const name = GOODS[g].name;
    for (let town = 0; town < s.towns.length; town++) {
      const m = s.markets[town * N_GOODS + g];
      if (!m) continue;
      const trade = Math.max(1, fin(m.volEma));
      const p = m.ema > 0 ? m.ema : m.price;
      if (!(p > 0)) continue;
      t.goods[town][g] = Math.max(0, fin(t.goods[town][g])) + SCEN_GOLDEN_RESERVE_DAYS * trade; // the founding reserve
      const qty = (share: number) => Math.max(1, Math.round(trade * share));
      dispatch(s, { type: 'placeOrder', market: { kind: 'good', town, good: g }, side: 'buy', price: +(p * SCEN_GOLDEN_RESERVE_BUY).toFixed(2), qty: qty(SCEN_GOLDEN_RESERVE_BUY_QTY), label: `${name} reserve: buy when cheap` });
      dispatch(s, { type: 'placeOrder', market: { kind: 'good', town, good: g }, side: 'sell', price: +(p * SCEN_GOLDEN_RESERVE_SELL).toFixed(2), qty: qty(SCEN_GOLDEN_RESERVE_SELL_QTY), label: `${name} reserve: sell when dear` });
    }
  }
  const head = (label: string, group: LevyInput['group'], rate: number): void => {
    const levy: LevyInput = { label, enabled: true, dir: -1, base: 'head', unit: 'flat', rate, payer: 'receiver', threshold: 0, good: -1, town: -1, toTown: -1, sector: 'any', group, buildingKind: 'any', until: -1 };
    dispatch(s, { type: 'addLevy', levy });
  };
  head('Coin for every household', 'all', SCEN_GOLDEN_HEAD_ALL);
  head('Coin for the hungry', 'hungry', SCEN_GOLDEN_HEAD_HUNGRY);
  s.news = s.news.filter((n) => before.has(n));
  news(
    s,
    `The Treasury's stores hold a month of grain, coal, oil and furniture in every town: standing orders buy more when a good falls to ${Math.round(100 * SCEN_GOLDEN_RESERVE_BUY)} % of today's price and sell when it reaches ${Math.round(100 * SCEN_GOLDEN_RESERVE_SELL)} %. Every household receives ${SCEN_GOLDEN_HEAD_ALL} ¤ a day and anyone who went hungry ${SCEN_GOLDEN_HEAD_HUNGRY} ¤ a day; auto-mint is on, so the Purse never runs dry.`,
    'policy',
    -1,
  );
}
