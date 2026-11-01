// User management and owner operations in relay/supabase/schema.sql, on a real Postgres.
//   QE_PG_URL=postgres://... node --test tests/users-sql.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const url = process.env.QE_PG_URL;
if (!url) {
  test('Users and owner SQL (set QE_PG_URL to run)', { skip: true }, () => {});
} else {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const call = async (key, op, body = {}) => (await pool.query('select qe_api($1, $2, $3::jsonb) as r', [key === null ? null : sha(key), op, JSON.stringify(body)])).rows[0].r;
  const fails = async (p, re) => assert.rejects(p, re);
  const tid = 'qa-' + crypto.randomUUID().slice(0, 8);
  test.after(async () => { await pool.query('delete from tenants where id = $1', [tid]); await pool.end(); });

  test('owner creates a company with an admin and a connector key; keys work and are stored only as hashes', async () => {
    const r = await call(null, 'owner.tenant.create', { id: tid, name: 'QA Co', adminName: 'Boss', adminCode: 'bos', settings: { company: { name: 'QA Co' } } });
    assert.equal(r.id, tid);
    assert.match(r.admin.key, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(r.admin.code, 'BOS');
    const me = await call(r.admin.key, 'me');
    assert.equal(me.role, 'admin');
    assert.equal(me.tenant, tid);
    await call(r.connectorKey, 'connector.hello', { version: 'qa' });
    const { rows } = await pool.query('select token_hash from app_users where tenant_id = $1', [tid]);
    assert.equal(rows[0].token_hash, sha(r.admin.key));
    test.admin = r.admin;
    test.ck = r.connectorKey;
  });

  test('owner ops refuse a user key, and a duplicate or invalid company id', async () => {
    await fails(call(test.admin.key, 'owner.tenants'), /Not allowed/);
    await fails(call(null, 'owner.tenant.create', { id: tid, name: 'X', adminName: 'A', adminCode: 'AA', settings: {} }), /already exists/);
    await fails(call(null, 'owner.tenant.create', { id: 'Bad Id!', name: 'X', adminName: 'A', adminCode: 'AA', settings: {} }), /Company ID/);
    const list = await call(null, 'owner.tenants');
    assert.ok(list.some((t) => t.id === tid && t.users === 1));
  });

  test('admin adds a salesperson; the new key signs in as sales', async () => {
    const s = await call(test.admin.key, 'users.add', { name: 'Ahmed', code: 'ahm', role: 'sales' });
    assert.equal(s.code, 'AHM');
    assert.equal((await call(s.key, 'me')).role, 'sales');
    await fails(call(test.admin.key, 'users.add', { name: 'Other', code: 'AHM' }), /already used/);
    await fails(call(test.admin.key, 'users.add', { name: 'Bad', code: 'TOO-LONG-CODE' }), /Code must be/);
    await fails(call(s.key, 'users.list'), /Only an office admin/);
    await fails(call(s.key, 'users.add', { name: 'Sneaky', code: 'SNK', role: 'admin' }), /Only an office admin/);
    test.sales = s;
  });

  test('switching a user off blocks sign-in at once; switching on restores it', async () => {
    await call(test.admin.key, 'users.update', { id: test.sales.id, active: false });
    await fails(call(test.sales.key, 'me'), /Please sign in again/);
    await call(test.admin.key, 'users.update', { id: test.sales.id, active: true });
    assert.equal((await call(test.sales.key, 'me')).name, 'Ahmed');
  });

  test('resetting a key: the old key stops working, the new one works', async () => {
    const r = await call(test.admin.key, 'users.resetkey', { id: test.sales.id });
    await fails(call(test.sales.key, 'me'), /Please sign in again/);
    assert.equal((await call(r.key, 'me')).id, test.sales.id);
  });

  test('an admin cannot lock the company out', async () => {
    await fails(call(test.admin.key, 'users.update', { id: test.admin.id, active: false }), /cannot switch off or demote yourself/);
    await fails(call(test.admin.key, 'users.update', { id: test.admin.id, role: 'sales' }), /cannot switch off or demote yourself/);
    await fails(call(null, 'owner.users.update', { tenant: tid, id: test.admin.id, role: 'sales' }), /at least one active admin/);
  });

  test('an admin cannot see or change users of another company', async () => {
    const other = 'qa2-' + crypto.randomUUID().slice(0, 8);
    const o = await call(null, 'owner.tenant.create', { id: other, name: 'Other', adminName: 'O', adminCode: 'OO', settings: {} });
    try {
      const list = await call(test.admin.key, 'users.list');
      assert.ok(list.every((u) => u.id.startsWith(tid)));
      await fails(call(test.admin.key, 'users.resetkey', { id: o.admin.id }), /User not found/);
    } finally { await pool.query('delete from tenants where id = $1', [other]); }
  });

  test('owner can reset the connector key; the old one stops working', async () => {
    const r = await call(null, 'owner.tenant.connectorkey', { tenant: tid });
    await fails(call(test.ck, 'connector.hello', {}), /Invalid connector key/);
    await call(r.connectorKey, 'connector.hello', {});
  });
}
