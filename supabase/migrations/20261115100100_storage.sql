-- Phase 8: storage stores and switching (docs/phase-8.md "Storage"). The stores themselves (endpoint, bucket,
-- connection, cost, keys) live in the API's deployment config and Worker secrets, never here: the database only
-- knows store ids. Each photo records the store holding every key under its prefix; a switch copies photos one
-- by one, flips photos.store_id only once the copy is verified, and deletes old copies only after every photo is
-- verified and STORAGE_HOLD_DAYS have passed.
--
-- Migration states: copying → (verifying) → holding → done, with paused and failed on the way, and
-- rolling_back → rolled_back. Item states: pending → verified → deleted, failed when the consumer gives up,
-- skipped when the photo went away or a rollback made the copy unnecessary.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create function public._store_id_ok(p text) returns boolean
language sql immutable set search_path = '' as $$ select p ~ '^[a-z][a-z0-9_]{0,31}$' $$;

alter table public.photos add column store_id text not null default 'r2' check (public._store_id_ok(store_id));
alter table public.uploads add column store_id text not null default 'r2' check (public._store_id_ok(store_id));
create index photos_store on public.photos (store_id, status);

create table public.storage_state (
  id smallint primary key default 1 check (id = 1),
  write_store text not null default 'r2' check (public._store_id_ok(write_store)),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.storage_state (id) values (1);
alter table public.storage_state enable row level security;

create table public.storage_checks (
  id bigint generated always as identity primary key,
  store_id text not null check (public._store_id_ok(store_id)),
  at timestamptz not null default now(),
  -- StoreCheck without `at`: reachable, latencyMs, roundTrip, uploadMBps, freeBytes, capacityBytes, error (a short code).
  result jsonb not null check (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 2000)
);
alter table public.storage_checks enable row level security;
create index storage_checks_store on public.storage_checks (store_id, id desc);

create table public.storage_migrations (
  id uuid primary key default gen_random_uuid(),
  from_store text not null check (public._store_id_ok(from_store)),
  to_store text not null check (public._store_id_ok(to_store)),
  state text not null default 'copying'
    check (state in ('copying', 'paused', 'verifying', 'holding', 'done', 'rolling_back', 'rolled_back', 'failed')),
  started_by uuid not null,
  started_at timestamptz not null default now(),
  reason text not null check (length(reason) between 3 and 300),
  delete_old_after timestamptz,
  finished_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 200),
  check (from_store <> to_store)
);
alter table public.storage_migrations enable row level security;
create unique index storage_migrations_one_active on public.storage_migrations ((true))
  where state in ('copying', 'paused', 'verifying', 'holding', 'rolling_back', 'failed');

-- No foreign key to photos: when a photo is purged mid-migration its leftover copy on the other store must still
-- be found and deleted (cleanup_store).
create table public.storage_migration_items (
  migration_id uuid not null references public.storage_migrations (id) on delete cascade,
  photo_id uuid not null,
  owner_id uuid not null,
  src text not null check (public._store_id_ok(src)),
  dst text not null check (public._store_id_ok(dst)),
  state text not null default 'pending' check (state in ('pending', 'copied', 'verified', 'failed', 'deleted', 'skipped')),
  bytes bigint not null default 0 check (bytes >= 0),
  attempts integer not null default 0 check (attempts between 0 and 1000),
  error text check (error is null or length(error) <= 200),
  lease_until timestamptz,
  -- What the copy was taken from (photo row, edits, masks): a later change means copying again.
  stamp timestamptz,
  -- A store holding a copy of this photo that's no longer needed (deleted once due), and when it was.
  cleanup_store text check (cleanup_store is null or public._store_id_ok(cleanup_store)),
  cleaned_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (migration_id, photo_id),
  check (src <> dst)
);
alter table public.storage_migration_items enable row level security;
create index storage_items_claim on public.storage_migration_items (migration_id, lease_until) where state = 'pending';
create index storage_items_cleanup on public.storage_migration_items (migration_id) where cleanup_store is not null and cleaned_at is null;

-- ---------------------------------------------------------------------------------------------
-- Uploads record the store they're written to
-- ---------------------------------------------------------------------------------------------
-- A new photo goes to the current write store; its upload uses the photo's store, so a switch never splits a
-- multipart upload.
create function public._photo_store_default() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.store_id := (select s.write_store from public.storage_state s where s.id = 1);
  return new;
end;
$$;
create trigger photos_store_default before insert on public.photos
  for each row execute function public._photo_store_default();

create function public._upload_store_default() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.store_id := coalesce((select p.store_id from public.photos p where p.id = new.photo_id),
                           (select s.write_store from public.storage_state s where s.id = 1));
  return new;
end;
$$;
create trigger uploads_store_default before insert on public.uploads
  for each row execute function public._upload_store_default();

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------
create function public._storage_lock() returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('zephyr:storage-migration', 0));
$$;

-- Every byte of a photo on its store: original, variants, edited variants, masks.
create function public._photo_store_bytes(p public.photos) returns bigint
language sql stable set search_path = '' as $$
  select p.size_bytes + p.thumb_bytes + p.preview_bytes
         + coalesce((select e.thumb_bytes + e.preview_bytes from public.photo_edits e where e.photo_id = p.id), 0)
         + coalesce((select sum(m.bytes) from public.photo_masks m where m.photo_id = p.id), 0);
$$;

create function public._photo_stamp(p_photo uuid) returns timestamptz
language sql stable set search_path = '' as $$
  select greatest(p.created_at,
                  (select e.updated_at from public.photo_edits e where e.photo_id = p.id),
                  (select max(m.created_at) from public.photo_masks m where m.photo_id = p.id))
    from public.photos p where p.id = p_photo;
$$;

-- StorageMigration.
create function public._migration_json(m public.storage_migrations) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', m.id, 'from', m.from_store, 'to', m.to_store, 'state', m.state,
    'startedAt', m.started_at, 'startedBy', public._staff_name(m.started_by),
    'photos', jsonb_build_object(
      'total', (select count(*) from public.storage_migration_items i where i.migration_id = m.id and i.state <> 'skipped'),
      'copied', (select count(*) from public.storage_migration_items i where i.migration_id = m.id and i.state in ('copied', 'verified', 'deleted')),
      'verified', (select count(*) from public.storage_migration_items i where i.migration_id = m.id and i.state in ('verified', 'deleted')),
      'failed', (select count(*) from public.storage_migration_items i where i.migration_id = m.id and i.state = 'failed')),
    'bytes', jsonb_build_object(
      'total', coalesce((select sum(coalesce(nullif(i.bytes, 0), public._photo_store_bytes(p)))
                           from public.storage_migration_items i left join public.photos p on p.id = i.photo_id
                          where i.migration_id = m.id and i.state <> 'skipped'), 0),
      'copied', coalesce((select sum(i.bytes) from public.storage_migration_items i
                           where i.migration_id = m.id and i.state in ('copied', 'verified', 'deleted')), 0)),
    'deleteOldAfter', m.delete_old_after, 'lastError', m.last_error);
$$;

-- After an item changes: moves the migration on when nothing is left to copy.
create function public._migration_progress(p_migration uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  m public.storage_migrations;
  open_ integer;
  copied integer;
  failed integer;
begin
  select * into m from public.storage_migrations where id = p_migration for update;
  if m.state not in ('copying', 'verifying', 'rolling_back') then return; end if;
  select count(*) filter (where state = 'pending'), count(*) filter (where state = 'copied'), count(*) filter (where state = 'failed')
    into open_, copied, failed
    from public.storage_migration_items where migration_id = p_migration;
  if open_ > 0 then return; end if;
  if copied > 0 then
    if m.state = 'copying' then update public.storage_migrations set state = 'verifying' where id = p_migration; end if;
    return;
  end if;
  if failed > 0 then
    update public.storage_migrations set state = 'failed', last_error = coalesce(last_error, 'copy_failed') where id = p_migration;
    perform public._audit(null, 'storage.migration_failed', p_migration::text, jsonb_build_object('failed', failed));
    return;
  end if;
  update public.storage_migrations
     set state = case when m.state = 'rolling_back' then 'rolled_back' else 'holding' end,
         delete_old_after = now() + interval '7 days', last_error = null
   where id = p_migration;
  perform public._audit(null, case when m.state = 'rolling_back' then 'storage.rolled_back' else 'storage.verified' end,
                        p_migration::text, '{}'::jsonb);
end;
$$;

-- Photos still on the store being emptied that aren't queued yet (uploads that were in progress at the switch,
-- or, during a rollback, photos uploaded to the new store meanwhile): queued so that store can be emptied.
-- Returns how many were added.
create function public._migration_top_up(m public.storage_migrations) returns integer
language plpgsql volatile set search_path = '' as $$
declare
  n integer;
  v_src text := case when m.state = 'rolling_back' then m.to_store else m.from_store end;
  v_dst text := case when m.state = 'rolling_back' then m.from_store else m.to_store end;
begin
  insert into public.storage_migration_items (migration_id, photo_id, owner_id, src, dst)
  select m.id, p.id, p.owner_id, p.store_id, v_dst
    from public.photos p
   where p.store_id = v_src and p.status in ('ready', 'trashed')
  on conflict (migration_id, photo_id) do update
    set state = 'pending', src = excluded.src, dst = excluded.dst, lease_until = null,
        cleanup_store = null, cleaned_at = null, attempts = 0, error = null, updated_at = now()
   where public.storage_migration_items.state in ('verified', 'deleted', 'skipped');
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Admin and the API's storage jobs
-- ---------------------------------------------------------------------------------------------
-- Objects and bytes per store: [{ storeId, objects, bytes }] ("objects" counts photos; each photo is a handful of
-- keys under one prefix). Photos being purged still count until their row goes.
create function public.storage_usage() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('storeId', x.store_id, 'objects', x.n, 'bytes', x.b) order by x.store_id), '[]'::jsonb)
    from (select p.store_id, count(*) as n, sum(public._photo_store_bytes(p))::bigint as b
            from public.photos p where p.status <> 'uploading' group by p.store_id) x;
$$;

-- { writeStore, migration: { id, state } | null } (the active migration, for the API's cron and uploads).
create function public.storage_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('writeStore', s.write_store,
    'migration', (select jsonb_build_object('id', m.id, 'state', m.state) from public.storage_migrations m
                   where m.state in ('copying', 'paused', 'verifying', 'holding', 'rolling_back', 'failed')))
    from public.storage_state s where s.id = 1;
$$;

-- The database's half of AdminStorageResult: { writeStore, migration: StorageMigration | null (the latest),
-- usage: [{ storeId, objects, bytes }], checks: [{ storeId, result: StoreCheck }] (the latest per store),
-- totals: { photos, bytes }, autoReadOnly }, or null when the staff member may not see Storage. The API adds each
-- configured store's name, kind, connection, cost and health.
create function public.admin_storage(p_staff uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'writeStore', (select s.write_store from public.storage_state s where s.id = 1),
    'migration', (select public._migration_json(m) from public.storage_migrations m order by m.started_at desc limit 1),
    'usage', public.storage_usage(),
    'checks', coalesce((select jsonb_agg(jsonb_build_object('storeId', c.store_id, 'result', c.result || jsonb_build_object('at', c.at))
                                         order by c.store_id)
                          from (select distinct on (store_id) * from public.storage_checks order by store_id, id desc) c), '[]'::jsonb),
    'totals', jsonb_build_object('photos', (select count(*) from public.photos p where p.status <> 'uploading'),
                                 'bytes', coalesce((select sum(public._photo_store_bytes(p)) from public.photos p where p.status <> 'uploading'), 0)),
    'autoReadOnly', (select coalesce((a.read_only ->> 'on')::boolean and (a.read_only ->> 'auto')::boolean, false)
                       from public.app_settings a where a.id = 1))
   where public._staff_can(p_staff, 'storage');
$$;

-- Records a health check (API cron or Admin "check now"; p_result is a StoreCheck, `at` is set here). Keeps the
-- last 50 per store. Returns { failStreak, okStreak, autoReadOnly }: the run of failed (or healthy) checks ending
-- with this one, and whether automatic read-only is on now. The API applies the rule (3 failures on the write
-- store → read_only_auto(true) and email the Owners; 2 successes → read_only_auto(false)).
create function public.storage_check_record(p_store text, p_result jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  f integer := 0;
  s integer := 0;
  r record;
  ok boolean;
begin
  if not public._store_id_ok(p_store) or p_result is null or jsonb_typeof(p_result) <> 'object' then
    raise exception 'bad check' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.storage_checks (store_id, result) values (p_store, p_result - 'at');
  delete from public.storage_checks where store_id = p_store
     and id < (select min(x.id) from (select id from public.storage_checks where store_id = p_store order by id desc limit 50) x);
  for r in select result from public.storage_checks where store_id = p_store order by id desc limit 10 loop
    ok := coalesce((r.result ->> 'reachable')::boolean, false) and coalesce((r.result ->> 'roundTrip')::boolean, false);
    if ok then
      exit when f > 0;
      s := s + 1;
    else
      exit when s > 0;
      f := f + 1;
    end if;
  end loop;
  return jsonb_build_object('failStreak', f, 'okStreak', s,
    'autoReadOnly', (select coalesce((a.read_only ->> 'on')::boolean and (a.read_only ->> 'auto')::boolean, false)
                       from public.app_settings a where a.id = 1));
end;
$$;

-- Switches the write store and moves every photo there (the API checks the passkey, that p_to is a configured
-- store and that its last check was healthy). One migration at a time, and not while an earlier one still has
-- old copies to delete. { migrationId, from, to } or { error: forbidden | invalid | conflict }.
create function public.storage_switch(p_staff uuid, p_to text, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  cur text;
  m public.storage_migrations;
  n integer;
begin
  if not public._staff_can(p_staff, 'storage') then return jsonb_build_object('error', 'forbidden'); end if;
  if p_to is null or not public._store_id_ok(p_to) or p_reason is null or length(btrim(p_reason)) not between 3 and 300 then
    return jsonb_build_object('error', 'invalid');
  end if;
  perform public._storage_lock();
  select write_store into cur from public.storage_state where id = 1 for update;
  if cur = p_to then return jsonb_build_object('error', 'invalid'); end if;
  if exists (select 1 from public.storage_migrations where state in ('copying', 'paused', 'verifying', 'holding', 'rolling_back', 'failed'))
     or exists (select 1 from public.storage_migration_items where cleanup_store is not null and cleaned_at is null) then
    return jsonb_build_object('error', 'conflict');
  end if;
  update public.storage_state set write_store = p_to, updated_at = now(), updated_by = p_staff where id = 1;
  insert into public.storage_migrations (from_store, to_store, started_by, reason)
  values (cur, p_to, p_staff, btrim(p_reason)) returning * into m;
  n := public._migration_top_up(m);
  -- Nothing to move: done at once. (Photos on a third store stay there; they're read from their own store.)
  if n = 0 then
    update public.storage_migrations set state = 'done', finished_at = now() where id = m.id;
  end if;
  perform public._audit(p_staff, 'storage.switch', m.id::text,
                        jsonb_build_object('from', cur, 'to', p_to, 'photos', n, 'reason', btrim(p_reason)));
  return jsonb_build_object('migrationId', m.id, 'from', cur, 'to', p_to);
end;
$$;

-- Claims up to p_limit items for the queue consumer with a 10-minute lease: a claimed item isn't handed out again
-- until its lease runs out (SKIP LOCKED keeps two concurrent claims apart), so a crashed consumer never strands
-- one. Photos that went away are skipped first. [{ photoId, ownerId, from, to, attempts }]; empty unless the
-- migration is copying or rolling back.
create function public.storage_migration_batch(p_migration uuid, p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  m public.storage_migrations;
  items jsonb;
begin
  select * into m from public.storage_migrations where id = p_migration;
  if not found then return '[]'::jsonb; end if;
  -- Late arrivals on the store being emptied (uploads that were in progress at the switch, photos uploaded to the
  -- new store before a rollback) are queued; they reopen a holding migration, whose old copies must wait.
  if m.state = 'rolling_back' then
    perform public._migration_top_up(m);
  elsif m.state in ('copying', 'verifying', 'holding') and public._migration_top_up(m) > 0 and m.state <> 'copying' then
    update public.storage_migrations set state = 'copying', delete_old_after = null where id = m.id and state in ('verifying', 'holding');
    m.state := 'copying';
  end if;
  if m.state not in ('copying', 'verifying', 'rolling_back') then return '[]'::jsonb; end if;
  -- Photos purged or being purged: nothing to copy; a partial copy on the destination is cleaned up.
  update public.storage_migration_items i
     set state = 'skipped', lease_until = null, updated_at = now(), cleanup_store = case when i.attempts > 0 then i.dst end
   where i.migration_id = p_migration and i.state in ('pending', 'copied')
     and not exists (select 1 from public.photos p where p.id = i.photo_id and p.status in ('ready', 'trashed'));
  with c as (
    select i.photo_id from public.storage_migration_items i
     where i.migration_id = p_migration and i.state = 'pending' and (i.lease_until is null or i.lease_until < now())
     order by i.updated_at, i.photo_id
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
     for update skip locked
  ), u as (
    update public.storage_migration_items i
       set lease_until = now() + interval '10 minutes', attempts = i.attempts + 1,
           stamp = public._photo_stamp(i.photo_id), updated_at = now()
      from c where i.migration_id = p_migration and i.photo_id = c.photo_id
    returning i.photo_id, i.owner_id, i.src, i.dst, i.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object('photoId', u.photo_id, 'ownerId', u.owner_id, 'from', u.src, 'to', u.dst,
                                               'attempts', u.attempts)), '[]'::jsonb)
    into items from u;
  perform public._migration_progress(p_migration);
  return items;
end;
$$;

-- The consumer reports an item:
--   verified: every object's hash matched on the destination. Flips photos.store_id under the photo's row lock in
--             the same transaction, only while the photo is still on the source and unchanged since the claim
--             (an edit or mask written meanwhile sends it back to pending, to be copied again);
--   pending:  try again after p_retry_after_s seconds (backoff chosen by the consumer);
--   failed:   gave up (shown in Admin; "retry" requeues it);
--   deleted:  the old copy listed by storage_old_copies_due is gone (refused if the photo is on that store again).
-- Returns { state, flipped }, or null for an unknown item or a deletion that wasn't due.
create function public.storage_item_mark(p_migration uuid, p_photo uuid, p_state text, p_bytes bigint, p_error text,
                                         p_retry_after_s integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  it public.storage_migration_items;
  ph public.photos;
  st text;
begin
  if p_state not in ('verified', 'pending', 'failed', 'deleted') then
    raise exception 'bad state' using errcode = 'invalid_parameter_value';
  end if;
  select * into it from public.storage_migration_items where migration_id = p_migration and photo_id = p_photo for update;
  if not found then return null; end if;

  if p_state = 'deleted' then
    if it.cleanup_store is null or it.cleaned_at is not null
       or exists (select 1 from public.photos p where p.id = p_photo and p.store_id = it.cleanup_store) then
      return null;
    end if;
    update public.storage_migration_items
       set cleaned_at = now(), state = case when state = 'verified' then 'deleted' else state end, updated_at = now()
     where migration_id = p_migration and photo_id = p_photo returning state into st;
    if not exists (select 1 from public.storage_migration_items where migration_id = p_migration and cleanup_store is not null and cleaned_at is null) then
      update public.storage_migrations set state = case when state = 'holding' then 'done' else state end, finished_at = now()
       where id = p_migration and state in ('holding', 'rolled_back') and finished_at is null;
      if found then perform public._audit(null, 'storage.old_copies_deleted', p_migration::text, '{}'::jsonb); end if;
    end if;
    return jsonb_build_object('state', st, 'flipped', false);
  end if;

  -- A report for an item that's no longer being copied (a rollback, or a late duplicate report) changes nothing.
  if it.state <> 'pending' then return jsonb_build_object('state', it.state, 'flipped', false); end if;

  if p_state = 'pending' then
    update public.storage_migration_items
       set lease_until = now() + make_interval(secs => least(greatest(coalesce(p_retry_after_s, 60), 0), 86400)),
           error = left(p_error, 200), updated_at = now()
     where migration_id = p_migration and photo_id = p_photo;
    if p_error is not null then update public.storage_migrations set last_error = left(p_error, 200) where id = p_migration; end if;
    return jsonb_build_object('state', 'pending', 'flipped', false);
  end if;

  if p_state = 'failed' then
    update public.storage_migration_items set state = 'failed', lease_until = null, error = left(coalesce(p_error, 'copy_failed'), 200), updated_at = now()
     where migration_id = p_migration and photo_id = p_photo;
    update public.storage_migrations set last_error = left(coalesce(p_error, 'copy_failed'), 200) where id = p_migration;
    perform public._migration_progress(p_migration);
    return jsonb_build_object('state', 'failed', 'flipped', false);
  end if;

  -- verified
  select * into ph from public.photos where id = p_photo for update;
  if not found or ph.status not in ('ready', 'trashed') then
    update public.storage_migration_items set state = 'skipped', lease_until = null, cleanup_store = it.dst, updated_at = now()
     where migration_id = p_migration and photo_id = p_photo;
    perform public._migration_progress(p_migration);
    return jsonb_build_object('state', 'skipped', 'flipped', false);
  end if;
  if ph.store_id <> it.src or public._photo_stamp(p_photo) is distinct from it.stamp then
    update public.storage_migration_items set lease_until = null, updated_at = now()
     where migration_id = p_migration and photo_id = p_photo;
    return jsonb_build_object('state', 'pending', 'flipped', false);
  end if;
  update public.photos set store_id = it.dst where id = p_photo;
  update public.storage_migration_items
     set state = 'verified', bytes = greatest(coalesce(p_bytes, it.bytes), 0), lease_until = null,
         error = null, cleanup_store = it.src, cleaned_at = null, updated_at = now()
   where migration_id = p_migration and photo_id = p_photo;
  perform public._migration_progress(p_migration);
  return jsonb_build_object('state', 'verified', 'flipped', true);
end;
$$;

-- pause | resume | retry | rollback (the API checks the passkey for rollback). Rollback sends writes back to the
-- source and copies the photos already moved back the same way; copies no longer needed are deleted after the
-- hold. { migrationId, from, to } or { error: forbidden | invalid | not_found | conflict }.
create function public.storage_migration_action(p_staff uuid, p_action text, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  m public.storage_migrations;
begin
  if not public._staff_can(p_staff, 'storage') then return jsonb_build_object('error', 'forbidden'); end if;
  if p_action not in ('pause', 'resume', 'retry', 'rollback') or p_reason is null or length(btrim(p_reason)) not between 3 and 300 then
    return jsonb_build_object('error', 'invalid');
  end if;
  perform public._storage_lock();
  select * into m from public.storage_migrations
   where state in ('copying', 'paused', 'verifying', 'holding', 'rolling_back', 'failed') for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if p_action = 'pause' then
    if m.state not in ('copying', 'verifying') then return jsonb_build_object('error', 'conflict'); end if;
    update public.storage_migrations set state = 'paused' where id = m.id;
  elsif p_action in ('resume', 'retry') then
    if m.state not in ('paused', 'failed') then return jsonb_build_object('error', 'conflict'); end if;
    update public.storage_migration_items set state = 'pending', attempts = 0, error = null, lease_until = null, updated_at = now()
     where migration_id = m.id and state = 'failed';
    update public.storage_migrations set state = 'copying', last_error = null where id = m.id;
    perform public._migration_progress(m.id);
  else
    if m.state = 'rolling_back' then return jsonb_build_object('error', 'conflict'); end if;
    update public.storage_state set write_store = m.from_store, updated_at = now(), updated_by = p_staff where id = 1;
    -- Moved photos come back (their old copy may be gone already, so they're copied, not just flipped).
    update public.storage_migration_items
       set src = dst, dst = src, state = 'pending', attempts = 0, error = null, lease_until = null,
           cleanup_store = null, cleaned_at = null, bytes = 0, stamp = null, updated_at = now()
     where migration_id = m.id and state in ('verified', 'deleted');
    -- Not moved yet: they stay put; a partial copy on the destination is cleaned up.
    update public.storage_migration_items
       set state = 'skipped', lease_until = null, updated_at = now(),
           cleanup_store = case when attempts > 0 or state = 'copied' then dst end
     where migration_id = m.id and state in ('pending', 'copied', 'failed');
    update public.storage_migrations set state = 'rolling_back', delete_old_after = null, last_error = null where id = m.id
      returning * into m;
    -- Photos uploaded to the new store since the switch go back too.
    perform public._migration_top_up(m);
    perform public._migration_progress(m.id);
  end if;
  perform public._audit(p_staff, 'storage.migration_' || p_action, m.id::text, jsonb_build_object('reason', btrim(p_reason)));
  return jsonb_build_object('migrationId', m.id, 'from', m.from_store, 'to', m.to_store);
end;
$$;

-- Old copies to delete, once a migration is holding (every photo verified) or rolled back and its hold has passed:
-- [{ migrationId, photoId, ownerId, from, to }]. `from` is the store holding the copy to delete; `to` is the store
-- the photo is on now (the other end of the move for a photo that's gone). Never a copy on the photo's current
-- store. Report each with storage_item_mark(..., 'deleted', ...).
create function public.storage_old_copies_due(p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('migrationId', x.migration_id, 'photoId', x.photo_id, 'ownerId', x.owner_id,
                                               'from', x.cleanup_store,
                                               'to', coalesce(x.cur, case when x.cleanup_store = x.src then x.dst else x.src end))), '[]'::jsonb)
    from (select i.*, (select p.store_id from public.photos p where p.id = i.photo_id) as cur
            from public.storage_migration_items i
            join public.storage_migrations m on m.id = i.migration_id
           where m.state in ('holding', 'done', 'rolled_back') and m.delete_old_after <= now()
             and i.cleanup_store is not null and i.cleaned_at is null
             and not exists (select 1 from public.photos p where p.id = i.photo_id and p.store_id = i.cleanup_store)
             and not exists (select 1 from public.storage_migration_items o
                              where o.migration_id = i.migration_id and o.state in ('pending', 'copied', 'failed'))
           order by i.migration_id, i.photo_id
           limit least(greatest(coalesce(p_limit, 100), 1), 1000)) x;
$$;

-- ---------------------------------------------------------------------------------------------
-- storeId in the existing functions' results
-- ---------------------------------------------------------------------------------------------
-- Each earlier function is kept under a private name and wrapped, so its behaviour is unchanged and its JSON
-- gains `storeId`: the store of the photo (or of the upload) the keys belong to. Gallery renders and renditions
-- (u/<owner>/g/…, zephyr-shared) stay on R2.
create function public._photo_store(p_photo uuid) returns text
language sql stable set search_path = '' as $$ select p.store_id from public.photos p where p.id = p_photo $$;

-- Adds storeId to every element of a [{ photoId, … }] array.
create function public._with_photo_stores(p_items jsonb, p_key text) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(e.value || jsonb_build_object('storeId',
                    coalesce(public._photo_store(nullif(e.value ->> p_key, '')::uuid), 'r2')) order by e.ord), '[]'::jsonb)
    from jsonb_array_elements(p_items) with ordinality e(value, ord);
$$;

alter function public.get_upload(uuid, uuid) rename to _v7_get_upload;
create function public.get_upload(p_owner uuid, p_upload uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select r || jsonb_build_object('storeId', (select u.store_id from public.uploads u where u.id = p_upload))
    from (select public._v7_get_upload(p_owner, p_upload) as r) x where r is not null;
$$;

alter function public.abort_upload(uuid, uuid) rename to _v7_abort_upload;
create function public.abort_upload(p_owner uuid, p_upload uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  st text;
  r jsonb;
begin
  select u.store_id into st from public.uploads u where u.id = p_upload and u.owner_id = p_owner;
  r := public._v7_abort_upload(p_owner, p_upload);
  return case when r is not null then r || jsonb_build_object('storeId', st) end;
end;
$$;

-- Deletes the rows it returns, so it's redefined in full (phase 2's body plus storeId).
create or replace function public.due_expired_uploads(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  o uuid;
  released bigint;
  claimed jsonb;
  result jsonb := '[]'::jsonb;
begin
  for o in select x.owner_id from (select distinct u.owner_id from public.uploads u where u.expires_at <= clock_timestamp()) x
            order by 1 limit lim loop
    exit when jsonb_array_length(result) >= lim;
    perform public._lock_storage(o);
    with picked as (
      select u.id from public.uploads u
       where u.owner_id = o and u.expires_at <= clock_timestamp()
       order by u.expires_at limit lim - jsonb_array_length(result)
       for update skip locked
    ), d as (
      delete from public.uploads u using picked where u.id = picked.id
      returning u.id, u.photo_id, u.r2_key, u.r2_upload_id, u.reserved_bytes, u.store_id
    ), gone as (
      delete from public.photos p where p.id in (select d.photo_id from d) and p.status = 'uploading'
    )
    select coalesce(sum(d.reserved_bytes), 0),
           coalesce(jsonb_agg(jsonb_build_object('uploadId', d.id, 'r2Key', d.r2_key, 'r2UploadId', d.r2_upload_id,
                                                 'keys', public._photo_keys(o, d.photo_id), 'storeId', d.store_id)), '[]'::jsonb)
      into released, claimed from d;
    update public.profiles set reserved_bytes = reserved_bytes - released where id = o;
    result := result || claimed;
  end loop;
  return result;
end;
$$;

alter function public.due_photo_purges(integer) rename to _v7_due_photo_purges;
create function public.due_photo_purges(p_limit integer) returns jsonb
language sql volatile security definer set search_path = '' as $$
  select public._with_photo_stores(public._v7_due_photo_purges(p_limit), 'photoId');
$$;

alter function public.due_publishes(integer) rename to _v7_due_publishes;
create function public.due_publishes(p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public._with_photo_stores(public._v7_due_publishes(p_limit), 'photoId');
$$;

-- Each open upload gains its store (the account's other keys are on every store its photos used: the API lists
-- the owner prefix on every configured store).
alter function public.due_account_purges(integer) rename to _v7_due_account_purges;
create function public.due_account_purges(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb := public._v7_due_account_purges(p_limit);
begin
  return (select coalesce(jsonb_agg(a.value || jsonb_build_object('uploads',
             (select coalesce(jsonb_agg(u.value || jsonb_build_object('storeId',
                       coalesce((select x.store_id from public.uploads x where x.r2_key = u.value ->> 'r2Key' limit 1), 'r2')) order by u.ord), '[]'::jsonb)
                from jsonb_array_elements(a.value -> 'uploads') with ordinality u(value, ord))) order by a.ord), '[]'::jsonb)
            from jsonb_array_elements(r) with ordinality a(value, ord));
end;
$$;

alter function public.photo_file(uuid, uuid) rename to _v7_photo_file;
create function public.photo_file(p_owner uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select r || jsonb_build_object('storeId', public._photo_store(p_id))
    from (select public._v7_photo_file(p_owner, p_id) as r) x where r is not null;
$$;

alter function public.edit_variant_check(uuid, uuid, integer, text) rename to _v7_edit_variant_check;
create function public.edit_variant_check(p_owner uuid, p_photo uuid, p_version integer, p_kind text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select r || jsonb_build_object('storeId', public._photo_store(p_photo))
    from (select public._v7_edit_variant_check(p_owner, p_photo, p_version, p_kind) as r) x where r is not null;
$$;

alter function public.ai_item_begin(uuid, bigint) rename to _v7_ai_item_begin;
create function public.ai_item_begin(p_item uuid, p_estimate bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb := public._v7_ai_item_begin(p_item, p_estimate);
begin
  if r ->> 'status' = 'go' then
    r := r || jsonb_build_object('storeId', public._photo_store((r ->> 'photoId')::uuid));
  end if;
  return r;
end;
$$;

alter function public.ai_scene_begin(uuid, uuid, bigint) rename to _v7_ai_scene_begin;
create function public.ai_scene_begin(p_owner uuid, p_photo uuid, p_estimate bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb := public._v7_ai_scene_begin(p_owner, p_photo, p_estimate);
begin
  if r ->> 'status' = 'go' then
    r := r || jsonb_build_object('storeId', public._photo_store(p_photo));
  end if;
  return r;
end;
$$;

alter function public.sweep_photo_rows(uuid[]) rename to _v7_sweep_photo_rows;
create function public.sweep_photo_rows(p_ids uuid[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public._with_photo_stores(public._v7_sweep_photo_rows(p_ids), 'id');
$$;

-- The guest media plan: source.storeId is the photo's store, except full-size gallery renders (u/<owner>/g/…),
-- which stay on R2.
alter function public.guest_media(uuid, uuid, text, boolean) rename to _v7_guest_media;
create function public.guest_media(p_gallery uuid, p_photo uuid, p_size text, p_download boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb := public._v7_guest_media(p_gallery, p_photo, p_size, p_download);
begin
  if r ? 'source' then
    r := jsonb_set(r, '{source,storeId}', to_jsonb(case when r -> 'source' ->> 'key' like 'u/%/g/%' then 'r2'
                                                        else coalesce(public._photo_store(p_photo), 'r2') end));
  end if;
  return r;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
revoke all on public.storage_state, public.storage_checks, public.storage_migrations, public.storage_migration_items
  from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on function
  public._store_id_ok(text), public._photo_store_default(), public._upload_store_default(), public._storage_lock(),
  public._photo_store_bytes(public.photos), public._photo_stamp(uuid), public._migration_json(public.storage_migrations),
  public._migration_progress(uuid), public._migration_top_up(public.storage_migrations),
  public._photo_store(uuid), public._with_photo_stores(jsonb, text),
  public._v7_get_upload(uuid, uuid), public._v7_abort_upload(uuid, uuid), public._v7_due_photo_purges(integer),
  public._v7_due_publishes(integer), public._v7_due_account_purges(integer), public._v7_photo_file(uuid, uuid),
  public._v7_edit_variant_check(uuid, uuid, integer, text), public._v7_ai_item_begin(uuid, bigint),
  public._v7_ai_scene_begin(uuid, uuid, bigint), public._v7_sweep_photo_rows(uuid[]),
  public._v7_guest_media(uuid, uuid, text, boolean)
from service_role;
grant execute on function
  public.storage_usage(),
  public.storage_status(),
  public.admin_storage(uuid),
  public.storage_check_record(text, jsonb),
  public.storage_switch(uuid, text, text),
  public.storage_migration_batch(uuid, integer),
  public.storage_item_mark(uuid, uuid, text, bigint, text, integer),
  public.storage_migration_action(uuid, text, text),
  public.storage_old_copies_due(integer),
  public.get_upload(uuid, uuid),
  public.abort_upload(uuid, uuid),
  public.due_expired_uploads(integer),
  public.due_photo_purges(integer),
  public.due_publishes(integer),
  public.due_account_purges(integer),
  public.photo_file(uuid, uuid),
  public.edit_variant_check(uuid, uuid, integer, text),
  public.ai_item_begin(uuid, bigint),
  public.ai_scene_begin(uuid, uuid, bigint),
  public.sweep_photo_rows(uuid[]),
  public.guest_media(uuid, uuid, text, boolean)
to service_role;
grant execute on function public._team_invite_usable(uuid), public._staff_invite_open(text) to supabase_auth_admin;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
