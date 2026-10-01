// ============================================================================
// One good, town by town: what each town makes, uses, brings in and sends out
// (a day, over the last 14 days: sim/stats/flows.ts), its market's balance and
// price, and what the Treasury holds there. Shared by Markets → a good's detail
// and Levers → Trade → Carry (where each row can be picked as a store to carry
// from and the town to carry to).
//
//   made  − used = net: + the town makes more than it uses (it sends the rest
//   out), − it uses more than it makes (it brings the rest in). "Traded" is
//   different again: what changed hands in the town's market hall.
// ============================================================================
import { recentBalance, type Balance } from '../../../sim/market/markets';
import { recentFlows, type Flows } from '../../../sim/stats/flows';
import { N_GOODS } from '../../../sim/goods';
import type { SimState } from '../../../sim/types';
import { h, toggleClass } from '../../dom';
import { fmtPct, fmtPrice } from '../../format';
import { badgeOf } from './data';

export interface TownFlowRow {
  town: number;
  name: string;
  flows: Flows;
  balance: Balance;
  price: number;
  held: number;
}

/** Every town's flows of one good, and the realm's (sums; town −1) last. */
export function townFlowRows(s: SimState, good: number): { rows: TownFlowRow[]; realm: Flows } {
  const rows: TownFlowRow[] = [];
  const realm: Flows = { days: 0, made: 0, used: 0, in: 0, out: 0, traded: 0, net: 0 };
  if (!(good >= 0 && good < N_GOODS)) return { rows, realm };
  for (const t of s.towns) {
    const m = s.markets[t.id * N_GOODS + good];
    const f = recentFlows(m);
    rows.push({ town: t.id, name: t.name, flows: f, balance: recentBalance(m), price: m ? (m.ema > 0 ? m.ema : m.price) : 0, held: Math.max(0, s.treasury.goods[t.id]?.[good] ?? 0) });
    realm.days = Math.max(realm.days, f.days);
    realm.made += f.made;
    realm.used += f.used;
    realm.in += f.in;
    realm.out += f.out;
    realm.traded += f.traded;
  }
  realm.net = realm.made - realm.used;
  return { rows, realm };
}

/** "12", "1.4k", "0.3"; "·" for nothing. */
export function qtyCell(x: number): string {
  const a = Math.abs(x);
  if (a < 0.05) return '·';
  if (a < 10) return a.toFixed(1);
  if (a < 1000) return String(Math.round(a));
  return (a / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
}

/** Net with its sign: "+296", "−245", "·". */
export function netCell(x: number): string {
  return Math.abs(x) < 0.05 ? '·' : (x > 0 ? '+' : '−') + qtyCell(x);
}

/** The market column: "short 5%", "9% unsold" ("left 9%" when narrow), "·". */
export function balanceCell(b: Balance, narrow = false): string {
  const f = badgeOf(b.volume, b.shortage, b.surplus);
  if (f === 'shortage') return `short ${fmtPct(Math.abs(b.net), 0)}`;
  if (f === 'surplus') return narrow ? `left ${fmtPct(Math.abs(b.net), 0)}` : `${fmtPct(Math.abs(b.net), 0)} unsold`;
  return '·';
}

export interface ByTownPick {
  /** Is `town` one of the stores to carry from / the town to carry to? */
  isFrom(town: number): boolean;
  isTo(town: number): boolean;
  onFrom(town: number): void;
  onTo(town: number): void;
}

export interface ByTown {
  el: HTMLElement;
  update(s: SimState, good: number, focus?: number): void;
}

/**
 * The table. With `pick`, each row gets a "from" toggle and a "to" choice (and the "Held" column);
 * with `onTown`, clicking a town's name opens it.
 */
export function byTownTable(opts: { pick?: ByTownPick; onTown?: (town: number) => void } = {}): ByTown {
  const pick = opts.pick;
  const el = h('div', { class: 'bt' + (pick ? ' bt-pick' : '') });
  let sig = '';
  // (the carry form is narrow: it leaves out In and Out)
  const heads = pick ? ['Town', 'Made', 'Used', 'Net', 'Market', 'Held', 'From', 'To'] : ['Town', 'Made', 'Used', 'Net', 'In', 'Out', 'Market', 'Price'];
  const tips: Record<string, string> = {
    Made: 'Produced by the workshops of the town, a day (last 14 days)',
    Used: 'Used up there a day: eaten, burnt, drunk, worn out, worked into other goods or buildings, burnt by wagons',
    Net: 'Made − used: + the town makes more than it uses and sends the rest out; − it uses more than it makes and brings the rest in',
    In: 'Brought in a day: wagons arriving, and goods bought from foreign ships at a port',
    Out: 'Sent out a day: wagons leaving, and goods sold to foreign ships at a port',
    Market: 'The market hall over the last 14 days: buyers who went short (short), or stock left unsold (left / unsold)',
    Held: 'What the Treasury holds in its store there',
    Price: 'Going price in the town’s market',
  };
  return {
    el,
    update(s, good, focus = -2) {
      const { rows, realm } = townFlowRows(s, good);
      const key = [good, focus, ...rows.map((r) => [qtyCell(r.flows.made), qtyCell(r.flows.used), qtyCell(r.flows.in), qtyCell(r.flows.out), balanceCell(r.balance), pick ? qtyCell(r.held) : fmtPrice(r.price), pick ? `${pick.isFrom(r.town)}${pick.isTo(r.town)}` : ''].join(','))].join('|');
      if (key === sig) return;
      sig = key;
      const head = h('div', { class: 'bt-r bt-h' }, heads.map((x) => h('span', { title: tips[x] ?? null }, x)));
      const body = rows.map((r) => {
        const f = r.flows;
        const netTone = f.net > 0.05 ? 'bt-plus' : f.net < -0.05 ? 'bt-minus' : '';
        const bf = badgeOf(r.balance.volume, r.balance.shortage, r.balance.surplus);
        const name = opts.onTown
          ? h('button', { class: 'bt-town ent-link', type: 'button', title: `Open ${r.name}’s market`, onClick: () => opts.onTown?.(r.town) }, r.name)
          : h('span', { class: 'bt-town' }, r.name);
        const cells: (HTMLElement | string)[] = [name, h('span', null, qtyCell(f.made)), h('span', null, qtyCell(f.used)), h('span', { class: netTone }, netCell(f.net))];
        if (!pick) cells.push(h('span', { class: 'bt-dim' }, qtyCell(f.in)), h('span', { class: 'bt-dim' }, qtyCell(f.out)));
        cells.push(h('span', { class: bf === 'shortage' ? 'bt-short' : bf === 'surplus' ? 'bt-unsold' : 'bt-dim', title: bf ? `Over the last ${r.balance.days} days: ${bf === 'shortage' ? 'buyers went short' : 'stock was left unsold'} (${fmtPct(Math.abs(r.balance.net), 0)} of what was ${bf === 'shortage' ? 'wanted' : 'offered'})` : null }, balanceCell(r.balance, !!pick)));
        if (pick) {
          const from = h('button', { class: 'lv-chip bt-pickb', type: 'button', title: `Carry from the Treasury’s store in ${r.name} (pick several to draw on each equally)` }, 'from');
          const to = h('button', { class: 'lv-chip bt-pickb', type: 'button', title: `Carry to ${r.name}` }, 'to');
          toggleClass(from, 'on', pick.isFrom(r.town));
          toggleClass(to, 'on', pick.isTo(r.town));
          from.addEventListener('click', () => pick.onFrom(r.town));
          to.addEventListener('click', () => pick.onTo(r.town));
          cells.push(h('span', { class: r.held > 0.05 ? '' : 'bt-dim' }, qtyCell(r.held)), from, to);
        } else cells.push(h('span', { class: 'bt-dim' }, r.price > 0 ? fmtPrice(r.price) : '·'));
        const row = h('div', { class: 'bt-r' }, cells);
        toggleClass(row, 'bt-focus', r.town === focus);
        return row;
      });
      const total = h(
        'div',
        { class: 'bt-r bt-total' },
        h('span', { class: 'bt-town' }, 'Realm'),
        h('span', null, qtyCell(realm.made)),
        h('span', null, qtyCell(realm.used)),
        h('span', { class: realm.net > 0.05 ? 'bt-plus' : realm.net < -0.05 ? 'bt-minus' : '' }, netCell(realm.net)),
        // (between towns, what one sends out another brings in: no realm total for In / Out)
        ...Array.from({ length: pick ? 4 : 4 }, () => h('span', null, '')),
      );
      const counting = realm.days === 0 ? [h('div', { class: 'bt-counting' }, 'Counting starts today: these figures fill in over the next days.')] : [];
      el.replaceChildren(head, ...body, total, ...counting);
    },
  };
}
