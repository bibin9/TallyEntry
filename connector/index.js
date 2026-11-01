// QuickEntry office connector. Runs on the PC where TallyPrime is open.
// Talks to TallyPrime on localhost:9000 and connects OUT to the cloud relay over HTTPS.
//
//   node connector/index.js [--config connector/config.json] [--once | --check]
//
//   --once   run one sync cycle and exit (exit code 2 on error)
//   --check  test the connection to TallyPrime and to the cloud, print a plain report, exit
//
// On Windows, connector/windows/install.cmd sets it up to start with the PC (see docs/SETUP.md).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connector, CONNECTOR_VERSION } from '../app/core/connector-core.js';
import { ledgersRequest } from '../app/core/tally-xml.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const cfgPath = path.resolve(arg('config', path.join(here, 'config.json')));
if (!fs.existsSync(cfgPath)) {
  console.error(`Missing ${cfgPath}. Copy connector/config.example.json and fill it in.`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')); // Notepad may add a BOM
const near = (f) => path.resolve(path.dirname(cfgPath), f);
// Key order: environment variable, then a key file (the Windows installer writes one that only
// SYSTEM and Administrators can read), then the config file (least preferred).
let key = process.env.QE_CONNECTOR_KEY || '';
if (!key && cfg.keyFile && fs.existsSync(near(cfg.keyFile))) key = fs.readFileSync(near(cfg.keyFile), 'utf8').trim();
if (!key) key = cfg.connectorKey || '';
if (!key) { console.error('No connector key (set QE_CONNECTOR_KEY, keyFile or connectorKey in config).'); process.exit(1); }

const logFile = cfg.logFile ? near(cfg.logFile) : null;
const LOG_MAX = (cfg.logMaxMb || 5) * 1024 * 1024;
const log = (level, msg) => {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
  console.log(line);
  if (!logFile) return;
  try {
    // Keep the log small: when it passes the limit, keep one previous file (connector.log.1).
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX) fs.renameSync(logFile, logFile + '.1');
    fs.appendFileSync(logFile, line + '\n');
  } catch { /* logging must never stop the connector */ }
};

async function tally(xml) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), (cfg.tallyTimeoutSec || 60) * 1000);
  try {
    const r = await fetch(cfg.tallyUrl || 'http://localhost:9000', {
      method: 'POST', body: xml, signal: ctl.signal,
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    });
    return await r.text();
  } finally { clearTimeout(t); }
}

async function call(method, p, body) {
  const r = await fetch(cfg.relayUrl.replace(/\/$/, '') + p, {
    method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Relay ${p}: ${r.status} ${data.error || ''}`);
  return data;
}
const relay = {
  hello: (info) => call('POST', '/api/connector/hello', info),
  saveState: (s) => call('POST', '/api/connector/state', s),
  pushMasters: (b) => call('POST', '/api/connector/masters', b),
  reconcile: (kind, codes) => call('POST', '/api/connector/reconcile', { kind, codes }),
  queue: () => call('GET', '/api/connector/queue'),
  result: (r) => call('POST', '/api/connector/result', r),
};

const connector = new Connector({
  tally, relay, company: cfg.tallyCompany, log,
  conflictPolicy: cfg.conflictPolicy || 'tally-wins', writeCodes: cfg.writeCodesToTally !== false,
});

async function cycle() {
  const r = await connector.runOnce();
  if (r.error) log('warn', r.error);
  else log('info', `cycle ok: ${r.posted.length} transaction(s) processed`);
  return r;
}

async function check() {
  const out = [];
  const ok = (m) => out.push('  OK    ' + m), bad = (m) => out.push('  FAIL  ' + m);
  const tallyUrl = cfg.tallyUrl || 'http://localhost:9000';
  let tallyOk = false;
  try {
    const r = await fetch(tallyUrl, { signal: AbortSignal.timeout(5000) });
    const t = await r.text();
    tallyOk = /Running/i.test(t);
    if (tallyOk) ok(`TallyPrime answers at ${tallyUrl}`);
    else bad(`Something answers at ${tallyUrl} but it does not look like TallyPrime: ${t.slice(0, 80)}`);
  } catch (e) {
    bad(`TallyPrime does not answer at ${tallyUrl}. Is Tally open, with the XML port enabled (F1 > Settings > Connectivity)?`);
  }
  if (tallyOk) {
    try {
      // Ask for ledgers changed after a very high AlterID: proves the company is open, returns almost nothing.
      const t = await tally(ledgersRequest(cfg.tallyCompany, 999999999));
      const err = /<LINEERROR>([^<]*)/i.exec(t);
      if (err) {
        tallyOk = false;
        bad(`Company "${cfg.tallyCompany}" is not open in TallyPrime (${err[1].replace(/&apos;/g, "'")}). Open it in Tally, or fix tallyCompany in the config: it must match exactly.`);
      } else ok(`Company "${cfg.tallyCompany}" is open in TallyPrime`);
    } catch (e) { tallyOk = false; bad(`TallyPrime did not answer a data request: ${e.message}`); }
  }
  try {
    await relay.hello({ version: CONNECTOR_VERSION, tallyOk });
    ok(`Cloud answers at ${cfg.relayUrl} and accepts the connector key`);
  } catch (e) {
    if (/401|403/.test(e.message)) bad(`Cloud at ${cfg.relayUrl} refused the connector key (${e.message})`);
    else bad(`Cannot reach the cloud at ${cfg.relayUrl}: ${e.message}. Check the internet and the relayUrl setting.`);
  }
  console.log(`QuickEntry connector check (version ${CONNECTOR_VERSION})\n` + out.join('\n'));
  return out.every((l) => l.startsWith('  OK'));
}

if (process.argv.includes('--check')) {
  process.exit((await check()) ? 0 : 3);
} else if (process.argv.includes('--once')) {
  const r = await cycle();
  process.exit(r.error ? 2 : 0);
} else {
  // A service must keep running: log unexpected errors instead of exiting.
  process.on('uncaughtException', (e) => log('error', 'uncaught: ' + (e && e.stack || e)));
  process.on('unhandledRejection', (e) => log('error', 'unhandled: ' + (e && e.stack || e)));
  log('info', `QuickEntry connector started. Tally ${cfg.tallyUrl}, company "${cfg.tallyCompany}", relay ${cfg.relayUrl}`);
  const every = (cfg.intervalSec || 30) * 1000;
  const loop = async () => { try { await cycle(); } catch (e) { log('error', e.message); } setTimeout(loop, every); };
  loop();
}
