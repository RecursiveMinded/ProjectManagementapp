'use strict';
// Cross-board reports: the portfolio of boards, and timesheets built from
// Time tracking columns.

const C = require('./columns');
const { today, addDays, parseJson } = require('./util');

const HEALTH = ['on_track', 'at_risk', 'off_track', 'done'];

/** A local calendar date (YYYY-MM-DD) for an ISO timestamp. */
function localDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class Reports {
  constructor(store) { this.store = store; this.db = store.db; }

  /** One row per active board: progress, dates, overdue and blocked counts, health. */
  portfolio() {
    const t = today();
    const people = this.store.peopleMap();
    const boards = this.db.all('SELECT b.id, b.name, b.folder, b.workspace_id, b.settings, b.updated_at, w.name AS ws FROM boards b LEFT JOIN workspaces w ON w.id=b.workspace_id WHERE b.archived=0 ORDER BY w.position, b.position, b.name');
    return boards.map((row) => {
      const B = this.store.getBoard(row.id);
      const cols = B.columns.filter((c) => c.scope === 'item');
      const sc = cols.find((c) => c.type === 'status');
      const dc = cols.find((c) => c.type === 'timeline') || cols.find((c) => c.type === 'date');
      const pc = cols.find((c) => c.type === 'people');
      let done = 0, overdue = 0, blocked = 0, start = null, end = null;
      const load = {};
      for (const it of B.items) {
        const l = sc && C.labelOf(sc, it.values[sc.id]);
        const isDone = !!(l && l.done);
        if (isDone) done++;
        if (l && (l.id === 'stuck' || /block|stuck/i.test(l.label))) blocked++;
        if (dc) {
          const v = it.values[dc.id];
          const s = dc.type === 'timeline' ? v && v.start : v && String(v).slice(0, 10);
          const e = dc.type === 'timeline' ? v && (v.end || v.start) : s;
          if (s && (!start || s < start)) start = s;
          if (e && (!end || e > end)) end = e;
          if (e && e < t && !isDone) overdue++;
        }
        if (pc && !isDone) for (const p of it.values[pc.id] || []) load[p] = (load[p] || 0) + 1;
      }
      const total = B.items.length;
      const progress = total ? Math.round((done / total) * 100) : 0;
      let auto = 'on_track';
      if (total && done === total) auto = 'done';
      else if (end && end < t) auto = 'off_track';
      else if (overdue || blocked) auto = 'at_risk';
      const settings = parseJson(row.settings, {});
      const owner = settings.ownerId && people[settings.ownerId] ? settings.ownerId
        : Object.entries(load).sort((a, b) => b[1] - a[1]).map(([p]) => p).find((p) => people[p]) || null;
      return {
        id: row.id, name: row.name, workspace: row.ws || '', workspaceId: row.workspace_id, folder: row.folder || '',
        items: total, done, progress, overdue, blocked, start, end,
        health: HEALTH.includes(settings.health) ? settings.health : auto, autoHealth: auto, healthSet: HEALTH.includes(settings.health),
        ownerId: owner, ownerSet: !!settings.ownerId, note: settings.statusNote || '', updatedAt: row.updated_at,
      };
    });
  }

  /** Set (or clear with null) a board's health, owner or status note for the portfolio. */
  setPortfolio(boardId, { health, ownerId, note } = {}) {
    const b = this.store.boardRow(boardId);
    const s = { ...(b.settings || {}) };
    if (health !== undefined) { s.health = health && HEALTH.includes(health) ? health : null; }
    if (ownerId !== undefined) { s.ownerId = ownerId || null; }
    if (note !== undefined) s.statusNote = String(note || '').slice(0, 500);
    return this.store.updateBoard(boardId, { settings: s });
  }

  /** Time tracked between two dates, from every Time tracking column. */
  timesheet({ from, to, personId } = {}) {
    const f = from || addDays(today(), -6);
    const tt = to || today();
    const cols = this.db.all("SELECT c.id, c.board_id, c.title, b.name AS board_name FROM columns c JOIN boards b ON b.id=c.board_id WHERE c.type='time_tracking' AND b.archived=0");
    const entries = [];
    const items = [];
    for (const c of cols) {
      const rows = this.db.all("SELECT id, name, parent_id, data FROM items WHERE board_id=? AND archived=0 AND data LIKE ?", [c.board_id, `%${c.id}%`]);
      for (const r of rows) {
        const v = parseJson(r.data, {})[c.id];
        if (!v) continue;
        items.push({ itemId: r.parent_id || r.id, subId: r.parent_id ? r.id : null, name: r.name, boardId: c.board_id, boardName: c.board_name, columnId: c.id, running: !!v.since });
        const sessions = [...(v.sessions || [])];
        if (v.since) sessions.push({ start: v.since, end: new Date().toISOString(), by: null, running: true });
        sessions.forEach((s, i) => {
          if (!s.start || !s.end) return;
          const date = s.date || localDate(s.start);
          if (date < f || date > tt) return;
          if (personId && s.by && s.by !== personId) return;
          const seconds = s.seconds != null ? Number(s.seconds) : Math.max(0, Math.round((new Date(s.end) - new Date(s.start)) / 1000));
          entries.push({ key: `${r.id}:${c.id}:${i}`, index: i, itemId: r.parent_id || r.id, rowId: r.id, subId: r.parent_id ? r.id : null, name: r.name, boardId: c.board_id, boardName: c.board_name, columnId: c.id, personId: s.by || null, date, seconds, note: s.note || '', manual: !!s.manual, running: !!s.running });
        });
      }
    }
    entries.sort((a, b) => a.date.localeCompare(b.date) || a.boardName.localeCompare(b.boardName));
    return { from: f, to: tt, entries, items };
  }

  /** Items whose name matches, on boards that have a Time tracking column. */
  timeTargets(q) {
    const s = `%${String(q || '').trim().toLowerCase().replace(/[%_]/g, '')}%`;
    const out = [];
    for (const c of this.db.all("SELECT c.id, c.board_id, b.name AS board_name FROM columns c JOIN boards b ON b.id=c.board_id WHERE c.type='time_tracking' AND b.archived=0")) {
      for (const r of this.db.all('SELECT id, name FROM items WHERE board_id=? AND archived=0 AND LOWER(name) LIKE ? LIMIT 20', [c.board_id, s])) {
        out.push({ key: `${r.id}:${c.id}`, label: `${r.name} · ${c.board_name}` });
      }
    }
    return out.slice(0, 40);
  }

  /** Log time by hand: minutes on a date, optionally with a note. */
  addTime(itemId, columnId, { date, minutes, note = '', personId } = {}) {
    const mins = Math.round(Number(minutes));
    if (!(mins > 0) || mins > 24 * 60) throw new Error('Enter between 1 minute and 24 hours');
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? date : today();
    const it = this.store.itemRow(itemId);
    const col = this.store.colRow(columnId);
    if (col.type !== 'time_tracking') throw new Error('Not a time tracking column');
    const v = { total: 0, since: null, sessions: [], ...(it.data[columnId] || {}) };
    const start = new Date(`${d}T09:00:00`).toISOString();
    const end = new Date(new Date(start).getTime() + mins * 60000).toISOString();
    v.sessions = [...(v.sessions || []), { start, end, date: d, seconds: mins * 60, by: personId || this.store.me().id, manual: true, note: String(note).slice(0, 200) }].slice(-500);
    v.total = (Number(v.total) || 0) + mins * 60;
    this.store.setValue(itemId, columnId, v, { source: 'timer' });
    return v;
  }

  /** Remove one logged session and take its time off the total. */
  removeTime(itemId, columnId, index) {
    const it = this.store.itemRow(itemId);
    const v = { total: 0, since: null, sessions: [], ...(it.data[columnId] || {}) };
    const s = (v.sessions || [])[index];
    if (!s) throw new Error('That time entry no longer exists');
    const secs = s.seconds != null ? Number(s.seconds) : Math.max(0, Math.round((new Date(s.end) - new Date(s.start)) / 1000));
    v.sessions = v.sessions.filter((_, i) => i !== index);
    v.total = Math.max(0, (Number(v.total) || 0) - secs);
    this.store.setValue(itemId, columnId, v, { source: 'timer' });
    return v;
  }
}

module.exports = { Reports, localDate, HEALTH };
