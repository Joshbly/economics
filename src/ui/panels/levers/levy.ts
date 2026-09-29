// ============================================================================
// Lever III — Levy: attach a signed rate to any flow, composed like a sentence:
//   [Take|Pay] [rate] [unit] on [flow] of [good] in [town], charged to [payer]
// plus the conditions that mean something for that flow (group, trade,
// threshold, expiry). A rule on sales of one good may instead aim at a price:
// its rate then re-sets each morning, town by town (levies.steerLevies). The rule is previewed with the sim's own neutral wording
// (describeLevy) and a rough estimate of today's base and yield.
// ============================================================================
import { AIM_MAX_CAP, AIM_MAX_DEFAULT, PLAYER_MAX_PCT, PLAYER_MAX_PRICE, PLAYER_MAX_UNIT_RATE } from '../../../sim/config';
import { G, GOODS, N_GOODS, SECTORS } from '../../../sim/goods';
import { inGroup, primeAimedRates } from '../../../sim/policy/levies';
import { describeLevy } from '../../../sim/policy/player';
import type { BuildingKind, Group, Levy, LevyBase, LevyPayer, LevyUnit, Sector, SimState } from '../../../sim/types';
import { h, setText, show } from '../../dom';
import { fmtPct, fmtPrice, plural } from '../../format';
import type { PrefillRequest } from '../../uiState';
import { goodOptions, numberInput, segmented, selectInput, townOptions, type Option } from '../../widgets';
import { fin, formEl, formFoot, hint, msgLine, run, safe, signedMoney, submitButton, unitOf, type Lever } from './common';
import { estimateLevy, type LevyDraft, type LevyEstimate } from './estimate';
import { BASES, baseDef, groupsFor, PAYER_WORD, saleTargeted, saleWhoFilters, saleWhoOf, saleWhoOptions, saleWhoWords, thresholdMeaning, unitLabel, type SaleWho } from './levyDefs';

const SECTOR_KEYS = (Object.keys(SECTORS) as Sector[]).filter((k) => k !== 'stateworks');

const GOODS_NAME = (g: number) => (GOODS[g]?.name ?? 'goods').toLowerCase();

/** Average going price of a good across the towns (0 if none). */
function avgPrice(s: SimState, g: number): number {
  let sum = 0;
  let n = 0;
  for (let t = 0; t < s.towns.length; t++) {
    const m = s.markets[t * N_GOODS + g];
    if (m && m.ema > 0) {
      sum += m.ema;
      n++;
    }
  }
  return n ? sum / n : 0;
}

function sectorOptions(anyLabel: string, producersOnly = false): Option<Sector | 'any'>[] {
  const out: Option<Sector | 'any'>[] = [{ value: 'any', label: anyLabel }];
  for (const k of SECTOR_KEYS) if (!producersOnly || SECTORS[k].producer) out.push({ value: k, label: SECTORS[k].name });
  return out;
}

export function levyLever(): Lever {
  let base: LevyBase = 'sale';
  let dir: 1 | -1 = 1;
  let unit: LevyUnit = 'pct';
  let payer: LevyPayer = 'buyer';
  let good = G.bread as number;
  let town = -1;
  let toTown = -1;
  let sector: Sector | 'any' = 'any';
  let group: Group = 'all';
  let kind: BuildingKind | 'any' = 'any';
  let ends: 'never' | 'after' = 'never';
  let who: SaleWho = 'all'; // sale levies: who the rule applies to
  let rateMode: 'fixed' | 'aim' = 'fixed'; // sale levies on one good: a fixed rate, or aim at a price
  let last: SimState | null = null;
  let estKey = '';
  let est: LevyEstimate | null = null;

  const msg = msgLine();
  const changed = () => {
    msg.clear();
    paint();
  };

  // ---- sentence controls -------------------------------------------------------
  const dirSeg = segmented<1 | -1>({
    options: [
      { value: 1, label: 'Take', title: 'The Treasury receives the rate' },
      { value: -1, label: 'Pay', title: 'The Treasury pays the rate out of the Purse' },
    ],
    value: dir,
    onChange: (v) => ((dir = v), changed()),
  });
  const ratePct = numberInput({ value: 0.1, percent: true, unit: '', min: 0, max: PLAYER_MAX_PCT, width: '66px', onChange: changed, title: 'Rate in percent' });
  const rateMoney = numberInput({ value: 0.5, prefix: '¤', min: 0, max: PLAYER_MAX_UNIT_RATE, width: '80px', onChange: changed, title: 'Rate in ¤' });
  const aimWord = h('span', { class: 'lv-w lv-w-strong' }, 'part of the price');
  const unitSel = selectInput<LevyUnit>({ options: [{ value: 'pct', label: '% of value' }], value: unit, onChange: (v) => ((unit = v), changed()) });
  const unitStatic = h('span', { class: 'lv-w lv-w-strong' });
  const conn = h('span', { class: 'lv-w' }, 'on');
  const baseSel = selectInput<LevyBase>({
    options: BASES.map((b) => ({ value: b.base, label: b.label, group: b.family })),
    value: base,
    onChange: (v) => setBase(v),
  });
  const wGood = h('span', { class: 'lv-w' }, 'of');
  const goodSel = selectInput<number>({ options: goodOptions(undefined, 'all goods'), value: good, onChange: (v) => ((good = v), changed()) });
  const wSector = h('span', { class: 'lv-w' }, 'at');
  const sectorSel = selectInput<Sector | 'any'>({ options: sectorOptions('any workplace'), value: sector, onChange: (v) => ((sector = v), changed()) });
  const wKind = h('span', { class: 'lv-w' }, 'used as');
  const kindSel = selectInput<BuildingKind | 'any'>({
    options: [
      { value: 'any', label: 'anything' },
      { value: 'house', label: 'homes' },
      { value: 'firm', label: 'workplaces' },
    ],
    value: kind,
    onChange: (v) => ((kind = v), changed()),
  });
  const wGroup = h('span', { class: 'lv-w' }, 'among');
  const groupSelInline = selectInput<Group>({ options: groupsFor('head'), value: group, onChange: (v) => ((group = v), changed()) });
  const wTown = h('span', { class: 'lv-w' }, 'in');
  const townSel = selectInput<number>({ options: [{ value: -1, label: 'all towns' }], value: town, onChange: (v) => ((town = v), changed()) });
  const wTo = h('span', { class: 'lv-w' }, 'to');
  const toSel = selectInput<number>({ options: [{ value: -1, label: 'any town' }], value: toTown, onChange: (v) => ((toTown = v), changed()) });
  const wPayer = h('span', { class: 'lv-w' }, 'charged to');
  // two-way payer choice: 0 = the base's first payer role, 1 = its second (labels set per base)
  const payerSeg2 = segmented<0 | 1>({ options: [{ value: 0, label: 'buyers' }, { value: 1, label: 'sellers' }], value: 0, size: 'sm', onChange: () => changed() });
  const payerSlot = h('span', { class: 'lv-payer' }, payerSeg2.el);

  const sentence = h(
    'div',
    { class: 'lv-sentence' },
    h('span', { class: 'lv-frag' }, dirSeg.el),
    h('span', { class: 'lv-frag' }, ratePct.el, rateMoney.el, aimWord, unitSel.el, unitStatic),
    h('span', { class: 'lv-frag' }, conn, baseSel.el),
    h('span', { class: 'lv-frag' }, wGroup, groupSelInline.el),
    h('span', { class: 'lv-frag' }, wGood, goodSel.el),
    h('span', { class: 'lv-frag' }, wKind, kindSel.el),
    h('span', { class: 'lv-frag' }, wSector, sectorSel.el),
    h('span', { class: 'lv-frag' }, wTown, townSel.el),
    h('span', { class: 'lv-frag' }, wTo, toSel.el),
    h('span', { class: 'lv-frag' }, wPayer, payerSlot),
  );
  const explain = hint();

  // ---- rate mode (sale rules on one good): fixed, or aimed at a price ---------------
  const modeSeg = segmented<'fixed' | 'aim'>({
    options: [
      { value: 'fixed', label: 'Fixed rate', title: 'The same rate every day' },
      { value: 'aim', label: 'Aim at a price', title: 'Each morning the rate re-sets, town by town, so that the price paid (or received) moves toward the price you set' },
    ],
    value: rateMode,
    size: 'sm',
    onChange: (v) => {
      rateMode = v;
      if (v === 'aim') {
        unit = 'pct';
        const s = last;
        if (s && !aimTouched) {
          const avg = avgPrice(s, good);
          if (avg > 0) aimPrice.set(Math.round(avg * (dir === -1 ? 0.85 : 1.15) * 100) / 100);
        }
      }
      changed();
    },
  });
  let aimTouched = false;
  const aimPrice = numberInput({
    value: 2.5,
    prefix: '¤',
    min: 0.01,
    max: PLAYER_MAX_PRICE,
    width: '84px',
    onChange: () => ((aimTouched = true), changed()),
    title: 'The price to aim at',
  });
  const aimMax = numberInput({ value: AIM_MAX_DEFAULT, percent: true, min: 0.01, max: AIM_MAX_CAP, width: '66px', onChange: changed, title: 'The most the rate may reach, as a share of the price' });
  const aimWho = h('span', { class: 'lv-w' });
  const aimUnit = h('span', { class: 'lv-w' });
  const aimFields = h('span', { class: 'lv-aim-f' }, aimWho, aimPrice.el, aimUnit, aimMax.el, h('span', { class: 'lv-w' }, 'of the price'));
  const aimRow = h('div', { class: 'lv-aim' }, h('span', { class: 'lv-w' }, 'Rate'), modeSeg.el, aimFields);

  // ---- conditions ----------------------------------------------------------------
  const groupSel = selectInput<Group>({ options: groupsFor('wage'), value: group, onChange: (v) => ((group = v), changed()) });
  const firmSectorSel = selectInput<Sector | 'any'>({ options: sectorOptions('any trade'), value: sector, onChange: (v) => ((sector = v), changed()) });
  const thrMoney = numberInput({ value: 0, prefix: '¤', min: 0, width: '100%', onChange: changed });
  const thrQty = numberInput({ value: 0, unit: 'units', min: 0, width: '100%', onChange: changed });
  const endsSeg = segmented<'never' | 'after'>({ options: [{ value: 'never', label: 'Never' }, { value: 'after', label: 'After' }], value: ends, size: 'sm', onChange: (v) => ((ends = v), changed()) });
  const endDays = numberInput({ value: 90, integer: true, min: 1, max: 36000, unit: 'days', width: '92px', onChange: changed });

  const whoSel = selectInput<SaleWho>({ options: saleWhoOptions('buyer'), value: who, onChange: (v) => ((who = v), changed()), title: 'Who the rule applies to' });
  const whoLab = h('div', { class: 'lv-cond-l' }, 'Applies to');
  const whoHint = h('div', { class: 'lv-cond-h' });
  const cWho = h('div', { class: 'lv-cond-c lv-cond-who' }, whoLab, whoSel.el, whoHint);
  const cGroup = h('div', { class: 'lv-cond-c' }, h('div', { class: 'lv-cond-l' }, 'Only for'), groupSel.el);
  const cSector = h('div', { class: 'lv-cond-c' }, h('div', { class: 'lv-cond-l' }, 'Firms in'), firmSectorSel.el);
  const thrLab = h('div', { class: 'lv-cond-l' }, 'Exempt first');
  const thrHint = h('div', { class: 'lv-cond-h' });
  const cThr = h('div', { class: 'lv-cond-c' }, thrLab, thrMoney.el, thrQty.el, thrHint);
  const cEnds = h('div', { class: 'lv-cond-c' }, h('div', { class: 'lv-cond-l' }, 'Ends'), h('div', { class: 'row' }, endsSeg.el, endDays.el));
  const conds = h('div', { class: 'lv-cond' }, cWho, cGroup, cSector, cThr, cEnds);

  // ---- preview -----------------------------------------------------------------------
  const decree = h('div', { class: 'lv-decree' });
  const estLine = h('div', { class: 'lv-est' });
  const preview = h('div', { class: 'lv-preview' }, estLine);
  const enact = submitButton('Enact', 'Put this rule in force (Enter)');

  const form = formEl(() => submit(), sentence, aimRow, explain, conds, decree, formFoot(preview, msg, enact));
  const body = h('div', { class: 'lv-body-in' }, form);

  // ---- logic -------------------------------------------------------------------------
  function setBase(b: LevyBase): void {
    base = b;
    const d = baseDef(b);
    unit = d.units[0];
    if (!d.payers.includes(payer)) payer = d.payers[0];
    const gs = groupsFor(b);
    if (!gs.some((g) => g.value === group)) group = 'all';
    if (b === 'goods' && unit === 'perUnit' && !(rateMoney.value > 0)) rateMoney.set(0.05);
    syncControls();
    changed();
  }

  function syncControls(): void {
    const d = baseDef(base);
    baseSel.set(base);
    dirSeg.set(dir);
    unitSel.setOptions(
      d.units.map((u) => ({ value: u, label: unitLabel(base, u, d.good ? good : -1) })),
      unit,
    );
    groupSel.setOptions(groupsFor(base), group);
    groupSelInline.setOptions(groupsFor('head'), group);
    goodSel.set(good);
    townSel.set(town);
    toSel.set(toTown);
    sectorSel.set(sector);
    firmSectorSel.set(sector);
    kindSel.set(kind);
    // payer segmented: rebuild labels for this base
    if (d.payers.length === 2) {
      const btns = payerSeg2.el.querySelectorAll('button');
      if (btns.length === 2) {
        setText(btns[0], PAYER_WORD[d.payers[0]]);
        setText(btns[1], PAYER_WORD[d.payers[1]]);
      }
    }
    payerSeg2.set(payer === d.payers[1] ? 1 : 0);
  }

  function draft(s: SimState): LevyDraft {
    const d = baseDef(base);
    const rate = unit === 'pct' ? ratePct.value : rateMoney.value;
    const thr = d.threshold ? (base === 'goods' && unit !== 'pct' ? thrQty.value : thrMoney.value) : 0;
    let bk: BuildingKind | 'any' = d.kind ? kind : 'any';
    let sec: Sector | 'any' = d.sector ? sector : 'any';
    if (base === 'building' && bk === 'house') sec = 'any';
    if (base === 'building' && sec !== 'any') bk = 'firm';
    let g = d.group ? group : 'all';
    if (base === 'sale') {
      const f = saleWhoFilters(who, payer);
      g = f.group;
      sec = f.sector;
    }
    const aiming = canAim() && rateMode === 'aim';
    const out: LevyDraft = {
      label: '',
      enabled: true,
      dir,
      base,
      unit: aiming ? 'pct' : unit,
      rate: aiming ? 0 : fin(rate, NaN),
      payer,
      threshold: fin(thr),
      good: d.good ? good : -1,
      town: d.town ? town : -1,
      toTown: d.toTown ? toTown : -1,
      sector: sec,
      group: base === 'head' && g === 'firms' ? 'all' : g,
      buildingKind: bk,
      until: ends === 'after' && endDays.value >= 1 ? s.day + Math.round(endDays.value) - 1 : -1,
    };
    if (aiming) {
      out.aim = fin(aimPrice.value, NaN);
      out.aimMax = fin(aimMax.value, NaN);
    }
    return out;
  }

  /** Can this rule aim at a price? (a rule on sales of one good) */
  function canAim(): boolean {
    return base === 'sale' && good >= 0 && good < N_GOODS;
  }

  /** The rate an aimed draft would apply in each town today (and the price there). */
  function aimedToday(s: SimState, dr: LevyDraft): { town: number; price: number; rate: number }[] {
    const pseudo: Levy = { ...dr, id: 0, created: s.day, today: 0, month: 0, lastMonth: 0, total: 0 };
    primeAimedRates(s, pseudo);
    const out: { town: number; price: number; rate: number }[] = [];
    for (let t = 0; t < s.towns.length; t++) {
      if (dr.town >= 0 && dr.town !== t) continue;
      const m = s.markets[t * N_GOODS + dr.good];
      out.push({ town: t, price: m ? fin(m.ema) : 0, rate: fin(pseudo.aimRates?.[t]) });
    }
    return out;
  }

  /** Live count of who a sale rule would reach ("5 bakeries in Millbrook"). */
  function whoCount(s: SimState, w: SaleWho, t: number): string {
    const where = t >= 0 ? ` in ${s.towns[t]?.name ?? ''}` : ' in the realm';
    if (w === 'all') return `Every ${payer === 'seller' ? 'seller' : 'buyer'}${where}: a wedge between what buyers pay and sellers receive.`;
    const f = saleWhoFilters(w, payer);
    let n = 0;
    if (w.startsWith('f:')) {
      for (const x of s.firms) if (x && x.alive && x.status !== 'closed' && x.sector !== 'stateworks' && (t < 0 || x.town === t) && (f.sector === 'any' || x.sector === f.sector)) n++;
    } else for (const p of s.people) if (p && p.alive && (t < 0 || p.town === t) && inGroup(s, p, f.group)) n++;
    return `${plural(n, w.startsWith('f:') ? (f.sector === 'any' ? 'workshop' : (SECTORS[f.sector]?.name ?? 'workshop').toLowerCase()) : 'household', w.startsWith('f:') ? (f.sector === 'any' ? 'workshops' : saleWhoWords(w)) : 'households')}${where}. Only their ${payer === 'seller' ? 'sales' : 'purchases'} are charged; everyone else trades at the auction price.`;
  }

  /** Today's yield of an aimed draft: the fixed-rate estimate, town by town, at the rate each town would start at. */
  function estimateAimed(s: SimState, dr: LevyDraft): LevyEstimate | null {
    let amount = 0;
    let any = false;
    for (const r of aimedToday(s, dr)) {
      if (!(r.rate > 0)) continue;
      const e = estimateLevy(s, { ...dr, aim: undefined, aimMax: undefined, rate: r.rate, town: r.town });
      if (!e) continue;
      any = true;
      amount += fin(e.amount);
    }
    if (!any) return { baseText: `the ${GOODS_NAME(dr.good)} price is already on your side of the aim everywhere`, amount: 0, per: 'day', rough: true };
    return { baseText: `each town’s starting rate on today’s ${GOODS_NAME(dr.good)} trade`, amount, per: 'day', rough: true };
  }

  function paint(): void {
    const s = last;
    if (!s) return;
    const d = baseDef(base);
    // payer role from the 2-way segmented
    if (d.payers.length === 2) payer = d.payers[payerSeg2.value] ?? d.payers[0];
    else payer = d.payers[0];
    unitSel.setOptions(
      d.units.map((u) => ({ value: u, label: unitLabel(base, u, d.good ? good : -1) })),
      unit,
    );
    const aimOk = canAim();
    const aiming = aimOk && rateMode === 'aim';
    if (aiming) unit = 'pct';
    const multiUnit = d.units.length > 1;
    show(unitSel.el, multiUnit && !aiming);
    show(unitStatic, !multiUnit && !aiming);
    setText(unitStatic, unitLabel(base, unit, d.good ? good : -1));
    show(ratePct.el, unit === 'pct' && !aiming);
    show(rateMoney.el, unit !== 'pct' && !aiming);
    show(aimWord, aiming);
    show(aimRow, aimOk);
    show(aimFields, aiming);
    modeSeg.set(rateMode);
    setText(conn, base === 'head' ? (dir === 1 ? 'from' : 'to') : 'on');

    const frag = (w: HTMLElement) => w.parentElement as HTMLElement;
    show(frag(wGroup), base === 'head');
    show(frag(wGood), d.good);
    const inlineSector = base === 'wage' || base === 'profit' || (base === 'building' && kind === 'firm');
    show(frag(wSector), inlineSector);
    setText(wSector, base === 'profit' ? 'of' : base === 'building' ? 'for' : 'at');
    const secOpts = sectorOptions(base === 'building' ? 'any trade' : base === 'profit' ? 'all firms' : 'any workplace', base === 'profit');
    sectorSel.setOptions(secOpts, sector);
    show(frag(wKind), d.kind);
    show(frag(wTown), d.town);
    setText(wTown, base === 'shipment' ? 'from' : 'in');
    townSel.setOptions(townOptions(s, base === 'shipment' ? 'any town' : 'all towns'), town);
    town = townSel.value;
    show(frag(wTo), d.toTown);
    toSel.setOptions(townOptions(s, 'any town'), toTown);
    toTown = toSel.value;
    show(frag(wPayer), d.payers.length === 2);
    setText(wPayer, dir === 1 ? 'charged to' : 'paid to');
    // sale levies: who they apply to (buyers may be workshops or households; sellers are workshops)
    const isSale = base === 'sale';
    if (isSale) {
      whoSel.setOptions(saleWhoOptions(payer), who);
      who = whoSel.value;
    }
    const targeted = isSale && who !== 'all';
    const whoW = saleWhoWords(who);
    const buyer = payer !== 'seller';
    setText(aimWho, `so that ${whoW || (buyer ? 'buyers' : 'sellers')} ${buyer ? 'pay' : 'receive'} about`);
    setText(aimUnit, `a ${unitOf(good)}, and at most`);
    setText(whoHint, isSale ? whoCount(s, who, town) : '');
    setText(
      explain,
      targeted
        ? `Charged only on what ${whoW} ${buyer ? 'buy' : 'sell'}: ${dir === 1 ? (buyer ? 'they pay the auction price plus the rate' : 'they receive the auction price less the rate') : buyer ? 'they pay the auction price less the rate' : 'they receive the auction price plus the rate'}. Treasury orders are exempt.`
        : d.explain + (d.stock && unit === 'pct' ? ' The rate is per year.' : ''),
    );
    if (aiming) {
      const dr0 = draft(s);
      const rows = dr0.aim && dr0.aim > 0 && dr0.aimMax && dr0.aimMax > 0 ? safe(() => aimedToday(s, dr0), []) : [];
      const parts = rows.map((r) => `${s.towns[r.town]?.name ?? ''} ${fmtPrice(r.price)} → ${r.rate > 0 ? fmtPct(r.rate) : 'none'}`);
      const intro = h('div', null, `Each morning the rate re-sets in each ${dr0.town >= 0 ? 'market' : 'town'} from the day before’s auction price, closing about a third of the gap each day, so the rule does not chase one day’s noise. Where the price is already on your side of the aim, it pays or takes nothing.${dir === -1 ? ' Payments made with newly created money push every price up, and the rates climb with them toward the ceiling you set.' : ''}`);
      if (parts.length) explain.replaceChildren(intro, h('div', { class: 'lv-aim-now' }, 'Going price now → rate it would start at: ', parts.join(' · ')));
      else explain.replaceChildren(intro);
    }

    // conditions
    show(cWho, isSale);
    show(cGroup, d.group && base !== 'head' && !isSale);
    show(cSector, base === 'money' || base === 'goods');
    show(cThr, d.threshold);
    const tm = thresholdMeaning(base, unit);
    setText(thrLab, tm.label);
    setText(thrHint, tm.hint);
    show(thrMoney.el, !tm.qty);
    show(thrQty.el, tm.qty);
    show(endDays.el, ends === 'after');

    // decree + estimate
    const dr = draft(s);
    const sameRoute = base === 'shipment' && dr.town >= 0 && dr.town === dr.toTown;
    const valid = aiming ? fin(dr.aim) > 0 && fin(dr.aimMax) > 0 && aimPrice.valid && aimMax.valid : Number.isFinite(dr.rate) && dr.rate > 0 && !sameRoute;
    const pseudo: Levy = { ...dr, id: 0, created: s.day, today: 0, month: 0, lastMonth: 0, total: 0 };
    let words = valid ? safe(() => describeLevy(s, pseudo), '') : '';
    if (valid && base === 'sale' && saleTargeted(dr.group, dr.sector) && whoW && !words.toLowerCase().includes(whoW)) words = words.replace(/\.$/, '') + ` — only when ${whoW} ${payer === 'seller' ? 'sell' : 'buy'}.`;
    setText(decree, valid ? words : sameRoute ? 'Choose two different towns for the route (or “any town” at one end).' : aiming ? 'Set the price to aim at, and the most the rate may reach.' : 'Set a rate above zero to see the rule in words.');
    const key = JSON.stringify(dr) + '|' + s.day;
    if (key !== estKey) {
      estKey = key;
      est = valid ? safe(() => (aiming ? estimateAimed(s, dr) : estimateLevy(s, dr)), null) : null;
    }
    const B = (x: string, cls = '') => h('b', { class: cls || null }, x);
    if (est && valid) {
      const signed = dir * est.amount;
      estLine.replaceChildren(
        h('span', { class: 'lv-est-base' }, 'Today: ', est.baseText, '.'),
        ' ',
        h(
          'span',
          null,
          est.rough ? 'Roughly ' : 'At that, about ',
          B(signedMoney(signed), signed >= 0 ? 'good' : 'bad'),
          ` a ${est.per} ${signed >= 0 ? 'into' : 'out of'} the Purse`,
          ', before anyone reacts.',
        ),
      );
    } else if (valid) estLine.replaceChildren(h('span', { class: 'faint' }, 'No quick estimate for this flow.'));
    else estLine.replaceChildren();
    enact.disabled = !valid;
  }

  function submit(): void {
    const s = last;
    if (!s) return;
    const dr = draft(s);
    if (dr.aim !== undefined) {
      if (!(fin(dr.aim) > 0)) return msg.err(aimPrice.error ?? 'Set the price to aim at.');
      if (!(fin(dr.aimMax) > 0)) return msg.err(aimMax.error ?? 'Set the most the rate may reach.');
      return void run({ type: 'addLevy', levy: dr }, msg, '✓ Enacted — the rule is listed under In force, with its rate in each town.');
    }
    if (!(dr.rate > 0)) return msg.err((unit === 'pct' ? ratePct.error : rateMoney.error) ?? 'Set a rate above zero.');
    run({ type: 'addLevy', levy: dr }, msg, '✓ Enacted — the rule is listed under In force.');
  }

  syncControls();

  return {
    id: 'levy',
    title: 'Levy',
    tagline: 'Take — or pay — a rate on a flow',
    body,
    summary(s) {
      const on = s.policy.levies.filter((l) => l.enabled);
      if (!on.length) return { text: 'No rules' };
      const net = on.reduce((a, l) => a + fin(l.today), 0);
      return { text: `${plural(on.length, 'rule')} · ${signedMoney(net)} today`, tone: net > 0.005 ? 'good' : net < -0.005 ? 'bad' : null };
    },
    update(s) {
      last = s;
      paint();
    },
    prefill(req: PrefillRequest, s) {
      if (req.lever !== 'levy') return false;
      last = s;
      if (req.good !== undefined) good = req.good;
      if (req.town !== undefined) town = req.town;
      who = 'all';
      setBase(req.base ?? base);
      return true;
    },
    focus() {
      (unit === 'pct' ? ratePct : rateMoney).focus();
    },
    reset() {
      estKey = '';
      est = null;
      last = null;
      town = -1;
      toTown = -1;
      who = 'all';
    },
  };
}
