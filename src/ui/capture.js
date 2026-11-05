// Quick capture: drop or paste rough notes, review what they become (items,
// calls, action items, updates), map anything unsure, then create it all.
import { useState, useRef, useEffect } from 'preact/hooks';
import { html, Icon, Modal, Spinner, toast, toastError, plural } from './lib.js';
import { call } from './api.js';

export const openCapture = () => window.dispatchEvent(new CustomEvent('bd-capture'));

const KIND_LABEL = { item: 'New item', meeting: 'Call or meeting', action: 'Action item', update: 'Update on an item' };
const KIND_ICON = { item: 'table', meeting: 'phone', action: 'check', update: 'msg' };
const ACCEPT = '.txt,.md,.docx,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff';

function RecordCard({ r, set, boards, people, records, boot }) {
  const b = boards.find((x) => x.id === r.boardId);
  const meetings = records.filter((x) => x.kind === 'meeting' && x.include);
  const missing = (r.kind === 'item' || (r.kind === 'action' && !r.meetingRef)) && !r.boardId ? 'board' : r.kind === 'update' && !r.itemId ? 'item' : null;
  return html`<div class=${`cap-card ${r.include ? '' : 'off'} ${r.needsMapping && !r.confirmed ? 'unsure' : ''}`}>
    <div class="row" style="gap:8px">
      <input type="checkbox" aria-label="Create this" checked=${r.include} onChange=${(e) => set({ include: e.target.checked })} />
      <span class=${`cap-kind ${r.kind}`}><${Icon} name=${KIND_ICON[r.kind]} size="13" /></span>
      <select class="input cap-kind-sel" aria-label="Kind" value=${r.kind} onChange=${(e) => set({ kind: e.target.value, confirmed: true })}>${Object.entries(KIND_LABEL).map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}</select>
      <input class="input grow" aria-label="Title" value=${r.title} onInput=${(e) => set({ title: e.target.value })} />
    </div>
    ${r.needsMapping && !r.confirmed && r.include ? html`<div class="cap-q small"><${Icon} name="warn" size="13" /> ${r.question || 'Not sure about this one. Check where it goes.'}
      ${!missing ? html`<button class="btn ghost small" onClick=${() => set({ confirmed: true })}>Looks right</button>` : null}</div>` : null}
    <div class="cap-fields">
      ${r.kind === 'item' || (r.kind === 'action' && !r.meetingRef) ? html`
        <label class="field">Board<select class=${`input ${missing === 'board' ? 'need' : ''}`} value=${r.boardId || ''} onChange=${(e) => { const nb = boards.find((x) => x.id === e.target.value); set({ boardId: e.target.value || null, groupId: nb && nb.groups[0] ? nb.groups[0].id : null, values: {}, confirmed: true }); }}>
          <option value="">Choose a board…</option>${boards.map((x) => html`<option key=${x.id} value=${x.id}>${x.name}</option>`)}</select></label>
        ${b ? html`<label class="field">Group<select class="input" value=${r.groupId || ''} onChange=${(e) => set({ groupId: e.target.value, confirmed: true })}>${b.groups.map((g) => html`<option key=${g.id} value=${g.id}>${g.name}</option>`)}</select></label>` : null}` : null}
      ${r.kind === 'action' ? html`<label class="field">From<select class="input" value=${r.meetingRef || ''} onChange=${(e) => set({ meetingRef: e.target.value || null })}>
          <option value="">No meeting (add to a board)</option>${meetings.map((m) => html`<option key=${m.key} value=${m.key}>${m.title}</option>`)}</select></label>` : null}
      ${r.kind === 'item' || r.kind === 'action' ? html`
        <label class="field">Owner<select class="input" value=${r.owner || ''} onChange=${(e) => set({ owner: e.target.value || null, confirmed: r.confirmed || /^Who is/.test(r.question || '') })}><option value="">${r.ownerText && !r.owner ? `“${r.ownerText}”?` : 'No owner'}</option>${people.map((p) => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}</select></label>
        <label class="field">Due<input class="input" type="date" value=${r.due || ''} onInput=${(e) => set({ due: e.target.value || null })} /></label>` : null}
      ${r.kind === 'meeting' ? html`
        <label class="field">Customer<input class="input" value=${r.customer} onInput=${(e) => set({ customer: e.target.value })} /></label>
        <label class="field">Date<input class="input" type="date" value=${r.date || ''} onInput=${(e) => set({ date: e.target.value })} /></label>
        <label class="field">Time<input class="input" type="time" value=${r.time || ''} onInput=${(e) => set({ time: e.target.value })} /></label>` : null}
      ${r.kind === 'meeting' || r.kind === 'update' ? html`<${ItemField} r=${r} set=${set} need=${missing === 'item'} />` : null}
    </div>
    ${b && Object.keys(r.values || {}).length ? html`<div class="small muted cap-vals">${Object.keys(r.values).map((cid) => { const c = b.columns.find((x) => x.id === cid); return c ? html`<span class="chip" key=${cid}>${c.title}</span>` : null; })} filled in</div>` : null}
    ${r.unmatched && r.unmatched.length ? html`<div class="small faint">Not placed: ${r.unmatched.join(', ')}</div>` : null}
    ${r.notes && r.kind !== 'meeting' ? html`<div class="small muted cap-notes">${r.notes}</div>` : null}
  </div>`;
}

function ItemField({ r, set, need }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState([]);
  const search = (v) => { setQ(v); if (v.trim().length < 2) { setRes([]); return; } call('search', v).then((x) => setRes(x.filter((y) => y.kind === 'item').slice(0, 6)), () => {}); };
  if (r.itemId) return html`<label class="field">About<span class="row" style="gap:6px"><span class="chip">${r.itemName}</span><button class="btn ghost small" onClick=${() => set({ itemId: null, itemName: '' })}>Change</button></span></label>`;
  return html`<label class="field item-pick">${r.kind === 'update' ? 'Item' : 'About (optional)'}<input class=${`input ${need ? 'need' : ''}`} placeholder="Search items" value=${q} onInput=${(e) => search(e.target.value)} />
    ${res.length ? html`<div class="item-pick-list">${res.map((x) => html`<button key=${x.id} class="mi" onClick=${(e) => { e.preventDefault(); set({ itemId: x.id, itemName: `${x.name} · ${x.boardName}`, confirmed: true }); setQ(''); setRes([]); }}>
      <span class="clip">${x.name}</span><span class="grow"></span><span class="small faint">${x.boardName}</span></button>`)}</div>` : null}</label>`;
}

function readerName(ai) {
  const p = (ai && ai.provider) || 'auto';
  if (p === 'off') return 'The built-in reader';
  if (p === 'anthropic' || (p === 'auto' && ai.hasKey)) return 'Claude reads them and';
  if (p === 'ollama' || p === 'openai') return 'Your local model reads them and';
  return 'Your local Ollama model (or the built-in reader if Ollama is not running) reads them and';
}
function readerHint(ai) {
  const p = (ai && ai.provider) || 'auto';
  if (p === 'off') return 'Built-in reader. Turn on a model in Settings > AI.';
  if (p === 'anthropic' || (p === 'auto' && ai.hasKey)) return 'Claude will read these notes.';
  return 'A model on this PC will read these notes; it can take up to a minute. Nothing leaves this PC.';
}

export function CaptureModal({ boot, onClose, onDone }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [over, setOver] = useState(false);
  const input = useRef(null);
  const [ai, setAiState] = useState(boot.ai);
  useEffect(() => { call('aiStatus').then(setAiState, () => {}); }, []);
  const addFiles = async (list) => {
    const out = [];
    for (const f of list) out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    setFiles((cur) => [...cur, ...out]);
  };
  const read = async () => {
    setBusy(true);
    try {
      const [r, b] = await Promise.all([call('readNotes', { text, files }), ctx ? Promise.resolve(ctx) : call('captureBoards')]);
      setCtx(b);
      setRes(r);
      if (!r.records.length) toast('Nothing to create was found in these notes', 'err');
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const setRec = (key, patch) => setRes((cur) => ({ ...cur, records: cur.records.map((x) => (x.key === key ? { ...x, ...patch } : x)) }));
  const chosen = res ? res.records.filter((r) => r.include) : [];
  const unsure = chosen.filter((r) => r.needsMapping && !r.confirmed);
  const blocking = chosen.filter((r) => ((r.kind === 'item' || (r.kind === 'action' && !r.meetingRef)) && !r.boardId) || (r.kind === 'update' && !r.itemId) || (r.needsMapping && !r.confirmed));
  const create = async () => {
    setBusy(true);
    try {
      const made = await call('applyNotes', { records: chosen, text: res.text });
      const parts = [made.meeting && plural(made.meeting, 'call'), made.item && plural(made.item, 'item'), made.action && plural(made.action, 'action item'), made.update && plural(made.update, 'update')].filter(Boolean);
      toast(`Created ${parts.join(', ')}`);
      onDone(made);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return html`<${Modal} wide title="Quick capture" onClose=${onClose}>
    ${!res ? html`<div class="col" style="gap:10px">
      <div class="small muted">Paste meeting notes, a to-do list or an email, or drop a Word file, PDF or photo of handwritten notes. ${readerName(ai)} suggests where each thing goes, and asks when it isn't sure. Nothing is created until you confirm.</div>
      <div class=${`cap-drop ${over ? 'over' : ''}`} onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); addFiles([...e.dataTransfer.files]); }}>
        <textarea class="input cap-text" autoFocus aria-label="Notes" placeholder=${'Call with Acme 11/12 2pm\nThey want the pilot in January.\n- Sam to send the quote by Friday\n- Book a demo for their IT team next week'} value=${text} onInput=${(e) => setText(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) read(); }}></textarea>
        <div class="row small" style="gap:6px;flex-wrap:wrap">${files.map((f, i) => html`<span class="chip" key=${i}><${Icon} name="file" size="12" /> ${f.name}<button class="ig-del" aria-label="Remove file" onClick=${() => setFiles(files.filter((_, j) => j !== i))}>×</button></span>`)}
          <a onClick=${() => input.current.click()}>Add a file</a><span class="faint">or drop one here</span></div>
        <input type="file" hidden multiple accept=${ACCEPT} ref=${input} onChange=${(e) => addFiles([...e.target.files])} />
      </div>
      <div class="row"><span class="small faint"><${Icon} name="spark" size="13" /> ${readerHint(ai)}</span><span class="grow"></span>
        <button class="btn" onClick=${onClose}>Cancel</button>
        <button class="btn primary" disabled=${busy || (!text.trim() && !files.length)} onClick=${read}>${busy ? html`<${Spinner} /> Reading…` : 'Read notes'}</button></div>
    </div>` : html`<div class="col" style="gap:10px">
      <div class="row small" style="gap:8px;flex-wrap:wrap"><span class="chip">${res.mode === 'claude' ? 'Read by Claude' : res.mode === 'local' ? `Read by ${res.model} on this PC` : 'Built-in reader'}</span>
        <span class="muted">${plural(res.records.length, 'record')} found${unsure.length ? `, ${unsure.length} to check` : ''}.</span>
        ${res.notes.map((n, i) => html`<span class="faint" key=${i}>${n}</span>`)}</div>
      <div class="cap-list">${res.records.map((r) => html`<${RecordCard} key=${r.key} r=${r} set=${(p) => setRec(r.key, p)} boards=${ctx || []} people=${boot.people} records=${res.records} boot=${boot} />`)}</div>
      <div class="row"><button class="btn ghost" onClick=${() => setRes(null)}><${Icon} name="arrowLeft" size="14" /> Back to the notes</button><span class="grow"></span>
        ${blocking.length ? html`<span class="small cap-need">${plural(blocking.length, 'record')} need${blocking.length === 1 ? 's' : ''} your answer</span>` : null}
        <button class="btn" onClick=${onClose}>Cancel</button>
        <button class="btn primary" disabled=${busy || !chosen.length || blocking.length} onClick=${create}>${busy ? 'Creating…' : `Create ${plural(chosen.length, 'record')}`}</button></div>
    </div>`}
  </${Modal}>`;
}

/** Settings: which model reads Quick capture notes. */
export function AiSettings() {
  const [st, setSt] = useState(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState(null);
  if (!st) { call('aiStatus').then(setSt, toastError); return html`<${Spinner} />`; }
  const save = async (patch) => { try { setSt(await call('setAi', patch)); setLocal(null); } catch (e) { toastError(e); } };
  const test = async () => {
    setBusy(true);
    try {
      const r = await call('testAi');
      if (r.models) setLocal(r);
      toast(r.provider === 'anthropic' ? 'Claude is connected and read a test note' : `Connected. Quick capture will use ${r.model}`);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const p = st.provider;
  const isLocal = p === 'ollama' || p === 'openai' || (p === 'auto' && !st.hasKey);
  const opts = [['auto', 'Automatic'], ['ollama', 'Ollama on this PC'], ['openai', 'Other local server'], ['anthropic', 'Claude (online)'], ['off', 'Off']];
  return html`<div class="card pad">
    <h3>AI for Quick capture</h3>
    <p class="small muted">Quick capture (Ctrl+J) turns rough notes into items, calls and action items. A model reads the notes and places each record using the names of your boards, groups, columns, people and recent items. Without one, a simpler built-in reader is used.</p>
    <div class="seg mt">${opts.map(([k, l]) => html`<button key=${k} class=${p === k ? 'on' : ''} onClick=${() => save({ provider: k, ...(k === 'openai' && !/:1234/.test(st.localUrl) ? { localUrl: 'http://127.0.0.1:1234' } : k === 'ollama' && !/:11434/.test(st.localUrl) ? { localUrl: 'http://127.0.0.1:11434' } : {}) })}>${l}</button>`)}</div>
    <p class="small muted mt">${p === 'auto' ? 'Uses Claude when an API key is saved below; otherwise the Llama or other model in Ollama on this PC (the same one LOA Command Center uses) when Ollama is running; otherwise the built-in reader.'
      : p === 'ollama' ? 'Uses a model installed in Ollama on this PC, such as the Llama model LOA Command Center uses. Notes never leave this PC.'
      : p === 'openai' ? 'Uses LM Studio, llama.cpp, Jan or another OpenAI-compatible server on this PC or your local network.'
      : p === 'anthropic' ? 'Claude reads the notes, including photos of handwriting. The notes are sent to Anthropic and usage is billed to your Anthropic account.' : 'Only the built-in reader is used.'}</p>
    ${isLocal ? html`<div class="grid c2 mt" style="gap:8px">
      <label class="field">Server address<input class="input" value=${st.localUrl} onChange=${(e) => save({ localUrl: e.target.value })} /></label>
      <label class="field">Model<input class="input" list="bd-local-models" placeholder="Pick automatically (prefers Llama)" value=${st.localModel} onChange=${(e) => save({ localModel: e.target.value })} />
        <datalist id="bd-local-models">${((local && local.models) || []).map((m) => html`<option key=${m} value=${m} />`)}</datalist></label></div>
      <div class="row mt" style="gap:8px"><button class="btn" disabled=${busy} onClick=${test}>${busy ? 'Checking…' : 'Test connection'}</button>
        ${local ? html`<span class="small muted">Installed: ${local.models.join(', ') || 'none'}. Using ${local.model}.</span>` : null}</div>
      <p class="small faint mt">Bigger models place records better. If Ollama is not installed: get it from ollama.com, then run <span class="mono">ollama pull llama3.1:8b</span> (or <span class="mono">llama3.2:3b</span> on a low-memory laptop).</p>` : null}
    ${p === 'anthropic' || p === 'auto' ? html`<div class="mt"><b class="small">Anthropic API key</b><div class="row mt" style="gap:8px">
      <input class="input grow" type="password" autocomplete="off" placeholder=${st.hasKey ? `Key saved (${st.keyHint}). Paste a new one to replace it` : 'sk-ant-…'} value=${key} onInput=${(e) => setKey(e.target.value)} />
      <button class="btn primary" disabled=${!key.trim()} onClick=${async () => { await save({ key: key.trim() }); setKey(''); toast('API key saved'); }}>Save key</button>
      ${st.hasKey ? html`${p === 'anthropic' ? html`<button class="btn" disabled=${busy} onClick=${test}>${busy ? 'Testing…' : 'Test'}</button>` : null}<button class="btn ghost" onClick=${() => save({ key: '' })}>Remove</button>` : null}</div>
      <label class="field mt" style="max-width:320px">Claude model<select class="input" value=${st.model} onChange=${(e) => save({ model: e.target.value })}>
        <option value="claude-opus-5-5">Claude Opus 5.5 (best placement)</option><option value="claude-sonnet-5-5">Claude Sonnet 5.5 (faster)</option><option value="claude-haiku-5-5">Claude Haiku 5.5 (cheapest)</option></select></label>
      <p class="small faint mt">Get a key at console.anthropic.com. The key is kept in this PC's Boardenda database and its backups.</p></div>` : null}
  </div>`;
}
