// Local stand-in for Cloudflare Pages + Supabase, for testing the production code path:
//   * serves app/ like Cloudflare Pages
//   * runs functions/api/[[path]].js for /api/*
//   * answers /rest/v1/rpc/qe_api like Supabase's PostgREST, using a real Postgres
//   QE_PG_URL=... node tests/cf-local.mjs --port 8790
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { onRequest } from '../functions/api/[[path]].js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1] || 8790);
const pool = new pg.Pool({ connectionString: process.env.QE_PG_URL });
const SERVICE_KEY = 'local-service-key';
const env = { SUPABASE_URL: `http://localhost:${PORT}`, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let raw = ''; for await (const c of req) raw += c;
  if (url.pathname === '/rest/v1/rpc/qe_api') {
    if (req.headers.apikey !== SERVICE_KEY) { res.writeHead(401); return res.end('{"message":"bad key"}'); }
    const { p_token_hash, p_op, p_body } = JSON.parse(raw);
    try {
      const r = await pool.query('select qe_api($1,$2,$3::jsonb) as r', [p_token_hash, p_op, JSON.stringify(p_body)]);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r.rows[0].r));
    } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ code: e.code, message: e.message })); }
  }
  if (url.pathname.startsWith('/api/')) {
    const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw });
    const r = await onRequest({ request, env });
    res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(await r.text());
  }
  let p = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const f = path.join(root, 'app', p);
  if (!f.startsWith(path.join(root, 'app')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`cf-local on http://localhost:${PORT}`));
