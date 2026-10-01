// ============================================================================
// Stat tiles ("KPIs"): label · value · signed delta (arrow + colour by whether
// the direction is good) · optional sparkline · hover explanation.
//
//   const t = kpi({ label: 'Jobless', format: fmtPct, good: 'down', spark: true,
//                   hint: 'Share of people who want work and have none.' });
//   grid.appendChild(t.el);
//   const tr = trend(s.stats.daily.unemp, 30);
//   t.set(tr.now, { delta: tr.delta, deltaFormat: fmtPts, deltaLabel: 'vs 30 days ago', spark: s.stats.daily.unemp });
//
// Colour is never the only cue: deltas always carry an arrow and a sign.
// ============================================================================
import { h, setText, setTone, toggleClass, type Child } from '../dom';
import { DASH, fmtNum, fmtPctSigned } from '../format';
import { sparkline, type Sparkline } from './sparkline';
import { T } from './theme';
import { attachTip, tipNote, tipTitle } from './tooltip';

export type GoodDirection = 'up' | 'down' | null;
export type Tone = 'good' | 'bad' | 'warn' | 'gold' | null;

export interface KpiOptions {
  label: string;
  /** Hover explanation (plain text or a node builder). */
  hint?: string | (() => Child);
  format?: (v: number) => string;
  /** Delta format (default: relative change as signed percent). */
  deltaFormat?: (d: number) => string;
  /** Which direction of change is good (colours the delta). null = neutral. */
  good?: GoodDirection;
  /** Show a sparkline under the value. */
  spark?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** Small suffix after the value ("/day"). */
  unit?: string;
  onClick?: () => void;
}

export interface KpiUpdate {
  /** Change to show (in the units deltaFormat expects). */
  delta?: number | null;
  deltaFormat?: (d: number) => string;
  /** Caption after the delta ("vs last month"). */
  deltaLabel?: string;
  spark?: ArrayLike<number>;
  /** Secondary line under the value. */
  sub?: string;
  /** Force the value's tone (e.g. 'bad' when the Purse is overdrawn). */
  tone?: Tone;
}

export interface Kpi {
  el: HTMLElement;
  set(value: number | null | undefined, u?: KpiUpdate): void;
}

/** Tone for a change given which direction is good. Tiny changes are neutral. */
export function deltaTone(delta: number | null | undefined, good: GoodDirection, eps = 1e-9): Tone {
  if (delta === null || delta === undefined || !Number.isFinite(delta) || Math.abs(delta) <= eps || !good) return null;
  return (delta > 0) === (good === 'up') ? 'good' : 'bad';
}

/** Arrow glyph for a change. */
export function arrowOf(delta: number | null | undefined, eps = 1e-9): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta) || Math.abs(delta) <= eps) return '→';
  return delta > 0 ? '▲' : '▼';
}

export interface Trend {
  now: number;
  prev: number;
  /** now − prev */
  delta: number;
  /** (now − prev) / |prev| (0 when prev is 0) */
  rel: number;
}

/**
 * Latest value vs the value `lookback` points earlier (or the first point
 * when the series is shorter). Non-finite values are skipped. Returns NaNs
 * when the series is empty.
 */
export function trend(series: ArrayLike<number> | undefined | null, lookback = 30): Trend {
  const out: Trend = { now: NaN, prev: NaN, delta: NaN, rel: NaN };
  if (!series || series.length === 0) return out;
  let i = series.length - 1;
  while (i >= 0 && !Number.isFinite(series[i])) i--;
  if (i < 0) return out;
  out.now = series[i];
  let j = Math.max(0, i - lookback);
  while (j < i && !Number.isFinite(series[j])) j++;
  out.prev = series[j];
  out.delta = out.now - out.prev;
  out.rel = out.prev !== 0 ? out.delta / Math.abs(out.prev) : 0;
  return out;
}

/** Mean of the last `n` finite values (NaN when none). */
export function tailMean(series: ArrayLike<number> | undefined | null, n: number, offset = 0): number {
  if (!series) return NaN;
  let s = 0;
  let k = 0;
  for (let i = series.length - 1 - offset; i >= 0 && k < n; i--) {
    const v = series[i];
    if (Number.isFinite(v)) {
      s += v;
      k++;
    }
  }
  return k ? s / k : NaN;
}

export function kpi(opts: KpiOptions): Kpi {
  const valueEl = h('span', { class: 'kpi-value' });
  const unitEl = opts.unit ? h('span', { class: 'kpi-unit' }, opts.unit) : null;
  const arrowEl = h('span', { class: 'kpi-arrow' });
  const deltaEl = h('span', { class: 'kpi-delta-val' });
  const deltaLab = h('span', { class: 'kpi-delta-lab' });
  const delta = h('div', { class: 'kpi-delta' }, arrowEl, deltaEl, deltaLab);
  const sub = h('div', { class: 'kpi-sub' });
  let sp: Sparkline | null = null;
  const el = h(
    opts.onClick ? 'button' : 'div',
    { class: `kpi kpi-${opts.size ?? 'md'}`, type: opts.onClick ? 'button' : null, onClick: opts.onClick ?? null },
    h('div', { class: 'kpi-label' }, opts.label),
    h('div', { class: 'kpi-main' }, valueEl, unitEl),
    delta,
    sub,
  );
  if (opts.spark) {
    sp = sparkline({ height: 26 });
    el.appendChild(h('div', { class: 'kpi-spark' }, sp.el));
  }
  if (opts.hint) {
    const hint = opts.hint;
    el.classList.add('has-hint');
    attachTip(el, () => (typeof hint === 'string' ? [tipTitle(opts.label), tipNote(hint)] : hint()), { placement: 'below' });
  }
  const fmt = opts.format ?? ((v: number) => fmtNum(v));

  return {
    el,
    set(value, u = {}) {
      setText(valueEl, value === null || value === undefined || !Number.isFinite(value) ? DASH : fmt(value));
      setTone(valueEl, ['good', 'bad', 'warn', 'gold'], u.tone ?? null);
      const d = u.delta;
      const hasDelta = d !== undefined && d !== null && Number.isFinite(d);
      toggleClass(delta, 'hidden', !hasDelta);
      if (hasDelta) {
        const df = u.deltaFormat ?? opts.deltaFormat ?? ((x: number) => fmtPctSigned(x));
        setText(arrowEl, arrowOf(d));
        setText(deltaEl, df(d as number));
        setText(deltaLab, u.deltaLabel ?? '');
        setTone(delta, ['good', 'bad'], deltaTone(d, opts.good ?? null));
      }
      setText(sub, u.sub ?? '');
      toggleClass(sub, 'hidden', !u.sub);
      if (sp && u.spark) {
        const tone = hasDelta ? deltaTone(d, opts.good ?? null) : null;
        sp.set(u.spark, tone === 'good' ? T.good : tone === 'bad' ? T.bad : T.ink1);
      }
    },
  };
}

/** Lay tiles out in a responsive grid (`cols` = preferred columns). */
export function kpiGrid(tiles: (Kpi | HTMLElement)[], cols = 3): HTMLElement {
  return h('div', { class: 'kpi-grid', style: { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } }, tiles.map((t) => ('el' in t ? t.el : t)));
}
