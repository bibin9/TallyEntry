// Device sync engine: outbox upload, status download, incremental master download, retention.
// Every write goes to IndexedDB first; the network is only ever a background step.

import { db } from './db.js';
import { NetworkError } from './api.js';
import { uuid } from '../core/types.js';

const DEVICE_ONLY = ['pushedVersion', 'syncedVersion', 'status', 'error', 'conflict', 'tally', 'lastStatusAt'];

export class SyncEngine {
  constructor(api, onChange) {
    this.api = api;
    this.onChange = onChange || (() => {});
    this.running = false;
    this.lastError = null;
    this.lastSync = null;
    this.offline = !navigator.onLine;
  }

  async init() {
    this.lastSync = await db.meta('lastSync');
    // Remember a device id so the office can tell where a transaction came from.
    if (!(await db.meta('deviceId'))) await db.meta('deviceId', uuid());
    this.deviceId = await db.meta('deviceId');
  }

  start() {
    window.addEventListener('online', () => { this.offline = false; this.syncNow(); });
    window.addEventListener('offline', () => { this.offline = true; this.onChange(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.syncNow(); });
    this._iv = setInterval(() => this.syncNow(), 20000);
    this.syncNow();
  }

  /** Save a transaction locally. New edits always raise the version, so the server and Tally follow. */
  async saveTransaction(data) {
    const old = data.id ? await db.get('txns', data.id) : null;
    const now = new Date().toISOString();
    const txn = {
      ...(old || {}), ...data,
      id: old?.id || data.id || uuid(),
      version: (old?.version || 0) + 1,
      pushedVersion: old?.pushedVersion || 0,
      syncedVersion: old?.syncedVersion || 0,
      createdAt: old?.createdAt || now,
      updatedAt: now,
      deviceId: this.deviceId,
      status: 'pending', error: null, conflict: null,
    };
    await db.put('txns', txn);
    this.onChange();
    setTimeout(() => this.syncNow(), 50);
    return txn;
  }

  async counts() {
    const all = await db.all('txns');
    const c = { pending: 0, sent: 0, synced: 0, failed: 0, conflict: 0, total: all.length };
    for (const t of all) c[t.status] = (c[t.status] || 0) + 1;
    return c;
  }

  async syncNow({ manual = false } = {}) {
    if (this.running) return this._current;
    this.running = true;
    this.onChange();
    this._current = this._run(manual).finally(() => { this.running = false; this.onChange(); });
    return this._current;
  }

  async _run(manual) {
    const report = { pushed: 0, updated: 0, masters: 0, error: null };
    try {
      // 1. Upload every transaction whose current version has not reached the server.
      const all = await db.all('txns');
      const outbox = all.filter((t) => t.version > (t.pushedVersion || 0));
      for (let i = 0; i < outbox.length; i += 50) {
        const chunk = outbox.slice(i, i + 50);
        const clean = chunk.map((t) => { const o = { ...t }; for (const k of DEVICE_ONLY) delete o[k]; return o; });
        const res = await this.api.push(clean);
        for (const r of res) {
          const cur = await db.get('txns', r.id);
          const sentVersion = chunk.find((t) => t.id === r.id).version;
          if (cur && r.purged) { // already in Tally and since cleaned off the server: nothing left to send
            Object.assign(cur, { pushedVersion: cur.version, syncedVersion: cur.version, status: 'synced', error: null });
            await db.put('txns', cur); continue;
          }
          if (!cur || (!r.accepted && !r.duplicate)) continue;
          // Only mark as sent if it was not edited again while uploading.
          cur.pushedVersion = Math.max(cur.pushedVersion || 0, sentVersion);
          if (cur.version === sentVersion) cur.status = 'sent';
          await db.put('txns', cur);
          report.pushed++;
        }
      }
      // 2. Ask the server what Tally said about everything not yet final.
      const open = (await db.all('txns')).filter((t) => t.pushedVersion && t.status !== 'synced' && t.status !== 'pending');
      for (let i = 0; i < open.length; i += 100) {
        const st = await this.api.statuses(open.slice(i, i + 100).map((t) => t.id));
        for (const s of st) {
          const cur = await db.get('txns', s.id);
          if (!cur || cur.status === 'pending') continue;
          if (s.status === 'unknown') { cur.pushedVersion = 0; cur.status = 'pending'; } // server lost it: upload again
          else {
            cur.tally = s.tally || cur.tally;
            cur.syncedVersion = s.syncedVersion || cur.syncedVersion || 0;
            if (s.status === 'synced' && cur.syncedVersion >= cur.version) { cur.status = 'synced'; cur.error = null; cur.conflict = null; }
            else if (s.status === 'synced' && s.version >= cur.version) { cur.status = 'synced'; } // Tally version kept by office
            else if (s.status === 'failed') { cur.status = 'failed'; cur.error = s.error; }
            else if (s.status === 'conflict') { cur.status = 'conflict'; cur.conflict = s.conflict; }
            else cur.status = 'sent';
          }
          cur.lastStatusAt = new Date().toISOString();
          await db.put('txns', cur);
          report.updated++;
        }
      }
      // 3. Masters changed since our cursor (first time: everything).
      const since = (await db.meta('mastersCursor')) || 0;
      const m = await this.api.masters(since);
      if (m.ledgers.length) await db.putMany('ledgers', m.ledgers);
      if (m.items.length) await db.putMany('items', m.items);
      await db.meta('mastersCursor', m.cursor);
      report.masters = m.ledgers.length + m.items.length;
      // 4. Settings (VAT, company details, ledger mapping).
      const settings = await this.api.settings();
      if (settings) await db.meta('settings', settings);
      // 5. Housekeeping: keep recent and unsynced transactions; drop old synced ones.
      await this.cleanup(settings?.retentionDays ?? 2);
      this.lastSync = new Date().toISOString();
      await db.meta('lastSync', this.lastSync);
      this.lastError = null;
      this.offline = false;
    } catch (e) {
      report.error = e.message;
      this.lastError = e instanceof NetworkError ? null : e.message;
      this.offline = e instanceof NetworkError;
      if (manual && !(e instanceof NetworkError)) console.warn('Sync failed', e);
    }
    this.lastReport = report;
    return report;
  }

  async cleanup(days) {
    const cutoff = Date.now() - Math.max(1, days) * 86400e3;
    const all = await db.all('txns');
    let n = 0;
    for (const t of all) {
      const final = t.status === 'synced' && t.syncedVersion >= t.version;
      const old = Date.parse(t.updatedAt) < cutoff && Date.parse(t.date + 'T23:59:59') < cutoff;
      if (final && old) { await db.del('txns', t.id); n++; }
    }
    return n;
  }
}
