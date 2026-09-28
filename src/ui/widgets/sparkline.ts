// ============================================================================
// Sparklines: a tiny trend line with an end dot (canvas, DPR-aware).
//
//   const sp = sparkline({ width: 90, height: 24 });
//   row.appendChild(sp.el);
//   sp.set(s.stats.daily.cpi.slice(-360));
//
// Also exports drawSparkline() to paint into any existing canvas context
// (e.g. inside a tooltip) and sparkCanvas() for one-off static sparklines.
// ============================================================================
import { createCanvasHost } from './canvas';
import { alpha, T } from './theme';

export interface SparklineOptions {
  width?: number; // CSS px; omit to fill the parent width
  height?: number; // CSS px (default 24)
  color?: string; // default: muted ink (de-emphasis); pass an accent to highlight
  area?: boolean; // soft wash under the line (default true)
  dot?: boolean; // end dot (default true)
  /** Draw a faint baseline at this value (e.g. 100 for an index). */
  baseline?: number;
  /** Include this value in the range (e.g. 0). */
  include?: number;
}

export interface Sparkline {
  el: HTMLElement;
  set(data: ArrayLike<number>, color?: string): void;
  destroy(): void;
}

export function sparkline(opts: SparklineOptions = {}): Sparkline {
  let data: ArrayLike<number> = [];
  let color = opts.color ?? T.ink1;
  let sig = '';
  const host = createCanvasHost({
    height: opts.height ?? 24,
    className: 'spark',
    draw: (ctx, w, hh) => drawSparkline(ctx, data, 0, 0, w, hh, { ...opts, color }),
  });
  if (opts.width) host.el.style.width = opts.width + 'px';
  return {
    el: host.el,
    set(d, c) {
      data = d;
      if (c) color = c;
      const n = d.length;
      const nsig = `${n}|${n ? d[n - 1] : ''}|${n ? d[0] : ''}|${color}`;
      if (nsig === sig) return;
      sig = nsig;
      host.redraw();
    },
    destroy: () => host.destroy(),
  };
}

/** Paint a sparkline into a rectangle of an existing (already DPR-scaled) context. */
export function drawSparkline(
  ctx: CanvasRenderingContext2D,
  data: ArrayLike<number>,
  x: number,
  y: number,
  w: number,
  hh: number,
  opts: SparklineOptions = {},
): void {
  const n = data.length;
  const color = opts.color ?? T.ink1;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (opts.include !== undefined) {
    lo = Math.min(lo, opts.include);
    hi = Math.max(hi, opts.include);
  }
  if (!Number.isFinite(lo)) {
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + hh / 2);
    ctx.lineTo(x + w, y + hh / 2);
    ctx.stroke();
    return;
  }
  if (hi - lo < 1e-9 * Math.max(1, Math.abs(hi))) {
    lo -= 1;
    hi += 1;
  }
  const pad = opts.dot === false ? 2 : 4;
  const x0 = x + 1;
  const x1 = x + w - pad;
  const y0 = y + pad;
  const y1 = y + hh - pad;
  const X = (i: number) => (n <= 1 ? x1 : x0 + ((x1 - x0) * i) / (n - 1));
  const Y = (v: number) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);

  if (opts.baseline !== undefined && opts.baseline > lo && opts.baseline < hi) {
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(Y(opts.baseline)) + 0.5);
    ctx.lineTo(x1, Math.round(Y(opts.baseline)) + 0.5);
    ctx.stroke();
  }

  // Decimate to ~2 points per pixel with min/max per column.
  const cols = Math.max(1, Math.floor(x1 - x0));
  const stride = n > cols * 2 ? n / cols : 1;
  const pts: number[] = [];
  if (stride === 1) {
    for (let i = 0; i < n; i++) if (Number.isFinite(data[i])) pts.push(X(i), Y(data[i]));
  } else {
    for (let c = 0; c < cols; c++) {
      const a = Math.floor(c * stride);
      const b = Math.min(n, Math.floor((c + 1) * stride));
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = a; i < b; i++) {
        const v = data[i];
        if (!Number.isFinite(v)) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (mn === Infinity) continue;
      const xx = X((a + b - 1) / 2);
      pts.push(xx, Y(mx), xx, Y(mn));
    }
  }
  if (pts.length < 2) return;
  if (opts.area !== false && pts.length >= 4) {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, alpha(color, 0.22));
    g.addColorStop(1, alpha(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(pts[0], y1 + pad);
    for (let i = 0; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.lineTo(pts[pts.length - 2], y1 + pad);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.stroke();
  if (opts.dot !== false) {
    // last finite point
    let li = n - 1;
    while (li >= 0 && !Number.isFinite(data[li])) li--;
    if (li >= 0) {
      const ex = X(li);
      const ey = Y(data[li]);
      ctx.beginPath();
      ctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = T.bg2;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex, ey, 2.25, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }
}

/** A static sparkline canvas (for tooltips and one-off use). */
export function sparkCanvas(data: ArrayLike<number>, w: number, hh: number, opts: SparklineOptions = {}): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  c.width = Math.round(w * dpr);
  c.height = Math.round(hh * dpr);
  c.style.width = w + 'px';
  c.style.height = hh + 'px';
  c.className = 'spark-static';
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSparkline(ctx, data, 0, 0, w, hh, opts);
  }
  return c;
}
