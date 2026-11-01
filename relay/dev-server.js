// QuickEntry relay: self-hosted Node server (no dependencies).
// Serves the PWA from ../app and the sync API under /api. Stores data in a JSON file.
// Good for development, the pilot, or a small single-server install. The managed
// production option (Netlify + Supabase) is described in docs/SETUP.md.
//
//   node relay/dev-server.js [--port 8787] [--config relay/config.json] [--data relay/data/state.json]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RelayCore } from '../app/core/relay-core.js';
import { handleApi } from '../app/core/relay-api.js';
import { defaultSettings } from '../app/core/defaults.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', process.env.PORT || 8787));
const CONFIG = path.resolve(arg('config', path.join(here, 'config.json')));
const DATA = path.resolve(arg('data', path.join(here, 'data', 'state.json')));
const APP = path.resolve(here, '..', 'app');

// ---- config: tenants, users (sign-in tokens) and connector keys
if (!fs.existsSync(CONFIG)) {
  const tok = () => crypto.randomBytes(18).toString('base64url');
  const sample = {
    tenants: {
      'al-noor': {
        name: 'Al Noor Trading LLC',
        connectorKey: tok(),
        users: [
          { id: 'u-admin', name: 'Office Admin', code: 'ADM', role: 'admin', token: tok() },
          { id: 'u-ahmed', name: 'Ahmed (Sales)', code: 'AHM', role: 'sales', token: tok() },
        ],
      },
    },
  };
  fs.writeFileSync(CONFIG, JSON.stringify(sample, null, 2));
  console.log(`Created ${CONFIG} with new random keys. Keep this file private.`);
}
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const auth = { users: {}, connectors: {} };
for (const [tid, t] of Object.entries(config.tenants)) {
  auth.connectors[t.connectorKey] = tid;
  for (const u of t.users) auth.users[u.token] = { ...u, tenant: tid };
}

// ---- state with atomic, debounced writes
fs.mkdirSync(path.dirname(DATA), { recursive: true });
const state = fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, 'utf8')) : null;
let timer = null;
const persist = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const tmp = DATA + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(core.s));
    fs.renameSync(tmp, DATA);
  }, 200);
};
const core = new RelayCore(state, persist);
for (const [tid, t] of Object.entries(config.tenants)) {
  const ten = core.tenant(tid);
  ten.name = t.name;
  if (!ten.settings) ten.settings = defaultSettings(t.name);
}
persist();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (url.pathname.startsWith('/api/')) {
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 20e6) { res.writeHead(413); return res.end(); } }
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400); return res.end('{"error":"bad json"}'); }
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    try {
      const out = await handleApi(core, auth, { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, token });
      res.writeHead(out.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out.data ?? null));
    } catch (e) {
      console.error(e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // static app
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!p) p = 'index.html';
  const file = path.join(APP, p);
  if (!file.startsWith(APP) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': p === 'sw.js' ? 'no-cache' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`QuickEntry relay on http://localhost:${PORT}  (app + /api)`);
  console.log(`Config: ${CONFIG}\nData:   ${DATA}`);
});
