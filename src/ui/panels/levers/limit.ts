// ============================================================================
// Lever IV — Limit: legal bounds on prices (and on how far a price may move in
// a day), wages, rents, the Bank's loan rate and balance sheet, and on how much
// may cross the port or travel between towns. Each kind shows today's actual
// value for reference and whether the bound would bite at once — town by town
// when a price limit covers every town; the rule is previewed in the sim's own
// words.
// ============================================================================
import { BANK_MIN_CAPITAL, BANK_OWN_MIN_CAPITAL, LIMIT_MOVE_MAX, PLAYER_MAX_PRICE, PLAYER_MAX_QTY, PLAYER_MAX_RATE } from '../../../sim/config';
import { minCapital } from '../../../sim/agents/bank';
import { G, GOODS, N_GOODS, TRADABLE_GOODS } from '../../../sim/goods';
import { describeLimit } from '../../../sim/policy/player';
import { GOLD_GOOD, IOU_GOOD, STATE, type Limit, type LimitKind, type MarketState, type SimState } from '../../../sim/types';
import { h, setText, show } from '../../dom';
import { fmtPct, fmtPrice, plural } from '../../format';
import type { PrefillRequest } from '../../uiState';
import { goodOptions, numberInput, segmented, selectInput, tailMean, townOptions, type Option } from '../../widgets';
import { chip, dynRow, fin, fmtQ, formEl, formFoot, hint, msgLine, niceRound, polishRule, row, run, safe, submitButton, unitOf, unitsOf, type Lever } from './common';

interface KindDef {
  kind: LimitKind;
  label: string;
  family: string;
  /** 'every': −1 means every good (a limit on how prices move). */
  good: 'none' | 'required' | 'every' | 'any' | 'tradable';
  /** The national IOU and gold markets may be chosen in place of a good. */
  instruments?: boolean;
  town: 'none' | 'any';
  toTown: boolean;
  value: 'money' | 'pct' | 'qty';
  /** Direction of the bound: 'max' binds when the actual is above it. */
  bound: 'max' | 'min';
}

const KINDS: KindDef[] = [
  { kind: 'priceMax', label: 'Price of a good — at most', family: 'Prices', good: 'required', instruments: true, town: 'any', toTown: false, value: 'money', bound: 'max' },
  { kind: 'priceMin', label: 'Price of a good — at least', family: 'Prices', good: 'required', instruments: true, town: 'any', toTown: false, value: 'money', bound: 'min' },
  { kind: 'priceMove', label: 'Price of a good — daily move at most', family: 'Prices', good: 'every', instruments: true, town: 'any', toTown: false, value: 'pct', bound: 'max' },
  { kind: 'wageMin', label: 'Daily wage — at least', family: 'Wages & rents', good: 'none', town: 'any', toTown: false, value: 'money', bound: 'min' },
  { kind: 'wageMax', label: 'Daily wage — at most', family: 'Wages & rents', good: 'none', town: 'any', toTown: false, value: 'money', bound: 'max' },
  { kind: 'rentMax', label: 'Rent — at most', family: 'Wages & rents', good: 'none', town: 'any', toTown: false, value: 'money', bound: 'max' },
  { kind: 'rentMin', label: 'Rent — at least', family: 'Wages & rents', good: 'none', town: 'any', toTown: false, value: 'money', bound: 'min' },
  { kind: 'rateMax', label: 'Bank loan rate — at most', family: 'The Bank', good: 'none', town: 'none', toTown: false, value: 'pct', bound: 'max' },
  { kind: 'rateMin', label: 'Bank loan rate — at least', family: 'The Bank', good: 'none', town: 'none', toTown: false, value: 'pct', bound: 'min' },
  { kind: 'reserveMin', label: 'Bank reserves — at least', family: 'The Bank', good: 'none', town: 'none', toTown: false, value: 'pct', bound: 'min' },
  { kind: 'capitalMin', label: 'Bank capital — at least', family: 'The Bank', good: 'none', town: 'none', toTown: false, value: 'pct', bound: 'min' },
  { kind: 'importMax', label: 'Imports — at most', family: 'Movement of goods', good: 'tradable', town: 'none', toTown: false, value: 'qty', bound: 'max' },
  { kind: 'exportMax', label: 'Exports — at most', family: 'Movement of goods', good: 'tradable', town: 'none', toTown: false, value: 'qty', bound: 'max' },
  { kind: 'shipMax', label: 'Wagon shipments — at most', family: 'Movement of goods', good: 'any', town: 'any', toTown: true, value: 'qty', bound: 'max' },
];

const kindDef = (k: LimitKind): KindDef => KINDS.find((x) => x.kind === k) ?? KINDS[0];
const isPriceKind = (k: LimitKind): boolean => k === 'priceMax' || k === 'priceMin' || k === 'priceMove';
const isInstrument = (g: number): boolean => g === IOU_GOOD || g === GOLD_GOOD;
/** Days of price history the move limit is judged against. */
const MOVE_DAYS = 30;
/** Quick values for a limit on daily moves. */
const MOVE_CHIPS: [string, number, string][] = [
  ['Hold', 0, '0% — the price may not move at all: every change in demand or supply becomes a shortage or unsold goods'],
  ['1%', 0.01, 'At most 1% a day'],
  ['2%', 0.02, 'At most 2% a day'],
  ['5%', 0.05, 'At most 5% a day'],
  ['10%', 0.1, 'At most 10% a day'],
];
/** Quick values for the Bank's capital rule (the standing rule and the Bank's own floor among them). */
const CAPITAL_CHIPS: number[] = [BANK_OWN_MIN_CAPITAL, 0.04, 0.06, BANK_MIN_CAPITAL, 0.12];

const INSTRUMENT_OPTIONS: Option<number>[] = [
  { value: IOU_GOOD, label: 'IOUs', group: 'National markets' },
  { value: GOLD_GOOD, label: 'Gold (per oz)', group: 'National markets' },
];

/** 0.08 → "8%", 0.025 → "2.5%" (no trailing ".0"). */
function tidyPct(x: number): string {
  return fmtPct(x, 1).replace(/\.0%$/, '%');
}

function instrumentName(g: number): string {
  return g === IOU_GOOD ? 'IOUs' : 'Gold';
}

function marketFor(s: SimState, town: number, g: number): MarketState | undefined {
  if (g === IOU_GOOD) return s.iouMarket;
  if (g === GOLD_GOOD) return s.goldMarket;
  return town >= 0 && g >= 0 && g < N_GOODS ? s.markets[town * N_GOODS + g] : undefined;
}

function priceOf(m: MarketState | undefined): number {
  return fin(m && m.price > 0 ? m.price : m?.ema, NaN);
}

/** Absolute daily price moves (fractions) over the last `n` days of a market's history. */
function dailyMoves(m: MarketState | undefined, n: number): number[] {
  const out: number[] = [];
  const hs = m?.hist;
  if (!hs || hs.length < 2) return out;
  for (let i = Math.max(1, hs.length - n); i < hs.length; i++) {
    const a = hs[i - 1];
    const b = hs[i];
    if (a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b)) out.push(Math.abs(b / a - 1));
  }
  return out;
}

/** One market's standing against a draft price limit (the per-town table). */
interface TownRow {
  name: string;
  price: number;
  /** priceMove: the largest daily move and the days it would have bound. */
  largest: number;
  days: number;
  binds: boolean;
  status: string;
}

export function limitLever(): Lever {
  let kind: LimitKind = 'priceMax';
  let good = G.bread as number;
  let town = -1;
  let toTown = -1;
  let ends: 'never' | 'after' = 'never';
  let valueFor = '';
  let last: SimState | null = null;
  const msg = msgLine();
  const changed = () => {
    msg.clear();
    paint();
  };

  const kindSel = selectInput<LimitKind>({
    options: KINDS.map((k) => ({ value: k.kind, label: k.label, group: k.family })),
    value: kind,
    onChange: (v) => {
      kind = v;
      const d = kindDef(v);
      if (d.good === 'required' && good < 0) good = G.bread;
      if (!d.instruments && isInstrument(good)) good = d.good === 'required' ? G.bread : -1;
      if (d.good === 'tradable' && good >= 0 && !GOODS[good].tradable) good = -1;
      syncSelects();
      changed();
    },
  });
  const goodSel = selectInput<number>({ options: goodOptions(), value: good, onChange: (v) => ((good = v), changed()) });
  const townSel = selectInput<number>({ options: [{ value: -1, label: 'All towns' }], value: town, onChange: (v) => ((town = v), changed()) });
  const toSel = selectInput<number>({ options: [{ value: -1, label: 'Any town' }], value: toTown, onChange: (v) => ((toTown = v), changed()) });
  const goodRow = dynRow('Good', goodSel.el);
  const townRow = dynRow('Town', townSel.el);
  const toRow = dynRow('To', toSel.el);

  const valMoney = numberInput({ value: NaN, prefix: '¤', min: 0, max: PLAYER_MAX_PRICE, width: '130px', onChange: changed });
  const valPct = numberInput({ value: 0.1, percent: true, min: 0, max: PLAYER_MAX_RATE, width: '118px', onChange: changed });
  const valQty = numberInput({ value: 0, min: 0, max: PLAYER_MAX_QTY, unit: 'a day', width: '130px', onChange: changed });
  const chipsBox = h('div', { class: 'lv-chips' });
  const refHint = hint();
  const ruleHint = hint();
  const valueRow = dynRow('Bound', valMoney.el, valPct.el, valQty.el, chipsBox, refHint, ruleHint);
  // every town: each town's price today and whether the draft would bind there
  const townsBox = h('div', { class: 'lv-hold lv-lim-towns', hidden: true });

  const endsSeg = segmented<'never' | 'after'>({ options: [{ value: 'never', label: 'Never' }, { value: 'after', label: 'After' }], value: ends, size: 'sm', onChange: (v) => ((ends = v), changed()) });
  const endDays = numberInput({ value: 90, integer: true, min: 1, max: 36000, unit: 'days', width: '92px', onChange: changed });

  const bite = h('div', { class: 'lv-bite' });
  const decree = h('div', { class: 'lv-decree' });
  const preview = h('div', { class: 'lv-preview' }, bite);
  const enact = submitButton('Enact', 'Put this limit in force (Enter)');
  const form = formEl(
    () => submit(),
    row('Limit on', kindSel.el),
    goodRow.el,
    townRow.el,
    toRow.el,
    valueRow.el,
    townsBox,
    row('Ends', endsSeg.el, endDays.el),
    decree,
    formFoot(preview, msg, enact),
  );
  const body = h('div', { class: 'lv-body-in' }, form);

  let chipSig = '';
  function setChips(d: KindDef): void {
    const sig = d.kind === 'priceMove' || d.kind === 'capitalMin' ? d.kind : d.value;
    if (sig === chipSig) return;
    chipSig = sig;
    if (d.kind === 'priceMove') {
      chipsBox.replaceChildren(...MOVE_CHIPS.map(([lab, v, title]) => chip(lab, () => (valPct.set(v), paint()), title)));
      return;
    }
    if (d.kind === 'capitalMin') {
      chipsBox.replaceChildren(
        ...CAPITAL_CHIPS.map((v) =>
          chip(
            v === BANK_MIN_CAPITAL ? `${tidyPct(v)} · standing` : tidyPct(v),
            () => (valPct.set(v), paint()),
            v === BANK_MIN_CAPITAL ? 'The realm’s standing rule' : v === BANK_OWN_MIN_CAPITAL ? 'The least the Bank keeps of its own accord' : `${fmtPct(v)} of its loans`,
          ),
        ),
      );
      return;
    }
    const mk = (lab: string, k: number | 'zero' | 'now', title: string) =>
      chip(lab, () => {
        if (!last) return;
        const r = reference(last).value;
        if (!Number.isFinite(r) && k !== 'zero') return;
        if (k === 'zero') valQty.set(0);
        else if (k === 'now') {
          if (d.value === 'qty') valQty.set(Math.round(r * 100) / 100);
          else if (d.value === 'pct') valPct.set(Math.round(r * 10000) / 10000);
          else valMoney.set(niceRound(r));
        } else if (d.value === 'pct') valPct.set(Math.max(0, Math.round(r * (1 + k) * 10000) / 10000));
        else if (d.value === 'qty') valQty.set(Math.max(0, Math.round(r * (1 + k))));
        else valMoney.set(niceRound(r * (1 + k)));
        paint();
      }, title);
    if (d.value === 'qty') chipsBox.replaceChildren(mk('None', 'zero', '0 = nothing may pass'), mk('Half', -0.5, 'Half of today’s flow'), mk('Now', 'now', 'Today’s flow'));
    else
      chipsBox.replaceChildren(
        mk('−20%', -0.2, '20% below today’s value'),
        mk('−10%', -0.1, '10% below today’s value'),
        mk('Today', 'now', 'Today’s value (for a price: today’s price; in every town, the realm’s average)'),
        mk('+10%', 0.1, '10% above today’s value'),
        mk('+20%', 0.2, '20% above today’s value'),
      );
  }

  function syncSelects(): void {
    kindSel.set(kind);
    const d = kindDef(kind);
    let opts: Option<number>[];
    if (d.good === 'required') opts = goodOptions();
    else if (d.good === 'every') opts = goodOptions(undefined, 'Every good');
    else if (d.good === 'tradable') opts = goodOptions((g) => g.tradable, 'any good');
    else opts = goodOptions(undefined, 'any good');
    if (d.instruments) opts = opts.concat(INSTRUMENT_OPTIONS);
    goodSel.setOptions(opts, good);
    good = goodSel.value;
  }

  /** The markets a draft price limit covers: the chosen town, or every town (one good), or the national market. */
  function covered(s: SimState): { town: number; name: string; m: MarketState | undefined }[] {
    if (isInstrument(good)) return [{ town: -1, name: instrumentName(good), m: marketFor(s, -1, good) }];
    const towns = town >= 0 ? [town] : s.towns.map((t) => t.id);
    const goods = good >= 0 ? [good] : Array.from({ length: N_GOODS }, (_, g) => g);
    const out: { town: number; name: string; m: MarketState | undefined }[] = [];
    for (const t of towns) for (const g of goods) out.push({ town: t, name: s.towns[t]?.name ?? '', m: marketFor(s, t, g) });
    return out;
  }

  /** Today's actual value for the draft's kind/good/town. */
  function reference(s: SimState): { value: number; label: string } {
    const L = s.stats?.latest ?? {};
    const tn = town >= 0 ? s.towns[town] : undefined;
    switch (kind) {
      case 'priceMax':
      case 'priceMin': {
        if (isInstrument(good)) return { value: priceOf(marketFor(s, -1, good)), label: `${good === IOU_GOOD ? 'IOU price' : 'Gold price'} today` };
        if (good < 0) return { value: NaN, label: '' };
        if (town >= 0) return { value: priceOf(marketFor(s, town, good)), label: `${GOODS[good].name} in ${tn?.name ?? ''} today` };
        return { value: fin(L['price_' + good], NaN), label: `${GOODS[good].name}, the realm’s average today` };
      }
      case 'priceMove': {
        let big = NaN;
        for (const c of covered(s)) for (const x of dailyMoves(c.m, MOVE_DAYS)) if (!(x <= big)) big = x;
        return { value: big, label: `Largest daily move in the last ${MOVE_DAYS} days` };
      }
      case 'wageMin':
      case 'wageMax':
        return { value: fin(tn ? tn.avgWage : L.wage), label: `Average wage${tn ? ' in ' + tn.name : ''} now` };
      case 'rentMax':
      case 'rentMin':
        return { value: fin(tn ? tn.avgRent : L.rent), label: `Average rent${tn ? ' in ' + tn.name : ''} now` };
      case 'rateMax':
      case 'rateMin':
        return { value: fin(L.loanRate), label: 'Average loan rate now' };
      case 'reserveMin': {
        const dep = fin(L.money);
        return { value: dep > 0 ? fin(s.bank.reserves) / dep : NaN, label: 'Reserves ÷ deposits now' };
      }
      case 'capitalMin':
        return { value: fin(L.capRatio, NaN), label: 'Capital ÷ loans now' };
      case 'importMax':
      case 'exportMax': {
        const pre = kind === 'importMax' ? 'imp_' : 'exp_';
        const gs = good >= 0 ? [good] : TRADABLE_GOODS;
        let v = 0;
        for (const g of gs) v += fin(tailMean(s.stats?.daily?.[pre + g], 30));
        return { value: v, label: `${kind === 'importMax' ? 'Imports' : 'Exports'} a day, 30-day average` };
      }
      case 'shipMax': {
        let q = 0;
        for (const sh of s.shipments) {
          if (!sh || sh.owner === STATE || sh.depart < s.day - 1) continue;
          if (town >= 0 && sh.from !== town) continue;
          if (toTown >= 0 && sh.to !== toTown) continue;
          if (good >= 0 && sh.good !== good) continue;
          q += fin(sh.qty);
        }
        return { value: q, label: 'Set off by wagon in the last day' };
      }
    }
    return { value: NaN, label: '' };
  }

  /** Every town's standing against a draft price limit on one good (town = every town). */
  function townRows(s: SimState, v: number): TownRow[] {
    const rows: TownRow[] = [];
    for (const t of s.towns) {
      const m = marketFor(s, t.id, good);
      const p = priceOf(m);
      const r: TownRow = { name: t.name, price: p, largest: NaN, days: 0, binds: false, status: '' };
      if (kind === 'priceMove') {
        const mv = dailyMoves(m, MOVE_DAYS);
        for (const x of mv) {
          if (!(x <= r.largest)) r.largest = x;
          if (x > v + 1e-9) r.days++;
        }
        r.binds = r.days > 0;
        r.status = !mv.length ? 'not known' : r.binds ? plural(r.days, 'day') : 'no';
      } else if (Number.isFinite(p)) {
        r.binds = kind === 'priceMax' ? v < p - 1e-9 : v > p + 1e-9;
        r.status = r.binds ? `yes · ${fmtPct(Math.abs(v / p - 1))} ${kind === 'priceMax' ? 'below' : 'above'}` : 'no';
      } else r.status = 'not known';
      rows.push(r);
    }
    return rows;
  }

  function paintTowns(rows: TownRow[] | null): void {
    show(townsBox, !!rows);
    if (!rows) return;
    const move = kind === 'priceMove';
    const cols = move ? 3 : 2;
    const cell = (text: string, cls?: string) => h('span', cls ? { class: cls } : null, text);
    townsBox.style.setProperty('--cols', String(cols));
    const head = h('div', { class: 'lv-hold-r lv-hold-h', title: move ? `The last ${MOVE_DAYS} days: the largest move from one day to the next, and on how many days a move was larger than the limit` : null }, cell('Town'), cell('Today'), move ? cell('Max move') : null, cell(move ? `Bound (${MOVE_DAYS} d)` : 'Would bind'));
    const body = rows.map((r) =>
      h(
        'div',
        { class: 'lv-hold-r' },
        cell(r.name),
        cell(fmtPrice(r.price)),
        move ? cell(Number.isFinite(r.largest) ? fmtPct(r.largest) : '—') : null,
        cell(r.status, r.binds ? 'bind' : undefined),
      ),
    );
    townsBox.replaceChildren(head, ...body);
  }

  function valueOf(d: KindDef): number {
    return d.value === 'money' ? valMoney.value : d.value === 'pct' ? valPct.value : valQty.value;
  }

  function draft(s: SimState): Omit<Limit, 'id' | 'created' | 'binding'> {
    const d = kindDef(kind);
    const inst = isPriceKind(kind) && isInstrument(good);
    return {
      label: '',
      enabled: true,
      kind,
      good: d.good === 'none' ? -1 : good,
      town: d.town === 'none' || inst ? -1 : town,
      toTown: d.toTown ? toTown : -1,
      value: fin(valueOf(d), NaN),
      until: ends === 'after' && endDays.value >= 1 ? s.day + Math.round(endDays.value) - 1 : -1,
    };
  }

  /** The would-it-bind line for a limit on bank capital: it replaces the standing rule, higher or lower. */
  function capitalText(s: SimState, v: number, r: number): string {
    const kept = Math.max(BANK_OWN_MIN_CAPITAL, v);
    const own = v < BANK_OWN_MIN_CAPITAL ? `The Bank never lets its own capital fall below ${tidyPct(BANK_OWN_MIN_CAPITAL)} of its own accord, so ${tidyPct(BANK_OWN_MIN_CAPITAL)} is what it would keep. ` : '';
    if (!Number.isFinite(r)) return own + `It replaces the standing ${tidyPct(BANK_MIN_CAPITAL)}.`;
    if (kept > r + 1e-9) return own + `It would bind at once (${fmtPct(kept / Math.max(1e-9, r) - 1)} above today): the Bank must lend less until its own capital catches up.`;
    const now = safe(() => minCapital(s), BANK_MIN_CAPITAL);
    if (kept < now - 1e-9) {
      if (r < now + 1e-9) return own + `Today the Bank holds ${fmtPct(r, 1)} of its loans, short of the ${tidyPct(now)} it must keep now: under this rule it may go on lending.`;
      return own + `It lets the Bank lend more against the capital it has. Today it holds ${fmtPct(r, 1)} of its loans — above both — so its lending changes only once losses thin its capital.`;
    }
    return own + `Today it would not bind: the Bank holds ${fmtPct(r, 1)} of its loans, above it.`;
  }

  /** The would-it-bind line for a limit on daily moves (judged on the last MOVE_DAYS days). */
  function moveText(s: SimState, v: number): string {
    if (v <= 0) return 'Zero holds the price where it stands: every change in demand or supply turns into a shortage or unsold goods.';
    let n = 0;
    let over = 0;
    let big = NaN;
    const cov = covered(s);
    for (const c of cov)
      for (const x of dailyMoves(c.m, MOVE_DAYS)) {
        n++;
        if (x > v + 1e-9) over++;
        if (!(x <= big)) big = x;
      }
    if (!n) return 'Not known yet: the markets have no price history.';
    const each = `each day’s price stays within ${fmtPct(v)} of the day before; the rest of the pressure shows as buyers or sellers rationed at the bound`;
    if (cov.length === 1) {
      if (!over) return `In the last ${MOVE_DAYS} days the price never moved more than ${fmtPct(v)} in a day: it would bind only on a sudden jump.`;
      return `On ${over} of the last ${n} days the price moved more than ${fmtPct(v)} (the largest move: ${fmtPct(big)}). It would bind: ${each}.`;
    }
    if (!over) return `In the last ${MOVE_DAYS} days no price it covers moved more than ${fmtPct(v)} in a day: it would bind only on a sudden jump.`;
    return `${plural(over, 'daily move')} of the ${n} in the last ${MOVE_DAYS} days ${over === 1 ? 'was' : 'were'} larger than ${fmtPct(v)} (the largest: ${fmtPct(big)}). It would bind: ${each}.`;
  }

  function paint(): void {
    const s = last;
    if (!s) return;
    const d = kindDef(kind);
    syncSelects();
    const inst = isPriceKind(kind) && isInstrument(good);
    show(goodRow.el, d.good !== 'none');
    setText(goodRow.lab, d.instruments ? 'Market' : 'Good');
    show(townRow.el, d.town !== 'none' && !inst);
    setText(townRow.lab, d.toTown ? 'From' : 'Town');
    townSel.setOptions(townOptions(s, d.toTown ? 'Any town' : kind === 'priceMove' ? 'Every town' : 'All towns'), town);
    town = townSel.value;
    show(toRow.el, d.toTown);
    toSel.setOptions(townOptions(s, 'Any town'), toTown);
    toTown = toSel.value;
    show(valMoney.el, d.value === 'money');
    show(valPct.el, d.value === 'pct');
    show(valQty.el, d.value === 'qty');
    show(endDays.el, ends === 'after');
    setChips(d);
    const unit =
      kind === 'priceMax' || kind === 'priceMin'
        ? good === IOU_GOOD
          ? '/IOU'
          : good === GOLD_GOOD
            ? '/oz'
            : `/${good >= 0 ? unitOf(good) : 'unit'}`
        : kind.startsWith('wage')
          ? '/day'
          : kind.startsWith('rent')
            ? '/home-day'
            : '';
    const q = valQty.el.querySelector('.num-unit');
    if (q) setText(q, `${good >= 0 && !isInstrument(good) ? unitsOf(good) : 'units'}/day`);
    const mu = valMoney.el.querySelector('.num-unit');
    if (mu) setText(mu, unit);
    const pu = valPct.el.querySelector('.num-unit');
    if (pu) setText(pu, kind === 'priceMove' ? '% a day' : kind === 'rateMax' || kind === 'rateMin' ? '% a year' : '%');
    setText(valueRow.lab, d.bound === 'max' ? 'At most' : 'At least');

    // default the value when the subject changes
    const sig = `${kind}:${good}:${town}:${toTown}`;
    const ref = reference(s);
    if (sig !== valueFor) {
      valueFor = sig;
      if (kind === 'priceMove') valPct.set(0.05);
      else if (kind === 'capitalMin') valPct.set(safe(() => minCapital(s), BANK_MIN_CAPITAL));
      else if (Number.isFinite(ref.value)) {
        if (d.value === 'money') valMoney.set(niceRound(ref.value * (d.bound === 'max' ? 0.9 : 1.1)));
        else if (d.value === 'pct') valPct.set(Math.max(0, Math.round(ref.value * (d.bound === 'max' ? 0.9 : 1.1) * 1000) / 1000));
        else valQty.set(Math.max(0, Math.round(ref.value * 0.5)));
      }
    }
    const fmtV = (v: number) => (d.value === 'money' ? fmtPrice(v) + unit : d.value === 'pct' ? fmtPct(v, kind === 'capitalMin' || kind === 'priceMove' ? 1 : undefined) : fmtQ(v) + ' a day');
    setText(refHint, ref.label ? `${ref.label}: ${Number.isFinite(ref.value) ? fmtV(ref.value) : 'not known yet'}` : '');
    const capNow = safe(() => minCapital(s), BANK_MIN_CAPITAL);
    setText(
      ruleHint,
      kind === 'capitalMin'
        ? `Rule in force now: ${tidyPct(capNow)}${Math.abs(capNow - BANK_MIN_CAPITAL) < 1e-9 && !s.policy.limits.some((l) => l.enabled && l.kind === 'capitalMin') ? ' (the standing rule)' : ' (a Limit)'}. A Limit replaces the standing ${tidyPct(BANK_MIN_CAPITAL)}, higher or lower; the Bank never goes below ${tidyPct(BANK_OWN_MIN_CAPITAL)} of its own accord.`
        : kind === 'priceMove'
          ? `Each day the auction may clear at most this far above or below the day before’s price${inst ? '' : ' (before levies)'}. Fixed price limits still apply and prevail.`
          : '',
    );

    const dr = draft(s);
    const sameRoute = kind === 'shipMax' && dr.town >= 0 && dr.town === dr.toTown;
    const tooFar = kind === 'priceMove' && dr.value > LIMIT_MOVE_MAX;
    const valid = Number.isFinite(dr.value) && dr.value >= 0 && !(d.good === 'required' && dr.good < 0) && !sameRoute && !tooFar;
    const pseudo: Limit = { ...dr, id: 0, created: s.day, binding: 0 };
    setText(decree, valid ? polishRule(safe(() => describeLimit(s, pseudo), '')) : sameRoute ? 'Choose two different towns for the route (or “any town” at one end).' : 'Set a value to see the rule in words.');

    // every town, one good: the table
    const perTown = valid && isPriceKind(kind) && !inst && good >= 0 && town < 0 && s.towns.length > 1 ? townRows(s, dr.value) : null;
    paintTowns(perTown);

    // would it bite at once?
    let text = '';
    const v = dr.value;
    const r = ref.value;
    if (valid && kind === 'priceMove') text = moveText(s, v);
    else if (valid && kind === 'capitalMin') text = capitalText(s, v, r);
    else if (valid && perTown && kind !== 'priceMove') {
      const hit = perTown.filter((x) => x.binds).map((x) => x.name);
      const how = kind === 'priceMax' ? 'demand beyond what is offered goes unmet (rationed pro rata)' : 'supply beyond what buyers take goes unsold';
      if (!hit.length) text = `Today it would not bind in any town: every town’s price is already ${kind === 'priceMax' ? 'below' : 'above'} it.`;
      else text = `It would bind at once in ${hit.length === perTown.length ? 'every town' : hit.join(', ')}: the market clears at the bound there and ${how}.`;
    } else if (valid && Number.isFinite(r)) {
      const bites = d.bound === 'max' ? v < r - 1e-9 : v > r + 1e-9;
      const gap = r > 0 ? Math.abs(v / r - 1) : NaN;
      const gapText = Number.isFinite(gap) && gap > 0.0005 ? ` (${fmtPct(gap)} ${d.bound === 'max' ? 'below' : 'above'} today)` : '';
      if (d.value === 'qty' && v <= 0) text = 'Zero means nothing may pass at all.';
      else if (!bites) text = `Today it would not bind: the actual value is already ${d.bound === 'max' ? 'below' : 'above'} it.`;
      else if (kind === 'priceMax') text = `It would bind at once${gapText}: the market clears at the bound and demand beyond what is offered goes unmet (rationed pro rata).`;
      else if (kind === 'priceMin') text = `It would bind at once${gapText}: the market clears at the bound and supply beyond what buyers take goes unsold.`;
      else if (kind === 'wageMin') text = `It would bind at once${gapText}: employers paying less must raise pay to the bound or not hire.`;
      else if (kind === 'wageMax') text = `It would bind at once${gapText}: employers paying more must cut pay to the bound.`;
      else if (kind === 'rentMax') text = `It would bind at once${gapText}: landlords asking more must cut rents to the bound.`;
      else if (kind === 'rentMin') text = `It would bind at once${gapText}: landlords asking less must raise rents to the bound.`;
      else if (kind === 'rateMax') text = `It would bind at once${gapText}: the Bank must lend at no more than this and turns away the riskier borrowers instead.`;
      else if (kind === 'rateMin') text = `It would bind at once${gapText}: the Bank must charge at least this on every loan, so its safest borrowers pay more and borrow less.`;
      else if (kind === 'reserveMin') text = `It would bind at once${gapText}: the Bank must hold more reserves, borrowing at the window when short.`;
      else text = `It would bind at once${gapText}: flows beyond the bound are turned away each day.`;
    }
    if (valid && kind === 'rateMin' && Number.isFinite(r) && !(v > r + 1e-9)) text = `Today it would not bind on average (loans cost ${fmtPct(r, 1)}), though loans to the safest borrowers below ${fmtPct(v, 1)} would be raised to it.`;
    setText(bite, text);
    enact.disabled = !valid;
  }

  function submit(): void {
    const s = last;
    if (!s) return;
    const d = kindDef(kind);
    const dr = draft(s);
    if (!Number.isFinite(dr.value)) {
      const ctl = d.value === 'money' ? valMoney : d.value === 'pct' ? valPct : valQty;
      return msg.err(ctl.error ?? 'Set a value.');
    }
    run({ type: 'addLimit', limit: dr }, msg, '✓ Enacted — the limit is listed under In force.');
  }

  return {
    id: 'limit',
    title: 'Limit',
    tagline: 'Legal bounds on prices, pay, credit',
    body,
    summary(s) {
      const on = s.policy.limits.filter((l) => l.enabled);
      if (!on.length) return { text: 'No limits' };
      const bound = on.filter((l) => l.binding > 0).length;
      return { text: `${plural(on.length, 'limit')}${bound ? ` · ${bound} binding` : ''}`, tone: bound ? 'warn' : null };
    },
    update(s) {
      last = s;
      paint();
    },
    prefill(req: PrefillRequest, s) {
      if (req.lever !== 'limit') return false;
      last = s;
      if (req.kind) kind = req.kind;
      if (req.good !== undefined) good = req.good;
      if (req.town !== undefined) town = req.town;
      valueFor = '';
      syncSelects();
      paint();
      return true;
    },
    focus() {
      const d = kindDef(kind);
      (d.value === 'money' ? valMoney : d.value === 'pct' ? valPct : valQty).focus();
    },
    reset() {
      valueFor = '';
      last = null;
      town = -1;
      toTown = -1;
    },
  };
}
