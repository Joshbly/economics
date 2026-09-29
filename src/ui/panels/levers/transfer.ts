// ============================================================================
// Lever VII — Transfer: a one-off lump sum handed to (or taken from) every
// member of a group, in one town or all; or paid into / out of the Bank's own
// capital. Shows the live recipient count and total; large sums ask first.
// ============================================================================
import { PLAYER_MAX_MONEY } from '../../../sim/config';
import { inGroup } from '../../../sim/policy/levies';
import { STATE, type Group, type SimState, type TransferGroup } from '../../../sim/types';
import { h, setText } from '../../dom';
import { fmtInt, fmtPct } from '../../format';
import { confirmDialog } from '../../modal';
import { numberInput, segmented, selectInput, townOptions } from '../../widgets';
import { chip, fin, fmtM, fmtMS, formEl, formFoot, msgLine, row, run, submitButton, townName, type Lever } from './common';

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
];

interface Tally {
  n: number;
  /** For takes: Σ min(amount, balance) — what would actually be collected. */
  takeable: number;
}

function tally(s: SimState, group: TransferGroup, town: number, amount: number): Tally {
  if (group === 'bank') return { n: 1, takeable: Math.min(amount, Math.max(0, fin(s.bank?.equity))) };
  let n = 0;
  let takeable = 0;
  if (group === 'firms') {
    for (const f of s.firms) {
      if (!f || !f.alive || f.status !== 'active' || f.sector === 'stateworks' || f.owner === STATE) continue;
      if (town >= 0 && f.town !== town) continue;
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

export function transferLever(): Lever {
  let dir: 1 | -1 = 1;
  let group: TransferGroup = 'unemployed';
  let town = -1;
  let last: SimState | null = null;
  let key = '';
  let t: Tally = { n: 0, takeable: 0 };
  const msg = msgLine();
  const changed = () => {
    msg.clear();
    paint();
  };

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

  const vCount = h('span', { class: 'lv-big' });
  const vCountL = h('span', { class: 'lv-big-l' });
  const vTotal = h('span', { class: 'lv-big' });
  const vTotalL = h('span', { class: 'lv-big-l' });
  const vEach = h('span', { class: 'lv-big' });
  const vEachL = h('span', { class: 'lv-big-l' }, 'each');
  const tallyBox = h(
    'div',
    { class: 'lv-tally' },
    h('div', null, vCount, vCountL),
    h('div', { class: 'lv-tally-x' }, '×'),
    h('div', null, vEach, vEachL),
    h('div', { class: 'lv-tally-x' }, '='),
    h('div', null, vTotal, vTotalL),
  );

  const preview = h('div', { class: 'lv-preview' });
  const go = submitButton('Give now');
  const amountLab = h('span', null, 'Each');
  const form = formEl(
    () => void submit(),
    row('Direction', dirSeg.el),
    row(amountLab, amount.el, amountChips),
    row('To', groupSel.el),
    row('Where', townSel.el),
    tallyBox,
    formFoot(preview, msg, go),
  );
  const body = h('div', { class: 'lv-body-in' }, form);

  function paint(): void {
    const s = last;
    if (!s) return;
    townSel.setOptions(townOptions(s, 'All towns'), town);
    town = townSel.value;
    townSel.setDisabled(group === 'bank');
    const a = amount.value;
    const k = `${group}:${town}:${a}:${s.day}`;
    if (k !== key) {
      key = k;
      t = Number.isFinite(a) && a > 0 ? tally(s, group, group === 'bank' ? -1 : town, a) : tally(s, group, group === 'bank' ? -1 : town, 0);
    }
    const g = GROUPS.find((x) => x.value === group) ?? GROUPS[0];
    const where = group !== 'bank' && town >= 0 ? ` in ${townName(s, town)}` : '';
    const purse = fin(s.treasury.purse);
    const total = dir === 1 ? (Number.isFinite(a) ? a * t.n : NaN) : t.takeable;
    setText(amountLab, group === 'bank' ? 'Amount' : 'Each');
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

  async function submit(): Promise<void> {
    const s = last;
    if (!s) return;
    const a = amount.value;
    if (!(a > 0)) return msg.err(amount.error ?? 'Set an amount.');
    const g = GROUPS.find((x) => x.value === group) ?? GROUPS[0];
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
    run({ type: 'transfer', group, town: group === 'bank' ? -1 : town, amount: a, dir }, msg, dir === 1 ? '✓ Paid out.' : '✓ Collected.');
    key = '';
  }

  return {
    id: 'transfer',
    title: 'Transfer',
    tagline: 'A one-off sum to or from a group',
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
    focus: () => amount.focus(),
    reset() {
      key = '';
      last = null;
      town = -1;
    },
  };
}
