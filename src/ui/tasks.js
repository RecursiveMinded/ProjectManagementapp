// Today and Tasks: one list of what is on me and what I'm waiting on, from
// dropped files, boards and meetings, ranked by priority with the reason, and
// the morning briefing.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Spinner, toast, toastError, Menu, Popover, InlineText, useAnchor, shortDate, todayIso, addDaysIso, diffDays } from './lib.js';
import { call } from './api.js';

const SRC = { case: ['spark', 'From the assistant'], item: ['table', 'Board item'], meeting: ['phone', 'Call or meeting action'], own: ['check', 'Your task'] };

export function openTaskSource(t) {
  if (!t.link) return;
  const ev = { case: 'bd-open-case', item: 'bd-open-item', meeting: 'bd-open-meeting' }[t.link.kind];
  if (ev) window.dispatchEvent(new CustomEvent(ev, { detail: t.link.id }));
}

/** Today, Tomorrow, a weekday this week, or a short date. */
function dueLabel(due, today) {
  const d = diffDays(today, due);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d > 1 && d < 7) return new Date(`${due}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
  return shortDate(due);
}

function nextMonday() { const d = new Date(); const add = ((8 - d.getDay()) % 7) || 7; return addDaysIso(todayIso(), add); }
function thisFriday() { const d = new Date(); const add = (5 - d.getDay() + 7) % 7; return addDaysIso(todayIso(), add); }

const PRIS = [['auto', 'Auto', 'Boardenda ranks it from dates, who it is from and what you do'], ['urgent', 'Urgent'], ['high', 'High'], ['normal', 'Normal'], ['low', 'Low']];
const PRI_CHIP = { urgent: 'Urgent', high: 'High', low: 'Low' };

// "Ask what's needed" from any task: Chat opens and asks the question there.
let pendingAsk = null;
export function askInChat(q) { pendingAsk = q; window.dispatchEvent(new CustomEvent('bd-ask-chat')); }
export function takePendingAsk() { const q = pendingAsk; pendingAsk = null; return q; }

function firstName(who) { const w = String(who || '').replace(/["<].*$/, '').trim().split(/\s+/)[0]; return w && !/^(internal|third|someone)$/i.test(w) ? w : 'there'; }
/** A short, friendly check-in to send to whoever owes the task. */
export function nudgeText(t) {
  return `Hi ${firstName(t.who)}, checking in on ${t.title.replace(/\.$/, '')}${t.due ? ` (due ${shortDate(t.due)})` : ''}. Where does it stand, and when can I expect it? Thanks.`;
}
async function copyNudge(t) {
  try { await navigator.clipboard.writeText(nudgeText(t)); toast('Check-in copied. Paste it into Teams or an email.'); } catch (e) { toastError(e); }
}

/** Pick a target date: quick choices or any date. */
function DatePop({ anchor, onClose, value, onPick }) {
  const pick = (d) => { onClose(); onPick(d); };
  const quick = [['Today', todayIso()], ['Tomorrow', addDaysIso(todayIso(), 1)], ['This Friday', thisFriday()], ['Next Monday', nextMonday()], ['In two weeks', addDaysIso(todayIso(), 14)]];
  return html`<${Popover} anchor=${anchor} onClose=${onClose} width=${230} align="right" cls="menu tk-datepop">
    <div class="menu-head">Target date</div>
    ${quick.map(([l, d]) => html`<button key=${l} class=${`mi ${value === d ? 'active' : ''}`} onClick=${() => pick(d)}><${Icon} name="calendar" /><span class="grow">${l}</span><span class="faint small">${shortDate(d)}</span></button>`)}
    <div class="tk-datepick"><input class="input" type="date" value=${value || ''} aria-label="Pick a date" onChange=${(e) => e.target.value && pick(e.target.value)} /></div>
    ${value ? html`<button class="mi" onClick=${() => pick('')}><${Icon} name="x" /><span class="grow">No date</span></button>` : null}
  </${Popover}>`;
}

/**
 * One task, wherever it shows: tick it off, give it a target date, set its priority, change its words,
 * snooze or dismiss it, ask what's needed, nudge whoever owes it, open where it came from.
 */
export function TaskRow({ t: given, onChanged, compact = false, inCase = false }) {
  const [t, setT] = useState(given);
  useEffect(() => setT(given), [given]);
  const [anchor, openMenu, closeMenu] = useAnchor();
  const [dateAt, openDate, closeDate] = useAnchor();
  const [gone, setGone] = useState(false);
  const [done, setDone] = useState(given.state === 'done');
  useEffect(() => setDone(given.state === 'done'), [given]);
  const act = async (fn, msg, undo) => {
    try {
      await fn();
      setGone(true);
      toast(msg, '', undo ? { label: 'Undo', run: () => call('taskRestore', t.key).then(onChanged, toastError) } : null);
      onChanged && onChanged();
    } catch (e) { toastError(e); }
  };
  const tick = async (on) => {
    try {
      if (on) {
        await call('taskDone', t.key);
        setDone(true);
        toast('Done', '', { label: 'Undo', run: () => call('taskReopen', t.key).then(() => { setDone(false); onChanged && onChanged(); }, toastError) });
        if (onChanged) setTimeout(onChanged, 900);
      } else {
        await call('taskReopen', t.key);
        setDone(false);
        toast('Back on your list');
        onChanged && onChanged();
      }
    } catch (e) { toastError(e); }
  };
  const change = async (patch, msg) => {
    try {
      const n = await call('taskEdit', t.key, patch);
      setT({ ...t, ...n });
      if (msg) toast(msg);
      onChanged && onChanged();
    } catch (e) { toastError(e); }
  };
  if (gone) return null;
  const today = todayIso();
  const late = t.due && t.due < today && !done;
  const hidden = t.state === 'snoozed' || t.state === 'dismissed';
  const live = !hidden && !done;
  const ask = () => askInChat(`What do I still need to know to finish "${t.title.slice(0, 140)}"${t.context ? ` (from ${t.context.slice(0, 80)})` : ''}? List the open questions, who can answer each, and anything missing.`);
  const pri = t.pinned ? t.priority : 'auto';
  const menu = [
    { head: 'Priority' },
    ...PRIS.map(([k, l, hint]) => ({ label: l, hint: k === 'auto' ? 'learned' : '', icon: k === 'auto' ? 'spark' : 'flag', active: pri === k, onClick: () => change({ priority: k }, k === 'auto' ? 'Boardenda will rank it' : `Marked ${l.toLowerCase()}`) })),
    { sep: true },
    { label: 'Ask what is needed', icon: 'help', onClick: ask },
    !t.mine ? { label: 'Copy a check-in message', icon: 'copy', onClick: () => copyNudge(t) } : null,
    t.link ? { label: 'Open where it came from', icon: 'arrowRight', onClick: () => openTaskSource(t) } : null,
    { sep: true },
    { head: 'Snooze' },
    { label: 'Until tomorrow', icon: 'snooze', onClick: () => act(() => call('taskSnooze', t.key, addDaysIso(todayIso(), 1)), 'Snoozed until tomorrow', true) },
    { label: 'Until next Monday', icon: 'calendar', onClick: () => act(() => call('taskSnooze', t.key, nextMonday()), 'Snoozed until Monday', true) },
    { label: 'For a week', icon: 'calendar', onClick: () => act(() => call('taskSnooze', t.key, addDaysIso(todayIso(), 7)), 'Snoozed for a week', true) },
  ];
  return html`<div class=${`tk-row ${t.isNew && live ? 'new' : ''} ${done ? 'done' : ''}`} data-key=${t.key}>
    ${hidden ? html`<span class="tk-ico"><${Icon} name=${t.state === 'snoozed' ? 'snooze' : 'hide'} size="15" /></span>`
      : html`<input type="checkbox" class="tk-check" checked=${done} aria-label=${done ? 'Not done' : 'Done'} title=${done ? 'Put it back on the list' : t.canDone === false ? 'Mark done (this board has no Done status, so it is only taken off your list)' : 'Mark done'} onChange=${(e) => tick(e.target.checked)} />`}
    <div class="grow tk-main">
      <div class="tk-title">${t.isNew && live ? html`<span class="tk-dot" title="New"></span>` : null}${live
        ? html`<${InlineText} value=${t.title} onSave=${(v) => v && change({ title: v })} />` : t.title}</div>
      <div class="small muted tk-meta">
        ${t.who ? html`<span class="tk-who">${t.who}</span>` : null}
        ${inCase ? null : t.link ? html`<a class="link clip" title=${(SRC[t.source] || SRC.own)[1]} onClick=${() => openTaskSource(t)}><${Icon} name=${(SRC[t.source] || SRC.own)[0]} size="12" /> ${t.context || (SRC[t.source] || SRC.own)[1]}</a>` : t.context ? html`<span class="clip">${t.context}</span>` : null}
        ${!compact && t.reason && live ? html`<span class="tk-why">${t.reason}</span>` : null}
        ${t.state === 'snoozed' ? html`<span>until ${shortDate(t.snoozeUntil)}</span>` : null}
      </div>
    </div>
    ${live && t.stalled ? html`<button class="btn small tk-nudge" title=${`Copy a check-in: "${nudgeText(t)}"`} onClick=${() => copyNudge(t)}><${Icon} name="bell" size="13" /> Nudge</button>` : null}
    ${PRI_CHIP[t.priority] && t.pinned ? html`<span class=${`tk-pri ${t.priority}`}>${PRI_CHIP[t.priority]}</span>` : null}
    ${t.due ? html`<button class=${`tk-due ${late ? 'late' : t.due === today ? 'today' : ''}`} title=${live ? `Target ${t.due}. Click to change.` : t.due} disabled=${!live} onClick=${openDate}>${dueLabel(t.due, today)}</button>`
      : live && t.mine ? html`<button class=${`tk-due ${t.needsDate ? 'ask' : 'none'}`} title="When will you finish it? Dated work gets planned into your week." onClick=${openDate}><${Icon} name="calendar" size="12" />${compact ? '' : ' Set date'}</button>` : null}
    ${hidden ? html`<button class="btn small" onClick=${() => act(() => call('taskRestore', t.key), 'Back on your list')}>Restore</button>`
      : live ? html`<button class="btn ghost small icon" title="Priority, snooze and more" aria-label="More" onClick=${openMenu}><${Icon} name="dots" size="15" /></button>
        <button class="btn ghost small icon" title="Not needed: take it off the list" aria-label="Dismiss" onClick=${() => act(() => call('taskDismiss', t.key), 'Dismissed', true)}><${Icon} name="x" size="15" /></button>` : null}
    ${anchor ? html`<${Menu} anchor=${anchor} onClose=${closeMenu} align="right" width=${240} items=${menu} />` : null}
    ${dateAt ? html`<${DatePop} anchor=${dateAt} onClose=${closeDate} value=${t.due || ''} onPick=${(d) => change({ due: d }, d ? `Target ${dueLabel(d, todayIso()).toLowerCase() === 'today' ? 'today' : shortDate(d)}` : 'Date cleared')} />` : null}
  </div>`;
}

/** What to work on which day this week, from dates, priority and how much is already on each day. */
export function WeekPlan({ version, onChanged }) {
  const [w, setW] = useState(null);
  const load = () => call('tasksWeek').then(setW, () => setW({ days: [], later: [] }));
  useEffect(load, [version]);
  if (!w || !w.days.length) return null;
  const today = todayIso();
  const tickDone = (t) => call('taskDone', t.key).then(() => { toast('Done', '', { label: 'Undo', run: () => call('taskReopen', t.key).then(load, toastError) }); load(); onChanged && onChanged(); }, toastError);
  return html`<section class="card td-sec td-week"><div class="row" style="gap:8px;align-items:baseline"><h3>Your week</h3>
      <span class="small muted grow">About ${w.perDay} tasks a day. Dated work lands on or before its date; the rest fills in by priority.</span>
      ${w.later.length ? html`<span class="small muted">${w.later.length} later</span>` : null}</div>
    <div class="td-days">${w.days.map((d) => html`<div key=${d.date} class=${`td-day ${d.date === today ? 'now' : ''}`}>
      <div class="td-dayhead"><b>${d.date === today ? 'Today' : new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' })}</b> <span class="faint small">${shortDate(d.date)}</span>
        <span class=${`td-load ${d.over ? 'over' : ''}`} title=${`${d.load} ${d.load === 1 ? 'task' : 'tasks'}`}>${d.load}</span></div>
      ${d.tasks.length ? d.tasks.map((t) => html`<div key=${t.key} class="tk-mini">
        <input type="checkbox" class="tk-check" aria-label="Done" onChange=${() => tickDone(t)} />
        <span class=${`grow clip ${t.due && t.due < today ? 'bad' : ''}`} title=${`${t.title}${t.reason ? ` (${t.reason})` : ''}`} onClick=${() => openTaskSource(t)}>${t.title}</span></div>`)
        : html`<div class="small faint">Free</div>`}
    </div>`)}</div>
  </section>`;
}

// ------------------------------------------------------------------- tasks
export function TasksPage({ version }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('mine');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [who, setWho] = useState('');
  const marked = useRef(false);
  const load = () => call('tasksList').then((d) => {
    setData(d);
    if (!marked.current) { marked.current = true; setTimeout(() => call('taskSeen', d.mine.filter((t) => t.isNew).map((t) => t.key)).catch(() => {}), 4000); }
  }, toastError);
  useEffect(load, [version]);
  const add = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    try { await call('taskAdd', { title, due, who }); setTitle(''); setDue(''); setWho(''); load(); } catch (err) { toastError(err); }
  };
  if (!data) return html`<div class="page"><${Spinner} /></div>`;
  const list = data[tab] || [];
  const tabs = [['mine', 'Mine', data.mine.length], ['waiting', 'Waiting on others', data.waiting.length], ['snoozed', 'Snoozed', data.snoozed.length], ['dismissed', 'Dismissed', data.dismissed.length]];
  return html`<div class="page tk-page">
    <div class="page-head"><h1>Tasks</h1><span class="muted small">Everything on you and everything you're waiting on, from dropped files, boards and meetings. Highest priority first.</span></div>
    <form class="tk-add card" onSubmit=${add}>
      <input class="input grow" placeholder="Add a task (Enter)" value=${title} onInput=${(e) => setTitle(e.target.value)} aria-label="New task" />
      <input class="input" type="date" value=${due} onInput=${(e) => setDue(e.target.value)} title="Due date" aria-label="Due date" />
      <input class="input" style="width:170px" placeholder="Waiting on (optional)" value=${who} onInput=${(e) => setWho(e.target.value)} aria-label="Waiting on" />
      <button class="btn primary" type="submit" disabled=${!title.trim()}><${Icon} name="plus" size="15" /> Add</button>
    </form>
    <div class="seg mt">${tabs.map(([k, l, n]) => html`<button key=${k} class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}${n ? html` <span class="faint">${n}</span>` : null}</button>`)}</div>
    <div class="card tk-list mt">${list.length ? list.map((t) => html`<${TaskRow} key=${t.key} t=${t} onChanged=${load} />`)
      : html`<div class="pad small muted">${tab === 'mine' ? 'Nothing on your list. Drop an email or a file in Chat and the tasks in it show up here.' : tab === 'waiting' ? 'Nobody owes you anything right now.' : tab === 'snoozed' ? 'No snoozed tasks.' : 'No dismissed tasks.'}</div>`}</div>
  </div>`;
}

// ------------------------------------------------------------------- today
export function TodayPage({ nav, version }) {
  const [b, setB] = useState(null);
  const [tick, setTick] = useState(0);
  const load = () => call('briefing').then((x) => { setB(x); setTick((n) => n + 1); }, toastError);
  useEffect(load, [version]);
  if (!b) return html`<div class="page"><${Spinner} /></div>`;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const dateLabel = new Date(`${b.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const openCase = (id) => window.dispatchEvent(new CustomEvent('bd-open-case', { detail: id }));
  return html`<div class="page td-page">
    <div class="page-head"><div><h1>${greet}</h1><div class="muted small">${dateLabel}</div></div><span class="grow"></span>
      <button class="btn" onClick=${() => call('chatBriefing').then(() => nav('chat'), toastError)}><${Icon} name="msg" size="15" /> Post briefing in chat</button>
      <button class="btn primary" onClick=${() => nav('chat')}><${Icon} name="plus" size="15" /> Drop files</button></div>
    <div class="td-head card pad"><${Icon} name="today" size="22" /><div class="grow"><b class="td-headline">${b.headline}</b>
      <div class="small muted">${b.counts.mine} open ${b.counts.mine === 1 ? 'task' : 'tasks'} for you · ${b.counts.waiting} waiting on others</div></div>
      <button class="btn small" onClick=${() => nav('tasks')}>All tasks</button></div>
    <div class="td-grid">
      <section class="card td-sec td-first"><h3>Do first</h3>
        ${b.top.length ? b.top.map((t) => html`<${TaskRow} key=${t.key} t=${t} onChanged=${load} />`) : html`<div class="small muted pad">Nothing on your list. Drop emails and files in Chat to fill it.</div>`}</section>
      <section class="card td-sec"><h3>Meetings today</h3>
        ${b.meetings.length ? b.meetings.map((m) => html`<button key=${m.id} class="td-line" onClick=${() => window.dispatchEvent(new CustomEvent('bd-open-meeting', { detail: m.id }))}>
          <span class="td-time">${m.time || 'Today'}</span><span class="grow clip">${m.title}${m.customer ? html` <span class="muted">· ${m.customer}</span>` : null}</span><${Icon} name="phone" size="14" /></button>`)
          : html`<div class="small muted pad">No meetings today.</div>`}</section>
      <section class="card td-sec"><h3>Waiting on others</h3>
        ${b.waiting.length ? b.waiting.map((t) => html`<${TaskRow} key=${t.key} t=${t} onChanged=${load} compact />`) : html`<div class="small muted pad">Nobody owes you anything right now.</div>`}</section>
      <section class="card td-sec"><h3>New since yesterday</h3>
        ${b.newCases.length ? b.newCases.slice(0, 8).map((c) => html`<button key=${c.id} class="td-line" onClick=${() => openCase(c.id)}>
          <span class="grow" style="min-width:0"><b class="clip" style="display:block">${c.title}</b><span class="small muted clip" style="display:block">${c.sender ? `${c.sender} · ` : ''}${c.summary}</span></span><${Icon} name="spark" size="14" /></button>`)
          : html`<div class="small muted pad">Nothing new. Files you drop in Chat show up here.</div>`}
        ${b.questions.length ? html`<div class="td-q small"><${Icon} name="help" size="14" /> The assistant has questions for you on ${b.questions.map((q, i) => html`${i ? ', ' : ''}<a key=${q.id} class="link" onClick=${() => openCase(q.id)}>${q.title}</a>`)}</div>` : null}</section>
    </div>
    <${WeekPlan} version=${`${version}:${tick}`} onChanged=${load} />
  </div>`;
}

