'use strict';
// Reports for people who need the big picture: executive summaries, weekly
// progress, status overviews, customer reports and detailed status listings,
// over any boards and period. Reports can be saved as snapshots (a frozen
// copy) and compared with an earlier snapshot. A written summary can be drafted
// by the AI chosen in Settings › AI; without one, plain highlights are written.

const C = require('./columns');
const { uid, now, today, addDays, daysBetween, parseJson, mondayOf } = require('./util');

const KINDS = {
  executive: { title: 'Executive summary', blurb: 'One page for leadership: headline numbers, board health, wins, risks and what is coming up.' },
  weekly: { title: 'Weekly progress report', blurb: 'What was done, what moved, what is late and what is due next, plus calls and time logged.' },
  overview: { title: 'Status overview', blurb: 'A snapshot of every board: status mix, progress, workload by person and customer.' },
  customer: { title: 'Customer report', blurb: 'Open work, calls and follow-ups for each customer.' },
  detail: { title: 'Detailed status report', blurb: 'Every open item by board and group, with status, owner, due date and latest update.' },
};

const PERIODS = {
  this_week: 'This week', last_week: 'Last week', this_month: 'This month', last_month: 'Last month',
  last_7: 'Last 7 days', last_30: 'Last 30 days', this_quarter: 'This quarter', custom: 'Custom dates',
};

function monthStart(iso) { return `${iso.slice(0, 7)}-01`; }
function monthEnd(iso) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** Resolve a period preset (or custom dates) to {from, to, label}, plus the previous period of the same length. */
function resolvePeriod(p = {}, t = today()) {
  const preset = PERIODS[p.preset] ? p.preset : (p.from && p.to ? 'custom' : 'this_week');
  let from, to;
  switch (preset) {
    case 'last_week': from = addDays(mondayOf(t), -7); to = addDays(from, 6); break;
    case 'this_month': from = monthStart(t); to = monthEnd(t); break;
    case 'last_month': { const s = monthStart(addDays(monthStart(t), -1)); from = s; to = monthEnd(s); break; }
    case 'last_7': from = addDays(t, -6); to = t; break;
    case 'last_30': from = addDays(t, -29); to = t; break;
    case 'this_quarter': { const m = Math.floor((+t.slice(5, 7) - 1) / 3) * 3 + 1; from = `${t.slice(0, 4)}-${String(m).padStart(2, '0')}-01`; to = monthEnd(`${t.slice(0, 4)}-${String(m + 2).padStart(2, '0')}-01`); break; }
    case 'custom': from = String(p.from).slice(0, 10); to = String(p.to).slice(0, 10); if (to < from) [from, to] = [to, from]; break;
    default: from = mondayOf(t); to = addDays(from, 6);
  }
  const len = daysBetween(from, to) + 1;
  const prev = { from: addDays(from, -len), to: addDays(from, -1) };
  const label = preset === 'custom' ? `${fmtDay(from)} to ${fmtDay(to)}` : `${PERIODS[preset]} (${fmtDay(from)} to ${fmtDay(to)})`;
  return { preset, from, to, label, days: len, prev };
}

/** ISO timestamp bounds for local calendar dates. */
function startTs(d) { return new Date(`${d}T00:00:00`).toISOString(); }
function endTs(d) { return new Date(`${d}T23:59:59.999`).toISOString(); }
function localDay(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

class Briefs {
  constructor({ db, store, reports, meetings, capture }) {
    this.db = db; this.store = store; this.reports = reports; this.meetings = meetings; this.capture = capture;
  }

  // ------------------------------------------------------------- options
  config() {
    const r = this.db.get("SELECT value FROM settings WHERE key='reports'");
    return { autoWeekly: true, ...parseJson(r && r.value, {}) };
  }
  setConfig(patch = {}) {
    const next = { ...this.config(), ...patch };
    this.db.run("INSERT INTO settings(key,value) VALUES('reports',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(next)]);
    return next;
  }

  /** What the report builder can offer: kinds, periods, and scopes (all, workspaces, folders, boards). */
  options() {
    const boards = this.db.all('SELECT b.id, b.name, b.folder, b.workspace_id, w.name AS ws FROM boards b LEFT JOIN workspaces w ON w.id=b.workspace_id WHERE b.archived=0 ORDER BY w.position, b.position, b.name');
    const scopes = [{ key: 'all', label: 'All boards' }];
    const seenWs = new Set(), seenFolder = new Set();
    for (const b of boards) {
      if (b.workspace_id && !seenWs.has(b.workspace_id)) { seenWs.add(b.workspace_id); scopes.push({ key: `ws:${b.workspace_id}`, label: `Workspace: ${b.ws || 'Untitled'}` }); }
      const fk = `${b.workspace_id}|${b.folder}`;
      if (b.folder && !seenFolder.has(fk)) { seenFolder.add(fk); scopes.push({ key: `folder:${fk}`, label: `Folder: ${b.folder}${b.ws ? ` (${b.ws})` : ''}` }); }
    }
    for (const b of boards) scopes.push({ key: `board:${b.id}`, label: `Board: ${b.name}` });
    return {
      kinds: Object.entries(KINDS).map(([id, k]) => ({ id, ...k })),
      periods: Object.entries(PERIODS).map(([id, label]) => ({ id, label })),
      scopes, people: this.store.people().map((p) => ({ id: p.id, name: p.name })), config: this.config(),
    };
  }

  scopeBoards(scope = 'all') {
    const all = this.db.all('SELECT id, name, folder, workspace_id FROM boards WHERE archived=0 ORDER BY position, name');
    const key = String(scope || 'all');
    if (key.startsWith('ws:')) return all.filter((b) => b.workspace_id === key.slice(3));
    if (key.startsWith('folder:')) { const [ws, folder] = key.slice(7).split('|'); return all.filter((b) => b.workspace_id === ws && b.folder === folder); }
    if (key.startsWith('board:')) return all.filter((b) => b.id === key.slice(6));
    return all;
  }
  scopeLabel(scope) {
    const o = this.options().scopes.find((s) => s.key === (scope || 'all'));
    return o ? o.label : 'All boards';
  }

  // ------------------------------------------------------------- facts
  /** Every item in scope with its status, dates, owners and customer, plus status changes in both periods. */
  facts(scope, period, personId) {
    const t = today();
    const people = this.store.peopleMap();
    const customers = this.store.customersMap();
    const boards = [];
    const items = [];
    const range = { a: startTs(period.prev.from), b: endTs(period.to) };
    const portfolio = Object.fromEntries(this.reports.portfolio().map((x) => [x.id, x]));
    for (const row of this.scopeBoards(scope)) {
      const B = this.store.getBoard(row.id);
      const cols = B.columns.filter((c) => c.scope === 'item');
      const sc = cols.find((c) => c.type === 'status');
      const dc = cols.find((c) => c.type === 'date') || cols.find((c) => c.type === 'timeline');
      const pcs = cols.filter((c) => c.type === 'people');
      const cc = cols.find((c) => c.type === 'customer');
      const groups = Object.fromEntries(B.groups.map((g) => [g.id, g]));
      const doneLabels = new Set(sc ? (sc.settings.labels || []).filter((l) => l.done).map((l) => l.label) : []);
      // Status changes from the activity log, newest last.
      const changes = {};
      if (sc) {
        for (const a of this.db.all("SELECT item_id, ts, old_value, new_value FROM activity WHERE board_id=? AND action='value' AND column_id=? AND ts>=? AND ts<=? ORDER BY id", [row.id, sc.id, range.a, range.b])) {
          (changes[a.item_id] = changes[a.item_id] || []).push({ ts: a.ts, day: localDay(a.ts), from: a.old_value || '', to: a.new_value || '', done: doneLabels.has(a.new_value) });
        }
      }
      const created = Object.fromEntries(this.db.all("SELECT item_id, ts FROM activity WHERE board_id=? AND action='item_created' AND ts>=?", [row.id, range.a]).map((r) => [r.item_id, r.ts]));
      const bItems = [];
      for (const it of B.items) {
        const l = sc && C.labelOf(sc, it.values[sc.id]);
        const done = !!(l && l.done);
        const dv = dc && it.values[dc.id];
        const due = dv ? (dc.type === 'timeline' ? (dv.end || dv.start || null) : String(dv).slice(0, 10)) : null;
        const owners = [...new Set(pcs.flatMap((c) => it.values[c.id] || []))].filter((p) => people[p]);
        if (personId && !owners.includes(personId)) continue;
        const cust = cc ? (it.values[cc.id] || []).filter((x) => customers[x]) : [];
        const ch = changes[it.id] || [];
        const lastDone = [...ch].reverse().find((c) => c.done);
        const g = groups[it.group_id];
        const f = {
          id: it.id, name: it.name, boardId: row.id, board: B.board.name, group: g ? g.name : '', groupColor: g ? C.colorHex(g.color) : '',
          status: l ? l.label : '', statusColor: l ? C.colorHex(l.color) : '', done, stuck: !!(l && !l.done && (l.id === 'stuck' || /block|stuck|hold|risk/i.test(l.label))),
          due, overdue: !!(due && due < t && !done), owners, ownerNames: owners.map((p) => people[p].name), customers: cust, customerNames: cust.map((x) => customers[x].name),
          createdDay: localDay(created[it.id] || it.created_at), changes: ch,
          doneDay: done && lastDone ? lastDone.day : null, updatedDay: localDay(it.updated_at),
        };
        // Items marked done without a logged change (imported, or before logging): treat their last update as the finish date.
        if (done && !f.doneDay && f.updatedDay >= period.prev.from) f.doneDay = f.updatedDay;
        bItems.push(f);
        items.push(f);
      }
      const pf = this.boardHealth(portfolio[row.id] || {}, bItems, B, people);
      boards.push({ id: row.id, name: B.board.name, workspace: B.workspace ? B.workspace.name : '', folder: row.folder || '', statusCol: sc ? sc.id : null,
        labels: sc ? (sc.settings.labels || []).map((x) => ({ label: x.label, color: C.colorHex(x.color), done: !!x.done })) : [], items: bItems, ...pf });
    }
    return { boards, items, people, customers, today: t };
  }

  boardHealth(p, items, B, people) {
    const total = items.length;
    const done = items.filter((i) => i.done).length;
    return { total, done, progress: pct(done, total), overdue: items.filter((i) => i.overdue).length, stuck: items.filter((i) => i.stuck).length,
      health: p.health || 'on_track', note: p.note || '', start: p.start || null, end: p.end || null, ownerName: p.ownerId && people[p.ownerId] ? people[p.ownerId].name : '', description: B.board.description || '' };
  }

  // ------------------------------------------------------------- build
  /**
   * Build a report. kind: executive | weekly | overview | customer | detail.
   * scope: 'all' | 'ws:<id>' | 'folder:<ws>|<name>' | 'board:<id>'. period: {preset} or {from, to}.
   */
  build({ kind = 'executive', scope = 'all', period: p, personId = null } = {}) {
    if (!KINDS[kind]) throw new Error('Unknown report type');
    const period = resolvePeriod(p);
    const F = this.facts(scope, period, personId);
    const inP = (d) => d && d >= period.from && d <= period.to;
    const inPrev = (d) => d && d >= period.prev.from && d <= period.prev.to;
    const open = F.items.filter((i) => !i.done);
    const completed = F.items.filter((i) => inP(i.doneDay)).sort((a, b) => b.doneDay.localeCompare(a.doneDay));
    const completedPrev = F.items.filter((i) => inPrev(i.doneDay)).length;
    const created = F.items.filter((i) => inP(i.createdDay));
    const overdue = open.filter((i) => i.overdue).sort((a, b) => a.due.localeCompare(b.due));
    const soonEnd = addDays(period.to > F.today ? period.to : F.today, 14);
    const upcoming = open.filter((i) => i.due && i.due >= F.today && i.due <= soonEnd).sort((a, b) => a.due.localeCompare(b.due));
    const nextWeek = open.filter((i) => i.due && i.due > period.to && i.due <= addDays(period.to, 7)).sort((a, b) => a.due.localeCompare(b.due));
    const moved = F.items.flatMap((i) => i.changes.filter((c) => inP(c.day) && !c.done).map((c) => ({ ...c, item: i }))).sort((a, b) => b.ts.localeCompare(a.ts));
    const stuck = open.filter((i) => i.stuck);
    const meetings = this.meetings.list({ from: period.from, to: period.to }).filter((m) => m.status !== 'cancelled');
    const actions = this.meetings.actions({ includeDone: false });
    const atRisk = F.boards.filter((b) => b.health === 'at_risk' || b.health === 'off_track');
    const people = Object.values(F.people);
    const peopleName = (id) => (F.people[id] ? F.people[id].name : '');

    const ref = (i) => ({ text: i.name, itemId: i.id });
    const owner = (i) => i.ownerNames.join(', ') || '—';
    const late = (i) => `${daysBetween(i.due, F.today)} days late`;
    const delta = (n, prev) => (prev === n ? 'same as the previous period' : `${n > prev ? 'up' : 'down'} from ${prev} the period before`);
    const healthLabel = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track', done: 'Done' };

    const kpis = [];
    const sections = [];
    const highlights = [];
    const r = { kind, title: KINDS[kind].title, scope, scopeLabel: this.scopeLabel(scope), person: personId ? peopleName(personId) : null, period, generatedAt: now(), kpis, sections };

    const boardTable = () => ({ type: 'table', id: 'health', title: 'Board health',
      columns: [{ key: 'board', label: 'Board' }, { key: 'health', label: 'Health', kind: 'health' }, { key: 'progress', label: 'Progress', kind: 'progress' }, { key: 'done', label: 'Done', kind: 'num' }, { key: 'overdue', label: 'Overdue', kind: 'num' }, { key: 'end', label: 'Due' }, { key: 'note', label: 'Status note' }],
      rows: F.boards.map((b) => ({ board: { text: b.name, boardId: b.id }, health: { text: healthLabel[b.health] || b.health, tone: b.health }, progress: b.progress, done: `${b.done} of ${b.total}`, overdue: b.overdue, end: b.end ? fmtDay(b.end) : '', note: b.note })),
      empty: 'No boards in this scope.' });
    const itemTable = (id, title, list, cols, empty, limit = 50) => ({ type: 'table', id, title, more: Math.max(0, list.length - limit),
      columns: cols.map(([key, label, k]) => ({ key, label, kind: k })), rows: list.slice(0, limit).map((i) => Object.fromEntries(cols.map(([key, , , fn]) => [key, fn(i)]))), empty });
    const cItem = ['item', 'Item', null, ref];
    const cBoard = ['board', 'Board', null, (i) => (i.group ? `${i.board} › ${i.group}` : i.board)];
    const cOwner = ['owner', 'Owner', null, owner];
    const cStatus = ['status', 'Status', 'status', (i) => ({ text: i.status || '—', color: i.statusColor })];
    const cDue = ['due', 'Due', null, (i) => (i.due ? fmtDay(i.due) : '—')];
    const actionList = (list, limit = 12) => list.slice(0, limit).map((a) => ({ text: a.text, sub: [peopleName(a.owner), a.due ? `due ${fmtDay(a.due)}` : '', a.meeting ? `from ${a.meeting.title}${a.meeting.customer ? ` (${a.meeting.customer})` : ''}` : ''].filter(Boolean).join(' · '), meetingId: a.meetingId, tone: a.due && a.due < F.today ? 'bad' : '' }));

    // Workload per person.
    const workload = people.map((p) => {
      const mine = F.items.filter((i) => i.owners.includes(p.id));
      return { p, open: mine.filter((i) => !i.done).length, overdue: mine.filter((i) => i.overdue).length, completed: mine.filter((i) => inP(i.doneDay)).length };
    }).filter((w) => w.open || w.completed).sort((a, b) => b.open - a.open);
    const workloadTable = { type: 'table', id: 'people', title: 'Workload by person',
      columns: [{ key: 'person', label: 'Person' }, { key: 'open', label: 'Open', kind: 'num' }, { key: 'overdue', label: 'Overdue', kind: 'num' }, { key: 'completed', label: 'Completed in period', kind: 'num' }],
      rows: workload.map((w) => ({ person: w.p.name, open: w.open, overdue: { text: String(w.overdue), tone: w.overdue ? 'bad' : '' }, completed: w.completed })), empty: 'Nobody has items assigned.' };

    if (kind === 'executive' || kind === 'weekly') {
      highlights.push(`${completed.length} ${completed.length === 1 ? 'item was' : 'items were'} completed, ${delta(completed.length, completedPrev)}.`);
      if (created.length) highlights.push(`${created.length} new ${created.length === 1 ? 'item was' : 'items were'} added.`);
      highlights.push(overdue.length ? `${overdue.length} open ${overdue.length === 1 ? 'item is' : 'items are'} overdue${overdue.length ? `, the oldest is ${overdue[0].name} on ${overdue[0].board} (${late(overdue[0])})` : ''}.` : 'Nothing is overdue.');
      if (atRisk.length) highlights.push(`${atRisk.length} ${atRisk.length === 1 ? 'board needs' : 'boards need'} attention: ${atRisk.map((b) => `${b.name} (${healthLabel[b.health].toLowerCase()})`).join(', ')}.`);
      else if (F.boards.length) highlights.push('Every board is on track.');
      if (stuck.length) highlights.push(`${stuck.length} ${stuck.length === 1 ? 'item is' : 'items are'} stuck or blocked.`);
      if (meetings.length) highlights.push(`${meetings.length} customer ${meetings.length === 1 ? 'call or meeting' : 'calls and meetings'} took place or ${meetings.length === 1 ? 'is' : 'are'} planned in the period.`);
      if (upcoming.length) highlights.push(`${upcoming.length} ${upcoming.length === 1 ? 'item is' : 'items are'} due in the next two weeks.`);
    }

    if (kind === 'executive') {
      const total = F.items.length;
      const doneAll = F.items.filter((i) => i.done).length;
      kpis.push({ label: 'Overall progress', value: `${pct(doneAll, total)}%`, sub: `${doneAll} of ${total} items done` },
        { label: 'Completed', value: completed.length, prev: completedPrev, sub: 'in this period' },
        { label: 'Open items', value: open.length },
        { label: 'Overdue', value: overdue.length, tone: overdue.length ? 'bad' : 'good' },
        { label: 'Boards at risk', value: atRisk.length, sub: `of ${F.boards.length} boards`, tone: atRisk.length ? 'warn' : 'good' },
        { label: 'Due in 2 weeks', value: upcoming.length });
      sections.push({ type: 'text', id: 'highlights', title: 'Highlights', lines: highlights });
      sections.push(boardTable());
      sections.push({ type: 'list', id: 'wins', title: 'Key accomplishments', items: completed.slice(0, 12).map((i) => ({ text: i.name, itemId: i.id, sub: `${i.board} · done ${fmtDay(i.doneDay)}${i.ownerNames.length ? ` · ${owner(i)}` : ''}`, tone: 'good' })), more: Math.max(0, completed.length - 12), empty: 'Nothing was completed in this period.' });
      const risks = [
        ...atRisk.map((b) => ({ text: `${b.name} is ${healthLabel[b.health].toLowerCase()}`, sub: [b.note, b.overdue ? `${b.overdue} overdue` : '', b.stuck ? `${b.stuck} stuck` : ''].filter(Boolean).join(' · '), boardId: b.id, tone: b.health === 'off_track' ? 'bad' : 'warn' })),
        ...stuck.slice(0, 8).map((i) => ({ text: i.name, sub: `${i.status} · ${i.board} · ${owner(i)}`, itemId: i.id, tone: 'warn' })),
        ...overdue.slice(0, 10).map((i) => ({ text: i.name, sub: `${late(i)} · ${i.board} · ${owner(i)}`, itemId: i.id, tone: 'bad' })),
      ];
      sections.push({ type: 'list', id: 'risks', title: 'Risks and issues', items: risks, empty: 'No risks: nothing is overdue, stuck or off track.' });
      sections.push({ type: 'list', id: 'next', title: 'Coming up in the next two weeks', items: upcoming.slice(0, 12).map((i) => ({ text: i.name, sub: `due ${fmtDay(i.due)} · ${i.board} · ${owner(i)}`, itemId: i.id })), more: Math.max(0, upcoming.length - 12), empty: 'Nothing is due in the next two weeks.' });
      if (actions.length) sections.push({ type: 'list', id: 'actions', title: 'Open follow-ups from calls', items: actionList(actions), more: Math.max(0, actions.length - 12) });
    }

    if (kind === 'weekly') {
      const ts = this.reports.timesheet({ from: period.from, to: period.to, personId: personId || undefined });
      const boardIds = new Set(F.boards.map((b) => b.id));
      const entries = ts.entries.filter((e) => boardIds.has(e.boardId));
      const secs = entries.reduce((s, e) => s + e.seconds, 0);
      kpis.push({ label: 'Completed', value: completed.length, prev: completedPrev },
        { label: 'New items', value: created.length },
        { label: 'Status changes', value: moved.length },
        { label: 'Overdue', value: overdue.length, tone: overdue.length ? 'bad' : 'good' },
        { label: 'Calls and meetings', value: meetings.length },
        { label: 'Hours logged', value: Math.round((secs / 3600) * 10) / 10 });
      sections.push({ type: 'text', id: 'highlights', title: 'Highlights', lines: highlights });
      sections.push(itemTable('completed', 'Completed', completed, [cItem, cBoard, cOwner, ['when', 'Completed', null, (i) => fmtDay(i.doneDay)]], 'Nothing was completed in this period.'));
      sections.push({ type: 'table', id: 'moved', title: 'Progress and status changes', more: Math.max(0, moved.length - 50),
        columns: [{ key: 'item', label: 'Item' }, { key: 'board', label: 'Board' }, { key: 'change', label: 'Change' }, { key: 'when', label: 'When' }],
        rows: moved.slice(0, 50).map((m) => ({ item: ref(m.item), board: m.item.board, change: `${m.from || 'No status'} → ${m.to || 'No status'}`, when: fmtDay(m.day) })), empty: 'No status changes in this period.' });
      sections.push(itemTable('new', 'New items', created.sort((a, b) => b.createdDay.localeCompare(a.createdDay)), [cItem, cBoard, cOwner, cStatus, cDue], 'No new items in this period.'));
      sections.push(itemTable('overdue', 'Overdue', overdue, [cItem, cBoard, cOwner, cStatus, ['late', 'Late', null, (i) => ({ text: late(i), tone: 'bad' })]], 'Nothing is overdue.'));
      sections.push(itemTable('nextweek', 'Due next week', nextWeek, [cItem, cBoard, cOwner, cStatus, cDue], 'Nothing is due in the week after this period.'));
      sections.push({ type: 'table', id: 'calls', title: 'Calls and meetings',
        columns: [{ key: 'when', label: 'Date' }, { key: 'title', label: 'Call or meeting' }, { key: 'customer', label: 'Customer' }, { key: 'open', label: 'Open follow-ups', kind: 'num' }],
        rows: meetings.map((m) => ({ when: `${fmtDay(m.date)} ${m.time || ''}`.trim(), title: { text: m.title, meetingId: m.id }, customer: m.customer || '—', open: m.open })), empty: 'No calls or meetings in this period.' });
      const byPerson = {};
      const byBoard = {};
      for (const e of entries) {
        const pn = peopleName(e.personId) || 'Unassigned';
        byPerson[pn] = (byPerson[pn] || 0) + e.seconds;
        byBoard[e.boardName] = (byBoard[e.boardName] || 0) + e.seconds;
      }
      const hrs = (s) => `${Math.round((s / 3600) * 10) / 10} h`;
      if (entries.length) {
        sections.push({ type: 'table', id: 'time', title: 'Time logged',
          columns: [{ key: 'who', label: 'Person or board' }, { key: 'hours', label: 'Hours', kind: 'num' }],
          rows: [...Object.entries(byPerson).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ who: k, hours: hrs(v) })), ...Object.entries(byBoard).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ who: `Board: ${k}`, hours: hrs(v) }))] });
      }
      sections.push(workloadTable);
    }

    if (kind === 'overview') {
      const total = F.items.length;
      const doneAll = F.items.filter((i) => i.done).length;
      kpis.push({ label: 'Boards', value: F.boards.length }, { label: 'Items', value: total }, { label: 'Complete', value: `${pct(doneAll, total)}%` },
        { label: 'Overdue', value: overdue.length, tone: overdue.length ? 'bad' : 'good' }, { label: 'Stuck', value: stuck.length, tone: stuck.length ? 'warn' : '' },
        { label: 'Unassigned', value: open.filter((i) => !i.owners.length).length });
      sections.push({ type: 'bars', id: 'mix', title: 'Status by board',
        bars: F.boards.map((b) => {
          const counts = {};
          for (const i of b.items) { const k = i.status || 'No status'; counts[k] = counts[k] || { label: k, value: 0, color: i.status ? i.statusColor : '#c4c9d4' }; counts[k].value++; }
          return { label: b.name, boardId: b.id, sub: `${b.progress}% done · ${b.total} items`, parts: Object.values(counts).sort((x, y) => y.value - x.value) };
        }) });
      sections.push(boardTable());
      const groups = [];
      for (const b of F.boards) {
        const g = {};
        for (const i of b.items) { const k = i.group || '—'; g[k] = g[k] || { board: b.name, group: k, total: 0, done: 0, overdue: 0 }; g[k].total++; if (i.done) g[k].done++; if (i.overdue) g[k].overdue++; }
        groups.push(...Object.values(g));
      }
      sections.push({ type: 'table', id: 'groups', title: 'Groups',
        columns: [{ key: 'board', label: 'Board' }, { key: 'group', label: 'Group' }, { key: 'total', label: 'Items', kind: 'num' }, { key: 'progress', label: 'Progress', kind: 'progress' }, { key: 'overdue', label: 'Overdue', kind: 'num' }],
        rows: groups.map((g) => ({ board: g.board, group: g.group, total: g.total, progress: pct(g.done, g.total), overdue: g.overdue })), empty: 'No groups.' });
      sections.push(workloadTable);
      const byCust = {};
      for (const i of open) for (const cn of i.customerNames) { byCust[cn] = byCust[cn] || { open: 0, overdue: 0 }; byCust[cn].open++; if (i.overdue) byCust[cn].overdue++; }
      if (Object.keys(byCust).length) {
        sections.push({ type: 'table', id: 'cust', title: 'Open work by customer',
          columns: [{ key: 'customer', label: 'Customer' }, { key: 'open', label: 'Open', kind: 'num' }, { key: 'overdue', label: 'Overdue', kind: 'num' }],
          rows: Object.entries(byCust).sort((a, b) => b[1].open - a[1].open).map(([k, v]) => ({ customer: k, open: v.open, overdue: v.overdue })) });
      }
    }

    if (kind === 'customer') {
      const custs = Object.values(F.customers);
      const allMeet = this.meetings.list({});
      const rows = custs.map((c) => {
        const mine = F.items.filter((i) => i.customers.includes(c.id));
        const lname = c.name.toLowerCase();
        const calls = allMeet.filter((m) => String(m.customer || '').toLowerCase() === lname);
        const inPeriod = calls.filter((m) => inP(m.date));
        const past = calls.filter((m) => m.date <= F.today && m.status !== 'cancelled').sort((a, b) => b.date.localeCompare(a.date));
        const future = calls.filter((m) => m.date > F.today && m.status !== 'cancelled').sort((a, b) => a.date.localeCompare(b.date));
        const acts = actions.filter((a) => a.meeting && String(a.meeting.customer || '').toLowerCase() === lname);
        return { c, mine, open: mine.filter((i) => !i.done), overdue: mine.filter((i) => i.overdue), done: mine.filter((i) => inP(i.doneDay)), calls: inPeriod, last: past[0] || null, next: future[0] || null, acts };
      }).filter((x) => x.mine.length || x.calls.length || x.acts.length || x.last || x.next).sort((a, b) => (b.open.length + b.calls.length) - (a.open.length + a.calls.length));
      kpis.push({ label: 'Active customers', value: rows.length, sub: `of ${custs.length}` },
        { label: 'Open customer work', value: rows.reduce((s, x) => s + x.open.length, 0) },
        { label: 'Overdue', value: rows.reduce((s, x) => s + x.overdue.length, 0), tone: rows.some((x) => x.overdue.length) ? 'bad' : 'good' },
        { label: 'Calls in period', value: rows.reduce((s, x) => s + x.calls.length, 0) },
        { label: 'Open follow-ups', value: rows.reduce((s, x) => s + x.acts.length, 0) });
      sections.push({ type: 'table', id: 'customers', title: 'Customers',
        columns: [{ key: 'customer', label: 'Customer' }, { key: 'open', label: 'Open', kind: 'num' }, { key: 'overdue', label: 'Overdue', kind: 'num' }, { key: 'done', label: 'Done in period', kind: 'num' }, { key: 'calls', label: 'Calls in period', kind: 'num' }, { key: 'last', label: 'Last call' }, { key: 'next', label: 'Next call' }, { key: 'acts', label: 'Follow-ups', kind: 'num' }],
        rows: rows.map((x) => ({ customer: { text: x.c.name, customerId: x.c.id }, open: x.open.length, overdue: { text: String(x.overdue.length), tone: x.overdue.length ? 'bad' : '' }, done: x.done.length, calls: x.calls.length, last: x.last ? fmtDay(x.last.date) : '—', next: x.next ? fmtDay(x.next.date) : '—', acts: x.acts.length })),
        empty: 'No customer has open work or calls. Assign customers to items with a Customer column, or log calls.' });
      for (const x of rows.slice(0, 15)) {
        const its = [...x.overdue, ...x.open.filter((i) => !i.overdue)].slice(0, 10).map((i) => ({ text: i.name, itemId: i.id, sub: [i.status, i.board, i.due ? `due ${fmtDay(i.due)}` : '', i.overdue ? late(i) : ''].filter(Boolean).join(' · '), tone: i.overdue ? 'bad' : '' }));
        its.push(...actionList(x.acts, 5));
        if (x.next) its.push({ text: `Next call: ${x.next.title}`, sub: fmtDay(x.next.date), meetingId: x.next.id });
        sections.push({ type: 'list', id: `c-${x.c.id}`, title: x.c.name, customerId: x.c.id, items: its, empty: 'No open work or follow-ups.' });
      }
    }

    if (kind === 'detail') {
      const latest = {};
      const ids = open.map((i) => i.id);
      for (let k = 0; k < ids.length; k += 400) {
        const chunk = ids.slice(k, k + 400);
        for (const u of this.db.all(`SELECT item_id, body, created_at FROM updates WHERE item_id IN (${chunk.map(() => '?').join(',')}) ORDER BY created_at`, chunk)) latest[u.item_id] = u;
      }
      kpis.push({ label: 'Open items', value: open.length }, { label: 'Overdue', value: overdue.length, tone: overdue.length ? 'bad' : 'good' },
        { label: 'Stuck', value: stuck.length, tone: stuck.length ? 'warn' : '' }, { label: 'Completed', value: completed.length, prev: completedPrev, sub: 'in this period' });
      for (const b of F.boards) {
        const list = b.items.filter((i) => !i.done).sort((x, y) => x.group.localeCompare(y.group) || String(x.due || '9999').localeCompare(String(y.due || '9999')));
        sections.push({ type: 'table', id: `b-${b.id}`, title: b.name, boardId: b.id, sub: `${b.progress}% done · ${list.length} open · ${healthLabel[b.health]}${b.note ? ` · ${b.note}` : ''}`,
          columns: [{ key: 'group', label: 'Group' }, { key: 'item', label: 'Item' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'owner', label: 'Owner' }, { key: 'due', label: 'Due' }, { key: 'customer', label: 'Customer' }, { key: 'update', label: 'Latest update' }],
          rows: list.map((i) => {
            const u = latest[i.id];
            return { group: i.group, item: ref(i), status: { text: i.status || '—', color: i.statusColor }, owner: owner(i), due: i.due ? { text: fmtDay(i.due), tone: i.overdue ? 'bad' : '' } : '—', customer: i.customerNames.join(', ') || '—', update: u ? `${stripHtml(u.body).slice(0, 160)} (${fmtDay(localDay(u.created_at))})` : '' };
          }), empty: 'Everything on this board is done.' });
      }
    }

    r.compare = this.compareWithSnapshot(r);
    return r;
  }

  // ------------------------------------------------------------- snapshots
  scopeKey(r) { return `${r.scope || 'all'}${r.person ? `|${r.person}` : ''}`; }

  /** KPI changes since the latest saved snapshot of the same report type and scope. */
  compareWithSnapshot(r) {
    const s = this.db.get('SELECT id, created_at, data FROM report_snapshots WHERE kind=? AND scope_key=? ORDER BY created_at DESC LIMIT 1', [r.kind, this.scopeKey(r)]);
    if (!s) return null;
    const old = parseJson(s.data, {});
    const byLabel = Object.fromEntries((old.kpis || []).map((k) => [k.label, k.value]));
    return { snapshotId: s.id, at: s.created_at, period: old.period ? old.period.label : '', kpis: Object.fromEntries(r.kpis.filter((k) => byLabel[k.label] !== undefined).map((k) => [k.label, byLabel[k.label]])) };
  }

  saveSnapshot({ report, kind, scope, period, personId, summary = '', note = '', auto = false } = {}) {
    const r = report || this.build({ kind, scope, period, personId });
    const id = uid('rs');
    const title = `${r.title} · ${r.period.label}`;
    this.db.run('INSERT INTO report_snapshots(id,kind,title,scope_key,period_from,period_to,data,summary,note,auto,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [id, r.kind, title, this.scopeKey(r), r.period.from, r.period.to, JSON.stringify({ ...r, compare: null }), String(summary || ''), String(note || '').slice(0, 500), auto ? 1 : 0, now()]);
    return this.snapshot(id);
  }
  snapshots({ kind } = {}) {
    return this.db.all(`SELECT id, kind, title, scope_key, period_from, period_to, note, auto, created_at, summary <> '' AS has_summary, data FROM report_snapshots ${kind ? 'WHERE kind=?' : ''} ORDER BY created_at DESC LIMIT 300`, kind ? [kind] : [])
      .map((s) => { const d = parseJson(s.data, {}); return { id: s.id, kind: s.kind, title: s.title, scopeLabel: d.scopeLabel || 'All boards', person: d.person || null, from: s.period_from, to: s.period_to, note: s.note, auto: !!s.auto, createdAt: s.created_at, hasSummary: !!s.has_summary, kpis: (d.kpis || []).slice(0, 4) }; });
  }
  snapshot(id) {
    const s = this.db.get('SELECT * FROM report_snapshots WHERE id=?', [id]);
    if (!s) throw new Error('That snapshot no longer exists');
    return { id: s.id, title: s.title, note: s.note, auto: !!s.auto, createdAt: s.created_at, summary: s.summary || '', report: parseJson(s.data, {}) };
  }
  updateSnapshot(id, { note, summary } = {}) {
    this.snapshot(id);
    if (note !== undefined) this.db.run('UPDATE report_snapshots SET note=? WHERE id=?', [String(note || '').slice(0, 500), id]);
    if (summary !== undefined) this.db.run('UPDATE report_snapshots SET summary=? WHERE id=?', [String(summary || ''), id]);
    return this.snapshot(id);
  }
  deleteSnapshot(id) { this.db.run('DELETE FROM report_snapshots WHERE id=?', [id]); return true; }

  /** KPI values over saved snapshots of one kind and scope, oldest first, for trend lines. */
  trend({ kind = 'weekly', scope = 'all' } = {}) {
    const rows = this.db.all('SELECT created_at, period_from, period_to, data FROM report_snapshots WHERE kind=? AND scope_key=? ORDER BY period_to, created_at', [kind, scope]);
    return rows.map((s) => ({ at: s.created_at, from: s.period_from, to: s.period_to, kpis: Object.fromEntries((parseJson(s.data, {}).kpis || []).map((k) => [k.label, k.value])) }));
  }

  /** Every Monday (or the first run after), save last week's progress report for all boards. */
  maybeAutoWeekly(at = new Date()) {
    if (!this.config().autoWeekly) return null;
    if (!this.db.get('SELECT 1 FROM boards WHERE archived=0 LIMIT 1')) return null;
    const t = today(at);
    const from = addDays(mondayOf(t), -7);
    const to = addDays(from, 6);
    if (this.db.get("SELECT 1 FROM report_snapshots WHERE kind='weekly' AND auto=1 AND period_from=?", [from])) return null;
    const r = this.build({ kind: 'weekly', scope: 'all', period: { from, to } });
    r.period.label = `Week of ${fmtDay(from)}`;
    const s = this.saveSnapshot({ report: r, auto: true });
    const me = this.store.me();
    this.store.notify(me.id, 'report', `Weekly progress report for ${r.period.label.toLowerCase()} is ready`, r.kpis.slice(0, 4).map((k) => `${k.label}: ${k.value}`).join(' · '), null, null);
    return s;
  }

  // ------------------------------------------------------------- written summary
  /** Plain text version of a report, for the AI and for copying. */
  toText(r, { limit = 25 } = {}) {
    const out = [`${r.title}`, `Scope: ${r.scopeLabel}${r.person ? ` (items owned by ${r.person})` : ''}`, `Period: ${r.period.label}`, ''];
    out.push(r.kpis.map((k) => `${k.label}: ${k.value}${k.prev !== undefined ? ` (previous period ${k.prev})` : ''}`).join('; '));
    const cell = (v) => (v && typeof v === 'object' ? v.text : v == null ? '' : String(v));
    for (const s of r.sections) {
      out.push('', `## ${s.title}`);
      if (s.type === 'text') out.push(...s.lines.map((l) => `- ${l}`));
      if (s.type === 'list') out.push(...(s.items.length ? s.items.slice(0, limit).map((i) => `- ${i.text}${i.sub ? ` (${i.sub})` : ''}`) : [s.empty || 'None']));
      if (s.type === 'table') out.push(...(s.rows.length ? s.rows.slice(0, limit).map((row) => `- ${s.columns.map((c) => `${c.label}: ${c.kind === 'progress' ? `${row[c.key]}%` : cell(row[c.key])}`).join('; ')}`) : [s.empty || 'None']));
      if (s.type === 'bars') out.push(...s.bars.map((b) => `- ${b.label}: ${b.parts.map((p) => `${p.label} ${p.value}`).join(', ')}`));
    }
    return out.join('\n');
  }

  /** A short written summary of a report by the AI chosen in Settings › AI, or plain highlights without one. */
  async writeSummary({ report, kind, scope, period, personId, audience = 'executive' } = {}) {
    const r = report || this.build({ kind, scope, period, personId });
    const facts = this.toText(r);
    const fallback = () => {
      const h = r.sections.find((s) => s.id === 'highlights');
      const lines = h ? h.lines : r.kpis.map((k) => `${k.label}: ${k.value}.`);
      return lines.join(' ');
    };
    const { engine, cfg, localCfg } = await this.capture.pickEngine();
    if (engine === 'basic') return { mode: 'basic', model: null, text: fallback(), note: 'No AI model is running, so these are the highlights. Start Ollama for a written summary.' };
    const system = `You write ${audience === 'team' ? 'team status updates' : 'executive status summaries'} for a small business from report data. Write in plain, confident business English.
- Start with a one-sentence bottom line.
- Then 2 or 3 short paragraphs: progress and wins, risks and what is being done about them, what is next.
- End with a short "Needs attention" list of at most 5 bullets (use "- "), or "Nothing needs attention." if that is true.
- Use only the facts given. Never invent names, numbers or dates. Keep it under 250 words. No headings.`;
    const user = `${facts}\n\nWrite the summary.`;
    try {
      let text;
      let model;
      if (engine === 'local') {
        ({ model } = await this.capture.localModels(localCfg));
        if (!model) return { mode: 'basic', model: null, text: fallback(), note: 'No chat model is installed in Ollama. Run: ollama pull llama3.2' };
        if (localCfg.provider === 'openai') {
          const res = await this.capture.localFetch(localCfg, '/v1/chat/completions', { model, temperature: 0.3, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, 300000);
          text = res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
        } else {
          const res = await this.capture.localFetch(localCfg, '/api/chat', { model, stream: false, options: { temperature: 0.3, num_ctx: 16384 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, 300000);
          text = res.message && res.message.content;
        }
      } else {
        const Anthropic = require('@anthropic-ai/sdk');
        const Client = Anthropic.default || Anthropic;
        const client = new Client({ apiKey: cfg.key, maxRetries: 2, timeout: 120000, ...(process.env.BOARDENDA_ANTHROPIC_BASE_URL ? { baseURL: process.env.BOARDENDA_ANTHROPIC_BASE_URL } : {}) });
        model = cfg.model;
        const res = await client.beta.messages.create({ model, max_tokens: 2000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'low' },
          system: [{ type: 'text', text: system }], messages: [{ role: 'user', content: user }] });
        text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      }
      text = String(text || '').trim();
      if (!text) return { mode: 'basic', model: null, text: fallback(), note: 'The model returned nothing, so these are the highlights.' };
      return { mode: engine, model, text };
    } catch (e) {
      return { mode: 'basic', model: null, text: fallback(), note: `The model could not write a summary (${e.message || e}), so these are the highlights.` };
    }
  }
}

module.exports = { Briefs, resolvePeriod, KINDS, PERIODS };
