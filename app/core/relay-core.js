// Cloud sync service logic ("relay"), independent of storage and transport.
// Used by: the Node dev server (JSON file storage), the in-browser demo, and the tests.
// The production Supabase/Postgres version implements the same operations in SQL
// (see relay/supabase/schema.sql); this file is the reference behaviour.

import { vanMoves } from './types.js';

const now = () => new Date().toISOString();

function blankTenant(id, name) {
  return {
    id, name, seq: 0,
    ledgers: {}, items: {},       // keyed by stable code
    txns: {},                     // keyed by transaction UUID
    mappings: {},                 // txn UUID -> Tally voucher
    log: [],                      // sync log, newest last (capped)
    connector: { state: { ledgerAlterId: 0, itemAlterId: 0, codeSeq: {}, lastKeysCheck: null }, lastSeen: null, version: null },
    settings: null,
    purged: {},                   // ids of deleted transactions -> time, so a late re-send is refused
    lastCleanup: null,
    vanMoves: {},                 // txn UUID -> { date, type, moves: [{van, itemCode, qty}] }; kept when the txn is cleaned up
  };
}

/** A retention setting in days: whole number, lo..3650, or the default if it is not a number. */
const days = (v, d, lo) => Math.min(Math.max(v !== null && v !== '' && Number.isFinite(+v) ? Math.trunc(+v) : d, lo), 3650);

const BALANCE_FIELDS = { ledgers: ['balance', 'overdue', 'overdueDays'], items: ['stock'] };
const MASTER_FIELDS = {
  ledgers: ['name', 'parent', 'role', 'phone', 'email', 'trn', 'address', 'balance', 'creditLimit', 'creditDays', 'priceLevel', 'tallyGuid', 'active'],
  items: ['name', 'group', 'unit', 'partNo', 'rate', 'cost', 'taxCode', 'stock', 'priceLevels', 'tallyGuid', 'active'],
};

export class RelayCore {
  /** state: persisted object; onChange: called after every mutation (to persist). */
  constructor(state, onChange = () => {}) {
    this.s = state || { tenants: {} };
    this.onChange = onChange;
  }
  tenant(tid) {
    if (!this.s.tenants[tid]) this.s.tenants[tid] = blankTenant(tid, tid);
    return this.s.tenants[tid];
  }
  _log(t, entry) {
    t.log.push({ at: now(), ...entry });
    if (t.log.length > 500) t.log.splice(0, t.log.length - 500);
  }
  async _save() { await this.onChange(this.s); }

  // ------------------------------------------------------------ settings
  async getSettings(tid) { return this.tenant(tid).settings; }
  async putSettings(tid, settings) { this.tenant(tid).settings = settings; await this._save(); return settings; }

  // ------------------------------------------------------------ device API
  /** Masters changed since the device's cursor (server sequence number). */
  async getMasters(tid, since = 0) {
    const t = this.tenant(tid);
    const pick = (coll) => Object.values(coll).filter((m) => m.seq > since);
    return { ledgers: pick(t.ledgers), items: pick(t.items), cursor: t.seq };
  }

  /** Idempotent upload. A version not newer than the stored one changes nothing. */
  async pushTransactions(tid, user, txns) {
    const t = this.tenant(tid);
    const results = [];
    for (const x of txns) {
      if (!x.id || !x.type || !(x.version >= 1)) { results.push({ id: x.id, accepted: false, error: 'invalid' }); continue; }
      if (t.purged?.[x.id]) { results.push({ id: x.id, accepted: false, purged: true, error: 'This entry is older than the company keeps data for, so it was not sent again' }); continue; }
      const cur = t.txns[x.id];
      if (cur && cur.version >= x.version) { results.push({ id: x.id, accepted: false, duplicate: true, version: cur.version }); continue; }
      const { status, error, tally, pushedVersion, syncedVersion, ...data } = x; // device-only fields are ignored
      t.txns[x.id] = { ...data, createdBy: cur?.createdBy || user, receivedAt: now(), status: 'queued', error: null, conflict: null };
      t.vanMoves ||= {};
      const mv = vanMoves(data);
      if (mv.length) t.vanMoves[x.id] = { date: data.date, type: data.type, moves: mv }; else delete t.vanMoves[x.id];
      this._log(t, { dir: 'device->cloud', id: x.id, number: x.number, version: x.version, result: cur ? 'updated' : 'received' });
      results.push({ id: x.id, accepted: true, version: x.version });
    }
    await this._save();
    return results;
  }

  /** Current sync status for the given transaction ids. */
  async getStatuses(tid, ids) {
    const t = this.tenant(tid);
    return ids.map((id) => {
      const x = t.txns[id];
      if (!x) return { id, status: 'unknown' };
      const m = t.mappings[id];
      return {
        id, status: x.status, version: x.version, error: x.error, conflict: x.conflict,
        syncedVersion: m?.syncedVersion || 0,
        tally: m ? { voucherNo: m.voucherNo, masterId: m.masterId, guid: m.guid, syncedAt: m.syncedAt } : null,
      };
    });
  }

  /** Office decision on a conflict: 'app' overwrites Tally, 'tally' keeps Tally's version. */
  async resolveConflict(tid, id, choice) {
    const t = this.tenant(tid);
    const x = t.txns[id];
    if (!x || x.status !== 'conflict') throw new Error('Not in conflict');
    if (choice === 'app') { x.status = 'queued'; x.force = true; x.conflict = null; }
    else { x.status = 'synced'; x.conflict = null; t.mappings[id].syncedVersion = x.version; x.keptTally = true; }
    this._log(t, { dir: 'office', id, number: x.number, result: 'conflict resolved: ' + (choice === 'app' ? 'app version sent' : 'Tally version kept') });
    await this._save();
    return { ok: true };
  }

  /** Retention: synced transactions stay active for serverActiveDays (default 7), are then archived
   *  for archiveDays (default 30), then deleted. Anything not yet in Tally is never touched. */
  async cleanup(tid, at = Date.now()) {
    const t = this.tenant(tid);
    const active = days(t.settings?.serverActiveDays, 7, 1), archive = days(t.settings?.archiveDays, 30, 0);
    const DAY = 86400000; let archived = 0, deleted = 0;
    t.purged ||= {};
    for (const x of Object.values(t.txns)) {
      const m = t.mappings[x.id];
      if (x.status !== 'synced') continue;
      if (!x.archivedAt && m && m.syncedVersion >= x.version && Date.parse(m.syncedAt) < at - active * DAY) { x.archivedAt = new Date(at).toISOString(); archived++; }
      else if (x.archivedAt && Date.parse(x.archivedAt) < at - archive * DAY) {
        delete t.txns[x.id]; delete t.mappings[x.id]; t.purged[x.id] = new Date(at).toISOString(); deleted++;
      }
    }
    const before = t.log.length;
    t.log = t.log.filter((l) => Date.parse(l.at) >= at - (active + archive) * DAY);
    for (const [id, when] of Object.entries(t.purged)) if (Date.parse(when) < at - 365 * DAY) delete t.purged[id];
    t.lastCleanup = new Date(at).toISOString();
    await this._save();
    return { archived, deleted, logDeleted: before - t.log.length };
  }

  /** Office check that everything reached Tally (same shape as txns.summary in SQL). */
  async getSummary(tid, users = {}) {
    const t = this.tenant(tid);
    const all = Object.values(t.txns), hourAgo = Date.now() - 3600000;
    const counts = { queued: 0, failed: 0, conflict: 0, synced: 0, archived: 0 };
    for (const x of all) { if (x.archivedAt) counts.archived++; else counts[x.status] = (counts[x.status] || 0) + 1; }
    const waiting = all.filter((x) => x.status !== 'synced').map((x) => x.receivedAt).sort();
    const attention = all.filter((x) => ['failed', 'conflict'].includes(x.status) || (x.status === 'queued' && Date.parse(x.receivedAt) < hourAgo))
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).slice(0, 100)
      .map((x) => ({ id: x.id, type: x.type, number: x.number, date: x.date, partyCode: x.partyCode, party: t.ledgers[x.partyCode]?.name, status: x.status,
        error: x.error || undefined, conflict: x.conflict || undefined, createdBy: users[x.createdBy] || x.createdBy, receivedAt: x.receivedAt, attempts: x.attempts || 0 }));
    return { counts, oldestWaiting: waiting[0] || null, connector: { lastSeen: t.connector.lastSeen, tallyOk: t.connector.tallyOk ?? null, version: t.connector.version }, attention };
  }

  /** Archived transactions for the office admin, newest first; q searches number, party code or name. */
  async getArchive(tid, q = '') {
    const t = this.tenant(tid);
    const archiveDays = days(t.settings?.archiveDays, 30, 0);
    const needle = String(q || '').toLowerCase();
    return Object.values(t.txns).filter((x) => x.archivedAt).map((x) => {
      const m = t.mappings[x.id], party = t.ledgers[x.partyCode]?.name;
      const total = x.type === 'rc' ? Number(x.amount) || 0  // before tax, like qe_txn_total() in SQL
        : (x.lines || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0) * (1 - (Number(l.discPct) || 0) / 100), 0);
      return { id: x.id, type: x.type, number: x.number, date: x.date, partyCode: x.partyCode, party, total: Math.round(total * 100) / 100, createdBy: x.createdBy,
        archivedAt: x.archivedAt, voucherNo: m?.voucherNo, syncedAt: m?.syncedAt, deleteOn: new Date(Date.parse(x.archivedAt) + archiveDays * 86400000).toISOString().slice(0, 10) };
    }).filter((r) => !needle || [r.number, r.partyCode, r.party].some((v) => String(v || '').toLowerCase().includes(needle)))
      .sort((a, b) => (b.archivedAt.localeCompare(a.archivedAt)) || String(b.number).localeCompare(String(a.number))).slice(0, 200);
  }

  /** Stock in each van (from issues, returns and van sales in the app) and, per item, the van sales
   *  not yet in Tally (Tally's stock figure does not include them yet). Same shape as stock.vans in SQL. */
  async getVanStock(tid) {
    const t = this.tenant(tid);
    const vans = {}, pending = {};
    for (const [id, e] of Object.entries(t.vanMoves || {})) {
      for (const m of e.moves) {
        const v = (vans[m.van] ||= { items: {}, lastIssue: null, lastReturn: null });
        v.items[m.itemCode] = Math.round(((v.items[m.itemCode] || 0) + m.qty) * 1000) / 1000;
      }
      const v = vans[e.moves[0]?.van];
      if (v && e.type === 'vi' && (!v.lastIssue || e.date > v.lastIssue)) v.lastIssue = e.date;
      if (v && e.type === 'vr' && (!v.lastReturn || e.date > v.lastReturn)) v.lastReturn = e.date;
      const x = t.txns[id];
      if (e.type === 'si' && x && x.status !== 'synced') for (const m of e.moves) pending[m.itemCode] = Math.round(((pending[m.itemCode] || 0) - m.qty) * 1000) / 1000;
    }
    for (const v of Object.values(vans)) for (const [k, q] of Object.entries(v.items)) if (!q) delete v.items[k];
    return { vans, pending };
  }

  async getLog(tid, limit = 100) { return this.tenant(tid).log.slice(-limit).reverse(); }

  // ------------------------------------------------------------ connector API
  async connectorHello(tid, info = {}) {
    const t = this.tenant(tid);
    t.connector.lastSeen = now(); t.connector.version = info.version || null; t.connector.tallyOk = info.tallyOk ?? null;
    if (!t.lastCleanup || Date.parse(t.lastCleanup) < Date.now() - 3600000) await this.cleanup(tid);
    await this._save();
    return { state: t.connector.state, settings: t.settings };
  }
  async connectorSaveState(tid, state) { this.tenant(tid).connector.state = state; await this._save(); }
  async connectorStatus(tid) { return this.tenant(tid).connector; }

  /** Upsert masters by stable code (GUID as fallback match). Returns counts. */
  async connectorPushMasters(tid, { ledgers = [], items = [] }) {
    const t = this.tenant(tid);
    const counts = { ledgers: { added: 0, updated: 0, unchanged: 0 }, items: { added: 0, updated: 0, unchanged: 0 } };
    for (const [kind, list] of [['ledgers', ledgers], ['items', items]]) {
      const coll = t[kind];
      for (const m of list) {
        if (!m.code) continue;
        let cur = coll[m.code];
        if (!cur && m.tallyGuid) {
          const byGuid = Object.values(coll).find((x) => x.tallyGuid === m.tallyGuid);
          if (byGuid) { delete coll[byGuid.code]; cur = byGuid; } // code was (re)assigned in Tally
        }
        const next = { ...m, active: true };
        const changed = !cur || MASTER_FIELDS[kind].some((f) => JSON.stringify(cur[f]) !== JSON.stringify(next[f])) || cur.code !== m.code;
        if (!changed) { counts[kind].unchanged++; continue; }
        coll[m.code] = { ...next, seq: ++t.seq, updatedAt: now() };
        counts[kind][cur ? 'updated' : 'added']++;
      }
    }
    this._log(t, { dir: 'tally->cloud', result: 'masters', counts });
    await this._save();
    return counts;
  }

  /** Merge refreshed balances, overdue amounts and stock into existing masters. Only these fields. */
  async connectorPushBalances(tid, { ledgers = [], items = [] }) {
    const t = this.tenant(tid);
    const out = { ledgers: 0, items: 0 };
    for (const [kind, list, fields] of [['ledgers', ledgers, BALANCE_FIELDS.ledgers], ['items', items, BALANCE_FIELDS.items]]) {
      for (const p of list) {
        const cur = t[kind][p?.code];
        if (!cur) continue;
        const patch = Object.fromEntries(fields.filter((f) => typeof p[f] === 'number' && Number.isFinite(p[f])).map((f) => [f, p[f]]));
        if (!Object.keys(patch).some((f) => cur[f] !== patch[f])) continue;
        Object.assign(cur, patch, { seq: ++t.seq, updatedAt: now() });
        out[kind]++;
      }
    }
    if (out.ledgers || out.items) { this._log(t, { dir: 'tally->cloud', result: `balances (${out.ledgers} customers/ledgers, ${out.items} items)` }); await this._save(); }
    return out;
  }

  /** Mark masters missing from Tally's full key list as inactive. */
  async connectorReconcile(tid, kind, codes) {
    const t = this.tenant(tid);
    const keep = new Set(codes);
    let n = 0;
    for (const m of Object.values(t[kind])) {
      if (m.active && !keep.has(m.code)) { m.active = false; m.seq = ++t.seq; n++; }
    }
    if (n) this._log(t, { dir: 'tally->cloud', result: `${n} ${kind} inactive (deleted in Tally)` });
    await this._save();
    return { deactivated: n };
  }

  /** Transactions waiting for Tally, with current Tally names resolved from stable codes. */
  async connectorQueue(tid, limit = 50) {
    const t = this.tenant(tid);
    const out = [];
    for (const x of Object.values(t.txns)) {
      const due = x.status === 'failed' && x.retryAt && x.retryAt <= Date.now() && (x.attempts || 0) < 6;
      if (x.status !== 'queued' && !due) continue;
      const party = t.ledgers[x.partyCode];
      const items = {};
      for (const l of x.lines || []) { const it = t.items[l.itemCode]; if (it) items[l.itemCode] = { name: it.name, unit: it.unit, cost: it.cost || 0 }; }
      const account = x.accountCode ? t.ledgers[x.accountCode]?.name : null;
      out.push({ txn: x, mapping: t.mappings[x.id] || null, names: { party: party?.name || null, items, account }, force: !!x.force });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Connector reports the outcome of posting one transaction version. */
  async connectorResult(tid, r) {
    const t = this.tenant(tid);
    const x = t.txns[r.id];
    if (!x) return { ok: false };
    const stale = r.version < x.version; // the device sent a newer edit meanwhile
    if (r.ok) {
      t.mappings[r.id] = {
        masterId: r.masterId, guid: r.guid || t.mappings[r.id]?.guid || null, voucherNo: r.voucherNo,
        syncedVersion: r.version, alterIdAtSync: r.alterId, syncedAt: now(),
      };
      if (!stale) { x.status = 'synced'; x.error = null; x.force = false; x.attempts = 0; x.retryAt = null; }
      this._log(t, { dir: 'cloud->tally', id: r.id, number: x.number, version: r.version, result: r.cancelled ? 'cancelled' : r.action === 'Alter' ? 'altered' : 'created', masterId: r.masterId });
    } else if (r.conflict) {
      if (!stale) { x.status = 'conflict'; x.conflict = r.conflict; }
      this._log(t, { dir: 'cloud->tally', id: r.id, number: x.number, version: r.version, result: 'conflict', message: r.conflict });
    } else {
      if (!stale) { x.status = 'failed'; x.error = r.error; x.attempts = (x.attempts || 0) + 1; x.retryAt = Date.now() + [1, 5, 15, 60, 240][Math.min(x.attempts - 1, 4)] * 60000; }
      this._log(t, { dir: 'cloud->tally', id: r.id, number: x.number, version: r.version, result: 'failed', message: r.error });
    }
    await this._save();
    return { ok: true };
  }

  /** Retry: failed transactions go back to the queue (from device or office). */
  async retry(tid, ids) {
    const t = this.tenant(tid);
    for (const id of ids) { const x = t.txns[id]; if (x && x.status === 'failed') { x.status = 'queued'; x.attempts = 0; } }
    await this._save();
    return { ok: true };
  }
}
