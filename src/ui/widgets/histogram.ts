// ============================================================================
// Histogram (canvas): distribution of a value across agents (wealth, wages,
// health…).
//
//   const hist = histogram({ bins: 24, log: true, format: fmtMoneyShort, unit: 'households' });
//   el.appendChild(hist.el);
//   hist.set(people.map((p) => p.cash), { markers: [{ x: median, label: 'median' }] });
//
// `log: true` uses log-spaced bins (right-skewed data such as wealth); values
// ≤ 0 then collect in a separate leftmost "≤ 0" bin. Columns are separated by a
// 2px surface gap with 4px rounded tops. Hover a column for its range and count.
// ============================================================================
import { h } from '../dom';
import { fmtInt, fmtNum, fmtPct } from '../format';
import { createCanvasHost, pillText, roundRect, snap, type CanvasHost } from './canvas';
import { fmtTick, logTicks, niceTicks, scaleLinear } from './axis';
import { drawEmpty } from './linechart';
import { alpha, font, lighten, SERIES, T } from './theme';
import { hideTip, showTip, tipKV, tipTitle } from './tooltip';

export interface HistMarker {
  x: number;
  label?: string;
  color?: string;
}

export interface HistogramOptions {
  height?: number; // default 160
  bins?: number; // default 20
  log?: boolean;
  /** Clamp the binned range (values outside go to the end bins). */
  min?: number;
  max?: number;
  /** Format of x values (ticks & tooltip). */
  format?: (v: number) => string;
  color?: string;
  markers?: HistMarker[];
  /** What is being counted ("people"). */
  unit?: string;
  empty?: string;
}

export interface Bins {
  /** Bin edges, length counts.length + 1 (log bins: edges[0] may be 0 for the "≤ 0" bin). */
  edges: number[];
  counts: number[];
  /** Index of the "≤ 0" bin in log mode, or -1. */
  zeroBin: number;
  total: number;
}

/** Bin values into `n` bins (linear or log-spaced). Non-finite values are ignored. */
export function binValues(values: ArrayLike<number>, n: number, log = false, min?: number, max?: number): Bins {
  n = Math.max(1, Math.min(200, Math.floor(n)));
  let lo = Infinity;
  let hi = -Infinity;
  let nonPos = 0;
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    total++;
    if (log && v <= 0) {
      nonPos++;
      continue;
    }
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (min !== undefined && Number.isFinite(min) && (!log || min > 0)) lo = min;
  if (max !== undefined && Number.isFinite(max)) hi = max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return log && nonPos ? { edges: [0, 0], counts: [nonPos], zeroBin: 0, total } : { edges: [0, 1], counts: [0], zeroBin: -1, total };
  }
  if (hi <= lo) hi = lo + (log ? lo : Math.max(1, Math.abs(lo) * 0.1));
  const edges: number[] = [];
  if (log) {
    const l0 = Math.log(lo);
    const l1 = Math.log(hi);
    for (let i = 0; i <= n; i++) edges.push(Math.exp(l0 + ((l1 - l0) * i) / n));
  } else {
    // snap the linear range to a nice step so bin edges are round numbers
    const t = niceTicks(lo, hi, n);
    const step = (t.max - t.min) / n;
    for (let i = 0; i <= n; i++) edges.push(t.min + step * i);
  }
  const counts = new Array(n).fill(0);
  const a = edges[0];
  const b = edges[n];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v) || (log && v <= 0)) continue;
    let k: number;
    if (v <= a) k = 0;
    else if (v >= b) k = n - 1;
    else if (log) k = Math.floor(((Math.log(v) - Math.log(a)) / (Math.log(b) - Math.log(a))) * n);
    else k = Math.floor(((v - a) / (b - a)) * n);
    counts[Math.max(0, Math.min(n - 1, k))]++;
  }
  if (log && nonPos > 0) return { edges: [0, ...edges], counts: [nonPos, ...counts], zeroBin: 0, total };
  return { edges, counts, zeroBin: -1, total };
}

export interface Histogram {
  el: HTMLElement;
  set(values: ArrayLike<number>, opts?: Partial<HistogramOptions>): void;
  /** Supply pre-computed bins instead of raw values. */
  setBins(bins: Bins, opts?: Partial<HistogramOptions>): void;
  destroy(): void;
}

export function histogram(initial: HistogramOptions = {}): Histogram {
  let o: HistogramOptions = { height: 160, bins: 20, ...initial };
  let bins: Bins | null = null;
  let hoverBin = -1;
  let hoverPos = { cx: 0, cy: 0 };
  let L: { left: number; right: number; top: number; bottom: number; colW: number } | null = null;
  const root = h('div', { class: 'chart chart-hist' });
  const host: CanvasHost = createCanvasHost({
    height: o.height,
    draw,
    onMove: (x, _y, e) => {
      hoverPos = { cx: e.clientX, cy: e.clientY };
      let next = -1;
      if (L && bins && x >= L.left && x <= L.right) next = Math.min(bins.counts.length - 1, Math.floor((x - L.left) / L.colW));
      if (next !== hoverBin) {
        hoverBin = next;
        host.redraw();
      }
      if (hoverBin >= 0) tip();
      else hideTip(root);
    },
    onLeave: () => {
      hoverBin = -1;
      hideTip(root);
      host.redraw();
    },
  });
  root.appendChild(host.el);
  const fmt = () => o.format ?? ((v: number) => fmtNum(v));

  function tip(): void {
    if (!bins || hoverBin < 0) return;
    const i = hoverBin;
    const c = bins.counts[i];
    const range = i === bins.zeroBin ? '≤ 0' : `${fmt()(bins.edges[i])} – ${fmt()(bins.edges[i + 1])}`;
    showTip([tipTitle(range), tipKV(o.unit ? capital(o.unit) : 'Count', fmtInt(c)), tipKV('Share', fmtPct(bins.total ? c / bins.total : 0))], hoverPos.cx, hoverPos.cy, root);
  }

  function draw(ctx: CanvasRenderingContext2D, w: number, hh: number): void {
    L = null;
    if (!bins || bins.total === 0) {
      drawEmpty(ctx, w, hh, o.empty ?? 'No data yet');
      return;
    }
    const dpr = host.dpr;
    const n = bins.counts.length;
    const top = 16;
    const bottom = hh - 22;
    const maxC = Math.max(1, ...bins.counts);
    const yt = niceTicks(0, maxC, Math.max(2, Math.min(4, Math.round((bottom - top) / 36))));
    ctx.font = font(10.5);
    const labW = Math.max(...yt.ticks.map((t) => ctx.measureText(fmtTick(t, yt.step)).width));
    const left = Math.ceil(labW + 12);
    const right = w - 8;
    const colW = (right - left) / n;
    L = { left, right, top, bottom, colW };
    const Y = scaleLinear(0, yt.max, bottom, top);

    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of yt.ticks) {
      const y = snap(Y(t), dpr);
      ctx.strokeStyle = t === 0 ? T.axis : T.grid;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.fillStyle = T.ink2;
      ctx.fillText(fmtTick(t, yt.step), left - 7, Y(t));
    }

    const base = o.color ?? SERIES[0];
    const gap = colW >= 6 ? 2 : colW >= 3 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const c = bins.counts[i];
      if (c <= 0) continue;
      const x = left + i * colW + gap / 2;
      const y = Y(c);
      const bw = Math.max(0.5, colW - gap);
      ctx.fillStyle = i === hoverBin ? lighten(base, 0.18) : i === bins.zeroBin ? alpha(base, 0.55) : base;
      roundRect(ctx, x, y, bw, bottom - y, [Math.min(4, bw / 2), Math.min(4, bw / 2), 0, 0]);
      ctx.fill();
    }

    // x ticks at round values (log: 1-2-5 per decade), positioned on the continuous scale
    const e0 = bins.zeroBin === 0 ? 1 : 0;
    const a = bins.edges[e0];
    const b = bins.edges[n];
    const xOfV = (v: number): number => {
      const fx = o.log ? (v > 0 && a > 0 ? (Math.log(v) - Math.log(a)) / (Math.log(b) - Math.log(a) || 1) : NaN) : (v - a) / (b - a || 1);
      return left + e0 * colW + fx * (n - e0) * colW;
    };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = T.ink2;
    const want = Math.max(2, Math.floor((right - left) / 70));
    const tk = o.log && a > 0 ? logTicks(a, b, want) : niceTicks(a, b, want);
    let lastR = -Infinity;
    const tickAt = (x: number, lab: string) => {
      const tw = ctx.measureText(lab).width;
      const lx = Math.max(left + tw / 2, Math.min(right - tw / 2, x));
      if (lx - tw / 2 < lastR + 8) return;
      ctx.strokeStyle = T.axis;
      ctx.beginPath();
      ctx.moveTo(snap(x, dpr), bottom);
      ctx.lineTo(snap(x, dpr), bottom + 4);
      ctx.stroke();
      ctx.fillText(lab, lx, bottom + 6);
      lastR = lx + tw / 2;
    };
    if (e0 === 1) tickAt(left + colW / 2, '≤0');
    for (const t of tk.ticks) {
      if (t < a - 1e-9 || t > b + 1e-9) continue;
      const x = xOfV(t);
      if (Number.isFinite(x)) tickAt(x, fmt()(t));
    }

    // markers (median, mean, a threshold…)
    for (const m of o.markers ?? []) {
      if (!Number.isFinite(m.x) || m.x < a || m.x > b) continue;
      const xm = xOfV(m.x);
      if (!Number.isFinite(xm)) continue;
      const x = snap(xm, dpr);
      ctx.strokeStyle = m.color ?? T.gold;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, top - 2);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      if (m.label) {
        ctx.font = font(10, 600);
        pillText(ctx, m.label, x, top - 6, { align: 'center', fill: m.color ?? T.goldHi, bg: alpha(T.bg2, 0.92), h: 14 });
      }
    }
  }

  return {
    el: root,
    set(values, patch) {
      if (patch) o = { ...o, ...patch };
      if (patch?.height !== undefined) host.setHeight(patch.height);
      bins = binValues(values, o.bins ?? 20, !!o.log, o.min, o.max);
      host.redraw();
    },
    setBins(b, patch) {
      if (patch) o = { ...o, ...patch };
      if (patch?.height !== undefined) host.setHeight(patch.height);
      bins = b;
      host.redraw();
    },
    destroy() {
      hideTip(root);
      host.destroy();
      root.remove();
    },
  };
}

function capital(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
