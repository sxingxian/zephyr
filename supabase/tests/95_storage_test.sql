-- Assertions for the storage migration (phase 8): per-photo stores, the write store for new uploads, switching
-- (claims with leases and tokens, lease renewal, verified copies flip the store, stamps, retries, failures,
-- holding), old copies only after every photo is verified plus the hold (claimed first, which closes rollback),
-- rollback (and retrying a failed rollback), uploads in progress and photos still publishing (queued, waited for,
-- never finished around; failed once stuck), late arrivals, never finished in the transaction that started it,
-- reversed items keep their cleanup store, stamp misses back off and fail, done without a hold when nothing is
-- held, abandoning old copies on a dead store, follow-up copies (and dropping them after 7 days), usage, health
-- checks, storeId in existing functions' results (masks and permanent deletes included), and privileges. Run with
-- supabase/tests/run-local.sh.
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
-- The current lease token of an item (the consumer gets it from the claim).
create function pg_temp.tok(m uuid, p uuid) returns uuid language sql as $$
  select token from public.storage_migration_items where migration_id = m and photo_id = p
$$;
-- Everything here runs in one transaction, so now() never moves: a migration's settle period (2 minutes after
-- its switch or rollback) is ended by hand where a test needs it to finish.
create function pg_temp.settle(m uuid) returns void language sql as $$
  update public.storage_migrations set settle_after = now() - interval '1 second' where id = m
$$;
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
select pg_temp.ok(public.storage_status() = '{"writeStore": "r2", "migration": null, "cleanupPending": false}'::jsonb, 'the write store is R2, no migration');
select pg_temp.ok(public._store_id_ok('r2') and public._store_id_ok('studio-nas') and not public._store_id_ok('studio_nas')
  and not public._store_id_ok('a') and not public._store_id_ok('NAS'), 'store ids follow storeIdSchema (dashes, not underscores)');
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
select pg_temp.ok((select settle_after = now() + interval '2 minutes' from public.storage_migrations where id = :'m'::uuid),
  'a switch can''t finish for 2 minutes (a photo whose insert raced it is only visible to a later transaction)');
select pg_temp.settle(:'m'::uuid);
select pg_temp.ok(public.storage_status() = jsonb_build_object('writeStore', 'nas', 'migration', jsonb_build_object('id', :'m', 'state', 'copying'),
                                                                'cleanupPending', false),
  'new uploads go to the new store at once');
select pg_temp.ok((select count(*) = 4 from public.storage_migration_items where migration_id = :'m'::uuid)
  and exists (select 1 from public.storage_migration_items where migration_id = :'m'::uuid and photo_id = (:'up0'::jsonb ->> 'photoId')::uuid and state = 'pending'),
  'ready and trashed photos are queued, and so is the upload in progress (copied once it''s ready)');
select pg_temp.ok(public.storage_switch(:own, 's3', 'Another') ->> 'error' = 'conflict', 'one migration at a time');
select public.create_uploads(:mei, jsonb_build_array(pg_temp.file('new.jpg'))) -> 'results' -> 0 as up1 \gset
select pg_temp.ok((select u.store_id = 'nas' and p.store_id = 'nas' from public.uploads u join public.photos p on p.id = u.photo_id
                    where u.id = (:'up1'::jsonb ->> 'uploadId')::uuid)
  and public.get_upload(:mei, (:'up1'::jsonb ->> 'uploadId')::uuid) ->> 'storeId' = 'nas'
  and public.get_upload(:mei, (:'up0'::jsonb ->> 'uploadId')::uuid) ->> 'storeId' = 'r2', 'uploads after the switch go to the new store; get_upload says which');
select pg_temp.ok(public.admin_storage(:fin) is null and public.admin_storage(:own) ->> 'writeStore' = 'nas'
  and (public.admin_storage(:own) -> 'migration' -> 'photos' ->> 'total')::int = 4
  and (public.admin_storage(:own) -> 'migration' -> 'photos' ->> 'waiting')::int = 1
  and public.admin_storage(:own) -> 'migration' ->> 'startedBy' = 'owner95@zephyr.test'
  and public.admin_storage(:own) -> 'migration' ->> 'direction' = 'forward'
  and (public.admin_storage(:own) -> 'migration' ->> 'canRollBack')::boolean, 'admin_storage (null for roles without Storage)');

-- ---- Claims, leases and tokens ---------------------------------------------------------------------------
select public.storage_migration_batch(:'m'::uuid, 2) as b1 \gset
select pg_temp.ok(jsonb_array_length(:'b1'::jsonb) = 2 and (select bool_and(e ->> 'from' = 'r2' and e ->> 'to' = 'nas' and (e ->> 'attempts')::int = 1
                                                                            and (e ->> 'token')::uuid is not null)
                                                            from jsonb_array_elements(:'b1'::jsonb) e), 'a batch claims items with from, to, attempts and a token');
select public.storage_migration_batch(:'m'::uuid, 10) as b2 \gset
select pg_temp.ok(jsonb_array_length(:'b2'::jsonb) = 1 and not (:'b1'::jsonb @> jsonb_build_array(jsonb_build_object('photoId', :'b2'::jsonb -> 0 ->> 'photoId')))
  and not (:'b1'::jsonb || :'b2'::jsonb) @> jsonb_build_array(jsonb_build_object('photoId', :'up0'::jsonb ->> 'photoId'))
  and (select attempts = 0 and lease_until > now() from public.storage_migration_items
        where migration_id = :'m'::uuid and photo_id = (:'up0'::jsonb ->> 'photoId')::uuid),
  'leased items aren''t handed out again; the upload in progress is put back without counting an attempt');
select pg_temp.ok(public.storage_migration_batch(:'m'::uuid, 10) = '[]'::jsonb, 'nothing left while every lease runs');
select (:'b2'::jsonb -> 0 ->> 'photoId') as p2, (:'b2'::jsonb -> 0 ->> 'token') as t2 \gset
update public.storage_migration_items set lease_until = now() - interval '1 second' where migration_id = :'m'::uuid and photo_id = :'p2'::uuid;
select public.storage_migration_batch(:'m'::uuid, 10) -> 0 as again \gset
select pg_temp.ok((:'again'::jsonb ->> 'attempts')::int = 2 and :'again'::jsonb ->> 'token' <> :'t2',
  'an expired lease is claimed again with a new token (a crashed consumer strands nothing)');
select pg_temp.ok(public.storage_item_mark(:'m'::uuid, :'p2'::uuid, 'verified', 1300, null, null, :'t2'::uuid) ->> 'flipped' = 'false'
  and (select store_id = 'r2' from public.photos where id = :'p2'::uuid)
  and public.storage_item_touch(:'m'::uuid, :'p2'::uuid, :'t2'::uuid) is null,
  'the old lease''s token can''t report the item or renew its lease (a slow consumer whose lease was taken over)');
select pg_temp.ok(public.storage_item_mark(:'m'::uuid, :'p2'::uuid, 'verified', 1300, null, null) ->> 'flipped' = 'false',
  'a report without a token changes nothing');

-- ---- Lease renewal, verification and marks ------------------------------------------------------------------
select public.storage_item_touch(:'m'::uuid, :'pb'::uuid, pg_temp.tok(:'m', :'pb')) as lease \gset
select pg_temp.ok(:'lease'::jsonb -> 'keys' = jsonb_build_array('u/' || :mei || '/p/' || :'pb' || '/original', 'u/' || :mei || '/p/' || :'pb' || '/thumb',
                                                               'u/' || :mei || '/p/' || :'pb' || '/preview')
  and (:'lease'::jsonb ->> 'minBytes')::int = 1000
  and (select lease_until > now() + interval '9 minutes' from public.storage_migration_items where migration_id = :'m'::uuid and photo_id = :'pb'::uuid),
  'renewing a lease lists the keys a copy must include and the least it can weigh');
select public.storage_item_mark(:'m'::uuid, :'pb'::uuid, 'verified', 999, null, null, pg_temp.tok(:'m', :'pb')) as r \gset
select pg_temp.ok(:'r'::jsonb = '{"state": "pending", "flipped": false}'::jsonb
  and (select store_id = 'r2' from public.photos where id = :'pb'::uuid)
  and (select error = 'verify_incomplete' and token is null from public.storage_migration_items where migration_id = :'m'::uuid and photo_id = :'pb'::uuid),
  'a copy lighter than the original is never verified');
select pg_temp.ok(public.storage_item_mark(:'m'::uuid, :'pa'::uuid, 'verified', 0, null, null, pg_temp.tok(:'m', :'pa')) ->> 'state' = 'pending',
  'nor is an empty one');
update public.storage_migration_items set lease_until = null where migration_id = :'m'::uuid and photo_id in (:'pa'::uuid, :'pb'::uuid);
select public.storage_migration_batch(:'m'::uuid, 10);

select public.storage_item_mark(:'m'::uuid, :'pa'::uuid, 'verified', 1300, null, null, pg_temp.tok(:'m', :'pa')) as r \gset
select pg_temp.ok(:'r'::jsonb = '{"state": "verified", "flipped": true}'::jsonb and (select store_id = 'nas' from public.photos where id = :'pa'::uuid),
  'a verified copy flips the photo''s store');
select pg_temp.ok(public.photo_file(:mei, :'pa'::uuid) ->> 'storeId' = 'nas' and public.photo_file(:mei, :'pb'::uuid) ->> 'storeId' = 'r2'
  and public.storage_photo_store(:'pa'::uuid) = 'nas' and public.storage_photo_store('95000000-0000-0000-0000-00000000ffff') is null,
  'photo_file reads from the photo''s own store; storage_photo_store says where a photo is now');
select pg_temp.ok(public.storage_item_mark(:'m'::uuid, :'pa'::uuid, 'verified', 1300, null, null, gen_random_uuid()) = '{"state": "verified", "flipped": false}'::jsonb,
  'a duplicate report changes nothing');
-- An edit recorded after the claim (even one that doesn't touch updated_at): copied again.
select pg_temp.tok(:'m', :'pb') as tb \gset
insert into public.photo_edits (photo_id, owner_id, recipe, version) values (:'pb'::uuid, :mei, '{"v": "1"}', 1);
select public.storage_item_mark(:'m'::uuid, :'pb'::uuid, 'verified', 1300, null, null, :'tb'::uuid) as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'state' = 'pending'
  and (select store_id = 'r2' from public.photos where id = :'pb'::uuid)
  and (select stamp_misses = 1 and lease_until > now() + interval '29 seconds' from public.storage_migration_items where migration_id = :'m'::uuid and photo_id = :'pb'::uuid),
  'a photo changed since the claim isn''t flipped; it''s copied again after a wait');
update public.storage_migration_items set lease_until = null where migration_id = :'m'::uuid and photo_id = :'pb'::uuid;
select pg_temp.ok((select e ->> 'photoId' = :'pb' from jsonb_array_elements(public.storage_migration_batch(:'m'::uuid, 10)) e where e ->> 'photoId' = :'pb'),
  'and is claimed again');
select public.storage_item_mark(:'m'::uuid, :'pb'::uuid, 'pending', null, 'timeout', 120, pg_temp.tok(:'m', :'pb')) as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'state' = 'pending'
  and (select lease_until between now() + interval '119 seconds' and now() + interval '121 seconds' and error = 'timeout'
         from public.storage_migration_items where migration_id = :'m'::uuid and photo_id = :'pb'::uuid), 'pending retries after the consumer''s backoff');
select pg_temp.ok(public.storage_item_mark(:'m'::uuid, :'pc'::uuid, 'failed', null, 'hash_mismatch', null, pg_temp.tok(:'m', :'pc')) ->> 'state' = 'failed', 'an item can fail');
update public.storage_migration_items set lease_until = null where migration_id = :'m'::uuid and photo_id = :'pb'::uuid;
select public.storage_migration_batch(:'m'::uuid, 10);
select public.storage_item_mark(:'m'::uuid, :'pb'::uuid, 'verified', 1300, null, null, pg_temp.tok(:'m', :'pb'));
select pg_temp.ok((select state = 'copying' from public.storage_migrations where id = :'m'::uuid)
  and (public.admin_storage(:own) -> 'migration' -> 'photos' ->> 'waiting')::int = 1,
  'the migration doesn''t finish (or fail) while a queued upload is still in progress');
update public.photos set status = 'ready' where id = (:'up0'::jsonb ->> 'photoId')::uuid;
update public.storage_migration_items set lease_until = null where migration_id = :'m'::uuid and photo_id = (:'up0'::jsonb ->> 'photoId')::uuid;
select public.storage_migration_batch(:'m'::uuid, 10) as bu \gset
select pg_temp.ok(jsonb_array_length(:'bu'::jsonb) = 1 and :'bu'::jsonb -> 0 ->> 'photoId' = :'up0'::jsonb ->> 'photoId', 'once the upload is ready it''s claimed');
select public.storage_item_mark(:'m'::uuid, (:'up0'::jsonb ->> 'photoId')::uuid, 'verified', 2000, null, null, pg_temp.tok(:'m', (:'up0'::jsonb ->> 'photoId')::uuid));
select pg_temp.ok((select state = 'failed' and direction = 'forward' and last_error = 'hash_mismatch' from public.storage_migrations where id = :'m'::uuid)
  and (public.admin_storage(:own) -> 'migration' -> 'photos' ->> 'failed')::int = 1, 'with only failures left the migration is failed');
select pg_temp.ok(public.storage_old_copies_due(100) = '[]'::jsonb, 'no old copy is deleted while an item failed');
select pg_temp.ok(public.storage_migration_action(:own, 'retry', 'Retry the failed photo') ->> 'migrationId' = :'m', 'retry requeues failures');
select pg_temp.ok((select state = 'copying' from public.storage_migrations where id = :'m'::uuid), 'and carries on copying');
select public.storage_migration_batch(:'m'::uuid, 10);
select public.storage_item_mark(:'m'::uuid, :'pc'::uuid, 'verified', 1300, null, null, pg_temp.tok(:'m', :'pc'));
select pg_temp.ok((select state = 'holding' and delete_old_after between now() + interval '7 days' - interval '1 minute' and now() + interval '7 days'
                     from public.storage_migrations where id = :'m'::uuid), 'every photo verified: holding for 7 days');
select pg_temp.ok(public.storage_old_copies_due(100) = '[]'::jsonb and (public.storage_status() ->> 'cleanupPending')::boolean,
  'old copies wait for the hold (and the sweep knows they''re held)');

-- A late arrival on the old store (a photo whose insert read the write store just before the switch committed)
-- reopens the migration. Batches look for late arrivals at most every 2 minutes, among recent photos; a photo
-- still publishing its variants is queued but waits.
select pg_temp.photo(:mei, 'late.jpg') as pl \gset
update public.photos set store_id = 'r2' where id = :'pl'::uuid;
select pg_temp.photo(:mei, 'publishing.jpg') as pp \gset
update public.photos set store_id = 'r2', publish_pending = true where id = :'pp'::uuid;
select pg_temp.ok(public.storage_migration_batch(:'m'::uuid, 10) = '[]'::jsonb
  and (select state = 'holding' from public.storage_migrations where id = :'m'::uuid), 'late arrivals are looked for at most every 2 minutes');
update public.storage_migrations set topped_up_at = null where id = :'m'::uuid;
select public.storage_migration_batch(:'m'::uuid, 10) as b3 \gset
select pg_temp.ok(:'b3'::jsonb -> 0 ->> 'photoId' = :'pl' and jsonb_array_length(:'b3'::jsonb) = 1
  and (select state = 'copying' and delete_old_after is null from public.storage_migrations where id = :'m'::uuid), 'late arrivals are queued and reopen a holding migration');
select pg_temp.ok((select state = 'pending' and attempts = 0 from public.storage_migration_items where migration_id = :'m'::uuid and photo_id = :'pp'::uuid),
  'a photo still publishing its variants (staging copies on its store) is queued but not copied yet');
select public.storage_item_mark(:'m'::uuid, :'pl'::uuid, 'verified', 1300, null, null, pg_temp.tok(:'m', :'pl'));
select pg_temp.ok((select state = 'copying' from public.storage_migrations where id = :'m'::uuid), 'and the migration waits for it');
delete from public.photos where id = :'pp'::uuid;
update public.storage_migration_items set lease_until = null where migration_id = :'m'::uuid and photo_id = :'pp'::uuid;
select public.storage_migration_batch(:'m'::uuid, 10);
select pg_temp.ok((select state = 'skipped' and cleanup_store is null from public.storage_migration_items where migration_id = :'m'::uuid and photo_id = :'pp'::uuid)
  and (select state = 'holding' from public.storage_migrations where id = :'m'::uuid), 'a queued photo that went away is skipped (nothing was copied, nothing to clean)');
select pg_temp.ok((public.admin_storage(:own) -> 'migration' ->> 'canRollBack')::boolean, 'a holding migration can still be rolled back');
update public.storage_migrations set delete_old_after = now() - interval '1 second' where id = :'m'::uuid;
select pg_temp.ok((select count(*) = 5 and bool_and(e ->> 'from' = 'r2' and e ->> 'to' = 'nas') from jsonb_array_elements(public.storage_old_copies_due(100)) e),
  'after the hold, every old copy on R2 is due');
-- A photo that went back to R2 by other means must never lose its R2 copy.
update public.photos set store_id = 'r2' where id = :'pa'::uuid;
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.storage_old_copies_due(100)) e where e ->> 'photoId' = :'pa')
  and public.storage_old_copy_claim(:'m'::uuid, :'pa'::uuid, 'r2') is null
  and public.storage_item_mark(:'m'::uuid, :'pa'::uuid, 'deleted', null, null, null, null, 'r2') is null, 'never a copy on the store the photo is on now');
update public.photos set store_id = 'nas' where id = :'pa'::uuid;
select pg_temp.ok(public.storage_item_mark(:'m'::uuid, :'pa'::uuid, 'deleted', null, null, null, null, 'r2') is null, 'a deletion must be claimed first');
select pg_temp.ok(public.storage_old_copy_claim(:'m'::uuid, :'pa'::uuid, 'nas') is null, 'a claim names the store holding the old copy');
select pg_temp.ok(public.storage_old_copy_claim(:'m'::uuid, :'pa'::uuid, 'r2') = '{"copyTo": "nas"}'::jsonb,
  'claiming a moved photo''s old copy says where missing objects go first');
select pg_temp.ok(public.storage_migration_action(:own, 'rollback', 'Too late') ->> 'error' = 'rollback_closed', 'once an old copy is being deleted, the move can''t be rolled back');
select pg_temp.ok(public.storage_status() ->> 'writeStore' = 'nas' and not (public.admin_storage(:own) -> 'migration' ->> 'canRollBack')::boolean,
  'nothing changed, and Admin no longer offers it');
select pg_temp.ok(public.storage_item_mark(:'m'::uuid, :'pa'::uuid, 'deleted', null, null, null, null, 'nas') is null, 'a deletion reports the store it emptied');
create temp table due1 as select * from jsonb_array_elements(public.storage_old_copies_due(100)) e;
select public.storage_old_copy_claim(:'m'::uuid, (e.value ->> 'photoId')::uuid, e.value ->> 'from') from due1 e;
select public.storage_item_mark(:'m'::uuid, (e.value ->> 'photoId')::uuid, 'deleted', null, null, null, null, e.value ->> 'from') from due1 e;
select pg_temp.ok((select state = 'done' and finished_at is not null from public.storage_migrations where id = :'m'::uuid)
  and public.storage_status() -> 'migration' = 'null'::jsonb and not (public.storage_status() ->> 'cleanupPending')::boolean
  and (select bool_and(state = 'deleted') from public.storage_migration_items where migration_id = :'m'::uuid and photo_id <> :'pp'::uuid),
  'all old copies deleted: done');
select pg_temp.ok(exists (select 1 from public.audit_log where action = 'storage.switch' and kind = 'storage' and details ->> 'reason' = 'Move to the NAS'),
  'the switch is audited');

-- ---- Stamps --------------------------------------------------------------------------------------------------
select public._photo_stamp(:'pb'::uuid) as s0 \gset
update public.photos set favourite = true where id = :'pb'::uuid;
select pg_temp.ok(public._photo_stamp(:'pb'::uuid) = :'s0', 'a change that writes no object leaves the stamp alone');
update public.photos set has_thumb = false, thumb_bytes = 0 where id = :'pb'::uuid;
select public._photo_stamp(:'pb'::uuid) as s1 \gset
update public.photo_edits set version = version where photo_id = :'pb'::uuid;
select public._photo_stamp(:'pb'::uuid) as s2 \gset
insert into public.photo_masks (id, photo_id, owner_id, key, bytes, width, height, provider)
values ('95700000-0000-0000-0000-000000000001', :'pb'::uuid, :mei, public._mask_key(:mei, :'pb'::uuid, '95700000-0000-0000-0000-000000000001'), 10, 2, 2, 'runware');
select public._photo_stamp(:'pb'::uuid) as s3 \gset
select pg_temp.ok(:'s1' <> :'s0' and :'s2' <> :'s1' and :'s3' <> :'s2',
  'the stamp changes with the photo''s variants, any edit-row write (record_edit_variant doesn''t touch updated_at) and its masks');
update public.photos set has_thumb = true, thumb_bytes = 100 where id = :'pb'::uuid;

-- ---- Masks are read from their photo's store ------------------------------------------------------------------------
insert into public.photo_masks (id, photo_id, owner_id, key, bytes, width, height, provider)
values ('95700000-0000-0000-0000-000000000002', :'pa'::uuid, :mei, public._mask_key(:mei, :'pa'::uuid, '95700000-0000-0000-0000-000000000002'), 10, 2, 2, 'runware');
select pg_temp.ok(public.ai_mask_key(:mei, :'pa'::uuid, '95700000-0000-0000-0000-000000000002')
                    = jsonb_build_object('key', public._mask_key(:mei, :'pa'::uuid, '95700000-0000-0000-0000-000000000002'), 'storeId', 'nas')
  and public.ai_mask_key(:fin, :'pa'::uuid, '95700000-0000-0000-0000-000000000002') is null,
  'a mask''s key comes with its photo''s store');

-- ---- Rollback, and retrying a failed rollback --------------------------------------------------------------------------
select pg_temp.photo(:mei, 'd.jpg') as pd \gset
update public.photos set store_id = 'nas' where id = :'pd'::uuid;
select public.storage_switch(:own, 'cold', 'Try the cold store') ->> 'migrationId' as m2 \gset
select public.storage_migration_batch(:'m2'::uuid, 1) -> 0 ->> 'photoId' as first \gset
select public.storage_item_mark(:'m2'::uuid, :'first'::uuid, 'verified', 5000, null, null, pg_temp.tok(:'m2', :'first'));
select public.storage_migration_batch(:'m2'::uuid, 1) -> 0 ->> 'photoId' as second \gset
select public.create_uploads(:mei, jsonb_build_array(pg_temp.file('during.jpg'))) -> 'results' -> 0 ->> 'photoId' as during \gset
update public.photos set status = 'ready' where id = :'during'::uuid;
select pg_temp.ok(public.storage_migration_action(:fin, 'rollback', 'Too slow') ->> 'error' = 'forbidden', 'Finance can''t roll back');
select public.storage_migration_action(:own, 'rollback', 'Too slow') as r \gset
select pg_temp.ok((select settle_after = now() + interval '2 minutes' from public.storage_migrations where id = :'m2'::uuid),
  'a rollback can''t finish for 2 minutes either');
select pg_temp.settle(:'m2'::uuid);
select pg_temp.ok(:'r'::jsonb ->> 'to' = 'cold' and public.storage_status() ->> 'writeStore' = 'nas'
  and (select direction = 'back' and state = 'rolling_back' from public.storage_migrations where id = :'m2'::uuid),
  'rollback sends writes back to the old store');
select pg_temp.ok((select src = 'cold' and dst = 'nas' and state = 'pending' from public.storage_migration_items where migration_id = :'m2'::uuid and photo_id = :'first'::uuid)
  and (select state = 'skipped' and cleanup_store = 'cold' from public.storage_migration_items where migration_id = :'m2'::uuid and photo_id = :'second'::uuid)
  and (select src = 'cold' and dst = 'nas' from public.storage_migration_items where migration_id = :'m2'::uuid and photo_id = :'during'::uuid),
  'moved photos (and uploads made since) are copied back; a started copy is cleaned up');
select pg_temp.ok(public.storage_migration_action(:own, 'rollback', 'Again') ->> 'error' = 'conflict', 'a rollback can''t be rolled back');
select public.storage_migration_batch(:'m2'::uuid, 10) as b4 \gset
select pg_temp.ok(jsonb_array_length(:'b4'::jsonb) = 2 and (select bool_and(e ->> 'from' = 'cold' and e ->> 'to' = 'nas') from jsonb_array_elements(:'b4'::jsonb) e),
  'the copy back runs through the same pipeline');
select public.storage_item_mark(:'m2'::uuid, :'first'::uuid, 'verified', 5000, null, null, pg_temp.tok(:'m2', :'first'));
select public.storage_item_mark(:'m2'::uuid, :'during'::uuid, 'failed', null, 'timeout', null, pg_temp.tok(:'m2', :'during'));
select pg_temp.ok((select state = 'failed' and direction = 'back' from public.storage_migrations where id = :'m2'::uuid), 'a rollback can fail too');
select pg_temp.ok(public.storage_migration_action(:own, 'retry', 'Retry the copy back') ->> 'migrationId' = :'m2', 'a failed rollback can be retried');
select pg_temp.ok((select state = 'rolling_back' from public.storage_migrations where id = :'m2'::uuid)
  and public.storage_status() ->> 'writeStore' = 'nas', 'retrying a failed rollback carries on rolling back');
update public.storage_migrations set topped_up_at = null where id = :'m2'::uuid;
select public.storage_migration_batch(:'m2'::uuid, 10) as b5 \gset
select pg_temp.ok(jsonb_array_length(:'b5'::jsonb) = 1 and :'b5'::jsonb -> 0 ->> 'photoId' = :'during'
  and :'b5'::jsonb -> 0 ->> 'from' = 'cold' and :'b5'::jsonb -> 0 ->> 'to' = 'nas'
  and (select state = 'verified' and src = 'cold' from public.storage_migration_items where migration_id = :'m2'::uuid and photo_id = :'first'::uuid)
  and not exists (select 1 from public.storage_migration_items where migration_id = :'m2'::uuid and src = 'nas' and state = 'pending'),
  'only the failed copy back is retried; nothing is sent forward again');
select public.storage_item_mark(:'m2'::uuid, :'during'::uuid, 'verified', 2000, null, null, pg_temp.tok(:'m2', :'during'));
select pg_temp.ok((select state = 'rolled_back' from public.storage_migrations where id = :'m2'::uuid)
  and not exists (select 1 from public.photos where owner_id = :mei and store_id = 'cold'), 'rolled back: every photo is on the old store');
select pg_temp.ok(public.storage_switch(:own, 's3', 'Again') ->> 'error' = 'conflict'
  and public.storage_status() -> 'migration' = 'null'::jsonb and (public.storage_status() ->> 'cleanupPending')::boolean,
  'no new switch while old copies wait for deletion (and the sweep keeps them)');
update public.storage_migrations set delete_old_after = now() - interval '1 second' where id = :'m2'::uuid;
select pg_temp.ok((select bool_and(e ->> 'from' = 'cold' and e ->> 'to' = 'nas') and count(*) = 3 from jsonb_array_elements(public.storage_old_copies_due(100)) e),
  'after the hold, the copies on the abandoned store are due');
savepoint purging_claim;
update public.photos set status = 'purging', trashed_at = now(), purge_after = now() where id = :'first'::uuid;
select pg_temp.ok(public.storage_old_copy_claim(:'m2'::uuid, :'first'::uuid, 'cold') = '{"copyTo": null}'::jsonb,
  'the old copy of a photo being purged is just deleted, never copied back');
rollback to savepoint purging_claim;
select pg_temp.ok(public.storage_old_copy_claim(:'m2'::uuid, :'second'::uuid, 'cold') = '{"copyTo": null}'::jsonb
  and public.storage_old_copy_claim(:'m2'::uuid, :'first'::uuid, 'cold') = '{"copyTo": "nas"}'::jsonb,
  'a partial copy that was never used is just deleted; a copied-back photo''s missing objects go to its store first');
create temp table due2 as select * from jsonb_array_elements(public.storage_old_copies_due(100)) e;
select public.storage_old_copy_claim(:'m2'::uuid, (e.value ->> 'photoId')::uuid, e.value ->> 'from') from due2 e;
select public.storage_item_mark(:'m2'::uuid, (e.value ->> 'photoId')::uuid, 'deleted', null, null, null, null, e.value ->> 'from') from due2 e;
select pg_temp.ok((select state = 'rolled_back' and finished_at is not null from public.storage_migrations where id = :'m2'::uuid)
  and not (public.storage_status() ->> 'cleanupPending')::boolean, 'clean-up finishes the rollback');

-- ---- Never finished in the transaction that started it ------------------------------------------------------------
savepoint empty_switch;
update public.photos set store_id = 'cold' where store_id = 'nas';
select public.storage_switch(:own, 's3', 'Nothing to move') ->> 'migrationId' as m7 \gset
select pg_temp.ok((select state = 'copying' and finished_at is null from public.storage_migrations where id = :'m7'::uuid)
  and not exists (select 1 from public.storage_migration_items where migration_id = :'m7'::uuid),
  'an empty switch isn''t done in the transaction that started it');
select pg_temp.ok(public.storage_migration_batch(:'m7'::uuid, 10) = '[]'::jsonb
  and (select state = 'copying' from public.storage_migrations where id = :'m7'::uuid), 'nor by a batch before its settle period ends');
-- A photo whose insert read the old write store while the switch was committing.
select pg_temp.photo(:mei, 'raced.jpg') as pr \gset
update public.photos set store_id = 'nas' where id = :'pr'::uuid;
select pg_temp.settle(:'m7'::uuid);
select public.storage_migration_batch(:'m7'::uuid, 10);
select pg_temp.ok((select state = 'copying' from public.storage_migrations where id = :'m7'::uuid)
  and exists (select 1 from public.storage_migration_items where migration_id = :'m7'::uuid and photo_id = :'pr'::uuid and state = 'pending'),
  'the first batch after it looks for late arrivals before finishing, and finds the raced photo');
select public.storage_migration_batch(:'m7'::uuid, 10) -> 0 ->> 'photoId' as got \gset
select public.storage_item_mark(:'m7'::uuid, :'pr'::uuid, 'verified', 1300, null, null, pg_temp.tok(:'m7', :'pr'));
select pg_temp.ok(:'got' = :'pr' and (select store_id = 's3' from public.photos where id = :'pr'::uuid)
  and (select state = 'holding' from public.storage_migrations where id = :'m7'::uuid), 'it''s moved, then the migration finishes');
rollback to savepoint empty_switch;

-- ---- A reversed item keeps tracking the copy on the store it had moved from ------------------------------------------
savepoint reversed_gone;
select pg_temp.photo(:mei, 'x.jpg') as px \gset
select public.storage_switch(:own, 's3', 'Reversed') ->> 'migrationId' as m8 \gset
select pg_temp.settle(:'m8'::uuid);
update public.storage_migration_items set updated_at = now() + interval '1 hour' where migration_id = :'m8'::uuid and photo_id <> :'px'::uuid;
select pg_temp.ok(public.storage_migration_batch(:'m8'::uuid, 1) -> 0 ->> 'photoId' = :'px', 'the photo is claimed');
select public.storage_item_mark(:'m8'::uuid, :'px'::uuid, 'verified', 1300, null, null, pg_temp.tok(:'m8', :'px'));
select public.storage_migration_action(:own, 'rollback', 'Undo');
select pg_temp.ok((select src = 's3' and dst = 'nas' and state = 'pending' and cleanup_store = 'nas'
                     from public.storage_migration_items where migration_id = :'m8'::uuid and photo_id = :'px'::uuid),
  'a reversed item keeps tracking the copy on the store it had moved from');
delete from public.photos where id = :'px'::uuid;
select pg_temp.settle(:'m8'::uuid);
update public.storage_migration_items set updated_at = now() - interval '1 hour' where migration_id = :'m8'::uuid and photo_id = :'px'::uuid;
select public.storage_migration_batch(:'m8'::uuid, 1);
select pg_temp.ok((select state = 'skipped' and cleanup_store = 'nas' from public.storage_migration_items where migration_id = :'m8'::uuid and photo_id = :'px'::uuid),
  'a photo deleted before its copy back still has that copy cleaned up');
rollback to savepoint reversed_gone;

-- ---- Stuck uploads and publishes fail; stamp misses back off and fail ------------------------------------------------
savepoint stuck;
select pg_temp.photo(:mei, 'stuck.jpg') as ps \gset
update public.photos set publish_pending = true, created_at = now() - interval '3 days' where id = :'ps'::uuid;
select pg_temp.photo(:mei, 'young.jpg') as py \gset
update public.photos set publish_pending = true where id = :'py'::uuid;
select public.storage_switch(:own, 's3', 'Stuck') ->> 'migrationId' as m9 \gset
select public.storage_migration_batch(:'m9'::uuid, 100);
select pg_temp.ok((select state = 'failed' and error = 'publish_stuck' from public.storage_migration_items where migration_id = :'m9'::uuid and photo_id = :'ps'::uuid)
  and (select state = 'pending' and error is null from public.storage_migration_items where migration_id = :'m9'::uuid and photo_id = :'py'::uuid)
  and (select last_error = 'publish_stuck' from public.storage_migrations where id = :'m9'::uuid),
  'a photo publishing its variants for more than a day fails (publish_stuck); a recent one waits');
update public.photos set status = 'uploading', publish_pending = false where id = :'py'::uuid;
update public.photos set created_at = now() - interval '3 days' where id = :'py'::uuid;
update public.storage_migration_items set lease_until = null where migration_id = :'m9'::uuid and photo_id = :'py'::uuid;
select public.storage_migration_batch(:'m9'::uuid, 100);
select pg_temp.ok((select state = 'failed' and error = 'upload_stuck' from public.storage_migration_items where migration_id = :'m9'::uuid and photo_id = :'py'::uuid),
  'and so does one stuck uploading');
-- Stamp misses: a photo changed every time its copy is verified.
select pg_temp.photo(:mei, 'busy.jpg') as pz \gset
update public.photos set store_id = 'nas' where id = :'pz'::uuid;
update public.storage_migrations set topped_up_at = null where id = :'m9'::uuid;
select public.storage_migration_batch(:'m9'::uuid, 100);
select set_config('t95.m', :'m9', false), set_config('t95.p', :'pz', false);
do $$
declare
  m uuid := current_setting('t95.m')::uuid;
  p uuid := current_setting('t95.p')::uuid;
  r jsonb;
  i integer;
begin
  for i in 1..10 loop
    update public.storage_migration_items set lease_until = null, updated_at = now() - interval '1 day' where migration_id = m and photo_id = p;
    perform public.storage_migration_batch(m, 1);
    update public.storage_migration_items set stamp = 'changed' where migration_id = m and photo_id = p;
    r := public.storage_item_mark(m, p, 'verified', 1300, null, null,
                                  (select token from public.storage_migration_items where migration_id = m and photo_id = p));
    if i = 1 and not (r ->> 'state' = 'pending' and (select stamp_misses = 1 and lease_until between now() + interval '29 seconds' and now() + interval '31 seconds'
                                                      from public.storage_migration_items where migration_id = m and photo_id = p)) then
      raise exception 'FAILED: the first stamp miss waits 30 s';
    end if;
    if i = 3 and not (select lease_until between now() + interval '119 seconds' and now() + interval '121 seconds'
                        from public.storage_migration_items where migration_id = m and photo_id = p) then
      raise exception 'FAILED: the third stamp miss waits 2 minutes';
    end if;
    if i < 10 and r ->> 'state' <> 'pending' then raise exception 'FAILED: miss % should stay pending', i; end if;
    if i = 10 and r ->> 'state' <> 'failed' then raise exception 'FAILED: the tenth miss should fail'; end if;
  end loop;
  raise notice 'ok - stamp misses back off (30 s, 1 min, 2 min …)';
end $$;
select pg_temp.ok((select state = 'failed' and error = 'busy' and stamp_misses = 10 and store_id_ok
                     from (select i.*, (select store_id = 'nas' from public.photos where id = :'pz'::uuid) as store_id_ok
                             from public.storage_migration_items i where migration_id = :'m9'::uuid and photo_id = :'pz'::uuid) x),
  'the tenth stamp miss fails the item (busy) and the photo stays where it was');
rollback to savepoint stuck;

-- ---- Abandoning old copies on a store that's gone ------------------------------------------------------------------
savepoint abandon;
update public.photos set status = 'purging', trashed_at = now(), purge_after = now() where id = (:'up1'::jsonb ->> 'photoId')::uuid;
select public.storage_switch(:own, 's3', 'Off the NAS') ->> 'migrationId' as m11 \gset
select pg_temp.ok(public.storage_abandon_old_copies(:own, 'nas', 'NAS died') ->> 'error' = 'conflict', 'nothing is abandoned while photos are moving');
select pg_temp.settle(:'m11'::uuid);
create temp table c11 as select e.value as v from jsonb_array_elements(public.storage_migration_batch(:'m11'::uuid, 100)) e;
select public.storage_item_mark(:'m11'::uuid, (v ->> 'photoId')::uuid, 'verified', 5000, null, null, (v ->> 'token')::uuid) from c11;
select pg_temp.ok((select state = 'holding' from public.storage_migrations where id = :'m11'::uuid)
  and public.admin_storage(:own) -> 'oldCopies' = jsonb_build_array(jsonb_build_object('storeId', 'nas', 'copies', (select count(*) from c11))),
  'Admin lists the old copies waiting on each store');
select pg_temp.ok(public.storage_abandon_old_copies(:fin, 'nas', 'NAS died') ->> 'error' = 'forbidden'
  and public.storage_abandon_old_copies(:own, 'NAS!', 'NAS died') ->> 'error' = 'invalid'
  and public.storage_abandon_old_copies(:own, 'nas', 'x') ->> 'error' = 'invalid'
  and public.storage_abandon_old_copies(:own, 'cold', 'Nothing there') ->> 'error' = 'not_found',
  'only an Owner, with a store and a reason, and only where copies are waiting');
select public.storage_abandon_old_copies(:own, 'nas', 'NAS died') as ab \gset
select pg_temp.ok((:'ab'::jsonb ->> 'copies')::int = (select count(*) from c11) and (:'ab'::jsonb ->> 'migrations')::int = 1
  and (select state = 'done' and finished_at is not null from public.storage_migrations where id = :'m11'::uuid)
  and (select bool_and(cleaned_at is not null and error = 'abandoned' and state = 'verified') from public.storage_migration_items where migration_id = :'m11'::uuid and cleanup_store = 'nas')
  and not (public.storage_status() ->> 'cleanupPending')::boolean and public.admin_storage(:own) -> 'oldCopies' = '[]'::jsonb
  and public.storage_old_copies_due(100) = '[]'::jsonb,
  'abandoning marks the copies cleaned (nothing deleted) and finishes the migration');
select pg_temp.ok(exists (select 1 from public.audit_log where action = 'storage.old_copies_abandoned' and target = 'nas'
                            and details ->> 'reason' = 'NAS died' and (details ->> 'copies')::int = (select count(*) from c11)),
  'it''s audited');
select pg_temp.ok(public.storage_abandon_old_copies(:own, 'nas', 'Again') ->> 'error' = 'not_found'
  and public.storage_switch(:own, 'cold', 'Next') ->> 'migrationId' is not null, 'nothing left to abandon; the next switch can start');
rollback to savepoint abandon;

-- ---- A switch with nothing to move but an upload in progress; done when nothing is held -----------------------------
savepoint only_upload;
update public.photos set store_id = 'cold' where store_id = 'nas' and status <> 'uploading';
select public.storage_switch(:own, 's3', 'Only an upload left') ->> 'migrationId' as m5 \gset
select pg_temp.ok((select state = 'copying' from public.storage_migrations where id = :'m5'::uuid)
  and (select count(*) = 1 from public.storage_migration_items where migration_id = :'m5'::uuid and photo_id = (:'up1'::jsonb ->> 'photoId')::uuid),
  'a switch with nothing to move but an upload in progress isn''t done: it waits for the upload');
select pg_temp.ok(public.storage_migration_batch(:'m5'::uuid, 10) = '[]'::jsonb
  and (select state = 'copying' from public.storage_migrations where id = :'m5'::uuid), 'nor is it claimed while uploading');
update public.photos set status = 'purging', trashed_at = now(), purge_after = now() where id = (:'up1'::jsonb ->> 'photoId')::uuid;
update public.storage_migration_items set lease_until = null where migration_id = :'m5'::uuid;
select pg_temp.settle(:'m5'::uuid);
select public.storage_migration_batch(:'m5'::uuid, 10);
select pg_temp.ok((select state = 'done' and finished_at is not null and delete_old_after is null from public.storage_migrations where id = :'m5'::uuid)
  and public.storage_status() -> 'migration' = 'null'::jsonb and not (public.storage_status() ->> 'cleanupPending')::boolean,
  'the upload expired: with no old copy to delete the move is done, not stuck holding');
select pg_temp.ok(public.storage_switch(:own, 'nas', 'And back') ->> 'migrationId' is not null, 'so the next switch can start');
rollback to savepoint only_upload;

-- ---- A rollback with an upload in progress on the new store ------------------------------------------------------
savepoint rollback_upload;
select public.storage_switch(:own, 's3', 'Try S3') ->> 'migrationId' as m6 \gset
select public.create_uploads(:mei, jsonb_build_array(pg_temp.file('mid.jpg'))) -> 'results' -> 0 ->> 'photoId' as mid \gset
select public.storage_migration_action(:own, 'rollback', 'Not now');
select pg_temp.settle(:'m6'::uuid);
select pg_temp.ok((select state = 'rolling_back' from public.storage_migrations where id = :'m6'::uuid)
  and (select src = 's3' and dst = 'nas' and state = 'pending' from public.storage_migration_items where migration_id = :'m6'::uuid and photo_id = :'mid'::uuid),
  'a rollback queues the upload in progress on the new store and doesn''t finish around it');
select pg_temp.ok(public.storage_migration_batch(:'m6'::uuid, 10) = '[]'::jsonb
  and (select state = 'rolling_back' from public.storage_migrations where id = :'m6'::uuid), 'it waits while the upload runs');
update public.photos set status = 'ready' where id = :'mid'::uuid;
update public.storage_migration_items set lease_until = null where migration_id = :'m6'::uuid and photo_id = :'mid'::uuid;
select public.storage_migration_batch(:'m6'::uuid, 10) as b6 \gset
select pg_temp.ok(jsonb_array_length(:'b6'::jsonb) = 1 and :'b6'::jsonb -> 0 ->> 'photoId' = :'mid' and :'b6'::jsonb -> 0 ->> 'from' = 's3',
  'once it''s ready it''s copied back');
select public.storage_item_mark(:'m6'::uuid, :'mid'::uuid, 'verified', 2000, null, null, pg_temp.tok(:'m6', :'mid'::uuid));
select pg_temp.ok((select state = 'rolled_back' from public.storage_migrations where id = :'m6'::uuid)
  and (select store_id = 'nas' from public.photos where id = :'mid'::uuid), 'then the rollback finishes, with nothing left on the abandoned store');
rollback to savepoint rollback_upload;

-- ---- Follow-up copies (followMove couldn't copy an object to the photo's new store) ---------------------------------
select ('u/' || :mei || '/p/' || :'pa' || '/e/v1-thumb.jpg') as fk \gset
select pg_temp.ok(public.storage_followup_add(:'pa'::uuid, 'r2', array[:'fk']) = 1, 'a failed follow-up copy is recorded');
select pg_temp.ok((public.storage_status() ->> 'cleanupPending')::boolean, 'and the sweep leaves copies away from their photo''s store alone meanwhile');
select pg_temp.ok(public.storage_followups_due(10) = jsonb_build_array(jsonb_build_object('photoId', :'pa', 'key', :'fk', 'from', 'r2', 'to', 'nas')),
  'due follow-ups name the photo''s store now');
do $$ begin
  begin
    perform public.storage_followup_add((select id from public.photos where filename = 'a.jpg'), 'r2', array['u/someone-else/p/x/original']);
    raise exception 'FAILED: a key outside the photo accepted';
  exception when invalid_parameter_value then raise notice 'ok - follow-ups only take keys under the photo''s prefix';
  end;
end $$;
select pg_temp.ok(public.storage_followup_add('95000000-0000-0000-0000-00000000ffff', 'r2', array['u/x/p/y/original']) = 0, 'a photo that''s gone records nothing');
select public.storage_followup_done(:'pa'::uuid, :'fk', 'r2', false);
select pg_temp.ok(public.storage_followups_due(10) = '[]'::jsonb
  and (select attempts = 1 and next_at > now() from public.storage_followups where photo_id = :'pa'::uuid), 'a failed retry backs off');
select public.storage_followup_done(:'pa'::uuid, :'fk', 'r2', true);
select pg_temp.ok(not exists (select 1 from public.storage_followups) and not (public.storage_status() ->> 'cleanupPending')::boolean, 'a done follow-up goes');
select public.storage_followup_add(:'pa'::uuid, 'cold', array[:'fk']);
select pg_temp.ok(public.storage_followups_expire() = 0 and (public.admin_storage(:own) -> 'followups' ->> 'pending')::int = 1,
  'a recent follow-up isn''t dropped (Admin counts it)');
update public.storage_followups set created_at = now() - interval '8 days';
-- (Expired in its own statement: a check in the same statement would still see the row.)
select public.storage_followups_expire() as fx \gset
select pg_temp.ok(:fx = 1 and not exists (select 1 from public.storage_followups)
  and exists (select 1 from public.audit_log where action = 'storage.followups_dropped' and details = '{"count": 1, "stores": {"cold": 1}}'::jsonb)
  and public.admin_storage(:own) -> 'followups' = '{"pending": 0, "dropped30d": 1}'::jsonb,
  'follow-ups older than 7 days are dropped, audited and counted in Admin');

-- ---- A photo purged mid-migration -------------------------------------------------------------------------
select pg_temp.photo(:mei, 'gone.jpg') as pe \gset
update public.photos set store_id = 'nas' where id = :'pe'::uuid;
select public.storage_switch(:own, 's3', 'To S3') ->> 'migrationId' as m3 \gset
-- Claim the dedicated photo first, so the purge never hits pa/pb (used by later assertions).
update public.storage_migration_items set updated_at = now() + interval '1 hour' where migration_id = :'m3'::uuid and photo_id <> :'pe'::uuid;
select public.storage_migration_batch(:'m3'::uuid, 1) -> 0 ->> 'photoId' as gone \gset
select pg_temp.ok(:'gone' = :'pe', 'the dedicated photo is claimed first');
update public.photos set status = 'purging', trashed_at = now(), purge_after = now() where id = :'gone'::uuid;
select public.storage_item_mark(:'m3'::uuid, :'gone'::uuid, 'verified', 1300, null, null, pg_temp.tok(:'m3', :'gone')) as r \gset
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

-- ---- Permanent deletes name each photo's store ------------------------------------------------------------------------
select pg_temp.photo(:mei, 'forever.jpg', 'trashed') as pf \gset
update public.photos set store_id = 's3' where id = :'pf'::uuid;
select pg_temp.ok(public.bulk_photos(:mei, array[:'pf']::uuid[], 'delete_forever') -> 'purge'
                    = jsonb_build_array(jsonb_build_object('photoId', :'pf', 'keys', public._photo_keys(:mei, :'pf'::uuid), 'storeId', 's3')),
  '"Delete forever" names the photo''s store');
select pg_temp.ok(public.bulk_photos(:mei, array[:'pa']::uuid[], 'favourite') = '{"affected": 1}'::jsonb, 'other bulk actions are unchanged');
select pg_temp.photo(:mei, 'emptied.jpg', 'trashed') as pg \gset
update public.photos set store_id = 'nas' where id = :'pg'::uuid;
select pg_temp.ok((select e ->> 'storeId' = 'nas' from jsonb_array_elements(public.empty_trash(:mei) -> 'purge') e where e ->> 'photoId' = :'pg'),
  '"Empty Trash" names each photo''s store');

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
update public.photo_edits set thumb_version = 1, thumb_key = 'u/' || :mei || '/p/' || :'pb' || '/edit-1-thumb-k95', thumb_bytes = 10 where photo_id = :'pb'::uuid;
select pg_temp.ok(public.edit_variant_check(:mei, :'pb'::uuid, 1, 'thumb') ->> 'status' = 'exists'
  and public.edit_variant_check(:mei, :'pb'::uuid, 1, 'thumb') ->> 'key' = 'u/' || :mei || '/p/' || :'pb' || '/edit-1-thumb-k95'
  and not (public.edit_variant_check(:mei, :'pb'::uuid, 1, 'preview') ? 'key'),
  'an edit check that finds the variant recorded gives its key (a retried PUT makes sure it followed a move)');
update public.photos set publish_pending = true where id = :'pb'::uuid;
select pg_temp.ok(public.due_publishes(100) @> jsonb_build_array(jsonb_build_object('photoId', :'pb', 'storeId', 'nas', 'stale', false)), 'pending publishes name the store');
update public.photos set created_at = now() - interval '4 days' where id = :'pb'::uuid;
select pg_temp.ok(public.due_publishes(100) @> jsonb_build_array(jsonb_build_object('photoId', :'pb', 'stale', true)),
  'a publish waiting for at least 2 days (created more than 3 days ago) is stale');
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
  select 1 from unnest(array['storage_state', 'storage_checks', 'storage_migrations', 'storage_migration_items', 'storage_followups']) t
   where has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')
      or has_table_privilege('authenticated', 'public.' || t, 'insert'))
  and (select bool_and(c.relrowsecurity) from pg_class c where c.relnamespace = 'public'::regnamespace
         and c.relname in ('storage_state', 'storage_checks', 'storage_migrations', 'storage_migration_items', 'storage_followups')),
  'the storage tables have RLS and nothing for anon or authenticated');
select pg_temp.ok(not has_function_privilege('service_role', 'public._v7_get_upload(uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.get_upload(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.storage_switch(uuid, text, text)', 'execute')
  and not has_function_privilege('service_role', 'public._migration_progress(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public._migration_top_up(public.storage_migrations, boolean)', 'execute')
  and has_function_privilege('service_role', 'public.storage_followup_add(uuid, text, text[])', 'execute')
  and has_function_privilege('service_role', 'public.storage_abandon_old_copies(uuid, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.storage_abandon_old_copies(uuid, text, text)', 'execute')
  and has_function_privilege('service_role', 'public.storage_followups_expire()', 'execute')
  and not has_function_privilege('anon', 'public.storage_followups_expire()', 'execute')
  and not has_function_privilege('authenticated', 'public.storage_followup_add(uuid, text, text[])', 'execute')
  and not has_function_privilege('anon', 'public.storage_followups_due(integer)', 'execute')
  and has_function_privilege('service_role', 'public.storage_item_touch(uuid, uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.storage_old_copy_claim(uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.storage_old_copy_claim(uuid, uuid, text)', 'execute')
  and not has_function_privilege('service_role', 'public._v7_bulk_photos(uuid, uuid[], text, uuid)', 'execute')
  and not has_function_privilege('service_role', 'public._v7_ai_mask_key(uuid, uuid, uuid)', 'execute')
  and not has_sequence_privilege('service_role', 'public.photo_write_seq', 'usage')
  and not has_sequence_privilege('authenticated', 'public.photo_write_seq', 'usage'), 'service_role only; wrapped originals are private');

rollback;
