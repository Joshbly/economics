// ============================================================================
// Placeholder panel: a tidy "coming soon" page for a sidebar tab, used until a
// real panel replaces it in panels/index.ts. Shows what the tab will hold, and
// (for Inspect) the current selection.
// ============================================================================
import type { Panel } from '../panel';
import { h, replace, setText } from '../dom';
import { fmtDay } from '../format';
import { ui, type TabId } from '../uiState';

export interface PlaceholderInfo {
  /** Small caps line above the title. */
  kicker: string;
  /** Headline. */
  heading: string;
  /** One paragraph. */
  lead: string;
  /** What the finished panel will offer. */
  bullets: string[];
}

/** Build a placeholder Panel for `id`. */
export function placeholderPanel(id: TabId, title: string, info: PlaceholderInfo): Panel {
  let dayEl: HTMLElement | null = null;
  let selEl: HTMLElement | null = null;
  return {
    id,
    title,
    mount(el) {
      dayEl = h('span', { class: 'num' });
      selEl = id === 'inspect' ? h('div', { class: 'ph-sel' }) : null;
      replace(
        el,
        h(
          'div',
          { class: 'ph' },
          h(
            'div',
            { class: 'ph-hero' },
            h('div', { class: 'ph-kicker' }, info.kicker),
            h('h2', { class: 'ph-title' }, info.heading),
            h('p', { class: 'ph-text' }, info.lead),
            h('ul', { class: 'ph-list' }, info.bullets.map((b) => h('li', null, b))),
          ),
          selEl ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, 'Selection')), selEl) : null,
          h('div', { class: 'ph-foot' }, 'This page is still being set in type. The ledger was last written up on ', dayEl, '.'),
        ),
      );
    },
    update() {
      const s = ui.game?.s;
      if (dayEl && s) setText(dayEl, fmtDay(s.day));
      if (selEl) setText(selEl, describeSelection());
    },
  };
}

function describeSelection(): string {
  const sel = ui.selection;
  const s = ui.game?.s;
  if (!sel || !s) return 'Nothing selected. Click a building, a person or a town on the map.';
  try {
    switch (sel.kind) {
      case 'building': {
        const b = s.buildings[sel.id];
        return b ? `Building #${b.id} — ${b.kind}${b.sector ? ' (' + b.sector + ')' : ''}, ${s.towns[b.town]?.name ?? ''}` : `Building #${sel.id}`;
      }
      case 'person': {
        const p = s.people[sel.id];
        return p ? `${p.name}, ${s.towns[p.town]?.name ?? ''}` : `Person #${sel.id}`;
      }
      case 'firm': {
        const f = s.firms[sel.id];
        return f ? `${f.name} — ${f.sector}` : `Firm #${sel.id}`;
      }
      case 'town':
        return s.towns[sel.id]?.name ?? `Town #${sel.id}`;
      case 'market':
        return `Market: town ${sel.town}, good ${sel.good}`;
    }
  } catch {
    /* fall through */
  }
  return JSON.stringify(sel);
}
