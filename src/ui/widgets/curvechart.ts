// ============================================================================
// Supply & demand diagram of one day's call auction (canvas), drawn from a
// market's CurveSnapshot (types.ts: MarketState.curve).
//
//   const cc = curveChart({ height: 240, unit: 'loaf' });
//   el.appendChild(cc.el);
//   cc.set(market.curve);          // in update(); null → empty state
//
// What it shows (all prices in BASE terms, the price the auction clears on):
//  * demand = aggregated bids, stepping down; supply = aggregated asks, stepping up
//  * the clearing point (volume, price) with guides to both axes
//  * the levy wedge: at the traded volume, buyers pay gross G = P(1+bPct)+bUnit
//    and sellers keep net N = P(1−sPct)−sUnit; the rectangle between them over
//    0…V is the Treasury's take per day (or payout, when G < N). Faint dashed
//    curves show the curves in the traders' own terms (buyers' gross willingness
//    to pay; sellers' net asks) so the textbook incidence shift is visible.
//  * price ceiling / floor lines, with the rationed gap (shortage under a
//    ceiling, surplus above a floor) measured off the curves
//  * Treasury orders as gold bars at their limit price
//  * hover: a price crosshair with demand, supply and excess at that price
// ============================================================================
import type { CurveSnapshot } from '../../sim/types';
import { h, replace } from '../dom';
import { fmtMoneyShort, fmtPrice, fmtQty, pluralize } from '../format';
import { createCanvasHost, pillText, snap, type CanvasHost } from './canvas';
import { fmtTick, niceTicks, scaleLinear } from './axis';
import { drawEmpty } from './linechart';
import { alpha, font, SERIES, T } from './theme';
import { hideTip, showTip, tipKV, tipNote, tipTitle } from './tooltip';

export interface CurveChartOptions {
  /** Canvas height (CSS px). Default 240. */
  height?: number;
  /** Unit of the good ('loaf'): used in axis captions and tooltips. */
  unit?: string;
  priceFormat?: (v: number) => string;
  qtyFormat?: (v: number) => string;
  /** Optional reference price (e.g. the market's smoothed price) drawn as a faint line. */
  reference?: number;
  /** Show the faint own-terms curves when a levy wedge is present. Default true. */
  ownTerms?: boolean;
  /** Show the legend row. Default true. */
  legend?: boolean;
  empty?: string;
}

export interface CurveChart {
  el: HTMLElement;
  set(snap: CurveSnapshot | null | undefined, opts?: Partial<CurveChartOptions>): void;
  destroy(): void;
}

export const DEMAND_COLOR = SERIES[0];
export const SUPPLY_COLOR = SERIES[1];

// ---- pure helpers (unit-tested) ----------------------------------------------

/** Cumulative demand at base price p: all bids priced ≥ p. `bids` = [price, cumQty, …] descending. */
export function demandAt(bids: ArrayLike<number>, p: number): number {
  let q = 0;
  for (let i = 0; i + 1 < bids.length; i += 2) {
    if (bids[i] >= p - 1e-12) q = bids[i + 1];
    else break;
  }
  return q;
}

/** Cumulative supply at base price p: all asks priced ≤ p. `asks` = [price, cumQty, …] ascending. */
export function supplyAt(asks: ArrayLike<number>, p: number): number {
  let q = 0;
  for (let i = 0; i + 1 < asks.length; i += 2) {
    if (asks[i] <= p + 1e-12) q = asks[i + 1];
    else break;
  }
  return q;
}

/** Buyer's gross price for a base price under a wedge. */
export function grossOf(snap: Pick<CurveSnapshot, 'wedge'>, p: number): number {
  return p * (1 + snap.wedge.bPct) + snap.wedge.bUnit;
}

/** Seller's net price for a base price under a wedge. */
export function netOf(snap: Pick<CurveSnapshot, 'wedge'>, p: number): number {
  return p * (1 - snap.wedge.sPct) - snap.wedge.sUnit;
}

/** True when the wedge moves money (any non-zero levy on either side). */
export function hasWedge(snap: Pick<CurveSnapshot, 'wedge'>): boolean {
  const w = snap.wedge;
  return Math.abs(w.bPct) > 1e-9 || Math.abs(w.bUnit) > 1e-9 || Math.abs(w.sPct) > 1e-9 || Math.abs(w.sUnit) > 1e-9;
}

/**
 * Visible price and quantity ranges. Prices are clamped to [P/4, 4P] around
 * the clearing (or indicative) price so a stray extreme order cannot squash
 * the interesting part; limits, the wedge and Treasury orders are included
 * when they are within a reasonable band.
 */
export function curveDomain(c: CurveSnapshot): { pLo: number; pHi: number; qMax: number; pRef: number } {
  const prices: number[] = [];
  for (let i = 0; i + 1 < c.bids.length; i += 2) if (c.bids[i] > 0) prices.push(c.bids[i]);
  for (let i = 0; i + 1 < c.asks.length; i += 2) if (c.asks[i] > 0) prices.push(c.asks[i]);
  let pRef = c.price > 0 && Number.isFinite(c.price) ? c.price : 0;
  if (!pRef && prices.length) {
    const sorted = [...prices].sort((a, b) => a - b);
    pRef = sorted[sorted.length >> 1];
  }
  if (!pRef) pRef = 1;
  const lo = pRef / 4;
  const hi = pRef * 4;
  let pLo = pRef;
  let pHi = pRef;
  const take = (p: number, band = 1) => {
    if (!(p > 0) || !Number.isFinite(p)) return;
    if (p < lo / band || p > hi * band) return;
    if (p < pLo) pLo = p;
    if (p > pHi) pHi = p;
  };
  for (const p of prices) take(p);
  if (c.ceiling > 0) take(c.ceiling, 2);
  if (c.floor > 0) take(c.floor, 2);
  if (c.volume > 0 && hasWedge(c)) {
    take(grossOf(c, c.price), 2);
    take(netOf(c, c.price), 2);
  }
  for (let i = 0; i + 2 < c.state.length; i += 3) take(c.state[i + 1], 2);
  pLo = Math.max(pLo, lo);
  pHi = Math.min(pHi, hi);
  if (pHi - pLo < pRef * 0.1) {
    pLo = Math.max(0, pLo - pRef * 0.1);
    pHi = pHi + pRef * 0.1;
  }
  let qMax = Math.max(demandAt(c.bids, pLo), supplyAt(c.asks, pHi), c.volume * 1.3);
  for (let i = 0; i + 2 < c.state.length; i += 3) {
    const p = c.state[i + 1];
    if (p >= pLo && p <= pHi) qMax = Math.max(qMax, c.state[i + 2]);
  }
  if (c.ceiling > 0) qMax = Math.max(qMax, demandAt(c.bids, c.ceiling));
  if (c.floor > 0) qMax = Math.max(qMax, supplyAt(c.asks, c.floor));
  if (!(qMax > 0) || !Number.isFinite(qMax)) qMax = 1;
  return { pLo, pHi, qMax: qMax * 1.06, pRef };
}

// ---- widget -------------------------------------------------------------------

export function curveChart(initial: CurveChartOptions = {}): CurveChart {
  let o: CurveChartOptions = { height: 240, ownTerms: true, legend: true, ...initial };
  let c: CurveSnapshot | null = null;
  let hover: { x: number; y: number; cx: number; cy: number } | null = null;
  let L: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    xOf: (q: number) => number;
    yOf: (p: number) => number;
    pOf: (y: number) => number;
  } | null = null;

  const legend = h('div', { class: 'chart-legend chart-legend-static' });
  const root = h('div', { class: 'chart chart-curve' }, legend);
  const host: CanvasHost = createCanvasHost({
    height: o.height,
    label: 'Supply and demand in this market today',
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

  const pf = () => o.priceFormat ?? fmtPrice;
  const qf = () => o.qtyFormat ?? fmtQty;
  const units = () => (o.unit ? pluralize(o.unit) : 'units');

  let legendSig = '';
  function buildLegend(): void {
    legend.hidden = o.legend === false;
    const wedge = !!c && hasWedge(c) && c.volume > 0;
    const state = !!c && c.state.length > 0;
    const limit = !!c && (c.ceiling > 0 || c.floor > 0);
    const sig = `${wedge}${state}${limit}${!!c}`;
    if (sig === legendSig) return;
    legendSig = sig;
    const item = (cls: string, color: string, label: string) =>
      h('span', { class: 'lg-item lg-static' }, h('span', { class: cls, style: { color } }), h('span', { class: 'lg-lab' }, label));
    replace(
      legend,
      item('lg-key', DEMAND_COLOR, 'Demand (bids)'),
      item('lg-key', SUPPLY_COLOR, 'Supply (asks)'),
      item('lg-key-dot', T.ink0, 'Clearing'),
      wedge ? item('lg-key-box', T.gold, 'Levy wedge') : null,
      state ? item('lg-key-diamond', T.gold, 'Treasury orders') : null,
      limit ? item('lg-key-dash', T.warn, 'Legal limit') : null,
    );
  }

  function draw(ctx: CanvasRenderingContext2D, w: number, hh: number): void {
    L = null;
    if (!c || (c.bids.length < 2 && c.asks.length < 2 && c.state.length < 3)) {
      drawEmpty(ctx, w, hh, o.empty ?? 'No orders in this market today');
      return;
    }
    const dpr = host.dpr;
    const d = curveDomain(c);
    const top = 22;
    const bottom = hh - 34;
    const py = niceTicks(d.pLo * 0.94, d.pHi * 1.04, Math.max(3, Math.min(7, Math.round((bottom - top) / 38))));
    const pLo = Math.max(0, py.min);
    const pHi = py.max;
    ctx.font = font(10.5);
    const tickLab = (p: number) => {
      const s = pf()(p);
      return s;
    };
    const labW = Math.max(...py.ticks.map((t) => ctx.measureText(tickLab(t)).width));
    const left = Math.max(36, Math.ceil(labW + 12));
    const right = w - 14;
    const qx = niceTicks(0, d.qMax, Math.max(2, Math.min(6, Math.round((right - left) / 80))));
    const xOf = scaleLinear(0, qx.max, left, right);
    const yOf = scaleLinear(pLo, pHi, bottom, top);
    const pOf = scaleLinear(bottom, top, pLo, pHi);
    L = { left, right, top, bottom, xOf, yOf, pOf };

    // grid + axes
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const t of py.ticks) {
      if (t < pLo - 1e-9) continue;
      const y = snap(yOf(t), dpr);
      ctx.strokeStyle = T.grid;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.fillStyle = T.ink2;
      ctx.fillText(tickLab(t), left - 7, yOf(t));
    }
    ctx.strokeStyle = T.axis;
    ctx.beginPath();
    ctx.moveTo(left, snap(bottom, dpr));
    ctx.lineTo(right, snap(bottom, dpr));
    ctx.moveTo(snap(left, dpr), top);
    ctx.lineTo(snap(left, dpr), bottom);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const t of qx.ticks) {
      const x = xOf(t);
      ctx.strokeStyle = T.axis;
      ctx.beginPath();
      ctx.moveTo(snap(x, dpr), bottom);
      ctx.lineTo(snap(x, dpr), bottom + 4);
      ctx.stroke();
      ctx.fillStyle = T.ink2;
      ctx.fillText(fmtTick(t, qx.step), Math.max(left + 8, Math.min(right - 8, x)), bottom + 6);
    }
    // axis captions
    ctx.font = font(10, 500);
    ctx.fillStyle = T.ink3;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('¤ per ' + (o.unit ?? 'unit'), 4, 4);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(units() + ' per day', right, hh - 2);

    ctx.save();
    ctx.beginPath();
    ctx.rect(left + 1, top - 4, right - left + 4, bottom - top + 4);
    ctx.clip();

    const wedge = hasWedge(c) && c.volume > 0;
    const G = grossOf(c, c.price);
    const N = netOf(c, c.price);

    // levy wedge rectangle (Treasury take per day = V × (G − N))
    if (wedge) {
      const x0 = xOf(0);
      const x1 = xOf(c.volume);
      const yG = yOf(G);
      const yN = yOf(N);
      const takes = G >= N;
      const col = takes ? T.gold : T.good;
      ctx.fillStyle = alpha(col, 0.13);
      ctx.fillRect(x0, Math.min(yG, yN), x1 - x0, Math.abs(yN - yG));
      ctx.strokeStyle = alpha(col, 0.8);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, snap(yG, dpr));
      ctx.lineTo(x1, snap(yG, dpr));
      ctx.moveTo(x0, snap(yN, dpr));
      ctx.lineTo(x1, snap(yN, dpr));
      ctx.stroke();
    }

    // own-terms (pre-levy) curves, faint & dashed
    if (wedge && o.ownTerms !== false) {
      const w0 = c.wedge;
      ctx.lineWidth = 1.25;
      ctx.setLineDash([4, 4]);
      if (Math.abs(w0.bPct) > 1e-9 || Math.abs(w0.bUnit) > 1e-9) {
        ctx.strokeStyle = alpha(DEMAND_COLOR, 0.55);
        stepPath(ctx, c.bids, (p) => grossOf(c!, p), xOf, yOf, 'down', bottom, top);
        ctx.stroke();
      }
      if (Math.abs(w0.sPct) > 1e-9 || Math.abs(w0.sUnit) > 1e-9) {
        ctx.strokeStyle = alpha(SUPPLY_COLOR, 0.55);
        stepPath(ctx, c.asks, (p) => netOf(c!, p), xOf, yOf, 'up', bottom, top);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // reference price
    if (o.reference && o.reference > pLo && o.reference < pHi) {
      ctx.strokeStyle = alpha(T.ink2, 0.5);
      ctx.setLineDash([1, 3]);
      ctx.beginPath();
      ctx.moveTo(left, snap(yOf(o.reference), dpr));
      ctx.lineTo(right, snap(yOf(o.reference), dpr));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // the curves
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (c.asks.length >= 2) {
      ctx.strokeStyle = SUPPLY_COLOR;
      stepPath(ctx, c.asks, (p) => p, xOf, yOf, 'up', bottom, top);
      ctx.stroke();
    }
    if (c.bids.length >= 2) {
      ctx.strokeStyle = DEMAND_COLOR;
      stepPath(ctx, c.bids, (p) => p, xOf, yOf, 'down', bottom, top);
      ctx.stroke();
    }

    // legal limits + rationed gap
    const limitLine = (price: number, label: string, gapFrom: number, gapTo: number, gapLabel: string) => {
      const y = snap(yOf(price), dpr);
      ctx.strokeStyle = T.warn;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (gapTo - gapFrom > 1e-9) {
        const xa = xOf(gapFrom);
        const xb = xOf(gapTo);
        ctx.fillStyle = alpha(T.warn, 0.22);
        ctx.fillRect(xa, y - 3, xb - xa, 6);
        ctx.fillStyle = T.warn;
        ctx.fillRect(xa, y - 5, 1.5, 10);
        ctx.fillRect(xb - 1.5, y - 5, 1.5, 10);
        if (xb - xa > 60) {
          ctx.font = font(10, 600);
          pillText(ctx, gapLabel, (xa + xb) / 2, y + 12, { align: 'center', fill: T.warn, bg: alpha(T.bg2, 0.92), h: 15 });
        }
      }
      ctx.font = font(10, 600);
      pillText(ctx, label, right - 2, y - 10, { align: 'right', fill: T.warn, bg: alpha(T.bg2, 0.92), h: 15 });
    };
    if (c.ceiling > 0 && c.ceiling >= pLo && c.ceiling <= pHi) {
      const qd = demandAt(c.bids, c.ceiling);
      const qs = supplyAt(c.asks, c.ceiling);
      limitLine(c.ceiling, 'Max price ' + pf()(c.ceiling), qs, qd, 'shortage ' + qf()(qd - qs));
    }
    if (c.floor > 0 && c.floor >= pLo && c.floor <= pHi) {
      const qd = demandAt(c.bids, c.floor);
      const qs = supplyAt(c.asks, c.floor);
      limitLine(c.floor, 'Min price ' + pf()(c.floor), qd, qs, 'surplus ' + qf()(qs - qd));
    }

    // Treasury orders
    const nState = Math.floor(c.state.length / 3);
    for (let i = 0; i < nState; i++) {
      const side = c.state[i * 3];
      const p = c.state[i * 3 + 1];
      const q = c.state[i * 3 + 2];
      if (!(p >= pLo && p <= pHi)) continue;
      const y = yOf(p);
      const x1 = xOf(Math.min(q, qx.max));
      ctx.strokeStyle = alpha(T.gold, 0.9);
      ctx.lineWidth = 3;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(left + 1, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.lineCap = 'round';
      diamond(ctx, x1, y, 5, T.gold);
      if (nState <= 3) {
        ctx.font = font(10, 600);
        const lab = `Treasury ${side === 0 ? 'buys' : 'sells'} ${qf()(q)} @ ${pf()(p)}`;
        const tw = ctx.measureText(lab).width + 10;
        const lx = x1 + 10 + tw < right ? x1 + 10 : Math.max(left + 4, x1 - 10 - tw);
        pillText(ctx, lab, lx, y, { align: 'left', fill: T.goldHi, bg: alpha(T.bg2, 0.92), h: 15 });
      }
    }
    ctx.restore();

    // clearing point / indicative price
    ctx.font = font(10.5, 600);
    if (c.volume > 0 && c.price > 0) {
      const x = xOf(c.volume);
      const y = yOf(c.price);
      ctx.strokeStyle = alpha(T.ink0, 0.35);
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(left, snap(y, dpr));
      ctx.lineTo(x, snap(y, dpr));
      ctx.moveTo(snap(x, dpr), y);
      ctx.lineTo(snap(x, dpr), bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = T.bg2;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = T.ink0;
      ctx.fill();
      // axis read-outs
      pillText(ctx, pf()(c.price), left - 3, y, { align: 'right', fill: T.bg0, bg: T.ink0, h: 16 });
      pillText(ctx, qf()(c.volume), x, bottom + 12, { align: 'center', fill: T.bg0, bg: T.ink0, h: 16 });
      if (wedge) {
        ctx.font = font(10, 600);
        const takes = G >= N;
        const col = takes ? T.goldHi : T.good;
        const xl = x + 10;
        const room = right - xl;
        const yG = yOf(G);
        const yN = yOf(N);
        const sep = Math.abs(yG - yN) < 18 ? 9 - Math.abs(yG - yN) / 2 : 0;
        const upper = Math.min(yG, yN) - sep;
        const lower = Math.max(yG, yN) + sep;
        const gLab = 'buyers pay ' + pf()(G);
        const nLab = 'sellers get ' + pf()(N);
        if (room > 90) {
          pillText(ctx, gLab, xl, yG <= yN ? upper : lower, { align: 'left', fill: col, bg: alpha(T.bg2, 0.9), h: 15 });
          pillText(ctx, nLab, xl, yG <= yN ? lower : upper, { align: 'left', fill: col, bg: alpha(T.bg2, 0.9), h: 15 });
        }
        const take = c.volume * (G - N);
        const rectH = Math.abs(yN - yG);
        const lab = (takes ? 'Treasury takes ' : 'Treasury pays ') + fmtMoneyShort(Math.abs(take)) + '/day';
        const tw = ctx.measureText(lab).width;
        if (rectH >= 15 && x - left > tw + 16) {
          ctx.fillStyle = col;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(lab, (left + x) / 2, (yG + yN) / 2);
        }
      }
    } else if (c.price > 0 && c.price >= pLo && c.price <= pHi) {
      const y = snap(yOf(c.price), dpr);
      ctx.strokeStyle = alpha(T.ink1, 0.6);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = font(10, 600);
      pillText(ctx, 'no trade · indicative ' + pf()(c.price), left + 6, y - 10, { align: 'left', fill: T.ink1, bg: alpha(T.bg2, 0.92), h: 15 });
    }
  }

  function drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (!hover || !L || !c) {
      hideTip(root);
      return;
    }
    const { left, right, top, bottom } = L;
    if (hover.x < left || hover.x > right || hover.y < top || hover.y > bottom) {
      hideTip(root);
      return;
    }
    const p = L.pOf(hover.y);
    const qd = demandAt(c.bids, p);
    const qs = supplyAt(c.asks, p);
    const y = snap(hover.y, host.dpr);
    ctx.strokeStyle = T.crosshair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    const mark = (q: number, col: string) => {
      const x = L!.xOf(q);
      if (x < left || x > right + 2) return;
      ctx.beginPath();
      ctx.arc(x, hover!.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = T.bg2;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, hover!.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    };
    mark(qd, DEMAND_COLOR);
    mark(qs, SUPPLY_COLOR);
    const u = units();
    const rows: HTMLElement[] = [tipTitle('At ' + pf()(p), hasWedge(c) ? 'base price' : undefined)];
    rows.push(tipKV('Buyers want', `${qf()(qd)} ${u}`));
    rows.push(tipKV('Sellers offer', `${qf()(qs)} ${u}`));
    const ex = qd - qs;
    if (Math.abs(ex) > 1e-9) rows.push(tipKV(ex > 0 ? 'Excess demand' : 'Excess supply', `${qf()(Math.abs(ex))} ${u}`, ex > 0 ? 'bad' : 'warn'));
    if (hasWedge(c)) {
      rows.push(tipKV('Buyers would pay', pf()(grossOf(c, p))));
      rows.push(tipKV('Sellers would get', pf()(netOf(c, p))));
    }
    if (c.volume > 0) rows.push(tipNote(`Today: ${qf()(c.volume)} ${u} changed hands at ${pf()(c.price)}.`));
    showTip(rows, hover.cx, hover.cy, root);
  }

  return {
    el: root,
    set(next, patch) {
      if (patch) {
        o = { ...o, ...patch };
        if (patch.height !== undefined) host.setHeight(patch.height);
      }
      c = next ?? null;
      buildLegend();
      host.redraw();
    },
    destroy() {
      hideTip(root);
      host.destroy();
      root.remove();
    },
  };
}

/**
 * Path a cumulative step curve. `pts` = [price, cumQty, …] in curve order;
 * `dir` 'down' (demand) extends the last level to the bottom, 'up' (supply) to the top.
 */
function stepPath(
  ctx: CanvasRenderingContext2D,
  pts: ArrayLike<number>,
  priceMap: (p: number) => number,
  xOf: (q: number) => number,
  yOf: (p: number) => number,
  dir: 'down' | 'up',
  bottom: number,
  top: number,
): void {
  ctx.beginPath();
  const n = Math.floor(pts.length / 2);
  if (!n) return;
  let y = yOf(priceMap(pts[0]));
  ctx.moveTo(xOf(0), y);
  for (let i = 0; i < n; i++) {
    const x = xOf(pts[i * 2 + 1]);
    ctx.lineTo(x, y);
    if (i + 1 < n) {
      y = yOf(priceMap(pts[(i + 1) * 2]));
      ctx.lineTo(x, y);
    } else ctx.lineTo(x, dir === 'down' ? bottom + 4 : top - 4);
  }
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, col: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r - 2);
  ctx.lineTo(x + r + 2, y);
  ctx.lineTo(x, y + r + 2);
  ctx.lineTo(x - r - 2, y);
  ctx.closePath();
  ctx.fillStyle = T.bg2;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = col;
  ctx.fill();
}
