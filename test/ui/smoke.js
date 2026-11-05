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
    await step('settings', async () => { await page.click('.side .foot button[title=Settings]'); await page.waitForSelector('h1:has-text("Settings")'); });
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
