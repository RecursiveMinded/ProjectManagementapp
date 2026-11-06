// Settings: profile, team, notifications, appearance, data and updates.
import { useState } from 'preact/hooks';
import { html, Icon, toast, toastError, useLoad, Spinner, Avatar, Avatars, bytes, ask } from './lib.js';
import { C } from './model.js';
import { call, native, isDesktop } from './api.js';
import { useUpdate, checkForUpdates, installUpdate } from './update.js';
import { AiSettings } from './capture.js';
import { AskSources } from './ask.js';
import { HelpPage } from './help.js';

const TABS = [['profile', 'People & teams'], ['notify', 'Notifications'], ['look', 'Appearance'], ['ai', 'AI'], ['data', 'Data & backups'], ['about', 'Updates & about'], ['help', 'Help & user guide']];

export function Settings({ boot, reloadShell }) {
  const [tab, setTab] = useState('profile');
  const s = boot.settings;
  const save = async (patch) => {
    try { await call('setSettings', patch); await reloadShell(); } catch (e) { toastError(e); }
  };
  return html`<div class="page"><div class="page-head"><h1>Settings</h1></div>
    <div class="tabs mb">${TABS.map(([k, l]) => html`<button class=${`tab ${tab === k ? 'on' : ''}`} onClick=${() => setTab(k)}>${l}</button>`)}</div>
    <div style="max-width:860px">
      ${tab === 'profile' ? html`<${Team} boot=${boot} reloadShell=${reloadShell} />` : null}
      ${tab === 'notify' ? html`<${Notify} s=${s} save=${save} />` : null}
      ${tab === 'look' ? html`<${Look} s=${s} save=${save} />` : null}
      ${tab === 'ai' ? html`<${AiSettings} /><h3 class="ask-set-h">Ask anything: folders to search</h3><${AskSources} />` : null}
      ${tab === 'data' ? html`<${Data} boot=${boot} s=${s} save=${save} reloadShell=${reloadShell} />` : null}
      ${tab === 'about' ? html`<${About} s=${s} save=${save} />` : null}
      ${tab === 'help' ? html`<${HelpPage} embedded />` : null}
    </div></div>`;
}

function Toggle({ on, onChange, label, hint }) {
  return html`<div class="row between" style="padding:10px 0;border-bottom:1px solid var(--line)">
    <div><b>${label}</b>${hint ? html`<div class="small muted">${hint}</div>` : null}</div>
    <button class=${`toggle ${on ? 'on' : ''}`} role="switch" aria-checked=${on} aria-label=${label} onClick=${() => onChange(!on)}></button></div>`;
}

function Team({ boot, reloadShell }) {
  const [edit, setEdit] = useState(null);
  const people = boot.people;
  const save = async () => {
    try { const { team, ...rest } = edit; await call('savePerson', rest); setEdit(null); await reloadShell(); toast('Saved'); } catch (e) { toastError(e); }
  };
  const remove = async (p) => {
    if (!(await ask({ title: `Remove ${p.name}?`, body: 'They are unassigned from every item. Their past updates stay.', ok: 'Remove' }))) return;
    try { await call('deletePerson', p.id); await reloadShell(); } catch (e) { toastError(e); }
  };
  return html`<div class="card pad">
    <div class="row between"><h3>People</h3><button class="btn primary small" onClick=${() => setEdit({ name: '', email: '', capacity: 0, teamIds: [] })}><${Icon} name="plus" /> Add person</button></div>
    <p class="small muted">Boardenda runs on this PC only. People here are the names you assign work to; the one marked “you” drives My work and notifications.</p>
    <table class="plain mt"><thead><tr><th></th><th>Name</th><th>Email</th><th>Team</th><th>Capacity / week</th><th></th></tr></thead>
    <tbody>${people.map((p) => html`<tr key=${p.id}>
      <td><${Avatar} person=${p} /></td><td><b>${p.name}</b>${p.is_me ? html` <span class="chip">you</span>` : null}</td>
      <td>${p.email}</td><td>${p.team}</td><td>${p.capacity || ''}</td>
      <td class="row" style="justify-content:flex-end"><button class="btn ghost small" onClick=${() => setEdit({ ...p, teamIds: (boot.teams || []).filter((t) => t.members.includes(p.id)).map((t) => t.id) })}>Edit</button>
        ${p.is_me ? null : html`<button class="btn ghost small" onClick=${() => remove(p)}><${Icon} name="trash" /></button>`}</td></tr>`)}</tbody></table>
    ${edit ? html`<div class="card pad mt" style="background:var(--bg)">
      <div class="grid c2">
        <label class="field">Name<input class="input" value=${edit.name} autoFocus onInput=${(e) => setEdit({ ...edit, name: e.target.value })} /></label>
        <label class="field">Email<input class="input" value=${edit.email || ''} onInput=${(e) => setEdit({ ...edit, email: e.target.value })} /></label>
        <div class="field">Teams<div class="chips" style="margin-top:6px">${(boot.teams || []).filter((t) => !t.external).map((t) => { const ids = edit.teamIds || []; const on = ids.includes(t.id); return html`<button key=${t.id} class=${`chip ${on ? 'on' : ''}`} style=${on ? `background:${C.colorHex(t.color)};color:#fff` : ''} onClick=${() => setEdit({ ...edit, teamIds: on ? ids.filter((x) => x !== t.id) : [...ids, t.id] })}>${t.name}</button>`; })}
          ${!(boot.teams || []).some((t) => !t.external) ? html`<span class="small muted">Add teams below first.</span>` : null}</div></div>
        <label class="field">Capacity (points or hours a week)<input class="input" type="number" min="0" value=${edit.capacity || ''} onInput=${(e) => setEdit({ ...edit, capacity: e.target.value })} /></label>
        <label class="field">Colour<input class="input" type="color" value=${edit.color || '#5b4fe0'} onInput=${(e) => setEdit({ ...edit, color: e.target.value })} /></label>
      </div>
      <div class="row mt"><span class="grow"></span><button class="btn" onClick=${() => setEdit(null)}>Cancel</button><button class="btn primary" onClick=${save}>Save</button></div>
    </div>` : null}
  </div>
  <${Teams} boot=${boot} reloadShell=${reloadShell} />`;
}

function Teams({ boot, reloadShell }) {
  const [edit, setEdit] = useState(null);
  const teams = boot.teams || [];
  const people = boot.people;
  const save = async () => {
    try { await call('saveTeam', edit); setEdit(null); await reloadShell(); toast('Team saved'); } catch (e) { toastError(e); }
  };
  const remove = async (t) => {
    if (!(await ask({ title: `Delete the ${t.name} team?`, body: 'People stay. Items that named this team lose that value.', ok: 'Delete' }))) return;
    try { await call('deleteTeam', t.id); await reloadShell(); } catch (e) { toastError(e); }
  };
  return html`<div class="card pad mt">
    <div class="row between"><h3>Teams</h3><button class="btn primary small" onClick=${() => setEdit({ name: '', color: 'indigo', external: false, description: '', members: [] })}><${Icon} name="plus" /> Add team</button></div>
    <p class="small muted">Teams own work and depend on each other. Mark a team as <b>outside Boardenda</b> for departments or vendors you track dependencies on but who never use the app; nothing is ever sent to them.</p>
    <table class="plain mt"><thead><tr><th>Team</th><th>Members</th><th>Notes</th><th></th></tr></thead>
    <tbody>${teams.map((t) => html`<tr key=${t.id}>
      <td><span class="team-chip" style=${`--tc:${C.colorHex(t.color)}`}>${t.name}</span>${t.external ? html` <span class="chip">outside</span>` : null}</td>
      <td><${Avatars} ids=${t.members} people=${Object.fromEntries(people.map((p) => [p.id, p]))} max=${5} size=${22} /></td>
      <td class="small muted">${t.description}</td>
      <td class="row" style="justify-content:flex-end"><button class="btn ghost small" onClick=${() => setEdit({ ...t })}>Edit</button><button class="btn ghost small" aria-label="Delete team" onClick=${() => remove(t)}><${Icon} name="trash" /></button></td></tr>`)}</tbody></table>
    ${!teams.length ? html`<p class="muted">No teams yet.</p>` : null}
    ${edit ? html`<div class="card pad mt" style="background:var(--bg)">
      <div class="grid c2">
        <label class="field">Name<input class="input" value=${edit.name} autoFocus onInput=${(e) => setEdit({ ...edit, name: e.target.value })} /></label>
        <label class="field">Notes<input class="input" value=${edit.description || ''} placeholder="What they own, who to ask" onInput=${(e) => setEdit({ ...edit, description: e.target.value })} /></label>
      </div>
      <div class="swatches mt">${C.PALETTE.map((p) => html`<button key=${p.id} class="swatch" title=${p.id} style=${`background:${p.hex};${edit.color === p.id ? 'outline:2px solid var(--text)' : ''}`} onClick=${() => setEdit({ ...edit, color: p.id })}></button>`)}</div>
      <label class="check mt"><input type="checkbox" checked=${edit.external} onChange=${(e) => setEdit({ ...edit, external: e.target.checked })} /> Outside Boardenda (track dependencies only)</label>
      ${edit.external ? null : html`<div class="field mt">Members<div class="chips" style="margin-top:6px">${people.map((p) => { const on = (edit.members || []).includes(p.id); return html`<button key=${p.id} class=${`chip ${on ? 'on' : ''}`} style=${on ? 'background:var(--brand);color:#fff' : ''} onClick=${() => setEdit({ ...edit, members: on ? edit.members.filter((x) => x !== p.id) : [...(edit.members || []), p.id] })}>${p.name}</button>`; })}</div></div>`}
      <div class="row mt"><span class="grow"></span><button class="btn" onClick=${() => setEdit(null)}>Cancel</button><button class="btn primary" onClick=${save}>Save team</button></div>
    </div>` : null}
  </div>`;
}

function Notify({ s, save }) {
  const d = s.digest;
  return html`<div class="card pad">
    <${Toggle} label="Desktop notifications" hint="Show a Windows notification when you are assigned, mentioned, or an automation notifies you." on=${s.desktopNotifications} onChange=${(v) => save({ desktopNotifications: v })} />
    <${Toggle} label="Daily digest" hint="A summary of what is overdue and due today." on=${d.enabled} onChange=${(v) => save({ digest: { enabled: v } })} />
    ${d.enabled ? html`<div class="grid c3 mt">
      <label class="field">How often<select class="input" value=${d.frequency} onChange=${(e) => save({ digest: { frequency: e.target.value } })}>
        <option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option></select></label>
      <label class="field">Time<input class="input" type="time" value=${d.time} onChange=${(e) => save({ digest: { time: e.target.value } })} /></label>
      ${d.frequency === 'weekly' ? html`<label class="field">Day<select class="input" value=${d.weekday} onChange=${(e) => save({ digest: { weekday: Number(e.target.value) } })}>
        ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((n, i) => html`<option value=${i}>${n}</option>`)}</select></label>` : null}
    </div>` : null}
    <div class="row mt"><button class="btn" onClick=${() => native('testNotification').then(() => toast('Notification sent')).catch(toastError)}><${Icon} name="bell" /> Send a test digest</button></div>
  </div>`;
}

function Look({ s, save }) {
  const seg = (key, opts) => html`<div class="seg">${opts.map(([v, l]) => html`<button class=${s[key] === v ? 'on' : ''} onClick=${() => save({ [key]: v })}>${l}</button>`)}</div>`;
  return html`<div class="card pad">
    <div class="row between" style="padding:10px 0;border-bottom:1px solid var(--line)"><b>Theme</b>${seg('theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']])}</div>
    <div class="row between" style="padding:10px 0;border-bottom:1px solid var(--line)"><b>Row density</b>${seg('density', [['comfortable', 'Comfortable'], ['compact', 'Compact']])}</div>
    <div class="row between" style="padding:10px 0"><b>Week starts on</b>${seg('weekStart', [[1, 'Monday'], [0, 'Sunday']])}</div>
  </div>`;
}

function Data({ boot, s, save, reloadShell }) {
  const [stats, reloadStats] = useLoad(() => call('stats'), []);
  const [backups, reloadBackups] = useLoad(() => call('listBackups'), []);
  const backup = async () => { try { const n = await call('backup', 'manual'); toast(`Backup saved: ${n}`); reloadBackups(); } catch (e) { toastError(e); } };
  const restore = async (b) => {
    if (!(await ask({ title: 'Restore this backup?', body: `Everything goes back to ${b.name}. A backup of the current data is taken first.`, ok: 'Restore', danger: true }))) return;
    try { await call('restoreBackup', b.name); toast('Backup restored'); await reloadShell(); reloadStats(); reloadBackups(); } catch (e) { toastError(e); }
  };
  const move = async () => {
    try {
      const p = await native('chooseFolder');
      if (!p) return;
      if (!(await ask({ title: 'Move your data?', body: `Boardenda copies its data to ${p} and restarts.`, ok: 'Move and restart', danger: false }))) return;
      await native('moveData', { path: p });
    } catch (e) { toastError(e); }
  };
  return html`<div class="card pad">
    <h3>Your data</h3>
    ${stats ? html`<div class="grid c3 mt">
      <div class="stat card"><b>${stats.boards}</b><span class="muted">boards</span></div>
      <div class="stat card"><b>${stats.items}</b><span class="muted">items</span></div>
      <div class="stat card"><b>${bytes(stats.dbBytes)}</b><span class="muted">database</span></div></div>
      <p class="small muted mt">Folder: <span class="mono">${stats.dataDir || 'in memory'}</span> · Integrity check: ${stats.integrity}</p>` : html`<${Spinner} />`}
    <div class="row mt">
      ${isDesktop ? html`<button class="btn" onClick=${() => native('openPath', { path: boot.dataDir }).catch(toastError)}><${Icon} name="folder" /> Open folder</button>
      <button class="btn" onClick=${move}>Move data folder…</button>` : null}
      <button class="btn primary" onClick=${backup}>Back up now</button></div>
  </div>
  <div class="card pad mt">
    <div class="row between"><h3>Backups</h3>
      <label class="row small">Keep daily backups for <input class="input" type="number" min="3" max="365" style="width:70px" value=${s.backupsKeep} onChange=${(e) => save({ backupsKeep: Number(e.target.value) || 14 })} /> days</label></div>
    <p class="small muted">A backup is taken each day you open Boardenda, before a restore, and before moving data.</p>
    ${backups && backups.length ? html`<div class="mt">${backups.slice(0, 30).map((b) => html`<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)" key=${b.name}>
      <span class="mono small grow">${b.name}</span><span class="small muted">${bytes(b.size)}</span><button class="btn ghost small" onClick=${() => restore(b)}>Restore</button></div>`)}</div>`
      : html`<p class="muted">No backups yet.</p>`}
  </div>`;
}

function About({ s, save }) {
  const update = useUpdate();
  const [info] = useLoad(() => native('appInfo').catch(() => ({ version: 'dev' })), []);
  return html`<div class="card pad">
    <h3>Boardenda ${info ? info.version : ''}</h3>
    <p class="muted">A local work management app: boards, timelines, automations and dashboards, stored on this PC.</p>
    <${Toggle} label="Run in the background" hint="Closing the window keeps Boardenda in the tray so automations and reminders keep running." on=${s.runInBackground} onChange=${(v) => save({ runInBackground: v })} />
    <${Toggle} label="Start with Windows" on=${s.startWithWindows} onChange=${(v) => save({ startWithWindows: v })} />
    <${Toggle} label="Install updates automatically" hint="Downloads new versions from GitHub releases." on=${s.autoUpdate} onChange=${(v) => save({ autoUpdate: v })} />
    ${update && update.state !== 'unsupported' ? html`<div class="row mt">
      <button class="btn" disabled=${['checking', 'downloading'].includes(update.state)} onClick=${() => checkForUpdates().then((st) => toast(st.state === 'current' ? 'You have the latest version' : st.state === 'error' ? st.message : `Version ${st.version} ${st.state === 'ready' ? 'is ready' : 'is downloading'}`, st.state === 'error' ? 'err' : '')).catch(toastError)}>
        ${update.state === 'checking' ? 'Checking…' : 'Check for updates'}</button>
      ${update.state === 'ready' ? html`<button class="btn primary" onClick=${() => installUpdate().catch(toastError)}>Restart to install ${update.version}</button>` : null}
    </div>` : html`<p class="small muted mt">${isDesktop ? 'The portable version does not update itself.' : 'Updates are available in the desktop app.'}</p>`}
  </div>`;
}

