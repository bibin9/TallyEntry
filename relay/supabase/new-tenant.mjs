// Create a client company (tenant), its office connector key and user sign-in keys.
// Prints SQL to paste into the Supabase SQL editor, and the keys to hand out.
// Only hashes go into the database; the keys are shown once here.
//
//   node relay/supabase/new-tenant.mjs --id al-noor --name "Al Noor Trading LLC" \
//        --user "Office Admin:ADM:admin" --user "Ahmed:AHM:sales"
import crypto from 'node:crypto';
import { defaultSettings } from '../../app/core/defaults.js';

const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const all = (k) => args.flatMap((a, i) => (a === '--' + k ? [args[i + 1]] : []));
const id = get('id'), name = get('name');
if (!id || !name) { console.error('Usage: --id <slug> --name "<Company>" --user "Name:CODE:role" ...'); process.exit(1); }
const key = () => crypto.randomBytes(24).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const connectorKey = key();
const settings = defaultSettings(name);
const users = all('user').map((u) => { const [n, code, role = 'sales'] = u.split(':'); return { id: `${id}-${code.toLowerCase()}`, name: n, code, role, token: key() }; });

console.log('-- ===== SQL (run in Supabase SQL editor) =====');
console.log(`insert into tenants (id, name, settings, connector_key_hash) values (${q(id)}, ${q(name)}, ${q(JSON.stringify(settings))}::jsonb, ${q(sha(connectorKey))});`);
for (const u of users) console.log(`insert into app_users (id, tenant_id, name, code, role, token_hash) values (${q(u.id)}, ${q(id)}, ${q(u.name)}, ${q(u.code)}, ${q(u.role)}, ${q(sha(u.token))});`);
console.log('\n-- ===== Keys (give each person only their own; they are not stored anywhere) =====');
console.log(`-- Office connector key (QE_CONNECTOR_KEY on the Tally PC): ${connectorKey}`);
for (const u of users) console.log(`-- ${u.name} (${u.role}) sign-in key: ${u.token}`);
