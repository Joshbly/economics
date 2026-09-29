// ============================================================================
// First-run welcome: the premise, the seven primitives, the controls and a
// pointer to the Almanac. Shown once per browser (remembered in localStorage),
// reopened from the realm menu ("Welcome & controls").
// ============================================================================
import { h } from './dom';
import { openModal, type ModalHandle } from './modal';
import { glyph } from './panels/levers/glyphs';
import { setTab, ui } from './uiState';

export const WELCOMED_KEY = 'realmLedger.welcomed';

function welcomed(): boolean {
  try {
    return !!localStorage.getItem(WELCOMED_KEY);
  } catch {
    return true; // storage blocked: do not nag on every visit
  }
}

function remember(): void {
  try {
    localStorage.setItem(WELCOMED_KEY, String(Date.now()));
  } catch {
    /* storage unavailable */
  }
}

const PRIMITIVES: [string, string, string][] = [
  ['mint', 'Mint', 'Create money in the Purse, or destroy it.'],
  ['trade', 'Trade', 'Buy or sell goods, labour, IOUs or gold in any market; move goods between towns.'],
  ['levy', 'Levy', 'A rate on any flow — sales, wages, rents, money held… Positive, you take; negative, you pay.'],
  ['limit', 'Limit', 'Legal bounds on prices, pay, rents, the Bank, the port and the roads.'],
  ['window', 'Window', 'What the Bank’s reserves earn with you, and what it pays to borrow from you.'],
  ['build', 'Build', 'Roads, houses, workshops of any trade, piers.'],
  ['transfer', 'Transfer', 'A one-off sum handed to a group, or taken from it.'],
];

const kbd = (k: string) => h('kbd', null, k);
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** [keys, what they do] — built when the dialog opens (module load must stay DOM-free). */
const keys = (): [(string | HTMLElement)[], string][] => [
  [[kbd('Space')], 'Start or pause the clock (a new realm waits, paused)'],
  [[kbd('1'), '–', kbd('5')], 'Speed: ¼ to 40 days a second; 0 pauses'],
  [['Drag · scroll'], 'Pan the map (two fingers on a trackpad)'],
  [['Pinch · ', kbd('+'), kbd('−')], 'Zoom in and out'],
  [['Click'], 'Inspect a house, workshop, person, town or market hall'],
  [[kbd('Esc')], 'Close, cancel or deselect'],
  [[kbd('['), kbd(']')], 'Previous / next tab'],
  [[kbd(MAC ? '⌘S' : 'Ctrl+S')], 'Save (it also autosaves monthly)'],
];

let open: ModalHandle | null = null;

/** Open the welcome dialog. `onClose` runs once it is dismissed. */
export function showWelcome(onClose?: () => void): void {
  if (open) return;
  const realm = ui?.game?.s?.settings?.realmName || 'the realm';
  const body = h(
    'div',
    { class: 'welcome' },
    h(
      'p',
      { class: 'welcome-lead' },
      'You are the Treasury of ',
      h('b', null, realm),
      ' — its mint, its bank of last resort and its purse in one. Hundreds of households, their farms and workshops, the traders on the roads and a single bank run the realm by themselves: each decides what to buy, where to work, what to charge and whom to lend to. You cannot order any of them about.',
    ),
    h('div', { class: 'welcome-h' }, 'You act through seven primitives'),
    h(
      'ul',
      { class: 'welcome-prims' },
      PRIMITIVES.map(([id, name, what]) => h('li', null, h('span', { class: 'welcome-glyph' }, glyph(id, 16)), h('span', null, h('b', null, name), ' — ', what))),
    ),
    h(
      'p',
      { class: 'welcome-note' },
      h('b', null, 'Nothing is labelled.'),
      ' There are no ready-made programmes here, only the primitives. What they add up to — and how the realm answers — is yours to find out. Try something, watch the markets, the Ledger and the people, and adjust.',
    ),
    h('div', { class: 'welcome-h' }, 'Controls'),
    h(
      'div',
      { class: 'welcome-keys' },
      keys().map(([k, what]) => h('div', { class: 'welcome-key' }, h('span', { class: 'welcome-k' }, ...k), h('span', { class: 'welcome-kd' }, what))),
    ),
    h('p', { class: 'welcome-note' }, 'The ', h('b', null, 'Almanac'), ' tab (or ', kbd('?'), ') explains how the realm works — markets, work, people, money and the Bank, shipping, and how to read the ledgers. This note can be reopened from the menu ', h('span', { class: 'welcome-menu' }, '☰'), ' at the top right.'),
  );
  open = openModal({
    title: 'Welcome to the Treasury',
    subtitle: 'Realm Ledger — a realm that runs itself, and a Treasury that can nudge it',
    body,
    width: 680,
    className: 'welcome-modal',
    actions: [
      { label: 'Open the Almanac', kind: 'ghost', onClick: () => void setTab('almanac') },
      { label: 'Take charge', kind: 'primary', default: true },
    ],
    onClose: () => {
      open = null;
      remember();
      onClose?.();
    },
  });
}

/** Show the welcome if this browser has not seen it yet. Returns true if shown. */
export function maybeShowWelcome(onClose?: () => void): boolean {
  if (welcomed()) return false;
  showWelcome(onClose);
  return true;
}
