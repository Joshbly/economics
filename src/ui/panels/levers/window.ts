// ============================================================================
// Lever V — Window: the rate the Treasury pays on the Bank's reserves and the
// rate it charges on what the Bank borrows at its window (lend ≥ reserve).
// A "rate ladder" shows where the Bank's own rates sit against the two.
// ============================================================================
import { DAYS_PER_YEAR, PLAYER_MAX_RATE, PLAYER_MIN_RATE } from '../../../sim/config';
import type { SimState } from '../../../sim/types';
import { h, setText, show, toggleClass } from '../../dom';
import { fmtPct, fmtRate } from '../../format';
import { button, numberInput, slider } from '../../widgets';
import { fin, fmtM, formEl, formFoot, hint, msgLine, row, run, submitButton, type Lever } from './common';

interface Rung {
  key: string;
  label: string;
  title: string;
  mine?: 'reserve' | 'lend';
  info?: boolean;
  get(s: SimState): number;
}

export function windowLever(): Lever {
  let dirty = false;
  let rr = 0.02;
  let lr = 0.05;
  let last: SimState | null = null;
  const msg = msgLine();

  const touch = () => {
    dirty = true;
    msg.clear();
    paint();
  };
  const rrIn = numberInput({ value: rr, percent: true, min: PLAYER_MIN_RATE, max: PLAYER_MAX_RATE, width: '82px', onChange: (v) => ((rr = v), rrSl.set(v), touch()) });
  const lrIn = numberInput({ value: lr, percent: true, min: PLAYER_MIN_RATE, max: PLAYER_MAX_RATE, width: '82px', onChange: (v) => ((lr = v), lrSl.set(v), touch()) });
  const rrSl = slider({ min: 0, max: 0.2, step: 0.0025, value: rr, format: (v) => fmtRate(v), onChange: (v) => ((rr = v), rrIn.set(v), touch()) });
  const lrSl = slider({ min: 0, max: 0.2, step: 0.0025, value: lr, format: (v) => fmtRate(v), onChange: (v) => ((lr = v), lrIn.set(v), touch()) });
  rrSl.el.classList.add('lv-slider');
  lrSl.el.classList.add('lv-slider');
  const clampNote = hint();

  const rungs: Rung[] = [
    { key: 'loan', label: 'Loan rate, avg', title: 'Average rate the Bank charges on its loans', get: (s) => fin(s.stats?.latest?.loanRate, NaN) },
    { key: 'base', label: 'Bank base', title: 'The Bank’s funding cost plus its base spread; loans are priced above it', get: (s) => fin(s.bank?.baseRate, NaN) },
    { key: 'lend', label: 'Lend rate', title: 'What the Treasury charges on the Bank’s window borrowing (you set this)', mine: 'lend', get: (s) => fin(s.treasury.lendRate, NaN) },
    { key: 'res', label: 'Reserve rate', title: 'What the Treasury pays on the Bank’s reserves (you set this)', mine: 'reserve', get: (s) => fin(s.treasury.reserveRate, NaN) },
    { key: 'dep', label: 'Deposit rate', title: 'What the Bank pays savers on their balances', get: (s) => fin(s.bank?.depositRate, NaN) },
    { key: 'iou', label: 'IOU yield', title: 'What an IOU bought at today’s price earns a year', get: (s) => fin(s.stats?.latest?.iouYield, NaN) },
    { key: 'infl', label: 'Prices, 30 d', title: 'How fast consumer prices rose over the last 30 days, a year’s pace', info: true, get: (s) => fin(s.stats?.latest?.infl30, NaN) },
  ];
  const rungEls = rungs.map((r) => {
    const fill = h('i', { class: 'lv-lad-fill' });
    const ghost = h('b', { class: 'lv-lad-ghost', hidden: true });
    const val = h('span', { class: 'lv-lad-v' });
    const el = h(
      'div',
      { class: 'lv-lad-row' + (r.mine ? ' mine' : '') + (r.info ? ' info' : ''), title: r.title },
      h('span', { class: 'lv-lad-l' }, r.label),
      h('span', { class: 'lv-lad-track' }, h('span', { class: 'lv-lad-zero' }), fill, ghost),
      val,
    );
    return { r, el, fill, ghost, val };
  });
  const ladder = h(
    'div',
    { class: 'lv-ladder' },
    h('div', { class: 'lv-lad-head' }, h('span', null, 'Rates, a year'), h('span', null, h('i', { class: 'lv-lad-key' }), 'set at the window')),
    rungEls.map((x) => x.el),
  );

  const kvRes = h('span', { class: 'lv-kv-v' });
  const kvRatio = h('span', { class: 'lv-kv-v' });
  const kvDebt = h('span', { class: 'lv-kv-v' });
  const kvCost = h('span', { class: 'lv-kv-v' });
  const kvCostL = h('span', { class: 'lv-kv-l' }, 'Treasury pays / day');
  const kv = h(
    'div',
    { class: 'lv-kv4 lv-kv2' },
    h('div', null, h('span', { class: 'lv-kv-l' }, 'Bank reserves'), kvRes),
    h('div', null, h('span', { class: 'lv-kv-l' }, 'Reserves ÷ deposits'), kvRatio),
    h('div', null, h('span', { class: 'lv-kv-l' }, 'Window debt'), kvDebt),
    h('div', { title: 'Interest on reserves paid out, minus window interest received, per day at the rates shown' }, kvCostL, kvCost),
  );

  const preview = h('div', { class: 'lv-preview' });
  const apply = submitButton('Apply', 'Set both rates (Enter)');
  const reset = button({ label: 'Reset', kind: 'ghost', title: 'Back to the rates in force', onClick: () => ((dirty = false), msg.clear(), sync(true)) });

  const form = formEl(
    () => submit(),
    row('Reserve rate', rrIn.el, rrSl.el),
    row('Lend rate', lrIn.el, lrSl.el),
    clampNote,
    ladder,
    kv,
    formFoot(preview, msg, reset, apply),
  );
  const body = h(
    'div',
    { class: 'lv-body-in' },
    h(
      'p',
      { class: 'lv-lead' },
      'The Bank keeps its reserves at the Treasury and borrows at its window when short. The reserve rate (paid to the Bank) and the lend rate (charged to it) bracket what money costs the Bank — and so what it pays savers and charges borrowers.',
    ),
    form,
  );

  function sync(force = false): void {
    const s = last;
    if (!s || (dirty && !force)) return;
    rr = fin(s.treasury.reserveRate);
    lr = fin(s.treasury.lendRate);
    rrIn.set(rr);
    lrIn.set(lr);
    rrSl.set(rr);
    lrSl.set(lr);
    paint();
  }

  function paint(): void {
    const s = last;
    if (!s) return;
    const effLend = Math.max(lr, rr);
    setText(clampNote, lr < rr - 1e-12 ? `The lending rate cannot sit below the reserve rate; it will be raised to ${fmtRate(rr)}.` : '');
    show(clampNote, lr < rr - 1e-12);

    // ladder scale
    const vals = rungEls.map((x) => (x.r.mine === 'reserve' ? rr : x.r.mine === 'lend' ? effLend : x.r.get(s)));
    const cur = rungEls.map((x) => x.r.get(s));
    let lo = 0;
    let hi = 0.05;
    rungEls.forEach((x, i) => {
      if (x.r.info) return;
      for (const v of [vals[i], cur[i]]) if (Number.isFinite(v)) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
    });
    // context rows (inflation) widen the scale only when they are within reach of the rates
    const reach = hi - lo;
    rungEls.forEach((x, i) => {
      const v = vals[i];
      if (!x.r.info || !Number.isFinite(v)) return;
      if (v <= hi + reach && v >= lo - reach) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
    });
    hi *= 1.15;
    lo = lo < 0 ? lo * 1.15 : 0;
    const span = hi - lo || 1;
    const X = (v: number) => ((v - lo) / span) * 100;
    rungEls.forEach((x, i) => {
      const raw = vals[i];
      const v = Number.isFinite(raw) ? Math.max(lo, Math.min(hi, raw)) : raw;
      const c = cur[i];
      toggleClass(x.el, 'over-hi', Number.isFinite(raw) && raw > hi);
      toggleClass(x.el, 'over-lo', Number.isFinite(raw) && raw < lo);
      const zero = x.el.querySelector('.lv-lad-zero') as HTMLElement;
      zero.style.left = X(0) + '%';
      if (Number.isFinite(v)) {
        const a = Math.min(X(0), X(v));
        const b = Math.max(X(0), X(v));
        x.fill.style.left = a + '%';
        x.fill.style.width = Math.max(0.6, b - a) + '%';
        toggleClass(x.fill, 'neg', v < 0);
      } else x.fill.style.width = '0';
      const changed = !!x.r.mine && Number.isFinite(c) && Math.abs(c - raw) > 1e-9;
      x.ghost.hidden = !changed;
      if (changed) x.ghost.style.left = X(c) + '%';
      setText(x.val, !Number.isFinite(raw) ? '—' : changed ? `${fmtRate(c)} → ${fmtRate(raw)}` : fmtRate(raw));
      toggleClass(x.el, 'pending', changed);
    });

    const L = s.stats?.latest ?? {};
    const res = fin(s.bank?.reserves);
    const dep = fin(L.money);
    const debt = fin(s.bank?.windowDebt);
    setText(kvRes, fmtM(res));
    setText(kvRatio, dep > 0 ? fmtPct(res / dep) : '—');
    setText(kvDebt, fmtM(debt));
    const cost = (Math.max(0, res) * rr - debt * effLend) / DAYS_PER_YEAR;
    setText(kvCostL, cost >= 0 ? 'Treasury pays / day' : 'Treasury earns / day');
    setText(kvCost, fmtM(Math.abs(cost)));
    toggleClass(kvCost, 'bad', cost > 0.005);
    toggleClass(kvCost, 'good', cost < -0.005);

    const changed = Math.abs(rr - fin(s.treasury.reserveRate)) > 1e-9 || Math.abs(effLend - fin(s.treasury.lendRate)) > 1e-9;
    const B = (t: string) => h('b', null, t);
    if (changed)
      preview.replaceChildren('Pay ', B(fmtRate(rr)), ' a year on reserves and charge ', B(fmtRate(effLend)), ' at the window. The Bank reprices from tomorrow.');
    else preview.replaceChildren('These are the rates in force. Move either one to see the change.');
    apply.disabled = !changed || !rrIn.valid || !lrIn.valid;
    reset.disabled = !dirty;
  }

  function submit(): void {
    if (!rrIn.valid || !lrIn.valid) return msg.err(rrIn.error ?? lrIn.error ?? 'Enter both rates.');
    const r = run({ type: 'setWindow', reserveRate: rr, lendRate: Math.max(lr, rr) }, msg, '✓ New window rates in force.');
    if (r.ok) {
      dirty = false;
      sync(true);
    }
  }

  return {
    id: 'window',
    title: 'Window',
    tagline: 'What reserves earn, what borrowing costs',
    body,
    summary(s) {
      return { text: `${fmtRate(fin(s.treasury.reserveRate))} · ${fmtRate(fin(s.treasury.lendRate))}` };
    },
    update(s) {
      last = s;
      sync();
      paint();
    },
    opened(s) {
      last = s;
      if (!dirty) sync(true);
    },
    focus: () => rrIn.focus(),
    reset() {
      dirty = false;
      last = null;
    },
  };
}
