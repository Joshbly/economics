// ============================================================================
// Hover tooltips anchored to the sidebar's left edge (so they float over the
// map, beside the hovered row, and never cover the dense tables and grids in
// the panel). Same content contract as widgets/tooltip attachTip().
//
//   attachSideTip(cell, () => [tipTitle('Bread · Kingsbridge'), tipKV('Price', '¤4.20')]);
// ============================================================================
import type { Child } from '../../dom';
import { hideTip, showTipAt } from '../../widgets';

export function attachSideTip(target: HTMLElement, content: () => Child | null, delay = 200): () => void {
  let timer = 0;
  let open = false;
  const key = {};
  const anchor = (): DOMRect => {
    const r = target.getBoundingClientRect();
    const side = (target.closest('.sidebar') ?? target.closest('.panel'))?.getBoundingClientRect();
    const left = side ? side.left : r.left;
    return new DOMRect(left, r.top, 1, r.height);
  };
  const doShow = () => {
    const c = content();
    if (c === null || c === undefined || c === false) return;
    open = true;
    showTipAt(c, anchor(), 'left', key);
  };
  const enter = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    clearTimeout(timer);
    timer = window.setTimeout(doShow, open ? 0 : delay);
  };
  const leave = () => {
    clearTimeout(timer);
    if (open) hideTip(key);
    open = false;
  };
  target.addEventListener('pointerenter', enter);
  target.addEventListener('pointerleave', leave);
  target.addEventListener('pointerdown', leave);
  const focus = () => {
    let kb = true;
    try {
      kb = target.matches(':focus-visible');
    } catch {
      /* old engines: treat as keyboard focus */
    }
    if (kb) doShow();
  };
  target.addEventListener('focus', focus);
  target.addEventListener('blur', leave);
  return () => {
    leave();
    target.removeEventListener('pointerenter', enter);
    target.removeEventListener('pointerleave', leave);
    target.removeEventListener('pointerdown', leave);
    target.removeEventListener('focus', focus);
    target.removeEventListener('blur', leave);
  };
}
