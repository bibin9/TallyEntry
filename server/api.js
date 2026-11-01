// QuickEntry sync API for /api/*. Used by the Cloudflare Worker (worker/index.js) and the
// Cloudflare Pages Function (functions/api/[[path]].js); both call handleApi().
// It authenticates nothing itself: it hashes the bearer key and passes it to the qe_api()
// database function in Supabase, which checks it and enforces tenant isolation.
//
// Environment variables (Cloudflare > your project > Settings > Variables and secrets, as Secrets):
//   SUPABASE_URL               e.g. https://abcd1234.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  service role key (never put this in the app)
//   ALLOWED_ORIGIN             optional, defaults to the same origin only
//   ALLOW_ANY_SUPABASE_URL     optional; set to 1 if Supabase uses a custom domain
//   OWNER_KEY                  optional; a long random key that unlocks /owner.html (create companies)

import { defaultSettings } from '../app/core/defaults.js';

const ROUTES = {
  'GET /api/me': 'me',
  'GET /api/settings': 'settings.get',
  'PUT /api/settings': 'settings.put',
  'GET /api/masters': 'masters',
  'POST /api/txns': 'txns.push',
  'POST /api/txns/status': 'txns.status',
  'POST /api/txns/retry': 'txns.retry',
  'POST /api/txns/resolve': 'txns.resolve',
  'GET /api/log': 'log',
  'GET /api/connector-status': 'connectorinfo',
  'POST /api/connector/hello': 'connector.hello',
  'POST /api/connector/state': 'connector.state',
  'POST /api/connector/masters': 'connector.masters',
  'POST /api/connector/reconcile': 'connector.reconcile',
  'GET /api/connector/queue': 'connector.queue',
  'POST /api/connector/result': 'connector.result',
  // company admin: manage the company's users
  'GET /api/users': 'users.list',
  'POST /api/users': 'users.add',
  'POST /api/users/update': 'users.update',
  'POST /api/users/resetkey': 'users.resetkey',
  // owner (OWNER_KEY): manage client companies
  'GET /api/owner/tenants': 'owner.tenants',
  'POST /api/owner/tenants': 'owner.tenant.create',
  'POST /api/owner/connectorkey': 'owner.tenant.connectorkey',
  'GET /api/owner/users': 'owner.users.list',
  'POST /api/owner/users': 'owner.users.add',
  'POST /api/owner/users/update': 'owner.users.update',
  'POST /api/owner/users/resetkey': 'owner.users.resetkey',
};
const STATUS = { '28000': 401, '42501': 403, '22023': 400 };

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function handleApi(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: 'Server not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY as secrets' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  const url = new URL(request.url);
  const cors = {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || url.origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const op = ROUTES[`${request.method} ${url.pathname.replace(/\/$/, '')}`];
  if (!op) return json(404, { error: 'Not found' });
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Please sign in again' });

  let body = {};
  if (request.method === 'GET') body = Object.fromEntries(url.searchParams);
  else {
    const text = await request.text();
    if (text.length > 20e6) return json(413, { error: 'Too large' });
    try { body = text ? JSON.parse(text) : {}; } catch { return json(400, { error: 'Bad JSON' }); }
  }

  // Owner operations are checked here against the OWNER_KEY secret and sent with no user key;
  // everything else is checked by the database against the key's hash.
  let tokenHash;
  if (op.startsWith('owner.')) {
    if (!env.OWNER_KEY || env.OWNER_KEY.length < 24) return json(404, { error: 'Owner access is not set up: add an OWNER_KEY secret (at least 24 characters)' });
    if ((await sha256(token)) !== (await sha256(env.OWNER_KEY))) return json(401, { error: 'Wrong owner key' });
    tokenHash = null;
    if (op === 'owner.tenant.create' && body && typeof body === 'object' && !body.settings) body.settings = defaultSettings(String(body.name || ''));
  } else {
    tokenHash = await sha256(token);
  }

  // Supabase accepts either the legacy service_role key (a JWT, also sent as Bearer) or a new
  // secret key (sb_secret_..., not a JWT: send it only as apikey).
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const base = env.SUPABASE_URL.trim().replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(base) && !env.ALLOW_ANY_SUPABASE_URL) {
    return json(500, { error: 'Server setup: SUPABASE_URL must look like https://<project-ref>.supabase.co (not the dashboard link)' });
  }
  let r;
  try {
    r = await fetch(`${base}/rest/v1/rpc/qe_api`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_token_hash: tokenHash, p_op: op, p_body: body }),
    });
  } catch (e) {
    console.error('Supabase unreachable', e);
    return json(502, { error: 'Server setup: cannot reach Supabase at SUPABASE_URL' });
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const code = data?.code;
    if (STATUS[code]) return json(STATUS[code], { error: data.message });
    // Other data errors (for example text where a number belongs) are the caller's fault, not a server error.
    if (typeof code === 'string' && code.startsWith('22')) return json(400, { error: 'Invalid input' });
    console.error('Supabase error', r.status, JSON.stringify(data));
    // Name the setup problem without echoing anything secret.
    let why = 'Server error';
    if (!data) why = `Server setup: SUPABASE_URL did not answer like Supabase (HTTP ${r.status})`;
    else if (r.status === 401 || r.status === 403) why = 'Server setup: Supabase rejected SUPABASE_SERVICE_ROLE_KEY (use the secret or service_role key, not the publishable/anon key)';
    else if (code === 'PGRST202' || r.status === 404) why = 'Server setup: database function qe_api not found (run relay/supabase/schema.sql in Supabase)';
    return json(500, { error: why });
  }
  return json(200, data);
}
