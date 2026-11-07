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
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connector, CONNECTOR_VERSION } from '../app/core/connector-core.js';
import { ledgersRequest } from '../app/core/tally-xml.js';
import { decodeTally, encodeTally } from '../app/core/tally-codec.js';

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
// Keys only ever use A-Z a-z 0-9 - _. A paste can bring in hidden characters (Ctrl+V in some
// consoles types a control character, chat apps add zero-width spaces), and Node then refuses
// to send the header at all (ERR_INVALID_CHAR). Drop anything that cannot be part of a key.
const rawKeyLen = key.length;
key = key.replace(/[^A-Za-z0-9_-]/g, '');
const keyStripped = rawKeyLen - key.length;
if (!key) { console.error('The saved connector key is not a key (often Ctrl+V was pressed at the hidden prompt, which types one invisible character). Run install.cmd -NewKey and RIGHT-CLICK to paste the key.'); process.exit(1); }

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
const keyNote = () => `${key.length} characters, ending ...${key.slice(-4)}` + (keyStripped ? `; ${keyStripped} hidden or invalid character(s) from the paste were removed` : '');
if (keyStripped && !process.argv.includes('--check')) log('warn', `Connector key: ${keyNote()}`);

// HTTP with node:http/https and a hard time limit. (fetch() is not used: on one client PC with
// Node.js 26 and the Windows certificate store, a fetch never settled and the process just ended.)
// The timer is a normal (ref'd) timer, so a stalled request always ends with an error.
function httpRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    let u;
    try { u = new URL(url); } catch { reject(Object.assign(new Error(`Invalid address ${url}`), { code: 'EINVALIDURL' })); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body === undefined ? undefined : Buffer.from(body);
    const req = lib.request(u, { method, headers: { ...headers, ...(data ? { 'Content-Length': data.length } : {}) }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); finish(resolve, { status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, buf, text: buf.toString('utf8') }); });
      res.on('error', (e) => finish(reject, e));
    });
    const timer = setTimeout(() => {
      const e = Object.assign(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' });
      req.destroy(e); finish(reject, e);
    }, timeoutMs);
    req.on('error', (e) => finish(reject, e));
    if (data) req.write(data);
    req.end();
  });
}

// Tally may answer in UTF-8, UTF-16 or Windows-1252 (see tally-codec.js). Requests are sent in
// the encoding of the last answer, so names with special characters match in Tally.
let tallyCharset = 'utf-8';
async function tally(xml) {
  const r = await httpRequest(cfg.tallyUrl || 'http://localhost:9000', {
    method: 'POST', body: encodeTally(xml, tallyCharset), timeoutMs: (cfg.tallyTimeoutSec || 60) * 1000,
    headers: { 'Content-Type': `text/xml; charset=${tallyCharset === 'windows-1252' ? 'windows-1252' : 'utf-8'}` },
  });
  const d = decodeTally(r.buf);
  if (d.charset !== tallyCharset && d.charset !== 'utf-8') tallyCharset = d.charset === 'utf-16le' ? 'utf-8' : d.charset;
  return d.text;
}

// Turn a network error into a plain reason: DNS, firewall, proxy, certificate or time-out.
function netReason(e) {
  const c = (e && e.cause) || e || {};
  const code = c.code || (c.errors && c.errors[0] && c.errors[0].code) || '';
  const hint = /ENOTFOUND|EAI_AGAIN/.test(code) ? 'the name could not be found (DNS or no internet)'
    : /ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|EPIPE/.test(code) ? 'the connection was blocked or timed out (firewall, antivirus or proxy)'
    : /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO/i.test(code + ' ' + (c.message || '')) ? 'the secure connection was rejected (antivirus or proxy inspecting HTTPS, or the PC clock is wrong)'
    : /ERR_INVALID_CHAR/.test(code) ? 'the connector key contains a character that cannot be sent; run install.cmd -NewKey and paste the key again'
    : '';
  const what = c === e ? e.message : `${e.message}: ${c.message}`;
  return `${code ? code + ' ' : ''}${what}${hint ? ' - ' + hint : ''}`;
}

async function call(method, p, body) {
  let r;
  try {
    r = await httpRequest(cfg.relayUrl.replace(/\/$/, '') + p, {
      method, timeoutMs: (cfg.relayTimeoutSec || 60) * 1000,
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) { throw new Error('Cloud not reachable: ' + netReason(e)); }
  let data = {};
  try { data = JSON.parse(r.text); } catch { }
  if (!r.ok) throw new Error(`Relay ${p}: ${r.status} ${data.error || ''}`);
  return data;
}
const relay = {
  hello: (info) => call('POST', '/api/connector/hello', info),
  saveState: (s) => call('POST', '/api/connector/state', s),
  pushMasters: (b) => call('POST', '/api/connector/masters', b),
  pushBalances: (b) => call('POST', '/api/connector/balances', b),
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
  if (!/Cloud not reachable|fetch failed/i.test(msg || '') || Date.now() - lastDiag < 600000) return;
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
    addrs = await withLimit(dns.promises.lookup(host, { all: true }), 10000, 'DNS lookup');
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
    const r = await httpRequest(cfg.relayUrl.replace(/\/$/, '') + '/api/me', { timeoutMs: 15000 });
    info(`HTTP GET /api/me -> ${r.status} (401 here is normal: it means the cloud answers)`);
  } catch (e) { bad(`HTTP request failed: ${netReason(e)}`); }
  return lines;
}

// Run one step with a hard time limit, so a step that never settles is reported, not left hanging.
function withLimit(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${what}: no answer within ${Math.round(ms / 1000)} s`), { code: 'ETIMEDOUT' })), ms); })])
    .finally(() => clearTimeout(t));
}

async function check() {
  // Each line is printed as soon as it is known, so even a stop part-way shows how far it got.
  const lines = [];
  const say = (l) => { lines.push(l); console.log(l); };
  const ok = (m) => say('  OK    ' + m), bad = (m) => say('  FAIL  ' + m), step = (m) => console.log('  ...   ' + m);
  console.log(`QuickEntry connector check (version ${CONNECTOR_VERSION}, Node.js ${process.version}${process.execArgv.includes('--use-system-ca') ? ', Windows certificates ON' : ''})`);
  const tallyUrl = cfg.tallyUrl || 'http://localhost:9000';
  let tallyOk = false;
  step(`Testing TallyPrime at ${tallyUrl}`);
  try {
    const r = await withLimit(httpRequest(tallyUrl, { timeoutMs: 8000 }), 10000, 'TallyPrime');
    tallyOk = /Running/i.test(r.text);
    if (tallyOk) ok(`TallyPrime answers at ${tallyUrl}`);
    else bad(`Something answers at ${tallyUrl} but it does not look like TallyPrime: ${r.text.slice(0, 80)}`);
  } catch (e) {
    bad(`TallyPrime does not answer at ${tallyUrl} (${netReason(e)}). Is Tally open, with the XML port enabled (F1 > Settings > Connectivity)?`);
  }
  if (tallyOk) {
    step(`Testing company "${cfg.tallyCompany}"`);
    try {
      // Ask for ledgers changed after a very high AlterID: proves the company is open, returns almost nothing.
      const t = await withLimit(tally(ledgersRequest(cfg.tallyCompany, 999999999)), 65000, 'TallyPrime data request');
      const err = /<LINEERROR>([^<]*)/i.exec(t);
      if (err) {
        tallyOk = false;
        bad(`Company "${cfg.tallyCompany}" is not open in TallyPrime (${err[1].replace(/&apos;/g, "'")}). Open it in Tally, or fix tallyCompany in the config: it must match exactly.`);
      } else ok(`Company "${cfg.tallyCompany}" is open in TallyPrime`);
    } catch (e) { tallyOk = false; bad(`TallyPrime did not answer a data request: ${netReason(e)}`); }
  }
  if (key.length < 20) bad(`The saved connector key is too short to be a key (${keyNote()}). Run install.cmd -NewKey and RIGHT-CLICK to paste the key (Ctrl+V does not paste in that prompt).`);
  else say(`  INFO  Connector key: ${keyNote()}`);
  step(`Testing the cloud at ${cfg.relayUrl}`);
  let cloudOk = false;
  try {
    await withLimit(relay.hello({ version: CONNECTOR_VERSION, tallyOk }), 70000, 'Cloud');
    cloudOk = true;
    ok(`Cloud answers at ${cfg.relayUrl} and accepts the connector key`);
  } catch (e) {
    if (/ 401| 403/.test(e.message)) bad(`Cloud at ${cfg.relayUrl} refused the connector key (${e.message}). Paste the key again with install.cmd -NewKey (right-click to paste, or type it).`);
    else bad(`Cannot reach the cloud at ${cfg.relayUrl}: ${e.message}. Check the internet and the relayUrl setting.`);
  }
  if (!cloudOk || process.argv.includes('--debug')) {
    say('');
    say('Network details (send this to support):');
    try { for (const l of await withLimit(netDiagnose(), 60000, 'Network test')) say(l); }
    catch (e) { bad('network test stopped: ' + e.message); }
  }
  if (process.argv.includes('--debug')) {
    // Root-cause aid: the same two requests made with fetch(), which older versions used. If fetch
    // fails or never settles where the lines above are OK, the problem is fetch on this PC.
    say('');
    say('fetch() comparison (diagnostic only):');
    for (const [what, url] of [['TallyPrime', tallyUrl], ['Cloud', cfg.relayUrl.replace(/\/$/, '') + '/api/me']]) {
      const t0 = Date.now();
      const settled = fetch(url, { signal: AbortSignal.timeout(15000) }).then((r) => `answered HTTP ${r.status}`, (e) => `failed: ${netReason(e)}`);
      const r = await Promise.race([settled, new Promise((res) => setTimeout(() => res(null), 25000))]);
      say(`  INFO  fetch ${what}: ${r ? r : 'DID NOT SETTLE within 25 s; open handles: ' + process.getActiveResourcesInfo().join(', ')} (${Date.now() - t0} ms)`);
    }
  }
  const allOk = lines.every((l) => !l.startsWith('  FAIL'));
  console.log(allOk ? 'RESULT: everything OK' : 'RESULT: a problem was found (see the FAIL lines above)');
  return allOk;
}

if (process.argv.includes('--check')) {
  // Last line of defence: whatever happens, the check ends with a clear result.
  const watchdog = setTimeout(() => { console.log('  FAIL  The test did not finish within 4 minutes. Send this screen to support.\nRESULT: a problem was found'); process.exit(3); }, 240000);
  let good = false;
  try { good = await check(); } catch (e) { console.log('  FAIL  The test stopped: ' + (e && e.stack || e) + '\nRESULT: a problem was found'); }
  clearTimeout(watchdog);
  process.exit(good ? 0 : 3);
} else if (process.argv.includes('--once')) {
  let r = { error: 'not run' };
  try { r = await withLimit(cycle(), (cfg.cycleLimitMin || 15) * 60000, 'Sync cycle'); } catch (e) { log('error', e.message); }
  process.exit(r.error ? 2 : 0);
} else {
  // A service must keep running: log unexpected errors instead of exiting.
  process.on('uncaughtException', (e) => log('error', 'uncaught: ' + (e && e.stack || e)));
  process.on('unhandledRejection', (e) => log('error', 'unhandled: ' + (e && e.stack || e)));
  log('info', `QuickEntry connector started. Tally ${cfg.tallyUrl}, company "${cfg.tallyCompany}", relay ${cfg.relayUrl} (Node.js ${process.version}${process.execArgv.includes('--use-system-ca') ? ', Windows certificates ON' : ''})`);
  const every = (cfg.intervalSec || 30) * 1000;
  const loop = async () => {
    try { await withLimit(cycle(), (cfg.cycleLimitMin || 15) * 60000, 'Sync cycle'); }
    catch (e) { log('error', e.message); connector.running = false; await diagIfNetwork(e.message).catch(() => {}); }
    setTimeout(loop, every);
  };
  // Keep the process alive even if some request stops without settling.
  setInterval(() => {}, 1 << 30);
  loop();
}
