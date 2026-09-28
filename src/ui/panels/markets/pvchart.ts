// ============================================================================
// Markets panel — price history with a volume sub-chart sharing one x axis
// (canvas). The price pane shows this market's daily base price (solid, in the
// good's colour) and optionally a reference series (dashed, e.g. the realm's
// volume-weighted price). The volume pane below shows daily traded units as
// bars. Hover: crosshair + one tooltip with the day's price, reference and volume.
//
//   const pv = pvChart({ height: 210 });
//   pv.set({ price: m.hist, volume: m.volHist, x0: s.day - m.hist.length, color, unit: 'loaf',
//            ref: { data: realm.hist, x0, label: 'Realm' } }, 90);
// ============================================================================
import { h } from '../../dom';
import { fmtDay, fmtPrice, fmtQty, pluralize } from '../../format';
import { alpha, createCanvasHost, dayTicks, drawEmpty, font, niceTicks, fmtTick, scaleLinear, snap, T, hideTip, showTip, tipRow, tipTitle } from '../../widgets';

export interface PVData {
  price: ArrayLike<number>;
  volume?: ArrayLike<number>;
  /** Day index of price[0] (volume is aligned with price). */
  x0: number;
  color: string;
  label: string;
  unit: string;
  ref?: { data: ArrayLike<number>; x0: number; label: string } | null;
  /** Price formatter (default fmtPrice). */
  format?: (v: number) => string;
}

export interface PVChart {
  el: HTMLElement;
  set(d: PVData | null, windowDays: number): void;
  destroy(): void;
}

interface Layout {
  left: number;
  right: number;
  top: number;
  pBottom: number;
  vTop: number;
  vBottom: number;
  xd0: number;
  xd1: number;
  xOf: (d: number) => number;
  yOf: (p: number) => number;
}

export function pvChart(opts: { height?: number } = {}): PVChart {
  let d: PVData | null = null;
  let win = 90;
  let L: Layout | null = null;
  let hover: { x: number; cx: number; cy: number } | null = null;
  let sig = '';
  const root = h('div', { class: 'chart mk-pv' });
  const host = createCanvasHost({
    height: opts.height ?? 210,
    label: 'Price and volume history',
    draw,
    overlay,
    onMove: (x, _y, e) => {
      hover = { x, cx: e.clientX, cy: e.clientY };
      host.redrawOverlay();
    },
    onLeave: () => {
      hover = null;
      hideTip(root);
      host.redrawOverlay();
    },
  });
  root.appendChild(host.el);
  const pf = () => d?.format ?? fmtPrice;

  function at(a: ArrayLike<number> | undefined, x0: number, day: number): number {
    if (!a) return NaN;
    const i = Math.round(day - x0);
    return i >= 0 && i < a.length ? a[i] : NaN;
  }

  function draw(ctx: CanvasRenderingContext2D, w: number, hh: number): void {
    L = null;
    const n = d?.price.length ?? 0;
    if (!d || n < 2) {
      drawEmpty(ctx, w, hh, 'No price history yet');
      return;
    }
    const dpr = host.dpr;
    const xd1 = d.x0 + n - 1;
    const xd0 = Math.max(d.x0, xd1 - win + 1);
    const hasVol = !!d.volume && d.volume.length > 0;
    const top = 10;
    const vBottom = hh - 22;
    const volH = hasVol ? Math.max(28, Math.round(hh * 0.2)) : 0;
    const vTop = vBottom - volH;
    const pBottom = hasVol ? vTop - 12 : vBottom;
    // price domain
    let lo = Infinity;
    let hi = -Infinity;
    const scan = (a: ArrayLike<number>, x0: number) => {
      for (let day = Math.ceil(xd0); day <= xd1; day++) {
        const v = at(a, x0, day);
        if (Number.isFinite(v) && v > 0) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    };
    scan(d.price, d.x0);
    if (d.ref) scan(d.ref.data, d.ref.x0);
    if (!Number.isFinite(lo)) {
      drawEmpty(ctx, w, hh, 'No trades in this period');
      return;
    }
    const pad = Math.max((hi - lo) * 0.06, hi * 0.01);
    const ticks = niceTicks(Math.max(0, lo - pad), hi + pad, Math.max(3, Math.min(6, Math.round((pBottom - top) / 34))));
    ctx.font = font(10.5);
    const tickLab = (t: number) => '¤' + fmtTick(t, ticks.step);
    let labW = 0;
    for (const t of ticks.ticks) labW = Math.max(labW, ctx.measureText(tickLab(t)).width);
    const left = Math.max(34, Math.ceil(labW + 12));
    const right = w - 10;
    const xOf = scaleLinear(xd0, Math.max(xd0 + 1, xd1), left, right);
    const yOf = scaleLinear(ticks.min, ticks.max, pBottom, top);
    L = { left, right, top, pBottom, vTop, vBottom, xd0, xd1, xOf, yOf };

    // grid + y labels
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of ticks.ticks) {
      const y = yOf(t);
      ctx.strokeStyle = T.grid;
      ctx.beginPath();
      ctx.moveTo(left, snap(y, dpr));
      ctx.lineTo(right, snap(y, dpr));
      ctx.stroke();
      ctx.fillStyle = T.ink2;
      ctx.fillText(tickLab(t), left - 7, y);
    }

    // volume pane
    if (hasVol && d.volume) {
      let vmax = 0;
      for (let day = Math.ceil(xd0); day <= xd1; day++) vmax = Math.max(vmax, Math.max(0, at(d.volume, d.x0, day) || 0));
      ctx.strokeStyle = T.axis;
      ctx.beginPath();
      ctx.moveTo(left, snap(vBottom, dpr));
      ctx.lineTo(right, snap(vBottom, dpr));
      ctx.stroke();
      ctx.font = font(9.5, 600);
      ctx.fillStyle = T.ink3;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('VOL', left - 7, vTop);
      if (vmax > 0) {
        ctx.font = font(10);
        ctx.fillStyle = T.ink3;
        ctx.textAlign = 'left';
        ctx.fillText(fmtQty(vmax) + ' max', left + 4, vTop - 1);
        const days = xd1 - xd0 + 1;
        const bw = Math.max(1, ((right - left) / days) * 0.72);
        ctx.fillStyle = alpha(d.color, 0.5);
        for (let day = Math.ceil(xd0); day <= xd1; day++) {
          const v = Math.max(0, at(d.volume, d.x0, day) || 0);
          if (!(v > 0)) continue;
          const bh = Math.max(1, (v / vmax) * (vBottom - vTop - 10));
          const x = xOf(day);
          ctx.fillRect(x - bw / 2, vBottom - bh, bw, bh);
        }
      }
    }

    // x axis
    ctx.strokeStyle = T.axis;
    ctx.beginPath();
    ctx.moveTo(left, snap(vBottom, dpr));
    ctx.lineTo(right, snap(vBottom, dpr));
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let lastR = -Infinity;
    for (const t of dayTicks(xd0, xd1, right - left, 64)) {
      const x = xOf(t.x);
      ctx.strokeStyle = T.axis;
      ctx.beginPath();
      ctx.moveTo(snap(x, dpr), vBottom);
      ctx.lineTo(snap(x, dpr), vBottom + 4);
      ctx.stroke();
      if (t.major) {
        ctx.strokeStyle = T.grid;
        ctx.beginPath();
        ctx.moveTo(snap(x, dpr), top);
        ctx.lineTo(snap(x, dpr), pBottom);
        ctx.stroke();
      }
      ctx.font = font(10.5, t.major ? 600 : 400);
      const tw = ctx.measureText(t.label).width;
      const lx = Math.max(left + tw / 2, Math.min(right - tw / 2, x));
      if (lx - tw / 2 < lastR + 6) continue;
      ctx.fillStyle = t.major ? T.ink1 : T.ink2;
      ctx.fillText(t.label, lx, vBottom + 6);
      lastR = lx + tw / 2;
    }

    // lines
    const line = (a: ArrayLike<number>, x0: number, col: string, width: number, dash: number[]) => {
      ctx.strokeStyle = col;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      let open = false;
      for (let day = Math.ceil(xd0); day <= xd1; day++) {
        const v = at(a, x0, day);
        if (!(Number.isFinite(v) && v > 0)) {
          open = false;
          continue;
        }
        const x = xOf(day);
        const y = yOf(v);
        if (!open) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        open = true;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top - 3, right - left + 3, pBottom - top + 6);
    ctx.clip();
    // soft wash under the price line
    const g = ctx.createLinearGradient(0, top, 0, pBottom);
    g.addColorStop(0, alpha(d.color, 0.16));
    g.addColorStop(1, alpha(d.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    let started = false;
    let lastX = 0;
    for (let day = Math.ceil(xd0); day <= xd1; day++) {
      const v = at(d.price, d.x0, day);
      if (!(Number.isFinite(v) && v > 0)) continue;
      const x = xOf(day);
      if (!started) {
        ctx.moveTo(x, pBottom);
        started = true;
      }
      ctx.lineTo(x, yOf(v));
      lastX = x;
    }
    if (started) {
      ctx.lineTo(lastX, pBottom);
      ctx.closePath();
      ctx.fill();
    }
    if (d.ref) line(d.ref.data, d.ref.x0, alpha(T.ink1, 0.7), 1.25, [4, 4]);
    line(d.price, d.x0, d.color, 2, []);
    ctx.restore();
    // end dot
    const lv = at(d.price, d.x0, xd1);
    if (Number.isFinite(lv) && lv > 0) {
      const x = xOf(xd1);
      const y = yOf(lv);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = T.bg2;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 3.25, 0, Math.PI * 2);
      ctx.fillStyle = d.color;
      ctx.fill();
    }
  }

  function overlay(ctx: CanvasRenderingContext2D): void {
    if (!hover || !L || !d) {
      hideTip(root);
      return;
    }
    const { left, right, top, vBottom } = L;
    if (hover.x < left - 4 || hover.x > right + 4) {
      hideTip(root);
      return;
    }
    const day = Math.round(L.xd0 + ((Math.max(left, Math.min(right, hover.x)) - left) / Math.max(1, right - left)) * (L.xd1 - L.xd0));
    const x = L.xOf(day);
    ctx.strokeStyle = T.crosshair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(snap(x, host.dpr), top);
    ctx.lineTo(snap(x, host.dpr), vBottom);
    ctx.stroke();
    const p = at(d.price, d.x0, day);
    const rows: HTMLElement[] = [tipTitle(fmtDay(day))];
    rows.push(tipRow(d.color, d.label, Number.isFinite(p) && p > 0 ? pf()(p) : '—'));
    if (Number.isFinite(p) && p > 0) {
      const y = L.yOf(p);
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = T.bg2;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 3.75, 0, Math.PI * 2);
      ctx.fillStyle = d.color;
      ctx.fill();
    }
    if (d.ref) {
      const r = at(d.ref.data, d.ref.x0, day);
      rows.push(tipRow(T.ink1, d.ref.label, Number.isFinite(r) && r > 0 ? pf()(r) : '—', 'dash'));
    }
    if (d.volume) {
      const v = at(d.volume, d.x0, day);
      rows.push(tipRow(alpha(d.color, 0.5), 'traded', Number.isFinite(v) ? `${fmtQty(v)} ${pluralize(d.unit)}` : '—', 'box'));
    }
    showTip(rows, hover.cx, hover.cy, root);
  }

  return {
    el: root,
    set(next, windowDays) {
      d = next;
      win = Math.max(7, windowDays);
      const n = next?.price.length ?? 0;
      const rn = next?.ref?.data.length ?? 0;
      const nsig = next
        ? `${win}|${next.x0}|${n}|${n ? next.price[n - 1] : ''}|${next.price[0]}|${next.color}|${next.ref?.x0}|${rn}|${rn ? next.ref!.data[rn - 1] : ''}|${next.volume?.length}|${next.volume && next.volume.length ? next.volume[next.volume.length - 1] : ''}`
        : 'null';
      if (nsig === sig) return;
      sig = nsig;
      host.redraw();
    },
    destroy() {
      hideTip(root);
      host.destroy();
      root.remove();
    },
  };
}
