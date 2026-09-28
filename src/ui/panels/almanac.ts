// ============================================================================
// Almanac panel — how the realm works, in long-form type.
//   Chapters from almanacContent.ts (simple markup, see almanac/markup.ts), a
//   chapter nav, a search box that shows every matching section in full with
//   the words highlighted, and reference tables generated from the game data
//   (Goods, Workshops — almanac/reference.ts).
// Static content: update() does nothing.
// ============================================================================
import './almanac/almanac.css';
import type { Panel } from '../panel';
import { h, setText, toggleClass } from '../dom';
import { textInput } from '../widgets';
import { ALMANAC, type AlmanacChapter } from './almanacContent';
import { highlighter, plainText, renderBody, type Highlight } from './almanac/markup';
import { goodsTable, referenceIndex, workshopsTable, type RefRow } from './almanac/reference';

const REFS = [
  { id: 'ref-goods', title: 'Goods', lead: 'Every good in the realm: who makes it, from what, who uses it, whether it keeps, and whether foreign ships will carry it.' },
  { id: 'ref-workshops', title: 'Workshops', lead: 'Every trade: what a worker makes in a day, how many one building holds, the tools each worker needs, where it can stand, and what it takes to build a new one.' },
];

let current = ALMANAC[0]?.id ?? 'ref-goods';
let query = '';
let article: HTMLElement;
let navBtns = new Map<string, HTMLButtonElement>();
let countEl: HTMLElement;
let refIndex: RefRow[] | null = null;

function scrollPanelTo(el: HTMLElement | null, flash = false): void {
  const panel = article?.closest('.panel') as HTMLElement | null;
  if (!panel) return;
  if (!el) {
    panel.scrollTo({ top: 0 });
    return;
  }
  requestAnimationFrame(() => {
    const top = el.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - 10;
    panel.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    if (flash) {
      el.classList.remove('alm-flash');
      void el.offsetWidth;
      el.classList.add('alm-flash');
      setTimeout(() => el.classList.remove('alm-flash'), 1600);
    }
  });
}

function open(id: string, sectionIndex?: number, refRow?: string): void {
  current = id;
  query = '';
  searchCtl?.set('');
  render();
  if (refRow) scrollPanelTo(article.querySelector<HTMLElement>(`[data-ref="${refRow}"]`), true);
  else if (sectionIndex !== undefined) scrollPanelTo(article.querySelector<HTMLElement>(`[data-sec="${sectionIndex}"]`), true);
  else scrollPanelTo(null);
}

function paintNav(): void {
  for (const [id, b] of navBtns) {
    const on = !query && id === current;
    toggleClass(b, 'on', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  }
}

function chapterView(ch: AlmanacChapter, idx: number, hl: Highlight): HTMLElement {
  const sections = ch.sections.map((sec, i) =>
    h('section', { class: 'alm-sec', dataset: { sec: i } }, h('h3', { class: 'alm-h' }, sec.title), h('div', { class: 'alm-body' + (i === 0 ? ' alm-first' : '') }, renderBody(sec.body, hl))),
  );
  const prev = idx > 0 ? ALMANAC[idx - 1] : null;
  const next = idx < ALMANAC.length - 1 ? ALMANAC[idx + 1] : null;
  const nextRef = !next ? REFS[0] : null;
  return h(
    'article',
    { class: 'alm-chapter' },
    h('div', { class: 'alm-chap-kicker' }, `Chapter ${idx + 1} of ${ALMANAC.length}`),
    h('h2', { class: 'alm-chap-title' }, ch.title),
    ch.sections.length > 1
      ? h(
          'nav',
          { class: 'alm-toc', 'aria-label': 'In this chapter' },
          ch.sections.map((sec, i) => h('button', { class: 'alm-toc-item', type: 'button', onClick: () => scrollPanelTo(article.querySelector<HTMLElement>(`[data-sec="${i}"]`), true) }, sec.title)),
        )
      : null,
    sections,
    h(
      'div',
      { class: 'alm-pager' },
      prev ? h('button', { class: 'alm-page prev', type: 'button', onClick: () => open(prev.id) }, h('span', { class: 'alm-page-lab' }, 'Previous'), h('span', { class: 'alm-page-t' }, '← ' + prev.title)) : h('span'),
      next
        ? h('button', { class: 'alm-page next', type: 'button', onClick: () => open(next.id) }, h('span', { class: 'alm-page-lab' }, 'Next'), h('span', { class: 'alm-page-t' }, next.title + ' →'))
        : nextRef
          ? h('button', { class: 'alm-page next', type: 'button', onClick: () => open(nextRef.id) }, h('span', { class: 'alm-page-lab' }, 'Reference'), h('span', { class: 'alm-page-t' }, nextRef.title + ' →'))
          : h('span'),
    ),
  );
}

function referenceView(id: string, hl: Highlight): HTMLElement {
  const r = REFS.find((x) => x.id === id) ?? REFS[0];
  return h(
    'article',
    { class: 'alm-chapter alm-refpage' },
    h('div', { class: 'alm-chap-kicker' }, 'Reference'),
    h('h2', { class: 'alm-chap-title' }, r.title),
    h('p', { class: 'alm-p alm-lead' }, r.lead),
    r.id === 'ref-goods' ? goodsTable(hl) : workshopsTable(hl),
    r.id === 'ref-goods'
      ? h('p', { class: 'alm-p alm-small' }, 'Furniture does not spoil in store, but a household’s furniture slowly wears out at home. Tools wear out with use at every workplace. Food that spoils is simply lost — whoever holds it bears the loss.')
      : h('p', { class: 'alm-p alm-small' }, 'Each site has limits: every extra worker adds a little less than the one before. Mines, wells, camps and fisheries do better on rich ground; farms on fertile soil. A building can be expanded by a level at half the cost of a new one.'),
  );
}

function searchView(q: string): HTMLElement {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hl = highlighter(q);
  const groups: HTMLElement[] = [];
  let hits = 0;
  ALMANAC.forEach((ch) => {
    const secs: HTMLElement[] = [];
    ch.sections.forEach((sec, i) => {
      const text = (sec.title + ' ' + plainText(sec.body) + ' ' + ch.title).toLowerCase();
      if (!words.every((w) => text.includes(w))) return;
      hits++;
      secs.push(
        h(
          'section',
          { class: 'alm-sec alm-hit' },
          h('button', { class: 'alm-hit-open', type: 'button', title: 'Open this chapter here', onClick: () => open(ch.id, i) }, h('span', { class: 'alm-hit-chap' }, ch.title), h('span', { class: 'alm-hit-go' }, 'open →')),
          h('h3', { class: 'alm-h' }, highlightNode(sec.title, hl)),
          h('div', { class: 'alm-body' }, renderBody(sec.body, hl)),
        ),
      );
    });
    if (secs.length) groups.push(...secs);
  });
  refIndex ??= referenceIndex();
  const refs = refIndex.filter((r) => words.every((w) => r.text.includes(w)));
  hits += refs.length;
  const refBox = refs.length
    ? h(
        'div',
        { class: 'alm-refhits' },
        h('div', { class: 'alm-refhits-lab' }, 'In the reference tables'),
        h(
          'div',
          { class: 'alm-refhits-row' },
          refs.map((r) => h('button', { class: 'chip alm-refchip', type: 'button', onClick: () => open(r.kind === 'good' ? 'ref-goods' : 'ref-workshops', undefined, `${r.kind}:${r.id}`) }, `${r.kind === 'good' ? 'Good' : 'Workshop'} · ${r.name}`)),
        ),
      )
    : null;
  setText(countEl, hits ? `${hits} ${hits === 1 ? 'match' : 'matches'}` : 'no matches');
  return h(
    'div',
    { class: 'alm-results' },
    refBox,
    groups.length ? groups : !refs.length ? h('div', { class: 'empty' }, `Nothing in the Almanac mentions “${q}”.`, h('div', { class: 'faint' }, 'Try a single word: bread, loan, window, levy, wagon…')) : null,
  );
}

function highlightNode(text: string, hl: Highlight): HTMLElement {
  const span = h('span');
  if (!hl) {
    span.textContent = text;
    return span;
  }
  hl.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = hl.exec(text))) {
    if (m.index > last) span.appendChild(document.createTextNode(text.slice(last, m.index)));
    span.appendChild(h('mark', { class: 'alm-mark' }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) span.appendChild(document.createTextNode(text.slice(last)));
  return span;
}

function render(): void {
  if (!article) return;
  const q = query.trim();
  paintNav();
  toggleClass(article.parentElement as HTMLElement, 'searching', q.length >= 2);
  if (q.length >= 2) {
    article.replaceChildren(searchView(q));
    return;
  }
  setText(countEl, '');
  const idx = ALMANAC.findIndex((c) => c.id === current);
  if (idx >= 0) article.replaceChildren(chapterView(ALMANAC[idx], idx, null));
  else article.replaceChildren(referenceView(current, null));
}

let searchCtl: ReturnType<typeof textInput> | null = null;

export const almanacPanel: Panel = {
  id: 'almanac',
  title: 'Almanac',
  mount(el) {
    searchCtl = textInput({
      value: '',
      placeholder: 'Search the Almanac…',
      onChange: (v) => {
        query = v;
        render();
        if (!v) scrollPanelTo(null);
      },
    });
    searchCtl.input.type = 'search';
    searchCtl.input.classList.add('alm-search');
    searchCtl.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && searchCtl?.input.value) {
        e.stopPropagation();
        searchCtl.set('');
        searchCtl.input.value = '';
        query = '';
        render();
      }
    });
    countEl = h('span', { class: 'alm-count' });
    navBtns = new Map();
    const chapterBtns = ALMANAC.map((ch, i) => {
      const b = h('button', { class: 'alm-nav-item', type: 'button', onClick: () => open(ch.id) }, h('span', { class: 'alm-nav-n' }, String(i + 1)), h('span', { class: 'alm-nav-t' }, ch.title));
      navBtns.set(ch.id, b);
      return b;
    });
    const refBtns = REFS.map((r) => {
      const b = h('button', { class: 'alm-nav-item alm-nav-ref', type: 'button', onClick: () => open(r.id) }, h('span', { class: 'alm-nav-n' }, '§'), h('span', { class: 'alm-nav-t' }, r.title));
      navBtns.set(r.id, b);
      return b;
    });
    article = h('div', { class: 'alm-article' });
    el.appendChild(
      h(
        'div',
        { class: 'alm' },
        h(
          'header',
          { class: 'alm-head' },
          h('div', { class: 'alm-kicker' }, 'The Almanac'),
          h('h1', { class: 'alm-title' }, 'How the realm works'),
          h('p', { class: 'alm-intro' }, 'Plain notes on the mechanics of markets, money, work and the outside world. It tells you how things move — never what to do.'),
        ),
        h('div', { class: 'alm-searchrow' }, searchCtl.el, countEl),
        h('nav', { class: 'alm-nav', 'aria-label': 'Chapters' }, h('div', { class: 'alm-nav-grid' }, chapterBtns), h('div', { class: 'alm-nav-lab' }, 'Reference'), h('div', { class: 'alm-nav-grid alm-nav-refs' }, refBtns)),
        article,
      ),
    );
    render();
  },
  update() {
    /* static content */
  },
};
