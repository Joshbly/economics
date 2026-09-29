// Every tab at three window sizes; flags horizontal overflow in the sidebar/top bar.
import { open, report } from './lib.mjs';
for (const [w, hh] of [[1280, 800], [1440, 900], [1920, 1080]]) {
  const q = await open({ w, h: hh });
  await q.ready();
  await q.s('R.setSpeed(4)');
  await q.page.waitForTimeout(2500);
  await q.s('R.setSpeed(0)');
  const ids = await q.s(`({ firm: s.firms.find(f => f && f.alive && f.workers?.length > 3)?.id, person: s.people.find(p => p && p.alive && p.job >= 0)?.id })`);
  for (const tab of ['levers', 'markets', 'ledger', 'charts', 'people', 'almanac', 'inspect']) {
    if (tab === 'inspect') await q.s(`R.select({kind:'firm', id:${ids.firm}})`);
    else await q.s(`R.setTab('${tab}')`);
    await q.page.waitForTimeout(500);
    const over = await q.page.evaluate(() => {
      const out = [];
      const sb = document.querySelector('.panel-host');
      const lim = sb.getBoundingClientRect().right + 1;
      for (const el of document.querySelectorAll('section.panel:not([hidden]) *')) {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > lim && getComputedStyle(el).position !== 'fixed') out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} right=${Math.round(r.right)} > ${Math.round(lim)} "${(el.textContent || '').slice(0, 30)}"`);
      }
      const ph = document.querySelector('section.panel:not([hidden])');
      if (ph && ph.scrollWidth > ph.clientWidth + 1) out.unshift(`PANEL hscroll ${ph.scrollWidth} > ${ph.clientWidth}`);
      const tb = document.querySelector('.tb-inds');
      if (tb && tb.scrollWidth > tb.clientWidth + 1) out.unshift(`TOPBAR overflow ${tb.scrollWidth} > ${tb.clientWidth}`);
      return out.slice(0, 6);
    });
    if (over.length) console.log(`${w}x${hh} ${tab}:`, over.join('\n    '));
    await q.shot(`size-${w}-${tab}`);
  }
  const hidden = await q.page.evaluate(() => [...document.querySelectorAll('.ind')].filter((e) => e.hidden).map((e) => e.getAttribute('aria-label')));
  console.log(`${w}x${hh} hidden indicators:`, hidden.join(', ') || 'none');
  report(q, `sizes ${w}`);
  await q.close();
}
