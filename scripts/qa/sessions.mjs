// Drive the market sessions in the built game: the Trade form's When choice, the route composer's,
// the market detail's session prices and the clock's session name.
//   node scripts/qa/sessions.mjs
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
await page.evaluate(() => window.__realm.ui.game.dispatch({ type: 'mint', amount: 50000 }));
const body = `.lv-item[data-lever="trade"] .lv-body`;
await q.lever('trade');
const when = page.locator(`${body} .lv-row`).filter({ hasText: 'When' }).first();
check('When row shown', await when.isVisible());
await when.locator('.seg-btn:text-is("Opening")').click();
await page.waitForTimeout(250);
const hintTxt = (await when.textContent()) ?? '';
check('opening hint', /Only at the opening/.test(hintTxt), hintTxt.slice(0, 160));
const n0 = await q.s('s.policy.orders.length');
await page.locator(`${body} .lv-submit:visible`).first().click();
await page.waitForTimeout(400);
const o = await q.s('s.policy.orders[s.policy.orders.length - 1]');
check('order placed for the opening', (await q.s('s.policy.orders.length')) === n0 + 1 && o.session === 0, JSON.stringify({ session: o.session, label: o.label }));
const desc = await page.evaluate(() => [...document.querySelectorAll('.lv-if-d')].map((e) => e.textContent).join(' | '));
check('In force says at the opening', /a day at the opening in /.test(desc), desc.slice(0, 200));

// route composer: buy at midday, send right away
await page.locator(`${body} .seg-btn:text-is("Route")`).first().click().catch(() => {});
await page.waitForTimeout(300);
await page.locator(`${body} .seg-btn:text-is("Midday"):visible`).first().click();
await page.locator(`${body} .seg-btn:text-is("Right away"):visible`).first().click();
await page.waitForTimeout(250);
await page.locator(`${body} .lv-submit:visible`).first().click();
await page.waitForTimeout(400);
const ro = await q.s('s.policy.orders.filter(x => x.route).pop()');
check('route bought at midday, sent right away', ro && ro.session === 1 && ro.route.dispatch === 'daily', JSON.stringify(ro && { session: ro.session, dispatch: ro.route.dispatch }));

// run a few days; market detail shows the sessions
await q.s(`R.setSpeed(3)`);
await page.waitForTimeout(2500);
await q.s(`R.setSpeed(0)`);
const sess = await q.s('s.markets[8].sess');
check('markets record three session prices', Array.isArray(sess) && sess.length === 3, JSON.stringify(sess));
await page.evaluate(() => window.__realm.ui.game && window.__realm.select({ kind: 'market', town: 0, good: 8 }));
await page.waitForTimeout(600);
const mk = await page.evaluate(() => document.body.innerText);
check('market detail shows today’s sessions', /today: opening ¤[\d.]+ \([\d.,]+\), midday ¤[\d.]+ \([\d.,]+\), close ¤[\d.]+/.test(mk), (mk.match(/today: opening[^\n]*/) ?? [''])[0]);
await q.shot('sessions-market');

// the clock names the session
await page.evaluate(() => { window.__realm.ui.dayFrac = 0.5; });
await page.waitForTimeout(500);
const tb = await page.evaluate(() => document.querySelector('.tb-date-sub')?.textContent ?? '');
check('clock names the midday market', /midday market/.test(tb), tb);

console.log(`\nFAILS: ${fails.length ? fails.join(', ') : 'none'}`);
report(q, 'sessions');
await q.close();
process.exit(fails.length ? 1 : 0);
