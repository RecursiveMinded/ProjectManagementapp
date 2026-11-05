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
