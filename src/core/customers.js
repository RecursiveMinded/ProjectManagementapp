'use strict';
// Customer directory: one profile per account with its details, contacts,
// devices, notes and files. A Customer column on any board links items to a
// profile, and calls and meetings are matched to it by the customer name.

const fs = require('fs');
const path = require('path');
const C = require('./columns');
const { uid, now, parseJson } = require('./util');

const STATUSES = ['prospect', 'active', 'on_hold', 'former'];
const DEVICE_STATUSES = ['active', 'pending', 'repair', 'retired'];
const str = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
const cleanHtml = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/javascript:/gi, '').slice(0, 400000);
const cleanTags = (t) => [...new Set((Array.isArray(t) ? t : String(t || '').split(',')).map((x) => str(x, 40)).filter(Boolean))].slice(0, 30);

class Customers {
  constructor(store, meetings) {
    this.store = store;
    this.db = store.db;
    this.meetings = meetings;
  }

  row(id) {
    const c = this.db.get('SELECT * FROM customers WHERE id=?', [id]);
    if (!c) throw new Error('That customer no longer exists');
    return c;
  }

  shape(c) {
    return {
      id: c.id, name: c.name, status: c.status, industry: c.industry, website: c.website, phone: c.phone, email: c.email,
      address: c.address, accountNo: c.account_no, owner: c.owner || null, tags: parseJson(c.tags, []), notes: c.notes,
      createdAt: c.created_at, updatedAt: c.updated_at,
    };
  }

  /** Columns on every board that hold customers, by board. */
  customerColumns() {
    return this.db.all("SELECT c.id, c.board_id, c.title FROM columns c JOIN boards b ON b.id=c.board_id WHERE c.type='customer' AND b.archived=0");
  }

  /** Items whose Customer column includes this customer. */
  items(id, { includeDone = true } = {}) {
    const cols = this.customerColumns();
    if (!cols.length) return [];
    const byBoard = {};
    for (const c of cols) (byBoard[c.board_id] = byBoard[c.board_id] || []).push(c.id);
    const rows = this.db.all(`SELECT i.id, i.name, i.board_id, i.group_id, i.parent_id, i.data, b.name AS board_name, g.name AS group_name, g.color AS group_color
      FROM items i JOIN boards b ON b.id=i.board_id LEFT JOIN groups g ON g.id=i.group_id
      WHERE i.archived=0 AND i.data LIKE ? AND i.board_id IN (${Object.keys(byBoard).map(() => '?').join(',')})`, [`%${id}%`, ...Object.keys(byBoard)]);
    const colCache = {};
    const out = [];
    for (const r of rows) {
      const data = parseJson(r.data, {});
      if (!byBoard[r.board_id].some((cid) => Array.isArray(data[cid]) && data[cid].includes(id))) continue;
      const cols2 = colCache[r.board_id] || (colCache[r.board_id] = this.store.columns(r.board_id));
      const st = cols2.find((c) => c.type === 'status' && c.scope === (r.parent_id ? 'subitem' : 'item'));
      const label = st ? C.labelOf(st, data[st.id]) : null;
      const pc = cols2.find((c) => c.type === 'people' && c.scope === (r.parent_id ? 'subitem' : 'item'));
      const dc = cols2.find((c) => c.type === 'date' && c.scope === (r.parent_id ? 'subitem' : 'item')) || cols2.find((c) => c.type === 'timeline');
      const due = dc ? (dc.type === 'timeline' ? (data[dc.id] || {}).end : data[dc.id]) : null;
      const done = !!(label && label.done);
      if (!includeDone && done) continue;
      out.push({
        id: r.parent_id || r.id, subId: r.parent_id ? r.id : null, name: r.name, boardId: r.board_id, boardName: r.board_name, groupName: r.group_name,
        status: label ? { label: label.label, color: C.colorHex(label.color) } : null, done, owners: pc ? data[pc.id] || [] : [], due: due ? String(due).slice(0, 10) : null,
      });
    }
    return out.sort((a, b) => Number(a.done) - Number(b.done) || String(a.due || '9').localeCompare(String(b.due || '9')));
  }

  list({ q, status } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push('c.status=?'); args.push(status); }
    if (q && String(q).trim()) {
      const like = `%${String(q).trim().toLowerCase()}%`;
      where.push(`(LOWER(c.name) LIKE ? OR LOWER(c.industry) LIKE ? OR LOWER(c.email) LIKE ? OR LOWER(c.account_no) LIKE ? OR LOWER(c.tags) LIKE ?
        OR c.id IN (SELECT customer_id FROM customer_contacts WHERE LOWER(name || ' ' || email || ' ' || phone || ' ' || mobile) LIKE ?)
        OR c.id IN (SELECT customer_id FROM customer_devices WHERE LOWER(name || ' ' || serial || ' ' || model || ' ' || kind) LIKE ?))`);
      args.push(like, like, like, like, like, like, like);
    }
    const rows = this.db.all(`SELECT c.*,
      (SELECT COUNT(*) FROM customer_contacts k WHERE k.customer_id=c.id) AS n_contacts,
      (SELECT COUNT(*) FROM customer_devices d WHERE d.customer_id=c.id) AS n_devices,
      (SELECT name FROM customer_contacts k WHERE k.customer_id=c.id ORDER BY is_primary DESC, position LIMIT 1) AS primary_name,
      (SELECT email FROM customer_contacts k WHERE k.customer_id=c.id ORDER BY is_primary DESC, position LIMIT 1) AS primary_email,
      (SELECT phone FROM customer_contacts k WHERE k.customer_id=c.id ORDER BY is_primary DESC, position LIMIT 1) AS primary_phone
      FROM customers c ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.name COLLATE NOCASE`, args);
    const calls = {};
    for (const m of this.db.all("SELECT LOWER(customer) AS k, COUNT(*) AS n, MAX(CASE WHEN status='held' OR date<=date('now') THEN date END) AS last, MIN(CASE WHEN status='planned' AND date>=date('now') THEN date END) AS next FROM meetings WHERE customer<>'' GROUP BY LOWER(customer)")) calls[m.k] = m;
    const open = {};
    for (const r of rows) open[r.id] = 0;
    if (rows.length) for (const c of rows) open[c.id] = this.items(c.id, { includeDone: false }).length;
    return rows.map((r) => {
      const m = calls[r.name.toLowerCase()] || {};
      return {
        ...this.shape(r), contacts: r.n_contacts, devices: r.n_devices, openTasks: open[r.id] || 0, calls: m.n || 0, lastCall: m.last || null, nextCall: m.next || null,
        primary: r.primary_name ? { name: r.primary_name, email: r.primary_email, phone: r.primary_phone } : null,
      };
    });
  }

  get(id) {
    const c = this.shape(this.row(id));
    c.contacts = this.db.all('SELECT * FROM customer_contacts WHERE customer_id=? ORDER BY is_primary DESC, position, name', [id]).map((k) => ({
      id: k.id, name: k.name, title: k.title, email: k.email, phone: k.phone, mobile: k.mobile, primary: !!k.is_primary, notes: k.notes,
    }));
    c.devices = this.db.all('SELECT * FROM customer_devices WHERE customer_id=? ORDER BY position, name', [id]).map((d) => ({
      id: d.id, name: d.name, kind: d.kind, model: d.model, serial: d.serial, location: d.location, status: d.status, installed: d.installed, notes: d.notes,
    }));
    c.files = this.db.all('SELECT id, name, size, added_at FROM files WHERE customer_id=? ORDER BY added_at DESC', [id]);
    c.tasks = this.items(id);
    c.calls = this.meetings ? this.meetings.list({ customer: c.name }).slice(0, 100) : [];
    return c;
  }

  names() { return this.db.all('SELECT name FROM customers ORDER BY name COLLATE NOCASE').map((r) => r.name); }

  byName(name, create = false) {
    const n = str(name, 160);
    if (!n) return null;
    const hit = this.db.get('SELECT * FROM customers WHERE LOWER(name)=LOWER(?)', [n]);
    if (hit || !create) return hit ? this.shape(hit) : null;
    return { id: this.save({ name: n }), name: n };
  }

  save(c = {}) {
    const has = (k) => Object.prototype.hasOwnProperty.call(c, k);
    const cur = c.id ? this.row(c.id) : {};
    const name = has('name') ? str(c.name, 160) : cur.name;
    if (!name) throw new Error('A customer name is required');
    const dup = this.db.get('SELECT id FROM customers WHERE LOWER(name)=LOWER(?) AND id<>?', [name, c.id || '']);
    if (dup) throw new Error(`A customer called “${name}” already exists`);
    const f = {
      name,
      status: has('status') ? (STATUSES.includes(c.status) ? c.status : 'active') : cur.status || 'active',
      industry: has('industry') ? str(c.industry, 120) : cur.industry || '',
      website: has('website') ? str(c.website, 300) : cur.website || '',
      phone: has('phone') ? str(c.phone, 60) : cur.phone || '',
      email: has('email') ? str(c.email, 160) : cur.email || '',
      address: has('address') ? str(c.address, 400) : cur.address || '',
      account_no: has('accountNo') ? str(c.accountNo, 60) : cur.account_no || '',
      owner: has('owner') ? (c.owner || null) : cur.owner || null,
      tags: has('tags') ? JSON.stringify(cleanTags(c.tags)) : cur.tags || '[]',
      notes: has('notes') ? cleanHtml(c.notes) : cur.notes || '',
    };
    const t = now();
    if (c.id) {
      this.db.tx(() => {
        this.db.run('UPDATE customers SET name=?,status=?,industry=?,website=?,phone=?,email=?,address=?,account_no=?,owner=?,tags=?,notes=?,updated_at=? WHERE id=?',
          [f.name, f.status, f.industry, f.website, f.phone, f.email, f.address, f.account_no, f.owner, f.tags, f.notes, t, c.id]);
        // Calls keep the customer by name, so follow a rename.
        if (cur.name !== f.name) this.db.run('UPDATE meetings SET customer=? WHERE LOWER(customer)=LOWER(?)', [f.name, cur.name]);
      });
      return c.id;
    }
    const id = uid('cu');
    this.db.run('INSERT INTO customers(id,name,status,industry,website,phone,email,address,account_no,owner,tags,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, f.name, f.status, f.industry, f.website, f.phone, f.email, f.address, f.account_no, f.owner, f.tags, f.notes, t, t]);
    for (const k of Array.isArray(c.contacts) ? c.contacts : []) this.saveContact(id, k);
    for (const d of Array.isArray(c.devices) ? c.devices : []) this.saveDevice(id, d);
    return id;
  }

  /** Delete a profile with its contacts, devices and files. Board values pointing at it are cleared. */
  remove(id) {
    this.row(id);
    const files = this.db.all('SELECT id, stored_path FROM files WHERE customer_id=?', [id]);
    this.db.tx(() => {
      for (const it of this.items(id)) {
        const itemId = it.subId || it.id;
        const r = this.db.get('SELECT data FROM items WHERE id=?', [itemId]);
        const data = parseJson(r && r.data, {});
        for (const k of Object.keys(data)) if (Array.isArray(data[k]) && data[k].includes(id)) { data[k] = data[k].filter((x) => x !== id); if (!data[k].length) delete data[k]; }
        this.db.run('UPDATE items SET data=? WHERE id=?', [JSON.stringify(data), itemId]);
      }
      this.db.run('DELETE FROM customer_contacts WHERE customer_id=?', [id]);
      this.db.run('DELETE FROM customer_devices WHERE customer_id=?', [id]);
      this.db.run('DELETE FROM files WHERE customer_id=?', [id]);
      this.db.run('DELETE FROM customers WHERE id=?', [id]);
    });
    if (this.store.filesDir) for (const f of files) { try { fs.unlinkSync(path.join(this.store.filesDir, f.stored_path)); } catch (_) { /* already gone */ } }
    return true;
  }

  touch(id) { this.db.run('UPDATE customers SET updated_at=? WHERE id=?', [now(), id]); }

  saveContact(customerId, k = {}) {
    this.row(customerId);
    const name = str(k.name, 120);
    if (!name) throw new Error('A contact name is required');
    const f = [name, str(k.title, 120), str(k.email, 160), str(k.phone, 60), str(k.mobile, 60), k.primary ? 1 : 0, str(k.notes, 4000)];
    let id = k.id;
    this.db.tx(() => {
      if (k.primary) this.db.run('UPDATE customer_contacts SET is_primary=0 WHERE customer_id=?', [customerId]);
      if (id && this.db.get('SELECT id FROM customer_contacts WHERE id=? AND customer_id=?', [id, customerId])) {
        this.db.run('UPDATE customer_contacts SET name=?,title=?,email=?,phone=?,mobile=?,is_primary=?,notes=? WHERE id=?', [...f, id]);
      } else {
        id = uid('ck');
        const n = this.db.get('SELECT COUNT(*) AS n FROM customer_contacts WHERE customer_id=?', [customerId]).n;
        if (!n) f[5] = 1; // the first contact is the main one
        this.db.run('INSERT INTO customer_contacts(id,customer_id,name,title,email,phone,mobile,is_primary,notes,position,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [id, customerId, ...f, n + 1, now()]);
      }
      this.touch(customerId);
    });
    return id;
  }

  removeContact(id) {
    const k = this.db.get('SELECT customer_id, is_primary FROM customer_contacts WHERE id=?', [id]);
    if (!k) return false;
    this.db.run('DELETE FROM customer_contacts WHERE id=?', [id]);
    if (k.is_primary) this.db.run('UPDATE customer_contacts SET is_primary=1 WHERE id=(SELECT id FROM customer_contacts WHERE customer_id=? ORDER BY position LIMIT 1)', [k.customer_id]);
    this.touch(k.customer_id);
    return true;
  }

  saveDevice(customerId, d = {}) {
    this.row(customerId);
    const name = str(d.name, 160) || str(d.model, 160);
    if (!name) throw new Error('A device name or model is required');
    const installed = /^\d{4}-\d{2}-\d{2}$/.test(String(d.installed || '')) ? d.installed : '';
    const f = [name, str(d.kind, 80), str(d.model, 160), str(d.serial, 120), str(d.location, 200), DEVICE_STATUSES.includes(d.status) ? d.status : 'active', installed, str(d.notes, 4000)];
    let id = d.id;
    if (id && this.db.get('SELECT id FROM customer_devices WHERE id=? AND customer_id=?', [id, customerId])) {
      this.db.run('UPDATE customer_devices SET name=?,kind=?,model=?,serial=?,location=?,status=?,installed=?,notes=? WHERE id=?', [...f, id]);
    } else {
      id = uid('cd');
      const n = this.db.get('SELECT COUNT(*) AS n FROM customer_devices WHERE customer_id=?', [customerId]).n;
      this.db.run('INSERT INTO customer_devices(id,customer_id,name,kind,model,serial,location,status,installed,notes,position,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [id, customerId, ...f, n + 1, now()]);
    }
    this.touch(customerId);
    return id;
  }

  removeDevice(id) {
    const d = this.db.get('SELECT customer_id FROM customer_devices WHERE id=?', [id]);
    if (!d) return false;
    this.db.run('DELETE FROM customer_devices WHERE id=?', [id]);
    this.touch(d.customer_id);
    return true;
  }

  addFile(customerId, { name, bytes }) {
    if (!this.store.filesDir) throw new Error('Files are not available here');
    this.row(customerId);
    const id = uid('f');
    const safe = String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(-120);
    const dir = path.join(this.store.filesDir, 'customers');
    fs.mkdirSync(dir, { recursive: true });
    const stored = path.join(dir, `${id}-${safe}`);
    fs.writeFileSync(stored, Buffer.from(bytes));
    this.db.run('INSERT INTO files(id,item_id,meeting_id,customer_id,column_id,name,stored_path,size,added_by,added_at) VALUES(?,NULL,NULL,?,?,?,?,?,?,?)',
      [id, customerId, '', safe, path.relative(this.store.filesDir, stored), bytes.length, this.store.me().id, now()]);
    this.touch(customerId);
    return id;
  }

  /** Make profiles for customers that so far only exist as names on calls. */
  adoptCallCustomers() {
    let n = 0;
    for (const r of this.db.all("SELECT DISTINCT customer FROM meetings WHERE customer<>''")) {
      if (!this.byName(r.customer)) { this.save({ name: r.customer }); n += 1; }
    }
    return n;
  }

  /** A plain-text card for the clipboard. */
  summary(id) {
    const c = this.get(id);
    const lines = [c.name];
    if (c.accountNo) lines.push(`Account ${c.accountNo}`);
    for (const [k, v] of [['Phone', c.phone], ['Email', c.email], ['Website', c.website], ['Address', c.address]]) if (v) lines.push(`${k}: ${v}`);
    if (c.contacts.length) { lines.push('', 'Contacts'); for (const k of c.contacts) lines.push(`- ${k.name}${k.title ? `, ${k.title}` : ''}${k.email ? ` · ${k.email}` : ''}${k.phone ? ` · ${k.phone}` : ''}${k.mobile ? ` · ${k.mobile}` : ''}${k.primary ? ' (main contact)' : ''}`); }
    if (c.devices.length) { lines.push('', 'Devices'); for (const d of c.devices) lines.push(`- ${d.name}${d.model && d.model !== d.name ? ` (${d.model})` : ''}${d.serial ? ` · S/N ${d.serial}` : ''}${d.location ? ` · ${d.location}` : ''}${d.status !== 'active' ? ` · ${d.status}` : ''}`); }
    const notes = String(c.notes || '').replace(/<br\s*\/?>|<\/(p|li|h\d|div)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
    if (notes) lines.push('', 'Notes', notes);
    return lines.join('\n');
  }
}

module.exports = { Customers, STATUSES, DEVICE_STATUSES };
