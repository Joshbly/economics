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
  | 'action'; // an action was dispatched (payload: ActionResult)

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
