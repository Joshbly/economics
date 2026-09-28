// ============================================================================
// Ledger — the commercial Bank.
//
//   banner       when the Bank has failed (equity < 0): what happens next
//   tiles        capital ratio · reserves vs requirement · loan rate · deposit rate
//   balance      T-account: reserves, loans, IOUs | deposits, window debt, equity
//   lending      stance meter, today's decisions (with reasons), defaults,
//                write-offs, interest in / out
//   rates        the window's two rates and the Bank's own
//   borrowers    the largest debtors (click → inspect)
//   history      loans and the Bank's own capital
// ============================================================================
import { BANK_FAIL_GRACE_DAYS, BANK_MIN_CAPITAL } from '../../../sim/config';
import { lastLoanDecisions, requiredReserves, minCapital } from '../../../sim/agents/bank';
import { refName } from '../../../sim/ledger';
import { FIRM_BASE, type LoanPurpose, type SimState } from '../../../sim/types';
import { h, replace, setText } from '../../dom';
import { fmtMoneyShort, fmtNum, fmtPct, fmtRate } from '../../format';
import { select } from '../../uiState';
import { icon, kpi, kpiGrid, kvList, lineChart, SERIES, T, table } from '../../widgets';
import { card, D, fin, foot, L, meter, rangeControl, tAccount, x0, type RangeDays } from './common';
import type { LedgerView } from './treasury';

interface Borrower {
  ref: number;
  name: string;
  kind: 'firm' | 'person';
  purpose: string;
  principal: number;
  rate: number;
  overdue: number;
  loans: number;
}

const PURPOSE: Record<LoanPurpose, string> = {
  working: 'cash',
  invest: 'tools',
  startup: 'new firm',
  house: 'house',
  project: 'building',
};

const REASONS: Record<string, string> = {
  failed: 'the Bank has failed',
  capital: 'not enough Bank capital',
  leverage: 'borrower too indebted',
  coverage: 'income too thin to repay',
  ratecap: 'rate limit too low for the risk',
  overdue: 'already behind on payments',
  gone: 'borrower gone',
  small: 'too small',
};

function tag(el: HTMLElement, cls: string): HTMLElement {
  el.classList.add(cls);
  return el;
}

function safe<T>(f: () => T, d: T): T {
  try {
    const v = f();
    return v;
  } catch {
    return d;
  }
}

export function createBankView(): LedgerView {
  let range: RangeDays = 360;
  let sig = '';
  let lastS: SimState | null = null;

  const banner = h('div', { class: 'ldg-banner', hidden: true });

  const tiles = {
    cap: kpi({ label: 'Capital ratio', format: (v) => fmtPct(v, 1), good: 'up', hint: 'The Bank’s own capital (equity) as a share of its loans. Below its minimum it must refuse new loans; below zero it has failed.' }),
    res: kpi({ label: 'Reserves', format: fmtMoneyShort, hint: 'Money the Bank keeps with the Treasury. When it holds less than the requirement it borrows the rest at the window.' }),
    loanRate: kpi({ label: 'Loan rate', format: fmtRate, hint: 'Average annual rate on the Bank’s loans, weighted by size.' }),
    depRate: kpi({ label: 'Deposit rate', format: fmtRate, hint: 'Annual rate the Bank pays on every deposit (every private balance of money).' }),
  };

  const bs = tAccount('Assets', 'Liabilities & equity', fmtMoneyShort);
  const bsNote = h('p', { class: 'note ldg-foot' });

  const stance = meter('Lending stance', 'How strict the Bank is when it judges a loan request. It tightens quickly after losses or when capital runs thin, and relaxes slowly.');
  const capMeter = meter('Capital vs its minimum', 'Equity as a share of loans, against the minimum the Bank (or a Limit) requires.');
  const resMeter = meter('Reserves vs the requirement', 'Reserves as a share of deposits, against the minimum share a Limit requires (if any).');
  const todayKv = h('div');
  const reasonsEl = h('div', { class: 'ldg-reasons' });
  const ratesKv = h('div');

  const borrowers = table<Borrower>({
    columns: [
      { key: 'name', label: 'Borrower', align: 'left', width: '37%', value: (b) => b.name },
      { key: 'purpose', label: 'For', align: 'left', width: '17%', title: 'What the loan paid for', value: (b) => b.purpose },
      { key: 'principal', label: 'Owes', width: '18%', value: (b) => b.principal, format: (v: number) => fmtMoneyShort(v) },
      { key: 'rate', label: 'Rate', width: '14%', title: 'Annual rate', value: (b) => b.rate, format: (v: number) => fmtPct(v, 1) },
      { key: 'overdue', label: 'Late', width: '14%', title: 'Days a payment has been missed', value: (b) => b.overdue, format: (v: number) => (v > 0 ? v + 'd' : '·'), tone: (b) => (b.overdue >= 30 ? 'bad' : b.overdue > 0 ? 'warn' : null) },
    ],
    rowKey: (b) => b.ref,
    onRowClick: (b) => select(b.kind === 'firm' ? { kind: 'firm', id: b.ref - FIRM_BASE } : { kind: 'person', id: b.ref }),
    sort: { key: 'principal', dir: -1 },
    dense: true,
    maxHeight: 250,
    empty: 'The Bank has no loans outstanding',
  });
  const borrowSub = h('span');

  const rangeCtl = rangeControl(range, (v) => {
    range = v;
    sig = '';
  });
  const chart = lineChart({ height: 160, format: fmtMoneyShort, tickFormat: (v) => fmtMoneyShort(v).replace('.00', ''), label: 'Bank loans and capital' });

  const el = h(
    'div',
    { class: 'ldg-view' },
    banner,
    tag(kpiGrid(Object.values(tiles), 4), 'ldg-k4'),
    card('Balance sheet', 'assets = liabilities + equity', null, bs.el, bsNote),
    card('Lending', 'today', null, h('div', { class: 'ldg-meters' }, stance.el, capMeter.el, resMeter.el), todayKv, reasonsEl),
    card('Rates', 'annual', null, ratesKv),
    card('Largest borrowers', borrowSub, null, borrowers.el),
    card('Loans and capital', 'end of each day', rangeCtl.el, chart.el),
  );

  function update(s: SimState, force: boolean): void {
    const nsig = `${s.day}|${range}|${s.bank?.failed}`;
    if (!force && nsig === sig && lastS === s) return;
    sig = nsig;
    lastS = s;
    const b = s.bank;
    const t = s.treasury;
    if (!b) return;

    // live aggregates (the balance sheet must balance today, not yesterday)
    let loans = 0;
    let wRate = 0;
    const by = new Map<number, Borrower>();
    for (const ln of s.loans ?? []) {
      if (!ln || !ln.active) continue;
      const p = Math.max(0, fin(ln.principal));
      loans += p;
      wRate += p * fin(ln.rate);
      let e = by.get(ln.borrower);
      if (!e) {
        const isFirm = ln.borrower >= FIRM_BASE;
        e = { ref: ln.borrower, name: safe(() => refName(s, ln.borrower), '—'), kind: isFirm ? 'firm' : 'person', purpose: PURPOSE[ln.purpose] ?? ln.purpose, principal: 0, rate: 0, overdue: 0, loans: 0 };
        by.set(ln.borrower, e);
      } else if (e.purpose !== (PURPOSE[ln.purpose] ?? ln.purpose)) e.purpose = 'several';
      e.rate = (e.rate * e.principal + fin(ln.rate) * p) / Math.max(1e-9, e.principal + p);
      e.principal += p;
      e.overdue = Math.max(e.overdue, fin(ln.overdue));
      e.loans++;
    }
    let deposits = fin(s.foreign?.coin);
    for (const p of s.people ?? []) if (p && p.alive) deposits += fin(p.cash);
    for (const f of s.firms ?? []) if (f && f.alive) deposits += fin(f.cash);
    const reserves = fin(b.reserves);
    const iouBook = fin(b.iouBook);
    const iouMkt = fin(b.iou) * fin(s.iouMarket?.price);
    const windowDebt = fin(b.windowDebt);
    const equity = fin(b.equity);
    const capRatio = loans > 0 ? equity / loans : NaN;
    const capMin = safe(() => minCapital(s), BANK_MIN_CAPITAL);
    const reqRes = safe(() => requiredReserves(s, deposits), 0);
    const avgLoan = loans > 0 ? wRate / loans : fin(b.baseRate, NaN);

    // banner
    banner.hidden = !b.failed;
    if (b.failed) {
      const left = Math.max(0, BANK_FAIL_GRACE_DAYS - fin(b.failedDays));
      replace(
        banner,
        icon('warning', 18),
        h(
          'div',
          null,
          h('div', { class: 'ldg-banner-title' }, 'The Bank has failed'),
          h(
            'div',
            { class: 'ldg-banner-text' },
            `Its losses exceed its own capital by ${fmtMoneyShort(-equity)}, so it makes no new loans. `,
            left > 0
              ? `If no new capital arrives within ${left} day${left === 1 ? '' : 's'}, every balance at the Bank will be cut to cover the hole. `
              : 'Balances at the Bank are about to be cut to cover the hole. ',
            'Money transferred to the Bank counts as new capital.',
          ),
        ),
      );
    }

    // tiles
    const capD = D(s, 'capRatio');
    tiles.cap.set(capRatio, { sub: `min ${fmtPct(capMin, 1)}`, tone: !(capRatio >= 0) ? 'bad' : capRatio < capMin ? 'warn' : null, delta: capD.length > 30 && Number.isFinite(capRatio) ? capRatio - capD[capD.length - 31] : null, deltaFormat: (d) => (d >= 0 ? '+' : '−') + (Math.abs(d) * 100).toFixed(1) + ' pts' });
    tiles.res.set(reserves, { sub: reqRes > 0 ? `need ${fmtMoneyShort(reqRes)}` : 'no minimum', tone: reqRes > 0 && reserves < reqRes ? 'warn' : null });
    tiles.loanRate.set(avgLoan, { sub: `base ${fmtPct(b.baseRate, 1)}` });
    tiles.depRate.set(fin(b.depositRate, NaN), { sub: `window ${fmtPct(t?.reserveRate, 1)}` });

    // balance sheet
    const assets = [
      { key: 'res', label: 'Reserves', sub: 'at the Treasury', value: reserves, hint: 'Money the Bank keeps on deposit with the Treasury, earning the reserve rate.', color: SERIES[6] },
      { key: 'loans', label: 'Loans', sub: `${by.size} borrower${by.size === 1 ? '' : 's'}`, value: loans, hint: 'What firms and households owe the Bank. Each loan created a deposit when it was made.', color: SERIES[0] },
      { key: 'iou', label: 'IOUs', sub: fin(b.iou) > 0 ? `${fmtNum(b.iou)} · market ${fmtMoneyShort(iouMkt)}` : 'none held', value: iouBook, hint: 'IOUs the Bank bought, at what it paid for them. The market value shows what they would fetch today.', color: SERIES[4] },
    ];
    const liabs = [
      { key: 'dep', label: 'Deposits', sub: 'the realm’s money', value: deposits, hint: 'Every private balance of money is a deposit at the Bank: households, firms and the foreign merchants’ desk.', color: SERIES[2] },
      { key: 'win', label: 'Window debt', sub: `at ${fmtPct(t?.lendRate, 1)}`, value: windowDebt, hint: 'What the Bank borrowed from the Treasury at the window.', color: SERIES[1] },
      { key: 'eq', label: 'Equity', sub: 'its own capital', value: equity, hint: 'What is left for the Bank’s owner: assets less what it owes. Losses on bad loans eat into it first.', color: T.gold, tone: equity < 0 ? ('bad' as const) : null },
    ];
    const aTot = reserves + loans + iouBook;
    const lTot = deposits + windowDebt + equity;
    bs.set(assets, liabs, { leftTotal: aTot, rightTotal: lTot, scale: Math.max(aTot, deposits + windowDebt + Math.max(0, equity)) });
    const gap = iouMkt - iouBook;
    const parts: string[] = [];
    if (fin(b.iou) > 0 && Math.abs(gap) > 0.5) parts.push(`At today’s IOU price its IOUs are worth ${fmtMoneyShort(Math.abs(gap))} ${gap >= 0 ? 'more' : 'less'} than it paid — a gain or loss it has not yet taken.`);
    parts.push(`Each loan the Bank makes adds a deposit, so lending creates money; repayments destroy it.`);
    setText(bsNote, parts.join(' '));

    // lending
    const st = Math.max(0, Math.min(1, fin(b.stance)));
    stance.set(st, { max: 1, text: st < 0.25 ? 'Loose' : st < 0.5 ? 'Normal' : st < 0.8 ? 'Cautious' : 'Tight', tone: st >= 0.8 ? 'warn' : null });
    capMeter.set(Math.max(0, capRatio), { max: Math.max(0.25, capMin * 2.5, Number.isFinite(capRatio) ? capRatio * 1.15 : 0), mark: capMin, markLabel: 'min', text: Number.isFinite(capRatio) ? fmtPct(capRatio, 1) : '—', tone: !(capRatio >= 0) ? 'bad' : capRatio < capMin ? 'warn' : 'good' });
    const resRatio = deposits > 0 ? reserves / deposits : NaN;
    const reqRatio = deposits > 0 ? reqRes / deposits : 0;
    resMeter.set(resRatio, { max: Math.max(0.2, reqRatio * 2.5, Number.isFinite(resRatio) ? resRatio * 1.15 : 0), mark: reqRatio > 0 ? reqRatio : undefined, markLabel: 'min', text: Number.isFinite(resRatio) ? fmtPct(resRatio, 1) + ' of deposits' : '—', tone: reqRatio > 0 && resRatio < reqRatio ? 'warn' : null });

    const dec = safe(() => lastLoanDecisions(s), { day: -1, items: [] });
    const fresh = dec.day === s.day - 1 || dec.day === s.day;
    let lent = 0;
    const refused = new Map<string, number>();
    if (fresh) {
      for (const d of dec.items) {
        lent += fin(d.amount);
        if (!(d.amount > 0) && d.reason) refused.set(d.reason, (refused.get(d.reason) ?? 0) + 1);
      }
    }
    replace(
      todayKv,
      kvList([
        ['Loans approved', `${fmtNum(b.approved)}${lent > 0 ? ' · ' + fmtMoneyShort(lent) : ''}`, b.approved > 0 ? 'good' : undefined],
        ['Requests refused', fmtNum(b.rejected), b.rejected > 0 ? 'warn' : undefined],
        ['Waiting for an answer', fmtNum(b.requests?.length ?? 0)],
        ['Lost to defaults today', fmtMoneyShort(fin(L(s, 'writeoffs'), 0)), fin(L(s, 'writeoffs')) > 0.5 ? 'bad' : undefined],
        ['Written off in all', fmtMoneyShort(b.writeoffs)],
        ['Interest earned · paid', `${fmtMoneyShort(b.interestIn)} · ${fmtMoneyShort(b.interestOut)}`],
        ['Profit this month', fmtMoneyShort(b.profitMonth), fin(b.profitMonth) < 0 ? 'bad' : undefined],
      ]),
    );
    if (refused.size) {
      const items = [...refused.entries()].sort((a, c) => c[1] - a[1]);
      replace(reasonsEl, h('span', { class: 'ldg-reasons-lab' }, 'Refused because: '), items.map(([r, n], i) => h('span', { class: 'ldg-reason' }, `${REASONS[r] ?? r} (${n})${i < items.length - 1 ? ', ' : ''}`)));
      reasonsEl.hidden = false;
    } else reasonsEl.hidden = true;

    replace(
      ratesKv,
      kvList([
        ['Treasury pays on reserves', fmtRate(t?.reserveRate), 'gold'],
        ['Treasury charges at the window', fmtRate(t?.lendRate), 'gold'],
        ['Bank’s base rate', fmtRate(b.baseRate)],
        ['Average loan rate', fmtRate(avgLoan)],
        ['Paid on deposits', fmtRate(b.depositRate)],
        ['Interest on loans, a year', fmtMoneyShort(wRate)],
      ]),
    );

    // borrowers
    const list = [...by.values()];
    borrowers.set(list);
    setText(borrowSub, list.length ? `${list.length} borrower${list.length === 1 ? '' : 's'} · ${fmtMoneyShort(loans)} in all · click to inspect` : '');

    // history
    chart.set(
      [
        { label: 'Loans', key: 'credit', data: D(s, 'credit'), color: SERIES[0], area: true },
        { label: 'Equity', key: 'eq', data: D(s, 'bankEquity'), color: T.gold },
        { label: 'Window debt', key: 'win', data: D(s, 'windowDebt'), color: SERIES[1], dashed: true },
      ],
      { x0: x0(s), window: range, zero: true, empty: 'Figures start with the first day of your reign' },
    );
  }

  return { el, update };
}
