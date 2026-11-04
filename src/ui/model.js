// View logic shared by every board view: filtering, sorting, grouping and
// summaries. Pure functions over the board payload from getBoard().
import C from '../core/columns.js';
import { todayIso, addDaysIso } from './lib.js';

export { C };

export function ctxOf(B) {
  const people = Object.fromEntries((B.people || []).map((p) => [p.id, p]));
  const itemNames = Object.fromEntries(Object.entries(B.linked || {}).map(([k, v]) => [k, v.name]));
  for (const it of [...(B.items || []), ...(B.subitems || [])]) itemNames[it.id] = it.name;
  const teams = Object.fromEntries((B.teams || []).map((t) => [t.id, t]));
  return { people, teams, files: B.files || {}, itemNames };
}

export const FILTER_OPS = {
  is: 'is', is_not: 'is not', contains: 'contains', empty: 'is empty', not_empty: 'is not empty',
  gt: 'greater than', lt: 'less than', before: 'before', after: 'after', overdue: 'is overdue', this_week: 'is this week', today: 'is today',
};

export function opsFor(col) {
  if (!col) return ['contains', 'empty', 'not_empty'];
  if (C.LABEL_TYPES.has(col.type) || ['people', 'team', 'dropdown', 'connect', 'vote', 'country'].includes(col.type)) return ['is', 'is_not', 'empty', 'not_empty'];
  if (['numbers', 'rating', 'progress', 'auto_number', 'item_id'].includes(col.type)) return ['is', 'gt', 'lt', 'empty', 'not_empty'];
  if (['date', 'timeline', 'week'].includes(col.type)) return ['before', 'after', 'today', 'this_week', 'overdue', 'empty', 'not_empty'];
  if (col.type === 'checkbox') return ['not_empty', 'empty'];
  return ['contains', 'is', 'empty', 'not_empty'];
}

function dateOf(col, v) {
  if (!v) return null;
  if (col.type === 'timeline') return v.end || v.start;
  return String(v).slice(0, 10);
}

function test(f, col, it, ctx) {
  if (f.column === '__name') {
    const s = String(it.name || '').toLowerCase();
    if (f.op === 'contains') return s.includes(String(f.value || '').toLowerCase());
    if (f.op === 'is') return s === String(f.value || '').toLowerCase();
    return true;
  }
  if (f.column === '__group') {
    const want = Array.isArray(f.value) ? f.value : [f.value];
    return f.op === 'is_not' ? !want.includes(it.group_id) : want.includes(it.group_id);
  }
  if (!col) return true;
  const v = it.values[col.id];
  const empty = C.isEmpty(col, v);
  const t = todayIso();
  switch (f.op) {
    case 'empty': return empty;
    case 'not_empty': return !empty;
    case 'is': case 'is_not': {
      const want = Array.isArray(f.value) ? f.value : f.value == null || f.value === '' ? [] : [f.value];
      if (!want.length) return true;
      let hit;
      if (Array.isArray(v)) hit = want.some((w) => v.includes(w === '__me' ? ctx.meId : w));
      else if (['numbers', 'rating', 'progress', 'auto_number', 'item_id'].includes(col.type)) hit = want.some((w) => Number(w) === Number(v));
      else if (C.LABEL_TYPES.has(col.type) || col.type === 'country') hit = want.includes(v == null ? '__empty' : v);
      else hit = want.some((w) => String(w).toLowerCase() === C.textOf(col, v, ctx).toLowerCase());
      return f.op === 'is' ? hit : !hit;
    }
    case 'contains': return C.textOf(col, v, ctx).toLowerCase().includes(String(f.value || '').toLowerCase());
    case 'gt': return !empty && Number(v) > Number(f.value);
    case 'lt': return !empty && Number(v) < Number(f.value);
    case 'before': { const d = dateOf(col, v); return !!d && d < (f.value || t); }
    case 'after': { const d = dateOf(col, v); return !!d && d > (f.value || t); }
    case 'today': { const d = dateOf(col, v); return d === t; }
    case 'this_week': { const d = dateOf(col, v); return !!d && d >= t && d <= addDaysIso(t, 7); }
    case 'overdue': { const d = dateOf(col, v); return !!d && d < t; }
    default: return true;
  }
}

/** Items that pass the view's search, person filter and filter rules. */
export function applyFilters(B, cfg, ctx, { items } = {}) {
  const cols = Object.fromEntries(B.columns.map((c) => [c.id, c]));
  const q = String(cfg.search || '').trim().toLowerCase();
  const person = cfg.person;
  const peopleCols = B.columns.filter((c) => c.type === 'people' && c.scope === 'item');
  const subsBy = {};
  for (const s of B.subitems || []) (subsBy[s.parent_id] = subsBy[s.parent_id] || []).push(s);
  const filters = (cfg.filters || []).filter((f) => f.column && f.op);
  const any = cfg.match === 'any';
  return (items || B.items).filter((it) => {
    if (q) {
      const hay = [it.name, ...B.columns.filter((c) => c.scope === 'item').map((c) => C.textOf(c, it.values[c.id], ctx))].join(' ').toLowerCase();
      const subHit = (subsBy[it.id] || []).some((s) => s.name.toLowerCase().includes(q));
      if (!hay.includes(q) && !subHit) return false;
    }
    if (person && !peopleCols.some((c) => (it.values[c.id] || []).includes(person))) return false;
    if (!filters.length) return true;
    const results = filters.map((f) => test(f, cols[f.column], it, ctx));
    return any ? results.some(Boolean) : results.every(Boolean);
  });
}

export function applySort(B, cfg, items, ctx) {
  const sorts = (cfg.sort || []).filter((s) => s.column);
  if (!sorts.length) return items;
  const cols = Object.fromEntries(B.columns.map((c) => [c.id, c]));
  return [...items].sort((a, b) => {
    for (const s of sorts) {
      const dir = s.dir === 'desc' ? -1 : 1;
      let ka, kb;
      if (s.column === '__name') { ka = a.name.toLowerCase(); kb = b.name.toLowerCase(); } else {
        const c = cols[s.column];
        if (!c) continue;
        ka = C.sortKey(c, a.values[c.id], ctx); kb = C.sortKey(c, b.values[c.id], ctx);
      }
      if (ka === kb) continue;
      if (ka == null) return 1; // empties last either way
      if (kb == null) return -1;
      if (ka < kb) return -1 * dir;
      if (ka > kb) return 1 * dir;
    }
    return 0;
  });
}

/** Sections for the table: board groups, or buckets of a "group by" column. */
export function sections(B, cfg, items, ctx) {
  const by = cfg.groupBy ? B.columns.find((c) => c.id === cfg.groupBy) : null;
  if (!by) {
    return B.groups.filter((g) => !g.archived).map((g) => ({ id: g.id, name: g.name, color: C.colorHex(g.color), group: g, items: items.filter((i) => i.group_id === g.id) }));
  }
  const out = new Map();
  const put = (key, name, color, it) => {
    if (!out.has(key)) out.set(key, { id: `by:${key}`, name, color, items: [], key });
    if (it) out.get(key).items.push(it);
  };
  if (C.LABEL_TYPES.has(by.type)) for (const l of by.settings.labels || []) put(l.id, l.label, C.colorHex(l.color));
  for (const it of items) {
    const v = it.values[by.id];
    if (C.LABEL_TYPES.has(by.type)) { const l = C.labelOf(by, v); if (l) put(l.id, l.label, C.colorHex(l.color), it); else put('__empty', 'No value', '#9aa3b2', it); }
    else if (by.type === 'team') { const tid = (v || [])[0]; const tm = tid && ctx.teams[tid]; put(tid || '__empty', tm ? tm.name : 'No team', tm ? C.colorHex(tm.color) : '#9aa3b2', it); }
    else if (by.type === 'people') { const p = (v || [])[0]; put(p || '__empty', p && ctx.people[p] ? ctx.people[p].name : 'Unassigned', p && ctx.people[p] ? ctx.people[p].color : '#9aa3b2', it); }
    else if (by.type === 'date') { const d = v ? String(v).slice(0, 7) : ''; put(d || '__empty', d ? monthName(d) : 'No date', '#3aa0e8', it); }
    else if (by.type === 'timeline') { const d = v && v.start ? v.start.slice(0, 7) : ''; put(d || '__empty', d ? monthName(d) : 'No date', '#3aa0e8', it); }
    else { const t = C.textOf(by, by.type === 'dropdown' ? (v || []).slice(0, 1) : v, ctx); put(t || '__empty', t || 'No value', '#5a55d6', it); }
  }
  const arr = [...out.values()];
  if (by.type === 'date' || by.type === 'timeline') arr.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return arr.filter((s) => s.items.length || C.LABEL_TYPES.has(by.type));
}

function monthName(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
}

/** Column footer summary for a set of items. */
export function summary(col, items, ctx) {
  const vals = items.map((i) => i.values[col.id]);
  if (C.LABEL_TYPES.has(col.type)) {
    const counts = {};
    for (const v of vals) counts[v || '__empty'] = (counts[v || '__empty'] || 0) + 1;
    const parts = [...(col.settings.labels || []).map((l) => ({ color: C.colorHex(l.color), n: counts[l.id] || 0, label: l.label })), { color: '#d5dae3', n: counts.__empty || 0, label: 'Empty' }].filter((p) => p.n);
    return { kind: 'bar', parts, total: items.length };
  }
  if (['numbers', 'formula', 'mirror'].includes(col.type)) {
    const nums = vals.map((v) => (typeof v === 'number' ? v : null)).filter((v) => v != null);
    if (!nums.length) return null;
    const fn = col.settings.summary || 'sum';
    const val = fn === 'avg' ? nums.reduce((a, b) => a + b, 0) / nums.length : fn === 'min' ? Math.min(...nums) : fn === 'max' ? Math.max(...nums) : fn === 'count' ? nums.length : fn === 'none' ? null : nums.reduce((a, b) => a + b, 0);
    if (val == null) return null;
    return { kind: 'num', text: col.type === 'numbers' ? C.fmtNumber({ ...col, settings: { ...col.settings, decimals: Number.isInteger(val) ? 0 : 2 } }, val) : String(Math.round(val * 100) / 100), fn };
  }
  if (col.type === 'timeline' || col.type === 'date') {
    const ds = vals.flatMap((v) => (!v ? [] : col.type === 'timeline' ? [v.start, v.end] : [String(v).slice(0, 10)])).filter(Boolean).sort();
    return ds.length ? { kind: 'range', from: ds[0], to: ds[ds.length - 1] } : null;
  }
  if (col.type === 'checkbox') return { kind: 'num', text: `${vals.filter(Boolean).length} / ${vals.length}` };
  if (col.type === 'progress') {
    const n = vals.filter((v) => v != null);
    return n.length ? { kind: 'progress', value: Math.round(n.reduce((a, b) => a + b, 0) / n.length) } : null;
  }
  if (col.type === 'time_tracking') return { kind: 'num', text: C.fmtDuration(vals.reduce((a, v) => a + C.trackedSeconds(v), 0)) || '' };
  if (col.type === 'people') {
    const ids = [...new Set(vals.flat().filter(Boolean))];
    return ids.length ? { kind: 'people', ids } : null;
  }
  if (col.type === 'rating') {
    const n = vals.filter((v) => v);
    return n.length ? { kind: 'num', text: `★ ${(n.reduce((a, b) => a + b, 0) / n.length).toFixed(1)}` } : null;
  }
  return null;
}

export const VIEW_TYPES = {
  table: { label: 'Table', icon: 'table' },
  kanban: { label: 'Kanban', icon: 'kanban' },
  timeline: { label: 'Timeline', icon: 'timeline' },
  calendar: { label: 'Calendar', icon: 'calendar' },
  chart: { label: 'Chart', icon: 'chart' },
  workload: { label: 'Workload', icon: 'workload' },
  form: { label: 'Form', icon: 'form' },
  files: { label: 'Files', icon: 'paperclip' },
};

export function firstCol(B, types, scope = 'item') {
  const t = Array.isArray(types) ? types : [types];
  return B.columns.find((c) => c.scope === scope && t.includes(c.type)) || null;
}
