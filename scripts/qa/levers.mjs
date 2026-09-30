// End-to-end check of every lever form in the built game.
//   node scripts/qa/levers.mjs   (needs a fresh `npm run build`)
import { open, report } from './lib.mjs';

const q = await open({});
await q.ready();
const { page } = q;
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) fails.push(name);
};
const L = (id) => `.lv-item[data-lever="${id}"] .lv-body`;
async function num(scope, label, v) {
  const row = page.locator(`${scope} .lv-row`).filter({ has: page.locator(`.lv-lab:text-is("${label}")`) }).first();
  const inp = row.locator('input.num-field').first();
  await inp.fill(String(v));
  await inp.press('Tab');
}
const seg = (scope, text) => page.locator(`${scope} .seg-btn:text-is("${text}")`).first().click();
async function selRow(scope, label, value, nth = 0) {
  const row = page.locator(`${scope} .lv-row`).filter({ has: page.locator(`.lv-lab:text-is("${label}")`) }).first();
  await row.locator('select').nth(nth).selectOption(String(value));
}
let modalShots = 0;
const submit = async (scope) => {
  await page.locator(`${scope} .lv-submit`).first().click();
  await page.waitForTimeout(300);
  if (await page.$('.modal-backdrop.on')) {
    if (modalShots++ < 2) await q.shot('lv-confirm-' + modalShots);
    console.log('   [modal]', (await page.locator('.modal-backdrop.on .modal').textContent()).slice(0, 200));
    await page.locator('.modal-backdrop.on .btn-primary, .modal-backdrop.on .btn-danger').last().click();
    await page.waitForTimeout(300);
  }
};
const msg = (scope) => page.locator(`${scope} .lv-msg`).first().textContent().catch(() => '');
const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()));

await q.s(`R.setSpeed(0)`);
const topPurse = () => page.locator('.ind[aria-label="The Purse"] .ind-val').textContent();

// ---------------- Mint ----------------
{
  await q.lever('mint');
  const p0 = await q.s('s.treasury.purse');
  await num(L('mint'), 'Amount', '25k');
  await submit(L('mint'));
  const p1 = await q.s('s.treasury.purse');
  check('mint create 25k', Math.abs(p1 - p0 - 25000) < 0.01, `${p0.toFixed(2)} -> ${p1.toFixed(2)}`);
  await page.waitForTimeout(400);
  {
    // Compare the top bar's figure (e.g. "¤37.0k", "¤4,094") with the live Purse.
    const txt = await topPurse();
    const m = /([\d.,]+)\s*([kM]?)/.exec(txt.replace(/\u2212/g, '-'));
    const val = m ? parseFloat(m[1].replace(/,/g, '')) * (m[2] === 'k' ? 1e3 : m[2] === 'M' ? 1e6 : 1) : NaN;
    check('top bar purse follows mint while paused', Number.isFinite(val) && Math.abs(val - p1) <= Math.max(1, 0.01 * p1), `${txt} vs ${p1.toFixed(2)}`);
  }
  await num(L('mint'), 'Amount', '5000');
  await page.locator(`${L('mint')} button:text-is("Destroy")`).click();
  await page.waitForTimeout(300);
  const p2 = await q.s('s.treasury.purse');
  check('mint destroy 5000', Math.abs(p1 - p2 - 5000) < 0.01, `${p1.toFixed(2)} -> ${p2.toFixed(2)}`);
  // auto-mint switch
  await page.locator(`${L('mint')} button.switch`).first().click();
  await page.waitForTimeout(200);
  check('auto-mint on', await q.s('s.treasury.autoMint'));
  await page.locator(`${L('mint')} button.switch`).first().click();
  await page.waitForTimeout(200);
  check('auto-mint off', !(await q.s('s.treasury.autoMint')));
  await q.shot('lv-mint');
}

// ---------------- Trade ----------------
{
  await q.lever('trade');
  const T = L('trade');
  const n0 = await q.s('s.policy.orders.length');
  // goods buy, until cancelled
  await selRow(T, 'Market', 1, 0);
  await selRow(T, 'Market', 0, 1);
  await seg(T, 'Buy');
  await num(T, 'Per day', 20);
  await submit(T);
  let o = await q.s('s.policy.orders.at(-1)');
  check('trade goods buy grain Milldale', (await q.s('s.policy.orders.length')) === n0 + 1 && o.side === 'buy' && o.market.kind === 'good' && o.market.good === 0 && o.market.town === 1, JSON.stringify(o).slice(0, 200));
  // sell N days
  await seg(T, 'Sell');
  await seg(T, 'N days');
  await page.waitForTimeout(150);
  await q.shot('lv-trade-ndays');
  const dayRow = await page.locator(`${T} .lv-row`).allTextContents();
  console.log('   rows:', dayRow.map((x) => x.slice(0, 40)).join(' | '));
  await submit(T);
  console.log('   msg:', await msg(T), await toasts());
  o = await q.s('s.policy.orders.at(-1)');
  console.log('   last order', JSON.stringify(o).slice(0, 300));
  // once
  await seg(T, 'Buy');
  await seg(T, 'Once');
  await submit(T);
  o = await q.s('s.policy.orders.at(-1)');
  check('trade once', o.once === true, JSON.stringify(o).slice(0, 200));
  // labour
  await seg(T, 'Labour');
  await page.waitForTimeout(200);
  await q.shot('lv-trade-labour');
  console.log('   labour rows:', (await page.locator(`${T} .lv-row`).allTextContents()).map((x) => x.slice(0, 50)).join(' | '));
  await submit(T);
  o = await q.s('s.policy.orders.at(-1)');
  check('trade labour', o.market.kind === 'labor', JSON.stringify(o).slice(0, 200) + ' ' + (await msg(T)));
  // IOUs
  await seg(T, 'IOUs');
  await page.waitForTimeout(200);
  await q.shot('lv-trade-ious');
  console.log('   iou rows:', (await page.locator(`${T} .lv-row`).allTextContents()).map((x) => x.slice(0, 50)).join(' | '));
  await seg(T, 'Issue new');
  await submit(T);
  o = await q.s('s.policy.orders.at(-1)');
  check('trade IOUs sell', o.market.kind === 'iou' && o.side === 'sell', JSON.stringify(o).slice(0, 200) + ' ' + (await msg(T)));
  // gold
  await seg(T, 'Gold');
  await page.waitForTimeout(200);
  await seg(T, 'Sell');
  await q.shot('lv-trade-gold');
  await submit(T);
  o = await q.s('s.policy.orders.at(-1)');
  check('trade gold sell', o.market.kind === 'gold', JSON.stringify(o).slice(0, 200) + ' ' + (await msg(T)));
  // move goods (if present)
  const move = page.locator(`${T} .seg-btn:text-is("Move")`);
  console.log('   move seg present:', await move.count());
  // step a few days so orders fill
  await q.s('R.setSpeed(3)');
  await page.waitForTimeout(2500);
  await q.s('R.setSpeed(0)');
  await page.waitForTimeout(400);
  console.log('   orders now', JSON.stringify(await q.s('s.policy.orders.map(o=>({id:o.id,k:o.market.kind,side:o.side,filled:o.filledTotal??o.filled,en:o.enabled}))')));
  console.log('   holdings', JSON.stringify(await q.s('s.treasury.goods')));
  await q.shot('lv-trade-after');
  // move goods from Milldale (where grain was bought) to Kingsbridge
  const mv = page.locator(`${T} .lv-subform form`);
  console.log('   move form visible:', await mv.isVisible());
  if (await mv.isVisible()) {
    const sels = mv.locator('select');
    console.log('   move from options:', (await sels.nth(0).locator('option').allTextContents()).join('/'));
    await sels.nth(2).selectOption('0');
    await mv.locator('.lv-chip:text-is("All")').click();
    const g0 = await q.s('JSON.stringify(s.treasury.goods.map(r=>+r[0].toFixed(1)))');
    await mv.locator('.lv-submit').click();
    await page.waitForTimeout(300);
    const g1 = await q.s('JSON.stringify(s.treasury.goods.map(r=>+r[0].toFixed(1)))');
    const mm = await mv.locator('.lv-msg').textContent().catch(() => '');
    check('move goods', g0 !== g1 || /ship|wagon|move/i.test(mm), `${g0} -> ${g1} ${mm} ${JSON.stringify(await toasts())}`);
  }
}

// ---------------- Levy (every base) ----------------
{
  await q.lever('levy');
  const T = L('levy');
  const baseSel = page.locator(`${T} select`).nth(1);
  const opts = await baseSel.locator('option').allTextContents();
  for (let i = 0; i < opts.length; i++) {
    await baseSel.selectOption(String(i));
    await page.waitForTimeout(150);
    const n0 = await q.s('s.policy.levies.length');
    const decree = await page.locator(`${T} .lv-decree`).textContent().catch(() => '');
    const units = await page.locator(`${T} select`).nth(0).locator('option').allTextContents();
    await submit(T);
    const n1 = await q.s('s.policy.levies.length');
    const lv = await q.s('s.policy.levies.at(-1)');
    check(`levy base "${opts[i]}"`, n1 === n0 + 1, `units=[${units.join('/')}] decree="${decree.slice(0, 110)}" -> ${JSON.stringify(lv).slice(0, 160)} ${n1 === n0 ? await msg(T) : ''}`);
  }
  // pay side
  await seg(T, 'Pay');
  await baseSel.selectOption('8');
  await submit(T);
  check('levy pay each person', (await q.s('s.policy.levies.at(-1).dir')) < 0, JSON.stringify(await q.s('s.policy.levies.at(-1)')).slice(0, 200));
  await q.shot('lv-levy');
}

// ---------------- Limit (every kind) ----------------
{
  await q.lever('limit');
  const T = L('limit');
  const kindSel = page.locator(`${T} .lv-row`).filter({ has: page.locator('.lv-lab:text-is("Limit on")') }).locator('select');
  const opts = await kindSel.locator('option').allTextContents();
  for (let i = 0; i < opts.length; i++) {
    await kindSel.selectOption(String(i));
    await page.waitForTimeout(150);
    const n0 = await q.s('s.policy.limits.length');
    const decree = await page.locator(`${T} .lv-decree`).textContent().catch(() => '');
    await submit(T);
    const n1 = await q.s('s.policy.limits.length');
    const lm = await q.s('s.policy.limits.at(-1)');
    check(`limit "${opts[i]}"`, n1 === n0 + 1, `decree="${decree.slice(0, 100)}" -> ${JSON.stringify(lm).slice(0, 140)} ${n1 === n0 ? await msg(T) : ''}`);
  }
  await q.shot('lv-limit');
}

// ---------------- Window ----------------
{
  await q.lever('window');
  const T = L('window');
  await num(T, 'Reserve rate', 3);
  await num(T, 'Lend rate', 7);
  await submit(T);
  const w = await q.s('({r: s.treasury.reserveRate, l: s.treasury.lendRate})');
  check('window 3%/7%', Math.abs(w.r - 0.03) < 1e-9 && Math.abs(w.l - 0.07) < 1e-9, JSON.stringify(w));
  // range slider
  await page.locator(`${T} input.range`).first().fill('50');
  await page.waitForTimeout(150);
  console.log('   after slider reserve field:', await page.locator(`${T} input.num-field`).first().inputValue());
  await page.locator(`${T} button:text-is("Reset")`).click();
  await page.waitForTimeout(150);
  console.log('   after reset reserve field:', await page.locator(`${T} input.num-field`).first().inputValue());
  await q.shot('lv-window');
}

// ---------------- Transfer ----------------
{
  await q.lever('transfer');
  const T = L('transfer');
  const sel = page.locator(`${T} .lv-row`).filter({ has: page.locator('.lv-lab:text-is("To")') }).locator('select');
  const opts = await sel.locator('option').allTextContents();
  for (let i = 0; i < opts.length; i++) {
    await sel.selectOption(String(i));
    await page.waitForTimeout(120);
    const p0 = await q.s('s.treasury.purse');
    const btn = await page.locator(`${T} .lv-submit`).textContent();
    const dis = await page.locator(`${T} .lv-submit`).isDisabled();
    if (!dis) await submit(T);
    const p1 = await q.s('s.treasury.purse');
    check(`transfer give to "${opts[i]}"`, dis || p1 < p0, `btn="${btn}" disabled=${dis} purse ${p0.toFixed(2)} -> ${p1.toFixed(2)} ${await msg(T)}`);
  }
  await seg(T, 'Take');
  await sel.selectOption('0');
  await page.waitForTimeout(120);
  const p0 = await q.s('s.treasury.purse');
  await submit(T);
  const p1 = await q.s('s.treasury.purse');
  check('transfer take from everyone', p1 > p0, `${p0.toFixed(2)} -> ${p1.toFixed(2)} ${await msg(T)}`);
  await sel.selectOption(String(opts.length - 1));
  await page.waitForTimeout(120);
  const p2 = await q.s('s.treasury.purse');
  const dis = await page.locator(`${T} .lv-submit`).isDisabled();
  if (!dis) await submit(T);
  const p3 = await q.s('s.treasury.purse');
  check('transfer take from the bank', dis || p3 > p2, `disabled=${dis} ${p2.toFixed(2)} -> ${p3.toFixed(2)} ${await msg(T)}`);
  await q.shot('lv-transfer');
}

// ---------------- Build ----------------
{
  await q.lever('build');
  const T = L('build');
  await q.lever('mint');
  await num(L('mint'), 'Amount', '200k');
  await submit(L('mint'));
  await q.lever('build');
  const n0 = await q.s('s.projects?.length ?? -1');
  await submit(T);
  // a road already paved or under way (trading houses and councils build them too) is rightly
  // refused: try the other destinations before judging
  let why = await msg(T);
  const tos = page.locator(`${T} select:visible`).nth(1);
  const nTo = await tos.locator('option').count();
  for (let k = 0; k < nTo && (await q.s('s.projects?.length ?? -1')) <= n0 && /under way|already paved/.test(why); k++) {
    await tos.selectOption({ index: k });
    await page.waitForTimeout(150);
    await submit(T);
    why = await msg(T);
  }
  const pr = await q.s('JSON.stringify((s.projects||[]).slice(-1))');
  const built = (await q.s('s.projects?.length ?? -1')) > n0;
  check('build road', built || /under way|already paved/.test(why), pr.slice(0, 200) + ' ' + why);
  for (const kind of ['Houses', 'Workshop', 'Pier', 'Enlarge']) {
    await seg(T, kind);
    await page.waitForTimeout(200);
    const rows = (await page.locator(`${T} .lv-row`).allTextContents()).map((x) => x.slice(0, 50));
    const btns = await page.locator(`${T} button`).allTextContents();
    console.log(`   build ${kind}: rows=${rows.join(' | ')} buttons=${btns.filter(Boolean).join(',')}`);
    await q.shot('lv-build-' + kind.toLowerCase());
    const m0 = await q.s('s.projects?.length ?? -1');
    const dis = await page.locator(`${T} .lv-submit`).isDisabled();
    if (!dis) await submit(T);
    const m1 = await q.s('s.projects?.length ?? -1');
    check(`build ${kind}`, dis || m1 > m0, `disabled=${dis} ${m0}->${m1} ${await msg(T)}`);
  }
}

await page.waitForTimeout(500);
await q.lever('mint'); // collapse others so In force is visible
await page.locator('.lv-force-sec').scrollIntoViewIfNeeded();
await q.shot('lv-inforce');
const counts = await q.s(`({levies: s.policy.levies.length, limits: s.policy.limits.length, orders: s.policy.orders.length, rows: document.querySelectorAll('.lv-if').length})`);
console.log('in force', JSON.stringify(counts));
console.log('\nFAILS:', fails.length ? fails.join('; ') : 'none');
report(q, 'levers');
await q.close();
