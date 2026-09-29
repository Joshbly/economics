import { open } from './lib.mjs';
const q = await open({ w: 1440, h: 900 });
await q.ready();
const kp = async () => q.page.evaluate(() => document.querySelector('.topbar, header')?.innerText.replace(/\s+/g, ' ').slice(0, 400));
console.log('d0', await kp());
await q.s(`R.setSpeed(5)`);
for (const target of [3, 20, 45]) {
  for (let i = 0; i < 200; i++) { const d = await q.s('s.day - s.startDay'); if (d >= target) break; await q.page.waitForTimeout(200); }
  await q.s(`R.setSpeed(0)`);
  console.log('d' + (await q.s('s.day - s.startDay')), await kp());
  await q.s(`R.setSpeed(5)`);
}
await q.s(`R.setSpeed(0)`);
await q.shot('tb-d45');
await q.tab('Markets');
await q.page.waitForTimeout(500);
await q.shot('markets-d45');
console.log(await q.page.evaluate(() => document.querySelector('.panel-body, .tabpanel, [class*="markets"]')?.innerText.slice(0, 1500)));
console.log('errors', q.errors.length);
process.exit(0);
