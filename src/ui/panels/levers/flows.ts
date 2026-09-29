// ============================================================================
// Levers panel — "Treasury stores & wagons": where the Treasury's goods are
// and where they are going. Used in Levers → Trade and in Ledger → Treasury.
//
//   summary   in store (value) · wagons on the road · routes running · routes' result
//   Stores    holdings by good × town (only towns where something is held)
//   On the road  every Treasury shipment: good, qty, from → to, ETA (from
//             s.day + ui.dayFrac vs shipment.arrive), owning route, Show on map
//   Supply routes  one pipeline per route order:
//             bought today → on the road → waiting at B → sold today,
//             lifetime shipped / sold / spent / freight / earned / result,
//             pause / resume, withdraw
//   Freight lines  one card per Treasury freight line (./lines.ts): wagons out,
//             carried, fare, and its accounts (fares in, drivers, fuel & wear)
//
// Everything is keyed and updated in place, so update() is cheap at 4×/s.
// ============================================================================
import { GOODS, N_GOODS } from '../../../sim/goods';
import { routeBetweenTowns } from '../../../sim/world/paths';
import { describeOrder } from '../../../sim/policy/player';
import { heldAtOrigin, routeFloor, routeHoldDays } from '../../../sim/policy/routes';
import { ROUTE_FULL_SHARE, WAGON_CAPACITY } from '../../../sim/config';
import { STATE, type PlayerOrder, type Shipment, type SimState } from '../../../sim/types';
import { h, setText, setTone, show, toggleClass } from '../../dom';
import { fmtNum, fmtPct, fmtPrice, plural } from '../../format';
import { centerMap, ui } from '../../uiState';
import { attachTip, icon, swatch, tipNote, tipTitle, toggle } from '../../widgets';
import { bar, fin, flowTone, fmtM, fmtMS, fmtQ, goodName, keyedList, run, safe, signedMoney, townName, TONES, unitsOf } from './common';
import { describeRoute, sellText } from './route';
import { lineList } from './lines';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Treasury route orders (goods buy orders carrying their purchases elsewhere). */
export function routeOrders(s: SimState): PlayerOrder[] {
  return s.policy.orders.filter((o) => !!o.route && o.market.kind === 'good');
}

/** Treasury shipments on the road, soonest arrival first. */
export function treasuryShipments(s: SimState): Shipment[] {
  return s.shipments.filter((x) => x && x.owner === STATE).sort((a, b) => a.arrive - b.arrive || a.id - b.id);
}

/** Current time in fractional days (the map's clock). */
function now(s: SimState): number {
  return s.day + fin(ui?.dayFrac, 0);
}

/** 0..1 progress of a shipment along its road. */
function progress(s: SimState, sh: Shipment): number {
  const span = sh.arrive - sh.depart;
  if (!(span > 1e-6)) return 1;
  const f = (now(s) - sh.depart) / span;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** Approximate tile position of a wagon (along its route's tiles; else between the towns). */
export function wagonXY(s: SimState, sh: Shipment): { x: number; y: number } {
  const f = progress(s, sh);
  const r = safe(() => routeBetweenTowns(s, sh.from, sh.to), null);
  if (r && r.tiles && r.tiles.length >= 2) {
    const t = r.tiles[Math.max(0, Math.min(r.tiles.length - 1, Math.round(f * (r.tiles.length - 1))))];
    return { x: (t % s.map.w) + 0.5, y: Math.floor(t / s.map.w) + 0.5 };
  }
  const A = s.towns[sh.from];
  const B = s.towns[sh.to];
  if (!A || !B) return { x: A?.x ?? 0, y: A?.y ?? 0 };
  return { x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f };
}

/** "in 1.4 days" / "unloading". */
function etaText(s: SimState, sh: Shipment): string {
  const left = sh.arrive - now(s);
  if (left <= 0.05) return 'arriving';
  if (left < 1) return `in ${Math.max(1, Math.round(left * 24))} h`;
  return `in ${fmtNum(left, left < 10 ? 1 : 0)} days`;
}

/** Has a route's buy side ended (paused, past its end day, one day only, or its overall cap reached)? */
export function buyingOver(s: SimState, o: PlayerOrder): boolean {
  return (o.until >= 0 && o.until < s.day) || (o.total >= 0 && fin(o.filled) >= o.total - 1e-9) || (o.once && o.created < s.day);
}

/** A route order in words (the sim's sentence, falling back to ours). */
export function routeWords(s: SimState, o: PlayerOrder): string {
  return safe(() => describeOrder(s, o), '') || describeRoute(s, o);
}

/** Lifetime result of a route: receipts at the destination less purchases and freight. */
export function routeResult(o: PlayerOrder): { spent: number; freight: number; earned: number; result: number } {
  const r = o.route;
  const spent = fin(o.value);
  const freight = fin(r?.freightPaid);
  const earned = fin(r?.revenue);
  return { spent, freight, earned, result: earned - spent - freight };
}

function statEl(label: string): { el: HTMLElement; v: HTMLElement } {
  const v = h('span', { class: 'lv-stat-v' });
  return { el: h('span', { class: 'lv-stat' }, h('span', { class: 'lv-stat-l' }, label), v), v };
}

/** Tight money for small cells: "¤1.7k", "¤211", "¤9.50" (signed when asked). */
function tight(v: number): string {
  const a = Math.abs(v);
  return a >= 1000 ? fmtMS(a) : a >= 100 ? '¤' + Math.round(a) : fmtM(a);
}

function money(el: HTMLElement, x: number, signed = false): void {
  const v = fin(x);
  const t = signed ? (Math.abs(v) < 0.005 ? fmtM(0) : (v > 0 ? '+' : '−') + tight(v)) : tight(v);
  setText(el, t);
  el.title = signed ? signedMoney(v) : fmtM(v);
}

// ---------------------------------------------------------------------------
// The pipeline strip (also used by In force)
// ---------------------------------------------------------------------------
export interface Pipeline {
  el: HTMLElement;
  set(s: SimState, o: PlayerOrder): void;
}

export function pipeline(opts: { compact?: boolean } = {}): Pipeline {
  const cell = (label: string) => {
    const v = h('span', { class: 'lv-pipe-v' });
    const sub = h('span', { class: 'lv-pipe-s' });
    const lab = h('span', { class: 'lv-pipe-l' }, label);
    return { el: h('div', { class: 'lv-pipe-c' }, lab, v, opts.compact ? null : sub), v, sub, lab };
  };
  const bought = cell('Bought');
  const road = cell('On road');
  const wait = cell('Waiting');
  const sold = cell('Sold');
  const el = h('div', { class: 'lv-pipe' + (opts.compact ? ' compact' : '') }, bought.el, road.el, wait.el, sold.el);
  return {
    el,
    set(s, o) {
      const r = o.route;
      const g = o.market.kind === 'good' ? o.market.good : 0;
      setText(bought.v, fmtQ(fin(o.filledToday)));
      const held = safe(() => heldAtOrigin(s, o), 0);
      const daily = r?.dispatch === 'daily';
      const fillPct = Math.round((100 * held) / WAGON_CAPACITY);
      const waited = r && r.heldSince !== undefined && r.heldSince >= 0 ? s.day - r.heldSince : 0;
      const hold = safe(() => routeHoldDays(g), 1);
      setText(bought.sub, held > 0.005 ? (daily ? `${fmtQ(held)} held` : `loading ${fillPct}%`) : buyingOver(s, o) ? 'buying over' : 'today');
      bought.el.title =
        `Bought today in ${townName(s, o.market.kind === 'good' ? o.market.town : -1)} (at most ${fmtQ(o.qty)} a day)` +
        (held > 0.005
          ? daily
            ? `; ${fmtQ(held)} held there, leaving with the next wagon`
            : `; ${fmtQ(held)} held there, filling a wagon (${fillPct}% of ${WAGON_CAPACITY}): it leaves when ${fmtPct(ROUTE_FULL_SHARE)} full or after ${plural(hold, 'day')} of waiting (${plural(waited, 'day')} so far)`
          : '');
      setText(road.v, fmtQ(fin(r?.inTransit)));
      let next = Infinity;
      let nWag = 0;
      for (const sh of s.shipments) {
        if (!sh || sh.owner !== STATE || sh.order !== o.id) continue;
        nWag += Math.max(1, Math.round(fin(sh.wagons, 1)));
        if (sh.arrive < next) next = sh.arrive;
      }
      setText(road.sub, nWag ? (next - now(s) <= 0.05 ? 'arriving' : `next ${etaShort(next - now(s))}`) : 'none out');
      road.el.title = nWag ? `${plural(nWag, 'wagon')} on the road to ${r ? townName(s, r.to) : ''}` : 'No wagons on the road';
      setText(wait.v, fmtQ(fin(r?.waiting)));
      setText(wait.sub, fin(r?.waiting) > 0.005 && fin(r?.landed) > 0 ? `cost ${fmtPrice(r!.landed)}` : `in ${r ? townName(s, r.to) : '—'}`);
      wait.el.title = `Arrived in ${r ? townName(s, r.to) : ''} and offered there, not yet sold${fin(r?.landed) > 0 ? ` · landed cost ${fmtPrice(r!.landed)} a unit (bought + freight)` : ''}`;
      setText(sold.v, fmtQ(fin(r?.soldToday)));
      const mk = r ? s.markets[r.to * N_GOODS + g] : undefined;
      const p = fin(mk?.price);
      setText(sold.sub, 'today');
      sold.el.title = `Sold today in ${r ? townName(s, r.to) : ''}${p > 0 ? `; the price there is ${fmtPrice(p)}` : ''} · ${unitsOf(g)}`;
      toggleClass(bought.el, 'on', fin(o.filledToday) > 0.005);
      toggleClass(road.el, 'on', fin(r?.inTransit) > 0.005);
      toggleClass(wait.el, 'on', fin(r?.waiting) > 0.005);
      toggleClass(sold.el, 'on', fin(r?.soldToday) > 0.005);
    },
  };
}

function etaShort(left: number): string {
  if (!Number.isFinite(left)) return '';
  if (left <= 0.05) return 'now';
  if (left < 1) return `${Math.max(1, Math.round(left * 24))} h`;
  return `${fmtNum(left, left < 10 ? 1 : 0)} d`;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------
interface ShipRow {
  el: HTMLElement;
  sw: HTMLElement;
  title: HTMLElement;
  sub: HTMLElement;
  tag: HTMLElement;
  eta: HTMLElement;
  bar: ReturnType<typeof bar>;
  good: number;
}

function shipRow(sh: Shipment, state: () => SimState | null): ShipRow {
  const id = sh.id;
  const sw = swatch(GOODS[sh.good]?.color ?? '#999', 'box');
  const title = h('span', { class: 'lv-ship-t' });
  const tag = h('span', { class: 'lv-ship-tag' });
  const sub = h('span', { class: 'lv-ship-s' });
  const eta = h('span', { class: 'lv-ship-eta' });
  const b = bar('lv-ship-bar');
  const btn = h('button', { class: 'icon-btn lv-ibtn', type: 'button', title: 'Show this wagon on the map', 'aria-label': 'Show on map' }, icon('target', 15));
  btn.addEventListener('click', () => {
    const s = state();
    const x = s?.shipments.find((q) => q && q.id === id);
    if (!s || !x) return;
    const p = wagonXY(s, x);
    centerMap(p.x, p.y);
  });
  const el = h(
    'div',
    { class: 'lv-ship' },
    sw,
    h('div', { class: 'lv-ship-main' }, title, h('div', { class: 'lv-ship-head' }, tag, sub)),
    h('div', { class: 'lv-ship-when' }, eta, b.el),
    btn,
  );
  attachTip(tag, () => {
    const s = state();
    const x = s?.shipments.find((q) => q && q.id === id);
    const o = s && x && x.order >= 0 ? s.policy.orders.find((q) => q.id === x.order) : undefined;
    if (!s || !x) return null;
    if (!o) return [tipTitle('Moved by hand'), tipNote('Sent with Move goods. On arrival it joins the Treasury’s stores there.')];
    return [tipTitle('Supply route'), tipNote(routeWords(s, o))];
  });
  return { el, sw, title, sub, tag, eta, bar: b, good: sh.good };
}

function paintShip(s: SimState, v: ShipRow, sh: Shipment): void {
  if (v.good !== sh.good) {
    v.good = sh.good;
    v.sw.style.background = GOODS[sh.good]?.color ?? '#999';
  }
  setText(v.title, `${fmtQ(sh.qty)} ${unitsOf(sh.good)} of ${goodName(sh.good).toLowerCase()}`);
  const nw = Math.max(1, Math.round(fin(sh.wagons, 1)));
  setText(v.sub, `${townName(s, sh.from)} → ${townName(s, sh.to)}${nw > 1 ? ` · ${nw} wagons` : ''}`);
  const routed = sh.order >= 0 && s.policy.orders.some((o) => o.id === sh.order);
  setText(v.tag, sh.order >= 0 ? (routed ? 'route' : 'route ended') : 'moved');
  setTone(v.tag, TONES, sh.order >= 0 ? 'gold' : null);
  setText(v.eta, etaText(s, sh));
  v.bar.set(progress(s, sh));
}

interface RouteRow {
  el: HTMLElement;
  sw: ReturnType<typeof toggle>;
  goodSw: HTMLElement;
  good: HTMLElement;
  path: HTMLElement;
  status: HTMLElement;
  terms: HTMLElement;
  pipe: Pipeline;
  spent: ReturnType<typeof statEl>;
  freight: ReturnType<typeof statEl>;
  earned: ReturnType<typeof statEl>;
  result: ReturnType<typeof statEl>;
}

function routeRow(o: PlayerOrder, state: () => SimState | null): RouteRow {
  const id = o.id;
  const sw = toggle({ value: o.enabled, title: 'Pause or resume buying for this route', onChange: (v) => run({ type: 'updateOrder', id, patch: { enabled: v } }, null) });
  const goodSw = swatch('#999', 'box');
  const good = h('span', { class: 'lv-rt-good' });
  const path = h('span', { class: 'lv-rt-path' });
  const status = h('span', { class: 'chip lv-rt-status' });
  const terms = h('div', { class: 'lv-rt-terms' });
  const pipe = pipeline();
  const spent = statEl('Purchases');
  const freight = statEl('Freight');
  const earned = statEl('Sales');
  const result = statEl('Result');
  attachTip(result.el, () => {
    const s = state();
    const x = s?.policy.orders.find((q) => q.id === id);
    if (!s || !x) return null;
    const rr = routeResult(x);
    return [
      tipTitle('Result so far', 'sales − purchases − freight'),
      tipNote(`Sales ${fmtM(rr.earned)} − purchases ${fmtM(rr.spent)} − freight ${fmtM(rr.freight)}. Goods still on the road or waiting are not counted until they sell.`),
    ];
  });
  const showBtn = h('button', { class: 'icon-btn lv-ibtn', type: 'button', title: 'Show the route on the map', 'aria-label': 'Show on map' }, icon('target', 15));
  showBtn.addEventListener('click', () => {
    const s = state();
    const x = s?.policy.orders.find((q) => q.id === id);
    if (!s || !x || !x.route || x.market.kind !== 'good') return;
    const lead = s.shipments.filter((q) => q && q.owner === STATE && q.order === id).sort((a, b) => a.arrive - b.arrive)[0];
    if (lead) {
      const p = wagonXY(s, lead);
      centerMap(p.x, p.y);
      return;
    }
    const A = s.towns[x.market.town];
    const B = s.towns[x.route.to];
    if (A && B) centerMap((A.x + B.x) / 2, (A.y + B.y) / 2);
  });
  const rm = h('button', { class: 'icon-btn lv-ibtn', type: 'button', title: 'Withdraw this route: it stops buying, and what it bought stays in the Treasury’s stores', 'aria-label': 'Withdraw route', onClick: () => run({ type: 'cancelOrder', id }, null) }, icon('trash', 15));
  // Change how the goods are offered at the destination, in place (goods on the road and
  // waiting keep their landed cost).
  const offerChip = (label: string, title: string, route: { sell: 'fixed' | 'cost' | 'market'; sellPrice?: number; sellMargin?: number }) =>
    h('button', { class: 'chip lv-chip', type: 'button', title, onClick: () => run({ type: 'updateOrder', id, patch: { route } }, null) }, label);
  const offer = h(
    'div',
    { class: 'lv-rt-offer' },
    h('span', { class: 'lv-rt-offer-k' }, 'Offer there:'),
    offerChip('at cost', 'Offer the goods at what they cost to buy and carry', { sell: 'cost', sellMargin: 0 }),
    offerChip('cost + 10%', 'Offer them at landed cost plus 10%', { sell: 'cost', sellMargin: 0.1 }),
    offerChip('any price', 'Offer them for whatever the destination auction pays', { sell: 'market' }),
    h('span', { class: 'lv-rt-offer-k' }, 'Wagons:'),
    h('button', { class: 'chip lv-chip', type: 'button', title: 'Wait for a nearly full wagon (or as long as the goods keep): low freight per unit', onClick: () => run({ type: 'updateOrder', id, patch: { route: { dispatch: 'full' } } }, null) }, 'full'),
    h('button', { class: 'chip lv-chip', type: 'button', title: 'Rush: send what each market session bought as soon as it closes — and what is held now, after the next one', onClick: () => run({ type: 'updateOrder', id, patch: { route: { dispatch: 'daily' } } }, null) }, 'right away'),
  );
  const el = h(
    'div',
    { class: 'lv-rt' },
    h('div', { class: 'lv-rt-head' }, h('span', { class: 'lv-if-sw' }, sw.el), h('span', { class: 'lv-goodtag' }, goodSw, good), path, h('span', { class: 'spacer' }), showBtn, rm),
    h('div', { class: 'lv-rt-sub' }, status, terms),
    pipe.el,
    h('div', { class: 'lv-rt-money' }, spent.el, freight.el, earned.el, result.el),
    offer,
  );
  return { el, sw, goodSw, good, path, status, terms, pipe, spent, freight, earned, result };
}

function paintRoute(s: SimState, v: RouteRow, o: PlayerOrder): void {
  const r = o.route;
  if (!r || o.market.kind !== 'good') return;
  const g = o.market.good;
  v.sw.set(o.enabled);
  toggleClass(v.el, 'off', !o.enabled);
  v.goodSw.style.background = GOODS[g]?.color ?? '#999';
  setText(v.good, goodName(g));
  setText(v.path, `${townName(s, o.market.town)} → ${townName(s, r.to)}`);
  const over = buyingOver(s, o);
  const pipeLeft = fin(r.inTransit) + fin(r.waiting) + safe(() => heldAtOrigin(s, o), 0) > 0.005;
  const floor = safe(() => routeFloor(s, o), 0);
  const refB = fin(s.markets[r.to * N_GOODS + g]?.price);
  const stuck = fin(r.waiting) > 0.5 && fin(r.soldToday) < 1e-6 && refB > 0 && floor > refB * 1.001;
  v.status.title = stuck
    ? `Its lowest ask (${fmtPrice(floor)}) is above ${townName(s, r.to)}’s price (${fmtPrice(refB)}), so its goods wait unsold. Lower its offer below (at cost, or any price) — goods waiting keep their landed cost.`
    : '';
  const [st, tone] = stuck
    ? ['Ask above price', 'warn']
    : over
      ? pipeLeft
        ? ['Selling off', 'gold']
        : ['Finished', 'good']
      : !o.enabled
      ? ['Paused', 'warn']
      : !s.treasury.autoMint && !(fin(s.treasury.purse) > 0)
      ? ['Purse empty', 'bad']
      : fin(o.filledToday) > 0.005 || fin(r.soldToday) > 0.005 || pipeLeft
        ? ['Running', 'gold']
        : ['Waiting to buy', null];
  setText(v.status, st as string);
  setTone(v.status, TONES, tone as (typeof TONES)[number] | null);
  setText(v.terms, `≤ ${fmtPrice(o.price)} × ${fmtQ(o.qty)}/day · offer ${sellText(r, g)} · ${fmtQ(fin(r.shippedTotal))} shipped, ${fmtQ(fin(r.soldTotal))} sold${o.total >= 0 ? ` · ${fmtQ(o.filled)} of ${fmtQ(o.total)} bought` : ''}`);
  v.pipe.set(s, o);
  const rr = routeResult(o);
  money(v.spent.v, rr.spent);
  money(v.freight.v, rr.freight);
  money(v.earned.v, rr.earned);
  money(v.result.v, rr.result, true);
  setTone(v.result.v, TONES, flowTone(rr.result));
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------
export interface FlowsView {
  el: HTMLElement;
  update(s: SimState): void;
}

export function flowsView(opts: { place: 'levers' | 'ledger' }): FlowsView {
  let state: SimState | null = null;
  const S = () => state;

  // summary
  const kv = (label: string) => {
    const v = h('span', { class: 'lv-kv-v' });
    const sub = h('span', { class: 'lv-kv-s' });
    return { el: h('div', null, h('span', { class: 'lv-kv-l' }, label), v, sub), v, sub };
  };
  const kStore = kv('In store');
  const kRoad = kv('Wagons');
  const kRoutes = kv('Routes');
  const kResult = kv('Result');
  const summary = h('div', { class: 'lv-kv4 lv-flows-kv' }, kStore.el, kRoad.el, kRoutes.el, kResult.el);
  attachTip(kResult.el, () => [tipTitle('Routes’ result', 'in all'), tipNote('Across every supply route still listed: what their goods sold for at the destination, less what the Treasury paid for them and for freight. Goods still on the road or waiting are not counted until they sell.')]);

  // stores
  const holdTable = h('div', { class: 'lv-hold' });
  const holdEmpty = h('div', { class: 'lv-empty-sm' }, 'The Treasury holds no goods. Anything it buys is kept in the town where it was bought — unless a supply route carries it on.');
  let holdSig = '';
  const storeNote = h('span', { class: 'lv-grp-n' });

  // wagons
  const shipList = h('div', { class: 'lv-ships' });
  const shipEmpty = h('div', { class: 'lv-empty-sm' }, 'No Treasury wagons on the road.');
  const shipCount = h('span', { class: 'lv-grp-n' });
  const recShip = keyedList<Shipment, ShipRow>(shipList, (x) => x.id, (x) => shipRow(x, S), (v, x) => state && paintShip(state, v, x));

  // routes
  const routeList = h('div', { class: 'lv-rts' });
  const routeEmpty = h(
    'div',
    { class: 'lv-empty-sm' },
    opts.place === 'levers'
      ? 'No supply routes. Choose Route above to buy in one town, carry by wagon and offer in another.'
      : 'No supply routes. In Levers → Trade → Route, buy in one town, carry by wagon and offer in another.',
  );
  const routeCount = h('span', { class: 'lv-grp-n' });
  const recRoute = keyedList<PlayerOrder, RouteRow>(routeList, (o) => o.id, (o) => routeRow(o, S), (v, o) => state && paintRoute(state, v, o));

  const grp = (title: string, n: HTMLElement, ...body: HTMLElement[]) => h('div', { class: 'lv-grp' }, h('div', { class: 'lv-grp-t' }, title, n), ...body);
  const gRoutes = grp('Supply routes', routeCount, routeList, routeEmpty);
  const lines = lineList();
  const lineCount = h('span', { class: 'lv-grp-n' });
  const gLines = grp('Freight lines', lineCount, lines.el);
  const gShips = grp('On the road', shipCount, shipList, shipEmpty);
  const idle = h(
    'div',
    { class: 'lv-empty-sm' },
    opts.place === 'levers'
      ? 'No supply routes and no Treasury wagons on the road. Choose Route above to buy in one town, carry by wagon and offer in another — or move goods you hold below.'
      : 'No supply routes and no Treasury wagons on the road. In Levers → Trade, Route buys in one town, carries by wagon and offers in another.',
  );
  const el = h(
    'div',
    { class: 'lv-flows' + (opts.place === 'ledger' ? ' in-ledger' : '') },
    summary,
    idle,
    gLines,
    gRoutes,
    gShips,
    grp('Stores', storeNote, holdTable, holdEmpty),
  );

  function paintHoldings(s: SimState): number {
    const t = s.treasury;
    const nT = s.towns.length;
    let value = 0;
    const rows: number[] = [];
    let sig = s.towns.map((x) => x.name).join('|');
    const holdsIn = new Set<number>();
    // units a supply route is offering in each (town, good)
    const offered: Record<number, number> = {};
    for (const o of s.policy.orders) if (o.route && o.market.kind === 'good' && o.route.waiting > 0.005) offered[o.route.to * N_GOODS + o.market.good] = (offered[o.route.to * N_GOODS + o.market.good] || 0) + o.route.waiting;
    for (const k in offered) sig += `|o${k}:${offered[k].toFixed(1)}`;
    for (let g = 0; g < N_GOODS; g++) {
      let any = false;
      for (let k = 0; k < nT; k++) {
        const q = fin(t.goods[k]?.[g]);
        if (q > 0.005) {
          any = true;
          holdsIn.add(k);
          const m = s.markets[k * N_GOODS + g];
          value += q * fin(m?.price > 0 ? m.price : m?.ema);
        }
        sig += ',' + q.toFixed(2);
      }
      if (any) rows.push(g);
    }
    if (sig !== holdSig) {
      holdSig = sig;
      if (rows.length) {
        const cols = s.towns.filter((x) => holdsIn.has(x.id));
        const head = h('div', { class: 'lv-hold-r lv-hold-h' }, h('span', null, 'Good'), cols.map((x) => h('span', { title: x.name }, x.name)));
        const body = rows.map((g) =>
          h(
            'div',
            { class: 'lv-hold-r' },
            h('span', { class: 'lv-hold-g' }, swatch(GOODS[g].color, 'box'), GOODS[g].name),
            cols.map((x) => {
              const q = fin(t.goods[x.id]?.[g]);
              const off = Math.min(q, offered[x.id * N_GOODS + g] || 0);
              return h(
                'span',
                { class: q > 0.005 ? (off > 0.005 ? 'routed' : '') : 'faint', title: off > 0.005 ? `${fmtQ(q)} held in ${x.name}; ${fmtQ(off)} of them offered there by a supply route` : null },
                q > 0.005 ? fmtQ(q) : '·',
              );
            }),
          ),
        );
        holdTable.replaceChildren(head, ...body);
        holdTable.style.setProperty('--cols', String(cols.length));
      } else holdTable.replaceChildren();
    }
    show(holdTable, rows.length > 0);
    show(holdEmpty, rows.length === 0);
    setText(storeNote, Object.keys(offered).length ? '● offered by a route' : '');
    setText(kStore.sub, rows.length ? `in ${plural(holdsIn.size, 'town')}` : 'nothing held');
    kStore.sub.title = rows.length ? `${plural(rows.length, 'good')} in ${plural(holdsIn.size, 'town')}` : '';
    return value;
  }

  return {
    el,
    update(s) {
      state = s;
      const value = paintHoldings(s);
      setText(kStore.v, tight(value));
      kStore.v.title = `≈ ${fmtM(value)} at today’s prices`;

      const ships = treasuryShipments(s);
      recShip(ships);
      let wagons = 0;
      let units = 0;
      for (const x of ships) {
        wagons += Math.max(1, Math.round(fin(x.wagons, 1)));
        units += fin(x.qty);
      }
      setText(kRoad.v, wagons ? String(wagons) : 'None');
      setText(kRoad.sub, wagons ? `${fmtQ(units)} units` : 'on the road');
      setText(shipCount, ships.length ? String(ships.length) : '');
      show(shipList, ships.length > 0);
      show(shipEmpty, ships.length === 0);

      const routes = routeOrders(s);
      recRoute(routes);
      const running = routes.filter((o) => o.enabled).length;
      let res = 0;
      for (const o of routes) res += routeResult(o).result;
      setText(kRoutes.v, routes.length ? `${running} running` : 'None');
      setText(kRoutes.sub, routes.length > running ? `${routes.length - running} paused or done` : routes.length ? 'all buying' : 'none yet');
      setText(kResult.v, routes.length ? (Math.abs(res) >= 1000 ? (res > 0 ? '+' : '−') + fmtMS(Math.abs(res)) : signedMoney(res)) : '—');
      setTone(kResult.v, TONES, routes.length ? flowTone(res) : null);
      setText(kResult.sub, routes.length ? 'routes, in all' : 'of routes');
      setText(routeCount, routes.length ? String(routes.length) : '');
      show(routeList, routes.length > 0);
      show(routeEmpty, routes.length === 0);
      const nLines = lines.update(s);
      setText(lineCount, nLines ? String(nLines) : '');
      show(gLines, nLines > 0);
      const quiet = routes.length === 0 && ships.length === 0 && nLines === 0;
      show(idle, quiet);
      show(gRoutes, !quiet);
      show(gShips, !quiet);
    },
  };
}
