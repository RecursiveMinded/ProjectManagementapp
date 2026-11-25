'use strict';
// One task list. Tasks come from three places and are shown together:
//  - steps in the assistant's plans (from dropped emails, files and chat notes),
//  - board items assigned to me,
//  - action items from calls and meetings,
// plus tasks typed straight into the list. Each task has a priority score and
// the reason for it. Done, snooze and dismiss are remembered per task, and
// every action is logged in task_events so priority can learn from it later.

const crypto = require('crypto');
const { uid, now, today, addDays, parseJson } = require('./util');

const PRI_POINTS = { urgent: 40, high: 25, normal: 10, low: 0 };
const STOP = new Set(['the', 'and', 'for', 'with', 'completed', 'complete', 'done', 'finished', 'finish', 'closed', 'sent', 'submitted', 'delivered', 'that', 'this', 'have', 'has', 'was', 'just', 'today', 'task', 'all']);

function hash(s) { return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 10); }
function daysFrom(a, b) { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5); }
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function niceDate(iso) { return iso ? `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}` : ''; }

/** Score a task and say why it ranks where it does. Higher comes first. */
function score(t, at = today()) {
  let s = PRI_POINTS[t.priority] != null ? PRI_POINTS[t.priority] : 10;
  const why = [];
  if (t.due) {
    const d = daysFrom(at, t.due);
    if (d < 0) { s += 50 + Math.min(-d, 10) * 2; why.push(d === -1 ? 'Overdue since yesterday' : `Overdue by ${-d} days`); }
    else if (d === 0) { s += 40; why.push('Due today'); }
    else if (d === 1) s += 25;
    else if (d <= 6) s += 15;
    else if (d <= 13) s += 5;
  }
  if (t.priority === 'urgent') why.push('Marked urgent');
  else if (t.priority === 'high') why.push('High priority');
  if (t.createdAt && Date.now() - Date.parse(t.createdAt) < 864e5) { s += 5; if (!why.length) why.push('New today'); }
  if (!t.mine) s -= 10;
  return { score: s, reason: why.join(' · ') };
}

class Tasks {
  constructor({ db, store, assistant, meetings, myWork, setItemDone }) {
    this.db = db;
    this.store = store;
    this.assistant = assistant;
    this.meetings = meetings;
    this.myWork = myWork;
    this.setItemDone = setItemDone;
  }

  states() {
    return Object.fromEntries(this.db.all('SELECT * FROM task_state').map((r) => [r.key, r]));
  }

  /** Every open task, scored. Snoozed and dismissed ones are left out unless asked for. */
  all({ includeHidden = false, at = today() } = {}) {
    const st = this.states();
    const me = this.store.me();
    const people = this.store.peopleMap();
    const out = [];
    const items = new Set();

    // Board items assigned to me.
    for (const w of this.myWork()) {
      items.add(w.id);
      out.push({
        key: `item:${w.id}`, source: 'item', sourceId: w.id, title: w.name, mine: true, who: '', due: w.due || null, priority: 'normal',
        context: `${w.boardName}${w.groupName ? ` › ${w.groupName}` : ''}${w.parentName ? ` › ${w.parentName}` : ''}`, link: { kind: 'item', id: w.parentId || w.id }, canDone: !!(w.statusColumn && (w.labels || []).some((l) => l.done)),
      });
    }
    // Steps in the assistant's plans.
    for (const r of this.db.all("SELECT id, title, priority, sender, analysis, created_at FROM assistant_cases WHERE status<>'done' AND state<>'error'")) {
      const a = parseJson(r.analysis, null);
      for (const [i, s] of ((a && a.plan) || []).entries()) {
        if (s.done || !s.step) continue;
        if (s.review && s.review !== 'approved') continue; // suggestions wait for approval; rejected ones are not tasks
        if (s.itemId && items.has(s.itemId)) continue;
        out.push({
          key: `case:${r.id}:${hash(s.step)}`, source: 'case', sourceId: r.id, index: i, title: s.step, mine: s.owner === 'me', who: s.owner === 'me' ? '' : (s.who || (s.owner === 'internal' ? 'Internal' : 'Third party')),
          due: s.due || null, priority: r.priority || 'normal', context: r.title, from: r.sender || '', createdAt: r.created_at, link: { kind: 'case', id: r.id }, canDone: true,
        });
      }
    }
    // Action items from calls and meetings.
    for (const x of this.meetings.actions({ includeDone: false })) {
      if (x.item && x.item.id && items.has(x.item.id)) continue;
      const mine = !x.owner || x.owner === me.id;
      out.push({
        key: `ma:${x.id}`, source: 'meeting', sourceId: x.id, title: x.text, mine, who: mine ? '' : ((people[x.owner] || {}).name || 'Someone'), due: x.due || null, priority: 'normal',
        context: `${x.meeting.title}${x.meeting.customer ? ` · ${x.meeting.customer}` : ''}`, link: { kind: 'meeting', id: x.meeting.id }, canDone: true,
      });
    }
    // Tasks typed into the list.
    for (const t of this.db.all('SELECT * FROM own_tasks WHERE done=0')) {
      out.push({ key: `own:${t.id}`, source: 'own', sourceId: t.id, title: t.title, mine: !t.who, who: t.who || '', due: t.due || null, priority: t.priority || 'normal', context: t.note || '', createdAt: t.created_at, link: null, canDone: true });
    }

    const edits = Object.fromEntries(this.db.all('SELECT * FROM task_edits').map((r) => [r.key, r]));
    const list = [];
    const lean0 = this.leanings();
    for (const t of out) {
      const s = st[t.key];
      const e = edits[t.key];
      if (e) {
        if (e.title) t.title = e.title;
        if (e.due) t.due = e.due === 'none' ? null : e.due;
        if (e.priority) { t.priority = e.priority; t.pinned = true; }
      }
      t.state = 'open';
      if (s && s.state === 'done') continue;
      if (s && s.state === 'dismissed') { if (!includeHidden) continue; t.state = 'dismissed'; }
      if (s && s.snooze_until && s.snooze_until > at) { if (!includeHidden) continue; t.state = 'snoozed'; t.snoozeUntil = s.snooze_until; }
      t.isNew = !s || !s.seen;
      t.needsDate = t.mine && !t.due;
      t.stalled = !t.mine && ((t.due && t.due <= at) || (t.createdAt && Date.now() - Date.parse(t.createdAt) > 3 * 864e5));
      Object.assign(t, score(t, at));
      const lean = this.leaning(t, lean0);
      if (lean) { t.score += lean; t.reason = t.reason ? `${t.reason} · You usually put these first` : 'You usually put these first'; }
      list.push(t);
    }
    list.sort((a, b) => b.score - a.score || String(a.due || '9999').localeCompare(String(b.due || '9999')) || a.title.localeCompare(b.title));
    return this.applyOrder(list);
  }

  /** Who the user tends to drag up (or down): sender or owner -> points. */
  leanings() {
    const m = {};
    for (const r of this.db.all("SELECT who, action, COUNT(*) AS n FROM task_events WHERE action IN ('up','down') AND who<>'' GROUP BY who, action")) {
      const k = r.who.toLowerCase();
      m[k] = (m[k] || 0) + (r.action === 'up' ? r.n : -r.n);
    }
    return m;
  }

  leaning(t, m) {
    const k = String(t.who || t.from || '').toLowerCase();
    const n = k ? m[k] || 0 : 0;
    return n > 0 ? Math.min(15, n * 5) : 0;
  }

  /** Tasks the user dragged keep their order; the rest slot in by score. */
  applyOrder(list) {
    const ranks = Object.fromEntries(this.db.all('SELECT key, rank FROM task_order').map((r) => [r.key, r.rank]));
    const ranked = list.filter((t) => ranks[t.key] != null).sort((a, b) => ranks[a.key] - ranks[b.key]);
    if (!ranked.length) return list;
    const rest = list.filter((t) => ranks[t.key] == null);
    const out = [];
    let i = 0; let j = 0;
    while (i < ranked.length || j < rest.length) {
      if (j < rest.length && (i >= ranked.length || rest[j].score > ranked[i].score)) out.push(rest[j++]);
      else { ranked[i].ordered = true; out.push(ranked[i++]); }
    }
    return out;
  }

  /** Save the order the user dragged tasks into. keys: the list top to bottom; moved: the one dragged. */
  reorder(keys, moved) {
    const ks = (Array.isArray(keys) ? keys : []).map(String).filter(Boolean).slice(0, 500);
    if (!ks.length) return true;
    const before = this.all({ includeHidden: true }).filter((t) => ks.includes(t.key));
    const oldAt = before.findIndex((t) => t.key === moved);
    const t = now();
    this.db.tx(() => {
      ks.forEach((k, i) => this.db.run('INSERT INTO task_order(key,rank,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET rank=excluded.rank, updated_at=excluded.updated_at', [k, i + 1, t]));
    });
    const newAt = ks.indexOf(moved);
    if (oldAt >= 0 && newAt >= 0 && oldAt !== newAt) this.log(before[oldAt], newAt < oldAt ? 'up' : 'down');
    return true;
  }

  /** Mine and waiting on others, plus counts. */
  list({ at = today() } = {}) {
    const all = this.all({ includeHidden: true, at });
    const open = all.filter((t) => t.state === 'open');
    return {
      mine: open.filter((t) => t.mine),
      waiting: open.filter((t) => !t.mine),
      snoozed: all.filter((t) => t.state === 'snoozed').sort((a, b) => a.snoozeUntil.localeCompare(b.snoozeUntil)),
      dismissed: all.filter((t) => t.state === 'dismissed'),
      counts: { mine: open.filter((t) => t.mine).length, waiting: open.filter((t) => !t.mine).length, overdue: open.filter((t) => t.mine && t.due && t.due < at).length, today: open.filter((t) => t.mine && t.due === at).length },
    };
  }

  find(key) {
    const t = this.all({ includeHidden: true }).find((x) => x.key === key);
    if (!t) throw new Error('That task is no longer on the list');
    return t;
  }

  setState(key, patch) {
    const cur = this.db.get('SELECT * FROM task_state WHERE key=?', [key]) || { state: '', snooze_until: null, seen: 0 };
    const n = { ...cur, ...patch };
    this.db.run('INSERT INTO task_state(key,state,snooze_until,seen,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state, snooze_until=excluded.snooze_until, seen=excluded.seen, updated_at=excluded.updated_at',
      [key, n.state || '', n.snooze_until || null, n.seen ? 1 : 0, now()]);
  }

  log(t, action) {
    this.db.run('INSERT INTO task_events(ts,key,action,source,who,subject) VALUES(?,?,?,?,?,?)', [now(), t.key, action, t.source, t.who || t.from || '', t.context || '']);
  }

  /** Mark done in its source (plan step, board status, meeting action) and remember it. */
  done(key) {
    const t = this.find(key);
    if (t.source === 'case') {
      const c = this.assistant.get(t.sourceId);
      const i = c.analysis.plan.findIndex((s) => !s.done && hash(s.step) === key.split(':')[2]);
      if (i >= 0) this.assistant.update(t.sourceId, { step: { index: i, done: true } });
    } else if (t.source === 'meeting') this.meetings.updateAction(t.sourceId, { done: true });
    else if (t.source === 'item') { if (t.canDone) this.setItemDone(t.sourceId); }
    else if (t.source === 'own') this.db.run('UPDATE own_tasks SET done=1, done_at=? WHERE id=?', [now(), t.sourceId]);
    this.setState(key, { state: 'done', snooze_until: null, seen: 1 });
    this.log(t, 'done');
    return true;
  }

  /** Change a task where it shows: its words, target date (YYYY-MM-DD, or '' to clear) or priority ('auto' to let Boardenda decide). */
  edit(key, patch = {}) {
    const t = this.find(key);
    const cur = this.db.get('SELECT * FROM task_edits WHERE key=?', [key]) || {};
    const n = { title: cur.title || null, due: cur.due || null, priority: cur.priority || null };
    if (patch.title !== undefined) { const v = String(patch.title || '').trim().slice(0, 500); if (v) n.title = v; }
    if (patch.due !== undefined) n.due = /^\d{4}-\d{2}-\d{2}$/.test(String(patch.due || '')) ? patch.due : 'none';
    if (patch.priority !== undefined) n.priority = PRI_POINTS[patch.priority] != null ? patch.priority : null;
    // Write dates and words back where they live, so the plan, meeting or own task stays right too.
    if (t.source === 'own') {
      if (patch.title !== undefined && n.title) this.db.run('UPDATE own_tasks SET title=? WHERE id=?', [n.title, t.sourceId]);
      if (patch.due !== undefined) this.db.run('UPDATE own_tasks SET due=? WHERE id=?', [n.due === 'none' ? null : n.due, t.sourceId]);
      if (patch.priority !== undefined) this.db.run('UPDATE own_tasks SET priority=? WHERE id=?', [n.priority || 'normal', t.sourceId]);
    } else if (t.source === 'meeting') {
      if (patch.due !== undefined) this.meetings.updateAction(t.sourceId, { due: n.due === 'none' ? '' : n.due });
      if (patch.title !== undefined && n.title) this.meetings.updateAction(t.sourceId, { text: n.title });
    } else if (t.source === 'case' && patch.due !== undefined) {
      const c = this.assistant.get(t.sourceId);
      const i = c.analysis.plan.findIndex((s) => !s.done && hash(s.step) === key.split(':')[2]);
      if (i >= 0) this.assistant.update(t.sourceId, { step: { index: i, due: n.due === 'none' ? '' : n.due } });
    }
    this.db.run('INSERT INTO task_edits(key,title,due,priority,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET title=excluded.title, due=excluded.due, priority=excluded.priority, updated_at=excluded.updated_at',
      [key, n.title, n.due, n.priority, now()]);
    this.setState(key, { seen: 1 });
    this.log(t, 'edit');
    return this.find(key);
  }

  /** The open task that best matches some words (for "completed the Omni battle card" in the chat). */
  match(text) {
    const words = (s) => new Set((String(s).toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOP.has(w)));
    const want = words(text);
    if (!want.size) return [];
    return this.all().map((t) => {
      const have = words(`${t.title} ${t.context || ''}`);
      let hit = 0;
      for (const w of want) if (have.has(w) || [...have].some((h) => h.length > 4 && w.length > 4 && (h.startsWith(w) || w.startsWith(h)))) hit += 1;
      return { t, m: hit / want.size };
    }).filter((x) => x.m > 0).sort((a, b) => b.m - a.m || b.t.score - a.t.score);
  }

  /**
   * What to work on which day: the next five working days, about five tasks a day. Overdue and due-today work
   * goes first, dated work lands on or before its date, and undated work fills the free slots by priority.
   */
  week({ at = today(), days = 5, perDay = 5 } = {}) {
    const dates = [];
    for (let d = at; dates.length < days; d = addDays(d, 1)) { const wd = new Date(`${d}T12:00:00Z`).getUTCDay(); if (wd !== 0 && wd !== 6) dates.push(d); }
    if (!dates.includes(at)) dates.unshift(at);
    const slots = Object.fromEntries(dates.map((d) => [d, []]));
    const mine = this.all({ at }).filter((t) => t.mine);
    const dated = mine.filter((t) => t.due).sort((a, b) => a.due.localeCompare(b.due) || b.score - a.score);
    const undated = mine.filter((t) => !t.due);
    const later = [];
    for (const t of dated) {
      if (t.due <= dates[0]) { slots[dates[0]].push(t); continue; }
      let day = [...dates].reverse().find((d) => d <= t.due);
      if (!day) { later.push(t); continue; }
      // A full day moves work earlier, never later than its date.
      while (slots[day].length >= perDay && dates.indexOf(day) > 0) day = dates[dates.indexOf(day) - 1];
      if (t.due > dates[dates.length - 1]) { later.push(t); continue; }
      slots[day].push(t);
    }
    for (const t of undated) {
      const day = dates.find((d) => slots[d].length < perDay);
      if (day) slots[day].push(t); else later.push(t);
    }
    return { days: dates.map((d) => ({ date: d, tasks: slots[d].sort((a, b) => b.score - a.score), load: slots[d].length, over: slots[d].length > perDay })), later, perDay };
  }

  snooze(key, until) {
    const t = this.find(key);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(until || '')) ? until : addDays(today(), 1);
    this.setState(key, { state: '', snooze_until: d, seen: 1 });
    this.log(t, 'snooze');
    return d;
  }

  dismiss(key) {
    const t = this.find(key);
    this.setState(key, { state: 'dismissed', snooze_until: null, seen: 1 });
    this.log(t, 'dismiss');
    return true;
  }

  /** Put a task that was ticked off by mistake back on the list. */
  reopen(key) {
    const [src, id, h] = key.split(':');
    if (src === 'case') {
      const c = this.assistant.get(id);
      const i = ((c.analysis && c.analysis.plan) || []).findIndex((s) => s.done && hash(s.step) === h);
      if (i >= 0) this.assistant.update(id, { step: { index: i, done: false } });
    } else if (src === 'meeting' || src === 'ma') this.meetings.updateAction(id, { done: false });
    else if (src === 'own') this.db.run('UPDATE own_tasks SET done=0, done_at=NULL WHERE id=?', [id]);
    return this.restore(key);
  }

  /** Bring a snoozed or dismissed task back. */
  restore(key) {
    this.setState(key, { state: '', snooze_until: null });
    this.db.run('INSERT INTO task_events(ts,key,action,source,who,subject) VALUES(?,?,?,?,?,?)', [now(), key, 'restore', key.split(':')[0], '', '']);
    return true;
  }

  seen(keys = []) { for (const k of keys) this.setState(k, { seen: 1 }); return true; }

  add({ title, due, who, priority, note } = {}) {
    const t = String(title || '').trim();
    if (!t) throw new Error('Write the task first');
    const id = uid('ot');
    this.db.run('INSERT INTO own_tasks(id,title,due,who,priority,note,done,created_at) VALUES(?,?,?,?,?,?,0,?)',
      [id, t.slice(0, 500), /^\d{4}-\d{2}-\d{2}$/.test(String(due || '')) ? due : null, String(who || '').slice(0, 120), PRI_POINTS[priority] != null ? priority : 'normal', String(note || '').slice(0, 500), now()]);
    return `own:${id}`;
  }

  /** The morning briefing: what to do first and why, what is late, who I'm waiting on, today's meetings and what came in. */
  briefing({ at = today() } = {}) {
    const l = this.list({ at });
    const meetings = this.meetings.list({ from: at, to: at }).filter((m) => m.status !== 'cancelled').map((m) => ({ id: m.id, title: m.title, time: m.time || '', customer: m.customer || '', kind: m.kind }));
    const since = addDays(at, -1);
    const cases = this.db.all('SELECT id, title, priority, sender, analysis, created_at FROM assistant_cases WHERE created_at>=? ORDER BY created_at DESC LIMIT 20', [since]);
    const questions = this.db.all("SELECT id, title, analysis FROM assistant_cases WHERE status<>'done'").map((r) => ({ id: r.id, title: r.title, n: ((parseJson(r.analysis, {}) || {}).questions || []).filter((q) => !q.answer).length })).filter((x) => x.n);
    const waitingLate = l.waiting.filter((t) => t.due && t.due <= at);
    const top = l.mine.slice(0, 5);
    const parts = [];
    if (l.counts.overdue) parts.push(`${l.counts.overdue} overdue`);
    if (l.counts.today) parts.push(`${l.counts.today} due today`);
    if (meetings.length) parts.push(`${meetings.length} ${meetings.length === 1 ? 'meeting' : 'meetings'}`);
    if (waitingLate.length) parts.push(`${waitingLate.length} ${waitingLate.length === 1 ? 'follow-up' : 'follow-ups'} to chase`);
    const headline = parts.length ? parts.join(', ') : l.mine.length ? `Nothing urgent. ${l.mine.length} open ${l.mine.length === 1 ? 'task' : 'tasks'} on your list.` : 'Your list is clear.';
    return {
      date: at, headline, top, counts: l.counts, meetings,
      waiting: [...waitingLate, ...l.waiting.filter((t) => !(t.due && t.due <= at))].slice(0, 5),
      newCases: cases.map((r) => ({ id: r.id, title: r.title, sender: r.sender || '', priority: r.priority, summary: ((parseJson(r.analysis, {}) || {}).summary || '').slice(0, 200) })),
      questions,
    };
  }

  /** The briefing as plain text, for a chat message or a desktop notification. */
  briefingText(b, hour = new Date().getHours()) {
    const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const lines = [`${hello}. ${b.headline}.`.replace('..', '.')];
    if (b.top.length) { lines.push('', 'Do first:'); for (const t of b.top) lines.push(`- ${t.title}${t.reason ? ` (${t.reason})` : ''}`); }
    if (b.meetings.length) { lines.push('', 'Meetings today:'); for (const m of b.meetings) lines.push(`- ${m.time ? `${m.time} ` : ''}${m.title}${m.customer ? ` with ${m.customer}` : ''}`); }
    if (b.waiting.length) { lines.push('', 'Waiting on others:'); for (const t of b.waiting.slice(0, 3)) lines.push(`- ${t.who}: ${t.title}${t.due ? ` (due ${niceDate(t.due)})` : ''}`); }
    if (b.questions.length) lines.push('', `The assistant has ${b.questions.reduce((n, q) => n + q.n, 0)} open questions for you.`);
    return lines.join('\n');
  }
}

module.exports = { Tasks, score, hash };
