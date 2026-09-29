// ============================================================================
// Levers panel — rough, read-only estimates of what a draft levy would touch
// today ("the base") and what it would collect or pay, at today's volumes and
// before anyone reacts. Mirrors the charging rules in sim/policy/levies.ts
// closely enough to be a useful guide; never exact (behaviour will respond).
// ============================================================================
import { DAYS_PER_MONTH, DAYS_PER_YEAR, IOU_COUPON } from '../../../sim/config';
import { CONSUMER_GOODS, G, N_GOODS, SECTORS } from '../../../sim/goods';
import { inGroup } from '../../../sim/policy/levies';
import { FIRM_BASE, STATE } from '../../../sim/types';
import type { Firm, Group, Levy, Person, SimState } from '../../../sim/types';
import { fmtNum, plural } from '../../format';
import { tailMean } from '../../widgets';
import { fin, fmtM, fmtQ, goodName, townName, unitsOf } from './common';
import { saleWhoOf, saleWhoWords } from './levyDefs';

export type LevyDraft = Omit<Levy, 'id' | 'created' | 'today' | 'month' | 'lastMonth' | 'total'>;

export interface LevyEstimate {
  /** Plain description of today's base, e.g. "Bread sales in Kingsbridge ≈ ¤41.66 a day". */
  baseText: string;
  /** Unsigned amount the rule would move per period. */
  amount: number;
  per: 'day' | 'month';
  /** Coarser than usual (flows that are hard to foresee). */
  rough: boolean;
}

function personMatches(s: SimState, p: Person, group: Group): boolean {
  if (!group || group === 'all' || group === 'persons') return true;
  if (group === 'firms') return false;
  return inGroup(s, p, group);
}

function where(s: SimState, t: number): string {
  return t >= 0 ? ` in ${townName(s, t)}` : '';
}

function priceAt(s: SimState, town: number, g: number): number {
  const m = s.markets[town * N_GOODS + g];
  if (!m) return 0;
  const p = m.price > 0 ? m.price : m.ema;
  return fin(p);
}

/** Estimate a draft levy's base and yield. Returns null if nothing sensible can be said. */
export function estimateLevy(s: SimState, l: LevyDraft): LevyEstimate | null {
  const rate = fin(l.rate);
  const thr = l.threshold > 0 ? l.threshold : 0;
  const pct = l.unit === 'pct';
  const nT = s.towns.length;
  const towns = l.town >= 0 ? [l.town] : Array.from({ length: nT }, (_, i) => i);
  const goods = l.good >= 0 ? [l.good] : Array.from({ length: N_GOODS }, (_, i) => i);
  const sec = l.sector && l.sector !== 'any' ? l.sector : null;
  const gw = l.good >= 0 ? goodName(l.good).toLowerCase() : 'all goods';

  switch (l.base) {
    case 'sale': {
      if ((l.group && l.group !== 'all') || sec) return saleTargetedEstimate(s, l, towns, goods);
      let value = 0;
      let qty = 0;
      for (const t of towns)
        for (const g of goods) {
          const m = s.markets[t * N_GOODS + g];
          if (!m) continue;
          const v = fin(m.volEma > 0 ? m.volEma : m.volume);
          value += v * priceAt(s, t, g);
          qty += v;
        }
      const units = l.good >= 0 ? ` (${fmtQ(qty)} ${unitsOf(l.good)})` : '';
      return {
        baseText: `${l.good >= 0 ? goodName(l.good) : 'All'} sales${where(s, l.town)} ≈ ${fmtM(value)} a day${units}`,
        amount: pct ? rate * value : rate * qty,
        per: 'day',
        rough: false,
      };
    }
    case 'wage': {
      let bill = 0;
      let over = 0;
      let n = 0;
      let nOver = 0;
      for (const f of s.firms) {
        if (!f || !f.alive || f.status === 'closed' || f.sector === 'stateworks') continue;
        if (l.town >= 0 && f.town !== l.town) continue;
        if (sec && f.sector !== sec) continue;
        const w = fin(f.wage);
        for (const id of f.workers) {
          const p = s.people[id];
          if (!p || !personMatches(s, p, l.group)) continue;
          n++;
          bill += w;
          over += Math.max(0, w - thr);
          if (thr <= 0 || w > thr) nOver++;
        }
      }
      return {
        baseText: `${plural(n, 'worker')}${where(s, l.town)} earning ≈ ${fmtM(bill)} a day`,
        amount: pct ? rate * over : rate * nOver,
        per: 'day',
        rough: false,
      };
    }
    case 'profit': {
      let month = 0;
      let n = 0;
      for (const f of s.firms) {
        if (!f || !f.alive || f.status === 'closed' || f.sector === 'stateworks' || f.owner === STATE) continue;
        if (l.town >= 0 && f.town !== l.town) continue;
        if (sec && f.sector !== sec) continue;
        const m = fin(f.profit) * DAYS_PER_MONTH;
        if (m > 0) {
          n++;
          month += Math.max(0, m - thr);
        }
      }
      return { baseText: `${plural(n, 'firm')} in profit${where(s, l.town)}, ≈ ${fmtM(month)} a month above the threshold`, amount: rate * month, per: 'month', rough: true };
    }
    case 'money': {
      let base = 0;
      let n = 0;
      if (!sec && l.group !== 'firms') {
        for (const p of s.people) {
          if (!p || !p.alive || (l.town >= 0 && p.town !== l.town) || !personMatches(s, p, l.group)) continue;
          const c = fin(p.cash);
          if (!(c > 0)) continue;
          base += Math.max(0, c - thr);
          if (c > thr) n++;
        }
      }
      if (l.group === 'all' || l.group === 'firms') {
        for (const f of s.firms) {
          if (!f || !f.alive || f.status === 'closed' || f.sector === 'stateworks') continue;
          if (l.town >= 0 && f.town !== l.town) continue;
          if (sec && f.sector !== sec) continue;
          const c = fin(f.cash);
          if (!(c > 0)) continue;
          base += Math.max(0, c - thr);
          if (c > thr) n++;
        }
      }
      return {
        baseText: pct ? `${fmtM(base)} held${where(s, l.town)} by ${plural(n, 'account')}` : `${plural(n, 'account')}${where(s, l.town)} above the threshold`,
        amount: pct ? (rate / DAYS_PER_YEAR) * base : rate * n,
        per: 'day',
        rough: false,
      };
    }
    case 'goods': {
      let units = 0;
      let value = 0;
      let cells = 0;
      const add = (inv: number[] | undefined, town: number) => {
        if (!inv || (l.town >= 0 && town !== l.town)) return;
        for (const g of goods) {
          const q = fin(inv[g]);
          if (!(q > 0)) continue;
          units += Math.max(0, q - thr);
          value += Math.max(0, q * priceAt(s, town, g) - thr);
          if (q > thr) cells++;
        }
      };
      if (!sec && l.group !== 'firms') for (const p of s.people) if (p && p.alive && personMatches(s, p, l.group)) add(p.pantry, p.town);
      if (l.group === 'all' || l.group === 'firms') {
        for (const f of s.firms) {
          if (!f || !f.alive || f.status === 'closed' || f.sector === 'stateworks') continue;
          if (sec && f.sector !== sec) continue;
          add(f.inv, f.town);
          if (f.trade) for (let t = 0; t < f.trade.stock.length; t++) if (t !== f.town) add(f.trade.stock[t], t);
        }
      }
      const unitW = l.good >= 0 ? unitsOf(l.good) : 'units';
      return {
        baseText: `${fmtQ(units)} ${unitW} of ${gw} in store${where(s, l.town)} (≈ ${fmtM(value)})`,
        amount: l.unit === 'perUnit' ? rate * units : pct ? (rate / DAYS_PER_YEAR) * value : rate * cells,
        per: 'day',
        rough: false,
      };
    }
    case 'head': {
      let n = 0;
      for (const p of s.people) {
        if (!p || !p.alive || (l.town >= 0 && p.town !== l.town) || !personMatches(s, p, l.group)) continue;
        if (thr > 0 && !(fin(p.cash) > thr)) continue;
        n++;
      }
      return { baseText: `${plural(n, 'person', 'people')}${where(s, l.town)} match`, amount: rate * n, per: 'day', rough: false };
    }
    case 'rent': {
      let paid = 0;
      let over = 0;
      let homes = 0;
      let nOver = 0;
      for (const b of s.buildings) {
        if (!b || b.kind !== 'house' || b.status !== 'active') continue;
        if (l.town >= 0 && b.town !== l.town) continue;
        const r = fin(b.rent);
        for (const id of b.residents) {
          const p = s.people[id];
          if (!p || !p.alive) continue;
          if (l.group !== 'all') {
            const who = l.payer === 'landlord' ? (b.owner >= 0 && b.owner < FIRM_BASE ? s.people[b.owner] : undefined) : p;
            if (!who || !personMatches(s, who, l.group)) continue;
          }
          homes++;
          paid += r;
          over += Math.max(0, r - thr);
          if (thr <= 0 || r > thr) nOver++;
        }
      }
      return { baseText: `${plural(homes, 'let home')}${where(s, l.town)} paying ≈ ${fmtM(paid)} a day`, amount: pct ? rate * over : rate * nOver, per: 'day', rough: false };
    }
    case 'interest': {
      const L = s.stats?.latest ?? {};
      let day = fin(L.interestDeposits) + (fin(s.treasury.iouOutstanding) * IOU_COUPON) / DAYS_PER_YEAR;
      if (l.town >= 0) {
        const pop = s.towns.reduce((a, t) => a + fin(t.pop), 0);
        day *= pop > 0 ? fin(s.towns[l.town]?.pop) / pop : 0;
      }
      return { baseText: `Interest paid to savers${where(s, l.town)} ≈ ${fmtM(day)} a day`, amount: rate * day, per: 'day', rough: true };
    }
    case 'shipment': {
      let qty = 0;
      let value = 0;
      for (const sh of s.shipments) {
        if (!sh || sh.owner === STATE || sh.depart < s.day - 1) continue;
        if (l.town >= 0 && sh.from !== l.town) continue;
        if (l.toTown >= 0 && sh.to !== l.toTown) continue;
        if (l.good >= 0 && sh.good !== l.good) continue;
        qty += fin(sh.qty);
        value += fin(sh.qty) * fin(sh.basis);
      }
      const unitW = l.good >= 0 ? unitsOf(l.good) : 'units';
      return { baseText: `${fmtQ(qty)} ${unitW} of ${gw} set off by wagon in the last day (≈ ${fmtM(value)})`, amount: pct ? rate * value : rate * qty, per: 'day', rough: true };
    }
    case 'import':
    case 'export': {
      const f = s.foreign;
      const q = l.base === 'import' ? f?.importsQty : f?.exportsQty;
      const port = s.towns.find((t) => t.hasPort)?.id ?? 0;
      let qty = 0;
      let value = 0;
      for (const g of goods) {
        const k = fin(tailMean(s.stats?.daily?.[(l.base === 'import' ? 'imp_' : 'exp_') + g], 30));
        const today = fin(q?.[g]);
        const v = k > 0 ? k : today;
        qty += v;
        value += v * priceAt(s, port, g);
      }
      const unitW = l.good >= 0 ? unitsOf(l.good) : 'units';
      return {
        baseText: `${fmtQ(qty)} ${unitW} of ${gw} ${l.base === 'import' ? 'arriving' : 'leaving'} by sea a day (≈ ${fmtM(value)})`,
        amount: pct ? rate * value : rate * qty,
        per: 'day',
        rough: false,
      };
    }
    case 'building': {
      let n = 0;
      let book = 0;
      for (const b of s.buildings) {
        if (!b || b.status !== 'active' || b.owner === STATE) continue;
        if (l.town >= 0 && b.town !== l.town) continue;
        if (l.buildingKind && l.buildingKind !== 'any' && b.kind !== l.buildingKind) continue;
        if (sec && b.sector !== sec) continue;
        if (b.firm >= 0 && s.firms[b.firm]?.owner === STATE) continue;
        const c = fin(b.cost);
        if (thr > 0 && !(c > thr)) continue;
        n++;
        book += Math.max(0, c - thr);
      }
      return { baseText: `${plural(n, 'building')}${where(s, l.town)} (book value ≈ ${fmtM(book)})`, amount: pct ? (rate / DAYS_PER_YEAR) * book : rate * n, per: 'day', rough: false };
    }
    case 'estate': {
      const deaths = fin(tailMean(s.stats?.daily?.deaths, 60));
      let wealth = 0;
      let n = 0;
      const iouP = fin(s.iouMarket?.price);
      const goldP = fin(s.goldMarket?.price);
      for (const p of s.people) {
        if (!p || !p.alive || (l.town >= 0 && p.town !== l.town) || !personMatches(s, p, l.group)) continue;
        n++;
        wealth += Math.max(0, fin(p.cash) + fin(p.iou) * iouP + fin(p.gold) * goldP - thr);
      }
      const share = s.people.length ? n / Math.max(1, s.people.filter((p) => p && p.alive).length) : 0;
      const perDay = deaths * share;
      const avg = n ? wealth / n : 0;
      return {
        baseText: `≈ ${fmtNum(perDay * DAYS_PER_MONTH)} estates a month${where(s, l.town)}, worth ≈ ${fmtM(avg)} each on average`,
        amount: (pct ? rate * avg : rate) * perDay,
        per: 'day',
        rough: true,
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Sale levies aimed at some traders only
// ---------------------------------------------------------------------------

/** Units of good g one firm buys a day: its recipe inputs at its usual output, tool wear, carters' loads. */
function firmBuysPerDay(s: SimState, f: Firm, g: number): { q: number; rough: boolean } {
  const d = SECTORS[f.sector];
  if (!d) return { q: 0, rough: false };
  let q = 0;
  let rough = false;
  for (const [ig, per] of d.inputs) if (ig === g) q += per * Math.max(0, fin(f.output));
  if (g === G.tools && d.toolUse > 0) q += d.toolUse * f.workers.length;
  if (f.sector === 'trader') {
    // merchandise loaded here in the last day (bought in this market to be carried elsewhere)
    for (const sh of s.shipments) if (sh && sh.owner === FIRM_BASE + f.id && sh.from === f.town && sh.good === g && sh.depart >= s.day - 1) q += fin(sh.qty);
    rough = true;
  }
  if (f.sector === 'builder') rough = true; // materials come and go with projects
  return { q, rough };
}

function saleTargetedEstimate(s: SimState, l: LevyDraft, towns: number[], goods: number[]): LevyEstimate {
  const rate = fin(l.rate);
  const pct = l.unit === 'pct';
  const who = saleWhoOf(l.group, l.sector);
  const words = saleWhoWords(who);
  const sec = l.sector && l.sector !== 'any' ? l.sector : null;
  const buyer = l.payer !== 'seller';
  let qty = 0;
  let value = 0;
  let rough = false;
  let n = 0;
  if (who.startsWith('f:')) {
    const inTown = new Set(towns);
    for (const f of s.firms) {
      if (!f || !f.alive || f.status === 'closed' || f.sector === 'stateworks') continue;
      if (!inTown.has(f.town) || (sec && f.sector !== sec)) continue;
      let touched = false;
      for (const g of goods) {
        let q = 0;
        if (buyer) {
          const b = firmBuysPerDay(s, f, g);
          q = b.q;
          rough ||= b.rough;
        } else if (SECTORS[f.sector]?.out === g) q = Math.max(0, fin(f.sales));
        else if (f.sector === 'trader' && f.trade) {
          // carters sell the stock they hold in this town's market
          const m = s.markets[f.town * N_GOODS + g];
          q = Math.min(fin(m?.volEma), Math.max(0, fin(f.trade.stock[f.town]?.[g])) * 0.25);
          rough = true;
        }
        if (q > 0) {
          qty += q;
          value += q * priceAt(s, f.town, g);
          touched = true;
        }
      }
      if (touched) n++;
    }
  } else {
    // households: their share of the town's consumer purchases (market volume less what firms buy)
    rough = true;
    for (const t of towns) {
      let pop = 0;
      let members = 0;
      for (const p of s.people) {
        if (!p || !p.alive || p.town !== t) continue;
        pop++;
        if (personMatches(s, p, l.group)) members++;
      }
      n += members;
      const share = pop > 0 ? members / pop : 0;
      for (const g of goods) {
        if (!CONSUMER_GOODS.includes(g)) continue;
        const m = s.markets[t * N_GOODS + g];
        let firmQ = 0;
        for (const f of s.firms) if (f && f.alive && f.town === t && f.sector !== 'stateworks') firmQ += firmBuysPerDay(s, f, g).q;
        const hh = Math.max(0, fin(m?.volEma > 0 ? m.volEma : m?.volume) - firmQ);
        qty += hh * share;
        value += hh * share * priceAt(s, t, g);
      }
    }
  }
  const unitW = l.good >= 0 ? ` (${fmtQ(qty)} ${unitsOf(l.good)})` : '';
  const whoText = !who.startsWith('f:') ? `${fmtNum(n)} ${words}` : sec ? `${fmtNum(n)} ${n === 1 ? (SECTORS[sec]?.name ?? 'workshop').toLowerCase() : words}` : plural(n, 'workshop');
  const gw = l.good >= 0 ? goodName(l.good).toLowerCase() : 'goods';
  return {
    baseText: `${buyer ? 'Purchases' : 'Sales'} of ${gw} by ${whoText}${where(s, l.town)} ≈ ${fmtM(value)} a day${unitW}`,
    amount: pct ? rate * value : rate * qty,
    per: 'day',
    rough,
  };
}
