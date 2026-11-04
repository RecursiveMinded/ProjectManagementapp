// App shell: sidebar, routing, search palette, item panel and global hosts.
import { render, Fragment } from 'preact';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { html, Icon, Toasts, toast, toastError, Spinner, Avatar, Menu, useAnchor, ConfirmHost, ask, Modal, usePersist } from './lib.js';
import { call, onEvent } from './api.js';
import { BoardPage } from './board.js';
import { ItemPanel } from './item.js';
import { DashboardPage } from './dashboards-ui.js';
import { Home, MyWork, Inbox, Archive, SearchPalette, NewBoard } from './pages.js';
import { Settings } from './settings.js';
import { CalendarPage } from './calendar.js';
import { useUpdate, installUpdate, checkForUpdates } from './update.js';
import { selfTest } from './selftest.js';
import { C } from './model.js';

window.__bdSelfTest = selfTest;

function applyLook(s) {
  const r = document.documentElement;
  if (s.theme && s.theme !== 'system') r.setAttribute('data-theme', s.theme); else r.removeAttribute('data-theme');
  if (s.density === 'compact') r.setAttribute('data-density', 'compact'); else r.removeAttribute('data-density');
  try { localStorage.setItem('bd.look', JSON.stringify({ theme: s.theme, density: s.density })); } catch (_) { /* ignore */ }
}
try { applyLook(JSON.parse(localStorage.getItem('bd.look') || '{}')); } catch (_) { /* ignore */ }

function App() {
  const [boot, setBoot] = useState(null);
  const [error, setError] = useState(null);
  const [route, setRoute] = usePersist('route', { name: 'home', id: null });
  const [version, setVersion] = useState(0);
  const [item, setItem] = useState(null); // { id, tab }
  const [palette, setPalette] = useState(false);
  const [newBoard, setNewBoard] = useState(null); // { workspaceId }
  const [closedWs, setClosedWs] = usePersist('closedWs', {});
  const itemReload = useRef(null);
  const update = useUpdate();

  const reloadShell = useCallback(async () => {
    try {
      const b = await call('bootstrap');
      applyLook(b.settings);
      setBoot(b);
      return b;
    } catch (e) { setError(e.message); return null; }
  }, []);
  useEffect(() => { reloadShell(); }, []);

  const nav = useCallback((name, id = null) => { setRoute({ name, id }); setItem(null); }, []);
  const openItem = useCallback((id, tab, reload) => { itemReload.current = reload || null; setItem({ id, tab: tab || null, t: Date.now() }); }, []);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // Unread count and data changed by automations in the background.
  useEffect(() => {
    const t = setInterval(() => { reloadShell(); }, 60000);
    const offs = [onEvent('navigate', (r) => (typeof r === 'string' ? nav(r) : nav(r.name, r.id))), onEvent('changed', () => { bump(); reloadShell(); }),
      onEvent('openItem', (id) => openItem(id))];
    return () => { clearInterval(t); offs.forEach((f) => f()); };
  }, []);

  useEffect(() => {
    const k = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); }
      if (e.key === 'Escape' && item && !document.querySelector('.modal, .pop, .palette')) setItem(null);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [item]);

  if (error) return html`<div style="padding:40px"><h2>Boardenda could not start</h2><p class="muted">${error}</p><button class="btn" onClick=${() => { setError(null); reloadShell(); }}>Try again</button></div>`;
  if (!boot) return html`<div class="row" style="padding:40px"><${Spinner} /> Starting…</div>`;

  const boards = boot.workspaces.flatMap((w) => w.boards);
  let r = route;
  if (r.name === 'board' && !boards.some((b) => b.id === r.id)) r = { name: 'home' };
  if (r.name === 'dashboard' && !boot.dashboards.some((d) => d.id === r.id)) r = { name: 'home' };

  const createWorkspace = async () => {
    try { await call('saveWorkspace', { name: 'New workspace' }); await reloadShell(); toast('Workspace added. Right-click it to rename.'); } catch (e) { toastError(e); }
  };
  const createDashboard = async () => {
    try { const id = await call('saveDashboard', { name: 'New dashboard', boardIds: boards.slice(0, 3).map((b) => b.id) }); await reloadShell(); nav('dashboard', id); } catch (e) { toastError(e); }
  };

  let page;
  if (r.name === 'board') page = html`<${BoardPage} key=${r.id} boardId=${r.id} openItem=${openItem} refreshShell=${reloadShell} nav=${nav} version=${version} />`;
  else if (r.name === 'dashboard') page = html`<${DashboardPage} key=${r.id} id=${r.id} boot=${boot} nav=${nav} openItem=${openItem} refreshShell=${reloadShell} version=${version} />`;
  else if (r.name === 'calendar') page = html`<${CalendarPage} boot=${boot} openItem=${openItem} version=${version} />`;
  else if (r.name === 'mywork') page = html`<${MyWork} boot=${boot} openItem=${openItem} version=${version} />`;
  else if (r.name === 'inbox') page = html`<${Inbox} openItem=${openItem} refreshShell=${reloadShell} version=${version} />`;
  else if (r.name === 'archive') page = html`<${Archive} refreshShell=${reloadShell} />`;
  else if (r.name === 'settings') page = html`<${Settings} boot=${boot} reloadShell=${reloadShell} />`;
  else page = html`<${Home} key=${version} boot=${boot} nav=${nav} openItem=${openItem} newBoard=${() => setNewBoard({})} reloadShell=${async () => { await reloadShell(); bump(); }} />`;

  const navLink = (name, label, icon, badge) => html`<a class=${r.name === name ? 'on' : ''} onClick=${() => nav(name)}><${Icon} name=${icon} />${label}${badge ? html`<span class="badge">${badge}</span>` : null}</a>`;

  return html`<${Fragment}><div class="app">
    <aside class="side" aria-label="Navigation">
      <div class="brand"><span class="brand-mark"><span></span></span>Boardenda</div>
      <div class="searchbox" role="button" tabindex="0" onClick=${() => setPalette(true)}><${Icon} name="search" />Search<kbd>Ctrl K</kbd></div>
      <nav class="nav">
        ${navLink('home', 'Home', 'home')}
        ${navLink('mywork', 'My work', 'check')}
        ${navLink('calendar', 'Calendar', 'calendar')}
        ${navLink('inbox', 'Inbox', 'inbox', boot.unread || null)}
      </nav>
      <div class="scroll">
        <div class="sect">Workspaces<span class="row" style="gap:2px"><button title="New board" aria-label="New board" onClick=${() => setNewBoard({})}><${Icon} name="plus" size=${14} /></button>
          <button title="New workspace" aria-label="New workspace" onClick=${createWorkspace}><${Icon} name="folder" size=${14} /></button></span></div>
        ${boot.workspaces.map((w) => html`<${Workspace} key=${w.id} w=${w} route=${r} nav=${nav} closed=${!!closedWs[w.id]} toggle=${() => setClosedWs({ ...closedWs, [w.id]: !closedWs[w.id] })}
          reloadShell=${reloadShell} newBoard=${() => setNewBoard({ workspaceId: w.id })} />`)}
        ${!boot.workspaces.length ? html`<div class="small" style="padding:6px 10px;color:#8584a3">No boards yet.</div>` : null}
        <div class="sect">Dashboards<button title="New dashboard" aria-label="New dashboard" onClick=${createDashboard}><${Icon} name="plus" size=${14} /></button></div>
        ${boot.dashboards.map((d) => html`<a key=${d.id} class=${`ws-board ${r.name === 'dashboard' && r.id === d.id ? 'on' : ''}`} style="padding-left:10px" onClick=${() => nav('dashboard', d.id)}><${Icon} name="dashboard" size=${15} /><span class="clip">${d.name}</span></a>`)}
      </div>
      <${UpdateButton} update=${update} />
      <div class="foot">
        <div class="me" onClick=${() => nav('settings')} title="Profile and settings"><${Avatar} person=${boot.me} size=${26} /><span class="clip">${boot.me.name}</span></div>
        <button title="Archive" aria-label="Archive" onClick=${() => nav('archive')}><${Icon} name="archive" /></button>
        <button title="Settings" aria-label="Settings" onClick=${() => nav('settings')}><${Icon} name="gear" /></button>
      </div>
    </aside>
    <main class="main">
      ${update && update.state === 'ready' ? html`<div class="row" style="background:var(--brand-soft);padding:8px 16px;gap:10px"><span class="grow">Boardenda ${update.version} is ready. Your data is kept.</span>
        <button class="btn small primary" onClick=${() => installUpdate().catch(toastError)}>Restart to update</button></div>` : null}
      ${page}
    </main></div>
    ${item ? html`<${ItemPanel} key=${item.id + item.t} id=${item.id} tab=${item.tab} openItem=${openItem} nav=${nav}
      onClose=${() => setItem(null)} onChanged=${() => { if (itemReload.current) itemReload.current(); else bump(); }} />` : null}
    ${palette ? html`<${SearchPalette} boot=${boot} nav=${nav} openItem=${openItem} onClose=${() => setPalette(false)} />` : null}
    ${newBoard ? html`<${NewBoard} boot=${boot} workspaceId=${newBoard.workspaceId} onClose=${() => setNewBoard(null)}
      onCreated=${async (id) => { setNewBoard(null); await reloadShell(); nav('board', id); }} />` : null}
    <${ConfirmHost} />
    <${Toasts} />
  </${Fragment}>`;
}

/** Always-visible update control: check, watch the download, restart to install. */
function UpdateButton({ update }) {
  const [busy, setBusy] = useState(false);
  if (!update) return null;
  const st = update.state;
  const check = async () => {
    setBusy(true);
    try {
      const r = await checkForUpdates();
      if (r.state === 'current') toast(`You have the latest version (${r.current})`);
      else if (r.state === 'error') toast(r.message, 'err');
      else if (r.state === 'downloading') toast(`Downloading version ${r.version}…`);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  if (st === 'unsupported') return html`<div class="upd-btn muted" title="The portable version does not update itself. Install with the Setup exe to get updates.">Version ${update.current} · portable</div>`;
  if (st === 'ready') return html`<button class="upd-btn ready" onClick=${() => installUpdate().catch(toastError)}><${Icon} name="refresh" size=${15} />Restart to update to ${update.version}</button>`;
  if (st === 'downloading') return html`<div class="upd-btn"><${Icon} name="download" size=${15} />Downloading ${update.version || 'update'}${update.percent ? ` · ${update.percent}%` : '…'}
    <span class="upd-bar"><i style=${`width:${update.percent || 3}%`}></i></span></div>`;
  return html`<button class="upd-btn" disabled=${busy || st === 'checking'} onClick=${check} title=${st === 'error' ? update.message : `Version ${update.current}`}>
    <${Icon} name="refresh" size=${15} />${busy || st === 'checking' ? 'Checking for updates…' : 'Check for updates'}<span class="v">v${update.current}</span></button>`;
}

function Workspace({ w, route, nav, closed, toggle, reloadShell, newBoard }) {
  const [a, open, close] = useAnchor();
  const [rename, setRename] = useState(null);
  const color = C.colorHex(w.color || 'indigo');
  const items = [
    { label: 'New board here', icon: 'plus', onClick: newBoard },
    { label: 'Rename', icon: 'edit', onClick: () => setRename({ name: w.name, color: w.color || 'indigo' }) },
    { sep: true },
    { label: 'Delete workspace', icon: 'trash', danger: true, onClick: async () => {
      if (!(await ask({ title: `Delete ${w.name}?`, body: `This deletes its ${w.boards.length} board(s) and every item on them. A backup is kept in Settings.` }))) return;
      try { await call('backup', 'before-delete'); await call('deleteWorkspace', w.id); await reloadShell(); nav('home'); } catch (e) { toastError(e); }
    } },
  ];
  return html`<div>
    <div class="ws-head" onClick=${toggle} onContextMenu=${(e) => { e.preventDefault(); open(e); }}>
      <span class="ws-icon" style=${`background:${color}`}>${(w.name[0] || 'W').toUpperCase()}</span><span class="clip grow">${w.name}</span>
      <button class="btn icon" style="background:none;border:0;color:inherit;padding:2px" aria-label="Workspace menu" onClick=${(e) => { e.stopPropagation(); open(e); }}><${Icon} name="dots" size=${14} /></button>
    </div>
    ${closed ? null : w.boards.map((b) => html`<a key=${b.id} class=${`ws-board ${route.name === 'board' && route.id === b.id ? 'on' : ''}`} onClick=${() => nav('board', b.id)}>
      <${Icon} name="table" size=${15} /><span class="clip">${b.name}</span><span class="n">${b.items}</span></a>`)}
    ${a ? html`<${Menu} anchor=${a} onClose=${close} items=${items} />` : null}
    ${rename ? html`<${Modal} title="Rename workspace" onClose=${() => setRename(null)}>
      <label class="field">Name<input class="input" autoFocus value=${rename.name} onInput=${(e) => setRename({ ...rename, name: e.target.value })} /></label>
      <div class="swatches mt">${C.PALETTE.map((p) => html`<button key=${p.id} class="swatch" title=${p.id} style=${`background:${p.hex};${rename.color === p.id ? 'outline:2px solid var(--text)' : ''}`} onClick=${() => setRename({ ...rename, color: p.id })}></button>`)}</div>
      <div class="row mt"><span class="grow"></span><button class="btn primary" onClick=${async () => { try { await call('saveWorkspace', { id: w.id, ...rename }); setRename(null); reloadShell(); } catch (e) { toastError(e); } }}>Save</button></div>
    </${Modal}>` : null}
  </div>`;
}

window.addEventListener('error', (e) => toastError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => toastError(e.reason));

render(html`<${App} />`, document.getElementById('root'));
