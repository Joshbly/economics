// ============================================================================
// Modal dialogs, confirmations and toasts.
//
//   const m = openModal({ title: 'Found a new realm', body: form, actions: [
//     { label: 'Cancel', kind: 'ghost' },
//     { label: 'Found it', kind: 'primary', default: true, onClick: () => { …; } },
//   ]});
//   if (await confirmDialog({ title: 'Abandon this realm?', message: '…', confirm: 'Abandon', danger: true })) …
//   toast('Saved.', 'good');          // (uiState) — rendered by initToasts()
//
// Esc closes the top modal (when dismissible); Enter triggers the default
// action unless focus is on a button or textarea. Focus moves into the dialog
// and returns to where it was on close.
// ============================================================================
import { h, type Child } from './dom';
import { on } from './uiState';
import { icon } from './widgets/icons';

export interface ModalAction {
  label: string;
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** Return false (or a promise of false) to keep the dialog open. */
  onClick?: () => boolean | void | Promise<boolean | void>;
  /** Triggered by Enter. */
  default?: boolean;
}

export interface ModalOptions {
  title: string;
  /** Short line under the title. */
  subtitle?: string;
  body?: Child;
  actions?: ModalAction[];
  /** Dialog width in px (default 460). */
  width?: number;
  /** Esc / backdrop click / × close it (default true). */
  dismissible?: boolean;
  onClose?: () => void;
  className?: string;
}

export interface ModalHandle {
  el: HTMLElement;
  body: HTMLElement;
  close(): void;
  /** Disable the action buttons (e.g. while working). */
  setBusy(busy: boolean): void;
}

const stack: { handle: ModalHandle; opts: ModalOptions }[] = [];

export function isModalOpen(): boolean {
  return stack.length > 0;
}

/** Close the top-most dismissible modal. Returns true if one was closed. */
export function closeTopModal(): boolean {
  const top = stack[stack.length - 1];
  if (!top || top.opts.dismissible === false) return false;
  top.handle.close();
  return true;
}

export function openModal(opts: ModalOptions): ModalHandle {
  const prevFocus = document.activeElement as HTMLElement | null;
  const dismissible = opts.dismissible !== false;
  const body = h('div', { class: 'modal-body' });
  if (opts.body !== undefined) {
    if (typeof opts.body === 'string') body.appendChild(h('p', null, opts.body));
    else if (Array.isArray(opts.body)) for (const c of opts.body) c && body.append(c as Node | string);
    else if (opts.body) body.appendChild(opts.body as Node);
  }
  const actions = opts.actions ?? [{ label: 'Close', kind: 'primary', default: true }];
  const btns: HTMLButtonElement[] = [];
  const foot = h('div', { class: 'modal-foot' });
  const dialog = h(
    'div',
    { class: 'modal' + (opts.className ? ' ' + opts.className : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title, style: { width: (opts.width ?? 460) + 'px' } },
    h(
      'div',
      { class: 'modal-head' },
      h('div', { class: 'modal-titles' }, h('h2', { class: 'modal-title' }, opts.title), opts.subtitle ? h('div', { class: 'modal-sub' }, opts.subtitle) : null),
      dismissible ? h('button', { class: 'icon-btn modal-x', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', onClick: () => handle.close() }, icon('close', 16)) : null,
    ),
    body,
    foot,
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  let closed = false;
  let busy = false;

  const handle: ModalHandle = {
    el: dialog,
    body,
    close() {
      if (closed) return;
      closed = true;
      const i = stack.findIndex((x) => x.handle === handle);
      if (i >= 0) stack.splice(i, 1);
      backdrop.classList.add('leaving');
      setTimeout(() => backdrop.remove(), 140);
      opts.onClose?.();
      if (prevFocus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
    },
    setBusy(b) {
      busy = b;
      for (const x of btns) x.disabled = b;
      dialog.classList.toggle('busy', b);
    },
  };

  const run = async (a: ModalAction) => {
    if (busy) return;
    let keep = false;
    try {
      const r = a.onClick ? await a.onClick() : undefined;
      keep = r === false;
    } catch (e) {
      console.error(e);
      keep = true;
    }
    if (!keep) handle.close();
  };
  for (const a of actions) {
    const b = h('button', { class: `btn btn-${a.kind ?? 'secondary'}`, type: 'button', onClick: () => run(a) }, a.label);
    btns.push(b);
    foot.appendChild(b);
  }
  if (!actions.length) foot.remove();

  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop && dismissible) handle.close();
  });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      if (dismissible && stack[stack.length - 1]?.handle === handle) handle.close();
    } else if (e.key === 'Enter' && !e.isComposing) {
      const t = e.target as HTMLElement;
      if (t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      const def = actions.find((a) => a.default);
      if (def) {
        e.preventDefault();
        run(def);
      }
    } else if (e.key === 'Tab') {
      // keep focus inside the dialog
      const f = [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !(x as HTMLButtonElement).disabled);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    // Game shortcuts must not fire while a dialog has focus.
    e.stopPropagation();
  });

  document.body.appendChild(backdrop);
  stack.push({ handle, opts });
  requestAnimationFrame(() => {
    backdrop.classList.add('on');
    const first = dialog.querySelector<HTMLElement>('input, select, textarea') ?? btns.find((_, i) => actions[i].default) ?? btns[btns.length - 1] ?? dialog;
    if (first === dialog) dialog.tabIndex = -1;
    first.focus({ preventScroll: true });
  });
  return handle;
}

export interface ConfirmOptions {
  title: string;
  message?: Child;
  confirm?: string;
  cancel?: string;
  danger?: boolean;
}

/** Ask a yes/no question. Resolves true on confirm, false on cancel / Esc. */
export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title: o.title,
      body: typeof o.message === 'string' ? h('p', { class: 'modal-text' }, o.message) : o.message,
      width: 420,
      actions: [
        { label: o.cancel ?? 'Cancel', kind: 'ghost', onClick: () => void (answered = true, resolve(false)) },
        { label: o.confirm ?? 'OK', kind: o.danger ? 'danger' : 'primary', default: true, onClick: () => void (answered = true, resolve(true)) },
      ],
      onClose: () => {
        if (!answered) resolve(false);
      },
    });
  });
}

/** A simple message dialog. */
export function alertDialog(title: string, message: Child): Promise<void> {
  return new Promise((resolve) => {
    openModal({
      title,
      body: typeof message === 'string' ? h('p', { class: 'modal-text' }, message) : message,
      width: 420,
      actions: [{ label: 'OK', kind: 'primary', default: true }],
      onClose: () => resolve(),
    });
  });
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export type ToastKind = 'info' | 'good' | 'bad';

let toastHost: HTMLElement | null = null;
const live: { el: HTMLElement; text: string; kind: ToastKind; count: number; timer: number; countEl: HTMLElement }[] = [];
const MAX_TOASTS = 5;

/** Show a toast directly (prefer uiState.toast(), which works from anywhere). */
export function showToast(text: string, kind: ToastKind = 'info', ms?: number): void {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const dup = live.find((t) => t.text === text && t.kind === kind);
  const life = ms ?? (kind === 'bad' ? 7000 : 4200);
  if (dup) {
    dup.count++;
    dup.countEl.textContent = '×' + dup.count;
    dup.countEl.hidden = false;
    clearTimeout(dup.timer);
    dup.timer = window.setTimeout(() => dismiss(dup.el), life);
    dup.el.classList.remove('bump');
    void dup.el.offsetWidth;
    dup.el.classList.add('bump');
    return;
  }
  const countEl = h('span', { class: 'toast-count', hidden: true });
  const el = h(
    'div',
    { class: 'toast toast-' + kind },
    h('span', { class: 'toast-icon' }, icon(kind === 'bad' ? 'warning' : kind === 'good' ? 'check' : 'info', 16)),
    h('span', { class: 'toast-text' }, text),
    countEl,
    h('button', { class: 'toast-x', type: 'button', 'aria-label': 'Dismiss', onClick: () => dismiss(el) }, icon('close', 13)),
  );
  const entry = { el, text, kind, count: 1, timer: 0, countEl };
  entry.timer = window.setTimeout(() => dismiss(el), life);
  el.addEventListener('pointerenter', () => clearTimeout(entry.timer));
  el.addEventListener('pointerleave', () => {
    clearTimeout(entry.timer);
    entry.timer = window.setTimeout(() => dismiss(el), 2000);
  });
  live.push(entry);
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));
  while (live.length > MAX_TOASTS) dismiss(live[0].el);
}

function dismiss(el: HTMLElement): void {
  const i = live.findIndex((t) => t.el === el);
  if (i < 0) return;
  clearTimeout(live[i].timer);
  live.splice(i, 1);
  el.classList.remove('on');
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 200);
}

/** Render uiState 'toast' events. Returns an unsubscribe function. */
export function initToasts(): () => void {
  return on('toast', (p) => {
    const t = p as { text?: string; kind?: ToastKind } | undefined;
    if (t && t.text) showToast(t.text, t.kind ?? 'info');
  });
}
