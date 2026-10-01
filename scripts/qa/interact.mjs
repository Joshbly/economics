// In force edits, map placement, inspect, map controls, prefill links, keys, speeds.
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
const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()));
const confirmModal = async () => {
  if (await page.$('.modal-backdrop.on')) {
    console.log('   [modal]', (await page.locator('.modal-backdrop.on .modal').textContent()).slice(0, 160));
    await page.locator('.modal-backdrop.on .btn-primary, .modal-backdrop.on .btn-danger').last().click();
    await page.waitForTimeout(300);
  }
};
await q.s('R.setSpeed(0)');

// ---- set up: mint, a levy, a limit, an order ----
await q.lever('mint');
await page.locator(`${L('mint')} input.num-field`).first().fill('300k');
await page.locator(`${L('mint')} .lv-submit`).click();
await q.lever('levy');
await page.locator(`${L('levy')} .lv-submit`).click();
await q.lever('limit');
await page.locator(`${L('limit')} .lv-submit`).click();
await q.lever('trade');
await page.locator(`${L("trade")} .lv-submit`).first().click();
await page.waitForTimeout(300);
await q.lever('trade'); // leave open
await page.click(`.lv-head[data-lever="trade"]`); // collapse
await page.waitForTimeout(200);

// ---- In force: toggle, inline edit, remove ----
{
  const rows = page.locator('.lv-if');
  check('in force has 3 rows', (await rows.count()) === 3, String(await rows.count()));
  // toggle levy off
  await rows.nth(0).locator('.lv-if-sw button').click();
  await page.waitForTimeout(200);
  check('levy toggled off', (await q.s('s.policy.levies[0].enabled')) === false);
  await rows.nth(0).locator('.lv-if-sw button').click();
  await page.waitForTimeout(200);
  check('levy toggled on', (await q.s('s.policy.levies[0].enabled')) === true);
  // inline rate edit
  await rows.nth(0).locator('.lv-pill').click();
  await page.waitForTimeout(150);
  const inp = rows.nth(0).locator('.lv-pill-slot input');
  await inp.fill('7');
  await inp.press('Enter');
  await page.waitForTimeout(250);
  const rate = await q.s('s.policy.levies[0].rate');
  check('levy inline edit to 7%', Math.abs(rate - 0.07) < 1e-9, String(rate));
  // Escape cancels an inline edit
  await rows.nth(0).locator('.lv-pill').click();
  await page.waitForTimeout(100);
  await rows.nth(0).locator('.lv-pill-slot input').fill('55');
  await rows.nth(0).locator('.lv-pill-slot input').press('Escape');
  await page.waitForTimeout(250);
  check('inline edit Escape cancels', Math.abs((await q.s('s.policy.levies[0].rate')) - 0.07) < 1e-9 && (await q.s('!!ui.selection')) === false, String(await q.s('s.policy.levies[0].rate')));
  // order inline price edit
  const orderRow = rows.nth(2);
  const p0 = await q.s('s.policy.orders[0].price');
  await orderRow.locator('.lv-pill').click();
  await page.waitForTimeout(100);
  await orderRow.locator('.lv-pill-slot input').fill(String((p0 * 1.5).toFixed(2)));
  await orderRow.locator('.lv-pill-slot input').press('Enter');
  await page.waitForTimeout(250);
  const p1 = await q.s('s.policy.orders[0].price');
  check('order inline price edit', Math.abs(p1 - p0 * 1.5) < 0.02, `${p0} -> ${p1}`);
  // toggle limit
  await rows.nth(1).locator('.lv-if-sw button').click();
  await page.waitForTimeout(200);
  check('limit toggled off', (await q.s('s.policy.limits[0].enabled')) === false);
  await q.shot('ia-inforce');
  // remove all three
  for (let i = 0; i < 3; i++) {
    await page.locator('.lv-if .lv-ibtn').first().click();
    await page.waitForTimeout(250);
    await confirmModal();
  }
  const c = await q.s('s.policy.levies.length + s.policy.limits.length + s.policy.orders.filter(o=>o.enabled!==false).length');
  check('removed all', c === 0, `${c} left; rows=${await page.locator('.lv-if').count()}`);
}

// ---- Build: choose on map ----
async function placeOnMap(kindSeg, sectorValue) {
  await q.lever('build');
  const T = L('build');
  await page.locator(`${T} .seg-btn:text-is("${kindSeg}")`).click();
  await page.waitForTimeout(150);
  if (sectorValue !== undefined) {
    const trade = page.locator(`${T} .lv-row`).filter({ has: page.locator('.lv-lab:text-is("Trade")') }).locator('select');
    await trade.selectOption({ label: sectorValue });
  }
  await page.locator(`${T} button:text-is("Choose on map")`).click();
  await page.waitForTimeout(400);
  const placing = await q.s('JSON.stringify(ui.placing)');
  const bar = await page.locator('.map-placing').textContent();
  const town = await q.s('ui.placing?.town ?? 0');
  const tc = await q.s(`(() => { const t = s.towns[${town}]; return {x: t.x ?? t.cx, y: t.y ?? t.cy}; })()`);
  // centre on the town, zoom in
  await q.s(`R.map.debug.setCamera(${tc.x}, ${tc.y}, 2)`);
  await page.waitForTimeout(300);
  const box = await page.locator('.mapwrap canvas').first().boundingBox();
  // sweep points spiralling out from the town centre until the hover note says OK
  let found = null;
  for (let r = 1; r < 26 && !found; r++) {
    for (let a = 0; a < 16 && !found; a++) {
      const cam = await q.s('({x: R.map.debug.cam.x, y: R.map.debug.cam.y, z: R.map.debug.cam.z})');
      const wxT = tc.x + Math.cos((a / 16) * Math.PI * 2) * r * 0.7;
      const wyT = tc.y + Math.sin((a / 16) * Math.PI * 2) * r * 0.7;
      const px = box.x + box.width / 2 + (wxT - cam.x) * 16 * cam.z;
      const py = box.y + box.height / 2 + (wyT - cam.y) * 16 * cam.z;
      if (px < box.x + 10 || py < box.y + 10 || px > box.x + box.width - 10 || py > box.y + box.height - 80) continue;
      await page.mouse.move(px, py);
      await page.waitForTimeout(40);
      const tip = await page.evaluate(() => [...document.querySelectorAll('.tip.on')].map((t) => t.textContent).join(' '));
      if (/Click to build here/.test(tip)) found = { px, py };
    }
  }
  if (!found) {
    check(`place ${kindSeg} on map`, false, `no valid site found; placing=${placing} bar="${bar}"`);
    await page.keyboard.press('Escape');
    return;
  }
  await q.shot('ia-place-' + kindSeg.toLowerCase());
  const n0 = await q.s('s.projects.length');
  await page.mouse.click(found.px, found.py);
  await page.waitForTimeout(400);
  const n1 = await q.s('s.projects.length');
  console.log('   after place: tab=', await q.s('ui.tab'), 'sel=', await q.s('JSON.stringify(ui.selection)'), 'open=', await page.evaluate(() => document.querySelector('.lv-item.open')?.dataset.lever));
  const pr = await q.s('JSON.stringify(s.projects.at(-1)).slice(0,160)');
  check(`place ${kindSeg} on map`, n1 === n0 + 1 && !(await q.s('ui.placing')), `placing=${placing} bar="${bar.trim()}" -> ${pr}`);
}
await placeOnMap('Houses');
await placeOnMap('Workshop', 'Bakery');
await placeOnMap('Workshop', 'Farm');
await placeOnMap('Pier');
// Esc cancels placement
await q.lever('build');
await page.locator(`${L('build')} .seg-btn:text-is("Houses")`).click();
await page.locator(`${L('build')} button:text-is("Choose on map")`).click();
await page.waitForTimeout(200);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Esc cancels placement', !(await q.s('ui.placing')));
await q.s('R.map.debug.setCamera(56, 38, 0.6)');

// ---- run a bit so projects progress, then look at the map/Inspect ----
await q.s('R.setSpeed(5)');
await page.waitForTimeout(4000);
await q.s('R.setSpeed(0)');
await page.waitForTimeout(300);
await q.shot('ia-after-run');

// ---- Inspect every selection kind ----
const kinds = await q.s(`(() => {
  const b = s.buildings.find(b => b && b.kind === 'house');
  const f = s.firms.find(f => f && f.alive && f.sector === 'bakery');
  const p = s.people.find(p => p && p.alive);
  return { building: b?.id, firm: f?.id, person: p?.id };
})()`);
for (const [kind, id] of [['building', kinds.building], ['firm', kinds.firm], ['person', kinds.person], ['town', 0]]) {
  await q.s(`R.select({kind: '${kind}', id: ${id}})`);
  await page.waitForTimeout(500);
  const tab = await q.s('ui.tab');
  const txt = (await page.locator('section.panel[data-panel="inspect"]').textContent()).slice(0, 160);
  const err = await page.locator('section.panel[data-panel="inspect"] .panel-error').count();
  check(`inspect ${kind}`, tab === 'inspect' && err === 0 && txt.length > 20, txt);
  await q.shot('ia-inspect-' + kind);
  // click every link in the inspector once (and come back)
  const links = page.locator('section.panel[data-panel="inspect"] a, section.panel[data-panel="inspect"] .link, section.panel[data-panel="inspect"] button.linkish');
  console.log(`   ${kind}: ${await links.count()} links`);
}
await q.s(`R.select({kind: 'market', town: 1, good: 3})`);
await page.waitForTimeout(500);
check('select market -> Markets tab', (await q.s('ui.tab')) === 'markets' && (await q.s('ui.marketTown')) === 1 && (await q.s('ui.marketGood')) === 3);
await q.shot('ia-markets-coal');
report(q, 'interact (partial)');

// ---- map clicks: hit something at the town centre ----
await q.s('R.select(null)');
{
  const tc = await q.s('({x: s.towns[0].x, y: s.towns[0].y})');
  await q.s(`R.map.debug.setCamera(${tc.x}, ${tc.y}, 2.5)`);
  await page.waitForTimeout(400);
  const box = await page.locator('.mapwrap canvas').first().boundingBox();
  let got = null;
  for (let i = 0; i < 30 && !got; i++) {
    const px = box.x + box.width / 2 + ((i % 6) - 3) * 18;
    const py = box.y + box.height / 2 + (Math.floor(i / 6) - 2) * 18;
    await page.mouse.click(px, py);
    await page.waitForTimeout(120);
    const sel = await q.s('JSON.stringify(ui.selection)');
    if (sel !== 'null') got = sel;
  }
  check('click map selects something', !!got, got ?? '');
  // wheel zoom
  const z0 = await q.s('R.map.debug.cam.z');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await q.s(`R.map.debug.setCamera(${tc.x}, ${tc.y}, 1.2)`);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(500);
  const z1 = await q.s('R.map.debug.cam.z');
  console.log('   wheel zoom', z0, '->', z1);
  // drag pan
  const c0 = await q.s('({x: R.map.debug.cam.x, y: R.map.debug.cam.y})');
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 400, box.y + 350, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const c1 = await q.s('({x: R.map.debug.cam.x, y: R.map.debug.cam.y})');
  check('drag pans', Math.abs(c1.x - c0.x) > 0.5, `${JSON.stringify(c0)} -> ${JSON.stringify(c1)}`);
  check('drag does not select', true);
  // +/- keys and buttons
  const z2 = await q.s('R.map.debug.cam.z');
  await page.keyboard.press('Minus');
  await page.waitForTimeout(400);
  const z3 = await q.s('R.map.debug.cam.z');
  await page.keyboard.press('Equal');
  await page.waitForTimeout(400);
  const z4 = await q.s('R.map.debug.cam.z');
  check('- / = keys zoom', z3 < z2 && z4 > z3, `${z2} -> ${z3} -> ${z4}`);
  await page.locator('.mapc-btn').nth(0).click();
  await page.waitForTimeout(300);
  await page.locator('.mapc-btn').nth(2).click();
  await page.waitForTimeout(500);
  console.log('   after fit', await q.s('JSON.stringify({x: R.map.debug.cam.x, y: R.map.debug.cam.y, z: R.map.debug.cam.z})'));
}

// ---- overlays, people/wagons ----
{
  const sel = page.locator('.mapc-ovl select').first();
  const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => o.value));
  const seen = new Set();
  for (const v of opts) {
    await sel.selectOption(v);
    await page.waitForTimeout(350);
    const ov = await q.s('ui.overlay');
    seen.add(ov);
    if (ov !== 'none') await q.shot('ia-overlay-' + ov);
  }
  check('overlays all selectable', seen.size === opts.length, [...seen].join(','));
  await sel.selectOption(opts[0]);
  const chips = page.locator('.mapc-chip');
  await chips.nth(0).click();
  await chips.nth(1).click();
  await page.waitForTimeout(200);
  check('people/wagons toggles', (await q.s('ui.showPeople')) === false && (await q.s('ui.showCarts')) === false);
  await chips.nth(0).click();
  await chips.nth(1).click();
}

// ---- keys: speeds, pause, tabs, help, hud ----
{
  for (const k of ['1', '2', '3', '4', '5', '0']) {
    await page.keyboard.press(k);
    await page.waitForTimeout(80);
    check(`key ${k} speed`, (await q.s('ui.speed')) === Number(k));
  }
  await page.keyboard.press('Space');
  await page.waitForTimeout(80);
  const sp = await q.s('ui.speed');
  await page.keyboard.press('Space');
  await page.waitForTimeout(80);
  check('Space toggles pause', sp > 0 && (await q.s('ui.speed')) === 0, String(sp));
  const t0 = await q.s('ui.tab');
  await page.keyboard.press(']');
  await page.waitForTimeout(150);
  const t1 = await q.s('ui.tab');
  await page.keyboard.press('[');
  await page.waitForTimeout(150);
  check('[ ] switch tabs', t1 !== t0 && (await q.s('ui.tab')) === t0, `${t0} -> ${t1}`);
  await page.keyboard.press('Shift+Slash');
  await page.waitForTimeout(150);
  check('? opens almanac', (await q.s('ui.tab')) === 'almanac');
  // speed buttons
  for (let i = 1; i <= 5; i++) {
    await page.locator('.speed-btn').nth(i).click();
    await page.waitForTimeout(60);
    check(`speed button ${i}`, (await q.s('ui.speed')) === i);
  }
  await page.locator('.speed-btn').nth(0).click();
  await page.waitForTimeout(60);
  check('pause button', (await q.s('ui.speed')) === 0);
}

// ---- performance at speed 5 ----
{
  await q.tab('Levers');
  await q.s('R.map.debug.setCamera(56, 38, 1)');
  await page.keyboard.press('Backquote');
  await q.s('R.setSpeed(5)');
  await page.waitForTimeout(8000);
  const hud = await page.evaluate(() => [...document.querySelectorAll('.tip.on')].map((t) => t.textContent).join(' | '));
  const perf = await q.s('({...R.perf, map: R.map.debug.perf()})');
  console.log('   HUD:', hud);
  console.log('   perf:', JSON.stringify(perf));
  await q.shot('ia-perf');
  await q.s('R.setSpeed(0)');
}

console.log('\nFAILS:', fails.length ? fails.join('; ') : 'none');
report(q, 'interact');
await q.close();
