// HTTP routing for the relay, independent of the HTTP server used.
// auth: { users: token -> {tenant, id, name, code, role}, connectors: key -> tenant }

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
    if (method === 'POST' && op === 'reconcile') return ok(await core.connectorReconcile(tid, body.kind, body.codes));
    if (method === 'GET' && op === 'queue') return ok(await core.connectorQueue(tid));
    if (method === 'POST' && op === 'result') return ok(await core.connectorResult(tid, body));
    return err(404, 'Not found');
  }

  const user = auth.users[token];
  if (!user) return err(401, 'Please sign in again');
  const tid = user.tenant;
  switch (`${method} ${path}`) {
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
    default: return err(404, 'Not found');
  }
}
