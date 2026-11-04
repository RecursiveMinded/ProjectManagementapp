'use strict';
// The application API. Electron (over IPC) and the dev server (over HTTP)
// expose exactly the methods listed in PUBLIC_METHODS.

const fs = require('fs');
const path = require('path');
const { Database } = require('./db');
const { Store } = require('./store');
const { Automations, TRIGGERS, ACTIONS } = require('./automations');
const { Dashboards, WIDGETS } = require('./dashboards');
const T = require('./templates');
const io = require('./io');
const C = require('./columns');
const { today, addDays, now, mondayOf, parseJson } = require('./util');

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
    this.store.me();
    if (dataDir) this.autoBackup();
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
  createBoard({ template = 'blank', workspaceId, name, sample = false } = {}) { return T.build(this.store, this.automations, template, { workspaceId, name, sample }); }
  getBoard(id) { return this.store.getBoard(id); }
  updateBoard(id, patch) { return this.store.updateBoard(id, patch); }
  duplicateBoard(id, opts) { return this.store.duplicateBoard(id, opts); }
  archiveBoard(id, archived) { return this.store.archiveBoard(id, archived); }
  deleteBoard(id) { return this.store.deleteBoard(id); }
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
  deleteGroup(id) { return this.store.deleteGroup(id); }
  archiveGroup(id, a) { return this.store.archiveGroup(id, a); }
  duplicateGroup(id) { return this.store.duplicateGroup(id); }

  addColumn(boardId, c) { return this.store.addColumn(boardId, c); }
  updateColumn(id, patch) { return this.store.updateColumn(id, patch); }
  deleteColumn(id) { return this.store.deleteColumn(id); }
  duplicateColumn(id, o) { return this.store.duplicateColumn(id, o); }

  addItem(boardId, it) { return this.store.addItem(boardId, it); }
  renameItem(id, name) { return this.store.renameItem(id, name); }
  setValue(itemId, columnId, value) { return this.store.setValue(itemId, columnId, value); }
  setValues(itemId, values) { return this.store.setValues(itemId, values); }
  moveItem(id, to) { return this.store.moveItem(id, to); }
  duplicateItem(id, o) { return this.store.duplicateItem(id, o); }
  archiveItem(id, a) { return this.store.archiveItem(id, a); }
  deleteItem(id) { return this.store.deleteItem(id); }
  bulk(ids, op, arg) { return this.store.bulk(ids, op, arg); }
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
  runSchedule(at) { return this.automations.tick(at ? new Date(at) : new Date()); }

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

const PUBLIC_METHODS = Object.getOwnPropertyNames(AppApi.prototype).filter((m) => ![
  'constructor', 'withLog', 'backupsDir', 'autoBackup', 'pruneBackups', 'filePath', 'takeUnshown', 'checkNotification',
].includes(m));

module.exports = { AppApi, PUBLIC_METHODS, DEFAULT_SETTINGS };
