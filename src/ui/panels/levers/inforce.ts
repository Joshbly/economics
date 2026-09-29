// ============================================================================
// Levers panel — "In force": everything the Treasury currently has running.
//   Levies  : label, plain description, today / this month / last month
//             (+ collected, − paid), on/off, inline rate edit, remove
//   Limits  : description, days it bound this month, on/off, remove
//   Orders  : description, filled today / in all, value, on/off, inline price
//             edit, cancel. Supply routes show their pipeline instead
//             (bought today → on the road → waiting → sold today) and result.
//   Lines   : Treasury freight lines (./lines.ts): wagons out, carried, accounts,
//             pause, close
//   Projects: Treasury construction with progress
// Rows are keyed by id and updated in place (4×/s safe).
// ============================================================================
import { PLAYER_MAX_PCT, PLAYER_MAX_PRICE, PLAYER_MAX_UNIT_RATE } from '../../../sim/config';
import { GOODS } from '../../../sim/goods';
import { describeLevy, describeLimit, describeOrder } from '../../../sim/policy/player';
import type { Levy, Limit, PlayerOrder, SimState } from '../../../sim/types';
import { h, setText, setTone, show, toggleClass } from '../../dom';
import { fmtDay, fmtPct, fmtPrice, plural } from '../../format';
import { icon, numberInput, toggle, type NumberInput } from '../../widgets';
import { fin, flowTone, fmtMS, fmtQ, keyedList, polishRule, run, safe, signedMoney, tersely, TONES, unitsOf } from './common';
import { baseDef, saleWhoOf, saleWhoWords } from './levyDefs';
import { projectList, treasuryProjects } from './projects';
import { pipeline, routeResult, routeWords, type Pipeline } from './flows';
import { sellText } from './route';
import { freightLines, lineList } from './lines';

// ---------------------------------------------------------------------------
// Inline number editor (a value pill that turns into an input on click)
// ---------------------------------------------------------------------------
interface InlineEdit {
  el: HTMLElement;
  refresh(text: string, value: number, percent: boolean, max: number): void;
}

function inlineEdit(title: string, commit: (v: number) => void): InlineEdit {
  let percent = false;
  let max = 1e6;
  let value = 0;
  let editing = false;
  let cancelled = false;
  let input: NumberInput | null = null;
  const txt = h('span', { class: 'lv-pill-t' });
  const pill = h('button', { class: 'lv-pill', type: 'button', title }, txt, icon('sliders', 12));
  const slot = h('span', { class: 'lv-pill-slot' });
  const el = h('span', { class: 'lv-inline' }, pill, slot);
  // Closing removes the focused input, which fires blur → change → onCommit again;
  // `editing` is cleared first so that re-entry is a no-op.
  const stop = () => {
    if (!editing && !input) return;
    editing = false;
    const old = input;
    input = null;
    pill.hidden = false;
    if (old && old.el.parentNode === slot) slot.replaceChildren();
  };
  pill.addEventListener('click', () => {
    editing = true;
    cancelled = false;
    input = numberInput({
      value,
      percent,
      prefix: percent ? undefined : '¤',
      min: 0,
      max,
      width: '96px',
      onCommit: (v) => {
        if (!editing || cancelled) return;
        editing = false;
        if (Math.abs(v - value) > 1e-12) commit(v);
        stop();
      },
    });
    input.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelled = true;
        stop();
      }
    });
    input.input.addEventListener('blur', () => {
      // a blur without a valid change closes the editor
      setTimeout(() => editing && !cancelled && stop(), 0);
    });
    pill.hidden = true;
    slot.replaceChildren(input.el);
    input.focus();
  });
  return {
    el,
    refresh(text, v, pct, mx) {
      setText(txt, text);
      if (!editing) {
        value = v;
        percent = pct;
        max = mx;
      }
    },
  };
}

function stat(label: string): { el: HTMLElement; v: HTMLElement } {
  const v = h('span', { class: 'lv-stat-v' });
  return { el: h('span', { class: 'lv-stat' }, h('span', { class: 'lv-stat-l' }, label), v), v };
}

function removeBtn(title: string, onClick: () => void): HTMLButtonElement {
  return h('button', { class: 'icon-btn lv-ibtn', type: 'button', title, 'aria-label': title, onClick }, icon('trash', 15));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------
function levyRate(l: Levy): string {
  const d = baseDef(l.base);
  if (l.unit === 'pct') return fmtPct(l.rate) + (d.stock ? '/yr' : '');
  const per =
    l.base === 'wage'
      ? '/worker-day'
      : l.base === 'rent'
        ? '/home-day'
        : l.base === 'goods'
          ? l.unit === 'perUnit'
            ? '/unit/day'
            : '/day'
          : l.base === 'estate'
            ? ' each'
            : l.unit === 'flat'
              ? '/day'
              : l.good >= 0
                ? '/' + (GOODS[l.good]?.unit ?? 'unit')
                : '/unit';
  return fmtPrice(l.rate) + per;
}

/** Short title for a levy row: what it applies to (the rate sits in its own pill). */
function levyTitle(s: SimState, l: Levy): string {
  const g = l.good >= 0 ? (GOODS[l.good]?.name ?? 'Goods') : 'All goods';
  const where = l.town >= 0 ? ` · ${s.towns[l.town]?.name ?? ''}` : '';
  switch (l.base) {
    case 'sale': {
      const who = saleWhoWords(saleWhoOf(l.group, l.sector));
      return who ? `${g} ${l.payer === 'seller' ? 'sold' : 'bought'} by ${who}${where}` : `${g} sales${where}`;
    }
    case 'wage':
      return `Wages${where}`;
    case 'rent':
      return `Rents${where}`;
    case 'profit':
      return `Profits${where}`;
    case 'money':
      return `Money held${where}`;
    case 'goods':
      return `${g} in store${where}`;
    case 'head':
      return `Per head${where}`;
    case 'interest':
      return `Interest earned${where}`;
    case 'shipment':
      return `${g} carried${l.town >= 0 ? ' from ' + (s.towns[l.town]?.name ?? '') : ''}${l.toTown >= 0 ? ' to ' + (s.towns[l.toTown]?.name ?? '') : ''}`;
    case 'import':
      return `${g} imports`;
    case 'export':
      return `${g} exports`;
    case 'building':
      return `Buildings${where}`;
    case 'estate':
      return `Estates${where}`;
  }
  return l.label;
}

/** Short title for an order row (the price sits in its own pill). */
function orderTitle(s: SimState, o: PlayerOrder): string {
  const m = o.market;
  if (m.kind === 'labor') return `Workers · ${s.towns[m.town]?.name ?? ''}`;
  if (m.kind === 'good') return `${GOODS[m.good]?.name ?? 'Goods'} · ${s.towns[m.town]?.name ?? ''}`;
  if (m.kind === 'iou') return 'IOUs';
  return 'Gold';
}

interface LevyRow {
  el: HTMLElement;
  sw: ReturnType<typeof toggle>;
  title: HTMLElement;
  desc: HTMLElement;
  today: ReturnType<typeof stat>;
  month: ReturnType<typeof stat>;
  lastM: ReturnType<typeof stat>;
  rate: InlineEdit;
  dir: HTMLElement;
}

function levyRow(l: Levy): LevyRow {
  const id = l.id;
  const sw = toggle({ value: l.enabled, title: 'Switch this rule on or off', onChange: (v) => run({ type: 'updateLevy', id, patch: { enabled: v } }, null) });
  const title = h('div', { class: 'lv-if-t' });
  const desc = h('div', { class: 'lv-if-d' });
  const today = stat('Today');
  const month = stat('This month');
  const lastM = stat('Last month');
  const rate = inlineEdit('Change the rate', (v) => run({ type: 'updateLevy', id, patch: { rate: v } }, null));
  const dir = h('span', { class: 'lv-dir' });
  const rm = removeBtn('Remove this rule', () => run({ type: 'removeLevy', id }, null));
  const el = h(
    'div',
    { class: 'lv-if' },
    h('div', { class: 'lv-if-sw' }, sw.el),
    h('div', { class: 'lv-if-main' }, h('div', { class: 'lv-if-head' }, dir, title, h('span', { class: 'spacer' }), rate.el), desc, h('div', { class: 'lv-if-stats' }, today.el, month.el, lastM.el)),
    h('div', { class: 'lv-if-act' }, rm),
  );
  return { el, sw, title, desc, today, month, lastM, rate, dir };
}

function paintLevy(s: SimState, v: LevyRow, l: Levy): void {
  v.sw.set(l.enabled);
  toggleClass(v.el, 'off', !l.enabled);
  setText(v.dir, l.dir === 1 ? 'Take' : 'Pay');
  setTone(v.dir, TONES, l.dir === 1 ? 'good' : 'bad');
  setText(v.title, levyTitle(s, l));
  setText(v.desc, tersely(safe(() => describeLevy(s, l), l.label)));
  const put = (x: ReturnType<typeof stat>, n: number) => {
    const v = fin(n);
    setText(x.v, Math.abs(v) >= 1000 ? (v > 0 ? '+' : '−') + fmtMS(Math.abs(v)) : signedMoney(v));
    x.v.title = signedMoney(v);
    setTone(x.v, TONES, flowTone(fin(n)));
  };
  put(v.today, l.today);
  put(v.month, l.month);
  put(v.lastM, l.lastMonth);
  v.rate.refresh(levyRate(l), l.rate, l.unit === 'pct', l.unit === 'pct' ? PLAYER_MAX_PCT : PLAYER_MAX_UNIT_RATE);
}

interface LimitRow {
  el: HTMLElement;
  sw: ReturnType<typeof toggle>;
  desc: HTMLElement;
  bind: HTMLElement;
  meta: HTMLElement;
}

function limitRow(l: Limit): LimitRow {
  const id = l.id;
  const sw = toggle({ value: l.enabled, title: 'Switch this limit on or off', onChange: (v) => run({ type: 'updateLimit', id, patch: { enabled: v } }, null) });
  const desc = h('div', { class: 'lv-if-t lv-if-t-wrap' });
  const bind = h('span', { class: 'chip' });
  const meta = h('span', { class: 'lv-if-meta' });
  const rm = removeBtn('Remove this limit', () => run({ type: 'removeLimit', id }, null));
  const el = h(
    'div',
    { class: 'lv-if' },
    h('div', { class: 'lv-if-sw' }, sw.el),
    h('div', { class: 'lv-if-main' }, desc, h('div', { class: 'lv-if-stats' }, bind, meta)),
    h('div', { class: 'lv-if-act' }, rm),
  );
  return { el, sw, desc, bind, meta };
}

function paintLimit(s: SimState, v: LimitRow, l: Limit): void {
  v.sw.set(l.enabled);
  toggleClass(v.el, 'off', !l.enabled);
  setText(v.desc, polishRule(safe(() => describeLimit(s, l), l.label)));
  const b = fin(l.binding);
  setText(v.bind, b > 0 ? `Bound ${plural(b, 'day')} this month` : 'Not binding this month');
  setTone(v.bind, TONES, b > 0 ? 'warn' : null);
  setText(v.meta, `since ${fmtDay(l.created)}`);
}

interface OrderRow {
  el: HTMLElement;
  sw: ReturnType<typeof toggle>;
  title: HTMLElement;
  desc: HTMLElement;
  today: ReturnType<typeof stat>;
  all: ReturnType<typeof stat>;
  value: ReturnType<typeof stat>;
  price: InlineEdit;
  side: HTMLElement;
  /** Supply routes only. */
  pipe: Pipeline | null;
  result: ReturnType<typeof stat> | null;
}

function orderRow(o: PlayerOrder): OrderRow {
  if (o.route) return routeOrderRow(o);
  const id = o.id;
  const sw = toggle({ value: o.enabled, title: 'Pause or resume this order', onChange: (v) => run({ type: 'updateOrder', id, patch: { enabled: v } }, null) });
  const title = h('div', { class: 'lv-if-t' });
  const desc = h('div', { class: 'lv-if-d' });
  const today = stat('Today');
  const all = stat('In all');
  const value = stat('Value');
  const price = inlineEdit('Change the price limit (a following order becomes fixed at this price)', (v) => run({ type: 'updateOrder', id, patch: { priceMode: 'fixed', price: v } }, null));
  const side = h('span', { class: 'lv-dir' });
  const rm = removeBtn('Withdraw this order', () => run({ type: 'cancelOrder', id }, null));
  const el = h(
    'div',
    { class: 'lv-if' },
    h('div', { class: 'lv-if-sw' }, sw.el),
    h('div', { class: 'lv-if-main' }, h('div', { class: 'lv-if-head' }, side, title, h('span', { class: 'spacer' }), price.el), desc, h('div', { class: 'lv-if-stats' }, today.el, all.el, value.el)),
    h('div', { class: 'lv-if-act' }, rm),
  );
  return { el, sw, title, desc, today, all, value, price, side, pipe: null, result: null };
}

/** A supply route: the buy order's pill and switch, its pipeline and running result. */
function routeOrderRow(o: PlayerOrder): OrderRow {
  const id = o.id;
  const sw = toggle({ value: o.enabled, title: 'Pause or resume buying for this route', onChange: (v) => run({ type: 'updateOrder', id, patch: { enabled: v } }, null) });
  const title = h('div', { class: 'lv-if-t' });
  const desc = h('div', { class: 'lv-if-d' });
  const today = stat('Today');
  const all = stat('Bought');
  const value = stat('Sold');
  const result = stat('Result');
  const price = inlineEdit('Change the most the route pays (a following limit becomes fixed at this price)', (v) => run({ type: 'updateOrder', id, patch: { priceMode: 'fixed', price: v } }, null));
  const side = h('span', { class: 'lv-dir' });
  const pipe = pipeline({ compact: true });
  const rm = removeBtn('Withdraw this route: it stops buying, and what it bought stays in the Treasury’s stores', () => run({ type: 'cancelOrder', id }, null));
  const el = h(
    'div',
    { class: 'lv-if lv-if-route' },
    h('div', { class: 'lv-if-sw' }, sw.el),
    h(
      'div',
      { class: 'lv-if-main' },
      h('div', { class: 'lv-if-head' }, side, title, h('span', { class: 'spacer' }), price.el),
      desc,
      pipe.el,
      h('div', { class: 'lv-if-stats' }, all.el, value.el, result.el),
    ),
    h('div', { class: 'lv-if-act' }, rm),
  );
  return { el, sw, title, desc, today, all, value, price, side, pipe, result };
}

function paintRouteOrder(s: SimState, v: OrderRow, o: PlayerOrder): void {
  const r = o.route;
  if (!r || o.market.kind !== 'good') return;
  v.sw.set(o.enabled);
  toggleClass(v.el, 'off', !o.enabled);
  setText(v.side, 'Route');
  setTone(v.side, TONES, 'gold');
  setText(v.title, `${GOODS[o.market.good]?.name ?? 'Goods'} → ${s.towns[r.to]?.name ?? ''}`);
  v.title.title = `${GOODS[o.market.good]?.name ?? 'Goods'}: bought in ${s.towns[o.market.town]?.name ?? ''}, offered in ${s.towns[r.to]?.name ?? ''}`;
  const g = o.market.good;
  setText(v.desc, `${s.towns[o.market.town]?.name ?? ''} → ${s.towns[r.to]?.name ?? ''}: up to ${fmtQ(o.qty)} ${unitsOf(g)} a day at ${limitText(o)}, offered ${sellText(r, g)}.`);
  v.desc.title = tersely(routeWords(s, o) || o.label);
  v.pipe?.set(s, o);
  setText(v.all.v, fmtQ(fin(o.filled)) + (o.total >= 0 ? ` / ${fmtQ(o.total)}` : ''));
  setText(v.value.v, fmtQ(fin(r.soldTotal)));
  const rr = routeResult(o).result;
  if (v.result) {
    setText(v.result.v, Math.abs(rr) >= 1000 ? (rr > 0 ? '+' : '−') + fmtMS(Math.abs(rr)) : signedMoney(rr));
    v.result.v.title = 'Sales at the destination less purchases and freight: ' + signedMoney(rr);
    setTone(v.result.v, TONES, flowTone(rr));
  }
  v.price.refresh(limitText(o), o.price, false, PLAYER_MAX_PRICE);
}

/** An order's price limit in a few words: '≤ ¤4.20', 'market +10%', 'any price'. */
function limitText(o: PlayerOrder): string {
  const mode = o.priceMode ?? 'fixed';
  if (mode === 'any') return 'any price';
  if (mode === 'follow') return `market ${o.side === 'buy' ? '+' : '−'}${Math.round(fin(o.band) * 100)}%`;
  return (o.side === 'buy' ? '≤ ' : '≥ ') + fmtPrice(o.price);
}

function paintOrder(s: SimState, v: OrderRow, o: PlayerOrder): void {
  if (v.pipe) return paintRouteOrder(s, v, o);
  v.sw.set(o.enabled);
  toggleClass(v.el, 'off', !o.enabled);
  const labor = o.market.kind === 'labor';
  setText(v.side, labor ? 'Hire' : o.market.kind === 'iou' ? (o.side === 'buy' ? 'Retire' : 'Issue') : o.side === 'buy' ? 'Buy' : 'Sell');
  setTone(v.side, TONES, o.side === 'buy' ? 'gold' : null);
  setText(v.title, orderTitle(s, o));
  setText(v.desc, tersely(safe(() => describeOrder(s, o), o.label)));
  setText(v.today.v, `${fmtQ(fin(o.filledToday))} of ${fmtQ(o.qty)}${o.market.kind === 'gold' ? ' oz' : ''}`);
  setText(v.all.v, fmtQ(fin(o.filled)) + (o.total >= 0 ? ` / ${fmtQ(o.total)}` : ''));
  // value: positive = spent from the Purse
  const val = -fin(o.value);
  setText(v.value.v, Math.abs(val) >= 1000 ? (val > 0 ? '+' : '−') + fmtMS(Math.abs(val)) : signedMoney(val));
  v.value.v.title = signedMoney(val);
  setTone(v.value.v, TONES, flowTone(val));
  v.price.refresh(labor ? fmtPrice(o.price) + '/day' : limitText(o), o.price, false, PLAYER_MAX_PRICE);
}

// ---------------------------------------------------------------------------
// The whole list
// ---------------------------------------------------------------------------
export interface InForce {
  el: HTMLElement;
  update(s: SimState): void;
  count(s: SimState): number;
}

function group(title: string, list: HTMLElement): { el: HTMLElement; count: HTMLElement } {
  const count = h('span', { class: 'lv-grp-n' });
  return { el: h('div', { class: 'lv-grp' }, h('div', { class: 'lv-grp-t' }, title, count), list), count };
}

export function inForce(): InForce {
  let state: SimState | null = null;
  const levyList = h('div', { class: 'lv-if-list' });
  const limitList = h('div', { class: 'lv-if-list' });
  const orderList = h('div', { class: 'lv-if-list' });
  const projects = projectList({ compact: true });
  const lines = lineList({ compact: true });
  const gLevy = group('Levies', levyList);
  const gLimit = group('Limits', limitList);
  const gOrder = group('Treasury orders', orderList);
  const gProj = group('Projects', projects.el);
  const gLine = group('Freight lines', lines.el);
  const empty = h(
    'div',
    { class: 'lv-empty' },
    h('div', { class: 'lv-empty-t' }, 'Nothing is in force.'),
    h('div', null, 'The realm is running on its own. Pull any lever above — alone or in combination — and watch what the markets, the Ledger and the people do.'),
  );
  const el = h('div', { class: 'lv-inforce' }, empty, gLevy.el, gLimit.el, gOrder.el, gLine.el, gProj.el);

  const recLevy = keyedList<Levy, LevyRow>(levyList, (l) => l.id, (l) => levyRow(l), (v, l) => state && paintLevy(state, v, l));
  const recLimit = keyedList<Limit, LimitRow>(limitList, (l) => l.id, (l) => limitRow(l), (v, l) => state && paintLimit(state, v, l));
  const recOrder = keyedList<PlayerOrder, OrderRow>(orderList, (o) => o.id, (o) => orderRow(o), (v, o) => state && paintOrder(state, v, o));

  return {
    el,
    count(s) {
      return s.policy.levies.length + s.policy.limits.length + s.policy.orders.length + freightLines(s).length + treasuryProjects(s).filter((p) => p.status !== 'done').length;
    },
    update(s) {
      state = s;
      const P = s.policy;
      recLevy(P.levies);
      recLimit(P.limits);
      recOrder(P.orders);
      const np = projects.set(s);
      const nl = lines.update(s);
      show(gLine.el, nl > 0);
      setText(gLine.count, nl ? String(nl) : '');
      show(gLevy.el, P.levies.length > 0);
      show(gLimit.el, P.limits.length > 0);
      show(gOrder.el, P.orders.length > 0);
      show(gProj.el, np > 0);
      const lNet = P.levies.reduce((a, l) => a + fin(l.today), 0);
      setText(gLevy.count, `${P.levies.length} · ${signedMoney(lNet)} today`);
      setTone(gLevy.count, TONES, flowTone(lNet));
      const bound = P.limits.filter((l) => l.enabled && l.binding > 0).length;
      setText(gLimit.count, `${P.limits.length}${bound ? ` · ${bound} binding` : ''}`);
      const nr = P.orders.filter((o) => !!o.route).length;
      setText(gOrder.count, nr ? `${P.orders.length} · ${plural(nr, 'route')}` : String(P.orders.length));
      setText(gProj.count, String(np));
      show(empty, P.levies.length + P.limits.length + P.orders.length + np + nl === 0);
    },
  };
}

