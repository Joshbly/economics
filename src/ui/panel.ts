// Panel contract: every right-hand tab is a Panel. The app shell mounts it once
// into its container and calls update() ~4×/s while the tab is visible (and on
// 'day' events). Panels read ui.game.s (read-only) and dispatch actions via
// ui.game.dispatch(...), then emit('action', result) and toast() on failure.
import type { TabId } from './uiState';

export interface Panel {
  id: TabId;
  title: string;
  /** Build DOM once. */
  mount(el: HTMLElement): void;
  /** Refresh displayed values (cheap; avoid rebuilding inputs the user is typing in). */
  update(): void;
  /** Optional: called when the tab becomes visible. */
  show?(): void;
}
