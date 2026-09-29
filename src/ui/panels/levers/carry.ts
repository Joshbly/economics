// ============================================================================
// Levers panel — Trade → Carry: move the Treasury's own goods from its store in
// one town to its store in another (dispatches `carry`; the rule's daily running
// lives in sim/policy/carry.ts).
//
//   From [town] to [town] · Goods [good] · Amount [Everything | Up to n a day]
//   Wagons [Full wagons | Right away] · Duration [Once | N days | Until removed]
//
// A carry neither buys nor sells: a buy order fills the store at the origin, a
// sell order empties the store at the destination. So a supply line is three
// rows in In force (buy · carry · sell), each changed on its own; the form ends
// with a one-click "Sell in B" that opens the Goods form on that market.
// ============================================================================
import { CARRY_FULL_SHARE, PLAYER_MAX_QTY, TREASURY_FREIGHT_PREMIUM, WAGON_CAPACITY } from '../../../sim/config';
import { carryHoldDays } from '../../../sim/policy/carry';
import { lineBetween } from '../../../sim/policy/lines';
import { freightPerUnit } from '../../../sim/agents/traders';
import { G, N_GOODS } from '../../../sim/goods';
import { routeBetweenTowns } from '../../../sim/world/paths';
import type { SimState } from '../../../sim/types';
import { h, setText, show } from '../../dom';
import { fmtNum, fmtPct, plural } from '../../format';
import { goodOptions, numberInput, segmented, selectInput, townOptions } from '../../widgets';
import { chip, fin, fmtM, fmtQ, formEl, formFoot, goodName, hint, msgLine, row, run, safe, setNumUnit, submitButton, townName, unitsOf } from './common';

type Amount = 'all' | 'some';
type Dur = 'once' | 'days' | 'standing';

export interface CarryForm {
  el: HTMLElement;
  update(s: SimState): void;
  /** Start from a store: the town (and good) the player was looking at. */
  seed(s: SimState, town: number, good: number): void;
  focus(): void;
  reset(): void;
}

export function carryForm(opts: { sellThere: (town: number, good: number, perDay: number) => void }): CarryForm {
  let last: SimState | null = null;
  let amount: Amount = 'all';
  let wagons: 'full' | 'now' = 'full';
  let dur: Dur = 'standing';
  const msg = msgLine();
  const edited = () => {
    msg.clear();
    paint();
  };

  const from = selectInput<number>({ options: [{ value: 0, label: '—' }], value: 0, onChange: () => edited() });
  const to = selectInput<number>({ options: [{ value: 1, label: '—' }], value: 1, onChange: () => edited() });
  const good = selectInput<number>({ options: goodOptions(), value: G.bread, onChange: () => edited() });
  const heldHint = hint();
  const amountSeg = segmented<Amount>({
    options: [
      { value: 'all', label: 'Everything', title: 'All the Treasury holds of it there — and, for a standing rule, whatever comes in' },
      { value: 'some', label: 'Up to', title: 'A set amount (a day, for a standing rule)' },
    ],
    value: amount,
    size: 'sm',
    onChange: (v) => ((amount = v), edited()),
  });
  const qty = numberInput({ value: 40, min: 0, max: PLAYER_MAX_QTY, unit: 'loaves/day', width: '140px', onChange: () => edited() });
  const wagonSeg = segmented<'full' | 'now'>({
    options: [
      { value: 'full', label: 'Full wagons', title: 'Wait for a nearly full wagon (or as long as the goods keep): the least freight per unit' },
      { value: 'now', label: 'Right away', title: 'Send what is held after every market session: quicker, dearer per unit when loads are small' },
    ],
    value: wagons,
    size: 'sm',
    onChange: (v) => ((wagons = v), edited()),
  });
  const wagonHint = hint();
  const durSeg = segmented<Dur>({
    options: [
      { value: 'once', label: 'Once, now', title: 'Send it now; no rule is kept' },
      { value: 'days', label: 'N days' },
      { value: 'standing', label: 'Until removed' },
    ],
    value: dur,
    size: 'sm',
    onChange: (v) => ((dur = v), edited()),
  });
  const days = numberInput({ value: 30, integer: true, min: 1, max: 36000, unit: 'days', width: '96px', onChange: () => edited() });
  const wagonRow = row('Wagons', wagonSeg.el, wagonHint);
  const preview = h('div', { class: 'lv-preview' });
  const sellChip = chip('Sell there…', () => last && opts.sellThere(to.value, good.value, arriving(last)), 'Open the Goods form on the market at the destination, to offer what arrives');
  const btn = submitButton('Carry');
  const form = formEl(
    () => submit(),
    row('From', from.el, h('span', { class: 'lv-w' }, 'to'), to.el),
    row('Goods', good.el, heldHint),
    row('Amount', amountSeg.el, qty.el),
    wagonRow,
    row('Duration', durSeg.el, days.el),
    formFoot(preview, msg, sellChip, btn),
  );
  const el = h('div', { class: 'lv-carry' }, form);

  /** About how much a day this carry brings (its daily amount, or what the Treasury's orders buy there a day): the sell order's default. */
  function arriving(s: SimState): number {
    if (amount === 'some' && qty.value > 0) return qty.value;
    let n = 0;
    for (const o of s.policy.orders)
      if (o.enabled && o.side === 'buy' && o.market.kind === 'good' && o.market.town === from.value && o.market.good === good.value) n += o.qty;
    return n;
  }

  function paint(): void {
    const s = last;
    if (!s) return;
    const A = from.value;
    const B = to.value;
    const g = good.value;
    const once = dur === 'once';
    const have = fin(s.treasury.goods[A]?.[g]);
    setText(heldHint, `Held in ${townName(s, A)}: ${fmtQ(have)} ${unitsOf(g)}`);
    show(qty.el, amount === 'some');
    setNumUnit(qty, once ? unitsOf(g) : `${unitsOf(g)}/day`);
    show(wagonRow, !once);
    show(days.el, dur === 'days');
    setText(sellChip, `Sell in ${townName(s, B)}…`);
    setText(
      wagonHint,
      wagons === 'full'
        ? `Leaves ${fmtPct(CARRY_FULL_SHARE)} full, or after ${plural(carryHoldDays(g), 'day')} of waiting.`
        : 'Leaves after every market session.',
    );
    const B_ = (x: string) => h('b', null, x);
    const fail = (why: string) => {
      preview.replaceChildren(why);
      btn.disabled = true;
    };
    if (A === B) return fail('Choose two different towns.');
    const fpu = safe(() => freightPerUnit(s, A, B), -1);
    if (!(fpu >= 0)) return fail(`No wagon road links ${townName(s, A)} and ${townName(s, B)}.`);
    if (amount === 'some' && !(qty.value > 0)) return fail('Set an amount.');
    if (once && !(have > 0.005)) return fail(`The Treasury holds no ${goodName(g).toLowerCase()} in ${townName(s, A)}. Buy some there first (Goods), or make this a standing rule that carries it as it comes in.`);
    const perWagon = fpu * WAGON_CAPACITY * (1 + TREASURY_FREIGHT_PREMIUM);
    const dd = safe(() => routeBetweenTowns(s, A, B).days, NaN);
    const line = safe(() => lineBetween(s, A, B), undefined);
    const bits: (string | Node)[] = [];
    if (once) {
      const q = amount === 'all' ? have : Math.min(qty.value, have);
      const n = Math.max(1, Math.ceil(q / WAGON_CAPACITY - 1e-9));
      bits.push('Sends ', B_(`${fmtQ(q)} ${unitsOf(g)}`), ' now: freight ≈ ', B_(fmtM(perWagon * n)), ` for ${plural(n, 'wagon')}`);
    } else {
      bits.push(amount === 'all' ? `Carries all the ${goodName(g).toLowerCase()} held in ${townName(s, A)}, as it comes in` : `Carries up to ${fmtQ(qty.value)} ${unitsOf(g)} a day`);
      bits.push(' · freight ≈ ', B_(fmtM(perWagon)), ' a wagon', wagons === 'full' ? ` (${fmtM(perWagon / WAGON_CAPACITY)} a unit when full)` : ', however little it carries');
    }
    if (Number.isFinite(dd) && dd > 0) bits.push(` · about ${fmtNum(Math.max(0.5, dd), 1)} days on the road`);
    bits.push('. ');
    if (line) bits.push('Your freight line on this road takes it for nothing when it has room. ');
    bits.push(h('span', { class: 'faint' }, `It lands in the Treasury’s store in ${townName(s, B)}; a sell order there offers it.`));
    preview.replaceChildren(...bits);
    btn.disabled = dur === 'days' && !(days.value > 0);
    setText(btn, once ? 'Send now' : 'Carry');
  }

  function submit(): void {
    const s = last;
    if (!s) return;
    const q = amount === 'all' ? -1 : qty.value;
    if (amount === 'some' && !(q > 0)) return msg.err(qty.error ?? 'Set an amount.');
    run(
      {
        type: 'carry',
        from: from.value,
        to: to.value,
        good: good.value,
        qty: q,
        once: dur === 'once',
        days: dur === 'days' ? Math.max(1, Math.round(days.value)) : undefined,
        wagons: dur === 'once' ? undefined : wagons,
      },
      msg,
      dur === 'once' ? '✓ On its way.' : '✓ Carry rule placed — it is listed under In force.',
    );
  }

  /** Start at the largest holding when nothing was chosen yet. */
  function largestHolding(s: SimState): [number, number] | null {
    let best: [number, number] | null = null;
    let bq = 0.005;
    for (let t = 0; t < s.towns.length; t++)
      for (let g = 0; g < N_GOODS; g++) {
        const q = fin(s.treasury.goods[t]?.[g]);
        if (q > bq) {
          bq = q;
          best = [t, g];
        }
      }
    return best;
  }
  let touched = false;

  return {
    el,
    update(s) {
      last = s;
      from.setOptions(townOptions(s));
      to.setOptions(townOptions(s));
      if (!touched) {
        touched = true;
        const b = largestHolding(s);
        if (b) {
          from.set(b[0]);
          good.set(b[1]);
        }
      }
      if (to.value === from.value && s.towns.length > 1) to.set((from.value + 1) % s.towns.length);
      paint();
    },
    seed(s, town, g) {
      last = s;
      touched = true;
      from.setOptions(townOptions(s));
      to.setOptions(townOptions(s));
      from.set(town);
      good.set(g);
      if (to.value === town && s.towns.length > 1) to.set((town + 1) % s.towns.length);
      paint();
    },
    focus: () => to.el.querySelector('select')?.focus(),
    reset() {
      touched = false;
      last = null;
      msg.clear();
    },
  };
}
