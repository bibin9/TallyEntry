// Runs the scenarios against relay/supabase/schema.sql on a real Postgres.
//   QE_PG_URL=postgres://postgres@localhost:5432/qe node --test tests/sql.test.mjs
import test from 'node:test';
import crypto from 'node:crypto';
import { scenarios } from './scenarios.mjs';

const url = process.env.QE_PG_URL;
if (!url) {
  test('Postgres scenarios (set QE_PG_URL to run)', { skip: true }, () => {});
} else {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  test.after(() => pool.end());
  scenarios(test, async () => {
    const tid = 't-' + crypto.randomUUID().slice(0, 8);
    const ut = 'user-' + tid, ck = 'conn-' + tid;
    await pool.query(`insert into tenants (id, name, settings, connector_key_hash) values ($1, 'Test', $2, $3)`, [tid, JSON.stringify({}), sha(ck)]);
    await pool.query(`insert into app_users (id, tenant_id, name, code, role, token_hash) values ($1, $2, 'Admin', 'ADM', 'admin', $3)`, ['u-' + tid, tid, sha(ut)]);
    const call = async (token, op, body = {}) => (await pool.query('select qe_api($1, $2, $3::jsonb) as r', [sha(token), op, JSON.stringify(body)])).rows[0].r;
    return {
      relay: {
        hello: (b) => call(ck, 'connector.hello', b), saveState: (s) => call(ck, 'connector.state', s),
        pushMasters: (b) => call(ck, 'connector.masters', b), pushBalances: (b) => call(ck, 'connector.balances', b), reconcile: (kind, codes) => call(ck, 'connector.reconcile', { kind, codes }),
        queue: () => call(ck, 'connector.queue'), result: (r) => call(ck, 'connector.result', r),
      },
      device: {
        masters: (since) => call(ut, 'masters', { since }), push: (txns) => call(ut, 'txns.push', { txns }),
        statuses: (ids) => call(ut, 'txns.status', { ids }), retry: (ids) => call(ut, 'txns.retry', { ids }),
        resolve: (id, choice) => call(ut, 'txns.resolve', { id, choice }), log: () => call(ut, 'log'),
        vanStock: () => call(ut, 'stock.vans'), saveSettings: (st) => call(ut, 'settings.put', st),
      },
      cleanup: () => pool.query('delete from tenants where id = $1', [tid]),
    };
  });
}
