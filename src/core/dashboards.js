'use strict';
// Dashboards: widgets that summarise one or more boards. Widgets refer to a
// column by id, or to "the first status/people/date column" of each board so
// that one widget works across boards with different structures.

const C = require('./columns');
const { uid, now, today, addDays, parseJson } = require('./util');

const WIDGETS = {
  numbers: 'Numbers', battery: 'Progress battery', chart: 'Chart', workload: 'Workload', list: 'Item list',
  timeline: 'Timeline', countdown: 'Countdown', note: 'Text note', calendar: 'Calendar', table: 'Table', teams: 'Team ownership',
};

class Dashboards {
  constructor(store) { this.store = store; this.db = store.db; }

  list() {
    return this.db.all('SELECT * FROM dashboards ORDER BY position, name').map((d) => ({ ...d, boardIds: parseJson(d.board_ids, []) }));
  }
  save(d) {
    const name = String(d.name || '').trim() || 'Dashboard';
    if (d.id && this.db.get('SELECT id FROM dashboards WHERE id=?', [d.id])) {
      const cur = this.db.get('SELECT * FROM dashboards WHERE id=?', [d.id]);
      this.db.run('UPDATE dashboards SET name=?, description=?, board_ids=? WHERE id=?', [name, d.description != null ? d.description : cur.description, JSON.stringify(d.boardIds || parseJson(cur.board_ids, [])), d.id]);
      return d.id;
    }
    const id = uid('d');
    const pos = (this.db.get('SELECT MAX(position) AS m FROM dashboards').m || 0) + 1;
    this.db.run('INSERT INTO dashboards(id,name,description,board_ids,position,created_at) VALUES(?,?,?,?,?,?)', [id, name, d.description || '', JSON.stringify(d.boardIds || []), pos, now()]);
    return id;
  }
  remove(id) { this.db.run('DELETE FROM dashboards WHERE id=?', [id]); }
  saveWidget(dashboardId, w) {
    if (!WIDGETS[w.type]) throw new Error('Unknown widget');
    if (w.id && this.db.get('SELECT id FROM widgets WHERE id=?', [w.id])) {
      this.db.run('UPDATE widgets SET title=?, size=?, config=?, position=COALESCE(?, position) WHERE id=?', [w.title || '', w.size || 'm', JSON.stringify(w.config || {}), w.position != null ? w.position : null, w.id]);
      return w.id;
    }
    const id = uid('x');
    const pos = (this.db.get('SELECT MAX(position) AS m FROM widgets WHERE dashboard_id=?', [dashboardId]).m || 0) + 1;
    this.db.run('INSERT INTO widgets(id,dashboard_id,type,title,position,size,config) VALUES(?,?,?,?,?,?,?)', [id, dashboardId, w.type, w.title || WIDGETS[w.type], pos, w.size || 'm', JSON.stringify(w.config || {})]);
    return id;
  }
  removeWidget(id) { this.db.run('DELETE FROM widgets WHERE id=?', [id]); }

  /** The dashboard with each widget's data computed. */
  get(id) {
    const d = this.db.get('SELECT * FROM dashboards WHERE id=?', [id]);
    if (!d) throw new Error('Dashboard not found');
    const boardIds = parseJson(d.board_ids, []);
    const cache = {};
    const board = (bid) => {
      if (!(bid in cache)) { try { cache[bid] = this.store.getBoard(bid); } catch (_) { cache[bid] = null; } }
      return cache[bid];
    };
    const widgets = this.db.all('SELECT * FROM widgets WHERE dashboard_id=? ORDER BY position', [id]).map((w) => {
      const config = parseJson(w.config, {});
      let data = null, error = null;
      try { data = this.compute(w.type, config, (config.boardIds && config.boardIds.length ? config.boardIds : boardIds).map(board).filter(Boolean)); } catch (e) { error = e.message; }
      return { ...w, config, data, error };
    });
    return { ...d, boardIds, widgets, boards: boardIds.map(board).filter(Boolean).map((b) => ({ id: b.board.id, name: b.board.name })) };
  }

  compute(type, cfg, boards) {
    const people = this.store.peopleMap();
    const rows = [];
    for (const b of boards) for (const it of b.items) rows.push({ it, b });
    const firstOf = (b, t) => b.columns.find((c) => c.scope === 'item' && (Array.isArray(t) ? t.includes(c.type) : c.type === t));
    const colFor = (b, ref) => {
      if (!ref) return null;
      if (ref === 'status') return firstOf(b, ['status']);
      if (ref === 'person') return firstOf(b, 'people');
      const c = b.columns.find((x) => x.id === ref);
      if (c) return c;
      // Same column title on another board counts as the same column.
      const any = boards.flatMap((x) => x.columns).find((x) => x.id === ref);
      return any ? b.columns.find((x) => x.title.toLowerCase() === any.title.toLowerCase() && x.type === any.type) : null;
    };
    const isDone = (b, it) => { const sc = firstOf(b, 'status'); return sc ? C.isDoneLabel(sc, it.values[sc.id]) : false; };
    const dueOf = (b, it) => {
      const dc = firstOf(b, ['date', 'timeline']);
      if (!dc) return null;
      const v = it.values[dc.id];
      return dc.type === 'timeline' ? (v && v.end) || null : v ? String(v).slice(0, 10) : null;
    };
    switch (type) {
      case 'numbers': {
        const vals = [];
        let count = 0;
        let unitCol = null;
        for (const { it, b } of rows) {
          if (cfg.notDone && isDone(b, it)) continue;
          count++;
          const c = colFor(b, cfg.column);
          if (!c) continue;
          unitCol = unitCol || c;
          const v = it.values[c.id];
          const n = typeof v === 'number' ? v : Number(v);
          if (v != null && v !== '' && Number.isFinite(n)) vals.push(n);
        }
        const fn = cfg.fn || (cfg.column ? 'sum' : 'count');
        const value = fn === 'count' ? (cfg.column ? vals.length : count)
          : fn === 'avg' ? (vals.length ? vals.reduce((a, x) => a + x, 0) / vals.length : 0)
            : fn === 'min' ? (vals.length ? Math.min(...vals) : 0) : fn === 'max' ? (vals.length ? Math.max(...vals) : 0) : vals.reduce((a, x) => a + x, 0);
        return { value, fn, unit: unitCol && unitCol.settings ? unitCol.settings.unit || '' : '', unitSide: unitCol && unitCol.settings ? unitCol.settings.unitSide : 'right' };
      }
      case 'battery': {
        const by = {};
        let total = 0, done = 0;
        for (const { it, b } of rows) {
          const sc = firstOf(b, 'status');
          if (!sc) continue;
          total++;
          const l = C.labelOf(sc, it.values[sc.id]);
          const key = l ? l.label : 'No status';
          by[key] = by[key] || { label: key, color: l ? C.colorHex(l.color) : '#c4cad4', n: 0, done: !!(l && l.done) };
          by[key].n++;
          if (l && l.done) done++;
        }
        const parts = Object.values(by).sort((a, b) => (b.done - a.done) || b.n - a.n);
        return { total, done, percent: total ? Math.round((done / total) * 100) : 0, parts };
      }
      case 'chart': {
        const buckets = {};
        for (const { it, b } of rows) {
          let keys = [];
          if (cfg.groupBy === 'group') { const g = b.groups.find((x) => x.id === it.group_id); keys = [{ k: g ? g.name : '—', color: g ? C.colorHex(g.color) : null }]; }
          else if (cfg.groupBy === 'board') keys = [{ k: b.board.name }];
          else {
            const c = colFor(b, cfg.groupBy || 'status');
            if (!c) continue;
            const v = it.values[c.id];
            if (C.LABEL_TYPES.has(c.type)) { const l = C.labelOf(c, v); keys = [{ k: l ? l.label : 'Empty', color: l ? C.colorHex(l.color) : '#c4cad4' }]; }
            else if (c.type === 'people') keys = (v && v.length ? v : [null]).map((p) => ({ k: p && people[p] ? people[p].name : 'Unassigned', color: p && people[p] ? people[p].color : '#c4cad4' }));
            else if (c.type === 'dropdown' || c.type === 'tags') keys = (C.textOf(c, v) || 'Empty').split(', ').map((k) => ({ k }));
            else if (c.type === 'date') keys = [{ k: v ? String(v).slice(0, 7) : 'No date' }];
            else keys = [{ k: C.textOf(c, v, { people }) || 'Empty' }];
          }
          let m = 1;
          if (cfg.measure === 'sum' && cfg.value) { const vc = colFor(b, cfg.value); m = vc ? Number(it.values[vc.id]) || 0 : 0; }
          for (const { k, color } of keys) {
            buckets[k] = buckets[k] || { label: k, value: 0, color: color || null };
            buckets[k].value += m;
          }
        }
        let out = Object.values(buckets);
        if (cfg.groupBy && cfg.groupBy.length && /date/.test(cfg.groupBy)) out.sort((a, b) => a.label.localeCompare(b.label));
        else out.sort((a, b) => b.value - a.value);
        out = out.map((x, i) => ({ ...x, color: x.color || C.PALETTE[(i * 3) % C.PALETTE.length].hex }));
        return { chart: cfg.chart || 'bar', series: out };
      }
      case 'workload': {
        const per = {};
        const t = today();
        for (const { it, b } of rows) {
          const pc = firstOf(b, 'people');
          if (!pc) continue;
          const done = isDone(b, it);
          const effortCol = b.columns.find((c) => c.type === 'numbers' && /effort|hour|estimate|points/i.test(c.title));
          const due = dueOf(b, it);
          for (const p of it.values[pc.id] || []) {
            if (!people[p]) continue;
            per[p] = per[p] || { id: p, name: people[p].name, color: people[p].color, capacity: people[p].capacity || 0, open: 0, done: 0, overdue: 0, effort: 0 };
            if (done) per[p].done++;
            else {
              per[p].open++;
              if (due && due < t) per[p].overdue++;
              if (effortCol) per[p].effort += Number(it.values[effortCol.id]) || 0;
            }
          }
        }
        return { people: Object.values(per).sort((a, b) => b.open - a.open) };
      }
      case 'list': {
        const t = today();
        const until = addDays(t, Number(cfg.dueWithin) || 14);
        const me = this.store.me().id;
        const out = [];
        for (const { it, b } of rows) {
          if (isDone(b, it)) continue;
          const due = dueOf(b, it);
          if (cfg.dueWithin && (!due || due > until)) continue;
          if (cfg.mine) { const pc = firstOf(b, 'people'); if (!pc || !(it.values[pc.id] || []).includes(me)) continue; }
          const sc = firstOf(b, 'status');
          const l = sc && C.labelOf(sc, it.values[sc.id]);
          out.push({ id: it.id, name: it.name, boardId: b.board.id, boardName: b.board.name, due, overdue: !!(due && due < t), status: l ? { label: l.label, color: C.colorHex(l.color) } : null });
        }
        return { items: out.sort((a, b) => String(a.due || '9').localeCompare(String(b.due || '9'))).slice(0, 50) };
      }
      case 'timeline': {
        const out = [];
        for (const { it, b } of rows) {
          const dc = firstOf(b, ['timeline', 'date']);
          if (!dc) continue;
          const v = it.values[dc.id];
          const span = dc.type === 'timeline' ? v && v.start && { start: v.start, end: v.end } : v && { start: String(v).slice(0, 10), end: String(v).slice(0, 10) };
          if (!span) continue;
          const sc = firstOf(b, 'status');
          const l = sc && C.labelOf(sc, it.values[sc.id]);
          const g = b.groups.find((x) => x.id === it.group_id);
          out.push({ id: it.id, name: it.name, boardId: b.board.id, ...span, color: l ? C.colorHex(l.color) : g ? C.colorHex(g.color) : '#5a55d6', done: !!(l && l.done) });
        }
        return { items: out.sort((a, b) => a.start.localeCompare(b.start)).slice(0, 80) };
      }
      case 'countdown': {
        const t = today();
        const date = cfg.date || t;
        const ms = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) - Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10));
        return { date, days: Math.round(ms / 86400000) };
      }
      case 'note': return { text: cfg.text || '' };
      case 'calendar': {
        const out = [];
        for (const { it, b } of rows) {
          const dc = firstOf(b, ['date', 'timeline']);
          if (!dc) continue;
          const v = it.values[dc.id];
          const start = dc.type === 'timeline' ? v && v.start : v && String(v).slice(0, 10);
          if (!start) continue;
          const end = dc.type === 'timeline' ? (v.end || v.start) : start;
          if (cfg.notDone && isDone(b, it)) continue;
          const sc = firstOf(b, 'status');
          const l = sc && C.labelOf(sc, it.values[sc.id]);
          out.push({ id: it.id, name: it.name, boardName: b.board.name, start: start.slice(0, 10), end: String(end).slice(0, 10), color: l ? C.colorHex(l.color) : '#5a55d6', done: !!(l && l.done) });
        }
        return { items: out.sort((a, b) => a.start.localeCompare(b.start)).slice(0, 1500) };
      }
      case 'table': {
        const t = today();
        const me = this.store.me().id;
        const teams = this.store.teamsMap();
        const extra = (cfg.columns || []).slice(0, 4);
        const out = [];
        for (const { it, b } of rows) {
          if (cfg.notDone && isDone(b, it)) continue;
          const pc = firstOf(b, 'people');
          if (cfg.mine && (!pc || !(it.values[pc.id] || []).includes(me))) continue;
          const sc = firstOf(b, 'status');
          const l = sc && C.labelOf(sc, it.values[sc.id]);
          const due = dueOf(b, it);
          const g = b.groups.find((x) => x.id === it.group_id);
          out.push({
            id: it.id, name: it.name, boardName: b.board.name, group: g ? g.name : '', groupColor: g ? C.colorHex(g.color) : null,
            status: l ? { label: l.label, color: C.colorHex(l.color) } : null,
            people: pc ? (it.values[pc.id] || []).map((p) => people[p]).filter(Boolean).map((p) => ({ id: p.id, name: p.name, color: p.color })) : [],
            due, overdue: !!(due && due < t && !isDone(b, it)),
            extra: extra.map((ref) => { const c = colFor(b, ref); return c ? C.textOf(c, it.values[c.id], { people, teams }) : ''; }),
          });
        }
        const titles = extra.map((ref) => { const c = boards.flatMap((x) => x.columns).find((x) => x.id === ref); return c ? c.title : ''; });
        const key = cfg.sortBy || 'due';
        out.sort((a, b) => (key === 'name' ? a.name.localeCompare(b.name) : key === 'board' ? a.boardName.localeCompare(b.boardName) || a.name.localeCompare(b.name) : String(a.due || '9').localeCompare(String(b.due || '9'))));
        return { columns: titles, total: out.length, items: out.slice(0, 200) };
      }
      case 'teams': {
        const teams = this.store.teams();
        const per = Object.fromEntries(teams.map((tm) => [tm.id, { id: tm.id, name: tm.name, color: C.colorHex(tm.color), external: !!tm.external, open: 0, done: 0, overdue: 0, waiting: 0 }]));
        const t = today();
        for (const { it, b } of rows) {
          const done = isDone(b, it);
          const due = dueOf(b, it);
          for (const c of b.columns.filter((x) => x.scope === 'item' && x.type === 'team')) {
            for (const tid of it.values[c.id] || []) {
              const r = per[tid];
              if (!r) continue;
              if (c.settings.role === 'waiting') { if (!done) r.waiting++; continue; }
              if (done) r.done++; else { r.open++; if (due && due < t) r.overdue++; }
            }
          }
        }
        return { teams: Object.values(per).filter((r) => r.open + r.done + r.waiting).sort((a, b) => (b.open + b.waiting) - (a.open + a.waiting)) };
      }
      default: throw new Error('Unknown widget');
    }
  }
}

module.exports = { Dashboards, WIDGETS };
