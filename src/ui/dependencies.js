// Team dependencies: which team is waiting on which, across every board.
// A record only: nothing is sent to anyone.
import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Spinner, toastError, shortDate, usePersist } from './lib.js';
import { call } from './api.js';
import { C } from './model.js';

const STATES = {
  blocked: ['Blocked', '#e2445c', 'The work it waits on is late, or this should already have started.'],
  at_risk: ['At risk', '#f2a516', 'The work it waits on finishes after this is due to start.'],
  waiting: ['Waiting', '#7b6dff', 'Marked as waiting on a team. Clear the mark or finish the item when it is resolved.'],
  on_track: ['On track', '#2bb673', 'The work it waits on finishes in time.'],
  done: ['Resolved', '#9aa3b2', 'The work it waited on is done.'],
};

export function DependenciesPage({ openItem, nav, version }) {
  const [d, setD] = useState(null);
  const [opt, setOpt] = usePersist('deps', { team: '', sameTeam: false, showDone: false });
  const [cell, setCell] = useState(null); // { waiting, provider }
  useEffect(() => { call('dependencies').then(setD, toastError); }, [version]);
  if (!d) return html`<div class="page"><${Spinner} /></div>`;
  const T = Object.fromEntries(d.teams.map((t) => [t.id, t]));
  const chip = (id, waiting) => {
    const t = T[id];
    return t ? html`<span key=${id} class=${`team-chip ${waiting ? 'waiting' : ''}`} style=${`--tc:${C.colorHex(t.color)}`} title=${t.external ? `${t.name} (outside Boardenda)` : t.name}>${t.name}</span>`
      : html`<span key=${id || 'none'} class="team-chip" style="--tc:#9aa3b2">No team</span>`;
  };
  const chips = (ids) => (ids.length ? ids.map((id) => chip(id)) : chip(''));
  const links = d.links.filter((l) => (opt.sameTeam || l.cross) && (opt.showDone || l.state !== 'done')
    && (!opt.team || l.waiting.includes(opt.team) || l.providers.includes(opt.team))
    && (!cell || ((l.waiting.length ? l.waiting : ['']).includes(cell.waiting) && (l.providers.length ? l.providers : ['']).includes(cell.provider))));

  // Matrix over the teams that appear in open cross-team links.
  const rows = [...new Set(d.matrix.map((m) => m.waiting))];
  const cols = [...new Set(d.matrix.map((m) => m.provider))];
  const at = (w, p) => d.matrix.find((m) => m.waiting === w && m.provider === p);
  const name = (id) => (T[id] ? T[id].name : 'No team');

  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Team dependencies</h1>
      <div class="small muted mt">Who is waiting on whom, across every board. This is a record for you: nobody is contacted.</div></div>
      <select class="input" style="width:auto" value=${opt.team} onChange=${(e) => { setCell(null); setOpt({ ...opt, team: e.target.value }); }} aria-label="Team">
        <option value="">All teams</option>${d.teams.map((t) => html`<option value=${t.id}>${t.name}${t.external ? ' (outside)' : ''}</option>`)}</select></div>

    <div class="grid c4 mb">
      <div class="card stat"><b>${d.summary.open}</b><span class="muted">open cross-team dependencies</span></div>
      <div class="card stat"><b style="color:#e2445c">${d.summary.blocked}</b><span class="muted">blocked</span></div>
      <div class="card stat"><b style="color:#f2a516">${d.summary.atRisk}</b><span class="muted">at risk</span></div>
      <div class="card stat"><b>${d.summary.external}</b><span class="muted">waiting on teams by mark</span></div>
    </div>

    ${!d.links.length ? html`<div class="card pad"><div class="empty"><${Icon} name="dependency" /><h3>No dependencies recorded yet</h3>
      <div>Two ways to record them, on any board:</div>
      <ol style="text-align:left;max-width:560px;margin:12px auto;line-height:1.7">
        <li>Add a <b>Team</b> column for the owning team and a <b>Dependency</b> column linking an item to the item it waits on. When the two items belong to different teams, the link shows here.</li>
        <li>Add a <b>Team</b> column set to <i>Teams the item is waiting on</i> and pick the team, even one outside Boardenda (Settings → People &amp; teams).</li>
      </ol>
      <button class="btn" onClick=${() => nav('settings')}>Set up teams</button></div></div>` : null}

    ${rows.length ? html`<div class="card pad mb"><div class="row between"><h3>Waiting on (open)</h3>${cell ? html`<button class="btn small" onClick=${() => setCell(null)}>Clear selection</button>` : null}</div>
      <div class="small muted">Rows are the teams waiting; columns are the teams they wait on. Red means at least one is blocked. Click a number to list those.</div>
      <div style="overflow:auto"><table class="plain dep-matrix mt"><thead><tr><th>Waiting ↓ / on →</th>${cols.map((p) => html`<th key=${p}>${chip(p)}</th>`)}</tr></thead>
      <tbody>${rows.map((w) => html`<tr key=${w}><th>${chip(w)}</th>${cols.map((p) => {
        const m = at(w, p);
        return html`<td key=${p}>${m ? html`<button class=${`dep-n ${m.blocked ? 'bad' : ''} ${cell && cell.waiting === w && cell.provider === p ? 'sel' : ''}`} title=${`${name(w)} waits on ${name(p)}: ${m.open} open, ${m.blocked} blocked`}
          onClick=${() => setCell(cell && cell.waiting === w && cell.provider === p ? null : { waiting: w, provider: p })}>${m.open}</button>` : html`<span class="faint">·</span>`}</td>`;
      })}</tr>`)}</tbody></table></div></div>` : null}

    ${d.links.length ? html`<div class="card pad">
      <div class="row between"><h3>${links.length} ${links.length === 1 ? 'dependency' : 'dependencies'}</h3>
        <div class="row" style="gap:12px"><label class="check small"><input type="checkbox" checked=${opt.sameTeam} onChange=${(e) => setOpt({ ...opt, sameTeam: e.target.checked })} /> Include same-team</label>
        <label class="check small"><input type="checkbox" checked=${opt.showDone} onChange=${(e) => setOpt({ ...opt, showDone: e.target.checked })} /> Show resolved</label></div></div>
      <div class="dep-list mt">${links.map((l) => html`<div class="dep-row" key=${l.key}>
        <span class="lbl" style=${`background:${STATES[l.state][1]};color:#fff`} title=${STATES[l.state][2]}>${STATES[l.state][0]}</span>
        <div class="dep-teams">${chips(l.waiting)}<span class="muted small">waits on</span>${l.providers.map((p) => chip(p, l.kind === 'team'))}</div>
        <div class="dep-items">
          <a onClick=${() => openItem(l.successor.id)}><b>${l.successor.name}</b></a><span class="small muted"> ${l.successor.boardName}${l.successor.start ? ` · starts ${shortDate(l.successor.start)}` : ''}</span>
          <div class="small">${l.kind === 'item'
            ? html`<span class="muted">needs </span><a onClick=${() => openItem(l.predecessor.id)}>${l.predecessor.name}</a><span class="muted"> · ${l.predecessor.boardName}${l.predecessor.due ? ` · due ${shortDate(l.predecessor.due)}` : ''}${l.predecessor.status ? ` · ${l.predecessor.status.label}` : ''}</span>`
            : html`<span class="muted">marked in “${l.column}”${T[l.providers[0]] && T[l.providers[0]].external ? ' · team outside Boardenda' : ''}</span>`}</div>
        </div></div>`)}
        ${!links.length ? html`<div class="muted pad">Nothing matches. ${!opt.sameTeam ? 'Same-team links are hidden.' : ''}</div>` : null}</div>
    </div>` : null}
  </div>`;
}
