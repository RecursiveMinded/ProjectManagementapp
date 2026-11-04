'use strict';
// Bundles the renderer into dist/ui.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'ui');
const watch = process.argv.includes('--watch');

async function main() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of ['index.html', 'styles.css']) fs.copyFileSync(path.join(root, 'src', 'ui', f), path.join(out, f));
  const opts = {
    entryPoints: [path.join(root, 'src', 'ui', 'app.js')],
    bundle: true, format: 'esm', platform: 'browser', target: ['chrome120'],
    outfile: path.join(out, 'app.js'), minify: !watch, sourcemap: watch ? 'inline' : false,
    legalComments: 'none', logLevel: 'info',
    define: { 'process.env.NODE_ENV': '"production"' },
  };
  if (watch) { const ctx = await esbuild.context(opts); await ctx.watch(); } else await esbuild.build(opts);
}

main().catch((e) => { console.error(e); process.exit(1); });
