-- QuickEntry for Tally: production database for Supabase (Postgres 15+).
-- Run once in the Supabase SQL editor (or psql). Re-running is safe.
--
-- Security model
--   * Every row carries tenant_id (one tenant = one client company).
--   * Row-level security is ON for every table with NO policies for anon/authenticated,
--     so the public Supabase API exposes nothing. All access goes through qe_api(),
--     called only by the Cloudflare Pages Function with the service-role key.
--   * Device sign-in keys and connector keys are stored as SHA-256 hashes, never in clear.

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

-- ---------------------------------------------------------------------------------------
-- Helpers
create or replace function qe_next_seq(p_tid text) returns bigint language sql as $$
  update tenants set seq = seq + 1 where id = p_tid returning seq;
$$;

create or replace function qe_log(p_tid text, p_dir text, p_txn text, p_number text, p_version int, p_result text, p_message text default null, p_counts jsonb default null)
returns void language sql as $$
  insert into sync_log (tenant_id, dir, txn_id, number, version, result, message, counts)
  values (p_tid, p_dir, p_txn, p_number, p_version, p_result, p_message, p_counts);
$$;

create or replace function qe_txn_total(d jsonb) returns numeric language sql immutable as $$
  select case when d->>'type' = 'rc' then coalesce((d->>'amount')::numeric, 0)
    else coalesce((select sum(coalesce((l->>'qty')::numeric,0) * coalesce((l->>'rate')::numeric,0) * (1 - coalesce((l->>'discPct')::numeric,0)/100))
                   from jsonb_array_elements(coalesce(d->'lines','[]'::jsonb)) l), 0) end;  -- before tax; for reporting only
$$;

-- Upsert one master; returns 'added' | 'updated' | 'unchanged'
create or replace function qe_upsert_master(p_tid text, p_kind text, m jsonb) returns text language plpgsql as $$
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
create or replace function qe_new_key() returns text language sql volatile as $$
  select rtrim(translate(encode(decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/', '-_'), '=')
$$;
create or replace function qe_hash(p_key text) returns text language sql immutable as $$
  select encode(sha256(convert_to(p_key, 'UTF8')), 'hex')
$$;

-- User management for one company. p_caller is the signed-in admin's user id, or null for the owner.
create or replace function qe_users(p_tid text, p_caller text, p_op text, p_body jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id text; v_code text; v_role text; v_key text; v_user app_users; v_admins int;
begin
  if p_op = 'users.list' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'code', code, 'role', role,
      'active', active, 'createdAt', created_at) order by active desc, name) from app_users where tenant_id = p_tid), '[]'::jsonb);
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
    return jsonb_build_object('id', v_user.id, 'key', v_key);
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

  if p_op in ('owner.users.list', 'owner.users.add', 'owner.users.update', 'owner.users.resetkey') then
    return qe_users(v_tid, null, substr(p_op, 7), p_body);
  end if;

  raise exception 'Unknown operation %', p_op using errcode = '22023';
end $$;

-- ---------------------------------------------------------------------------------------
-- The whole sync API in one entry point. Mirrors app/core/relay-core.js.
create or replace function qe_api(p_token_hash text, p_op text, p_body jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u app_users; t tenants; v_tid text; x jsonb; r jsonb; res jsonb := '[]'::jsonb;
  cur txns; m sync_mappings; v_ver int; v_kind text; v_res text; v_counts jsonb; v_n int; v_since bigint;
  v_stale boolean; v_names jsonb; v_items jsonb;
begin
  if p_op like 'owner.%' then
    -- Owner calls carry no user key; the Worker checks the OWNER_KEY secret before sending them.
    if p_token_hash is not null then raise exception 'Not allowed' using errcode = '42501'; end if;
    return qe_owner(p_op, p_body);
  elsif p_op like 'connector.%' then
    select * into t from tenants where connector_key_hash = p_token_hash;
    if not found then raise exception 'Invalid connector key' using errcode = '28000'; end if;
    v_tid := t.id;
  else
    select * into u from app_users where token_hash = p_token_hash and active;
    if not found then raise exception 'Please sign in again' using errcode = '28000'; end if;
    v_tid := u.tenant_id;
    select * into t from tenants where id = v_tid;
  end if;

  -- ------------------------------------------------------------- device operations
  if p_op = 'me' then
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
      select * into cur from txns where tenant_id = v_tid and id = x->>'id' for update;
      if found and cur.version >= (x->>'version')::int then
        res := res || jsonb_build_object('id', x->>'id', 'accepted', false, 'duplicate', true, 'version', cur.version); continue;
      end if;
      x := x - 'status' - 'error' - 'tally' - 'pushedVersion' - 'syncedVersion' - 'conflict';
      insert into txns (tenant_id, id, type, number, txn_date, party_code, total, version, data, status, created_by)
      values (v_tid, x->>'id', x->>'type', x->>'number', (x->>'date')::date, x->>'partyCode', qe_txn_total(x), (x->>'version')::int, x, 'queued', u.id)
      on conflict (tenant_id, id) do update set type = excluded.type, number = excluded.number, txn_date = excluded.txn_date,
        party_code = excluded.party_code, total = excluded.total, version = excluded.version, data = excluded.data,
        status = 'queued', error = null, conflict = null, received_at = now();
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

  elsif p_op = 'connectorinfo' then
    return jsonb_build_object('state', t.connector_state, 'lastSeen', t.connector_last_seen, 'version', t.connector_version, 'tallyOk', t.connector_tally_ok);

  -- ------------------------------------------------------------- connector operations
  elsif p_op like 'users.%' then
    if u.role <> 'admin' then raise exception 'Only an office admin can manage users' using errcode = '42501'; end if;
    return qe_users(v_tid, u.id, p_op, p_body);

  elsif p_op = 'connector.hello' then
    update tenants set connector_last_seen = now(), connector_version = p_body->>'version', connector_tally_ok = (p_body->>'tallyOk')::boolean where id = v_tid;
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
  foreach f in array array['qe_api(text, text, jsonb)', 'qe_users(text, text, text, jsonb)', 'qe_owner(text, jsonb)',
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
