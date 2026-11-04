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
    await step('add an item', async () => {
      await page.click('.tabs .tab:has-text("Main table")');
      await page.fill('.add-row input >> nth=0', 'Smoke test task');
      await page.keyboard.press('Enter');
      await page.waitForSelector('text=Smoke test task');
    });
    await step('set a status', async () => {
      const row = page.locator('tr:has-text("Smoke test task")').first();
      await row.locator('.cell.click').nth(1).click();
      await page.click('.pop .label-opt:has-text("Done")');
      await page.waitForSelector('tr:has-text("Smoke test task") .lbl:has-text("Done")');
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
    });
    await step('main calendar: month, week, agenda', async () => {
      await page.click('.side .nav a:has-text("Calendar")');
      await page.waitForSelector('.cal-item');
      await page.click('.seg button:has-text("Week")');
      await page.click('.seg button:has-text("Agenda")');
      await page.waitForSelector('.ag-row');
      await page.click('.seg button:has-text("Month")');
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
