// Drive Build → Freight line in the built game: open a Treasury freight line through the
// composer, run the clock, and check that its card (Build, Trade → stores & wagons, In force)
// shows it working, that it is drawn on the map, then pause, resume, change the fare and close it.
//   node scripts/qa/freightline.mjs   (needs a fresh `npm run build`)
//   (a cached autosave from before freight lines exercises the save migration too)
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
const body = L('build');
const confirmModal = async () => {
  await page.waitForTimeout(250);
  if (await page.$('.modal-backdrop.on')) {
    console.log('   [modal]', (await page.locator('.modal-backdrop.on .modal').textContent()).slice(0, 160));
    await page.locator('.modal-backdrop.on .btn-primary, .modal-backdrop.on .btn-danger').last().click();
    await page.waitForTimeout(250);
  }
};
async function num(scope, label, v) {
  const row = page.locator(`${scope} .lv-row`).filter({ has: page.locator(`.lv-lab:text-is("${label}")`) }).first();
  const inp = row.locator('input.num-field').first();
  await inp.fill(String(v));
  await inp.press('Tab');
}

await q.s('R.setSpeed(0)');
check('save loads with an empty list of lines', await q.s('Array.isArray(s.policy.lines) && s.policy.lines.length === 0'), String(await q.s('JSON.stringify(s.policy.lines)')));
check('shipments carry a line tag', await q.s('s.shipments.every((x) => x.line === -1)'));
await page.evaluate(() => window.__realm.ui.game.dispatch({ type: 'setAutoMint', value: true }));
const towns = await q.s('s.towns.map((t) => ({ id: t.id, kind: t.kind, name: t.name }))');
const cap = towns.find((t) => t.kind === 'capital');
const farm = towns.find((t) => t.kind === 'farm');

// ---- the composer ----
await q.lever('build');
await page.locator(`${body} .seg-btn:text-is("Freight line")`).first().click();
await page.waitForTimeout(250);
const between = page.locator(`${body} .lv-row`).filter({ has: page.locator('.lv-lab:text-is("Between")') }).first();
await between.locator('select').nth(0).selectOption(String(cap.id));
await between.locator('select').nth(1).selectOption(String(farm.id));
await num(body, 'Wagons', 5);
await page.locator(`${body} .seg-btn:text-is("Free")`).first().click();
await page.waitForTimeout(300);
const what = await page.locator(`${body} .lv-what`).first().textContent();
check('composer describes the line', what.includes(`Freight line ${cap.name} ⇄ ${farm.name}`) && /keeps 5 wagons in/.test(what) && /pay nothing/.test(what), what.slice(0, 220));
const prev = await page.locator(`${body} .lv-preview`).first().textContent();
check('preview compares the trading houses’ own freight and the line’s running cost', /Trading houses’ own wagons today: ¤[\d.]+ a unit/.test(prev) && /a day with every wagon on the road/.test(prev), prev.slice(0, 260));
check('no modern policy words', !/subsid|tax|nationali|public transit|tariff/i.test(what + prev));
await q.shot('fl-composer');
await page.locator(`${body} .lv-submit:visible`).first().click();
await confirmModal();
await page.waitForTimeout(300);
const L0 = await q.s('s.policy.lines[0] ?? null');
check('line opened through the UI', !!L0 && L0.a === cap.id && L0.b === farm.id && L0.wagonsWanted === 5 && L0.fare === 'free', JSON.stringify(L0 && { a: L0.a, b: L0.b, n: L0.wagonsWanted, fare: L0.fare }));
check('card appears under the composer', (await page.locator(`${body} .lv-ln`).count()) === 1);
const msg = await page.locator(`${body} .lv-msg`).first().textContent().catch(() => '');
check('composer confirms', /Line opened/.test(msg), msg);

// ---- run the clock ----
await q.s('R.setSpeed(4)');
await page.waitForFunction(() => (window.__realm.s.policy.lines[0]?.carried ?? 0) > 200, null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);
await q.s('R.setSpeed(0)');
await page.waitForTimeout(400);
const L1 = await q.s('s.policy.lines[0]');
check('the line bought wagons, hired drivers, carried goods', L1.wagons >= 1 && L1.crew >= 1 && L1.carried > 0 && L1.legs > 0, JSON.stringify({ wagons: L1.wagons, crew: L1.crew, carried: Math.round(L1.carried), legs: L1.legs, wages: Math.round(L1.wages) }));
check('free fares: nothing received, the Purse pays the running cost', L1.fares === 0 && L1.wages + L1.fuelCost > 0);
const cardTxt = await page.locator(`${body} .lv-ln`).first().textContent();
check('card shows carried units and the result', /In all/.test(cardTxt) && /Result/.test(cardTxt) && /−¤/.test(cardTxt), cardTxt.slice(0, 300));
const allCell = await page.locator(`${body} .lv-ln .lv-pipe-c:nth-child(3) .lv-pipe-v`).first().textContent();
check('carried-in-all cell is non-zero', allCell.trim() !== '0' && allCell.trim() !== '', allCell);
await q.shot('fl-card');

// map: the line is in the route layer and wagons on it are Treasury-tagged
const onMap = await q.s('R.map && s.shipments.some((x) => x.line === s.policy.lines[0].id)');
check('line cargo on the road (tagged for the map)', onMap);
await page.evaluate(() => window.__realm.setTab('levers'));

// ---- In force ----
await page.evaluate(() => document.querySelector('.lv-inforce')?.scrollIntoView());
await page.waitForTimeout(400);
const forceTxt = await page.evaluate(() => [...document.querySelectorAll('.lv-inforce .lv-grp')].map((g) => g.textContent).join(' | '));
check('In force lists the freight line', /Freight lines/.test(forceTxt) && forceTxt.includes('⇄'), forceTxt.slice(0, 200));
await q.shot('fl-inforce');

// ---- Trade → Treasury stores & wagons ----
await q.lever('trade');
await page.waitForTimeout(400);
const flowsTxt = await page.evaluate(() => document.querySelector('.lv-item[data-lever="trade"] .lv-flows')?.textContent ?? '');
check('Treasury stores & wagons shows the line', /Freight lines/.test(flowsTxt) && flowsTxt.includes('⇄'), flowsTxt.slice(0, 160));

// ---- Ledger: fares category known ----
await q.lever('build');
await page.waitForTimeout(300);

// ---- pause, resume, fare, wagons, close ----
await page.locator(`${body} .lv-ln .switch`).first().click();
await page.waitForTimeout(300);
check('pause from the card', (await q.s('s.policy.lines[0].enabled')) === false);
await page.locator(`${body} .lv-ln .switch`).first().click();
await page.waitForTimeout(300);
check('resume from the card', (await q.s('s.policy.lines[0].enabled')) === true);
await page.locator(`${body} .lv-ln .lv-chip:text-is("at cost")`).first().click();
await page.waitForTimeout(300);
check('fare switched to at cost', (await q.s('s.policy.lines[0].fare')) === 'cost');
await page.locator(`${body} .lv-ln .lv-chip:text-is("+1 wagon")`).first().click();
await page.waitForTimeout(300);
check('one wagon more', (await q.s('s.policy.lines[0].wagonsWanted')) === 6);
await q.s('R.setSpeed(3)');
await page.waitForTimeout(2500);
await q.s('R.setSpeed(0)');
const fares = await q.s('s.policy.lines[0].fares');
console.log('   fares received at cost so far:', fares.toFixed(2), '· fare today', (await q.s('s.policy.lines[0].fareToday')).toFixed(3));
// fares that earn: undercut the trading houses' own wagons, then cost + 20 %
const res0 = await q.s('s.policy.lines[0].fares - s.policy.lines[0].wages - s.policy.lines[0].fuelCost - s.policy.lines[0].wear');
await page.locator(`${body} .lv-ln .lv-chip:text-is("undercut 10%")`).first().click();
await page.waitForTimeout(300);
const Lu = await q.s('({ fare: s.policy.lines[0].fare, margin: s.policy.lines[0].margin })');
check('fare switched to undercut 10%', Lu.fare === 'under' && Math.abs(Lu.margin - 0.1) < 1e-9, JSON.stringify(Lu));
const termsU = (await page.locator(`${body} .lv-ln .lv-rt-sub`).first().textContent()) ?? '';
check('card names the undercut fare', /10% under theirs ≈ ¤/.test(termsU), termsU.slice(0, 200));
await q.s('R.setSpeed(3)');
await page.waitForTimeout(3000);
await q.s('R.setSpeed(0)');
const res1 = await q.s('s.policy.lines[0].fares - s.policy.lines[0].wages - s.policy.lines[0].fuelCost - s.policy.lines[0].wear');
const faresU = await q.s('s.policy.lines[0].fares');
check('undercut fares come in', faresU > fares, `${fares.toFixed(2)} → ${faresU.toFixed(2)}; result ${res0.toFixed(2)} → ${res1.toFixed(2)}`);
await page.locator(`${body} .lv-ln .lv-chip:text-is("cost +20%")`).first().click();
await page.waitForTimeout(300);
check('fare switched to cost +20%', (await q.s('s.policy.lines[0].fare')) === 'cost' && Math.abs((await q.s('s.policy.lines[0].margin')) - 0.2) < 1e-9);
await q.shot('fl-fares');
const tools0 = await q.s(`s.treasury.goods[${cap.id}][7]`);
const lineTools = await q.s('s.policy.lines[0].tools');
await page.locator(`${body} .lv-ln button[aria-label="Close line"]`).first().click();
await confirmModal();
await page.waitForTimeout(300);
const tools1 = await q.s(`s.treasury.goods[${cap.id}][7]`);
check('closing removes the line', (await q.s('s.policy.lines.length')) === 0);
check('closing hands its wagons to the Treasury’s stores', Math.abs(tools1 - tools0 - lineTools) < 1e-6 && lineTools > 0, `${tools0.toFixed(2)} + ${lineTools.toFixed(2)} → ${tools1.toFixed(2)}`);
await q.s('R.setSpeed(3)');
await page.waitForTimeout(1500);
await q.s('R.setSpeed(0)');
await q.shot('fl-closed');

console.log(`\nFAILS: ${fails.length ? fails.join(', ') : 'none'}`);
const errs = report(q, 'freightline');
await q.close();
process.exit(fails.length || errs.length ? 1 : 0);
