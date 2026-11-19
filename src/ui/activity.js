// Activity: a private log of what was in front of you (apps, documents,
// meetings) and, if turned on, what your screens said. Summarize the day and
// recap meetings into tasks and a follow-up email. Everything stays on this PC.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Spinner, Modal, toast, toastError, ask, shortDate, todayIso, addDaysIso } from './lib.js';
import { call, native, isDesktop } from './api.js';
import { answerHtml } from './ask.js';

const hm = (min) => { const h = Math.floor(min / 60), m = min % 60; return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`; };
const dayLabel = (d) => (d === todayIso() ? 'Today' : d === addDaysIso(todayIso(), -1) ? 'Yesterday' : new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }));
const openCase = (id) => window.dispatchEvent(new CustomEvent('bd-open-case', { detail: id }));

function Toggle({ on, onChange, label, hint }) {
  return html`<div class="row between ac-toggle">
    <div><b>${label}</b>${hint ? html`<div class="small muted">${hint}</div>` : null}</div>
    <button class=${`toggle ${on ? 'on' : ''}`} role="switch" aria-checked=${on} aria-label=${label} onClick=${() => onChange(!on)}></button></div>`;
}

async function confirmScreens() {
  return ask({ title: 'Read your screen text?', ok: 'Turn on', danger: false,
    body: 'Every minute or so (every 20 seconds in a meeting) Boardenda takes a picture of your screens and reads the text on them with OCR, on this PC. Pictures and text stay in your Boardenda data folder and are deleted after the days you choose. Windows with words from your private list (passwords, banking, private browsing) are never captured. A red dot on the tray icon shows while it is on.' });
}

/** Recap a meeting: add the transcript or notes; the assistant writes the summary, tasks and follow-up email. */
function RecapModal({ meeting, onClose, onDone }) {
  const [title, setTitle] = useState(meeting ? meeting.title : '');
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const fileIn = useRef(null);
  const add = async (list) => {
    const out = [];
    for (const f of Array.from(list || [])) if (f.size < 40e6) out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    setFiles((x) => [...x, ...out].slice(0, 5));
  };
  const go = async () => {
    setBusy(true);
    try {
      const r = await call('activityRecap', { id: meeting && meeting.id, date: meeting && meeting.date, title, text, files });
      toast('Recap started. It shows in Chat with its tasks and a follow-up email.');
      onDone && onDone(r);
      onClose();
      openCase(r.caseId);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return html`<${Modal} title="Recap a meeting" onClose=${onClose}>
    ${meeting ? html`<div class="small muted" style="margin-bottom:10px">${dayLabel(meeting.date)}, ${meeting.from}–${meeting.to} · ${meeting.app} · ${meeting.minutes} min${meeting.screens ? ` · ${meeting.screens} screen ${meeting.screens === 1 ? 'reading' : 'readings'}` : ''}</div>` : null}
    <label class="small muted">Meeting</label>
    <input class="input" value=${title} placeholder="What was the meeting?" onInput=${(e) => setTitle(e.target.value)} style="width:100%;margin-bottom:10px" />
    <label class="small muted">Transcript or your notes (optional${meeting && meeting.screens ? ': screen text is used too' : ''})</label>
    <textarea class="input ac-recap-text" rows="8" value=${text} placeholder="Paste the Teams transcript, the meeting chat, or your notes" onInput=${(e) => setText(e.target.value)}></textarea>
    <div class="as-drop ac-drop" role="button" tabindex="0" onClick=${() => fileIn.current.click()} onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { e.preventDefault(); add(e.dataTransfer.files); }}>
      <${Icon} name="upload" size="18" /> Drop the transcript file (.vtt or .docx from Teams, or Word, PDF, text)</div>
    <input ref=${fileIn} type="file" multiple accept=".vtt,.docx,.txt,.md,.pdf" style="display:none" onChange=${(e) => add(e.target.files)} />
    ${files.length ? html`<div class="small" style="margin-top:6px">${files.map((f, i) => html`<span key=${i} class="chip">${f.name}<button class="btn ghost icon tiny" aria-label="Remove" onClick=${() => setFiles(files.filter((_, j) => j !== i))}><${Icon} name="x" size="11" /></button></span>`)}</div>` : null}
    <div class="row" style="justify-content:flex-end;gap:8px;margin-top:14px">
      <button class="btn" onClick=${onClose}>Cancel</button>
      <button class="btn primary" disabled=${busy} onClick=${go}>${busy ? html`<${Spinner} />` : html`<${Icon} name="spark" size="15" />`} Make the recap</button></div>
  </${Modal}>`;
}

function ScreenView({ date, file, onClose }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let u = null;
    call('activityShot', date, file).then((b) => { if (b) { u = URL.createObjectURL(new Blob([b], { type: 'image/jpeg' })); setUrl(u); } }, toastError);
    return () => u && URL.revokeObjectURL(u);
  }, [file]);
  return html`<${Modal} title="Screen" wide onClose=${onClose}>${url ? html`<img src=${url} alt="Screen picture" style="max-width:100%;border-radius:8px" />` : html`<${Spinner} />`}</${Modal}>`;
}

function Privacy({ st, save, date, reload }) {
  const [words, setWords] = useState(st.exclude.join(', '));
  useEffect(() => setWords(st.exclude.join(', ')), [st.exclude.join(',')]);
  return html`<section class="card ac-sec"><h3><${Icon} name="shield" size="15" /> Privacy and storage</h3>
    <${Toggle} label="Track my activity" hint="The app and window title in front, every ${st.everySec} seconds. Stops while you are away or the PC is locked." on=${st.enabled} onChange=${(v) => save({ enabled: v })} />
    <${Toggle} label="Read screen text" hint="Pictures of your screens read with OCR on this PC, for meeting recaps and day summaries." on=${st.screens} onChange=${async (v) => { if (v && !(await confirmScreens())) return; save({ screens: v }); }} />
    <${Toggle} label="Let an online AI read it" hint="Off: window titles go to an online AI (Claude or ChatGPT) only for summaries, screen text never does. A local model (Ollama) always gets everything." on=${st.allowCloud} onChange=${(v) => save({ allowCloud: v })} />
    <div class="row between ac-toggle"><div><b>Keep for</b><div class="small muted">Older days are deleted automatically.</div></div>
      <select class="input" style="width:auto" value=${st.keepDays} onChange=${(e) => save({ keepDays: Number(e.target.value) })}>${[1, 3, 7, 14, 30, 90].map((n) => html`<option key=${n} value=${n}>${n} ${n === 1 ? 'day' : 'days'}</option>`)}</select></div>
    <div class="ac-toggle"><b>Never capture windows with these words</b><div class="small muted">Their title is kept as "(private)" and their screen is not read.</div>
      <textarea class="input" rows="2" style="width:100%;margin-top:6px" value=${words} onInput=${(e) => setWords(e.target.value)} onBlur=${() => save({ exclude: words })}></textarea></div>
    <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px">
      ${isDesktop && st.folder ? html`<button class="btn small" onClick=${() => native('openPath', { path: st.folder }).catch(toastError)}><${Icon} name="folder" size="14" /> Open the folder</button>` : null}
      <button class="btn small" onClick=${async () => { if (await ask({ title: `Delete ${dayLabel(date).toLowerCase()}?`, body: 'The log, screen pictures and their text for this day are deleted.' })) { await call('activityDeleteDay', date).catch(toastError); reload(); } }}><${Icon} name="trash" size="14" /> Delete this day</button>
      <button class="btn small" onClick=${async () => { if (await ask({ title: 'Delete all activity?', body: 'Every day of the log, all screen pictures and their text are deleted. Recaps already made stay in Chat.' })) { await call('activityDeleteAll').catch(toastError); reload(); } }}><${Icon} name="trash" size="14" /> Delete everything</button></div>
  </section>`;
}

export function ActivityPage({ version, reloadShell }) {
  const [st, setSt] = useState(null);
  const [date, setDate] = useState(todayIso());
  const [days, setDays] = useState([]);
  const [d, setD] = useState(null);
  const [recap, setRecap] = useState(null); // meeting or {}
  const [summ, setSumm] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  const [shot, setShot] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const load = async () => {
    try {
      const [s, ds, day] = await Promise.all([call('activityStatus'), call('activityDays'), call('activityDay', date)]);
      setSt(s); setDays(ds); setD(day);
    } catch (e) { toastError(e); }
  };
  useEffect(() => { load(); }, [date, version]);
  useEffect(() => { const t = setInterval(load, 60000); return () => clearInterval(t); }, [date]);
  const save = async (patch) => { try { setSt(await call('setActivity', patch)); reloadShell && reloadShell(); load(); } catch (e) { toastError(e); } };
  if (!st || !d) return html`<div class="page"><${Spinner} /></div>`;

  const summarize = async () => { setSumm(true); try { await call('activitySummarize', date); await load(); } catch (e) { toastError(e); } finally { setSumm(false); } };
  const search = async (e) => { e.preventDefault(); try { setHits(q.trim() ? await call('activitySearch', q) : null); } catch (err) { toastError(err); } };
  const startStop = async () => {
    try {
      if (st.meeting) { const m = await call('activityMeetingStop'); await load(); if (m) setRecap(m); }
      else { await call('activityMeetingStart', ''); toast('Meeting started. Screens are read more often until you stop it.'); load(); }
      reloadShell && reloadShell();
    } catch (e) { toastError(e); }
  };

  if (!st.enabled && !d.timeline.length) {
    return html`<div class="page ac-page">
      <div class="page-head"><div><h1>Activity</h1><div class="muted small">Meeting recaps and a private log of your day</div></div></div>
      <div class="card ac-hero"><${Icon} name="clock" size="30" />
        <h2>Let Boardenda keep track of your day</h2>
        <ul class="ac-list">
          <li><b>Your day, summarized:</b> time per app, the documents, emails and customers you worked on, and loose ends. Ask in Chat: “what did I do today?”</li>
          <li><b>Meeting recaps:</b> Teams, Zoom, Webex and Meet calls are spotted on their own. Add the transcript or your notes and get the summary, decisions, your tasks and a follow-up email.</li>
          <li><b>Screen text (optional):</b> reads shared slides, meeting chat and captions from your screens with OCR, so a recap works even without a transcript.</li>
          <li><b>Private:</b> kept only on this PC, deleted after ${st.keepDays} days, paused while you are away. A red dot on the tray icon shows when it is on, and you can pause or stop it there.</li>
        </ul>
        <div class="row" style="gap:8px;justify-content:center">
          <button class="btn primary" onClick=${() => save({ enabled: true })}><${Icon} name="play" size="15" /> Track my activity</button>
          <button class="btn" onClick=${async () => { if (await confirmScreens()) save({ enabled: true, screens: true }); }}><${Icon} name="eye" size="15" /> Also read screen text</button>
          <button class="btn ghost" onClick=${() => setRecap({})}><${Icon} name="spark" size="15" /> Recap a meeting from a transcript</button></div>
      </div>
      ${recap ? html`<${RecapModal} meeting=${recap.id ? recap : null} onClose=${() => setRecap(null)} onDone=${load} />` : null}
    </div>`;
  }

  const dayList = [...new Set([todayIso(), ...days])].sort().reverse();
  const stateLabel = st.watching ? (st.recordingScreens ? 'Tracking activity and reading screen text' : 'Tracking activity') : st.paused ? `Paused until ${new Date(st.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Tracking is off';
  const maxApp = Math.max(1, ...d.apps.map((a) => a.minutes));
  const timeline = showAll ? d.timeline : d.timeline.slice(-25);

  return html`<div class="page ac-page">
    <div class="page-head"><div><h1>Activity</h1><div class="muted small">Meeting recaps and a private log of your day</div></div><span class="grow"></span>
      <select class="input" style="width:auto" aria-label="Day" value=${date} onChange=${(e) => { setDate(e.target.value); setHits(null); }}>${dayList.map((x) => html`<option key=${x} value=${x}>${dayLabel(x)}</option>`)}</select>
      <button class="btn" onClick=${() => setRecap({})}><${Icon} name="spark" size="15" /> Recap from a transcript</button></div>

    <div class=${`card ac-status ${st.watching ? (st.recordingScreens ? 'rec' : 'on') : ''}`}>
      <span class="ac-dot"></span><div class="grow"><b>${stateLabel}</b>
        <div class="small muted">${st.meeting ? `In a meeting since ${new Date(st.meeting.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. ` : ''}Kept on this PC for ${st.keepDays} days.</div></div>
      ${st.enabled ? html`<button class="btn small" onClick=${startStop}><${Icon} name=${st.meeting ? 'pause' : 'phone'} size="14" /> ${st.meeting ? 'End meeting and recap' : 'Start a meeting'}</button>` : null}
      ${st.enabled ? (st.paused ? html`<button class="btn small" onClick=${() => save({ pauseMinutes: 0 })}><${Icon} name="play" size="14" /> Resume</button>`
        : html`<button class="btn small" onClick=${() => save({ pauseMinutes: 60 })}><${Icon} name="pause" size="14" /> Pause 1 hour</button>`) : null}
      <button class=${`btn small ${st.enabled ? '' : 'primary'}`} onClick=${() => save({ enabled: !st.enabled })}>${st.enabled ? 'Turn off' : 'Turn on'}</button>
    </div>

    <div class="ac-grid">
      <section class="card ac-sec ac-meetings"><h3><${Icon} name="phone" size="15" /> Meetings</h3>
        ${d.meetings.length ? d.meetings.map((m) => html`<div key=${m.id} class="ac-meet">
          <span class="td-time">${m.from}</span>
          <div class="grow" style="min-width:0"><b class="clip" style="display:block">${m.title}</b>
            <span class="small muted">${m.app} · ${m.live ? 'now' : `${m.minutes} min`}${m.screens ? ` · ${m.screens} screen ${m.screens === 1 ? 'reading' : 'readings'}` : ''}</span></div>
          ${m.recap ? html`<button class="btn small" onClick=${() => openCase(m.recap.caseId)}><${Icon} name="spark" size="14" /> Open recap</button>`
            : m.live ? null : html`<button class="btn small primary" onClick=${() => setRecap(m)}><${Icon} name="spark" size="14" /> Recap</button>`}
        </div>`) : html`<div class="small muted pad">No meetings ${date === todayIso() ? 'yet today' : 'on this day'}. Teams, Zoom, Webex and Meet calls show up here on their own, or use <b>Start a meeting</b> for a phone call.</div>`}
      </section>

      <section class="card ac-sec"><h3><${Icon} name="spark" size="15" /> ${dayLabel(date)}${d.totalMinutes ? html` <span class="muted small">· ${hm(d.totalMinutes)} at the PC${d.first ? `, ${d.first}–${d.last}` : ''}</span>` : null}</h3>
        ${d.summary ? html`<div class="ac-summary answer" dangerouslySetInnerHTML=${{ __html: answerHtml(d.summary.text) }}></div>
          ${d.summary.note ? html`<div class="small muted">${d.summary.note}</div>` : null}` : html`<div class="small muted">${d.timeline.length ? 'Get a short summary of what you worked on, your meetings and loose ends.' : 'Nothing tracked on this day yet.'}</div>`}
        ${d.timeline.length ? html`<button class="btn small" style="margin-top:8px" disabled=${summ} onClick=${summarize}>${summ ? html`<${Spinner} />` : html`<${Icon} name="refresh" size="14" />`} ${d.summary ? 'Summarize again' : 'Summarize my day'}</button>` : null}
      </section>

      <section class="card ac-sec"><h3><${Icon} name="chart" size="15" /> Time by app</h3>
        ${d.apps.length ? d.apps.slice(0, 8).map((a) => html`<div key=${a.app} class="ac-bar"><span class="ac-bar-l clip">${a.app}</span><span class="ac-bar-t"><span style=${`width:${Math.round((a.minutes / maxApp) * 100)}%`}></span></span><span class="small muted ac-bar-v">${hm(a.minutes)}</span></div>`)
          : html`<div class="small muted">Nothing yet.</div>`}
        ${d.topics.length ? html`<h3 style="margin-top:14px"><${Icon} name="file" size="15" /> What you worked on</h3>${d.topics.slice(0, 10).map((t, i) => html`<div key=${i} class="ac-topic"><span class="grow clip">${t.label}</span><span class="small muted">${t.app} · ${hm(t.minutes)}</span></div>`)}` : null}
      </section>

      <section class="card ac-sec"><h3><${Icon} name="search" size="15" /> Find something you saw</h3>
        <form class="row" style="gap:6px" onSubmit=${search}><input class="input grow" placeholder="A name, number or phrase from a window or screen" value=${q} onInput=${(e) => setQ(e.target.value)} /><button class="btn small">Search</button></form>
        ${hits ? (hits.length ? hits.map((h, i) => html`<div key=${i} class="ac-hit"><div class="small"><b>${dayLabel(h.date)} ${h.time}</b> · ${h.app}${h.title && h.title !== '(private)' ? ` · ${h.title}` : ''}</div>
            ${h.snippet ? html`<div class="small muted ac-snip">…${h.snippet}…</div>` : null}
            ${h.file ? html`<button class="btn ghost tiny" onClick=${() => setShot({ date: h.date, file: h.file })}><${Icon} name="eye" size="12" /> View screen</button>` : null}</div>`)
          : html`<div class="small muted pad">Nothing found in the last ${st.keepDays} days.</div>`) : html`<div class="small muted" style="margin-top:6px">${st.screens ? 'Searches window titles and the text read from your screens.' : 'Searches window titles. Turn on screen text to search what was on screen too.'}</div>`}
      </section>
    </div>

    ${d.timeline.length ? html`<section class="card ac-sec"><h3><${Icon} name="timeline" size="15" /> Timeline</h3>
      ${!showAll && d.timeline.length > 25 ? html`<button class="btn ghost small" onClick=${() => setShowAll(true)}>Show all ${d.timeline.length}</button>` : null}
      ${timeline.map((b, i) => html`<div key=${i} class=${`ac-line ${b.meeting ? 'meet' : ''}`}><span class="td-time">${b.from}</span><span class="ac-app">${b.app}</span><span class="grow clip">${b.label}</span><span class="small muted">${b.minutes} min</span></div>`)}
    </section>` : null}

    <${Privacy} st=${st} save=${save} date=${date} reload=${load} />
    ${recap ? html`<${RecapModal} meeting=${recap.id ? recap : null} onClose=${() => setRecap(null)} onDone=${load} />` : null}
    ${shot ? html`<${ScreenView} date=${shot.date} file=${shot.file} onClose=${() => setShot(null)} />` : null}
  </div>`;
}

/** The sidebar line that shows tracking is on, always visible while it is. */
export function ActivityPill({ a, onClick }) {
  if (!a || !(a.watching || a.paused)) return null;
  const label = a.paused ? 'Activity paused' : a.meeting ? 'In a meeting' : a.recordingScreens ? 'Reading screens' : 'Tracking activity';
  return html`<button class=${`ac-pill ${a.paused ? 'paused' : a.recordingScreens ? 'rec' : 'on'}`} title="Activity tracking is on. Click to see it, pause it or turn it off." onClick=${onClick}><span class="ac-dot"></span>${label}</button>`;
}
