'use strict';
// Boardenda's own browser session: the built-in browser on the Web page (a
// <webview>) and the hidden window that reads links share it, so a site the
// user signs in to there can be read and watched later. It is separate from
// Edge and Chrome and is stored in the app's profile.

const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:boardenda-web';
const hidden = new Set();
let ready = false;

function webSession() {
  const ses = session.fromPartition(PARTITION);
  if (!ready) {
    ready = true;
    // The hidden reader never downloads files; the built-in browser asks where to save them.
    ses.on('will-download', (e, _item, wc) => { if (wc && hidden.has(wc.id)) e.preventDefault(); });
    // Pages may not use the camera, microphone, location or notifications.
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(['clipboard-sanitized-write', 'fullscreen'].includes(perm)));
  }
  return ses;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Load a link in a hidden window, let its scripts run, and read it with the page script. */
async function readInWindow(url, script, { settle = 1800, timeout = 30000 } = {}) {
  webSession();
  const w = new BrowserWindow({
    show: false, width: 1366, height: 900,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
  });
  const wc = w.webContents;
  hidden.add(wc.id);
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    const nav = w.loadURL(url).catch((e) => { if (!/ERR_ABORTED/.test(String(e && e.message))) throw e; });
    const late = await Promise.race([nav.then(() => false), sleep(timeout).then(() => true)]);
    if (!late) await sleep(settle);
    // Scroll down once so pages that load more as you scroll show their next rows.
    await wc.executeJavaScript('window.scrollTo(0, document.body ? document.body.scrollHeight : 0); 1', true).catch(() => null);
    await sleep(600);
    return await wc.executeJavaScript(script, true);
  } finally {
    hidden.delete(wc.id);
    if (!w.isDestroyed()) w.destroy();
  }
}

/** fetch() through this session (proxy settings and sign-ins of the built-in browser). */
function sessionFetch(url, opts = {}) {
  return webSession().fetch(url, opts);
}

/** Lock down <webview> tags in the main window: no Node, sandboxed, only web pages, this session. */
function guardWebviews(contents) {
  contents.on('will-attach-webview', (e, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.partition = PARTITION;
    params.partition = PARTITION;
    if (params.src && !/^(https?:|about:blank)/i.test(params.src)) e.preventDefault();
  });
  contents.on('did-attach-webview', (_e, wc) => {
    webSession();
    // Links that open a new window open in the same built-in browser instead.
    wc.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) wc.loadURL(url); return { action: 'deny' }; });
    wc.on('will-navigate', (e, url) => { if (!/^(https?:|about:blank)/i.test(url)) e.preventDefault(); });
  });
}

module.exports = { PARTITION, readInWindow, sessionFetch, guardWebviews, webSession };
