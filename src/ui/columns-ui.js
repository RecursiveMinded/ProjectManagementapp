// Column picker and per-type column settings.
import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Popover, Modal, toastError } from './lib.js';
import { call } from './api.js';
import { C } from './model.js';
import { ColorDot } from './cells.js';
import F from '../core/formula.js';

export function ColumnPicker({ anchor, onClose, onPick }) {
  const [q, setQ] = useState('');
  const groups = {};
  for (const [k, t] of Object.entries(C.TYPES)) {
    if (q && !t.label.toLowerCase().includes(q.toLowerCase())) continue;
    (groups[t.group] = groups[t.group] || []).push([k, t]);
  }
  return html`<${Popover} anchor=${anchor} onClose=${onClose} width=${360} align="right">
    <div class="pad col" style="gap:8px">
      <input class="input" autoFocus placeholder="Search column types" value=${q} onInput=${(e) => setQ(e.target.value)} />
      ${Object.entries(groups).map(([g, list]) => html`<div key=${g}><div class="menu-head" style="padding-left:2px">${g}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px">${list.map(([k, t]) => html`<button key=${k} class="mi" onClick=${() => onPick(k)}><${Icon} name=${t.icon} />${t.label}</button>`)}</div></div>`)}
    </div></${Popover}>`;
}

export function ColumnSettings({ col, B, onClose, reload }) {
  const [title, setTitle] = useState(col.title);
  const [desc, setDesc] = useState(col.description || '');
  const [s, setS] = useState(JSON.parse(JSON.stringify(col.settings || {})));
  const [type, setType] = useState(col.type);
  const [err, setErr] = useState('');
  const up = (patch) => setS({ ...s, ...patch });
  const save = async () => {
    try {
      await call('updateColumn', col.id, { title, description: desc, settings: s, ...(type !== col.type ? { type } : {}) });
      reload();
      onClose();
    } catch (e) { setErr(e.message); }
  };
  const sameScope = B.columns.filter((c) => c.scope === col.scope && c.id !== col.id);
  const T = col.type;
  return html`<${Modal} title=${`${C.TYPES[T].label} column`} onClose=${onClose} wide=${T === 'formula'}>
    <div class="col" style="gap:12px">
      <div class="grid c2">
        <label class="field">Title<input class="input" value=${title} onInput=${(e) => setTitle(e.target.value)} /></label>
        <label class="field">Type<select class="input" value=${type} onChange=${(e) => setType(e.target.value)}>
          ${Object.entries(C.TYPES).map(([k, t]) => html`<option value=${k} key=${k}>${t.label}</option>`)}</select></label>
      </div>
      ${type !== col.type ? html`<div class="small" style="color:var(--warn)">Changing the type converts existing values as text where it can. Values that do not fit are cleared.</div>` : null}
      <label class="field">Description<input class="input" value=${desc} placeholder="Shown when hovering the column header" onInput=${(e) => setDesc(e.target.value)} /></label>
      ${type === col.type ? html`<${TypeSettings} T=${T} s=${s} up=${up} col=${col} B=${B} sameScope=${sameScope} setErr=${setErr} />` : null}
      ${err ? html`<div class="small" style="color:var(--bad)">${err}</div>` : null}
      <div class="row" style="justify-content:flex-end"><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" onClick=${save}>Save</button></div>
    </div></${Modal}>`;
}

function TypeSettings({ T, s, up, col, B, sameScope, setErr }) {
  if (C.LABEL_TYPES.has(T)) return html`<${LabelsEditor} labels=${s.labels || []} onChange=${(labels) => up({ labels })} />`;
  if (T === 'numbers') {
    return html`<div class="grid c2">
      <label class="field">Unit<input class="input" value=${s.unit || ''} placeholder="$, %, h, pts…" onInput=${(e) => up({ unit: e.target.value })} /></label>
      <label class="field">Unit position<select class="input" value=${s.unitSide || 'right'} onChange=${(e) => up({ unitSide: e.target.value })}><option value="left">Before the number</option><option value="right">After the number</option></select></label>
      <label class="field">Decimals<select class="input" value=${s.decimals ?? 'auto'} onChange=${(e) => up({ decimals: e.target.value })}>${['auto', 0, 1, 2, 3].map((d) => html`<option value=${d}>${d}</option>`)}</select></label>
      <label class="field">Group summary<select class="input" value=${s.summary || 'sum'} onChange=${(e) => up({ summary: e.target.value })}>${[['sum', 'Sum'], ['avg', 'Average'], ['min', 'Minimum'], ['max', 'Maximum'], ['count', 'Count'], ['none', 'None']].map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></label>
    </div>`;
  }
  if (T === 'people') return html`<label class="check"><input type="checkbox" checked=${s.max === 1} onChange=${(e) => up({ max: e.target.checked ? 1 : 0 })} /> Only one person per item</label>`;
  if (T === 'date') return html`<label class="check"><input type="checkbox" checked=${!!s.time} onChange=${(e) => up({ time: e.target.checked })} /> Include a time</label>`;
  if (T === 'rating') return html`<label class="field">Maximum<select class="input" value=${s.max || 5} onChange=${(e) => up({ max: Number(e.target.value) })}>${[3, 4, 5, 6, 7, 8, 9, 10].map((n) => html`<option value=${n}>${n}</option>`)}</select></label>`;
  if (T === 'button') {
    return html`<div class="grid c2"><label class="field">Label<input class="input" value=${s.label || ''} onInput=${(e) => up({ label: e.target.value })} /></label>
      <label class="field">Colour<span><${ColorDot} color=${s.color} onPick=${(c) => up({ color: c })} /></span></label>
      <div class="small muted" style="grid-column:span 2">Clicking the button triggers automations with “When a button is clicked”. Add one from the Automate menu.</div></div>`;
  }
  if (T === 'auto_number' || T === 'item_id') {
    return html`<div class="grid c2"><label class="field">Prefix<input class="input" value=${s.prefix || ''} placeholder="e.g. TASK-" onInput=${(e) => up({ prefix: e.target.value })} /></label>
      <label class="field">Minimum digits<input class="input" type="number" min="0" max="8" value=${s.digits || 0} onInput=${(e) => up({ digits: Number(e.target.value) })} /></label></div>`;
  }
  if (T === 'dropdown') return html`<div class="col"><${OptionsEditor} options=${s.options || []} onChange=${(options) => up({ options })} /><label class="check"><input type="checkbox" checked=${s.max === 1} onChange=${(e) => up({ max: e.target.checked ? 1 : 0 })} /> Only one option per item</label></div>`;
  if (T === 'progress') {
    const statusCols = sameScope.filter((c) => c.type === 'status');
    const sel = s.columns && s.columns.length ? s.columns : statusCols.map((c) => c.id);
    return html`<div class="col"><div class="small muted">Progress is the share of these status columns set to a label marked as done.</div>
      ${statusCols.map((c) => html`<label class="check" key=${c.id}><input type="checkbox" checked=${sel.includes(c.id)} onChange=${(e) => up({ columns: e.target.checked ? [...sel, c.id] : sel.filter((x) => x !== c.id) })} /> ${c.title}
        <input class="input" style="width:70px;margin-left:auto" type="number" min="1" title="Weight" value=${(s.weights || {})[c.id] || 1} onInput=${(e) => up({ weights: { ...(s.weights || {}), [c.id]: Number(e.target.value) } })} /></label>`)}
      ${!statusCols.length ? html`<div class="small" style="color:var(--warn)">Add a status column first.</div>` : null}</div>`;
  }
  if (T === 'dependency') {
    const dateCols = sameScope.filter((c) => c.type === 'date' || c.type === 'timeline');
    return html`<div class="grid c2">
      <label class="field">Dates it controls<select class="input" value=${s.dateColumn || ''} onChange=${(e) => up({ dateColumn: e.target.value })}><option value="">Choose…</option>${dateCols.map((c) => html`<option value=${c.id}>${c.title}</option>`)}</select></label>
      <label class="field">Type<select class="input" value=${s.type || 'fs'} onChange=${(e) => up({ type: e.target.value })}>
        <option value="fs">Finish to start</option><option value="ss">Start to start</option><option value="ff">Finish to finish</option><option value="sf">Start to finish</option></select></label>
      <label class="field">When a predecessor moves<select class="input" value=${s.mode || 'flexible'} onChange=${(e) => up({ mode: e.target.value })}>
        <option value="flexible">Flexible: push later only if they would overlap</option><option value="strict">Strict: keep the gap, move both ways</option><option value="none">Do nothing</option></select></label>
      <label class="field">Lag (days)<input class="input" type="number" value=${s.lagDays || 0} onInput=${(e) => up({ lagDays: Number(e.target.value) })} /></label>
    </div>`;
  }
  if (T === 'connect') return html`<${ConnectSettings} s=${s} up=${up} col=${col} />`;
  if (T === 'mirror') return html`<${MirrorSettings} s=${s} up=${up} sameScope=${sameScope} />`;
  if (T === 'formula') return html`<${FormulaEditor} s=${s} up=${up} sameScope=${sameScope} setErr=${setErr} />`;
  void B;
  return null;
}

export function LabelsEditor({ labels, onChange }) {
  return html`<div class="col" style="gap:6px"><div class="small muted">Labels marked ✓ count as done (progress, My Work, dashboards).</div>
    ${labels.map((l, i) => html`<div class="row" key=${l.id}>
      <${ColorDot} color=${l.color} onPick=${(c) => onChange(labels.map((x, j) => (j === i ? { ...x, color: c } : x)))} />
      <input class="input grow" value=${l.label} onInput=${(e) => onChange(labels.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
      <button class=${`btn icon ghost ${l.done ? 'on' : ''}`} title="Counts as done" onClick=${() => onChange(labels.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))}><${Icon} name="check" size="14" /></button>
      <button class="btn icon ghost" title="Move up" disabled=${i === 0} onClick=${() => { const n = [...labels]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; onChange(n); }}>↑</button>
      <button class="btn icon ghost" title="Remove" onClick=${() => onChange(labels.filter((_, j) => j !== i))}><${Icon} name="x" size="14" /></button></div>`)}
    <button class="btn small" style="align-self:flex-start" onClick=${() => onChange([...labels, { id: `l${Date.now().toString(36)}`, label: 'New label', color: C.PALETTE[(labels.length * 3) % C.PALETTE.length].id }])}><${Icon} name="plus" size="14" /> Add label</button></div>`;
}

function OptionsEditor({ options, onChange }) {
  return html`<div class="col" style="gap:6px">
    ${options.map((o, i) => html`<div class="row" key=${o.id}><input class="input grow" value=${o.label} onInput=${(e) => onChange(options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
      <button class="btn icon ghost" title="Remove" onClick=${() => onChange(options.filter((_, j) => j !== i))}><${Icon} name="x" size="14" /></button></div>`)}
    <button class="btn small" style="align-self:flex-start" onClick=${() => onChange([...options, { id: `o${Date.now().toString(36)}`, label: 'Option' }])}><${Icon} name="plus" size="14" /> Add option</button></div>`;
}

function ConnectSettings({ s, up, col }) {
  const [boards, setBoards] = useState([]);
  useEffect(() => { call('allBoards').then(setBoards, toastError); }, []);
  const sel = s.boardIds || [];
  return html`<div class="col"><div class="small muted">Link items on this board to items on these boards. Add a Mirror column to show their values here.</div>
    <div class="pick-list card" style="padding:4px">${boards.filter((b) => !b.archived).map((b) => html`<label class="check mi" key=${b.id}><input type="checkbox" checked=${sel.includes(b.id)} onChange=${(e) => up({ boardIds: e.target.checked ? [...sel, b.id] : sel.filter((x) => x !== b.id) })} />${b.name}<span class="faint small" style="margin-left:auto">${b.id === col.board_id ? 'this board' : b.workspace}</span></label>`)}</div>
    <label class="check"><input type="checkbox" checked=${s.multiple !== false} onChange=${(e) => up({ multiple: e.target.checked })} /> Allow linking several items</label></div>`;
}

function MirrorSettings({ s, up, sameScope }) {
  const conns = sameScope.filter((c) => c.type === 'connect');
  const conn = conns.find((c) => c.id === s.connectColumn);
  const [targets, setTargets] = useState([]);
  useEffect(() => {
    (async () => {
      if (!conn) { setTargets([]); return; }
      const all = [];
      for (const b of conn.settings.boardIds || []) { try { all.push(...(await call('boardColumns', b)).filter((c) => c.scope === 'item')); } catch (_) { /* gone */ } }
      setTargets([...new Map(all.map((c) => [c.title.toLowerCase(), c])).values()]);
    })();
  }, [s.connectColumn]);
  if (!conns.length) return html`<div class="small" style="color:var(--warn)">Add a Connect boards column first, then choose which of the linked items' columns to mirror.</div>`;
  return html`<div class="grid c2">
    <label class="field">Through<select class="input" value=${s.connectColumn || ''} onChange=${(e) => up({ connectColumn: e.target.value })}><option value="">Choose a connect column…</option>${conns.map((c) => html`<option value=${c.id}>${c.title}</option>`)}</select></label>
    <label class="field">Show<select class="input" value=${s.targetTitle || ''} onChange=${(e) => up({ targetTitle: e.target.value })}><option value="name">Item name</option>${targets.map((c) => html`<option value=${c.title}>${c.title} (${C.TYPES[c.type].label})</option>`)}</select></label>
    <label class="field">Combine as<select class="input" value=${s.agg || 'list'} onChange=${(e) => up({ agg: e.target.value })}>${[['list', 'List every value'], ['sum', 'Sum'], ['avg', 'Average'], ['min', 'Minimum'], ['max', 'Maximum'], ['count', 'Count'], ['earliest', 'Earliest date'], ['latest', 'Latest date']].map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></label>
  </div>`;
}

function FormulaEditor({ s, up, sameScope, setErr }) {
  const [expr, setExpr] = useState(s.expr || '');
  const err = F.check(expr);
  useEffect(() => { up({ expr }); setErr(''); }, [expr]);
  const ins = (t) => setExpr(`${expr}${t}`);
  return html`<div class="col" style="gap:8px">
    <textarea class="input mono" rows="4" value=${expr} placeholder='IF({Spent} > {Budget}, "Over budget", "On track")' onInput=${(e) => setExpr(e.target.value)}></textarea>
    <div class="small" style=${`color:${err ? 'var(--bad)' : 'var(--good)'}`}>${expr ? (err || 'Formula looks good') : 'Refer to columns as {Column title}. Timeline columns: {Timeline#Start} and {Timeline#End}.'}</div>
    <div class="grid c2" style="align-items:start">
      <div><div class="menu-head" style="padding-left:0">Columns</div><div class="chips" style="flex-wrap:wrap">
        <button class="chip" onClick=${() => ins('{Name}')}>Name</button>
        ${sameScope.filter((c) => c.type !== 'button').map((c) => html`<button class="chip" key=${c.id} onClick=${() => ins(`{${c.title}}`)}>${c.title}</button>`)}</div></div>
      <div><div class="menu-head" style="padding-left:0">Functions</div><div class="chips" style="flex-wrap:wrap;max-height:140px;overflow:auto">
        ${F.FUNCTIONS.map((f) => html`<button class="chip" key=${f} onClick=${() => ins(`${f}(`)}>${f}</button>`)}</div></div>
    </div>
    <div class="row wrap small muted" style="gap:4px">Output<select class="input" style="width:auto" value=${s.decimals ?? 2} onChange=${(e) => up({ decimals: Number(e.target.value) })}>${[0, 1, 2, 3, 4].map((d) => html`<option value=${d}>${d} decimals</option>`)}</select>
      <select class="input" style="width:auto" value=${s.summary || 'sum'} onChange=${(e) => up({ summary: e.target.value })}>${[['sum', 'Sum in group footer'], ['avg', 'Average in footer'], ['none', 'No footer']].map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></div>
  </div>`;
}
