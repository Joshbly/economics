// ============================================================================
// The trading desk: one good across every town's market, in a window of its own.
//
//   chart     the good's price in each town over the last 90 / 180 / 360 days, with the
//             floor and ceiling of the bracket being drawn up (or the one being edited)
//   towns     today's price, the going price a bracket reckons with (a slow average), the
//             floor and ceiling there, what the Treasury holds there, today's bracket trade
//   bracket   buy below a floor and sell above a ceiling — fixed prices, each town's own
//             going price, or the realm's — in some or all towns, a set quantity a day, a
//             ladder of rungs, a stock cap (policy/brackets.ts)
//   at once   buy or sell in every chosen town at the going price (within a band) or a fixed
//             price: one Treasury order in each town's market
//   in force  the good's brackets, with what they have bought and sold; pause, edit, remove
//
// It only reads the realm and dispatches actions (like every panel). It refreshes each day
// while open, so it can stay up while the realm runs.
// ============================================================================
import { MARKET_HIST_DAYS } from '../../sim/config';
import { G, GOODS, N_GOODS } from '../../sim/goods';
import { bracketBand, bracketRef, bracketTowns, describeBracket } from '../../sim/policy/brackets';
import type { Bracket, BracketInput, BracketMode, SimState } from '../../sim/types';
import { h, replace, setText, show } from '../dom';
import { fmtDay, fmtNum, fmtPct, fmtPrice } from '../format';
import { openFloat } from '../floatwin';
import { on, ui } from '../uiState';
import { button, goodOptions, lineChart, numberInput, segmented, selectInput, SERIES, table, toggle } from '../widgets';
import { fin, fmtMS, fmtQ, msgLine, run, unitsOf } from './levers/common';
import './desk.css';

interface TownRow {
  town: number;
  name: string;
  price: number;
  ref: number;
  floor: number;
  ceiling: number;
  held: number;
  today: string;
}

const MODES: { value: BracketMode; label: string; title: string }[] = [
  { value: 'local', label: 'Each town’s price', title: 'Floor and ceiling a share below / above each town’s own going price (a slow average): each town’s gluts and spikes' },
  { value: 'realm', label: 'The realm’s price', title: 'One floor and ceiling for every town, a share below / above the mean of the towns’ going prices: buys where it is cheap, sells where it is dear' },
  { value: 'fixed', label: 'Fixed prices', title: 'Floor and ceiling as prices (¤), the same in every town' },
];

let openHandle: { close(): void } | null = null;

/** Open the trading desk (on `good`, or bread). One at a time: opening it again brings it up on that good. */
export function openDesk(good?: number): void {
  if (openHandle) openHandle.close();
  const s0 = ui?.game?.s as SimState | undefined;
  if (!s0) return;
  let g = Number.isInteger(good) && good! >= 0 && good! < N_GOODS ? good! : G.bread;
  let range = 180;
  let mode: BracketMode = 'local';
  let editing = -1; // bracket id being edited
  let focus = 0; // town whose band the chart shows ('local')
  const chosen = new Set<number>(s0.towns.map((t) => t.id));

  // ---- controls ----
  const goodSel = selectInput({ options: goodOptions(), value: g, onChange: (v) => { g = v; editing = -1; resetDraft(); refresh(); }, width: '160px' });
  const rangeSeg = segmented({ options: [{ value: 90, label: '90 d' }, { value: 180, label: '180 d' }, { value: 360, label: '360 d' }], value: range, onChange: (v) => { range = v; refresh(); }, size: 'sm' });
  const chart = lineChart({ height: 230, format: fmtPrice, label: 'Price in each town', legendValues: true });
  const townTable = table<TownRow>({
    columns: [
      { key: 'name', label: 'Town', align: 'left', width: '20%', value: (r) => r.name, format: (_v: never, r: TownRow) => h('span', { class: 'desk-town' + (chosen.has(r.town) ? '' : ' off') + (r.town === focus ? ' focus' : '') }, r.name) },
      { key: 'price', label: 'Today', title: 'Today’s price in the market', value: (r) => r.price, format: (v: number) => fmtPrice(v) },
      { key: 'ref', label: 'Going', title: 'The going price a bracket reckons with: a slow average (about 90 days) of the market’s', value: (r) => r.ref, format: (v: number) => fmtPrice(v) },
      { key: 'floor', label: 'Floor', title: 'Buys below this (the draft bracket)', value: (r) => r.floor, format: (v: number) => (v > 0 ? fmtPrice(v) : '—') },
      { key: 'ceiling', label: 'Ceiling', title: 'Sells above this (the draft bracket)', value: (r) => r.ceiling, format: (v: number) => (v > 0 ? fmtPrice(v) : '—') },
      { key: 'held', label: 'Held', title: 'What the Treasury’s store there holds', value: (r) => r.held, format: (v: number) => fmtQ(v) },
      { key: 'today', label: 'Traded', title: 'What the Treasury bought (+) and sold (−) there today: its brackets on this good, and its standing orders', value: (r) => r.today },
    ],
    rowKey: (r) => r.town,
    onRowClick: (r) => { focus = r.town; refresh(); },
    dense: true,
  });

  // ---- the bracket form ----
  const modeSeg = segmented({ options: MODES.map((m) => ({ value: m.value, label: m.label, title: m.title })), value: mode, onChange: (v) => { mode = v; setUnits(); refresh(); }, size: 'sm' });
  // floor and ceiling: a share of the going price, or (fixed) a price
  const lowP = numberInput({ value: 0.1, percent: true, min: 0, max: 0.9, title: 'How far below the going price it buys' });
  const highP = numberInput({ value: 0.15, percent: true, min: 0, title: 'How far above the going price it sells' });
  const lowF = numberInput({ value: 1, min: 0, prefix: '¤', title: 'It buys at this price or below' });
  const highF = numberInput({ value: 2, min: 0, prefix: '¤', title: 'It sells at this price or above' });
  const lowWrap = h('span', { class: 'desk-num' }, lowP.el, lowF.el);
  const highWrap = h('span', { class: 'desk-num' }, highP.el, highF.el);
  const low = () => (mode === 'fixed' ? lowF : lowP);
  const high = () => (mode === 'fixed' ? highF : highP);
  const buyQty = numberInput({ value: 20, min: 0, unit: '/day', title: 'Units it buys a day in each town, at the floor (0: it does not buy)' });
  const sellQty = numberInput({ value: 20, min: 0, unit: '/day', title: 'Units it offers a day in each town, at the ceiling, from the store there (0: it does not sell)' });
  const maxStock = numberInput({ value: 1000, min: 0, title: 'The most it holds in each town’s store: it stops buying there at this (empty or 0: no cap)', placeholder: 'no cap' });
  const rungs = segmented({ options: [1, 2, 3, 4].map((n) => ({ value: n, label: n === 1 ? 'one price' : `${n} steps` })), value: 1, onChange: () => refresh(), size: 'sm' });
  const step = numberInput({ value: 0.05, percent: true, min: 0, title: 'How far apart the steps of a ladder are (each further step bids lower and offers higher, for more)' });
  const days = numberInput({ value: 0, min: 0, integer: true, unit: 'days', title: 'How long it stands (0: until removed)', placeholder: 'standing' });
  for (const c of [lowP, highP, lowF, highF, buyQty, sellQty, maxStock, step]) c.input.addEventListener('input', () => refresh());
  const townChips = h('div', { class: 'desk-chips' });
  const msg = msgLine();
  const submit = button({ label: 'Set the bracket', kind: 'primary', onClick: () => submitBracket() });
  const cancelEdit = button({ label: 'New bracket instead', kind: 'ghost', size: 'sm', onClick: () => { editing = -1; resetDraft(); refresh(); } });
  const preview = h('p', { class: 'desk-preview' });

  /** Show the fields the band's mode takes; fixed prices start a little either side of the realm's going price. */
  function setUnits(reset = true): void {
    const fixed = mode === 'fixed';
    show(lowP.el, !fixed);
    show(highP.el, !fixed);
    show(lowF.el, fixed);
    show(highF.el, fixed);
    if (!reset) return;
    if (fixed) {
      const ref = meanRef(ui.game.s as SimState);
      lowF.set(Math.round(ref * 0.9 * 100) / 100);
      highF.set(Math.round(ref * 1.15 * 100) / 100);
    } else {
      lowP.set(0.1);
      highP.set(0.15);
    }
  }

  function draft(): BracketInput {
    const ms = fin(maxStock.value);
    const all = chosen.size >= (ui.game.s as SimState).towns.length;
    return {
      good: g,
      towns: all ? [] : [...chosen].sort((a, b) => a - b),
      mode,
      low: fin(low().value),
      high: fin(high().value),
      buyQty: Math.max(0, fin(buyQty.value)),
      sellQty: Math.max(0, fin(sellQty.value)),
      maxStock: ms > 0 ? ms : -1,
      rungs: rungs.value,
      step: fin(step.value),
      days: Math.max(0, Math.round(fin(days.value))),
    };
  }

  /** The draft as a bracket record (for its band on the chart and in the table). */
  function draftBracket(s: SimState): Bracket {
    const d = draft();
    const ed = editing >= 0 ? s.policy.brackets?.find((b) => b.id === editing) : undefined;
    return {
      id: -1, label: '', enabled: true, good: g, towns: d.towns ?? [], mode: d.mode, low: d.low, high: d.high,
      buyQty: d.buyQty, sellQty: d.sellQty, maxStock: d.maxStock ?? -1, rungs: d.rungs ?? 1, step: d.step ?? 0,
      created: s.day, until: -1, ref: ed && ed.good === g ? ed.ref : [], bought: 0, spent: 0, sold: 0, earned: 0, boughtToday: 0, soldToday: 0, today: [],
    };
  }

  function meanRef(s: SimState): number {
    let a = 0;
    let n = 0;
    for (const t of s.towns) {
      const m = s.markets[t.id * N_GOODS + g];
      if (m && m.ema > 0) {
        a += m.ema;
        n++;
      }
    }
    return n ? a / n : 1;
  }

  function resetDraft(): void {
    mode = 'local';
    modeSeg.set(mode);
    setUnits();
    buyQty.set(20);
    sellQty.set(20);
    maxStock.set(1000);
    rungs.set(1);
    step.set(0.05);
    days.set(0);
    const s = ui.game.s as SimState;
    chosen.clear();
    for (const t of s.towns) chosen.add(t.id);
    setText(submit, 'Set the bracket');
    msg.clear();
  }

  function loadBracket(b: Bracket): void {
    editing = b.id;
    g = b.good;
    goodSel.set(g);
    mode = b.mode;
    modeSeg.set(mode);
    setUnits(false);
    low().set(b.low);
    high().set(b.high);
    buyQty.set(b.buyQty);
    sellQty.set(b.sellQty);
    maxStock.set(b.maxStock >= 0 ? b.maxStock : 0);
    rungs.set(Math.max(1, b.rungs));
    step.set(b.step > 0 ? b.step : 0.05);
    days.set(b.until >= 0 ? Math.max(1, b.until - (ui.game.s as SimState).day + 1) : 0);
    const s = ui.game.s as SimState;
    chosen.clear();
    for (const t of b.towns.length ? b.towns : s.towns.map((x) => x.id)) chosen.add(t);
    setText(submit, 'Update the bracket');
    msg.clear();
    refresh();
  }

  function submitBracket(): void {
    const d = draft();
    if (editing >= 0) {
      const r = run({ type: 'updateBracket', id: editing, patch: d }, msg, '✓ Bracket updated.');
      if (r.ok) refresh();
    } else {
      const r = run({ type: 'addBracket', bracket: d }, msg, '✓ Bracket set: it trades from tomorrow’s market.');
      if (r.ok && typeof r.id === 'number') {
        editing = r.id;
        setText(submit, 'Update the bracket');
        refresh();
      }
    }
  }

  // ---- buy / sell everywhere at once ----
  const qSide = segmented<'buy' | 'sell'>({ options: [{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }], value: 'buy', size: 'sm' });
  const qQty = numberInput({ value: 10, min: 0, unit: '/day', title: 'Units a day in each chosen town' });
  const qHow = segmented({
    options: [
      { value: 'follow', label: 'the going price', title: 'Each town’s going price, within the band (a patient order: it bids as little as gets its quantity)' },
      { value: 'fixed', label: 'a fixed price', title: 'One price in every chosen town' },
    ],
    value: 'follow' as 'follow' | 'fixed',
    size: 'sm',
    onChange: () => paintQuick(),
  });
  const qBand = numberInput({ value: 0.1, percent: true, min: 0, max: 1, title: 'How far from the going price it may go' });
  const qPrice = numberInput({ value: 1, min: 0, prefix: '¤', title: 'The price in every chosen town' });
  const qDays = numberInput({ value: 0, min: 0, integer: true, unit: 'days', placeholder: 'standing', title: 'How long the orders stand (0: until withdrawn)' });
  const qMsg = msgLine();
  const qBandWrap = h('span', { class: 'desk-inline' }, 'within ', qBand.el);
  const qPriceWrap = h('span', { class: 'desk-inline' }, qPrice.el);
  function paintQuick(): void {
    show(qBandWrap, qHow.value === 'follow');
    show(qPriceWrap, qHow.value === 'fixed');
  }
  const qGo = button({
    label: 'Place the orders',
    kind: 'secondary',
    onClick: () => {
      const towns = [...chosen].sort((a, b) => a - b);
      let ok = 0;
      let last = '';
      for (const t of towns) {
        const days0 = Math.max(0, Math.round(fin(qDays.value)));
        const base = { type: 'placeOrder' as const, market: { kind: 'good' as const, town: t, good: g }, side: qSide.value, qty: Math.max(0, fin(qQty.value)), ...(days0 > 0 ? { days: days0 } : {}) };
        const r = run(qHow.value === 'follow' ? { ...base, price: 0, priceMode: 'follow' as const, band: fin(qBand.value), pace: 'patient' as const } : { ...base, price: fin(qPrice.value), priceMode: 'fixed' as const }, null);
        if (r.ok) ok++;
        else last = r.message;
      }
      if (ok === towns.length) qMsg.ok(`✓ ${ok} ${ok === 1 ? 'order' : 'orders'} placed — one in each chosen town’s ${(GOODS[g]?.name ?? '').toLowerCase()} market.`);
      else qMsg.err(`${ok} of ${towns.length} placed. ${last}`);
      refresh();
    },
  });

  // ---- the good's brackets ----
  const list = h('div', { class: 'desk-list' });

  function paintChips(s: SimState): void {
    replace(
      townChips,
      ...s.towns.map((t) =>
        h(
          'button',
          {
            type: 'button',
            class: 'chip lv-chip' + (chosen.has(t.id) ? ' on' : ''),
            title: chosen.has(t.id) ? `Leave ${t.name} out` : `Trade in ${t.name} too`,
            onClick: () => {
              if (chosen.has(t.id)) {
                if (chosen.size > 1) chosen.delete(t.id);
              } else chosen.add(t.id);
              refresh();
            },
          },
          t.name,
        ),
      ),
    );
  }

  function paintList(s: SimState): void {
    const mine = (s.policy.brackets ?? []).filter((b) => b.good === g);
    if (!mine.length) {
      replace(list, h('p', { class: 'note' }, `No bracket on ${(GOODS[g]?.name ?? 'this good').toLowerCase()} yet.`));
      return;
    }
    replace(
      list,
      ...mine.map((b) => {
        const held = bracketTowns(s, b).reduce((a, t) => a + fin(s.treasury.goods[t]?.[b.good]), 0);
        const sw = toggle({ value: b.enabled, title: 'Pause or resume', onChange: (v) => { run({ type: 'updateBracket', id: b.id, patch: { enabled: v } }, null); refresh(); } });
        const net = b.earned - b.spent;
        return h(
          'div',
          { class: 'desk-item' + (b.id === editing ? ' editing' : '') + (b.enabled ? '' : ' off') },
          sw.el,
          h(
            'div',
            { class: 'desk-item-main' },
            h('div', { class: 'desk-item-t' }, b.label),
            h('div', { class: 'desk-item-d' }, describeBracket(s, b) + (b.until >= 0 ? ` Until ${fmtDay(b.until)}.` : '')),
            h(
              'div',
              { class: 'desk-item-s' },
              `Bought ${fmtQ(b.bought)} for ${fmtMS(b.spent)} · sold ${fmtQ(b.sold)} for ${fmtMS(b.earned)} · holds ${fmtQ(held)} ${unitsOf(b.good)} · `,
              h('span', { class: net >= 0 ? 'good' : 'bad' }, `${net >= 0 ? 'took in' : 'paid out'} ${fmtMS(Math.abs(net))} net`),
              ` · today +${fmtQ(b.boughtToday)} / −${fmtQ(b.soldToday)}`,
            ),
          ),
          button({ label: 'Edit', kind: 'ghost', size: 'sm', onClick: () => loadBracket(b) }),
          button({ label: 'Remove', kind: 'ghost', size: 'sm', onClick: () => { run({ type: 'removeBracket', id: b.id }, null); if (editing === b.id) { editing = -1; resetDraft(); } refresh(); } }),
        );
      }),
    );
  }

  // ---- paint ----
  function refresh(): void {
    const s = ui.game.s as SimState;
    if (!s) return;
    const d = draftBracket(s);
    const name = GOODS[g]?.name ?? 'Goods';
    // chart: each town's daily price
    const series = s.towns.map((t, i) => {
      const m = s.markets[t.id * N_GOODS + g];
      const hist = m?.hist ?? [];
      return { label: t.name, key: 't' + t.id, data: hist.slice(-Math.min(range, MARKET_HIST_DAYS)), color: SERIES[i % SERIES.length], width: t.id === focus ? 2.2 : 1.3 };
    });
    const n = series.reduce((a, x) => Math.max(a, x.data.length), 0);
    const band = bracketBand(s, d, focus);
    const fixedLike = d.mode !== 'local';
    const refLines = [
      { y: band.floor, label: fixedLike ? 'floor' : `floor · ${s.towns[focus]?.name ?? ''}`, color: '#6fb38a', dashed: true },
      { y: band.ceiling, label: fixedLike ? 'ceiling' : `ceiling · ${s.towns[focus]?.name ?? ''}`, color: '#d98a6a', dashed: true },
    ].filter((r) => r.y > 0);
    chart.set(series, { x0: s.day - n, window: range, refLines, empty: 'No prices yet' });
    // table
    const rows: TownRow[] = s.towns.map((t) => {
      const m = s.markets[t.id * N_GOODS + g];
      const b = bracketBand(s, d, t.id);
      return { town: t.id, name: t.name, price: fin(m?.price), ref: bracketRef(s, d, t.id), floor: chosen.has(t.id) ? b.floor : 0, ceiling: chosen.has(t.id) ? b.ceiling : 0, held: fin(s.treasury.goods[t.id]?.[g]), today: '' };
    });
    // what the Treasury traded there today: its brackets on the good (net), and its standing orders
    const mine = (s.policy.brackets ?? []).filter((b) => b.good === g);
    for (const r of rows) {
      const net = mine.reduce((a, b) => a + fin(b.today?.[r.town]), 0);
      const orders = (s.policy.orders ?? []).filter((o) => o.market.kind === 'good' && o.market.town === r.town && o.market.good === g);
      const ob = orders.filter((o) => o.side === 'buy').reduce((a, o) => a + fin(o.filledToday), 0);
      const os = orders.filter((o) => o.side === 'sell').reduce((a, o) => a + fin(o.filledToday), 0);
      const parts: string[] = [];
      if (Math.abs(net) > 0.005) parts.push(`${net > 0 ? '+' : '−'}${fmtQ(Math.abs(net))}`);
      if (ob > 0.005 || os > 0.005) parts.push(`orders ${ob > 0.005 ? '+' + fmtQ(ob) : ''}${ob > 0.005 && os > 0.005 ? ' ' : ''}${os > 0.005 ? '−' + fmtQ(os) : ''}`);
      r.today = parts.join(' · ');
    }
    townTable.set(rows);
    paintChips(s);
    paintList(s);
    show(step.el, rungs.value > 1);
    show(cancelEdit, editing >= 0);
    const tw = chosen.size >= s.towns.length ? 'every town' : [...chosen].map((t) => s.towns[t]?.name).join(', ');
    setText(
      preview,
      d.mode === 'fixed'
        ? `Buys ${name.toLowerCase()} below ${fmtPrice(d.low)} and sells above ${fmtPrice(d.high)} in ${tw}.`
        : `Buys ${name.toLowerCase()} ${fmtPct(d.low, 0)} below the ${d.mode === 'realm' ? 'realm’s' : 'town’s'} going price and sells ${fmtPct(d.high, 0)} above it, in ${tw}. Today in ${s.towns[focus]?.name}: buys below ${fmtPrice(band.floor)}, sells above ${fmtPrice(band.ceiling)}.`,
    );
    setText(head, `${name} across the realm · ${fmtNum(s.towns.length)} towns`);
  }

  const head = h('div', { class: 'desk-head-t' });
  const body = h(
    'div',
    { class: 'desk' },
    h('div', { class: 'desk-head' }, goodSel.el, head, h('span', { class: 'spacer' }), rangeSeg.el),
    chart.el,
    h('p', { class: 'note' }, 'Click a town in the table to draw its floor and ceiling on the chart.'),
    townTable.el,
    h(
      'div',
      { class: 'desk-cols' },
      h(
        'section',
        { class: 'desk-card' },
        h('h3', null, 'Price bracket', cancelEdit),
        h('p', { class: 'note' }, 'Buy below a floor and sell above a ceiling, every day, in each chosen town: the Treasury’s store there takes in a glut and lets it out into a spike.'),
        h('div', { class: 'desk-row' }, h('span', { class: 'k' }, 'Band'), modeSeg.el),
        h('div', { class: 'desk-row' }, h('span', { class: 'k' }, 'Buy below'), lowWrap, h('span', { class: 'k' }, 'Sell above'), highWrap),
        h('div', { class: 'desk-row' }, h('span', { class: 'k' }, 'Buy a day'), buyQty.el, h('span', { class: 'k' }, 'Sell a day'), sellQty.el),
        h('div', { class: 'desk-row' }, h('span', { class: 'k' }, 'Hold at most'), maxStock.el, h('span', { class: 'note' }, 'in each store')),
        h('div', { class: 'desk-row' }, h('span', { class: 'k' }, 'Ladder'), rungs.el, step.el),
        h('div', { class: 'desk-row' }, h('span', { class: 'k' }, 'Towns'), townChips),
        h('div', { class: 'desk-row' }, h('span', { class: 'k' }, 'For'), days.el),
        preview,
        h('div', { class: 'desk-row' }, submit),
        msg.el,
      ),
      h(
        'section',
        { class: 'desk-card' },
        h('h3', null, 'Trade in every chosen town at once'),
        h('p', { class: 'note' }, 'One Treasury order in each chosen town’s market: they show in In force like any order.'),
        h('div', { class: 'desk-row' }, qSide.el, qQty.el, h('span', { class: 'k' }, 'at'), qHow.el),
        h('div', { class: 'desk-row' }, qBandWrap, qPriceWrap, h('span', { class: 'k' }, 'for'), qDays.el),
        h('div', { class: 'desk-row' }, qGo),
        qMsg.el,
        h('h3', null, 'Brackets on this good'),
        list,
      ),
    ),
  );

  resetDraft();
  paintQuick();
  // live: each day, and after any action (a bracket paused or removed in In force); a new realm closes it
  const offs = [on('day', () => refresh()), on('action', () => refresh()), on('newgame', () => m.close())];
  const m = openFloat({
    title: 'Trading desk',
    subtitle: 'One good in every town’s market: prices, the Treasury’s stores, its price brackets. The realm keeps running; drag the window by its title.',
    body,
    width: 1000,
    className: 'desk-win',
    onClose: () => {
      for (const f of offs) f();
      openHandle = null;
    },
  });
  openHandle = m;
  refresh();
}
