'use strict';
// The daily assistant. Drop emails and documents (or paste an email) and each
// becomes a case: the text is read on this PC, translated if needed, matched
// to customers, boards and documents, and the AI chosen in Settings › AI
// writes a summary, an action plan, draft replies, questions it needs answered,
// and where the work belongs on your boards (or a better way to organise it).
// Without a model, a simpler built-in reader still files and outlines the case.

const fs = require('fs');
const path = require('path');
const { uid, now, today, addDays, parseJson } = require('./util');
const mail = require('./mail');
const archives = require('./archives');

const CATEGORIES = ['customer issue', 'request', 'approval', 'escalation', 'information', 'meeting', 'finance', 'order or logistics', 'technical', 'internal', 'other'];
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
const STATUSES = ['open', 'waiting', 'done'];
const READABLE = /\.(msg|eml|pdf|docx|xlsx|xlsm|csv|tsv|txt|md|html?|mht|mhtml|one|rtf|xml|json|log|png|jpe?g|bmp|gif|webp|tiff?)$/i;
const MAX_TEXT = 60000;

const DEFAULT_PROFILE = 'I run North America retail for Ingenico (payment terminals and services for retailers). I work with retail customers, partners and resellers, and internal teams such as sales, product, support, operations, finance and legal.';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    language: { type: 'string' },
    translation: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    priority: { type: 'string', enum: PRIORITIES },
    due: { type: 'string' },
    sender_type: { type: 'string', enum: ['internal', 'customer', 'partner', 'vendor', 'unknown'] },
    customer: { type: 'string' },
    key_points: { type: 'array', items: { type: 'string' } },
    plan: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { step: { type: 'string' }, owner: { type: 'string', enum: ['me', 'internal', 'third party'] }, who: { type: 'string' }, due: { type: 'string' } }, required: ['step', 'owner', 'who', 'due'] } },
    replies: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { to: { type: 'string' }, audience: { type: 'string', enum: ['internal', 'external'] }, purpose: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'audience', 'purpose', 'subject', 'body'] } },
    questions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { question: { type: 'string' }, why: { type: 'string' } }, required: ['question', 'why'] } },
    risks: { type: 'array', items: { type: 'string' } },
    placement: { type: 'object', additionalProperties: false, properties: { workspace: { type: 'string' }, board: { type: 'string' }, group: { type: 'string' }, new_board: { type: 'boolean' }, reason: { type: 'string' } }, required: ['workspace', 'board', 'group', 'new_board', 'reason'] },
    organize: { type: 'object', additionalProperties: false, properties: { advice: { type: 'string' }, board_name: { type: 'string' }, workspace: { type: 'string' }, groups: { type: 'array', items: { type: 'string' } }, columns: { type: 'array', items: { type: 'string' } } }, required: ['advice', 'board_name', 'workspace', 'groups', 'columns'] },
    sources_used: { type: 'array', items: { type: 'integer' } },
  },
  required: ['title', 'summary', 'language', 'translation', 'category', 'priority', 'due', 'sender_type', 'customer', 'key_points', 'plan', 'replies', 'questions', 'risks', 'placement', 'organize', 'sources_used'],
};

const COLUMN_TYPES = { owner: 'people', status: 'status', priority: 'priority', due: 'date', 'due date': 'date', date: 'date', timeline: 'timeline', customer: 'customer', notes: 'long_text', budget: 'numbers', amount: 'numbers', value: 'numbers', region: 'dropdown', store: 'text', link: 'link', files: 'files' };
const colType = (title) => {
  const t = String(title || '').toLowerCase();
  for (const [k, v] of Object.entries(COLUMN_TYPES)) if (t === k || t.includes(k)) return v;
  return 'text';
};

function isoDate(s) {
  const m = String(s || '').match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : '';
}

class Assistant {
  constructor({ db, store, capture, knowledge, customers, meetings, dataDir, readFile }) {
    this.db = db; this.store = store; this.capture = capture; this.knowledge = knowledge; this.customers = customers; this.meetings = meetings;
    this.dir = dataDir ? path.join(dataDir, 'assistant') : null;
    this.readFile = readFile; // (name, bytes) => text, for documents
    this.running = new Map();
    this.busy = 0;
    this.waiting = [];
  }

  /** Run at most two plans at a time, so dropping a whole mailbox does not swamp the AI. */
  async slot(fn) {
    if (this.busy >= 2) await new Promise((res) => this.waiting.push(res));
    this.busy += 1;
    try { return await fn(); } finally { this.busy -= 1; const next = this.waiting.shift(); if (next) next(); }
  }

  // ------------------------------------------------------------- settings
  config() {
    const r = this.db.get("SELECT value FROM settings WHERE key='assistant'");
    return { profile: DEFAULT_PROFILE, signature: '', tone: 'professional, warm and concise', watchFolder: '', allowCloudFiles: false, ...parseJson(r && r.value, {}) };
  }
  setConfig(patch = {}) {
    const next = { ...this.config(), ...patch };
    if (patch.profile !== undefined) next.profile = String(patch.profile || '').slice(0, 3000);
    if (patch.signature !== undefined) next.signature = String(patch.signature || '').slice(0, 1000);
    this.db.run("INSERT INTO settings(key,value) VALUES('assistant',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(next)]);
    return next;
  }

  // ------------------------------------------------------------- reading
  /** Read one file (email or document) into {name, kind, text, email?, attachments}. */
  async read(name, bytes, depth = 0) {
    const ext = path.extname(name).toLowerCase();
    if (ext === '.msg' || ext === '.eml') {
      const e = ext === '.msg' ? mail.parseMsg(bytes) : mail.parseEml(bytes);
      const atts = [];
      for (const a of e.attachments.slice(0, 12)) {
        if (!READABLE.test(a.name) || depth > 1 || a.bytes.length > 25e6) { atts.push({ name: a.name, size: a.bytes.length, text: '', skipped: true }); continue; }
        try { const r = await this.read(a.name, a.bytes, depth + 1); atts.push({ name: a.name, size: a.bytes.length, text: r.text.slice(0, 20000), email: r.email || null }); } catch (err) { atts.push({ name: a.name, size: a.bytes.length, text: '', error: String(err.message || err).slice(0, 160) }); }
      }
      return { name, kind: 'email', email: { subject: e.subject, from: e.from, to: e.to, cc: e.cc, date: e.date }, text: e.text, attachments: atts, raw: e.attachments };
    }
    if (ext === '.json') return { name, kind: 'document', text: Buffer.from(bytes).toString('utf8'), attachments: [] };
    if (ext === '.mht' || ext === '.mhtml') { const r = archives.mhtText(bytes); return { name, kind: 'document', title: r.title, text: r.title ? `${r.title}\n\n${r.text}` : r.text, attachments: [] }; }
    if (ext === '.one') return { name, kind: 'document', text: archives.oneText(bytes), attachments: [] };
    if (ext === '.pst' || ext === '.onepkg') throw new Error('Drop Outlook .pst files and OneNote notebooks (.onepkg) in Chat: each email or section is read on its own.');
    const text = await this.readFile(name, bytes);
    return { name, kind: 'document', text: String(text || ''), attachments: [] };
  }

  /** Text the model reads for a case: email headers, body, then each document and attachment. */
  caseText(src) {
    const parts = [];
    for (const f of src.files || []) {
      if (f.email) parts.push(`EMAIL "${f.name}"\nFrom: ${f.email.from}\nTo: ${f.email.to}${f.email.cc ? `\nCc: ${f.email.cc}` : ''}\nDate: ${f.email.date}\nSubject: ${f.email.subject}\n\n${f.text}`);
      else parts.push(`DOCUMENT "${f.name}"\n${f.text}`);
      for (const a of f.attachments || []) if (a.text) parts.push(`ATTACHMENT "${a.name}" (of ${f.name})\n${a.text}`);
    }
    if (src.pasted && src.chat) parts.push(`CHAT CONVERSATION (pasted, e.g. from Teams)\n${src.pasted}`);
    else if (src.pasted) parts.push(src.pastedEmail ? `EMAIL (pasted)\nFrom: ${src.pastedEmail.from}\nTo: ${src.pastedEmail.to}\nDate: ${src.pastedEmail.date}\nSubject: ${src.pastedEmail.subject}\n\n${src.pasted}` : `PASTED TEXT\n${src.pasted}`);
    return parts.join('\n\n---\n\n').slice(0, MAX_TEXT);
  }

  // ------------------------------------------------------------- cases
  row(id) {
    const r = this.db.get('SELECT * FROM assistant_cases WHERE id=?', [id]);
    if (!r) throw new Error('That case no longer exists');
    return r;
  }
  shape(r, full = false) {
    const a = parseJson(r.analysis, null);
    const src = parseJson(r.source, {});
    const out = {
      id: r.id, title: r.title, kind: r.kind, status: r.status, state: r.state, error: r.error || '', priority: r.priority, due: r.due || null,
      sender: r.sender || '', customerId: r.customer_id || null, createdAt: r.created_at, updatedAt: r.updated_at,
      summary: a ? a.summary : '', category: a ? a.category : '', mode: a ? a.mode : null,
      openSteps: a ? (a.plan || []).filter((s) => !s.done).length : 0, waiting: a ? (a.plan || []).some((s) => !s.done && s.owner !== 'me') : false,
      questions: a ? (a.questions || []).filter((q) => !q.answer).length : 0, files: (src.files || []).map((f) => f.name),
    };
    if (full) {
      Object.assign(out, { analysis: a, source: { ...src, files: (src.files || []).map((f) => ({ name: f.name, kind: f.kind, email: f.email || null, attachments: (f.attachments || []).map((x) => ({ name: x.name, size: x.size, skipped: !!x.skipped, error: x.error || '' })), stored: f.stored || null, chars: (f.text || '').length })) },
        chat: parseJson(r.chat, []), text: (r.text || '').slice(0, 20000) });
      if (r.customer_id) { try { const c = this.customers.get(r.customer_id); out.customer = { id: c.id, name: c.name }; } catch (_) { out.customer = null; } }
    }
    return out;
  }
  list({ status, q } = {}) {
    const where = [];
    const args = [];
    if (status && status !== 'all') { where.push('status=?'); args.push(status); }
    if (q) { const like = `%${String(q).toLowerCase()}%`; where.push('(LOWER(title) LIKE ? OR LOWER(sender) LIKE ? OR LOWER(text) LIKE ?)'); args.push(like, like, like); }
    const pri = "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";
    return this.db.all(`SELECT * FROM assistant_cases ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE status WHEN 'done' THEN 1 ELSE 0 END, ${pri}, created_at DESC LIMIT 500`, args).map((r) => this.shape(r));
  }
  get(id) { return this.shape(this.row(id), true); }

  /** New case from dropped files and/or pasted text. Reading and the plan run in the background. */
  async intake({ files = [], text = '', origin = 'drop', title = '' } = {}) {
    const pasted = String(text || '').trim();
    if (!files.length && !pasted) throw new Error('Drop an email or a file, or paste some text.');
    const id = uid('ac');
    const ts = now();
    const firstName = title || (files[0] ? files[0].name : 'Pasted text');
    this.db.run('INSERT INTO assistant_cases(id,title,kind,status,state,priority,source,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [id, firstName.replace(/\.[a-z0-9]+$/i, ''), files.some((f) => /\.(msg|eml)$/i.test(f.name)) ? 'email' : pasted && !files.length ? 'text' : 'document', 'open', 'reading', 'normal', JSON.stringify({ origin }), '', ts, ts]);
    const job = (async () => {
      const src = { origin, files: [] };
      for (const f of files.slice(0, 20)) {
        const bytes = Buffer.from(f.bytes);
        let stored = null;
        if (this.dir) {
          try { const d = path.join(this.dir, id); fs.mkdirSync(d, { recursive: true }); stored = path.join(d, path.basename(f.name).replace(/[\\/:*?"<>|]/g, '_')); fs.writeFileSync(stored, bytes); } catch (_) { stored = null; }
        }
        try {
          const r = await this.read(f.name, bytes);
          src.files.push({ name: f.name, kind: r.kind, email: r.email || null, text: r.text.slice(0, MAX_TEXT), attachments: r.attachments, stored });
        } catch (e) {
          src.files.push({ name: f.name, kind: 'document', text: '', error: String(e.message || e), attachments: [], stored });
        }
      }
      if (pasted) { src.pasted = pasted.slice(0, MAX_TEXT); src.pastedEmail = mail.parsePasted(pasted); if (!src.pastedEmail && isChat(pasted)) src.chat = true; }
      const email = (src.files.find((f) => f.email) || {}).email || src.pastedEmail || null;
      const body = this.caseText(src);
      if (!body.trim()) throw new Error(src.files.map((f) => f.error).filter(Boolean)[0] || 'No text could be read from this.');
      this.db.run('UPDATE assistant_cases SET source=?, text=?, sender=?, title=?, state=?, updated_at=? WHERE id=?',
        [JSON.stringify(src), body, email ? email.from : '', title || (email && email.subject ? email.subject : src.chat ? 'Chat conversation' : firstName.replace(/\.[a-z0-9]+$/i, '')), 'thinking', now(), id]);
      if (src.chat) this.db.run("UPDATE assistant_cases SET kind='chat' WHERE id=?", [id]);
      await this.slot(() => this.analyze(id));
    })().catch((e) => { this.db.run("UPDATE assistant_cases SET state='error', error=?, updated_at=? WHERE id=?", [String(e.message || e).slice(0, 400), now(), id]); })
      .finally(() => this.running.delete(id));
    this.running.set(id, job);
    return id;
  }
  /** Wait for a case's background work (used by tests and the dev server). */
  async settle(id) { const j = this.running.get(id); if (j) await j; return this.get(id); }

  // ------------------------------------------------------------- context
  /** Boards, groups and customers the model can file work into. */
  structure() {
    const boards = this.db.all('SELECT b.id, b.name, b.folder, b.description, w.id AS ws_id, w.name AS ws FROM boards b LEFT JOIN workspaces w ON w.id=b.workspace_id WHERE b.archived=0 ORDER BY w.position, b.position');
    return {
      workspaces: this.db.all('SELECT id, name FROM workspaces ORDER BY position'),
      boards: boards.map((b) => ({ id: b.id, name: b.name, workspace: b.ws || '', workspaceId: b.ws_id, folder: b.folder || '', description: b.description || '',
        groups: this.db.all('SELECT id, name FROM groups WHERE board_id=? AND archived=0 ORDER BY position', [b.id]),
        items: this.db.get('SELECT COUNT(*) AS n FROM items WHERE board_id=? AND archived=0 AND parent_id IS NULL', [b.id]).n,
        columns: this.db.all("SELECT title, type FROM columns WHERE board_id=? AND scope='item' ORDER BY position", [b.id]).map((c) => `${c.title} (${c.type})`) })),
    };
  }

  /** Related records and documents for a case, numbered for citations. */
  async related(c, text) {
    const head = `${c.title} ${c.sender} ${text.slice(0, 1500)}`;
    let files = [];
    let biz = [];
    try { files = this.knowledge ? await this.knowledge.searchFiles(head, 6) : []; } catch (_) { files = []; }
    try { biz = this.knowledge ? this.knowledge.searchBusiness(head).slice(0, 10) : []; } catch (_) { biz = []; }
    // Customers matched by the sender's email domain or name.
    const who = mail.address(c.sender);
    const domain = who.email.split('@')[1] || '';
    const custHits = [];
    if (domain && !/gmail|outlook|hotmail|yahoo|icloud|live\.com|aol/i.test(domain)) {
      for (const cu of this.customers.list({ q: domain.split('.').slice(-2, -1)[0] })) custHits.push(cu);
      for (const cu of this.db.all('SELECT DISTINCT customer_id AS id FROM customer_contacts WHERE LOWER(email) LIKE ?', [`%@${domain}`])) { const x = this.customers.list({}).find((y) => y.id === cu.id); if (x) custHits.push(x); }
    }
    return { files, biz, customers: [...new Map(custHits.map((x) => [x.id, x])).values()].slice(0, 3) };
  }

  // ------------------------------------------------------------- analysis
  async analyze(id) {
    const r = this.row(id);
    const c = this.shape(r);
    const cfg = this.config();
    const prev = parseJson(r.analysis, null);
    const answers = prev ? (prev.questions || []).filter((q) => q.answer) : [];
    this.db.run("UPDATE assistant_cases SET state='thinking', error='', updated_at=? WHERE id=?", [now(), id]);
    const rel = await this.related(c, r.text || '');
    const struct = this.structure();
    const { engine } = await this.capture.pickEngine();
    const cloud = engine === 'claude' || engine === 'chatgpt';
    const fileSources = cloud && !cfg.allowCloudFiles ? [] : rel.files;
    const sources = [
      ...rel.customers.map((x) => ({ kind: 'customer', id: x.id, name: x.name, text: `Customer ${x.name}${x.account_no ? ` (account ${x.account_no})` : ''}${x.industry ? `, ${x.industry}` : ''}${x.email ? `, ${x.email}` : ''}${x.phone ? `, ${x.phone}` : ''}` })),
      ...rel.biz, ...fileSources,
    ].map((s, i) => ({ ...s, n: i + 1 }));
    let result = null;
    let mode = 'basic';
    let model = null;
    const notes = [];
    if (cloud && !cfg.allowCloudFiles && rel.files.length) notes.push(`${rel.files.length} related passages from your PC files were not sent to ${engine === 'chatgpt' ? 'ChatGPT' : 'Claude'}. Allow it in the assistant settings, or use a local model.`);
    if (engine !== 'basic') {
      const system = this.systemPrompt(cfg);
      const user = [
        `Today is ${today()}.`,
        `<my_boards>\n${struct.boards.map((b) => `- Workspace "${b.workspace}"${b.folder ? `, folder "${b.folder}"` : ''}, board "${b.name}" (${b.items} items${b.description ? `; ${b.description.slice(0, 120)}` : ''}). Groups: ${b.groups.map((g) => g.name).join(', ')}. Columns: ${b.columns.join(', ')}`).join('\n') || 'No boards yet.'}\n</my_boards>`,
        `<people>\n${this.store.people().map((p) => `${p.name}${p.is_me ? ' (me)' : ''}${p.email ? ` <${p.email}>` : ''}${p.team ? `, ${p.team}` : ''}`).join('\n')}\n</people>`,
        sources.length ? `<related>\n${sources.map((s) => `<source n="${s.n}" kind="${s.kind}"${s.path ? ` file="${s.path}"` : ''}>\n${String(s.text).slice(0, 1800)}\n</source>`).join('\n')}\n</related>` : '<related>Nothing related was found on your boards or in your indexed folders.</related>',
        answers.length ? `<my_answers_to_your_questions>\n${answers.map((q) => `Q: ${q.question}\nA: ${q.answer}`).join('\n\n')}\n</my_answers_to_your_questions>` : '',
        `<case>\n${(r.text || '').slice(0, engine === 'local' ? 14000 : 40000)}\n</case>`,
      ].filter(Boolean).join('\n\n');
      try {
        const out = await this.capture.askJson({ system, text: user, schema: SCHEMA });
        if (out && out.data && out.data.summary) { result = out.data; mode = out.mode; model = out.model; }
        else if (out) notes.push('The model did not return a usable plan, so the built-in reader was used.');
      } catch (e) { notes.push(`The model could not read this (${e.message || e}), so the built-in reader was used.`); }
    } else notes.push(this.capture.aiConfig().provider === 'off' ? 'AI is off in Settings › AI, so the built-in reader made this outline.' : 'No AI model is running (start Ollama for a full plan and draft replies), so the built-in reader made this outline.');
    if (!result) result = this.basic(r, c, struct, rel);
    const a = this.normalize(result, { struct, sources, answers, prev, mode, model, notes });
    const cust = this.matchCustomer(a.customer, rel);
    this.db.run('UPDATE assistant_cases SET analysis=?, title=?, priority=?, due=?, customer_id=?, state=?, updated_at=? WHERE id=?',
      [JSON.stringify(a), (a.title || r.title).slice(0, 200), a.priority, a.due || null, cust ? cust.id : r.customer_id || null, 'ready', now(), id]);
    return this.get(id);
  }

  systemPrompt(cfg) {
    return `You are a chief of staff and executive assistant built into Boardenda, a work management app on the user's PC.
About the user: ${cfg.profile || DEFAULT_PROFILE}
For every email or document you get:
- Write a short title and a 2-4 sentence summary of what it is and what is being asked.
- If it is not in English, set language and give a faithful English translation in "translation"; otherwise language "English" and translation "".
- Decide category, priority (urgent = same day; high = this week), and a due date (YYYY-MM-DD) if one is stated or implied, else "".
- Make an action plan: concrete, ordered steps to respond or resolve. Owner is "me" (the user), "internal" (a colleague or team) or "third party" (customer, partner, vendor); put the person or team in "who" when known; give due dates where sensible.
- Draft every reply needed: to the sender, and any internal or third-party messages needed to resolve it (e.g. ask support for a status, loop in finance). Write them ready to send, in a ${cfg.tone || 'professional'} tone, in the language the recipient used. Sign as the user${cfg.signature ? ` with this signature:\n${cfg.signature}` : ''}.
- If you need more data, a document, a contact name or a decision from the user, ask in "questions" (max 5) and say why. Never invent facts, numbers, names, emails or commitments; use placeholders like [order number] instead.
- Placement: choose the existing workspace, board and group where the follow-up tasks belong (use exact names from <my_boards>). If none fits, set new_board true and name a sensible new board.
- Organize: if the boards could be structured better for this kind of work (swim lanes/groups, a board per customer or program, columns to track), give short practical advice and, if useful, a proposed board with groups (swim lanes) and columns. Otherwise leave advice "" and the lists empty.
- List risks (escalation, SLA, revenue, compliance, reputation) when relevant.
- customer: the customer or partner company this is about, if any, else "".
- If the input is a chat conversation (for example copied from Microsoft Teams), treat it as context for planning: summarise the thread, list decisions made, open questions and who owns what, then plan the next steps and any messages to send.
- sources_used: numbers of the related sources you relied on.`;
  }

  /** Built-in reader: a usable outline without a model. */
  basic(r, c, struct, rel) {
    const text = r.text || '';
    const src = parseJson(r.source, {});
    const ef = (src.files || []).find((f) => f.email);
    const email = ef ? { email: ef.email, text: ef.text } : src.pastedEmail ? { email: src.pastedEmail, text: src.pasted.replace(/^[\s\S]*?\n\s*\n/, '') } : null;
    const body = email ? email.text : (src.pasted || text);
    const sentences = body.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter((s) => s.length > 20 && !/^(from|to|sent|subject|cc):/i.test(s));
    const asks = sentences.filter((s) => /\?|please|could you|can you|need|required|request|asap|urgent|by (mon|tue|wed|thu|fri|sat|sun|end of|eod|cob|\d)/i.test(s)).slice(0, 6);
    const urgent = /urgent|asap|immediately|escalat|outage|down\b|critical|today/i.test(body);
    const dueM = body.match(/\b(?:by|before|due|no later than)\s+([A-Z][a-z]+ \d{1,2}(?:, \d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})/);
    let due = '';
    if (dueM) { const d = new Date(dueM[1].match(/\d{4}/) ? dueM[1] : `${dueM[1]} ${new Date().getFullYear()}`); if (!Number.isNaN(d.getTime())) due = today(d); }
    const sender = mail.address(c.sender || (email && email.email.from) || '');
    if (src.chat) {
      const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const qs = lines.filter((l) => /\?$/.test(l)).slice(0, 5);
      const acts = lines.filter((l) => !/\?$/.test(l) && /\b(I'll|I will|will send|by (mon|tue|wed|thu|fri|eod|end of)|need to|action|owner|owns)\b/i.test(l)).slice(0, 6);
      const b0 = struct.boards[0];
      return { title: 'Chat conversation', summary: `A chat of ${lines.length} lines. ${acts.length ? `Commitments mentioned: ${acts.slice(0, 2).join(' ')}` : ''}`.trim(), language: '', translation: '', category: 'internal', priority: 'normal', due: '', sender_type: 'internal', customer: rel.customers[0] ? rel.customers[0].name : '',
        key_points: [...acts, ...qs].slice(0, 8), plan: [...qs.map((x) => ({ step: `Get an answer: ${x.slice(0, 160)}`, owner: 'me', who: '', due: addDays(today(), 2) })), ...acts.map((x) => ({ step: `Follow up: ${x.slice(0, 160)}`, owner: 'internal', who: '', due: addDays(today(), 3) }))].slice(0, 10),
        replies: [], questions: [], risks: [], placement: b0 ? { workspace: b0.workspace, board: b0.name, group: (b0.groups[0] || {}).name || '', new_board: false, reason: 'Your first board; change it if another fits better.' } : { workspace: '', board: 'Action items', group: 'To do', new_board: true, reason: 'You have no boards yet.' },
        organize: { advice: '', board_name: '', workspace: '', groups: [], columns: [] }, sources_used: [] };
    }
    const words = new Set((`${c.title} ${body.slice(0, 2000)}`).toLowerCase().match(/[a-z0-9]{4,}/g) || []);
    const scored = struct.boards.map((b) => ({ b, s: (b.name.toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((w) => words.has(w)).length + (rel.biz.filter((x) => x.board === b.name).length) })).sort((a, b2) => b2.s - a.s);
    const best = scored[0] && scored[0].s > 0 ? scored[0].b : struct.boards[0];
    return {
      title: (email && email.email.subject) || c.title,
      summary: sentences.slice(0, 3).join(' ').slice(0, 600) || body.slice(0, 400),
      language: '', translation: '', category: email ? 'request' : 'information', priority: urgent ? 'urgent' : asks.length ? 'high' : 'normal', due,
      sender_type: 'unknown', customer: rel.customers[0] ? rel.customers[0].name : '',
      key_points: asks.length ? asks : sentences.slice(0, 4),
      plan: [
        { step: 'Read the full message and confirm what is being asked', owner: 'me', who: '', due: today() },
        ...asks.slice(0, 4).map((s) => ({ step: `Answer: ${s.slice(0, 160)}`, owner: 'me', who: '', due: due || addDays(today(), 2) })),
        ...(email ? [{ step: `Reply to ${sender.name || sender.email || 'the sender'}`, owner: 'me', who: sender.name || '', due: due || addDays(today(), 1) }] : []),
      ],
      replies: email ? [{ to: email.email.from, audience: 'external', purpose: 'Acknowledge and set expectations', subject: `RE: ${email.email.subject || ''}`.trim(), body: `Hi ${(sender.name || '').split(' ')[0] || 'there'},\n\nThank you for your message. I'm looking into this and will come back to you${due ? ` by ${due}` : ' shortly'}.\n\nBest regards,` }] : [],
      questions: [], risks: urgent ? ['Marked urgent: reply today.'] : [],
      placement: best ? { workspace: best.workspace, board: best.name, group: (best.groups[0] || {}).name || '', new_board: false, reason: scored[0] && scored[0].s > 0 ? 'Matched words in the board name or related items.' : 'Your first board; change it if another fits better.' } : { workspace: '', board: 'Action items', group: 'To do', new_board: true, reason: 'You have no boards yet.' },
      organize: { advice: '', board_name: '', workspace: '', groups: [], columns: [] },
      sources_used: [],
    };
  }

  normalize(x, { struct, sources, answers, prev, mode, model, notes }) {
    const str = (v, n = 4000) => String(v == null ? '' : v).slice(0, n);
    const arr = (v) => (Array.isArray(v) ? v : []);
    const prevDone = new Set(prev ? arr(prev.plan).filter((s) => s.done).map((s) => s.step) : []);
    const prevSent = new Set(prev ? arr(prev.replies).filter((s) => s.sent).map((s) => s.subject + s.to) : []);
    const answerFor = (q) => { const m = answers.find((a) => a.question.toLowerCase() === String(q).toLowerCase()); return m ? m.answer : ''; };
    // Resolve placement to real ids.
    const p = x.placement || {};
    const board = struct.boards.find((b) => b.name.toLowerCase() === str(p.board).toLowerCase()) || struct.boards.find((b) => str(p.board) && b.name.toLowerCase().includes(str(p.board).toLowerCase()));
    const group = board && (board.groups.find((g) => g.name.toLowerCase() === str(p.group).toLowerCase()) || board.groups[0]);
    const ws = struct.workspaces.find((w) => w.name.toLowerCase() === str(p.workspace).toLowerCase());
    const used = new Set(arr(x.sources_used).map(Number));
    return {
      title: str(x.title, 200), summary: str(x.summary, 3000), language: str(x.language, 40), translation: /^english$/i.test(str(x.language)) ? '' : str(x.translation, 40000),
      category: CATEGORIES.includes(x.category) ? x.category : 'other', priority: PRIORITIES.includes(x.priority) ? x.priority : 'normal', due: isoDate(x.due),
      senderType: str(x.sender_type, 20), customer: str(x.customer, 200), keyPoints: arr(x.key_points).map((s) => str(s, 500)).slice(0, 12),
      plan: arr(x.plan).slice(0, 20).map((s) => ({ step: str(s.step, 500), owner: ['me', 'internal', 'third party'].includes(s.owner) ? s.owner : 'me', who: str(s.who, 120), due: isoDate(s.due), done: prevDone.has(str(s.step, 500)), itemId: null })),
      replies: arr(x.replies).slice(0, 8).map((s) => ({ to: str(s.to, 300), audience: s.audience === 'internal' ? 'internal' : 'external', purpose: str(s.purpose, 200), subject: str(s.subject, 300), body: str(s.body, 10000), sent: prevSent.has(str(s.subject, 300) + str(s.to, 300)) })),
      questions: arr(x.questions).slice(0, 6).map((q) => ({ question: str(q.question, 400), why: str(q.why, 300), answer: answerFor(q.question) })),
      answered: answers,
      risks: arr(x.risks).map((s) => str(s, 400)).slice(0, 8),
      placement: { workspace: board ? board.workspace : str(p.workspace, 120), workspaceId: board ? board.workspaceId : ws ? ws.id : null, board: board ? board.name : str(p.board, 120), boardId: board ? board.id : null, group: group ? group.name : str(p.group, 120), groupId: group ? group.id : null, newBoard: !board, reason: str(p.reason, 500) },
      organize: { advice: str((x.organize || {}).advice, 2000), boardName: str((x.organize || {}).board_name, 120), workspace: str((x.organize || {}).workspace, 120), groups: arr((x.organize || {}).groups).map((g) => str(g, 80)).filter(Boolean).slice(0, 12), columns: arr((x.organize || {}).columns).map((g) => str(g, 60)).filter(Boolean).slice(0, 12) },
      sources: sources.map((s) => ({ n: s.n, kind: s.kind, id: s.id || null, name: s.name || '', path: s.path || null, board: s.board || null, snippet: String(s.text || '').replace(/\s+/g, ' ').slice(0, 240), used: used.has(s.n) })),
      mode, model, notes, analyzedAt: now(),
    };
  }

  matchCustomer(name, rel) {
    const n = String(name || '').trim();
    if (n) { try { const c = this.customers.byName(n, false); if (c) return c; } catch (_) { /* not found */ } }
    return rel.customers[0] || null;
  }

  // ------------------------------------------------------------- user actions
  update(id, patch = {}) {
    const r = this.row(id);
    const a = parseJson(r.analysis, null);
    const sets = [];
    const args = [];
    if (patch.status && STATUSES.includes(patch.status)) { sets.push('status=?'); args.push(patch.status); }
    if (patch.priority && PRIORITIES.includes(patch.priority)) { sets.push('priority=?'); args.push(patch.priority); }
    if (patch.title !== undefined) { sets.push('title=?'); args.push(String(patch.title).slice(0, 200) || r.title); }
    if (patch.due !== undefined) { sets.push('due=?'); args.push(isoDate(patch.due) || null); }
    if (patch.customerId !== undefined) { sets.push('customer_id=?'); args.push(patch.customerId || null); }
    if (a) {
      let changed = false;
      if (patch.step) { const s = a.plan[patch.step.index]; if (s) { Object.assign(s, pick(patch.step, ['done', 'step', 'owner', 'who', 'due'])); changed = true; } }
      if (patch.addStep) { a.plan.push({ step: String(patch.addStep.step || '').slice(0, 500), owner: patch.addStep.owner || 'me', who: patch.addStep.who || '', due: isoDate(patch.addStep.due), done: false, itemId: null }); changed = true; }
      if (patch.removeStep != null) { a.plan.splice(patch.removeStep, 1); changed = true; }
      if (patch.reply) { const s = a.replies[patch.reply.index]; if (s) { Object.assign(s, pick(patch.reply, ['to', 'subject', 'body', 'sent'])); changed = true; } }
      if (patch.answer) { const q = a.questions[patch.answer.index]; if (q) { q.answer = String(patch.answer.answer || '').slice(0, 2000); changed = true; } }
      if (patch.placement) { a.placement = { ...a.placement, ...patch.placement }; changed = true; }
      if (changed) { sets.push('analysis=?'); args.push(JSON.stringify(a)); }
    }
    if (sets.length) this.db.run(`UPDATE assistant_cases SET ${sets.join(', ')}, updated_at=? WHERE id=?`, [...args, now(), id]);
    return this.get(id);
  }

  /** Answer the assistant's questions (and add more context), then rebuild the plan. */
  async answer(id, { answers = {}, extra = '' } = {}) {
    const r = this.row(id);
    const a = parseJson(r.analysis, null);
    if (a) {
      for (const [k, v] of Object.entries(answers)) if (a.questions[k]) a.questions[k].answer = String(v || '').slice(0, 2000);
      a.answered = [...(a.answered || []).filter((x) => !a.questions.some((q) => q.question === x.question)), ...a.questions.filter((q) => q.answer)];
      if (String(extra).trim()) a.answered.push({ question: 'Additional context from me', answer: String(extra).slice(0, 4000) });
      a.questions = a.questions.map((q) => ({ ...q }));
      this.db.run('UPDATE assistant_cases SET analysis=? WHERE id=?', [JSON.stringify({ ...a, questions: a.answered.map((x) => ({ question: x.question, why: '', answer: x.answer })) }), id]);
    }
    return this.analyze(id);
  }

  /** Add more files or text to a case and rebuild the plan. */
  async addTo(id, { files = [], text = '' } = {}) {
    const r = this.row(id);
    const src = parseJson(r.source, {});
    for (const f of files.slice(0, 20)) {
      const bytes = Buffer.from(f.bytes);
      try { const x = await this.read(f.name, bytes); src.files = [...(src.files || []), { name: f.name, kind: x.kind, email: x.email || null, text: x.text.slice(0, MAX_TEXT), attachments: x.attachments }]; } catch (e) { src.files = [...(src.files || []), { name: f.name, kind: 'document', text: '', error: String(e.message || e), attachments: [] }]; }
    }
    if (String(text).trim()) src.pasted = `${src.pasted ? `${src.pasted}\n\n---\n\n` : ''}${String(text).trim()}`.slice(0, MAX_TEXT);
    this.db.run('UPDATE assistant_cases SET source=?, text=? WHERE id=?', [JSON.stringify(src), this.caseText(src), id]);
    return this.analyze(id);
  }

  /** A follow-up conversation about one case. */
  async chat(id, message) {
    const r = this.row(id);
    const a = parseJson(r.analysis, {}) || {};
    const history = parseJson(r.chat, []);
    const q = String(message || '').trim();
    if (!q) throw new Error('Type a message first.');
    const cfg = this.config();
    const system = `${this.systemPrompt(cfg)}\n\nNow you are discussing one case with the user. Help them decide, write or rewrite messages, plan next steps, and find information. Be direct and brief. When you write a message, write it ready to send. If you need information you don't have, ask for it.`;
    const ctx = `<case>\n${(r.text || '').slice(0, 20000)}\n</case>\n\n<your_analysis>\nSummary: ${a.summary || ''}\nPlan:\n${(a.plan || []).map((s, i) => `${i + 1}. ${s.step} (${s.owner}${s.who ? `: ${s.who}` : ''}${s.due ? `, due ${s.due}` : ''})${s.done ? ' [done]' : ''}`).join('\n')}\n</your_analysis>`;
    const messages = [{ role: 'user', content: ctx }, { role: 'assistant', content: 'Understood. What would you like to do?' }, ...history.slice(-12).map((h) => ({ role: h.role, content: h.content })), { role: 'user', content: q }];
    let reply;
    try { reply = await this.capture.askText({ system, messages }); } catch (e) { reply = { mode: 'error', text: `The model could not answer: ${e.message || e}` }; }
    const text = reply ? reply.text || 'The model returned an empty answer.' : 'No AI model is running. Start Ollama (or choose an AI in Settings › AI) to chat about this case.';
    const next = [...history, { role: 'user', content: q, at: now() }, { role: 'assistant', content: text, at: now(), model: reply && reply.model }].slice(-40);
    this.db.run('UPDATE assistant_cases SET chat=?, updated_at=? WHERE id=?', [JSON.stringify(next), now(), id]);
    return next;
  }

  /** Create the proposed board (or one the user names) with its swim lanes and columns. */
  createBoard(id, { name, workspaceId, groups, columns } = {}) {
    const r = this.row(id);
    const a = parseJson(r.analysis, null);
    const o = (a && a.organize) || {};
    const bname = String(name || o.boardName || (a && a.placement && a.placement.board) || 'Action items').trim();
    const wsId = workspaceId || (this.db.get('SELECT id FROM workspaces WHERE LOWER(name)=?', [String(o.workspace || (a && a.placement && a.placement.workspace) || '').toLowerCase()]) || {}).id || null;
    const gs = (groups || o.groups || []).length ? (groups || o.groups) : ['To do', 'In progress', 'Waiting on others', 'Done'];
    const extra = (columns || o.columns || []).filter((t) => !/^(owner|status|due( date)?|name|item)$/i.test(t));
    const boardId = this.store.createBoard({ workspaceId: wsId, name: bname,
      groups: gs.map((g) => ({ name: g, color: /done|closed|complete/i.test(g) ? 'mint' : undefined })),
      columns: [{ title: 'Owner', type: 'people' }, { title: 'Status', type: 'status' }, { title: 'Due date', type: 'date' }, { title: 'Priority', type: 'priority' }, ...extra.map((t) => ({ title: t, type: colType(t) }))] });
    if (a) {
      const g = this.db.get('SELECT id, name FROM groups WHERE board_id=? ORDER BY position LIMIT 1', [boardId]);
      a.placement = { ...a.placement, board: bname, boardId, group: g.name, groupId: g.id, newBoard: false, workspaceId: this.store.boardRow(boardId).workspace_id };
      this.db.run('UPDATE assistant_cases SET analysis=? WHERE id=?', [JSON.stringify(a), id]);
    }
    return boardId;
  }

  /** Turn plan steps into items on a board, with owner, due date, priority and customer, and a link back. */
  toTasks(id, { boardId, groupId, steps } = {}) {
    const r = this.row(id);
    const a = parseJson(r.analysis, null);
    if (!a) throw new Error('This case has no plan yet.');
    const bid = boardId || a.placement.boardId;
    if (!bid) throw new Error('Choose a board for these tasks, or create the suggested board first.');
    const cols = this.store.columns(bid, 'item');
    const people = this.store.people();
    const me = this.store.me().id;
    const pc = cols.find((c) => c.type === 'people');
    const dc = cols.find((c) => c.type === 'date');
    const tc = cols.find((c) => c.type === 'timeline');
    const prc = cols.find((c) => c.type === 'priority');
    const cc = cols.find((c) => c.type === 'customer');
    const pick2 = (steps && steps.length ? steps : a.plan.map((_, i) => i)).filter((i) => a.plan[i] && !a.plan[i].itemId);
    let n = 0;
    for (const i of pick2) {
      const s = a.plan[i];
      const values = {};
      if (pc) {
        const who = s.owner === 'me' ? me : (people.find((p) => s.who && p.name.toLowerCase() === s.who.toLowerCase()) || {}).id;
        if (who) values[pc.id] = [who];
      }
      if (s.due && dc) values[dc.id] = s.due;
      else if (s.due && tc) values[tc.id] = { start: s.due, end: s.due };
      if (prc) { const lab = (prc.settings.labels || []).find((l) => l.label.toLowerCase().startsWith(r.priority === 'urgent' ? 'crit' : r.priority)); if (lab) values[prc.id] = lab.id; }
      if (cc && r.customer_id) values[cc.id] = [r.customer_id];
      const name = s.owner === 'me' ? s.step : `${s.step}${s.who ? ` (${s.who})` : ''}`;
      const itemId = this.store.addItem(bid, { groupId: groupId || a.placement.groupId, name: name.slice(0, 250), values, source: 'assistant' });
      this.store.postUpdate(itemId, `From the assistant case “${r.title}”${r.sender ? ` (from ${r.sender})` : ''}.\n\n${a.summary}`);
      s.itemId = itemId;
      s.boardId = bid;
      n += 1;
    }
    this.db.run('UPDATE assistant_cases SET analysis=?, updated_at=? WHERE id=?', [JSON.stringify(a), now(), id]);
    return { created: n, boardId: bid };
  }

  // ------------------------------------------------------------- teaching
  notesDir() { return this.dir ? path.join(path.dirname(this.dir), 'Assistant knowledge') : null; }
  /** Save notes and documents (OneNote .md exports, Word, PDF…) so every answer can draw on them. */
  async teach({ files = [] } = {}) {
    const dir = this.notesDir();
    if (!dir) throw new Error('Teaching needs the desktop app.');
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const f of files) {
      const rel = String(f.name || 'note.md').replace(/\\/g, '/').split('/').map((x) => x.replace(/[:*?"<>|]/g, '_')).filter((x) => x && x !== '..' && x !== '.').join(path.sep) || 'note.md';
      const dest = path.join(dir, rel);
      if (!dest.startsWith(dir)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(f.bytes));
      n += 1;
    }
    if (this.knowledge) { this.knowledge.addFolder(dir); this.knowledge.startIndex(); }
    return { saved: n, notes: this.notes() };
  }
  /** Add whole folders (on this PC) to what the assistant searches. */
  teachFolders(paths = []) {
    const added = [];
    for (const p of paths) { try { this.knowledge.addFolder(p); added.push(p); } catch (_) { /* not a folder */ } }
    if (added.length) this.knowledge.startIndex();
    return { added };
  }
  notes() {
    const dir = this.notesDir();
    if (!dir || !fs.existsSync(dir)) return [];
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const st = fs.statSync(p); out.push({ name: path.relative(dir, p), size: st.size, at: st.mtime.toISOString() }); } } };
    walk(dir);
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 1000);
  }
  forget(name) {
    const dir = this.notesDir();
    const p = path.join(dir, String(name));
    if (!p.startsWith(dir) || !fs.existsSync(p)) throw new Error('That note no longer exists.');
    fs.rmSync(p, { force: true });
    if (this.knowledge) this.knowledge.startIndex();
    return this.notes();
  }

  remove(id) {
    this.row(id);
    this.db.run('DELETE FROM assistant_cases WHERE id=?', [id]);
    if (this.dir) { try { fs.rmSync(path.join(this.dir, id), { recursive: true, force: true }); } catch (_) { /* ignore */ } }
    return true;
  }

  storedFile(id, name) {
    const src = parseJson(this.row(id).source, {});
    const f = (src.files || []).find((x) => x.name === name);
    if (!f || !f.stored || !fs.existsSync(f.stored)) throw new Error('The original file is no longer available.');
    return f.stored;
  }

  /** The day at a glance: what needs me, what I'm waiting on, and what's due. */
  today() {
    const t = today();
    const rows = this.db.all("SELECT * FROM assistant_cases WHERE status<>'done'").map((r) => ({ r, a: parseJson(r.analysis, null) }));
    const mine = [];
    const waiting = [];
    for (const { r, a } of rows) {
      for (const [i, s] of ((a && a.plan) || []).entries()) {
        if (s.done) continue;
        const e = { caseId: r.id, caseTitle: r.title, index: i, step: s.step, who: s.who, due: s.due || null, overdue: !!(s.due && s.due < t), priority: r.priority };
        (s.owner === 'me' ? mine : waiting).push(e);
      }
    }
    const order = (x, y) => String(x.due || '9999').localeCompare(String(y.due || '9999')) || PRIORITIES.indexOf(x.priority) - PRIORITIES.indexOf(y.priority);
    return {
      open: rows.length, urgent: rows.filter(({ r }) => r.priority === 'urgent').length,
      replies: rows.reduce((n, { a }) => n + ((a && a.replies) || []).filter((x) => !x.sent).length, 0),
      questions: rows.reduce((n, { a }) => n + ((a && a.questions) || []).filter((x) => !x.answer).length, 0),
      dueToday: mine.filter((s) => s.due && s.due <= t).length,
      mine: mine.sort(order).slice(0, 15), waiting: waiting.sort(order).slice(0, 15),
    };
  }

  // ------------------------------------------------------------- watched folder
  /** New files in the watched folder become cases (checked every minute). */
  async scanWatch() {
    const cfg = this.config();
    const dir = cfg.watchFolder;
    if (!dir || !fs.existsSync(dir)) return 0;
    const seen = new Set(cfg.watchSeen || []);
    const first = !cfg.watchStarted;
    let n = 0;
    const names = fs.readdirSync(dir).filter((f) => READABLE.test(f) && !f.startsWith('~$') && !f.startsWith('.'));
    for (const f of names) {
      const p = path.join(dir, f);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (!st.isFile() || st.size > 40e6) continue;
      const key = `${f}|${st.size}|${Math.round(st.mtimeMs)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (first || Date.now() - st.mtimeMs < 2000) continue; // skip what was there before watching, and files still being written
      try { await this.intake({ files: [{ name: f, bytes: fs.readFileSync(p) }], origin: 'watch' }); n += 1; } catch (_) { /* ignore */ }
    }
    this.setConfig({ watchSeen: [...seen].slice(-3000), watchStarted: true });
    if (n) this.store.notify(this.store.me().id, 'assistant', `${n} new ${n === 1 ? 'file is' : 'files are'} in the assistant`, `From ${dir}`, null, null);
    return n;
  }
}

/** Looks like a chat transcript: several "Name, time" or "[time] Name" lines. */
function isChat(text) {
  const lines = String(text).split(/\r?\n/).slice(0, 400);
  const stamp = lines.filter((l) => /^\s*\[?\d{1,2}:\d{2}(\s?[AP]M)?\]?\s+\S/i.test(l) || /^\s*[A-Z][\w'.-]+(?: [A-Z][\w'.-]+){0,3},?\s+(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s+)?\d{1,2}:\d{2}\s?(?:[AP]M)?\s*$/i.test(l) || /^\s*(Yesterday|Today|Monday|Tuesday|Wednesday|Thursday|Friday)\s+\d{1,2}:\d{2}/i.test(l)).length;
  return stamp >= 3;
}

function pick(o, keys) { return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])); }

module.exports = { Assistant, SCHEMA, DEFAULT_PROFILE, isChat };
