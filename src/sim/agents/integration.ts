// ============================================================================
// Firms under one control: what owning a rival or a supplier does. OWNER: firms
// agent. See DESIGN §3.2 (and agents/invest.ts, where buyers value it).
//
// A firm's controller is whoever holds its largest share — followed up the chain
// when that is another firm (a subsidiary's parent's controller). Firms with the
// same controller form a group.
//
//   · Horizontal — firms of one group making the same good in the same town set
//     their prices together: to the margin each would keep alone they add
//     INTEGRATION_POWER × (the group's share of the town's sales of the good − the
//     firm's own) / the demand's elasticity (a Lerner-style margin: the more of the
//     market one owner holds, the higher the price it can keep), at most
//     INTEGRATION_MARKUP_MAX. That is the gain a buyer of a rival pays for — and the
//     cost to the town's buyers (a price Limit answers it).
//   · Vertical — each morning, before the market meets, a group's supplier passes to
//     a sister firm of the same town what it needs of the supplier's good for
//     SISTER_DAYS of making (at most half the supplier's stock), at the going price:
//     the goods and the money move between them directly, and the customer cannot go
//     short in the market hall while its sister has stock.
// ============================================================================
import { ENTRY_DEMAND_ELASTICITY, INTEGRATION_MARKUP_MAX, INTEGRATION_POWER, SISTER_DAYS } from '../config';
import { N_GOODS, SECTORS } from '../goods';
import { firmRef, isFirm, pay, refId } from '../ledger';
import { marketOf } from '../market/markets';
import { rt } from '../runtime';
import type { Firm, Ref, SimState } from '../types';
import { fin } from '../util';

/** Whoever controls `f`: its largest holder, followed up through firms that own firms. */
export function controllerOf(s: SimState, f: Firm): Ref {
  let ref = f.owner;
  for (let k = 0; k < 6 && isFirm(ref); k++) {
    const o = s.firms[refId(ref)];
    if (!o || !o.alive || o.id === f.id) break;
    ref = o.owner;
  }
  return ref;
}

interface Groups {
  day: number;
  /** controller|town|good → the group's sales and its number of firms there. */
  sales: Map<string, { sold: number; n: number }>;
  /** town*N_GOODS+good → all firms' sales there. */
  market: Float64Array;
}

function groups(s: SimState): Groups {
  const bag = rt(s).bag;
  let g = bag.integrationGroups as Groups | undefined;
  if (g && g.day === s.day) return g;
  g = { day: s.day, sales: new Map(), market: new Float64Array(s.towns.length * N_GOODS) };
  for (const f of s.firms) {
    if (!f || !f.alive || f.status !== 'active') continue;
    const d = SECTORS[f.sector];
    if (!d || !d.producer) continue;
    const sold = Math.max(0, fin(f.salesLong > 0 ? f.salesLong : f.sales));
    g.market[f.town * N_GOODS + d.out] += sold;
    const key = `${controllerOf(s, f)}|${f.town}|${d.out}`;
    const e = g.sales.get(key) ?? { sold: 0, n: 0 };
    e.sold += sold;
    e.n += 1;
    g.sales.set(key, e);
  }
  bag.integrationGroups = g;
  return g;
}

/** The extra margin a firm keeps for being one of a group's several makers of its good in its town (a share of its price). */
export function groupMarkup(s: SimState, f: Firm): number {
  const d = SECTORS[f.sector];
  if (!d || !d.producer || f.owner < 0) return 0;
  const g = groups(s);
  const e = g.sales.get(`${controllerOf(s, f)}|${f.town}|${d.out}`);
  if (!e || e.n < 2) return 0;
  const all = g.market[f.town * N_GOODS + d.out];
  if (!(all > 0)) return 0;
  const own = Math.max(0, fin(f.salesLong > 0 ? f.salesLong : f.sales)) / all;
  const eps = ENTRY_DEMAND_ELASTICITY[d.out] ?? 1;
  return Math.min(INTEGRATION_MARKUP_MAX, Math.max(0, (INTEGRATION_POWER * (e.sold / all - own)) / eps));
}

/** Each morning, before the market: suppliers pass sister firms of their town what they need (see the header). */
export function sisterSupply(s: SimState): void {
  // suppliers by controller|town|good
  const byKey = new Map<string, Firm[]>();
  let any = false;
  for (const f of s.firms) {
    if (!f || !f.alive || f.status !== 'active' || f.owner < 0) continue;
    const d = SECTORS[f.sector];
    if (!d || !d.producer || !(f.inv[d.out] > 0)) continue;
    const key = `${controllerOf(s, f)}|${f.town}|${d.out}`;
    let list = byKey.get(key);
    if (!list) byKey.set(key, (list = []));
    list.push(f);
    any = true;
  }
  if (!any) return;
  const acc = s.stats.acc;
  for (const b of s.firms) {
    if (!b || !b.alive || b.status !== 'active' || b.owner < 0) continue;
    const d = SECTORS[b.sector];
    if (!d || !d.producer || !d.inputs.length) continue;
    const ctl = controllerOf(s, b);
    const use = Math.max(0, fin(b.output));
    for (const [g, a] of d.inputs) {
      const list = byKey.get(`${ctl}|${b.town}|${g}`);
      if (!list) continue;
      let want = Math.max(0, a * use * SISTER_DAYS - Math.max(0, fin(b.inv[g])));
      const price = Math.max(0, fin(marketOf(s, b.town, g).ema));
      if (!(want > 1e-6) || !(price > 0)) continue;
      for (const sup of list) {
        if (sup.id === b.id || !(want > 1e-6)) continue;
        const q0 = Math.min(want, 0.5 * Math.max(0, fin(sup.inv[g])), Math.max(0, fin(b.cash)) / price);
        if (!(q0 > 1e-6)) continue;
        const paid = pay(s, firmRef(b.id), firmRef(sup.id), q0 * price, 'buy');
        const q = paid / price;
        if (!(q > 1e-9)) continue;
        sup.inv[g] -= q;
        b.inv[g] += q;
        sup.revenue += paid;
        sup.soldToday += q;
        b.spent += paid;
        want -= q;
        acc.inhouse_value = (acc.inhouse_value || 0) + paid;
      }
    }
  }
}
