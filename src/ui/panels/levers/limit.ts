// ============================================================================
// Lever IV — Limit: legal bounds on prices, wages, rents, the Bank's loan rate
// and balance sheet, and on how much may cross the port or travel between
// towns. Each kind shows today's actual value for reference and whether the
// bound would bite at once; the rule is previewed in the sim's own words.
// ============================================================================
import { PLAYER_MAX_PRICE, PLAYER_MAX_QTY, PLAYER_MAX_RATE } from '../../../sim/config';
import { G, GOODS, N_GOODS, TRADABLE_GOODS } from '../../../sim/goods';
import { describeLimit } from '../../../sim/policy/player';
import { STATE, type Limit, type LimitKind, type SimState } from '../../../sim/types';
import { h, setText, show } from '../../dom';
import { fmtPct, fmtPrice, plural } from '../../format';
import type { PrefillRequest } from '../../uiState';
import { goodOptions, numberInput, segmented, selectInput, tailMean, townOptions, type Option } from '../../widgets';
import { chip, dynRow, fin, fmtQ, formEl, formFoot, hint, msgLine, niceRound, polishRule, row, run, safe, submitButton, unitOf, unitsOf, type Lever } from './common';

interface KindDef {
  kind: LimitKind;
  label: string;
  family: string;
  good: 'none' | 'required' | 'any' | 'tradable';
  town: 'none' | 'any';
  toTown: boolean;
  value: 'money' | 'pct' | 'qty';
  /** Direction of the bound: 'max' binds when the actual is above it. */
  bound: 'max' | 'min';
}

const KINDS: KindDef[] = [
  { kind: 'priceMax', label: 'Price of a good — at most', family: 'Prices', good: 'required', town: 'any', toTown: false, value: 'money', bound: 'max' },
  { kind: 'priceMin', label: 'Price of a good — at least', family: 'Prices', good: 'required', town: 'any', toTown: false, value: 'money', bound: 'min' },
  { kind: 'wageMin', label: 'Daily wage — at least', family: 'Wages & rents', good: 'none', town: 'any', toTown: false, value: 'money', bound: 'min' },
  { kind: 'wageMax', label: 'Daily wage — at most', family: 'Wages & rents', good: 'none', town: 'any', toTown: false, value: 'money', bound: 'max' },
  { kind: 'rentMax', label: 'Rent — at most', family: 'Wages & rents', good: 'none', town: 'any', toTown: false, value: 'money', bound: 'max' },
  { kind: 'rentMin', label: 'Rent — at least', family: 'Wages & rents', good: 'none', town: 'any', toTown: false, value: 'money', bound: 'min' },
  { kind: 'rateMax', label: 'Bank loan rate — at most', family: 'The Bank', good: 'none', town: 'none', toTown: false, value: 'pct', bound: 'max' },
  { kind: 'reserveMin', label: 'Bank reserves — at least', family: 'The Bank', good: 'none', town: 'none', toTown: false, value: 'pct', bound: 'min' },
  { kind: 'capitalMin', label: 'Bank capital — at least', family: 'The Bank', good: 'none', town: 'none', toTown: false, value: 'pct', bound: 'min' },
  { kind: 'importMax', label: 'Imports — at most', family: 'Movement of goods', good: 'tradable', town: 'none', toTown: false, value: 'qty', bound: 'max' },
  { kind: 'exportMax', label: 'Exports — at most', family: 'Movement of goods', good: 'tradable', town: 'none', toTown: false, value: 'qty', bound: 'max' },
  { kind: 'shipMax', label: 'Wagon shipments — at most', family: 'Movement of goods', good: 'any', town: 'any', toTown: true, value: 'qty', bound: 'max' },
];

const kindDef = (k: LimitKind): KindDef => KINDS.find((x) => x.kind === k) ?? KINDS[0];

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
  const valPct = numberInput({ value: 0.1, percent: true, min: 0, max: PLAYER_MAX_RATE, width: '100px', onChange: changed });
  const valQty = numberInput({ value: 0, min: 0, max: PLAYER_MAX_QTY, unit: 'a day', width: '130px', onChange: changed });
  const chipsBox = h('div', { class: 'lv-chips' });
  const refHint = hint();
  const valueRow = dynRow('Bound', valMoney.el, valPct.el, valQty.el, chipsBox, refHint);

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
    row('Ends', endsSeg.el, endDays.el),
    decree,
    formFoot(preview, msg, enact),
  );
  const body = h('div', { class: 'lv-body-in' }, form);

  let chipSig = '';
  function setChips(d: KindDef): void {
    const sig = d.value;
    if (sig === chipSig) return;
    chipSig = sig;
    const mk = (lab: string, k: number | 'zero' | 'now', title: string) =>
      chip(lab, () => {
        if (!last) return;
        const r = reference(last).value;
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
    else chipsBox.replaceChildren(mk('−20%', -0.2, '20% below today'), mk('−10%', -0.1, '10% below today'), mk('Now', 'now', 'Today’s value'), mk('+10%', 0.1, '10% above today'), mk('+20%', 0.2, '20% above today'));
  }

  function syncSelects(): void {
    kindSel.set(kind);
    const d = kindDef(kind);
    let opts: Option<number>[];
    if (d.good === 'required') opts = goodOptions();
    else if (d.good === 'tradable') opts = goodOptions((g) => g.tradable, 'any good');
    else opts = goodOptions(undefined, 'any good');
    goodSel.setOptions(opts, good);
    good = goodSel.value;
  }

  /** Today's actual value for the draft's kind/good/town. */
  function reference(s: SimState): { value: number; label: string } {
    const L = s.stats?.latest ?? {};
    const tn = town >= 0 ? s.towns[town] : undefined;
    switch (kind) {
      case 'priceMax':
      case 'priceMin': {
        if (good < 0) return { value: NaN, label: '' };
        if (town >= 0) {
          const m = s.markets[town * N_GOODS + good];
          const p = fin(m?.price > 0 ? m.price : m?.ema);
          return { value: p, label: `${GOODS[good].name} in ${tn?.name ?? ''} now` };
        }
        return { value: fin(L['price_' + good]), label: `${GOODS[good].name} across the realm now` };
      }
      case 'wageMin':
      case 'wageMax':
        return { value: fin(tn ? tn.avgWage : L.wage), label: `Average wage${tn ? ' in ' + tn.name : ''} now` };
      case 'rentMax':
      case 'rentMin':
        return { value: fin(tn ? tn.avgRent : L.rent), label: `Average rent${tn ? ' in ' + tn.name : ''} now` };
      case 'rateMax':
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

  function valueOf(d: KindDef): number {
    return d.value === 'money' ? valMoney.value : d.value === 'pct' ? valPct.value : valQty.value;
  }

  function draft(s: SimState): Omit<Limit, 'id' | 'created' | 'binding'> {
    const d = kindDef(kind);
    return {
      label: '',
      enabled: true,
      kind,
      good: d.good === 'none' ? -1 : good,
      town: d.town === 'none' ? -1 : town,
      toTown: d.toTown ? toTown : -1,
      value: fin(valueOf(d), NaN),
      until: ends === 'after' && endDays.value >= 1 ? s.day + Math.round(endDays.value) - 1 : -1,
    };
  }

  function paint(): void {
    const s = last;
    if (!s) return;
    const d = kindDef(kind);
    syncSelects();
    show(goodRow.el, d.good !== 'none');
    show(townRow.el, d.town !== 'none');
    setText(townRow.lab, d.toTown ? 'From' : 'Town');
    townSel.setOptions(townOptions(s, d.toTown ? 'Any town' : 'All towns'), town);
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
        ? `/${good >= 0 ? unitOf(good) : 'unit'}`
        : kind.startsWith('wage')
          ? '/day'
          : kind.startsWith('rent')
            ? '/home-day'
            : '';
    const q = valQty.el.querySelector('.num-unit');
    if (q) setText(q, `${good >= 0 ? unitsOf(good) : 'units'}/day`);
    const mu = valMoney.el.querySelector('.num-unit');
    if (mu) setText(mu, unit);
    setText(valueRow.lab, d.bound === 'max' ? 'At most' : 'At least');

    // default the value when the subject changes
    const sig = `${kind}:${good}:${town}:${toTown}`;
    const ref = reference(s);
    if (sig !== valueFor) {
      valueFor = sig;
      if (Number.isFinite(ref.value)) {
        if (d.value === 'money') valMoney.set(niceRound(ref.value * (d.bound === 'max' ? 0.9 : 1.1)));
        else if (d.value === 'pct') valPct.set(Math.max(0, Math.round(ref.value * (d.bound === 'max' ? 0.9 : 1.1) * 1000) / 1000));
        else valQty.set(Math.max(0, Math.round(ref.value * 0.5)));
      }
    }
    const fmtV = (v: number) => (d.value === 'money' ? fmtPrice(v) + unit : d.value === 'pct' ? fmtPct(v) : fmtQ(v) + ' a day');
    setText(refHint, ref.label ? `${ref.label}: ${Number.isFinite(ref.value) ? fmtV(ref.value) : 'not known yet'}` : '');

    const dr = draft(s);
    const sameRoute = kind === 'shipMax' && dr.town >= 0 && dr.town === dr.toTown;
    const valid = Number.isFinite(dr.value) && dr.value >= 0 && !(d.good === 'required' && dr.good < 0) && !sameRoute;
    const pseudo: Limit = { ...dr, id: 0, created: s.day, binding: 0 };
    setText(decree, valid ? polishRule(safe(() => describeLimit(s, pseudo), '')) : sameRoute ? 'Choose two different towns for the route (or “any town” at one end).' : 'Set a value to see the rule in words.');

    // would it bite at once?
    let text = '';
    const v = dr.value;
    const r = ref.value;
    if (valid && Number.isFinite(r)) {
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
      else if (kind === 'reserveMin') text = `It would bind at once${gapText}: the Bank must hold more reserves, borrowing at the window when short.`;
      else if (kind === 'capitalMin') text = `It would bind at once${gapText}: the Bank must lend less until its own capital catches up.`;
      else text = `It would bind at once${gapText}: flows beyond the bound are turned away each day.`;
    }
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
