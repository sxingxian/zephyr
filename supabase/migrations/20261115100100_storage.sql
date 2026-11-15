-- Phase 8: storage stores and switching (docs/phase-8.md "Storage"). The stores themselves (endpoint, bucket,
-- connection, cost, keys) live in the API's deployment config and Worker secrets, never here: the database only
-- knows store ids. Each photo records the store holding every key under its prefix; a switch copies photos one
-- by one, flips photos.store_id only once the copy is verified, and deletes old copies only after every photo is
-- verified and STORAGE_HOLD_DAYS have passed.
--
-- Migration states: copying → (verifying) → holding → done, with paused and failed on the way, and
-- rolling_back → rolled_back. `direction` says which way photos are moving ('back' after a rollback), so a
-- failed or paused rollback resumes as a rollback. Item states: pending → verified → deleted, failed when the
-- consumer gives up, skipped when the photo went away or a rollback made the copy unnecessary.
--
-- Lock order, everywhere: the storage advisory lock (switch, actions, batch claims, old-copy claims), then the
-- migration row, then item rows, then the photo row. A photo writer (edits, masks, publishing) takes only the
-- photo row, so it and a flip are serialised by that row.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
-- The same rule as storeIdSchema (packages/shared admin-schemas.ts); secrets map dashes to underscores.
create function public._store_id_ok(p text) returns boolean
language sql immutable set search_path = '' as $$ select p ~ '^[a-z][a-z0-9-]{1,31}$' $$;

alter table public.photos add column store_id text not null default 'r2' check (public._store_id_ok(store_id));
alter table public.uploads add column store_id text not null default 'r2' check (public._store_id_ok(store_id));
create index photos_store on public.photos (store_id, status);
-- Late arrivals on a store being emptied are looked for among recent photos only.
create index photos_store_created on public.photos (store_id, created_at);

-- Every write that records an object under a photo's prefix changes the photo's stamp (see _photo_stamp): the
-- photo row's variant columns and any photo_edits write take a fresh number from one sequence, and masks are
-- stamped by their id set. A copy taken before such a write is never flipped.
create sequence public.photo_write_seq;
alter table public.photos add column write_seq bigint not null default 0;
alter table public.photo_edits add column write_seq bigint not null default 0;

create function public._photos_write_seq() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.has_thumb, new.has_preview, new.thumb_bytes, new.preview_bytes, new.publish_pending)
     is distinct from (old.has_thumb, old.has_preview, old.thumb_bytes, old.preview_bytes, old.publish_pending) then
    new.write_seq := nextval('public.photo_write_seq');
  end if;
  return new;
end;
$$;
create trigger photos_write_seq before update on public.photos
  for each row execute function public._photos_write_seq();

create function public._photo_edits_write_seq() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.write_seq := nextval('public.photo_write_seq');
  return new;
end;
$$;
create trigger photo_edits_write_seq before insert or update on public.photo_edits
  for each row execute function public._photo_edits_write_seq();

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
  -- forward: from_store → to_store; back: a rollback, to_store → from_store.
  direction text not null default 'forward' check (direction in ('forward', 'back')),
  started_by uuid not null,
  started_at timestamptz not null default now(),
  reason text not null check (length(reason) between 3 and 300),
  delete_old_after timestamptz,
  finished_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 200),
  -- When late arrivals on the store being emptied were last looked for (batches look at most every 2 minutes).
  topped_up_at timestamptz,
  -- A switch or rollback can't finish before this (2 minutes after it started): a photo whose insert read the
  -- old write store while the switch was committing is only visible to a later transaction, so finishing waits
  -- for a batch that runs after this (the 5-minute cron sends one) and looks for late arrivals first.
  settle_after timestamptz,
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
  -- The current lease's token: only the consumer holding it may report the item.
  token uuid,
  -- What the copy was taken from (_photo_stamp): a later change means copying again.
  stamp text check (stamp is null or length(stamp) <= 100),
  -- Verified copies refused because the photo changed meanwhile (an edit, a mask): each one backs off longer,
  -- and the tenth fails the item (`busy`, retryable), so a photo edited non-stop can't keep a migration open.
  stamp_misses integer not null default 0 check (stamp_misses between 0 and 1000),
  -- A store holding a copy of this photo that's no longer needed (deleted once due), when its deletion was
  -- claimed (from then on the migration can't be rolled back), and when it was done.
  cleanup_store text check (cleanup_store is null or public._store_id_ok(cleanup_store)),
  deleting_at timestamptz,
  cleaned_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (migration_id, photo_id),
  check (src <> dst)
);
alter table public.storage_migration_items enable row level security;
-- The claim walks pending items in order and stops at its limit (lease and photo checks per row).
create index storage_items_claim on public.storage_migration_items (migration_id, updated_at, photo_id) where state = 'pending';
create index storage_items_open on public.storage_migration_items (migration_id, state) where state in ('pending', 'copied', 'failed');
create index storage_items_cleanup on public.storage_migration_items (migration_id) where cleanup_store is not null and cleaned_at is null;

-- Objects a writer stored on a photo's old store after the photo moved, whose copy to the photo's store failed
-- (followMove). The 5-minute cron copies each one to wherever the photo is then, and the orphan sweep leaves
-- copies away from their photo's store alone while any are listed. No foreign key: a photo purged meanwhile
-- just drops its rows.
create table public.storage_followups (
  photo_id uuid not null,
  key text not null check (length(key) between 1 and 300),
  from_store text not null check (public._store_id_ok(from_store)),
  attempts integer not null default 0 check (attempts between 0 and 100000),
  next_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (photo_id, key, from_store)
);
alter table public.storage_followups enable row level security;
create index storage_followups_due on public.storage_followups (next_at);

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

-- Changes whenever anything under the photo's prefix is recorded or dropped: the photo row's variants
-- (write_seq), its edit row (write_seq; '-' when there's none) and its masks (the id set).
create function public._photo_stamp(p_photo uuid) returns text
language sql stable set search_path = '' as $$
  select concat_ws('/', p.write_seq,
           coalesce((select e.write_seq::text from public.photo_edits e where e.photo_id = p.id), '-'),
           coalesce((select md5(string_agg(m.id::text, ',' order by m.id)) from public.photo_masks m where m.photo_id = p.id), '-'))
    from public.photos p where p.id = p_photo;
$$;

-- The keys a verified copy must include: the original, the variants the photo has, its recorded edited
-- variants and masks.
create function public._photo_move_keys(p_photo uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_array(public._r2_prefix(p.owner_id, p.id) || 'original')
         || case when p.has_thumb then jsonb_build_array(public._r2_prefix(p.owner_id, p.id) || 'thumb') else '[]'::jsonb end
         || case when p.has_preview then jsonb_build_array(public._r2_prefix(p.owner_id, p.id) || 'preview') else '[]'::jsonb end
         || coalesce((select public._edit_keys(e) from public.photo_edits e where e.photo_id = p.id), '[]'::jsonb)
         || coalesce((select jsonb_agg(m.key order by m.created_at, m.id) from public.photo_masks m where m.photo_id = p.id), '[]'::jsonb)
    from public.photos p where p.id = p_photo;
$$;

-- A migration can be rolled back while it moves photos forward and no old copy's deletion has started.
create function public._migration_can_roll_back(m public.storage_migrations) returns boolean
language sql stable set search_path = '' as $$
  select m.direction = 'forward' and m.state in ('copying', 'paused', 'verifying', 'holding', 'failed')
     and not exists (select 1 from public.storage_migration_items i
                      where i.migration_id = m.id and (i.deleting_at is not null or i.cleaned_at is not null));
$$;

-- StorageMigration.
create function public._migration_json(m public.storage_migrations) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', m.id, 'from', m.from_store, 'to', m.to_store, 'state', m.state,
    'direction', m.direction, 'canRollBack', public._migration_can_roll_back(m),
    'startedAt', m.started_at, 'startedBy', public._staff_name(m.started_by),
    'photos', jsonb_build_object(
      'total', (select count(*) from public.storage_migration_items i where i.migration_id = m.id and i.state <> 'skipped'),
      'copied', (select count(*) from public.storage_migration_items i where i.migration_id = m.id and i.state in ('copied', 'verified', 'deleted')),
      'verified', (select count(*) from public.storage_migration_items i where i.migration_id = m.id and i.state in ('verified', 'deleted')),
      'failed', (select count(*) from public.storage_migration_items i where i.migration_id = m.id and i.state = 'failed'),
      -- Queued photos still uploading or publishing their variants: copied once they're done.
      'waiting', (select count(*) from public.storage_migration_items i join public.photos p on p.id = i.photo_id
                   where i.migration_id = m.id and i.state = 'pending' and (p.status = 'uploading' or p.publish_pending))),
    -- total is approximate while photos move: copied photos count what was copied; the rest count their
    -- original and variants (edited variants and masks show up once copied). One pass over the items.
    'bytes', jsonb_build_object(
      'total', coalesce((select sum(case when i.state in ('verified', 'deleted') then i.bytes
                                         else coalesce(p.size_bytes + p.thumb_bytes + p.preview_bytes, 0) end)
                           from public.storage_migration_items i left join public.photos p on p.id = i.photo_id
                          where i.migration_id = m.id and i.state <> 'skipped'), 0),
      'copied', coalesce((select sum(i.bytes) from public.storage_migration_items i
                           where i.migration_id = m.id and i.state in ('copied', 'verified', 'deleted')), 0)),
    'deleteOldAfter', m.delete_old_after, 'lastError', m.last_error);
$$;

-- After an item changes: moves the migration on when nothing is left to copy (never before settle_after). Only looks for open items (an
-- index lookup) and recent photos, so it costs the same for every item of a large migration. Photos still
-- uploading or publishing their variants on the store being emptied are pending items, so the migration
-- can't finish (done, holding or rolled back) while any remain; an upload that expires is purged, which
-- skips its item.
create function public._migration_progress(p_migration uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  m public.storage_migrations;
  failed integer;
  held boolean;
begin
  select * into m from public.storage_migrations where id = p_migration for update;
  if m.state not in ('copying', 'verifying', 'rolling_back') then return; end if;
  if exists (select 1 from public.storage_migration_items where migration_id = p_migration and state = 'pending') then return; end if;
  if exists (select 1 from public.storage_migration_items where migration_id = p_migration and state = 'copied') then
    if m.state = 'copying' then update public.storage_migrations set state = 'verifying' where id = p_migration; end if;
    return;
  end if;
  if exists (select 1 from public.storage_migration_items where migration_id = p_migration and state = 'failed') then
    -- The direction stays, so retrying a failed rollback carries on rolling back.
    select count(*) into failed from public.storage_migration_items where migration_id = p_migration and state = 'failed';
    update public.storage_migrations set state = 'failed', last_error = coalesce(last_error, 'copy_failed') where id = p_migration;
    perform public._audit(null, 'storage.migration_failed', p_migration::text,
                          jsonb_build_object('failed', failed, 'direction', m.direction));
    return;
  end if;
  -- Never in the transaction that started the switch or rollback, nor in the 2 minutes after it: a photo whose
  -- insert raced it is only visible later. The batch the cron sends after that finishes it.
  if m.settle_after is not null and now() < m.settle_after then return; end if;
  -- A last look for late arrivals (recent photos only, so it's cheap): one found means more to copy.
  if public._migration_top_up(m, false) > 0 then return; end if;
  held := exists (select 1 from public.storage_migration_items
                   where migration_id = p_migration and cleanup_store is not null and cleaned_at is null);
  -- Old copies wait for the 7-day hold (holding, or rolled back with clean-up pending). With none to delete a
  -- forward move is done at once, so it never blocks the next switch.
  update public.storage_migrations
     set state = case when m.direction = 'back' then 'rolled_back' when held then 'holding' else 'done' end,
         delete_old_after = case when held then now() + interval '7 days' end,
         finished_at = case when held then null else now() end, last_error = null
   where id = p_migration;
  perform public._audit(null, case when m.direction = 'back' then 'storage.rolled_back' when held then 'storage.verified' else 'storage.done' end,
                        p_migration::text, '{}'::jsonb);
end;
$$;

-- Queues the photos on the store being emptied that have no item yet. The direction, not the state, says which
-- store that is, so a paused or failed rollback stays a rollback. p_full looks at every photo there (at a switch
-- and at a rollback); otherwise only photos created since the last look (minus 10 minutes), which catches a photo
-- whose insert read the write store just before a switch committed. Photos still uploading or publishing their
-- variants are queued too: the claim leaves them alone until they're ready, and they keep the migration from
-- finishing. A photo that already has an item is never touched here (no ON CONFLICT row locks), and an item's
-- state is only changed by claims, marks and actions. Returns how many were added.
create function public._migration_top_up(m public.storage_migrations, p_full boolean) returns integer
language plpgsql volatile set search_path = '' as $$
declare
  n integer;
  v_src text := case when m.direction = 'back' then m.to_store else m.from_store end;
  v_dst text := case when m.direction = 'back' then m.from_store else m.to_store end;
begin
  insert into public.storage_migration_items (migration_id, photo_id, owner_id, src, dst)
  select m.id, p.id, p.owner_id, p.store_id, v_dst
    from public.photos p
   where p.store_id = v_src and p.status in ('uploading', 'ready', 'trashed')
     and (p_full or p.created_at >= coalesce(m.topped_up_at, m.started_at) - interval '10 minutes')
     and not exists (select 1 from public.storage_migration_items i where i.migration_id = m.id and i.photo_id = p.id)
  on conflict (migration_id, photo_id) do nothing;
  get diagnostics n = row_count;
  update public.storage_migrations set topped_up_at = now() where id = m.id;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Admin and the API's storage jobs
-- ---------------------------------------------------------------------------------------------
-- Objects and bytes per store: [{ storeId, objects, bytes }] ("objects" counts photos; each photo is a handful of
-- keys under one prefix). Photos being purged still count until their row goes. Three grouped scans (photos,
-- edits, masks), not a lookup per photo: admin_storage takes about 0.35 s with 200k photos locally (3.2 s before).
create function public.storage_usage() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('storeId', x.store_id, 'objects', x.n,
                                               'bytes', (x.b + coalesce(e.b, 0) + coalesce(k.b, 0))::bigint) order by x.store_id), '[]'::jsonb)
    from (select p.store_id, count(*) as n, sum(p.size_bytes + p.thumb_bytes + p.preview_bytes) as b
            from public.photos p where p.status <> 'uploading' group by p.store_id) x
    left join (select p.store_id, sum(ed.thumb_bytes + ed.preview_bytes) as b
                 from public.photo_edits ed join public.photos p on p.id = ed.photo_id
                where p.status <> 'uploading' group by p.store_id) e on e.store_id = x.store_id
    left join (select p.store_id, sum(mk.bytes) as b
                 from public.photo_masks mk join public.photos p on p.id = mk.photo_id
                where p.status <> 'uploading' group by p.store_id) k on k.store_id = x.store_id;
$$;

-- { writeStore, migration: { id, state } | null (the active migration), cleanupPending } for the API's cron,
-- uploads and orphan sweep. cleanupPending: some migration (rolled back or done included) still has old copies
-- waiting for deletion, or a follow-up copy is outstanding, so a copy away from its photo's store may be one
-- that's still needed.
create function public.storage_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('writeStore', s.write_store,
    'migration', (select jsonb_build_object('id', m.id, 'state', m.state) from public.storage_migrations m
                   where m.state in ('copying', 'paused', 'verifying', 'holding', 'rolling_back', 'failed')),
    'cleanupPending', exists (select 1 from public.storage_migration_items i where i.cleanup_store is not null and i.cleaned_at is null)
                      or exists (select 1 from public.storage_followups))
    from public.storage_state s where s.id = 1;
$$;

-- The current store of a photo, or null once it's gone. A writer that stored an object on the store it read
-- before recording it calls this after recording: a different answer means the photo moved in between, and the
-- writer copies its object to the new store.
create function public.storage_photo_store(p_photo uuid) returns text
language sql stable security definer set search_path = '' as $$
  select p.store_id from public.photos p where p.id = p_photo and p.status in ('uploading', 'ready', 'trashed');
$$;

-- The database's half of AdminStorageResult: { writeStore, migration: StorageMigration | null (the latest),
-- usage: [{ storeId, objects, bytes }], checks: [{ storeId, result: StoreCheck }] (the latest per store),
-- totals: { photos, bytes }, autoReadOnly, oldCopies: [{ storeId, copies, endsRollback, targets }],
-- stranded: [{ storeId, photos }], followups: { pending, dropped30d } },
-- or null when the staff member may not see Storage. The API adds each
-- configured store's name, kind, connection, cost and health.
create function public.admin_storage(p_staff uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'writeStore', (select s.write_store from public.storage_state s where s.id = 1),
    'migration', (select public._migration_json(m) from public.storage_migrations m order by m.started_at desc limit 1),
    'usage', u.j,
    'checks', coalesce((select jsonb_agg(jsonb_build_object('storeId', c.store_id, 'result', c.result || jsonb_build_object('at', c.at))
                                         order by c.store_id)
                          from (select distinct on (store_id) * from public.storage_checks order by store_id, id desc) c), '[]'::jsonb),
    'totals', jsonb_build_object('photos', coalesce((select sum((e ->> 'objects')::bigint) from jsonb_array_elements(u.j) e), 0),
                                 'bytes', coalesce((select sum((e ->> 'bytes')::bigint) from jsonb_array_elements(u.j) e), 0)),
    'autoReadOnly', (select coalesce((a.read_only ->> 'on')::boolean and (a.read_only ->> 'auto')::boolean, false)
                       from public.app_settings a where a.id = 1),
    -- Old copies still waiting for deletion, per store (an Owner can abandon them on a store that's gone).
    -- endsRollback: abandoning them would finish a migration that can still be rolled back.
    -- targets: the stores the copies' photos are on now (each copy's deletion first copies anything missing
    -- there, so a target that's gone blocks it just like the store itself).
    'oldCopies', coalesce((select jsonb_agg(jsonb_build_object('storeId', x.cleanup_store, 'copies', x.n,
                                                               'endsRollback', x.ends, 'targets', x.targets) order by x.cleanup_store)
                             from (select i.cleanup_store, count(*) as n, bool_or(public._migration_can_roll_back(m)) as ends,
                                          coalesce(jsonb_agg(distinct p.store_id) filter (where p.store_id is not null and p.store_id <> i.cleanup_store),
                                                   '[]'::jsonb) as targets
                                     from public.storage_migration_items i join public.storage_migrations m on m.id = i.migration_id
                                     left join public.photos p on p.id = i.photo_id and p.status in ('ready', 'trashed')
                                    where i.cleanup_store is not null and i.cleaned_at is null and i.state in ('verified', 'skipped')
                                      and m.state in ('holding', 'done', 'rolled_back')
                                    group by i.cleanup_store) x), '[]'::jsonb),
    -- Photos still read from a store other than the write store while no migration is moving anything (a
    -- given-up rollback leaves these on the store it was rolling back to): unreadable while that store is
    -- unreachable (Admin shows them only then). While a migration is active, photos on its source are expected.
    'stranded', coalesce((select jsonb_agg(jsonb_build_object('storeId', x.store_id, 'photos', x.n) order by x.store_id)
                            from (select p.store_id, count(*) as n
                                    from public.photos p
                                   where p.status in ('ready', 'trashed')
                                     and p.store_id <> (select s.write_store from public.storage_state s where s.id = 1)
                                     and not exists (select 1 from public.storage_migrations a
                                                      where a.state in ('copying', 'paused', 'verifying', 'rolling_back', 'failed'))
                                   group by p.store_id) x), '[]'::jsonb),
    -- Follow-up copies outstanding, and how many were dropped after 7 days in the last 30.
    'followups', jsonb_build_object(
      'pending', (select count(*) from public.storage_followups),
      'dropped30d', coalesce((select sum((a.details ->> 'count')::bigint) from public.audit_log a
                               where a.action = 'storage.followups_dropped' and a.created_at > now() - interval '30 days'), 0)))
    from (select public.storage_usage() as j) u
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
  insert into public.storage_migrations (from_store, to_store, started_by, reason, settle_after)
  values (cur, p_to, p_staff, btrim(p_reason), now() + interval '2 minutes') returning * into m;
  n := public._migration_top_up(m, true);
  -- Even with nothing to move the migration stays open until a batch after settle_after has looked for late
  -- arrivals (a photo inserted while this transaction was committing still went to the old store). (Photos
  -- on a third store stay there; they're read from their own store.)
  perform public._migration_progress(m.id);
  perform public._audit(p_staff, 'storage.switch', m.id::text,
                        jsonb_build_object('from', cur, 'to', p_to, 'photos', n, 'reason', btrim(p_reason)));
  return jsonb_build_object('migrationId', m.id, 'from', cur, 'to', p_to);
end;
$$;

-- Claims up to p_limit items for the queue consumer with a 10-minute lease and a fresh token: a claimed item
-- isn't handed out again until its lease runs out (SKIP LOCKED keeps two concurrent claims apart), so a crashed
-- consumer never strands one, and a report from an earlier lease is refused. The consumer renews each item's
-- lease with storage_item_touch just before copying it. Candidates are walked in order (an index range scan that
-- stops at the limit), and each is checked on its own: a photo that went away is skipped (a partial copy on the
-- destination is cleaned up), a photo still uploading or publishing its variants is put back for 2 minutes
-- (no attempt counted; failed with upload_stuck or publish_stuck once that's gone on for more than a day), the
-- rest are claimed. Late arrivals on the store being emptied are looked for at most
-- every 2 minutes (and at every switch and rollback, and before the migration finishes).
-- [{ photoId, ownerId, from, to, attempts, token }]; empty unless the migration is copying or rolling back.
-- Measured locally with 200k queued photos: about 4 ms a batch (2–6 s before, when every batch rescanned
-- every item and every remaining photo).
create function public.storage_migration_batch(p_migration uuid, p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  m public.storage_migrations;
  items jsonb := '[]'::jsonb;
  n integer;
  lim integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  seen integer;
  r record;
  it public.storage_migration_items;
  k integer;
begin
  perform public._storage_lock();
  select * into m from public.storage_migrations where id = p_migration for update;
  if not found then return '[]'::jsonb; end if;
  -- Late arrivals (a photo whose insert raced a switch or rollback) are queued; they reopen a holding
  -- migration, whose old copies must wait.
  if m.state in ('copying', 'verifying', 'holding', 'rolling_back')
     and (m.topped_up_at is null or m.topped_up_at < now() - interval '2 minutes') then
    n := public._migration_top_up(m, false);
    if n > 0 and m.state in ('verifying', 'holding') then
      update public.storage_migrations set state = 'copying', delete_old_after = null where id = m.id;
      m.state := 'copying';
    end if;
  end if;
  if m.state not in ('copying', 'verifying', 'rolling_back') then return '[]'::jsonb; end if;
  for k in 1..5 loop
    exit when jsonb_array_length(items) >= lim;
    seen := 0;
    for r in
      select i.photo_id, p.status, p.publish_pending, p.created_at
        from public.storage_migration_items i left join public.photos p on p.id = i.photo_id
       where i.migration_id = p_migration and i.state = 'pending' and (i.lease_until is null or i.lease_until < now())
       order by i.updated_at, i.photo_id
       limit lim - jsonb_array_length(items)
         for update of i skip locked
    loop
      seen := seen + 1;
      if r.status is null or r.status not in ('uploading', 'ready', 'trashed') then
        -- Purged or being purged: nothing to copy.
        -- A partial copy (an attempt was made) is on dst. An item a rollback reversed keeps the cleanup store it
        -- was given then: the store it had moved to still holds that copy.
        update public.storage_migration_items
           set state = 'skipped', lease_until = null, token = null, updated_at = now(),
               cleanup_store = case when attempts > 0 then dst else cleanup_store end
         where migration_id = p_migration and photo_id = r.photo_id;
      elsif (r.status = 'uploading' or r.publish_pending) and r.created_at < now() - interval '2 days' then
        -- Uploads finish within 24 hours, so this photo has been uploading, or publishing its variants, for at
        -- least a day: something is stuck (a staged variant of the wrong size, a clean-up job that can't reach
        -- its store). Failed, so Admin shows it and the migration isn't held open for ever; retryable once the
        -- clean-up job has finished or given up on the variants (after 3 days).
        update public.storage_migration_items
           set state = 'failed', lease_until = null, token = null, updated_at = now(),
               error = case when r.status = 'uploading' then 'upload_stuck' else 'publish_stuck' end
         where migration_id = p_migration and photo_id = r.photo_id;
        update public.storage_migrations
           set last_error = case when r.status = 'uploading' then 'upload_stuck' else 'publish_stuck' end
         where id = p_migration;
      elsif r.status = 'uploading' or r.publish_pending then
        update public.storage_migration_items set lease_until = now() + interval '2 minutes', updated_at = now()
         where migration_id = p_migration and photo_id = r.photo_id;
      else
        update public.storage_migration_items
           set lease_until = now() + interval '10 minutes', attempts = least(attempts + 1, 1000), token = gen_random_uuid(),
               stamp = public._photo_stamp(photo_id), updated_at = now()
         where migration_id = p_migration and photo_id = r.photo_id
        returning * into it;
        items := items || jsonb_build_array(jsonb_build_object('photoId', it.photo_id, 'ownerId', it.owner_id, 'from', it.src,
                                                               'to', it.dst, 'attempts', it.attempts, 'token', it.token));
      end if;
    end loop;
    exit when seen = 0;
  end loop;
  perform public._migration_progress(p_migration);
  return items;
end;
$$;

-- Renews one claimed item's lease (10 minutes from now) just before the consumer copies it, and takes the
-- stamp the copy is checked against then. { keys, minBytes }: the keys the copy must include and the least it
-- can weigh (the original). Null when the token isn't the item's current one or the item isn't pending (taken
-- over, rolled back, reported): the consumer skips it.
create function public.storage_item_touch(p_migration uuid, p_photo uuid, p_token uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  it public.storage_migration_items;
begin
  perform 1 from public.storage_migrations where id = p_migration for update;
  select * into it from public.storage_migration_items where migration_id = p_migration and photo_id = p_photo for update;
  if not found or it.state <> 'pending' or p_token is null or it.token is distinct from p_token then return null; end if;
  update public.storage_migration_items
     set lease_until = now() + interval '10 minutes', stamp = public._photo_stamp(p_photo), updated_at = now()
   where migration_id = p_migration and photo_id = p_photo;
  return jsonb_build_object('keys', coalesce(public._photo_move_keys(p_photo), '[]'::jsonb),
                            'minBytes', coalesce((select p.size_bytes from public.photos p where p.id = p_photo), 0));
end;
$$;

-- The consumer reports an item (p_token: the lease's token from the claim; a report from any other lease
-- changes nothing):
--   verified: every object's hash matched on the destination, including every key storage_item_touch listed,
--             and p_bytes is at least the original's size. Flips photos.store_id under the photo's row lock in
--             the same transaction, only while the photo is still on the source and unchanged since the touch
--             (an edit, variant or mask written meanwhile sends it back to pending, to be copied again after a
--             growing wait; the tenth time it fails with `busy`);
--   pending:  try again after p_retry_after_s seconds (backoff chosen by the consumer);
--   failed:   gave up (shown in Admin; "retry" requeues it).
-- And for an old copy (no token; p_store is the store whose copy was deleted):
--   deleted:  the copy claimed by storage_old_copy_claim is gone.
-- Returns { state, flipped }, or null for an unknown item or a deletion that wasn't claimed.
create function public.storage_item_mark(p_migration uuid, p_photo uuid, p_state text, p_bytes bigint, p_error text,
                                         p_retry_after_s integer, p_token uuid default null, p_store text default null)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  it public.storage_migration_items;
  ph public.photos;
  st text;
begin
  if p_state not in ('verified', 'pending', 'failed', 'deleted') then
    raise exception 'bad state' using errcode = 'invalid_parameter_value';
  end if;
  perform 1 from public.storage_migrations where id = p_migration for update;
  select * into it from public.storage_migration_items where migration_id = p_migration and photo_id = p_photo for update;
  if not found then return null; end if;

  if p_state = 'deleted' then
    if p_store is null or it.cleanup_store is distinct from p_store or it.deleting_at is null or it.cleaned_at is not null
       or it.state not in ('verified', 'skipped')
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

  -- A report for an item that's no longer being copied (a rollback, a late duplicate) or from a lease that was
  -- taken over changes nothing.
  if it.state <> 'pending' or p_token is null or it.token is distinct from p_token then
    return jsonb_build_object('state', it.state, 'flipped', false);
  end if;

  if p_state = 'pending' then
    update public.storage_migration_items
       set lease_until = now() + make_interval(secs => least(greatest(coalesce(p_retry_after_s, 60), 0), 86400)),
           token = null, error = left(p_error, 200), updated_at = now()
     where migration_id = p_migration and photo_id = p_photo;
    if p_error is not null then update public.storage_migrations set last_error = left(p_error, 200) where id = p_migration; end if;
    return jsonb_build_object('state', 'pending', 'flipped', false);
  end if;

  if p_state = 'failed' then
    update public.storage_migration_items set state = 'failed', lease_until = null, token = null,
           error = left(coalesce(p_error, 'copy_failed'), 200), updated_at = now()
     where migration_id = p_migration and photo_id = p_photo;
    update public.storage_migrations set last_error = left(coalesce(p_error, 'copy_failed'), 200) where id = p_migration;
    perform public._migration_progress(p_migration);
    return jsonb_build_object('state', 'failed', 'flipped', false);
  end if;

  -- verified
  select * into ph from public.photos where id = p_photo for update;
  if not found or ph.status not in ('ready', 'trashed') then
    update public.storage_migration_items set state = 'skipped', lease_until = null, token = null, cleanup_store = it.dst, updated_at = now()
     where migration_id = p_migration and photo_id = p_photo;
    perform public._migration_progress(p_migration);
    return jsonb_build_object('state', 'skipped', 'flipped', false);
  end if;
  -- A copy that can't hold the original isn't a copy: retried with a backoff, failed after the fifth attempt.
  if coalesce(p_bytes, 0) <= 0 or p_bytes < ph.size_bytes then
    if it.attempts >= 5 then
      update public.storage_migration_items set state = 'failed', lease_until = null, token = null, error = 'verify_incomplete', updated_at = now()
       where migration_id = p_migration and photo_id = p_photo;
      update public.storage_migrations set last_error = 'verify_incomplete' where id = p_migration;
      perform public._migration_progress(p_migration);
      return jsonb_build_object('state', 'failed', 'flipped', false);
    end if;
    update public.storage_migration_items
       set lease_until = now() + make_interval(secs => 60 * it.attempts), token = null, error = 'verify_incomplete', updated_at = now()
     where migration_id = p_migration and photo_id = p_photo;
    return jsonb_build_object('state', 'pending', 'flipped', false);
  end if;
  if ph.store_id <> it.src or public._photo_stamp(p_photo) is distinct from it.stamp then
    -- Changed while it was being copied: copied again, after a growing wait (30 s, 1 min, 2 min … at most an
    -- hour); the tenth time the item fails (`busy`), so a photo edited non-stop can't keep the migration open.
    if it.stamp_misses + 1 >= 10 then
      update public.storage_migration_items
         set state = 'failed', lease_until = null, token = null, error = 'busy',
             stamp_misses = it.stamp_misses + 1, updated_at = now()
       where migration_id = p_migration and photo_id = p_photo;
      update public.storage_migrations set last_error = 'busy' where id = p_migration;
      perform public._migration_progress(p_migration);
      return jsonb_build_object('state', 'failed', 'flipped', false);
    end if;
    update public.storage_migration_items
       set lease_until = now() + make_interval(secs => least(30 * power(2, it.stamp_misses), 3600)),
           token = null, stamp_misses = it.stamp_misses + 1, updated_at = now()
     where migration_id = p_migration and photo_id = p_photo;
    return jsonb_build_object('state', 'pending', 'flipped', false);
  end if;
  update public.photos set store_id = it.dst where id = p_photo;
  update public.storage_migration_items
     set state = 'verified', bytes = p_bytes, lease_until = null, token = null,
         error = null, cleanup_store = it.src, deleting_at = null, cleaned_at = null, updated_at = now()
   where migration_id = p_migration and photo_id = p_photo;
  perform public._migration_progress(p_migration);
  return jsonb_build_object('state', 'verified', 'flipped', true);
end;
$$;

-- pause | resume | retry | rollback (the API checks the passkey for rollback). Resume and retry carry on in the
-- migration's direction. Rollback sends writes back to the source and copies the photos already moved back the
-- same way; copies no longer needed are deleted after the hold. A rollback can't be rolled back, and once an old
-- copy's deletion has started the move can't be rolled back at all (`rollback_closed`). { migrationId, from, to }
-- or { error: forbidden | invalid | not_found | conflict | rollback_closed }.
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
    if m.state not in ('copying', 'verifying', 'rolling_back') then return jsonb_build_object('error', 'conflict'); end if;
    update public.storage_migrations set state = 'paused' where id = m.id;
  elsif p_action in ('resume', 'retry') then
    if m.state not in ('paused', 'failed') then return jsonb_build_object('error', 'conflict'); end if;
    update public.storage_migration_items
       set state = 'pending', attempts = 0, stamp_misses = 0, error = null, lease_until = null, token = null, updated_at = now()
     where migration_id = m.id and state = 'failed';
    update public.storage_migrations
       set state = case when direction = 'back' then 'rolling_back' else 'copying' end, last_error = null
     where id = m.id;
    perform public._migration_progress(m.id);
  else
    if m.direction = 'back' then return jsonb_build_object('error', 'conflict'); end if;
    if not public._migration_can_roll_back(m) then return jsonb_build_object('error', 'rollback_closed'); end if;
    update public.storage_state set write_store = m.from_store, updated_at = now(), updated_by = p_staff where id = 1;
    -- Not moved yet: they stay put; a partial copy on the destination is cleaned up. (First, so the moved photos
    -- requeued below aren't caught by it.)
    update public.storage_migration_items
       set state = 'skipped', lease_until = null, token = null, updated_at = now(),
           cleanup_store = case when attempts > 0 or state = 'copied' then dst end
     where migration_id = m.id and state in ('pending', 'copied', 'failed');
    -- Moved photos come back (their old copy is still there, but they may have changed on the new store since,
    -- so they're copied, not just flipped). Until the copy back is verified the item keeps tracking the copy on
    -- the store it had moved from (cleanup_store: its new dst; SET reads the old row), so a photo deleted
    -- meanwhile still has that copy cleaned up.
    update public.storage_migration_items
       set src = dst, dst = src, state = 'pending', attempts = 0, stamp_misses = 0, error = null, lease_until = null,
           token = null, cleanup_store = src, deleting_at = null, cleaned_at = null, bytes = 0, stamp = null, updated_at = now()
     where migration_id = m.id and state in ('verified', 'deleted');
    update public.storage_migrations
       set state = 'rolling_back', direction = 'back', delete_old_after = null, last_error = null,
           settle_after = now() + interval '2 minutes'
     where id = m.id returning * into m;
    -- Photos uploaded to the new store since the switch (finished or still uploading) go back too.
    perform public._migration_top_up(m, true);
    perform public._migration_progress(m.id);
  end if;
  perform public._audit(p_staff, 'storage.migration_' || p_action, m.id::text, jsonb_build_object('reason', btrim(p_reason)));
  return jsonb_build_object('migrationId', m.id, 'from', m.from_store, 'to', m.to_store);
end;
$$;

-- Old copies to delete, once a migration is holding (every photo verified) or rolled back and its hold has passed:
-- [{ migrationId, photoId, ownerId, from, to }]. `from` is the store holding the copy to delete; `to` is the store
-- the photo is on now (the other end of the move for a photo that's gone). Never a copy on the photo's current
-- store. Claim each with storage_old_copy_claim before deleting, then report it with storage_item_mark(...,
-- 'deleted', ..., p_store => from). A claimed copy whose report was lost is listed again.
create function public.storage_old_copies_due(p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('migrationId', x.migration_id, 'photoId', x.photo_id, 'ownerId', x.owner_id,
                                               'from', x.cleanup_store,
                                               'to', coalesce(x.cur, case when x.cleanup_store = x.src then x.dst else x.src end))), '[]'::jsonb)
    from (select i.*, (select p.store_id from public.photos p where p.id = i.photo_id) as cur
            from public.storage_migration_items i
            join public.storage_migrations m on m.id = i.migration_id
           where m.state in ('holding', 'done', 'rolled_back') and m.delete_old_after <= now()
             and i.cleanup_store is not null and i.cleaned_at is null and i.state in ('verified', 'skipped')
             and not exists (select 1 from public.photos p where p.id = i.photo_id and p.store_id = i.cleanup_store)
             and not exists (select 1 from public.storage_migration_items o
                              where o.migration_id = i.migration_id and o.state in ('pending', 'copied', 'failed'))
           order by i.migration_id, i.photo_id
           limit least(greatest(coalesce(p_limit, 100), 1), 1000)) x;
$$;

-- Claims the deletion of one old copy (p_store: the store holding it), under the storage lock, so a rollback
-- can't start in between: from the first claim on, the migration can't be rolled back. Re-checks everything
-- storage_old_copies_due did. { copyTo }: the store to copy any object missing there to before deleting (the
-- photo's own store, for a photo that moved and is still ready or in Trash), or null to just delete (a photo
-- that's gone or being purged, or a partial copy that was never used). Null when the copy isn't due (or no longer due).
create function public.storage_old_copy_claim(p_migration uuid, p_photo uuid, p_store text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  m public.storage_migrations;
  it public.storage_migration_items;
  cur text;
  st text;
begin
  perform public._storage_lock();
  select * into m from public.storage_migrations where id = p_migration for update;
  if not found or m.state not in ('holding', 'done', 'rolled_back') or m.delete_old_after is null or m.delete_old_after > now() then
    return null;
  end if;
  if exists (select 1 from public.storage_migration_items o where o.migration_id = p_migration and o.state in ('pending', 'copied', 'failed')) then
    return null;
  end if;
  select * into it from public.storage_migration_items where migration_id = p_migration and photo_id = p_photo for update;
  if not found or p_store is null or it.cleanup_store is distinct from p_store or it.cleaned_at is not null
     or it.state not in ('verified', 'skipped') then
    return null;
  end if;
  select p.store_id, p.status into cur, st from public.photos p where p.id = p_photo;
  -- A copy on the store the photo is on now is never an old copy (a photo being purged there is the purge's).
  if cur = p_store then return null; end if;
  update public.storage_migration_items set deleting_at = coalesce(deleting_at, now()), updated_at = now()
   where migration_id = p_migration and photo_id = p_photo;
  -- Copy missing objects forward only for a photo that still exists: one being purged is just deleted.
  return jsonb_build_object('copyTo', case when it.state = 'verified' and st in ('ready', 'trashed') and cur = it.dst then cur end);
end;
$$;

-- followMove couldn't copy objects it wrote to a photo's old store (p_from) after the photo moved: the 5-minute
-- cron retries them. Only keys under the photo's own prefix, at most 20 per call; a photo that's gone records
-- nothing. Returns how many keys are listed for it now.
create function public.storage_followup_add(p_photo uuid, p_from text, p_keys text[]) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  pre text;
begin
  if p_from is null or not public._store_id_ok(p_from) or p_keys is null or cardinality(p_keys) not between 1 and 20 then
    raise exception 'bad follow-up' using errcode = 'invalid_parameter_value';
  end if;
  select public._r2_prefix(p.owner_id, p.id) into pre from public.photos p where p.id = p_photo;
  if pre is null then return 0; end if;
  if exists (select 1 from unnest(p_keys) k where k is null or length(k) > 300 or left(k, length(pre)) <> pre or k like '%..%') then
    raise exception 'bad follow-up key' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.storage_followups (photo_id, key, from_store)
  select p_photo, k, p_from from unnest(p_keys) k
  on conflict (photo_id, key, from_store) do update set next_at = now();
  return (select count(*) from public.storage_followups where photo_id = p_photo);
end;
$$;

-- Follow-ups due now: [{ photoId, key, from, to }]. `to` is the photo's store now, or null once the photo is
-- gone (nothing to copy; report it done).
create function public.storage_followups_due(p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('photoId', x.photo_id, 'key', x.key, 'from', x.from_store, 'to', x.cur)), '[]'::jsonb)
    from (select f.*, (select p.store_id from public.photos p where p.id = f.photo_id and p.status in ('uploading', 'ready', 'trashed')) as cur
            from public.storage_followups f where f.next_at <= now()
           order by f.next_at, f.photo_id, f.key
           limit least(greatest(coalesce(p_limit, 50), 1), 500)) x;
$$;

-- A follow-up was handled (p_ok: copied, already there, or nothing left to copy) or failed again (retried
-- with a growing backoff, at most an hour apart).
create function public.storage_followup_done(p_photo uuid, p_key text, p_from text, p_ok boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_ok then
    delete from public.storage_followups where photo_id = p_photo and key = p_key and from_store = p_from;
  else
    update public.storage_followups
       set attempts = least(attempts + 1, 100000),
           next_at = now() + make_interval(secs => least(60 * power(2, least(attempts, 6)), 3600))
     where photo_id = p_photo and key = p_key and from_store = p_from;
  end if;
end;
$$;

-- Follow-ups older than 7 days are dropped (a store that's gone for good would otherwise keep the orphan sweep
-- off copies away from their photo's store for ever). Audited with how many went from which stores: the
-- object may be missing on its photo's store (Admin › Storage shows the count). Returns how many were dropped.
create function public.storage_followups_expire() returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  n integer;
  per jsonb;
begin
  with gone as (
    delete from public.storage_followups where created_at < now() - interval '7 days' returning from_store
  )
  select coalesce(sum(x.c), 0)::integer, coalesce(jsonb_object_agg(x.from_store, x.c), '{}'::jsonb) into n, per
    from (select g.from_store, count(*) as c from gone g group by g.from_store) x;
  if n > 0 then
    perform public._audit(null, 'storage.followups_dropped', null, jsonb_build_object('count', n, 'stores', per));
  end if;
  return n;
end;
$$;

-- An Owner gives up on the old copies still waiting for deletion on p_store, because either that store or the
-- store their photos are on now is unreachable or gone, so the 5-minute cron can never delete them (each
-- deletion first copies anything missing to the photo's store) and no later switch could start. The copies are
-- marked cleaned (error 'abandoned'; a stranded photo's item keeps 'rollback_stranded') and every held or
-- rolled-back migration with nothing else to clean finishes. p_targets: only the copies whose photo is on one of
-- these stores now (the store itself answers; those targets don't); null: every copy on p_store (the store itself
-- is gone). Nothing is deleted: the copies stay on that store, and if it comes back the orphan sweep only deletes
-- a copy once the photo's own store holds the key (copying it there first if needed). Not while a migration is
-- moving photos. Finishing a held migration that could still be rolled back ends that option, so it needs p_ack
-- (`rollback_ends` otherwise). The API checks the passkey, runs fresh health checks (the store, or else each
-- target) that must fail (or the store must be undeclared in a config that parses), and emails every Owner. Lock
-- order as everywhere: the storage lock, then the migration rows (in id order), then their items.
-- { store, copies, migrations } or { error: forbidden | invalid | conflict | not_found | rollback_ends }.
create function public.storage_abandon_old_copies(p_staff uuid, p_store text, p_reason text, p_ack boolean default false,
                                                  p_targets text[] default null)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  n integer;
  mids uuid[];
begin
  if public._staff_role_of(p_staff) is distinct from 'owner' then return jsonb_build_object('error', 'forbidden'); end if;
  if p_store is null or not public._store_id_ok(p_store) or p_reason is null or length(btrim(p_reason)) not between 3 and 300
     or (p_targets is not null and (cardinality(p_targets) not between 1 and 50
                                    or exists (select 1 from unnest(p_targets) t where t is null or not public._store_id_ok(t) or t = p_store))) then
    return jsonb_build_object('error', 'invalid');
  end if;
  perform public._storage_lock();
  if exists (select 1 from public.storage_migrations where state in ('copying', 'paused', 'verifying', 'rolling_back', 'failed')) then
    return jsonb_build_object('error', 'conflict');
  end if;
  -- The migrations holding copies on p_store, locked before any of their items (storage_item_mark takes the
  -- migration row, then the item).
  select array_agg(m.id order by m.id) into mids
    from (select m.id from public.storage_migrations m
           where m.state in ('holding', 'done', 'rolled_back')
             and exists (select 1 from public.storage_migration_items i
                          where i.migration_id = m.id and i.cleanup_store = p_store and i.cleaned_at is null
                            and i.state in ('verified', 'skipped')
                            and (p_targets is null
                                 or exists (select 1 from public.photos p where p.id = i.photo_id and p.store_id = any (p_targets))))
           order by m.id for update) m;
  if mids is null then return jsonb_build_object('error', 'not_found'); end if;
  if not coalesce(p_ack, false)
     and exists (select 1 from public.storage_migrations m where m.id = any (mids) and public._migration_can_roll_back(m)) then
    return jsonb_build_object('error', 'rollback_ends');
  end if;
  update public.storage_migration_items i
     set cleaned_at = now(), error = case when i.error = 'rollback_stranded' then i.error else 'abandoned' end, updated_at = now()
   where i.migration_id = any (mids) and i.cleanup_store = p_store and i.cleaned_at is null and i.state in ('verified', 'skipped')
     and (p_targets is null or exists (select 1 from public.photos p where p.id = i.photo_id and p.store_id = any (p_targets)));
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('error', 'not_found'); end if;
  update public.storage_migrations m
     set state = case when m.state = 'holding' then 'done' else m.state end, finished_at = now(), delete_old_after = null
   where m.id = any (mids) and m.state in ('holding', 'rolled_back') and m.finished_at is null
     and not exists (select 1 from public.storage_migration_items i
                      where i.migration_id = m.id and i.cleanup_store is not null and i.cleaned_at is null);
  perform public._audit(p_staff, 'storage.old_copies_abandoned', p_store,
                        jsonb_build_object('store', p_store, 'copies', n, 'migrations', to_jsonb(mids),
                                           'targets', to_jsonb(p_targets),
                                           'endedRollback', coalesce(p_ack, false), 'reason', btrim(p_reason)));
  return jsonb_build_object('store', p_store, 'copies', n, 'migrations', cardinality(mids));
end;
$$;

-- The stores the photos of the old copies waiting on p_store are on now (other than p_store): the API checks
-- them when p_store itself answers, since a copy can't be deleted while its photo's store can't be written.
create function public.storage_old_copy_targets(p_store text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(distinct p.store_id), '[]'::jsonb)
    from public.storage_migration_items i
    join public.storage_migrations m on m.id = i.migration_id and m.state in ('holding', 'done', 'rolled_back')
    join public.photos p on p.id = i.photo_id and p.status in ('ready', 'trashed') and p.store_id <> i.cleanup_store
   where i.cleanup_store = p_store and i.cleaned_at is null and i.state in ('verified', 'skipped');
$$;

-- An Owner gives up a failed rollback (its copies back can't succeed, e.g. the store it was rolling back to,
-- from_store, is gone for good). Uploads go back to to_store, the store the photos had moved to. Then:
--   * photos not copied back yet: their items get their forward shape again (verified onto to_store, the copy
--     on from_store being the old copy), so the old-copy deletion copies anything missing to to_store first;
--   * photos copied back whose copy on to_store is still held and that haven't changed since: flipped back to
--     to_store (that copy is the same bytes) and given the forward shape too, so nothing is left reading from
--     the store that's gone and the copy there is deleted (or abandoned) like any old copy;
--   * photos copied back that changed since (an edit or mask written to from_store): the copy on to_store is
--     older, so they stay on from_store, marked 'rollback_stranded' (Admin lists them: unreadable while that
--     store is unreachable; their old copies on to_store can be abandoned once from_store fails a check);
--   * photos uploaded to to_store during the rollback (late arrivals, never moved): skipped, with a partial
--     copy on from_store tracked for clean-up;
--   * photos the rollback skipped mid-move that are still on from_store: their copy on to_store is no longer
--     cleaned up (it may be the only readable one); the orphan sweep keeps it while from_store is unreachable.
-- The migration finishes as rolled back with error 'rollback_abandoned' (old copies wait for the hold). Lock
-- order as everywhere: the storage lock, the migration row, items, then each photo row. The API checks the
-- passkey, re-evaluates automatic read-only mode and emails every Owner.
-- { migrationId, from, to, photos, returned, stranded, edited } (photos: on to_store now; stranded: every photo
-- still read from from_store, so unreadable while it's unreachable; edited: those of them copied back and changed
-- since) or
-- { error: forbidden | invalid | not_found | conflict }.
create function public.storage_rollback_give_up(p_staff uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  m public.storage_migrations;
  kept integer;
  late integer;
  returned integer := 0;
  edited integer := 0;
  stranded integer := 0;
  held boolean;
  r record;
begin
  if public._staff_role_of(p_staff) is distinct from 'owner' then return jsonb_build_object('error', 'forbidden'); end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 300 then return jsonb_build_object('error', 'invalid'); end if;
  perform public._storage_lock();
  select * into m from public.storage_migrations
   where state in ('copying', 'paused', 'verifying', 'holding', 'rolling_back', 'failed') for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if m.direction <> 'back' or m.state <> 'failed' then return jsonb_build_object('error', 'conflict'); end if;
  update public.storage_state set write_store = m.to_store, updated_at = now(), updated_by = p_staff where id = 1;
  -- Not copied back (reversed by the rollback, which gave them from_store as their cleanup store): forward shape
  -- again. A partial copy back sits under the same prefix on from_store, so it goes with the old copy.
  update public.storage_migration_items
     set src = m.from_store, dst = m.to_store, state = 'verified', cleanup_store = m.from_store,
         error = 'rollback_abandoned', attempts = 0, stamp_misses = 0, lease_until = null, token = null,
         deleting_at = null, cleaned_at = null, updated_at = now(),
         bytes = coalesce((select p.size_bytes + p.thumb_bytes + p.preview_bytes from public.photos p
                            where p.id = storage_migration_items.photo_id), 0)
   where migration_id = m.id and state in ('pending', 'copied', 'failed')
     and src = m.to_store and dst = m.from_store and cleanup_store = m.from_store;
  get diagnostics kept = row_count;
  -- Late arrivals (uploaded to to_store during the rollback): they stay; a partial copy (an attempt was made) on
  -- from_store is cleaned up after the hold.
  update public.storage_migration_items
     set state = 'skipped', lease_until = null, token = null, updated_at = now(), error = coalesce(error, 'rollback_abandoned'),
         cleanup_store = case when attempts > 0 or state = 'copied' then dst else cleanup_store end
   where migration_id = m.id and state in ('pending', 'copied', 'failed');
  get diagnostics late = row_count;
  -- Never moved (the rollback skipped them mid-copy, tracking the partial or complete copy on to_store for
  -- clean-up) and still on from_store: that copy may now be the only readable one, so it's no longer cleaned up.
  -- The orphan sweep keeps it while from_store is unreachable (a live key away from its photo's store is only
  -- deleted once the photo's own store has it) and copies anything missing back if from_store returns.
  update public.storage_migration_items i
     set cleanup_store = null, updated_at = now()
   where i.migration_id = m.id and i.state = 'skipped' and i.src = m.from_store and i.dst = m.to_store
     and i.cleanup_store = m.to_store and i.cleaned_at is null and i.deleting_at is null
     and exists (select 1 from public.photos p
                  where p.id = i.photo_id and p.store_id = m.from_store and p.status in ('ready', 'trashed'));
  -- Copied back: flipped back to to_store when the copy there is still held and the photo is unchanged since.
  for r in
    select i.photo_id, i.stamp from public.storage_migration_items i
     where i.migration_id = m.id and i.state = 'verified' and i.src = m.to_store and i.dst = m.from_store
       and i.cleanup_store = m.to_store and i.cleaned_at is null and i.deleting_at is null
     order by i.photo_id
       for update of i
  loop
    perform 1 from public.photos p
     where p.id = r.photo_id and p.store_id = m.from_store and p.status in ('ready', 'trashed') for update;
    continue when not found;
    if r.stamp is not null and public._photo_stamp(r.photo_id) = r.stamp then
      update public.photos set store_id = m.to_store where id = r.photo_id;
      update public.storage_migration_items
         set src = m.from_store, dst = m.to_store, cleanup_store = m.from_store, error = 'rollback_abandoned',
             lease_until = null, token = null, deleting_at = null, cleaned_at = null, updated_at = now()
       where migration_id = m.id and photo_id = r.photo_id;
      returned := returned + 1;
    else
      update public.storage_migration_items set error = 'rollback_stranded', updated_at = now()
       where migration_id = m.id and photo_id = r.photo_id;
      edited := edited + 1;
    end if;
  end loop;
  -- Everything still read from from_store (never moved, uploaded there, or edited after its copy back): it
  -- can't be shown while that store is unreachable. Admin › Storage counts these per store too.
  select count(*) into stranded from public.photos p
   where p.store_id = m.from_store and p.status in ('ready', 'trashed');
  held := exists (select 1 from public.storage_migration_items
                   where migration_id = m.id and cleanup_store is not null and cleaned_at is null);
  update public.storage_migrations
     set state = 'rolled_back', last_error = 'rollback_abandoned',
         delete_old_after = case when held then now() + interval '7 days' end,
         finished_at = case when held then null else now() end
   where id = m.id;
  perform public._audit(p_staff, 'storage.rollback_abandoned', m.id::text,
                        jsonb_build_object('photos', kept + late + returned, 'returned', returned, 'stranded', stranded,
                                           'edited', edited, 'writeStore', m.to_store, 'reason', btrim(p_reason)));
  return jsonb_build_object('migrationId', m.id, 'from', m.from_store, 'to', m.to_store,
                            'photos', kept + late + returned, 'returned', returned, 'stranded', stranded, 'edited', edited);
end;
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
-- Also `stale`: the photo was created more than 3 days ago, so (uploads finish within 24 hours) its variants
-- have been waiting to publish for at least 2 days: a staged copy of the wrong size is given up on (lost).
create function public.due_publishes(p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(e.value || jsonb_build_object('stale',
                    coalesce((select p.created_at < now() - interval '3 days' from public.photos p
                               where p.id = nullif(e.value ->> 'photoId', '')::uuid), false)) order by e.ord), '[]'::jsonb)
    from jsonb_array_elements(public._with_photo_stores(public._v7_due_publishes(p_limit), 'photoId')) with ordinality e(value, ord);
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
-- With status 'exists' it also gives the recorded variant's key, so a PUT retried after a lost reply can make
-- sure that object followed the photo if it moved meanwhile.
create function public.edit_variant_check(p_owner uuid, p_photo uuid, p_version integer, p_kind text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select r || jsonb_build_object('storeId', public._photo_store(p_photo))
           || case when r ->> 'status' = 'exists' then
                coalesce((select jsonb_build_object('key', case p_kind when 'thumb' then e.thumb_key else e.preview_key end)
                            from public.photo_edits e where e.photo_id = p_photo), '{}'::jsonb)
              else '{}'::jsonb end
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
-- Also says whether the thumbnail and preview exist: the orphan sweep never deletes a copy away from the
-- photo's store that the photo still points at until the photo's store holds it.
create function public.sweep_photo_rows(p_ids uuid[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(e.value || jsonb_build_object('hasThumb', coalesce(p.has_thumb, false),
                                                          'hasPreview', coalesce(p.has_preview, false))
                            order by e.ord), '[]'::jsonb)
    from jsonb_array_elements(public._with_photo_stores(public._v7_sweep_photo_rows(p_ids), 'id'))
         with ordinality e(value, ord)
    left join public.photos p on p.id = (e.value ->> 'id')::uuid;
$$;

-- Permanent deletes ("Delete forever", "Empty Trash") name each photo's store, so the API deletes the objects
-- where they are.
alter function public.bulk_photos(uuid, uuid[], text, uuid) rename to _v7_bulk_photos;
create function public.bulk_photos(p_owner uuid, p_ids uuid[], p_action text, p_album uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb := public._v7_bulk_photos(p_owner, p_ids, p_action, p_album);
begin
  if r ? 'purge' then r := jsonb_set(r, '{purge}', public._with_photo_stores(r -> 'purge', 'photoId')); end if;
  return r;
end;
$$;

alter function public.empty_trash(uuid) rename to _v7_empty_trash;
create function public.empty_trash(p_owner uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb := public._v7_empty_trash(p_owner);
begin
  if r ? 'purge' then r := jsonb_set(r, '{purge}', public._with_photo_stores(r -> 'purge', 'photoId')); end if;
  return r;
end;
$$;

-- A mask is read from its photo's store: { key, storeId } (the phase 6 function returned the bare key).
alter function public.ai_mask_key(uuid, uuid, uuid) rename to _v7_ai_mask_key;
create function public.ai_mask_key(p_owner uuid, p_photo uuid, p_mask uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('key', k, 'storeId', coalesce(public._photo_store(p_photo), 'r2'))
    from (select public._v7_ai_mask_key(p_owner, p_photo, p_mask) as k) x where k is not null;
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
revoke all on public.storage_state, public.storage_checks, public.storage_migrations, public.storage_migration_items,
  public.storage_followups
  from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on function
  public._store_id_ok(text), public._photo_store_default(), public._upload_store_default(), public._storage_lock(),
  public._photos_write_seq(), public._photo_edits_write_seq(), public._photo_move_keys(uuid),
  public._migration_can_roll_back(public.storage_migrations),
  public._photo_store_bytes(public.photos), public._photo_stamp(uuid), public._migration_json(public.storage_migrations),
  public._migration_progress(uuid), public._migration_top_up(public.storage_migrations, boolean),
  public._photo_store(uuid), public._with_photo_stores(jsonb, text),
  public._v7_get_upload(uuid, uuid), public._v7_abort_upload(uuid, uuid), public._v7_due_photo_purges(integer),
  public._v7_due_publishes(integer), public._v7_due_account_purges(integer), public._v7_photo_file(uuid, uuid),
  public._v7_edit_variant_check(uuid, uuid, integer, text), public._v7_ai_item_begin(uuid, bigint),
  public._v7_ai_scene_begin(uuid, uuid, bigint), public._v7_sweep_photo_rows(uuid[]),
  public._v7_guest_media(uuid, uuid, text, boolean), public._v7_bulk_photos(uuid, uuid[], text, uuid),
  public._v7_empty_trash(uuid), public._v7_ai_mask_key(uuid, uuid, uuid)
from service_role;
revoke all on sequence public.photo_write_seq from public, anon, authenticated, service_role;
grant execute on function
  public.storage_usage(),
  public.storage_status(),
  public.admin_storage(uuid),
  public.storage_check_record(text, jsonb),
  public.storage_switch(uuid, text, text),
  public.storage_migration_batch(uuid, integer),
  public.storage_item_mark(uuid, uuid, text, bigint, text, integer, uuid, text),
  public.storage_item_touch(uuid, uuid, uuid),
  public.storage_old_copy_claim(uuid, uuid, text),
  public.storage_photo_store(uuid),
  public.storage_followup_add(uuid, text, text[]),
  public.storage_followups_due(integer),
  public.storage_followup_done(uuid, text, text, boolean),
  public.storage_followups_expire(),
  public.storage_abandon_old_copies(uuid, text, text, boolean, text[]), public.storage_rollback_give_up(uuid, text),
  public.storage_old_copy_targets(text),
  public.bulk_photos(uuid, uuid[], text, uuid),
  public.empty_trash(uuid),
  public.ai_mask_key(uuid, uuid, uuid),
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
