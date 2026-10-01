// ============================================================================
// An investor's temperament (a person, or a firm): drawn from the realm's seed and
// who they are, so it never changes and needs no record. See agents/invest.ts.
// ============================================================================
import type { Ref, SimState } from '../types';
import { hash2 } from '../world/mapgen';

export interface Temperament {
  /** Years ahead they look (3 … 15). */
  horizon: number;
  /** What they ask over the bank's rate (0 … 8 points). */
  premium: number;
  /** How rosy they see a firm's profit (−20 % … +20 %). */
  optimism: number;
  /** Share of their spare cash they will risk (0.3 … 0.9). */
  nerve: number;
}

/** A temperament of their own, drawn from the realm's seed and who they are. */
export function temperament(s: SimState, ref: Ref): Temperament {
  const u = (k: number) => hash2(s.seed ^ 0x7e3a1b, ref, k);
  return {
    horizon: 3 + 12 * u(1),
    premium: 0.08 * u(2),
    optimism: 0.4 * (u(3) - 0.5),
    nerve: 0.3 + 0.6 * u(4),
  };
}
