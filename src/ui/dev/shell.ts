// ============================================================================
// DEV ONLY: the full app shell around a synthetic (non-simulating) state, so
// the layout, top bar, tabs, ticker and dialogs can be reviewed before the
// simulation is complete. Built by scripts/gallery.mjs into dist/shell.html.
//   dist/shell.html          the shell
//   dist/shell.html#error    the error screen
// window.__ui exposes the UI state helpers for scripted checks.
// ============================================================================
import '../styles.css';
import { Game } from '../../sim/game';
import { mountShell, showErrorScreen } from '../app';
import { initToasts } from '../modal';
import { select, setTab, toast, ui } from '../uiState';
import { fakeState } from './fake';

initToasts();
const root = document.getElementById('app')!;
if (location.hash === '#error') {
  const e = new TypeError("Cannot read properties of undefined (reading 'inv')");
  e.stack = `TypeError: Cannot read properties of undefined (reading 'inv')\n    at firmsProduce (src/sim/agents/firms.ts:212:31)\n    at stepDay (src/sim/engine.ts:38:3)\n    at foundRealm (src/ui/app.ts:190:7)`;
  showErrorScreen(root, e);
} else {
  mountShell(root, new Game(fakeState()), 'preview');
}
(window as unknown as Record<string, unknown>).__ui = { get ui() { return ui; }, select, setTab, toast };
