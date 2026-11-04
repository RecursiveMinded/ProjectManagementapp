// Calendar, chart, workload, form and files views.
import { useState } from 'preact/hooks';
import { html, Icon, toastError, toast, todayIso, addDaysIso, diffDays, Avatar, bytes } from '../lib.js';
import { call, native } from '../api.js';
import { C, firstCol } from '../model.js';
import { Cell } from '../cells.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ------------------------------------------------------------------ calendar
export function CalendarView({ B, cfg, setCfg, items, reload, openItem }) {
  const dateCols = B.columns.filter((c) => c.scope === 'item' && (c.type === 'date' || c.type === 'timeline'));
  const col = dateCols.find((c) => c.id === cfg.dateColumn) || dateCols[0];
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [over, setOver] = useState(null);
  const [drag, setDrag] = useState(null);
  if (!col) return html`<div class="empty"><${Icon} name="calendar" /><h3>Add a Date or Timeline column</h3></div>`;
  const statusCol = firstCol(B, 'status');
  const first = `${month}-01`;
  const dow = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDaysIso(first, -dow);
  const cells = Array.from({ length: 42 }, (_, i) => addDaysIso(start, i));
  const t = todayIso();
  const on = {};
  for (const it of items) {
    const v = it.values[col.id];
    if (!v) continue;
    const s = col.type === 'timeline' ? v.start : String(v).slice(0, 10);
    const e = col.type === 'timeline' ? v.end : s;
    if (!s) continue;
    const n = Math.min(62, diffDays(s, e));
    for (let i = 0; i <= n; i++) { const d = addDaysIso(s, i); (on[d] = on[d] || []).push({ it, first: i === 0 }); }
  }
  const colorOf = (it) => {
    if (statusCol) { const l = C.labelOf(statusCol, it.values[statusCol.id]); if (l) return C.colorHex(l.color); }
    const g = B.groups.find((x) => x.id === it.group_id);
    return g ? C.colorHex(g.color) : '#5a55d6';
  };
  const shift = (n) => { const [y, m] = month.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); setMonth(d.toISOString().slice(0, 7)); };
  const moveTo = async (d) => {
    setOver(null);
    const it = items.find((x) => x.id === drag);
    setDrag(null);
    if (!it) return;
    const v = it.values[col.id];
    let value = d;
    if (col.type === 'timeline' && v) { const len = diffDays(v.start, v.end); value = { start: d, end: addDaysIso(d, len) }; }
    else if (col.type === 'timeline') value = { start: d, end: d };
    else if (v && String(v).length > 10) value = `${d}${String(v).slice(10)}`;
    try { await call('setValue', it.id, col.id, value); reload(); } catch (e) { toastError(e); }
  };
  const addOn = async (d) => {
    try { const id = await call('addItem', B.board.id, { name: `New ${B.board.item_noun || 'item'}`, values: { [col.id]: col.type === 'timeline' ? { start: d, end: d } : d } }); reload(); openItem(id); } catch (e) { toastError(e); }
  };
  const [y, m] = month.split('-').map(Number);
  return html`<div class="cal">
    <div class="row" style="margin-bottom:12px">
      <button class="btn icon" aria-label="Previous month" onClick=${() => shift(-1)}><${Icon} name="arrowLeft" /></button>
      <button class="btn" onClick=${() => setMonth(t.slice(0, 7))}>Today</button>
      <button class="btn icon" aria-label="Next month" onClick=${() => shift(1)}><${Icon} name="arrowRight" /></button>
      <h2 style="margin-left:8px">${MONTHS[m - 1]} ${y}</h2>
      <span class="grow"></span>
      <span class="small muted">Dates from</span>
      <select class="input" style="width:auto;height:30px" value=${col.id} onChange=${(e) => setCfg({ ...cfg, dateColumn: e.target.value })}>${dateCols.map((c) => html`<option value=${c.id}>${c.title}</option>`)}</select>
    </div>
    <div class="cal-grid">
      ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => html`<div class="cal-dow" key=${d}>${d}</div>`)}
      ${cells.map((d) => {
        const list = on[d] || [];
        return html`<div key=${d} class=${`cal-day ${d.slice(0, 7) !== month ? 'other' : ''} ${d === t ? 'today' : ''} ${over === d ? 'over' : ''}`}
          onDragOver=${(e) => { e.preventDefault(); setOver(d); }} onDragLeave=${() => setOver(null)} onDrop=${(e) => { e.preventDefault(); moveTo(d); }}>
          <div class="dn"><b>${Number(d.slice(8))}</b><button title="Add item on this day" onClick=${() => addOn(d)}><${Icon} name="plus" size="14" /></button></div>
          ${list.slice(0, 4).map(({ it, first: f }) => html`<div key=${it.id} class="cal-item" draggable=${f} onDragStart=${() => setDrag(it.id)} style=${`background:${colorOf(it)};${f ? '' : 'opacity:.6'}`} title=${it.name} onClick=${() => openItem(it.id)}>${it.name}</div>`)}
          ${list.length > 4 ? html`<div class="cal-more">+${list.length - 4} more</div>` : null}
        </div>`;
      })}
    </div></div>`;
}

// --------------------------------------------------------------------- chart
export function ChartView({ B, cfg, setCfg, items, ctx }) {
  const groupables = B.columns.filter((c) => c.scope === 'item' && (C.LABEL_TYPES.has(c.type) || ['people', 'dropdown', 'date', 'country', 'tags', 'text', 'checkbox', 'rating'].includes(c.type)));
  const numCols = B.columns.filter((c) => c.scope === 'item' && ['numbers', 'formula', 'time_tracking', 'rating', 'mirror'].includes(c.type));
  const by = cfg.groupBy || (groupables[0] ? groupables[0].id : 'group');
  const chart = cfg.chart || 'bar';
  const measure = cfg.measure || 'count';
  const vcol = numCols.find((c) => c.id === cfg.value) || numCols[0];
  const buckets = new Map();
  for (const it of items) {
    let keys;
    if (by === 'group') { const g = B.groups.find((x) => x.id === it.group_id); keys = [[g ? g.name : '—', g ? C.colorHex(g.color) : null]]; }
    else {
      const c = B.columns.find((x) => x.id === by);
      if (!c) continue;
      const v = it.values[c.id];
      if (C.LABEL_TYPES.has(c.type)) { const l = C.labelOf(c, v); keys = [[l ? l.label : 'Empty', l ? C.colorHex(l.color) : '#c4cad4']]; }
      else if (c.type === 'people') keys = (v && v.length ? v : [null]).map((p) => [p && ctx.people[p] ? ctx.people[p].name : 'Unassigned', p && ctx.people[p] ? ctx.people[p].color : '#c4cad4']);
      else if (c.type === 'dropdown' || c.type === 'tags') keys = (C.textOf(c, v) || 'Empty').split(', ').map((k) => [k, null]);
      else if (c.type === 'date') keys = [[v ? String(v).slice(0, 7) : 'No date', null]];
      else keys = [[C.textOf(c, v, ctx) || 'Empty', null]];
    }
    let val = 1;
    if (measure !== 'count' && vcol) {
      const raw = it.values[vcol.id];
      val = vcol.type === 'time_tracking' ? C.trackedSeconds(raw) / 3600 : typeof raw === 'number' ? raw : Number(raw) || 0;
    }
    for (const [k, color] of keys) {
      const b = buckets.get(k) || { label: k, sum: 0, n: 0, color };
      b.sum += val; b.n++;
      buckets.set(k, b);
    }
  }
  let series = [...buckets.values()].map((b, i) => ({ ...b, value: measure === 'avg' ? b.sum / Math.max(1, b.n) : b.sum, color: b.color || C.PALETTE[(i * 3 + 5) % C.PALETTE.length].hex }));
  const byCol = B.columns.find((x) => x.id === by);
  if (byCol && byCol.type === 'date') series.sort((a, b) => a.label.localeCompare(b.label));
  else if (byCol && C.LABEL_TYPES.has(byCol.type)) { const order = (byCol.settings.labels || []).map((l) => l.label); series.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label)); }
  else series.sort((a, b) => b.value - a.value);
  series = series.slice(0, 40);
  const fmt = (v) => (Math.round(v * 100) / 100).toLocaleString();
  return html`<div class="chart-wrap">
    <div class="row wrap" style="margin-bottom:16px">
      <div class="seg">${[['bar', 'Bars'], ['column', 'Columns'], ['pie', 'Pie'], ['donut', 'Donut']].map(([k, l]) => html`<button key=${k} class=${chart === k ? 'on' : ''} onClick=${() => setCfg({ ...cfg, chart: k })}>${l}</button>`)}</div>
      <span class="small muted">X axis</span>
      <select class="input" style="width:auto;height:30px" value=${by} onChange=${(e) => setCfg({ ...cfg, groupBy: e.target.value })}><option value="group">Group</option>${groupables.map((c) => html`<option value=${c.id}>${c.title}</option>`)}</select>
      <span class="small muted">Y axis</span>
      <select class="input" style="width:auto;height:30px" value=${measure} onChange=${(e) => setCfg({ ...cfg, measure: e.target.value })}><option value="count">Count of items</option>${numCols.length ? html`<option value="sum">Sum of</option><option value="avg">Average of</option>` : null}</select>
      ${measure !== 'count' && numCols.length ? html`<select class="input" style="width:auto;height:30px" value=${vcol ? vcol.id : ''} onChange=${(e) => setCfg({ ...cfg, value: e.target.value })}>${numCols.map((c) => html`<option value=${c.id}>${c.title}</option>`)}</select>` : null}
    </div>
    <div class="card" style="padding:20px"><${Chart} kind=${chart} series=${series} fmt=${fmt} /></div>
  </div>`;
}

export function Chart({ kind, series, fmt = (v) => v.toLocaleString(), height = 260 }) {
  if (!series.length) return html`<div class="muted small">No data to chart yet.</div>`;
  const max = Math.max(...series.map((s) => s.value), 0) || 1;
  const total = series.reduce((a, s) => a + s.value, 0) || 1;
  if (kind === 'pie' || kind === 'donut') {
    let a0 = -Math.PI / 2;
    const R = 90, r = kind === 'donut' ? 52 : 0;
    const arcs = series.map((s) => {
      const a1 = a0 + (s.value / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad, ang) => `${100 + rad * Math.cos(ang)},${100 + rad * Math.sin(ang)}`;
      const d = series.length === 1 ? `M100,${100 - R} A${R},${R} 0 1,1 99.99,${100 - R} Z` : r ? `M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z` : `M100,100 L${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} Z`;
      a0 = a1;
      return html`<path key=${s.label} d=${d} fill=${s.color} stroke="var(--panel)" stroke-width="2"><title>${s.label}: ${fmt(s.value)}</title></path>`;
    });
    return html`<div class="row" style="gap:24px;align-items:center;flex-wrap:wrap"><svg viewBox="0 0 200 200" width=${Math.min(height, 240)} height=${Math.min(height, 240)}>${arcs}${r ? html`<text x="100" y="98" text-anchor="middle" font-size="22" font-weight="700" fill="var(--text)">${fmt(total)}</text><text x="100" y="118" text-anchor="middle" font-size="11" fill="var(--muted)">total</text>` : null}</svg>
      <div class="legend">${series.map((s) => html`<div key=${s.label}><i style=${`background:${s.color}`}></i>${s.label} <b>${fmt(s.value)}</b> <span class="faint">(${Math.round((s.value / total) * 100)}%)</span></div>`)}</div></div>`;
  }
  if (kind === 'column') {
    return html`<div class="vbars" style=${`height:${height}px`}>${series.map((s) => html`<div class="vbar" key=${s.label} title=${`${s.label}: ${fmt(s.value)}`}><span class="small" style="font-weight:600">${fmt(s.value)}</span><div class="v" style=${`height:${(s.value / max) * (height - 50)}px;background:${s.color}`}></div><div class="vl">${s.label}</div></div>`)}</div>`;
  }
  return html`<div class="bars">${series.map((s) => html`<div class="bar-row" key=${s.label}><span class="clip" title=${s.label}>${s.label}</span><div class="track"><div class="fill" style=${`width:${(s.value / max) * 100}%;background:${s.color}`}></div></div><b class="num" style="text-align:right">${fmt(s.value)}</b></div>`)}</div>`;
}

// ------------------------------------------------------------------ workload
export function WorkloadView({ B, cfg, setCfg, items, ctx, openItem }) {
  const peopleCols = B.columns.filter((c) => c.scope === 'item' && c.type === 'people');
  const dateCols = B.columns.filter((c) => c.scope === 'item' && (c.type === 'date' || c.type === 'timeline'));
  const numCols = B.columns.filter((c) => c.scope === 'item' && c.type === 'numbers');
  const pc = peopleCols.find((c) => c.id === cfg.peopleColumn) || peopleCols[0];
  const dc = dateCols.find((c) => c.id === cfg.dateColumn) || dateCols[0];
  const ec = numCols.find((c) => c.id === cfg.effortColumn) || null;
  const weeks = cfg.weeks || 8;
  if (!pc || !dc) return html`<div class="empty"><${Icon} name="workload" /><h3>Workload needs a People column and a Date or Timeline column</h3></div>`;
  const statusCol = firstCol(B, 'status');
  const t = todayIso();
  const mon = addDaysIso(t, -((new Date(`${t}T00:00:00Z`).getUTCDay() + 6) % 7));
  const wk = Array.from({ length: weeks }, (_, i) => addDaysIso(mon, i * 7));
  const load = {};
  const capOf = (p) => (ec ? (p.capacity || 40) : (cfg.maxItems || 5));
  for (const it of items) {
    if (statusCol && C.isDoneLabel(statusCol, it.values[statusCol.id])) continue;
    const v = it.values[dc.id];
    if (!v) continue;
    const s = dc.type === 'timeline' ? v.start : String(v).slice(0, 10);
    const e = dc.type === 'timeline' ? v.end : s;
    const span = diffDays(s, e) + 1;
    const effort = ec ? Number(it.values[ec.id]) || 0 : 1;
    for (const p of it.values[pc.id] || []) {
      wk.forEach((w, i) => {
        const we = addDaysIso(w, 6);
        if (e < w || s > we) return;
        const overlap = diffDays(s > w ? s : w, e < we ? e : we) + 1;
        const share = ec ? (effort * overlap) / span : 1;
        const k = `${p}|${i}`;
        load[k] = load[k] || { v: 0, items: [] };
        load[k].v += share;
        load[k].items.push(it);
      });
    }
  }
  const people = B.people.filter((p) => wk.some((_, i) => load[`${p.id}|${i}`]) || cfg.showAll);
  return html`<div class="chart-wrap">
    <div class="row wrap" style="margin-bottom:14px">
      <span class="small muted">People</span><select class="input" style="width:auto;height:30px" value=${pc.id} onChange=${(e) => setCfg({ ...cfg, peopleColumn: e.target.value })}>${peopleCols.map((c) => html`<option value=${c.id}>${c.title}</option>`)}</select>
      <span class="small muted">Dates</span><select class="input" style="width:auto;height:30px" value=${dc.id} onChange=${(e) => setCfg({ ...cfg, dateColumn: e.target.value })}>${dateCols.map((c) => html`<option value=${c.id}>${c.title}</option>`)}</select>
      <span class="small muted">Effort</span><select class="input" style="width:auto;height:30px" value=${ec ? ec.id : ''} onChange=${(e) => setCfg({ ...cfg, effortColumn: e.target.value })}><option value="">Count items</option>${numCols.map((c) => html`<option value=${c.id}>${c.title}</option>`)}</select>
      ${!ec ? html`<span class="small muted">Capacity</span><input class="input" type="number" min="1" style="width:70px;height:30px" value=${cfg.maxItems || 5} onInput=${(e) => setCfg({ ...cfg, maxItems: Number(e.target.value) || 5 })} /><span class="small muted">items / week</span>` : html`<span class="small muted">Capacity comes from each person's weekly hours (Settings → Team).</span>`}
      <label class="check small"><input type="checkbox" checked=${!!cfg.showAll} onChange=${(e) => setCfg({ ...cfg, showAll: e.target.checked })} /> Show everyone</label>
    </div>
    <div class="card" style="overflow:auto"><table class="wl"><thead><tr><th>Person</th>${wk.map((w) => html`<th key=${w}>Week of ${w.slice(5).replace('-', '/')}</th>`)}</tr></thead>
      <tbody>${people.map((p) => html`<tr key=${p.id}><td><span class="row"><${Avatar} person=${p} size=${26} />${p.name}</span></td>
        ${wk.map((w, i) => {
          const L = load[`${p.id}|${i}`];
          if (!L) return html`<td key=${w}><span class="faint">—</span></td>`;
          const cap = capOf(p);
          const ratio = L.v / cap;
          const bg = ratio > 1 ? 'var(--bad)' : ratio > 0.8 ? 'var(--warn)' : 'var(--good)';
          return html`<td key=${w} title=${L.items.map((x) => x.name).join('\n')}><span class="cap" style=${`background:${bg};color:#fff;cursor:pointer`} onClick=${() => openItem(L.items[0].id)}>${ec ? `${Math.round(L.v * 10) / 10}h` : L.v}</span><div class="faint" style="font-size:10px">${Math.round(ratio * 100)}%</div></td>`;
        })}</tr>`)}
      ${!people.length ? html`<tr><td colspan=${weeks + 1} class="muted">Nobody has dated work in these weeks.</td></tr>` : null}</tbody></table></div>
  </div>`;
  void ctx;
}

// ---------------------------------------------------------------------- form
export function FormView({ B, cfg, setCfg, ctx, reload }) {
  const editable = B.columns.filter((c) => c.scope === 'item' && !C.isComputed(c.type) && !['button', 'time_tracking', 'files', 'vote', 'dependency'].includes(c.type));
  const fields = cfg.fields || editable.map((c) => c.id);
  const required = cfg.required || [];
  const [draft, setDraft] = useState({ values: {}, data: {} });
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(false);
  const fake = { id: '__form', name, values: draft.values, data: draft.values };
  const submit = async () => {
    if (!name.trim()) { toast(`Give the ${B.board.item_noun || 'item'} a name`, 'err'); return; }
    for (const id of required) if (draft.values[id] == null || draft.values[id] === '' || (Array.isArray(draft.values[id]) && !draft.values[id].length)) { toast(`${(B.columns.find((c) => c.id === id) || {}).title} is required`, 'err'); return; }
    try {
      await call('addItem', B.board.id, { groupId: cfg.groupId, name: name.trim(), values: draft.values, source: 'form' });
      toast('Submitted');
      setName(''); setDraft({ values: {}, data: {} });
      reload();
    } catch (e) { toastError(e); }
  };
  return html`<div style="padding:0 24px">
    <div class="row" style="justify-content:flex-end;padding-top:12px"><button class=${`btn small ${editing ? 'on' : ''}`} onClick=${() => setEditing(!editing)}><${Icon} name="gear" size="14" /> ${editing ? 'Done editing' : 'Edit form'}</button></div>
    <div class="form-view">
      ${editing ? html`<input class="input" style="font-size:20px;font-weight:700;height:40px" value=${cfg.title ?? B.board.name} onInput=${(e) => setCfg({ ...cfg, title: e.target.value })} />
        <textarea class="input mt2" rows="2" placeholder="Description shown above the form" value=${cfg.description || ''} onInput=${(e) => setCfg({ ...cfg, description: e.target.value })}></textarea>
        <label class="field mt2">New submissions go to<select class="input" value=${cfg.groupId || ''} onChange=${(e) => setCfg({ ...cfg, groupId: e.target.value })}><option value="">First group</option>${B.groups.filter((g) => !g.archived).map((g) => html`<option value=${g.id}>${g.name}</option>`)}</select></label>
        <div class="mt2 col" style="gap:4px"><b class="small">Fields</b>${editable.map((c) => html`<div class="row" key=${c.id}><label class="check grow"><input type="checkbox" checked=${fields.includes(c.id)} onChange=${(e) => setCfg({ ...cfg, fields: e.target.checked ? [...fields, c.id] : fields.filter((x) => x !== c.id) })} />${c.title}</label>
          <label class="check small muted"><input type="checkbox" checked=${required.includes(c.id)} onChange=${(e) => setCfg({ ...cfg, required: e.target.checked ? [...required, c.id] : required.filter((x) => x !== c.id) })} /> required</label></div>`)}</div>`
        : html`<h1>${cfg.title ?? B.board.name}</h1>${cfg.description ? html`<p class="muted mt">${cfg.description}</p>` : null}
        <div class="ff mt2"><label>${(B.board.item_noun || 'item')[0].toUpperCase() + (B.board.item_noun || 'item').slice(1)} name *</label><input class="input" value=${name} onInput=${(e) => setName(e.target.value)} /></div>
        ${fields.map((id) => B.columns.find((c) => c.id === id)).filter(Boolean).map((c) => html`<div class="ff" key=${c.id}><label>${c.title}${required.includes(c.id) ? ' *' : ''}</label>
          ${c.description ? html`<div class="small muted" style="margin:-4px 0 6px">${c.description}</div>` : null}
          <div class="fv"><${Cell} col=${c} item=${fake} B=${B} ctx=${ctx} onSet=${(v) => setDraft((d) => ({ ...d, values: { ...d.values, [c.id]: v } }))} reload=${() => {}} /></div></div>`)}
        <button class="btn primary" style="width:100%;height:40px;justify-content:center" onClick=${submit}>Submit</button>`}
    </div></div>`;
}

// --------------------------------------------------------------------- files
export function FilesView({ B, items, openItem }) {
  const list = Object.values(B.files).filter((f) => items.some((i) => i.id === f.item_id) || B.subitems.some((s) => s.id === f.item_id));
  if (!list.length) return html`<div class="empty"><${Icon} name="paperclip" /><h3>No files yet</h3><div>Add a Files column and drop files into it, or attach them from an item's Files tab.</div></div>`;
  const nameOf = (id) => (B.items.find((i) => i.id === id) || B.subitems.find((i) => i.id === id) || {}).name;
  return html`<div class="files-grid">${list.map((f) => html`<div class="file-card" key=${f.id} onClick=${() => native('openFile', { id: f.id }).catch(toastError)}>
    <${Icon} name="file" size="28" /><b class="clip">${f.name}</b><span class="small muted">${bytes(f.size)}</span>
    <a class="small" onClick=${(e) => { e.stopPropagation(); openItem(f.item_id); }}>${nameOf(f.item_id)}</a></div>`)}</div>`;
}
