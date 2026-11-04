'use strict';
// SQLite via sql.js (WebAssembly). No native modules, so the Windows build has
// nothing to compile. The database lives in memory and is written to disk
// atomically (temp file + rename) after every committed change.

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 2;

// Everything on a board is stored relationally except cell values, which are
// one JSON object per item keyed by column id (typed by the column).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT DEFAULT '',
  team TEXT DEFAULT '',
  color TEXT DEFAULT '',
  is_me INTEGER DEFAULT 0,
  capacity REAL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT DEFAULT 'indigo',
  description TEXT DEFAULT '',
  external INTEGER DEFAULT 0,
  position REAL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  PRIMARY KEY (team_id, person_id)
);
CREATE TABLE IF NOT EXISTS trash (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  board_id TEXT,
  board_name TEXT DEFAULT '',
  payload TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT DEFAULT '',
  position REAL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  folder TEXT DEFAULT '',
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  item_noun TEXT DEFAULT 'item',
  position REAL DEFAULT 0,
  settings TEXT DEFAULT '{}',
  archived INTEGER DEFAULT 0,
  next_seq INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT DEFAULT '',
  position REAL DEFAULT 0,
  collapsed INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_groups_board ON groups(board_id);
CREATE TABLE IF NOT EXISTS columns (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'item',
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT DEFAULT '',
  position REAL DEFAULT 0,
  width INTEGER DEFAULT 0,
  settings TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_columns_board ON columns(board_id);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  group_id TEXT,
  parent_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position REAL DEFAULT 0,
  seq INTEGER DEFAULT 0,
  data TEXT DEFAULT '{}',
  archived INTEGER DEFAULT 0,
  created_by TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_items_board ON items(board_id);
CREATE INDEX IF NOT EXISTS ix_items_parent ON items(parent_id);
CREATE TABLE IF NOT EXISTS updates (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  parent_id TEXT,
  author TEXT DEFAULT '',
  body TEXT NOT NULL,
  pinned INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  edited_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_updates_item ON updates(item_id);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  column_id TEXT DEFAULT '',
  name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size INTEGER DEFAULT 0,
  added_by TEXT DEFAULT '',
  added_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_files_item ON files(item_id);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT DEFAULT '',
  board_id TEXT,
  item_id TEXT,
  action TEXT NOT NULL,
  column_id TEXT DEFAULT '',
  old_value TEXT,
  new_value TEXT,
  source TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_activity_board ON activity(board_id);
CREATE INDEX IF NOT EXISTS ix_activity_item ON activity(item_id);
CREATE TABLE IF NOT EXISTS views (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  position REAL DEFAULT 0,
  config TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  recipe TEXT NOT NULL,
  runs INTEGER DEFAULT 0,
  last_run TEXT,
  last_error TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS automation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id TEXT,
  board_id TEXT,
  item_id TEXT,
  ts TEXT NOT NULL,
  ok INTEGER DEFAULT 1,
  summary TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS fired (
  key TEXT PRIMARY KEY,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  board_ids TEXT DEFAULT '[]',
  position REAL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS widgets (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT DEFAULT '',
  position REAL DEFAULT 0,
  size TEXT DEFAULT 'm',
  config TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  person_id TEXT,
  kind TEXT DEFAULT '',
  title TEXT DEFAULT '',
  body TEXT DEFAULT '',
  board_id TEXT,
  item_id TEXT,
  read INTEGER DEFAULT 0,
  shown INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

let SQL = null;
async function loadSql() {
  if (SQL) return SQL;
  const initSqlJs = require('sql.js');
  const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
  SQL = await initSqlJs({ locateFile: (f) => path.join(wasmDir, f) });
  return SQL;
}

class Database {
  constructor(sqlDb, file) {
    this.db = sqlDb;
    this.file = file; // null = in-memory only (tests)
    this.depth = 0;
    this.dirty = false;
    this.db.run('PRAGMA foreign_keys = ON;');
  }

  static async open(file) {
    const S = await loadSql();
    let sqlDb;
    if (file && fs.existsSync(file)) {
      sqlDb = new S.Database(fs.readFileSync(file));
    } else {
      sqlDb = new S.Database();
    }
    const d = new Database(sqlDb, file || null);
    d.migrate();
    return d;
  }

  /** v2: teams. Turn the free-text team on each person into real teams. */
  upgradeTo2() {
    const names = this.all("SELECT DISTINCT team FROM people WHERE team<>''").map((r) => r.team);
    let pos = 0;
    for (const name of names) {
      const id = `t${Date.now().toString(36)}${Math.random().toString(16).slice(2, 10)}`;
      this.run('INSERT INTO teams(id,name,color,position,created_at) VALUES(?,?,?,?,?)', [id, name, ['indigo', 'teal', 'tangerine', 'grape', 'mint', 'rose'][pos % 6], ++pos, new Date().toISOString()]);
      this.run('INSERT OR IGNORE INTO team_members(team_id,person_id) SELECT ?, id FROM people WHERE team=?', [id, name]);
    }
  }

  migrate() {
    this.db.exec(SCHEMA);
    const v = this.get("SELECT value FROM settings WHERE key='schema_version'");
    const from = v ? Number(JSON.parse(v.value)) : SCHEMA_VERSION;
    if (from < 2) this.upgradeTo2();
    const ver = JSON.stringify(SCHEMA_VERSION);
    if (!v) this.run("INSERT INTO settings(key,value) VALUES('schema_version', ?)", [ver]);
    else if (v.value !== ver) this.run("UPDATE settings SET value=? WHERE key='schema_version'", [ver]);
    this.save();
  }

  run(sql, params = []) {
    this.db.run(sql, params);
    this.dirty = true;
    if (this.depth === 0) this.save();
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(sql, params = []) {
    return this.all(sql, params)[0] || null;
  }

  lastId() {
    return this.get('SELECT last_insert_rowid() AS id').id;
  }

  /** Run fn inside a transaction; all-or-nothing, one disk write at the end. */
  tx(fn) {
    if (this.depth > 0) {
      this.depth++;
      try { return fn(); } finally { this.depth--; }
    }
    this.depth = 1;
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      this.depth = 0;
      this.save();
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
      this.depth = 0;
      throw e;
    }
  }

  save() {
    if (!this.file) { this.dirty = false; return; }
    const data = Buffer.from(this.db.export());
    // sql.js export() resets pragmas on some versions; re-enable FK checks.
    this.db.run('PRAGMA foreign_keys = ON;');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  exportBytes() {
    return Buffer.from(this.db.export());
  }

  integrityCheck() {
    const r = this.get('PRAGMA integrity_check');
    return r ? Object.values(r)[0] : 'unknown';
  }

  close() {
    if (this.dirty) this.save();
    this.db.close();
  }
}

module.exports = { Database, loadSql, SCHEMA_VERSION };
