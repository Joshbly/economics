// ============================================================================
// Markets panel: every town's daily call auctions.
//
//   Overview  goods × towns matrix (price, 30-day change, sparkline, volume,
//             shortage/surplus badges) + the national IOU and gold markets
//   Detail    one market: tiles, price & volume history, today's supply and
//             demand, the same good in every town, who holds the stock, the
//             Treasury's rules and orders there, and shortcuts into Levers
//
// The focused market lives in ui.marketTown / ui.marketGood (focusMarket()).
// Any outside change of the focus (map click on a market, focusMarket from
// another panel) opens the detail view.
// ============================================================================
import './markets/markets.css';
import type { Panel } from '../panel';
import { h, setText } from '../dom';
import { fmtDay } from '../format';
import { focusMarket, on, ui, type Selection } from '../uiState';
import { button, hideTip, icon } from '../widgets';
import { openDesk } from './desk';
import { goodLabel, isGood, isInstrument } from './markets/data';
import { createDetail, type Detail } from './markets/detail';
import { createOverview, type Overview } from './markets/overview';

type View = 'overview' | 'detail';

let view: View = 'overview';
let seen = { town: 0, good: 8 };
let lastGood = 8;
let lastTown = 0;
let root: HTMLElement | null = null;
let overview: Overview | null = null;
let detail: Detail | null = null;
let subEl: HTMLElement | null = null;
let resumeBtn: HTMLButtonElement | null = null;
let resumeLab: HTMLElement | null = null;
let ovWrap: HTMLElement | null = null;
let dtWrap: HTMLElement | null = null;
let force = true;

/** The focused market, repaired if the UI state holds something invalid (e.g. a market hall with no good). */
function current(): { town: number; good: number } {
  const s = ui.game?.s;
  let g = ui.marketGood;
  let t = ui.marketTown;
  if (!isGood(g) && !isInstrument(g)) g = lastGood;
  if (isInstrument(g)) t = -1;
  else if (!s || !Number.isInteger(t) || t < -1 || t >= s.towns.length) t = lastTown;
  return { town: t, good: g };
}

function setView(v: View): void {
  hideTip();
  view = v;
  force = true;
  if (ovWrap) ovWrap.hidden = v !== 'overview';
  if (dtWrap) dtWrap.hidden = v !== 'detail';
  if (root) root.closest('.panel')?.scrollTo({ top: 0 });
}

function pick(town: number, good: number): void {
  lastGood = good;
  if (!isInstrument(good)) lastTown = town;
  seen = { town, good };
  focusMarket(town, good);
  setView('detail');
  marketsPanel.update();
}

export const marketsPanel: Panel = {
  id: 'markets',
  title: 'Markets',
  mount(el) {
    seen = { town: ui.marketTown, good: ui.marketGood };
    overview = createOverview((t, g) => pick(t, g));
    detail = createDetail({
      back: () => {
        setView('overview');
        marketsPanel.update();
      },
      pick: (t, g) => pick(t, g),
    });
    subEl = h('div', { class: 'card-sub' });
    resumeLab = h('span');
    resumeBtn = h('button', { class: 'mk-resume', type: 'button', title: 'Back to the market you were looking at', onClick: () => setView('detail') }, resumeLab, icon('chevronRight', 14));
    ovWrap = h('div', { class: 'mk-view' }, overview.el);
    dtWrap = h('div', { class: 'mk-view', hidden: true }, detail.el);
    root = h(
      'div',
      { class: 'mk' },
      h(
        'div',
        { class: 'panel-head mk-head' },
        h('div', { class: 'mk-head-titles' }, h('div', { class: 'panel-title' }, 'Markets'), subEl),
        h('div', { class: 'mk-head-btns' }, resumeBtn, button({ label: 'Trading desk', kind: 'ghost', size: 'sm', title: 'One good in every town at once: each town’s price on one chart, orders in every town, price brackets', onClick: () => openDesk(isGood(ui.marketGood) ? ui.marketGood : undefined) })),
      ),
      ovWrap,
      dtWrap,
    );
    el.appendChild(root);

    on('select', (payload) => {
      const sel = payload as Selection;
      if (sel && sel.kind === 'market') {
        if (isGood(sel.good) || isInstrument(sel.good)) lastGood = sel.good;
        if (Number.isInteger(sel.town) && sel.town >= 0) lastTown = sel.town;
        setView('detail');
      }
    });
    on('newgame', () => {
      force = true;
    });
  },
  show() {
    force = true;
  },
  update() {
    const s = ui.game?.s;
    if (!s || !overview || !detail) return;
    // an outside change of focus opens the detail view
    if (ui.marketTown !== seen.town || ui.marketGood !== seen.good) {
      seen = { town: ui.marketTown, good: ui.marketGood };
      if (view !== 'detail') setView('detail');
    }
    const c = current();
    if (c.good !== ui.marketGood || c.town !== ui.marketTown) {
      // repair (e.g. a market hall picked on the map carries no good)
      ui.marketGood = c.good;
      ui.marketTown = c.town;
      seen = { town: c.town, good: c.good };
    }
    if (isGood(c.good) || isInstrument(c.good)) lastGood = c.good;
    if (c.town >= 0) lastTown = c.town;
    setText(subEl!, `Auctions cleared ${fmtDay(Math.max(0, s.day - 1))}`);
    const where = isInstrument(c.good) ? 'national' : c.town >= 0 ? s.towns[c.town]?.name ?? '' : 'realm';
    setText(resumeLab!, `${goodLabel(c.good)} · ${where}`);
    resumeBtn!.hidden = view !== 'overview';
    const f = force;
    force = false;
    if (view === 'overview') {
      overview.setFocus(c.town, c.good);
      overview.update(s, f);
    } else detail.update(s, c.town, c.good, f);
  },
};
