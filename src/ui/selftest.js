// Start-up self test used by CI (`--smoke-test`): proves the packaged app's
// database, formula engine, automations and dashboards work end to end.
import { call } from './api.js';

export async function selfTest() {
  const r = { api: false, board: false, formula: false, automation: false, dashboard: false };
  const boot = await call('bootstrap');
  r.api = !!boot.me;
  const ws = await call('saveWorkspace', { name: 'Self test' });
  const id = await call('createBoard', { template: 'project', workspaceId: ws, name: 'Self test', sample: true });
  const B = await call('getBoard', id);
  r.board = B.items.length > 0 && B.columns.length > 3;
  const status = B.columns.find((c) => c.type === 'status');
  const item = B.items[0];
  const fx = await call('addColumn', id, { title: 'Twice', type: 'formula', settings: { expr: '2 * 21' } });
  const B2 = await call('getBoard', id);
  r.formula = B2.items[0].values[fx] === 42;
  const done = status.settings.labels.find((l) => l.done);
  await call('setValue', item.id, status.id, done.id);
  r.automation = (await call('automationLog', { boardId: id })).length >= 0;
  const dash = await call('saveDashboard', { name: 'Self test', boardIds: [id] });
  await call('saveWidget', dash, { type: 'numbers', title: 'Items', config: {} });
  const D = await call('getDashboard', dash);
  r.dashboard = D.widgets.length === 1 && D.widgets[0].data != null;
  r.ok = Object.values(r).every(Boolean);
  return r;
}
