// Shared UI helpers and small components.
import { h } from 'preact';
import { useEffect, useState, useCallback, useRef } from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);

// ------------------------------------------------------------------ icons
const P = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  plan: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  list: 'M4 6h16M4 12h16M4 18h16',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  inbox: 'M4 13h4l2 3h4l2-3h4M5 5h14l1 8v6H4v-6z',
  report: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v4h16v-4',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6L6 18',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  warn: 'M12 3l10 18H2zM12 10v5M12 18v.5',
  plus: 'M12 5v14M5 12h14',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  mail: 'M3 6h18v12H3zM3 6l9 7 9-7',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  table: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v14',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  chev: 'M9 6l6 6-6 6',
  print: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  snooze: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9h6l-6 6h6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  wave: 'M2 12c2.5-4 5-4 7.5 0s5 4 7.5 0 3.5-3 5-2',
  text: 'M5 6h14M12 6v13M9 19h6',
  para: 'M4 6h16M4 10h16M4 14h10M4 18h12',
  status: 'M4 7h16v10H4zM8 12h8',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14a6 6 0 0 1 3.5 6',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  timeline: 'M4 6h9M8 12h12M6 18h8',
  hash: 'M5 9h14M5 15h14M10 4L8 20M16 4l-2 16',
  dropdown: 'M4 6h16v12H4zM9 11l3 3 3-3',
  checkbox: 'M4 4h16v16H4zM8 12l3 3 5-6',
  connect: 'M7 7h4v4H7zM13 13h4v4h-4zM11 9h3a2 2 0 0 1 2 2v2',
  mirror: 'M12 3v18M4 7l5 5-5 5zM20 7l-5 5 5 5z',
  flag: 'M5 21V4h11l-2 4 2 4H5',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8.5h.01',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  pin: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  paperclip: 'M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L14 4.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3L15 7.5',
  star: 'M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4 6.5 20.3l1-6.2L3 9.7l6.2-.9z',
  vote: 'M7 11l3-7a2 2 0 0 1 2 2v4h6l-2 9H7zM3 11h4v9H3z',
  palette: 'M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-1.3-1.2-1.4-1.2-2.6 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2zM7.5 12h.01M9 7.5h.01M15 7.5h.01',
  battery: 'M3 8h15v8H3zM21 11v2M6 11v2M9 11v2',
  fx: 'M10 4H8a2 2 0 0 0-2 2v14M4 11h6M14 10l6 8M20 10l-6 8',
  dependency: 'M5 5h6v5H5zM13 14h6v5h-6zM8 10v6.5h5',
  timer: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 9v4l2 2M10 2h4',
  button: 'M4 8h16v8H4zM9 12h6',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  kanban: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  form: 'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5',
  workload: 'M4 18h4v-6H4zM10 18h4V6h-4zM16 18h4v-9h-4z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  dashboard: 'M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z',
  filter: 'M4 5h16l-6 8v6l-4 2v-8z',
  sort: 'M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  dots: 'M12 5h.01M12 12h.01M12 19h.01',
  drag: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  msg: 'M4 5h16v11H8l-4 4z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h4v16H7zM13 4h4v16h-4z',
  hide: 'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6',
  group: 'M3 5h18M3 12h18M3 19h18M3 5v14',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  star2: 'M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4 6.5 20.3l1-6.2L3 9.7l6.2-.9z',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  sub: 'M6 4v10a2 2 0 0 0 2 2h10M14 12l4 4-4 4',
  zoomIn: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5M11 8v6M8 11h6',
  today: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M12 14v3',
  pinIcon: 'M15 3l6 6-4 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z',
};

export function Icon({ name, size, cls }) {
  return html`<svg class=${cls} viewBox="0 0 24 24" width=${size} height=${size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${P[name] || P.file} /></svg>`;
}

// --------------------------------------------------------------- formatting
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m) return String(iso);
  return `${MON[m - 1]} ${d}, ${y}`;
}
export function fmtMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MON[m - 1]} ${String(y).slice(2)}`;
}
export function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return `${fmtDate(d.toISOString().slice(0, 10))} ${d.toTimeString().slice(0, 5)}`;
}
export function daysLabel(days) {
  if (days == null) return 'No date';
  if (days < 0) return `${-days} d ago`;
  if (days === 0) return 'Today';
  return `${days} d`;
}
export function plural(n, word, pl) { return `${n} ${n === 1 ? word : (pl || `${word}s`)}`; }
export function bytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// --------------------------------------------------------------- components
export function Spinner() { return html`<span class="spin"></span>`; }

export function Empty({ icon = 'file', title, children }) {
  return html`<div class="empty"><${Icon} name=${icon} /><h3>${title}</h3><div>${children}</div></div>`;
}

export function Drawer({ onClose, title, sub, wide, children, footer }) {
  useEsc(onClose);
  return html`<div>
    <div class="scrim" onClick=${onClose}></div>
    <aside class=${`drawer ${wide ? 'wide' : ''}`} role="dialog" aria-label=${title}>
      <div class="hd row between top"><div class="grow"><h2>${title}</h2>${sub ? html`<div class="muted small mt">${sub}</div>` : null}</div>
        <button class="btn ghost icon" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
      <div class="bd">${children}</div>
      ${footer ? html`<div class="ft">${footer}</div>` : null}
    </aside></div>`;
}

export function Modal({ onClose, title, wide, children }) {
  useEsc(onClose);
  return html`<div>
    <div class="scrim" style="z-index:60" onClick=${onClose}></div>
    <div class=${`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label=${title}>
      <div class="row between" style="margin-bottom:12px"><h2>${title}</h2><button class="btn ghost icon" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
      ${children}
    </div></div>`;
}

function useEsc(fn) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') fn && fn(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [fn]);
}

// ------------------------------------------------------------------ toasts
let pushToast = () => {};
export function toast(msg, kind = '') { pushToast(msg, kind); }
export function toastError(e) { pushToast(e && e.message ? e.message : String(e), 'err'); }

export function Toasts() {
  const [list, setList] = useState([]);
  useEffect(() => {
    pushToast = (msg, kind) => {
      const id = Math.random();
      setList((l) => [...l, { id, msg, kind }]);
      setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), kind === 'err' ? 7000 : 3800);
    };
  }, []);
  return html`<div class="toasts" role="status">${list.map((t) => html`<div class=${`toast ${t.kind}`} key=${t.id}>${t.msg}</div>`)}</div>`;
}

// ------------------------------------------------------------------- hooks
/** Load async data; reloads when deps change. Returns [data, reload, loading, error]. */
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: undefined, loading: true, error: null });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fn();
      if (my === seq.current) setState({ data, loading: false, error: null });
    } catch (e) {
      if (my === seq.current) setState((s) => ({ ...s, loading: false, error: e }));
    }
  }, deps);
  useEffect(() => { load(); }, [load]);
  return [state.data, load, state.loading, state.error];
}

export function usePersist(key, initial) {
  const [v, setV] = useState(() => {
    try { const s = localStorage.getItem(`bd.${key}`); return s ? { ...initial, ...JSON.parse(s) } : initial; } catch (_) { return initial; }
  });
  const set = useCallback((nv) => {
    setV((old) => {
      const next = typeof nv === 'function' ? nv(old) : nv;
      try { localStorage.setItem(`bd.${key}`, JSON.stringify(next)); } catch (_) { /* private mode */ }
      return next;
    });
  }, [key]);
  return [v, set];
}

/** Run an async action with busy state and error toasts. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn) => {
    setBusy(true);
    try { return await fn(); } catch (e) { toastError(e); return undefined; } finally { setBusy(false); }
  }, []);
  return [busy, run];
}

export function unique(list) { return [...new Set(list.filter((x) => x != null && x !== ''))].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })); }

export function Ring({ value, size = 74, color: fixed }) {
  const r = (size - 10) / 2, c = 2 * Math.PI * r;
  const color = fixed || (value >= 80 ? 'var(--good)' : value >= 40 ? 'var(--warn)' : 'var(--bad)');
  return html`<div class="ring" style=${`width:${size}px;height:${size}px`}>
    <svg width=${size} height=${size}><circle cx=${size / 2} cy=${size / 2} r=${r} stroke="var(--line)" stroke-width="8" fill="none" />
      <circle cx=${size / 2} cy=${size / 2} r=${r} stroke=${color} stroke-width="8" fill="none" stroke-linecap="round" stroke-dasharray=${`${(c * value) / 100} ${c}`} /></svg>
    <b>${value}</b></div>`;
}

export function Select({ value, onChange, options, placeholder, cls, title }) {
  return html`<select class=${cls} value=${value} title=${title || placeholder} aria-label=${title || placeholder} onChange=${(e) => onChange(e.target.value)}>
    ${placeholder != null ? html`<option value="">${placeholder}</option>` : null}
    ${options.map((o) => (typeof o === 'object' ? html`<option value=${o.value}>${o.label}</option>` : html`<option value=${o}>${o}</option>`))}
  </select>`;
}

// ------------------------------------------------------------- board helpers
export function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

export function Avatar({ person, size = 24, title }) {
  if (!person) return html`<span class="avatar none" style=${`width:${size}px;height:${size}px`}><${Icon} name="user" size=${Math.round(size * 0.62)} /></span>`;
  return html`<span class="avatar" title=${title || person.name} style=${`width:${size}px;height:${size}px;background:${person.color || '#5a55d6'};font-size:${Math.round(size * 0.42)}px`}>${initials(person.name)}</span>`;
}

export function Avatars({ ids, people, max = 3, size = 24 }) {
  const list = (ids || []).map((id) => people[id]).filter(Boolean);
  if (!list.length) return html`<${Avatar} size=${size} />`;
  return html`<span class="avatars">${list.slice(0, max).map((p) => html`<${Avatar} key=${p.id} person=${p} size=${size} />`)}${list.length > max ? html`<span class="avatar more" style=${`width:${size}px;height:${size}px`}>+${list.length - max}</span>` : null}</span>`;
}

/** A floating panel anchored to an element; closes on outside click or Escape. */
export function Popover({ anchor, onClose, children, width = 260, cls = '', align = 'left' }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 200, bottom: 200, top: 180, right: 400, width: 200 };
    const h = window.innerHeight, w = window.innerWidth;
    let left = align === 'right' ? r.right - width : align === 'center' ? r.left + r.width / 2 - width / 2 : r.left;
    left = Math.max(8, Math.min(left, w - width - 8));
    const below = h - r.bottom;
    setPos(below > 280 || below > r.top ? { left, top: r.bottom + 4, maxHeight: below - 16 } : { left, bottom: h - r.top + 4, maxHeight: r.top - 16 });
  }, [anchor]);
  useEffect(() => {
    const down = (e) => { if (ref.current && !ref.current.contains(e.target) && !(anchor && anchor.contains && anchor.contains(e.target))) onClose(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    setTimeout(() => document.addEventListener('mousedown', down), 0);
    window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true); };
  }, [onClose, anchor]);
  if (!pos) return null;
  const style = `width:${width}px;left:${pos.left}px;${pos.top != null ? `top:${pos.top}px` : `bottom:${pos.bottom}px`};max-height:${Math.max(160, pos.maxHeight)}px`;
  return html`<div class=${`pop ${cls}`} ref=${ref} style=${style} onClick=${(e) => e.stopPropagation()}>${children}</div>`;
}

/** A menu of actions in a popover. items: [{ label, icon, onClick, danger, sep }] */
export function Menu({ anchor, onClose, items, width = 220, align }) {
  return html`<${Popover} anchor=${anchor} onClose=${onClose} width=${width} align=${align} cls="menu">
    ${items.filter(Boolean).map((it, i) => (it.sep ? html`<div class="sep" key=${i}></div>` : it.head ? html`<div class="menu-head" key=${i}>${it.head}</div>` : html`<button key=${i} class=${`mi ${it.danger ? 'danger' : ''} ${it.active ? 'active' : ''}`} disabled=${it.disabled} onClick=${() => { onClose(); it.onClick && it.onClick(); }}>
      ${it.icon ? html`<${Icon} name=${it.icon} />` : html`<span class="ico-space"></span>`}<span class="grow">${it.label}</span>${it.hint ? html`<span class="faint small">${it.hint}</span>` : null}</button>`))}
  </${Popover}>`;
}

/** useAnchor: [anchorEl, open(e), close] for popovers. */
export function useAnchor() {
  const [el, setEl] = useState(null);
  const open = useCallback((e) => { e && e.stopPropagation && e.stopPropagation(); setEl(e && e.currentTarget ? e.currentTarget : e); }, []);
  const close = useCallback(() => setEl(null), []);
  return [el, open, close];
}

/** Click-to-edit text. */
export function InlineText({ value, onSave, cls = '', placeholder = '', multiline = false, autoFocus = false }) {
  const [editing, setEditing] = useState(autoFocus);
  const [v, setV] = useState(value || '');
  useEffect(() => { if (!editing) setV(value || ''); }, [value, editing]);
  if (!editing) return html`<span class=${`inline-text ${cls} ${value ? '' : 'faint'}`} tabindex="0" onClick=${(e) => { e.stopPropagation(); setEditing(true); }} onKeyDown=${(e) => { if (e.key === 'Enter') setEditing(true); }}>${value || placeholder}</span>`;
  const done = (save) => { setEditing(false); if (save && v.trim() !== (value || '').trim()) onSave(v.trim()); };
  const props = {
    class: `inline-input ${cls}`, value: v, autoFocus: true, placeholder,
    onInput: (e) => setV(e.target.value), onBlur: () => done(true), onClick: (e) => e.stopPropagation(),
    onKeyDown: (e) => { if (e.key === 'Enter' && (!multiline || e.ctrlKey)) { e.preventDefault(); done(true); } if (e.key === 'Escape') { e.stopPropagation(); done(false); } },
  };
  return multiline ? html`<textarea ...${props} rows="4"></textarea>` : html`<input ...${props} />`;
}

export function Confirm({ title, body, ok = 'Delete', onOk, onClose, danger = true }) {
  return html`<${Modal} title=${title} onClose=${onClose}>
    <p class="muted">${body}</p>
    <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" onClick=${onClose}>Cancel</button>
      <button class=${`btn ${danger ? 'danger' : 'primary'}`} onClick=${() => { onClose(); onOk(); }}>${ok}</button></div>
  </${Modal}>`;
}

let confirmHost = () => {};
export function ask(opts) { return new Promise((res) => confirmHost({ ...opts, resolve: res })); }
export function ConfirmHost() {
  const [c, setC] = useState(null);
  useEffect(() => { confirmHost = setC; }, []);
  if (!c) return null;
  return html`<${Confirm} ...${c} onOk=${() => c.resolve(true)} onClose=${() => { setC(null); c.resolve(false); }} />`;
}

export function hexA(hex, a) {
  const h = String(hex || '#999999').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function todayIso() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
export function addDaysIso(iso, n) {
  const t = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
export function diffDays(a, b) {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
}
export function shortDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const now = new Date();
  return `${MON[m - 1]} ${d}${y !== now.getFullYear() ? `, ${y}` : ''}`;
}
export function relTime(ts) {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(String(ts).slice(0, 10));
}

export function saveFileName(s) { return String(s || 'export').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80); }
