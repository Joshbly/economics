// Scenario presets applied after world creation. OWNER: world agent.
import type { SimState } from '../types';

export interface ScenarioDef {
  id: string;
  name: string;
  description: string;
}

export const SCENARIOS: ScenarioDef[] = [
  { id: 'founding', name: 'A Quiet Founding', description: 'A balanced young realm. No levies, no limits, modest credit.' },
];

/** Apply a scenario's modifications to a freshly created world (before warm-up). */
export function applyScenario(s: SimState, id: string): void {
  // TODO(world)
}
