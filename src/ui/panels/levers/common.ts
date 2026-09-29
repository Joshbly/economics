// ============================================================================
// Levers panel — shared contract and small building blocks.
//
// Every primitive is a `Lever`: a body built once, refreshed in place by
// update(s) while its section is open, plus a one-line summary for its header
// (refreshed always). Forms are real <form>s so Enter submits; failures from
// act() are echoed inline under the form as well as toasted.
// ============================================================================
import { GOODS } from '../../../sim/goods';
import type { ActionResult, PlayerAction, SimState } from '../../../sim/types';
import { h, setText, setTone, toggleClass, type Child } from '../../dom';
import { DASH, fmtMoney, fmtMoneyShort, fmtQty, pluralize } from '../../format';
import { act, type PrefillRequest } from '../../uiState';
import { parseNumber, segmented } from '../../widgets';

export type LeverId = 'mint' | 'trade' | 'levy' | 'limit' | 'window' | 'build' | 'transfer';
export type Tone = 'good' | 'bad' | 'warn' | 'gold' | null;

export interface Summary {
  text: string;
  tone?: Tone;
}

export interface Lever {
  id: LeverId;
  title: string;
  /** Muted one-liner under the title (what the primitive does). */
  tagline: string;
  body: HTMLElement;
  /** Refresh the open form (cheap; never clobber a field being typed in). */
  update(s: SimState): void;
  /** Header summary (called on every refresh, open or not). */
  summary(s: SimState): Summary;
  /** The section was just opened. */
  opened?(s: SimState): void;
  /** The Levers tab became visible. */
  tabShown?(s: SimState): void;
  /** Open-with-values request from another panel. Returns true if handled. */
  prefill?(req: PrefillRequest, s: SimState): boolean;
  /** Focus the most useful field. */
  focus?(): void;
  /** A new game was loaded: drop caches, re-sync defaults. */
  reset?(s: SimState): void;
}

export const TONES = ['good', 'bad', 'warn', 'gold'] as const;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Label · control(s) row in the compact lever grid. */
export function row(label: Child, ...controls: Child[]): HTMLElement {
  return h('div', { class: 'lv-row' }, h('div', { class: 'lv-lab' }, label), h('div', { class: 'lv-ctl' }, ...controls));
}

/** A row whose label text can change later. */
export function dynRow(label: string, ...controls: Child[]): { el: HTMLElement; lab: HTMLElement; ctl: HTMLElement } {
  const lab = h('div', { class: 'lv-lab' }, label);
  const ctl = h('div', { class: 'lv-ctl' }, ...controls);
  return { el: h('div', { class: 'lv-row' }, lab, ctl), lab, ctl };
}

/** Small-caps subheading inside a lever body. */
export function subhead(title: string, ...right: Child[]): HTMLElement {
  return h('div', { class: 'lv-sub' }, h('span', { class: 'lv-sub-t' }, title), right.length ? h('span', { class: 'lv-sub-r' }, ...right) : null);
}

/** A muted hint line (updatable). */
export function hint(text: Child = ''): HTMLElement {
  return h('div', { class: 'lv-hint' }, text);
}

/** Blur a focused text field so programmatic set() calls land (Safari keeps focus on click). */
export function releaseFocus(): void {
  const a = document.activeElement as HTMLElement | null;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) a.blur();
}

/** Quick-set chip. */
export function chip(label: string, onClick: () => void, title?: string): HTMLButtonElement {
  return h(
    'button',
    {
      class: 'lv-chip',
      type: 'button',
      title: title ?? null,
      onClick: (e: MouseEvent) => {
        e.preventDefault();
        releaseFocus();
        onClick();
      },
    },
    label,
  );
}

/** Warning / info banner. */
export function banner(tone: 'warn' | 'bad' | 'info', ...children: Child[]): HTMLElement {
  return h('div', { class: 'lv-banner lv-banner-' + tone, role: tone === 'info' ? null : 'alert' }, ...children);
}

/** Primary submit button (so Enter in any field of the form submits). */
export function submitButton(label: string, title?: string): HTMLButtonElement {
  return h('button', { class: 'btn btn-primary lv-submit', type: 'submit', title: title ?? null }, label);
}

/** A <form> whose submit (button or Enter) calls `onSubmit`. */
export function formEl(onSubmit: () => void, ...children: Child[]): HTMLFormElement {
  const f = h('form', { class: 'lv-form', novalidate: true, autocomplete: 'off' }, ...children);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    onSubmit();
  });
  return f;
}

/** The footer of a form: preview text on the left, action buttons on the right, message below. */
export function formFoot(preview: HTMLElement, msg: MsgLine, ...buttons: Child[]): HTMLElement {
  return h('div', { class: 'lv-foot' }, h('div', { class: 'lv-foot-main' }, preview, h('div', { class: 'lv-foot-btns' }, ...buttons)), msg.el);
}

// ---------------------------------------------------------------------------
// Inline result line
// ---------------------------------------------------------------------------

export interface MsgLine {
  el: HTMLElement;
  ok(text: string): void;
  err(text: string): void;
  clear(): void;
}

export function msgLine(): MsgLine {
  const el = h('div', { class: 'lv-msg', hidden: true, 'aria-live': 'polite' });
  let timer = 0;
  const put = (text: string, tone: 'good' | 'bad') => {
    clearTimeout(timer);
    setText(el, text);
    setTone(el, ['good', 'bad'], tone);
    el.hidden = !text;
    toggleClass(el, 'fade', false);
    if (tone === 'good') {
      timer = window.setTimeout(() => {
        toggleClass(el, 'fade', true);
        timer = window.setTimeout(() => (el.hidden = true), 600);
      }, 5000);
    }
  };
  return {
    el,
    ok: (t) => put(t, 'good'),
    err: (t) => put(t, 'bad'),
    clear() {
      clearTimeout(timer);
      el.hidden = true;
    },
  };
}

/** Dispatch through act() (toasts the full message) and echo the outcome inline. */
export function run(a: PlayerAction, msg: MsgLine | null, okText?: string): ActionResult {
  const r = act(a, true);
  if (msg) {
    if (r.ok) msg.ok(okText ?? '✓ Done.');
    else msg.err(r.message || 'That could not be done.');
  }
  return r;
}

// ---------------------------------------------------------------------------
// Optional number input (empty = none) in the house style
// ---------------------------------------------------------------------------

export interface OptNumber {
  el: HTMLElement;
  input: HTMLInputElement;
  /** NaN when empty or invalid. */
  readonly value: number;
  readonly empty: boolean;
  readonly error: string | null;
  set(v: number): void;
  setUnit(u: string): void;
}

export function optNumber(o: { placeholder?: string; prefix?: string; unit?: string; min?: number; integer?: boolean; width?: string; onChange?: () => void }): OptNumber {
  const input = h('input', { class: 'num-field', type: 'text', inputMode: 'decimal', spellcheck: false, autocomplete: 'off', placeholder: o.placeholder ?? '' });
  const unitEl = h('span', { class: 'num-unit' }, o.unit ?? '');
  const box = h('label', { class: 'num-input' + (o.prefix ? ' has-pre' : '') }, o.prefix ? h('span', { class: 'num-pre' }, o.prefix) : null, input, unitEl);
  if (o.width) box.style.width = o.width;
  const msg = h('div', { class: 'ctl-msg', hidden: true });
  const el = h('div', { class: 'num-ctl' }, box, msg);
  let value = NaN;
  let error: string | null = null;
  const read = () => {
    const t = input.value.trim();
    if (!t) {
      value = NaN;
      error = null;
    } else {
      const v = parseNumber(t);
      if (!Number.isFinite(v)) error = 'Enter a number, or leave empty';
      else if (o.integer && Math.abs(v - Math.round(v)) > 1e-9) error = 'Whole numbers only';
      else if (o.min !== undefined && v < o.min) error = `At least ${o.min}`;
      else error = null;
      value = error ? NaN : v;
    }
    toggleClass(box, 'invalid', !!error);
    msg.hidden = !error;
    setText(msg, error ?? '');
  };
  input.addEventListener('input', () => {
    read();
    o.onChange?.();
  });
  input.addEventListener('focus', () => input.select());
  return {
    el,
    input,
    get value() {
      return value;
    },
    get empty() {
      return !input.value.trim();
    },
    get error() {
      return error;
    },
    set(v) {
      if (document.activeElement === input) return;
      input.value = Number.isFinite(v) ? String(Number(v.toPrecision(6))) : '';
      read();
    },
    setUnit(u) {
      setText(unitEl, u);
    },
  };
}

/** Change the unit / prefix text of a widget numberInput after creation. */
export function setNumUnit(ctl: { el: HTMLElement }, unit: string): void {
  const u = ctl.el.querySelector('.num-unit');
  if (u) setText(u, unit);
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Plural unit word of a good: "loaves", "sacks". */
export function unitsOf(g: number): string {
  const u = GOODS[g]?.unit ?? 'unit';
  return pluralize(u);
}

/** Singular unit word of a good: "loaf". */
export function unitOf(g: number): string {
  return GOODS[g]?.unit ?? 'unit';
}

export function goodName(g: number): string {
  return GOODS[g]?.name ?? 'Goods';
}

export function townName(s: SimState, t: number): string {
  return s.towns[t]?.name ?? 'the realm';
}

/** Strip "The Treasury now " / "The Treasury will " and capitalise, for compact list descriptions. */
export function tersely(sentence: string): string {
  const t = sentence.replace(/^The Treasury (now |will )/, '');
  return t.length ? t[0].toUpperCase() + t.slice(1) : t;
}

/** Smooth the sim's generic wording where no good is chosen ("No any good may…" → "Nothing may…"). */
export function polishRule(text: string): string {
  return text
    .replace(/^No any good may/, 'No goods may')
    .replace(/units of any good/g, 'units of goods')
    .replace(/trade any good/g, 'trade goods');
}

/** Quantity that never shows float residue: |x| < 0.005 → "0" (fmtQty otherwise). */
export function fmtQ(x: number | null | undefined): string {
  if (typeof x !== 'number' || !Number.isFinite(x)) return DASH;
  return Math.abs(x) < 0.005 ? '0' : fmtQty(x);
}

/** Money that never shows float residue (|x| < half a cent → "¤0.00"). */
export function fmtM(x: number | null | undefined): string {
  if (typeof x !== 'number' || !Number.isFinite(x)) return DASH;
  return fmtMoney(Math.abs(x) < 0.005 ? 0 : x);
}

/** Compact money without float residue. */
export function fmtMS(x: number | null | undefined): string {
  if (typeof x !== 'number' || !Number.isFinite(x)) return DASH;
  return fmtMoneyShort(Math.abs(x) < 0.005 ? 0 : x);
}

/** A finite number or a fallback. */
export function fin(x: number | undefined | null, d = 0): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : d;
}

/** Money with an explicit sign ("+¤4.10" / "−¤2.00"); "¤0.00" when ~0. */
export function signedMoney(x: number): string {
  if (!Number.isFinite(x)) return DASH;
  if (Math.abs(x) < 0.005) return fmtMoney(0);
  return (x > 0 ? '+' : '−') + fmtMoney(Math.abs(x));
}

/** Tone for a flow into (+) or out of (−) the Purse. */
export function flowTone(x: number): Tone {
  if (!Number.isFinite(x) || Math.abs(x) < 0.005) return null;
  return x > 0 ? 'good' : 'bad';
}

/** Round a reference price to something typeable (3 significant figures, ≥ 2 decimals below ¤100). */
export function niceRound(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 0;
  if (x >= 1000) return Math.round(x);
  if (x >= 100) return Math.round(x * 10) / 10;
  if (x >= 1) return Math.round(x * 100) / 100;
  return Number(x.toPrecision(3));
}

/** Safe try/catch wrapper for read-only sim helpers that may be mid-refactor elsewhere. */
export function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** localStorage get/set that never throws. */
export function storeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function storeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** Keyed list reconciliation: builds rows for new keys, drops rows for gone keys, keeps order. */
export function keyedList<T, V extends { el: HTMLElement }>(
  container: HTMLElement,
  key: (x: T) => string | number,
  create: (x: T) => V,
  update: (v: V, x: T) => void,
): (items: readonly T[]) => void {
  const views = new Map<string | number, V>();
  return (items) => {
    const seen = new Set<string | number>();
    let prev: Element | null = null;
    for (const it of items) {
      const k = key(it);
      seen.add(k);
      let v = views.get(k);
      if (!v) {
        v = create(it);
        views.set(k, v);
      }
      update(v, it);
      const want: Element | null = prev ? prev.nextElementSibling : container.firstElementChild;
      if (want !== v.el) container.insertBefore(v.el, want);
      prev = v.el;
    }
    for (const [k, v] of views) {
      if (!seen.has(k)) {
        v.el.remove();
        views.delete(k);
      }
    }
  };
}

/** A tiny progress bar. */
export function bar(cls = ''): { el: HTMLElement; set(f: number): void } {
  const fill = h('i');
  const el = h('div', { class: 'lv-bar' + (cls ? ' ' + cls : '') }, fill);
  let last = -1;
  return {
    el,
    set(f) {
      const v = Math.max(0, Math.min(1, fin(f)));
      if (Math.abs(v - last) < 0.001) return;
      last = v;
      fill.style.width = (v * 100).toFixed(1) + '%';
    },
  };
}

/**
 * When in the day an order trades: all day (a third of the day's quantity at each market session,
 * what is left carried to the next) or in one session only (0 opening, 1 midday, 2 close).
 */
export function sessionSeg(onChange: (v: number) => void): { el: HTMLElement; get value(): number; set(v: number): void } {
  const seg = segmented<number>({
    options: [
      { value: -1, label: 'All day', title: 'Spread over the day’s three market sessions, like everyone’s orders: what one session leaves goes to the next' },
      { value: 0, label: 'Opening', title: 'All of it at the opening market (morning)' },
      { value: 1, label: 'Midday', title: 'All of it at the midday market' },
      { value: 2, label: 'Close', title: 'All of it at the closing market (evening)' },
    ],
    value: -1,
    size: 'sm',
    onChange,
  });
  return seg;
}

/** "at the opening" / "at midday" / "at the close" / "" for an order's session. */
export function sessionWords(session: number | undefined): string {
  return session === 0 ? 'at the opening' : session === 1 ? 'at midday' : session === 2 ? 'at the close' : '';
}
