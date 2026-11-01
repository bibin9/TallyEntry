// LIVE-MODE path test: browser app -> Cloudflare Pages Function (run locally) -> Postgres (schema.sql)
// <- office connector process -> SIMULATED Tally server. Needs QE_PG_URL. Tally is still the simulator.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { defaultSettings } from '../app/core/defaults.js';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SHOTS = process.argv[2] || 'test-results/live';
fs.mkdirSync(SHOTS, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qelive-'));
const procs = [];
const start = (args, ready, env = {}) => new Promise((res, rej) => {
  const p = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env } }); procs.push(p);
  let out = ''; p.stdout.on('data', (d) => { out += d; if (out.includes(ready)) res(p); }); p.stderr.on('data', (d) => (out += d));
  p.on('exit', (c) => rej(new Error(out)));
});
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };
const T_PORT = 19400, C_PORT = 8790;

try {
  await start(['mock-tally/server.js', '--port', String(T_PORT)], 'SIMULATED');
  await start(['tests/cf-local.mjs', '--port', String(C_PORT)], 'cf-local');
  const db = new pg.Pool({ connectionString: process.env.QE_PG_URL });
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const tid = 'live-' + crypto.randomUUID().slice(0, 6), ck = crypto.randomBytes(18).toString('hex'), ut = crypto.randomBytes(18).toString('hex');
  const settings = defaultSettings('Al Noor Trading LLC (Demo)');
  await db.query('insert into tenants (id,name,settings,connector_key_hash) values ($1,$2,$3,$4)', [tid, 'Al Noor', settings, sha(ck)]);
  await db.query(`insert into app_users (id,tenant_id,name,code,role,token_hash) values ($1,$2,'Ahmed','AHM','admin',$3)`, ['u-' + tid, tid, sha(ut)]);
  const cfg = path.join(tmp, 'conn.json');
  fs.writeFileSync(cfg, JSON.stringify({ tallyUrl: `http://localhost:${T_PORT}`, tallyCompany: 'Al Noor Trading LLC (Demo)', relayUrl: `http://localhost:${C_PORT}`, connectorKey: ck }));
  const connector = () => execFileSync(process.execPath, ['connector/index.js', '--config', cfg, '--once'], { cwd: root }).toString();
  connector();

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const BASE = `http://localhost:${C_PORT}`;
  await page.goto(BASE + '/#more');
  await page.waitForSelector('#c-token');
  await page.fill('#c-token', ut);
  await page.click('[data-act="golive"]');
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => !document.querySelector('#modebar') || document.querySelector('#modebar').hidden, null, { timeout: 10000 });
  await page.goto(BASE + '/#home');
  await page.waitForFunction(() => document.querySelector('.tiles') && !document.body.textContent.includes('No customers or items'), null, { timeout: 20000 });
  check('Live sign-in and first master download through the Pages Function', true);

  await page.evaluate(() => navigator.serviceWorker.ready);
  await ctx.setOffline(true);
  await page.goto(BASE + '/#new/si');
  await page.click('[data-act="pickparty"]'); await page.fill('#pq', 'emirates hardware'); await page.waitForTimeout(150); await page.locator('#pres [data-pick]').first().click();
  await page.click('[data-act="additem"]'); await page.fill('#pq', 'mcb'); await page.waitForTimeout(150); await page.locator('#pres [data-pick]').first().click();
  await page.fill('[data-l="qty"][data-i="0"]', '12');
  await page.click('[data-act="save"]');
  await page.waitForSelector('.status');
  const id = page.url().split('/').pop();
  check('Invoice saved offline in live mode', /Pending/.test(await page.textContent('.status .badge')));
  await ctx.setOffline(false);
  await page.waitForFunction(() => /Waiting for Tally/.test(document.querySelector('.status .badge')?.textContent || ''), null, { timeout: 30000 });
  check('Uploaded to the cloud when back online', true);
  connector();
  await page.click('#syncpill');
  await page.waitForFunction(() => /Synced/.test(document.querySelector('.status .badge')?.textContent || ''), null, { timeout: 30000 });
  let day = await (await fetch(`http://localhost:${T_PORT}/sim/daybook`)).json();
  check('Connector posted it to (simulated) Tally; app shows Synced', day.length === 1 && day[0].party === 'Emirates Hardware LLC', `vouchers ${day.length}`);
  await page.screenshot({ path: `${SHOTS}/live-synced.png`, fullPage: true });

  await page.click('[data-act="edit"]'); await page.waitForSelector('[data-l="qty"]');
  await page.fill('[data-l="qty"][data-i="0"]', '30'); await page.click('[data-act="save"]');
  await page.waitForFunction(() => /Waiting for Tally/.test(document.querySelector('.status .badge')?.textContent || ''), null, { timeout: 30000 });
  connector(); connector();
  await page.click('#syncpill');
  await page.waitForFunction(() => /Synced/.test(document.querySelector('.status .badge')?.textContent || ''), null, { timeout: 30000 });
  const day2 = await (await fetch(`http://localhost:${T_PORT}/sim/daybook`)).json();
  check('Edit updates the same voucher, no duplicate', day2.length === 1 && day2[0].masterId === day[0].masterId && day2[0].amount > day[0].amount, `${day[0].amount} -> ${day2[0].amount}`);

  const bad = await fetch(`${BASE}/api/masters`, { headers: { Authorization: 'Bearer nope' } });
  const badConn = await fetch(`${BASE}/api/connector/queue`, { headers: { Authorization: 'Bearer ' + ut } });
  check('Wrong keys are refused (401)', bad.status === 401 && badConn.status === 401);
  const lines = await db.query('select count(*)::int n from txn_lines where tenant_id=$1 and txn_id=$2', [tid, id]);
  check('Transaction lines stored in their own table', lines.rows[0].n === 1);
  check('No JavaScript errors', errors.length === 0, errors.join(' | '));
  await db.query('delete from tenants where id=$1', [tid]); await db.end();
  await browser.close();
} catch (e) { console.error(e); results.push({ ok: false }); }
procs.forEach((p) => p.kill());
process.exit(results.every((r) => r.ok) ? 0 : 1);
