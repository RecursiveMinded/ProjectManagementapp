// The daily assistant: drop emails, documents or a Teams chat and get a
// summary, an action plan, draft replies and where the work belongs; teach it
// with notes (OneNote .md exports) and folders.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Spinner, toast, toastError, Modal, Select, usePersist, relTime, shortDate, ask as confirm } from './lib.js';
import { call, native, isDesktop, pathFor } from './api.js';
import { AskSources } from './ask.js';

const PRI = { urgent: ['Urgent', 'var(--bad)'], high: ['High', '#d38a00'], normal: ['Normal', 'var(--brand)'], low: ['Low', 'var(--muted)'] };
const OWNER = { me: 'Me', internal: 'Internal', 'third party': 'Third party' };
const KIND_ICON = { email: 'mail', document: 'file', text: 'text', chat: 'msg' };
const MAX_FILES = 400;
const TEXTY = /\.(md|markdown|txt|msg|eml|pdf|docx|xlsx|xlsm|csv|tsv|html?|rtf|json|png|jpe?g|webp|bmp|gif|tiff?)$/i;

/** Files (and folders) from a drop or a file picker. Folders are walked; on the desktop their paths come back too. */
export async function collect(dt) {
  const files = [];
  const folders = [];
  const items = dt && dt.items ? [...dt.items] : [];
  const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  const read = async (file, rel) => { if (files.length < MAX_FILES && file.size < 40e6) files.push({ name: rel || file.name, bytes: new Uint8Array(await file.arrayBuffer()) }); };
  const walk = async (entry, prefix) => {
    if (files.length >= MAX_FILES) return;
    if (entry.isFile) { if (TEXTY.test(entry.name)) await new Promise((res) => entry.file((f) => read(f, `${prefix}${entry.name}`).then(res, res), res)); return; }
    const reader = entry.createReader();
    let batch;
    do { batch = await new Promise((res) => reader.readEntries(res, () => res([]))); for (const e of batch) await walk(e, `${prefix}${entry.name}/`); } while (batch.length);
  };
  if (entries.length && entries.some(Boolean)) {
    const plain = dt.files ? [...dt.files] : [];
    for (const [i, e] of entries.entries()) {
      if (!e) continue;
      if (e.isDirectory) {
        const p = plain[i] ? pathFor(plain[i]) : '';
        if (p) folders.push(p); else await walk(e, '');
      } else if (plain[i]) await read(plain[i]);
    }
  } else for (const f of (dt && dt.files) || []) await read(f);
  return { files, folders };
}

function mailto(r) {
  const m = String(r.to || '').match(/[\w.+'-]+@[\w-]+(\.[\w-]+)+/g) || [];
  const url = `mailto:${m.join(';')}?subject=${encodeURIComponent(r.subject || '')}&body=${encodeURIComponent(r.body || '')}`;
  if (isDesktop) native('openExternal', { url }).catch(toastError); else window.open(url, '_blank');
}
async function copy(text, msg = 'Copied') { try { await navigator.clipboard.writeText(text); toast(msg); } catch (e) { toastError(e); } }

// ------------------------------------------------------------------- today
function Today({ data, open }) {
  if (!data) return null;
  const chip = (n, label, tone) => html`<div class="as-kpi"><b style=${tone && n ? `color:${tone}` : ''}>${n}</b><span>${label}</span></div>`;
  const row = (s) => html`<button key=${s.caseId + s.index} class="as-step-row" onClick=${() => open(s.caseId)}>
    <span class="grow clip">${s.step}</span><span class="small muted clip" style="max-width:40%">${s.who ? `${s.who} · ` : ''}${s.caseTitle}</span>
    ${s.due ? html`<span class=${`small ${s.overdue ? 'bad' : 'muted'}`}>${shortDate(s.due)}</span>` : null}</button>`;
  return html`<div class="card pad as-today">
    <div class="as-kpis">${chip(data.open, 'open cases')}${chip(data.urgent, 'urgent', 'var(--bad)')}${chip(data.dueToday, 'steps due today', '#d38a00')}${chip(data.replies, 'replies to send')}${chip(data.questions, 'questions for you', 'var(--brand)')}</div>
    ${data.mine.length || data.waiting.length ? html`<div class="as-today-cols">
      <div><div class="small muted mb1">Your next steps</div>${data.mine.slice(0, 6).map(row)}${!data.mine.length ? html`<div class="small faint">Nothing for you right now.</div>` : null}</div>
      <div><div class="small muted mb1">Waiting on others</div>${data.waiting.slice(0, 6).map(row)}${!data.waiting.length ? html`<div class="small faint">Nobody owes you anything.</div>` : null}</div>
    </div>` : null}
  </div>`;
}

// ------------------------------------------------------------------- paste
function PasteBox({ onClose, onDone, caseId }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      if (caseId) { await call('assistantAddTo', caseId, { text }); onDone(caseId); } else onDone(await call('assistantIntake', { text, origin: 'paste' }));
      onClose();
    } catch (e) { toastError(e); setBusy(false); }
  };
  return html`<${Modal} title=${caseId ? 'Add more to this case' : 'Paste an email, Teams chat or notes'} onClose=${onClose} wide>
    <div class="small muted mb">Copy a whole email (with From, To and Subject), a long Teams conversation, meeting notes or anything else, and paste it here. ${caseId ? 'The plan is rebuilt with it.' : 'For a chat, you get a summary, decisions, open questions and a plan, then you can talk it through.'}</div>
    <textarea class="input as-paste" autoFocus placeholder="Paste here (Ctrl+V)" value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
    <div class="row mt"><span class="small muted">${text.length ? `${text.length.toLocaleString()} characters` : ''}</span><span class="grow"></span>
      <button class="btn" onClick=${onClose}>Cancel</button>
      <button class="btn primary" disabled=${busy || !text.trim()} onClick=${go}>${busy ? html`<${Spinner} />` : html`<${Icon} name="spark" size="15" />`} ${caseId ? 'Add and update plan' : 'Read and plan'}</button></div>
  </${Modal}>`;
}

// ------------------------------------------------------------------- settings
export function AssistantSettings({ onClose }) {
  const [cfg, setCfg] = useState(null);
  const [notes, setNotes] = useState([]);
  const load = () => { call('assistantConfig').then(setCfg, toastError); call('assistantNotes').then(setNotes, () => {}); };
  useEffect(load, []);
  if (!cfg) return null;
  const save = (patch) => call('setAssistantConfig', patch).then(() => { setCfg({ ...cfg, ...patch }); toast('Saved'); }, toastError);
  const addDocs = async () => {
    try { const p = await native('documentsPath'); await call('askAddFolder', p); await call('askIndex'); toast('Your Documents folder is being read. Big folders take a few minutes.'); } catch (e) { toastError(e); }
  };
  const watch = async () => { try { const p = await native('chooseFolder'); if (p) save({ watchFolder: p }); } catch (e) { toastError(e); } };
  return html`<${Modal} title="Assistant settings" onClose=${onClose} wide>
    <label class="field">About you and your work<textarea class="input" rows="4" value=${cfg.profile} onChange=${(e) => save({ profile: e.target.value })}></textarea>
      <span class="small muted">Used in every answer: your role, region, products, key customers and partners, internal teams and how you like to work.</span></label>
    <div class="grid2 mt">
      <label class="field">Tone for replies<input class="input" value=${cfg.tone} onChange=${(e) => save({ tone: e.target.value })} /></label>
      <label class="field">Email signature<textarea class="input" rows="3" value=${cfg.signature} onChange=${(e) => save({ signature: e.target.value })}></textarea></label>
    </div>
    <h3 class="mt2">Watch a folder</h3>
    <div class="small muted">New files saved into this folder become cases automatically within a minute, for example a folder you save Outlook emails into, or a OneDrive folder.</div>
    <div class="row mt" style="gap:8px">${cfg.watchFolder ? html`<span class="mono small grow clip">${cfg.watchFolder}</span><button class="btn small" onClick=${() => save({ watchFolder: '' })}>Stop watching</button>` : html`<span class="grow small faint">Not watching a folder.</span>`}
      ${isDesktop ? html`<button class="btn small" onClick=${watch}><${Icon} name="folder" size="14" /> ${cfg.watchFolder ? 'Change' : 'Choose folder'}</button>` : null}</div>
    <h3 class="mt2">What it knows</h3>
    <div class="row" style="gap:8px;flex-wrap:wrap"><span class="small muted grow">The assistant searches your boards, customers and calls, notes you teach it, and the folders below.</span>
      ${isDesktop ? html`<button class="btn small" onClick=${addDocs}><${Icon} name="folder" size="14" /> Add my Documents folder</button>` : null}</div>
    <div class="mt"><${AskSources} /></div>
    <div class="small muted mt2">${notes.length} ${notes.length === 1 ? 'note' : 'notes'} taught. Drop .md files from OneNote, Word or PDF documents, or whole folders on the <b>Teach</b> area of the Assistant page.</div>
    ${notes.length ? html`<div class="as-notes">${notes.slice(0, 60).map((n) => html`<div key=${n.name} class="row small"><${Icon} name="file" size="13" /><span class="grow clip">${n.name}</span><span class="faint">${relTime(n.at)}</span>
      <button class="btn ghost small" onClick=${() => call('assistantForget', n.name).then(setNotes, toastError)}>Forget</button></div>`)}</div>` : null}
  </${Modal}>`;
}

// ------------------------------------------------------------------- case
export function CaseView({ id, nav, onChanged, onDeleted }) {
  const [c, setC] = useState(null);
  const [answers, setAnswers] = useState({});
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [paste, setPaste] = useState(false);
  const [showTr, setShowTr] = useState(false);
  const [showSrc, setShowSrc] = useState(false);
  const [target, setTarget] = useState(null);
  const [struct, setStruct] = useState(null);
  const timer = useRef(null);
  const c0 = useRef(null);
  const load = () => call('assistantCase', id).then((x) => {
    setC(x);
    clearTimeout(timer.current);
    const was = c0.current; c0.current = x.state; if (x.state === 'reading' || x.state === 'thinking') timer.current = setTimeout(load, 1500); else if (was !== x.state && onChanged) onChanged();
  }, toastError);
  useEffect(() => { setC(null); setAnswers({}); setExtra(''); setTarget(null); load(); call('assistantConfig').then((x) => setStruct(x.structure), () => {}); return () => clearTimeout(timer.current); }, [id]);
  if (!c) return html`<div class="card pad"><${Spinner} /></div>`;
  const a = c.analysis;
  const upd = (patch) => call('assistantUpdate', id, patch).then((x) => { setC(x); if (onChanged) onChanged(); }, toastError);
  const run = async (label, fn) => { setBusy(label); try { await fn(); } catch (e) { toastError(e); } finally { setBusy(''); load(); } };
  const thinking = c.state === 'reading' || c.state === 'thinking';
  const pl = a ? a.placement : null;
  const boardOpts = struct ? struct.boards.map((b) => ({ value: b.id, label: `${b.workspace} › ${b.name}` })) : [];
  const tgtBoard = (target && target.boardId) || (pl && pl.boardId) || '';
  const tgtGroups = struct && tgtBoard ? (struct.boards.find((b) => b.id === tgtBoard) || { groups: [] }).groups : [];
  const tgtGroup = (target && target.groupId) || (pl && pl.boardId === tgtBoard ? pl.groupId : (tgtGroups[0] || {}).id) || '';
  const sendChat = async () => {
    if (!msg.trim()) return;
    setChatBusy(true);
    const text = msg; setMsg('');
    setC({ ...c, chat: [...c.chat, { role: 'user', content: text, at: new Date().toISOString() }] });
    try { const chat = await call('assistantChat', id, text); setC((x) => ({ ...x, chat })); } catch (e) { toastError(e); } finally { setChatBusy(false); }
  };
  const openFile = (name) => native('openAssistantFile', { id, name }).catch(toastError);

  return html`<div class="as-case">
    <div class="as-case-head">
      <${Icon} name=${KIND_ICON[c.kind] || 'file'} />
      <div class="grow" style="min-width:0"><h2 class="clip" title=${c.title}>${c.title}</h2>
        <div class="small muted">${c.sender ? html`From ${c.sender} · ` : null}${relTime(c.createdAt)}${c.customer ? html` · <a class="link" onClick=${() => window.dispatchEvent(new CustomEvent('bd-open-customer', { detail: c.customer.id }))}>${c.customer.name}</a>` : null}${a && a.category ? ` · ${a.category}` : ''}</div></div>
      <${Select} cls="input small" value=${c.priority} onChange=${(v) => upd({ priority: v })} options=${Object.entries(PRI).map(([k, [l]]) => ({ value: k, label: l }))} title="Priority" />
      <${Select} cls="input small" value=${c.status} onChange=${(v) => upd({ status: v })} options=${[{ value: 'open', label: 'Open' }, { value: 'waiting', label: 'Waiting' }, { value: 'done', label: 'Done' }]} title="Status" />
      <button class="btn ghost small" title="Delete case" aria-label="Delete case" onClick=${async () => { if (await confirm({ title: `Delete "${c.title}"?`, ok: 'Delete' })) { await call('assistantDelete', id).catch(toastError); onDeleted(); } }}><${Icon} name="trash" size="14" /></button>
    </div>
    ${thinking ? html`<div class="card pad row" style="gap:10px"><${Spinner} /><span>${c.state === 'reading' ? 'Reading the files…' : 'Working out a plan… local models can take a minute or two.'}</span></div>` : null}
    ${c.state === 'error' ? html`<div class="card pad bad">This could not be read: ${c.error}</div>` : null}
    ${a ? html`
      ${(a.notes || []).map((n, i) => html`<div key=${i} class="small faint">${n}</div>`)}
      <div class="card pad"><div class="row between"><b>Summary</b><span class="row" style="gap:6px">
        ${c.due ? html`<span class="chip">Due ${shortDate(c.due)}</span>` : null}<span class="chip" style=${`color:${PRI[c.priority][1]}`}>${PRI[c.priority][0]}</span></span></div>
        <div class="mt as-text">${a.summary}</div>
        ${a.keyPoints.length ? html`<ul class="as-list mt">${a.keyPoints.map((k, i) => html`<li key=${i}>${k}</li>`)}</ul>` : null}
        ${a.translation ? html`<div class="mt"><a class="link small" onClick=${() => setShowTr(!showTr)}>${showTr ? 'Hide' : 'Show'} English translation (from ${a.language})</a>${showTr ? html`<div class="as-text as-quote mt">${a.translation}</div>` : null}</div>` : null}
        ${a.risks.length ? html`<div class="mt"><div class="small muted">Risks</div><ul class="as-list">${a.risks.map((k, i) => html`<li key=${i} class="bad">${k}</li>`)}</ul></div>` : null}
      </div>

      ${a.questions.length ? html`<div class="card pad as-questions"><b>I need a few things from you</b>
        ${a.questions.map((q, i) => html`<div key=${i} class="mt"><div>${q.question}</div>${q.why ? html`<div class="small muted">${q.why}</div>` : null}
          <input class="input mt1" placeholder=${q.answer ? '' : 'Your answer, a name, an email address…'} value=${answers[i] != null ? answers[i] : q.answer || ''} onInput=${(e) => setAnswers({ ...answers, [i]: e.target.value })} /></div>`)}
        <textarea class="input mt" rows="2" placeholder="Anything else I should know? (optional)" value=${extra} onInput=${(e) => setExtra(e.target.value)}></textarea>
        <div class="row mt"><span class="grow"></span><button class="btn primary" disabled=${!!busy} onClick=${() => run('answer', () => call('assistantAnswer', id, { answers, extra }).then(() => { setAnswers({}); setExtra(''); }))}>
          ${busy === 'answer' ? html`<${Spinner} />` : html`<${Icon} name="refresh" size="14" />`} Update the plan</button></div></div>` : null}

      <div class="card pad"><div class="row between"><b>Action plan</b><span class="small muted">${a.plan.filter((s) => s.done).length} of ${a.plan.length} done</span></div>
        <div class="as-plan">${a.plan.map((s, i) => html`<div key=${i} class=${`as-step ${s.done ? 'done' : ''}`}>
          <input type="checkbox" checked=${s.done} onChange=${(e) => upd({ step: { index: i, done: e.target.checked } })} aria-label="Done" />
          <div class="grow"><div>${s.step}</div><div class="small muted">${OWNER[s.owner] || s.owner}${s.who ? ` · ${s.who}` : ''}${s.due ? ` · due ${shortDate(s.due)}` : ''}${s.itemId ? html` · <a class="link" onClick=${() => window.dispatchEvent(new CustomEvent('bd-open-item', { detail: s.itemId }))}>task on board</a>` : ''}</div></div>
          <button class="btn ghost small" aria-label="Remove step" title="Remove step" onClick=${() => upd({ removeStep: i })}><${Icon} name="x" size="13" /></button></div>`)}</div>
        <form class="row mt" style="gap:6px" onSubmit=${(e) => { e.preventDefault(); const v = e.target.step.value.trim(); if (v) { upd({ addStep: { step: v, owner: 'me' } }); e.target.reset(); } }}>
          <input name="step" class="input grow" placeholder="Add a step" /><button class="btn small" type="submit">Add</button></form>
      </div>

      <div class="card pad"><b>Where this work goes</b>
        <div class="small mt">${pl.boardId ? html`Suggested: <b>${pl.workspace} › ${pl.board} › ${pl.group}</b>` : html`Suggested new board: <b>${pl.board}</b>${pl.workspace ? ` in ${pl.workspace}` : ''}`}${pl.reason ? html`<div class="muted">${pl.reason}</div>` : null}</div>
        <div class="row mt" style="gap:8px;flex-wrap:wrap">
          <${Select} cls="input small" value=${tgtBoard} onChange=${(v) => setTarget({ boardId: v, groupId: '' })} placeholder="Choose a board" options=${boardOpts} title="Board" />
          ${tgtGroups.length ? html`<${Select} cls="input small" value=${tgtGroup} onChange=${(v) => setTarget({ boardId: tgtBoard, groupId: v })} options=${tgtGroups.map((g) => ({ value: g.id, label: g.name }))} title="Group" />` : null}
          <button class="btn primary small" disabled=${!tgtBoard || !!busy || !a.plan.some((s) => !s.itemId)} onClick=${() => run('tasks', async () => { const r = await call('assistantToTasks', id, { boardId: tgtBoard, groupId: tgtGroup }); toast(`${r.created} ${r.created === 1 ? 'task' : 'tasks'} added`, '', { label: 'Open board', run: () => nav('board', r.boardId) }); })}>
            <${Icon} name="plus" size="14" /> Add plan steps as tasks</button>
          ${!pl.boardId ? html`<button class="btn small" disabled=${!!busy} onClick=${() => run('board', async () => { const b = await call('assistantCreateBoard', id, {}); setTarget({ boardId: b, groupId: '' }); call('assistantConfig').then((x) => setStruct(x.structure)); toast('Board created'); })}>Create "${pl.board}"</button>` : null}
        </div>
        ${a.organize && a.organize.advice ? html`<div class="as-organize mt2"><div class="small muted">How to organize this kind of work</div><div class="as-text">${a.organize.advice}</div>
          ${a.organize.boardName ? html`<div class="small mt">Proposed board <b>${a.organize.boardName}</b>${a.organize.groups.length ? html` with swim lanes: ${a.organize.groups.map((g) => html`<span key=${g} class="chip">${g}</span>`)}` : null}${a.organize.columns.length ? html` and columns: ${a.organize.columns.join(', ')}` : null}</div>
            <button class="btn small mt" disabled=${!!busy} onClick=${() => run('board', async () => { const b = await call('assistantCreateBoard', id, { name: a.organize.boardName, groups: a.organize.groups, columns: a.organize.columns }); setTarget({ boardId: b, groupId: '' }); call('assistantConfig').then((x) => setStruct(x.structure)); toast('Board created', '', { label: 'Open board', run: () => nav('board', b) }); })}>
              <${Icon} name="plus" size="14" /> Create this board</button>` : null}</div>` : null}
      </div>

      ${a.replies.length ? html`<div class="card pad"><b>Replies to send</b>
        ${a.replies.map((r, i) => html`<div key=${i} class=${`as-reply ${r.sent ? 'sent' : ''}`}>
          <div class="row" style="gap:8px"><span class="chip">${r.audience === 'internal' ? 'Internal' : 'External'}</span><span class="small muted grow clip">${r.purpose}</span>
            <label class="check small"><input type="checkbox" checked=${r.sent} onChange=${(e) => upd({ reply: { index: i, sent: e.target.checked } })} /> Sent</label></div>
          <div class="as-reply-fields"><label class="small muted">To</label><input class="input small" value=${r.to} onChange=${(e) => upd({ reply: { index: i, to: e.target.value } })} />
            <label class="small muted">Subject</label><input class="input small" value=${r.subject} onChange=${(e) => upd({ reply: { index: i, subject: e.target.value } })} /></div>
          <textarea class="input" rows=${Math.min(14, Math.max(5, r.body.split('\n').length + 1))} value=${r.body} onChange=${(e) => upd({ reply: { index: i, body: e.target.value } })}></textarea>
          <div class="row mt1" style="gap:6px"><span class="grow"></span>
            <button class="btn small" onClick=${() => copy(r.body, 'Reply copied')}><${Icon} name="copy" size="14" /> Copy</button>
            <button class="btn small primary" onClick=${() => mailto(r)}><${Icon} name="mail" size="14" /> Open in email</button></div></div>`)}
      </div>` : null}

      <div class="card pad as-chat"><b>Talk it through</b><div class="small muted">Ask for a different reply, a plan for a meeting, who to involve, or what to do first.</div>
        ${c.chat.map((m, i) => html`<div key=${i} class=${`as-msg ${m.role}`}><div class="as-text">${m.content}</div>${m.role === 'assistant' ? html`<button class="btn ghost small" onClick=${() => copy(m.content)}><${Icon} name="copy" size="13" /></button>` : null}</div>`)}
        ${chatBusy ? html`<div class="as-msg assistant"><${Spinner} /></div>` : null}
        <div class="row mt" style="gap:6px;align-items:flex-end"><textarea class="input grow" rows="2" placeholder="Message the assistant about this case… (Enter to send)" value=${msg} onInput=${(e) => setMsg(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }}></textarea>
          <button class="btn primary" disabled=${chatBusy || !msg.trim()} onClick=${sendChat}>Send</button></div></div>

      <div class="card pad"><div class="row between"><b>Sources</b><span class="row" style="gap:6px">
        <button class="btn small" onClick=${() => setPaste(true)}><${Icon} name="plus" size="14" /> Add more</button>
        <button class="btn small" disabled=${!!busy} onClick=${() => run('re', () => call('assistantAnalyze', id))}><${Icon} name="refresh" size="14" /> Read again</button></span></div>
        <div class="as-files mt">${c.source.files.map((f) => html`<div key=${f.name} class="row small" style="gap:6px"><${Icon} name=${f.email ? 'mail' : 'file'} size="14" />
          ${f.stored && isDesktop ? html`<a class="link clip" onClick=${() => openFile(f.name)}>${f.name}</a>` : html`<span class="clip">${f.name}</span>`}
          ${f.attachments.length ? html`<span class="faint">+ ${f.attachments.map((x) => x.name).join(', ')}</span>` : null}</div>`)}
          ${c.source.pasted ? html`<div class="row small" style="gap:6px"><${Icon} name=${c.kind === 'chat' ? 'msg' : 'text'} size="14" />${c.kind === 'chat' ? 'Pasted chat' : 'Pasted text'} · ${c.source.pasted.length.toLocaleString()} characters</div>` : null}</div>
        ${a.sources.length ? html`<div class="mt"><a class="link small" onClick=${() => setShowSrc(!showSrc)}>${showSrc ? 'Hide' : 'Show'} ${a.sources.length} related records and documents it looked at</a>
          ${showSrc ? html`<div class="as-related mt1">${a.sources.map((s) => html`<button key=${s.n} class="ask-src" onClick=${() => (s.kind === 'file' ? native('openPath', { path: s.path }).catch(toastError) : s.kind === 'customer' ? window.dispatchEvent(new CustomEvent('bd-open-customer', { detail: s.id })) : s.kind === 'meeting' ? window.dispatchEvent(new CustomEvent('bd-open-meeting', { detail: s.id })) : s.kind === 'item' ? window.dispatchEvent(new CustomEvent('bd-open-item', { detail: s.id })) : null)}>
            <span class="n">${s.n}</span><span class="grow" style="min-width:0"><b class="clip">${s.name || s.kind}${s.used ? ' · used' : ''}</b><span class="small muted clip">${s.path || s.snippet}</span></span></button>`)}</div>` : null}</div>` : null}
      </div>
      <div class="small faint">${a.mode === 'local' ? `Read by ${a.model} on this PC` : a.mode === 'claude' ? `Read by Claude (${a.model})` : 'Read by the built-in reader'} · ${relTime(a.analyzedAt)}</div>
    ` : null}
    ${paste ? html`<${PasteBox} caseId=${id} onClose=${() => setPaste(false)} onDone=${() => load()} />` : null}
  </div>`;
}

// ------------------------------------------------------------------- page
export function AssistantPage({ nav, version }) {
  const [list, setList] = useState(null);
  const [today, setToday] = useState(null);
  const [sel, setSel] = usePersist('as.sel', '');
  const [filter, setFilter] = usePersist('as.filter', 'open');
  const [q, setQ] = useState('');
  const [drag, setDrag] = useState(false);
  const [paste, setPaste] = useState(false);
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileIn = useRef(null);
  const teachIn = useRef(null);
  const depth = useRef(0);
  const load = () => {
    call('assistantCases', { status: filter === 'all' ? null : filter, q: q.trim() || null }).then(setList, toastError);
    call('assistantToday').then(setToday, () => {});
  };
  useEffect(load, [filter, q, version]);
  useEffect(() => { const t = setInterval(() => { if (list && list.some((c) => c.state === 'reading' || c.state === 'thinking')) load(); }, 2500); return () => clearInterval(t); }, [list]);

  const intake = async (files) => {
    if (!files.length) { toast('Nothing readable was dropped. Emails, PDF, Word, Excel, text, Markdown and pictures work.'); return; }
    setBusy(true);
    try { const id = await call('assistantIntake', { files }); setSel(id); setFilter('open'); load(); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const teach = async ({ files, folders }) => {
    try {
      if (folders.length) { await call('assistantTeachFolders', folders); toast(`${folders.length === 1 ? 'Folder' : `${folders.length} folders`} added. The assistant is reading ${folders.length === 1 ? 'it' : 'them'} now.`); }
      if (files.length) { const r = await call('assistantTeach', { files }); toast(`Learned from ${r.saved} ${r.saved === 1 ? 'file' : 'files'}.`); }
      if (!files.length && !folders.length) toast('Nothing readable was dropped.');
    } catch (e) { toastError(e); }
  };
  const onDrop = async (e, zone) => {
    e.preventDefault(); e.stopPropagation(); depth.current = 0; setDrag(false);
    const got = await collect(e.dataTransfer);
    if (zone === 'teach') teach(got);
    else if (got.folders.length && !got.files.length) teach(got);
    else intake(got.files.slice(0, 20));
  };
  const counts = list ? list.length : 0;
  return html`<div class="page as-page" onDragEnter=${(e) => { if ([...(e.dataTransfer.types || [])].includes('Files')) { depth.current += 1; setDrag(true); } }}
      onDragLeave=${() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDrag(false); }} onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => onDrop(e, 'case')}>
    <div class="page-head"><h1>Assistant</h1><span class="muted small">Drop emails and documents, or paste a Teams chat. Get a plan, draft replies and tasks.</span><span class="grow"></span>
      <button class="btn" onClick=${() => setPaste(true)}><${Icon} name="text" size="15" /> Paste</button>
      <button class="btn" onClick=${() => fileIn.current.click()}><${Icon} name="plus" size="15" /> Add files</button>
      <button class="btn ghost" title="Assistant settings" aria-label="Assistant settings" onClick=${() => setSettings(true)}><${Icon} name="gear" size="16" /></button>
      <input ref=${fileIn} type="file" multiple hidden onChange=${async (e) => { const g = await collect({ files: e.target.files }); e.target.value = ''; intake(g.files); }} />
      <input ref=${teachIn} type="file" multiple hidden onChange=${async (e) => { const g = await collect({ files: e.target.files }); e.target.value = ''; teach(g); }} /></div>
    <${Today} data=${today} open=${(id) => { setSel(id); }} />
    <div class="as-drops">
      <div class="as-drop" role="button" tabindex="0" onClick=${() => fileIn.current.click()} onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => onDrop(e, 'case')}>
        ${busy ? html`<${Spinner} />` : html`<${Icon} name="mail" size="22" />`}<div><b>Drop an email or file to get a plan</b><div class="small muted">Outlook emails, PDF, Word, Excel, pictures, text. Each one becomes a case.</div></div></div>
      <div class="as-drop teach" role="button" tabindex="0" onClick=${() => teachIn.current.click()} onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => onDrop(e, 'teach')}>
        <${Icon} name="spark" size="22" /><div><b>Teach the assistant</b><div class="small muted">Drop OneNote .md exports, documents or whole folders. It uses them in every answer.</div></div></div>
    </div>
    <div class="as-layout">
      <div class="as-list-col">
        <div class="row" style="gap:6px"><div class="seg">${[['open', 'Open'], ['waiting', 'Waiting'], ['done', 'Done'], ['all', 'All']].map(([k, l]) => html`<button key=${k} class=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${l}</button>`)}</div>
          <input class="input small grow" placeholder="Search cases" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
        <div class="as-cases">${!list ? html`<${Spinner} />` : !counts ? html`<div class="small muted pad">No ${filter === 'all' ? '' : filter} cases. Drop an email or a document above, or paste a Teams chat.</div>`
          : list.map((c) => html`<button key=${c.id} class=${`as-case-row ${sel === c.id ? 'on' : ''}`} onClick=${() => setSel(c.id)}>
            <span class="as-pri" style=${`background:${PRI[c.priority][1]}`} title=${PRI[c.priority][0]}></span>
            <span class="grow" style="min-width:0"><b class="clip">${c.title}</b><span class="small muted clip">${c.state === 'reading' || c.state === 'thinking' ? 'Working on it…' : c.state === 'error' ? 'Could not be read' : c.summary || c.sender}</span>
              <span class="small faint">${relTime(c.createdAt)}${c.openSteps ? ` · ${c.openSteps} open ${c.openSteps === 1 ? 'step' : 'steps'}` : ''}${c.questions ? ` · ${c.questions} ${c.questions === 1 ? 'question' : 'questions'}` : ''}${c.due ? ` · due ${shortDate(c.due)}` : ''}</span></span>
            ${c.state === 'reading' || c.state === 'thinking' ? html`<${Spinner} />` : html`<${Icon} name=${KIND_ICON[c.kind] || 'file'} size="15" />`}</button>`)}</div>
      </div>
      <div class="as-detail">${sel && list && (list.some((c) => c.id === sel) || filter === 'all' || true) ? html`<${CaseView} key=${sel} id=${sel} nav=${nav} onChanged=${load} onDeleted=${() => { setSel(''); load(); }} />`
        : html`<div class="card pad muted as-empty-detail"><${Icon} name="spark" size="26" /><h3>Your daily assistant</h3>
          <div>Drop an email from Outlook (or save it as .msg first), a PDF, a Word or Excel file, or paste a Teams chat. You get a summary, an English translation when needed, an action plan, draft replies for customers, partners and colleagues, questions when something is missing, and where the tasks belong on your boards.</div></div>`}</div>
    </div>
    ${drag ? html`<div class="as-overlay"><div class="as-overlay-zone" onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => onDrop(e, 'case')}><${Icon} name="mail" size="34" />Make a case<span>Plan and replies</span></div>
      <div class="as-overlay-zone teach" onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => onDrop(e, 'teach')}><${Icon} name="spark" size="34" />Teach the assistant<span>Notes, documents, folders</span></div></div>` : null}
    ${paste ? html`<${PasteBox} onClose=${() => setPaste(false)} onDone=${(id) => { setSel(id); setFilter('open'); load(); }} />` : null}
    ${settings ? html`<${AssistantSettings} onClose=${() => setSettings(false)} />` : null}
  </div>`;
}
