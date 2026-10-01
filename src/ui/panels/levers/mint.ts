// ============================================================================
// Lever I — Mint: create money in the Purse, or destroy what it holds.
// Also home of the auto-mint setting and the "Purse is empty" warning.
// ============================================================================
import { PLAYER_MAX_MONEY } from '../../../sim/config';
import type { SimState } from '../../../sim/types';
import { h, setText, show, toggleClass } from '../../dom';
import { fmtPct } from '../../format';
import { button, icon, numberInput, toggle } from '../../widgets';
import { banner, chip, fin, fmtM, fmtMS, formEl, formFoot, hint, msgLine, row, run, submitButton, type Lever } from './common';

export function mintLever(): Lever {
  const msg = msgLine();
  const amount = numberInput({ value: 10000, prefix: '¤', min: 0.01, max: PLAYER_MAX_MONEY, width: '150px', placeholder: 'e.g. 25k', title: 'Accepts k / M suffixes: 25k, 1.5M', onChange: () => paint() });
  const chips = h(
    'div',
    { class: 'lv-chips' },
    [1e3, 1e4, 1e5, 1e6].map((v) => chip(fmtMS(v), () => (amount.set(v), paint()))),
  );
  const create = submitButton('Create', 'Add this much new money to the Purse (Enter)');
  const destroy = button({ label: 'Destroy', kind: 'secondary', title: 'Remove this much money from the Purse; it ceases to exist', onClick: () => doBurn() });
  const preview = h('div', { class: 'lv-preview' });

  // stat row
  const vPurse = h('span', { class: 'lv-kv-v gold' });
  const vMinted = h('span', { class: 'lv-kv-v' });
  const vBurned = h('span', { class: 'lv-kv-v' });
  const vMoney = h('span', { class: 'lv-kv-v' });
  const stats = h(
    'div',
    { class: 'lv-kv4' },
    h('div', null, h('span', { class: 'lv-kv-l' }, 'Purse'), vPurse),
    h('div', null, h('span', { class: 'lv-kv-l' }, 'Created'), vMinted),
    h('div', null, h('span', { class: 'lv-kv-l' }, 'Destroyed'), vBurned),
    h('div', null, h('span', { class: 'lv-kv-l', title: 'All bank balances of people and firms' }, 'All money'), vMoney),
  );

  // auto-mint
  const auto = toggle({ value: false, label: 'Auto-mint', onChange: (v) => run({ type: 'setAutoMint', value: v }, null) });
  const autoHint = hint();
  const autoBox = h('div', { class: 'lv-setting' }, auto.el, autoHint);

  // warning when promised payments are on hold
  const warnText = h('span');
  const warnBtn = button({ label: 'Turn on auto-mint', kind: 'secondary', size: 'sm', onClick: () => run({ type: 'setAutoMint', value: true }, null) });
  const warn = banner('warn', icon('warning', 16), h('div', { class: 'lv-banner-body' }, h('b', null, 'The Purse is empty. '), warnText, h('div', { class: 'lv-banner-act' }, warnBtn)));

  const form = formEl(
    () => doMint(),
    row('Amount', amount.el, chips),
    formFoot(preview, msg, destroy, create),
  );

  const body = h('div', { class: 'lv-body-in' }, warn, stats, form, autoBox);

  function doMint(): void {
    const v = amount.value;
    if (!(v > 0)) return msg.err(amount.error ?? 'Enter an amount to create.');
    run({ type: 'mint', amount: v }, msg, `✓ Created ${fmtM(v)}.`);
  }
  function doBurn(): void {
    const v = amount.value;
    if (!(v > 0)) return msg.err(amount.error ?? 'Enter an amount to destroy.');
    run({ type: 'burn', amount: v }, msg, '✓ Destroyed.');
  }

  let last: SimState | null = null;
  function paint(): void {
    if (!last) return;
    const s = last;
    const t = s.treasury;
    const money = fin(s.stats?.latest?.money);
    const v = amount.value;
    if (v > 0) {
      const share = money > 0 ? v / money : NaN;
      preview.replaceChildren(
        'Create adds ',
        h('b', null, fmtM(v)),
        Number.isFinite(share) ? h('span', null, ' (', h('b', null, fmtPct(share)), ' of all money held)') : '',
        '. Destroy removes up to ',
        h('b', null, fmtM(Math.min(v, Math.max(0, fin(t.purse))))),
        '.',
      );
    } else preview.replaceChildren('Type an amount — 25k or 1.5M work too.');
    create.disabled = !(v > 0);
    destroy.disabled = !(v > 0) || !(fin(t.purse) > 0);
  }

  return {
    id: 'mint',
    title: 'Mint',
    tagline: 'Create money, or destroy it',
    body,
    summary(s) {
      const t = s.treasury;
      if (t.givesSuspended) return { text: 'Purse empty', tone: 'bad' };
      return { text: 'Purse ' + fmtMS(fin(t.purse)) + (t.autoMint ? ' · auto' : ''), tone: fin(t.purse) < 0 ? 'bad' : 'gold' };
    },
    update(s) {
      last = s;
      const t = s.treasury;
      setText(vPurse, fmtM(fin(t.purse)));
      toggleClass(vPurse, 'bad', fin(t.purse) < 0 || !!t.givesSuspended);
      setText(vMinted, fmtM(fin(t.minted)));
      setText(vBurned, fmtM(fin(t.burned)));
      setText(vMoney, fmtM(fin(s.stats?.latest?.money)));
      auto.set(!!t.autoMint);
      setText(
        autoHint,
        t.autoMint
          ? 'On: whenever the Treasury owes more than the Purse holds — wages of its workers, purchases, payments it promised — the difference is created on the spot. The Purse never runs dry.'
          : 'Off: the Treasury pays only from what the Purse holds. When it is empty, payments it has promised (pay-levies, transfers) wait and purchases shrink until money comes in.',
      );
      show(warn, !!t.givesSuspended);
      setText(warnText, 'Every payment the Treasury has promised is on hold until money comes in. Create some, collect some, or let the Treasury create what it owes.');
      paint();
    },
    focus: () => amount.focus(),
  };
}
