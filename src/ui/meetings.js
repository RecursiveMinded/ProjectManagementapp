// Customer calls and meetings: a page listing them, a drawer to plan one and
// keep its agenda, notes, recap, files and action items, and a Calls tab on
// items. Action items get an owner and due date and can be added to a board.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Spinner, Drawer, Modal, Menu, useAnchor, toastError, toast, ask, plural, Avatar, Avatars, shortDate, todayIso, addDaysIso, bytes, relTime, usePersist } from './lib.js';
import { call, native } from './api.js';
import { RichText } from './docs.js';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const dowOf = (d) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const when = (m) => `${shortDate(m.date)} · ${m.time}`;
export const openMeeting = (id) => window.dispatchEvent(new CustomEvent('bd-open-meeting', { detail: id }));
export const newMeeting = (preset = {}) => window.dispatchEvent(new CustomEvent('bd-new-meeting', { detail: preset }));

const REPEATS = [
  ['', 'Does not repeat'], ['week', 'Every week'], ['2week', 'Every 2 weeks'], ['month', 'Every month'], ['weekdays', 'Every weekday (Mon to Fri)'], ['day', 'Every day'],
];
function ruleFor(key, date) {
  if (key === 'week') return { unit: 'week', every: 1, weekdays: [dowOf(date)] };
  if (key === '2week') return { unit: 'week', every: 2, weekdays: [dowOf(date)] };
  if (key === 'month') return { unit: 'month', every: 1 };
  if (key === 'weekdays') return { unit: 'week', every: 1, weekdays: [1, 2, 3, 4, 5] };
  if (key === 'day') return { unit: 'day', every: 1 };
  return null;
}

/** Pick an item to link: type to search every board. */
function ItemPicker({ value, onPick }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return undefined; }
    const t = setTimeout(() => call('search', q).then((r) => setRes(r.filter((x) => x.kind === 'item').slice(0, 8)), () => setRes([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  if (value) return html`<span class="row" style="gap:6px"><span class="chip" title=${value.boardName}><${Icon} name="table" size="12" /> ${value.name}</span><button class="btn ghost small" onClick=${() => onPick(null)}>Change</button></span>`;
  return html`<div class="item-pick"><input class="input" placeholder="Search for an item, deal or project" value=${q} onInput=${(e) => setQ(e.target.value)} />
    ${res.length ? html`<div class="item-pick-list">${res.map((r) => html`<button key=${r.id} class="mi" onClick=${() => { onPick({ id: r.id, name: r.name, boardName: r.boardName }); setQ(''); }}>
      <${Icon} name="table" size="14" /><span class="clip">${r.name}</span><span class="grow"></span><span class="small faint">${r.boardName}</span></button>`)}</div>` : null}</div>`;
}

/** Plan a new call or meeting. */
export function NewMeeting({ boot, preset = {}, onClose, onCreated }) {
  const [f, setF] = useState({ kind: 'call', title: '', customer: '', date: todayIso(), time: '10:00', minutes: 30, where: '', item: null, repeat: '', attendees: [boot.me.id], ...preset });
  const [customers, setCustomers] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call('meetingCustomers').then(setCustomers, () => {}); }, []);
  const set = (k, v) => setF({ ...f, [k]: v });
  const create = async () => {
    setBusy(true);
    try {
      const id = await call('createMeeting', {
        kind: f.kind, title: f.title.trim() || (f.kind === 'call' ? `Call${f.customer ? ` with ${f.customer}` : ''}` : 'Meeting'), customer: f.customer, date: f.date, time: f.time, minutes: f.minutes,
        where: f.where, itemId: f.item ? f.item.id : null, attendees: f.attendees, repeat: ruleFor(f.repeat, f.date),
      });
      onCreated(id);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return html`<${Modal} title=${f.kind === 'call' ? 'New customer call' : 'New meeting'} onClose=${onClose}>
    <div class="seg" style="margin-bottom:10px">${[['call', 'Customer call'], ['meeting', 'Meeting']].map(([k, l]) => html`<button key=${k} class=${f.kind === k ? 'on' : ''} onClick=${() => set('kind', k)}>${l}</button>`)}</div>
    <div class="grid c2">
      <label class="field">Title<input class="input" autoFocus placeholder=${f.kind === 'call' ? 'e.g. Discovery call' : 'e.g. Weekly sync'} value=${f.title} onInput=${(e) => set('title', e.target.value)} /></label>
      <label class="field">Customer<input class="input" list="bd-customers" placeholder="Company or account" value=${f.customer} onInput=${(e) => set('customer', e.target.value)} />
        <datalist id="bd-customers">${customers.map((c) => html`<option key=${c.name} value=${c.name} />`)}</datalist></label>
      <label class="field">Date<input class="input" type="date" value=${f.date} onInput=${(e) => set('date', e.target.value)} /></label>
      <div class="grid c2" style="gap:8px"><label class="field">Time<input class="input" type="time" value=${f.time} onInput=${(e) => set('time', e.target.value)} /></label>
        <label class="field">Minutes<input class="input" type="number" min="5" step="5" value=${f.minutes} onInput=${(e) => set('minutes', Number(e.target.value) || 30)} /></label></div>
      <label class="field">Where<input class="input" placeholder="Phone number, meeting link or room" value=${f.where} onInput=${(e) => set('where', e.target.value)} /></label>
      <label class="field">Repeats<select class="input" value=${f.repeat} onChange=${(e) => set('repeat', e.target.value)}>${REPEATS.map(([k, l]) => html`<option key=${k} value=${k}>${l}${k === 'week' || k === '2week' ? ` on ${DOW[dowOf(f.date) - 1]}` : ''}</option>`)}</select></label>
    </div>
    <div class="field mt2">About<${ItemPicker} value=${f.item} onPick=${(v) => set('item', v)} /></div>
    <div class="row mt2"><span class="grow"></span><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${busy} onClick=${create}>Create</button></div>
  </${Modal}>`;
}

function Attendees({ m, boot, save }) {
  const [a, open, close] = useAnchor();
  const people = Object.fromEntries(boot.people.map((p) => [p.id, p]));
  const toggle = (id) => save({ attendees: m.attendees.includes(id) ? m.attendees.filter((x) => x !== id) : [...m.attendees, id] });
  return html`<span class="row" style="gap:6px;flex-wrap:wrap">
    ${m.attendees.map((id) => people[id] ? html`<span class="chip" key=${id}><${Avatar} person=${people[id]} size=${16} /> ${people[id].name}</span>` : null)}
    <button class="btn ghost small" onClick=${open}><${Icon} name="plus" size="12" /> Team</button>
    ${a ? html`<${Menu} anchor=${a} onClose=${close} width=${240} items=${boot.people.map((p) => ({ label: p.name + (p.is_me ? ' (you)' : ''), icon: m.attendees.includes(p.id) ? 'check' : 'person', active: m.attendees.includes(p.id), onClick: () => toggle(p.id) }))} />` : null}</span>`;
}

function Contacts({ m, save }) {
  const [list, setList] = useState(m.contacts);
  const commit = (next) => { setList(next); save({ contacts: next }); };
  const edit = (i, k, v) => setList(list.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  return html`<div class="col" style="gap:4px">
    ${list.map((c, i) => html`<div class="row contact-row" key=${i}>
      <input class="input" placeholder="Name" aria-label="Contact name" value=${c.name} onInput=${(e) => edit(i, 'name', e.target.value)} onBlur=${() => save({ contacts: list })} />
      <input class="input" placeholder="Company" aria-label="Contact company" value=${c.company} onInput=${(e) => edit(i, 'company', e.target.value)} onBlur=${() => save({ contacts: list })} />
      <input class="input" placeholder="Email" aria-label="Contact email" value=${c.email} onInput=${(e) => edit(i, 'email', e.target.value)} onBlur=${() => save({ contacts: list })} />
      <input class="input" placeholder="Phone" aria-label="Contact phone" value=${c.phone} onInput=${(e) => edit(i, 'phone', e.target.value)} onBlur=${() => save({ contacts: list })} />
      <button class="btn icon ghost small" aria-label="Remove contact" onClick=${() => commit(list.filter((_, j) => j !== i))}><${Icon} name="x" size="14" /></button></div>`)}
    <div><button class="btn ghost small" onClick=${() => setList([...list, { name: '', company: m.customer || '', email: '', phone: '' }])}><${Icon} name="plus" size="12" /> Outside contact</button></div></div>`;
}

/** Action items: what happens next, who owns it, by when, and on which board. */
function Actions({ m, boot, reload, openItem }) {
  const [text, setText] = useState('');
  const [owner, setOwner] = useState(boot.me.id);
  const [due, setDue] = useState(addDaysIso(m.date > todayIso() ? m.date : todayIso(), 3));
  const [boardFor, setBoardFor] = useState(null);
  const boards = boot.workspaces.flatMap((w) => w.boards.map((b) => ({ ...b, ws: w.name })));
  const add = async () => {
    if (!text.trim()) return;
    try { await call('addMeetingAction', m.id, { text, owner, due }); setText(''); reload(); } catch (e) { toastError(e); }
  };
  const upd = (id, patch) => call('updateMeetingAction', id, patch).then(reload, toastError);
  return html`<div class="col" style="gap:6px">
    <div class="small muted">Who does what next. Add an action to a board to put it into that team's workflow: the owner and due date go into its People and Date columns, and it shows in their My work.</div>
    <table class="plain actions"><tbody>${m.actions.map((a) => html`<tr key=${a.id} class=${a.done ? 'done' : ''}>
      <td style="width:26px"><input type="checkbox" aria-label="Done" checked=${a.done} onChange=${(e) => upd(a.id, { done: e.target.checked })} /></td>
      <td><input class="input bare" aria-label="Action" value=${a.text} onBlur=${(e) => e.target.value !== a.text && upd(a.id, { text: e.target.value })} /></td>
      <td style="width:150px"><select class="input" aria-label="Owner" value=${a.owner || ''} onChange=${(e) => upd(a.id, { owner: e.target.value })}><option value="">No owner</option>${boot.people.map((p) => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}</select></td>
      <td style="width:140px"><input class="input" type="date" aria-label="Due" value=${a.due || ''} onChange=${(e) => upd(a.id, { due: e.target.value })} /></td>
      <td style="width:170px;text-align:right">${a.item ? html`<a class="chip" title=${`${a.item.boardName}${a.item.status ? ` · ${a.item.status}` : ''}`} onClick=${() => openItem(a.item.id)}><${Icon} name="table" size="12" /> ${a.item.boardName}</a>`
        : html`<button class="btn ghost small" onClick=${(e) => setBoardFor({ a, anchor: e.currentTarget })}><${Icon} name="plus" size="12" /> Add to board</button>`}
        <button class="btn icon ghost small" aria-label="Remove action" onClick=${() => call('removeMeetingAction', a.id).then(reload, toastError)}><${Icon} name="trash" size="14" /></button></td></tr>`)}</tbody></table>
    <div class="row action-add" style="gap:6px">
      <input class="input grow" placeholder="Next action, e.g. Send the quote" value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') add(); }} />
      <select class="input" style="width:150px" aria-label="New action owner" value=${owner} onChange=${(e) => setOwner(e.target.value)}><option value="">No owner</option>${boot.people.map((p) => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}</select>
      <input class="input" style="width:140px" type="date" aria-label="New action due" value=${due} onInput=${(e) => setDue(e.target.value)} />
      <button class="btn primary" onClick=${add}>Add action</button></div>
    ${boardFor ? html`<${Menu} anchor=${boardFor.anchor} onClose=${() => setBoardFor(null)} width=${280} items=${[{ head: true, label: 'Add as an item on…' },
      ...boards.map((b) => ({ label: b.name, hint: b.ws, icon: 'table', onClick: () => call('meetingActionToItem', boardFor.a.id, { boardId: b.id }).then(() => { toast(`Added to ${b.name}`); reload(); }, toastError) }))]} />` : null}
  </div>`;
}

function MeetingFiles({ m, reload }) {
  const input = useRef(null);
  const add = async (files) => {
    for (const f of files) { try { await call('addMeetingFile', m.id, { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }); } catch (e) { toastError(e); } }
    reload();
  };
  return html`<div onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { e.preventDefault(); add([...e.dataTransfer.files]); }}>
    <div class="drop-hint">Drop slides, quotes or documents for this meeting here, or <a onClick=${() => input.current.click()}>browse</a>.</div>
    <input type="file" multiple hidden ref=${input} onChange=${(e) => add([...e.target.files])} />
    <table class="plain mt2"><tbody>${m.files.map((f) => html`<tr key=${f.id}><td><a onClick=${() => native('openFile', { id: f.id }).catch(toastError)}><${Icon} name="file" size="14" /> ${f.name}</a></td><td class="small muted">${bytes(f.size)}</td><td class="small muted">${relTime(f.added_at)}</td>
      <td style="text-align:right"><button class="btn ghost small" onClick=${() => native('saveFileAs', { id: f.id, name: f.name }).catch(toastError)}>Save as</button><button class="btn icon ghost small" aria-label="Remove file" onClick=${() => call('removeFile', f.id).then(reload, toastError)}><${Icon} name="trash" size="14" /></button></td></tr>`)}</tbody></table>
  </div>`;
}

/** One call or meeting: details, agenda, notes, recap, actions and files. */
export function MeetingDrawer({ id, boot, onClose, openItem, onChanged }) {
  const [m, setM] = useState(null);
  const [tab, setTab] = useState(null);
  const [menu, openMenu, closeMenu] = useAnchor();
  const [repeat, setRepeat] = useState(null);
  const load = () => call('getMeeting', id).then((x) => { setM(x); setTab((t) => t || (x.status === 'held' || x.date < todayIso() ? 'notes' : 'agenda')); }, (e) => { toastError(e); onClose(); });
  useEffect(() => { load(); }, [id]);
  const changed = () => { load(); onChanged && onChanged(); };
  const save = (patch) => call('updateMeeting', id, patch).then((x) => { setM((cur) => ({ ...cur, ...x })); onChanged && onChanged(); }, toastError);
  const saveHtml = (k) => (h) => call('updateMeeting', id, { [k]: h }).then(() => onChanged && onChanged());
  if (!m) return html`<div><div class="scrim" onClick=${onClose}></div><aside class="drawer wide"><div class="bd"><${Spinner} /></div></aside></div>`;
  const del = async (series) => {
    if (!(await ask({ title: series ? 'Delete this and later meetings?' : 'Delete this meeting?', body: 'Its notes, recap, action items and files are deleted too. Items already added to boards stay.' }))) return;
    try { await call('deleteMeeting', id, { series }); onChanged && onChanged(); onClose(); } catch (e) { toastError(e); }
  };
  const copy = () => call('meetingSummary', id).then((t) => navigator.clipboard.writeText(t)).then(() => toast('Summary copied. Paste it into an email.'), toastError);
  const tabs = [['agenda', 'Agenda'], ['notes', 'Notes'], ['recap', 'Recap'], ['actions', `Action items${m.open ? ` / ${m.open}` : ''}`], ['files', `Files${m.files.length ? ` / ${m.files.length}` : ''}`]];
  return html`<${Drawer} wide title=${m.title} sub=${`${m.kind === 'call' ? 'Customer call' : 'Meeting'}${m.customer ? ` with ${m.customer}` : ''} · ${when(m)}${m.repeat ? ` · ↻ ${m.repeat}` : ''}`} onClose=${onClose}>
    <div class="row" style="gap:6px;margin:-4px 0 10px;flex-wrap:wrap">
      <div class="seg">${[['planned', 'Planned'], ['held', 'Held'], ['cancelled', 'Cancelled']].map(([k, l]) => html`<button key=${k} class=${m.status === k ? 'on' : ''} onClick=${() => save({ status: k })}>${l}</button>`)}</div>
      <span class="grow"></span>
      <button class="btn small" onClick=${copy}><${Icon} name="copy" size="14" /> Copy summary</button>
      <button class="btn icon" aria-label="Meeting menu" onClick=${openMenu}><${Icon} name="more" /></button>
    </div>
    <div class="fields meet-fields">
      <div class="fl">Title</div><input class="input bare" aria-label="Title" value=${m.title} onBlur=${(e) => e.target.value !== m.title && save({ title: e.target.value })} />
      <div class="fl">When</div><div class="row" style="gap:6px"><input class="input" type="date" aria-label="Date" value=${m.date} onChange=${(e) => save({ date: e.target.value })} />
        <input class="input" type="time" aria-label="Time" value=${m.time} onChange=${(e) => save({ time: e.target.value })} />
        <input class="input" style="width:80px" type="number" min="5" step="5" aria-label="Minutes" value=${m.minutes} onChange=${(e) => save({ minutes: Number(e.target.value) })} /><span class="small muted">min</span></div>
      <div class="fl">Customer</div><div class="row" style="gap:6px"><input class="input bare grow" aria-label="Customer" placeholder="Company or account" value=${m.customer} onBlur=${(e) => e.target.value !== m.customer && save({ customer: e.target.value })} />
        ${m.customer ? html`<button class="btn ghost small" onClick=${() => call('customerOptions').then((l) => { const hit = l.find((x) => x.name.toLowerCase() === m.customer.toLowerCase()); if (hit) window.dispatchEvent(new CustomEvent('bd-open-customer', { detail: hit.id })); else toast('Not in Customers yet'); }, toastError)}><${Icon} name="building" size="13" /> Profile</button>` : null}</div>
      <div class="fl">Where</div><input class="input bare" aria-label="Where" placeholder="Phone number, link or room" value=${m.where} onBlur=${(e) => e.target.value !== m.where && save({ where: e.target.value })} />
      <div class="fl">About</div><div>${m.item ? html`<span class="row" style="gap:6px"><a class="chip" onClick=${() => openItem(m.item.id)}><${Icon} name="table" size="12" /> ${m.item.name} · ${m.item.boardName}</a><button class="btn ghost small" onClick=${() => save({ itemId: null })}>Unlink</button></span>`
        : html`<${ItemPicker} value=${null} onPick=${(v) => v && save({ itemId: v.id })} />`}</div>
      <div class="fl">Our team</div><${Attendees} m=${m} boot=${boot} save=${save} />
      <div class="fl" style="align-self:start;padding-top:8px">Their side</div><${Contacts} key=${m.id} m=${m} save=${save} />
      ${m.next ? html`<div class="fl">Next action</div><div class="next-action"><b>${m.next.text}</b>${m.next.owner ? ` · ${(boot.people.find((p) => p.id === m.next.owner) || {}).name || ''}` : ''}${m.next.due ? ` · due ${shortDate(m.next.due)}` : ''}</div>` : null}
    </div>
    <div class="ptabs" style="margin-top:14px">${tabs.map(([k, l]) => html`<button key=${k} class=${`tab ${tab === k ? 'on' : ''}`} onClick=${() => setTab(k)}>${l}</button>`)}</div>
    <div class="mt2">
      ${tab === 'agenda' ? html`<${RichText} key=${`a${m.id}`} label="Agenda" placeholder="What to cover on this call" value=${m.agenda} onSave=${saveHtml('agenda')} />` : null}
      ${tab === 'notes' ? html`<${RichText} key=${`n${m.id}`} label="Notes" placeholder="Notes taken during the call" value=${m.notes} onSave=${saveHtml('notes')} />` : null}
      ${tab === 'recap' ? html`<${RichText} key=${`r${m.id}`} label="Recap" placeholder="Decisions and outcomes, for the record" value=${m.recap} onSave=${saveHtml('recap')} />` : null}
      ${tab === 'actions' ? html`<${Actions} m=${m} boot=${boot} reload=${changed} openItem=${openItem} />` : null}
      ${tab === 'files' ? html`<${MeetingFiles} m=${m} reload=${changed} />` : null}
    </div>
    ${menu ? html`<${Menu} anchor=${menu} onClose=${closeMenu} align="right" width=${280} items=${[
      { label: m.repeat ? 'Change how it repeats…' : 'Make it repeat…', icon: 'refresh', hint: m.repeat || '', onClick: () => setRepeat(m.series ? '' : 'week') },
      m.seriesId && { label: 'Use this set-up for later meetings', icon: 'copy', hint: 'time, people, agenda', onClick: () => call('applyMeetingToSeries', id).then((n) => { toast(`Updated ${plural(n, 'later meeting')}`); changed(); }, toastError) },
      m.seriesId && { label: 'Stop repeating after this one', icon: 'x', onClick: () => call('stopMeetingRepeat', id).then(() => { toast('Later meetings without notes were removed'); changed(); }, toastError) },
      { label: 'Log a follow-up call', icon: 'plus', onClick: () => { onClose(); newMeeting({ kind: 'call', title: `Follow-up: ${m.title}`, customer: m.customer, item: m.item, date: m.next && m.next.due ? m.next.due : addDaysIso(todayIso(), 7) }); } },
      { sep: true },
      { label: 'Delete this meeting', icon: 'trash', danger: true, onClick: () => del(false) },
      m.seriesId && { label: 'Delete this and later ones', icon: 'trash', danger: true, onClick: () => del(true) },
    ].filter(Boolean)} />` : null}
    ${repeat != null ? html`<${Modal} title="Repeat" onClose=${() => setRepeat(null)}>
      <p class="small muted">Each meeting in the series keeps its own notes, recap, action items and files. Later meetings are scheduled about two months ahead.</p>
      <select class="input mt" value=${repeat} onChange=${(e) => setRepeat(e.target.value)}>${REPEATS.filter(([k]) => k).map(([k, l]) => html`<option key=${k} value=${k}>${l}${k === 'week' || k === '2week' ? ` on ${DOW[dowOf(m.date) - 1]}` : ''}</option>`)}</select>
      <div class="row mt2"><span class="grow"></span><button class="btn" onClick=${() => setRepeat(null)}>Cancel</button>
        <button class="btn primary" onClick=${() => call('setMeetingRepeat', id, ruleFor(repeat || 'week', m.date)).then(() => { setRepeat(null); toast('Repeating meetings scheduled'); changed(); }, toastError)}>Save</button></div></${Modal}>` : null}
  </${Drawer}>`;
}

export function MeetingRow({ m, people }) {
  const owner = m.next && m.next.owner && people[m.next.owner];
  return html`<div class=${`meet-row ${m.status}`} role="button" tabindex="0" onClick=${() => openMeeting(m.id)} onKeyDown=${(e) => { if (e.key === 'Enter') openMeeting(m.id); }}>
    <span class=${`meet-ic ${m.kind}`}><${Icon} name=${m.kind === 'call' ? 'phone' : 'people'} size="15" /></span>
    <span class="meet-when"><b>${shortDate(m.date)}</b><span class="small muted">${m.time}</span></span>
    <span class="meet-main"><b class="clip">${m.title}${m.repeat ? html` <span class="faint" title=${m.repeat}>↻</span>` : null}</b>
      <span class="small muted clip">${m.customer || ''}${m.item && m.item.name !== m.customer ? `${m.customer ? ' · ' : ''}${m.item.name}` : ''}</span></span>
    <span class="meet-next small">${m.next ? html`<span class="clip">Next: ${m.next.text}</span><span class="faint">${owner ? owner.name : 'No owner'}${m.next.due ? ` · ${shortDate(m.next.due)}` : ''}</span>` : null}</span>
    <span class="meet-flags small faint">${m.hasNotes ? 'Notes ' : ''}${m.hasRecap ? '· Recap' : ''}${m.status === 'cancelled' ? 'Cancelled' : ''}</span>
    <${Avatars} ids=${m.attendees} people=${people} size=${22} />
  </div>`;
}

/** The Calls and meetings page. */
export function MeetingsPage({ boot, openItem, version }) {
  const [opt, setOpt] = usePersist('meetings', { tab: 'upcoming', customer: '' });
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const [actions, setActions] = useState(null);
  const [customers, setCustomers] = useState([]);
  const t = todayIso();
  const load = () => {
    call('listMeetings', { q: q.trim() || undefined, customer: opt.customer || undefined }).then(setList, toastError);
    call('meetingActions', {}).then(setActions, toastError);
    call('meetingCustomers').then(setCustomers, () => {});
  };
  useEffect(() => { load(); }, [q, opt.customer, version]);
  useEffect(() => { const h = () => load(); window.addEventListener('bd-meetings-changed', h); return () => window.removeEventListener('bd-meetings-changed', h); }, [q, opt.customer]);
  const people = Object.fromEntries(boot.people.map((p) => [p.id, p]));
  const upcoming = (list || []).filter((m) => m.date >= t && m.status !== 'held');
  const past = (list || []).filter((m) => m.date < t || m.status === 'held').reverse();
  const shown = opt.tab === 'past' ? past : upcoming;
  const tabs = [['upcoming', `Upcoming${upcoming.length ? ` / ${upcoming.length}` : ''}`], ['past', 'Past and held'], ['actions', `Action items${actions && actions.length ? ` / ${actions.length}` : ''}`]];
  return html`<div class="page meetings-page">
    <div class="page-head"><h1>Calls and meetings</h1><span class="grow"></span>
      <button class="btn" onClick=${() => newMeeting({ kind: 'meeting' })}><${Icon} name="people" /> New meeting</button>
      <button class="btn primary" onClick=${() => newMeeting({ kind: 'call' })}><${Icon} name="phone" /> Log a customer call</button></div>
    <div class="row" style="gap:8px;margin:-6px 0 12px;flex-wrap:wrap">
      <div class="seg">${tabs.map(([k, l]) => html`<button key=${k} class=${opt.tab === k ? 'on' : ''} onClick=${() => setOpt({ ...opt, tab: k })}>${l}</button>`)}</div>
      <select class="input" style="width:auto;height:30px" aria-label="Customer" value=${opt.customer} onChange=${(e) => setOpt({ ...opt, customer: e.target.value })}>
        <option value="">All customers</option>${customers.map((c) => html`<option key=${c.name} value=${c.name}>${c.name} (${c.meetings})</option>`)}</select>
      <input class="input" style="width:240px;height:30px" placeholder="Search titles, notes and recaps" value=${q} onInput=${(e) => setQ(e.target.value)} />
    </div>
    ${!list ? html`<${Spinner} />` : opt.tab === 'actions' ? html`<div class="card">
        ${(actions || []).filter((a) => !opt.customer || (a.meeting.customer || '').toLowerCase() === opt.customer.toLowerCase()).map((a) => html`<div class="meet-row" key=${a.id} role="button" tabindex="0" onClick=${() => openMeeting(a.meeting.id)}>
          <input type="checkbox" aria-label="Done" checked=${a.done} onClick=${(e) => e.stopPropagation()} onChange=${(e) => call('updateMeetingAction', a.id, { done: e.target.checked }).then(load, toastError)} />
          <span class="meet-main"><b class="clip">${a.text}</b><span class="small muted clip">From ${a.meeting.title}${a.meeting.customer ? ` · ${a.meeting.customer}` : ''} · ${shortDate(a.meeting.date)}</span></span>
          <span class=${`small ${a.due && a.due < t ? 'overdue' : 'muted'}`}>${a.due ? `Due ${shortDate(a.due)}` : 'No due date'}</span>
          ${a.item ? html`<a class="chip" onClick=${(e) => { e.stopPropagation(); openItem(a.item.id); }}>${a.item.boardName}${a.item.status ? ` · ${a.item.status}` : ''}</a>` : html`<span class="small faint">Not on a board</span>`}
          ${a.owner && people[a.owner] ? html`<${Avatar} person=${people[a.owner]} size=${24} />` : html`<span class="small faint">No owner</span>`}</div>`)}
        ${!(actions || []).length ? html`<div class="empty"><${Icon} name="check" /><h3>No open action items</h3><div>Add next actions with an owner and due date in a call's Action items tab.</div></div>` : null}</div>`
      : html`<div class="card">${shown.map((m) => html`<${MeetingRow} key=${m.id} m=${m} people=${people} />`)}
        ${!shown.length ? html`<div class="empty"><${Icon} name="phone" /><h3>${opt.tab === 'past' ? 'No past calls yet' : 'Nothing scheduled'}</h3><div>Log customer calls and meetings with an agenda, notes, a recap and action items.</div></div>` : null}</div>`}
  </div>`;
}

/** The Calls tab in an item panel. */
export function ItemCalls({ d, boot }) {
  const c = d.calls || { meetings: [], openActions: [] };
  const people = Object.fromEntries((boot ? boot.people : d.people).map((p) => [p.id, p]));
  return html`<div class="col" style="gap:10px">
    <div class="row"><span class="small muted grow">Calls and meetings about this item, and their action items.</span>
      <button class="btn small primary" onClick=${() => newMeeting({ kind: 'call', item: { id: d.item.id, name: d.item.name, boardName: d.board.name } })}><${Icon} name="phone" size="14" /> Log a call</button></div>
    ${c.nextAction ? html`<div class="next-action card pad"><div class="small muted">Next action</div><b>${c.nextAction.text}</b>
      <div class="small">${c.nextAction.owner && people[c.nextAction.owner] ? people[c.nextAction.owner].name : 'No owner'}${c.nextAction.due ? ` · due ${shortDate(c.nextAction.due)}` : ''} · from <a onClick=${() => openMeeting(c.nextAction.meeting.id)}>${c.nextAction.meeting.title}</a></div></div>` : null}
    <div class="card">${[...c.meetings].reverse().map((m) => html`<${MeetingRow} key=${m.id} m=${m} people=${people} />`)}
      ${!c.meetings.length ? html`<div class="empty small" style="padding:20px">No calls logged yet.</div>` : null}</div>
  </div>`;
}
