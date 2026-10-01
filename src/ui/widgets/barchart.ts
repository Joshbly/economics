// ============================================================================
// Horizontal bar chart with row labels (canvas).
//
//   const bars = barChart({ format: fmtMoney, onClick: (row) => … });
//   el.appendChild(bars.el);
//   bars.set(towns.map((t) => ({ key: t.id, label: t.name, value: t.avgWage })));
//
// Bars grow from a single zero baseline (diverging automatically when any
// value is negative), ≤ 14px thick with a 4px rounded data-end, value at the
// tip in text ink. Hovering a row lifts its bar and shows a tooltip. The chart
// height follows the row count, so it never needs its own scrollbar.
// One series → one colour for every bar (pass `color` per row only when the
// colour means something, e.g. a good's own colour).
// ============================================================================
import { h } from '../dom';
import { fmtNum } from '../format';
import { createCanvasHost, fitText, roundRect, snap, type CanvasHost } from './canvas';
import { drawEmpty } from './linechart';
import { font, lighten, SERIES, T } from './theme';
import { hideTip, showTip, tipKV, tipNote, tipTitle } from './tooltip';

export interface BarRow {
  label: string;
  value: number;
  /** Stable key (for click handlers / highlighting). */
  key?: string | number;
  color?: string;
  /** Value text override (default: format(value)). */
  text?: string;
  /** Secondary label drawn muted after the label (e.g. a town kind). */
  sub?: string;
  /** Extra tooltip line. */
  hint?: string;
}

export interface BarChartOptions {
  /** Row height in CSS px (default 24). */
  rowHeight?: number;
  /** Label column width in px (default: fitted to labels, ≤ 42 % of the width). */
  labelWidth?: number;
  format?: (v: number) => string;
  /** Fixed scale bounds (default: data extent, always including 0). */
  max?: number;
  min?: number;
  /** Default bar colour (default SERIES[0]). */
  color?: string;
  /** Key of a row to emphasise (others dim slightly). */
  highlight?: string | number | null;
  onClick?: (row: BarRow, index: number) => void;
  empty?: string;
}

export interface BarChart {
  el: HTMLElement;
  set(rows: BarRow[], opts?: Partial<BarChartOptions>): void;
  destroy(): void;
}

export function barChart(initial: BarChartOptions = {}): BarChart {
  let o: BarChartOptions = { rowHeight: 24, ...initial };
  let rows: BarRow[] = [];
  let hoverRow = -1;
  let hoverPos = { cx: 0, cy: 0 };
  const PAD_T = 4;
  const PAD_B = 4;
  const root = h('div', { class: 'chart chart-bar' });
  const host: CanvasHost = createCanvasHost({
    height: 40,
    draw,
    onMove: (x, y, e) => {
      const i = Math.floor((y - PAD_T) / (o.rowHeight ?? 24));
      const next = i >= 0 && i < rows.length ? i : -1;
      hoverPos = { cx: e.clientX, cy: e.clientY };
      if (next !== hoverRow) {
        hoverRow = next;
        host.redraw();
      }
      if (hoverRow >= 0) tip();
      else hideTip(root);
      host.el.style.cursor = hoverRow >= 0 && o.onClick ? 'pointer' : '';
    },
    onLeave: () => {
      hoverRow = -1;
      hideTip(root);
      host.redraw();
    },
    onClick: () => {
      if (hoverRow >= 0 && o.onClick) o.onClick(rows[hoverRow], hoverRow);
    },
  });
  root.appendChild(host.el);
  const fmt = () => o.format ?? ((v: number) => fmtNum(v));

  function tip(): void {
    const r = rows[hoverRow];
    if (!r) return;
    showTip([tipTitle(r.label, r.sub), tipKV('Value', r.text ?? fmt()(r.value)), r.hint ? tipNote(r.hint) : null].filter(Boolean) as HTMLElement[], hoverPos.cx, hoverPos.cy, root);
  }

  function draw(ctx: CanvasRenderingContext2D, w: number, hh: number): void {
    if (!rows.length) {
      drawEmpty(ctx, w, hh, o.empty ?? 'Nothing to show');
      return;
    }
    const dpr = host.dpr;
    const rh = o.rowHeight ?? 24;
    const barH = Math.max(4, Math.min(14, rh - 10));
    ctx.font = font(11.5);
    let labW = o.labelWidth ?? 0;
    if (!o.labelWidth) {
      for (const r of rows) {
        let lw = ctx.measureText(r.label).width;
        if (r.sub) {
          ctx.font = font(10.5);
          lw += ctx.measureText(' ' + r.sub).width + 4;
          ctx.font = font(11.5);
        }
        labW = Math.max(labW, lw);
      }
      labW = Math.min(Math.ceil(labW) + 12, Math.floor(w * 0.42));
    }
    ctx.font = font(11, 500);
    let valW = 0;
    for (const r of rows) valW = Math.max(valW, ctx.measureText(r.text ?? fmt()(r.value)).width);
    valW = Math.ceil(valW) + 10;

    let lo = o.min ?? 0;
    let hi = o.max ?? 0;
    for (const r of rows) {
      if (!Number.isFinite(r.value)) continue;
      if (o.min === undefined && r.value < lo) lo = r.value;
      if (o.max === undefined && r.value > hi) hi = r.value;
    }
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
    if (hi - lo < 1e-12) hi = lo + 1;
    const neg = lo < 0;
    const x0 = labW + (neg ? valW : 0);
    const x1 = w - valW;
    const span = Math.max(10, x1 - x0);
    const X = (v: number) => x0 + ((v - lo) / (hi - lo)) * span;
    const zx = X(0);

    // zero baseline
    ctx.strokeStyle = T.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(snap(zx, dpr), PAD_T);
    ctx.lineTo(snap(zx, dpr), hh - PAD_B);
    ctx.stroke();

    rows.forEach((r, i) => {
      const yc = PAD_T + i * rh + rh / 2;
      const dim = o.highlight !== undefined && o.highlight !== null && r.key !== o.highlight;
      if (i === hoverRow) {
        ctx.fillStyle = T.bg3;
        roundRect(ctx, 0, yc - rh / 2 + 1, w, rh - 2, 4);
        ctx.fill();
      }
      // label (+ sub)
      ctx.font = font(11.5, r.key !== undefined && r.key === o.highlight ? 600 : 400);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = dim ? T.ink2 : T.ink1;
      const lab = fitText(ctx, r.label, labW - 10);
      ctx.fillText(lab, 6, yc);
      if (r.sub) {
        const lw = ctx.measureText(lab).width;
        ctx.font = font(10.5);
        ctx.fillStyle = T.ink3;
        ctx.fillText(fitText(ctx, r.sub, Math.max(0, labW - 14 - lw)), 6 + lw + 5, yc + 0.5);
      }
      if (!Number.isFinite(r.value)) return;
      const xv = X(r.value);
      const base = r.color ?? o.color ?? SERIES[0];
      ctx.fillStyle = i === hoverRow ? lighten(base, 0.15) : base;
      ctx.globalAlpha = dim ? 0.45 : 1;
      const bw = Math.abs(xv - zx);
      if (bw >= 0.5) {
        const left = Math.min(xv, zx);
        const pos = r.value >= 0;
        // rounded data-end, square at the baseline
        roundRect(ctx, left, yc - barH / 2, Math.max(1, bw), barH, pos ? [0, 4, 4, 0] : [4, 0, 0, 4]);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // value at the tip, in text ink
      ctx.font = font(11, 500);
      ctx.fillStyle = dim ? T.ink2 : T.ink0;
      const txt = r.text ?? fmt()(r.value);
      if (r.value >= 0) {
        ctx.textAlign = 'left';
        ctx.fillText(txt, xv + 6, yc);
      } else {
        ctx.textAlign = 'right';
        ctx.fillText(txt, xv - 6, yc);
      }
    });
  }

  return {
    el: root,
    set(next, patch) {
      if (patch) o = { ...o, ...patch };
      rows = next;
      if (hoverRow >= rows.length) hoverRow = -1;
      host.setHeight(Math.max(40, PAD_T + PAD_B + rows.length * (o.rowHeight ?? 24)));
      host.redraw();
      if (hoverRow >= 0) tip();
    },
    destroy() {
      hideTip(root);
      host.destroy();
      root.remove();
    },
  };
}
