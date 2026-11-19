// Web pages: read the page in your browser (Ctrl+Alt+B), a page in the
// built-in browser, or a link. Saved pages feed Chat; their tables and lists
// can be exported to Excel, specific fields pulled out by the AI, the page
// asked about, handed to the assistant, or watched for changes.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Spinner, toast, toastError, ask, relTime, usePersist, plural } from './lib.js';
import { call, native, isDesktop } from './api.js';
import { answerHtml } from './ask.js';

const VIA = { browser: 'your browser', 'built-in': 'the built-in browser', link: 'a link' };
const WATCH = [[0, 'Not watched'], [1, 'Every hour'], [4, 'Every 4 hours'], [12, 'Twice a day'], [24, 'Every day'], [168, 'Every week']];
const site = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };
let readerScript = null;

/** The built-in browser: sign in to sites here once; Boardenda can then read and watch them. */
function BrowserPane({ onRead }) {
  const ref = useRef(null);
  const [last, setLast] = usePersist('webLast', 'https://www.bing.com');
  const [start] = useState(last);
  const [addr, setAddr] = useState(start);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!v) return undefined;
    const nav = (e) => { if (e.isMainFrame === false) return; setAddr(e.url); setLast(e.url); };
    const t = (e) => setTitle(e.title);
    const a = () => setLoading(true);
    const b = () => setLoading(false);
    v.addEventListener('did-navigate', nav);
    v.addEventListener('did-navigate-in-page', nav);
    v.addEventListener('page-title-updated', t);
    v.addEventListener('did-start-loading', a);
    v.addEventListener('did-stop-loading', b);
    return () => { v.removeEventListener('did-navigate', nav); v.removeEventListener('did-navigate-in-page', nav); v.removeEventListener('page-title-updated', t); v.removeEventListener('did-start-loading', a); v.removeEventListener('did-stop-loading', b); };
  }, []);
  const go = (e) => {
    e.preventDefault();
    let u = addr.trim();
    if (!u) return;
    if (!/^[a-z]+:/i.test(u)) u = /\s/.test(u) || !/\./.test(u) ? `https://www.bing.com/search?q=${encodeURIComponent(u)}` : `https://${u}`;
    try { ref.current.loadURL(u); } catch (err) { toastError(err); }
  };
  const read = async () => {
    setBusy(true);
    try {
      readerScript = readerScript || await call('webScript');
      const data = await ref.current.executeJavaScript(readerScript);
      const p = await call('webSave', data, { via: 'built-in' });
      toast(`Read "${p.title}"`);
      onRead(p);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const act = (fn) => () => { try { fn(ref.current); } catch (_) { /* not ready */ } };
  return html`<div class="wb-browser">
    <form class="wb-bar" onSubmit=${go}>
      <button type="button" class="btn ghost icon small" title="Back" aria-label="Back" onClick=${act((v) => v.canGoBack() && v.goBack())}><${Icon} name="chev" size="14" cls="wb-back" /></button>
      <button type="button" class="btn ghost icon small" title="Forward" aria-label="Forward" onClick=${act((v) => v.canGoForward() && v.goForward())}><${Icon} name="chev" size="14" /></button>
      <button type="button" class="btn ghost icon small" title="Reload" aria-label="Reload" onClick=${act((v) => v.reload())}>${loading ? html`<${Spinner} />` : html`<${Icon} name="refresh" size="14" />`}</button>
      <input class="input grow" aria-label="Address" value=${addr} onInput=${(e) => setAddr(e.target.value)} onFocus=${(e) => e.target.select()} />
      <button type="button" class="btn primary small" disabled=${busy || loading} onClick=${read} title=${title ? `Read "${title}"` : 'Read this page'}>${busy ? html`<${Spinner} />` : html`<${Icon} name="download" size="14" />`} Read this page</button>
    </form>
    <webview ref=${ref} class="wb-view" src=${start} partition="persist:boardenda-web"></webview>
  </div>`;
}

function TableView({ page, onExtracted }) {
  const all = [...(page.tables || []), ...(page.lists || [])];
  const [i, setI] = useState(0);
  const [want, setWant] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setI((x) => Math.min(x, Math.max(0, all.length - 1))), [page.id, all.length]);
  const t = all[i];
  const save = async (which, format) => {
    try {
      const r = await call('webExport', page.id, which, format);
      const path = await native('saveFile', r.bytes ? { name: r.name, bytes: r.bytes, filters: [{ name: 'Excel', extensions: ['xlsx'] }] } : { name: r.name, text: r.text, filters: [{ name: 'CSV', extensions: ['csv'] }] });
      if (path) toast(`Saved ${r.name}`);
    } catch (e) { toastError(e); }
  };
  const pull = async (e) => {
    e.preventDefault();
    if (!want.trim()) return;
    setBusy(true);
    try {
      const r = await call('webExtract', page.id, want);
      toast(r.mode === 'basic' ? 'No AI is set up, so the closest table was picked.' : `Pulled out ${plural(r.table.rows.length, 'row')}.`);
      onExtracted(r.page, r.index);
      setI(r.index);
      setWant('');
    } catch (err) { toastError(err); } finally { setBusy(false); }
  };
  const label = (x, k) => x.caption || (x.kind === 'ai' ? 'Pulled out' : x.kind === 'list' ? `List ${k + 1}` : `Table ${k + 1}`);
  return html`<div>
    <form class="row wb-pull" onSubmit=${pull}>
      <${Icon} name="spark" size="15" />
      <input class="input grow" placeholder="Pull out data: e.g. every product with its price and stock" value=${want} onInput=${(e) => setWant(e.target.value)} />
      <button class="btn small" disabled=${busy || !want.trim()}>${busy ? html`<${Spinner} />` : null} Pull out</button></form>
    ${all.length ? html`
      <div class="wb-chips">${all.map((x, k) => html`<button key=${k} class=${`chip wb-chip ${k === i ? 'on' : ''} ${x.kind}`} onClick=${() => setI(k)} title=${label(x, k)}>${label(x, k)} <span class="muted">· ${x.rows.length}</span></button>`)}</div>
      ${t ? html`<div class="wb-tablewrap"><table class="wb-table"><thead><tr>${t.headers.map((h, k) => html`<th key=${k}>${h}</th>`)}</tr></thead>
        <tbody>${t.rows.slice(0, 300).map((r, k) => html`<tr key=${k}>${r.map((c, j) => html`<td key=${j}>${/^https?:\/\//.test(c) ? html`<a href="#" onClick=${(e) => { e.preventDefault(); native('openExternal', { url: c }); }}>${site(c) || c}</a>` : c}</td>`)}</tr>`)}</tbody></table></div>
        ${t.rows.length > 300 ? html`<div class="small muted">Showing 300 of ${t.rows.length} rows. Export to get them all.</div>` : null}
        <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:8px">
          <button class="btn small" onClick=${() => save(i, 'xlsx')}><${Icon} name="download" size="14" /> Excel</button>
          <button class="btn small" onClick=${() => save(i, 'csv')}><${Icon} name="download" size="14" /> CSV</button>
          ${all.length > 1 ? html`<button class="btn small ghost" onClick=${() => save('all', 'xlsx')}><${Icon} name="table" size="14" /> All ${all.length} to one Excel file</button>` : null}</div>` : null}`
      : html`<div class="small muted pad">No tables or lists were found on this page. Say what to pull out above and the AI will build the table from the text.</div>`}
  </div>`;
}

function PageView({ id, onChanged, onGone }) {
  const [p, setP] = useState(null);
  const [tab, setTab] = usePersist('webTab', 'tables');
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState('');
  const load = async () => { try { setP(await call('webPage', id)); } catch (e) { toastError(e); onGone(); } };
  useEffect(() => { setP(null); setAnswer(null); setQ(''); load(); }, [id]);
  if (!p) return html`<div class="card wb-detail"><${Spinner} /></div>`;
  const run = async (name, fn) => { setBusy(name); try { await fn(); } catch (e) { toastError(e); } finally { setBusy(''); } };
  const doAsk = async (e) => {
    if (e) e.preventDefault();
    setAsking(true);
    try { setAnswer(await call('webAsk', [p.id], q)); } catch (err) { toastError(err); } finally { setAsking(false); }
  };
  const ch = p.change;
  return html`<div class="card wb-detail">
    <div class="row" style="gap:10px;align-items:flex-start">
      <div class="grow" style="min-width:0">
        <h2 class="wb-title">${p.title}</h2>
        <a class="small wb-url clip" href="#" title=${p.url} onClick=${(e) => { e.preventDefault(); native('openExternal', { url: p.url }).catch(toastError); }}>${p.url}</a>
        <div class="small muted">Read ${relTime(p.at)} from ${VIA[p.via] || p.via}${p.first !== p.at ? ` · first read ${relTime(p.first)}` : ''} · ${plural(p.text.length, 'character')}</div>
        ${ch && ch.error ? html`<div class="small wb-change bad">Last check failed: ${ch.error}</div>`
          : ch && ch.changed ? html`<div class="small wb-change">Changed since the last read: ${[ch.added && `${ch.added} new lines`, ch.rowsAdded && `${ch.rowsAdded} new rows`, ch.removed && `${ch.removed} lines gone`, ch.rowsRemoved && `${ch.rowsRemoved} rows gone`].filter(Boolean).join(', ')}</div>`
          : ch ? html`<div class="small muted">No change since the last read.</div>` : null}
      </div>
      <select class="input" style="width:auto" aria-label="Watch this page" title="Read the page again on a schedule and tell you in Chat when it changes" value=${p.watch || 0}
        onChange=${(e) => run('watch', async () => { const n = await call('webUpdate', p.id, { watch: Number(e.target.value) }); setP(n); onChanged(); toast(n.watch ? 'Watching it. Changes show in Chat.' : 'Stopped watching.'); })}>
        ${WATCH.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}</select>
    </div>
    <div class="row wb-actions">
      <button class="btn small" disabled=${!!busy} onClick=${() => run('again', async () => { const n = await call('webRecheck', p.id); setP(n); onChanged(); toast(n.change && n.change.changed ? 'Read again: it changed.' : 'Read again: no change.'); })}>${busy === 'again' ? html`<${Spinner} />` : html`<${Icon} name="refresh" size="14" />`} Read again</button>
      <button class="btn small" disabled=${!!busy} title="The assistant reads it and suggests what to act on, in Chat" onClick=${() => run('send', async () => { await call('webToAssistant', p.id, { note: q }); toast('Sent to the assistant. Anything to act on shows in Chat.'); })}>${busy === 'send' ? html`<${Spinner} />` : html`<${Icon} name="msg" size="14" />`} Send to assistant</button>
      <button class="btn small ghost" onClick=${() => { navigator.clipboard.writeText(p.text).then(() => toast('Page text copied'), toastError); }}><${Icon} name="copy" size="14" /> Copy text</button>
      <span class="grow"></span>
      <button class="btn small ghost" onClick=${async () => { if (await ask({ title: 'Delete this page?', body: 'Its text, tables and the note Chat uses are deleted.' })) { await call('webDelete', p.id).catch(toastError); onGone(); } }}><${Icon} name="trash" size="14" /> Delete</button>
    </div>
    <form class="row wb-ask" onSubmit=${doAsk}>
      <input class="input grow" placeholder="Ask about this page, or leave empty for a summary" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <button class="btn primary small" disabled=${asking}>${asking ? html`<${Spinner} />` : html`<${Icon} name="spark" size="14" />`} ${q.trim() ? 'Ask' : 'Summarize'}</button></form>
    ${answer ? html`<div class="answer wb-answer" dangerouslySetInnerHTML=${{ __html: answerHtml(answer.answer) }}></div>
      <div class="small faint">${answer.mode === 'local' ? `Answered by ${answer.model} on this PC` : answer.mode === 'claude' ? 'Answered by Claude' : answer.mode === 'chatgpt' ? 'Answered by ChatGPT' : 'No AI is set up: matching lines from the page'}</div>` : null}
    <div class="tabs wb-tabs">
      ${[['tables', `Tables and lists (${(p.tables || []).length + (p.lists || []).length})`], ['text', 'Text'], ['links', `Links (${(p.links || []).length})`]].map(([k, l]) => html`<button key=${k} class=${`tab ${tab === k ? 'on' : ''}`} onClick=${() => setTab(k)}>${l}</button>`)}
    </div>
    ${tab === 'tables' ? html`<${TableView} page=${p} onExtracted=${(np) => { setP(np); onChanged(); }} />`
      : tab === 'text' ? html`<div class="wb-text">${p.selection ? html`<div class="wb-sel"><b>You selected:</b>\n${p.selection}</div>` : null}${p.text.slice(0, 60000)}${p.text.length > 60000 ? '\n…' : ''}</div>`
      : html`<div class="wb-links">${(p.links || []).map((l, k) => html`<a key=${k} href="#" class="wb-link" onClick=${(e) => { e.preventDefault(); native('openExternal', { url: l.href }); }}><span class="clip">${l.text}</span><span class="small muted clip">${site(l.href)}</span></a>`)}
          ${(p.links || []).length ? null : html`<div class="small muted pad">No links were kept for this page.</div>`}</div>`}
  </div>`;
}

function Privacy({ st, save, reload, onCleared }) {
  const [words, setWords] = useState(st.blocked.join(', '));
  useEffect(() => setWords(st.blocked.join(', ')), [st.blocked.join(',')]);
  const Toggle = ({ on, label, hint, k }) => html`<div class="row between ac-toggle"><div><b>${label}</b><div class="small muted">${hint}</div></div>
    <button class=${`toggle ${on ? 'on' : ''}`} role="switch" aria-checked=${on} aria-label=${label} onClick=${() => save({ [k]: !on })}></button></div>`;
  return html`<section class="card ac-sec"><h3><${Icon} name="shield" size="15" /> Privacy</h3>
    <${Toggle} k="learn" on=${st.learn} label="Chat can use saved pages" hint="Each saved page is kept as a note on this PC that Chat searches when you ask something. Online AI sees them only if you allow files under Search folders." />
    ${isDesktop ? html`<${Toggle} k="hotkey" on=${st.hotkey} label="Ctrl+Alt+B reads my browser" hint="Press it in Edge, Chrome or Firefox to save the page you are on. Also in the tray menu." />` : null}
    <div class="row between ac-toggle"><div><b>Keep</b><div class="small muted">The oldest pages go first; watched pages are kept.</div></div>
      <select class="input" style="width:auto" value=${st.keepPages} onChange=${(e) => save({ keepPages: Number(e.target.value) })}>${[100, 500, 1000, 5000, 20000].map((n) => html`<option key=${n} value=${n}>${n} pages</option>`)}</select></div>
    <div class="ac-toggle"><b>Never read pages with these words in the address</b>
      <div class="small muted">Private windows (InPrivate, Incognito), sign-in and password pages are never read whatever this says, nor windows with the private words from Activity.</div>
      <textarea class="input" rows="2" style="width:100%;margin-top:6px" value=${words} onInput=${(e) => setWords(e.target.value)} onBlur=${() => save({ blocked: words })}></textarea></div>
    <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px">
      ${isDesktop && st.folder ? html`<button class="btn small" onClick=${() => native('openPath', { path: st.notesFolder }).catch(toastError)}><${Icon} name="folder" size="14" /> Open the notes folder</button>` : null}
      <button class="btn small" onClick=${async () => { if (await ask({ title: 'Delete all saved pages?', body: 'Every saved page, its tables and the notes Chat uses are deleted.' })) { await call('webClear').catch(toastError); onCleared(); reload(); } }}><${Icon} name="trash" size="14" /> Delete all pages</button></div>
  </section>`;
}

export function WebPage({ id, version }) {
  const [st, setSt] = useState(null);
  const [pages, setPages] = useState([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(id || null);
  const [url, setUrl] = useState('');
  const [reading, setReading] = useState('');
  const [showBrowser, setShowBrowser] = usePersist('webBrowserOpen', false);
  const [tick, setTick] = useState(0);
  const load = async () => {
    try {
      const [s, list] = await Promise.all([call('webStatus'), call('webPages', { q })]);
      setSt(s); setPages(list);
      setSel((cur) => cur || (list[0] && list[0].id) || null);
    } catch (e) { toastError(e); }
  };
  useEffect(() => { load(); }, [version, q]);
  useEffect(() => { if (id) setSel(id); }, [id]);
  const save = async (patch) => { try { setSt(await call('setWeb', patch)); } catch (e) { toastError(e); } };
  const opened = (p) => { setSel(p.id); setTick((t) => t + 1); load(); };
  const readLink = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setReading('link');
    try { const p = await call('webReadUrl', url); setUrl(''); toast(`Read "${p.title}"`); opened(p); } catch (err) { toastError(err); } finally { setReading(''); }
  };
  const readBrowser = async () => {
    setReading('browser');
    try {
      const r = await native('readBrowser');
      if (!r.ok) toast(r.message, 'err');
      else { toast(`Read "${r.title}"`); opened({ id: r.id }); }
    } catch (err) { toastError(err); } finally { setReading(''); }
  };
  if (!st) return html`<div class="page"><${Spinner} /></div>`;
  return html`<div class="page ac-page wb-page">
    <div class="page-head"><div><h1>Web pages</h1><div class="muted small">Read pages from your browser, scrape their tables and lists, and let the assistant use them</div></div><span class="grow"></span>
      ${isDesktop ? html`<button class="btn primary" disabled=${!!reading} onClick=${readBrowser} title="Reads the page open in Edge, Chrome or Firefox (Ctrl+Alt+B from the browser)">${reading === 'browser' ? html`<${Spinner} />` : html`<${Icon} name="globe" size="15" />`} Read my browser</button>` : null}</div>

    <section class="card ac-sec">
      <form class="row" style="gap:8px" onSubmit=${readLink}>
        <${Icon} name="link" size="16" />
        <input class="input grow" aria-label="Web address" placeholder="Paste a link to read it, e.g. a price list, a portal page or a news article" value=${url} onInput=${(e) => setUrl(e.target.value)} />
        <button class="btn" disabled=${!!reading || !url.trim()}>${reading === 'link' ? html`<${Spinner} />` : null} Read link</button>
        ${isDesktop ? html`<button type="button" class=${`btn ${showBrowser ? 'on' : 'ghost'}`} onClick=${() => setShowBrowser(!showBrowser)} title="A browser inside Boardenda: sign in to sites once, then read and watch them"><${Icon} name="globe" size="15" /> ${showBrowser ? 'Hide browser' : 'Built-in browser'}</button>` : null}
      </form>
      ${isDesktop ? html`<div class="small muted" style="margin-top:6px">${st.hotkey ? html`In Edge, Chrome or Firefox, press <b>Ctrl+Alt+B</b> to save the page you are on, with its tables. ` : ''}Pages that need a sign-in work from your own browser, or sign in once in the built-in browser.</div>` : null}
      ${isDesktop && showBrowser ? html`<${BrowserPane} onRead=${opened} />` : null}
    </section>

    ${pages.length || q ? html`<div class="wb-grid">
      <section class="card wb-list">
        <input class="input" style="width:100%;margin-bottom:8px" placeholder=${`Search ${plural(st.pages, 'page')}`} value=${q} onInput=${(e) => setQ(e.target.value)} />
        ${pages.map((p) => html`<button key=${p.id} class=${`wb-item ${p.id === sel ? 'on' : ''}`} onClick=${() => setSel(p.id)}>
          <b class="clip">${p.title}</b>
          <span class="small muted clip">${p.site || site(p.url)} · ${relTime(p.at)}</span>
          <span class="small faint">${[p.tables && plural(p.tables, 'table'), p.lists && plural(p.lists, 'list'), p.rows && plural(p.rows, 'row'), p.watch && 'watched'].filter(Boolean).join(' · ') || 'text'}${p.change && p.change.changed ? html` · <span class="wb-dot">changed</span>` : ''}</span></button>`)}
        ${!pages.length ? html`<div class="small muted pad">No saved page matches.</div>` : null}
      </section>
      ${sel ? html`<${PageView} key=${`${sel}:${tick}`} id=${sel} onChanged=${load} onGone=${() => { setSel(null); load(); }} />` : html`<div class="card wb-detail small muted">Pick a page.</div>`}
    </div>` : html`<div class="card ac-hero"><${Icon} name="globe" size="30" />
        <h2>Bring web pages into your assistant</h2>
        <ul class="ac-list">
          <li><b>From your browser:</b> on any page in Edge, Chrome or Firefox press Ctrl+Alt+B, or click <b>Read my browser</b>. It reads the tab you are looking at, signed in as you are.</li>
          <li><b>Scrape:</b> tables and repeated lists (products, search results, orders, tickets) become rows you can export to Excel. Say what you want, like "every store with its address and status", and the AI builds the table.</li>
          <li><b>Ask and act:</b> ask about a page, summarize it, or send it to the assistant for tasks. Chat can use every saved page.</li>
          <li><b>Watch:</b> have a page read again every hour or day and get told in Chat what changed.</li>
          <li><b>Private:</b> pages stay on this PC. Private windows, banking, sign-in and password pages are never read.</li>
        </ul></div>`}

    <${Privacy} st=${st} save=${save} reload=${load} onCleared=${() => setSel(null)} />
  </div>`;
}
