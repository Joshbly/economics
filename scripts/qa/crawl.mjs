// Click every button in every panel (and every inspector view) once; report
// errors, panel-error boxes and where each click led.
import { open, report } from './lib.mjs';

const q = await open({});
await q.ready();
const { page } = q;
await q.s('R.setSpeed(3)');
await page.waitForTimeout(3000); // a few days of daily series
await q.s('R.setSpeed(0)');
const issues = [];
const panelErrors = async () => page.evaluate(() => [...document.querySelectorAll('.panel-error')].map((e) => e.textContent.slice(0, 300)));
const closeModals = async () => {
  for (let i = 0; i < 3 && (await page.$('.modal-backdrop.on')); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
};

async function crawl(label, scopeSel, reset, max = 120) {
  await reset();
  await page.waitForTimeout(300);
  const n = await page.locator(`${scopeSel} button:visible, ${scopeSel} select:visible`).count();
  console.log(`\n## ${label}: ${n} controls`);
  const seen = [];
  for (let i = 0; i < Math.min(n, max); i++) {
    await reset();
    await page.waitForTimeout(120);
    const els = page.locator(`${scopeSel} button:visible, ${scopeSel} select:visible`);
    if (i >= (await els.count())) break;
    const el = els.nth(i);
    const tag = await el.evaluate((e) => e.tagName);
    const text = ((await el.textContent()) || (await el.getAttribute('title')) || (await el.getAttribute('aria-label')) || '').trim().slice(0, 40);
    const before = q.errors.length;
    try {
      if (tag === 'SELECT') {
        const vals = await el.locator('option').evaluateAll((os) => os.map((o) => o.value));
        for (const v of vals.slice(0, 14)) {
          await el.selectOption(v);
          await page.waitForTimeout(60);
        }
      } else {
        if (await el.isDisabled()) continue;
        await el.click({ timeout: 2000 });
      }
    } catch (e) {
      seen.push(`  ! ${tag} "${text}": ${e.message.split('\n')[0]}`);
      continue;
    }
    await page.waitForTimeout(200);
    const where = await q.s('ui.tab + " " + JSON.stringify(ui.selection) + (ui.placing ? " placing" : "")');
    const modal = (await page.$('.modal-backdrop.on')) ? ' [modal: ' + (await page.locator('.modal-backdrop.on .modal-title, .modal-backdrop.on h2').first().textContent().catch(() => '?')) + ']' : '';
    const pe = await panelErrors();
    const newErr = q.errors.slice(before);
    seen.push(`  ${tag === 'SELECT' ? 'sel' : 'btn'} "${text}" -> ${where}${modal}${pe.length ? ' PANEL-ERROR ' + pe.join('|') : ''}${newErr.length ? ' ERR ' + newErr.join('|').slice(0, 300) : ''}`);
    if (pe.length || newErr.length) issues.push(`${label}: "${text}" ${pe.join('|')} ${newErr.join('|').slice(0, 300)}`);
    await closeModals();
    if (await q.s('!!ui.placing')) await page.keyboard.press('Escape');
  }
  console.log(seen.join('\n'));
}

const tabReset = (name) => async () => {
  await closeModals();
  if ((await q.s('ui.tab')) !== name) await q.s(`R.setTab('${name}')`);
};
for (const t of ['markets', 'ledger', 'charts', 'people', 'almanac']) {
  await crawl(`tab ${t}`, `section.panel[data-panel="${t}"]`, tabReset(t), 90);
  await q.s(`R.setTab('${t}')`);
  await page.waitForTimeout(300);
  await q.shot('crawl-' + t);
}

const ids = await q.s(`(() => {
  const b = s.buildings.find(b => b && b.kind === 'house' && b.residents?.length);
  const f = s.firms.find(f => f && f.alive && f.workers?.length > 2);
  const tr = s.firms.find(f => f && f.alive && f.sector === 'trader');
  const p = s.people.find(p => p && p.alive && p.job >= 0);
  const fb = f ? f.building : -1;
  const mk = s.buildings.find(b => b && b.kind === 'market');
  return { house: b?.id, firm: f?.id, trader: tr?.id, person: p?.id, firmBuilding: fb, bank: s.buildings.find(b => b && b.kind === 'bank')?.id, mk: mk?.id, kinds: [...new Set(s.buildings.filter(Boolean).map(b => b.kind))] };
})()`);
console.log('ids', JSON.stringify(ids));
const selReset = (sel) => async () => {
  await closeModals();
  const cur = await q.s('JSON.stringify(ui.selection)');
  if (cur !== JSON.stringify(sel) || (await q.s('ui.tab')) !== 'inspect') await q.s(`R.select(${JSON.stringify(sel)})`);
};
for (const [label, sel] of [
  ['inspect house', { kind: 'building', id: ids.house }],
  ['inspect firm', { kind: 'firm', id: ids.firm }],
  ['inspect trader', { kind: 'firm', id: ids.trader }],
  ['inspect firm building', { kind: 'building', id: ids.firmBuilding }],
  ['inspect bank', { kind: 'building', id: ids.bank }],
  ['inspect person', { kind: 'person', id: ids.person }],
  ['inspect town', { kind: 'town', id: 1 }],
]) {
  if (sel.id === undefined || sel.id === null || sel.id < 0) {
    console.log('skip', label);
    continue;
  }
  await crawl(label, 'section.panel[data-panel="inspect"]', selReset(sel), 40);
  await selReset(sel)();
  await page.waitForTimeout(300);
  await q.shot('crawl-' + label.replace(/ /g, '-'));
}

console.log('\nISSUES:', issues.length ? '\n' + issues.join('\n') : 'none');
report(q, 'crawl');
await q.close();
