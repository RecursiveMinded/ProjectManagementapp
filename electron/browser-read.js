'use strict';
// Reads the page open in the user's own browser (Edge, Chrome, Firefox, Brave,
// Opera, Vivaldi) through Windows UI Automation, the same interface screen
// readers use: the address, the page text and its tables, from the tab the
// user is looking at, signed in as they are. It picks the browser window in
// front, or the one nearest the front when Boardenda itself is in front.
//
// Privacy is checked before the page is read: private windows (InPrivate,
// Incognito), titles with the user's private words, sign-in and password
// pages and sites on the never-read list are skipped; only the title and
// address are looked at for those.
//
// No Electron here, so it can be tried with plain Node (scripts/try-browser-read.js).

const { spawn } = require('child_process');

const PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$rules = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__RULES__')) | ConvertFrom-Json
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class BdBrowse {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<IntPtr> Windows() {
    var l = new List<IntPtr>();
    l.Add(GetForegroundWindow());
    EnumWindows(delegate(IntPtr h, IntPtr p) { if (IsWindowVisible(h) && !IsIconic(h)) l.Add(h); return true; }, IntPtr.Zero);
    return l;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(1024); GetWindowText(h, sb, 1024); return sb.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
}
"@
function Done($o) { [Console]::Out.Write(($o | ConvertTo-Json -Depth 8 -Compress)); [Console]::Out.Flush(); exit }
if (-not ([System.Management.Automation.PSTypeName]'BdBrowse').Type) { Done @{ ok = $false; reason = 'error'; message = 'Windows helper did not load' } }

$browsers = @('msedge','chrome','firefox','brave','opera','vivaldi','arc','chromium','waterfox','librewolf','iexplore')
$target = [IntPtr]::Zero; $title = ''; $proc = ''
foreach ($h in [BdBrowse]::Windows()) {
  if ($h -eq [IntPtr]::Zero) { continue }
  $t = [BdBrowse]::Title($h)
  if (-not $t) { continue }
  $p = Get-Process -Id ([BdBrowse]::Pid($h))
  if ($p -and ($browsers -contains $p.ProcessName.ToLower())) { $target = $h; $title = $t; $proc = $p.ProcessName; break }
}
if ($target -eq [IntPtr]::Zero) { Done @{ ok = $false; reason = 'nobrowser' } }
$low = $title.ToLower()
foreach ($w in $rules.titleWords) { if ($w -and $low.Contains([string]$w)) { Done @{ ok = $false; reason = 'private'; title = $title; proc = $proc } } }

$A = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$TS = [System.Windows.Automation.TreeScope]
function Cond($type) { New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $type) }
$root = $A::FromHandle($target)
if (-not $root) { Done @{ ok = $false; reason = 'error'; message = 'The browser window could not be read'; title = $title; proc = $proc } }

# Walk the browser's own controls (not into pages) to find the address bar and the page.
# Chromium builds its page tree for UI Automation only after a client first asks, so the
# page may be missing on the first walk: walk again a few times until its text shows.
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$urlLike = '^(https?://|file:///|[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(/|\?|$)|localhost(:\d+)?(/|$))'
$script:url = ''; $script:guess = ''
function Walk {
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($root)
  $seen = 0; $found = @()
  while ($queue.Count -gt 0 -and $seen -lt 6000) {
    $el = $queue.Dequeue(); $seen++
    $ct = $el.Current.ControlType
    if ($ct -eq $CT::Document) { $found += $el; continue }
    if ($ct -eq $CT::Edit -and -not $script:url) {
      $vp = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
        $v = ([string]$vp.Current.Value).Trim()
        $n = [string]$el.Current.Name
        if ($v -match $urlLike) {
          if ($n -match 'address|location|url|search bar|search or enter|search with|adresse|direcci|indirizzo|adres') { $script:url = $v } elseif (-not $script:guess) { $script:guess = $v }
        }
      }
    }
    $c = $walker.GetFirstChild($el)
    while ($c -ne $null) { $queue.Enqueue($c); $c = $walker.GetNextSibling($c) }
  }
  if ($found.Count -eq 0) { $f = $root.FindFirst($TS::Descendants, (Cond $CT::Document)); if ($f) { $found += $f } }
  return ,$found
}
function PickDoc($docs) {
  foreach ($d in $docs) { $dn = [string]$d.Current.Name; if ($dn -and $title.StartsWith($dn)) { return $d } }
  $best = $null; $bestArea = 0
  foreach ($d in $docs) { $r = $d.Current.BoundingRectangle; $a = $r.Width * $r.Height; if ($a -gt $bestArea -and -not ([string]$d.Current.Name -match '^DevTools')) { $bestArea = $a; $best = $d } }
  return $best
}
function ReadText($doc) {
  $t = ''
  $tp = $null
  if ($doc.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { $t = [string]$tp.DocumentRange.GetText(300000) }
  if ($t.Length -lt 80) {
    $parts = New-Object System.Collections.Generic.List[string]
    $n = 0
    foreach ($x in $doc.FindAll($TS::Descendants, (Cond $CT::Text))) { if ($n -ge 20000) { break }; $n++; $s = [string]$x.Current.Name; if ($s.Trim()) { $parts.Add($s.Trim()) } }
    $j = $parts -join [Environment]::NewLine
    if ($j.Length -gt $t.Length) { $t = $j }
  }
  return $t
}

$docs = Walk
$url = $script:url
if (-not $url) { $url = $script:guess }
$schemeGuessed = $false
if ($url -and $url -notmatch '^[a-z][a-z0-9+.-]*:') {
  # Edge and Chrome hide http:// and https:// in the address bar.
  $schemeGuessed = $true
  if ($url -match '^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)') { $url = 'http://' + $url } else { $url = 'https://' + $url }
}
if ($url) {
  if ([regex]::IsMatch($url, $rules.always, 'IgnoreCase')) { Done @{ ok = $false; reason = 'blocked'; title = $title; url = $url; proc = $proc } }
  $hay = $url.ToLower()
  foreach ($w in $rules.blocked) { if ($w -and $hay.Contains([string]$w)) { Done @{ ok = $false; reason = 'blocked'; word = $w; title = $title; url = $url; proc = $proc } } }
}

$doc = $null; $text = ''; $tries = 0
for ($i = 0; $i -lt 5; $i++) {
  $tries++
  if ($i -gt 0) { Start-Sleep -Milliseconds 1200; $docs = Walk }
  $doc = PickDoc $docs
  if ($doc) { $text = ReadText $doc; if ($text.Length -ge 80) { break } }
}
if (-not $doc) { Done @{ ok = $true; title = $title; url = $url; schemeGuessed = $schemeGuessed; proc = $proc; text = ''; tables = @(); note = 'nodoc'; tries = $tries } }

# Tables: rows and cells through the grid interface; header names when the page marks them.
$tables = @()
$cells = 0
$tconds = New-Object System.Windows.Automation.OrCondition((Cond $CT::Table), (Cond $CT::DataGrid))
foreach ($tb in $doc.FindAll($TS::Descendants, $tconds)) {
  if ($tables.Count -ge 12 -or $cells -ge 25000) { break }
  $gp = $null
  if (-not $tb.TryGetCurrentPattern([System.Windows.Automation.GridPattern]::Pattern, [ref]$gp)) { continue }
  $rc = [Math]::Min($gp.Current.RowCount, 3000); $cc = [Math]::Min($gp.Current.ColumnCount, 40)
  if ($rc -lt 2 -or $cc -lt 2) { continue }
  $headers = @()
  $tpat = $null
  if ($tb.TryGetCurrentPattern([System.Windows.Automation.TablePattern]::Pattern, [ref]$tpat)) { foreach ($hh in $tpat.Current.GetColumnHeaders()) { $headers += ([string]$hh.Current.Name).Trim() } }
  $rows = New-Object System.Collections.Generic.List[object]
  for ($r = 0; $r -lt $rc; $r++) {
    $row = New-Object string[] $cc
    for ($c = 0; $c -lt $cc; $c++) {
      $it = $gp.GetItem($r, $c); $cells++
      $v = ''
      if ($it) {
        $v = [string]$it.Current.Name
        if (-not $v.Trim()) { $v = (@($it.FindAll($TS::Descendants, (Cond $CT::Text)) | ForEach-Object { [string]$_.Current.Name }) -join ' ') }
      }
      $row[$c] = $v.Trim()
    }
    $rows.Add($row)
    if ($cells -ge 25000) { break }
  }
  $tables += @{ caption = ([string]$tb.Current.Name).Trim(); headers = $headers; rows = $rows.ToArray() }
}
Done @{ ok = $true; title = $title; url = $url; schemeGuessed = $schemeGuessed; proc = $proc; text = $text; tables = $tables; docs = $docs.Count; tries = $tries }
`;

/** The PowerShell script with the privacy rules filled in. */
function script(rules = {}) {
  const r = { titleWords: rules.titleWords || [], blocked: rules.blocked || [], always: rules.always || '^$' };
  return PS.replace('__RULES__', Buffer.from(JSON.stringify(r), 'utf8').toString('base64'));
}

/** Browser window titles end with " - Microsoft Edge", " - Google Chrome" and similar. */
function pageTitle(t) {
  return String(t || '').replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+[-—–]\s+(Microsoft\s*Edge|Google Chrome|Mozilla Firefox|Firefox|Brave|Opera|Vivaldi|Chromium|Arc)(\s+(Beta|Dev|Canary))?$/i, '')
    .replace(/\s+[-—–]\s+(Personal|Work|Profile \d+|[^-—–]{1,40} \(profile\))$/i, '')
    .replace(/\s+and \d+ more pages?$/i, '').trim();
}

/** Tables from UI Automation often carry the header row as the first row. */
function fixTables(tables) {
  return (Array.isArray(tables) ? tables : tables ? [tables] : []).map((t) => {
    let rows = (Array.isArray(t.rows) ? t.rows : []).map((r) => (Array.isArray(r) ? r : [r]).map((c) => String(c == null ? '' : c)));
    let headers = (Array.isArray(t.headers) ? t.headers : t.headers ? [t.headers] : []).map(String).filter((h, i, a) => a.some(Boolean));
    if (headers.length && rows[0] && rows[0].join('|') === headers.join('|')) rows = rows.slice(1);
    if (!headers.length && rows.length > 2 && rows[0].every((c) => c && c.length < 60 && !/^[\d$€£.,% -]+$/.test(c))) headers = rows.shift();
    return { caption: String(t.caption || ''), headers, rows, kind: 'table' };
  }).filter((t) => t.rows.length);
}

/**
 * Read the browser page. Resolves to
 *   { ok: true, url, title, text, tables, proc } or
 *   { ok: false, reason: 'nobrowser' | 'private' | 'blocked' | 'error' | 'unsupported', ... }.
 */
function readBrowser(rules, { timeoutMs = 60000 } = {}) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, reason: 'unsupported' });
  return new Promise((resolve) => {
    const enc = Buffer.from(script(rules), 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { try { ps.kill(); } catch (_) { /* gone */ } resolve({ ok: false, reason: 'error', message: 'Reading the browser took too long.' }); }, timeoutMs);
    ps.on('error', (e) => { clearTimeout(t); resolve({ ok: false, reason: 'error', message: String(e.message || e) }); });
    ps.on('close', () => {
      clearTimeout(t);
      const s = out.trim();
      let r = null;
      try { r = JSON.parse(s.slice(s.indexOf('{'))); } catch (_) { r = null; }
      if (!r) return resolve({ ok: false, reason: 'error', message: (err || s || 'No answer from Windows').slice(0, 300) });
      if (r.title) r.title = pageTitle(r.title);
      if (r.ok) r.tables = fixTables(r.tables);
      resolve(r);
    });
  });
}

module.exports = { readBrowser, script, pageTitle, fixTables };
