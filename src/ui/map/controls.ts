// ============================================================================
// The map's floating control strip (bottom-left): zoom, overlays, layers and
// the overlay legend. Reads and writes UI state only (never the simulation).
// ============================================================================
import { GOODS } from '../../sim/goods';
import { h, setText, toggleClass } from '../dom';
import { on, setOverlay, ui, type OverlayId } from '../uiState';
import { selectInput } from '../widgets/controls';
import { overlayLegend, overlayTitle } from './overlay';
import './map.css';

export interface MapControls {
  el: HTMLElement;
  /** Refresh from ui state (cheap; call at a few Hz). */
  sync(): void;
  destroy(): void;
}

const OVERLAYS: { value: OverlayId; label: string }[] = [
  { value: 'none', label: 'No overlay' },
  { value: 'price', label: 'Prices' },
  { value: 'unemployment', label: 'Without work' },
  { value: 'wealth', label: 'Wealth' },
  { value: 'health', label: 'Health' },
  { value: 'rent', label: 'Rent' },
];

function svg(path: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 20 20');
  s.setAttribute('width', '15');
  s.setAttribute('height', '15');
  s.setAttribute('aria-hidden', 'true');
  for (const d of path.split('|')) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.6');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    s.appendChild(p);
  }
  return s;
}

export function createControls(container: HTMLElement, act: { zoomIn(): void; zoomOut(): void; fit(): void }): MapControls {
  const btn = (title: string, icon: string, fn: () => void) => h('button', { class: 'mapc-btn', type: 'button', title, 'aria-label': title, onClick: fn }, svg(icon));
  const zoom = h(
    'div',
    { class: 'mapc-group' },
    btn('Zoom out (−)', 'M5 10h10', () => act.zoomOut()),
    btn('Zoom in (+)', 'M5 10h10|M10 5v10', () => act.zoomIn()),
    btn('Show the whole realm', 'M4 8V4h4|M12 4h4v4|M16 12v4h-4|M8 16H4v-4', () => act.fit()),
  );
  const overlaySel = selectInput<OverlayId>({ options: OVERLAYS, value: ui?.overlay ?? 'none', title: 'Colour the towns by…', onChange: (v) => setOverlay(v) });
  const goodSel = selectInput<number>({ options: GOODS.map((g) => ({ value: g.id, label: g.name })), value: ui?.overlayGood ?? 8, title: 'Which good’s price', onChange: (g) => setOverlay('price', g) });
  const chip = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const el = h('button', { class: 'mapc-chip', type: 'button', 'aria-pressed': 'true', onClick: () => set(!get()) }, h('span', { class: 'mapc-dot' }), label);
    return { el, get };
  };
  const people = chip(
    'People',
    () => !!ui?.showPeople,
    (v) => {
      if (ui) ui.showPeople = v;
      sync();
    },
  );
  const carts = chip(
    'Wagons',
    () => !!ui?.showCarts,
    (v) => {
      if (ui) ui.showCarts = v;
      sync();
    },
  );
  const layers = h('div', { class: 'mapc-group mapc-layers' }, people.el, carts.el);
  const ovl = h('div', { class: 'mapc-group mapc-ovl' }, overlaySel.el, goodSel.el);
  const legTitle = h('div', { class: 'mapc-leg-t' });
  const legA = h('span');
  const legB = h('span');
  const legend = h('div', { class: 'mapc-legend', hidden: true }, legTitle, h('div', { class: 'mapc-leg-bar' }), h('div', { class: 'mapc-leg-ends' }, legA, legB));
  const el = h('div', { class: 'mapc' }, h('div', { class: 'mapc-row' }, zoom, ovl, layers), legend);
  container.appendChild(el);
  // keep pointer interaction on the strip from reaching the map canvas
  for (const ev of ['pointerdown', 'wheel', 'dblclick']) el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });

  function sync(): void {
    if (!ui) return;
    overlaySel.set(ui.overlay);
    goodSel.set(ui.overlayGood);
    goodSel.el.hidden = ui.overlay !== 'price';
    for (const c of [people, carts]) {
      const onv = c.get();
      toggleClass(c.el, 'on', onv);
      c.el.setAttribute('aria-pressed', String(onv));
    }
    const show = ui.overlay !== 'none';
    legend.hidden = !show;
    if (show) {
      setText(legTitle, overlayTitle(ui.overlay, ui.overlayGood));
      const [a, b] = overlayLegend(ui.overlay);
      setText(legA, a);
      setText(legB, b);
    }
  }
  const offs = [on('overlay', sync), on('newgame', sync)];
  sync();
  return {
    el,
    sync,
    destroy() {
      for (const f of offs) f();
      el.remove();
    },
  };
}
