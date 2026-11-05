// Workdocs: rich notes that live in a workspace, or behind an item's Doc column.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Spinner, Drawer, Menu, useAnchor, toastError, toast, ask, relTime } from './lib.js';
import { call, native } from './api.js';

const ALLOWED = new Set(['P', 'DIV', 'BR', 'H1', 'H2', 'H3', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'UL', 'OL', 'LI', 'A', 'CODE', 'PRE', 'BLOCKQUOTE', 'HR', 'SPAN', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'MARK']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT']);

/** Keep only plain formatting from pasted or stored HTML. */
export function cleanDocHtml(input) {
  const doc = new DOMParser().parseFromString(`<body>${input || ''}</body>`, 'text/html');
  const walk = (node) => {
    for (const el of [...node.children]) {
      if (DROP.has(el.tagName)) { el.remove(); continue; }
      walk(el);
      if (!ALLOWED.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
      for (const a of [...el.attributes]) {
        const keep = (a.name === 'href' && el.tagName === 'A' && /^(https?:|mailto:|#)/i.test(a.value.trim()))
          || (a.name === 'class' && ['UL', 'LI'].includes(el.tagName) && /^(checklist|done)( done)?$/.test(a.value));
        if (!keep) el.removeAttribute(a.name);
      }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

const TOOLS = [
  { k: 'h1', label: 'H1', title: 'Heading 1', run: () => document.execCommand('formatBlock', false, 'H1') },
  { k: 'h2', label: 'H2', title: 'Heading 2', run: () => document.execCommand('formatBlock', false, 'H2') },
  { k: 'h3', label: 'H3', title: 'Heading 3', run: () => document.execCommand('formatBlock', false, 'H3') },
  { k: 'p', label: '¶', title: 'Normal text', run: () => document.execCommand('formatBlock', false, 'P') },
  { sep: true },
  { k: 'b', label: html`<b>B</b>`, title: 'Bold (Ctrl+B)', run: () => document.execCommand('bold') },
  { k: 'i', label: html`<i>I</i>`, title: 'Italic (Ctrl+I)', run: () => document.execCommand('italic') },
  { k: 'u', label: html`<u>U</u>`, title: 'Underline (Ctrl+U)', run: () => document.execCommand('underline') },
  { k: 's', label: html`<s>S</s>`, title: 'Strikethrough', run: () => document.execCommand('strikeThrough') },
  { k: 'mark', label: html`<mark>H</mark>`, title: 'Highlight', run: () => document.execCommand('hiliteColor', false, '#fff3a3') },
  { sep: true },
  { k: 'ul', label: '•', title: 'Bulleted list', run: () => document.execCommand('insertUnorderedList') },
  { k: 'ol', label: '1.', title: 'Numbered list', run: () => document.execCommand('insertOrderedList') },
  { k: 'check', label: '☑', title: 'Checklist', run: () => makeChecklist() },
  { k: 'quote', label: '❝', title: 'Quote', run: () => document.execCommand('formatBlock', false, 'BLOCKQUOTE') },
  { k: 'code', label: '</>', title: 'Code block', run: () => document.execCommand('formatBlock', false, 'PRE') },
  { k: 'hr', label: '—', title: 'Divider', run: () => document.execCommand('insertHorizontalRule') },
  { k: 'link', label: html`<${Icon} name="link" size="15" />`, title: 'Link', run: () => addLink() },
  { sep: true },
  { k: 'clear', label: html`<${Icon} name="x" size="14" />`, title: 'Clear formatting', run: () => { document.execCommand('removeFormat'); document.execCommand('formatBlock', false, 'P'); } },
];

function makeChecklist() {
  document.execCommand('insertUnorderedList');
  const sel = window.getSelection();
  let n = sel && sel.anchorNode;
  while (n && n.nodeName !== 'UL') n = n.parentNode;
  if (n) n.className = 'checklist';
}

function addLink() {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const url = window.prompt('Link address', 'https://');
  if (!url || !/^(https?:|mailto:)/i.test(url.trim())) return;
  if (range) { sel.removeAllRanges(); sel.addRange(range); }
  if (range && range.collapsed) document.execCommand('insertHTML', false, `<a href="${url.trim().replace(/"/g, '&quot;')}">${url.trim().replace(/</g, '&lt;')}</a>`);
  else document.execCommand('createLink', false, url.trim());
}

/** Markdown-style shortcuts typed at the start of a line. */
function shortcut(e) {
  if (e.key !== ' ') return;
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode || sel.anchorNode.nodeType !== 3) return;
  const text = sel.anchorNode.textContent.slice(0, sel.anchorOffset);
  const map = { '#': 'H1', '##': 'H2', '###': 'H3', '>': 'BLOCKQUOTE', '-': 'ul', '*': 'ul', '1.': 'ol', '[]': 'check', '```': 'PRE' };
  const what = map[text];
  if (!what) return;
  e.preventDefault();
  const node = sel.anchorNode;
  node.textContent = node.textContent.slice(sel.anchorOffset);
  const r = document.createRange();
  r.setStart(node, 0);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  if (what === 'ul') document.execCommand('insertUnorderedList');
  else if (what === 'ol') document.execCommand('insertOrderedList');
  else if (what === 'check') makeChecklist();
  else document.execCommand('formatBlock', false, what);
}

/** The editor: title, toolbar and body, saved as you type. */
export function DocEditor({ id, onTitle, onLoaded }) {
  const [d, setD] = useState(null);
  const [state, setState] = useState('saved');
  const body = useRef(null);
  const timer = useRef(null);
  const pending = useRef({});
  useEffect(() => {
    let live = true;
    call('getDoc', id).then((x) => { if (live) { setD(x); onLoaded && onLoaded(x); } }, toastError);
    return () => { live = false; flush(); };
  }, [id]);
  useEffect(() => {
    if (d && body.current && !body.current.dataset.ready) {
      body.current.innerHTML = cleanDocHtml(d.html) || '<p><br></p>';
      body.current.dataset.ready = '1';
    }
  }, [d]);
  const flush = async () => {
    clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return;
    try { await call('saveDoc', { id, ...patch }); setState('saved'); } catch (e) { setState('error'); toastError(e); }
  };
  const queue = (patch) => {
    pending.current = { ...pending.current, ...patch };
    setState('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  };
  const onInput = () => queue({ html: cleanDocHtml(body.current.innerHTML) });
  const onClick = (e) => {
    const li = e.target.closest && e.target.closest('ul.checklist > li');
    if (li && e.offsetX < 22) { li.classList.toggle('done'); onInput(); }
    const a = e.target.closest && e.target.closest('a[href]');
    if (a && (e.ctrlKey || e.metaKey) && /^(https?:|mailto:)/i.test(a.getAttribute('href'))) { e.preventDefault(); native('openExternal', { url: a.getAttribute('href') }).catch(toastError); }
  };
  const onPaste = (e) => {
    const h = e.clipboardData && e.clipboardData.getData('text/html');
    if (!h) return;
    e.preventDefault();
    document.execCommand('insertHTML', false, cleanDocHtml(h));
  };
  if (!d) return html`<${Spinner} />`;
  return html`<div class="doc-editor">
    <input class="doc-title" value=${d.title} placeholder="Untitled" aria-label="Doc title"
      onInput=${(e) => { queue({ title: e.target.value }); onTitle && onTitle(e.target.value); }} onBlur=${flush}
      onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); body.current.focus(); } }} />
    <div class="doc-meta small faint">${d.author ? `${d.author.name} · ` : ''}Edited ${relTime(d.updated_at)} · <span class=${`doc-state ${state}`}>${state === 'saving' ? 'Saving…' : state === 'error' ? 'Not saved' : 'Saved'}</span></div>
    <div class="doc-tools" role="toolbar" aria-label="Formatting">
      ${TOOLS.map((t, i) => (t.sep ? html`<span class="sep" key=${i}></span>` : html`<button key=${t.k} title=${t.title} aria-label=${t.title} onMouseDown=${(e) => { e.preventDefault(); body.current.focus(); t.run(); onInput(); }}>${t.label}</button>`))}
    </div>
    <div class="doc-body" ref=${body} contenteditable="true" spellcheck="true" aria-label="Doc body"
      onInput=${onInput} onClick=${onClick} onPaste=${onPaste} onKeyDown=${shortcut} onBlur=${flush}></div>
    <div class="small faint doc-hint">Type # for a heading, - for a list, [] for a checklist. Ctrl+click opens a link.</div>
  </div>`;
}

export async function printDoc(d) {
  if (!d) return;
  const el = document.querySelector('.doc-body');
  const title = (document.querySelector('.doc-title') || {}).value || d.title;
  const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body{font:14px/1.6 "Segoe UI",system-ui,sans-serif;color:#1d1c2b;margin:40px 48px}h1.t{font-size:28px;margin:0 0 4px}.m{color:#8a89a3;font-size:12px;margin-bottom:18px}
    blockquote{border-left:3px solid #5a55d6;margin:8px 0;padding:2px 14px;color:#555}pre{background:#f4f4f8;padding:10px;border-radius:6px;white-space:pre-wrap}
    ul.checklist{list-style:none;padding-left:4px}ul.checklist li:before{content:"☐ "}ul.checklist li.done:before{content:"☑ "}ul.checklist li.done{color:#888;text-decoration:line-through}
    mark{background:#fff3a3}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px}</style></head><body>
    <h1 class="t">${esc(title)}</h1><div class="m">${d.workspace ? esc(d.workspace.name) : ''} · printed ${new Date().toLocaleDateString()}</div>${cleanDocHtml(el ? el.innerHTML : d.html)}</body></html>`;
  try { await native('savePdf', { name: `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Doc'}.pdf`, html: page }); } catch (e) { toastError(e); }
}

/** A workspace doc as a full page. */
export function DocPage({ id, nav, openItem, refreshShell }) {
  const [d, setD] = useState(null);
  const [m, open, close] = useAnchor();
  const del = async () => {
    if (!(await ask({ title: 'Delete doc?', body: `“${d.title}” moves to the trash. You can restore it for 30 days.` }))) return;
    try { await call('deleteDoc', id); refreshShell(); nav('home'); window.dispatchEvent(new CustomEvent('bd-undoable')); } catch (e) { toastError(e); }
  };
  return html`<div class="page doc-page">
    <div class="row" style="margin-bottom:6px">
      <div class="crumbs grow">${d && d.workspace ? html`<a onClick=${() => nav('home')}>${d.workspace.name}</a><span>/ Docs</span>` : null}
        ${d && d.item ? html`<span>· for <a onClick=${() => openItem(d.item.id)}>${d.item.name}</a> on ${d.item.boardName}</span>` : null}</div>
      <button class="btn small" onClick=${() => printDoc(d)}><${Icon} name="print" size="14" /> Print or PDF</button>
      <button class="btn icon" aria-label="Doc menu" onClick=${open}><${Icon} name="more" /></button>
    </div>
    <${DocEditor} key=${id} id=${id} onLoaded=${setD} onTitle=${() => { clearTimeout(DocPage.t); DocPage.t = setTimeout(refreshShell, 900); }} />
    ${m ? html`<${Menu} anchor=${m} onClose=${close} align="right" items=${[
      { label: 'Copy as text', icon: 'copy', onClick: () => { const el = document.querySelector('.doc-body'); navigator.clipboard.writeText(el ? el.innerText : '').then(() => toast('Copied'), toastError); } },
      { sep: true },
      { label: 'Delete doc', icon: 'trash', danger: true, onClick: del },
    ]} />` : null}
  </div>`;
}

/** An item's doc, opened from its Doc column. */
export function DocDrawer({ id, onClose, nav }) {
  const [d, setD] = useState(null);
  return html`<${Drawer} wide title=${d ? d.title : 'Doc'} sub=${d && d.item ? `${d.item.name} · ${d.item.boardName}` : ''} onClose=${onClose}>
    <div class="row" style="justify-content:flex-end;margin-bottom:6px"><button class="btn small" onClick=${() => { onClose(); nav('doc', id); }}><${Icon} name="expand" size="14" /> Open full page</button></div>
    <${DocEditor} id=${id} onLoaded=${setD} onTitle=${(t) => setD((x) => ({ ...x, title: t }))} />
  </${Drawer}>`;
}

/** A small rich-text box (agenda, notes, recap) that saves as you type. */
export function RichText({ value, onSave, placeholder, label }) {
  const body = useRef(null);
  const timer = useRef(null);
  const last = useRef(value || '');
  const [state, setState] = useState('saved');
  useEffect(() => { if (body.current) body.current.innerHTML = cleanDocHtml(value) || ''; last.current = value || ''; }, []);
  const flush = async () => {
    clearTimeout(timer.current);
    if (!body.current) return;
    const h = cleanDocHtml(body.current.innerHTML);
    if (h === last.current) return;
    last.current = h;
    try { await onSave(h); setState('saved'); } catch (e) { setState('error'); toastError(e); }
  };
  useEffect(() => () => flush(), []);
  const onInput = () => { setState('saving'); clearTimeout(timer.current); timer.current = setTimeout(flush, 700); };
  const onPaste = (e) => { const h = e.clipboardData && e.clipboardData.getData('text/html'); if (!h) return; e.preventDefault(); document.execCommand('insertHTML', false, cleanDocHtml(h)); };
  const onClick = (e) => { const li = e.target.closest && e.target.closest('ul.checklist > li'); if (li && e.offsetX < 22) { li.classList.toggle('done'); onInput(); } };
  return html`<div class="rich">
    <div class="doc-tools" role="toolbar" aria-label="Formatting">
      ${TOOLS.filter((t) => !['h1', 'code', 'hr'].includes(t.k)).map((t, i) => (t.sep ? html`<span class="sep" key=${i}></span>` : html`<button key=${t.k} title=${t.title} aria-label=${t.title} onMouseDown=${(e) => { e.preventDefault(); body.current.focus(); t.run(); onInput(); }}>${t.label}</button>`))}
      <span class="grow"></span><span class=${`small faint doc-state ${state}`}>${state === 'saving' ? 'Saving…' : state === 'error' ? 'Not saved' : 'Saved'}</span>
    </div>
    <div class="doc-body rich-body" ref=${body} contenteditable="true" spellcheck="true" aria-label=${label || placeholder} data-ph=${placeholder || ''}
      onInput=${onInput} onPaste=${onPaste} onClick=${onClick} onKeyDown=${shortcut} onBlur=${flush}></div>
  </div>`;
}
