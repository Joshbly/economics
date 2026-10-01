// ============================================================================
// Shared helpers for the Inspect and People panels (owned by the same engineer):
//  * entity links (person / firm / building / town / any Ref) that call select()
//  * where an entity sits on the map (for "Centre on map")
//  * small derived figures computed from plain state (debts, wealth, firm value)
//  * a keyed mini table and a meter bar that update in place (cheap at 4×/s)
// Everything here reads state only; nothing mutates it.
// ============================================================================
import './common.css';
import { GOODS, N_GOODS, SECTORS } from '../../../sim/goods';
import { BANK, FIRM_BASE, FOREIGN, STATE, type Building, type Firm, type Person, type Ref, type Sector, type SimState } from '../../../sim/types';
import { h, setText, toggleClass, type Child } from '../../dom';
import { centerMap, select, type Selection } from '../../uiState';
import type { Tone } from '../../widgets';

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------
export const isFirmRef = (r: Ref): boolean => r >= FIRM_BASE;
export const isPersonRef = (r: Ref): boolean => r >= 0 && r < FIRM_BASE;
export const firmRefOf = (id: number): Ref => FIRM_BASE + id;

export function sectorName(k: Sector | string): string {
  return SECTORS[k as Sector]?.name ?? (k ? String(k) : 'Workshop');
}

/** Short label for a building: "House block", firm name, "Kingsbridge Market Hall"… */
export function buildingLabel(s: SimState, b: Building | undefined): string {
  if (!b) return 'Building';
  const town = s.towns[b.town]?.name ?? '';
  switch (b.kind) {
    case 'house':
      return `House block · ${town}`;
    case 'market':
      return `${town} Market Hall`;
    case 'palace':
      return 'The Palace';
    case 'bank':
      return 'The Bank';
    case 'port':
      return `Port of ${town}`;
    case 'firm': {
      const f = b.firm >= 0 ? s.firms[b.firm] : undefined;
      if (f && f.alive && f.building === b.id) return f.name;
      return `${b.status === 'ruin' ? 'Ruined' : b.status === 'construction' ? 'New' : 'Empty'} ${sectorName(b.sector || '').toLowerCase()}`;
    }
  }
  return 'Building';
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** A text button styled as a link. */
export function linkButton(label: Child, onClick: (e: MouseEvent) => void, title?: string, cls = ''): HTMLButtonElement {
  return h(
    'button',
    {
      class: 'ent-link' + (cls ? ' ' + cls : ''),
      type: 'button',
      title: title ?? null,
      onClick: (e: MouseEvent) => {
        e.stopPropagation();
        onClick(e);
      },
    },
    label,
  );
}

/** A link that selects an entity. */
export function selLink(label: Child, sel: Selection, title?: string, cls = ''): HTMLButtonElement {
  return linkButton(label, () => select(sel), title ?? 'Inspect', cls);
}

export function personLink(s: SimState, id: number): Node {
  const p = id >= 0 ? s.people[id] : undefined;
  if (!p) return document.createTextNode('—');
  return selLink(p.name, { kind: 'person', id }, p.alive ? 'Inspect this household' : 'No longer in the realm', p.alive ? '' : 'gone');
}

export function firmLink(s: SimState, id: number): Node {
  const f = id >= 0 ? s.firms[id] : undefined;
  if (!f) return document.createTextNode('—');
  return selLink(f.name, { kind: 'firm', id }, `${sectorName(f.sector)} · inspect`, f.alive ? '' : 'gone');
}

export function buildingLink(s: SimState, id: number, label?: string): Node {
  const b = id >= 0 ? s.buildings[id] : undefined;
  if (!b) return document.createTextNode('—');
  return selLink(label ?? buildingLabel(s, b), { kind: 'building', id }, 'Inspect this building');
}

export function townLink(s: SimState, id: number): Node {
  const t = id >= 0 ? s.towns[id] : undefined;
  if (!t) return document.createTextNode('—');
  return selLink(t.name, { kind: 'town', id }, 'Inspect this town');
}

/** Link for any agent reference (person, firm, the Treasury, the Bank, foreign merchants). */
export function refLink(s: SimState, r: Ref): Node {
  if (r === STATE) {
    const pal = s.buildings.find((b) => b.kind === 'palace');
    return pal ? selLink('the Treasury', { kind: 'building', id: pal.id }, 'That is you') : document.createTextNode('the Treasury');
  }
  if (r === BANK) {
    const bank = s.buildings.find((b) => b.kind === 'bank');
    return bank ? selLink('the Bank', { kind: 'building', id: bank.id }) : document.createTextNode('the Bank');
  }
  if (r === FOREIGN) return document.createTextNode('foreign merchants');
  if (isFirmRef(r)) return firmLink(s, r - FIRM_BASE);
  if (r >= 0) return personLink(s, r);
  return document.createTextNode('—');
}

/** Stable key for a ref link (so keyed cells rebuild only when the target changes). */
export function refKey(s: SimState, r: Ref): string {
  if (isFirmRef(r)) return 'f' + r + (s.firms[r - FIRM_BASE]?.alive ? '' : 'x');
  if (r >= 0) return 'p' + r + (s.people[r]?.alive ? '' : 'x');
  return 'r' + r;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

function buildingCentre(b: Building | undefined): { x: number; y: number } | null {
  if (!b) return null;
  return { x: b.x + (b.w || 1) / 2, y: b.y + (b.h || 1) / 2 };
}

export function firmPos(s: SimState, f: Firm | undefined): { x: number; y: number } | null {
  if (!f) return null;
  const b = f.building >= 0 ? s.buildings[f.building] : undefined;
  const c = buildingCentre(b);
  if (c) return c;
  const t = s.towns[f.town];
  return t ? { x: t.x, y: t.y } : null;
}

export function personPos(s: SimState, p: Person | undefined): { x: number; y: number } | null {
  if (!p) return null;
  const home = p.home >= 0 ? buildingCentre(s.buildings[p.home]) : null;
  if (home) return home;
  const job = p.job >= 0 ? firmPos(s, s.firms[p.job]) : null;
  if (job) return job;
  const t = s.towns[p.town];
  return t ? { x: t.x, y: t.y } : null;
}

/** Map tile at the centre of a selection, or null. */
export function selectionPos(s: SimState, sel: Selection): { x: number; y: number } | null {
  if (!sel) return null;
  switch (sel.kind) {
    case 'building':
      return buildingCentre(s.buildings[sel.id]);
    case 'firm':
      return firmPos(s, s.firms[sel.id]);
    case 'person':
      return personPos(s, s.people[sel.id]);
    case 'town': {
      const t = s.towns[sel.id];
      return t ? { x: t.x, y: t.y } : null;
    }
    case 'market': {
      const t = s.towns[sel.town];
      const b = t ? s.buildings[t.market] : undefined;
      return buildingCentre(b) ?? (t ? { x: t.x, y: t.y } : null);
    }
  }
  return null;
}

/** Pan the map to a selection. Returns false when it has no place on the map. */
export function centreOn(s: SimState, sel: Selection, zoom?: number): boolean {
  const p = selectionPos(s, sel);
  if (!p) return false;
  centerMap(p.x, p.y, zoom);
  return true;
}

// ---------------------------------------------------------------------------
// Derived figures
// ---------------------------------------------------------------------------

const fin = (x: number | undefined, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
export { fin };

/** Outstanding debt per borrower ref, from the active loan book. */
export function debtMap(s: SimState): Map<Ref, number> {
  const m = new Map<Ref, number>();
  for (const ln of s.loans ?? []) {
    if (!ln || !ln.active) continue;
    m.set(ln.borrower, (m.get(ln.borrower) ?? 0) + Math.max(0, fin(ln.principal)));
  }
  return m;
}

/** Smoothed market price of a good in a town (0 when unknown). */
export function emaPrice(s: SimState, town: number, good: number): number {
  const m = s.markets?.[town * N_GOODS + good];
  return m ? Math.max(0, fin(m.ema, fin(m.price))) : 0;
}

/** A firm's assets at market value: cash + stock + tools + building (before debts). */
export function firmAssetsValue(s: SimState, f: Firm): number {
  let v = Math.max(0, fin(f.cash));
  for (let g = 0; g < N_GOODS; g++) {
    const q = fin(f.inv?.[g]);
    if (q > 0) v += q * emaPrice(s, f.town, g);
  }
  v += Math.max(0, fin(f.tools)) * emaPrice(s, f.town, 7);
  if (f.trade) {
    for (let u = 0; u < (f.trade.stock?.length ?? 0); u++) {
      const st = f.trade.stock[u];
      if (!st || u === f.town) continue;
      for (let g = 0; g < N_GOODS; g++) if (st[g] > 0) v += st[g] * emaPrice(s, u, g);
    }
  }
  const b = f.building >= 0 ? s.buildings[f.building] : undefined;
  if (b && b.firm === f.id) v += Math.max(0, fin(b.cost));
  return v;
}

export interface Wealth {
  /** Deposits + IOUs + gold at today's prices. */
  savings: number;
  /** Savings + houses and workshops owned − debts. */
  net: number;
  property: number;
  debt: number;
}

/** Today's IOU and gold prices (with sane fallbacks). */
export function assetPrices(s: SimState): { iou: number; gold: number } {
  const iou = fin(s.iouMarket?.price, fin(s.stats?.latest?.iouPrice, 100)) || 100;
  const gold = fin(s.foreign?.goldPrice, fin(s.goldMarket?.price, fin(s.stats?.latest?.goldPrice, 0)));
  return { iou, gold };
}

/** Wealth of a household. Pass a debt map and price pair when computing many. */
export function wealthOf(s: SimState, p: Person, debts?: Map<Ref, number>, px = assetPrices(s)): Wealth {
  const savings = Math.max(0, fin(p.cash)) + Math.max(0, fin(p.iou)) * px.iou + Math.max(0, fin(p.gold)) * px.gold;
  let property = 0;
  let debt = debts ? (debts.get(p.id) ?? 0) : 0;
  for (const hid of p.houses ?? []) {
    const b = s.buildings[hid];
    if (b) property += Math.max(0, fin(b.cost));
  }
  for (const fid of p.owns ?? []) {
    const f = s.firms[fid];
    if (!f || !f.alive) continue;
    property += firmAssetsValue(s, f);
    if (debts) debt += debts.get(firmRefOf(fid)) ?? 0;
  }
  return { savings, property, debt, net: savings + property - debt };
}

/** Share of a project's labour done, 0..1. */
export function projectShare(p: { need: { labor: number }; done: { labor: number }; status: string }): number {
  if (p.status === 'done') return 1;
  const need = fin(p.need?.labor);
  return need > 0 ? Math.max(0, Math.min(1, fin(p.done?.labor) / need)) : 0;
}

/** Goods name + unit: "12.5 loaves". */
export function qtyUnit(g: number, q: number, fmt: (v: number) => string): string {
  const d = GOODS[g];
  if (!d) return fmt(q);
  const one = Math.abs(q - 1) < 1e-9;
  return `${fmt(q)} ${one ? d.unit : plural(d.unit)}`;
}

function plural(w: string): string {
  if (/(?:f|fe)$/.test(w) && !/(?:ff|oof)$/.test(w)) return w.replace(/fe?$/, 'ves');
  if (/(?:s|x|z|ch|sh)$/.test(w)) return w + 'es';
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies';
  return w + 's';
}

// ---------------------------------------------------------------------------
// Small in-place DOM pieces
// ---------------------------------------------------------------------------

/** A value slot that can hold text or a keyed node (rebuilt only when its key changes). */
export interface Slot {
  el: HTMLElement;
  text(t: string, tone?: Tone): void;
  node(key: string, build: () => Child, tone?: Tone): void;
}

const TONES = ['good', 'bad', 'warn', 'gold'];

export function slot(tag = 'span', cls = ''): Slot {
  const el = h(tag, { class: cls || null });
  let mode: 'text' | 'node' = 'text';
  let key = '';
  const tone = (t?: Tone) => {
    for (const x of TONES) toggleClass(el, x, x === t);
  };
  return {
    el,
    text(t, tn) {
      if (mode !== 'text') {
        el.textContent = '';
        mode = 'text';
        key = '';
      }
      setText(el, t);
      tone(tn ?? null);
    },
    node(k, build, tn) {
      if (mode !== 'node' || k !== key) {
        mode = 'node';
        key = k;
        el.textContent = '';
        const c = build();
        appendChild(el, c);
      }
      tone(tn ?? null);
    },
  };
}

function appendChild(el: HTMLElement, c: Child): void {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) for (const x of c) appendChild(el, x);
  else if (typeof c === 'string' || typeof c === 'number') el.appendChild(document.createTextNode(String(c)));
  else el.appendChild(c);
}

/** Label/value list whose values update in place. Rows can be hidden. */
export interface KvBlock {
  el: HTMLElement;
  row(label: Child, hint?: string): KvRow;
}
export interface KvRow extends Slot {
  row: HTMLElement;
  show(on: boolean): void;
  label(t: string): void;
}

export function kvBlock(cls = ''): KvBlock {
  const el = h('div', { class: 'kv ent-kv' + (cls ? ' ' + cls : '') });
  return {
    el,
    row(label, hint) {
      const v = slot('span', 'kv-val');
      const lab = h('span', { class: 'kv-lab', title: hint ?? null }, label);
      const row = h('div', { class: 'kv-row' + (hint ? ' has-hint' : '') }, lab, v.el);
      el.appendChild(row);
      return {
        ...v,
        row,
        show(on) {
          if (row.hidden === on) row.hidden = !on;
        },
        label(t) {
          setText(lab, t);
        },
      };
    },
  };
}

/** A thin horizontal meter (0..1) with an optional tone. */
export interface Meter {
  el: HTMLElement;
  set(v: number, tone?: Tone): void;
}
export function meter(cls = ''): Meter {
  const bar = h('i');
  const el = h('span', { class: 'ent-meter' + (cls ? ' ' + cls : '') }, bar);
  let last = -1;
  return {
    el,
    set(v, tone) {
      const f = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
      const pct = Math.round(f * 1000) / 10;
      if (pct !== last) {
        bar.style.width = pct + '%';
        last = pct;
      }
      for (const x of TONES) toggleClass(el, x, x === tone);
    },
  };
}

/** Tone for a 0..1 wellbeing figure. */
export function wellTone(v: number): Tone {
  if (!Number.isFinite(v)) return null;
  return v < 0.4 ? 'bad' : v < 0.65 ? 'warn' : 'good';
}

// ---- keyed mini table ------------------------------------------------------------

export type Cell = string | { key: string; node: () => Child };

export interface MiniCol {
  label: string;
  align?: 'left' | 'right' | 'center';
  width?: string;
  title?: string;
}

export interface MiniRow {
  key: string | number;
  cells: Cell[];
  tones?: (Tone | undefined)[];
  onClick?: () => void;
  title?: string;
  cls?: string;
}

export interface MiniTable {
  el: HTMLElement;
  set(rows: MiniRow[]): void;
}

/** A small table for detail views: rows keyed, cells updated in place, links rebuilt only when their key changes. */
export function miniTable(cols: MiniCol[], opts: { empty?: string; cls?: string; maxHeight?: number } = {}): MiniTable {
  const tbody = h('tbody');
  const thead = h(
    'thead',
    null,
    h(
      'tr',
      null,
      cols.map((c) => h('th', { class: 'al-' + (c.align ?? 'right'), title: c.title ?? null, scope: 'col' }, c.label)),
    ),
  );
  const colgroup = h('colgroup', null, cols.map((c) => h('col', { style: c.width ? { width: c.width } : null })));
  const table = h('table', { class: 'tbl dense ent-tbl' }, colgroup, thead, tbody);
  const empty = h('div', { class: 'tbl-empty', hidden: true }, opts.empty ?? 'Nothing here');
  const el = h('div', { class: 'tbl-wrap ent-tbl-wrap' + (opts.cls ? ' ' + opts.cls : '') }, table, empty);
  if (opts.maxHeight) el.style.maxHeight = opts.maxHeight + 'px';

  interface R {
    tr: HTMLTableRowElement;
    slots: Slot[];
    click?: () => void;
  }
  const rows = new Map<string, R>();
  let order = '';

  tbody.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest('tr');
    const k = tr?.dataset.key;
    if (k === undefined) return;
    rows.get(k)?.click?.();
  });

  return {
    el,
    set(next) {
      const keys = next.map((r) => String(r.key));
      const sig = keys.join('|');
      const seen = new Set<string>();
      for (const r of next) {
        const k = String(r.key);
        seen.add(k);
        let row = rows.get(k);
        if (!row) {
          const slots = cols.map((c) => slot('span'));
          const tds = cols.map((c, i) => h('td', { class: 'al-' + (c.align ?? 'right') }, slots[i].el));
          const tr = h('tr', { dataset: { key: k } }, tds);
          row = { tr, slots };
          rows.set(k, row);
        }
        row.click = r.onClick;
        toggleClass(row.tr, 'clickable-row', !!r.onClick);
        if (r.title !== undefined && row.tr.title !== r.title) row.tr.title = r.title;
        const cls = r.cls ?? '';
        if ((row.tr.dataset.cls ?? '') !== cls) {
          if (row.tr.dataset.cls) row.tr.classList.remove(...row.tr.dataset.cls.split(' ').filter(Boolean));
          if (cls) row.tr.classList.add(...cls.split(' ').filter(Boolean));
          row.tr.dataset.cls = cls;
        }
        r.cells.forEach((c, i) => {
          const sl = row!.slots[i];
          if (!sl) return;
          const tone = r.tones?.[i] ?? null;
          if (typeof c === 'string') sl.text(c, tone);
          else sl.node(c.key, c.node, tone);
          const td = sl.el.parentElement;
          if (td) for (const x of TONES) toggleClass(td, x, x === tone);
        });
      }
      for (const k of [...rows.keys()]) if (!seen.has(k)) rows.delete(k);
      if (sig !== order) {
        order = sig;
        tbody.replaceChildren(...keys.map((k) => rows.get(k)!.tr));
      }
      empty.hidden = next.length > 0;
      table.hidden = next.length === 0;
      toggleClass(el, 'is-empty', next.length === 0);
    },
  };
}

/** Section block with a gold small-caps title and optional right-side extra. */
export function block(title: string, extra?: Child, ...children: Child[]): HTMLElement {
  return h(
    'section',
    { class: 'section ent-sec' },
    h('h3', { class: 'section-title' }, h('span', null, title), extra ? h('span', { class: 'ent-sec-extra' }, extra) : null),
    ...children,
  );
}
