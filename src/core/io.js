'use strict';
// Import (CSV, Excel, Boardenda board files) and export (Excel, CSV, board files).

const ExcelJS = require('exceljs');
const C = require('./columns');
const { uid, parseJson } = require('./util');

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  const delim = (s.split('\n')[0].match(/;/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? ';' : (s.split('\n')[0].includes('\t') && !s.split('\n')[0].includes(',') ? '\t' : ',');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function readTable(name, bytes) {
  if (/\.xlsx$/i.test(name)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes);
    const ws = wb.worksheets.find((w) => w.rowCount > 0) || wb.worksheets[0];
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const vals = [];
      for (let i = 1; i <= ws.columnCount; i++) {
        let v = r.getCell(i).value;
        if (v && typeof v === 'object') {
          if (v instanceof Date) v = v.toISOString().slice(0, 10);
          else if (v.text) v = v.text;
          else if (v.result != null) v = v.result;
          else if (v.richText) v = v.richText.map((t) => t.text).join('');
          else if (v.hyperlink) v = v.hyperlink;
        }
        vals.push(v == null ? '' : String(v));
      }
      rows.push(vals);
    });
    return rows;
  }
  return parseCsv(Buffer.from(bytes).toString('utf8'));
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})|^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/;
function toIsoDate(s) {
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  return null;
}

/** Guess each column's type from its header and values. */
function inferColumns(header, rows) {
  return header.map((h, i) => {
    const title = String(h || `Column ${i + 1}`).trim();
    const vals = rows.map((r) => String(r[i] || '').trim()).filter(Boolean);
    const all = (re) => vals.length > 0 && vals.every((v) => re.test(v));
    const t = title.toLowerCase();
    let type = 'text';
    if (/^(group|section|phase)$/.test(t)) type = '__group';
    else if (/status|stage|state/.test(t) && new Set(vals).size <= 12) type = 'status';
    else if (/priority|severity/.test(t) && new Set(vals).size <= 8) type = 'priority';
    else if (/^(team|teams|department|squad|owning team)$/.test(t)) type = 'team';
    else if (/owner|assignee|assigned|person|people|responsible/.test(t)) type = 'people';
    else if (/email/.test(t) || all(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)) type = 'email';
    else if (/phone|mobile/.test(t)) type = 'phone';
    else if (all(/^https?:\/\//i)) type = 'link';
    else if (vals.length && vals.every((v) => toIsoDate(v))) type = 'date';
    else if (all(/^-?[$€£]?\s?-?[\d,]*\.?\d+\s?%?$/)) type = 'numbers';
    else if (all(/^(yes|no|true|false|y|n|x|✓|done)$/i)) type = 'checkbox';
    else if (/tags?|labels?/.test(t)) type = 'tags';
    else if (vals.some((v) => v.length > 80)) type = 'long_text';
    return { title, type, index: i };
  });
}

async function importTable(store, { name, bytes, workspaceId, boardId, boardName }) {
  const rows = await readTable(name, bytes);
  if (rows.length < 2) throw new Error('The file has no rows to import');
  const header = rows[0];
  const body = rows.slice(1);
  const cols = inferColumns(header, body);
  const nameCol = cols.find((c) => /^(name|item|title|task|subject)$/i.test(c.title)) || cols.find((c) => c.type === 'text') || cols[0];
  let created = 0;
  store.db.tx(() => {
    const target = boardId || store.createBoard({ workspaceId, name: boardName || String(name).replace(/\.[^.]+$/, ''), groups: [], columns: [], views: [{ name: 'Main table', type: 'table' }] });
    const existing = store.columns(target, 'item');
    const map = {};
    for (const c of cols) {
      if (c === nameCol || c.type === '__group') continue;
      const hit = existing.find((x) => x.title.toLowerCase() === c.title.toLowerCase());
      if (hit) { map[c.index] = hit.id; continue; }
      const settings = {};
      if (c.type === 'status' || c.type === 'priority') {
        const labels = [...new Set(body.map((r) => String(r[c.index] || '').trim()).filter(Boolean))];
        settings.labels = labels.map((l, i) => ({ id: uid('l'), label: l, color: /done|complete|closed|won|fixed/i.test(l) ? 'mint' : /stuck|block|lost|late/i.test(l) ? 'coral' : C.PALETTE[(i * 3 + 4) % C.PALETTE.length].id, done: /^(done|complete|completed|closed|won|fixed)$/i.test(l) || undefined }));
      }
      if (c.type === 'numbers') {
        const sample = body.map((r) => String(r[c.index] || '')).find((v) => /[$€£%]/.test(v)) || '';
        const u = (sample.match(/[$€£%]/) || [''])[0];
        if (u) Object.assign(settings, { unit: u, unitSide: u === '%' ? 'right' : 'left' });
      }
      map[c.index] = store.addColumn(target, { title: c.title, type: c.type, settings });
    }
    const groupCol = cols.find((c) => c.type === '__group');
    const groups = Object.fromEntries(store.db.all('SELECT id, name FROM groups WHERE board_id=?', [target]).map((g) => [g.name.toLowerCase(), g.id]));
    const colRows = Object.fromEntries(store.columns(target).map((c) => [c.id, c]));
    for (const r of body) {
      const nm = String(r[nameCol.index] || '').trim();
      if (!nm) continue;
      let gid;
      const gname = groupCol ? String(r[groupCol.index] || '').trim() || 'Imported' : 'Imported';
      gid = groups[gname.toLowerCase()];
      if (!gid) { gid = store.addGroup(target, { name: gname }); groups[gname.toLowerCase()] = gid; }
      const values = {};
      for (const [idx, cid] of Object.entries(map)) {
        const raw = String(r[idx] || '').trim();
        if (!raw) continue;
        const col = colRows[cid];
        if (col.type === 'team') {
          values[cid] = raw.split(/[,;]/).map((n) => n.trim()).filter(Boolean).map((n) => store.teamByName(n, true).id);
        } else if (col.type === 'people') {
          values[cid] = raw.split(/[,;]/).map((n) => n.trim()).filter(Boolean).map((n) => (store.personByName(n) || { id: store.savePerson({ name: n }) }).id);
        } else if (col.type === 'date') values[cid] = toIsoDate(raw);
        else if (col.type === 'dropdown') {
          const opts = [...(col.settings.options || [])];
          values[cid] = raw.split(',').map((t) => t.trim()).filter(Boolean).map((t) => { let o = opts.find((x) => x.label === t); if (!o) { o = { id: uid('o'), label: t }; opts.push(o); } return o.id; });
          store.updateColumn(cid, { settings: { options: opts } });
          col.settings.options = opts;
        } else values[cid] = raw;
      }
      store.addItem(target, { groupId: gid, name: nm, values, source: 'import' });
      created++;
    }
    boardId = target;
  });
  return { boardId, created, columns: cols.length };
}

/** Rows for export: one per item and subitem, with every column as text. */
function exportRows(store, boardId) {
  const B = store.getBoard(boardId);
  const ctx = { people: Object.fromEntries(B.people.map((p) => [p.id, p])), teams: Object.fromEntries((B.teams || []).map((t) => [t.id, t])), files: B.files, itemNames: Object.fromEntries(Object.entries(B.linked).map(([k, v]) => [k, v.name])) };
  for (const it of [...B.items, ...B.subitems]) ctx.itemNames[it.id] = it.name;
  const cols = B.columns.filter((c) => c.scope === 'item' && c.type !== 'button');
  const subCols = B.columns.filter((c) => c.scope === 'sub' && c.type !== 'button');
  const header = ['Group', 'Name', ...cols.map((c) => c.title), ...(subCols.length ? ['Subitem of'] : [])];
  const rows = [];
  const cell = (c, v) => {
    if (c.type === 'formula') return v && v.error ? `#ERROR ${v.error}` : v ?? '';
    if (c.type === 'numbers') return v ?? '';
    return C.textOf(c, v, ctx);
  };
  for (const g of B.groups) {
    for (const it of B.items.filter((x) => x.group_id === g.id)) {
      rows.push([g.name, it.name, ...cols.map((c) => cell(c, it.values[c.id]))]);
      for (const s of B.subitems.filter((x) => x.parent_id === it.id)) {
        const r = [g.name, s.name, ...cols.map(() => '')];
        for (const sc of subCols) { const i = cols.findIndex((c) => c.title === sc.title); if (i >= 0) r[i + 2] = cell(sc, s.values[sc.id]); }
        r.push(it.name);
        rows.push(r);
      }
    }
  }
  return { board: B.board, header, rows, cols };
}

async function exportXlsx(store, boardIds) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Boardenda';
  for (const id of boardIds) {
    const { board, header, rows, cols } = exportRows(store, id);
    const ws = wb.addWorksheet(board.name.replace(/[\\/*?:[\]]/g, ' ').slice(0, 31) || 'Board');
    ws.addRow(header);
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B3F9E' } };
    for (const r of rows) ws.addRow(r);
    ws.columns.forEach((c, i) => { c.width = i === 1 ? 36 : 18; });
    cols.forEach((c, i) => { if (c.type === 'numbers' && c.settings.unit) ws.getColumn(i + 3).numFmt = c.settings.unitSide === 'left' ? `"${c.settings.unit}"#,##0.##` : `#,##0.## "${c.settings.unit}"`; });
    ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 2 }];
    ws.autoFilter = { from: 'A1', to: { row: 1, column: header.length } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function exportCsv(store, boardId) {
  const { header, rows } = exportRows(store, boardId);
  return `﻿${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** A self-contained board file (structure, items, updates; not attachments). */
function exportBoardFile(store, boardId) {
  const db = store.db;
  const board = db.get('SELECT * FROM boards WHERE id=?', [boardId]);
  return JSON.stringify({
    format: 'boardenda.board', version: 1, exportedAt: new Date().toISOString(),
    board, groups: db.all('SELECT * FROM groups WHERE board_id=?', [boardId]), columns: db.all('SELECT * FROM columns WHERE board_id=?', [boardId]),
    items: db.all('SELECT * FROM items WHERE board_id=? AND archived=0', [boardId]), views: db.all('SELECT * FROM views WHERE board_id=?', [boardId]),
    automations: db.all('SELECT * FROM automations WHERE board_id=?', [boardId]),
    updates: db.all('SELECT u.* FROM updates u JOIN items i ON i.id=u.item_id WHERE i.board_id=?', [boardId]),
    people: db.all('SELECT id, name, email, team, color FROM people'),
    teams: db.all('SELECT id, name, color, description, external FROM teams'),
  }, null, 1);
}

function importBoardFile(store, text, { workspaceId, name } = {}) {
  const f = parseJson(text, null);
  if (!f || f.format !== 'boardenda.board') throw new Error('This is not a Boardenda board file');
  const db = store.db;
  const map = {};
  const id = (old, p) => { if (!map[old]) map[old] = uid(p); return map[old]; };
  // People are matched by name; unknown people are added.
  for (const p of f.people || []) map[p.id] = (store.personByName(p.name) || { id: store.savePerson({ ...p, team: '' }) }).id;
  for (const t of f.teams || []) map[t.id] = (store.teamByName(t.name) || { id: store.saveTeam({ ...t, id: null }) }).id;
  const remap = (json) => JSON.stringify(parseJson(json, {}), (k, v) => (typeof v === 'string' && map[v] ? map[v] : v));
  let nb;
  db.tx(() => {
    for (const x of f.groups) id(x.id, 'g');
    for (const x of f.columns) id(x.id, 'c');
    for (const x of f.items) id(x.id, 'i');
    nb = id(f.board.id, 'b');
    const ws = workspaceId || (db.get('SELECT id FROM workspaces ORDER BY position LIMIT 1') || {}).id || store.saveWorkspace({ name: 'Main workspace' });
    const ts = new Date().toISOString();
    db.run('INSERT INTO boards(id,workspace_id,folder,name,description,item_noun,position,settings,next_seq,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [nb, ws, '', name || f.board.name, f.board.description || '', f.board.item_noun || 'item', Date.now() / 1e12, remap(f.board.settings), f.board.next_seq || 1, ts, ts]);
    for (const g of f.groups) db.run('INSERT INTO groups(id,board_id,name,color,position,collapsed,archived) VALUES(?,?,?,?,?,?,?)', [map[g.id], nb, g.name, g.color, g.position, 0, g.archived || 0]);
    for (const c of f.columns) db.run('INSERT INTO columns(id,board_id,scope,title,type,description,position,width,settings) VALUES(?,?,?,?,?,?,?,?,?)', [map[c.id], nb, c.scope, c.title, c.type, c.description || '', c.position, c.width || 0, remap(c.settings)]);
    const items = [...f.items].sort((a, b) => (a.parent_id ? 1 : 0) - (b.parent_id ? 1 : 0));
    for (const it of items) {
      const data = {};
      for (const [k, v] of Object.entries(parseJson(it.data, {}))) if (map[k]) data[map[k]] = Array.isArray(v) ? v.map((x) => map[x] || x).filter((x) => typeof x !== 'string' || !/^f/.test(x)) : v;
      db.run('INSERT INTO items(id,board_id,group_id,parent_id,name,position,seq,data,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        [map[it.id], nb, it.group_id ? map[it.group_id] : null, it.parent_id ? map[it.parent_id] : null, it.name, it.position, it.seq || 0, JSON.stringify(data), map[it.created_by] || it.created_by || '', it.created_at, it.updated_at]);
    }
    for (const v of f.views) db.run('INSERT INTO views(id,board_id,name,type,position,config) VALUES(?,?,?,?,?,?)', [uid('v'), nb, v.name, v.type, v.position, remap(v.config)]);
    for (const a of f.automations || []) db.run('INSERT INTO automations(id,board_id,name,enabled,recipe,created_at) VALUES(?,?,?,?,?,?)', [uid('a'), nb, a.name, a.enabled, remap(a.recipe), ts]);
    for (const u of f.updates || []) if (map[u.item_id]) db.run('INSERT INTO updates(id,item_id,parent_id,author,body,pinned,created_at) VALUES(?,?,?,?,?,?,?)', [uid('u'), map[u.item_id], null, map[u.author] || u.author, u.body, u.pinned || 0, u.created_at]);
  });
  return nb;
}

module.exports = { parseCsv, inferColumns, importTable, exportXlsx, exportCsv, exportBoardFile, importBoardFile, toIsoDate };
