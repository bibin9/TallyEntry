// User management for the self-hosted server and demo mode. Same rules as qe_users() in
// relay/supabase/schema.sql. `users` maps sign-in key -> { id, tenant, name, code, role, active, pw? }.
// `sessions` (optional) maps a password sign-in's session key -> user id.

export class UserError extends Error { constructor(m) { super(m); this.status = 400; } }

export function newKey() {
  const b = new Uint8Array(30);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const pub = (u) => ({ id: u.id, name: u.name, code: u.code, role: u.role, active: u.active !== false, hasPassword: !!u.pw });
const BAD_LOGIN = 'Wrong company ID, user code or password';
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function pbkdf2(password, saltHex, iter) {
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, k, 256));
}
export async function hashPassword(password) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, iter: 100000, hash: await pbkdf2(password, salt, 100000) };
}

/** Find the user for a bearer key: a sign-in key, or a session key from a password sign-in. */
export function userForToken(users, sessions, token) {
  if (users[token]) return users[token];
  const id = sessions?.[token];
  return id ? Object.values(users).find((u) => u.id === id) : undefined;
}

/** Company ID + user code + password -> { ok, key, user } or { ok:false, error, locked? }. 5 wrong tries lock for 15 minutes. */
export async function loginOp(users, sessions, body = {}, now = Date.now()) {
  const tid = String(body.company || '').trim().toLowerCase(), code = String(body.code || '').trim().toUpperCase();
  const u = Object.values(users).find((x) => x.tenant === tid && x.code === code);
  if (!u || !u.pw || u.active === false) { await pbkdf2(String(body.password || ''), '00', 100000); return { ok: false, error: BAD_LOGIN }; }
  if (u.lockedUntil > now) {
    const m = Math.max(1, Math.ceil((u.lockedUntil - now) / 60000));
    return { ok: false, locked: true, error: `Too many wrong tries. Try again in ${m} minute${m === 1 ? '' : 's'}, or ask your office admin to reset your password.` };
  }
  const right = (await pbkdf2(String(body.password || ''), u.pw.salt, u.pw.iter)) === u.pw.hash;
  if (u.lockedUntil > Date.now()) return { ok: false, locked: true, error: 'Too many wrong tries. Try again in 15 minutes, or ask your office admin to reset your password.' }; // locked while checking
  if (!right) {
    u.pwFailed = (u.pwFailed || 0) + 1;
    if (u.pwFailed >= 5) {
      u.pwFailed = 0; u.lockedUntil = now + 15 * 60000;
      return { ok: false, locked: true, error: 'Too many wrong tries. Try again in 15 minutes, or ask your office admin to reset your password.' };
    }
    return { ok: false, error: BAD_LOGIN };
  }
  u.pwFailed = 0; delete u.lockedUntil;
  const key = newKey();
  sessions[key] = u.id;
  return { ok: true, key, user: { id: u.id, name: u.name, code: u.code, role: u.role, tenant: u.tenant } };
}

const endSessions = (sessions, id) => { for (const [k, v] of Object.entries(sessions || {})) if (v === id) delete sessions[k]; };

/** callerId: the signed-in admin's id, or null for the owner. Returns the API result. */
export async function usersOp(users, tid, callerId, op, body = {}, sessions = {}) {
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
    endSessions(sessions, u.id);
    return { id: u.id, key };
  }
  if (op === 'users.setpassword') {
    const pw = String(body.password || '');
    if (pw.length < 6 || pw.length > 72) throw new UserError('Password must be 6 to 72 characters');
    u.pw = await hashPassword(pw); u.pwFailed = 0; delete u.lockedUntil;
    endSessions(sessions, u.id);
    return { id: u.id, company: tid, code: u.code, hasPassword: true };
  }
  throw new UserError('Unknown operation');
}
