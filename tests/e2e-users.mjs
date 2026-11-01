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

// ---- Users screen, demo mode
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '/#more');
  await page.waitForSelector('text=Users and sign-in keys');
  await page.click('text=Users and sign-in keys');
  await page.waitForSelector('text=Add a person');
  check(await page.isVisible('text=Ahmed (Sales)'), 'Users screen lists the company users');
  await page.fill('#nu-name', 'Fatima');
  await page.fill('#nu-code', 'fat');
  await page.click('text=Add and create key');
  await page.waitForSelector('#newkey');
  const key = await page.textContent('#newkey');
  check(/^[A-Za-z0-9_-]{30,}$/.test(key), 'Adding a person shows a new sign-in key once', key.length + ' chars');
  const wa = await page.getAttribute('a.wa', 'href');
  check(wa.includes(encodeURIComponent('/#connect=' + key)), 'WhatsApp message carries a one-tap sign-in link');
  await page.screenshot({ path: `${OUT}/users-newkey.png`, fullPage: true });
  await page.click('[data-act="usertoggle"] >> nth=0').catch(() => {});
  await page.reload(); await page.waitForSelector('text=Add a person');
  check(!(await page.isVisible('#newkey')), 'The key is not shown again after leaving the screen');
  await page.fill('#nu-name', 'Dup'); await page.fill('#nu-code', 'FAT'); await page.click('text=Add and create key');
  await page.waitForTimeout(400);
  check((await page.textContent('#toast')).includes('already used'), 'Duplicate code is refused with a clear message');
  await page.screenshot({ path: `${OUT}/users-list.png`, fullPage: true });

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
  await page.fill('#nc-id', id); await page.fill('#nc-admin', 'Office Boss'); await page.fill('#nc-code', 'BOS');
  await page.click('text=Create company');
  await page.waitForSelector('.keycard');
  const keys = await page.$$eval('.keycard code.key', (els) => els.map((e) => e.textContent));
  check(keys.length === 2, 'Creating a company shows the admin key and the connector key');
  await page.screenshot({ path: `${OUT}/owner-created.png`, fullPage: true });
  const me = await (await fetch(url + '/api/me', { headers: { Authorization: 'Bearer ' + keys[0] } })).json();
  check(me.role === 'admin' && me.tenant === id, 'The new admin key signs in to the new company');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.QE_PG_URL });
  await pool.query('delete from tenants where id = $1', [id]); await pool.end();
  cf.kill();
  await ctx.close();
}
check(errors.length === 0, 'No JavaScript errors', errors.join(' | '));
await browser.close();
process.exit(fails ? 1 : 0);
