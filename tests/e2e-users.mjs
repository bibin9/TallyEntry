// Browser test of the Users screen (demo mode) and the owner page (production path).
//   node tests/e2e-users.mjs <dev-server-url> [out-dir]      (owner part needs QE_PG_URL)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8787', OUT = process.argv[3] || '/tmp/e2e-users';
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const check = (ok, name, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
const errors = [];

// ---- First run, Users screen and settings, demo mode
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '/');
  await page.waitForSelector('#li-co');
  check(await page.isVisible('text=Company ID') && await page.isVisible('#li-pw'), 'First run opens the sign-in screen (Company ID, user code, password)');
  await page.screenshot({ path: `${OUT}/signin.png` });
  await page.click('[data-act="signin"]');
  check((await page.textContent('#lierr')).includes('Enter your company ID'), 'Signing in with empty fields says what is missing');
  await page.click('[data-act="trydemo"]');
  await page.waitForSelector('.tiles');
  check(true, '"Try the demo" opens the app with sample data');

  await page.goto(BASE + '/#more');
  await page.waitForSelector('text=Users and passwords');
  await page.click('text=Users and passwords');
  await page.waitForSelector('text=Add a person');
  check(await page.isVisible('text=Ahmed (Sales)'), 'Users screen lists the company users');
  check(/^[a-z]{5}[2-9]{3}$/.test(await page.inputValue('#nu-pw')), 'A password is suggested for the new person', await page.inputValue('#nu-pw'));
  await page.fill('#nu-name', 'Fatima');
  await page.fill('#nu-code', 'fat');
  await page.fill('#nu-pw', 'fatima55');
  await page.click('text=Add person');
  await page.waitForSelector('.logindet');
  const det = await page.textContent('.logindet');
  check(det.includes('demo') && det.includes('FAT') && det.includes('fatima55'), 'Adding a person shows Company ID, user code and password once', det.replace(/\s+/g, ' '));
  const wa = decodeURIComponent(await page.getAttribute('a.wa', 'href'));
  check(wa.includes('Company ID: demo') && wa.includes('User code: FAT') && wa.includes('Password: fatima55'), 'WhatsApp message carries the sign-in details');
  await page.screenshot({ path: `${OUT}/users-login-details.png`, fullPage: true });
  await page.reload(); await page.waitForSelector('text=Add a person');
  check(!(await page.isVisible('.logindet')), 'The password is not shown again after leaving the screen');
  check((await page.textContent('#view')).includes('Fatima') && (await page.textContent('#view')).includes('password set'), 'The list shows who has a password');
  // Reset a password (prompt) and make a sign-in key (confirm).
  page.once('dialog', (d) => d.accept('ahmed777'));
  await page.click('[data-act="userpw"][data-code="AHM"]');
  await page.waitForSelector('.logindet');
  check((await page.textContent('.logindet')).includes('ahmed777'), 'Reset password shows the new sign-in details');
  page.once('dialog', (d) => d.accept());
  await page.click('[data-act="userkey"] >> nth=1');
  await page.waitForSelector('#newkey');
  const key = await page.textContent('#newkey');
  check(/^[A-Za-z0-9_-]{30,}$/.test(key) && decodeURIComponent(await page.getAttribute('.keycard a.wa >> nth=0', 'href')).includes('/#connect=' + key), '"New key" still makes a one-tap WhatsApp sign-in link');
  await page.fill('#nu-name', 'Dup'); await page.fill('#nu-code', 'FAT'); await page.click('text=Add person');
  await page.waitForTimeout(400);
  check((await page.textContent('#toast')).includes('already used'), 'Duplicate code is refused with a clear message');
  await page.screenshot({ path: `${OUT}/users-list.png`, fullPage: true });

  // Data retention settings
  await page.goto(BASE + '/#company');
  await page.waitForSelector('#co-active');
  check(await page.inputValue('#co-ret') === '2' && await page.inputValue('#co-active') === '7' && await page.inputValue('#co-arch') === '30', 'Retention defaults: phones 2 days, server 7 days, archive 30 days');
  await page.fill('#co-arch', '400'); await page.click('[data-act="savecompany"]');
  check((await page.textContent('#formerr')).includes('0 to 365'), 'Archive days outside 0 to 365 are refused');
  await page.fill('#co-arch', '45'); await page.click('[data-act="savecompany"]');
  await page.waitForSelector('text=Saved for all users');
  await page.goto(BASE + '/#company'); await page.waitForSelector('#co-arch');
  check(await page.inputValue('#co-arch') === '45', 'Archive days are saved for the company');
  await page.evaluate(() => document.querySelector('#co-ret').scrollIntoView());
  await page.screenshot({ path: `${OUT}/retention.png` });

  // Tally sync check and archive
  await page.goto(BASE + '/#synccheck');
  await page.waitForSelector('#verdict');
  check(/Everything is in Tally|on their way/.test(await page.textContent('#verdict')), 'Tally sync check gives a plain verdict', (await page.textContent('#verdict')).trim().slice(0, 60));
  await page.screenshot({ path: `${OUT}/synccheck.png`, fullPage: true });
  await page.goto(BASE + '/#archive');
  await page.waitForSelector('#archq');
  check((await page.textContent('#view')).includes('Nothing in the archive yet'), 'Archive screen opens (empty in a new demo)');

  // sign-in link fills the key
  const p2 = await ctx.newPage();
  await p2.goto(BASE + '/#connect=abcDEF123_-xyz');
  await p2.waitForSelector('#c-token');
  check((await p2.inputValue('#c-token')) === 'abcDEF123_-xyz', 'Opening the sign-in link fills in the key');
  check(!p2.url().includes('abcDEF'), 'The key is removed from the address bar');
  await ctx.close();
}

// ---- Owner page, production path
if (process.env.QE_PG_URL) {
  const port = 22500 + Math.floor(Math.random() * 300), OWNER = 'owner-key-for-e2e-0123456789';
  const cf = spawn(process.execPath, ['tests/cf-local.mjs', '--port', String(port)], { env: { ...process.env, QE_OWNER_KEY: OWNER } });
  await new Promise((r) => cf.stdout.on('data', (d) => String(d).includes('cf-local on') && r()));
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const url = `http://localhost:${port}`;
  await page.goto(url + '/owner.html');
  await page.fill('#ok', 'wrong-key-wrong-key-wrong-key');
  await page.click('text=Open');
  await page.waitForTimeout(500);
  check(await page.isVisible('#ok'), 'Owner page refuses a wrong owner key');
  await page.fill('#ok', OWNER); await page.click('text=Open');
  await page.waitForSelector('text=New client company');
  const id = 'e2e-' + Math.random().toString(36).slice(2, 7);
  await page.fill('#nc-name', 'E2E Trading LLC');
  check((await page.inputValue('#nc-id')) === 'e2e', 'Company ID is suggested from the name', await page.inputValue('#nc-id'));
  await page.fill('#nc-id', id); await page.fill('#nc-admin', 'Office Boss'); await page.fill('#nc-code', 'BOS'); await page.fill('#nc-pw', 'office123');
  await page.click('text=Create company');
  await page.waitForSelector('.keycard');
  const det = await page.textContent('.keycard .logindet');
  const keys = await page.$$eval('.keycard code.key', (els) => els.map((e) => e.textContent));
  check(det.includes(id) && det.includes('BOS') && det.includes('office123') && keys.length === 1, 'Creating a company shows the admin sign-in details and the connector key');
  await page.screenshot({ path: `${OUT}/owner-created.png`, fullPage: true });
  // Owner adds a salesperson with a password.
  await page.fill('#au-name', 'Sami'); await page.fill('#au-code', 'SAM'); await page.fill('#au-pw', 'sami1234');
  await page.click('[data-act="uadd"]');
  await page.waitForSelector('text=Sami added');
  check((await page.textContent('.keycard')).includes('sami1234'), 'Owner page adds a person with a password');
  await page.screenshot({ path: `${OUT}/owner-users.png`, fullPage: true });
  // Remember the owner key on this device.
  await page.click('#signout');
  await page.fill('#ok', OWNER); await page.check('#remember'); await page.click('text=Open');
  await page.waitForSelector('text=New client company');
  const p3 = await ctx.newPage(); await p3.goto(url + '/owner.html');
  await p3.waitForSelector('text=New client company');
  check(true, '"Remember on this device" keeps the owner signed in in a new tab');
  await p3.click('#signout'); await p3.close();

  // The admin signs in on a phone with the details, in live mode.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ph = await phone.newPage();
  ph.on('pageerror', (e) => errors.push(e.message));
  await ph.goto(url + '/');
  await ph.waitForSelector('#li-co');
  await ph.fill('#li-co', id); await ph.fill('#li-code', 'bos'); await ph.fill('#li-pw', 'wrong-pass');
  await ph.click('[data-act="signin"]');
  await ph.waitForFunction(() => document.querySelector('#lierr').textContent.length > 0);
  check((await ph.textContent('#lierr')).includes('Wrong company ID, user code or password'), 'A wrong password says so on the sign-in screen');
  await ph.screenshot({ path: `${OUT}/signin-wrong.png` });
  await ph.fill('#li-pw', 'office123'); await ph.click('[data-act="signin"]');
  await ph.waitForSelector('.tiles');
  check(!(await ph.isVisible('#modebar')), 'Signed in to live mode (no demo banner)');
  await ph.goto(url + '/#more'); await ph.waitForSelector('text=Sign out');
  check((await ph.textContent('#view')).includes(id), 'More shows the company ID of the signed-in person');
  await ph.goto(url + '/#synccheck'); await ph.waitForSelector('#verdict');
  check(/office PC is not sending/.test(await ph.textContent('#verdict')), 'Sync check warns when the office PC has never connected');
  await ph.screenshot({ path: `${OUT}/synccheck-pc-off.png`, fullPage: true });
  await ph.goto(url + '/#users'); await ph.waitForSelector('text=Company ID:');
  await ph.screenshot({ path: `${OUT}/users-live.png`, fullPage: true });
  await ph.goto(url + '/#more'); await ph.waitForSelector('text=Sign out');
  ph.once('dialog', (d) => d.accept());
  await ph.click('[data-act="signout"]');
  await ph.waitForSelector('#li-co');
  check((await ph.inputValue('#li-co')) === id, 'Sign out returns to the sign-in screen with the Company ID remembered');
  await phone.close();
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.QE_PG_URL });
  await pool.query('delete from tenants where id = $1', [id]); await pool.end();
  cf.kill();
  await ctx.close();
}
check(errors.length === 0, 'No JavaScript errors', errors.join(' | '));
await browser.close();
process.exit(fails ? 1 : 0);
