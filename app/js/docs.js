// Invoice / receipt documents: on-screen preview, print, PDF and sharing. All work offline.

import { TYPES } from '../core/types.js';
import { calcDoc } from '../core/vat.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n, cur = 'AED', d = 2) => `${cur} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const num = (n, d = 2) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const fdate = (s) => (s ? new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

/** Everything a document needs, resolved from local data. */
export function docModel(txn, ctx) {
  const t = TYPES[txn.type];
  const st = ctx.settings;
  const tax = st.tax;
  const van = (st.vanStock?.vans || []).find((v) => v.id === txn.van);
  const party = t.kind === 'transfer' ? { name: van?.name || txn.van || '' }
    : ctx.ledgerByCode.get(txn.partyCode) || { name: txn.partyName || txn.partyCode };
  const model = { t, txn, co: st.company, tax, party, cur: tax.currency, d: tax.decimals ?? 2 };
  if (t.kind === 'transfer') {
    const office = st.vanStock?.officeGodown || 'Office store';
    [model.from, model.to] = t.dir === 'out' ? [office, party.name] : [party.name, office];
    model.lines = (txn.lines || []).map((l, i) => { const it = ctx.itemByCode.get(l.itemCode) || { name: l.itemCode, unit: '' }; return { n: i + 1, name: it.name, unit: it.unit, code: l.itemCode, qty: l.qty }; });
    model.total = model.lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
  } else if (t.kind === 'items') {
    const c = calcDoc(txn.lines, tax);
    model.calc = c;
    model.lines = c.lines.map((l, i) => {
      const it = ctx.itemByCode.get(l.itemCode) || { name: l.itemName || l.itemCode, unit: '' };
      return { ...l, n: i + 1, name: it.name, unit: it.unit, code: l.itemCode };
    });
    model.total = c.total;
  } else {
    model.total = Number(txn.amount) || 0;
    model.account = ctx.ledgerByCode.get(txn.accountCode)?.name || '';
  }
  return model;
}

export function docHtml(m) {
  const { t, txn, co, tax, party, cur, d } = m;
  const head = `<div class="doc-head"><div>${co.logo ? `<img class="doc-logo" src="${esc(co.logo)}" alt="">` : ''}<div class="doc-co">${esc(co.name)}</div><div class="doc-sub">${esc(co.address)}</div>
    ${co.trn ? `<div class="doc-sub">${esc(tax.taxIdLabel)}: ${esc(co.trn)}</div>` : ''}${co.phone ? `<div class="doc-sub">${esc(co.phone)}</div>` : ''}</div>
    <div class="doc-title">${esc(t.docTitle)}</div></div>`;
  if (t.kind === 'transfer') {
    const rows = m.lines.map((l) => `<tr><td>${l.n}</td><td>${esc(l.name)}<div class="doc-sub">${esc(l.code)}</div></td><td class="r">${esc(l.qty)} ${esc(l.unit)}</td></tr>`).join('');
    return `<div class="doc">${head}<div class="doc-meta"><div><div class="doc-lab">From</div><b>${esc(m.from)}</b><div class="doc-lab" style="margin-top:6px">To</div><b>${esc(m.to)}</b></div>
      <div class="doc-right"><div><span class="doc-lab">No.</span> <b>${esc(txn.number)}</b></div><div><span class="doc-lab">Date</span> ${fdate(txn.date)}</div>
      ${txn.tally?.voucherNo ? `<div class="doc-sub">Tally voucher ${esc(txn.tally.voucherNo)}</div>` : ''}</div></div>
      <table class="doc-tbl"><thead><tr><th>#</th><th>Item</th><th class="r">Qty</th></tr></thead><tbody>${rows}</tbody></table>
      <table class="doc-tot"><tr class="grand"><td>Total quantity</td><td class="r">${esc(m.total)}</td></tr></table>
      ${txn.narration ? `<div class="doc-note">${esc(txn.narration)}</div>` : ''}<div class="doc-sig"><span>Issued by</span><span>Received by</span></div>
      <div class="doc-foot">Stock transfer between stores. Not an invoice.${txn.status !== 'synced' ? ' Not yet posted to Tally.' : ''}</div></div>`;
  }
  const meta = `<div class="doc-meta"><div><div class="doc-lab">${t.party === 'supplier' ? 'Supplier' : 'Customer'}</div><b>${esc(party.name)}</b>
      ${party.address ? `<div>${esc(party.address)}</div>` : ''}${party.trn ? `<div>${esc(tax.taxIdLabel)}: ${esc(party.trn)}</div>` : ''}${party.phone ? `<div>${esc(party.phone)}</div>` : ''}</div>
    <div class="doc-right"><div><span class="doc-lab">No.</span> <b>${esc(txn.number)}</b></div><div><span class="doc-lab">Date</span> ${fdate(txn.date)}</div>
      ${txn.dueDate ? `<div><span class="doc-lab">Delivery</span> ${fdate(txn.dueDate)}</div>` : ''}${txn.supplierInvNo ? `<div><span class="doc-lab">Supplier inv.</span> ${esc(txn.supplierInvNo)}</div>` : ''}
      ${txn.tally?.voucherNo ? `<div class="doc-sub">Tally voucher ${esc(txn.tally.voucherNo)}</div>` : ''}</div></div>`;
  let body;
  if (t.kind === 'items') {
    const rows = m.lines.map((l) => `<tr><td>${l.n}</td><td>${esc(l.name)}<div class="doc-sub">${esc(l.code)}</div></td><td class="r">${num(l.qty, 0)} ${esc(l.unit)}</td><td class="r">${num(l.rate, d)}</td>
      ${l.discPct ? `<td class="r">${num(l.discPct, 1)}%</td>` : '<td class="r">-</td>'}<td class="r">${num(l.taxable, d)}</td><td class="r">${num(l.taxPct, 0)}%</td><td class="r">${num(l.tax, d)}</td><td class="r">${num(l.amount, d)}</td></tr>`).join('');
    const vatRows = m.calc.byRate.map((b) => `<tr><td>${esc(tax.taxLabel)} @ ${num(b.pct, 0)}% on ${num(b.taxable, d)}</td><td class="r">${num(b.tax, d)}</td></tr>`).join('');
    body = `<table class="doc-tbl"><thead><tr><th>#</th><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Disc</th><th class="r">Taxable</th><th class="r">${esc(tax.taxLabel)}%</th><th class="r">${esc(tax.taxLabel)}</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
      <table class="doc-tot"><tr><td>Total before ${esc(tax.taxLabel)}</td><td class="r">${num(m.calc.taxable, d)}</td></tr>${vatRows}
      <tr class="grand"><td>Total (${esc(cur)})</td><td class="r">${num(m.total, d)}</td></tr></table>`;
  } else {
    body = `<table class="doc-tot wide"><tr><td>Amount received</td><td class="r"><b>${money(m.total, cur, d)}</b></td></tr>
      <tr><td>Mode</td><td class="r">${esc(txn.mode || '')}</td></tr>${m.account ? `<tr><td>Deposited to</td><td class="r">${esc(m.account)}</td></tr>` : ''}
      ${txn.reference ? `<tr><td>Reference</td><td class="r">${esc(txn.reference)}</td></tr>` : ''}${txn.against ? `<tr><td>Against invoice</td><td class="r">${esc(txn.against)}</td></tr>` : ''}</table>`;
  }
  const foot = `${txn.narration ? `<div class="doc-note">${esc(txn.narration)}</div>` : ''}${co.footer ? `<div class="doc-note">${esc(co.footer)}</div>` : ''}<div class="doc-foot">This is a computer-generated document.${txn.status !== 'synced' ? ' Not yet posted to accounts.' : ''}</div>`;
  return `<div class="doc">${head}${meta}${body}${foot}</div>`;
}

/** Build a PDF with jsPDF (bundled locally, so it works offline). Returns a Blob. */
export function docPdf(m) {
  const { jsPDF } = window.jspdf;
  const { t, txn, co, tax, party, cur, d } = m;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, L = 14, R = W - 14;
  let y = 16;
  if (co.logo) {
    try {
      const p = pdf.getImageProperties(co.logo);
      const h = 14, w = Math.min(60, (p.width / p.height) * h);
      pdf.addImage(co.logo, 'PNG', L, 8, w, (w / ((p.width / p.height) * h)) * h);
      y = 30;
    } catch { /* unreadable logo: print without it */ }
  }
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14); pdf.text(co.name || '', L, y);
  pdf.setFontSize(15); pdf.text(t.docTitle, R, y, { align: 'right' });
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
  for (const s of [co.address, co.trn && `${tax.taxIdLabel}: ${co.trn}`, co.phone].filter(Boolean)) { y += 4.5; pdf.text(String(s), L, y); }
  y += 4; pdf.setDrawColor(200); pdf.line(L, y, R, y); y += 7;
  const y0 = y;
  if (t.kind === 'transfer') {
    for (const [k, v] of [['FROM', m.from], ['TO', m.to]]) {
      pdf.setFontSize(8); pdf.setTextColor(110); pdf.text(k, L, y); pdf.setTextColor(0);
      pdf.setFontSize(10); pdf.setFont('helvetica', 'bold'); pdf.text(String(v || ''), L + 14, y); pdf.setFont('helvetica', 'normal'); y += 6;
    }
    pdf.setFontSize(9);
    let yr2 = y0;
    for (const [k, v] of [['No.', txn.number], ['Date', fdate(txn.date)]]) { pdf.setTextColor(110); pdf.text(k, R - 55, yr2); pdf.setTextColor(0); pdf.text(String(v), R, yr2, { align: 'right' }); yr2 += 5; }
    y = Math.max(y, yr2) + 6;
    pdf.setFillColor(238, 242, 248); pdf.rect(L - 2, y - 4.5, R - L + 4, 7, 'F');
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5); pdf.text('#', L, y); pdf.text('Item', L + 7, y); pdf.text('Qty', R, y, { align: 'right' });
    pdf.setFont('helvetica', 'normal'); y += 7;
    for (const l of m.lines) {
      if (y > 265) { pdf.addPage(); y = 20; }
      const name = pdf.splitTextToSize(`${l.name} (${l.code})`, 140);
      pdf.text(String(l.n), L, y); pdf.text(name, L + 7, y); pdf.text(`${l.qty} ${l.unit}`, R, y, { align: 'right' });
      y += 4.5 * name.length + 2; pdf.setDrawColor(230); pdf.line(L, y - 3, R, y - 3);
    }
    pdf.setFont('helvetica', 'bold'); pdf.text('Total quantity', 140, y + 3, { align: 'right' }); pdf.text(String(m.total), R, y + 3, { align: 'right' }); pdf.setFont('helvetica', 'normal');
    y += 22; pdf.text('Issued by: ____________________', L, y); pdf.text('Received by: ____________________', R, y, { align: 'right' });
    if (txn.narration) { y += 10; pdf.text(pdf.splitTextToSize(txn.narration, R - L), L, y); }
    pdf.setFontSize(8); pdf.setTextColor(120); pdf.text('Stock transfer between stores. Not an invoice.', L, 287);
    return pdf.output('blob');
  }
  pdf.setFontSize(8); pdf.setTextColor(110); pdf.text(t.party === 'supplier' ? 'SUPPLIER' : 'CUSTOMER', L, y); pdf.setTextColor(0);
  pdf.setFontSize(10); pdf.setFont('helvetica', 'bold'); y += 5; pdf.text(party.name || '', L, y); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
  for (const s of [party.address, party.trn && `${tax.taxIdLabel}: ${party.trn}`, party.phone].filter(Boolean)) { y += 4.5; pdf.text(String(s), L, y); }
  let yr = y0;
  const kv = (k, v) => { pdf.setTextColor(110); pdf.text(k, R - 55, yr); pdf.setTextColor(0); pdf.text(String(v), R, yr, { align: 'right' }); yr += 5; };
  kv('No.', txn.number); kv('Date', fdate(txn.date));
  if (txn.dueDate) kv('Delivery', fdate(txn.dueDate));
  if (txn.supplierInvNo) kv('Supplier inv.', txn.supplierInvNo);
  y = Math.max(y, yr) + 8;
  if (t.kind === 'items') {
    const cols = [[L, '#', 'l'], [L + 7, 'Item', 'l'], [112, 'Qty', 'r'], [130, 'Rate', 'r'], [146, 'Disc', 'r'], [163, 'Taxable', 'r'], [176, tax.taxLabel, 'r'], [R, 'Amount', 'r']];
    pdf.setFillColor(238, 242, 248); pdf.rect(L - 2, y - 4.5, R - L + 4, 7, 'F');
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5);
    for (const [x, h, a] of cols) pdf.text(h, x, y, { align: a === 'r' ? 'right' : 'left' });
    pdf.setFont('helvetica', 'normal'); y += 7;
    for (const l of m.lines) {
      if (y > 265) { pdf.addPage(); y = 20; }
      const name = pdf.splitTextToSize(l.name, 72);
      const vals = [String(l.n), name, `${num(l.qty, 0)} ${l.unit}`, num(l.rate, d), l.discPct ? num(l.discPct, 1) + '%' : '-', num(l.taxable, d), `${num(l.tax, d)} (${num(l.taxPct, 0)}%)`, num(l.amount, d)];
      cols.forEach(([x, , a], i) => pdf.text(vals[i], x, y, { align: a === 'r' ? 'right' : 'left' }));
      y += 4.5 * name.length + 2;
      pdf.setDrawColor(230); pdf.line(L, y - 3, R, y - 3);
    }
    y += 3;
    const tot = (k, v, bold) => { pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.text(k, 140, y, { align: 'right' }); pdf.text(v, R, y, { align: 'right' }); y += 5.5; };
    tot(`Total before ${tax.taxLabel}`, num(m.calc.taxable, d));
    for (const b of m.calc.byRate) tot(`${tax.taxLabel} @ ${num(b.pct, 0)}%`, num(b.tax, d));
    pdf.setFontSize(11); tot(`Total (${cur})`, num(m.total, d), true); pdf.setFontSize(9);
  } else {
    const row = (k, v) => { pdf.setTextColor(110); pdf.text(k, L, y); pdf.setTextColor(0); pdf.text(String(v), L + 45, y); y += 6; };
    pdf.setFontSize(11); pdf.setFont('helvetica', 'bold'); row('Amount received', money(m.total, cur, d)); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9.5);
    row('Mode', txn.mode || ''); if (m.account) row('Deposited to', m.account);
    if (txn.reference) row('Reference', txn.reference); if (txn.against) row('Against invoice', txn.against);
  }
  if (txn.narration) { y += 4; pdf.setFontSize(9); pdf.text(pdf.splitTextToSize(txn.narration, R - L), L, y); }
  pdf.setFontSize(8); pdf.setTextColor(120);
  if (co.footer) pdf.text(pdf.splitTextToSize(co.footer, R - L), L, 281);
  pdf.text('This is a computer-generated document.', L, 287);
  return pdf.output('blob');
}

export function shareText(m) {
  if (m.t.kind === 'transfer') return `${m.t.docTitle} ${m.txn.number}\n${m.co.name}\nFrom: ${m.from}\nTo: ${m.to}\nDate: ${fdate(m.txn.date)}\nTotal quantity: ${m.total}`;
  return `${m.t.docTitle} ${m.txn.number}\n${m.co.name}\nTo: ${m.party.name}\nDate: ${fdate(m.txn.date)}\nTotal: ${money(m.total, m.cur, m.d)}`;
}

export function fileName(m) { return `${m.txn.number}.pdf`.replace(/[^\w.-]+/g, '_'); }

/** Share via the phone's share sheet (WhatsApp appears there). Falls back to download + wa.me. */
export async function sharePdf(m) {
  const blob = docPdf(m);
  const file = new File([blob], fileName(m), { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: `${m.t.docTitle} ${m.txn.number}`, text: shareText(m) });
    return 'shared';
  }
  downloadBlob(blob, fileName(m));
  const phone = String(m.party.phone || '').replace(/\D/g, '');
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(shareText(m) + '\n(PDF attached separately)')}`;
  window.open(url, '_blank', 'noopener');
  return 'fallback';
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function printDoc(m) {
  const area = document.getElementById('print-area');
  area.innerHTML = docHtml(m);
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 1500);
}
