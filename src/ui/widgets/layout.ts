// ============================================================================
// Layout helpers for panels, so every tab shares one rhythm:
//
//   el.append(
//     panelHeader('Markets', 'Kingsbridge · Bread'),
//     section('Today', curve.el),
//     section('History', card('Price', 'base price, 360 days', chart.el)),
//     kvList([['Buyers pay', '¤4.40'], ['Sellers get', '¤4.00', 'gold']]),
//   );
// ============================================================================
import { h, type Child } from '../dom';
import type { Tone } from './kpi';

/** Panel title row (large) with an optional muted subtitle and right-side actions. */
export function panelHeader(title: string, sub?: Child, ...actions: Child[]): HTMLElement {
  return h(
    'div',
    { class: 'panel-head' },
    h('div', { class: 'panel-title' }, title),
    sub ? h('div', { class: 'card-sub' }, sub) : null,
    actions.length ? h('div', { class: 'row', style: 'margin-left:auto' }, ...actions) : null,
  );
}

/** A titled section (gold small-caps rule) holding any content. */
export function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'section' }, h('h3', { class: 'section-title' }, title), ...children);
}

/** A card with a title, optional subtitle, and content. */
export function card(title: string | null, sub: Child | null, ...children: Child[]): HTMLElement {
  return h(
    'div',
    { class: 'card' },
    title || sub ? h('div', { class: 'card-head' }, title ? h('div', { class: 'card-title' }, title) : null, sub ? h('div', { class: 'card-sub' }, sub) : null) : null,
    ...children,
  );
}

/** Label/value rows ("Buyers pay … ¤4.40"); values are tabular and may carry a tone. */
export function kvList(rows: [label: Child, value: Child, tone?: Tone][]): HTMLElement {
  return h(
    'div',
    { class: 'kv' },
    rows.map(([l, v, t]) => h('div', { class: 'kv-row' }, h('span', { class: 'kv-lab' }, l), h('span', { class: 'kv-val' + (t ? ' ' + t : '') }, v))),
  );
}

/** A muted explanatory paragraph. */
export function note(text: Child): HTMLElement {
  return h('p', { class: 'note' }, text);
}

/** An empty-state block ("No standing orders yet."). */
export function emptyState(text: Child, action?: Child): HTMLElement {
  return h('div', { class: 'empty' }, h('div', null, text), action ?? null);
}
