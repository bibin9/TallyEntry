// Office connector logic: Tally <-> cloud. Transport-agnostic.
//   tally(xml) -> Promise<xml>   (Node: HTTP POST to http://localhost:9000; demo: simulator)
//   relay: { hello, saveState, pushMasters, pushBalances, reconcile, queue, result }  (HTTP client or in-process)

import * as TX from './tally-xml.js';
import { DEFAULT_TAX } from './vat.js';

export const CONNECTOR_VERSION = '0.2.0';

export const DEFAULT_LEDGER_MAP = {
  salesLedger: 'Sales - Local', purchaseLedger: 'Purchase - Local',
  outputTaxLedger: 'Output VAT', inputTaxLedger: 'Input VAT', roundOffLedger: 'Round Off', cashLedger: 'Cash',
};

const CODE_PREFIX = { customer: 'C', supplier: 'S', account: 'A', other: 'L', item: 'I' };

export class Connector {
  constructor({ tally, relay, company, log = () => {}, conflictPolicy = 'tally-wins', writeCodes = true, keysCheckHours = 24 }) {
    Object.assign(this, { tally, relay, company, log, conflictPolicy, writeCodes, keysCheckHours });
    this.running = false;
  }

  async _tally(xml) {
    try { return await this.tally(xml); }
    catch (e) { const err = new Error('Tally not reachable: ' + e.message); err.tallyDown = true; throw err; }
  }

  /** One full cycle: masters first (so names are current), then pending transactions. */
  async runOnce() {
    if (this.running) return { skipped: true };
    this.running = true;
    const report = { masters: null, posted: [], error: null };
    try {
      let tallyOk = true;
      try { await this._tally(TX.keysRequest(this.company, 'Currency')); } catch (e) { tallyOk = false; }
      const { state, settings } = await this.relay.hello({ version: CONNECTOR_VERSION, tallyOk });
      this.state = { ledgerAlterId: 0, itemAlterId: 0, codeSeq: {}, ...(state || {}) };
      this.settings = settings || {};
      if (!tallyOk) { report.error = 'Tally not reachable'; return report; }
      report.masters = await this.syncMasters();
      report.posted = await this.postPending();
    } catch (e) {
      report.error = e.message;
      this.log('error', e.message);
    } finally { this.running = false; }
    return report;
  }

  // ------------------------------------------------------------------ masters
  _nextCode(prefix, existing) {
    let n = this.state.codeSeq[prefix] || 0;
    for (const c of existing) {
      const m = c && c.startsWith(prefix) && c.slice(prefix.length).match(/^\d+$/);
      if (m) n = Math.max(n, Number(c.slice(prefix.length)));
    }
    n += 1;
    this.state.codeSeq[prefix] = n;
    return prefix + String(n).padStart(6, '0');
  }

  async _fetchChanged(kind, since) {
    const req = kind === 'ledgers' ? TX.ledgersRequest(this.company, since) : TX.itemsRequest(this.company, since);
    const raw = TX.parseCollection(await this._tally(req), kind === 'ledgers' ? 'LEDGER' : 'STOCKITEM');
    // A real TallyPrime can return an empty <LEDGER/> or <STOCKITEM/> element (no GUID, no name),
    // for example when nothing matches the filter. Skip anything that is not a real master.
    return raw.map(kind === 'ledgers' ? TX.ledgerFromTally : TX.itemFromTally).filter((m) => m.tallyGuid && m.name);
  }

  async syncMasters() {
    const out = {};
    for (const kind of ['ledgers', 'items']) {
      const key = kind === 'ledgers' ? 'ledgerAlterId' : 'itemAlterId';
      const since = this.state[key] || 0;
      let list = await this._fetchChanged(kind, since);
      const full = since === 0;
      // Give every master a stable code. Codes are written back to Tally (QE Code field via TDL);
      // without the TDL the GUID is used as the code.
      const missing = list.filter((m) => !m.code);
      if (missing.length) {
        const existing = list.map((m) => m.code).filter(Boolean);
        for (const m of missing) {
          if (!this.writeCodes) { m.code = 'G:' + m.tallyGuid; continue; }
          const prefix = kind === 'items' ? CODE_PREFIX.item : CODE_PREFIX[m.role] || 'L';
          const code = this._nextCode(prefix, existing);
          const res = TX.parseImportResponse(await this._tally(TX.setMasterCodeRequest(this.company, kind === 'items' ? 'STOCKITEM' : 'LEDGER', m.name, code)));
          if (res.errors || !(res.altered || res.created)) { this.log('warn', `Could not write code to ${m.name}: ${res.messages.join('; ')}. Using GUID.`); m.code = 'G:' + m.tallyGuid; }
          else { m.code = code; existing.push(code); }
        }
        // Writing codes changed those masters' AlterIDs; read them back so the next run starts clean.
        const maxNow = Math.max(since, ...list.map((m) => m.tallyAlterId));
        const after = await this._fetchChanged(kind, maxNow);
        const byGuid = new Map(list.map((m) => [m.tallyGuid, m]));
        for (const m of after) byGuid.set(m.tallyGuid, m.code ? m : { ...m, code: byGuid.get(m.tallyGuid)?.code });
        list = [...byGuid.values()];
      }
      const maxAlter = Math.max(since, ...list.map((m) => m.tallyAlterId));
      for (const m of list) this._bal?.[kind].delete(m.code); // a full push replaces the record; resend its balance
      const counts = list.length ? (await this.relay.pushMasters(kind === 'ledgers' ? { ledgers: list } : { items: list }))[kind] : { added: 0, updated: 0, unchanged: 0 };
      this.state[key] = maxAlter;
      out[kind] = { fetched: list.length, full, ...counts };
    }
    // Never let the balance refresh hold up posting vouchers.
    try { out.balances = await this.refreshBalances(); this._balWarned = false; }
    catch (e) {
      if (e.tallyDown) throw e;
      if (!this._balWarned) this.log('warn', `Balance and stock refresh skipped: ${e.message}`);
      this._balWarned = true; out.balances = { error: e.message };
    }
    // Daily: compare full key lists to find masters deleted in Tally.
    const last = this.state.lastKeysCheck ? Date.parse(this.state.lastKeysCheck) : 0;
    if (Date.now() - last > this.keysCheckHours * 3600e3) {
      for (const [kind, type, tag] of [['ledgers', 'Ledger', 'LEDGER'], ['items', 'StockItem', 'STOCKITEM']]) {
        const keys = TX.parseCollection(await this._tally(TX.keysRequest(this.company, type)), tag);
        await this.relay.reconcile(kind, keys.map((k) => k.QECODE || 'G:' + k.GUID));
      }
      this.state.lastKeysCheck = new Date().toISOString();
    }
    await this.relay.saveState(this.state);
    this.log('info', `Masters: ledgers ${out.ledgers.fetched} fetched, items ${out.items.fetched} fetched`);
    return out;
  }

  /** Balances, overdue amounts and stock change with every sale and receipt, but the masters'
   *  AlterIDs do not. Read them in full and send only what changed since the last send. */
  async refreshBalances() {
    if (!this.relay.pushBalances) return null;
    this._bal ||= { ledgers: new Map(), items: new Map() };
    const codeOf = (o) => o.QECODE || 'G:' + o.GUID;
    const ledgers = TX.parseCollection(await this._tally(TX.balancesRequest(this.company, 'Ledger')), 'LEDGER').filter((o) => o.GUID);
    const items = TX.parseCollection(await this._tally(TX.balancesRequest(this.company, 'StockItem')), 'STOCKITEM').filter((o) => o.GUID);
    let overdue = {};
    try {
      const creditDays = Object.fromEntries(ledgers.map((o) => [o.NAME, Number(String(o.BILLCREDITPERIOD || '').match(/\d+/)?.[0] || 0)]));
      overdue = TX.overdueByParty(TX.parseCollection(await this._tally(TX.billsRequest(this.company)), 'BILL'), creditDays);
      this._billsWarned = false;
    } catch (e) {
      if (!this._billsWarned) this.log('warn', `Could not read outstanding bills, so overdue amounts are not shown: ${e.message}`);
      this._billsWarned = true;
    }
    const changed = { ledgers: [], items: [] };
    const add = (kind, code, patch) => {
      const key = JSON.stringify(patch);
      if (this._bal[kind].get(code) === key) return;
      changed[kind].push({ code, ...patch });
      this._bal[kind].set(code, key);
    };
    for (const o of ledgers) add('ledgers', codeOf(o), { balance: TX.drBalance(o.CLOSINGBALANCE), overdue: overdue[o.NAME]?.overdue || 0, overdueDays: overdue[o.NAME]?.overdueDays || 0 });
    for (const o of items) add('items', codeOf(o), { stock: Number(String(o.CLOSINGBALANCE || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/)?.[0] || 0) });
    if (!changed.ledgers.length && !changed.items.length) return { ledgers: 0, items: 0 };
    try {
      const r = await this.relay.pushBalances(changed);
      return { ledgers: r?.ledgers ?? changed.ledgers.length, items: r?.items ?? changed.items.length };
    } catch (e) {
      for (const kind of ['ledgers', 'items']) for (const m of changed[kind]) this._bal[kind].delete(m.code); // retry next time
      throw e;
    }
  }

  // ------------------------------------------------------------------ transactions
  async _findVoucher(by, value) {
    const req = by === 'txn' ? TX.voucherByTxnIdRequest(this.company, value) : TX.voucherByMasterIdRequest(this.company, value);
    const list = TX.parseCollection(await this._tally(req), 'VOUCHER');
    if (!list.length) return null;
    const v = list[list.length - 1];
    return { masterId: Number(String(v.MASTERID).trim()), alterId: Number(String(v.ALTERID).trim()), guid: v.GUID, voucherNo: v.VOUCHERNUMBER, count: list.length };
  }

  /** Cancel in Tally an entry the app cancelled. Nothing in Tally yet (or deleted there): nothing to do. */
  async _cancel(txn, mapping, r) {
    let target = mapping?.masterId ? await this._findVoucher('mid', mapping.masterId) : null;
    if (!target) target = await this._findVoucher('txn', txn.id);
    if (!target) {
      await this.relay.result({ ...r, ok: true, action: 'Alter', cancelled: true, masterId: mapping?.masterId || null, voucherNo: mapping?.voucherNo || txn.number });
      this.log('info', `${txn.number}: cancelled in the app; no voucher in Tally to cancel`);
      return { ...r, ok: true, action: 'Cancel', masterId: null };
    }
    const res = TX.parseImportResponse(await this._tally(TX.cancelVoucherRequest(this.company, txn, target.masterId, txn.cancelReason || '')));
    if (res.errors || !(res.cancelled || res.altered)) {
      const msg = res.messages.join('; ') || 'Tally did not cancel the voucher';
      await this.relay.result({ ...r, ok: false, error: msg });
      return { ...r, ok: false, error: msg };
    }
    const after = await this._findVoucher('mid', target.masterId);
    await this.relay.result({ ...r, ok: true, action: 'Alter', cancelled: true, masterId: target.masterId, alterId: after?.alterId, guid: after?.guid || target.guid, voucherNo: after?.voucherNo || target.voucherNo });
    this.log('info', `${txn.number} v${txn.version}: cancelled Tally voucher ${target.masterId}`);
    return { ...r, ok: true, action: 'Cancel', masterId: target.masterId };
  }

  async postPending() {
    const queue = await this.relay.queue();
    const results = [];
    const tax = this.settings.tax || DEFAULT_TAX;
    const map = { ...DEFAULT_LEDGER_MAP, ...(this.settings.ledgerMap || {}) };
    for (const { txn, mapping, names, force } of queue) {
      const r = { id: txn.id, version: txn.version };
      try {
        if (txn.cancelled) { results.push(await this._cancel(txn, mapping, r)); continue; }
        if (!names.party) throw new Error(`Party code ${txn.partyCode} not found in synced masters`);
        let target = null;
        if (mapping?.masterId) {
          target = await this._findVoucher('mid', mapping.masterId);
          if (!target) { await this.relay.result({ ...r, conflict: 'Voucher was deleted in Tally' }); results.push({ ...r, conflict: true }); continue; }
          const changedInTally = mapping.alterIdAtSync && target.alterId !== mapping.alterIdAtSync;
          if (changedInTally && !force && this.conflictPolicy === 'tally-wins') {
            const msg = `Voucher ${target.voucherNo} was changed in Tally after the last sync`;
            await this.relay.result({ ...r, conflict: msg });
            results.push({ ...r, conflict: true });
            continue;
          }
        } else {
          // Never confirmed: the previous attempt may have reached Tally but lost its reply.
          target = await this._findVoucher('txn', txn.id);
          if (target) this.log('info', `${txn.number}: already in Tally (voucher ${target.masterId}); altering instead of creating`);
        }
        const action = target ? 'Alter' : 'Create';
        const xml = TX.voucherRequest(this.company, txn, names, map, tax, action, target?.masterId);
        const res = TX.parseImportResponse(await this._tally(xml));
        if (res.errors || (!res.created && !res.altered)) {
          const msg = res.messages.join('; ') || 'Tally did not accept the voucher';
          await this.relay.result({ ...r, ok: false, error: msg });
          results.push({ ...r, ok: false, error: msg });
          continue;
        }
        const masterId = res.lastVchId || target?.masterId;
        const after = await this._findVoucher('mid', masterId);
        await this.relay.result({ ...r, ok: true, action, masterId, alterId: after?.alterId, guid: after?.guid, voucherNo: after?.voucherNo || txn.number });
        results.push({ ...r, ok: true, action, masterId });
        this.log('info', `${txn.number} v${txn.version}: ${action === 'Alter' ? 'altered' : 'created'} Tally voucher ${masterId}`);
      } catch (e) {
        if (e.tallyDown) throw e; // stop the cycle; nothing is lost, the queue stays as is
        await this.relay.result({ ...r, ok: false, error: e.message });
        results.push({ ...r, ok: false, error: e.message });
      }
    }
    return results;
  }
}

/** Adapter: use a RelayCore instance directly (demo, tests). */
export function directRelay(core, tid) {
  return {
    hello: (info) => core.connectorHello(tid, info),
    saveState: (s) => core.connectorSaveState(tid, s),
    pushMasters: (b) => core.connectorPushMasters(tid, b),
    pushBalances: (b) => core.connectorPushBalances(tid, b),
    reconcile: (k, c) => core.connectorReconcile(tid, k, c),
    queue: () => core.connectorQueue(tid),
    result: (r) => core.connectorResult(tid, r),
  };
}
