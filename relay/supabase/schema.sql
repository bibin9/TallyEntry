-- QuickEntry for Tally: production database for Supabase (Postgres 15+).
-- Run once in the Supabase SQL editor (or psql). Re-running is safe.
--
-- Security model
--   * Every row carries tenant_id (one tenant = one client company).
--   * Row-level security is ON for every table with NO policies for anon/authenticated,
--     so the public Supabase API exposes nothing. All access goes through qe_api(),
--     called only by the Cloudflare Pages Function with the service-role key.
--   * Device sign-in keys, session keys and connector keys are stored as SHA-256 hashes, never in clear.
--   * Passwords are stored as bcrypt hashes (pgcrypto). 5 wrong tries lock a user for 15 minutes.

-- pgcrypto gives crypt()/gen_salt() for passwords. Supabase installs it in the extensions schema.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists tenants (
  id                  text primary key,
  name                text not null,
  settings            jsonb,
  seq                 bigint not null default 0,          -- master change counter (device cursor)
  connector_key_hash  text unique,
  connector_state     jsonb not null default '{"ledgerAlterId":0,"itemAlterId":0,"codeSeq":{}}',
  connector_last_seen timestamptz,
  connector_version   text,
  connector_tally_ok  boolean,
  created_at          timestamptz not null default now()
);

create table if not exists app_users (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  name        text not null,
  code        text not null,                         -- used in document numbers, e.g. SI-AHM-0001
  role        text not null check (role in ('sales','admin')),
  token_hash  text not null unique,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (tenant_id, code)
);
alter table app_users add column if not exists password_hash text;          -- bcrypt; null = no password set
alter table app_users add column if not exists pw_failed     int not null default 0;
alter table app_users add column if not exists locked_until  timestamptz;

-- One row per phone signed in with a password. Deleted when the password or key is reset.
create table if not exists user_sessions (
  token_hash  text primary key,
  user_id     text not null references app_users(id) on delete cascade,
  tenant_id   text not null references tenants(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists user_sessions_u on user_sessions (user_id);

-- Masters from Tally, keyed by the stable code. data holds the full record as the app uses it.
create table if not exists ledgers (
  tenant_id  text not null references tenants(id) on delete cascade,
  code       text not null,
  name       text not null,
  role       text,
  tally_guid text,
  data       jsonb not null,
  active     boolean not null default true,
  seq        bigint not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, code)
);
create index if not exists ledgers_seq on ledgers (tenant_id, seq);
create index if not exists ledgers_guid on ledgers (tenant_id, tally_guid);

create table if not exists items (
  tenant_id  text not null references tenants(id) on delete cascade,
  code       text not null,
  name       text not null,
  tally_guid text,
  data       jsonb not null,
  active     boolean not null default true,
  seq        bigint not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, code)
);
create index if not exists items_seq on items (tenant_id, seq);
create index if not exists items_guid on items (tenant_id, tally_guid);

-- Transactions from devices. id is the UUID created on the device; version rises on every edit.
create table if not exists txns (
  tenant_id   text not null references tenants(id) on delete cascade,
  id          text not null,
  type        text not null,
  number      text,
  txn_date    date,
  party_code  text,
  total       numeric(14,2),
  version     int not null,
  data        jsonb not null,
  status      text not null default 'queued' check (status in ('queued','synced','failed','conflict')),
  error       text,
  conflict    text,
  force       boolean not null default false,
  attempts    int not null default 0,
  retry_at    timestamptz,
  created_by  text,
  received_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists txns_queue on txns (tenant_id, status, retry_at);
-- Data retention (per company, in settings): synced transactions stay active for serverActiveDays,
-- then are archived (kept, shown to admins only) for archiveDays, then deleted.
alter table txns add column if not exists archived_at timestamptz;
create index if not exists txns_archived on txns (tenant_id, archived_at) where archived_at is not null;
alter table tenants add column if not exists last_cleanup timestamptz;
-- Ids of deleted transactions, so a late re-send from a phone can never post it to Tally twice.
create table if not exists purged_txns (
  tenant_id text not null references tenants(id) on delete cascade,
  id        text not null,
  purged_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

create table if not exists txn_lines (
  tenant_id text not null,
  txn_id    text not null,
  line_no   int not null,
  item_code text,
  qty       numeric(14,3),
  rate      numeric(14,4),
  disc_pct  numeric(6,3),
  tax_code  text,
  primary key (tenant_id, txn_id, line_no),
  foreign key (tenant_id, txn_id) references txns(tenant_id, id) on delete cascade
);

-- One app transaction maps to exactly one Tally voucher.
create table if not exists sync_mappings (
  tenant_id         text not null,
  txn_id            text not null,
  tally_master_id   bigint,
  tally_guid        text,
  voucher_no        text,
  synced_version    int not null,
  alter_id_at_sync  bigint,
  synced_at         timestamptz not null default now(),
  primary key (tenant_id, txn_id),
  foreign key (tenant_id, txn_id) references txns(tenant_id, id) on delete cascade
);

create table if not exists sync_log (
  id        bigserial primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  at        timestamptz not null default now(),
  dir       text not null,
  txn_id    text,
  number    text,
  version   int,
  result    text not null,
  message   text,
  counts    jsonb
);
create index if not exists sync_log_t on sync_log (tenant_id, id desc);

alter table tenants       enable row level security;
alter table app_users     enable row level security;
alter table ledgers       enable row level security;
alter table items         enable row level security;
alter table txns          enable row level security;
alter table txn_lines     enable row level security;
alter table sync_mappings enable row level security;
alter table sync_log      enable row level security;
alter table user_sessions enable row level security;
alter table purged_txns   enable row level security;

-- ---------------------------------------------------------------------------------------
-- Helpers
create or replace function qe_next_seq(p_tid text) returns bigint language sql set search_path = public as $$
  update tenants set seq = seq + 1 where id = p_tid returning seq;
$$;

create or replace function qe_log(p_tid text, p_dir text, p_txn text, p_number text, p_version int, p_result text, p_message text default null, p_counts jsonb default null)
returns void language sql set search_path = public as $$
  insert into sync_log (tenant_id, dir, txn_id, number, version, result, message, counts)
  values (p_tid, p_dir, p_txn, p_number, p_version, p_result, p_message, p_counts);
$$;

create or replace function qe_txn_total(d jsonb) returns numeric language sql immutable set search_path = public as $$
  select case when d->>'type' = 'rc' then coalesce((d->>'amount')::numeric, 0)
    else coalesce((select sum(coalesce((l->>'qty')::numeric,0) * coalesce((l->>'rate')::numeric,0) * (1 - coalesce((l->>'discPct')::numeric,0)/100))
                   from jsonb_array_elements(coalesce(d->'lines','[]'::jsonb)) l), 0) end;  -- before tax; for reporting only
$$;

-- Upsert one master; returns 'added' | 'updated' | 'unchanged'
create or replace function qe_upsert_master(p_tid text, p_kind text, m jsonb) returns text language plpgsql set search_path = public as $$
declare
  v_code text := m->>'code';
  v_old jsonb; v_old_code text; v_seq bigint;
  v_new jsonb := m - 'seq' - 'active' - 'updatedAt';
  strip constant text[] := array['tallyAlterId','tallyMasterId'];
begin
  if v_code is null or v_code = '' then return 'skipped'; end if;
  if p_kind = 'ledgers' then
    select data, code into v_old, v_old_code from ledgers where tenant_id = p_tid and code = v_code;
    if not found and m->>'tallyGuid' is not null then
      select data, code into v_old, v_old_code from ledgers where tenant_id = p_tid and tally_guid = m->>'tallyGuid' limit 1;
      if found then delete from ledgers where tenant_id = p_tid and code = v_old_code; end if;
    end if;
  else
    select data, code into v_old, v_old_code from items where tenant_id = p_tid and code = v_code;
    if not found and m->>'tallyGuid' is not null then
      select data, code into v_old, v_old_code from items where tenant_id = p_tid and tally_guid = m->>'tallyGuid' limit 1;
      if found then delete from items where tenant_id = p_tid and code = v_old_code; end if;
    end if;
  end if;
  if v_old is not null and v_old_code = v_code and (v_old - strip) = (v_new - strip) then
    -- also reactivate silently if it had been marked inactive
    return 'unchanged';
  end if;
  v_seq := qe_next_seq(p_tid);
  if p_kind = 'ledgers' then
    insert into ledgers (tenant_id, code, name, role, tally_guid, data, active, seq, updated_at)
    values (p_tid, v_code, m->>'name', m->>'role', m->>'tallyGuid', v_new, true, v_seq, now())
    on conflict (tenant_id, code) do update set name = excluded.name, role = excluded.role, tally_guid = excluded.tally_guid,
      data = excluded.data, active = true, seq = excluded.seq, updated_at = now();
  else
    insert into items (tenant_id, code, name, tally_guid, data, active, seq, updated_at)
    values (p_tid, v_code, m->>'name', m->>'tallyGuid', v_new, true, v_seq, now())
    on conflict (tenant_id, code) do update set name = excluded.name, tally_guid = excluded.tally_guid,
      data = excluded.data, active = true, seq = excluded.seq, updated_at = now();
  end if;
  return case when v_old is null then 'added' else 'updated' end;
end $$;

-- New random key (about 240 bits, URL-safe) and its SHA-256 hash, as the app sends it.
create or replace function qe_new_key() returns text language sql volatile set search_path = public as $$
  select rtrim(translate(encode(decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/', '-_'), '=')
$$;
create or replace function qe_hash(p_key text) returns text language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(p_key, 'UTF8')), 'hex')
$$;

-- User management for one company. p_caller is the signed-in admin's user id, or null for the owner.
create or replace function qe_users(p_tid text, p_caller text, p_op text, p_body jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id text; v_code text; v_role text; v_key text; v_user app_users; v_admins int;
begin
  if p_op = 'users.list' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'code', code, 'role', role,
      'active', active, 'hasPassword', password_hash is not null, 'createdAt', created_at) order by active desc, name) from app_users where tenant_id = p_tid), '[]'::jsonb);
  end if;

  if p_op = 'users.add' then
    v_code := upper(trim(coalesce(p_body->>'code', '')));
    v_role := coalesce(p_body->>'role', 'sales');
    if coalesce(trim(p_body->>'name'), '') = '' then raise exception 'Enter a name' using errcode = '22023'; end if;
    if v_code !~ '^[A-Z0-9]{2,6}$' then raise exception 'Code must be 2 to 6 letters or digits, for example AHM' using errcode = '22023'; end if;
    if v_role not in ('sales', 'admin') then raise exception 'Role must be sales or admin' using errcode = '22023'; end if;
    if exists (select 1 from app_users where tenant_id = p_tid and code = v_code) then
      raise exception 'Code % is already used in this company', v_code using errcode = '22023';
    end if;
    v_id := p_tid || '-' || lower(v_code);
    v_key := qe_new_key();
    insert into app_users (id, tenant_id, name, code, role, token_hash)
      values (v_id, p_tid, trim(p_body->>'name'), v_code, v_role, qe_hash(v_key));
    return jsonb_build_object('id', v_id, 'name', trim(p_body->>'name'), 'code', v_code, 'role', v_role, 'active', true, 'key', v_key);
  end if;

  select * into v_user from app_users where tenant_id = p_tid and id = p_body->>'id';
  if not found then raise exception 'User not found' using errcode = '22023'; end if;

  if p_op = 'users.update' then
    v_role := coalesce(p_body->>'role', v_user.role);
    if v_role not in ('sales', 'admin') then raise exception 'Role must be sales or admin' using errcode = '22023'; end if;
    if v_user.id = p_caller and (v_role <> 'admin' or (p_body ? 'active' and not (p_body->>'active')::boolean)) then
      raise exception 'You cannot switch off or demote yourself' using errcode = '22023';
    end if;
    update app_users set
      name = coalesce(nullif(trim(p_body->>'name'), ''), name),
      role = v_role,
      active = coalesce((p_body->>'active')::boolean, active)
    where id = v_user.id;
    select count(*) into v_admins from app_users where tenant_id = p_tid and role = 'admin' and active;
    if v_admins = 0 then raise exception 'A company needs at least one active admin' using errcode = '22023'; end if;
    return (select jsonb_build_object('id', id, 'name', name, 'code', code, 'role', role, 'active', active) from app_users where id = v_user.id);
  end if;

  if p_op = 'users.resetkey' then
    v_key := qe_new_key();
    update app_users set token_hash = qe_hash(v_key) where id = v_user.id;
    delete from user_sessions where user_id = v_user.id;            -- signs every phone of this person out
    return jsonb_build_object('id', v_user.id, 'key', v_key);
  end if;

  if p_op = 'users.setpassword' then
    if length(coalesce(p_body->>'password', '')) < 6 or length(p_body->>'password') > 72 then
      raise exception 'Password must be 6 to 72 characters' using errcode = '22023';
    end if;
    update app_users set password_hash = crypt(p_body->>'password', gen_salt('bf', 8)), pw_failed = 0, locked_until = null
      where id = v_user.id;
    delete from user_sessions where user_id = v_user.id;            -- old password sessions stop working
    return jsonb_build_object('id', v_user.id, 'company', p_tid, 'code', v_user.code, 'hasPassword', true);
  end if;

  raise exception 'Unknown operation %', p_op using errcode = '22023';
end $$;

-- Owner operations: create client companies. The Worker only allows these with the OWNER_KEY secret.
create or replace function qe_owner(p_op text, p_body jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tid text; v_ckey text; v_admin jsonb;
begin
  if p_op = 'owner.tenants' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'createdAt', t.created_at,
      'connectorLastSeen', t.connector_last_seen, 'connectorVersion', t.connector_version,
      'users', (select count(*) from app_users u where u.tenant_id = t.id and u.active)) order by t.created_at) from tenants t), '[]'::jsonb);
  end if;

  if p_op = 'owner.tenant.create' then
    v_tid := lower(trim(coalesce(p_body->>'id', '')));
    if v_tid !~ '^[a-z0-9][a-z0-9-]{1,39}$' then
      raise exception 'Company ID must be 2 to 40 lowercase letters, digits or dashes, for example al-noor' using errcode = '22023';
    end if;
    if coalesce(trim(p_body->>'name'), '') = '' then raise exception 'Enter the company name' using errcode = '22023'; end if;
    if exists (select 1 from tenants where id = v_tid) then raise exception 'Company ID % already exists', v_tid using errcode = '22023'; end if;
    if p_body->'settings' is null then raise exception 'Missing settings' using errcode = '22023'; end if;
    v_ckey := qe_new_key();
    insert into tenants (id, name, settings, connector_key_hash) values (v_tid, trim(p_body->>'name'), p_body->'settings', qe_hash(v_ckey));
    v_admin := qe_users(v_tid, null, 'users.add', jsonb_build_object('name', p_body->>'adminName', 'code', p_body->>'adminCode', 'role', 'admin'));
    return jsonb_build_object('id', v_tid, 'name', trim(p_body->>'name'), 'connectorKey', v_ckey, 'admin', v_admin);
  end if;

  v_tid := p_body->>'tenant';
  if not exists (select 1 from tenants where id = v_tid) then raise exception 'Company not found' using errcode = '22023'; end if;

  if p_op = 'owner.tenant.connectorkey' then
    v_ckey := qe_new_key();
    update tenants set connector_key_hash = qe_hash(v_ckey) where id = v_tid;
    return jsonb_build_object('id', v_tid, 'connectorKey', v_ckey);
  end if;

  if p_op in ('owner.users.list', 'owner.users.add', 'owner.users.update', 'owner.users.resetkey', 'owner.users.setpassword') then
    return qe_users(v_tid, null, substr(p_op, 7), p_body);
  end if;

  raise exception 'Unknown operation %', p_op using errcode = '22023';
end $$;

-- Archive and delete old synced data for one company. Only 'synced' transactions are touched:
-- anything still waiting for Tally (queued, failed, conflict) is kept however old it is.
create or replace function qe_cleanup(p_tid text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s jsonb; v_active int; v_archive int; v_arch int; v_del int; v_log int;
begin
  select settings into s from tenants where id = p_tid;
  v_active  := least(greatest(coalesce(case when s->>'serverActiveDays' ~ '^-?[0-9]{1,6}$' then (s->>'serverActiveDays')::int end, 7), 1), 3650);
  v_archive := least(greatest(coalesce(case when s->>'archiveDays' ~ '^-?[0-9]{1,6}$' then (s->>'archiveDays')::int end, 30), 0), 3650);
  update txns tx set archived_at = now()
    from sync_mappings mp
    where tx.tenant_id = p_tid and tx.status = 'synced' and tx.archived_at is null
      and mp.tenant_id = tx.tenant_id and mp.txn_id = tx.id and mp.synced_version >= tx.version
      and mp.synced_at < now() - make_interval(days => v_active);
  get diagnostics v_arch = row_count;
  with gone as (
    delete from txns where tenant_id = p_tid and status = 'synced' and archived_at < now() - make_interval(days => v_archive)
    returning id)
  insert into purged_txns (tenant_id, id) select p_tid, id from gone on conflict do nothing;
  get diagnostics v_del = row_count;
  delete from sync_log where tenant_id = p_tid and at < now() - make_interval(days => v_active + v_archive);
  get diagnostics v_log = row_count;
  delete from purged_txns where tenant_id = p_tid and purged_at < now() - interval '1 year';
  update tenants set last_cleanup = now() where id = p_tid;
  return jsonb_build_object('archived', v_arch, 'deleted', v_del, 'logDeleted', v_log);
end $$;

-- Sign in with Company ID + user code + password. Returns a new session key for the phone.
-- Answers with ok:false instead of raising, so the wrong-try counter is saved.
-- Every failure gives the same message, so it never tells whether a company or user exists.
create or replace function qe_login(p_body jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user app_users; v_key text; v_wait int;
  c_bad constant text := 'Wrong company ID, user code or password';
begin
  select * into v_user from app_users
    where tenant_id = lower(trim(coalesce(p_body->>'company', ''))) and code = upper(trim(coalesce(p_body->>'code', '')))
    for update;  -- tries arriving at the same moment are counted one after another, so none slips past the lockout
  if not found or v_user.password_hash is null or not v_user.active then
    perform crypt(coalesce(p_body->>'password', ''), '$2a$08$4h6Yw0bH1Gp1q0f7c3J9eO');  -- same work as a real check
    return jsonb_build_object('ok', false, 'error', c_bad);
  end if;
  if v_user.locked_until > now() then
    v_wait := greatest(1, ceil(extract(epoch from v_user.locked_until - now()) / 60)::int);
    return jsonb_build_object('ok', false, 'locked', true, 'error', format('Too many wrong tries. Try again in %s minute%s, or ask your office admin to reset your password.', v_wait, case when v_wait = 1 then '' else 's' end));
  end if;
  if crypt(coalesce(p_body->>'password', ''), v_user.password_hash) <> v_user.password_hash then
    if v_user.pw_failed + 1 >= 5 then
      update app_users set pw_failed = 0, locked_until = now() + interval '15 minutes' where id = v_user.id;
      return jsonb_build_object('ok', false, 'locked', true, 'error', 'Too many wrong tries. Try again in 15 minutes, or ask your office admin to reset your password.');
    end if;
    update app_users set pw_failed = pw_failed + 1 where id = v_user.id;
    return jsonb_build_object('ok', false, 'error', c_bad);
  end if;
  update app_users set pw_failed = 0, locked_until = null where id = v_user.id;
  v_key := qe_new_key();
  insert into user_sessions (token_hash, user_id, tenant_id) values (qe_hash(v_key), v_user.id, v_user.tenant_id);
  return jsonb_build_object('ok', true, 'key', v_key,
    'user', jsonb_build_object('id', v_user.id, 'name', v_user.name, 'code', v_user.code, 'role', v_user.role, 'tenant', v_user.tenant_id));
end $$;

-- ---------------------------------------------------------------------------------------
-- The whole sync API in one entry point. Mirrors app/core/relay-core.js.
create or replace function qe_api(p_token_hash text, p_op text, p_body jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u app_users; t tenants; v_tid text; x jsonb; r jsonb; res jsonb := '[]'::jsonb;
  cur txns; m sync_mappings; v_ver int; v_kind text; v_res text; v_counts jsonb; v_n int; v_since bigint;
  v_stale boolean; v_names jsonb; v_items jsonb; v_c int; v_li int; v_patch jsonb;
begin
  if p_op = 'login' then
    if p_token_hash is not null then raise exception 'Not allowed' using errcode = '42501'; end if;
    return qe_login(p_body);
  elsif p_op like 'owner.%' then
    -- Owner calls carry no user key; the Worker checks the OWNER_KEY secret before sending them.
    if p_token_hash is not null then raise exception 'Not allowed' using errcode = '42501'; end if;
    return qe_owner(p_op, p_body);
  elsif p_op like 'connector.%' then
    select * into t from tenants where connector_key_hash = p_token_hash;
    if not found then raise exception 'Invalid connector key' using errcode = '28000'; end if;
    v_tid := t.id;
  else
    select * into u from app_users where token_hash = p_token_hash and active;
    if not found then   -- a phone signed in with a password carries a session key instead
      select a.* into u from user_sessions s join app_users a on a.id = s.user_id where s.token_hash = p_token_hash and a.active;
    end if;
    if not found then raise exception 'Please sign in again' using errcode = '28000'; end if;
    v_tid := u.tenant_id;
    select * into t from tenants where id = v_tid;
  end if;

  -- ------------------------------------------------------------- device operations
  if p_op = 'logout' then
    delete from user_sessions where token_hash = p_token_hash;      -- a sign-in key stays valid; only a session ends
    return '{"ok":true}';

  elsif p_op = 'me' then
    return jsonb_build_object('id', u.id, 'name', u.name, 'code', u.code, 'role', u.role, 'tenant', v_tid);

  elsif p_op = 'settings.get' then
    return t.settings;

  elsif p_op = 'settings.put' then
    if u.role <> 'admin' then raise exception 'Only an office admin can change settings' using errcode = '42501'; end if;
    update tenants set settings = p_body where id = v_tid;
    return p_body;

  elsif p_op = 'masters' then
    v_since := coalesce((p_body->>'since')::bigint, 0);
    return jsonb_build_object(
      'ledgers', coalesce((select jsonb_agg(l.data || jsonb_build_object('seq', l.seq, 'active', l.active)) from ledgers l where l.tenant_id = v_tid and l.seq > v_since), '[]'::jsonb),
      'items',   coalesce((select jsonb_agg(i.data || jsonb_build_object('seq', i.seq, 'active', i.active)) from items i where i.tenant_id = v_tid and i.seq > v_since), '[]'::jsonb),
      'cursor', t.seq);

  elsif p_op = 'txns.push' then
    for x in select * from jsonb_array_elements(coalesce(p_body->'txns', '[]'::jsonb)) loop
      if x->>'id' is null or x->>'type' is null or coalesce((x->>'version')::int, 0) < 1 then
        res := res || jsonb_build_object('id', x->>'id', 'accepted', false, 'error', 'invalid'); continue;
      end if;
      if exists (select 1 from purged_txns where tenant_id = v_tid and id = x->>'id') then
        res := res || jsonb_build_object('id', x->>'id', 'accepted', false, 'purged', true, 'error', 'This entry is older than the company keeps data for, so it was not sent again'); continue;
      end if;
      select * into cur from txns where tenant_id = v_tid and id = x->>'id' for update;
      if found and cur.version >= (x->>'version')::int then
        res := res || jsonb_build_object('id', x->>'id', 'accepted', false, 'duplicate', true, 'version', cur.version); continue;
      end if;
      x := x - 'status' - 'error' - 'tally' - 'pushedVersion' - 'syncedVersion' - 'conflict';
      insert into txns (tenant_id, id, type, number, txn_date, party_code, total, version, data, status, created_by)
      values (v_tid, x->>'id', x->>'type', x->>'number', (x->>'date')::date, x->>'partyCode', qe_txn_total(x), (x->>'version')::int, x, 'queued', u.id)
      on conflict (tenant_id, id) do update set type = excluded.type, number = excluded.number, txn_date = excluded.txn_date,
        party_code = excluded.party_code, total = excluded.total, version = excluded.version, data = excluded.data,
        status = 'queued', error = null, conflict = null, received_at = now(), archived_at = null
        where txns.version < excluded.version;  -- two copies of one push arriving at the same instant: the second is a duplicate
      if not found then
        res := res || jsonb_build_object('id', x->>'id', 'accepted', false, 'duplicate', true, 'version', (x->>'version')::int); continue;
      end if;
      delete from txn_lines where tenant_id = v_tid and txn_id = x->>'id';
      insert into txn_lines (tenant_id, txn_id, line_no, item_code, qty, rate, disc_pct, tax_code)
      select v_tid, x->>'id', o.n, o.l->>'itemCode', (o.l->>'qty')::numeric, (o.l->>'rate')::numeric, coalesce((o.l->>'discPct')::numeric, 0), o.l->>'taxCode'
      from jsonb_array_elements(coalesce(x->'lines', '[]'::jsonb)) with ordinality as o(l, n);
      perform qe_log(v_tid, 'device->cloud', x->>'id', x->>'number', (x->>'version')::int, case when cur.id is null then 'received' else 'updated' end);
      res := res || jsonb_build_object('id', x->>'id', 'accepted', true, 'version', (x->>'version')::int);
    end loop;
    return res;

  elsif p_op = 'txns.status' then
    return coalesce((select jsonb_agg(
      case when tx.id is null then jsonb_build_object('id', ids.id, 'status', 'unknown')
      else jsonb_build_object('id', tx.id, 'status', tx.status, 'version', tx.version, 'error', tx.error, 'conflict', tx.conflict,
        'syncedVersion', coalesce(mp.synced_version, 0),
        'tally', case when mp.txn_id is null then null else jsonb_build_object('voucherNo', mp.voucher_no, 'masterId', mp.tally_master_id, 'guid', mp.tally_guid, 'syncedAt', mp.synced_at) end)
      end order by ids.n)
      from jsonb_array_elements_text(coalesce(p_body->'ids', '[]'::jsonb)) with ordinality as ids(id, n)
      left join txns tx on tx.tenant_id = v_tid and tx.id = ids.id
      left join sync_mappings mp on mp.tenant_id = v_tid and mp.txn_id = ids.id), '[]'::jsonb);

  elsif p_op = 'txns.retry' then
    update txns set status = 'queued', attempts = 0 where tenant_id = v_tid and status = 'failed'
      and id in (select jsonb_array_elements_text(coalesce(p_body->'ids', '[]'::jsonb)));
    return '{"ok":true}';

  elsif p_op = 'txns.resolve' then
    if u.role <> 'admin' then raise exception 'Only an office admin can resolve conflicts' using errcode = '42501'; end if;
    select * into cur from txns where tenant_id = v_tid and id = p_body->>'id' for update;
    if not found or cur.status <> 'conflict' then raise exception 'Not in conflict' using errcode = '22023'; end if;
    if p_body->>'choice' = 'app' then
      update txns set status = 'queued', force = true, conflict = null where tenant_id = v_tid and id = cur.id;
    else
      update txns set status = 'synced', conflict = null where tenant_id = v_tid and id = cur.id;
      update sync_mappings set synced_version = cur.version where tenant_id = v_tid and txn_id = cur.id;
    end if;
    perform qe_log(v_tid, 'office', cur.id, cur.number, cur.version, 'conflict resolved: ' || case when p_body->>'choice' = 'app' then 'app version sent' else 'Tally version kept' end);
    return '{"ok":true}';

  elsif p_op = 'log' then
    return coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('at', l.at, 'dir', l.dir, 'id', l.txn_id, 'number', l.number, 'version', l.version, 'result', l.result, 'message', l.message, 'counts', l.counts)) order by l.id desc)
      from (select * from sync_log where tenant_id = v_tid order by id desc limit 150) l), '[]'::jsonb);

  elsif p_op = 'txns.summary' then
    -- Office check that everything reached Tally: counts, the oldest waiting entry, and what needs attention.
    if u.role <> 'admin' then raise exception 'Only an office admin can see the sync check' using errcode = '42501'; end if;
    return jsonb_build_object(
      'counts', (select jsonb_build_object(
          'queued', count(*) filter (where status = 'queued'), 'failed', count(*) filter (where status = 'failed'),
          'conflict', count(*) filter (where status = 'conflict'), 'synced', count(*) filter (where status = 'synced' and archived_at is null),
          'archived', count(*) filter (where archived_at is not null))
        from txns where tenant_id = v_tid),
      'oldestWaiting', (select min(received_at) from txns where tenant_id = v_tid and status <> 'synced'),
      'connector', jsonb_build_object('lastSeen', t.connector_last_seen, 'tallyOk', t.connector_tally_ok, 'version', t.connector_version),
      'attention', coalesce((select jsonb_agg(x.j order by x.j->>'receivedAt') from (
          select jsonb_strip_nulls(jsonb_build_object('id', tx.id, 'type', tx.type, 'number', tx.number, 'date', tx.txn_date, 'partyCode', tx.party_code, 'party', l.name,
            'status', tx.status, 'error', tx.error, 'conflict', tx.conflict, 'createdBy', a.name, 'receivedAt', tx.received_at, 'attempts', tx.attempts)) j
          from txns tx left join ledgers l on l.tenant_id = tx.tenant_id and l.code = tx.party_code
          left join app_users a on a.id = tx.created_by
          where tx.tenant_id = v_tid and (tx.status in ('failed', 'conflict') or (tx.status = 'queued' and tx.received_at < now() - interval '1 hour'))
          order by tx.received_at limit 100) x), '[]'::jsonb));

  elsif p_op = 'archive.list' then
    -- Archived (older, already in Tally) transactions, newest first. Optional search on number or party.
    if u.role <> 'admin' then raise exception 'Only an office admin can open the archive' using errcode = '42501'; end if;
    return coalesce((select jsonb_agg(a.j order by a.j->>'archivedAt' desc, a.j->>'number' desc) from (
      select jsonb_strip_nulls(jsonb_build_object('id', tx.id, 'type', tx.type, 'number', tx.number, 'date', tx.txn_date,
        'partyCode', tx.party_code, 'party', l.name, 'total', tx.total, 'createdBy', tx.created_by, 'archivedAt', tx.archived_at,
        'voucherNo', mp.voucher_no, 'syncedAt', mp.synced_at,
        'deleteOn', (tx.archived_at + make_interval(days => least(greatest(coalesce(case when t.settings->>'archiveDays' ~ '^-?[0-9]{1,6}$' then (t.settings->>'archiveDays')::int end, 30), 0), 3650)))::date)) j
      from txns tx
      left join sync_mappings mp on mp.tenant_id = tx.tenant_id and mp.txn_id = tx.id
      left join ledgers l on l.tenant_id = tx.tenant_id and l.code = tx.party_code
      where tx.tenant_id = v_tid and tx.archived_at is not null
        and (coalesce(p_body->>'q', '') = '' or tx.number ilike '%' || (p_body->>'q') || '%' or l.name ilike '%' || (p_body->>'q') || '%' or tx.party_code ilike '%' || (p_body->>'q') || '%')
      order by tx.archived_at desc, tx.number desc limit 200) a), '[]'::jsonb);

  elsif p_op = 'connectorinfo' then
    return jsonb_build_object('state', t.connector_state, 'lastSeen', t.connector_last_seen, 'version', t.connector_version, 'tallyOk', t.connector_tally_ok);

  -- ------------------------------------------------------------- connector operations
  elsif p_op like 'users.%' then
    if u.role <> 'admin' then raise exception 'Only an office admin can manage users' using errcode = '42501'; end if;
    return qe_users(v_tid, u.id, p_op, p_body);

  elsif p_op = 'connector.hello' then
    update tenants set connector_last_seen = now(), connector_version = p_body->>'version', connector_tally_ok = (p_body->>'tallyOk')::boolean where id = v_tid;
    if t.last_cleanup is null or t.last_cleanup < now() - interval '1 hour' then perform qe_cleanup(v_tid); end if;
    return jsonb_build_object('state', t.connector_state, 'settings', t.settings);

  elsif p_op = 'connector.state' then
    update tenants set connector_state = p_body where id = v_tid;
    return '{"ok":true}';

  elsif p_op = 'connector.masters' then
    v_counts := '{"ledgers":{"added":0,"updated":0,"unchanged":0},"items":{"added":0,"updated":0,"unchanged":0}}';
    foreach v_kind in array array['ledgers','items'] loop
      for x in select * from jsonb_array_elements(coalesce(p_body->v_kind, '[]'::jsonb)) loop
        v_res := qe_upsert_master(v_tid, v_kind, x);
        if v_res <> 'skipped' then
          v_counts := jsonb_set(v_counts, array[v_kind, v_res], to_jsonb((v_counts->v_kind->>v_res)::int + 1));
        end if;
      end loop;
    end loop;
    perform qe_log(v_tid, 'tally->cloud', null, null, null, 'masters', null, v_counts);
    return v_counts;

  elsif p_op = 'connector.balances' then
    -- Merge refreshed balance, overdue and stock numbers into existing masters (only these fields).
    v_li := 0; v_n := 0;
    for x in select * from jsonb_array_elements(coalesce(p_body->'ledgers', '[]'::jsonb)) loop
      v_patch := jsonb_strip_nulls(jsonb_build_object(
        'balance', case when jsonb_typeof(x->'balance') = 'number' then x->'balance' end,
        'overdue', case when jsonb_typeof(x->'overdue') = 'number' then x->'overdue' end,
        'overdueDays', case when jsonb_typeof(x->'overdueDays') = 'number' then x->'overdueDays' end));
      update ledgers set data = data || v_patch, seq = qe_next_seq(v_tid), updated_at = now()
        where tenant_id = v_tid and code = x->>'code' and data || v_patch <> data;
      get diagnostics v_c = row_count; v_li := v_li + v_c;
    end loop;
    for x in select * from jsonb_array_elements(coalesce(p_body->'items', '[]'::jsonb)) loop
      continue when jsonb_typeof(x->'stock') is distinct from 'number';
      v_patch := jsonb_build_object('stock', x->'stock');
      update items set data = data || v_patch, seq = qe_next_seq(v_tid), updated_at = now()
        where tenant_id = v_tid and code = x->>'code' and data || v_patch <> data;
      get diagnostics v_c = row_count; v_n := v_n + v_c;
    end loop;
    if v_li + v_n > 0 then
      perform qe_log(v_tid, 'tally->cloud', null, null, null, 'balances (' || v_li || ' customers/ledgers, ' || v_n || ' items)');
    end if;
    return jsonb_build_object('ledgers', v_li, 'items', v_n);

  elsif p_op = 'connector.reconcile' then
    v_n := 0;
    if p_body->>'kind' = 'ledgers' then
      with gone as (select code from ledgers where tenant_id = v_tid and active
                    and code not in (select jsonb_array_elements_text(coalesce(p_body->'codes','[]'::jsonb))))
      update ledgers l set active = false, seq = qe_next_seq(v_tid) from gone where l.tenant_id = v_tid and l.code = gone.code;
    else
      with gone as (select code from items where tenant_id = v_tid and active
                    and code not in (select jsonb_array_elements_text(coalesce(p_body->'codes','[]'::jsonb))))
      update items i set active = false, seq = qe_next_seq(v_tid) from gone where i.tenant_id = v_tid and i.code = gone.code;
    end if;
    get diagnostics v_n = row_count;
    if v_n > 0 then perform qe_log(v_tid, 'tally->cloud', null, null, null, v_n || ' ' || (p_body->>'kind') || ' inactive (deleted in Tally)'); end if;
    return jsonb_build_object('deactivated', v_n);

  elsif p_op = 'connector.queue' then
    for cur in select * from txns where tenant_id = v_tid
        and (status = 'queued' or (status = 'failed' and retry_at <= now() and attempts < 6))
        order by received_at limit 50 loop
      select * into m from sync_mappings where tenant_id = v_tid and txn_id = cur.id;
      select coalesce(jsonb_object_agg(i.code, jsonb_build_object('name', i.name, 'unit', i.data->>'unit')), '{}'::jsonb) into v_items
        from items i where i.tenant_id = v_tid and i.code in (select l->>'itemCode' from jsonb_array_elements(coalesce(cur.data->'lines','[]'::jsonb)) l);
      v_names := jsonb_build_object(
        'party', (select name from ledgers where tenant_id = v_tid and code = cur.party_code),
        'items', v_items,
        'account', (select name from ledgers where tenant_id = v_tid and code = cur.data->>'accountCode'));
      res := res || jsonb_build_object('txn', cur.data, 'force', cur.force, 'names', v_names,
        'mapping', case when m.txn_id is null then null else jsonb_build_object('masterId', m.tally_master_id, 'guid', m.tally_guid, 'voucherNo', m.voucher_no,
          'syncedVersion', m.synced_version, 'alterIdAtSync', m.alter_id_at_sync, 'syncedAt', m.synced_at) end);
      m := null;
    end loop;
    return res;

  elsif p_op = 'connector.result' then
    select * into cur from txns where tenant_id = v_tid and id = p_body->>'id' for update;
    if not found then return '{"ok":false}'; end if;
    v_ver := (p_body->>'version')::int;
    v_stale := v_ver < cur.version;
    if (p_body->>'ok')::boolean then
      insert into sync_mappings (tenant_id, txn_id, tally_master_id, tally_guid, voucher_no, synced_version, alter_id_at_sync, synced_at)
      values (v_tid, cur.id, (p_body->>'masterId')::bigint, p_body->>'guid', p_body->>'voucherNo', v_ver, (p_body->>'alterId')::bigint, now())
      on conflict (tenant_id, txn_id) do update set tally_master_id = excluded.tally_master_id, tally_guid = coalesce(excluded.tally_guid, sync_mappings.tally_guid),
        voucher_no = excluded.voucher_no, synced_version = excluded.synced_version, alter_id_at_sync = excluded.alter_id_at_sync, synced_at = now();
      if not v_stale then update txns set status = 'synced', error = null, force = false, attempts = 0, retry_at = null where tenant_id = v_tid and id = cur.id; end if;
      perform qe_log(v_tid, 'cloud->tally', cur.id, cur.number, v_ver, case when p_body->>'action' = 'Alter' then 'altered' else 'created' end);
    elsif p_body->>'conflict' is not null then
      if not v_stale then update txns set status = 'conflict', conflict = p_body->>'conflict' where tenant_id = v_tid and id = cur.id; end if;
      perform qe_log(v_tid, 'cloud->tally', cur.id, cur.number, v_ver, 'conflict', p_body->>'conflict');
    else
      if not v_stale then
        update txns set status = 'failed', error = p_body->>'error', attempts = attempts + 1,
          retry_at = now() + make_interval(mins => (array[1,5,15,60,240])[least(attempts + 1, 5)])
          where tenant_id = v_tid and id = cur.id;
      end if;
      perform qe_log(v_tid, 'cloud->tally', cur.id, cur.number, v_ver, 'failed', p_body->>'error');
    end if;
    return '{"ok":true}';
  end if;

  raise exception 'Unknown operation %', p_op using errcode = '22023';
end $$;

-- Only the service role (used by the Cloudflare Worker / Pages Function) may call these.
-- Supabase grants EXECUTE on new functions to anon and authenticated by default, so revoke
-- from those roles explicitly, not only from public.
do $$
declare f text; r text;
begin
  foreach f in array array['qe_api(text, text, jsonb)', 'qe_users(text, text, text, jsonb)', 'qe_owner(text, jsonb)', 'qe_login(jsonb)', 'qe_cleanup(text)',
                           'qe_new_key()', 'qe_hash(text)', 'qe_next_seq(text)', 'qe_log(text, text, text, text, integer, text, text, jsonb)',
                           'qe_txn_total(jsonb)', 'qe_upsert_master(text, text, jsonb)'] loop
    if to_regprocedure(f) is null then continue; end if;
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function qe_api(text, text, jsonb) to service_role';
  end if;
end $$;
