// Reports: executive summaries, weekly progress, status overviews, customer
// reports and detailed status, with snapshots, a written summary and export.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Spinner, toast, toastError, useAnchor, Menu, Select, usePersist, relTime, ask as confirm, saveFileName } from './lib.js';
import { call, native, saveAs, isDesktop } from './api.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const KIND_ICON = { executive: 'report', weekly: 'calendar', overview: 'chart', customer: 'building', detail: 'list' };
const TONE = { bad: 'var(--bad)', warn: '#d38a00', good: 'var(--good, #1f9d6b)', off_track: 'var(--bad)', at_risk: '#d38a00', on_track: 'var(--good, #1f9d6b)', done: 'var(--brand)' };

export const REPORT_CSS = `
.rpt { color: var(--text); font-size: 13px; line-height: 1.45; }
.rpt h1 { font-size: 22px; margin: 0 0 2px; }
.rpt .rpt-meta { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
.rpt h2 { font-size: 15px; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
.rpt h2 .sub { font-weight: 400; color: var(--muted); font-size: 12px; margin-left: 8px; }
.rpt .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 8px; }
.rpt .kpi { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--panel); break-inside: avoid; }
.rpt .kpi .v { font-size: 24px; font-weight: 700; line-height: 1.1; }
.rpt .kpi .l { color: var(--muted); font-size: 12px; }
.rpt .kpi .d { font-size: 11px; color: var(--muted); margin-top: 2px; }
.rpt .summary { border-left: 3px solid var(--brand); padding: 8px 14px; background: var(--panel); border-radius: 0 8px 8px 0; white-space: pre-wrap; }
.rpt ul.hl { margin: 0; padding-left: 18px; } .rpt ul.hl li { margin: 3px 0; }
.rpt table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.rpt th { text-align: left; color: var(--muted); font-weight: 600; font-size: 11.5px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
.rpt td { padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.rpt tr { break-inside: avoid; }
.rpt td.num, .rpt th.num { text-align: right; }
.rpt .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; color: #fff; font-size: 11.5px; white-space: nowrap; }
.rpt .bar { position: relative; height: 8px; border-radius: 4px; background: var(--line); min-width: 60px; }
.rpt .bar > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; background: var(--brand); }
.rpt .prog { display: flex; align-items: center; gap: 6px; } .rpt .prog .bar { flex: 1; }
.rpt .lst { margin: 0; padding: 0; list-style: none; }
.rpt .lst li { padding: 6px 0 6px 12px; border-bottom: 1px solid var(--line); border-left: 3px solid transparent; break-inside: avoid; }
.rpt .lst li .s { color: var(--muted); font-size: 12px; }
.rpt .stack { display: flex; height: 14px; border-radius: 4px; overflow: hidden; background: var(--line); }
.rpt .stack > i { display: block; height: 100%; }
.rpt .brow { display: grid; grid-template-columns: minmax(120px, 220px) 1fr; gap: 10px; align-items: center; padding: 5px 0; }
.rpt .rlg { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11.5px; color: var(--muted); margin-top: 2px; }
.rpt .rlg b { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.rpt .empty-note { color: var(--muted); font-style: italic; }
.rpt .more { color: var(--muted); font-size: 12px; margin-top: 4px; }
.rpt a[data-go] { color: inherit; text-decoration: none; border-bottom: 1px dotted var(--muted); cursor: pointer; }
`;
const PRINT_VARS = ':root{--text:#1c1b2b;--muted:#6b6a80;--line:#e3e3ec;--panel:#f7f7fb;--brand:#5b4ee6;--bad:#d64545;--good:#1f9d6b}body{font-family:Segoe UI,Arial,sans-serif;margin:28px;background:#fff}@page{margin:14mm}.rpt a[data-go]{border:0}';

function cellHtml(v, col) {
  if (col.kind === 'progress') { const p = Number(v) || 0; return `<div class="prog"><div class="bar"><i style="width:${p}%"></i></div><span>${p}%</span></div>`; }
  if (v == null || v === '') return '';
  if (typeof v !== 'object') return esc(v);
  const go = v.itemId ? `data-go="item" data-id="${esc(v.itemId)}"` : v.boardId ? `data-go="board" data-id="${esc(v.boardId)}"` : v.customerId ? `data-go="customer" data-id="${esc(v.customerId)}"` : v.meetingId ? `data-go="meeting" data-id="${esc(v.meetingId)}"` : '';
  let inner = esc(v.text);
  if (col.kind === 'status' && v.color && v.text !== '—') inner = `<span class="pill" style="background:${esc(v.color)}">${inner}</span>`;
  else if (col.kind === 'health' && v.tone) inner = `<span class="pill" style="background:${TONE[v.tone] || 'var(--muted)'}">${inner}</span>`;
  else if (v.tone) inner = `<span style="color:${TONE[v.tone]}">${inner}</span>`;
  return go ? `<a ${go}>${inner}</a>` : inner;
}

function kpiDelta(k, compare) {
  const bits = [];
  if (k.sub) bits.push(esc(k.sub));
  if (k.prev !== undefined && typeof k.value === 'number') {
    const d = k.value - k.prev;
    bits.push(d === 0 ? 'same as previous period' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} vs previous period`);
  }
  if (compare && compare.kpis[k.label] !== undefined && compare.kpis[k.label] !== k.value) bits.push(`was ${esc(compare.kpis[k.label])} at last snapshot`);
  return bits.join(' · ');
}

/** The report as an HTML fragment (screen and export share it). */
export function reportBody(r, { summary = '', note = '' } = {}) {
  if (!r || !r.kpis) return '';
  const out = [];
  out.push(`<h1>${esc(r.title)}</h1><div class="rpt-meta">${esc(r.scopeLabel)}${r.person ? ` · items owned by ${esc(r.person)}` : ''} · ${esc(r.period.label)} · prepared ${esc(new Date(r.generatedAt).toLocaleString())}${r.compare ? ` · compared with snapshot of ${esc(new Date(r.compare.at).toLocaleDateString())}` : ''}</div>`);
  if (note) out.push(`<div class="rpt-meta"><b>Note:</b> ${esc(note)}</div>`);
  if (summary) out.push(`<h2>Summary</h2><div class="summary">${esc(summary)}</div>`);
  out.push(`<div class="kpis" style="margin-top:14px">${r.kpis.map((k) => `<div class="kpi"><div class="v" style="${k.tone ? `color:${TONE[k.tone]}` : ''}">${esc(k.value)}</div><div class="l">${esc(k.label)}</div><div class="d">${kpiDelta(k, r.compare)}</div></div>`).join('')}</div>`);
  for (const s of r.sections) {
    const go = s.boardId ? ` data-go="board" data-id="${esc(s.boardId)}"` : s.customerId ? ` data-go="customer" data-id="${esc(s.customerId)}"` : '';
    out.push(`<h2>${go ? `<a${go}>${esc(s.title)}</a>` : esc(s.title)}${s.sub ? `<span class="sub">${esc(s.sub)}</span>` : ''}</h2>`);
    if (s.type === 'text') out.push(`<ul class="hl">${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`);
    if (s.type === 'list') {
      if (!s.items.length) out.push(`<div class="empty-note">${esc(s.empty || 'Nothing to show.')}</div>`);
      else out.push(`<ul class="lst">${s.items.map((i) => { const v = { text: i.text, itemId: i.itemId, boardId: i.boardId, meetingId: i.meetingId }; return `<li style="${i.tone ? `border-left-color:${TONE[i.tone]}` : ''}">${cellHtml(v, {})}${i.sub ? `<div class="s">${esc(i.sub)}</div>` : ''}</li>`; }).join('')}</ul>`);
    }
    if (s.type === 'table') {
      if (!s.rows.length) out.push(`<div class="empty-note">${esc(s.empty || 'Nothing to show.')}</div>`);
      else out.push(`<table><thead><tr>${s.columns.map((c) => `<th class="${c.kind === 'num' ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${s.rows.map((row) => `<tr>${s.columns.map((c) => `<td class="${c.kind === 'num' ? 'num' : ''}">${cellHtml(row[c.key], c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    }
    if (s.type === 'bars') {
      out.push(s.bars.map((b) => { const tot = b.parts.reduce((a, p) => a + p.value, 0) || 1; return `<div class="brow"><div><a data-go="board" data-id="${esc(b.boardId)}"><b>${esc(b.label)}</b></a><div class="rlg">${esc(b.sub || '')}</div></div><div><div class="stack">${b.parts.map((p) => `<i title="${esc(p.label)}: ${p.value}" style="width:${(p.value / tot) * 100}%;background:${esc(p.color)}"></i>`).join('')}</div><div class="rlg">${b.parts.map((p) => `<span><b style="background:${esc(p.color)}"></b>${esc(p.label)} ${p.value}</span>`).join('')}</div></div></div>`; }).join(''));
    }
    if (s.more) out.push(`<div class="more">and ${s.more} more</div>`);
  }
  return out.join('');
}

export function reportHtml(r, extra) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.title)}</title><style>${PRINT_VARS}${REPORT_CSS}</style></head><body><div class="rpt">${reportBody(r, extra)}</div></body></html>`;
}

export function reportMarkdown(r, { summary = '', note = '' } = {}) {
  const cell = (v, c) => (c.kind === 'progress' ? `${v}%` : v && typeof v === 'object' ? v.text : v == null ? '' : String(v)).replace(/\|/g, '\\|');
  const out = [`# ${r.title}`, '', `${r.scopeLabel}${r.person ? ` · items owned by ${r.person}` : ''} · ${r.period.label} · prepared ${new Date(r.generatedAt).toLocaleString()}`, ''];
  if (note) out.push(`**Note:** ${note}`, '');
  if (summary) out.push('## Summary', '', summary, '');
  out.push('| Measure | Value |', '| --- | --- |', ...r.kpis.map((k) => `| ${k.label} | ${k.value}${k.prev !== undefined ? ` (previous ${k.prev})` : ''} |`), '');
  for (const s of r.sections) {
    out.push(`## ${s.title}`, '');
    if (s.sub) out.push(`_${s.sub}_`, '');
    if (s.type === 'text') out.push(...s.lines.map((l) => `- ${l}`));
    if (s.type === 'list') out.push(...(s.items.length ? s.items.map((i) => `- **${i.text}**${i.sub ? ` — ${i.sub}` : ''}`) : [`_${s.empty || 'Nothing to show.'}_`]));
    if (s.type === 'table') {
      if (!s.rows.length) out.push(`_${s.empty || 'Nothing to show.'}_`);
      else out.push(`| ${s.columns.map((c) => c.label).join(' | ')} |`, `| ${s.columns.map(() => '---').join(' | ')} |`, ...s.rows.map((row) => `| ${s.columns.map((c) => cell(row[c.key], c)).join(' | ')} |`));
    }
    if (s.type === 'bars') out.push(...s.bars.map((b) => `- **${b.label}** (${b.sub}): ${b.parts.map((p) => `${p.label} ${p.value}`).join(', ')}`));
    if (s.more) out.push('', `_and ${s.more} more_`);
    out.push('');
  }
  return out.join('\n');
}

async function exportReport(kind, r, extra) {
  try {
    const name = saveFileName(`${r.title} ${r.period.from} to ${r.period.to}`);
    if (kind === 'pdf') { await native('savePdf', { name: `${name}.pdf`, html: reportHtml(r, extra) }); return; }
    if (kind === 'word') {
      const doc = reportHtml(r, extra).replace('<html>', '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">');
      if (await saveAs(`${name}.doc`, doc, [{ name: 'Word document', extensions: ['doc'] }])) toast('Report saved for Word');
      return;
    }
    if (kind === 'html') { if (await saveAs(`${name}.html`, reportHtml(r, extra), [{ name: 'Web page', extensions: ['html'] }])) toast('Report saved'); return; }
    if (kind === 'copy') { await navigator.clipboard.writeText(reportMarkdown(r, extra)); toast('Report copied. Paste it into an email or document.'); return; }
    if (await saveAs(`${name}.md`, reportMarkdown(r, extra), [{ name: 'Markdown', extensions: ['md'] }])) toast('Report saved as Markdown');
  } catch (e) { toastError(e); }
}

function ExportButton({ report, extra }) {
  const [a, open, close] = useAnchor();
  return html`<span><button class="btn" onClick=${open}><${Icon} name="download" size="15" /> Export</button>
    ${a ? html`<${Menu} anchor=${a} onClose=${close} align="right" items=${[
      { label: 'PDF', icon: 'print', hint: 'print or email', onClick: () => exportReport('pdf', report, extra) },
      { label: 'Word document', icon: 'file', hint: '.doc', onClick: () => exportReport('word', report, extra) },
      { label: 'Web page', icon: 'globe', hint: '.html', onClick: () => exportReport('html', report, extra) },
      { label: 'Markdown', icon: 'text', hint: '.md', onClick: () => exportReport('md', report, extra) },
      { label: 'Copy as text', icon: 'copy', hint: 'for email', onClick: () => exportReport('copy', report, extra) },
    ]} />` : null}</span>`;
}

/** The rendered report; links open items, boards, customers and calls. */
function ReportView({ report, summary, note, nav }) {
  const onClick = (e) => {
    const a = e.target.closest('[data-go]');
    if (!a) return;
    const id = a.getAttribute('data-id');
    const go = a.getAttribute('data-go');
    if (go === 'item') window.dispatchEvent(new CustomEvent('bd-open-item', { detail: id }));
    else if (go === 'board') nav('board', id);
    else if (go === 'customer') window.dispatchEvent(new CustomEvent('bd-open-customer', { detail: id }));
    else if (go === 'meeting') window.dispatchEvent(new CustomEvent('bd-open-meeting', { detail: id }));
  };
  return html`<div class="rpt-paper"><div class="rpt" onClick=${onClick} dangerouslySetInnerHTML=${{ __html: reportBody(report, { summary, note }) }}></div></div>`;
}

function SummaryBox({ report, summary, setSummary }) {
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const write = async () => {
    setBusy(true); setInfo('');
    try {
      const r = await call('reportSummary', { report });
      setSummary(r.text);
      setInfo(r.note || (r.mode === 'local' ? `Written by ${r.model} on this PC. Edit it before you share.` : r.mode === 'claude' ? `Written by Claude (${r.model}). Edit it before you share.` : ''));
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return html`<div class="card pad rpt-summary-edit">
    <div class="row between"><b>Written summary</b>
      <button class="btn small" disabled=${busy} onClick=${write}>${busy ? html`<${Spinner} />` : html`<${Icon} name="spark" size="14" />`} ${summary ? 'Write again' : 'Write summary'}</button></div>
    ${busy ? html`<div class="small muted mt">Writing… local models can take up to a minute.</div>` : null}
    ${summary || busy ? null : html`<div class="small muted mt">Optional. The AI in Settings › AI drafts a short summary from this report; you can edit it. It appears at the top of the report and in exports.</div>`}
    ${summary ? html`<textarea class="input mt" rows="6" value=${summary} onInput=${(e) => setSummary(e.target.value)}></textarea>` : null}
    ${info ? html`<div class="small faint mt">${info}</div>` : null}
  </div>`;
}

function Builder({ nav, opts, onSaved }) {
  const [kind, setKind] = usePersist('rpt.kind', 'executive');
  const [scope, setScope] = usePersist('rpt.scope', 'all');
  const [preset, setPreset] = usePersist('rpt.period', 'this_week');
  const [person, setPerson] = usePersist('rpt.person', '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState('');
  const seq = useRef(0);
  const scopeOk = opts.scopes.some((s) => s.key === scope) ? scope : 'all';
  const period = preset === 'custom' ? (from && to ? { from, to } : { preset: 'this_week' }) : { preset };
  const run = async () => {
    const n = ++seq.current;
    setBusy(true);
    try {
      const r = await call('buildReport', { kind, scope: scopeOk, period, personId: person || null });
      if (n === seq.current) { setReport(r); setSummary(''); }
    } catch (e) { toastError(e); } finally { if (n === seq.current) setBusy(false); }
  };
  useEffect(() => { run(); }, [kind, scopeOk, preset, from, to, person]);
  const save = async () => {
    try {
      const s = await call('saveReportSnapshot', { report, summary });
      toast(`Snapshot saved: ${s.title}`);
      onSaved && onSaved();
      run();
    } catch (e) { toastError(e); }
  };
  return html`<div class="rpt-layout">
    <div class="rpt-kinds">${opts.kinds.map((k) => html`<button key=${k.id} class=${`rpt-kind ${kind === k.id ? 'on' : ''}`} onClick=${() => setKind(k.id)}>
      <${Icon} name=${KIND_ICON[k.id] || 'report'} /><span><b>${k.title}</b><span class="small muted">${k.blurb}</span></span></button>`)}</div>
    <div class="rpt-main">
      <div class="rpt-controls">
        <label class="small muted">Boards <${Select} cls="input" value=${scopeOk} onChange=${setScope} options=${opts.scopes.map((s) => ({ value: s.key, label: s.label }))} /></label>
        <label class="small muted">Period <${Select} cls="input" value=${preset} onChange=${setPreset} options=${opts.periods.map((p) => ({ value: p.id, label: p.label }))} /></label>
        ${preset === 'custom' ? html`<label class="small muted">From <input class="input" type="date" value=${from} onInput=${(e) => setFrom(e.target.value)} /></label>
          <label class="small muted">To <input class="input" type="date" value=${to} onInput=${(e) => setTo(e.target.value)} /></label>` : null}
        <label class="small muted">People <${Select} cls="input" value=${person} onChange=${setPerson} options=${[{ value: '', label: 'Everyone' }, ...opts.people.map((p) => ({ value: p.id, label: `Only ${p.name}` }))]} /></label>
        <span class="grow"></span>
        ${busy ? html`<${Spinner} />` : null}
        <button class="btn" disabled=${!report} onClick=${save} title="Save a frozen copy of this report to compare with later"><${Icon} name="history" size="15" /> Save snapshot</button>
        ${report ? html`<${ExportButton} report=${report} extra=${{ summary }} />` : null}
      </div>
      ${report ? html`<${SummaryBox} report=${report} summary=${summary} setSummary=${setSummary} />` : null}
      ${report ? html`<${ReportView} report=${report} summary=${summary} nav=${nav} />` : html`<div class="card pad"><${Spinner} /></div>`}
    </div>
  </div>`;
}

function Trend({ points }) {
  if (points.length < 2) return null;
  const keys = ['Completed', 'New items', 'Overdue', 'Hours logged'].filter((k) => points.some((p) => typeof p.kpis[k] === 'number'));
  return html`<div class="card pad mb"><b>Weekly trend</b><span class="small muted"> from weekly progress snapshots of all boards</span>
    <div class="rpt-trend">${keys.map((k) => {
      const max = Math.max(1, ...points.map((p) => Number(p.kpis[k]) || 0));
      return html`<div key=${k}><div class="small muted">${k}</div><div class="rpt-spark">${points.slice(-12).map((p) => html`<i key=${p.from} title=${`Week of ${p.from}: ${p.kpis[k] ?? 0}`} style=${`height:${Math.max(2, ((Number(p.kpis[k]) || 0) / max) * 100)}%;${k === 'Overdue' ? 'background:var(--bad)' : ''}`}></i>`)}</div>
        <div class="small"><b>${points[points.length - 1].kpis[k] ?? 0}</b> <span class="muted">latest week</span></div></div>`;
    })}</div></div>`;
}

function Snapshots({ nav, opts, bump }) {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  const [trend, setTrend] = useState([]);
  const [cfg, setCfg] = useState(opts.config);
  const load = () => { call('reportSnapshots').then(setList, toastError); call('reportTrend', { kind: 'weekly', scope: 'all' }).then(setTrend, () => {}); };
  useEffect(load, [bump]);
  const show = (id) => call('reportSnapshot', id).then(setOpen, toastError);
  const del = async (s) => { if (await confirm({ title: `Delete snapshot "${s.title}"?`, ok: 'Delete' })) { await call('deleteReportSnapshot', s.id).catch(toastError); if (open && open.id === s.id) setOpen(null); load(); } };
  if (open) {
    const saveEdits = (patch) => call('updateReportSnapshot', open.id, patch).then((s) => setOpen(s), toastError);
    return html`<div>
      <div class="row mb" style="gap:8px"><button class="btn ghost" onClick=${() => { setOpen(null); load(); }}><${Icon} name="arrowLeft" size="15" /> All snapshots</button>
        <span class="small muted">Saved ${new Date(open.createdAt).toLocaleString()}${open.auto ? ' automatically' : ''}. This is a frozen copy; it does not change when boards change.</span><span class="grow"></span>
        <${ExportButton} report=${open.report} extra=${{ summary: open.summary, note: open.note }} /></div>
      <div class="card pad mb"><label class="small muted">Note on this snapshot</label>
        <input class="input" placeholder="For example: sent to the board on Monday" value=${open.note} onChange=${(e) => saveEdits({ note: e.target.value })} /></div>
      <${ReportView} report=${open.report} summary=${open.summary} note=${open.note} nav=${nav} /></div>`;
  }
  return html`<div>
    <${Trend} points=${trend} />
    <div class="row mb" style="gap:10px"><label class="check small"><input type="checkbox" checked=${cfg.autoWeekly} onChange=${(e) => call('setReportOptions', { autoWeekly: e.target.checked }).then(setCfg, toastError)} />
      Save a weekly progress snapshot of all boards every Monday, and tell me in the Inbox</label></div>
    ${!list ? html`<${Spinner} />` : !list.length ? html`<div class="card pad muted">No snapshots yet. Build a report and click <b>Save snapshot</b> to keep a frozen copy you can compare with later.</div>`
      : html`<div class="rpt-snaps">${list.map((s) => html`<div key=${s.id} class="rpt-snap card" role="button" tabindex="0" onClick=${() => show(s.id)}>
        <${Icon} name=${KIND_ICON[s.kind] || 'report'} />
        <div class="grow" style="min-width:0"><b class="clip">${s.title}</b><div class="small muted clip">${s.scopeLabel}${s.person ? ` · ${s.person}` : ''} · saved ${relTime(s.createdAt)}${s.auto ? ' · automatic' : ''}${s.hasSummary ? ' · with summary' : ''}${s.note ? ` · ${s.note}` : ''}</div>
          <div class="rpt-chips">${s.kpis.map((k) => html`<span key=${k.label} class="chip">${k.label}: <b>${k.value}</b></span>`)}</div></div>
        <button class="btn ghost small" title="Delete snapshot" aria-label="Delete snapshot" onClick=${(e) => { e.stopPropagation(); del(s); }}><${Icon} name="trash" size="14" /></button></div>`)}</div>`}
  </div>`;
}

export function ReportsPage({ nav, version }) {
  const [tab, setTab] = usePersist('rpt.tab', 'build');
  const [opts, setOpts] = useState(null);
  const [bump, setBump] = useState(0);
  useEffect(() => { call('reportOptions').then(setOpts, toastError); }, [version]);
  return html`<div class="page rpt-page">
    <style>${REPORT_CSS}</style>
    <div class="page-head"><h1>Reports</h1><span class="muted small">Executive summaries, weekly progress and status snapshots from your boards, customers and calls</span></div>
    <div class="tabs mb"><button class=${`tab ${tab === 'build' ? 'on' : ''}`} onClick=${() => setTab('build')}>Build a report</button>
      <button class=${`tab ${tab === 'snaps' ? 'on' : ''}`} onClick=${() => setTab('snaps')}>Snapshots</button></div>
    ${!opts ? html`<${Spinner} />` : tab === 'snaps' ? html`<${Snapshots} nav=${nav} opts=${opts} bump=${bump} />` : html`<${Builder} nav=${nav} opts=${opts} onSaved=${() => setBump(bump + 1)} />`}
  </div>`;
}
