// ============================================================================
// Top bar: realm name · date & season · speed controls · headline indicators
// (with trend arrows and explanatory hover cards) · the realm menu.
// Reads ui.game.s (read-only). Menu commands are supplied by the app shell.
// ============================================================================
import { SEASONS, seasonOf } from '../sim/calendar';
import { DAYS_PER_YEAR } from '../sim/config';
import type { SimState } from '../sim/types';
import { h, listen, setText, setTone, toggleClass } from './dom';
import { fmtDayLong, fmtIndex, fmtInt, fmtMoney, fmtMoneyDelta, fmtMoneyShort, fmtPct, fmtPctSigned, fmtPrice, fmtPts, fmtSigned } from './format';
import { act, on, setSpeed, SPEEDS, ui } from './uiState';
import { icon, speedIcon } from './widgets/icons';
import { arrowOf, tailMean, trend, type Tone } from './widgets/kpi';
import { sparkCanvas } from './widgets/sparkline';
import { T } from './widgets/theme';
import { attachTip, tipKV, tipNote, tipTitle } from './widgets/tooltip';

export interface TopbarActions {
  newRealm(): void;
  save(): void;
  load(): void;
  exportFile(): void;
  importFile(): void;
  help(): void;
}

export interface Topbar {
  el: HTMLElement;
  /** Refresh (cheap; call several times a second). `force` recomputes indicators even if the day is unchanged. */
  update(force?: boolean): void;
}

// ---------------------------------------------------------------------------
// Indicator definitions
// ---------------------------------------------------------------------------

interface IndReading {
  value: string;
  valueTone?: Tone;
  delta?: string;
  /** Direction of the change (sign), for the arrow. */
  dir?: number;
  tone?: Tone;
}

interface IndDef {
  id: string;
  label: string;
  /** Responsive hide class (ind-hide-1 hides first as the window narrows). */
  hide?: string;
  /** Daily series behind the indicator (for the hover sparkline). */
  series: string;
  read(s: SimState): IndReading;
  title: string;
  explain: string;
  /** Hover-card detail lines. */
  detail(s: SimState): HTMLElement[];
}

const L = (s: SimState, k: string): number => {
  const v = s.stats?.latest?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
};
const D = (s: SimState, k: string): number[] => s.stats?.daily?.[k] ?? [];

/** Real output indexed to 100 over the first 30 days of the player's reign (30-day means). */
export function outputIndex(series: ArrayLike<number>): { index: number; prev: number } {
  const n = series.length;
  if (!n) return { index: NaN, prev: NaN };
  let base = 0;
  let k = 0;
  for (let i = 0; i < Math.min(30, n); i++) {
    if (Number.isFinite(series[i])) {
      base += series[i];
      k++;
    }
  }
  base = k ? base / k : NaN;
  if (!(base > 0)) return { index: NaN, prev: NaN };
  const now = tailMean(series, 30);
  const prev = n > 30 ? tailMean(series, 30, 30) : NaN;
  return { index: (now / base) * 100, prev: (prev / base) * 100 };
}

const toneOf = (d: number, good: 'up' | 'down' | null, eps: number): Tone => {
  if (!Number.isFinite(d) || Math.abs(d) <= eps || !good) return null;
  return (d > 0) === (good === 'up') ? 'good' : 'bad';
};

const INDICATORS: IndDef[] = [
  {
    id: 'prices',
    label: 'Prices',
    series: 'cpi',
    title: 'Prices',
    explain:
      'What a typical household basket costs — bread, fish, ale, coal, furniture and rent — as an index: 100 is the level when you took charge. The small figure is inflation: the change over the last 30 days, expressed per year.',
    read(s) {
      const cpi = L(s, 'cpi');
      const inf = L(s, 'infl30');
      const hot = Number.isFinite(inf) && (inf > 0.06 || inf < -0.03);
      return {
        value: fmtIndex(cpi),
        delta: Number.isFinite(inf) ? fmtPctSigned(inf) + '/yr' : undefined,
        dir: inf,
        tone: hot ? 'bad' : null,
      };
    },
    detail(s) {
      return [tipKV('Last 30 days (per year)', fmtPctSigned(L(s, 'infl30'))), tipKV('Last 12 months', fmtPctSigned(L(s, 'inflYoY')))];
    },
  },
  {
    id: 'jobless',
    label: 'Jobless',
    series: 'unemp',
    title: 'Jobless',
    explain: 'Share of households with no job. Every household has one worker. Rising joblessness means firms are hiring fewer than want work.',
    read(s) {
      const u = L(s, 'unemp');
      const tr = trend(D(s, 'unemp'), 30);
      return {
        value: fmtPct(u),
        valueTone: u > 0.15 ? 'bad' : u > 0.1 ? 'warn' : null,
        delta: Number.isFinite(tr.delta) && D(s, 'unemp').length > 1 ? fmtPts(tr.delta) : undefined,
        dir: tr.delta,
        tone: toneOf(tr.delta, 'down', 0.002),
      };
    },
    detail(s) {
      return [tipKV('Jobless now', fmtInt(L(s, 'unemployed'))), tipKV('Open vacancies', fmtInt(L(s, 'vacancies'))), tipKV('Average posted wage', fmtMoney(L(s, 'wage')) + '/day')];
    },
  },
  {
    id: 'output',
    label: 'Output',
    series: 'gdpReal',
    title: 'Output',
    explain:
      'Everything the realm produces in a day, valued at fixed founding prices so that only quantities count. 30-day average, indexed to 100 when you took charge. Harvests make it swing with the seasons.',
    read(s) {
      const o = outputIndex(D(s, 'gdpReal'));
      const d = o.index - o.prev;
      return {
        value: fmtIndex(o.index),
        delta: Number.isFinite(d) ? fmtSigned(d / (o.prev || 1), (x) => fmtPct(x)) : undefined,
        dir: d,
        tone: toneOf(d, 'up', 0.05),
      };
    },
    detail(s) {
      return [tipKV('Today, at founding prices', fmtMoneyShort(L(s, 'gdpReal')) + '/day'), tipKV('Today, at current prices', fmtMoneyShort(L(s, 'gdpNominal')) + '/day')];
    },
  },
  {
    id: 'money',
    label: 'Money',
    hide: 'ind-hide-2',
    series: 'money',
    title: 'Money',
    explain:
      'All the money people, workshops and foreign merchants hold as bank deposits. It grows when the bank lends or the Treasury spends, and shrinks when loans are repaid or the Treasury collects.',
    read(s) {
      const tr = trend(D(s, 'money'), 30);
      return { value: fmtMoneyShort(L(s, 'money')), delta: Number.isFinite(tr.rel) && D(s, 'money').length > 1 ? fmtPctSigned(tr.rel) : undefined, dir: tr.delta, tone: null };
    },
    detail(s) {
      return [tipKV('Bank loans', fmtMoneyShort(L(s, 'credit'))), tipKV('Bank reserves at the Treasury', fmtMoneyShort(L(s, 'reserves'))), tipKV('Loan rate', fmtPct(L(s, 'loanRate'), 1))];
    },
  },
  {
    id: 'purse',
    label: 'Purse',
    series: 'purse',
    title: 'The Purse',
    explain: 'Money the Treasury holds. Spending from it puts money into circulation; collecting pulls it out. You can always create more with Mint — at a price.',
    read(s) {
      const p = L(s, 'purse');
      const tr = trend(D(s, 'purse'), 30);
      return {
        value: fmtMoneyShort(p),
        valueTone: p < 0 ? 'bad' : null,
        delta: Number.isFinite(tr.delta) && D(s, 'purse').length > 1 ? fmtMoneyDelta(tr.delta) : undefined,
        dir: tr.delta,
        tone: null,
      };
    },
    detail(s) {
      return [tipKV('Taken in today', fmtMoneyShort(L(s, 'treasuryIncome'))), tipKV('Paid out today', fmtMoneyShort(L(s, 'treasurySpend'))), tipKV('Created so far', fmtMoneyShort(L(s, 'minted')))];
    },
  },
  {
    id: 'gold',
    label: 'Gold',
    hide: 'ind-hide-1',
    series: 'goldPrice',
    title: 'Gold price',
    explain:
      'What an ounce of gold costs in ¤ — the realm’s exchange rate with the outside world, where prices are quoted in gold. A rising gold price means your money buys less abroad: imports get dearer, exports cheaper.',
    read(s) {
      const tr = trend(D(s, 'goldPrice'), 30);
      return { value: fmtPrice(L(s, 'goldPrice')), delta: Number.isFinite(tr.rel) && D(s, 'goldPrice').length > 1 ? fmtPctSigned(tr.rel) : undefined, dir: tr.delta, tone: null };
    },
    detail(s) {
      return [tipKV('Treasury gold', fmtInt(L(s, 'treasuryGold')) + ' oz'), tipKV('Trade balance today', fmtMoneyShort(L(s, 'tradeBal')))];
    },
  },
  {
    id: 'people',
    label: 'People',
    hide: 'ind-hide-3',
    series: 'pop',
    title: 'Households',
    explain: 'Households living in the realm. Births and newcomers add to it; deaths and people leaving for abroad — taking their money with them — subtract.',
    read(s) {
      const tr = trend(D(s, 'pop'), 30);
      return {
        value: fmtInt(L(s, 'pop')),
        delta: Number.isFinite(tr.delta) && D(s, 'pop').length > 1 ? fmtSigned(tr.delta, (x) => fmtInt(x)) : undefined,
        dir: tr.delta,
        tone: toneOf(tr.delta, 'up', 0.5),
      };
    },
    detail(s) {
      return [tipKV('Hungry', fmtPct(L(s, 'hunger'))), tipKV('Homeless', fmtInt(L(s, 'homeless'))), tipKV('Average health', fmtPct(L(s, 'health'), 0))];
    },
  },
];

// ---------------------------------------------------------------------------

export function createTopbar(actions: TopbarActions): Topbar {
  // brand
  const realmEl = h('div', { class: 'tb-realm' });
  const brand = h('div', { class: 'tb-brand' }, h('div', { class: 'tb-crest' }, icon('crown', 17)), h('div', { class: 'tb-titles' }, realmEl, h('div', { class: 'tb-sub' }, 'Treasury of the Realm')));

  // date
  const dateMain = h('div', { class: 'tb-date-main' });
  const seasonDot = h('span', { class: 'season-dot' });
  const seasonLab = h('span');
  const dayFill = h('i');
  const date = h('div', { class: 'tb-date' }, dateMain, h('div', { class: 'tb-date-sub' }, seasonDot, seasonLab, h('span', { class: 'tb-daybar', title: 'Time of day' }, dayFill)));

  // speed
  const speedLab = h('span', { class: 'speed-lab' });
  const speedBtns = SPEEDS.map((sp, i) =>
    h(
      'button',
      {
        class: 'speed-btn' + (i === 0 ? ' pause' : ''),
        type: 'button',
        'aria-label': i === 0 ? 'Pause' : `Speed ${i}`,
        onClick: () => setSpeed(i === 0 && ui.speed === 0 ? 2 : i),
      },
      i === 0 ? icon('pause', 16) : speedIcon(i, 17),
    ),
  );
  speedBtns.forEach((b, i) =>
    attachTip(b, () => [tipTitle(i === 0 ? 'Pause' : `Speed ${i}`, i === 0 ? 'Space' : `key ${i}`), tipNote(i === 0 ? 'Stop the clock. Space toggles.' : `${daysPerSecond(SPEEDS[i])} per second.`)], { delay: 400 }),
  );
  const speed = h('div', { class: 'tb-speed' }, h('div', { class: 'speed-seg', role: 'group', 'aria-label': 'Speed' }, speedBtns), speedLab);

  // indicators
  const inds = INDICATORS.map((def) => {
    const val = h('span', { class: 'ind-val' });
    const arr = h('span', { class: 'arr' });
    const dtxt = h('span');
    const delta = h('span', { class: 'ind-delta' }, arr, dtxt);
    const el = h('div', { class: 'ind' + (def.hide ? ' ' + def.hide : ''), tabIndex: 0 }, h('span', { class: 'ind-lab' }, def.label), h('span', { class: 'ind-row' }, val, delta));
    attachTip(el, () => indicatorCard(def), { placement: 'below', delay: 220 });
    return { def, el, val, arr, dtxt, delta };
  });
  const indBox = h('div', { class: 'tb-inds' }, inds.map((x) => x.el));

  // menu
  const menuBtn = h('button', { class: 'icon-btn tb-menu-btn', type: 'button', title: 'Realm menu', 'aria-haspopup': 'menu', onClick: () => toggleMenu() }, icon('menu', 18));

  const el = h('header', { class: 'topbar' }, brand, h('div', { class: 'tb-sep' }), date, h('div', { class: 'tb-sep' }), speed, indBox, menuBtn);

  // ---- menu -----------------------------------------------------------------
  let menuEl: HTMLElement | null = null;
  let offMenu: (() => void)[] = [];
  function closeMenu(): void {
    if (!menuEl) return;
    const m = menuEl;
    menuEl = null;
    m.classList.remove('on');
    setTimeout(() => m.remove(), 150);
    offMenu.forEach((f) => f());
    offMenu = [];
  }
  function toggleMenu(): void {
    if (menuEl) return closeMenu();
    const item = (ic: string, label: string, kbd: string | null, fn: () => void, check?: boolean) =>
      h(
        'button',
        {
          class: 'menu-item',
          type: 'button',
          role: 'menuitem',
          onClick: () => {
            closeMenu();
            fn();
          },
        },
        icon(ic, 16),
        label,
        check !== undefined ? h('span', { class: 'menu-check' }, check ? icon('check', 15) : '') : kbd ? h('span', { class: 'menu-kbd' }, kbd) : null,
      );
    const s = ui.game?.s;
    const events = !!s?.settings?.events;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    menuEl = h(
      'div',
      { class: 'menu', role: 'menu' },
      item('plus', 'Found a new realm…', null, actions.newRealm),
      h('div', { class: 'menu-sep' }),
      item('save', 'Save', mac ? '⌘S' : 'Ctrl+S', actions.save),
      item('load', 'Load saved realm', null, actions.load),
      item('download', 'Export to file…', null, actions.exportFile),
      item('upload', 'Import from file…', null, actions.importFile),
      h('div', { class: 'menu-sep' }),
      item('dice', 'Random events', null, () => act({ type: 'setEvents', value: !events }, true), events),
      h('div', { class: 'menu-sep' }),
      item('book', 'Almanac & help', '?', actions.help),
    );
    document.body.appendChild(menuEl);
    const r = menuBtn.getBoundingClientRect();
    menuEl.style.top = Math.round(r.bottom + 6) + 'px';
    menuEl.style.right = Math.round(window.innerWidth - r.right) + 'px';
    requestAnimationFrame(() => menuEl?.classList.add('on'));
    offMenu.push(
      listen(document, 'pointerdown', (e) => {
        if (menuEl && !menuEl.contains(e.target as Node) && !menuBtn.contains(e.target as Node)) closeMenu();
      }, true),
      listen(document, 'keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Escape') {
          e.stopPropagation();
          closeMenu();
        }
      }, true),
      listen(window, 'blur', closeMenu),
    );
  }

  // ---- updates ----------------------------------------------------------------
  let lastDay = -1;
  let lastSpeed = -1;
  let lastRealm = '';

  function paintSpeed(): void {
    if (ui.speed === lastSpeed) return;
    lastSpeed = ui.speed;
    speedBtns.forEach((b, i) => {
      toggleClass(b, 'on', i === ui.speed);
      b.setAttribute('aria-pressed', String(i === ui.speed));
    });
    setText(speedLab, ui.speed === 0 ? 'PAUSED' : daysPerSecond(SPEEDS[ui.speed]) + '/s');
    toggleClass(speedLab, 'paused', ui.speed === 0);
  }

  function update(force = false): void {
    const s = ui.game?.s;
    paintSpeed();
    dayFill.style.width = Math.round(Math.max(0, Math.min(1, ui.dayFrac)) * 100) + '%';
    if (!s) return;
    const name = s.settings?.realmName || 'The Realm';
    if (name !== lastRealm) {
      lastRealm = name;
      setText(realmEl, name);
      realmEl.title = name;
    }
    if (s.day === lastDay && !force) return;
    lastDay = s.day;
    setText(dateMain, fmtDayLong(s.day));
    const season = seasonOf(s.day);
    setText(seasonLab, SEASONS[season]);
    seasonDot.className = 'season-dot season-' + season;
    for (const x of inds) {
      let r: IndReading;
      try {
        r = x.def.read(s);
      } catch {
        r = { value: '—' };
      }
      setText(x.val, r.value);
      setTone(x.val, ['bad', 'warn', 'good'], r.valueTone ?? null);
      toggleClass(x.delta, 'hidden', !r.delta);
      if (r.delta) {
        setText(x.arr, arrowOf(r.dir, 1e-12));
        setText(x.dtxt, r.delta);
        setTone(x.delta, ['good', 'bad'], r.tone ?? null);
      }
    }
  }

  on('speed', () => paintSpeed());
  on('newgame', () => {
    lastDay = -1;
    lastRealm = '';
    update(true);
  });
  update(true);
  return { el, update };
}

function daysPerSecond(v: number): string {
  if (v <= 0) return 'paused';
  if (v < 1) return `¼ day`;
  return `${v} day${v === 1 ? '' : 's'}`;
}

/** Hover card for an indicator: value, explanation, one-year sparkline, comparisons. */
function indicatorCard(def: IndDef): HTMLElement[] | null {
  const s = ui.game?.s;
  if (!s) return null;
  const r = def.read(s);
  const series = D(s, def.series);
  const out: HTMLElement[] = [tipTitle(def.title, r.value)];
  out.push(tipNote(def.explain));
  if (series.length > 2) {
    const tail = series.slice(-DAYS_PER_YEAR);
    const tone = r.tone === 'good' ? T.good : r.tone === 'bad' ? T.bad : T.gold;
    out.push(h('div', { class: 'tip-spark' }, sparkCanvas(tail, 260, 38, { color: tone })));
  }
  try {
    out.push(...def.detail(s));
  } catch {
    /* detail keys may be missing early on */
  }
  return out;
}
