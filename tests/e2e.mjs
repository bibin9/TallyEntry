// Browser acceptance test of the PWA in DEMO mode (simulated Tally inside the browser).
// Covers acceptance criteria 1-10 from the BRD. Usage:
//   node relay/dev-server.js --port 8787 &   then   node tests/e2e.mjs [http://localhost:8787] [shots-dir]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://localhost:8787';
const SHOTS = process.argv[3] || 'test-results';
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (ac, name, ok, detail = '') => { results.push({ ac, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  AC${ac}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, acceptDownloads: true });
let page = await ctx.newPage();
const errors = [];
const watch = (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text()) && errors.push(m.text())); };
watch(page);
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
const waitText = (sel, re, t = 15000) => page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent || ''), [sel, re.source], { timeout: t });

await page.goto(BASE + '/#home');
await page.evaluate(() => navigator.serviceWorker.ready);
await page.waitForFunction(() => !document.body.textContent.includes('No customers or items'), null, { timeout: 15000 });
await page.reload(); // now controlled by the service worker
await page.waitForSelector('.tiles');
await shot('01-home-online');

// ---------------- AC1: invoice and receipt with no internet
await ctx.setOffline(true);
await page.waitForTimeout(300);
async function pick(q, idx = 0) {
  await page.fill('#pq', q);
  await page.waitForTimeout(150);
  await page.locator('#pres [data-pick]').nth(idx).click();
}
await page.click('[data-go="new/si"]');
await page.click('[data-act="pickparty"]');
await pick('gulf star');
await page.click('[data-act="additem"]');
await pick('led panel');
await page.fill('[data-l="qty"][data-i="0"]', '10');
await page.click('[data-act="additem"]');
await pick('fan');
await page.fill('[data-l="qty"][data-i="1"]', '2');
await page.fill('[data-l="discPct"][data-i="1"]', '5');
await shot('02-invoice-form-offline');
const totalTxt = await page.textContent('#t-total');
await page.click('[data-act="save"]');
await page.waitForSelector('.status');
const invUrl = page.url();
const invBadge = await page.textContent('.status .badge');
await shot('03-invoice-saved-offline');
check(1, 'Invoice saved offline', /Pending/.test(invBadge), `total ${totalTxt}, status ${invBadge}`);

await page.goto(BASE + '/#new/rc');
await page.click('[data-act="pickparty"]');
await pick('al madina');
await page.fill('[data-f="amount"]', '1500');
await page.selectOption('[data-f="mode"]', 'Cheque');
await page.fill('[data-f="reference"]', 'CHQ 004512');
await page.click('[data-act="save"]');
await page.waitForSelector('.status');
const rcUrl = page.url();
check(1, 'Receipt saved offline', /Pending/.test(await page.textContent('.status .badge')));

// ---------------- AC2: still there after restarting the app (offline)
await page.close();
page = await ctx.newPage(); watch(page);
await page.goto(BASE + '/#list');
await page.waitForSelector('.list .row', { timeout: 15000 });
const rowsAfterRestart = await page.locator('.list .row').count();
const pendingAfter = await page.locator('.badge.b-pending').count();
await shot('04-after-restart-offline');
check(2, 'Records survive an app restart while offline', rowsAfterRestart === 2 && pendingAfter === 2, `${rowsAfterRestart} rows, ${pendingAfter} pending`);

// ---------------- AC3: syncs when connectivity returns
await ctx.setOffline(false);
await page.goto(BASE + '/#list');
await page.waitForFunction(() => document.querySelectorAll('.badge.b-synced').length === 2, null, { timeout: 30000 });
await shot('05-synced');
check(3, 'Pending transactions sync automatically when back online', true);

const dayBook = async () => {
  await page.goto(BASE + '/#daybook');
  await page.waitForSelector('.tbl');
  return page.$$eval('.tbl tr', (rows) => rows.slice(1).map((r) => [...r.children].map((c) => c.textContent)));
};
let db1 = await dayBook();

// ---------------- AC4: no duplicates on repeated sync
await page.goto(BASE + '/#home');
for (let i = 0; i < 4; i++) { await page.click('[data-act="syncnow"]'); await page.waitForTimeout(700); }
let db2 = await dayBook();
await shot('06-daybook');
check(4, 'Repeated syncs create no duplicate vouchers', db1.length === 2 && db2.length === 2, `Tally vouchers: ${db1.length} then ${db2.length}`);

// ---------------- AC5: edit synced invoice updates the same voucher
const invId = invUrl.split('/').pop();
await page.goto(BASE + '/#detail/' + invId);
await page.waitForSelector('.status');
await page.click('[data-act="edit"]');
await page.waitForSelector('[data-l="qty"]');
await page.fill('[data-l="qty"][data-i="0"]', '20');
await page.click('[data-act="save"]');
await page.waitForFunction(() => /Synced/.test(document.querySelector('.status .badge')?.textContent || ''), null, { timeout: 30000 });
const verTxt = await page.textContent('.status .small');
let db3 = await dayBook();
const before = db2.find((r) => r[1] === 'Sales'), after = db3.find((r) => r[1] === 'Sales');
check(5, 'Editing a synced invoice updates the same Tally voucher', db3.length === 2 && before[0] === after[0] && Number(after[4]) > Number(before[4]), `voucher ID ${before[0]} -> ${after[0]}, amount ${before[4]} -> ${after[4]}; ${verTxt.trim()}`);

// ---------------- AC6 + AC7: rename in Tally, only changes transferred
await page.goto(BASE + '/#more');
await page.waitForSelector('#d-old');
await page.selectOption('#d-old', 'Gulf Star Electronics');
await page.fill('#d-new', 'Gulf Star Electronics LLC');
await page.click('[data-act="demo-rename"]');
await page.waitForTimeout(1500);
await page.goto(BASE + '/#parties');
await page.fill('#partyq', 'gulf star');
await page.waitForTimeout(400);
const partyNames = await page.$$eval('.list .row .p', (els) => els.map((e) => e.textContent));
await page.goto(BASE + '/#detail/' + invId);
await page.waitForSelector('.doc');
const docHasNew = (await page.textContent('.doc')).includes('Gulf Star Electronics LLC');
check(6, 'Renaming a customer in Tally updates the same app record', partyNames.length === 1 && partyNames[0] === 'Gulf Star Electronics LLC' && docHasNew, `customer list: ${partyNames.join(', ')}`);
await page.goto(BASE + '/#log');
await page.waitForSelector('.tbl');
const logRows = await page.$$eval('.tbl tr', (rows) => rows.slice(1).map((r) => r.textContent));
const masterRows = logRows.filter((r) => r.includes('masters'));
await shot('07-sync-log');
check(7, 'Later master syncs send only changes', masterRows.length >= 2 && /ledgers \+0\/~1, items \+0\/~0/.test(masterRows[0]), `latest: ${masterRows[0]?.replace(/\s+/g, ' ').trim()}; first: ${masterRows[masterRows.length - 1]?.replace(/\s+/g, ' ').trim()}`);

// ---------------- AC8: recent transactions viewable and editable on device (offline)
await ctx.setOffline(true);
await page.goto(BASE + '/#list');
await page.waitForSelector('.list .row');
const rcId = rcUrl.split('/').pop();
await page.goto(BASE + '/#edit/' + rcId);
await page.waitForSelector('[data-f="amount"]');
await page.fill('[data-f="amount"]', '1750');
await page.click('[data-act="save"]');
await page.waitForSelector('.status');
const rcBadge = await page.textContent('.status .badge');
await ctx.setOffline(false);
await page.waitForFunction(() => /Synced/.test(document.querySelector('.status .badge')?.textContent || ''), null, { timeout: 30000 });
const db4 = await dayBook();
const rcRow = db4.find((r) => r[1] === 'Receipt');
check(8, 'Recent transactions can be viewed and edited on the device (offline)', /Pending/.test(rcBadge) && db4.length === 2 && Number(rcRow[4]) === 1750, `receipt in Tally now ${rcRow[4]}`);

// ---------------- AC9: PDF, print, WhatsApp share
await page.goto(BASE + '/#detail/' + invId);
await page.waitForSelector('[data-act="pdf"]');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="pdf"]')]);
const pdfPath = `${SHOTS}/${dl.suggestedFilename()}`;
await dl.saveAs(pdfPath);
const pdfHead = fs.readFileSync(pdfPath).subarray(0, 5).toString();
await page.evaluate(() => { window.__printed = null; window.print = () => { window.__printed = 'called:' + document.getElementById('print-area').textContent; }; });
await page.click('[data-act="print"]');
await page.waitForFunction(() => window.__printed, null, { timeout: 5000 });
const printed = await page.evaluate(() => window.__printed);
await page.evaluate(() => {
  window.__shared = null;
  navigator.canShare = (d) => !!d.files;
  navigator.share = async (d) => { window.__shared = { name: d.files[0].name, type: d.files[0].type, size: d.files[0].size, text: d.text }; };
});
await ctx.setOffline(true);
await page.click('[data-act="share"]');
await page.waitForTimeout(300);
const shared = await page.evaluate(() => window.__shared);
await ctx.setOffline(false);
await shot('08-invoice-detail');
check(9, 'PDF export, print and WhatsApp share (share works offline)', pdfHead === '%PDF-' && /TAX INVOICE/.test(printed || '') && shared?.type === 'application/pdf', `PDF ${dl.suggestedFilename()}, ${fs.statSync(pdfPath).size} bytes; shared ${shared?.name}`);

// ---------------- AC10: responsiveness with realistic volume
await page.goto(BASE + '/#more');
await page.waitForSelector('[data-act="demo-bulk"]');
await page.click('[data-act="demo-bulk"]');
await page.waitForFunction(() => /10,0\d\d items/.test(document.body.textContent), null, { timeout: 60000 });
await page.goto(BASE + '/#new/si');
await page.click('[data-act="pickparty"]');
const timings = [];
for (const q of ['falcon', 'falcon hardware', 'sharjah 12', 'zzz']) {
  const t0 = Date.now();
  await page.fill('#pq', q);
  await page.waitForFunction((q) => document.getElementById('pq').value === q && document.getElementById('pres').dataset.ms, q);
  timings.push({ q, searchMs: Number(await page.getAttribute('#pres', 'data-ms')), uiMs: Date.now() - t0 });
}
const countTxt = await page.textContent('#pcount');
await shot('09-picker-5000');
await page.fill('#pq', 'falcon');
await page.waitForTimeout(150);
await page.locator('#pres [data-pick]').first().click();
await page.click('[data-act="additem"]');
for (const q of ['led bulb', 'cable 4mm', 'model 9876']) {
  const t0 = Date.now();
  await page.fill('#pq', q);
  await page.waitForFunction((q) => document.getElementById('pq').value === q && document.getElementById('pres').dataset.ms, q);
  timings.push({ q, searchMs: Number(await page.getAttribute('#pres', 'data-ms')), uiMs: Date.now() - t0 });
}
const itemCount = await page.textContent('#pcount');
const worst = Math.max(...timings.map((t) => t.searchMs));
check(10, 'Customer and item search stays fast with 5,000 customers and 10,000 items', worst < 100, `worst search ${worst.toFixed(1)} ms; ${countTxt.split('·')[0].trim()} customers; ${itemCount.split('·')[0].trim()} items`);

check('-', 'No JavaScript errors', errors.length === 0, errors.slice(0, 3).join(' | '));
fs.writeFileSync(`${SHOTS}/results.json`, JSON.stringify({ base: BASE, at: new Date().toISOString(), results, timings }, null, 2));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
