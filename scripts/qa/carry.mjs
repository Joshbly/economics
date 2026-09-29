// Drive a supply line built from primitives in the built game: a buy order in one town (Goods),
// a carry rule to another (Carry), and a sell order there (the Carry form's "Sell in …" button);
// then In force (three rows, the carry row's wagons chips), the stores view and the map.
//   node scripts/qa/carry.mjs
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
const T = `.lv-item[data-lever="trade"] .lv-body`;
await q.lever('trade');

// the Trade kinds: no Route composer, a Carry form; no separate Move goods form
const kinds = await page.locator(`${T} .lv-kindrow .seg-btn`).allTextContents();
check('Trade kinds are Goods · Carry · Labour · IOUs · Gold', kinds.join('|') === 'Goods|Carry|Labour|IOUs|Gold', kinds.join('|'));
check('no Move goods form', (await page.locator(`${T} .lv-subform`).count()) === 0);

// 1) buy bread in the farm town, patiently within +10 %
const farm = await q.s(`s.towns.find(t => t.kind === 'farm').id`);
const harbor = await q.s(`s.towns.find(t => t.kind === 'harbor').id`);
await page.locator(`${T} .seg-btn:text-is("Goods")`).click();
const gsel = page.locator(`${T} form`).first().locator('select');
await gsel.nth(0).selectOption({ index: farm });
await gsel.nth(1).selectOption({ label: 'Bread' });
await page.locator(`${T} .seg-btn:text-is("Buy")`).first().click();
await page.locator(`${T} .seg-btn:text-is("±10%"):visible`).first().click();
await page.locator(`${T} .lv-submit:visible`).first().click();
await page.waitForTimeout(300);
const buy = await q.s('s.policy.orders[s.policy.orders.length - 1]');
check('buy order placed in the farm town', buy && buy.side === 'buy' && buy.market.town === farm && buy.priceMode === 'follow', JSON.stringify(buy && { town: buy.market.town, mode: buy.priceMode }));

// 2) carry everything held there to the harbour, in full wagons (the form starts from the Goods market)
await page.locator(`${T} .seg-btn:text-is("Carry")`).click();
await page.waitForTimeout(300);
const cf = page.locator(`${T} .lv-carry form`);
const csel = cf.locator('select');
check('carry form starts from the market being traded', Number(await csel.nth(0).inputValue()) === farm, `from=${await csel.nth(0).inputValue()}`);
await csel.nth(1).selectOption({ index: harbor });
await cf.locator('.seg-btn:text-is("Everything")').click();
await cf.locator('.seg-btn:text-is("Full wagons")').click();
await cf.locator('.seg-btn:text-is("Until removed")').click();
await page.waitForTimeout(200);
const pv = (await cf.locator('.lv-preview').textContent()) ?? '';
check('carry preview explains freight and where it lands', /freight ≈ ¤/.test(pv) && /lands in the Treasury’s store in/.test(pv), pv.slice(0, 200));
await q.shot('carry-form');
await cf.locator('.lv-submit').click();
await page.waitForTimeout(300);
const cr = await q.s('s.policy.carries[0]');
check('carry rule placed', cr && cr.from === farm && cr.to === harbor && cr.qty === -1 && cr.wagons === 'full', JSON.stringify(cr && { from: cr.from, to: cr.to, qty: cr.qty, wagons: cr.wagons }));

// 3) "Sell in <harbour>…" opens the Goods form there, selling; offer at any price
await cf.locator('.lv-chip', { hasText: 'Sell in' }).click();
await page.waitForTimeout(300);
const gv = await gsel.nth(0).inputValue();
const sideOn = await page.locator(`${T} .seg-btn.on:visible, ${T} .seg-btn[aria-pressed="true"]:visible`).allTextContents();
check('Sell in … opens the Goods form on the destination market', Number(gv) === harbor && sideOn.includes('Sell'), `town=${gv} on=${sideOn.join('/')}`);
await page.locator(`${T} .seg-btn:text-is("Any"):visible`).first().click();
await page.locator(`${T} .lv-submit:visible`).first().click();
await page.waitForTimeout(300);
const sell = await q.s('s.policy.orders[s.policy.orders.length - 1]');
check('sell order placed at the harbour', sell && sell.side === 'sell' && sell.market.town === harbor && sell.priceMode === 'any', JSON.stringify(sell && { town: sell.market.town, side: sell.side, mode: sell.priceMode }));

// run: bread is bought, carried and sold
await q.s(`R.setSpeed(3)`);
await page.waitForTimeout(6000);
await q.s(`R.setSpeed(0)`);
await page.waitForTimeout(400);
const st = await q.s(`({ bought: s.policy.orders[0].filled, carried: s.policy.carries[0].carried, sold: s.policy.orders[1].filled, day: s.day })`);
check('bread bought, carried and sold', st.bought > 0 && st.carried > 0 && st.sold > 0, JSON.stringify(st));

// In force: three rows; the carry row with its wagons chips
await page.evaluate(() => document.querySelector('.lv-inforce')?.scrollIntoView());
await page.waitForTimeout(300);
const heads = await page.evaluate(() => [...document.querySelectorAll('.lv-inforce .lv-if-head')].map((e) => e.textContent.trim()));
check('In force lists Buy, Sell and Carry rows', heads.some((x) => /^Buy/.test(x)) && heads.some((x) => /^Sell/.test(x)) && heads.some((x) => /^Carry/.test(x)), heads.join(' | ').slice(0, 300));
const carryRow = page.locator('.lv-inforce .lv-if').filter({ hasText: /^Carry/ }).first();
check('carry row: full wagons marked, right away offered', (await carryRow.locator('.lv-chip.on').allTextContents()).join('|') === 'full wagons');
await carryRow.locator('.lv-chip:text-is("right away")').click();
await page.waitForTimeout(250);
check('switching the carry rule to right away', (await q.s('s.policy.carries[0].wagons')) === 'now');
await q.shot('carry-inforce');

// stores & wagons: no route pipelines, the carry-rules tile
const flows = await page.locator(`${T} .lv-flows`).first().textContent();
check('stores view shows carry rules, not routes', /Carrying/.test(flows ?? '') && !/Supply routes/.test(flows ?? ''), (flows ?? '').slice(0, 200));

// the map draws the rule
const drawn = await page.evaluate(() => (window.__realm.ui.game.s.policy.carries ?? []).length);
check('a carry rule exists for the map layer', drawn === 1);
await q.shot('carry-map');

// no modern policy names anywhere in the panel
const txt = await page.locator('.lv-item[data-lever="trade"]').innerText();
check('neutral wording', !/\b(tax|subsid\w*|tariff\w*|quota\w*|stimulus|bailout)\b/i.test(txt));

console.log(`\nFAILS: ${fails.length ? fails.join(', ') : 'none'}`);
report(q, 'carry');
await q.close();
process.exit(fails.length ? 1 : 0);
