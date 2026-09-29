// Build → Road in the built game: the surface choice (paved / dirt track), a road between two
// towns, and a road drawn anywhere on the map (click where it starts, the planned way and its
// cost follow the pointer, click where it ends).
//   node scripts/qa/roads.mjs
import { open, report } from './lib.mjs';

const q = await open({});
await q.ready();
const { page } = q;
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) fails.push(name);
};
await q.s('R.setSpeed(0)');
await page.evaluate(() => window.__realm.ui.game.dispatch({ type: 'mint', amount: 50000 }));
const B = `.lv-item[data-lever="build"] .lv-body`;
await q.lever('build');
await page.locator(`${B} .seg-btn:text-is("Road")`).click();
await page.waitForTimeout(200);
check('Road offers Paved and Dirt track', (await page.locator(`${B} .seg-btn:text-is("Paved")`).count()) === 1 && (await page.locator(`${B} .seg-btn:text-is("Dirt track")`).count()) === 1);
check('Road offers Draw on map', (await page.locator(`${B} button:text-is("Draw on map")`).count()) === 1);
await page.locator(`${B} .seg-btn:text-is("Dirt track")`).click();
await page.waitForTimeout(200);
const t1 = (await page.locator(`${B} .lv-what-t`).textContent()) ?? '';
check('dirt track between towns is titled a Track', /^Track /.test(t1), t1);

// draw one anywhere
await page.locator(`${B} button:text-is("Draw on map")`).click();
await page.waitForTimeout(300);
const pl = await q.s('JSON.stringify(ui.placing)');
check('drawing mode is on', /"kind":"road"/.test(pl) && /"grade":1/.test(pl), pl);
const bar0 = (await page.locator('.map-placing').textContent()) ?? '';
check('banner asks where it starts', /starts/.test(bar0), bar0.trim());
const st = await page.evaluate(() => {
  const s = window.__realm.s;
  const m = s.map;
  const open = (i) => m.road[i] === 0 && m.occ[i] < 0 && m.river[i] === 0 && (m.terrain[i] === 3 || m.terrain[i] === 2);
  for (let y = 4; y < m.h - 4; y++)
    for (let x = 4; x + 8 < m.w - 4; x++) {
      let ok = true;
      for (let k = 0; k <= 8 && ok; k++) if (!open(y * m.w + x + k)) ok = false;
      if (ok) return { x, y };
    }
  return null;
});
check('an open stretch of country to try', !!st);
await q.s(`R.map.debug.setCamera(${st.x + 4}, ${st.y}, 2)`);
await page.waitForTimeout(300);
const box = await page.locator('.mapwrap canvas').first().boundingBox();
const toPx = async (tx, ty) => {
  const cam = await q.s('({x: R.map.debug.cam.x, y: R.map.debug.cam.y, z: R.map.debug.cam.z})');
  return { px: box.x + box.width / 2 + (tx + 0.5 - cam.x) * 16 * cam.z, py: box.y + box.height / 2 + (ty + 0.5 - cam.y) * 16 * cam.z };
};
const A = await toPx(st.x, st.y);
await page.mouse.move(A.px, A.py);
await page.waitForTimeout(150);
await page.mouse.click(A.px, A.py);
await page.waitForTimeout(300);
const a = await q.s('ui.placing?.a');
const w = await q.s('s.map.w');
check('first click sets the start', a === st.y * w + st.x, `a=${a} want ${st.y * w + st.x}`);
const bar1 = (await page.locator('.map-placing').textContent()) ?? '';
check('banner asks where it ends', /ends/.test(bar1), bar1.trim());
const Bp = await toPx(st.x + 8, st.y);
await page.mouse.move(Bp.px - 20, Bp.py);
await page.waitForTimeout(80);
await page.mouse.move(Bp.px, Bp.py);
await page.waitForTimeout(700);
const tip = await page.evaluate(() => [...document.querySelectorAll('.tip.on')].map((t) => t.textContent).join(' '));
check('the pointer shows the planned way: tiles and cost', /9 tiles of new track · ≈ ¤/.test(tip), tip.slice(0, 160));
await q.shot('road-draw');
const n0 = await q.s('s.projects.length');
await page.mouse.click(Bp.px, Bp.py);
await page.waitForTimeout(400);
const pr = await q.s('s.projects[s.projects.length - 1]');
check('second click commissions the track', (await q.s('s.projects.length')) === n0 + 1 && pr.kind === 'road' && pr.grade === 1 && pr.tiles.length === 9, JSON.stringify(pr && { kind: pr.kind, grade: pr.grade, n: pr.tiles.length, label: pr.label }));
check('drawing mode ends', !(await q.s('ui.placing')));
check('the project names where it runs', /^Track /.test(pr.label), pr.label);

// paved between two towns, as before
await page.locator(`${B} .seg-btn:text-is("Paved")`).click();
await page.waitForTimeout(200);
const t2 = (await page.locator(`${B} .lv-what-t`).textContent()) ?? '';
check('paved between towns is titled a Paved road', /^Paved road /.test(t2), t2);

// Esc cancels drawing
await page.locator(`${B} button:text-is("Draw on map")`).click();
await page.waitForTimeout(200);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Esc cancels drawing', !(await q.s('ui.placing')));

// run: the track gets built
await q.s('R.setSpeed(5)');
await page.waitForTimeout(8000);
await q.s('R.setSpeed(0)');
const prog = await q.s(`(() => { const p = s.projects.find((x) => x.id === ${pr.id}); return { status: p.status, laid: p.tiles.filter((i) => s.map.road[i] >= 1).length }; })()`);
check('work starts on the track', prog.laid > 0 || prog.status !== 'queued', JSON.stringify(prog));
await q.shot('road-built');

const txt = await page.locator('.lv-item[data-lever="build"]').innerText();
check('neutral wording', !/\b(tax|subsid\w*|tariff\w*|quota\w*|stimulus|bailout)\b/i.test(txt));
console.log(`\nFAILS: ${fails.length ? fails.join(', ') : 'none'}`);
report(q, 'roads');
await q.close();
process.exit(fails.length ? 1 : 0);
