// Automation center: recipes in plain sentences, a gallery of starting
// points and a builder for "When … if … then …".
import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Modal, toastError, toast, Spinner, relTime } from './lib.js';
import { call } from './api.js';
import { C } from './model.js';

const TRIGGER_LABEL = {
  item_created: 'an item is created', subitem_created: 'a subitem is created', status_changed: 'a status changes', column_changed: 'a column changes',
  checkbox_checked: 'a checkbox is checked', person_assigned: 'a person is assigned', number_changed: 'a number changes', item_moved: 'an item moves to a group',
  date_arrives: 'a date arrives', every_period: 'on a schedule', button_clicked: 'a button is clicked', update_posted: 'an update is posted', subitems_done: 'all subitems are done',
};
const ACTION_LABEL = {
  set_value: 'Set a column', clear_value: 'Clear a column', increase_number: 'Increase a number', push_date: 'Push a date', assign: 'Assign a person',
  move_to_group: 'Move to group', move_to_board: 'Move to board', create_item: 'Create an item', connect_new: 'Create a linked item on another board', create_subitem: 'Create a subitem',
  duplicate: 'Duplicate the item', archive: 'Archive the item', delete: 'Delete the item', notify: 'Notify someone', post_update: 'Post an update',
  start_timer: 'Start a time tracker', stop_timer: 'Stop a time tracker', set_parent: "Set the parent item's column",
};

function colName(B, id) { const c = B.columns.find((x) => x.id === id); return c ? c.title : '?'; }
function groupName(B, id) { const g = B.groups.find((x) => x.id === id); return g ? g.name : '?'; }
function valText(B, colId, v) {
  const c = B.columns.find((x) => x.id === colId);
  if (!c) return String(v ?? '');
  if (C.LABEL_TYPES.has(c.type)) { const l = C.labelOf(c, v); return l ? l.label : 'something'; }
  if (c.type === 'people') return whoText(B, v);
  if (c.type === 'date') return v === 'today' ? 'today' : String(v || '').startsWith('today') ? String(v).replace('today', 'today ') + ' days' : String(v || '');
  if (c.type === 'checkbox') return v ? 'checked' : 'unchecked';
  return String(v ?? '');
}
function whoText(B, w) {
  const list = Array.isArray(w) ? w : [w];
  return list.map((x) => (x === 'me' ? 'me' : x === 'creator' ? 'the item creator' : String(x || '').startsWith('column:') ? `the people in ${colName(B, x.slice(7))}` : (B.people.find((p) => p.id === x) || {}).name || 'someone')).join(', ');
}

export function describe(r, B) {
  const t = r.trigger || {};
  const b = (s) => html`<b>${s}</b>`;
  let when;
  switch (t.type) {
    case 'status_changed': when = html`When ${b(colName(B, t.column))} changes${t.from ? html` from ${b(valText(B, t.column, t.from))}` : ''}${t.to ? html` to ${b(valText(B, t.column, t.to))}` : ''}`; break;
    case 'column_changed': when = html`When ${b(colName(B, t.column))} changes`; break;
    case 'checkbox_checked': when = html`When ${b(colName(B, t.column))} is checked`; break;
    case 'person_assigned': when = html`When someone is assigned in ${b(colName(B, t.column))}`; break;
    case 'number_changed': when = html`When ${b(colName(B, t.column))} changes${t.op === 'gt' ? html` to more than ${b(t.value)}` : t.op === 'lt' ? html` to less than ${b(t.value)}` : ''}`; break;
    case 'item_moved': when = html`When an item moves to ${b(t.group ? groupName(B, t.group) : 'any group')}`; break;
    case 'date_arrives': when = html`When ${b(colName(B, t.column))}${t.edge === 'end' ? ' (end)' : ''} ${Number(t.offset) ? html`is ${b(`${Math.abs(t.offset)} day${Math.abs(t.offset) === 1 ? '' : 's'} ${t.offset < 0 ? 'away' : 'past'}`)}` : 'arrives'} at ${b(t.at || '09:00')}`; break;
    case 'every_period': when = html`Every ${b(t.period === 'week' ? `week on ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][(t.weekday || 1) - 1]}` : t.period === 'month' ? `month on day ${t.day || 1}` : t.period === 'weekday' ? 'weekday' : 'day')} at ${b(t.at || '09:00')}`; break;
    case 'button_clicked': when = html`When ${b(colName(B, t.column))} is clicked`; break;
    case 'subitems_done': when = html`When all subitems' ${b(colName(B, t.column))} are done`; break;
    default: when = html`When ${b(TRIGGER_LABEL[t.type] || t.type)}`;
  }
  const conds = (r.conditions || []).map((c, i) => html`<span key=${i}>${i ? ' and ' : ', if '}${c.column === '__group' ? html`group ${c.op === 'is_not' ? 'is not' : 'is'} ${b(groupName(B, c.value))}` : html`${b(colName(B, c.column))} ${{ is: 'is', is_not: 'is not', empty: 'is empty', not_empty: 'is not empty', gt: 'is more than', lt: 'is less than', contains: 'contains' }[c.op] || c.op} ${['empty', 'not_empty'].includes(c.op) ? '' : b(valText(B, c.column, c.value))}`}</span>`);
  const acts = (r.actions || []).map((a, i) => {
    let s;
    switch (a.type) {
      case 'set_value': s = html`set ${b(colName(B, a.column))} to ${b(valText(B, a.column, a.value))}`; break;
      case 'clear_value': s = html`clear ${b(colName(B, a.column))}`; break;
      case 'increase_number': s = html`increase ${b(colName(B, a.column))} by ${b(a.by || 1)}`; break;
      case 'push_date': s = html`push ${b(colName(B, a.column))} by ${b(`${a.days || 0} days`)}`; break;
      case 'assign': s = html`assign ${b(whoText(B, a.person))} in ${b(colName(B, a.column))}`; break;
      case 'move_to_group': s = html`move the item to ${b(groupName(B, a.group))}`; break;
      case 'move_to_board': s = html`move the item to another board`; break;
      case 'create_item': s = html`create ${b(a.name || 'an item')}`; break;
      case 'connect_new': s = html`create a linked item on another board`; break;
      case 'create_subitem': s = html`add subitem ${b(a.name || 'Subitem')}`; break;
      case 'notify': s = html`notify ${b(whoText(B, a.to))}${a.message ? html`: “${a.message}”` : ''}`; break;
      case 'post_update': s = html`post the update “${a.text || ''}”`; break;
      case 'set_parent': s = html`set the parent's ${b(colName(B, a.column))} to ${b(valText(B, a.column, a.value))}`; break;
      default: s = html`${(ACTION_LABEL[a.type] || a.type).toLowerCase()}`;
    }
    return html`<span key=${i}>${i ? (i === r.actions.length - 1 ? ' and ' : ', ') : ', '}${s}</span>`;
  });
  return html`<span>${when}${conds}${acts}.</span>`;
}

function gallery(B) {
  const status = B.columns.find((c) => c.scope === 'item' && c.type === 'status');
  const people = B.columns.find((c) => c.scope === 'item' && c.type === 'people');
  const date = B.columns.find((c) => c.scope === 'item' && (c.type === 'date' || c.type === 'timeline'));
  const subStatus = B.columns.find((c) => c.scope === 'sub' && c.type === 'status');
  const done = status && (status.settings.labels || []).find((l) => l.done);
  const stuck = status && (status.settings.labels || []).find((l) => /stuck|block/i.test(l.label));
  const lastGroup = B.groups.filter((g) => !g.archived).slice(-1)[0];
  const out = [];
  if (status && done && lastGroup) out.push({ trigger: { type: 'status_changed', column: status.id, to: done.id }, actions: [{ type: 'move_to_group', group: lastGroup.id }] });
  if (people) out.push({ trigger: { type: 'item_created' }, conditions: [{ column: people.id, op: 'empty' }], actions: [{ type: 'assign', column: people.id, person: 'creator' }] });
  if (status && people) out.push({ trigger: { type: 'status_changed', column: status.id, to: stuck ? stuck.id : '' }, actions: [{ type: 'notify', to: `column:${people.id}`, message: '{name} changed to {' + status.title + '}' }] });
  if (date && people) out.push({ trigger: { type: 'date_arrives', column: date.id, offset: -1, at: '09:00', edge: 'end' }, conditions: done ? [{ column: status.id, op: 'is_not', value: done.id }] : [], actions: [{ type: 'notify', to: `column:${people.id}`, message: '{name} is due tomorrow' }] });
  if (date && status && stuck) out.push({ trigger: { type: 'date_arrives', column: date.id, offset: 1, at: '08:00', edge: 'end' }, conditions: done ? [{ column: status.id, op: 'is_not', value: done.id }] : [], actions: [{ type: 'set_value', column: status.id, value: stuck.id }] });
  if (subStatus && status && done) out.push({ trigger: { type: 'subitems_done', column: subStatus.id }, actions: [{ type: 'set_parent', column: status.id, value: done.id }] });
  if (people) out.push({ trigger: { type: 'person_assigned', column: people.id }, actions: [{ type: 'notify', to: `column:${people.id}`, message: 'You now own {name}' }] });
  out.push({ trigger: { type: 'every_period', period: 'week', weekday: 1, at: '09:00' }, actions: [{ type: 'create_item', name: 'Weekly review {today}', group: '' }] });
  if (status && date) out.push({ trigger: { type: 'status_changed', column: status.id, to: (status.settings.labels || [])[1] ? status.settings.labels[1].id : '' }, actions: [{ type: 'set_value', column: date.id, value: date.type === 'date' ? 'today' : { days: 5 } }] });
  out.push({ trigger: { type: 'item_created' }, actions: [{ type: 'post_update', text: 'Created. Add details and an owner.' }] });
  return out;
}

export function AutomationCenter({ B, onClose }) {
  const [list, setList] = useState(null);
  const [mode, setMode] = useState('list');
  const [editing, setEditing] = useState(null);
  const load = () => call('listAutomations', B.board.id).then(setList, toastError);
  useEffect(() => { load(); }, []);
  const save = async (a) => {
    try { await call('saveAutomation', B.board.id, a); toast('Automation saved'); setMode('list'); setEditing(null); load(); } catch (e) { toastError(e); }
  };
  return html`<${Modal} title=${mode === 'list' ? `Automations on ${B.board.name}` : mode === 'gallery' ? 'Start from a recipe' : 'Automation'} onClose=${onClose} wide>
    ${mode === 'list' ? html`<div class="col" style="gap:10px">
      <div class="row"><span class="muted small grow">Automations run inside Boardenda while it is open or in the tray. Date and schedule automations catch up one missed day.</span>
        <button class="btn" onClick=${() => setMode('gallery')}><${Icon} name="spark" /> Recipes</button>
        <button class="btn primary" onClick=${() => { setEditing({ recipe: { trigger: { type: 'status_changed' }, conditions: [], actions: [{ type: 'notify', to: 'me' }] } }); setMode('edit'); }}><${Icon} name="plus" /> Create custom</button></div>
      ${list == null ? html`<${Spinner} />` : !list.length ? html`<div class="empty"><${Icon} name="bolt" /><h3>No automations yet</h3><div>Pick a recipe to start, then adjust it.</div></div>` : null}
      ${(list || []).map((a) => html`<div class="auto-card" key=${a.id}>
        <button class=${`toggle ${a.enabled ? 'on' : ''}`} aria-label=${a.enabled ? 'Turn off' : 'Turn on'} onClick=${() => call('toggleAutomation', a.id, !a.enabled).then(load, toastError)}></button>
        <div class="sentence">${a.name ? html`<div class="small muted">${a.name}</div>` : null}${describe(a.recipe, B)}
          <div class="small faint">${a.runs ? `Ran ${a.runs} time${a.runs === 1 ? '' : 's'}, last ${relTime(a.last_run)}` : 'Has not run yet'}${a.last_error ? html` · <span style="color:var(--bad)">Last error: ${a.last_error}</span>` : ''}</div></div>
        <button class="btn ghost small" onClick=${() => { setEditing(a); setMode('edit'); }}>Edit</button>
        <button class="btn icon ghost small" aria-label="Delete automation" onClick=${() => call('deleteAutomation', a.id).then(load, toastError)}><${Icon} name="trash" size="14" /></button>
      </div>`)}
    </div>` : null}
    ${mode === 'gallery' ? html`<div class="col"><div class="recipe-grid">${gallery(B).map((r, i) => html`<button key=${i} class="recipe" onClick=${() => { setEditing({ recipe: r }); setMode('edit'); }}>${describe(r, B)}</button>`)}</div>
      <div class="row mt2"><button class="btn" onClick=${() => setMode('list')}>Back</button></div></div>` : null}
    ${mode === 'edit' ? html`<${Builder} B=${B} initial=${editing} onCancel=${() => { setMode('list'); setEditing(null); }} onSave=${save} />` : null}
  </${Modal}>`;
}

function Builder({ B, initial, onSave, onCancel }) {
  const [name, setName] = useState(initial.name || '');
  const [r, setR] = useState(JSON.parse(JSON.stringify(initial.recipe)));
  const [boards, setBoards] = useState([]);
  useEffect(() => { call('allBoards').then(setBoards, () => {}); }, []);
  const cols = (types, scope = 'item') => B.columns.filter((c) => c.scope === scope && (!types || types.includes(c.type)));
  const t = r.trigger;
  const setT = (patch) => setR({ ...r, trigger: { ...t, ...patch } });
  const setA = (i, patch) => setR({ ...r, actions: r.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const setCnd = (i, patch) => setR({ ...r, conditions: (r.conditions || []).map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const sel = (value, onChange, options, placeholder = 'Choose…') => html`<select class="input" value=${value ?? ''} onChange=${(e) => onChange(e.target.value)}><option value="">${placeholder}</option>${options.map((o) => html`<option value=${o.value}>${o.label}</option>`)}</select>`;
  const colOpts = (types, scope) => cols(types, scope).map((c) => ({ value: c.id, label: c.title }));
  const labelOpts = (colId) => { const c = B.columns.find((x) => x.id === colId); return c ? (c.settings.labels || []).map((l) => ({ value: l.id, label: l.label })) : []; };
  const groupOpts = B.groups.filter((g) => !g.archived).map((g) => ({ value: g.id, label: g.name }));
  const whoOpts = [{ value: 'me', label: 'Me' }, { value: 'creator', label: 'Item creator' }, ...cols(['people']).map((c) => ({ value: `column:${c.id}`, label: `People in ${c.title}` })), ...B.people.map((p) => ({ value: p.id, label: p.name }))];
  const valueEditor = (colId, value, onChange) => {
    const c = B.columns.find((x) => x.id === colId);
    if (!c) return html`<span></span>`;
    if (C.LABEL_TYPES.has(c.type)) return sel(value, onChange, labelOpts(colId));
    if (c.type === 'people') return sel(Array.isArray(value) ? value[0] : value, onChange, whoOpts);
    if (c.type === 'checkbox') return sel(value === true || value === 'true' ? 'true' : 'false', (v) => onChange(v === 'true'), [{ value: 'true', label: 'Checked' }, { value: 'false', label: 'Unchecked' }]);
    if (c.type === 'date') return sel(value, onChange, [{ value: 'today', label: 'Today' }, { value: 'today+1', label: 'Tomorrow' }, { value: 'today+7', label: 'In a week' }, { value: 'today+14', label: 'In two weeks' }, { value: 'today+30', label: 'In 30 days' }]);
    if (c.type === 'timeline') return html`<label class="row small">Today for <input class="input" type="number" style="width:70px" value=${(value && value.days) || 5} onInput=${(e) => onChange({ days: Number(e.target.value) })} /> days</label>`;
    if (c.type === 'dropdown') return sel(Array.isArray(value) ? value[0] : value, (v) => onChange([v]), (c.settings.options || []).map((o) => ({ value: o.id, label: o.label })));
    return html`<input class="input" value=${value ?? ''} placeholder=${c.type === 'text' ? 'Text, can use {name}' : ''} onInput=${(e) => onChange(e.target.value)} />`;
  };

  let triggerFields = null;
  switch (t.type) {
    case 'status_changed':
      triggerFields = html`${sel(t.column, (v) => setT({ column: v, to: '', from: '' }), colOpts(['status', 'priority']), 'Which status')}
        ${sel(t.from, (v) => setT({ from: v }), labelOpts(t.column), 'from anything')}${sel(t.to, (v) => setT({ to: v }), labelOpts(t.column), 'to anything')}`; break;
    case 'column_changed': triggerFields = sel(t.column, (v) => setT({ column: v }), colOpts(null)); break;
    case 'checkbox_checked': triggerFields = sel(t.column, (v) => setT({ column: v }), colOpts(['checkbox'])); break;
    case 'person_assigned': triggerFields = sel(t.column, (v) => setT({ column: v }), colOpts(['people'])); break;
    case 'number_changed': triggerFields = html`${sel(t.column, (v) => setT({ column: v }), colOpts(['numbers']))}${sel(t.op || 'any', (v) => setT({ op: v }), [{ value: 'any', label: 'to anything' }, { value: 'gt', label: 'above' }, { value: 'lt', label: 'below' }])}${t.op && t.op !== 'any' ? html`<input class="input" type="number" value=${t.value || 0} onInput=${(e) => setT({ value: Number(e.target.value) })} />` : null}`; break;
    case 'item_moved': triggerFields = sel(t.group, (v) => setT({ group: v }), groupOpts, 'any group'); break;
    case 'button_clicked': triggerFields = sel(t.column, (v) => setT({ column: v }), colOpts(['button'])); break;
    case 'subitems_done': triggerFields = sel(t.column, (v) => setT({ column: v }), colOpts(['status'], 'sub'), 'Subitem status column'); break;
    case 'date_arrives':
      triggerFields = html`${sel(t.column, (v) => setT({ column: v }), colOpts(['date', 'timeline']))}
        ${B.columns.find((c) => c.id === t.column && c.type === 'timeline') ? sel(t.edge || 'start', (v) => setT({ edge: v }), [{ value: 'start', label: 'start date' }, { value: 'end', label: 'end date' }]) : null}
        <label class="row small" style="white-space:nowrap"><input class="input" type="number" style="width:70px" value=${t.offset || 0} onInput=${(e) => setT({ offset: Number(e.target.value) })} /> days (negative = before)</label>
        <input class="input" type="time" value=${t.at || '09:00'} onInput=${(e) => setT({ at: e.target.value })} />`; break;
    case 'every_period':
      triggerFields = html`${sel(t.period || 'day', (v) => setT({ period: v }), [{ value: 'day', label: 'Every day' }, { value: 'weekday', label: 'Every weekday' }, { value: 'week', label: 'Every week' }, { value: 'month', label: 'Every month' }])}
        ${t.period === 'week' ? sel(String(t.weekday || 1), (v) => setT({ weekday: Number(v) }), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d, i) => ({ value: String(i + 1), label: d }))) : null}
        ${t.period === 'month' ? html`<input class="input" type="number" min="1" max="28" value=${t.day || 1} onInput=${(e) => setT({ day: Number(e.target.value) })} />` : null}
        <input class="input" type="time" value=${t.at || '09:00'} onInput=${(e) => setT({ at: e.target.value })} />`; break;
    default: break;
  }

  const actionFields = (a, i) => {
    switch (a.type) {
      case 'set_value': return html`${sel(a.column, (v) => setA(i, { column: v, value: '' }), colOpts(['status', 'priority', 'people', 'date', 'timeline', 'text', 'numbers', 'checkbox', 'dropdown', 'long_text']))}${valueEditor(a.column, a.value, (v) => setA(i, { value: v }))}`;
      case 'set_parent': return html`${sel(a.column, (v) => setA(i, { column: v, value: '' }), colOpts(['status', 'priority', 'date', 'checkbox']))}${valueEditor(a.column, a.value, (v) => setA(i, { value: v }))}`;
      case 'clear_value': return sel(a.column, (v) => setA(i, { column: v }), colOpts(null));
      case 'increase_number': return html`${sel(a.column, (v) => setA(i, { column: v }), colOpts(['numbers']))}<input class="input" type="number" value=${a.by || 1} onInput=${(e) => setA(i, { by: Number(e.target.value) })} />`;
      case 'push_date': return html`${sel(a.column, (v) => setA(i, { column: v }), colOpts(['date', 'timeline']))}<label class="row small"><input class="input" type="number" style="width:80px" value=${a.days || 1} onInput=${(e) => setA(i, { days: Number(e.target.value) })} /> days</label>`;
      case 'assign': return html`${sel(a.person, (v) => setA(i, { person: v }), whoOpts.filter((o) => !o.value.startsWith('column:')))}${sel(a.column, (v) => setA(i, { column: v }), colOpts(['people']), 'in which column')}`;
      case 'move_to_group': return sel(a.group, (v) => setA(i, { group: v }), groupOpts);
      case 'duplicate': return sel(a.group, (v) => setA(i, { group: v }), groupOpts, 'same group');
      case 'move_to_board': return sel(a.board, (v) => setA(i, { board: v }), boards.filter((x) => x.id !== B.board.id && !x.archived).map((x) => ({ value: x.id, label: x.name })));
      case 'create_item': return html`<input class="input" placeholder="Name (can use {name}, {today})" value=${a.name || ''} onInput=${(e) => setA(i, { name: e.target.value })} />${sel(a.board, (v) => setA(i, { board: v }), boards.filter((x) => !x.archived).map((x) => ({ value: x.id, label: x.name })), 'this board')}${!a.board || a.board === B.board.id ? sel(a.group, (v) => setA(i, { group: v }), groupOpts, 'first group') : null}`;
      case 'connect_new': return html`${sel(a.board, (v) => setA(i, { board: v }), boards.filter((x) => x.id !== B.board.id && !x.archived).map((x) => ({ value: x.id, label: x.name })), 'On board')}<input class="input" placeholder="Name, e.g. {name}" value=${a.name || ''} onInput=${(e) => setA(i, { name: e.target.value })} />${sel(a.column, (v) => setA(i, { column: v }), colOpts(['connect']), 'and link it in')}`;
      case 'create_subitem': return html`<input class="input" placeholder="Subitem name" value=${a.name || ''} onInput=${(e) => setA(i, { name: e.target.value })} />`;
      case 'notify': return html`${sel(a.to, (v) => setA(i, { to: v }), whoOpts)}<input class="input" placeholder="Message, can use {name} and {Column title}" value=${a.message || ''} onInput=${(e) => setA(i, { message: e.target.value })} />`;
      case 'post_update': return html`<input class="input" placeholder="Update text, can use {name}" value=${a.text || ''} onInput=${(e) => setA(i, { text: e.target.value })} />`;
      case 'start_timer': case 'stop_timer': return sel(a.column, (v) => setA(i, { column: v }), colOpts(['time_tracking']));
      default: return null;
    }
  };

  return html`<div class="builder">
    <label class="field" style="margin-bottom:10px">Name (optional)<input class="input" value=${name} onInput=${(e) => setName(e.target.value)} placeholder="e.g. Done moves to Done" /></label>
    <div class="step"><h4>When</h4><div class="row wrap">${sel(t.type, (v) => setR({ ...r, trigger: { type: v } }), Object.entries(TRIGGER_LABEL).map(([k, l]) => ({ value: k, label: l })))}${triggerFields}</div></div>
    <div class="step"><h4>Only if (optional)</h4>
      ${(r.conditions || []).map((c, i) => html`<div class="row" key=${i} style="margin-bottom:6px">
        ${sel(c.column, (v) => setCnd(i, { column: v, value: '' }), [{ value: '__group', label: 'Group' }, ...colOpts(null)])}
        ${sel(c.op || 'is', (v) => setCnd(i, { op: v }), [['is', 'is'], ['is_not', 'is not'], ['empty', 'is empty'], ['not_empty', 'is not empty'], ['gt', 'is more than'], ['lt', 'is less than'], ['contains', 'contains']].map(([v, l]) => ({ value: v, label: l })))}
        ${['empty', 'not_empty'].includes(c.op) ? html`<span class="grow"></span>` : c.column === '__group' ? sel(c.value, (v) => setCnd(i, { value: v }), groupOpts) : valueEditor(c.column, c.value, (v) => setCnd(i, { value: v }))}
        <button class="btn icon ghost small" aria-label="Remove condition" onClick=${() => setR({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })}><${Icon} name="x" size="14" /></button></div>`)}
      <button class="btn small" onClick=${() => setR({ ...r, conditions: [...(r.conditions || []), { column: '', op: 'is', value: '' }] })}><${Icon} name="plus" size="14" /> Add condition</button></div>
    <div class="step"><h4>Then</h4>
      ${r.actions.map((a, i) => html`<div class="row wrap" key=${i} style="margin-bottom:6px">${sel(a.type, (v) => setA(i, { type: v }), Object.entries(ACTION_LABEL).map(([k, l]) => ({ value: k, label: l })))}${actionFields(a, i)}
        ${r.actions.length > 1 ? html`<button class="btn icon ghost small" aria-label="Remove action" onClick=${() => setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })}><${Icon} name="x" size="14" /></button>` : null}</div>`)}
      <button class="btn small" onClick=${() => setR({ ...r, actions: [...r.actions, { type: 'notify', to: 'me' }] })}><${Icon} name="plus" size="14" /> Add action</button></div>
    <div class="card" style="padding:12px 14px;background:var(--panel-2)"><span class="small muted">Reads as: </span>${describe(r, B)}</div>
    <div class="row mt2" style="justify-content:flex-end"><button class="btn" onClick=${onCancel}>Cancel</button><button class="btn primary" onClick=${() => onSave({ id: initial.id, name, enabled: initial.enabled !== false, recipe: r })}>Save automation</button></div>
  </div>`;
}
