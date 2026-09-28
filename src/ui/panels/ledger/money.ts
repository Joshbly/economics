// ============================================================================
// Ledger — money & credit.
//
//   tiles     money (Σ deposits) · bank loans · reserves · IOUs outstanding ·
//             made by the Treasury (minted − destroyed) · made by lending
//   sources   where every ¤ of deposit comes from: the Bank's balance-sheet
//             identity deposits = reserves + loans + IOUs − window debt − equity
//   charts    money / loans / reserves; minted vs lending vs the Purse; IOUs
// ============================================================================
import type { SimState } from '../../../sim/types';
import { h, setText } from '../../dom';
import { fmtMoneyDelta, fmtMoneyShort, fmtNum, fmtPctSigned } from '../../format';
import { barChart, kpi, kpiGrid, lineChart, SERIES, T } from '../../widgets';
import { card, D, fin, foot, rangeControl, x0, type RangeDays } from './common';
import type { LedgerView } from './treasury';

/** "+¤12.3k" / "−¤2.2k" / "¤0" */
function signed(v: number): string {
  if (!Number.isFinite(v) || Math.abs(v) < 0.005) return '¤0';
  return (v > 0 ? '+' : '−') + fmtMoneyShort(Math.abs(v));
}

/** Relative change of a series over the last n points. */
function rel(a: number[], n: number): number {
  if (a.length < 2) return NaN;
  const now = a[a.length - 1];
  const prev = a[Math.max(0, a.length - 1 - n)];
  return Number.isFinite(now) && Number.isFinite(prev) && Math.abs(prev) > 1e-9 ? now / prev - 1 : NaN;
}

export function createMoneyView(): LedgerView {
  let range: RangeDays = 360;
  let sig = '';
  let lastS: SimState | null = null;

  const tiles = {
    money: kpi({ label: 'Money', format: fmtMoneyShort, spark: true, hint: 'Every private balance of money in the realm — households, firms and the foreign merchants’ desk. All of it is held as deposits at the Bank.' }),
    credit: kpi({ label: 'Bank loans', format: fmtMoneyShort, spark: true, hint: 'What borrowers owe the Bank. Lending creates deposits; repayment destroys them.' }),
    reserves: kpi({ label: 'Reserves', format: fmtMoneyShort, spark: true, hint: 'The Bank’s money on deposit with the Treasury. It grows when the Treasury pays out and shrinks when the Treasury takes in.' }),
    iou: kpi({ label: 'IOUs outstanding', format: (v) => fmtNum(v), spark: true, hint: 'Treasury IOUs held by the Bank and by people.' }),
    minted: kpi({ label: 'Treasury-made', format: fmtMoneyShort, hint: 'Money created by the Treasury: all money minted less all money destroyed, since the realm began.' }),
    lent: kpi({ label: 'Bank-made', format: fmtMoneyShort, hint: 'Money created by the Bank’s lending: the deposits its loans created that have not yet been repaid (= loans outstanding).' }),
  };

  const sources = barChart({ format: fmtMoneyShort, rowHeight: 25 });
  const srcNote = foot('');

  const rangeCtl = rangeControl(range, (v) => {
    range = v;
    sig = '';
  });
  const moneyChart = lineChart({ height: 170, format: fmtMoneyShort, tickFormat: (v) => fmtMoneyShort(v).replace('.00', ''), label: 'Money, loans and reserves' });
  const madeChart = lineChart({ height: 150, format: fmtMoneyShort, tickFormat: (v) => fmtMoneyShort(v).replace('.00', ''), label: 'Money created' });
  const iouChart = lineChart({ height: 120, format: (v) => fmtNum(v), label: 'IOUs outstanding' });

  const el = h(
    'div',
    { class: 'ldg-view' },
    kpiGrid(Object.values(tiles), 3),
    card('Where the money comes from', 'the Bank’s books today', null, sources.el, srcNote),
    h('div', { class: 'ldg-range-row' }, h('span', { class: 'ldg-range-lab' }, 'Charts show'), rangeCtl.el),
    card('Money, loans and reserves', 'end of each day', null, moneyChart.el),
    card('Who made it', 'cumulative', null, madeChart.el, foot('Minting puts new money in the Purse; it reaches people when the Treasury spends it. Bank lending adds deposits directly.')),
    card('IOUs outstanding', 'count', null, iouChart.el),
  );

  function update(s: SimState, force: boolean): void {
    const nsig = `${s.day}|${range}`;
    if (!force && nsig === sig && lastS === s) return;
    sig = nsig;
    lastS = s;
    const b = s.bank;
    const t = s.treasury;
    // live stocks
    let deposits = fin(s.foreign?.coin);
    for (const p of s.people ?? []) if (p && p.alive) deposits += fin(p.cash);
    for (const f of s.firms ?? []) if (f && f.alive) deposits += fin(f.cash);
    let loans = 0;
    for (const ln of s.loans ?? []) if (ln && ln.active) loans += Math.max(0, fin(ln.principal));
    const reserves = fin(b?.reserves);

    const mD = D(s, 'money');
    const cD = D(s, 'credit');
    const rD = D(s, 'reserves');
    const iD = D(s, 'iouOut');
    const lab = '30 days';
    tiles.money.set(deposits, { delta: rel(mD, 30), deltaFormat: fmtPctSigned, deltaLabel: lab, spark: mD.slice(-360) });
    tiles.credit.set(loans, { delta: rel(cD, 30), deltaFormat: fmtPctSigned, deltaLabel: lab, spark: cD.slice(-360) });
    tiles.reserves.set(reserves, { delta: rel(rD, 30), deltaFormat: fmtPctSigned, deltaLabel: lab, spark: rD.slice(-360) });
    const iouNow = fin(t?.iouOutstanding);
    const i30 = iD.length > 1 ? iD[Math.max(0, iD.length - 31)] : NaN;
    tiles.iou.set(iouNow, { delta: Number.isFinite(i30) ? iouNow - i30 : null, deltaFormat: (d) => (d >= 0 ? '+' : '−') + fmtNum(Math.abs(d)), deltaLabel: lab, spark: iD.slice(-360) });
    const net = fin(t?.minted) - fin(t?.burned);
    tiles.minted.set(net, { sub: fin(t?.minted) > 0.005 ? 'minted − destroyed' : 'none minted yet' });
    tiles.lent.set(loans, { sub: deposits > 0 ? `${Math.round((loans / deposits) * 100)}% of money` : undefined });

    // identity
    const iouBook = fin(b?.iouBook);
    const wd = fin(b?.windowDebt);
    const eq = fin(b?.equity);
    sources.set([
      { key: 'res', label: 'Reserves', value: reserves, text: signed(reserves), color: SERIES[6], hint: 'Money the Treasury has paid out (or lent at the window) that the Bank keeps with it.' },
      { key: 'loans', label: 'Loans', value: loans, text: signed(loans), color: SERIES[0], hint: 'Deposits the Bank created when it lent.' },
      { key: 'iou', label: 'IOUs held', value: iouBook, text: signed(iouBook), color: SERIES[4], hint: 'When the Bank buys IOUs from people it pays them in deposits.' },
      { key: 'win', label: '− Window debt', value: -wd, text: signed(-wd), color: SERIES[1], hint: 'Reserves the Bank borrowed rather than earned: they back no deposit.' },
      { key: 'eq', label: '− Bank’s capital', value: -eq, text: signed(-eq), color: T.gold, hint: 'The part of the Bank’s assets that belongs to its owner, not its depositors. A negative capital means depositors’ money has already been lost.' },
      { key: 'dep', label: '= Deposits', value: deposits, text: fmtMoneyShort(deposits), color: SERIES[2], hint: 'Every private balance of money in the realm.' },
    ]);
    const gap = reserves + loans + iouBook - wd - eq - deposits;
    setText(srcNote, Math.abs(gap) > Math.max(1, deposits * 0.001) ? `(The books are off by ${fmtMoneyShort(gap)} today — money in transit.)` : 'Every ¤ held by anyone is a deposit at the Bank, matched on its books by reserves, loans or IOUs.');

    // charts
    const X = x0(s);
    moneyChart.set(
      [
        { label: 'Money', key: 'money', data: mD, color: SERIES[2], area: true },
        { label: 'Loans', key: 'credit', data: cD, color: SERIES[0] },
        { label: 'Reserves', key: 'reserves', data: rD, color: SERIES[6] },
      ],
      { x0: X, window: range, zero: true, empty: 'Figures start with the first day of your reign' },
    );
    madeChart.set(
      [
        { label: 'Minted (all time)', key: 'minted', data: D(s, 'minted'), color: SERIES[6] },
        { label: 'Bank loans', key: 'credit', data: cD, color: SERIES[0] },
        { label: 'Purse', key: 'purse', data: D(s, 'purse'), color: T.gold, dashed: true },
      ],
      { x0: X, window: range, zero: true, empty: 'Figures start with the first day of your reign' },
    );
    const anyIou = iD.some((v) => v > 0) || iouNow > 0;
    iouChart.set([{ label: 'IOUs outstanding', key: 'iou', data: anyIou ? iD : [], color: SERIES[4], area: true }], { x0: X, window: range, zero: true, legend: false, empty: 'No IOUs issued yet — selling IOUs (Trade) creates them' });
  }

  return { el, update };
}
