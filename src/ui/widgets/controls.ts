// ============================================================================
// Form controls in the house style. Every control returns `{ el, value, set }`;
// set() never clobbers a field the user is currently typing in, so panels can
// call it on every refresh.
//
//   const good = selectInput({ options: goodOptions(), value: G.bread, onChange: (g) => … });
//   const rate = numberInput({ value: 0.1, percent: true, min: -1, max: 10, onCommit: (v) => … });
//   const side = segmented({ options: [{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }], value: 'buy' });
//   form.append(field('Good', good), field('Rate', rate, 'Share of each sale'), field('Side', side));
// ============================================================================
import { GOODS, type GoodDef } from '../../sim/goods';
import type { SimState } from '../../sim/types';
import { h, setText, toggleClass, type Child } from '../dom';
import { fmtNum } from '../format';

export interface Option<V> {
  value: V;
  label: string;
  /** <optgroup> label (select only). */
  group?: string;
  disabled?: boolean;
  title?: string;
}

export interface Control<V> {
  el: HTMLElement;
  readonly value: V;
  set(v: V): void;
  setDisabled(disabled: boolean): void;
}

// ---- select ---------------------------------------------------------------------

export interface SelectOptions<V extends string | number> {
  options: Option<V>[];
  value: V;
  onChange?: (v: V) => void;
  title?: string;
  /** CSS width ('160px', '100%'). */
  width?: string;
}

export interface Select<V extends string | number> extends Control<V> {
  setOptions(options: Option<V>[], value?: V): void;
}

/** Native <select> (keeps the macOS popup) styled to the theme. */
export function selectInput<V extends string | number>(o: SelectOptions<V>): Select<V> {
  let options = o.options;
  let value = o.value;
  const sel = h('select', { class: 'select', title: o.title ?? null });
  if (o.width) sel.style.width = o.width;
  const wrap = h('span', { class: 'select-wrap' }, sel);
  if (o.width) wrap.style.width = o.width;

  function build(): void {
    sel.textContent = '';
    const groups = new Map<string, HTMLOptGroupElement>();
    options.forEach((op, i) => {
      const opt = h('option', { value: String(i), disabled: op.disabled ?? false, title: op.title ?? null }, op.label);
      if (op.group) {
        let g = groups.get(op.group);
        if (!g) {
          g = h('optgroup', { label: op.group });
          groups.set(op.group, g);
          sel.appendChild(g);
        }
        g.appendChild(opt);
      } else sel.appendChild(opt);
    });
    sync();
  }
  function sync(): void {
    const i = options.findIndex((op) => op.value === value);
    const want = String(Math.max(0, i));
    if (sel.value !== want) sel.value = want;
  }
  sel.addEventListener('change', () => {
    const op = options[Number(sel.value)];
    if (!op) return;
    value = op.value;
    o.onChange?.(value);
  });
  build();
  return {
    el: wrap,
    get value() {
      return value;
    },
    set(v) {
      value = v;
      if (document.activeElement !== sel) sync();
    },
    setOptions(next, v) {
      const same = next.length === options.length && next.every((x, i) => x.value === options[i].value && x.label === options[i].label);
      options = next;
      if (v !== undefined) value = v;
      if (!options.some((x) => x.value === value) && options.length) value = options[0].value;
      if (same) sync();
      else build();
    },
    setDisabled(d) {
      sel.disabled = d;
      toggleClass(wrap, 'disabled', d);
    },
  };
}

// ---- number input -----------------------------------------------------------------

export interface NumberInputOptions {
  value: number;
  /** Fires on every valid edit. */
  onChange?: (v: number) => void;
  /** Fires on Enter / blur with a valid value. */
  onCommit?: (v: number) => void;
  min?: number;
  max?: number;
  /** Arrow-key step in displayed units (Shift = ×10). Default: magnitude-based. */
  step?: number;
  /** Text before the number ('¤'). */
  prefix?: string;
  /** Text after the number ('/day', 'workers'). */
  unit?: string;
  /** The value is a fraction, shown and typed as a percentage (0.1 ↔ "10"). Unit defaults to '%'. */
  percent?: boolean;
  /** Decimals when displaying a programmatic value (default: up to 4 significant). */
  digits?: number;
  integer?: boolean;
  /** Custom validation: return an error message or null. Receives the model value. */
  validate?: (v: number) => string | null;
  placeholder?: string;
  width?: string;
  title?: string;
}

export interface NumberInput extends Control<number> {
  input: HTMLInputElement;
  /** Is the current text a valid value? */
  readonly valid: boolean;
  readonly error: string | null;
  focus(): void;
}

/** Parse a typed number: accepts commas, spaces, ¤ and %, and k/M/B suffixes. Returns NaN if invalid. */
export function parseNumber(text: string): number {
  let t = text.trim().replace(/[,\s¤%]/g, '').replace(/−/g, '-');
  if (!t) return NaN;
  let mult = 1;
  const m = /([kmb])$/i.exec(t);
  if (m) {
    mult = { k: 1e3, m: 1e6, b: 1e9 }[m[1].toLowerCase() as 'k' | 'm' | 'b'];
    t = t.slice(0, -1);
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return NaN;
  const v = Number(t) * mult;
  return Number.isFinite(v) ? v : NaN;
}

export function numberInput(o: NumberInputOptions): NumberInput {
  const scale = o.percent ? 100 : 1;
  const unit = o.unit ?? (o.percent ? '%' : undefined);
  let value = o.value;
  let error: string | null = null;
  const input = h('input', {
    class: 'num-field',
    type: 'text',
    inputMode: 'decimal',
    spellcheck: false,
    autocomplete: 'off',
    placeholder: o.placeholder ?? null,
    title: o.title ?? null,
  });
  const msg = h('div', { class: 'ctl-msg', hidden: true });
  const box = h('label', { class: 'num-input' + (o.prefix ? ' has-pre' : '') }, o.prefix ? h('span', { class: 'num-pre' }, o.prefix) : null, input, unit ? h('span', { class: 'num-unit' }, unit) : null);
  const el = h('div', { class: 'num-ctl' }, box, msg);
  if (o.width) box.style.width = o.width;

  const show = (v: number) => {
    if (!Number.isFinite(v)) return '';
    const d = v * scale;
    if (o.digits !== undefined) return d.toFixed(o.digits);
    if (o.integer) return String(Math.round(d));
    return String(Number(d.toPrecision(6)));
  };

  function check(v: number): string | null {
    if (!Number.isFinite(v)) return 'Enter a number';
    if (o.integer && Math.abs(v - Math.round(v)) > 1e-9) return 'Whole numbers only';
    if (o.min !== undefined && v < o.min - 1e-12) return `At least ${fmtNum(o.min * scale)}${unit === '%' ? '%' : ''}`;
    if (o.max !== undefined && v > o.max + 1e-12) return `At most ${fmtNum(o.max * scale)}${unit === '%' ? '%' : ''}`;
    return o.validate ? o.validate(v) : null;
  }

  function readInput(): number {
    const raw = parseNumber(input.value);
    return Number.isFinite(raw) ? raw / scale : NaN;
  }

  function paintError(): void {
    toggleClass(box, 'invalid', !!error);
    msg.hidden = !error;
    setText(msg, error ?? '');
  }

  input.addEventListener('input', () => {
    const v = readInput();
    error = check(v);
    paintError();
    if (!error) {
      value = v;
      o.onChange?.(v);
    }
  });
  const commit = () => {
    const v = readInput();
    error = check(v);
    paintError();
    if (!error) {
      value = v;
      o.onCommit?.(v);
    }
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit();
      input.select();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = Number.isFinite(readInput()) ? readInput() : value;
      const disp = cur * scale;
      const base = o.step ?? (o.integer ? 1 : autoStep(disp));
      let next = (disp + (e.key === 'ArrowUp' ? 1 : -1) * base * (e.shiftKey ? 10 : 1)) / scale;
      if (o.min !== undefined) next = Math.max(o.min, next);
      if (o.max !== undefined) next = Math.min(o.max, next);
      input.value = show(Number(next.toPrecision(12)));
      input.dispatchEvent(new Event('input'));
    }
  });
  input.addEventListener('focus', () => input.select());

  input.value = show(value);
  error = check(value);
  if (!Number.isFinite(value)) error = null; // empty initial value is not an error until typed
  paintError();

  return {
    el,
    input,
    get value() {
      return error ? NaN : value;
    },
    get valid() {
      return !error && Number.isFinite(value);
    },
    get error() {
      return error;
    },
    set(v) {
      if (document.activeElement === input) return; // never fight the user's typing
      value = v;
      const t = show(v);
      if (input.value !== t) input.value = t;
      error = Number.isFinite(v) ? check(v) : null;
      paintError();
    },
    setDisabled(d) {
      input.disabled = d;
      toggleClass(box, 'disabled', d);
    },
    focus: () => input.focus(),
  };
}

function autoStep(v: number): number {
  const a = Math.abs(v);
  if (a < 1) return 0.1;
  const mag = Math.pow(10, Math.floor(Math.log10(a)) - 1);
  return Math.max(0.1, mag);
}

// ---- text input ------------------------------------------------------------------

export interface TextInputOptions {
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  width?: string;
}

export function textInput(o: TextInputOptions): Control<string> & { input: HTMLInputElement } {
  let value = o.value;
  const input = h('input', { class: 'text-field', type: 'text', value, placeholder: o.placeholder ?? null, maxLength: o.maxLength ?? 80, spellcheck: false });
  if (o.width) input.style.width = o.width;
  input.addEventListener('input', () => {
    value = input.value;
    o.onChange?.(value);
  });
  return {
    el: input,
    input,
    get value() {
      return value;
    },
    set(v) {
      value = v;
      if (document.activeElement !== input && input.value !== v) input.value = v;
    },
    setDisabled(d) {
      input.disabled = d;
    },
  };
}

// ---- segmented control ---------------------------------------------------------------

export interface SegmentedOptions<V> {
  options: Option<V>[];
  value: V;
  onChange?: (v: V) => void;
  size?: 'sm' | 'md';
  /** Stretch buttons to fill the width. */
  full?: boolean;
}

export function segmented<V>(o: SegmentedOptions<V>): Control<V> {
  let value = o.value;
  const btns = o.options.map((op) =>
    h(
      'button',
      {
        class: 'seg-btn',
        type: 'button',
        title: op.title ?? null,
        disabled: op.disabled ?? false,
        onClick: () => {
          if (value === op.value) return;
          value = op.value;
          paint();
          o.onChange?.(value);
        },
      },
      op.label,
    ),
  );
  const el = h('div', { class: 'seg seg-' + (o.size ?? 'md') + (o.full ? ' seg-full' : ''), role: 'group' }, btns);
  function paint(): void {
    o.options.forEach((op, i) => {
      toggleClass(btns[i], 'on', op.value === value);
      btns[i].setAttribute('aria-pressed', String(op.value === value));
    });
  }
  paint();
  return {
    el,
    get value() {
      return value;
    },
    set(v) {
      value = v;
      paint();
    },
    setDisabled(d) {
      for (const b of btns) b.disabled = d;
    },
  };
}

// ---- toggle switch -----------------------------------------------------------------

export interface ToggleOptions {
  value: boolean;
  onChange?: (v: boolean) => void;
  label?: string;
  title?: string;
}

export function toggle(o: ToggleOptions): Control<boolean> {
  let value = o.value;
  const btn = h('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    title: o.title ?? null,
    onClick: () => {
      value = !value;
      paint();
      o.onChange?.(value);
    },
  }, h('span', { class: 'switch-knob' }));
  const el = o.label ? h('label', { class: 'switch-row' }, btn, h('span', { class: 'switch-lab', onClick: () => btn.click() }, o.label)) : btn;
  function paint(): void {
    toggleClass(btn, 'on', value);
    btn.setAttribute('aria-checked', String(value));
  }
  paint();
  return {
    el,
    get value() {
      return value;
    },
    set(v) {
      value = v;
      paint();
    },
    setDisabled(d) {
      btn.disabled = d;
    },
  };
}

// ---- slider ------------------------------------------------------------------------

export interface SliderOptions {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange?: (v: number) => void;
  /** Fires when the user releases the thumb. */
  onCommit?: (v: number) => void;
  format?: (v: number) => string;
  /** Log-scaled track (min must be > 0). */
  log?: boolean;
  width?: string;
}

export function slider(o: SliderOptions): Control<number> {
  let value = o.value;
  const log = !!o.log && o.min > 0;
  const RES = 1000;
  const toPos = (v: number) => (log ? (Math.log(v / o.min) / Math.log(o.max / o.min)) * RES : ((v - o.min) / (o.max - o.min || 1)) * RES);
  const fromPos = (p: number) => {
    let v = log ? o.min * Math.pow(o.max / o.min, p / RES) : o.min + ((o.max - o.min) * p) / RES;
    if (o.step) v = Math.round(v / o.step) * o.step;
    return Math.max(o.min, Math.min(o.max, Number(v.toPrecision(10))));
  };
  const input = h('input', { class: 'range', type: 'range', min: '0', max: String(RES), step: '1' });
  const out = h('output', { class: 'range-val' });
  const el = h('div', { class: 'range-ctl' }, input, out);
  if (o.width) el.style.width = o.width;
  const fmt = o.format ?? ((v: number) => fmtNum(v));
  function paint(): void {
    const p = Math.max(0, Math.min(RES, toPos(value)));
    if (document.activeElement !== input) input.value = String(Math.round(p));
    input.style.setProperty('--fill', (p / RES) * 100 + '%');
    setText(out, fmt(value));
  }
  input.addEventListener('input', () => {
    value = fromPos(Number(input.value));
    input.style.setProperty('--fill', (Number(input.value) / RES) * 100 + '%');
    setText(out, fmt(value));
    o.onChange?.(value);
  });
  input.addEventListener('change', () => o.onCommit?.(value));
  paint();
  return {
    el,
    get value() {
      return value;
    },
    set(v) {
      value = v;
      paint();
    },
    setDisabled(d) {
      input.disabled = d;
    },
  };
}

// ---- buttons & layout ------------------------------------------------------------------

export interface ButtonOptions {
  label: Child;
  onClick?: (e: MouseEvent) => void;
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  title?: string;
  icon?: Node;
  disabled?: boolean;
}

export function button(o: ButtonOptions): HTMLButtonElement {
  return h(
    'button',
    {
      class: `btn btn-${o.kind ?? 'secondary'}${o.size === 'sm' ? ' btn-sm' : ''}`,
      type: 'button',
      title: o.title ?? null,
      disabled: o.disabled ?? false,
      onClick: o.onClick ?? null,
    },
    o.icon ?? null,
    o.label,
  );
}

/** A labelled form row: label on the left (or above with `stacked`), control, optional hint. */
export function field(label: string, control: HTMLElement | { el: HTMLElement }, hint?: string, stacked = false): HTMLElement {
  const c = control instanceof HTMLElement ? control : control.el;
  return h('div', { class: 'field' + (stacked ? ' field-stacked' : '') }, h('div', { class: 'field-lab' }, label), h('div', { class: 'field-ctl' }, c, hint ? h('div', { class: 'field-hint' }, hint) : null));
}

// ---- common option lists ------------------------------------------------------------------

/** Goods as select options (optionally filtered), e.g. goodOptions((g) => g.consumer). */
export function goodOptions(filter?: (g: GoodDef) => boolean, anyLabel?: string): Option<number>[] {
  const out: Option<number>[] = anyLabel ? [{ value: -1, label: anyLabel }] : [];
  for (const g of GOODS) if (!filter || filter(g)) out.push({ value: g.id, label: g.name });
  return out;
}

/** Towns of the current realm as select options; `anyLabel` adds a −1 "all towns" entry. */
export function townOptions(s: SimState, anyLabel?: string): Option<number>[] {
  const out: Option<number>[] = anyLabel ? [{ value: -1, label: anyLabel }] : [];
  for (const t of s.towns ?? []) out.push({ value: t.id, label: t.name });
  return out;
}

/** A small colour swatch (for a good or series) to put before a label. */
export function swatch(color: string, shape: 'dot' | 'box' | 'line' = 'dot'): HTMLElement {
  return h('span', { class: 'swatch swatch-' + shape, style: { background: color } });
}
