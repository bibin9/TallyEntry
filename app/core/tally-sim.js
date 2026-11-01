// SIMULATED TallyPrime. For demos and automated tests only.
// It answers the same XML requests the connector sends to a real TallyPrime on port 9000,
// with Tally-like rules (masters referenced by name, AlterID on every change, LINEERROR on
// missing ledgers). It is NOT TallyPrime and passing tests against it does not verify the
// live integration.
//
// Deliberately strict: a Create with an existing REMOTEID makes a second voucher, so the
// connector's own duplicate protection is what keeps the books clean.

import { esc, parseXml, deep, deepAll, find, findAll, childText, text, bare } from './xml.js';
import { uuid } from './types.js';

const CUSTOMERS = [
  ['Al Madina Supermarket', '971501110001', 'accounts@almadina.example', '100234567800003', 'Industrial Area 2, Sharjah'],
  ['Gulf Star Electronics', '971501110002', 'purchase@gulfstar.example', '100345678900003', 'Deira, Dubai'],
  ['Emirates Hardware LLC', '971501110003', 'emhw@example.com', '100456789000003', 'Al Jurf, Ajman'],
  ['Desert Rose Trading', '971501110004', 'desertrose@example.com', '', 'Mussafah, Abu Dhabi'],
  ['Blue Lagoon Contracting', '971501110005', 'ops@bluelagoon.example', '100567812300003', 'Al Quoz, Dubai'],
  ['Palm Line Interiors', '971501110006', 'buy@palmline.example', '100678123400003', 'JLT, Dubai'],
];
const SUPPLIERS = [
  ['Sharjah Wholesale Co', '971551110011', 'sales@sharjahwholesale.example', '100567890100003', 'Sharjah'],
  ['Jebel Ali Distributors', '971551110012', 'orders@jadist.example', '100678901200003', 'Jebel Ali, Dubai'],
];
const ITEMS = [
  ['LED Panel Light 18W', 'Pcs', 42, 30, 'SR', 'LP-18'],
  ['Ceiling Fan 56"', 'Pcs', 185, 140, 'SR', 'CF-56'],
  ['Extension Socket 4-way', 'Pcs', 28, 19, 'SR', 'ES-4'],
  ['Copper Cable 2.5mm (100m)', 'Roll', 265, 210, 'SR', 'CC-25'],
  ['MCB 32A', 'Pcs', 24, 16, 'SR', 'MCB-32'],
  ['Wall Switch 1-gang', 'Pcs', 6.5, 4, 'SR', 'WS-1'],
  ['Export Packing Crate', 'Nos', 120, 80, 'ZR', 'PK-EX'],
];

export class TallySim {
  constructor(state) {
    this.s = state || TallySim.seed();
  }

  static seed() {
    const s = { company: 'Al Noor Trading LLC (Demo)', alterSeq: 0, masterSeq: 0, ledgers: {}, items: {}, vouchers: [], vchNo: {}, open: true };
    const sim = new TallySim(s);
    const L = (name, parent, extra = {}) => sim.addLedger({ name, parent, ...extra });
    L('Cash', 'Cash-in-Hand'); L('Emirates NBD Current A/c', 'Bank Accounts'); L('ADCB Current A/c', 'Bank Accounts');
    L('Sales - Local', 'Sales Accounts'); L('Purchase - Local', 'Purchase Accounts');
    L('Output VAT', 'Duties & Taxes'); L('Input VAT', 'Duties & Taxes'); L('Round Off', 'Indirect Expenses');
    // Some masters start with a code already (as if the client had them); others get one from the connector.
    CUSTOMERS.forEach(([name, phone, email, trn, address], i) => L(name, 'Sundry Debtors', { phone, email, trn, address, qeCode: i < 2 ? `C${String(i + 1).padStart(6, '0')}` : '' }));
    SUPPLIERS.forEach(([name, phone, email, trn, address]) => L(name, 'Sundry Creditors', { phone, email, trn, address }));
    ITEMS.forEach(([name, unit, rate, cost, vat, partNo]) => sim.addItem({ name, unit, rate, cost, vatClass: vat, partNo, stock: 100 + name.length * 7 }));
    return s;
  }

  get company() { return this.s.company; }
  _alter() { return ++this.s.alterSeq; }
  _mid() { return ++this.s.masterSeq; }

  addLedger({ name, parent, phone = '', email = '', trn = '', address = '', qeCode = '' }) {
    const id = this._mid();
    this.s.ledgers[name] = { guid: uuid(), masterId: id, alterId: this._alter(), name, parent, phone, email, trn, address, qeCode };
    return this.s.ledgers[name];
  }
  addItem({ name, unit = 'Nos', rate = 0, cost = 0, vatClass = 'SR', partNo = '', stock = 0, group = 'Primary', qeCode = '' }) {
    this.s.items[name] = { guid: uuid(), masterId: this._mid(), alterId: this._alter(), name, unit, rate, cost, vatClass, partNo, stock, group, qeCode };
    return this.s.items[name];
  }
  /** Rename a ledger the way a Tally user would (Alt+C / Alter). */
  renameLedger(oldName, newName) {
    const l = this.s.ledgers[oldName];
    if (!l) throw new Error('No ledger ' + oldName);
    if (this.s.ledgers[newName]) throw new Error('Name already exists');
    delete this.s.ledgers[oldName];
    l.name = newName; l.alterId = this._alter();
    this.s.ledgers[newName] = l;
    for (const v of this.s.vouchers) if (v.party === oldName) v.party = newName; // Tally relinks by internal id
    return l;
  }
  renameItem(oldName, newName) {
    const it = this.s.items[oldName];
    delete this.s.items[oldName];
    it.name = newName; it.alterId = this._alter();
    this.s.items[newName] = it;
    return it;
  }
  changeItemRate(name, rate) { const it = this.s.items[name]; it.rate = rate; it.alterId = this._alter(); return it; }
  deleteLedger(name) { delete this.s.ledgers[name]; }
  /** A Tally user edits a voucher directly (used to demonstrate conflicts). */
  editVoucherInTally(masterId, narration = 'Edited in Tally') {
    const v = this.s.vouchers.find((x) => x.masterId === Number(masterId));
    if (!v) throw new Error('No voucher ' + masterId);
    v.narration = narration; v.alterId = this._alter();
    return v;
  }
  /** Bulk sample data for performance tests. */
  seedBulk(nCustomers = 5000, nItems = 10000) {
    const areas = ['Deira', 'Bur Dubai', 'Al Quoz', 'Sharjah', 'Ajman', 'Mussafah', 'Al Ain', 'RAK', 'Fujairah', 'JLT'];
    const words = ['Trading', 'General Trading', 'Contracting', 'Electricals', 'Building Materials', 'Supermarket', 'Hardware', 'Interiors', 'Technical Services', 'Lighting'];
    const names = ['Al Fajr', 'Golden Sands', 'Crescent', 'Oasis', 'Pearl', 'Falcon', 'Horizon', 'Marina', 'Zenith', 'Royal', 'Sahara', 'Coral', 'Summit', 'Nakheel', 'Silver Line'];
    for (let i = 0; i < nCustomers; i++) {
      const n = `${names[i % names.length]} ${words[(i * 7) % words.length]} ${areas[(i * 3) % areas.length]} ${i + 1}`;
      if (!this.s.ledgers[n]) this.addLedger({ name: n, parent: 'Sundry Debtors', phone: '9715' + String(10000000 + i), trn: i % 3 ? '100' + String(100000000000 + i) : '', address: areas[(i * 3) % areas.length] });
    }
    const kinds = ['LED Bulb', 'Cable', 'Switch', 'Socket', 'Breaker', 'Conduit', 'Panel', 'Fan', 'Lamp', 'Adaptor', 'Junction Box', 'Plug'];
    const specs = ['5W', '9W', '12W', '18W', '2.5mm', '4mm', '6A', '10A', '16A', '32A', 'White', 'Black', 'IP65', '3-pin'];
    for (let i = 0; i < nItems; i++) {
      const n = `${kinds[i % kinds.length]} ${specs[(i * 5) % specs.length]} Model ${1000 + i}`;
      if (!this.s.items[n]) this.addItem({ name: n, unit: i % 9 === 0 ? 'Box' : 'Pcs', rate: 5 + (i % 300), cost: 3 + (i % 200), vatClass: 'SR', partNo: 'P' + (1000 + i), stock: i % 500 });
    }
  }

  dayBook() {
    return this.s.vouchers.map((v) => ({ ...v }));
  }

  // ------------------------------------------------------------------ XML entry point
  handle(xml) {
    if (this.s.open === false) throw new Error('ECONNREFUSED: TallyPrime is not running');
    const root = parseXml(xml);
    const req = text(deep(root, 'TALLYREQUEST')).toLowerCase();
    const company = text(deep(root, 'SVCURRENTCOMPANY'));
    if (company && company !== this.s.company) {
      return `<RESPONSE><LINEERROR>Could not set &apos;SVCurrentCompany&apos; to &apos;${esc(company)}&apos;</LINEERROR></RESPONSE>`;
    }
    if (req === 'export') return this._export(root);
    if (req === 'import data' || req === 'import') return this._import(root);
    return '<RESPONSE><LINEERROR>Unknown Request, cannot be processed</LINEERROR></RESPONSE>';
  }

  _filter(root) {
    const f = text(deep(root, 'SYSTEM'));
    if (!f) return () => true;
    const m = f.match(/^\$(\w+)\s*(>|=)\s*"?([^"]*)"?$/);
    if (!m) throw new Error('Simulator does not support formula ' + f);
    const [, field, op, val] = m;
    const key = { AlterID: 'alterId', MasterID: 'masterId', QETxnID: 'qeTxnId', GUID: 'guid' }[field];
    return (o) => (op === '>' ? Number(o[key]) > Number(val) : String(o[key]) === val);
  }

  _export(root) {
    const type = text(deep(deep(root, 'COLLECTION'), 'TYPE'));
    const keep = this._filter(root);
    let out = '';
    const u = (n, v) => `<UDF:${n}.LIST DESC="\`${n}\`" ISLIST="YES" TYPE="String"><UDF:${n} DESC="\`${n}\`">${esc(v)}</UDF:${n}></UDF:${n}.LIST>`;
    if (type === 'Ledger') {
      for (const l of Object.values(this.s.ledgers)) if (keep(l)) {
        out += `<LEDGER NAME="${esc(l.name)}" RESERVEDNAME=""><GUID>${l.guid}</GUID><MASTERID> ${l.masterId}</MASTERID><ALTERID> ${l.alterId}</ALTERID><PARENT>${esc(l.parent)}</PARENT>`
          + `<LEDGERMOBILE>${esc(l.phone)}</LEDGERMOBILE><EMAIL>${esc(l.email)}</EMAIL><VATTINNUMBER>${esc(l.trn)}</VATTINNUMBER>`
          + `<ADDRESS.LIST TYPE="String"><ADDRESS>${esc(l.address)}</ADDRESS></ADDRESS.LIST>${l.qeCode ? u('QECODE', l.qeCode) : ''}</LEDGER>`;
      }
    } else if (type === 'StockItem') {
      for (const i of Object.values(this.s.items)) if (keep(i)) {
        out += `<STOCKITEM NAME="${esc(i.name)}"><GUID>${i.guid}</GUID><MASTERID> ${i.masterId}</MASTERID><ALTERID> ${i.alterId}</ALTERID><PARENT>${esc(i.group)}</PARENT>`
          + `<BASEUNITS>${esc(i.unit)}</BASEUNITS><PARTNO>${esc(i.partNo)}</PARTNO><STANDARDPRICE>${i.rate.toFixed(2)}/${esc(i.unit)}</STANDARDPRICE><STANDARDCOST>${i.cost.toFixed(2)}/${esc(i.unit)}</STANDARDCOST>`
          + `<VATCLASS>${esc(i.vatClass)}</VATCLASS><CLOSINGBALANCE> ${i.stock} ${esc(i.unit)}</CLOSINGBALANCE>${i.qeCode ? u('QECODE', i.qeCode) : ''}</STOCKITEM>`;
      }
    } else if (type === 'Voucher') {
      for (const v of this.s.vouchers) if (keep(v)) {
        out += `<VOUCHER REMOTEID="${esc(v.remoteId)}" VCHTYPE="${esc(v.vchType)}"><GUID>${v.guid}</GUID><MASTERID> ${v.masterId}</MASTERID><ALTERID> ${v.alterId}</ALTERID>`
          + `<DATE>${v.date}</DATE><VOUCHERTYPENAME>${esc(v.vchType)}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(v.number)}</VOUCHERNUMBER>${u('QETXNID', v.qeTxnId)}</VOUCHER>`;
      }
    } else return `<RESPONSE><LINEERROR>Simulator: unsupported collection type ${esc(type)}</LINEERROR></RESPONSE>`;
    return `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC></DESC><DATA><COLLECTION>${out}</COLLECTION></DATA></BODY></ENVELOPE>`;
  }

  _udf(node, name) {
    const l = find(node, name + '.LIST');
    return l ? text(find(l, name)) : childText(node, name);
  }

  _import(root) {
    const msg = deep(root, 'TALLYMESSAGE');
    const r = { created: 0, altered: 0, errors: 0, lastVchId: 0, lastMid: 0, lineErrors: [] };
    for (const n of msg ? msg.children : []) {
      const tag = bare(n.name);
      try {
        if (tag === 'VOUCHER') this._importVoucher(n, r);
        else if (tag === 'LEDGER' || tag === 'STOCKITEM') this._importMaster(tag, n, r);
      } catch (e) { r.errors++; r.lineErrors.push(e.message); }
    }
    return `<RESPONSE><CREATED>${r.created}</CREATED><ALTERED>${r.altered}</ALTERED><DELETED>0</DELETED><LASTVCHID>${r.lastVchId}</LASTVCHID><LASTMID>${r.lastMid}</LASTMID><COMBINED>0</COMBINED><IGNORED>0</IGNORED><ERRORS>${r.errors}</ERRORS><CANCELLED>0</CANCELLED><EXCEPTIONS>0</EXCEPTIONS>${r.lineErrors.map((e) => `<LINEERROR>${esc(e)}</LINEERROR>`).join('')}</RESPONSE>`;
  }

  _importMaster(tag, n, r) {
    const name = n.attrs.NAME;
    const coll = tag === 'LEDGER' ? this.s.ledgers : this.s.items;
    const m = coll[name];
    if (!m) throw new Error(`${tag === 'LEDGER' ? 'Ledger' : 'Stock Item'} '${name}' does not exist!`);
    const code = this._udf(n, 'QECODE');
    if (code) m.qeCode = code;
    m.alterId = this._alter();
    r.altered++; r.lastMid = m.masterId;
  }

  _importVoucher(n, r) {
    const action = (n.attrs.ACTION || 'Create').toLowerCase();
    const vchType = n.attrs.VCHTYPE || childText(n, 'VOUCHERTYPENAME');
    const party = childText(n, 'PARTYLEDGERNAME');
    const ledgerNames = deepAll(n, 'LEDGERNAME').map(text);
    for (const ln of [party, ...ledgerNames]) if (ln && !this.s.ledgers[ln]) throw new Error(`Ledger '${ln}' does not exist!`);
    const lines = findAll(n, 'ALLINVENTORYENTRIES.LIST').map((e) => {
      const item = childText(e, 'STOCKITEMNAME');
      if (!this.s.items[item]) throw new Error(`Stock Item '${item}' does not exist!`);
      return { item, qty: childText(e, 'BILLEDQTY'), rate: childText(e, 'RATE'), amount: Number(childText(e, 'AMOUNT')) };
    });
    // Balance check, as Tally refuses unbalanced vouchers.
    let sum = 0;
    for (const le of findAll(n, 'LEDGERENTRIES.LIST')) sum += Number(childText(le, 'AMOUNT')) || 0;
    for (const e of findAll(n, 'ALLINVENTORYENTRIES.LIST')) sum += Number(childText(e, 'AMOUNT')) || 0;
    if (Math.abs(sum) > 0.005) throw new Error(`Voucher totals do not match! Dr/Cr difference ${sum.toFixed(2)}`);
    const partyEntry = findAll(n, 'LEDGERENTRIES.LIST').find((le) => childText(le, 'LEDGERNAME') === party);
    const data = {
      vchType, date: childText(n, 'DATE'), number: childText(n, 'VOUCHERNUMBER'), party,
      narration: childText(n, 'NARRATION'), amount: Math.abs(Number(childText(partyEntry, 'AMOUNT')) || 0), lines,
      qeTxnId: this._udf(n, 'QETXNID'), remoteId: n.attrs.REMOTEID || '',
    };
    if (action === 'alter') {
      const tagName = (n.attrs.TAGNAME || '').toUpperCase();
      const v = tagName === 'MASTERID' ? this.s.vouchers.find((x) => x.masterId === Number(n.attrs.TAGVALUE)) : null;
      if (!v) throw new Error('Voucher to alter not found');
      Object.assign(v, data, { alterId: this._alter() });
      r.altered++; r.lastVchId = v.masterId;
    } else {
      const v = { guid: uuid(), masterId: this._mid(), alterId: this._alter(), ...data };
      this.s.vouchers.push(v);
      r.created++; r.lastVchId = v.masterId;
    }
  }
}
