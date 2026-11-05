// Dashboards: widgets over one or more boards.
import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Modal, Menu, useAnchor, toastError, Spinner, InlineText, Avatar, shortDate, todayIso, diffDays, addDaysIso, ask } from './lib.js';
import { call } from './api.js';
import { Chart } from './views/more.js';

export function DashboardPage({ id, boot, nav, openItem, refreshShell, version }) {
  const [d, setD] = useState(null);
  const [edit, setEdit] = useState(null);
  const [boards, setBoards] = useState(false);
  const load = () => call('getDashboard', id).then(setD, toastError);
  useEffect(() => { setD(null); load(); }, [id, version]);
  if (!d) return html`<div class="page"><${Spinner} /></div>`;
  const allBoards = boot.workspaces.flatMap((w) => w.boards);
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1><${InlineText} value=${d.name} onSave=${(v) => call('saveDashboard', { id, name: v }).then(() => { load(); refreshShell(); }, toastError)} /></h1>
      <div class="small muted mt">Showing ${d.boards.length ? d.boards.map((b) => b.name).join(', ') : 'no boards yet'} · <a onClick=${() => setBoards(true)}>Choose boards</a></div></div>
      <button class=${`fav-btn ${(boot.favorites || []).some((f) => f.kind === 'dashboard' && f.id === id) ? 'on' : ''}`} title="Favorite" aria-label="Toggle favorite" onClick=${() => call('toggleFavorite', 'dashboard', id).then(refreshShell, toastError)}><${Icon} name="star" size=${18} /></button>
      <button class="btn primary" onClick=${() => setEdit({ type: 'numbers', size: 's', config: {} })}><${Icon} name="plus" /> Add widget</button>
      <button class="btn icon" aria-label="Delete dashboard" onClick=${async () => { if (await ask({ title: 'Delete dashboard?', body: 'Boards and items are not affected.' })) call('deleteDashboard', id).then(() => { refreshShell(); nav('home'); }, toastError); }}><${Icon} name="trash" /></button></div>
    ${!d.widgets.length ? html`<div class="empty"><${Icon} name="dashboard" /><h3>Add your first widget</h3><div>Numbers, charts, progress, workload, timelines and lists across the boards you choose.</div></div>` : null}
    <div class="dash">${d.widgets.map((w) => html`<${Widget} key=${w.id} w=${w} boot=${boot} onEdit=${() => setEdit(w)} reload=${load} openItem=${openItem} nav=${nav} />`)}</div>
    ${edit ? html`<${WidgetEditor} w=${edit} d=${d} allBoards=${allBoards} onClose=${() => setEdit(null)} onSaved=${() => { setEdit(null); load(); }} />` : null}
    ${boards ? html`<${Modal} title="Boards on this dashboard" onClose=${() => setBoards(false)}><${BoardPicker} value=${d.boardIds} allBoards=${allBoards} onSave=${(ids) => call('saveDashboard', { id, boardIds: ids }).then(() => { setBoards(false); load(); refreshShell(); }, toastError)} /></${Modal}>` : null}
  </div>`;
}

function BoardPicker({ value, allBoards, onSave }) {
  const [sel, setSel] = useState(value || []);
  return html`<div class="col">${allBoards.map((b) => html`<label class="check" key=${b.id}><input type="checkbox" checked=${sel.includes(b.id)} onChange=${(e) => setSel(e.target.checked ? [...sel, b.id] : sel.filter((x) => x !== b.id))} />${b.name}</label>`)}
    <div class="row" style="justify-content:flex-end"><button class="btn primary" onClick=${() => onSave(sel)}>Save</button></div></div>`;
}

function fmtNum(v, unit, side) {
  const n = Math.round(v * 100) / 100;
  const s = Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString();
  return unit ? (side === 'left' ? `${unit}${s}` : `${s} ${unit}`) : s;
}

function Widget({ w, onEdit, reload, openItem, nav }) {
  const [a, open, close] = useAnchor();
  const D = w.data;
  let body;
  if (w.error) body = html`<div class="small" style="color:var(--bad)">${w.error}</div>`;
  else if (!D) body = html`<${Spinner} />`;
  else switch (w.type) {
    case 'numbers': body = html`<div class="big-num">${fmtNum(D.value, D.unit, D.unitSide)}</div><div class="small muted">${{ sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum', count: 'Count' }[D.fn]}</div>`; break;
    case 'battery': body = html`<div class="row" style="align-items:baseline"><span class="big-num" style="font-size:34px">${D.percent}%</span><span class="muted small">done · ${D.done} of ${D.total}</span></div>
      <div class="battery mt2">${D.parts.map((p) => html`<span key=${p.label} title=${`${p.label}: ${p.n}`} style=${`width:${(p.n / Math.max(1, D.total)) * 100}%;background:${p.color}`}></span>`)}</div>
      <div class="row wrap small mt2" style="gap:10px">${D.parts.map((p) => html`<span key=${p.label}><i class="swatch" style=${`background:${p.color};width:9px;height:9px;margin-right:4px`}></i>${p.label} ${p.n}</span>`)}</div>`; break;
    case 'chart': body = html`<${Chart} kind=${D.chart} series=${D.series} height=${200} />`; break;
    case 'workload': body = D.people.length ? html`<table class="wl"><thead><tr><th>Person</th><th>Open</th><th>Overdue</th><th>Done</th><th>Effort</th><th style="width:40%">Load</th></tr></thead><tbody>
      ${D.people.map((p) => { const max = Math.max(...D.people.map((x) => x.open), 1); return html`<tr key=${p.id}><td><span class="row"><${Avatar} person=${p} size=${22} />${p.name}</span></td><td>${p.open}</td><td style=${p.overdue ? 'color:var(--bad);font-weight:700' : ''}>${p.overdue}</td><td>${p.done}</td><td>${p.effort ? `${Math.round(p.effort)}h` : '—'}</td>
        <td><div class="battery" style="height:12px"><span style=${`width:${(p.open / max) * 100}%;background:${p.overdue ? 'var(--bad)' : 'var(--brand)'}`}></span></div></td></tr>`; })}</tbody></table>` : html`<div class="muted small">No one is assigned yet.</div>`; break;
    case 'list': body = D.items.length ? html`<div>${D.items.map((x) => html`<div class="row" key=${x.id} style="padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer" onClick=${() => openItem(x.id)}>
      <span class="grow" style="min-width:0"><span class="clip">${x.name}</span><span class="small muted">${x.boardName}</span></span>
      ${x.status ? html`<span class="lbl" style=${`background:${x.status.color}22;color:${x.status.color}`}>${x.status.label}</span>` : null}
      <span class="small" style=${`width:70px;text-align:right;${x.overdue ? 'color:var(--bad);font-weight:700' : ''}`}>${x.due ? shortDate(x.due) : ''}</span></div>`)}</div>` : html`<div class="muted small">Nothing due.</div>`; break;
    case 'timeline': {
      if (!D.items.length) { body = html`<div class="muted small">No dated items.</div>`; break; }
      const from = D.items[0].start;
      const to = D.items.reduce((m, x) => (x.end > m ? x.end : m), from);
      const span = Math.max(1, diffDays(from, to) + 1);
      const t = todayIso();
      body = html`<div style="position:relative">${t >= from && t <= to ? html`<div style=${`position:absolute;top:0;bottom:0;left:calc(30% + ${(diffDays(from, t) / span) * 70}%);width:2px;background:var(--accent)`}></div>` : null}
        ${D.items.slice(0, 20).map((x) => html`<div class="row" key=${x.id} style="height:26px;gap:0;cursor:pointer" onClick=${() => openItem(x.id)}><span class="clip small" style="width:30%;padding-right:8px">${x.name}</span>
          <span style="position:relative;flex:1;height:14px"><span style=${`position:absolute;left:${(diffDays(from, x.start) / span) * 100}%;width:${Math.max(1.5, ((diffDays(x.start, x.end) + 1) / span) * 100)}%;height:14px;border-radius:4px;background:${x.color};opacity:${x.done ? 0.5 : 1}`}></span></span></div>`)}
        <div class="row between small faint"><span style="margin-left:30%">${shortDate(from)}</span><span>${shortDate(to)}</span></div></div>`;
      break;
    }
    case 'countdown': body = html`<div class="big-num">${Math.abs(D.days)}</div><div class="muted">${D.days >= 0 ? `day${D.days === 1 ? '' : 's'} to go` : 'days ago'} · ${shortDate(D.date)}</div>`; break;
    case 'note': body = html`<div style="white-space:pre-wrap">${D.text || html`<span class="muted">Empty note</span>`}</div>`; break;
    case 'calendar': body = html`<${MiniCalendar} items=${D.items} openItem=${openItem} />`; break;
    case 'table': body = D.items.length ? html`<div class="wtable-wrap"><table class="wtable"><thead><tr><th>Item</th><th>Board</th><th>Status</th><th>Owner</th><th>Due</th>${D.columns.map((c, i) => html`<th key=${i}>${c}</th>`)}</tr></thead><tbody>
      ${D.items.map((x) => html`<tr key=${x.id} onClick=${() => openItem(x.id)}><td><span class="grp-dot" style=${`background:${x.groupColor || '#c4cad4'}`}></span>${x.name}</td><td class="muted">${x.boardName}</td>
        <td>${x.status ? html`<span class="lbl" style=${`background:${x.status.color};color:#fff`}>${x.status.label}</span>` : null}</td>
        <td><span class="avatars">${x.people.slice(0, 3).map((p) => html`<${Avatar} key=${p.id} person=${p} size=${20} />`)}</span></td>
        <td style=${x.overdue ? 'color:var(--bad);font-weight:700' : ''}>${x.due ? shortDate(x.due) : ''}</td>${x.extra.map((v, i) => html`<td key=${i} class="clip">${v}</td>`)}</tr>`)}</tbody></table>
      ${D.total > D.items.length ? html`<div class="small faint mt">Showing ${D.items.length} of ${D.total}</div>` : null}</div>` : html`<div class="muted small">No items match.</div>`; break;
    case 'teams': body = D.teams.length ? html`<table class="wl"><thead><tr><th>Team</th><th>Owns (open)</th><th>Overdue</th><th>Done</th><th>Waited on</th></tr></thead><tbody>
      ${D.teams.map((t) => html`<tr key=${t.id} style="cursor:pointer" onClick=${() => nav('dependencies')}><td><span class="row" style="gap:6px"><span class="swatch" style=${`background:${t.color};width:10px;height:10px`}></span>${t.name}${t.external ? html`<span class="chip small">outside</span>` : null}</span></td>
        <td>${t.open}</td><td style=${t.overdue ? 'color:var(--bad);font-weight:700' : ''}>${t.overdue}</td><td>${t.done}</td><td style=${t.waiting ? 'color:#c77700;font-weight:700' : ''}>${t.waiting}</td></tr>`)}</tbody></table>`
      : html`<div class="muted small">Add a Team column to these boards to see who owns what and who is waited on.</div>`; break;
    default: body = null;
  }
  return html`<div class=${`widget ${w.size || 'm'}`}>
    <div class="wh"><span class="grow clip">${w.title}</span><button class="btn icon ghost small" aria-label="Widget menu" onClick=${open}><${Icon} name="more" size="14" /></button></div>
    <div class="wb">${body}</div>
    ${a ? html`<${Menu} anchor=${a} onClose=${close} align="right" items=${[
      { label: 'Edit widget', icon: 'edit', onClick: onEdit },
      { label: 'Small', icon: 'grid', onClick: () => call('saveWidget', w.dashboard_id, { ...w, size: 's' }).then(reload, toastError) },
      { label: 'Medium', icon: 'grid', onClick: () => call('saveWidget', w.dashboard_id, { ...w, size: 'm' }).then(reload, toastError) },
      { label: 'Full width', icon: 'grid', onClick: () => call('saveWidget', w.dashboard_id, { ...w, size: 'l' }).then(reload, toastError) },
      { label: 'Move earlier', icon: 'arrowLeft', onClick: () => call('saveWidget', w.dashboard_id, { ...w, position: w.position - 1.5 }).then(reload, toastError) },
      { sep: true },
      { label: 'Remove widget', icon: 'trash', danger: true, onClick: () => call('deleteWidget', w.id).then(reload, toastError) },
    ]} />` : null}
  </div>`;
  void addDaysIso;
}

const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function MiniCalendar({ items, openItem }) {
  const t = todayIso();
  const [ym, setYm] = useState(t.slice(0, 7));
  const first = `${ym}-01`;
  const dow = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDaysIso(first, -dow);
  const days = Array.from({ length: 42 }, (_, i) => addDaysIso(start, i));
  const shift = (n) => { const d = new Date(`${first}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); setYm(d.toISOString().slice(0, 7)); };
  const on = (d) => items.filter((x) => x.start <= d && x.end >= d);
  return html`<div class="mini-cal">
    <div class="row between" style="margin-bottom:6px"><button class="btn icon ghost small" aria-label="Previous month" onClick=${() => shift(-1)}><${Icon} name="arrowLeft" size="14" /></button>
      <b class="small">${MONTHS[+ym.slice(5) - 1]} ${ym.slice(0, 4)}</b>
      <button class="btn icon ghost small" aria-label="Next month" onClick=${() => shift(1)}><${Icon} name="arrowRight" size="14" /></button></div>
    <div class="mc-grid">${WD.map((w) => html`<div class="mc-wd" key=${w}>${w}</div>`)}
      ${days.map((d) => { const its = on(d); return html`<div key=${d} class=${`mc-day ${d.slice(0, 7) !== ym ? 'out' : ''} ${d === t ? 'today' : ''}`}><span class="mc-n">${+d.slice(8)}</span>
        ${its.slice(0, 2).map((x) => html`<div key=${x.id} class="mc-item" title=${`${x.name} · ${x.boardName}`} style=${`background:${x.color};opacity:${x.done ? 0.5 : 1}`} onClick=${() => openItem(x.id)}>${x.name}</div>`)}
        ${its.length > 2 ? html`<div class="mc-more">+${its.length - 2}</div>` : null}</div>`; })}</div></div>`;
}

function WidgetEditor({ w, d, allBoards, onClose, onSaved }) {
  const [type, setType] = useState(w.type);
  const [title, setTitle] = useState(w.title || '');
  const [size, setSize] = useState(w.size || 'm');
  const [cfg, setCfg] = useState(w.config || {});
  const [cols, setCols] = useState([]);
  const boardIds = cfg.boardIds && cfg.boardIds.length ? cfg.boardIds : d.boardIds;
  useEffect(() => {
    (async () => {
      const all = [];
      for (const b of boardIds) { try { all.push(...(await call('boardColumns', b)).filter((c) => c.scope === 'item').map((c) => ({ ...c, boardName: (allBoards.find((x) => x.id === b) || {}).name }))); } catch (_) { /* gone */ } }
      setCols(all);
    })();
  }, [JSON.stringify(boardIds)]);
  const numCols = cols.filter((c) => ['numbers', 'formula', 'mirror'].includes(c.type));
  const grpCols = cols.filter((c) => ['status', 'priority', 'people', 'dropdown', 'date', 'country', 'tags', 'text'].includes(c.type));
  const save = async () => {
    try { await call('saveWidget', d.id, { id: w.id, type, title, size, config: cfg }); onSaved(); } catch (e) { toastError(e); }
  };
  const TYPES = { numbers: 'Numbers', battery: 'Progress battery', chart: 'Chart', workload: 'Workload', list: 'Item list', table: 'Table', calendar: 'Calendar', timeline: 'Timeline', teams: 'Team ownership', countdown: 'Countdown', note: 'Text note' };
  return html`<${Modal} title=${w.id ? 'Edit widget' : 'Add widget'} onClose=${onClose}>
    <div class="col" style="gap:12px">
      <div class="grid c2"><label class="field">Type<select class="input" value=${type} onChange=${(e) => setType(e.target.value)}>${Object.entries(TYPES).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></label>
        <label class="field">Size<select class="input" value=${size} onChange=${(e) => setSize(e.target.value)}><option value="s">Small</option><option value="m">Medium</option><option value="l">Full width</option></select></label></div>
      <label class="field">Title<input class="input" value=${title} placeholder=${TYPES[type]} onInput=${(e) => setTitle(e.target.value)} /></label>
      ${!['countdown', 'note'].includes(type) ? html`<div class="field"><span>Boards</span><div class="row wrap">${allBoards.map((b) => html`<label class="check small" key=${b.id}><input type="checkbox" checked=${boardIds.includes(b.id)} onChange=${(e) => setCfg({ ...cfg, boardIds: e.target.checked ? [...boardIds, b.id] : boardIds.filter((x) => x !== b.id) })} />${b.name}</label>`)}</div></div>` : null}
      ${type === 'numbers' ? html`<div class="grid c2"><label class="field">Column<select class="input" value=${cfg.column || ''} onChange=${(e) => setCfg({ ...cfg, column: e.target.value })}><option value="">Count items</option>${numCols.map((c) => html`<option value=${c.id}>${c.title} (${c.boardName})</option>`)}</select></label>
        <label class="field">Calculation<select class="input" value=${cfg.fn || (cfg.column ? 'sum' : 'count')} onChange=${(e) => setCfg({ ...cfg, fn: e.target.value })}>${[['sum', 'Sum'], ['avg', 'Average'], ['min', 'Minimum'], ['max', 'Maximum'], ['count', 'Count']].map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></label>
        <label class="check small"><input type="checkbox" checked=${!!cfg.notDone} onChange=${(e) => setCfg({ ...cfg, notDone: e.target.checked })} /> Only items that are not done</label></div>` : null}
      ${type === 'chart' ? html`<div class="grid c2"><label class="field">Chart<select class="input" value=${cfg.chart || 'bar'} onChange=${(e) => setCfg({ ...cfg, chart: e.target.value })}><option value="bar">Bars</option><option value="column">Columns</option><option value="pie">Pie</option><option value="donut">Donut</option></select></label>
        <label class="field">Group by<select class="input" value=${cfg.groupBy || 'status'} onChange=${(e) => setCfg({ ...cfg, groupBy: e.target.value })}><option value="status">Status (each board's first)</option><option value="person">Person (each board's first)</option><option value="group">Group</option><option value="board">Board</option>${grpCols.map((c) => html`<option value=${c.id}>${c.title} (${c.boardName})</option>`)}</select></label>
        <label class="field">Measure<select class="input" value=${cfg.measure || 'count'} onChange=${(e) => setCfg({ ...cfg, measure: e.target.value })}><option value="count">Count of items</option><option value="sum">Sum of a number</option></select></label>
        ${cfg.measure === 'sum' ? html`<label class="field">Number column<select class="input" value=${cfg.value || ''} onChange=${(e) => setCfg({ ...cfg, value: e.target.value })}><option value="">Choose…</option>${numCols.map((c) => html`<option value=${c.id}>${c.title} (${c.boardName})</option>`)}</select></label>` : null}</div>` : null}
      ${type === 'list' ? html`<div class="grid c2"><label class="field">Due within (days, blank for all open items)<input class="input" type="number" value=${cfg.dueWithin || ''} onInput=${(e) => setCfg({ ...cfg, dueWithin: e.target.value ? Number(e.target.value) : null })} /></label>
        <label class="check small"><input type="checkbox" checked=${!!cfg.mine} onChange=${(e) => setCfg({ ...cfg, mine: e.target.checked })} /> Only mine</label></div>` : null}
      ${type === 'table' ? html`<div class="grid c2"><label class="field">Sort by<select class="input" value=${cfg.sortBy || 'due'} onChange=${(e) => setCfg({ ...cfg, sortBy: e.target.value })}><option value="due">Due date</option><option value="name">Name</option><option value="board">Board</option></select></label>
        <div class="field"><span>Extra columns (up to 4)</span><div class="row wrap">${cols.filter((c) => !['status', 'people'].includes(c.type)).map((c) => html`<label class="check small" key=${c.id}><input type="checkbox" checked=${(cfg.columns || []).includes(c.id)} disabled=${!(cfg.columns || []).includes(c.id) && (cfg.columns || []).length >= 4} onChange=${(e) => setCfg({ ...cfg, columns: e.target.checked ? [...(cfg.columns || []), c.id] : (cfg.columns || []).filter((x) => x !== c.id) })} />${c.title}</label>`)}</div></div>
        <label class="check small"><input type="checkbox" checked=${!!cfg.notDone} onChange=${(e) => setCfg({ ...cfg, notDone: e.target.checked })} /> Hide items that are done</label>
        <label class="check small"><input type="checkbox" checked=${!!cfg.mine} onChange=${(e) => setCfg({ ...cfg, mine: e.target.checked })} /> Only mine</label></div>` : null}
      ${type === 'calendar' ? html`<label class="check small"><input type="checkbox" checked=${!!cfg.notDone} onChange=${(e) => setCfg({ ...cfg, notDone: e.target.checked })} /> Hide items that are done</label>` : null}
      ${type === 'countdown' ? html`<label class="field">Date<input class="input" type="date" value=${cfg.date || todayIso()} onInput=${(e) => setCfg({ ...cfg, date: e.target.value })} /></label>` : null}
      ${type === 'note' ? html`<label class="field">Text<textarea class="input" rows="5" value=${cfg.text || ''} onInput=${(e) => setCfg({ ...cfg, text: e.target.value })}></textarea></label>` : null}
      <div class="row" style="justify-content:flex-end"><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" onClick=${save}>Save widget</button></div>
    </div></${Modal}>`;
}
