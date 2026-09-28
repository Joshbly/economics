// ============================================================================
// News ticker (bottom bar) + expandable news log. Reads ui.game.s.news
// (newest last, capped by the sim). The newest item slides in; clicking the
// ticker opens the log, grouped by month and filterable by kind. Unread count
// = items newer than the newest one seen when the log was last open.
// ============================================================================
import { MONTH_NAMES, monthOf, yearOf } from '../../sim/calendar';
import type { NewsItem, NewsKind } from '../../sim/types';
import { h, listen, replace, setText } from '../dom';
import { fmtDay } from '../format';
import { ui } from '../uiState';
import { segmented } from './controls';
import { icon } from './icons';

export interface NewsTicker {
  el: HTMLElement;
  update(): void;
  openLog(): void;
  /** Close the log; returns true if it was open. */
  closeLog(): boolean;
  readonly logOpen: boolean;
}

type Filter = 'all' | 'alarm' | 'market' | 'policy' | 'other';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'alarm', label: 'Alarms' },
  { value: 'market', label: 'Markets' },
  { value: 'policy', label: 'Treasury' },
  { value: 'other', label: 'Other' },
];

function matches(k: NewsKind, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'alarm') return k === 'crisis' || k === 'bad';
  if (f === 'market') return k === 'market';
  if (f === 'policy') return k === 'policy';
  return k === 'good' || k === 'info';
}

const keyOf = (n: NewsItem | undefined) => (n ? `${n.day}|${n.text}` : '');

export function createNewsTicker(): NewsTicker {
  const track = h('div', { class: 'ticker-track', title: 'Click to read all the news', onClick: () => (open ? closeLog() : openLog()) });
  const badge = h('span', { class: 'ticker-badge', hidden: true });
  const more = h('button', { class: 'btn btn-ghost btn-sm ticker-more', type: 'button', onClick: () => (open ? closeLog() : openLog()) }, icon('news', 15), 'All news', badge);
  const el = h('footer', { class: 'ticker' }, h('span', { class: 'ticker-label' }, 'NEWS'), track, more);

  let shownKey = '';
  let current: HTMLElement | null = null;
  let seenKey = '';
  let open = false;
  let filter: Filter = 'all';
  let logSig = '';

  // ---- log drawer --------------------------------------------------------------
  const list = h('div', { class: 'newslog-list' });
  const seg = segmented<Filter>({
    options: FILTERS,
    value: 'all',
    size: 'sm',
    onChange: (v) => {
      filter = v;
      logSig = '';
      renderLog();
    },
  });
  const log = h(
    'div',
    { class: 'newslog', role: 'dialog', 'aria-label': 'News log' },
    h('div', { class: 'newslog-head' }, h('span', { class: 'newslog-title' }, 'News of the realm'), h('span', { class: 'spacer' }), seg.el, h('button', { class: 'icon-btn', type: 'button', title: 'Close (Esc)', onClick: () => closeLog() }, icon('close', 15))),
    list,
  );
  let offOutside: (() => void) | null = null;

  function openLog(): void {
    if (open) return;
    open = true;
    if (!log.isConnected) document.body.appendChild(log);
    logSig = '';
    renderLog();
    requestAnimationFrame(() => log.classList.add('on'));
    markSeen();
    offOutside = listen(document, 'pointerdown', (e) => {
      const t = e.target as Node;
      if (!log.contains(t) && !el.contains(t)) closeLog();
    }, true);
  }

  function closeLog(): boolean {
    if (!open) return false;
    open = false;
    log.classList.remove('on');
    offOutside?.();
    offOutside = null;
    return true;
  }

  function markSeen(): void {
    const news = ui.game?.s?.news ?? [];
    seenKey = keyOf(news[news.length - 1]);
    paintBadge(news);
  }

  function paintBadge(news: NewsItem[]): void {
    let unread = 0;
    if (seenKey) {
      for (let i = news.length - 1; i >= 0 && unread < 100; i--) {
        if (keyOf(news[i]) === seenKey) break;
        unread++;
      }
    } else unread = Math.min(100, news.length);
    badge.hidden = unread === 0 || open;
    setText(badge, unread >= 100 ? '99+' : String(unread));
  }

  function renderLog(): void {
    const s = ui.game?.s;
    const news = s?.news ?? [];
    const sig = `${news.length}|${keyOf(news[news.length - 1])}|${filter}`;
    if (sig === logSig) return;
    logSig = sig;
    const rows: HTMLElement[] = [];
    let lastMonth = -1;
    for (let i = news.length - 1; i >= 0; i--) {
      const n = news[i];
      if (!matches(n.kind, filter)) continue;
      const mi = Math.floor(n.day / 30);
      if (mi !== lastMonth) {
        lastMonth = mi;
        rows.push(h('div', { class: 'news-day' }, `${MONTH_NAMES[monthOf(n.day)]}, Year ${yearOf(n.day)}`));
      }
      const town = n.town >= 0 ? s?.towns?.[n.town]?.name : '';
      rows.push(
        h(
          'div',
          { class: 'news-row' },
          h('span', { class: 'nk nk-' + n.kind }),
          h('span', { class: 'ticker-date' }, fmtDay(n.day)),
          h('span', { class: 'news-text' }, n.text),
          town ? h('span', { class: 'news-town' }, '· ' + town) : null,
        ),
      );
    }
    if (!rows.length) rows.push(h('div', { class: 'news-empty' }, filter === 'all' ? 'No news yet.' : 'Nothing of this kind yet.'));
    replace(list, rows);
    list.scrollTop = 0;
  }

  // ---- ticker ------------------------------------------------------------------
  function update(): void {
    const news = ui.game?.s?.news ?? [];
    const newest = news[news.length - 1];
    const k = keyOf(newest);
    if (k !== shownKey) {
      shownKey = k;
      const item = h(
        'div',
        { class: 'ticker-item enter' },
        newest ? h('span', { class: 'nk nk-' + newest.kind }) : null,
        newest ? h('span', { class: 'ticker-date' }, fmtDay(newest.day)) : null,
        h('span', { class: 'ticker-text' }, newest ? newest.text : 'The realm is quiet.'),
      );
      track.appendChild(item);
      const prev = current;
      current = item;
      requestAnimationFrame(() => {
        item.classList.remove('enter');
        if (prev) {
          prev.classList.add('exit');
          setTimeout(() => prev.remove(), 400);
        }
      });
      if (newest) track.title = newest.text + ' — click to read all the news';
    }
    if (open) {
      renderLog();
      markSeen();
    } else paintBadge(news);
  }

  return {
    el,
    update,
    openLog,
    closeLog,
    get logOpen() {
      return open;
    },
  };
}

/** Reset the seen-marker (after a new game) — call update() afterwards. */
export function newsKey(n: NewsItem | undefined): string {
  return keyOf(n);
}
