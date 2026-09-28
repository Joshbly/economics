// Dev-only builds of the UI gallery and the shell preview (synthetic data):
//   node scripts/gallery.mjs          -> dist/gallery.html, dist/shell.html
// Then e.g.: node scripts/shot.mjs dist/gallery.html /tmp/gallery.png --h 3000
import * as esbuild from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

const pages = [
  ['src/ui/dev/gallery.ts', 'dist/gallery.html', 'Realm Ledger — widget gallery'],
  ['src/ui/dev/shell.ts', 'dist/shell.html', 'Realm Ledger — shell preview'],
];

for (const [entry, out, title] of pages) {
  const r = await esbuild.build({
    entryPoints: [entry],
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
<meta name="color-scheme" content="dark"><title>${title}</title>
<style>${css.replace(/<\/style/gi, '<\\/style')}</style></head>
<body><div id="app"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  writeFileSync(out, html);
  console.log(`[gallery] ${out} (${(html.length / 1024).toFixed(0)} KB)`);
}
