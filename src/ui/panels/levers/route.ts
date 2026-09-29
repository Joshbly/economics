// ============================================================================
// Levers panel — Supply routes: a Treasury buy order whose goods are carried
// to another town and offered there. Composed as three steps:
//
//   ① Buy    [good] in [town A] at up to [¤ price] × [qty / day]
//   ② Carry  to [town B]            (freight paid to A's trading house)
//   ③ Offer  there [at ¤ fixed | at landed cost + margin % | for whatever it fetches]
//
// with the usual duration / overall cap, a price comparison of the good across
// every town, and a per-unit "landed cost → sale → margin" estimate. Dispatches
// placeOrder with `route`. Also exports the quote maths and a plain sentence
// for route orders (used by the In force list and the flows view).
// ============================================================================
import { PLAYER_MAX_PRICE, PLAYER_MAX_QTY, ROUTE_HOLD_DAYS, ROUTE_LOAD_SHARE, ROUTE_MARGIN_MAX, ROUTE_MARGIN_MIN, TREASURY_FREIGHT_PREMIUM, WAGON_CAPACITY } from '../../../sim/config';
import { freightPerUnit, traderOf } from '../../../sim/agents/traders';
import { GOODS, G, N_GOODS } from '../../../sim/goods';
import { routeBetweenTowns } from '../../../sim/world/paths';
import type { OrderRoute, PlayerOrder, SimState } from '../../../sim/types';
import { h, setText, show, toggleClass } from '../../dom';
import { fmtNum, fmtPct, fmtPrice, plural } from '../../format';
import { goodOptions, numberInput, segmented, selectInput, swatch, townOptions } from '../../widgets';
import { chip, fin, fmtM, fmtQ, formEl, formFoot, goodName, hint, msgLine, niceRound, optNumber, run, safe, setNumUnit, submitButton, townName, unitOf, unitsOf } from './common';

export type SellMode = OrderRoute['sell'];
type Dur = 'once' | 'days' | 'standing';

// ---------------------------------------------------------------------------
// Quote maths (read-only; shared with the flows view)
// ---------------------------------------------------------------------------

/** Base price of a good in a town today (last clearing, else its average; 0 if unknown). */
export function priceIn(s: SimState, town: number, g: number): number {
  const m = s.markets[town * N_GOODS + g];
  if (!m) return 0;
  const p = m.price > 0 ? m.price : m.ema;
  return fin(p) > 0 ? p : 0;
}

export interface Haul {
  ok: boolean;
  /** Why the route cannot run (when !ok). */
  reason: string;
  /** Treasury freight per unit in full wagons (trip cost / capacity, plus the Treasury premium). */
  perUnitFull: number;
  /** Freight per unit at the route's usual load (a part-filled wagon costs as much as a full one). */
  perUnit: number;
  /** Units per departure, and every how many days a departure leaves. */
  load: number;
  every: number;
  wagons: number;
  days: number;
}

/**
 * How a route buying `q` a day loads its wagons (mirrors player.shipRoutes): the goods wait
 * at the origin until they fill ROUTE_LOAD_SHARE of a wagon or amount to ROUTE_HOLD_DAYS of
 * buying, whichever is less; then everything waiting leaves together.
 */
export function routeLoad(q: number): { load: number; every: number } {
  if (!(q > 0)) return { load: WAGON_CAPACITY, every: 1 };
  const thr = Math.min(ROUTE_LOAD_SHARE * WAGON_CAPACITY, ROUTE_HOLD_DAYS * q);
  const every = q >= thr - 1e-9 ? 1 : Math.ceil(thr / q - 1e-9);
  return { load: every * q, every };
}

/**
 * What carrying `qty` units a day from `a` to `b` costs the Treasury: the origin trading
 * house's full-wagon trip cost (traders.freightPerUnit) plus TREASURY_FREIGHT_PREMIUM,
 * paid per wagon — so loads below a wagonful cost more per unit.
 */
export function haul(s: SimState, a: number, b: number, qty: number): Haul {
  const out: Haul = { ok: false, reason: '', perUnitFull: NaN, perUnit: NaN, load: 0, every: 1, wagons: 0, days: NaN };
  if (a === b) return { ...out, reason: 'Choose a different town to carry the goods to.' };
  const fpu = safe(() => freightPerUnit(s, a, b), -1);
  if (!(fpu >= 0)) return { ...out, reason: `No wagon road links ${townName(s, a)} and ${townName(s, b)}.` };
  if (!safe(() => traderOf(s, a), undefined)) return { ...out, reason: `There is no trading house in ${townName(s, a)} to carry the goods.` };
  const full = fpu * (1 + TREASURY_FREIGHT_PREMIUM);
  const { load, every } = routeLoad(qty);
  const wagons = Math.max(1, Math.ceil(load / WAGON_CAPACITY - 1e-9));
  const days = safe(() => routeBetweenTowns(s, a, b).days, NaN);
  return { ok: true, reason: '', perUnitFull: full, perUnit: (full * WAGON_CAPACITY * wagons) / load, load, every, wagons, days };
}

export interface RouteQuote {
  haul: Haul;
  refA: number; // market price at the origin
  refB: number; // market price at the destination
  buy: number; // expected purchase price per unit
  landed: number; // buy + freight
  floor: number; // lowest price asked at the destination (0 = any)
  sell: number; // expected sale price per unit (NaN when it would not sell at today's price)
  margin: number; // sell − landed
  purseDay: number; // most the Purse pays a day (purchases at the limit + freight)
}

/** Unit economics of a route at today's prices, before anyone reacts. */
export function routeQuote(s: SimState, a: number, b: number, g: number, limit: number, qty: number, mode: SellMode, sellPrice: number, margin: number): RouteQuote {
  const hl = haul(s, a, b, qty);
  const refA = priceIn(s, a, g);
  const refB = priceIn(s, b, g);
  const buy = limit > 0 ? (refA > 0 ? Math.min(limit, refA) : limit) : refA;
  const fr = hl.ok ? hl.perUnit : 0;
  const landed = buy + fr;
  const floor = mode === 'fixed' ? Math.max(0, fin(sellPrice)) : mode === 'cost' ? Math.max(0, landed * (1 + fin(margin))) : 0;
  // An ask at or below today's price sells at about today's price; one above it waits for buyers.
  const sell = refB > 0 ? (floor <= refB + 1e-9 ? refB : NaN) : mode === 'market' ? NaN : floor;
  return { haul: hl, refA, refB, buy, landed, floor, sell, margin: sell - landed, purseDay: (limit > 0 ? limit : buy) * Math.max(0, qty) + fr * Math.max(0, qty) };
}

/** How a route offers its goods, in words: "at landed cost + 10%". */
export function sellText(r: Pick<OrderRoute, 'sell' | 'sellPrice' | 'sellMargin'>, g: number): string {
  if (r.sell === 'fixed') return `for no less than ${fmtPrice(r.sellPrice)} a ${unitOf(g)}`;
  if (r.sell === 'cost') {
    const m = fin(r.sellMargin);
    return Math.abs(m) < 1e-9 ? 'at landed cost' : m > 0 ? `at landed cost + ${fmtPct(m)}` : `at ${fmtPct(-m)} below landed cost`;
  }
  return 'for whatever they fetch';
}

/** Plain sentence for a route order ("Buys up to 50 loaves of bread a day in Aldbury…"). */
export function describeRoute(s: SimState, o: PlayerOrder): string {
  const r = o.route;
  if (!r || o.market.kind !== 'good') return '';
  const g = o.market.good;
  const span = o.once ? ' today' : o.until >= 0 ? ' until the order ends' : '';
  const cap = o.total >= 0 ? ` (at most ${fmtQ(o.total)} in all)` : '';
  return `Buys up to ${fmtQ(o.qty)} ${unitsOf(g)} of ${goodName(g).toLowerCase()} a day in ${townName(s, o.market.town)} at no more than ${fmtPrice(o.price)} each${span}${cap}, carries them by wagon to ${townName(s, r.to)} and offers them there ${sellText(r, g)}.`;
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------
export interface RouteComposer {
  el: HTMLElement;
  update(s: SimState): void;
  /** Start from a market (e.g. the Trade form's current good/town). */
  seed(s: SimState, town: number, good: number): void;
  focus(): void;
  reset(): void;
}

export function routeComposer(): RouteComposer {
  let good: number = G.bread;
  let from = 0;
  let to = 1;
  let mode: SellMode = 'cost';
  let dur: Dur = 'standing';
  let last: SimState | null = null;
  let priceFor = '';
  let sellFor = '';
  const msg = msgLine();
  const edited = () => {
    msg.clear();
    paint();
  };

  // ---- the good across towns --------------------------------------------------
  const cmpTitle = h('span', { class: 'lv-ref-t' });
  const cmpBest = chip('Best spread', () => pickSpread(), 'Buy where this good is cheapest and offer it where it fetches most, after freight at the quantity set');
  const cmpGrid = h('div', { class: 'lv-cmp' });
  const cmpNote = h('div', { class: 'lv-ref-note' });
  const cmp = h('div', { class: 'lv-ref' }, h('div', { class: 'lv-ref-head' }, cmpTitle, cmpBest), cmpGrid, cmpNote);
  let cmpSig = '';

  // ---- ① buy -------------------------------------------------------------------
  const goodSel = selectInput<number>({ options: goodOptions(), value: good, onChange: (v) => ((good = v), marketChanged()) });
  const fromSel = selectInput<number>({ options: [{ value: 0, label: '—' }], value: from, onChange: (v) => ((from = v), marketChanged()) });
  const price = numberInput({ value: NaN, prefix: '¤', unit: '/loaf', min: 0, max: PLAYER_MAX_PRICE, width: '112px', onChange: () => edited(), title: 'The most the Treasury pays per unit' });
  const qty = numberInput({ value: 40, min: 0, max: PLAYER_MAX_QTY, unit: 'loaves/day', width: '132px', onChange: () => edited(), title: 'Units bought per day, at most' });
  const buyChips = h(
    'div',
    { class: 'lv-chips' },
    ([
      [-0.1, '−10%'],
      [0, 'Market'],
      [0.1, '+10%'],
      [0.2, '+20%'],
    ] as [number, string][]).map(([k, lab]) =>
      chip(lab, () => {
        if (!last) return;
        const r = priceIn(last, from, good);
        if (r > 0) price.set(niceRound(r * (1 + k)));
        paint();
      }, k === 0 ? 'Pay at most today’s price here' : `Today’s price here ${lab}`),
    ),
  );
  const buyHint = hint();
  const step1 = step(
    '1',
    'Buy',
    h('div', { class: 'lv-step-line' }, goodSel.el, h('span', { class: 'lv-w' }, 'in'), fromSel.el),
    h('div', { class: 'lv-step-line' }, h('span', { class: 'lv-w' }, 'at up to'), price.el, h('span', { class: 'lv-nowrap' }, h('span', { class: 'lv-w' }, '×'), qty.el)),
    buyChips,
    buyHint,
  );

  // ---- ② carry -----------------------------------------------------------------
  const toSel = selectInput<number>({ options: [{ value: 1, label: '—' }], value: to, onChange: (v) => ((to = v), (sellFor = ''), edited()) });
  const carryHint = hint();
  const fillChip = chip('Fill the wagon', () => {
    const q = qty.value;
    const w = Math.max(1, Math.ceil((q > 0 ? q : 1) / WAGON_CAPACITY - 1e-9));
    qty.set(w * WAGON_CAPACITY);
    edited();
  }, `Buy a full wagonload (${WAGON_CAPACITY}) a day: the freight per unit is lowest when the wagons leave full`);
  const fillRow = h('div', { class: 'lv-chips' }, fillChip);
  const step2 = step('2', 'Carry', h('div', { class: 'lv-step-line' }, h('span', { class: 'lv-w' }, 'by wagon to'), toSel.el), carryHint, fillRow);

  // ---- ③ offer -----------------------------------------------------------------
  const modeSeg = segmented<SellMode>({
    options: [
      { value: 'fixed', label: 'At a price', title: 'Offer them for no less than a price you set' },
      { value: 'cost', label: 'Cost + margin', title: 'Offer them for no less than what they cost to buy and carry, plus a margin' },
      { value: 'market', label: 'Any price', title: 'Offer them for whatever they fetch in the auction' },
    ],
    value: mode,
    size: 'sm',
    full: true,
    onChange: (v) => ((mode = v), edited()),
  });
  const sellPrice = numberInput({ value: NaN, prefix: '¤', unit: '/loaf', min: 0, max: PLAYER_MAX_PRICE, width: '112px', onChange: () => edited(), title: 'The lowest price asked at the destination' });
  const margin = numberInput({ value: 0.1, percent: true, min: ROUTE_MARGIN_MIN, max: ROUTE_MARGIN_MAX, width: '82px', onChange: () => edited(), title: 'Margin over landed cost (negative: below it)' });
  const sellChips = h(
    'div',
    { class: 'lv-chips' },
    chip('Market there', () => setSell(0), 'Today’s price at the destination'),
    chip('+10%', () => setSell(0.1)),
    chip('Landed cost', () => setSell(NaN), 'What a unit costs to buy here and carry there'),
  );
  const marginChips = h('div', { class: 'lv-chips' }, [0, 0.05, 0.1, 0.25].map((m) => chip(m === 0 ? 'At cost' : '+' + fmtPct(m), () => (margin.set(m), paint()))));
  const wFixed = h('div', { class: 'lv-step-line' }, h('span', { class: 'lv-w' }, 'for no less than'), sellPrice.el);
  const wCost = h('div', { class: 'lv-step-line' }, h('span', { class: 'lv-w' }, 'landed cost +'), margin.el);
  const wMarket = h('div', { class: 'lv-hint lv-step-note' });
  const sellHint = hint();
  const step3 = step('3', 'Offer', modeSeg.el, wFixed, sellChips, wCost, marginChips, wMarket, sellHint);

  // ---- duration --------------------------------------------------------------------
  const durSeg = segmented<Dur>({
    options: [
      { value: 'once', label: 'Once', title: 'Buy in today’s market only' },
      { value: 'days', label: 'N days' },
      { value: 'standing', label: 'Until cancelled' },
    ],
    value: dur,
    size: 'sm',
    onChange: (v) => ((dur = v), edited()),
  });
  const days = numberInput({ value: 30, integer: true, min: 1, max: 36000, unit: 'days', width: '92px', onChange: () => edited() });
  const total = optNumber({ placeholder: 'no cap', unit: 'loaves', min: 0, width: '132px', onChange: () => edited() });
  const durRow = h('div', { class: 'lv-row' }, h('div', { class: 'lv-lab' }, 'Buying for'), h('div', { class: 'lv-ctl' }, durSeg.el, days.el));
  const totalRow = h('div', { class: 'lv-row' }, h('div', { class: 'lv-lab' }, 'In all'), h('div', { class: 'lv-ctl' }, total.el, hint('Optional: stop buying after this many.')));

  // ---- per-unit economics & preview ----------------------------------------------------
  const eq = {
    buy: eqCell('Buy'),
    fr: eqCell('Freight'),
    landed: eqCell('Landed'),
    sell: eqCell('Sells'),
    margin: eqCell('Margin'),
  };
  const eqRow = h(
    'div',
    { class: 'lv-eq' },
    eq.buy.el,
    h('span', { class: 'lv-eq-op' }, '+'),
    eq.fr.el,
    h('span', { class: 'lv-eq-op' }, '='),
    eq.landed.el,
    h('span', { class: 'lv-eq-op' }, '→'),
    eq.sell.el,
    eq.margin.el,
  );
  const preview = h('div', { class: 'lv-preview' });
  const go = submitButton('Start route', 'Place the buy order and send what it buys to the destination (Enter)');
  const form = formEl(() => submit(), cmp, h('div', { class: 'lv-steps' }, step1, step2, step3), durRow, totalRow, eqRow, formFoot(preview, msg, go));
  const el = h('div', { class: 'lv-route' }, form);

  // ---- logic ------------------------------------------------------------------------------
  function setSell(k: number): void {
    const s = last;
    if (!s) return;
    if (Number.isFinite(k)) {
      const r = priceIn(s, to, good);
      if (r > 0) sellPrice.set(niceRound(r * (1 + k)));
    } else {
      const q = routeQuote(s, from, to, good, price.value, qty.value, 'market', 0, 0);
      if (q.landed > 0) sellPrice.set(niceRound(q.landed));
    }
    paint();
  }

  /** The pair of towns with the widest gap after freight (at the quantity set). */
  function pickSpread(): void {
    const s = last;
    if (!s) return;
    const q = qty.value > 0 ? qty.value : WAGON_CAPACITY;
    let best = -Infinity;
    let pa = -1;
    let pb = -1;
    for (let a = 0; a < s.towns.length; a++) {
      const A = priceIn(s, a, good);
      if (!(A > 0)) continue;
      for (let b = 0; b < s.towns.length; b++) {
        if (b === a) continue;
        const Bp = priceIn(s, b, good);
        if (!(Bp > 0)) continue;
        const hl = haul(s, a, b, q);
        if (!hl.ok) continue;
        const gap = Bp - A - hl.perUnit;
        if (gap > best) {
          best = gap;
          pa = a;
          pb = b;
        }
      }
    }
    if (pa < 0) return msg.err(`No two towns with a price for ${goodName(good).toLowerCase()} and a wagon road between them.`);
    from = pa;
    to = pb;
    sellFor = '';
    marketChanged();
    if (qty.value > 0 && Math.abs(qty.value - q) > 1e-9) {
      qty.set(q); // keep the quantity the pair was judged at
      paint();
    }
    if (best <= 0) msg.err(`Even the best pair loses ${fmtPrice(-best)} a ${unitOf(good)} after freight at ${fmtQ(q)} a day. Fuller wagons carry for less.`);
  }

  function marketChanged(): void {
    msg.clear();
    goodSel.set(good);
    fromSel.set(from);
    if (to === from && last && last.towns.length > 1) to = (from + 1) % last.towns.length;
    toSel.set(to);
    if (last) syncDefaults(last);
    paint();
  }

  /** New good/origin: default the limit to the market there, the quantity to a sensible share. */
  function syncDefaults(s: SimState): void {
    const k = `${from}:${good}`;
    if (k !== priceFor) {
      priceFor = k;
      const r = priceIn(s, from, good);
      price.set(r > 0 ? niceRound(r * 1.05) : NaN);
      const v = fin(s.markets[from * N_GOODS + good]?.volEma);
      const q = v * 0.2;
      qty.set(q >= 50 ? Math.round(q / 10) * 10 : q >= 5 ? Math.round(q) : 5);
    }
    const k2 = `${to}:${good}`;
    if (k2 !== sellFor) {
      sellFor = k2;
      const r = priceIn(s, to, good);
      sellPrice.set(r > 0 ? niceRound(r) : NaN);
    }
  }

  function paintCompare(s: SimState): void {
    setText(cmpTitle, `${goodName(good)} across the realm`);
    const nT = s.towns.length;
    let sig = `${good}|${from}|${to}|${nT}`;
    const vals: { p: number; v: number; hold: number }[] = [];
    for (let t = 0; t < nT; t++) {
      const m = s.markets[t * N_GOODS + good];
      const p = priceIn(s, t, good);
      const v = fin(m?.volEma);
      const hold = fin(s.treasury.goods[t]?.[good]);
      vals.push({ p, v, hold });
      sig += `|${p.toFixed(3)},${v.toFixed(1)},${hold.toFixed(1)}`;
    }
    if (sig !== cmpSig) {
      cmpSig = sig;
      const lab = (t: string) => h('span', { class: 'lv-cmp-l' }, t);
      const head = h('div', { class: 'lv-cmp-r lv-cmp-h' }, h('span'), ...s.towns.map((t) => h('span', { class: 'lv-cmp-town' + (t.id === from ? ' is-from' : t.id === to ? ' is-to' : ''), title: t.name }, h('i', null, t.id === from ? 'buy' : t.id === to ? 'offer' : '\u00a0'), t.name)));
      const pRow = h('div', { class: 'lv-cmp-r' }, lab('Price'), ...vals.map((x, t) => h('span', { class: cellCls(t) + ' strong' }, x.p > 0 ? fmtPrice(x.p) : '—')));
      const vRow = h('div', { class: 'lv-cmp-r' }, lab('Per day'), ...vals.map((x, t) => h('span', { class: cellCls(t) }, fmtQ(x.v))));
      const anyHold = vals.some((x) => x.hold > 0.005);
      const hRow = anyHold ? h('div', { class: 'lv-cmp-r' }, lab('You hold'), ...vals.map((x, t) => h('span', { class: cellCls(t) + (x.hold > 0.005 ? '' : ' faint') }, x.hold > 0.005 ? fmtQ(x.hold) : '·'))) : null;
      cmpGrid.replaceChildren(head, pRow, vRow, ...(hRow ? [hRow] : []));
      cmpGrid.style.setProperty('--cols', String(nT));
    }
    const pa = vals[from]?.p ?? 0;
    const pb = vals[to]?.p ?? 0;
    const gap = pa > 0 && pb > 0 ? pb - pa : NaN;
    setText(
      cmpNote,
      Number.isFinite(gap)
        ? `${townName(s, to)} pays ${fmtPrice(Math.abs(gap))} ${gap >= 0 ? 'more' : 'less'} a ${unitOf(good)} than ${townName(s, from)} today (${gap >= 0 ? '+' : '−'}${fmtPct(Math.abs(gap) / pa)}).`
        : 'No price yet in one of the two towns.',
    );
  }
  function cellCls(t: number): string {
    return t === from ? 'is-from' : t === to ? 'is-to' : '';
  }

  function paint(): void {
    const s = last;
    if (!s) return;
    const u = unitOf(good);
    const us = unitsOf(good);
    setNumUnit(price, '/' + u);
    setNumUnit(sellPrice, '/' + u);
    setNumUnit(qty, us + '/day');
    total.setUnit(us);
    paintCompare(s);
    show(days.el, dur === 'days');
    show(wFixed, mode === 'fixed');
    show(sellChips, mode === 'fixed');
    show(wCost, mode === 'cost');
    show(marginChips, mode === 'cost');
    show(wMarket, mode === 'market');

    const p = price.value;
    const q = qty.value;
    const Q = routeQuote(s, from, to, good, p, q, mode, sellPrice.value, margin.value);
    const hl = Q.haul;
    // ① buy hint
    const rel = Q.refA > 0 && p > 0 ? p / Q.refA - 1 : NaN;
    setText(
      buyHint,
      Q.refA > 0
        ? `Here ${fmtPrice(Q.refA)}/${u}${Number.isFinite(rel) ? ` · yours is ${Math.abs(rel) < 0.0005 ? 'at the market' : fmtPct(Math.abs(rel)) + (rel > 0 ? ' above' : ' below')}` : ''} · ≈ ${fmtQ(fin(s.markets[from * N_GOODS + good]?.volEma))} ${us} traded a day.`
        : 'No price here yet.',
    );
    // ② carry hint
    if (!hl.ok) carryHint.replaceChildren(h('span', { class: 'warn' }, hl.reason));
    else {
      const part = q > 0 && hl.perUnit > hl.perUnitFull * 1.02;
      setText(fillChip, `Fill the wagon: ${fmtQ(Math.max(1, Math.ceil((q > 0 ? q : 1) / WAGON_CAPACITY - 1e-9)) * WAGON_CAPACITY)} a day`);
      const bits: (string | Node)[] = [];
      if (Number.isFinite(hl.days) && hl.days > 0) bits.push(`About ${plural(Math.max(0.5, Math.round(hl.days * 10) / 10), 'day')} on the road. `);
      if (q > 0 && hl.every > 1) bits.push(`A wagon leaves every ${plural(hl.every, 'day')} with about ${fmtQ(hl.load)}. `);
      else if (q > 0) bits.push(`${hl.wagons > 1 ? `${hl.wagons} wagons leave` : 'A wagon leaves'} daily with ${fmtQ(hl.load)}. `);
      bits.push('Freight ', h('b', null, `${fmtPrice(hl.perUnit)}/${u}`), part ? ` (${fmtPrice(hl.perUnitFull)} in full wagons of ${WAGON_CAPACITY}).` : '.');
      carryHint.replaceChildren(...bits);
    }
    show(fillRow, hl.ok && q > 0 && hl.perUnit > hl.perUnitFull * 1.02);
    carryHint.title = hl.ok
      ? `Paid from the Purse to ${townName(s, from)}’s trading house for every wagon: its carters’ wages, fuel and wagon wear for the round trip, plus ${fmtPct(TREASURY_FREIGHT_PREMIUM)}. A part-filled wagon costs as much as a full one, so purchases wait in ${townName(s, from)} until they fill half a wagon or ${ROUTE_HOLD_DAYS} days of buying.`
      : '';
    // ③ offer hint
    if (mode === 'market') setText(wMarket, `Everything that arrives is offered in ${townName(s, to)}’s auction at any price. When buyers are few, a large delivery sells for little.`);
    const refB = Q.refB;
    if (mode === 'fixed') {
      const sp = sellPrice.value;
      setText(sellHint, refB > 0 ? `${townName(s, to)} today: ${fmtPrice(refB)}/${u}.${sp > refB * 1.001 ? ' Above today’s price there — the goods wait until buyers pay it.' : ''}` : `No price in ${townName(s, to)} yet.`);
    } else if (mode === 'cost') {
      setText(sellHint, Q.landed > 0 ? `Lowest ask at today’s prices ≈ ${fmtPrice(Q.floor)}/${u}${refB > 0 ? `; ${townName(s, to)} pays ${fmtPrice(refB)}` : ''}. Landed cost = what the units cost to buy and carry.` : '');
    } else setText(sellHint, refB > 0 ? `${townName(s, to)} today: ${fmtPrice(refB)}/${u}.` : '');

    // per-unit economics
    const okP = p > 0 && q > 0;
    eq.buy.set(okP ? fmtPrice(Q.buy) : '—', p > 0 && Q.refA > 0 && p < Q.refA ? 'at most' : 'about');
    eq.fr.set(hl.ok ? fmtPrice(hl.perUnit) : '—', hl.ok ? 'a unit' : 'no road');
    eq.landed.set(okP && hl.ok ? fmtPrice(Q.landed) : '—', 'a unit');
    const sells = Number.isFinite(Q.sell) && Q.sell > 0;
    eq.sell.set(sells ? fmtPrice(Q.sell) : '—', sells ? 'there now' : refB > 0 ? 'too high' : 'no price');
    eq.sell.el.title = sells ? `Today’s price in ${townName(s, to)}` : refB > 0 ? `The lowest ask is above today’s price in ${townName(s, to)} (${fmtPrice(refB)})` : '';
    const mg = okP && hl.ok && sells ? Q.margin : NaN;
    eq.margin.set(Number.isFinite(mg) ? (mg >= 0 ? '+' : '−') + fmtPrice(Math.abs(mg)) : '—', Number.isFinite(mg) && Q.landed > 0 ? `${mg >= 0 ? '+' : '−'}${fmtPct(Math.abs(mg) / Q.landed)}` : 'a unit');
    eq.margin.el.title = Number.isFinite(mg) ? `${mg >= 0 ? 'Gain' : 'Loss'} per ${u} at today’s prices, before anyone reacts` : '';
    toggleClass(eq.margin.el, 'good', Number.isFinite(mg) && mg > 0.0005);
    toggleClass(eq.margin.el, 'bad', Number.isFinite(mg) && mg < -0.0005);

    // preview
    const B = (x: string, cls?: string) => h('b', { class: cls ?? null }, x);
    const bits: (string | Node)[] = [];
    const n = dur === 'days' ? days.value : dur === 'once' ? 1 : NaN;
    const span = dur === 'once' ? ', today only' : dur === 'days' && n > 0 ? `, for ${plural(n, 'day')}` : ', until cancelled';
    if (!(p > 0)) bits.push('Set the most to pay.');
    else if (!(q > 0)) bits.push('Set how many to buy a day.');
    else if (!hl.ok) bits.push(h('span', { class: 'warn' }, hl.reason));
    else {
      bits.push('Up to ', B(fmtM(Q.purseDay)), ' a day from the Purse', span, ` (${fmtM(p * q)} buying, ≈ ${fmtM(hl.perUnit * q)} freight).`);
      if (Number.isFinite(mg) && q > 0) bits.push(' If it all sells at today’s price: ', B((mg >= 0 ? '+' : '−') + fmtM(Math.abs(mg * q)), mg >= 0 ? 'good' : 'bad'), ' a day.');
      else if (mode !== 'market' && refB > 0 && Q.floor > refB) bits.push(h('span', { class: 'warn' }, ` The asking price is above what ${townName(s, to)} pays today, so goods may wait unsold.`));
      if (total.value > 0) bits.push(' Stops buying after ', B(`${fmtQ(total.value)} ${us}`), '.');
      if (!s.treasury.autoMint && fin(s.treasury.purse) < Q.purseDay) bits.push(h('span', { class: 'warn' }, ` The Purse holds ${fmtM(fin(s.treasury.purse))}, so purchases are capped by what it can pay.`));
    }
    preview.replaceChildren(...bits);
    const sellOk = mode === 'market' || (mode === 'fixed' ? sellPrice.value > 0 : Number.isFinite(margin.value) && !margin.error);
    go.disabled = !(p > 0 && q > 0 && hl.ok && sellOk && (dur !== 'days' || n > 0) && !total.error);
  }

  function submit(): void {
    const s = last;
    if (!s) return;
    const p = price.value;
    const q = qty.value;
    if (!(p > 0)) return msg.err(price.error ?? 'Set the most to pay.');
    if (!(q > 0)) return msg.err(qty.error ?? 'Set how many to buy a day.');
    if (from === to) return msg.err('Choose a different town to carry the goods to.');
    if (total.error) return msg.err(total.error);
    const route: { to: number; sell: SellMode; sellPrice?: number; sellMargin?: number } = { to, sell: mode };
    if (mode === 'fixed') {
      if (!(sellPrice.value > 0)) return msg.err(sellPrice.error ?? 'Set the lowest price to ask (above zero).');
      route.sellPrice = sellPrice.value;
    } else if (mode === 'cost') {
      if (!Number.isFinite(margin.value) || margin.error) return msg.err(margin.error ?? 'Set a margin (0 for at cost).');
      route.sellMargin = margin.value;
    }
    run(
      {
        type: 'placeOrder',
        market: { kind: 'good', town: from, good },
        side: 'buy',
        price: p,
        qty: q,
        total: total.value > 0 ? total.value : undefined,
        days: dur === 'days' ? Math.max(1, Math.round(days.value)) : undefined,
        once: dur === 'once',
        route,
      },
      msg,
      '✓ Route started — follow it under Stores & wagons below.',
    );
  }

  return {
    el,
    update(s) {
      last = s;
      fromSel.setOptions(townOptions(s), from);
      from = fromSel.value;
      toSel.setOptions(townOptions(s), to);
      to = toSel.value;
      if (to === from && s.towns.length > 1) {
        to = (from + 1) % s.towns.length;
        toSel.set(to);
      }
      syncDefaults(s);
      paint();
    },
    seed(s, town, g) {
      last = s;
      if (town >= 0 && town < s.towns.length) from = town;
      if (g >= 0 && g < N_GOODS) good = g;
      marketChanged();
    },
    focus: () => price.focus(),
    reset() {
      last = null;
      priceFor = '';
      sellFor = '';
      cmpSig = '';
    },
  };
}

function step(n: string, title: string, ...body: (HTMLElement | null)[]): HTMLElement {
  return h('div', { class: 'lv-step' }, h('div', { class: 'lv-step-rail' }, h('span', { class: 'lv-step-n' }, n)), h('div', { class: 'lv-step-main' }, h('div', { class: 'lv-step-t' }, title), ...body));
}

function eqCell(label: string): { el: HTMLElement; set(v: string, sub: string): void } {
  const v = h('span', { class: 'lv-eq-v' });
  const sub = h('span', { class: 'lv-eq-s' });
  const el = h('div', { class: 'lv-eq-c' }, h('span', { class: 'lv-eq-l' }, label), v, sub);
  return {
    el,
    set(val, s) {
      setText(v, val);
      setText(sub, s);
    },
  };
}

/** Good swatch + name, for compact rows. */
export function goodTag(g: number): HTMLElement {
  return h('span', { class: 'lv-goodtag' }, swatch(GOODS[g]?.color ?? '#999', 'box'), goodName(g));
}
