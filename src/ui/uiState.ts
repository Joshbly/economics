// ============================================================================
// Shared UI state + a tiny event bus. The contract between the app shell, the
// map renderer and the panels. Never put sim state here — the sim lives in
// `game.s` and is read directly (read-only!); mutations go through
// `game.dispatch(action)`.
// ============================================================================
import type { Game } from '../sim/game';

export type Selection =
  | { kind: 'building'; id: number }
  | { kind: 'person'; id: number }
  | { kind: 'firm'; id: number }
  | { kind: 'town'; id: number }
  | { kind: 'market'; town: number; good: number }
  | null;

export type TabId = 'levers' | 'markets' | 'ledger' | 'charts' | 'people' | 'almanac' | 'inspect';

export type OverlayId = 'none' | 'price' | 'unemployment' | 'wealth' | 'health' | 'rent';

/** Placement mode when the player is choosing a site on the map for a Build. */
export interface Placing {
  kind: 'house' | 'firm' | 'pier';
  sector?: string;
  town?: number;
}

export interface UiState {
  game: Game;
  /** 0 = paused, 1..5 speed levels (see SPEEDS). */
  speed: number;
  /** Fraction of the current day elapsed (0..1) — drives animation (commutes, carts). */
  dayFrac: number;
  selection: Selection;
  tab: TabId;
  overlay: OverlayId;
  overlayGood: number;
  placing: Placing | null;
  showPeople: boolean;
  showCarts: boolean;
  /** Market the Markets panel is focused on. */
  marketTown: number;
  marketGood: number;
}

/** Days per real second for each speed level. */
export const SPEEDS = [0, 0.25, 1, 4, 12, 40];

export type UiEvent =
  | 'select' // selection changed
  | 'tab' // tab changed
  | 'day' // one or more sim days completed (payload: number of days)
  | 'frame' // animation frame
  | 'speed'
  | 'overlay'
  | 'placing'
  | 'toast' // payload: { text, kind }
  | 'newgame' // game replaced (load / new realm)
  | 'action' // an action was dispatched (payload: ActionResult)
  | 'center' // ask the map to pan to a tile (payload: { x, y, zoom? })
  | 'prefill'; // ask the Levers panel to open a form prefilled (payload: PrefillRequest)

/** Request from another panel to open a Levers form prefilled (e.g. "Trade here" from Markets). */
export type PrefillRequest =
  | { lever: 'trade'; market: import('../sim/types').OrderMarket; side?: 'buy' | 'sell'; price?: number }
  | { lever: 'levy'; base?: import('../sim/types').LevyBase; good?: number; town?: number }
  | { lever: 'limit'; kind?: import('../sim/types').LimitKind; good?: number; town?: number }
  | { lever: 'build'; kind?: 'road' | 'house' | 'firm' | 'pier'; town?: number; sector?: string };

/** Ask the map to centre on a tile. */
export function centerMap(x: number, y: number, zoom?: number): void {
  emit('center', { x, y, zoom });
}

/** Open the Levers tab with a prefilled form. */
export function prefill(req: PrefillRequest): void {
  ui.tab = 'levers';
  emit('tab', 'levers');
  emit('prefill', req);
}

type Handler = (payload?: unknown) => void;
const handlers = new Map<UiEvent, Set<Handler>>();

export function on(ev: UiEvent, fn: Handler): () => void {
  let set = handlers.get(ev);
  if (!set) handlers.set(ev, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

export function emit(ev: UiEvent, payload?: unknown): void {
  const set = handlers.get(ev);
  if (set) for (const fn of [...set]) fn(payload);
}

export let ui: UiState = null as unknown as UiState;

export function initUi(game: Game): UiState {
  ui = {
    game,
    speed: 0,
    dayFrac: 0.3,
    selection: null,
    tab: 'levers',
    overlay: 'none',
    overlayGood: 8,
    placing: null,
    showPeople: true,
    showCarts: true,
    marketTown: 0,
    marketGood: 8,
  };
  return ui;
}

export function select(sel: Selection): void {
  ui.selection = sel;
  emit('select', sel);
}

export function setTab(tab: TabId): void {
  ui.tab = tab;
  emit('tab', tab);
}

export function toast(text: string, kind: 'info' | 'good' | 'bad' = 'info'): void {
  emit('toast', { text, kind });
}

// ---------------------------------------------------------------------------
// Convenience helpers (added by ui-foundation). Additive: the exports above are
// the original contract.
// ---------------------------------------------------------------------------
import type { ActionResult, PlayerAction } from '../sim/types';

/**
 * Dispatch a player action the standard way: game.dispatch → emit('action') →
 * toast the message on failure (and on success when `announce` is true).
 * Returns the result so callers can read `id` / `message`.
 */
export function act(a: PlayerAction, announce = false): ActionResult {
  let r: ActionResult;
  try {
    r = ui.game.dispatch(a);
  } catch (e) {
    r = { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  emit('action', r);
  if (!r.ok) toast(r.message || 'That could not be done.', 'bad');
  else if (announce && r.message) toast(r.message, 'good');
  return r;
}

/** Last non-zero speed, restored by togglePause(). */
let lastSpeed = 2;

/** Set the sim speed (0 = paused, 1..SPEEDS.length-1). */
export function setSpeed(n: number): void {
  const v = Math.max(0, Math.min(SPEEDS.length - 1, Math.round(n)));
  if (v > 0) lastSpeed = v;
  if (ui.speed === v) return;
  ui.speed = v;
  emit('speed', v);
}

/** Pause, or resume at the last speed. */
export function togglePause(): void {
  setSpeed(ui.speed > 0 ? 0 : lastSpeed);
}

/** Enter / leave map placement mode. */
export function setPlacing(p: Placing | null): void {
  ui.placing = p;
  emit('placing', p);
}

/** Change the map overlay (and optionally the good it shows). */
export function setOverlay(overlay: OverlayId, good?: number): void {
  ui.overlay = overlay;
  if (good !== undefined) ui.overlayGood = good;
  emit('overlay', overlay);
}

/** Focus the Markets tab on one market. */
export function focusMarket(town: number, good: number): void {
  ui.marketTown = town;
  ui.marketGood = good;
  setTab('markets');
}
