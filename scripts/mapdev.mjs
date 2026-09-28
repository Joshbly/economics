// Dev-only build of the map renderer harness (a generated world, no simulation):
//   node scripts/mapdev.mjs              -> dist/mapdev.html
// Then e.g.:
//   node scripts/shot.mjs "file://$PWD/dist/mapdev.html?seed=1&z=1.5&t=0.3" /tmp/map.png
// URL parameters are documented in src/ui/map/dev.ts.
import * as esbuild from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
const r = await esbuild.build({
  entryPoints: ['src/ui/map/dev.ts'],
  bundle: true,
  format: 'iife',
  target: ['es2020', 'safari15'],
  write: false,
  outdir: 'dist',
  loader: { '.css': 'css' },
  logLevel: 'warning',
  define: { __DEV__: 'true' },
});
let js = '';
let css = '';
for (const f of r.outputFiles) {
  if (f.path.endsWith('.js')) js = f.text;
  else if (f.path.endsWith('.css')) css = f.text;
}
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark"><title>Realm Ledger — map harness</title>
<style>${css.replace(/<\/style/gi, '<\\/style')}</style></head>
<body><div id="app"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
writeFileSync('dist/mapdev.html', html);
console.log(`[mapdev] dist/mapdev.html (${(html.length / 1024).toFixed(0)} KB)`);
