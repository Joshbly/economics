// ============================================================================
// Map overlays: per-town values for the badges and district tints (pure).
//
// Each value carries `rel` in −1..1: positive = worse for households (dearer,
// more jobless, poorer, sicker), negative = better; the map shows it as coral
// ↔ teal, always next to the number and an arrow, so colour is never the only
// cue. Prices and rents are compared with the realm's average across towns.
// ============================================================================
import { GOODS, N_GOODS } from '../../sim/goods';
import type { SimState } from '../../sim/types';
import type { OverlayId } from '../uiState';

export interface TownValue {
  town: number;
  value: number;
  /** Main badge text. */
  text: string;
  /** Secondary text (comparison). */
  sub: string;
  /** −1 (good) .. +1 (bad); 0 neutral. */
  rel: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return !Number.isFinite(x) ? 0 : x < lo ? lo : x > hi ? hi : x;
}

function money(x: number): string {
  if (!Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  if (a >= 10000) return '¤' + (a / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (a >= 100) return '¤' + a.toFixed(0);
  return '¤' + a.toFixed(2);
}

function vsAvg(x: number, avg: number): string {
  if (!(avg > 0) || !Number.isFinite(x)) return '';
  const d = x / avg - 1;
  if (Math.abs(d) < 0.005) return '= realm';
  return `${d > 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(0)}% vs realm`;
}

/** Wealth per household by town: deposits + gold + IOUs at market prices. */
export function wealthByTown(s: SimState): number[] {
  const nt = s.towns.length;
  const sum = new Array<number>(nt).fill(0);
  const cnt = new Array<number>(nt).fill(0);
  const gp = Number.isFinite(s.goldMarket?.price) && s.goldMarket.price > 0 ? s.goldMarket.price : s.foreign?.goldPrice ?? 0;
  const ip = Number.isFinite(s.iouMarket?.price) && s.iouMarket.price > 0 ? s.iouMarket.price : 0;
  for (const p of s.people) {
    if (!p || !p.alive || p.town < 0 || p.town >= nt) continue;
    const w = (p.cash || 0) + (p.gold || 0) * gp + (p.iou || 0) * ip;
    if (!Number.isFinite(w)) continue;
    sum[p.town] += w;
    cnt[p.town]++;
  }
  return sum.map((x, i) => (cnt[i] > 0 ? x / cnt[i] : 0));
}

/** Consumer price of good g in town t (what buyers paid, falling back to the base price). */
export function townPrice(s: SimState, t: number, g: number): number {
  const m = s.markets[t * N_GOODS + g];
  if (!m) return 0;
  const p = Number.isFinite(m.gross) && m.gross > 0 ? m.gross : m.price;
  return Number.isFinite(p) && p > 0 ? p : 0;
}

/** Values for an overlay, one per town (null for 'none'). */
export function overlayValues(s: SimState, id: OverlayId, good: number): TownValue[] | null {
  const towns = s.towns;
  if (id === 'none' || !towns.length) return null;
  switch (id) {
    case 'price': {
      const g = good >= 0 && good < N_GOODS ? good : 8;
      const ps = towns.map((t) => townPrice(s, t.id, g));
      const valid = ps.filter((p) => p > 0);
      const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
      return towns.map((t, i) => ({
        town: t.id,
        value: ps[i],
        text: ps[i] > 0 ? money(ps[i]) : '—',
        sub: ps[i] > 0 ? vsAvg(ps[i], avg) : 'not traded',
        rel: avg > 0 && ps[i] > 0 ? clamp((ps[i] / avg - 1) / 0.2, -1, 1) : 0,
      }));
    }
    case 'unemployment':
      return towns.map((t) => {
        const lab = (t.employed || 0) + (t.unemployed || 0);
        const r = lab > 0 ? (t.unemployed || 0) / lab : 0;
        return { town: t.id, value: r, text: `${(r * 100).toFixed(1)}%`, sub: `${t.unemployed || 0} without work`, rel: clamp((r - 0.05) / 0.08, -1, 1) };
      });
    case 'wealth': {
      const w = wealthByTown(s);
      const valid = w.filter((x) => x > 0);
      const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
      return towns.map((t, i) => ({
        town: t.id,
        value: w[i],
        text: money(w[i]),
        sub: 'per household · ' + (vsAvg(w[i], avg) || '—'),
        rel: avg > 0 ? -clamp((w[i] / avg - 1) / 0.45, -1, 1) : 0,
      }));
    }
    case 'health':
      return towns.map((t) => {
        const h = Number.isFinite(t.health) ? t.health : 0;
        return { town: t.id, value: h, text: `${Math.round(h * 100)}%`, sub: 'average health', rel: clamp((0.86 - h) / 0.12, -1, 1) };
      });
    case 'rent': {
      const rs = towns.map((t) => (Number.isFinite(t.avgRent) && t.avgRent > 0 ? t.avgRent : 0));
      const valid = rs.filter((x) => x > 0);
      const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
      return towns.map((t, i) => ({
        town: t.id,
        value: rs[i],
        text: rs[i] > 0 ? `${money(rs[i])}/day` : '—',
        sub: rs[i] > 0 ? vsAvg(rs[i], avg) : 'no tenants',
        rel: avg > 0 && rs[i] > 0 ? clamp((rs[i] / avg - 1) / 0.2, -1, 1) : 0,
      }));
    }
    default:
      return null;
  }
}

/** Short title for the overlay legend. */
export function overlayTitle(id: OverlayId, good: number): string {
  switch (id) {
    case 'price':
      return `Price of ${(GOODS[good]?.name ?? 'bread').toLowerCase()}`;
    case 'unemployment':
      return 'Without work';
    case 'wealth':
      return 'Household wealth';
    case 'health':
      return 'Health';
    case 'rent':
      return 'Rent';
    default:
      return '';
  }
}

/** Legend ends: [good end, bad end]. */
export function overlayLegend(id: OverlayId): [string, string] {
  switch (id) {
    case 'price':
    case 'rent':
      return ['cheaper', 'dearer'];
    case 'unemployment':
      return ['fewer jobless', 'more jobless'];
    case 'wealth':
      return ['richer', 'poorer'];
    case 'health':
      return ['healthier', 'sicker'];
    default:
      return ['', ''];
  }
}

/** Colour of a relative value: teal (−1) … neutral parchment (0) … coral (+1). */
export function relColor(rel: number, alpha = 1): string {
  const r = clamp(rel, -1, 1);
  const n: [number, number, number] = [214, 204, 180];
  const good: [number, number, number] = [87, 184, 165];
  const bad: [number, number, number] = [232, 132, 90];
  const c = r >= 0 ? bad : good;
  const t = Math.min(1, Math.abs(r) * 1.25);
  const m = (i: number) => Math.round(n[i] + (c[i] - n[i]) * t);
  return `rgba(${m(0)},${m(1)},${m(2)},${alpha})`;
}
