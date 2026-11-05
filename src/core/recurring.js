'use strict';
// Recurring items: an item that repeats makes a fresh copy of itself on a
// schedule (every N days, weeks on chosen weekdays, or months), with its dates
// moved to the new day and its status, checkboxes and timers reset.
// Item templates: save an item (with subitems) and add copies of it later.

const C = require('./columns');
const { uid, now, today, addDays, parseJson } = require('./util');

const UNITS = ['day', 'week', 'month'];

function dow(iso) { return ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; } // 1 = Monday
function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

/** The first occurrence strictly after `from` that matches the rule. */
function nextAfter(rule, from, anchor) {
  const every = Math.max(1, Math.min(365, Number(rule.every) || 1));
  if (rule.unit === 'month') {
    let d = anchor || from;
    let guard = 0;
    while (d <= from && guard++ < 2000) d = addMonths(d, every);
    return d;
  }
  if (rule.unit === 'week') {
    const days = (rule.weekdays && rule.weekdays.length ? rule.weekdays : [dow(anchor || from)]).map(Number);
    const base = anchor || from;
    const baseMonday = addDays(base, -(dow(base) - 1));
    for (let i = 1; i <= 7 * every * 2 + 7; i++) {
      const d = addDays(from, i);
      const weeks = Math.floor((Date.parse(addDays(d, -(dow(d) - 1))) - Date.parse(baseMonday)) / (7 * 86400000));
      if (weeks % every === 0 && days.includes(dow(d))) return d;
    }
    return addDays(from, 7 * every);
  }
  let d = anchor || from;
  let guard = 0;
  while (d <= from && guard++ < 5000) d = addDays(d, every);
  return d;
}

function describe(rule) {
  const every = Number(rule.every) || 1;
  const unit = UNITS.includes(rule.unit) ? rule.unit : 'week';
  const names = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let s = every === 1 ? `Every ${unit}` : `Every ${every} ${unit}s`;
  if (unit === 'week' && rule.weekdays && rule.weekdays.length) s += ` on ${rule.weekdays.map((d) => names[d]).join(', ')}`;
  return s;
}

class Recurring {
  constructor(store) { this.store = store; this.db = store.db; }

  get(itemId) {
    const r = this.db.get('SELECT * FROM recurrences WHERE item_id=?', [itemId]);
    return r ? { ...r, rule: parseJson(r.rule, {}), text: describe(parseJson(r.rule, {})) } : null;
  }
  forBoard(boardId) {
    return Object.fromEntries(this.db.all('SELECT item_id, rule, next_date FROM recurrences WHERE board_id=?', [boardId])
      .map((r) => [r.item_id, { text: describe(parseJson(r.rule, {})), next: r.next_date }]));
  }
  /** Start (or change) repeating an item. rule: { every, unit, weekdays?, start?, groupId? } */
  set(itemId, rule = {}) {
    const it = this.store.itemRow(itemId);
    if (it.parent_id) throw new Error('Subitems cannot repeat; repeat the parent item');
    const unit = UNITS.includes(rule.unit) ? rule.unit : 'week';
    const clean = {
      every: Math.max(1, Math.min(365, Math.round(Number(rule.every) || 1))), unit,
      weekdays: unit === 'week' ? [...new Set((rule.weekdays || []).map(Number).filter((d) => d >= 1 && d <= 7))].sort() : [],
      groupId: rule.groupId || null,
    };
    const start = /^\d{4}-\d{2}-\d{2}$/.test(String(rule.start || '')) ? rule.start : null;
    const t = today();
    const anchor = start || t;
    const next = start && start >= t ? start : nextAfter(clean, t, anchor);
    clean.anchor = anchor;
    const existing = this.db.get('SELECT id FROM recurrences WHERE item_id=?', [itemId]);
    if (existing) this.db.run('UPDATE recurrences SET rule=?, next_date=? WHERE id=?', [JSON.stringify(clean), next, existing.id]);
    else this.db.run('INSERT INTO recurrences(id,item_id,board_id,rule,next_date,created_at) VALUES(?,?,?,?,?,?)', [uid('r'), itemId, it.board_id, JSON.stringify(clean), next, now()]);
    this.store.log({ boardId: it.board_id, itemId, action: 'recurrence_set', newValue: describe(clean) });
    return this.get(itemId);
  }
  clear(itemId) { this.db.run('DELETE FROM recurrences WHERE item_id=?', [itemId]); }

  /** Make the copies that are due. Returns how many were created. */
  tick(at = new Date()) {
    const day = today(at);
    let made = 0;
    for (const r of this.db.all('SELECT * FROM recurrences WHERE next_date<=?', [day])) {
      const it = this.db.get('SELECT id, archived FROM items WHERE id=?', [r.item_id]);
      if (!it) { this.db.run('DELETE FROM recurrences WHERE id=?', [r.id]); continue; }
      const rule = parseJson(r.rule, {});
      if (!it.archived) {
        try { this.occur(r.item_id, r.next_date, rule); made++; } catch (_) { /* board or group gone; skip this one */ }
      }
      // Only one copy for missed days; then move to the next date after today.
      const next = nextAfter(rule, day, rule.anchor || r.next_date);
      this.db.run('UPDATE recurrences SET next_date=?, last_date=? WHERE id=?', [next, r.next_date, r.id]);
    }
    return made;
  }

  /** Create one occurrence of a repeating item for `date`. */
  occur(itemId, date, rule = {}) {
    const src = this.store.itemRow(itemId);
    const groupId = rule.groupId && this.db.get('SELECT id FROM groups WHERE id=? AND board_id=?', [rule.groupId, src.board_id]) ? rule.groupId : src.group_id;
    const nid = this.store.duplicateItem(itemId, { groupId, keepName: true });
    const values = fresh(this.store.columns(src.board_id), src.data, date);
    this.store.setValues(nid, values, { source: 'recurring', noDeps: true });
    this.db.run('UPDATE items SET position=? WHERE id=?', [(this.db.get('SELECT MIN(position) AS p FROM items WHERE group_id=?', [groupId]).p || 1) - 1, nid]);
    for (const s of this.db.all('SELECT id, data FROM items WHERE parent_id=?', [nid])) {
      const sv = fresh(this.store.columns(src.board_id).filter((c) => c.scope === 'sub'), parseJson(s.data, {}), date);
      if (Object.keys(sv).length) this.store.setValues(s.id, sv, { source: 'recurring', noDeps: true });
    }
    return nid;
  }

  // ------------------------------------------------------- item templates
  itemTemplates(boardId) {
    return this.db.all('SELECT id, name, created_at FROM item_templates WHERE board_id=? ORDER BY name', [boardId]);
  }
  saveItemTemplate(itemId, name) {
    const it = this.store.itemRow(itemId);
    const subs = this.db.all('SELECT name, data FROM items WHERE parent_id=? AND archived=0 ORDER BY position', [itemId]).map((s) => ({ name: s.name, data: parseJson(s.data, {}) }));
    const cols = this.store.columns(it.board_id);
    const keep = (data, scope) => {
      const out = {};
      for (const c of cols.filter((x) => x.scope === scope)) if (data[c.id] != null && !C.isComputed(c.type) && !['files', 'time_tracking', 'doc', 'vote'].includes(c.type)) out[c.id] = data[c.id];
      return out;
    };
    const payload = { name: it.name, data: keep(it.data, 'item'), subitems: subs.map((s) => ({ name: s.name, data: keep(s.data, 'sub') })) };
    const id = uid('t');
    this.db.run('INSERT INTO item_templates(id,board_id,name,payload,created_at) VALUES(?,?,?,?,?)', [id, it.board_id, String(name || it.name).trim() || it.name, JSON.stringify(payload), now()]);
    return id;
  }
  deleteItemTemplate(id) { this.db.run('DELETE FROM item_templates WHERE id=?', [id]); }
  addFromTemplate(templateId, { groupId, name } = {}) {
    const t = this.db.get('SELECT * FROM item_templates WHERE id=?', [templateId]);
    if (!t) throw new Error('That item template no longer exists');
    const p = parseJson(t.payload, {});
    const cols = new Set(this.store.columns(t.board_id).map((c) => c.id));
    const only = (d) => Object.fromEntries(Object.entries(d || {}).filter(([k]) => cols.has(k)));
    const g = groupId || (this.db.get('SELECT id FROM groups WHERE board_id=? AND archived=0 ORDER BY position LIMIT 1', [t.board_id]) || {}).id;
    const id = this.store.addItem(t.board_id, { groupId: g, name: name || p.name, values: only(p.data), top: true, source: 'template' });
    for (const s of p.subitems || []) this.store.addItem(t.board_id, { parentId: id, name: s.name, values: only(s.data), source: 'template' });
    return id;
  }
}

/** Values for a new occurrence: dates moved to `date`, progress reset. */
function fresh(cols, data, date) {
  const out = {};
  const dateCols = cols.filter((c) => c.type === 'date' || c.type === 'timeline');
  // Keep the gap between date columns: anchor on the earliest date the item has.
  const firsts = dateCols.map((c) => { const v = data[c.id]; return c.type === 'timeline' ? v && v.start : v && String(v).slice(0, 10); }).filter(Boolean).sort();
  const base = firsts[0];
  const shift = (d) => (base ? addDays(date, Math.round((Date.parse(String(d).slice(0, 10)) - Date.parse(base)) / 86400000)) : date);
  for (const c of cols) {
    const v = data[c.id];
    if (c.type === 'date' && v) out[c.id] = shift(v) + (String(v).length > 10 ? String(v).slice(10) : '');
    else if (c.type === 'timeline' && v && v.start) out[c.id] = { start: shift(v.start), end: shift(v.end || v.start) };
    else if (c.type === 'status' && v != null) {
      const first = (c.settings.labels || []).find((l) => !l.done);
      out[c.id] = first ? first.id : null;
    } else if (c.type === 'checkbox' && v) out[c.id] = null;
    else if (c.type === 'dependency' && v) out[c.id] = null;
  }
  return out;
}

module.exports = { Recurring, nextAfter, describe };
