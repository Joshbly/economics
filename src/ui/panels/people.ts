// ============================================================================
// People panel — the realm's households.
//
//   KPIs · towns side by side · employment by trade · distributions of wealth,
//   income and health · the wealthiest households and what they own · every
//   household in a searchable, sortable, virtualised table (click a row to
//   inspect the household and centre the map on its home).
// Heavy figures are derived once per sim day (people/derive.ts); update() is
// otherwise just cheap text/tone refreshes.
// ============================================================================
import './people/people.css';
import type { SimState } from '../../sim/types';
import type { Panel } from '../panel';
import { h, setText, toggleClass } from '../dom';
import { fmtDayLong, fmtIndex, fmtInt, fmtMoneyShort, fmtPct, fmtPrice, fmtPts } from '../format';
import { select, ui } from '../uiState';
import {
  attachTip,
  barChart,
  histogram,
  kpi,
  kpiGrid,
  segmented,
  SERIES,
  T,
  table,
  textInput,
  tipNote,
  tipTitle,
  trend,
  type BarChart,
  type BarRow,
  type Control,
  type Histogram,
  type Kpi,
  type Table,
  type Tone,
} from '../widgets';
import { centreOn, firmLink, linkButton, sectorName, selLink, slot, type Slot } from './inspector/common';
import { derive, quantile, type Derived, type PersonRow } from './people/derive';

type Filter = 'all' | 'working' | 'jobless' | 'homeless' | 'hungry';

let derived: Derived | null = null;
let derivedFor: unknown = null;
let dirtyToken = 0;
let builtToken = -1;

// ---- UI pieces (created in mount) --------------------------------------------------
let subEl: HTMLElement;
let tiles: Record<string, Kpi> = {};
let townsHost: HTMLElement;
let townsTable: TownsTable | null = null;
let sectorBars: BarChart;
let wealthHist: Histogram;
let incomeHist: Histogram;
let healthHist: Histogram;
let wealthMode: Control<'savings' | 'net'>;
let wealthNote: HTMLElement;
let incomeNote: HTMLElement;
let healthNote: HTMLElement;
let topList: HTMLElement;
let topRows = new Map<number, TopRow>();
let tbl: Table<PersonRow>;
let countEl: HTMLElement;
let sectorChip: HTMLElement;
let search = '';
let filter: Filter = 'all';
let sectorFilter = '';
let tableSig = '';
let lastSelId: number | null = null;

// ---------------------------------------------------------------------------
// Towns side by side (transposed: one column per town)
// ---------------------------------------------------------------------------
interface TownsTable {
  el: HTMLElement;
  count: number;
  update(s: SimState, d: Derived): void;
}

interface TownMetric {
  label: string;
  hint: string;
  value: (s: SimState, t: SimState['towns'][number], d: Derived) => number;
  fmt: (v: number) => string;
  /** Which direction is worse, for toning towns that stand out. */
  worse?: 'high' | 'low';
}

const TOWN_METRICS: TownMetric[] = [
  { label: 'Households', hint: 'Households living in the town.', value: (_s, t) => t.pop, fmt: fmtInt },
  { label: 'Jobless', hint: 'Share of the town’s households with no job.', value: (_s, t) => (t.pop > 0 ? t.unemployed / t.pop : NaN), fmt: (v) => fmtPct(v), worse: 'high' },
  { label: 'Open posts', hint: 'Workers the town’s workshops want but have not found.', value: (_s, t) => t.vacancies, fmt: fmtInt },
  { label: 'Homeless', hint: 'Households with no home in the town.', value: (_s, t) => t.homeless, fmt: fmtInt, worse: 'high' },
  {
    label: 'Hungry',
    hint: 'Share of households that ate too little yesterday.',
    value: (_s, t, d) => {
      const x = d.towns[t.id];
      return x && x.pop > 0 ? x.hungry / x.pop : NaN;
    },
    fmt: (v) => fmtPct(v),
    worse: 'high',
  },
  { label: 'Wage', hint: 'Average posted wage per day, weighted by workers.', value: (_s, t) => t.avgWage, fmt: fmtPrice, worse: 'low' },
  { label: 'Rent', hint: 'Average rent per home slot per day.', value: (_s, t) => t.avgRent, fmt: fmtPrice },
  { label: 'Prices', hint: 'The town’s consumer price index (100 = when you took charge).', value: (_s, t) => t.cpi, fmt: fmtIndex, worse: 'high' },
  { label: 'Contentment', hint: 'Average contentment. Low and falling for long → strikes and departures.', value: (_s, t) => t.contentment, fmt: (v) => fmtPct(v), worse: 'low' },
  { label: 'Health', hint: 'Average health. Sick workers produce less.', value: (_s, t) => t.health, fmt: (v) => fmtPct(v), worse: 'low' },
];

function makeTownsTable(s: SimState): TownsTable {
  const towns = s.towns ?? [];
  const head = h(
    'tr',
    null,
    h('th', { class: 'al-left pp-t-corner', scope: 'col' }, ''),
    towns.map((t) =>
      h(
        'th',
        { class: 'al-right', scope: 'col' },
        linkButton(t.name, () => select({ kind: 'town', id: t.id }), `${t.name} — inspect this town`, 'pp-t-town'),
        h('div', { class: 'pp-t-kind' }, t.kind === 'capital' ? 'capital' : t.kind === 'harbor' ? 'harbour' : t.kind === 'mining' ? 'mines' : 'farms'),
      ),
    ),
  );
  const cells: HTMLElement[][] = [];
  const body = TOWN_METRICS.map((m, r) => {
    const lab = h('th', { class: 'al-left pp-t-lab', scope: 'row' }, m.label);
    attachTip(lab, () => [tipTitle(m.label), tipNote(m.hint)], { placement: 'right', delay: 250 });
    cells[r] = towns.map(() => h('td', { class: 'al-right' }));
    return h('tr', null, lab, cells[r]);
  });
  const statusCells = towns.map(() => h('td', { class: 'al-right pp-t-status' }));
  const statusRow = h('tr', { class: 'pp-t-statusrow' }, h('th', { class: 'al-left pp-t-lab', scope: 'row' }, 'Troubles'), statusCells);
  const el = h(
    'div',
    { class: 'tbl-wrap pp-towns-wrap' },
    h('table', { class: 'tbl dense pp-towns' }, h('colgroup', null, h('col', { class: 'pp-t-labcol' }), towns.map(() => h('col'))), h('thead', null, head), h('tbody', null, body, statusRow)),
  );
  const statusSig: (string | null)[] = towns.map(() => null);
  return {
    el,
    count: towns.length,
    update(s2, d) {
      TOWN_METRICS.forEach((m, r) => {
        const vals = (s2.towns ?? []).map((t) => m.value(s2, t, d));
        const fin2 = vals.filter((v) => Number.isFinite(v));
        const mean = fin2.length ? fin2.reduce((a, b) => a + b, 0) / fin2.length : NaN;
        vals.forEach((v, i) => {
          const td = cells[r][i];
          if (!td) return;
          setText(td, Number.isFinite(v) ? m.fmt(v) : '—');
          let tone: Tone = null;
          if (m.worse && Number.isFinite(v) && Number.isFinite(mean) && fin2.length > 1) {
            const rel = mean !== 0 ? (v - mean) / Math.abs(mean) : 0;
            const bad = m.worse === 'high' ? rel > 0.25 : rel < -0.15;
            if (bad && (m.label !== 'Jobless' || v > 0.05) && (m.label !== 'Hungry' || v > 0.05) && (m.label !== 'Homeless' || v >= 3)) tone = 'bad';
          }
          toggleClass(td, 'bad', tone === 'bad');
        });
      });
      (s2.towns ?? []).forEach((t, i) => {
        const td = statusCells[i];
        if (!td) return;
        const parts: [string, string][] = [];
        if (t.strikeDays > 0) parts.push(['bad', 'strike']);
        if (t.droughtDays > 0) parts.push(['warn', 'drought']);
        if (t.unrestDays > 0 && t.strikeDays <= 0) parts.push(['warn', 'unrest']);
        const sig = parts.map((p) => p.join(':')).join(',');
        if (sig === statusSig[i]) return;
        statusSig[i] = sig;
        td.replaceChildren(...(parts.length ? parts.map(([tone, text]) => h('span', { class: 'chip ' + tone + ' pp-chip' }, text)) : [h('span', { class: 'faint' }, 'none')]));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Wealthiest households
// ---------------------------------------------------------------------------
interface TopRow {
  el: HTMLElement;
  rank: HTMLElement;
  value: HTMLElement;
  sub: HTMLElement;
  owns: Slot;
}

function makeTopRow(s: SimState, id: number): TopRow {
  const p = s.people[id];
  const rank = h('span', { class: 'pp-top-rank' });
  const value = h('span', { class: 'pp-top-val' });
  const sub = h('span', { class: 'pp-top-sub' });
  const owns = slot('div', 'pp-top-owns');
  const el = h(
    'div',
    { class: 'pp-top-row' },
    rank,
    h('div', { class: 'pp-top-main' }, h('div', { class: 'pp-top-line' }, selLink(p?.name ?? '—', { kind: 'person', id }, 'Inspect this household', 'pp-top-name'), sub, value), owns.el),
  );
  return { el, rank, value, sub, owns };
}

function updateTop(s: SimState, d: Derived): void {
  const want = d.top.map((x) => x.p.id);
  const seen = new Set(want);
  for (const id of [...topRows.keys()]) if (!seen.has(id)) topRows.delete(id);
  d.top.forEach(({ p, w }, i) => {
    let r = topRows.get(p.id);
    if (!r) topRows.set(p.id, (r = makeTopRow(s, p.id)));
    setText(r.rank, String(i + 1));
    setText(r.value, fmtMoneyShort(w.net));
    setText(r.sub, s.towns[p.town]?.name ?? '');
    const firms = (p.owns ?? []).filter((fid) => s.firms[fid]?.alive);
    const houses = (p.houses ?? []).filter((hid) => s.buildings[hid]);
    const key = firms.join(',') + '|' + houses.length + '|' + Math.round(w.savings) + '|' + Math.round(w.debt);
    r.owns.node(key, () => {
      const parts: (Node | string)[] = [];
      for (const fid of firms.slice(0, 4)) {
        parts.push(h('span', { class: 'pp-own' }, firmLink(s, fid)));
      }
      if (firms.length > 4) parts.push(h('span', { class: 'pp-own muted' }, `+${firms.length - 4} more`));
      if (houses.length) parts.push(h('span', { class: 'pp-own muted' }, houses.length === 1 ? '1 house block' : `${houses.length} house blocks`));
      const liquid = w.savings;
      parts.push(h('span', { class: 'pp-own faint' }, `${fmtMoneyShort(liquid)} in savings${w.debt > 1 ? ` · owes ${fmtMoneyShort(w.debt)}` : ''}`));
      return parts;
    });
  });
  const els = want.map((id) => topRows.get(id)!.el);
  const cur = [...topList.children];
  if (cur.length !== els.length || cur.some((c, i) => c !== els[i])) topList.replaceChildren(...els);
  if (!els.length) topList.replaceChildren(h('div', { class: 'empty' }, 'No households yet.'));
}

// ---------------------------------------------------------------------------
// Households table
// ---------------------------------------------------------------------------
function filteredRows(d: Derived): PersonRow[] {
  const q = search.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  return d.rows.filter((r) => {
    if (filter === 'working' && r.jobless) return false;
    if (filter === 'jobless' && !r.jobless) return false;
    if (filter === 'homeless' && r.home !== 'none') return false;
    if (filter === 'hungry' && !r.hungry) return false;
    if (sectorFilter && r.sector !== sectorFilter) return false;
    for (const t of terms) if (!r.search.includes(t)) return false;
    return true;
  });
}

function refreshTable(force = false): void {
  if (!derived) return;
  const sig = `${derived.day}|${dirtyToken}|${search}|${filter}|${sectorFilter}`;
  if (!force && sig === tableSig) return;
  tableSig = sig;
  const rows = filteredRows(derived);
  lastSelId = ui.selection?.kind === 'person' ? ui.selection.id : null;
  tbl.setSelected(lastSelId);
  tbl.set(rows);
  setText(countEl, rows.length === derived.count ? `${fmtInt(rows.length)} households` : `${fmtInt(rows.length)} of ${fmtInt(derived.count)}`);
  sectorChip.hidden = !sectorFilter;
  if (sectorFilter) sectorChip.firstChild!.textContent = sectorName(sectorFilter) + ' ';
}

function setSectorFilter(k: string): void {
  sectorFilter = sectorFilter === k ? '' : k;
  refreshTable(true);
  if (sectorFilter) {
    const panel = tbl.el.closest('.panel') as HTMLElement | null;
    const target = tbl.el.parentElement?.parentElement ?? tbl.el;
    if (panel) {
      const top = target.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - 8;
      panel.scrollTo({ top, behavior: 'smooth' });
    }
  }
}

/** Money in at most ~5 characters for narrow columns: ¤4.25 · ¤42.5 · ¤425 · ¤4.2k · ¤42k · ¤4.2M. */
function tinyMoney(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  let t: string;
  if (a < 10) t = a.toFixed(2);
  else if (a < 100) t = a.toFixed(1);
  else if (a < 1000) t = a.toFixed(0);
  else if (a < 1e4) t = (a / 1e3).toFixed(1) + 'k';
  else if (a < 1e6) t = (a / 1e3).toFixed(0) + 'k';
  else if (a < 1e7) t = (a / 1e6).toFixed(1) + 'M';
  else t = (a / 1e6).toFixed(0) + 'M';
  return sign + '¤' + t;
}

/** Two-line table cell: main text over a muted sub line. */
function two(a: string, b: string, tone?: 'warn'): HTMLElement {
  return h('div', { class: 'pp-c2' }, h('div', { class: 'pp-c2a' + (tone ? ' ' + tone : '') }, a), h('div', { class: 'pp-c2b' }, b || '\u00a0'));
}

/**
 * Two-line cells are cached per household and column and updated in place, so
 * the virtualised table re-renders without rebuilding DOM (cheap at 4×/s).
 */
interface Cell2 {
  el: HTMLElement;
  a: HTMLElement;
  b: HTMLElement;
}
let cellCache = new Map<string, Cell2>();
function cachedTwo(key: string, a: string, b: string, tone?: 'warn'): HTMLElement {
  let c = cellCache.get(key);
  if (!c) {
    const el = two(a, b, tone);
    c = { el, a: el.firstChild as HTMLElement, b: el.lastChild as HTMLElement };
    cellCache.set(key, c);
  }
  setText(c.a, a);
  setText(c.b, b || '\u00a0');
  toggleClass(c.a, 'warn', tone === 'warn');
  return c.el;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------
function section(title: string, extra: HTMLElement | null, ...children: (HTMLElement | null)[]): HTMLElement {
  return h('section', { class: 'section pp-sec' }, h('h3', { class: 'section-title' }, h('span', null, title), extra ? h('span', { class: 'pp-sec-extra' }, extra) : null), ...children);
}

function histCard(title: string, control: HTMLElement | null, hist: Histogram, noteEl: HTMLElement): HTMLElement {
  return h('div', { class: 'card pp-hist' }, h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, title), control), hist.el, noteEl);
}

function paintDistributions(d: Derived): void {
  const net = wealthMode.value === 'net';
  const vals = net ? d.net : d.savings;
  const med = net ? d.medianNet : d.medianSavings;
  wealthHist.set(vals, { markers: Number.isFinite(med) && med > 0 ? [{ x: med, label: 'median' }] : [] });
  const zero = vals.filter((v) => !(v > 0)).length;
  setText(
    wealthNote,
    `Median ${fmtMoneyShort(med)} · richest tenth from ${fmtMoneyShort(quantile(vals, 0.9))}${zero ? ` · ${fmtInt(zero)} with nothing` : ''}. ` +
      (net ? 'Savings plus houses and workshops owned, less debts.' : 'Deposits, IOUs and gold at today’s prices.'),
  );
  const inc = d.income;
  const hi = quantile(inc, 0.98);
  const lo = Math.min(0, quantile(inc, 0));
  const medInc = quantile(inc, 0.5);
  incomeHist.set(inc, { min: lo, max: Number.isFinite(hi) && hi > lo ? hi : undefined, markers: Number.isFinite(medInc) ? [{ x: medInc, label: 'median' }] : [] });
  setText(incomeNote, `Median ${fmtPrice(medInc)} a day · top 2% above ${fmtPrice(hi)} (gathered in the last column). Wages, dividends, rent, interest and payments received.`);
  const hs = d.health;
  const mean = hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : NaN;
  healthHist.set(hs, { min: 0, max: 1, markers: Number.isFinite(mean) ? [{ x: mean, label: 'mean' }] : [] });
  const weak = hs.filter((v) => v < 0.4).length;
  setText(healthNote, `Average ${fmtPct(mean)} · ${fmtInt(weak)} household${weak === 1 ? '' : 's'} below 40%. Hunger and cold wear health down; sick workers produce less.`);
}

export const peoplePanel: Panel = {
  id: 'people',
  title: 'People',
  mount(el) {
    subEl = h('div', { class: 'card-sub' });
    const k = (key: string, o: Parameters<typeof kpi>[0]) => (tiles[key] = kpi({ size: 'sm', spark: true, ...o }));
    k('pop', { label: 'Households', format: fmtInt, good: 'up', hint: 'Households living in the realm. Each has one worker — unless it lives on what its capital brings in. Changes on these tiles are over the last 30 days.' });
    k('jobless', { label: 'Jobless', format: (v) => fmtPct(v), good: 'down', deltaFormat: fmtPts, hint: 'Share of the households that work or look for work with no job. Those living on their means (interest, dividends, rents of three times a wage or more) look for none and are not counted.' });
    k('hungry', { label: 'Hungry', format: (v) => fmtPct(v), good: 'down', deltaFormat: fmtPts, hint: 'Share of households that ate too little yesterday.' });
    k('homeless', { label: 'Homeless', format: fmtInt, good: 'down', deltaFormat: (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + fmtInt(Math.abs(x)), hint: 'Households with no roof. They take the cheapest vacant slot they can afford.' });
    k('health', { label: 'Health', format: (v) => fmtPct(v), good: 'up', deltaFormat: fmtPts, hint: 'Average health. It falls with hunger and cold, and lowers what a worker can make. “Weak” = below 40%.' });
    k('content', { label: 'Contentment', format: (v) => fmtPct(v), good: 'up', deltaFormat: fmtPts, hint: 'Average contentment: food, warmth, work, home, comforts and income. Long misery brings strikes and departures. “Unhappy” = below 30%.' });
    k('gini', { label: 'Wealth Gini', format: (v) => v.toFixed(2), good: 'down', deltaFormat: (x) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2), hint: 'Inequality of wealth, measured monthly: 0 = everyone equal, 1 = one household holds everything.' });
    k('median', { label: 'Savings', format: fmtMoneyShort, good: 'up', spark: false, hint: 'The median: half of households hold less than this in deposits, IOUs and gold.' });

    townsHost = h('div');
    sectorBars = barChart({ format: fmtInt, rowHeight: 22, onClick: (row) => row.key && row.key !== 'none' && row.key !== 'means' && setSectorFilter(String(row.key)) });
    wealthMode = segmented<'savings' | 'net'>({
      options: [
        { value: 'savings', label: 'Savings', title: 'Deposits, IOUs and gold' },
        { value: 'net', label: 'Net worth', title: 'Savings plus property, less debts' },
      ],
      value: 'savings',
      size: 'sm',
      onChange: () => derived && paintDistributions(derived),
    });
    wealthHist = histogram({ height: 130, bins: 22, log: true, format: fmtMoneyShort, unit: 'households', color: SERIES[0] });
    incomeHist = histogram({ height: 120, bins: 22, format: fmtMoneyShort, unit: 'households', color: SERIES[2] });
    healthHist = histogram({ height: 110, bins: 20, min: 0, max: 1, format: (v) => fmtPct(v), unit: 'households', color: SERIES[6] });
    wealthNote = h('div', { class: 'pp-hnote' });
    incomeNote = h('div', { class: 'pp-hnote' });
    healthNote = h('div', { class: 'pp-hnote' });
    topList = h('div', { class: 'pp-top' });

    const searchIn = textInput({
      value: '',
      placeholder: 'Search by name, town or trade…',
      onChange: (v) => {
        search = v;
        refreshTable();
      },
    });
    searchIn.input.classList.add('pp-search');
    searchIn.input.type = 'search';
    const filters = segmented<Filter>({
      options: [
        { value: 'all', label: 'All' },
        { value: 'working', label: 'Working' },
        { value: 'jobless', label: 'Jobless' },
        { value: 'homeless', label: 'Homeless' },
        { value: 'hungry', label: 'Hungry' },
      ],
      value: 'all',
      size: 'sm',
      full: true,
      onChange: (v) => {
        filter = v;
        refreshTable();
      },
    });
    countEl = h('span', { class: 'pp-count' });
    sectorChip = h('button', { class: 'chip gold pp-sector-chip', type: 'button', title: 'Clear the trade filter', hidden: true, onClick: () => setSectorFilter(sectorFilter) }, 'Trade ', h('span', { 'aria-hidden': 'true' }, '×'));

    tbl = table<PersonRow>({
      columns: [
        {
          key: 'name',
          label: 'Household',
          value: (r) => r.name,
          format: (_v: never, r: PersonRow) => cachedTwo('n' + r.id, r.name, r.townName),
          align: 'left',
          width: '27%',
          title: 'Name and town (sorts by name — type a town in the search box to narrow it down)',
        },
        {
          key: 'work',
          label: 'Work',
          value: (r) => (r.jobless ? 'zz' + String(1e6 + r.unempDays) : r.work),
          format: (_v: never, r: PersonRow) => (r.jobless ? cachedTwo('w' + r.id, 'Jobless', `${fmtInt(r.unempDays)} ${Math.round(r.unempDays) === 1 ? 'day' : 'days'}`, 'warn') : cachedTwo('w' + r.id, r.work, r.firmName)),
          align: 'left',
          width: '21%',
          title: 'Trade and workplace, or how long without work',
        },
        { key: 'wage', label: 'Wage', value: (r) => r.wage, format: (v: never) => (Number.isFinite(v as number) ? tinyMoney(v as number) : '—'), width: '13%', title: 'Posted wage per day' },
        { key: 'cash', label: 'Cash', value: (r) => r.cash, format: (v: never) => tinyMoney(v as number), width: '13%', title: 'Bank deposit' },
        { key: 'health', label: 'Health', value: (r) => r.health, format: (v: never) => fmtPct(v as number, 0), tone: (r) => (r.health < 0.4 ? 'bad' : r.health < 0.65 ? 'warn' : null), width: '13%' },
        {
          key: 'home',
          label: 'Home',
          value: (r) => (r.home === 'none' ? 0 : r.home === 'rents' ? 1 : 2),
          format: (_v: never, r: PersonRow) => (r.home === 'none' ? 'none' : r.home === 'owns' ? 'own' : 'rent'),
          tone: (r) => (r.home === 'none' ? 'bad' : null),
          width: '13%',
          align: 'right',
          title: 'Renting, living in a house they own, or homeless',
        },
      ],
      rowKey: (r) => r.id,
      onRowClick: (r) => {
        const s = ui.game?.s;
        select({ kind: 'person', id: r.id });
        if (s) centreOn(s, { kind: 'person', id: r.id });
      },
      maxHeight: 420,
      rowHeight: 34,
      sort: { key: 'cash', dir: -1 },
      empty: 'No household matches.',
    });

    el.appendChild(
      h(
        'div',
        { class: 'pp-panel' },
        h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, 'People'), subEl),
        kpiGrid(Object.values(tiles), 4),
        section('Towns', null, townsHost),
        section('Work by trade', h('span', { class: 'muted' }, 'click a bar to list its workers'), h('div', { class: 'card pp-bars' }, sectorBars.el)),
        section(
          'Distributions',
          null,
          h(
            'div',
            { class: 'pp-hists' },
            histCard('Wealth', wealthMode.el, wealthHist, wealthNote),
            histCard('Income per day', null, incomeHist, incomeNote),
            histCard('Health', null, healthHist, healthNote),
          ),
        ),
        section('The wealthiest', h('span', { class: 'muted' }, 'by net worth'), topList),
        section(
          'Every household',
          countEl,
          h('div', { class: 'pp-filters' }, searchIn.el, filters.el, sectorChip),
          h('div', { class: 'pp-hh' }, tbl.el),
          h('div', { class: 'pp-foot' }, 'Click a household to inspect it and find its home on the map.'),
        ),
      ),
    );
  },
  update() {
    const s = ui.game?.s;
    if (!s || !tbl) return;
    const fresh = derivedFor !== s || !derived || derived.day !== s.day || builtToken !== dirtyToken;
    if (fresh) {
      if (derivedFor !== s) {
        cellCache = new Map();
        townsTable = null;
        topRows = new Map();
        topList.textContent = '';
        sectorFilter = '';
      }
      derivedFor = s;
      builtToken = dirtyToken;
      derived = derive(s);
      const d = derived;
      if (!townsTable || townsTable.count !== (s.towns?.length ?? 0)) {
        townsTable = makeTownsTable(s);
        townsHost.replaceChildren(townsTable.el);
      }
      townsTable.update(s, d);
      paintKpis(s, d);
      const rows: BarRow[] = d.sectors
        .map((r): BarRow => ({
          key: r.sector,
          label: sectorName(r.sector),
          sub: r.sector === 'stateworks' ? 'yours' : `${r.firms} ${r.firms === 1 ? 'site' : 'sites'}`,
          value: r.workers,
          color: r.sector === 'stateworks' ? T.gold : undefined,
          hint: sectorFilter === r.sector ? 'Click again to show every household' : 'Click to list these workers below',
        }))
        .sort((a, b) => b.value - a.value);
      rows.push({ key: 'none', label: 'Without work', sub: '', value: d.jobless, color: T.ink3, hint: 'Households looking for work' });
      if (d.ofMeans > 0) rows.push({ key: 'means', label: 'Of independent means', sub: '', value: d.ofMeans, color: T.gold, hint: 'Households living on what their capital brings in: they look for no work' });
      sectorBars.set(rows, { highlight: sectorFilter || null });
      paintDistributions(d);
      updateTop(s, d);
      setText(subEl, `${fmtInt(d.count)} households · ${fmtDayLong(s.day)}`);
    }
    refreshTable();
    const selId = ui.selection?.kind === 'person' ? ui.selection.id : null;
    if (selId !== lastSelId) {
      lastSelId = selId;
      tbl.setSelected(selId);
    }
  },
};

function paintKpis(s: SimState, d: Derived): void {
  const D = s.stats?.daily ?? {};
  const L = s.stats?.latest ?? {};
  const lat = (k: string, fallback: number) => (Number.isFinite(L[k]) ? L[k] : fallback);
  const tr = (k: string) => trend(D[k], 30);
  const n = (x: number, one: string, many: string) => `${fmtInt(x)} ${Math.round(x) === 1 ? one : many}`;
  const pop = tr('pop');
  tiles.pop.set(lat('pop', d.count), { delta: Number.isFinite(pop.rel) ? pop.rel : null, spark: D.pop, sub: n(s.towns?.length ?? 0, 'town', 'towns') });
  const un = tr('unemp');
  const force = d.count - d.ofMeans;
  tiles.jobless.set(lat('unemp', force ? d.jobless / force : NaN), { delta: un.delta, spark: D.unemp, sub: `${fmtInt(d.jobless)} of ${fmtInt(force)}${d.ofMeans > 0 ? ` · ${fmtInt(d.ofMeans)} of means` : ''}` });
  const hu = tr('hunger');
  tiles.hungry.set(lat('hunger', d.count ? d.hungry / d.count : NaN), { delta: hu.delta, spark: D.hunger, sub: `${fmtInt(d.hungry)} of ${fmtInt(d.count)}`, tone: lat('hunger', 0) > 0.15 ? 'bad' : null });
  const ho = tr('homeless');
  const hr = lat('homelessRate', NaN);
  tiles.homeless.set(lat('homeless', NaN), { delta: ho.delta, spark: D.homeless, sub: Number.isFinite(hr) ? `${fmtPct(hr)} of all` : undefined });
  const he = tr('health');
  tiles.health.set(lat('health', NaN), { delta: he.delta, spark: D.health, sub: `${fmtInt(d.weak)} weak` });
  const co = tr('content');
  tiles.content.set(lat('content', NaN), { delta: co.delta, spark: D.content, sub: `${fmtInt(d.unhappy)} unhappy` });
  const M = s.stats?.monthly?.gini ?? [];
  const gi = trend(M, 3);
  tiles.gini.set(Number.isFinite(L.gini) ? L.gini : gi.now, { delta: M.length > 1 ? gi.delta : null, spark: M.length > 1 ? M : [], sub: M.length ? 'monthly' : 'at month end' });
  tiles.median.set(d.medianSavings, { sub: `avg ${fmtMoneyShort(d.meanSavings)}` });
}

/** Force a re-derive on the next update (e.g. after an action). */
export function peopleDirty(): void {
  dirtyToken++;
}
