'use strict';
// Formula column language: spreadsheet-style expressions over an item's
// columns. Column references are written {Column title}. Shared with the UI.
//
//   IF({Spent} > {Budget}, "Over budget", "On track")
//   ROUND({Hours} * {Rate}, 2)
//   DAYS({Due date}, TODAY())

class FormulaError extends Error {}

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '{') {
      const j = src.indexOf('}', i);
      if (j < 0) throw new FormulaError('Missing } after a column name');
      out.push({ t: 'ref', v: src.slice(i + 1, j).trim() });
      i = j + 1; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\' && j + 1 < src.length) j++; s += src[j]; j++; }
      if (j >= src.length) throw new FormulaError('Missing closing quote');
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    const num = src.slice(i).match(/^\d+(\.\d+)?([eE][-+]?\d+)?/);
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (id) { out.push({ t: 'id', v: id[0].toUpperCase() }); i += id[0].length; continue; }
    const op = src.slice(i).match(/^(<=|>=|<>|!=|==|&&|\|\||[-+*/^%(),<>=&!])/);
    if (op) { out.push({ t: 'op', v: op[0] }); i += op[0].length; continue; }
    throw new FormulaError(`Unexpected "${c}"`);
  }
  return out;
}

const PREC = { '||': 1, '&&': 2, '=': 3, '==': 3, '!=': 3, '<>': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '&': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7, '^': 8 };

function parse(src) {
  const toks = tokenize(String(src || ''));
  let p = 0;
  const peek = () => toks[p];
  const take = (v) => { const t = toks[p]; if (!t || (v && t.v !== v)) throw new FormulaError(v ? `Expected "${v}"` : 'Unexpected end of formula'); p++; return t; };
  function primary() {
    const t = take();
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'ref') return { k: 'ref', v: t.v };
    if (t.t === 'op' && t.v === '(') { const e = expr(0); take(')'); return e; }
    if (t.t === 'op' && (t.v === '-' || t.v === '!')) return { k: 'un', op: t.v, a: expr(PREC['^']) };
    if (t.t === 'op' && t.v === '+') return expr(PREC['^']);
    if (t.t === 'id') {
      if (t.v === 'TRUE') return { k: 'lit', v: true };
      if (t.v === 'FALSE') return { k: 'lit', v: false };
      take('(');
      const args = [];
      if (!(peek() && peek().v === ')')) { args.push(expr(0)); while (peek() && peek().v === ',') { p++; args.push(expr(0)); } }
      take(')');
      if (!FN[t.v]) throw new FormulaError(`Unknown function ${t.v}`);
      return { k: 'call', fn: t.v, args };
    }
    throw new FormulaError(`Unexpected "${t.v}"`);
  }
  function expr(min) {
    let left = primary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || PREC[t.v] == null || PREC[t.v] < min) break;
      p++;
      const pr = PREC[t.v];
      left = { k: 'bin', op: t.v, a: left, b: expr(t.v === '^' ? pr : pr + 1) };
    }
    return left;
  }
  if (!toks.length) return { k: 'lit', v: '' };
  const e = expr(0);
  if (p < toks.length) throw new FormulaError(`Unexpected "${toks[p].v}"`);
  return e;
}

// ---------------------------------------------------------------- runtime
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
const toNum = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const toStr = (v) => (v == null ? '' : typeof v === 'number' ? String(Math.round(v * 1e10) / 1e10) : String(v));
const truthy = (v) => (typeof v === 'string' ? v !== '' && v.toLowerCase() !== 'false' : !!v);
const dayMs = 86400000;
const toDay = (s) => (isDate(s) ? Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) : NaN);
const fromDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const flat = (args) => args.flat(Infinity);

function workdays(a, b) {
  let s = toDay(a), e = toDay(b);
  if (Number.isNaN(s) || Number.isNaN(e)) return '';
  let sign = 1;
  if (e < s) { [s, e] = [e, s]; sign = -1; }
  let n = 0;
  for (let t = s; t <= e; t += dayMs) { const d = new Date(t).getUTCDay(); if (d !== 0 && d !== 6) n++; }
  return n * sign;
}

const FN = {
  IF: (c, a, b) => (truthy(c) ? a : b === undefined ? '' : b),
  AND: (...a) => flat(a).every(truthy),
  OR: (...a) => flat(a).some(truthy),
  NOT: (a) => !truthy(a),
  XOR: (a, b) => truthy(a) !== truthy(b),
  SWITCH: (v, ...pairs) => { for (let i = 0; i + 1 < pairs.length; i += 2) if (toStr(pairs[i]) === toStr(v)) return pairs[i + 1]; return pairs.length % 2 ? pairs[pairs.length - 1] : ''; },
  SUM: (...a) => flat(a).reduce((s, x) => s + toNum(x), 0),
  AVERAGE: (...a) => { const f = flat(a).filter((x) => x !== '' && x != null); return f.length ? f.reduce((s, x) => s + toNum(x), 0) / f.length : 0; },
  MIN: (...a) => { const f = flat(a).filter((x) => x !== '' && x != null).map(toNum); return f.length ? Math.min(...f) : 0; },
  MAX: (...a) => { const f = flat(a).filter((x) => x !== '' && x != null).map(toNum); return f.length ? Math.max(...f) : 0; },
  COUNT: (...a) => flat(a).filter((x) => x !== '' && x != null && x !== false).length,
  ROUND: (v, d = 0) => { const m = 10 ** toNum(d); return Math.round(toNum(v) * m) / m; },
  ROUNDUP: (v, d = 0) => { const m = 10 ** toNum(d); return Math.ceil(toNum(v) * m) / m; },
  ROUNDDOWN: (v, d = 0) => { const m = 10 ** toNum(d); return Math.floor(toNum(v) * m) / m; },
  ABS: (v) => Math.abs(toNum(v)),
  SQRT: (v) => Math.sqrt(toNum(v)),
  POWER: (a, b) => toNum(a) ** toNum(b),
  MOD: (a, b) => toNum(a) % toNum(b),
  DIVIDE: (a, b) => (toNum(b) === 0 ? '' : toNum(a) / toNum(b)),
  MULTIPLY: (a, b) => toNum(a) * toNum(b),
  MINUS: (a, b) => toNum(a) - toNum(b),
  PERCENT: (a, b) => (toNum(b) === 0 ? 0 : (toNum(a) / toNum(b)) * 100),
  PI: () => Math.PI,
  CONCATENATE: (...a) => flat(a).map(toStr).join(''),
  LEN: (s) => toStr(s).length,
  UPPER: (s) => toStr(s).toUpperCase(),
  LOWER: (s) => toStr(s).toLowerCase(),
  TRIM: (s) => toStr(s).trim(),
  LEFT: (s, n = 1) => toStr(s).slice(0, toNum(n)),
  RIGHT: (s, n = 1) => { const t = toStr(s); return t.slice(Math.max(0, t.length - toNum(n))); },
  MID: (s, start, n) => toStr(s).substr(toNum(start) - 1, toNum(n)),
  REPLACE: (s, start, n, r) => { const t = toStr(s); const i = toNum(start) - 1; return t.slice(0, i) + toStr(r) + t.slice(i + toNum(n)); },
  SUBSTITUTE: (s, a, b) => toStr(s).split(toStr(a)).join(toStr(b)),
  SEARCH: (needle, hay) => { const i = toStr(hay).toLowerCase().indexOf(toStr(needle).toLowerCase()); return i < 0 ? 0 : i + 1; },
  CONTAINS: (hay, needle) => toStr(hay).toLowerCase().includes(toStr(needle).toLowerCase()),
  REPT: (s, n) => toStr(s).repeat(Math.max(0, toNum(n))),
  TEXT: (v, fmt) => { const s = toStr(fmt); const n = toNum(v); if (/0\.0+/.test(s)) return n.toFixed(s.split('.')[1].length); return toStr(v); },
  TODAY: () => new Date().toISOString().slice(0, 10),
  NOW: () => new Date().toISOString().slice(0, 16).replace('T', ' '),
  DATE: (y, m, d) => fromDay(Date.UTC(toNum(y), toNum(m) - 1, toNum(d))),
  DAYS: (end, start) => { const a = toDay(toStr(end)), b = toDay(toStr(start)); return Number.isNaN(a) || Number.isNaN(b) ? '' : Math.round((a - b) / dayMs); },
  WORKDAYS: (end, start) => workdays(toStr(start), toStr(end)),
  ADD_DAYS: (d, n) => { const a = toDay(toStr(d)); return Number.isNaN(a) ? '' : fromDay(a + toNum(n) * dayMs); },
  SUBTRACT_DAYS: (d, n) => { const a = toDay(toStr(d)); return Number.isNaN(a) ? '' : fromDay(a - toNum(n) * dayMs); },
  YEAR: (d) => (isDate(toStr(d)) ? +toStr(d).slice(0, 4) : ''),
  MONTH: (d) => (isDate(toStr(d)) ? +toStr(d).slice(5, 7) : ''),
  DAY: (d) => (isDate(toStr(d)) ? +toStr(d).slice(8, 10) : ''),
  WEEKNUM: (d) => { const t = toDay(toStr(d)); if (Number.isNaN(t)) return ''; const dt = new Date(t); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const first = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return 1 + Math.round(((dt - first) / dayMs - 3 + ((first.getUTCDay() + 6) % 7)) / 7); },
  WEEKDAY: (d) => { const t = toDay(toStr(d)); return Number.isNaN(t) ? '' : new Date(t).getUTCDay() + 1; },
  FORMAT_DATE: (d) => { const t = toDay(toStr(d)); if (Number.isNaN(t)) return ''; const dt = new Date(t); return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`; },
  ISBLANK: (v) => v == null || v === '' || (Array.isArray(v) && !v.length),
  IFBLANK: (v, alt) => (v == null || v === '' ? alt : v),
};

const FUNCTIONS = Object.keys(FN).sort();

function evaluate(node, resolve) {
  switch (node.k) {
    case 'lit': return node.v;
    case 'ref': return resolve(node.v);
    case 'un': { const a = evaluate(node.a, resolve); return node.op === '-' ? -toNum(a) : !truthy(a); }
    case 'call': {
      // IF is lazy so that the unused branch cannot fail.
      if (node.fn === 'IF') { const c = evaluate(node.args[0], resolve); return truthy(c) ? evaluate(node.args[1], resolve) : node.args[2] ? evaluate(node.args[2], resolve) : ''; }
      return FN[node.fn](...node.args.map((a) => evaluate(a, resolve)));
    }
    case 'bin': {
      const a = evaluate(node.a, resolve), b = evaluate(node.b, resolve);
      switch (node.op) {
        case '+': return toNum(a) + toNum(b);
        case '-': return isDate(a) && isDate(b) ? FN.DAYS(a, b) : toNum(a) - toNum(b);
        case '*': return toNum(a) * toNum(b);
        case '/': return toNum(b) === 0 ? '' : toNum(a) / toNum(b);
        case '%': return toNum(a) % toNum(b);
        case '^': return toNum(a) ** toNum(b);
        case '&': return toStr(a) + toStr(b);
        case '&&': return truthy(a) && truthy(b);
        case '||': return truthy(a) || truthy(b);
        case '=': case '==': return cmp(a, b) === 0;
        case '!=': case '<>': return cmp(a, b) !== 0;
        case '<': return cmp(a, b) < 0;
        case '>': return cmp(a, b) > 0;
        case '<=': return cmp(a, b) <= 0;
        case '>=': return cmp(a, b) >= 0;
        default: throw new FormulaError(`Unknown operator ${node.op}`);
      }
    }
    default: throw new FormulaError('Bad formula');
  }
}

function cmp(a, b) {
  if (typeof a === 'number' || typeof b === 'number') {
    if ((a === '' || a == null) && typeof b === 'number') return -1;
    if ((b === '' || b == null) && typeof a === 'number') return 1;
    return toNum(a) - toNum(b);
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return (truthy(a) ? 1 : 0) - (truthy(b) ? 1 : 0);
  return toStr(a).localeCompare(toStr(b), undefined, { sensitivity: 'accent' });
}

const cache = new Map();
/** Evaluate expr; resolve(title) returns the referenced column's value. */
function run(expr, resolve) {
  let ast = cache.get(expr);
  if (!ast) { ast = parse(expr); if (cache.size > 500) cache.clear(); cache.set(expr, ast); }
  const v = evaluate(ast, resolve);
  if (typeof v === 'number' && !Number.isFinite(v)) return '';
  return v;
}

function check(expr) {
  try { parse(expr); return null; } catch (e) { return e.message; }
}

function refs(expr) {
  try { return [...new Set(tokenize(String(expr || '')).filter((t) => t.t === 'ref').map((t) => t.v))]; } catch (_) { return []; }
}

module.exports = { run, parse, check, refs, FUNCTIONS, FormulaError };
