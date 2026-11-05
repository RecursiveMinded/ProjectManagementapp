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
    else if (/^(subitem of|parent|parent item)$/.test(t)) type = '__parent';
    else if (/timeline|date range|period/.test(t) || (vals.length && vals.every((v) => /\d{4}-\d{2}-\d{2}.*\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\s*[-–]\s*\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(v)))) type = 'timeline';
    else if (/status|stage|state/.test(t) && new Set(vals).size <= 12) type = 'status';
    else if (/priority|severity/.test(t) && new Set(vals).size <= 8) type = 'priority';
    else if (/^(team|teams|department|squad|owning team)$/.test(t)) type = 'team';
    else if (/^(customer|customers|client|account|account name|company)$/.test(t)) type = 'customer';
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

const EXAMPLE_RE = /^example\s*[:\-–]/i;

/** What an import would create, so it can be checked and adjusted first. */
async function previewImport(name, bytes) {
  const { extract } = require('./extract');
  const r = await extract(name, bytes, readTable);
  const rows = (r.rows || []).map((x) => x.map((v) => (v == null ? '' : String(v))));
  if (rows.length < 2) throw new Error('No rows were found to import');
  const width = Math.max(...rows.map((x) => x.length));
  const norm = rows.map((x) => { const y = [...x]; while (y.length < width) y.push(''); return y; });
  const header = norm[0].map((h, i) => String(h || '').trim() || `Column ${i + 1}`);
  const body = norm.slice(1).filter((x) => x.some((v) => String(v).trim()));
  const cols = inferColumns(header, body);
  const nameCol = guessName(cols);
  const examples = body.filter((x) => EXAMPLE_RE.test(String(x[nameCol.index] || ''))).length;
  return { kind: r.kind, notes: r.notes || [], confidence: r.confidence, header, rows: body.slice(0, 500), total: body.length, examples,
    columns: cols.map((c) => ({ ...c, type: c === nameCol ? '__name' : c.type })) };
}

function guessName(cols) {
  return cols.find((c) => /^(name|item|title|task|subject|item name|task name|action|action item)$/i.test(c.title)) || cols.find((c) => c.type === 'text') || cols[0];
}

/**
 * Create items from rows. columns (optional) overrides the guessed types:
 * [{ index, title, type }] where type may be '__name', '__group', '__parent' or 'skip'.
 */
async function importTable(store, { name, bytes, rows: given, header: givenHeader, columns: chosen, workspaceId, boardId, boardName, skipExamples = true }) {
  let rows = given ? [givenHeader, ...given] : await readTable(name, bytes);
  if (rows.length < 2) throw new Error('The file has no rows to import');
  const header = rows[0].map((h, i) => String(h || '').trim() || `Column ${i + 1}`);
  let body = rows.slice(1);
  let cols = chosen && chosen.length ? chosen.map((c) => ({ index: Number(c.index), title: String(c.title || header[c.index] || `Column ${Number(c.index) + 1}`).trim(), type: c.type })).filter((c) => c.type !== 'skip') : inferColumns(header, body);
  const nameCol = cols.find((c) => c.type === '__name') || guessName(cols);
  if (!nameCol) throw new Error('Choose which column holds the item names');
  if (skipExamples) body = body.filter((r) => !EXAMPLE_RE.test(String(r[nameCol.index] || '').trim()));
  if (!body.some((r) => String(r[nameCol.index] || '').trim())) throw new Error(rows.length > 1 && skipExamples ? 'Only EXAMPLE rows were found. Add your own rows to the sheet, then import it.' : 'No rows with a name were found');
  cols = cols.map((c) => (c === nameCol ? { ...c, type: '__name' } : c));
  let created = 0;
  store.db.tx(() => {
    const target = boardId || store.createBoard({ workspaceId, name: boardName || String(name).replace(/\.[^.]+$/, ''), groups: [], columns: [], views: [{ name: 'Main table', type: 'table' }] });
    const existing = store.columns(target, 'item');
    const map = {};
    for (const c of cols) {
      if (c === nameCol || c.type === '__group' || c.type === '__parent' || c.type === '__name' || !C.TYPES[c.type]) continue;
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
    const parentCol = cols.find((c) => c.type === '__parent');
    const byName = {};
    const subs = [];
    const groups = Object.fromEntries(store.db.all('SELECT id, name FROM groups WHERE board_id=?', [target]).map((g) => [g.name.toLowerCase(), g.id]));
    const colRows = Object.fromEntries(store.columns(target).map((c) => [c.id, c]));
    for (const r of body) {
      const nm = String(r[nameCol.index] || '').trim();
      if (!nm) continue;
      const gname = groupCol ? String(r[groupCol.index] || '').trim() || 'Imported' : 'Imported';
      const groupFor = () => { let g = groups[gname.toLowerCase()]; if (!g) { g = store.addGroup(target, { name: gname }); groups[gname.toLowerCase()] = g; } return g; };
      const values = {};
      for (const [idx, cid] of Object.entries(map)) {
        const raw = String(r[idx] || '').trim();
        if (!raw) continue;
        const col = colRows[cid];
        if (col.type === 'customer') {
          values[cid] = raw.split(/[;]/).map((n) => n.trim()).filter(Boolean).map((n) => store.customerByName(n, true).id).slice(0, col.settings.max === 1 ? 1 : 50);
        } else if (col.type === 'team') {
          values[cid] = raw.split(/[,;]/).map((n) => n.trim()).filter(Boolean).map((n) => store.teamByName(n, true).id);
        } else if (col.type === 'people') {
          values[cid] = raw.split(/[,;]/).map((n) => n.trim()).filter(Boolean).map((n) => (store.personByName(n) || { id: store.savePerson({ name: n }) }).id);
        } else if (col.type === 'date') values[cid] = toIsoDate(raw);
        else if (col.type === 'timeline') {
          const ds = (raw.match(/\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4}/g) || []).map(toIsoDate).filter(Boolean);
          if (ds.length) values[cid] = { start: ds[0], end: ds[1] || ds[0] };
        } else if (col.type === 'checkbox') values[cid] = /^(yes|true|y|x|1|✓|done)$/i.test(raw) || null;
        else if (col.type === 'dropdown') {
          const opts = [...(col.settings.options || [])];
          values[cid] = raw.split(',').map((t) => t.trim()).filter(Boolean).map((t) => { let o = opts.find((x) => x.label === t); if (!o) { o = { id: uid('o'), label: t }; opts.push(o); } return o.id; });
          store.updateColumn(cid, { settings: { options: opts } });
          col.settings.options = opts;
        } else values[cid] = raw;
      }
      const parentName = parentCol ? String(r[parentCol.index] || '').trim() : '';
      if (parentName) { subs.push({ parentName, nm, values, groupFor }); continue; }
      byName[nm.toLowerCase()] = store.addItem(target, { groupId: groupFor(), name: nm, values, source: 'import' });
      created++;
    }
    for (const s of subs) {
      const pid = byName[s.parentName.toLowerCase()];
      if (pid) {
        // Subitems keep only values for subitem columns with the same title.
        const subCols = store.columns(target, 'sub');
        const sv = {};
        for (const [cid, v] of Object.entries(s.values)) { const c = colRows[cid]; const sc = c && subCols.find((x) => x.title.toLowerCase() === c.title.toLowerCase()); if (sc) sv[sc.id] = v; }
        store.addItem(target, { parentId: pid, name: s.nm, values: sv, source: 'import' });
      } else byName[s.nm.toLowerCase()] = store.addItem(target, { groupId: s.groupFor(), name: s.nm, values: s.values, source: 'import' });
      created++;
    }
    boardId = target;
  });
  return { boardId, created, columns: cols.length };
}

/** Rows for export: one per item and subitem, with every column as text. */
function exportRows(store, boardId) {
  const B = store.getBoard(boardId);
  const ctx = { people: Object.fromEntries(B.people.map((p) => [p.id, p])), teams: Object.fromEntries((B.teams || []).map((t) => [t.id, t])), customers: Object.fromEntries((B.customers || []).map((c) => [c.id, c])), files: B.files, itemNames: Object.fromEntries(Object.entries(B.linked).map(([k, v]) => [k, v.name])) };
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

module.exports = { parseCsv, inferColumns, importTable, previewImport, importSheet, readTable, exportXlsx, exportCsv, exportBoardFile, importBoardFile, toIsoDate };

const SHEET_COLS = [
  ['Name', 'text', 'Required. One row per item.', ['EXAMPLE: Write the project brief', 'EXAMPLE: Review the brief', 'EXAMPLE: Collect sign-off']],
  ['Group', '__group', 'Items with the same group name are put together. New groups are created.', ['Planning', 'Planning', 'Approval']],
  ['Subitem of', '__parent', 'Optional. The name of another row; this row becomes its subitem.', ['', 'EXAMPLE: Write the project brief', '']],
  ['Status', 'status', 'Any words. Done, Complete, Closed, Won and Fixed count as done. Each different value becomes a label.', ['Done', 'In progress', 'Not started']],
  ['Owner', 'people', 'Names, separated by commas. Unknown names are added as people.', ['Alex Morgan', 'Jordan Lee, Sam Patel', '']],
  ['Team', 'team', 'Team names, separated by commas. Unknown teams are added.', ['Product', 'Design', 'Legal']],
  ['Customer', 'customer', 'The customer or account name. Unknown customers are added to the Customers directory.', ['Northwind Traders', 'Northwind Traders', '']],
  ['Priority', 'priority', 'Any words, such as Low, Medium, High, Critical.', ['High', 'Medium', 'Low']],
  ['Timeline', 'timeline', 'Two dates: 2026-01-05 - 2026-01-09 (or 05/01/2026 - 09/01/2026).', ['2026-01-05 - 2026-01-09', '2026-01-12 - 2026-01-14', '']],
  ['Due date', 'date', 'One date: 2026-01-09, or day/month/year.', ['2026-01-09', '2026-01-14', '2026-01-20']],
  ['Effort (hours)', 'numbers', 'A number. Add $, €, £ or % to a value to use it as the unit.', ['6', '2', '1']],
  ['Done?', 'checkbox', 'Yes / No (also True/False, Y/N, X).', ['Yes', 'No', '']],
  ['Tags', 'tags', 'Words separated by commas.', ['brief, q1', 'review', '']],
  ['Link', 'link', 'A web address starting with http:// or https://.', ['https://example.com/brief', '', '']],
  ['Notes', 'long_text', 'Any text.', ['Keep it to one page.', '', 'Needs Legal to sign.']],
];

/**
 * A blank Excel sheet to fill in for import, with examples and a "How to fill
 * this in" tab. With a boardId, its headers match that board's columns.
 */
async function importSheet(store, boardId) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Boardenda';
  const ws = wb.addWorksheet('Items', { views: [{ state: 'frozen', ySplit: 1 }] });
  let cols;
  if (boardId) {
    const B = store.getBoard(boardId);
    const usable = B.columns.filter((c) => c.scope === 'item' && !C.isComputed(c.type) && !['button', 'files', 'doc', 'vote', 'time_tracking', 'connect', 'dependency'].includes(c.type));
    const sample = B.items[0];
    const ctx = { people: Object.fromEntries(B.people.map((p) => [p.id, p])), teams: Object.fromEntries((B.teams || []).map((t) => [t.id, t])), customers: Object.fromEntries((B.customers || []).map((c) => [c.id, c])) };
    const fmt = (c, v) => (c.type === 'timeline' && v ? `${v.start} - ${v.end}` : C.textOf(c, v, ctx));
    cols = [
      [B.board.item_noun ? B.board.item_noun[0].toUpperCase() + B.board.item_noun.slice(1) : 'Name', 'text', 'Required.', [sample ? `EXAMPLE: ${sample.name}` : 'EXAMPLE: First item']],
      ['Group', '__group', `Existing groups: ${B.groups.filter((g) => !g.archived).map((g) => g.name).join(', ')}. Other names create a group.`, [sample ? (B.groups.find((g) => g.id === sample.group_id) || {}).name || '' : '']],
      ['Subitem of', '__parent', 'Optional. The name of another row; this row becomes its subitem.', ['']],
      ...usable.map((c) => {
        const base = SHEET_COLS.find((x) => x[1] === c.type);
        const labels = C.LABEL_TYPES.has(c.type) ? (c.settings.labels || []).map((l) => l.label) : c.type === 'dropdown' ? (c.settings.options || []).map((o) => o.label) : null;
        return [c.title, c.type, labels ? `One of: ${labels.join(', ')}` : base ? base[2] : 'Any text.', [sample ? fmt(c, sample.values[c.id]) : ''], labels];
      }),
    ];
  } else cols = SHEET_COLS;
  ws.columns = cols.map(([title, type]) => ({ header: title, key: title, width: type === 'long_text' ? 36 : type === 'text' ? 34 : type === 'timeline' ? 26 : 16 }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5A55D6' } };
  const n = Math.max(...cols.map((c) => c[3].length));
  for (let i = 0; i < n; i++) {
    const r = ws.addRow(cols.map((c) => (c[3][i] != null ? c[3][i] : '')));
    r.font = { italic: true, color: { argb: 'FF8A89A3' } };
  }
  cols.forEach((c, i) => {
    const list = c[4] || (c[1] === 'status' && !boardId ? ['Not started', 'In progress', 'Blocked', 'Done'] : c[1] === 'priority' && !boardId ? ['Low', 'Medium', 'High', 'Critical'] : c[1] === 'checkbox' ? ['Yes', 'No'] : null);
    if (!list || !list.length || list.join(',').length > 250) return;
    const letter = ws.getColumn(i + 1).letter;
    for (let r = 2; r <= 500; r++) ws.getCell(`${letter}${r}`).dataValidation = { type: 'list', allowBlank: true, showErrorMessage: false, formulae: [`"${list.join(',')}"`] };
  });
  const help = wb.addWorksheet('How to fill this in');
  help.columns = [{ header: 'Column', key: 'c', width: 22 }, { header: 'What to put in it', key: 'd', width: 90 }];
  help.getRow(1).font = { bold: true };
  help.addRow({ c: 'Rows', d: 'One row per item. Rows whose name starts with "EXAMPLE:" are skipped, so you can leave or delete them.' });
  help.addRow({ c: 'Headers', d: 'Keep the header names: they decide each column’s type. You can delete columns you do not need or add your own; new ones are guessed from their values.' });
  help.addRow({ c: 'Before importing', d: 'Boardenda shows a preview where you can change any column’s type or skip it.' });
  help.addRow({});
  for (const c of cols) help.addRow({ c: c[0], d: c[2] });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
