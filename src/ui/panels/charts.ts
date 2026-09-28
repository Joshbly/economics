// ============================================================================
// Charts panel — an indicator explorer.
//
//  * Preset groups (Prices, Work, Output, Money, Treasury, People, Trade), each
//    2–4 titled line charts with proper units (charts/groups.ts).
//  * Range: 1 year / 5 years / all. A range that fits in the daily history
//    (≤ 4 years) is drawn from daily figures, otherwise from monthly figures.
//  * "Index to 100": every level series of a chart rebased to 100 at the start
//    of the range (rates and shares stay as they are — they are already relative).
//  * "Your own": pick up to four series from every recorded statistic.
//  * Clicking a top-bar indicator opens Charts on the matching group and chart.
//  * Gold triangles mark Treasury events (policy news: your actions, empty-Purse notices).
// Reads ui.game.s fresh every update; recomputes only when the day or an option
// changes.
// ============================================================================
import './charts/charts.css';
import { monthMode } from '../../sim/stats/stats';
import type { SimState } from '../../sim/types';
import type { Panel } from '../panel';
import { h, setText, toggleClass } from '../dom';
import { fmtDay, fmtIndex, fmtMonth, fmtNum, fmtPctSigned, fmtPts, MINUS } from '../format';
import { ui } from '../uiState';
import {
  attachTip,
  button,
  lineChart,
  segmented,
  selectInput,
  SERIES,
  swatch,
  T,
  tipNote,
  tipTitle,
  toggle,
  type Control,
  type LineChart,
  type LineSeries,
  type Option,
  type Select,
  type XMarker,
} from '../widgets';
import { miniTable, type MiniTable } from './inspector/common';
import { indexBase, indexTo, resolveView, seriesData, summarize, type RangeId, type View } from './charts/data';
import { GROUP_LABELS, GROUPS, INDICATOR_FOCUS, type ChartDef, type GroupId } from './charts/groups';
import { allSeries, indexable, seriesInfo, tick, UNIT_LABEL, unitFormat, unitTick, type Unit } from './charts/series';

// ---------------------------------------------------------------------------
// Persistent options (per viewer, survive new realms)
// ---------------------------------------------------------------------------
interface Opts {
  group: GroupId;
  range: RangeId;
  index: boolean;
  custom: string[];
  customSmooth: number;
}
const STORE = 'realmLedger.charts';
const opts: Opts = loadOpts();

function loadOpts(): Opts {
  const d: Opts = { group: 'prices', range: 'y1', index: false, custom: ['cpi', 'wage', '', ''], customSmooth: 0 };
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return d;
    const o = JSON.parse(raw) as Partial<Opts>;
    if (o && typeof o === 'object') {
      if (GROUP_LABELS.some((g) => g.id === o.group)) d.group = o.group as GroupId;
      if (o.range === 'y1' || o.range === 'y5' || o.range === 'all') d.range = o.range;
      d.index = !!o.index;
      if (Array.isArray(o.custom)) d.custom = [0, 1, 2, 3].map((i) => (typeof o.custom![i] === 'string' ? o.custom![i] : ''));
      if (o.customSmooth === 0 || o.customSmooth === 7 || o.customSmooth === 30) d.customSmooth = o.customSmooth;
    }
  } catch {
    /* storage unavailable */
  }
  return d;
}
function saveOpts(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(opts));
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const finite = (v: number) => typeof v === 'number' && Number.isFinite(v);

/** Change over the range for a unit: relative for levels, points for rates/shares. */
function changeText(unit: Unit | 'indexed', first: number, last: number): { text: string; dir: number } {
  if (!finite(first) || !finite(last)) return { text: '', dir: 0 };
  const d = last - first;
  if (unit === 'rate' || unit === 'share' || unit === 'score') return { text: fmtPts(d), dir: d };
  if (unit === 'coef') return { text: (d >= 0 ? '+' : MINUS) + Math.abs(d).toFixed(2), dir: d };
  if (Math.abs(first) < 1e-9) return { text: '', dir: d };
  return { text: fmtPctSigned(d / Math.abs(first)), dir: d };
}

function policyMarkers(s: SimState, v: View): XMarker[] {
  const out: XMarker[] = [];
  const seen = new Set<number>();
  const news = s.news ?? [];
  for (let i = news.length - 1; i >= 0 && out.length < 80; i--) {
    const n = news[i];
    if (!n || n.kind !== 'policy' || n.day < v.from || n.day > v.to) continue;
    const d = Math.floor(n.day);
    if (seen.has(d)) continue;
    seen.add(d);
    out.push({ x: d, color: T.gold });
  }
  return out;
}

// ---------------------------------------------------------------------------
// One chart card
// ---------------------------------------------------------------------------
interface Card {
  id: string;
  el: HTMLElement;
  update(s: SimState, v: View, sig: string): void;
  destroy(): void;
}

interface CardSpec {
  id: string;
  title: string;
  sub: () => string;
  height: number;
  note?: string;
  /** Build the lines for this view. `unit` = the chart's axis unit (null when mixed). */
  build(s: SimState, v: View): { lines: BuiltLine[]; unit: Unit | null; log?: boolean; zero?: boolean; ref?: { y: number; label?: string }; empty?: string };
}

interface BuiltLine {
  key: string;
  label: string;
  data: number[];
  x0: number;
  xStep: number;
  unit: Unit;
  color: string;
  dashed?: boolean;
  area?: boolean;
  width?: number;
  hidden?: boolean;
}

function makeCard(spec: CardSpec): Card {
  const title = h('div', { class: 'card-title' }, spec.title);
  const sub = h('div', { class: 'card-sub' });
  const nowVal = h('span', { class: 'ch-now-val' });
  const nowArr = h('span', { class: 'ch-now-arr' });
  const nowDelta = h('span', { class: 'ch-now-delta' });
  const now = h('div', { class: 'ch-now', title: 'Latest value · change over the range shown' }, nowVal, h('span', { class: 'ch-now-chg' }, nowArr, nowDelta));
  let figsOpen = false;
  const figBtn = h(
    'button',
    {
      class: 'ch-fig-btn',
      type: 'button',
      title: 'Show the figures behind this chart',
      'aria-pressed': 'false',
      onClick: () => {
        figsOpen = !figsOpen;
        toggleClass(figBtn, 'on', figsOpen);
        figBtn.setAttribute('aria-pressed', String(figsOpen));
        figs.el.hidden = !figsOpen;
        lastSig = '';
        if (lastArgs) update(lastArgs[0], lastArgs[1], lastArgs[2]);
      },
    },
    'Figures',
  );
  const chip = h('span', { class: 'chip ch-chip', hidden: true });
  const head = h('div', { class: 'ch-head' }, h('div', { class: 'ch-titles' }, title, h('div', { class: 'ch-subrow' }, sub, chip)), now, figBtn);
  const chart: LineChart = lineChart({ height: spec.height, label: spec.title });
  const figs: MiniTable = miniTable(
    [
      { label: 'Series', align: 'left', width: '32%' },
      { label: 'Start', width: '13%' },
      { label: 'Low', width: '13%' },
      { label: 'High', width: '13%' },
      { label: 'Now', width: '13%' },
      { label: 'Change', width: '16%', title: 'Over the range shown: relative for levels, in points for rates and shares' },
    ],
    { cls: 'ch-figs', empty: 'No figures yet' },
  );
  figs.el.hidden = true;
  const note = spec.note ? h('div', { class: 'ch-note' }, spec.note) : null;
  const el = h('div', { class: 'card ch-card', dataset: { chart: spec.id } }, head, chart.el, figs.el, note);

  let lastSig = '';
  let lastArgs: [SimState, View, string] | null = null;

  function update(s: SimState, v: View, sig: string): void {
    lastArgs = [s, v, sig];
    const hid = chart.hidden().join(',');
    const full = sig + '|' + hid + '|' + figsOpen;
    if (full === lastSig) return;
    lastSig = full;
    const b = spec.build(s, v);
    const lines = b.lines;

    // chart-level indexing: only when every line can be indexed
    let indexed = false;
    let why = '';
    if (opts.index && lines.length) {
      const bases = lines.map((l) => (indexable(l.unit) ? indexBase(l.data) : NaN));
      if (bases.every((x) => finite(x))) {
        indexed = true;
        lines.forEach((l, i) => (l.data = indexTo(l.data, bases[i])));
      } else why = lines.some((l) => !indexable(l.unit)) ? 'Rates and shares are not indexed' : 'Not indexed: values at or below zero';
    }
    setText(chip, why);
    chip.hidden = !why;

    const axisUnit: Unit | null = indexed ? 'index' : b.unit;
    setText(sub, indexed ? 'index, 100 = start of range' : spec.sub());
    const fmtFor = (u: Unit) => (indexed ? fmtIndex : unitFormat(u));
    const series: LineSeries[] = lines.map((l) => ({
      key: l.key,
      label: l.label,
      data: l.data,
      x0: l.x0,
      xStep: l.xStep,
      color: l.color,
      dashed: l.dashed,
      area: l.area,
      width: l.width,
      hidden: l.hidden,
      format: fmtFor(l.unit),
    }));
    const monthly = lines.some((l) => l.xStep >= 28);
    chart.set(series, {
      x0: lines[0]?.x0 ?? v.from,
      xStep: lines[0]?.xStep ?? 1,
      format: axisUnit ? fmtFor(axisUnit) : (x: number) => fmtNum(x),
      tickFormat: axisUnit && !indexed ? unitTick(axisUnit) : tick,
      log: !!b.log && !indexed,
      zero: !!b.zero && !indexed,
      refLines: indexed ? [{ y: 100, label: '100' }] : b.ref ? [{ y: b.ref.y, label: b.ref.label }] : [],
      markers: policyMarkers(s, v),
      dateFormat: monthly ? fmtMonth : fmtDay,
      legend: lines.length >= 2,
      empty: b.empty ?? (s.day <= (s.startDay ?? 0) + 1 ? 'No history yet — start the clock' : 'No data for this range'),
    });

    // headline for single-series charts
    const single = lines.length === 1;
    now.hidden = !single;
    if (single) {
      const l = lines[0];
      const sm = summarize(l.data);
      setText(nowVal, finite(sm.last) ? fmtFor(l.unit)(sm.last) : '—');
      const ch = changeText(indexed ? 'indexed' : l.unit, sm.first, sm.last);
      setText(nowArr, ch.text ? (ch.dir > 0 ? '▲' : ch.dir < 0 ? '▼' : '→') : '');
      setText(nowDelta, ch.text);
    }

    if (figsOpen) {
      figs.set(
        lines.map((l, i) => {
          const sm = summarize(l.data);
          const f = fmtFor(l.unit);
          const ch = changeText(indexed ? 'indexed' : l.unit, sm.first, sm.last);
          return {
            key: l.key + i,
            cells: [
              { key: l.key + l.color, node: () => h('span', { class: 'ch-fig-lab' }, swatch(l.color, l.dashed ? 'line' : 'dot'), ' ', l.label) },
              f(sm.first),
              f(sm.min),
              f(sm.max),
              f(sm.last),
              ch.text || '—',
            ],
          };
        }),
      );
    }
  }

  return {
    id: spec.id,
    el,
    update,
    destroy() {
      chart.destroy();
      el.remove();
    },
  };
}

/** Card spec for a preset chart definition. */
function presetSpec(def: ChartDef): CardSpec {
  return {
    id: def.id,
    title: def.title,
    height: def.height ?? 148,
    note: def.note,
    sub: () => def.sub ?? UNIT_LABEL[def.unit],
    build(s, v) {
      const lines: BuiltLine[] = def.lines(s).map((ln) => {
        const info = seriesInfo(s, ln.key);
        const unit = ln.unit ?? def.unit;
        const r = seriesData(s, ln.key, v, { smooth: def.smooth, total: def.total, monthlyOnly: !!info.monthlyOnly });
        return { key: ln.key, label: ln.label, data: r.data, x0: r.x0, xStep: r.xStep, unit, color: ln.color ?? SERIES[0], dashed: ln.dashed, area: ln.area, width: ln.width, hidden: ln.hidden };
      });
      return { lines, unit: def.unit, log: def.log, zero: def.zero, ref: def.ref };
    },
  };
}

// ---------------------------------------------------------------------------
// Custom chart builder
// ---------------------------------------------------------------------------
interface Custom {
  el: HTMLElement;
  card: Card;
  refreshOptions(s: SimState): void;
}

function makeCustom(onChange: () => void): Custom {
  const selects: Select<string>[] = [];
  const rows: HTMLElement[] = [];
  for (let i = 0; i < 4; i++) {
    const sel = selectInput<string>({
      options: [{ value: '', label: '— none —' }],
      value: opts.custom[i] ?? '',
      width: '100%',
      title: `Series ${i + 1}`,
      onChange: (v) => {
        opts.custom[i] = v;
        saveOpts();
        onChange();
      },
    });
    selects.push(sel);
    const clear = button({
      label: '×',
      kind: 'ghost',
      size: 'sm',
      title: 'Remove this series',
      onClick: () => {
        opts.custom[i] = '';
        sel.set('');
        saveOpts();
        onChange();
      },
    });
    rows.push(h('div', { class: 'ch-slot' }, h('span', { class: 'ch-slot-key', style: { background: SERIES[i] } }), h('div', { class: 'ch-slot-sel' }, sel.el), clear));
  }
  const smooth: Control<number> = segmented<number>({
    options: [
      { value: 0, label: 'Daily' },
      { value: 7, label: '7-day avg' },
      { value: 30, label: '30-day avg' },
    ],
    value: opts.customSmooth,
    size: 'sm',
    onChange: (v) => {
      opts.customSmooth = v;
      saveOpts();
      onChange();
    },
  });
  const hint = h('div', { class: 'ch-custom-hint' });
  const builder = h(
    'div',
    { class: 'card ch-builder' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, 'Build your own chart'), h('div', { class: 'card-sub' }, 'up to four series')),
    h('div', { class: 'ch-slots' }, rows),
    h('div', { class: 'ch-builder-foot' }, h('span', { class: 'muted small' }, 'Smoothing'), smooth.el),
    hint,
  );

  const spec: CardSpec = {
    id: 'custom',
    title: 'Your chart',
    height: 220,
    sub: () => {
      const units = [...new Set(opts.custom.filter(Boolean).map((k) => seriesInfo(ui.game?.s, k).unit))];
      return units.length === 1 ? UNIT_LABEL[units[0]] : units.length ? 'mixed units' : '';
    },
    build(s, v) {
      const keys = opts.custom.map((k, i) => ({ k, i })).filter((x) => x.k);
      const lines: BuiltLine[] = keys.map(({ k, i }) => {
        const info = seriesInfo(s, k);
        const r = seriesData(s, k, v, { smooth: opts.customSmooth || undefined, perDayMonthly: monthMode(k) === 'sum', monthlyOnly: !!info.monthlyOnly });
        return { key: k + '#' + i, label: info.name, data: r.data, x0: r.x0, xStep: r.xStep, unit: info.unit, color: SERIES[i] };
      });
      const units = [...new Set(lines.map((l) => l.unit))];
      const mixed = units.length > 1;
      let hintText = '';
      if (!lines.length) hintText = 'Pick a series above to draw it.';
      else if (mixed && !opts.index) hintText = 'These series are measured in different units. Switch on “Index to 100” to compare how each has moved.';
      else if (lines.some((l) => seriesInfo(s, l.key.split('#')[0]).monthlyOnly)) hintText = 'Inequality figures are only recorded once a month.';
      setText(hint, hintText);
      hint.hidden = !hintText;
      return { lines, unit: mixed ? null : (units[0] ?? 'count'), zero: false, empty: lines.length ? undefined : 'Choose up to four series above' };
    },
  };
  const card = makeCard(spec);
  const el = h('div', { class: 'ch-custom' }, builder, card.el);

  let optSig = '';
  return {
    el,
    card,
    refreshOptions(s) {
      const all = allSeries(s);
      const sig = all.map((x) => x.key + x.name).join('|');
      if (sig === optSig) return;
      optSig = sig;
      const options: Option<string>[] = [{ value: '', label: '— none —' }, ...all.map((x) => ({ value: x.key, label: x.name, group: x.cat }))];
      selects.forEach((sel, i) => {
        const want = opts.custom[i] ?? '';
        sel.setOptions(options, all.some((x) => x.key === want) ? want : '');
        if (!all.some((x) => x.key === want) && want) opts.custom[i] = '';
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------
let root: HTMLElement | null = null;
let body: HTMLElement | null = null;
let metaEl: HTMLElement | null = null;
let metaText: HTMLElement | null = null;
let marksEl: HTMLElement | null = null;
let lastView: View | null = null;
let blurbEl: HTMLElement | null = null;
let groupBtns: HTMLButtonElement[] = [];
let rangeCtl: Control<RangeId> | null = null;
let indexCtl: Control<boolean> | null = null;
let cards: Card[] = [];
let custom: Custom | null = null;
let builtGroup: GroupId | null = null;
let lastGame: unknown = null;
let pendingFocus: { group: GroupId; chart: string } | null = null;
let optsVersion = 0;

function setGroup(g: GroupId): void {
  if (opts.group === g) return;
  opts.group = g;
  saveOpts();
  paintGroups();
  chartsPanel.update();
  body?.parentElement?.scrollTo?.({ top: 0 });
}

function paintGroups(): void {
  GROUP_LABELS.forEach((g, i) => {
    const b = groupBtns[i];
    if (!b) return;
    toggleClass(b, 'on', g.id === opts.group);
    b.setAttribute('aria-pressed', String(g.id === opts.group));
  });
}

function rebuildBody(s: SimState): void {
  if (!body) return;
  for (const c of cards) c.destroy();
  cards = [];
  custom?.card.destroy();
  custom = null;
  body.textContent = '';
  builtGroup = opts.group;
  if (opts.group === 'custom') {
    custom = makeCustom(() => {
      optsVersion++;
      chartsPanel.update();
    });
    custom.refreshOptions(s);
    body.appendChild(custom.el);
    return;
  }
  const g = GROUPS.find((x) => x.id === opts.group) ?? GROUPS[0];
  for (const def of g.charts) {
    const c = makeCard(presetSpec(def));
    cards.push(c);
    body.appendChild(c.el);
  }
}

function applyFocus(): void {
  const f = pendingFocus;
  pendingFocus = null;
  if (!f) return;
  if (opts.group !== f.group) {
    opts.group = f.group;
    saveOpts();
    paintGroups();
  }
  chartsPanel.update();
  const card = body?.querySelector<HTMLElement>(`[data-chart="${f.chart}"]`);
  if (!card) return;
  requestAnimationFrame(() => {
    const panel = root?.closest('.panel') as HTMLElement | null;
    if (panel) {
      const top = card.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - 8;
      panel.scrollTo({ top: Math.max(0, f.chart === cards[0]?.id ? 0 : top), behavior: 'smooth' });
    }
    card.classList.remove('ch-flash');
    void card.offsetWidth;
    card.classList.add('ch-flash');
    setTimeout(() => card.classList.remove('ch-flash'), 1600);
  });
}

/** Clicks on top-bar indicators: remember which one, so show() can focus its chart. */
function watchIndicators(): void {
  document.addEventListener(
    'click',
    (e) => {
      const btn = (e.target as HTMLElement | null)?.closest?.('.ind') as HTMLElement | null;
      if (!btn) return;
      const key = (btn.getAttribute('aria-label') || btn.querySelector('.ind-lab')?.textContent || '').trim().toLowerCase();
      const f = INDICATOR_FOCUS[key];
      if (f) pendingFocus = f;
    },
    true,
  );
}

export const chartsPanel: Panel = {
  id: 'charts',
  title: 'Charts',
  mount(el) {
    groupBtns = GROUP_LABELS.map((g) =>
      h(
        'button',
        { class: 'ch-group' + (g.id === 'custom' ? ' ch-group-custom' : ''), type: 'button', 'aria-pressed': 'false', onClick: () => setGroup(g.id) },
        g.id === 'custom' ? 'Your own' : g.label,
      ),
    );
    rangeCtl = segmented<RangeId>({
      options: [
        { value: 'y1', label: '1 year', title: 'The last 360 days, day by day' },
        { value: 'y5', label: '5 years', title: 'The last five years' },
        { value: 'all', label: 'All', title: 'Everything since you took charge' },
      ],
      value: opts.range,
      size: 'sm',
      onChange: (v) => {
        opts.range = v;
        saveOpts();
        chartsPanel.update();
      },
    });
    indexCtl = toggle({
      value: opts.index,
      label: 'Index to 100',
      title: 'Rebase every level series to 100 at the start of the range, so different measures can be compared',
      onChange: (v) => {
        opts.index = v;
        saveOpts();
        chartsPanel.update();
      },
    });
    blurbEl = h('div', { class: 'ch-blurb' });
    metaText = h('span');
    marksEl = h('span', { class: 'ch-marks', hidden: true, tabIndex: 0 }, '▼ Treasury events');
    metaEl = h('div', { class: 'ch-meta' }, metaText, marksEl);
    attachTip(
      marksEl,
      () => {
        const s = ui.game?.s;
        const v = lastView;
        if (!s || !v) return null;
        const acts = (s.news ?? []).filter((n) => n && n.kind === 'policy' && n.day >= v.from && n.day <= v.to + 1);
        const last = acts.slice(-8).reverse();
        return [
          tipTitle('The Treasury’s record', `${acts.length} in this range`),
          ...last.map((n) => tipNote(`${fmtDay(n.day)} — ${n.text}`)),
          tipNote(acts.length > last.length ? `…and ${acts.length - last.length} earlier. Gold marks on each chart show the days.` : 'Gold marks on each chart show the days.'),
        ];
      },
      { placement: 'below', delay: 150 },
    );
    body = h('div', { class: 'ch-body' });
    root = h(
      'div',
      { class: 'ch-panel' },
      h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, 'Charts'), h('div', { class: 'card-sub' }, 'the realm over time')),
      h('div', { class: 'ch-groups', role: 'group', 'aria-label': 'Chart groups' }, groupBtns),
      h('div', { class: 'ch-opts' }, rangeCtl.el, h('span', { class: 'spacer' }), indexCtl.el),
      h('div', { class: 'ch-caption' }, blurbEl, metaEl),
      body,
    );
    el.appendChild(root);
    paintGroups();
    watchIndicators();
  },
  show() {
    if (pendingFocus) applyFocus();
  },
  update() {
    const s = ui.game?.s;
    if (!s || !body) return;
    if (lastGame !== s) {
      lastGame = s;
      builtGroup = null; // new realm: rebuild (town names, keys)
    }
    if (builtGroup !== opts.group) rebuildBody(s);
    rangeCtl?.set(opts.range);
    indexCtl?.set(opts.index);
    paintGroups();

    const v = resolveView(s, opts.range);
    const g = GROUPS.find((x) => x.id === opts.group);
    setText(blurbEl!, opts.group === 'custom' ? 'Any figure the realm records, side by side.' : (g?.blurb ?? ''));
    const hasRange = v.to > v.from;
    lastView = v;
    setText(
      metaText!,
      !hasRange
        ? 'No history yet — press Space to start the clock.'
        : `${v.monthly ? 'Monthly' : 'Daily'} figures · ${v.monthly ? fmtMonth(v.from) : fmtDay(v.from)} – ${v.monthly ? fmtMonth(v.to) : fmtDay(v.to)}`,
    );
    const acted = hasRange && (s.news ?? []).some((n) => n.kind === 'policy' && n.day >= v.from);
    if (marksEl!.hidden === acted) marksEl!.hidden = !acted;

    const sig = `${s.day}|${v.from}|${v.to}|${v.monthly}|${opts.index}|${opts.range}|${optsVersion}|${s.news?.length ?? 0}`;
    if (custom) {
      custom.refreshOptions(s);
      custom.card.update(s, v, sig + '|' + opts.custom.join(',') + '|' + opts.customSmooth);
    }
    for (const c of cards) c.update(s, v, sig);
  },
};
