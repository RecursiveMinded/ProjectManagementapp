'use strict';
// Reading a web page into plain data: its text, tables, repeated lists (product
// cards, search results, rows built from <div>s) and links.
//
// READER_JS runs inside the page (the built-in browser, or a hidden window that
// loads a link) and uses the real, rendered DOM. fromHtml() is the fallback
// for raw HTML in Node (the dev server and tests), with no rendering.

const MAX_TEXT = 250000;

// Runs in the page. Keep it self-contained: no outside names.
function readPage() {
  const MAX_TEXT = 250000;
  const MAX_ROWS = 5000;
  const clean = (s) => String(s || '').replace(/ /g, ' ').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const one = (el) => clean(el.innerText || el.textContent || '').replace(/\s*\n\s*/g, ' ').slice(0, 2000);
  const shown = (el) => {
    try { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0; } catch (_) { return true; }
  };
  const meta = (n) => { const m = document.querySelector(`meta[name="${n}"],meta[property="${n}"]`); return m ? String(m.content || '').trim() : ''; };
  const near = (el) => {
    const cap = el.querySelector && el.querySelector(':scope > caption');
    if (cap) return one(cap);
    let p = el;
    for (let i = 0; i < 6 && p; i++) {
      let s = p.previousElementSibling;
      for (let j = 0; j < 4 && s; j++) { if (/^H[1-6]$/.test(s.tagName) || s.getAttribute('role') === 'heading') return one(s).slice(0, 120); const h = s.querySelector && s.querySelector('h1,h2,h3,h4'); if (h) return one(h).slice(0, 120); s = s.previousElementSibling; }
      p = p.parentElement;
    }
    return el.getAttribute && (el.getAttribute('aria-label') || '');
  };
  const square = (rows) => {
    const w = Math.min(60, Math.max(0, ...rows.map((r) => r.length)));
    return rows.map((r) => { const x = r.slice(0, w); while (x.length < w) x.push(''); return x; });
  };
  const tables = [];
  const used = new Set();
  // Real <table>s (layout tables that only wrap other tables are skipped).
  for (const t of document.querySelectorAll('table')) {
    if (tables.length >= 25) break;
    if (t.querySelector('table') || !shown(t)) continue;
    let head = null;
    const rows = [];
    for (const tr of t.rows) {
      if (rows.length >= MAX_ROWS) break;
      const cells = [];
      for (const c of tr.cells) { cells.push(one(c)); for (let k = 1; k < Math.min(20, c.colSpan || 1); k++) cells.push(''); }
      if (!cells.some(Boolean)) continue;
      const isHead = !head && !rows.length && (tr.parentElement.tagName === 'THEAD' || [...tr.cells].every((c) => c.tagName === 'TH'));
      if (isHead) head = cells; else rows.push(cells);
    }
    if (!head && rows.length > 2 && rows[0].every((c) => c && c.length < 60) && !rows[0].some((c) => /^[\d$€£.,% -]+$/.test(c))) head = rows.shift();
    const all = square(head ? [head, ...rows] : rows);
    if (all.length - (head ? 1 : 0) < 1 || (all[0] || []).length < 2 || all.length < 2) continue;
    used.add(t);
    tables.push({ caption: near(t), headers: head ? all[0] : all[0].map((_, i) => `Column ${i + 1}`), rows: head ? all.slice(1) : all, kind: 'table' });
  }
  // ARIA grids: most web apps (CRMs, portals, dashboards) build tables from <div>s.
  for (const g of document.querySelectorAll('[role=grid],[role=table],[role=treegrid]')) {
    if (tables.length >= 25) break;
    if (g.tagName === 'TABLE' || !shown(g)) continue;
    let head = null;
    const rows = [];
    for (const r of g.querySelectorAll('[role=row]')) {
      if (rows.length >= MAX_ROWS) break;
      const cs = [...r.querySelectorAll('[role=columnheader],[role=gridcell],[role=cell],[role=rowheader]')].filter((c) => c.closest('[role=row]') === r);
      if (!cs.length) continue;
      const vals = cs.map(one);
      if (!head && !rows.length && cs.every((c) => c.getAttribute('role') === 'columnheader')) head = vals; else if (vals.some(Boolean)) rows.push(vals);
    }
    const all = square(head ? [head, ...rows] : rows);
    if (!rows.length || (all[0] || []).length < 2) continue;
    used.add(g);
    tables.push({ caption: near(g), headers: head ? all[0] : all[0].map((_, i) => `Column ${i + 1}`), rows: head ? all.slice(1) : all, kind: 'grid' });
  }
  // Repeated blocks with the same shape (cards, results, feed items) become a list table.
  const sig = (el) => `${el.tagName}.${[...el.classList].filter((c) => !/\d{3,}|active|selected|first|last|odd|even|hover/i.test(c)).sort().join('.')}`;
  const groups = [];
  for (const p of document.querySelectorAll('ul,ol,div,section,main,tbody,[role=list],[role=feed]')) {
    if (p.closest('table') || p.closest('nav,header,footer,[role=navigation]')) continue;
    const kids = [...p.children];
    if (kids.length < 4) continue;
    const by = {};
    for (const k of kids) { const s = sig(k); (by[s] = by[s] || []).push(k); }
    const best = Object.values(by).sort((a, b) => b.length - a.length)[0];
    if (!best || best.length < 4 || best.length < kids.length * 0.6) continue;
    const items = best.filter(shown).slice(0, MAX_ROWS);
    const lines = items.map((k) => clean(k.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 15));
    const filled = lines.filter((l) => l.length);
    if (filled.length < 4) continue;
    const avg = filled.reduce((s, l) => s + l.length, 0) / filled.length;
    const chars = filled.reduce((s, l) => s + l.join(' ').length, 0) / filled.length;
    if (chars < 8) continue;
    groups.push({ p, items, lines, score: filled.length * Math.min(6, avg) * (chars > 20 ? 1.5 : 1) });
  }
  groups.sort((a, b) => b.score - a.score);
  const lists = [];
  for (const g of groups) {
    if (lists.length >= 8) break;
    if (lists.some((x) => x.p.contains(g.p) || g.p.contains(x.p))) continue;
    const width = Math.min(12, Math.max(...g.lines.map((l) => l.length)));
    const rows = g.items.map((k, i) => {
      const r = g.lines[i].slice(0, width);
      while (r.length < width) r.push('');
      const a = k.tagName === 'A' ? k : k.querySelector('a[href]');
      r.push(a && a.href && !/^javascript:/i.test(a.href) ? a.href : '');
      return r;
    }).filter((r) => r.some(Boolean));
    const hasLink = rows.some((r) => r[r.length - 1]);
    const headers = [...Array(width)].map((_, i) => (i === 0 ? 'Item' : `Detail ${i}`));
    lists.push({ p: g.p, caption: near(g.p), headers: hasLink ? [...headers, 'Link'] : headers, rows: hasLink ? rows : rows.map((r) => r.slice(0, -1)), kind: 'list' });
  }
  // Main text: the article or main region when there is one, else the whole page.
  const body = document.body;
  const bodyText = body ? clean(body.innerText || '') : '';
  let text = bodyText;
  const mains = [...document.querySelectorAll('article,main,[role=main]')].map((el) => clean(el.innerText || '')).sort((a, b) => b.length - a.length);
  if (mains[0] && mains[0].length > bodyText.length * 0.35) text = mains[0];
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter(shown).map(one).filter(Boolean).slice(0, 60);
  const seen = new Set();
  const links = [];
  for (const a of document.querySelectorAll('a[href]')) {
    if (links.length >= 400) break;
    const href = a.href;
    const t = one(a).slice(0, 160);
    if (!t || !/^https?:/i.test(href) || seen.has(href)) continue;
    seen.add(href);
    links.push({ text: t, href });
  }
  let selection = '';
  try { selection = clean(String(window.getSelection() || '')).slice(0, 20000); } catch (_) { /* none */ }
  return {
    url: location.href,
    title: document.title || headings[0] || location.hostname,
    text: text.slice(0, MAX_TEXT),
    headings,
    tables: tables.map((t) => ({ caption: t.caption, headers: t.headers, rows: t.rows, kind: t.kind })),
    lists: lists.map((t) => ({ caption: t.caption, headers: t.headers, rows: t.rows, kind: t.kind })),
    links,
    selection,
    meta: { description: meta('description') || meta('og:description'), site: meta('og:site_name'), author: meta('author'), published: meta('article:published_time') || meta('date'), lang: document.documentElement.lang || '' },
  };
}

/** The script to run in a page; it evaluates to the page's data. */
const READER_JS = `(${readPage.toString()})()`;

// ------------------------------------------------------------------ Node side
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£' };
function decode(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m;
  });
}
const tidy = (s) => String(s || '').replace(/ /g, ' ').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const inline = (h) => tidy(decode(String(h || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))).replace(/\s*\n\s*/g, ' ');
function blockText(h) {
  return tidy(decode(String(h || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol|dd|dt)>/gi, '\n')
    .replace(/<(td|th)[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')));
}

/** Data from raw HTML, without running it: title, text, tables, links. */
function fromHtml(html, url = '') {
  let h = String(html || '');
  const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? decode(m[2] || m[3] || m[4] || '') : ''; };
  const meta = (n) => { const re = /<meta\b[^>]*>/gi; let m; while ((m = re.exec(h))) { if ([attr(m[0], 'name'), attr(m[0], 'property')].some((x) => x.toLowerCase() === n)) return attr(m[0], 'content').trim(); } return ''; };
  const title = inline((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const description = meta('description') || meta('og:description');
  const site = meta('og:site_name');
  h = h.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<head\b[\s\S]*?<\/head>/i, ' ');
  const abs = (href) => { try { return new URL(decode(href), url || undefined).href; } catch (_) { return ''; } };
  const tables = [];
  const tre = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tm;
  while ((tm = tre.exec(h)) && tables.length < 25) {
    const inner = tm[1];
    if (/<table\b/i.test(inner)) continue;
    let head = null;
    const rows = [];
    const caption = inline((inner.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i) || [])[1] || '');
    const rre = /<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/tbody>|<\/thead>|<\/tfoot>|$)/gi;
    let rm;
    while ((rm = rre.exec(inner)) && rows.length < 5000) {
      const cells = [];
      let allTh = true;
      const cre = /<(td|th)\b([^>]*)>([\s\S]*?)(?=<td\b|<th\b|<\/tr>|$)/gi;
      let cm;
      while ((cm = cre.exec(rm[1]))) {
        if (cm[1].toLowerCase() !== 'th') allTh = false;
        cells.push(inline(cm[3].replace(/<\/t[dh]>[\s\S]*$/i, '')));
        const span = Math.min(20, Number(attr(`<x ${cm[2]}>`, 'colspan')) || 1);
        for (let k = 1; k < span; k++) cells.push('');
      }
      if (!cells.some(Boolean)) continue;
      if (!head && !rows.length && allTh) head = cells; else rows.push(cells);
    }
    const w = Math.min(60, Math.max(0, ...(head ? [head, ...rows] : rows).map((r) => r.length)));
    const sq = (r) => { const x = r.slice(0, w); while (x.length < w) x.push(''); return x; };
    if (w < 2 || !rows.length || (!head && rows.length < 2)) continue;
    tables.push({ caption, headers: head ? sq(head) : sq(rows[0]).map((_, i) => `Column ${i + 1}`), rows: rows.map(sq), kind: 'table' });
  }
  // Lists: <ul>/<ol> with four or more items outside navigation.
  const lists = [];
  const body = h.replace(/<(nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ');
  const lre = /<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let lm;
  while ((lm = lre.exec(body)) && lists.length < 8) {
    const items = [...lm[2].matchAll(/<li\b[^>]*>([\s\S]*?)(?=<li\b|$)/gi)].map((x) => x[1]);
    if (items.length < 4) continue;
    const rows = items.map((it) => { const a = it.match(/<a\b[^>]*href\s*=\s*["']?([^"'\s>]+)/i); return [inline(it), a ? abs(a[1]) : '']; }).filter((r) => r[0]);
    if (rows.length < 4) continue;
    const hasLink = rows.some((r) => r[1]);
    lists.push({ caption: '', headers: hasLink ? ['Item', 'Link'] : ['Item'], rows: hasLink ? rows : rows.map((r) => [r[0]]), kind: 'list' });
  }
  const mainHtml = (body.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i) || [])[2];
  const all = blockText((body.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [])[1] || body);
  const main = mainHtml ? blockText(mainHtml) : '';
  const text = main && main.length > all.length * 0.35 ? main : all;
  const headings = [...h.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => inline(m[2])).filter(Boolean).slice(0, 60);
  const links = [];
  const seen = new Set();
  for (const m of h.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= 400) break;
    const href = abs(attr(`<a ${m[1]}>`, 'href'));
    const t = inline(m[2]).slice(0, 160);
    if (!t || !/^https?:/i.test(href) || seen.has(href)) continue;
    seen.add(href);
    links.push({ text: t, href });
  }
  return { url, title: title || headings[0] || '', text: text.slice(0, MAX_TEXT), headings, tables, lists, links, selection: '', meta: { description, site, author: meta('author'), published: meta('article:published_time'), lang: '' } };
}

module.exports = { READER_JS, readPage, fromHtml, decode };
