'use strict';
const crypto = require('crypto');

function uid(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}
function now() { return new Date().toISOString(); }
function today(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const t = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10) + (iso.length > 10 ? iso.slice(10) : '');
}
function daysBetween(a, b) {
  const ta = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const tb = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((tb - ta) / 86400000);
}
function parseJson(s, fallback) {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); } catch (_) { return fallback; }
}
function mondayOf(iso) {
  const t = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  const d = new Date(t).getUTCDay();
  return addDays(iso.slice(0, 10), -((d + 6) % 7));
}

module.exports = { uid, now, today, addDays, daysBetween, parseJson, mondayOf };
