// End-to-end over real HTTP: simulated Tally server <- connector process -> relay server <- device API calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-'));
const procs = [];
const start = (args, ready) => new Promise((res, rej) => {
  const p = spawn(process.execPath, args, { cwd: root });
  procs.push(p);
  let out = '';
  p.stdout.on('data', (d) => { out += d; if (out.includes(ready)) res(p); });
  p.stderr.on('data', (d) => { out += d; });
  p.on('exit', (c) => rej(new Error('exited ' + c + ' ' + out)));
});
const runConnector = (cfg) => new Promise((res) => {
  const p = spawn(process.execPath, ['connector/index.js', '--config', cfg, '--once'], { cwd: root });
  let out = ''; p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => out += d);
  p.on('exit', (code) => res({ code, out }));
});

test('HTTP stack: connector syncs masters and posts a device invoice exactly once', async (t) => {
  t.after(() => procs.forEach((p) => p.kill()));
  const tPort = 19000 + Math.floor(Math.random() * 500), rPort = tPort + 1000;
  await start(['mock-tally/server.js', '--port', String(tPort)], 'SIMULATED');
  const relayCfg = path.join(tmp, 'relay.json');
  fs.writeFileSync(relayCfg, JSON.stringify({ tenants: { t1: { name: 'Al Noor Trading LLC (Demo)', connectorKey: 'ck-test', users: [{ id: 'u1', name: 'Ahmed', code: 'AHM', role: 'admin', token: 'ut-test' }] } } }));
  await start(['relay/dev-server.js', '--port', String(rPort), '--config', relayCfg, '--data', path.join(tmp, 'state.json')], 'QuickEntry relay');
  const connCfg = path.join(tmp, 'conn.json');
  fs.writeFileSync(connCfg, JSON.stringify({ tallyUrl: `http://localhost:${tPort}`, tallyCompany: 'Al Noor Trading LLC (Demo)', relayUrl: `http://localhost:${rPort}`, connectorKey: 'ck-test' }));

  let r = await runConnector(connCfg);
  assert.equal(r.code, 0, r.out);
  const api = async (method, p, body) => (await fetch(`http://localhost:${rPort}${p}`, { method, headers: { Authorization: 'Bearer ut-test', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })).json();
  const m = await api('GET', '/api/masters?since=0');
  assert.ok(m.ledgers.length > 10 && m.items.length >= 7);
  const cust = m.ledgers.find((l) => l.role === 'customer');
  const txn = { id: '11111111-2222-4333-8444-555555555555', version: 1, type: 'si', number: 'SI-AHM-0001', date: '2026-10-31', partyCode: cust.code, lines: [{ itemCode: m.items[0].code, qty: 3, rate: m.items[0].rate, taxCode: 'SR' }] };
  await api('POST', '/api/txns', { txns: [txn] });
  await api('POST', '/api/txns', { txns: [txn] });
  r = await runConnector(connCfg); assert.equal(r.code, 0, r.out);
  r = await runConnector(connCfg); assert.equal(r.code, 0, r.out);
  const st = await api('POST', '/api/txns/status', { ids: [txn.id] });
  assert.equal(st[0].status, 'synced');
  const day = await (await fetch(`http://localhost:${tPort}/sim/daybook`)).json();
  assert.equal(day.length, 1);
  assert.equal(day[0].party, cust.name);
  const bad = await fetch(`http://localhost:${rPort}/api/masters`, { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(bad.status, 401);
});
