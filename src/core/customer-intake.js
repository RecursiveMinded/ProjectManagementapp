'use strict';
// Getting customers in: read a pasted email or signature into a proposed
// customer with contacts, and import customers from Excel, CSV or vCard files.

const ExcelJS = require('exceljs');
const { parseCsv } = require('./io');

const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|gmx|mail|zoho|yandex|comcast|verizon|att|sbcglobal|btinternet)\./i;
const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)\s?|\d{2,4}[\s.-])?\d{3,4}[\s.-]?\d{3,4}(?:\s*(?:x|ext\.?)\s*\d{1,5})?/g;
const COMPANY_RE = /\b(inc|inc\.|llc|l\.l\.c\.|ltd|limited|corp|corporation|co\.|company|group|gmbh|plc|pty|s\.a\.|ag|bv|holdings|partners|solutions|services|systems|technologies|technology|labs|consulting|industries|international|enterprises|associates|health|healthcare|bank|university|hospital|retail|foods|logistics)\b/i;
const TITLE_RE = /\b(ceo|cfo|cto|coo|cio|ciso|vp|svp|evp|president|director|manager|head|lead|engineer|specialist|analyst|consultant|coordinator|officer|owner|founder|partner|principal|administrator|admin|executive|representative|rep|associate|supervisor|architect|developer|technician|buyer|purchasing|procurement|sales|account|operations|marketing|support|assistant|chief)\b/i;
const STREET_RE = /\d+.*\b(st|st\.|street|ave|ave\.|avenue|rd|rd\.|road|blvd|boulevard|dr|dr\.|drive|ln|lane|way|pkwy|parkway|suite|ste|floor|fl|court|ct|place|pl|highway|hwy|circle|plaza|square|po box)\b/i;
const CITY_RE = /^[A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5}(-\d{4})?$|^[A-Za-z .'-]+,?\s+[A-Z]{2}\s+\d{5}|\b\d{5}(-\d{4})?\b|[A-Z]\d[A-Z]\s?\d[A-Z]\d|\b[A-Z]{1,2}\d{1,2}[A-Z]?\s\d[A-Z]{2}\b/;
const SIGNOFF_RE = /^(thanks|thank you|many thanks|regards|best|best regards|kind regards|warm regards|sincerely|cheers|respectfully|all the best|br|thx|--|—|__+|sent from my)\b[ ,!.]*$/i;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const titleCase = (s) => s.replace(/(^|[\s-])(\w)/g, (m, a, b) => a + b.toUpperCase());
const looksLikeName = (s) => /^[A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]*){1,3}$/.test(s) && !COMPANY_RE.test(s) && !TITLE_RE.test(s) && s.length <= 40;

function companyFromDomain(email) {
  const d = String(email || '').split('@')[1] || '';
  if (!d || FREE_MAIL.test(d)) return '';
  const stem = d.split('.').slice(-2, -1)[0] || d.split('.')[0];
  return titleCase(stem.replace(/[-_]+/g, ' '));
}
const domainOf = (email) => (String(email || '').split('@')[1] || '').toLowerCase();

/** Name from an address like "dana.ruiz@x.com". */
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0];
  if (!/[._-]/.test(local) || /\d/.test(local) || /^(info|sales|support|admin|hello|contact|office|billing|accounts|noreply|no-reply)$/i.test(local)) return '';
  return titleCase(local.replace(/[._-]+/g, ' '));
}

function phonesIn(line) {
  const out = [];
  for (const m of line.match(PHONE_RE) || []) {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 16) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(m.trim())) continue;
    out.push(m.trim());
  }
  return out;
}

/**
 * Read pasted text (an email, a thread, or a signature) into a proposed
 * customer: { customer: { name, website, phone, email, address, industry }, contacts: [...], confidence }.
 */
function parseContactText(text) {
  const raw = String(text || '').replace(/\r/g, '');
  const lines = raw.split('\n').map((l) => l.replace(/^[>\s]+/, '').trim());
  const contacts = [];
  const byEmail = {};
  const add = (c) => {
    const email = (c.email || '').toLowerCase();
    if (email && byEmail[email]) { const k = byEmail[email]; for (const f of ['name', 'title', 'phone', 'mobile']) if (!k[f] && c[f]) k[f] = c[f]; return k; }
    const k = { name: c.name || '', title: c.title || '', email: c.email || '', phone: c.phone || '', mobile: c.mobile || '' };
    contacts.push(k);
    if (email) byEmail[email] = k;
    return k;
  };

  // Header lines: From / To / Cc with "Name <email>".
  for (const l of lines) {
    const h = l.match(/^(from|to|cc|reply-to)\s*:\s*(.+)$/i);
    if (!h) continue;
    for (const part of h[2].split(/[;,](?![^<]*>)/)) {
      const m = part.match(/"?([^"<]*?)"?\s*<([^>]+)>/) || part.match(/()([^\s<>]+@[^\s<>]+)/);
      if (!m) continue;
      let name = clean(m[1]).replace(/^'|'$/g, '');
      if (/,/.test(name)) { const [last, first] = name.split(',').map(clean); name = `${first} ${last}`; }
      add({ name: name && !name.includes('@') ? name : nameFromEmail(m[2]), email: m[2].trim(), from: /^from/i.test(h[1]) });
    }
  }

  // The signature: the block after the last sign-off, or the last short block.
  let sigStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (SIGNOFF_RE.test(lines[i])) { sigStart = i + 1; break; }
  const firstHeader = lines.findIndex((l) => /^(from|sent|to|subject|date)\s*:/i.test(l));
  if (sigStart < 0) {
    // No sign-off: the whole paste may be a signature, or the signature is the last block.
    const blocks = raw.split(/\n\s*\n/);
    const last = blocks.map((b) => b.trim()).filter(Boolean);
    sigStart = last.length ? lines.length - last[last.length - 1].split('\n').length : 0;
    if (lines.filter(Boolean).length <= 12) sigStart = 0;
  }
  let sigEnd = lines.length;
  if (firstHeader > sigStart) sigEnd = firstHeader; // stop at a quoted earlier email
  const sig = lines.slice(Math.max(0, sigStart), sigEnd).filter((l) => l && !/^(from|to|cc|sent|date|subject)\s*:/i.test(l));

  const out = { name: '', website: '', phone: '', email: '', address: '', industry: '' };
  const person = {};
  const addr = [];
  for (const l0 of sig) {
    const l = l0.replace(/^[|•·\s]+|[|•·\s]+$/g, '');
    if (!l) continue;
    const emails = l.match(EMAIL_RE) || [];
    const urls = (l.match(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|us|uk|ca|au|de|biz|info|health|tech|ai|app)(?:\/[^\s|]*)?/gi) || [])
      .filter((u) => !emails.some((e) => e.toLowerCase().includes(u.toLowerCase().replace(/^https?:\/\//, ''))) && !/linkedin|twitter|x\.com|facebook|instagram|calendly|teams\.microsoft|zoom\.us/i.test(u));
    const phones = phonesIn(l.replace(EMAIL_RE, ''));
    if (emails.length) { if (!person.email) person.email = emails[0]; }
    if (urls.length && !out.website) out.website = /^https?:/i.test(urls[0]) ? urls[0] : `https://${urls[0].replace(/^www\./i, 'www.')}`;
    if (phones.length) {
      for (const seg of l.split(/\s*[|•·]\s*|\s{2,}/)) {
        const p = phonesIn(seg)[0];
        if (!p) continue;
        if (/\b(fax|f:)/i.test(seg)) continue;
        if (/\b(m|mob|mobile|cell|c)\b[\s.:]/i.test(seg) || /^(m|c)\s*[:.]/i.test(seg)) { if (!person.mobile) person.mobile = p; } else if (!person.phone) person.phone = p;
      }
      continue;
    }
    if (emails.length || urls.length) continue;
    if (STREET_RE.test(l) || (addr.length && CITY_RE.test(l))) { addr.push(l); continue; }
    // "Title | Company" or "Title, Company" on one line.
    const parts = l.split(/\s*[|]\s*|\s+[-–—]\s+|\s+at\s+|,\s+(?=[A-Z])/).map(clean).filter(Boolean);
    for (const p of parts) {
      if (!person.name && looksLikeName(p)) person.name = p;
      else if (!person.title && TITLE_RE.test(p) && p.length <= 70 && !COMPANY_RE.test(p.replace(TITLE_RE, ''))) person.title = p;
      else if (!out.name && (COMPANY_RE.test(p) || (person.name && person.title && p.length <= 60 && /^[A-Z0-9]/.test(p) && !/[.!?]$/.test(p)))) out.name = p;
    }
  }
  out.address = addr.join(', ');
  // Fill gaps from what we have.
  const fromHeader = contacts.find((c) => c.email && (!person.email || c.email.toLowerCase() === person.email.toLowerCase()));
  if (!person.name && fromHeader) person.name = fromHeader.name;
  if (!person.email && fromHeader) person.email = fromHeader.email;
  if (!person.name && person.email) person.name = nameFromEmail(person.email);
  if (person.name || person.email) {
    const k = add(person);
    // Put the signature's person first.
    contacts.splice(contacts.indexOf(k), 1);
    contacts.unshift(k);
  }
  for (const e of raw.match(EMAIL_RE) || []) if (!byEmail[e.toLowerCase()]) add({ email: e, name: nameFromEmail(e) });
  const mainEmail = (contacts[0] || {}).email || '';
  if (!out.name) out.name = companyFromDomain(mainEmail);
  if (!out.website && mainEmail && !FREE_MAIL.test(domainOf(mainEmail))) out.website = `https://${domainOf(mainEmail)}`;
  // Keep contacts from the same company as the main one; others are left unticked.
  const dom = domainOf(mainEmail);
  for (const c of contacts) c.include = !dom || FREE_MAIL.test(dom) ? c === contacts[0] : domainOf(c.email) === dom || !c.email;
  if (contacts[0]) contacts[0].primary = true;
  let confidence = 0;
  if (out.name) confidence += 0.35;
  if (contacts[0] && contacts[0].name) confidence += 0.3;
  if (contacts[0] && contacts[0].email) confidence += 0.2;
  if (contacts[0] && (contacts[0].phone || contacts[0].mobile)) confidence += 0.15;
  return { customer: out, contacts: contacts.slice(0, 12), confidence: Math.round(confidence * 100) / 100 };
}

// --------------------------------------------------------------- import
const FIELDS = [
  ['name', 'Customer name', /^(customer|customer name|company|company name|account|account name|client|client name|organisation|organization|business)$/],
  ['accountNo', 'Account no.', /^(account (no|number|#|id)|customer (no|number|#|id)|acct|id|ref|reference)\.?$/],
  ['status', 'Status', /^(status|stage|type)$/],
  ['industry', 'Industry', /^(industry|sector|vertical|segment)$/],
  ['phone', 'Main phone', /^(main phone|company phone|business phone|phone|telephone|tel|office phone)$/],
  ['email', 'Main email', /^(main email|company email|general email)$/],
  ['website', 'Website', /^(website|web site|web|url|homepage|domain)$/],
  ['address', 'Address', /^(address|street|street address|business address|location|city|mailing address)$/],
  ['tags', 'Tags', /^(tags|labels|categories|category)$/],
  ['notes', 'Notes', /^(notes|note|comments|description|details)$/],
  ['contact', 'Contact name', /^(contact|contact name|full name|name|person|primary contact|main contact)$/],
  ['contactFirst', 'Contact first name', /^(first name|given name|first)$/],
  ['contactLast', 'Contact last name', /^(last name|surname|family name|last)$/],
  ['contactTitle', 'Contact title', /^(title|job title|role|position|contact title)$/],
  ['contactEmail', 'Contact email', /^(email|e-mail|email address|e-mail address|contact email|email 1|e-mail 1)$/],
  ['contactPhone', 'Contact phone', /^(contact phone|direct|direct phone|work phone|business phone 2|phone 2)$/],
  ['contactMobile', 'Contact mobile', /^(mobile|mobile phone|cell|cell phone|contact mobile)$/],
  ['device', 'Device name', /^(device|device name|equipment|asset|asset name|terminal|unit)$/],
  ['deviceKind', 'Device type', /^(device type|equipment type|asset type|kind)$/],
  ['deviceModel', 'Device model', /^(model|device model|model number)$/],
  ['deviceSerial', 'Serial number', /^(serial|serial no|serial number|s\/n|sn|serial #)\.?$/],
  ['deviceLocation', 'Device location', /^(device location|site|store|install location|room)$/],
  ['deviceStatus', 'Device status', /^(device status|equipment status)$/],
  ['deviceInstalled', 'Installed on', /^(installed|install date|installed on|date installed)$/],
];
const EXAMPLE_RE = /^\s*example\b/i;

function guessField(title, taken) {
  const t = String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
  for (const [k, , re] of FIELDS) if (re.test(t) && !taken.has(k)) return k;
  return 'skip';
}

function parseVcf(text) {
  const rows = [['Customer name', 'Contact name', 'Contact title', 'Contact email', 'Contact phone', 'Contact mobile', 'Address', 'Website', 'Notes']];
  const unfolded = String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  for (const card of unfolded.split(/BEGIN:VCARD/i).slice(1)) {
    const get = (re) => { const m = card.match(re); return m ? m[1].replace(/\\,/g, ',').replace(/\\n/gi, ' ').trim() : ''; };
    const tel = (kind) => { const m = card.match(new RegExp(`^TEL[^:\\n]*${kind}[^:\\n]*:(.+)$`, 'im')); return m ? m[1].trim() : ''; };
    const adr = get(/^ADR[^:\n]*:(.+)$/im).split(';').map((x) => x.trim()).filter(Boolean).join(', ');
    rows.push([get(/^ORG[^:\n]*:([^;\n]+)/im), get(/^FN[^:\n]*:(.+)$/im), get(/^TITLE[^:\n]*:(.+)$/im), get(/^EMAIL[^:\n]*:(.+)$/im),
      tel('WORK') || get(/^TEL[^:\n]*:(.+)$/im), tel('CELL'), adr, get(/^URL[^:\n]*:(.+)$/im), get(/^NOTE[^:\n]*:(.+)$/im)]);
  }
  return rows;
}

async function readRows(name, bytes) {
  if (/\.vcf$/i.test(name)) return parseVcf(Buffer.from(bytes).toString('utf8'));
  if (/\.xlsx$/i.test(name)) {
    const { readTable } = require('./io');
    return readTable(name, bytes);
  }
  if (/\.(csv|txt|tsv)$/i.test(name)) {
    const text = Buffer.from(bytes).toString('utf8').replace(/^﻿/, '');
    if (/\t/.test(text.split('\n')[0])) return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split('\t'));
    return parseCsv(text);
  }
  throw new Error('Choose an Excel (.xlsx), CSV or vCard (.vcf) file');
}

async function previewCustomers(name, bytes) {
  const rows = (await readRows(name, bytes)).map((r) => r.map((v) => (v == null ? '' : String(v))));
  if (rows.length < 2) throw new Error('No rows were found to import');
  const width = Math.max(...rows.map((r) => r.length));
  const header = rows[0].map((h, i) => String(h || '').trim() || `Column ${i + 1}`);
  while (header.length < width) header.push(`Column ${header.length + 1}`);
  const body = rows.slice(1).map((r) => { const y = [...r]; while (y.length < width) y.push(''); return y; }).filter((r) => r.some((v) => v.trim()));
  const taken = new Set();
  const columns = header.map((title, index) => { const field = guessField(title, taken); if (field !== 'skip') taken.add(field); return { index, title, field }; });
  // An Outlook-style list with only a "Company" and a "Name" works; one with only names uses them as customers.
  if (!taken.has('name')) {
    const c = columns.find((x) => x.field === 'contact');
    if (c && !columns.some((x) => x.field === 'contactEmail' || x.field === 'contactTitle')) c.field = 'name';
  }
  return { header, rows: body.slice(0, 1000), total: body.length, columns, fields: FIELDS.map(([k, l]) => [k, l]),
    examples: body.filter((r) => columns.some((c) => c.field === 'name' && EXAMPLE_RE.test(r[c.index]))).length };
}

/** Create or update customers from rows. Rows with the same customer add contacts and devices to it. */
function importCustomers(customers, { rows, columns }) {
  const col = {};
  for (const c of columns || []) if (c.field && c.field !== 'skip' && col[c.field] == null) col[c.field] = c.index;
  if (col.name == null && col.contact == null && col.email == null) throw new Error('Choose which column holds the customer name');
  const v = (r, k) => (col[k] == null ? '' : String(r[col[k]] || '').trim());
  const stats = { created: 0, updated: 0, contacts: 0, devices: 0, skipped: 0 };
  const seen = {};
  for (const r of rows || []) {
    let name = v(r, 'name');
    const contactName = v(r, 'contact') || [v(r, 'contactFirst'), v(r, 'contactLast')].filter(Boolean).join(' ');
    const contactEmail = v(r, 'contactEmail');
    if (!name) name = companyFromDomain(contactEmail || v(r, 'email')) || contactName;
    if (!name || EXAMPLE_RE.test(name)) { stats.skipped += 1; continue; }
    let existing = customers.byName(name);
    const patch = {};
    for (const k of ['accountNo', 'industry', 'phone', 'email', 'website', 'address', 'notes']) if (v(r, k)) patch[k] = k === 'notes' ? `<p>${v(r, k).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p>` : v(r, k);
    const st = v(r, 'status').toLowerCase().replace(/\s+/g, '_');
    if (st) patch.status = { lead: 'prospect', prospect: 'prospect', active: 'active', customer: 'active', current: 'active', on_hold: 'on_hold', hold: 'on_hold', paused: 'on_hold', former: 'former', inactive: 'former', lost: 'former', churned: 'former' }[st] || 'active';
    if (v(r, 'tags')) patch.tags = v(r, 'tags').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
    let id;
    if (existing) {
      id = existing.id;
      const cur = customers.get(id);
      const fill = {};
      for (const [k, val] of Object.entries(patch)) {
        if (k === 'tags') fill.tags = [...new Set([...(cur.tags || []), ...val])];
        else if (k === 'notes') { if (!String(cur.notes || '').includes(val)) fill.notes = `${cur.notes || ''}${val}`; } else if (!cur[k] || seen[id] == null) fill[k] = val;
      }
      if (Object.keys(fill).length) customers.save({ id, ...fill });
      if (seen[id] == null) stats.updated += 1;
    } else {
      id = customers.save({ name, ...patch });
      stats.created += 1;
      existing = { id };
    }
    seen[id] = true;
    if (contactName || contactEmail) {
      const cur = customers.get(id);
      const dup = cur.contacts.find((k) => (contactEmail && k.email.toLowerCase() === contactEmail.toLowerCase()) || (contactName && k.name.toLowerCase() === contactName.toLowerCase()));
      const k = { name: contactName || contactEmail.split('@')[0], title: v(r, 'contactTitle'), email: contactEmail, phone: v(r, 'contactPhone') || (col.phone == null ? '' : ''), mobile: v(r, 'contactMobile') };
      if (dup) customers.saveContact(id, { ...dup, ...Object.fromEntries(Object.entries(k).filter(([, x]) => x)) });
      else { customers.saveContact(id, k); stats.contacts += 1; }
    }
    const dev = v(r, 'device') || v(r, 'deviceModel');
    if (dev || v(r, 'deviceSerial')) {
      const cur = customers.get(id);
      const serial = v(r, 'deviceSerial');
      const d = { name: dev || serial, kind: v(r, 'deviceKind'), model: v(r, 'deviceModel'), serial, location: v(r, 'deviceLocation'), installed: toIso(v(r, 'deviceInstalled')),
        status: ({ active: 'active', 'in service': 'active', pending: 'pending', 'pending install': 'pending', repair: 'repair', 'needs repair': 'repair', broken: 'repair', retired: 'retired', removed: 'retired' })[v(r, 'deviceStatus').toLowerCase()] || 'active' };
      const dup = cur.devices.find((x) => (serial && x.serial.toLowerCase() === serial.toLowerCase()) || (!serial && x.name.toLowerCase() === d.name.toLowerCase()));
      if (dup) customers.saveDevice(id, { ...dup, ...Object.fromEntries(Object.entries(d).filter(([, x]) => x)) });
      else { customers.saveDevice(id, d); stats.devices += 1; }
    }
  }
  return stats;
}

function toIso(s) {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (!m) return '';
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  const [a, b] = [Number(m[1]), Number(m[2])];
  const [mo, d] = a > 12 ? [b, a] : [a, b];
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const SHEET = [
  ['Customer name', 'Required. Rows with the same customer add more contacts or devices to it.', ['EXAMPLE: Northwind Traders', 'EXAMPLE: Northwind Traders', 'EXAMPLE: Contoso Retail']],
  ['Account no.', 'Your reference.', ['NW-1042', 'NW-1042', 'CR-2210']],
  ['Status', 'Prospect, Active, On hold or Former.', ['Active', 'Active', 'Prospect']],
  ['Industry', '', ['Retail', 'Retail', 'Grocery']],
  ['Main phone', '', ['+1 555 0100', '', '+1 555 0200']],
  ['Website', '', ['https://northwind.example', '', '']],
  ['Address', '', ['12 Harbor Way, Seattle, WA', '', '']],
  ['Tags', 'Separated by commas.', ['pilot, priority', '', '']],
  ['Contact name', 'One contact per row.', ['Priya Shah', 'Marcus Lee', 'Dana Ruiz']],
  ['Contact title', '', ['Director of Operations', 'Finance manager', 'IT lead']],
  ['Contact email', '', ['priya@northwind.example', 'marcus@northwind.example', 'dana@contoso.example']],
  ['Contact phone', '', ['+1 555 0101', '+1 555 0102', '']],
  ['Contact mobile', '', ['', '', '+1 555 0201']],
  ['Device name', 'Optional. One device per row.', ['Front counter terminal', 'Mobile terminal', '']],
  ['Device model', '', ['PT-400', 'PT-200 Go', '']],
  ['Serial number', '', ['PT4-88231', 'PT2-10457', '']],
  ['Device location', '', ['Store 1, Seattle', 'Store 2, Tacoma', '']],
  ['Notes', '', ['Prefers quarterly billing', '', '']],
];

async function customerSheet() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Boardenda';
  const ws = wb.addWorksheet('Customers', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = SHEET.map(([h]) => ({ header: h, key: h, width: /name|email|address|location|website|title/i.test(h) ? 28 : 16 }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5A55D6' } };
  SHEET.forEach(([, note], i) => { if (note) head.getCell(i + 1).note = note; });
  for (let r = 0; r < 3; r++) ws.addRow(SHEET.map(([, , ex]) => ex[r]));
  for (let r = 2; r <= 300; r++) ws.getCell(`C${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Prospect,Active,On hold,Former"'] };
  const help = wb.addWorksheet('How to fill this in');
  help.columns = [{ header: 'Column', key: 'c', width: 22 }, { header: 'What to enter', key: 'w', width: 80 }];
  help.getRow(1).font = { bold: true };
  for (const [h, note] of SHEET) help.addRow({ c: h, w: note || 'Optional.' });
  help.addRow({ c: '', w: 'Rows that start with EXAMPLE are skipped. Delete them or type over them.' });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { parseContactText, previewCustomers, importCustomers, customerSheet, parseVcf, companyFromDomain, FIELDS };
