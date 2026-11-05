'use strict';
// Board templates and the sample workspace. Templates reference columns and
// groups by title; build() resolves them to ids once the board exists.

const { today, addDays } = require('./util');

const L = (id, label, color, done) => ({ id, label, color, ...(done ? { done: true } : {}) });

const TEMPLATES = {
  blank: {
    name: 'Blank board', description: 'Start from an empty board with the essentials.',
    groups: [{ name: 'Group 1', color: 'ocean' }, { name: 'Group 2', color: 'mint' }],
    columns: [{ title: 'Owner', type: 'people' }, { title: 'Status', type: 'status' }, { title: 'Due date', type: 'date' }],
    views: [{ name: 'Main table', type: 'table' }],
  },
  project: {
    name: 'Project plan', description: 'Phases, owners, timelines, dependencies and budget for a project.', itemNoun: 'task',
    groups: [{ name: 'Planning', color: 'indigo' }, { name: 'Execution', color: 'tangerine' }, { name: 'Launch', color: 'mint' }],
    columns: [
      { title: 'Owner', type: 'people' },
      { title: 'Team', type: 'team' },
      { title: 'Status', type: 'status' },
      { title: 'Priority', type: 'priority' },
      { title: 'Timeline', type: 'timeline' },
      { title: 'Depends on', type: 'dependency', settings: { dateColumnTitle: 'Timeline', mode: 'flexible', type: 'fs' } },
      { title: 'Waiting on team', type: 'team', settings: { role: 'waiting' }, description: 'Teams this task depends on. Recorded only: nobody is contacted.' },
      { title: 'Effort (h)', type: 'numbers', settings: { unit: 'h', summary: 'sum' } },
      { title: 'Budget', type: 'numbers', settings: { unit: '$', unitSide: 'left', summary: 'sum' } },
      { title: 'Spent', type: 'numbers', settings: { unit: '$', unitSide: 'left', summary: 'sum' } },
      { title: 'Budget check', type: 'formula', settings: { expr: 'IF({Spent} > {Budget}, "Over budget", IF({Budget} > 0, "On budget", ""))' } },
      { title: 'Progress', type: 'progress' },
      { title: 'Files', type: 'files' },
    ],
    subColumns: [{ title: 'Owner', type: 'people' }, { title: 'Status', type: 'status' }, { title: 'Due date', type: 'date' }],
    views: [
      { name: 'Main table', type: 'table' },
      { name: 'Gantt', type: 'timeline', config: { dateColumnTitle: 'Timeline', zoom: 'week' } },
      { name: 'Kanban', type: 'kanban', config: { columnTitle: 'Status' } },
      { name: 'Workload', type: 'workload', config: { peopleColumnTitle: 'Owner', dateColumnTitle: 'Timeline', effortColumnTitle: 'Effort (h)' } },
    ],
    automations: [
      { name: 'Done moves to Launch', recipe: { trigger: { type: 'status_changed', column: 'Status', to: 'done' }, actions: [{ type: 'move_to_group', group: 'Launch' }] } },
      { name: 'Remind owner before the end date', recipe: { trigger: { type: 'date_arrives', column: 'Timeline', edge: 'end', offset: -1, at: '09:00' }, conditions: [{ column: 'Status', op: 'is_not', value: 'done' }], actions: [{ type: 'notify', to: 'column:Owner', message: '{name} is due tomorrow' }] } },
      { name: 'Subitems done completes the task', recipe: { trigger: { type: 'subitems_done', column: 'sub:Status' }, actions: [{ type: 'set_parent', column: 'Status', value: 'done' }] } },
    ],
  },
  tasks: {
    name: 'Team tasks', description: 'A simple shared to-do board for a team.', itemNoun: 'task',
    groups: [{ name: 'This week', color: 'ocean' }, { name: 'Next week', color: 'grape' }, { name: 'Done', color: 'mint' }],
    columns: [
      { title: 'Owner', type: 'people' }, { title: 'Status', type: 'status' }, { title: 'Priority', type: 'priority' },
      { title: 'Due date', type: 'date' }, { title: 'Tags', type: 'tags' }, { title: 'Time spent', type: 'time_tracking' }, { title: 'Notes', type: 'long_text' },
    ],
    views: [{ name: 'Main table', type: 'table' }, { name: 'Kanban', type: 'kanban', config: { columnTitle: 'Status' } }, { name: 'Calendar', type: 'calendar', config: { dateColumnTitle: 'Due date' } }],
    automations: [
      { name: 'Creator owns new tasks', recipe: { trigger: { type: 'item_created' }, conditions: [{ column: 'Owner', op: 'empty' }], actions: [{ type: 'assign', column: 'Owner', person: 'creator' }] } },
      { name: 'Done moves to Done', recipe: { trigger: { type: 'status_changed', column: 'Status', to: 'done' }, actions: [{ type: 'move_to_group', group: 'Done' }] } },
      { name: 'Overdue tasks are flagged', recipe: { trigger: { type: 'date_arrives', column: 'Due date', offset: 1, at: '08:00' }, conditions: [{ column: 'Status', op: 'is_not', value: 'done' }], actions: [{ type: 'set_value', column: 'Status', value: 'stuck' }, { type: 'notify', to: 'column:Owner', message: '{name} is overdue' }] } },
    ],
  },
  crm: {
    name: 'Sales pipeline', description: 'Deals by stage with value, probability and forecast.', itemNoun: 'deal',
    groups: [{ name: 'Active deals', color: 'ocean' }, { name: 'Won', color: 'mint' }, { name: 'Lost', color: 'coral' }],
    columns: [
      { title: 'Stage', type: 'status', settings: { labels: [L('lead', 'Lead', 'stone'), L('qualified', 'Qualified', 'sky'), L('proposal', 'Proposal', 'indigo'), L('negotiation', 'Negotiation', 'tangerine'), L('won', 'Won', 'mint', true), L('lost', 'Lost', 'coral')] } },
      { title: 'Owner', type: 'people' },
      { title: 'Deal value', type: 'numbers', settings: { unit: '$', unitSide: 'left', summary: 'sum' } },
      { title: 'Probability', type: 'numbers', settings: { unit: '%', summary: 'avg' } },
      { title: 'Forecast', type: 'formula', settings: { expr: 'ROUND({Deal value} * {Probability} / 100, 0)' } },
      { title: 'Close date', type: 'date' },
      { title: 'Contact email', type: 'email' }, { title: 'Phone', type: 'phone' }, { title: 'Country', type: 'country' },
      { title: 'Last touch', type: 'last_updated' },
    ],
    views: [{ name: 'Main table', type: 'table' }, { name: 'Pipeline', type: 'kanban', config: { columnTitle: 'Stage' } }, { name: 'Forecast chart', type: 'chart', config: { chart: 'bar', groupByTitle: 'Stage', measure: 'sum', valueTitle: 'Deal value' } }, { name: 'Lead form', type: 'form' }],
    automations: [
      { name: 'Won deals move to Won', recipe: { trigger: { type: 'status_changed', column: 'Stage', to: 'won' }, actions: [{ type: 'move_to_group', group: 'Won' }, { type: 'set_value', column: 'Probability', value: 100 }] } },
      { name: 'Lost deals move to Lost', recipe: { trigger: { type: 'status_changed', column: 'Stage', to: 'lost' }, actions: [{ type: 'move_to_group', group: 'Lost' }, { type: 'set_value', column: 'Probability', value: 0 }] } },
    ],
  },
  bugs: {
    name: 'Bug tracker', description: 'Report, triage and fix bugs.', itemNoun: 'bug',
    groups: [{ name: 'New reports', color: 'coral' }, { name: 'In progress', color: 'tangerine' }, { name: 'Fixed', color: 'mint' }],
    columns: [
      { title: 'Severity', type: 'priority' },
      { title: 'Status', type: 'status', settings: { labels: [L('new', 'New', 'stone'), L('triaged', 'Triaged', 'sky'), L('fixing', 'Fixing', 'tangerine'), L('testing', 'Testing', 'indigo'), L('fixed', 'Fixed', 'mint', true), L('wontfix', "Won't fix", 'slate', true)] } },
      { title: 'Assignee', type: 'people' }, { title: 'Reported by', type: 'creation_log' }, { title: 'Platform', type: 'dropdown', settings: { options: [{ id: 'win', label: 'Windows' }, { id: 'mac', label: 'macOS' }, { id: 'web', label: 'Web' }, { id: 'mobile', label: 'Mobile' }] } },
      { title: 'Version', type: 'text' }, { title: 'Steps', type: 'long_text' }, { title: 'Bug ID', type: 'item_id' }, { title: 'Votes', type: 'vote' },
    ],
    views: [{ name: 'Main table', type: 'table' }, { name: 'Board', type: 'kanban', config: { columnTitle: 'Status' } }, { name: 'Report a bug', type: 'form' }],
    automations: [{ name: 'Fixed bugs move to Fixed', recipe: { trigger: { type: 'status_changed', column: 'Status', to: 'fixed' }, actions: [{ type: 'move_to_group', group: 'Fixed' }] } }],
  },
  content: {
    name: 'Content calendar', description: 'Plan, write and publish content by channel.', itemNoun: 'post',
    groups: [{ name: 'Ideas', color: 'sun' }, { name: 'In production', color: 'grape' }, { name: 'Published', color: 'mint' }],
    columns: [
      { title: 'Writer', type: 'people' },
      { title: 'Status', type: 'status', settings: { labels: [L('idea', 'Idea', 'stone'), L('draft', 'Drafting', 'tangerine'), L('edit', 'Editing', 'indigo'), L('sched', 'Scheduled', 'sky'), L('pub', 'Published', 'mint', true)] } },
      { title: 'Channel', type: 'dropdown', settings: { options: [{ id: 'blog', label: 'Blog' }, { id: 'news', label: 'Newsletter' }, { id: 'social', label: 'Social' }, { id: 'video', label: 'Video' }] } },
      { title: 'Publish date', type: 'date' }, { title: 'Link', type: 'link' }, { title: 'Rating', type: 'rating' },
    ],
    views: [{ name: 'Main table', type: 'table' }, { name: 'Calendar', type: 'calendar', config: { dateColumnTitle: 'Publish date' } }, { name: 'Kanban', type: 'kanban', config: { columnTitle: 'Status' } }],
    automations: [{ name: 'Published posts move to Published', recipe: { trigger: { type: 'status_changed', column: 'Status', to: 'pub' }, actions: [{ type: 'move_to_group', group: 'Published' }] } }],
  },
};

/** Create a board from a template. Returns the board id. */
function build(store, automations, key, { workspaceId, name, sample = false } = {}) {
  const t = TEMPLATES[key] || TEMPLATES.blank;
  let boardId;
  store.db.tx(() => {
    boardId = store.createBoard({ workspaceId, name: name || t.name, description: t.description, itemNoun: t.itemNoun || 'item', groups: t.groups, columns: [], views: [] });
    const titles = {};
    for (const c of t.columns) {
      const s = { ...(c.settings || {}) };
      delete s.dateColumnTitle;
      titles[c.title] = store.addColumn(boardId, { title: c.title, type: c.type, settings: s, description: c.description || '' });
    }
    for (const c of t.subColumns || []) titles[`sub:${c.title}`] = store.addColumn(boardId, { title: c.title, type: c.type, scope: 'sub', settings: c.settings });
    for (const c of t.columns) if (c.settings && c.settings.dateColumnTitle) store.updateColumn(titles[c.title], { settings: { dateColumn: titles[c.settings.dateColumnTitle] } });
    const groups = Object.fromEntries(store.db.all('SELECT id, name FROM groups WHERE board_id=?', [boardId]).map((g) => [g.name, g.id]));
    for (const v of t.views) store.saveView(boardId, { name: v.name, type: v.type, config: resolveConfig(v.config || {}, titles) });
    for (const a of t.automations || []) automations.save(boardId, { name: a.name, recipe: resolveRecipe(a.recipe, titles, groups) });
    if (sample) {
      store.muted = true; // sample data should not trip the board's automations
      try { fillSample(store, boardId, key, titles, groups); } finally { store.muted = false; }
    }
  });
  return boardId;
}

function resolveConfig(cfg, titles) {
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k.endsWith('Title')) out[k.replace(/Title$/, '')] = titles[v] || '';
    else out[k] = v;
  }
  return out;
}
function resolveRecipe(r, titles, groups) {
  const fix = (o) => {
    const x = { ...o };
    if (x.column) x.column = titles[x.column] || x.column;
    if (x.group) x.group = groups[x.group] || x.group;
    if (typeof x.to === 'string' && x.to.startsWith('column:')) x.to = `column:${titles[x.to.slice(7)] || x.to.slice(7)}`;
    return x;
  };
  return { trigger: fix(r.trigger), conditions: (r.conditions || []).map(fix), actions: r.actions.map(fix) };
}

function fillSample(store, boardId, key, T, G) {
  const ppl = store.people();
  const P = (i) => [ppl[i % ppl.length].id];
  const d = (n) => addDays(today(), n);
  const tl = (a, b) => ({ start: d(a), end: d(b) });
  const add = (g, name, values, subs) => {
    const vals = {};
    for (const [k, v] of Object.entries(values)) if (T[k]) vals[T[k]] = v;
    const id = store.addItem(boardId, { groupId: G[g], name, values: vals, source: 'sample' });
    for (const s of subs || []) {
      const sv = {};
      for (const [k, v] of Object.entries(s.values || {})) if (T[`sub:${k}`]) sv[T[`sub:${k}`]] = v;
      store.addItem(boardId, { parentId: id, name: s.name, values: sv, source: 'sample' });
    }
    return id;
  };
  const TM = (...names) => names.map((n) => store.teamByName(n, true).id);
  if (key === 'project') {
    const a = add('Planning', 'Define goals and scope', { Owner: P(0), Team: TM('Product'), Status: 'done', Priority: 'high', Timeline: tl(-14, -10), 'Effort (h)': 12, Budget: 2000, Spent: 1800 });
    const b = add('Planning', 'Research users', { Owner: P(1), Team: TM('Design'), Status: 'done', Priority: 'medium', Timeline: tl(-9, -4), 'Effort (h)': 20, Budget: 3000, Spent: 3400 },
      [{ name: 'Interview 5 customers', values: { Status: 'done', Owner: P(1) } }, { name: 'Summarise findings', values: { Status: 'done', Owner: P(0) } }]);
    const c = add('Execution', 'Design the solution', { Owner: P(2), Team: TM('Design'), Status: 'working', Priority: 'high', Timeline: tl(-3, 4), 'Effort (h)': 30, Budget: 5000, Spent: 2100 },
      [{ name: 'Wireframes', values: { Status: 'done', Owner: P(2) } }, { name: 'Visual design', values: { Status: 'working', Owner: P(2), 'Due date': d(2) } }, { name: 'Design review', values: { Status: 'todo', Owner: P(0), 'Due date': d(4) } }]);
    const e = add('Execution', 'Build first release', { Owner: P(3), Team: TM('Engineering'), 'Waiting on team': TM('IT Security'), Status: 'todo', Priority: 'critical', Timeline: tl(5, 18), 'Effort (h)': 80, Budget: 12000 });
    const f = add('Execution', 'Test with pilot customers', { Owner: P(1), Team: TM('Product'), Status: 'todo', Priority: 'medium', Timeline: tl(19, 25), 'Effort (h)': 24, Budget: 1500 });
    add('Launch', 'Launch announcement', { Owner: P(0), Team: TM('Product'), 'Waiting on team': TM('Legal'), Status: 'todo', Priority: 'low', Timeline: tl(26, 28), 'Effort (h)': 6, Budget: 800 });
    for (const [x, y] of [[b, a], [c, b], [e, c], [f, e]]) store.setValue(x, T['Depends on'], [y], { source: 'sample', noDeps: true });
  } else if (key === 'tasks') {
    add('This week', 'Prepare weekly report', { Owner: P(0), Status: 'working', Priority: 'high', 'Due date': d(1), Tags: ['reporting'] });
    add('This week', 'Review vendor contract', { Owner: P(1), Status: 'stuck', Priority: 'critical', 'Due date': d(-1), Tags: ['legal'] });
    add('This week', 'Update onboarding guide', { Owner: P(2), Status: 'todo', Priority: 'medium', 'Due date': d(3), Tags: ['docs'] });
    add('Next week', 'Plan team offsite', { Owner: P(3), Status: 'todo', Priority: 'low', 'Due date': d(9) });
    add('Done', 'Order new laptops', { Owner: P(0), Status: 'done', Priority: 'medium', 'Due date': d(-4) });
  } else if (key === 'crm') {
    add('Active deals', 'Northwind Traders', { Stage: 'proposal', Owner: P(0), 'Deal value': 48000, Probability: 50, 'Close date': d(20), 'Contact email': 'buyer@northwind.example', Country: 'US' });
    add('Active deals', 'Contoso Health', { Stage: 'negotiation', Owner: P(1), 'Deal value': 125000, Probability: 70, 'Close date': d(12), Country: 'CA' });
    add('Active deals', 'Fabrikam Studio', { Stage: 'qualified', Owner: P(2), 'Deal value': 18000, Probability: 25, 'Close date': d(45), Country: 'GB' });
    add('Active deals', 'Tailspin Air', { Stage: 'lead', Owner: P(0), 'Deal value': 64000, Probability: 10, 'Close date': d(70), Country: 'DE' });
    add('Won', 'Adventure Works', { Stage: 'won', Owner: P(1), 'Deal value': 36000, Probability: 100, 'Close date': d(-6), Country: 'AU' });
    add('Lost', 'Wide World Importers', { Stage: 'lost', Owner: P(3), 'Deal value': 22000, Probability: 0, 'Close date': d(-15), Country: 'NZ' });
  } else if (key === 'bugs') {
    add('New reports', 'Export button does nothing', { Severity: 'high', Status: 'new', Platform: ['win'], Version: '2.4.1' });
    add('In progress', 'Dark mode contrast on charts', { Severity: 'low', Status: 'fixing', Assignee: P(2), Platform: ['web', 'mac'], Version: '2.4.0' });
    add('Fixed', 'Crash when opening an empty board', { Severity: 'critical', Status: 'fixed', Assignee: P(3), Platform: ['win'], Version: '2.3.9' });
  } else if (key === 'content') {
    add('Ideas', '10 lessons from our first year', { Status: 'idea', Channel: ['blog'] });
    add('In production', 'November newsletter', { Writer: P(1), Status: 'draft', Channel: ['news'], 'Publish date': d(5) });
    add('In production', 'Product walkthrough video', { Writer: P(2), Status: 'edit', Channel: ['video', 'social'], 'Publish date': d(11) });
    add('Published', 'Customer story: Contoso', { Writer: P(0), Status: 'pub', Channel: ['blog', 'social'], 'Publish date': d(-8), Rating: 4, Link: { url: 'https://example.com/contoso', text: 'Read it' } });
  }
}

/** The first-run sample: a team, a workspace with several boards and a dashboard. */
function sampleWorkspace(store, automations, dashboards) {
  let ws;
  store.db.tx(() => {
    const me = store.me();
    if (me.name === 'Me') store.savePerson({ id: me.id, name: 'Alex Morgan', email: 'alex@example.com', team: 'Product', color: me.color, capacity: 40 });
    if (store.people().length < 4) {
      store.savePerson({ name: 'Jordan Lee', email: 'jordan@example.com', team: 'Design', capacity: 40 });
      store.savePerson({ name: 'Sam Patel', email: 'sam@example.com', team: 'Engineering', capacity: 32 });
      store.savePerson({ name: 'Riley Chen', email: 'riley@example.com', team: 'Engineering', capacity: 40 });
    }
    if (!store.teamByName('Legal')) store.saveTeam({ name: 'Legal', color: 'slate', external: true, description: 'Reviews launch copy, terms and contracts. Not in Boardenda.' });
    if (!store.teamByName('IT Security')) store.saveTeam({ name: 'IT Security', color: 'night', external: true, description: 'Approves new systems before go-live. Not in Boardenda.' });
    ws = store.saveWorkspace({ name: 'Sample workspace', color: 'indigo' });
    const project = build(store, automations, 'project', { workspaceId: ws, name: 'Website relaunch', sample: true });
    const tasks = build(store, automations, 'tasks', { workspaceId: ws, name: 'Team tasks', sample: true });
    const crm = build(store, automations, 'crm', { workspaceId: ws, name: 'Sales pipeline', sample: true });
    build(store, automations, 'content', { workspaceId: ws, name: 'Content calendar', sample: true });
    build(store, automations, 'bugs', { workspaceId: ws, name: 'Bug tracker', sample: true });
    const dash = dashboards.save({ name: 'Company overview', boardIds: [project, tasks, crm] });
    const col = (b, t) => (store.columns(b).find((c) => c.title === t) || {}).id;
    dashboards.saveWidget(dash, { type: 'numbers', title: 'Pipeline value', size: 's', config: { boardIds: [crm], column: col(crm, 'Deal value'), fn: 'sum' } });
    dashboards.saveWidget(dash, { type: 'numbers', title: 'Forecast', size: 's', config: { boardIds: [crm], column: col(crm, 'Forecast'), fn: 'sum' } });
    dashboards.saveWidget(dash, { type: 'battery', title: 'Project progress', size: 's', config: { boardIds: [project, tasks] } });
    dashboards.saveWidget(dash, { type: 'numbers', title: 'Open tasks', size: 's', config: { boardIds: [project, tasks], fn: 'count', notDone: true } });
    dashboards.saveWidget(dash, { type: 'chart', title: 'Work by status', size: 'm', config: { boardIds: [project, tasks], chart: 'pie', groupBy: 'status' } });
    dashboards.saveWidget(dash, { type: 'chart', title: 'Deals by stage', size: 'm', config: { boardIds: [crm], chart: 'bar', groupBy: col(crm, 'Stage'), measure: 'sum', value: col(crm, 'Deal value') } });
    dashboards.saveWidget(dash, { type: 'workload', title: 'Team workload', size: 'l', config: { boardIds: [project, tasks] } });
    dashboards.saveWidget(dash, { type: 'list', title: 'Due in the next 14 days', size: 'm', config: { boardIds: [project, tasks, crm], dueWithin: 14 } });
    dashboards.saveWidget(dash, { type: 'timeline', title: 'Project timeline', size: 'l', config: { boardIds: [project] } });
    dashboards.saveWidget(dash, { type: 'countdown', title: 'Launch day', size: 's', config: { date: addDays(today(), 28) } });
    dashboards.saveWidget(dash, { type: 'teams', title: 'Who owns what, who we wait on', size: 'm', config: { boardIds: [project] } });
    dashboards.saveWidget(dash, { type: 'calendar', title: 'This month', size: 'm', config: { boardIds: [project, tasks] } });
    dashboards.saveWidget(dash, { type: 'table', title: 'All open work', size: 'l', config: { boardIds: [project, tasks], notDone: true } });
    const ts = new Date().toISOString();
    store.db.run('INSERT INTO docs(id,workspace_id,item_id,title,html,position,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', [
      `d_sample_${ws}`, ws, null, 'Relaunch kickoff notes',
      '<h2>Why we are relaunching</h2><p>The current site is slow on phones and hard to update. The relaunch should <b>halve page load time</b> and let marketing publish without a developer.</p>'
      + '<h2>Decisions</h2><ul><li>Design system first, then templates.</li><li>Pilot with five customers before launch.</li></ul>'
      + '<h2>Waiting on other teams</h2><p>Legal reviews launch copy. IT Security approves the new hosting. Both are tracked on the <i>Waiting on team</i> column; nobody is contacted from Boardenda.</p>'
      + '<h2>Next steps</h2><ul class="checklist"><li class="done">Agree goals and scope</li><li>Share research summary</li><li>Book pilot customer calls</li></ul>',
      1, store.me().id, ts, ts]);
  });
  return ws;
}

module.exports = { TEMPLATES, build, sampleWorkspace };
