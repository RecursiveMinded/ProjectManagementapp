'use strict';
// The application API. Electron (over IPC) and the dev server (over HTTP)
// expose exactly the methods listed in PUBLIC_METHODS.

const fs = require('fs');
const path = require('path');
const { Database } = require('./db');
const { Store } = require('./store');
const { Automations, TRIGGERS, ACTIONS } = require('./automations');
const { Dashboards, WIDGETS } = require('./dashboards');
const { Reports } = require('./reports');
const { Recurring } = require('./recurring');
const T = require('./templates');
const io = require('./io');
const C = require('./columns');
const { today, addDays, now, mondayOf, parseJson, uid } = require('./util');

const DEFAULT_SETTINGS = {
  theme: 'system',
  runInBackground: true,
  startWithWindows: false,
  autoUpdate: true,
  desktopNotifications: true,
  digest: { enabled: true, frequency: 'daily', time: '08:30', weekday: 1 },
  weekStart: 1,
  density: 'comfortable',
  backupsKeep: 14,
};

class AppApi {
  static async create({ dataDir, file } = {}) {
    const dbFile = file !== undefined ? file : dataDir ? path.join(dataDir, 'boardenda.db') : null;
    const db = await Database.open(dbFile);
    return new AppApi(db, dataDir || null);
  }

  constructor(db, dataDir) {
    this.db = db;
    this.dataDir = dataDir;
    this.store = new Store(db, { filesDir: dataDir ? path.join(dataDir, 'files') : null });
    this.automations = new Automations(this.store);
    this.dashboards = new Dashboards(this.store);
    this.reports = new Reports(this.store);
    this.recurring = new Recurring(this.store);
    this.store.me();
    if (dataDir) this.autoBackup();
    try { this.store.purgeTrash({ olderThanDays: 30 }); } catch (_) { /* never block start-up */ }
  }

  // ------------------------------------------------------------- settings
  getSettings() {
    const r = this.db.get("SELECT value FROM settings WHERE key='app'");
    const s = parseJson(r && r.value, {});
    return { ...DEFAULT_SETTINGS, ...s, digest: { ...DEFAULT_SETTINGS.digest, ...(s.digest || {}) } };
  }
  setSettings(patch) {
    const next = { ...this.getSettings(), ...patch };
    if (patch.digest) next.digest = { ...this.getSettings().digest, ...patch.digest };
    this.db.run("INSERT INTO settings(key,value) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(next)]);
    return next;
  }

  // ---------------------------------------------------------------- shell
  bootstrap() {
    const ws = this.store.workspaces();
    return {
      workspaces: ws,
      people: this.store.people(),
      teams: this.store.teams(),
      favorites: this.favorites(),
      docs: this.docs(),
      userTemplates: this.userTemplates(),
      me: this.store.me(),
      settings: this.getSettings(),
      dashboards: this.dashboards.list(),
      unread: this.db.get('SELECT COUNT(*) AS n FROM notifications WHERE read=0 AND (person_id=? OR person_id IS NULL)', [this.store.me().id]).n,
      empty: !ws.some((w) => w.boards.length),
      catalog: {
        types: C.TYPES, palette: C.PALETTE, countries: C.COUNTRIES, triggers: TRIGGERS, actions: ACTIONS, widgets: WIDGETS,
        templates: Object.fromEntries(Object.entries(T.TEMPLATES).map(([k, t]) => [k, { name: t.name, description: t.description }])),
      },
      dataDir: this.dataDir,
    };
  }
  loadSample() { return this.withLog(() => T.sampleWorkspace(this.store, this.automations, this.dashboards)); }
  withLog(fn) { return fn(); }

  // ------------------------------------------------------------ workspaces
  saveWorkspace(w) { return this.store.saveWorkspace(w); }
  deleteWorkspace(id) { return this.store.deleteWorkspace(id); }
  savePerson(p) { return this.store.savePerson(p); }
  deletePerson(id) { return this.store.deletePerson(id); }
  setMe(patch) { const me = this.store.me(); return this.store.savePerson({ ...me, ...patch, id: me.id }); }

  // ---------------------------------------------------------------- boards
  createBoard({ template = 'blank', workspaceId, name, sample = false } = {}) {
    if (String(template).startsWith('user:')) {
      const t = this.db.get('SELECT * FROM user_templates WHERE id=?', [template.slice(5)]);
      if (!t) throw new Error('That template no longer exists');
      return io.importBoardFile(this.store, t.payload, { workspaceId, name: name || t.name });
    }
    return T.build(this.store, this.automations, template, { workspaceId, name, sample });
  }

  // ------------------------------------------------------------------ docs
  /** Workspace docs (not the ones attached to items) for the sidebar. */
  docs() { return this.db.all('SELECT id, workspace_id, title, updated_at FROM docs WHERE item_id IS NULL ORDER BY position, created_at'); }
  getDoc(id) {
    const d = this.db.get('SELECT * FROM docs WHERE id=?', [id]);
    if (!d) throw new Error('This doc no longer exists');
    const item = d.item_id ? this.db.get('SELECT i.id, i.name, i.board_id AS boardId, b.name AS boardName FROM items i JOIN boards b ON b.id=i.board_id WHERE i.id=?', [d.item_id]) : null;
    const ws = d.workspace_id ? this.db.get('SELECT id, name FROM workspaces WHERE id=?', [d.workspace_id]) : null;
    const author = d.created_by ? this.db.get('SELECT id, name FROM people WHERE id=?', [d.created_by]) : null;
    return { ...d, item, workspace: ws, author };
  }
  saveDoc({ id, workspaceId, itemId, title, html } = {}) {
    const ts = now();
    if (id) {
      const d = this.db.get('SELECT * FROM docs WHERE id=?', [id]);
      if (!d) throw new Error('This doc no longer exists');
      this.db.run('UPDATE docs SET title=?, html=?, workspace_id=?, updated_at=? WHERE id=?', [
        title != null ? String(title).trim() || 'Untitled' : d.title, html != null ? cleanHtml(html) : d.html, workspaceId || d.workspace_id, ts, id]);
      return id;
    }
    const nid = uid('d');
    const ws = workspaceId || (this.db.get('SELECT id FROM workspaces ORDER BY position LIMIT 1') || {}).id || this.store.saveWorkspace({ name: 'Main workspace' });
    const pos = (this.db.get('SELECT MAX(position) AS p FROM docs').p || 0) + 1;
    this.db.run('INSERT INTO docs(id,workspace_id,item_id,title,html,position,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [nid, ws, itemId || null, String(title || 'Untitled').trim() || 'Untitled', cleanHtml(html || ''), pos, this.store.me().id, ts, ts]);
    return nid;
  }
  /** Create the doc behind an item's Doc column and link it. */
  createItemDoc(itemId, columnId) {
    const it = this.store.itemRow(itemId);
    const existing = it.data[columnId];
    if (existing && this.db.get('SELECT id FROM docs WHERE id=?', [existing])) return existing;
    const b = this.db.get('SELECT workspace_id FROM boards WHERE id=?', [it.board_id]);
    const id = this.saveDoc({ workspaceId: b && b.workspace_id, itemId, title: it.name, html: '' });
    this.store.setValue(itemId, columnId, id);
    return id;
  }
  deleteDoc(id) {
    const d = this.db.get('SELECT * FROM docs WHERE id=?', [id]);
    if (!d) return;
    this.store.toTrash('doc', d.title, null, 'Docs', { docs: [d] });
    this.db.run('DELETE FROM docs WHERE id=?', [id]);
    this.lastTrash(`Deleted doc “${d.title}”`);
  }

  // ------------------------------------------------- your templates, folders
  /** Save a board's structure (and optionally its items) as a reusable template. */
  saveAsTemplate(boardId, { name, description = '', withItems = false } = {}) {
    const f = JSON.parse(io.exportBoardFile(this.store, boardId));
    if (!withItems) { f.items = []; f.updates = []; }
    const id = uid('u');
    const n = String(name || f.board.name).trim();
    this.db.run('INSERT INTO user_templates(id,name,description,with_items,payload,created_at) VALUES(?,?,?,?,?,?)', [id, n, description, withItems ? 1 : 0, JSON.stringify(f), now()]);
    return id;
  }
  userTemplates() { return this.db.all('SELECT id, name, description, with_items, created_at FROM user_templates ORDER BY created_at DESC'); }
  deleteTemplate(id) { this.db.run('DELETE FROM user_templates WHERE id=?', [id]); }
  setBoardFolder(boardId, folder) { return this.store.updateBoard(boardId, { folder: String(folder || '').trim() }); }
  favorites() { const r = this.db.get("SELECT value FROM settings WHERE key='favorites'"); return parseJson(r && r.value, []); }
  toggleFavorite(kind, id) {
    const list = this.favorites();
    const i = list.findIndex((f) => f.kind === kind && f.id === id);
    if (i >= 0) list.splice(i, 1); else list.push({ kind, id });
    this.db.run("INSERT INTO settings(key,value) VALUES('favorites',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(list)]);
    return list;
  }
  getBoard(id) { const B = this.store.getBoard(id); B.recurring = this.recurring.forBoard(id); B.itemTemplates = this.recurring.itemTemplates(id); return B; }
  updateBoard(id, patch) { return this.store.updateBoard(id, patch); }
  duplicateBoard(id, opts) { return this.store.duplicateBoard(id, opts); }
  archiveBoard(id, archived) { return this.store.archiveBoard(id, archived); }
  deleteBoard(id) { const n = this.store.boardRow(id).name; this.store.deleteBoard(id); this.lastTrash(`Deleted board “${n}”`); }
  moveBoardTo(id, workspaceId, position) { return this.store.moveBoardTo(id, workspaceId, position); }
  allBoards() {
    return this.db.all('SELECT b.id, b.name, b.workspace_id, b.archived, w.name AS workspace FROM boards b LEFT JOIN workspaces w ON w.id=b.workspace_id ORDER BY w.position, b.position');
  }
  boardColumns(id) { return this.store.columns(id); }
  boardItems(id) { return this.db.all('SELECT id, name, group_id FROM items WHERE board_id=? AND archived=0 AND parent_id IS NULL ORDER BY position', [id]); }
  archived() {
    return {
      boards: this.db.all('SELECT b.id, b.name, b.updated_at, w.name AS workspace FROM boards b LEFT JOIN workspaces w ON w.id=b.workspace_id WHERE b.archived=1 ORDER BY b.updated_at DESC'),
      items: this.db.all('SELECT i.id, i.name, i.updated_at, b.name AS board FROM items i JOIN boards b ON b.id=i.board_id WHERE i.archived=1 ORDER BY i.updated_at DESC LIMIT 500'),
      groups: this.db.all('SELECT g.id, g.name, b.name AS board FROM groups g JOIN boards b ON b.id=g.board_id WHERE g.archived=1'),
    };
  }

  addGroup(boardId, g) { return this.store.addGroup(boardId, g); }
  updateGroup(id, patch) { return this.store.updateGroup(id, patch); }
  deleteGroup(id) { const g = this.db.get('SELECT name FROM groups WHERE id=?', [id]); this.store.deleteGroup(id); if (g) this.lastTrash(`Deleted group “${g.name}”`); }
  archiveGroup(id, a) { return this.store.archiveGroup(id, a); }
  duplicateGroup(id) { return this.store.duplicateGroup(id); }

  addColumn(boardId, c) { return this.store.addColumn(boardId, c); }
  updateColumn(id, patch) { return this.store.updateColumn(id, patch); }
  deleteColumn(id) { const c = this.store.colRow(id); this.store.deleteColumn(id); this.lastTrash(`Deleted column “${c.title}”`); }
  duplicateColumn(id, o) { return this.store.duplicateColumn(id, o); }

  addItem(boardId, it) { return this.store.addItem(boardId, it); }
  renameItem(id, name) { const old = this.store.itemRow(id).name; this.store.renameItem(id, name); this.pushUndo(`Renamed “${old}”`, () => this.store.renameItem(id, old)); }
  setValue(itemId, columnId, value) {
    const it = this.store.itemRow(itemId);
    const old = it.data[columnId];
    const changed = this.store.setValue(itemId, columnId, value);
    if (changed) { const c = this.store.colRow(columnId); this.pushUndo(`Changed ${c.title} on “${it.name}”`, () => this.store.setValue(itemId, columnId, old === undefined ? null : old)); }
    return changed;
  }
  setValues(itemId, values) { return this.store.setValues(itemId, values); }
  moveItem(id, to) {
    const it = this.store.itemRow(id);
    const r = this.store.moveItem(id, to);
    if (!to || !to.boardId || to.boardId === it.board_id) this.pushUndo(`Moved “${it.name}”`, () => this.db.run('UPDATE items SET group_id=?, position=? WHERE id=?', [it.group_id, it.position, id]));
    return r;
  }
  duplicateItem(id, o) { return this.store.duplicateItem(id, o); }
  archiveItem(id, a = true) { const it = this.store.itemRow(id); this.store.archiveItem(id, a); this.pushUndo(`${a ? 'Archived' : 'Restored'} “${it.name}”`, () => this.store.archiveItem(id, !a)); }
  deleteItem(id) { const it = this.store.itemRow(id); this.store.deleteItem(id); this.lastTrash(`Deleted “${it.name}”`); }
  bulk(ids, op, arg) {
    const before = ids.map((id) => this.db.get('SELECT * FROM items WHERE id=?', [id])).filter(Boolean);
    const trashBefore = this.db.get('SELECT COUNT(*) AS n FROM trash').n;
    const r = this.store.bulk(ids, op, arg);
    const n = before.length;
    if (op === 'delete') {
      const added = this.db.all('SELECT id FROM trash ORDER BY rowid DESC LIMIT ?', [this.db.get('SELECT COUNT(*) AS n FROM trash').n - trashBefore]).map((x) => x.id);
      this.pushUndo(`Deleted ${n} items`, () => { for (const t of added.reverse()) this.store.restoreTrash(t); });
    } else if (['archive', 'restore', 'set', 'move'].includes(op)) {
      this.pushUndo(`${op === 'set' ? 'Changed' : op[0].toUpperCase() + op.slice(1)} ${n} items`, () => {
        for (const b of before) this.db.run('UPDATE items SET archived=?, group_id=?, position=?, data=? WHERE id=?', [b.archived, b.group_id, b.position, b.data, b.id]);
      });
    }
    return r;
  }

  // ------------------------------------------------------------ undo, trash
  pushUndo(label, fn) {
    this.undoStack = this.undoStack || [];
    this.undoStack.push({ label, fn, at: Date.now() });
    if (this.undoStack.length > 50) this.undoStack.shift();
  }
  lastTrash(label) {
    const t = this.db.get('SELECT id FROM trash ORDER BY rowid DESC LIMIT 1');
    if (t) this.pushUndo(label, () => this.store.restoreTrash(t.id));
  }
  /** Undo the most recent change made in this session. Returns its label, or null. */
  undo() {
    const u = (this.undoStack || []).pop();
    if (!u) return null;
    this.db.tx(() => u.fn());
    return u.label;
  }
  undoLabel() { const s = this.undoStack || []; return s.length ? s[s.length - 1].label : null; }
  trash() { return this.store.trash(); }
  restoreTrash(id) { return this.store.restoreTrash(id); }
  purgeTrash(id) { return this.store.purgeTrash(id ? { id } : {}); }
  toggleTimer(itemId, columnId) { return this.store.toggleTimer(itemId, columnId); }
  clickButton(itemId, columnId) { return this.store.clickButton(itemId, columnId); }
  /** One item with its subitems, updates, files and activity, for the item panel. */
  getItem(id) {
    const row = this.store.itemRow(id);
    const B = this.store.getBoard(row.board_id, { includeArchived: true });
    const item = B.items.find((x) => x.id === id) || B.subitems.find((x) => x.id === id);
    return {
      item, board: B.board, columns: B.columns, groups: B.groups, people: B.people, linked: B.linked, files: B.files,
      subitems: B.subitems.filter((s) => s.parent_id === id),
      parent: row.parent_id ? B.items.find((x) => x.id === row.parent_id) || null : null,
      updates: this.store.updates(id), fileList: this.store.itemFiles(id),
      activity: this.store.activity({ itemId: id, limit: 150 }),
      docs: B.docs, recurrence: row.parent_id ? null : this.recurring.get(id),
    };
  }

  postUpdate(itemId, body, o) { return this.store.postUpdate(itemId, body, o); }
  editUpdate(id, body) { return this.store.editUpdate(id, body); }
  pinUpdate(id, p) { return this.store.pinUpdate(id, p); }
  deleteUpdate(id) { return this.store.deleteUpdate(id); }
  addFile(itemId, columnId, f) { return this.store.addFile(itemId, columnId, f); }
  removeFile(id) { return this.store.removeFile(id); }
  filePath(id) { return this.store.filePath(id); }

  saveView(boardId, v) { return this.store.saveView(boardId, v); }
  deleteView(id) { return this.store.deleteView(id); }
  activity(q) { return this.store.activity(q); }
  search(q) { return this.store.search(q); }

  // ----------------------------------------------------------- automations
  listAutomations(boardId) { return this.automations.list(boardId); }
  saveAutomation(boardId, a) { return this.automations.save(boardId, a); }
  toggleAutomation(id, e) { return this.automations.toggle(id, e); }
  deleteAutomation(id) { return this.automations.remove(id); }
  automationLog(q) { return this.automations.log(q); }
  runSchedule(at) {
    const when = at ? new Date(at) : new Date();
    const made = this.recurring.tick(when);
    return this.automations.tick(when) + made;
  }

  // ------------------------------------------- recurring items, item templates
  getRecurrence(itemId) { return this.recurring.get(itemId); }
  setRecurrence(itemId, rule) { const r = this.recurring.set(itemId, rule); this.recurring.tick(); return r; }
  clearRecurrence(itemId) { return this.recurring.clear(itemId); }
  itemTemplates(boardId) { return this.recurring.itemTemplates(boardId); }
  saveItemTemplate(itemId, name) { return this.recurring.saveItemTemplate(itemId, name); }
  deleteItemTemplate(id) { return this.recurring.deleteItemTemplate(id); }
  addItemFromTemplate(templateId, opts) { return this.recurring.addFromTemplate(templateId, opts); }

  // --------------------------------------------------- portfolio, timesheets
  portfolio() { return this.reports.portfolio(); }
  setPortfolio(boardId, patch) { return this.reports.setPortfolio(boardId, patch); }
  timesheet(opts) { return this.reports.timesheet(opts); }
  addTime(itemId, columnId, entry) { return this.reports.addTime(itemId, columnId, entry); }
  removeTime(itemId, columnId, index) { return this.reports.removeTime(itemId, columnId, index); }
  timeTargets(q) { return this.reports.timeTargets(q); }
  timesheetCsv(opts) {
    const { entries } = this.reports.timesheet(opts);
    const people = this.store.peopleMap();
    const q = (x) => (/[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : String(x));
    const rows = [['Date', 'Person', 'Board', 'Item', 'Hours', 'Note', 'Entered by hand']];
    for (const e of entries) rows.push([e.date, e.personId && people[e.personId] ? people[e.personId].name : '', e.boardName, e.name, (e.seconds / 3600).toFixed(2), e.note, e.manual ? 'yes' : '']);
    return rows.map((r) => r.map(q).join(',')).join('\r\n');
  }

  // ------------------------------------------------------------ dashboards
  listDashboards() { return this.dashboards.list(); }
  getDashboard(id) { return this.dashboards.get(id); }
  saveDashboard(d) { return this.dashboards.save(d); }
  deleteDashboard(id) { return this.dashboards.remove(id); }
  saveWidget(dashboardId, w) { return this.dashboards.saveWidget(dashboardId, w); }
  deleteWidget(id) { return this.dashboards.removeWidget(id); }

  // --------------------------------------------------------------- my work
  /** Items assigned to me across all boards, bucketed by due date. */
  myWork({ includeDone = false, personId } = {}) {
    const me = personId || this.store.me().id;
    const t = today();
    const weekEnd = addDays(mondayOf(t), 6);
    const nextEnd = addDays(weekEnd, 7);
    const out = [];
    for (const b of this.db.all('SELECT id FROM boards WHERE archived=0')) {
      const peopleCols = this.db.all("SELECT id FROM columns WHERE board_id=? AND type='people'", [b.id]);
      if (!peopleCols.length) continue;
      const B = this.store.getBoard(b.id);
      const statusCol = B.columns.find((c) => c.scope === 'item' && c.type === 'status');
      const subStatus = B.columns.find((c) => c.scope === 'sub' && c.type === 'status');
      const dateCol = B.columns.find((c) => c.scope === 'item' && (c.type === 'date' || c.type === 'timeline'));
      const subDate = B.columns.find((c) => c.scope === 'sub' && (c.type === 'date' || c.type === 'timeline'));
      const consider = (it, sub) => {
        const pcs = B.columns.filter((c) => c.type === 'people' && c.scope === (sub ? 'sub' : 'item'));
        if (!pcs.some((c) => (it.values[c.id] || []).includes(me))) return;
        const sc = sub ? subStatus : statusCol;
        const dc = sub ? subDate : dateCol;
        const l = sc && C.labelOf(sc, it.values[sc.id]);
        if (l && l.done && !includeDone) return;
        const dv = dc && it.values[dc.id];
        const due = dv ? (dc.type === 'timeline' ? dv.end : String(dv).slice(0, 10)) : null;
        const bucket = l && l.done ? 'done' : !due ? 'none' : due < t ? 'overdue' : due === t ? 'today' : due <= weekEnd ? 'week' : due <= nextEnd ? 'next' : 'later';
        const g = B.groups.find((x) => x.id === (sub ? (B.items.find((p) => p.id === it.parent_id) || {}).group_id : it.group_id));
        out.push({
          id: it.id, parentId: it.parent_id || null, name: it.name, boardId: b.id, boardName: B.board.name, groupName: g ? g.name : '', groupColor: g ? C.colorHex(g.color) : '',
          due, bucket, status: l ? { id: l.id, label: l.label, color: C.colorHex(l.color) } : null, statusColumn: sc ? sc.id : null, dateColumn: dc ? dc.id : null, labels: sc ? sc.settings.labels : [],
          parentName: sub ? (B.items.find((p) => p.id === it.parent_id) || {}).name : null,
        });
      };
      for (const it of B.items) consider(it, false);
      for (const s of B.subitems) consider(s, true);
    }
    return out.sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')));
  }

  // ----------------------------------------------------------------- teams
  teams() { return this.store.teams(); }
  saveTeam(t) { return this.store.saveTeam(t); }
  deleteTeam(id) { return this.store.deleteTeam(id); }

  /**
   * Who is waiting on whom. Two kinds of link:
   *  - item: an item's Dependency column points at a predecessor item; the
   *    teams are each item's Team column (role owner), or its people's teams.
   *  - team: an item's "waiting on" Team column marks a team it depends on,
   *    with no item on their side (e.g. another department or a vendor).
   * Nothing is sent to anyone; this only records and reports.
   */
  dependencies() {
    const t = today();
    const teams = this.store.teams();
    const personTeams = {};
    for (const tm of teams) for (const pid of tm.members) (personTeams[pid] = personTeams[pid] || []).push(tm.id);
    const info = {};
    const raw = [];
    for (const b of this.db.all('SELECT id FROM boards WHERE archived=0')) {
      const B = this.store.getBoard(b.id);
      for (const scope of ['item', 'sub']) {
        const cols = B.columns.filter((c) => c.scope === scope);
        const status = cols.find((c) => c.type === 'status');
        const dateCol = cols.find((c) => c.type === 'timeline') || cols.find((c) => c.type === 'date');
        const owners = cols.filter((c) => c.type === 'team' && (c.settings.role || 'owner') === 'owner');
        const waits = cols.filter((c) => c.type === 'team' && c.settings.role === 'waiting');
        const people = cols.filter((c) => c.type === 'people');
        const deps = cols.filter((c) => c.type === 'dependency');
        for (const it of scope === 'item' ? B.items : B.subitems) {
          let tms = [...new Set(owners.flatMap((c) => it.values[c.id] || []))];
          if (!tms.length) tms = [...new Set(people.flatMap((c) => it.values[c.id] || []).flatMap((pid) => personTeams[pid] || []))];
          const dv = dateCol && it.values[dateCol.id];
          const l = status && C.labelOf(status, it.values[status.id]);
          const parent = it.parent_id ? B.items.find((x) => x.id === it.parent_id) : null;
          const g = B.groups.find((x) => x.id === (parent ? parent.group_id : it.group_id));
          info[it.id] = {
            id: it.id, name: it.name, parentName: parent ? parent.name : null, boardId: b.id, boardName: B.board.name, groupName: g ? g.name : '',
            start: dv ? (dateCol.type === 'timeline' ? dv.start : String(dv).slice(0, 10)) : null,
            due: dv ? (dateCol.type === 'timeline' ? dv.end : String(dv).slice(0, 10)) : null,
            done: !!(l && l.done), status: l ? { label: l.label, color: C.colorHex(l.color) } : null, teams: tms,
          };
          for (const c of deps) for (const pid of it.values[c.id] || []) raw.push({ kind: 'item', from: pid, to: it.id, column: c.title });
          for (const c of waits) for (const tid of it.values[c.id] || []) raw.push({ kind: 'team', team: tid, to: it.id, column: c.title });
        }
      }
    }
    const links = [];
    for (const r of raw) {
      const S = info[r.to];
      if (!S) continue;
      if (r.kind === 'item') {
        const P = info[r.from];
        if (!P) continue;
        let state = 'on_track';
        if (P.done) state = 'done';
        else if ((P.due && P.due < t) || (S.start && S.start <= t)) state = 'blocked';
        else if (P.due && S.start && P.due >= S.start) state = 'at_risk';
        const cross = P.teams.length > 0 && S.teams.length > 0 && P.teams.join() !== S.teams.join();
        links.push({ key: `${P.id}>${S.id}`, kind: 'item', providers: P.teams, waiting: S.teams, predecessor: P, successor: S, state, cross, column: r.column });
      } else {
        let state = 'waiting';
        if (S.done) state = 'done';
        else if ((S.start && S.start <= t) || (S.due && S.due < t)) state = 'blocked';
        links.push({ key: `${r.team}>${S.id}`, kind: 'team', providers: [r.team], waiting: S.teams, predecessor: null, successor: S, state, cross: !S.teams.includes(r.team), column: r.column });
      }
    }
    const rank = { blocked: 0, at_risk: 1, waiting: 2, on_track: 3, done: 4 };
    links.sort((a, b) => rank[a.state] - rank[b.state] || String(a.successor.start || '9').localeCompare(String(b.successor.start || '9')));
    const matrix = {};
    for (const l of links) {
      if (l.state === 'done' || !l.cross) continue;
      for (const w of l.waiting.length ? l.waiting : ['']) for (const p of l.providers.length ? l.providers : ['']) {
        if (w === p) continue;
        const k = `${w}|${p}`;
        matrix[k] = matrix[k] || { waiting: w, provider: p, open: 0, blocked: 0 };
        matrix[k].open++;
        if (l.state === 'blocked') matrix[k].blocked++;
      }
    }
    const openCross = links.filter((l) => l.cross && l.state !== 'done');
    return {
      teams, links, matrix: Object.values(matrix),
      summary: { open: openCross.length, blocked: openCross.filter((l) => l.state === 'blocked').length, atRisk: openCross.filter((l) => l.state === 'at_risk').length, external: openCross.filter((l) => l.kind === 'team').length },
    };
  }

  // -------------------------------------------------------------- calendar
  /**
   * Dated work across every board between two days (inclusive), for the main
   * calendar. Each entry is one item on one date or timeline column.
   */
  calendar({ from, to, includeSubitems = true } = {}) {
    const out = [];
    const boards = [];
    for (const b of this.db.all('SELECT id FROM boards WHERE archived=0 ORDER BY position, name')) {
      const has = this.db.get("SELECT COUNT(*) AS n FROM columns WHERE board_id=? AND type IN ('date','timeline')", [b.id]).n;
      if (!has) continue;
      const B = this.store.getBoard(b.id);
      const dateCols = B.columns.filter((c) => c.type === 'date' || c.type === 'timeline');
      boards.push({ id: b.id, name: B.board.name, noun: B.board.item_noun || 'item', dateColumns: dateCols.filter((c) => c.scope === 'item').map((c) => ({ id: c.id, title: c.title, type: c.type })) });
      const status = { item: B.columns.find((c) => c.scope === 'item' && c.type === 'status'), sub: B.columns.find((c) => c.scope === 'sub' && c.type === 'status') };
      const consider = (it, scope) => {
        const sc = status[scope];
        const l = sc && C.labelOf(sc, it.values[sc.id]);
        const parent = scope === 'sub' ? B.items.find((p) => p.id === it.parent_id) : null;
        const g = B.groups.find((x) => x.id === (parent ? parent.group_id : it.group_id));
        const people = [...new Set(B.columns.filter((c) => c.scope === scope && c.type === 'people').flatMap((c) => it.values[c.id] || []))];
        for (const c of dateCols.filter((x) => x.scope === scope)) {
          const v = it.values[c.id];
          if (!v) continue;
          const start = c.type === 'timeline' ? v.start : String(v).slice(0, 10);
          const end = c.type === 'timeline' ? (v.end || v.start) : start;
          if (!start || (to && start > to) || (from && end < from)) continue;
          out.push({
            key: `${it.id}:${c.id}`, id: it.id, name: it.name, parentName: parent ? parent.name : null, boardId: b.id, boardName: B.board.name,
            groupName: g ? g.name : '', columnId: c.id, columnTitle: c.title, type: c.type, start, end, time: c.type === 'date' && String(v).length > 10 ? String(v).slice(11, 16) : null,
            raw: v, people, done: !!(l && l.done), status: l ? { label: l.label, color: C.colorHex(l.color) } : null,
            color: l ? C.colorHex(l.color) : g ? C.colorHex(g.color) : '#5a55d6',
          });
        }
      };
      for (const it of B.items) consider(it, 'item');
      if (includeSubitems) for (const s of B.subitems) consider(s, 'sub');
    }
    out.sort((a, b) => a.start.localeCompare(b.start) || String(a.time || '').localeCompare(String(b.time || '')) || a.name.localeCompare(b.name));
    return { entries: out, boards };
  }

  // --------------------------------------------------------- notifications
  notifications(q) { return this.store.notifications(q); }
  markRead(ids, read) { return this.store.markRead(ids, read); }
  takeUnshown() { return this.getSettings().desktopNotifications ? this.store.takeUnshown() : []; }

  /** The reminder digest of my work. */
  digest() {
    const w = this.myWork();
    const overdue = w.filter((x) => x.bucket === 'overdue');
    const todayL = w.filter((x) => x.bucket === 'today');
    const week = w.filter((x) => x.bucket === 'week');
    const lines = [
      ...overdue.slice(0, 3).map((x) => `Overdue: ${x.name} (${x.boardName})`),
      ...todayL.slice(0, 3).map((x) => `Today: ${x.name} (${x.boardName})`),
    ];
    const headline = overdue.length || todayL.length
      ? `${overdue.length} overdue, ${todayL.length} due today, ${week.length} more this week`
      : week.length ? `${week.length} due later this week. Nothing overdue.` : 'Nothing due. Enjoy the clear day.';
    return { title: 'Your Boardenda agenda', headline, lines, overdue: overdue.length, today: todayL.length, week: week.length };
  }
  /** Called every minute: returns a digest when the configured slot has arrived. */
  checkNotification(at = new Date()) {
    const s = this.getSettings().digest;
    if (!s.enabled) return null;
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    if (hhmm < s.time) return null;
    const dow = ((at.getDay() + 6) % 7) + 1;
    if (s.frequency === 'weekly' && dow !== Number(s.weekday || 1)) return null;
    if (s.frequency === 'weekdays' && dow > 5) return null;
    const key = `digest:${today(at)}`;
    if (!this.automations.once(key)) return null;
    return this.digest();
  }

  // ----------------------------------------------------------- import/export
  importTable(args) { return io.importTable(this.store, args); }
  async exportXlsx(boardIds) { return io.exportXlsx(this.store, Array.isArray(boardIds) ? boardIds : [boardIds]); }
  exportCsv(boardId) { return io.exportCsv(this.store, boardId); }
  exportBoardFile(boardId) { return io.exportBoardFile(this.store, boardId); }
  importBoardFile(text, o) { return io.importBoardFile(this.store, typeof text === 'string' ? text : Buffer.from(text).toString('utf8'), o); }

  // --------------------------------------------------------------- backups
  backupsDir() { return this.dataDir ? path.join(this.dataDir, 'Backups') : null; }
  backup(reason = 'manual') {
    const dir = this.backupsDir();
    if (!dir) return null;
    fs.mkdirSync(dir, { recursive: true });
    const name = `boardenda-${now().replace(/[:.]/g, '-').slice(0, 19)}-${reason}.db`;
    fs.writeFileSync(path.join(dir, name), this.db.exportBytes());
    this.pruneBackups();
    return name;
  }
  autoBackup() {
    try {
      const dir = this.backupsDir();
      const last = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('-daily.db')).sort().pop() : null;
      if (!last || last.slice(10, 20) < today()) {
        if (this.db.get('SELECT COUNT(*) AS n FROM items').n > 0) this.backup('daily');
      }
    } catch (_) { /* never block start-up on a backup */ }
  }
  pruneBackups() {
    const dir = this.backupsDir();
    const keep = this.getSettings().backupsKeep || 14;
    const daily = fs.readdirSync(dir).filter((f) => f.endsWith('-daily.db')).sort();
    for (const f of daily.slice(0, Math.max(0, daily.length - keep))) fs.unlinkSync(path.join(dir, f));
  }
  listBackups() {
    const dir = this.backupsDir();
    if (!dir || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort().reverse().map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }));
  }
  async restoreBackup(name) {
    const file = path.join(this.backupsDir(), path.basename(name));
    if (!fs.existsSync(file)) throw new Error('Backup not found');
    this.backup('before-restore');
    const { loadSql } = require('./db');
    const S = await loadSql();
    const restored = new S.Database(fs.readFileSync(file));
    this.db.db.close();
    this.db.db = restored;
    this.db.migrate();
    this.undoStack = [];
    return true;
  }
  stats() {
    const n = (sql) => this.db.get(sql).n;
    return {
      boards: n('SELECT COUNT(*) AS n FROM boards WHERE archived=0'), items: n('SELECT COUNT(*) AS n FROM items WHERE archived=0'),
      updates: n('SELECT COUNT(*) AS n FROM updates'), automations: n('SELECT COUNT(*) AS n FROM automations'), files: n('SELECT COUNT(*) AS n FROM files'),
      dbBytes: this.db.exportBytes().length, dataDir: this.dataDir, integrity: this.db.integrityCheck(),
    };
  }
}

/** Keep doc HTML to plain formatting: no scripts, styles, handlers or script URLs. */
function cleanHtml(html) {
  return String(html || '')
    .replace(/<(script|style|iframe|object|embed|link|meta|base|form|svg|math)[\s\S]*?(<\/\1\s*>|$)/gi, '')
    .replace(/<\/?(script|style|iframe|object|embed|link|meta|base|form|svg|math)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')?\s*(javascript|vbscript|data):[^"'\s>]*("|')?/gi, '$1="#"')
    .slice(0, 2000000);
}

const PUBLIC_METHODS = Object.getOwnPropertyNames(AppApi.prototype).filter((m) => ![
  'constructor', 'withLog', 'backupsDir', 'autoBackup', 'pruneBackups', 'filePath', 'takeUnshown', 'checkNotification', 'pushUndo', 'lastTrash',
].includes(m));

module.exports = { AppApi, PUBLIC_METHODS, DEFAULT_SETTINGS };
