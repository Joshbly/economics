// ============================================================================
// The game loop (requestAnimationFrame).
//
// Every frame:
//   1. advance ui.dayFrac by SPEEDS[ui.speed] × dt (dt capped at 0.25 s so a
//      background tab does not come back to a burst of simulation);
//   2. each time it wraps past 1, run one stepDay — at high speed several per
//      frame, but never more than STEP_BUDGET_MS of simulation per frame (the
//      backlog is dropped rather than accumulated, so the sim degrades to
//      "slower than asked" instead of freezing the page);
//   3. emit('day', n) once if n > 0 days ran, then emit('frame', dt);
//   4. mapView.frame(dt).
// A stepDay that throws pauses the game and raises a toast (the error is kept
// in loop.lastError); a map renderer that throws is disabled with a notice so
// the rest of the game keeps working.
// ============================================================================
import { stepDay } from '../sim/engine';
import type { MapView } from './map/renderer';
import { emit, setSpeed, SPEEDS, toast, ui } from './uiState';

/** Most simulation time spent per animation frame (ms). */
export const STEP_BUDGET_MS = 10;
/** Longest frame delta honoured (s). */
export const MAX_DT = 0.25;

export interface AdvanceResult {
  days: number;
  dayFrac: number;
  error: unknown;
  /** True when the time budget ran out and the backlog was dropped. */
  dropped: boolean;
}

/**
 * Pure clock advance (unit-tested): moves `dayFrac` forward by `daysPerSec × dt`
 * and calls `step()` once per whole day crossed, until `budgetMs` of wall time
 * (measured by `now()`) is spent. Remaining whole days are dropped; the
 * fractional part is kept so animations stay continuous.
 */
export function advanceClock(dayFrac: number, daysPerSec: number, dt: number, step: () => void, budgetMs: number, now: () => number): AdvanceResult {
  const out: AdvanceResult = { days: 0, dayFrac, error: null, dropped: false };
  if (!(daysPerSec > 0) || !(dt > 0)) return out;
  let f = (Number.isFinite(dayFrac) ? dayFrac : 0) + daysPerSec * Math.min(dt, MAX_DT);
  const t0 = now();
  while (f >= 1) {
    try {
      step();
    } catch (e) {
      out.error = e;
      f = f % 1;
      break;
    }
    f -= 1;
    out.days++;
    if (f >= 1 && now() - t0 >= budgetMs) {
      out.dropped = true;
      f = f % 1;
      break;
    }
  }
  out.dayFrac = f;
  return out;
}

export interface LoopPerf {
  /** Smoothed ms per stepDay. */
  stepMs: number;
  /** Smoothed frames per second. */
  fps: number;
  /** Smoothed simulated days per real second. */
  daysPerSec: number;
}

export interface GameLoop {
  start(): void;
  stop(): void;
  readonly running: boolean;
  setMapView(mv: MapView | null): void;
  readonly perf: LoopPerf;
  /** Last error thrown by stepDay (null if none since start). */
  readonly lastError: unknown;
}

export function createLoop(opts: { onMapError?: (e: unknown) => void } = {}): GameLoop {
  let raf = 0;
  let last = 0;
  let running = false;
  let mapView: MapView | null = null;
  let mapBroken = false;
  let lastError: unknown = null;
  const perf: LoopPerf = { stepMs: 0, fps: 60, daysPerSec: 0 };

  const timedStep = () => {
    const t0 = performance.now();
    stepDay(ui.game.s);
    const ms = performance.now() - t0;
    perf.stepMs = perf.stepMs ? perf.stepMs * 0.95 + ms * 0.05 : ms;
  };

  function frame(t: number): void {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(MAX_DT, Math.max(0, (t - last) / 1000)) : 0;
    last = t;
    if (dt > 0) perf.fps = perf.fps * 0.95 + (1 / dt) * 0.05;

    let days = 0;
    const speed = SPEEDS[ui.speed] ?? 0;
    if (speed > 0 && ui.game?.s) {
      const r = advanceClock(ui.dayFrac, speed, dt, timedStep, STEP_BUDGET_MS, () => performance.now());
      ui.dayFrac = r.dayFrac;
      days = r.days;
      if (r.error) {
        lastError = r.error;
        console.error('[sim] stepDay failed', r.error);
        setSpeed(0);
        const msg = r.error instanceof Error ? r.error.message : String(r.error);
        toast(`The simulation stumbled on ${ui.game.s ? 'day ' + ui.game.s.day : 'a day'} and was paused: ${msg}`, 'bad');
      }
    }
    perf.daysPerSec = dt > 0 ? perf.daysPerSec * 0.9 + (days / dt) * 0.1 : perf.daysPerSec;
    if (days > 0) emit('day', days);
    emit('frame', dt);
    if (mapView && !mapBroken) {
      try {
        mapView.frame(dt);
      } catch (e) {
        mapBroken = true;
        console.error('[map] frame failed; map rendering disabled', e);
        opts.onMapError?.(e);
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    get running() {
      return running;
    },
    setMapView(mv) {
      mapView = mv;
      mapBroken = false;
    },
    perf,
    get lastError() {
      return lastError;
    },
  };
}
