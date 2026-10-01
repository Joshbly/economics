// Drive the trading desk in the built game: open it from Trade, set a price bracket on grain at the realm's
// price, let the realm run with the window up, edit / pause / remove it, place orders in every town at once,
// drag the window, and open it again from the Markets panel.
//   node scripts/qa/desk.mjs
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
const nTowns = await q.s('s.towns.length');

// open from the Trade lever
await q.lever('trade');
await page.locator('.lv-item[data-lever="trade"] .lv-desk-row .btn').click();
await page.waitForTimeout(400);
const W = '.float-win.desk-win';
check('desk opens as a floating window (no backdrop)', (await page.locator(W).count()) === 1 && (await page.locator('.modal-backdrop').count()) === 0);
check('chart drawn', (await page.locator(`${W} canvas, ${W} svg`).count()) > 0);
const rows = await page.locator(`${W} tbody tr`).count();
check('one row per town', rows === nTowns, `${rows} rows, ${nTowns} towns`);
await q.shot('desk_open');

// grain, at the realm's price, a ladder of two
await page.locator(`${W} .desk-head select`).selectOption({ label: 'Grain' });
await page.waitForTimeout(150);
await page.locator(`${W} .seg-btn:text-is("The realm’s price")`).click();
await page.locator(`${W} .seg-btn:text-is("2 steps")`).click();
const preview = (await page.locator(`${W} .desk-preview`).textContent()) ?? '';
check('preview speaks of the realm’s going price', /realm’s going price/.test(preview), preview.slice(0, 160));
await page.locator(`${W} .btn:text-is("Set the bracket")`).click();
await page.waitForTimeout(300);
const b0 = await q.s('s.policy.brackets && s.policy.brackets[0]');
check('bracket set', !!b0 && b0.mode === 'realm' && b0.rungs === 2, JSON.stringify(b0 && { mode: b0.mode, good: b0.good, rungs: b0.rungs }));
check('submit turns into Update', (await page.locator(`${W} .btn:text-is("Update the bracket")`).count()) === 1);

// the realm runs with the window up; Space (outside an input) still pauses
await page.locator(`${W} .float-title`).click();
const day0 = await q.s('s.day');
await q.s('R.setSpeed(5)');
await page.waitForTimeout(3500);
await q.s('R.setSpeed(0)');
const day1 = await q.s('s.day');
check('realm ran while the desk was open', day1 > day0 + 3, `${day0} -> ${day1}`);
await page.waitForTimeout(300);
const item = (await page.locator(`${W} .desk-item-s`).first().textContent()) ?? '';
check('the bracket’s tally shows', /Bought .* sold .* holds/.test(item), item.slice(0, 160));
const b1 = await q.s('s.policy.brackets[0]');
console.log('   bracket after', day1 - day0, 'days:', JSON.stringify({ bought: b1.bought, sold: b1.sold, today: b1.today }));

// In force lists it
await page.evaluate(() => document.querySelector('.lv-inforce')?.scrollIntoView());
const heads = await page.evaluate(() => [...document.querySelectorAll('.lv-inforce .lv-if-head')].map((e) => e.textContent.trim()));
check('In force lists the bracket', heads.some((x) => /^Bracket/.test(x)), heads.join(' | ').slice(0, 200));
check('Trade summary counts it', /bracket/.test((await page.locator('.lv-head[data-lever="trade"]').textContent()) ?? ''));

// edit: more a day
await page.locator(`${W} .desk-item .btn:text-is("Edit")`).click();
const buyIn = page.locator(`${W} .desk-row`, { hasText: 'Buy a day' }).locator('input').first();
await buyIn.fill('35');
await buyIn.dispatchEvent('input');
await page.locator(`${W} .btn:text-is("Update the bracket")`).click();
await page.waitForTimeout(250);
check('edited', (await q.s('s.policy.brackets[0].buyQty')) === 35, String(await q.s('s.policy.brackets[0].buyQty')));
check('Enter in a field does not close the desk', await (async () => {
  await buyIn.press('Enter');
  await page.waitForTimeout(200);
  return (await page.locator(W).count()) === 1;
})());

// orders in every town at once
const n0 = await q.s('s.policy.orders.length');
await page.locator(`${W} .btn:text-is("Place the orders")`).click();
await page.waitForTimeout(300);
const n1 = await q.s('s.policy.orders.length');
check('one order in each town', n1 - n0 === nTowns, `${n0} -> ${n1}`);
const placed = await q.s(`s.policy.orders.slice(-${nTowns}).map(o => [o.market.town, o.market.good, o.side, o.priceMode].join(':'))`);
check('orders are grain buys following the price', placed.every((x) => /:buy:follow$/.test(x) && x.split(':')[1] === String(b0.good)), placed.join(' '));

// pause, then remove
await page.locator(`${W} .desk-item .toggle, ${W} .desk-item [role="switch"]`).first().click();
await page.waitForTimeout(200);
check('paused', (await q.s('s.policy.brackets[0].enabled')) === false);
await page.locator(`${W} .desk-item .btn:text-is("Remove")`).click();
await page.waitForTimeout(200);
check('removed', (await q.s('(s.policy.brackets || []).length')) === 0);

// a fixed-price bracket: the floor and ceiling fields are prices (¤), near the going price
await page.locator(`${W} .seg-btn:text-is("Fixed prices")`).click();
await page.waitForTimeout(150);
const vis = await page.evaluate((W) => [...document.querySelectorAll(`${W} .desk-num input`)].filter((i) => i.offsetParent).map((i) => Number(i.value.replace(/,/g, ''))), W);
const mean = await q.s(`(() => { const g = ${b0.good}; let a = 0; for (const t of s.towns) a += s.markets[t.id * s.markets.length / s.towns.length + g].ema; return a / s.towns.length; })()`);
check('fixed mode shows two prices', vis.length === 2 && vis[0] > 0 && vis[0] < vis[1] && Math.abs(vis[0] / mean - 0.9) < 0.1, `${vis.join(', ')} vs mean ${mean.toFixed(2)}`);
await page.locator(`${W} .btn:text-is("Set the bracket")`).click();
await page.waitForTimeout(250);
const bf = await q.s('s.policy.brackets && s.policy.brackets[0]');
check('fixed bracket set at those prices', !!bf && bf.mode === 'fixed' && Math.abs(bf.low - vis[0]) < 0.011 && Math.abs(bf.high - vis[1]) < 0.011, JSON.stringify(bf && { mode: bf.mode, low: bf.low, high: bf.high }));
await page.locator(`${W} .desk-item .btn:text-is("Edit")`).click();
await page.waitForTimeout(150);
const vis2 = await page.evaluate((W) => [...document.querySelectorAll(`${W} .desk-num input`)].filter((i) => i.offsetParent).map((i) => Number(i.value.replace(/,/g, ''))), W);
check('editing a fixed bracket shows its prices', Math.abs(vis2[0] - bf.low) < 0.011 && Math.abs(vis2[1] - bf.high) < 0.011, vis2.join(', '));
await page.locator(`${W} .desk-item .btn:text-is("Remove")`).click();
await page.waitForTimeout(200);

// drag the window by its title bar
const box0 = await page.locator(W).boundingBox();
await page.mouse.move(box0.x + 200, box0.y + 20);
await page.mouse.down();
await page.mouse.move(box0.x + 60, box0.y + 90, { steps: 6 });
await page.mouse.up();
const box1 = await page.locator(W).boundingBox();
check('drags', Math.abs(box1.x - box0.x + 140) < 3 && Math.abs(box1.y - box0.y - 70) < 3, `${Math.round(box0.x)},${Math.round(box0.y)} -> ${Math.round(box1.x)},${Math.round(box1.y)}`);
await q.shot('desk_dragged');

// close; reopen from Markets, Esc closes it
await page.locator(`${W} .float-x`).click();
await page.waitForTimeout(250);
check('closes', (await page.locator(W).count()) === 0);
await q.tab('Markets');
await page.locator('.mk-head-btns .btn:text-is("Trading desk")').click();
await page.waitForTimeout(350);
check('opens from Markets', (await page.locator(W).count()) === 1);
await page.locator(`${W} select`).first().focus();
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
check('Esc closes it', (await page.locator(W).count()) === 0);

// a small screen
await page.setViewportSize({ width: 1100, height: 720 });
await page.locator('.mk-head-btns .btn:text-is("Trading desk")').click();
await page.waitForTimeout(350);
const bx = await page.locator(W).boundingBox();
check('fits a small screen', bx.x >= 0 && bx.x + bx.width <= 1100 && bx.y + bx.height <= 720, JSON.stringify(bx));
await q.shot('desk_small');

const errs = report(q, 'desk');
if (errs.length) fails.push('console errors');
await q.close();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
