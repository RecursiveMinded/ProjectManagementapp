'use strict';
// CI check on Windows: open a test page in Edge and read it the way Ctrl+Alt+B does.
//   node scripts/try-browser-read.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { readBrowser } = require('../electron/browser-read');

const page = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'web-page.html'));
const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));

(async () => {
  if (!edge) { console.log('Edge not found; skipped'); return; }
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(page); }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/prices`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-edge-'));
  const b = spawn(edge, ['--no-first-run', '--no-default-browser-check', '--disable-features=msEdgeWelcomePage', `--user-data-dir=${profile}`, '--new-window', url], { detached: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 12000));
  const t0 = Date.now();
  const r = await readBrowser({ titleWords: ['inprivate', 'incognito'], blocked: ['bank'], always: '/login' });
  const ms = Date.now() - t0;
  try { process.kill(b.pid); } catch (_) { /* gone */ }
  spawn('taskkill', ['/F', '/IM', 'msedge.exe'], { stdio: 'ignore' });
  srv.close();
  const tables = (r.tables || []).map((t) => `${t.headers.join('|')} x${t.rows.length}`);
  console.log(JSON.stringify({ ok: r.ok, reason: r.reason, message: r.message, title: r.title, url: r.url, schemeGuessed: r.schemeGuessed, note: r.note, docs: r.docs, tries: r.tries, chars: (r.text || '').length, text: (r.text || '').slice(0, 300), tables, ms }, null, 2));
  if (!r.ok) process.exitCode = 1;
  else if (!/Terminal price list/.test(r.title || '') || !/valid until December 31/.test(r.text || '')) process.exitCode = 1;
})();
