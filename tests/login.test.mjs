// Password sign-in, lockout, sessions, data retention and the Tally sync check, over real HTTP:
//   1. self-hosted server (relay/dev-server.js)
//   2. production path: Worker entry -> local PostgREST stand-in -> Postgres (needs QE_PG_URL)
// plus the retention rules on RelayCore and in SQL directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayCore } from '../app/core/relay-core.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-login-'));
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
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  const r = await fetch(base + p, { method, headers, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const BAD = 'Wrong company ID, user code or password';

/** The same sign-in story on any backend. adminKey belongs to an admin of company `tid`. */
async function signInStory(api, tid, adminKey) {
  const add = await api(adminKey, 'POST', '/api/users', { name: 'Ahmed', code: 'ahm' });
  assert.equal(add.status, 200);
  let list = (await api(adminKey, 'GET', '/api/users')).data;
  assert.equal(list.find((u) => u.code === 'AHM').hasPassword, false);
  assert.equal((await api(adminKey, 'POST', '/api/users/password', { id: add.data.id, password: '12345' })).status, 400, 'too short');
  const sp = await api(adminKey, 'POST', '/api/users/password', { id: add.data.id, password: 'sunny42' });
  assert.equal(sp.status, 200);
  assert.equal(sp.data.company, tid);
  list = (await api(adminKey, 'GET', '/api/users')).data;
  assert.equal(list.find((u) => u.code === 'AHM').hasPassword, true);
  assert.equal((await api(add.data.key, 'POST', '/api/users/password', { id: add.data.id, password: 'mine123' })).status, 403, 'sales cannot set passwords');

  // Same answer for a wrong password, an unknown user and an unknown company: nothing to enumerate.
  for (const body of [{ company: tid, code: 'AHM', password: 'nope' }, { company: tid, code: 'ZZZ', password: 'nope' }, { company: 'no-such-co', code: 'AHM', password: 'nope' }]) {
    const r = await api(null, 'POST', '/api/login', body);
    assert.equal(r.status, 401); assert.equal(r.data.error, BAD);
  }
  // Company ID and code are not case sensitive; the session key works like a sign-in key.
  const ok = await api(null, 'POST', '/api/login', { company: tid.toUpperCase(), code: ' ahm ', password: 'sunny42' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.code, 'AHM');
  assert.equal(ok.data.user.tenant, tid);
  assert.notEqual(ok.data.key, add.data.key);
  const me = await api(ok.data.key, 'GET', '/api/me');
  assert.equal(me.status, 200); assert.equal(me.data.role, 'sales');
  // A second phone gets its own session; signing out ends only that one.
  const phone2 = (await api(null, 'POST', '/api/login', { company: tid, code: 'AHM', password: 'sunny42' })).data.key;
  assert.equal((await api(phone2, 'POST', '/api/logout', {})).status, 200);
  assert.equal((await api(phone2, 'GET', '/api/me')).status, 401, 'signed out');
  assert.equal((await api(ok.data.key, 'GET', '/api/me')).status, 200, 'other phone still signed in');
  assert.equal((await api(add.data.key, 'GET', '/api/me')).status, 200, 'sign-in key link still works');

  // 5 wrong tries lock the user, even for the right password; a reset unlocks and signs every phone out.
  for (let i = 1; i <= 4; i++) assert.equal((await api(null, 'POST', '/api/login', { company: tid, code: 'AHM', password: 'bad' + i })).status, 401);
  const locked = await api(null, 'POST', '/api/login', { company: tid, code: 'AHM', password: 'bad5' });
  assert.equal(locked.status, 429); assert.match(locked.data.error, /Too many wrong tries/);
  assert.equal((await api(null, 'POST', '/api/login', { company: tid, code: 'AHM', password: 'sunny42' })).status, 429, 'locked even with the right password');
  await api(adminKey, 'POST', '/api/users/password', { id: add.data.id, password: 'rainy77' });
  assert.equal((await api(ok.data.key, 'GET', '/api/me')).status, 401, 'old session ended by the reset');
  assert.equal((await api(null, 'POST', '/api/login', { company: tid, code: 'AHM', password: 'sunny42' })).status, 401, 'old password dead');
  const again = await api(null, 'POST', '/api/login', { company: tid, code: 'AHM', password: 'rainy77' });
  assert.equal(again.status, 200, 'unlocked by the reset');

  // A switched-off person cannot sign in; "New key" also ends password sessions.
  await api(adminKey, 'POST', '/api/users/update', { id: add.data.id, active: false });
  assert.equal((await api(null, 'POST', '/api/login', { company: tid, code: 'AHM', password: 'rainy77' })).data.error, BAD);
  assert.equal((await api(again.data.key, 'GET', '/api/me')).status, 401);
  await api(adminKey, 'POST', '/api/users/update', { id: add.data.id, active: true });
  const s3 = (await api(null, 'POST', '/api/login', { company: tid, code: 'AHM', password: 'rainy77' })).data.key;
  await api(adminKey, 'POST', '/api/users/resetkey', { id: add.data.id });
  assert.equal((await api(s3, 'GET', '/api/me')).status, 401, 'new key signs every phone out');

  // Archive and sync check are admin only.
  const s4 = (await api(null, 'POST', '/api/login', { company: tid, code: 'AHM', password: 'rainy77' })).data.key;
  assert.equal((await api(s4, 'GET', '/api/archive')).status, 403);
  assert.equal((await api(s4, 'GET', '/api/sync-check')).status, 403);
  const chk = await api(adminKey, 'GET', '/api/sync-check');
  assert.equal(chk.status, 200);
  assert.deepEqual(Object.keys(chk.data.counts).sort(), ['archived', 'conflict', 'failed', 'queued', 'synced']);
  return { salesKey: s4 };
}

test('self-hosted: password sign-in, lockout and sessions', async () => {
  const port = 22000 + Math.floor(Math.random() * 500);
  const cfg = path.join(tmp, 'relay.json');
  fs.writeFileSync(cfg, JSON.stringify({ tenants: { t1: { name: 'T1', connectorKey: 'ck', users: [{ id: 'u1', name: 'Boss', code: 'BOS', role: 'admin', token: 'admin-key' }] } } }));
  await start(['relay/dev-server.js', '--port', String(port), '--config', cfg, '--data', path.join(tmp, 's.json')], 'QuickEntry relay');
  await signInStory(client(`http://localhost:${port}`), 't1', 'admin-key');
  const saved = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  const ahm = saved.tenants.t1.users.find((u) => u.code === 'AHM');
  assert.ok(ahm.pw?.hash && !JSON.stringify(saved).includes('rainy77'), 'only a password hash is saved');
});

const pgUrl = process.env.QE_PG_URL;
test('production path: password sign-in, lockout, sessions and owner password reset', { skip: !pgUrl && 'set QE_PG_URL' }, async () => {
  const port = 22600 + Math.floor(Math.random() * 300);
  const OWNER = 'owner-key-for-tests-0123456789';
  await start(['tests/cf-local.mjs', '--port', String(port)], 'cf-local on', { QE_OWNER_KEY: OWNER });
  const api = client(`http://localhost:${port}`);
  const id = 'qa-' + Math.random().toString(36).slice(2, 8);
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: pgUrl, max: 1 });
  try {
    const co = await api(OWNER, 'POST', '/api/owner/tenants', { name: 'Login QA LLC', id, adminName: 'Boss', adminCode: 'BOS' });
    assert.equal(co.status, 200);
    const { salesKey } = await signInStory(api, id, co.data.admin.key);
    // The owner sets the admin's password from the owner page.
    assert.equal((await api(OWNER, 'POST', '/api/owner/users/password', { tenant: id, id: co.data.admin.id, password: 'office99' })).status, 200);
    const adm = await api(null, 'POST', '/api/login', { company: id, code: 'bos', password: 'office99' });
    assert.equal(adm.status, 200); assert.equal(adm.data.user.role, 'admin');
    // Bad input to the login route.
    assert.equal((await api(null, 'POST', '/api/login', { company: id, code: 'BOS', password: { $ne: 1 } })).status, 400);
    assert.equal((await api(null, 'POST', '/api/login', [])).status, 400);
    assert.equal((await api(salesKey, 'POST', '/api/owner/users/password', { tenant: id, id: co.data.admin.id, password: 'hacked1' })).status, 401, 'a user key is not the owner key');
    // Passwords are bcrypt hashes; session keys are stored only as SHA-256 hashes.
    const { rows } = await pool.query('select password_hash from app_users where tenant_id = $1 and code = $2', [id, 'BOS']);
    assert.match(rows[0].password_hash, /^\$2a\$08\$/);
    const sess = await pool.query('select token_hash from user_sessions where tenant_id = $1', [id]);
    assert.ok(sess.rows.some((r) => r.token_hash === crypto.createHash('sha256').update(adm.data.key).digest('hex')));
    assert.ok(!sess.rows.some((r) => r.token_hash === adm.data.key));
  } finally {
    await pool.query('delete from tenants where id = $1', [id]);
    await pool.end();
  }
});

// ---------------------------------------------------------------- retention
const DAY = 86400000;
test('retention (self-hosted and demo): active 7 days, archive 30, then deleted; unsynced never touched', async () => {
  const core = new RelayCore();
  const t = core.tenant('t'); t.settings = { serverActiveDays: 7, archiveDays: 30 };
  await core.pushTransactions('t', 'u', [
    { id: 'old', type: 'si', version: 1, number: 'SI-1', lines: [{ qty: 2, rate: 5 }] },
    { id: 'new', type: 'si', version: 1, number: 'SI-2', lines: [] },
    { id: 'stuck', type: 'si', version: 1, number: 'SI-3', lines: [] },
    { id: 'bad', type: 'si', version: 1, number: 'SI-4', lines: [] },
  ]);
  for (const id of ['old', 'new']) await core.connectorResult('t', { id, version: 1, ok: true, masterId: 1, voucherNo: id });
  await core.connectorResult('t', { id: 'bad', version: 1, ok: false, error: 'Ledger missing' });
  const now = Date.now();
  t.mappings.old.syncedAt = new Date(now - 8 * DAY).toISOString();
  let r = await core.cleanup('t', now);
  assert.deepEqual(r, { archived: 1, deleted: 0, logDeleted: 0 });
  const arch = await core.getArchive('t');
  assert.equal(arch.length, 1); assert.equal(arch[0].number, 'SI-1'); assert.equal(arch[0].total, 10);
  assert.equal((await core.getArchive('t', 'si-2')).length, 0);
  // 31 days later the archived one is deleted; everything else is still there.
  r = await core.cleanup('t', now + 31 * DAY);
  assert.equal(r.deleted, 1);
  assert.deepEqual(Object.keys(t.txns).sort(), ['bad', 'new', 'stuck']);
  assert.equal(t.txns.stuck.status, 'queued'); assert.equal(t.txns.bad.status, 'failed');
  // A late re-send of the deleted one is refused, so Tally never gets it twice.
  const again = await core.pushTransactions('t', 'u', [{ id: 'old', type: 'si', version: 1, lines: [] }]);
  assert.equal(again[0].accepted, false); assert.equal(again[0].purged, true);
  const sum = await core.getSummary('t');
  assert.equal(sum.counts.queued, 1); assert.equal(sum.counts.failed, 1);
  assert.ok(sum.attention.some((x) => x.id === 'bad'));
});

test('retention in SQL: same rules, run by the connector at most once an hour', { skip: !pgUrl && 'set QE_PG_URL' }, async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: pgUrl, max: 1 });
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const call = async (key, op, body = {}) => (await pool.query('select qe_api($1, $2, $3::jsonb) as r', [key === null ? null : sha(key), op, JSON.stringify(body)])).rows[0].r;
  const tid = 'qr-' + crypto.randomUUID().slice(0, 8);
  try {
    const co = await call(null, 'owner.tenant.create', { id: tid, name: 'Ret', adminName: 'A', adminCode: 'ADM', settings: { serverActiveDays: 7, archiveDays: 30, tax: { currency: 'AED' } } });
    const k = co.admin.key, ck = co.connectorKey;
    const mk = (id, n) => ({ id, type: 'si', version: 1, number: n, date: '2026-10-01', lines: [{ itemCode: 'X', qty: 3, rate: 4 }] });
    await call(k, 'txns.push', { txns: [mk('a', 'SI-A'), mk('b', 'SI-B'), mk('c', 'SI-C'), mk('d', 'SI-D')] });
    for (const id of ['a', 'b']) await call(ck, 'connector.result', { id, version: 1, ok: true, masterId: 1, voucherNo: 'V' + id, action: 'Create' });
    await call(ck, 'connector.result', { id: 'd', version: 1, ok: false, error: 'Ledger missing' });
    await pool.query("update sync_mappings set synced_at = now() - interval '8 days' where tenant_id = $1 and txn_id = 'a'", [tid]);
    await pool.query("update txns set received_at = now() - interval '2 hours' where tenant_id = $1 and id = 'c'", [tid]);
    await call(ck, 'connector.hello', { version: 'qa', tallyOk: true }); // first hello runs the cleanup
    const arch = await call(k, 'archive.list', {});
    assert.equal(arch.length, 1); assert.equal(arch[0].number, 'SI-A'); assert.equal(Number(arch[0].total), 12); assert.equal(arch[0].voucherNo, 'Va');
    assert.equal((await call(k, 'archive.list', { q: 'si-a' })).length, 1);
    assert.equal((await call(k, 'archive.list', { q: 'zzz' })).length, 0);
    const sum = await call(k, 'txns.summary');
    assert.deepEqual(sum.counts, { queued: 1, failed: 1, conflict: 0, synced: 1, archived: 1 });
    assert.deepEqual(sum.attention.map((x) => x.id).sort(), ['c', 'd'], 'failed, and waiting over an hour');
    // Ran less than an hour ago: a second hello does not clean up again.
    await pool.query("update txns set archived_at = now() - interval '31 days' where tenant_id = $1 and id = 'a'", [tid]);
    await call(ck, 'connector.hello', { version: 'qa', tallyOk: true });
    assert.equal((await call(k, 'archive.list', {})).length, 1);
    await pool.query("update tenants set last_cleanup = now() - interval '2 hours' where id = $1", [tid]);
    await call(ck, 'connector.hello', { version: 'qa', tallyOk: true });
    assert.equal((await call(k, 'archive.list', {})).length, 0, 'deleted after the archive period');
    const left = (await pool.query('select id, status from txns where tenant_id = $1 order by id', [tid])).rows;
    assert.deepEqual(left, [{ id: 'b', status: 'synced' }, { id: 'c', status: 'queued' }, { id: 'd', status: 'failed' }]);
    const re = await call(k, 'txns.push', { txns: [mk('a', 'SI-A')] });
    assert.equal(re[0].accepted, false); assert.equal(re[0].purged, true);
    assert.equal((await call(ck, 'connector.queue')).some((e) => e.txn.id === 'a'), false, 'never queued for Tally again');
    // Settings out of range are clamped, not trusted.
    await pool.query(`update tenants set settings = settings || '{"serverActiveDays":-5,"archiveDays":"abc"}' where id = $1`, [tid]);
    const r = (await pool.query('select qe_cleanup($1) as r', [tid])).rows[0].r;
    assert.equal(r.archived, 0, 'active days below 1 count as 1, so b synced just now stays active');
    await call(ck, 'connector.hello', { version: 'qa', tallyOk: true }); // bad settings never break the connector
    // Sales cannot see the archive.
    const s = await call(k, 'users.add', { name: 'S', code: 'SS' });
    await assert.rejects(call(s.key, 'archive.list', {}), /Only an office admin/);
  } finally {
    await pool.query('delete from tenants where id = $1', [tid]);
    await pool.end();
  }
});
