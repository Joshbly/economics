// Prefill links (Markets / Inspect town) land in the right lever with the right values;
// Carry (once); form validation; end conditions.
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
const selVals = (id) => page.locator(`${L(id)} select:visible`).evaluateAll((ss) => ss.map((s) => s.options[s.selectedIndex]?.text));
await q.s('R.setSpeed(0)');

// Markets -> coal in Milldale
await q.s(`R.select({kind:'market', town:1, good:3})`);
await page.waitForTimeout(500);
for (const [btn, lever] of [['Trade here', 'trade'], ['Levy here', 'levy'], ['Limit here', 'limit']]) {
  await q.s(`R.select({kind:'market', town:1, good:3})`);
  await page.waitForTimeout(400);
  await page.locator(`section.panel[data-panel="markets"] button:text-is("${btn}")`).first().click();
  await page.waitForTimeout(600);
  const open = await page.evaluate(() => document.querySelector('.lv-item.open')?.dataset.lever);
  const vals = await selVals(lever);
  const focused = await page.evaluate(() => document.activeElement?.className);
  check(`Markets "${btn}" -> ${lever}`, (await q.s('ui.tab')) === 'levers' && open === lever && vals.includes('Coal') && vals.some((v) => /Milldale/.test(v)), `open=${open} selects=${vals.join('/')} focus=${focused}`);
  await q.shot('pf-' + lever);
}
// gold and IOU
for (const g of [100, 101]) {
  await q.s(`R.select({kind:'market', town:0, good:${g}})`);
  await page.waitForTimeout(400);
  const has = await page.locator('section.panel[data-panel="markets"] button:text-is("Trade here")').count();
  if (!has) { console.log('   no Trade here for good', g); continue; }
  await page.locator('section.panel[data-panel="markets"] button:text-is("Trade here")').first().click();
  await page.waitForTimeout(500);
  const seg = await page.locator(`${L('trade')} .seg-btn.on`).first().textContent();
  check(`Markets good ${g} Trade here`, /Gold|IOUs/.test(seg), seg);
}
// Town inspector -> Trade here
await q.s(`R.select({kind:'town', id:2})`);
await page.waitForTimeout(400);
await page.locator('section.panel[data-panel="inspect"] button:text-is("Trade here")').click();
await page.waitForTimeout(500);
const tv = await selVals('trade');
check('Town "Trade here" -> Trade in that town', tv.some((v) => /Sootfell/.test(v)) || tv.includes(await q.s('s.towns[2].name')), tv.join('/'));

// Carry once: buy bread once at +20%, run 2 days, send all of it to another town
await q.lever('mint');
await page.locator(`${L('mint')} input.num-field`).first().fill('50k');
await page.locator(`${L('mint')} .lv-submit`).click();
await q.lever('trade');
const T = L('trade');
await page.locator(`${T} .seg-btn:text-is("Goods")`).click();
const selects = page.locator(`${T} form`).first().locator('select');
await selects.nth(0).selectOption({ index: 0 });
await selects.nth(1).selectOption({ label: 'Bread' });
await page.locator(`${T} .seg-btn:text-is("Buy")`).first().click();
await page.locator(`${T} .lv-chip:text-is("+20%")`).first().click();
await page.locator(`${T} .seg-btn:text-is("Once")`).click();
await page.locator(`${T} .lv-submit`).first().click();
await page.waitForTimeout(300);
await q.s('R.setSpeed(2)');
await page.waitForTimeout(2600);
await q.s('R.setSpeed(0)');
await page.waitForTimeout(400);
const held = await q.s('s.treasury.goods[0][8]');
console.log('   bread held in town 0:', held);
await page.locator(`${T} .seg-btn:text-is("Carry")`).click();
await page.waitForTimeout(300);
const mv = page.locator(`${T} .lv-carry form`);
check('holdings + carry form visible after buying', held > 0 && (await mv.isVisible()), `held=${held}`);
await q.shot('pf-holdings');
if (await mv.isVisible()) {
  const ms = mv.locator('select');
  await ms.nth(0).selectOption({ index: 0 });
  await ms.nth(2).selectOption({ label: 'Bread' });
  await mv.locator('.seg-btn:text-is("Everything")').click();
  await mv.locator('.seg-btn:text-is("Once, now")').click();
  await page.waitForTimeout(150);
  console.log('   preview:', await mv.locator('.lv-preview').textContent());
  const sh0 = await q.s('s.shipments.filter(x => x).length');
  await mv.locator('.lv-submit').click();
  await page.waitForTimeout(400);
  const msg = await mv.locator('.lv-msg').textContent().catch(() => '');
  const g1 = await q.s('s.treasury.goods[0][8]');
  const sh1 = await q.s('s.shipments.filter(x => x).length');
  check('carry once dispatches', g1 < held && (await q.s('s.policy.carries.length')) === 0, `held ${held} -> ${g1}; shipments ${sh0}->${sh1}; msg=${msg}`);
}

// Validation: bad numbers
await q.lever('mint');
for (const v of ['-5', 'abc', '1e99', '0']) {
  await page.locator(`${L('mint')} input.num-field`).first().fill(v);
  await page.locator(`${L('mint')} input.num-field`).first().press('Tab');
  const p0 = await q.s('s.treasury.purse');
  const dis = await page.locator(`${L('mint')} .lv-submit`).isDisabled();
  if (!dis) await page.locator(`${L('mint')} .lv-submit`).click();
  else await page.locator(`${L('mint')} input.num-field`).first().press('Enter');
  await page.waitForTimeout(250);
  const p1 = await q.s('s.treasury.purse');
  const m = await page.locator(`${L('mint')} .lv-msg`).textContent().catch(() => '');
  const err = await page.locator(`${L('mint')} .num-err, ${L('mint')} .field-err, ${L('mint')} [aria-invalid="true"]`).count();
  check(`mint rejects "${v}"`, p1 === p0, `disabled=${dis} msg="${m}" invalidMarks=${err} purse ${p0.toFixed(0)}->${p1.toFixed(0)}`);
}
// Levy with an end after N days
await q.lever('levy');
await page.locator(`${L('levy')} .seg-btn:text-is("After")`).click();
await page.waitForTimeout(150);
const condRow = await page.locator(`${L('levy')} .lv-cond`).first().textContent().catch(() => '');
console.log('   levy end row:', condRow);
await page.locator(`${L('levy')} .lv-submit`).click();
await page.waitForTimeout(250);
const lv = await q.s('s.policy.levies.at(-1)');
check('levy with end date', lv && lv.until > (await q.s('s.day')), JSON.stringify(lv).slice(0, 220));
// limit with end
await q.lever('limit');
await page.locator(`${L('limit')} .seg-btn:text-is("After")`).click();
await page.locator(`${L('limit')} .lv-submit`).click();
await page.waitForTimeout(250);
const lm = await q.s('s.policy.limits.at(-1)');
check('limit with end date', lm && lm.until > (await q.s('s.day')), JSON.stringify(lm).slice(0, 220));
// trade N days + total cap
await q.lever('trade');
await page.locator(`${T} .seg-btn:text-is("Goods")`).click();
await page.locator(`${T} .seg-btn:text-is("N days"):visible`).click();
const daysInp = page.locator(`${T} form:visible .lv-row`).filter({ has: page.locator('.lv-lab:text-is("Duration")') }).locator('input');
await daysInp.fill('7');
await daysInp.press('Tab');
const totInp = page.locator(`${T} .lv-row`).filter({ has: page.locator('.lv-lab:text-is("In all")') }).locator('input');
await totInp.fill('55');
await totInp.press('Tab');
await page.locator(`${T} .lv-submit`).first().click();
await page.waitForTimeout(250);
const od = await q.s('s.policy.orders.at(-1)');
check('trade 7 days capped at 55', od.until === (await q.s('s.day')) + 6 || od.until === (await q.s('s.day')) + 7, `until=${od.until} day=${await q.s('s.day')} total=${od.total}`);
check('trade total cap', od.total === 55, String(od.total));
await page.locator('.lv-force-sec').scrollIntoViewIfNeeded();
await q.shot('pf-inforce');
console.log('\nFAILS:', fails.length ? fails.join('; ') : 'none');
report(q, 'prefill');
await q.close();
