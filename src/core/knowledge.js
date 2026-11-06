'use strict';
// Ask: a chat that answers questions from the business data in Boardenda and
// from documents in folders on this PC that the user chose. Documents are read
// and indexed on this PC into a separate knowledge.db (full-text search, plus
// embeddings when Ollama has an embedding model). Answers come from the local
// model (Llama by default); Claude is used only if set up, and file excerpts go
// to it only when the user allows that.

const fs = require('fs');
const path = require('path');
const C = require('./columns');
const { loadSql } = require('./db');
const { today, parseJson } = require('./util');

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.log', '.html', '.htm', '.eml', '.rtf', '.xml', '.ini', '.yaml', '.yml']);
const DOC_EXT = new Set(['.docx', '.pdf', '.xlsx']);
const SKIP_DIRS = /^(node_modules|\.git|\.svn|\.hg|\$recycle\.bin|system volume information|appdata|windows|program files|program files \(x86\)|programdata|__pycache__|\.cache|\.venv|venv|dist|build|bin|obj)$/i;
const MAX_FILE = 15 * 1024 * 1024;
const MAX_FILES = 20000;
const CHUNK = 1100;
const OVERLAP = 180;
const STOP = new Set('a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or our please show so tell than that the their them then there these they this to us was we what when where which who whom why will with would you your about any all also give find list get much many more most some anything something know need want'.split(' '));
const EMBED_RE = /embed|bge|minilm|e5-|gte-|arctic-embed/i;

const words = (q) => [...new Set(String(q || '').toLowerCase().match(/[a-z0-9][a-z0-9'@._-]*[a-z0-9]|[a-z0-9]/g) || [])].filter((w) => w.length > 1 && !STOP.has(w));
const strip = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');

function chunkText(text) {
  const t = String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!t) return [];
  const out = [];
  let i = 0;
  while (i < t.length) {
    let end = Math.min(t.length, i + CHUNK);
    if (end < t.length) {
      const para = t.lastIndexOf('\n\n', end);
      const sent = t.lastIndexOf('. ', end);
      if (para > i + CHUNK * 0.5) end = para;
      else if (sent > i + CHUNK * 0.5) end = sent + 1;
    }
    out.push(t.slice(i, end).trim());
    if (end >= t.length) break;
    i = Math.max(end - OVERLAP, i + 1);
  }
  return out.filter((c) => c.length > 20);
}

function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

class Knowledge {
  constructor({ db, dataDir, store, capture, customers, meetings }) {
    this.db = db; // main database (settings)
    this.dataDir = dataDir;
    this.store = store;
    this.capture = capture;
    this.customers = customers;
    this.meetings = meetings;
    this.kdb = null;
    this.job = null;
    this.vecCache = null;
  }

  // -------------------------------------------------------------- settings
  config() {
    const r = this.db.get("SELECT value FROM settings WHERE key='knowledge'");
    const v = parseJson(r && r.value, {});
    return { folders: Array.isArray(v.folders) ? v.folders : [], allowCloud: !!v.allowCloud, lastIndexed: v.lastIndexed || null, useBusiness: v.useBusiness !== false };
  }
  saveConfig(patch) {
    const next = { ...this.config(), ...patch };
    this.db.run("INSERT INTO settings(key,value) VALUES('knowledge',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(next)]);
    return next;
  }
  addFolder(p) {
    const dir = path.resolve(String(p || ''));
    if (!p || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('That folder does not exist');
    const cfg = this.config();
    if (cfg.folders.some((f) => path.resolve(f).toLowerCase() === dir.toLowerCase())) return this.status();
    this.saveConfig({ folders: [...cfg.folders, dir] });
    return this.status();
  }
  async removeFolder(p) {
    const cfg = this.config();
    this.saveConfig({ folders: cfg.folders.filter((f) => f !== p) });
    const k = await this.open();
    const ids = this.kall('SELECT id FROM files WHERE folder=?', [p]).map((r) => r.id);
    this.dropFiles(ids);
    this.ksave();
    return this.status();
  }
  setOptions({ allowCloud, useBusiness } = {}) {
    const patch = {};
    if (allowCloud !== undefined) patch.allowCloud = !!allowCloud;
    if (useBusiness !== undefined) patch.useBusiness = !!useBusiness;
    this.saveConfig(patch);
    return this.status();
  }

  // ---------------------------------------------------------- index store
  async open() {
    if (this.kdb) return this.kdb;
    const S = await loadSql();
    const file = this.dataDir ? path.join(this.dataDir, 'knowledge.db') : null;
    let k;
    try { k = file && fs.existsSync(file) ? new S.Database(fs.readFileSync(file)) : new S.Database(); } catch (_) { k = new S.Database(); }
    k.exec(`CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, path TEXT UNIQUE, folder TEXT, name TEXT, ext TEXT, mtime REAL, size INTEGER, indexed_at TEXT, chunks INTEGER DEFAULT 0, error TEXT DEFAULT '');
      CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, file_id INTEGER, idx INTEGER, text TEXT, vec BLOB);
      CREATE INDEX IF NOT EXISTS ix_chunks_file ON chunks(file_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts4(text, tokenize=unicode61);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);
    this.kdb = k;
    this.kfile = file;
    return k;
  }
  kall(sql, params = []) {
    const st = this.kdb.prepare(sql);
    try { st.bind(params); const rows = []; while (st.step()) rows.push(st.getAsObject()); return rows; } finally { st.free(); }
  }
  kget(sql, params = []) { return this.kall(sql, params)[0] || null; }
  ksave() {
    if (!this.kfile) return;
    const tmp = `${this.kfile}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(this.kdb.export()));
    fs.renameSync(tmp, this.kfile);
  }
  dropFiles(ids) {
    for (const id of ids) {
      for (const c of this.kall('SELECT id FROM chunks WHERE file_id=?', [id])) this.kdb.run('DELETE FROM chunk_fts WHERE docid=?', [c.id]);
      this.kdb.run('DELETE FROM chunks WHERE file_id=?', [id]);
      this.kdb.run('DELETE FROM files WHERE id=?', [id]);
    }
    this.vecCache = null;
  }

  async status() {
    await this.open();
    const cfg = this.config();
    const n = this.kget('SELECT COUNT(*) AS files, SUM(chunks) AS chunks, SUM(CASE WHEN error<>\'\' THEN 1 ELSE 0 END) AS errors FROM files');
    const perFolder = Object.fromEntries(this.kall('SELECT folder, COUNT(*) AS n FROM files GROUP BY folder').map((r) => [r.folder, r.n]));
    const vec = this.kget('SELECT COUNT(*) AS n FROM chunks WHERE vec IS NOT NULL').n;
    return {
      folders: cfg.folders.map((f) => ({ path: f, files: perFolder[f] || 0, missing: !fs.existsSync(f) })),
      files: n.files || 0, chunks: n.chunks || 0, errors: n.errors || 0, embedded: vec, embedModel: (this.kget("SELECT value FROM meta WHERE key='embedModel'") || {}).value || '',
      allowCloud: cfg.allowCloud, useBusiness: cfg.useBusiness, lastIndexed: cfg.lastIndexed,
      job: this.job ? { ...this.job } : null,
    };
  }

  // -------------------------------------------------------------- reading
  async fileText(file, ext) {
    const bytes = fs.readFileSync(file);
    if (TEXT_EXT.has(ext)) {
      const t = bytes.toString('utf8');
      if (ext === '.html' || ext === '.htm' || ext === '.eml' || ext === '.xml') return strip(t);
      if (ext === '.rtf') return t.replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^}]*\}|\\[a-z]+-?\d* ?|[{}]/gi, '');
      return t;
    }
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      return (await mammoth.extractRawText({ buffer: bytes })).value;
    }
    if (ext === '.xlsx') {
      const { readTable } = require('./io');
      const rows = await readTable(path.basename(file), bytes);
      return rows.slice(0, 3000).map((r) => r.filter((v) => v !== '').join(' | ')).filter(Boolean).join('\n');
    }
    if (ext === '.pdf') {
      const { extract } = require('./extract');
      const r = await extract(path.basename(file), bytes, async () => []);
      return r.text || (r.rows || []).map((x) => x.join(' ')).join('\n');
    }
    return '';
  }

  /** Every readable file under the chosen folders. */
  walk(folders) {
    const out = [];
    const visit = (dir, root, depth) => {
      if (out.length >= MAX_FILES || depth > 12) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        if (out.length >= MAX_FILES) return;
        if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.test(e.name)) visit(p, root, depth + 1); continue; }
        if (!e.isFile()) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (!TEXT_EXT.has(ext) && !DOC_EXT.has(ext)) continue;
        let st;
        try { st = fs.statSync(p); } catch (_) { continue; }
        if (st.size > MAX_FILE || st.size === 0) continue;
        out.push({ path: p, folder: root, name: e.name, ext, mtime: st.mtimeMs, size: st.size });
      }
    };
    for (const f of folders) if (fs.existsSync(f)) visit(f, f, 0);
    return out;
  }

  /** The Ollama embedding model to use, if one is installed. */
  async embedModel() {
    const cfg = this.capture.aiConfig();
    if (cfg.provider === 'off' || cfg.provider === 'openai' || cfg.provider === 'anthropic') return null;
    try {
      const r = await this.capture.localFetch({ ...cfg, provider: 'ollama' }, '/api/tags', null, 3000);
      const names = (r.models || []).map((m) => m.name);
      return names.find((m) => /nomic-embed/i.test(m)) || names.find((m) => /mxbai-embed/i.test(m)) || names.find((m) => EMBED_RE.test(m)) || null;
    } catch (_) { return null; }
  }
  async embed(model, inputs) {
    const cfg = this.capture.aiConfig();
    const r = await this.capture.localFetch({ ...cfg, provider: 'ollama' }, '/api/embed', { model, input: inputs }, 120000);
    return r.embeddings || [];
  }

  /**
   * Bring the index up to date with the chosen folders: read new and changed
   * files, drop deleted ones. Runs in the background; status() shows progress.
   */
  async index({ force = false } = {}) {
    if (this.job && this.job.running) return this.status();
    await this.open();
    const cfg = this.config();
    this.job = { running: true, phase: 'Looking for files', done: 0, total: 0, current: '', added: 0, updated: 0, removed: 0, failed: 0, startedAt: new Date().toISOString() };
    try {
      const found = this.walk(cfg.folders);
      const known = Object.fromEntries(this.kall('SELECT id, path, mtime, size FROM files').map((r) => [r.path, r]));
      const keep = new Set(found.map((f) => f.path));
      const gone = Object.values(known).filter((r) => !keep.has(r.path) || !cfg.folders.some((f) => r.path.startsWith(f))).map((r) => r.id);
      this.dropFiles(gone);
      this.job.removed = gone.length;
      const todo = found.filter((f) => force || !known[f.path] || Math.abs(known[f.path].mtime - f.mtime) > 1 || known[f.path].size !== f.size);
      this.job.total = todo.length;
      this.job.phase = 'Reading documents';
      let model = await this.embedModel();
      const prevModel = (this.kget("SELECT value FROM meta WHERE key='embedModel'") || {}).value || '';
      if (model && prevModel && model !== prevModel) { this.kdb.run('UPDATE chunks SET vec=NULL'); }
      if (model) this.kdb.run("INSERT OR REPLACE INTO meta(key,value) VALUES('embedModel',?)", [model]);
      let sinceSave = 0;
      for (const f of todo) {
        this.job.current = f.name;
        let text = '';
        let error = '';
        try { text = await this.fileText(f.path, f.ext); } catch (e) { error = String(e.message || e).slice(0, 200); this.job.failed += 1; }
        const chunks = chunkText(`${f.name}\n${text}`);
        const old = known[f.path];
        if (old) this.dropFiles([old.id]);
        this.kdb.run('INSERT INTO files(path,folder,name,ext,mtime,size,indexed_at,chunks,error) VALUES(?,?,?,?,?,?,?,?,?)',
          [f.path, f.folder, f.name, f.ext, f.mtime, f.size, new Date().toISOString(), chunks.length, error]);
        const fid = this.kget('SELECT last_insert_rowid() AS id').id;
        let vecs = [];
        if (model && chunks.length) {
          try { vecs = await this.embed(model, chunks.slice(0, 200)); } catch (_) { model = null; }
        }
        chunks.forEach((c, i) => {
          const v = vecs[i] ? Buffer.from(new Float32Array(vecs[i]).buffer) : null;
          this.kdb.run('INSERT INTO chunks(file_id,idx,text,vec) VALUES(?,?,?,?)', [fid, i, c, v]);
          const cid = this.kget('SELECT last_insert_rowid() AS id').id;
          this.kdb.run('INSERT INTO chunk_fts(docid,text) VALUES(?,?)', [cid, c]);
        });
        if (old) this.job.updated += 1; else this.job.added += 1;
        this.job.done += 1;
        if (++sinceSave >= 150) { this.ksave(); sinceSave = 0; }
        await new Promise((r) => setImmediate(r)); // keep the app responsive
      }
      // Fill in embeddings for chunks indexed before a model was installed.
      if (model) {
        const missing = this.kall('SELECT id, text FROM chunks WHERE vec IS NULL LIMIT 4000');
        this.job.phase = 'Preparing smart search';
        for (let i = 0; i < missing.length; i += 32) {
          const batch = missing.slice(i, i + 32);
          let vecs;
          try { vecs = await this.embed(model, batch.map((b) => b.text)); } catch (_) { break; }
          batch.forEach((b, j) => { if (vecs[j]) this.kdb.run('UPDATE chunks SET vec=? WHERE id=?', [Buffer.from(new Float32Array(vecs[j]).buffer), b.id]); });
          await new Promise((r) => setImmediate(r));
        }
      }
      this.vecCache = null;
      this.ksave();
      this.saveConfig({ lastIndexed: new Date().toISOString() });
      this.job = { ...this.job, running: false, phase: 'Done', current: '', finishedAt: new Date().toISOString() };
    } catch (e) {
      this.job = { ...this.job, running: false, phase: 'Failed', error: String(e.message || e) };
    }
    return this.status();
  }

  /** Start indexing without waiting for it. */
  startIndex(opts) { this.index(opts).catch(() => {}); return this.status(); }

  /** Re-index in the background when the last run is older than six hours. */
  maybeRefresh() {
    const cfg = this.config();
    if (!cfg.folders.length || (this.job && this.job.running)) return false;
    if (cfg.lastIndexed && Date.now() - Date.parse(cfg.lastIndexed) < 6 * 3600e3) return false;
    this.startIndex();
    return true;
  }

  // --------------------------------------------------------------- search
  /** Passages from the indexed files that best match the question. */
  async searchFiles(q, limit = 8) {
    await this.open();
    const ws = words(q).slice(0, 12);
    const scored = new Map();
    if (ws.length) {
      const match = ws.map((w) => `${w.replace(/["*]/g, '')}*`).join(' OR ');
      let rows = [];
      try { rows = this.kall('SELECT c.id, c.text, c.file_id FROM chunk_fts f JOIN chunks c ON c.id=f.docid WHERE chunk_fts MATCH ? LIMIT 400', [match]); } catch (_) { rows = []; }
      const total = Math.max(1, this.kget('SELECT COUNT(*) AS n FROM chunks').n);
      const df = {};
      for (const w of ws) df[w] = rows.filter((r) => r.text.toLowerCase().includes(w)).length || 1;
      for (const r of rows) {
        const t = r.text.toLowerCase();
        let s = 0;
        let hits = 0;
        for (const w of ws) {
          const n = t.split(w).length - 1;
          if (n) { hits += 1; s += (1 + Math.log(n)) * Math.log(1 + total / df[w]); }
        }
        s *= 1 + hits / ws.length; // passages with more of the words rank higher
        scored.set(r.id, { id: r.id, fileId: r.file_id, text: r.text, kw: s, vec: 0 });
      }
    }
    // Meaning-based search when an embedding model is available.
    const model = (this.kget("SELECT value FROM meta WHERE key='embedModel'") || {}).value;
    if (model && this.kget('SELECT id FROM chunks WHERE vec IS NOT NULL LIMIT 1')) {
      try {
        const [qv] = await this.embed(model, [q]);
        if (qv) {
          if (!this.vecCache) this.vecCache = this.kall('SELECT id, file_id, vec FROM chunks WHERE vec IS NOT NULL LIMIT 60000').map((r) => ({ id: r.id, fileId: r.file_id, v: new Float32Array(new Uint8Array(r.vec).buffer) }));
          const top = this.vecCache.map((r) => ({ r, s: cosine(qv, r.v) })).sort((a, b) => b.s - a.s).slice(0, 30);
          for (const { r, s } of top) {
            const cur = scored.get(r.id) || { id: r.id, fileId: r.fileId, text: null, kw: 0 };
            cur.vec = s;
            scored.set(r.id, cur);
          }
        }
      } catch (_) { /* Ollama stopped: keyword results only */ }
    }
    const maxKw = Math.max(0.0001, ...[...scored.values()].map((x) => x.kw));
    const list = [...scored.values()].map((x) => ({ ...x, score: x.kw / maxKw * 0.55 + Math.max(0, x.vec) * 0.9 })).sort((a, b) => b.score - a.score);
    const out = [];
    const perFile = {};
    for (const x of list) {
      if (out.length >= limit) break;
      if ((perFile[x.fileId] = (perFile[x.fileId] || 0) + 1) > 3) continue;
      const f = this.kget('SELECT path, name, folder FROM files WHERE id=?', [x.fileId]);
      if (!f) continue;
      const text = x.text || (this.kget('SELECT text FROM chunks WHERE id=?', [x.id]) || {}).text || '';
      out.push({ kind: 'file', path: f.path, name: f.name, folder: f.folder, text, score: Math.round(x.score * 100) / 100 });
    }
    return out;
  }

  /** Items, customers and calls in Boardenda that relate to the question. */
  searchBusiness(q) {
    const ws = words(q);
    const out = [];
    const ctx = { people: this.store.peopleMap(), teams: this.store.teamsMap(), customers: this.store.customersMap() };
    const colCache = {};
    const describeItem = (id) => {
      const it = this.db.get('SELECT i.id, i.name, i.board_id, i.parent_id, i.data, i.archived, b.name AS board, g.name AS grp FROM items i JOIN boards b ON b.id=i.board_id LEFT JOIN groups g ON g.id=i.group_id WHERE i.id=? AND b.archived=0', [id]);
      if (!it) return null;
      const cols = colCache[it.board_id] || (colCache[it.board_id] = this.store.columns(it.board_id));
      const data = parseJson(it.data, {});
      const vals = cols.filter((c) => c.scope === (it.parent_id ? 'sub' : 'item') && !C.isComputed(c.type) && data[c.id] != null)
        .map((c) => { const t = C.textOf(c, data[c.id], ctx); return t ? `${c.title}: ${String(t).slice(0, 200)}` : ''; }).filter(Boolean);
      const parent = it.parent_id ? this.db.get('SELECT name FROM items WHERE id=?', [it.parent_id]) : null;
      return { kind: 'item', id: it.parent_id || it.id, name: it.name, board: it.board,
        text: `${parent ? `Subitem of “${parent.name}”` : 'Item'} “${it.name}” on board ${it.board}${it.grp ? `, group ${it.grp}` : ''}${it.archived ? ' (archived)' : ''}. ${vals.join('; ')}` };
    };
    // Items: score by how many of the words they contain.
    const hits = new Map();
    for (const w of ws.slice(0, 8)) {
      for (const r of this.store.search(w, { limit: 40 })) {
        if (r.kind !== 'item' && r.kind !== 'subitem' && r.kind !== 'update') continue;
        const id = r.subId || r.id;
        const h = hits.get(id) || { id, n: 0, words: new Set() };
        if (!h.words.has(w)) { h.words.add(w); h.n += r.score || 1; }
        hits.set(id, h);
      }
    }
    for (const h of [...hits.values()].sort((a, b) => b.words.size - a.words.size || b.n - a.n).slice(0, 10)) {
      const d = describeItem(h.id);
      if (d) out.push(d);
    }
    // Customers, with contacts and devices.
    if (this.customers) {
      const seen = new Set();
      const all = this.customers.list();
      const named = all.filter((c) => ws.some((w) => c.name.toLowerCase().includes(w) && w.length > 2));
      const found = [...named];
      for (const w of ws.slice(0, 6)) if (w.length > 2) for (const c of this.customers.list({ q: w })) found.push(c);
      for (const c of found) {
        if (seen.has(c.id) || seen.size >= 4) continue;
        seen.add(c.id);
        out.push({ kind: 'customer', id: c.id, name: c.name, text: `Customer profile:\n${this.customers.summary(c.id)}\nOpen tasks: ${c.openTasks}. Calls: ${c.calls}${c.nextCall ? `, next ${c.nextCall}` : ''}${c.lastCall ? `, last ${c.lastCall}` : ''}.` });
      }
      if (/\bcustomers?\b|\bclients?\b|\baccounts?\b/i.test(q) && !named.length) {
        out.push({ kind: 'note', text: `All customers (${all.length}): ${all.slice(0, 80).map((c) => `${c.name} [${c.status}${c.openTasks ? `, ${c.openTasks} open tasks` : ''}${c.devices ? `, ${c.devices} devices` : ''}]`).join('; ')}` });
      }
    }
    // Calls and meetings.
    if (this.meetings) {
      const ms = new Map();
      for (const w of ws.slice(0, 6)) if (w.length > 2) for (const m of this.meetings.list({ q: w })) ms.set(m.id, m);
      for (const m of [...ms.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 4)) {
        out.push({ kind: 'meeting', id: m.id, name: m.title, text: `Call or meeting:\n${this.meetings.summary(m.id)}` });
      }
    }
    return out;
  }

  /** A short overview so general questions ("what is overdue?") have something to work with. */
  overview(myWork) {
    const t = today();
    const boards = this.db.all('SELECT b.id, b.name, (SELECT COUNT(*) FROM items i WHERE i.board_id=b.id AND i.archived=0 AND i.parent_id IS NULL) AS n FROM boards b WHERE b.archived=0 ORDER BY b.position');
    const lines = [`Today is ${t}. You are ${this.store.me().name}.`, `Boards: ${boards.map((b) => `${b.name} (${b.n} items)`).join(', ') || 'none'}.`];
    try {
      const mine = myWork();
      const over = mine.filter((x) => x.bucket === 'overdue');
      const soon = mine.filter((x) => x.bucket === 'today' || x.bucket === 'week');
      if (over.length) lines.push(`Overdue for me: ${over.slice(0, 12).map((x) => `${x.name} (${x.boardName}, due ${x.due})`).join('; ')}.`);
      if (soon.length) lines.push(`Due soon for me: ${soon.slice(0, 12).map((x) => `${x.name} (${x.boardName}, due ${x.due})`).join('; ')}.`);
    } catch (_) { /* optional */ }
    if (this.meetings) {
      const up = this.meetings.list({ from: t }).filter((m) => m.status === 'planned').slice(0, 6);
      if (up.length) lines.push(`Upcoming calls and meetings: ${up.map((m) => `${m.title}${m.customer ? ` with ${m.customer}` : ''} on ${m.date} ${m.time}`).join('; ')}.`);
    }
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ ask
  async ask({ question, history = [] } = {}, { myWork } = {}) {
    const q = String(question || '').trim();
    if (!q) throw new Error('Type a question first.');
    const cfg = this.config();
    const [files, biz] = [await this.searchFiles(q, 8), cfg.useBusiness ? this.searchBusiness(q) : []];
    const { engine, cfg: aiCfg, localCfg } = await this.capture.pickEngine();
    const cloud = engine === 'claude';
    const fileSources = cloud && !cfg.allowCloud ? [] : files;
    const sources = [...biz, ...fileSources].map((s, i) => ({ ...s, n: i + 1 }));
    const notes = [];
    if (cloud && !cfg.allowCloud && files.length) notes.push(`${files.length} matching passages from your files were not sent to Claude. Allow it in Settings › AI, or use a local model.`);
    const result = { mode: 'basic', model: null, answer: null, notes,
      sources: sources.map((s) => ({ n: s.n, kind: s.kind, id: s.id || null, name: s.name || (s.kind === 'note' ? 'Overview' : ''), path: s.path || null, board: s.board || null, snippet: String(s.text || '').replace(/\s+/g, ' ').slice(0, 260), score: s.score })) };
    if (engine === 'basic') {
      result.notes.push(this.capture.aiConfig().provider === 'off' ? 'AI is off in Settings › AI, so here is what was found.' : 'No AI model is running (start Ollama to get written answers), so here is what was found.');
      return result;
    }
    const context = [
      `<overview>\n${this.overview(myWork)}\n</overview>`,
      ...sources.map((s) => `<source n="${s.n}" kind="${s.kind}"${s.path ? ` file="${s.path}"` : ''}${s.name ? ` name="${String(s.name).replace(/"/g, "'")}"` : ''}>\n${String(s.text).slice(0, 2400)}\n</source>`),
    ].join('\n\n');
    const system = `You are the assistant inside Boardenda, a work management app that runs on the user's PC. Answer questions about their business using only the overview and the numbered sources: items on their boards, customers with contacts and devices, calls and meetings, and passages from documents in folders on their PC.
- Be direct and brief. Lead with the answer. Use short lists when there are several things.
- Cite sources inline as [1], [2] using their numbers. Mention file names when the answer comes from a document.
- If the sources don't contain the answer, say so plainly and suggest what to search for or which folder to add. Never invent names, numbers, dates or contact details.
- Today is ${today()}.`;
    const turns = (Array.isArray(history) ? history : []).slice(-6).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content || '').slice(0, 4000) })).filter((h) => h.content);
    const user = `${context}\n\nQuestion: ${q}`;
    try {
      if (engine === 'local') {
        const { model } = await this.capture.localModels(localCfg);
        if (!model) throw new Error('No chat model is installed. Run: ollama pull llama3.2');
        let answer;
        if (localCfg.provider === 'openai') {
          const r = await this.capture.localFetch(localCfg, '/v1/chat/completions', { model, temperature: 0.2, messages: [{ role: 'system', content: system }, ...turns, { role: 'user', content: user }] }, 300000);
          answer = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
        } else {
          const r = await this.capture.localFetch(localCfg, '/api/chat', { model, stream: false, options: { temperature: 0.2, num_ctx: 16384 }, messages: [{ role: 'system', content: system }, ...turns, { role: 'user', content: user }] }, 300000);
          answer = r.message && r.message.content;
        }
        return { ...result, mode: 'local', model, answer: String(answer || '').trim() || 'The model returned an empty answer.' };
      }
      const Anthropic = require('@anthropic-ai/sdk');
      const Client = Anthropic.default || Anthropic;
      const client = new Client({ apiKey: aiCfg.key, maxRetries: 2, timeout: 120000, ...(process.env.BOARDENDA_ANTHROPIC_BASE_URL ? { baseURL: process.env.BOARDENDA_ANTHROPIC_BASE_URL } : {}) });
      const response = await client.beta.messages.create({
        model: aiCfg.model, max_tokens: 4000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'low' },
        system: [{ type: 'text', text: system }], messages: [...turns, { role: 'user', content: user }],
      });
      if (response.stop_reason === 'refusal') throw new Error('Claude declined to answer this.');
      const answer = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      return { ...result, mode: 'claude', model: aiCfg.model, answer: answer || 'Claude returned an empty answer.' };
    } catch (e) {
      result.notes.push(`The model could not answer (${e.message || e}), so here is what was found.`);
      return result;
    }
  }
}

module.exports = { Knowledge, chunkText, words };
