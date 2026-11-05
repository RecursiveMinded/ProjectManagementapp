'use strict';
// Column type registry. Shared by the core (Node) and the UI (bundled), so it
// must stay free of Node-only modules.
//
// Each cell value is stored in items.data[columnId] in the shape documented
// next to its type below. Computed types (formula, mirror, progress, …) are
// filled in by the core when a board is read and never stored.

const PALETTE = [
  { id: 'mint', hex: '#2bb673' }, { id: 'leaf', hex: '#66a83a' }, { id: 'teal', hex: '#13a89e' }, { id: 'sky', hex: '#3aa0e8' },
  { id: 'ocean', hex: '#2f6fdf' }, { id: 'indigo', hex: '#5a55d6' }, { id: 'grape', hex: '#8a4fd8' }, { id: 'orchid', hex: '#c24fbf' },
  { id: 'rose', hex: '#e4497a' }, { id: 'coral', hex: '#f0634e' }, { id: 'tangerine', hex: '#f28a2e' }, { id: 'sun', hex: '#f2b316' },
  { id: 'sand', hex: '#c9a66b' }, { id: 'cocoa', hex: '#8b6248' }, { id: 'slate', hex: '#5e6b80' }, { id: 'stone', hex: '#9aa3b2' },
  { id: 'night', hex: '#2c3448' }, { id: 'berry', hex: '#a3245a' }, { id: 'lime', hex: '#a6c934' }, { id: 'aqua', hex: '#2cc6d6' },
];
const COLOR = Object.fromEntries(PALETTE.map((c) => [c.id, c.hex]));
function colorHex(c) { return COLOR[c] || (typeof c === 'string' && c.startsWith('#') ? c : '#9aa3b2'); }

// type: { label, group, value: storage shape, computed, defaults() }
const TYPES = {
  text: { label: 'Text', group: 'Essentials', icon: 'text', value: 'string' },
  long_text: { label: 'Long text', group: 'Essentials', icon: 'para', value: 'string' },
  status: { label: 'Status', group: 'Essentials', icon: 'status', value: 'label id', defaults: () => ({ labels: statusLabels() }) },
  people: { label: 'People', group: 'Essentials', icon: 'people', value: '[person id]', defaults: () => ({ max: 0 }) },
  team: { label: 'Team', group: 'Essentials', icon: 'group', value: '[team id]', defaults: () => ({ role: 'owner', max: 0 }) },
  customer: { label: 'Customer', group: 'Essentials', icon: 'building', value: '[customer id]', defaults: () => ({ max: 1 }) },
  date: { label: 'Date', group: 'Essentials', icon: 'calendar', value: "'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM'", defaults: () => ({ time: false }) },
  timeline: { label: 'Timeline', group: 'Essentials', icon: 'timeline', value: '{ start, end }' },
  numbers: { label: 'Numbers', group: 'Essentials', icon: 'hash', value: 'number', defaults: () => ({ unit: '', unitSide: 'right', decimals: 'auto', summary: 'sum' }) },
  dropdown: { label: 'Dropdown', group: 'Essentials', icon: 'dropdown', value: '[option id]', defaults: () => ({ options: [], max: 0 }) },
  checkbox: { label: 'Checkbox', group: 'Essentials', icon: 'checkbox', value: 'boolean' },
  connect: { label: 'Connect boards', group: 'Essentials', icon: 'connect', value: '[item id]', defaults: () => ({ boardIds: [], multiple: true, twoWay: false }) },
  mirror: { label: 'Mirror', group: 'Essentials', icon: 'mirror', computed: true, defaults: () => ({ connectColumn: '', targetTitle: '', agg: 'list' }) },
  priority: { label: 'Priority', group: 'Essentials', icon: 'flag', value: 'label id', defaults: () => ({ labels: priorityLabels() }) },

  tags: { label: 'Tags', group: 'Useful', icon: 'tag', value: '[string]' },
  link: { label: 'Link', group: 'Useful', icon: 'link', value: '{ url, text }' },
  email: { label: 'Email', group: 'Useful', icon: 'mail', value: 'string' },
  phone: { label: 'Phone', group: 'Useful', icon: 'phone', value: 'string' },
  location: { label: 'Location', group: 'Useful', icon: 'pin', value: 'string (address)' },
  files: { label: 'Files', group: 'Useful', icon: 'paperclip', value: '[file id]' },
  doc: { label: 'Doc', group: 'Useful', icon: 'para', value: 'doc id' },
  rating: { label: 'Rating', group: 'Useful', icon: 'star', value: 'number 0..max', defaults: () => ({ max: 5 }) },
  vote: { label: 'Vote', group: 'Useful', icon: 'vote', value: '[person id]' },
  country: { label: 'Country', group: 'Useful', icon: 'globe', value: 'ISO country code' },
  world_clock: { label: 'World clock', group: 'Useful', icon: 'clock', value: 'IANA time zone' },
  hour: { label: 'Hour', group: 'Useful', icon: 'clock', value: "'HH:MM'" },
  week: { label: 'Week', group: 'Useful', icon: 'calendar', value: "'YYYY-MM-DD' (Monday)" },
  color: { label: 'Color picker', group: 'Useful', icon: 'palette', value: '#rrggbb' },

  progress: { label: 'Progress', group: 'Power', icon: 'battery', computed: true, defaults: () => ({ columns: [] }) },
  formula: { label: 'Formula', group: 'Power', icon: 'fx', computed: true, defaults: () => ({ expr: '', format: 'auto', decimals: 2 }) },
  dependency: { label: 'Dependency', group: 'Power', icon: 'dependency', value: '[item id]', defaults: () => ({ dateColumn: '', mode: 'flexible', type: 'fs', lagDays: 0 }) },
  time_tracking: { label: 'Time tracking', group: 'Power', icon: 'timer', value: '{ total: seconds, since: ISO | null, sessions: [] }' },
  button: { label: 'Button', group: 'Power', icon: 'button', value: 'none (clicks trigger automations)', defaults: () => ({ label: 'Click me', color: 'ocean' }) },
  auto_number: { label: 'Auto number', group: 'Power', icon: 'hash', computed: true, defaults: () => ({ prefix: '', digits: 0 }) },
  item_id: { label: 'Item ID', group: 'Power', icon: 'hash', computed: true },
  creation_log: { label: 'Creation log', group: 'Power', icon: 'history', computed: true },
  last_updated: { label: 'Last updated', group: 'Power', icon: 'history', computed: true },
  subitems_count: { label: 'Subitem count', group: 'Power', icon: 'list', computed: true },
};

function statusLabels() {
  return [
    { id: 'todo', label: 'Not started', color: 'stone' },
    { id: 'working', label: 'In progress', color: 'tangerine' },
    { id: 'stuck', label: 'Blocked', color: 'coral' },
    { id: 'review', label: 'In review', color: 'indigo' },
    { id: 'done', label: 'Done', color: 'mint', done: true },
  ];
}
function priorityLabels() {
  return [
    { id: 'critical', label: 'Critical', color: 'night' },
    { id: 'high', label: 'High', color: 'grape' },
    { id: 'medium', label: 'Medium', color: 'indigo' },
    { id: 'low', label: 'Low', color: 'sky' },
  ];
}

const LABEL_TYPES = new Set(['status', 'priority']);
const DATE_TYPES = new Set(['date', 'timeline', 'week']);

function isComputed(type) { return !!(TYPES[type] && TYPES[type].computed); }
function defaultsFor(type) { return TYPES[type] && TYPES[type].defaults ? TYPES[type].defaults() : {}; }

function labelOf(col, id) {
  const ls = (col.settings && col.settings.labels) || [];
  return ls.find((l) => l.id === id) || null;
}
function optionOf(col, id) {
  const os = (col.settings && col.settings.options) || [];
  return os.find((o) => o.id === id) || null;
}

/** Plain-text rendering of a cell, for search, export, formulas and sorting. */
function textOf(col, v, ctx = {}) {
  if (v == null || v === '') return '';
  switch (col.type) {
    case 'status': case 'priority': { const l = labelOf(col, v); return l ? l.label : ''; }
    case 'dropdown': return (Array.isArray(v) ? v : []).map((id) => (optionOf(col, id) || {}).label).filter(Boolean).join(', ');
    case 'people': case 'vote': return (Array.isArray(v) ? v : []).map((id) => (ctx.people && ctx.people[id] ? ctx.people[id].name : '')).filter(Boolean).join(', ');
    case 'team': return (Array.isArray(v) ? v : []).map((id) => (ctx.teams && ctx.teams[id] ? ctx.teams[id].name : '')).filter(Boolean).join(', ');
    case 'customer': return (Array.isArray(v) ? v : []).map((id) => (ctx.customers && ctx.customers[id] ? ctx.customers[id].name : '')).filter(Boolean).join(', ');
    case 'timeline': return v.start || v.end ? `${v.start || ''} - ${v.end || ''}` : '';
    case 'checkbox': return v ? 'Yes' : '';
    case 'tags': return (Array.isArray(v) ? v : []).join(', ');
    case 'link': return typeof v === 'object' ? (v.text || v.url || '') : String(v);
    case 'files': return (Array.isArray(v) ? v : []).map((id) => (ctx.files && ctx.files[id] ? ctx.files[id].name : '')).filter(Boolean).join(', ');
    case 'doc': return ctx.docs && ctx.docs[v] ? ctx.docs[v].title : '';
    case 'connect': case 'dependency': return (Array.isArray(v) ? v : []).map((id) => (ctx.itemNames && ctx.itemNames[id]) || '').filter(Boolean).join(', ');
    case 'time_tracking': return fmtDuration(trackedSeconds(v));
    case 'progress': return `${Math.round(Number(v) || 0)}%`;
    case 'mirror': return Array.isArray(v) ? v.join(', ') : String(v);
    case 'numbers': return fmtNumber(col, v);
    case 'rating': return v ? `${v}/${(col.settings && col.settings.max) || 5}` : '';
    case 'creation_log': return v.at ? `${(ctx.people && ctx.people[v.by] && ctx.people[v.by].name) || ''} ${v.at.slice(0, 10)}`.trim() : '';
    case 'last_updated': return v.at ? v.at.slice(0, 16).replace('T', ' ') : '';
    default: return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

function fmtNumber(col, v) {
  if (v == null || v === '' || Number.isNaN(Number(v))) return '';
  const s = col.settings || {};
  const n = Number(v);
  const d = s.decimals === 'auto' || s.decimals == null ? (Number.isInteger(n) ? 0 : 2) : Number(s.decimals);
  const body = n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  if (!s.unit) return body;
  return s.unitSide === 'left' ? `${s.unit}${body}` : `${body} ${s.unit}`;
}

function trackedSeconds(v, now = Date.now()) {
  if (!v) return 0;
  let t = Number(v.total) || 0;
  if (v.since) t += Math.max(0, (now - new Date(v.since).getTime()) / 1000);
  return Math.round(t);
}
function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Sort key: numbers sort as numbers, dates as ISO strings, labels by their order. */
function sortKey(col, v, ctx) {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return null;
  switch (col.type) {
    case 'numbers': case 'rating': case 'progress': case 'auto_number': case 'item_id': case 'subitems_count': return Number(v);
    case 'status': case 'priority': { const ls = (col.settings && col.settings.labels) || []; const i = ls.findIndex((l) => l.id === v); return i < 0 ? null : i; }
    case 'timeline': return v.start || v.end || null;
    case 'checkbox': return v ? 1 : 0;
    case 'time_tracking': return trackedSeconds(v);
    case 'creation_log': case 'last_updated': return v.at || null;
    case 'formula': return typeof v === 'number' ? v : String(v);
    default: return textOf(col, v, ctx).toLowerCase();
  }
}

function isEmpty(col, v) {
  if (v == null || v === '' || v === false) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (col.type === 'timeline') return !v.start && !v.end;
  if (col.type === 'link') return !v.url;
  if (col.type === 'time_tracking') return !trackedSeconds(v);
  return false;
}

/** Normalise a value written by the UI, an import or an automation. */
function coerce(col, v) {
  if (v == null || v === '') return null;
  switch (col.type) {
    case 'numbers': case 'rating': { const n = Number(String(v).replace(/[^0-9.\-eE]/g, '')); return Number.isFinite(n) ? n : null; }
    case 'checkbox': return v === true || v === 1 || /^(true|yes|y|1|x|done|✓)$/i.test(String(v)) || null;
    case 'people': case 'vote': case 'dropdown': case 'connect': case 'dependency': case 'files': case 'team': case 'customer': return Array.isArray(v) ? v.filter(Boolean) : [v];
    case 'tags': return (Array.isArray(v) ? v : String(v).split(',')).map((t) => String(t).trim()).filter(Boolean);
    case 'link': return typeof v === 'object' ? (v.url ? { url: v.url, text: v.text || '' } : null) : { url: String(v), text: '' };
    case 'timeline': {
      if (typeof v === 'object') return v.start || v.end ? { start: v.start || v.end, end: v.end || v.start } : null;
      const m = String(v).match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
      return m ? { start: m[1], end: m[2] } : null;
    }
    case 'date': case 'week': return String(v).slice(0, col.settings && col.settings.time ? 16 : 10);
    case 'status': case 'priority': {
      if (labelOf(col, v)) return v;
      const hit = ((col.settings && col.settings.labels) || []).find((l) => l.label.toLowerCase() === String(v).toLowerCase());
      return hit ? hit.id : null;
    }
    default: return v;
  }
}

/** Is this item "done" by its first status column (label flagged done)? */
function isDoneLabel(col, v) {
  const l = labelOf(col, v);
  return !!(l && l.done);
}

const COUNTRIES = [
  ['US', 'United States'], ['CA', 'Canada'], ['MX', 'Mexico'], ['GB', 'United Kingdom'], ['IE', 'Ireland'], ['FR', 'France'], ['DE', 'Germany'],
  ['ES', 'Spain'], ['PT', 'Portugal'], ['IT', 'Italy'], ['NL', 'Netherlands'], ['BE', 'Belgium'], ['CH', 'Switzerland'], ['AT', 'Austria'],
  ['SE', 'Sweden'], ['NO', 'Norway'], ['DK', 'Denmark'], ['FI', 'Finland'], ['PL', 'Poland'], ['CZ', 'Czechia'], ['RO', 'Romania'], ['GR', 'Greece'],
  ['TR', 'Türkiye'], ['IL', 'Israel'], ['AE', 'United Arab Emirates'], ['SA', 'Saudi Arabia'], ['EG', 'Egypt'], ['ZA', 'South Africa'], ['NG', 'Nigeria'],
  ['KE', 'Kenya'], ['IN', 'India'], ['PK', 'Pakistan'], ['CN', 'China'], ['JP', 'Japan'], ['KR', 'South Korea'], ['SG', 'Singapore'], ['MY', 'Malaysia'],
  ['TH', 'Thailand'], ['VN', 'Vietnam'], ['PH', 'Philippines'], ['ID', 'Indonesia'], ['AU', 'Australia'], ['NZ', 'New Zealand'], ['BR', 'Brazil'],
  ['AR', 'Argentina'], ['CL', 'Chile'], ['CO', 'Colombia'], ['PE', 'Peru'], ['UA', 'Ukraine'],
];

module.exports = {
  PALETTE, COLOR, colorHex, TYPES, LABEL_TYPES, DATE_TYPES, COUNTRIES,
  statusLabels, priorityLabels, isComputed, defaultsFor, labelOf, optionOf,
  textOf, fmtNumber, trackedSeconds, fmtDuration, sortKey, isEmpty, coerce, isDoneLabel,
};
