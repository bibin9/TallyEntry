// DEMO MODE: the cloud relay, the office connector and a SIMULATED TallyPrime all run
// inside the browser, using the same code as the real relay and connector. Nothing here
// talks to a real Tally. Everything is labelled "Demo" in the UI.

import { RelayCore } from '../core/relay-core.js';
import { Connector, directRelay } from '../core/connector-core.js';
import { TallySim } from '../core/tally-sim.js';
import { defaultSettings } from '../core/defaults.js';
import { db } from './db.js';
import { NetworkError } from './api.js';
import { usersOp, newKey } from '../core/users-core.js';

const TID = 'demo';

export class DemoBackend {
  static async create() {
    const b = new DemoBackend();
    await b._load();
    return b;
  }

  async _load() {
    const saved = await db.get('demo', 'state');
    const st = saved?.value;
    this.flags = st?.flags || { internet: true, tallyOn: true };
    this.userKeys = st?.users || {
      [newKey()]: { id: 'demo-user', tenant: TID, name: 'Demo Salesperson', code: 'DEMO', role: 'admin', active: true },
      [newKey()]: { id: 'demo-ahm', tenant: TID, name: 'Ahmed (Sales)', code: 'AHM', role: 'sales', active: true },
    };
    this.sim = new TallySim(st?.tally);
    this.core = new RelayCore(st?.relay, () => this._save());
    const t = this.core.tenant(TID);
    if (!t.settings) {
      t.settings = defaultSettings(this.sim.company);
      Object.assign(t.settings.company, { address: 'Office 204, Al Qusais, Dubai, UAE', trn: '100123456700003', phone: '+971 4 000 0000', email: 'accounts@alnoor.example' });
    }
    this.connector = new Connector({ tally: async (x) => { if (!this.flags.tallyOn) throw new Error('TallyPrime is closed'); return this.sim.handle(x); }, relay: directRelay(this.core, TID), company: this.sim.company });
    this.mode = 'demo';
    this.listeners = new Set();
    this._timer = setInterval(() => this.tick(), 4000);
    await this.tick(); // the simulated office connector does its first master sync straight away
    await this._save(true);
  }

  _save(now) {
    clearTimeout(this._st);
    const doIt = () => db.put('demo', { key: 'state', value: { flags: this.flags, users: this.userKeys, tally: this.sim.s, relay: this.core.s } });
    if (now) return doIt();
    this._st = setTimeout(doIt, 300);
  }

  onChange(fn) { this.listeners.add(fn); }
  _emit() { for (const f of this.listeners) f(); }

  /** The office connector runs in the background whenever "Tally PC" and "internet" are on. */
  async tick() {
    if (!this.flags.tallyOn || !this.flags.internet || !navigator.onLine) return null;
    const r = await this.connector.runOnce();
    this._save();
    if (r.posted?.length || r.masters?.ledgers?.fetched || r.masters?.items?.fetched) this._emit();
    return r;
  }

  _net() { if (!navigator.onLine || !this.flags.internet) throw new NetworkError('No internet connection (demo)'); }
  async me() { this._net(); return { id: 'demo-user', name: 'Demo Salesperson', code: 'DEMO', role: 'admin', tenant: TID }; }
  async settings() { this._net(); return this.core.getSettings(TID); }
  async saveSettings(s) { this._net(); return this.core.putSettings(TID, s); }
  async masters(since) { this._net(); return structuredClone(await this.core.getMasters(TID, since)); }
  async push(txns) { this._net(); const r = await this.core.pushTransactions(TID, 'demo-user', structuredClone(txns)); setTimeout(() => this.tick(), 300); return r; }
  async statuses(ids) { this._net(); return structuredClone(await this.core.getStatuses(TID, ids)); }
  async retry(ids) { this._net(); const r = await this.core.retry(TID, ids); setTimeout(() => this.tick(), 300); return r; }
  async resolve(id, choice) { this._net(); const r = await this.core.resolveConflict(TID, id, choice); setTimeout(() => this.tick(), 300); return r; }
  async log() { return this.core.getLog(TID); }
  async connectorStatus() { return this.core.connectorStatus(TID); }
  _users(op, body) { this._net(); const r = usersOp(this.userKeys, TID, 'demo-user', op, body); if (op !== 'users.list') this._save(true); return r; }
  async users() { return this._users('users.list'); }
  async addUser(u) { return this._users('users.add', u); }
  async updateUser(u) { return this._users('users.update', u); }
  async resetUserKey(id) { return this._users('users.resetkey', { id }); }

  // ---------------------------------------------------------------- demo controls
  async setFlag(k, v) { this.flags[k] = v; this.sim.s.open = this.flags.tallyOn; await this._save(true); this._emit(); }
  dayBook() { return this.sim.dayBook(); }
  tallyLedgers(role) { return Object.values(this.sim.s.ledgers).filter((l) => !role || l.parent === role); }
  tallyItems() { return Object.values(this.sim.s.items); }
  renameLedgerInTally(oldName, newName) { this.sim.renameLedger(oldName, newName); this._save(); }
  addItemInTally(name, rate) { this.sim.addItem({ name, unit: 'Pcs', rate: Number(rate) || 1, cost: 0, vatClass: 'SR' }); this._save(); }
  editVoucherInTally(txnId) {
    const m = this.core.tenant(TID).mappings[txnId];
    if (!m) throw new Error('This transaction is not in Tally yet');
    this.sim.editVoucherInTally(m.masterId, 'Edited by the accountant in Tally (demo)');
    this._save();
  }
  loadBulk() { this.sim.seedBulk(5000, 10000); this._save(true); }
  async reset() { clearInterval(this._timer); await db.del('demo', 'state'); }
}
