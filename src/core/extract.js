'use strict';
// Turn documents into rows for import: Excel and CSV sheets, Word documents
// (tables, or lists and headings), PDFs and plain text, and images or scans
// read with OCR. Everything runs on this PC; nothing is uploaded.

const path = require('path');

const IMAGE_RE = /\.(png|jpe?g|bmp|gif|webp|tiff?)$/i;
const KINDS = { xlsx: 'Excel', csv: 'CSV', tsv: 'CSV', txt: 'Text', md: 'Text', docx: 'Word', pdf: 'PDF', image: 'Image (OCR)' };

function kindOf(name) {
  if (IMAGE_RE.test(name)) return 'image';
  const ext = (String(name).match(/\.([a-z0-9]+)$/i) || [])[1];
  return ext ? ext.toLowerCase() : 'txt';
}

const decode = (s) => String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').trim();

/** Tables in an HTML fragment, as arrays of rows of cell text. */
function htmlTables(html) {
  const out = [];
  for (const t of String(html).match(/<table[\s\S]*?<\/table>/gi) || []) {
    const rows = [];
    for (const tr of t.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (tr.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(decode);
      if (cells.some(Boolean)) rows.push(cells);
    }
    if (rows.length) out.push(rows);
  }
  return out;
}

/**
 * Rows from a Word document without tables: headings become groups and each
 * list item or short paragraph becomes an item. "Task - Owner - 2026-01-05"
 * style lines are split into columns when that pattern repeats.
 */
function outlineRows(html) {
  const blocks = [];
  const re = /<(h[1-6]|li|p)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) blocks.push({ tag: m[1].toLowerCase(), text: decode(m[2]) });
  let group = '';
  const items = [];
  const hasList = blocks.some((b) => b.tag === 'li');
  for (const b of blocks) {
    if (!b.text) continue;
    if (/^h/.test(b.tag)) { group = b.text; continue; }
    if (hasList && b.tag !== 'li') continue;
    if (!hasList && b.text.length > 160) continue;
    items.push({ group, text: b.text });
  }
  return linesToRows(items.map((x) => x.text), items.map((x) => x.group));
}

/**
 * Split lines into columns. Tabs, pipes, runs of 2+ spaces, " - " and " | "
 * separators are tried; the one giving the most consistent column count wins.
 */
function linesToRows(lines, groups) {
  const clean = lines.map((l) => String(l).replace(/^[\s>*•·\-–—▪◦●○■□☐☑✓✔]+\s*|^\(?\d{1,3}[.)]\s+/u, '').trim()).filter((l, i) => l || (groups && groups[i]));
  const splitters = [/\t+/, /\s*\|\s*/, /\s{2,}/, /\s+[-–—]\s+/, /\s*;\s*/, /\s*,\s+/];
  let best = null;
  for (const sp of splitters) {
    const parts = clean.map((l) => l.split(sp).map((x) => x.trim()).filter((x, i, a) => x || i < a.length - 1));
    // Single-cell title lines before the first split line don't count against the fit.
    const lead = parts.findIndex((p) => p.length > 1);
    const body = lead > 0 ? parts.slice(lead) : parts;
    const counts = body.map((p) => p.length).filter((n) => n > 1);
    if (counts.length < Math.max(2, body.length * 0.6)) continue;
    const mode = [...counts].sort((a, b) => counts.filter((x) => x === b).length - counts.filter((x) => x === a).length)[0];
    const fit = counts.filter((n) => n === mode).length / body.length;
    if (!best || fit > best.fit || (fit === best.fit && mode > best.mode)) best = { sp, mode, fit, parts };
  }
  let rows;
  if (best && best.fit >= 0.6) {
    // Titles above a table (one cell, before the first full row) are not items.
    const firstFull = best.parts.findIndex((p) => p.length > 1);
    if (firstFull > 0 && best.parts.slice(0, firstFull).every((p) => p.length === 1)) { best.parts = best.parts.slice(firstFull); if (groups) groups = groups.slice(firstFull); }
    rows = best.parts.map((p) => { const r = p.slice(0, best.mode); while (r.length < best.mode) r.push(''); if (p.length > best.mode) r[best.mode - 1] = p.slice(best.mode - 1).join(' '); return r; });
  } else rows = clean.map((l) => [l]);
  // Is the first row a header? Short, no dates or digits-heavy cells, and different in shape.
  const first = rows[0] || [];
  const looksHeader = first.length > 1 && first.every((c) => c && c.length < 30 && !/\d{2,}/.test(c)) && rows.length > 1;
  let header;
  if (looksHeader) { header = first; rows = rows.slice(1); } else header = rows[0] && rows[0].length > 1 ? ['Name', ...rows[0].slice(1).map((_, i) => `Column ${i + 2}`)] : ['Name'];
  if (groups && groups.some(Boolean)) {
    const g = looksHeader ? groups.slice(1) : groups;
    header = [...header, 'Group'];
    rows = rows.map((r, i) => [...r, g[i] || '']);
  }
  return [header, ...rows];
}

/** Lines of text from a PDF, rebuilt by position so table columns keep their gaps. */
async function pdfLines(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  const lines = [];
  for (let p = 1; p <= Math.min(doc.numPages, 50); p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3) * 3;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], w: it.width, s: it.str, f: Math.abs(it.transform[0]) || it.height || 10 });
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      const parts = rows.get(y).sort((a, b) => a.x - b.x);
      let line = '', end = null;
      for (const part of parts) {
        if (end != null) line += part.x - end > part.f * 0.4 ? '\t' : part.x - end > part.f * 0.1 ? ' ' : '';
        line += part.s;
        end = part.x + part.w;
      }
      lines.push(line.trim());
    }
  }
  await doc.destroy();
  return lines.filter(Boolean);
}

let worker = null;
let workerIdle = null;
async function ocr(bytes) {
  const { createWorker } = require('tesseract.js');
  const lang = require('@tesseract.js-data/eng');
  if (!worker) {
    worker = await createWorker('eng', 1, {
      langPath: lang.langPath.replace('app.asar', 'app.asar.unpacked'), gzip: true, cacheMethod: 'none',
      workerPath: require.resolve('tesseract.js/src/worker-script/node/index.js').replace('app.asar', 'app.asar.unpacked'),
      corePath: path.dirname(require.resolve('tesseract.js-core/package.json')).replace('app.asar', 'app.asar.unpacked'),
    });
    await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '3' });
  }
  clearTimeout(workerIdle);
  try {
    const { data } = await worker.recognize(Buffer.from(bytes));
    return { text: data.text || '', confidence: Math.round(data.confidence || 0) };
  } finally {
    // Free the OCR engine's memory after a minute of no use.
    workerIdle = setTimeout(() => { const w = worker; worker = null; if (w) w.terminate().catch(() => {}); }, 60000);
    if (workerIdle.unref) workerIdle.unref();
  }
}

/**
 * Read a file into rows. Returns { kind, rows: [header, ...rows], text?, notes: [] }.
 * readTable handles Excel and CSV.
 */
async function extract(name, bytes, readTable) {
  const kind = kindOf(name);
  const notes = [];
  if (kind === 'xlsx' || kind === 'csv' || kind === 'tsv') return { kind: KINDS[kind], rows: await readTable(name, bytes), notes };
  if (kind === 'docx') {
    const mammoth = require('mammoth');
    const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
    const tables = htmlTables(html).sort((a, b) => b.length * (b[0] || []).length - a.length * (a[0] || []).length);
    if (tables.length) {
      if (tables.length > 1) notes.push(`The document has ${tables.length} tables; the largest was used.`);
      return { kind: KINDS.docx, rows: tables[0], notes };
    }
    notes.push('No table found, so each list item or short paragraph became an item, and headings became groups.');
    return { kind: KINDS.docx, rows: outlineRows(html), notes };
  }
  if (kind === 'doc') throw new Error('Old .doc files cannot be read. Open it in Word and save it as .docx first.');
  if (kind === 'pdf') {
    const lines = await pdfLines(bytes);
    if (!lines.length) throw new Error('This PDF has no text layer (it is probably a scan). Save the page as an image and import that to read it with OCR.');
    return { kind: KINDS.pdf, rows: linesToRows(lines), text: lines.join('\n'), notes };
  }
  if (kind === 'image') {
    const { text, confidence } = await ocr(bytes);
    const lines = text.split(/\r?\n/).map((l) => l.replace(/\s*[|¦]\s*/g, '\t').replace(/ {3,}/g, '\t').replace(/^\t+|\t+$/g, '')).filter((l) => l.trim());
    if (!lines.length) throw new Error('No text could be read from this image. Try a sharper, straight-on picture.');
    notes.push(`Read with OCR (confidence ${confidence}%). Check names and dates before importing.`);
    return { kind: KINDS.image, rows: linesToRows(lines), text, notes, confidence };
  }
  const text = Buffer.from(bytes).toString('utf8').replace(/^﻿/, '');
  if (kind === 'json') throw new Error('Use Import board file for .json files');
  return { kind: KINDS.txt, rows: linesToRows(text.split(/\r?\n/)), text, notes };
}

module.exports = { extract, linesToRows, htmlTables, outlineRows, kindOf, IMAGE_RE };
