'use strict';
// The work-management model: people, workspaces, boards, groups, columns,
// items and subitems, updates, files, views and activity. Every mutation goes
// through here so that activity is logged, dependencies are shifted and
// automations hear about it.

const fs = require('fs');
const path = require('path');
const C = require('./columns');
const F = require('./formula');
const { uid, now, today, addDays, daysBetween, parseJson } = require('./util');

const GROUP_COLORS = ['ocean', 'mint', 'tangerine', 'grape', 'coral', 'teal', 'sun', 'rose', 'indigo', 'leaf'];
const PERSON_COLORS = ['#2f6fdf', '#13a89e', '#8a4fd8', '#e4497a', '#f28a2e', '#66a83a', '#5a55d6', '#c24fbf', '#3aa0e8', '#a3245a'];

class Store {
  constructor(db, { filesDir } = {}) {
    this.db = db;
    this.filesDir = filesDir || null;
    this.listeners = [];
    this.depth = 0;
  }

  on(fn) { this.listeners.push(fn); }
  emit(ev) {
    if (this.muted) return;
    if (this.depth > 6) return; // automations triggering automations: stop runaway chains
    this.depth++;
    try { for (const fn of this.listeners) fn(ev); } finally { this.depth--; }
  }

  // ---------------------------------------------------------------- people
  people() {
    return this.db.all('SELECT * FROM people ORDER BY is_me DESC, name COLLATE NOCASE').map((p) => ({ ...p, is_me: !!p.is_me }));
  }
  peopleMap() { return Object.fromEntries(this.people().map((p) => [p.id, p])); }
  me() {
    let m = this.db.get('SELECT * FROM people WHERE is_me=1');
    if (!m) {
      const id = uid('p');
      this.db.run('INSERT INTO people(id,name,email,color,is_me,created_at) VALUES(?,?,?,?,1,?)', [id, 'Me', '', PERSON_COLORS[0], now()]);
      m = this.db.get('SELECT * FROM people WHERE id=?', [id]);
    }
    return m;
  }
  savePerson(p) {
    const name = String(p.name || '').trim();
    if (!name) throw new Error('A name is required');
    let id = p.id;
    if (id && this.db.get('SELECT id FROM people WHERE id=?', [id])) {
      this.db.run('UPDATE people SET name=?, email=?, color=?, capacity=? WHERE id=?', [name, p.email || '', p.color || '', Number(p.capacity) || 0, id]);
    } else {
      id = uid('p');
      const n = this.db.get('SELECT COUNT(*) AS n FROM people').n;
      this.db.run('INSERT INTO people(id,name,email,team,color,is_me,capacity,created_at) VALUES(?,?,?,?,?,0,?,?)', [id, name, p.email || '', '', p.color || PERSON_COLORS[n % PERSON_COLORS.length], Number(p.capacity) || 0, now()]);
    }
    // Team membership: explicit ids, or a team name (created if new).
    let teamIds = Array.isArray(p.teamIds) ? p.teamIds : null;
    if (!teamIds && typeof p.team === 'string' && p.team.trim()) teamIds = [this.teamByName(p.team, true).id];
    if (teamIds) this.setPersonTeams(id, teamIds);
    return id;
  }
  setPersonTeams(personId, teamIds) {
    this.db.run('DELETE FROM team_members WHERE person_id=?', [personId]);
    for (const t of teamIds) this.db.run('INSERT OR IGNORE INTO team_members(team_id,person_id) VALUES(?,?)', [t, personId]);
    this.syncTeamText(personId);
  }
  syncTeamText(personId) {
    const names = this.db.all('SELECT t.name FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.person_id=? ORDER BY t.position, t.name', [personId]).map((r) => r.name);
    this.db.run('UPDATE people SET team=? WHERE id=?', [names.join(', '), personId]);
  }

  // ----------------------------------------------------------------- teams
  teams() {
    const members = this.db.all('SELECT * FROM team_members');
    return this.db.all('SELECT * FROM teams ORDER BY position, name COLLATE NOCASE').map((t) => ({
      ...t, external: !!t.external, members: members.filter((m) => m.team_id === t.id).map((m) => m.person_id),
    }));
  }
  teamsMap() { return Object.fromEntries(this.teams().map((t) => [t.id, t])); }
  teamByName(name, create = false) {
    const n = String(name || '').trim();
    const hit = this.db.get('SELECT * FROM teams WHERE lower(name)=lower(?)', [n]);
    if (hit || !create || !n) return hit || null;
    return { id: this.saveTeam({ name: n }) };
  }
  saveTeam(t) {
    const name = String(t.name || '').trim();
    if (!name) throw new Error('A team name is required');
    const dup = this.db.get('SELECT id FROM teams WHERE lower(name)=lower(?) AND id<>?', [name, t.id || '']);
    if (dup) throw new Error(`There is already a team called ${name}`);
    let id = t.id;
    if (id && this.db.get('SELECT id FROM teams WHERE id=?', [id])) {
      const old = this.db.get('SELECT * FROM teams WHERE id=?', [id]);
      this.db.run('UPDATE teams SET name=?, color=?, description=?, external=? WHERE id=?',
        [name, t.color || old.color, t.description != null ? t.description : old.description, t.external != null ? (t.external ? 1 : 0) : old.external, id]);
    } else {
      id = uid('t');
      const n = this.db.get('SELECT COUNT(*) AS n, MAX(position) AS m FROM teams');
      this.db.run('INSERT INTO teams(id,name,color,description,external,position,created_at) VALUES(?,?,?,?,?,?,?)',
        [id, name, t.color || GROUP_COLORS[n.n % GROUP_COLORS.length], t.description || '', t.external ? 1 : 0, (n.m || 0) + 1, now()]);
    }
    if (Array.isArray(t.members)) {
      const before = this.db.all('SELECT person_id FROM team_members WHERE team_id=?', [id]).map((r) => r.person_id);
      this.db.run('DELETE FROM team_members WHERE team_id=?', [id]);
      for (const pid of t.members) this.db.run('INSERT OR IGNORE INTO team_members(team_id,person_id) VALUES(?,?)', [id, pid]);
      for (const pid of new Set([...before, ...t.members])) this.syncTeamText(pid);
    } else {
      for (const r of this.db.all('SELECT person_id FROM team_members WHERE team_id=?', [id])) this.syncTeamText(r.person_id);
    }
    return id;
  }
  deleteTeam(id) {
    const members = this.db.all('SELECT person_id FROM team_members WHERE team_id=?', [id]).map((r) => r.person_id);
    this.db.run('DELETE FROM team_members WHERE team_id=?', [id]);
    this.db.run('DELETE FROM teams WHERE id=?', [id]);
    for (const pid of members) this.syncTeamText(pid);
  }
  deletePerson(id) {
    const p = this.db.get('SELECT * FROM people WHERE id=?', [id]);
    if (!p) return;
    if (p.is_me) throw new Error('You cannot remove yourself');
    this.db.run('DELETE FROM people WHERE id=?', [id]);
    this.db.run('DELETE FROM team_members WHERE person_id=?', [id]);
  }
  personByName(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    return this.people().find((p) => p.name.toLowerCase() === n || (p.email && p.email.toLowerCase() === n)) || null;
  }

  // ------------------------------------------------------------ workspaces
  workspaces() {
    const ws = this.db.all('SELECT * FROM workspaces ORDER BY position, name');
    const boards = this.db.all('SELECT id, workspace_id, folder, name, description, position, archived, updated_at FROM boards ORDER BY position, name');
    const counts = Object.fromEntries(this.db.all('SELECT board_id, COUNT(*) AS n FROM items WHERE archived=0 AND parent_id IS NULL GROUP BY board_id').map((r) => [r.board_id, r.n]));
    return ws.map((w) => ({
      ...w,
      boards: boards.filter((b) => b.workspace_id === w.id && !b.archived).map((b) => ({ ...b, items: counts[b.id] || 0 })),
    }));
  }
  saveWorkspace(w) {
    const name = String(w.name || '').trim() || 'Workspace';
    if (w.id && this.db.get('SELECT id FROM workspaces WHERE id=?', [w.id])) {
      this.db.run('UPDATE workspaces SET name=?, color=? WHERE id=?', [name, w.color || '', w.id]);
      return w.id;
    }
    const id = uid('w');
    const pos = (this.db.get('SELECT MAX(position) AS m FROM workspaces').m || 0) + 1;
    this.db.run('INSERT INTO workspaces(id,name,color,position,created_at) VALUES(?,?,?,?,?)', [id, name, w.color || 'indigo', pos, now()]);
    return id;
  }
  deleteWorkspace(id) {
    this.db.tx(() => {
      for (const b of this.db.all('SELECT id FROM boards WHERE workspace_id=?', [id])) this.deleteBoard(b.id);
      this.db.run('DELETE FROM docs WHERE workspace_id=? AND item_id IS NULL', [id]);
      this.db.run('DELETE FROM workspaces WHERE id=?', [id]);
    });
  }

  // ---------------------------------------------------------------- boards
  boardRow(id) {
    const b = this.db.get('SELECT * FROM boards WHERE id=?', [id]);
    if (!b) throw new Error('Board not found');
    return { ...b, settings: parseJson(b.settings, {}), archived: !!b.archived };
  }
  createBoard({ workspaceId, name, description = '', folder = '', itemNoun = 'item', groups, columns, views } = {}) {
    if (!workspaceId) workspaceId = (this.db.get('SELECT id FROM workspaces ORDER BY position LIMIT 1') || {}).id || this.saveWorkspace({ name: 'Main workspace' });
    const id = uid('b');
    const ts = now();
    const pos = (this.db.get('SELECT MAX(position) AS m FROM boards WHERE workspace_id=?', [workspaceId]).m || 0) + 1;
    this.db.tx(() => {
      this.db.run('INSERT INTO boards(id,workspace_id,folder,name,description,item_noun,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [id, workspaceId, folder, String(name || 'New board').trim(), description, itemNoun, pos, ts, ts]);
      for (const [i, g] of (groups || [{ name: 'To do' }, { name: 'Done', color: 'mint' }]).entries()) this.addGroup(id, { ...g, position: i + 1 });
      for (const [i, c] of (columns || [
        { title: 'Owner', type: 'people' }, { title: 'Status', type: 'status' }, { title: 'Due date', type: 'date' },
      ]).entries()) this.addColumn(id, { ...c, position: i + 1 });
      for (const [i, v] of (views || [{ name: 'Main table', type: 'table' }]).entries()) this.saveView(id, { ...v, position: i + 1 });
      this.log({ boardId: id, action: 'board_created', newValue: name });
    });
    return id;
  }
  updateBoard(id, patch) {
    const b = this.boardRow(id);
    const next = {
      name: patch.name != null ? String(patch.name).trim() || b.name : b.name,
      description: patch.description != null ? patch.description : b.description,
      folder: patch.folder != null ? patch.folder : b.folder,
      item_noun: patch.itemNoun != null ? patch.itemNoun : b.item_noun,
      workspace_id: patch.workspaceId || b.workspace_id,
      settings: patch.settings ? { ...b.settings, ...patch.settings } : b.settings,
    };
    this.db.run('UPDATE boards SET name=?, description=?, folder=?, item_noun=?, workspace_id=?, settings=?, updated_at=? WHERE id=?',
      [next.name, next.description, next.folder, next.item_noun, next.workspace_id, JSON.stringify(next.settings), now(), id]);
    if (patch.name && patch.name !== b.name) this.log({ boardId: id, action: 'board_renamed', oldValue: b.name, newValue: next.name });
  }
  archiveBoard(id, archived = true) {
    this.boardRow(id);
    this.db.run('UPDATE boards SET archived=?, updated_at=? WHERE id=?', [archived ? 1 : 0, now(), id]);
    this.log({ boardId: id, action: archived ? 'board_archived' : 'board_restored' });
  }
  deleteBoard(id, { trash = true } = {}) {
    const b = this.boardRow(id);
    this.db.tx(() => {
      if (trash) this.toTrash('board', b.name, id, b.name, this.snapshot({ boards: [id] }));
      else for (const f of this.db.all('SELECT f.* FROM files f JOIN items i ON i.id=f.item_id WHERE i.board_id=?', [id])) this.unlinkFile(f);
      this.db.run('DELETE FROM items WHERE board_id=? AND parent_id IS NOT NULL', [id]);
      this.db.run('DELETE FROM boards WHERE id=?', [id]);
      this.db.run('DELETE FROM activity WHERE board_id=?', [id]);
    });
  }
  moveBoardTo(id, workspaceId, position) {
    this.db.run('UPDATE boards SET workspace_id=?, position=? WHERE id=?', [workspaceId, position != null ? position : Date.now() / 1e12, id]);
  }
  /** Copy a board's structure (groups, columns, views, automations) and optionally its items. */
  duplicateBoard(id, { withItems = true, name } = {}) {
    const b = this.boardRow(id);
    const nid = uid('b');
    const ts = now();
    const map = {};
    this.db.tx(() => {
      this.db.run('INSERT INTO boards(id,workspace_id,folder,name,description,item_noun,position,settings,next_seq,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        [nid, b.workspace_id, b.folder, name || `${b.name} (copy)`, b.description, b.item_noun, b.position + 0.5, JSON.stringify(b.settings), withItems ? b.next_seq : 1, ts, ts]);
      for (const g of this.db.all('SELECT * FROM groups WHERE board_id=?', [id])) {
        map[g.id] = uid('g');
        this.db.run('INSERT INTO groups(id,board_id,name,color,position,collapsed,archived) VALUES(?,?,?,?,?,?,?)', [map[g.id], nid, g.name, g.color, g.position, g.collapsed, g.archived]);
      }
      const cols = this.db.all('SELECT * FROM columns WHERE board_id=?', [id]);
      for (const c of cols) map[c.id] = uid('c');
      for (const c of cols) {
        const s = remapSettings(parseJson(c.settings, {}), map);
        this.db.run('INSERT INTO columns(id,board_id,scope,title,type,description,position,width,settings) VALUES(?,?,?,?,?,?,?,?,?)', [map[c.id], nid, c.scope, c.title, c.type, c.description, c.position, c.width, JSON.stringify(s)]);
      }
      for (const v of this.db.all('SELECT * FROM views WHERE board_id=?', [id])) {
        this.db.run('INSERT INTO views(id,board_id,name,type,position,config) VALUES(?,?,?,?,?,?)', [uid('v'), nid, v.name, v.type, v.position, JSON.stringify(remapSettings(parseJson(v.config, {}), map))]);
      }
      for (const a of this.db.all('SELECT * FROM automations WHERE board_id=?', [id])) {
        this.db.run('INSERT INTO automations(id,board_id,name,enabled,recipe,created_at) VALUES(?,?,?,?,?,?)', [uid('a'), nid, a.name, a.enabled, JSON.stringify(remapSettings(parseJson(a.recipe, {}), map)), ts]);
      }
      if (withItems) {
        const items = this.db.all('SELECT * FROM items WHERE board_id=? AND archived=0 ORDER BY parent_id IS NOT NULL', [id]);
        for (const it of items) map[it.id] = uid('i');
        for (const it of items) {
          const data = {};
          for (const [k, v] of Object.entries(parseJson(it.data, {}))) if (map[k]) data[map[k]] = remapValue(v, map);
          this.db.run('INSERT INTO items(id,board_id,group_id,parent_id,name,position,seq,data,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            [map[it.id], nid, it.group_id ? map[it.group_id] : null, it.parent_id ? map[it.parent_id] : null, it.name, it.position, it.seq, JSON.stringify(data), it.created_by, ts, ts]);
        }
      }
    });
    return nid;
  }

  // ---------------------------------------------------------------- groups
  addGroup(boardId, { name, color, position, top } = {}) {
    const id = uid('g');
    const n = this.db.get('SELECT COUNT(*) AS n, MAX(position) AS mx, MIN(position) AS mn FROM groups WHERE board_id=?', [boardId]);
    const pos = position != null ? position : top ? (n.mn || 1) - 1 : (n.mx || 0) + 1;
    this.db.run('INSERT INTO groups(id,board_id,name,color,position) VALUES(?,?,?,?,?)', [id, boardId, String(name || 'New group').trim(), color || GROUP_COLORS[n.n % GROUP_COLORS.length], pos]);
    return id;
  }
  updateGroup(id, patch) {
    const g = this.db.get('SELECT * FROM groups WHERE id=?', [id]);
    if (!g) throw new Error('Group not found');
    this.db.run('UPDATE groups SET name=?, color=?, collapsed=?, position=? WHERE id=?', [
      patch.name != null ? String(patch.name).trim() || g.name : g.name, patch.color || g.color,
      patch.collapsed != null ? (patch.collapsed ? 1 : 0) : g.collapsed, patch.position != null ? patch.position : g.position, id]);
  }
  deleteGroup(id) {
    const g = this.db.get('SELECT * FROM groups WHERE id=?', [id]);
    if (!g) return;
    const b = this.boardRow(g.board_id);
    this.db.tx(() => {
      this.toTrash('group', g.name, g.board_id, b.name, this.snapshot({ groups: [id] }));
      this.db.run('DELETE FROM items WHERE group_id=? AND parent_id IS NULL AND id IN (SELECT id FROM items)', [id]);
      this.db.run('DELETE FROM groups WHERE id=?', [id]);
      this.log({ boardId: g.board_id, action: 'group_deleted', oldValue: g.name });
    });
  }
  archiveGroup(id, archived = true) {
    const g = this.db.get('SELECT * FROM groups WHERE id=?', [id]);
    if (!g) return;
    this.db.run('UPDATE groups SET archived=? WHERE id=?', [archived ? 1 : 0, id]);
    this.log({ boardId: g.board_id, action: archived ? 'group_archived' : 'group_restored', newValue: g.name });
  }
  duplicateGroup(id) {
    const g = this.db.get('SELECT * FROM groups WHERE id=?', [id]);
    if (!g) throw new Error('Group not found');
    let nid;
    this.db.tx(() => {
      nid = this.addGroup(g.board_id, { name: `${g.name} (copy)`, color: g.color, position: g.position + 0.5 });
      for (const it of this.db.all('SELECT id FROM items WHERE group_id=? AND archived=0 ORDER BY position', [id])) this.duplicateItem(it.id, { groupId: nid, keepName: true });
    });
    return nid;
  }

  // --------------------------------------------------------------- columns
  colRow(id) {
    const c = this.db.get('SELECT * FROM columns WHERE id=?', [id]);
    if (!c) throw new Error('Column not found');
    return { ...c, settings: parseJson(c.settings, {}) };
  }
  columns(boardId, scope) {
    return this.db.all(`SELECT * FROM columns WHERE board_id=? ${scope ? 'AND scope=?' : ''} ORDER BY position`, scope ? [boardId, scope] : [boardId])
      .map((c) => ({ ...c, settings: parseJson(c.settings, {}) }));
  }
  addColumn(boardId, { title, type = 'text', scope = 'item', settings, position, after, description = '', width = 0 } = {}) {
    if (!C.TYPES[type]) throw new Error(`Unknown column type ${type}`);
    const id = uid('c');
    let pos = position;
    if (pos == null && after) {
      const a = this.db.get('SELECT position FROM columns WHERE id=?', [after]);
      const nx = a && this.db.get('SELECT MIN(position) AS p FROM columns WHERE board_id=? AND scope=? AND position>?', [boardId, scope, a.position]);
      pos = a ? (nx && nx.p != null ? (a.position + nx.p) / 2 : a.position + 1) : null;
    }
    if (pos == null) pos = (this.db.get('SELECT MAX(position) AS m FROM columns WHERE board_id=? AND scope=?', [boardId, scope]).m || 0) + 1;
    const s = { ...C.defaultsFor(type), ...(settings || {}) };
    if (type === 'formula' && s.expr) { const err = F.check(s.expr); if (err) throw new Error(`Formula: ${err}`); }
    this.db.run('INSERT INTO columns(id,board_id,scope,title,type,description,position,width,settings) VALUES(?,?,?,?,?,?,?,?,?)',
      [id, boardId, scope, String(title || C.TYPES[type].label).trim(), type, description, pos, width, JSON.stringify(s)]);
    if (type === 'auto_number') this.renumber(boardId);
    return id;
  }
  updateColumn(id, patch) {
    const c = this.colRow(id);
    const settings = patch.settings ? { ...c.settings, ...patch.settings } : c.settings;
    if (c.type === 'formula' && patch.settings && patch.settings.expr != null) {
      const err = F.check(patch.settings.expr);
      if (err) throw new Error(`Formula: ${err}`);
    }
    let type = c.type;
    if (patch.type && patch.type !== c.type) {
      if (!C.TYPES[patch.type]) throw new Error('Unknown column type');
      type = patch.type;
      Object.assign(settings, { ...C.defaultsFor(type), ...settings });
      this.convertValues(c, type, settings);
    }
    this.db.run('UPDATE columns SET title=?, type=?, description=?, width=?, position=?, settings=? WHERE id=?', [
      patch.title != null ? String(patch.title).trim() || c.title : c.title, type,
      patch.description != null ? patch.description : c.description, patch.width != null ? patch.width : c.width,
      patch.position != null ? patch.position : c.position, JSON.stringify(settings), id]);
    if (patch.title && patch.title !== c.title) this.log({ boardId: c.board_id, action: 'column_renamed', columnId: id, oldValue: c.title, newValue: patch.title });
  }
  /** Change a column's type, carrying values across as text where possible. */
  convertValues(col, type, settings) {
    const ctx = { people: this.peopleMap(), teams: this.teamsMap() };
    const target = { ...col, type, settings };
    const items = this.db.all('SELECT id, data FROM items WHERE board_id=?', [col.board_id]);
    for (const it of items) {
      const d = parseJson(it.data, {});
      if (!(col.id in d)) continue;
      const txt = C.textOf(col, d[col.id], ctx);
      let nv = null;
      if (C.LABEL_TYPES.has(type)) {
        nv = txt ? C.coerce(target, txt) : null;
        if (txt && !nv) {
          const lid = uid('l');
          settings.labels = [...(settings.labels || []), { id: lid, label: txt, color: C.PALETTE[(settings.labels || []).length % C.PALETTE.length].id }];
          nv = lid;
        }
      } else if (type === 'dropdown') {
        nv = txt ? txt.split(',').map((t) => t.trim()).filter(Boolean).map((t) => {
          let o = (settings.options || []).find((x) => x.label === t);
          if (!o) { o = { id: uid('o'), label: t }; settings.options = [...(settings.options || []), o]; }
          return o.id;
        }) : null;
      } else if (!C.isComputed(type)) nv = txt ? C.coerce(target, txt) : null;
      if (nv == null) delete d[col.id]; else d[col.id] = nv;
      this.db.run('UPDATE items SET data=? WHERE id=?', [JSON.stringify(d), it.id]);
    }
  }
  deleteColumn(id) {
    const c = this.colRow(id);
    const b = this.boardRow(c.board_id);
    this.db.tx(() => {
      const values = {};
      for (const it of this.db.all('SELECT id, data FROM items WHERE board_id=?', [c.board_id])) {
        const d = parseJson(it.data, {});
        if (c.id in d) { values[it.id] = d[c.id]; delete d[c.id]; this.db.run('UPDATE items SET data=? WHERE id=?', [JSON.stringify(d), it.id]); }
      }
      this.toTrash('column', c.title, c.board_id, b.name, { columns: [this.db.get('SELECT * FROM columns WHERE id=?', [id])], values: { [id]: values } });
      this.db.run('DELETE FROM columns WHERE id=?', [id]);
      this.log({ boardId: c.board_id, action: 'column_deleted', oldValue: c.title });
    });
  }
  duplicateColumn(id, { withValues = true } = {}) {
    const c = this.colRow(id);
    const nid = this.addColumn(c.board_id, { title: `${c.title} (copy)`, type: c.type, scope: c.scope, settings: c.settings, after: id, width: c.width });
    if (withValues) {
      for (const it of this.db.all('SELECT id, data FROM items WHERE board_id=?', [c.board_id])) {
        const d = parseJson(it.data, {});
        if (c.id in d) { d[nid] = d[c.id]; this.db.run('UPDATE items SET data=? WHERE id=?', [JSON.stringify(d), it.id]); }
      }
    }
    return nid;
  }
  renumber(boardId) {
    const items = this.db.all('SELECT id FROM items WHERE board_id=? AND parent_id IS NULL ORDER BY seq, created_at', [boardId]);
    let n = 1;
    for (const it of items) this.db.run('UPDATE items SET seq=? WHERE id=?', [n++, it.id]);
    this.db.run('UPDATE boards SET next_seq=? WHERE id=?', [n, boardId]);
  }

  // ----------------------------------------------------------------- items
  itemRow(id) {
    const it = this.db.get('SELECT * FROM items WHERE id=?', [id]);
    if (!it) throw new Error('Item not found');
    return { ...it, data: parseJson(it.data, {}), archived: !!it.archived };
  }
  addItem(boardId, { groupId, name, values, parentId, position, top, source = 'manual' } = {}) {
    const b = this.boardRow(boardId);
    if (parentId) {
      const parent = this.itemRow(parentId);
      boardId = parent.board_id;
      groupId = null;
    } else if (!groupId || !this.db.get('SELECT id FROM groups WHERE id=? AND board_id=?', [groupId, boardId])) {
      const g = this.db.get('SELECT id FROM groups WHERE board_id=? AND archived=0 ORDER BY position LIMIT 1', [boardId]);
      groupId = g ? g.id : this.addGroup(boardId, { name: 'Group' });
    }
    const id = uid('i');
    const ts = now();
    const where = parentId ? ['parent_id=?', parentId] : ['group_id=?', groupId];
    const r = this.db.get(`SELECT MAX(position) AS mx, MIN(position) AS mn FROM items WHERE ${where[0]}`, [where[1]]);
    const pos = position != null ? position : top ? (r.mn != null ? r.mn - 1 : 1) : (r.mx != null ? r.mx + 1 : 1);
    const me = this.me().id;
    this.db.tx(() => {
      const seq = parentId ? 0 : b.next_seq;
      if (!parentId) this.db.run('UPDATE boards SET next_seq=next_seq+1, updated_at=? WHERE id=?', [ts, boardId]);
      this.db.run('INSERT INTO items(id,board_id,group_id,parent_id,name,position,seq,data,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        [id, boardId, groupId, parentId || null, String(name || `New ${b.item_noun}`).trim(), pos, seq, '{}', me, ts, ts]);
      this.log({ boardId, itemId: id, action: parentId ? 'subitem_created' : 'item_created', newValue: name, source });
      if (values) {
        const cols = this.columns(boardId, parentId ? 'sub' : 'item');
        for (const [k, v] of Object.entries(values)) {
          const col = cols.find((c) => c.id === k) || cols.find((c) => c.title.toLowerCase() === String(k).toLowerCase());
          if (col && !C.isComputed(col.type)) this.setValue(id, col.id, v, { source, quiet: true });
        }
      }
      this.emit({ type: parentId ? 'subitem_created' : 'item_created', boardId, itemId: id, parentId });
    });
    return id;
  }
  renameItem(id, name) {
    const it = this.itemRow(id);
    const n = String(name || '').trim();
    if (!n || n === it.name) return;
    this.db.run('UPDATE items SET name=?, updated_at=? WHERE id=?', [n, now(), id]);
    this.log({ boardId: it.board_id, itemId: id, action: 'renamed', oldValue: it.name, newValue: n });
    this.emit({ type: 'name_changed', boardId: it.board_id, itemId: id });
  }
  /** Set one cell. Returns true when the stored value changed. */
  setValue(itemId, columnId, value, { source = 'manual', quiet = false, noDeps = false } = {}) {
    const it = this.itemRow(itemId);
    const col = this.colRow(columnId);
    if (col.board_id !== it.board_id) throw new Error('That column is on another board');
    if (C.isComputed(col.type)) throw new Error(`${col.title} is calculated automatically`);
    let v = C.coerce(col, value);
    if (col.type === 'people' && v && col.settings.max) v = v.slice(-col.settings.max);
    if (col.type === 'dropdown' && v && col.settings.max) v = v.slice(-col.settings.max);
    if (col.type === 'connect' && v && col.settings.multiple === false) v = v.slice(-1);
    const old = it.data[columnId];
    if (JSON.stringify(old ?? null) === JSON.stringify(v ?? null)) return false;
    if (v == null) delete it.data[columnId]; else it.data[columnId] = v;
    this.db.tx(() => {
      this.db.run('UPDATE items SET data=?, updated_at=? WHERE id=?', [JSON.stringify(it.data), now(), itemId]);
      const ctx = { people: this.peopleMap(), teams: this.teamsMap(), itemNames: this.namesFor([...(Array.isArray(old) ? old : []), ...(Array.isArray(v) ? v : [])]) };
      if (col.type !== 'time_tracking') {
        this.log({ boardId: it.board_id, itemId, action: 'value', columnId, oldValue: C.textOf(col, old, ctx), newValue: C.textOf(col, v, ctx), source });
      }
      if (col.type === 'people' && source !== 'sample' && source !== 'import') this.notifyAssigned(it, col, old, v);
      if (col.type === 'connect' && col.settings.twoWay && col.settings.backColumn) this.syncBackLinks(it, col, old, v);
      if (!noDeps && (col.type === 'date' || col.type === 'timeline')) this.shiftDependents(it, col, old, v, new Set([itemId]));
      if (!quiet || source !== 'import') this.emit({ type: 'value_changed', boardId: it.board_id, itemId, columnId, old, value: v, parentId: it.parent_id, source });
    });
    return true;
  }
  setValues(itemId, values, opts) {
    this.db.tx(() => { for (const [k, v] of Object.entries(values || {})) this.setValue(itemId, k, v, opts); });
  }
  clearValue(itemId, columnId) { return this.setValue(itemId, columnId, null); }

  moveItem(id, { groupId, position, boardId, before, after } = {}) {
    const it = this.itemRow(id);
    if (it.parent_id) {
      if (position != null) this.db.run('UPDATE items SET position=? WHERE id=?', [position, id]);
      return;
    }
    if (boardId && boardId !== it.board_id) return this.moveItemToBoard(id, boardId, groupId);
    const gid = groupId || it.group_id;
    let pos = position;
    if (pos == null && (before || after)) {
      const ref = this.db.get('SELECT position FROM items WHERE id=?', [before || after]);
      if (ref) {
        const nb = before
          ? this.db.get('SELECT MAX(position) AS p FROM items WHERE group_id=? AND position<? AND id<>?', [gid, ref.position, id])
          : this.db.get('SELECT MIN(position) AS p FROM items WHERE group_id=? AND position>? AND id<>?', [gid, ref.position, id]);
        pos = nb && nb.p != null ? (ref.position + nb.p) / 2 : ref.position + (before ? -1 : 1);
      }
    }
    if (pos == null) pos = (this.db.get('SELECT MAX(position) AS m FROM items WHERE group_id=?', [gid]).m || 0) + 1;
    this.db.tx(() => {
      this.db.run('UPDATE items SET group_id=?, position=?, updated_at=? WHERE id=?', [gid, pos, now(), id]);
      if (gid !== it.group_id) {
        const names = Object.fromEntries(this.db.all('SELECT id, name FROM groups WHERE id IN (?,?)', [it.group_id, gid]).map((g) => [g.id, g.name]));
        this.log({ boardId: it.board_id, itemId: id, action: 'moved_group', oldValue: names[it.group_id], newValue: names[gid] });
        this.emit({ type: 'item_moved', boardId: it.board_id, itemId: id, fromGroup: it.group_id, toGroup: gid });
      }
    });
  }
  /** Move to another board; values follow by matching column title and type. */
  moveItemToBoard(id, boardId, groupId) {
    const it = this.itemRow(id);
    const from = this.boardRow(it.board_id);
    const to = this.boardRow(boardId);
    const srcCols = this.columns(it.board_id);
    const dstCols = this.columns(boardId);
    const map = {};
    for (const c of srcCols) {
      const d = dstCols.find((x) => x.scope === c.scope && x.title.toLowerCase() === c.title.toLowerCase() && x.type === c.type);
      if (d) map[c.id] = d;
    }
    const remap = (data) => {
      const out = {};
      for (const [k, v] of Object.entries(data)) {
        const d = map[k];
        if (!d) continue;
        const s = srcCols.find((c) => c.id === k);
        if (C.LABEL_TYPES.has(s.type)) { const l = C.labelOf(s, v); const hit = l && C.coerce(d, l.label); if (hit) out[d.id] = hit; } else out[d.id] = v;
      }
      return out;
    };
    if (!groupId || !this.db.get('SELECT id FROM groups WHERE id=? AND board_id=?', [groupId, boardId])) {
      groupId = (this.db.get('SELECT id FROM groups WHERE board_id=? AND archived=0 ORDER BY position LIMIT 1', [boardId]) || {}).id || this.addGroup(boardId, {});
    }
    this.db.tx(() => {
      const seq = to.next_seq;
      this.db.run('UPDATE boards SET next_seq=next_seq+1 WHERE id=?', [boardId]);
      this.db.run('UPDATE items SET board_id=?, group_id=?, seq=?, data=?, updated_at=? WHERE id=?', [boardId, groupId, seq, JSON.stringify(remap(it.data)), now(), id]);
      for (const s of this.db.all('SELECT id, data FROM items WHERE parent_id=?', [id])) {
        this.db.run('UPDATE items SET board_id=?, data=? WHERE id=?', [boardId, JSON.stringify(remap(parseJson(s.data, {}))), s.id]);
      }
      this.db.run('UPDATE activity SET board_id=? WHERE item_id=?', [boardId, id]);
      this.log({ boardId, itemId: id, action: 'moved_board', oldValue: from.name, newValue: to.name });
    });
  }
  duplicateItem(id, { groupId, keepName = false, withUpdates = false } = {}) {
    const it = this.itemRow(id);
    const nid = uid('i');
    const ts = now();
    this.db.tx(() => {
      let seq = 0;
      if (!it.parent_id) { seq = this.boardRow(it.board_id).next_seq; this.db.run('UPDATE boards SET next_seq=next_seq+1 WHERE id=?', [it.board_id]); }
      const data = { ...it.data };
      for (const c of this.columns(it.board_id)) if (c.type === 'files' || c.type === 'time_tracking') delete data[c.id];
      this.db.run('INSERT INTO items(id,board_id,group_id,parent_id,name,position,seq,data,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        [nid, it.board_id, groupId || it.group_id, it.parent_id, keepName ? it.name : `${it.name} (copy)`, it.position + 0.001, seq, JSON.stringify(data), this.me().id, ts, ts]);
      for (const s of this.db.all('SELECT * FROM items WHERE parent_id=? AND archived=0', [id])) {
        this.db.run('INSERT INTO items(id,board_id,group_id,parent_id,name,position,seq,data,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          [uid('i'), s.board_id, null, nid, s.name, s.position, 0, s.data, this.me().id, ts, ts]);
      }
      if (withUpdates) for (const u of this.db.all('SELECT * FROM updates WHERE item_id=?', [id])) this.db.run('INSERT INTO updates(id,item_id,parent_id,author,body,created_at) VALUES(?,?,?,?,?,?)', [uid('u'), nid, null, u.author, u.body, u.created_at]);
      this.log({ boardId: it.board_id, itemId: nid, action: 'item_created', newValue: it.name, source: 'duplicate' });
    });
    return nid;
  }
  archiveItem(id, archived = true) {
    const it = this.itemRow(id);
    this.db.run('UPDATE items SET archived=?, updated_at=? WHERE id=?', [archived ? 1 : 0, now(), id]);
    this.log({ boardId: it.board_id, itemId: id, action: archived ? 'archived' : 'restored', newValue: it.name });
  }
  deleteItem(id, { quiet = false } = {}) {
    const it = this.db.get('SELECT * FROM items WHERE id=?', [id]);
    if (!it) return;
    const b = this.boardRow(it.board_id);
    this.db.tx(() => {
      this.toTrash(it.parent_id ? 'subitem' : 'item', it.name, it.board_id, b.name, this.snapshot({ items: [id] }));
      this.db.run('DELETE FROM items WHERE parent_id=?', [id]);
      this.db.run('DELETE FROM items WHERE id=?', [id]);
      if (!quiet) this.log({ boardId: it.board_id, itemId: null, action: 'item_deleted', oldValue: it.name });
    });
  }

  // ----------------------------------------------------------------- trash
  /** Every row that belongs to the given boards, groups or items. */
  snapshot({ boards = [], groups = [], items = [] }) {
    const q = (sql, ids) => (ids.length ? this.db.all(sql.replace('?*', ids.map(() => '?').join(',')), ids) : []);
    const out = { boards: q('SELECT * FROM boards WHERE id IN (?*)', boards) };
    out.groups = [...q('SELECT * FROM groups WHERE board_id IN (?*)', boards), ...q('SELECT * FROM groups WHERE id IN (?*)', groups)];
    out.columns = q('SELECT * FROM columns WHERE board_id IN (?*)', boards);
    out.views = q('SELECT * FROM views WHERE board_id IN (?*)', boards);
    out.automations = q('SELECT * FROM automations WHERE board_id IN (?*)', boards);
    const top = [...q('SELECT * FROM items WHERE board_id IN (?*)', boards), ...q('SELECT * FROM items WHERE group_id IN (?*) AND parent_id IS NULL', groups), ...q('SELECT * FROM items WHERE id IN (?*)', items)];
    const seen = new Set(top.map((r) => r.id));
    const kids = q('SELECT * FROM items WHERE parent_id IN (?*)', [...seen]).filter((r) => !seen.has(r.id));
    out.items = [...top.filter((r) => !r.parent_id), ...top.filter((r) => r.parent_id), ...kids];
    const ids = out.items.map((r) => r.id);
    out.updates = q('SELECT * FROM updates WHERE item_id IN (?*)', ids);
    out.files = q('SELECT * FROM files WHERE item_id IN (?*)', ids);
    return out;
  }
  toTrash(kind, name, boardId, boardName, payload) {
    const id = uid('x');
    this.db.run('INSERT INTO trash(id,kind,name,board_id,board_name,payload,deleted_at) VALUES(?,?,?,?,?,?,?)', [id, kind, name, boardId || null, boardName || '', JSON.stringify(payload), now()]);
    return id;
  }
  trash() {
    return this.db.all('SELECT id, kind, name, board_id, board_name, deleted_at, length(payload) AS size FROM trash ORDER BY deleted_at DESC');
  }
  insertRows(table, rows) {
    for (const r of rows || []) {
      const keys = Object.keys(r);
      this.db.run(`INSERT OR REPLACE INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, keys.map((k) => r[k]));
    }
  }
  /** Put a deleted board, group, column or item back where it was. */
  restoreTrash(id) {
    const t = this.db.get('SELECT * FROM trash WHERE id=?', [id]);
    if (!t) throw new Error('That is no longer in the trash');
    const p = parseJson(t.payload, {});
    this.db.tx(() => {
      for (const b of p.boards || []) {
        if (!this.db.get('SELECT id FROM workspaces WHERE id=?', [b.workspace_id])) b.workspace_id = (this.db.get('SELECT id FROM workspaces ORDER BY position LIMIT 1') || {}).id || this.saveWorkspace({ name: 'Restored' });
      }
      this.insertRows('boards', p.boards);
      const boardId = t.board_id;
      this.insertRows('docs', p.docs);
      if (t.kind !== 'board' && t.kind !== 'doc' && !this.db.get('SELECT id FROM boards WHERE id=?', [boardId])) throw new Error(`Restore the board “${t.board_name}” first`);
      this.insertRows('groups', p.groups);
      this.insertRows('columns', p.columns);
      for (const it of p.items || []) {
        if (!it.parent_id && !this.db.get('SELECT id FROM groups WHERE id=?', [it.group_id])) {
          it.group_id = (this.db.get('SELECT id FROM groups WHERE board_id=? ORDER BY position LIMIT 1', [it.board_id]) || {}).id || this.addGroup(it.board_id, { name: 'Restored' });
        }
        if (it.parent_id && !this.db.get('SELECT id FROM items WHERE id=?', [it.parent_id]) && !(p.items || []).some((x) => x.id === it.parent_id)) throw new Error('Restore its parent item first');
      }
      this.insertRows('items', p.items);
      this.insertRows('updates', p.updates);
      this.insertRows('files', p.files);
      this.insertRows('views', p.views);
      this.insertRows('automations', p.automations);
      for (const [colId, vals] of Object.entries(p.values || {})) {
        for (const [itemId, v] of Object.entries(vals)) {
          const r = this.db.get('SELECT data FROM items WHERE id=?', [itemId]);
          if (!r) continue;
          const d = parseJson(r.data, {});
          d[colId] = v;
          this.db.run('UPDATE items SET data=? WHERE id=?', [JSON.stringify(d), itemId]);
        }
      }
      this.db.run('DELETE FROM trash WHERE id=?', [id]);
      if (boardId) this.log({ boardId, action: 'restored_from_trash', newValue: `${t.kind}: ${t.name}` });
    });
    return { kind: t.kind, boardId: t.board_id, itemId: t.kind === 'item' || t.kind === 'subitem' ? (p.items[0] || {}).id : null };
  }
  /** Permanently remove trash entries (and their stored files). */
  purgeTrash({ id, olderThanDays } = {}) {
    const rows = id ? this.db.all('SELECT * FROM trash WHERE id=?', [id])
      : olderThanDays != null ? this.db.all('SELECT * FROM trash WHERE deleted_at < ?', [new Date(Date.now() - olderThanDays * 864e5).toISOString()])
        : this.db.all('SELECT * FROM trash');
    for (const t of rows) {
      for (const f of parseJson(t.payload, {}).files || []) this.unlinkFile(f);
      this.db.run('DELETE FROM trash WHERE id=?', [t.id]);
    }
    return rows.length;
  }

  bulk(ids, op, arg = {}) {
    const out = [];
    this.db.tx(() => {
      for (const id of ids) {
        if (op === 'archive') this.archiveItem(id, true);
        else if (op === 'restore') this.archiveItem(id, false);
        else if (op === 'delete') this.deleteItem(id);
        else if (op === 'duplicate') out.push(this.duplicateItem(id));
        else if (op === 'move') this.moveItem(id, arg);
        else if (op === 'set') this.setValue(id, arg.columnId, arg.value);
        else throw new Error(`Unknown bulk action ${op}`);
      }
    });
    return out;
  }
  namesFor(ids) {
    const uniq = [...new Set(ids.filter((x) => typeof x === 'string'))];
    if (!uniq.length) return {};
    return Object.fromEntries(this.db.all(`SELECT id, name FROM items WHERE id IN (${uniq.map(() => '?').join(',')})`, uniq).map((r) => [r.id, r.name]));
  }

  // ------------------------------------------------------- linked columns
  syncBackLinks(it, col, old, v) {
    const before = new Set(Array.isArray(old) ? old : []);
    const after = new Set(Array.isArray(v) ? v : []);
    const back = this.db.get('SELECT * FROM columns WHERE id=?', [col.settings.backColumn]);
    if (!back) return;
    const touch = (otherId, add) => {
      const o = this.db.get('SELECT id, data FROM items WHERE id=?', [otherId]);
      if (!o) return;
      const d = parseJson(o.data, {});
      const cur = new Set(d[back.id] || []);
      if (add) cur.add(it.id); else cur.delete(it.id);
      d[back.id] = [...cur];
      if (!d[back.id].length) delete d[back.id];
      this.db.run('UPDATE items SET data=? WHERE id=?', [JSON.stringify(d), otherId]);
    };
    for (const x of after) if (!before.has(x)) touch(x, true);
    for (const x of before) if (!after.has(x)) touch(x, false);
  }

  /** Dependency columns: when a predecessor's dates move, move its successors. */
  shiftDependents(it, col, old, v, seen) {
    const deps = this.db.all("SELECT * FROM columns WHERE board_id=? AND type='dependency'", [it.board_id]).map((c) => ({ ...c, settings: parseJson(c.settings, {}) }))
      .filter((d) => d.settings.dateColumn === col.id && d.settings.mode !== 'none');
    if (!deps.length) return;
    const span = (val) => {
      if (!val) return null;
      if (col.type === 'timeline') return val.start && val.end ? { start: val.start.slice(0, 10), end: val.end.slice(0, 10) } : null;
      return { start: String(val).slice(0, 10), end: String(val).slice(0, 10) };
    };
    const a0 = span(old), a1 = span(v);
    if (!a1) return;
    const rows = this.db.all('SELECT id, data FROM items WHERE board_id=? AND archived=0', [it.board_id]);
    for (const dep of deps) {
      const lag = Number(dep.settings.lagDays) || 0;
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        const d = parseJson(r.data, {});
        if (!(d[dep.id] || []).includes(it.id)) continue;
        const b = span(d[col.id]);
        if (!b) continue;
        let delta = 0;
        const type = dep.settings.type || 'fs';
        const anchor = type === 'ss' || type === 'sf' ? a1.start : a1.end;
        const target = type === 'fs' ? addDays(anchor, 1 + lag) : addDays(anchor, lag);
        const cur = type === 'ff' || type === 'sf' ? b.end : b.start;
        if (dep.settings.mode === 'strict' && a0) {
          delta = daysBetween(type === 'ss' || type === 'sf' ? a0.start : a0.end, anchor);
        } else if (cur < target) {
          delta = daysBetween(cur, target); // flexible: only push forward on conflict
        }
        if (!delta) continue;
        const nv = col.type === 'timeline' ? { start: addDays(b.start, delta), end: addDays(b.end, delta) } : addDays(String(d[col.id]), delta);
        seen.add(r.id);
        const prev = d[col.id];
        d[col.id] = nv;
        this.db.run('UPDATE items SET data=?, updated_at=? WHERE id=?', [JSON.stringify(d), now(), r.id]);
        this.log({ boardId: it.board_id, itemId: r.id, action: 'value', columnId: col.id, oldValue: C.textOf(col, prev), newValue: C.textOf(col, nv), source: 'dependency' });
        this.shiftDependents({ ...it, id: r.id }, col, prev, nv, seen);
      }
    }
  }

  // ---------------------------------------------------------- time tracking
  toggleTimer(itemId, columnId) {
    const it = this.itemRow(itemId);
    const col = this.colRow(columnId);
    if (col.type !== 'time_tracking') throw new Error('Not a time tracking column');
    const v = { total: 0, since: null, sessions: [], ...(it.data[columnId] || {}) };
    if (v.since) {
      const secs = Math.round((Date.now() - new Date(v.since).getTime()) / 1000);
      v.total += Math.max(0, secs);
      v.sessions = [...(v.sessions || []).slice(-49), { start: v.since, end: now(), by: this.me().id }];
      v.since = null;
    } else v.since = now();
    this.setValue(itemId, columnId, v, { source: 'timer' });
    return v;
  }
  clickButton(itemId, columnId) {
    const it = this.itemRow(itemId);
    const col = this.colRow(columnId);
    if (col.type !== 'button') throw new Error('Not a button column');
    this.log({ boardId: it.board_id, itemId, action: 'button', columnId, newValue: col.settings.label });
    this.emit({ type: 'button_clicked', boardId: it.board_id, itemId, columnId });
  }

  // --------------------------------------------------------------- updates
  updates(itemId) {
    return this.db.all('SELECT * FROM updates WHERE item_id=? ORDER BY pinned DESC, created_at DESC', [itemId]).map((u) => ({ ...u, pinned: !!u.pinned }));
  }
  postUpdate(itemId, body, { parentId = null, author } = {}) {
    const it = this.itemRow(itemId);
    const text = String(body || '').trim();
    if (!text) throw new Error('Write something first');
    const id = uid('u');
    const by = author || this.me().id;
    this.db.tx(() => {
      this.db.run('INSERT INTO updates(id,item_id,parent_id,author,body,created_at) VALUES(?,?,?,?,?,?)', [id, itemId, parentId, by, text, now()]);
      this.db.run('UPDATE items SET updated_at=? WHERE id=?', [now(), itemId]);
      this.log({ boardId: it.board_id, itemId, action: parentId ? 'reply' : 'update', newValue: text.slice(0, 140) });
      // @Name mentions notify that person.
      for (const p of this.people()) {
        if (p.id === by) continue;
        const re = new RegExp(`@${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (re.test(text)) this.notify(p.id, 'mention', `${this.personName(by)} mentioned ${p.is_me ? 'you' : p.name}`, `${it.name}: ${text.slice(0, 200)}`, it.board_id, itemId);
      }
      this.emit({ type: 'update_posted', boardId: it.board_id, itemId });
    });
    return id;
  }
  editUpdate(id, body) {
    const text = String(body || '').trim();
    if (!text) throw new Error('Write something first');
    this.db.run('UPDATE updates SET body=?, edited_at=? WHERE id=?', [text, now(), id]);
  }
  pinUpdate(id, pinned = true) { this.db.run('UPDATE updates SET pinned=? WHERE id=?', [pinned ? 1 : 0, id]); }
  deleteUpdate(id) { this.db.run('DELETE FROM updates WHERE id=? OR parent_id=?', [id, id]); }
  personName(id) { const p = this.db.get('SELECT name FROM people WHERE id=?', [id]); return p ? p.name : 'Someone'; }

  // ----------------------------------------------------------------- files
  addFile(itemId, columnId, { name, bytes }) {
    if (!this.filesDir) throw new Error('Files are not available here');
    const it = this.itemRow(itemId);
    const id = uid('f');
    const safe = String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(-120);
    const dir = path.join(this.filesDir, it.board_id);
    fs.mkdirSync(dir, { recursive: true });
    const stored = path.join(dir, `${id}-${safe}`);
    fs.writeFileSync(stored, bytes);
    this.db.tx(() => {
      this.db.run('INSERT INTO files(id,item_id,column_id,name,stored_path,size,added_by,added_at) VALUES(?,?,?,?,?,?,?,?)', [id, itemId, columnId || '', safe, path.relative(this.filesDir, stored), bytes.length, this.me().id, now()]);
      if (columnId) {
        const cur = Array.isArray(it.data[columnId]) ? it.data[columnId] : [];
        this.setValue(itemId, columnId, [...cur, id]);
      } else this.log({ boardId: it.board_id, itemId, action: 'file', newValue: safe });
    });
    return id;
  }
  removeFile(id) {
    const f = this.db.get('SELECT * FROM files WHERE id=?', [id]);
    if (!f) return;
    this.db.tx(() => {
      if (f.column_id) {
        const it = this.itemRow(f.item_id);
        const cur = Array.isArray(it.data[f.column_id]) ? it.data[f.column_id] : [];
        this.setValue(f.item_id, f.column_id, cur.filter((x) => x !== id));
      }
      this.db.run('DELETE FROM files WHERE id=?', [id]);
      this.unlinkFile(f);
    });
  }
  unlinkFile(f) {
    if (!this.filesDir) return;
    try { fs.unlinkSync(path.join(this.filesDir, f.stored_path)); } catch (_) { /* already gone */ }
  }
  filePath(id) {
    const f = this.db.get('SELECT * FROM files WHERE id=?', [id]);
    if (!f || !this.filesDir) return null;
    const p = path.join(this.filesDir, f.stored_path);
    return fs.existsSync(p) ? p : null;
  }
  itemFiles(itemId) { return this.db.all('SELECT * FROM files WHERE item_id=? ORDER BY added_at DESC', [itemId]); }

  // ----------------------------------------------------------------- views
  views(boardId) {
    return this.db.all('SELECT * FROM views WHERE board_id=? ORDER BY position', [boardId]).map((v) => ({ ...v, config: parseJson(v.config, {}) }));
  }
  saveView(boardId, v) {
    if (v.id && this.db.get('SELECT id FROM views WHERE id=?', [v.id])) {
      const cur = this.db.get('SELECT * FROM views WHERE id=?', [v.id]);
      this.db.run('UPDATE views SET name=?, config=?, position=? WHERE id=?', [v.name || cur.name, JSON.stringify(v.config != null ? v.config : parseJson(cur.config, {})), v.position != null ? v.position : cur.position, v.id]);
      return v.id;
    }
    const id = uid('v');
    const pos = v.position != null ? v.position : (this.db.get('SELECT MAX(position) AS m FROM views WHERE board_id=?', [boardId]).m || 0) + 1;
    this.db.run('INSERT INTO views(id,board_id,name,type,position,config) VALUES(?,?,?,?,?,?)', [id, boardId, v.name || 'View', v.type || 'table', pos, JSON.stringify(v.config || {})]);
    return id;
  }
  deleteView(id) {
    const v = this.db.get('SELECT * FROM views WHERE id=?', [id]);
    if (!v) return;
    if (this.db.get('SELECT COUNT(*) AS n FROM views WHERE board_id=?', [v.board_id]).n <= 1) throw new Error('A board needs at least one view');
    this.db.run('DELETE FROM views WHERE id=?', [id]);
  }

  // -------------------------------------------------------------- activity
  log({ boardId, itemId = null, action, columnId = '', oldValue = null, newValue = null, source = 'manual', actor }) {
    this.db.run('INSERT INTO activity(ts,actor,board_id,item_id,action,column_id,old_value,new_value,source) VALUES(?,?,?,?,?,?,?,?,?)',
      [now(), actor || (source === 'automation' ? 'automation' : this.me().id), boardId || null, itemId, action, columnId || '', oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), source]);
  }
  activity({ boardId, itemId, limit = 200, since } = {}) {
    const where = [], args = [];
    if (boardId) { where.push('a.board_id=?'); args.push(boardId); }
    if (itemId) { where.push('(a.item_id=? OR a.item_id IN (SELECT id FROM items WHERE parent_id=?))'); args.push(itemId, itemId); }
    if (since) { where.push('a.ts>=?'); args.push(since); }
    return this.db.all(`SELECT a.*, i.name AS item_name, c.title AS column_title FROM activity a LEFT JOIN items i ON i.id=a.item_id LEFT JOIN columns c ON c.id=a.column_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`, [...args, limit]);
  }

  // --------------------------------------------------------- notifications
  notify(personId, kind, title, body, boardId, itemId) {
    this.db.run('INSERT INTO notifications(ts,person_id,kind,title,body,board_id,item_id) VALUES(?,?,?,?,?,?,?)', [now(), personId, kind, title, body || '', boardId || null, itemId || null]);
  }
  notifyAssigned(it, col, old, v) {
    const before = new Set(Array.isArray(old) ? old : []);
    const me = this.me().id;
    for (const pid of Array.isArray(v) ? v : []) {
      if (before.has(pid)) continue;
      const b = this.boardRow(it.board_id);
      this.notify(pid, 'assigned', pid === me ? `You were assigned to ${it.name}` : `${this.personName(pid)} was assigned to ${it.name}`, `${b.name} · ${col.title}`, it.board_id, it.id);
    }
  }
  notifications({ unreadOnly = false, limit = 200 } = {}) {
    const me = this.me().id;
    return this.db.all(`SELECT n.*, b.name AS board_name, i.name AS item_name FROM notifications n LEFT JOIN boards b ON b.id=n.board_id LEFT JOIN items i ON i.id=n.item_id
      WHERE (n.person_id=? OR n.person_id IS NULL) ${unreadOnly ? 'AND n.read=0' : ''} ORDER BY n.id DESC LIMIT ?`, [me, limit]).map((n) => ({ ...n, read: !!n.read }));
  }
  markRead(ids, read = true) {
    if (ids === 'all') this.db.run('UPDATE notifications SET read=?', [read ? 1 : 0]);
    else for (const id of ids || []) this.db.run('UPDATE notifications SET read=? WHERE id=?', [read ? 1 : 0, id]);
  }
  /** Notifications for me not yet shown as a desktop toast. */
  takeUnshown() {
    const me = this.me().id;
    const rows = this.db.all('SELECT * FROM notifications WHERE shown=0 AND read=0 AND (person_id=? OR person_id IS NULL) ORDER BY id', [me]);
    if (rows.length) this.db.run('UPDATE notifications SET shown=1 WHERE shown=0');
    return rows;
  }

  // ------------------------------------------------------------- read model
  /** A board with every computed value filled in, ready to render. */
  getBoard(id, { includeArchived = false } = {}) {
    const board = this.boardRow(id);
    const groups = this.db.all('SELECT * FROM groups WHERE board_id=? ORDER BY position', [id]).map((g) => ({ ...g, collapsed: !!g.collapsed, archived: !!g.archived }));
    const columns = this.columns(id);
    const rows = this.db.all(`SELECT * FROM items WHERE board_id=? ${includeArchived ? '' : 'AND archived=0'} ORDER BY position`, [id])
      .map((it) => ({ ...it, data: parseJson(it.data, {}), archived: !!it.archived }));
    const ctx = this.computeContext(rows, columns);
    const items = rows.filter((r) => !r.parent_id);
    const subitems = rows.filter((r) => r.parent_id);
    this.compute(board, columns, items, subitems, ctx);
    const files = {};
    for (const f of this.db.all('SELECT f.id, f.name, f.size, f.item_id FROM files f JOIN items i ON i.id=f.item_id WHERE i.board_id=?', [id])) files[f.id] = f;
    const updateCounts = Object.fromEntries(this.db.all('SELECT u.item_id, COUNT(*) AS n FROM updates u JOIN items i ON i.id=u.item_id WHERE i.board_id=? GROUP BY u.item_id', [id]).map((r) => [r.item_id, r.n]));
    const ws = this.db.get('SELECT id, name FROM workspaces WHERE id=?', [board.workspace_id]);
    const docs = {};
    const docCols = columns.filter((c) => c.type === 'doc');
    if (docCols.length) {
      const ids = [...new Set(rows.flatMap((r) => docCols.map((c) => r.data[c.id]).filter(Boolean)))];
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        for (const d of this.db.all(`SELECT id, title, updated_at FROM docs WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk)) docs[d.id] = d;
      }
    }
    return {
      board, workspace: ws, groups, columns, items, subitems, files, updateCounts, docs,
      linked: ctx.linked, people: this.people(), teams: this.teams(), views: this.views(id),
      automations: this.db.get('SELECT COUNT(*) AS n FROM automations WHERE board_id=? AND enabled=1', [id]).n,
    };
  }

  /** Preload the items other boards contribute via connect / dependency columns. */
  computeContext(rows, columns) {
    const linkIds = new Set();
    for (const c of columns) if (c.type === 'connect' || c.type === 'dependency') for (const r of rows) for (const x of r.data[c.id] || []) linkIds.add(x);
    const linked = {};
    const extBoards = {};
    if (linkIds.size) {
      const ids = [...linkIds];
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        for (const r of this.db.all(`SELECT i.id, i.name, i.board_id, i.group_id, i.seq, i.data, i.created_at, i.created_by, i.updated_at, b.name AS board_name FROM items i JOIN boards b ON b.id=i.board_id WHERE i.id IN (${chunk.map(() => '?').join(',')})`, chunk)) {
          linked[r.id] = { id: r.id, name: r.name, boardId: r.board_id, boardName: r.board_name, row: { ...r, data: parseJson(r.data, {}) } };
          extBoards[r.board_id] = true;
        }
      }
    }
    const boardCols = {};
    for (const b of Object.keys(extBoards)) boardCols[b] = this.columns(b);
    return { linked, boardCols, people: this.peopleMap(), teams: this.teamsMap() };
  }

  compute(board, columns, items, subitems, ctx) {
    const subsByParent = {};
    for (const s of subitems) (subsByParent[s.parent_id] = subsByParent[s.parent_id] || []).push(s);
    const itemCols = columns.filter((c) => c.scope === 'item');
    const subCols = columns.filter((c) => c.scope === 'sub');
    const fill = (it, cols, siblingsCols) => {
      const v = it.values = { ...it.data };
      for (const c of cols) {
        switch (c.type) {
          case 'item_id': v[c.id] = it.seq || null; break;
          case 'auto_number': v[c.id] = it.seq || null; break;
          case 'creation_log': v[c.id] = { at: it.created_at, by: it.created_by }; break;
          case 'last_updated': v[c.id] = { at: it.updated_at }; break;
          case 'subitems_count': v[c.id] = (subsByParent[it.id] || []).length; break;
          case 'mirror': v[c.id] = this.mirrorValue(it, c, cols, ctx); break;
          default: break;
        }
      }
      for (const c of cols) if (c.type === 'progress') v[c.id] = progressOf(it, c, cols);
      const formulas = cols.filter((c) => c.type === 'formula');
      if (formulas.length) {
        const doing = new Set();
        const byTitle = {};
        for (const c of cols) byTitle[c.title.toLowerCase()] = c;
        const resolve = (title) => {
          const [t, part] = title.split('#');
          const key = t.trim().toLowerCase();
          if (key === 'name' || key === 'item' || key === 'item name') return it.name;
          if (key === 'subitems count') return (subsByParent[it.id] || []).length;
          const c = byTitle[key];
          if (!c) throw new F.FormulaError(`No column named "${t.trim()}"`);
          if (c.type === 'formula' && !(c.id in v)) {
            if (doing.has(c.id)) throw new F.FormulaError('Formulas refer to each other in a loop');
            doing.add(c.id);
            v[c.id] = evalFormula(c);
          }
          return formulaInput(c, v[c.id], part, ctx);
        };
        const evalFormula = (c) => {
          try { return F.run(c.settings.expr || '', resolve); } catch (e) { return { error: e.message }; }
        };
        for (const c of formulas) if (!(c.id in v)) { doing.add(c.id); v[c.id] = evalFormula(c); }
      }
      void siblingsCols;
    };
    for (const it of items) fill(it, itemCols);
    for (const s of subitems) fill(s, subCols);
  }

  mirrorValue(it, col, cols, ctx) {
    const conn = cols.find((c) => c.id === col.settings.connectColumn);
    if (!conn) return null;
    const ids = it.data[conn.id] || [];
    const title = String(col.settings.targetTitle || '').toLowerCase();
    const vals = [];
    for (const lid of ids) {
      const l = ctx.linked[lid];
      if (!l) continue;
      if (!title || title === 'name') { vals.push({ text: l.name }); continue; }
      const tc = (ctx.boardCols[l.boardId] || []).find((c) => c.title.toLowerCase() === title && c.scope === 'item');
      if (!tc) continue;
      const raw = l.row.data[tc.id];
      if (raw == null) continue;
      vals.push({ text: C.textOf(tc, raw, ctx), num: tc.type === 'numbers' || tc.type === 'rating' ? Number(raw) : null, raw, col: tc });
    }
    if (!vals.length) return null;
    const agg = col.settings.agg || 'list';
    const nums = vals.map((x) => x.num).filter((n) => n != null && !Number.isNaN(n));
    if (agg === 'sum') return nums.reduce((s, n) => s + n, 0);
    if (agg === 'avg') return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
    if (agg === 'min') return nums.length ? Math.min(...nums) : null;
    if (agg === 'max') return nums.length ? Math.max(...nums) : null;
    if (agg === 'count') return vals.length;
    if (agg === 'earliest' || agg === 'latest') {
      const ds = vals.map((x) => (x.raw && x.raw.start ? (agg === 'earliest' ? x.raw.start : x.raw.end) : typeof x.raw === 'string' ? x.raw : null)).filter(Boolean).sort();
      return ds.length ? (agg === 'earliest' ? ds[0] : ds[ds.length - 1]) : null;
    }
    // "list" keeps label colours for status-like targets.
    return vals.map((x) => {
      if (x.col && C.LABEL_TYPES.has(x.col.type)) { const l = C.labelOf(x.col, x.raw); return l ? { label: l.label, color: l.color } : x.text; }
      return x.text;
    });
  }

  // ---------------------------------------------------------------- search
  search(q, { limit = 60 } = {}) {
    const s = String(q || '').trim().toLowerCase();
    if (s.length < 2) return [];
    const like = `%${s.replace(/[%_]/g, '')}%`;
    const out = [];
    const rows = this.db.all(`SELECT i.id, i.name, i.board_id, i.parent_id, i.data, b.name AS board_name, g.name AS group_name, g.color AS group_color FROM items i
      JOIN boards b ON b.id=i.board_id LEFT JOIN groups g ON g.id=i.group_id WHERE i.archived=0 AND b.archived=0 AND (LOWER(i.name) LIKE ? OR LOWER(i.data) LIKE ?) LIMIT 400`, [like, like]);
    for (const r of rows) {
      const nameHit = r.name.toLowerCase().includes(s);
      out.push({ kind: r.parent_id ? 'subitem' : 'item', id: r.parent_id || r.id, subId: r.parent_id ? r.id : null, name: r.name, boardId: r.board_id, boardName: r.board_name, groupName: r.group_name, groupColor: r.group_color, score: nameHit ? 2 : 1 });
    }
    for (const u of this.db.all(`SELECT u.id, u.body, u.item_id, i.name, i.board_id, b.name AS board_name FROM updates u JOIN items i ON i.id=u.item_id JOIN boards b ON b.id=i.board_id WHERE LOWER(u.body) LIKE ? LIMIT 100`, [like])) {
      out.push({ kind: 'update', id: u.item_id, name: u.name, snippet: u.body.slice(0, 160), boardId: u.board_id, boardName: u.board_name, score: 0.5 });
    }
    for (const d of this.db.all('SELECT id, title, html FROM docs WHERE LOWER(title) LIKE ? OR LOWER(html) LIKE ? LIMIT 50', [like, like])) {
      const text = d.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const i = text.toLowerCase().indexOf(s);
      out.push({ kind: 'doc', id: d.id, name: d.title, snippet: i >= 0 ? text.slice(Math.max(0, i - 40), i + 120).trim() : '', score: d.title.toLowerCase().includes(s) ? 2.5 : 0.8 });
    }
    for (const b of this.db.all('SELECT id, name, description FROM boards WHERE archived=0 AND (LOWER(name) LIKE ? OR LOWER(description) LIKE ?)', [like, like])) {
      out.push({ kind: 'board', id: b.id, name: b.name, boardId: b.id, boardName: b.name, score: 3 });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

function progressOf(it, col, cols) {
  const statusCols = cols.filter((c) => (c.type === 'status') && (!col.settings.columns || !col.settings.columns.length || col.settings.columns.includes(c.id)));
  if (!statusCols.length) return null;
  let total = 0, done = 0;
  for (const c of statusCols) {
    const w = (col.settings.weights && Number(col.settings.weights[c.id])) || 1;
    total += w;
    if (C.isDoneLabel(c, it.data[c.id])) done += w;
  }
  return total ? Math.round((done / total) * 100) : null;
}

function formulaInput(c, v, part, ctx) {
  if (v == null) return '';
  switch (c.type) {
    case 'numbers': case 'rating': case 'auto_number': case 'item_id': case 'progress': case 'subitems_count': return Number(v);
    case 'checkbox': return !!v;
    case 'timeline': return part && part.toLowerCase() === 'end' ? v.end || '' : v.start || '';
    case 'date': return String(v).slice(0, 10);
    case 'time_tracking': return C.trackedSeconds(v) / 3600;
    case 'formula': return v && v.error ? '' : v;
    case 'mirror': return Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? x.label : x)).join(', ') : v;
    case 'creation_log': case 'last_updated': return v.at ? v.at.slice(0, 10) : '';
    default: return C.textOf(c, v, ctx);
  }
}

function remapSettings(s, map) {
  const json = JSON.stringify(s);
  return JSON.parse(json.replace(/"([a-z][0-9a-z]{14,})"/g, (m, id) => (map[id] ? `"${map[id]}"` : m)));
}
function remapValue(v, map) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' && map[x] ? map[x] : x));
  return v;
}

module.exports = { Store, GROUP_COLORS, PERSON_COLORS, progressOf };
void today;
