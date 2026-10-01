// ============================================================================
// Multi-series time chart (canvas).
//
//   const chart = lineChart({ height: 180, format: fmtIndex });
//   panel.appendChild(chart.el);
//   // in update():
//   chart.set([
//     { label: 'Prices', data: s.stats.daily.cpi, color: SERIES[0] },
//     { label: 'Wages', data: s.stats.daily.wage, axis: 'right', format: fmtMoney },
//   ], { x0: s.stats.dailyStart });
//
// X axis = day index (x0 + i·xStep; use xStep 30 for monthly series) with
// calendar labels ("Y3", "M6"). Features: nice y ticks, optional log scale,
// optional right axis (prefer indexing to a common base where you can — two
// y-scales invite false correlations), area fill, dashed series, reference
// lines, vertical event markers, gaps for NaN / non-finite values, min/max
// decimation per pixel column (smooth with 4k+ points), hover crosshair with
// one tooltip listing every visible series, and a clickable legend (click =
// toggle, shift/alt-click = show only this one) that also shows latest values.
// Colours follow the entity: pass `color` (or rely on the fixed SERIES order by
// position) and keep it stable across updates.
// ============================================================================
import { h, replace, setText, toggleClass } from '../dom';
import { fmtDay, fmtMonth, fmtNum } from '../format';
import { createCanvasHost, pillText, snap, type CanvasHost } from './canvas';
import { dayTicks, fmtTick, logTicks, niceTicks, scaleLinear, scaleLog, type Ticks } from './axis';
import { alpha, font, SERIES, T } from './theme';
import { hideTip, showTip, tipRow, tipTitle } from './tooltip';

export interface LineSeries {
  label: string;
  data: ArrayLike<number>;
  /** Stable identity for legend toggling (default: label). */
  key?: string;
  /** Series colour (default: SERIES[position]). */
  color?: string;
  axis?: 'left' | 'right';
  /** Soft wash under the line (to zero, or to the plot bottom if zero is out of range). */
  area?: boolean;
  dashed?: boolean;
  /** Line width in CSS px (default 2; 1.5 for dashed). */
  width?: number;
  /** Start hidden (the legend can show it). */
  hidden?: boolean;
  /** Tooltip / legend value format (default: the axis format). */
  format?: (v: number) => string;
  /** Per-series x origin / step if it differs from the chart's. */
  x0?: number;
  xStep?: number;
}

export interface RefLine {
  y: number;
  label?: string;
  color?: string;
  axis?: 'left' | 'right';
  /** Default true (dashed reads as "threshold", not data). */
  dashed?: boolean;
}

export interface XMarker {
  /** Day index. */
  x: number;
  label?: string;
  color?: string;
}

export interface LineChartOptions {
  /** Canvas height in CSS px (legend sits above, outside it). Default 180. */
  height?: number;
  /** Day index of data[0]. Default 0. */
  x0?: number;
  /** Days per data point (1 for daily series, 30 for monthly). Default 1. */
  xStep?: number;
  /** Show only the last N days. */
  window?: number;
  /** Left-axis value format for tooltips/legend. */
  format?: (v: number) => string;
  /** Left-axis tick label format (default: fmtTick, decimals matched to the step). */
  tickFormat?: (v: number, step: number) => string;
  rightFormat?: (v: number) => string;
  rightTickFormat?: (v: number, step: number) => string;
  /** Log scale on the left axis (non-positive values become gaps). */
  log?: boolean;
  /** Include zero in the left / right domain. */
  zero?: boolean;
  rightZero?: boolean;
  /** Fixed domain bounds (left axis). */
  yMin?: number;
  yMax?: number;
  refLines?: RefLine[];
  markers?: XMarker[];
  /** Legend row above the plot. Default: shown when there are ≥ 2 series. */
  legend?: boolean;
  /** Show each series' latest value in the legend. Default true. */
  legendValues?: boolean;
  /** Empty-state text. */
  empty?: string;
  /** Tooltip header for a day (default: fmtDay, or fmtMonth when xStep ≥ 30). */
  dateFormat?: (day: number) => string;
  /** Accessible label for the canvas. */
  label?: string;
}

export interface LineChart {
  el: HTMLElement;
  /** Replace the series (and optionally patch options). Cheap to call every refresh. */
  set(series: LineSeries[], opts?: Partial<LineChartOptions>): void;
  /** Patch options and redraw. */
  options(opts: Partial<LineChartOptions>): void;
  /** Keys of series hidden via the legend. */
  hidden(): string[];
  destroy(): void;
}

interface AxisLayout {
  ticks: Ticks;
  map: (v: number) => number;
  log: boolean;
  fmt: (v: number) => string;
  tickFmt: (v: number, step: number) => string;
}

interface Layout {
  left: number;
  right: number;
  top: number;
  bottom: number;
  xd0: number;
  xd1: number;
  xOf: (day: number) => number;
  yl: AxisLayout | null;
  yr: AxisLayout | null;
}

const keyOf = (s: LineSeries) => s.key ?? s.label;

/** Create a line chart. See file header for usage. */
export function lineChart(initial: LineChartOptions = {}): LineChart {
  let o: LineChartOptions = { height: 180, legendValues: true, ...initial };
  let series: LineSeries[] = [];
  const hiddenKeys = new Set<string>();
  const seenKeys = new Set<string>();
  let layout: Layout | null = null;
  let hover: { x: number; y: number; cx: number; cy: number } | null = null;
  let sig = '';

  const legend = h('div', { class: 'chart-legend' });
  const root = h('div', { class: 'chart chart-line' }, legend);
  const host: CanvasHost = createCanvasHost({
    height: o.height,
    label: o.label,
    draw,
    overlay: drawOverlay,
    onMove: (x, y, e) => {
      hover = { x, y, cx: e.clientX, cy: e.clientY };
      host.redrawOverlay();
    },
    onLeave: () => {
      hover = null;
      hideTip(root);
      host.redrawOverlay();
    },
  });
  root.appendChild(host.el);

  const colorOf = (s: LineSeries, i: number) => s.color ?? SERIES[i % SERIES.length];
  const visible = (s: LineSeries) => !hiddenKeys.has(keyOf(s));
  const fmtFor = (s: LineSeries) => s.format ?? (s.axis === 'right' ? o.rightFormat : o.format) ?? ((v: number) => fmtNum(v));
  const x0Of = (s: LineSeries) => s.x0 ?? o.x0 ?? 0;
  const stepOf = (s: LineSeries) => s.xStep ?? o.xStep ?? 1;

  // ---- legend --------------------------------------------------------------
  let legendKeys = '';
  let legendItems: { item: HTMLElement; val: HTMLElement; key: string }[] = [];

  function buildLegend(): void {
    const show = o.legend ?? series.length >= 2;
    toggleClass(legend, 'hidden', !show);
    const keys = series.map((s, i) => keyOf(s) + '|' + colorOf(s, i) + '|' + (s.axis ?? '') + '|' + (s.area ? 1 : 0) + (s.dashed ? 1 : 0)).join('§');
    if (keys !== legendKeys) {
      legendKeys = keys;
      legendItems = series.map((s, i) => {
        const key = keyOf(s);
        const val = h('span', { class: 'lg-val' });
        const item = h(
          'button',
          {
            class: 'lg-item',
            type: 'button',
            title: 'Click to show/hide · Shift-click to show only this' + (s.axis === 'right' ? ' · plotted on the right axis' : ''),
            onClick: (e: MouseEvent) => toggle(key, e.shiftKey || e.altKey),
          },
          h('span', { class: 'lg-key' + (s.area ? ' lg-key-area' : '') + (s.dashed ? ' lg-key-dash' : ''), style: { color: colorOf(s, i) } }),
          h('span', { class: 'lg-lab' }, s.label),
          s.axis === 'right' ? h('span', { class: 'lg-axis', title: 'right axis' }, 'R') : null,
          val,
        );
        return { item, val, key };
      });
      replace(legend, legendItems.map((x) => x.item));
    }
    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      const li = legendItems[i];
      if (!li) continue;
      toggleClass(li.item, 'off', hiddenKeys.has(li.key));
      if (o.legendValues !== false) {
        const v = lastFinite(s.data);
        setText(li.val, v === null ? '' : fmtFor(s)(v));
      } else setText(li.val, '');
    }
  }

  function toggle(key: string, solo: boolean): void {
    if (solo) {
      const onlyThis = series.every((s) => keyOf(s) === key || hiddenKeys.has(keyOf(s))) && !hiddenKeys.has(key);
      hiddenKeys.clear();
      if (!onlyThis) for (const s of series) if (keyOf(s) !== key) hiddenKeys.add(keyOf(s));
    } else if (hiddenKeys.has(key)) hiddenKeys.delete(key);
    else {
      hiddenKeys.add(key);
      if (series.every((s) => hiddenKeys.has(keyOf(s)))) hiddenKeys.clear();
    }
    sig = '';
    buildLegend();
    host.redraw();
  }

  // ---- layout ----------------------------------------------------------------
  function computeLayout(ctx: CanvasRenderingContext2D, w: number, hh: number): Layout | null {
    // X domain from ALL series (hidden too) so toggling never shifts the axis.
    let xd0 = Infinity;
    let xd1 = -Infinity;
    for (const s of series) {
      const n = s.data.length;
      if (!n) continue;
      const a = x0Of(s);
      const b = a + (n - 1) * stepOf(s);
      if (a < xd0) xd0 = a;
      if (b > xd1) xd1 = b;
    }
    if (!Number.isFinite(xd0)) return null;
    if (o.window && o.window > 0) xd0 = Math.max(xd0, xd1 - o.window);
    if (xd1 - xd0 < 1) xd1 = xd0 + 1;

    const top = 10;
    const bottom = hh - 22;
    const plotH = Math.max(10, bottom - top);
    const count = Math.max(2, Math.min(7, Math.round(plotH / 36)));

    const axisFor = (side: 'left' | 'right'): AxisLayout | null => {
      const isRight = side === 'right';
      const log = !isRight && !!o.log;
      let lo = Infinity;
      let hi = -Infinity;
      let any = false;
      for (const s of series) {
        if ((s.axis === 'right') !== isRight || !visible(s)) continue;
        const a = x0Of(s);
        const st = stepOf(s);
        const n = s.data.length;
        const i0 = Math.max(0, Math.ceil((xd0 - a) / st - 1e-9));
        const i1 = Math.min(n - 1, Math.floor((xd1 - a) / st + 1e-9));
        for (let i = i0; i <= i1; i++) {
          const v = s.data[i];
          if (!Number.isFinite(v) || (log && v <= 0)) continue;
          any = true;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      const hasSeries = series.some((s) => (s.axis === 'right') === isRight);
      if (!hasSeries) return null;
      for (const r of o.refLines ?? []) {
        if ((r.axis === 'right') !== isRight || !Number.isFinite(r.y) || (log && r.y <= 0)) continue;
        if (!any) {
          lo = hi = r.y;
          any = true;
        }
        lo = Math.min(lo, r.y);
        hi = Math.max(hi, r.y);
      }
      if (!any) {
        lo = 0;
        hi = 1;
      }
      if (!isRight) {
        if (o.yMin !== undefined && Number.isFinite(o.yMin)) lo = o.yMin;
        if (o.yMax !== undefined && Number.isFinite(o.yMax)) hi = o.yMax;
      }
      if ((isRight ? o.rightZero : o.zero) && !log) {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
      }
      let ticks: Ticks;
      if (log) ticks = logTicks(lo, hi, count);
      else {
        // pad 4 % so lines never sit on the frame, then snap to nice steps
        const pad = (hi - lo) * 0.04;
        const zeroed = (isRight ? o.rightZero : o.zero) ?? false;
        ticks = niceTicks(zeroed && lo >= 0 ? lo : lo - pad, zeroed && hi <= 0 ? hi : hi + pad, count);
        if (lo >= 0 && ticks.min < 0) ticks = niceTicks(0, hi + pad, count);
      }
      const map = log ? scaleLog(ticks.min, ticks.max, bottom, top) : scaleLinear(ticks.min, ticks.max, bottom, top);
      const fmt = (isRight ? o.rightFormat : o.format) ?? ((v: number) => fmtNum(v));
      const tickFmt = (isRight ? o.rightTickFormat : o.tickFormat) ?? fmtTick;
      return { ticks, map, log, fmt, tickFmt };
    };

    const yl = axisFor('left');
    const yr = axisFor('right');
    ctx.font = font(10.5);
    const labW = (ax: AxisLayout | null) => (ax ? Math.max(...ax.ticks.ticks.map((t) => ctx.measureText(ax.tickFmt(t, ax.ticks.step)).width), 0) : 0);
    const left = Math.max(28, Math.ceil(labW(yl) + 12));
    const right = w - (yr ? Math.max(28, Math.ceil(labW(yr) + 12)) : 12);
    const xOf = scaleLinear(xd0, xd1, left, right);
    return { left, right, top, bottom, xd0, xd1, xOf, yl, yr };
  }

  // ---- drawing -----------------------------------------------------------------
  function draw(ctx: CanvasRenderingContext2D, w: number, hh: number): void {
    const dpr = host.dpr;
    layout = computeLayout(ctx, w, hh);
    const L = layout;
    const hasData = !!L && series.some((s) => visible(s) && lastFinite(s.data) !== null);
    if (!L || !hasData) {
      drawEmpty(ctx, w, hh, o.empty ?? 'No data yet');
      return;
    }
    const { left, right, top, bottom } = L;

    // gridlines (left axis ticks) + labels
    ctx.lineWidth = 1;
    ctx.font = font(10.5);
    ctx.textBaseline = 'middle';
    if (L.yl) {
      ctx.textAlign = 'right';
      for (const t of L.yl.ticks.ticks) {
        const y = L.yl.map(t);
        if (!Number.isFinite(y)) continue;
        ctx.strokeStyle = t === 0 ? T.axis : T.grid;
        ctx.beginPath();
        ctx.moveTo(left, snap(y, dpr));
        ctx.lineTo(right, snap(y, dpr));
        ctx.stroke();
        ctx.fillStyle = T.ink2;
        ctx.fillText(L.yl.tickFmt(t, L.yl.ticks.step), left - 7, y);
      }
    }
    if (L.yr) {
      ctx.textAlign = 'left';
      ctx.fillStyle = T.ink2;
      for (const t of L.yr.ticks.ticks) {
        const y = L.yr.map(t);
        if (!Number.isFinite(y)) continue;
        if (!L.yl) {
          ctx.strokeStyle = t === 0 ? T.axis : T.grid;
          ctx.beginPath();
          ctx.moveTo(left, snap(y, dpr));
          ctx.lineTo(right, snap(y, dpr));
          ctx.stroke();
        }
        ctx.fillText(L.yr.tickFmt(t, L.yr.ticks.step), right + 7, y);
      }
    }

    // x axis: baseline, year rules, labels
    ctx.strokeStyle = T.axis;
    ctx.beginPath();
    ctx.moveTo(left, snap(bottom, dpr));
    ctx.lineTo(right, snap(bottom, dpr));
    ctx.stroke();
    const ticks = dayTicks(L.xd0, L.xd1, right - left, 70);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let lastLabelRight = -Infinity;
    for (const t of ticks) {
      const x = L.xOf(t.x);
      if (t.major) {
        ctx.strokeStyle = T.grid;
        ctx.beginPath();
        ctx.moveTo(snap(x, dpr), top);
        ctx.lineTo(snap(x, dpr), bottom);
        ctx.stroke();
      }
      ctx.strokeStyle = T.axis;
      ctx.beginPath();
      ctx.moveTo(snap(x, dpr), bottom);
      ctx.lineTo(snap(x, dpr), bottom + 4);
      ctx.stroke();
      ctx.font = font(10.5, t.major ? 600 : 400);
      const tw = ctx.measureText(t.label).width;
      const lx = Math.max(left + tw / 2, Math.min(right - tw / 2, x));
      if (lx - tw / 2 < lastLabelRight + 6) continue;
      ctx.fillStyle = t.major ? T.ink1 : T.ink2;
      ctx.fillText(t.label, lx, bottom + 6);
      lastLabelRight = lx + tw / 2;
    }

    // clip series to the plot
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top - 2, right - left, bottom - top + 3);
    ctx.clip();

    // areas first (under every line)
    series.forEach((s, i) => {
      if (!visible(s) || !s.area) return;
      const ax = s.axis === 'right' ? L.yr : L.yl;
      if (!ax) return;
      const col = colorOf(s, i);
      const zeroY = !ax.log && ax.ticks.min <= 0 && ax.ticks.max >= 0 ? ax.map(0) : bottom;
      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, alpha(col, 0.2));
      g.addColorStop(1, alpha(col, 0.02));
      ctx.fillStyle = g;
      ctx.beginPath();
      trace(s, L, ax, {
        start: (x, y) => {
          ctx.moveTo(x, zeroY);
          ctx.lineTo(x, y);
        },
        point: (x, y) => ctx.lineTo(x, y),
        end: (x) => {
          ctx.lineTo(x, zeroY);
          ctx.closePath();
        },
      });
      ctx.fill();
    });

    // reference lines (behind the data lines)
    for (const r of o.refLines ?? []) {
      const ax = r.axis === 'right' ? L.yr : L.yl;
      if (!ax || !Number.isFinite(r.y)) continue;
      const y = ax.map(r.y);
      if (!Number.isFinite(y) || y < top - 1 || y > bottom + 1) continue;
      ctx.strokeStyle = r.color ?? T.ink2;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1;
      if (r.dashed !== false) ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(left, snap(y, dpr));
      ctx.lineTo(right, snap(y, dpr));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // lines
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    series.forEach((s, i) => {
      if (!visible(s)) return;
      const ax = s.axis === 'right' ? L.yr : L.yl;
      if (!ax) return;
      ctx.strokeStyle = colorOf(s, i);
      ctx.lineWidth = s.width ?? (s.dashed ? 1.5 : 2);
      ctx.setLineDash(s.dashed ? [5, 4] : []);
      ctx.beginPath();
      trace(s, L, ax, {
        start: (x, y) => ctx.moveTo(x, y),
        point: (x, y) => ctx.lineTo(x, y),
        end: () => {},
      });
      ctx.stroke();
      ctx.setLineDash([]);
    });
    ctx.restore();

    // end dots (2px surface ring)
    series.forEach((s, i) => {
      if (!visible(s)) return;
      const ax = s.axis === 'right' ? L.yr : L.yl;
      if (!ax) return;
      const li = lastIndexIn(s, L);
      if (li < 0) return;
      const x = L.xOf(x0Of(s) + li * stepOf(s));
      const y = ax.map(s.data[li]);
      if (!Number.isFinite(y)) return;
      dot(ctx, x, y, colorOf(s, i), 3.5);
    });

    // reference-line labels (on top)
    ctx.font = font(10, 500);
    for (const r of o.refLines ?? []) {
      if (!r.label) continue;
      const ax = r.axis === 'right' ? L.yr : L.yl;
      if (!ax) continue;
      const y = ax.map(r.y);
      if (!Number.isFinite(y) || y < top || y > bottom) continue;
      pillText(ctx, r.label, right - 4, Math.max(top + 8, y - 9), { align: 'right', fill: T.ink1, bg: alpha(T.bg2, 0.88), h: 15 });
    }

    // event markers
    for (const m of o.markers ?? []) {
      if (!(m.x >= L.xd0 && m.x <= L.xd1)) continue;
      const x = snap(L.xOf(m.x), dpr);
      ctx.strokeStyle = m.color ?? T.gold;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = m.color ?? T.gold;
      ctx.beginPath();
      ctx.moveTo(x - 4, top - 1);
      ctx.lineTo(x + 4, top - 1);
      ctx.lineTo(x, top + 5);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawOverlay(ctx: CanvasRenderingContext2D): void {
    const L = layout;
    if (!hover || !L) {
      hideTip(root);
      return;
    }
    const { left, right, top, bottom } = L;
    if (hover.x < left - 4 || hover.x > right + 4 || hover.y < top - 6 || hover.y > bottom + 20) {
      hideTip(root);
      return;
    }
    const day = L.xd0 + ((Math.max(left, Math.min(right, hover.x)) - left) / Math.max(1, right - left)) * (L.xd1 - L.xd0);
    // Snap to the nearest data x of the first visible series with data.
    const ref = series.find((s) => visible(s) && s.data.length > 0);
    if (!ref) return;
    const rst = stepOf(ref);
    const ri = Math.max(0, Math.min(ref.data.length - 1, Math.round((day - x0Of(ref)) / rst)));
    const snapDay = Math.max(L.xd0, Math.min(L.xd1, x0Of(ref) + ri * rst));
    const x = L.xOf(snapDay);

    ctx.strokeStyle = T.crosshair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(snap(x, host.dpr), top);
    ctx.lineTo(snap(x, host.dpr), bottom);
    ctx.stroke();

    const rows: HTMLElement[] = [];
    series.forEach((s, i) => {
      if (!visible(s)) return;
      const ax = s.axis === 'right' ? L.yr : L.yl;
      if (!ax) return;
      const idx = Math.round((snapDay - x0Of(s)) / stepOf(s));
      const v = idx >= 0 && idx < s.data.length ? s.data[idx] : NaN;
      const col = colorOf(s, i);
      rows.push(tipRow(col, s.label + (s.axis === 'right' && L.yl ? ' (R)' : ''), Number.isFinite(v) ? fmtFor(s)(v) : '—', s.area ? 'box' : s.dashed ? 'dash' : 'line'));
      if (!Number.isFinite(v)) return;
      const y = ax.map(v);
      if (Number.isFinite(y)) dot(ctx, L.xOf(x0Of(s) + idx * stepOf(s)), y, col, 4);
    });
    const dateFmt = o.dateFormat ?? (rst >= 28 ? fmtMonth : fmtDay);
    showTip([tipTitle(dateFmt(snapDay)), ...rows], hover.cx, hover.cy, root);
  }

  function dot(ctx: CanvasRenderingContext2D, x: number, y: number, col: string, r: number): void {
    ctx.beginPath();
    ctx.arc(x, y, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = T.bg2;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
  }

  function lastIndexIn(s: LineSeries, L: Layout): number {
    const a = x0Of(s);
    const st = stepOf(s);
    const i1 = Math.min(s.data.length - 1, Math.floor((L.xd1 - a) / st + 1e-9));
    const i0 = Math.max(0, Math.ceil((L.xd0 - a) / st - 1e-9));
    for (let i = i1; i >= i0; i--) {
      const v = s.data[i];
      if (Number.isFinite(v) && !(o.log && s.axis !== 'right' && v <= 0)) return i;
    }
    return -1;
  }

  /**
   * Walk a series inside the x domain, emitting contiguous segments. When there
   * are more points than pixels, each pixel column contributes its first, min,
   * max and last value, so spikes survive decimation.
   */
  function trace(
    s: LineSeries,
    L: Layout,
    ax: AxisLayout,
    cb: { start: (x: number, y: number) => void; point: (x: number, y: number) => void; end: (x: number) => void },
  ): void {
    const a = x0Of(s);
    const st = stepOf(s);
    const n = s.data.length;
    const i0 = Math.max(0, Math.ceil((L.xd0 - a) / st - 1e-9));
    const i1 = Math.min(n - 1, Math.floor((L.xd1 - a) / st + 1e-9));
    if (i1 < i0) return;
    const cols = Math.max(1, L.right - L.left);
    const decimate = i1 - i0 + 1 > cols * 1.5;
    let open = false;
    let lastX = 0;
    const ok = (v: number) => Number.isFinite(v) && !(ax.log && v <= 0);
    if (!decimate) {
      for (let i = i0; i <= i1; i++) {
        const v = s.data[i];
        if (!ok(v)) {
          if (open) cb.end(lastX);
          open = false;
          continue;
        }
        const x = L.xOf(a + i * st);
        const y = ax.map(v);
        if (!open) {
          cb.start(x, y);
          open = true;
        } else cb.point(x, y);
        lastX = x;
      }
      if (open) cb.end(lastX);
      return;
    }
    let col = -1;
    let cMin = 0;
    let cMax = 0;
    let cLast = 0;
    let cX = 0;
    const flush = () => {
      if (col < 0) return;
      const yMin = ax.map(cMin);
      const yMax = ax.map(cMax);
      cb.point(cX, yMax);
      cb.point(cX, yMin);
      cb.point(cX, ax.map(cLast));
      lastX = cX;
    };
    for (let i = i0; i <= i1; i++) {
      const v = s.data[i];
      if (!ok(v)) {
        if (open) {
          flush();
          cb.end(lastX);
        }
        open = false;
        col = -1;
        continue;
      }
      const x = L.xOf(a + i * st);
      const c = Math.floor(x);
      if (!open) {
        cb.start(x, ax.map(v));
        open = true;
        col = c;
        cMin = cMax = cLast = v;
        cX = x;
        continue;
      }
      if (c !== col) {
        flush();
        col = c;
        cMin = cMax = v;
        cX = x;
      } else {
        if (v < cMin) cMin = v;
        if (v > cMax) cMax = v;
      }
      cLast = v;
    }
    if (open) {
      flush();
      cb.end(lastX);
    }
  }

  function signature(): string {
    let s = `${o.window}|${o.log}|${o.x0}|${o.xStep}|${o.yMin}|${o.yMax}|${[...hiddenKeys].join(',')}|`;
    for (const x of series) {
      const n = x.data.length;
      s += `${keyOf(x)}:${n}:${n ? x.data[n - 1] : ''}:${n ? x.data[0] : ''}:${x.color}:${x.axis};`;
    }
    for (const r of o.refLines ?? []) s += `r${r.y}${r.label}`;
    for (const m of o.markers ?? []) s += `m${m.x}${m.label}`;
    return s;
  }

  return {
    el: root,
    set(next: LineSeries[], patch?: Partial<LineChartOptions>) {
      if (patch) o = { ...o, ...patch };
      series = next;
      for (const s of series) {
        const k = keyOf(s);
        if (!seenKeys.has(k)) {
          seenKeys.add(k);
          if (s.hidden) hiddenKeys.add(k);
        }
      }
      if (patch?.height !== undefined) host.setHeight(patch.height);
      buildLegend();
      const nsig = signature();
      if (nsig === sig) return;
      sig = nsig;
      host.redraw();
    },
    options(patch: Partial<LineChartOptions>) {
      o = { ...o, ...patch };
      if (patch.height !== undefined) host.setHeight(patch.height);
      sig = '';
      buildLegend();
      host.redraw();
    },
    hidden: () => [...hiddenKeys],
    destroy() {
      hideTip(root);
      host.destroy();
      root.remove();
    },
  };
}

/** Last finite value of a series, or null. */
export function lastFinite(data: ArrayLike<number>): number | null {
  for (let i = data.length - 1; i >= 0; i--) if (Number.isFinite(data[i])) return data[i];
  return null;
}

/** Centered empty-state message with a faint baseline. */
export function drawEmpty(ctx: CanvasRenderingContext2D, w: number, hh: number, text: string): void {
  ctx.strokeStyle = T.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(12, Math.round(hh - 22) + 0.5);
  ctx.lineTo(w - 12, Math.round(hh - 22) + 0.5);
  ctx.stroke();
  ctx.fillStyle = T.ink3;
  ctx.font = font(12);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, hh / 2 - 6);
}
