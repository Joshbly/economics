// Drive the Levy composer's "Aim at a price" rate, the Build → road preview and the top bar's
// early figures in the built game.
//   node scripts/qa/aimlevy.mjs
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
const body = `.lv-item[data-lever="levy"] .lv-body`;
await q.lever('levy');
await page.locator(`${body} .seg-btn:text-is("Pay")`).first().click();
// who: households
await page.locator(`${body} .lv-cond-who select`).selectOption({ label: 'Any household' });
await page.waitForTimeout(200);
await page.locator(`${body} .seg-btn:text-is("Aim at a price")`).first().click();
await page.waitForTimeout(300);
check('aim fields shown', await page.locator(`${body} .lv-aim-f`).isVisible());
check('rate % field hidden', !(await page.locator(`${body} .lv-sentence .num-ctl`).first().isVisible()));
const hintTxt = (await page.locator(`${body} .lv-hint`).first().textContent()) ?? '';
check('per-town starting rates listed', /Going price now → rate it would start at/.test(hintTxt), hintTxt.slice(0, 220));
const aimIn = page.locator(`${body} .lv-aim-f input`).first();
await aimIn.fill('2.4');
await aimIn.press('Tab');
await page.waitForTimeout(250);
const decree = (await page.locator(`${body} .lv-decree`).textContent()) ?? '';
check('decree in neutral words', /pays part of the price of bread bought by households — re-set each morning in each town so that they pay about ¤2\.40 a loaf/.test(decree) && !/subsid|tax/i.test(decree), decree);
await q.shot('aim-levy-form');
await page.locator(`${body} .lv-submit`).first().click();
await page.waitForTimeout(400);
const l = await q.s(`s.policy.levies[s.policy.levies.length - 1]`);
check('aimed rule enacted', l && l.aim === 2.4 && l.group === 'persons' && Array.isArray(l.aimRates), JSON.stringify(l && { aim: l.aim, aimMax: l.aimMax, rates: l.aimRates }));
await q.s(`R.setSpeed(3)`);
await page.waitForTimeout(3500);
await q.s(`R.setSpeed(0)`);
await page.evaluate(() => document.querySelector('.lv-inforce')?.scrollIntoView());
await page.waitForTimeout(300);
const row = await page.evaluate(() => [...document.querySelectorAll('.lv-if')].map((e) => e.textContent.replace(/\s+/g, ' ')).join(' | '));
check('In force shows the aim and each town’s rate', /aim ¤2\.40/.test(row) && /Today: .*%/.test(row), row.slice(0, 300));
await q.shot('aim-levy-inforce');

// top bar moves in the first days
const tb = await page.evaluate(() => document.querySelector('.topbar, header')?.innerText.replace(/\s+/g, ' '));
check('top bar shows price and output changes early', /PRICES [\d.]+ [▲▼→]?[+−-]?[\d.]+% so far/.test(tb) && /OUTPUT [\d.]+ [▲▼→]?[+−-]?[\d.]+% so far/.test(tb), tb.slice(0, 260));

// Build → road preview
await q.lever('build');
const bb = `.lv-item[data-lever="build"] .lv-body`;
const selects = page.locator(`${bb} select`);
await selects.nth(0).selectOption({ index: 0 });
await selects.nth(1).selectOption({ index: 2 });
await page.waitForTimeout(400);
const desc = await page.evaluate((sel) => document.querySelector(sel)?.innerText ?? '', bb);
check('road preview says what paving does', /existing dirt track in place/.test(desc) && /Trips it speeds up: .* → .* days, freight ¤[\d.]+ → ¤[\d.]+ a unit/.test(desc), desc.replace(/\s+/g, ' ').slice(0, 400));
await q.shot('build-road-preview');

console.log(`\nFAILS: ${fails.length ? fails.join(', ') : 'none'}`);
report(q, 'aimlevy');
await q.close();
process.exit(fails.length ? 1 : 0);
