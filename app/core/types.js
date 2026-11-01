// Transaction type definitions. Adding a type (e.g. Credit Note) means adding an
// entry here plus a mapping in tally-xml.js; the UI, storage and sync engine are generic.

export const TYPES = {
  si: {
    code: 'si', name: 'Sales Invoice', short: 'Invoice', prefix: 'SI', kind: 'items',
    party: 'customer', vchType: 'Sales', docTitle: 'TAX INVOICE', icon: 'SI',
    fields: ['date', 'party', 'lines', 'narration'],
  },
  rc: {
    code: 'rc', name: 'Receipt', short: 'Receipt', prefix: 'RV', kind: 'payment',
    party: 'customer', vchType: 'Receipt', docTitle: 'RECEIPT VOUCHER', icon: 'RV',
    fields: ['date', 'party', 'amount', 'mode', 'reference', 'against', 'narration'],
  },
  so: {
    code: 'so', name: 'Sales Order', short: 'Order', prefix: 'SO', kind: 'items',
    party: 'customer', vchType: 'Sales Order', docTitle: 'SALES ORDER', icon: 'SO',
    fields: ['date', 'party', 'dueDate', 'lines', 'narration'],
  },
  pi: {
    code: 'pi', name: 'Purchase', short: 'Purchase', prefix: 'PI', kind: 'items',
    party: 'supplier', vchType: 'Purchase', docTitle: 'PURCHASE INVOICE', icon: 'PI',
    fields: ['date', 'party', 'supplierInvNo', 'lines', 'narration'],
    note: 'Purchase workflow awaiting client confirmation (BRD Q4). Built as a Purchase voucher from a supplier invoice.',
  },
};

export const TYPE_ORDER = ['si', 'rc', 'so', 'pi'];

/** Ledger groups that count as customers / suppliers / payment accounts. */
export const GROUPS = {
  customer: ['Sundry Debtors'],
  supplier: ['Sundry Creditors'],
  account: ['Bank Accounts', 'Cash-in-Hand', 'Bank OD A/c'],
};

export function ledgerRole(parent) {
  for (const [role, groups] of Object.entries(GROUPS)) if (groups.includes(parent)) return role;
  return 'other';
}

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
