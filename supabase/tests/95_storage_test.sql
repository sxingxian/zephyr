-- Assertions for the storage migration (phase 8): per-photo stores, the write store for new uploads, switching
-- (claims with leases, verified copies flip the store, retries, failures, holding), old copies only after every
-- photo is verified plus the hold, rollback, late arrivals, usage, health checks, storeId in existing functions'
-- results, and privileges. Run with supabase/tests/run-local.sh.
\set ON_ERROR_STOP on
begin;

create function pg_temp.ok(cond boolean, what text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok - %', what;
end $$;
grant execute on function pg_temp.ok(boolean, text) to public;
create function pg_temp.photo(o uuid, n text, st text default 'ready') returns uuid language plpgsql as $$
declare id uuid;
begin
  insert into public.photos (owner_id, status, file_type, filename, size_bytes, sha256, width, height, has_thumb, has_preview, thumb_bytes, preview_bytes,
                             trashed_at, purge_after)
  values (o, st, 'jpeg', n, 1000, extensions.digest(n || o::text, 'sha256'), 4000, 3000, true, true, 100, 200,
          case when st in ('trashed', 'purging') then now() end, case when st in ('trashed', 'purging') then now() + interval '30 days' end)
  returning photos.id into id;
  update public.profiles set storage_bytes = storage_bytes + 1300 where profiles.id = o;
  return id;
end $$;
create function pg_temp.file(n text) returns jsonb language sql as $$
  select jsonb_build_object('name', n, 'type', 'jpeg', 'size', 2000, 'sha256', encode(extensions.digest(n, 'sha256'), 'hex'))
$$;

insert into auth.users (id, email, email_confirmed_at) values
  ('95000000-0000-0000-0000-000000000001', 'owner95@zephyr.test', now()),
  ('95000000-0000-0000-0000-000000000002', 'finance95@zephyr.test', now()),
  ('95000000-0000-0000-0000-000000000011', 'mei95@example.com', now());
insert into public.staff (user_id, role) values ('95000000-0000-0000-0000-000000000001', 'owner'), ('95000000-0000-0000-0000-000000000002', 'finance');
update public.profiles set plan_id = 'pro' where id = '95000000-0000-0000-0000-000000000011';
\set own '\'95000000-0000-0000-0000-000000000001\''
\set fin '\'95000000-0000-0000-0000-000000000002\''
\set mei '\'95000000-0000-0000-0000-000000000011\''

select pg_temp.photo(:mei, 'a.jpg') as pa \gset
select pg_temp.photo(:mei, 'b.jpg') as pb \gset
select pg_temp.photo(:mei, 'c.jpg', 'trashed') as pc \gset
select pg_temp.ok((select bool_and(store_id = 'r2') from public.photos where owner_id = :mei), 'photos start on R2');
select pg_temp.ok(public.storage_status() = '{"writeStore": "r2", "migration": null}'::jsonb, 'the write store is R2, no migration');
do $$ begin
  begin
    update public.photos set store_id = 'Bad Store!' where owner_id = '95000000-0000-0000-0000-000000000011';
    raise exception 'FAILED: bad store id accepted';
  exception when check_violation then raise notice 'ok - store ids are checked';
  end;
end $$;

-- An upload in progress at the switch keeps its store.
select public.create_uploads(:mei, jsonb_build_array(pg_temp.file('inflight.jpg'))) -> 'results' -> 0 as up0 \gset
select pg_temp.ok((select u.store_id = 'r2' and p.store_id = 'r2' from public.uploads u join public.photos p on p.id = u.photo_id
                    where u.id = (:'up0'::jsonb ->> 'uploadId')::uuid), 'a new upload and its photo record the write store');

-- ---- Switch -------------------------------------------------------------------------------------------
select pg_temp.ok(public.storage_switch(:fin, 'nas', 'Move to the NAS') ->> 'error' = 'forbidden', 'Finance can''t switch storage');
select pg_temp.ok(public.storage_switch(:own, 'r2', 'Same store') ->> 'error' = 'invalid'
  and public.storage_switch(:own, 'NAS!', 'Bad id') ->> 'error' = 'invalid'
  and public.storage_switch(:own, 'nas', 'x') ->> 'error' = 'invalid', 'same store, bad ids and missing reasons are refused');
select public.storage_switch(:own, 'nas', 'Move to the NAS') as sw \gset
select pg_temp.ok(:'sw'::jsonb ->> 'from' = 'r2' and :'sw'::jsonb ->> 'to' = 'nas' and :'sw'::jsonb ->> 'migrationId' is not null, 'switching returns the migration');
select (:'sw'::jsonb ->> 'migrationId') as m \gset
select pg_temp.ok(public.storage_status() = jsonb_build_object('writeStore', 'nas', 'migration', jsonb_build_object('id', :'m', 'state', 'copying')),
  'new uploads go to the new store at once');
select pg_temp.ok((select count(*) = 3 from public.storage_migration_items where migration_id = :'m'::uuid)
  and not exists (select 1 from public.storage_migration_items where migration_id = :'m'::uuid and photo_id = (:'up0'::jsonb ->> 'photoId')::uuid),
  'ready and trashed photos are queued; an upload in progress isn''t');
select pg_temp.ok(public.storage_switch(:own, 's3', 'Another') ->> 'error' = 'conflict', 'one migration at a time');
select public.create_uploads(:mei, jsonb_build_array(pg_temp.file('new.jpg'))) -> 'results' -> 0 as up1 \gset
select pg_temp.ok((select u.store_id = 'nas' and p.store_id = 'nas' from public.uploads u join public.photos p on p.id = u.photo_id
                    where u.id = (:'up1'::jsonb ->> 'uploadId')::uuid)
  and public.get_upload(:mei, (:'up1'::jsonb ->> 'uploadId')::uuid) ->> 'storeId' = 'nas'
  and public.get_upload(:mei, (:'up0'::jsonb ->> 'uploadId')::uuid) ->> 'storeId' = 'r2', 'uploads after the switch go to the new store; get_upload says which');
select pg_temp.ok(public.admin_storage(:fin) is null and public.admin_storage(:own) ->> 'writeStore' = 'nas'
  and (public.admin_storage(:own) -> 'migration' -> 'photos' ->> 'total')::int = 3
  and public.admin_storage(:own) -> 'migration' ->> 'startedBy' = 'owner95@zephyr.test', 'admin_storage (null for roles without Storage)');

-- ---- Claims and leases ----------------------------------------------------------------------------------
select public.storage_migration_batch(:'m'::uuid, 2) as b1 \gset
select pg_temp.ok(jsonb_array_length(:'b1'::jsonb) = 2 and (select bool_and(e ->> 'from' = 'r2' and e ->> 'to' = 'nas' and (e ->> 'attempts')::int = 1)
                                                            from jsonb_array_elements(:'b1'::jsonb) e), 'a batch claims items with from, to and attempts');
select public.storage_migration_batch(:'m'::uuid, 10) as b2 \gset
select pg_temp.ok(jsonb_array_length(:'b2'::jsonb) = 1 and not (:'b1'::jsonb @> jsonb_build_array(jsonb_build_object('photoId', :'b2'::jsonb -> 0 ->> 'photoId'))),
  'leased items aren''t handed out again');
select pg_temp.ok(public.storage_migration_batch(:'m'::uuid, 10) = '[]'::jsonb, 'nothing left while every lease runs');
update public.storage_migration_items set lease_until = now() - interval '1 second' where migration_id = :'m'::uuid and photo_id = (:'b2'::jsonb -> 0 ->> 'photoId')::uuid;
select pg_temp.ok((public.storage_migration_batch(:'m'::uuid, 10) -> 0 ->> 'attempts')::int = 2, 'an expired lease is claimed again (a crashed consumer strands nothing)');

-- ---- Marks ---------------------------------------------------------------------------------------------
select public.storage_item_mark(:'m'::uuid, :'pa'::uuid, 'verified', 1300, null, null) as r \gset
select pg_temp.ok(:'r'::jsonb = '{"state": "verified", "flipped": true}'::jsonb and (select store_id = 'nas' from public.photos where id = :'pa'::uuid),
  'a verified copy flips the photo''s store');
select pg_temp.ok(public.photo_file(:mei, :'pa'::uuid) ->> 'storeId' = 'nas' and public.photo_file(:mei, :'pb'::uuid) ->> 'storeId' = 'r2',
  'photo_file reads from the photo''s own store');
select pg_temp.ok(public.storage_item_mark(:'m'::uuid, :'pa'::uuid, 'verified', 1300, null, null) = '{"state": "verified", "flipped": false}'::jsonb,
  'a duplicate report changes nothing');
-- An edit recorded after the claim: copied again.
insert into public.photo_edits (photo_id, owner_id, recipe, version, updated_at) values (:'pb'::uuid, :mei, '{"v": "1"}', 1, now() + interval '1 second');
select public.storage_item_mark(:'m'::uuid, :'pb'::uuid, 'verified', 1300, null, null) as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'state' = 'pending'
  and (select store_id = 'r2' from public.photos where id = :'pb'::uuid), 'a photo changed since the claim isn''t flipped; it''s copied again');
select pg_temp.ok((select e ->> 'photoId' = :'pb' from jsonb_array_elements(public.storage_migration_batch(:'m'::uuid, 10)) e where e ->> 'photoId' = :'pb'),
  'and is claimed again');
select public.storage_item_mark(:'m'::uuid, :'pb'::uuid, 'pending', null, 'timeout', 120) as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'state' = 'pending'
  and (select lease_until between now() + interval '119 seconds' and now() + interval '121 seconds' and error = 'timeout'
         from public.storage_migration_items where migration_id = :'m'::uuid and photo_id = :'pb'::uuid), 'pending retries after the consumer''s backoff');
select pg_temp.ok(public.storage_item_mark(:'m'::uuid, :'pc'::uuid, 'failed', null, 'hash_mismatch', null) ->> 'state' = 'failed', 'an item can fail');
update public.storage_migration_items set lease_until = null where migration_id = :'m'::uuid and photo_id = :'pb'::uuid;
select public.storage_migration_batch(:'m'::uuid, 10);
select public.storage_item_mark(:'m'::uuid, :'pb'::uuid, 'verified', 1300, null, null);
select pg_temp.ok((select state = 'failed' and last_error = 'hash_mismatch' from public.storage_migrations where id = :'m'::uuid)
  and (public.admin_storage(:own) -> 'migration' -> 'photos' ->> 'failed')::int = 1, 'with only failures left the migration is failed');
select pg_temp.ok(public.storage_old_copies_due(100) = '[]'::jsonb, 'no old copy is deleted while an item failed');
select pg_temp.ok(public.storage_migration_action(:own, 'retry', 'Retry the failed photo') ->> 'migrationId' = :'m', 'retry requeues failures');
select public.storage_migration_batch(:'m'::uuid, 10);
select public.storage_item_mark(:'m'::uuid, :'pc'::uuid, 'verified', 1300, null, null);
select pg_temp.ok((select state = 'holding' and delete_old_after between now() + interval '7 days' - interval '1 minute' and now() + interval '7 days'
                     from public.storage_migrations where id = :'m'::uuid), 'every photo verified: holding for 7 days');
select pg_temp.ok(public.storage_old_copies_due(100) = '[]'::jsonb, 'old copies wait for the hold');

-- A late arrival on the old store (the upload in progress at the switch finished) reopens the migration.
update public.photos set status = 'ready' where id = (:'up0'::jsonb ->> 'photoId')::uuid;
select public.storage_migration_batch(:'m'::uuid, 10) as b3 \gset
select pg_temp.ok(:'b3'::jsonb -> 0 ->> 'photoId' = :'up0'::jsonb ->> 'photoId'
  and (select state = 'copying' and delete_old_after is null from public.storage_migrations where id = :'m'::uuid), 'late arrivals are queued and reopen a holding migration');
select public.storage_item_mark(:'m'::uuid, (:'up0'::jsonb ->> 'photoId')::uuid, 'verified', 2000, null, null);
update public.storage_migrations set delete_old_after = now() - interval '1 second' where id = :'m'::uuid;
select pg_temp.ok((select count(*) = 4 and bool_and(e ->> 'from' = 'r2' and e ->> 'to' = 'nas') from jsonb_array_elements(public.storage_old_copies_due(100)) e),
  'after the hold, every old copy on R2 is due');
-- A photo that went back to R2 by other means must never lose its R2 copy.
update public.photos set store_id = 'r2' where id = :'pa'::uuid;
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.storage_old_copies_due(100)) e where e ->> 'photoId' = :'pa')
  and public.storage_item_mark(:'m'::uuid, :'pa'::uuid, 'deleted', null, null, null) is null, 'never a copy on the store the photo is on now');
update public.photos set store_id = 'nas' where id = :'pa'::uuid;
select public.storage_item_mark(:'m'::uuid, (e ->> 'photoId')::uuid, 'deleted', null, null, null) from jsonb_array_elements(public.storage_old_copies_due(100)) e;
select pg_temp.ok((select state = 'done' and finished_at is not null from public.storage_migrations where id = :'m'::uuid)
  and public.storage_status() -> 'migration' = 'null'::jsonb
  and (select bool_and(state = 'deleted') from public.storage_migration_items where migration_id = :'m'::uuid), 'all old copies deleted: done');
select pg_temp.ok(exists (select 1 from public.audit_log where action = 'storage.switch' and kind = 'storage' and details ->> 'reason' = 'Move to the NAS'),
  'the switch is audited');

-- ---- Rollback ---------------------------------------------------------------------------------------------
select pg_temp.photo(:mei, 'd.jpg') as pd \gset
update public.photos set store_id = 'nas' where id = :'pd'::uuid;
select public.storage_switch(:own, 'cold', 'Try the cold store') ->> 'migrationId' as m2 \gset
select public.storage_migration_batch(:'m2'::uuid, 1) -> 0 ->> 'photoId' as first \gset
select public.storage_item_mark(:'m2'::uuid, :'first'::uuid, 'verified', 1300, null, null);
select public.storage_migration_batch(:'m2'::uuid, 1) -> 0 ->> 'photoId' as second \gset
select public.create_uploads(:mei, jsonb_build_array(pg_temp.file('during.jpg'))) -> 'results' -> 0 ->> 'photoId' as during \gset
update public.photos set status = 'ready' where id = :'during'::uuid;
select pg_temp.ok(public.storage_migration_action(:fin, 'rollback', 'Too slow') ->> 'error' = 'forbidden', 'Finance can''t roll back');
select public.storage_migration_action(:own, 'rollback', 'Too slow') as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'to' = 'cold' and public.storage_status() ->> 'writeStore' = 'nas',
  'rollback sends writes back to the old store');
select pg_temp.ok((select src = 'cold' and dst = 'nas' and state = 'pending' from public.storage_migration_items where migration_id = :'m2'::uuid and photo_id = :'first'::uuid)
  and (select state = 'skipped' and cleanup_store = 'cold' from public.storage_migration_items where migration_id = :'m2'::uuid and photo_id = :'second'::uuid)
  and (select src = 'cold' and dst = 'nas' from public.storage_migration_items where migration_id = :'m2'::uuid and photo_id = :'during'::uuid),
  'moved photos (and uploads made since) are copied back; a started copy is cleaned up');
select public.storage_migration_batch(:'m2'::uuid, 10) as b4 \gset
select pg_temp.ok(jsonb_array_length(:'b4'::jsonb) = 2 and (select bool_and(e ->> 'from' = 'cold' and e ->> 'to' = 'nas') from jsonb_array_elements(:'b4'::jsonb) e),
  'the copy back runs through the same pipeline');
select public.storage_item_mark(:'m2'::uuid, (e ->> 'photoId')::uuid, 'verified', 1300, null, null) from jsonb_array_elements(:'b4'::jsonb) e;
select pg_temp.ok((select state = 'rolled_back' from public.storage_migrations where id = :'m2'::uuid)
  and not exists (select 1 from public.photos where owner_id = :mei and store_id = 'cold'), 'rolled back: every photo is on the old store');
select pg_temp.ok(public.storage_switch(:own, 's3', 'Again') ->> 'error' = 'conflict', 'no new switch while old copies wait for deletion');
update public.storage_migrations set delete_old_after = now() - interval '1 second' where id = :'m2'::uuid;
select pg_temp.ok((select bool_and(e ->> 'from' = 'cold' and e ->> 'to' = 'nas') and count(*) = 3 from jsonb_array_elements(public.storage_old_copies_due(100)) e),
  'after the hold, the copies on the abandoned store are due');
select public.storage_item_mark(:'m2'::uuid, (e ->> 'photoId')::uuid, 'deleted', null, null, null) from jsonb_array_elements(public.storage_old_copies_due(100)) e;
select pg_temp.ok((select state = 'rolled_back' and finished_at is not null from public.storage_migrations where id = :'m2'::uuid), 'clean-up finishes the rollback');

-- ---- A photo purged mid-migration -------------------------------------------------------------------------
select pg_temp.photo(:mei, 'gone.jpg') as pe \gset
update public.photos set store_id = 'nas' where id = :'pe'::uuid;
select public.storage_switch(:own, 's3', 'To S3') ->> 'migrationId' as m3 \gset
-- Claim the dedicated photo first, so the purge never hits pa/pb (used by later assertions).
update public.storage_migration_items set updated_at = now() + interval '1 hour' where migration_id = :'m3'::uuid and photo_id <> :'pe'::uuid;
select public.storage_migration_batch(:'m3'::uuid, 1) -> 0 ->> 'photoId' as gone \gset
select pg_temp.ok(:'gone' = :'pe', 'the dedicated photo is claimed first');
update public.photos set status = 'purging', trashed_at = now(), purge_after = now() where id = :'gone'::uuid;
select public.storage_item_mark(:'m3'::uuid, :'gone'::uuid, 'verified', 1300, null, null) as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'state' = 'skipped'
  and (select store_id = 'nas' from public.photos where id = :'gone'::uuid)
  and (select cleanup_store = 's3' from public.storage_migration_items where migration_id = :'m3'::uuid and photo_id = :'gone'::uuid),
  'a photo being purged isn''t flipped; its new copy is cleaned up');
select pg_temp.ok(public.due_photo_purges(100) @> jsonb_build_array(jsonb_build_object('photoId', :'gone', 'storeId', 'nas')), 'purges delete on the photo''s own store');
select public.storage_migration_action(:own, 'pause', 'Pause it') as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'migrationId' = :'m3' and public.storage_migration_batch(:'m3'::uuid, 10) = '[]'::jsonb,
  'a paused migration hands out nothing');
select pg_temp.ok(public.storage_migration_action(:own, 'pause', 'Again') ->> 'error' = 'conflict'
  and public.storage_migration_action(:own, 'explode', 'Nope') ->> 'error' = 'invalid', 'bad actions are refused');

-- ---- Usage and checks -------------------------------------------------------------------------------------------
select pg_temp.ok(exists (select 1 from jsonb_array_elements(public.storage_usage()) e where e ->> 'storeId' = 'nas' and (e ->> 'objects')::int >= 5),
  'usage per store');
select public.storage_check_record('nas', '{"reachable": false, "roundTrip": false, "latencyMs": null, "error": "timeout"}');
select public.storage_check_record('nas', '{"reachable": false, "roundTrip": false, "latencyMs": null, "error": "timeout"}');
select pg_temp.ok(public.storage_check_record('nas', '{"reachable": false, "roundTrip": false, "latencyMs": null, "error": "timeout"}')
  = '{"failStreak": 3, "okStreak": 0, "autoReadOnly": false}'::jsonb, 'three failures in a row');
select public.storage_check_record('nas', '{"reachable": true, "roundTrip": true, "latencyMs": 40, "at": "1999-01-01"}') as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'okStreak' = '1'
  and (select result ? 'at' from public.storage_checks order by id desc limit 1) = false, 'a success resets the streak; `at` is set by the database');
select pg_temp.ok((select e -> 'result' ->> 'latencyMs' = '40' and e -> 'result' ? 'at' from jsonb_array_elements(public.admin_storage(:own) -> 'checks') e where e ->> 'storeId' = 'nas'),
  'the latest check per store is in admin_storage');
select public.storage_check_record('cold', '{"reachable": true, "roundTrip": true}') from generate_series(1, 55);
select pg_temp.ok((select count(*) = 50 from public.storage_checks where store_id = 'cold'), 'the last 50 checks per store are kept');
select public.read_only_auto(true, 'Write store unreachable');
select pg_temp.ok((public.storage_check_record('nas', '{"reachable": true, "roundTrip": true}') ->> 'autoReadOnly')::boolean
  and (public.admin_storage(:own) ->> 'autoReadOnly')::boolean, 'automatic read-only shows up');
select public.read_only_auto(false, 'Healthy again');

-- ---- storeId in existing functions ----------------------------------------------------------------------------------
select pg_temp.ok((select bool_and(e ? 'storeId') from jsonb_array_elements(public.sweep_photo_rows(array[:'pa', :'pb']::uuid[])) e)
  and public.edit_variant_check(:mei, :'pb'::uuid, 1, 'thumb') ->> 'storeId' = 'nas', 'the sweep and edit checks name the store');
update public.photos set publish_pending = true where id = :'pb'::uuid;
select pg_temp.ok(public.due_publishes(100) @> jsonb_build_array(jsonb_build_object('photoId', :'pb', 'storeId', 'nas')), 'pending publishes name the store');
select public.create_uploads(:mei, jsonb_build_array(pg_temp.file('abort.jpg'))) -> 'results' -> 0 as up2 \gset
select pg_temp.ok(public.abort_upload(:mei, (:'up2'::jsonb ->> 'uploadId')::uuid) ->> 'storeId' = 's3', 'abort names the upload''s store (the write store when it was made)');
update public.uploads set expires_at = now() - interval '1 second' where id = (:'up1'::jsonb ->> 'uploadId')::uuid;
select pg_temp.ok(public.due_expired_uploads(100) @> jsonb_build_array(jsonb_build_object('uploadId', :'up1'::jsonb ->> 'uploadId', 'storeId', 'nas')),
  'expired uploads name their store');
select public.create_gallery(:mei, '95600000-0000-0000-0000-000000000001', extensions.digest('tok95', 'sha256'), 'tok95', extensions.digest('ct95', 'sha256'),
  substr(extensions.digest('iv', 'sha256'), 1, 12), null, 'Shoot', null, array[:'pa']::uuid[], (now() at time zone 'utc')::date + 5, 'web', '{}'::jsonb);
select pg_temp.ok(public.guest_media('95600000-0000-0000-0000-000000000001', :'pa'::uuid, 'view', false) -> 'source' ->> 'storeId' = 'nas'
  and public.guest_media('95600000-0000-0000-0000-000000000001', :'pa'::uuid, 'view', false) -> 'source' ->> 'key' like 'u/%/p/%/preview',
  'the guest media plan reads the source from the photo''s store');
select pg_temp.ok(public.get_upload(:mei, '95000000-0000-0000-0000-00000000ffff') is null and public.photo_file(:mei, '95000000-0000-0000-0000-00000000ffff') is null,
  'unknown ids are still null');

-- ---- Privileges ----------------------------------------------------------------------------------------------------
select pg_temp.ok(not exists (
  select 1 from unnest(array['storage_state', 'storage_checks', 'storage_migrations', 'storage_migration_items']) t
   where has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')
      or has_table_privilege('authenticated', 'public.' || t, 'insert'))
  and (select bool_and(c.relrowsecurity) from pg_class c where c.relnamespace = 'public'::regnamespace
         and c.relname in ('storage_state', 'storage_checks', 'storage_migrations', 'storage_migration_items')),
  'the storage tables have RLS and nothing for anon or authenticated');
select pg_temp.ok(not has_function_privilege('service_role', 'public._v7_get_upload(uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.get_upload(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.storage_switch(uuid, text, text)', 'execute')
  and not has_function_privilege('service_role', 'public._migration_progress(uuid)', 'execute'), 'service_role only; wrapped originals are private');

rollback;
