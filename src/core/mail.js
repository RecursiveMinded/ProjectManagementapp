'use strict';
// Read emails: Outlook .msg files, standard .eml files, and email text pasted
// from Outlook or a browser. Returns headers, the body as plain text, and the
// attachments so they can be read too. Everything runs on this PC.

const iconvSafe = (buf, charset) => {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^["']|["']$/g, '');
  if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') return buf.toString('utf8');
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'windows-1252' || cs === 'cp1252') return buf.toString('latin1');
  try { return require('iconv-lite').decode(buf, cs); } catch (_) { return buf.toString('utf8'); }
};

function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** RFC 2047 encoded words: =?utf-8?B?...?= and =?iso-8859-1?Q?...?= */
function decodeWords(s) {
  return String(s || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_, cs, enc, data) => {
    const buf = enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    return iconvSafe(buf, cs);
  });
}

function parseHeaders(block) {
  const out = {};
  const lines = block.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n');
  for (const l of lines) {
    const m = l.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (out[k] === undefined) out[k] = m[2];
  }
  return out;
}
function param(v, name) {
  const m = String(v || '').match(new RegExp(`${name}\\*?=(?:"([^"]*)"|([^;\\s]*))`, 'i'));
  if (!m) return '';
  const raw = m[1] != null ? m[1] : m[2];
  const star = raw.match(/^([^']*)''(.*)$/); // RFC 2231 filename*=utf-8''name
  return star ? decodeURIComponent(star[2]) : decodeWords(raw);
}
function decodeBody(buf, enc) {
  const e = String(enc || '').toLowerCase().trim();
  if (e === 'base64') return Buffer.from(buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (e === 'quoted-printable') {
    const s = buf.toString('latin1').replace(/=\r?\n/g, '');
    return Buffer.from(s.replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  }
  return buf;
}

/** Walk a MIME part, collecting text, html and attachments. */
function walkPart(buf, acc, depth = 0) {
  const raw = buf.toString('latin1');
  const split = raw.search(/\r?\n\r?\n/);
  const head = split < 0 ? raw : raw.slice(0, split);
  const bodyStart = split < 0 ? raw.length : raw.indexOf('\n', raw.indexOf('\n', split) + 1) + 0;
  const h = parseHeaders(head);
  const body = Buffer.from(raw.slice(split < 0 ? raw.length : raw.slice(split).match(/^\r?\n\r?\n/)[0].length + split), 'latin1');
  void bodyStart;
  const ct = h['content-type'] || 'text/plain';
  const type = ct.split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/') && depth < 8) {
    const b = param(ct, 'boundary');
    if (!b) return;
    const parts = body.toString('latin1').split(new RegExp(`\\r?\\n?--${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
    for (const p of parts.slice(1)) if (p.trim()) walkPart(Buffer.from(p, 'latin1'), acc, depth + 1);
    return;
  }
  const disp = h['content-disposition'] || '';
  const name = param(disp, 'filename') || param(ct, 'name');
  const data = decodeBody(body, h['content-transfer-encoding']);
  if (type === 'message/rfc822' && depth < 4) {
    const inner = parseEml(data);
    acc.attachments.push({ name: `${inner.subject || 'Forwarded email'}.eml`, bytes: data, contentType: type });
    return;
  }
  if (name || /attachment/i.test(disp)) { acc.attachments.push({ name: name || 'attachment', bytes: data, contentType: type }); return; }
  if (type === 'text/plain') acc.text.push(iconvSafe(data, param(ct, 'charset')));
  else if (type === 'text/html') acc.html.push(iconvSafe(data, param(ct, 'charset')));
}

/** Details from email headers: importance, categories, ids for threading. */
function headerMeta(h) {
  const imp = String(h.importance || h.priority || '').toLowerCase();
  const xp = String(h['x-priority'] || '').trim();
  const importance = /high|urgent/.test(imp) || /^[12]\b/.test(xp) ? 'high' : /low|non-urgent/.test(imp) || /^[45]\b/.test(xp) ? 'low' : '';
  const cats = decodeWords(h.keywords || h['x-ms-exchange-organization-categories'] || h.categories || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  return { importance, categories: cats, messageId: String(h['message-id'] || '').trim(), inReplyTo: String(h['in-reply-to'] || '').trim(), threadTopic: decodeWords(h['thread-topic'] || ''), sensitivity: String(h.sensitivity || '').trim() };
}

/** Parse an .eml file (bytes) into { subject, from, to, cc, date, text, attachments }. */
function parseEml(bytes) {
  const buf = Buffer.from(bytes);
  const raw = buf.toString('latin1');
  const split = raw.search(/\r?\n\r?\n/);
  const h = parseHeaders(split < 0 ? raw : raw.slice(0, split));
  const acc = { text: [], html: [], attachments: [] };
  walkPart(buf, acc);
  const text = acc.text.join('\n\n').trim() || htmlToText(acc.html.join('\n'));
  return {
    subject: decodeWords(h.subject || ''), from: decodeWords(h.from || ''), to: decodeWords(h.to || ''), cc: decodeWords(h.cc || ''),
    date: h.date ? new Date(h.date).toString() !== 'Invalid Date' ? new Date(h.date).toISOString() : h.date : '',
    text: text.replace(/\r\n/g, '\n'), attachments: acc.attachments, meta: headerMeta(h),
  };
}

/** Parse an Outlook .msg file. */
function parseMsg(bytes) {
  const Mod = require('@kenjiuno/msgreader');
  const MsgReader = Mod.default || Mod;
  const r = new MsgReader(Buffer.from(bytes));
  const info = r.getFileData();
  if (info.error) throw new Error(`This Outlook message could not be read (${info.error}).`);
  const who = (x) => (x ? `${x.name || ''}${x.email || x.smtpAddress ? ` <${x.smtpAddress || x.email}>` : ''}`.trim() : '');
  const recips = info.recipients || [];
  const to = recips.filter((x) => !x.recipType || x.recipType === 'to').map(who).join(', ');
  const cc = recips.filter((x) => x.recipType === 'cc').map(who).join(', ');
  let text = info.body || '';
  if (!text && info.bodyHtml) text = htmlToText(info.bodyHtml);
  const attachments = [];
  for (const a of info.attachments || []) {
    try {
      const f = r.getAttachment(a);
      if (a.innerMsgContent) attachments.push({ name: `${a.name || a.fileName || 'Attached email'}.msg`.replace(/\.msg\.msg$/, '.msg'), bytes: Buffer.from(f.content), contentType: 'application/vnd.ms-outlook' });
      else attachments.push({ name: f.fileName || a.fileName || 'attachment', bytes: Buffer.from(f.content), contentType: a.attachMimeTag || '' });
    } catch (_) { /* skip an unreadable attachment */ }
  }
  const date = info.messageDeliveryTime || info.clientSubmitTime || info.creationTime || '';
  const meta = headerMeta(info.headers ? parseHeaders(String(info.headers)) : {});
  if (!meta.messageId && info.messageId) meta.messageId = info.messageId;
  if (!meta.threadTopic && info.conversationTopic) meta.threadTopic = info.conversationTopic;
  if (info.messageClass) meta.messageClass = info.messageClass;
  if (/IPM\.Schedule\.Meeting|IPM\.Appointment/i.test(info.messageClass || '')) meta.meeting = { start: info.apptStartWhole || '', end: info.apptEndWhole || '', location: info.apptLocation || '' };
  return {
    subject: info.subject || '', from: `${info.senderName || ''}${info.senderSmtpAddress || info.senderEmail ? ` <${info.senderSmtpAddress || info.senderEmail}>` : ''}`.trim(), to, cc,
    date: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : '', text: String(text).replace(/\r\n/g, '\n').trim(), attachments, meta,
  };
}

/** Headers in pasted email text (Outlook "From: / Sent: / To: / Subject:" blocks, or Gmail style). */
function parsePasted(text) {
  const t = String(text || '').replace(/\r\n/g, '\n');
  const head = t.slice(0, 1500);
  const get = (re) => { const m = head.match(re); return m ? m[1].trim() : ''; };
  const from = get(/^\s*From:\s*(.+)$/mi);
  const subject = get(/^\s*Subject:\s*(.+)$/mi);
  if (!from && !subject) return null;
  const date = get(/^\s*(?:Sent|Date):\s*(.+)$/mi);
  return { subject, from, to: get(/^\s*To:\s*(.+)$/mi), cc: get(/^\s*Cc:\s*(.+)$/mi), date: date && !Number.isNaN(Date.parse(date.replace(/ at /, ' '))) ? new Date(date.replace(/ at /, ' ')).toISOString() : date, text: t.trim(), attachments: [] };
}

/** Split an address list on commas or semicolons that are not inside quotes or <>. */
function splitList(s) {
  const out = [];
  let cur = '';
  let q = false;
  let a = false;
  for (const ch of String(s || '')) {
    if (ch === '"') q = !q;
    else if (ch === '<') a = true;
    else if (ch === '>') a = false;
    if ((ch === ',' || ch === ';') && !q && !a) {
      // "Martinez, Carla <c@x>" without quotes: a comma before a lone first name is part of the name.
      out.push(cur); cur = ''; continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  // Re-join "Last, First <email>" that was split on its comma.
  const fixed = [];
  for (const part of out.map((x) => x.trim()).filter(Boolean)) {
    const prev = fixed[fixed.length - 1];
    if (prev && !/[@<]/.test(prev) && /^[^@,]+<[^>]+>$/.test(part)) fixed[fixed.length - 1] = `${prev}, ${part}`;
    else fixed.push(part);
  }
  return fixed;
}

/** A display name written "Last, First" becomes "First Last". */
function niceName(n) {
  const t = String(n || '').replace(/^["']+|["']+$/g, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^([^,]+),\s*([^,]+)$/);
  return m && !/\b(inc|llc|ltd|co|corp)\b/i.test(m[2]) ? `${m[2].trim()} ${m[1].trim()}` : t;
}

/** "Jane Doe <jane@acme.com>" → { name, email } */
function address(s) {
  const str = splitList(s)[0] || '';
  const m = str.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: niceName(m[1]) || m[2].trim(), email: m[2].trim().toLowerCase() };
  const e = str.match(/[\w.+'-]+@[\w-]+(\.[\w-]+)+/);
  return { name: e ? niceName(str.replace(e[0], '').replace(/[<>"()\[\]]/g, '').replace(/^mailto:/i, '').trim()) || e[0] : niceName(str), email: e ? e[0].toLowerCase() : '' };
}

/** Every address in a list, as "Name <email>". */
function addresses(s) { return splitList(s).map(address).filter((a) => a.name || a.email); }

/** "RE: RE: FW: Subject" → "RE: Subject" */
function replySubject(s) { return `RE: ${String(s || '').replace(/^\s*((re|fw|fwd|aw|wg|tr|rv)\s*(\[\d+\])?\s*:\s*)+/i, '').trim()}`; }

const QUOTE_START = [
  /^\s*-{2,}\s*(original message|forwarded message|message d'origine|mensaje original|ursprüngliche nachricht)\s*-{2,}/i,
  /^\s*(from|de|von|van):\s.+$/i, // Outlook header block, checked with the next lines below
  /^\s*on .{6,120}(wrote|écrit|schrieb|escribió):\s*$/i,
  /^\s*_{10,}\s*$/,
];
const DISCLAIMER = /^\s*(confidentiality notice|disclaimer|this (e-?mail|message|communication)( and any attachments)? (is|are|may|contains?)|the information (contained )?in this (e-?mail|message)|if you (are not|have received) th(e|is) .*(intended|in error)|please consider the environment|caution: this email originated|external email|\[external\])/i;
const SIGNOFF = /^\s*(thanks|thank you|many thanks|thanks again|best|best regards|kind regards|regards|warm regards|cheers|sincerely|br|rgds|thx|merci|cordialement|saludos|gracias|mit freundlichen grüßen)[\s,!.]*$/i;

/**
 * Split an email body into the newest message and the quoted history, and drop
 * the signature, legal disclaimers and inline image placeholders.
 * Returns { latest, signature, history, greeting }.
 */
function cleanBody(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\[cid:[^\]]*\]/gi, '').replace(/ /g, ' ').split('\n');
  let cut = lines.length;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*>/.test(l) && lines.slice(i, i + 3).filter((x) => /^\s*>/.test(x)).length >= 2) { cut = i; break; }
    if (QUOTE_START[0].test(l) || QUOTE_START[2].test(l) || QUOTE_START[3].test(l)) { cut = i; break; }
    if (QUOTE_START[1].test(l) && lines.slice(i + 1, i + 6).some((x) => /^\s*(sent|date|envoyé|gesendet|enviado|to|subject|objet|betreff):/i.test(x))) { cut = i; break; }
  }
  const history = lines.slice(cut).join('\n').trim();
  let body = lines.slice(0, cut);
  // Legal disclaimers: drop from the first disclaimer paragraph on.
  const d = body.findIndex((l) => DISCLAIMER.test(l));
  if (d > 0) body = body.slice(0, d);
  // Signature: from "Thanks," / "--" to the end, when it comes after the main text.
  let sig = '';
  const dash = body.findIndex((l) => /^\s*--\s*$/.test(l));
  const off = body.findIndex((l, i) => i > 0 && SIGNOFF.test(l));
  const s = [dash, off].filter((i) => i > 0).sort((a, b) => a - b)[0];
  if (s !== undefined && body.slice(0, s).join(' ').trim().length > 20) { sig = body.slice(s).join('\n').trim(); body = body.slice(0, s); }
  let latest = body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  let greeting = '';
  const g = latest.match(/^(hi|hello|hey|dear|good (morning|afternoon|evening)|bonjour|hola|hallo)\b[^\n,]{0,40}[,!:]?\s*\n?/i);
  if (g) { greeting = g[0].trim(); latest = latest.slice(g[0].length).trim(); }
  return { latest, signature: sig, history, greeting };
}

module.exports = { headerMeta, parseEml, parseMsg, parsePasted, address, addresses, niceName, replySubject, cleanBody, htmlToText, decodeWords };
