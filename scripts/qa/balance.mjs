// The Markets tab's 14-day shortage / surplus view next to the day's: detail chips and tiles,
// the grid's badges (14 days) and their tooltips, the town inspector; and made / used / moved.
//   node scripts/qa/balance.mjs
import { open, report } from './lib.mjs';

const q = await open({});
await q.ready();
const { page } = q;
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) fails.push(name);
};
await q.s(`R.setSpeed(4)`);
await page.waitForTimeout(5000);
await q.s(`R.setSpeed(0)`);
const days = await q.s(`s.markets[0].shortHist.length`);
check('markets keep up to 14 days', days >= 1 && days <= 14, `days ${days}`);
// the grid: legend says 14 days
await page.evaluate(() => window.__realm.setTab('markets'));
await page.waitForTimeout(600);
const legend = await page.locator('.mk-lg').allTextContents();
check('grid legend names the 14 days', legend.some((t) => /buyers went short \(14 days\)/.test(t)), legend.join(' | '));
await q.shot('balance-grid');
// a market's detail: today's chip and the 14-day chip side by side; tiles with the 14-day average
await page.evaluate(() => window.__realm.select({ kind: 'market', town: 0, good: 3 }));
await page.waitForTimeout(700);
const txt = (await page.locator('section.panel[data-panel="markets"]').innerText()).replace(/\s+/g, ' ');
check('detail shows a 14-day chip', /\d+ days: (short \d+%|\d+% unsold|balanced)/.test(txt), (txt.match(/\d+ days: [^·]{0,30}/) ?? [''])[0]);
check('detail tiles show the 14-day average under today’s', /Unmet today/i.test(txt) && /\d+d avg/.test(txt));
await q.shot('balance-detail');
// made, used and moved: the detail card and the grid's "Made & used" view
check('detail has a Made, used and moved card with every town', /Made, used and moved/.test(txt) && /Made here/.test(txt) && /Traded in the market/.test(txt) && /Traded is different/.test(txt));
await q.shot('flows-detail');
await page.evaluate(() => window.__realm.select({ kind: 'market', town: -1, good: 8 }));
await page.waitForTimeout(400);
await page.locator('section.panel[data-panel="markets"] .mk-back, section.panel[data-panel="markets"] button:has-text("All markets")').first().click().catch(() => {});
await page.waitForTimeout(400);
await page.locator('section.panel[data-panel="markets"] .seg-btn:text-is("Made & used")').first().click().catch(() => {});
await page.waitForTimeout(500);
const cellsTxt = await page.locator('section.panel[data-panel="markets"] .mk-cell').allTextContents();
const numeric = cellsTxt.filter((x) => /\d/.test(x)).length;
check('grid shows what each town makes (Made & used)', numeric > 10 && (await page.locator('.mk-legend:visible').first().textContent())?.includes('made a day'), `${numeric} cells with numbers`);
await q.shot('flows-grid');
// town inspector
await q.s(`R.select({ kind: 'town', id: 0 })`);
await page.waitForTimeout(500);
await q.shot('balance-town');
console.log(`\nFAILS: ${fails.length ? fails.join(', ') : 'none'}`);
report(q, 'balance');
await q.close();
process.exit(fails.length ? 1 : 0);
