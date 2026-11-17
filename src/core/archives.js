'use strict';
// Readers for exports that hold many things at once, all on this PC:
//  - Outlook data files (.pst): the emails in every folder, newest first.
//  - OneNote: a section (.one), a whole notebook (.onepkg, a cabinet of
//    .one files) and a page saved as a single web page (.mht / .mhtml).
//    OneNote PDF and Word exports are read like any other PDF or Word file.

const zlib = require('zlib');
const mail = require('./mail');

// ------------------------------------------------------------------ Outlook
const MAIL_CLASS = /^IPM\.(Note|Schedule\.Meeting)/i;

/**
 * Emails in an Outlook .pst (a path or the bytes), newest first.
 * `since` (YYYY-MM-DD) and `limit` keep a big archive manageable; `scanMax` caps how many are looked at.
 */
function readPst(source, { since = null, limit = 100, scanMax = 50000 } = {}) {
  const { PSTFile } = require('pst-extractor');
  const pst = new PSTFile(typeof source === 'string' ? source : Buffer.from(source));
  const found = [];
  let scanned = 0;
  const walk = (folder, trail, depth) => {
    if (depth > 12 || scanned >= scanMax) return;
    if (folder.contentCount > 0) {
      let m = folder.getNextChild();
      while (m && scanned < scanMax) {
        scanned += 1;
        try {
          if (MAIL_CLASS.test(m.messageClass || '')) {
            const when = m.messageDeliveryTime || m.clientSubmitTime || null;
            const date = when ? new Date(when).toISOString() : '';
            if (!since || !date || date.slice(0, 10) >= since) found.push({ m, date, folder: trail });
          }
        } catch (_) { /* skip a damaged message */ }
        m = folder.getNextChild();
      }
    }
    if (folder.hasSubfolders) for (const f of folder.getSubFolders()) walk(f, trail ? `${trail}/${f.displayName}` : f.displayName, depth + 1);
  };
  try {
    walk(pst.getRootFolder(), '', 0);
    found.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const emails = found.slice(0, limit).map(({ m, date, folder }) => {
      const atts = [];
      for (let i = 0; i < Math.min(m.numberOfAttachments || 0, 20); i++) { try { const a = m.getAttachment(i); atts.push(a.longFilename || a.filename || `attachment ${i + 1}`); } catch (_) { /* skip */ } }
      let body = '';
      try { body = m.body || ''; } catch (_) { body = ''; }
      if (!body.trim()) { try { body = mail.htmlToText(m.bodyHTML || ''); } catch (_) { body = ''; } }
      const from = m.senderEmailAddress && /@/.test(m.senderEmailAddress) ? `${m.senderName ? `"${m.senderName}" ` : ''}<${m.senderEmailAddress}>` : (m.senderName || '');
      return { subject: m.subject || '(no subject)', from, to: m.displayTo || '', cc: m.displayCC || '', date, folder, body: body.replace(/\r\n/g, '\n').slice(0, 60000), attachments: atts };
    });
    return { total: found.length, scanned, emails };
  } finally {
    try { pst.close(); } catch (_) { /* ignore */ }
  }
}

/** An email from a .pst as .eml bytes, so it is read like any dropped email. */
function toEml(e) {
  const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ');
  const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
  const date = e.date ? new Date(e.date).toUTCString() : '';
  const note = e.attachments && e.attachments.length ? `\n\n[Attachments in Outlook: ${e.attachments.join(', ')}]` : '';
  const head = [`From: ${enc(clean(e.from))}`, `To: ${enc(clean(e.to))}`, e.cc ? `Cc: ${enc(clean(e.cc))}` : '', `Subject: ${enc(clean(e.subject))}`, date ? `Date: ${date}` : '',
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64'].filter(Boolean).join('\r\n');
  return Buffer.from(`${head}\r\n\r\n${Buffer.from(`${e.body || ''}${note}`, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n')}\r\n`, 'latin1');
}

// ------------------------------------------------------------------ OneNote
/** A page saved from OneNote as a single web page (.mht / .mhtml). */
function mhtText(bytes) {
  const e = mail.parseEml(bytes);
  return { title: e.subject || '', text: e.text };
}

const NOISE = /^(Calibri|Calibri Light|Cambria|Arial|Segoe UI|Times New Roman|Consolas|Verdana|Tahoma|Courier New|Normal|PageTitle|Heading \d|Title|Quote|Citation|Code|Remember for later|PageDateTime|PageTitle|cite|blockquote|Comic Sans MS|Georgia|Trebuchet MS|Wingdings|Symbol|To Do|Important|Question|Idea|Highlight|Contact|Address|Phone number|Website to visit|Project [AB]|Movie to see|Book to read|Music to listen to|Source for article|Remember for blog|Discuss with \w+|Send in email|Schedule meeting|Call back|To Do priority \d|Client request|Definition|en-US|en-GB|fr-FR|Default)$/i;

/**
 * Text from a OneNote section (.one). The format is binary and not published in a way that is easy to read,
 * so this pulls out the runs of Unicode text it stores (titles, outlines, paragraphs), in order, and drops
 * style names, GUIDs and repeats. Good enough to read and plan from.
 */
function oneText(bytes) {
  const b = Buffer.from(bytes);
  const ok = (c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 0xd800 && c !== 0xfffd) || (c >= 0xe000 && c < 0xfff0);
  const runs = oneTextRuns(b, ok);
  // Text can sit at an odd offset too; read again shifted by one byte and keep whichever finds more letters.
  const letters = (arr) => arr.join('').replace(/[^A-Za-zÀ-ɏ]/g, '').length;
  const shifted = b.length > 2 ? oneTextRuns(b.subarray(1), ok) : [];
  const pick = letters(shifted) > letters(runs) ? shifted : runs;
  const seen = new Set();
  const lines = [];
  for (const r of pick) {
    for (let t of r.split(/\r\n|\r|\n|\u000b/)) {
      t = t.replace(/\uFDDF?\s*HYPERLINK\s+"[^"]*"/g, '').replace(/[\uFDD0-\uFDEF]/g, '').replace(/\s+/g, ' ').trim();
      if (/^<[a-z]/i.test(t)) continue; // stored XML
      if (t.length < 3 || NOISE.test(t)) continue;
      if (/^[{(]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[)}]?$/i.test(t)) continue;
      const letterShare = t.replace(/[^A-Za-zÀ-ɏ0-9 ]/g, '').length / t.length;
      if (letterShare < 0.6 || !/[A-Za-zÀ-ɏ]{2}/.test(t)) continue;
      if (/[Ā-￿]/.test(t) && (t.match(/[Ā-￿]/g) || []).length > t.length * 0.3) continue; // bytes read as CJK by mistake
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push(t);
    }
  }
  return lines.join('\n');
}
function oneTextRuns(b, ok) {
  const runs = [];
  let cur = '';
  for (let i = 0; i + 1 < b.length; i += 2) {
    const c = b[i] | (b[i + 1] << 8);
    if (ok(c) && !(c >= 0x7f && c < 0xa0)) cur += String.fromCharCode(c);
    else { if (cur.length >= 3) runs.push(cur); cur = ''; }
  }
  if (cur.length >= 3) runs.push(cur);
  return runs;
}

/**
 * Files inside a Microsoft cabinet (.cab, and OneNote's .onepkg). Stored and MSZIP folders are supported,
 * which is what OneNote writes; LZX and Quantum are not.
 */
function cabFiles(bytes) {
  const b = Buffer.from(bytes);
  if (b.toString('latin1', 0, 4) !== 'MSCF') throw new Error('This is not a OneNote notebook package (.onepkg) or cabinet file.');
  const coffFiles = b.readUInt32LE(16);
  const cFolders = b.readUInt16LE(26);
  const cFiles = b.readUInt16LE(28);
  const flags = b.readUInt16LE(30);
  let p = 36;
  let cbFolderReserve = 0;
  let cbDataReserve = 0;
  if (flags & 4) { const cbHeader = b.readUInt16LE(36); cbFolderReserve = b[38]; cbDataReserve = b[39]; p = 40 + cbHeader; }
  if (flags & 1) { while (b[p]) p++; p++; while (b[p]) p++; p++; } // previous cabinet
  if (flags & 2) { while (b[p]) p++; p++; while (b[p]) p++; p++; } // next cabinet
  const folders = [];
  for (let i = 0; i < cFolders; i++) {
    folders.push({ coffCabStart: b.readUInt32LE(p), cCFData: b.readUInt16LE(p + 4), typeCompress: b.readUInt16LE(p + 6) & 0x0f });
    p += 8 + cbFolderReserve;
  }
  const data = folders.map((f) => {
    if (f.typeCompress !== 0 && f.typeCompress !== 1) throw new Error('This notebook package uses a compression Boardenda cannot read yet. Export the notebook or sections as PDF or Word instead.');
    const out = [];
    let q = f.coffCabStart;
    let window = Buffer.alloc(0);
    for (let k = 0; k < f.cCFData; k++) {
      const cbData = b.readUInt16LE(q + 4);
      const start = q + 8 + cbDataReserve;
      const chunk = b.subarray(start, start + cbData);
      let plain;
      if (f.typeCompress === 0) plain = chunk;
      else {
        if (chunk[0] !== 0x43 || chunk[1] !== 0x4b) throw new Error('The notebook package looks damaged.');
        plain = window.length ? zlib.inflateRawSync(chunk.subarray(2), { dictionary: window }) : zlib.inflateRawSync(chunk.subarray(2));
      }
      out.push(plain);
      window = Buffer.concat([window, plain]).subarray(-32768);
      q = start + cbData;
    }
    return Buffer.concat(out);
  });
  const files = [];
  p = coffFiles;
  for (let i = 0; i < cFiles; i++) {
    const size = b.readUInt32LE(p);
    const off = b.readUInt32LE(p + 4);
    const iFolder = b.readUInt16LE(p + 8);
    const attribs = b.readUInt16LE(p + 14);
    let e = p + 16;
    while (b[e]) e++;
    const name = b.toString(attribs & 0x80 ? 'utf8' : 'latin1', p + 16, e);
    p = e + 1;
    const folder = data[iFolder];
    if (folder) files.push({ name: name.replace(/\\/g, '/'), bytes: folder.subarray(off, off + size) });
  }
  return files;
}

/** The sections of a OneNote notebook package, each with its text. */
function onepkgSections(bytes) {
  return cabFiles(bytes)
    .filter((f) => /\.one$/i.test(f.name) && !/OneNote_RecycleBin/i.test(f.name))
    .map((f) => ({ name: f.name, text: oneText(f.bytes) }))
    .filter((s) => s.text.trim());
}

module.exports = { readPst, toEml, mhtText, oneText, cabFiles, onepkgSections };
