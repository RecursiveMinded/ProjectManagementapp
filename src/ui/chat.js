// Chat: the home screen. Drop any file (emails, PDF, Word, Excel, pictures,
// Markdown), paste an email or a Teams chat, type a note, or ask a question.
// Each file gets its own answer with what was found and the tasks in it.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Spinner, toast, toastError, relTime, shortDate, ask as confirm } from './lib.js';
import { call, native, isDesktop } from './api.js';
import { answerHtml, openSource, KIND } from './ask.js';
import { collect, AssistantSettings } from './assistant.js';
import { TaskRow, takePendingAsk } from './tasks.js';

const PRI = { urgent: ['Urgent', 'var(--bad)'], high: ['High', '#d38a00'], normal: ['', ''], low: ['', ''] };
const SUGGEST = ['What should I do today?', 'Who am I waiting on?', 'What happened with my customers this week?', 'Summarise my last calls'];
const busyState = (c) => c.state === 'reading' || c.state === 'thinking';
const openCase = (id) => window.dispatchEvent(new CustomEvent('bd-open-case', { detail: id }));

function CaseCard({ c }) {
  if (c.gone) return html`<div class="ch-case gone small muted">This item was deleted.</div>`;
  const working = busyState(c);
  const chips = [];
  if (!working && c.state !== 'error') {
    if (c.needsAction === false) chips.push(html`<span class="chip">No action needed</span>`);
    if (c.suggested) chips.push(html`<span class="chip ch-ask" role="button" onClick=${(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('bd-action-tab', { detail: 'suggested' })); }}>${c.suggested} suggested ${c.suggested === 1 ? 'action' : 'actions'}</span>`);
    if (c.mine) chips.push(html`<span class="chip ch-good">${c.mine} ${c.mine === 1 ? 'task' : 'tasks'} for you</span>`);
    if (c.waiting) chips.push(html`<span class="chip">${c.waiting} waiting on others</span>`);
    if (c.replies) chips.push(html`<span class="chip">${c.replies} ${c.replies === 1 ? 'reply' : 'replies'} drafted</span>`);
    if (c.questions) chips.push(html`<span class="chip ch-ask">${c.questions} ${c.questions === 1 ? 'question' : 'questions'} for you</span>`);
    if (c.due) chips.push(html`<span class="chip">Due ${shortDate(c.due)}</span>`);
    if (PRI[c.priority] && PRI[c.priority][0]) chips.push(html`<span class="chip" style=${`color:${PRI[c.priority][1]}`}>${PRI[c.priority][0]}</span>`);
  }
  // Open steps are real tasks: tick, date and prioritise them right here.
  const steps = [];
  return html`<div class="ch-case-wrap"><button class="ch-case" onClick=${() => openCase(c.id)} title="Open the summary, plan and replies">
    <span class="ch-case-ico">${working ? html`<${Spinner} />` : html`<${Icon} name=${c.kind === 'email' ? 'mail' : c.kind === 'chat' ? 'msg' : c.kind === 'text' ? 'text' : 'file'} size="16" />`}</span>
    <span class="grow" style="min-width:0">
      <b class="clip" style="display:block">${c.title}</b>
      <span class="small muted ch-sum">${working ? (c.state === 'reading' ? 'Reading…' : 'Working out the tasks… a local model can take a minute.') : c.state === 'error' ? `Could not be read: ${c.error}` : `${c.sender && !String(c.summary || '').includes(c.sender.replace(/\s*<[^>]*>/, '').replace(/^"|"$/g, '')) ? `From ${c.sender.replace(/\s*<[^>]*>/, '').replace(/^"|"$/g, '')}. ` : ''}${c.summary || ''}`}</span>
      ${chips.length ? html`<span class="ch-chips">${chips}</span>` : null}
    </span>
    <${Icon} name="arrowRight" size="14" /></button>
    ${steps.length ? html`<div class="ch-steps">${steps.slice(0, 8).map((t) => html`<${TaskRow} key=${t.key} t=${t} compact inCase />`)}
      ${steps.length > 8 ? html`<a class="link small" onClick=${() => openCase(c.id)}>${steps.length - 8} more</a>` : null}</div>` : null}
  </div>`;
}

function Bubble({ m, nav }) {
  if (m.role === 'user') {
    return html`<div class="ask-msg user"><div class="bubble">${m.content}${(m.files || []).length ? html`<div class="ch-files">${m.files.map((f) => html`<span key=${f} class="ch-file"><${Icon} name="paperclip" size="12" />${f}</span>`)}</div>` : null}</div></div>`;
  }
  const onCite = (e) => {
    const a = e.target.closest('.cite');
    if (!a) return;
    const s = (m.sources || []).find((x) => String(x.n) === a.getAttribute('data-n'));
    if (s) openSource(s);
  };
  let body;
  if (m.kind === 'cases') {
    const cs = m.cases || [];
    const head = /^Reading /.test(m.content || '') && cs.length && !cs.some(busyState) ? (cs.length === 1 ? 'Read it. Here is what it says and what to do next.' : `Read all ${cs.length}. Each has its summary and next steps.`) : m.content;
    body = html`<div>${head}</div><div class="ch-cases">${(m.cases || []).map((c) => html`<${CaseCard} key=${c.id} c=${c} />`)}</div>`;
  } else if (m.kind === 'tasks') {
    body = html`<div>${m.content}</div><div class="ch-steps ch-tasks">${(m.tasks || []).length ? m.tasks.map((t) => html`<${TaskRow} key=${t.key} t=${t} compact />`) : html`<div class="small muted">These tasks are no longer on your list.</div>`}</div>`;
  } else if (m.kind === 'review') {
    body = html`<div>${m.content}</div>${(m.items || []).length ? html`<div class="ai-list mt1">${m.items.map((x) => html`<${ActionRow} key=${x.key} x=${x} tab=${x.review} />`)}</div>` : null}`;
  } else if (m.kind === 'briefing' && m.briefing) {
    const b = m.briefing;
    const hour = new Date(m.at).getHours();
    body = html`<div><b>${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}.</b> ${b.headline}${/[.!]$/.test(b.headline) ? '' : '.'}</div>
      ${b.top.length ? html`<div class="ch-bhead">Do first</div><div class="ch-steps">${b.top.map((t) => html`<${TaskRow} key=${t.key} t=${t} />`)}</div>` : null}
      ${(b.meetings || []).length ? html`<div class="ch-bhead">Meetings today</div>${b.meetings.map((x) => html`<button key=${x.id} class="td-line" onClick=${() => window.dispatchEvent(new CustomEvent('bd-open-meeting', { detail: x.id }))}><span class="td-time">${x.time || 'Today'}</span><span class="grow clip">${x.title}${x.customer ? html` <span class="muted">· ${x.customer}</span>` : null}</span></button>`)}` : null}
      ${b.waiting.length ? html`<div class="ch-bhead">Waiting on others</div><div class="ch-steps">${b.waiting.map((t) => html`<${TaskRow} key=${t.key} t=${t} compact />`)}</div>` : null}
      ${(b.questions || []).length ? html`<div class="td-q small"><${Icon} name="help" size="14" /> Questions for you on ${b.questions.map((q, i) => html`${i ? ', ' : ''}<a key=${q.id} class="link" onClick=${() => openCase(q.id)}>${q.title}</a>`)}. Answering them sharpens the plan.</div>` : null}
      <div class="row mt1" style="gap:6px"><button class="btn small" onClick=${() => nav('today')}><${Icon} name="today" size="14" /> Open Today</button><button class="btn small" onClick=${() => nav('tasks')}><${Icon} name="check" size="14" /> All tasks</button></div>`;
  } else if (m.kind === 'briefing') {
    body = html`<div class="ask-answer" dangerouslySetInnerHTML=${{ __html: answerHtml(m.content) }}></div>
      <div class="row mt1" style="gap:6px"><button class="btn small" onClick=${() => nav('today')}><${Icon} name="today" size="14" /> Open Today</button><button class="btn small" onClick=${() => nav('tasks')}><${Icon} name="check" size="14" /> All tasks</button></div>`;
  } else if (m.error) {
    body = html`<div class="bad">${m.error}</div>`;
  } else {
    body = html`${m.content ? html`<div class="ask-answer" onClick=${onCite} dangerouslySetInnerHTML=${{ __html: answerHtml(m.content) }}></div>`
      : html`<div class="muted small">${(m.sources || []).length ? 'Here is what I found:' : 'I found nothing about that in your files, boards, customers or calls.'}</div>`}
      ${(m.notes || []).map((n, j) => html`<div key=${j} class="small faint mt2">${n}</div>`)}
      ${(m.sources || []).filter((s) => s.kind !== 'note').length ? html`<div class="ask-sources open">
        ${m.sources.filter((s) => s.kind !== 'note').map((s) => html`<button key=${s.n} class="ask-src" title=${s.path || s.name} onClick=${() => openSource(s)}>
          <span class="n">${s.n}</span><${Icon} name=${(KIND[s.kind] || KIND.note)[0]} size="14" /><span class="grow" style="min-width:0"><b class="clip">${s.name || (KIND[s.kind] || KIND.note)[1]}</b>
          <span class="small muted clip">${s.kind === 'file' ? s.path : s.board ? `${s.board} · ${s.snippet}` : s.snippet}</span></span>
          ${s.kind === 'file' && isDesktop ? html`<span class="btn ghost small" role="button" onClick=${(e) => { e.stopPropagation(); native('showPath', { path: s.path }).catch(toastError); }}>Show</span>` : null}</button>`)}</div>` : null}`;
  }
  return html`<div class="ask-msg bot"><div class=${`bubble ${m.kind === 'briefing' ? 'ch-brief' : ''}`}>${body}
    <div class="small faint mt1">${m.kind === 'briefing' ? 'Briefing · ' : m.mode === 'local' ? `Answered by ${m.model} on this PC · ` : m.mode === 'claude' ? `Answered by Claude · ` : m.mode === 'chatgpt' ? `Answered by ChatGPT · ` : ''}${relTime(m.at)}</div></div></div>`;
}

const changed = () => window.dispatchEvent(new CustomEvent('bd-actions-changed'));

/** One action item with its decision buttons. */
function ActionRow({ x, tab }) {
  const [state, setState] = useState(tab);
  const decide = async (d) => { try { await call('actionItemReview', x.caseId, x.index, d); setState(d); changed(); if (d === 'rejected') toast('Removed. It will learn from this.'); } catch (e) { toastError(e); } };
  return html`<div class=${`ai-row ${state}`}>
    <div class="grow" style="min-width:0">
      <div class="ai-step">${x.step}</div>
      <div class="small muted ai-meta">
        ${x.due ? html`<span class="chip">${shortDate(x.due)}</span>` : null}
        ${x.who && x.owner !== 'me' ? html`<span>${x.who}</span>` : null}
        <a class="link clip" onClick=${() => openCase(x.caseId)} title="Open where it came from">${x.sender ? `${x.sender}: ` : ''}${x.caseTitle}</a>
      </div>
      ${x.why ? html`<div class="small faint ai-why">${x.why}</div>` : null}
      ${x.autoRejected && state === 'rejected' ? html`<div class="small faint ai-why">Skipped because you rejected something like it before.</div>` : null}
    </div>
    <div class="ai-btns">
      ${state === 'suggested' ? html`<button class="btn small primary" title="Add to my tasks" onClick=${() => decide('approved')}><${Icon} name="check" size="14" /> Approve</button>
        <button class="btn small ghost" title="Not an action item" aria-label="Not an action item" onClick=${() => decide('rejected')}><${Icon} name="x" size="14" /></button>`
      : state === 'approved' ? html`<span class="small ai-ok">On your list</span><button class="btn small ghost" title="Not an action item after all" aria-label="Not an action item" onClick=${() => decide('rejected')}><${Icon} name="x" size="14" /></button>`
      : html`<span class="small muted">Not an action item</span><button class="btn small ghost" onClick=${() => decide('suggested')}>Restore</button>`}
    </div>
  </div>`;
}

/** Suggested, approved and rejected action items from everything dropped into the chat. */
function ActionPanel({ refresh }) {
  const [tab, setTab] = useState('suggested');
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const load = () => call('actionItems').then(setData, toastError);
  useEffect(() => { load(); }, [refresh]);
  useEffect(() => {
    const h = () => load();
    const t = (e) => setTab(e.detail || 'suggested');
    window.addEventListener('bd-actions-changed', h);
    window.addEventListener('bd-action-tab', t);
    return () => { window.removeEventListener('bd-actions-changed', h); window.removeEventListener('bd-action-tab', t); };
  }, []);
  const all = async (d) => { try { const n = await call('actionItemsReviewAll', d); toast(d === 'approved' ? `${n} added to your tasks` : `${n} removed`); load(); } catch (e) { toastError(e); } };
  const list = data ? data[tab].filter((x) => !q || `${x.step} ${x.caseTitle} ${x.sender}`.toLowerCase().includes(q.toLowerCase())) : [];
  const TABS = [['suggested', 'Suggested'], ['approved', 'Approved'], ['rejected', 'Rejected']];
  return html`<aside class="ai-panel" aria-label="Action items">
    <div class="ai-head"><b>Action items</b><span class="grow"></span>
      ${tab === 'suggested' && data && data.counts.suggested ? html`<button class="btn small" onClick=${() => all('approved')}>Approve all</button>` : null}</div>
    <div class="seg ai-tabs">${TABS.map(([k, l]) => html`<button key=${k} class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}${data ? ` ${data.counts[k]}` : ''}</button>`)}</div>
    ${data && data[tab].length > 6 ? html`<input class="input ai-filter" placeholder="Filter…" value=${q} onInput=${(e) => setQ(e.target.value)} />` : null}
    <div class="ai-list">
      ${!data ? html`<${Spinner} />` : list.length ? list.map((x) => html`<${ActionRow} key=${`${tab}:${x.key}`} x=${x} tab=${tab} />`)
        : html`<div class="small muted ai-empty">${tab === 'suggested' ? 'Nothing waiting. When you drop an email or file, the action items it suggests show here for you to approve or reject.' : tab === 'approved' ? 'Approved action items are on your task list.' : 'Nothing rejected. Say "not an action item" in the chat, or press ✕, and the assistant learns from it.'}</div>`}
    </div>
    <div class="small faint ai-foot">Approve adds it to your tasks. ✕ means it is not an action item, and the assistant stops suggesting things like it.</div>
  </aside>`;
}

export function ChatPage({ nav, version }) {
  const [msgs, setMsgs] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [settings, setSettings] = useState(false);
  const end = useRef(null);
  const input = useRef(null);
  const fileIn = useRef(null);
  const depth = useRef(0);
  const load = () => call('chatHistory').then(setMsgs, toastError);
  const actionsKey = msgs ? msgs.map((m) => `${m.id}:${(m.cases || []).map((c) => c.state + (c.suggested || 0)).join(',')}`).join('|') : '';
  const sendRef = useRef(null);
  // "Ask what is needed" on a task, from any page: ask it here.
  useEffect(() => {
    const h = () => { const q = takePendingAsk(); if (q && sendRef.current) sendRef.current({ words: q }); };
    const t = setTimeout(h, 300);
    window.addEventListener('bd-ask-chat', h);
    return () => { clearTimeout(t); window.removeEventListener('bd-ask-chat', h); };
  }, []);
  useEffect(() => { call('chatBriefingIfDue').catch(() => {}).finally(load); }, [version]);
  useEffect(() => { if (end.current) end.current.scrollIntoView({ block: 'end' }); }, [msgs && msgs.length, busy]);
  // Refresh messages whose files are still being read.
  useEffect(() => {
    if (!msgs || !msgs.some((m) => (m.cases || []).some(busyState))) return undefined;
    const t = setTimeout(async () => {
      try {
        const fresh = await Promise.all(msgs.map((m) => ((m.cases || []).some(busyState) ? call('chatMessage', m.id) : m)));
        setMsgs(fresh.filter(Boolean));
      } catch (_) { /* try again next time */ }
    }, 2000);
    return () => clearTimeout(t);
  }, [msgs]);

  const send = async ({ files = [], words = text } = {}) => {
    const t = String(words || '').trim();
    if ((!t && !files.length) || busy) return;
    setBusy(true);
    const pending = { id: `p${Date.now()}`, role: 'user', kind: 'text', content: t, files: files.map((f) => f.name), at: new Date().toISOString() };
    setMsgs((m) => [...(m || []), pending]);
    if (words === text) setText('');
    try {
      const [u, r] = await call('chatSend', { text: t, files });
      setMsgs((m) => [...(m || []).filter((x) => x.id !== pending.id), u, r]);
    } catch (e) { toastError(e); setMsgs((m) => (m || []).filter((x) => x.id !== pending.id)); if (words === text) setText(t); } finally { setBusy(false); setTimeout(() => input.current && input.current.focus(), 30); }
  };
  sendRef.current = send;
  const onDrop = async (e) => {
    e.preventDefault(); e.stopPropagation(); depth.current = 0; setDrag(false);
    const got = await collect(e.dataTransfer);
    if (got.folders.length) {
      try { await call('assistantTeachFolders', got.folders); toast(`${got.folders.length === 1 ? 'Folder' : `${got.folders.length} folders`} added to what the assistant knows. It is reading ${got.folders.length === 1 ? 'it' : 'them'} now.`); } catch (err) { toastError(err); }
    }
    if (got.files.length) send({ files: got.files.slice(0, 40), words: text });
    else if (!got.folders.length) toast('Nothing readable was dropped. Emails, PDF, Word, Excel, text, Markdown and pictures work.');
  };
  const clear = async () => { if (await confirm({ title: 'Clear the chat history?', body: 'The files you dropped and their tasks are kept.', ok: 'Clear', danger: false })) { await call('chatClear').catch(toastError); load(); } };

  return html`<div class="page ask-page ch-page" onDragEnter=${(e) => { if ([...(e.dataTransfer.types || [])].includes('Files')) { depth.current += 1; setDrag(true); } }}
      onDragLeave=${() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDrag(false); }} onDragOver=${(e) => e.preventDefault()} onDrop=${onDrop}>
    <div class="page-head"><h1>Chat</h1><span class="muted small">Drop files, paste an email or Teams chat, write a note, ask anything, or say what you finished.</span><span class="grow"></span>
      <button class="btn" onClick=${() => send({ words: 'What should I do today?' })} disabled=${busy}><${Icon} name="today" size="15" /> Briefing</button>
      ${msgs && msgs.length ? html`<button class="btn ghost" title="Clear chat" aria-label="Clear chat" onClick=${clear}><${Icon} name="trash" size="15" /></button>` : null}
      <button class="btn ghost" title="Assistant settings: about you, reply tone, watched folder, what it knows" aria-label="Assistant settings" onClick=${() => setSettings(true)}><${Icon} name="gear" size="16" /></button></div>
    <div class="ch-split"><div class="ch-main">
    <div class="ask-thread">
      ${!msgs ? html`<${Spinner} />` : !msgs.length ? html`<div class="ask-empty"><${Icon} name="spark" size="30" /><h3>Drop anything here</h3>
        <div class="muted small">Outlook emails (.msg, .eml) and Outlook data files (.pst), OneNote sections, notebooks and pages (.one, .onepkg, .mht), PDF, Word, Excel, Markdown, pictures and scans, or a pasted Teams chat. I read each one on this PC, pull out who, what and when, and put the tasks on your list. Ask me anything about it later.</div>
        <div class="ask-suggest">${SUGGEST.map((s) => html`<button key=${s} class="chip" onClick=${() => send({ words: s })}>${s}</button>`)}</div></div>`
        : msgs.map((m) => html`<${Bubble} key=${m.id} m=${m} nav=${nav} />`)}
      ${busy ? html`<div class="ask-msg bot"><div class="bubble"><${Spinner} /> <span class="muted small">Working on it…</span></div></div>` : null}
      <div ref=${end}></div>
    </div>
    <div class="ask-input ch-input">
      <button class="btn ghost icon" title="Add files" aria-label="Add files" onClick=${() => fileIn.current.click()}><${Icon} name="paperclip" /></button>
      <input ref=${fileIn} type="file" multiple hidden onChange=${async (e) => { const g = await collect({ files: e.target.files }); e.target.value = ''; if (g.files.length) send({ files: g.files, words: text }); }} />
      <textarea ref=${input} class="input" rows="2" autoFocus placeholder="Drop files here, paste an email, write a note, or ask a question… (Enter to send, Shift+Enter for a new line)" value=${text} onInput=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} aria-label="Message"></textarea>
      <button class="btn primary" disabled=${busy || !text.trim()} onClick=${() => send()}><${Icon} name="arrowRight" /> Send</button>
    </div></div>
    <${ActionPanel} refresh=${actionsKey} /></div>
    ${drag ? html`<div class="as-overlay ch-overlay"><div class="as-overlay-zone" onDragOver=${(e) => e.preventDefault()} onDrop=${onDrop}><${Icon} name="upload" size="34" />Drop to read<span>Each file gets a summary and its tasks</span></div></div>` : null}
    ${settings ? html`<${AssistantSettings} onClose=${() => setSettings(false)} />` : null}
  </div>`;
}
