// Drive the Works tab: commission a road with "staff it automatically" on, run the clock,
// check the town's crew, who is where, the projects list, set-number staffing and letting go.
//   node scripts/qa/works.mjs
import { open, report } from './lib.mjs';

const q = await open({});
await q.ready();
const { page } = q;
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) fails.push(name);
};
await q.s(`R.setSpeed(0)`);
await page.evaluate(() => window.__realm.ui.game.dispatch({ type: 'mint', amount: 60000 }));
const tabs = await page.evaluate(() => [...document.querySelectorAll('.tabs .tab')].map((t) => [t.textContent, t.getBoundingClientRect().right]));
const navRight = await page.evaluate(() => document.querySelector('.tabs').getBoundingClientRect().right);
check('Works tab present and the tab bar fits', tabs.some(([t]) => t === 'Works') && tabs.every(([, r]) => r <= navRight + 1), JSON.stringify(tabs.map(([t, r]) => `${t}@${Math.round(r)}`)) + ' nav ' + Math.round(navRight));

// commission a road from the Build lever (crew switch on by default)
await q.lever('build');
const bb = `.lv-item[data-lever="build"] .lv-body`;
const sw = await page.locator(`${bb} .lv-crew .switch`).getAttribute('aria-checked');
check('crew switch shown and on', sw === 'true', String(sw));
const selects = page.locator(`${bb} select`);
await selects.nth(0).selectOption({ index: 0 });
await selects.nth(1).selectOption({ index: 1 });
await page.waitForTimeout(300);
await page.locator(`${bb} .lv-submit`).first().click();
await page.waitForTimeout(400);
const ord = await q.s(`s.policy.orders.filter(o => o.market.kind === 'labor').map(o => ({ town: o.market.town, staff: o.staff, qty: o.qty, mode: o.priceMode, band: o.band, today: o.staffToday }))`);
check('commissioning placed an order that staffs the projects', ord.length === 1 && ord[0].staff === 'projects' && ord[0].mode === 'follow' && ord[0].today > 0, JSON.stringify(ord));

// run and open Works
await q.s(`R.setSpeed(4)`);
await page.waitForTimeout(6000);
await q.s(`R.setSpeed(0)`);
await page.evaluate(() => window.__realm.setTab('works'));
await page.waitForTimeout(600);
const t0 = ord[0]?.town ?? 0;
const card = `.wk-town[data-town="${t0}"]`;
const txt = (await page.locator(card).innerText()).replace(/\s+/g, ' ');
const crew = await q.s(`(() => { const f = s.firms.find(f => f.alive && f.sector === 'stateworks' && f.town === ${t0}); return f ? f.workers.length : 0; })()`);
check('the town has a Treasury crew', crew > 0, `crew ${crew}`);
check('card shows who is building which project, by name', /Paved road .* — \d+/.test(txt) && (await page.locator(`${card} .wk-who .ent-link`).count()) > 0, txt.slice(0, 300));
check('card lists the project with its crew and progress', /Treasury projects here/i.test(txt) && /Treasury crew today: about \d+/.test(txt), txt.slice(0, 500));
check('staffing control shows automatic staffing', (await page.locator(`${card} .seg-btn.on`).first().textContent()) === 'Staff projects');
await q.shot('works-auto');

// clicking a name inspects the person
await page.locator(`${card} .wk-who .ent-link`).first().click();
await page.waitForTimeout(300);
const sel = await q.s(`ui.selection`);
check('clicking a name selects that person', sel && sel.kind === 'person', JSON.stringify(sel));
await page.evaluate(() => window.__realm.setTab('works'));
await page.waitForTimeout(300);

// switch to a set number of 3 and apply
await page.locator(`${card} .seg-btn:text-is("Set number")`).click();
const qin = page.locator(`${card} .wk-ctl input`).first();
await qin.fill('3');
await qin.press('Tab');
await page.locator(`${card} .wk-apply`).click();
await page.waitForTimeout(300);
const o2 = await q.s(`s.policy.orders.filter(o => o.market.kind === 'labor').map(o => ({ staff: o.staff ?? null, qty: o.qty }))`);
check('set number applied (one order, 3 people, no longer automatic)', o2.length === 1 && o2[0].staff === null && o2[0].qty === 3, JSON.stringify(o2));
await q.s(`R.setSpeed(3)`);
await page.waitForTimeout(1500);
await q.s(`R.setSpeed(0)`);
const crew2 = await q.s(`(() => { const f = s.firms.find(f => f.alive && f.sector === 'stateworks' && f.town === ${t0}); return f ? f.workers.length : 0; })()`);
check('the crew shrank to 3', crew2 === 3, `crew ${crew2}`);

// None → everyone let go
await page.locator(`${card} .seg-btn:text-is("None")`).click();
await page.locator(`${card} .wk-apply`).click();
await page.waitForTimeout(300);
await q.s(`R.setSpeed(3)`);
await page.waitForTimeout(1200);
await q.s(`R.setSpeed(0)`);
const crew3 = await q.s(`(() => { const f = s.firms.find(f => f.alive && f.sector === 'stateworks' && f.town === ${t0}); return f ? f.workers.length : 0; })()`);
const o3 = await q.s(`s.policy.orders.filter(o => o.market.kind === 'labor').length`);
check('None lets everyone go', crew3 === 0 && o3 === 0, `crew ${crew3}, orders ${o3}`);

// Staff every town automatically
await page.locator('.wk-actions .btn', { hasText: 'Staff every town' }).click();
await page.waitForTimeout(300);
const o4 = await q.s(`s.policy.orders.filter(o => o.market.kind === 'labor' && o.staff === 'projects').length`);
check('staff every town: one automatic order per town', o4 === (await q.s('s.towns.length')), String(o4));
await q.shot('works-all');

console.log(`\nFAILS: ${fails.length ? fails.join(', ') : 'none'}`);
report(q, 'works');
await q.close();
process.exit(fails.length ? 1 : 0);
