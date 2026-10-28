-- Assertions for the library migration (phase 3): uploads and reservations, plan rules, duplicates,
-- photos, albums, Trash and purges, account deletion, cross-owner isolation and usage accounting.
-- Run with supabase/tests/run-local.sh.
\set ON_ERROR_STOP on
begin;

create function pg_temp.ok(cond boolean, what text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok - %', what;
end $$;
grant execute on function pg_temp.ok(boolean, text) to public;
create function pg_temp.sha(t text) returns text language sql as $$ select encode(extensions.digest(t, 'sha256'), 'hex') $$;
create function pg_temp.file(n text, size bigint, typ text, content text) returns jsonb language sql as $$
  select jsonb_build_object('name', n, 'size', size, 'type', typ, 'sha256', pg_temp.sha(content))
$$;
-- The usage invariant: what profiles say equals what the rows add up to.
create function pg_temp.no_drift(o uuid) returns boolean language sql as $$
  select pr.storage_bytes = (select coalesce(sum(p.size_bytes + p.thumb_bytes + p.preview_bytes), 0) from public.photos p
                              where p.owner_id = o and p.status in ('ready', 'trashed', 'purging'))
     and pr.reserved_bytes = (select coalesce(sum(u.reserved_bytes), 0) from public.uploads u where u.owner_id = o)
  from public.profiles pr where pr.id = o
$$;
create function pg_temp.all_ok() returns boolean language sql as $$
  select bool_and(pg_temp.no_drift(id)) from public.profiles
$$;
-- Uploads every part and both variants, then completes. Returns complete_upload's result.
create function pg_temp.finish(o uuid, u uuid, md jsonb default '{}') returns jsonb language plpgsql as $$
declare n integer;
begin
  for n in 1 .. (select part_count from public.uploads where id = u) loop
    perform public.record_part(o, u, n, 'etag-' || n);
  end loop;
  perform public.record_variant(o, u, 'thumb', 20000);
  perform public.record_variant(o, u, 'preview', 400000);
  return public.complete_upload(o, u, md, 20000, 400000);
end $$;

-- Mei (free), Wei (pro), Ana (free; deletes her account), and a staff member.
insert into auth.users (id, email, email_confirmed_at) values
  ('20000000-0000-0000-0000-000000000001', 'mei@example.com', now()),
  ('20000000-0000-0000-0000-000000000002', 'wei@example.com', now()),
  ('20000000-0000-0000-0000-000000000003', 'ana@example.com', now()),
  ('10000000-0000-0000-0000-000000000001', 'owner@zephyr.test', now());
insert into public.staff (user_id, role) values ('10000000-0000-0000-0000-000000000001', 'owner');
update public.profiles set plan_id = 'pro' where id = '20000000-0000-0000-0000-000000000002';

create temp table t (k text primary key, v jsonb);
grant all on t to public;

-- ---- Plan rules ------------------------------------------------------------------------------------
insert into t select 'r1', create_uploads('20000000-0000-0000-0000-000000000001', jsonb_build_array(
  pg_temp.file('IMG_1.jpg', 5000000, 'jpeg', 'one'),
  pg_temp.file('IMG_2.CR2', 20000000, 'cr2', 'raw'),
  pg_temp.file('big.png', 60 * 1048576, 'png', 'big'),
  pg_temp.file('IMG_1 copy.jpg', 5000000, 'jpeg', 'one'),
  pg_temp.file('evil.svg', 100, 'svg', 'svg'),
  jsonb_build_object('name', 'x.jpg', 'size', 10, 'type', 'jpeg', 'sha256', 'nothex'),
  pg_temp.file('IMG_3.jpg', 20000000, 'jpeg', 'three')));
select pg_temp.ok((select v #>> '{results,0,status}' = 'ready' and (v #>> '{results,0,partCount}')::int = 1
  and (v #>> '{results,0,partSize}')::int = 16777216 from t where k = 'r1'), 'free: a JPEG is accepted');
select pg_temp.ok((select v #>> '{results,1,reason}' = 'type' from t where k = 'r1'), 'free: CR2 is rejected (plan file types)');
select pg_temp.ok((select v #>> '{results,2,reason}' = 'too_large' from t where k = 'r1'), 'free: over max_file_mb is too_large');
select pg_temp.ok((select v #>> '{results,3,status}' = 'duplicate' and v #>> '{results,3,photoId}' = v #>> '{results,0,photoId}' from t where k = 'r1'),
  'the same file twice in one batch is a duplicate');
select pg_temp.ok((select v #>> '{results,4,reason}' = 'type' from t where k = 'r1'), 'unknown types (svg) are rejected');
select pg_temp.ok((select v #>> '{results,5,reason}' = 'invalid' from t where k = 'r1'), 'a malformed hash is invalid');
select pg_temp.ok((select (v #>> '{results,6,partCount}')::int = 2 from t where k = 'r1'), '20 MB → two 16 MiB parts');
select pg_temp.ok((select reserved_bytes = 5000000 + 20000000 + 2 * 1880064 from public.profiles where id = '20000000-0000-0000-0000-000000000001'),
  'accepted files reserve their size plus variant room');
select pg_temp.ok(pg_temp.all_ok(), 'no drift after create_uploads');
select pg_temp.ok((select v #>> '{results,0,r2Key}' = 'u/20000000-0000-0000-0000-000000000001/p/' || (v #>> '{results,0,photoId}') || '/original' from t where k = 'r1'),
  'R2 key is u/<owner>/p/<photo>/original');
select pg_temp.ok(create_uploads('20000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.file('a.NEF', 30000000, 'nef', 'nef1'))) #>> '{results,0,status}' = 'ready',
  'pro: NEF is accepted');
select pg_temp.ok(create_uploads('20000000-0000-0000-0000-000000000001',
  (select jsonb_agg(pg_temp.file('f' || i || '.jpg', 1000, 'jpeg', 'batch' || i)) from generate_series(1, 26) i)) ->> 'error' = 'batch_too_large',
  'free: more than batch_size files is refused');
select pg_temp.ok(create_uploads('20000000-0000-0000-0000-000000000001', '[]') ->> 'error' = 'invalid', 'an empty batch is invalid');

-- ---- Cross-owner upload access -----------------------------------------------------------------------
select pg_temp.ok(get_upload('20000000-0000-0000-0000-000000000002', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'r1')) is null, 'get_upload: other owner → null');
select pg_temp.ok(set_upload_r2('20000000-0000-0000-0000-000000000002', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'r1'), 'r2-x') is null, 'set_upload_r2: other owner → null');
select pg_temp.ok(record_part('20000000-0000-0000-0000-000000000002', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'r1'), 1, 'e') is null, 'record_part: other owner → null');
select pg_temp.ok(record_variant('20000000-0000-0000-0000-000000000002', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'r1'), 'thumb', 10) is null, 'record_variant: other owner → null');
select pg_temp.ok(complete_upload('20000000-0000-0000-0000-000000000002', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'r1'), '{}', 0, 0) is null, 'complete_upload: other owner → null');
select pg_temp.ok(abort_upload('20000000-0000-0000-0000-000000000002', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'r1')) is null, 'abort_upload: other owner → null');
select pg_temp.ok((select count(*) = 2 from public.uploads where owner_id = '20000000-0000-0000-0000-000000000001'), 'other owners changed nothing');

-- ---- Parts, variants, completion --------------------------------------------------------------------
select pg_temp.ok(set_upload_r2('20000000-0000-0000-0000-000000000001', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'r1'), 'r2-first') = 'r2-first', 'set_upload_r2 stores the id');
select pg_temp.ok(set_upload_r2('20000000-0000-0000-0000-000000000001', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'r1'), 'r2-second') = 'r2-first', 'set_upload_r2: the first writer wins');
select pg_temp.ok(record_part('20000000-0000-0000-0000-000000000001', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'r1'), 2, 'e') is null, 'record_part: part number out of range → null');
select pg_temp.ok(record_variant('20000000-0000-0000-0000-000000000001', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'r1'), 'thumb', 400000) is null, 'record_variant: over the thumb cap → null');
select pg_temp.ok(record_variant('20000000-0000-0000-0000-000000000001', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'r1'), 'original', 10) is null, 'record_variant: unknown kind → null');
select pg_temp.ok(complete_upload('20000000-0000-0000-0000-000000000001', (select (v #>> '{results,6,uploadId}')::uuid from t where k = 'r1'), '{}', 0, 0) ->> 'status' = 'incomplete', 'complete before every part → incomplete');
insert into t select 'c1', pg_temp.finish('20000000-0000-0000-0000-000000000001', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'r1'),
  '{"width": 6000, "height": 4000, "takenAt": "2026-06-01T10:00:00+08:00", "cameraMake": "  FUJIFILM\u0007 ", "cameraModel": "X-T5",
    "iso": 400, "aperture": 2.8, "orientation": 9, "lens": 42, "GPSLatitude": 1.3, "takenAtBad": "x", "focalLengthMm": -1}');
select pg_temp.ok((select v ->> 'status' = 'ready' and v #>> '{photo,filename}' = 'IMG_1.jpg' and (v #>> '{photo,hasThumb}')::boolean
  and (v #>> '{photo,width}')::int = 6000 from t where k = 'c1'), 'complete → ready photo');
select pg_temp.ok((select metadata = '{"width": 6000, "height": 4000, "takenAt": "2026-06-01T10:00:00+08:00", "cameraMake": "FUJIFILM", "cameraModel": "X-T5", "iso": 400, "aperture": 2.8}'::jsonb
  and taken_at = '2026-06-01T02:00:00Z' from public.photos where id = (select (v #>> '{photo,id}')::uuid from t where k = 'c1')),
  'metadata keeps only known, valid keys (no GPS, no junk) and control characters are stripped');
select pg_temp.ok((select storage_bytes = 5000000 + 20000 + 400000 and reserved_bytes = 20000000 + 1880064
  from public.profiles where id = '20000000-0000-0000-0000-000000000001'), 'completion turns the reservation into usage');
select pg_temp.ok(not exists (select 1 from public.uploads where id = (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'r1')), 'the upload row is gone');
-- Variant sizes counted are the ones the Worker measured in R2, clamped to the caps; the browser's are ignored.
insert into t select 'vs', create_uploads('20000000-0000-0000-0000-000000000003', jsonb_build_array(pg_temp.file('v.jpg', 100, 'jpeg', 'vsize')));
select record_part('20000000-0000-0000-0000-000000000003', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'vs'), 1, 'e1');
select record_variant('20000000-0000-0000-0000-000000000003', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'vs'), 'thumb', 10);
select pg_temp.ok(complete_upload('20000000-0000-0000-0000-000000000003', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'vs'), '{}', 999999999, 0) #>> '{photo,hasPreview}' = 'false',
  'complete_upload: an absent preview is not counted');
select pg_temp.ok((select thumb_bytes = 307200 and preview_bytes = 0 from public.photos where id = (select (v #>> '{results,0,photoId}')::uuid from t where k = 'vs')),
  'complete_upload counts the measured sizes, clamped to the variant caps (not uploads.variants)');
select pg_temp.ok(pg_temp.all_ok(), 'no drift with measured variant sizes');
-- Expiry is checked against the wall clock once the lock is held, not the transaction start.
insert into t select 'ck', create_uploads('20000000-0000-0000-0000-000000000003', jsonb_build_array(pg_temp.file('ck.jpg', 100, 'jpeg', 'clock')));
select record_part('20000000-0000-0000-0000-000000000003', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'ck'), 1, 'e1');
update public.uploads set expires_at = clock_timestamp() where id = (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'ck');
select pg_temp.ok(complete_upload('20000000-0000-0000-0000-000000000003', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'ck'), '{}', 0, 0) ->> 'status' = 'expired',
  'complete_upload: expired by the wall clock even though the transaction began earlier');
select pg_temp.ok((select v ->> 'r2Key' is not null from (select jsonb_array_elements(due_expired_uploads(10)) v) x
                    where v ->> 'uploadId' = (select v #>> '{results,0,uploadId}' from t where k = 'ck')), 'the expiry job claims it instead');
select pg_temp.ok(not exists (select 1 from public.photos where id = (select (v #>> '{results,0,photoId}')::uuid from t where k = 'ck'))
  and pg_temp.all_ok(), 'claimed expired upload: rows gone, reservation released');
-- Publishing: counted variants stay pending until the copy is confirmed; a lost staged copy is dropped.
select pg_temp.ok((select publish_pending from public.photos where id = (select (v #>> '{results,0,photoId}')::uuid from t where k = 'vs')),
  'a completed photo with variants is publish_pending');
select pg_temp.ok((select bool_or(e ->> 'photoId' = (select v #>> '{results,0,photoId}' from t where k = 'vs') and (e ->> 'thumbBytes')::int = 307200)
  from jsonb_array_elements(due_publishes(100)) e), 'due_publishes lists it with its counted bytes');
select pg_temp.ok(finish_publish('20000000-0000-0000-0000-000000000002', (select (v #>> '{results,0,photoId}')::uuid from t where k = 'vs'), true, false) is null,
  'finish_publish: other owner → null');
select pg_temp.ok(finish_publish('20000000-0000-0000-0000-000000000003', (select (v #>> '{results,0,photoId}')::uuid from t where k = 'vs'), true, false),
  'finish_publish with the thumb lost');
select pg_temp.ok((select not publish_pending and not has_thumb and thumb_bytes = 0 from public.photos where id = (select (v #>> '{results,0,photoId}')::uuid from t where k = 'vs'))
  and (select storage_bytes = 100 from public.profiles where id = '20000000-0000-0000-0000-000000000003'),
  'a lost variant is dropped and its bytes leave usage');
select pg_temp.ok(finish_publish('20000000-0000-0000-0000-000000000003', (select (v #>> '{results,0,photoId}')::uuid from t where k = 'vs'), false, false) is null,
  'finish_publish only applies once');
select pg_temp.ok(pg_temp.all_ok(), 'no drift after finish_publish');
select pg_temp.ok(pg_temp.all_ok(), 'no drift after completion');

-- ---- Duplicates -----------------------------------------------------------------------------------------
select pg_temp.ok(create_uploads('20000000-0000-0000-0000-000000000001', jsonb_build_array(pg_temp.file('again.jpg', 5000000, 'jpeg', 'one'))) #>> '{results,0,photoId}'
  = (select v #>> '{photo,id}' from t where k = 'c1'), 'a file already in the library is a duplicate');
select pg_temp.ok(create_uploads('20000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.file('mine.jpg', 5000000, 'jpeg', 'one'))) #>> '{results,0,status}' = 'ready',
  'duplicates are per owner: another member can upload the same file');
-- Two uploads of the same file: the second to complete is told it's a duplicate and its reservation goes.
insert into t select 'd1', create_uploads('20000000-0000-0000-0000-000000000001', jsonb_build_array(pg_temp.file('race.jpg', 1000, 'jpeg', 'race')));
insert into t select 'd2', create_uploads('20000000-0000-0000-0000-000000000001', jsonb_build_array(pg_temp.file('race.jpg', 1000, 'jpeg', 'race')));
select pg_temp.ok((select v #>> '{results,0,status}' = 'ready' from t where k = 'd2'), 'an unfinished upload does not block a retry');
select pg_temp.ok(pg_temp.finish('20000000-0000-0000-0000-000000000001', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'd1')) ->> 'status' = 'ready', 'first copy completes');
select pg_temp.ok(pg_temp.finish('20000000-0000-0000-0000-000000000001', (select (v #>> '{results,0,uploadId}')::uuid from t where k = 'd2')) ->> 'photoId'
  = (select v #>> '{results,0,photoId}' from t where k = 'd1'), 'second copy → duplicate of the first');
select pg_temp.ok(not exists (select 1 from public.photos where id = (select (v #>> '{results,0,photoId}')::uuid from t where k = 'd2')), 'the losing copy is removed');
select pg_temp.ok(pg_temp.all_ok(), 'no drift after a duplicate race');

-- ---- Quota: reservations count, so separate batches can't overshoot ---------------------------------
-- Fill Mei's 5 GB to 60 MB short (a real row, so the invariant holds).
insert into public.photos (owner_id, status, file_type, filename, size_bytes, sha256)
select '20000000-0000-0000-0000-000000000001', 'ready', 'jpeg', 'filler.jpg',
       5::bigint * 1073741824 - 60 * 1048576 - (storage_bytes + reserved_bytes), extensions.digest('filler', 'sha256')
  from public.profiles where id = '20000000-0000-0000-0000-000000000001';
update public.profiles set storage_bytes = (select sum(size_bytes + thumb_bytes + preview_bytes) from public.photos
  where owner_id = '20000000-0000-0000-0000-000000000001' and status in ('ready', 'trashed', 'purging'))
 where id = '20000000-0000-0000-0000-000000000001';
select pg_temp.ok(create_uploads('20000000-0000-0000-0000-000000000001', jsonb_build_array(pg_temp.file('q1.jpg', 40 * 1048576, 'jpeg', 'q1'))) #>> '{results,0,status}' = 'ready',
  'quota: the first 40 MB file fits');
select pg_temp.ok(create_uploads('20000000-0000-0000-0000-000000000001', jsonb_build_array(pg_temp.file('q2.jpg', 40 * 1048576, 'jpeg', 'q2'))) #>> '{results,0,reason}' = 'quota',
  'quota: a second 40 MB file in another request is refused (the first is reserved)');
select pg_temp.ok((select storage_bytes + reserved_bytes <= 5::bigint * 1073741824 from public.profiles where id = '20000000-0000-0000-0000-000000000001'),
  'used + reserved never exceeds the plan limit');
select pg_temp.ok(pg_temp.all_ok(), 'no drift after quota checks');

-- ---- Abort and expiry ---------------------------------------------------------------------------------
insert into t select 'ab', abort_upload('20000000-0000-0000-0000-000000000001', (select (v #>> '{results,6,uploadId}')::uuid from t where k = 'r1'));
select pg_temp.ok((select jsonb_array_length(v -> 'keys') = 5 and v ->> 'r2Key' like '%/original'
    and v #>> '{keys,3}' like 'staging/20000000-0000-0000-0000-000000000001/%/thumb' from t where k = 'ab'),
  'abort_upload claims the upload and returns the keys to delete (original, variants, staging)');
select pg_temp.ok(abort_upload('20000000-0000-0000-0000-000000000001', (select (v #>> '{results,6,uploadId}')::uuid from t where k = 'r1')) is null,
  'a second abort (lost race) gets nothing to delete');
select pg_temp.ok(not exists (select 1 from public.photos where id = (select (v #>> '{results,6,photoId}')::uuid from t where k = 'r1')), 'abort removes the uploading photo');
select pg_temp.ok(pg_temp.all_ok(), 'no drift after abort');
update public.uploads set expires_at = now() - interval '1 second' where owner_id = '20000000-0000-0000-0000-000000000002';
select pg_temp.ok(record_part('20000000-0000-0000-0000-000000000002', (select id from public.uploads where owner_id = '20000000-0000-0000-0000-000000000002' limit 1), 1, 'e') is null,
  'expired upload: parts are refused');
select pg_temp.ok(complete_upload('20000000-0000-0000-0000-000000000002', (select id from public.uploads where owner_id = '20000000-0000-0000-0000-000000000002' limit 1), '{}', 0, 0) ->> 'status' = 'expired',
  'expired upload: complete → expired');
insert into t select 'due', due_expired_uploads(100);
select pg_temp.ok((select jsonb_array_length(v) = 2 and v #>> '{0,keys,0}' like 'u/20000000-0000-0000-0000-000000000002/p/%/original' from t where k = 'due'),
  'due_expired_uploads claims only expired uploads and returns their keys');
select pg_temp.ok(jsonb_array_length(due_expired_uploads(100)) = 0, 'due_expired_uploads claims: the same uploads are not handed out twice');
select pg_temp.ok((select reserved_bytes = 0 from public.profiles where id = '20000000-0000-0000-0000-000000000002')
  and not exists (select 1 from public.photos where owner_id = '20000000-0000-0000-0000-000000000002'), 'expired uploads release their reservation');
select pg_temp.ok(pg_temp.all_ok(), 'no drift after expiry');

-- ---- Listing and search ---------------------------------------------------------------------------------
-- Five more ready photos for Mei with dates and cameras.
insert into public.photos (owner_id, status, file_type, filename, size_bytes, sha256, taken_at, metadata, created_at)
select '20000000-0000-0000-0000-000000000001', 'ready', case when i = 5 then 'cr2' else 'jpeg' end, 'Lake_' || i || '.jpg', 1000 + i,
       extensions.digest('lake' || i, 'sha256'), case when i <> 3 then timestamptz '2026-01-01T00:00:00Z' + i * interval '1 day' end,
       case when i = 2 then '{"cameraModel": "Leica Q3"}'::jsonb else '{}'::jsonb end, now() - i * interval '1 hour'
  from generate_series(1, 5) i;
update public.profiles set storage_bytes = storage_bytes + (select sum(1000 + i) from generate_series(1, 5) i) where id = '20000000-0000-0000-0000-000000000001';
select pg_temp.ok(pg_temp.all_ok(), 'no drift after seeding');
insert into t select 'p1', list_photos('20000000-0000-0000-0000-000000000001', p_limit => 3);
select pg_temp.ok((select jsonb_array_length(v -> 'items') = 3 and v ->> 'nextCursor' is not null from t where k = 'p1'), 'list: first page of 3 with a cursor');
insert into t select 'p2', list_photos('20000000-0000-0000-0000-000000000001', p_limit => 3, p_cursor => (select v ->> 'nextCursor' from t where k = 'p1'));
insert into t select 'p3', list_photos('20000000-0000-0000-0000-000000000001', p_limit => 3, p_cursor => (select v ->> 'nextCursor' from t where k = 'p2'));
select pg_temp.ok((select count(distinct e ->> 'id') = 8 from t, jsonb_array_elements(v -> 'items') e where k in ('p1', 'p2', 'p3'))
  and (select v ->> 'nextCursor' is null from t where k = 'p3'), 'list: keyset pages cover every ready photo once');
-- Order: no taken date sorts by upload time (now, now, now − 3 h), then June, then the January lakes.
select pg_temp.ok((select v #>> '{items,0,id}' = (select v #>> '{photo,id}' from t where k = 'c1') from t where k = 'p2')
  and (select v #>> '{items,2,filename}' = 'Lake_3.jpg' from t where k = 'p1'), 'sort by taken, falling back to the upload time');
select pg_temp.ok(list_photos('20000000-0000-0000-0000-000000000001', p_sort => 'added') #>> '{items,0,filename}' in ('filler.jpg', 'race.jpg', 'IMG_1.jpg'), 'sort by added (ties on the upload time go by id)');
select pg_temp.ok(jsonb_array_length(list_photos('20000000-0000-0000-0000-000000000001', p_view => 'raw') -> 'items') = 1, 'view raw');
select pg_temp.ok(list_photos('20000000-0000-0000-0000-000000000001', p_q => 'leica') #>> '{items,0,filename}' = 'Lake_2.jpg', 'search by camera (trigram)');
select pg_temp.ok(jsonb_array_length(list_photos('20000000-0000-0000-0000-000000000001', p_q => 'LAKE_') -> 'items') = 5, 'search by filename, case-insensitive, _ is literal');
select pg_temp.ok(jsonb_array_length(list_photos('20000000-0000-0000-0000-000000000001', p_q => '%') -> 'items') = 0, 'search: % is literal');
select pg_temp.ok(jsonb_array_length(list_photos('20000000-0000-0000-0000-000000000001', p_from => '2026-01-02', p_to => '2026-01-04') -> 'items') = 2, 'date range on the taken date');
select pg_temp.ok(jsonb_array_length(list_photos('20000000-0000-0000-0000-000000000002') -> 'items') = 0, 'list: another member sees none of these');
select pg_temp.ok(list_photos('20000000-0000-0000-0000-000000000001', p_cursor => 'garbage') ->> 'items' is not null, 'a malformed cursor starts from the top');

-- ---- Photo detail, patch, bulk ------------------------------------------------------------------------
create temp table ids as select id, filename from public.photos where owner_id = '20000000-0000-0000-0000-000000000001' and filename like 'Lake_%';
grant all on ids to public;
select pg_temp.ok(get_photo('20000000-0000-0000-0000-000000000001', (select id from ids where filename = 'Lake_1.jpg')) ->> 'albums' = '[]', 'get_photo includes albums');
select pg_temp.ok(get_photo('20000000-0000-0000-0000-000000000002', (select id from ids where filename = 'Lake_1.jpg')) is null, 'get_photo: other owner → null');
select pg_temp.ok(photo_file('20000000-0000-0000-0000-000000000002', (select id from ids where filename = 'Lake_1.jpg')) is null, 'photo_file: other owner → null');
select pg_temp.ok(patch_photo('20000000-0000-0000-0000-000000000002', (select id from ids where filename = 'Lake_1.jpg'), true, null) is null, 'patch_photo: other owner → null');
select pg_temp.ok(patch_photo('20000000-0000-0000-0000-000000000001', (select id from ids where filename = 'Lake_1.jpg'), true, E' Sunrise\u0001.jpg ') ->> 'filename' = 'Sunrise.jpg', 'patch_photo renames (cleaned) and favourites');
select pg_temp.ok(patch_photo('20000000-0000-0000-0000-000000000001', (select id from ids where filename = 'Lake_1.jpg'), null, '   ') ->> 'error' = 'invalid', 'patch_photo: blank name → invalid');
select pg_temp.ok(jsonb_array_length(list_photos('20000000-0000-0000-0000-000000000001', p_view => 'favourites') -> 'items') = 1, 'view favourites');
select pg_temp.ok(bulk_photos('20000000-0000-0000-0000-000000000002', (select array_agg(id) from ids), 'trash') ->> 'affected' = '0', 'bulk: another member affects nothing');
select pg_temp.ok(bulk_photos('20000000-0000-0000-0000-000000000001', (select array_agg(id) from ids), 'favourite') ->> 'affected' = '5', 'bulk favourite');
select pg_temp.ok(bulk_photos('20000000-0000-0000-0000-000000000001', (select array_agg(id) from ids), 'delete_forever') ->> 'affected' = '0', 'delete_forever only applies to Trash');

-- ---- Albums -------------------------------------------------------------------------------------------
insert into t select 'a1', create_album('20000000-0000-0000-0000-000000000001', ' Lakes ', (select array_agg(id) from ids));
select pg_temp.ok((select v ->> 'name' = 'Lakes' and (v ->> 'photoCount')::int = 5 and jsonb_array_length(v -> 'coverPhotoIds') = 3 from t where k = 'a1'), 'create_album with photos');
select pg_temp.ok(create_album('20000000-0000-0000-0000-000000000002', 'Not yours', (select array_agg(id) from ids)) ->> 'photoCount' = '0', 'create_album ignores other owners'' photos');
select pg_temp.ok(get_album('20000000-0000-0000-0000-000000000002', (select (v ->> 'id')::uuid from t where k = 'a1')) is null, 'get_album: other owner → null');
select pg_temp.ok(patch_album('20000000-0000-0000-0000-000000000002', (select (v ->> 'id')::uuid from t where k = 'a1'), 'Mine', false, null) is null, 'patch_album: other owner → null');
select pg_temp.ok(delete_album('20000000-0000-0000-0000-000000000002', (select (v ->> 'id')::uuid from t where k = 'a1')) is null, 'delete_album: other owner → null');
select pg_temp.ok(list_photos('20000000-0000-0000-0000-000000000002', p_album => (select (v ->> 'id')::uuid from t where k = 'a1')) is null, 'list_photos: other owner''s album → null');
select pg_temp.ok(bulk_photos('20000000-0000-0000-0000-000000000002', array[gen_random_uuid()], 'add_to_album', (select (v ->> 'id')::uuid from t where k = 'a1')) is null, 'bulk add_to_album: other owner''s album → null');
select pg_temp.ok(jsonb_array_length(list_albums('20000000-0000-0000-0000-000000000002')) = 1, 'list_albums: only your own');
select pg_temp.ok(patch_album('20000000-0000-0000-0000-000000000001', (select (v ->> 'id')::uuid from t where k = 'a1'), null, true, (select id from ids where filename = 'Lake_4.jpg')) #>> '{coverPhotoIds,0}'
  = (select id::text from ids where filename = 'Lake_4.jpg'), 'patch_album sets the cover (shown first)');
select pg_temp.ok(patch_album('20000000-0000-0000-0000-000000000001', (select (v ->> 'id')::uuid from t where k = 'a1'), null, true, (select v #>> '{photo,id}' from t where k = 'c1')::uuid) ->> 'error' = 'invalid',
  'the cover must be in the album');
select pg_temp.ok(jsonb_array_length(list_photos('20000000-0000-0000-0000-000000000001', p_album => (select (v ->> 'id')::uuid from t where k = 'a1')) -> 'items') = 5, 'list by album');
select pg_temp.ok(get_photo('20000000-0000-0000-0000-000000000001', (select id from ids where filename = 'Lake_2.jpg')) #>> '{albums,0,name}' = 'Lakes', 'photo detail lists its albums');
do $$ begin
  begin
    insert into public.album_photos (album_id, photo_id)
    select a.id, (select id from ids limit 1) from public.albums a where a.owner_id = '20000000-0000-0000-0000-000000000002';
    raise exception 'FAILED: an album took another owner''s photo';
  exception when check_violation then raise notice 'ok - an album can''t hold another owner''s photo (trigger)';
  end;
  begin
    update public.albums set cover_photo_id = (select id from ids limit 1) where owner_id = '20000000-0000-0000-0000-000000000002';
    raise exception 'FAILED: an album took another owner''s cover';
  exception when check_violation then raise notice 'ok - an album can''t use another owner''s photo as cover (trigger)';
  end;
end $$;
select pg_temp.ok(bulk_photos('20000000-0000-0000-0000-000000000001', array[(select id from ids where filename = 'Lake_2.jpg')], 'remove_from_album', (select (v ->> 'id')::uuid from t where k = 'a1')) ->> 'affected' = '1', 'bulk remove_from_album');

-- ---- Trash, restore and purge -------------------------------------------------------------------------
select pg_temp.ok(bulk_photos('20000000-0000-0000-0000-000000000001', (select array_agg(id) from ids), 'trash') ->> 'affected' = '5', 'bulk trash');
select pg_temp.ok((select (e ->> 'purgeAt')::timestamptz = now() + interval '30 days' from jsonb_array_elements(list_photos('20000000-0000-0000-0000-000000000001', p_view => 'trash') -> 'items') e limit 1),
  'Trash items show their purge date (30 days)');
select pg_temp.ok(get_album('20000000-0000-0000-0000-000000000001', (select (v ->> 'id')::uuid from t where k = 'a1')) ->> 'photoCount' = '0', 'trashed photos leave album counts');
select pg_temp.ok(create_uploads('20000000-0000-0000-0000-000000000001', jsonb_build_array(pg_temp.file('lake.jpg', 1001, 'jpeg', 'lake1'))) #>> '{results,0,photoId}'
  = (select id::text from ids where filename = 'Lake_1.jpg'), 'uploading a trashed file again → duplicate with the trashed id (restore instead)');
select pg_temp.ok(bulk_photos('20000000-0000-0000-0000-000000000001', array[(select id from ids where filename = 'Lake_1.jpg')], 'restore') ->> 'affected' = '1', 'bulk restore');
select pg_temp.ok(get_album('20000000-0000-0000-0000-000000000001', (select (v ->> 'id')::uuid from t where k = 'a1')) ->> 'photoCount' = '1', 'a restored photo is back in its album');
insert into t select 'df', bulk_photos('20000000-0000-0000-0000-000000000001', array[(select id from ids where filename = 'Lake_2.jpg')], 'delete_forever');
select pg_temp.ok((select v ->> 'affected' = '1' and jsonb_array_length(v #> '{purge,0,keys}') = 5 from t where k = 'df'), 'delete_forever from Trash returns the R2 keys');
select pg_temp.ok(bulk_photos('20000000-0000-0000-0000-000000000001', array[(select id from ids where filename = 'Lake_2.jpg')], 'restore') ->> 'affected' = '0', 'a purging photo can''t be restored');
select pg_temp.ok(get_photo('20000000-0000-0000-0000-000000000001', (select id from ids where filename = 'Lake_2.jpg')) is null, 'a purging photo is hidden');
select pg_temp.ok(create_uploads('20000000-0000-0000-0000-000000000001', jsonb_build_array(pg_temp.file('lake2.jpg', 1002, 'jpeg', 'lake2'))) #>> '{results,0,status}' = 'ready',
  'a purging photo is not a duplicate');
select pg_temp.ok(pg_temp.all_ok(), 'no drift: purging photos still count until confirmed');
select pg_temp.ok(confirm_photo_purges(array[(select id from ids where filename = 'Lake_2.jpg')]) = 1, 'confirm_photo_purges');
select pg_temp.ok(pg_temp.all_ok(), 'no drift after confirm_photo_purges');
-- Trash past its date is purged by the job.
update public.photos set purge_after = now() - interval '1 second' where id = (select id from ids where filename = 'Lake_3.jpg');
insert into t select 'dp', due_photo_purges(100);
select pg_temp.ok((select jsonb_array_length(v) = 1 and (v #>> '{0,photoId}')::uuid = (select id from ids where filename = 'Lake_3.jpg') from t where k = 'dp'),
  'due_photo_purges picks up only expired Trash');
select pg_temp.ok((select status = 'purging' from public.photos where id = (select id from ids where filename = 'Lake_3.jpg')), 'and marks it purging');
select pg_temp.ok(confirm_photo_purges(array[(select id from ids where filename = 'Lake_3.jpg'), (select id from ids where filename = 'Lake_4.jpg')]) = 1,
  'confirm only removes purging photos (not still-trashed ones)');
insert into t select 'et', empty_trash('20000000-0000-0000-0000-000000000001');
select pg_temp.ok((select (v ->> 'deleted')::int = 2 and jsonb_array_length(v -> 'purge') = 2 from t where k = 'et'), 'empty_trash');
select pg_temp.ok(empty_trash('20000000-0000-0000-0000-000000000002') ->> 'deleted' = '0', 'empty_trash is per owner');
select pg_temp.ok(confirm_photo_purges((select array_agg((e ->> 'photoId')::uuid) from t, jsonb_array_elements(v -> 'purge') e where k = 'et')) = 2, 'confirm after empty_trash');
select pg_temp.ok(pg_temp.all_ok(), 'no drift after Trash');

-- ---- Usage -----------------------------------------------------------------------------------------
select pg_temp.ok((select (u ->> 'limitBytes')::bigint = 5::bigint * 1073741824 and u ->> 'plan' = 'free' and u -> 'fileTypes' = '["jpeg", "png", "webp"]'
  and (u ->> 'maxFileBytes')::bigint = 50 * 1048576 and (u ->> 'batchSize')::int = 25
  and (u ->> 'usedBytes')::bigint = (select storage_bytes from public.profiles where id = '20000000-0000-0000-0000-000000000001')
  from get_usage('20000000-0000-0000-0000-000000000001') u), 'get_usage follows the active plan limits');
select pg_temp.ok(get_usage('20000000-0000-0000-0000-000000000002') ->> 'batchSize' = '500', 'get_usage: pro');

-- ---- Account deletion ----------------------------------------------------------------------------
select pg_temp.ok(request_account_deletion('20000000-0000-0000-0000-000000000003') = now() + interval '30 days', 'request_account_deletion: 30 days');
select pg_temp.ok(get_session_profile('20000000-0000-0000-0000-000000000003') ->> 'deletionDue' is not null, 'the session profile shows the pending deletion');
select pg_temp.ok(create_uploads('20000000-0000-0000-0000-000000000003', jsonb_build_array(pg_temp.file('a.jpg', 10, 'jpeg', 'ana'))) ->> 'error' = 'account_pending_deletion',
  'no uploads while deletion is pending');
select pg_temp.ok(exists (select 1 from public.audit_log where action = 'account.deletion_requested'), 'deletion request is audited');
select pg_temp.ok(restore_account('20000000-0000-0000-0000-000000000003'), 'restore_account');
select pg_temp.ok(get_session_profile('20000000-0000-0000-0000-000000000003') ->> 'deletionDue' is null, 'restored: nothing pending');
select pg_temp.ok(restore_account('20000000-0000-0000-0000-000000000003') is null, 'restore with nothing pending → null');
select request_account_deletion('20000000-0000-0000-0000-000000000003');
select pg_temp.ok(jsonb_array_length(due_account_purges(10)) = 0, 'nothing is due before the date');
update public.profiles set deletion_due = now() - interval '1 second', deletion_requested_at = now() - interval '31 days'
 where id in ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001');
select pg_temp.ok((select jsonb_array_length(d) = 1 and d #>> '{0,ownerId}' = '20000000-0000-0000-0000-000000000003'
  and d #>> '{0,prefix}' = 'u/20000000-0000-0000-0000-000000000003/' from due_account_purges(10) d), 'due_account_purges: due members only (never staff)');
select pg_temp.ok(restore_account('20000000-0000-0000-0000-000000000003') is null, 'too late to restore after the date');
select pg_temp.ok(jsonb_array_length(due_account_purges(10)) = 0, 'an account attempted in the last hour is skipped (backoff)');
select account_purge_progress('20000000-0000-0000-0000-000000000003');
select pg_temp.ok(jsonb_array_length(due_account_purges(10)) = 1, 'after progress it is picked up again on the next run');
update public.profiles set purge_attempts = 4, purge_attempted_at = now() - interval '2 hours' where id = '20000000-0000-0000-0000-000000000003';
select pg_temp.ok(jsonb_array_length(due_account_purges(10)) = 1, 'retried after the hour');
select pg_temp.ok(exists (select 1 from public.audit_log where action = 'jobs.account_purge_failing' and target = '20000000-0000-0000-0000-000000000003'),
  'the fifth failed attempt raises an audit alert');
-- The Worker deletes the Auth user; everything cascades.
delete from auth.users where id = '20000000-0000-0000-0000-000000000001';
select pg_temp.ok(not exists (select 1 from public.photos where owner_id = '20000000-0000-0000-0000-000000000001')
  and not exists (select 1 from public.albums where owner_id = '20000000-0000-0000-0000-000000000001')
  and not exists (select 1 from public.uploads where owner_id = '20000000-0000-0000-0000-000000000001'), 'deleting the Auth user cascades to the library');

-- ---- Jobs bookkeeping ---------------------------------------------------------------------------------
select record_cleanup('{"photosPurged": 3, "objectsDeleted": 9, "orphansDeleted": 1}');
select pg_temp.ok(exists (select 1 from public.audit_log where action = 'jobs.cleanup' and actor is null and target is null
  and details = '{"photosPurged": 3, "objectsDeleted": 9, "orphansDeleted": 1}'), 'record_cleanup writes counts only');
do $$ begin
  begin
    perform public.record_cleanup('{"email": "x@example.com"}');
    raise exception 'FAILED: record_cleanup took an unknown key';
  exception when invalid_parameter_value then raise notice 'ok - record_cleanup refuses anything but counts';
  end;
end $$;
select pg_temp.ok(purge_rate_limits() >= 0, 'purge_rate_limits');
insert into t select 'sw', create_uploads('20000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.file('sw.jpg', 100, 'jpeg', 'sweep')));
select pg_temp.ok((select jsonb_array_length(r) = 2
    and (select bool_and((e ->> 'activeUpload')::boolean = ((e ->> 'status') = 'uploading')) from jsonb_array_elements(r) e)
  from sweep_photo_rows(array[(select (v #>> '{results,0,photoId}')::uuid from t where k = 'sw'),
                              (select (v #>> '{results,0,photoId}')::uuid from t where k = 'vs'), gen_random_uuid()]) r),
  'sweep_photo_rows: known photos with their active-upload flag; unknown ids are absent');
select set_job_state('orphan_sweep_cursor', 'abc');
select set_job_state('orphan_sweep_cursor', repeat('d', 8192));
select set_job_state('orphan_sweep_cursor', 'def');
select pg_temp.ok(get_job_state('orphan_sweep_cursor') = 'def', 'job state round-trips');
do $$ begin
  begin
    perform public.set_job_state('anything', 'x');
    raise exception 'FAILED: job_state took an unknown key';
  exception when check_violation then raise notice 'ok - job_state only takes known keys';
  end;
end $$;

-- ---- Privileges ----------------------------------------------------------------------------------------
select pg_temp.ok(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['anon', 'authenticated', 'service_role']) r(role)
   where n.nspname = 'public' and c.relname in ('photos', 'uploads', 'albums', 'album_photos', 'job_state')
     and (has_table_privilege(r.role, c.oid, 'select') or has_table_privilege(r.role, c.oid, 'insert')
          or has_table_privilege(r.role, c.oid, 'update') or has_table_privilege(r.role, c.oid, 'delete'))
     and r.role <> 'service_role'
), 'browser roles hold no privileges on library tables');
set local role authenticated;
do $$ begin
  begin
    perform public.list_photos('20000000-0000-0000-0000-000000000002');
    raise exception 'FAILED: authenticated could list photos';
  exception when insufficient_privilege then raise notice 'ok - members cannot call library functions directly';
  end;
  begin
    perform count(*) from public.photos;
    raise exception 'FAILED: authenticated could read photos';
  exception when insufficient_privilege then raise notice 'ok - members cannot read the photos table';
  end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform public.create_uploads('20000000-0000-0000-0000-000000000002', '[]');
    raise exception 'FAILED: anon could create uploads';
  exception when insufficient_privilege then raise notice 'ok - anon cannot create uploads';
  end;
end $$;
reset role;
select pg_temp.ok(has_function_privilege('service_role', 'public.complete_upload(uuid, uuid, jsonb, integer, integer)', 'execute')
  and not has_function_privilege('service_role', 'public._clean_metadata(jsonb)', 'execute'), 'service_role calls entry points, not helpers');

rollback;
\echo 'All library tests passed.'
