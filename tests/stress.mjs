// Stress and load test for the production code path (Worker API + Postgres qe_api).
//   QE_PG_URL=... node tests/stress.mjs [results.json]
// Uses autocannon (npm i autocannon) for the sustained-load parts; loaded with createRequire so it
// can live outside the repo (set QE_AUTOCANNON to its folder).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';

const require = createRequire(process.env.QE_AUTOCANNON || import.meta.url);
const autocannon = require('autocannon');
const PG = process.env.QE_PG_URL;
if (!PG) { console.error('Set QE_PG_URL'); process.exit(2); }

const OWNER = crypto.randomBytes(24).toString('base64url');
const port = 24000 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${port}`;
const cf = spawn(process.execPath, ['tests/cf-local.mjs', '--port', String(port)], { env: { ...process.env, QE_OWNER_KEY: OWNER } });
await new Promise((r) => cf.stdout.on('data', (d) => String(d).includes('cf-local on') && r()));
const pool = new pg.Pool({ connectionString: PG });
const results = [];
const record = (area, name, pass, metrics) => { results.push({ area, name, pass, metrics }); console.log(`${pass ? 'PASS' : 'FAIL'}  [${area}] ${name}\n      ${JSON.stringify(metrics)}`); };

const req = async (key, method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
};
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]); };
// autocannon ignores a separate `path` option, so the path goes into the URL.
const run = ({ path: p = '/', ...opts }) => new Promise((res, rej) => autocannon({ url: BASE + p, ...opts }, (e, r) => (e ? rej(e) : res(r))));

const tid = `st-${crypto.randomUUID().slice(0, 6)}`;
const co = await req(OWNER, 'POST', '/api/owner/tenants', { id: tid, name: 'Stress Test LLC', adminName: 'Admin', adminCode: 'ADM' });
const admin = co.data.admin.key, ck = co.data.connectorKey;
const DEVICES = 30;
const reps = [];
for (let i = 0; i < DEVICES; i++) reps.push((await req(admin, 'POST', '/api/users', { name: `Rep ${i}`, code: `R${String(i).padStart(2, '0')}` })).data);

try {
  // ------------------------------------------------ 1. Masters: 5,000 customers and 10,000 items
  let t0 = Date.now();
  const ledgers = Array.from({ length: 5000 }, (_, i) => ({ code: `C${String(i).padStart(5, '0')}`, name: `Customer ${i} Trading LLC`, role: 'customer', parent: 'Sundry Debtors', trn: '100' + String(i).padStart(12, '0'), tallyGuid: crypto.randomUUID() }));
  const items = Array.from({ length: 10000 }, (_, i) => ({ code: `I${String(i).padStart(5, '0')}`, name: `Item ${i} 500ml`, unit: 'Pcs', rate: 1 + (i % 90), taxCode: 'SR', tallyGuid: crypto.randomUUID() }));
  for (let i = 0; i < 5000; i += 1000) await req(ck, 'POST', '/api/connector/masters', { ledgers: ledgers.slice(i, i + 1000), items: [] });
  for (let i = 0; i < 10000; i += 1000) await req(ck, 'POST', '/api/connector/masters', { ledgers: [], items: items.slice(i, i + 1000) });
  const upload = Date.now() - t0;
  t0 = Date.now();
  const full = await req(reps[0].key, 'GET', '/api/masters?since=0');
  const dl = Date.now() - t0;
  const size = JSON.stringify(full.data).length;
  t0 = Date.now();
  const again = await req(ck, 'POST', '/api/connector/masters', { ledgers: ledgers.slice(0, 1000), items: [] });
  const resync = Date.now() - t0;
  t0 = Date.now();
  const delta = await req(reps[0].key, 'GET', `/api/masters?since=${full.data.cursor}`);
  const deltaMs = Date.now() - t0;
  record('Masters', 'Office uploads 5,000 customers and 10,000 items; a phone downloads them all in one go',
    full.data.ledgers.length === 5000 && full.data.items.length === 10000 && again.data.ledgers.unchanged === 1000 && delta.data.ledgers.length === 0 && dl < 10000,
    { uploadMs: upload, fullDownloadMs: dl, fullDownloadMB: +(size / 1e6).toFixed(2), unchangedResync1000Ms: resync, deltaDownloadMs: deltaMs, deltaRecords: delta.data.ledgers.length + delta.data.items.length });

  // ------------------------------------------------ 2. 30 phones push at once, each request sent twice (flaky network retries)
  const inv = (rep, n) => ({ id: crypto.randomUUID(), version: 1, type: 'si', number: `SI-${rep.code}-${String(n).padStart(4, '0')}`, date: new Date().toISOString().slice(0, 10), partyCode: `C${String(n % 5000).padStart(5, '0')}`,
    lines: Array.from({ length: 5 }, (_, k) => ({ itemCode: `I${String((n * 7 + k) % 10000).padStart(5, '0')}`, qty: 1 + k, rate: 10, discPct: 0, taxCode: 'SR' })) });
  const PER = 40, BATCH = 10;
  const sent = reps.map((rep) => Array.from({ length: PER }, (_, n) => inv(rep, n + 1)));
  const lat = []; let errors = 0, dupes = 0, accepted = 0;
  t0 = Date.now();
  await Promise.all(reps.map(async (rep, d) => {
    for (let b = 0; b < PER; b += BATCH) {
      const txns = sent[d].slice(b, b + BATCH);
      const both = await Promise.all([0, 1].map(async () => { const s = Date.now(); const r = await req(rep.key, 'POST', '/api/txns', { txns }); lat.push(Date.now() - s); return r; }));
      for (const r of both) { if (r.status !== 200) errors++; else for (const x of r.data) { if (x.accepted) accepted++; if (x.duplicate) dupes++; } }
    }
  }));
  const pushMs = Date.now() - t0;
  const stored = (await pool.query('select count(*)::int n, count(distinct id)::int d from txns where tenant_id = $1', [tid])).rows[0];
  const lines = (await pool.query('select count(*)::int n from txn_lines where tenant_id = $1', [tid])).rows[0].n;
  const total = DEVICES * PER;
  record('Push', `${DEVICES} phones each push ${PER} invoices at the same time, every request sent twice: no duplicates, nothing lost`,
    errors === 0 && stored.n === total && stored.d === total && accepted === total && dupes === total && lines === total * 5,
    { invoices: total, requests: lat.length, errors, accepted, duplicatesRefused: dupes, storedRows: stored.n, storedLines: lines, wallMs: pushMs, invoicesPerSec: Math.round(total / (pushMs / 1000)), p50ms: pct(lat, 0.5), p95ms: pct(lat, 0.95), maxMs: Math.max(...lat) });

  // ------------------------------------------------ 3. Office connector drains the queue while phones keep polling status
  t0 = Date.now(); let posted = 0, rounds = 0;
  const ids = sent.flat().map((t) => t.id);
  let polling = true; const pollLat = [];
  const pollers = reps.slice(0, 10).map(async (rep, d) => { while (polling) { const s = Date.now(); await req(rep.key, 'POST', '/api/txns/status', { ids: sent[d].map((t) => t.id) }); pollLat.push(Date.now() - s); } });
  for (;;) {
    const q = await req(ck, 'GET', '/api/connector/queue');
    if (!q.data.length) break;
    rounds++;
    await Promise.all(q.data.map((e, k) => req(ck, 'POST', '/api/connector/result', { id: e.txn.id, version: e.txn.version, ok: true, action: 'Create', masterId: 100000 + posted + k, guid: crypto.randomUUID(), voucherNo: e.txn.number, alterId: posted + k })));
    posted += q.data.length;
  }
  polling = false; await Promise.all(pollers);
  const drainMs = Date.now() - t0;
  const synced = (await pool.query("select count(*)::int n from txns where tenant_id = $1 and status = 'synced'", [tid])).rows[0].n;
  const mapped = (await pool.query('select count(*)::int n from sync_mappings where tenant_id = $1', [tid])).rows[0].n;
  record('Connector', `Connector drains ${total} invoices (50 per batch) while 10 phones poll their status non-stop`,
    synced === total && mapped === total && posted === total,
    { posted, rounds, wallMs: drainMs, invoicesPerSec: Math.round(posted / (drainMs / 1000)), statusPolls: pollLat.length, pollP50ms: pct(pollLat, 0.5), pollP95ms: pct(pollLat, 0.95) });

  // ------------------------------------------------ 4. Sustained load (autocannon)
  const auth = { Authorization: 'Bearer ' + reps[1].key, 'Content-Type': 'application/json' };
  const sustained = async (name, opts, limitP99, expect = 200) => {
    const r = await run({ connections: 50, duration: 15, ...opts });
    const right = (r.statusCodeStats?.[expect]?.count || 0) === r.requests.total;
    record('Sustained', name, right && r.errors + r.timeouts === 0 && r.latency.p99 <= limitP99,
      { connections: 50, seconds: 15, requests: r.requests.total, reqPerSec: Math.round(r.requests.average), p50ms: r.latency.p50, p97_5ms: r.latency.p97_5, p99ms: r.latency.p99, maxMs: r.latency.max, statusCodes: Object.fromEntries(Object.entries(r.statusCodeStats || {}).map(([k, v]) => [k, v.count])), errors: r.errors, timeouts: r.timeouts });
    return r;
  };
  await sustained('Sign-in check (GET /api/me), 50 users at once for 15 s', { path: '/api/me', headers: auth }, 2000);
  await sustained('Status polling of 40 invoices (POST /api/txns/status), 50 at once for 15 s', { path: '/api/txns/status', method: 'POST', headers: auth, body: JSON.stringify({ ids: sent[1].map((t) => t.id) }) }, 2000);
  await sustained('Delta masters check (GET /api/masters?since=cursor), 50 at once for 15 s', { path: `/api/masters?since=${full.data.cursor + 1000}`, headers: auth }, 2000);
  await sustained('Wrong keys (brute force), 50 at once for 15 s: every answer is 401', { path: '/api/me', headers: { Authorization: 'Bearer ' + crypto.randomBytes(30).toString('base64url') } }, 2000, 401);

  // ------------------------------------------------ 5. Edits under load: new versions replace old, stale results ignored
  const edits = sent[2].slice(0, 20).map((t) => ({ ...t, version: 2, lines: t.lines.slice(0, 2) }));
  await req(reps[2].key, 'POST', '/api/txns', { txns: edits });
  const stale = await req(ck, 'POST', '/api/connector/result', { id: edits[0].id, version: 1, ok: false, error: 'late answer for v1' });
  const st = (await pool.query("select status, version from txns where tenant_id = $1 and id = $2", [tid, edits[0].id])).rows[0];
  const ln = (await pool.query('select count(*)::int n from txn_lines where tenant_id = $1 and txn_id = $2', [tid, edits[0].id])).rows[0].n;
  record('Consistency', 'Edited invoices go back in the queue as v2, and a late v1 answer from Tally does not overwrite them',
    stale.status === 200 && st.status === 'queued' && st.version === 2 && ln === 2, { status: st.status, version: st.version, lines: ln });
} finally {
  await pool.query('delete from tenants where id = $1', [tid]);
  await pool.end();
  cf.kill();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed} passed, ${results.length - passed} failed`);
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ at: new Date().toISOString(), node: process.version, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
