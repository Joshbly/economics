// ============================================================================
// Ledger panel — shared helpers: series access, smoothing, small DOM builders
// (cards, a T-account, a meter) used by the four ledger views.
// ============================================================================
import type { SimState } from '../../../sim/types';
import { h, replace, setText, setTone, toggleClass, type Child } from '../../dom';
import { segmented, tipNote, tipTitle, type Control, type Tone } from '../../widgets';
import { attachSideTip } from '../markets/sidetip';

/** A finite number or the fallback. */
export function fin(x: unknown, d = 0): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : d;
}

/** Latest value of a stats indicator (NaN when missing). */
export function L(s: SimState, k: string): number {
  const v = s.stats?.latest?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
}

const EMPTY: number[] = [];
/** A daily stats series (empty when missing). */
export function D(s: SimState, k: string): number[] {
  return s.stats?.daily?.[k] ?? EMPTY;
}

/** Day index of daily[k][0]. */
export function x0(s: SimState): number {
  return fin(s.stats?.dailyStart, 0);
}

/** Mean of the last n finite values (NaN when none), optionally skipping the newest `offset`. */
export function meanLast(a: ArrayLike<number> | undefined | null, n: number, offset = 0): number {
  if (!a || !a.length) return NaN;
  let sum = 0;
  let k = 0;
  for (let i = a.length - 1 - offset; i >= 0 && k < n; i--) {
    const v = a[i];
    if (Number.isFinite(v)) {
      sum += v;
      k++;
    }
  }
  return k ? sum / k : NaN;
}

/** Trailing moving average (window w), same length as the input. */
export function smooth(a: ArrayLike<number>, w: number): number[] {
  const out: number[] = new Array(a.length);
  let sum = 0;
  let k = 0;
  const q: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    q.push(v);
    if (Number.isFinite(v)) {
      sum += v;
      k++;
    }
    if (q.length > w) {
      const o = q.shift()!;
      if (Number.isFinite(o)) {
        sum -= o;
        k--;
      }
    }
    out[i] = k ? sum / k : NaN;
  }
  return out;
}

// ---------------------------------------------------------------------------
// DOM builders
// ---------------------------------------------------------------------------

/** A card with title (+ sub) on the left and an optional control on the right. */
export function card(title: string, sub: Child, right: HTMLElement | null, ...body: Child[]): HTMLElement {
  return h(
    'div',
    { class: 'card ldg-card' },
    h('div', { class: 'card-head' }, h('div', { class: 'ldg-card-titles' }, h('div', { class: 'card-title' }, title), sub ? h('div', { class: 'card-sub' }, sub) : null), right),
    ...body,
  );
}

export type RangeDays = 90 | 360 | 1440;

/** 3M / 1Y / All range selector. */
export function rangeControl(value: RangeDays, onChange: (v: RangeDays) => void): Control<RangeDays> {
  return segmented<RangeDays>({
    options: [
      { value: 90, label: '3M' },
      { value: 360, label: '1Y' },
      { value: 1440, label: 'All' },
    ],
    value,
    size: 'sm',
    onChange,
  });
}

// ---- T-account ---------------------------------------------------------------------

export interface TRow {
  key: string;
  label: string;
  value: number;
  /** Secondary text under the label. */
  sub?: string;
  hint?: string;
  tone?: Tone;
  color?: string;
}

export interface TAccount {
  el: HTMLElement;
  set(left: TRow[], right: TRow[], opts: { leftTotal: number; rightTotal: number; scale?: number }): void;
}

/**
 * Two-column account (e.g. Assets | Liabilities & equity). Each row: label,
 * value, and a bar scaled to the larger column total, so both sides of an
 * identity read at a glance.
 */
export function tAccount(leftTitle: string, rightTitle: string, fmt: (v: number) => string, totalLabels: [string, string] = ['Total', 'Total']): TAccount {
  const lBody = h('div', { class: 'ldg-t-body' });
  const rBody = h('div', { class: 'ldg-t-body' });
  const lTot = h('span', { class: 'ldg-t-totv' });
  const rTot = h('span', { class: 'ldg-t-totv' });
  const el = h(
    'div',
    { class: 'ldg-t' },
    h('div', { class: 'ldg-t-col' }, h('div', { class: 'ldg-t-head' }, leftTitle), lBody, h('div', { class: 'ldg-t-tot' }, h('span', null, totalLabels[0]), lTot)),
    h('div', { class: 'ldg-t-col' }, h('div', { class: 'ldg-t-head' }, rightTitle), rBody, h('div', { class: 'ldg-t-tot' }, h('span', null, totalLabels[1]), rTot)),
  );
  interface RowEls {
    el: HTMLElement;
    lab: HTMLElement;
    sub: HTMLElement;
    val: HTMLElement;
    bar: HTMLElement;
    row: TRow;
  }
  const pools: [Map<string, RowEls>, Map<string, RowEls>] = [new Map(), new Map()];
  let sigs = ['', ''];

  function paint(side: 0 | 1, rows: TRow[], scale: number): void {
    const body = side === 0 ? lBody : rBody;
    const pool = pools[side];
    const sig = rows.map((r) => r.key).join('|');
    if (sig !== sigs[side]) {
      sigs[side] = sig;
      const els: HTMLElement[] = [];
      for (const r of rows) {
        let e = pool.get(r.key);
        if (!e) {
          const lab = h('span', { class: 'ldg-t-lab' });
          const sub = h('span', { class: 'ldg-t-sub' });
          const val = h('span', { class: 'ldg-t-val' });
          const bar = h('i', { class: 'ldg-t-bar' });
          const rowEl = h('div', { class: 'ldg-t-row' }, h('div', { class: 'ldg-t-line' }, h('span', { class: 'ldg-t-labs' }, lab, sub), val), h('div', { class: 'ldg-t-track' }, bar));
          const holder: RowEls = { el: rowEl, lab, sub, val, bar, row: r };
          attachSideTip(rowEl, () => (holder.row.hint ? [tipTitle(holder.row.label), tipNote(holder.row.hint)] : null));
          pool.set(r.key, (e = holder));
        }
        els.push(e.el);
      }
      replace(body, els);
    }
    for (const r of rows) {
      const e = pool.get(r.key)!;
      e.row = r;
      setText(e.lab, r.label);
      setText(e.sub, r.sub ?? '');
      toggleClass(e.sub, 'hidden', !r.sub);
      setText(e.val, fmt(r.value));
      setTone(e.val, ['good', 'bad', 'warn', 'gold'], r.tone ?? (r.value < -1e-9 ? 'bad' : null));
      const f = scale > 0 && Number.isFinite(r.value) ? Math.min(1, Math.abs(r.value) / scale) : 0;
      e.bar.style.width = (f * 100).toFixed(2) + '%';
      e.bar.style.background = r.color ?? '';
      toggleClass(e.bar, 'neg', r.value < -1e-9);
    }
  }

  return {
    el,
    set(left, right, o) {
      const scale = o.scale ?? Math.max(Math.abs(o.leftTotal), Math.abs(o.rightTotal), 1e-9);
      paint(0, left, scale);
      paint(1, right, scale);
      setText(lTot, fmt(o.leftTotal));
      setText(rTot, fmt(o.rightTotal));
      setTone(lTot, ['bad'], o.leftTotal < -1e-9 ? 'bad' : null);
      setTone(rTot, ['bad'], o.rightTotal < -1e-9 ? 'bad' : null);
    },
  };
}

// ---- meter ---------------------------------------------------------------------------------

export interface Meter {
  el: HTMLElement;
  /** value and a threshold marker, both in [0, max]. */
  set(value: number, opts: { max: number; mark?: number; text: string; tone?: Tone; markLabel?: string }): void;
}

/** A thin horizontal meter with an optional threshold tick (e.g. capital ratio vs its minimum). */
export function meter(label: string, hint?: string): Meter {
  const fill = h('i', { class: 'ldg-meter-fill' });
  const mark = h('i', { class: 'ldg-meter-mark' });
  const markLab = h('span', { class: 'ldg-meter-marklab' });
  const val = h('span', { class: 'ldg-meter-val' });
  const el = h(
    'div',
    { class: 'ldg-meter' },
    h('div', { class: 'ldg-meter-line' }, h('span', { class: 'ldg-meter-lab' }, label), val),
    h('div', { class: 'ldg-meter-track' }, fill, mark, markLab),
  );
  if (hint) attachSideTip(el, () => [tipTitle(label), tipNote(hint)]);
  return {
    el,
    set(v, o) {
      const f = o.max > 0 && Number.isFinite(v) ? Math.max(0, Math.min(1, v / o.max)) : 0;
      fill.style.width = (f * 100).toFixed(2) + '%';
      setTone(fill, ['good', 'bad', 'warn', 'gold'], o.tone ?? null);
      setTone(val, ['good', 'bad', 'warn', 'gold'], o.tone ?? null);
      setText(val, o.text);
      const hasMark = o.mark !== undefined && Number.isFinite(o.mark) && o.max > 0;
      mark.hidden = !hasMark;
      markLab.hidden = !hasMark || !o.markLabel;
      if (hasMark) {
        const m = Math.max(0, Math.min(1, (o.mark as number) / o.max));
        mark.style.left = (m * 100).toFixed(2) + '%';
        markLab.style.left = (m * 100).toFixed(2) + '%';
        setText(markLab, o.markLabel ?? '');
      }
    },
  };
}

/** Plain explanatory paragraph under a chart. */
export function foot(...children: Child[]): HTMLElement {
  return h('p', { class: 'note ldg-foot' }, ...children);
}
