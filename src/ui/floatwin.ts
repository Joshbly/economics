// ============================================================================
// Floating windows: a panel of its own over the map that does not block the rest of the
// screen (unlike a modal) — the realm keeps running, the top bar and the map stay usable.
//
//   const w = openFloat({ title: 'Trading desk', body, width: 980, onClose: () => off() });
//   w.close();
//
// Drag it by its title bar; resize it from its corner. Esc closes it while focus is inside.
// ============================================================================
import { h, type Child } from './dom';
import { icon } from './widgets/icons';

export interface FloatOptions {
  title: string;
  subtitle?: string;
  body: Child;
  /** Width in px (default 720); it never exceeds the viewport. */
  width?: number;
  className?: string;
  onClose?: () => void;
}

export interface FloatHandle {
  el: HTMLElement;
  close(): void;
  /** Bring it to the front. */
  raise(): void;
}

let zTop = 870;

export function openFloat(o: FloatOptions): FloatHandle {
  const body = h('div', { class: 'float-body' });
  if (Array.isArray(o.body)) for (const c of o.body) c && body.append(c as Node | string);
  else if (o.body) body.append(o.body as Node | string);
  const head = h(
    'div',
    { class: 'float-head' },
    h('div', { class: 'float-titles' }, h('h2', { class: 'float-title' }, o.title), o.subtitle ? h('div', { class: 'float-sub' }, o.subtitle) : null),
    h('button', { class: 'icon-btn float-x', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', onClick: () => handle.close() }, icon('close', 16)),
  );
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(o.width ?? 720, vw - 32);
  const el = h(
    'div',
    { class: 'float-win' + (o.className ? ' ' + o.className : ''), role: 'dialog', 'aria-label': o.title, style: { width: width + 'px', left: Math.max(16, Math.round((vw - width) / 2)) + 'px', top: Math.max(16, Math.round(vh * 0.07)) + 'px' } },
    head,
    body,
  );
  let closed = false;
  const handle: FloatHandle = {
    el,
    close() {
      if (closed) return;
      closed = true;
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 120);
      o.onClose?.();
    },
    raise() {
      el.style.zIndex = String(++zTop);
    },
  };

  // drag by the title bar (not from its buttons)
  head.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const x = Math.min(Math.max(ev.clientX - dx, 8 - r.width + 120), window.innerWidth - 120);
      const y = Math.min(Math.max(ev.clientY - dy, 0), window.innerHeight - 40);
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
  el.addEventListener('pointerdown', () => handle.raise(), true);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handle.close();
    }
  });

  document.body.appendChild(el);
  handle.raise();
  requestAnimationFrame(() => el.classList.add('on'));
  return handle;
}
