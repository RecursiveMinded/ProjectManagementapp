'use strict';
// The chat: the one place to drop files and ask things. Each dropped file is
// read and planned by the assistant (a case per file, so every file gets its
// own answer). A question is answered from boards, customers, calls, cases and
// indexed folders. Anything else typed is treated as a note to act on and goes
// to the assistant too. The morning briefing is posted here as well.
// History is kept in the database, so it survives restarts.

const { now, today, parseJson } = require('./util');

const QUESTION = /^(who|what|when|where|why|how|which|whose|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|any|list|show|find|tell|summari[sz]e|give)\b/i;
const BRIEF = /^(brief(ing)?|today|good morning|morning|what('?s| is) (on|up|next)( for)?( today)?|what should i (do|work on)( first| next| today)?|what('?s| is) (my )?(priority|priorities)|plan my day)\b/i;

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

  shape(r) {
    const data = parseJson(r.data, {});
    const m = { id: r.id, at: r.ts, role: r.role, kind: r.kind, content: r.content, ...data };
    if (data.caseIds) {
      m.cases = data.caseIds.map((id) => {
        try {
          const c = this.assistant.get(id);
          const plan = (c.analysis && c.analysis.plan) || [];
          return { id, title: c.title, state: c.state, error: c.error, summary: c.summary, priority: c.priority, due: c.due, sender: c.sender, files: c.files, kind: c.kind,
            mine: plan.filter((s) => !s.done && s.owner === 'me').length, waiting: plan.filter((s) => !s.done && s.owner !== 'me').length, questions: c.questions, replies: ((c.analysis && c.analysis.replies) || []).length };
        } catch (_) { return { id, gone: true }; }
      });
    }
    return m;
  }

  history({ limit = 200 } = {}) {
    return this.db.all('SELECT * FROM (SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?) ORDER BY id', [limit]).map((r) => this.shape(r));
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
      for (const f of files.slice(0, 40)) ids.push(await this.assistant.intake({ files: [f], text: files.length === 1 ? t : '', origin: 'chat' }));
      if (t && files.length > 1) ids.push(await this.assistant.intake({ text: t, origin: 'chat' }));
      reply = this.post('assistant', 'cases', ids.length === 1 ? 'Reading it now.' : `Reading ${ids.length} items now. Each gets its own summary and tasks.`, { caseIds: ids });
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

module.exports = { Chat, isQuestion, BRIEF };
