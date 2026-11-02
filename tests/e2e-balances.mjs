// Browser check: balances, overdue, credit limit, price levels and stock from (simulated) Tally.
//   node tests/e2e-balances.mjs http://localhost:8790 /tmp/shots
import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const B = process.argv[2] || 'http://localhost:8790', OUT = process.argv[3] || '/tmp/qe-balances';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`); };
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 400, height: 860 } })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
const pick = async (q) => { await page.fill('#pq', q); await page.waitForTimeout(250); await page.locator('#pres [data-pick]').first().click(); await page.waitForTimeout(250); };

await page.goto(B + '/#home');
await page.waitForFunction(() => !document.body.textContent.includes('No customers or items'), null, { timeout: 15000 });
await page.goto(B + '/#parties');
await page.waitForSelector('.list .row', { timeout: 10000 });
const list = await page.textContent('.list');
await page.screenshot({ path: OUT + '/b1-customers.png' });
check('Customers list shows balance and overdue from Tally', /Owes AED 4,700\.00/.test(list) && /3,200\.00 overdue/.test(list));

await page.goto(B + '/#new/si');
await page.click('[data-act="pickparty"]'); await pick('gulf');
await page.click('[data-act="additem"]'); await pick('led panel');
const rate = await page.inputValue('[data-l="rate"]');
check('Wholesale customer gets the Wholesale price level', rate === '37.8', `rate ${rate}`);
await page.fill('[data-l="qty"]', '500'); await page.waitForTimeout(250);
const stk = await page.textContent('.line .stk');
await page.screenshot({ path: OUT + '/b2-wholesale.png' });
check('Item line shows stock and warns when quantity is more than stock', /Stock 233 \(not enough\)/.test(stk), stk);

await page.click('[data-act="pickparty"]'); await pick('emirates');
const rate2 = await page.inputValue('[data-l="rate"]');
const info = await page.textContent('#partyinfo');
await page.screenshot({ path: OUT + '/b3-overlimit.png' });
check('Changing to a normal customer moves the line back to the standard price', rate2 === '42', `rate ${rate2}`);
check('Overdue and credit limit warnings show for the customer', /overdue/.test(info) && /over the credit limit of AED 5,000\.00/.test(info));
await page.fill('[data-l="qty"]', '1'); await page.waitForTimeout(250);
const info2 = await page.textContent('#partyinfo');
check('Credit warning updates as the invoice total changes', /takes the balance to AED 6,144\.10/.test(info2), info2.match(/balance to [^,]+,\d+\.\d+/)?.[0]);

check('No JavaScript errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
