'use strict';
// Web pages: reading links and saved pages, scraping tables and lists,
// privacy rules, changes, watching, export, asking and pulling out fields.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { AppApi } = require('../src/core/api');
const { fromHtml } = require('../src/core/page-script');
const { normalizeUrl } = require('../src/core/web');
const { fixTables, pageTitle, script } = require('../electron/browser-read');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'web-page.html'), 'utf8');

function serve(handler) {
  const srv = http.createServer(handler);
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

test('web: raw HTML gives title, text, tables, lists and links', () => {
  const p = fromHtml(FIXTURE, 'https://portal.acme.example/prices');
  assert.equal(p.title, 'Terminal price list | Acme Retail Portal');
  assert.equal(p.meta.site, 'Acme Portal');
  assert.match(p.text, /valid until December 31, 2026/);
  assert.doesNotMatch(p.text, /© 2026 Acme/, 'footer is outside the main text');
  assert.deepEqual(p.tables[0].headers, ['Model', 'Price', 'Stock']);
  assert.deepEqual(p.tables[0].rows[2], ['Lane 7000', '$529', '0']);
  assert.ok(p.links.some((l) => l.href === 'https://portal.acme.example/orders'));
  assert.equal(normalizeUrl('Example.com/a?utm_source=x&id=4#top'), 'https://example.com/a?id=4');
});

test('web: browser reader helpers', () => {
  assert.equal(pageTitle('Q4 prices - Acme and 3 more pages - Work - Microsoft​ Edge'), 'Q4 prices - Acme');
  assert.equal(pageTitle('Orders — Mozilla Firefox'), 'Orders');
  const t = fixTables([{ caption: 'x', headers: ['A', 'B'], rows: [['A', 'B'], ['1', '2']] }, { rows: [['Name', 'City'], ['Dana', 'Austin'], ['Lee', 'Waco']] }]);
  assert.deepEqual(t[0].rows, [['1', '2']], 'header row repeated as first row is dropped');
  assert.deepEqual(t[1].headers, ['Name', 'City']);
  const ps = script({ titleWords: ['inprivate'], blocked: ['bank'], always: 'login' });
  assert.ok(!ps.includes('__RULES__'));
  assert.ok(!ps.includes('`'), 'no stray backtick from the JS template');
});

test('web: read a link, privacy, changes, watch, export, ask and pull out', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-web-'));
  let version = 1;
  const { srv, base } = await serve((req, res) => {
    if (req.url.startsWith('/prices')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const extra = ['', '<tr><td>Flex 9000</td><td>$619</td><td>15</td></tr>', '<tr><td>Flex 9000</td><td>$599</td><td>15</td></tr>'][Math.min(version, 3) - 1];
      return res.end(FIXTURE.replace('<tr><td>Lane 7000</td>', `${extra}<tr><td>Lane 7000</td>`));
    }
    if (req.url === '/notes.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('Rollout call moved to Friday.'); }
    res.writeHead(404); return res.end('no');
  });
  try {
    const api = await AppApi.create({ dataDir });
    // Privacy: these are never read.
    await assert.rejects(api.webReadUrl('https://login.microsoftonline.com/common'), /never read/);
    assert.throws(() => api.webSave({ url: 'https://www.chase.com/accounts', title: 'Chase', text: 'balance' }), /never-read list/);
    assert.throws(() => api.webSave({ url: 'https://news.example/a', title: 'News - InPrivate', text: 'x' }), /private/);
    api.setActivity({ exclude: 'payroll' });
    assert.throws(() => api.webSave({ url: 'https://hr.example/p', title: 'Payroll summary', text: 'x' }), /private/);

    const p = await api.webReadUrl(`${base}/prices?utm_source=mail`);
    assert.equal(p.url, `${base}/prices`);
    assert.equal(p.via, 'link');
    assert.equal(p.tables[0].rows.length, 3);
    assert.equal(api.webPages().length, 1);
    assert.equal(api.webPages({ q: 'Lane 7000' }).length, 1, 'search reaches the page text');
    assert.equal(api.webPages({ q: 'nothing-like-this' }).length, 0);

    // A note Chat can search is written to the Web pages folder.
    const notes = fs.readdirSync(path.join(dataDir, 'Web pages'));
    assert.equal(notes.length, 1);
    const md = fs.readFileSync(path.join(dataDir, 'Web pages', notes[0]), 'utf8');
    assert.match(md, /\| Move 5000 \| \$399 \| 120 \|/);

    // Read again: the new row is noticed.
    version = 2;
    const again = await api.webRecheck(p.id);
    assert.equal(again.id, p.id);
    assert.ok(again.change.changed);
    assert.equal(again.change.rowsAdded, 1);
    assert.match(again.change.newRows[0], /Flex 9000/);

    // Watching: due pages are read again and a change goes to Chat.
    api.webUpdate(p.id, { watch: 1, note: 'Track Flex pricing' });
    version = 3;
    const later = new Date(Date.now() + 2 * 3600e3);
    assert.equal(await api.web.runWatches(later), 1);
    const posted = api.chatHistory({}).filter((m) => m.web === p.id);
    assert.equal(posted.length, 1);
    assert.match(posted[0].content, /changed/);

    // Export.
    const csv = await api.webExport(p.id, 0, 'csv');
    assert.match(csv.text, /^Model,Price,Stock\r\nMove 5000,\$399,120/);
    const xl = await api.webExport(p.id, 'all', 'xlsx');
    assert.ok(xl.bytes.length > 3000);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xl.bytes);
    assert.equal(wb.worksheets[0].getCell('A2').value, 'Move 5000');
    assert.equal(wb.worksheets[0].getCell('C2').value, 120, 'numbers export as numbers');

    // Without an AI: matching lines, and the closest table.
    api.setAi({ provider: 'off' });
    const a = await api.webAsk([p.id], 'price of Desk 3500');
    assert.equal(a.mode, 'basic');
    assert.match(a.answer, /Desk 3500/);
    const ex = await api.webExtract(p.id, 'model and price');
    assert.equal(ex.table.kind, 'ai');
    assert.deepEqual(ex.table.headers, ['Model', 'Price', 'Stock']);

    // A plain text link, and the built-in browser path (webSave with lists).
    const t = await api.webReadUrl(`${base}/notes.txt`);
    assert.match(t.text, /moved to Friday/);
    const b = api.webSave({ url: 'https://shop.example/list', title: 'Shop', text: 'Products', lists: [{ caption: 'Products', headers: ['Item', 'Detail 1'], rows: [['A', '1'], ['B', '2'], ['C', '3'], ['D', '4']] }] }, { via: 'built-in' });
    assert.equal(b.lists[0].rows.length, 4);
    assert.equal(b.via, 'built-in');
    await assert.rejects(api.webReadUrl(`${base}/missing`), /404/);

    // Settings and clean-up.
    assert.equal(api.setWeb({ learn: false }).learn, false);
    assert.equal(fs.readdirSync(path.join(dataDir, 'Web pages')).length, 0, 'notes go when Chat may not use pages');
    api.webDelete(t.id);
    assert.equal(api.webPages().length, 2);
    api.webClear();
    assert.equal(api.webPages().length, 0);
    // The page list survives a restart.
    const p2 = await api.webReadUrl(`${base}/prices`);
    const api2 = await AppApi.create({ dataDir });
    assert.equal(api2.webPages()[0].id, p2.id);
  } finally {
    srv.close();
  }
});

test('web: asking and pulling out fields use the AI, long pages in parts', async () => {
  const calls = [];
  const { srv, base } = await serve((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'llama3.1:8b' }] }));
      const body = JSON.parse(b || '{}');
      calls.push(body);
      const last = body.messages[body.messages.length - 1].content;
      if (body.format) {
        const part = (last.match(/part (\d) of/) || [])[1] || '1';
        return res.end(JSON.stringify({ message: { content: JSON.stringify({ columns: ['Store', 'Status'], rows: [[`Store ${part}`, 'Live'], ['Store 1', 'Live']] }) } }));
      }
      return res.end(JSON.stringify({ message: { content: 'The Move 5000 costs $399.' } }));
    });
  });
  try {
    const api = await AppApi.create({});
    api.setAi({ provider: 'ollama', localUrl: base });
    const long = Array.from({ length: 3000 }, (_, i) => `Store ${i} status line with some words to make it long.`).join('\n');
    const p = api.webSave({ url: 'https://portal.example/stores', title: 'Stores', text: long });
    const a = await api.webAsk([p.id], 'What does the Move 5000 cost?');
    assert.equal(a.mode, 'local');
    assert.match(a.answer, /\$399/);
    assert.ok(calls[0].messages[1].content.length < 100000, 'a long page is cut to what matters');
    const ex = await api.webExtract(p.id, 'every store and its status');
    assert.deepEqual(ex.table.headers, ['Store', 'Status']);
    const parts = calls.filter((c) => c.format).length;
    assert.ok(parts >= 3, `long page read in parts (${parts})`);
    assert.ok(ex.table.rows.length >= parts, 'rows from every part, duplicates dropped');
    assert.equal(new Set(ex.table.rows.map((r) => r.join())).size, ex.table.rows.length);
    assert.equal(api.webPage(p.id).tables.find((t) => t.kind === 'ai').caption, 'every store and its status');
  } finally {
    srv.close();
  }
});
