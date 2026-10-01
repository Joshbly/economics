// ============================================================================
// Levers panel — Trade → Carry: move the Treasury's own goods between its stores
// (dispatches `carry`; the rule's daily running lives in sim/policy/carry.ts).
//
//   Goods [good]
//   the good, town by town (../markets/bytown.ts): made, used, net, in, out, its
//     market's 14-day balance, what the Treasury holds — each row a "from" toggle
//     (several: each load draws on them equally) and a "to" choice
//   To [a town picked above | where it runs short]
//   Amount [Everything | What it needs | Up to n a day] · Wagons [Full | Right away]
//   Duration [Once | N days | Until removed]
//
// A carry neither buys nor sells: a buy order fills a store, a sell order empties
// one. So a supply line is buy · carry · sell, each its own row in In force; the
// form ends with "Buy in A…" and "Sell in B…", which open the Goods form there.
// ============================================================================
import { CARRY_FULL_SHARE, PLAYER_MAX_QTY, TREASURY_FREIGHT_PREMIUM, WAGON_CAPACITY } from '../../../sim/config';
import { carryHoldDays, destNeed, shortTargets } from '../../../sim/policy/carry';
import { lineBetween } from '../../../sim/policy/lines';
import { freightPerUnit } from '../../../sim/agents/traders';
import { G, N_GOODS } from '../../../sim/goods';
import { routeBetweenTowns } from '../../../sim/world/paths';
import type { SimState } from '../../../sim/types';
import { h, setText, show, toggleClass } from '../../dom';
import { fmtNum, fmtPct, plural } from '../../format';
import { goodOptions, numberInput, segmented, selectInput } from '../../widgets';
import { byTownTable } from '../markets/bytown';
import { chip, fin, fmtM, fmtQ, formEl, formFoot, goodName, hint, msgLine, row, run, safe, setNumUnit, submitButton, townName, unitsOf } from './common';

type Amount = 'all' | 'need' | 'some';
type Dur = 'once' | 'days' | 'standing';

export interface CarryForm {
  el: HTMLElement;
  update(s: SimState): void;
  /** Start from a store: the town (and good) the player was looking at. */
  seed(s: SimState, town: number, good: number): void;
  focus(): void;
  reset(): void;
}

export function carryForm(opts: {
  sellThere: (town: number, good: number, perDay: number) => void;
  buyThere: (town: number, good: number) => void;
}): CarryForm {
  let last: SimState | null = null;
  let amount: Amount = 'all';
  let wagons: 'full' | 'now' = 'full';
  let dur: Dur = 'standing';
  let sources: number[] = [0]; // the stores to carry from (the first is the rule's `from`)
  let dest = 1; // the town to carry to, −1: where it runs short
  let lastTown = 1; // the last town picked as the destination (to come back to from "where short")
  const msg = msgLine();
  const edited = () => {
    msg.clear();
    paint();
  };

  const good = selectInput<number>({ options: goodOptions(), value: G.bread, onChange: () => edited() });
  const heldHint = hint();
  const table = byTownTable({
    pick: {
      isFrom: (t) => sources.includes(t),
      isTo: (t) => dest === t,
      onFrom: (t) => {
        if (sources.includes(t)) {
          if (sources.length > 1) sources = sources.filter((x) => x !== t);
        } else {
          sources = [...sources, t];
          if (dest === t) dest = -1;
        }
        edited();
      },
      onTo: (t) => {
        dest = t;
        lastTown = t;
        if (sources.includes(t)) sources = sources.length > 1 ? sources.filter((x) => x !== t) : sources;
        edited();
      },
    },
  });
  const tableNote = h('div', { class: 'lv-hint bt-note' });
  const routeText = h('span', { class: 'lv-static' });
  const shortChip = chip('Where it runs short', () => {
    if (dest >= 0) dest = -1;
    else if (last) {
      // back to one town: the last one picked, or the first that is not a store
      const nT = last.towns.length;
      const free = [lastTown, ...Array.from({ length: nT }, (_, i) => i)].find((t) => t >= 0 && t < nT && !sources.includes(t));
      dest = free ?? -1;
    }
    edited();
  }, 'Instead of one town: each load to whichever town, of those where you sell it, needs it most');
  const amountSeg = segmented<Amount>({
    options: [
      { value: 'all', label: 'Everything', title: 'All the Treasury holds of it there — and, for a standing rule, whatever comes in' },
      { value: 'need', label: 'What it needs', title: 'Only what the destination needs: its shortage over the last 14 days plus what you sell there a day, for the days a load takes, less what you hold there or have on the road' },
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
  const buyChip = chip('Buy there…', () => last && opts.buyThere(sources[0], good.value), 'Open the Goods form on the market of the first store, to buy what it should carry');
  const sellChip = chip('Sell there…', () => last && dest >= 0 && opts.sellThere(dest, good.value, arriving(last)), 'Open the Goods form on the market at the destination, to offer what arrives');
  const btn = submitButton('Carry');
  const form = formEl(
    () => submit(),
    row('Goods', good.el, heldHint),
    h('div', { class: 'lv-row lv-row-full' }, table.el),
    tableNote,
    row('Route', routeText, shortChip),
    row('Amount', amountSeg.el, qty.el),
    wagonRow,
    row('Duration', durSeg.el, days.el),
    formFoot(preview, msg, buyChip, sellChip, btn),
  );
  const el = h('div', { class: 'lv-carry' }, form);

  /** About how much a day this carry brings (its daily amount, or what the Treasury's orders buy at its stores a day): the sell order's default. */
  function arriving(s: SimState): number {
    if (amount === 'some' && qty.value > 0) return qty.value;
    let n = 0;
    for (const o of s.policy.orders)
      if (o.enabled && o.side === 'buy' && o.market.kind === 'good' && sources.includes(o.market.town) && o.market.good === good.value) n += o.qty;
    return n;
  }

  function names(s: SimState, ts: number[]): string {
    const n = ts.map((t) => townName(s, t));
    return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  }

  function paint(): void {
    const s = last;
    if (!s) return;
    const g = good.value;
    const once = dur === 'once';
    const short = dest < 0;
    const many = sources.length > 1;
    // amounts that fit the route: "what it needs" is built into "where it runs short"
    if (short && amount === 'need') amount = 'all';
    if (once && amount === 'need') amount = 'all';
    amountSeg.set(amount);
    const needBtn = amountSeg.el.querySelectorAll('button')[1] as HTMLButtonElement | undefined;
    if (needBtn) show(needBtn, !short && !once);
    table.update(s, g);
    const have = sources.reduce((x, t) => x + fin(s.treasury.goods[t]?.[g]), 0);
    setText(heldHint, `You hold ${fmtQ(have)} ${unitsOf(g)} in ${names(s, sources)}`);
    setText(
      tableNote,
      `A day, last 14 days. Made − used = net: + the town makes more than it uses and sends the rest out, − it brings the rest in. Pick "from" in one or more towns (each load draws on them equally) and "to" in one.`,
    );
    setText(routeText, `${names(s, sources)}${many ? ' (equally)' : ''} → ${short ? 'where it runs short' : townName(s, dest)}`);
    toggleClass(shortChip, 'on', short);
    show(qty.el, amount === 'some');
    setNumUnit(qty, once ? unitsOf(g) : `${unitsOf(g)}/day`);
    show(wagonRow, !once);
    show(days.el, dur === 'days');
    setText(buyChip, `Buy in ${townName(s, sources[0])}…`);
    show(sellChip, !short);
    setText(sellChip, `Sell in ${short ? '…' : townName(s, dest)}…`);
    setText(wagonHint, wagons === 'full' ? `Leaves ${fmtPct(CARRY_FULL_SHARE)} full, or after ${plural(carryHoldDays(g), 'day')} of waiting.` : 'Leaves after every market session.');
    const B_ = (x: string) => h('b', null, x);
    const fail = (why: string) => {
      preview.replaceChildren(why);
      btn.disabled = true;
    };
    if (!short && sources.includes(dest)) return fail('Choose a destination other than the stores it carries from.');
    if (amount === 'some' && !(qty.value > 0)) return fail('Set an amount.');
    if (once && (short || many)) return fail('Once, now carries from one town to one town: pick a single "from" and a "to", or make this a standing rule.');
    const gn = goodName(g).toLowerCase();
    if (short) {
      const served = safe(() => shortTargets(s, { from: sources[0], good: g, sources }), []);
      const bits: (string | Node)[] = [
        amount === 'all' ? `Carries the ${gn} held in ${names(s, sources)}` : `Carries up to ${fmtQ(qty.value)} ${unitsOf(g)} a day`,
        ' to wherever it runs short: each load goes to the town, of those where you sell ',
        gn,
        ', that needs it most — its shortage over the last 14 days plus what you sell there a day, less what you hold there or have on the road. ',
      ];
      if (served.length)
        bits.push(B_('Serves '), served.map((x) => `${townName(s, x.town)} (${x.need > 0.5 ? `needs ${fmtQ(x.need)}` : 'supplied'})`).join(', '), '. ', h('span', { class: 'faint' }, 'A sell order in another town adds it.'));
      else bits.push(h('span', { class: 'warn' }, `You sell ${gn} in no other town yet: place a sell order (Goods) in each town it should serve.`));
      preview.replaceChildren(...bits);
      btn.disabled = dur === 'days' && !(days.value > 0);
      setText(btn, 'Carry');
      return;
    }
    const reach = sources.filter((f) => safe(() => freightPerUnit(s, f, dest), -1) >= 0);
    if (!reach.length) return fail(`No wagon road links ${names(s, sources)} and ${townName(s, dest)}.`);
    if (once && !(have > 0.005)) return fail(`The Treasury holds no ${gn} in ${townName(s, sources[0])}. Buy some there first (Buy in ${townName(s, sources[0])}…), or make this a standing rule that carries it as it comes in.`);
    const fpu = safe(() => freightPerUnit(s, reach[0], dest), 0);
    const perWagon = fpu * WAGON_CAPACITY * (1 + TREASURY_FREIGHT_PREMIUM);
    const dd = safe(() => routeBetweenTowns(s, reach[0], dest).days, NaN);
    const line = safe(() => lineBetween(s, reach[0], dest), undefined);
    const bits: (string | Node)[] = [];
    if (once) {
      const q = amount === 'all' ? have : Math.min(qty.value, have);
      const n = Math.max(1, Math.ceil(q / WAGON_CAPACITY - 1e-9));
      bits.push('Sends ', B_(`${fmtQ(q)} ${unitsOf(g)}`), ' now: freight ≈ ', B_(fmtM(perWagon * n)), ` for ${plural(n, 'wagon')}`);
    } else {
      if (amount === 'need') {
        const x = safe(() => destNeed(s, sources, dest, g), null);
        bits.push(`Carries what ${townName(s, dest)} needs`);
        if (x) bits.push(' — ', x.need > 0.5 ? B_(`${fmtQ(x.need)} ${unitsOf(g)} now`) : 'nothing now', ` (short ${fmtQ(x.shortage)} a day there, you sell ${fmtQ(x.sold)} a day there, hold ${fmtQ(x.held)}, ${fmtQ(x.onRoad)} on the road)`);
      } else bits.push(amount === 'all' ? `Carries all the ${gn} held in ${names(s, sources)}, as it comes in` : `Carries up to ${fmtQ(qty.value)} ${unitsOf(g)} a day`);
      if (many) bits.push(', drawing on each store equally');
      bits.push(' · freight ≈ ', B_(fmtM(perWagon)), ' a wagon', wagons === 'full' ? ` (${fmtM(perWagon / WAGON_CAPACITY)} a unit when full)` : ', however little it carries');
    }
    if (Number.isFinite(dd) && dd > 0) bits.push(` · about ${fmtNum(Math.max(0.5, dd), 1)} days on the road`);
    bits.push('. ');
    if (line) bits.push('Your freight line on this road takes it for nothing when it has room. ');
    bits.push(h('span', { class: 'faint' }, `It lands in the Treasury’s store in ${townName(s, dest)}; a sell order there offers it.`));
    preview.replaceChildren(...bits);
    btn.disabled = dur === 'days' && !(days.value > 0);
    setText(btn, once ? 'Send now' : 'Carry');
  }

  function submit(): void {
    const s = last;
    if (!s) return;
    const q = amount === 'some' ? qty.value : -1;
    if (amount === 'some' && !(q > 0)) return msg.err(qty.error ?? 'Set an amount.');
    run(
      {
        type: 'carry',
        from: sources[0],
        to: dest,
        good: good.value,
        qty: q,
        sources: sources.length > 1 ? sources.slice() : undefined,
        need: amount === 'need' && dest >= 0 ? true : undefined,
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
  const clampTowns = (s: SimState) => {
    const nT = s.towns.length;
    sources = sources.filter((t) => t >= 0 && t < nT);
    if (!sources.length) sources = [0];
    if (dest >= nT) dest = -1;
    if (dest >= 0 && sources.includes(dest)) dest = nT > 1 ? (sources[0] + 1) % nT : -1;
  };

  return {
    el,
    update(s) {
      last = s;
      if (!touched) {
        touched = true;
        const b = largestHolding(s);
        if (b) {
          sources = [b[0]];
          good.set(b[1]);
          dest = lastTown = s.towns.length > 1 ? (b[0] + 1) % s.towns.length : -1;
        }
      }
      clampTowns(s);
      paint();
    },
    seed(s, town, g) {
      last = s;
      touched = true;
      sources = [town];
      good.set(g);
      if (dest === town || dest >= s.towns.length) dest = lastTown = s.towns.length > 1 ? (town + 1) % s.towns.length : -1;
      clampTowns(s);
      paint();
    },
    focus: () => good.el.querySelector('select')?.focus(),
    reset() {
      touched = false;
      last = null;
      msg.clear();
    },
  };
}
