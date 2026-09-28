// ============================================================================
// Ledger panel: the books of the realm, in four views.
//
//   Treasury        the Purse, what the Treasury holds and owes, income &
//                   spending by category, every levy rule's takings
//   Bank            the commercial Bank's balance sheet, lending, rates,
//                   largest borrowers
//   Money & credit  money, loans, reserves, IOUs; who created the money
//   National        output, spending, production, work, the port, shipping
//
// Only the visible view is refreshed, and only when a day has passed.
// ============================================================================
import './ledger/ledger.css';
import type { Panel } from '../panel';
import { h, setText } from '../dom';
import { fmtDayLong } from '../format';
import { on, ui } from '../uiState';
import { segmented, type Control } from '../widgets';
import { createBankView } from './ledger/bank';
import { createMoneyView } from './ledger/money';
import { createNationalView } from './ledger/national';
import { createTreasuryView, type LedgerView } from './ledger/treasury';

type ViewId = 'treasury' | 'bank' | 'money' | 'national';

const VIEWS: { id: ViewId; label: string; title: string }[] = [
  { id: 'treasury', label: 'Treasury', title: 'The Treasury’s own books: the Purse, income and spending, levy rules' },
  { id: 'bank', label: 'Bank', title: 'The commercial Bank: balance sheet, lending, rates, borrowers' },
  { id: 'money', label: 'Money & credit', title: 'Money, loans, reserves and IOUs — and who created the money' },
  { id: 'national', label: 'National', title: 'Output, spending, production, work, trade and shipping' },
];

let current: ViewId = 'treasury';
let views: Record<ViewId, LedgerView> | null = null;
let wraps: Record<ViewId, HTMLElement> | null = null;
let nav: Control<ViewId> | null = null;
let subEl: HTMLElement | null = null;
let force = true;

function showView(id: ViewId): void {
  current = id;
  force = true;
  if (wraps) for (const v of VIEWS) wraps[v.id].hidden = v.id !== id;
  nav?.set(id);
  const panel = wraps?.[id]?.closest('.panel');
  panel?.scrollTo({ top: 0 });
  try {
    localStorage.setItem('realmLedger.ledgerView', id);
  } catch {
    /* storage unavailable */
  }
}

export const ledgerPanel: Panel = {
  id: 'ledger',
  title: 'Ledger',
  mount(el) {
    try {
      const saved = localStorage.getItem('realmLedger.ledgerView') as ViewId | null;
      if (saved && VIEWS.some((v) => v.id === saved)) current = saved;
    } catch {
      /* storage unavailable */
    }
    views = { treasury: createTreasuryView(), bank: createBankView(), money: createMoneyView(), national: createNationalView() };
    wraps = {
      treasury: h('div', { class: 'ldg-wrap' }, views.treasury.el),
      bank: h('div', { class: 'ldg-wrap' }, views.bank.el),
      money: h('div', { class: 'ldg-wrap' }, views.money.el),
      national: h('div', { class: 'ldg-wrap' }, views.national.el),
    };
    nav = segmented<ViewId>({
      options: VIEWS.map((v) => ({ value: v.id, label: v.label, title: v.title })),
      value: current,
      full: true,
      onChange: (v) => {
        showView(v);
        ledgerPanel.update();
      },
    });
    subEl = h('div', { class: 'card-sub' });
    el.appendChild(
      h(
        'div',
        { class: 'ldg' },
        h('div', { class: 'panel-head ldg-head' }, h('div', { class: 'ldg-head-titles' }, h('div', { class: 'panel-title' }, 'Ledger'), subEl)),
        h('div', { class: 'ldg-nav' }, nav.el),
        ...VIEWS.map((v) => wraps![v.id]),
      ),
    );
    showView(current);
    on('newgame', () => (force = true));
  },
  show() {
    force = true;
  },
  update() {
    const s = ui.game?.s;
    if (!s || !views) return;
    setText(subEl!, `The books of the realm · closed ${fmtDayLong(Math.max(0, s.day - 1))}`);
    const f = force;
    force = false;
    views[current].update(s, f);
  },
};
