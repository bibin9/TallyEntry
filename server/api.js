// QuickEntry sync API for /api/*. Used by the Cloudflare Worker (worker/index.js) and the
// Cloudflare Pages Function (functions/api/[[path]].js); both call handleApi().
// It authenticates nothing itself: it hashes the bearer key and passes it to the qe_api()
// database function in Supabase, which checks it and enforces tenant isolation.
//
// Environment variables (Cloudflare > your project > Settings > Variables and secrets, as Secrets):
//   SUPABASE_URL               e.g. https://abcd1234.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  service role key (never put this in the app)
//   ALLOWED_ORIGIN             optional, defaults to the same origin only

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

  // Supabase accepts either the legacy service_role key (a JWT, also sent as Bearer) or a new
  // secret key (sb_secret_..., not a JWT: send it only as apikey).
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const r = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/qe_api`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_token_hash: await sha256(token), p_op: op, p_body: body }),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const code = data?.code;
    return json(STATUS[code] || 500, { error: STATUS[code] ? data.message : 'Server error' });
  }
  return json(200, data);
}
