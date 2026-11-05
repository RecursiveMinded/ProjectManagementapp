// Customer directory: a page listing every account, and a profile drawer with
// details, contacts, devices, notes, files, the tasks assigned to the customer
// (through a Customer column) and their calls.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Spinner, Drawer, Modal, Menu, useAnchor, toastError, toast, ask, Avatar, shortDate, todayIso, bytes, relTime, usePersist } from './lib.js';
import { call, native } from './api.js';
import { RichText } from './docs.js';
import { MeetingRow, newMeeting } from './meetings.js';

export const STATUS = { prospect: ['Prospect', '#8a4fd8'], active: ['Active', '#2bb673'], on_hold: ['On hold', '#f2a516'], former: ['Former', '#9aa3b2'] };
const DEVICE_STATUS = { active: ['In service', '#2bb673'], pending: ['Pending install', '#3aa0e8'], repair: ['Needs repair', '#e2445c'], retired: ['Retired', '#9aa3b2'] };
export const openCustomer = (id) => window.dispatchEvent(new CustomEvent('bd-open-customer', { detail: id }));
const changed = () => window.dispatchEvent(new CustomEvent('bd-customers-changed'));
const Pill = ({ s, map }) => { const [l, c] = map[s] || map.active; return html`<span class="cust-status" style=${`--sc:${c}`}>${l}</span>`; };
const mail = (e) => e && html`<a onClick=${(ev) => { ev.stopPropagation(); native('openExternal', { url: `mailto:${e}` }).catch(toastError); }}>${e}</a>`;
const tel = (p) => p && html`<a onClick=${(ev) => { ev.stopPropagation(); native('openExternal', { url: `tel:${p.replace(/[^\d+]/g, '')}` }).catch(toastError); }}>${p}</a>`;

/** The Customers page. */
export function CustomersPage({ boot, version }) {
  const [opt, setOpt] = usePersist('customers', { status: '' });
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = () => call('listCustomers', { q: q.trim() || undefined, status: opt.status || undefined }).then(setList, toastError);
  useEffect(() => { const t = setTimeout(load, q ? 150 : 0); return () => clearTimeout(t); }, [q, opt.status, version]);
  useEffect(() => { const h = () => load(); window.addEventListener('bd-customers-changed', h); return () => window.removeEventListener('bd-customers-changed', h); }, [q, opt.status]);
  const people = Object.fromEntries(boot.people.map((p) => [p.id, p]));
  const t = todayIso();
  return html`<div class="page customers-page">
    <div class="page-head"><h1>Customers</h1><span class="muted small">${list ? `${list.length} ${list.length === 1 ? 'account' : 'accounts'}` : ''}</span><span class="grow"></span>
      <button class="btn primary" onClick=${() => setAdding(true)}><${Icon} name="plus" /> New customer</button></div>
    <div class="row" style="gap:8px;margin:-6px 0 12px;flex-wrap:wrap">
      <div class="seg">${[['', 'All'], ...Object.entries(STATUS).map(([k, [l]]) => [k, l])].map(([k, l]) => html`<button key=${k} class=${opt.status === k ? 'on' : ''} onClick=${() => setOpt({ ...opt, status: k })}>${l}</button>`)}</div>
      <input class="input" style="width:300px;height:30px" placeholder="Search names, contacts, emails, phones or serial numbers" value=${q} onInput=${(e) => setQ(e.target.value)} />
    </div>
    ${!list ? html`<${Spinner} />` : html`<div class="card cust-table"><table class="plain">
      <thead><tr><th>Customer</th><th>Status</th><th>Main contact</th><th>Phone and email</th><th class="num">Devices</th><th class="num">Open tasks</th><th>Calls</th><th>Owner</th></tr></thead>
      <tbody>${list.map((c) => html`<tr key=${c.id} class="click" onClick=${() => openCustomer(c.id)}>
        <td><b>${c.name}</b>${c.accountNo || c.industry ? html`<div class="small muted">${[c.accountNo, c.industry].filter(Boolean).join(' · ')}</div>` : null}</td>
        <td><${Pill} s=${c.status} map=${STATUS} /></td>
        <td>${c.primary ? c.primary.name : html`<span class="faint small">None yet</span>`}${c.contacts > 1 ? html`<span class="small muted"> +${c.contacts - 1}</span>` : null}</td>
        <td class="small">${tel((c.primary && c.primary.phone) || c.phone)}${((c.primary && c.primary.phone) || c.phone) && ((c.primary && c.primary.email) || c.email) ? html`<br />` : null}${mail((c.primary && c.primary.email) || c.email)}</td>
        <td class="num">${c.devices || html`<span class="faint">0</span>`}</td>
        <td class="num">${c.openTasks || html`<span class="faint">0</span>`}</td>
        <td class="small">${c.nextCall ? html`<span class=${c.nextCall === t ? 'today' : ''}>Next ${shortDate(c.nextCall)}</span>` : c.lastCall ? html`<span class="muted">Last ${shortDate(c.lastCall)}</span>` : html`<span class="faint">None</span>`}</td>
        <td>${c.owner && people[c.owner] ? html`<${Avatar} person=${people[c.owner]} size=${24} />` : null}</td></tr>`)}</tbody></table>
      ${!list.length ? html`<div class="empty"><${Icon} name="building" /><h3>${q || opt.status ? 'No customers match' : 'No customers yet'}</h3><div>Keep each account's contacts, devices, notes and files in one place, then assign customers to tasks with a Customer column.</div></div>` : null}</div>`}
    ${adding ? html`<${NewCustomer} onClose=${() => setAdding(false)} onDone=${(id) => { setAdding(false); load(); openCustomer(id); }} />` : null}
  </div>`;
}

function NewCustomer({ onClose, onDone, preset = {} }) {
  const [f, setF] = useState({ name: '', status: 'active', industry: '', phone: '', email: '', contact: '', contactEmail: '', contactPhone: '', ...preset });
  const set = (k, v) => setF({ ...f, [k]: v });
  const save = async () => {
    try {
      const id = await call('saveCustomer', { name: f.name, status: f.status, industry: f.industry, phone: f.phone, email: f.email });
      if (f.contact.trim()) await call('saveCustomerContact', id, { name: f.contact, email: f.contactEmail, phone: f.contactPhone, primary: true });
      changed(); onDone(id);
    } catch (e) { toastError(e); }
  };
  return html`<${Modal} title="New customer" onClose=${onClose}>
    <div class="grid2">
      <label class="field" style="grid-column:span 2">Customer or account name<input class="input" autoFocus value=${f.name} onInput=${(e) => set('name', e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && f.name.trim() && save()} /></label>
      <label class="field">Status<select class="input" value=${f.status} onChange=${(e) => set('status', e.target.value)}>${Object.entries(STATUS).map(([k, [l]]) => html`<option value=${k}>${l}</option>`)}</select></label>
      <label class="field">Industry<input class="input" value=${f.industry} onInput=${(e) => set('industry', e.target.value)} /></label>
      <label class="field">Main phone<input class="input" value=${f.phone} onInput=${(e) => set('phone', e.target.value)} /></label>
      <label class="field">Main email<input class="input" value=${f.email} onInput=${(e) => set('email', e.target.value)} /></label>
      <div class="small muted" style="grid-column:span 2;margin-top:6px">Main contact (optional; add more on the profile)</div>
      <label class="field">Name<input class="input" value=${f.contact} onInput=${(e) => set('contact', e.target.value)} /></label>
      <label class="field">Email<input class="input" value=${f.contactEmail} onInput=${(e) => set('contactEmail', e.target.value)} /></label>
      <label class="field">Phone<input class="input" value=${f.contactPhone} onInput=${(e) => set('contactPhone', e.target.value)} /></label>
    </div>
    <div class="row mt"><span class="grow"></span><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${!f.name.trim()} onClick=${save}>Create customer</button></div>
  </${Modal}>`;
}

/** A customer profile. */
export function CustomerDrawer({ id, boot, onClose, openItem }) {
  const [c, setC] = useState(null);
  const [tab, setTab] = usePersist('custTab', 'contacts');
  const [menu, openMenu, closeMenu] = useAnchor();
  const load = () => call('getCustomer', id).then(setC, (e) => { toastError(e); onClose(); });
  useEffect(() => { load(); }, [id]);
  useEffect(() => { const h = () => load(); window.addEventListener('bd-meetings-changed', h); return () => window.removeEventListener('bd-meetings-changed', h); }, [id]);
  if (!c) return html`<div><div class="scrim" onClick=${onClose}></div><aside class="drawer wide"><div class="bd"><${Spinner} /></div></aside></div>`;
  const save = (patch) => call('saveCustomer', { id, ...patch }).then(() => { setC((cur) => ({ ...cur, ...patch })); changed(); }, (e) => { toastError(e); load(); });
  const field = (k, label, ph, type = 'text') => html`<div class="fl">${label}</div><input class="input bare" type=${type} aria-label=${label} placeholder=${ph || ''} value=${c[k] || ''}
    onBlur=${(e) => e.target.value !== (c[k] || '') && save({ [k]: e.target.value })} />`;
  const del = async () => {
    if (!(await ask({ title: `Delete ${c.name}?`, body: 'Its contacts, devices, notes and files are deleted, and it is cleared from tasks. Calls keep the name.' }))) return;
    try { await call('deleteCustomer', id); changed(); onClose(); toast(`${c.name} deleted`); } catch (e) { toastError(e); }
  };
  const copy = () => call('customerSummary', id).then((t) => navigator.clipboard.writeText(t)).then(() => toast('Customer card copied'), toastError);
  const open = c.tasks.filter((x) => !x.done).length;
  const tabs = [['contacts', `Contacts${c.contacts.length ? ` / ${c.contacts.length}` : ''}`], ['devices', `Devices${c.devices.length ? ` / ${c.devices.length}` : ''}`], ['notes', 'Notes'],
    ['tasks', `Tasks${open ? ` / ${open}` : ''}`], ['calls', `Calls${c.calls.length ? ` / ${c.calls.length}` : ''}`], ['files', `Files${c.files.length ? ` / ${c.files.length}` : ''}`]];
  const people = Object.fromEntries(boot.people.map((p) => [p.id, p]));
  return html`<${Drawer} wide title=${c.name} sub=${[STATUS[c.status] ? STATUS[c.status][0] : '', c.accountNo && `Account ${c.accountNo}`, c.industry].filter(Boolean).join(' · ')} onClose=${onClose}>
    <div class="row" style="gap:6px;margin:-4px 0 10px;flex-wrap:wrap">
      <div class="seg">${Object.entries(STATUS).map(([k, [l]]) => html`<button key=${k} class=${c.status === k ? 'on' : ''} onClick=${() => save({ status: k })}>${l}</button>`)}</div>
      <span class="grow"></span>
      <button class="btn small" onClick=${() => newMeeting({ kind: 'call', customer: c.name })}><${Icon} name="phone" size="14" /> Log a call</button>
      <button class="btn small" onClick=${copy}><${Icon} name="copy" size="14" /> Copy card</button>
      <button class="btn icon" aria-label="Customer menu" onClick=${openMenu}><${Icon} name="more" /></button>
    </div>
    <div class="fields meet-fields cust-fields">
      ${field('name', 'Name')}
      ${field('accountNo', 'Account no.', 'Your reference for this account')}
      ${field('industry', 'Industry')}
      ${field('phone', 'Main phone', '', 'tel')}
      ${field('email', 'Main email', '', 'email')}
      ${field('website', 'Website', 'https://')}
      ${field('address', 'Address')}
      <div class="fl">Account owner</div><select class="input bare" aria-label="Account owner" value=${c.owner || ''} onChange=${(e) => save({ owner: e.target.value || null })}>
        <option value="">No owner</option>${boot.people.map((p) => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}</select>
      <div class="fl">Tags</div><input class="input bare" aria-label="Tags" placeholder="Separate with commas" value=${(c.tags || []).join(', ')}
        onBlur=${(e) => e.target.value !== (c.tags || []).join(', ') && save({ tags: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
    </div>
    <div class="ptabs" style="margin-top:14px">${tabs.map(([k, l]) => html`<button key=${k} class=${`tab ${tab === k ? 'on' : ''}`} onClick=${() => setTab(k)}>${l}</button>`)}</div>
    <div class="mt2">
      ${tab === 'contacts' ? html`<${Contacts} c=${c} reload=${load} />` : null}
      ${tab === 'devices' ? html`<${Devices} c=${c} reload=${load} />` : null}
      ${tab === 'notes' ? html`<${RichText} key=${`n${c.id}`} label="Customer notes" placeholder="Background, preferences, history, anything worth remembering" value=${c.notes} onSave=${(h) => call('saveCustomer', { id, notes: h })} />` : null}
      ${tab === 'tasks' ? html`<${Tasks} c=${c} people=${people} openItem=${openItem} reload=${load} />` : null}
      ${tab === 'calls' ? html`<div class="col" style="gap:8px"><div class="row"><span class="small muted grow">Calls and meetings with ${c.name}.</span>
          <button class="btn small primary" onClick=${() => newMeeting({ kind: 'call', customer: c.name })}><${Icon} name="phone" size="14" /> Log a call</button></div>
        <div class="card">${[...c.calls].reverse().map((m) => html`<${MeetingRow} key=${m.id} m=${m} people=${people} />`)}
          ${!c.calls.length ? html`<div class="empty small" style="padding:20px">No calls logged with this customer yet.</div>` : null}</div></div>` : null}
      ${tab === 'files' ? html`<${Files} c=${c} reload=${load} />` : null}
    </div>
    ${menu ? html`<${Menu} anchor=${menu} onClose=${closeMenu} align="right" width=${240} items=${[
      { label: 'Copy customer card', icon: 'copy', onClick: copy },
      { label: 'Log a call', icon: 'phone', onClick: () => newMeeting({ kind: 'call', customer: c.name }) },
      { sep: true },
      { label: 'Delete customer', icon: 'trash', danger: true, onClick: del },
    ]} />` : null}
  </${Drawer}>`;
}

function Contacts({ c, reload }) {
  const [edit, setEdit] = useState(null);
  const remove = async (k) => { if (await ask({ title: `Remove ${k.name}?`, ok: 'Remove' })) call('removeCustomerContact', k.id).then(() => { reload(); changed(); }, toastError); };
  return html`<div class="col" style="gap:8px">
    <div class="row"><span class="small muted grow">People you deal with at ${c.name}. The main contact shows in the directory.</span>
      <button class="btn small primary" onClick=${() => setEdit({ name: '', title: '', email: '', phone: '', mobile: '', notes: '', primary: !c.contacts.length })}><${Icon} name="plus" size="14" /> Add contact</button></div>
    <div class="cust-cards">${c.contacts.map((k) => html`<div class="card cust-card" key=${k.id}>
      <div class="row" style="gap:8px"><${Avatar} person=${{ name: k.name, color: '#2f6fdf' }} size=${32} /><div class="grow" style="min-width:0"><b class="clip">${k.name}</b>${k.title ? html`<div class="small muted clip">${k.title}</div>` : null}</div>
        ${k.primary ? html`<span class="chip">Main</span>` : null}</div>
      <div class="cust-lines small">${k.email ? html`<div><${Icon} name="mail" size="13" />${mail(k.email)}</div>` : null}${k.phone ? html`<div><${Icon} name="phone" size="13" />${tel(k.phone)}</div>` : null}
        ${k.mobile ? html`<div><${Icon} name="phone" size="13" />${tel(k.mobile)} <span class="faint">mobile</span></div>` : null}${k.notes ? html`<div class="muted">${k.notes}</div>` : null}</div>
      <div class="row" style="gap:4px"><button class="btn small ghost" onClick=${() => setEdit({ ...k })}>Edit</button>
        ${!k.primary ? html`<button class="btn small ghost" onClick=${() => call('saveCustomerContact', c.id, { ...k, primary: true }).then(() => { reload(); changed(); }, toastError)}>Make main</button>` : null}
        <span class="grow"></span><button class="btn icon ghost small" aria-label=${`Remove ${k.name}`} onClick=${() => remove(k)}><${Icon} name="trash" size="14" /></button></div></div>`)}</div>
    ${!c.contacts.length ? html`<div class="empty small" style="padding:20px">No contacts yet. Add names, titles, emails and phone numbers.</div>` : null}
    ${edit ? html`<${Modal} title=${edit.id ? `Edit ${edit.name}` : 'Add contact'} onClose=${() => setEdit(null)}>
      <div class="grid2">
        <label class="field">Name<input class="input" autoFocus value=${edit.name} onInput=${(e) => setEdit({ ...edit, name: e.target.value })} /></label>
        <label class="field">Job title or role<input class="input" value=${edit.title} onInput=${(e) => setEdit({ ...edit, title: e.target.value })} /></label>
        <label class="field">Email<input class="input" type="email" value=${edit.email} onInput=${(e) => setEdit({ ...edit, email: e.target.value })} /></label>
        <label class="field">Phone<input class="input" value=${edit.phone} onInput=${(e) => setEdit({ ...edit, phone: e.target.value })} /></label>
        <label class="field">Mobile<input class="input" value=${edit.mobile} onInput=${(e) => setEdit({ ...edit, mobile: e.target.value })} /></label>
        <label class="check" style="align-self:end"><input type="checkbox" checked=${edit.primary} onChange=${(e) => setEdit({ ...edit, primary: e.target.checked })} /> Main contact</label>
        <label class="field" style="grid-column:span 2">Notes<textarea class="input" rows="3" value=${edit.notes} onInput=${(e) => setEdit({ ...edit, notes: e.target.value })}></textarea></label>
      </div>
      <div class="row mt"><span class="grow"></span><button class="btn" onClick=${() => setEdit(null)}>Cancel</button>
        <button class="btn primary" disabled=${!edit.name.trim()} onClick=${() => call('saveCustomerContact', c.id, edit).then(() => { setEdit(null); reload(); changed(); }, toastError)}>Save contact</button></div>
    </${Modal}>` : null}
  </div>`;
}

function Devices({ c, reload }) {
  const [edit, setEdit] = useState(null);
  const remove = async (d) => { if (await ask({ title: `Remove ${d.name}?`, ok: 'Remove' })) call('removeCustomerDevice', d.id).then(() => { reload(); changed(); }, toastError); };
  return html`<div class="col" style="gap:8px">
    <div class="row"><span class="small muted grow">Equipment and devices at ${c.name}, with serial numbers and where they are.</span>
      <button class="btn small primary" onClick=${() => setEdit({ name: '', kind: '', model: '', serial: '', location: '', status: 'active', installed: '', notes: '' })}><${Icon} name="plus" size="14" /> Add device</button></div>
    ${c.devices.length ? html`<div class="card"><table class="plain"><thead><tr><th>Device</th><th>Type</th><th>Model</th><th>Serial no.</th><th>Location</th><th>Status</th><th>Installed</th><th></th></tr></thead>
      <tbody>${c.devices.map((d) => html`<tr key=${d.id} class="click" onClick=${() => setEdit({ ...d })}><td><b>${d.name}</b>${d.notes ? html`<div class="small muted clip" style="max-width:220px">${d.notes}</div>` : null}</td>
        <td class="small">${d.kind}</td><td class="small">${d.model}</td><td class="small mono">${d.serial}</td><td class="small">${d.location}</td><td><${Pill} s=${d.status} map=${DEVICE_STATUS} /></td>
        <td class="small">${d.installed ? shortDate(d.installed) : ''}</td>
        <td style="text-align:right"><button class="btn icon ghost small" aria-label=${`Remove ${d.name}`} onClick=${(e) => { e.stopPropagation(); remove(d); }}><${Icon} name="trash" size="14" /></button></td></tr>`)}</tbody></table></div>`
      : html`<div class="empty small" style="padding:20px">No devices yet. Track model, serial number, location and status for each one.</div>`}
    ${edit ? html`<${Modal} title=${edit.id ? `Edit ${edit.name}` : 'Add device'} onClose=${() => setEdit(null)}>
      <div class="grid2">
        <label class="field">Name<input class="input" autoFocus placeholder="Front counter terminal" value=${edit.name} onInput=${(e) => setEdit({ ...edit, name: e.target.value })} /></label>
        <label class="field">Type<input class="input" placeholder="Terminal, printer, laptop…" value=${edit.kind} onInput=${(e) => setEdit({ ...edit, kind: e.target.value })} /></label>
        <label class="field">Model<input class="input" value=${edit.model} onInput=${(e) => setEdit({ ...edit, model: e.target.value })} /></label>
        <label class="field">Serial number<input class="input" value=${edit.serial} onInput=${(e) => setEdit({ ...edit, serial: e.target.value })} /></label>
        <label class="field">Location<input class="input" placeholder="Site, store or room" value=${edit.location} onInput=${(e) => setEdit({ ...edit, location: e.target.value })} /></label>
        <label class="field">Status<select class="input" value=${edit.status} onChange=${(e) => setEdit({ ...edit, status: e.target.value })}>${Object.entries(DEVICE_STATUS).map(([k, [l]]) => html`<option value=${k}>${l}</option>`)}</select></label>
        <label class="field">Installed on<input class="input" type="date" value=${edit.installed} onInput=${(e) => setEdit({ ...edit, installed: e.target.value })} /></label>
        <span></span>
        <label class="field" style="grid-column:span 2">Notes<textarea class="input" rows="3" value=${edit.notes} onInput=${(e) => setEdit({ ...edit, notes: e.target.value })}></textarea></label>
      </div>
      <div class="row mt"><span class="grow"></span><button class="btn" onClick=${() => setEdit(null)}>Cancel</button>
        <button class="btn primary" disabled=${!edit.name.trim() && !edit.model.trim()} onClick=${() => call('saveCustomerDevice', c.id, edit).then(() => { setEdit(null); reload(); changed(); }, toastError)}>Save device</button></div>
    </${Modal}>` : null}
  </div>`;
}

function Tasks({ c, people, openItem }) {
  const t = todayIso();
  return html`<div class="col" style="gap:8px">
    <div class="small muted">Items on any board with ${c.name} in a Customer column. Assign a customer from a task's Customer column, or with Assign customer in its menu.</div>
    <div class="card">${c.tasks.map((x) => html`<div class="meet-row cust-task" key=${x.subId || x.id} role="button" tabindex="0" onClick=${() => openItem(x.id)}>
      <span class="meet-main"><b class=${`clip ${x.done ? 'done-text' : ''}`}>${x.name}</b><span class="small muted clip">${x.boardName}${x.groupName ? ` · ${x.groupName}` : ''}</span></span>
      ${x.status ? html`<span class="cust-status" style=${`--sc:${x.status.color}`}>${x.status.label}</span>` : html`<span></span>`}
      <span class=${`small ${x.due && x.due < t && !x.done ? 'overdue' : 'muted'}`}>${x.due ? `Due ${shortDate(x.due)}` : ''}</span>
      <span>${(x.owners || []).slice(0, 2).map((p) => people[p] && html`<${Avatar} key=${p} person=${people[p]} size=${22} />`)}</span></div>`)}
      ${!c.tasks.length ? html`<div class="empty small" style="padding:20px">No tasks assigned to this customer yet. Add a Customer column to a board and pick ${c.name}.</div>` : null}</div>
  </div>`;
}

function Files({ c, reload }) {
  const input = useRef(null);
  const add = async (files) => {
    for (const f of files) { try { await call('addCustomerFile', c.id, { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }); } catch (e) { toastError(e); } }
    reload();
  };
  return html`<div onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { e.preventDefault(); add([...e.dataTransfer.files]); }}>
    <div class="drop-hint">Drop contracts, site photos, configs or manuals for ${c.name} here, or <a onClick=${() => input.current.click()}>browse</a>.</div>
    <input type="file" multiple hidden ref=${input} onChange=${(e) => add([...e.target.files])} />
    <table class="plain mt2"><tbody>${c.files.map((f) => html`<tr key=${f.id}><td><a onClick=${() => native('openFile', { id: f.id }).catch(toastError)}><${Icon} name="file" size="14" /> ${f.name}</a></td><td class="small muted">${bytes(f.size)}</td><td class="small muted">${relTime(f.added_at)}</td>
      <td style="text-align:right"><button class="btn ghost small" onClick=${() => native('saveFileAs', { id: f.id, name: f.name }).catch(toastError)}>Save as</button><button class="btn icon ghost small" aria-label="Remove file" onClick=${() => call('removeFile', f.id).then(reload, toastError)}><${Icon} name="trash" size="14" /></button></td></tr>`)}</tbody></table>
  </div>`;
}

/** Pick a customer for an item from its panel menu. */
export function AssignCustomer({ itemId, onClose, onDone }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => { call('customerOptions').then(setList, toastError); }, []);
  const pick = async (id) => { try { await call('assignCustomer', itemId, id); onDone(); } catch (e) { toastError(e); } };
  const create = async () => { try { const id = await call('saveCustomer', { name: q.trim() }); changed(); await pick(id); } catch (e) { toastError(e); } };
  const shown = (list || []).filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  return html`<${Modal} title="Assign a customer" onClose=${onClose}>
    <input class="input" autoFocus placeholder="Search customers" value=${q} onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { if (shown[0]) pick(shown[0].id); else if (q.trim()) create(); } }} />
    <div class="pick-list mt2" style="max-height:320px">${!list ? html`<${Spinner} />` : shown.map((c) => html`<button key=${c.id} class="mi" onClick=${() => pick(c.id)}><${Icon} name="building" size="14" /><span class="grow">${c.name}</span></button>`)}</div>
    ${q.trim() && list && !list.some((c) => c.name.toLowerCase() === q.trim().toLowerCase()) ? html`<button class="btn small mt2" onClick=${create}>Add “${q.trim()}” to Customers and assign</button>` : null}
    <div class="small muted mt2">The board gets a Customer column if it doesn't have one yet.</div>
  </${Modal}>`;
}
