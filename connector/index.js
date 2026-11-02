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
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
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
// The cloud is only served over HTTPS; a typed http:// address would fail with "fetch failed".
if (/^http:\/\//i.test(cfg.relayUrl || '') && !/^http:\/\/(localhost|127\.|\[::1\])/i.test(cfg.relayUrl)) cfg.relayUrl = 'https://' + cfg.relayUrl.slice(7);
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

// Node only says "fetch failed"; the real reason (DNS, firewall, proxy, certificate) is in e.cause.
function netReason(e) {
  const c = e && e.cause;
  if (!c) return e.message;
  const code = c.code || (c.errors && c.errors[0] && c.errors[0].code) || '';
  const hint = /ENOTFOUND|EAI_AGAIN/.test(code) ? 'the name could not be found (DNS or no internet)'
    : /ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/.test(code) ? 'the connection was blocked or timed out (firewall, antivirus or proxy)'
    : /CERT|SSL|TLS/i.test(code + c.message) ? 'the secure connection was rejected (antivirus or proxy inspecting HTTPS, or the PC clock is wrong)'
    : '';
  return `${e.message}: ${code || c.message}${hint ? ' - ' + hint : ''}`;
}

async function call(method, p, body) {
  let r;
  try {
    r = await fetch(cfg.relayUrl.replace(/\/$/, '') + p, {
      method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) { throw new Error(netReason(e)); }
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

// Cloud unreachable: write the step-by-step network test to the log, at most every 10 minutes.
let lastDiag = 0;
async function diagIfNetwork(msg) {
  if (!/fetch failed/i.test(msg || '') || Date.now() - lastDiag < 600000) return;
  lastDiag = Date.now();
  try { for (const l of await netDiagnose()) log('info', 'net: ' + l.trim()); } catch { }
}

async function cycle() {
  const r = await connector.runOnce();
  if (r.error) { log('warn', r.error); await diagIfNetwork(r.error); }
  else log('info', `cycle ok: ${r.posted.length} transaction(s) processed`);
  return r;
}

// Step-by-step network test, so a failure says exactly where it stops: DNS, TCP, TLS or HTTP.
async function netDiagnose() {
  const lines = [], info = (m) => lines.push('  INFO  ' + m), bad = (m) => lines.push('  FAIL  ' + m);
  const u = new URL(cfg.relayUrl);
  const host = u.hostname, port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const sysCa = process.execArgv.includes('--use-system-ca') || /--use-system-ca/.test(process.env.NODE_OPTIONS || '');
  info(`Node.js ${process.version} on ${process.platform} ${process.arch}; Windows certificate store ${sysCa ? 'ON (--use-system-ca)' : 'OFF'}`);
  const proxies = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED']
    .filter((k) => process.env[k]).map((k) => `${k}=${String(process.env[k]).slice(0, 120)}`);
  info('Proxy/TLS environment: ' + (proxies.length ? proxies.join(' ') : 'none set'));
  if (process.platform === 'win32') {
    try {
      const w = execFileSync('netsh', ['winhttp', 'show', 'proxy'], { timeout: 5000, encoding: 'utf8' });
      info('Windows proxy (netsh winhttp): ' + w.replace(/\s+/g, ' ').replace(/^.*?Current WinHTTP proxy settings:\s*/i, '').trim());
    } catch (e) { info('Windows proxy: could not read (' + (e.code || e.message) + ')'); }
  }
  let addrs = [];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
    info(`DNS ${host} -> ${addrs.map((a) => a.address).join(', ')}`);
  } catch (e) { bad(`DNS lookup of ${host} failed: ${e.code || e.message} (DNS blocked or no internet)`); return lines; }
  const tcp = await new Promise((res) => {
    const t0 = Date.now(), sock = net.connect({ host, port, timeout: 8000 });
    sock.once('connect', () => { sock.destroy(); res({ ok: true, ms: Date.now() - t0 }); });
    sock.once('timeout', () => { sock.destroy(); res({ ok: false, err: 'ETIMEDOUT' }); });
    sock.once('error', (e) => res({ ok: false, err: e.code || e.message }));
  });
  if (!tcp.ok) { bad(`TCP connect to ${host}:${port} failed: ${tcp.err} (firewall, antivirus or network blocks node.exe)`); return lines; }
  info(`TCP connect to ${host}:${port} OK in ${tcp.ms} ms`);
  if (u.protocol === 'https:') {
    const t = await new Promise((res) => {
      const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 8000 });
      sock.once('secureConnect', () => {
        const c = sock.getPeerCertificate() || {};
        res({ ok: sock.authorized, why: sock.authorizationError, subject: c.subject && c.subject.CN, issuer: c.issuer && (c.issuer.O || c.issuer.CN), to: c.valid_to, proto: sock.getProtocol() });
        sock.destroy();
      });
      sock.once('timeout', () => { sock.destroy(); res({ err: 'ETIMEDOUT' }); });
      sock.once('error', (e) => res({ err: e.code || e.message }));
    });
    if (t.err) { bad(`TLS handshake with ${host} failed: ${t.err} (something on the network interrupts HTTPS)`); return lines; }
    const certTxt = `certificate for ${t.subject || '?'} issued by "${t.issuer || '?'}", valid to ${t.to || '?'}, ${t.proto || ''}`;
    if (t.ok) info(`TLS OK: ${certTxt}`);
    else bad(`TLS certificate not trusted (${t.why}): ${certTxt}. If the issuer is your antivirus or a company proxy, install.cmd uses --use-system-ca so Node.js trusts it; otherwise turn off HTTPS scanning for node.exe.`);
    info(`PC clock: ${new Date().toISOString()} (a wrong date breaks certificates)`);
  }
  try {
    const r = await fetch(cfg.relayUrl.replace(/\/$/, '') + '/api/me', { signal: AbortSignal.timeout(10000) });
    info(`HTTP GET /api/me -> ${r.status} (401 here is normal: it means the cloud answers)`);
  } catch (e) { bad(`HTTP request failed: ${netReason(e)}`); }
  return lines;
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
  if (out.some((l) => l.includes('cloud')) && (out.some((l) => l.startsWith('  FAIL') && l.includes('cloud')) || process.argv.includes('--debug'))) {
    out.push('', 'Network details (send this to support):');
    try { out.push(...await netDiagnose()); } catch (e) { out.push('  FAIL  network test crashed: ' + e.message); }
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
  log('info', `QuickEntry connector started. Tally ${cfg.tallyUrl}, company "${cfg.tallyCompany}", relay ${cfg.relayUrl} (Node.js ${process.version}${process.execArgv.includes('--use-system-ca') ? ', Windows certificates ON' : ''})`);
  const every = (cfg.intervalSec || 30) * 1000;
  const loop = async () => {
    try { await cycle(); } catch (e) { log('error', e.message); await diagIfNetwork(e.message); }
    setTimeout(loop, every);
  };
  loop();
}
