// QA harness for driving the real built game (EconSim.html) with Playwright.
//   import { open } from './lib.mjs';
//   const q = await open({ w: 1440, h: 900, fresh: false });
//   ... q.page, q.s(expr), q.shot(name), q.errors ...
//   await q.close();
// A tiny static server serves EconSim.html over http so localStorage behaves
// normally. The first run founds a realm (warm-up) and caches its autosave in
// /tmp/qa/realm.save; later runs inject it and press "Continue" (fast).
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const OUT = process.env.QA_OUT || '/tmp/qa';
mkdirSync(OUT, { recursive: true });
const CACHE = OUT + '/realm.save';

export async function open({ w = 1440, h = 900, fresh = false, welcome = false, file = 'EconSim.html', keepStorage = null } = {}) {
  const html = readFileSync(resolve(file));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/EconSim.html`;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, acceptDownloads: true });
  const errors = [];
  const cached = !fresh && existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : null;
  const store = keepStorage ?? cached;
  await ctx.addInitScript(
    ([st, welcome]) => {
      if (sessionStorage.getItem('__qa_init')) return;
      sessionStorage.setItem('__qa_init', '1');
      try {
        localStorage.clear();
        if (st) for (const k in st) localStorage.setItem(k, st[k]);
        if (!welcome) localStorage.setItem('realmLedger.welcomed', '1');
      } catch {}
    },
    [store, welcome],
  );
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
  await page.goto(url);
  const q = {
    page,
    ctx,
    browser,
    url,
    errors,
    async ready(timeout = 60000) {
      // boot screen: continue if offered
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (await page.$('.app')) break;
        const cont = await page.$('button.choice.primary');
        if (cont) await cont.click().catch(() => {});
        await page.waitForTimeout(250);
      }
      await page.waitForFunction(() => !!window.__realm && !!window.__realm.s, null, { timeout });
      await page.waitForTimeout(600);
    },
    s(expr) {
      return page.evaluate(`(() => { const R = window.__realm, ui = R.ui, s = R.s; return (${expr}); })()`);
    },
    async shot(name) {
      const p = `${OUT}/${name}.png`;
      await page.screenshot({ path: p });
      return p;
    },
    async tab(name) {
      await page.click(`.tabs .tab:text-is("${name}")`);
      await page.waitForTimeout(250);
    },
    async lever(id) {
      if ((await page.evaluate(() => window.__realm.ui.tab)) !== 'levers') await page.evaluate(() => window.__realm.setTab('levers'));
      const open = await page.$(`.lv-item[data-lever="${id}"].open`);
      if (!open) await page.click(`.lv-head[data-lever="${id}"]`);
      await page.waitForTimeout(250);
      return page.$(`.lv-item[data-lever="${id}"] .lv-body`);
    },
    async saveCache() {
      const st = await page.evaluate(() => {
        const o = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k.startsWith('realmLedger.autosave')) o[k] = localStorage.getItem(k);
        }
        return o;
      });
      writeFileSync(CACHE, JSON.stringify(st));
    },
    async close() {
      await browser.close();
      server.close();
    },
  };
  return q;
}

export function report(q, label) {
  const errs = q.errors.filter((e) => !/favicon/.test(e));
  console.log(`\n== ${label}: ${errs.length} console errors/warnings`);
  for (const e of errs.slice(0, 40)) console.log('  ', e.slice(0, 600));
  return errs;
}
