'use strict';
// Core engine tests: formulas, boards and columns, dependencies, automations,
// dashboards, My work, import/export and persistence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../src/core/formula');
const C = require('../src/core/columns');
const { AppApi } = require('../src/core/api');
const { addDays, today } = require('../src/core/util');

const fresh = () => AppApi.create({});
const col = (B, title, scope = 'item') => B.columns.find((c) => c.title === title && c.scope === scope);

test('formulas: arithmetic, precedence, functions and references', () => {
  const vals = { Budget: 1000, Spent: 1200, Name: 'Alpha' };
  const r = (e) => F.run(e, (k) => vals[k]);
  assert.equal(r('1 + 2 * 3'), 7);
  assert.equal(r('-2^2'), -4);
  assert.equal(r('2^3^2'), 512);
  assert.equal(r('IF({Spent} > {Budget}, "Over", "OK")'), 'Over');
  assert.equal(r('ROUND({Spent} / {Budget} * 100, 1)'), 120);
  assert.equal(r('CONCATENATE(UPPER({Name}), "-", LEN({Name}))'), 'ALPHA-5');
  assert.equal(r('SWITCH(2, 1, "one", 2, "two", "many")'), 'two');
  assert.equal(r('AND(TRUE, NOT(FALSE))'), true);
  assert.equal(r('DAYS("2026-03-10", "2026-03-01")'), 9);
  assert.equal(r('IF(FALSE, 1/0, 5)'), 5, 'IF is lazy');
  assert.deepEqual(F.refs('{A} + {B#Start} + {A}'), ['A', 'B#Start']);
  assert.ok(F.check('1 +'), 'syntax errors are reported');
  assert.equal(F.check('SUM(1, 2)'), null);
});

test('columns: coercion, text and done labels', () => {
  const status = { type: 'status', settings: { labels: C.statusLabels() } };
  const done = status.settings.labels.find((l) => l.done);
  assert.ok(C.isDoneLabel(status, done.id));
  assert.equal(C.textOf({ type: 'numbers', settings: { unit: '$', unitSide: 'left' } }, 1234.5, {}).replace(/\s/g, ''), '$1,234.50');
  assert.equal(C.coerce({ type: 'numbers', settings: {} }, '12.5'), 12.5);
  assert.equal(C.coerce({ type: 'checkbox', settings: {} }, 'yes'), true);
  assert.ok(C.isComputed('formula') && C.isComputed('mirror') && !C.isComputed('text'));
});

test('sample workspace builds every board, view and dashboard', async () => {
  const api = await fresh();
  api.loadSample();
  const boot = api.bootstrap();
  assert.equal(boot.empty, false);
  const boards = boot.workspaces.flatMap((w) => w.boards);
  assert.ok(boards.length >= 5);
  for (const b of boards) {
    const B = api.getBoard(b.id);
    assert.ok(B.items.length > 0, `${b.name} has items`);
    assert.ok(B.views.length > 0, `${b.name} has views`);
  }
  const D = api.getDashboard(boot.dashboards[0].id);
  assert.ok(D.widgets.length >= 6);
  for (const w of D.widgets) assert.equal(w.error, null, `${w.type} widget computes`);
});

test('boards: groups, columns, items, subitems and formulas', async () => {
  const api = await fresh();
  const ws = api.saveWorkspace({ name: 'W' });
  const id = api.createBoard({ template: 'blank', workspaceId: ws, name: 'B' });
  let B = api.getBoard(id);
  const g = api.addGroup(id, { name: 'Next' });
  const budget = api.addColumn(id, { title: 'Budget', type: 'numbers' });
  const spent = api.addColumn(id, { title: 'Spent', type: 'numbers' });
  const fx = api.addColumn(id, { title: 'Left', type: 'formula', settings: { expr: '{Budget} - {Spent}' } });
  assert.throws(() => api.addColumn(id, { title: 'Bad', type: 'formula', settings: { expr: '{Budget} +' } }));
  const it = api.addItem(id, { groupId: g, name: 'Thing', values: { Budget: 100, [spent]: 30 } });
  B = api.getBoard(id);
  const item = B.items.find((i) => i.id === it);
  assert.equal(item.values[budget], 100);
  assert.equal(item.values[fx], 70);
  api.addItem(id, { parentId: it, name: 'Sub one' });
  B = api.getBoard(id);
  assert.equal(B.subitems.filter((s) => s.parent_id === it).length, 1);
  const copy = api.duplicateItem(it);
  api.moveItem(copy, { groupId: B.groups[0].id });
  B = api.getBoard(id);
  assert.equal(B.items.find((i) => i.id === copy).group_id, B.groups[0].id);
  api.bulk([it, copy], 'archive');
  assert.equal(api.getBoard(id).items.length, 0);
  assert.equal(api.archived().items.length, 2);
});

test('changing a column type converts its values', async () => {
  const api = await fresh();
  const ws = api.saveWorkspace({ name: 'W' });
  const id = api.createBoard({ template: 'blank', workspaceId: ws, name: 'B' });
  const c = api.addColumn(id, { title: 'Size', type: 'text' });
  const it = api.addItem(id, { name: 'A', values: { [c]: '42' } });
  api.updateColumn(c, { type: 'numbers' });
  assert.equal(api.getBoard(id).items.find((i) => i.id === it).values[c], 42);
});

test('dependencies push dependent timelines later', async () => {
  const api = await fresh();
  api.loadSample();
  const pb = api.bootstrap().workspaces[0].boards.find((b) => b.name === 'Website relaunch');
  let B = api.getBoard(pb.id);
  const tl = col(B, 'Timeline');
  const design = B.items.find((i) => i.name === 'Design the solution');
  const build = B.items.find((i) => i.name === 'Build first release');
  const before = build.values[tl.id];
  const d = design.values[tl.id];
  api.setValue(design.id, tl.id, { start: d.start, end: addDays(d.end, 5) });
  B = api.getBoard(pb.id);
  const after = B.items.find((i) => i.id === build.id).values[tl.id];
  assert.ok(after.start > before.start, 'dependent moved later');
});

test('automations: status change moves items; new items are assigned; logs are kept', async () => {
  const api = await fresh();
  api.loadSample();
  const boards = api.bootstrap().workspaces[0].boards;
  const pb = boards.find((b) => b.name === 'Website relaunch');
  let B = api.getBoard(pb.id);
  const status = col(B, 'Status');
  const design = B.items.find((i) => i.name === 'Design the solution');
  api.setValue(design.id, status.id, 'done');
  B = api.getBoard(pb.id);
  assert.equal(B.groups.find((g) => g.id === B.items.find((i) => i.id === design.id).group_id).name, 'Launch');
  assert.ok(api.automationLog({ boardId: pb.id }).length >= 1);

  const tasks = boards.find((b) => b.name === 'Team tasks');
  const id = api.addItem(tasks.id, { name: 'Brand new' });
  const T = api.getBoard(tasks.id);
  assert.ok((T.items.find((i) => i.id === id).values[col(T, 'Owner').id] || []).length > 0);
});

test('automations: custom recipe with a condition, and the scheduler fires once a day', async () => {
  const api = await fresh();
  const ws = api.saveWorkspace({ name: 'W' });
  const id = api.createBoard({ template: 'tasks', workspaceId: ws, name: 'T' });
  const B = api.getBoard(id);
  const due = B.columns.find((c) => c.type === 'date');
  const prio = api.addColumn(id, { title: 'Score', type: 'numbers' });
  api.saveAutomation(id, { name: 'Due today', recipe: { trigger: { type: 'date_arrives', column: due.id, offset: 0, at: '00:00' }, conditions: [], actions: [{ type: 'increase_number', column: prio, by: 1 }] } });
  const it = api.addItem(id, { name: 'Today', values: { [due.id]: today() } });
  const first = api.runSchedule();
  const second = api.runSchedule();
  assert.ok(first >= 1);
  assert.equal(second, 0, 'the same day is not fired twice');
  assert.equal(api.getBoard(id).items.find((i) => i.id === it).values[prio], 1);
  assert.throws(() => api.saveAutomation(id, { recipe: { trigger: { type: 'nope' }, actions: [] } }));
});

test('updates, mentions, notifications and the digest', async () => {
  const api = await fresh();
  api.loadSample();
  const pb = api.bootstrap().workspaces[0].boards[0];
  const B = api.getBoard(pb.id);
  api.postUpdate(B.items[0].id, 'Looping in @Jordan Lee');
  const jordan = api.bootstrap().people.find((p) => p.name === 'Jordan Lee');
  const n = api.db.all('SELECT * FROM notifications WHERE person_id=?', [jordan.id]);
  assert.ok(n.some((x) => x.kind === 'mention'), 'mentioned person is notified');
  const dg = api.digest();
  assert.match(dg.headline, /due|Nothing/);
  assert.ok(Array.isArray(api.myWork({ includeDone: true })));
  assert.ok(api.search('design').length > 0);
});

test('import and export: CSV, Excel and board files round-trip', async () => {
  const api = await fresh();
  api.loadSample();
  const pb = api.bootstrap().workspaces[0].boards[0];
  const csv = api.exportCsv(pb.id);
  assert.match(csv.split('\n')[0], /Name|Task/);
  const xlsx = await api.exportXlsx([pb.id]);
  assert.ok(xlsx.length > 1000);
  const copy = api.importBoardFile(api.exportBoardFile(pb.id));
  assert.equal(api.getBoard(copy).items.length, api.getBoard(pb.id).items.length);
  const imp = await api.importTable({ name: 't.csv', bytes: Buffer.from('Name,Status,Owner,Due,Cost,Group\nA,Done,Jordan Lee,2026-11-10,$100,G1\nB,Working,New Person,11/20/2026,$20.5,G2\n') });
  const IB = api.getBoard(imp.boardId);
  const types = Object.fromEntries(IB.columns.map((c) => [c.title, c.type]));
  assert.equal(types.Status, 'status');
  assert.equal(types.Owner, 'people');
  assert.equal(types.Due, 'date');
  assert.equal(types.Cost, 'numbers');
  assert.deepEqual(IB.groups.map((g) => g.name).sort(), ['G1', 'G2']);
  const back = await api.importTable({ name: 'x.xlsx', bytes: xlsx });
  assert.ok(api.getBoard(back.boardId).items.length > 0);
});

test('persistence: data survives a restart, backups restore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-test-'));
  let api = await AppApi.create({ dataDir: dir });
  api.loadSample();
  const count = api.stats().items;
  api.db.close();
  api = await AppApi.create({ dataDir: dir });
  assert.equal(api.stats().items, count);
  const name = api.backup('manual');
  const pb = api.bootstrap().workspaces[0].boards[0];
  api.deleteBoard(pb.id);
  assert.ok(api.stats().items < count);
  await api.restoreBackup(name);
  assert.equal(api.stats().items, count);
  assert.equal(api.stats().integrity, 'ok');
  api.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('calendar: dated work across boards within a range', async () => {
  const api = await fresh();
  api.loadSample();
  const all = api.calendar({});
  assert.ok(all.entries.length > 5);
  assert.ok(new Set(all.entries.map((e) => e.boardId)).size >= 3, 'several boards contribute');
  const e = all.entries.find((x) => x.type === 'timeline');
  const narrow = api.calendar({ from: e.end, to: e.end });
  assert.ok(narrow.entries.some((x) => x.key === e.key), 'an overlapping timeline is included');
  assert.ok(narrow.entries.every((x) => x.start <= e.end && x.end >= e.end));
});

test('teams: membership, team column, and cross-team dependencies (record only)', async () => {
  const api = await fresh();
  api.loadSample();
  const teams = api.teams();
  const eng = teams.find((t) => t.name === 'Engineering');
  assert.equal(eng.members.length, 2, 'people were placed in their teams');
  assert.ok(teams.find((t) => t.name === 'Legal').external);
  const d = api.dependencies();
  assert.ok(d.links.some((l) => l.kind === 'item' && l.cross), 'item dependency between two teams');
  assert.ok(d.links.some((l) => l.kind === 'team' && l.state === 'waiting'), 'a waiting-on-team mark');
  assert.ok(d.matrix.length >= 3);
  // Marking a new team dependency on an item.
  const pb = api.bootstrap().workspaces[0].boards.find((b) => b.name === 'Website relaunch');
  const B = api.getBoard(pb.id);
  const wait = col(B, 'Waiting on team');
  const vendor = api.saveTeam({ name: 'Print vendor', external: true });
  const it = B.items.find((i) => i.name === 'Test with pilot customers');
  api.setValue(it.id, wait.id, [vendor]);
  const after = api.dependencies();
  assert.ok(after.links.some((l) => l.kind === 'team' && l.providers[0] === vendor && l.successor.id === it.id));
  assert.equal(api.notifications({}).filter((n) => /Print vendor/.test(n.title + n.body)).length, 0, 'nobody is notified');
  // Deleting a team keeps its members.
  api.deleteTeam(eng.id);
  assert.equal(api.bootstrap().people.length, 4);
});

test('upgrading a version 1 database turns free-text teams into teams', async () => {
  const api = await fresh();
  api.db.run("INSERT INTO people(id,name,team,created_at) VALUES('p1','Kim','Ops','2026-01-01'),('p2','Lee','Ops','2026-01-01')");
  api.db.run("UPDATE settings SET value='1' WHERE key='schema_version'");
  api.db.run('DELETE FROM teams');
  api.db.migrate();
  const ops = api.teams().find((t) => t.name === 'Ops');
  assert.ok(ops);
  assert.deepEqual(ops.members.sort(), ['p1', 'p2']);
});

test('trash and undo: deleted boards, groups, columns and items come back', async () => {
  const api = await fresh();
  api.loadSample();
  const b = api.bootstrap().workspaces[0].boards.find((x) => x.name === 'Website relaunch');
  const B = api.getBoard(b.id);
  const status = col(B, 'Status');
  const first = B.items[0];
  const before = first.values[status.id];
  api.setValue(first.id, status.id, 'stuck');
  assert.match(api.undo(), /Changed Status/);
  const byId = () => api.getBoard(b.id).items.find((i) => i.id === first.id);
  assert.equal(byId().values[status.id], before);

  api.deleteColumn(status.id);
  api.undo();
  assert.equal(byId().values[status.id], before, 'column values restored');

  const withSubs = B.items.find((i) => B.subitems.some((s) => s.parent_id === i.id));
  api.postUpdate(withSubs.id, 'keep me');
  api.deleteItem(withSubs.id);
  assert.equal(api.trash()[0].kind, 'item');
  api.restoreTrash(api.trash()[0].id);
  const back = api.getItem(withSubs.id);
  assert.ok(back.subitems.length > 0 && back.updates.length === 1, 'subitems and updates restored');

  const counts = (id) => { const x = api.getBoard(id); return [x.items.length, x.subitems.length, x.columns.length, x.views.length]; };
  const full = counts(b.id);
  api.deleteBoard(b.id);
  assert.throws(() => api.getBoard(b.id));
  api.undo();
  assert.deepEqual(counts(b.id), full);

  api.deleteGroup(B.groups[0].id);
  assert.equal(api.purgeTrash(), 1);
  assert.equal(api.trash().length, 0);
});

test('your templates, favorites and folders', async () => {
  const api = await fresh();
  api.loadSample();
  const ws = api.bootstrap().workspaces[0];
  const b = ws.boards.find((x) => x.name === 'Website relaunch');
  const src = api.getBoard(b.id);
  const tid = api.saveAsTemplate(b.id, { name: 'My plan', description: 'Reusable' });
  assert.equal(api.userTemplates()[0].name, 'My plan');
  const nb = api.createBoard({ template: `user:${tid}`, workspaceId: ws.id });
  const N = api.getBoard(nb);
  assert.equal(N.board.name, 'My plan');
  assert.equal(N.items.length, 0);
  assert.equal(N.columns.length, src.columns.length);
  const withItems = api.createBoard({ template: `user:${api.saveAsTemplate(b.id, { name: 'Full', withItems: true })}`, workspaceId: ws.id });
  assert.equal(api.getBoard(withItems).items.length, src.items.length);
  api.deleteTemplate(tid);
  assert.equal(api.userTemplates().length, 1);
  assert.throws(() => api.createBoard({ template: `user:${tid}`, workspaceId: ws.id }), /no longer exists/);

  assert.deepEqual(api.toggleFavorite('board', b.id), [{ kind: 'board', id: b.id }]);
  assert.equal(api.bootstrap().favorites.length, 1);
  assert.deepEqual(api.toggleFavorite('board', b.id), []);

  api.setBoardFolder(nb, '  Q4  ');
  assert.equal(api.bootstrap().workspaces[0].boards.find((x) => x.id === nb).folder, 'Q4');
});

test('critical path and baseline variance', () => {
  const S = require('../src/core/schedule');
  // A(1-3) -> B(4-6) -> D(7-10);  A -> C(4-5) -> D ;  E(1-2) unlinked
  const nodes = [
    { id: 'A', start: '2026-01-01', end: '2026-01-03' }, { id: 'B', start: '2026-01-04', end: '2026-01-06' },
    { id: 'C', start: '2026-01-04', end: '2026-01-05' }, { id: 'D', start: '2026-01-07', end: '2026-01-10' },
    { id: 'E', start: '2026-01-01', end: '2026-01-02' },
  ];
  const links = [{ from: 'A', to: 'B' }, { from: 'B', to: 'D' }, { from: 'A', to: 'C' }, { from: 'C', to: 'D' }];
  const r = S.criticalPath(nodes, links);
  assert.deepEqual([...r.critical].sort(), ['A', 'B', 'D']);
  assert.equal(r.float.C, 1);
  assert.ok(r.links.has('A>B') && r.links.has('B>D') && !r.links.has('C>D'));
  assert.equal(r.finish, '2026-01-10');
  assert.equal(S.criticalPath(nodes, []).critical.size, 0);
  // A lag of 1 day on finish-to-start: the chain with no gap has negative float and stays critical.
  assert.ok(S.criticalPath(nodes, links, { type: 'fs', lagDays: 1 }).critical.has('B'));
  assert.deepEqual(S.variance({ start: '2026-01-01', end: '2026-01-05' }, { start: '2026-01-03', end: '2026-01-08' }), { start: 2, end: 3 });
});

test('docs: workspace docs, item Doc column, search, trash and cleaning', async () => {
  const api = await fresh();
  api.loadSample();
  const ws = api.bootstrap().workspaces[0];
  const id = api.saveDoc({ workspaceId: ws.id, title: 'Launch brief', html: '<h1>Goals</h1><p onclick="x()">Ship <b>v2</b></p><script>alert(1)</script><a href="javascript:alert(1)">x</a>' });
  const d = api.getDoc(id);
  assert.equal(d.title, 'Launch brief');
  assert.ok(!/script|onclick|javascript/i.test(d.html), d.html);
  assert.match(d.html, /<b>v2<\/b>/);
  assert.equal(api.bootstrap().docs.length, 2, 'the sample doc and the new one');
  assert.equal(api.search('launch brief')[0].kind, 'doc');
  api.saveDoc({ id, title: 'Brief' });
  assert.equal(api.getDoc(id).title, 'Brief');
  assert.match(api.getDoc(id).html, /Goals/);

  const b = ws.boards.find((x) => x.name === 'Website relaunch');
  const colId = api.addColumn(b.id, { type: 'doc', title: 'Spec' });
  const it = api.getBoard(b.id).items[0];
  const did = api.createItemDoc(it.id, colId);
  assert.equal(api.createItemDoc(it.id, colId), did);
  const B = api.getBoard(b.id);
  assert.equal(B.items[0].values[colId], did);
  assert.equal(B.docs[did].title, it.name);
  assert.equal(api.getDoc(did).item.id, it.id);
  assert.equal(api.bootstrap().docs.length, 2, 'item docs stay out of the sidebar');

  api.deleteDoc(id);
  assert.throws(() => api.getDoc(id), /no longer exists/);
  assert.match(api.undo(), /Deleted doc/);
  assert.equal(api.getDoc(id).title, 'Brief');
});

test('dashboard widgets: table, calendar and team ownership', async () => {
  const api = await fresh();
  api.loadSample();
  const d = api.getDashboard(api.bootstrap().dashboards[0].id);
  const w = (t) => d.widgets.find((x) => x.type === t);
  for (const t of ['table', 'calendar', 'teams']) assert.ok(w(t) && !w(t).error, t);
  assert.ok(w('table').data.items.length > 3);
  assert.ok(w('table').data.items.every((x) => !x.status || x.status.label !== 'Done'));
  assert.ok(w('calendar').data.items.every((x) => x.start <= x.end));
  const teams = w('teams').data.teams;
  assert.ok(teams.some((t) => t.name === 'Legal' && t.waiting > 0), JSON.stringify(teams));
});

test('portfolio and timesheets', async () => {
  const api = await fresh();
  api.loadSample();
  const P = api.portfolio();
  const web = P.find((b) => b.name === 'Website relaunch');
  assert.ok(web.items >= 6 && web.progress > 0 && web.start && web.end);
  assert.ok(['on_track', 'at_risk', 'off_track', 'done'].includes(web.health));
  api.setPortfolio(web.id, { health: 'off_track', note: 'Waiting on Legal' });
  let w2 = api.portfolio().find((b) => b.id === web.id);
  assert.equal(w2.health, 'off_track');
  assert.equal(w2.note, 'Waiting on Legal');
  api.setPortfolio(web.id, { health: null });
  w2 = api.portfolio().find((b) => b.id === web.id);
  assert.equal(w2.health, w2.autoHealth);

  const { addDays, today } = require('../src/core/util');
  const ts = api.timesheet({ from: addDays(today(), -10), to: today() });
  assert.ok(ts.entries.length > 3, 'sample time is logged');
  const tasks = api.bootstrap().workspaces[0].boards.find((b) => b.name === 'Team tasks');
  const B = api.getBoard(tasks.id);
  const tc = col(B, 'Time spent');
  const it = B.items[4];
  api.addTime(it.id, tc.id, { date: today(), minutes: 90, note: 'Call' });
  const mine = api.timesheet({ from: today(), to: today() }).entries.filter((e) => e.rowId === it.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].seconds, 5400);
  assert.equal(api.getBoard(tasks.id).items[4].values[tc.id].total, 5400);
  assert.match(api.timesheetCsv({ from: today(), to: today() }), /Call/);
  api.removeTime(it.id, tc.id, mine[0].index);
  assert.equal(api.getBoard(tasks.id).items[4].values[tc.id].total, 0);
  assert.throws(() => api.addTime(it.id, tc.id, { minutes: 0 }), /between/);
});

test('recurring items and item templates', async () => {
  const api = await fresh();
  api.loadSample();
  const R = require('../src/core/recurring');
  // Rules
  assert.equal(R.nextAfter({ every: 1, unit: 'day' }, '2026-03-10', '2026-03-01'), '2026-03-11');
  assert.equal(R.nextAfter({ every: 1, unit: 'week', weekdays: [1, 4] }, '2026-03-10', '2026-03-09'), '2026-03-12');
  assert.equal(R.nextAfter({ every: 2, unit: 'week', weekdays: [1] }, '2026-03-09', '2026-03-09'), '2026-03-23');
  assert.equal(R.nextAfter({ every: 1, unit: 'month' }, '2026-01-31', '2026-01-31'), '2026-02-28');
  assert.equal(R.describe({ every: 2, unit: 'week', weekdays: [1, 3] }), 'Every 2 weeks on Mon, Wed');

  const tasks = api.bootstrap().workspaces[0].boards.find((b) => b.name === 'Team tasks');
  let B = api.getBoard(tasks.id);
  const st = col(B, 'Status') || B.columns.find((c) => c.type === 'status');
  const due = B.columns.find((c) => c.type === 'date' && c.scope === 'item');
  const src = B.items[0];
  api.setValue(src.id, st.id, 'done');
  const r = api.setRecurrence(src.id, { every: 1, unit: 'week', start: today() });
  assert.equal(r.text, 'Every week');
  B = api.getBoard(tasks.id);
  const copies = B.items.filter((i) => i.name === src.name);
  assert.equal(copies.length, 2, 'a copy is made on the start day');
  const copy = copies.find((i) => i.id !== src.id);
  assert.notEqual(copy.values[st.id], 'done', 'status reset');
  if (due && src.values[due.id]) assert.equal(copy.values[due.id], today());
  assert.ok(B.recurring[src.id].next > today());
  api.runSchedule();
  assert.equal(api.getBoard(tasks.id).items.filter((i) => i.name === src.name).length, 2, 'no duplicate on the same day');
  api.runSchedule(addDays(today(), 7) + 'T12:00:00');
  assert.equal(api.getBoard(tasks.id).items.filter((i) => i.name === src.name).length, 3);
  api.clearRecurrence(src.id);
  assert.equal(api.getRecurrence(src.id), null);

  // Item templates keep values and subitems
  const web = api.bootstrap().workspaces[0].boards.find((b) => b.name === 'Website relaunch');
  const W = api.getBoard(web.id);
  const parent = W.items.find((i) => W.subitems.some((s) => s.parent_id === i.id));
  const nSubs = W.subitems.filter((s) => s.parent_id === parent.id).length;
  const tid = api.saveItemTemplate(parent.id, 'Phase template');
  assert.equal(api.getBoard(web.id).itemTemplates[0].name, 'Phase template');
  const nid = api.addItemFromTemplate(tid, {});
  const W2 = api.getBoard(web.id);
  assert.equal(W2.subitems.filter((s) => s.parent_id === nid).length, nSubs);
  assert.equal(W2.items.find((i) => i.id === nid).name, parent.name);
  api.deleteItemTemplate(tid);
  assert.equal(api.itemTemplates(web.id).length, 0);
});

test('import and export templates: template file, board file, CSV', async () => {
  const api = await fresh();
  api.loadSample();
  const ws = api.bootstrap().workspaces[0];
  const web = ws.boards.find((b) => b.name === 'Website relaunch');
  const tid = api.saveAsTemplate(web.id, { name: 'Launch plan', description: 'Phases', withItems: true });
  const file = api.exportTemplate(tid);
  assert.match(file, /boardenda\.template/);

  const other = await fresh();
  const t1 = await other.importTemplate({ name: 'Launch plan.boardenda-template.json', text: file });
  const T1 = other.userTemplates().find((t) => t.id === t1);
  assert.equal(T1.name, 'Launch plan');
  assert.equal(T1.description, 'Phases');
  const b1 = other.createBoard({ template: `user:${t1}` });
  assert.ok(other.getBoard(b1).items.length >= 6);

  const t2 = await other.importTemplate({ name: 'web.boardenda.json', text: api.exportBoardFile(web.id), withItems: false });
  assert.equal(other.getBoard(other.createBoard({ template: `user:${t2}` })).items.length, 0);

  const before = other.bootstrap().workspaces.flatMap((w) => w.boards).length;
  const csv = 'Name,Status,Owner,Due date,Group\nWrite brief,Done,Alex,2026-01-05,Plan\nReview,Working on it,Sam,2026-01-09,Do\n';
  const t3 = await other.importTemplate({ name: 'Content process.csv', bytes: Buffer.from(csv), withItems: true });
  assert.equal(other.bootstrap().workspaces.flatMap((w) => w.boards).length, before, 'scratch board removed');
  assert.equal(other.trash().length, 0, 'scratch board not left in the trash');
  const B3 = other.getBoard(other.createBoard({ template: `user:${t3}` }));
  assert.equal(B3.board.name, 'Content process');
  assert.equal(B3.items.length, 2);
  await assert.rejects(other.importTemplate({ name: 'x.json', text: '{"a":1}' }), /not a Boardenda/);
  other.renameTemplate(t3, { name: 'Content flow' });
  assert.ok(other.userTemplates().some((t) => t.name === 'Content flow'));
});

test('import: blank sheet, preview, column overrides, subitems, Word and text', async () => {
  const api = await fresh();
  const ExcelJS = require('exceljs');
  const sheet = await api.importSheet();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(sheet);
  assert.equal(wb.worksheets[0].name, 'Items');
  assert.ok(wb.worksheets.some((w) => w.name === 'How to fill this in'));
  await assert.rejects(api.importTable({ name: 'blank.xlsx', bytes: sheet }), /Only EXAMPLE rows/);
  // Fill in two rows plus a subitem
  const ws = wb.worksheets[0];
  const hdr = ws.getRow(1).values.slice(1);
  const at = (h) => hdr.indexOf(h) + 1;
  const add = (vals) => { const r = ws.addRow([]); for (const [h, v] of Object.entries(vals)) r.getCell(at(h)).value = v; };
  add({ Name: 'Kickoff call', Group: 'Week 1', Status: 'Done', Owner: 'Alex Morgan', Timeline: '2026-01-05 - 2026-01-07', 'Done?': 'Yes' });
  add({ Name: 'Send recap', 'Subitem of': 'Kickoff call', Status: 'Not started' });
  add({ Name: 'Pilot', Group: 'Week 2', Priority: 'High', 'Effort (hours)': '4' });
  const bytes = Buffer.from(await wb.xlsx.writeBuffer());
  const pv = await api.previewImport('filled.xlsx', bytes);
  assert.equal(pv.examples, 3);
  const types = Object.fromEntries(pv.columns.map((c) => [c.title, c.type]));
  assert.equal(types.Name, '__name');
  assert.equal(types['Subitem of'], '__parent');
  assert.equal(types.Timeline, 'timeline');
  const r = await api.importTable({ name: 'filled.xlsx', bytes, columns: pv.columns.map((c) => (c.title === 'Notes' ? { ...c, type: 'skip' } : c)) });
  const B = api.getBoard(r.boardId);
  assert.equal(B.items.length, 2);
  assert.equal(B.subitems.length, 1);
  const tl = B.columns.find((c) => c.title === 'Timeline');
  assert.deepEqual(B.items.find((i) => i.name === 'Kickoff call').values[tl.id], { start: '2026-01-05', end: '2026-01-07' });
  assert.ok(!B.columns.some((c) => c.title === 'Notes'), 'skipped column not created');
  assert.deepEqual(B.groups.map((g) => g.name).sort(), ['Week 1', 'Week 2']);
  // A board's own sheet uses its column titles
  const own = new ExcelJS.Workbook();
  await own.xlsx.load(await api.importSheet(r.boardId));
  assert.ok(own.worksheets[0].getRow(1).values.includes('Timeline'));
  // Text lists and outlines
  const { linesToRows } = require('../src/core/extract');
  assert.deepEqual(linesToRows(['- Draft agenda - Alex - 2026-03-02', '- Confirm attendees - Sam - 2026-03-03']).slice(1), [['Draft agenda', 'Alex', '2026-03-02'], ['Confirm attendees', 'Sam', '2026-03-03']]);
  assert.deepEqual(linesToRows(['Task\tOwner', 'A\tAlex', 'B\tSam'])[0], ['Task', 'Owner']);
  const txt = await api.previewImport('list.txt', Buffer.from('Plan venue\nSend invites\n'));
  assert.equal(txt.total, 2);
});

test('customer calls: agenda, notes, recurring series, actions to a board', async () => {
  const api = await fresh();
  api.loadSample();
  const sample = api.listMeetings({ customer: 'Northwind Traders' });
  assert.equal(sample.length, 2, 'sample calls');
  assert.ok(sample[0].actions[0].item, 'a sample action is on a board');
  for (const m of api.listMeetings()) api.deleteMeeting(m.id);
  const me = api.bootstrap().me.id;
  const crm = api.bootstrap().workspaces[0].boards.find((b) => b.name === 'Team tasks');
  const B = api.getBoard(crm.id);
  const about = B.items[0];
  const t = today();
  // A one-off call about an item, with an outside contact
  const id = api.createMeeting({ title: 'Kickoff call', customer: 'Acme', date: t, time: '14:30', itemId: about.id, attendees: [me], contacts: [{ name: 'Jo Client', email: 'jo@acme.test', company: 'Acme' }], agenda: '<p>Scope</p><script>x</script>' });
  let m = api.getMeeting(id);
  assert.equal(m.time, '14:30');
  assert.equal(m.contacts[0].company, 'Acme');
  assert.ok(!/script/.test(m.agenda));
  m = api.updateMeeting(id, { notes: '<p>They want phase 1 in March</p>', recap: '<p>Agreed scope</p>', status: 'held' });
  assert.ok(m.hasNotes && m.hasRecap);
  // Actions: owner and due, one added to a board as an item
  const a1 = api.addMeetingAction(id, { text: 'Send quote', owner: me, due: addDays(t, 2) });
  api.addMeetingAction(id, { text: 'Book follow-up', due: addDays(t, 5), boardId: crm.id });
  const itemId = api.meetingActionToItem(a1, { boardId: crm.id });
  const nb = api.getBoard(crm.id);
  const created = nb.items.find((i) => i.id === itemId);
  const people = nb.columns.find((c) => c.type === 'people' && c.scope === 'item');
  assert.deepEqual(created.values[people.id], [me]);
  assert.equal(nb.items.filter((i) => i.name === 'Book follow-up').length, 1, 'boardId on add creates the item');
  assert.equal(nb.nextActions[about.id].text, 'Send quote', 'next action shows on the item the call is about');
  assert.ok(api.myWork().some((w) => w.id === itemId), 'action owner sees it in My work');
  assert.equal(api.meetingActions({ mine: true })[0].text, 'Send quote');
  api.updateMeetingAction(a1, { done: true });
  assert.equal(api.getMeeting(id).actions.find((a) => a.id === a1).done, true);
  assert.equal(api.getItem(about.id).calls.nextAction.text, 'Book follow-up');
  assert.match(api.meetingSummary(id), /Action items:[\s\S]*\[x\] Send quote/);
  // Recurring weekly series: each meeting keeps its own notes
  const sid = api.createMeeting({ title: 'Weekly sync', customer: 'Acme', date: t, time: '10:00', agenda: '<p>Status</p>', repeat: { unit: 'week', every: 1 } });
  let series = api.listMeetings({ q: 'weekly sync' });
  assert.ok(series.length >= 8 && series.length <= 13, `series scheduled ahead (${series.length})`);
  assert.ok(series.every((x) => x.agenda === undefined && x.repeat === 'Every week'));
  const second = series[1];
  assert.equal(second.date, addDays(t, 7));
  api.updateMeeting(second.id, { notes: '<p>Week 2 notes</p>' });
  assert.ok(!api.getMeeting(series[2].id).hasNotes, 'notes are per meeting');
  api.updateMeeting(sid, { time: '11:00', agenda: '<p>New agenda</p>' });
  assert.equal(api.applyMeetingToSeries(sid), series.length - 2, 'later empty meetings follow; ones with notes are kept');
  assert.equal(api.getMeeting(series[3].id).time, '11:00');
  assert.equal(api.getMeeting(second.id).time, '10:00');
  api.stopMeetingRepeat(second.id);
  series = api.listMeetings({ q: 'weekly sync' });
  assert.equal(series.length, 2);
  api.runSchedule(addDays(t, 30) + 'T12:00:00');
  assert.equal(api.listMeetings({ q: 'weekly sync' }).length, 2, 'a stopped series stays stopped');
  // Calendar and customers
  const cal = api.calendar({ from: t, to: addDays(t, 7) });
  assert.ok(cal.entries.some((e) => e.meetingId === id && e.time === '14:30'));
  assert.equal(api.meetingCustomers()[0].name, 'Acme');
  assert.equal(api.deleteMeeting(sid, { series: true }), 2);
});

test('quick capture: built-in reader proposes records, flags unsure ones, and creates them', async () => {
  const api = await fresh();
  api.loadSample();
  const P = require('../src/core/capture');
  assert.equal(P.parseDate('tomorrow', '2026-11-05'), '2026-11-06');
  assert.equal(P.parseDate('by Friday', '2026-11-05'), '2026-11-06');
  assert.equal(P.parseDate('Nov 12', '2026-11-05'), '2026-11-12');
  assert.equal(P.parseDate('in 2 weeks', '2026-11-05'), '2026-11-19');
  assert.equal(P.parseTime('2:30pm'), '14:30');
  assert.equal(api.aiStatus().hasKey, false);
  const call = await api.readNotes({ text: 'Call with Northwind Traders 11/10 2pm\nThey want quarterly billing.\n- Jordan to send revised quote by Friday\n- TODO: book a demo next week' });
  assert.equal(call.mode, 'basic');
  const [m, a1, a2] = call.records;
  assert.equal(m.kind, 'meeting');
  assert.equal(m.title, 'Call with Northwind Traders');
  assert.equal(m.time, '14:00');
  assert.ok(m.itemId, 'linked to the existing deal');
  assert.equal(a1.kind, 'action');
  assert.equal(a1.meetingRef, m.key);
  assert.ok(a1.owner && a1.due);
  assert.equal(a2.owner, null);
  const list = await api.readNotes({ text: '- Export button crashes on Windows\n- Write a blog post about the relaunch\n- Something vague' });
  assert.equal(list.records.length, 3);
  const vague = list.records[2];
  assert.ok(vague.needsMapping && vague.question, 'unsure records ask the user');
  assert.throws(() => api.applyNotes({ records: list.records }), /Choose a board/);
  const tasks = api.bootstrap().workspaces[0].boards.find((b) => b.name === 'Team tasks');
  vague.boardId = tasks.id;
  const made = api.applyNotes({ records: list.records });
  assert.equal(made.item, 3);
  assert.ok(api.getBoard(tasks.id).items.some((i) => i.name === 'Something vague'));
  const m2 = api.applyNotes({ records: call.records, text: call.text });
  assert.deepEqual([m2.meeting, m2.action], [1, 2]);
  const meeting = api.listMeetings({ q: 'quarterly billing' })[0];
  assert.equal(meeting.actions.length, 2);
});

test('quick capture: reads notes with a local Ollama model, and only local servers are allowed', async () => {
  const http = require('http');
  let body = null;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'nomic-embed-text' }, { name: 'llama3.2:3b' }] }));
      body = JSON.parse(b);
      const rec = { kind: 'item', title: 'Fix export crash', board: 'Bug tracker', group: '', existingItem: '', customer: '', date: '', time: '', owner: 'Sam', due: 'tomorrow', fields: [], notes: '', meetingIndex: -1, confidence: 0.9, question: '' };
      res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify({ records: [rec] }) }, done: true }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const api = await fresh();
    api.loadSample();
    assert.throws(() => api.setAi({ localUrl: 'https://example.com' }), /privacy/);
    api.setAi({ provider: 'ollama', localUrl: `http://127.0.0.1:${srv.address().port}` });
    assert.equal((await api.testAi()).model, 'llama3.2:3b', 'prefers an installed Llama model');
    const r = await api.readNotes({ text: '- export crashes, Sam to fix tomorrow' });
    assert.equal(r.mode, 'local');
    assert.equal(body.model, 'llama3.2:3b');
    assert.equal(body.format.type, 'object', 'asks Ollama for the record schema');
    const [rec] = r.records;
    assert.equal(api.getBoard(rec.boardId).board.name, 'Bug tracker');
    assert.equal(rec.due, addDays(today(), 1));
    assert.ok(rec.owner);
    srv.close();
    const fb = await api.readNotes({ text: '- export crashes' });
    assert.equal(fb.mode, 'basic', 'falls back to the built-in reader when the server is down');
    assert.match(fb.notes.join(' '), /local model/);
  } finally { srv.close(); }
});

test('customer directory: profiles, contacts, devices, Customer column, calls, import and delete', async () => {
  const api = await fresh();
  const ws = api.saveWorkspace({ name: 'Accounts' });
  const board = api.createBoard({ workspaceId: ws, name: 'Service', template: 'blank' });
  const id = api.saveCustomer({ name: 'Acme Health', status: 'active', phone: '555 1000', accountNo: 'AC-1', tags: 'vip, east' });
  assert.throws(() => api.saveCustomer({ name: 'acme health' }), /already exists/);
  const k1 = api.saveCustomerContact(id, { name: 'Jo Park', title: 'CIO', email: 'jo@acme.test' });
  api.saveCustomerContact(id, { name: 'Ray Diaz', phone: '555 1001', primary: true });
  api.saveCustomerDevice(id, { name: 'Lobby kiosk', model: 'K-9', serial: 'SN123', status: 'repair' });
  let c = api.getCustomer(id);
  assert.deepEqual(c.tags, ['vip', 'east']);
  assert.equal(c.contacts[0].name, 'Ray Diaz', 'the main contact comes first');
  assert.equal(c.contacts.filter((x) => x.primary).length, 1);
  assert.equal(c.devices[0].serial, 'SN123');
  assert.equal(c.devices[0].status, 'repair');
  api.removeCustomerContact(k1);
  // Assign to a task: adds the Customer column on first use.
  const item = api.addItem(board, { name: 'Replace kiosk screen' });
  const colId = api.assignCustomer(item, id);
  const B = api.getBoard(board);
  assert.equal(B.columns.find((x) => x.id === colId).type, 'customer');
  assert.ok(B.customers.some((x) => x.id === id));
  c = api.getCustomer(id);
  assert.equal(c.tasks.length, 1);
  assert.equal(c.tasks[0].name, 'Replace kiosk screen');
  // Calls are matched by name, follow a rename, and new call customers join the directory.
  api.createMeeting({ title: 'Quarterly review', customer: 'Acme Health', date: today(), time: '10:00' });
  api.createMeeting({ title: 'Intro call', customer: 'Globex', date: today(), time: '11:00' });
  assert.ok(api.listCustomers().some((x) => x.name === 'Globex'));
  api.saveCustomer({ id, name: 'Acme Healthcare' });
  c = api.getCustomer(id);
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].customer, 'Acme Healthcare');
  const row = api.listCustomers({ q: 'sn123' });
  assert.equal(row.length, 1, 'search finds a customer by device serial');
  assert.equal(row[0].openTasks, 1);
  assert.equal(row[0].calls, 1);
  assert.ok(api.search('Acme').some((r) => r.kind === 'customer'));
  assert.match(api.customerSummary(id), /Lobby kiosk/);
  // Import: a Customer header becomes a Customer column and unknown names are added.
  const csv = Buffer.from('Name,Customer\nFix printer,Acme Healthcare\nNew site survey,Initech\n');
  const prev = await api.previewImport('jobs.csv', csv);
  assert.equal(prev.columns.find((x) => x.title === 'Customer').type, 'customer');
  const r = await api.importTable({ name: 'jobs.csv', bytes: csv, columns: prev.columns, workspaceId: ws });
  const IB = api.getBoard(r.boardId);
  const icol = IB.columns.find((x) => x.type === 'customer');
  const initech = api.listCustomers({ q: 'Initech' })[0];
  assert.ok(initech, 'unknown customer added to the directory');
  assert.deepEqual(IB.items.find((x) => x.name === 'New site survey').values[icol.id], [initech.id]);
  assert.equal(api.getCustomer(id).tasks.length, 2);
  // Delete clears the value from items.
  api.deleteCustomer(id);
  assert.equal(api.store.getBoard(board).items.find((x) => x.id === item).values[colId], undefined);
});

test('customers from a pasted email, and customer import with merging', async () => {
  const api = await fresh();
  const mail = `From: Anthony Acosta <anthony.acosta@ingenico-partners.com>
To: Me <me@example.org>
Cc: Sara Kim <sara.kim@ingenico-partners.com>
Subject: RX3

Hi, devices are on the way.

Thanks,
Anthony Acosta
Senior Certification Manager | Ingenico Partners LLC
1200 Market Street, Suite 400
Philadelphia, PA 19107
O: (215) 555-0134 | M: 215.555.0199
www.ingenico-partners.com`;
  const r = await api.readCustomerText({ text: mail });
  assert.equal(r.mode, 'basic');
  assert.equal(r.customer.name, 'Ingenico Partners LLC');
  assert.match(r.customer.address, /1200 Market Street.*19107/);
  const a = r.contacts[0];
  assert.deepEqual([a.name, a.title, a.email, a.phone, a.mobile], ['Anthony Acosta', 'Senior Certification Manager', 'anthony.acosta@ingenico-partners.com', '(215) 555-0134', '215.555.0199']);
  assert.equal(r.contacts.find((k) => k.email === 'me@example.org').include, false, 'other companies are left out');
  assert.equal(r.contacts.find((k) => k.name === 'Sara Kim').include, true);
  assert.equal(r.match, null);
  const id = api.createCustomerFromText({ customer: r.customer, contacts: r.contacts, keepText: true, text: mail });
  const c = api.getCustomer(id);
  assert.equal(c.contacts.length, 2);
  assert.equal(c.contacts[0].name, 'Anthony Acosta');
  assert.match(c.notes, /Pasted/);
  // A second paste from the same company is matched by email domain.
  const r2 = await api.readCustomerText({ text: 'Lee Wong\nField Engineer\nlee.wong@ingenico-partners.com\nMobile +1 555 0201' });
  assert.equal(r2.match && r2.match.id, id);
  assert.equal(r2.contacts[0].mobile, '+1 555 0201');
  api.createCustomerFromText({ customerId: id, customer: r2.customer, contacts: r2.contacts });
  assert.equal(api.getCustomer(id).contacts.length, 3);
  // Import: the blank sheet's EXAMPLE rows are skipped; rows merge by customer name.
  const sheet = await api.customerImportSheet();
  const pv = await api.previewCustomerImport('sheet.xlsx', sheet);
  assert.equal(pv.columns.find((x) => x.title === 'Serial number').field, 'deviceSerial');
  assert.equal(api.importCustomers({ rows: pv.rows, columns: pv.columns }).created, 0);
  const csv = Buffer.from('Company,First Name,Last Name,Email,Mobile,Serial,Model\nIngenico Partners LLC,Sara,Kim,sara.kim@ingenico-partners.com,555 1111,SN-1,RX3\nGlobex,Hank,Scorpio,hank@globex.test,,SN-9,K2\nGlobex,Lisa,Ray,lisa@globex.test,,,\n');
  const pc = await api.previewCustomerImport('list.csv', csv);
  assert.deepEqual(pc.columns.map((x) => x.field), ['name', 'contactFirst', 'contactLast', 'contactEmail', 'contactMobile', 'deviceSerial', 'deviceModel']);
  const s = api.importCustomers({ rows: pc.rows, columns: pc.columns });
  assert.deepEqual([s.created, s.updated, s.contacts, s.devices], [1, 1, 2, 2]);
  const ing = api.getCustomer(id);
  assert.equal(ing.contacts.length, 3, 'existing contact updated, not duplicated');
  assert.equal(ing.contacts.find((k) => k.name === 'Sara Kim').mobile, '555 1111');
  assert.equal(ing.devices[0].serial, 'SN-1');
  const vcf = Buffer.from('BEGIN:VCARD\nVERSION:3.0\nFN:Ola Nord\nORG:Nordic Foods;\nTITLE:Buyer\nEMAIL;TYPE=WORK:ola@nordic.test\nTEL;TYPE=CELL:+47 555 01 234\nEND:VCARD\n');
  const pvv = await api.previewCustomerImport('cards.vcf', vcf);
  api.importCustomers({ rows: pvv.rows, columns: pvv.columns });
  const nf = api.listCustomers({ q: 'Nordic Foods' })[0];
  assert.equal(api.getCustomer(nf.id).contacts[0].mobile, '+47 555 01 234');
});
