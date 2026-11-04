// Table view: groups of items with typed columns, subitems, summaries,
// inline editing, drag and drop, column resizing and bulk actions.
import { useState, useRef } from 'preact/hooks';
import { html, Icon, Menu, useAnchor, InlineText, toastError, toast, ask, plural } from '../lib.js';
import { call } from '../api.js';
import { Cell, ColorDot } from '../cells.js';
import { C, sections, summary } from '../model.js';
import { ColumnPicker, ColumnSettings } from '../columns-ui.js';

const DEFAULT_W = { text: 160, long_text: 200, status: 140, priority: 130, people: 110, date: 120, timeline: 170, numbers: 110, formula: 140, mirror: 160, connect: 170, dependency: 160, tags: 160, dropdown: 160, link: 150, files: 140, progress: 130, time_tracking: 130, checkbox: 90, rating: 120, button: 120 };
export const widthOf = (c) => c.width || DEFAULT_W[c.type] || 130;

export function TableView({ B, cfg, setCfg, items, ctx, reload, openItem, selected, setSelected }) {
  const [openSubs, setOpenSubs] = useState({});
  const [drag, setDrag] = useState(null);
  const hidden = new Set(cfg.hidden || []);
  const cols = B.columns.filter((c) => c.scope === 'item' && !hidden.has(c.id));
  const subCols = B.columns.filter((c) => c.scope === 'sub');
  const secs = sections(B, cfg, items, ctx);
  const byGroup = !cfg.groupBy;
  const collapsed = cfg.collapsed || {};
  const toggleSec = (s) => {
    if (byGroup) call('updateGroup', s.id, { collapsed: !s.group.collapsed }).then(reload, toastError);
    else setCfg({ ...cfg, collapsed: { ...collapsed, [s.id]: !collapsed[s.id] } });
  };
  const subsOf = (id) => B.subitems.filter((s) => s.parent_id === id);
  const set = (it, col) => (v) => call('setValue', it.id, col.id, v).then(reload);

  const dropOn = async (target, sec) => {
    const d = drag;
    setDrag(null);
    if (!d || !byGroup) return;
    try {
      if (target) await call('moveItem', d, { groupId: sec.id, before: target.id });
      else await call('moveItem', d, { groupId: sec.id });
      reload();
    } catch (e) { toastError(e); }
  };

  return html`<div class="tbl-wrap">
    ${secs.map((s) => {
      const isCollapsed = byGroup ? s.group.collapsed : collapsed[s.id];
      return html`<div class="section" key=${s.id} style=${`--sec:${s.color}`}>
        <${SectionHead} s=${s} B=${B} byGroup=${byGroup} collapsed=${isCollapsed} toggle=${() => toggleSec(s)} reload=${reload} />
        ${isCollapsed ? html`<${CollapsedRow} s=${s} cols=${cols} ctx=${ctx} />` : html`
        <table class="tbl" onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { e.preventDefault(); dropOn(null, s); }}>
          <colgroup><col style="width:6px" /><col style="width:36px" /><col style="width:${cfg.nameWidth || 340}px" />${cols.map((c) => html`<col key=${c.id} style=${`width:${widthOf(c)}px`} />`)}<col style="width:44px" /></colgroup>
          <thead><tr><th class="stripe"></th><th class="sel"><${SelectAll} items=${s.items} selected=${selected} setSelected=${setSelected} /></th>
            <th class="name-cell"><div class="th" style="justify-content:flex-start;padding-left:12px">${B.board.item_noun ? cap(B.board.item_noun) : 'Item'}</div></th>
            ${cols.map((c) => html`<${ColumnHead} key=${c.id} col=${c} B=${B} cfg=${cfg} setCfg=${setCfg} reload=${reload} />`)}
            <th class="add-col"><${AddColumn} B=${B} reload=${reload} scope="item" /></th></tr></thead>
          <tbody>
            ${s.items.map((it) => {
              const subs = subsOf(it.id);
              const open = openSubs[it.id];
              return html`
              <tr key=${it.id} class=${`${selected.has(it.id) ? 'selected' : ''} ${drag === it.id ? 'dragging' : ''}`} draggable=${byGroup}
                onDragStart=${(e) => { setDrag(it.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd=${() => setDrag(null)}
                onDragOver=${(e) => { e.preventDefault(); e.currentTarget.classList.add('drop-before'); }} onDragLeave=${(e) => e.currentTarget.classList.remove('drop-before')}
                onDrop=${(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('drop-before'); dropOn(it, s); }}>
                <td class="stripe"></td>
                <td class="sel"><input type="checkbox" aria-label="Select" checked=${selected.has(it.id)} onChange=${() => { const n = new Set(selected); if (n.has(it.id)) n.delete(it.id); else n.add(it.id); setSelected(n); }} /></td>
                <td class="name-cell"><div class="item-name">
                  <button class=${`sub-toggle ${subs.length ? 'has' : ''} ${open ? 'open' : ''}`} title=${subs.length ? plural(subs.length, 'subitem') : 'Add subitems'} onClick=${() => setOpenSubs({ ...openSubs, [it.id]: !open })}><${Icon} name="chev" size="14" />${subs.length ? subs.length : ''}</button>
                  <span class="nm"><${InlineText} value=${it.name} onSave=${(v) => call('renameItem', it.id, v).then(reload, toastError)} /></span>
                  <button class="open-btn" onClick=${() => openItem(it.id)}><${Icon} name="expand" size="12" />Open</button>
                  <button class=${`upd-count ${B.updateCounts[it.id] ? '' : 'zero'}`} title="Updates" onClick=${() => openItem(it.id, 'updates')}><${Icon} name="msg" size="16" />${B.updateCounts[it.id] || ''}</button>
                </div></td>
                ${cols.map((c) => html`<td key=${c.id}><${Cell} col=${c} item=${it} B=${B} ctx=${ctx} onSet=${set(it, c)} reload=${reload} /></td>`)}
                <td></td>
              </tr>
              ${open ? html`<tr class="sub-wrap"><td class="stripe"></td><td colspan=${cols.length + 3} class="sub-holder">
                <${SubTable} parent=${it} subs=${subs} subCols=${subCols} B=${B} ctx=${ctx} reload=${reload} openItem=${openItem} />
              </td></tr>` : null}`;
            })}
            ${byGroup ? html`<tr class="add-row"><td class="stripe" style="opacity:.5"></td><td></td><td class="name-cell" colspan=${cols.length + 2}><${AddItem} B=${B} groupId=${s.id} reload=${reload} /></td></tr>` : null}
            <${SumRow} cols=${cols} items=${s.items} ctx=${ctx} />
          </tbody>
        </table>`}
      </div>`;
    })}
    ${byGroup ? html`<button class="btn" onClick=${() => call('addGroup', B.board.id, {}).then(reload, toastError)}><${Icon} name="plus" /> Add new group</button>` : null}
  </div>`;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function SelectAll({ items, selected, setSelected }) {
  const all = items.length > 0 && items.every((i) => selected.has(i.id));
  return html`<input type="checkbox" aria-label="Select all" checked=${all} onChange=${() => { const n = new Set(selected); for (const i of items) { if (all) n.delete(i.id); else n.add(i.id); } setSelected(n); }} />`;
}

function CollapsedRow({ s, cols, ctx }) {
  return html`<div class="card row" style="padding:8px 12px;border-left:6px solid var(--sec);gap:16px;width:max-content;min-width:600px">
    <b style="color:var(--sec)">${s.name}</b><span class="faint small">${plural(s.items.length, 'item')}</span>
    ${cols.filter((c) => C.LABEL_TYPES.has(c.type) || c.type === 'numbers').slice(0, 3).map((c) => { const sm = summary(c, s.items, ctx); return sm ? html`<span key=${c.id} class="row small" style="gap:6px">${c.title}: ${sm.kind === 'bar' ? html`<span class="sum-bar" style="width:120px;margin:0">${sm.parts.map((p, i) => html`<span key=${i} title=${`${p.label}: ${p.n}`} style=${`width:${(p.n / sm.total) * 100}%;background:${p.color}`}></span>`)}</span>` : html`<b>${sm.text}</b>`}</span>` : null; })}
  </div>`;
}

function SectionHead({ s, B, byGroup, collapsed, toggle, reload }) {
  const [a, open, close] = useAnchor();
  const g = s.group;
  return html`<div class=${`sec-head ${collapsed ? 'collapsed' : ''}`}>
    <button class="caret" aria-label="Collapse" onClick=${toggle}><${Icon} name="chev" /></button>
    ${byGroup ? html`<${ColorDot} color=${g.color} onPick=${(c) => call('updateGroup', g.id, { color: c }).then(reload, toastError)} />` : null}
    <span class="sec-name">${byGroup ? html`<${InlineText} value=${s.name} onSave=${(v) => call('updateGroup', g.id, { name: v }).then(reload, toastError)} />` : s.name}</span>
    <span class="sec-count">${plural(s.items.length, B.board.item_noun || 'item')}</span>
    ${byGroup ? html`<button class="btn icon ghost small" aria-label="Group menu" onClick=${open}><${Icon} name="more" /></button>` : null}
    ${a ? html`<${Menu} anchor=${a} onClose=${close} items=${[
      { label: 'Add item at top', icon: 'plus', onClick: () => call('addItem', B.board.id, { groupId: g.id, top: true }).then(reload, toastError) },
      { label: 'Add group below', icon: 'group', onClick: () => call('addGroup', B.board.id, { position: g.position + 0.5 }).then(reload, toastError) },
      { label: 'Duplicate group', icon: 'copy', onClick: () => call('duplicateGroup', g.id).then(reload, toastError) },
      { label: 'Move up', icon: 'arrowLeft', onClick: () => moveGroup(B, g, -1).then(reload, toastError) },
      { label: 'Move down', icon: 'arrowRight', onClick: () => moveGroup(B, g, 1).then(reload, toastError) },
      { label: collapsed ? 'Expand' : 'Collapse', icon: 'chev', onClick: toggle },
      { sep: true },
      { label: 'Archive group', icon: 'archive', onClick: () => call('archiveGroup', g.id, true).then(() => { toast('Group archived'); reload(); }, toastError) },
      { label: 'Delete group', icon: 'trash', danger: true, onClick: async () => { if (await ask({ title: 'Delete group?', body: `“${g.name}” and its ${plural(s.items.length, 'item')} will be deleted.` })) call('deleteGroup', g.id).then(reload, toastError); } },
    ]} />` : null}
  </div>`;
}

async function moveGroup(B, g, dir) {
  const list = B.groups.filter((x) => !x.archived);
  const i = list.findIndex((x) => x.id === g.id);
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  const other = list[j];
  await call('updateGroup', g.id, { position: other.position });
  await call('updateGroup', other.id, { position: g.position });
}

function AddItem({ B, groupId, parentId, reload, placeholder }) {
  const [v, setV] = useState('');
  const add = async () => {
    const name = v.trim();
    if (!name) return;
    setV('');
    try { await call('addItem', B.board.id, { groupId, parentId, name }); reload(); } catch (e) { toastError(e); }
  };
  return html`<input placeholder=${placeholder || `+ Add ${B.board.item_noun || 'item'}`} value=${v} onInput=${(e) => setV(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') add(); if (e.key === 'Escape') setV(''); }} onBlur=${add} />`;
}

function SumRow({ cols, items, ctx }) {
  return html`<tr class="sum-row"><td></td><td></td><td></td>
    ${cols.map((c) => {
      const s = items.length ? summary(c, items, ctx) : null;
      if (!s) return html`<td key=${c.id}></td>`;
      let body = null;
      if (s.kind === 'bar') body = html`<div class="sum-bar">${s.parts.map((p, i) => html`<span key=${i} title=${`${p.label}: ${p.n} (${Math.round((p.n / s.total) * 100)}%)`} style=${`width:${(p.n / s.total) * 100}%;background:${p.color}`}></span>`)}</div>`;
      else if (s.kind === 'num') body = html`<div class="sum-num">${s.text}<div class="faint" style="font-size:10px;font-weight:400">${s.fn || ''}</div></div>`;
      else if (s.kind === 'range') body = html`<div class="sum-num small">${s.from.slice(5)} → ${s.to.slice(5)}</div>`;
      else if (s.kind === 'progress') body = html`<div style="padding:0 8px"><span class="progress"><span style=${`width:${s.value}%`}></span><b>${s.value}%</b></span></div>`;
      else if (s.kind === 'people') body = html`<div class="sum-num">${s.ids.length} ${s.ids.length === 1 ? 'person' : 'people'}</div>`;
      return html`<td key=${c.id} class="has-sum">${body}</td>`;
    })}<td></td></tr>`;
}

function SubTable({ parent, subs, subCols, B, ctx, reload, openItem }) {
  return html`<table class="tbl sub">
    <colgroup><col style="width:280px" />${subCols.map((c) => html`<col key=${c.id} style=${`width:${widthOf(c)}px`} />`)}<col style="width:44px" /></colgroup>
    <thead><tr><th class="name-cell"><div class="th" style="justify-content:flex-start;padding-left:12px">Subitem</div></th>
      ${subCols.map((c) => html`<${ColumnHead} key=${c.id} col=${c} B=${B} cfg=${{}} setCfg=${() => {}} reload=${reload} sub />`)}
      <th class="add-col"><${AddColumn} B=${B} reload=${reload} scope="sub" /></th></tr></thead>
    <tbody>
      ${subs.map((s) => html`<tr key=${s.id}>
        <td class="name-cell"><div class="item-name"><span class="faint"><${Icon} name="sub" size="14" /></span>
          <span class="nm"><${InlineText} value=${s.name} onSave=${(v) => call('renameItem', s.id, v).then(reload, toastError)} /></span>
          <button class="open-btn" onClick=${() => openItem(s.id)}><${Icon} name="expand" size="12" />Open</button></div></td>
        ${subCols.map((c) => html`<td key=${c.id}><${Cell} col=${c} item=${s} B=${B} ctx=${ctx} onSet=${(v) => call('setValue', s.id, c.id, v).then(reload)} reload=${reload} compact /></td>`)}
        <td></td></tr>`)}
      <tr class="add-row"><td colspan=${subCols.length + 2}><${AddItem} B=${B} parentId=${parent.id} reload=${reload} placeholder="+ Add subitem" /></td></tr>
    </tbody></table>`;
}

function AddColumn({ B, reload, scope }) {
  const [a, open, close] = useAnchor();
  return html`<span><button aria-label="Add column" title="Add column" onClick=${open}><${Icon} name="plus" /></button>
    ${a ? html`<${ColumnPicker} anchor=${a} onClose=${close} onPick=${async (type) => {
      close();
      try { await call('addColumn', B.board.id, { type, scope, title: C.TYPES[type].label }); reload(); } catch (e) { toastError(e); }
    }} />` : null}</span>`;
}

function ColumnHead({ col, B, cfg, setCfg, reload, sub }) {
  const [a, open, close] = useAnchor();
  const [settings, setSettings] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const th = useRef(null);
  const sortDir = (cfg.sort || []).find((s) => s.column === col.id);
  const startResize = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widthOf(col);
    const colEl = th.current.closest('table').querySelectorAll('col')[[...th.current.parentNode.children].indexOf(th.current)];
    const move = (ev) => { if (colEl) colEl.style.width = `${Math.max(60, w0 + ev.clientX - x0)}px`; };
    const up = (ev) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      call('updateColumn', col.id, { width: Math.max(60, w0 + ev.clientX - x0) }).then(reload, toastError);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const siblings = B.columns.filter((c) => c.scope === col.scope);
  const move = async (dir) => {
    const i = siblings.findIndex((c) => c.id === col.id);
    const o = siblings[i + dir];
    if (!o) return;
    await call('updateColumn', col.id, { position: o.position });
    await call('updateColumn', o.id, { position: col.position });
    reload();
  };
  return html`<th ref=${th} draggable=${!renaming} title=${col.description || col.title}
      onDragStart=${(e) => { e.stopPropagation(); e.dataTransfer.setData('text/col', col.id); }}
      onDragOver=${(e) => { if ([...e.dataTransfer.types].includes('text/col')) { e.preventDefault(); e.stopPropagation(); th.current.classList.add('dragover'); } }}
      onDragLeave=${() => th.current.classList.remove('dragover')}
      onDrop=${async (e) => {
        const id = e.dataTransfer.getData('text/col');
        th.current.classList.remove('dragover');
        if (!id || id === col.id) return;
        e.preventDefault(); e.stopPropagation();
        const i = siblings.findIndex((c) => c.id === col.id);
        const prev = siblings[i - 1];
        const pos = prev ? (prev.position + col.position) / 2 : col.position - 1;
        await call('updateColumn', id, { position: pos }).catch(toastError);
        reload();
      }}>
    <div class="th" onClick=${open} onDblClick=${() => setRenaming(true)}>
      ${renaming ? html`<${InlineText} value=${col.title} autoFocus onSave=${(v) => { setRenaming(false); call('updateColumn', col.id, { title: v }).then(reload, toastError); }} />` : html`<span class="clip">${col.title}</span>`}
      ${sortDir ? html`<span class="faint">${sortDir.dir === 'desc' ? '↓' : '↑'}</span>` : null}
    </div>
    <span class="th-menu"><button class="btn icon ghost small" aria-label="Column menu" onClick=${open}><${Icon} name="more" size="14" /></button></span>
    <span class="resize" onMouseDown=${startResize}></span>
    ${a ? html`<${Menu} anchor=${a} onClose=${close} items=${[
      { head: `${C.TYPES[col.type] ? C.TYPES[col.type].label : col.type} column` },
      { label: 'Settings', icon: 'gear', onClick: () => setSettings(true) },
      { label: 'Rename', icon: 'edit', onClick: () => setRenaming(true) },
      !sub && { label: 'Sort ascending', icon: 'sort', onClick: () => setCfg({ ...cfg, sort: [{ column: col.id, dir: 'asc' }] }) },
      !sub && { label: 'Sort descending', icon: 'sort', onClick: () => setCfg({ ...cfg, sort: [{ column: col.id, dir: 'desc' }] }) },
      !sub && { label: 'Group by this column', icon: 'group', onClick: () => setCfg({ ...cfg, groupBy: col.id }) },
      !sub && { label: 'Filter by this column', icon: 'filter', onClick: () => setCfg({ ...cfg, filters: [...(cfg.filters || []), { column: col.id, op: 'is', value: [] }], showFilter: true }) },
      !sub && { label: 'Hide in this view', icon: 'hide', onClick: () => setCfg({ ...cfg, hidden: [...(cfg.hidden || []), col.id] }) },
      { label: 'Move left', icon: 'arrowLeft', onClick: () => move(-1) },
      { label: 'Move right', icon: 'arrowRight', onClick: () => move(1) },
      { label: 'Duplicate', icon: 'copy', onClick: () => call('duplicateColumn', col.id).then(reload, toastError) },
      { sep: true },
      { label: 'Delete column', icon: 'trash', danger: true, onClick: async () => { if (await ask({ title: 'Delete column?', body: `“${col.title}” and every value in it will be deleted.` })) call('deleteColumn', col.id).then(reload, toastError); } },
    ]} />` : null}
    ${settings ? html`<${ColumnSettings} col=${col} B=${B} onClose=${() => setSettings(false)} reload=${reload} />` : null}
  </th>`;
}

export function BulkBar({ B, selected, setSelected, reload }) {
  const [a, open, close] = useAnchor();
  const [b, openB, closeB] = useAnchor();
  const ids = [...selected];
  if (!ids.length) return null;
  const run = async (op, arg) => { try { await call('bulk', ids, op, arg); setSelected(new Set()); reload(); } catch (e) { toastError(e); } };
  const labelCols = B.columns.filter((c) => c.scope === 'item' && (C.LABEL_TYPES.has(c.type) || c.type === 'people'));
  return html`<div class="bulk-bar">
    <span class="count">${ids.length}</span><span class="small muted" style="margin-right:8px">selected</span>
    <button class="btn ghost small" onClick=${() => run('duplicate')}><${Icon} name="copy" size="14" /> Duplicate</button>
    <button class="btn ghost small" onClick=${open}><${Icon} name="arrowRight" size="14" /> Move to</button>
    <button class="btn ghost small" onClick=${openB}><${Icon} name="edit" size="14" /> Set</button>
    <button class="btn ghost small" onClick=${() => run('archive')}><${Icon} name="archive" size="14" /> Archive</button>
    <button class="btn ghost small" style="color:var(--bad)" onClick=${async () => { if (await ask({ title: `Delete ${plural(ids.length, 'item')}?`, body: 'This cannot be undone. Archive keeps them restorable.' })) run('delete'); }}><${Icon} name="trash" size="14" /> Delete</button>
    <button class="btn icon ghost small" aria-label="Clear selection" onClick=${() => setSelected(new Set())}><${Icon} name="x" size="14" /></button>
    ${a ? html`<${Menu} anchor=${a} onClose=${close} items=${B.groups.filter((g) => !g.archived).map((g) => ({ label: g.name, icon: 'group', onClick: () => run('move', { groupId: g.id }) }))} />` : null}
    ${b ? html`<${Menu} anchor=${b} onClose=${closeB} width=${260} items=${labelCols.flatMap((c) => [{ head: c.title }, ...(c.type === 'people'
      ? B.people.map((p) => ({ label: p.name, icon: 'user', onClick: () => run('set', { columnId: c.id, value: [p.id] }) }))
      : (c.settings.labels || []).map((l) => ({ label: l.label, icon: 'status', onClick: () => run('set', { columnId: c.id, value: l.id }) })))])} />` : null}
  </div>`;
}
