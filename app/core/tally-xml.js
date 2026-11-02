// TallyPrime XML request builders and response parsers.
//
// STATUS: written against TallyPrime's documented XML-over-HTTP interface (port 9000)
// and tested against the bundled simulator only. NOT yet verified on a live TallyPrime.
// Points to verify on the client's Tally are marked "VERIFY".

import { esc, parseXml, deep, deepAll, find, findAll, childText, text, bare } from './xml.js';
import { calcDoc, roundTo } from './vat.js';
import { TYPES, ledgerRole } from './types.js';

const env = (header, body) => `<ENVELOPE><HEADER>${header}</HEADER><BODY>${body}</BODY></ENVELOPE>`;
const sv = (company) => `<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${company ? `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` : ''}</STATICVARIABLES>`;

/** Export a TDL collection inline (no add-on needed for read-only exports). */
export function collectionRequest(company, id, type, fetch, filterFormula) {
  const filter = filterFormula ? `<FILTER>QEFilter</FILTER>` : '';
  const formula = filterFormula ? `<SYSTEM TYPE="Formulae" NAME="QEFilter">${esc(filterFormula)}</SYSTEM>` : '';
  return env(
    `<VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${esc(id)}</ID>`,
    `<DESC>${sv(company)}<TDL><TDLMESSAGE><COLLECTION NAME="${esc(id)}" ISMODIFY="No"><TYPE>${esc(type)}</TYPE><FETCH>${fetch.join(', ')}</FETCH>${filter}</COLLECTION>${formula}</TDLMESSAGE></TDL></DESC>`,
  );
}

const LEDGER_FETCH = ['GUID', 'MASTERID', 'ALTERID', 'NAME', 'PARENT', 'LEDGERPHONE', 'LEDGERMOBILE', 'EMAIL', 'VATTINNUMBER', 'ADDRESS', 'QECODE'];
const ITEM_FETCH = ['GUID', 'MASTERID', 'ALTERID', 'NAME', 'PARENT', 'BASEUNITS', 'PARTNO', 'STANDARDPRICE', 'STANDARDCOST', 'VATCLASS', 'CLOSINGBALANCE', 'QECODE'];

export const ledgersRequest = (company, sinceAlterId = 0) =>
  collectionRequest(company, 'QELedgers', 'Ledger', LEDGER_FETCH, sinceAlterId ? `$AlterID > ${Number(sinceAlterId)}` : null);
export const itemsRequest = (company, sinceAlterId = 0) =>
  collectionRequest(company, 'QEItems', 'StockItem', ITEM_FETCH, sinceAlterId ? `$AlterID > ${Number(sinceAlterId)}` : null);
/** Full list of keys only, used daily to detect masters deleted in Tally. */
export const keysRequest = (company, type) =>
  collectionRequest(company, 'QEKeys' + type, type, ['GUID', 'NAME', 'QECODE'], null);
export const voucherByTxnIdRequest = (company, txnId) =>
  collectionRequest(company, 'QEVchByTxn', 'Voucher', ['GUID', 'MASTERID', 'ALTERID', 'VOUCHERNUMBER', 'VOUCHERTYPENAME', 'DATE', 'QETXNID'], `$QETxnID = "${String(txnId).replace(/"/g, '')}"`);
export const voucherByMasterIdRequest = (company, masterId) =>
  collectionRequest(company, 'QEVchById', 'Voucher', ['GUID', 'MASTERID', 'ALTERID', 'VOUCHERNUMBER', 'VOUCHERTYPENAME', 'DATE', 'QETXNID'], `$MasterID = ${Number(masterId)}`);

function plain(node) {
  const o = { NAME: node.attrs.NAME || '' };
  for (const c of node.children) {
    const k = bare(c.name).replace(/\.LIST$/, '');
    if (c.children.length) {
      // e.g. ADDRESS.LIST/ADDRESS, UDF:QECODE.LIST/UDF:QECODE
      const vals = c.children.map((x) => text(x)).filter(Boolean);
      o[k] = vals.length > 1 ? vals : vals[0] ?? '';
    } else o[k] = text(c);
  }
  if (!o.NAME && o.NAME !== undefined) o.NAME = childText(node, 'NAME');
  return o;
}

/** Parse an exported collection into plain objects keyed by Tally tag names. */
export function parseCollection(xml, tag) {
  const root = parseXml(xml);
  const err = tallyError(root);
  if (err) throw new Error(err);
  return deepAll(root, tag).map(plain);
}

function tallyError(root) {
  const line = deep(root, 'LINEERROR');
  if (line && !deep(root, 'COLLECTION') && !deep(root, 'CREATED')) return text(line);
  return null;
}

const num = (s) => {
  const m = String(s ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
};

export function ledgerFromTally(o) {
  const addr = Array.isArray(o.ADDRESS) ? o.ADDRESS.join(', ') : o.ADDRESS || '';
  return {
    code: o.QECODE || '', tallyGuid: o.GUID, tallyMasterId: num(o.MASTERID), tallyAlterId: num(o.ALTERID),
    name: o.NAME, parent: o.PARENT, role: ledgerRole(o.PARENT),
    phone: o.LEDGERMOBILE || o.LEDGERPHONE || '', email: o.EMAIL || '', trn: o.VATTINNUMBER || '', address: addr,
  };
}

export function itemFromTally(o) {
  return {
    code: o.QECODE || '', tallyGuid: o.GUID, tallyMasterId: num(o.MASTERID), tallyAlterId: num(o.ALTERID),
    name: o.NAME, group: o.PARENT || '', unit: o.BASEUNITS || 'Nos', partNo: o.PARTNO || '',
    rate: num(o.STANDARDPRICE), cost: num(o.STANDARDCOST), taxCode: o.VATCLASS || '', stock: num(o.CLOSINGBALANCE),
  };
}

const importEnv = (company, report, body) => env(
  `<TALLYREQUEST>Import Data</TALLYREQUEST>`,
  `<IMPORTDATA><REQUESTDESC><REPORTNAME>${report}</REPORTNAME><STATICVARIABLES>${company ? `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` : ''}</STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${body}</TALLYMESSAGE></REQUESTDATA></IMPORTDATA>`,
);

// VERIFY: UDF tag layout. This is the layout Tally uses when it exports UDFs; the TDL in
// /tdl defines QECode (masters) and QETxnID (vouchers) as String UDFs.
const udf = (name, value) =>
  `<UDF:${name}.LIST DESC="\`${name}\`" ISLIST="YES" TYPE="String"><UDF:${name} DESC="\`${name}\`">${esc(value)}</UDF:${name}></UDF:${name}.LIST>`;

/** Write a generated stable code back onto a Tally master (needs the QuickEntry TDL). */
export function setMasterCodeRequest(company, kind /* 'LEDGER' | 'STOCKITEM' */, name, code) {
  return importEnv(company, 'All Masters', `<${kind} NAME="${esc(name)}" ACTION="Alter"><NAME>${esc(name)}</NAME>${udf('QECODE', code)}</${kind}>`);
}

const tdate = (iso) => String(iso).replace(/-/g, '');
const amt = (x) => roundTo(x, 2).toFixed(2);
const qtyStr = (q, unit) => ` ${Number(q)} ${unit || ''}`.trimEnd();

/**
 * Build the voucher import XML for an app transaction.
 * names: { party, items: {code: {name, unit}}, ledgers: {code: name} } current Tally names, resolved by code.
 * map:   ledger mapping from settings (salesLedger, purchaseLedger, outputTaxLedger, inputTaxLedger, roundOffLedger)
 * action: 'Create' | 'Alter'; masterId required for Alter.
 */
export function voucherRequest(company, txn, names, map, tax, action = 'Create', masterId = null) {
  const t = TYPES[txn.type];
  if (!t) throw new Error('Unknown transaction type ' + txn.type);
  const head = action === 'Alter'
    // VERIFY: altering by MASTERID via TAGNAME/TAGVALUE on the client's Tally release.
    ? `<VOUCHER TAGNAME="MASTERID" TAGVALUE="${Number(masterId)}" VCHTYPE="${esc(t.vchType)}" ACTION="Alter" REMOTEID="${esc(txn.id)}"${t.kind === 'items' ? ' OBJVIEW="Invoice Voucher View"' : ''}>`
    : `<VOUCHER VCHTYPE="${esc(t.vchType)}" ACTION="Create" REMOTEID="${esc(txn.id)}"${t.kind === 'items' ? ' OBJVIEW="Invoice Voucher View"' : ''}>`;
  let body = `<DATE>${tdate(txn.date)}</DATE><VOUCHERTYPENAME>${esc(t.vchType)}</VOUCHERTYPENAME>`
    + `<VOUCHERNUMBER>${esc(txn.number)}</VOUCHERNUMBER><REFERENCE>${esc(txn.supplierInvNo || txn.number)}</REFERENCE>`
    + `<PARTYLEDGERNAME>${esc(names.party)}</PARTYLEDGERNAME>`
    + `<NARRATION>${esc(txn.narration || '')}</NARRATION>` + udf('QETXNID', txn.id);

  if (t.kind === 'items') {
    const doc = calcDoc(txn.lines, tax);
    const sales = t.party === 'customer';
    const accLedger = sales ? map.salesLedger : map.purchaseLedger;
    const taxLedger = sales ? map.outputTaxLedger : map.inputTaxLedger;
    // Sign convention: debit = ISDEEMEDPOSITIVE Yes with negative AMOUNT.
    const partySign = sales ? -1 : 1, lineSign = sales ? 1 : -1;
    body += `<PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><ISINVOICE>Yes</ISINVOICE>`;
    if (txn.type === 'so' && txn.dueDate) body += `<ORDERDUEDATE>${tdate(txn.dueDate)}</ORDERDUEDATE>`;
    body += `<LEDGERENTRIES.LIST><LEDGERNAME>${esc(names.party)}</LEDGERNAME><ISDEEMEDPOSITIVE>${sales ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>${amt(partySign * doc.total)}</AMOUNT>`
      + (txn.type !== 'so' ? `<BILLALLOCATIONS.LIST><NAME>${esc(txn.supplierInvNo || txn.number)}</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>${amt(partySign * doc.total)}</AMOUNT></BILLALLOCATIONS.LIST>` : '')
      + `</LEDGERENTRIES.LIST>`;
    if (doc.tax) body += `<LEDGERENTRIES.LIST><LEDGERNAME>${esc(taxLedger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${sales ? 'No' : 'Yes'}</ISDEEMEDPOSITIVE><AMOUNT>${amt(lineSign * doc.tax)}</AMOUNT></LEDGERENTRIES.LIST>`;
    for (const l of doc.lines) {
      const it = names.items[l.itemCode];
      if (!it) throw new Error(`Item ${l.itemCode} is not in the synced masters`);
      body += `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${esc(it.name)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>${sales ? 'No' : 'Yes'}</ISDEEMEDPOSITIVE>`
        + `<RATE>${amt(l.rate)}/${esc(it.unit)}</RATE>${l.discPct ? `<DISCOUNT>${Number(l.discPct)}</DISCOUNT>` : ''}<AMOUNT>${amt(lineSign * l.taxable)}</AMOUNT>`
        + `<ACTUALQTY>${esc(qtyStr(l.qty, it.unit))}</ACTUALQTY><BILLEDQTY>${esc(qtyStr(l.qty, it.unit))}</BILLEDQTY>`
        + `<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${esc(accLedger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${sales ? 'No' : 'Yes'}</ISDEEMEDPOSITIVE><AMOUNT>${amt(lineSign * l.taxable)}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>`
        + `</ALLINVENTORYENTRIES.LIST>`;
    }
  } else {
    // Receipt: party credited, bank/cash debited.
    const a = Number(txn.amount) || 0;
    const acct = names.account || map.cashLedger;
    const bill = txn.against
      ? `<BILLALLOCATIONS.LIST><NAME>${esc(txn.against)}</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>${amt(a)}</AMOUNT></BILLALLOCATIONS.LIST>`
      : `<BILLALLOCATIONS.LIST><NAME>${esc(txn.number)}</NAME><BILLTYPE>On Account</BILLTYPE><AMOUNT>${amt(a)}</AMOUNT></BILLALLOCATIONS.LIST>`;
    body += `<LEDGERENTRIES.LIST><LEDGERNAME>${esc(names.party)}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>${amt(a)}</AMOUNT>${bill}</LEDGERENTRIES.LIST>`
      + `<LEDGERENTRIES.LIST><LEDGERNAME>${esc(acct)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>${amt(-a)}</AMOUNT>`
      + (txn.reference ? `<BANKALLOCATIONS.LIST><INSTRUMENTNUMBER>${esc(txn.reference)}</INSTRUMENTNUMBER><TRANSACTIONTYPE>${esc(txn.mode || '')}</TRANSACTIONTYPE><AMOUNT>${amt(-a)}</AMOUNT></BANKALLOCATIONS.LIST>` : '')
      + `</LEDGERENTRIES.LIST>`;
  }
  return importEnv(company, 'Vouchers', head + body + '</VOUCHER>');
}

/**
 * Cancel a voucher that is already in Tally. Tally keeps the voucher number with zero amounts and
 * marks it "Cancelled", which keeps the numbering complete for VAT. The reason goes in the narration.
 */
export function cancelVoucherRequest(company, txn, masterId, reason = '') {
  const t = TYPES[txn.type];
  if (!t) throw new Error('Unknown transaction type ' + txn.type);
  // VERIFY: cancelling by MASTERID via TAGNAME/TAGVALUE on the client's Tally release (same form as Alter).
  return importEnv(company, 'Vouchers', `<VOUCHER DATE="${tdate(txn.date)}" TAGNAME="MASTERID" TAGVALUE="${Number(masterId)}" VCHTYPE="${esc(t.vchType)}" ACTION="Cancel">`
    + `<NARRATION>${esc(('Cancelled in QuickEntry' + (reason ? ': ' + reason : '')).slice(0, 250))}</NARRATION></VOUCHER>`);
}

/** Parse Tally's import response: <RESPONSE><CREATED>..<LASTVCHID>..<LINEERROR>.. */
export function parseImportResponse(xml) {
  const root = parseXml(xml);
  const r = deep(root, 'RESPONSE') || root;
  const n = (k) => num(childText(r, k) || text(deep(root, k)));
  const errors = deepAll(root, 'LINEERROR').map(text).filter(Boolean);
  return {
    created: n('CREATED'), altered: n('ALTERED'), errors: n('ERRORS') || (errors.length ? errors.length : 0),
    cancelled: n('CANCELLED'), exceptions: n('EXCEPTIONS'), lastVchId: n('LASTVCHID'), lastMid: n('LASTMID'), messages: errors,
  };
}

export { find, findAll };
