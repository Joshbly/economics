// ============================================================================
// App shell. OWNER: ui-foundation.
//
//   startApp(root)
//     → boot screen: "Continue your realm" / "Found a new realm" when a save
//       exists, otherwise straight to founding
//     → founding: world/init.createWorld, then WARMUP_DAYS of stepDay in
//       time-sliced chunks (progress bar, page stays responsive), then
//       stats.rebaseStats
//     → mountShell: top bar · map · sidebar tabs · news ticker, the game loop,
//       keyboard shortcuts, monthly autosave
//   Anything that throws during boot lands on a readable error screen; errors
//   after boot become toasts (the sim loop pauses itself on a failing day).
//
// Layout (CSS grid, see styles.css):
//   ┌──────────── top bar (48px) ─────────────┐
//   │ map (flex)                  │ sidebar   │
//   │                             │ (tabs +   │
//   │                             │  panels)  │
//   └──────────── news ticker (30px) ─────────┘
// ============================================================================
import { WARMUP_DAYS } from '../sim/config';
import { stepDay } from '../sim/engine';
import { Game } from '../sim/game';
import { rebaseStats } from '../sim/stats/stats';
import { createWorld } from '../sim/world/init';
import { SCENARIOS } from '../sim/world/scenarios';
import type { Panel } from './panel';
import { PANELS } from './panels/index';
import { createMapView, type MapView } from './map/renderer';
import { downloadFile, h, isTyping, listen, pickTextFile, replace, setText, toggleClass } from './dom';
import { fmtAgo, fmtBytes, fmtDay } from './format';
import { createLoop, type GameLoop } from './loop';
import { alertDialog, closeTopModal, confirmDialog, initToasts, isModalOpen, openModal, showToast } from './modal';
import { createTopbar, type Topbar } from './topbar';
import { emit, initUi, on, select, setPlacing, setSpeed, setTab, toast, togglePause, ui, type Selection, type TabId } from './uiState';
import { button, field, numberInput, selectInput, textInput } from './widgets/controls';
import { icon } from './widgets/icons';
import { createNewsTicker, type NewsTicker } from './widgets/ticker';

// ---------------------------------------------------------------------------
// Persistence (localStorage, gzip-compressed when the browser supports it)
// ---------------------------------------------------------------------------

export const SLOT_AUTO = 'realmLedger.autosave';
export const SLOT_SAVE = 'realmLedger.save';
const META = '.meta';
/** Autosave at most this often in real time, even at top speed (ms). */
const AUTOSAVE_MIN_MS = 15000;

export interface SaveMeta {
  name: string;
  day: number;
  savedAt: number;
  bytes: number;
  scenario: string;
}

function readMeta(slot: string): SaveMeta | null {
  try {
    const raw = localStorage.getItem(slot + META);
    if (!raw || !localStorage.getItem(slot)) return null;
    const m = JSON.parse(raw) as SaveMeta;
    return m && typeof m.day === 'number' ? m : null;
  } catch {
    return null;
  }
}

function removeSlot(slot: string): void {
  try {
    localStorage.removeItem(slot);
    localStorage.removeItem(slot + META);
  } catch {
    /* storage unavailable */
  }
}

const hasGzip = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH) as unknown as number[]);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Pack a JSON save for localStorage: "gz1:<base64 gzip>" or "raw:<json>". */
export async function packSave(json: string): Promise<string> {
  if (!hasGzip()) return 'raw:' + json;
  try {
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    return 'gz1:' + bytesToB64(buf);
  } catch {
    return 'raw:' + json;
  }
}

/** Inverse of packSave (also accepts bare JSON). */
export async function unpackSave(packed: string): Promise<string> {
  if (packed.startsWith('raw:')) return packed.slice(4);
  if (packed.startsWith('gz1:')) {
    if (!hasGzip()) throw new Error('This browser cannot read compressed saves.');
    const stream = new Blob([b64ToBytes(packed.slice(4)) as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }
  return packed;
}

async function writeSlot(slot: string, game: Game): Promise<{ ok: true; meta: SaveMeta } | { ok: false; error: string; quota: boolean }> {
  let json: string;
  try {
    json = game.save();
  } catch (e) {
    return { ok: false, error: 'The realm could not be written down: ' + errText(e), quota: false };
  }
  const packed = await packSave(json);
  const s = game.s;
  const meta: SaveMeta = { name: s.settings?.realmName || 'The Realm', day: s.day, savedAt: Date.now(), bytes: packed.length, scenario: s.settings?.scenario ?? '' };
  try {
    localStorage.setItem(slot, packed);
    localStorage.setItem(slot + META, JSON.stringify(meta));
    return { ok: true, meta };
  } catch (e) {
    const quota = e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22 || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return { ok: false, error: quota ? `The browser's storage is full (${fmtBytes(packed.length)} needed).` : 'Saving is not available here: ' + errText(e), quota };
  }
}

async function readSlot(slot: string): Promise<Game> {
  let packed: string | null = null;
  try {
    packed = localStorage.getItem(slot);
  } catch (e) {
    throw new Error('Saved realms cannot be read here: ' + errText(e));
  }
  if (!packed) throw new Error('There is no saved realm.');
  return Game.load(await unpackSave(packed));
}

// ---------------------------------------------------------------------------
// Founding (time-sliced warm-up)
// ---------------------------------------------------------------------------

export interface FoundOptions {
  seed: number;
  realmName?: string;
  scenario?: string;
}

const PHASES: [number, string][] = [
  [0, 'Laying out the fields and the roads'],
  [0.12, 'Opening the market halls'],
  [0.25, 'The first sowing'],
  [0.4, 'Wagons on the roads'],
  [0.55, 'The harvest comes in'],
  [0.7, 'Prices settle'],
  [0.82, 'Laying in coal for winter'],
  [0.93, 'The year closes'],
];

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * Create a world and run the warm-up without freezing the page: steps run in
 * ~24 ms slices between animation frames. Progress: f in 0..1, a phase label
 * and the in-game day.
 */
export async function foundRealm(opts: FoundOptions, onProgress: (f: number, label: string, day: number) => void): Promise<Game> {
  onProgress(0.01, 'Surveying the land', 0);
  await nextFrame();
  await nextFrame();
  const s = createWorld({ seed: opts.seed, realmName: opts.realmName || undefined, scenario: opts.scenario });
  if (!s || typeof s !== 'object' || !Array.isArray(s.people)) {
    throw new Error('The world could not be created (world/init.createWorld returned no state).');
  }
  onProgress(0.05, PHASES[0][1], s.day);
  await nextFrame();
  let i = 0;
  while (i < WARMUP_DAYS) {
    const t0 = performance.now();
    do {
      stepDay(s);
      i++;
    } while (i < WARMUP_DAYS && performance.now() - t0 < 24);
    const f = i / WARMUP_DAYS;
    let label = PHASES[0][1];
    for (const [at, lab] of PHASES) if (f >= at) label = lab;
    onProgress(0.05 + 0.92 * f, label, s.day);
    await nextFrame();
  }
  onProgress(0.98, 'Taking stock', s.day);
  await nextFrame();
  rebaseStats(s);
  return new Game(s);
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function screen(root: HTMLElement, ...children: (Node | null)[]): HTMLElement {
  const card = h('div', { class: 'screen-card' }, ...children);
  replace(root, h('div', { class: 'screen' }, card));
  return card;
}

function brandHeader(): HTMLElement[] {
  return [
    h('div', { class: 'screen-crest' }, icon('crown', 24)),
    h('h1', { class: 'screen-title' }, 'Realm Ledger'),
    h('div', { class: 'screen-tag' }, 'You are the Treasury. Everyone else decides for themselves.'),
  ];
}

interface Progress {
  el: HTMLElement;
  set(f: number, label: string, day: number): void;
}

function progressView(title: string): Progress {
  const bar = h('i');
  const lab = h('span');
  const day = h('span', { class: 'num' });
  const el = h('div', null, h('div', { class: 'caps', style: 'text-align:center;margin-bottom:12px;color:var(--gold)' }, title), h('div', { class: 'progress' }, bar), h('div', { class: 'boot-status' }, lab, day));
  return {
    el,
    set(f, label, d) {
      bar.style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';
      setText(lab, label + '…');
      setText(day, d > 0 ? fmtDay(d) : '');
    },
  };
}

/** The realm form (name, seed, scenario) used on the boot screen and in the New realm dialog. */
function realmForm(defaults: Partial<FoundOptions> = {}): { el: HTMLElement; read(): FoundOptions | null } {
  const name = textInput({ value: defaults.realmName ?? '', placeholder: 'Leave blank for a name from the chronicles', maxLength: 40 });
  const seed = numberInput({ value: defaults.seed ?? randomSeed(), integer: true, min: 0, max: 2 ** 31 - 1, width: '140px' });
  const dice = button({ label: '', kind: 'ghost', size: 'sm', icon: icon('dice', 16), title: 'Roll a new seed', onClick: () => seed.set(randomSeed()) });
  const scen = selectInput({ options: SCENARIOS.map((x) => ({ value: x.id, label: x.name })), value: defaults.scenario ?? SCENARIOS[0]?.id ?? 'founding' });
  const desc = h('div', { class: 'field-hint' });
  const paintDesc = () => setText(desc, SCENARIOS.find((x) => x.id === scen.value)?.description ?? '');
  scen.el.addEventListener('change', paintDesc);
  paintDesc();
  const el = h(
    'div',
    { class: 'screen-form' },
    field('Realm name', name),
    field('Seed', h('div', { class: 'row' }, seed.el, dice), 'The same seed always grows the same land.'),
    field('Beginning', h('div', { class: 'stack', style: 'gap:5px' }, scen.el, desc)),
  );
  return {
    el,
    read() {
      if (!seed.valid) {
        seed.focus();
        return null;
      }
      return { realmName: name.value.trim() || undefined, seed: Math.round(seed.value), scenario: scen.value };
    },
  };
}

function randomSeed(): number {
  // UI-side randomness is fine (the sim itself only uses its seeded RNG).
  return Math.floor(Math.random() * 900000) + 1000;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Full-screen error with the message, stack and recovery options. */
export function showErrorScreen(root: HTMLElement, err: unknown, context = 'The realm could not be founded'): void {
  const msg = errText(err) || 'Unknown error';
  const stack = err instanceof Error && err.stack ? err.stack : '';
  const hasAuto = !!readMeta(SLOT_AUTO);
  const copyBtn = button({
    label: 'Copy details',
    kind: 'ghost',
    icon: icon('copy', 15),
    onClick: () => {
      const text = `${context}\n${msg}\n\n${stack}`;
      navigator.clipboard?.writeText(text).then(
        () => setText(copyBtn, 'Copied'),
        () => setText(copyBtn, 'Copy failed'),
      );
    },
  });
  screen(
    root,
    h('div', { class: 'screen-crest err-icon' }, icon('warning', 24)),
    h('h1', { class: 'err-title' }, context),
    h('p', { class: 'err-lead' }, 'Something in the simulation broke. The details below help whoever is building this realm.'),
    h('div', { class: 'err-msg' }, msg),
    stack ? h('pre', { class: 'err-stack' }, stack) : null,
    h(
      'div',
      { class: 'err-actions' },
      button({ label: 'Try again', kind: 'primary', icon: icon('refresh', 15), onClick: () => location.reload() }),
      button({ label: 'Found a new realm', kind: 'secondary', icon: icon('plus', 15), onClick: () => newRealmScreen(root) }),
      hasAuto
        ? button({
            label: 'Discard autosave',
            kind: 'danger',
            icon: icon('trash', 15),
            onClick: async () => {
              if (await confirmDialog({ title: 'Discard the autosaved realm?', message: 'This cannot be undone.', confirm: 'Discard', danger: true })) {
                removeSlot(SLOT_AUTO);
                showToast('Autosave discarded.', 'info');
              }
            },
          })
        : null,
      copyBtn,
    ),
  ).classList.add('wide');
}

function newRealmScreen(root: HTMLElement, defaults: Partial<FoundOptions> = {}, back?: () => void): void {
  const form = realmForm(defaults);
  const go = () => {
    const o = form.read();
    if (o) found(root, o);
  };
  const card = screen(
    root,
    ...brandHeader(),
    form.el,
    h('div', { class: 'screen-actions' }, back ? button({ label: 'Back', kind: 'ghost', onClick: back }) : null, button({ label: 'Found the realm', kind: 'primary', onClick: go })),
  );
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });
}

async function found(root: HTMLElement, o: FoundOptions): Promise<void> {
  const p = progressView('Founding the realm');
  screen(root, ...brandHeader(), p.el, h('div', { class: 'screen-foot' }, `Seed ${o.seed} · the first year passes before you take charge`));
  try {
    const game = await foundRealm(o, p.set);
    mountShell(root, game, 'new');
  } catch (e) {
    console.error(e);
    showErrorScreen(root, e);
  }
}

async function continueFrom(root: HTMLElement, slot: string): Promise<void> {
  const p = progressView('Opening the ledger');
  screen(root, ...brandHeader(), p.el);
  p.set(0.3, 'Reading the books', 0);
  await nextFrame();
  try {
    const game = await readSlot(slot);
    p.set(1, 'Ready', game.s.day);
    await nextFrame();
    mountShell(root, game, 'loaded');
  } catch (e) {
    console.error(e);
    showErrorScreen(root, e, 'The saved realm could not be opened');
  }
}

function bootScreen(root: HTMLElement): void {
  const auto = readMeta(SLOT_AUTO);
  const manual = readMeta(SLOT_SAVE);
  if (!auto && !manual) {
    found(root, { seed: randomSeed() });
    return;
  }
  const choice = (ic: string, title: string, sub: string, primary: boolean, fn: () => void) =>
    h('button', { class: 'choice' + (primary ? ' primary' : ''), type: 'button', onClick: fn }, h('span', { class: 'choice-icon' }, icon(ic, 20)), h('span', { class: 'choice-main' }, h('div', { class: 'choice-title' }, title), h('div', { class: 'choice-sub' }, sub)), icon('chevronRight', 16));
  const metaLine = (m: SaveMeta) => `${m.name} · ${fmtDay(m.day)} · saved ${fmtAgo(m.savedAt)}`;
  const newer = auto && manual ? (auto.savedAt >= manual.savedAt ? 'auto' : 'manual') : auto ? 'auto' : 'manual';
  screen(
    root,
    ...brandHeader(),
    h(
      'div',
      { class: 'boot-choices' },
      auto ? choice('crown', 'Continue your realm', metaLine(auto), newer === 'auto', () => continueFrom(root, SLOT_AUTO)) : null,
      manual ? choice('load', auto ? 'Open your saved realm' : 'Continue your realm', metaLine(manual), newer === 'manual', () => continueFrom(root, SLOT_SAVE)) : null,
      choice('plus', 'Found a new realm', 'A fresh land, a new seed, a first year already lived', false, () => newRealmScreen(root, {}, () => bootScreen(root))),
    ),
    h('div', { class: 'screen-foot' }, 'Your realm is kept in this browser and saved every month.'),
  );
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

let booting = true;

/** Boot the app into `root`. */
export function startApp(root: HTMLElement): void {
  installGlobalErrorHandlers(root);
  initToasts();
  try {
    bootScreen(root);
  } catch (e) {
    console.error(e);
    showErrorScreen(root, e);
  }
}

function installGlobalErrorHandlers(root: HTMLElement): void {
  let lastToast = 0;
  const report = (err: unknown) => {
    console.error(err);
    if (booting) {
      showErrorScreen(root, err);
      return;
    }
    const now = Date.now();
    if (now - lastToast > 4000) {
      lastToast = now;
      toast('Something went wrong in the interface: ' + errText(err), 'bad');
    }
  };
  window.addEventListener('error', (e) => report(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => report(e.reason));
}

interface PanelSlot {
  panel: Panel;
  el: HTMLElement;
  tab: HTMLButtonElement;
  mounted: boolean;
  failed: string | null;
  errorEl: HTMLElement | null;
}

/**
 * Build the in-game layout around `game` and start the loop. Exported for the
 * dev shell preview; the normal path is startApp().
 */
export function mountShell(root: HTMLElement, game: Game, how: 'new' | 'loaded' | 'preview' = 'new'): void {
  booting = false;
  initUi(game);

  // ---- persistence commands -------------------------------------------------------
  let autosaveMonth = Math.floor(game.s.day / 30);
  let lastAutosave = 0;
  let saving = false;
  let quotaWarned = 0;
  async function autosave(reason: string): Promise<void> {
    if (saving || how === 'preview') return;
    saving = true;
    try {
      const r = await writeSlot(SLOT_AUTO, ui.game);
      lastAutosave = Date.now();
      if (!r.ok) {
        console.warn('[autosave]', reason, r.error);
        if (Date.now() - quotaWarned > 5 * 60_000) {
          quotaWarned = Date.now();
          toast(`Autosave failed: ${r.error} Export the realm to a file to keep it.`, 'bad');
        }
      }
    } catch (e) {
      console.warn('[autosave]', e);
    } finally {
      saving = false;
    }
  }

  const commands = {
    async save() {
      const r = await writeSlot(SLOT_SAVE, ui.game);
      if (r.ok) toast(`Realm saved — ${fmtDay(r.meta.day)}.`, 'good');
      else toast(`Could not save: ${r.error} Try Export to file instead.`, 'bad');
    },
    async load() {
      const m = readMeta(SLOT_SAVE);
      if (!m) {
        toast('There is no saved realm yet. Use Save first.', 'info');
        return;
      }
      if (!(await confirmDialog({ title: 'Open the saved realm?', message: `${m.name}, ${fmtDay(m.day)} (saved ${fmtAgo(m.savedAt)}). Anything since your last save or autosave will be lost.`, confirm: 'Open it' }))) return;
      try {
        swapGame(await readSlot(SLOT_SAVE), 'Saved realm opened.');
      } catch (e) {
        alertDialog('The saved realm could not be opened', errText(e));
      }
    },
    exportFile() {
      try {
        const s = ui.game.s;
        const slug = (s.settings?.realmName || 'realm').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'realm';
        downloadFile(`${slug}-${fmtDay(s.day).replace(/[^A-Za-z0-9]+/g, '-')}.json`, ui.game.save());
        toast('Realm exported.', 'good');
      } catch (e) {
        toast('Export failed: ' + errText(e), 'bad');
      }
    },
    async importFile() {
      const f = await pickTextFile();
      if (!f) return;
      let g: Game;
      try {
        g = Game.load(await unpackSave(f.text.trim()));
      } catch (e) {
        alertDialog('That file is not a realm we can open', errText(e));
        return;
      }
      if (!(await confirmDialog({ title: 'Open the imported realm?', message: `${g.s.settings?.realmName || 'A realm'}, ${fmtDay(g.s.day)}, from ${f.name}. The current realm will be replaced (it is autosaved monthly).`, confirm: 'Open it' }))) return;
      swapGame(g, 'Realm imported.');
    },
    newRealm() {
      const form = realmForm({});
      openModal({
        title: 'Found a new realm',
        subtitle: 'The current realm stays in its last autosave until the new one replaces it.',
        body: form.el,
        width: 480,
        actions: [
          { label: 'Cancel', kind: 'ghost' },
          {
            label: 'Found it',
            kind: 'primary',
            default: true,
            onClick: () => {
              const o = form.read();
              if (!o) return false;
              foundInPlace(o);
            },
          },
        ],
      });
    },
    help() {
      setTab('almanac');
    },
  };

  async function foundInPlace(o: FoundOptions): Promise<void> {
    setSpeed(0);
    const p = progressView('Founding the realm');
    const overlay = h('div', { class: 'founding-overlay' }, h('div', { class: 'screen' }, h('div', { class: 'screen-card' }, ...brandHeader(), p.el)));
    document.body.appendChild(overlay);
    try {
      const g = await foundRealm(o, p.set);
      swapGame(g, 'A new realm is founded.');
      autosave('new realm');
    } catch (e) {
      console.error(e);
      alertDialog('The realm could not be founded', errText(e));
    } finally {
      overlay.remove();
    }
  }

  function swapGame(g: Game, message: string): void {
    setSpeed(0);
    ui.game = g;
    ui.selection = null;
    ui.placing = null;
    ui.dayFrac = 0.3;
    autosaveMonth = Math.floor(g.s.day / 30);
    try {
      mapView?.reset();
    } catch (e) {
      console.error('[map] reset failed', e);
    }
    emit('newgame');
    emit('select', null);
    topbar.update(true);
    tickerDirty = true;
    forcePanels = true;
    toast(message, 'good');
  }

  // ---- layout ----------------------------------------------------------------------
  const topbar: Topbar = createTopbar(commands);
  const mapEl = h('main', { class: 'mapwrap', 'aria-label': 'Map of the realm' });
  const placingEl = h('div', { class: 'map-placing', hidden: true });
  const tabsEl = h('nav', { class: 'tabs', role: 'tablist' });
  const panelHost = h('div', { class: 'panel-host' });
  const sidebar = h('aside', { class: 'sidebar' }, tabsEl, panelHost);
  const ticker: NewsTicker = createNewsTicker();
  const app = h('div', { class: 'app' }, topbar.el, mapEl, sidebar, ticker.el);
  replace(root, app);

  // ---- map ---------------------------------------------------------------------------
  let mapView: MapView | null = null;
  const mapNote = (text: string) => mapEl.appendChild(h('div', { class: 'map-note' }, text));
  try {
    mapView = createMapView(mapEl);
  } catch (e) {
    console.error('[map] could not be created', e);
    mapNote('The map could not be drawn: ' + errText(e));
  }
  mapEl.appendChild(placingEl);
  new ResizeObserver(() => {
    try {
      mapView?.resize();
    } catch (e) {
      console.error('[map] resize failed', e);
    }
  }).observe(mapEl);

  // ---- sidebar -----------------------------------------------------------------------
  const slots: PanelSlot[] = PANELS.map((panel) => {
    const el = h('section', { class: 'panel', role: 'tabpanel', hidden: true, dataset: { panel: panel.id } });
    const tab = h('button', { class: 'tab', type: 'button', role: 'tab', onClick: () => setTab(panel.id) }, panel.title);
    tabsEl.appendChild(tab);
    panelHost.appendChild(el);
    return { panel, el, tab, mounted: false, failed: null, errorEl: null };
  });
  const slotOf = (id: TabId) => slots.find((x) => x.panel.id === id);

  function panelError(slot: PanelSlot, phase: string, e: unknown): void {
    const msg = errText(e);
    if (slot.failed === msg) return;
    slot.failed = msg;
    console.error(`[panel ${slot.panel.id}] ${phase} failed`, e);
    slot.errorEl?.remove();
    slot.errorEl = h('div', { class: 'panel-error' }, h('div', { class: 'strong' }, `This page hit a problem while it ${phase === 'mount' ? 'was being built' : 'was updating'}.`), h('pre', null, msg));
    slot.el.prepend(slot.errorEl);
  }

  function mountPanel(slot: PanelSlot): void {
    if (slot.mounted) return;
    slot.mounted = true;
    try {
      slot.panel.mount(slot.el);
    } catch (e) {
      panelError(slot, 'mount', e);
    }
  }

  function updatePanel(slot: PanelSlot): void {
    try {
      slot.panel.update();
      if (slot.failed) {
        slot.failed = null;
        slot.errorEl?.remove();
        slot.errorEl = null;
      }
    } catch (e) {
      panelError(slot, 'update', e);
    }
  }

  let prevTab: TabId = ui.tab === 'inspect' ? 'levers' : ui.tab;
  function showTab(id: TabId): void {
    for (const s of slots) {
      const on = s.panel.id === id;
      toggleClass(s.tab, 'on', on);
      s.tab.setAttribute('aria-selected', String(on));
      if (s.el.hidden === on) s.el.hidden = !on;
    }
    const slot = slotOf(id);
    if (!slot) return;
    mountPanel(slot);
    try {
      slot.panel.show?.();
    } catch (e) {
      panelError(slot, 'show', e);
    }
    updatePanel(slot);
    lastPanelUpdate = performance.now();
  }
  for (const s of slots) mountPanel(s);

  // ---- event wiring --------------------------------------------------------------------
  let dirty = true;
  let tickerDirty = true;
  let forcePanels = true;
  let lastPanelUpdate = 0;
  let lastTopbar = 0;
  let lastTicker = 0;

  on('tab', (t) => {
    const id = t as TabId;
    if (id !== 'inspect') prevTab = id;
    showTab(id);
  });
  on('select', (payload) => {
    const sel = payload as Selection;
    const inspect = slotOf('inspect');
    if (inspect) {
      const dot = inspect.tab.querySelector('.tab-dot');
      if (sel && !dot) inspect.tab.appendChild(h('span', { class: 'tab-dot' }));
      if (!sel && dot) dot.remove();
    }
    if (sel && sel.kind === 'market') {
      ui.marketTown = sel.town;
      ui.marketGood = sel.good;
      if (ui.tab !== 'markets') setTab('markets');
    } else if (sel) {
      if (ui.tab !== 'inspect') setTab('inspect');
    } else if (ui.tab === 'inspect' && prevTab !== 'inspect') setTab(prevTab);
    forcePanels = true;
  });
  on('placing', () => paintPlacing());
  on('day', () => {
    dirty = true;
    tickerDirty = true;
    const m = Math.floor(ui.game.s.day / 30);
    if (m !== autosaveMonth && Date.now() - lastAutosave >= AUTOSAVE_MIN_MS) {
      autosaveMonth = m;
      autosave('month');
    }
  });
  for (const ev of ['action', 'newgame', 'overlay'] as const) on(ev, () => (forcePanels = true));
  on('frame', () => {
    const now = performance.now();
    if (now - lastTopbar >= 66) {
      lastTopbar = now;
      topbar.update();
    }
    if (tickerDirty && now - lastTicker >= 250) {
      lastTicker = now;
      tickerDirty = false;
      ticker.update();
    }
    const elapsed = now - lastPanelUpdate;
    if (forcePanels || (elapsed >= 250 && (dirty || elapsed >= 1000))) {
      const slot = slotOf(ui.tab);
      if (slot) updatePanel(slot);
      lastPanelUpdate = now;
      forcePanels = false;
      dirty = false;
    }
  });

  function paintPlacing(): void {
    const p = ui.placing;
    placingEl.hidden = !p;
    if (!p) return;
    const what = p.kind === 'house' ? 'a house block' : p.kind === 'pier' ? 'the pier' : `the new ${p.sector ?? 'workshop'}`;
    replace(placingEl, icon('target', 16), h('span', null, `Choose a site for ${what}`), h('kbd', null, 'Esc'), button({ label: 'Cancel', kind: 'ghost', size: 'sm', onClick: () => setPlacing(null) }));
  }

  // ---- keyboard ---------------------------------------------------------------------------
  const tabOrder = () => slots.map((s) => s.panel.id);
  listen(window, 'keydown', (ev) => {
    const e = ev as KeyboardEvent;
    if (e.defaultPrevented) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      commands.save();
      return;
    }
    if (isModalOpen()) {
      if (e.key === 'Escape') closeTopModal();
      return;
    }
    if (isTyping(e)) {
      if (e.key === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === ' ' || e.code === 'Space') {
      e.preventDefault();
      togglePause();
    } else if (k >= '0' && k <= '5' && k.length === 1) {
      e.preventDefault();
      setSpeed(Number(k));
    } else if (k === 'Escape') {
      if (ticker.closeLog()) return;
      if (ui.placing) setPlacing(null);
      else if (ui.selection) select(null);
    } else if (k === '[' || k === ']') {
      const order = tabOrder();
      const i = order.indexOf(ui.tab);
      const n = order.length;
      setTab(order[(((i < 0 ? 0 : i) + (k === ']' ? 1 : -1)) % n + n) % n]);
    } else if (k === '?') {
      setTab('almanac');
    } else if (k === '`') {
      toggleHud();
    }
  });

  // ---- dev HUD (backquote) ---------------------------------------------------------------
  let hud: HTMLElement | null = null;
  let hudTimer = 0;
  function toggleHud(): void {
    if (hud) {
      hud.remove();
      hud = null;
      clearInterval(hudTimer);
      return;
    }
    hud = h('div', { class: 'tip on', style: 'left:auto;right:12px;top:auto;bottom:calc(var(--ticker-h) + 12px);transform:none;pointer-events:none;max-width:none;white-space:nowrap;font:11px/1.5 var(--mono)' });
    document.body.appendChild(hud);
    const paint = () => {
      if (!hud) return;
      const p = loop.perf;
      let alive = 0;
      for (const x of ui.game.s.people) if (x && x.alive) alive++;
      hud.textContent = `fps ${p.fps.toFixed(0)} · ${p.stepMs.toFixed(2)} ms/day · ${p.daysPerSec.toFixed(1)} days/s · ${alive} households · day ${ui.game.s.day}`;
    };
    paint();
    hudTimer = window.setInterval(paint, 500);
  }

  // ---- autosave on hide / close ---------------------------------------------------------------
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden' && Date.now() - lastAutosave > 3000) autosave('hidden');
  });
  // The page is going away: compression is asynchronous and may not finish, so
  // write uncompressed synchronously. If that exceeds the quota the previous
  // (compressed) autosave stays in place — setItem failures leave it untouched.
  listen(window, 'pagehide', () => {
    if (how === 'preview' || Date.now() - lastAutosave < 3000) return;
    try {
      const json = ui.game.save();
      const s = ui.game.s;
      localStorage.setItem(SLOT_AUTO, 'raw:' + json);
      const meta: SaveMeta = { name: s.settings?.realmName || 'The Realm', day: s.day, savedAt: Date.now(), bytes: json.length + 4, scenario: s.settings?.scenario ?? '' };
      localStorage.setItem(SLOT_AUTO + META, JSON.stringify(meta));
    } catch {
      /* quota or storage disabled: keep the last compressed autosave */
    }
  });

  // ---- go ----------------------------------------------------------------------------------
  const loop: GameLoop = createLoop({ onMapError: (e) => mapNote('The map stopped drawing: ' + errText(e)) });
  loop.setMapView(mapView);
  showTab(ui.tab);
  paintPlacing();
  topbar.update(true);
  ticker.update();
  loop.start();
  if (how === 'new') autosave('founded');
  if (how !== 'preview') {
    setTimeout(() => toast(how === 'new' ? 'The realm is yours. Press Space to start the clock.' : 'Welcome back. Press Space to resume.', 'info'), 600);
  }
}
