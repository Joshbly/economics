// ============================================================================
// Levers panel — Treasury construction projects: a compact card per project
// with overall progress, per-material progress, what has been billed, and
// Cancel / Show on map. Used by the Build lever and the In force list.
// ============================================================================
import type { Materials, Project, SimState } from '../../../sim/types';
import { STATE } from '../../../sim/types';
import { h, setText, setTone, toggleClass } from '../../dom';

import { confirmDialog } from '../../modal';
import { centerMap } from '../../uiState';
import { icon } from '../../widgets';
import { bar, fin, fmtM, fmtQ, keyedList, run, TONES } from './common';

const MATS: [keyof Materials, string][] = [
  ['labor', 'Labour'],
  ['wood', 'Wood'],
  ['iron', 'Iron'],
  ['tools', 'Tools'],
];

const STATUS_TEXT: Record<string, [string, 'good' | 'bad' | 'warn' | 'gold' | null]> = {
  queued: ['Queued', null],
  active: ['Under way', 'gold'],
  stalled: ['Stalled', 'warn'],
  done: ['Finished', 'good'],
  cancelled: ['Called off', 'bad'],
};

/** Treasury projects worth listing (active ones first, then recently finished). */
export function treasuryProjects(s: SimState): Project[] {
  const out = s.projects.filter((p) => p && p.owner === STATE && p.status !== 'cancelled');
  const rank = (p: Project) => (p.status === 'active' ? 0 : p.status === 'stalled' ? 1 : p.status === 'queued' ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b) || b.created - a.created);
}

/** Overall progress: mean completion over the materials the project needs. */
export function projectFraction(p: Project): number {
  if (p.status === 'done') return 1;
  let sum = 0;
  let n = 0;
  for (const [k] of MATS) {
    const need = fin(p.need?.[k]);
    if (need > 0) {
      sum += Math.min(1, fin(p.done?.[k]) / need);
      n++;
    }
  }
  return n ? sum / n : 0;
}

interface ProjView {
  el: HTMLElement;
  title: HTMLElement;
  status: HTMLElement;
  meta: HTMLElement;
  main: ReturnType<typeof bar>;
  mats: { el: HTMLElement; bar: ReturnType<typeof bar>; val: HTMLElement }[];
  cancel: HTMLButtonElement;
  id: number;
}

/** A self-refreshing list of Treasury projects. */
export function projectList(opts: { compact?: boolean; empty?: string } = {}): { el: HTMLElement; set(s: SimState): number } {
  const list = h('div', { class: 'lv-projs' });
  const empty = h('div', { class: 'lv-empty-sm' }, opts.empty ?? 'No Treasury projects under way.');
  const el = h('div', null, list, empty);
  let state: SimState | null = null;

  const reconcile = keyedList<Project, ProjView>(
    list,
    (p) => p.id,
    (p) => {
      const title = h('span', { class: 'lv-proj-t' });
      const status = h('span', { class: 'chip' });
      const meta = h('div', { class: 'lv-proj-meta' });
      const main = bar('lv-bar-main');
      const mats = MATS.map(([, lab]) => {
        const b = bar();
        const val = h('span', { class: 'lv-mat-v' });
        return { el: h('div', { class: 'lv-mat' }, h('span', { class: 'lv-mat-l' }, lab), b.el, val), bar: b, val };
      });
      const view: ProjView = {
        el: h('div'),
        title,
        status,
        meta,
        main,
        mats,
        cancel: h('button', { class: 'icon-btn lv-ibtn', type: 'button', title: 'Call off this project', 'aria-label': 'Cancel project' }, icon('close', 15)),
        id: p.id,
      };
      const showBtn = h('button', { class: 'icon-btn lv-ibtn', type: 'button', title: 'Show on the map', 'aria-label': 'Show on map' }, icon('target', 15));
      showBtn.addEventListener('click', () => {
        const s = state;
        const pr = s?.projects.find((x) => x.id === view.id);
        if (!s || !pr) return;
        const b = pr.building >= 0 ? s.buildings[pr.building] : undefined;
        if (b) centerMap(b.x + b.w / 2, b.y + b.h / 2);
        else if (pr.tiles?.length) {
          const mid = pr.tiles[Math.floor(pr.tiles.length / 2)];
          centerMap(mid % s.map.w, Math.floor(mid / s.map.w));
        } else {
          const t = s.towns[pr.town];
          if (t) centerMap(t.x, t.y);
        }
      });
      view.cancel.addEventListener('click', async () => {
        const s = state;
        const pr = s?.projects.find((x) => x.id === view.id);
        if (!pr) return;
        const ok = await confirmDialog({
          title: 'Call off this project?',
          message: `“${pr.label}” stops where it is. ${fmtM(fin(pr.billed))} has been billed so far; nothing is refunded.`,
          confirm: 'Call it off',
          danger: true,
        });
        if (ok) run({ type: 'cancelProject', id: view.id }, null);
      });
      view.el = h(
        'div',
        { class: 'lv-proj' + (opts.compact ? ' compact' : '') },
        h('div', { class: 'lv-proj-head' }, title, status, h('span', { class: 'spacer' }), showBtn, view.cancel),
        main.el,
        meta,
        opts.compact ? null : h('div', { class: 'lv-mats' }, mats.map((m) => m.el)),
      );
      return view;
    },
    (v, p) => {
      setText(v.title, p.label || 'Treasury project');
      const [st, tone] = STATUS_TEXT[p.status] ?? [p.status, null];
      setText(v.status, st);
      setTone(v.status, TONES, tone);
      const f = projectFraction(p);
      v.main.set(f);
      const owed = fin(p.landDue ?? 0);
      const waiting = owed > 0.005 ? ` · waiting to pay ${fmtM(owed)} still owed for the plot` : p.loanWanted > 0 ? ' · waiting for funds' : p.stalledDays > 0 ? ` · stalled ${p.stalledDays} days` : '';
      setText(v.meta, `${Math.round(f * 100)}% done · ${fmtM(fin(p.billed))} billed${waiting}`);
      MATS.forEach(([k], i) => {
        const need = fin(p.need?.[k]);
        const done = fin(p.done?.[k]);
        const m = v.mats[i];
        m.bar.set(need > 0 ? done / need : 1);
        const whole = (x: number) => (need >= 10 ? String(Math.floor(x + 1e-6)) : fmtQ(x));
        setText(m.val, need > 0 ? `${whole(Math.min(done, need))}/${whole(need)}` : '—');
        toggleClass(m.el, 'none', !(need > 0));
      });
      const live = p.status !== 'done' && p.status !== 'cancelled';
      v.cancel.hidden = !live;
    },
  );

  return {
    el,
    set(s) {
      state = s;
      const ps = treasuryProjects(s);
      reconcile(ps);
      empty.hidden = ps.length > 0;
      list.hidden = ps.length === 0;
      return ps.length;
    },
  };
}
