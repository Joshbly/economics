// ============================================================================
// Ledger — the Treasury's own books.
//
//   tiles        Purse · net flow today · money created · IOUs · gold · window loans
//   position     what the Treasury holds vs what it owes (T-account)
//   statement    income & spending by category: today / this month / last month
//                (treasury.flows / flowsMonth / flowsLastMonth; + = into the Purse)
//   rules        every levy with what it took (or paid) today, this month,
//                last month and in all
//   history      the Purse and cumulative money minted
// ============================================================================
import { DAYS_PER_MONTH, IOU_COUPON } from '../../../sim/config';
import { N_GOODS } from '../../../sim/goods';
import { describeLevy, levyShortLabel } from '../../../sim/policy/player';
import type { Levy, SimState } from '../../../sim/types';
import { h, replace, setText, setTone } from '../../dom';
import { DASH, fmtDay, fmtMoney, fmtMoneyDelta, fmtMoneyShort, fmtNum, fmtPct } from '../../format';
import { setTab } from '../../uiState';
import { button, emptyState, kpi, kpiGrid, lineChart, SERIES, T, table, tipNote, tipTitle } from '../../widgets';
import { attachSideTip } from '../markets/sidetip';
import { card, D, fin, foot, L, rangeControl, tAccount, x0, type RangeDays } from './common';

export interface LedgerView {
  el: HTMLElement;
  update(s: SimState, force: boolean): void;
}

/** Friendly names for treasury.flows categories (ledger.ts Flow), in statement order. */
export const FLOW_INFO: { key: string; label: string; hint: string }[] = [
  { key: 'levy', label: 'Levies taken', hint: 'Collected by every “take” rule: shares of sales, wages, rent, profits, money or goods held, heads, shipments, the port…' },
  { key: 'give', label: 'Levies given', hint: 'Paid out by every “give” rule (a negative levy): the Treasury adds to a flow instead of taking from it.' },
  { key: 'transfer', label: 'Transfers', hint: 'One-off lump sums paid to (or taken from) a group, and advances handed to builders for Treasury projects.' },
  { key: 'recap', label: 'Paid to the Bank', hint: 'Transfers to the Bank. They count as new capital for it.' },
  { key: 'interest', label: 'Window interest', hint: 'Interest the Bank pays on what it borrowed at the window, less the interest the Treasury pays on the reserves the Bank keeps with it.' },
  { key: 'coupon', label: 'IOU interest', hint: `¤${IOU_COUPON} a year to the holder of every IOU, paid a little each day.` },
  { key: 'buy', label: 'Goods trades', hint: 'Money received for goods the Treasury sold, less money paid for goods it bought.' },
  { key: 'asset', label: 'IOU & gold trades', hint: 'Money from selling IOUs or gold, less money spent buying them.' },
  { key: 'wage', label: 'Treasury workers', hint: 'Wages paid to the people the Treasury employs.' },
  { key: 'build', label: 'Construction', hint: 'Builders’ bills for the Treasury’s roads, houses, workshops and piers.' },
  { key: 'freight', label: 'Freight', hint: 'Carting the Treasury’s own goods between towns.' },
  { key: 'dividend', label: 'Dividends', hint: 'Profits paid out by Treasury-owned workshops (and by the Bank when it has no private owner).' },
  { key: 'rent', label: 'Rent', hint: 'Rent from the tenants of Treasury-owned houses.' },
  { key: 'estate', label: 'Estates', hint: 'Money left by people who died without an heir.' },
];
const KNOWN = new Set(FLOW_INFO.map((f) => f.key));

function flowLabel(key: string): { label: string; hint: string } {
  const f = FLOW_INFO.find((x) => x.key === key);
  if (f) return f;
  return { label: key === 'fee' ? 'Fees' : key === 'misc' ? 'Other' : key.charAt(0).toUpperCase() + key.slice(1), hint: 'Other payments into or out of the Purse.' };
}

/** Cumulative stats series value at the end of `day` (NaN when outside the series). */
function seriesAt(s: SimState, key: string, day: number): number {
  const a = D(s, key);
  const i = day - x0(s);
  return i >= 0 && i < a.length ? a[i] : NaN;
}

/** Value of the Treasury's goods at each town's current price. */
export function treasuryGoodsValue(s: SimState): number {
  let v = 0;
  const tg = s.treasury?.goods ?? [];
  for (let t = 0; t < tg.length; t++) {
    for (let g = 0; g < N_GOODS; g++) {
      const q = fin(tg[t]?.[g]);
      if (q > 0) v += q * Math.max(0, fin(s.markets[t * N_GOODS + g]?.price));
    }
  }
  return v;
}

export function createTreasuryView(): LedgerView {
  let range: RangeDays = 360;
  let sig = '';
  let lastS: SimState | null = null;

  const tiles = {
    purse: kpi({ label: 'Purse', format: fmtMoneyShort, good: 'up', spark: true, hint: 'Money the Treasury holds right now. Everything it pays comes out of here; everything it takes goes in.' }),
    flow: kpi({ label: 'Net flow today', format: fmtMoneyDelta, hint: 'Everything that came into the Purse today less everything that went out (money minted not included).' }),
    made: kpi({ label: 'Money created', format: fmtMoneyShort, hint: 'All money the Treasury has minted, less what it has destroyed.' }),
    iou: kpi({ label: 'IOUs outstanding', format: (v) => fmtNum(v), hint: `IOUs held by the Bank and by people. Each one costs the Treasury ¤${IOU_COUPON} a year, forever, until it is bought back.` }),
    gold: kpi({ label: 'Gold', format: (v) => fmtNum(v) + ' oz', hint: 'The Treasury’s gold, valued at today’s gold price.' }),
    window: kpi({ label: 'Lent at the window', format: fmtMoneyShort, hint: 'What the Bank has borrowed from the Treasury at the window lending rate.' }),
  };

  // position
  const pos = tAccount('What it holds', 'What it owes', fmtMoneyShort);
  const netEl = h('span', { class: 'ldg-net-val' });
  const netRow = h('div', { class: 'ldg-net' }, h('span', { class: 'ldg-net-lab' }, 'Holds less owes'), netEl);
  attachSideTip(netRow, () => [tipTitle('Holds less owes'), tipNote('The reserves the Bank keeps with the Treasury are money the Treasury has promised to pay on demand, so they sit on the “owes” side. A Treasury that creates money usually owes more than it holds.')]);

  // statement
  const stmtBody = h('div', { class: 'ldg-stmt-body' });
  const stmtTot = h('div', { class: 'ldg-stmt-row ldg-stmt-total' });
  const stmtMint = h('div', { class: 'ldg-stmt-row ldg-stmt-mint' });
  const stmtEmpty = h('div', { class: 'ldg-stmt-empty' }, 'No money moved in or out of the Purse this month or last.');
  const stmt = h(
    'div',
    { class: 'ldg-stmt' },
    h('div', { class: 'ldg-stmt-row ldg-stmt-head' }, h('span', null, ''), h('span', null, 'Today'), h('span', null, 'This month'), h('span', null, 'Last month')),
    stmtBody,
    stmtEmpty,
    stmtTot,
    stmtMint,
  );
  const stmtSub = h('span');

  // levy rules
  const rules = table<Levy>({
    columns: [
      {
        key: 'rule',
        label: 'Rule',
        align: 'left',
        width: '38%',
        value: (l) => l.label || String(l.id),
        format: (_v, l) => ruleCell(l),
      },
      { key: 'today', label: 'Day', title: 'Today', value: (l) => fin(l.today), format: (v: number) => signedTight(v), tone: (l) => toneOf(l.today) },
      { key: 'month', label: 'Mon', title: 'This month', value: (l) => fin(l.month), format: (v: number) => signedTight(v), tone: (l) => toneOf(l.month) },
      { key: 'last', label: 'Last', title: 'Last month', value: (l) => fin(l.lastMonth), format: (v: number) => signedTight(v), tone: (l) => toneOf(l.lastMonth) },
      { key: 'total', label: 'Total', title: 'Since the rule was made', value: (l) => fin(l.total), format: (v: number) => signedTight(v), tone: (l) => toneOf(l.total) },
    ],
    rowKey: (l) => l.id,
    dense: true,
    maxHeight: 260,
    empty: 'No levy rules yet',
  });
  const rulesEmpty = emptyState('No levy rules yet. Each rule you attach in Levers appears here with what it took or paid.', button({ label: 'Open Levers', size: 'sm', onClick: () => setTab('levers') }));
  const ruleCellCache = new Map<number, { el: HTMLElement; lab: HTMLElement; meta: HTMLElement; sig: string }>();
  let stateRef: SimState | null = null;
  function ruleCell(l: Levy): HTMLElement {
    let c = ruleCellCache.get(l.id);
    if (!c) {
      const lab = h('span', { class: 'ldg-rule-lab' });
      const meta = h('span', { class: 'ldg-rule-meta' });
      const el = h('span', { class: 'ldg-rule' }, lab, meta);
      c = { el, lab, meta, sig: '' };
      ruleCellCache.set(l.id, c);
      const id = l.id;
      attachSideTip(el, () => {
        const s = stateRef;
        const lv = s?.policy?.levies?.find((x) => x.id === id);
        if (!s || !lv) return null;
        let text = '';
        try {
          text = describeLevy(s, lv);
        } catch {
          text = lv.label;
        }
        return [tipTitle(lv.dir === 1 ? 'Take rule' : 'Give rule'), tipNote(text)];
      });
    }
    const s = stateRef;
    let label = l.label;
    if (s) {
      try {
        label = levyShortLabel(s, l);
      } catch {
        /* keep label */
      }
    }
    const meta = !l.enabled ? 'paused' : l.until >= 0 ? 'until ' + fmtDay(l.until) : '';
    const sigv = label + '|' + meta;
    if (sigv !== c.sig) {
      c.sig = sigv;
      setText(c.lab, label);
      setText(c.meta, meta);
      c.meta.hidden = !meta;
    }
    return c.el;
  }

  // history
  const rangeCtl = rangeControl(range, (v) => {
    range = v;
    sig = '';
  });
  const chart = lineChart({ height: 170, format: fmtMoneyShort, tickFormat: (v) => fmtMoneyShort(v).replace('.00', ''), label: 'The Purse and money minted' });

  const el = h(
    'div',
    { class: 'ldg-view' },
    kpiGrid(Object.values(tiles), 3),
    card('Position', 'valued at today’s prices', null, pos.el, netRow),
    card('Income & spending', stmtSub, null, stmt, foot('Positive figures came into the Purse; negative ones went out. Hover a line for what it covers.')),
    card('Levy rules', 'what each rule took (+) or paid (−)', null, rules.el, rulesEmpty),
    card('The Purse over time', 'end of each day', rangeCtl.el, chart.el),
  );

  function update(s: SimState, force: boolean): void {
    stateRef = s;
    const t = s.treasury;
    const nsig = `${s.day}|${range}|${s.policy?.levies?.length}`;
    if (!force && nsig === sig && lastS === s) return;
    sig = nsig;
    lastS = s;
    const b = s.bank;
    const goldP = fin(s.goldMarket?.price, fin(s.foreign?.goldPrice));
    const iouP = fin(s.iouMarket?.price);
    const purseD = D(s, 'purse');
    const p30 = purseD.length > 1 ? purseD[Math.max(0, purseD.length - 31)] : NaN;
    tiles.purse.set(t.purse, { delta: Number.isFinite(p30) ? t.purse - p30 : null, deltaFormat: fmtMoneyDeltaShort, deltaLabel: '30d', spark: purseD.slice(-360), tone: t.purse < 0 ? 'bad' : null, sub: t.givesSuspended ? 'gives suspended' : t.autoMint ? 'auto-mint on' : undefined });
    let today = 0;
    let month = 0;
    for (const k in t.flows) today += fin(t.flows[k]);
    for (const k in t.flowsMonth) month += fin(t.flowsMonth[k]);
    tiles.flow.set(today, { sub: 'month ' + fmtMoneyDeltaShort(month), tone: today < -1e-6 ? 'bad' : today > 1e-6 ? 'good' : null });
    tiles.made.set(fin(t.minted) - fin(t.burned), { sub: fin(t.burned) > 0.005 ? `${fmtMoneyShort(t.burned)} destroyed` : fin(t.minted) > 0.005 ? 'none destroyed' : 'none minted yet' });
    const out = fin(t.iouOutstanding);
    tiles.iou.set(out, { sub: out > 0 ? `owe ${fmtMoneyShort(out * IOU_COUPON)} a year` : 'none issued' });
    tiles.gold.set(t.gold, { sub: 'worth ' + fmtMoneyShort(fin(t.gold) * goldP) });
    tiles.window.set(fin(b?.windowDebt), { sub: `at ${fmtPct(t.lendRate, 1)} a year` });

    // position
    const goodsV = treasuryGoodsValue(s);
    const holds = [
      { key: 'purse', label: 'Purse', value: fin(t.purse), hint: 'Money in hand.', color: T.gold },
      { key: 'gold', label: 'Gold', sub: `${fmtNum(t.gold)} oz at ${fmtMoneyShort(goldP)}`, value: fin(t.gold) * goldP, hint: 'The Treasury’s gold at today’s price in the gold market.', color: T.goldHi },
      { key: 'goods', label: 'Goods in store', value: goodsV, hint: 'Goods the Treasury bought and still holds, at each town’s price today.', color: SERIES[2] },
      { key: 'window', label: 'Lent to the Bank', sub: 'at the window', value: fin(b?.windowDebt), hint: 'The Bank’s borrowing at the window: it pays the window lending rate on it.', color: SERIES[0] },
    ];
    const owes = [
      { key: 'reserves', label: 'Bank reserves', sub: `pays ${fmtPct(t.reserveRate, 1)} a year`, value: fin(b?.reserves), hint: 'Money the Bank keeps on deposit with the Treasury. The Treasury pays the reserve rate on it and must hand it over on demand.', color: SERIES[6] },
      { key: 'iou', label: 'IOUs', sub: out > 0 ? `${fmtNum(out)} at ${fmtMoneyShort(iouP)}` : 'none issued', value: out * iouP, hint: `IOUs outstanding at today’s market price. Each pays ¤${IOU_COUPON} a year forever.`, color: SERIES[4] },
    ];
    const hTot = holds.reduce((a, r) => a + r.value, 0);
    const oTot = owes.reduce((a, r) => a + r.value, 0);
    pos.set(holds, owes, { leftTotal: hTot, rightTotal: oTot });
    setText(netEl, fmtMoneyDelta(hTot - oTot));
    setTone(netEl, ['good', 'bad'], hTot - oTot < 0 ? 'bad' : 'good');

    // statement
    const keys = new Set<string>();
    for (const src of [t.flows, t.flowsMonth, t.flowsLastMonth]) for (const k in src ?? {}) if (Math.abs(fin(src[k])) > 0.005) keys.add(k);
    const ordered = [...FLOW_INFO.map((f) => f.key).filter((k) => keys.has(k)), ...[...keys].filter((k) => !KNOWN.has(k)).sort()];
    const rows = ordered.map((k) => {
      const info = flowLabel(k);
      return stmtRow(info.label, info.hint, fin(t.flows?.[k]), fin(t.flowsMonth?.[k]), fin(t.flowsLastMonth?.[k]));
    });
    replace(stmtBody, rows);
    stmtEmpty.hidden = rows.length > 0;
    let last = 0;
    for (const k in t.flowsLastMonth ?? {}) last += fin(t.flowsLastMonth[k]);
    fillStmt(stmtTot, 'Net into the Purse', 'Sum of the lines above.', today, month, last);
    // money minted (not a flow): from the cumulative series
    const dayDone = s.day - 1;
    const mStart = Math.floor(dayDone / DAYS_PER_MONTH) * DAYS_PER_MONTH;
    const mintNow = fin(t.minted);
    const atMStart = seriesAt(s, 'minted', mStart - 1);
    const atLStart = seriesAt(s, 'minted', mStart - DAYS_PER_MONTH - 1);
    const mintToday = fin(L(s, 'mintDay'), 0);
    const mintMonth = Number.isFinite(atMStart) ? mintNow - atMStart : NaN;
    const mintLast = Number.isFinite(atLStart) && Number.isFinite(atMStart) ? atMStart - atLStart : NaN;
    const anyMint = mintNow > 0.005;
    stmtMint.hidden = !anyMint;
    if (anyMint) fillStmt(stmtMint, 'Money minted', 'New money created in the Purse — by Mint, or automatically when the Purse runs dry while auto-mint is on. Not income: nobody paid it.', mintToday, mintMonth, mintLast, true);
    const dom = (dayDone % DAYS_PER_MONTH) + 1;
    setText(stmtSub, `day ${dom} of ${DAYS_PER_MONTH} this month`);

    // levies
    const levies = s.policy?.levies ?? [];
    rules.el.hidden = levies.length === 0;
    rulesEmpty.hidden = levies.length > 0;
    for (const id of [...ruleCellCache.keys()]) if (!levies.some((l) => l.id === id)) ruleCellCache.delete(id);
    rules.set(levies);

    // history
    const minted = D(s, 'minted');
    chart.set(
      [
        { label: 'Purse', key: 'purse', data: purseD, color: T.gold, area: true },
        { label: 'Minted (all time)', key: 'minted', data: minted, color: SERIES[6], dashed: true, hidden: !(mintNow > 0) },
      ],
      { x0: x0(s), window: range, zero: true, empty: 'Figures start with the first day of your reign' },
    );
  }

  return { el, update };
}

function fmtMoneyDeltaShort(v: number): string {
  if (!Number.isFinite(v)) return DASH;
  if (Math.abs(v) < 0.005) return '¤0';
  return (v > 0 ? '+' : '−') + fmtMoneyShort(Math.abs(v));
}

function toneOf(v: number): 'good' | 'bad' | null {
  if (!Number.isFinite(v) || Math.abs(v) < 0.005) return null;
  return v > 0 ? 'good' : 'bad';
}

function signedShort(v: number): string {
  if (!Number.isFinite(v)) return DASH;
  if (Math.abs(v) < 0.005) return '·';
  return (v > 0 ? '+' : '−') + fmtMoneyShort(Math.abs(v));
}

/** Tight signed money for table cells: "+¤115", "−¤7.3", "+¤1.1k". */
function signedTight(v: number): string {
  if (!Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  if (a < 0.005) return '·';
  const body = a >= 1e6 ? (a / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : a >= 1000 ? (a / 1000).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k' : a >= 10 ? Math.round(a).toString() : a.toFixed(1);
  return (v > 0 ? '+' : '−') + '¤' + body;
}

function stmtRow(label: string, hint: string, a: number, b: number, c: number): HTMLElement {
  const row = h('div', { class: 'ldg-stmt-row' });
  fillStmt(row, label, hint, a, b, c);
  return row;
}

function fillStmt(row: HTMLElement, label: string, hint: string, a: number, b: number, c: number, neutral = false): void {
  const cell = (v: number) => h('span', { class: 'ldg-stmt-v' + (neutral ? ' gold' : toneOf(v) ? ' ' + toneOf(v) : ''), title: Number.isFinite(v) ? fmtMoney(v) : '' }, neutral && Number.isFinite(v) && Math.abs(v) >= 0.005 ? '+' + fmtMoneyShort(Math.abs(v)) : signedShort(v));
  const lab = h('span', { class: 'ldg-stmt-lab' }, label);
  replace(row, lab, cell(a), cell(b), cell(c));
  attachSideTip(lab, () => [tipTitle(label), tipNote(hint)]);
}
