// The top bar holds still: as the day runs (market sessions named, months turning) and the
// indicators update, nothing in the bar moves sideways. Samples every item's left edge across
// several game days at a few window widths.
//   node scripts/qa/topbar.mjs
import { open, report } from './lib.mjs';

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) fails.push(name);
};
let last;
for (const w of [1920, 1440, 1280]) {
  const q = await open({ w });
  last = q;
  await q.ready();
  const { page } = q;
  const edges = () =>
    page.evaluate(() => {
      const bar = document.querySelector('header.topbar');
      const els = [bar.querySelector('.tb-speed'), ...bar.querySelectorAll('.tb-inds > .ind'), bar.lastElementChild];
      return els.map((e) => Math.round(e.getBoundingClientRect().left * 10) / 10);
    });
  // any reading wider than the room its indicator keeps
  const over = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('header.topbar .ind:not([hidden]) .tb-fit')].flatMap((f) => {
        const [room, row] = [f.querySelector('.tb-ghost'), f.querySelector(':scope > :not(.tb-ghost)')];
        return row.scrollWidth > room.scrollWidth + 0.5 ? [row.textContent + ` (${row.scrollWidth} > ${room.scrollWidth})`] : [];
      }),
    );
  const wide = new Set();
  const labels = new Set();
  const seen = [];
  // (the first days fill the indicators in; after that nothing may move)
  await q.s('R.setSpeed(2)');
  await page.waitForTimeout(2500);
  const day0 = await q.s('s.day');
  for (let i = 0; i < 120; i++) {
    if (i === 60) await q.s('R.setSpeed(4)');
    await page.waitForTimeout(60);
    seen.push(await edges());
    for (const x of await over()) wide.add(x);
    labels.add(await page.evaluate(() => document.querySelector('.tb-date-sub .tb-fit > :not(.tb-ghost)')?.textContent?.trim()));
  }
  await q.s('R.setSpeed(0)');
  const days = (await q.s('s.day')) - day0;
  const n = seen[0].length;
  let worst = 0;
  let who = -1;
  for (let k = 0; k < n; k++) {
    const xs = seen.map((r) => r[k]);
    const d = Math.max(...xs) - Math.min(...xs);
    if (d > worst) (worst = d), (who = k);
  }
  const words = [...labels].filter(Boolean);
  check(`${w}px: the day showed market sessions`, words.some((x) => /market/.test(x)), words.slice(0, 6).join(' | '));
  check(`${w}px: nothing in the top bar moves as the day runs`, worst < 0.6, `largest shift ${worst}px (item ${who} of ${n}) over ${days} days${wide.size ? '; wider than their room: ' + [...wide].slice(0, 4).join(', ') : ''}`);
  await q.shot(`topbar-${w}`);
  if (w !== 1280) await q.close();
}
console.log(`\nFAILS: ${fails.length ? fails.join(', ') : 'none'}`);
report(last, 'topbar');
await last.close();
process.exit(fails.length ? 1 : 0);
