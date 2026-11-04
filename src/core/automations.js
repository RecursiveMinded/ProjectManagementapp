'use strict';
// Automations: "When <trigger>, if <conditions>, then <actions>" recipes per
// board. Event triggers run inside the change that caused them; time triggers
// (a date arriving, every day/week/month) run from the scheduler tick.

const C = require('./columns');
const { uid, now, today, addDays, parseJson } = require('./util');

const TRIGGERS = {
  item_created: { label: 'an item is created', fields: [] },
  subitem_created: { label: 'a subitem is created', fields: [] },
  status_changed: { label: 'a status changes', fields: ['column:status', 'to?', 'from?'] },
  column_changed: { label: 'a column changes', fields: ['column'] },
  checkbox_checked: { label: 'a checkbox is checked', fields: ['column:checkbox'] },
  person_assigned: { label: 'a person is assigned', fields: ['column:people'] },
  number_changed: { label: 'a number changes', fields: ['column:numbers', 'op', 'value'] },
  item_moved: { label: 'an item moves to a group', fields: ['group'] },
  date_arrives: { label: 'a date arrives', fields: ['column:date', 'offset', 'at'] },
  every_period: { label: 'on a schedule', fields: ['period', 'at', 'weekday', 'day'] },
  button_clicked: { label: 'a button is clicked', fields: ['column:button'] },
  update_posted: { label: 'an update is posted', fields: [] },
  subitems_done: { label: 'all subitems are done', fields: ['column:sub-status'] },
};

const ACTIONS = {
  set_value: 'set a column',
  clear_value: 'clear a column',
  increase_number: 'increase a number',
  push_date: 'push a date',
  assign: 'assign a person',
  move_to_group: 'move the item to a group',
  move_to_board: 'move the item to another board',
  create_item: 'create an item',
  create_subitem: 'create a subitem',
  duplicate: 'duplicate the item',
  archive: 'archive the item',
  delete: 'delete the item',
  notify: 'notify someone',
  post_update: 'post an update',
  start_timer: 'start a time tracker',
  stop_timer: 'stop a time tracker',
  set_parent: "set the parent item's column",
  connect_new: 'create a linked item on another board',
};

class Automations {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    store.on((ev) => this.onEvent(ev));
  }

  list(boardId) {
    return this.db.all('SELECT * FROM automations WHERE board_id=? ORDER BY created_at', [boardId])
      .map((a) => ({ ...a, enabled: !!a.enabled, recipe: parseJson(a.recipe, {}) }));
  }
  save(boardId, a) {
    validate(a.recipe);
    if (a.id && this.db.get('SELECT id FROM automations WHERE id=?', [a.id])) {
      this.db.run('UPDATE automations SET name=?, enabled=?, recipe=?, last_error=? WHERE id=?', [a.name || '', a.enabled === false ? 0 : 1, JSON.stringify(a.recipe), '', a.id]);
      return a.id;
    }
    const id = uid('a');
    this.db.run('INSERT INTO automations(id,board_id,name,enabled,recipe,created_at) VALUES(?,?,?,?,?,?)', [id, boardId, a.name || '', a.enabled === false ? 0 : 1, JSON.stringify(a.recipe), now()]);
    return id;
  }
  toggle(id, enabled) { this.db.run('UPDATE automations SET enabled=? WHERE id=?', [enabled ? 1 : 0, id]); }
  remove(id) { this.db.run('DELETE FROM automations WHERE id=?', [id]); }
  log({ boardId, limit = 100 } = {}) {
    return this.db.all(`SELECT l.*, a.name, i.name AS item_name FROM automation_log l LEFT JOIN automations a ON a.id=l.automation_id LEFT JOIN items i ON i.id=l.item_id
      ${boardId ? 'WHERE l.board_id=?' : ''} ORDER BY l.id DESC LIMIT ?`, boardId ? [boardId, limit] : [limit]);
  }

  enabledFor(boardId, type) {
    return this.list(boardId).filter((a) => a.enabled && a.recipe.trigger && a.recipe.trigger.type === type);
  }

  // -------------------------------------------------------------- events
  onEvent(ev) {
    const s = this.store;
    switch (ev.type) {
      case 'item_created': case 'subitem_created': case 'update_posted':
        for (const a of this.enabledFor(ev.boardId, ev.type)) this.fire(a, ev.itemId, ev);
        break;
      case 'item_moved':
        for (const a of this.enabledFor(ev.boardId, 'item_moved')) if (!a.recipe.trigger.group || a.recipe.trigger.group === ev.toGroup) this.fire(a, ev.itemId, ev);
        break;
      case 'button_clicked':
        for (const a of this.enabledFor(ev.boardId, 'button_clicked')) if (a.recipe.trigger.column === ev.columnId) this.fire(a, ev.itemId, ev);
        break;
      case 'value_changed': {
        const t = (type) => this.enabledFor(ev.boardId, type).filter((a) => a.recipe.trigger.column === ev.columnId);
        for (const a of t('column_changed')) this.fire(a, ev.itemId, ev);
        for (const a of t('status_changed')) {
          const tr = a.recipe.trigger;
          if ((!tr.to || tr.to === ev.value) && (!tr.from || tr.from === ev.old)) this.fire(a, ev.itemId, ev);
        }
        for (const a of t('checkbox_checked')) if (ev.value && !ev.old) this.fire(a, ev.itemId, ev);
        for (const a of t('person_assigned')) {
          const added = (ev.value || []).filter((p) => !(ev.old || []).includes(p));
          if (added.length && (!a.recipe.trigger.person || added.includes(a.recipe.trigger.person))) this.fire(a, ev.itemId, { ...ev, added });
        }
        for (const a of t('number_changed')) if (compare(Number(ev.value), a.recipe.trigger.op || 'any', Number(a.recipe.trigger.value))) this.fire(a, ev.itemId, ev);
        // A subitem status change can complete the parent's subitems.
        if (ev.parentId) {
          for (const a of this.enabledFor(ev.boardId, 'subitems_done')) {
            if (a.recipe.trigger.column !== ev.columnId) continue;
            const col = s.colRow(ev.columnId);
            if (!C.isDoneLabel(col, ev.value)) continue;
            const subs = this.db.all('SELECT data FROM items WHERE parent_id=? AND archived=0', [ev.parentId]).map((r) => parseJson(r.data, {}));
            if (subs.length && subs.every((d) => C.isDoneLabel(col, d[col.id]))) this.fire(a, ev.parentId, ev);
          }
        }
        break;
      }
      default: break;
    }
  }

  // ------------------------------------------------------------ schedule
  /** Time-based triggers. Called every minute by the app and on start-up. */
  tick(at = new Date()) {
    const day = today(at);
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    let fired = 0;
    const autos = this.db.all("SELECT a.* FROM automations a JOIN boards b ON b.id=a.board_id WHERE a.enabled=1 AND b.archived=0")
      .map((a) => ({ ...a, recipe: parseJson(a.recipe, {}) }))
      .filter((a) => a.recipe.trigger && ['date_arrives', 'every_period'].includes(a.recipe.trigger.type));
    for (const a of autos) {
      const tr = a.recipe.trigger;
      if ((tr.at || '09:00') > hhmm) continue;
      if (tr.type === 'date_arrives') {
        let col;
        try { col = this.store.colRow(tr.column); } catch (_) { continue; }
        const items = this.db.all('SELECT id, data FROM items WHERE board_id=? AND archived=0', [a.board_id]);
        for (const it of items) {
          const v = parseJson(it.data, {})[col.id];
          const d = col.type === 'timeline' ? v && (tr.edge === 'end' ? v.end : v.start) : v;
          if (!d) continue;
          const when = addDays(String(d).slice(0, 10), Number(tr.offset) || 0);
          // Fire on the day, or catch up one missed day if the app was closed.
          if (when !== day && when !== addDays(day, -1)) continue;
          if (this.once(`${a.id}:${it.id}:${when}`)) { this.fire(a, it.id, { type: 'date_arrives' }); fired++; }
        }
      } else {
        const period = tr.period || 'day';
        const dow = ((at.getDay() + 6) % 7) + 1; // 1 = Monday
        if (period === 'week' && Number(tr.weekday || 1) !== dow) continue;
        if (period === 'month' && Number(tr.day || 1) !== at.getDate()) continue;
        if (period === 'weekday' && dow > 5) continue;
        if (!this.once(`${a.id}:${day}`)) continue;
        fired++;
        if (needsItem(a.recipe)) {
          for (const it of this.db.all('SELECT id FROM items WHERE board_id=? AND archived=0 AND parent_id IS NULL', [a.board_id])) this.fire(a, it.id, { type: 'every_period' });
        } else this.fire(a, null, { type: 'every_period' });
      }
    }
    return fired;
  }
  once(key) {
    if (this.db.get('SELECT key FROM fired WHERE key=?', [key])) return false;
    this.db.run('INSERT INTO fired(key, ts) VALUES(?,?)', [key, now()]);
    return true;
  }

  // -------------------------------------------------------------- running
  fire(a, itemId, ev) {
    const s = this.store;
    let item = null;
    if (itemId) {
      try { item = s.itemRow(itemId); } catch (_) { return; }
      if (item.archived) return;
      if (!this.conditionsHold(a.recipe.conditions || [], item)) return;
    }
    const done = [];
    try {
      this.db.tx(() => {
        for (const act of a.recipe.actions || []) {
          const out = this.act(a, act, item, ev);
          if (out) done.push(out);
          if (act.type === 'delete') break;
        }
        this.db.run('UPDATE automations SET runs=runs+1, last_run=?, last_error=? WHERE id=?', [now(), '', a.id]);
        this.db.run('INSERT INTO automation_log(automation_id,board_id,item_id,ts,ok,summary) VALUES(?,?,?,?,1,?)', [a.id, a.board_id, itemId, now(), done.join('; ')]);
      });
    } catch (e) {
      this.db.run('UPDATE automations SET last_error=? WHERE id=?', [e.message, a.id]);
      this.db.run('INSERT INTO automation_log(automation_id,board_id,item_id,ts,ok,summary) VALUES(?,?,?,?,0,?)', [a.id, a.board_id, itemId, now(), e.message]);
    }
  }

  conditionsHold(conds, item) {
    for (const c of conds) {
      if (c.column === '__group') { if ((c.op === 'is_not') === (item.group_id === c.value)) return false; continue; }
      let col;
      try { col = this.store.colRow(c.column); } catch (_) { return false; }
      const v = item.data[col.id];
      const empty = C.isEmpty(col, v);
      switch (c.op) {
        case 'empty': if (!empty) return false; break;
        case 'not_empty': if (empty) return false; break;
        case 'is': if (!matches(col, v, c.value)) return false; break;
        case 'is_not': if (matches(col, v, c.value)) return false; break;
        case 'gt': if (!(Number(v) > Number(c.value))) return false; break;
        case 'lt': if (!(Number(v) < Number(c.value))) return false; break;
        case 'contains': if (!C.textOf(col, v, { people: this.store.peopleMap() }).toLowerCase().includes(String(c.value || '').toLowerCase())) return false; break;
        default: break;
      }
    }
    return true;
  }

  act(a, act, item, ev) {
    const s = this.store;
    const opts = { source: 'automation' };
    const need = () => { if (!item) throw new Error(`"${ACTIONS[act.type]}" needs an item`); return item; };
    switch (act.type) {
      case 'set_value': {
        const it = need();
        const col = s.colRow(act.column);
        s.setValue(it.id, col.id, this.resolveValue(col, act.value, it, ev), opts);
        return `set ${col.title}`;
      }
      case 'clear_value': { const it = need(); s.setValue(it.id, act.column, null, opts); return 'cleared'; }
      case 'increase_number': {
        const it = need();
        const cur = Number(s.itemRow(it.id).data[act.column]) || 0;
        s.setValue(it.id, act.column, cur + (Number(act.by) || 1), opts);
        return 'increased';
      }
      case 'push_date': {
        const it = need();
        const col = s.colRow(act.column);
        const v = s.itemRow(it.id).data[col.id];
        if (!v) return null;
        const n = Number(act.days) || 0;
        const nv = col.type === 'timeline' ? { start: addDays(v.start, n), end: addDays(v.end, n) } : addDays(String(v), n);
        s.setValue(it.id, col.id, nv, opts);
        return `pushed ${n} d`;
      }
      case 'assign': {
        const it = need();
        const col = s.colRow(act.column);
        const who = this.people(act.person, it);
        const cur = act.mode === 'replace' ? [] : (s.itemRow(it.id).data[col.id] || []);
        s.setValue(it.id, col.id, [...new Set([...cur, ...who])], opts);
        return 'assigned';
      }
      case 'move_to_group': { const it = need(); s.moveItem(it.id, { groupId: act.group }); return 'moved'; }
      case 'move_to_board': { const it = need(); s.moveItemToBoard(it.id, act.board, act.group); return 'moved board'; }
      case 'create_item': {
        const boardId = act.board || a.board_id;
        const id = s.addItem(boardId, { groupId: act.group, name: this.template(act.name || 'New item', item), source: 'automation' });
        return `created ${id}`;
      }
      case 'connect_new': {
        const it = need();
        const nid = s.addItem(act.board, { groupId: act.group, name: this.template(act.name || '{name}', it), source: 'automation' });
        if (act.column) {
          const cur = s.itemRow(it.id).data[act.column] || [];
          s.setValue(it.id, act.column, [...cur, nid], opts);
        }
        return 'created linked item';
      }
      case 'create_subitem': { const it = need(); s.addItem(it.board_id, { parentId: it.id, name: this.template(act.name || 'Subitem', it), source: 'automation' }); return 'subitem'; }
      case 'duplicate': { const it = need(); s.duplicateItem(it.id, { groupId: act.group }); return 'duplicated'; }
      case 'archive': { const it = need(); s.archiveItem(it.id, true); return 'archived'; }
      case 'delete': { const it = need(); s.deleteItem(it.id); return 'deleted'; }
      case 'notify': {
        const who = item ? this.people(act.to, item) : this.people(act.to, null);
        const msg = this.template(act.message || '{name} needs attention', item);
        const board = s.boardRow(a.board_id);
        for (const p of who) s.notify(p, 'automation', msg, item ? `${board.name} · ${item.name}` : board.name, a.board_id, item && item.id);
        return `notified ${who.length}`;
      }
      case 'post_update': { const it = need(); s.postUpdate(it.id, this.template(act.text || '', it), { author: 'automation' }); return 'posted'; }
      case 'start_timer': case 'stop_timer': {
        const it = need();
        const v = s.itemRow(it.id).data[act.column] || {};
        if ((act.type === 'start_timer') !== !!v.since) s.toggleTimer(it.id, act.column);
        return act.type === 'start_timer' ? 'timer started' : 'timer stopped';
      }
      case 'set_parent': {
        const it = need();
        const target = it.parent_id ? s.itemRow(it.parent_id) : it;
        const col = s.colRow(act.column);
        s.setValue(target.id, col.id, this.resolveValue(col, act.value, target, ev), opts);
        return 'set parent';
      }
      default: throw new Error(`Unknown action ${act.type}`);
    }
  }

  /** Who: a person id, 'me', 'creator', 'column:<peopleColumnId>' or a list. */
  people(spec, item) {
    const s = this.store;
    const list = Array.isArray(spec) ? spec : [spec || 'me'];
    const out = new Set();
    for (const x of list) {
      if (x === 'me') out.add(s.me().id);
      else if (x === 'creator' && item) out.add(item.created_by || s.me().id);
      else if (typeof x === 'string' && x.startsWith('column:') && item) for (const p of s.itemRow(item.id).data[x.slice(7)] || []) out.add(p);
      else if (x) out.add(x);
    }
    return [...out].filter((p) => s.db.get('SELECT id FROM people WHERE id=?', [p]));
  }

  resolveValue(col, value, item, ev) {
    if (col.type === 'date' || col.type === 'week') {
      if (value === 'today') return today();
      const m = String(value || '').match(/^today\s*([+-])\s*(\d+)$/) || String(value || '').match(/^([+-])(\d+)$/);
      if (m) return addDays(today(), (m[1] === '-' ? -1 : 1) * Number(m[2]));
    }
    if (col.type === 'timeline' && value && value.days) return { start: today(), end: addDays(today(), Number(value.days) - 1) };
    if (col.type === 'people') return this.people(value, item);
    if (col.type === 'text' || col.type === 'long_text') return this.template(String(value || ''), item);
    void ev;
    return value;
  }

  template(text, item) {
    if (!item) return String(text).replace(/\{[^}]+\}/g, '');
    const s = this.store;
    const cols = s.columns(item.board_id);
    const ctx = { people: s.peopleMap() };
    const fresh = s.itemRow(item.id);
    return String(text).replace(/\{([^}]+)\}/g, (m, key) => {
      const k = key.trim().toLowerCase();
      if (k === 'name' || k === 'item') return fresh.name;
      if (k === 'board') return s.boardRow(item.board_id).name;
      if (k === 'today') return today();
      if (k === 'group') { const g = s.db.get('SELECT name FROM groups WHERE id=?', [fresh.group_id]); return g ? g.name : ''; }
      const c = cols.find((x) => x.title.toLowerCase() === k);
      return c ? C.textOf(c, fresh.data[c.id], ctx) : m;
    });
  }
}

function matches(col, v, want) {
  if (Array.isArray(v)) return Array.isArray(want) ? want.every((w) => v.includes(w)) : v.includes(want);
  if (col.type === 'checkbox') return !!v === (want === true || want === 'true');
  return String(v ?? '') === String(want ?? '');
}
function compare(n, op, x) {
  if (Number.isNaN(n)) return false;
  if (op === 'gt') return n > x;
  if (op === 'lt') return n < x;
  if (op === 'eq') return n === x;
  return true;
}
function needsItem(recipe) {
  return (recipe.conditions || []).length > 0 || (recipe.actions || []).some((x) => !['create_item', 'notify'].includes(x.type));
}
function validate(r) {
  if (!r || !r.trigger || !TRIGGERS[r.trigger.type]) throw new Error('Choose when the automation runs');
  if (!Array.isArray(r.actions) || !r.actions.length) throw new Error('Add at least one action');
  for (const a of r.actions) if (!ACTIONS[a.type]) throw new Error(`Unknown action ${a.type}`);
}

module.exports = { Automations, TRIGGERS, ACTIONS };
