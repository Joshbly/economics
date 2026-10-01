// Save / Load / Export / Import / New realm (every scenario) / Continue.
import { open, report, OUT } from './lib.mjs';
import { readFileSync } from 'node:fs';

const q = await open({});
await q.ready();
const { page } = q;
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) fails.push(name);
};
const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()).join(' | '));
const menu = async (label) => {
  await page.click('.tb-menu-btn');
  await page.waitForTimeout(250);
  await page.click(`.menu-item:has-text("${label}")`);
  await page.waitForTimeout(300);
};

// Save (menu) and Cmd/Ctrl+S
await q.s('R.setSpeed(0)');
const day0 = await q.s('s.day');
await menu('Save');
await page.waitForTimeout(600);
check('save via menu', /saved/i.test(await toasts()), await toasts());
const meta = await page.evaluate(() => localStorage.getItem('realmLedger.save.meta'));
check('save meta written', !!meta, meta);
await page.keyboard.press('Control+s');
await page.waitForTimeout(600);
// advance, then load
await q.s('R.setSpeed(5)');
await page.waitForTimeout(1500);
await q.s('R.setSpeed(0)');
const day1 = await q.s('s.day');
await menu('Load saved realm');
await page.waitForTimeout(300);
await page.locator('.modal-backdrop.on .btn-primary').click();
await page.waitForTimeout(800);
const day2 = await q.s('s.day');
check('load restores saved day', day2 === day0 && day1 > day0, `${day0} -> ${day1} -> ${day2}`);
check('load leaves no panel errors', (await page.locator('.panel-error').count()) === 0);

// Export
const [dl] = await Promise.all([page.waitForEvent('download'), menu('Export to file')]);
const path = OUT + '/' + dl.suggestedFilename();
await dl.saveAs(path);
const json = readFileSync(path, 'utf8');
check('export downloads JSON', json.startsWith('{') && json.length > 10000, `${dl.suggestedFilename()} ${(json.length / 1024).toFixed(0)} KB`);

// Import (after advancing)
await q.s('R.setSpeed(5)');
await page.waitForTimeout(1200);
await q.s('R.setSpeed(0)');
const [fc] = await Promise.all([page.waitForEvent('filechooser'), menu('Import from file')]);
await fc.setFiles(path);
await page.waitForTimeout(800);
await page.locator('.modal-backdrop.on .btn-primary').click();
await page.waitForTimeout(800);
check('import restores exported day', (await q.s('s.day')) === day0, String(await q.s('s.day')));
// Import garbage
const bad = OUT + '/bad.json';
(await import('node:fs')).writeFileSync(bad, '{"nope": true}');
const [fc2] = await Promise.all([page.waitForEvent('filechooser'), menu('Import from file')]);
await fc2.setFiles(bad);
await page.waitForTimeout(800);
const badModal = await page.locator('.modal-backdrop.on').textContent().catch(() => '');
check('import bad file shows error', /not a realm/i.test(badModal), badModal.slice(0, 160));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// New realm with each scenario
const scen = ['founding', 'longwinter', 'creditboom', 'golden', 'isolated']; // (the order of the scenario list)
for (const id of scen) {
  await menu('Found a new realm');
  const modal = page.locator('.modal-backdrop.on');
  await modal.locator('select').selectOption({ index: scen.indexOf(id) });
  await modal.locator('input').first().fill('QA ' + id);
  await modal.locator('.btn-primary').click();
  const t0 = Date.now();
  await page.waitForFunction((n) => window.__realm?.s?.settings?.realmName === n && !document.querySelector('.founding-overlay'), 'QA ' + id, { timeout: 90000 });
  await page.waitForTimeout(800);
  const st = await q.s('({scen: s.settings.scenario, day: s.day, name: s.settings.realmName, pop: s.people.filter(p=>p&&p.alive).length, levies: s.policy.levies.length, purse: s.treasury.purse})');
  const pe = await page.locator('.panel-error').count();
  check(`new realm "${id}"`, st.scen === id && pe === 0, `${JSON.stringify(st)} in ${Date.now() - t0} ms`);
  await q.s('R.setSpeed(5)');
  await page.waitForTimeout(2500);
  await q.s('R.setSpeed(0)');
  await q.shot('persist-' + id);
}
await page.waitForTimeout(300);
// Reload the page: boot screen offers Continue
await page.evaluate(() => sessionStorage.setItem('__qa_init', '1'));
await page.reload();
await page.waitForTimeout(1200);
await q.shot('persist-bootscreen');
const choices = await page.locator('button.choice').allTextContents();
check('boot screen shows continue choices', choices.length >= 2, choices.join(' || '));
await page.locator('button.choice.primary').click();
await page.waitForFunction(() => !!window.__realm?.s, null, { timeout: 30000 });
await page.waitForTimeout(600);
check('continue opens last realm', (await q.s('s.settings.realmName')) === 'QA isolated', await q.s('s.settings.realmName'));
// Found a new realm from the boot screen
await page.reload();
await page.waitForTimeout(1000);
await page.locator('button.choice:has-text("Found a new realm")').click();
await page.waitForTimeout(300);
await q.shot('persist-bootscreen-new');
await page.locator('.screen-form input').first().fill('Boot QA');
await page.locator('button:text-is("Found the realm")').click();
await page.waitForFunction(() => window.__realm?.s?.settings?.realmName === 'Boot QA', null, { timeout: 90000 });
check('found from boot screen', true);
console.log('\nFAILS:', fails.length ? fails.join('; ') : 'none');
report(q, 'persist');
await q.close();
