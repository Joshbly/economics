// ============================================================================
// Markets panel — one market in depth.
//
//   header      good & town selectors (town "Whole realm" for a realm-wide view;
//               IOUs and gold are national), a status line of chips, actions
//   tiles       price · buyers pay · sellers get · 30-day change · traded ·
//               demand unmet · left unsold · best bid/ask (instrument-specific
//               sets for IOUs and gold)
//   history     daily base price + the realm's weighted price, volume bars
//   auction     today's demand & supply (curveChart) with a plain reading
//   the realm   the same good's price in every town, with the cost of carting
//   holders     who holds the stock here
//   rules       levies, limits and Treasury orders that touch this market
// Everything is recomputed only when the day, the market or the view changes.
// ============================================================================
import { DAYS_PER_YEAR, IOU_COUPON } from '../../../sim/config';
import { GOODS, N_GOODS } from '../../../sim/goods';
import { freightPerUnit } from '../../../sim/agents/traders';
import { describeLimit, describeOrder, levyShortLabel } from '../../../sim/policy/player';
import type { CurveSnapshot, Levy, Limit, MarketState, PlayerOrder, SimState } from '../../../sim/types';
import { h, replace, setText, toggleClass } from '../../dom';
import { DASH, fmtMoney, fmtMoneyShort, fmtNum, fmtPct, fmtPctSigned, fmtPrice, fmtQty, pluralize } from '../../format';
import { centerMap, prefill, setOverlay, setTab } from '../../uiState';
import {
  barChart,
  button,
  curveChart,
  demandAt,
  goodColor,
  grossOf,
  hasWedge,
  icon,
  kpi,
  kpiGrid,
  lineChart,
  netOf,
  segmented,
  selectInput,
  SERIES,
  supplyAt,
  T,
  type Kpi,
  type Option,
} from '../../widgets';
import {
  badgeOf,
  fin,
  GOLD_GOOD,
  goodLabel,
  holdersOf,
  iouYield,
  IOU_GOOD,
  isGood,
  isInstrument,
  marketAt,
  meanLast,
  nationalGood,
  relChange,
  unitOf,
} from './data';
import { pvChart } from './pvchart';

export interface Detail {
  el: HTMLElement;
  update(s: SimState, town: number, good: number, force: boolean): void;
}

export interface DetailHooks {
  back(): void;
  pick(town: number, good: number): void;
}

type Mode = 'town' | 'realm' | 'iou' | 'gold';

const WINDOWS = [
  { value: 90, label: '3M' },
  { value: 180, label: '6M' },
  { value: 360, label: '1Y' },
];

/** Realm price series: the stats series price_<g> where it exists, the volume-weighted market history before it. */
function realmSeries(s: SimState, g: number): { data: number[]; x0: number } {
  const n = nationalGood(s, g);
  const x0c = s.day - n.hist.length;
  const st = s.stats?.daily?.['price_' + g];
  const x0s = fin(s.stats?.dailyStart, s.day);
  const x0 = Math.min(x0c, st && st.length ? x0s : x0c);
  const x1 = s.day - 1;
  const out: number[] = [];
  for (let d = x0; d <= x1; d++) {
    const k = d - x0s;
    const sv = st && k >= 0 && k < st.length ? st[k] : NaN;
    if (Number.isFinite(sv) && sv > 0) out.push(sv);
    else {
      const j = d - x0c;
      out.push(j >= 0 && j < n.hist.length ? n.hist[j] : NaN);
    }
  }
  return { data: out, x0 };
}

function safeFreight(s: SimState, a: number, b: number): number {
  if (a === b) return 0;
  try {
    const f = freightPerUnit(s, a, b);
    return Number.isFinite(f) && f >= 0 ? f : NaN;
  } catch {
    return NaN;
  }
}

export function createDetail(hooks: DetailHooks): Detail {
  let state: SimState | null = null;
  let town = 0;
  let good = 8;
  let mode: Mode = 'town';
  let win = 90;
  let sig = '';
  let lastS: SimState | null = null;
  let lastGoodTown = 0;

  // ---- header -----------------------------------------------------------------
  const goodSel = selectInput<number>({
    options: goodOptionsAll(),
    value: good,
    width: '100%',
    title: 'Which market',
    onChange: (g) => {
      const nextTown = isInstrument(g) ? -1 : isInstrument(good) ? lastGoodTown : town;
      hooks.pick(nextTown, g);
    },
  });
  const townSel = selectInput<number>({
    options: [],
    value: town,
    width: '100%',
    title: 'Which town',
    onChange: (t) => hooks.pick(t, good),
  });
  const back = button({ label: 'All markets', kind: 'ghost', size: 'sm', icon: chevronLeft(), onClick: () => hooks.back(), title: 'Back to the overview of every market' });
  const nav = h('div', { class: 'mk-dnav' }, back, h('div', { class: 'mk-dnav-sel' }, goodSel.el, townSel.el));

  const titleDot = h('span', { class: 'mk-title-dot' });
  const titleName = h('span', { class: 'mk-title-name' });
  const titleWhere = h('span', { class: 'mk-title-where' });
  const chips = h('div', { class: 'mk-chips' });
  const title = h('div', { class: 'mk-title' }, h('div', { class: 'mk-title-row' }, titleDot, titleName, titleWhere), chips);

  const btnTrade = button({ label: 'Trade here', kind: 'primary', size: 'sm', onClick: () => doTrade(), title: 'Post a Treasury buy or sell order in this market' });
  const btnLevy = button({ label: 'Levy here', size: 'sm', onClick: () => doLevy(), title: 'Attach a levy (or a payment) to sales of this good here' });
  const btnLimit = button({ label: 'Limit here', size: 'sm', onClick: () => doLimit(), title: 'Set a legal maximum (or minimum) price for this good here' });
  const btnMap = button({ label: 'Show on map', kind: 'ghost', size: 'sm', onClick: () => doMap(), title: 'Colour the map by this good’s price in each town' });
  const actions = h('div', { class: 'mk-actions' }, btnTrade, btnLevy, btnLimit, btnMap);

  // ---- tiles (one set per mode) ----------------------------------------------------
  const px = (v: number) => fmtPrice(v);
  const qty = (v: number) => fmtQty(Math.abs(v) < 0.005 ? 0 : v);
  const tiles = {
    town: {
      price: kpi({ label: 'Price', size: 'sm', format: px, deltaFormat: fmtPctSigned, hint: 'The base price the auction cleared at today, before any levy. The small change is against yesterday.' }),
      gross: kpi({ label: 'Buyers pay', size: 'sm', format: px, hint: 'What buyers paid per unit, including levies charged to buyers (or less any payment the Treasury makes to them).' }),
      net: kpi({ label: 'Sellers get', size: 'sm', format: px, hint: 'What sellers kept per unit, after levies charged to sellers (or plus any payment the Treasury makes to them).' }),
      ch: kpi({ label: '30 days', size: 'sm', format: (v) => fmtPctSigned(v), hint: 'How far the base price has moved over the last 30 days.' }),
      vol: kpi({ label: 'Traded', size: 'sm', format: qty, hint: 'Units that changed hands in today’s auction (and the 30-day average).' }),
      short: kpi({ label: 'Unmet', size: 'sm', format: qty, good: 'down', hint: 'Units buyers bid for at the clearing price but could not get — rationed away by a legal maximum, or bids at the clearing price that were only partly filled.' }),
      surplus: kpi({ label: 'Unsold', size: 'sm', format: qty, good: 'down', hint: 'Units sellers offered at the clearing price that found no buyer.' }),
      bid: kpi({ label: 'Best bid', size: 'sm', format: px, hint: 'The highest price any buyer offered today, and the lowest any seller asked. When the bid is below the ask, nothing trades.' }),
    },
    realm: {
      price: kpi({ label: 'Realm price', size: 'sm', format: px, deltaFormat: fmtPctSigned, hint: 'Base price averaged over the towns, weighted by how much each one trades.' }),
      gross: kpi({ label: 'Buyers pay', size: 'sm', format: px, hint: 'Weighted average of what buyers paid per unit, levies included.' }),
      net: kpi({ label: 'Sellers get', size: 'sm', format: px, hint: 'Weighted average of what sellers kept per unit.' }),
      ch: kpi({ label: '30 days', size: 'sm', format: (v) => fmtPctSigned(v), hint: 'How far the weighted price has moved in 30 days.' }),
      vol: kpi({ label: 'Traded', size: 'sm', format: qty, hint: 'Units traded today in every town together (and the 30-day average).' }),
      short: kpi({ label: 'Unmet', size: 'sm', format: qty, good: 'down', hint: 'Demand rationed away in every town together.' }),
      surplus: kpi({ label: 'Unsold', size: 'sm', format: qty, good: 'down', hint: 'Supply left unsold in every town together.' }),
      made: kpi({ label: 'Made today', size: 'sm', format: qty, hint: 'Units produced in the whole realm today.' }),
    },
    iou: {
      price: kpi({ label: 'Price', size: 'sm', format: px, deltaFormat: fmtPctSigned, hint: 'What one IOU fetched today. The change is against yesterday.' }),
      yld: kpi({ label: 'Yield', size: 'sm', format: (v) => fmtPct(v, 2), hint: 'The ¤5 a year an IOU pays, as a share of its price. A buyer at this price earns this much a year.' }),
      ch: kpi({ label: '30 days', size: 'sm', format: (v) => fmtPctSigned(v), hint: 'How far the IOU price has moved in 30 days.' }),
      vol: kpi({ label: 'Traded', size: 'sm', format: qty, hint: 'IOUs that changed hands today (and the 30-day average).' }),
      out: kpi({ label: 'Outstanding', size: 'sm', format: (v) => fmtNum(v), hint: 'IOUs held by the Bank and by people. Selling IOUs adds to this; buying them back retires them.' }),
      bank: kpi({ label: 'Bank holds', size: 'sm', format: (v) => fmtNum(v), hint: 'IOUs on the Bank’s books.' }),
      people: kpi({ label: 'People hold', size: 'sm', format: (v) => fmtNum(v), hint: 'IOUs held by households as savings.' }),
      owed: kpi({ label: 'Owed a year', size: 'sm', format: fmtMoneyShort, hint: 'What the Treasury pays holders each year: ¤5 per IOU outstanding.' }),
    },
    gold: {
      price: kpi({ label: 'Price /oz', size: 'sm', format: px, deltaFormat: fmtPctSigned, hint: 'What an ounce of gold fetched today. Foreign ships price everything in gold, so this is also the exchange rate. The change is against yesterday.' }),
      ch: kpi({ label: '30 days', size: 'sm', format: (v) => fmtPctSigned(v), hint: 'How far the gold price has moved in 30 days.' }),
      vol: kpi({ label: 'Traded', size: 'sm', format: qty, hint: 'Ounces that changed hands today (and the 30-day average).' }),
      dealer: kpi({ label: 'Dealer value', size: 'sm', format: px, hint: 'What foreign dealers think an ounce is worth: they buy below it and sell above it. It drifts toward the price at which ¤ would buy as much abroad as at home.' }),
      state: kpi({ label: 'Treasury', size: 'sm', format: (v) => fmtNum(v) + ' oz', hint: 'The Treasury’s own gold.' }),
      stateVal: kpi({ label: 'Worth', size: 'sm', format: fmtMoneyShort, hint: 'The Treasury’s gold at today’s price.' }),
      people: kpi({ label: 'People hold', size: 'sm', format: (v) => fmtNum(v) + ' oz', hint: 'Gold hoarded by households.' }),
      bid: kpi({ label: 'Best bid', size: 'sm', format: px, hint: 'The highest bid and the lowest ask for gold today.' }),
    },
  };
  const tileSets: Record<Mode, HTMLElement> = {
    town: kpiGrid(Object.values(tiles.town), 4),
    realm: kpiGrid(Object.values(tiles.realm), 4),
    iou: kpiGrid(Object.values(tiles.iou), 4),
    gold: kpiGrid(Object.values(tiles.gold), 4),
  };
  const tileWrap = h('div', { class: 'mk-kpis' }, Object.values(tileSets));

  // ---- history -------------------------------------------------------------------------
  const winCtl = segmented<number>({ options: WINDOWS, value: win, size: 'sm', onChange: (v) => {
    win = v;
    sig = '';
    if (state) update(state, town, good, true);
  } });
  const pv = pvChart({ height: 210 });
  const realmLines = lineChart({ height: 200, format: fmtPrice, tickFormat: (v) => '¤' + (Math.abs(v) >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 0 : 1)), label: 'Price of this good in every town' });
  const histSub = h('div', { class: 'card-sub' });
  const histCard = card('Price history', histSub, winCtl.el, pv.el, realmLines.el);

  // ---- auction ------------------------------------------------------------------------
  const reading = h('div', { class: 'mk-reading' });
  const curve = curveChart({ height: 240 });
  const auctionNote = h('p', { class: 'note mk-auction-note' });
  const auctionSub = h('div', { class: 'card-sub' });
  const auctionCard = card('Today’s auction', auctionSub, null, reading, curve.el, auctionNote);

  // ---- across the realm ------------------------------------------------------------------
  const townBars = barChart({ format: fmtPrice, rowHeight: 26, labelWidth: 150, onClick: (row) => hooks.pick(Number(row.key), good) });
  const freightNote = h('p', { class: 'note mk-freight' });
  const realmCard = card('In every town', h('div', { class: 'card-sub' }, 'base price today · click a town'), null, townBars.el, freightNote);

  // ---- holders --------------------------------------------------------------------------------
  const holdBars = barChart({ format: fmtQty, rowHeight: 24 });
  const holdSub = h('div', { class: 'card-sub' });
  const holdNote = h('p', { class: 'note mk-hold-note' });
  const holdCard = card('Who holds it', holdSub, null, holdBars.el, holdNote);

  // ---- rules -------------------------------------------------------------------------------------
  const rulesList = h('div', { class: 'mk-rules' });
  const rulesCard = card('Your rules and orders here', h('button', { class: 'mk-link', type: 'button', onClick: () => setTab('levers') }, 'Manage in Levers'), null, rulesList);

  const instrNote = h('div', { class: 'mk-instr' });

  const el = h('div', { class: 'mk-detail' }, nav, title, actions, tileWrap, instrNote, histCard, auctionCard, realmCard, holdCard, rulesCard);

  // ---- actions ------------------------------------------------------------------------------------
  function doTrade(): void {
    const s = state;
    if (!s) return;
    if (good === IOU_GOOD) prefill({ lever: 'trade', market: { kind: 'iou' }, price: posOr(s.iouMarket?.price) });
    else if (good === GOLD_GOOD) prefill({ lever: 'trade', market: { kind: 'gold' }, price: posOr(s.goldMarket?.price) });
    else if (town >= 0) prefill({ lever: 'trade', market: { kind: 'good', town, good }, price: posOr(marketAt(s, town, good)?.price) });
  }
  function doLevy(): void {
    if (isGood(good)) prefill({ lever: 'levy', base: 'sale', good, town });
  }
  function doLimit(): void {
    if (isGood(good)) prefill({ lever: 'limit', kind: 'priceMax', good, town });
    else if (isInstrument(good)) prefill({ lever: 'limit', kind: 'priceMax', good, town: -1 });
  }
  function doMap(): void {
    const s = state;
    if (!s || !isGood(good)) return;
    setOverlay('price', good);
    const t = town >= 0 ? s.towns[town] : null;
    if (t) centerMap(t.x, t.y);
  }

  // ---- update -----------------------------------------------------------------------------------------
  function update(s: SimState, t: number, g: number, force: boolean): void {
    state = s;
    if (!isGood(g) && !isInstrument(g)) g = 8;
    if (isInstrument(g)) t = -1;
    else if (t >= s.towns.length) t = 0;
    town = t;
    good = g;
    if (isGood(g) && t >= 0) lastGoodTown = t;
    mode = g === IOU_GOOD ? 'iou' : g === GOLD_GOOD ? 'gold' : t < 0 ? 'realm' : 'town';
    const nsig = `${s.day}|${t}|${g}|${win}|${s.towns.length}|${s.policy?.levies?.length}|${s.policy?.limits?.length}|${s.policy?.orders?.length}`;
    if (!force && nsig === sig && lastS === s) return;
    sig = nsig;
    lastS = s;

    paintHeader(s);
    for (const k of Object.keys(tileSets) as Mode[]) tileSets[k].hidden = k !== mode;
    const m = marketAt(s, t, g);
    if (mode === 'town' && m) paintTownTiles(s, m);
    else if (mode === 'realm') paintRealmTiles(s);
    else if (mode === 'iou' && m) paintIouTiles(s, m);
    else if (mode === 'gold' && m) paintGoldTiles(s, m);
    paintHistory(s, m);
    paintAuction(s, m);
    paintRealm(s);
    paintHolders(s);
    paintRules(s);
    paintInstrument(s, m);
  }

  function paintHeader(s: SimState): void {
    goodSel.set(good);
    const tOpts: Option<number>[] = isInstrument(good)
      ? [{ value: -1, label: 'National market' }]
      : [...s.towns.map((x) => ({ value: x.id, label: x.name })), { value: -1, label: 'Whole realm' }];
    townSel.setOptions(tOpts, town);
    townSel.set(town);
    townSel.setDisabled(isInstrument(good));
    const col = isGood(good) ? goodColor(good) : good === GOLD_GOOD ? T.goldHi : '#b9c4d0';
    titleDot.style.background = col;
    toggleClass(titleDot, 'mk-dot-iou', good === IOU_GOOD);
    setText(titleName, goodLabel(good));
    setText(titleWhere, mode === 'town' ? 'in ' + (s.towns[town]?.name ?? '') : mode === 'realm' ? 'across the realm' : 'national market');

    const m = marketAt(s, town, good);
    const list: HTMLElement[] = [];
    const chip = (text: string, tone?: string, tip?: string) => h('span', { class: 'chip' + (tone ? ' ' + tone : ''), title: tip ?? null }, text);
    if (mode === 'realm') {
      const n = nationalGood(s, good);
      const b = badgeOf(n.volume, n.shortage, n.surplus);
      if (b === 'shortage') list.push(chip('Buyers went short', 'warn'));
      if (b === 'surplus') list.push(chip('Unsold stock'));
      list.push(chip(`${s.towns.length} town auctions`));
    } else if (m) {
      if (!m.traded) list.push(chip('No trade today', undefined, 'Bids and asks did not meet today; the price shown is indicative.'));
      const b = badgeOf(m.volume, m.shortage, m.surplus);
      if (b === 'shortage') list.push(chip('Buyers went short', 'warn', `${fmtQty(m.shortage)} units of demand went unmet today.`));
      if (b === 'surplus') list.push(chip('Unsold stock', undefined, `${fmtQty(m.surplus)} units offered found no buyer today.`));
      const c = m.curve;
      if (c && c.ceiling > 0) list.push(chip('Max price ' + fmtPrice(c.ceiling), 'warn', 'A legal maximum price applies here today: a fixed limit, or as far as the price may rise from yesterday’s.'));
      if (c && c.floor > 0) list.push(chip('Min price ' + fmtPrice(c.floor), 'warn', 'A legal minimum price applies here today: a fixed limit, or as far as the price may fall from yesterday’s.'));
      if (c && hasWedge(c)) list.push(chip('Levy wedge', 'gold', 'Buyers pay and sellers keep different amounts because of a levy (or payment).'));
      if (c && c.state.length) list.push(chip('Treasury order', 'gold', 'The Treasury has an order in this market today.'));
      if (mode === 'town' && s.towns[town]?.hasPort && GOODS[good]?.tradable) list.push(chip('Foreign ships trade here', undefined, 'The port lets foreign ships buy and sell this good here at world prices.'));
    }
    replace(chips, list);

    const inst = isInstrument(good);
    btnTrade.disabled = mode === 'realm';
    btnTrade.title = mode === 'realm' ? 'Pick a town to trade in' : inst ? (good === IOU_GOOD ? 'Sell new IOUs or buy them back' : 'Buy or sell gold') : 'Post a Treasury buy or sell order in this market';
    btnLevy.disabled = inst;
    btnLimit.disabled = false;
    btnMap.disabled = inst;
    btnLevy.title = inst ? 'Levies attach to flows of goods, wages, rent… — not to this market' : 'Attach a levy (or a payment) to sales of this good' + (town >= 0 ? ' here' : ' in every town');
    btnLimit.title = inst
      ? `Set a legal maximum or minimum ${good === IOU_GOOD ? 'price of IOUs' : 'gold price'}, or how far it may move in a day`
      : 'Set a legal maximum (or minimum) price for this good, or how far it may move in a day' + (town >= 0 ? ' here' : ' in every town');
  }

  function dayChange(hist: ArrayLike<number> | undefined): number {
    return relChange(hist, 1);
  }

  function paintTownTiles(s: SimState, m: MarketState): void {
    const T0 = tiles.town;
    const unit = unitOf(good);
    T0.price.set(m.price, { delta: dayChange(m.hist), deltaLabel: 'day', sub: m.traded ? undefined : 'indicative' });
    T0.gross.set(fin(m.gross, m.price), { sub: wedgeSub(m.gross, m.price) });
    T0.net.set(fin(m.net, m.price), { sub: wedgeSub(m.net, m.price) });
    const ch = relChange(m.hist, 30);
    const h30 = m.hist?.length ? m.hist[Math.max(0, m.hist.length - 31)] : NaN;
    T0.ch.set(ch, { sub: Number.isFinite(h30) ? 'from ' + fmtPrice(h30) : undefined, tone: null });
    T0.vol.set(m.volume, { sub: `avg ${fmtQty(meanLast(m.volHist, 30))}` });
    T0.short.set(m.shortage, { tone: badgeOf(m.volume, m.shortage, 0) === 'shortage' ? 'warn' : null, sub: shareOf(m.shortage, m.volume + m.shortage, 'of bids') });
    T0.surplus.set(m.surplus, { sub: shareOf(m.surplus, m.volume + m.surplus, 'of asks') });
    T0.bid.set(m.bestBid > 0 ? m.bestBid : NaN, { sub: m.bestAsk > 0 ? 'ask ' + fmtPrice(m.bestAsk) : 'no asks' });
  }

  function paintRealmTiles(s: SimState): void {
    const R = tiles.realm;
    const n = nationalGood(s, good);
    R.price.set(n.price, { delta: dayChange(n.hist), deltaLabel: 'day' });
    R.gross.set(n.gross, { sub: wedgeSub(n.gross, n.price) });
    R.net.set(n.net, { sub: wedgeSub(n.net, n.price) });
    R.ch.set(relChange(n.hist, 30));
    R.vol.set(n.volume, { sub: `avg ${fmtQty(meanLast(n.volHist, 30))}` });
    R.short.set(n.shortage, { tone: badgeOf(n.volume, n.shortage, 0) === 'shortage' ? 'warn' : null, sub: shareOf(n.shortage, n.volume + n.shortage, 'of bids') });
    R.surplus.set(n.surplus, { sub: shareOf(n.surplus, n.volume + n.surplus, 'of asks') });
    const made = fin(s.stats?.latest?.['prod_' + good], NaN);
    const imp = fin(s.stats?.latest?.['imp_' + good]);
    R.made.set(made, { sub: imp > 0.05 ? `+${fmtQty(imp)} by sea` : `avg ${fmtQty(meanLast(s.stats?.daily?.['prod_' + good], 30))}` });
  }

  function paintIouTiles(s: SimState, m: MarketState): void {
    const I = tiles.iou;
    const out = fin(s.treasury?.iouOutstanding);
    let people = 0;
    for (const p of s.people ?? []) if (p && p.alive) people += Math.max(0, fin(p.iou));
    I.price.set(m.price, { delta: dayChange(m.hist), deltaLabel: 'day', sub: m.traded ? undefined : 'indicative' });
    I.yld.set(iouYield(m.price), { sub: `deposit ${fmtPct(s.bank?.depositRate, 1)}` });
    I.ch.set(relChange(m.hist, 30));
    I.vol.set(m.volume, { sub: `avg ${fmtQty(meanLast(m.volHist, 30))}` });
    I.out.set(out, { sub: out > 0 ? 'worth ' + fmtMoneyShort(out * m.price) : 'none issued' });
    I.bank.set(fin(s.bank?.iou), { sub: 'book ' + fmtMoneyShort(s.bank?.iouBook) });
    I.people.set(people);
    I.owed.set(IOU_COUPON * out, { sub: fmtMoneyShort((IOU_COUPON * out) / DAYS_PER_YEAR) + ' a day' });
  }

  function paintGoldTiles(s: SimState, m: MarketState): void {
    const G0 = tiles.gold;
    let people = 0;
    for (const p of s.people ?? []) if (p && p.alive) people += Math.max(0, fin(p.gold));
    const gold = fin(s.treasury?.gold);
    G0.price.set(m.price, { delta: dayChange(m.hist), deltaLabel: 'day', sub: m.traded ? undefined : 'indicative' });
    G0.ch.set(relChange(m.hist, 30));
    G0.vol.set(m.volume, { sub: `avg ${fmtQty(meanLast(m.volHist, 30))}` });
    G0.dealer.set(fin(s.foreign?.dealerValue, NaN), { sub: fin(s.foreign?.dealerValue) > 0 && m.price > 0 ? `price ${fmtPctSigned(m.price / s.foreign.dealerValue - 1)}` : undefined });
    G0.state.set(gold);
    G0.stateVal.set(gold * m.price);
    G0.people.set(people);
    G0.bid.set(m.bestBid > 0 ? m.bestBid : NaN, { sub: m.bestAsk > 0 ? 'ask ' + fmtPrice(m.bestAsk) : 'no asks' });
  }

  function paintHistory(s: SimState, m: MarketState | null): void {
    const realm = mode === 'realm';
    pv.el.hidden = realm;
    realmLines.el.hidden = !realm;
    if (realm) {
      const series = s.towns.map((tw, i) => {
        const mm = marketAt(s, tw.id, good);
        const hist = mm?.hist ?? [];
        return { label: tw.name, key: 't' + tw.id, data: hist, x0: s.day - hist.length, color: SERIES[i % SERIES.length] };
      });
      const r = realmSeries(s, good);
      realmLines.set([...series, { label: 'Realm', key: 'realm', data: r.data, x0: r.x0, color: T.ink1, dashed: true, width: 1.5 }], { window: win });
      setText(histSub, 'by town · dashed: realm');
      return;
    }
    if (!m) {
      pv.set(null, win);
      return;
    }
    const col = isGood(good) ? goodColor(good) : good === GOLD_GOOD ? T.goldHi : '#b9c4d0';
    const x0 = s.day - (m.hist?.length ?? 0);
    const ref = mode === 'town' ? realmSeries(s, good) : null;
    pv.set(
      {
        price: m.hist ?? [],
        volume: m.volHist ?? [],
        x0,
        color: col,
        label: mode === 'town' ? s.towns[town]?.name ?? 'Here' : goodLabel(good),
        unit: unitOf(good),
        ref: ref ? { data: ref.data, x0: ref.x0, label: 'Realm (weighted)' } : null,
      },
      win,
    );
    setText(histSub, mode === 'town' ? 'base price · dashed: realm' : 'price and volume');
  }

  function paintAuction(s: SimState, m: MarketState | null): void {
    const realm = mode === 'realm';
    auctionCard.hidden = false;
    curve.el.hidden = realm;
    reading.hidden = realm;
    if (realm) {
      setText(auctionSub, '');
      setText(auctionNote, 'Each town’s market meets three times a day — the opening, midday and the close. Pick a town above to see the bids and asks behind its price.');
      auctionNote.hidden = false;
      return;
    }
    auctionNote.hidden = true;
    const c = m?.curve ?? null;
    const unit = unitOf(good);
    curve.set(c, { unit, reference: m && m.ema > 0 ? m.ema : undefined });
    const ss = m?.sess;
    const sv = m?.sessVol;
    const sessText =
      ss && ss.length === 3
        ? ` · today: opening ${fmtPrice(ss[0])}${sv ? ` (${fmtQty(sv[0])})` : ''}, midday ${fmtPrice(ss[1])}${sv ? ` (${fmtQty(sv[1])})` : ''}, close ${fmtPrice(ss[2])}${sv ? ` (${fmtQty(sv[2])})` : ''}`
        : '';
    setText(auctionSub, (c ? `${Math.floor(c.bids.length / 2)} bid steps · ${Math.floor(c.asks.length / 2)} ask steps` : '') + sessText);
    replace(reading, icon('info', 15), h('span', null, readCurve(c, m, unit)));
  }

  function paintRealm(s: SimState): void {
    const show = isGood(good);
    realmCard.hidden = !show;
    if (!show) return;
    const rows = s.towns.map((tw) => {
      const mm = marketAt(s, tw.id, good);
      const p = fin(mm?.price, NaN);
      const f = town >= 0 && tw.id !== town ? safeFreight(s, town, tw.id) : NaN;
      return {
        key: tw.id,
        label: tw.name,
        sub: mm && !mm.traded ? 'no trade' : undefined,
        value: p > 0 ? p : NaN,
        color: goodColor(good),
        hint: town >= 0 && tw.id !== town ? (Number.isFinite(f) ? `Carting one ${unitOf(good)} from ${s.towns[town]?.name} costs about ${fmtPrice(f)}` : 'No road to carry goods along') : mm ? `Traded ${fmtQty(mm.volume)} today` : undefined,
      };
    });
    townBars.set(rows, { highlight: town >= 0 ? town : null });
    // freight reading: cheapest vs dearest town
    const priced = rows.filter((r) => Number.isFinite(r.value));
    if (priced.length < 2) {
      setText(freightNote, '');
      freightNote.hidden = true;
      return;
    }
    freightNote.hidden = false;
    let lo = priced[0];
    let hi = priced[0];
    for (const r of priced) {
      if (r.value < lo.value) lo = r;
      if (r.value > hi.value) hi = r;
    }
    const gap = hi.value - lo.value;
    const f = safeFreight(s, Number(lo.key), Number(hi.key));
    const u = unitOf(good);
    const b = (x: string) => h('b', null, x);
    const parts: (Node | string)[] = [
      'Cheapest in ',
      b(lo.label),
      ` (${fmtPrice(lo.value)}), dearest in `,
      b(hi.label),
      ` (${fmtPrice(hi.value)}): a gap of `,
      b(fmtPrice(gap)),
      ` a ${u}. `,
    ];
    if (Number.isFinite(f)) {
      parts.push('Carting one between them costs about ', b(fmtPrice(f)), f < gap * 0.8 ? ' — worth a trader’s while, which tends to pull the prices together.' : ' — more than the gap, so little is worth shipping.');
    } else parts.push('No road links them, so the gap can persist.');
    const sp = GOODS[good]?.spoil ?? 0;
    if (sp >= 0.03) parts.push(` ${GOODS[good].name} spoils on the way (${fmtPct(sp)} a day).`);
    replace(freightNote, ...parts);
  }

  function paintHolders(s: SimState): void {
    if (good === IOU_GOOD || good === GOLD_GOOD) {
      let people = 0;
      for (const p of s.people ?? []) if (p && p.alive) people += Math.max(0, fin(good === IOU_GOOD ? p.iou : p.gold));
      const rows =
        good === IOU_GOOD
          ? [
              { key: 'bank', label: 'The Bank', value: fin(s.bank?.iou), hint: 'Bought with its spare reserves when the yield beats what reserves earn' },
              { key: 'people', label: 'Households', value: people, hint: 'Savers buy IOUs when the yield beats the deposit rate' },
            ]
          : [
              { key: 'state', label: 'Treasury', value: fin(s.treasury?.gold), hint: 'The Treasury’s own reserve of gold' },
              { key: 'people', label: 'Households', value: people, hint: 'People hoard gold when they expect prices to rise faster than deposits pay' },
            ];
      holdBars.set(
        rows.filter((r) => r.value > 1e-6).map((r) => ({ ...r, color: good === GOLD_GOOD ? T.goldHi : '#b9c4d0', text: fmtNum(r.value) + (good === GOLD_GOOD ? ' oz' : '') })),
        { empty: good === IOU_GOOD ? 'No IOUs are outstanding yet' : 'No one holds gold' },
      );
      setText(holdSub, good === IOU_GOOD ? 'IOUs held' : 'ounces held');
      holdNote.hidden = true;
      return;
    }
    const rows = holdersOf(s, town, good);
    const u = unitOf(good);
    holdBars.set(
      rows.map((r) => ({ key: r.key, label: r.label, value: r.qty, text: `${fmtQty(r.qty)}`, hint: r.hint, color: r.key === 'state' ? T.gold : goodColor(good) })),
      { empty: 'No one holds any here right now' },
    );
    let total = 0;
    for (const r of rows) total += r.qty;
    setText(holdSub, `${fmtQty(total)} ${pluralize(u)} ${town >= 0 ? 'in ' + (s.towns[town]?.name ?? '') : 'in the realm'}`);
    const sp = GOODS[good]?.spoil ?? 0;
    const m = town >= 0 ? marketAt(s, town, good) : null;
    const daily = m ? meanLast(m.volHist, 30) : meanLast(nationalGood(s, good).volHist, 30);
    const parts: string[] = [];
    if (daily > 0.05 && total > 0) parts.push(`About ${fmtNum(total / daily)} days of trading at the 30-day pace.`);
    if (sp > 0) parts.push(`${GOODS[good].name} spoils: ${fmtPct(sp, sp < 0.01 ? 2 : 1)} of every store is lost each day.`);
    holdNote.hidden = !parts.length;
    setText(holdNote, parts.join(' '));
  }

  function paintRules(s: SimState): void {
    const items: HTMLElement[] = [];
    const levies = (s.policy?.levies ?? []).filter((l) => levyTouches(l));
    const limits = (s.policy?.limits ?? []).filter((l) => limitTouches(l));
    const orders = (s.policy?.orders ?? []).filter((o) => orderTouches(o));
    for (const l of levies) {
      let label: string;
      try {
        label = levyShortLabel(s, l);
      } catch {
        label = l.label || 'Levy';
      }
      items.push(ruleRow('Levy', l.dir === 1 ? 'gold' : 'good', label, !l.enabled ? 'paused' : `${l.today >= 0 ? 'took' : 'paid'} ${fmtMoney(Math.abs(l.today))} today`));
    }
    for (const l of limits) {
      let label: string;
      try {
        label = describeLimit(s, l);
      } catch {
        label = l.label || 'Limit';
      }
      items.push(ruleRow('Limit', 'warn', label, !l.enabled ? 'paused' : l.binding > 0 ? `bound ${l.binding} day${l.binding === 1 ? '' : 's'} this month` : 'not binding'));
    }
    for (const o of orders) {
      let label: string;
      try {
        label = describeOrder(s, o);
      } catch {
        label = o.label || 'Order';
      }
      items.push(ruleRow(o.side === 'buy' ? 'Buy' : 'Sell', 'gold', label, !o.enabled ? 'paused' : `filled ${fmtQty(o.filledToday)} today · ${fmtQty(o.filled)} in all`));
    }
    rulesCard.hidden = items.length === 0;
    replace(rulesList, items);
  }

  function paintInstrument(s: SimState, m: MarketState | null): void {
    if (good === IOU_GOOD) {
      instrNote.hidden = false;
      const p = fin(m?.price);
      replace(
        instrNote,
        h('b', null, 'IOUs '),
        'are the Treasury’s own promises: each pays its holder ',
        h('b', null, '¤5 a year, forever'),
        '. Selling new ones brings money into the Purse; buying them back takes money out of the realm. ',
        p > 0 ? `At ${fmtPrice(p)} an IOU yields ${fmtPct(iouYield(p), 2)} a year.` : '',
      );
    } else if (good === GOLD_GOOD) {
      instrNote.hidden = false;
      const p = fin(m?.price);
      replace(
        instrNote,
        h('b', null, 'Gold '),
        'is what foreign ships are paid in. When ¤ buy less gold, imports cost more ¤ and exports earn more. ',
        p > 0 ? `Today one ounce costs ${fmtPrice(p)}.` : '',
      );
    } else instrNote.hidden = true;
  }

  // ---- rule matching ------------------------------------------------------------------------------------------
  function levyTouches(l: Levy): boolean {
    if (good === IOU_GOOD) return l.base === 'interest';
    if (!isGood(good)) return false;
    const gOk = l.good < 0 || l.good === good;
    const tOk = town < 0 || l.town < 0 || l.town === town;
    if (!gOk) return false;
    if (l.base === 'sale' || l.base === 'goods') return tOk;
    if (l.base === 'shipment') return town < 0 || l.town < 0 || l.town === town || l.toTown === town;
    if (l.base === 'import' || l.base === 'export') return town < 0 || !!state?.towns[town]?.hasPort;
    return false;
  }
  function limitTouches(l: Limit): boolean {
    const price = l.kind === 'priceMax' || l.kind === 'priceMin' || l.kind === 'priceMove';
    if (isInstrument(good)) return price && l.good === good; // the IOU and gold markets: only price limits that name them
    if (!isGood(good)) return false;
    const gOk = l.good < 0 || l.good === good;
    if (!gOk) return false;
    const tOk = town < 0 || l.town < 0 || l.town === town;
    if (price) return tOk;
    if (l.kind === 'shipMax') return town < 0 || l.town < 0 || l.town === town || l.toTown === town;
    if (l.kind === 'importMax' || l.kind === 'exportMax') return town < 0 || !!state?.towns[town]?.hasPort;
    return false;
  }
  function orderTouches(o: PlayerOrder): boolean {
    const mk = o.market;
    if (good === IOU_GOOD) return mk.kind === 'iou';
    if (good === GOLD_GOOD) return mk.kind === 'gold';
    return mk.kind === 'good' && mk.good === good && (town < 0 || mk.town === town);
  }

  return { el, update };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A positive finite number, else undefined (so a prefill leaves the field to its default). */
function posOr(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Number(v.toPrecision(4)) : undefined;
}

function goodOptionsAll(): Option<number>[] {
  const out: Option<number>[] = [];
  for (let g = 0; g < N_GOODS; g++) out.push({ value: g, label: GOODS[g].name, group: 'Goods' });
  out.push({ value: IOU_GOOD, label: 'IOUs', group: 'National markets' });
  out.push({ value: GOLD_GOOD, label: 'Gold', group: 'National markets' });
  return out;
}

function card(titleText: string, sub: HTMLElement | null, right: HTMLElement | null, ...body: (HTMLElement | null)[]): HTMLElement {
  return h(
    'div',
    { class: 'card mk-card' },
    h('div', { class: 'card-head' }, h('div', { class: 'mk-card-titles' }, h('div', { class: 'card-title' }, titleText), sub), right),
    ...body,
  );
}

function ruleRow(kind: string, tone: string, text: string, meta: string): HTMLElement {
  return h('div', { class: 'mk-rule' }, h('span', { class: 'chip ' + tone + ' mk-rule-kind' }, kind), h('div', { class: 'mk-rule-body' }, h('div', { class: 'mk-rule-text' }, text), h('div', { class: 'mk-rule-meta' }, meta)));
}

/** Tile sub for buyers-pay / sellers-get: the wedge against the base price. */
function wedgeSub(v: number, base: number): string {
  if (!(base > 0) || !Number.isFinite(v) || Math.abs(v - base) <= 1e-6 * Math.max(1, base)) return 'no levy';
  return `${fmtPctSigned(v / base - 1)} levy`;
}

function shareOf(part: number, whole: number, what: string): string | undefined {
  if (!(whole > 1e-9) || !(part > 1e-9)) return undefined;
  return `${fmtPct(part / whole)} ${what}`;
}

function chevronLeft(): SVGSVGElement {
  const svg = icon('chevronRight', 14);
  svg.style.transform = 'scaleX(-1)';
  return svg;
}

function signedQty(d: number): string {
  if (!Number.isFinite(d) || Math.abs(d) < 0.05) return '±0';
  return (d > 0 ? '+' : '−') + fmtQty(Math.abs(d));
}

/** Plain-language reading of today's auction (what cleared, who went short, a what-if). */
export function readCurve(c: CurveSnapshot | null, m: MarketState | null, unit: string): string {
  if (!c || !m || (c.bids.length < 2 && c.asks.length < 2)) return 'No one posted orders in this market today.';
  const us = pluralize(unit);
  const P = c.price;
  if (!(c.volume > 0) || !(P > 0)) {
    const bb = c.bids.length >= 2 ? c.bids[0] : -1;
    const ba = c.asks.length >= 2 ? c.asks[0] : -1;
    if (c.ceiling > 0 && ba > c.ceiling) return `Nothing traded: the legal maximum of ${fmtPrice(c.ceiling)} is below the cheapest seller’s ask (${fmtPrice(ba)}), so no one will sell${bb > 0 ? ` — though buyers bid for ${fmtQty(demandAt(c.bids, c.ceiling))} ${us} at that price` : ''}.`;
    if (c.floor > 0 && bb > 0 && bb < c.floor) return `Nothing traded: the legal minimum of ${fmtPrice(c.floor)} is above the keenest bid (${fmtPrice(bb)}), so no one will buy${ba > 0 ? ` — though sellers offered ${fmtQty(supplyAt(c.asks, c.floor))} ${us} at that price` : ''}.`;
    if (bb > 0 && ba > 0) return `Nothing traded: the keenest buyer offered ${fmtPrice(bb)} but the cheapest seller wanted ${fmtPrice(ba)}.`;
    if (ba > 0) return `Sellers are asking from ${fmtPrice(ba)}, but no one bid today.`;
    if (bb > 0) return `Buyers bid up to ${fmtPrice(bb)}, but no one offered any for sale.`;
    return 'Nothing traded today.';
  }
  const parts: string[] = [`Cleared ${fmtQty(c.volume)} ${c.volume === 1 ? unit : us} at ${fmtPrice(P)}.`];
  const sh = fin(m.shortage);
  const su = fin(m.surplus);
  if (c.ceiling > 0 && P >= c.ceiling - 1e-6 && sh > 0.05) parts.push(`The legal maximum of ${fmtPrice(c.ceiling)} holds the price down, so buyers wanted ${fmtQty(sh)} more ${us} than sellers would part with.`);
  else if (c.floor > 0 && P <= c.floor + 1e-6 && su > 0.05) parts.push(`The legal minimum of ${fmtPrice(c.floor)} holds the price up, so ${fmtQty(su)} ${us} went unsold.`);
  else if (sh > 0.05 && sh >= su) parts.push(`Demand outran supply: bids for ${fmtQty(sh)} more ${us} at that price went unfilled.`);
  else if (su > 0.05) parts.push(`Supply outran demand: sellers were left holding ${fmtQty(su)} ${us} at that price.`);
  else parts.push('Every bid at or above that price was filled, and nothing offered at or below it was left over.');
  if (hasWedge(c)) {
    const G = grossOf(c, P);
    const N = netOf(c, P);
    const take = c.volume * (G - N);
    parts.push(`Buyers pay ${fmtPrice(G)}, sellers keep ${fmtPrice(N)}: the Treasury ${G >= N ? 'takes' : 'pays'} ${fmtMoneyShort(Math.abs(take))} a day.`);
  }
  // what-if: 10 % dearer
  const P1 = P * 1.1;
  const d0 = demandAt(c.bids, P);
  const s0 = supplyAt(c.asks, P);
  const d1 = demandAt(c.bids, P1);
  const s1 = supplyAt(c.asks, P1);
  if (d0 > 0 || s0 > 0) parts.push(`At ${fmtPrice(P1)} (10 % dearer) buyers would want ${fmtQty(d1)} (${signedQty(d1 - d0)}) and sellers would offer ${fmtQty(s1)} (${signedQty(s1 - s0)}).`);
  return parts.join(' ');
}

