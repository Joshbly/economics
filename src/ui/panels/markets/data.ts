// ============================================================================
// Markets panel — read-only helpers over the sim state (no DOM).
// Everything tolerates missing / zero / non-finite values: callers get NaN
// (rendered as "—") rather than exceptions.
// ============================================================================
import { IOU_COUPON } from '../../../sim/config';
import { GOODS, N_GOODS, SECTORS } from '../../../sim/goods';
import { GOLD_GOOD, IOU_GOOD, type MarketState, type SimState } from '../../../sim/types';
import { recentBalance, type Balance } from '../../../sim/market/markets';
import { fmtPct, fmtQty } from '../../format';

export { GOLD_GOOD, IOU_GOOD, IOU_COUPON };

/** A finite number or the fallback. */
export function fin(x: unknown, d = 0): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : d;
}

export const isInstrument = (g: number): boolean => g === IOU_GOOD || g === GOLD_GOOD;
export const isGood = (g: number): boolean => Number.isInteger(g) && g >= 0 && g < N_GOODS;

/** The market of a good in a town, or a national instrument market. */
export function marketAt(s: SimState, town: number, good: number): MarketState | null {
  if (good === IOU_GOOD) return s.iouMarket ?? null;
  if (good === GOLD_GOOD) return s.goldMarket ?? null;
  if (!isGood(good) || town < 0 || town >= s.towns.length) return null;
  return s.markets[town * N_GOODS + good] ?? null;
}

/** Relative change of the last finite value vs the one `days` points earlier (NaN if unknown). */
export function relChange(hist: ArrayLike<number> | undefined | null, days: number): number {
  if (!hist || hist.length < 2) return NaN;
  let i = hist.length - 1;
  while (i >= 0 && !(fin(hist[i]) > 0)) i--;
  if (i < 1) return NaN;
  let j = Math.max(0, i - days);
  while (j < i && !(fin(hist[j]) > 0)) j++;
  if (j >= i) return NaN;
  return hist[i] / hist[j] - 1;
}

/** Mean of the last n finite values. */
export function meanLast(a: ArrayLike<number> | undefined | null, n: number): number {
  if (!a || !a.length) return NaN;
  let sum = 0;
  let k = 0;
  for (let i = a.length - 1; i >= 0 && k < n; i--) {
    const v = a[i];
    if (Number.isFinite(v)) {
      sum += v;
      k++;
    }
  }
  return k ? sum / k : NaN;
}

/** Volume weights per town for a good (smoothed volume; equal weights when nothing trades). */
function weights(s: SimState, g: number): number[] {
  const w: number[] = [];
  let tot = 0;
  for (let t = 0; t < s.towns.length; t++) {
    const m = marketAt(s, t, g);
    const v = Math.max(0, fin(m?.volEma));
    w.push(v);
    tot += v;
  }
  if (!(tot > 1e-9)) for (let t = 0; t < w.length; t++) w[t] = marketAt(s, t, g) ? 1 : 0;
  return w;
}

export interface NationalGood {
  price: number;
  gross: number;
  net: number;
  volume: number;
  shortage: number;
  surplus: number;
  /** Shortage and surplus over the last MARKET_BALANCE_DAYS days, every town together. */
  balance: Balance;
  /** Volume-weighted daily base price history (current weights), oldest first. */
  hist: number[];
  volHist: number[];
  traded: boolean;
}

/** Realm-wide view of one good: volume-weighted prices, summed quantities. */
export function nationalGood(s: SimState, g: number): NationalGood {
  const w = weights(s, g);
  let wp = 0;
  let wg = 0;
  let wn = 0;
  let ws = 0;
  let volume = 0;
  let shortage = 0;
  let surplus = 0;
  let traded = false;
  let len = 0;
  const bal = { days: 0, shortage: 0, surplus: 0, volume: 0, treasury: 0 };
  for (let t = 0; t < s.towns.length; t++) {
    const m = marketAt(s, t, g);
    if (!m) continue;
    const p = fin(m.price);
    if (p > 0 && w[t] > 0) {
      wp += w[t] * p;
      wg += w[t] * fin(m.gross, p);
      wn += w[t] * fin(m.net, p);
      ws += w[t];
    }
    volume += Math.max(0, fin(m.volume));
    shortage += Math.max(0, fin(m.shortage));
    surplus += Math.max(0, fin(m.surplus));
    const b = recentBalance(m);
    bal.days = Math.max(bal.days, b.days);
    bal.shortage += b.shortage;
    bal.surplus += b.surplus;
    bal.volume += b.volume;
    bal.treasury += b.treasury;
    traded = traded || !!m.traded;
    len = Math.max(len, m.hist?.length ?? 0);
  }
  const hist: number[] = new Array(len).fill(NaN);
  const volHist: number[] = new Array(len).fill(0);
  for (let i = 0; i < len; i++) {
    let num = 0;
    let den = 0;
    let vol = 0;
    for (let t = 0; t < s.towns.length; t++) {
      const m = marketAt(s, t, g);
      if (!m) continue;
      const k = i - (len - (m.hist?.length ?? 0));
      if (k < 0) continue;
      const p = fin(m.hist[k]);
      if (p > 0 && w[t] > 0) {
        num += w[t] * p;
        den += w[t];
      }
      vol += Math.max(0, fin(m.volHist?.[k]));
    }
    hist[i] = den > 0 ? num / den : NaN;
    volHist[i] = vol;
  }
  return {
    price: ws > 0 ? wp / ws : NaN,
    gross: ws > 0 ? wg / ws : NaN,
    net: ws > 0 ? wn / ws : NaN,
    volume,
    shortage,
    surplus,
    balance: { ...bal, net: netBalance(bal.shortage, bal.surplus, bal.volume) },
    hist,
    volHist,
    traded,
  };
}

/** Signed balance share: + unmet ÷ what buyers wanted, − unsold ÷ what sellers offered. */
function netBalance(shortage: number, surplus: number, volume: number): number {
  const x = shortage >= surplus ? (shortage > 0 ? (shortage - surplus) / (volume + shortage) : 0) : -(surplus - shortage) / (volume + surplus);
  return Number.isFinite(x) ? x : 0;
}

/** The 14-day balance of a town's market (town ≥ 0) or of every town together (town −1). */
export function balanceAt(s: SimState, town: number, g: number): Balance {
  return town >= 0 ? recentBalance(marketAt(s, town, g) ?? undefined) : nationalGood(s, g).balance;
}

/** "short 4.8 a day (5 % of demand)" / "12 unsold a day (7 % of supply)" / "balanced". */
export function balanceWords(b: Balance, units: string): string {
  const flag = badgeOf(b.volume, b.shortage, b.surplus);
  if (flag === 'shortage') return `short ${fmtQty(b.shortage)} ${units} a day (${fmtPct(Math.abs(b.net))} of demand)`;
  if (flag === 'surplus') return `${fmtQty(b.surplus)} ${units} unsold a day (${fmtPct(Math.abs(b.net))} of supply)`;
  return 'balanced';
}

export type Badge = 'shortage' | 'surplus' | null;

/** Is the rationed side big enough to flag? (≥ 5 % of what was wanted and ≥ 0.5 units) */
export function badgeOf(volume: number, shortage: number, surplus: number): Badge {
  const v = Math.max(0, fin(volume));
  const sh = Math.max(0, fin(shortage));
  const su = Math.max(0, fin(surplus));
  if (sh >= 0.5 && sh >= 0.05 * (v + sh) && sh >= su) return 'shortage';
  if (su >= 0.5 && su >= 0.05 * (v + su)) return 'surplus';
  return null;
}

/** Yield of an IOU at a price (¤5 a year forever). */
export function iouYield(price: number): number {
  return price > 0 ? IOU_COUPON / price : NaN;
}

/** Unit word for a market ('loaf', 'IOU', 'oz'). */
export function unitOf(g: number): string {
  if (g === IOU_GOOD) return 'IOU';
  if (g === GOLD_GOOD) return 'oz';
  return GOODS[g]?.unit ?? 'unit';
}

/** Display name of a market's instrument. */
export function goodLabel(g: number): string {
  if (g === IOU_GOOD) return 'IOUs';
  if (g === GOLD_GOOD) return 'Gold';
  return GOODS[g]?.name ?? 'Goods';
}

export interface HolderRow {
  key: string;
  label: string;
  qty: number;
  hint: string;
}

/**
 * Who holds stock of a good in a town (town −1 = the whole realm): producers,
 * workshops that use it, builders, traders, households' pantries, the Treasury,
 * and wagons on the way there.
 */
export function holdersOf(s: SimState, town: number, g: number): HolderRow[] {
  const inTown = (t: number) => town < 0 || t === town;
  let producers = 0;
  let users = 0;
  let builders = 0;
  let traders = 0;
  let homes = 0;
  let transit = 0;
  let nProd = 0;
  let nUse = 0;
  for (const f of s.firms ?? []) {
    if (!f || !f.alive) continue;
    const q = Math.max(0, fin(f.inv?.[g]));
    if (f.sector === 'trader') {
      if (inTown(f.town)) traders += q;
      const st = f.trade?.stock;
      if (st) {
        if (town < 0) for (let t = 0; t < st.length; t++) traders += Math.max(0, fin(st[t]?.[g]));
        else traders += Math.max(0, fin(st[town]?.[g]));
      }
      continue;
    }
    if (!inTown(f.town) || !(q > 0)) continue;
    if (f.sector === 'builder') builders += q;
    else if (SECTORS[f.sector]?.out === g) {
      producers += q;
      nProd++;
    } else {
      users += q;
      nUse++;
    }
  }
  for (const p of s.people ?? []) {
    if (!p || !p.alive || !inTown(p.town)) continue;
    homes += Math.max(0, fin(p.pantry?.[g]));
  }
  let treasury = 0;
  const tg = s.treasury?.goods ?? [];
  if (town < 0) for (let t = 0; t < tg.length; t++) treasury += Math.max(0, fin(tg[t]?.[g]));
  else treasury = Math.max(0, fin(tg[town]?.[g]));
  for (const sh of s.shipments ?? []) {
    if (sh && sh.good === g && (town < 0 || sh.to === town)) transit += Math.max(0, fin(sh.qty));
  }
  const prodLab = producerLabel(g);
  const rows: HolderRow[] = [
    { key: 'prod', label: prodLab, qty: producers, hint: `Unsold output waiting at ${nProd} ${nProd === 1 ? singular(prodLab).toLowerCase() : prodLab.toLowerCase()}` },
    { key: 'use', label: 'Workshops using it', qty: users, hint: `Input stocks held by ${nUse} firm${nUse === 1 ? '' : 's'} that use it` },
    { key: 'build', label: 'Builders', qty: builders, hint: 'Construction materials in the builders’ yards' },
    { key: 'trade', label: 'Traders', qty: traders, hint: 'Stock the trading houses hold here, for sale or to be carried away' },
    { key: 'home', label: 'Households', qty: homes, hint: 'What people keep at home (pantries, coal stores, furniture)' },
    { key: 'state', label: 'Treasury', qty: treasury, hint: 'The Treasury’s own store (bought with Trade orders)' },
    { key: 'ship', label: town < 0 ? 'On the road' : 'On wagons, arriving', qty: transit, hint: town < 0 ? 'Being carried between towns right now' : 'Being carried here from other towns' },
  ];
  return rows.filter((r) => r.qty > 1e-6);
}

function producerSector(g: number): keyof typeof SECTORS | null {
  for (const k of Object.keys(SECTORS) as (keyof typeof SECTORS)[]) if (SECTORS[k].out === g) return k;
  return null;
}

function singular(plural: string): string {
  if (/ies$/.test(plural)) return plural.slice(0, -3) + 'y';
  return plural.replace(/s$/, '');
}

function producerLabel(g: number): string {
  const k = producerSector(g);
  if (!k) return 'Producers';
  const n = SECTORS[k].name;
  if (/s$/.test(n)) return n;
  if (/y$/.test(n)) return n.slice(0, -1) + 'ies';
  return n + 's';
}

/** Short town kind label for column heads. */
export function townKindLabel(kind: string, hasPort: boolean): string {
  if (hasPort || kind === 'harbor') return 'port';
  if (kind === 'capital') return 'capital';
  if (kind === 'farm') return 'farms';
  if (kind === 'mining') return 'mines';
  return kind;
}
