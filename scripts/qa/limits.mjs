// Drive the Limit lever in the built game: a limit on how far bread's price may move in a
// day (every town, with the town-by-town table and quick chips), price chips relative to
// today's price, a price limit on the gold market, and a 3 % capital rule for the Bank
// (below the standing 8 %) — then check the In force list and the Ledger's Bank view.
//   node scripts/qa/limits.mjs   (needs a fresh `npm run build`; QA_OUT sets the output folder)
import { existsSync } from 'node:fs';
import { open, OUT, report } from './lib.mjs';

const hadCache = existsSync(OUT + '/realm.save');
const q = await open({});
await q.ready(180000);
if (!hadCache) await q.saveCache();
const { page } = q;
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) fails.push(name);
};
const T = '.lv-item[data-lever="limit"] .lv-body';
const rowOf = (label) => page.locator(`${T} .lv-row`).filter({ has: page.locator(`.lv-lab:text-is("${label}")`) }).first();
async function choose(label, optionText) {
  await rowOf(label).locator('select').first().selectOption({ label: optionText });
  await page.waitForTimeout(200);
}
const text = (sel) => page.locator(`${T} ${sel}`).first().textContent().catch(() => '');
const chipClick = async (label) => {
  await page.locator(`${T} .lv-chip:text-is("${label}")`).first().click();
  await page.waitForTimeout(200);
};
async function enact() {
  const n0 = await q.s('s.policy.limits.length');
  await page.locator(`${T} .lv-submit`).first().click();
  await page.waitForTimeout(400);
  if (await page.$('.modal-backdrop.on')) {
    await page.locator('.modal-backdrop.on .btn-primary, .modal-backdrop.on .btn-danger').last().click();
    await page.waitForTimeout(300);
  }
  return (await q.s('s.policy.limits.length')) === n0 + 1 ? await q.s('s.policy.limits.at(-1)') : null;
}

await q.s('R.setSpeed(0)');
await q.lever('limit');
const nTowns = await q.s('s.towns.length');
const nGoods = await q.s('s.markets.length / s.towns.length');

// ---------------- a limit on daily moves: bread, every town ----------------
await choose('Limit on', 'Price of a good — daily move at most');
await choose('Market', 'Bread');
await choose('Town', 'Every town');
await chipClick('2%');
const decreeMove = await text('.lv-decree');
check('move decree in words', /The price of bread in every town may move at most 2% a day/.test(decreeMove), decreeMove);
const towns = page.locator(`${T} .lv-lim-towns`);
check('town-by-town table shown for every town', await towns.isVisible(), '');
const rowsMove = await towns.locator('.lv-hold-r').count();
check('one row per town (+ header)', rowsMove === nTowns + 1, `${rowsMove} rows for ${nTowns} towns`);
const tableMove = (await towns.textContent()) ?? '';
check('table has prices and largest moves', /Max move/.test(tableMove) && /¤/.test(tableMove), tableMove.slice(0, 200));
const biteMove = await text('.lv-bite');
check('would-it-bind text for moves', /last 30 days|last \d+ days|sudden jump/.test(biteMove), biteMove);
await q.shot('limits-move');
const mv = await enact();
check('move limit enacted', !!mv && mv.kind === 'priceMove' && Math.abs(mv.value - 0.02) < 1e-12 && mv.town === -1 && mv.good >= 0, JSON.stringify(mv));

// ---------------- a price ceiling in every town: chips relative to today's price ----------------
await choose('Limit on', 'Price of a good — at most');
await choose('Market', 'Bread');
await choose('Town', 'All towns');
await chipClick('Today');
const avg = await q.s(`s.stats.latest['price_' + ${mv?.good ?? 0}]`);
const typed = Number(((await rowOf('At most').locator('input.num-field:visible').first().inputValue()) || 'NaN').replace(/[^0-9.]/g, ''));
check('“Today” chip sets today’s price', Math.abs(typed - avg) / avg < 0.01, `field ${typed} vs realm average ${avg}`);
await chipClick('−20%');
const tableCap = (await towns.textContent()) ?? '';
check('ceiling table shows whether it binds per town', (await towns.isVisible()) && /Would bind/.test(tableCap) && /yes/.test(tableCap), tableCap.slice(0, 200));
const biteCap = await text('.lv-bite');
check('ceiling 20% below binds in towns', /It would bind at once in/.test(biteCap), biteCap);
await q.shot('limits-ceiling-towns');

// ---------------- the gold market ----------------
await choose('Market', 'Gold (per oz)');
check('no town for the gold market', !(await rowOf('Town').isVisible()), '');
check('no town table for gold', !(await towns.isVisible()), '');
const decreeGold = await text('.lv-decree');
check('gold decree', /No one may trade gold above ¤[\d.,]+ an ounce/.test(decreeGold), decreeGold);

// ---------------- the Bank's capital: 3 % in place of the standing 8 % ----------------
await choose('Limit on', 'Bank capital — at least');
const ruleHint0 = await page.locator(`${T} .lv-hint`).filter({ hasText: 'Rule in force now' }).first().textContent().catch(() => '');
check('the rule in force is shown', /Rule in force now: 8(\.0)?%/.test(ruleHint0) && /never goes below 2/.test(ruleHint0), ruleHint0);
const inp = rowOf('At least').locator('input.num-field:visible').first();
await inp.fill('3');
await inp.press('Tab');
await page.waitForTimeout(250);
const decreeCap = await text('.lv-decree');
check('capital decree: in place of the standing 8 %', /above 3% of its loans, in place of the standing 8%/.test(decreeCap), decreeCap);
const biteCapital = await text('.lv-bite');
check('capital would-it-bind text', biteCapital.length > 20, biteCapital);
await q.shot('limits-capital');
const cl = await enact();
check('capital limit enacted', !!cl && cl.kind === 'capitalMin' && Math.abs(cl.value - 0.03) < 1e-12, JSON.stringify(cl));
await page.waitForTimeout(300);
const ruleHint1 = await page.locator(`${T} .lv-hint`).filter({ hasText: 'Rule in force now' }).first().textContent().catch(() => '');
check('the rule in force is now the Limit', /Rule in force now: 3(\.0)?% \(a Limit\)/.test(ruleHint1), ruleHint1);

// ---------------- run a few days ----------------
const day0 = await q.s('s.day');
const p0 = await q.s(`s.towns.map((t) => s.markets[t.id * ${nGoods} + ${mv?.good ?? 0}].price)`);
await q.s('R.setSpeed(3)');
for (let i = 0; i < 60 && (await q.s('s.day')) < day0 + 6; i++) await page.waitForTimeout(250);
await q.s('R.setSpeed(0)');
await page.waitForTimeout(300);
const days = (await q.s('s.day')) - day0;
// the last `days` + 1 recorded prices: yesterday's (before the limit) and every day since
const hist = await q.s(`s.towns.map((t) => s.markets[t.id * ${nGoods} + ${mv?.good ?? 0}].hist.slice(-${Math.max(1, days) + 1}))`);
let worst = 0;
for (const h of hist) for (let i = 1; i < h.length; i++) worst = Math.max(worst, Math.abs(h[i] / h[i - 1] - 1));
check('the clock ran', days >= 3, `${days} days`);
check('bread never moved more than 2 % a day since', worst <= 0.02 + 1e-9, `worst ${(worst * 100).toFixed(3)}% over ${days} days; start ${JSON.stringify(p0.map((x) => +x.toFixed(3)))}`);
const bound = await q.s(`s.policy.limits.find((l) => l.kind === 'priceMove')?.binding ?? -1`);
check('the move limit is counted binding', bound > 0, `${bound} days this month`);

// ---------------- In force ----------------
await page.evaluate(() => document.querySelector('.lv-inforce')?.scrollIntoView());
await page.waitForTimeout(300);
const inforce = await page.evaluate(() => [...document.querySelectorAll('.lv-inforce .lv-if')].map((e) => e.textContent.trim()).join(' | '));
check('In force lists the move limit', /may move at most 2% a day/.test(inforce), inforce.slice(0, 300));
check('In force lists the capital rule', /in place of the standing 8%/.test(inforce), '');
await q.shot('limits-inforce');

// ---------------- the Ledger's Bank view shows the rule in force ----------------
await q.tab('Ledger');
await page.locator('.ldg-nav .seg-btn:text-is("Bank")').first().click();
await page.waitForTimeout(500);
const tile = await page.evaluate(() => [...document.querySelectorAll('.kpi')].find((k) => /Capital ratio/.test(k.textContent))?.textContent ?? '');
check('Ledger capital tile shows the 3 % Limit', /Limit 3(\.0)?%/.test(tile), tile.slice(0, 160));
await q.shot('limits-ledger-bank');

console.log(`\nFAILS: ${fails.length ? fails.join(', ') : 'none'}`);
const errs = report(q, 'limits');
await q.close();
process.exit(fails.length || errs.length ? 1 : 0);
