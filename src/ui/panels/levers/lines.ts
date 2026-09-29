// ============================================================================
// Levers panel — Treasury freight lines: one card per line, used in
// Build (under the composer), Trade → Treasury stores & wagons, Ledger →
// Treasury and In force.
//
//   head   on/off (pause) · A ⇄ B · status · show on map · close
//   terms  wagons · fare rule · drivers · the trading houses' own freight
//   strip  wagons out · carried today · carried in all · fare today
//   money  fares in · drivers · fuel & wear · result (lifetime; + = into the Purse)
//   chips  fare: free / at cost / fixed · wagons −1 / +1
//
// Keyed by line id and updated in place (4×/s safe). Money moves only through
// the sim (updateLine / closeLine via run()).
// ============================================================================
import { freightPerUnit } from '../../../sim/agents/traders';
import { costPerUnit, lineResult, wagonsOut } from '../../../sim/policy/lines';
import { describeLine } from '../../../sim/policy/player';
import type { FreightLine, SimState } from '../../../sim/types';
import { h, setText, setTone, show, toggleClass } from '../../dom';
import { fmtNum, fmtPrice, plural } from '../../format';
import { centerMap } from '../../uiState';
import { attachTip, icon, tipNote, tipTitle, toggle } from '../../widgets';
import { chip, fin, flowTone, fmtM, fmtMS, fmtQ, keyedList, run, safe, signedMoney, tersely, townName, TONES } from './common';

/** The Treasury's freight lines (empty for saves from before them). */
export function freightLines(s: SimState): FreightLine[] {
  return s.policy.lines ?? [];
}

function statEl(label: string): { el: HTMLElement; v: HTMLElement } {
  const v = h('span', { class: 'lv-stat-v' });
  return { el: h('span', { class: 'lv-stat' }, h('span', { class: 'lv-stat-l' }, label), v), v };
}

/** Tight money for small cells: "¤1.7k", "¤211", "¤9.50". */
function tight(v: number): string {
  const a = Math.abs(v);
  return a >= 1000 ? fmtMS(a) : a >= 100 ? '¤' + Math.round(a) : fmtM(a);
}

function money(el: HTMLElement, x: number, signed = false): void {
  const v = fin(x);
  const t = signed ? (Math.abs(v) < 0.005 ? fmtM(0) : (v > 0 ? '+' : '−') + tight(v)) : tight(v);
  setText(el, t);
  el.title = signed ? signedMoney(v) : fmtM(v);
}

/** The fare rule in a few words: "free", "¤0.40 a unit", "at cost ≈ ¤0.21". */
export function fareWords(L: Pick<FreightLine, 'fare' | 'farePrice' | 'fareToday'>): string {
  if (L.fare === 'free') return 'free';
  if (L.fare === 'fixed') return `${fmtPrice(L.farePrice)} a unit`;
  return `at cost ≈ ${fmtPrice(L.fareToday)}`;
}

/** Status chip text and tone. */
function lineStatus(s: SimState, L: FreightLine): [string, (typeof TONES)[number] | null, string] {
  const out = wagonsOut(s, L);
  if (!L.enabled) return ['Paused', 'warn', 'It takes no loads; wagons on the road finish their trips.'];
  if (!s.treasury.autoMint && !(fin(s.treasury.purse) > 0)) return ['Purse empty', 'bad', 'It cannot buy wagons or fuel, or pay its drivers, until money comes in.'];
  if (!(L.wagons > 0)) return ['Buying wagons', 'gold', `Its wagons are bought as tools in ${townName(s, L.a)}.`];
  if (!(L.crew > 0) && out === 0) return ['Hiring drivers', 'warn', `Its drivers are Treasury workers of ${townName(s, L.a)}; they are taken on as people apply.`];
  if (!(L.oil > 0) && out === 0) return ['Buying fuel', 'warn', `Its oil is bought in ${townName(s, L.a)}.`];
  if (fin(L.carriedToday) > 0.5 || out > 0) return ['Running', 'gold', ''];
  return ['Waiting for loads', null, 'No trading house found it cheaper than its own wagons today.'];
}

interface Card {
  el: HTMLElement;
  sw: ReturnType<typeof toggle>;
  path: HTMLElement;
  status: HTMLElement;
  terms: HTMLElement;
  cells: { v: HTMLElement; sub: HTMLElement; el: HTMLElement }[];
  fares: ReturnType<typeof statEl>;
  drivers: ReturnType<typeof statEl>;
  running: ReturnType<typeof statEl>;
  result: ReturnType<typeof statEl>;
  fareBtns: HTMLButtonElement[];
  less: HTMLButtonElement;
}

function card(L: FreightLine, state: () => SimState | null, compact: boolean): Card {
  const id = L.id;
  const cur = () => {
    const s = state();
    return s ? (freightLines(s).find((x) => x.id === id) ?? null) : null;
  };
  const sw = toggle({ value: L.enabled, title: 'Pause or resume the line (paused: it takes no loads)', onChange: (v) => run({ type: 'updateLine', id, patch: { enabled: v } }, null) });
  const path = h('span', { class: 'lv-rt-path lv-ln-path' });
  const status = h('span', { class: 'chip lv-rt-status' });
  const terms = h('div', { class: 'lv-rt-terms' });
  const cell = (label: string) => {
    const v = h('span', { class: 'lv-pipe-v' });
    const sub = h('span', { class: 'lv-pipe-s' });
    return { el: h('div', { class: 'lv-pipe-c' }, h('span', { class: 'lv-pipe-l' }, label), v, compact ? null : sub), v, sub };
  };
  const cells = [cell('Out'), cell('Today'), cell('In all'), cell('Fare')];
  cells[0].el.title = 'Wagons on the road / wagons the line has';
  cells[1].el.title = 'Units loaded onto the line today (both ways)';
  cells[2].el.title = 'Units carried since the line opened';
  cells[3].el.title = 'What a trading house pays today per unit carried';
  const strip = h('div', { class: 'lv-pipe lv-ln-strip' + (compact ? ' compact' : '') }, cells.map((c) => c.el));
  const fares = statEl('Fares in');
  const drivers = statEl('Drivers');
  const running = statEl('Fuel & wear');
  const result = statEl('Result');
  attachTip(result.el, () => {
    const x = cur();
    if (!x) return null;
    const r = lineResult(x);
    return [
      tipTitle('Result so far', 'fares − drivers − fuel − wear'),
      tipNote(
        `Fares ${fmtM(x.fares)} − drivers ${fmtM(x.wages)} − fuel ${fmtM(x.fuelCost)} − wear ${fmtM(x.wear)} = ${signedMoney(r.result)}. ` +
          `A negative result is what the Purse pays for the service. The wagons themselves (${fmtM(x.toolsSpent)} of tools bought) stay the Treasury's: closing the line hands them to its stores.`,
      ),
    ];
  });
  attachTip(drivers.el, () => {
    const x = cur();
    return x ? [tipTitle('Drivers', 'Treasury workers'), tipNote(`Paid from the Purse with the rest of the Treasury's crew in ${townName(state()!, x.a)}: ${fmtM(x.wages)} so far.`)] : null;
  });
  const showBtn = h('button', { class: 'icon-btn lv-ibtn', type: 'button', title: 'Show the line on the map', 'aria-label': 'Show on map' }, icon('target', 15));
  showBtn.addEventListener('click', () => {
    const s = state();
    const x = cur();
    if (!s || !x) return;
    const A = s.towns[x.a];
    const B = s.towns[x.b];
    if (A && B) centerMap((A.x + B.x) / 2, (A.y + B.y) / 2);
  });
  const rm = h(
    'button',
    { class: 'icon-btn lv-ibtn', type: 'button', title: 'Close this line: its wagons (tools) and fuel go to the Treasury’s stores in its depot town', 'aria-label': 'Close line', onClick: () => run({ type: 'closeLine', id }, null) },
    icon('trash', 15),
  );
  const fareBtn = (label: string, title: string, patch: { fare: 'free' | 'cost' | 'fixed'; farePrice?: number }) => {
    const b = chip(label, () => run({ type: 'updateLine', id, patch }, null), title);
    b.classList.add('chip');
    return b;
  };
  const fareBtns = [
    fareBtn('free', 'Carry the trading houses’ goods for nothing: the Purse pays all its running costs', { fare: 'free' }),
    fareBtn('at cost', 'Charge what the line’s recent trips cost per unit carried', { fare: 'cost' }),
  ];
  const less = chip('−1 wagon', () => {
    const x = cur();
    if (x && x.wagonsWanted > 1) run({ type: 'updateLine', id, patch: { wagons: x.wagonsWanted - 1 } }, null);
  }, 'Keep one wagon fewer (its tools go to the Treasury’s stores)');
  const more = chip('+1 wagon', () => {
    const x = cur();
    if (x) run({ type: 'updateLine', id, patch: { wagons: x.wagonsWanted + 1 } }, null);
  }, 'Keep one wagon more (bought as tools in the depot town)');
  for (const b of [less, more]) b.classList.add('chip');
  const controls = h('div', { class: 'lv-if-opts lv-ln-ctl' }, h('span', { class: 'lv-if-opts-k' }, 'Fare:'), ...fareBtns, h('span', { class: 'lv-ln-gap' }), less, more);
  const el = h(
    'div',
    { class: 'lv-rt lv-ln', dataset: { line: String(id) } },
    h('div', { class: 'lv-rt-head' }, h('span', { class: 'lv-if-sw' }, sw.el), h('span', { class: 'lv-dir gold lv-ln-tag' }, 'Line'), path, h('span', { class: 'spacer' }), showBtn, rm),
    h('div', { class: 'lv-rt-sub' }, status, terms),
    strip,
    h('div', { class: 'lv-rt-money' }, fares.el, drivers.el, running.el, result.el),
    compact ? null : controls,
  );
  return { el, sw, path, status, terms, cells, fares, drivers, running, result, fareBtns, less };
}

function paint(s: SimState, v: Card, L: FreightLine): void {
  v.sw.set(L.enabled);
  toggleClass(v.el, 'off', !L.enabled);
  setText(v.path, `${townName(s, L.a)} ⇄ ${townName(s, L.b)}`);
  v.path.title = tersely(safe(() => describeLine(s, L), L.label));
  const [st, tone, why] = lineStatus(s, L);
  setText(v.status, st);
  setTone(v.status, TONES, tone);
  v.status.title = why;
  const ownAB = safe(() => freightPerUnit(s, L.a, L.b), -1);
  const ownBA = safe(() => freightPerUnit(s, L.b, L.a), -1);
  const lo = Math.min(ownAB, ownBA);
  const hi = Math.max(ownAB, ownBA);
  const own = ownAB >= 0 && ownBA >= 0 ? (fmtPrice(lo) === fmtPrice(hi) ? fmtPrice(lo) : `${fmtPrice(lo)}–${fmtPrice(hi)}`) : '—';
  setText(
    v.terms,
    `${plural(L.wagonsWanted, 'wagon')}${L.wagons !== L.wagonsWanted ? ` (${fmtNum(L.wagons)} so far)` : ''} kept in ${townName(s, L.a)} · fare ${fareWords(L)} · ${plural(L.crew, 'driver')} at ${fmtPrice(L.wage)} a day · trading houses’ own wagons ${own} a unit`,
  );
  v.terms.title = 'The trading houses’ own freight is a full wagon’s trip cost per unit (a part-full wagon costs them more a unit).';
  const out = wagonsOut(s, L);
  const [cOut, cToday, cAll, cFare] = v.cells;
  setText(cOut.v, `${fmtNum(out)} / ${fmtNum(L.wagons)}`);
  setText(cOut.sub, `${plural(L.crew, 'driver')}`);
  cOut.el.title = `${fmtNum(out)} of its ${plural(L.wagons, 'wagon')} on the road; ${plural(L.crew, 'driver')} (Treasury workers of ${townName(s, L.a)})`;
  toggleClass(cOut.el, 'on', out > 0);
  setText(cToday.v, fmtQ(fin(L.carriedToday)));
  setText(cToday.sub, L.legsToday > 0 ? plural(L.legsToday, 'load') : 'no loads');
  toggleClass(cToday.el, 'on', fin(L.carriedToday) > 0.5);
  setText(cAll.v, fmtQ(fin(L.carried)));
  setText(cAll.sub, plural(L.legs, 'load'));
  toggleClass(cAll.el, 'on', fin(L.carried) > 0.5);
  setText(cFare.v, fmtPrice(fin(L.fareToday)));
  setText(cFare.sub, L.fare === 'free' ? 'free' : L.fare === 'cost' ? `cost ${fmtPrice(safe(() => costPerUnit(s, L), 0))}` : 'fixed');
  toggleClass(cFare.el, 'on', true);
  const r = lineResult(L);
  money(v.fares.v, L.fares);
  money(v.drivers.v, -L.wages, true);
  money(v.running.v, -(L.fuelCost + L.wear), true);
  money(v.result.v, r.result, true);
  setTone(v.result.v, TONES, flowTone(r.result));
  v.fareBtns[0].classList.toggle('on', L.fare === 'free');
  v.fareBtns[1].classList.toggle('on', L.fare === 'cost');
  v.less.disabled = L.wagonsWanted <= 1;
}

export interface LineList {
  el: HTMLElement;
  /** Refresh; returns the number of lines. */
  update(s: SimState): number;
}

/** Every freight line as a card (an empty-state note when there are none, unless `quiet`). */
export function lineList(opts: { compact?: boolean; empty?: string } = {}): LineList {
  let state: SimState | null = null;
  const list = h('div', { class: 'lv-rts lv-lns' });
  const empty = h('div', { class: 'lv-empty-sm' }, opts.empty ?? '');
  const rec = keyedList<FreightLine, Card>(list, (L) => L.id, (L) => card(L, () => state, !!opts.compact), (v, L) => state && paint(state, v, L));
  const el = h('div', { class: 'lv-ln-list' }, list, opts.empty ? empty : null);
  return {
    el,
    update(s) {
      state = s;
      const ls = freightLines(s);
      rec(ls);
      show(list, ls.length > 0);
      show(empty, ls.length === 0 && !!opts.empty);
      return ls.length;
    },
  };
}
