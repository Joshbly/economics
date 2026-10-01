// Frame-time distribution at speed 5 with each tab open (and zoomed-in map).
import { open, report } from './lib.mjs';
const q = await open({ w: 1440, h: 900 });
await q.ready();
const { page } = q;
await page.evaluate(() => {
  window.__ft = [];
  let last = 0;
  const f = (t) => {
    if (last) window.__ft.push(t - last);
    last = t;
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
});
const cases = [['levers', 1], ['markets', 1], ['charts', 1], ['people', 1], ['ledger', 1], ['inspect', 1], ['levers', 3]];
for (const [tab, z] of cases) {
  if (tab === 'inspect') await q.s(`R.select({kind:'town', id:0})`);
  else await q.s(`R.setTab('${tab}')`);
  await q.s(`R.map.debug.setCamera(s.towns[0].x, s.towns[0].y, ${z})`);
  await q.s('R.setSpeed(5)');
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window.__ft = []));
  const d0 = await q.s('s.day');
  await page.waitForTimeout(6000);
  const r = await page.evaluate(() => {
    const a = window.__ft.slice().sort((x, y) => x - y);
    const p = (k) => a[Math.min(a.length - 1, Math.floor(a.length * k))];
    return { n: a.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: a[a.length - 1], over50: a.filter((x) => x > 50).length };
  });
  const d1 = await q.s('s.day');
  const perf = await q.s('({step: R.perf.stepMs, map: R.map.debug.perf().frameMs})');
  console.log(`${tab.padEnd(8)} z=${z}  frames=${r.n} p50=${r.p50.toFixed(1)} p95=${r.p95.toFixed(1)} p99=${r.p99.toFixed(1)} max=${r.max.toFixed(0)} >50ms=${r.over50}  days/s=${((d1 - d0) / 6).toFixed(1)} step=${perf.step.toFixed(2)}ms map=${perf.map.toFixed(2)}ms`);
  await q.s('R.setSpeed(0)');
}
report(q, 'perf');
await q.close();
