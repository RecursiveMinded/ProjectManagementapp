// The main calendar: dated work from every board in month, week or agenda form.
import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Menu, useAnchor, toastError, toast, todayIso, addDaysIso, diffDays, usePersist, Avatars, Spinner } from './lib.js';
import { call, saveAs } from './api.js';
import { C } from './model.js';
import { openMeeting } from './meetings.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const BOARD_COLORS = ['indigo', 'teal', 'tangerine', 'grape', 'mint', 'rose', 'ocean', 'sun', 'coral', 'leaf'];

const mondayOf = (d) => addDaysIso(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
const nice = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${DOW[(new Date(Date.UTC(y, m - 1, dd)).getUTCDay() + 6) % 7]} ${dd} ${MONTHS[m - 1].slice(0, 3)}`; };

export function CalendarPage({ boot, openItem, version }) {
  const [opt, setOpt] = usePersist('calendar', { mode: 'month', person: '', board: '', showDone: true, colorBy: 'status', subitems: true });
  const [anchorDay, setAnchorDay] = useState(todayIso());
  const [data, setData] = useState(null);
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  const t = todayIso();

  // Visible range for the mode.
  let from, to, days;
  if (opt.mode === 'month') {
    const first = `${anchorDay.slice(0, 7)}-01`;
    from = mondayOf(first);
    days = Array.from({ length: 42 }, (_, i) => addDaysIso(from, i));
  } else if (opt.mode === 'week') {
    from = mondayOf(anchorDay);
    days = Array.from({ length: 7 }, (_, i) => addDaysIso(from, i));
  } else {
    from = anchorDay;
    days = Array.from({ length: 42 }, (_, i) => addDaysIso(from, i));
  }
  to = days[days.length - 1];

  const load = () => call('calendar', { from, to, includeSubitems: opt.subitems }).then(setData, toastError);
  useEffect(() => { load(); }, [from, to, opt.subitems, version]);

  const me = boot.me.id;
  const boardIdx = {};
  boot.workspaces.flatMap((w) => w.boards).forEach((b, i) => { boardIdx[b.id] = i; });
  const entries = (data ? data.entries : []).filter((e) => (!opt.board || e.boardId === opt.board || (e.meetingId && opt.board === 'meetings'))
    && (!opt.person || e.people.includes(opt.person === 'me' ? me : opt.person))
    && (opt.showDone || !e.done));
  const colorOf = (e) => (opt.colorBy === 'board' && !e.meetingId ? C.colorHex(BOARD_COLORS[(boardIdx[e.boardId] || 0) % BOARD_COLORS.length]) : e.color);

  const on = {};
  for (const e of entries) {
    const n = Math.min(62, Math.max(0, diffDays(e.start, e.end)));
    for (let i = 0; i <= n; i++) { const d = addDaysIso(e.start, i); if (d >= from && d <= to) (on[d] = on[d] || []).push({ e, first: i === 0 || d === from || (opt.mode !== 'agenda' && days.indexOf(d) % 7 === 0), span: n + 1 }); }
  }

  const step = (n) => {
    if (opt.mode === 'month') { const [y, m] = anchorDay.split('-').map(Number); setAnchorDay(new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10)); }
    else setAnchorDay(addDaysIso(anchorDay, n * (opt.mode === 'week' ? 7 : 42)));
  };
  const [y, m] = anchorDay.split('-').map(Number);
  const title = opt.mode === 'month' ? `${MONTHS[m - 1]} ${y}` : `${nice(days[0])} – ${nice(to)}${to.slice(0, 4) !== days[0].slice(0, 4) ? ` ${to.slice(0, 4)}` : ` ${y}`}`;

  const moveTo = async (d) => {
    setOver(null);
    const e = drag;
    setDrag(null);
    if (!e || d === e.start) return;
    if (e.meetingId) { try { await call('updateMeeting', e.meetingId, { date: d }); toast(`Moved “${e.name}” to ${nice(d)}`); load(); } catch (er) { toastError(er); } return; }
    let value = d;
    if (e.type === 'timeline') value = { ...e.raw, start: d, end: addDaysIso(d, diffDays(e.start, e.end)) };
    else if (String(e.raw).length > 10) value = `${d}${String(e.raw).slice(10)}`;
    try { await call('setValue', e.id, e.columnId, value); toast(`Moved “${e.name}” to ${nice(d)}`); load(); } catch (er) { toastError(er); }
  };
  const dropProps = (d) => ({
    onDragOver: (ev) => { if (drag) { ev.preventDefault(); setOver(d); } },
    onDragLeave: () => setOver(null),
    onDrop: (ev) => { ev.preventDefault(); moveTo(d); },
  });
  const chip = ({ e, first }, compact) => html`<div key=${e.key} class=${`cal-item ${e.done ? 'done' : ''}`} draggable=${first} data-meeting=${e.meetingId || null} onDragStart=${() => setDrag(e)} onDragEnd=${() => setDrag(null)}
    style=${`background:${colorOf(e)};${first ? '' : 'opacity:.55'}`} title=${`${e.name} · ${e.boardName}${e.groupName ? ` · ${e.groupName}` : ''} · ${e.columnTitle}`} onClick=${() => (e.meetingId ? openMeeting(e.meetingId) : openItem(e.id))}>
    ${e.time ? html`<b>${e.time}</b> ` : null}${e.name}${compact ? null : html`<span class="cal-sub">${e.boardName}</span>`}</div>`;

  const exportIcs = () => {
    const esc = (s) => String(s).replace(/[\\,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
    const d8 = (d) => d.replace(/-/g, '');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Boardenda//Calendar//EN', 'CALSCALE:GREGORIAN'];
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    for (const e of entries) {
      lines.push('BEGIN:VEVENT', `UID:${e.key}@boardenda`, `DTSTAMP:${stamp}`, ...(e.meetingId && e.time ? [`DTSTART:${d8(e.start)}T${e.time.replace(':', '')}00`] : [`DTSTART;VALUE=DATE:${d8(e.start)}`, `DTEND;VALUE=DATE:${d8(addDaysIso(e.end, 1))}`]),
        `SUMMARY:${esc(e.name)}`, `DESCRIPTION:${esc(`${e.boardName}${e.groupName ? ` / ${e.groupName}` : ''} / ${e.columnTitle}${e.status ? ` / ${e.status.label}` : ''}`)}`, 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    saveAs(`Boardenda ${from} to ${to}.ics`, lines.join('\r\n'), [{ name: 'Calendar', extensions: ['ics'] }]).catch(toastError);
  };

  const seg = (key, opts) => html`<div class="seg">${opts.map(([v, l]) => html`<button key=${v} class=${opt[key] === v ? 'on' : ''} onClick=${() => setOpt({ ...opt, [key]: v })}>${l}</button>`)}</div>`;
  const boards = data ? data.boards : [];

  return html`<div class="page cal-page">
    <div class="page-head" style="flex-wrap:wrap">
      <h1>Calendar</h1>
      <button class="btn icon" aria-label="Previous" onClick=${() => step(-1)}><${Icon} name="arrowLeft" /></button>
      <button class="btn" onClick=${() => setAnchorDay(t)}>Today</button>
      <button class="btn icon" aria-label="Next" onClick=${() => step(1)}><${Icon} name="arrowRight" /></button>
      <h2 style="margin:0 6px">${title}</h2>
      <span class="grow"></span>
      ${seg('mode', [['month', 'Month'], ['week', 'Week'], ['agenda', 'Agenda']])}
    </div>
    <div class="row" style="flex-wrap:wrap;gap:8px;margin:-6px 0 14px">
      <select class="input" style="width:auto;height:30px" value=${opt.person} onChange=${(e) => setOpt({ ...opt, person: e.target.value })} aria-label="Person">
        <option value="">Everyone</option><option value="me">Assigned to me</option>
        ${boot.people.filter((p) => !p.is_me).map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select>
      <select class="input" style="width:auto;height:30px" value=${opt.board} onChange=${(e) => setOpt({ ...opt, board: e.target.value })} aria-label="Board">
        <option value="">All boards</option><option value="meetings">Calls and meetings only</option>${boards.map((b) => html`<option value=${b.id}>${b.name}</option>`)}</select>
      <span class="small muted">Colour by</span>${seg('colorBy', [['status', 'Status'], ['board', 'Board']])}
      <label class="check small"><input type="checkbox" checked=${opt.showDone} onChange=${(e) => setOpt({ ...opt, showDone: e.target.checked })} /> Show done</label>
      <label class="check small"><input type="checkbox" checked=${opt.subitems} onChange=${(e) => setOpt({ ...opt, subitems: e.target.checked })} /> Subitems</label>
      <span class="grow"></span>
      <span class="small muted">${entries.length} dated ${entries.length === 1 ? 'item' : 'items'}</span>
      <button class="btn small" onClick=${exportIcs} title="Open in Outlook or Google Calendar"><${Icon} name="download" size=${14} /> Export .ics</button>
    </div>
    ${!data ? html`<${Spinner} />` : !boards.length && !entries.length ? html`<div class="empty"><${Icon} name="calendar" /><h3>No dated work yet</h3><div>Add a Date or Timeline column to a board and its items appear here.</div></div>`
      : opt.mode === 'agenda' ? html`<div class="card agenda">${days.filter((d) => (on[d] || []).some((x) => x.first || d === from)).map((d) => html`<div class="ag-day" key=${d}>
          <div class=${`ag-date ${d === t ? 'today' : ''} ${d < t ? 'past' : ''}`}>${nice(d)}</div>
          <div class="ag-list">${on[d].filter((x) => x.first || d === from).map(({ e }) => html`<div class="ag-row" key=${e.key} onClick=${() => (e.meetingId ? openMeeting(e.meetingId) : openItem(e.id))}>
            <span class="dot" style=${`background:${colorOf(e)}`}></span><b class="clip">${e.parentName ? html`<span class="muted">${e.parentName} › </span>` : null}${e.name}</b>
            <span class="small muted clip">${e.boardName}${e.groupName ? ` · ${e.groupName}` : ''}</span>
            <span class="small muted">${e.type === 'timeline' && e.end !== e.start ? `until ${nice(e.end)}` : e.time || ''}</span>
            ${e.status ? html`<span class="lbl" style=${`background:${e.status.color};color:#fff`}>${e.status.label}</span>` : html`<span></span>`}
            <${Avatars} ids=${e.people} people=${Object.fromEntries(boot.people.map((p) => [p.id, p]))} size=${22} /></div>`)}</div></div>`)}
          ${!days.some((d) => (on[d] || []).length) ? html`<div class="empty"><${Icon} name="calendar" /><h3>Nothing scheduled in these six weeks</h3></div>` : null}</div>`
      : html`<div class=${`cal-grid ${opt.mode === 'week' ? 'week' : ''}`}>
        ${DOW.map((d) => html`<div class="cal-dow" key=${d}>${d}</div>`)}
        ${days.map((d) => {
          const list = on[d] || [];
          const max = opt.mode === 'week' ? 40 : 4;
          return html`<div key=${d} class=${`cal-day ${opt.mode === 'month' && d.slice(0, 7) !== anchorDay.slice(0, 7) ? 'other' : ''} ${d === t ? 'today' : ''} ${over === d ? 'over' : ''}`} ...${dropProps(d)}>
            <div class="dn"><b>${Number(d.slice(8))}</b><${AddOn} day=${d} boards=${boards} openItem=${openItem} reload=${load} /></div>
            ${list.slice(0, max).map((x) => chip(x, opt.mode === 'month'))}
            ${list.length > max ? html`<button class="cal-more" onClick=${() => { setAnchorDay(d); setOpt({ ...opt, mode: 'week' }); }}>+${list.length - max} more</button>` : null}
          </div>`;
        })}
      </div>`}
  </div>`;
}

/** "+" on a day: pick a board and create an item dated that day. */
function AddOn({ day, boards, openItem, reload }) {
  const [a, open, close] = useAnchor();
  const add = async (b) => {
    const c = b.dateColumns[0];
    if (!c) { toast('That board has no date column on its items', 'err'); return; }
    try {
      const id = await call('addItem', b.id, { name: `New ${b.noun}`, values: { [c.id]: c.type === 'timeline' ? { start: day, end: day } : day } });
      reload();
      openItem(id);
    } catch (e) { toastError(e); }
  };
  return html`<span><button title="Add an item on this day" aria-label="Add an item on this day" onClick=${open}><${Icon} name="plus" size="14" /></button>
    ${a ? html`<${Menu} anchor=${a} onClose=${close} items=${[{ head: true, label: `Add on ${nice(day)} to…` }, ...boards.filter((b) => b.dateColumns.length).map((b) => ({ label: b.name, icon: 'table', onClick: () => add(b) }))]} />` : null}</span>`;
}

