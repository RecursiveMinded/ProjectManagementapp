'use strict';
// Scheduling maths for the Gantt view: the critical path through a board's
// dependency links, and baseline variance. Pure functions over plain data.

const DAY = 86400000;
const dayNo = (iso) => Math.round(Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) / DAY);

/**
 * Critical path by a backward pass over the dependency network.
 * nodes: [{ id, start, end }]   (ISO dates, end inclusive)
 * links: [{ from, to }]         (from = predecessor)
 * opts:  { type: 'fs'|'ss'|'ff'|'sf', lagDays }
 * Returns { critical: Set<id>, links: Set<'from>to'>, float: { id: days }, finish }.
 * Only items that take part in at least one link can be critical.
 */
function criticalPath(nodes, links, { type = 'fs', lagDays = 0 } = {}) {
  const N = {};
  for (const n of nodes) if (n && n.start) N[n.id] = { id: n.id, s: dayNo(n.start), e: dayNo(n.end || n.start) };
  const L = links.filter((l) => N[l.from] && N[l.to] && l.from !== l.to);
  const out = { critical: new Set(), links: new Set(), float: {}, finish: null };
  if (!L.length) return out;
  const inNet = new Set(L.flatMap((l) => [l.from, l.to]));
  const finish = Math.max(...[...inNet].map((id) => N[id].e));
  const lag = Number(lagDays) || 0;
  const succ = {};
  for (const l of L) (succ[l.from] = succ[l.from] || []).push(l.to);
  const LF = {};
  for (const id of inNet) LF[id] = finish;
  // Relax until stable; the network is small and cycles are capped.
  for (let pass = 0; pass < inNet.size + 1; pass++) {
    let changed = false;
    for (const id of inNet) {
      const p = N[id];
      const dur = p.e - p.s;
      let lf = finish;
      for (const sid of succ[id] || []) {
        const s = N[sid];
        const sLF = LF[sid];
        const sLS = sLF - (s.e - s.s);
        let bound;
        if (type === 'ss') bound = sLS - lag + dur;
        else if (type === 'ff') bound = sLF - lag;
        else if (type === 'sf') bound = sLF - lag + dur;
        else bound = sLS - 1 - lag;
        if (bound < lf) lf = bound;
      }
      if (lf !== LF[id]) { LF[id] = lf; changed = true; }
    }
    if (!changed) break;
  }
  for (const id of inNet) {
    const f = LF[id] - N[id].e;
    out.float[id] = f;
    if (f <= 0) out.critical.add(id);
  }
  for (const l of L) {
    if (!out.critical.has(l.from) || !out.critical.has(l.to)) continue;
    const p = N[l.from], s = N[l.to];
    let gap;
    if (type === 'ss') gap = s.s - (p.s + lag);
    else if (type === 'ff') gap = s.e - (p.e + lag);
    else if (type === 'sf') gap = s.e - (p.s + lag);
    else gap = s.s - (p.e + 1 + lag);
    if (gap <= 0) out.links.add(`${l.from}>${l.to}`);
  }
  out.finish = new Date(finish * DAY).toISOString().slice(0, 10);
  return out;
}

/** Days an item has slipped against its baseline (positive = later). */
function variance(base, now) {
  if (!base || !now) return null;
  return { start: dayNo(now.start) - dayNo(base.start), end: dayNo(now.end) - dayNo(base.end) };
}

module.exports = { criticalPath, variance, dayNo };
