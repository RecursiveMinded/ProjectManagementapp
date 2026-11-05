'use strict';
// Customer calls and meetings: when, who (team members and outside contacts),
// which customer and item they are about, an agenda, notes and a recap, files,
// and action items with an owner and due date that can be added to a board.
// A recurring meeting is a series; each meeting in it keeps its own notes,
// recap, files and actions.

const fs = require('fs');
const path = require('path');
const C = require('./columns');
const { uid, now, today, addDays, parseJson } = require('./util');
const { nextAfter, describe } = require('./recurring');

const KINDS = ['call', 'meeting'];
const STATUSES = ['planned', 'held', 'cancelled'];
const AHEAD_DAYS = 60;
const MAX_AHEAD = 12;

const cleanTime = (t) => (/^\d{1,2}:\d{2}$/.test(String(t || '')) ? String(t).padStart(5, '0') : '09:00');
const cleanDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '').slice(0, 10)) ? String(d).slice(0, 10) : today());
const cleanContacts = (list) => (Array.isArray(list) ? list : []).map((c) => ({
  name: String((c && c.name) || '').trim().slice(0, 120), email: String((c && c.email) || '').trim().slice(0, 160),
  phone: String((c && c.phone) || '').trim().slice(0, 60), company: String((c && c.company) || '').trim().slice(0, 120),
})).filter((c) => c.name || c.email || c.phone);
const cleanIds = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter(Boolean))];
const cleanHtml = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/javascript:/gi, '').slice(0, 400000);
const textOf = (h) => String(h || '').replace(/<br\s*\/?>|<\/(p|li|h\d|div)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();

function cleanRule(rule) {
  const r = rule || {};
  const unit = ['day', 'week', 'month'].includes(r.unit) ? r.unit : 'week';
  const every = Math.max(1, Math.min(52, Number(r.every) || 1));
  const weekdays = unit === 'week' ? cleanIds(r.weekdays).map(Number).filter((d) => d >= 1 && d <= 7).sort() : [];
  const until = /^\d{4}-\d{2}-\d{2}$/.test(String(r.until || '')) ? r.until : null;
  return { unit, every, weekdays, until };
}

class Meetings {
  constructor(store) { this.store = store; this.db = store.db; }

  row(id) {
    const m = this.db.get('SELECT * FROM meetings WHERE id=?', [id]);
    if (!m) throw new Error('That meeting no longer exists');
    return m;
  }

  shape(m, { full = false } = {}) {
    const actions = this.db.all('SELECT * FROM meeting_actions WHERE meeting_id=? ORDER BY position, created_at', [m.id]).map((a) => this.shapeAction(a));
    const item = m.item_id ? this.db.get('SELECT i.id, i.name, i.board_id, b.name AS board_name FROM items i JOIN boards b ON b.id=i.board_id WHERE i.id=?', [m.item_id]) : null;
    const series = m.series_id ? this.db.get('SELECT * FROM meeting_series WHERE id=?', [m.series_id]) : null;
    const out = {
      id: m.id, seriesId: m.series_id || null, title: m.title, kind: m.kind, date: m.date, time: m.time, minutes: m.minutes, where: m.where_text,
      customer: m.customer, status: m.status, attendees: parseJson(m.attendees, []), contacts: parseJson(m.contacts, []),
      item: item ? { id: item.id, name: item.name, boardId: item.board_id, boardName: item.board_name } : null,
      repeat: series ? describe(parseJson(series.rule, {})) : null,
      hasNotes: !!textOf(m.notes), hasRecap: !!textOf(m.recap), hasAgenda: !!textOf(m.agenda),
      actions, open: actions.filter((a) => !a.done).length,
      next: actions.filter((a) => !a.done).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'))[0] || null,
      updatedAt: m.updated_at,
    };
    if (full) {
      Object.assign(out, { agenda: m.agenda, notes: m.notes, recap: m.recap, files: this.db.all('SELECT * FROM files WHERE meeting_id=? ORDER BY added_at DESC', [m.id]) });
      if (series) out.series = { id: series.id, rule: parseJson(series.rule, {}), until: parseJson(series.rule, {}).until || null };
    }
    return out;
  }

  /** An action item, with the board item it was added to (and that item's done state). */
  shapeAction(a) {
    let item = null;
    let done = !!a.done;
    if (a.item_id) {
      const it = this.db.get('SELECT i.id, i.name, i.board_id, i.data, b.name AS board_name FROM items i JOIN boards b ON b.id=i.board_id WHERE i.id=?', [a.item_id]);
      if (it) {
        const data = parseJson(it.data, {});
        const statusCols = this.db.all("SELECT * FROM columns WHERE board_id=? AND type='status' AND scope='item'", [it.board_id]).map((c) => ({ ...c, settings: parseJson(c.settings, {}) }));
        const l = statusCols.length ? C.labelOf(statusCols[0], data[statusCols[0].id]) : null;
        item = { id: it.id, name: it.name, boardId: it.board_id, boardName: it.board_name, status: l ? l.label : '', statusColor: l ? l.color : '' };
        if (l && l.done) done = true;
      }
    }
    return { id: a.id, meetingId: a.meeting_id, text: a.text, owner: a.owner || null, team: a.team || null, due: a.due || null, done, item };
  }

  list({ from, to, customer, itemId, q, status } = {}) {
    const where = [];
    const args = [];
    if (from) { where.push('date>=?'); args.push(from); }
    if (to) { where.push('date<=?'); args.push(to); }
    if (customer) { where.push('LOWER(customer)=?'); args.push(String(customer).toLowerCase()); }
    if (itemId) { where.push('item_id=?'); args.push(itemId); }
    if (status) { where.push('status=?'); args.push(status); }
    if (q) {
      const like = `%${String(q).toLowerCase().replace(/[%_]/g, '')}%`;
      where.push('(LOWER(title) LIKE ? OR LOWER(customer) LIKE ? OR LOWER(notes) LIKE ? OR LOWER(recap) LIKE ? OR LOWER(agenda) LIKE ? OR LOWER(contacts) LIKE ?)');
      args.push(like, like, like, like, like, like);
    }
    return this.db.all(`SELECT * FROM meetings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY date, time`, args).map((m) => this.shape(m));
  }

  get(id) { return this.shape(this.row(id), { full: true }); }

  customers() {
    return this.db.all("SELECT customer, COUNT(*) AS n, MAX(date) AS last FROM meetings WHERE customer<>'' GROUP BY LOWER(customer) ORDER BY last DESC").map((r) => ({ name: r.customer, meetings: r.n, last: r.last }));
  }

  fields(m, cur = {}) {
    const has = (k) => m[k] !== undefined;
    return {
      title: has('title') ? (String(m.title || '').trim() || (cur.title || 'Call')) : cur.title || 'Call',
      kind: has('kind') ? (KINDS.includes(m.kind) ? m.kind : 'call') : cur.kind || 'call',
      date: has('date') ? cleanDate(m.date) : cur.date || today(),
      time: has('time') ? cleanTime(m.time) : cur.time || '09:00',
      minutes: has('minutes') ? Math.max(5, Math.min(1440, Number(m.minutes) || 30)) : cur.minutes || 30,
      where_text: has('where') ? String(m.where || '').trim().slice(0, 300) : cur.where_text || '',
      customer: has('customer') ? String(m.customer || '').trim().slice(0, 160) : cur.customer || '',
      status: has('status') ? (STATUSES.includes(m.status) ? m.status : 'planned') : cur.status || 'planned',
      attendees: has('attendees') ? JSON.stringify(cleanIds(m.attendees)) : cur.attendees || '[]',
      contacts: has('contacts') ? JSON.stringify(cleanContacts(m.contacts)) : cur.contacts || '[]',
      item_id: has('itemId') ? (m.itemId && this.db.get('SELECT id FROM items WHERE id=?', [m.itemId]) ? m.itemId : null) : cur.item_id || null,
      agenda: has('agenda') ? cleanHtml(m.agenda) : cur.agenda || '',
      notes: has('notes') ? cleanHtml(m.notes) : cur.notes || '',
      recap: has('recap') ? cleanHtml(m.recap) : cur.recap || '',
    };
  }

  insert(f, seriesId = null) {
    const id = uid('m');
    const t = now();
    this.db.run(`INSERT INTO meetings(id,series_id,title,kind,date,time,minutes,where_text,customer,status,attendees,contacts,item_id,agenda,notes,recap,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, seriesId, f.title, f.kind, f.date, f.time, f.minutes, f.where_text, f.customer, f.status, f.attendees, f.contacts, f.item_id, f.agenda, f.notes, f.recap, t, t]);
    return id;
  }

  /** Create a call or meeting. With `repeat`, it starts a series and the next meetings are scheduled. */
  create(m = {}) {
    return this.db.tx(() => {
      const f = this.fields(m);
      if (m.repeat) {
        const rule = cleanRule(m.repeat);
        const sid = uid('ms');
        const tpl = { ...f, notes: '', recap: '', status: 'planned' };
        this.db.run('INSERT INTO meeting_series(id,rule,template,anchor,last_date,created_at) VALUES(?,?,?,?,?,?)', [sid, JSON.stringify(rule), JSON.stringify(tpl), f.date, f.date, now()]);
        const id = this.insert(f, sid);
        this.extend(sid);
        return id;
      }
      return this.insert(f);
    });
  }

  update(id, patch = {}) {
    const cur = this.row(id);
    const f = this.fields(patch, cur);
    this.db.run(`UPDATE meetings SET title=?,kind=?,date=?,time=?,minutes=?,where_text=?,customer=?,status=?,attendees=?,contacts=?,item_id=?,agenda=?,notes=?,recap=?,updated_at=? WHERE id=?`,
      [f.title, f.kind, f.date, f.time, f.minutes, f.where_text, f.customer, f.status, f.attendees, f.contacts, f.item_id, f.agenda, f.notes, f.recap, now(), id]);
    return this.get(id);
  }

  /**
   * Copy this meeting's set-up (title, time, people, customer, agenda) to the
   * series, and to later meetings in it that have no notes or recap yet.
   */
  applyToSeries(id) {
    const m = this.row(id);
    if (!m.series_id) throw new Error('This meeting does not repeat');
    return this.db.tx(() => {
      const s = this.db.get('SELECT * FROM meeting_series WHERE id=?', [m.series_id]);
      const tpl = { ...parseJson(s.template, {}), title: m.title, kind: m.kind, time: m.time, minutes: m.minutes, where_text: m.where_text, customer: m.customer, attendees: m.attendees, contacts: m.contacts, item_id: m.item_id, agenda: m.agenda };
      this.db.run('UPDATE meeting_series SET template=? WHERE id=?', [JSON.stringify(tpl), s.id]);
      const later = this.db.all("SELECT id FROM meetings WHERE series_id=? AND date>? AND status='planned' AND notes='' AND recap=''", [s.id, m.date]);
      for (const l of later) {
        this.db.run('UPDATE meetings SET title=?,kind=?,time=?,minutes=?,where_text=?,customer=?,attendees=?,contacts=?,item_id=?,agenda=?,updated_at=? WHERE id=?',
          [tpl.title, tpl.kind, tpl.time, tpl.minutes, tpl.where_text, tpl.customer, tpl.attendees, tpl.contacts, tpl.item_id, tpl.agenda, now(), l.id]);
      }
      return later.length;
    });
  }

  /** Change how a series repeats. Later empty meetings are rebuilt on the new schedule. */
  setRepeat(id, rule) {
    const m = this.row(id);
    return this.db.tx(() => {
      const r = cleanRule(rule);
      let sid = m.series_id;
      if (!sid) {
        sid = uid('ms');
        const tpl = { ...this.fields({}, m), notes: '', recap: '', status: 'planned' };
        this.db.run('INSERT INTO meeting_series(id,rule,template,anchor,last_date,created_at) VALUES(?,?,?,?,?,?)', [sid, JSON.stringify(r), JSON.stringify(tpl), m.date, m.date, now()]);
        this.db.run('UPDATE meetings SET series_id=? WHERE id=?', [sid, id]);
      } else {
        this.dropEmptyAfter(sid, m.date);
        this.db.run('UPDATE meeting_series SET rule=?, anchor=?, last_date=? WHERE id=?', [JSON.stringify(r), m.date, m.date, sid]);
      }
      this.extend(sid);
      return sid;
    });
  }

  /** Stop a series repeating after this meeting. Meetings with notes are kept. */
  stopRepeat(id) {
    const m = this.row(id);
    if (!m.series_id) return 0;
    return this.db.tx(() => {
      const n = this.dropEmptyAfter(m.series_id, m.date);
      const s = this.db.get('SELECT * FROM meeting_series WHERE id=?', [m.series_id]);
      const rule = { ...parseJson(s.rule, {}), until: m.date };
      this.db.run('UPDATE meeting_series SET rule=? WHERE id=?', [JSON.stringify(rule), s.id]);
      return n;
    });
  }

  dropEmptyAfter(sid, date) {
    const rows = this.db.all("SELECT m.id FROM meetings m WHERE series_id=? AND date>? AND notes='' AND recap='' AND status='planned' AND NOT EXISTS (SELECT 1 FROM meeting_actions a WHERE a.meeting_id=m.id) AND NOT EXISTS (SELECT 1 FROM files f WHERE f.meeting_id=m.id)", [sid, date]);
    for (const r of rows) this.db.run('DELETE FROM meetings WHERE id=?', [r.id]);
    const last = this.db.get('SELECT MAX(date) AS d FROM meetings WHERE series_id=?', [sid]);
    this.db.run('UPDATE meeting_series SET last_date=? WHERE id=?', [(last && last.d) || date, sid]);
    return rows.length;
  }

  /** Schedule a series' meetings up to AHEAD_DAYS from today (always at least the next one). */
  extend(sid, at = new Date()) {
    const s = this.db.get('SELECT * FROM meeting_series WHERE id=?', [sid]);
    if (!s) return 0;
    const rule = parseJson(s.rule, {});
    const tpl = parseJson(s.template, {});
    const horizon = addDays(today(at), AHEAD_DAYS);
    let last = s.last_date || s.anchor;
    let made = 0;
    const future = () => this.db.get('SELECT COUNT(*) AS n FROM meetings WHERE series_id=? AND date>=?', [sid, today(at)]).n;
    for (let guard = 0; guard < 400 && made < MAX_AHEAD; guard++) {
      const next = nextAfter(rule, last, s.anchor);
      if (rule.until && next > rule.until) break;
      if (next > horizon && future() > 0) break;
      this.insert({ ...tpl, date: next, status: 'planned', notes: '', recap: '' }, sid);
      last = next;
      made++;
    }
    this.db.run('UPDATE meeting_series SET last_date=? WHERE id=?', [last, sid]);
    return made;
  }

  tick(at = new Date()) {
    let made = 0;
    for (const s of this.db.all('SELECT id FROM meeting_series')) made += this.extend(s.id, at);
    return made;
  }

  /** Delete a meeting, or with `series`, this one and every later meeting in its series. */
  remove(id, { series = false } = {}) {
    const m = this.row(id);
    return this.db.tx(() => {
      const ids = series && m.series_id ? this.db.all('SELECT id FROM meetings WHERE series_id=? AND date>=?', [m.series_id, m.date]).map((r) => r.id) : [id];
      for (const x of ids) {
        for (const f of this.db.all('SELECT * FROM files WHERE meeting_id=?', [x])) { this.db.run('DELETE FROM files WHERE id=?', [f.id]); this.store.unlinkFile(f); }
        this.db.run('DELETE FROM meeting_actions WHERE meeting_id=?', [x]);
        this.db.run('DELETE FROM meetings WHERE id=?', [x]);
      }
      if (series && m.series_id) {
        const rule = { ...parseJson((this.db.get('SELECT rule FROM meeting_series WHERE id=?', [m.series_id]) || {}).rule, {}), until: addDays(m.date, -1) };
        this.db.run('UPDATE meeting_series SET rule=? WHERE id=?', [JSON.stringify(rule), m.series_id]);
        if (!this.db.get('SELECT id FROM meetings WHERE series_id=?', [m.series_id])) this.db.run('DELETE FROM meeting_series WHERE id=?', [m.series_id]);
      }
      return ids.length;
    });
  }

  // --------------------------------------------------------------- actions
  addAction(meetingId, a = {}) {
    this.row(meetingId);
    const text = String(a.text || '').trim();
    if (!text) throw new Error('Write the action first');
    const id = uid('ma');
    const pos = (this.db.get('SELECT MAX(position) AS p FROM meeting_actions WHERE meeting_id=?', [meetingId]).p || 0) + 1;
    this.db.run('INSERT INTO meeting_actions(id,meeting_id,text,owner,team,due,done,item_id,position,created_at) VALUES(?,?,?,?,?,?,0,NULL,?,?)',
      [id, meetingId, text.slice(0, 500), a.owner || null, a.team || null, /^\d{4}-\d{2}-\d{2}$/.test(String(a.due || '')) ? a.due : null, pos, now()]);
    if (a.boardId) this.actionToItem(id, { boardId: a.boardId, groupId: a.groupId });
    return id;
  }

  updateAction(id, patch = {}) {
    const a = this.db.get('SELECT * FROM meeting_actions WHERE id=?', [id]);
    if (!a) throw new Error('That action no longer exists');
    const next = {
      text: patch.text !== undefined ? String(patch.text || '').trim().slice(0, 500) || a.text : a.text,
      owner: patch.owner !== undefined ? patch.owner || null : a.owner,
      team: patch.team !== undefined ? patch.team || null : a.team,
      due: patch.due !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(String(patch.due || '')) ? patch.due : null) : a.due,
      done: patch.done !== undefined ? (patch.done ? 1 : 0) : a.done,
    };
    this.db.tx(() => {
      this.db.run('UPDATE meeting_actions SET text=?, owner=?, team=?, due=?, done=? WHERE id=?', [next.text, next.owner, next.team, next.due, next.done, id]);
      if (a.item_id && this.db.get('SELECT id FROM items WHERE id=?', [a.item_id])) this.syncItem(a.item_id, next, patch);
    });
    return this.shapeAction(this.db.get('SELECT * FROM meeting_actions WHERE id=?', [id]));
  }

  removeAction(id) { this.db.run('DELETE FROM meeting_actions WHERE id=?', [id]); }

  /** Columns of a board used for an action's owner, team, due date and status. */
  slots(boardId) {
    const cols = this.db.all("SELECT * FROM columns WHERE board_id=? AND scope='item' ORDER BY position", [boardId]).map((c) => ({ ...c, settings: parseJson(c.settings, {}) }));
    return {
      people: cols.find((c) => c.type === 'people'),
      team: cols.find((c) => c.type === 'team'),
      date: cols.find((c) => c.type === 'date') || cols.find((c) => c.type === 'timeline'),
      status: cols.find((c) => c.type === 'status'),
    };
  }

  syncItem(itemId, a, patch) {
    const it = this.store.itemRow(itemId);
    const s = this.slots(it.board_id);
    if (patch.text !== undefined) this.store.renameItem(itemId, a.text);
    if (patch.owner !== undefined && s.people) this.store.setValue(itemId, s.people.id, a.owner ? [a.owner] : []);
    if (patch.team !== undefined && s.team) this.store.setValue(itemId, s.team.id, a.team ? [a.team] : []);
    if (patch.due !== undefined && s.date) this.store.setValue(itemId, s.date.id, a.due ? (s.date.type === 'timeline' ? { start: a.due, end: a.due } : a.due) : null);
    if (patch.done !== undefined && s.status) {
      const labels = (s.status.settings.labels || []);
      const done = labels.find((l) => l.done);
      if (a.done && done) this.store.setValue(itemId, s.status.id, done.id);
    }
  }

  /** Add an action to a board as an item, with its owner, team and due date set. */
  actionToItem(id, { boardId, groupId } = {}) {
    const a = this.db.get('SELECT * FROM meeting_actions WHERE id=?', [id]);
    if (!a) throw new Error('That action no longer exists');
    if (a.item_id && this.db.get('SELECT id FROM items WHERE id=?', [a.item_id])) return a.item_id;
    const m = this.row(a.meeting_id);
    const s = this.slots(boardId);
    const values = {};
    if (s.people && a.owner) values[s.people.id] = [a.owner];
    if (s.team && a.team) values[s.team.id] = [a.team];
    if (s.date && a.due) values[s.date.id] = s.date.type === 'timeline' ? { start: a.due, end: a.due } : a.due;
    return this.db.tx(() => {
      const itemId = this.store.addItem(boardId, { groupId, name: a.text, values, source: 'meeting' });
      this.db.run('UPDATE meeting_actions SET item_id=? WHERE id=?', [itemId, id]);
      const who = m.customer ? ` with ${m.customer}` : '';
      try { this.store.postUpdate(itemId, `Action from “${m.title}”${who} on ${m.date}.`); } catch (_) { /* updates are a nicety */ }
      return itemId;
    });
  }

  /** Open actions across meetings, soonest due first; `mine` limits them to me. */
  actions({ mine = false, includeDone = false, owner } = {}) {
    const me = this.store.me().id;
    const who = owner || (mine ? me : null);
    const rows = this.db.all(`SELECT a.*, m.title AS m_title, m.date AS m_date, m.customer AS m_customer FROM meeting_actions a JOIN meetings m ON m.id=a.meeting_id
      ${who ? 'WHERE a.owner=?' : ''} ORDER BY COALESCE(a.due,'9999'), a.created_at`, who ? [who] : []);
    return rows.map((r) => ({ ...this.shapeAction(r), meeting: { id: r.meeting_id, title: r.m_title, date: r.m_date, customer: r.m_customer } })).filter((a) => includeDone || !a.done);
  }

  /** The next open action and the next and last calls about an item, for its panel. */
  forItem(itemId) {
    const meetings = this.list({ itemId });
    const t = today();
    const viaAction = this.db.all('SELECT DISTINCT meeting_id FROM meeting_actions WHERE item_id=?', [itemId]).map((r) => r.meeting_id);
    const extra = viaAction.filter((id) => !meetings.some((m) => m.id === id)).map((id) => { try { return this.shape(this.row(id)); } catch (_) { return null; } }).filter(Boolean);
    const all = [...meetings, ...extra].sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
    const open = all.flatMap((m) => m.actions.filter((a) => !a.done).map((a) => ({ ...a, meeting: { id: m.id, title: m.title, date: m.date } })));
    open.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    return {
      meetings: all,
      next: all.find((m) => m.date >= t && m.status === 'planned') || null,
      last: [...all].reverse().find((m) => m.date < t || m.status === 'held') || null,
      nextAction: open[0] || null,
      openActions: open,
    };
  }

  /** For each item on a board that calls are about: its next open action (soonest due). */
  nextByItem(boardId) {
    const rows = this.db.all(`SELECT a.*, m.item_id AS about, m.title AS m_title, m.date AS m_date FROM meeting_actions a JOIN meetings m ON m.id=a.meeting_id
      JOIN items i ON i.id=m.item_id WHERE i.board_id=? ORDER BY COALESCE(a.due,'9999'), a.created_at`, [boardId]);
    const out = {};
    for (const r of rows) {
      if (out[r.about]) continue;
      const a = this.shapeAction(r);
      if (!a.done) out[r.about] = { ...a, meeting: { id: r.meeting_id, title: r.m_title, date: r.m_date } };
    }
    return out;
  }

  // ----------------------------------------------------------------- files
  addFile(meetingId, { name, bytes }) {
    if (!this.store.filesDir) throw new Error('Files are not available here');
    this.row(meetingId);
    const id = uid('f');
    const safe = String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(-120);
    const dir = path.join(this.store.filesDir, 'meetings');
    fs.mkdirSync(dir, { recursive: true });
    const stored = path.join(dir, `${id}-${safe}`);
    fs.writeFileSync(stored, Buffer.from(bytes));
    this.db.run('INSERT INTO files(id,item_id,meeting_id,column_id,name,stored_path,size,added_by,added_at) VALUES(?,NULL,?,?,?,?,?,?,?)',
      [id, meetingId, '', safe, path.relative(this.store.filesDir, stored), bytes.length, this.store.me().id, now()]);
    return id;
  }

  /** The meeting as plain text, to paste into an email or a ticket. */
  summary(id) {
    const m = this.get(id);
    const people = this.store.people();
    const name = (pid) => (people.find((p) => p.id === pid) || {}).name || '';
    const lines = [`${m.title}${m.customer ? ` with ${m.customer}` : ''}`, `${m.date} ${m.time} (${m.minutes} min)${m.where ? ` · ${m.where}` : ''}`];
    const who = [...m.attendees.map(name).filter(Boolean), ...m.contacts.map((c) => (c.company ? `${c.name} (${c.company})` : c.name))];
    if (who.length) lines.push(`Attendees: ${who.join(', ')}`);
    for (const [k, label] of [['agenda', 'Agenda'], ['notes', 'Notes'], ['recap', 'Recap']]) {
      const t = textOf(m[k]);
      if (t) lines.push('', `${label}:`, t);
    }
    if (m.actions.length) {
      lines.push('', 'Action items:');
      for (const a of m.actions) lines.push(`- [${a.done ? 'x' : ' '}] ${a.text}${a.owner ? ` (${name(a.owner)})` : ''}${a.due ? `, due ${a.due}` : ''}`);
    }
    return lines.join('\n');
  }
}

module.exports = { Meetings, cleanRule, textOf };
