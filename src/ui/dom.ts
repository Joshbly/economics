// ============================================================================
// Tiny DOM helpers shared by the shell, panels and widgets. No framework: build
// DOM once with h(), then update text/classes cheaply (setText only touches
// the DOM when the value changed, so 4×/s refreshes stay free).
//
//   h('div.card', { title: 'Hint', onClick: () => … }, 'text', h('b', null, 42))
//   h('input', { type: 'number', value: '3', onInput: (e) => … })
//
// Security note: children strings are inserted as text nodes, never HTML, so
// names coming from the simulation (towns, people, firms) are always safe.
// ============================================================================

export type Child = Node | string | number | null | undefined | false | Child[];

export type Attrs = {
  class?: string | null;
  style?: string | Partial<Record<keyof CSSStyleDeclaration, string | number>> | null;
  dataset?: Record<string, string | number> | null;
  [key: string]: unknown;
};

/**
 * Create an element. `tag` may carry an id and classes: 'div#main.card.wide'.
 * Attributes:
 *  - `class`, `style` (string or object), `dataset`
 *  - `onXxx` functions become event listeners ('onClick' → 'click', 'onPointerDown' → 'pointerdown')
 *  - aria-*, data-*, role, for, and anything that is not a DOM property → setAttribute
 *  - other keys are assigned as properties (value, checked, disabled, title, type…)
 *  - null / undefined / false values are skipped
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement;
export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement {
  let name = tag;
  let id = '';
  let classes = '';
  const m = /^([a-z0-9-]*)((?:[#.][\w-]+)*)$/i.exec(tag);
  if (m && m[2]) {
    name = m[1] || 'div';
    for (const part of m[2].match(/[#.][\w-]+/g) ?? []) {
      if (part[0] === '#') id = part.slice(1);
      else classes += (classes ? ' ' : '') + part.slice(1);
    }
  }
  const el = document.createElement(name || 'div');
  if (id) el.id = id;
  if (classes) el.className = classes;
  if (attrs) applyAttrs(el, attrs);
  append(el, children);
  return el;
}

function applyAttrs(el: HTMLElement, attrs: Attrs): void {
  for (const key in attrs) {
    const v = attrs[key];
    if (v === null || v === undefined || v === false) continue;
    if (key === 'class' || key === 'className') {
      el.className = el.className ? el.className + ' ' + String(v) : String(v);
    } else if (key === 'style') {
      if (typeof v === 'string') el.style.cssText += v;
      else Object.assign(el.style, v);
    } else if (key === 'dataset') {
      for (const k in v as Record<string, unknown>) el.dataset[k] = String((v as Record<string, unknown>)[k]);
    } else if (key.length > 2 && key[0] === 'o' && key[1] === 'n' && typeof v === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), v as EventListener);
    } else if (key.startsWith('aria-') || key.startsWith('data-') || key === 'role' || key === 'for' || !(key in el)) {
      el.setAttribute(key, v === true ? '' : String(v));
    } else {
      (el as unknown as Record<string, unknown>)[key] = v;
    }
  }
}

/** Append children (strings become text nodes, arrays are flattened, falsy skipped). */
export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (typeof c === 'string' || typeof c === 'number') el.appendChild(document.createTextNode(String(c)));
    else el.appendChild(c);
  }
}

/** Replace all children of `el`. */
export function replace(el: Element, ...children: Child[]): void {
  el.textContent = '';
  append(el, children);
}

/** Remove all children. */
export function clear(el: Element): void {
  el.textContent = '';
}

/** Set textContent only when it changed (cheap to call every refresh). */
export function setText(el: Element | null | undefined, text: string | number): void {
  if (!el) return;
  const t = String(text);
  if (el.textContent !== t) el.textContent = t;
}

/** Set an attribute only when it changed. */
export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/** Add/remove a class. */
export function toggleClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

/** Set one of several mutually exclusive classes (e.g. tone: 'good' | 'bad' | ''). */
export function setTone(el: Element, tones: readonly string[], active: string | null | undefined): void {
  for (const t of tones) toggleClass(el, t, t === active);
}

/** Show/hide via the `hidden` attribute. */
export function show(el: HTMLElement, visible: boolean): void {
  if (el.hidden === visible) el.hidden = !visible;
}

/** addEventListener that returns its own remover. */
export function listen<K extends keyof HTMLElementEventMap>(
  target: HTMLElement | Document | Window,
  type: K,
  fn: (e: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions | boolean,
): () => void;
export function listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions | boolean): () => void;
export function listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions | boolean): () => void {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

/** True when keyboard input is going to a text field (global shortcuts should back off). */
export function isTyping(e?: Event): boolean {
  const t = (e?.target as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return type !== 'checkbox' && type !== 'radio' && type !== 'range' && type !== 'button';
  }
  return t.isContentEditable;
}

/** Run `fn` at most once per animation frame (latest arguments win). */
export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let pending = false;
  let lastArgs: A;
  return (...args: A) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn(...lastArgs);
    });
  };
}

/** Is the element attached and laid out (not inside a display:none ancestor)? */
export function isVisible(el: HTMLElement): boolean {
  return el.isConnected && el.getClientRects().length > 0;
}

/** Trigger a file download of `data` (string or Blob). */
export function downloadFile(name: string, data: string | Blob, type = 'application/json'): void {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: 'display:none' });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

/** Ask the user for a file and resolve with its text (null if cancelled). */
export function pickTextFile(accept = '.json,application/json'): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: 'display:none' });
    let done = false;
    const finish = (v: { name: string; text: string } | null) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) return finish(null);
      const r = new FileReader();
      r.onload = () => finish({ name: f.name, text: String(r.result ?? '') });
      r.onerror = () => finish(null);
      r.readAsText(f);
    });
    // Some browsers never fire 'change' on cancel; 'cancel' covers the newer ones.
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}
