// Browser test of van stock in DEMO mode: issue to van, van sale (over-selling blocked), end-of-day return.
//   node relay/dev-server.js --port 8787 &   then   node tests/e2e-vans.mjs [http://localhost:8787] [shots-dir]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787', SH = process.argv[3] || 'test-results/vans';
fs.mkdirSync(SH, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 400, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
const shot = (n) => page.screenshot({ path: `${SH}/${n}.png`, fullPage: true });
const ok = (c, m) => { console.log(c ? 'PASS' : 'FAIL', m); if (!c) process.exitCode = 1; };
async function pick(q) { await page.fill('#pq', q); await page.waitForTimeout(150); await page.locator('#pres [data-pick]').first().click(); }
const sync = async () => { await page.evaluate(() => window.location.hash = '#home'); await page.waitForSelector('[data-act="syncnow"]'); await page.click('[data-act="syncnow"]'); await page.waitForTimeout(2500); await page.click('[data-act="syncnow"]'); await page.waitForTimeout(1500); };

await page.goto(BASE + '/#home');
await page.waitForFunction(() => !document.body.textContent.includes('No customers or items'), null, { timeout: 15000 });
// Settings
await page.waitForTimeout(3000); await page.goto(BASE + '/#vansettings'); await page.waitForSelector('#vs-on');
await page.check('#vs-on');
await shot('01-van-settings');
await page.click('[data-act="savevans"]'); await page.waitForTimeout(500);
await page.goto(BASE + '/#home'); await page.waitForSelector('[data-go="new/vi"]');
await shot('02-home');
// Issue 30 LED panels + 10 MCB to Van 1
await page.click('[data-go="new/vi"]'); await page.waitForSelector('select[data-f="van"]');
await page.selectOption('select[data-f="van"]', 'V1'); await page.waitForTimeout(200);
await page.click('[data-act="additem"]'); await pick('led panel');
await page.fill('[data-l="qty"][data-i="0"]', '30');
await page.click('[data-act="additem"]'); await pick('mcb');
await page.fill('[data-l="qty"][data-i="1"]', '10');
await shot('03-issue-form');
await page.click('[data-act="save"]'); await page.waitForURL(/#detail/);
await shot('04-issue-detail');
await sync();
// Invoice from van (demo user is assigned Van 1)
await page.goto(BASE + '/#new/si'); await page.waitForSelector('[data-act="pickparty"]');
await page.click('[data-act="pickparty"]'); await pick('gulf star');
await page.click('[data-act="additem"]'); await pick('led panel');
await page.fill('[data-l="qty"][data-i="0"]', '40');
await page.click('[data-act="save"]'); await page.waitForTimeout(300);
const err = await page.textContent('#formerr');
ok(/has only 30/.test(err), 'over-selling from van is blocked: ' + err);
await shot('05-invoice-too-much');
await page.fill('[data-l="qty"][data-i="0"]', '25');
await page.click('[data-act="save"]'); await page.waitForURL(/#detail/);
await sync();
await page.goto(BASE + '/#vans'); await page.waitForSelector('[data-van="V1"]');
const v1 = await page.textContent('[data-van="V1"]');
ok(/LED Panel Light 18W\s*5/.test(v1) && /MCB 32A\s*10/.test(v1), 'van 1 shows 5 LED and 10 MCB: ' + v1.replace(/\s+/g, ' '));
await shot('06-van-stock');
// End-of-day return
await page.click('[data-go="new/vr/V1"]'); await page.waitForSelector('[data-act="returnall"]');
await page.click('[data-act="returnall"]'); await page.waitForTimeout(200);
await shot('07-return-all');
await page.click('[data-act="save"]'); await page.waitForURL(/#detail/);
await sync();
await page.goto(BASE + '/#vans'); await page.waitForSelector('[data-van="V1"]');
ok(/Empty/.test(await page.textContent('[data-van="V1"]')), 'van 1 empty after return');
await shot('08-van-after-return');
// Tally side
const tally = await page.evaluate(async () => { const { db } = await import('./js/db.js'); const st = (await db.get('demo', 'state')).value.tally; return st.vouchers.map((v) => [v.vchType, v.number, v.lines.map((l) => `${l.item}:${l.qty}@${l.godown}${l.inward ? '+' : '-'}`).join(' | ')]); });
console.log(JSON.stringify(tally, null, 1));
await page.goto(BASE + '/#list/all'); await page.waitForSelector('.row'); await shot('09-list');
ok(!errors.length, 'no page errors ' + errors.join('; '));
await browser.close();
if (process.exitCode) process.exit(process.exitCode);
