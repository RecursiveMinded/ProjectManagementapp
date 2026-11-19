'use strict';
// Activity and meeting recaps. When the user turns it on, the desktop app notes
// which window is in front (app and title) every half minute and, only if the
// user also turns on screen notes, takes a picture of the screen now and then
// and reads its text with OCR on this PC. Nothing is uploaded: it is kept in
// <data folder>/Activity/<date>/ for a set number of days, then deleted.
// From that it builds the day (time per app, a timeline, the meetings held)
// and, on request, a summary of the day or a meeting recap. A recap goes to the
// assistant like a dropped file, so it gets a summary, tasks and a follow-up
// email, and its tasks join the one task list.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { now, today, addDays, parseJson } = require('./util');

const DEFAULTS = {
  enabled: false,          // note the window in front
  screens: false,          // also read the screen's text (OCR)
  everySec: 30,
  screenEverySec: 60,
  keepDays: 7,
  allowCloud: false,       // let a cloud AI read window titles and screen text
  exclude: ['password', '1password', 'bitwarden', 'keepass', 'lastpass', 'inprivate', 'incognito', 'private browsing', 'bank'],
  pausedUntil: null,
};

// Meeting windows in Teams, Zoom, Webex, Google Meet, GoTo, Slack huddles and Skype.
const MEETING_APPS = /^(teams|ms-teams|msteams|zoom|cpthost|webex|ciscowebex|atmgr|gotomeeting|g2mlauncher|skype|lync|slack)$/i;
const MEETING_TITLE = /\b(meeting|call with|call in progress|huddle|webinar|zoom meeting|meet - |google meet|webex|gotomeeting|screen sharing|is presenting|sharing)\b|\| microsoft teams.*(call|meeting)|^meet\b/i;
const NOT_MEETING = /\b(chat|activity|calendar|files|teams and channels)\s*\|/i;
const TEAMS_PAGES = /^(chat|activity|calendar|calls|files|teams|teams and channels|apps|onedrive|copilot|assignments|approvals|planner|shifts|viva.*|search|settings|notifications|microsoft teams|new chat|community|people)$/i;
const IDLE_SEC = 300;
const GAP_SEC = 150;          // a block ends after this much silence
const MEETING_MIN_SEC = 240;  // shorter than 4 minutes is not a meeting
const MEETING_GAP_SEC = 300;  // switching away for under 5 minutes stays in the meeting

const pad = (n) => String(n).padStart(2, '0');
const localTime = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const minutes = (sec) => Math.max(1, Math.round(sec / 60));
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** "Quarterly review - Contoso | Microsoft Teams" -> "Quarterly review - Contoso" */
function cleanTitle(title, app) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/\s*[|–—-]\s*(Microsoft Teams|Teams|Zoom( Workplace| Meeting)?|Google Chrome|Microsoft Edge|Mozilla Firefox|Outlook|Microsoft Outlook|Word|Excel|PowerPoint|OneNote|Notepad|Webex)\s*$/i, '');
  t = t.replace(/^\(\d+\)\s*/, '');
  return t || String(app || '');
}

/** A friendly app name from a process name. */
function appName(proc, desc) {
  const p = String(proc || '').replace(/\.exe$/i, '');
  const known = { msedge: 'Edge', chrome: 'Chrome', firefox: 'Firefox', outlook: 'Outlook', olk: 'Outlook', winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint', onenote: 'OneNote', 'ms-teams': 'Teams', msteams: 'Teams', teams: 'Teams', zoom: 'Zoom', cpthost: 'Zoom', explorer: 'File Explorer', notepad: 'Notepad', code: 'VS Code', slack: 'Slack', acrobat: 'Acrobat', acrord32: 'Acrobat', boardenda: 'Boardenda', electron: 'Boardenda', webex: 'Webex', ciscowebex: 'Webex', atmgr: 'Webex' };
  return known[p.toLowerCase()] || String(desc || '').trim() || p || 'Unknown';
}

function isMeeting(s) {
  if (!s || !s.title) return false;
  if (NOT_MEETING.test(s.title)) return false;
  const proc = String(s.proc || s.app || '').replace(/\.exe$/i, '');
  if (/^(zoom|cpthost)$/i.test(proc) && /zoom meeting|meeting|webinar/i.test(s.title)) return true;
  if (MEETING_APPS.test(proc) || /teams|zoom|webex/i.test(s.app || '')) {
    if (MEETING_TITLE.test(s.title) || /\bcall\b/i.test(s.title)) return true;
    // A Teams meeting window is titled "<meeting name> | Microsoft Teams"; its other pages are "Chat | …", "Calendar | …".
    const parts = s.title.split(/\s+\|\s+/);
    return /teams/i.test(`${proc} ${s.app}`) && parts.length === 2 && /^Microsoft Teams/i.test(parts[1]) && !TEAMS_PAGES.test(parts[0].trim());
  }
  return /meet\.google\.com|Google Meet|^Meet - /i.test(s.title);
}

/** Speaker lines from a Teams or Zoom transcript (.vtt), without timestamps. */
function vttText(text) {
  const out = [];
  let last = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || /^WEBVTT/i.test(l) || /-->/.test(l) || /^\d+$/.test(l) || /^NOTE\b/.test(l)) continue;
    const m = l.match(/^<v ([^>]+)>(.*?)(<\/v>)?$/);
    const line = m ? `${m[1].trim()}: ${m[2].trim()}` : l.replace(/<[^>]+>/g, '');
    if (line && line !== last) out.push(line);
    last = line;
  }
  return out.join('\n');
}

class Activity {
  /**
   * capture: the AI (askText), assistant: makes the recap a case, chat: posts it,
   * readFile(name, bytes): text of a transcript file, ocr(bytes): screen text.
   */
  constructor({ db, dataDir, capture, assistant, readFile, ocr }) {
    this.db = db;
    this.dir = dataDir ? path.join(dataDir, 'Activity') : null;
    this.capture = capture;
    this.assistant = assistant;
    this.readFile = readFile;
    this.ocr = ocr || null;
    this.mem = {}; // date -> lines, when there is no data folder (tests)
    this.memDay = {};
    this.lastShot = null;
    this.ocrQueue = Promise.resolve();
    this.chat = null;
  }

  // -------------------------------------------------------------- settings
  settings() {
    const r = this.db.get("SELECT value FROM settings WHERE key='activity'");
    const s = { ...DEFAULTS, ...parseJson(r && r.value, {}) };
    if (s.pausedUntil && new Date(s.pausedUntil) <= new Date()) s.pausedUntil = null;
    return s;
  }
  setSettings(patch = {}) {
    const cur = this.settings();
    const next = { ...cur };
    for (const k of ['enabled', 'screens', 'allowCloud']) if (patch[k] !== undefined) next[k] = !!patch[k];
    if (patch.everySec !== undefined) next.everySec = Math.min(300, Math.max(10, Number(patch.everySec) || DEFAULTS.everySec));
    if (patch.screenEverySec !== undefined) next.screenEverySec = Math.min(900, Math.max(20, Number(patch.screenEverySec) || DEFAULTS.screenEverySec));
    if (patch.keepDays !== undefined) next.keepDays = Math.min(90, Math.max(1, Math.round(Number(patch.keepDays) || DEFAULTS.keepDays)));
    if (patch.exclude !== undefined) next.exclude = (Array.isArray(patch.exclude) ? patch.exclude : String(patch.exclude).split(/[,\n]/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 100);
    if (patch.pausedUntil !== undefined) next.pausedUntil = patch.pausedUntil || null;
    if (patch.pauseMinutes !== undefined) next.pausedUntil = Number(patch.pauseMinutes) > 0 ? new Date(Date.now() + Number(patch.pauseMinutes) * 60000).toISOString() : null;
    if (next.screens && !cur.screens) next.enabled = true; // screen notes need the tracker
    if (!next.enabled) { next.screens = false; next.pausedUntil = null; }
    this.db.run("INSERT INTO settings(key,value) VALUES('activity',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(next)]);
    return this.status();
  }

  /** What the app shows: on/off, paused, in a meeting, where the data is. */
  status() {
    const s = this.settings();
    const meeting = this.openMeeting();
    return {
      ...s,
      paused: s.enabled && !!s.pausedUntil,
      watching: s.enabled && !s.pausedUntil,
      recordingScreens: s.enabled && s.screens && !s.pausedUntil,
      folder: this.dir,
      meeting,
    };
  }

  /** Window titles with these words are not kept (only the app), and their screen is never read. */
  excluded(s, cfg = this.settings()) {
    const hay = `${s.title || ''} ${s.app || ''} ${s.proc || ''}`.toLowerCase();
    return cfg.exclude.some((w) => w && hay.includes(w));
  }

  // --------------------------------------------------------------- storage
  dayDir(date) { return this.dir ? path.join(this.dir, date) : null; }
  append(date, line) {
    if (!this.dir) { (this.mem[date] = this.mem[date] || []).push(line); return; }
    const d = this.dayDir(date);
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, 'log.jsonl'), `${JSON.stringify(line)}\n`);
  }
  lines(date) {
    if (!this.dir) return (this.mem[date] || []).slice();
    const f = path.join(this.dayDir(date), 'log.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => parseJson(l, null)).filter(Boolean);
  }
  dayMeta(date) {
    if (!this.dir) return this.memDay[date] || {};
    return parseJson((() => { try { return fs.readFileSync(path.join(this.dayDir(date), 'day.json'), 'utf8'); } catch (_) { return ''; } })(), {});
  }
  saveDayMeta(date, patch) {
    const next = { ...this.dayMeta(date), ...patch };
    if (!this.dir) { this.memDay[date] = next; return next; }
    fs.mkdirSync(this.dayDir(date), { recursive: true });
    fs.writeFileSync(path.join(this.dayDir(date), 'day.json'), JSON.stringify(next, null, 1));
    return next;
  }
  days() {
    const set = new Set(Object.keys(this.mem));
    if (this.dir && fs.existsSync(this.dir)) for (const d of fs.readdirSync(this.dir)) if (isDate(d)) set.add(d);
    return [...set].sort().reverse();
  }

  // -------------------------------------------------------------- recording
  /**
   * One look at the window in front: { app, proc, title, idleSec, at }.
   * Returns what was kept, or null when off, paused, idle or locked.
   */
  record(sample = {}) {
    const cfg = this.settings();
    if (!cfg.enabled || cfg.pausedUntil) return null;
    if (sample.locked || Number(sample.idleSec || 0) >= IDLE_SEC) return null;
    const at = sample.at || now();
    const s = { t: 'w', at, app: appName(sample.proc || sample.app, sample.app), proc: String(sample.proc || '').replace(/\.exe$/i, ''), title: String(sample.title || '').slice(0, 300) };
    if (this.excluded(s, cfg)) s.title = '(private)';
    if (isMeeting(s)) s.meeting = true;
    this.append(today(new Date(at)), s);
    return s;
  }

  /** Should the desktop app take a screen picture now? */
  wantShot(sample = {}, at = new Date()) {
    const cfg = this.settings();
    if (!cfg.enabled || !cfg.screens || cfg.pausedUntil) return false;
    if (sample.locked || Number(sample.idleSec || 0) >= IDLE_SEC) return false;
    if (this.excluded({ title: sample.title, app: sample.app, proc: sample.proc }, cfg)) return false;
    const every = (this.openMeeting() || isMeeting({ ...sample, app: appName(sample.proc || sample.app, sample.app) }) ? Math.min(cfg.screenEverySec, 20) : cfg.screenEverySec) * 1000;
    return !this.lastShot || at - this.lastShot >= every - 1500;
  }

  /**
   * A screen picture (JPEG bytes). It is kept as a file and its text is read with OCR
   * in the background; a picture whose text did not change is dropped.
   */
  async addShot({ bytes, at = now(), app = '', title = '', screen = 0 } = {}) {
    const cfg = this.settings();
    if (!cfg.enabled || !cfg.screens || cfg.pausedUntil || !bytes) return null;
    this.lastShot = new Date(at);
    const date = today(new Date(at));
    const name = `${localTime(at).replace(':', '')}${pad(new Date(at).getSeconds())}-${screen}.jpg`;
    let file = null;
    if (this.dir) {
      const d = path.join(this.dayDir(date), 'screens');
      fs.mkdirSync(d, { recursive: true });
      file = path.join(d, name);
      fs.writeFileSync(file, Buffer.from(bytes));
    }
    const job = this.ocrQueue.then(async () => {
      let text = '';
      try { text = this.ocr ? String((await this.ocr(Buffer.from(bytes))).text || '') : ''; } catch (_) { text = ''; }
      text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
      const h = crypto.createHash('sha1').update(text.replace(/\d+/g, '')).digest('hex').slice(0, 12);
      const prev = this.lastHash && this.lastHash[screen];
      this.lastHash = { ...(this.lastHash || {}), [screen]: h };
      if (prev === h || text.length < 20) {
        // Same screen as last time, or nothing readable: keep only the newest picture of it.
        if (file && prev === h) { try { fs.unlinkSync(file); } catch (_) { /* gone */ } }
        if (prev === h) return null;
      }
      const line = { t: 's', at, file: file ? `screens/${name}` : null, screen, app: appName(app, app), title: this.excluded({ title, app }, cfg) ? '(private)' : String(title).slice(0, 300), text };
      this.append(date, line);
      return line;
    });
    this.ocrQueue = job.catch(() => null);
    return job;
  }

  /** The bytes of a kept screen picture. */
  shot(date, file) {
    if (!this.dir || !isDate(date) || !/^screens\/[\w-]+\.jpg$/.test(String(file))) return null;
    const p = path.join(this.dayDir(date), file);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }

  // -------------------------------------------------------- manual meetings
  /** Start a meeting by hand (for a phone call or one in a room). Screens are read more often while it runs. */
  meetingStart(title = '') {
    const open = this.openMeeting();
    if (open) return open;
    const at = now();
    this.append(today(), { t: 'm', at, on: true, title: String(title || '').trim() || 'Meeting' });
    return this.openMeeting();
  }
  meetingStop() {
    const open = this.openMeeting();
    if (!open) return null;
    const at = now();
    this.append(today(), { t: 'm', at, on: false, title: open.title });
    const m = this.day(today()).meetings.find((x) => x.manual && x.start === open.start);
    return m || null;
  }
  openMeeting() {
    let open = null;
    for (const l of this.lines(today())) if (l.t === 'm') open = l.on ? { title: l.title, start: l.at } : null;
    return open;
  }

  // ------------------------------------------------------------------ a day
  /** Totals only (cheap): minutes tracked and the top apps. */
  dayTotals(date) {
    const d = this.day(date);
    return { minutes: d.totalMinutes, meetings: d.meetings.length, top: d.apps.slice(0, 3) };
  }

  /**
   * The day: blocks of the same window, time per app, meetings (detected and started
   * by hand), and what screens said. Each sample counts for the time until the next one.
   */
  day(date = today()) {
    if (!isDate(date)) throw new Error('Pick a day.');
    const all = this.lines(date);
    const meta = this.dayMeta(date);
    const ws = all.filter((l) => l.t === 'w').sort((a, b) => (a.at < b.at ? -1 : 1));
    const shots = all.filter((l) => l.t === 's').sort((a, b) => (a.at < b.at ? -1 : 1));
    const step = this.settings().everySec;
    const blocks = [];
    for (let i = 0; i < ws.length; i++) {
      const s = ws[i];
      const t = Date.parse(s.at);
      const next = ws[i + 1] ? Date.parse(ws[i + 1].at) : t + step * 1000;
      const dur = Math.min((next - t) / 1000, step * 2, GAP_SEC);
      const last = blocks[blocks.length - 1];
      if (last && last.app === s.app && last.title === s.title && t - Date.parse(last.end) <= GAP_SEC * 1000) {
        last.end = new Date(t + dur * 1000).toISOString();
        last.sec += dur;
      } else {
        blocks.push({ start: s.at, end: new Date(t + dur * 1000).toISOString(), app: s.app, title: s.title, label: cleanTitle(s.title, s.app), sec: dur, meeting: !!s.meeting });
      }
    }
    const appSec = {};
    for (const b of blocks) appSec[b.app] = (appSec[b.app] || 0) + b.sec;
    const total = Object.values(appSec).reduce((a, b) => a + b, 0);
    const apps = Object.entries(appSec).sort((a, b) => b[1] - a[1]).map(([app, sec]) => ({ app, minutes: minutes(sec), share: total ? Math.round((sec / total) * 100) : 0 }));
    // What was worked on: window titles (documents, emails, pages), by time.
    const topicSec = {};
    for (const b of blocks) if (b.title && b.title !== '(private)' && b.label !== b.app) topicSec[`${b.app}\u0000${b.label}`] = (topicSec[`${b.app}\u0000${b.label}`] || 0) + b.sec;
    const topics = Object.entries(topicSec).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, sec]) => { const [app, label] = k.split('\u0000'); return { app, label, minutes: minutes(sec) }; });

    // Meetings: runs of meeting windows (short switches away stay inside), plus ones started by hand.
    const meetings = [];
    let cur = null;
    for (const b of blocks.filter((x) => x.meeting)) {
      if (cur && Date.parse(b.start) - Date.parse(cur.end) <= MEETING_GAP_SEC * 1000) {
        cur.end = b.end; cur.sec += b.sec;
        if (b.sec > cur.bestSec && b.label !== b.app) { cur.title = b.label; cur.bestSec = b.sec; }
      } else {
        if (cur) meetings.push(cur);
        cur = { start: b.start, end: b.end, app: b.app, title: b.label, bestSec: b.sec, sec: b.sec };
      }
    }
    if (cur) meetings.push(cur);
    const found = meetings.filter((m) => m.sec >= MEETING_MIN_SEC || (Date.parse(m.end) - Date.parse(m.start)) / 1000 >= MEETING_MIN_SEC);
    let open = null;
    for (const l of all.filter((x) => x.t === 'm').sort((a, b) => (a.at < b.at ? -1 : 1))) {
      if (l.on && !open) open = l;
      else if (!l.on && open) { found.push({ start: open.at, end: l.at, app: 'Started by you', title: open.title, manual: true }); open = null; }
    }
    if (open) found.push({ start: open.at, end: null, app: 'Started by you', title: open.title, manual: true, live: true });
    const recaps = meta.recaps || {};
    const shaped = found.sort((a, b) => (a.start < b.start ? -1 : 1)).map((m) => {
      const id = `${date}T${localTime(m.start)}`;
      const end = m.end || now();
      const inside = shots.filter((s) => s.at >= m.start && s.at <= end);
      return { id, date, start: m.start, end: m.end, from: localTime(m.start), to: m.end ? localTime(m.end) : 'now', minutes: minutes((Date.parse(end) - Date.parse(m.start)) / 1000), app: m.app, title: m.title || 'Meeting', manual: !!m.manual, live: !!m.live, screens: inside.length, recap: recaps[id] || null };
    });
    return {
      date, totalMinutes: total ? minutes(total) : 0, first: ws[0] ? localTime(ws[0].at) : null, last: ws.length ? localTime(ws[ws.length - 1].at) : null,
      apps, topics, meetings: shaped,
      timeline: blocks.filter((b) => b.sec >= 45 || b.meeting).map((b) => ({ ...b, from: localTime(b.start), to: localTime(b.end), minutes: minutes(b.sec) })),
      screens: shots.map((s) => ({ at: s.at, time: localTime(s.at), app: s.app, title: s.title, file: s.file, text: s.text.slice(0, 600), chars: s.text.length })),
      summary: meta.summary || null,
    };
  }

  /** Screen text that contains these words, newest first, across kept days. */
  search(q, { limit = 30 } = {}) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (!words.length) return [];
    const out = [];
    for (const date of this.days()) {
      for (const l of this.lines(date).reverse()) {
        if (l.t !== 's' && l.t !== 'w') continue;
        const hay = `${l.title} ${l.text || ''}`.toLowerCase();
        if (words.every((w) => hay.includes(w))) {
          const i = l.text ? l.text.toLowerCase().indexOf(words[0]) : -1;
          out.push({ date, time: localTime(l.at), at: l.at, app: l.app, title: l.title, file: l.file || null, snippet: i >= 0 ? l.text.slice(Math.max(0, i - 120), i + 240) : '' });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------ AI helpers
  async cloudAllowed() {
    const { engine } = await this.capture.pickEngine();
    const cloud = engine !== 'local' && engine !== 'basic';
    return { engine, cloud, ok: !cloud || this.settings().allowCloud };
  }

  /** Text the AI reads for a stretch of the day: windows in order with minutes, and what screens said. */
  digestText(date, from = null, to = null, { screens = true, maxChars = 24000 } = {}) {
    const d = this.day(date);
    const inRange = (at) => (!from || at >= from) && (!to || at <= to);
    const rows = d.timeline.filter((b) => inRange(b.start) || inRange(b.end)).map((b) => `${b.from}-${b.to} ${b.app}: ${b.label}${b.meeting ? ' [meeting]' : ''} (${b.minutes} min)`);
    let text = `Windows in front (${date}):\n${rows.join('\n') || '(none)'}`;
    if (screens) {
      const seen = new Set();
      const shots = [];
      for (const s of this.lines(date).filter((l) => l.t === 's' && inRange(l.at))) {
        const fresh = s.text.split('\n').map((x) => x.trim()).filter((x) => x.length > 3 && !seen.has(x));
        fresh.forEach((x) => seen.add(x));
        if (fresh.length) shots.push(`[${localTime(s.at)} ${s.app}${s.title && s.title !== '(private)' ? ` - ${cleanTitle(s.title, s.app)}` : ''}]\n${fresh.join('\n')}`);
      }
      if (shots.length) text += `\n\nText read from the screen (new lines only):\n${shots.join('\n\n')}`;
    }
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(cut)` : text;
  }

  /** A short summary of the day: what was worked on, meetings, and loose ends. Saved with the day. */
  async summarize(date = today()) {
    const d = this.day(date);
    if (!d.timeline.length) throw new Error('Nothing was tracked on this day.');
    const plain = this.plainSummary(d);
    const ai = await this.cloudAllowed();
    let r = null;
    if (ai.engine !== 'basic') {
      const system = 'You summarize a person\'s workday from the windows they had in front and text read from their screen. Be brief and concrete, in plain sentences. Sections, each a short Markdown list: "What you worked on" (projects, customers, documents, by time spent), "Meetings", "Loose ends" (things that look started but not finished, replies owed, follow-ups). Do not invent details. Leave out anything personal or unrelated to work.';
      try {
        r = await this.capture.askText({ system, messages: [{ role: 'user', content: this.digestText(date, null, null, { screens: ai.ok, maxChars: ai.ok ? 24000 : 8000 }) }], maxTokens: 1500 });
      } catch (e) { r = { error: String(e.message || e) }; }
    }
    const summary = r && r.text ? { text: r.text, mode: r.mode, model: r.model, at: now(), screens: ai.ok } : { text: plain, mode: 'basic', at: now(), note: r && r.error ? `The AI could not be reached (${r.error}), so this is the built-in summary.` : ai.engine === 'basic' ? 'Set up an AI in Settings › AI for a written summary.' : '' };
    this.saveDayMeta(date, { summary });
    return summary;
  }

  plainSummary(d) {
    const lines = [`You were at the PC for about ${hm(d.totalMinutes)}${d.first ? `, from ${d.first} to ${d.last}` : ''}.`];
    if (d.apps.length) lines.push('', '**Time by app**', ...d.apps.slice(0, 6).map((a) => `- ${a.app}: ${hm(a.minutes)}`));
    if (d.topics.length) lines.push('', '**What you worked on**', ...d.topics.slice(0, 8).map((t) => `- ${t.label} (${t.app}, ${hm(t.minutes)})`));
    if (d.meetings.length) lines.push('', '**Meetings**', ...d.meetings.map((m) => `- ${m.from}–${m.to} ${m.title} (${m.minutes} min)`));
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- recaps
  /**
   * Recap a meeting: the transcript or notes the user adds (pasted or dropped, e.g. a Teams
   * .vtt or .docx transcript) and the screen text read during it go to the assistant, which
   * writes the summary, decisions, tasks and a follow-up email. Returns { caseId }.
   */
  async recap({ id, date, title = '', text = '', files = [], quiet = false } = {}) {
    const day = this.day(date || String(id || '').slice(0, 10) || today());
    const m = day.meetings.find((x) => x.id === id) || null;
    if (id && !m) throw new Error('That meeting is no longer in the activity log.');
    const ai = await this.cloudAllowed();
    const parts = [];
    const name = String(title || (m && m.title) || 'Meeting').trim();
    parts.push(`Meeting recap request: "${name}"${m ? ` on ${day.date}, ${m.from} to ${m.to} (${m.minutes} min, ${m.app})` : ''}.`);
    parts.push('Write the recap: what was discussed, decisions made, action items with who owns them and when, open questions, and a short follow-up email to the attendees.');
    const notes = String(text || '').trim();
    if (notes) parts.push(`Transcript or notes:\n${/-->/.test(notes) ? vttText(notes) : notes}`);
    const readable = [];
    for (const f of files.slice(0, 5)) {
      if (/\.vtt$/i.test(f.name)) parts.push(`Transcript (${f.name}):\n${vttText(Buffer.from(f.bytes).toString('utf8'))}`);
      else readable.push(f);
    }
    if (m && ai.ok) {
      const scr = this.digestText(day.date, m.start, m.end || now(), { screens: true, maxChars: 20000 });
      parts.push(`What was on the screen during the meeting (read with OCR, may have errors; shared slides, chat and captions show up here):\n${scr}`);
    } else if (m) {
      parts.push('(Screen text was not included because cloud AI is not allowed to read activity. Turn it on under Activity › Privacy to include it.)');
    }
    const body = parts.join('\n\n');
    if (!notes && !files.length && (!m || !m.screens || !ai.ok)) throw new Error('Paste the transcript or your notes, or drop the Teams transcript file. Nothing was read from the screen during this meeting.');
    const caseId = await this.assistant.intake({ files: readable, text: body, origin: 'meeting', title: `Recap: ${name}` });
    if (m) {
      const meta = this.dayMeta(day.date);
      this.saveDayMeta(day.date, { recaps: { ...(meta.recaps || {}), [m.id]: { caseId, at: now(), title: name } } });
    }
    if (this.chat && !quiet) { try { this.chat.post('assistant', 'cases', `Meeting recap: ${name}. Reading it now; the summary, tasks and a follow-up email will show here.`, { caseIds: [caseId] }); } catch (_) { /* chat is optional */ } }
    return { caseId };
  }

  // -------------------------------------------------------------- clean-up
  /** Delete days older than the keep setting. */
  prune(at = today()) {
    const keep = this.settings().keepDays;
    const cutoff = addDays(at, -keep + 1);
    let n = 0;
    for (const d of this.days()) if (d < cutoff) { this.deleteDay(d); n += 1; }
    return n;
  }
  deleteDay(date) {
    if (!isDate(date)) throw new Error('Pick a day.');
    delete this.mem[date]; delete this.memDay[date];
    if (this.dir) fs.rmSync(this.dayDir(date), { recursive: true, force: true });
    return true;
  }
  deleteAll() {
    for (const d of this.days()) this.deleteDay(d);
    this.lastShot = null; this.lastHash = null;
    return true;
  }
}

function hm(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

module.exports = { Activity, isMeeting, cleanTitle, appName, vttText, DEFAULTS, hm };
