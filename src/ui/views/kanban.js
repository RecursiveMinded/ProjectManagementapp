// Kanban view: one lane per label of a status-like column; drag cards across.
import { useState } from 'preact/hooks';
import { html, Icon, toastError, Avatars, shortDate } from '../lib.js';
import { call } from '../api.js';
import { C, firstCol } from '../model.js';
import { renderValue } from '../cells.js';

export function KanbanView({ B, cfg, setCfg, items, ctx, reload, openItem }) {
  const laneCols = B.columns.filter((c) => c.scope === 'item' && (C.LABEL_TYPES.has(c.type) || c.type === 'people' || c.type === 'dropdown'));
  const col = laneCols.find((c) => c.id === cfg.column) || laneCols[0];
  const [over, setOver] = useState(null);
  const [drag, setDrag] = useState(null);
  if (!col) return html`<div class="empty"><h3>Add a status column to use Kanban</h3></div>`;
  let lanes;
  if (C.LABEL_TYPES.has(col.type)) lanes = [...(col.settings.labels || []).map((l) => ({ id: l.id, name: l.label, color: C.colorHex(l.color) })), { id: '__none', name: 'No value', color: '#9aa3b2' }];
  else if (col.type === 'people') lanes = [...B.people.map((p) => ({ id: p.id, name: p.name, color: p.color })), { id: '__none', name: 'Unassigned', color: '#9aa3b2' }];
  else lanes = [...(col.settings.options || []).map((o, i) => ({ id: o.id, name: o.label, color: C.PALETTE[(i * 3) % C.PALETTE.length].hex })), { id: '__none', name: 'No value', color: '#9aa3b2' }];
  const laneOf = (it) => {
    const v = it.values[col.id];
    if (Array.isArray(v)) return v[0] || '__none';
    return v || '__none';
  };
  const cardCols = (cfg.cardFields || B.columns.filter((c) => c.scope === 'item' && c.id !== col.id && ['people', 'date', 'timeline', 'priority', 'numbers'].includes(c.type)).slice(0, 3).map((c) => c.id))
    .map((id) => B.columns.find((c) => c.id === id)).filter(Boolean);
  const drop = async (lane) => {
    setOver(null);
    const id = drag;
    setDrag(null);
    if (!id) return;
    const value = lane.id === '__none' ? null : col.type === 'people' || col.type === 'dropdown' ? [lane.id] : lane.id;
    try { await call('setValue', id, col.id, value); reload(); } catch (e) { toastError(e); }
  };
  const addIn = async (lane) => {
    try {
      const id = await call('addItem', B.board.id, { name: `New ${B.board.item_noun || 'item'}`, values: lane.id === '__none' ? {} : { [col.id]: col.type === 'people' || col.type === 'dropdown' ? [lane.id] : lane.id } });
      reload();
      openItem(id);
    } catch (e) { toastError(e); }
  };
  const statusCol = firstCol(B, 'status');
  const hideEmpty = cfg.hideEmptyLanes;
  return html`<div>
    <div class="row" style="padding:12px 24px 0;gap:8px">
      <span class="small muted">Lanes by</span>
      <select class="input" style="width:auto;height:28px" value=${col.id} onChange=${(e) => setCfg({ ...cfg, column: e.target.value })}>${laneCols.map((c) => html`<option value=${c.id}>${c.title}</option>`)}</select>
      <label class="check small"><input type="checkbox" checked=${!!hideEmpty} onChange=${(e) => setCfg({ ...cfg, hideEmptyLanes: e.target.checked })} /> Hide empty lanes</label>
    </div>
    <div class="kanban">
    ${lanes.map((lane) => {
      const cards = items.filter((it) => laneOf(it) === lane.id);
      if (hideEmpty && !cards.length) return null;
      return html`<div key=${lane.id} class=${`k-lane ${over === lane.id ? 'over' : ''}`} style=${`--lc:${lane.color}`}
        onDragOver=${(e) => { e.preventDefault(); setOver(lane.id); }} onDragLeave=${() => setOver(null)} onDrop=${(e) => { e.preventDefault(); drop(lane); }}>
        <div class="k-head"><span class="grow clip">${lane.name}</span><span class="faint small">${cards.length}</span></div>
        <div class="k-cards">
          ${cards.map((it) => {
            const g = B.groups.find((x) => x.id === it.group_id);
            const done = statusCol && C.isDoneLabel(statusCol, it.values[statusCol.id]);
            const subs = B.subitems.filter((s) => s.parent_id === it.id);
            return html`<div key=${it.id} class="k-card" draggable="true" onDragStart=${() => setDrag(it.id)} onClick=${() => openItem(it.id)}>
              <div class="row" style="gap:6px"><span class="swatch" style=${`background:${g ? C.colorHex(g.color) : '#999'};width:8px;height:8px;border-radius:50%`}></span><span class="small faint clip">${g ? g.name : ''}</span></div>
              <div class="k-name" style=${done ? 'text-decoration:line-through;opacity:.7' : ''}>${it.name}</div>
              <div class="k-meta">${cardCols.map((c) => html`<span key=${c.id} title=${c.title}>${c.type === 'people' ? html`<${Avatars} ids=${it.values[c.id]} people=${ctx.people} size=${22} />` : c.type === 'date' ? (it.values[c.id] ? html`<span><${Icon} name="calendar" size="12" /> ${shortDate(it.values[c.id])}</span>` : null) : renderValue(c, it.values[c.id], B, ctx, true, it)}</span>`)}
                ${subs.length ? html`<span><${Icon} name="sub" size="12" /> ${subs.length}</span>` : null}
                ${B.updateCounts[it.id] ? html`<span><${Icon} name="msg" size="12" /> ${B.updateCounts[it.id]}</span>` : null}</div>
            </div>`;
          })}
        </div>
        <button class="btn ghost small k-add" onClick=${() => addIn(lane)}><${Icon} name="plus" size="14" /> Add</button>
      </div>`;
    })}
  </div></div>`;
}
