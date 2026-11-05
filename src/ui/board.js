// The board page: header, view tabs, toolbar (search, person, filter, sort,
// hide, group by) and the active view.
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { html, Icon, Menu, Popover, useAnchor, InlineText, Avatar, toastError, toast, ask, Spinner, Modal, saveFileName } from './lib.js';
import { call, saveAs, native } from './api.js';
import { C, ctxOf, applyFilters, applySort, VIEW_TYPES, FILTER_OPS, opsFor } from './model.js';
import { TableView, BulkBar } from './views/table.js';
import { KanbanView } from './views/kanban.js';
import { TimelineView } from './views/timeline.js';
import { CalendarView, ChartView, WorkloadView, FormView, FilesView } from './views/more.js';
import { AutomationCenter } from './automations-ui.js';
import { ActivityLog } from './item.js';

export function BoardPage({ boardId, openItem, refreshShell, nav, version }) {
  const [B, setB] = useState(null);
  const [err, setErr] = useState(null);
  const [viewId, setViewId] = useState(null);
  const [cfgs, setCfgs] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [autos, setAutos] = useState(false);
  const [activity, setActivity] = useState(false);
  const saveTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      const b = await call('getBoard', boardId);
      setB(b);
      setErr(null);
    } catch (e) { setErr(e); }
  }, [boardId]);
  useEffect(() => { setB(null); setViewId(null); setCfgs({}); setSelected(new Set()); load(); }, [boardId]);
  useEffect(() => { if (version) load(); }, [version]);
  const printRef = useRef(null);
  useEffect(() => {
    const h = () => printRef.current && printRef.current();
    window.addEventListener('bd-print', h);
    return () => window.removeEventListener('bd-print', h);
  }, []);

  if (err) return html`<div class="page"><div class="empty"><h3>This board could not be opened</h3><div>${err.message}</div></div></div>`;
  if (!B) return html`<div class="page"><${Spinner} /></div>`;

  const view = B.views.find((v) => v.id === viewId) || B.views[0];
  const cfg = cfgs[view.id] || view.config || {};
  const setCfg = (next) => {
    setCfgs({ ...cfgs, [view.id]: next });
    clearTimeout(saveTimer.current);
    const persist = { ...next };
    delete persist.showFilter;
    saveTimer.current = setTimeout(() => call('saveView', B.board.id, { id: view.id, config: persist }).catch(() => {}), 500);
  };
  const reload = () => { load(); refreshShell && refreshShell(); };
  const ctx = { ...ctxOf(B), meId: (B.people.find((p) => p.is_me) || {}).id };
  const filtered = applySort(B, cfg, applyFilters(B, cfg, ctx), ctx);
  const props = { B, cfg, setCfg, items: filtered, ctx, reload, openItem: (id, tab) => openItem(id, tab, reload), selected, setSelected };
  printRef.current = () => printBoard(B, view, cfg, filtered, ctx);
  const V = { table: TableView, kanban: KanbanView, timeline: TimelineView, calendar: CalendarView, chart: ChartView, workload: WorkloadView, form: FormView, files: FilesView }[view.type] || TableView;

  return html`<div class="page flush">
    <${BoardHeader} B=${B} printPdf=${() => printBoard(B, view, cfg, filtered, ctx)} reload=${reload} view=${view} setViewId=${setViewId} openAutos=${() => setAutos(true)} openActivity=${() => setActivity(true)} nav=${nav} />
    ${view.type !== 'form' ? html`<${Toolbar} B=${B} cfg=${cfg} setCfg=${setCfg} view=${view} reload=${reload} count=${filtered.length} />` : null}
    <div class="view-body">
      <${V} ...${props} />
      ${view.type === 'table' ? html`<${BulkBar} B=${B} selected=${selected} setSelected=${setSelected} reload=${reload} />` : null}
    </div>
    ${autos ? html`<${AutomationCenter} B=${B} onClose=${() => { setAutos(false); reload(); }} />` : null}
    ${activity ? html`<${ActivityDrawer} B=${B} onClose=${() => setActivity(false)} openItem=${props.openItem} />` : null}
  </div>`;
}

function BoardHeader({ B, printPdf, reload, view, setViewId, openAutos, openActivity, nav }) {
  const [more, openMore, closeMore] = useAnchor();
  const [addV, openAddV, closeAddV] = useAnchor();
  const [vmenu, setVmenu] = useState(null);
  const [renameV, setRenameV] = useState(null);
  const [moveWs, setMoveWs] = useState(false);
  const [saveTpl, setSaveTpl] = useState(false);
  const [fav, setFav] = useState(false);
  const b = B.board;
  useEffect(() => { call('favorites').then((l) => setFav(l.some((f) => f.kind === 'board' && f.id === b.id)), () => {}); }, [b.id]);
  const toggleFav = async () => { try { const l = await call('toggleFavorite', 'board', b.id); setFav(l.some((f) => f.kind === 'board' && f.id === b.id)); reload(); } catch (e) { toastError(e); } };
  const exportX = async () => { try { const bytes = await call('exportXlsx', [b.id]); await saveAs(`${saveFileName(b.name)}.xlsx`, bytes, [{ name: 'Excel', extensions: ['xlsx'] }]); } catch (e) { toastError(e); } };
  const exportC = async () => { try { await saveAs(`${saveFileName(b.name)}.csv`, await call('exportCsv', b.id), [{ name: 'CSV', extensions: ['csv'] }]); } catch (e) { toastError(e); } };
  const exportB = async () => { try { await saveAs(`${saveFileName(b.name)}.boardenda.json`, await call('exportBoardFile', b.id), [{ name: 'Boardenda board', extensions: ['json'] }]); } catch (e) { toastError(e); } };
  const addView = async (type) => {
    try { const id = await call('saveView', b.id, { name: VIEW_TYPES[type].label, type }); await reload(); setViewId(id); } catch (e) { toastError(e); }
  };
  return html`<div class="board-head">
    <div class="row">
      <div class="grow">
        <div class="crumbs"><a onClick=${() => nav('home')}>${B.workspace ? B.workspace.name : 'Workspace'}</a>${b.folder ? html`<span>/ ${b.folder}</span>` : null}</div>
        <div class="board-title row" style="gap:6px"><${InlineText} value=${b.name} onSave=${(v) => call('updateBoard', b.id, { name: v }).then(reload, toastError)} />
          <button class=${`fav-btn ${fav ? 'on' : ''}`} title=${fav ? 'Remove from favorites' : 'Add to favorites'} aria-label=${fav ? 'Remove from favorites' : 'Add to favorites'} onClick=${toggleFav}><${Icon} name="star" size=${18} /></button></div>
        <div class="board-desc"><${InlineText} value=${b.description} placeholder="Add a board description" onSave=${(v) => call('updateBoard', b.id, { description: v }).then(reload, toastError)} /></div>
      </div>
      <div class="row" style="align-self:flex-start">
        <span class="avatars">${B.people.slice(0, 4).map((p) => html`<${Avatar} key=${p.id} person=${p} size=${28} />`)}</span>
        <button class="btn" onClick=${openActivity}><${Icon} name="history" /> Activity</button>
        <button class="btn" onClick=${openAutos}><${Icon} name="bolt" /> Automate${B.automations ? html` <span class="chip" style="padding:0 6px">${B.automations}</span>` : null}</button>
        <button class="btn icon" aria-label="Board menu" onClick=${openMore}><${Icon} name="more" /></button>
      </div>
    </div>
    <div class="tabs">
      ${B.views.map((v) => html`<button key=${v.id} class=${`tab ${v.id === view.id ? 'on' : ''}`} onClick=${() => setViewId(v.id)} onContextMenu=${(e) => { e.preventDefault(); setVmenu({ el: e.currentTarget, v }); }} onDblClick=${() => setRenameV(v)}>
        <${Icon} name=${(VIEW_TYPES[v.type] || {}).icon || 'table'} size="16" />${renameV && renameV.id === v.id ? html`<${InlineText} value=${v.name} autoFocus onSave=${(n) => { setRenameV(null); call('saveView', b.id, { id: v.id, name: n }).then(reload, toastError); }} />` : v.name}
        ${v.id === view.id ? html`<span role="button" class="faint" style="margin-left:2px" onClick=${(e) => { e.stopPropagation(); setVmenu({ el: e.currentTarget, v }); }}><${Icon} name="more" size="14" /></span>` : null}</button>`)}
      <button class="tab" onClick=${openAddV}><${Icon} name="plus" size="16" /> Add view</button>
    </div>
    ${addV ? html`<${Menu} anchor=${addV} onClose=${closeAddV} items=${Object.entries(VIEW_TYPES).map(([k, t]) => ({ label: t.label, icon: t.icon, onClick: () => addView(k) }))} />` : null}
    ${vmenu ? html`<${Menu} anchor=${vmenu.el} onClose=${() => setVmenu(null)} items=${[
      { label: 'Rename view', icon: 'edit', onClick: () => setRenameV(vmenu.v) },
      { label: 'Duplicate view', icon: 'copy', onClick: async () => { const id = await call('saveView', b.id, { name: `${vmenu.v.name} (copy)`, type: vmenu.v.type, config: vmenu.v.config }).catch(toastError); await reload(); setViewId(id); } },
      { label: 'Reset filters and sort', icon: 'refresh', onClick: () => call('saveView', b.id, { id: vmenu.v.id, config: {} }).then(reload, toastError) },
      { sep: true },
      { label: 'Delete view', icon: 'trash', danger: true, onClick: () => call('deleteView', vmenu.v.id).then(() => { setViewId(null); reload(); }, toastError) },
    ]} />` : null}
    ${more ? html`<${Menu} anchor=${more} onClose=${closeMore} align="right" width=${250} items=${[
      { label: 'Export to Excel', icon: 'download', onClick: exportX },
      { label: 'Export to CSV', icon: 'download', onClick: exportC },
      { label: 'Save as board file', icon: 'file', hint: 'share or back up', onClick: exportB },
      { label: 'Print or save as PDF', icon: 'print', hint: 'Ctrl+P', onClick: printPdf },
      { sep: true },
      { label: 'Duplicate with items', icon: 'copy', onClick: () => call('duplicateBoard', b.id, { withItems: true }).then((id) => { toast('Board duplicated'); nav('board', id); }, toastError) },
      { label: 'Duplicate structure only', icon: 'copy', onClick: () => call('duplicateBoard', b.id, { withItems: false }).then((id) => { toast('Board duplicated'); nav('board', id); }, toastError) },
      { label: 'Save as template…', icon: 'spark', hint: 'reuse this setup', onClick: () => setSaveTpl(true) },
      { label: 'Move to workspace or folder', icon: 'folder', onClick: () => setMoveWs('move') },
      { label: 'Board settings', icon: 'gear', hint: `items: ${b.item_noun}`, onClick: () => setMoveWs('settings') },
      { sep: true },
      { label: 'Archive board', icon: 'archive', onClick: () => call('archiveBoard', b.id, true).then(() => { toast('Board archived. Restore it from Archive.'); nav('home'); }, toastError) },
      { label: 'Delete board', icon: 'trash', danger: true, onClick: async () => { if (await ask({ title: 'Delete board?', body: `“${b.name}” moves to the trash with its items, updates and files. You can restore it for 30 days.` })) call('deleteBoard', b.id).then(() => nav('home'), toastError); } },
    ]} />` : null}
    ${moveWs ? html`<${BoardSettings} B=${B} mode=${moveWs} onClose=${() => setMoveWs(false)} reload=${reload} />` : null}
    ${saveTpl ? html`<${SaveTemplate} B=${B} onClose=${() => setSaveTpl(false)} reload=${reload} />` : null}
  </div>`;
}

const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The current view's items as a printable page, saved as PDF in the desktop app. */
export async function printBoard(B, view, cfg, items, ctx) {
  const hidden = new Set(cfg.hidden || []);
  const cols = B.columns.filter((c) => c.scope === 'item' && !hidden.has(c.id) && c.type !== 'button').slice(0, 9);
  const groups = B.groups.filter((g) => !g.archived);
  const cell = (c, it) => {
    const v = it.values[c.id];
    if (C.LABEL_TYPES.has(c.type)) { const l = C.labelOf(c, v); return l ? `<span class="l" style="background:${C.colorHex(l.color)}">${esc(l.label)}</span>` : ''; }
    return esc(C.textOf(c, v, ctx));
  };
  const body = groups.map((g) => {
    const its = items.filter((i) => i.group_id === g.id);
    if (!its.length) return '';
    return `<h2 style="color:${C.colorHex(g.color)}">${esc(g.name)} <small>${its.length}</small></h2><table><thead><tr><th>${esc(B.board.item_noun || 'Item')}</th>${cols.map((c) => `<th>${esc(c.title)}</th>`).join('')}</tr></thead>
      <tbody>${its.map((it) => `<tr><td style="border-left:4px solid ${C.colorHex(g.color)}">${esc(it.name)}</td>${cols.map((c) => `<td>${cell(c, it)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }).join('');
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(B.board.name)}</title><style>
    body{font:12px/1.4 "Segoe UI",system-ui,sans-serif;color:#1d1c2b;margin:28px}h1{font-size:22px;margin:0}p.d{color:#6b6a85;margin:4px 0 14px}
    h2{font-size:14px;margin:18px 0 6px}h2 small{color:#8a89a3;font-weight:400}table{width:100%;border-collapse:collapse;page-break-inside:auto}tr{page-break-inside:avoid}
    th{text-align:left;font-size:11px;color:#6b6a85;border-bottom:1px solid #ddd;padding:4px 6px}td{border-bottom:1px solid #eee;padding:4px 6px;vertical-align:top}
    .l{color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;white-space:nowrap}footer{margin-top:18px;color:#8a89a3;font-size:10px}</style></head><body>
    <h1>${esc(B.board.name)}</h1><p class="d">${esc(B.workspace ? B.workspace.name : '')} · ${esc(view.name)} · ${items.length} ${esc(B.board.item_noun || 'item')}s${(cfg.filters || []).length || cfg.search ? ' (filtered)' : ''}</p>
    ${body}<footer>Printed from Boardenda on ${new Date().toLocaleString()}</footer></body></html>`;
  try { await native('savePdf', { name: `${saveFileName(B.board.name)}.pdf`, html: page }); } catch (e) { toastError(e); }
}

function SaveTemplate({ B, onClose, reload }) {
  const [name, setName] = useState(B.board.name);
  const [desc, setDesc] = useState(B.board.description || '');
  const [withItems, setWithItems] = useState(false);
  const save = async () => {
    try { await call('saveAsTemplate', B.board.id, { name, description: desc, withItems }); toast('Template saved. Find it under New board → Your templates.'); reload(); onClose(); } catch (e) { toastError(e); }
  };
  return html`<${Modal} title="Save as template" onClose=${onClose}>
    <p class="muted small">Groups, columns, views and automations are saved. New boards made from it start the same way.</p>
    <label class="field mt">Template name<input class="input" autoFocus value=${name} onInput=${(e) => setName(e.target.value)} /></label>
    <label class="field mt">Description<input class="input" value=${desc} onInput=${(e) => setDesc(e.target.value)} placeholder="What is this template for?" /></label>
    <label class="check mt2"><input type="checkbox" checked=${withItems} onChange=${(e) => setWithItems(e.target.checked)} /> Include the current items</label>
    <div class="row mt2"><span class="grow"></span><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${!name.trim()} onClick=${save}>Save template</button></div>
  </${Modal}>`;
}

function BoardSettings({ B, mode, onClose, reload }) {
  const [ws, setWs] = useState([]);
  const [wsId, setWsId] = useState(B.board.workspace_id);
  const [folder, setFolder] = useState(B.board.folder || '');
  const [noun, setNoun] = useState(B.board.item_noun || 'item');
  useEffect(() => { call('bootstrap').then((b) => setWs(b.workspaces), toastError); }, []);
  const save = async () => { try { await call('updateBoard', B.board.id, { workspaceId: wsId, folder, itemNoun: noun }); reload(); onClose(); } catch (e) { toastError(e); } };
  return html`<${Modal} title="Board settings" onClose=${onClose}>
    <div class="col" style="gap:12px">
      <label class="field">Workspace<select class="input" value=${wsId} onChange=${(e) => setWsId(e.target.value)}>${ws.map((w) => html`<option value=${w.id}>${w.name}</option>`)}</select></label>
      <label class="field">Folder (optional)<input class="input" value=${folder} onInput=${(e) => setFolder(e.target.value)} placeholder="e.g. Q4 projects" /></label>
      <label class="field">What are the items called?<input class="input" value=${noun} onInput=${(e) => setNoun(e.target.value)} placeholder="task, deal, bug…" /></label>
      <div class="row" style="justify-content:flex-end"><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" onClick=${save}>Save</button></div>
    </div></${Modal}>`;
  void mode;
}

function Toolbar({ B, cfg, setCfg, view, reload, count }) {
  const [pa, openP, closeP] = useAnchor();
  const [fa, openF, closeF] = useAnchor();
  const [sa, openS, closeS] = useAnchor();
  const [ha, openH, closeH] = useAnchor();
  const [ga, openG, closeG] = useAnchor();
  const [na, openN, closeN] = useAnchor();
  const [ca, openC, closeC] = useAnchor();
  const filterBtn = useRef(null);
  useEffect(() => { if (cfg.showFilter && filterBtn.current) { openF({ currentTarget: filterBtn.current }); setCfg({ ...cfg, showFilter: false }); } }, [cfg.showFilter]);
  const nFilters = (cfg.filters || []).filter((f) => f.column).length;
  const person = cfg.person && B.people.find((p) => p.id === cfg.person);
  const firstGroup = B.groups.find((g) => !g.archived);
  const newItem = async () => {
    try { await call('addItem', B.board.id, { groupId: firstGroup && firstGroup.id, top: true, name: `New ${B.board.item_noun || 'item'}` }); reload(); } catch (e) { toastError(e); }
  };
  const itemCols = B.columns.filter((c) => c.scope === 'item');
  return html`<div class="toolbar">
    <div class="btn-group"><button class="btn primary" onClick=${newItem}><${Icon} name="plus" /> New ${B.board.item_noun || 'item'}</button>
      <button class="btn primary icon" aria-label="More new options" onClick=${openN}><${Icon} name="chev" size="14" /></button></div>
    ${na ? html`<${Menu} anchor=${na} onClose=${closeN} items=${[
      { label: 'New group of items', icon: 'group', onClick: () => call('addGroup', B.board.id, { top: true }).then(reload, toastError) },
      { label: 'Import items from Excel or CSV', icon: 'upload', onClick: () => importInto(B, reload) },
    ]} />` : null}
    <input class="input search" placeholder="Search this board" value=${cfg.search || ''} onInput=${(e) => setCfg({ ...cfg, search: e.target.value })} />
    <button class=${`btn ghost ${person ? 'active' : ''}`} onClick=${openP}>${person ? html`<${Avatar} person=${person} size=${20} />` : html`<${Icon} name="person" />`} ${person ? person.name.split(' ')[0] : 'Person'}</button>
    <button ref=${filterBtn} class=${`btn ghost ${nFilters ? 'active' : ''}`} onClick=${openF}><${Icon} name="filter" /> Filter${nFilters ? ` / ${nFilters}` : ''}</button>
    <button class=${`btn ghost ${(cfg.sort || []).length ? 'active' : ''}`} onClick=${openS}><${Icon} name="sort" /> Sort${(cfg.sort || []).length ? ` / ${(cfg.sort || []).length}` : ''}</button>
    ${view.type === 'table' ? html`<button class=${`btn ghost ${(cfg.hidden || []).length ? 'active' : ''}`} onClick=${openH}><${Icon} name="hide" /> Hide${(cfg.hidden || []).length ? ` / ${(cfg.hidden || []).length}` : ''}</button>
      <button class=${`btn ghost ${cfg.groupBy ? 'active' : ''}`} onClick=${openG}><${Icon} name="group" /> Group by</button>` : null}
    ${['table', 'kanban', 'timeline'].includes(view.type) ? html`<button class=${`btn ghost ${(cfg.colors || []).length ? 'active' : ''}`} onClick=${openC}><${Icon} name="palette" /> Colour${(cfg.colors || []).length ? ` / ${(cfg.colors || []).length}` : ''}</button>` : null}
    <span class="grow"></span>
    <span class="small faint">${count} shown</span>
    ${ca ? html`<${Popover} anchor=${ca} onClose=${closeC} width=${780}><${ColorRules} B=${B} cfg=${cfg} setCfg=${setCfg} /></${Popover}>` : null}
    ${pa ? html`<${Popover} anchor=${pa} onClose=${closeP} width=${260}><div class="pad col" style="gap:4px"><b class="small">Show items assigned to</b>
      ${B.people.map((p) => html`<button key=${p.id} class=${`mi ${cfg.person === p.id ? 'active' : ''}`} onClick=${() => { setCfg({ ...cfg, person: cfg.person === p.id ? null : p.id }); closeP(); }}><${Avatar} person=${p} size=${22} />${p.name}${p.is_me ? ' (you)' : ''}</button>`)}
      ${cfg.person ? html`<button class="btn small" onClick=${() => { setCfg({ ...cfg, person: null }); closeP(); }}>Clear</button>` : null}</div></${Popover}>` : null}
    ${fa ? html`<${Popover} anchor=${fa} onClose=${closeF} width=${620}><${FilterBuilder} B=${B} cfg=${cfg} setCfg=${setCfg} /></${Popover}>` : null}
    ${sa ? html`<${Popover} anchor=${sa} onClose=${closeS} width=${400}><${SortBuilder} B=${B} cfg=${cfg} setCfg=${setCfg} /></${Popover}>` : null}
    ${ha ? html`<${Popover} anchor=${ha} onClose=${closeH} width=${260}><div class="pad col" style="gap:2px"><b class="small">Columns shown in this view</b>
      ${itemCols.map((c) => html`<label class="check mi" key=${c.id}><input type="checkbox" checked=${!(cfg.hidden || []).includes(c.id)} onChange=${(e) => setCfg({ ...cfg, hidden: e.target.checked ? (cfg.hidden || []).filter((x) => x !== c.id) : [...(cfg.hidden || []), c.id] })} /><${Icon} name=${C.TYPES[c.type].icon} />${c.title}</label>`)}
      <div class="row"><button class="btn small" onClick=${() => setCfg({ ...cfg, hidden: [] })}>Show all</button></div></div></${Popover}>` : null}
    ${ga ? html`<${Menu} anchor=${ga} onClose=${closeG} items=${[
      { label: 'Board groups', icon: 'group', active: !cfg.groupBy, onClick: () => setCfg({ ...cfg, groupBy: null }) },
      { sep: true },
      ...itemCols.filter((c) => C.LABEL_TYPES.has(c.type) || ['people', 'team', 'date', 'timeline', 'dropdown', 'text', 'rating', 'formula', 'country', 'checkbox', 'numbers', 'mirror', 'connect'].includes(c.type))
        .map((c) => ({ label: c.title, icon: C.TYPES[c.type].icon, active: cfg.groupBy === c.id, onClick: () => setCfg({ ...cfg, groupBy: c.id }) })),
    ]} />` : null}
  </div>`;
}

async function importInto(B, reload) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,.xlsx,.tsv,.txt';
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      const r = await call('importTable', { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), boardId: B.board.id });
      toast(`Imported ${r.created} items`);
      reload();
    } catch (e) { toastError(e); }
  };
  input.click();
}

function ruleValue(B, cols, f, setF) {
  if (['empty', 'not_empty', 'today', 'this_week', 'overdue'].includes(f.op)) return html`<span></span>`;
  if (f.column === '__group') {
    return html`<select class="input" value=${Array.isArray(f.value) ? f.value[0] : f.value} onChange=${(e) => setF({ value: [e.target.value] })}><option value="">Choose…</option>${B.groups.map((g) => html`<option value=${g.id}>${g.name}</option>`)}</select>`;
  }
  const col = cols.find((c) => c.id === f.column);
  if (!col) return html`<input class="input" value=${f.value || ''} onInput=${(e) => setF({ value: e.target.value })} />`;
  const multi = (opts) => html`<select class="input" value=${Array.isArray(f.value) ? f.value[0] || '' : f.value || ''} onChange=${(e) => setF({ value: e.target.value ? [e.target.value] : [] })}><option value="">Choose…</option>${opts.map((o) => html`<option value=${o.value}>${o.label}</option>`)}</select>`;
  if (C.LABEL_TYPES.has(col.type)) return multi([...(col.settings.labels || []).map((l) => ({ value: l.id, label: l.label })), { value: '__empty', label: '(empty)' }]);
  if (col.type === 'people') return multi([{ value: '__me', label: 'Me' }, ...B.people.map((p) => ({ value: p.id, label: p.name }))]);
  if (col.type === 'team') return multi((B.teams || []).map((t) => ({ value: t.id, label: t.name })));
  if (col.type === 'dropdown') return multi((col.settings.options || []).map((o) => ({ value: o.id, label: o.label })));
  if (col.type === 'country') return multi(C.COUNTRIES.map(([k, n]) => ({ value: k, label: n })));
  if (['before', 'after'].includes(f.op)) return html`<input class="input" type="date" value=${f.value || ''} onInput=${(e) => setF({ value: e.target.value })} />`;
  return html`<input class="input" value=${f.value || ''} onInput=${(e) => setF({ value: e.target.value })} />`;
}

const RULE_COLORS = ['coral', 'tangerine', 'sun', 'mint', 'teal', 'sky', 'indigo', 'grape', 'rose', 'slate'];

/** Conditional colouring: rows (and cards and bars) that match a rule take its colour. */
function ColorRules({ B, cfg, setCfg }) {
  const rules = cfg.colors || [];
  const cols = B.columns.filter((c) => c.scope === 'item');
  const setR = (i, patch) => setCfg({ ...cfg, colors: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const palette = RULE_COLORS.filter((c) => C.COLOR[c]);
  return html`<div class="pad">
    <div class="row between" style="margin-bottom:4px"><b>Colour items when…</b>${rules.length ? html`<button class="btn ghost small" onClick=${() => setCfg({ ...cfg, colors: [] })}>Clear all</button>` : null}</div>
    <div class="small muted" style="margin-bottom:8px">The first matching rule wins. Applies to rows, kanban cards and Gantt bars in this view.</div>
    ${rules.map((r, i) => html`<div class="filter-row color-rule" key=${i}>
      <select class="input" value=${r.column} onChange=${(e) => setR(i, { column: e.target.value, op: opsFor(cols.find((c) => c.id === e.target.value))[0], value: [] })}>
        <option value="__name">Name</option><option value="__group">Group</option>${cols.map((c) => html`<option value=${c.id}>${c.title}</option>`)}</select>
      <select class="input" value=${r.op} onChange=${(e) => setR(i, { op: e.target.value })}>${(r.column === '__name' ? ['contains', 'is'] : r.column === '__group' ? ['is', 'is_not'] : opsFor(cols.find((c) => c.id === r.column))).map((o) => html`<option value=${o}>${FILTER_OPS[o]}</option>`)}</select>
      ${ruleValue(B, cols, r, (patch) => setR(i, patch))}
      <span class="swatches">${palette.map((c) => html`<button key=${c} class="swatch sm" title=${c} aria-label=${`Colour ${c}`} style=${`background:${C.colorHex(c)};${r.color === c ? 'outline:2px solid var(--text);outline-offset:1px' : ''}`} onClick=${() => setR(i, { color: c })}></button>`)}</span>
      <button class="btn icon ghost small" aria-label="Remove rule" onClick=${() => setCfg({ ...cfg, colors: rules.filter((_, j) => j !== i) })}><${Icon} name="x" size="14" /></button></div>`)}
    <button class="btn small" onClick=${() => { const c = cols.find((x) => C.LABEL_TYPES.has(x.type)) || cols[0]; setCfg({ ...cfg, colors: [...rules, { column: c ? c.id : '__name', op: c ? opsFor(c)[0] : 'contains', value: [], color: 'coral' }] }); }}><${Icon} name="plus" size="14" /> Add rule</button>
  </div>`;
}

function FilterBuilder({ B, cfg, setCfg }) {
  const filters = cfg.filters || [];
  const cols = B.columns.filter((c) => c.scope === 'item');
  const setF = (i, patch) => setCfg({ ...cfg, filters: filters.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const valueInput = (f, i) => ruleValue(B, cols, f, (patch) => setF(i, patch));
  return html`<div class="pad">
    <div class="row between" style="margin-bottom:8px"><b>Filter items</b>${filters.length ? html`<button class="btn ghost small" onClick=${() => setCfg({ ...cfg, filters: [] })}>Clear all</button>` : null}</div>
    ${filters.map((f, i) => html`<div class="filter-row" key=${i}>
      <span class="small muted">${i === 0 ? 'Where' : html`<select class="input" style="height:28px;padding:0 4px" value=${cfg.match || 'all'} onChange=${(e) => setCfg({ ...cfg, match: e.target.value })}><option value="all">and</option><option value="any">or</option></select>`}</span>
      <select class="input" value=${f.column} onChange=${(e) => setF(i, { column: e.target.value, op: opsFor(cols.find((c) => c.id === e.target.value))[0], value: [] })}>
        <option value="__name">Name</option><option value="__group">Group</option>${cols.map((c) => html`<option value=${c.id}>${c.title}</option>`)}</select>
      <select class="input" value=${f.op} onChange=${(e) => setF(i, { op: e.target.value })}>${(f.column === '__name' ? ['contains', 'is'] : f.column === '__group' ? ['is', 'is_not'] : opsFor(cols.find((c) => c.id === f.column))).map((o) => html`<option value=${o}>${FILTER_OPS[o]}</option>`)}</select>
      ${valueInput(f, i)}
      <button class="btn icon ghost small" aria-label="Remove" onClick=${() => setCfg({ ...cfg, filters: filters.filter((_, j) => j !== i) })}><${Icon} name="x" size="14" /></button></div>`)}
    <button class="btn small" onClick=${() => { const c = cols.find((x) => C.LABEL_TYPES.has(x.type)) || cols[0]; setCfg({ ...cfg, filters: [...filters, { column: c ? c.id : '__name', op: c ? opsFor(c)[0] : 'contains', value: [] }] }); }}><${Icon} name="plus" size="14" /> Add filter</button>
  </div>`;
}

function SortBuilder({ B, cfg, setCfg }) {
  const sort = cfg.sort || [];
  const cols = B.columns.filter((c) => c.scope === 'item');
  return html`<div class="pad col" style="gap:6px"><b>Sort items</b>
    ${sort.map((s, i) => html`<div class="row" key=${i}>
      <select class="input grow" value=${s.column} onChange=${(e) => setCfg({ ...cfg, sort: sort.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })}><option value="__name">Name</option>${cols.map((c) => html`<option value=${c.id}>${c.title}</option>`)}</select>
      <select class="input" style="width:130px" value=${s.dir} onChange=${(e) => setCfg({ ...cfg, sort: sort.map((x, j) => (j === i ? { ...x, dir: e.target.value } : x)) })}><option value="asc">Ascending</option><option value="desc">Descending</option></select>
      <button class="btn icon ghost small" aria-label="Remove" onClick=${() => setCfg({ ...cfg, sort: sort.filter((_, j) => j !== i) })}><${Icon} name="x" size="14" /></button></div>`)}
    <div class="row"><button class="btn small" onClick=${() => setCfg({ ...cfg, sort: [...sort, { column: '__name', dir: 'asc' }] })}><${Icon} name="plus" size="14" /> Add sort</button>
      ${sort.length ? html`<button class="btn ghost small" onClick=${() => setCfg({ ...cfg, sort: [] })}>Clear</button>` : null}</div>
    <div class="small faint">Sorting a view shows items in that order. Drag and drop reorders the board when no sort is set.</div></div>`;
}

function ActivityDrawer({ B, onClose, openItem }) {
  const [rows, setRows] = useState(null);
  const [tab, setTab] = useState('activity');
  const [log, setLog] = useState(null);
  useEffect(() => { call('activity', { boardId: B.board.id, limit: 400 }).then(setRows, toastError); call('automationLog', { boardId: B.board.id }).then(setLog, toastError); }, []);
  return html`<div><div class="scrim" onClick=${onClose}></div><aside class="drawer">
    <div class="hd row between"><h2>Board activity</h2><button class="btn ghost icon" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
    <div class="ptabs" style="margin:0;padding:0 20px">${[['activity', 'Changes'], ['autos', 'Automation runs']].map(([k, l]) => html`<button key=${k} class=${`tab ${tab === k ? 'on' : ''}`} onClick=${() => setTab(k)}>${l}</button>`)}</div>
    <div class="bd">${tab === 'activity' ? (rows ? html`<${ActivityLog} rows=${rows} people=${B.people} openItem=${openItem} />` : html`<${Spinner} />`)
      : log ? (log.length ? log.map((l) => html`<div class="act-row" key=${l.id}><span class="small muted">${l.ts.slice(0, 16).replace('T', ' ')}</span><span><b>${l.name || 'Automation'}</b>${l.item_name ? ` on ${l.item_name}` : ''}: <span style=${l.ok ? '' : 'color:var(--bad)'}>${l.summary || (l.ok ? 'ran' : 'failed')}</span></span></div>`) : html`<div class="muted">No automation has run on this board yet.</div>`) : html`<${Spinner} />`}</div>
  </aside></div>`;
}
