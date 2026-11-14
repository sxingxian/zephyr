-- Assertions for the sharing migration (phase 5): galleries and plan limits, passcode attempts and pauses,
-- guest reads, renditions and full-size renders with storage accounting, favourites, branding, safety
-- holds, clean-up, account purge, cross-owner isolation and privileges. Run with supabase/tests/run-local.sh.
\set ON_ERROR_STOP on
begin;

create function pg_temp.ok(cond boolean, what text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok - %', what;
end $$;
grant execute on function pg_temp.ok(boolean, text) to public;
-- The usage invariant, with edited variants and share objects.
create function pg_temp.no_drift(o uuid) returns boolean language sql as $$
  select pr.storage_bytes =
           (select coalesce(sum(p.size_bytes + p.thumb_bytes + p.preview_bytes), 0) from public.photos p
             where p.owner_id = o and p.status in ('ready', 'trashed', 'purging'))
         + (select coalesce(sum(e.thumb_bytes + e.preview_bytes), 0) from public.photo_edits e
              join public.photos p on p.id = e.photo_id
             where p.owner_id = o and p.status in ('ready', 'trashed', 'purging'))
         + (select coalesce(sum(r.bytes), 0) from public.gallery_renditions r where r.owner_id = o)
         + (select coalesce(sum(r.bytes), 0) from public.gallery_renders r where r.owner_id = o)
         + (select coalesce(sum(b.logo_bytes + b.wm_bytes), 0) from public.branding b where b.owner_id = o)
  from public.profiles pr where pr.id = o
$$;
create function pg_temp.all_ok() returns boolean language sql as $$
  select bool_and(pg_temp.no_drift(id)) from public.profiles
$$;
create function pg_temp.photo(o uuid, n text, t text default 'jpeg') returns uuid language plpgsql as $$
declare id uuid;
begin
  insert into public.photos (owner_id, status, file_type, filename, size_bytes, sha256, width, height, has_thumb, has_preview, thumb_bytes, preview_bytes)
  values (o, 'ready', t, n, 1000, extensions.digest(n || o::text, 'sha256'), 4000, 3000, true, t = 'jpeg' or t = 'cr2', 100, 200)
  returning photos.id into id;
  update public.profiles set storage_bytes = storage_bytes + 1300 where profiles.id = o;
  return id;
end $$;
create function pg_temp.h(t text) returns bytea language sql as $$ select extensions.digest(t, 'sha256') $$;
-- A gallery; returns create_gallery's result. Days from today (UTC).
create function pg_temp.mk(o uuid, id uuid, tok text, pass boolean, photos uuid[], days integer, dl text, x jsonb default '{}')
returns jsonb language sql as $$
  select public.create_gallery(o, id, pg_temp.h(tok), left(tok, 8), pg_temp.h('ct:' || tok), substr(pg_temp.h('iv'), 1, 12),
    case when pass then pg_temp.h('code:' || tok) end,
    'Wedding', null, photos, (now() at time zone 'utc')::date + days, dl, x)
$$;
-- Rendition and render keys as the Worker would write them (md5: 32 lower-case hex).
create function pg_temp.rk(o uuid, g uuid, p uuid, size text, n text) returns text language sql as $$
  select 'o/' || o || '/g/' || g || '/' || p || '/' || size || '-' || md5(n)
$$;
create function pg_temp.fk(o uuid, g uuid, p uuid, v integer, n text) returns text language sql as $$
  select 'u/' || o || '/g/' || g || '/' || p || '/full-' || v || '-' || md5(n)
$$;

insert into auth.users (id, email, email_confirmed_at) values
  ('50000000-0000-0000-0000-000000000001', 'mei5@example.com', now()),
  ('50000000-0000-0000-0000-000000000002', 'wei5@example.com', now()),
  ('50000000-0000-0000-0000-000000000003', 'ana5@example.com', now());
update public.profiles set plan_id = 'studio' where id = '50000000-0000-0000-0000-000000000001';
update public.profiles set plan_id = 'pro' where id = '50000000-0000-0000-0000-000000000003';
create temp table ids (k text primary key, id uuid);
grant all on ids to public;
insert into ids values
  ('mei', '50000000-0000-0000-0000-000000000001'),
  ('wei', '50000000-0000-0000-0000-000000000002'),
  ('ana', '50000000-0000-0000-0000-000000000003'),
  ('g1', '5a000000-0000-0000-0000-000000000001'),
  ('g2', '5a000000-0000-0000-0000-000000000002'),
  ('gw1', '5b000000-0000-0000-0000-000000000001'),
  ('gw2', '5b000000-0000-0000-0000-000000000002'),
  ('gw3', '5b000000-0000-0000-0000-000000000003'),
  ('gw4', '5b000000-0000-0000-0000-000000000004'),
  ('ga1', '5c000000-0000-0000-0000-000000000001');
insert into ids select 'p1', pg_temp.photo((select id from ids where k = 'mei'), 'a.jpg');
insert into ids select 'p2', pg_temp.photo((select id from ids where k = 'mei'), 'b.jpg');
insert into ids select 'p3', pg_temp.photo((select id from ids where k = 'mei'), 'c.cr2', 'cr2');
insert into ids select 'p4', pg_temp.photo((select id from ids where k = 'mei'), 'd.jpg');
insert into ids select 'w1', pg_temp.photo((select id from ids where k = 'wei'), 'w.jpg');
insert into ids select 'a1', pg_temp.photo((select id from ids where k = 'ana'), 'x.jpg');
create function pg_temp.i(k text) returns uuid language sql as $$ select id from ids where ids.k = $1 $$;

-- ---- Plan limits ------------------------------------------------------------------------------------------
select pg_temp.ok((select bool_and(guest_favourites = (plan_id = 'studio') and watermark = (plan_id = 'studio')
                                   and access_log = (plan_id = 'studio')) from public.plan_limits),
  'the new plan limits are Studio-only');

-- ---- Creating galleries -----------------------------------------------------------------------------------
select pg_temp.ok(pg_temp.mk(pg_temp.i('wei'), pg_temp.i('gw1'), 'w-tok-1', true, array[pg_temp.i('w1')], 3, 'full') ->> 'error' = 'plan',
  'Free: full-size downloads → plan');
select pg_temp.ok(pg_temp.mk(pg_temp.i('wei'), pg_temp.i('gw1'), 'w-tok-1', true, array[pg_temp.i('w1')], 3, 'web', '{"favourites":true}') ->> 'error' = 'plan',
  'Free: a Studio extra → plan');
select pg_temp.ok(pg_temp.mk(pg_temp.i('wei'), pg_temp.i('gw1'), 'w-tok-1', true, array[pg_temp.i('w1')], 8, 'web') ->> 'error' = 'expiry',
  'Free: longer than 7 days → expiry');
select pg_temp.ok(pg_temp.mk(pg_temp.i('wei'), pg_temp.i('gw1'), 'w-tok-1', true, array[pg_temp.i('w1')], -1, 'web') ->> 'error' = 'expiry',
  'an expiry in the past → expiry');
select pg_temp.ok(pg_temp.mk(pg_temp.i('mei'), pg_temp.i('g1'), 'm-tok-x', true, array[pg_temp.i('p1')], 366, 'web') ->> 'error' = 'expiry',
  'Studio: capped at the 365-day system ceiling');
select pg_temp.ok(pg_temp.mk(pg_temp.i('wei'), pg_temp.i('gw1'), 'w-tok-1', true, array[pg_temp.i('p1')], 3, 'web') ->> 'error' = 'no_photos',
  'only the owner''s photos: someone else''s → no_photos');
select pg_temp.ok((select v #>> '{gallery,status}' = 'live' and (v #>> '{gallery,photoCount}')::int = 1
                     and v #>> '{gallery,passcode}' = 'true' and v #>> '{gallery,linkHint}' = 'w-tok-1'
                     and (v #>> '{gallery,expiresAt}')::timestamptz = ((now() at time zone 'utc')::date + 8)::timestamp at time zone 'utc'
  from (select pg_temp.mk(pg_temp.i('wei'), pg_temp.i('gw1'), 'w-tok-1', true, array[pg_temp.i('w1'), pg_temp.i('p1'), pg_temp.i('w1')], 7, 'web') v) x),
  'creates a gallery of the owner''s photos (duplicates and others'' ignored), ending at the end of the day UTC');
select pg_temp.mk(pg_temp.i('wei'), pg_temp.i('gw2'), 'w-tok-2', false, array[pg_temp.i('w1')], 3, 'none');
select pg_temp.mk(pg_temp.i('wei'), pg_temp.i('gw3'), 'w-tok-3', false, array[pg_temp.i('w1')], 3, 'none');
select pg_temp.ok(pg_temp.mk(pg_temp.i('wei'), pg_temp.i('gw4'), 'w-tok-4', false, array[pg_temp.i('w1')], 3, 'none') ->> 'error' = 'limit',
  'Free: at most 3 live galleries');
select pg_temp.ok((select v #>> '{gallery,photoCount}' = '4' and v #>> '{gallery,extras,watermark}' = 'true'
  from (select pg_temp.mk(pg_temp.i('mei'), pg_temp.i('g1'), 'm-tok-1', true,
    array[pg_temp.i('p1'), pg_temp.i('p2'), pg_temp.i('p3'), pg_temp.i('p4')], 30, 'full',
    '{"favourites":true,"watermark":true,"branding":true,"accessLog":true}') v) x), 'Studio: full-size downloads and every extra');
select pg_temp.ok((select v #>> '{gallery,pendingRenders}' = '1' from (select jsonb_build_object('gallery', get_gallery(pg_temp.i('mei'), pg_temp.i('g1'))) v) x),
  'a RAW photo needs a full-size render from the device');
select pg_temp.mk(pg_temp.i('mei'), pg_temp.i('g2'), 'm-tok-2', false, array[pg_temp.i('p1'), pg_temp.i('p2')], 30, 'web');
select pg_temp.ok(gallery_link(pg_temp.i('mei'), pg_temp.i('g1')) ->> 'ciphertext' = encode(pg_temp.h('ct:m-tok-1'), 'hex')
  and gallery_link(pg_temp.i('wei'), pg_temp.i('g1')) is null, 'the encrypted link is the owner''s');
select pg_temp.ok(get_gallery(pg_temp.i('wei'), pg_temp.i('g1')) is null and jsonb_array_length(list_galleries(pg_temp.i('wei'))) = 3
  and jsonb_array_length(list_galleries(pg_temp.i('mei'))) = 2, 'galleries are per owner');
do $$ begin
  begin
    insert into public.gallery_photos values ((select id from ids where k = 'g1'), (select id from ids where k = 'w1'), 9);
    raise exception 'FAILED: someone else''s photo in a gallery';
  exception when check_violation then raise notice 'ok - a gallery only ever holds its owner''s photos';
  end;
end $$;

-- ---- Changing galleries -----------------------------------------------------------------------------------
select pg_temp.ok(patch_gallery(pg_temp.i('wei'), pg_temp.i('g1'), '{"name":"Mine"}') is null, 'patch: someone else''s gallery → null');
select pg_temp.ok(patch_gallery(pg_temp.i('wei'), pg_temp.i('gw1'), '{"downloads":"full"}') ->> 'error' = 'plan', 'patch: Free can''t turn on full size');
select pg_temp.ok(patch_gallery(pg_temp.i('mei'), pg_temp.i('g2'), '{"name":"Reception","message":"Hi"}') #>> '{gallery,name}' = 'Reception', 'patch: rename');
select pg_temp.ok(update_gallery_photos(pg_temp.i('mei'), pg_temp.i('g2'), array[pg_temp.i('p4'), pg_temp.i('w1')], null) ->> 'count' = '3',
  'add photos (others'' ignored)');
select pg_temp.ok(update_gallery_photos(pg_temp.i('wei'), pg_temp.i('g2'), array[pg_temp.i('w1')], null) is null, 'adding to someone else''s gallery → null');
select pg_temp.ok((select jsonb_agg(x ->> 'photoId') from jsonb_array_elements(list_gallery_photos(pg_temp.i('mei'), pg_temp.i('g2'), null, 2) -> 'items') x)
    = jsonb_build_array(pg_temp.i('p1'), pg_temp.i('p2'))
  and list_gallery_photos(pg_temp.i('mei'), pg_temp.i('g2'), null, 2) ->> 'nextCursor' = '2'
  and list_gallery_photos(pg_temp.i('mei'), pg_temp.i('g2'), 2, 2) #>> '{items,0,photoId}' = pg_temp.i('p4')::text,
  'photos page in gallery order with a position cursor');

-- ---- Passcodes and unlocking ------------------------------------------------------------------------------
select pg_temp.ok(gallery_unlock_reserve(pg_temp.i('g2'), pg_temp.h('net1'), false) ->> 'status' = 'open', 'no passcode → open');
select pg_temp.ok((select v ->> 'status' = 'ok' and v ->> 'hmac' = encode(pg_temp.h('code:m-tok-1'), 'hex') and v ->> 'generation' = '1'
  from (select gallery_unlock_reserve(pg_temp.i('g1'), pg_temp.h('net1'), false) v) x), 'first attempt: reserved, with the stored HMAC');
select gallery_unlock_reserve(pg_temp.i('g1'), pg_temp.h('net1'), false);
select pg_temp.ok(gallery_unlock_reserve(pg_temp.i('g1'), pg_temp.h('net1'), false) ->> 'status' = 'turnstile'
  and (select count(*) from public.gallery_attempts where gallery_id = pg_temp.i('g1')) = 2,
  'after 2 failures from a network, Turnstile is required (nothing counted without it)');
select pg_temp.ok(guest_gallery_info(pg_temp.h('m-tok-1'), pg_temp.h('net1')) ->> 'turnstile' = 'true'
  and guest_gallery_info(pg_temp.h('m-tok-1'), pg_temp.h('net2')) ->> 'turnstile' = 'false', 'the guest page knows when to show Turnstile');
select gallery_unlock_reserve(pg_temp.i('g1'), pg_temp.h('net1'), true) from generate_series(1, 3);
select pg_temp.ok((select v ->> 'status' = 'limited' and (v ->> 'retryAfter')::int between 1 and 900
  from (select gallery_unlock_reserve(pg_temp.i('g1'), pg_temp.h('net1'), true) v) x), '5 per network per 15 minutes → limited');
select pg_temp.ok((select (v ->> 'status') = 'ok' from (select gallery_unlock_reserve(pg_temp.i('g1'), pg_temp.h('net2'), false) v) x),
  'another network still has its own allowance');
select gallery_unlock_succeeded((select max(id) from public.gallery_attempts where gallery_id = pg_temp.i('g1')));
select pg_temp.ok((select count(*) from public.gallery_attempts where gallery_id = pg_temp.i('g1')) = 5, 'a right passcode stops counting');
insert into public.gallery_attempts (gallery_id, network_hash) select pg_temp.i('g1'), pg_temp.h('net' || n) from generate_series(10, 28) n;
select pg_temp.ok((select v ->> 'status' = 'ok' and v ->> 'pausedNow' = 'true' and v ->> 'ownerEmail' = 'mei5@example.com'
  from (select gallery_unlock_reserve(pg_temp.i('g1'), pg_temp.h('net3'), false) v) x), 'the 25th failure from anywhere pauses the gallery');
select pg_temp.ok((select paused_notified_at is not null from public.galleries where id = pg_temp.i('g1')), 'the pause email is recorded');
select pg_temp.ok(gallery_unlock_reserve(pg_temp.i('g1'), pg_temp.h('net4'), false) ->> 'status' = 'paused'
  and get_gallery(pg_temp.i('mei'), pg_temp.i('g1')) ->> 'status' = 'paused'
  and guest_gallery_info(pg_temp.h('m-tok-1'), pg_temp.h('net4')) ->> 'state' = 'paused'
  and guest_gallery_state(pg_temp.h('m-tok-1')) ->> 'serving' = 'true', 'paused: no unlocking, but unlocked guests are still served');
-- (Checks that read what an earlier call in the same statement wrote run as a separate statement: a
-- statement's subqueries and stable functions see the database as it was when the statement began.)
select patch_gallery(pg_temp.i('mei'), pg_temp.i('g1'), '{"unpause":true}') #>> '{gallery,status}' as st \gset
select pg_temp.ok(:'st' = 'live'
  and not exists (select 1 from public.gallery_attempts where gallery_id = pg_temp.i('g1')), 'reopen clears the pause and the attempts');
insert into public.gallery_attempts (gallery_id, network_hash) select pg_temp.i('g1'), pg_temp.h('again' || n) from generate_series(1, 24) n;
select pg_temp.ok((select v ->> 'pausedNow' = 'true' and v ->> 'ownerEmail' is null and v ->> 'name' is null
  from (select gallery_unlock_reserve(pg_temp.i('g1'), pg_temp.h('again0'), false) v) x),
  'paused again within a day: no second email to the owner');
select patch_gallery(pg_temp.i('mei'), pg_temp.i('g1'), '{"unpause":true}');
select pg_temp.ok(gallery_passcode_state(pg_temp.i('mei'), pg_temp.i('g1')) ->> 'generation' = '1'
  and gallery_passcode_state(pg_temp.i('wei'), pg_temp.i('g1')) is null, 'passcode state is the owner''s');
select set_gallery_passcode(pg_temp.i('mei'), pg_temp.i('g1'), 3, pg_temp.h('new')) as a,
       set_gallery_passcode(pg_temp.i('mei'), pg_temp.i('g1'), 2, pg_temp.h('new')) as b \gset
select pg_temp.ok(:'a' = 'conflict' and :'b' = 'ok'
  and guest_gallery_state(pg_temp.h('m-tok-1')) ->> 'generation' = '2', 'a new passcode moves to the next generation only');
select pg_temp.ok(set_gallery_passcode(pg_temp.i('wei'), pg_temp.i('g1'), 3, null) is null, 'someone else can''t change it');

-- ---- Guest reads ------------------------------------------------------------------------------------------
select pg_temp.ok(guest_gallery_state(pg_temp.h('nope')) is null and guest_gallery_info(pg_temp.h('nope'), pg_temp.h('net1')) is null,
  'unknown token → null');
select pg_temp.ok((select v ->> 'state' = 'locked' and v ->> 'favourites' = 'true' and v ->> 'downloads' = 'full'
                     and v #>> '{brand,studioName}' = 'Zephyr' and not (v ? 'items')
  from (select guest_gallery_info(pg_temp.h('m-tok-1'), pg_temp.h('net1')) v) x), 'guest info: locked, Studio extras, no photos');
select pg_temp.ok((select jsonb_agg(x ->> 'full' order by n) = '["ready","ready","pending","ready"]'::jsonb
  from jsonb_array_elements(guest_photos(pg_temp.i('g1'), null, 10, null) -> 'items') with ordinality t(x, n)),
  'guest photos: full size ready for unedited JPEGs, pending for RAW');
select pg_temp.ok(guest_photos(pg_temp.i('g2'), null, 10, null) -> 'selection' = 'null'::jsonb, 'no favourites → no selection');

-- ---- Renditions and storage -------------------------------------------------------------------------------
select pg_temp.ok(guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'grid', false) ->> 'unavailable' = 'pending'
  and guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'view', false) ->> 'unavailable' = 'pending'
  and get_gallery(pg_temp.i('mei'), pg_temp.i('g1')) ->> 'watermarkReady' = 'false'
  and get_branding(pg_temp.i('mei')) ->> 'watermarkReady' = 'false',
  'watermark on without an image to draw → pending, never unwatermarked (watermarkReady false)');
select patch_gallery(pg_temp.i('mei'), pg_temp.i('g1'), '{"extras":{"watermark":false}}');
select pg_temp.ok((select v #>> '{source,key}' = 'u/' || pg_temp.i('mei') || '/p/' || pg_temp.i('p1') || '/preview'
                     and v -> 'rendition' = 'null'::jsonb and v -> 'watermark' = 'null'::jsonb and v ->> 'wmVersion' = '0'
                     and v ->> 'galleryName' = 'Wedding' and v ->> 'position' = '0' and not (v ? 'filename')
  from (select guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'grid', false) v) x),
  'grid comes from the preview; the plan names the gallery and position, never the member''s file name');
select pg_temp.ok(guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'full', false) ->> 'unavailable' = 'not_allowed'
  and guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'grid', true) ->> 'unavailable' = 'not_allowed'
  and guest_media(pg_temp.i('gw2'), pg_temp.i('w1'), 'view', true) ->> 'unavailable' = 'not_allowed'
  and guest_media(pg_temp.i('gw2'), pg_temp.i('w1'), 'view', false) ->> 'unavailable' is null
  and guest_media(pg_temp.i('gw1'), pg_temp.i('w1'), 'view', true) ->> 'unavailable' is null,
  'downloads are checked when served: none → refused, web allowed; full only as a download; grid never');
select pg_temp.ok(guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'full', true) #>> '{source,key}' = 'u/' || pg_temp.i('mei') || '/p/' || pg_temp.i('p1') || '/original'
  and guest_media(pg_temp.i('g1'), pg_temp.i('p3'), 'full', true) ->> 'unavailable' = 'pending'
  and guest_media(pg_temp.i('g2'), pg_temp.i('p1'), 'full', true) ->> 'unavailable' = 'not_allowed'
  and guest_media(pg_temp.i('g1'), pg_temp.i('w1'), 'grid', false) is null and guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'huge', false) is null,
  'full size: the original for unedited JPEGs, pending for RAW, refused without full downloads; other photos → null');
select pg_temp.ok(record_rendition(pg_temp.i('g1'), pg_temp.i('p1'), 'grid', pg_temp.rk(pg_temp.i('wei'), pg_temp.i('g1'), pg_temp.i('p1'), 'grid', 'a'), 500, 0, 0) ->> 'status' = 'invalid'
  and record_rendition(pg_temp.i('g1'), pg_temp.i('p1'), 'grid', pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 'view', 'a'), 500, 0, 0) ->> 'status' = 'invalid'
  and record_rendition(pg_temp.i('g1'), pg_temp.i('p1'), 'grid', pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 'grid', 'a'), 0, 0, 0) ->> 'status' = 'invalid',
  'record_rendition: a key outside the owner''s gallery prefix, the wrong size or no bytes → invalid');
select pg_temp.ok(record_rendition(pg_temp.i('g1'), pg_temp.i('p1'), 'grid', pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 'grid', 'a'), 500, 3, 0) ->> 'status' = 'gone',
  'record_rendition: made from another edit version → gone');
select record_rendition(pg_temp.i('g1'), pg_temp.i('p1'), 'grid', pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 'grid', 'a'), 500, 0, 0) ->> 'status' as st \gset
select pg_temp.ok(:'st' = 'ok'
  and guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'grid', false) #>> '{rendition,key}' = pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 'grid', 'a')
  and pg_temp.all_ok(), 'a recorded rendition is served next time and counts toward storage');
select pg_temp.ok((select v ->> 'status' = 'exists' and v ->> 'key' = pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 'grid', 'a')
  from (select record_rendition(pg_temp.i('g1'), pg_temp.i('p1'), 'grid', pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 'grid', 'b'), 600, 0, 0) v) x),
  'a racing request finds the rendition already recorded');
select record_rendition(pg_temp.i('g1'), pg_temp.i('p2'), 'view', pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p2'), 'view', 'a'), 900, 0, 0);
-- An edit with a stored preview: grid and view now come from it, and the old rendition is replaced.
select save_edit(pg_temp.i('mei'), pg_temp.i('p1'), '{"v":1,"light":{"exposure":0.5}}', null);
select pg_temp.ok(guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'grid', false) ->> 'unavailable' = 'pending'
  and guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'view', true) ->> 'unavailable' = 'pending'
  and record_rendition(pg_temp.i('g1'), pg_temp.i('p1'), 'view', pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 'view', 'pre'), 500, 0, 0) ->> 'status' = 'gone',
  'edited but its preview not rendered yet → pending (never the unedited original, nor the rendition made from it)');
select record_edit_variant(pg_temp.i('mei'), pg_temp.i('p1'), 1, 'preview',
  'u/' || pg_temp.i('mei') || '/p/' || pg_temp.i('p1') || '/edit-1-preview-' || md5('e1'), 700);
select pg_temp.ok((select v #>> '{source,editVersion}' = '1' and v -> 'rendition' = 'null'::jsonb
                     and v #>> '{source,key}' like '%/edit-1-preview-%'
  from (select guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'grid', false) v) x), 'an edit makes a new rendition from the edited preview');
select record_rendition(pg_temp.i('g1'), pg_temp.i('p1'), 'grid', pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 'grid', 'c'), 450, 1, 0) ->> 'status' as st \gset
select pg_temp.ok(:'st' = 'ok'
  and exists (select 1 from public.share_object_deletions where key = pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 'grid', 'a'))
  and pg_temp.all_ok(), 'the replaced rendition''s object is queued for deletion and its bytes released');
select pg_temp.ok(guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'full', true) ->> 'unavailable' = 'pending'
  and (get_gallery(pg_temp.i('mei'), pg_temp.i('g1')) ->> 'pendingRenders')::int = 2, 'an edited photo''s full size waits for a device render');

-- ---- Full-size renders ------------------------------------------------------------------------------------
select pg_temp.ok((select jsonb_agg(x ->> 'photoId') @> jsonb_build_array(pg_temp.i('p1'), pg_temp.i('p3')) and count(*) = 2
  from jsonb_array_elements(gallery_render_queue(pg_temp.i('mei'), pg_temp.i('g1'))) x)
  and gallery_render_queue(pg_temp.i('wei'), pg_temp.i('g1')) is null, 'render queue: the edited and the RAW photo, for the owner only');
select pg_temp.ok(gallery_render_check(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 0) ->> 'status' = 'stale'
  and gallery_render_check(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 1) ->> 'status' = 'current'
  and gallery_render_check(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p2'), 0) ->> 'status' = 'not_needed'
  and gallery_render_check(pg_temp.i('mei'), pg_temp.i('g2'), pg_temp.i('p3'), 0) is null
  and gallery_render_check(pg_temp.i('wei'), pg_temp.i('g1'), pg_temp.i('p1'), 1) is null, 'render check: stale, current, not needed, not in gallery, not the owner');
select pg_temp.ok(record_gallery_render(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 1, pg_temp.fk(pg_temp.i('mei'), pg_temp.i('g2'), pg_temp.i('p1'), 1, 'r'), 5000) ->> 'status' = 'invalid'
  and record_gallery_render(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 0, pg_temp.fk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 0, 'r'), 5000) ->> 'status' = 'gone',
  'record render: another gallery''s key → invalid; a stale version → gone');
select record_gallery_render(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 1, pg_temp.fk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 1, 'r'), 5000) ->> 'status' as a \gset
select record_gallery_render(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 1, pg_temp.fk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 1, 's'), 5000) ->> 'status' as b \gset
select pg_temp.ok(:'a' = 'ok' and :'b' = 'exists'
  and guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'full', true) #>> '{source,key}' = pg_temp.fk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 1, 'r')
  and pg_temp.all_ok(), 'a render is recorded once (a racing one → exists), becomes the full-size source and counts');
select pl.storage_gb::bigint * 1073741824 as big from public.plan_limits pl join public.plan_limit_versions v on v.id = pl.version_id and v.status = 'active' where pl.plan_id = 'studio' \gset
update public.profiles set storage_bytes = storage_bytes + :big where id = pg_temp.i('mei');
select pg_temp.ok(record_gallery_render(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p3'), 0, pg_temp.fk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p3'), 0, 'r'), 5000) ->> 'status' = 'storage_full'
  and record_rendition(pg_temp.i('g1'), pg_temp.i('p1'), 'full', pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p1'), 'full', 'a'), 9000, 1, 0) ->> 'status' = 'storage_full'
  and record_rendition(pg_temp.i('g1'), pg_temp.i('p4'), 'grid', pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p4'), 'grid', 'a'), 300, 0, 0) ->> 'status' = 'ok',
  'storage full: renders and full renditions refused, grid and view still recorded');
-- Past the overflow allowance too: previews are refused as storage_full (never 'gone') and the member is told.
select public._share_overflow(:big) as over \gset
update public.profiles set storage_bytes = storage_bytes + :over where id = pg_temp.i('mei');
select pg_temp.ok(get_usage(pg_temp.i('mei')) #>> '{sharing,previewsBlocked}' = 'false'
  and guest_media(pg_temp.i('g1'), pg_temp.i('p2'), 'grid', false) ->> 'storageFull' = 'true',
  'past the overflow allowance: previews are refused, but no notice until one actually was');
-- (Separate statements: a statement's stable reads don't see what its own volatile calls wrote.)
select record_rendition(pg_temp.i('g1'), pg_temp.i('p2'), 'grid', pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p2'), 'grid', 'full'), 300, 0, 0) ->> 'status' as st \gset
select pg_temp.ok(:'st' = 'storage_full'
  and (select share_previews_blocked_at = now() from public.profiles where id = pg_temp.i('mei'))
  and get_usage(pg_temp.i('mei')) #>> '{sharing,previewsBlocked}' = 'true'
  and not exists (select 1 from public.gallery_renditions where key = pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p2'), 'grid', 'full')),
  'past the overflow allowance: record_rendition → storage_full (not gone), flags the account, records nothing');
update public.profiles set storage_bytes = storage_bytes - :over where id = pg_temp.i('mei');
select pg_temp.ok(get_usage(pg_temp.i('mei')) #>> '{sharing,previewsBlocked}' = 'true',
  'previews refused within the last hour: the notice stays even after usage drops back under the margin');
update public.profiles set share_previews_blocked_at = now() - interval '2 hours' where id = pg_temp.i('mei');
select pg_temp.ok(get_usage(pg_temp.i('mei')) #>> '{sharing,previewsBlocked}' = 'false',
  'an old flag with usage back under the margin: no notice');
update public.profiles set storage_bytes = storage_bytes + :over where id = pg_temp.i('mei');
select pg_temp.ok(get_usage(pg_temp.i('mei')) #>> '{sharing,previewsBlocked}' = 'true',
  'an old flag with usage still past the margin: the notice shows');
update public.profiles set storage_bytes = storage_bytes - :over, share_previews_blocked_at = null where id = pg_temp.i('mei');
update public.profiles set storage_bytes = storage_bytes - :big where id = pg_temp.i('mei');
select pg_temp.ok(pg_temp.all_ok(), 'usage invariant holds');

-- ---- Watermark and downgrades -----------------------------------------------------------------------------
select patch_gallery(pg_temp.i('mei'), pg_temp.i('g1'), '{"extras":{"watermark":true}}');
select pg_temp.ok(update_branding(pg_temp.i('wei'), '{"studioName":"W"}') ->> 'error' = 'plan'
  and update_branding(pg_temp.i('ana'), '{"watermark":{"opacity":50}}') ->> 'error' = 'plan', 'branding and watermark need their plan limits');
select pg_temp.ok(record_branding_asset(pg_temp.i('mei'), 'watermark', 'o/' || pg_temp.i('wei') || '/b/watermark-' || md5('w'), 800) ->> 'status' = 'invalid'
  and record_branding_asset(pg_temp.i('ana'), 'logo', 'o/' || pg_temp.i('ana') || '/b/logo-' || md5('l'), 800) ->> 'status' = 'plan',
  'branding assets: only under the owner''s prefix, only with the plan');
select pg_temp.ok((select v ->> 'status' = 'ok' and v #>> '{branding,watermark,hasImage}' = 'true'
  from (select record_branding_asset(pg_temp.i('mei'), 'watermark', 'o/' || pg_temp.i('mei') || '/b/watermark-' || md5('w'), 800) v) x)
  and pg_temp.all_ok(), 'a watermark image is recorded and counts');
select pg_temp.ok(get_gallery(pg_temp.i('mei'), pg_temp.i('g1')) ->> 'watermarkReady' = 'true'
  and get_branding(pg_temp.i('mei')) ->> 'watermarkReady' = 'true', 'watermarkReady once the text watermark has its image');
select pg_temp.ok((select v ->> 'error' = 'in_use' and v ->> 'galleries' = '1'
  from (select delete_branding_asset(pg_temp.i('mei'), 'watermark') v) x)
  and branding_asset_key(pg_temp.i('mei'), 'watermark') is not null
  and delete_branding_asset(pg_temp.i('mei'), 'logo') ? 'branding',
  'the watermark image can''t be deleted while a live gallery draws it (the unused logo can)');
select pg_temp.ok((select v ->> 'error' = 'in_use' and v ->> 'galleries' = '1'
  from (select update_branding(pg_temp.i('mei'), '{"watermark":{"kind":"logo"}}') v) x)
  and (select wm_kind from public.branding where owner_id = pg_temp.i('mei')) is distinct from 'logo'
  and update_branding(pg_temp.i('mei'), '{"watermark":{"kind":"text"}}') ? 'branding',
  'switching the watermark to a kind with nothing to draw is refused while a live gallery uses it (same kind is fine)');
select pg_temp.ok(branding_asset_key(pg_temp.i('mei'), 'watermark') like 'o/' || pg_temp.i('mei') || '/b/watermark-%'
  and branding_asset_key(pg_temp.i('wei'), 'watermark') is null, 'the owner reads back their own asset key');
select pg_temp.ok((select v -> 'watermark' ->> 'key' like '%/b/watermark-%' and v -> 'rendition' = 'null'::jsonb and (v ->> 'wmVersion')::int > 1
  from (select guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'grid', false) v) x), 'a watermark change makes new renditions');
select pg_temp.ok(update_branding(pg_temp.i('mei'), '{"studioName":"Mei Studio","accent":"#2D5FD3","watermark":{"position":"tiled","opacity":40}}') #>> '{branding,watermark,position}' = 'tiled'
  and update_branding(pg_temp.i('mei'), '{"accent":"#123456"}') ->> 'error' = 'invalid', 'branding settings (accents from the fixed list only)');
select pg_temp.ok(guest_gallery_info(pg_temp.h('m-tok-1'), pg_temp.h('n')) #>> '{brand,studioName}' = 'Mei Studio', 'guests see the studio''s brand');
update public.profiles set plan_id = 'free' where id = pg_temp.i('mei');
select pg_temp.ok((select v ->> 'downloads' = 'web' and v ->> 'favourites' = 'false' and v #>> '{brand,studioName}' = 'Zephyr' and v ->> 'state' = 'locked'
  from (select guest_gallery_info(pg_temp.h('m-tok-1'), pg_temp.h('n')) v) x)
  and guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'grid', false) -> 'watermark' ->> 'key' like '%/b/watermark-%'
  and guest_media(pg_temp.i('g1'), pg_temp.i('p1'), 'full', true) ->> 'unavailable' = 'not_allowed'
  and get_gallery(pg_temp.i('mei'), pg_temp.i('g1')) #>> '{extras,watermark}' = 'true',
  'after a downgrade the extras stop working (the watermark stays, phase 7) but the gallery stays live, unchanged');
update public.profiles set plan_id = 'studio' where id = pg_temp.i('mei');

-- ---- Favourites -------------------------------------------------------------------------------------------
select pg_temp.ok(guest_set_favourite(pg_temp.i('g2'), pg_temp.h('v1'), pg_temp.i('p1'), true, pg_temp.h('fnet')) = 'off', 'favourites off for this gallery → off');
select pg_temp.ok(guest_set_favourite(pg_temp.i('g1'), pg_temp.h('v1'), pg_temp.i('w1'), true, pg_temp.h('fnet')) is null, 'a photo not in the gallery → null');
select guest_set_favourite(pg_temp.i('g1'), pg_temp.h('v1'), pg_temp.i('p1'), true, pg_temp.h('fnet')) as a \gset
select guest_set_favourite(pg_temp.i('g1'), pg_temp.h('v1'), pg_temp.i('p2'), true, pg_temp.h('fnet')) as b \gset
select guest_set_favourite(pg_temp.i('g1'), pg_temp.h('v1'), pg_temp.i('p2'), false, pg_temp.h('fnet')) as c \gset
select guest_set_favourite(pg_temp.i('g1'), pg_temp.h('v2'), pg_temp.i('p2'), false, pg_temp.h('fnet')) as d \gset
select pg_temp.ok(:'a' = 'ok' and :'b' = 'ok' and :'c' = 'ok' and :'d' = 'ok'
  and (guest_photos(pg_temp.i('g1'), null, 10, pg_temp.h('v1')) #>> '{selection,count}')::int = 1
  and guest_photos(pg_temp.i('g1'), null, 10, pg_temp.h('v1')) #>> '{items,0,favourite}' = 'true'
  and (select count(*) from public.gallery_guests where gallery_id = pg_temp.i('g1')) = 1,
  'favourite and unfavourite (unfavouriting makes no guest)');
select pg_temp.ok(guest_send_favourites(pg_temp.i('g1'), pg_temp.h('v2'), 'Ann', null) ->> 'status' = 'empty', 'send with nothing favourited → empty');
select pg_temp.ok((select v ->> 'status' = 'ok' and v ->> 'notify' = 'true' and v ->> 'ownerEmail' = 'mei5@example.com'
  from (select guest_send_favourites(pg_temp.i('g1'), pg_temp.h('v1'), 'Lin', 'These please') v) x), 'send favourites: stored, owner emailed');
select guest_set_favourite(pg_temp.i('g1'), pg_temp.h('v2'), pg_temp.i('p4'), true, pg_temp.h('fnet'));
select pg_temp.ok(guest_send_favourites(pg_temp.i('g1'), pg_temp.h('v2'), 'Ann', null) ->> 'notify' = 'false', 'at most one favourites email per gallery an hour');
select pg_temp.ok((select jsonb_array_length(v) = 2 and v #>> '{1,name}' is not null
  from (select gallery_favourites(pg_temp.i('mei'), pg_temp.i('g1')) v) x)
  and gallery_favourites(pg_temp.i('wei'), pg_temp.i('g1')) is null, 'the owner sees each guest''s selection');
-- Guests without favourites don't count toward the cap.
insert into public.gallery_guests (gallery_id, cookie_hash) select pg_temp.i('g1'), pg_temp.h('idle' || n) from generate_series(1, 600) n;
select pg_temp.ok(guest_set_favourite(pg_temp.i('g1'), pg_temp.h('v4'), pg_temp.i('p1'), true, pg_temp.h('fnet')) = 'ok',
  'guests with no favourites don''t count toward the 500');
delete from public.gallery_guests where cookie_hash in (select pg_temp.h('idle' || n) from generate_series(1, 600) n)
   or cookie_hash = pg_temp.h('v4');
with g as (insert into public.gallery_guests (gallery_id, cookie_hash)
           select pg_temp.i('g1'), pg_temp.h('many' || n) from generate_series(1, 498) n returning id)
insert into public.gallery_favourites (guest_id, gallery_id, photo_id) select g.id, pg_temp.i('g1'), pg_temp.i('p1') from g;
insert into public.gallery_guests (gallery_id, cookie_hash) values (pg_temp.i('g1'), pg_temp.h('empty'));
select pg_temp.ok(guest_set_favourite(pg_temp.i('g1'), pg_temp.h('v3'), pg_temp.i('p1'), true, pg_temp.h('fnet')) = 'limit'
  and guest_set_favourite(pg_temp.i('g1'), pg_temp.h('empty'), pg_temp.i('p1'), true, pg_temp.h('fnet')) = 'limit'
  and guest_set_favourite(pg_temp.i('g1'), pg_temp.h('v1'), pg_temp.i('p4'), true, pg_temp.h('fnet')) = 'ok',
  'at most 500 guests with favourites per gallery (existing ones still work)');
delete from public.gallery_guests where cookie_hash in (select pg_temp.h('many' || n) from generate_series(1, 498) n)
   or cookie_hash = pg_temp.h('empty');
select guest_set_favourite(pg_temp.i('g1'), pg_temp.h('n' || n), pg_temp.i('p1'), true, pg_temp.h('busy')) from generate_series(1, 20) n;
select pg_temp.ok(guest_set_favourite(pg_temp.i('g1'), pg_temp.h('n21'), pg_temp.i('p1'), true, pg_temp.h('busy')) = 'limit'
  and guest_set_favourite(pg_temp.i('g1'), pg_temp.h('n1'), pg_temp.i('p2'), true, pg_temp.h('busy')) = 'ok'
  and guest_set_favourite(pg_temp.i('g1'), pg_temp.h('n21'), pg_temp.i('p1'), true, pg_temp.h('calm')) = 'ok',
  'one network makes at most 20 new guests per gallery a day');
delete from public.gallery_guests where network_hash in (pg_temp.h('busy'), pg_temp.h('calm'));
select update_gallery_photos(pg_temp.i('mei'), pg_temp.i('g1'), null, array[pg_temp.i('p4')]) ->> 'count' as st \gset
select pg_temp.ok(:'st' = '3'
  and not exists (select 1 from public.gallery_favourites where photo_id = pg_temp.i('p4'))
  and not exists (select 1 from public.gallery_renditions where photo_id = pg_temp.i('p4') and gallery_id = pg_temp.i('g1'))
  and exists (select 1 from public.share_object_deletions where key = pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g1'), pg_temp.i('p4'), 'grid', 'a'))
  and pg_temp.all_ok(), 'removing a photo removes its favourites and renditions (objects queued)');

select pg_temp.ok(gallery_preview_info(pg_temp.i('mei'), pg_temp.i('g1')) ->> 'name' = 'Wedding'
  and gallery_preview_info(pg_temp.i('wei'), pg_temp.i('g1')) is null, 'the owner''s preview, for the owner only');
select pg_temp.ok(guest_logo(pg_temp.i('g1')) is null and guest_logo(pg_temp.i('g2')) is null, 'no logo recorded → none shown');

-- ---- Reports ----------------------------------------------------------------------------------------------
select pg_temp.ok((select v ->> 'status' = 'ok' and v ->> 'ownerId' = pg_temp.i('mei')::text and v -> 'photoId' = 'null'::jsonb
                     and v ->> 'alert' = 'true' and v ->> 'pendingCount' = '1'
  from (select guest_report(pg_temp.i('g1'), pg_temp.i('w1'), 'csam', 'Details', pg_temp.h('rep')) v) x),
  'a guest report is stored; a photo outside the gallery comes back null; the first CSAM report alerts');
-- The Worker confirms once the alert email is sent.
select pg_temp.ok((select confirm_safety_alert(id) from public.gallery_reports where network_hash = pg_temp.h('rep') and reason = 'csam') = 1,
  'confirming an alert marks the reports it covered');
select (select v ->> 'alert' = 'false' and v ->> 'photoId' = pg_temp.i('p1')::text
  from (select guest_report(pg_temp.i('g1'), pg_temp.i('p1'), 'csam', null, pg_temp.h('rep3')) v) x) as st \gset
select pg_temp.ok(:'st'::boolean
  and (select count(*) from public.gallery_reports where gallery_id = pg_temp.i('g1') and reason = 'csam') = 2,
  'CSAM alerts at most once an hour per gallery (every report still recorded; the validated photo id returned)');
-- (now() is the transaction's start: move the earlier reports and the alert back in time.)
update public.gallery_reports set created_at = now() - interval '3 hours' where gallery_id = pg_temp.i('g1');
update public.galleries set csam_alerted_at = now() - interval '2 hours' where id = pg_temp.i('g1');
select guest_report(pg_temp.i('g1'), null, 'csam', null, pg_temp.h('rep4')) -> 'alert' as st \gset
select pg_temp.ok(:'st'::boolean, 'an hour after the last alert, the next CSAM report alerts again');
update public.galleries set csam_alerted_at = now() - interval '2 hours' where id = pg_temp.i('g1');
select pg_temp.ok((select v ->> 'alert' = 'true' and v ->> 'pendingCount' = '3'
  from (select guest_report(pg_temp.i('g1'), null, 'csam', null, pg_temp.h('rep3')) v) x),
  'the alert counts every CSAM report no sent alert has covered (the last one''s email wasn''t confirmed)');
-- Cron sweep: reports no alert covered.
select pg_temp.ok(due_safety_alerts(10) = '[]'::jsonb, 'sweep: nothing while the gallery''s alert hour is taken');
update public.galleries set csam_alerted_at = now() - interval '2 hours' where id = pg_temp.i('g1');
select due_safety_alerts(10) as v \gset
select pg_temp.ok((select jsonb_array_length(v) = 1 and v #>> '{0,galleryId}' = pg_temp.i('g1')::text
                     and v #>> '{0,ownerId}' = pg_temp.i('mei')::text and v #>> '{0,count}' = '1'
                     and v #>> '{0,photoId}' = pg_temp.i('p1')::text
  from (select :'v'::jsonb v) x)
  and (select csam_alerted_at = now() from public.galleries where id = pg_temp.i('g1'))
  and due_safety_alerts(10) = '[]'::jsonb,
  'sweep: one row per gallery for unalerted reports over 5 minutes old; it claims the gallery''s hour');
select confirm_safety_alert((:'v'::jsonb #>> '{0,reportId}')::uuid) as st \gset
select pg_temp.ok(:'st' = '1'
  and (select count(*) from public.gallery_reports where gallery_id = pg_temp.i('g1') and reason = 'csam' and alerted_at is null) = 2,
  'confirming the sweep''s alert marks what it covered; fresher reports wait for the next hour');
insert into public.gallery_reports (gallery_id, owner_id, reason, network_hash, created_at, reviewed_at) values
  (null, pg_temp.i('mei'), 'csam', pg_temp.h('orph'), now() - interval '1 hour', null),
  (null, pg_temp.i('mei'), 'csam', pg_temp.h('orph'), now() - interval '1 hour', now());
select due_safety_alerts(10) as v \gset
select confirm_safety_alert((:'v'::jsonb #>> '{0,reportId}')::uuid) as st \gset
select pg_temp.ok((select jsonb_array_length(v) = 1 and v -> 0 -> 'galleryId' = 'null'::jsonb and v #>> '{0,count}' = '1'
  from (select :'v'::jsonb v) x)
  and :'st'::int >= 1 and due_safety_alerts(10) = '[]'::jsonb,
  'sweep: reports on a deleted gallery still alert (reviewed ones don''t), once');
select pg_temp.ok((select photo_id is null and reason = 'csam' from public.gallery_reports where network_hash = pg_temp.h('rep') and reason = 'csam')
  and exists (select 1 from public.audit_log where action = 'safety.report'), 'a photo outside the gallery isn''t attached; the report is audited');
select guest_report(pg_temp.i('g1'), null, 'other', null, pg_temp.h('rep')) from generate_series(1, 9);
select pg_temp.ok(guest_report(pg_temp.i('g1'), null, 'other', null, pg_temp.h('rep')) ->> 'status' = 'limited'
  and guest_report(pg_temp.i('g1'), null, 'spam', null, pg_temp.h('rep2')) is null
  and guest_report(gen_random_uuid(), null, 'other', null, pg_temp.h('rep2')) is null, 'reports: 10 a day per network; unknown reasons and galleries → null');

-- ---- Access log -------------------------------------------------------------------------------------------
select gallery_event(pg_temp.i('g1'), 'opened', 'Singapore', 'Safari on iPhone', 1);
select gallery_event(pg_temp.i('g1'), 'downloaded', null, null, 3);
select gallery_event(pg_temp.i('g2'), 'opened', 'Singapore', 'Safari on iPhone', 1);
select gallery_event(pg_temp.i('g1'), 'created', null, null, 1);
select pg_temp.ok((select v #>> '{stats,views}' = '1' and v #>> '{stats,downloads}' = '3' and v #>> '{events,0,kind}' = 'downloaded'
  from (select gallery_activity(pg_temp.i('mei'), pg_temp.i('g1'), null, 50) v) x)
  and not exists (select 1 from public.gallery_events where gallery_id = pg_temp.i('g2') and kind = 'opened')
  and (select views from public.galleries where id = pg_temp.i('g2')) = 1
  and (select count(*) from public.gallery_events where gallery_id = pg_temp.i('g1') and kind = 'created') = 1,
  'events only with the access log on (counters always); guests can''t log member events');
select pg_temp.ok(gallery_activity(pg_temp.i('wei'), pg_temp.i('g1'), null, 50) is null, 'activity is the owner''s');

-- ---- Revoke and expiry ------------------------------------------------------------------------------------
select record_rendition(pg_temp.i('g2'), pg_temp.i('p1'), 'view', pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g2'), pg_temp.i('p1'), 'view', 'a'), 900, 1, 0);
select pg_temp.ok(revoke_gallery(pg_temp.i('wei'), pg_temp.i('g2')) is null, 'revoke: someone else''s gallery → null');
select revoke_gallery(pg_temp.i('mei'), pg_temp.i('g2')) as st \gset
select pg_temp.ok(:'st'::boolean
  and not exists (select 1 from public.gallery_renditions where gallery_id = pg_temp.i('g2'))
  and exists (select 1 from public.share_object_deletions where key = pg_temp.rk(pg_temp.i('mei'), pg_temp.i('g2'), pg_temp.i('p1'), 'view', 'a'))
  and guest_gallery_info(pg_temp.h('m-tok-2'), pg_temp.h('n')) ->> 'state' = 'ended'
  and guest_gallery_info(pg_temp.h('m-tok-2'), pg_temp.h('n')) ->> 'name' = ''
  and guest_gallery_info(pg_temp.h('m-tok-2'), pg_temp.h('n')) #>> '{brand,studioName}' = ''
  and guest_gallery_info(pg_temp.h('m-tok-2'), pg_temp.h('n')) ->> 'message' is null
  and guest_gallery_state(pg_temp.h('m-tok-2')) ->> 'serving' = 'false'
  and guest_photos(pg_temp.i('g2'), null, 10, null) is null and guest_media(pg_temp.i('g2'), pg_temp.i('p1'), 'grid', false) is null
  and pg_temp.all_ok(), 'revoke: renditions go at once, guests see ended, nothing is served');
select pg_temp.ok(patch_gallery(pg_temp.i('mei'), pg_temp.i('g2'), '{"expiresOn":"2099-01-01"}') ->> 'error' = 'ended'
  and set_gallery_passcode(pg_temp.i('mei'), pg_temp.i('g2'), 2, null) = 'ended'
  and gallery_link(pg_temp.i('mei'), pg_temp.i('g2')) is null, 'a revoked gallery can''t change, and its link is gone');
update public.galleries set expires_at = now() - interval '1 minute' where id = pg_temp.i('gw1');
select pg_temp.ok(get_gallery(pg_temp.i('wei'), pg_temp.i('gw1')) ->> 'status' = 'expired'
  and guest_gallery_info(pg_temp.h('w-tok-1'), pg_temp.h('n')) ->> 'state' = 'ended', 'expired: ended for guests');
select pg_temp.ok(pg_temp.mk(pg_temp.i('wei'), pg_temp.i('gw4'), 'w-tok-4', false, array[pg_temp.i('w1')], 3, 'none') #>> '{gallery,status}' = 'live',
  'an expired gallery no longer counts toward the live limit');
select pg_temp.ok(patch_gallery(pg_temp.i('wei'), pg_temp.i('gw1'), jsonb_build_object('expiresOn', (now() at time zone 'utc')::date + 2)) ->> 'error' = 'limit',
  'reopening an expired gallery counts toward the limit');

-- ---- Safety hold ------------------------------------------------------------------------------------------
select pg_temp.mk(pg_temp.i('ana'), pg_temp.i('ga1'), 'a-tok-1', false, array[pg_temp.i('a1')], 30, 'web');
select record_rendition(pg_temp.i('ga1'), pg_temp.i('a1'), 'grid', pg_temp.rk(pg_temp.i('ana'), pg_temp.i('ga1'), pg_temp.i('a1'), 'grid', 'a'), 300, 0, 0);
select pg_temp.ok((select v ->> 'ownerId' = pg_temp.i('ana')::text and v ->> 'alreadyHeld' = 'false'
  from (select apply_safety_hold(pg_temp.i('ga1'), pg_temp.i('a1')) v) x)
  and apply_safety_hold(pg_temp.i('ga1'), pg_temp.i('a1')) ->> 'alreadyHeld' = 'true', 'a safety hold is applied once');
select pg_temp.ok((select safety_hold_at is not null from public.photos where id = pg_temp.i('a1'))
  and (select sharing_suspended_at is not null from public.profiles where id = pg_temp.i('ana'))
  and not exists (select 1 from public.gallery_photos where photo_id = pg_temp.i('a1'))
  and not exists (select 1 from public.gallery_renditions where photo_id = pg_temp.i('a1'))
  and (select count(*) from public.audit_log where action = 'safety.csam_match' and target = pg_temp.i('a1')::text) = 1
  and photo_file(pg_temp.i('ana'), pg_temp.i('a1')) is null
  and guest_gallery_info(pg_temp.h('a-tok-1'), pg_temp.h('n')) ->> 'state' = 'ended'
  and pg_temp.all_ok(), 'held: out of every gallery, never served (even to the owner), sharing suspended, audited');
update public.photos set status = 'trashed', trashed_at = now(), purge_after = now() where id = pg_temp.i('a1');
delete from public.photos where id = pg_temp.i('a1');
select pg_temp.ok((select status from public.photos where id = pg_temp.i('a1')) = 'ready', 'a held photo can''t be trashed or deleted');
do $$ begin
  begin
    update public.photos set safety_hold_at = null where id = (select id from ids where k = 'a1');
    raise exception 'FAILED: a hold was lifted';
  exception when check_violation then raise notice 'ok - a hold isn''t lifted by an update';
  end;
end $$;
select pg_temp.ok(pg_temp.mk(pg_temp.i('ana'), gen_random_uuid(), 'a-tok-2', false, array[pg_temp.i('a1')], 3, 'web') ->> 'error' = 'suspended'
  and get_usage(pg_temp.i('ana')) #>> '{sharing,suspended}' = 'true', 'a suspended account can''t share');
update public.profiles set deletion_requested_at = now() - interval '31 days', deletion_due = now() - interval '1 day' where id = pg_temp.i('ana');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(due_account_purges(100)) x where x ->> 'ownerId' = pg_temp.i('ana')::text),
  'an account holding a held photo is never purged');

-- ---- Usage ------------------------------------------------------------------------------------------------
select pg_temp.ok((select v #>> '{sharing,galleries}' = '3' and v #>> '{sharing,liveGalleries}' = '3' and v #>> '{sharing,maxLinkDays}' = '7'
                     and v #>> '{sharing,guestFullRes}' = 'false'
  from (select get_usage(pg_temp.i('wei')) v) x)
  and get_usage(pg_temp.i('mei')) #>> '{sharing,accessLog}' = 'true', 'usage carries the plan''s sharing limits');

-- ---- Edited photo sizes -----------------------------------------------------------------------------------
insert into ids select 'pz', pg_temp.photo(pg_temp.i('mei'), 'z.jpg');
insert into ids values ('gz', '5a000000-0000-0000-0000-00000000000f');
select pg_temp.mk(pg_temp.i('mei'), pg_temp.i('gz'), 'z-tok-1', false, array[pg_temp.i('pz')], 3, 'web');
create function pg_temp.dims() returns text language sql as $$
  select (x ->> 'width') || 'x' || (x ->> 'height') from jsonb_array_elements(guest_photos(pg_temp.i('gz'), null, 10, null) -> 'items') x
$$;
create function pg_temp.mdims() returns text language sql as $$
  select (v ->> 'width') || 'x' || (v ->> 'height') from (select guest_media(pg_temp.i('gz'), pg_temp.i('pz'), 'view', false) v) x
$$;
select pg_temp.ok(pg_temp.dims() = '4000x3000', 'unedited: the original''s size');
select save_edit(pg_temp.i('mei'), pg_temp.i('pz'), '{"v":1,"crop":{"quarterTurns":1,"rect":{"x":0,"y":0,"w":1,"h":0.5}}}', null);
select pg_temp.ok(pg_temp.dims() = '3000x2000', 'edited, no preview yet: the recipe''s output size (turned and cropped), never 4000x3000');
select pg_temp.ok(record_edit_variant(pg_temp.i('mei'), pg_temp.i('pz'), 1, 'preview',
    'u/' || pg_temp.i('mei') || '/p/' || pg_temp.i('pz') || '/edit-1-preview-' || md5('z1'), 700, 2048, null) ->> 'status' = 'invalid'
  and record_edit_variant(pg_temp.i('mei'), pg_temp.i('pz'), 1, 'preview',
    'u/' || pg_temp.i('mei') || '/p/' || pg_temp.i('pz') || '/edit-1-preview-' || md5('z1'), 700, 9000, 6000) ->> 'status' = 'invalid',
  'record_edit_variant: width and height together, within bounds');
select record_edit_variant(pg_temp.i('mei'), pg_temp.i('pz'), 1, 'preview',
  'u/' || pg_temp.i('mei') || '/p/' || pg_temp.i('pz') || '/edit-1-preview-' || md5('z1'), 700, 2048, 1366);
select pg_temp.ok(pg_temp.dims() = '3000x2001' and pg_temp.mdims() = '3000x2001',
  'edited: the stored preview''s aspect at the output''s long edge, in the photo list and the media plan alike');
select save_edit(pg_temp.i('mei'), pg_temp.i('pz'), '{"v":1,"crop":{"rect":{"x":0,"y":0,"w":0.5,"h":1}}}', 1);
select pg_temp.ok(pg_temp.dims() = '2000x3000', 'a preview of an older version doesn''t set the size');

-- ---- Clean-up ---------------------------------------------------------------------------------------------
update public.galleries set expires_at = now() - interval '2 days' where id = pg_temp.i('g1');
insert into public.gallery_attempts (gallery_id, network_hash, created_at) values (pg_temp.i('g1'), pg_temp.h('old'), now() - interval '3 days');
insert into public.gallery_events (gallery_id, kind, created_at) values (pg_temp.i('g1'), 'opened', now() - interval '91 days');
update public.galleries set created_at = now() - interval '5 days', expires_at = now() + interval '2 days' where id = pg_temp.i('gw3');
select due_share_cleanup(50) as v \gset
select pg_temp.ok((select (v ->> 'purged')::int >= 1 and jsonb_array_length(v -> 'reminders') = 1
                     and v #>> '{reminders,0,galleryId}' = pg_temp.i('gw3')::text and v #>> '{reminders,0,ownerEmail}' = 'wei5@example.com'
  from (select :'v'::jsonb v) x)
  and not exists (select 1 from public.gallery_renditions where gallery_id = pg_temp.i('g1'))
  and not exists (select 1 from public.gallery_renders where gallery_id = pg_temp.i('g1'))
  and not exists (select 1 from public.gallery_attempts where network_hash = pg_temp.h('old'))
  and not exists (select 1 from public.gallery_events where created_at < now() - interval '90 days')
  and pg_temp.all_ok(), 'clean-up: renditions of galleries ended a day ago, old attempts and events, expiry reminders');
select pg_temp.ok(jsonb_array_length(due_share_cleanup(50) -> 'reminders') = 0, 'each reminder goes once');
update public.galleries set expires_at = now() - interval '31 days' where id = pg_temp.i('g1');
select due_share_cleanup(50) ->> 'deleted' as st \gset
select pg_temp.ok(:'st'::int >= 1 and get_gallery(pg_temp.i('mei'), pg_temp.i('g1')) is null
  and not exists (select 1 from public.gallery_guests where gallery_id = pg_temp.i('g1'))
  and exists (select 1 from public.share_object_deletions where is_prefix and key = 'o/' || pg_temp.i('mei') || '/g/' || pg_temp.i('g1') || '/')
  and exists (select 1 from public.share_object_deletions where is_prefix and bucket = 'photos' and key = 'u/' || pg_temp.i('mei') || '/g/' || pg_temp.i('g1') || '/'),
  'clean-up: gallery data (guests included) goes 30 days after the end, with its prefixes');
select pg_temp.ok((select bool_and(x ? 'id' and x ? 'bucket' and x ? 'key' and x ? 'prefix') and count(*) > 0
  from jsonb_array_elements(due_share_deletions(1000)) x), 'the deletion queue lists objects and prefixes');
select confirm_share_deletions((select array_agg((x ->> 'id')::bigint) from jsonb_array_elements(due_share_deletions(1000)) x)) as st \gset
select pg_temp.ok(:'st'::int > 0
  and due_share_deletions(10) = '[]'::jsonb, 'confirmed deletions leave the queue');

-- ---- Account deletion -------------------------------------------------------------------------------------
update public.profiles set deletion_requested_at = now() - interval '31 days', deletion_due = now() - interval '1 day' where id = pg_temp.i('wei');
select pg_temp.ok((select x ->> 'sharedPrefix' from jsonb_array_elements(due_account_purges(100)) x
                    where x ->> 'ownerId' = pg_temp.i('wei')::text) = 'o/' || pg_temp.i('wei') || '/',
  'account purges also empty the shared bucket''s o/<owner>/ prefix');
select pg_temp.ok(guest_gallery_info(pg_temp.h('w-tok-2'), pg_temp.h('n')) ->> 'state' = 'ended', 'an account due for deletion shares nothing');
select record_branding_asset(pg_temp.i('mei'), 'logo', 'o/' || pg_temp.i('mei') || '/b/logo-' || md5('l'), 600);
delete from auth.users where id = pg_temp.i('mei');
select pg_temp.ok(not exists (select 1 from public.galleries where owner_id = pg_temp.i('mei'))
  and not exists (select 1 from public.branding where owner_id = pg_temp.i('mei'))
  and exists (select 1 from public.share_object_deletions where key = 'o/' || pg_temp.i('mei') || '/b/logo-' || md5('l')),
  'deleting the account deletes its galleries and branding (objects queued)');

-- ---- Privileges -------------------------------------------------------------------------------------------
select pg_temp.ok(not exists (
  select 1 from unnest(array['galleries', 'gallery_photos', 'gallery_renditions', 'gallery_renders', 'gallery_guests',
                             'gallery_favourites', 'gallery_attempts', 'gallery_events', 'branding', 'share_object_deletions',
                             'gallery_reports']) t(n)
    cross join unnest(array['anon', 'authenticated']) r(role)
    cross join unnest(array['select', 'insert', 'update', 'delete']) pr(priv)
   where has_table_privilege(r.role, 'public.' || t.n, pr.priv)), 'browser roles hold no privileges on sharing tables');
select pg_temp.ok((select bool_and(relrowsecurity) from pg_class where relnamespace = 'public'::regnamespace
  and relname in ('galleries', 'gallery_photos', 'gallery_renditions', 'gallery_renders', 'gallery_guests',
                  'gallery_favourites', 'gallery_attempts', 'gallery_events', 'branding', 'share_object_deletions')), 'RLS is on');
select pg_temp.ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '\_%' and has_function_privilege('service_role', p.oid, 'execute')),
  'service_role calls entry points, not helpers');
select pg_temp.ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']
                                   and not has_function_privilege('anon', p.oid, 'execute')
                                   and not has_function_privilege('authenticated', p.oid, 'execute')
                                   and has_function_privilege('service_role', p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('create_gallery', 'list_galleries', 'get_gallery', 'patch_gallery', 'revoke_gallery',
    'gallery_passcode_state', 'set_gallery_passcode', 'list_gallery_photos', 'update_gallery_photos', 'gallery_favourites',
    'gallery_activity', 'gallery_render_queue', 'gallery_render_check', 'record_gallery_render', 'get_branding', 'update_branding',
    'record_branding_asset', 'delete_branding_asset', 'guest_gallery_state', 'guest_gallery_info', 'gallery_unlock_reserve',
    'gallery_unlock_succeeded', 'guest_photos', 'guest_media', 'record_rendition', 'gallery_event', 'guest_set_favourite',
    'guest_send_favourites', 'apply_safety_hold', 'gallery_link', 'branding_asset_key', 'gallery_preview_info', 'guest_logo', 'guest_report', 'confirm_safety_alert', 'due_safety_alerts', 'due_share_cleanup', 'due_share_deletions', 'confirm_share_deletions')),
  'entry points: security definer, empty search_path, service_role only');

rollback;
\echo 'All sharing tests passed.'
