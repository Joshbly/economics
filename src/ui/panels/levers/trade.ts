// ============================================================================
// Lever II — Trade: post Treasury orders in any market (a good in a town, a
// town's labour market, the national IOU and Gold markets), and look after the
// Treasury's holdings (with Move goods between towns).
// Treasury orders trade at the base price and are exempt from levies.
// ============================================================================
import { IOU_COUPON, IOU_PAR, PLAYER_MAX_PRICE, PLAYER_MAX_QTY, PLAYER_MAX_WORKERS, TREASURY_FREIGHT_PREMIUM, WAGON_CAPACITY } from '../../../sim/config';
import { freightPerUnit } from '../../../sim/agents/traders';
import { GOODS, G, N_GOODS } from '../../../sim/goods';
import { routeBetweenTowns } from '../../../sim/world/paths';
import type { MarketState, OrderMarket, SimState } from '../../../sim/types';
import { h, setText, show } from '../../dom';
import { fmtNum, fmtPct, fmtPrice, plural } from '../../format';
import { ui, type PrefillRequest } from '../../uiState';
import { goodOptions, numberInput, segmented, selectInput, sparkline, swatch, townOptions } from '../../widgets';
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

type MKind = 'good' | 'labor' | 'iou' | 'gold';
type Dur = 'once' | 'days' | 'standing';

export function tradeLever(): Lever {
  let kind: MKind = 'good';
  let town = 0;
  let good: number = G.bread;
  let side: 'buy' | 'sell' = 'buy';
  let dur: Dur = 'standing';
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
      { value: 'labor', label: 'Labour', title: 'Hire Treasury workers in a town' },
      { value: 'iou', label: 'IOUs', title: 'Issue or buy back the Treasury’s IOUs (national market)' },
      { value: 'gold', label: 'Gold', title: 'Buy or sell gold (national market)' },
    ],
    value: kind,
    full: true,
    onChange: (v) => {
      kind = v;
      if (kind === 'labor') side = 'buy';
      marketChanged();
    },
  });
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
    h('div', { class: 'lv-row lv-row-full' }, kindSeg.el),
    marketRow,
    ref,
    sideRow.el,
    priceRow.el,
    qtyRow.el,
    durRow,
    totalRow,
    formFoot(preview, msg, place),
  );

  // ---- holdings ---------------------------------------------------------------
  const holdTotal = h('span', { class: 'lv-sub-v' });
  const holdTable = h('div', { class: 'lv-hold' });
  const holdEmpty = h('div', { class: 'lv-empty-sm' }, 'The Treasury holds no goods. Anything it buys is kept in the town where it was bought.');
  const goldLine = h('div', { class: 'lv-hold-line' });
  const iouLine = h('div', { class: 'lv-hold-line' });
  let holdSig = '';

  // move goods
  const moveMsg = msgLine();
  const mvFrom = selectInput<number>({ options: [{ value: 0, label: '—' }], value: 0, onChange: () => paintMove() });
  const mvTo = selectInput<number>({ options: [{ value: 1, label: '—' }], value: 1, onChange: () => paintMove() });
  const mvGood = selectInput<number>({ options: goodOptions(), value: G.bread, onChange: () => paintMove() });
  const mvQty = numberInput({ value: 40, min: 0, max: PLAYER_MAX_QTY, unit: 'loaves', width: '130px', onChange: () => paintMove() });
  const mvAll = chip('All', () => {
    if (!last) return;
    mvQty.set(Math.floor(fin(last.treasury.goods[mvFrom.value]?.[mvGood.value]) * 100) / 100);
    paintMove();
  }, 'Everything held there');
  const mvPreview = h('div', { class: 'lv-preview' });
  const mvBtn = submitButton('Move goods');
  const moveForm = formEl(
    () => doMove(),
    row('Route', mvFrom.el, h('span', { class: 'lv-w' }, 'to'), mvTo.el),
    row('Goods', mvGood.el),
    row('Quantity', mvQty.el, mvAll),
    formFoot(mvPreview, moveMsg, mvBtn),
  );
  const moveBox = h('div', { class: 'lv-subform' }, subhead('Move goods'), moveForm);

  const body = h(
    'div',
    { class: 'lv-body-in' },
    form,
    h('div', { class: 'lv-sep' }),
    subhead('Treasury holdings', holdTotal),
    holdTable,
    holdEmpty,
    goldLine,
    iouLine,
    moveBox,
  );

  // ---- helpers ------------------------------------------------------------------
  function market(s: SimState): MarketState | undefined {
    if (kind === 'iou') return s.iouMarket;
    if (kind === 'gold') return s.goldMarket;
    if (kind === 'good') return s.markets[town * N_GOODS + good];
    return undefined;
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

    // quantity hint
    if (kind === 'good') {
      const have = fin(t.goods[town]?.[good]);
      setText(qtyHint, side === 'sell' ? `You hold ${fmtQ(have)} ${unitsOf(good)} in ${townName(s, town)}.` : `≈ ${fmtQ(fin(market(s)?.volEma))} ${unitsOf(good)} traded here a day.`);
    } else if (kind === 'labor') {
      const tw = s.towns[town];
      setText(qtyHint, `Jobless in ${townName(s, town)}: ${fmtNum(fin(tw?.unemployed))} · Treasury workers now: ${fmtNum(stateworksCount(s, town))}`);
    } else if (kind === 'iou') setText(qtyHint, side === 'buy' ? `In public hands: ${fmtNum(fin(t.iouOutstanding))}.` : 'New IOUs are created as they sell.');
    else setText(qtyHint, `The Treasury holds ${fmtQ(fin(t.gold))} oz.`);

    // preview
    const q = qty.value;
    const n = dur === 'days' ? days.value : dur === 'once' ? 1 : NaN;
    const cap = total.value;
    const perDay = p * q;
    const bits: (string | Node)[] = [];
    const B = (x: string) => h('b', null, x);
    const span = dur === 'once' ? ', today only' : dur === 'days' && n > 0 ? `, for ${plural(n, 'day')}` : ', until cancelled';
    if (!(p > 0) && !(kind !== 'labor' && side === 'sell' && p === 0)) bits.push('Set a price limit.');
    else if (!(q > 0)) bits.push('Set a quantity per day.');
    else if (kind === 'labor') {
      bits.push('Up to ', B(fmtM(perDay)), ' a day in wages for ', B(plural(Math.round(q), 'worker')), ' in ', townName(s, town), span, '. Paid from the Purse.');
    } else if (kind === 'good' && side === 'buy') {
      bits.push('Up to ', B(fmtM(perDay)), ' a day from the Purse', span, '.');
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
    if (buying && p > 0 && q > 0 && !t.autoMint && fin(t.purse) < perDay) {
      bits.push(h('span', { class: 'warn' }, ` The Purse holds ${fmtM(fin(t.purse))}, so purchases are capped by what it can pay.`));
    }
    preview.replaceChildren(...bits);
    const okPrice = kind !== 'labor' && side === 'sell' ? p >= 0 : p > 0;
    place.disabled = !(okPrice && q > 0 && (dur !== 'days' || n > 0) && !total.error);
    setText(place, kind === 'labor' ? 'Hire' : kind === 'iou' && side === 'sell' ? 'Issue' : 'Place order');
  }

  function submit(): void {
    if (!last) return;
    const p = price.value;
    const q = qty.value;
    if (!Number.isFinite(p)) return msg.err(price.error ?? 'Set a price limit.');
    if (!(q > 0)) return msg.err(qty.error ?? 'Set a quantity per day.');
    if (total.error) return msg.err(total.error);
    const m: OrderMarket = kind === 'good' ? { kind: 'good', town, good } : kind === 'labor' ? { kind: 'labor', town } : { kind };
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
      },
      msg,
      '✓ Order placed — it is listed under In force.',
    );
  }

  // ---- holdings & move ----------------------------------------------------------
  function paintHoldings(s: SimState): void {
    const t = s.treasury;
    const nT = s.towns.length;
    let value = 0;
    const rows: number[] = [];
    let sigParts = s.towns.map((x) => x.name).join('|');
    const holdsIn = new Set<number>();
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
        sigParts += ',' + q.toFixed(2);
      }
      if (any) rows.push(g);
    }
    const goldV = fin(t.gold) * fin(s.goldMarket?.price);
    setText(holdTotal, value + goldV > 0 ? `≈ ${fmtM(value + goldV)} at market prices` : '');
    if (sigParts !== holdSig) {
      holdSig = sigParts;
      if (rows.length) {
        // only the towns where the Treasury holds something get a column
        const cols = s.towns.filter((x) => holdsIn.has(x.id));
        const head = h('div', { class: 'lv-hold-r lv-hold-h' }, h('span', null, 'Good'), cols.map((x) => h('span', { title: x.name }, x.name)));
        const body = rows.map((g) =>
          h(
            'div',
            { class: 'lv-hold-r' },
            h('span', { class: 'lv-hold-g' }, swatch(GOODS[g].color, 'box'), GOODS[g].name),
            cols.map((x) => {
              const q = fin(t.goods[x.id]?.[g]);
              return h('span', { class: q > 0.005 ? '' : 'faint' }, q > 0.005 ? fmtQ(q) : '·');
            }),
          ),
        );
        holdTable.replaceChildren(head, ...body);
        holdTable.style.setProperty('--cols', String(cols.length));
      } else holdTable.replaceChildren();
    }
    show(holdTable, rows.length > 0);
    show(holdEmpty, rows.length === 0);
    goldLine.replaceChildren(h('span', { class: 'lv-hold-k' }, 'Gold'), h('span', { class: 'lv-hold-v' }, `${fmtQ(fin(t.gold))} oz`), h('span', { class: 'muted' }, goldV > 0 ? ` ≈ ${fmtM(goldV)}` : ''));
    const owed = fin(t.iouOutstanding);
    iouLine.replaceChildren(
      h('span', { class: 'lv-hold-k' }, 'IOUs in public hands'),
      h('span', { class: 'lv-hold-v' }, fmtNum(owed)),
      h('span', { class: 'muted' }, owed > 0 ? ` · the Purse pays ${fmtM(owed * IOU_COUPON)} a year` : ''),
    );
    show(moveBox, rows.length > 0);
  }

  function paintMove(): void {
    const s = last;
    if (!s) return;
    const from = mvFrom.value;
    const to = mvTo.value;
    const g = mvGood.value;
    setNumUnit(mvQty, unitsOf(g));
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
    mvBtn.disabled = false;
  }

  function doMove(): void {
    if (!last) return;
    const q = mvQty.value;
    if (!(q > 0)) return moveMsg.err(mvQty.error ?? 'Set a quantity.');
    run({ type: 'moveGoods', from: mvFrom.value, to: mvTo.value, good: mvGood.value, qty: q }, moveMsg, '✓ On its way.');
  }

  function applyUiMarket(s: SimState): void {
    const k = `${ui.marketTown}:${ui.marketGood}`;
    if (k === uiMarketApplied) return;
    uiMarketApplied = k;
    if (ui.marketTown >= 0 && ui.marketTown < s.towns.length && ui.marketGood >= 0 && ui.marketGood < N_GOODS) {
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
      const n = s.policy.orders.filter((o) => o.enabled).length;
      return { text: n ? plural(n, 'order') : 'No orders' };
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
      syncDefaults(s);
      paint();
      paintHoldings(s);
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
      townSel.setOptions(townOptions(s), town);
      goodSel.set(good);
      sideSeg.set(side);
      priceFor = '';
      syncDefaults(s, req.price);
      paint();
      return true;
    },
    focus: () => price.focus(),
    reset() {
      priceFor = '';
      holdSig = '';
      uiMarketApplied = '';
      last = null;
    },
  };
}

