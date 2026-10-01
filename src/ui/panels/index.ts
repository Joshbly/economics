// ============================================================================
// Sidebar panel registry. Tab order = array order.
//
// Each panel lives in its own file (levers.ts, works.ts, markets.ts, ledger.ts, charts.ts,
// people.ts, almanac.ts, inspector.ts). Keep the ids (they are TabIds used by setTab / keyboard shortcuts) and the
// order. See ../panel.ts for the contract and ../widgets/* for building blocks.
// ============================================================================
import type { Panel } from '../panel';
import type { TabId } from '../uiState';
import { leversPanel } from './levers';
import { worksPanel } from './works';
import { marketsPanel } from './markets';
import { ledgerPanel } from './ledger';
import { chartsPanel } from './charts';
import { peoplePanel } from './people';
import { almanacPanel } from './almanac';
import { inspectorPanel } from './inspector';

export const PANELS: Panel[] = [
  leversPanel,
  worksPanel,
  marketsPanel,
  ledgerPanel,
  chartsPanel,
  peoplePanel,
  almanacPanel,
  inspectorPanel,
];

/** Find a panel by tab id. */
export function panelById(id: TabId): Panel | undefined {
  return PANELS.find((p) => p.id === id);
}
