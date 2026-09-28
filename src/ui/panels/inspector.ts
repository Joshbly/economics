// ============================================================================
// Inspect panel — the books of whatever is selected (ui.selection):
//   building → house block / workshop (→ firm view) / market hall / Palace /
//              Bank / Port, with construction progress where something is going up
//   firm     → workforce, making & selling, money & loans, stock, wagons or
//              project queue, workers — with sparklines of output, cash, price
//   person   → home, work, money, wellbeing, pantry, property
//   town     → figures, workshops by trade, market prices, homes, Treasury stores
// A toolbar offers Back (to the previous selection), Centre on map and Close.
// Views are built once per selection and updated in place.
// ============================================================================
import './inspector/inspector.css';
import type { SimState } from '../../sim/types';
import type { Panel } from '../panel';
import { h, setText } from '../dom';
import { select, ui, type Selection } from '../uiState';
import { button, icon } from '../widgets';
import { centreOn, selectionPos } from './inspector/common';
import { firmView, resetFirmRing } from './inspector/firmView';
import { goneView, type View } from './inspector/kit';
import { personView } from './inspector/personView';
import { marketHallView, placeView } from './inspector/placeView';
import { townView } from './inspector/townView';

let host: HTMLElement;
let toolbar: HTMLElement;
let kindEl: HTMLElement;
let backBtn: HTMLButtonElement;
let centreBtn: HTMLButtonElement;
let emptyEl: HTMLElement;
let quickEl: HTMLElement;
let view: View | null = null;
let viewKey = '';
let lastSel: Selection = null;
let history: NonNullable<Selection>[] = [];
let goingBack = false;
let gameRef: unknown = null;
let quickSig = '';

const sameSel = (a: Selection, b: Selection) => JSON.stringify(a) === JSON.stringify(b);

/** Identity of the view a selection needs (changes → the view is rebuilt). */
function keyOf(s: SimState, sel: Selection): string {
  if (!sel) return 'none';
  switch (sel.kind) {
    case 'building': {
      const b = s.buildings[sel.id];
      if (!b) return 'gone:b' + sel.id;
      const f = b.kind === 'firm' && b.firm >= 0 ? s.firms[b.firm] : undefined;
      if (f && f.alive && f.building === b.id && b.status === 'active') return `bf:${b.id}:${f.id}`;
      return `b:${b.id}:${b.kind}:${b.status}:${b.project}`;
    }
    case 'firm':
      return s.firms[sel.id] ? 'f:' + sel.id : 'gone:f' + sel.id;
    case 'person':
      return s.people[sel.id] ? 'p:' + sel.id : 'gone:p' + sel.id;
    case 'town':
      return s.towns[sel.id] ? 't:' + sel.id : 'gone:t' + sel.id;
    case 'market':
      return `m:${sel.town}:${sel.good}`;
  }
  return 'none';
}

function kindLabel(s: SimState, sel: Selection): string {
  if (!sel) return '';
  switch (sel.kind) {
    case 'building': {
      const b = s.buildings[sel.id];
      if (!b) return 'Building';
      if (b.kind === 'firm') return 'Workshop';
      return { house: 'House block', market: 'Market hall', bank: 'The Bank', palace: 'The Palace', port: 'The Port', firm: 'Workshop' }[b.kind] ?? 'Building';
    }
    case 'firm':
      return 'Workshop';
    case 'person':
      return 'Household';
    case 'town':
      return 'Town';
    case 'market':
      return 'Market';
  }
  return '';
}

function build(s: SimState, sel: Selection): View | null {
  if (!sel) return null;
  try {
    switch (sel.kind) {
      case 'building': {
        const b = s.buildings[sel.id];
        if (!b) return goneView('That building no longer stands.');
        const f = b.kind === 'firm' && b.firm >= 0 ? s.firms[b.firm] : undefined;
        if (f && f.alive && f.building === b.id && b.status === 'active') return firmView(s, f.id, true);
        return placeView(s, b);
      }
      case 'firm':
        return s.firms[sel.id] ? firmView(s, sel.id) : goneView('That workshop has closed and been wound up.');
      case 'person':
        return s.people[sel.id] ? personView(s, sel.id) : goneView('That household is no longer in the realm.');
      case 'town':
        return s.towns[sel.id] ? townView(s, sel.id) : goneView('No such town.');
      case 'market':
        return marketHallView(s, sel.town, sel.good);
    }
  } catch (e) {
    console.error('[inspect] view failed', e);
    return goneView('This could not be shown: ' + (e instanceof Error ? e.message : String(e)));
  }
  return null;
}

function paintQuick(s: SimState): void {
  const sig = (s.towns ?? []).map((t) => t.name).join('|');
  if (sig === quickSig) return;
  quickSig = sig;
  const find = (k: string) => s.buildings.find((b) => b && b.kind === k);
  const place = (k: string, label: string) => {
    const b = find(k);
    return b ? button({ label, size: 'sm', kind: 'secondary', onClick: () => pick({ kind: 'building', id: b.id }) }) : null;
  };
  quickEl.replaceChildren(
    h('div', { class: 'ins-quick-lab' }, 'Towns'),
    h('div', { class: 'ins-quick-row' }, (s.towns ?? []).map((t) => button({ label: t.name, size: 'sm', kind: 'secondary', onClick: () => pick({ kind: 'town', id: t.id }) }))),
    h('div', { class: 'ins-quick-lab' }, 'Institutions'),
    h('div', { class: 'ins-quick-row' }, place('palace', 'The Treasury'), place('bank', 'The Bank'), place('port', 'The Port')),
  );
}

function pick(sel: Selection): void {
  select(sel);
  const s = ui.game?.s;
  if (s) centreOn(s, sel);
}

export const inspectorPanel: Panel = {
  id: 'inspect',
  title: 'Inspect',
  mount(el) {
    backBtn = button({
      label: 'Back',
      kind: 'ghost',
      size: 'sm',
      icon: icon('chevronRight', 14),
      title: 'Back to what you were looking at before',
      onClick: () => {
        const prev = history.pop();
        if (!prev) return;
        goingBack = true;
        select(prev);
      },
    });
    backBtn.classList.add('ins-back');
    kindEl = h('span', { class: 'ins-kind' });
    centreBtn = button({
      label: 'Centre on map',
      kind: 'secondary',
      size: 'sm',
      icon: icon('target', 14),
      title: 'Pan the map to it',
      onClick: () => {
        const s = ui.game?.s;
        if (s && ui.selection) centreOn(s, ui.selection);
      },
    });
    const closeBtn = h('button', { class: 'icon-btn ins-close', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', onClick: () => select(null) }, icon('close', 16));
    toolbar = h('div', { class: 'ins-toolbar' }, backBtn, kindEl, h('span', { class: 'spacer' }), centreBtn, closeBtn);
    host = h('div', { class: 'ins-host' });
    quickEl = h('div', { class: 'ins-quick' });
    emptyEl = h(
      'div',
      { class: 'ins-empty' },
      h('div', { class: 'ins-empty-mark' }, icon('target', 30)),
      h('h2', { class: 'ins-empty-title' }, 'Look closer'),
      h('p', { class: 'ins-empty-text' }, 'Click anything on the map — a house, a workshop, a person walking to work, a market hall — and its books open here.'),
      h('p', { class: 'ins-empty-text faint' }, 'Names in any page are links too: follow a worker to their home, a workshop to its owner.'),
      quickEl,
    );
    el.appendChild(h('div', { class: 'ins-panel' }, toolbar, emptyEl, host));
  },
  update() {
    const s = ui.game?.s;
    if (!s || !host) return;
    if (gameRef !== s) {
      gameRef = s;
      history = [];
      lastSel = null;
      viewKey = '';
      quickSig = '';
    }
    const sel = ui.selection;
    // navigation history
    if (!sameSel(sel, lastSel)) {
      if (!goingBack && lastSel && sel && !sameSel(history[history.length - 1] ?? null, lastSel)) {
        history.push(lastSel);
        if (history.length > 30) history.shift();
      }
      if (!sel) history = [];
      goingBack = false;
      lastSel = sel;
    }
    const key = keyOf(s, sel);
    if (key !== viewKey) {
      viewKey = key;
      view?.destroy?.();
      view = build(s, sel);
      host.replaceChildren(...(view ? [view.el] : []));
      if (!sel || sel.kind !== 'firm' && !key.startsWith('bf:')) resetFirmRing();
      (host.closest('.panel') as HTMLElement | null)?.scrollTo({ top: 0 });
    }
    const has = !!sel;
    emptyEl.hidden = has;
    toolbar.hidden = !has;
    host.hidden = !has;
    if (!has) {
      paintQuick(s);
      return;
    }
    setText(kindEl, kindLabel(s, sel));
    backBtn.hidden = history.length === 0;
    centreBtn.disabled = !selectionPos(s, sel);
    try {
      view?.update(s);
    } catch (e) {
      console.error('[inspect] update failed', e);
    }
  },
};
