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
 * Visible price and quantity ranges. The window of interest is 0.55–1.7 × the
 * clearing (or indicative) price P, widened for any legal limit, the levy
 * wedge, Treasury orders — and, when nothing traded, the best bid and ask —
 * as long as they lie within [P/3, 3P]. Extreme rungs (desperate bids at
 * 2.5×, far asks) simply run off the plot edge, so they cannot squash the part
 * of the diagram where the curves cross.
 */
export function curveDomain(c: CurveSnapshot): { pLo: number; pHi: number; qMax: number; pRef: number } {
  let pRef = c.price > 0 && Number.isFinite(c.price) ? c.price : 0;
  if (!pRef) {
    const prices: number[] = [];
    for (let i = 0; i + 1 < c.bids.length; i += 2) if (c.bids[i] > 0) prices.push(c.bids[i]);
    for (let i = 0; i + 1 < c.asks.length; i += 2) if (c.asks[i] > 0) prices.push(c.asks[i]);
    prices.sort((x, y) => x - y);
    pRef = prices.length ? prices[prices.length >> 1] : 1;
  }
  let pLo = pRef * 0.55;
  let pHi = pRef * 1.7;
  const take = (p: number) => {
    if (!(p > 0) || !Number.isFinite(p) || p < pRef / 3 || p > pRef * 3) return;
    pLo = Math.min(pLo, p * 0.92);
    pHi = Math.max(pHi, p * 1.08);
  };
  if (c.ceiling > 0) take(c.ceiling);
  if (c.floor > 0) take(c.floor);
  if (c.volume > 0 && hasWedge(c)) {
    take(grossOf(c, c.price));
    take(netOf(c, c.price));
  }
  for (let i = 0; i + 2 < c.state.length; i += 3) take(c.state[i + 1]);
  if (!(c.volume > 0)) {
    if (c.bids.length >= 2) take(c.bids[0]);
    if (c.asks.length >= 2) take(c.asks[0]);
  }
  let qMax = Math.max(demandAt(c.bids, pLo), supplyAt(c.asks, pHi), c.volume * 1.3);
  for (let i = 0; i + 2 < c.state.length; i += 3) {
    const p = c.state[i + 1];
    if (p >= pLo && p <= pHi) qMax = Math.max(qMax, c.state[i + 2]);
  }
  if (!(qMax > 0) || !Number.isFinite(qMax)) qMax = 1;
  return { pLo, pHi, qMax: qMax * 1.06, pRef };
}

/** Does a price limit bind? (price sits on it and the long side is rationed) */
export function limitBinds(c: CurveSnapshot): { kind: 'ceiling' | 'floor'; gap: number } | null {
  const eps = 1e-6 * Math.max(1, c.price);
  if (c.ceiling > 0 && c.price >= c.ceiling - eps) {
    const gap = demandAt(c.bids, c.ceiling) - supplyAt(c.asks, c.ceiling);
    if (gap > 1e-9) return { kind: 'ceiling', gap };
  }
  if (c.floor > 0 && c.price <= c.floor + eps) {
    const gap = supplyAt(c.asks, c.floor) - demandAt(c.bids, c.floor);
    if (gap > 1e-9) return { kind: 'floor', gap };
  }
  return null;
}

interface Label {
  text: string;
  x: number;
  y: number;
  align: 'left' | 'right' | 'center';
  fill: string;
  prio: number;
}

/**
 * Draw pill labels by priority, nudging each vertically to avoid the ones
 * already placed and dropping it when no free spot is found.
 */
function placeLabels(ctx: CanvasRenderingContext2D, labels: Label[], bounds: { left: number; right: number; top: number; bottom: number }): void {
  const H = 15;
  const placed: [number, number, number, number][] = [];
  ctx.font = font(10, 600);
  labels.sort((a, b) => b.prio - a.prio);
  for (const l of labels) {
    const w = ctx.measureText(l.text).width + 10;
    for (const dy of [0, -16, 16, -32, 32]) {
      let x0 = l.align === 'left' ? l.x : l.align === 'right' ? l.x - w : l.x - w / 2;
      x0 = Math.max(bounds.left + 2, Math.min(bounds.right - w, x0));
      const y0 = l.y + dy - H / 2;
      if (y0 < bounds.top - 14 || y0 + H > bounds.bottom + 2) continue;
      const hit = placed.some(([a, b, c, d]) => x0 < c + 3 && x0 + w > a - 3 && y0 < d + 2 && y0 + H > b - 2);
      if (hit) continue;
      placed.push([x0, y0, x0 + w, y0 + H]);
      pillText(ctx, l.text, x0, y0 + H / 2, { align: 'left', fill: l.fill, bg: alpha(T.bg2, 0.93), h: H });
      break;
    }
  }
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
  const summary = h('div', { class: 'chart-summary' });
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
  root.appendChild(summary);

  const pf = () => o.priceFormat ?? fmtPrice;
  const qf = () => o.qtyFormat ?? fmtQty;
  const units = () => (o.unit ? pluralize(o.unit) : 'units');

  let legendSig = '';
  /** One-paragraph text read-out of the diagram (also the accessible equivalent). */
  function buildSummary(): void {
    if (!c || (c.bids.length < 2 && c.asks.length < 2)) {
      summary.hidden = true;
      return;
    }
    summary.hidden = false;
    const u = units();
    const b = (t: string) => h('b', null, t);
    const parts: (Node | string)[] = [];
    if (c.volume > 0) {
      parts.push('Cleared ', b(`${qf()(c.volume)} ${u}`), ' at ', b(pf()(c.price)), '.');
      if (hasWedge(c)) {
        const G = grossOf(c, c.price);
        const N = netOf(c, c.price);
        const take = c.volume * (G - N);
        parts.push(' Buyers pay ', b(pf()(G)), ', sellers get ', b(pf()(N)), ' — the Treasury ', G >= N ? 'takes ' : 'pays ', h('b', { class: G >= N ? 'gold' : 'good' }, fmtMoneyShort(Math.abs(take))), ' a day.');
      }
    } else {
      const bb = c.bids.length >= 2 ? c.bids[0] : -1;
      const ba = c.asks.length >= 2 ? c.asks[0] : -1;
      parts.push('No trade today');
      if (bb > 0 && ba > 0) parts.push(': the best bid (', b(pf()(bb)), ') is below the best ask (', b(pf()(ba)), ').');
      else parts.push(bb > 0 ? ': nobody is selling.' : ba > 0 ? ': nobody is buying.' : '.');
    }
    const lim = limitBinds(c);
    if (lim) {
      parts.push(
        lim.kind === 'ceiling' ? ' The max price of ' : ' The min price of ',
        b(pf()(lim.kind === 'ceiling' ? c.ceiling : c.floor)),
        ' binds: ',
        h('b', { class: 'warn' }, `${qf()(lim.gap)} ${u}`),
        lim.kind === 'ceiling' ? ' of demand go unmet.' : ' go unsold.',
      );
    }
    replace(summary, ...parts);
  }

  function buildLegend(): void {
    legend.hidden = o.legend === false || !c;
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
    const py = niceTicks(d.pLo, d.pHi, Math.max(3, Math.min(7, Math.round((bottom - top) / 38))));
    const pLo = Math.max(0, py.min);
    const pHi = py.max;
    ctx.font = font(10.5);
    const labW = Math.max(...py.ticks.map((t) => ctx.measureText(pf()(t)).width), ctx.measureText(pf()(c.price)).width + 6);
    const left = Math.max(36, Math.ceil(labW + 14));
    const right = w - 14;
    const qx = niceTicks(0, d.qMax, Math.max(2, Math.min(6, Math.round((right - left) / 80))));
    const xOf = scaleLinear(0, qx.max, left, right);
    const yOf = scaleLinear(pLo, pHi, bottom, top);
    const pOf = scaleLinear(bottom, top, pLo, pHi);
    L = { left, right, top, bottom, xOf, yOf, pOf };
    const traded = c.volume > 0 && c.price > 0;
    const wedge = hasWedge(c) && traded;
    const G = grossOf(c, c.price);
    const N = netOf(c, c.price);
    const yP = traded ? yOf(c.price) : NaN;
    const xV = traded ? xOf(c.volume) : NaN;
    const labels: Label[] = [];

    // grid + axes (tick labels give way to the clearing read-outs)
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const t of py.ticks) {
      if (t < pLo - 1e-9) continue;
      const y = yOf(t);
      ctx.strokeStyle = T.grid;
      ctx.beginPath();
      ctx.moveTo(left, snap(y, dpr));
      ctx.lineTo(right, snap(y, dpr));
      ctx.stroke();
      if (Math.abs(y - yP) < 13) continue;
      ctx.fillStyle = T.ink2;
      ctx.fillText(pf()(t), left - 7, y);
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
      const lab = fmtTick(t, qx.step);
      const lx = Math.max(left + 8, Math.min(right - 8, x));
      if (Math.abs(lx - xV) < ctx.measureText(lab).width / 2 + 26) continue;
      ctx.fillStyle = T.ink2;
      ctx.fillText(lab, lx, bottom + 6);
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

    // levy wedge: rectangle 0…V between seller net and buyer gross = the Treasury's take per day
    if (wedge) {
      const x0 = xOf(0);
      const yG = yOf(G);
      const yN = yOf(N);
      const col = G >= N ? T.gold : T.good;
      ctx.fillStyle = alpha(col, 0.2);
      ctx.fillRect(x0, Math.min(yG, yN), xV - x0, Math.abs(yN - yG));
      ctx.strokeStyle = alpha(col, 0.85);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, snap(yG, dpr));
      ctx.lineTo(xV, snap(yG, dpr));
      ctx.moveTo(x0, snap(yN, dpr));
      ctx.lineTo(xV, snap(yN, dpr));
      ctx.stroke();
      // bracket at the traded volume
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(snap(xV, dpr), yG);
      ctx.lineTo(snap(xV, dpr), yN);
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
      ctx.lineWidth = 1;
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

    // legal limits + the rationed gap measured off the curves
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
        ctx.fillStyle = alpha(T.warn, 0.25);
        ctx.fillRect(xa, y - 3, xb - xa, 6);
        ctx.fillStyle = T.warn;
        ctx.fillRect(xa - 0.75, y - 5, 1.5, 10);
        ctx.fillRect(xb - 0.75, y - 5, 1.5, 10);
        labels.push({ text: gapLabel, x: (xa + xb) / 2, y: y + 13, align: 'center', fill: T.warn, prio: 7 });
      }
      labels.push({ text: label, x: right - 2, y: y - 10, align: 'right', fill: T.warn, prio: 8 });
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

    // Treasury orders: a gold bar at the limit price, as long as the quantity
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
      if (nState <= 4) labels.push({ text: `Treasury ${side === 0 ? 'buys' : 'sells'} ${qf()(q)} @ ${pf()(p)}`, x: x1 + 10, y, align: 'left', fill: T.goldHi, prio: 4 });
    }
    ctx.restore();

    // clearing point with guides; wedge read-outs beside it
    if (traded) {
      ctx.strokeStyle = alpha(T.ink0, 0.35);
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(left, snap(yP, dpr));
      ctx.lineTo(xV, snap(yP, dpr));
      ctx.moveTo(snap(xV, dpr), yP);
      ctx.lineTo(snap(xV, dpr), bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(xV, yP, 7, 0, Math.PI * 2);
      ctx.fillStyle = T.bg2;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(xV, yP, 5, 0, Math.PI * 2);
      ctx.fillStyle = T.ink0;
      ctx.fill();
      if (wedge) {
        const col = G >= N ? T.goldHi : T.good;
        labels.push({ text: 'buyers pay ' + pf()(G), x: xV + 10, y: yOf(G) + (G >= N ? -8 : 8), align: 'left', fill: col, prio: 9 });
        labels.push({ text: 'sellers get ' + pf()(N), x: xV + 10, y: yOf(N) + (G >= N ? 8 : -8), align: 'left', fill: col, prio: 9 });
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
      labels.push({ text: 'no trade · indicative ' + pf()(c.price), x: left + 6, y: y - 10, align: 'left', fill: T.ink1, prio: 8 });
    }
    placeLabels(ctx, labels, { left, right, top, bottom });

    // axis read-outs of the clearing point (on top of everything)
    if (traded) {
      ctx.font = font(10.5, 600);
      pillText(ctx, pf()(c.price), left - 3, yP, { align: 'right', fill: T.bg0, bg: T.ink0, h: 16 });
      pillText(ctx, qf()(c.volume), xV, bottom + 12, { align: 'center', fill: T.bg0, bg: T.ink0, h: 16 });
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
      buildSummary();
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
