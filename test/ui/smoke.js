'use strict';
// Browser smoke test of the whole UI against the real backend (dev server).
// Needs Playwright with Chromium installed:  npm run test:ui
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 5198;
const SHOTS = process.env.SHOTS_DIR || '';

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'boardenda-ui-'));
  const server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'dev', 'server.js'), data, String(PORT)], { stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 1200));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  let n = 0;
  const step = async (name, fn) => {
    process.stdout.write(`- ${name} … `);
    await fn();
    await page.waitForTimeout(250);
    const bad = await page.$$eval('.toast.err', (x) => x.map((e) => e.textContent));
    if (bad.length) throw new Error(`${name}: error toast "${bad.join(' | ')}"`);
    if (errors.length) throw new Error(`${name}: ${errors.join(' | ')}`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${String(++n).padStart(2, '0')}-${name.replace(/\W+/g, '-')}.png`) });
    console.log('ok');
  };
  let code = 0;
  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await step('welcome screen', async () => { await page.waitForSelector('.home-hero'); });
    await step('load the sample workspace', async () => {
      await page.click('text=Try the sample workspace');
      await page.waitForSelector('.ws-board:has-text("Website relaunch")');
    });
    await step('open a board in table view', async () => {
      await page.click('.ws-board:has-text("Website relaunch")');
      await page.waitForSelector('.tbl');
      if ((await page.$$('.tbl tbody tr')).length < 5) throw new Error('rows missing');
    });
    for (const view of ['Gantt', 'Kanban', 'Workload']) {
      await step(`${view} view`, async () => { await page.click(`.tabs .tab:has-text("${view}")`); await page.waitForSelector(view === 'Gantt' ? '.gantt' : view === 'Kanban' ? '.kanban' : '.wl'); });
    }
    await step('gantt critical path and baseline', async () => {
      await page.click('.tabs .tab:has-text("Gantt")');
      await page.click('button:has-text("Critical path")');
      await page.waitForSelector('.g-bar.crit');
      await page.click('button:has-text("Baseline")');
      await page.click('.menu >> text=Save baseline');
      await page.waitForSelector('.g-base');
    });
    await step('conditional colouring', async () => {
      await page.click('.tabs .tab:has-text("Main table")');
      await page.click('.toolbar button:has-text("Colour")');
      await page.click('.pop button:has-text("Add rule")');
      await page.waitForSelector('.tbl tr.ruled');
      await page.click('.pop button:has-text("Clear all")');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.tbl tr.ruled', { state: 'detached' });
    });
    await step('add an item', async () => {
      await page.click('.tabs .tab:has-text("Main table")');
      await page.fill('.add-row input >> nth=0', 'Smoke test task');
      await page.keyboard.press('Enter');
      await page.waitForSelector('text=Smoke test task');
    });
    await step('set a status', async () => {
      const row = page.locator('tr:has-text("Smoke test task")').first();
      await row.locator('.cell.click:has(.lbl)').first().click();
      await page.click('.pop .label-opt:has-text("Done")');
      await page.waitForSelector('tr:has-text("Smoke test task") .lbl:has-text("Done")');
    });
    await step('delete and undo', async () => {
      const rows = () => page.locator('.tbl tbody tr .item-name').count();
      const n = await rows();
      await page.locator('tr:has-text("Smoke test task") .sel-cell input').first().check();
      await page.click('.bulk-bar button:has-text("Delete")');
      await page.click('.modal button:has-text("Delete")');
      await page.waitForSelector('.toast-act');
      if ((await rows()) !== n - 1) throw new Error('item was not deleted');
      await page.click('.toast-act');
      await page.waitForSelector('text=Smoke test task');
    });
    await step('item panel with an update', async () => {
      const row = page.locator('tr:has-text("Smoke test task")').first();
      await row.hover();
      await row.locator('.open-btn').click();
      await page.waitForSelector('.drawer');
      await page.fill('.composer textarea', 'Checked by the smoke test');
      await page.click('.composer button:has-text("Post")');
      await page.waitForSelector('.drawer >> text=Checked by the smoke test');
      for (const t of ['Details', 'Subitems', 'Files', 'Activity log']) await page.click(`.drawer .tab:has-text("${t}")`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.drawer', { state: 'detached' });
    });
    await step('automation center', async () => {
      await page.click('button:has-text("Automate")');
      await page.waitForSelector('.modal >> text=Automations on');
      await page.click('.modal button[aria-label="Close"]');
      await page.waitForSelector('.scrim', { state: 'detached' });
    });
    await step('calendar view', async () => { await page.click('.ws-board:has-text("Team tasks")'); await page.click('.tabs .tab:has-text("Calendar")'); await page.waitForSelector('.cal'); });
    await step('chart and form views', async () => {
      await page.click('.ws-board:has-text("Sales pipeline")');
      await page.click('.tabs .tab:has-text("Forecast chart")');
      await page.waitForSelector('.chart-wrap, .bars, svg');
      await page.click('.tabs .tab:has-text("Lead form")');
      await page.waitForSelector('.form-view');
    });
    await step('dashboard', async () => {
      await page.click('.side a:has-text("Company overview")');
      await page.waitForSelector('.widget');
      if ((await page.$$('.widget')).length < 6) throw new Error('widgets missing');
      await page.waitForSelector('.wtable');
      await page.waitForSelector('.mini-cal .mc-day');
    });
    await step('main calendar: month, week, agenda', async () => {
      await page.click('.side .nav a:has-text("Calendar")');
      await page.waitForSelector('.cal-item');
      await page.click('.seg button:has-text("Week")');
      await page.click('.seg button:has-text("Agenda")');
      await page.waitForSelector('.ag-row');
      await page.click('.seg button:has-text("Month")');
    });
    await step('team dependencies', async () => {
      await page.click('.side .nav a:has-text("Dependencies")');
      await page.waitForSelector('.dep-row');
      await page.click('.dep-n >> nth=0');
    });
    await step('workdoc: open, edit and save', async () => {
      await page.click('.side .ws-board:has-text("Relaunch kickoff notes")');
      await page.waitForSelector('.doc-body h2');
      await page.click('.doc-body');
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Added by the smoke test');
      await page.waitForSelector('.doc-state.saved');
      await page.waitForTimeout(800);
      await page.click('.side .nav a:has-text("Home")');
      await page.click('.side .ws-board:has-text("Relaunch kickoff notes")');
      await page.waitForSelector('.doc-body >> text=Added by the smoke test');
    });
    await step('doc column on an item', async () => {
      await page.click('.ws-board:has-text("Team tasks")');
      await page.click('.tabs .tab:has-text("Main table")');
      await page.click('.tbl .add-col button');
      await page.click('.pop .mi:text-is("Doc")');
      await page.waitForSelector('.tbl th:has-text("Doc")');
      await page.locator('.tbl tbody tr .doc-cell').first().click();
      await page.waitForSelector('.drawer .doc-body');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.tbl .doc-chip');
    });
    await step('repeat an item and save an item template', async () => {
      const row = page.locator('.tbl tbody tr:has-text("Plan team offsite")').first();
      await row.hover();
      await row.locator('.open-btn').click();
      await page.waitForSelector('.drawer');
      await page.click('.drawer button[aria-label="Item menu"]');
      await page.click('.menu .mi:has-text("Repeat")');
      await page.click('.modal button:has-text("Save")');
      await page.waitForSelector('.drawer .rec-chip');
      await page.click('.drawer button[aria-label="Item menu"]');
      await page.click('.menu .mi:has-text("Save as item template")');
      await page.fill('.modal input.input', 'Offsite plan');
      await page.click('.modal button:has-text("Save template")');
      await page.waitForSelector('.modal', { state: 'detached' });
      await page.keyboard.press('Escape');
      await page.waitForSelector('.drawer', { state: 'detached' });
      await page.waitForSelector('.tbl .rec-ic');
      await page.click('.toolbar button[aria-label="More new options"]');
      await page.click('.menu .mi:has-text("Offsite plan")');
      await page.waitForFunction(() => document.querySelectorAll('.tbl tbody tr .nm').length && [...document.querySelectorAll('.tbl .nm')].filter((x) => x.textContent.includes('Plan team offsite')).length >= 2);
    });
    await step('portfolio', async () => {
      await page.click('.side .nav a:has-text("Portfolio")');
      await page.waitForSelector('table.pf tbody tr');
      await page.selectOption('table.pf tbody tr:has-text("Website relaunch") .pf-health', 'off_track');
      await page.waitForSelector('.stat.click:has-text("Off track") b:text("1")');
    });
    await step('timesheets', async () => {
      await page.click('.side .nav a:has-text("Timesheets")');
      await page.selectOption('.page select.input', '');
      await page.waitForSelector('table.ts tbody tr td a');
      await page.click('button:has-text("Log time")');
      await page.fill('.modal input[placeholder="Search items"]', 'offsite');
      await page.waitForSelector('.modal select option:has-text("Plan team offsite")', { state: 'attached' });
      await page.selectOption('.modal select >> nth=0', { label: 'Plan team offsite · Team tasks' });
      await page.fill('.modal .grid input >> nth=1', '2:30');
      await page.click('.modal button:has-text("Log time")');
      await page.waitForSelector('table.ts tbody tr:has-text("Plan team offsite")');
    });
    await step('customer calls: log, notes, action to a board, repeat', async () => {
      await page.click('.side .nav a:has-text("Calls and meetings")');
      await page.waitForSelector('h1:has-text("Calls and meetings")');
      await page.click('button:has-text("Log a customer call")');
      await page.fill('.modal input[placeholder="e.g. Discovery call"]', 'Smoke call');
      await page.fill('.modal input[placeholder="Company or account"]', 'Globex');
      await page.click('.modal button:has-text("Create")');
      await page.waitForSelector('.drawer h2:has-text("Smoke call")');
      await page.click('.drawer .tab:has-text("Notes")');
      await page.click('.drawer .rich-body');
      await page.keyboard.type('Globex wants a demo');
      await page.click('.drawer .tab:has-text("Action items")');
      await page.fill('.drawer input[placeholder^="Next action"]', 'Book the demo');
      await page.click('.drawer button:has-text("Add action")');
      await page.waitForSelector('.drawer .actions tr');
      await page.click('.drawer .actions button:has-text("Add to board")');
      await page.click('.menu .mi:has-text("Team tasks")');
      await page.waitForSelector('.drawer .actions .chip:has-text("Team tasks")');
      await page.click('.drawer button[aria-label="Meeting menu"]');
      await page.click('.menu .mi:has-text("Make it repeat")');
      await page.click('.modal button:has-text("Save")');
      await page.waitForSelector('.drawer .muted:has-text("Every week")');
      await page.click('.drawer button[aria-label="Close"]');
      await page.waitForSelector('.scrim', { state: 'detached' });
      await page.waitForSelector('.meet-row:has-text("Smoke call") >> nth=1');
      await page.click('.seg button:has-text("Action items")');
      await page.waitForSelector('.meet-row:has-text("Book the demo")');
      await page.click('.seg button:has-text("Past and held")');
      await page.waitForSelector('.meet-row:has-text("Proposal walkthrough")');
    });
    await step('quick capture: notes to records with mapping', async () => {
      await page.click('.side .capture-btn');
      await page.fill('.modal .cap-text', 'Call with Northwind Traders tomorrow 2pm\nThey want quarterly billing.\n- Jordan to send revised quote by Friday');
      await page.click('.modal button:has-text("Read notes")');
      await page.waitForSelector('.cap-card >> nth=1');
      await page.click('.modal button:has-text("Back to the notes")');
      await page.fill('.modal .cap-text', '- Zebra crossing paint order');
      await page.click('.modal button:has-text("Read notes")');
      await page.waitForSelector('.cap-card.unsure');
      if (!(await page.isDisabled('.modal button:has-text("Create 1 record")'))) throw new Error('unplaced record should block creating');
      await page.selectOption('.cap-card select >> nth=1', { label: 'Bug tracker' });
      await page.waitForSelector('.cap-card.unsure', { state: 'detached' });
      await page.click('.modal button:has-text("Create 1 record")');
      await page.waitForSelector('.drawer h2:has-text("Zebra crossing paint order")');
      await page.click('.drawer button[aria-label="Close"]');
      await page.waitForSelector('.scrim', { state: 'detached' });
    });
    await step('my work', async () => { await page.click('.side .nav a:has-text("My work")'); await page.waitForSelector('h1:has-text("My work")'); });
    await step('inbox', async () => { await page.click('.side .nav a:has-text("Inbox")'); await page.waitForSelector('h1:has-text("Inbox")'); });
    await step('search palette', async () => {
      await page.keyboard.press('Control+k');
      await page.fill('.palette input', 'smoke test');
      await page.waitForSelector('.palette .mi:has-text("Smoke test task")');
      await page.keyboard.press('Escape');
    });
    await step('new board from a template', async () => {
      await page.click('.side .sect button[title="New board"]');
      await page.click('.tpl:has-text("Bug tracker")');
      await page.fill('.modal input.input', 'QA');
      await page.click('.modal button:has-text("Create board")');
      await page.waitForSelector('.board-title:has-text("QA"), h1:has-text("QA")');
    });
    await step('favorite, folder and save as template', async () => {
      await page.click('.board-head .fav-btn');
      await page.waitForSelector('.side .sect:has-text("Favorites")');
      await page.click('button[aria-label="Board menu"]');
      await page.click('.menu >> text=Move to workspace or folder');
      await page.fill('.modal input[placeholder="e.g. Q4 projects"]', 'Quality');
      await page.click('.modal button:has-text("Save")');
      await page.waitForSelector('.side .ws-folder:has-text("Quality")');
      await page.click('button[aria-label="Board menu"]');
      await page.click('.menu >> text=Save as template');
      await page.fill('.modal input.input >> nth=0', 'QA setup');
      await page.click('.modal button:has-text("Save template")');
      await page.waitForSelector('.scrim', { state: 'detached' });
      await page.click('.side .sect button[title="New board"]');
      await page.click('.user-tpl:has-text("QA setup")');
      await page.click('.modal button:has-text("Create board")');
      await page.waitForSelector('.board-title:has-text("QA setup")');
    });
    await step('import wizard from a text file', async () => {
      await page.click('.side .sect button[title="New board"]');
      const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('.modal button:has-text("Import a file")')]);
      await fc.setFiles({ name: 'Call list.txt', mimeType: 'text/plain', buffer: Buffer.from('Task\tOwner\tDue\nEXAMPLE: sample row\tSam\t2026-01-01\nCall Acme\tDana\t2026-12-01\nSend quote\tLee\t2026-12-03\n') });
      await page.waitForSelector('.import-grid');
      await page.waitForSelector('.modal button:has-text("Import 2 items")');
      await page.fill('.import-grid tbody tr >> nth=1 >> .ig-cell >> nth=0', 'Call Acme Ltd');
      await page.click('.modal button:has-text("Import 2 items")');
      await page.waitForSelector('.board-title:has-text("Call list")');
      await page.waitForSelector('text=Call Acme Ltd');
    });
    await step('keyboard shortcuts', async () => {
      await page.click('.side .nav a:has-text("Home")');
      await page.keyboard.press('?');
      await page.waitForSelector('.modal .keys');
      await page.click('.modal button[aria-label="Close"]');
      await page.waitForSelector('.scrim', { state: 'detached' });
      await page.keyboard.press('g');
      await page.keyboard.press('i');
      await page.waitForSelector('h1:has-text("Inbox")');
    });
    await step('help center: search, article, export', async () => {
      await page.keyboard.press('F1');
      await page.waitForSelector('h1:has-text("Help and user guide")');
      await page.fill('.help-search input', 'serial number');
      await page.click('.help-row:has-text("Track customer devices")');
      await page.waitForSelector('.help-art h2:has-text("Track customer devices")');
      await page.click('.help-art a:has-text("Customers")').catch(() => {});
      await page.click('button:has-text("Export user guide")');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.menu .mi:has-text("Markdown")')]);
      if (!/user guide/.test(dl.suggestedFilename())) throw new Error(`unexpected guide name ${dl.suggestedFilename()}`);
    });
    await step('customers: create, contact, device, assign to a task', async () => {
      await page.keyboard.press('g');
      await page.keyboard.press('u');
      await page.waitForSelector('h1:has-text("Customers")');
      await page.click('button:has-text("New customer")');
      await page.fill('.modal label:has-text("Customer or account name") input', 'Smoke Corp');
      await page.fill('.modal label:has-text("Name") >> nth=1 >> input', 'Pat Smoke').catch(() => {});
      await page.click('.modal button:has-text("Create customer")');
      await page.waitForSelector('.drawer .hd:has-text("Smoke Corp"), .drawer:has-text("Smoke Corp")');
      await page.click('.drawer .ptabs .tab:has-text("Devices")');
      await page.click('.drawer button:has-text("Add device")');
      await page.fill('.modal label:has-text("Name") input', 'Kiosk 7');
      await page.fill('.modal label:has-text("Serial number") input', 'SMK-777');
      await page.click('.modal button:has-text("Save device")');
      await page.waitForSelector('.drawer td:has-text("SMK-777")');
      await page.click('.drawer .ptabs .tab:has-text("Contacts")');
      await page.click('.drawer button:has-text("Add contact")');
      await page.fill('.modal label:has-text("Name") input', 'Robin Ops');
      await page.fill('.modal label:has-text("Email") input', 'robin@smoke.test');
      await page.click('.modal button:has-text("Save contact")');
      await page.waitForSelector('.drawer .cust-card:has-text("Robin Ops")');
      await page.click('.drawer button[aria-label="Close"]');
      if (!(await page.locator('.paste-cust').count())) await page.click('button:has-text("Paste an email or signature")');
      await page.fill('.paste-box', 'Thanks,\nLee Wong\nField Engineer | Wong Labs Inc.\nlee@wonglabs.test\nM: +1 555 0201');
      await page.click('.paste-cust button:has-text("Read details")');
      await page.waitForSelector('.paste-review');
      await page.click('.paste-review button:has-text("Create customer")');
      await page.waitForSelector('.drawer .cust-card:has-text("Lee Wong")');
      await page.click('.drawer button[aria-label="Close"]');
      await page.fill('.customers-page input[placeholder^="Search"]', 'smk-777');
      await page.waitForSelector('.cust-table tr:has-text("Smoke Corp")');
      // Assign through the item panel menu.
      await page.click('.ws-board:has-text("Call list")');
      const row = page.locator('.tbl tbody tr:has-text("Call Acme Ltd")').first();
      await row.hover();
      await row.locator('.open-btn').click();
      await page.waitForSelector('.drawer');
      await page.click('.drawer button[aria-label="Item menu"]');
      await page.click('.menu .mi:has-text("Assign customer")');
      await page.fill('.modal input[placeholder="Search customers"]', 'Smoke');
      await page.click('.modal .mi:has-text("Smoke Corp")');
      await page.waitForSelector('text=Customer assigned');
      await page.click('.drawer button[aria-label="Close"]');
      await page.waitForSelector('.tbl .cust-chip:has-text("Smoke Corp")');
    });
    await step('reports: executive summary', async () => {
      await page.click('.side a:has-text("Reports")');
      await page.waitForSelector('.rpt h1:has-text("Executive summary")');
      await page.waitForSelector('.rpt h2:has-text("Board health")');
    });
    await step('reports: weekly progress, last week, export', async () => {
      await page.click('.rpt-kind:has-text("Weekly progress report")');
      await page.waitForSelector('.rpt h1:has-text("Weekly progress report")');
      await page.selectOption('.rpt-controls label:has-text("Period") select', 'this_month');
      await page.waitForSelector('.rpt-meta:has-text("This month")');
      await page.click('.rpt-summary-edit button:has-text("Write summary")');
      await page.waitForSelector('.rpt-summary-edit textarea');
      await page.waitForSelector('.rpt h2:has-text("Summary")');
      await page.click('.rpt-controls button:has-text("Export")');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.menu .mi:has-text("Markdown")')]);
      if (!/Weekly progress report/.test(dl.suggestedFilename())) throw new Error(`unexpected report name ${dl.suggestedFilename()}`);
    });
    await step('reports: status overview and detailed status', async () => {
      await page.click('.rpt-kind:has-text("Status overview")');
      await page.waitForSelector('.rpt h2:has-text("Status by board")');
      await page.click('.rpt-kind:has-text("Detailed status report")');
      await page.waitForSelector('.rpt h1:has-text("Detailed status report")');
      await page.click('.rpt-kind:has-text("Customer report")');
      await page.waitForSelector('.rpt h1:has-text("Customer report")');
    });
    await step('reports: save and open a snapshot', async () => {
      await page.click('.rpt-kind:has-text("Executive summary")');
      await page.waitForSelector('.rpt h1:has-text("Executive summary")');
      await page.click('.rpt-controls button:has-text("Save snapshot")');
      await page.waitForSelector('.toast:has-text("Snapshot saved")');
      await page.click('.tabs .tab:has-text("Snapshots")');
      await page.click('.rpt-snap:has-text("Executive summary")');
      await page.waitForSelector('.rpt h1:has-text("Executive summary")');
      await page.fill('.card input[placeholder^="For example"]', 'Sent to the owners');
      await page.keyboard.press('Tab');
      await page.waitForSelector('.rpt-meta:has-text("Sent to the owners")');
      await page.click('button:has-text("All snapshots")');
      await page.waitForSelector('.rpt-snap:has-text("Sent to the owners")');
      await page.click('.tabs .tab:has-text("Build a report")');
    });
    await step('ask anything: folders, index, question with sources', async () => {
      const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'boardenda-docs-'));
      fs.writeFileSync(path.join(docs, 'northwind-contract.txt'), 'Service agreement with Northwind Traders. Payment terms are net 45 days. The support line is open 8am to 6pm.');
      const api = (m, ...a) => page.evaluate(async ([m, a]) => (await fetch(`/api/${m}`, { method: 'POST', body: JSON.stringify(a) })).json(), [m, a]);
      await api('askAddFolder', docs);
      await api('askIndex');
      for (let i = 0; i < 40; i++) { const s = await api('askStatus'); if (!(s.job && s.job.running) && s.files) break; await page.waitForTimeout(250); }
      await page.click('.side a:has-text("Ask anything")');
      await page.waitForSelector('.ask-page .page-head:has-text("1 folder")');
      await page.fill('.ask-input textarea', 'What are the payment terms for Northwind?');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.ask-msg.bot .ask-src:has-text("northwind-contract.txt")', { timeout: 30000 });
    });
    await step('sidebar: collapse menu, workspaces and folders', async () => {
      await page.click('.side .sect:has-text("Menu")');
      await page.waitForSelector('.side .nav.compact a[aria-label="Reports"]');
      await page.click('.side .nav.compact a[aria-label="Reports"]');
      await page.waitForSelector('h1:has-text("Reports")');
      await page.click('.side .ws-board:has-text("Team tasks")');
      await page.click('.side .ws-head:has-text("Sample workspace")');
      if (await page.locator('.side .ws-board:has-text("Website relaunch")').count()) throw new Error('workspace did not collapse');
      await page.waitForSelector('.side .ws-board.on:has-text("Team tasks")');
      await page.click('.side .ws-head:has-text("Sample workspace")');
      await page.waitForSelector('.side .ws-board:has-text("Website relaunch")');
      await page.click('.side button[aria-label="Collapse all workspaces"]');
      await page.click('.side button[aria-label="Expand all workspaces"]');
      await page.click('.side .sect:has-text("Workspaces")');
      if (await page.locator('.side .ws-head').count()) throw new Error('workspaces section did not collapse');
      await page.click('.side .sect:has-text("Workspaces")');
      await page.click('.side .sect:has-text("Menu")');
      await page.waitForSelector('.side .nav a:has-text("Help and guide")');
    });
    await step('settings', async () => { await page.click('.side .foot button[title=Settings]'); await page.waitForSelector('h1:has-text("Settings")'); });
    await step('settings: AI and Ask folders', async () => { await page.click('.page button:text-is("AI")'); await page.waitForSelector('.ask-setup:has-text("boardenda-docs")'); });
    await step('desktop self test', async () => {
      const r = await page.evaluate(() => window.__bdSelfTest());
      if (!r.ok) throw new Error(`self test failed ${JSON.stringify(r)}`);
    });
    console.log('UI smoke test passed');
  } catch (e) {
    console.log('FAILED');
    console.error(e.message);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'failure.png') });
    code = 1;
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
  process.exit(code);
})();
