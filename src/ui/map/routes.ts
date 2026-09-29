// ============================================================================
// The Treasury's carry rules on the map.
//
// A carry rule (s.policy.carries) moves the Treasury's goods from its store in
// one town to its store in another on wagons (s.shipments with owner STATE and
// shipment.order = the rule's id). For every running rule the map draws
// a subtle gold dashed line along the road between the two towns
// (routeBetweenTowns, smoothed like the roads, kept to the right of the centre
// as the wagons are, trimmed inside the towns), chevrons drifting slowly toward
// the destination, and a pill label near the middle
// ("bread · 20/day → Saltmere" / "bread · all → Saltmere", with the good's colour).
//
// Treasury freight lines (s.policy.lines) are drawn the same way, as a solid
// line in each direction (a lane each side of the road, chevrons both ways) and
// one pill ("freight line ⇄ Millbrook · 2/4 out"); their ids share the policy
// id space (s.ids.policy), so one hit id names either.
//
// Pure helpers first (unit-tested), then the drawing layer. Reads the
// simulation only; never mutates it.
// ============================================================================
import { GOODS } from '../../sim/goods';
import { rt } from '../../sim/runtime';
import { STATE, type Shipment, type SimState } from '../../sim/types';
import { routeBetweenTowns } from '../../sim/world/paths';
import { fmtNum } from '../format';
import {
  HALO,
  INK,
  ROUTE_CHEVRON_GAP,
  ROUTE_CHEVRON_R,
  ROUTE_CHEVRON_SPEED,
  ROUTE_COLOR,
  ROUTE_DASH,
  ROUTE_HIT_PX,
  ROUTE_LANE,
  ROUTE_SHADE,
  ROUTE_SIDE,
  ROUTE_TRIM_MIN,
  ROUTE_TRIM_R,
  ROUTE_WIDTH,
  LINE_COLOR,
  LINE_DOT,
  SANS,
} from './constants';
import type { View } from './life';
import { chaikin } from './roads';
import { polyFromPoints, samplePoly, type Poly, type PolySample } from './schedule';

/** One running carry rule (or freight line direction) as the map shows it. */
export interface RouteInfo {
  /** The carry rule's id (or the freight line's). */
  order: number;
  from: number;
  to: number;
  good: number;
  /** Units carried per day at most (CarryRule.qty; −1 = everything held). */
  perDay: number;
  /** Still running (enabled, not lapsed); false = only its last loads are on the road. */
  buying: boolean;
  /** Units on the road now. */
  inTransit: number;
  /** Units held in the store at `from`, waiting to be loaded. */
  waiting: number;
  /** 0 for the first route from `from` to `to`, 1 for a second one… (drawn one lane further out). */
  lane: number;
  /** A Treasury freight line (order = the line's id; one entry per direction). */
  line?: boolean;
  /** Freight lines: wagons in the fleet, wagons on the road, and whether this entry carries the pill. */
  wagons?: number;
  out?: number;
  pill?: boolean;
}

function num(x: number | undefined): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

/** Quantity for labels: whole units from 10 up, one decimal below. */
export function roundQty(x: number): number {
  const v = num(x);
  return Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
}

/**
 * The carry rules to draw: every rule that is running, or whose last loads are still on the road
 * (a paused rule with nothing moving is not drawn).
 */
export function activeRoutes(s: SimState, lanes: Map<string, number> = new Map()): RouteInfo[] {
  const cs = s.policy?.carries;
  if (!cs || !cs.length) return [];
  const nt = s.towns.length;
  let carried: Map<number, number> | null = null;
  for (const sh of s.shipments) {
    if (!sh || sh.owner !== STATE || !(sh.order >= 0)) continue;
    if (!carried) carried = new Map();
    carried.set(sh.order, (carried.get(sh.order) ?? 0) + Math.max(0, num(sh.qty)));
  }
  const out: RouteInfo[] = [];
  for (const c of cs) {
    if (!c) continue;
    const { from, to } = c;
    if (!(from >= 0 && from < nt && to >= 0 && to < nt) || from === to) continue;
    const buying = !!c.enabled && !(c.until >= 0 && c.until < s.day);
    const inTransit = carried?.get(c.id) ?? 0;
    if (!buying && !(inTransit > 1e-6)) continue;
    const key = from + '>' + to;
    const lane = lanes.get(key) ?? 0;
    lanes.set(key, lane + 1);
    const held = Math.max(0, num(s.treasury?.goods?.[from]?.[c.good]));
    out.push({ order: c.id, from, to, good: c.good, perDay: c.qty >= 0 ? num(c.qty) : -1, buying, inTransit, waiting: held, lane });
  }
  return out;
}

/**
 * The freight lines to draw: every line that is running or still has wagons on the road, one
 * entry per direction (a → b carries the pill), on the next free lane of each road.
 */
export function activeLines(s: SimState, lanes: Map<string, number> = new Map()): RouteInfo[] {
  const ls = s.policy?.lines;
  if (!ls || !ls.length) return [];
  const nt = s.towns.length;
  const out: RouteInfo[] = [];
  for (const L of ls) {
    if (!L || !(L.a >= 0 && L.a < nt && L.b >= 0 && L.b < nt) || L.a === L.b) continue;
    let busy = 0;
    for (const d of L.busy ?? []) if (d > s.day) busy++;
    let moving = 0;
    for (const sh of s.shipments) if (sh && sh.line === L.id) moving += Math.max(0, num(sh.qty));
    if (!L.enabled && !(busy > 0) && !(moving > 1e-6)) continue;
    for (const [from, to] of [
      [L.a, L.b],
      [L.b, L.a],
    ]) {
      const key = from + '>' + to;
      const lane = lanes.get(key) ?? 0;
      lanes.set(key, lane + 1);
      out.push({ order: L.id, from, to, good: -1, perDay: Math.max(0, num(L.carriedToday)), buying: !!L.enabled, inTransit: moving, waiting: 0, lane, line: true, wagons: Math.max(0, num(L.wagons)), out: busy, pill: from === L.a });
    }
  }
  return out;
}

function goodWord(g: number): string {
  return (GOODS[g]?.name ?? 'goods').toLowerCase();
}

/** Pill text: "bread · 20/day → Saltmere", "bread · all → Saltmere" (or "… · 12 on the road → …" once it has stopped). */
export function routeLabel(r: RouteInfo, toName: string): string {
  if (r.line) return `freight line ⇄ ${toName} · ${fmtNum(num(r.out))}/${fmtNum(num(r.wagons))} out`;
  const what = r.buying ? (r.perDay < 0 ? 'all' : `${fmtNum(roundQty(r.perDay))}/day`) : `${fmtNum(roundQty(r.inTransit))} on the road`;
  return `${goodWord(r.good)} · ${what} → ${toName}`;
}

/** Hover line for a Treasury wagon: ["Treasury: 40 bread → Saltmere", "arrives in 1.4 days"]. */
export function treasuryWagonText(s: SimState, sh: Shipment, dayFrac: number): [string, string] {
  const to = s.towns[sh.to]?.name ?? 'another town';
  const left = num(sh.arrive) - (s.day + num(dayFrac));
  const when = left < 0.05 ? 'arriving now' : `arrives in ${fmtNum(left, 1)} days`;
  return [`Treasury: ${fmtNum(roundQty(sh.qty))} ${goodWord(sh.good)} → ${to}`, when];
}

/**
 * Offset an open polyline [x0, y0, x1, y1, …] sideways by `d` (positive = to the
 * right of the direction of travel, in screen orientation: y grows downwards),
 * with mitred joins (the mitre capped at 2×).
 */
export function offsetPath(pts: readonly number[], d: number): number[] {
  const n = Math.floor(pts.length / 2);
  if (n < 2 || !d) return pts.slice(0, 2 * n);
  const out = new Array<number>(2 * n);
  const nx: number[] = [];
  const ny: number[] = [];
  for (let k = 0; k < n - 1; k++) {
    const dx = pts[2 * k + 2] - pts[2 * k];
    const dy = pts[2 * k + 3] - pts[2 * k + 1];
    const l = Math.hypot(dx, dy);
    // right-hand normal of (dx, dy) with y down: (−dy, dx)
    nx.push(l > 1e-9 ? -dy / l : k > 0 ? nx[k - 1] : 0);
    ny.push(l > 1e-9 ? dx / l : k > 0 ? ny[k - 1] : 1);
  }
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - 1);
    const b = Math.min(n - 2, k);
    let mx = nx[a] + nx[b];
    let my = ny[a] + ny[b];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) {
      mx = nx[b];
      my = ny[b];
    } else {
      mx /= ml;
      my /= ml;
    }
    const cos = mx * nx[b] + my * ny[b];
    const s = 1 / Math.max(0.5, cos);
    out[2 * k] = pts[2 * k] + mx * d * s;
    out[2 * k + 1] = pts[2 * k + 1] + my * d * s;
  }
  return out;
}

/**
 * Arc-length span [d0, d1] of a route polyline outside the two towns' cores:
 * from the first point `ra` tiles from A to the last point `rb` tiles from B.
 * Each end is trimmed by at most 40% of the length, so short routes still show.
 */
export function trimSpan(p: Poly, ax: number, ay: number, ra: number, bx: number, by: number, rb: number): [number, number] {
  const n = p.cum.length;
  if (n < 2 || !(p.len > 0)) return [0, 0];
  let d0 = 0;
  for (let k = 0; k < n; k++) {
    if (Math.hypot(p.xy[2 * k] - ax, p.xy[2 * k + 1] - ay) >= ra) {
      d0 = p.cum[k];
      break;
    }
    d0 = p.cum[k];
  }
  let d1 = p.len;
  for (let k = n - 1; k >= 0; k--) {
    if (Math.hypot(p.xy[2 * k] - bx, p.xy[2 * k + 1] - by) >= rb) {
      d1 = p.cum[k];
      break;
    }
    d1 = p.cum[k];
  }
  d0 = Math.min(d0, p.len * 0.4);
  d1 = Math.max(d1, p.len * 0.6);
  return [d0, d1];
}

/** The part of a polyline between arc lengths d0 ≤ d1, as points (end points interpolated). */
export function slicePoly(p: Poly, d0: number, d1: number): number[] {
  const n = p.cum.length;
  if (n < 2 || !(d1 > d0)) return [];
  const smp: PolySample = { x: 0, y: 0, dx: 1, dy: 0 };
  samplePoly(p, d0, smp);
  const out = [smp.x, smp.y];
  for (let k = 0; k < n; k++) {
    const c = p.cum[k];
    if (c > d0 && c < d1) out.push(p.xy[2 * k], p.xy[2 * k + 1]);
  }
  samplePoly(p, d1, smp);
  out.push(smp.x, smp.y);
  return out;
}

/** Distance from (x, y) to a polyline [x0, y0, x1, y1, …]; Infinity when it has no segment. */
export function distToPath(pts: readonly number[], x: number, y: number): number {
  let best = Infinity;
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const ax = pts[k];
    const ay = pts[k + 1];
    const dx = pts[k + 2] - ax;
    const dy = pts[k + 3] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 1e-12 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Arc lengths of the chevrons on [d0, d1]: every `gap`, shifted by `phase`
 * (which grows with time, so they drift from d0 toward d1).
 */
export function chevronsAt(d0: number, d1: number, gap: number, phase: number): number[] {
  if (!(gap > 1e-6) || !(d1 > d0) || !Number.isFinite(phase)) return [];
  const out: number[] = [];
  const first = d0 + (((phase % gap) + gap) % gap);
  for (let d = first; d <= d1 && out.length < 2000; d += gap) out.push(d);
  return out;
}

// ---------------------------------------------------------------------------
// Drawing layer
// ---------------------------------------------------------------------------

interface Geo {
  key: string;
  poly: Poly;
  /** Visible part (outside the town cores) as points, in tiles. */
  vis: number[];
  d0: number;
  d1: number;
}

export interface RouteLayer {
  /** Refresh the list of active routes (cheap; every frame). */
  sync(s: SimState): void;
  list(): readonly RouteInfo[];
  info(order: number): RouteInfo | undefined;
  /** Lines and chevrons (device px). `hot` = order id to emphasise (hovered), or -1. */
  drawLines(ctx: CanvasRenderingContext2D, s: SimState, v: View, time: number, hot: number): void;
  /** Pill labels, placed clear of `avoid` (CSS-px boxes, stride 5: x0, y0, x1, y1, id). */
  drawLabels(ctx: CanvasRenderingContext2D, s: SimState, v: View, avoid: readonly number[], hot: number): void;
  /** Route (order id) under a CSS-px point, or -1: labels, then (if `lines`) the lines. */
  hit(v: View, cssX: number, cssY: number, lines: boolean): number;
  reset(): void;
}

export function createRouteLayer(): RouteLayer {
  let routes: RouteInfo[] = [];
  const geos = new Map<string, Geo>();
  let roadVer = -1;
  let S: SimState | null = null;
  // pill hit boxes (CSS px): x0, y0, x1, y1, order
  let pills: number[] = [];
  const smp: PolySample = { x: 0, y: 0, dx: 1, dy: 0 };

  function geoOf(s: SimState, r: RouteInfo): Geo | null {
    const key = r.from + '>' + r.to + ':' + r.lane;
    let g = geos.get(key);
    if (g) return g;
    let tiles: number[] = [];
    try {
      tiles = routeBetweenTowns(s, r.from, r.to).tiles;
    } catch {
      tiles = [];
    }
    if (tiles.length < 2) return null;
    const w = s.map.w;
    const pts: number[] = [];
    for (const i of tiles) pts.push((i % w) + 0.5, Math.floor(i / w) + 0.5);
    const smooth = offsetPath(chaikin(pts, 2), ROUTE_SIDE + ROUTE_LANE * r.lane);
    const poly = polyFromPoints(smooth);
    const A = s.towns[r.from];
    const B = s.towns[r.to];
    const ra = Math.max(ROUTE_TRIM_MIN, (A?.radius ?? 0) * ROUTE_TRIM_R);
    const rb = Math.max(ROUTE_TRIM_MIN, (B?.radius ?? 0) * ROUTE_TRIM_R);
    const [d0, d1] = trimSpan(poly, A?.x ?? smooth[0], A?.y ?? smooth[1], ra, B?.x ?? smooth[smooth.length - 2], B?.y ?? smooth[smooth.length - 1], rb);
    g = { key, poly, vis: slicePoly(poly, d0, d1), d0, d1 };
    geos.set(key, g);
    return g;
  }

  function sync(s: SimState): void {
    const rv = rt(s).roadVersion;
    if (s !== S || rv !== roadVer) {
      S = s;
      roadVer = rv;
      geos.clear();
    }
    const lanes = new Map<string, number>();
    routes = activeRoutes(s, lanes);
    const lines = activeLines(s, lanes);
    if (lines.length) routes = routes.concat(lines);
    if (!routes.length) pills = [];
  }

  function drawLines(ctx: CanvasRenderingContext2D, s: SimState, v: View, time: number, hot: number): void {
    if (!routes.length) return;
    const k = v.k;
    const d = v.dpr;
    const x0 = -v.ox / k - 1;
    const y0 = -v.oy / k - 1;
    const x1 = (v.vw - v.ox) / k + 1;
    const y1 = (v.vh - v.oy) / k + 1;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const r of routes) {
      const g = geoOf(s, r);
      if (!g || g.vis.length < 4) continue;
      const on = r.order === hot;
      ctx.beginPath();
      for (let i = 0; i < g.vis.length; i += 2) {
        const X = v.ox + g.vis[i] * k;
        const Y = v.oy + g.vis[i + 1] * k;
        if (i === 0) ctx.moveTo(X, Y);
        else ctx.lineTo(X, Y);
      }
      ctx.setLineDash([]);
      ctx.strokeStyle = ROUTE_SHADE;
      ctx.lineWidth = (ROUTE_WIDTH + (on ? 3 : 1.8)) * d;
      ctx.stroke();
      // carry rules are dashed; freight lines are solid (a standing service)
      ctx.setLineDash(r.line ? [] : [ROUTE_DASH[0] * d, ROUTE_DASH[1] * d]);
      ctx.lineDashOffset = 0;
      ctx.strokeStyle = r.line ? LINE_COLOR : ROUTE_COLOR;
      ctx.lineWidth = (on ? ROUTE_WIDTH + 0.8 : ROUTE_WIDTH) * d;
      ctx.globalAlpha = r.buying ? 1 : 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      // chevrons drifting toward the destination, fading in and out at the ends
      const scale = v.scale;
      const gap = ROUTE_CHEVRON_GAP / scale;
      const ramp = Math.min(gap, (g.d1 - g.d0) / 3);
      const R = ROUTE_CHEVRON_R * d * (on ? 1.2 : 1);
      const base = r.buying ? 1 : 0.6;
      // chevrons at full strength share one path; the few fading at the ends are drawn singly
      const full = new Path2D();
      let nFull = 0;
      const chevron = (p: CanvasRenderingContext2D | Path2D, X: number, Y: number, ux: number, uy: number) => {
        p.moveTo(X - ux * R - uy * R, Y - uy * R + ux * R);
        p.lineTo(X + ux * R * 0.6, Y + uy * R * 0.6);
        p.lineTo(X - ux * R + uy * R, Y - uy * R - ux * R);
      };
      const stroke2 = (p?: Path2D) => {
        ctx.strokeStyle = ROUTE_SHADE;
        ctx.lineWidth = 3.4 * d;
        if (p) ctx.stroke(p);
        else ctx.stroke();
        ctx.strokeStyle = ROUTE_COLOR;
        ctx.lineWidth = 1.7 * d;
        if (p) ctx.stroke(p);
        else ctx.stroke();
      };
      for (const at of chevronsAt(g.d0, g.d1, gap, (time * ROUTE_CHEVRON_SPEED) / scale)) {
        samplePoly(g.poly, at, smp);
        if (smp.x < x0 || smp.x > x1 || smp.y < y0 || smp.y > y1) continue;
        const a = Math.min(1, (at - g.d0) / ramp, (g.d1 - at) / ramp);
        if (a <= 0.02) continue;
        const X = v.ox + smp.x * k;
        const Y = v.oy + smp.y * k;
        if (a >= 0.999) {
          chevron(full, X, Y, smp.dx, smp.dy);
          nFull++;
          continue;
        }
        ctx.beginPath();
        chevron(ctx, X, Y, smp.dx, smp.dy);
        ctx.globalAlpha = a * base;
        stroke2();
      }
      if (nFull) {
        ctx.globalAlpha = base;
        stroke2(full);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function overlaps(b: number[], x0: number, y0: number, x1: number, y1: number): boolean {
    for (let i = 0; i + 4 < b.length; i += 5) if (x0 < b[i + 2] && x1 > b[i] && y0 < b[i + 3] && y1 > b[i + 1]) return true;
    return false;
  }

  function drawLabels(ctx: CanvasRenderingContext2D, s: SimState, v: View, avoid: readonly number[], hot: number): void {
    pills = [];
    if (!routes.length) return;
    const d = v.dpr;
    const k = v.k;
    const fs = 11 * d;
    const hgt = 19; // CSS px
    ctx.save();
    ctx.font = `600 ${fs}px ${SANS}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const taken = avoid.slice();
    for (const r of routes) {
      const g = geoOf(s, r);
      if (!g || !(g.d1 > g.d0)) continue;
      if (r.line && !r.pill) continue; // one pill per freight line
      const text = routeLabel(r, s.towns[r.to]?.name ?? 'another town');
      const tw = ctx.measureText(text).width / d; // CSS px
      const wid = tw + 25;
      // near the middle of the visible line, clear of town names, other pills and
      // (if it can) the towns themselves, so it never reads as a town's label
      let bx = 0;
      let by = 0;
      let placed = false;
      for (let pass = 0; pass < 2 && !placed; pass++) {
        for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78]) {
          samplePoly(g.poly, g.d0 + (g.d1 - g.d0) * f, smp);
          // beside the line rather than on it, on the side the route keeps to (its right)
          const nx = -smp.dy;
          const ny = smp.dx;
          const off = (Math.abs(nx) * wid) / 2 + (Math.abs(ny) * hgt) / 2 + 6;
          bx = (v.ox + smp.x * k) / d + nx * off - wid / 2;
          by = (v.oy + smp.y * k) / d + ny * off - hgt / 2;
          if (pass === 0 && inTown(s, ((bx + wid / 2) * d - v.ox) / k, ((by + hgt / 2) * d - v.oy) / k)) continue;
          if (!overlaps(taken, bx - 3, by - 3, bx + wid + 3, by + hgt + 3)) {
            placed = true;
            break;
          }
        }
      }
      if (!placed) {
        samplePoly(g.poly, (g.d0 + g.d1) / 2, smp);
        bx = (v.ox + smp.x * k) / d - wid / 2;
        by = (v.oy + smp.y * k) / d + 9;
        for (let n = 0; n < 6 && overlaps(taken, bx - 3, by - 3, bx + wid + 3, by + hgt + 3); n++) by += hgt + 4;
      }
      if (bx > v.vw / d + 20 || by > v.vh / d + 20 || bx + wid < -20 || by + hgt < -20) continue;
      taken.push(bx, by, bx + wid, by + hgt, -1);
      pills.push(bx, by, bx + wid, by + hgt, r.order);
      // pill (device px)
      const X = bx * d;
      const Y = by * d;
      const W = wid * d;
      const H = hgt * d;
      const on = r.order === hot;
      ctx.globalAlpha = r.buying ? 1 : 0.8;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      pillPath(ctx, X + d, Y + 1.5 * d, W, H);
      ctx.fill();
      ctx.fillStyle = on ? 'rgba(34,30,20,0.94)' : 'rgba(16,18,22,0.86)';
      pillPath(ctx, X, Y, W, H);
      ctx.fill();
      ctx.strokeStyle = on ? 'rgba(242,205,114,0.95)' : 'rgba(242,205,114,0.5)';
      ctx.lineWidth = d;
      ctx.stroke();
      // the good's colour
      ctx.fillStyle = HALO;
      ctx.beginPath();
      ctx.arc(X + 10 * d, Y + H / 2, 4.6 * d, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = r.line ? LINE_DOT : (GOODS[r.good]?.color ?? '#999');
      ctx.beginPath();
      ctx.arc(X + 10 * d, Y + H / 2, 3.6 * d, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = INK;
      ctx.fillText(text, X + 18 * d, Y + H / 2 + 0.5 * d);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function hit(v: View, cssX: number, cssY: number, lines: boolean): number {
    if (!routes.length) return -1;
    for (let i = 0; i + 4 < pills.length; i += 5) if (cssX >= pills[i] && cssX <= pills[i + 2] && cssY >= pills[i + 1] && cssY <= pills[i + 3]) return pills[i + 4];
    if (!lines || !S) return -1;
    const k = v.k;
    const x = (cssX * v.dpr - v.ox) / k;
    const y = (cssY * v.dpr - v.oy) / k;
    const tol = (ROUTE_HIT_PX * v.dpr) / k;
    let best = -1;
    let bd = tol;
    for (const r of routes) {
      const g = geoOf(S, r);
      if (!g) continue;
      const dd = distToPath(g.vis, x, y);
      if (dd <= bd) {
        bd = dd;
        best = r.order;
      }
    }
    return best;
  }

  return {
    sync,
    list: () => routes,
    info: (order) => routes.find((r) => r.order === order),
    drawLines,
    drawLabels,
    hit,
    reset() {
      routes = [];
      geos.clear();
      pills = [];
      S = null;
      roadVer = -1;
    },
  };
}

/** Inside a town's built-up core (world tiles)? */
function inTown(s: SimState, x: number, y: number): boolean {
  for (const t of s.towns) if (t && Math.hypot(t.x - x, t.y - y) < Math.max(3, t.radius * 0.8)) return true;
  return false;
}

function pillPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + r, r, Math.PI / 2, (3 * Math.PI) / 2);
  ctx.closePath();
}
