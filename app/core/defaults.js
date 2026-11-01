import { DEFAULT_TAX } from './vat.js';
import { DEFAULT_LEDGER_MAP } from './connector-core.js';

export function defaultSettings(companyName = 'Your Company LLC') {
  return {
    company: { name: companyName, address: 'Office address, City, UAE', trn: '', phone: '', email: '' },
    tax: structuredClone(DEFAULT_TAX),
    ledgerMap: { ...DEFAULT_LEDGER_MAP },
    retentionDays: 2,                // synced transactions kept on devices (unsynced are always kept)
    conflictPolicy: 'tally-wins',    // BRD Q6: to be confirmed by the client
    allowRateEdit: true,             // BRD Q5
    receiptModes: ['Cash', 'Cheque', 'PDC', 'Bank transfer', 'Card'],
  };
}
