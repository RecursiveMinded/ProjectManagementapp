// Ask: a chat that answers from your boards, customers, calls and the
// documents in folders you choose on this PC, using the local model.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Spinner, toastError, toast, relTime, ask as confirm } from './lib.js';
import { call, native, isDesktop } from './api.js';

const KIND = { file: ['file', 'File'], item: ['table', 'Item'], customer: ['building', 'Customer'], meeting: ['phone', 'Call'], note: ['list', 'Overview'] };
const SUGGEST = ['What is overdue this week?', 'Who is the main contact at Northwind Traders and what devices do they have?', 'Summarise my last calls with customers', 'Find the contract that mentions payment terms'];
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Light Markdown for answers: paragraphs, lists, bold, code and [n] citations. */
function answerHtml(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[(\d{1,2})\]/g, '<a class="cite" data-n="$1">$1</a>');
  for (const l of lines) {
    const t = l.trim();
    let m;
    if (!t) { close(); continue; }
    if ((m = t.match(/^#{1,4}\s+(.+)/))) { close(); out.push(`<h4>${inline(m[1])}</h4>`); continue; }
    if ((m = t.match(/^[-*•]\s+(.+)/)) || (m = t.match(/^\d+[.)]\s+(.+)/))) {
      const k = /^\d/.test(t) ? 'ol' : 'ul';
      if (list !== k) { close(); out.push(`<${k}>`); list = k; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    close();
    out.push(`<p>${inline(t)}</p>`);
  }
  close();
  return out.join('');
}

function openSource(s) {
  if (s.kind === 'file') native('openPath', { path: s.path }).catch(toastError);
  else if (s.kind === 'item') window.dispatchEvent(new CustomEvent('bd-open-item', { detail: s.id }));
  else if (s.kind === 'customer') window.dispatchEvent(new CustomEvent('bd-open-customer', { detail: s.id }));
  else if (s.kind === 'meeting') window.dispatchEvent(new CustomEvent('bd-open-meeting', { detail: s.id }));
}

function loadChat() { try { return JSON.parse(localStorage.getItem('bd.askChat') || '[]'); } catch (_) { return []; } }
function saveChat(list) { try { localStorage.setItem('bd.askChat', JSON.stringify(list.slice(-40))); } catch (_) { /* private mode */ } }

export function AskPage({ boot }) {
  const [msgs, setMsgs] = useState(loadChat);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [st, setSt] = useState(null);
  const [showSetup, setShowSetup] = useState(false);
  const end = useRef(null);
  const input = useRef(null);
  useEffect(() => { call('askStatus').then((s) => { setSt(s); if (!s.folders.length && !loadChat().length) setShowSetup(true); }, () => {}); }, []);
  useEffect(() => { if (end.current) end.current.scrollIntoView({ block: 'end' }); saveChat(msgs); }, [msgs, busy]);
  const send = async (text = q) => {
    const question = text.trim();
    if (!question || busy) return;
    const history = msgs.filter((m) => m.content).map((m) => ({ role: m.role, content: m.content }));
    const next = [...msgs, { role: 'user', content: question, at: Date.now() }];
    setMsgs(next); setQ(''); setBusy(true);
    try {
      const r = await call('ask', { question, history });
      setMsgs([...next, { role: 'assistant', content: r.answer || '', mode: r.mode, model: r.model, sources: r.sources, notes: r.notes, at: Date.now() }]);
    } catch (e) {
      setMsgs([...next, { role: 'assistant', content: '', error: e.message || String(e), at: Date.now() }]);
    } finally { setBusy(false); setTimeout(() => input.current && input.current.focus(), 30); }
  };
  const clear = async () => { if (await confirm({ title: 'Clear this conversation?', ok: 'Clear', danger: false })) setMsgs([]); };
  const onCite = (e, m) => {
    const a = e.target.closest('.cite');
    if (!a) return;
    const s = (m.sources || []).find((x) => String(x.n) === a.getAttribute('data-n'));
    if (s) openSource(s);
  };
  const ai = boot.ai || {};
  return html`<div class="page ask-page">
    <div class="page-head"><h1>Ask</h1><span class="muted small">Answers from your boards, customers, calls${st && st.folders.length ? ` and ${st.files} ${st.files === 1 ? 'file' : 'files'} in ${st.folders.length} ${st.folders.length === 1 ? 'folder' : 'folders'}` : ''}</span><span class="grow"></span>
      ${msgs.length ? html`<button class="btn ghost" onClick=${clear}><${Icon} name="trash" size="15" /> Clear chat</button>` : null}
      <button class=${`btn ${showSetup ? 'active' : ''}`} onClick=${() => setShowSetup(!showSetup)}><${Icon} name="folder" /> Folders to search</button></div>
    ${showSetup ? html`<${AskSources} onChange=${setSt} />` : null}
    <div class="ask-thread">
      ${!msgs.length ? html`<div class="ask-empty"><${Icon} name="spark" size="28" /><h3>Ask about your business</h3>
        <div class="muted small">Questions are answered from your boards, customers, contacts, devices, calls and the documents in folders you choose. Everything is read on this PC${ai.provider === 'anthropic' ? '' : ' with the local model'}.</div>
        <div class="ask-suggest">${SUGGEST.map((s) => html`<button key=${s} class="chip" onClick=${() => send(s)}>${s}</button>`)}</div></div>` : null}
      ${msgs.map((m, i) => (m.role === 'user' ? html`<div class="ask-msg user" key=${i}><div class="bubble">${m.content}</div></div>`
        : html`<div class="ask-msg bot" key=${i}>
          ${m.error ? html`<div class="bubble err">${m.error}</div>` : html`<div class="bubble">
            ${m.content ? html`<div class="ask-answer" onClick=${(e) => onCite(e, m)} dangerouslySetInnerHTML=${{ __html: answerHtml(m.content) }}></div>` : html`<div class="muted small">${(m.sources || []).length ? 'Here is what was found:' : 'Nothing matching was found in your boards, customers or folders.'}</div>`}
            ${(m.notes || []).map((n, j) => html`<div key=${j} class="small faint mt2">${n}</div>`)}
            ${(m.sources || []).length ? html`<div class=${`ask-sources ${m.content ? '' : 'open'}`}>${m.content ? html`<div class="small muted">Sources</div>` : null}
              ${m.sources.filter((s) => s.kind !== 'note').map((s) => html`<button key=${s.n} class="ask-src" title=${s.path || s.name} onClick=${() => openSource(s)}>
                <span class="n">${s.n}</span><${Icon} name=${(KIND[s.kind] || KIND.note)[0]} size="14" /><span class="grow" style="min-width:0"><b class="clip">${s.name || (KIND[s.kind] || KIND.note)[1]}</b>
                <span class="small muted clip">${s.kind === 'file' ? s.path : s.board ? `${s.board} · ${s.snippet}` : s.snippet}</span>${!m.content && s.kind === 'file' ? html`<span class="small ask-snip">${s.snippet}</span>` : null}</span>
                ${s.kind === 'file' && isDesktop ? html`<span class="btn ghost small" role="button" onClick=${(e) => { e.stopPropagation(); native('showPath', { path: s.path }).catch(toastError); }}>Show</span>` : null}</button>`)}</div>` : null}
            <div class="small faint mt2">${m.mode === 'local' ? `Answered by ${m.model} on this PC` : m.mode === 'claude' ? `Answered by Claude (${m.model})` : 'Search results only'} · ${relTime(new Date(m.at).toISOString())}</div></div>`}
        </div>`))}
      ${busy ? html`<div class="ask-msg bot"><div class="bubble"><${Spinner} /> <span class="muted small">Searching and thinking… local models can take up to a minute.</span></div></div>` : null}
      <div ref=${end}></div>
    </div>
    <div class="ask-input">
      <textarea ref=${input} class="input" rows="2" autoFocus placeholder="Ask anything about your customers, work, calls or documents…" value=${q} onInput=${(e) => setQ(e.target.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}></textarea>
      <button class="btn primary" disabled=${busy || !q.trim()} onClick=${() => send()}><${Icon} name="arrowRight" /> Ask</button>
    </div>
  </div>`;
}

/** Folders on this PC that Ask can search, with indexing status. Used on the Ask page and in Settings › AI. */
export function AskSources({ onChange }) {
  const [st, setSt] = useState(null);
  const timer = useRef(null);
  const load = () => call('askStatus').then((s) => { setSt(s); onChange && onChange(s); clearTimeout(timer.current); if (s.job && s.job.running) timer.current = setTimeout(load, 1000); }, toastError);
  useEffect(() => { load(); return () => clearTimeout(timer.current); }, []);
  if (!st) return html`<div class="card pad"><${Spinner} /></div>`;
  const add = async () => {
    try {
      const p = await native('chooseFolder');
      if (!p) return;
      await call('askAddFolder', p);
      await call('askIndex');
      toast('Folder added. Reading its documents…');
      load();
    } catch (e) { toastError(e); }
  };
  const job = st.job;
  return html`<div class="card pad ask-setup">
    <div class="row between"><div><b>Folders Ask can search</b><div class="small muted">Word, PDF, Excel, CSV, text, Markdown, HTML and email files in these folders are read and indexed on this PC. Nothing is uploaded${st.allowCloud ? ' (except passages sent to Claude, which you allowed)' : ''}.</div></div>
      ${isDesktop ? html`<button class="btn primary" onClick=${add}><${Icon} name="plus" /> Add folder</button>` : html`<span class="small muted">Adding folders needs the desktop app.</span>`}</div>
    ${st.folders.length ? html`<table class="plain mt2"><tbody>${st.folders.map((f) => html`<tr key=${f.path}><td><${Icon} name="folder" size="14" /> <span class="mono">${f.path}</span>${f.missing ? html` <span class="chip" style="color:var(--bad)">not found</span>` : null}</td>
      <td class="small muted">${f.files} ${f.files === 1 ? 'file' : 'files'}</td>
      <td style="text-align:right"><button class="btn ghost small" onClick=${() => call('askRemoveFolder', f.path).then(load, toastError)}>Remove</button></td></tr>`)}</tbody></table>`
      : html`<div class="small muted mt2">No folders yet. Add the folders where you keep contracts, quotes, proposals, notes and customer documents, for example Documents or a shared drive.</div>`}
    <div class="row mt2" style="gap:10px;flex-wrap:wrap">
      ${job && job.running ? html`<span class="row small" style="gap:8px"><${Spinner} /> ${job.phase}${job.total ? ` · ${job.done} of ${job.total}` : ''}${job.current ? html` · <span class="clip" style="max-width:260px">${job.current}</span>` : null}</span>`
        : html`<span class="small muted">${st.files} ${st.files === 1 ? 'file' : 'files'} indexed${st.embedded ? ` · smart search on (${st.embedModel})` : ''}${st.errors ? ` · ${st.errors} could not be read` : ''}${st.lastIndexed ? ` · updated ${relTime(st.lastIndexed)}` : ''}</span>`}
      <span class="grow"></span>
      ${st.folders.length ? html`<button class="btn small" disabled=${job && job.running} onClick=${() => call('askIndex').then(() => setTimeout(load, 200), toastError)}><${Icon} name="refresh" size="14" /> Update index</button>` : null}
    </div>
    <div class="col mt2" style="gap:4px">
      <label class="check small"><input type="checkbox" checked=${st.useBusiness} onChange=${(e) => call('askOptions', { useBusiness: e.target.checked }).then(load, toastError)} /> Also answer from boards, customers and calls in Boardenda</label>
      <label class="check small"><input type="checkbox" checked=${st.allowCloud} onChange=${(e) => call('askOptions', { allowCloud: e.target.checked }).then(load, toastError)} /> Allow passages from these files to be sent to Claude when Claude is the AI in Settings › AI</label>
    </div>
    <div class="small faint mt2">Answers come from the AI chosen in Settings › AI (by default the Llama model in Ollama on this PC). For smarter search by meaning, also run <span class="mono">ollama pull nomic-embed-text</span>, then Update index. The index refreshes by itself every few hours.</div>
  </div>`;
}
