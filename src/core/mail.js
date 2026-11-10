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
    text: text.replace(/\r\n/g, '\n'), attachments: acc.attachments,
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
  return {
    subject: info.subject || '', from: `${info.senderName || ''}${info.senderSmtpAddress || info.senderEmail ? ` <${info.senderSmtpAddress || info.senderEmail}>` : ''}`.trim(), to, cc,
    date: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : '', text: String(text).replace(/\r\n/g, '\n').trim(), attachments,
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

/** "Jane Doe <jane@acme.com>" → { name, email } */
function address(s) {
  const str = String(s || '').split(/[,;](?![^<]*>)/)[0].trim();
  const m = str.match(/^"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim() || m[2], email: m[2].trim().toLowerCase() };
  const e = str.match(/[\w.+'-]+@[\w-]+(\.[\w-]+)+/);
  return { name: e ? str.replace(e[0], '').replace(/[<>"()]/g, '').trim() || e[0] : str, email: e ? e[0].toLowerCase() : '' };
}

module.exports = { parseEml, parseMsg, parsePasted, address, htmlToText, decodeWords };
