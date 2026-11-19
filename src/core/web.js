'use strict';
// Web pages: read the page open in the user's browser (Edge, Chrome, Firefox),
// a page in Boardenda's own browser, or a link, and keep what it says: the
// text, its tables and repeated lists (scraped into rows), and its links.
// Saved pages are written as notes the Chat searches, so the assistant knows
// them; tables export to Excel; a page can be asked about, have specific
// fields pulled out by the AI, be handed to the assistant for actions, or be
// watched for changes. Everything stays on this PC. Banking, password and
// private-browsing pages are never read.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { now, today, parseJson } = require('./util');
const { fromHtml } = require('./page-script');

const DEFAULTS = {
  learn: true,        // saved pages become notes Chat can search
  hotkey: true,       // Ctrl+Alt+B reads the browser in front (desktop app)
  keepPages: 1000,
  blocked: ['bank', 'banking', 'paypal.com', 'venmo.com', 'zelle', 'chase.com', 'wellsfargo.com', 'americanexpress.com', 'capitalone.com', 'fidelity.com', 'schwab.com', 'vanguard.com',
    '1password', 'lastpass', 'bitwarden', 'dashlane', 'keepersecurity', 'mychart', 'checkout', 'payment'],
};
// Never read, whatever the list says: sign-in and password pages, browser internals, private windows.
const ALWAYS_BLOCKED = /(^|[/.?&=_-])(login|log-in|signin|sign-in|signup|password|passwd|reset-password|2fa|mfa|otp)([/.?&=_-]|$)|^(chrome|edge|about|brave|opera|vivaldi|devtools|view-source|chrome-extension|moz-extension):|login\.microsoftonline\.com|login\.live\.com|accounts\.google\.com|appleid\.apple\.com/i;
const PRIVATE_TITLE = /\b(inprivate|incognito|private browsing)\b/i;
const MAX_TEXT = 250000;
const MAX_ROWS = 5000;
const AI_CHARS = 60000;

const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'page';
const words = (q) => [...new Set(String(q || '').toLowerCase().match(/[a-z0-9][a-z0-9'._-]*[a-z0-9]|[a-z0-9]/g) || [])].filter((w) => w.length > 2);

/** https://Example.com/a/?utm_source=x#top -> https://example.com/a/ */
function normalizeUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const x = new URL(s);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_eid$|mc_cid$|ref_src$)/i.test(k)) x.searchParams.delete(k);
    return x.href;
  } catch (_) { return ''; }
}

/** Rows as tab-separated text, for the AI and for search. */
function tableText(t, maxRows = 400) {
  const head = (t.headers || []).join('\t');
  const rows = (t.rows || []).slice(0, maxRows).map((r) => r.join('\t'));
  return `${t.caption ? `${t.caption}\n` : ''}${head}\n${rows.join('\n')}${(t.rows || []).length > maxRows ? `\n…(${t.rows.length - maxRows} more rows)` : ''}`;
}

function mdTable(t, maxRows = 500) {
  const esc = (c) => String(c || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const h = t.headers && t.headers.length ? t.headers : (t.rows[0] || []).map((_, i) => `Column ${i + 1}`);
  const lines = [`| ${h.map(esc).join(' | ')} |`, `| ${h.map(() => '---').join(' | ')} |`, ...t.rows.slice(0, maxRows).map((r) => `| ${r.map(esc).join(' | ')} |`)];
  if (t.rows.length > maxRows) lines.push(`\n(${t.rows.length - maxRows} more rows in Boardenda)`);
  return lines.join('\n');
}

function cleanTable(t) {
  const headers = (Array.isArray(t.headers) ? t.headers : []).map((h) => clip(String(h == null ? '' : h).trim(), 200)).slice(0, 60);
  const rows = (Array.isArray(t.rows) ? t.rows : []).slice(0, MAX_ROWS).map((r) => (Array.isArray(r) ? r : [r]).slice(0, 60).map((c) => clip(String(c == null ? '' : c).trim(), 2000)));
  const w = Math.max(headers.length, ...rows.map((r) => r.length), 0);
  const pad = (r) => { const x = r.slice(); while (x.length < w) x.push(''); return x; };
  return { caption: clip(String(t.caption || '').trim(), 200), headers: pad(headers.length ? headers : [...Array(w)].map((_, i) => `Column ${i + 1}`)), rows: rows.filter((r) => r.some(Boolean)).map(pad), kind: t.kind || 'table' };
}

/** What changed between two reads of a page: new and gone lines, and table rows. */
function diff(prev, next) {
  const lines = (p) => new Set(String(p.text || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 2));
  const a = lines(prev), b = lines(next);
  const added = [...b].filter((l) => !a.has(l));
  const removed = [...a].filter((l) => !b.has(l));
  const rowKeys = (p) => new Set([...(p.tables || []), ...(p.lists || [])].flatMap((t) => t.rows.map((r) => r.join('\u0001'))));
  const ra = rowKeys(prev), rb = rowKeys(next);
  const rowsAdded = [...rb].filter((k) => !ra.has(k));
  const rowsRemoved = [...ra].filter((k) => !rb.has(k));
  return {
    changed: added.length + removed.length + rowsAdded.length + rowsRemoved.length > 0,
    added: added.length, removed: removed.length, rowsAdded: rowsAdded.length, rowsRemoved: rowsRemoved.length,
    sample: added.slice(0, 8).map((l) => clip(l, 200)),
    newRows: rowsAdded.slice(0, 8).map((k) => clip(k.split('\u0001').filter(Boolean).join(' · '), 200)),
  };
}

class Web {
  /**
   * readFile(name, bytes): text of a PDF/Word/Excel file. activity: its private-window words.
   * The desktop app sets loader(url) (a hidden browser window that runs the page) and fetcher(url).
   */
  constructor({ db, dataDir, capture, assistant, knowledge, activity, readFile }) {
    this.db = db;
    this.dir = dataDir ? path.join(dataDir, 'Web') : null;
    this.notesDir = dataDir ? path.join(dataDir, 'Web pages') : null;
    this.capture = capture;
    this.assistant = assistant;
    this.knowledge = knowledge;
    this.activity = activity;
    this.readFile = readFile;
    this.loader = null;
    this.fetcher = null;
    this.chat = null;
    this.mem = new Map();
    this.indexTimer = null;
    this.watching = false;
  }

  // -------------------------------------------------------------- settings
  settings() {
    const r = this.db.get("SELECT value FROM settings WHERE key='web'");
    const s = { ...DEFAULTS, ...parseJson(r && r.value, {}) };
    if (!Array.isArray(s.blocked)) s.blocked = DEFAULTS.blocked;
    return s;
  }
  setSettings(patch = {}) {
    const next = { ...this.settings() };
    for (const k of ['learn', 'hotkey']) if (patch[k] !== undefined) next[k] = !!patch[k];
    if (patch.keepPages !== undefined) next.keepPages = Math.min(20000, Math.max(20, Math.round(Number(patch.keepPages) || DEFAULTS.keepPages)));
    if (patch.blocked !== undefined) next.blocked = (Array.isArray(patch.blocked) ? patch.blocked : String(patch.blocked).split(/[,\n]/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 200);
    this.db.run("INSERT INTO settings(key,value) VALUES('web',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(next)]);
    if (patch.learn !== undefined) { if (next.learn) this.learnAll(); else this.forgetAll(); }
    return this.status();
  }
  status() {
    const s = this.settings();
    return { ...s, pages: this.index().length, folder: this.dir, notesFolder: this.notesDir };
  }

  /** Why a page must not be read, or null when it may. */
  blockedReason(url, title = '') {
    const u = String(url || '');
    if (PRIVATE_TITLE.test(title)) return 'This is a private browsing window, so it is not read.';
    if (ALWAYS_BLOCKED.test(u)) return 'Sign-in, password and browser pages are never read.';
    const hay = `${host(u)} ${u}`.toLowerCase();
    const s = this.settings();
    const hit = s.blocked.find((w) => w && hay.includes(w));
    if (hit) return `Pages matching "${hit}" are on your never-read list.`;
    if (this.activity) {
      try { const ex = this.activity.settings().exclude || []; const t = String(title || '').toLowerCase(); const w = ex.find((x) => x && t.includes(x)); if (w) return `Windows with "${w}" in the title are private.`; } catch (_) { /* activity is optional */ }
    }
    return null;
  }
  /** Words and sites the desktop reader checks before it reads anything (titles and addresses). */
  privacyRules() {
    const s = this.settings();
    let ex = [];
    try { ex = (this.activity && this.activity.settings().exclude) || []; } catch (_) { /* optional */ }
    return { titleWords: [...new Set([...ex, 'inprivate', 'incognito', 'private browsing'])], blocked: s.blocked, always: ALWAYS_BLOCKED.source };
  }

  // --------------------------------------------------------------- storage
  file(id) { return this.dir ? path.join(this.dir, 'pages', `${id}.json`) : null; }
  index() {
    if (!this.dir) return [...this.mem.values()].map((p) => this.summary(p)).sort((a, b) => (a.at < b.at ? 1 : -1));
    if (this.idx) return this.idx;
    try { this.idx = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')); } catch (_) { this.idx = []; }
    return this.idx;
  }
  writeIndex(list) {
    this.idx = list.sort((a, b) => (a.at < b.at ? 1 : -1));
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const f = path.join(this.dir, 'index.json');
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(this.idx));
    fs.renameSync(`${f}.tmp`, f);
  }
  summary(p) {
    return { id: p.id, url: p.url, title: p.title, site: p.site, at: p.at, first: p.first, via: p.via, chars: (p.text || '').length,
      tables: (p.tables || []).length, lists: (p.lists || []).length, rows: [...(p.tables || []), ...(p.lists || [])].reduce((n, t) => n + t.rows.length, 0),
      links: (p.links || []).length, watch: p.watch || 0, checked: p.checked || null, change: p.change || null, note: p.note || '' };
  }
  load(id) {
    if (!this.dir) return this.mem.get(id) || null;
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch (_) { return null; }
  }
  store(p) {
    if (!this.dir) { this.mem.set(p.id, p); } else {
      fs.mkdirSync(path.dirname(this.file(p.id)), { recursive: true });
      fs.writeFileSync(`${this.file(p.id)}.tmp`, JSON.stringify(p));
      fs.renameSync(`${this.file(p.id)}.tmp`, this.file(p.id));
    }
    const list = this.index().filter((x) => x.id !== p.id);
    list.push(this.summary(p));
    // Keep the newest pages; older ones (not watched) go.
    const keep = this.settings().keepPages;
    list.sort((a, b) => (a.at < b.at ? 1 : -1));
    const drop = list.slice(keep).filter((x) => !x.watch);
    for (const d of drop) this.removeFiles(d.id);
    this.writeIndex(list.filter((x) => !drop.includes(x)));
    if (this.settings().learn) this.writeNote(p); else this.dropNote(p);
  }
  removeFiles(id) {
    const p = this.load(id);
    if (p) this.dropNote(p);
    if (this.dir) { try { fs.rmSync(this.file(id), { force: true }); } catch (_) { /* gone */ } } else this.mem.delete(id);
  }

  // ----------------------------------------------------- notes Chat can search
  noteName(p) { return `${safeName(p.site || host(p.url))} - ${safeName(p.title)} (${p.id.slice(3, 9)}).md`; }
  noteText(p) {
    const out = [`# ${p.title}`, '', `Web page: ${p.url}`, `Read: ${String(p.at).slice(0, 16).replace('T', ' ')}${p.first && p.first !== p.at ? ` (first read ${p.first.slice(0, 10)})` : ''}`];
    if (p.meta && p.meta.description) out.push('', p.meta.description);
    if (p.note) out.push('', `Note: ${p.note}`);
    if (p.selection) out.push('', '## Selected text', '', p.selection);
    out.push('', '## Page text', '', p.text || '(no text)');
    const tabs = [...(p.tables || []), ...(p.lists || [])];
    if (tabs.length) out.push('', '## Tables and lists');
    tabs.forEach((t, i) => out.push('', `### ${t.caption || `${t.kind === 'list' ? 'List' : 'Table'} ${i + 1}`}`, '', mdTable(t)));
    return out.join('\n');
  }
  writeNote(p) {
    if (!this.notesDir) return;
    try {
      fs.mkdirSync(this.notesDir, { recursive: true });
      const name = this.noteName(p);
      if (p.noteFile && p.noteFile !== name) fs.rmSync(path.join(this.notesDir, p.noteFile), { force: true });
      fs.writeFileSync(path.join(this.notesDir, name), this.noteText(p));
      if (p.noteFile !== name) {
        p.noteFile = name;
        if (this.dir) fs.writeFileSync(this.file(p.id), JSON.stringify(p));
      }
      this.reindexSoon();
    } catch (_) { /* notes are a convenience */ }
  }
  dropNote(p) {
    if (!this.notesDir || !p.noteFile) return;
    try { fs.rmSync(path.join(this.notesDir, p.noteFile), { force: true }); this.reindexSoon(); } catch (_) { /* gone */ }
  }
  forgetAll() {
    for (const s of this.index()) {
      const p = this.load(s.id);
      if (p && p.noteFile) { this.dropNote(p); p.noteFile = null; if (this.dir) fs.writeFileSync(this.file(p.id), JSON.stringify(p)); }
    }
  }
  learnAll() { for (const s of this.index()) { const p = this.load(s.id); if (p) this.writeNote(p); } }
  reindexSoon() {
    if (!this.knowledge || !this.notesDir || this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      try { this.knowledge.addFolder(this.notesDir); this.knowledge.startIndex(); } catch (_) { /* knowledge is optional */ }
    }, 3000);
    if (this.indexTimer.unref) this.indexTimer.unref();
  }

  // ------------------------------------------------------------------ save
  /**
   * Keep a page that was read (from the browser, the built-in browser or a link).
   * The same address read again updates the page and notes what changed.
   */
  save(raw = {}, { via = raw.via || 'link', note } = {}) {
    const url = normalizeUrl(raw.url) || String(raw.url || '');
    const title = clip(String(raw.title || '').replace(/\s+/g, ' ').trim(), 300) || host(url) || 'Web page';
    const why = this.blockedReason(url, title);
    if (why) { const e = new Error(why); e.blocked = true; throw e; }
    const text = String(raw.text || '').replace(/\r/g, '').slice(0, MAX_TEXT);
    const tables = (raw.tables || []).slice(0, 25).map(cleanTable).filter((t) => t.rows.length);
    const lists = (raw.lists || []).slice(0, 10).map((t) => cleanTable({ ...t, kind: 'list' })).filter((t) => t.rows.length);
    if (!text.trim() && !tables.length && !lists.length) throw new Error('Nothing could be read from this page. If it needs you to sign in, open it in the built-in browser on the Web page, sign in there, and read it again.');
    const id = `wp_${crypto.createHash('sha1').update(url || `${title}${text.slice(0, 200)}`).digest('hex').slice(0, 16)}`;
    const prev = this.load(id);
    const at = now();
    const page = {
      id, url, title, site: clip((raw.meta && raw.meta.site) || host(url), 80), via, at, first: prev ? prev.first || prev.at : at,
      text, selection: clip(raw.selection || '', 20000), headings: (raw.headings || []).slice(0, 60).map((h) => clip(h, 200)),
      tables: [...tables, ...((prev && prev.tables) || []).filter((t) => t.kind === 'ai')], lists,
      links: (raw.links || []).filter((l) => l && /^https?:/i.test(l.href)).slice(0, 400).map((l) => ({ text: clip(l.text, 160), href: String(l.href).slice(0, 1000) })),
      meta: { description: clip(raw.meta && raw.meta.description, 600), author: clip(raw.meta && raw.meta.author, 120), published: clip(raw.meta && raw.meta.published, 40) },
      note: note !== undefined ? clip(note, 2000) : (prev && prev.note) || '',
      watch: (prev && prev.watch) || 0, checked: at, noteFile: prev && prev.noteFile,
      change: prev ? { at, ...diff(prev, { text, tables, lists }) } : null,
    };
    this.store(page);
    return page;
  }

  list({ q = '', limit = 300 } = {}) {
    let rows = this.index();
    const ws = words(q);
    if (ws.length) {
      rows = rows.map((s) => {
        const hay = `${s.title} ${s.url} ${s.site} ${s.note}`.toLowerCase();
        let n = ws.filter((w) => hay.includes(w)).length * 3;
        if (n < ws.length * 3) { const p = this.load(s.id); const t = p ? p.text.toLowerCase() : ''; n += ws.filter((w) => t.includes(w)).length; }
        return { s, n };
      }).filter((x) => x.n >= ws.length).sort((a, b) => b.n - a.n).map((x) => x.s);
    }
    return rows.slice(0, limit);
  }
  get(id) {
    const p = this.load(id);
    if (!p) throw new Error('That page is no longer saved.');
    return p;
  }
  update(id, { note, watch, title } = {}) {
    const p = this.get(id);
    if (note !== undefined) p.note = clip(note, 2000);
    if (title !== undefined && String(title).trim()) p.title = clip(String(title).trim(), 300);
    if (watch !== undefined) p.watch = [0, 1, 4, 12, 24, 168].includes(Number(watch)) ? Number(watch) : 0;
    this.store(p);
    return p;
  }
  remove(id) {
    this.removeFiles(id);
    this.writeIndex(this.index().filter((x) => x.id !== id));
    return true;
  }
  clear() {
    for (const s of this.index()) this.removeFiles(s.id);
    this.writeIndex([]);
    return true;
  }

  // ----------------------------------------------------------------- reading
  /** Read a link: in the desktop app a hidden browser window runs the page; otherwise it is downloaded. */
  async readUrl(url, { note } = {}) {
    const u = normalizeUrl(url);
    if (!u || !/^(https?|file):/i.test(u)) throw new Error('Type a web address, like example.com/page.');
    const why = this.blockedReason(u, '');
    if (why) throw new Error(why);
    let page = null;
    let err = null;
    const isFile = /\.(pdf|docx|xlsx|xls|csv|txt|md)(\?|$)/i.test(new URL(u).pathname);
    if (this.loader && !isFile) {
      try { page = await this.loader(u); } catch (e) { err = e; }
    }
    if (!page || (!String(page.text || '').trim() && !(page.tables || []).length)) {
      try { page = await this.download(u); } catch (e) { if (!page) throw err || e; }
    }
    return this.save(page, { via: 'link', note });
  }

  /** Download a link and read it without running it (also PDFs and Office files). */
  async download(u) {
    const get = this.fetcher || ((x, o) => fetch(x, o));
    const res = await get(u, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Boardenda', accept: 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.8' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`The page answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`);
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 25e6) throw new Error('That file is too large to read (over 25 MB).');
    const finalUrl = res.url || u;
    const name = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || 'page');
    if (/pdf|officedocument|msword|ms-excel|spreadsheet/.test(type) || /\.(pdf|docx|xlsx|xls)$/i.test(name)) {
      const ext = /pdf/.test(type) ? '.pdf' : /word/.test(type) ? '.docx' : /sheet|excel/.test(type) ? '.xlsx' : '';
      const fname = ext && !name.toLowerCase().endsWith(ext) ? `${name}${ext}` : name;
      if (!this.readFile) throw new Error('This file type cannot be read here.');
      const text = await this.readFile(fname, buf);
      return { url: finalUrl, title: fname, text: String(text || ''), tables: [], lists: [], links: [], meta: {} };
    }
    const body = buf.toString(/charset=(iso-8859-1|latin1|windows-1252)/.test(type) ? 'latin1' : 'utf8');
    if (/json/.test(type)) { let t = body; try { t = JSON.stringify(JSON.parse(body), null, 2); } catch (_) { /* as is */ } return { url: finalUrl, title: name, text: t, tables: [], lists: [], links: [], meta: {} }; }
    if (/text\/plain|text\/csv|text\/markdown/.test(type)) return { url: finalUrl, title: name, text: body, tables: [], lists: [], links: [], meta: {} };
    return fromHtml(body, finalUrl);
  }

  /** Read the page again and note what changed. */
  async recheck(id) {
    const p = this.get(id);
    if (!/^(https?|file):/i.test(p.url)) throw new Error('This page has no address to read again.');
    const next = await this.readUrl(p.url);
    return next;
  }

  /** Watched pages that are due get read again; changes are posted to Chat. */
  async runWatches(at = new Date()) {
    if (this.watching) return 0;
    this.watching = true;
    let n = 0;
    try {
      for (const s of this.index().filter((x) => x.watch)) {
        if (s.checked && at - new Date(s.checked) < s.watch * 3600e3 - 60e3) continue;
        try {
          const p = await this.recheck(s.id);
          n += 1;
          if (p.change && p.change.changed && this.chat) {
            const c = p.change;
            const bits = [c.added ? `${c.added} new ${c.added === 1 ? 'line' : 'lines'}` : '', c.rowsAdded ? `${c.rowsAdded} new ${c.rowsAdded === 1 ? 'row' : 'rows'}` : '', c.removed ? `${c.removed} gone` : ''].filter(Boolean).join(', ');
            const lines = [...c.newRows, ...c.sample].slice(0, 6).map((l) => `- ${l}`).join('\n');
            this.chat.post('assistant', 'answer', `**${p.title}** changed (${bits}).\n${lines}\n\n${p.url}`, { mode: 'basic', web: p.id });
          }
        } catch (e) {
          const p = this.load(s.id);
          if (p) { p.checked = now(); p.change = { at: now(), error: String(e.message || e).slice(0, 200) }; this.store(p); }
        }
      }
    } finally { this.watching = false; }
    return n;
  }

  // -------------------------------------------------------------- AI helpers
  /** The page as text for the AI, cut to the passages that matter most for the question. */
  context(p, question = '', max = AI_CHARS) {
    const head = `Web page: ${p.title}\nAddress: ${p.url}\nRead: ${p.at.slice(0, 16).replace('T', ' ')}${p.note ? `\nUser's note: ${p.note}` : ''}${p.selection ? `\nText the user selected:\n${p.selection}` : ''}`;
    const tabs = [...(p.tables || []), ...(p.lists || [])].map((t, i) => `[${t.kind === 'list' ? 'List' : 'Table'} ${i + 1}] ${tableText(t)}`).join('\n\n');
    const full = `${head}\n\nPage text:\n${p.text}${tabs ? `\n\nTables and lists (tab separated):\n${tabs}` : ''}`;
    if (full.length <= max) return full;
    // Too long: keep the start, then the paragraphs that share the most words with the question.
    const ws = words(question);
    const paras = `${p.text}\n\n${tabs}`.split(/\n{2,}/).map((t, i) => ({ t, i, s: ws.reduce((n, w) => n + (t.toLowerCase().split(w).length - 1), 0) }));
    const keep = new Set();
    let size = head.length + 200;
    for (const x of paras.slice(0, 6)) { if (size + x.t.length > max * 0.3) break; keep.add(x.i); size += x.t.length; }
    for (const x of [...paras].sort((a, b) => b.s - a.s)) { if (!x.s) break; if (size + x.t.length > max) continue; keep.add(x.i); size += x.t.length; }
    return `${head}\n\nPage text (the parts that matter most; the page is long):\n${paras.filter((x) => keep.has(x.i)).map((x) => x.t).join('\n\n')}`;
  }

  /** Answer a question about one or more saved pages. */
  async ask(ids, question) {
    const list = (Array.isArray(ids) ? ids : [ids]).map((id) => this.get(id));
    const q = String(question || '').trim() || 'Summarize this page: what it is, the key facts and numbers, and anything I should act on.';
    const per = Math.floor(AI_CHARS * 1.5 / list.length);
    const ctx = list.map((p) => this.context(p, q, per)).join('\n\n=====\n\n');
    const r = await this.capture.askText({
      system: `You are the user's personal work assistant. Answer from the web page${list.length > 1 ? 's' : ''} below. Be specific: quote numbers, names, dates and prices exactly as the page shows them. Use short paragraphs or bullets. If the page does not say, say so plainly. Today is ${today()}.`,
      messages: [{ role: 'user', content: `${ctx}\n\nQuestion: ${q}` }], maxTokens: 2500,
    });
    if (r && r.text) return { answer: r.text, mode: r.mode, model: r.model };
    // No AI set up: the sentences that match the question best.
    const ws = words(q);
    const sents = list.flatMap((p) => p.text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 8));
    const top = sents.map((s) => ({ s, n: ws.filter((w) => s.toLowerCase().includes(w)).length })).filter((x) => x.n).sort((a, b) => b.n - a.n).slice(0, 6).map((x) => `- ${clip(x.s, 300)}`);
    const lead = list[0].meta && list[0].meta.description ? list[0].meta.description : clip(list[0].text.split('\n').find((l) => l.length > 60) || list[0].text, 400);
    return { answer: top.length ? `The page says:\n${top.join('\n')}` : `${lead}\n\n(Set up an AI model in Settings for real answers about pages.)`, mode: 'basic' };
  }

  /**
   * Scrape specific fields: "product, price, stock" or "every customer and their region".
   * Long pages are read in parts. The result is added to the page as a table.
   */
  async extract(id, instruction) {
    const p = this.get(id);
    const want = String(instruction || '').trim();
    if (!want) throw new Error('Say what to pull out, for example "name, price and stock for each product".');
    const schema = { type: 'object', properties: { columns: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } }, required: ['columns', 'rows'], additionalProperties: false };
    const tabs = [...(p.tables || []).filter((t) => t.kind !== 'ai'), ...(p.lists || [])].map((t, i) => `[Table ${i + 1}] ${tableText(t, MAX_ROWS)}`).join('\n\n');
    const all = `${p.text}${tabs ? `\n\nTables and lists (tab separated):\n${tabs}` : ''}`;
    const parts = [];
    for (let i = 0; i < all.length && parts.length < 6; i += 45000) parts.push(all.slice(i, i + 45000));
    let columns = null;
    const rows = [];
    let mode = 'basic';
    let model = '';
    for (const [k, part] of parts.entries()) {
      const r = await this.capture.askJson({
        system: 'You pull structured data out of a web page into a table. Return every matching record on the page, not a sample. Copy values exactly as written (numbers, prices, dates, names). Use an empty string when a record has no value for a column. Never invent records.',
        text: `What to pull out: ${want}\n${columns ? `Use exactly these columns: ${JSON.stringify(columns)}\n` : 'Choose short, clear column names.\n'}Page: ${p.title} (${p.url})${parts.length > 1 ? `\nThis is part ${k + 1} of ${parts.length} of the page.` : ''}\n\n${part}`,
        schema,
      });
      if (!r) break;
      mode = r.mode; model = r.model;
      const d = r.data || {};
      if (!columns && Array.isArray(d.columns) && d.columns.length) columns = d.columns.map(String).slice(0, 40);
      for (const row of Array.isArray(d.rows) ? d.rows : []) if (Array.isArray(row) && row.some((c) => String(c || '').trim())) rows.push(row.map((c) => String(c == null ? '' : c)));
    }
    let table;
    if (columns) {
      const seen = new Set();
      table = cleanTable({ caption: want, headers: columns, rows: rows.filter((r) => { const key = r.join('\u0001'); if (seen.has(key)) return false; seen.add(key); return true; }), kind: 'ai' });
    } else {
      // No AI: the table or list whose headings best match the request.
      const ws = words(want);
      const cands = [...(p.tables || []).filter((t) => t.kind !== 'ai'), ...(p.lists || [])].map((t) => ({ t, n: ws.filter((w) => `${t.caption} ${t.headers.join(' ')}`.toLowerCase().includes(w)).length + Math.min(1, t.rows.length / 50) })).sort((a, b) => b.n - a.n);
      if (!cands.length) throw new Error('Set up an AI model in Settings to pull out specific fields. This page has no tables to fall back on.');
      table = { ...cands[0].t, caption: `${want} (best matching table; set up an AI model for exact fields)`, kind: 'ai' };
    }
    p.tables = [...(p.tables || []).filter((t) => !(t.kind === 'ai' && t.caption === table.caption)), table];
    this.store(p);
    return { page: p, table, index: p.tables.length - 1, mode, model };
  }

  /** One table (tables first, then lists) as an Excel workbook or CSV text. */
  async exportTable(id, which = 0, format = 'xlsx') {
    const p = this.get(id);
    const all = [...(p.tables || []), ...(p.lists || [])];
    const t = which === 'all' ? null : all[Number(which) || 0];
    if (which !== 'all' && !t) throw new Error('That table is no longer on this page.');
    const base = safeName(`${p.title}${t && t.caption ? ` - ${t.caption}` : ''}`).slice(0, 80);
    if (format === 'csv') {
      const q = (c) => (/[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : String(c));
      return { name: `${base}.csv`, text: [t.headers, ...t.rows].map((r) => r.map(q).join(',')).join('\r\n') };
    }
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const used = new Set();
    for (const [i, tb] of (t ? [t] : all).entries()) {
      let name = safeName(tb.caption || `${tb.kind === 'list' ? 'List' : 'Table'} ${i + 1}`).replace(/[[\]]/g, '').slice(0, 28) || `Sheet ${i + 1}`;
      while (used.has(name.toLowerCase())) name = `${name.slice(0, 25)} ${i + 1}`;
      used.add(name.toLowerCase());
      const ws = wb.addWorksheet(name);
      ws.addRow(tb.headers).font = { bold: true };
      for (const r of tb.rows) ws.addRow(r.map((c) => (/^-?\d{1,15}(\.\d+)?$/.test(c) ? Number(c) : c)));
      ws.columns.forEach((c, k) => { c.width = Math.min(60, Math.max(10, ...[tb.headers[k] || '', ...tb.rows.slice(0, 200).map((r) => r[k] || '')].map((x) => String(x).length + 2))); });
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    }
    const src = wb.addWorksheet('Source');
    src.addRow(['Page', p.title]); src.addRow(['Address', p.url]); src.addRow(['Read', p.at]);
    return { name: `${base}.xlsx`, bytes: Buffer.from(await wb.xlsx.writeBuffer()) };
  }

  /** Hand the page to the assistant: it reads it like a dropped file and suggests actions in Chat. */
  async toAssistant(id, { note = '' } = {}) {
    const p = this.get(id);
    const ask = String(note || p.note || '').trim();
    const text = `${ask ? `What I want from this page: ${ask}\n\n` : ''}${this.context(p, ask, 40000)}`;
    const caseId = await this.assistant.intake({ text, origin: 'web', title: `Web: ${clip(p.title, 120)}` });
    if (this.chat) { try { this.chat.post('assistant', 'cases', `Reading the web page "${clip(p.title, 120)}". Anything to act on will show here.`, { caseIds: [caseId] }); } catch (_) { /* chat is optional */ } }
    return { caseId };
  }
}

module.exports = { Web, normalizeUrl, diff, tableText, DEFAULTS };
