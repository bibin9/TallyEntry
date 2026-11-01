// Tax calculation driven entirely by settings: no jurisdiction rules in code.

export const DEFAULT_TAX = {
  taxLabel: 'VAT',          // label printed on documents
  taxIdLabel: 'TRN',        // label for the tax registration number
  currency: 'AED',
  decimals: 2,
  pricesIncludeTax: false,  // true = rates entered tax-inclusive
  rounding: 'line',         // 'line' = round tax per line, 'total' = round once per document
  defaultRateCode: 'SR',
  rates: [
    { code: 'SR', label: 'Standard 5%', rate: 5 },
    { code: 'ZR', label: 'Zero-rated 0%', rate: 0 },
    { code: 'EX', label: 'Exempt', rate: 0 },
  ],
};

export function roundTo(x, d = 2) {
  const f = 10 ** d;
  return Math.sign(x) * Math.round(Math.abs(x) * f + 1e-9) / f;
}

export function rateFor(code, tax) {
  const r = tax.rates.find((x) => x.code === code) || tax.rates.find((x) => x.code === tax.defaultRateCode);
  return r ? Number(r.rate) : 0;
}

/**
 * Compute line and document totals.
 * line: {qty, rate, discPct, taxCode}
 */
export function calcDoc(lines, tax = DEFAULT_TAX) {
  const d = tax.decimals ?? 2;
  const out = [];
  let taxable = 0, taxTotal = 0, rawTax = 0;
  const byRate = {};
  for (const l of lines || []) {
    const qty = Number(l.qty) || 0, rate = Number(l.rate) || 0, disc = Number(l.discPct) || 0;
    const pct = rateFor(l.taxCode, tax);
    const gross = qty * rate;
    const net = gross - gross * disc / 100;
    let base, t;
    if (tax.pricesIncludeTax) { base = net / (1 + pct / 100); t = net - base; }
    else { base = net; t = net * pct / 100; }
    base = roundTo(base, d);
    const lineTax = tax.rounding === 'line' ? roundTo(t, d) : t;
    out.push({ ...l, gross: roundTo(gross, d), taxable: base, taxPct: pct, tax: roundTo(lineTax, d), amount: roundTo(base + lineTax, d) });
    taxable += base; rawTax += t; taxTotal += lineTax;
    const k = String(pct);
    byRate[k] = byRate[k] || { pct, taxable: 0, tax: 0 };
    byRate[k].taxable += base; byRate[k].tax += lineTax;
  }
  if (tax.rounding !== 'line') taxTotal = roundTo(rawTax, d);
  taxable = roundTo(taxable, d); taxTotal = roundTo(taxTotal, d);
  for (const k in byRate) { byRate[k].taxable = roundTo(byRate[k].taxable, d); byRate[k].tax = roundTo(byRate[k].tax, d); }
  return { lines: out, taxable, tax: taxTotal, total: roundTo(taxable + taxTotal, d), byRate: Object.values(byRate) };
}

export function txnTotal(txn, tax) {
  if (txn.kind === 'payment' || txn.type === 'rc') return Number(txn.amount) || 0;
  return calcDoc(txn.lines, tax).total;
}
