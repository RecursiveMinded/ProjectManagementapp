// Help center: search the built-in knowledge base, read articles, and export the whole user guide.
import { useState, useMemo, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Menu, useAnchor, toast, toastError } from './lib.js';
import { native, saveAs } from './api.js';
import { TOPICS, ARTICLES } from './help-content.js';

const byId = Object.fromEntries(ARTICLES.map((a) => [a.id, a]));
const topicName = Object.fromEntries(TOPICS);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function inline(s, link) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<kbd>$1</kbd>')
    .replace(/\[\[([a-z0-9-]+)\]\]/g, (_, id) => (byId[id] ? link(id, byId[id].title) : ''));
}

/** Article Markdown to HTML. `link(id, title)` decides how cross-references render. */
export function articleHtml(body, link = (id, t) => `<a data-help="${id}">${esc(t)}</a>`) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of body.trim().split('\n')) {
    const line = raw.trim();
    let m;
    if (!line) { close(); continue; }
    if ((m = line.match(/^## (.+)/))) { close(); out.push(`<h3>${inline(m[1], link)}</h3>`); continue; }
    if ((m = line.match(/^> (.+)/))) { close(); out.push(`<p class="tip">${inline(m[1], link)}</p>`); continue; }
    if ((m = line.match(/^- (.+)/)) || (m = line.match(/^\d+\. (.+)/))) {
      const kind = /^\d/.test(line) ? 'ol' : 'ul';
      if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(m[1], link)}</li>`);
      continue;
    }
    close();
    out.push(`<p>${inline(line, link)}</p>`);
  }
  close();
  return out.join('');
}

const plain = (s) => s.replace(/\*\*|`|\[\[([a-z0-9-]+)\]\]/g, (m, id) => (id ? (byId[id] || {}).title || '' : ''));

/** Rank articles for a query: title words count most, then keywords, then the body. */
export function searchHelp(q) {
  const words = q.toLowerCase().split(/[^a-z0-9+]+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  return ARTICLES.map((a) => {
    const t = a.title.toLowerCase(); const k = a.keys.toLowerCase(); const b = plain(a.body).toLowerCase();
    let score = 0;
    for (const w of words) {
      const s = (t.includes(w) ? 6 : 0) + (k.includes(w) ? 4 : 0) + (b.includes(w) ? 1 : 0);
      if (!s) return null; // every word has to appear somewhere
      score += s;
    }
    return { a, score };
  }).filter(Boolean).sort((x, y) => y.score - x.score).map((x) => x.a);
}

function snippet(a, q) {
  const text = plain(a.body).split('\n').map((l) => l.trim().replace(/^(#+ |- |\d+\. |> )/, '')).filter(Boolean).join(' ').replace(/\s+/g, ' ');
  const w = q.toLowerCase().split(/\s+/).find((x) => x.length > 1 && text.toLowerCase().includes(x));
  const at = w ? Math.max(0, text.toLowerCase().indexOf(w) - 40) : 0;
  return (at ? '…' : '') + text.slice(at, at + 150) + (text.length > at + 150 ? '…' : '');
}

const GUIDE_CSS = `body{font:13.5px/1.6 "Segoe UI",system-ui,sans-serif;color:#1d1c2b;margin:40px 48px}
h1{font-size:30px;margin:0 0 4px}h2{font-size:21px;margin:30px 0 8px;padding-bottom:4px;border-bottom:2px solid #5a55d6;page-break-after:avoid}
h3{font-size:15px;margin:18px 0 4px;page-break-after:avoid}h4{font-size:13px;margin:12px 0 2px;color:#5a55d6}
.m{color:#8a89a3;font-size:12px;margin-bottom:22px}.toc{columns:2;font-size:12.5px}.toc>div{break-inside:avoid}.toc b{display:block;margin-top:8px}
.art{page-break-inside:avoid}kbd{font:12px Consolas,monospace;background:#f1f1f8;border:1px solid #d6d6e3;border-radius:4px;padding:0 4px}
.tip{background:#f3f2ff;border-left:3px solid #5a55d6;padding:6px 12px}a{color:#5a55d6;text-decoration:none}ul,ol{padding-left:22px}`;

/** The whole knowledge base as one printable HTML document. */
export function guideHtml(version) {
  const link = (id, t) => `<a href="#${id}">${esc(t)}</a>`;
  const toc = TOPICS.map(([k, name]) => `<div><b>${esc(name)}</b>${ARTICLES.filter((a) => a.topic === k).map((a) => `<div>${link(a.id, a.title)}</div>`).join('')}</div>`).join('');
  const body = TOPICS.map(([k, name]) => `<h2>${esc(name)}</h2>${ARTICLES.filter((a) => a.topic === k)
    .map((a) => `<div class="art" id="${a.id}"><h3>${esc(a.title)}</h3>${articleHtml(a.body, link).replace(/<h3>/g, '<h4>').replace(/<\/h3>/g, '</h4>')}</div>`).join('')}`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Boardenda user guide</title><style>${GUIDE_CSS}</style></head><body>
<h1>Boardenda user guide</h1><div class="m">${version ? `Version ${esc(version)} · ` : ''}${new Date().toLocaleDateString()}</div>
<h2>Contents</h2><div class="toc">${toc}</div>${body}</body></html>`;
}

/** The whole knowledge base as Markdown. */
export function guideMarkdown(version) {
  const md = (s) => s.trim().replace(/\[\[([a-z0-9-]+)\]\]/g, (_, id) => (byId[id] ? `"${byId[id].title}"` : '')).replace(/^## /gm, '#### ');
  return `# Boardenda user guide\n\n${version ? `Version ${version}. ` : ''}${new Date().toLocaleDateString()}\n\n${TOPICS.map(([k, name]) => `## ${name}\n\n${ARTICLES.filter((a) => a.topic === k).map((a) => `### ${a.title}\n\n${md(a.body)}\n`).join('\n')}`).join('\n')}`;
}

async function appVersion() {
  try { const i = await native('appInfo'); return i && i.version; } catch (_) { return ''; }
}

export async function exportGuide(kind) {
  try {
    const v = await appVersion();
    const name = `Boardenda user guide${v ? ` ${v}` : ''}`;
    if (kind === 'pdf') { await native('savePdf', { name: `${name}.pdf`, html: guideHtml(v) }); return; }
    // Word opens an HTML file saved as .doc, keeping headings, lists and the contents links.
    if (kind === 'word') {
      const doc = guideHtml(v).replace('<html>', '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">');
      const r = await saveAs(`${name}.doc`, doc, [{ name: 'Word document', extensions: ['doc'] }]);
      if (r) toast('User guide saved for Word');
      return;
    }
    if (kind === 'html') { const r = await saveAs(`${name}.html`, guideHtml(v), [{ name: 'Web page', extensions: ['html'] }]); if (r) toast('User guide saved'); return; }
    const r = await saveAs(`${name}.md`, guideMarkdown(v), [{ name: 'Markdown', extensions: ['md'] }]);
    if (r) toast('User guide saved as Markdown');
  } catch (e) { toastError(e); }
}

export function ExportGuideButton({ cls = 'btn' }) {
  const [a, open, close] = useAnchor();
  return html`<span><button class=${cls} onClick=${open}><${Icon} name="download" size="15" /> Export user guide</button>
    ${a ? html`<${Menu} anchor=${a} onClose=${close} align="right" items=${[
      { label: 'PDF', icon: 'print', hint: 'print or send', onClick: () => exportGuide('pdf') },
      { label: 'Word document', icon: 'file', hint: '.doc', onClick: () => exportGuide('word') },
      { label: 'Web page', icon: 'globe', hint: '.html', onClick: () => exportGuide('html') },
      { label: 'Markdown', icon: 'text', hint: '.md', onClick: () => exportGuide('md') },
    ]} />` : null}</span>`;
}

/** Help center page. `id` opens one article; `embedded` drops the page header (used inside Settings). */
export function HelpPage({ id, nav, embedded }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(id && byId[id] ? id : null);
  const [topic, setTopic] = useState(null);
  const body = useRef(null);
  useEffect(() => { if (id && byId[id]) { setOpen(id); setQ(''); } }, [id]);
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [open]);
  const results = useMemo(() => (q.trim() ? searchHelp(q) : null), [q]);
  const art = open && byId[open];
  const go = (aid) => { setOpen(aid); if (nav && !embedded) nav('help', aid); };
  const onClick = (e) => { const l = e.target.closest('[data-help]'); if (l) { e.preventDefault(); go(l.getAttribute('data-help')); } };

  const list = (arts) => html`<div class="help-list">${arts.map((a) => html`<button key=${a.id} class=${`help-row ${open === a.id ? 'on' : ''}`} onClick=${() => go(a.id)}>
    <b>${a.title}</b><span class="small muted">${snippet(a, q)}</span></button>`)}</div>`;

  return html`<div class=${embedded ? 'help help-embedded' : 'page help'}>
    ${embedded ? null : html`<div class="row between mb"><div><h1>Help and user guide</h1><div class="muted small">How to use every part of Boardenda. Press F1 to open this page from anywhere.</div></div><${ExportGuideButton} /></div>`}
    <div class="help-search"><${Icon} name="search" />
      <input class="input" placeholder="Search help, for example “repeat an item” or “import from Word”" value=${q} aria-label="Search help"
        onInput=${(e) => { setQ(e.target.value); setOpen(null); }} onKeyDown=${(e) => { if (e.key === 'Enter' && results && results[0]) go(results[0].id); if (e.key === 'Escape') setQ(''); }} />
      ${embedded ? html`<${ExportGuideButton} cls="btn small" />` : null}</div>
    <div class="help-grid">
      <aside class="help-side">
        ${results ? html`<div class="sect-title">${results.length ? `${results.length} ${results.length === 1 ? 'article' : 'articles'}` : 'Nothing found'}</div>
          ${results.length ? list(results) : html`<div class="small muted pad">Try fewer or different words, or browse the topics.</div>`}`
        : TOPICS.map(([k, name]) => { const on = topic === k || (topic == null && art && art.topic === k); return html`<div key=${k}><button class=${`help-topic ${on ? 'on' : ''}`} onClick=${() => setTopic(on ? '' : k)}>
            <${Icon} name="chev" size="12" cls=${on ? 'rot' : ''} />${name}<span class="faint small">${ARTICLES.filter((a) => a.topic === k).length}</span></button>
            ${on ? list(ARTICLES.filter((a) => a.topic === k)) : null}</div>`; })}
      </aside>
      <article class="help-art card" ref=${body} onClick=${onClick}>
        ${art ? html`<div class="small faint">${topicName[art.topic]}</div><h2>${art.title}</h2><div class="help-body" dangerouslySetInnerHTML=${{ __html: articleHtml(art.body) }}></div>
          <div class="help-more small muted">Related: ${ARTICLES.filter((a) => a.topic === art.topic && a.id !== art.id).slice(0, 4).map((a, i) => html`${i ? ' · ' : ''}<a key=${a.id} onClick=${() => go(a.id)}>${a.title}</a>`)}</div>`
        : html`<h2>Welcome to the help center</h2><p class="muted">Search above, or pick a topic on the left. Popular articles:</p>
          <div class="help-pop">${['first-board', 'quick-capture', 'import', 'calls', 'automations', 'views', 'formulas', 'backups'].map((k) => html`<button key=${k} class="help-card" onClick=${() => go(k)}><b>${byId[k].title}</b><span class="small muted">${topicName[byId[k].topic]}</span></button>`)}</div>
          <p class="small muted mt">Need it on paper or to share with your team? Use <b>Export user guide</b> for a PDF, Word or Markdown copy of every article.</p>`}
      </article>
    </div>
  </div>`;
}
