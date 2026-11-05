'use strict';
// Quick capture: paste or drop rough notes (text, Word, PDF, a photo) and get
// proposed records: items on the right board and group, calls and meetings,
// action items with owners and due dates, and updates on existing items.
// With an Anthropic API key Claude reads the notes; without one a built-in
// reader uses the boards, people and customers already in Boardenda. Anything
// it is unsure about is flagged so the user maps it before anything is created.

const C = require('./columns');
const { today, addDays, parseJson } = require('./util');

const KINDS = ['item', 'meeting', 'action', 'update'];
const DEFAULT_MODEL = 'claude-opus-5-5';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
function isLocalUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1'].includes(h) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /\.local$/.test(h);
  } catch (_) { return false; }
}
const STOP = new Set('the a an and or of to for on in at with by from is are be this that it we our us you i me my need needs new call meeting notes re fw fwd up about next week today tomorrow'.split(' '));

const dow = (iso) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const toHtml = (text) => String(text || '').split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

/** A date written loosely ("tomorrow", "Fri", "next week", "Nov 12", "12/11", "2026-11-12") as YYYY-MM-DD. */
function parseDate(s, base = today()) {
  const t = String(s || '').toLowerCase();
  let m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (/\btoday\b|\beod\b/.test(t)) return base;
  if (/\btomorrow\b|\btmrw\b/.test(t)) return addDays(base, 1);
  if (/\bnext week\b/.test(t)) return addDays(base, 8 - dow(base));
  if (/\bend of (the )?week\b|\beow\b/.test(t)) return addDays(base, (5 - dow(base) + 7) % 7);
  if (/\bend of (the )?month\b|\beom\b/.test(t)) { const [y, mo] = base.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); }
  m = t.match(/\bin (\d{1,2}) (day|week)s?\b/);
  if (m) return addDays(base, Number(m[1]) * (m[2] === 'week' ? 7 : 1));
  m = t.match(/\b(next )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu|thurs?|fri)\b/);
  if (m) {
    const want = DAYS.findIndex((d) => d.startsWith(m[2].slice(0, 3))) + 1;
    let n = (want - dow(base) + 7) % 7 || 7;
    if (m[1] && n < 7) n += 7;
    return addDays(base, n);
  }
  m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(st|nd|rd|th)?\b/) || t.match(/\b(\d{1,2})(st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  if (m) {
    const mon = MONTHS.indexOf(isNaN(m[1]) ? m[1] : m[3]) + 1;
    const day = Number(isNaN(m[1]) ? m[2] : m[1]);
    let y = Number(base.slice(0, 4));
    let d = `${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (d < addDays(base, -60)) { y += 1; d = `${y}${d.slice(4)}`; }
    return d;
  }
  m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    let y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : Number(base.slice(0, 4));
    let d = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    if (!m[3] && d < addDays(base, -60)) { y += 1; d = `${y}${d.slice(4)}`; }
    if (Number(m[1]) <= 12 && Number(m[2]) <= 31) return d;
  }
  return null;
}

function parseTime(s) {
  const m = String(s || '').toLowerCase().match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  let h = Number(m[1] || m[4]);
  const min = m[2] || m[5] || '00';
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return h < 24 ? `${String(h).padStart(2, '0')}:${min}` : null;
}

class Capture {
  constructor(store, meetings) { this.store = store; this.db = store.db; this.meetings = meetings; }

  // ---------------------------------------------------------- AI settings
  /**
   * provider: 'auto' (Claude if a key is saved, else Ollama if it is running),
   * 'ollama', 'openai' (another local server such as LM Studio or llama.cpp),
   * 'anthropic', or 'off' (built-in reader only).
   */
  aiConfig() {
    const r = this.db.get("SELECT value FROM settings WHERE key='ai'");
    const v = parseJson(r && r.value, {});
    const key = v.key || process.env.BOARDENDA_ANTHROPIC_KEY || '';
    const provider = ['auto', 'ollama', 'openai', 'anthropic', 'off'].includes(v.provider) ? v.provider : (v.enabled === false ? 'off' : 'auto');
    return {
      provider, key,
      model: v.model || DEFAULT_MODEL,
      localUrl: v.localUrl || (provider === 'openai' ? 'http://127.0.0.1:1234' : 'http://127.0.0.1:11434'),
      localModel: v.localModel || '',
    };
  }
  aiStatus() {
    const c = this.aiConfig();
    return { provider: c.provider, hasKey: !!c.key, keyHint: c.key ? `…${c.key.slice(-4)}` : '', model: c.model, localUrl: c.localUrl, localModel: c.localModel, enabled: c.provider !== 'off' };
  }
  setAi(patch = {}) {
    const cur = parseJson((this.db.get("SELECT value FROM settings WHERE key='ai'") || {}).value, {});
    const next = { ...cur };
    if (patch.key !== undefined) next.key = String(patch.key || '').trim();
    if (patch.model !== undefined) next.model = String(patch.model || DEFAULT_MODEL);
    if (patch.provider !== undefined) next.provider = patch.provider;
    if (patch.localUrl !== undefined) {
      const u = String(patch.localUrl || '').trim();
      if (u && !isLocalUrl(u)) throw new Error('For privacy, a local model server must be on this PC or your local network.');
      next.localUrl = u;
    }
    if (patch.localModel !== undefined) next.localModel = String(patch.localModel || '').trim();
    if (patch.enabled !== undefined) next.provider = patch.enabled ? (next.provider === 'off' ? 'auto' : next.provider) : 'off';
    this.db.run("INSERT INTO settings(key,value) VALUES('ai',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(next)]);
    return this.aiStatus();
  }

  // ------------------------------------------------------- local models
  async localFetch(cfg, path, body, timeoutMs) {
    const flavor = cfg.provider === 'openai' ? 'openai' : 'ollama';
    const base = (cfg.localUrl || (flavor === 'openai' ? 'http://127.0.0.1:1234' : 'http://127.0.0.1:11434')).replace(/\/+$/, '');
    if (!isLocalUrl(base)) throw new Error('For privacy, a local model server must be on this PC or your local network.');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
      if (!res.ok) throw new Error(`The model server answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(body ? 'The local model took too long to answer.' : `No model server answered at ${base}.`);
      if (/fetch failed|ECONNREFUSED/i.test(String(e.message || e) + String(e.cause || ''))) throw new Error(`No model server is running at ${base}. Start Ollama and try again.`);
      throw e;
    } finally { clearTimeout(t); }
  }

  /** Models installed on the local server, and which one Quick capture will use. */
  async localModels(cfg = this.aiConfig()) {
    const c = { ...cfg, provider: cfg.provider === 'openai' ? 'openai' : 'ollama' };
    const r = c.provider === 'openai' ? await this.localFetch(c, '/v1/models', null, 4000) : await this.localFetch(c, '/api/tags', null, 4000);
    const models = c.provider === 'openai' ? (r.data || []).map((m) => m.id) : (r.models || []).map((m) => m.name);
    const chat = models.filter((m) => !/embed|bge|nomic|minilm/i.test(m));
    const pick = (cfg.localModel && chat.find((m) => m === cfg.localModel || m.split(':')[0] === cfg.localModel.split(':')[0]))
      || chat.find((m) => /llama/i.test(m)) || chat.find((m) => /qwen|gemma|mistral|phi/i.test(m)) || chat[0] || null;
    return { models: chat, model: pick };
  }

  async aiTest() {
    const cfg = this.aiConfig();
    if (cfg.provider === 'off') throw new Error('AI is off. The built-in reader is used.');
    if (cfg.provider === 'anthropic' || (cfg.provider === 'auto' && cfg.key)) {
      if (!cfg.key) throw new Error('Paste an Anthropic API key first.');
      await this.readWithClaude({ text: 'Call with Test Co tomorrow 10am. Send the quote by Friday.' }, this.context());
      return { provider: 'anthropic', model: cfg.model };
    }
    const m = await this.localModels(cfg);
    if (!m.model) throw new Error(cfg.provider === 'openai' ? 'The local server has no models loaded.' : 'Ollama is running but has no models. Run: ollama pull llama3.2');
    return { provider: cfg.provider === 'openai' ? 'openai' : 'ollama', model: m.model, models: m.models };
  }

  async readWithLocal({ text, images = [] }, ctx, cfg) {
    const { model } = await this.localModels(cfg);
    if (!model) throw new Error('No local model is installed. Run: ollama pull llama3.2');
    const system = `${this.prompt(ctx)}\n\nReply with JSON only, shaped as {"records": [...]}, using exactly these fields for each record: kind, title, board, group, existingItem, customer, date, time, owner, due, fields (list of {column, value}), notes, meetingIndex, confidence, question.`;
    const user = `<notes>\n${text || '(see the attached pictures)'}\n</notes>`;
    const vision = /llava|vision|-vl|vl:|gemma3|minicpm-v|moondream|bakllava/i.test(model);
    let out;
    if (cfg.provider === 'openai') {
      const r = await this.localFetch(cfg, '/v1/chat/completions', {
        model, temperature: 0,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_schema', json_schema: { name: 'records', strict: true, schema: this.schema() } },
      }, 300000);
      out = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
    } else {
      const r = await this.localFetch(cfg, '/api/chat', {
        model, stream: false, format: this.schema(),
        options: { temperature: 0, num_ctx: 16384 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user, ...(vision && images.length ? { images: images.map((i) => i.data) } : {}) }],
      }, 300000);
      out = r.message && r.message.content;
    }
    const parsed = parseJson(out, null) || parseJson((String(out || '').match(/\{[\s\S]*\}/) || [])[0], null);
    if (!parsed || !Array.isArray(parsed.records)) throw new Error('The local model returned something that could not be read.');
    return { records: parsed.records, model };
  }

  // ------------------------------------------------------------- context
  /** What Boardenda already holds, so notes can be matched to it. */
  context() {
    const boards = this.db.all('SELECT b.id, b.name, b.description, b.item_noun, w.name AS ws FROM boards b LEFT JOIN workspaces w ON w.id=b.workspace_id WHERE b.archived=0 ORDER BY w.position, b.position');
    return {
      today: today(),
      weekday: DAYS[dow(today()) - 1],
      people: this.store.people().map((p) => ({ id: p.id, name: p.name, isMe: !!p.is_me })),
      teams: this.store.teams().map((t) => ({ id: t.id, name: t.name })),
      customers: [...new Set([...(this.customers ? this.customers.names() : []), ...this.meetings.customers().map((c) => c.name)])],
      boards: boards.map((b) => {
        const cols = this.db.all("SELECT * FROM columns WHERE board_id=? AND scope='item' ORDER BY position", [b.id]).map((c) => ({ ...c, settings: parseJson(c.settings, {}) }));
        return {
          id: b.id, name: b.name, workspace: b.ws, description: b.description || '', itemNoun: b.item_noun || 'item',
          groups: this.db.all('SELECT id, name FROM groups WHERE board_id=? AND archived=0 ORDER BY position', [b.id]),
          columns: cols.map((c) => ({
            id: c.id, title: c.title, type: c.type,
            options: (c.settings.labels || c.settings.options || []).map((l) => l.label).filter(Boolean),
          })),
          items: this.db.all('SELECT id, name FROM items WHERE board_id=? AND archived=0 AND parent_id IS NULL ORDER BY updated_at DESC LIMIT 60', [b.id]),
        };
      }),
    };
  }

  // ---------------------------------------------------------- resolving
  person(name, ctx) {
    const n = String(name || '').trim().toLowerCase().replace(/^@/, '');
    if (!n) return null;
    if (/^(me|i|myself|you)$/.test(n)) return (ctx.people.find((p) => p.isMe) || {}).id || null;
    const hit = ctx.people.find((p) => p.name.toLowerCase() === n) || ctx.people.find((p) => p.name.toLowerCase().split(' ')[0] === n.split(' ')[0]);
    return hit ? hit.id : null;
  }
  board(name, ctx) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    return ctx.boards.find((b) => b.id === name || b.name.toLowerCase() === n) || ctx.boards.find((b) => b.name.toLowerCase().includes(n) || n.includes(b.name.toLowerCase())) || null;
  }
  findItem(name, ctx, boardId) {
    const n = String(name || '').trim().toLowerCase();
    if (n.length < 3) return null;
    for (const b of ctx.boards) {
      if (boardId && b.id !== boardId) continue;
      const it = b.items.find((i) => i.name.toLowerCase() === n) || b.items.find((i) => i.name.toLowerCase().startsWith(n) || n.startsWith(i.name.toLowerCase()));
      if (it) return { id: it.id, name: it.name, boardId: b.id, boardName: b.name };
    }
    return null;
  }

  /** A column value from loose text: names for people, label names, dates in words, numbers. */
  valueFor(col, text, ctx) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    if (col.type === 'people') { const ids = t.split(/,|&| and /).map((x) => this.person(x, ctx)).filter(Boolean); return ids.length ? ids : null; }
    if (col.type === 'customer') {
      const list = this.store.customersList();
      const lc = t.toLowerCase();
      const hit = list.find((x) => x.name.toLowerCase() === lc) || list.find((x) => lc.includes(x.name.toLowerCase()) || x.name.toLowerCase().includes(lc));
      return hit ? [hit.id] : null;
    }
    if (col.type === 'team') { const hit = ctx.teams.find((x) => x.name.toLowerCase() === t.toLowerCase()); return hit ? [hit.id] : null; }
    if (col.type === 'date') return parseDate(t, ctx.today);
    if (col.type === 'timeline') { const parts = t.split(/\s+(?:to|-|–|until)\s+/); const a = parseDate(parts[0], ctx.today); const b = parseDate(parts[1] || parts[0], ctx.today); return a ? { start: a, end: b && b >= a ? b : a } : null; }
    if (col.type === 'dropdown') {
      const row = this.db.get('SELECT settings FROM columns WHERE id=?', [col.id]);
      const opts = (parseJson(row && row.settings, {}).options || []);
      const ids = t.split(',').map((x) => (opts.find((o) => o.label.toLowerCase() === x.trim().toLowerCase()) || {}).id).filter(Boolean);
      return ids.length ? ids : null;
    }
    const row = this.db.get('SELECT * FROM columns WHERE id=?', [col.id]);
    return C.coerce({ ...row, settings: parseJson(row.settings, {}) }, t);
  }

  /**
   * Turn raw proposals (from Claude or the built-in reader) into records the
   * UI can show: ids resolved, values typed, and a question when unsure.
   */
  resolve(raw, ctx, source) {
    const out = [];
    raw.forEach((r, i) => {
      const kind = KINDS.includes(r.kind) ? r.kind : 'item';
      const b = this.board(r.board, ctx);
      const g = b ? (b.groups.find((x) => x.name.toLowerCase() === String(r.group || '').toLowerCase()) || b.groups[0]) : null;
      const existing = r.existingItem ? this.findItem(r.existingItem, ctx) : null;
      const values = {};
      const unmatched = [];
      if (b) {
        for (const f of r.fields || []) {
          const col = b.columns.find((c) => c.title.toLowerCase() === String(f.column || '').toLowerCase());
          if (!col) { if (f.value) unmatched.push(`${f.column}: ${f.value}`); continue; }
          const v = this.valueFor(col, f.value, ctx);
          if (v != null && !(Array.isArray(v) && !v.length)) values[col.id] = v; else if (f.value) unmatched.push(`${f.column}: ${f.value}`);
        }
      }
      const owner = this.person(r.owner, ctx);
      let confidence = Math.max(0, Math.min(1, Number(r.confidence) || 0));
      const questions = [];
      if (r.question) questions.push(String(r.question));
      if (kind === 'item' && !b) questions.push(r.board ? `There is no board called “${r.board}”. Which board should this go on?` : 'Which board should this go on?');
      if (kind === 'update' && !existing) questions.push(r.existingItem ? `Which item is “${r.existingItem}”?` : 'Which item should this update go on?');
      if (r.owner && !owner) questions.push(`Who is “${r.owner}”? They are not in your people list.`);
      if (kind === 'action' && (r.meetingIndex == null || r.meetingIndex < 0) && !b) questions.push('Which board should this action go on?');
      if (questions.length) confidence = Math.min(confidence, 0.5);
      out.push({
        key: `r${i}`, kind, include: true, title: (String(r.title || '').trim().slice(0, 300) || 'Untitled').replace(/^[a-z]/, (c) => c.toUpperCase()),
        boardId: b ? b.id : null, groupId: g ? g.id : null,
        itemId: existing ? existing.id : null, itemName: existing ? `${existing.name} · ${existing.boardName}` : '',
        customer: String(r.customer || '').trim(), date: parseDate(r.date, ctx.today) || (kind === 'meeting' ? ctx.today : null),
        time: parseTime(r.time) || (r.time && /^\d{2}:\d{2}$/.test(r.time) ? r.time : null),
        owner, ownerText: r.owner || '', due: parseDate(r.due, ctx.today), values, unmatched,
        notes: String(r.notes || '').trim(), meetingRef: Number.isInteger(r.meetingIndex) && r.meetingIndex >= 0 ? `r${r.meetingIndex}` : null,
        confidence, question: questions.join(' '), needsMapping: confidence < 0.6 || questions.length > 0, source,
      });
    });
    // Actions point at meetings by index; drop references to non-meetings.
    for (const r of out) if (r.meetingRef && !out.some((m) => m.key === r.meetingRef && m.kind === 'meeting')) r.meetingRef = null;
    return out;
  }

  // ------------------------------------------------------ built-in reader
  /** Match a line of notes to a board by shared words with its name, groups, columns and items. */
  placeLocally(line, ctx) {
    const ws = new Set(words(line));
    const scored = ctx.boards.map((b) => {
      let s = 0;
      for (const w of words(`${b.name} ${b.itemNoun} ${b.description}`)) if (ws.has(w) || ws.has(w.replace(/s$/, ''))) s += 3;
      for (const g of b.groups) for (const w of words(g.name)) if (ws.has(w)) s += 1;
      for (const c of b.columns) for (const o of c.options) for (const w of words(o)) if (ws.has(w)) s += 1;
      for (const it of b.items) if (words(it.name).some((w) => ws.has(w))) s += 1;
      return { b, s };
    }).sort((x, y) => y.s - x.s);
    const best = scored[0];
    if (!best || best.s === 0) return { board: null, confidence: 0.3 };
    const margin = best.s - ((scored[1] || {}).s || 0);
    return { board: best.b.name, confidence: margin >= 2 && best.s >= 3 ? 0.8 : 0.5 };
  }

  readLocally(text, ctx) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
    const entries = [];
    let blank = false;
    for (const l of lines) { if (!l.trim()) { blank = true; continue; } entries.push({ t: l, afterBlank: blank }); blank = false; }
    const content = entries.map((e) => e.t);
    if (!content.length) return [];
    const raw = [];
    const first = content[0].replace(/^[#\s*-]+/, '');
    const meetingLike = /\b(call|meeting|met with|spoke with|sync|catch[- ]?up|standup|stand-up|demo|kickoff|kick-off|review with|1:1)\b/i.test(content.slice(0, 3).join(' '));
    let meetingIndex = -1;
    if (meetingLike) {
      const headerText = content.slice(0, 2).join(' ');
      const known = ctx.customers.find((c) => headerText.toLowerCase().includes(c.toLowerCase()));
      const withM = headerText.match(/\bwith\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/);
      const customer = known || (withM ? withM[1] : '');
      const about = customer ? this.findItem(customer, ctx) : null;
      raw.push({ kind: 'meeting', title: first.replace(/\s+(on\s+)?(\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d{4}-\d{2}-\d{2}|today|tomorrow|(mon|tue|wed|thu|fri)[a-z]*|\d{1,2}(:\d{2})?\s*(am|pm)|\d{1,2}:\d{2}|at)\b.*$/i, '').replace(/\s*[-–:|,]\s*$/, '').slice(0, 120), customer, existingItem: about ? about.name : '', date: parseDate(headerText, ctx.today) || '', time: parseTime(headerText) || '', notes: text, confidence: 0.85, question: '' });
      meetingIndex = 0;
    }
    const people = ctx.people.map((p) => p.name.split(' ')[0].toLowerCase());
    let inMeeting = meetingLike;
    for (let i = meetingLike ? 1 : 0; i < content.length; i++) {
      const line = content[i].trim();
      const body = line.replace(/^([-*•·▪◦]|\d+[.)]|\[ ?\]|\[x\]|- \[ \])\s*/i, '').trim();
      if (!body || /^(notes?|attendees?|agenda|summary|recap)\s*:?\s*$/i.test(body)) continue;
      const isBullet = body !== line;
      // A short heading after a blank line ends the meeting's notes ("Other tasks", "Bugs").
      if (inMeeting && entries[i].afterBlank && !isBullet && body.length < 50 && !/[.!?]$/.test(body) && !/^(actions?|action items|next steps?|todo|to do|follow[- ]?ups?)\b/i.test(body)) { inMeeting = false; continue; }
      const lower = body.toLowerCase();
      const ownerM = body.match(/^@?([A-Z][a-z]+)\s*(?:to|will|should|:|-)\s+(.+)$/) || body.match(/@([A-Za-z]+)/);
      const owner = ownerM && people.includes(ownerM[1].toLowerCase()) ? ownerM[1] : (/^(i|me|i'll|i will)\b/i.test(body) ? 'me' : '');
      const actionLike = !!owner || /^(todo|to do|action|ai|next steps?|follow[- ]?up|fu)\b[:\s-]*/i.test(body) || /^\[ ?\]|^- \[ \]/.test(line)
        || /\b(by|before|due)\s+(mon|tue|wed|thu|fri|sat|sun|tomorrow|today|next week|end of|eod|eow|\d)/i.test(body);
      const cleaned = body.replace(/^(todo|to do|action( item)?|ai|next steps?|follow[- ]?up|fu)\s*[:\-]\s*/i, '').replace(/^@?[A-Z][a-z]+\s*(to|will|should|:|-)\s+/, (m) => (owner && owner !== 'me' ? '' : m)).replace(/\s*\b(by|before|due)\s+[^,;.]+$/i, '').trim();
      const due = parseDate(body.match(/\b(by|before|due|on)\s+(.+)$/i)?.[2] || '', ctx.today) || parseDate(body, ctx.today) || '';
      if (inMeeting) {
        if (actionLike) raw.push({ kind: 'action', title: cleaned || body, owner, due, meetingIndex, confidence: owner ? 0.85 : 0.65, question: '' });
        continue; // other lines are meeting notes
      }
      if (!isBullet && content.length > 3 && body.length > 140) continue; // prose paragraph: not a record
      const known = this.findItem(body.split(/[:\-–]/)[0], ctx);
      if (known && /\b(update|status|progress|blocked|waiting|done|finished|moved)\b/i.test(lower)) {
        raw.push({ kind: 'update', title: body, existingItem: known.name, notes: body, confidence: 0.7, question: '' });
        continue;
      }
      const place = this.placeLocally(body, ctx);
      raw.push({ kind: 'item', title: cleaned || body, board: place.board || '', owner, due, fields: [], confidence: place.confidence, question: place.board && place.confidence < 0.6 ? `Best guess is ${place.board}. Is that the right board?` : '' });
    }
    return raw;
  }

  // --------------------------------------------------------------- Claude
  schema() {
    const str = { type: 'string' };
    return {
      type: 'object', additionalProperties: false, required: ['records'],
      properties: {
        records: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['kind', 'title', 'board', 'group', 'existingItem', 'customer', 'date', 'time', 'owner', 'due', 'fields', 'notes', 'meetingIndex', 'confidence', 'question'],
            properties: {
              kind: { type: 'string', enum: KINDS },
              title: str, board: str, group: str, existingItem: str, customer: str, date: str, time: str, owner: str, due: str, notes: str,
              fields: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['column', 'value'], properties: { column: str, value: str } } },
              meetingIndex: { type: 'integer' },
              confidence: { type: 'number' },
              question: str,
            },
          },
        },
      },
    };
  }

  prompt(ctx) {
    const boards = ctx.boards.map((b) => ({
      name: b.name, workspace: b.workspace, description: b.description, itemNoun: b.itemNoun, groups: b.groups.map((g) => g.name),
      columns: b.columns.filter((c) => !['formula', 'mirror', 'auto_number', 'creation_log', 'last_updated', 'button', 'files', 'doc', 'dependency', 'connect', 'vote', 'time_tracking'].includes(c.type))
        .map((c) => (c.options.length ? { title: c.title, type: c.type, options: c.options } : { title: c.title, type: c.type })),
      existingItems: b.items.map((i) => i.name),
    }));
    return `You turn rough work notes into records for Boardenda, a local project management app. The person dropped these notes in; your proposals are shown to them for review before anything is created.

Record kinds:
- "meeting": a customer call or meeting the notes describe or schedule. Put the date, time and customer in their fields and keep the notes (decisions, discussion) in "notes". If the call is about an existing item (a deal, account or project), name it in "existingItem".
- "action": a next step with an owner and due date, usually from a meeting. Set "meetingIndex" to the index of that meeting in your records list, or -1 if there is none; an action without a meeting also needs a "board".
- "item": a new task, deal, bug, request or project for a board. Pick the board and group where it fits, and fill "fields" with column values using the exact column titles and option names given below.
- "update": progress on an existing item. Name it exactly in "existingItem" and put the update text in "notes".

Rules:
- Use only board, group, column and option names from the context, written exactly. Use people's names from the people list; use "me" for the person writing the notes when they say I or me.
- Dates as YYYY-MM-DD (resolve words like "Friday" or "next week" against today), times as HH:MM in 24-hour time. Empty string when unknown; meetingIndex -1 when not used.
- One record per distinct thing. Don't turn background chatter into records, and don't duplicate an existing item: use an update instead.
- "confidence" is 0 to 1. When you are unsure where something goes or what it means, give your best guess, set confidence below 0.6, and write a short question for the person in "question". Otherwise leave "question" empty.

Today is ${ctx.weekday} ${ctx.today}.
People: ${JSON.stringify(ctx.people.map((p) => (p.isMe ? `${p.name} (me)` : p.name)))}
Teams: ${JSON.stringify(ctx.teams.map((t) => t.name))}
Known customers: ${JSON.stringify(ctx.customers)}
Boards: ${JSON.stringify(boards)}`;
  }

  async readWithClaude({ text, images = [] }, ctx) {
    const cfg = this.aiConfig();
    const Anthropic = require('@anthropic-ai/sdk');
    const Client = Anthropic.default || Anthropic;
    const client = new Client({ apiKey: cfg.key, maxRetries: 2, timeout: 120000, ...(process.env.BOARDENDA_ANTHROPIC_BASE_URL ? { baseURL: process.env.BOARDENDA_ANTHROPIC_BASE_URL } : {}) });
    const content = [
      ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
      { type: 'text', text: `<notes>\n${text || '(see the attached pictures)'}\n</notes>` },
    ];
    const response = await client.beta.messages.create({
      model: cfg.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: this.schema() } },
      system: [{ type: 'text', text: this.prompt(ctx) }],
      messages: [{ role: 'user', content }],
    });
    if (response.stop_reason === 'refusal') throw new Error('Claude declined to read these notes.');
    if (response.stop_reason === 'max_tokens') throw new Error('The notes were too long to read in one go. Try a shorter piece.');
    const block = response.content.find((b) => b.type === 'text');
    const parsed = parseJson(block && block.text, null);
    if (!parsed || !Array.isArray(parsed.records)) throw new Error('Claude returned something that could not be read.');
    return parsed.records;
  }

  /**
   * Read notes into proposed records. files: [{ name, bytes }] (Word, PDF,
   * text, pictures). Returns { mode, records, text, notes }.
   */
  async read({ text = '', files = [] } = {}, extract) {
    const ctx = this.context();
    const cfg = this.aiConfig();
    const notes = [];
    // Which reader: Claude, a local model (Ollama or similar), or the built-in one.
    let engine = 'basic';
    if (cfg.provider === 'anthropic' || (cfg.provider === 'auto' && cfg.key)) engine = cfg.key ? 'claude' : 'basic';
    else if (cfg.provider === 'ollama' || cfg.provider === 'openai') engine = 'local';
    else if (cfg.provider === 'auto') {
      try { if ((await this.localModels({ ...cfg, provider: 'ollama' })).model) engine = 'local'; } catch (_) { /* Ollama not running */ }
    }
    const localCfg = engine === 'local' ? { ...cfg, provider: cfg.provider === 'openai' ? 'openai' : 'ollama' } : null;
    let all = String(text || '');
    const images = [];
    for (const f of files) {
      const isImg = /\.(png|jpe?g|gif|webp)$/i.test(f.name);
      if (isImg && f.bytes.length < 4.5e6 && engine !== 'basic') {
        const ext = f.name.toLowerCase().match(/\.(\w+)$/)[1];
        images.push({ mediaType: `image/${ext === 'jpg' ? 'jpeg' : ext}`, data: Buffer.from(f.bytes).toString('base64') });
        if (engine === 'claude') continue; // Claude reads pictures directly; local models also get the OCR text
      }
      const t = await extract(f.name, f.bytes);
      if (t) all += `${all ? '\n\n' : ''}${t}`;
      notes.push(`Read ${f.name}${/\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(f.name) ? ' with OCR' : ''}.`);
    }
    if (!all.trim() && !images.length) throw new Error('Paste some notes or drop a file first.');
    let raw;
    let mode = 'basic';
    let model = null;
    if (engine === 'claude') {
      try { raw = await this.readWithClaude({ text: all, images }, ctx); mode = 'claude'; model = cfg.model; } catch (e) {
        notes.push(`Claude could not be reached (${e.message || e}), so the built-in reader was used.`);
        if (images.length && !all.trim()) throw new Error('Claude is needed to read pictures without OCR, and it could not be reached.');
      }
    } else if (engine === 'local') {
      try { const r = await this.readWithLocal({ text: all, images }, ctx, localCfg); raw = r.records; mode = 'local'; model = r.model; } catch (e) {
        notes.push(`The local model could not read these notes (${e.message || e}), so the built-in reader was used.`);
      }
    }
    if (!raw) raw = this.readLocally(all, ctx);
    return { mode, model, records: this.resolve(raw, ctx, mode), text: all, notes };
  }

  // ---------------------------------------------------------------- apply
  /** Create the reviewed records. Meetings first, so actions can attach to them. */
  apply({ records = [], text = '' } = {}) {
    const keep = records.filter((r) => r.include !== false);
    const made = { meeting: 0, action: 0, item: 0, update: 0, first: null };
    const ids = {};
    return this.db.tx(() => {
      for (const r of keep.filter((x) => x.kind === 'meeting')) {
        const id = this.meetings.create({
          kind: /\b(meeting|sync|standup|review|workshop)\b/i.test(r.title) && !/call/i.test(r.title) ? 'meeting' : 'call',
          title: r.title, customer: r.customer, date: r.date || today(), time: r.time || '09:00', itemId: r.itemId || null,
          attendees: [this.store.me().id], notes: toHtml(r.notes || text), status: (r.date || today()) <= today() ? 'held' : 'planned',
        });
        ids[r.key] = id; made.meeting++; made.first = made.first || { kind: 'meeting', id };
      }
      for (const r of keep.filter((x) => x.kind !== 'meeting')) {
        if (r.kind === 'update') {
          if (!r.itemId) throw new Error(`Choose the item for “${r.title}”`);
          this.store.postUpdate(r.itemId, r.notes || r.title); made.update++; continue;
        }
        if (r.kind === 'action' && r.meetingRef && ids[r.meetingRef]) {
          this.meetings.addAction(ids[r.meetingRef], { text: r.title, owner: r.owner, due: r.due, boardId: r.boardId || undefined, groupId: r.groupId || undefined });
          made.action++; continue;
        }
        if (!r.boardId) throw new Error(`Choose a board for “${r.title}”`);
        const s = this.meetings.slots(r.boardId);
        const values = { ...(r.values || {}) };
        if (r.owner && s.people && !values[s.people.id]) values[s.people.id] = [r.owner];
        if (r.due && s.date && !values[s.date.id]) values[s.date.id] = s.date.type === 'timeline' ? { start: r.due, end: r.due } : r.due;
        const id = this.store.addItem(r.boardId, { groupId: r.groupId || undefined, name: r.title, values, source: 'capture' });
        if (r.notes && r.notes !== r.title) this.store.postUpdate(id, r.notes);
        made[r.kind === 'action' ? 'action' : 'item']++;
        made.first = made.first || { kind: 'item', id, boardId: r.boardId };
      }
      return made;
    });
  }
}

module.exports = { Capture, parseDate, parseTime, DEFAULT_MODEL };
