// ============================================================================
// Ledger — national accounts.
//
//   tiles      real output · nominal output · trade balance · shipping rate
//   output     real & nominal output (7-day average)
//   spending   what output was spent on (30-day averages)
//   by good    units made per day (bar length = value at base prices)
//   work       workers by sector, firm counts (live from s.firms)
//   trade      the port: imports vs exports, per-good table with world prices
//   shipping   the shipping-rate index
// ============================================================================
import { GOODS, N_GOODS, SECTORS, TRADABLE_GOODS } from '../../../sim/goods';
import type { Sector, SimState } from '../../../sim/types';
import { h, setText } from '../../dom';
import { fmtMoneyDelta, fmtMoneyShort, fmtNum, fmtPct, fmtPctSigned, fmtPrice, fmtQty, pluralize } from '../../format';
import { barChart, fmtTick, goodColor, kpi, kpiGrid, lineChart, readable, SERIES, swatch, T, table } from '../../widgets';
import { card, D, fin, foot, L, meanLast, rangeControl, smooth, x0, type RangeDays } from './common';
import type { LedgerView } from './treasury';

interface TradeRow {
  g: number;
  world: number;
  inQ: number;
  outQ: number;
  today: number;
}

const SECTOR_PLURAL: Partial<Record<Sector, string>> = {
  farm: 'Farms',
  fishery: 'Fisheries',
  lumber: 'Lumber camps',
  coalmine: 'Coal mines',
  oilwell: 'Oil wells',
  oremine: 'Ore mines',
  smelter: 'Smelters',
  toolworks: 'Toolworks',
  bakery: 'Bakeries',
  brewery: 'Breweries',
  furniture: 'Furniture shops',
  builder: 'Builders’ yards',
  trader: 'Trading houses',
  stateworks: 'Treasury works',
};

/** 30-day mean of a daily series, falling back to the latest value (the first days of a reign). */
function avg(s: SimState, key: string, n = 30): number {
  const m = meanLast(D(s, key), n);
  return Number.isFinite(m) ? m : fin(L(s, key), NaN);
}

const EMPTY = 'Figures start with the first day of your reign';

function rel30(a: number[]): number {
  const now = meanLast(a, 30);
  const prev = meanLast(a, 30, 30);
  return Number.isFinite(now) && Number.isFinite(prev) && Math.abs(prev) > 1e-9 ? now / prev - 1 : NaN;
}

export function createNationalView(): LedgerView {
  let range: RangeDays = 360;
  let sig = '';
  let lastS: SimState | null = null;

  const tiles = {
    real: kpi({ label: 'Real output', format: fmtMoneyShort, unit: '/day', good: 'up', hint: 'Everything the realm produced in a day, valued at fixed base prices — so it moves only when quantities move. 30-day average; the change is against the 30 days before.' }),
    nominal: kpi({ label: 'Nominal output', format: fmtMoneyShort, unit: '/day', hint: 'Spending on what the realm produced, at today’s prices. 30-day average.' }),
    trade: kpi({ label: 'Trade balance', format: fmtMoneyDelta, unit: '/day', hint: 'Exports less imports through the port, at base prices. 30-day average.' }),
    freight: kpi({ label: 'Shipping rate', format: fmtPrice, good: 'down', hint: 'What carting one unit ten tiles costs: drivers’ wages, oil and wagon wear. Oil prices and roads move it.' }),
  };

  const rangeCtl = rangeControl(range, (v) => {
    range = v;
    sig = '';
  });
  const outChart = lineChart({ height: 170, format: fmtMoneyShort, tickFormat: (v) => fmtMoneyShort(v).replace('.00', ''), label: 'Real and nominal output' });

  const spend = barChart({ format: fmtMoneyShort, rowHeight: 24 });
  const spendNote = foot('');
  const byGood = barChart({ format: fmtMoneyShort, rowHeight: 22 });
  const noneNote = foot('');
  const work = barChart({ format: (v) => fmtNum(v), rowHeight: 22 });
  const workSub = h('span');

  const tradeChart = lineChart({ height: 140, format: fmtMoneyShort, tickFormat: (v) => fmtMoneyShort(v).replace('.00', ''), label: 'Imports and exports' });
  const tradeTbl = table<TradeRow>({
    columns: [
      {
        key: 'good',
        label: 'Good',
        align: 'left',
        width: '34%',
        value: (r) => GOODS[r.g]?.name ?? '',
        format: (_v, r) => goodCell(r.g),
      },
      { key: 'world', label: 'World', title: 'World price per unit, in ¤ at today’s gold price', value: (r) => r.world, format: (v: number) => (v > 0 ? fmtPrice(v) : '—') },
      { key: 'in', label: 'In', title: 'Units arriving by sea per day (30-day average)', value: (r) => r.inQ, format: (v: number) => (v > 0.005 ? fmtQty(v) : '·') },
      { key: 'out', label: 'Out', title: 'Units leaving by sea per day (30-day average)', value: (r) => r.outQ, format: (v: number) => (v > 0.005 ? fmtQty(v) : '·') },
    ],
    rowKey: (r) => r.g,
    dense: true,
    sort: { key: 'world', dir: -1 },
  });
  const goodCells = new Map<number, HTMLElement>();
  function goodCell(g: number): HTMLElement {
    let e = goodCells.get(g);
    if (!e) {
      e = h('span', { class: 'ldg-goodcell' }, swatch(goodColor(g)), GOODS[g]?.name ?? '');
      goodCells.set(g, e);
    }
    return e;
  }
  const tradeSub = h('span');
  const shipChart = lineChart({ height: 120, format: fmtPrice, tickFormat: (v, st) => '¤' + fmtTick(v, st), legend: false, label: 'Shipping rate' });
  const shipNote = foot('');

  const el = h(
    'div',
    { class: 'ldg-view' },
    kpiGrid(Object.values(tiles), 2),
    h('div', { class: 'ldg-range-row' }, h('span', { class: 'ldg-range-lab' }, 'Charts show'), rangeCtl.el),
    card('Output', '¤ a day · 7-day average', null, outChart.el),
    card('What it was spent on', '¤ a day · 30-day average', null, spend.el, spendNote),
    card('Made each day', 'units a day · bars sized by value at base prices', null, byGood.el, noneNote),
    card('Where people work', workSub, null, work.el),
    card('Trade with the outside world', tradeSub, null, tradeChart.el, tradeTbl.el),
    card('Shipping', '¤ to cart one unit ten tiles', null, shipChart.el, shipNote),
  );

  function update(s: SimState, force: boolean): void {
    const nsig = `${s.day}|${range}`;
    if (!force && nsig === sig && lastS === s) return;
    sig = nsig;
    lastS = s;
    const X = x0(s);
    const real = D(s, 'gdpReal');
    const nom = D(s, 'gdpNominal');
    tiles.real.set(avg(s, 'gdpReal'), { delta: rel30(real), deltaFormat: fmtPctSigned, deltaLabel: 'vs prior 30 days', sub: undefined });
    tiles.nominal.set(avg(s, 'gdpNominal'), { delta: rel30(nom), deltaFormat: fmtPctSigned, deltaLabel: 'vs prior 30 days' });
    const tb = avg(s, 'tradeBal');
    tiles.trade.set(tb, { tone: tb < -0.5 ? 'bad' : tb > 0.5 ? 'good' : null, sub: `in ${fmtMoneyShort(avg(s, 'imports'))} · out ${fmtMoneyShort(avg(s, 'exports'))}` });
    const fr = D(s, 'freight');
    const f30 = fr.length > 1 ? fr[Math.max(0, fr.length - 31)] : NaN;
    const fNow = fin(L(s, 'freight'), NaN);
    tiles.freight.set(fNow, { delta: Number.isFinite(f30) && f30 > 0 ? fNow / f30 - 1 : null, deltaFormat: fmtPctSigned, deltaLabel: '30 days', sub: 'per unit per 10 tiles' });

    outChart.set(
      [
        { label: 'Real (base prices)', key: 'real', data: smooth(real, 7), color: SERIES[2], area: true },
        { label: 'Nominal (today’s prices)', key: 'nom', data: smooth(nom, 7), color: SERIES[3] },
      ],
      { x0: X, window: range, empty: EMPTY },
    );

    // spending split
    const cons = avg(s, 'cons');
    const rent = avg(s, 'rentPaid');
    const inv = avg(s, 'inv');
    const gov = avg(s, 'gov');
    const nx = avg(s, 'netExports');
    const nomM = avg(s, 'gdpNominal');
    const imputed = nomM - fin(cons) - fin(rent) - fin(inv) - fin(gov) - fin(nx);
    const rows: { key: string; label: string; value: number; color: string; hint: string }[] = [
      { key: 'cons', label: 'Households: goods', value: cons, color: SERIES[0], hint: 'Bread, fish, coal, ale and furniture bought by households, at the prices they paid.' },
      { key: 'rent', label: 'Households: rent', value: rent, color: SERIES[6], hint: 'Rent paid by tenants.' },
      { key: 'inv', label: 'Investment', value: inv, color: SERIES[2], hint: 'Tools bought by firms, and construction paid for by private owners.' },
      { key: 'gov', label: 'Treasury', value: gov, color: T.gold, hint: 'Goods the Treasury bought (less sold), Treasury workers’ wages and Treasury construction.' },
      { key: 'nx', label: 'Net exports', value: nx, color: SERIES[1], hint: 'What foreign ships bought from the realm, less what they sold to it.' },
    ];
    if (imputed > 0.5) rows.splice(2, 0, { key: 'own', label: 'Owners’ own homes', value: imputed, color: SERIES[5], hint: 'The rent people living in homes they own would otherwise pay.' });
    spend.set(rows.filter((r) => Number.isFinite(r.value)).map((r) => ({ ...r, text: fmtMoneyShort(r.value) })));
    setText(spendNote, Number.isFinite(nomM) ? `Together: ${fmtMoneyShort(nomM)} a day — the nominal output above.` : '');

    // output by good
    const base = s.stats?.basePrices ?? [];
    const goods = [];
    for (let g = 0; g < N_GOODS; g++) {
      const q = avg(s, 'prod_' + g);
      if (!Number.isFinite(q)) continue;
      const u = GOODS[g].unit;
      goods.push({ key: g, label: GOODS[g].name, value: q * Math.max(0, fin(base[g], 1)), text: `${fmtQty(q)} ${q === 1 ? u : pluralize(u)}`, color: goodColor(g), hint: `${fmtMoneyShort(q * fin(base[g], 1))} a day at base prices` });
    }
    goods.sort((a, b) => b.value - a.value);
    const made = goods.filter((r) => r.value > 1e-6);
    const none = goods.filter((r) => !(r.value > 1e-6)).map((r) => r.label.toLowerCase());
    byGood.set(made, { empty: 'Nothing produced yet' });
    setText(noneNote, none.length ? `Not made at all lately: ${none.join(', ')}.` : '');
    noneNote.hidden = !none.length;

    // work by sector (live)
    const agg = new Map<Sector, { firms: number; workers: number; wage: number }>();
    for (const f of s.firms ?? []) {
      if (!f || !f.alive || f.status === 'closed') continue;
      let e = agg.get(f.sector);
      if (!e) agg.set(f.sector, (e = { firms: 0, workers: 0, wage: 0 }));
      e.firms++;
      const n = f.workers?.length ?? 0;
      e.workers += n;
      e.wage += n * fin(f.wage);
    }
    const wrows = [...agg.entries()]
      .map(([sec, e]) => ({
        key: sec,
        label: SECTOR_PLURAL[sec] ?? SECTORS[sec]?.name ?? sec,
        sub: sec === 'stateworks' ? '' : `${e.firms}`,
        value: e.workers,
        color: sec === 'stateworks' ? T.gold : readable(SECTORS[sec]?.color ?? T.ink2),
        hint: `${e.firms} ${e.firms === 1 ? 'firm' : 'firms'} · average wage ${e.workers > 0 ? fmtPrice(e.wage / e.workers) : '—'} a day`,
      }))
      .filter((r) => r.value > 0 || r.key !== 'stateworks')
      .sort((a, b) => b.value - a.value);
    work.set(wrows, { empty: 'No firms yet' });
    const emp = fin(L(s, 'employed'), NaN);
    const un = fin(L(s, 'unemp'), NaN);
    setText(workSub, `workers by sector (small figure: firms)${Number.isFinite(emp) ? ` · ${fmtNum(emp)} employed, ${fmtPct(un)} jobless` : ''}`);

    // trade
    tradeChart.set(
      [
        { label: 'Imports', key: 'imp', data: smooth(D(s, 'imports'), 7), color: SERIES[1] },
        { label: 'Exports', key: 'exp', data: smooth(D(s, 'exports'), 7), color: SERIES[2] },
      ],
      { x0: X, window: range, zero: true, yMin: 0, empty: EMPTY },
    );
    const gp = fin(s.goldMarket?.ema) > 0 ? s.goldMarket.ema : fin(s.foreign?.goldPrice);
    const trows: TradeRow[] = TRADABLE_GOODS.map((g) => ({
      g,
      world: fin(s.foreign?.world?.[g]) * gp,
      inQ: fin(avg(s, 'imp_' + g)),
      outQ: fin(avg(s, 'exp_' + g)),
      today: fin(s.foreign?.importsQty?.[g]) - fin(s.foreign?.exportsQty?.[g]),
    }));
    tradeTbl.set(trows);
    setText(tradeSub, `¤ a day · units a day, 30-day average · gold ${fmtPrice(gp)}/oz`);

    shipChart.set([{ label: 'Shipping rate', key: 'freight', data: fr, color: SERIES[3], area: true }], { x0: X, window: range, empty: EMPTY });
    const oil = fin(L(s, 'price_4'), NaN);
    setText(shipNote, `Carters burn oil on every tile${Number.isFinite(oil) ? ` (oil is ${fmtPrice(oil)} a barrel today)` : ''}. Dearer oil or slower roads raise this rate — and the wider prices can drift apart between towns before carting goods pays.`);
  }

  return { el, update };
}
