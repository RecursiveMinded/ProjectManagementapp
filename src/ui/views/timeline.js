// Timeline (Gantt) view: bars on a time scale, drag to move or resize,
// dependency arrows, today line, zoom by day/week/month.
import { useState, useRef, useEffect } from 'preact/hooks';
import { html, Icon, toastError, toast, todayIso, addDaysIso, diffDays, shortDate, Menu, useAnchor, ask } from '../lib.js';
import { call } from '../api.js';
import { C, firstCol, ruleColor } from '../model.js';
import { criticalPath, variance } from '../../core/schedule.js';

const ZOOM = { day: 34, week: 16, month: 5 };
const ROW = 36;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function spanOf(col, v) {
  if (!v) return null;
  if (col.type === 'timeline') return v.start ? { start: v.start.slice(0, 10), end: (v.end || v.start).slice(0, 10) } : null;
  return { start: String(v).slice(0, 10), end: String(v).slice(0, 10) };
}

export function TimelineView({ B, cfg, setCfg, items, ctx, reload, openItem }) {
  const dateCols = B.columns.filter((c) => c.scope === 'item' && (c.type === 'timeline' || c.type === 'date'));
  const col = dateCols.find((c) => c.id === cfg.dateColumn) || firstCol(B, ['timeline']) || dateCols[0];
  const zoom = cfg.zoom || 'week';
  const px = ZOOM[zoom];
  const scroller = useRef(null);
  const [dragState, setDragState] = useState(null);
  const [opt, openOpt, closeOpt] = useAnchor();
  if (!col) return html`<div class="empty"><${Icon} name="timeline" /><h3>Add a Timeline or Date column</h3><div>The timeline places items using their dates.</div></div>`;
  const statusCol = firstCol(B, 'status');
  const depCol = B.columns.find((c) => c.type === 'dependency' && c.scope === 'item' && (!c.settings.dateColumn || c.settings.dateColumn === col.id));
  const checkCols = B.columns.filter((c) => c.scope === 'item' && c.type === 'checkbox');
  const msCol = cfg.milestoneColumn === '' ? null : checkCols.find((c) => c.id === cfg.milestoneColumn) || checkCols.find((c) => /milestone/i.test(c.title));
  const isMilestone = (it) => col.type === 'date' || (msCol && !!it.values[msCol.id]);
  const baseline = cfg.baseline && cfg.showBaseline !== false ? cfg.baseline : null;
  const showCrit = !!cfg.critical && !!depCol;
  const crit = showCrit
    ? criticalPath(items.map((it) => ({ id: it.id, ...(spanOf(col, it.values[col.id]) || {}) })),
      items.flatMap((it) => (it.values[depCol.id] || []).map((pid) => ({ from: pid, to: it.id }))), depCol.settings)
    : null;
  const saveBaseline = async () => {
    if (cfg.baseline && !(await ask({ title: 'Replace the baseline?', body: `The baseline saved ${shortDate(cfg.baseline.at)} will be replaced with the current dates.`, ok: 'Replace', danger: false }))) return;
    const spansNow = {};
    for (const it of B.items) { const sp = spanOf(col, it.values[col.id]); if (sp) spansNow[it.id] = sp; }
    setCfg({ ...cfg, baseline: { at: todayIso(), column: col.id, spans: spansNow }, showBaseline: true });
    toast(`Baseline saved for ${Object.keys(spansNow).length} items`);
  };
  const t = todayIso();
  const spans = items.map((it) => spanOf(col, it.values[col.id])).filter(Boolean);
  let from = addDaysIso(t, -14), to = addDaysIso(t, 60);
  for (const s of spans) { if (s.start < from) from = s.start; if (s.end > to) to = s.end; }
  from = addDaysIso(from, -7);
  to = addDaysIso(to, 21);
  // Start on a Monday.
  const dow = (new Date(`${from}T00:00:00Z`).getUTCDay() + 6) % 7;
  from = addDaysIso(from, -dow);
  const days = diffDays(from, to) + 1;
  const width = days * px;
  const x = (d) => diffDays(from, d) * px;

  useEffect(() => {
    if (scroller.current && !scroller.current.dataset.init) {
      scroller.current.dataset.init = '1';
      scroller.current.scrollLeft = Math.max(0, x(t) - 260);
    }
  }, [zoom]);

  const rows = [];
  for (const g of B.groups.filter((gg) => !gg.archived)) {
    const its = items.filter((i) => i.group_id === g.id);
    if (!its.length) continue;
    const gs = its.map((i) => spanOf(col, i.values[col.id])).filter(Boolean);
    rows.push({ kind: 'group', g, span: gs.length ? { start: gs.map((s) => s.start).sort()[0], end: gs.map((s) => s.end).sort().pop() } : null, n: its.length });
    if (!(cfg.collapsed || {})[g.id]) for (const it of its) rows.push({ kind: 'item', it, g, span: spanOf(col, it.values[col.id]) });
  }
  const rowIndex = {};
  rows.forEach((r, i) => { if (r.kind === 'item') rowIndex[r.it.id] = i; });

  const colorOf = (it, g) => {
    const rc = ruleColor(B, cfg, it, ctx);
    if (rc) return rc;
    if (cfg.colorBy !== 'group' && statusCol) { const l = C.labelOf(statusCol, it.values[statusCol.id]); if (l) return C.colorHex(l.color); }
    return C.colorHex(g.color);
  };

  const startDrag = (e, it, mode, span) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    let delta = 0;
    const move = (ev) => {
      delta = Math.round((ev.clientX - x0) / px);
      setDragState({ id: it.id, mode, delta });
    };
    const up = async () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDragState(null);
      if (!delta) { if (mode === 'move') openItem(it.id); return; }
      let s = span.start, en = span.end;
      if (mode === 'move') { s = addDaysIso(s, delta); en = addDaysIso(en, delta); }
      if (mode === 'l') s = addDaysIso(s, delta) > en ? en : addDaysIso(s, delta);
      if (mode === 'r') en = addDaysIso(en, delta) < s ? s : addDaysIso(en, delta);
      const value = col.type === 'timeline' ? { start: s, end: en } : s;
      try { await call('setValue', it.id, col.id, value); reload(); } catch (er) { toastError(er); }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const schedule = async (e, it) => {
    // Click on an empty lane to schedule an undated item there.
    const rect = e.currentTarget.getBoundingClientRect();
    const d = addDaysIso(from, Math.floor((e.clientX - rect.left) / px));
    const value = col.type === 'timeline' ? { start: d, end: addDaysIso(d, zoom === 'month' ? 13 : 4) } : d;
    try { await call('setValue', it.id, col.id, value); reload(); } catch (er) { toastError(er); }
  };

  // Scale: month labels on top, day/week ticks below.
  const months = [];
  const ticks = [];
  for (let i = 0; i < days; i++) {
    const d = addDaysIso(from, i);
    if (d.slice(8) === '01' || i === 0) months.push({ d, left: i * px });
    const wd = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
    if (zoom === 'day') ticks.push({ left: i * px, w: px, label: d.slice(8), we: wd >= 5 });
    else if (zoom === 'week' && wd === 0) ticks.push({ left: i * px, w: px * 7, label: shortDate(d) });
  }

  const arrows = [];
  if (depCol) {
    for (const r of rows) {
      if (r.kind !== 'item' || !r.span) continue;
      for (const pid of r.it.values[depCol.id] || []) {
        const pi = rowIndex[pid];
        if (pi == null) continue;
        const pr = rows[pi];
        if (!pr.span) continue;
        const x1 = x(pr.span.end) + px, y1 = pi * ROW + ROW / 2;
        const x2 = x(r.span.start), y2 = rowIndex[r.it.id] * ROW + ROW / 2;
        const mid = Math.max(x1 + 8, Math.min(x2 - 8, x1 + 12));
        const late = r.span.start <= pr.span.end;
        const onPath = crit && crit.links.has(`${pid}>${r.it.id}`);
        const hot = late || onPath;
        arrows.push(html`<path key=${`${pid}-${r.it.id}`} class=${onPath ? 'crit' : ''} d=${`M${x1},${y1} H${mid} V${y2} H${x2 - 2}`} fill="none" stroke=${hot ? 'var(--bad)' : 'var(--faint)'} stroke-width=${onPath ? 2.5 : 1.5} marker-end=${hot ? 'url(#ahr)' : 'url(#ah)'} />`);
      }
    }
  }

  return html`<div style="display:flex;flex-direction:column;height:100%">
    <div class="row gantt-bar" style="padding:10px 24px;gap:8px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap">
      <span class="small muted">Dates from</span>
      <select class="input" style="width:auto;height:28px" value=${col.id} onChange=${(e) => setCfg({ ...cfg, dateColumn: e.target.value })}>${dateCols.map((c) => html`<option value=${c.id}>${c.title}</option>`)}</select>
      <span class="small muted">Colour by</span>
      <select class="input" style="width:auto;height:28px" value=${cfg.colorBy || 'status'} onChange=${(e) => setCfg({ ...cfg, colorBy: e.target.value })}><option value="status">Status</option><option value="group">Group</option></select>
      <button class=${`btn small ${showCrit ? 'active' : ''}`} disabled=${!depCol} title=${depCol ? 'Highlight the chain of linked items that sets the finish date' : 'Add a Dependency column to see the critical path'} onClick=${() => setCfg({ ...cfg, critical: !cfg.critical })}><${Icon} name="flag" size="14" /> Critical path</button>
      <button class=${`btn small ${baseline ? 'active' : ''}`} onClick=${openOpt}><${Icon} name="history" size="14" /> Baseline${cfg.baseline ? ` · ${shortDate(cfg.baseline.at)}` : ''}</button>
      ${opt ? html`<${Menu} anchor=${opt} onClose=${closeOpt} width=${260} items=${[
        { label: cfg.baseline ? 'Save a new baseline' : 'Save baseline', icon: 'history', hint: 'snapshot of current dates', onClick: saveBaseline },
        cfg.baseline ? { label: cfg.showBaseline === false ? 'Show baseline' : 'Hide baseline', icon: 'eye', onClick: () => setCfg({ ...cfg, showBaseline: cfg.showBaseline === false }) } : null,
        cfg.baseline ? { label: 'Clear baseline', icon: 'trash', danger: true, onClick: () => setCfg({ ...cfg, baseline: null }) } : null,
        { sep: true },
        { head: 'Milestones from' },
        { label: 'None', active: !msCol, onClick: () => setCfg({ ...cfg, milestoneColumn: '' }) },
        ...checkCols.map((c) => ({ label: c.title, icon: 'checkbox', active: msCol && msCol.id === c.id, onClick: () => setCfg({ ...cfg, milestoneColumn: c.id }) })),
        !checkCols.length ? { label: 'Add a checkbox column to mark milestones', disabled: true } : null,
      ]} />` : null}
      ${crit && crit.finish ? html`<span class="small muted">Finish ${shortDate(crit.finish)} · ${crit.critical.size} critical</span>` : null}
      <span class="grow"></span>
      <button class="btn small" onClick=${() => { if (scroller.current) scroller.current.scrollLeft = Math.max(0, x(t) - 260); }}><${Icon} name="today" size="14" /> Today</button>
      <div class="seg">${Object.keys(ZOOM).map((z) => html`<button key=${z} class=${zoom === z ? 'on' : ''} onClick=${() => { if (scroller.current) delete scroller.current.dataset.init; setCfg({ ...cfg, zoom: z }); }}>${z[0].toUpperCase() + z.slice(1)}</button>`)}</div>
    </div>
    <div style="flex:1;overflow:auto" ref=${scroller}>
      <div class="gantt" style=${`width:${280 + width}px`}>
        <div class="g-left">
          <div class="g-head row" style="padding:0 12px"><b class="small muted">${B.board.item_noun ? `${B.board.item_noun[0].toUpperCase()}${B.board.item_noun.slice(1)}s` : 'Items'}</b></div>
          ${rows.map((r) => (r.kind === 'group'
            ? html`<div class="g-row grp" key=${`g${r.g.id}`} style=${`--sec:${C.colorHex(r.g.color)}`}><button class="btn icon ghost small" onClick=${() => setCfg({ ...cfg, collapsed: { ...(cfg.collapsed || {}), [r.g.id]: !(cfg.collapsed || {})[r.g.id] } })}><${Icon} name="chev" size="14" /></button><span class="clip grow">${r.g.name}</span><span class="faint small">${r.n}</span></div>`
            : html`<div class=${`g-row ${crit && crit.critical.has(r.it.id) ? 'crit' : ''}`} key=${r.it.id}>${isMilestone(r.it) ? html`<span class="ms-dot" title="Milestone"></span>` : null}<span class="clip grow" style="cursor:pointer" onClick=${() => openItem(r.it.id)}>${r.it.name}</span>${!r.span ? html`<span class="faint small" title="Click the lane to schedule">unscheduled</span>` : varianceTag(baseline, r)}</div>`))}
        </div>
        <div class="g-right" style=${`width:${width}px`}>
          <div class="g-scale">
            ${months.map((m) => html`<div class="mon" key=${m.d} style=${`left:${m.left}px`}>${MON[+m.d.slice(5, 7) - 1]} ${m.d.slice(0, 4)}</div>`)}
            ${ticks.map((k) => html`<div class=${`tick ${k.we ? 'we' : ''}`} key=${k.left} style=${`left:${k.left}px;width:${k.w}px`}>${k.label}</div>`)}
          </div>
          ${zoom !== 'month' ? ticks.filter((k) => k.we).map((k) => html`<div class="g-grid we" key=${`w${k.left}`} style=${`left:${k.left}px;width:${k.w}px`}></div>`) : null}
          <div class="g-today" style=${`left:${x(t) + px / 2}px`} title="Today"></div>
          <div style="position:relative">
            <svg class="g-arrows" width=${width} height=${rows.length * ROW}>
              <defs><marker id="ah" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--faint)" /></marker>
                <marker id="ahr" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--bad)" /></marker></defs>
              ${arrows}
            </svg>
            ${rows.map((r) => {
              if (r.kind === 'group') {
                return html`<div class="g-lane grp" key=${`g${r.g.id}`} style=${`--sec:${C.colorHex(r.g.color)}`}>${r.span ? html`<div class="g-sum" style=${`left:${x(r.span.start)}px;width:${(diffDays(r.span.start, r.span.end) + 1) * px}px`}></div>` : null}</div>`;
              }
              if (!r.span) return html`<div class="g-lane" key=${r.it.id} style="cursor:copy" title="Click to schedule here" onClick=${(e) => schedule(e, r.it)}></div>`;
              let s = r.span.start, en = r.span.end;
              if (dragState && dragState.id === r.it.id) {
                const d = dragState.delta;
                if (dragState.mode === 'move') { s = addDaysIso(s, d); en = addDaysIso(en, d); }
                if (dragState.mode === 'l') s = addDaysIso(s, d);
                if (dragState.mode === 'r') en = addDaysIso(en, d);
              }
              const milestone = isMilestone(r.it);
              const w = milestone ? 16 : Math.max(px, (diffDays(s, en) + 1) * px);
              const b0 = baseline && baseline.spans[r.it.id];
              const onCrit = crit && crit.critical.has(r.it.id);
              const fl = crit && crit.float[r.it.id];
              return html`<div class="g-lane" key=${r.it.id}>
                ${b0 ? html`<div class="g-base" title=${`Baseline: ${shortDate(b0.start)}${b0.start !== b0.end ? ` – ${shortDate(b0.end)}` : ''}`} style=${`left:${x(b0.start)}px;width:${(diffDays(b0.start, b0.end) + 1) * px}px`}></div>` : null}
                <div class=${`g-bar ${milestone ? 'milestone' : ''} ${onCrit ? 'crit' : ''}`} data-float=${fl != null ? fl : ''} title=${`${r.it.name}: ${shortDate(s)}${s !== en && !milestone ? ` – ${shortDate(en)}` : ''}${onCrit ? ' · on the critical path' : fl != null ? ` · ${fl} day${fl === 1 ? '' : 's'} of slack` : ''}`}
                  style=${`left:${x(milestone ? en : s) + (milestone ? px / 2 - 8 : 0)}px;width:${w}px;background:${colorOf(r.it, r.g)}`} onMouseDown=${(e) => startDrag(e, r.it, 'move', r.span)}>
                  ${milestone ? null : html`<span class="h l" onMouseDown=${(e) => startDrag(e, r.it, 'l', r.span)}></span>${w > 60 ? r.it.name : ''}<span class="h r" onMouseDown=${(e) => startDrag(e, r.it, 'r', r.span)}></span>`}
                </div>
                ${milestone || w <= 60 ? html`<span class="small" style=${`position:absolute;top:9px;left:${x(milestone ? en : s) + (milestone ? px / 2 + 12 : w + 8)}px;white-space:nowrap;color:var(--muted)`}>${r.it.name}</span>` : null}
              </div>`;
            })}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function varianceTag(baseline, r) {
  if (!baseline || !r.span) return null;
  const v = variance(baseline.spans[r.it.id], r.span);
  if (!v || !v.end) return null;
  return html`<span class=${`var-tag ${v.end > 0 ? 'late' : 'early'}`} title=${`Finish ${Math.abs(v.end)} day${Math.abs(v.end) === 1 ? '' : 's'} ${v.end > 0 ? 'later' : 'earlier'} than the baseline`}>${v.end > 0 ? '+' : '−'}${Math.abs(v.end)}d</span>`;
}
