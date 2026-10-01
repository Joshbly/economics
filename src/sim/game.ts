// ============================================================================
// Game facade used by the UI and scripts. Thin: all logic lives in modules.
// ============================================================================
import { WARMUP_DAYS } from './config';
import { stepDay } from './engine';
import { dispatch as applyAction } from './policy/player';
import { deserialize, serialize } from './save';
import { rebaseStats } from './stats/stats';
import type { ActionResult, PlayerAction, SimState } from './types';
import { createWorld, type WorldOptions } from './world/init';
import { startScenario } from './world/scenarios';

export interface NewGameOptions extends Partial<WorldOptions> {
  /** Simulate WARMUP_DAYS silently first (default true). */
  warmup?: boolean;
  /** Progress callback during warm-up (0..1). */
  onProgress?: (f: number) => void;
}

export class Game {
  s: SimState;

  constructor(s: SimState) {
    this.s = s;
  }

  static create(opts: NewGameOptions = {}): Game {
    const seed = opts.seed ?? 1;
    const s = createWorld({ seed, realmName: opts.realmName, scenario: opts.scenario });
    const g = new Game(s);
    if (opts.warmup !== false) {
      for (let i = 0; i < WARMUP_DAYS; i++) {
        stepDay(s);
        if (opts.onProgress && i % 30 === 0) opts.onProgress(i / WARMUP_DAYS);
      }
      rebaseStats(s);
    }
    startScenario(s);
    return g;
  }

  /** Advance `n` days. */
  step(n = 1): void {
    for (let i = 0; i < n; i++) stepDay(this.s);
  }

  dispatch(a: PlayerAction): ActionResult {
    try {
      return applyAction(this.s, a);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  save(): string {
    return serialize(this.s);
  }

  static load(json: string): Game {
    return new Game(deserialize(json));
  }
}
