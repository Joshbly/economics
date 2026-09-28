// ============================================================================
// Compact sortable table (DOM). Built for refresh-heavy panels: rows and cells
// are pooled and only touched when their text changes, and long tables are
// virtualised (only visible rows exist), so a 1 000-person list can refresh 4×/s.
//
//   const tbl = table<Person>({
//     columns: [
//       { key: 'name', label: 'Name', value: (p) => p.name, align: 'left' },
//       { key: 'cash', label: 'Cash', value: (p) => p.cash, format: fmtMoney },
//     ],
//     rowKey: (p) => p.id,
//     onRowClick: (p) => select({ kind: 'person', id: p.id }),
//     maxHeight: 360,
//     sort: { key: 'cash', dir: -1 },
//   });
//   el.appendChild(tbl.el);
//   tbl.set(people);                 // in update()
// ============================================================================
import { h, setText, toggleClass } from '../dom';
import { fmtNum } from '../format';
import type { Tone } from './kpi';

export interface Column<R> {
  key: string;
  label: string;
  /** Sort value and default display value. */
  value: (r: R) => number | string;
  /** Display (string or a node, e.g. a colour swatch). Default: numbers via fmtNum. */
  format?: (v: never, r: R) => string | Node;
  /** Default: right for numeric columns, left otherwise. */
  align?: 'left' | 'right' | 'center';
  /** CSS width, e.g. '84px' or '30%'. */
  width?: string;
  sortable?: boolean;
  /** Header tooltip. */
  title?: string;
  /** Colour a cell by meaning (good/bad/warn/gold). */
  tone?: (r: R) => Tone;
}

export interface TableOptions<R> {
  columns: Column<R>[];
  rowKey: (r: R) => string | number;
  onRowClick?: (r: R) => void;
  /** Initial sort. */
  sort?: { key: string; dir: 1 | -1 };
  /** Scroll inside the table beyond this height (px). Long tables are virtualised. */
  maxHeight?: number;
  /** Row height in px (used for virtualisation; default 26). */
  rowHeight?: number;
  empty?: string;
  selected?: string | number | null;
  /** Tighter rows (22px). */
  dense?: boolean;
}

export interface Table<R> {
  el: HTMLElement;
  set(rows: readonly R[]): void;
  setSelected(key: string | number | null): void;
  sortBy(key: string, dir?: 1 | -1): void;
  /** Rows in current display order. */
  rows(): readonly R[];
}

const VIRTUAL_MIN = 120;

/** Compare two sort values: numbers numerically (non-finite last), strings naturally. */
export function compareValues(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') {
    const fa = Number.isFinite(a);
    const fb = Number.isFinite(b);
    if (!fa || !fb) return fa === fb ? 0 : fa ? -1 : 1;
    return a - b;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Stable sort of rows by a column value. */
export function sortRows<R>(rows: readonly R[], value: (r: R) => number | string, dir: 1 | -1): R[] {
  const idx = rows.map((r, i) => ({ r, i, v: value(r) }));
  idx.sort((x, y) => {
    const c = compareValues(x.v, y.v);
    // non-finite numbers stay last in both directions
    if (typeof x.v === 'number' && typeof y.v === 'number' && (!Number.isFinite(x.v) || !Number.isFinite(y.v))) return c || x.i - y.i;
    return c * dir || x.i - y.i;
  });
  return idx.map((x) => x.r);
}

export function table<R>(opts: TableOptions<R>): Table<R> {
  const rh = opts.rowHeight ?? (opts.dense ? 22 : 26);
  let sort = opts.sort ?? null;
  let data: readonly R[] = [];
  let view: R[] = [];
  let selected = opts.selected ?? null;
  const cols = opts.columns;

  const colgroup = h('colgroup', null, cols.map((c) => h('col', { style: c.width ? { width: c.width } : null })));
  const ths = cols.map((c) =>
    h(
      'th',
      {
        class: 'al-' + (c.align ?? 'right') + (c.sortable === false ? '' : ' sortable'),
        title: c.title ?? null,
        scope: 'col',
        onClick: c.sortable === false ? null : () => onHeader(c),
      },
      h('span', { class: 'th-lab' }, c.label),
      h('span', { class: 'th-sort', 'aria-hidden': 'true' }),
    ),
  );
  const thead = h('thead', null, h('tr', null, ths));
  const tbody = h('tbody');
  const tbl = h('table', { class: 'tbl' + (opts.dense ? ' dense' : '') + (opts.onRowClick ? ' clickable' : '') }, colgroup, thead, tbody);
  const emptyEl = h('div', { class: 'tbl-empty', hidden: true }, opts.empty ?? 'Nothing here yet');
  const wrap = h('div', { class: 'tbl-wrap' }, tbl, emptyEl);
  if (opts.maxHeight) wrap.style.maxHeight = opts.maxHeight + 'px';
  const topPad = h('tr', { class: 'tbl-pad', 'aria-hidden': 'true' }, h('td', { colSpan: cols.length }));
  const botPad = h('tr', { class: 'tbl-pad', 'aria-hidden': 'true' }, h('td', { colSpan: cols.length }));

  interface PooledRow {
    tr: HTMLTableRowElement;
    tds: HTMLTableCellElement[];
    idx: number;
  }
  const pool: PooledRow[] = [];

  tbody.addEventListener('click', (e) => {
    if (!opts.onRowClick) return;
    const tr = (e.target as HTMLElement).closest('tr');
    if (!tr || tr.classList.contains('tbl-pad')) return;
    const i = Number(tr.dataset.idx);
    if (Number.isInteger(i) && view[i] !== undefined) opts.onRowClick(view[i]);
  });

  let scrollPending = false;
  wrap.addEventListener('scroll', () => {
    if (view.length < VIRTUAL_MIN || scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => {
      scrollPending = false;
      render();
    });
  });

  function onHeader(c: Column<R>): void {
    if (sort && sort.key === c.key) sort = { key: c.key, dir: sort.dir === 1 ? -1 : 1 };
    else {
      const sample = data.length ? c.value(data[0]) : 0;
      sort = { key: c.key, dir: typeof sample === 'number' ? -1 : 1 };
    }
    wrap.scrollTop = 0;
    apply();
  }

  function paintHeader(): void {
    cols.forEach((c, i) => {
      const on = !!sort && sort.key === c.key;
      toggleClass(ths[i], 'sorted', on);
      setText(ths[i].lastChild as HTMLElement, on ? (sort!.dir === 1 ? '▲' : '▼') : '');
      ths[i].setAttribute('aria-sort', on ? (sort!.dir === 1 ? 'ascending' : 'descending') : 'none');
    });
  }

  function apply(): void {
    const col = sort ? cols.find((c) => c.key === sort!.key) : undefined;
    view = col && sort ? sortRows(data, col.value, sort.dir) : [...data];
    paintHeader();
    render();
  }

  function makeRow(): PooledRow {
    const tds = cols.map((c) => h('td', { class: 'al-' + (c.align ?? 'right') }));
    const tr = h('tr', { style: { height: rh + 'px' } }, tds);
    return { tr, tds, idx: -1 };
  }

  function fillRow(pr: PooledRow, i: number): void {
    const r = view[i];
    pr.idx = i;
    if (pr.tr.dataset.idx !== String(i)) pr.tr.dataset.idx = String(i);
    toggleClass(pr.tr, 'sel', selected !== null && opts.rowKey(r) === selected);
    for (let k = 0; k < cols.length; k++) {
      const c = cols[k];
      const td = pr.tds[k];
      const v = c.value(r);
      const out = c.format ? c.format(v as never, r) : typeof v === 'number' ? fmtNum(v) : v;
      if (typeof out === 'string') {
        if (td.firstChild && td.firstChild.nodeType !== 3) td.textContent = out;
        else setText(td, out);
      } else if (td.firstChild !== out) td.replaceChildren(out);
      const tone = c.tone ? c.tone(r) : null;
      const want = 'al-' + (c.align ?? 'right') + (tone ? ' ' + tone : '');
      if (td.className !== want) td.className = want;
    }
  }

  function render(): void {
    const n = view.length;
    emptyEl.hidden = n > 0;
    tbl.hidden = false;
    let start = 0;
    let end = n;
    const virtual = n >= VIRTUAL_MIN && !!opts.maxHeight;
    if (virtual) {
      const headH = thead.offsetHeight || rh;
      const top = Math.max(0, wrap.scrollTop - headH);
      const visible = Math.ceil((opts.maxHeight ?? 400) / rh) + 1;
      start = Math.max(0, Math.floor(top / rh) - 6);
      end = Math.min(n, start + visible + 12);
    }
    const count = end - start;
    while (pool.length < count) pool.push(makeRow());
    // rebuild tbody membership only when the count changes
    const want = count + (virtual ? 2 : 0);
    if (tbody.childElementCount !== want || (virtual && tbody.firstChild !== topPad) || (!virtual && tbody.firstChild === topPad)) {
      const frag = document.createDocumentFragment();
      if (virtual) frag.appendChild(topPad);
      for (let i = 0; i < count; i++) frag.appendChild(pool[i].tr);
      if (virtual) frag.appendChild(botPad);
      tbody.replaceChildren(frag);
    }
    if (virtual) {
      (topPad.firstChild as HTMLElement).style.height = start * rh + 'px';
      (botPad.firstChild as HTMLElement).style.height = (n - end) * rh + 'px';
    }
    for (let i = 0; i < count; i++) fillRow(pool[i], start + i);
  }

  paintHeader();
  return {
    el: wrap,
    set(rows) {
      data = rows;
      apply();
    },
    setSelected(key) {
      selected = key;
      render();
    },
    sortBy(key, dir) {
      sort = { key, dir: dir ?? (sort?.key === key ? (sort.dir === 1 ? -1 : 1) : -1) };
      apply();
    },
    rows: () => view,
  };
}
