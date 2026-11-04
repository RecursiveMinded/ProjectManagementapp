// The item panel: updates (comments with @mentions and replies), every
// field, subitems, files and the item's activity log.
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { html, Icon, Menu, useAnchor, InlineText, Avatar, toastError, toast, ask, Spinner, relTime, plural, bytes } from './lib.js';
import { call, native } from './api.js';
import { C, ctxOf } from './model.js';
import { Cell } from './cells.js';

export function ItemPanel({ id, tab: initialTab, onClose, onChanged, openItem, nav }) {
  const [d, setD] = useState(null);
  const [tab, setTab] = useState(initialTab || 'updates');
  const [menu, openMenu, closeMenu] = useAnchor();
  const [moveB, setMoveB] = useState(null);
  const load = useCallback(async () => {
    try { setD(await call('getItem', id)); } catch (e) { toastError(e); onClose(); }
  }, [id]);
  useEffect(() => { setD(null); load(); }, [id]);
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const changed = () => { load(); onChanged && onChanged(); };
  if (!d) return html`<div><div class="scrim" onClick=${onClose}></div><aside class="drawer wide"><div class="bd"><${Spinner} /></div></aside></div>`;
  const it = d.item;
  const isSub = !!it.parent_id;
  const B = { board: d.board, columns: d.columns, groups: d.groups, people: d.people, items: d.parent ? [d.parent] : [it], subitems: d.subitems, files: d.files, linked: d.linked, updateCounts: {} };
  const ctx = ctxOf(B);
  const cols = d.columns.filter((c) => c.scope === (isSub ? 'sub' : 'item'));
  const group = d.groups.find((g) => g.id === it.group_id);
  return html`<div><div class="scrim" onClick=${onClose}></div>
  <aside class="drawer wide" role="dialog" aria-label=${it.name}>
    <div class="hd item-head">
      <div class="row between top">
        <div class="grow">
          <div class="crumbs"><a onClick=${() => { onClose(); nav('board', d.board.id); }}>${d.board.name}</a>
            ${group ? html`<span>/</span><span style=${`color:${C.colorHex(group.color)}`}>${group.name}</span>` : null}
            ${d.parent ? html`<span>/</span><a onClick=${() => openItem(d.parent.id)}>${d.parent.name}</a>` : null}
            ${it.archived ? html`<span class="chip">Archived</span>` : null}</div>
          <h2 class="mt"><${InlineText} value=${it.name} onSave=${(v) => call('renameItem', it.id, v).then(changed, toastError)} /></h2>
        </div>
        <button class="btn icon ghost" aria-label="Item menu" onClick=${openMenu}><${Icon} name="more" /></button>
        <button class="btn icon ghost" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button>
      </div>
      <div class="ptabs">${[['updates', `Updates${d.updates.length ? ` / ${d.updates.length}` : ''}`], ['info', 'Details'], !isSub && ['subitems', `Subitems${d.subitems.length ? ` / ${d.subitems.length}` : ''}`], ['files', `Files${d.fileList.length ? ` / ${d.fileList.length}` : ''}`], ['activity', 'Activity log']].filter(Boolean).map(([k, l]) => html`<button key=${k} class=${`tab ${tab === k ? 'on' : ''}`} onClick=${() => setTab(k)}>${l}</button>`)}</div>
    </div>
    <div class="bd">
      ${tab === 'updates' ? html`<${Updates} d=${d} changed=${changed} />` : null}
      ${tab === 'info' ? html`<div class="fields">${cols.map((c) => html`<div class="fl" key=${`l${c.id}`}><${Icon} name=${C.TYPES[c.type].icon} size="15" />${c.title}</div>
        <div class="fv" key=${`v${c.id}`}><${Cell} col=${c} item=${it} B=${B} ctx=${ctx} onSet=${(v) => call('setValue', it.id, c.id, v).then(changed)} reload=${changed} /></div>`)}
        <div class="fl"><${Icon} name="history" size="15" />Created</div><div class="small muted" style="padding:0 8px">${it.created_at.slice(0, 16).replace('T', ' ')} by ${(d.people.find((p) => p.id === it.created_by) || {}).name || 'someone'}</div></div>` : null}
      ${tab === 'subitems' ? html`<${Subitems} d=${d} B=${B} ctx=${ctx} changed=${changed} openItem=${openItem} />` : null}
      ${tab === 'files' ? html`<${Files} d=${d} changed=${changed} />` : null}
      ${tab === 'activity' ? html`<${ActivityLog} rows=${d.activity} people=${d.people} />` : null}
    </div>
    ${menu ? html`<${Menu} anchor=${menu} onClose=${closeMenu} align="right" items=${[
      { label: 'Duplicate', icon: 'copy', onClick: () => call('duplicateItem', it.id).then((nid) => { changed(); openItem(nid); }, toastError) },
      !isSub && { head: 'Move to group' },
      ...(!isSub ? d.groups.filter((g) => !g.archived && g.id !== it.group_id).map((g) => ({ label: g.name, icon: 'group', onClick: () => call('moveItem', it.id, { groupId: g.id }).then(changed, toastError) })) : []),
      !isSub && { label: 'Move to another board…', icon: 'arrowRight', onClick: async () => setMoveB(await call('allBoards')) },
      { sep: true },
      it.archived ? { label: 'Restore', icon: 'refresh', onClick: () => call('archiveItem', it.id, false).then(changed, toastError) }
        : { label: 'Archive', icon: 'archive', onClick: () => call('archiveItem', it.id, true).then(() => { toast('Archived'); onChanged && onChanged(); onClose(); }, toastError) },
      { label: 'Delete', icon: 'trash', danger: true, onClick: async () => { if (await ask({ title: 'Delete this item?', body: 'The item, its subitems, updates and files are deleted permanently.' })) call('deleteItem', it.id).then(() => { onChanged && onChanged(); onClose(); }, toastError); } },
    ]} />` : null}
    ${moveB ? html`<${Menu} anchor=${{ getBoundingClientRect: () => ({ left: window.innerWidth - 420, right: window.innerWidth - 120, top: 60, bottom: 80, width: 300 }) }} onClose=${() => setMoveB(null)} width=${300}
      items=${moveB.filter((b) => b.id !== d.board.id && !b.archived).map((b) => ({ label: b.name, hint: b.workspace, icon: 'table', onClick: () => call('moveItem', it.id, { boardId: b.id }).then(() => { toast(`Moved to ${b.name}`); changed(); }, toastError) }))} />` : null}
  </aside></div>`;
}

function renderBody(text, people) {
  const names = people.map((p) => p.name).sort((a, b) => b.length - a.length);
  if (!names.length) return text;
  const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`, 'g');
  return String(text).split(re).map((part, i) => (i % 2 ? html`<span class="mention" key=${i}>${part}</span>` : part));
}

function Composer({ onPost, people, placeholder = 'Write an update… use @ to mention someone', autoFocus }) {
  const [t, setT] = useState('');
  const [busy, setBusy] = useState(false);
  const [mention, setMention] = useState(null);
  const ta = useRef(null);
  const onInput = (e) => {
    const v = e.target.value;
    setT(v);
    const upto = v.slice(0, e.target.selectionStart);
    const m = upto.match(/@([\w .-]{0,20})$/);
    setMention(m ? m[1].toLowerCase() : null);
  };
  const pick = (p) => {
    const el = ta.current;
    const pos = el.selectionStart;
    const before = t.slice(0, pos).replace(/@[\w .-]{0,20}$/, `@${p.name} `);
    setT(before + t.slice(pos));
    setMention(null);
    setTimeout(() => { el.focus(); el.selectionStart = el.selectionEnd = before.length; }, 0);
  };
  const post = async () => {
    if (!t.trim()) return;
    setBusy(true);
    try { await onPost(t); setT(''); setMention(null); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const matches = mention != null ? people.filter((p) => p.name.toLowerCase().startsWith(mention) || p.name.toLowerCase().includes(` ${mention}`)).slice(0, 6) : [];
  return html`<div class="composer" style="position:relative">
    <textarea ref=${ta} value=${t} autoFocus=${autoFocus} placeholder=${placeholder} onInput=${onInput} onKeyDown=${(e) => { if (e.key === 'Enter' && e.ctrlKey) post(); if (e.key === 'Enter' && matches.length && mention != null) { e.preventDefault(); pick(matches[0]); } }}></textarea>
    ${matches.length ? html`<div class="pop menu" style="position:absolute;left:8px;top:100%;width:240px;z-index:5">${matches.map((p) => html`<button key=${p.id} class="mi" onMouseDown=${(e) => { e.preventDefault(); pick(p); }}><${Avatar} person=${p} size=${20} />${p.name}</button>`)}</div>` : null}
    <div class="row between"><span class="faint small">Ctrl+Enter to post</span><button class="btn primary small" disabled=${busy || !t.trim()} onClick=${post}>Post</button></div>
  </div>`;
}

function Updates({ d, changed }) {
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const top = d.updates.filter((u) => !u.parent_id);
  const replies = (id) => d.updates.filter((u) => u.parent_id === id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const who = (id) => (id === 'automation' ? { name: 'Automation', color: '#ff9f43' } : d.people.find((p) => p.id === id) || { name: 'Someone' });
  return html`<div>
    <${Composer} people=${d.people} autoFocus onPost=${(t) => call('postUpdate', d.item.id, t).then(changed)} />
    ${!top.length ? html`<div class="empty" style="padding:30px"><${Icon} name="msg" /><h3>No updates yet</h3><div>Share progress, ask a question or @mention a teammate.</div></div>` : null}
    ${top.map((u) => html`<div class=${`upd ${u.pinned ? 'pinned' : ''}`} key=${u.id}>
      <div class="row"><${Avatar} person=${who(u.author)} size=${30} /><div class="grow"><b>${who(u.author).name}</b><div class="faint small">${relTime(u.created_at)}${u.edited_at ? ' · edited' : ''}${u.pinned ? ' · pinned' : ''}</div></div>
        <${UpdateMenu} u=${u} changed=${changed} edit=${() => setEditing(u.id)} /></div>
      ${editing === u.id ? html`<div class="mt2"><${EditBox} text=${u.body} onSave=${(t) => call('editUpdate', u.id, t).then(() => { setEditing(null); changed(); }, toastError)} onCancel=${() => setEditing(null)} /></div>` : html`<div class="body">${renderBody(u.body, d.people)}</div>`}
      ${replies(u.id).map((r) => html`<div class="reply" key=${r.id}><div class="row"><${Avatar} person=${who(r.author)} size=${22} /><b class="small">${who(r.author).name}</b><span class="faint small">${relTime(r.created_at)}</span><span class="grow"></span><button class="btn icon ghost small" aria-label="Delete reply" onClick=${() => call('deleteUpdate', r.id).then(changed, toastError)}><${Icon} name="trash" size="13" /></button></div><div class="body" style="margin-top:4px">${renderBody(r.body, d.people)}</div></div>`)}
      ${replyTo === u.id ? html`<div class="mt2"><${Composer} people=${d.people} autoFocus placeholder="Write a reply…" onPost=${(t) => call('postUpdate', d.item.id, t, { parentId: u.id }).then(() => { setReplyTo(null); changed(); })} /></div>`
        : html`<button class="btn ghost small mt2" onClick=${() => setReplyTo(u.id)}><${Icon} name="msg" size="14" /> Reply</button>`}
    </div>`)}
  </div>`;
}

function EditBox({ text, onSave, onCancel }) {
  const [t, setT] = useState(text);
  return html`<div class="col"><textarea class="input" rows="4" value=${t} onInput=${(e) => setT(e.target.value)}></textarea><div class="row" style="justify-content:flex-end"><button class="btn small" onClick=${onCancel}>Cancel</button><button class="btn primary small" onClick=${() => onSave(t)}>Save</button></div></div>`;
}

function UpdateMenu({ u, changed, edit }) {
  const [a, open, close] = useAnchor();
  return html`<span><button class="btn icon ghost small" aria-label="Update menu" onClick=${open}><${Icon} name="more" size="14" /></button>
    ${a ? html`<${Menu} anchor=${a} onClose=${close} align="right" items=${[
      { label: u.pinned ? 'Unpin' : 'Pin to top', icon: 'pinIcon', onClick: () => call('pinUpdate', u.id, !u.pinned).then(changed, toastError) },
      { label: 'Edit', icon: 'edit', onClick: edit },
      { label: 'Copy text', icon: 'copy', onClick: () => navigator.clipboard && navigator.clipboard.writeText(u.body).then(() => toast('Copied')) },
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => call('deleteUpdate', u.id).then(changed, toastError) },
    ]} />` : null}</span>`;
}

function Subitems({ d, B, ctx, changed, openItem }) {
  const [name, setName] = useState('');
  const cols = d.columns.filter((c) => c.scope === 'sub');
  const add = async () => { if (!name.trim()) return; try { await call('addItem', d.board.id, { parentId: d.item.id, name: name.trim() }); setName(''); changed(); } catch (e) { toastError(e); } };
  return html`<div>
    <div class="card" style="overflow:auto"><table class="tbl sub" style="width:100%">
      <thead><tr><th class="name-cell" style="width:240px"><div class="th" style="justify-content:flex-start;padding-left:12px">Subitem</div></th>${cols.map((c) => html`<th key=${c.id} style="width:140px"><div class="th">${c.title}</div></th>`)}</tr></thead>
      <tbody>${d.subitems.map((s) => html`<tr key=${s.id}><td class="name-cell"><div class="item-name"><span class="nm"><${InlineText} value=${s.name} onSave=${(v) => call('renameItem', s.id, v).then(changed, toastError)} /></span><button class="open-btn" style="opacity:1" onClick=${() => openItem(s.id)}>Open</button></div></td>
        ${cols.map((c) => html`<td key=${c.id}><${Cell} col=${c} item=${s} B=${B} ctx=${ctx} onSet=${(v) => call('setValue', s.id, c.id, v).then(changed)} reload=${changed} compact /></td>`)}</tr>`)}</tbody></table></div>
    <div class="row mt2"><input class="input grow" placeholder="Add a subitem" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') add(); }} /><button class="btn primary" onClick=${add}>Add</button></div>
    ${!cols.length ? html`<div class="small muted mt2">Subitem columns are added from the board table: expand an item's subitems and use + in their header.</div>` : null}
  </div>`;
}

function Files({ d, changed }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);
  const add = async (files) => {
    for (const f of files) {
      try { await call('addFile', d.item.id, '', { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }); } catch (e) { toastError(e); }
    }
    changed();
  };
  return html`<div onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); add([...e.dataTransfer.files]); }}>
    <div class="drop-hint" style=${over ? 'border-color:var(--brand);background:var(--brand-soft)' : ''}>Drop files here or <a onClick=${() => input.current.click()}>browse</a>. Files are copied into Boardenda's data folder.</div>
    <input type="file" multiple hidden ref=${input} onChange=${(e) => add([...e.target.files])} />
    <table class="plain mt2"><tbody>${d.fileList.map((f) => html`<tr key=${f.id}><td><a onClick=${() => native('openFile', { id: f.id }).catch(toastError)}><${Icon} name="file" size="14" /> ${f.name}</a></td><td class="small muted">${bytes(f.size)}</td><td class="small muted">${relTime(f.added_at)}</td>
      <td style="text-align:right"><button class="btn ghost small" onClick=${() => native('saveFileAs', { id: f.id, name: f.name }).catch(toastError)}>Save as</button><button class="btn icon ghost small" aria-label="Remove file" onClick=${() => call('removeFile', f.id).then(changed, toastError)}><${Icon} name="trash" size="14" /></button></td></tr>`)}</tbody></table>
  </div>`;
}

const ACTION_TEXT = {
  item_created: 'created the item', subitem_created: 'added a subitem', renamed: 'renamed', moved_group: 'moved to group', moved_board: 'moved to board',
  archived: 'archived', restored: 'restored', item_deleted: 'deleted', update: 'posted an update', reply: 'replied', file: 'added a file', button: 'clicked',
  group_deleted: 'deleted group', group_archived: 'archived group', group_restored: 'restored group', column_deleted: 'deleted column', column_renamed: 'renamed column',
  board_created: 'created the board', board_renamed: 'renamed the board', board_archived: 'archived the board', board_restored: 'restored the board',
};

export function ActivityLog({ rows, people, openItem }) {
  if (!rows.length) return html`<div class="muted">No activity yet.</div>`;
  const who = (id) => (id === 'automation' ? 'Automation' : (people.find((p) => p.id === id) || {}).name || 'Someone');
  return html`<div>${rows.map((r) => html`<div class="act-row" key=${r.id}>
    <span class="small muted" title=${r.ts}>${relTime(r.ts)}</span>
    <span><b>${who(r.actor)}</b>${r.source && r.source !== 'manual' && r.actor !== 'automation' ? html` <span class="chip" style="padding:0 5px">${r.source}</span>` : ''} ${r.action === 'value'
      ? html`changed <b>${r.column_title || 'a column'}</b>${r.item_name ? html` on <a onClick=${() => openItem && openItem(r.item_id)}>${r.item_name}</a>` : ''}: ${r.old_value ? html`<span class="ov">${r.old_value}</span> → ` : ''}${r.new_value || html`<span class="faint">empty</span>`}`
      : html`${ACTION_TEXT[r.action] || r.action}${r.item_name && !['item_deleted'].includes(r.action) ? html` <a onClick=${() => openItem && openItem(r.item_id)}>${r.item_name}</a>` : ''}${r.old_value && r.action !== 'value' ? html` <span class="ov">${r.old_value}</span>` : ''}${r.new_value && !['item_created', 'subitem_created'].includes(r.action) ? html` ${r.action.includes('moved') || r.action === 'renamed' ? '→ ' : ''}${r.new_value}` : ''}`}</span>
  </div>`)}</div>`;
}
void plural;
