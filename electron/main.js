'use strict';
// Electron main process: window, tray, native dialogs, the automation
// scheduler, desktop notifications, and the IPC bridge to the core API.

const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, nativeImage, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const { AppApi, PUBLIC_METHODS } = require('../src/core/api');
const updates = require('./updater');

const APP_NAME = 'Boardenda';
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.boardenda.app');

// The UI is served from app://ui/ so it has a stable, sandboxed origin.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const UI_ROOT = path.join(__dirname, '..', 'dist', 'ui');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function registerUiProtocol() {
  protocol.handle('app', async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(UI_ROOT, rel));
    if (!file.startsWith(UI_ROOT + path.sep)) return new Response('Not found', { status: 404 });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch (_) {
      return new Response('Not found', { status: 404 });
    }
  });
}

let win = null;
let tray = null;
let api = null;
let quitting = false;
const startHidden = process.argv.includes('--hidden');
const smokeTest = process.argv.includes('--smoke-test');

// ----------------------------------------------------------- data location
function configFile() { return path.join(app.getPath('userData'), 'config.json'); }
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch (_) { return {}; }
}
function writeConfig(c) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2));
}
function defaultDataDir() {
  if (smokeTest) return path.join(app.getPath('temp'), `boardenda-smoke-${process.pid}`);
  // Local (not roaming) AppData on Windows: attached files can be large and
  // should not sync with roaming profiles.
  const base = process.platform === 'win32' && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA : app.getPath('userData');
  return path.join(base, 'Boardenda');
}
function dataDir() { return readConfig().dataDir || defaultDataDir(); }

function logError(e) {
  try {
    const f = path.join(dataDir(), 'error.log');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `[${new Date().toISOString()}] ${e && e.stack ? e.stack : e}\n`);
  } catch (_) { /* nothing else to do */ }
}
process.on('uncaughtException', logError);
process.on('unhandledRejection', logError);

// ------------------------------------------------------------------ window
function iconPath() {
  const p = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1460, height: 920, minWidth: 1100, minHeight: 700,
    title: APP_NAME, icon: iconPath(), show: false, backgroundColor: '#f6f6fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL('app://ui/index.html');
  win.once('ready-to-show', () => { if (!startHidden && !smokeTest) win.show(); });
  if (smokeTest) runSmokeTest();
  win.on('close', (e) => {
    if (quitting) return;
    let bg = true;
    try { bg = api.getSettings().runInBackground !== false; } catch (_) { /* default */ }
    if (bg) {
      e.preventDefault();
      win.hide();
      if (process.platform === 'win32' && !readConfig().trayHintShown) {
        writeConfig({ ...readConfig(), trayHintShown: true });
        notify('Still running in the background', 'Boardenda keeps running your automations and reminders. Open it from the tray icon.');
      }
    }
  });
  // Never navigate away from the app; open web links in the browser.
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
  });
}

/** CI check: the UI renders and the database, formulas and dashboards work in the packaged app. */
function runSmokeTest() {
  const finish = (code, msg) => { console.log(`SMOKE ${code ? 'FAIL' : 'PASS'} ${msg}`); quitting = true; app.exit(code); };
  setTimeout(() => finish(1, 'timeout'), 120000);
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.log(`renderer: ${message}`); });
  win.webContents.on('did-finish-load', async () => {
    try {
      const r = await win.webContents.executeJavaScript(`new Promise((res) => { const t = setInterval(() => { if (window.__bdSelfTest && document.querySelector('.side')) { clearInterval(t); window.__bdSelfTest().then(res, (e) => res({ ok: false, error: String(e) })); } }, 200); })`);
      finish(r.ok ? 0 : 1, JSON.stringify(r));
    } catch (e) { finish(1, e.message); }
  });
}

function openExternal(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

function showWindow(route) {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (route && route.name === 'item') win.webContents.send('openItem', route.id);
  else if (route) win.webContents.send('navigate', route);
}

function createTray() {
  const icon = iconPath() ? nativeImage.createFromPath(iconPath()) : nativeImage.createEmpty();
  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Boardenda', click: () => showWindow() },
    { label: 'My work', click: () => showWindow('mywork') },
    { label: 'Send digest now', click: () => sendDigest(true) },
    { label: 'Check for updates', click: () => checkUpdatesNow() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showWindow());
}

// ---------------------------------------------------------- notifications
function notify(title, body, route) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath(), silent: false });
  n.on('click', () => showWindow(route));
  n.show();
}

function sendDigest(force = false) {
  try {
    const dg = force ? api.digest() : api.checkNotification(new Date());
    if (!dg) return null;
    const body = [dg.headline, ...dg.lines.slice(0, 3)].join('\n');
    notify(dg.title, body, 'mywork');
    if (win) win.webContents.send('digest', dg);
    return dg;
  } catch (e) {
    logError(e);
    return null;
  }
}

/** Show new assignments, mentions and automation notifications as Windows toasts. */
function showNotifications() {
  const rows = api.takeUnshown();
  for (const n of rows.slice(-4)) notify(n.title, n.body || '', n.item_id ? { name: 'item', id: n.item_id } : 'inbox');
  if (rows.length > 4) notify(`${rows.length - 4} more notifications`, 'Open the inbox to see them all.', 'inbox');
  if (rows.length && win) win.webContents.send('changed', { notifications: rows.length });
}

/** Every minute: time-based automations, the digest, and desktop notifications. */
function tick() {
  try {
    const fired = api.runSchedule();
    if (fired && win) win.webContents.send('changed', { automations: fired });
  } catch (e) { logError(e); }
  sendDigest(false);
  try { showNotifications(); } catch (e) { logError(e); }
}

function startScheduler() {
  setTimeout(tick, 15000); // catch up on missed reminders after start-up
  setInterval(tick, 60 * 1000);
}

// --------------------------------------------------------------------- IPC
function serializeError(e) {
  return { __error: true, message: e && e.message ? e.message : String(e) };
}

function registerIpc() {
  ipcMain.handle('api', async (_e, method, args) => {
    if (!PUBLIC_METHODS.includes(method)) return serializeError(new Error(`Unknown method ${method}`));
    try {
      const fixed = (args || []).map((a) => fixBinary(a));
      const out = await api[method](...fixed);
      if (method === 'setSettings') applyOsSettings();
      return out;
    } catch (e) {
      logError(e);
      return serializeError(e);
    }
  });

  ipcMain.handle('native', async (_e, op, a = {}) => {
    try {
      switch (op) {
        case 'saveFile': {
          const r = await dialog.showSaveDialog(win, { defaultPath: a.name, filters: a.filters });
          if (r.canceled || !r.filePath) return null;
          fs.writeFileSync(r.filePath, a.bytes ? Buffer.from(a.bytes) : a.text, a.bytes ? undefined : 'utf8');
          return r.filePath;
        }
        case 'savePdf': {
          const r = await dialog.showSaveDialog(win, { defaultPath: a.name || 'Board.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
          if (r.canceled || !r.filePath) return null;
          fs.writeFileSync(r.filePath, await htmlToPdf(a.html));
          shell.openPath(r.filePath);
          return r.filePath;
        }
        case 'openFile': {
          const p = api.filePath(a.id);
          if (!p || !fs.existsSync(p)) throw new Error('The attached file is missing');
          const err = await shell.openPath(p);
          if (err) throw new Error(err);
          return true;
        }
        case 'saveFileAs': {
          const p = api.filePath(a.id);
          if (!p || !fs.existsSync(p)) throw new Error('The attached file is missing');
          const name = (a.name || path.basename(p)).replace(/[\\/:*?"<>|]/g, '_');
          const r = await dialog.showSaveDialog(win, { defaultPath: name });
          if (r.canceled || !r.filePath) return null;
          fs.copyFileSync(p, r.filePath);
          return r.filePath;
        }
        case 'showFile': {
          const p = api.filePath(a.id);
          if (p) shell.showItemInFolder(p);
          return true;
        }
        case 'appInfo': return { version: app.getVersion(), dataDir: dataDir(), platform: process.platform };
        case 'openPath': { await shell.openPath(a.path); return true; }
        case 'openExternal': { openExternal(a.url); return true; }
        case 'testNotification': { sendDigest(true); return true; }
        case 'chooseFolder': {
          const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
          return r.canceled ? null : r.filePaths[0];
        }
        case 'moveData': {
          const target = path.join(a.path, 'Boardenda');
          if (path.resolve(target) === path.resolve(dataDir())) return dataDir();
          api.backup('before-move');
          copyDir(dataDir(), target);
          writeConfig({ ...readConfig(), dataDir: target });
          app.relaunch();
          quitting = true;
          app.exit(0);
          return target;
        }
        case 'updateStatus': return updates.getStatus();
        case 'checkForUpdates': return await updates.check();
        case 'installUpdate': { const ok = updates.install(); if (ok) quitting = true; return ok; }
        case 'relaunch': { app.relaunch(); quitting = true; app.exit(0); return true; }
        default: throw new Error(`Unknown native op ${op}`);
      }
    } catch (e) {
      logError(e);
      return serializeError(e);
    }
  });
}

function fixBinary(a) {
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    if (a instanceof Uint8Array) return Buffer.from(a);
    const out = {};
    for (const [k, v] of Object.entries(a)) out[k] = v instanceof Uint8Array ? Buffer.from(v) : v;
    return out;
  }
  return a;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
  }
}

async function htmlToPdf(html) {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await w.webContents.printToPDF({ printBackground: true, pageSize: 'Letter', margins: { marginType: 'default' } });
  } finally {
    w.destroy();
  }
}

function applyOsSettings() {
  try {
    const s = api.getSettings();
    if (process.platform === 'win32' || process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: !!s.startWithWindows, args: ['--hidden'] });
    }
  } catch (e) { logError(e); }
}

/** Manual check from the tray: always say what happened. */
async function checkUpdatesNow() {
  const st = await updates.check({ manual: true });
  if (st.state === 'unsupported') notify('Updates', 'The portable version does not update itself. Use the installer to get automatic updates.');
  else if (st.state === 'current') notify('You have the latest version', `Boardenda ${st.current} is up to date.`);
  else if (st.state === 'downloading') notify(`Downloading version ${st.version}`, 'You will be told when it is ready to install.');
  else if (st.state === 'error') notify('Could not check for updates', st.message);
}

function startUpdates() {
  let told = null;
  updates.init({
    enabled: () => api.getSettings().autoUpdate !== false,
    log: logError,
    changed: (st) => {
      if (win) win.webContents.send('update', st);
      if (st.state === 'ready' && told !== st.version) {
        told = st.version;
        notify(`Update ready: version ${st.version}`, 'Restart Boardenda to install it. It also installs the next time you quit.', 'settings');
      }
    },
  });
}

// --------------------------------------------------------------- lifecycle
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(async () => {
    try {
      api = await AppApi.create({ dataDir: dataDir() });
    } catch (e) {
      logError(e);
      dialog.showErrorBox(APP_NAME, `The database could not be opened.\n\n${e.message}\n\nData folder: ${dataDir()}\nA log was written to error.log in that folder.`);
      app.exit(1);
      return;
    }
    registerUiProtocol();
    registerIpc();
    createWindow();
    if (smokeTest) return;
    createTray();
    applyOsSettings();
    startScheduler();
    startUpdates();
  });
  app.on('before-quit', () => { quitting = true; try { api && api.db.close(); } catch (_) { /* closing */ } });
  app.on('window-all-closed', () => { /* stay in tray */ });
  app.on('activate', () => showWindow());
}
