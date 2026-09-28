// ============================================================================
// Inspector building blocks: the View contract, the hero header, stat tiles
// with sparklines, chip rows and a list of links.
// ============================================================================
import type { SimState } from '../../../sim/types';
import { h, setText, toggleClass, type Child } from '../../dom';
import { sparkline, T, type Sparkline, type Tone } from '../../widgets';
import { slot, type Slot } from './common';

export interface View {
  el: HTMLElement;
  update(s: SimState): void;
  destroy?(): void;
}

export type ChipSpec = [tone: Tone | '', text: string, title?: string];

/** A row of status chips, rebuilt only when their text/tones change. */
export function chipRow(cls = 'ins-chips'): { el: HTMLElement; set(chips: ChipSpec[]): void } {
  const el = h('div', { class: cls });
  let sig = '';
  return {
    el,
    set(chips) {
      const next = chips.map((c) => c.join('~')).join('|');
      if (next === sig) return;
      sig = next;
      el.replaceChildren(...chips.map(([tone, text, title]) => h('span', { class: 'chip' + (tone ? ' ' + tone : ''), title: title ?? null }, text)));
      el.hidden = chips.length === 0;
    },
  };
}

export interface Hero {
  el: HTMLElement;
  kicker(t: string): void;
  title(t: string): void;
  chips(c: ChipSpec[]): void;
  /** A line of text + links under the title. */
  sub: Slot;
}

export function hero(): Hero {
  const k = h('div', { class: 'ins-kicker' });
  const t = h('h2', { class: 'ins-title' });
  const chips = chipRow();
  const sub = slot('div', 'ins-sub');
  const el = h('div', { class: 'ins-hero' }, k, t, sub.el, chips.el);
  return {
    el,
    kicker: (x) => setText(k, x),
    title: (x) => setText(t, x),
    chips: (c) => chips.set(c),
    sub,
  };
}

export interface StatTile {
  el: HTMLElement;
  set(value: string, sub?: string, tone?: Tone, data?: ArrayLike<number>): void;
  label(t: string): void;
}

/** A compact figure tile (label · value · sub · optional sparkline). */
export function statTile(label: string, withSpark = false, hint?: string): StatTile {
  const lab = h('div', { class: 'ins-stat-lab' }, label);
  const val = h('div', { class: 'ins-stat-val' });
  const sub = h('div', { class: 'ins-stat-sub' });
  let sp: Sparkline | null = null;
  const el = h('div', { class: 'ins-stat', title: hint ?? null }, lab, val, sub);
  if (withSpark) {
    sp = sparkline({ height: 24 });
    el.appendChild(h('div', { class: 'ins-stat-spark' }, sp.el));
  }
  return {
    el,
    set(value, s, tone, data) {
      setText(val, value);
      for (const x of ['good', 'bad', 'warn', 'gold']) toggleClass(val, x, x === tone);
      setText(sub, s ?? '');
      sub.hidden = !s;
      if (sp && data) sp.set(data, tone === 'bad' ? T.bad : tone === 'good' ? T.good : T.ink1);
    },
    label: (t) => setText(lab, t),
  };
}

export function statStrip(tiles: StatTile[], cls = ''): HTMLElement {
  return h('div', { class: 'ins-stats' + (cls ? ' ' + cls : ''), style: { gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` } }, tiles.map((t) => t.el));
}

/** A wrapping list of links (workers, residents…), rebuilt when the id set changes. */
export function linkList(empty: string, max = 40): { el: HTMLElement; set(key: string, items: (() => Child)[], total?: number): void } {
  const el = h('div', { class: 'ins-links' });
  let sig: string | null = null;
  return {
    el,
    set(key, items, total) {
      if (key === sig) return;
      sig = key;
      if (!items.length) {
        el.replaceChildren(h('span', { class: 'faint' }, empty));
        return;
      }
      const shown = items.slice(0, max).map((b) => h('span', { class: 'ins-link-item' }, b()));
      const more = (total ?? items.length) - shown.length;
      if (more > 0) shown.push(h('span', { class: 'ins-link-item faint' }, `+${more} more`));
      el.replaceChildren(...shown);
    },
  };
}

/** A plain paragraph of explanation. */
export function para(text: Child, cls = 'ins-para'): HTMLElement {
  return h('p', { class: cls }, text);
}

/** "Missing" view for selections that no longer exist. */
export function goneView(text: string): View {
  return {
    el: h('div', { class: 'empty ins-gone' }, h('div', { class: 'strong' }, 'Not here any more'), h('div', null, text)),
    update() {},
  };
}
