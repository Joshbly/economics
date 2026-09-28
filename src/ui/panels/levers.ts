// ============================================================================
// Levers — the Treasury's seven primitives, one collapsible section each
// (Mint, Trade, Levy, Limit, Window, Build, Transfer), plus "In force": every
// levy, limit, order and project currently running.
//
// Sections are an accordion (one open at a time, remembered per viewer). Other
// panels open a prefilled form with uiState.prefill(); when the tab is shown,
// the Trade form follows the market last focused in the Markets tab.
// Each lever lives in ./levers/<name>.ts; shared bits in ./levers/common.ts.
// ============================================================================
import './levers.css';
import type { Panel } from '../panel';
import type { SimState } from '../../sim/types';
import { h, setText, setTone, toggleClass } from '../dom';
import { on, ui, type PrefillRequest } from '../uiState';
import { attachTip, icon, tipNote, tipTitle } from '../widgets';
import { fin, flowTone, fmtM, signedMoney, storeGet, storeSet, TONES, type Lever, type LeverId } from './levers/common';
import { glyph } from './levers/glyphs';
import { inForce, type InForce } from './levers/inforce';
import { mintLever } from './levers/mint';
import { tradeLever } from './levers/trade';
import { levyLever } from './levers/levy';
import { limitLever } from './levers/limit';
import { windowLever } from './levers/window';
import { buildLever } from './levers/build';
import { transferLever } from './levers/transfer';

const STORE_OPEN = 'realmLedger.levers.open';

/** Plain names for the Treasury's flow categories (ledger Flow keys). */
const FLOW_LABEL: Record<string, string> = {
  wage: 'Wages of Treasury workers',
  buy: 'Trades in markets',
  levy: 'Levies taken',
  give: 'Levies paid out',
  interest: 'Interest (reserves, window)',
  coupon: 'IOU payments',
  dividend: 'Profits of Treasury firms',
  rent: 'Rent from Treasury houses',
  transfer: 'Transfers',
  build: 'Construction bills',
  freight: 'Freight',
  estate: 'Estates',
  recap: 'Into the Bank’s capital',
  fee: 'Fees',
  asset: 'Sales of assets',
  misc: 'Other',
};
const flowLabel = (k: string): string => FLOW_LABEL[k] ?? k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ');

interface Item {
  lever: Lever;
  el: HTMLElement;
  head: HTMLButtonElement;
  body: HTMLElement;
  sum: HTMLElement;
}

export const leversPanel: Panel = (() => {
  let items: Item[] = [];
  let open: LeverId | null = null;
  let lastState: SimState | null = null;
  let forceList: InForce | null = null;
  let forceSec: HTMLElement | null = null;
  let forceSum: HTMLElement | null = null;
  let vPurse: HTMLElement | null = null;
  let vPurseSub: HTMLElement | null = null;
  let vNet: HTMLElement | null = null;
  let vCount: HTMLElement | null = null;

  function state(): SimState | null {
    return ui.game?.s ?? null;
  }

  function setOpen(id: LeverId | null, scroll = false): void {
    open = id;
    storeSet(STORE_OPEN, id ?? '');
    const s = state();
    for (const it of items) {
      const on = it.lever.id === id;
      toggleClass(it.el, 'open', on);
      it.head.setAttribute('aria-expanded', String(on));
      if (it.body.hidden === on) it.body.hidden = !on;
      if (on && s) {
        it.lever.opened?.(s);
        it.lever.update(s);
      }
    }
    if (scroll && id) {
      const it = items.find((x) => x.lever.id === id);
      if (it) requestAnimationFrame(() => it.el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    }
  }

  function scrollToForce(): void {
    forceSec?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function onPrefill(payload: unknown): void {
    const req = payload as PrefillRequest;
    const s = state();
    if (!req || !s) return;
    const it = items.find((x) => x.lever.id === req.lever);
    if (!it) return;
    try {
      it.lever.prefill?.(req, s);
    } catch (e) {
      console.error('[levers] prefill failed', e);
    }
    setOpen(it.lever.id, true);
    setTimeout(() => it.lever.focus?.(), 80);
  }

  return {
    id: 'levers',
    title: 'Levers',
    mount(el) {
      const levers: Lever[] = [mintLever(), tradeLever(), levyLever(), limitLever(), windowLever(), buildLever(), transferLever()];
      items = levers.map((lever) => {
        const sum = h('span', { class: 'lv-sum' });
        const head = h(
          'button',
          { class: 'lv-head', type: 'button', 'aria-expanded': 'false', dataset: { lever: lever.id } },
          h('span', { class: 'lv-glyph' }, glyph(lever.id, 17)),
          h('span', { class: 'lv-titles' }, h('span', { class: 'lv-name' }, lever.title), h('span', { class: 'lv-tag' }, lever.tagline)),
          sum,
          h('span', { class: 'lv-chev' }, icon('chevronRight', 15)),
        );
        const body = h('div', { class: 'lv-body', hidden: true }, lever.body);
        const item = h('div', { class: 'lv-item', dataset: { lever: lever.id } }, head, body);
        head.addEventListener('click', () => setOpen(open === lever.id ? null : lever.id, open !== lever.id));
        return { lever, el: item, head, body, sum };
      });

      // header strip: Purse · last day's net flow · rules in force
      vPurse = h('span', { class: 'lv-strip-v gold' });
      vPurseSub = h('span', { class: 'lv-strip-s' });
      vNet = h('span', { class: 'lv-strip-v' });
      vCount = h('span', { class: 'lv-strip-v' });
      const cPurse = h('div', { class: 'lv-strip-c' }, h('span', { class: 'lv-strip-l' }, 'Purse'), vPurse, vPurseSub);
      const cNet = h('div', { class: 'lv-strip-c' }, h('span', { class: 'lv-strip-l' }, 'Last day'), vNet);
      const cCount = h('button', { class: 'lv-strip-c lv-strip-btn', type: 'button', title: 'Jump to everything in force', onClick: () => scrollToForce() }, h('span', { class: 'lv-strip-l' }, 'In force'), vCount);
      attachTip(cPurse, () => [tipTitle('The Purse'), tipNote('The money the Treasury holds. Levies it takes, sales it makes and money it creates flow in; what it pays, buys and builds flows out.')], { placement: 'below' });
      attachTip(cNet, () => {
        const s = state();
        const flows = s?.treasury.flows ?? {};
        const rows = Object.entries(flows)
          .filter(([, v]) => Math.abs(fin(v)) > 0.005)
          .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
          .slice(0, 8)
          .map(([k, v]) => h('div', { class: 'tip-kv' }, h('span', { class: 'tip-lab' }, flowLabel(k)), h('span', { class: 'tip-val ' + (v > 0 ? 'good' : 'bad') }, signedMoney(v))));
        return [tipTitle('Into and out of the Purse', 'last day'), ...(rows.length ? rows : [tipNote('Nothing moved.')])];
      }, { placement: 'below' });
      const strip = h('div', { class: 'lv-strip' }, cPurse, cNet, cCount);

      forceList = inForce();
      forceSum = h('span', { class: 'lv-sec-sum' });
      forceSec = h(
        'section',
        { class: 'lv-force-sec' },
        h('div', { class: 'lv-sec-head' }, h('span', { class: 'lv-glyph sm' }, glyph('inforce', 15)), h('span', { class: 'lv-sec-t' }, 'In force'), forceSum),
        forceList.el,
      );

      el.classList.add('lv-panel');
      el.replaceChildren(
        h(
          'div',
          { class: 'lv' },
          h('div', { class: 'panel-head lv-phead' }, h('div', { class: 'panel-title' }, 'Levers'), h('div', { class: 'card-sub' }, 'Seven primitives. What they add up to is yours to find.')),
          strip,
          h('div', { class: 'lv-list' }, items.map((x) => x.el)),
          forceSec,
        ),
      );

      const saved = storeGet(STORE_OPEN) as LeverId | null;
      open = saved && items.some((x) => x.lever.id === saved) ? saved : null;
      setOpen(open);
      on('prefill', onPrefill);
      on('newgame', () => {
        lastState = null;
      });
    },

    update() {
      const s = state();
      if (!s) return;
      if (s !== lastState) {
        for (const it of items) it.lever.reset?.(s);
        lastState = s;
      }
      const t = s.treasury;
      if (vPurse && vPurseSub && vNet && vCount) {
        setText(vPurse, fmtM(fin(t.purse)));
        setTone(vPurse, TONES, fin(t.purse) < 0 || t.givesSuspended ? 'bad' : 'gold');
        setText(vPurseSub, t.givesSuspended ? 'empty — payments on hold' : t.autoMint ? 'auto-mint on' : '');
        toggleClass(vPurseSub, 'bad', !!t.givesSuspended);
        let net = 0;
        for (const k in t.flows) net += fin(t.flows[k]);
        setText(vNet, signedMoney(net));
        setTone(vNet, TONES, flowTone(net));
        const n = forceList ? forceList.count(s) : 0;
        setText(vCount, n ? String(n) : 'None');
      }
      for (const it of items) {
        let sm;
        try {
          sm = it.lever.summary(s);
        } catch {
          sm = { text: '' };
        }
        setText(it.sum, sm.text);
        setTone(it.sum, TONES, sm.tone ?? null);
        if (it.lever.id === open) it.lever.update(s);
      }
      if (forceList) {
        forceList.update(s);
        const n = forceList.count(s);
        if (forceSum) setText(forceSum, n ? `${n} running` : '');
      }
    },

    show() {
      const s = state();
      if (!s) return;
      for (const it of items) it.lever.tabShown?.(s);
    },
  };
})();
