// HTTP routing for the relay, independent of the HTTP server used.
// auth: { users: token -> {tenant, id, name, code, role, active}, connectors: key -> tenant, save?() }
import { usersOp, loginOp, userForToken } from './users-core.js';

export async function handleApi(core, auth, { method, path, query = {}, body = {}, token }) {
  const ok = (data) => ({ status: 200, data });
  const err = (status, message) => ({ status, data: { error: message } });

  if (path.startsWith('/api/connector/')) {
    const tid = auth.connectors[token];
    if (!tid) return err(401, 'Invalid connector key');
    const op = path.slice('/api/connector/'.length);
    if (method === 'POST' && op === 'hello') return ok(await core.connectorHello(tid, body));
    if (method === 'POST' && op === 'state') { await core.connectorSaveState(tid, body); return ok({ ok: true }); }
    if (method === 'POST' && op === 'masters') return ok(await core.connectorPushMasters(tid, body));
    if (method === 'POST' && op === 'balances') return ok(await core.connectorPushBalances(tid, body));
    if (method === 'POST' && op === 'reconcile') return ok(await core.connectorReconcile(tid, body.kind, body.codes));
    if (method === 'GET' && op === 'queue') return ok(await core.connectorQueue(tid));
    if (method === 'POST' && op === 'result') return ok(await core.connectorResult(tid, body));
    return err(404, 'Not found');
  }

  if (path.startsWith('/api/owner/')) return err(404, 'Owner screens need the Cloudflare + Supabase setup');
  auth.sessions ||= {};
  if (method === 'POST' && path === '/api/login') {
    const r = await loginOp(auth.users, auth.sessions, body);
    await auth.save?.();
    return r.ok ? ok(r) : err(r.locked ? 429 : 401, r.error);
  }
  const user = userForToken(auth.users, auth.sessions, token);
  if (!user || user.active === false) return err(401, 'Please sign in again');
  const tid = user.tenant;
  switch (`${method} ${path}`) {
    case 'POST /api/logout': if (auth.sessions[token]) { delete auth.sessions[token]; await auth.save?.(); } return ok({ ok: true });
    case 'GET /api/archive':
      if (user.role !== 'admin') return err(403, 'Only an office admin can open the archive');
      return ok(await core.getArchive(tid, query.q));
    case 'GET /api/sync-check':
      if (user.role !== 'admin') return err(403, 'Only an office admin can see the sync check');
      return ok(await core.getSummary(tid, Object.fromEntries(Object.values(auth.users).map((u) => [u.id, u.name]))));
    case 'GET /api/me': return ok({ id: user.id, name: user.name, code: user.code, role: user.role, tenant: tid });
    case 'GET /api/settings': return ok(await core.getSettings(tid));
    case 'PUT /api/settings':
      if (user.role !== 'admin') return err(403, 'Only an office admin can change settings');
      return ok(await core.putSettings(tid, body));
    case 'GET /api/masters': return ok(await core.getMasters(tid, Number(query.since) || 0));
    case 'POST /api/txns': return ok(await core.pushTransactions(tid, user.id, body.txns || []));
    case 'POST /api/txns/status': return ok(await core.getStatuses(tid, body.ids || []));
    case 'POST /api/txns/retry': return ok(await core.retry(tid, body.ids || []));
    case 'POST /api/txns/resolve':
      if (user.role !== 'admin') return err(403, 'Only an office admin can resolve conflicts');
      return ok(await core.resolveConflict(tid, body.id, body.choice));
    case 'GET /api/log': return ok(await core.getLog(tid));
    case 'GET /api/connector-status': return ok(await core.connectorStatus(tid));
    case 'GET /api/users': case 'POST /api/users': case 'POST /api/users/update': case 'POST /api/users/resetkey': case 'POST /api/users/password': {
      if (user.role !== 'admin') return err(403, 'Only an office admin can manage users');
      const op = { 'GET /api/users': 'users.list', 'POST /api/users': 'users.add', 'POST /api/users/update': 'users.update', 'POST /api/users/resetkey': 'users.resetkey', 'POST /api/users/password': 'users.setpassword' }[`${method} ${path}`];
      try {
        const r = await usersOp(auth.users, tid, user.id, op, body, auth.sessions);
        if (op !== 'users.list') await auth.save?.();
        return ok(r);
      } catch (e) { if (e.status) return err(e.status, e.message); throw e; }
    }
    default: return err(404, 'Not found');
  }
}
