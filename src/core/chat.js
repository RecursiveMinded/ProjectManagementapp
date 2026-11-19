'use strict';
// The chat: the one place to drop files and ask things. Each dropped file is
// read and planned by the assistant (a case per file, so every file gets its
// own answer). A question is answered from boards, customers, calls, cases and
// indexed folders. Anything else typed is treated as a note to act on and goes
// to the assistant too. The morning briefing is posted here as well.
// History is kept in the database, so it survives restarts.

const fs = require('fs');
const crypto = require('crypto');
const { now, today, addDays, parseJson } = require('./util');
const archives = require('./archives');
const { hash } = require('./tasks');

const PST_DAYS = 30;
const PST_LIMIT = 100;

const QUESTION = /^(who|what|when|where|why|how|which|whose|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|any|list|show|find|tell|summari[sz]e|give)\b/i;
const BRIEF = /^(brief(ing)?|today|good morning|morning|what('?s| is) (on|up|next)( for)?( today)?|what should i (do|work on)( first| next| today)?|what('?s| is) (my )?(priority|priorities)|plan my day)\b/i;

// "completed the Omni battle card", "done with the price file", "sent the quote to Joe"
// "what did I do today?", "summarize my day", "where did my time go yesterday"
const MYDAY = /^(what (did|have) i (do|done|work(ed)? on)|how did i spend|where did (my|the) (time|day) go|(summari[sz]e|recap) my (day|time|activity)|my day so far|my activity)\b/i;
// "recap my last meeting", "summarize the last call"
const LASTMEETING = /^(recap|summari[sz]e|write up)\s+(my |the )?(last|latest|previous|recent) (meeting|call)\b/i;

const DONE = /^(i\s+)?(just\s+|have\s+|'ve\s+)?(completed?|done|finished|closed( out)?|sent|submitted|delivered|wrapped up|ticked off|mark(ed)? (as )?done)\b/i;

function isQuestion(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 300 || t.includes('\n')) return false;
  return /\?\s*$/.test(t) || QUESTION.test(t);
}

class Chat {
  constructor({ db, assistant, knowledge, tasks, myWork }) {
    this.db = db;
    this.assistant = assistant;
    this.knowledge = knowledge;
    this.tasks = tasks;
    this.myWork = myWork;
  }

  post(role, kind, content, data = {}) {
    this.db.run('INSERT INTO chat_messages(ts,role,kind,content,data) VALUES(?,?,?,?,?)', [now(), role, kind, String(content || ''), JSON.stringify(data || {})]);
    return this.db.get('SELECT last_insert_rowid() AS id').id;
  }

  /** Open tasks by key, so a message shows each task as it is now (its date, priority, words). */
  live() {
    const map = {};
    for (const t of this.tasks.all()) map[t.key] = t;
    return map;
  }

  shape(r, live = null) {
    const data = parseJson(r.data, {});
    const m = { id: r.id, at: r.ts, role: r.role, kind: r.kind, content: r.content, ...data };
    const need = data.caseIds || data.briefing || data.keys;
    const open = need ? (live || this.live()) : {};
    if (data.caseIds) {
      m.cases = data.caseIds.map((id) => {
        try {
          const c = this.assistant.get(id);
          const plan = (c.analysis && c.analysis.plan) || [];
          const steps = plan.filter((s) => s.step).map((s) => {
            const key = `case:${id}:${hash(s.step)}`;
            return open[key] || { key, title: s.step, mine: s.owner === 'me', who: s.owner === 'me' ? '' : (s.who || (s.owner === 'internal' ? 'Internal' : 'Third party')), due: s.due || null, state: s.done ? 'done' : 'hidden' };
          });
          return { id, title: c.title, state: c.state, error: c.error, summary: c.summary, priority: c.priority, due: c.due, sender: c.sender, files: c.files, kind: c.kind, steps,
            mine: plan.filter((s) => !s.done && s.owner === 'me').length, waiting: plan.filter((s) => !s.done && s.owner !== 'me').length, questions: c.questions, replies: ((c.analysis && c.analysis.replies) || []).length };
        } catch (_) { return { id, gone: true }; }
      });
    }
    if (data.briefing) {
      m.briefing = { ...data.briefing, top: (data.briefing.top || []).filter((x) => open[x.key]).map((x) => open[x.key]), waiting: (data.briefing.waiting || []).filter((x) => open[x.key]).map((x) => open[x.key]) };
    }
    if (data.keys) {
      // Tasks a message is about: open ones as they are now; ones ticked off here show as done.
      m.tasks = data.keys.map((k) => open[k] || ((data.done || []).includes(k) ? { ...((data.snap || {})[k] || { title: 'Task' }), key: k, state: 'done' } : null)).filter(Boolean);
    }
    return m;
  }

  history({ limit = 200 } = {}) {
    let live = null;
    return this.db.all('SELECT * FROM (SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?) ORDER BY id', [limit]).map((r) => {
      const d = r.data || '';
      if (!live && /"(caseIds|briefing|keys)"/.test(d)) live = this.live();
      return this.shape(r, live);
    });
  }

  get(id) { const r = this.db.get('SELECT * FROM chat_messages WHERE id=?', [id]); return r ? this.shape(r) : null; }

  clear() { this.db.run('DELETE FROM chat_messages'); return true; }

  /** Send files and/or text. Returns the new messages (the user's and the reply). */
  async send({ text = '', files = [] } = {}) {
    const t = String(text || '').trim();
    if (!t && !files.length) throw new Error('Type something or drop a file.');
    const first = this.post('user', 'text', t, files.length ? { files: files.map((f) => f.name) } : {});
    let reply;
    if (files.length) {
      const ids = [];
      const notes = [];
      const plain = [];
      for (const f of files.slice(0, 40)) {
        if (/\.pst$/i.test(f.name)) { const r = await this.fromPst(f); ids.push(...r.ids); notes.push(r.note); }
        else if (/\.onepkg$/i.test(f.name)) { const r = await this.fromOnepkg(f); ids.push(...r.ids); notes.push(r.note); }
        else plain.push(f);
      }
      for (const f of plain) ids.push(await this.assistant.intake({ files: [f], text: plain.length === 1 && files.length === 1 ? t : '', origin: 'chat' }));
      if (t && (files.length > 1 || plain.length !== files.length)) ids.push(await this.assistant.intake({ text: t, origin: 'chat' }));
      const head = ids.length === 1 ? 'Reading it now.' : ids.length ? `Reading ${ids.length} items now. Each gets its own summary and tasks.` : 'Nothing new to read.';
      reply = this.post('assistant', 'cases', [...notes, head].join(' '), { caseIds: ids });
    } else if (DONE.test(t) && t.length < 300 && !t.includes('\n') && this.tasks.match(t).some((x) => x.m >= 0.34)) {
      reply = this.ticked(t);
    } else if (this.activity && MYDAY.test(t) && t.length < 200) {
      reply = await this.myDay(/yesterday/i.test(t) ? addDays(today(), -1) : today());
    } else if (this.activity && LASTMEETING.test(t) && t.length < 200) {
      reply = await this.lastMeeting();
    } else if (BRIEF.test(t)) {
      reply = this.briefing({ force: true, quiet: true });
    } else if (isQuestion(t)) {
      reply = await this.answer(t, first);
    } else {
      const id = await this.assistant.intake({ text: t, origin: 'chat' });
      reply = this.post('assistant', 'cases', 'Got it. I will turn this into tasks.', { caseIds: [id] });
    }
    return [this.get(first), this.get(reply)];
  }

  /**
   * "Completed the market review": tick off the task that clearly matches, or show the likely ones to tick.
   * A clear match is most of the words and well ahead of the next best.
   */
  ticked(text) {
    const hits = this.tasks.match(text);
    const [best, next] = hits;
    const snap = (t) => ({ title: t.title, context: t.context || '', who: t.who || '', mine: t.mine, source: t.source, link: t.link || null });
    if (best.m >= 0.6 && (!next || next.m <= best.m - 0.2)) {
      this.tasks.done(best.t.key);
      const left = this.tasks.list().mine;
      const tail = left.length ? ` Next up: ${left[0].title}.` : ' Your list is clear.';
      return this.post('assistant', 'tasks', `Ticked off: ${best.t.title}.${tail}`, { keys: [best.t.key, ...(left[0] ? [left[0].key] : [])], done: [best.t.key], snap: { [best.t.key]: snap(best.t) } });
    }
    const pick = hits.filter((x) => x.m >= 0.34).slice(0, 5).map((x) => x.t.key);
    return this.post('assistant', 'tasks', pick.length === 1 ? 'Is this the one? Tick it to mark it done.' : 'Which one did you finish? Tick it to mark it done.', { keys: pick });
  }

  bytesOf(f) {
    if (f.bytes) return Buffer.from(f.bytes);
    if (f.path) return fs.readFileSync(f.path);
    throw new Error(`${f.name} could not be opened.`);
  }

  /** Emails from an Outlook .pst: the last 30 days, newest 100, each read on its own; ones already read are skipped. */
  async fromPst(f) {
    const since = addDays(today(), -PST_DAYS);
    const r = archives.readPst(f.path && !f.bytes ? f.path : this.bytesOf(f), { since, limit: PST_LIMIT * 3 });
    const seenRow = this.db.get("SELECT value FROM settings WHERE key='pst_seen'");
    const seen = new Set(parseJson(seenRow && seenRow.value, []));
    const fresh = [];
    let dupes = 0;
    for (const e of r.emails) {
      const k = crypto.createHash('sha1').update(`${e.from}|${e.subject}|${e.date}`).digest('hex').slice(0, 16);
      if (seen.has(k)) { dupes += 1; continue; }
      if (fresh.length >= PST_LIMIT) break;
      seen.add(k);
      fresh.push(e);
    }
    this.db.run("INSERT INTO settings(key,value) VALUES('pst_seen',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify([...seen].slice(-20000))]);
    const ids = [];
    for (const e of fresh) {
      const name = `${String(e.subject || 'Email').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.eml`;
      ids.push(await this.assistant.intake({ files: [{ name, bytes: archives.toEml(e) }], origin: 'pst' }));
    }
    const more = r.total - dupes - fresh.length;
    const note = `${f.name}: ${r.total} ${r.total === 1 ? 'email' : 'emails'} from the last ${PST_DAYS} days${dupes ? `, ${dupes} already read` : ''}${more > 0 ? `. Reading the newest ${fresh.length}; drop it again to read the next ${Math.min(more, PST_LIMIT)}` : ''}.`;
    return { ids, note };
  }

  /** Each section of a OneNote notebook package is read on its own. */
  async fromOnepkg(f) {
    const files = archives.cabFiles(this.bytesOf(f)).filter((x) => /\.one$/i.test(x.name) && !/OneNote_RecycleBin/i.test(x.name));
    const ids = [];
    for (const x of files.slice(0, 60)) ids.push(await this.assistant.intake({ files: [{ name: x.name.split('/').pop(), bytes: x.bytes }], origin: 'onenote' }));
    return { ids, note: `${f.name}: ${files.length} ${files.length === 1 ? 'section' : 'sections'}${files.length > 60 ? ', reading the first 60' : ''}.` };
  }

  async answer(question, beforeId) {
    const history = this.db.all("SELECT role, content FROM chat_messages WHERE id<? AND kind IN ('text','answer') AND content<>'' ORDER BY id DESC LIMIT 6", [beforeId]).reverse();
    try {
      const r = await this.knowledge.ask({ question, history }, { myWork: this.myWork, extra: (q) => this.caseSources(q) });
      return this.post('assistant', 'answer', r.answer || '', { sources: r.sources, notes: r.notes, mode: r.mode, model: r.model });
    } catch (e) {
      return this.post('assistant', 'answer', '', { error: String(e.message || e) });
    }
  }

  /** Cases (dropped emails, files, notes) that match the words of a question, as sources for an answer. */
  caseSources(q) {
    const ws = String(q || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || [];
    const stop = new Set(['what', 'who', 'when', 'where', 'why', 'how', 'the', 'and', 'for', 'with', 'about', 'did', 'does', 'this', 'that', 'week', 'today', 'have', 'has', 'are', 'was', 'were', 'any', 'from', 'what\'s', 'last', 'there', 'happened', 'tell', 'show', 'list']);
    const words = [...new Set(ws.filter((w) => !stop.has(w)))].slice(0, 6);
    if (!words.length) return [];
    const rows = this.db.all("SELECT id, title, sender, text, analysis, created_at FROM assistant_cases WHERE state='ready' ORDER BY created_at DESC LIMIT 400");
    return rows.map((r) => {
      const hay = `${r.title} ${r.sender} ${r.text}`.toLowerCase();
      const n = words.filter((w) => hay.includes(w)).length;
      return { r, n };
    }).filter((x) => x.n).sort((a, b) => b.n - a.n).slice(0, 5).map(({ r }) => {
      const a = parseJson(r.analysis, {}) || {};
      const steps = (a.plan || []).map((s) => `${s.done ? '[done] ' : ''}${s.step}${s.who ? ` (${s.who})` : ''}${s.due ? ` due ${s.due}` : ''}`).join('; ');
      return { kind: 'case', id: r.id, name: r.title, text: `Dropped ${r.created_at.slice(0, 10)}${r.sender ? ` from ${r.sender}` : ''}: “${r.title}”. ${a.summary || ''}${steps ? ` Plan: ${steps}` : ''}`.slice(0, 2400) };
    });
  }

  /** "What did I do today?": the activity summary for the day, or how to turn tracking on. */
  async myDay(date) {
    const st = this.activity.settings();
    const d = this.activity.day(date);
    if (!d.timeline.length) {
      const why = st.enabled ? 'Nothing was tracked on that day yet.' : 'Activity tracking is off. Turn it on in **Activity** (left menu) and I will keep a private log of the apps and documents you work in, on this PC only.';
      return this.post('assistant', 'answer', why, { mode: 'basic' });
    }
    try {
      const s = await this.activity.summarize(date);
      return this.post('assistant', 'answer', `${s.text}${s.note ? `\n\n_${s.note}_` : ''}`, { mode: s.mode, model: s.model, activity: date });
    } catch (e) { return this.post('assistant', 'answer', '', { error: String(e.message || e) }); }
  }

  /** "Recap my last meeting": the most recent meeting from the activity log goes to the assistant. */
  async lastMeeting() {
    const ms = [...this.activity.day(today()).meetings, ...this.activity.day(addDays(today(), -1)).meetings].filter((m) => !m.live).sort((a, b) => (a.start < b.start ? 1 : -1));
    if (!ms.length) return this.post('assistant', 'answer', 'I did not see a meeting today or yesterday. Open **Activity** to start one by hand, or paste the transcript or your notes here.', { mode: 'basic' });
    const m = ms[0];
    if (m.recap) return this.post('assistant', 'cases', `${m.title} was already recapped.`, { caseIds: [m.recap.caseId] });
    try {
      const { caseId } = await this.activity.recap({ id: m.id, date: m.date, quiet: true });
      return this.post('assistant', 'cases', `Recapping ${m.title} (${m.from}–${m.to}) from what was on your screen. Drop the Teams transcript here too for a fuller recap.`, { caseIds: [caseId] });
    } catch (e) { return this.post('assistant', 'answer', '', { error: String(e.message || e) }); }
  }

  /** Post the morning briefing once a day (or now, when asked). Returns the message id, or null. */
  briefing({ force = false, at = today() } = {}) {
    const key = `briefing:${at}`;
    if (!force && this.db.get('SELECT key FROM settings WHERE key=?', [key])) return null;
    const b = this.tasks.briefing({ at });
    if (!force) {
      if (!b.top.length && !b.meetings.length && !b.waiting.length && !b.newCases.length) return null; // nothing to say yet
      this.db.run('INSERT INTO settings(key,value) VALUES(?,?)', [key, 'true']);
    }
    return this.post('assistant', 'briefing', this.tasks.briefingText(b), { briefing: b });
  }
}

module.exports = { Chat, isQuestion, BRIEF, DONE, MYDAY, LASTMEETING };
