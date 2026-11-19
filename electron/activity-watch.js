'use strict';
// Activity tracking in the desktop app (only while the user has it turned on):
// every half minute it asks Windows which window is in front, and if screen
// notes are on it takes a picture of the screens now and then for the core to
// read with OCR. It stops while the PC is locked or idle, and the tray icon and
// sidebar show when it is running. Meetings it sees end get a "Recap it?" toast.

const { spawn } = require('child_process');
const { powerMonitor, desktopCapturer, screen } = require('electron');

// One PowerShell process answers "which window is in front?" each time a line is written to it.
const PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class BdFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$names = @{}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $h = [BdFg]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][BdFg]::GetWindowText($h, $sb, 512)
  $procId = 0
  [void][BdFg]::GetWindowThreadProcessId($h, [ref]$procId)
  $proc = ''; $desc = ''
  if ($procId -ne 0) {
    if ($names.ContainsKey($procId)) { $proc = $names[$procId][0]; $desc = $names[$procId][1] }
    else {
      $p = Get-Process -Id $procId
      if ($p) { $proc = $p.ProcessName; try { $desc = $p.MainModule.FileVersionInfo.FileDescription } catch {} }
      $names[$procId] = @($proc, $desc)
    }
  }
  $o = @{ title = $sb.ToString(); proc = $proc; app = $desc } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($o)
  [Console]::Out.Flush()
}
`;

class ForegroundReader {
  constructor(log) { this.log = log; this.ps = null; this.waiting = []; this.buf = ''; }
  start() {
    if (process.platform !== 'win32' || this.ps) return;
    const enc = Buffer.from(PS, 'utf16le').toString('base64');
    this.ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.ps.stdout.setEncoding('utf8');
    this.ps.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        const w = this.waiting.shift();
        if (w) { try { w(JSON.parse(line)); } catch (_) { w(null); } }
      }
    });
    this.ps.on('exit', () => { this.ps = null; this.waiting.splice(0).forEach((w) => w(null)); });
    this.ps.on('error', (e) => { this.log(e); this.ps = null; });
  }
  stop() { if (this.ps) { try { this.ps.stdin.end(); this.ps.kill(); } catch (_) { /* gone */ } this.ps = null; } }
  /** { title, proc, app } of the window in front, or null. */
  read() {
    if (process.platform !== 'win32') return Promise.resolve(null);
    this.start();
    if (!this.ps) return Promise.resolve(null);
    return new Promise((res) => {
      const t = setTimeout(() => { const k = this.waiting.indexOf(done); if (k >= 0) this.waiting.splice(k, 1); res(null); }, 8000);
      const done = (v) => { clearTimeout(t); res(v); };
      this.waiting.push(done);
      try { this.ps.stdin.write('?\n'); } catch (_) { done(null); }
    });
  }
}

/**
 * start({ api, log, notify, onChange }) -> { refresh(), stop(), status() }
 * onChange(status) is called when watching starts/stops or a meeting starts/ends,
 * so the tray and window can show it.
 */
function start({ api, log = () => {}, notify = () => {}, onChange = () => {} }) {
  const fg = new ForegroundReader(log);
  let timer = null;
  let locked = false;
  let busy = false;
  let inMeeting = null; // { title, since, lastSeen }
  let last = null;

  powerMonitor.on('lock-screen', () => { locked = true; });
  powerMonitor.on('unlock-screen', () => { locked = false; });
  powerMonitor.on('suspend', () => { locked = true; });
  powerMonitor.on('resume', () => { locked = false; });

  async function shoot(sample) {
    const displays = screen.getAllDisplays();
    const big = displays.reduce((m, d) => Math.max(m, d.size.width * d.scaleFactor), 1280);
    const width = Math.min(1920, big);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height: Math.round(width * 0.625) } });
    let i = 0;
    for (const s of sources.slice(0, 3)) {
      if (s.thumbnail.isEmpty()) continue;
      await api.activityAddShot({ bytes: s.thumbnail.toJPEG(70), at: new Date().toISOString(), app: sample.app || sample.proc || '', title: sample.title || '', screen: i++ });
    }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const st = api.activityStatus();
      if (!st.watching) { stopMeeting(); return; }
      const idleSec = powerMonitor.getSystemIdleTime();
      const w = await fg.read();
      const sample = { ...(w || {}), idleSec, locked, at: new Date().toISOString() };
      if (!w && process.platform === 'win32') return;
      const kept = api.activityRecord(sample);
      last = kept;
      if (kept && api.activityWantShot(sample)) await shoot(sample).catch(log);
      // Meeting end: no meeting window for 3 minutes after one was seen for at least 4.
      const nowMs = Date.now();
      if (kept && kept.meeting) {
        if (!inMeeting) { inMeeting = { title: kept.title, since: nowMs, lastSeen: nowMs }; onChange(status()); }
        inMeeting.lastSeen = nowMs;
      } else if (inMeeting && nowMs - inMeeting.lastSeen > 180000) {
        stopMeeting();
      }
    } catch (e) { log(e); } finally { busy = false; }
  }

  function stopMeeting() {
    if (!inMeeting) return;
    const m = inMeeting;
    inMeeting = null;
    onChange(status());
    if (m.lastSeen - m.since >= 240000) {
      notify('Meeting ended. Recap it?', `${String(m.title || 'Your meeting').replace(/\s*\|.*$/, '').slice(0, 80)}. Open Activity to get the summary, tasks and a follow-up email. Drop the Teams transcript there for a fuller recap.`, 'activity');
    }
  }

  function status() {
    let st = {};
    try { st = api.activityStatus(); } catch (_) { /* starting */ }
    return { watching: !!st.watching, screens: !!st.recordingScreens, paused: !!st.paused, pausedUntil: st.pausedUntil || null, meeting: (st.meeting && st.meeting.title) || (inMeeting ? String(inMeeting.title || 'Meeting').replace(/\s*\|.*$/, '') : null), last };
  }

  function refresh() {
    clearInterval(timer);
    timer = null;
    const st = api.activityStatus();
    if (st.enabled) {
      timer = setInterval(tick, Math.max(10, st.everySec) * 1000);
      setTimeout(tick, 2000);
    } else {
      fg.stop();
      stopMeeting();
    }
    onChange(status());
  }

  refresh();
  // Paused tracking resumes on its own: re-check each minute.
  let lastPaused = status().paused;
  const watchPause = setInterval(() => { try { const p = !!api.activityStatus().paused; if (p !== lastPaused) { lastPaused = p; onChange(status()); } } catch (_) { /* ignore */ } }, 60000);
  return { refresh, status, stop: () => { clearInterval(timer); clearInterval(watchPause); fg.stop(); } };
}

module.exports = { start };
