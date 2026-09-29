// ============================================================================
// Lever II — Trade: post Treasury orders in any market (a good in a town, a
// town's labour market, the national IOU and Gold markets), compose supply
// routes (buy in one town → carry → offer in another; ./route.ts), and look
// after the Treasury's stores and wagons (./flows.ts, with Move goods).
// Treasury orders trade at the base price and are exempt from levies.
// ============================================================================
import { IOU_COUPON, IOU_PAR, PLAYER_MAX_PRICE, PLAYER_MAX_QTY, PLAYER_MAX_WORKERS, ROUTE_MARGIN_MAX, ROUTE_MARGIN_MIN, TREASURY_FREIGHT_PREMIUM, WAGON_CAPACITY } from '../../../sim/config';
import { freightPerUnit } from '../../../sim/agents/traders';
import { GOODS, G, N_GOODS } from '../../../sim/goods';
import { routeBetweenTowns } from '../../../sim/world/paths';
import type { MarketState, OrderMarket, SimState } from '../../../sim/types';
import { h, setText, show } from '../../dom';
import { fmtNum, fmtPct, fmtPrice, plural } from '../../format';
import { ui, type PrefillRequest } from '../../uiState';
import { goodOptions, numberInput, segmented, selectInput, sparkline, townOptions } from '../../widgets';
import {
  chip,
  dynRow,
  fin,
  fmtM,
  fmtQ,
  formEl,
  formFoot,
  goodName,
  hint,
  msgLine,
  niceRound,
  optNumber,
  row,
  run,
  safe,
  setNumUnit,
  subhead,
  submitButton,
  townName,
  unitOf,
  unitsOf,
  type Lever,
} from './common';
import { flowsView } from './flows';
import { priceIn, routeComposer, type SellMode } from './route';

type MKind = 'good' | 'route' | 'labor' | 'iou' | 'gold';
type Then = 'hold' | 'fixed' | 'cost' | 'market';
type Dur = 'once' | 'days' | 'standing';

export function tradeLever(): Lever {
  let kind: MKind = 'good';
  let town = 0;
  let good: number = G.bread;
  let side: 'buy' | 'sell' = 'buy';
  let dur: Dur = 'standing';
  /** How the price limit is set: fixed, following the market within a band, or none. */
  type PMode = 'fixed' | 'f05' | 'f10' | 'f20' | 'f30' | 'any';
  let pmode: PMode = 'fixed';
  let pace: 'patient' | 'eager' = 'patient'; // how an order that follows the market bids within its band
  const bandOf = (m: PMode): number => (m === 'f05' ? 0.05 : m === 'f10' ? 0.1 : m === 'f20' ? 0.2 : m === 'f30' ? 0.3 : 0);
  let priceFor = ''; // market signature the price field was last defaulted for
  let uiMarketApplied = '';
  let last: SimState | null = null;

  const msg = msgLine();
  const edited = () => {
    msg.clear();
    paint();
  };

  // ---- market -------------------------------------------------------------
  const kindSeg = segmented<MKind>({
    options: [
      { value: 'good', label: 'Goods', title: 'A good in one town’s market' },
      { value: 'route', label: 'Route', title: 'Buy in one town, carry by wagon, offer in another' },
      { value: 'labor', label: 'Labour', title: 'Hire Treasury workers in a town' },
      { value: 'iou', label: 'IOUs', title: 'Issue or buy back the Treasury’s IOUs (national market)' },
      { value: 'gold', label: 'Gold', title: 'Buy or sell gold (national market)' },
    ],
    value: kind,
    full: true,
    onChange: (v) => {
      if (v === 'route') {
        if (kind === 'good' && last) routes.seed(last, town, good);
        kind = v;
        kindSeg.set(v);
        showMode();
        if (last) routes.update(last);
        return;
      }
      kind = v;
      if (kind === 'labor') side = 'buy';
      marketChanged();
    },
  });
  const routes = routeComposer();
  const townSel = selectInput<number>({ options: [{ value: 0, label: '—' }], value: 0, onChange: (v) => ((town = v), marketChanged()) });
  const goodSel = selectInput<number>({ options: goodOptions(), value: good, onChange: (v) => ((good = v), marketChanged()) });
  const nationalNote = h('span', { class: 'lv-static' }, 'National market');
  const marketRow = row('Market', townSel.el, goodSel.el, nationalNote);

  const sideSeg = segmented<'buy' | 'sell'>({
    options: [
      { value: 'buy', label: 'Buy' },
      { value: 'sell', label: 'Sell' },
    ],
    value: side,
    size: 'md',
    onChange: (v) => ((side = v), edited()),
  });
  const employNote = h('span', { class: 'lv-static' }, 'Employ Treasury workers');
  const sideRow = dynRow('Side', sideSeg.el, employNote);

  // ---- reference card -----------------------------------------------------------
  const refTitle = h('span', { class: 'lv-ref-t' });
  const spark = sparkline({ width: 96, height: 22, dot: true });
  const cellL = [0, 1, 2, 3].map(() => h('span', { class: 'lv-ref-l' }));
  const cellV = [0, 1, 2, 3].map(() => h('span', { class: 'lv-ref-v' }));
  const refNote = h('div', { class: 'lv-ref-note' });
  const ref = h(
    'div',
    { class: 'lv-ref' },
    h('div', { class: 'lv-ref-head' }, refTitle, spark.el),
    h('div', { class: 'lv-ref-grid' }, cellL.map((l, i) => h('div', { class: 'lv-ref-cell' }, l, cellV[i]))),
    refNote,
  );

  // ---- price / qty / duration ---------------------------------------------------
  const price = numberInput({ value: NaN, prefix: '¤', unit: '/loaf', min: 0, max: PLAYER_MAX_PRICE, width: '132px', onChange: () => edited() });
  const pctChips = h(
    'div',
    { class: 'lv-chips' },
    ([
      [-0.2, '−20%'],
      [-0.1, '−10%'],
      [0, 'Market'],
      [0.1, '+10%'],
      [0.2, '+20%'],
    ] as [number, string][]).map(([k, lab]) =>
      chip(lab, () => {
        if (!last) return;
        const r = refPrice(last);
        if (r > 0) price.set(niceRound(r * (1 + k)));
        paint();
      }, k === 0 ? 'Set the limit to the current market price' : `Market price ${lab}`),
    ),
  );
  const modeSeg = segmented<PMode>({
    options: [
      { value: 'fixed', label: 'Fixed', title: 'A price limit you set and that stays put' },
      { value: 'f05', label: '±5%', title: 'Follow the market: each morning the limit re-sets to the going price, within 5%' },
      { value: 'f10', label: '±10%', title: 'Follow the market: each morning the limit re-sets to the going price, within 10%' },
      { value: 'f20', label: '±20%', title: 'Follow the market: each morning the limit re-sets to the going price, within 20%' },
      { value: 'f30', label: '±30%', title: 'Follow the market: each morning the limit re-sets to the going price, within 30%' },
      { value: 'any', label: 'Any', title: 'Any price — no limit: buying goes on however high the price climbs (while the Purse can pay); selling takes whatever the market pays' },
    ],
    value: pmode,
    size: 'sm',
    onChange: (v) => {
      pmode = v;
      edited();
    },
  });
  const modeHint = hint();
  const modeRow = dynRow('Price', modeSeg.el, modeHint);
  const paceSeg = segmented<'patient' | 'eager'>({
    options: [
      { value: 'patient', label: 'As low as it can', title: 'Start at the market’s going price; step towards the band’s edge only on days the order falls short, and back on days it fills' },
      { value: 'eager', label: 'Always at the edge', title: 'Always bid the full band away from the going price: fills first, pays more when the order is large' },
    ],
    value: pace,
    size: 'sm',
    onChange: (v) => {
      pace = v;
      edited();
    },
  });
  const paceRow = dynRow('Bidding', paceSeg.el);
  const priceRow = dynRow('Price limit', price.el, pctChips);
  const priceHint = hint();
  priceRow.ctl.appendChild(priceHint);

  const qty = numberInput({ value: 10, unit: 'loaves/day', min: 0, max: PLAYER_MAX_QTY, width: '150px', onChange: () => edited() });
  const qtyHint = hint();
  const qtyRow = dynRow('Per day', qty.el, qtyHint);

  const durSeg = segmented<Dur>({
    options: [
      { value: 'once', label: 'Once', title: 'Today’s market only' },
      { value: 'days', label: 'N days' },
      { value: 'standing', label: 'Until cancelled' },
    ],
    value: dur,
    size: 'sm',
    onChange: (v) => {
      dur = v;
      edited();
    },
  });
  const days = numberInput({ value: 30, integer: true, min: 1, max: 36000, unit: 'days', width: '96px', onChange: () => edited() });
  const total = optNumber({ placeholder: 'no cap', unit: 'loaves', min: 0, width: '150px', onChange: () => edited() });
  const durRow = row('Duration', durSeg.el, days.el);
  const totalRow = row('In all', total.el, hint('Optional: the order ends after this many in all.'));

  const preview = h('div', { class: 'lv-preview' });
  const place = submitButton('Place order');
  const form = formEl(
    () => submit(),
    marketRow,
    ref,
    sideRow.el,
    modeRow.el,
    paceRow.el,
    priceRow.el,
    qtyRow.el,
    durRow,
    totalRow,
    formFoot(preview, msg, place),
  );

  // ---- stores & wagons ------------------------------------------------------------
  const flows = flowsView({ place: 'levers' });
  const goldLine = h('div', { class: 'lv-hold-line' });
  const iouLine = h('div', { class: 'lv-hold-line' });

  // move goods
  const moveMsg = msgLine();
  // The form follows the stores: a good jumps the origin to where it is held, an origin
  // jumps the good to what is held there, and an untouched form starts at the largest holding.
  let mvTouched = false;
  const mvFrom = selectInput<number>({ options: [{ value: 0, label: '—' }], value: 0, onChange: () => ((mvTouched = true), followStores('from'), paintMove()) });
  const mvTo = selectInput<number>({ options: [{ value: 1, label: '—' }], value: 1, onChange: () => ((mvTouched = true), paintMove()) });
  const mvGood = selectInput<number>({ options: goodOptions(), value: G.bread, onChange: () => ((mvTouched = true), followStores('good'), paintMove()) });
  const mvQty = numberInput({ value: 40, min: 0, max: PLAYER_MAX_QTY, unit: 'loaves', width: '130px', onChange: () => paintMove() });
  const mvAll = chip('All', () => {
    if (!last) return;
    mvQty.set(Math.floor(fin(last.treasury.goods[mvFrom.value]?.[mvGood.value]) * 100) / 100);
    paintMove();
  }, 'Everything held there');
  // …then offer it there
  let then: Then = 'hold';
  const thenSeg = segmented<Then>({
    options: [
      { value: 'hold', label: 'Keep', title: 'Add them to the Treasury’s stores there' },
      { value: 'fixed', label: 'Offer at ¤', title: 'Offer them there for no less than a price' },
      { value: 'cost', label: 'Cost + %', title: 'Offer them there for no less than what they cost, plus a margin' },
      { value: 'market', label: 'Any price', title: 'Offer them there for whatever they fetch' },
    ],
    value: then,
    size: 'sm',
    onChange: (v) => ((then = v), moveMsg.clear(), paintMove()),
  });
  const mvPrice = numberInput({ value: NaN, prefix: '¤', min: 0, max: PLAYER_MAX_PRICE, unit: '/loaf', width: '112px', onChange: () => paintMove() });
  const mvMargin = numberInput({ value: 0.1, percent: true, min: ROUTE_MARGIN_MIN, max: ROUTE_MARGIN_MAX, width: '82px', onChange: () => paintMove() });
  const mvThenHint = hint();
  let mvPriceFor = '';
  const mvPreview = h('div', { class: 'lv-preview' });
  const mvBtn = submitButton('Move goods');
  const moveForm = formEl(
    () => doMove(),
    row('Route', mvFrom.el, h('span', { class: 'lv-w' }, 'to'), mvTo.el),
    row('Goods', mvGood.el),
    row('Quantity', mvQty.el, mvAll),
    row('Then', thenSeg.el, mvPrice.el, mvMargin.el, mvThenHint),
    formFoot(mvPreview, moveMsg, mvBtn),
  );
  const moveBox = h('div', { class: 'lv-subform' }, subhead('Move goods'), moveForm);

  const body = h(
    'div',
    { class: 'lv-body-in' },
    h('div', { class: 'lv-row lv-row-full lv-kindrow' }, kindSeg.el),
    form,
    routes.el,
    h('div', { class: 'lv-sep' }),
    subhead('Treasury stores & wagons'),
    flows.el,
    goldLine,
    iouLine,
    moveBox,
  );

  function showMode(): void {
    show(form, kind !== 'route');
    show(routes.el, kind === 'route');
  }

  // ---- helpers ------------------------------------------------------------------
  function market(s: SimState): MarketState | undefined {
    if (kind === 'iou') return s.iouMarket;
    if (kind === 'gold') return s.goldMarket;
    if (kind === 'good' || kind === 'route') return s.markets[town * N_GOODS + good];
    return undefined;
  }
  /** The going price the simulation follows (the market's smoothed clearing price). */
  function goingPrice(s: SimState): number {
    if (kind === 'labor') return 0;
    const m = market(s);
    // the market's own going price: without the Treasury's orders (what following orders anchor to)
    const own = fin(m?.ownEma);
    const p = m ? (own > 0 ? own : m.ema > 0 ? m.ema : m.price) : 0;
    return fin(p) > 0 ? p : kind === 'iou' ? IOU_PAR : 0;
  }
  function refPrice(s: SimState): number {
    if (kind === 'labor') {
      const t = s.towns[town];
      const w = fin(t?.avgWage);
      return w > 0 ? w : fin(s.stats?.latest?.wage);
    }
    const m = market(s);
    if (!m) return kind === 'iou' ? IOU_PAR : 0;
    const p = m.price > 0 ? m.price : m.ema;
    return fin(p) > 0 ? p : kind === 'iou' ? IOU_PAR : 0;
  }
  function sig(): string {
    return kind === 'good' ? `g${town}:${good}` : kind === 'labor' ? `l${town}` : kind;
  }
  function stateworksCount(s: SimState, t: number): number {
    let n = 0;
    for (const f of s.firms) if (f && f.alive && f.sector === 'stateworks' && f.town === t) n += f.workers.length;
    return n;
  }
  function mean30(a: number[] | undefined): number {
    if (!a || !a.length) return NaN;
    let sum = 0;
    let k = 0;
    for (let i = a.length - 1; i >= 0 && k < 30; i--) if (Number.isFinite(a[i]) && a[i] > 0) (sum += a[i]), k++;
    return k ? sum / k : NaN;
  }

  function marketChanged(): void {
    msg.clear();
    kindSeg.set(kind);
    showMode();
    townSel.set(town);
    goodSel.set(good);
    sideSeg.set(side);
    if (last) syncDefaults(last);
    paint();
  }

  /** New market selected: default the price to the market, the quantity to something sensible. */
  function syncDefaults(s: SimState, forcePrice?: number): void {
    const k = sig();
    if (k === priceFor && forcePrice === undefined) return;
    priceFor = k;
    const r = forcePrice !== undefined && forcePrice > 0 ? forcePrice : refPrice(s);
    price.set(r > 0 ? niceRound(r) : NaN);
    if (kind === 'labor') qty.set(5);
    else if (kind === 'iou') qty.set(10);
    else if (kind === 'gold') qty.set(1);
    else {
      const m = market(s);
      const v = fin(m?.volEma);
      const q = v * 0.3;
      qty.set(q >= 50 ? Math.round(q / 10) * 10 : q >= 5 ? Math.round(q) : 5);
    }
  }

  function unitWords(): { price: string; qty: string; total: string } {
    switch (kind) {
      case 'labor':
        return { price: '/day', qty: 'workers', total: 'worker-days' };
      case 'iou':
        return { price: '/IOU', qty: 'IOUs/day', total: 'IOUs' };
      case 'gold':
        return { price: '/oz', qty: 'oz/day', total: 'oz' };
      default:
        return { price: '/' + unitOf(good), qty: unitsOf(good) + '/day', total: unitsOf(good) };
    }
  }

  function paintRef(s: SimState): void {
    const t = s.treasury;
    const cells: [string, string, string?][] = [];
    let note = '';
    if (kind === 'good') {
      const m = market(s);
      setText(refTitle, `${goodName(good)} · ${townName(s, town)}`);
      const p = fin(m?.price);
      cells.push(['Last', fmtPrice(p > 0 ? p : m?.ema)]);
      cells.push(['30-day avg', fmtPrice(mean30(m?.hist))]);
      cells.push(['Traded / day', fmtQ(fin(m?.volEma))]);
      cells.push(['You hold here', fmtQ(fin(t.goods[town]?.[good]))]);
      if (m && (Math.abs(m.gross - m.price) > 1e-6 || Math.abs(m.net - m.price) > 1e-6) && m.price > 0)
        note = `Levies in force here: buyers pay ${fmtPrice(m.gross)}, sellers get ${fmtPrice(m.net)}. Treasury orders trade at the base price, free of levies.`;
      else if (m && !m.traded) note = 'No trade cleared here today — the price shown is indicative (between the best bid and ask).';
      spark.set(m?.hist ?? []);
      show(spark.el, true);
    } else if (kind === 'labor') {
      const tw = s.towns[town];
      setText(refTitle, `Workers · ${townName(s, town)}`);
      cells.push(['Avg wage', fmtPrice(fin(tw?.avgWage)) + '/day']);
      cells.push(['Jobless', fmtNum(fin(tw?.unemployed))]);
      cells.push(['Vacancies', fmtNum(fin(tw?.vacancies))]);
      cells.push(['Treasury workers', fmtNum(stateworksCount(s, town))]);
      note = 'Treasury workers add their labour to Treasury building projects in this town; with none under way, they wait idle. They are paid from the Purse.';
      show(spark.el, false);
    } else if (kind === 'iou') {
      const m = s.iouMarket;
      setText(refTitle, 'IOUs · national');
      const p = fin(m?.price) > 0 ? m.price : IOU_PAR;
      cells.push(['Price', fmtPrice(p)]);
      cells.push(['Yield', fmtPct(IOU_COUPON / p)]);
      cells.push(['In public hands', fmtNum(fin(t.iouOutstanding))]);
      cells.push(['Owed a year', fmtM(fin(t.iouOutstanding) * IOU_COUPON)]);
      note = `Each IOU pays its holder ${fmtM(IOU_COUPON)} a year from the Purse, forever. Selling issues new ones; buying retires them.`;
      spark.set(m?.hist ?? []);
      show(spark.el, true);
    } else {
      const m = s.goldMarket;
      setText(refTitle, 'Gold · national');
      cells.push(['Price', fmtPrice(fin(m?.price)) + '/oz']);
      cells.push(['30-day avg', fmtPrice(mean30(m?.hist))]);
      cells.push(['Traded / day', fmtQ(fin(m?.volEma)) + ' oz']);
      cells.push(['You hold', fmtQ(fin(t.gold)) + ' oz']);
      note = 'The price of gold in ¤ is also the realm’s exchange rate with the outside world.';
      spark.set(m?.hist ?? []);
      show(spark.el, true);
    }
    for (let i = 0; i < 4; i++) {
      setText(cellL[i], cells[i]?.[0] ?? '');
      setText(cellV[i], cells[i]?.[1] ?? '');
    }
    setText(refNote, note);
    show(refNote, !!note);
  }

  function paint(): void {
    const s = last;
    if (!s) return;
    const t = s.treasury;
    const u = unitWords();
    setNumUnit(price, u.price);
    setNumUnit(qty, u.qty);
    total.setUnit(u.total);
    show(townSel.el, kind === 'good' || kind === 'labor');
    show(goodSel.el, kind === 'good');
    show(nationalNote, kind === 'iou' || kind === 'gold');
    show(sideSeg.el, kind !== 'labor');
    show(employNote, kind === 'labor');
    show(days.el, dur === 'days');
    setText(sideRow.lab, kind === 'labor' ? 'Order' : 'Side');
    setText(priceRow.lab, kind === 'labor' ? 'Daily wage' : side === 'buy' ? 'Pay at most' : 'Accept at least');
    // side labels for IOUs
    const btns = sideSeg.el.querySelectorAll('button');
    if (btns.length === 2) {
      setText(btns[0], kind === 'iou' ? 'Buy back' : 'Buy');
      setText(btns[1], kind === 'iou' ? 'Issue new' : 'Sell');
    }
    paintRef(s);

    const r = refPrice(s);
    const p = price.value;
    const rel = r > 0 && p > 0 ? p / r - 1 : NaN;
    setText(
      priceHint,
      !(r > 0)
        ? 'No market price yet.'
        : Number.isFinite(rel)
          ? `Market ${fmtPrice(r)}${u.price} · yours is ${Math.abs(rel) < 0.0005 ? 'at the market' : fmtPct(Math.abs(rel)) + (rel > 0 ? ' above' : ' below')}`
          : `Market ${fmtPrice(r)}${u.price}`,
    );

    // price mode: follow the market / any price (not for wages)
    const canFollow = kind !== 'labor';
    if (!canFollow && pmode !== 'fixed') {
      pmode = 'fixed';
      modeSeg.set('fixed');
    }
    show(modeRow.el, canFollow);
    show(priceRow.el, pmode === 'fixed');
    const going = goingPrice(s);
    const band = bandOf(pmode);
    const sign = side === 'buy' ? '+' : '−';
    const banded = canFollow && pmode !== 'fixed' && pmode !== 'any';
    show(paceRow.el, banded);
    const pb = paceSeg.el.querySelectorAll('button');
    if (pb.length === 2) {
      setText(pb[0], side === 'buy' ? 'As low as it can' : 'As high as it can');
      setText(pb[1], `Always ${sign}${Math.round(band * 100)}%`);
    }
    const patient = banded && pace === 'patient';
    setText(
      modeHint,
      pmode === 'fixed'
        ? 'Your limit stays where you set it.'
        : !(going > 0)
          ? 'This market has no going price yet to follow.'
          : pmode === 'any'
            ? side === 'buy'
              ? `No limit: keeps buying however high the price goes (going price ≈ ${fmtPrice(going)}${u.price}), as long as the Purse can pay.`
              : `No floor: takes whatever the market pays (going price ≈ ${fmtPrice(going)}${u.price}).`
            : patient
              ? side === 'buy'
                ? `Bids from the market’s going price (${fmtPrice(going)}${u.price}, without your orders) and steps up — to at most ${fmtPrice(going * (1 + band))} — only on days it falls short, back down on days it fills. You pay the day’s auction price, like every buyer.`
                : `Asks from the market’s going price (${fmtPrice(going)}${u.price}, without your orders) and steps down — to at least ${fmtPrice(going * (1 - band))} — only on days it does not sell out, back up on days it does. You receive the day’s auction price, like every seller.`
              : `Each morning the limit re-sets to the market’s going price (without your orders) ${sign}${Math.round(band * 100)}% — today ${fmtPrice(going * (side === 'buy' ? 1 + band : 1 - band))}${u.price}. You pay the day’s auction price; a large order pushes it towards the limit.`,
    );

    // quantity hint
    if (kind === 'good') {
      const have = fin(t.goods[town]?.[good]);
      setText(qtyHint, side === 'sell' ? `You hold ${fmtQ(have)} ${unitsOf(good)} in ${townName(s, town)}.` : `≈ ${fmtQ(fin(market(s)?.volEma))} ${unitsOf(good)} traded here a day.`);
    } else if (kind === 'labor') {
      const tw = s.towns[town];
      setText(qtyHint, `Jobless in ${townName(s, town)}: ${fmtNum(fin(tw?.unemployed))} · Treasury workers now: ${fmtNum(stateworksCount(s, town))}`);
    } else if (kind === 'iou') setText(qtyHint, side === 'buy' ? `In public hands: ${fmtNum(fin(t.iouOutstanding))}.` : 'New IOUs are created as they sell.');
    else setText(qtyHint, `The Treasury holds ${fmtQ(fin(t.gold))} oz.`);

    // preview (a following order is estimated at today's limit; 'any price' at the going price)
    const pEff = pmode === 'fixed' ? p : pmode === 'any' ? (side === 'buy' ? going : 0) : patient ? going : going * (side === 'buy' ? 1 + band : 1 - band);
    const q = qty.value;
    const n = dur === 'days' ? days.value : dur === 'once' ? 1 : NaN;
    const cap = total.value;
    const perDay = pEff * q;
    const bits: (string | Node)[] = [];
    const B = (x: string) => h('b', null, x);
    const span = dur === 'once' ? ', today only' : dur === 'days' && n > 0 ? `, for ${plural(n, 'day')}` : ', until cancelled';
    if (pmode !== 'fixed' && !(going > 0)) bits.push('No going price to follow yet — choose Fixed.');
    else if (pmode === 'fixed' && !(p > 0) && !(kind !== 'labor' && side === 'sell' && p === 0)) bits.push('Set a price limit.');
    else if (!(q > 0)) bits.push('Set a quantity per day.');
    else if (kind === 'labor') {
      bits.push('Up to ', B(fmtM(perDay)), ' a day in wages for ', B(plural(Math.round(q), 'worker')), ' in ', townName(s, town), span, '. Paid from the Purse.');
    } else if (kind === 'good' && side === 'buy') {
      bits.push(pmode === 'any' ? 'About ' : 'Up to ', B(fmtM(perDay)), ' a day from the Purse at today’s prices', span, pmode === 'any' ? ' — more if the price climbs.' : '.');
    } else if (kind === 'good') {
      const have = fin(t.goods[town]?.[good]);
      bits.push('Sells from your holdings in ', townName(s, town), ': ', B(`${fmtQ(have)} available`), have > 0 ? `, raising at least ${fmtM(perDay)} a day if all ${q === 1 ? 'of it sells' : 'sell'}` : ' — buy some there or move goods in first', '.');
    } else if (kind === 'iou' && side === 'sell') {
      bits.push('Issues up to ', B(plural(q, 'new IOU')), ' a day, each paying ', B(fmtM(IOU_COUPON) + ' a year'), ' forever: raises at least ', B(fmtM(perDay)), ' a day if all sell, and adds up to ', B(fmtM(q * IOU_COUPON)), ' a year to what the Purse pays out.');
    } else if (kind === 'iou') {
      bits.push('Buys back up to ', B(plural(q, 'IOU')), ' a day for at most ', B(fmtM(perDay)), span, '. Each one retired saves ', fmtM(IOU_COUPON), ' a year.');
    } else if (side === 'buy') {
      bits.push('Up to ', B(fmtM(perDay)), ' a day from the Purse for gold', span, '.');
    } else {
      bits.push('Sells from the Treasury’s gold: ', B(fmtQ(fin(t.gold)) + ' oz available'), '.');
    }
    if (cap > 0 && q > 0) bits.push(' Stops after ', B(`${fmtQ(cap)} ${u.total}`), ' in all.');
    const buying = kind === 'labor' || side === 'buy';
    if (buying && pEff > 0 && q > 0 && !t.autoMint && fin(t.purse) < perDay) {
      bits.push(h('span', { class: 'warn' }, ` The Purse holds ${fmtM(fin(t.purse))}, so purchases are capped by what it can pay.`));
    }
    preview.replaceChildren(...bits);
    const okPrice = pmode !== 'fixed' ? going > 0 : kind !== 'labor' && side === 'sell' ? p >= 0 : p > 0;
    place.disabled = !(okPrice && q > 0 && (dur !== 'days' || n > 0) && !total.error);
    setText(place, kind === 'labor' ? 'Hire' : kind === 'iou' && side === 'sell' ? 'Issue' : 'Place order');
  }

  function submit(): void {
    if (!last || kind === 'route') return;
    const p = pmode === 'fixed' ? price.value : 0;
    const q = qty.value;
    if (pmode === 'fixed' && !Number.isFinite(p)) return msg.err(price.error ?? 'Set a price limit.');
    if (!(q > 0)) return msg.err(qty.error ?? 'Set a quantity per day.');
    if (total.error) return msg.err(total.error);
    const m: OrderMarket = kind === 'good' ? { kind: 'good', town, good } : kind === 'labor' ? { kind: 'labor', town } : { kind: kind === 'iou' ? 'iou' : 'gold' };
    const qq = kind === 'labor' ? Math.min(PLAYER_MAX_WORKERS, Math.max(1, Math.round(q))) : q;
    run(
      {
        type: 'placeOrder',
        market: m,
        side: kind === 'labor' ? 'buy' : side,
        price: p,
        qty: qq,
        total: total.value > 0 ? total.value : undefined,
        days: dur === 'days' ? Math.max(1, Math.round(days.value)) : undefined,
        once: dur === 'once',
        priceMode: kind === 'labor' || pmode === 'fixed' ? 'fixed' : pmode === 'any' ? 'any' : 'follow',
        band: pmode === 'fixed' || pmode === 'any' ? undefined : bandOf(pmode),
        pace: kind === 'labor' || pmode === 'fixed' || pmode === 'any' ? undefined : pace,
      },
      msg,
      '✓ Order placed — it is listed under In force.',
    );
  }

  // ---- stores, wagons & move ---------------------------------------------------------
  function paintStores(s: SimState): void {
    const t = s.treasury;
    flows.update(s);
    const goldV = fin(t.gold) * fin(s.goldMarket?.price);
    goldLine.replaceChildren(h('span', { class: 'lv-hold-k' }, 'Gold'), h('span', { class: 'lv-hold-v' }, `${fmtQ(fin(t.gold))} oz`), h('span', { class: 'muted' }, goldV > 0 ? ` ≈ ${fmtM(goldV)}` : ''));
    const owed = fin(t.iouOutstanding);
    iouLine.replaceChildren(
      h('span', { class: 'lv-hold-k' }, 'IOUs in public hands'),
      h('span', { class: 'lv-hold-v' }, fmtNum(owed)),
      h('span', { class: 'muted' }, owed > 0 ? ` · the Purse pays ${fmtM(owed * IOU_COUPON)} a year` : ''),
    );
    let any = false;
    for (let k = 0; k < s.towns.length && !any; k++) for (let g = 0; g < N_GOODS; g++) if (fin(t.goods[k]?.[g]) > 0.005) any = true;
    show(moveBox, any);
  }

  function followStores(what: 'from' | 'good' | 'auto'): void {
    const s = last;
    if (!s) return;
    const tg = s.treasury.goods;
    const held = (t: number, g: number) => fin(tg[t]?.[g]);
    if (held(mvFrom.value, mvGood.value) > 0.005) return;
    let bt = -1;
    let bg = -1;
    let bq = 0.005;
    for (let t = 0; t < s.towns.length; t++)
      for (let g = 0; g < N_GOODS; g++) {
        if (what === 'good' && g !== mvGood.value) continue;
        if (what === 'from' && t !== mvFrom.value) continue;
        const q = held(t, g);
        if (q > bq) {
          bq = q;
          bt = t;
          bg = g;
        }
      }
    if (bt < 0) return;
    mvFrom.set(bt);
    mvGood.set(bg);
    if (mvTo.value === bt && s.towns.length > 1) mvTo.set((bt + 1) % s.towns.length);
  }

  function paintMove(): void {
    const s = last;
    if (!s) return;
    const from = mvFrom.value;
    const to = mvTo.value;
    const g = mvGood.value;
    setNumUnit(mvQty, unitsOf(g));
    setNumUnit(mvPrice, '/' + unitOf(g));
    show(mvPrice.el, then === 'fixed');
    show(mvMargin.el, then === 'cost');
    const pk = `${to}:${g}`;
    if (pk !== mvPriceFor) {
      mvPriceFor = pk;
      const r = priceIn(s, to, g);
      mvPrice.set(r > 0 ? niceRound(r) : NaN);
    }
    const refTo = priceIn(s, to, g);
    setText(
      mvThenHint,
      then === 'hold'
        ? `On arrival they join the Treasury’s stores in ${townName(s, to)}.`
        : then === 'fixed'
          ? `Offered in ${townName(s, to)} until sold${refTo > 0 ? ` (${fmtPrice(refTo)} there today)` : ''}.`
          : then === 'cost'
            ? `Offered in ${townName(s, to)} for no less than what they are worth in ${townName(s, from)} plus freight, plus the margin.`
            : `Offered in ${townName(s, to)}’s auction for whatever they fetch.`,
    );
    const have = fin(s.treasury.goods[from]?.[g]);
    const q = Math.min(fin(mvQty.value), have);
    const B = (x: string) => h('b', null, x);
    if (from === to) {
      mvPreview.replaceChildren('Choose two different towns.');
      mvBtn.disabled = true;
      return;
    }
    if (!(have > 0.005)) {
      mvPreview.replaceChildren(`The Treasury holds no ${goodName(g).toLowerCase()} in ${townName(s, from)}.`);
      mvBtn.disabled = true;
      return;
    }
    const fpu = safe(() => freightPerUnit(s, from, to), -1);
    if (!(fpu >= 0)) {
      mvPreview.replaceChildren(`No wagon road links ${townName(s, from)} and ${townName(s, to)}.`);
      mvBtn.disabled = true;
      return;
    }
    if (!(q > 0)) {
      mvPreview.replaceChildren(`${fmtQ(have)} ${unitsOf(g)} held in ${townName(s, from)}. Set a quantity.`);
      mvBtn.disabled = true;
      return;
    }
    const wagons = Math.max(1, Math.ceil(q / WAGON_CAPACITY - 1e-9));
    const fee = fpu * WAGON_CAPACITY * wagons * (1 + TREASURY_FREIGHT_PREMIUM);
    const dd = safe(() => routeBetweenTowns(s, from, to).days, NaN);
    mvPreview.replaceChildren(
      'Freight ≈ ',
      B(fmtM(fee)),
      ` for ${plural(wagons, 'wagon')}`,
      Number.isFinite(dd) && dd > 0 ? ` · about ${fmtNum(Math.max(0.5, dd))} days on the road` : '',
      '. ',
      h('span', { class: 'faint' }, `${fmtQ(have)} held.`),
    );
    mvBtn.disabled = (then === 'fixed' && !(mvPrice.value > 0)) || (then === 'cost' && (!Number.isFinite(mvMargin.value) || !!mvMargin.error));
    setText(mvBtn, then === 'hold' ? 'Move goods' : 'Move & offer');
  }

  function doMove(): void {
    if (!last) return;
    const q = mvQty.value;
    if (!(q > 0)) return moveMsg.err(mvQty.error ?? 'Set a quantity.');
    if (then === 'cost' && (!Number.isFinite(mvMargin.value) || mvMargin.error)) return moveMsg.err(mvMargin.error ?? 'Set a margin (0 for at cost).');
    let sell: { mode: SellMode; price?: number; margin?: number } | undefined;
    if (then === 'fixed') {
      if (!(mvPrice.value > 0)) return moveMsg.err(mvPrice.error ?? 'Set the lowest price to ask (above zero).');
      sell = { mode: 'fixed', price: mvPrice.value };
    } else if (then === 'cost') {
      sell = { mode: 'cost', margin: mvMargin.value };
    } else if (then === 'market') sell = { mode: 'market' };
    run({ type: 'moveGoods', from: mvFrom.value, to: mvTo.value, good: mvGood.value, qty: q, sell }, moveMsg, sell ? '✓ On its way — it will be offered on arrival.' : '✓ On its way.');
  }

  function applyUiMarket(s: SimState): void {
    const k = `${ui.marketTown}:${ui.marketGood}`;
    if (k === uiMarketApplied) return;
    uiMarketApplied = k;
    if (ui.marketTown >= 0 && ui.marketTown < s.towns.length && ui.marketGood >= 0 && ui.marketGood < N_GOODS) {
      if (kind === 'route') {
        routes.seed(s, ui.marketTown, ui.marketGood);
        town = ui.marketTown;
        good = ui.marketGood;
        return;
      }
      kind = 'good';
      town = ui.marketTown;
      good = ui.marketGood;
      marketChanged();
    }
  }

  return {
    id: 'trade',
    title: 'Trade',
    tagline: 'Goods, labour, IOUs and gold',
    body,
    summary(s) {
      const on = s.policy.orders.filter((o) => o.enabled);
      const nr = on.filter((o) => !!o.route).length;
      const n = on.length - nr;
      if (!on.length) return { text: 'No orders' };
      return { text: [n ? plural(n, 'order') : '', nr ? plural(nr, 'route') : ''].filter(Boolean).join(' · ') };
    },
    update(s) {
      const fresh = last !== s;
      last = s;
      townSel.setOptions(townOptions(s), town);
      town = townSel.value;
      mvFrom.setOptions(townOptions(s));
      mvTo.setOptions(townOptions(s));
      if (fresh) {
        if (mvTo.value === mvFrom.value && s.towns.length > 1) mvTo.set((mvFrom.value + 1) % s.towns.length);
        applyUiMarket(s);
      }
      if (kind === 'route') routes.update(s);
      else {
        syncDefaults(s);
        paint();
      }
      paintStores(s);
      if (!mvTouched) followStores('auto');
      paintMove();
    },
    tabShown(s) {
      last = s;
      applyUiMarket(s);
    },
    prefill(req: PrefillRequest, s) {
      if (req.lever !== 'trade') return false;
      last = s;
      const m = req.market;
      kind = m.kind;
      if (m.kind === 'good') {
        town = m.town;
        good = m.good;
      } else if (m.kind === 'labor') town = m.town;
      side = kind === 'labor' ? 'buy' : (req.side ?? side);
      kindSeg.set(kind);
      showMode();
      townSel.setOptions(townOptions(s), town);
      goodSel.set(good);
      sideSeg.set(side);
      priceFor = '';
      syncDefaults(s, req.price);
      paint();
      return true;
    },
    focus: () => (kind === 'route' ? routes.focus() : price.focus()),
    reset() {
      priceFor = '';
      mvPriceFor = '';
      mvTouched = false;
      uiMarketApplied = '';
      last = null;
      routes.reset();
    },
  };
}

