// The import wizard: pick a file (Excel, CSV, Word, PDF, text or a picture),
// check what was read, fix cells and column types, then create the items.
import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Modal, Spinner, toastError, toast, plural } from './lib.js';
import { call, saveAs } from './api.js';
import { C } from './model.js';

export const IMPORT_ACCEPT = '.xlsx,.csv,.tsv,.txt,.md,.docx,.pdf,.png,.jpg,.jpeg,.bmp,.gif,.webp,.tif,.tiff';

const ROLES = [['__name', 'Item name'], ['__group', 'Group'], ['__parent', 'Subitem of'], ['skip', 'Skip this column']];
const TYPES = ['text', 'long_text', 'status', 'priority', 'people', 'team', 'date', 'timeline', 'numbers', 'checkbox', 'dropdown', 'tags', 'email', 'phone', 'link', 'location', 'country', 'rating'];

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => { const f = input.files[0]; resolve(f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null); };
    input.click();
  });
}

export async function downloadImportSheet(boardId, boardName) {
  try {
    const bytes = await call('importSheet', boardId || null);
    await saveAs(boardId ? `${boardName} import sheet.xlsx` : 'Boardenda import sheet.xlsx', bytes, [{ name: 'Excel', extensions: ['xlsx'] }]);
  } catch (e) { toastError(e); }
}

/** file: { name, bytes }. boardId set = add to that board; otherwise a new board. */
export function ImportWizard({ file, boardId, boardName, workspaces = [], workspaceId, onClose, onDone }) {
  const [p, setP] = useState(null);
  const [err, setErr] = useState(null);
  const [rows, setRows] = useState(null);
  const [cols, setCols] = useState(null);
  const [name, setName] = useState(String(file.name).replace(/\.[^.]+$/, ''));
  const [ws, setWs] = useState(workspaceId || (workspaces[0] || {}).id || '');
  const [skipEx, setSkipEx] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call('previewImport', file.name, file.bytes).then((r) => { setP(r); setRows(r.rows.map((x) => [...x])); setCols(r.columns.map((c) => ({ ...c }))); }, (e) => setErr(e.message || String(e)));
  }, [file]);
  const nameCol = cols ? cols.findIndex((c) => c.type === '__name') : -1;
  const isEx = (r) => nameCol >= 0 && /^example\s*[:\-–]/i.test(String(r[nameCol] || ''));
  const nEx = rows ? rows.filter(isEx).length : 0;
  const setCell = (i, j, v) => { const n = rows.slice(); n[i] = [...n[i]]; n[i][j] = v; setRows(n); };
  const setType = (j, type) => setCols(cols.map((c, k) => (k === j ? { ...c, type } : type === '__name' && c.type === '__name' ? { ...c, type: 'text' } : c)));
  const setTitle = (j, title) => setCols(cols.map((c, k) => (k === j ? { ...c, title } : c)));
  const removeRow = (i) => setRows(rows.filter((_, k) => k !== i));
  const go = async () => {
    if (!cols.some((c) => c.type === '__name')) { toast('Choose which column holds the item names', 'err'); return; }
    setBusy(true);
    try {
      const r = await call('importTable', { name: file.name, header: cols.map((c) => c.title), rows, columns: cols, boardId, workspaceId: ws, boardName: name, skipExamples: skipEx });
      toast(`Imported ${plural(r.created, 'item')}`);
      onDone(r.boardId);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const isOcr = p && /OCR/.test(p.kind);
  return html`<${Modal} wide title=${boardId ? `Import into ${boardName}` : 'Import'} onClose=${onClose}>
    ${err ? html`<div class="import-err"><b>This file could not be read.</b><div class="small mt">${err}</div></div>`
    : !p ? html`<div class="row" style="padding:30px;justify-content:center;gap:10px"><${Spinner} /> ${/\.(png|jpe?g|bmp|gif|webp|tiff?)$/i.test(file.name) ? 'Reading the picture with OCR. The first time takes a few seconds…' : 'Reading the file…'}</div>`
    : html`<div class="col" style="gap:10px">
      <div class="row wrap" style="gap:8px"><span class="chip">${p.kind}</span><b class="clip">${file.name}</b><span class="muted small">${plural(p.total, 'row')}${p.total > rows.length ? `, first ${rows.length} shown and imported` : ''}</span>
        ${isOcr ? html`<span class=${`chip ${p.confidence < 70 ? 'warn' : ''}`}>OCR ${p.confidence}%</span>` : null}</div>
      ${p.notes.map((n, i) => html`<div class="import-note small" key=${i}><${Icon} name="spark" size="14" /> ${n}</div>`)}
      <div class="small muted">Check each column's type, and click any cell to fix it. ${isOcr ? 'Pictures are read by OCR, so look closely at names, numbers and dates.' : ''}</div>
      <div class="import-grid-wrap"><table class="import-grid">
        <thead><tr><th></th>${cols.map((c, j) => html`<th key=${j} class=${c.type === 'skip' ? 'skip' : ''}>
          <input class="ig-title" value=${c.title} aria-label="Column title" onInput=${(e) => setTitle(j, e.target.value)} />
          <select class="ig-type" aria-label="Column type" value=${c.type} onChange=${(e) => setType(j, e.target.value)}>
            ${ROLES.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}<option disabled>──────</option>
            ${TYPES.map((t) => html`<option key=${t} value=${t}>${C.TYPES[t] ? C.TYPES[t].label : t}</option>`)}</select></th>`)}</tr></thead>
        <tbody>${rows.slice(0, 200).map((r, i) => html`<tr key=${i} class=${skipEx && isEx(r) ? 'ex' : ''}>
          <td><button class="ig-del" title="Leave this row out" aria-label="Leave this row out" onClick=${() => removeRow(i)}>×</button></td>
          ${cols.map((c, j) => html`<td key=${j} class=${c.type === 'skip' ? 'skip' : ''}><input class="ig-cell" value=${r[j] || ''} onInput=${(e) => setCell(i, j, e.target.value)} /></td>`)}</tr>`)}</tbody>
      </table>${rows.length > 200 ? html`<div class="small faint" style="padding:6px">${rows.length - 200} more rows will be imported as read.</div>` : null}</div>
      <div class="row wrap" style="gap:10px;align-items:flex-end">
        ${boardId ? null : html`<label class="field" style="min-width:220px">New board name<input class="input" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
          ${workspaces.length ? html`<label class="field">Workspace<select class="input" value=${ws} onChange=${(e) => setWs(e.target.value)}>${workspaces.map((w) => html`<option key=${w.id} value=${w.id}>${w.name}</option>`)}</select></label>` : null}`}
        ${nEx ? html`<label class="check small"><input type="checkbox" checked=${skipEx} onChange=${(e) => setSkipEx(e.target.checked)} /> Skip the ${plural(nEx, 'EXAMPLE row')}</label>` : null}
        <span class="grow"></span>
        <button class="btn" onClick=${onClose}>Cancel</button>
        <button class="btn primary" disabled=${busy || !(rows.length - (skipEx ? nEx : 0))} onClick=${go}>${busy ? 'Importing…' : `Import ${plural(rows.length - (skipEx ? nEx : 0), 'item')}`}</button>
      </div></div>`}
  </${Modal}>`;
}
