// Drive the "Price" control (fixed / follow the market ±5–30 % / any price) in the built game.
//   node scripts/qa/pricemode.mjs
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
await q.s(`R.setSpeed(0)`);
await q.s(`(R.game ?? R).dispatch ? 0 : 0`);
await page.evaluate(() => window.__realm.ui.game.dispatch({ type: 'mint', amount: 100000 }));

await q.lever('trade');
const body = L('trade');
// ordinary goods order (Order tab is the default)
const segClick = (text) => page.locator(`${body} .seg-btn:text-is("${text}")`).first().click();
await segClick('±10%');
await page.waitForTimeout(300);
const hintTxt = await page.locator(`${body} .lv-row`).filter({ hasText: 'Bids from the market' }).first().textContent().catch(() => '');
check('follow hint shown (patient by default)', /Bids from the market’s going price .* steps up — to at most/.test(hintTxt), hintTxt.slice(0, 160));
check('bidding choice shown', await page.locator(`${body} .seg-btn:text-is("As low as it can")`).first().isVisible());
check('fixed price field hidden', !(await page.locator(`${body} .lv-row .lv-lab:text-is("Pay at most")`).first().isVisible().catch(() => false)));
await q.shot('pm-trade-follow');
const n0 = await q.s('s.policy.orders.length');
await page.locator(`${body} .lv-submit`).first().click();
await page.waitForTimeout(400);
const o = await q.s(`s.policy.orders[s.policy.orders.length-1]`);
check('order placed following the market', (await q.s('s.policy.orders.length')) === n0 + 1 && o.priceMode === 'follow' && Math.abs(o.band - 0.1) < 1e-9, JSON.stringify({ mode: o.priceMode, band: o.band, price: o.price }));

await segClick('Any');
await page.waitForTimeout(250);
await page.locator(`${body} .lv-submit`).first().click();
await page.waitForTimeout(400);
const o2 = await q.s(`s.policy.orders[s.policy.orders.length-1]`);
check('order placed at any price', o2.priceMode === 'any', JSON.stringify({ mode: o2.priceMode, price: o2.price }));

// run a few days: limits re-set, orders fill
await q.s(`R.setSpeed(3)`);
await page.waitForTimeout(3000);
await q.s(`R.setSpeed(0)`);
const after = await q.s(`s.policy.orders.filter(x => x.priceMode !== 'fixed').map(x => ({ mode: x.priceMode, price: x.price, filled: x.filled }))`);
check('following orders keep filling', after.every((x) => x.filled > 0), JSON.stringify(after));

// In force pill text
await page.evaluate(() => document.querySelector('.lv-inforce')?.scrollIntoView());
await page.waitForTimeout(300);
const pills = await page.evaluate(() => [...document.querySelectorAll('.lv-if-head')].map((e) => e.textContent.trim()).join(' | '));
check('In force shows market ≤ +10% (patient, with today’s step) and any price', /market ≤ \+10% · /.test(pills) && /any price/.test(pills), pills.slice(0, 300));
await q.shot('pm-inforce');

console.log(`\nFAILS: ${fails.length ? fails.join(', ') : 'none'}`);
report(q, 'pricemode');
await q.close();
