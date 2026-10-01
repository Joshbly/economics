// ============================================================================
// Levers panel — "In force": everything the Treasury currently has running.
//   Levies  : label, plain description, today / this month / last month
//             (+ collected, − paid), on/off, inline rate edit, remove
//   Limits  : description, days it bound this month, on/off, remove
//   Orders  : description, filled today / in all, value, on/off, inline price
//             edit, cancel
//   Carry   : carry rules between the Treasury's stores: held at the origin,
//             on the road, carried today / in all, freight; on/off, inline
//             amount edit, full wagons / right away, remove
//   Lines   : Treasury freight lines (./lines.ts): wagons out, carried, accounts,
//             pause, close
//   Projects: Treasury construction with progress
// Rows are keyed by id and updated in place (4×/s safe).
// ============================================================================
import { MARKET_DAY, PLAYER_MAX_MONEY, PLAYER_MAX_PCT, PLAYER_MAX_PRICE, PLAYER_MAX_UNIT_RATE } from '../../../sim/config';
import { GOODS } from '../../../sim/goods';
import { isAimed } from '../../../sim/policy/levies';
import { aimedRatesText, describeLevy, describeLimit, describeOrder } from '../../../sim/policy/player';
import { carryDest, carryFrom, carryHoldDays, carryOnRoad, carrySources, describeCarry, shortTargets } from '../../../sim/policy/carry';
import { CARRY_FULL_SHARE, WAGON_CAPACITY } from '../../../sim/config';
import type { CarryRule, Levy, Limit, PlayerOrder, SimState } from '../../../sim/types';
import { h, setText, setTone, show, toggleClass } from '../../dom';
import { fmtDay, fmtPct, fmtPrice, plural } from '../../format';
import { marketOf } from '../../../sim/market/markets';
import { icon, numberInput, toggle, type NumberInput } from '../../widgets';
import { fin, flowTone, fmtMS, fmtQ, keyedList, polishRule, run, safe, signedMoney, tersely, TONES, unitsOf } from './common';
import { baseDef, saleWhoOf, saleWhoWords } from './levyDefs';
import { projectList, treasuryProjects } from './projects';
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
    case 'land':
      return `Land held unbuilt${where}`;
  }
  return l.label;
}

/** Short title for an order row (the price sits in its own pill). */
function orderTitle(s: SimState, o: PlayerOrder): string {
  const m = o.market;
  if (m.kind === 'labor') return `Workers · ${s.towns[m.town]?.name ?? ''}`;
  if (m.kind === 'good') return `${GOODS[m.good]?.name ?? 'Goods'} · ${s.towns[m.town]?.name ?? ''}`;
  if (m.kind === 'iou') return 'IOUs';
  if (m.kind === 'company') return `Shares · ${s.firms[m.firm]?.name ?? 'a company'}`;
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
  /** The rule aims at a price: the pill shows (and edits) the price, not the rate. */
  mode: { aimed: boolean };
}

function levyRow(l: Levy): LevyRow {
  const id = l.id;
  const sw = toggle({ value: l.enabled, title: 'Switch this rule on or off', onChange: (v) => run({ type: 'updateLevy', id, patch: { enabled: v } }, null) });
  const title = h('div', { class: 'lv-if-t' });
  const desc = h('div', { class: 'lv-if-d' });
  const today = stat('Today');
  const month = stat('This month');
  const lastM = stat('Last month');
  const mode = { aimed: isAimed(l) };
  const rate = inlineEdit('Change the rate', (v) => run({ type: 'updateLevy', id, patch: mode.aimed ? { aim: v } : { rate: v } }, null));
  const dir = h('span', { class: 'lv-dir' });
  const rm = removeBtn('Remove this rule', () => run({ type: 'removeLevy', id }, null));
  const el = h(
    'div',
    { class: 'lv-if' },
    h('div', { class: 'lv-if-sw' }, sw.el),
    h('div', { class: 'lv-if-main' }, h('div', { class: 'lv-if-head' }, dir, title, h('span', { class: 'spacer' }), rate.el), desc, h('div', { class: 'lv-if-stats' }, today.el, month.el, lastM.el)),
    h('div', { class: 'lv-if-act' }, rm),
  );
  return { el, sw, title, desc, today, month, lastM, rate, dir, mode };
}

function paintLevy(s: SimState, v: LevyRow, l: Levy): void {
  v.sw.set(l.enabled);
  toggleClass(v.el, 'off', !l.enabled);
  setText(v.dir, l.dir === 1 ? 'Take' : 'Pay');
  setTone(v.dir, TONES, l.dir === 1 ? 'good' : 'bad');
  setText(v.title, levyTitle(s, l));
  v.mode.aimed = isAimed(l);
  const words = tersely(safe(() => describeLevy(s, l), l.label));
  setText(v.desc, v.mode.aimed ? `${words} Today: ${safe(() => aimedRatesText(s, l), '')}.` : words);
  const put = (x: ReturnType<typeof stat>, n: number) => {
    const v = fin(n);
    setText(x.v, Math.abs(v) >= 1000 ? (v > 0 ? '+' : '−') + fmtMS(Math.abs(v)) : signedMoney(v));
    x.v.title = signedMoney(v);
    setTone(x.v, TONES, flowTone(fin(n)));
  };
  put(v.today, l.today);
  put(v.month, l.month);
  put(v.lastM, l.lastMonth);
  if (v.mode.aimed) v.rate.refresh(`aim ${fmtPrice(l.aim ?? 0)}`, l.aim ?? 0, false, PLAYER_MAX_PRICE);
  else v.rate.refresh(levyRate(l), l.rate, l.unit === 'pct', l.unit === 'pct' ? PLAYER_MAX_PCT : PLAYER_MAX_UNIT_RATE);
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

/** A limit on daily moves in one market: the range the auction allowed today ("today ¤2.35–¤2.45"), else ''. */
function moveBand(s: SimState, l: Limit): string {
  if (l.kind !== 'priceMove' || !l.enabled) return '';
  const c = marketOf(s, l.town, l.good).curve; // one market: a good in a town, or the IOU / gold market
  if (!c || !(c.ceiling > 0)) return '';
  return c.floor > 0 ? `today ${fmtPrice(c.floor)}–${fmtPrice(c.ceiling)} · ` : `today up to ${fmtPrice(c.ceiling)} · `;
}

function paintLimit(s: SimState, v: LimitRow, l: Limit): void {
  v.sw.set(l.enabled);
  toggleClass(v.el, 'off', !l.enabled);
  setText(v.desc, polishRule(safe(() => describeLimit(s, l), l.label)));
  const b = fin(l.binding);
  setText(v.bind, b > 0 ? `Bound ${plural(b, 'day')} this month` : 'Not binding this month');
  setTone(v.bind, TONES, b > 0 ? 'warn' : null);
  setText(v.meta, `${safe(() => moveBand(s, l), '')}since ${fmtDay(l.created)}`);
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
}

function orderRow(o: PlayerOrder): OrderRow {
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
  return { el, sw, title, desc, today, all, value, price, side };
}

/** An order's price limit in a few words: '≤ ¤4.20', 'market +10%', 'any price'. */
function limitText(o: PlayerOrder): string {
  const mode = o.priceMode ?? 'fixed';
  if (mode === 'any') return 'any price';
  if (o.market.kind === 'company') return `${o.side === 'buy' ? '≤ ' : '≥ '}${fmtPrice(o.price)} for the firm`;
  if (mode === 'fixed' && o.side === 'sell' && o.market.kind === 'good' && !(o.price > 0)) return 'free — handed out';
  if (mode === 'follow') {
    const b = Math.round(fin(o.band) * 100);
    if (o.pace !== 'patient') return `market ${o.side === 'buy' ? '+' : '−'}${b}%`;
    // where it opens next (after the close: tomorrow's opening) and how high it went today
    const pct = (x: number) => {
      const v = (o.side === 'buy' ? x : -x) * 100;
      return Math.abs(v) < 0.05 ? 'at market' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
    };
    const went = o.reached !== undefined && Math.abs(o.reached - fin(o.offset)) > 1e-4 ? ` (today ${pct(o.reached)})` : '';
    return `market ${o.side === 'buy' ? '≤ +' : '≥ −'}${b}% · opens ${pct(fin(o.offset))}${went}`;
  }
  return (o.side === 'buy' ? '≤ ' : '≥ ') + fmtPrice(o.price);
}

function paintOrder(s: SimState, v: OrderRow, o: PlayerOrder): void {
  v.sw.set(o.enabled);
  toggleClass(v.el, 'off', !o.enabled);
  const labor = o.market.kind === 'labor';
  setText(v.side, labor ? 'Hire' : o.market.kind === 'iou' ? (o.side === 'buy' ? 'Retire' : 'Issue') : o.side === 'buy' ? 'Buy' : 'Sell');
  setTone(v.side, TONES, o.side === 'buy' ? 'gold' : null);
  setText(v.title, orderTitle(s, o));
  const netted = fin(o.nettedToday);
  const words = tersely(safe(() => describeOrder(s, o), o.label));
  setText(v.desc, netted > 1e-6 ? `${words} Today ${fmtQ(netted)} cancelled against your own ${o.side === 'buy' ? 'offer' : 'purchase'} in this market (the Treasury never trades with itself).` : words);
  const shares = o.market.kind === 'company';
  const pc = (x: number) => `${Math.round(100 * fin(x))}%`;
  setText(v.today.v, shares ? (o.enabled ? `meets day ${MARKET_DAY}` : 'done') : `${fmtQ(fin(o.filledToday))} of ${fmtQ(o.qty)}${o.market.kind === 'gold' ? ' oz' : ''}`);
  setText(v.all.v, shares ? `${pc(o.filled)} / ${pc(o.total)}` : fmtQ(fin(o.filled)) + (o.total >= 0 ? ` / ${fmtQ(o.total)}` : ''));
  // value: positive = spent from the Purse
  const val = -fin(o.value);
  setText(v.value.v, Math.abs(val) >= 1000 ? (val > 0 ? '+' : '−') + fmtMS(Math.abs(val)) : signedMoney(val));
  v.value.v.title = signedMoney(val);
  setTone(v.value.v, TONES, flowTone(val));
  v.price.refresh(labor ? fmtPrice(o.price) + '/day' : limitText(o), o.price, false, shares ? PLAYER_MAX_MONEY : PLAYER_MAX_PRICE);
}

interface CarryRow {
  el: HTMLElement;
  sw: ReturnType<typeof toggle>;
  title: HTMLElement;
  desc: HTMLElement;
  held: ReturnType<typeof stat>;
  road: ReturnType<typeof stat>;
  today: ReturnType<typeof stat>;
  qty: InlineEdit;
  full: HTMLButtonElement;
  now: HTMLButtonElement;
}

function carryRow(c: CarryRule): CarryRow {
  const id = c.id;
  const sw = toggle({ value: c.enabled, title: 'Pause or resume this carry rule', onChange: (v) => run({ type: 'updateCarry', id, patch: { enabled: v } }, null) });
  const title = h('div', { class: 'lv-if-t' });
  const desc = h('div', { class: 'lv-if-d' });
  const held = stat('Held there');
  const road = stat('On the road');
  const today = stat('Carried today');
  const qty = inlineEdit('Change how much it carries a day (0 or empty: everything held)', (v) => run({ type: 'updateCarry', id, patch: { qty: v > 0 ? v : -1 } }, null));
  const wagons = (label: string, value: CarryRule['wagons'], tip: string) =>
    h('button', { class: 'chip lv-chip', type: 'button', title: tip, onClick: () => run({ type: 'updateCarry', id, patch: { wagons: value } }, null) }, label);
  const full = wagons('full wagons', 'full', 'Wait for a nearly full wagon (or as long as the goods keep): the least freight per unit');
  const now = wagons('right away', 'now', 'Send what is held after every market session: quicker, dearer per unit when loads are small');
  const rm = removeBtn('Remove this carry rule (goods on the road still arrive)', () => run({ type: 'removeCarry', id }, null));
  const el = h(
    'div',
    { class: 'lv-if' },
    h('div', { class: 'lv-if-sw' }, sw.el),
    h(
      'div',
      { class: 'lv-if-main' },
      h('div', { class: 'lv-if-head' }, h('span', { class: 'lv-dir' }, 'Carry'), title, h('span', { class: 'spacer' }), qty.el),
      desc,
      h('div', { class: 'lv-if-stats' }, held.el, road.el, today.el),
      h('div', { class: 'lv-if-opts' }, h('span', { class: 'lv-if-opts-k' }, 'Wagons:'), full, now),
    ),
    h('div', { class: 'lv-if-act' }, rm),
  );
  return { el, sw, title, desc, held, road, today, qty, full, now };
}

function paintCarry(s: SimState, v: CarryRow, c: CarryRule): void {
  v.sw.set(c.enabled);
  toggleClass(v.el, 'off', !c.enabled);
  const A = carryFrom(s, c);
  const B = carryDest(s, c);
  setText(v.title, `${GOODS[c.good]?.name ?? 'Goods'} · ${A} → ${B}`);
  const have = carrySources(s, c).reduce((x, t) => x + fin(s.treasury.goods[t]?.[c.good]), 0);
  let state = '';
  if (c.enabled && c.wagons === 'full' && c.heldSince >= 0 && have > 0.005) {
    const fill = Math.min(100, Math.round((100 * Math.min(have, c.qty >= 0 ? fin(c.allow) : have)) / WAGON_CAPACITY));
    state = ` Filling a wagon: ${fill}% (it leaves at ${Math.round(CARRY_FULL_SHARE * 100)}%, or after ${plural(carryHoldDays(c.good), 'day')} of waiting — ${plural(s.day - c.heldSince, 'day')} so far).`;
  } else if (c.enabled && !(have > 0.005)) state = ` Nothing held in ${A} now: it carries what comes in.`;
  if (c.to < 0) {
    // the towns it serves (where the Treasury sells the good), neediest first
    const t = safe(() => shortTargets(s, c), []);
    state += t.length
      ? ` Serves ${t.map((x) => `${s.towns[x.town]?.name ?? ''} (${x.need > 0.5 ? `needs ${fmtQ(x.need)}` : 'supplied'})`).join(', ')}.`
      : ` The Treasury sells ${(GOODS[c.good]?.name ?? 'it').toLowerCase()} in no other town yet: a sell order in a town adds it.`;
  }
  setText(v.desc, tersely(safe(() => describeCarry(s, c), c.label)) + state);
  setText(v.held.v, fmtQ(have));
  setText(v.road.v, fmtQ(safe(() => carryOnRoad(s, c.id), 0)));
  setText(v.today.v, `${fmtQ(fin(c.carriedToday))} · ${fmtQ(fin(c.carried))} in all`);
  v.today.v.title = `Freight paid: ${fmtMS(fin(c.freightToday))} today, ${fmtMS(fin(c.freight))} in all`;
  v.qty.refresh(c.qty >= 0 ? `${fmtQ(c.qty)} ${unitsOf(c.good)}/day` : 'everything', c.qty >= 0 ? c.qty : 0, false, 1e6);
  toggleClass(v.full, 'on', c.wagons === 'full');
  toggleClass(v.now, 'on', c.wagons === 'now');
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
  const carryList = h('div', { class: 'lv-if-list' });
  const projects = projectList({ compact: true });
  const lines = lineList({ compact: true });
  const gLevy = group('Levies', levyList);
  const gLimit = group('Limits', limitList);
  const gOrder = group('Treasury orders', orderList);
  const gCarry = group('Carry rules', carryList);
  const gProj = group('Projects', projects.el);
  const gLine = group('Freight lines', lines.el);
  const empty = h(
    'div',
    { class: 'lv-empty' },
    h('div', { class: 'lv-empty-t' }, 'Nothing is in force.'),
    h('div', null, 'The realm is running on its own. Pull any lever above — alone or in combination — and watch what the markets, the Ledger and the people do.'),
  );
  const el = h('div', { class: 'lv-inforce' }, empty, gLevy.el, gLimit.el, gOrder.el, gCarry.el, gLine.el, gProj.el);

  const recLevy = keyedList<Levy, LevyRow>(levyList, (l) => l.id, (l) => levyRow(l), (v, l) => state && paintLevy(state, v, l));
  const recLimit = keyedList<Limit, LimitRow>(limitList, (l) => l.id, (l) => limitRow(l), (v, l) => state && paintLimit(state, v, l));
  const recOrder = keyedList<PlayerOrder, OrderRow>(orderList, (o) => o.id, (o) => orderRow(o), (v, o) => state && paintOrder(state, v, o));
  const recCarry = keyedList<CarryRule, CarryRow>(carryList, (c) => c.id, (c) => carryRow(c), (v, c) => state && paintCarry(state, v, c));

  return {
    el,
    count(s) {
      return s.policy.levies.length + s.policy.limits.length + s.policy.orders.length + (s.policy.carries?.length ?? 0) + freightLines(s).length + treasuryProjects(s).filter((p) => p.status !== 'done').length;
    },
    update(s) {
      state = s;
      const P = s.policy;
      recLevy(P.levies);
      recLimit(P.limits);
      recOrder(P.orders);
      const carries = P.carries ?? [];
      recCarry(carries);
      const np = projects.set(s);
      const nl = lines.update(s);
      show(gLine.el, nl > 0);
      setText(gLine.count, nl ? String(nl) : '');
      show(gLevy.el, P.levies.length > 0);
      show(gLimit.el, P.limits.length > 0);
      show(gOrder.el, P.orders.length > 0);
      show(gCarry.el, carries.length > 0);
      setText(gCarry.count, carries.length ? String(carries.length) : '');
      show(gProj.el, np > 0);
      const lNet = P.levies.reduce((a, l) => a + fin(l.today), 0);
      setText(gLevy.count, `${P.levies.length} · ${signedMoney(lNet)} today`);
      setTone(gLevy.count, TONES, flowTone(lNet));
      const bound = P.limits.filter((l) => l.enabled && l.binding > 0).length;
      setText(gLimit.count, `${P.limits.length}${bound ? ` · ${bound} binding` : ''}`);
      setText(gOrder.count, String(P.orders.length));
      setText(gProj.count, String(np));
      show(empty, P.levies.length + P.limits.length + P.orders.length + carries.length + np + nl === 0);
    },
  };
}

