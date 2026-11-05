// Cell display and editing for every column type.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Popover, useAnchor, Avatar, Avatars, shortDate, todayIso, addDaysIso, diffDays, hexA, toastError } from './lib.js';
import { call, native } from './api.js';
import { C } from './model.js';

const TZ = ['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Kyiv', 'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland', 'UTC'];

export function LabelPill({ label, empty = '', big = false }) {
  if (!label) return html`<span class=${`lbl none ${big ? 'big' : ''}`}>${empty}</span>`;
  const hex = C.colorHex(label.color);
  return html`<span class=${`lbl ${big ? 'big' : ''}`} style=${`--c:${hex};background:${hexA(hex, 0.16)};color:${hex}`}><i style=${`background:${hex}`}></i>${label.label}</span>`;
}

/** Display + editor for one cell. */
export function Cell({ col, item, B, ctx, onSet, reload, compact = false, readonly = false }) {
  const [anchor, open, close] = useAnchor();
  const v = item.values ? item.values[col.id] : item.data[col.id];
  const set = async (nv) => { try { await onSet(nv); } catch (e) { toastError(e); } };
  const ro = readonly || C.isComputed(col.type);
  const T = col.type;

  // Types edited in place without a popover.
  if (T === 'checkbox') {
    return html`<div class="cell center"><button class=${`cbx ${v ? 'on' : ''}`} disabled=${ro} aria-label=${col.title} onClick=${(e) => { e.stopPropagation(); set(!v); }}>${v ? html`<${Icon} name="check" />` : null}</button></div>`;
  }
  if (T === 'rating') {
    const max = col.settings.max || 5;
    return html`<div class="cell center rating">${Array.from({ length: max }, (_, i) => html`<button key=${i} class=${`star ${i < (v || 0) ? 'on' : ''}`} aria-label=${`${i + 1} stars`} onClick=${(e) => { e.stopPropagation(); if (!ro) set(v === i + 1 ? 0 : i + 1); }}>★</button>`)}</div>`;
  }
  if (T === 'button') {
    return html`<div class="cell center"><button class="cell-btn" style=${`background:${C.colorHex(col.settings.color)}`} onClick=${async (e) => { e.stopPropagation(); try { await call('clickButton', item.id, col.id); reload && reload(); } catch (er) { toastError(er); } }}>${col.settings.label || 'Click'}</button></div>`;
  }
  if (T === 'doc') {
    const d = v && ctx.docs && ctx.docs[v];
    const openDoc = async (e) => {
      e.stopPropagation();
      try {
        const id = d ? v : await call('createItemDoc', item.id, col.id);
        if (!d) reload && reload();
        window.dispatchEvent(new CustomEvent('bd-open-doc', { detail: id }));
      } catch (er) { toastError(er); }
    };
    if (ro && !d) return html`<div class="cell"></div>`;
    return html`<div class="cell click doc-cell" tabindex="0" onClick=${openDoc} onKeyDown=${(e) => { if (e.key === 'Enter') openDoc(e); }}>
      ${d ? html`<span class="chip doc-chip"><${Icon} name="para" size="12" />${d.title}</span>` : html`<span class="placeholder doc-add"><${Icon} name="plus" size="13" /> Doc</span>`}</div>`;
  }
  if (T === 'time_tracking') return html`<${TimerCell} col=${col} item=${item} v=${v} reload=${reload} />`;
  if (T === 'vote') {
    const me = B.people.find((p) => p.is_me);
    const on = me && (v || []).includes(me.id);
    return html`<div class="cell center"><button class=${`vote ${on ? 'on' : ''}`} onClick=${(e) => { e.stopPropagation(); if (!me) return; set(on ? (v || []).filter((x) => x !== me.id) : [...(v || []), me.id]); }}><${Icon} name="vote" size="14" /> ${(v || []).length}</button></div>`;
  }
  if (['text', 'numbers', 'email', 'phone', 'hour'].includes(T) && !ro) return html`<${InlineCell} col=${col} v=${v} set=${set} />`;

  const display = renderValue(col, v, B, ctx, compact, item);
  return html`<div class=${`cell ${cellAlign(T)} ${ro ? 'ro' : 'click'}`} tabindex=${ro ? -1 : 0} onClick=${(e) => { if (!ro) open(e); }} onKeyDown=${(e) => { if (!ro && e.key === 'Enter') open(e); }}>
    ${display}
    ${anchor ? html`<${Editor} anchor=${anchor} close=${close} col=${col} item=${item} v=${v} set=${set} B=${B} ctx=${ctx} reload=${reload} />` : null}
  </div>`;
}

function cellAlign(T) {
  return ['status', 'priority', 'people', 'team', 'date', 'timeline', 'progress', 'week', 'color', 'country', 'world_clock', 'item_id', 'auto_number', 'subitems_count', 'last_updated', 'creation_log'].includes(T) ? 'center' : '';
}

export function renderValue(col, v, B, ctx, compact, item) {
  const T = col.type;
  switch (T) {
    case 'status': case 'priority': return html`<${LabelPill} label=${C.labelOf(col, v)} />`;
    case 'people': return html`<${Avatars} ids=${v} people=${ctx.people} size=${compact ? 22 : 26} />`;
    case 'team': {
      const list = (v || []).map((id) => ctx.teams && ctx.teams[id]).filter(Boolean);
      if (!list.length) return html`<span class="placeholder"><${Icon} name="group" size="15" /></span>`;
      return html`<span class="team-chips">${list.slice(0, compact ? 1 : 2).map((t) => html`<span key=${t.id} class=${`team-chip ${col.settings.role === 'waiting' ? 'waiting' : ''}`} style=${`--tc:${C.colorHex(t.color)}`} title=${t.external ? `${t.name} (outside Boardenda)` : t.name}>${col.settings.role === 'waiting' ? '⏳ ' : ''}${t.name}</span>`)}${list.length > (compact ? 1 : 2) ? html`<span class="small muted">+${list.length - (compact ? 1 : 2)}</span>` : null}</span>`;
    }
    case 'date': {
      if (!v) return html`<span class="placeholder"><${Icon} name="calendar" size="15" /></span>`;
      const d = String(v).slice(0, 10);
      const t = todayIso();
      const statusCol = B.columns.find((c) => c.scope === col.scope && c.type === 'status');
      const done = !!(item && statusCol && C.isDoneLabel(statusCol, (item.values || {})[statusCol.id]));
      return html`<span class=${`date ${d < t && !done ? 'late' : d === t ? 'today' : ''}`}>${shortDate(d)}${String(v).length > 10 ? ` ${String(v).slice(11, 16)}` : ''}</span>`;
    }
    case 'timeline': {
      if (!v || !v.start) return html`<span class="placeholder"><${Icon} name="timeline" size="15" /></span>`;
      const t = todayIso();
      const total = Math.max(1, diffDays(v.start, v.end) + 1);
      const gone = Math.min(total, Math.max(0, diffDays(v.start, t) + 1));
      return html`<span class="tl-pill" title=${`${total} days`}><span class="tl-fill" style=${`width:${(gone / total) * 100}%`}></span><span class="tl-text">${shortDate(v.start)} – ${shortDate(v.end)}</span></span>`;
    }
    case 'week': return v ? html`<span>Week of ${shortDate(v)}</span>` : html`<span class="placeholder">—</span>`;
    case 'dropdown': return html`<span class="chips">${(v || []).map((id) => { const o = C.optionOf(col, id); return o ? html`<span class="chip" key=${id}>${o.label}</span>` : null; })}</span>`;
    case 'tags': return html`<span class="chips">${(v || []).map((t) => html`<span class="chip tag" key=${t}>#${t}</span>`)}</span>`;
    case 'link': return v && v.url ? html`<a href=${v.url} onClick=${(e) => { e.preventDefault(); e.stopPropagation(); native('openExternal', { url: v.url }); }}>${v.text || v.url.replace(/^https?:\/\//, '')}</a>` : null;
    case 'long_text': return html`<span class="clip">${v || ''}</span>`;
    case 'location': return v ? html`<span class="clip"><${Icon} name="pin" size="14" /> ${v}</span>` : null;
    case 'files': {
      const fs = (v || []).map((id) => ctx.files[id]).filter(Boolean);
      return fs.length ? html`<span class="chips">${fs.slice(0, 2).map((f) => html`<span class="chip file" key=${f.id}><${Icon} name="file" size="12" />${f.name}</span>`)}${fs.length > 2 ? html`<span class="chip">+${fs.length - 2}</span>` : null}</span>` : html`<span class="placeholder"><${Icon} name="paperclip" size="15" /></span>`;
    }
    case 'connect': case 'dependency': {
      const ids = v || [];
      return ids.length ? html`<span class="chips">${ids.slice(0, 2).map((id) => html`<span class="chip link-chip" key=${id}>${ctx.itemNames[id] || '…'}</span>`)}${ids.length > 2 ? html`<span class="chip">+${ids.length - 2}</span>` : null}</span>` : html`<span class="placeholder"><${Icon} name=${T === 'connect' ? 'connect' : 'dependency'} size="15" /></span>`;
    }
    case 'mirror': {
      if (v == null) return null;
      if (Array.isArray(v)) return html`<span class="chips">${v.map((x, i) => (typeof x === 'object' ? html`<${LabelPill} key=${i} label=${x} />` : html`<span class="chip" key=${i}>${x}</span>`))}</span>`;
      return html`<span>${typeof v === 'number' ? Math.round(v * 100) / 100 : v}</span>`;
    }
    case 'progress': {
      if (v == null) return null;
      return html`<span class="progress" title=${`${v}%`}><span style=${`width:${v}%`}></span><b>${v}%</b></span>`;
    }
    case 'formula': {
      if (v && v.error) return html`<span class="f-err" title=${v.error}><${Icon} name="warn" size="14" /> Error</span>`;
      if (typeof v === 'boolean') return html`<span>${v ? 'true' : 'false'}</span>`;
      if (typeof v === 'number') return html`<span class="num">${Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: col.settings.decimals ?? 2 })}</span>`;
      return html`<span class="clip">${v ?? ''}</span>`;
    }
    case 'country': { const c = C.COUNTRIES.find((x) => x[0] === v); return c ? html`<span>${flag(c[0])} ${c[1]}</span>` : null; }
    case 'world_clock': return v ? html`<span title=${v}>${clockIn(v)} <span class="faint small">${v.split('/').pop().replace(/_/g, ' ')}</span></span>` : null;
    case 'color': return v ? html`<span class="swatch" style=${`background:${v}`}></span>` : null;
    case 'item_id': case 'auto_number': return v ? html`<span class="faint">${col.settings.prefix || ''}${col.settings.digits ? String(v).padStart(col.settings.digits, '0') : v}</span>` : null;
    case 'subitems_count': return html`<span>${v || 0}</span>`;
    case 'creation_log': return v ? html`<span class="row" style="gap:6px;justify-content:center"><${Avatar} person=${ctx.people[v.by]} size="20" /><span class="small">${shortDate(v.at.slice(0, 10))}</span></span>` : null;
    case 'last_updated': return v ? html`<span class="small">${shortDate(v.at.slice(0, 10))} ${v.at.slice(11, 16)}</span>` : null;
    default: return html`<span class="clip">${C.textOf(col, v, ctx)}</span>`;
  }
}

function flag(cc) { return String.fromCodePoint(...cc.toUpperCase().split('').map((c) => 0x1f1a5 + c.charCodeAt(0))); }
function clockIn(tz) { try { return new Date().toLocaleTimeString([], { timeZone: tz, hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } }

function InlineCell({ col, v, set }) {
  const [edit, setEdit] = useState(false);
  const [val, setVal] = useState('');
  const T = col.type;
  const shown = T === 'numbers' ? C.fmtNumber(col, v) : v || '';
  if (!edit) {
    return html`<div class=${`cell ${T === 'numbers' ? 'num' : ''} click`} tabindex="0" onClick=${(e) => { e.stopPropagation(); setVal(v == null ? '' : String(v)); setEdit(true); }}
      onKeyDown=${(e) => { if (e.key === 'Enter') { setVal(v == null ? '' : String(v)); setEdit(true); } }}>
      ${T === 'email' && v ? html`<a href=${`mailto:${v}`} onClick=${(e) => { e.preventDefault(); e.stopPropagation(); native('openExternal', { url: `mailto:${v}` }).catch(() => {}); }}>${v}</a>` : html`<span class="clip">${shown}</span>`}
    </div>`;
  }
  const done = (save) => { setEdit(false); if (save && String(val) !== String(v ?? '')) set(val === '' ? null : val); };
  return html`<div class="cell editing"><input class="cell-input" autoFocus value=${val} type=${T === 'numbers' ? 'text' : T === 'hour' ? 'time' : T === 'email' ? 'email' : 'text'} inputmode=${T === 'numbers' ? 'decimal' : undefined}
    onInput=${(e) => setVal(e.target.value)} onBlur=${() => done(true)} onClick=${(e) => e.stopPropagation()}
    onKeyDown=${(e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') { e.stopPropagation(); done(false); } }} /></div>`;
}

function TimerCell({ col, item, v, reload }) {
  const [, tick] = useState(0);
  const running = v && v.since;
  useEffect(() => { if (!running) return undefined; const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, [running]);
  const secs = C.trackedSeconds(v);
  return html`<div class="cell timer">
    <button class=${`play ${running ? 'on' : ''}`} aria-label=${running ? 'Stop timer' : 'Start timer'} onClick=${async (e) => { e.stopPropagation(); try { await call('toggleTimer', item.id, col.id); reload && reload(); } catch (er) { toastError(er); } }}><${Icon} name=${running ? 'pause' : 'play'} size="12" /></button>
    <span class="mono">${secs ? C.fmtDuration(secs) : '00:00:00'}</span></div>`;
}

// ------------------------------------------------------------------ editors
function Editor({ anchor, close, col, item, v, set, B, ctx, reload }) {
  const T = col.type;
  const props = { col, item, v, set, close, B, ctx, reload };
  let body;
  let width = 260;
  if (C.LABEL_TYPES.has(T)) body = html`<${LabelEditor} ...${props} />`;
  else if (T === 'people') body = html`<${PeopleEditor} ...${props} />`;
  else if (T === 'team') body = html`<${TeamEditor} ...${props} />`;
  else if (T === 'date') body = html`<${DateEditor} ...${props} />`;
  else if (T === 'timeline') { body = html`<${TimelineEditor} ...${props} />`; width = 300; }
  else if (T === 'week') body = html`<${DateEditor} ...${props} week />`;
  else if (T === 'dropdown') body = html`<${DropdownEditor} ...${props} />`;
  else if (T === 'tags') body = html`<${TagsEditor} ...${props} />`;
  else if (T === 'link') body = html`<${LinkEditor} ...${props} />`;
  else if (T === 'long_text' || T === 'location') { body = html`<${LongTextEditor} ...${props} />`; width = 340; }
  else if (T === 'files') { body = html`<${FilesEditor} ...${props} />`; width = 300; }
  else if (T === 'connect' || T === 'dependency') { body = html`<${ConnectEditor} ...${props} />`; width = 320; }
  else if (T === 'country') body = html`<${PickList} options=${C.COUNTRIES.map(([k, n]) => ({ value: k, label: `${flag(k)} ${n}` }))} value=${v} onPick=${(x) => { set(x); close(); }} />`;
  else if (T === 'world_clock') body = html`<${PickList} options=${TZ.map((z) => ({ value: z, label: `${z.replace(/_/g, ' ')} · ${clockIn(z)}` }))} value=${v} onPick=${(x) => { set(x); close(); }} />`;
  else if (T === 'color') body = html`<div class="pad col"><div class="swatches">${C.PALETTE.map((p) => html`<button key=${p.id} class="swatch big" style=${`background:${p.hex}`} onClick=${() => { set(p.hex); close(); }}></button>`)}</div>
    <label class="row small">Custom <input type="color" value=${v || '#5a55d6'} onChange=${(e) => set(e.target.value)} /></label><button class="btn ghost small" onClick=${() => { set(null); close(); }}>Clear</button></div>`;
  else body = html`<div class="pad muted small">This value is calculated.</div>`;
  return html`<${Popover} anchor=${anchor} onClose=${close} width=${width} align="center">${body}</${Popover}>`;
}

function PickList({ options, value, onPick, placeholder = 'Search' }) {
  const [q, setQ] = useState('');
  const list = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));
  return html`<div class="col pad" style="gap:6px">
    <input class="input" autoFocus placeholder=${placeholder} value=${q} onInput=${(e) => setQ(e.target.value)} />
    <div class="pick-list">${list.slice(0, 200).map((o) => html`<button key=${o.value} class=${`mi ${o.value === value ? 'active' : ''}`} onClick=${() => onPick(o.value)}>${o.label}</button>`)}</div>
    ${value ? html`<button class="btn ghost small" onClick=${() => onPick(null)}>Clear</button>` : null}
  </div>`;
}

function LabelEditor({ col, v, set, close, reload }) {
  const [editing, setEditing] = useState(false);
  const [labels, setLabels] = useState(col.settings.labels || []);
  if (!editing) {
    return html`<div class="pad col" style="gap:6px">
      <div class="label-grid">${(col.settings.labels || []).map((l) => html`<button key=${l.id} class=${`label-opt ${v === l.id ? 'sel' : ''}`} style=${`background:${C.colorHex(l.color)}`} onClick=${() => { set(l.id); close(); }}>${l.label}</button>`)}
        <button class="label-opt clear" onClick=${() => { set(null); close(); }}>Clear</button></div>
      <button class="btn ghost small" onClick=${() => setEditing(true)}><${Icon} name="edit" size="14" /> Edit labels</button></div>`;
  }
  const save = async () => {
    try { await call('updateColumn', col.id, { settings: { labels: labels.filter((l) => l.label.trim()) } }); reload && reload(); close(); } catch (e) { toastError(e); }
  };
  return html`<div class="pad col" style="gap:6px">
    ${labels.map((l, i) => html`<div class="row" key=${l.id}>
      <${ColorDot} color=${l.color} onPick=${(c) => setLabels(labels.map((x, j) => (j === i ? { ...x, color: c } : x)))} />
      <input class="input grow" value=${l.label} onInput=${(e) => setLabels(labels.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
      <button class=${`btn icon ghost ${l.done ? 'on' : ''}`} title="Counts as done" onClick=${() => setLabels(labels.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))}><${Icon} name="check" size="14" /></button>
      <button class="btn icon ghost" title="Remove" onClick=${() => setLabels(labels.filter((_, j) => j !== i))}><${Icon} name="x" size="14" /></button></div>`)}
    <button class="btn ghost small" onClick=${() => setLabels([...labels, { id: `l${Date.now().toString(36)}`, label: 'New label', color: C.PALETTE[(labels.length * 3) % C.PALETTE.length].id }])}><${Icon} name="plus" size="14" /> Add label</button>
    <div class="row" style="justify-content:flex-end"><button class="btn small" onClick=${() => setEditing(false)}>Back</button><button class="btn primary small" onClick=${save}>Save labels</button></div>
  </div>`;
}

export function ColorDot({ color, onPick }) {
  const [a, open, close] = useAnchor();
  return html`<span><button class="color-dot" style=${`background:${C.colorHex(color)}`} aria-label="Colour" onClick=${open}></button>
    ${a ? html`<${Popover} anchor=${a} onClose=${close} width=${200}><div class="swatches pad">${C.PALETTE.map((p) => html`<button key=${p.id} class="swatch big" title=${p.id} style=${`background:${p.hex}`} onClick=${() => { onPick(p.id); close(); }}></button>`)}</div></${Popover}>` : null}</span>`;
}

function PeopleEditor({ col, v, set, B }) {
  const [q, setQ] = useState('');
  const cur = v || [];
  const list = B.people.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()) || (p.team || '').toLowerCase().includes(q.toLowerCase()));
  const toggle = (id) => set(cur.includes(id) ? cur.filter((x) => x !== id) : col.settings.max === 1 ? [id] : [...cur, id]);
  return html`<div class="pad col" style="gap:6px">
    ${cur.length ? html`<div class="chips">${cur.map((id) => { const p = B.people.find((x) => x.id === id); return p ? html`<span class="chip person" key=${id}><${Avatar} person=${p} size="18" />${p.name}<button aria-label="Remove" onClick=${() => toggle(id)}>×</button></span>` : null; })}</div>` : null}
    <input class="input" autoFocus placeholder="Search people" value=${q} onInput=${(e) => setQ(e.target.value)} />
    <div class="pick-list">${list.map((p) => html`<button key=${p.id} class=${`mi ${cur.includes(p.id) ? 'active' : ''}`} onClick=${() => toggle(p.id)}><${Avatar} person=${p} size="22" /><span class="grow">${p.name}${p.is_me ? ' (you)' : ''}</span><span class="faint small">${p.team || ''}</span></button>`)}</div>
    ${q && !list.length ? html`<button class="btn small" onClick=${async () => { try { const id = await call('savePerson', { name: q }); B.people.push({ id, name: q, color: '#5a55d6' }); set([...cur, id]); setQ(''); } catch (e) { toastError(e); } }}>Add “${q}” to the team</button>` : null}
  </div>`;
}

function TeamEditor({ col, v, set, B }) {
  const [q, setQ] = useState('');
  const cur = v || [];
  const teams = B.teams || [];
  const list = teams.filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id) => set(cur.includes(id) ? cur.filter((x) => x !== id) : col.settings.max === 1 ? [id] : [...cur, id]);
  return html`<div class="pad col" style="gap:6px">
    ${col.settings.role === 'waiting' ? html`<div class="small muted">Teams this depends on. This is a record only; nobody is contacted.</div>` : null}
    <input class="input" autoFocus placeholder="Search teams" value=${q} onInput=${(e) => setQ(e.target.value)} />
    <div class="pick-list">${list.map((t) => html`<button key=${t.id} class=${`mi ${cur.includes(t.id) ? 'active' : ''}`} onClick=${() => toggle(t.id)}>
      <span class="color-dot" style=${`background:${C.colorHex(t.color)}`}></span><span class="grow">${t.name}</span>${t.external ? html`<span class="faint small">outside</span>` : html`<span class="faint small">${t.members.length}</span>`}${cur.includes(t.id) ? html`<${Icon} name="check" size="14" />` : null}</button>`)}</div>
    ${q && !list.some((t) => t.name.toLowerCase() === q.toLowerCase()) ? html`<button class="btn small" onClick=${async () => { try { const id = await call('saveTeam', { name: q, external: col.settings.role === 'waiting' }); B.teams = [...teams, { id, name: q, color: 'indigo', members: [], external: col.settings.role === 'waiting' }]; set([...cur, id]); setQ(''); } catch (e) { toastError(e); } }}>Create team “${q}”</button>` : null}
    ${!teams.length && !q ? html`<div class="small muted">Type a name to create your first team.</div>` : null}
  </div>`;
}

function DateEditor({ col, v, set, close, week }) {
  const withTime = !!col.settings.time;
  const t = todayIso();
  const pick = (d) => { set(week && d ? mondayOf(d) : d); close(); };
  return html`<div class="pad col" style="gap:8px">
    <input class="input" type=${withTime ? 'datetime-local' : 'date'} autoFocus value=${v ? (withTime ? String(v).slice(0, 16) : String(v).slice(0, 10)) : ''} onChange=${(e) => { set(week ? mondayOf(e.target.value) : e.target.value || null); }} />
    <div class="row wrap" style="gap:4px">
      <button class="btn small" onClick=${() => pick(t)}>Today</button>
      <button class="btn small" onClick=${() => pick(addDaysIso(t, 1))}>Tomorrow</button>
      <button class="btn small" onClick=${() => pick(addDaysIso(t, 7))}>Next week</button>
      <button class="btn small ghost" onClick=${() => pick(null)}>Clear</button>
    </div></div>`;
}
function mondayOf(iso) { const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay(); return addDaysIso(iso.slice(0, 10), -((d + 6) % 7)); }

function TimelineEditor({ v, set, close }) {
  const [s, setS] = useState((v && v.start) || todayIso());
  const [e, setE] = useState((v && v.end) || addDaysIso(todayIso(), 4));
  const days = s && e ? diffDays(s, e) + 1 : 0;
  return html`<div class="pad col" style="gap:8px">
    <div class="row"><label class="grow small">Start<input class="input" type="date" value=${s} onChange=${(x) => { setS(x.target.value); if (e < x.target.value) setE(x.target.value); }} /></label>
      <label class="grow small">End<input class="input" type="date" value=${e} onChange=${(x) => setE(x.target.value)} /></label></div>
    <label class="row small">Duration <input class="input" style="width:80px" type="number" min="1" value=${days} onChange=${(x) => setE(addDaysIso(s, Math.max(1, Number(x.target.value)) - 1))} /> days</label>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost small" onClick=${() => { set(null); close(); }}>Clear</button><button class="btn primary small" disabled=${!s || !e || e < s} onClick=${() => { set({ start: s, end: e }); close(); }}>Set timeline</button></div>
  </div>`;
}

function DropdownEditor({ col, v, set, reload }) {
  const [q, setQ] = useState('');
  const cur = v || [];
  const opts = col.settings.options || [];
  const list = opts.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id) => set(cur.includes(id) ? cur.filter((x) => x !== id) : col.settings.max === 1 ? [id] : [...cur, id]);
  const create = async () => {
    const o = { id: `o${Date.now().toString(36)}`, label: q.trim() };
    try { await call('updateColumn', col.id, { settings: { options: [...opts, o] } }); col.settings.options = [...opts, o]; set([...cur, o.id]); setQ(''); reload && reload(); } catch (e) { toastError(e); }
  };
  return html`<div class="pad col" style="gap:6px">
    <input class="input" autoFocus placeholder="Search or create" value=${q} onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && q.trim() && !list.length) create(); }} />
    <div class="pick-list">${list.map((o) => html`<button key=${o.id} class=${`mi ${cur.includes(o.id) ? 'active' : ''}`} onClick=${() => toggle(o.id)}><span class=${`cbx small ${cur.includes(o.id) ? 'on' : ''}`}>${cur.includes(o.id) ? html`<${Icon} name="check" size="12" />` : null}</span>${o.label}</button>`)}</div>
    ${q.trim() && !opts.some((o) => o.label.toLowerCase() === q.trim().toLowerCase()) ? html`<button class="btn small" onClick=${create}>Create “${q.trim()}”</button>` : null}
  </div>`;
}

function TagsEditor({ v, set }) {
  const [q, setQ] = useState('');
  const cur = v || [];
  const add = () => { const t = q.trim().replace(/^#/, ''); if (t && !cur.includes(t)) set([...cur, t]); setQ(''); };
  return html`<div class="pad col" style="gap:6px">
    <div class="chips">${cur.map((t) => html`<span class="chip tag" key=${t}>#${t}<button aria-label="Remove" onClick=${() => set(cur.filter((x) => x !== t))}>×</button></span>`)}</div>
    <input class="input" autoFocus placeholder="Add a tag and press Enter" value=${q} onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }} />
  </div>`;
}

function LinkEditor({ v, set, close }) {
  const [url, setUrl] = useState((v && v.url) || '');
  const [text, setText] = useState((v && v.text) || '');
  return html`<div class="pad col" style="gap:6px">
    <input class="input" autoFocus placeholder="https://" value=${url} onInput=${(e) => setUrl(e.target.value)} />
    <input class="input" placeholder="Text to show (optional)" value=${text} onInput=${(e) => setText(e.target.value)} />
    <div class="row" style="justify-content:flex-end"><button class="btn ghost small" onClick=${() => { set(null); close(); }}>Clear</button>
      <button class="btn primary small" onClick=${() => { set(url ? { url: /^[a-z]+:/i.test(url) ? url : `https://${url}`, text } : null); close(); }}>Save</button></div></div>`;
}

function LongTextEditor({ v, set, close, col }) {
  const [t, setT] = useState(v || '');
  return html`<div class="pad col" style="gap:6px">
    <textarea class="input" autoFocus rows=${col.type === 'location' ? 2 : 6} value=${t} placeholder=${col.type === 'location' ? 'Address' : ''} onInput=${(e) => setT(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && e.ctrlKey) { set(t || null); close(); } }}></textarea>
    <div class="row between"><span class="faint small">Ctrl+Enter to save</span><button class="btn primary small" onClick=${() => { set(t || null); close(); }}>Save</button></div></div>`;
}

function FilesEditor({ col, item, v, ctx, reload }) {
  const input = useRef(null);
  const add = async (files) => {
    for (const f of files) {
      try { await call('addFile', item.id, col.id, { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }); } catch (e) { toastError(e); }
    }
    reload && reload();
  };
  const list = (v || []).map((id) => ctx.files[id]).filter(Boolean);
  return html`<div class="pad col" style="gap:6px" onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { e.preventDefault(); add([...e.dataTransfer.files]); }}>
    ${list.map((f) => html`<div class="row file-row" key=${f.id}><${Icon} name="file" size="15" /><a class="grow clip" onClick=${() => native('openFile', { id: f.id }).catch(toastError)}>${f.name}</a>
      <button class="btn icon ghost" title="Remove" onClick=${async () => { await call('removeFile', f.id).catch(toastError); reload && reload(); }}><${Icon} name="trash" size="14" /></button></div>`)}
    <div class="drop-hint">Drop files here or <a onClick=${() => input.current.click()}>browse</a></div>
    <input type="file" multiple hidden ref=${input} onChange=${(e) => add([...e.target.files])} />
  </div>`;
}

function ConnectEditor({ col, item, v, set, B }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState(null);
  const cur = v || [];
  useEffect(() => {
    (async () => {
      if (col.type === 'dependency') { setItems(B.items.filter((x) => x.id !== item.id).map((x) => ({ id: x.id, name: x.name, board: '' }))); return; }
      const out = [];
      for (const bid of col.settings.boardIds || []) {
        try {
          const list = await call('boardItems', bid);
          const name = (await call('allBoards')).find((b) => b.id === bid);
          for (const x of list) out.push({ id: x.id, name: x.name, board: name ? name.name : '' });
        } catch (_) { /* board removed */ }
      }
      setItems(out);
    })();
  }, [col.id]);
  if (col.type === 'connect' && !(col.settings.boardIds || []).length) return html`<div class="pad muted small">Choose which boards to connect in the column settings first.</div>`;
  const list = (items || []).filter((x) => x.name.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id) => set(cur.includes(id) ? cur.filter((x) => x !== id) : col.settings.multiple === false ? [id] : [...cur, id]);
  return html`<div class="pad col" style="gap:6px">
    <input class="input" autoFocus placeholder="Search items" value=${q} onInput=${(e) => setQ(e.target.value)} />
    ${items == null ? html`<span class="muted small">Loading…</span>` : null}
    <div class="pick-list">${list.slice(0, 150).map((x) => html`<button key=${x.id} class=${`mi ${cur.includes(x.id) ? 'active' : ''}`} onClick=${() => toggle(x.id)}><span class=${`cbx small ${cur.includes(x.id) ? 'on' : ''}`}>${cur.includes(x.id) ? html`<${Icon} name="check" size="12" />` : null}</span><span class="grow clip">${x.name}</span><span class="faint small">${x.board}</span></button>`)}</div>
  </div>`;
}
