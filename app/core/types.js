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
  // Van stock: moving goods between the office store and a salesperson's van (Tally godowns).
  vi: {
    code: 'vi', name: 'Issue to Van', short: 'Issue to van', prefix: 'VI', kind: 'transfer',
    vchType: 'Stock Journal', docTitle: 'STOCK ISSUE TO VAN', icon: 'VI', dir: 'out',
    fields: ['date', 'van', 'lines', 'narration'],
  },
  vr: {
    code: 'vr', name: 'Return from Van', short: 'Van return', prefix: 'VR', kind: 'transfer',
    vchType: 'Stock Journal', docTitle: 'STOCK RETURN FROM VAN', icon: 'VR', dir: 'in',
    fields: ['date', 'van', 'lines', 'narration'],
  },
};

export const TYPE_ORDER = ['si', 'rc', 'so', 'pi'];
export const VAN_TYPES = ['vi', 'vr'];

/** Van stock settings with defaults. vans: [{ id, name, godown, user }] where user is a user code. */
export function vanConfig(settings) {
  const v = settings?.vanStock || {};
  return { enabled: !!v.enabled, officeGodown: v.officeGodown || 'Main Location', vans: Array.isArray(v.vans) ? v.vans : [] };
}

/** The van a user sells from, or null (office stock). */
export function vanForUser(settings, userCode) {
  const c = vanConfig(settings);
  return c.enabled && userCode ? c.vans.find((v) => v.user === userCode) || null : null;
}

/**
 * How a transaction changes van stock: [{ van, itemCode, qty }] with qty signed (+ into the van).
 * Issue adds to the van, return and van sales take from it. Cancelled entries change nothing.
 */
export function vanMoves(txn) {
  if (!txn || txn.cancelled || !txn.van) return [];
  const sign = txn.type === 'vi' ? 1 : txn.type === 'vr' || txn.type === 'si' ? -1 : 0;
  if (!sign) return [];
  return (txn.lines || []).filter((l) => l.itemCode && Number(l.qty)).map((l) => ({ van: String(txn.van), itemCode: l.itemCode, qty: sign * Number(l.qty) }));
}

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
