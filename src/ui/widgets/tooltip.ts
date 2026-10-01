// ============================================================================
// One shared floating tooltip for the whole app (charts, indicators, buttons).
//
//   showTip(node, clientX, clientY)       follow-the-pointer (charts)
//   showTipAt(node, anchorRect, 'below')   anchored to an element
//   attachTip(el, () => node | string)     hover/focus tooltip for any element
//   tipTitle / tipRow / tipNote            standard content building blocks
//
// Content is built from DOM nodes / text (never HTML strings), so names from
// the simulation are always rendered safely.
// ============================================================================
import { h, type Child } from '../dom';

let tipEl: HTMLDivElement | null = null;
let owner: unknown = null;

function el(): HTMLDivElement {
  if (!tipEl || !tipEl.isConnected) {
    tipEl = h('div', { class: 'tip', role: 'tooltip', 'aria-hidden': 'true' });
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function setContent(content: Child): void {
  const t = el();
  t.textContent = '';
  if (typeof content === 'string' || typeof content === 'number') t.appendChild(h('div', { class: 'tip-text' }, String(content)));
  else if (Array.isArray(content)) for (const c of content) setChild(t, c);
  else if (content) t.appendChild(content);
}

function setChild(t: HTMLElement, c: Child): void {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) for (const x of c) setChild(t, x);
  else if (typeof c === 'string' || typeof c === 'number') t.appendChild(h('div', { class: 'tip-text' }, String(c)));
  else t.appendChild(c);
}

/** Show the tooltip near the pointer (flips to stay on screen). `key` identifies the owner for hideTip(key). */
export function showTip(content: Child, clientX: number, clientY: number, key?: unknown): void {
  owner = key ?? null;
  setContent(content);
  const t = el();
  t.classList.add('on');
  const r = t.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = clientX + 16;
  let y = clientY + 14;
  if (x + r.width > vw - 8) x = clientX - r.width - 16;
  if (y + r.height > vh - 8) y = clientY - r.height - 12;
  t.style.transform = `translate(${Math.max(8, Math.round(x))}px, ${Math.max(8, Math.round(y))}px)`;
}

/** Show the tooltip anchored to a rectangle (e.g. an element's getBoundingClientRect()). */
export function showTipAt(content: Child, anchor: DOMRect, placement: 'below' | 'above' | 'left' | 'right' = 'below', key?: unknown): void {
  owner = key ?? null;
  setContent(content);
  const t = el();
  t.classList.add('on');
  const r = t.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = anchor.left + anchor.width / 2 - r.width / 2;
  let y = anchor.bottom + 8;
  if (placement === 'above') y = anchor.top - r.height - 8;
  else if (placement === 'left') {
    x = anchor.left - r.width - 8;
    y = anchor.top + anchor.height / 2 - r.height / 2;
  } else if (placement === 'right') {
    x = anchor.right + 8;
    y = anchor.top + anchor.height / 2 - r.height / 2;
  }
  if (placement === 'below' && y + r.height > vh - 8) y = anchor.top - r.height - 8;
  if (placement === 'above' && y < 8) y = anchor.bottom + 8;
  x = Math.max(8, Math.min(vw - r.width - 8, x));
  y = Math.max(8, Math.min(vh - r.height - 8, y));
  t.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

/** Hide the tooltip (only if `key` still owns it, when given). */
export function hideTip(key?: unknown): void {
  if (key !== undefined && owner !== key) return;
  owner = null;
  if (tipEl) tipEl.classList.remove('on');
}

export interface AttachTipOptions {
  placement?: 'below' | 'above' | 'left' | 'right' | 'cursor';
  /** Hover delay before showing (ms). */
  delay?: number;
}

/**
 * Hover (and keyboard focus) tooltip for an element. `content` is called each
 * time the tooltip opens, so it can show live values. Return null to skip.
 * Returns a remover.
 */
export function attachTip(target: HTMLElement, content: () => Child | null, opts: AttachTipOptions = {}): () => void {
  const delay = opts.delay ?? 280;
  const placement = opts.placement ?? 'below';
  let timer = 0;
  let open = false;
  const key = {};
  const doShow = (e?: PointerEvent) => {
    const c = content();
    if (c === null || c === undefined || c === false) return;
    open = true;
    if (placement === 'cursor' && e) showTip(c, e.clientX, e.clientY, key);
    else showTipAt(c, target.getBoundingClientRect(), placement === 'cursor' ? 'below' : placement, key);
  };
  const enter = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    clearTimeout(timer);
    timer = window.setTimeout(() => doShow(e), delay);
  };
  const move = (e: PointerEvent) => {
    if (open && placement === 'cursor') doShow(e);
  };
  const leave = () => {
    clearTimeout(timer);
    if (open) hideTip(key);
    open = false;
  };
  const focus = () => doShow();
  target.addEventListener('pointerenter', enter);
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerleave', leave);
  target.addEventListener('pointerdown', leave);
  target.addEventListener('focus', focus);
  target.addEventListener('blur', leave);
  return () => {
    leave();
    target.removeEventListener('pointerenter', enter);
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerleave', leave);
    target.removeEventListener('pointerdown', leave);
    target.removeEventListener('focus', focus);
    target.removeEventListener('blur', leave);
  };
}

// ---- content building blocks ----------------------------------------------

/** Bold heading line. */
export function tipTitle(text: string, sub?: string): HTMLElement {
  return h('div', { class: 'tip-title' }, text, sub ? h('span', { class: 'tip-sub' }, sub) : null);
}

/**
 * A value row: coloured key (line/box/dot) · value (strong) · label (secondary).
 * Values lead, labels follow — the reader already knows the series and wants the number.
 */
export function tipRow(color: string | null, label: string, value: string, key: 'line' | 'box' | 'dot' | 'dash' = 'line'): HTMLElement {
  return h(
    'div',
    { class: 'tip-row' },
    color ? h('span', { class: 'tip-key tip-key-' + key, style: { background: key === 'dash' ? '' : color, borderColor: color } }) : h('span', { class: 'tip-key tip-key-none' }),
    h('span', { class: 'tip-val' }, value),
    h('span', { class: 'tip-lab' }, label),
  );
}

/** Explanatory paragraph (muted). */
export function tipNote(text: string): HTMLElement {
  return h('div', { class: 'tip-note' }, text);
}

/** A two-column key/value line ("Buyers pay  ¤5.40"). */
export function tipKV(label: string, value: string, tone?: 'good' | 'bad' | 'warn' | 'gold'): HTMLElement {
  return h('div', { class: 'tip-kv' }, h('span', { class: 'tip-lab' }, label), h('span', { class: 'tip-val' + (tone ? ' ' + tone : '') }, value));
}
