// Screenshot helper for visual checks (uses the preinstalled Chromium).
//   node scripts/shot.mjs <file.html|url> <out.png> [--w 1440] [--h 900] [--wait 1500]
//        [--eval "js to run before the shot"] [--clicks "#sel1,#sel2"]
// Prints browser console errors/warnings so broken pages are obvious.
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const target = args[0];
const out = args[1] || 'shot.png';
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const w = Number(opt('w', 1440));
const h = Number(opt('h', 900));
const wait = Number(opt('wait', 1500));
const evalJs = opt('eval', '');
const clicks = opt('clicks', '');

const url = /^https?:|^file:/.test(target) ? target : 'file://' + resolve(target);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}]`, m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForTimeout(wait);
for (const sel of clicks.split(',').filter(Boolean)) {
  await page.click(sel).catch((e) => console.log('[click failed]', sel, e.message));
  await page.waitForTimeout(400);
}
if (evalJs) {
  const r = await page.evaluate(evalJs).catch((e) => 'eval error: ' + e.message);
  if (r !== undefined) console.log('[eval]', typeof r === 'string' ? r : JSON.stringify(r));
  await page.waitForTimeout(400);
}
await page.screenshot({ path: out });
console.log('saved', out);
await browser.close();
