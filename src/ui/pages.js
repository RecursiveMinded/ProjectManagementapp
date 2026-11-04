// Home, My Work, Inbox, Archive and the new-board dialog.
import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Modal, toastError, toast, Spinner, useLoad, relTime, shortDate, Avatar, plural, hexA, ask } from './lib.js';
import { call } from './api.js';
import { C } from './model.js';
import { LabelPill } from './cells.js';

const TPL_STYLE = {
  blank: ['#5e6b80', 'table'], project: ['#5a55d6', 'timeline'], tasks: ['#13a89e', 'checkbox'], crm: ['#2bb673', 'chart'], bugs: ['#f0634e', 'warn'], content: ['#f28a2e', 'calendar'],
};

export function NewBoard({ boot, onClose, onCreated, workspaceId }) {
  const [tpl, setTpl] = useState('blank');
  const [name, setName] = useState('');
  const [ws, setWs] = useState(workspaceId || (boot.workspaces[0] || {}).id || '');
  const [sample, setSample] = useState(false);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      let wid = ws;
      if (!wid) wid = await call('saveWorkspace', { name: 'Main workspace' });
      const id = await call('createBoard', { template: tpl, workspaceId: wid, name: name.trim() || boot.catalog.templates[tpl].name, sample });
      onCreated(id);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const importFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.xlsx,.tsv,.txt,.json';
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        let id;
        if (/\.json$/i.test(f.name)) id = await call('importBoardFile', new TextDecoder().decode(bytes), { workspaceId: ws });
        else { const r = await call('importTable', { name: f.name, bytes, workspaceId: ws }); id = r.boardId; toast(`Imported ${plural(r.created, 'item')}`); }
        onCreated(id);
      } catch (e) { toastError(e); }
    };
    input.click();
  };
  return html`<${Modal} title="New board" onClose=${onClose} wide>
    <div class="grid c3">${Object.entries(boot.catalog.templates).map(([k, t]) => html`<button key=${k} class="tpl" style=${tpl === k ? 'border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)' : ''} onClick=${() => setTpl(k)}>
      <span class="ic" style=${`background:${TPL_STYLE[k][0]}`}><${Icon} name=${TPL_STYLE[k][1]} /></span><b>${t.name}</b><span class="small muted">${t.description}</span></button>`)}</div>
    <div class="grid c2 mt2">
      <label class="field">Board name<input class="input" placeholder=${boot.catalog.templates[tpl].name} value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') create(); }} /></label>
      <label class="field">Workspace<select class="input" value=${ws} onChange=${(e) => setWs(e.target.value)}>${boot.workspaces.map((w) => html`<option value=${w.id}>${w.name}</option>`)}${!boot.workspaces.length ? html`<option value="">Main workspace</option>` : null}</select></label>
    </div>
    ${tpl !== 'blank' ? html`<label class="check mt2"><input type="checkbox" checked=${sample} onChange=${(e) => setSample(e.target.checked)} /> Include example items</label>` : null}
    <div class="row mt2"><button class="btn ghost" onClick=${importFile}><${Icon} name="upload" /> Import from Excel, CSV or a board file</button><span class="grow"></span>
      <button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${busy} onClick=${create}>Create board</button></div>
  </${Modal}>`;
}

export function Home({ boot, nav, openItem, newBoard, reloadShell }) {
  const [work] = useLoad(() => call('myWork'), []);
  const [notes] = useLoad(() => call('notifications', { limit: 6 }), []);
  const me = boot.me;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const boards = boot.workspaces.flatMap((w) => w.boards.map((b) => ({ ...b, ws: w.name }))).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  if (boot.empty) {
    return html`<div class="page"><div class="home-hero"><h1>Welcome to Boardenda</h1><p style="opacity:.9;max-width:640px;margin-top:8px">Plan projects, track work and keep your team in step: boards with typed columns, timelines, kanban, calendars, dashboards and automations. Everything is stored on this computer.</p>
      <div class="row mt2"><button class="btn" style="background:#fff;color:#2a2560;border:0" onClick=${async () => { try { await call('loadSample'); toast('Sample workspace added'); reloadShell(); } catch (e) { toastError(e); } }}><${Icon} name="spark" /> Try the sample workspace</button>
        <button class="btn" style="background:transparent;color:#fff;border-color:rgba(255,255,255,.5)" onClick=${newBoard}><${Icon} name="plus" /> Start a board</button></div></div>
      <div class="grid c3">
        ${[['table', 'Boards your way', 'Thirty column types: status, people, timeline, formula, mirror, dependency, time tracking and more.'],
          ['timeline', 'Every view', 'Table, kanban, Gantt timeline, calendar, chart, workload, form and files views of the same data.'],
          ['bolt', 'Automations', 'When a status changes, a date arrives or a button is clicked: move, assign, notify, create and more.']].map(([i, t, d]) => html`<div class="card" style="padding:18px" key=${t}><${Icon} name=${i} /><h3 class="mt">${t}</h3><p class="muted small mt">${d}</p></div>`)}
      </div></div>`;
  }
  const counts = (work || []).reduce((a, w) => { a[w.bucket] = (a[w.bucket] || 0) + 1; return a; }, {});
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>${greet}, ${me.name.split(' ')[0]}</h1><div class="muted">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div></div>
      <button class="btn primary" onClick=${newBoard}><${Icon} name="plus" /> New board</button></div>
    <div class="grid c4">
      ${[['overdue', 'Overdue', 'var(--bad)'], ['today', 'Due today', 'var(--brand)'], ['week', 'This week', 'var(--warn)'], ['none', 'No date', 'var(--faint)']].map(([k, l, c]) => html`<button class="card stat" key=${k} style="text-align:left;cursor:pointer" onClick=${() => nav('mywork')}><span class="muted small">${l}</span><b style=${`color:${c}`}>${work ? counts[k] || 0 : '…'}</b><span class="small faint">assigned to you</span></button>`)}
    </div>
    <div class="grid c2 mt2" style="margin-top:16px">
      <div class="card"><div class="hd"><h3 class="grow">Recently updated boards</h3></div><div class="bd">
        ${boards.slice(0, 8).map((b) => html`<div class="row" key=${b.id} style="padding:8px 0;border-bottom:1px solid var(--line);cursor:pointer" onClick=${() => nav('board', b.id)}>
          <${Icon} name="table" /><span class="grow"><b>${b.name}</b><div class="small muted">${b.ws} · ${plural(b.items, 'item')}</div></span><span class="small faint">${relTime(b.updated_at)}</span></div>`)}</div></div>
      <div class="card"><div class="hd"><h3 class="grow">Inbox</h3><a class="small" onClick=${() => nav('inbox')}>See all</a></div><div class="bd">
        ${notes && !notes.length ? html`<div class="muted small">Nothing new. Mentions, assignments and automation alerts appear here.</div>` : null}
        ${(notes || []).map((n) => html`<div class="row" key=${n.id} style="padding:8px 0;border-bottom:1px solid var(--line);cursor:pointer" onClick=${() => n.item_id && openItem(n.item_id)}>
          <${Icon} name=${n.kind === 'mention' ? 'msg' : n.kind === 'assigned' ? 'user' : 'bell'} /><span class="grow"><span style=${n.read ? '' : 'font-weight:650'}>${n.title}</span><div class="small muted clip">${n.body}</div></span><span class="small faint">${relTime(n.ts)}</span></div>`)}</div></div>
    </div>
  </div>`;
}

const BUCKETS = [['overdue', 'Overdue', '#d64545'], ['today', 'Today', '#5b4fe0'], ['week', 'This week', '#c98113'], ['next', 'Next week', '#3aa0e8'], ['later', 'Later', '#13a89e'], ['none', 'Without a date', '#8f8ea6'], ['done', 'Done', '#1f9d63']];

export function MyWork({ boot, openItem, version }) {
  const [showDone, setShowDone] = useState(false);
  const [person, setPerson] = useState(boot.me.id);
  const [list, reload] = useLoad(() => call('myWork', { includeDone: showDone, personId: person }), [showDone, person, version]);
  const [q, setQ] = useState('');
  const setStatus = async (w, id) => { try { await call('setValue', w.id, w.statusColumn, id); reload(); } catch (e) { toastError(e); } };
  const setDate = async (w, d) => { try { await call('setValue', w.id, w.dateColumn, d || null); reload(); } catch (e) { toastError(e); } };
  const items = (list || []).filter((w) => !q || w.name.toLowerCase().includes(q.toLowerCase()) || w.boardName.toLowerCase().includes(q.toLowerCase()));
  return html`<div class="page">
    <div class="page-head"><h1 class="grow">My work</h1>
      <select class="input" style="width:200px" value=${person} onChange=${(e) => setPerson(e.target.value)}>${boot.people.map((p) => html`<option value=${p.id}>${p.is_me ? `Me (${p.name})` : p.name}</option>`)}</select>
      <input class="input" style="width:220px" placeholder="Search" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <label class="check small"><input type="checkbox" checked=${showDone} onChange=${(e) => setShowDone(e.target.checked)} /> Show done</label></div>
    ${list == null ? html`<${Spinner} />` : !items.length ? html`<div class="empty"><${Icon} name="check" /><h3>Nothing assigned</h3><div>Items appear here when someone puts ${person === boot.me.id ? 'you' : 'this person'} in a People column.</div></div>` : null}
    ${BUCKETS.map(([k, label, color]) => {
      const rows = items.filter((w) => w.bucket === k);
      if (!rows.length) return null;
      return html`<div class="mw-sec" key=${k}><h3 style=${`color:${color}`}>${label} <span class="faint small">${rows.length}</span></h3>
        ${rows.map((w) => html`<div class="mw-row" key=${w.id} style=${`border-left:4px solid ${w.groupColor || color}`}>
          <div style="min-width:0;cursor:pointer" onClick=${() => openItem(w.id)}><b class="clip">${w.name}</b><div class="small muted clip">${w.parentName ? `Subitem of ${w.parentName} · ` : ''}${w.boardName} · ${w.groupName}</div></div>
          <div>${w.statusColumn ? html`<select class="input" style=${`height:28px;${w.status ? `background:${hexA(w.status.color, 0.16)};color:${w.status.color};font-weight:600;border-color:transparent` : ''}`} value=${w.status ? w.status.id : ''} onChange=${(e) => setStatus(w, e.target.value)}>
            <option value="">No status</option>${w.labels.map((l) => html`<option value=${l.id}>${l.label}</option>`)}</select>` : null}</div>
          <div>${w.dateColumn ? html`<input class="input" type="date" style=${`height:28px;${w.bucket === 'overdue' ? 'color:var(--bad);font-weight:600' : ''}`} value=${w.due || ''} onChange=${(e) => setDate(w, e.target.value)} />` : null}</div>
          <div class="small faint" style="text-align:right">${w.due ? shortDate(w.due) : ''}</div>
        </div>`)}</div>`;
    })}
  </div>`;
}

export function Inbox({ openItem, refreshShell, version }) {
  const [unread, setUnread] = useState(false);
  const [list, reload] = useLoad(() => call('notifications', { unreadOnly: unread, limit: 300 }), [unread, version]);
  const mark = async (ids, read = true) => { try { await call('markRead', ids, read); reload(); refreshShell(); } catch (e) { toastError(e); } };
  return html`<div class="page">
    <div class="page-head"><h1 class="grow">Inbox</h1>
      <div class="seg"><button class=${!unread ? 'on' : ''} onClick=${() => setUnread(false)}>All</button><button class=${unread ? 'on' : ''} onClick=${() => setUnread(true)}>Unread</button></div>
      <button class="btn" onClick=${() => mark('all')}><${Icon} name="check" /> Mark all read</button></div>
    <div class="card">
      ${list == null ? html`<div class="pad"><${Spinner} /></div>` : !list.length ? html`<div class="empty"><${Icon} name="inbox" /><h3>You're all caught up</h3><div>Mentions, assignments, automation notifications and reminders land here.</div></div>` : null}
      ${(list || []).map((n) => html`<div key=${n.id} class=${`notif ${n.read ? '' : 'unread'}`} onClick=${() => { if (!n.read) mark([n.id]); if (n.item_id) openItem(n.item_id); }}>
        <span class="ws-icon" style=${`background:${n.kind === 'mention' ? '#5b4fe0' : n.kind === 'assigned' ? '#13a89e' : '#ff9f43'}`}><${Icon} name=${n.kind === 'mention' ? 'msg' : n.kind === 'assigned' ? 'user' : 'bolt'} size="13" /></span>
        <div class="grow" style="min-width:0"><div style=${n.read ? '' : 'font-weight:650'}>${n.title}</div><div class="small muted">${n.body}</div></div>
        <span class="small faint" style="white-space:nowrap">${relTime(n.ts)}</span>
        <button class="btn icon ghost small" title=${n.read ? 'Mark unread' : 'Mark read'} onClick=${(e) => { e.stopPropagation(); mark([n.id], !n.read); }}><${Icon} name=${n.read ? 'eye' : 'check'} size="14" /></button></div>`)}
    </div></div>`;
}

export function Archive({ refreshShell }) {
  const [d, reload] = useLoad(() => call('archived'), []);
  const act = (p) => p.then(() => { reload(); refreshShell(); }, toastError);
  if (!d) return html`<div class="page"><${Spinner} /></div>`;
  return html`<div class="page"><div class="page-head"><h1 class="grow">Archive</h1></div>
    <div class="card"><div class="hd"><h3>Boards</h3></div><div class="bd">${d.boards.length ? html`<table class="plain"><tbody>${d.boards.map((b) => html`<tr key=${b.id}><td><b>${b.name}</b></td><td class="muted small">${b.workspace}</td><td class="small faint">${relTime(b.updated_at)}</td>
      <td style="text-align:right"><button class="btn small" onClick=${() => act(call('archiveBoard', b.id, false))}>Restore</button> <button class="btn small ghost" style="color:var(--bad)" onClick=${async () => { if (await ask({ title: 'Delete board permanently?', body: b.name })) act(call('deleteBoard', b.id)); }}>Delete</button></td></tr>`)}</tbody></table>` : html`<div class="muted small">No archived boards.</div>`}</div></div>
    <div class="card mt2" style="margin-top:16px"><div class="hd"><h3>Groups</h3></div><div class="bd">${d.groups.length ? html`<table class="plain"><tbody>${d.groups.map((g) => html`<tr key=${g.id}><td><b>${g.name}</b></td><td class="muted small">${g.board}</td>
      <td style="text-align:right"><button class="btn small" onClick=${() => act(call('archiveGroup', g.id, false))}>Restore</button> <button class="btn small ghost" style="color:var(--bad)" onClick=${() => act(call('deleteGroup', g.id))}>Delete</button></td></tr>`)}</tbody></table>` : html`<div class="muted small">No archived groups.</div>`}</div></div>
    <div class="card mt2" style="margin-top:16px"><div class="hd"><h3>Items</h3></div><div class="bd">${d.items.length ? html`<table class="plain"><tbody>${d.items.map((i) => html`<tr key=${i.id}><td><b>${i.name}</b></td><td class="muted small">${i.board}</td><td class="small faint">${relTime(i.updated_at)}</td>
      <td style="text-align:right"><button class="btn small" onClick=${() => act(call('archiveItem', i.id, false))}>Restore</button> <button class="btn small ghost" style="color:var(--bad)" onClick=${() => act(call('deleteItem', i.id))}>Delete</button></td></tr>`)}</tbody></table>` : html`<div class="muted small">No archived items.</div>`}</div></div>
  </div>`;
}

export function SearchPalette({ onClose, nav, openItem, boot }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState([]);
  const [focus, setFocus] = useState(0);
  useEffect(() => {
    const t = setTimeout(async () => { if (q.trim().length < 2) { setRes([]); return; } try { setRes(await call('search', q)); setFocus(0); } catch (_) { /* ignore */ } }, 120);
    return () => clearTimeout(t);
  }, [q]);
  const commands = [
    ['Go to Home', () => nav('home')], ['Go to My work', () => nav('mywork')], ['Go to Inbox', () => nav('inbox')], ['Go to Settings', () => nav('settings')],
    ...boot.workspaces.flatMap((w) => w.boards.map((b) => [`Open board: ${b.name}`, () => nav('board', b.id)])),
    ...boot.dashboards.map((d) => [`Open dashboard: ${d.name}`, () => nav('dashboard', d.id)]),
  ].filter(([l]) => !q || l.toLowerCase().includes(q.toLowerCase())).slice(0, q ? 6 : 8);
  const all = [...res.map((r) => ({ label: r.name, sub: r.kind === 'update' ? `Update: ${r.snippet}` : `${r.boardName}${r.groupName ? ` · ${r.groupName}` : ''}`, icon: r.kind === 'board' ? 'table' : r.kind === 'update' ? 'msg' : r.kind === 'subitem' ? 'sub' : 'list', go: () => (r.kind === 'board' ? nav('board', r.id) : openItem(r.subId || r.id)) })),
    ...commands.map(([l, go]) => ({ label: l, icon: 'arrowRight', go }))];
  const run = (x) => { onClose(); x.go(); };
  return html`<div><div class="scrim" style="z-index:94" onClick=${onClose}></div><div class="palette" role="dialog" aria-label="Search">
    <input autoFocus placeholder="Search items, updates and boards, or jump anywhere" value=${q} onInput=${(e) => setQ(e.target.value)}
      onKeyDown=${(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(Math.min(all.length - 1, focus + 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(Math.max(0, focus - 1)); } if (e.key === 'Enter' && all[focus]) run(all[focus]); }} />
    <div class="res">${all.map((x, i) => html`<button key=${i} class=${`mi ${i === focus ? 'focus' : ''}`} onMouseEnter=${() => setFocus(i)} onClick=${() => run(x)}><${Icon} name=${x.icon} /><span class="grow" style="min-width:0"><span class="clip">${x.label}</span>${x.sub ? html`<span class="small muted clip">${x.sub}</span>` : null}</span></button>`)}
      ${q.trim().length >= 2 && !res.length ? html`<div class="pad muted small">No items match “${q}”.</div>` : null}</div>
  </div></div>`;
}
void Avatar; void C; void LabelPill;
