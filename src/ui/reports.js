// Portfolio (every board at a glance) and Timesheets (time tracked across boards).
import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Spinner, toastError, toast, shortDate, usePersist, Avatar, Modal, todayIso, addDaysIso, diffDays } from './lib.js';
import { call, saveAs } from './api.js';

export const HEALTH = {
  on_track: ['On track', '#2bb673'], at_risk: ['At risk', '#f2a516'], off_track: ['Off track', '#e2445c'], done: ['Done', '#9aa3b2'],
};

export function PortfolioPage({ boot, nav, version }) {
  const [rows, setRows] = useState(null);
  const [opt, setOpt] = usePersist('portfolio', { ws: '', health: '', sort: 'workspace' });
  const [edit, setEdit] = useState(null);
  const load = () => call('portfolio').then(setRows, toastError);
  useEffect(() => { load(); }, [version]);
  if (!rows) return html`<div class="page"><${Spinner} /></div>`;
  const people = Object.fromEntries(boot.people.map((p) => [p.id, p]));
  const t = todayIso();
  let list = rows.filter((r) => (!opt.ws || r.workspaceId === opt.ws) && (!opt.health || r.health === opt.health));
  if (opt.sort === 'end') list = [...list].sort((a, b) => String(a.end || '9').localeCompare(String(b.end || '9')));
  if (opt.sort === 'progress') list = [...list].sort((a, b) => a.progress - b.progress);
  if (opt.sort === 'health') { const o = Object.keys(HEALTH); list = [...list].sort((a, b) => o.indexOf(b.health === 'done' ? 'zz' : b.health) - o.indexOf(a.health === 'done' ? 'zz' : a.health)); }
  const count = (h) => rows.filter((r) => r.health === h).length;
  const items = rows.reduce((a, r) => a + r.items, 0), done = rows.reduce((a, r) => a + r.done, 0);
  const setP = (id, patch) => call('setPortfolio', id, patch).then(load, toastError);
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Portfolio</h1><div class="muted small mt">Every board at a glance: progress, dates and health. Health is worked out from overdue and blocked items unless you set it.</div></div></div>
    <div class="stat-row">
      <div class="stat"><b>${rows.length}</b><span>boards</span></div>
      <div class="stat"><b>${items ? Math.round((done / items) * 100) : 0}%</b><span>of ${items} items done</span></div>
      ${Object.entries(HEALTH).map(([k, [l, c]]) => html`<button key=${k} class=${`stat click ${opt.health === k ? 'on' : ''}`} onClick=${() => setOpt({ ...opt, health: opt.health === k ? '' : k })}><b style=${`color:${c}`}>${count(k)}</b><span>${l}</span></button>`)}
    </div>
    <div class="row mt2" style="gap:8px">
      <select class="input" style="width:auto" value=${opt.ws} onChange=${(e) => setOpt({ ...opt, ws: e.target.value })}><option value="">All workspaces</option>${boot.workspaces.map((w) => html`<option value=${w.id}>${w.name}</option>`)}</select>
      <select class="input" style="width:auto" value=${opt.sort} onChange=${(e) => setOpt({ ...opt, sort: e.target.value })}><option value="workspace">By workspace</option><option value="health">Needs attention first</option><option value="end">By end date</option><option value="progress">Least progress first</option></select>
      ${opt.health ? html`<button class="btn small ghost" onClick=${() => setOpt({ ...opt, health: '' })}>Show all health</button>` : null}
    </div>
    <div class="card mt2" style="padding:0;overflow:auto">
      <table class="pf">
        <thead><tr><th>Board</th><th>Owner</th><th>Health</th><th style="min-width:180px">Progress</th><th>Dates</th><th>Overdue</th><th>Blocked</th><th>Status note</th></tr></thead>
        <tbody>${list.map((r) => {
          const [hl, hc] = HEALTH[r.health];
          const left = r.end ? diffDays(t, r.end) : null;
          return html`<tr key=${r.id}>
            <td><a class="pf-name" onClick=${() => nav('board', r.id)}>${r.name}</a><div class="small faint">${r.workspace}${r.folder ? ` / ${r.folder}` : ''}</div></td>
            <td><select class="pf-sel" aria-label="Owner" value=${r.ownerId || ''} onChange=${(e) => setP(r.id, { ownerId: e.target.value || null })}><option value="">—</option>${boot.people.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select>
              ${r.ownerId && people[r.ownerId] ? html`<span class="pf-av"><${Avatar} person=${people[r.ownerId]} size=${20} /></span>` : null}</td>
            <td><select class="pf-health" aria-label="Health" style=${`--hc:${hc}`} value=${r.healthSet ? r.health : ''} onChange=${(e) => setP(r.id, { health: e.target.value || null })}>
              <option value="">${HEALTH[r.autoHealth][0]} (auto)</option>${Object.entries(HEALTH).map(([k, [l]]) => html`<option value=${k}>${l}</option>`)}</select>
              ${!r.healthSet ? null : html`<span class="small faint" title="Set by hand">●</span>`}<span class="sr">${hl}</span></td>
            <td><div class="pf-bar"><span style=${`width:${r.progress}%`}></span></div><span class="small muted">${r.progress}% · ${r.done}/${r.items}</span></td>
            <td class="small">${r.start ? `${shortDate(r.start)} – ${shortDate(r.end)}` : html`<span class="faint">No dates</span>`}
              ${left != null && r.health !== 'done' ? html`<div class=${`small ${left < 0 ? 'bad' : 'faint'}`}>${left < 0 ? `${-left} days late` : left === 0 ? 'ends today' : `${left} days left`}</div>` : null}</td>
            <td class=${r.overdue ? 'bad b' : 'faint'}>${r.overdue}</td>
            <td class=${r.blocked ? 'bad b' : 'faint'}>${r.blocked}</td>
            <td class="pf-note" onClick=${() => setEdit(r)}>${r.note || html`<span class="faint">Add a note</span>`}</td>
          </tr>`;
        })}</tbody>
      </table>
      ${!list.length ? html`<div class="empty"><h3>No boards match</h3></div>` : null}
    </div>
    ${edit ? html`<${NoteEditor} r=${edit} onClose=${() => setEdit(null)} onSave=${(note) => { setEdit(null); setP(edit.id, { note }); }} />` : null}
  </div>`;
}

function NoteEditor({ r, onClose, onSave }) {
  const [v, setV] = useState(r.note || '');
  return html`<${Modal} title=${`Status note: ${r.name}`} onClose=${onClose}>
    <textarea class="input" rows="4" autoFocus value=${v} onInput=${(e) => setV(e.target.value)} placeholder="Where things stand, what is in the way"></textarea>
    <div class="row mt2"><span class="grow"></span><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" onClick=${() => onSave(v)}>Save</button></div>
  </${Modal}>`;
}

const hm = (sec) => { const m = Math.round(sec / 60); return m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : ''; };
const mondayOf = (iso) => addDaysIso(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function TimesheetPage({ boot, openItem, version }) {
  const [opt, setOpt] = usePersist('timesheet', { person: '__me', week: '' });
  const week = opt.week || mondayOf(todayIso());
  const to = addDaysIso(week, 6);
  const me = boot.me.id;
  const personId = opt.person === '__me' ? me : opt.person || undefined;
  const [d, setD] = useState(null);
  const [adding, setAdding] = useState(null);
  const load = () => call('timesheet', { from: week, to, personId }).then(setD, toastError);
  useEffect(() => { setD(null); load(); }, [week, opt.person, version]);
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(week, i));
  const people = Object.fromEntries(boot.people.map((p) => [p.id, p]));
  const exportCsv = async () => { try { await saveAs(`Timesheet ${week}.csv`, await call('timesheetCsv', { from: week, to, personId }), [{ name: 'CSV', extensions: ['csv'] }]); } catch (e) { toastError(e); } };
  const rows = {};
  for (const e of (d ? d.entries : [])) {
    const k = `${e.rowId}:${e.columnId}`;
    rows[k] = rows[k] || { key: k, name: e.name, boardName: e.boardName, itemId: e.itemId, rowId: e.rowId, columnId: e.columnId, by: {}, total: 0, entries: [] };
    rows[k].by[e.date] = (rows[k].by[e.date] || 0) + e.seconds;
    rows[k].total += e.seconds;
    rows[k].entries.push(e);
  }
  const list = Object.values(rows).sort((a, b) => a.boardName.localeCompare(b.boardName) || a.name.localeCompare(b.name));
  const dayTotal = (day) => list.reduce((a, r) => a + (r.by[day] || 0), 0);
  const total = list.reduce((a, r) => a + r.total, 0);
  const cap = personId && people[personId] ? Number(people[personId].capacity) || 0 : 0;
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Timesheets</h1><div class="muted small mt">Time from every Time tracking column, by day. Timers and time you enter by hand both count.</div></div>
      <button class="btn" onClick=${exportCsv}><${Icon} name="download" /> Export CSV</button>
      <button class="btn primary" onClick=${() => setAdding({ date: todayIso() <= to && todayIso() >= week ? todayIso() : week })}><${Icon} name="plus" /> Log time</button></div>
    <div class="row" style="gap:8px">
      <button class="btn icon" aria-label="Previous week" onClick=${() => setOpt({ ...opt, week: addDaysIso(week, -7) })}><${Icon} name="arrowLeft" /></button>
      <b>${shortDate(week)} – ${shortDate(to)}</b>
      <button class="btn icon" aria-label="Next week" onClick=${() => setOpt({ ...opt, week: addDaysIso(week, 7) })}><${Icon} name="arrowRight" /></button>
      <button class="btn small" onClick=${() => setOpt({ ...opt, week: '' })}>This week</button>
      <span class="grow"></span>
      <select class="input" style="width:auto" value=${opt.person} onChange=${(e) => setOpt({ ...opt, person: e.target.value })}>
        <option value="__me">Me (${boot.me.name})</option><option value="">Everyone</option>${boot.people.filter((p) => p.id !== me).map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select>
    </div>
    ${!d ? html`<${Spinner} />` : html`<div class="card mt2" style="padding:0;overflow:auto"><table class="ts">
      <thead><tr><th>Item</th>${days.map((x, i) => html`<th key=${x} class=${x === todayIso() ? 'today' : ''}>${DOW[i]}<div class="faint small">${+x.slice(8)}</div></th>`)}<th>Total</th></tr></thead>
      <tbody>${list.map((r) => html`<tr key=${r.key}>
        <td><a onClick=${() => openItem(r.itemId)}>${r.name}</a><div class="small faint">${r.boardName}</div></td>
        ${days.map((x) => html`<td key=${x} class="num click" title="Log time" onClick=${() => setAdding({ date: x, itemKey: r.key })}>${hm(r.by[x] || 0)}</td>`)}
        <td class="num b">${hm(r.total)}</td></tr>`)}
        ${!list.length ? html`<tr><td colspan="9" class="muted" style="padding:24px;text-align:center">No time logged this week. Start a timer on a Time tracking column, or use Log time.</td></tr>` : null}
      </tbody>
      <tfoot><tr><td>Total${cap ? html`<div class="small faint">capacity ${cap}h a week</div>` : null}</td>${days.map((x) => html`<td key=${x} class="num">${hm(dayTotal(x))}</td>`)}
        <td class=${`num b ${cap && total / 3600 > cap ? 'bad' : ''}`}>${hm(total) || '0:00'}</td></tr></tfoot></table></div>
      ${list.length ? html`<details class="mt2"><summary class="small muted">All entries (${d.entries.length})</summary><table class="ts entries mt">
        ${d.entries.map((e) => html`<tr key=${e.key}><td>${shortDate(e.date)}</td><td>${e.personId && people[e.personId] ? people[e.personId].name : '—'}</td><td>${e.name} <span class="faint small">${e.boardName}</span></td><td class="num">${hm(e.seconds)}</td><td class="small muted">${e.note}${e.manual ? '' : ' timer'}${e.running ? ' (running)' : ''}</td>
          <td>${e.running ? null : html`<button class="btn icon ghost small" aria-label="Delete entry" onClick=${() => call('removeTime', e.rowId, e.columnId, e.index).then(() => { toast('Entry removed'); load(); }, toastError)}><${Icon} name="trash" size="14" /></button>`}</td></tr>`)}</table></details>` : null}`}
    ${adding ? html`<${LogTime} boot=${boot} d=${d} rows=${list} init=${adding} personId=${personId || me} onClose=${() => setAdding(null)} onDone=${() => { setAdding(null); load(); }} />` : null}
  </div>`;
}

function LogTime({ boot, d, rows, init, personId, onClose, onDone }) {
  const known = [...(d ? d.items : [])].filter((x, i, a) => a.findIndex((y) => (y.subId || y.itemId) === (x.subId || x.itemId) && y.columnId === x.columnId) === i);
  const opts = known.map((x) => ({ key: `${x.subId || x.itemId}:${x.columnId}`, label: `${x.name} · ${x.boardName}` }));
  const [target, setTarget] = useState(init.itemKey || (opts[0] || {}).key || '');
  const [date, setDate] = useState(init.date);
  const [hours, setHours] = useState('1:00');
  const [note, setNote] = useState('');
  const [who, setWho] = useState(personId);
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    call('timeTargets', q).then(setFound, () => setFound([]));
  }, [q]);
  const all = [...opts, ...found.filter((f) => !opts.some((o) => o.key === f.key))];
  const save = async () => {
    const m = String(hours).trim().match(/^(\d+)(?::(\d{1,2}))?$|^(\d*\.\d+)$/);
    const minutes = m ? (m[3] ? Math.round(Number(m[3]) * 60) : Number(m[1]) * 60 + Number(m[2] || 0)) : NaN;
    const [rowId, columnId] = target.split(':');
    if (!rowId) { toast('Choose an item', 'err'); return; }
    try { await call('addTime', rowId, columnId, { date, minutes, note, personId: who }); toast('Time logged'); onDone(); } catch (e) { toastError(e); }
  };
  void rows;
  return html`<${Modal} title="Log time" onClose=${onClose}>
    <div class="col" style="gap:10px">
      <label class="field">Find an item with a Time tracking column<input class="input" placeholder="Search items" value=${q} onInput=${(e) => setQ(e.target.value)} /></label>
      <label class="field">Item<select class="input" value=${target} onChange=${(e) => setTarget(e.target.value)}>${!all.length ? html`<option value="">No items yet: search above</option>` : null}${all.map((o) => html`<option key=${o.key} value=${o.key}>${o.label}</option>`)}</select></label>
      <div class="grid c3"><label class="field">Date<input class="input" type="date" value=${date} onInput=${(e) => setDate(e.target.value)} /></label>
        <label class="field">Time (h:mm or 1.5)<input class="input" value=${hours} onInput=${(e) => setHours(e.target.value)} /></label>
        <label class="field">Person<select class="input" value=${who} onChange=${(e) => setWho(e.target.value)}>${boot.people.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select></label></div>
      <label class="field">Note<input class="input" value=${note} onInput=${(e) => setNote(e.target.value)} placeholder="Optional" /></label>
      <div class="row"><span class="grow"></span><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" onClick=${save}>Log time</button></div>
    </div></${Modal}>`;
}
