// Users screen and owner page APIs over real HTTP:
//   1. self-hosted server (relay/dev-server.js)
//   2. production path: Worker entry -> local PostgREST stand-in -> Postgres (needs QE_PG_URL)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-users-'));
const procs = [];
test.after(() => procs.forEach((p) => p.kill()));
const start = (args, ready, env = {}) => new Promise((res, rej) => {
  const p = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env } });
  procs.push(p);
  let out = '';
  p.stdout.on('data', (d) => { out += d; if (out.includes(ready)) res(p); });
  p.stderr.on('data', (d) => { out += d; });
  p.on('exit', (c) => rej(new Error('exited ' + c + ' ' + out)));
});
const client = (base) => async (key, method, p, body) => {
  const r = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

test('self-hosted: admin adds, switches off and re-keys a salesperson; changes are saved', async () => {
  const port = 21000 + Math.floor(Math.random() * 500);
  const cfg = path.join(tmp, 'relay.json');
  fs.writeFileSync(cfg, JSON.stringify({ tenants: { t1: { name: 'T1', connectorKey: 'ck', users: [{ id: 'u1', name: 'Boss', code: 'BOS', role: 'admin', token: 'admin-key' }] } } }));
  await start(['relay/dev-server.js', '--port', String(port), '--config', cfg, '--data', path.join(tmp, 's.json')], 'QuickEntry relay');
  const api = client(`http://localhost:${port}`);

  const add = await api('admin-key', 'POST', '/api/users', { name: 'Ahmed', code: 'ahm' });
  assert.equal(add.status, 200);
  assert.equal(add.data.code, 'AHM');
  assert.equal((await api(add.data.key, 'GET', '/api/me')).data.role, 'sales');
  assert.equal((await api(add.data.key, 'GET', '/api/users')).status, 403, 'sales cannot list users');
  assert.equal((await api('admin-key', 'POST', '/api/users', { name: 'X', code: 'AHM' })).status, 400, 'duplicate code');
  assert.ok(JSON.parse(fs.readFileSync(cfg, 'utf8')).tenants.t1.users.some((u) => u.code === 'AHM'), 'saved to config');

  await api('admin-key', 'POST', '/api/users/update', { id: add.data.id, active: false });
  assert.equal((await api(add.data.key, 'GET', '/api/me')).status, 401, 'switched off');
  await api('admin-key', 'POST', '/api/users/update', { id: add.data.id, active: true });
  const nk = await api('admin-key', 'POST', '/api/users/resetkey', { id: add.data.id });
  assert.equal((await api(add.data.key, 'GET', '/api/me')).status, 401, 'old key dead');
  assert.equal((await api(nk.data.key, 'GET', '/api/me')).status, 200, 'new key works');
  assert.equal((await api('admin-key', 'POST', '/api/users/update', { id: 'u1', active: false })).status, 400, 'no self lock-out');
});

const pgUrl = process.env.QE_PG_URL;
test('production path: owner page creates a company; its admin adds a salesperson', { skip: !pgUrl && 'set QE_PG_URL' }, async () => {
  const port = 21600 + Math.floor(Math.random() * 300);
  const OWNER = 'owner-key-for-tests-0123456789';
  await start(['tests/cf-local.mjs', '--port', String(port)], 'cf-local on', { QE_OWNER_KEY: OWNER });
  const api = client(`http://localhost:${port}`);
  const id = 'qa-' + Math.random().toString(36).slice(2, 8);

  assert.equal((await api('wrong-owner-key-xxxxxxxxxxxx', 'GET', '/api/owner/tenants')).status, 401);
  const c = await api(OWNER, 'POST', '/api/owner/tenants', { id, name: 'QA Trading', adminName: 'Boss', adminCode: 'BOS' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.ok(c.data.connectorKey && c.data.admin.key);
  assert.equal((await api(c.data.admin.key, 'GET', '/api/owner/tenants')).status, 401, 'user key cannot open owner API');
  const settings = await api(c.data.admin.key, 'GET', '/api/settings');
  assert.equal(settings.data.company.name, 'QA Trading', 'default settings created');
  const s = await api(c.data.admin.key, 'POST', '/api/users', { name: 'Ahmed', code: 'AHM' });
  assert.equal(s.status, 200);
  assert.equal((await api(s.data.key, 'GET', '/api/me')).data.tenant, id);
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: pgUrl });
  await pool.query('delete from tenants where id = $1', [id]);
  await pool.end();
});
