// ============================================================================
// Lever VII — Transfer: a one-off lump sum handed to (or taken from) every
// member of a group, in one town or all; or paid into / out of the Bank's own
// capital. Shows the live recipient count and total; large sums ask first.
//
// In kind ("Goods"): hand out units of a good the Treasury holds in a town to
// every member of a group there — people (into their pantries) or workshops,
// optionally of one trade (into their stores). The tally compares the units
// needed with the units held.
// ============================================================================
import { PLAYER_MAX_MONEY, PLAYER_MAX_QTY } from '../../../sim/config';
import { G, GOODS, N_GOODS, SECTORS } from '../../../sim/goods';
import { inGroup } from '../../../sim/policy/levies';
import { STATE, type Group, type PlayerAction, type Sector, type SimState, type TransferGroup } from '../../../sim/types';
import { h, setText, show } from '../../dom';
import { fmtInt, fmtPct } from '../../format';
import { confirmDialog } from '../../modal';
import { numberInput, segmented, selectInput, townOptions, type Option } from '../../widgets';
import { chip, dynRow, fin, fmtM, fmtMS, fmtQ, formEl, formFoot, goodName, hint, msgLine, row, run, setNumUnit, submitButton, townName, unitOf, unitsOf, type Lever } from './common';
import { tradePlural } from './levyDefs';

type Mode = 'money' | 'goods';

const GROUPS: { value: TransferGroup; label: string; noun: string }[] = [
  { value: 'all', label: 'Everyone', noun: 'people' },
  { value: 'employed', label: 'People in work', noun: 'people in work' },
  { value: 'unemployed', label: 'People without work', noun: 'people without work' },
  { value: 'homeless', label: 'People without a home', noun: 'people without a home' },
  { value: 'owners', label: 'Property owners', noun: 'property owners' },
  { value: 'nonowners', label: 'People owning no property', noun: 'people who own no property' },
  { value: 'hungry', label: 'Hungry people', noun: 'hungry people' },
  { value: 'firms', label: 'Firms', noun: 'firms' },
  { value: 'bank', label: 'The Bank’s own capital', noun: 'the Bank' },
  { value: 'councils', label: 'Town councils', noun: 'town councils' },
];

/** Groups that can receive goods: people (their pantry) or workshops (their stores). */
const GOODS_GROUPS: { value: TransferGroup; label: string }[] = [
  ...GROUPS.filter((g) => g.value !== 'firms' && g.value !== 'bank' && g.value !== 'councils').map((g) => ({ value: g.value, label: g.label })),
  { value: 'firms', label: 'Workshops' },
];

const TRADES = (Object.keys(SECTORS) as Sector[]).filter((k) => k !== 'stateworks');

interface Tally {
  n: number;
  /** For takes: Σ min(amount, balance) — what would actually be collected. */
  takeable: number;
}

function tally(s: SimState, group: TransferGroup, town: number, amount: number, sector: Sector | 'any' = 'any'): Tally {
  if (group === 'bank') return { n: 1, takeable: Math.min(amount, Math.max(0, fin(s.bank?.equity))) };
  if (group === 'councils') {
    let n = 0;
    let takeable = 0;
    for (const tw of s.towns) {
      if (town >= 0 && tw.id !== town) continue;
      n++;
      takeable += Math.min(amount, Math.max(0, fin(tw.council?.purse ?? 0)));
    }
    return { n, takeable };
  }
  let n = 0;
  let takeable = 0;
  if (group === 'firms') {
    for (const f of s.firms) {
      if (!f || !f.alive || f.status !== 'active' || f.sector === 'stateworks' || f.owner === STATE) continue;
      if (town >= 0 && f.town !== town) continue;
      if (sector !== 'any' && f.sector !== sector) continue;
      n++;
      takeable += Math.min(amount, Math.max(0, fin(f.cash)));
    }
    return { n, takeable };
  }
  for (const p of s.people) {
    if (!p || !p.alive) continue;
    if (town >= 0 && p.town !== town) continue;
    if (!inGroup(s, p, group as Group)) continue;
    n++;
    takeable += Math.min(amount, Math.max(0, fin(p.cash)));
  }
  return { n, takeable };
}

/** The town holding the most of a good (or −1). */
function bestTown(s: SimState, g: number): number {
  let best = -1;
  let q = 0.005;
  for (let t = 0; t < s.towns.length; t++) {
    const v = fin(s.treasury.goods[t]?.[g]);
    if (v > q) {
      q = v;
      best = t;
    }
  }
  return best;
}

export function transferLever(): Lever {
  let mode: Mode = 'money';
  let dir: 1 | -1 = 1;
  let group: TransferGroup = 'unemployed';
  let town = -1;
  // goods mode
  let good = 8;
  let gTown = 0;
  let gGroup: TransferGroup = 'unemployed';
  let sector: Sector | 'any' = 'any';
  let last: SimState | null = null;
  let key = '';
  let optSig = '';
  let t: Tally = { n: 0, takeable: 0 };
  const msg = msgLine();
  const changed = () => {
    msg.clear();
    paint();
  };

  const modeSeg = segmented<Mode>({
    options: [
      { value: 'money', label: 'Money', title: 'A sum of ¤ to (or from) each member of a group' },
      { value: 'goods', label: 'Goods', title: 'Hand out goods the Treasury holds in a town' },
    ],
    value: mode,
    onChange: (v) => {
      mode = v;
      key = '';
      if (mode === 'goods' && last) {
        const b = bestTown(last, good);
        if (b >= 0 && !(fin(last.treasury.goods[gTown]?.[good]) > 0.005)) gTown = b;
      }
      changed();
    },
  });
  const dirSeg = segmented<1 | -1>({
    options: [
      { value: 1, label: 'Give', title: 'Pay the sum to each recipient, from the Purse' },
      { value: -1, label: 'Take', title: 'Collect up to the sum from each, into the Purse' },
    ],
    value: dir,
    onChange: (v) => ((dir = v), changed()),
  });
  const amount = numberInput({ value: 20, prefix: '¤', min: 0.01, max: PLAYER_MAX_MONEY, width: '130px', onChange: changed });
  const amountChips = h('div', { class: 'lv-chips' }, [5, 20, 100, 500].map((v) => chip(fmtM(v).replace('.00', ''), () => (amount.set(v), paint()))));
  const groupSel = selectInput<TransferGroup>({ options: GROUPS.map((g) => ({ value: g.value, label: g.label })), value: group, onChange: (v) => ((group = v), changed()) });
  const townSel = selectInput<number>({ options: [{ value: -1, label: 'All towns' }], value: town, onChange: (v) => ((town = v), changed()) });

  // goods mode controls
  const goodSel = selectInput<number>({ options: [{ value: good, label: '—' }], value: good, onChange: (v) => pickGood(v) });
  const gTownSel = selectInput<number>({ options: [{ value: 0, label: '—' }], value: gTown, onChange: (v) => ((gTown = v), changed()) });
  const units = numberInput({ value: 2, min: 0, max: PLAYER_MAX_QTY, unit: 'loaves', width: '130px', onChange: changed, title: 'Units handed to each recipient' });
  const unitChips = h('div', { class: 'lv-chips' }, [1, 2, 5, 10, 25].map((v) => chip(String(v), () => (units.set(v), paint()))), chip('Share all', () => shareAll(), 'Divide everything held there equally'));
  const gGroupSel = selectInput<TransferGroup>({ options: GOODS_GROUPS, value: gGroup, onChange: (v) => ((gGroup = v), changed()) });
  const tradeSel = selectInput<Sector | 'any'>({
    options: [{ value: 'any', label: 'Any trade' }, ...TRADES.map((k) => ({ value: k, label: SECTORS[k].name, group: SECTORS[k].producer ? 'Makes goods' : 'Services' }))],
    value: sector,
    onChange: (v) => ((sector = v), changed()),
  });
  const heldHint = hint();

  const vCount = h('span', { class: 'lv-big' });
  const vCountL = h('span', { class: 'lv-big-l' });
  const vTotal = h('span', { class: 'lv-big' });
  const vTotalL = h('span', { class: 'lv-big-l' });
  const vEach = h('span', { class: 'lv-big' });
  const vEachL = h('span', { class: 'lv-big-l' }, 'each');
  const heldBar = h('i');
  const heldTrack = h('span', { class: 'lv-tally-held' }, heldBar);
  const tallyBox = h(
    'div',
    { class: 'lv-tally' },
    h('div', null, vCount, vCountL),
    h('div', { class: 'lv-tally-x' }, '×'),
    h('div', null, vEach, vEachL),
    h('div', { class: 'lv-tally-x' }, '='),
    h('div', null, vTotal, vTotalL),
    heldTrack,
  );

  const preview = h('div', { class: 'lv-preview' });
  const go = submitButton('Give now');
  const amountRow = dynRow('Each', amount.el, amountChips, units.el, unitChips);
  const dirRow = row('Direction', dirSeg.el);
  const goodsRow = row('Goods', goodSel.el);
  const heldRow = row('From stores in', gTownSel.el, heldHint);
  const toRow = row('To', groupSel.el);
  const handRow = row('Hand to', gGroupSel.el);
  const tradeRow = row('Trade', tradeSel.el);
  const whereRow = row('Where', townSel.el);
  const form = formEl(() => void submit(), row('Hand out', modeSeg.el), dirRow, goodsRow, heldRow, amountRow.el, toRow, handRow, tradeRow, whereRow, tallyBox, formFoot(preview, msg, go));
  const body = h('div', { class: 'lv-body-in' }, form);

  function pickGood(v: number): void {
    good = v;
    const s = last;
    if (s && !(fin(s.treasury.goods[gTown]?.[good]) > 0.005)) {
      const b = bestTown(s, good);
      if (b >= 0) gTown = b;
    }
    changed();
  }

  function shareAll(): void {
    const s = last;
    if (!s) return;
    const held = fin(s.treasury.goods[gTown]?.[good]);
    const n = tally(s, gGroup, gTown, 0, gGroup === 'firms' ? sector : 'any').n;
    if (n > 0 && held > 0) units.set(Math.floor((held / n) * 100) / 100);
    paint();
  }

  /** Good and town pickers list what the Treasury holds (held goods first). */
  function syncGoodsOptions(s: SimState): void {
    const tg = s.treasury.goods;
    let sig = '';
    const total: number[] = [];
    for (let g = 0; g < N_GOODS; g++) {
      let q = 0;
      for (let k = 0; k < s.towns.length; k++) q += fin(tg[k]?.[g]);
      total.push(q);
      sig += Math.round(q * 10) + ',';
    }
    for (let k = 0; k < s.towns.length; k++) sig += Math.round(fin(tg[k]?.[good]) * 10) + ';';
    sig += good;
    if (sig === optSig) return;
    optSig = sig;
    const held: Option<number>[] = [];
    const none: Option<number>[] = [];
    for (let g = 0; g < N_GOODS; g++) {
      const name = GOODS[g].name;
      if (total[g] > 0.005) held.push({ value: g, label: `${name} — ${fmtQ(total[g])} held`, group: 'Held by the Treasury' });
      else none.push({ value: g, label: name, group: 'None held' });
    }
    goodSel.setOptions([...held, ...none], good);
    good = goodSel.value;
    gTownSel.setOptions(
      s.towns.map((x) => {
        const q = fin(tg[x.id]?.[good]);
        return { value: x.id, label: q > 0.005 ? `${x.name} · ${fmtQ(q)}` : x.name };
      }),
      gTown,
    );
    gTown = gTownSel.value;
  }

  function paint(): void {
    const s = last;
    if (!s) return;
    const goods = mode === 'goods';
    show(dirRow, !goods);
    show(goodsRow, goods);
    show(heldRow, goods);
    show(toRow, !goods);
    show(handRow, goods);
    show(tradeRow, goods ? gGroup === 'firms' : group === 'firms');
    show(whereRow, !goods);
    show(amount.el, !goods);
    show(amountChips, !goods);
    show(units.el, goods);
    show(unitChips, goods);
    show(heldTrack, goods);
    if (goods) return paintGoods(s);

    townSel.setOptions(townOptions(s, 'All towns'), town);
    town = townSel.value;
    townSel.setDisabled(group === 'bank');
    const a = amount.value;
    const msec = group === 'firms' ? sector : 'any';
    const k = `m:${group}:${msec}:${town}:${a}:${s.day}`;
    if (k !== key) {
      key = k;
      t = tally(s, group, group === 'bank' ? -1 : town, Number.isFinite(a) && a > 0 ? a : 0, msec);
    }
    const g0 = GROUPS.find((x) => x.value === group) ?? GROUPS[0];
    const g = group === 'firms' && sector !== 'any' ? { ...g0, noun: tradePlural(sector) } : g0;
    const where = group !== 'bank' && town >= 0 ? ` in ${townName(s, town)}` : '';
    const purse = fin(s.treasury.purse);
    const total = dir === 1 ? (Number.isFinite(a) ? a * t.n : NaN) : t.takeable;
    setText(amountRow.lab, group === 'bank' ? 'Amount' : 'Each');
    setText(vCount, group === 'bank' ? '1' : fmtInt(t.n));
    setText(vCountL, group === 'bank' ? 'the Bank' : t.n === 1 ? 'recipient' : 'recipients');
    const short = (x: number) => (Math.abs(x) >= 1000 ? fmtMS(x) : fmtM(x));
    setText(vTotal, short(total));
    vTotal.title = fmtM(total);
    setText(vEach, Number.isFinite(a) ? short(a) : '—');
    setText(vEachL, dir === 1 ? 'each' : 'at most each');
    setText(vTotalL, dir === 1 ? 'from the Purse' : 'into the Purse');
    const B = (x: string, cls?: string) => h('b', { class: cls ?? null }, x);
    const bits: (string | Node)[] = [];
    if (!(a > 0)) bits.push('Set an amount.');
    else if (t.n === 0) bits.push(`Nobody matches: there are no ${g.noun}${where}.`);
    else if (group === 'bank') {
      bits.push(dir === 1 ? 'Pays ' : 'Takes ', B(fmtM(dir === 1 ? a : t.takeable)), dir === 1 ? ' into the Bank’s own capital (its buffer against bad loans).' : ' out of the Bank’s own capital.');
    } else if (group === 'councils' && dir === 1) {
      bits.push('Pays ', B(fmtM(total)), ' in all into the purse of ', B(t.n === 1 ? 'the town council' : `each of the ${fmtInt(t.n)} town councils`), where, '. Each council spends it as its mayor sees fit: roads for its town’s trade, houses to let when people have no roof, empty buildings bought for their plots.');
      if (!s.treasury.autoMint && total > purse) bits.push(h('span', { class: 'warn' }, ` The Purse holds only ${fmtM(purse)}.`));
    } else if (dir === 1) {
      bits.push('Hands ', B(fmtM(total)), ' in all to ', B(`${fmtInt(t.n)} ${g.noun}`), where, ', paid from the Purse.');
      if (!s.treasury.autoMint && total > purse) {
        const each = t.n > 0 ? Math.max(0, purse) / t.n : 0;
        bits.push(h('span', { class: 'warn' }, ` The Purse holds only ${fmtM(purse)}, so each would get ${fmtM(each)}.`));
      } else if (s.treasury.autoMint && total > purse) bits.push(h('span', { class: 'muted' }, ` Auto-mint will create the ${fmtM(total - Math.max(0, purse))} the Purse lacks.`));
    } else {
      bits.push('Collects about ', B(fmtM(t.takeable)), ' from ', B(`${fmtInt(t.n)} ${g.noun}`), where, '; those holding less than ', fmtM(a), ' give what they have.');
    }
    preview.replaceChildren(...bits);
    setText(go, dir === 1 ? 'Give now' : 'Take now');
    // a Purse under half a penny is empty (dust left after a capped payout)
    const empty = dir === 1 && !s.treasury.autoMint && !(purse >= 0.005);
    go.disabled = !(a > 0) || t.n === 0 || empty;
    if (empty && a > 0 && t.n > 0) preview.append(h('span', { class: 'bad' }, ' The Purse is empty.'));
  }

  function goodsNoun(n: number): string {
    if (gGroup === 'firms') return sector === 'any' ? (n === 1 ? 'workshop' : 'workshops') : n === 1 ? (SECTORS[sector]?.name ?? 'workshop').toLowerCase() : tradePlural(sector);
    return (GROUPS.find((x) => x.value === gGroup) ?? GROUPS[0]).noun;
  }

  function paintGoods(s: SimState): void {
    syncGoodsOptions(s);
    const u = unitsOf(good);
    setNumUnit(units, u);
    setText(amountRow.lab, 'Each');
    const held = fin(s.treasury.goods[gTown]?.[good]);
    const each = units.value;
    const sec = gGroup === 'firms' ? sector : 'any';
    const k = `g:${gGroup}:${sec}:${gTown}:${s.day}`;
    if (k !== key) {
      key = k;
      t = tally(s, gGroup, gTown, 0, sec);
    }
    const need = Number.isFinite(each) && each > 0 ? each * t.n : NaN;
    const forFirms = !GOODS[good]?.consumer ? ' Only workshops can use it.' : '';
    setText(heldHint, held > 0.005 ? `${fmtQ(held)} ${u} held there.${forFirms}` : `None held in ${townName(s, gTown)} — buy some there with Trade, or carry some in.${forFirms}`);
    heldHint.classList.toggle('warn', !(held > 0.005));
    setText(vCount, fmtInt(t.n));
    setText(vCountL, t.n === 1 ? 'recipient' : 'recipients');
    setText(vEach, Number.isFinite(each) ? fmtQ(each) : '—');
    setText(vEachL, `${each === 1 ? unitOf(good) : u} each`);
    setText(vTotal, Number.isFinite(need) ? fmtQ(need) : '—');
    vTotal.title = Number.isFinite(need) ? `${fmtQ(need)} ${u}` : '';
    setText(vTotalL, `of ${fmtQ(held)} held`);
    const f = held > 0 && Number.isFinite(need) ? Math.min(1, need / held) : 0;
    heldBar.style.width = (f * 100).toFixed(1) + '%';
    heldTrack.classList.toggle('over', Number.isFinite(need) && need > held + 1e-9);
    heldTrack.title = Number.isFinite(need) && held > 0 ? `${fmtPct(Math.min(9.99, need / held))} of what is held there` : '';

    const B = (x: string, cls?: string) => h('b', { class: cls ?? null }, x);
    const bits: (string | Node)[] = [];
    const who = goodsNoun(t.n);
    const where = ` in ${townName(s, gTown)}`;
    const noUse = gGroup !== 'firms' && !GOODS[good]?.consumer;
    if (!(held > 0.005)) bits.push(`Nothing to hand out: no ${goodName(good).toLowerCase()} is held${where}.`);
    else if (noUse) bits.push(h('span', { class: 'warn' }, `People have no use for ${goodName(good).toLowerCase()} at home — hand it to workshops instead.`));
    else if (!(each > 0)) bits.push('Set how many each recipient gets.');
    else if (t.n === 0) bits.push(`Nobody matches: there are no ${who}${where}.`);
    else {
      const into = gGroup === 'firms' ? 'into their stores' : 'into their pantries';
      if (need <= held + 1e-9) bits.push('Hands ', B(`${fmtQ(each)} ${each === 1 ? unitOf(good) : u}`), ' to each of ', B(`${fmtInt(t.n)} ${who}`), where, ` (${fmtQ(need)} of the ${fmtQ(held)} held), ${into}.`);
      else bits.push('Hands out all ', B(`${fmtQ(held)} ${u}`), ' held', where, ' to ', B(`${fmtInt(t.n)} ${who}`), ` — `, h('span', { class: 'warn' }, `${fmtQ(held / t.n)} each, not ${fmtQ(each)}`), `, ${into}.`);
      if (gGroup === 'firms' && good === G.tools) bits.push(' Tools join each workshop’s tool stock.');
      const p = s.markets[gTown * N_GOODS + good]?.price;
      if (fin(p) > 0) bits.push(h('span', { class: 'muted' }, ` Worth ≈ ${fmtM(Math.min(need, held) * fin(p))} at today’s price there.`));
    }
    preview.replaceChildren(...bits);
    setText(go, 'Hand out');
    go.disabled = !(held > 0.005) || !(each > 0) || t.n === 0 || noUse;
  }

  async function submit(): Promise<void> {
    const s = last;
    if (!s) return;
    if (mode === 'goods') return submitGoods(s);
    const a = amount.value;
    if (!(a > 0)) return msg.err(amount.error ?? 'Set an amount.');
    const g0 = GROUPS.find((x) => x.value === group) ?? GROUPS[0];
    const g = group === 'firms' && sector !== 'any' ? { ...g0, noun: tradePlural(sector) } : g0;
    const money = fin(s.stats?.latest?.money);
    const purse = fin(s.treasury.purse);
    const want = dir === 1 ? a * t.n : t.takeable;
    if (dir === 1 && !s.treasury.autoMint && !(purse >= 0.005)) return msg.err('The Purse is empty. Create money with Mint, or switch on auto-mint.');
    // what would actually move: without auto-mint a payout is capped by the Purse
    const capped = dir === 1 && !s.treasury.autoMint && want > Math.max(0, purse);
    const total = capped ? Math.max(0, purse) : want;
    const large = total >= 10000 || (dir === 1 && purse > 0 && total > 0.5 * purse) || (money > 0 && total > 0.02 * money);
    if (large) {
      const where = group !== 'bank' && town >= 0 ? ` in ${townName(s, town)}` : '';
      const share =
        (capped && t.n > 0 ? ` The Purse holds only ${fmtM(purse)}, so each would get ${fmtM(total / t.n)} and the Purse would be emptied.` : '') +
        (money > 0 ? ` That is ${fmtPct(total / money)} of all the money people and firms hold.` : '');
      const ok = await confirmDialog({
        title: dir === 1 ? `Hand out ${fmtM(total)}?` : `Collect ${fmtM(total)}?`,
        message:
          (group === 'bank'
            ? `${dir === 1 ? 'Pay' : 'Take'} ${fmtM(a)} ${dir === 1 ? 'into' : 'out of'} the Bank’s own capital.`
            : `${dir === 1 ? 'Give' : 'Take up to'} ${fmtM(a)} ${dir === 1 ? 'to' : 'from'} each of ${fmtInt(t.n)} ${g.noun}${where}.`) + share,
        confirm: dir === 1 ? 'Hand it out' : 'Collect it',
        danger: dir === -1,
      });
      if (!ok) return;
    }
    const act: Extract<PlayerAction, { type: 'transfer' }> = { type: 'transfer', group, town: group === 'bank' ? -1 : town, amount: a, dir };
    if (group === 'firms' && sector !== 'any') act.sector = sector;
    run(act, msg, dir === 1 ? '✓ Paid out.' : '✓ Collected.');
    key = '';
  }

  function submitGoods(s: SimState): void {
    const each = units.value;
    if (!(each > 0)) return msg.err(units.error ?? 'Set how many each recipient gets.');
    const held = fin(s.treasury.goods[gTown]?.[good]);
    if (!(held > 0.005)) return msg.err(`The Treasury holds no ${goodName(good).toLowerCase()} in ${townName(s, gTown)}.`);
    const a: Extract<PlayerAction, { type: 'transfer' }> = { type: 'transfer', group: gGroup, town: gTown, amount: each, dir: 1, good };
    if (gGroup === 'firms' && sector !== 'any') a.sector = sector;
    run(a, msg, '✓ Handed out.');
    key = '';
    optSig = '';
  }

  return {
    id: 'transfer',
    title: 'Transfer',
    tagline: 'One-off sums or goods to a group',
    body,
    summary(s) {
      const L = s.stats?.latest ?? {};
      const g = fin(L.transferGive);
      const tk = fin(L.transferTake);
      if (g > 0.005) return { text: `${fmtM(g)} handed out`, tone: 'bad' };
      if (tk > 0.005) return { text: `${fmtM(tk)} collected`, tone: 'good' };
      return { text: 'One-off sums' };
    },
    update(s) {
      last = s;
      paint();
    },
    focus: () => (mode === 'goods' ? units.focus() : amount.focus()),
    prefill(req) {
      if (req.lever !== 'transfer') return false;
      mode = 'money';
      modeSeg.set(mode);
      if (req.group && GROUPS.some((g) => g.value === req.group)) {
        group = req.group;
        groupSel.set(group);
      }
      if (req.town !== undefined) town = req.town;
      dir = 1;
      dirSeg.set(dir);
      key = '';
      changed();
      return true;
    },
    reset() {
      key = '';
      optSig = '';
      last = null;
      town = -1;
      gTown = 0;
    },
  };
}
