// Build script: bundles the whole game into ONE self-contained HTML file
// (dist/EconSim.html, copied to ./EconSim.html) so it can be opened on a Mac
// by simply double-clicking it — no server, no install.
//
//   node build.mjs            -> production build (minified)
//   node build.mjs --serve    -> dev server on http://localhost:8000 with auto-reload
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';

const serve = process.argv.includes('--serve');
const outDir = 'dist';
mkdirSync(outDir, { recursive: true });

let version = 0;

function inline(js, css, dev) {
  const template = readFileSync('src/index.html', 'utf8');
  const reload = dev
    ? `<script>(function(){var v=null;setInterval(function(){fetch('/__version').then(function(r){return r.text()}).then(function(t){if(v===null)v=t;else if(t!==v)location.reload()}).catch(function(){})},700)})();</script>`
    : '';
  // Use function replacers so `$` sequences inside the bundle are not interpreted.
  return template
    .replace('/*__CSS__*/', () => css.replace(/<\/style/gi, '<\\/style'))
    .replace('<!--__JS__-->', () => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>${reload}`);
}

async function buildOnce(dev) {
  const result = await esbuild.build({
    entryPoints: ['src/main.ts'],
    bundle: true,
    format: 'iife',
    target: ['es2020', 'safari15'],
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    write: false,
    outdir: outDir,
    loader: { '.css': 'css' },
    logLevel: 'warning',
    define: { __DEV__: dev ? 'true' : 'false' },
  });
  let js = '';
  let css = '';
  for (const f of result.outputFiles) {
    if (f.path.endsWith('.js')) js = f.text;
    else if (f.path.endsWith('.css')) css = f.text;
  }
  const html = inline(js, css, dev);
  writeFileSync(`${outDir}/EconSim.html`, html);
  if (!dev) copyFileSync(`${outDir}/EconSim.html`, 'EconSim.html');
  version++;
  const kb = (html.length / 1024).toFixed(0);
  console.log(`[build] ${dev ? 'dev' : 'release'} build #${version} -> ${outDir}/EconSim.html (${kb} KB)${dev ? '' : ' and ./EconSim.html'}`);
}

if (!serve) {
  await buildOnce(false);
} else {
  await buildOnce(true);
  const ctx = await esbuild.context({
    entryPoints: ['src/main.ts'],
    bundle: true,
    write: false,
    outdir: outDir,
    logLevel: 'silent',
    plugins: [
      {
        name: 'rebuild-notify',
        setup(b) {
          b.onEnd(async (r) => {
            if (r.errors.length) {
              console.log('[build] errors:', r.errors.map((e) => e.text).join('\n'));
              return;
            }
            try {
              await buildOnce(true);
            } catch (e) {
              console.log('[build] failed', e.message);
            }
          });
        },
      },
    ],
  });
  await ctx.watch();
  const port = Number(process.env.PORT || 8000);
  createServer((req, res) => {
    if (req.url === '/__version') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end(String(version));
      return;
    }
    const file = `${outDir}/EconSim.html`;
    if (!existsSync(file)) {
      res.writeHead(503);
      res.end('building...');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  }).listen(port, () => console.log(`[dev] http://localhost:${port}`));
}
