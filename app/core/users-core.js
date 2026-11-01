// User management for the self-hosted server and demo mode. Same rules as qe_users() in
// relay/supabase/schema.sql. `users` maps sign-in key -> { id, tenant, name, code, role, active }.

export class UserError extends Error { constructor(m) { super(m); this.status = 400; } }

export function newKey() {
  const b = new Uint8Array(30);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const pub = (u) => ({ id: u.id, name: u.name, code: u.code, role: u.role, active: u.active !== false });

/** callerId: the signed-in admin's id, or null for the owner. Returns the API result. */
export function usersOp(users, tid, callerId, op, body = {}) {
  const mine = () => Object.entries(users).filter(([, u]) => u.tenant === tid);
  if (op === 'users.list') {
    return mine().map(([, u]) => pub(u)).sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
  }
  if (op === 'users.add') {
    const name = String(body.name || '').trim(), code = String(body.code || '').trim().toUpperCase(), role = body.role || 'sales';
    if (!name) throw new UserError('Enter a name');
    if (!/^[A-Z0-9]{2,6}$/.test(code)) throw new UserError('Code must be 2 to 6 letters or digits, for example AHM');
    if (!['sales', 'admin'].includes(role)) throw new UserError('Role must be sales or admin');
    if (mine().some(([, u]) => u.code === code)) throw new UserError(`Code ${code} is already used in this company`);
    const u = { id: `${tid}-${code.toLowerCase()}`, tenant: tid, name, code, role, active: true };
    const key = newKey();
    users[key] = u;
    return { ...pub(u), key };
  }
  const found = mine().find(([, u]) => u.id === body.id);
  if (!found) throw new UserError('User not found');
  const [oldKey, u] = found;
  if (op === 'users.update') {
    const role = body.role || u.role;
    if (!['sales', 'admin'].includes(role)) throw new UserError('Role must be sales or admin');
    if (u.id === callerId && (role !== 'admin' || body.active === false)) throw new UserError('You cannot switch off or demote yourself');
    const next = { ...u, name: String(body.name || '').trim() || u.name, role, active: body.active === undefined ? u.active !== false : !!body.active };
    const after = mine().map(([, x]) => (x.id === u.id ? next : x));
    if (!after.some((x) => x.role === 'admin' && x.active !== false)) throw new UserError('A company needs at least one active admin');
    users[oldKey] = next;
    return pub(next);
  }
  if (op === 'users.resetkey') {
    const key = newKey();
    delete users[oldKey];
    users[key] = u;
    return { id: u.id, key };
  }
  throw new UserError('Unknown operation');
}
