// Today and Tasks: one list of what is on me and what I'm waiting on, from
// dropped files, boards and meetings, ranked by priority with the reason, and
// the morning briefing.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Spinner, toast, toastError, Menu, useAnchor, shortDate, todayIso, addDaysIso, diffDays } from './lib.js';
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

/** One task: tick it off, snooze it, dismiss it, open where it came from. */
export function TaskRow({ t, onChanged, compact = false }) {
  const [anchor, openMenu, closeMenu] = useAnchor();
  const [gone, setGone] = useState(false);
  const act = async (fn, msg, undo) => {
    try {
      await fn();
      setGone(true);
      toast(msg, '', undo ? { label: 'Undo', run: () => call('taskRestore', t.key).then(onChanged, toastError) } : null);
      onChanged && onChanged();
    } catch (e) { toastError(e); }
  };
  if (gone) return null;
  const today = todayIso();
  const late = t.due && t.due < today;
  const hidden = t.state === 'snoozed' || t.state === 'dismissed';
  return html`<div class=${`tk-row ${t.isNew ? 'new' : ''}`}>
    ${hidden ? html`<span class="tk-ico"><${Icon} name=${t.state === 'snoozed' ? 'snooze' : 'hide'} size="15" /></span>`
      : html`<input type="checkbox" class="tk-check" aria-label="Done" title=${t.canDone ? 'Mark done' : 'Mark done (this board has no Done status, so it is only taken off your list)'} onChange=${() => act(() => call('taskDone', t.key), 'Done')} />`}
    <div class="grow tk-main">
      <div class="tk-title">${t.isNew ? html`<span class="tk-dot" title="New"></span>` : null}${t.title}</div>
      <div class="small muted tk-meta">
        ${t.who ? html`<span class="tk-who">${t.who}</span>` : null}
        ${t.link ? html`<a class="link clip" title=${SRC[t.source][1]} onClick=${() => openTaskSource(t)}><${Icon} name=${SRC[t.source][0]} size="12" /> ${t.context || SRC[t.source][1]}</a>` : t.context ? html`<span class="clip">${t.context}</span>` : null}
        ${!compact && t.reason ? html`<span class="tk-why">${t.reason}</span>` : null}
        ${t.state === 'snoozed' ? html`<span>until ${shortDate(t.snoozeUntil)}</span>` : null}
      </div>
    </div>
    ${t.due ? html`<span class=${`tk-due ${late ? 'late' : t.due === today ? 'today' : ''}`} title=${t.due}>${dueLabel(t.due, today)}</span>` : null}
    ${hidden ? html`<button class="btn small" onClick=${() => act(() => call('taskRestore', t.key), 'Back on your list')}>Restore</button>`
      : html`<button class="btn ghost small icon" title="Snooze" aria-label="Snooze" onClick=${openMenu}><${Icon} name="snooze" size="15" /></button>
        <button class="btn ghost small icon" title="Not needed: take it off the list" aria-label="Dismiss" onClick=${() => act(() => call('taskDismiss', t.key), 'Dismissed', true)}><${Icon} name="x" size="15" /></button>`}
    ${anchor ? html`<${Menu} anchor=${anchor} onClose=${closeMenu} align="right" items=${[
      { label: 'Until tomorrow', icon: 'snooze', onClick: () => act(() => call('taskSnooze', t.key, addDaysIso(todayIso(), 1)), 'Snoozed until tomorrow', true) },
      { label: 'Until next Monday', icon: 'calendar', onClick: () => act(() => call('taskSnooze', t.key, nextMonday()), 'Snoozed until Monday', true) },
      { label: 'For a week', icon: 'calendar', onClick: () => act(() => call('taskSnooze', t.key, addDaysIso(todayIso(), 7)), 'Snoozed for a week', true) },
    ]} />` : null}
  </div>`;
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
  const load = () => call('briefing').then(setB, toastError);
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
  </div>`;
}

