-- Assertions for the editor migration (phase 4): saved edits and versions, edited variants and usage,
-- revert, bulk paste, purges, the orphan sweep's view, saved recipes, cross-owner isolation and privileges.
-- Run with supabase/tests/run-local.sh.
\set ON_ERROR_STOP on
begin;

create function pg_temp.ok(cond boolean, what text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok - %', what;
end $$;
grant execute on function pg_temp.ok(boolean, text) to public;
-- The usage invariant, with edited variants.
create function pg_temp.no_drift(o uuid) returns boolean language sql as $$
  select pr.storage_bytes =
           (select coalesce(sum(p.size_bytes + p.thumb_bytes + p.preview_bytes), 0) from public.photos p
             where p.owner_id = o and p.status in ('ready', 'trashed', 'purging'))
         + (select coalesce(sum(e.thumb_bytes + e.preview_bytes), 0) from public.photo_edits e
              join public.photos p on p.id = e.photo_id
             where p.owner_id = o and p.status in ('ready', 'trashed', 'purging'))
  from public.profiles pr where pr.id = o
$$;
create function pg_temp.all_ok() returns boolean language sql as $$
  select bool_and(pg_temp.no_drift(id)) from public.profiles
$$;
-- The edited-variant key a PUT for (owner, photo, version, kind) would write: a fixed nonce per version and
-- kind (md5 is 32 lower-case hex) so tests can name it.
create function pg_temp.k(o uuid, p uuid, v integer, kind text) returns text language sql as $$
  select 'u/' || o || '/p/' || p || '/edit-' || v || '-' || kind || '-' || md5(v::text || kind)
$$;
create function pg_temp.rec(o uuid, p uuid, v integer, kind text, bytes integer) returns jsonb language sql as $$
  select public.record_edit_variant(o, p, v, kind, pg_temp.k(o, p, v, kind), bytes)
$$;
-- A ready photo (as a finished upload leaves it), with usage kept in step.
create function pg_temp.photo(o uuid, n text) returns uuid language plpgsql as $$
declare id uuid;
begin
  insert into public.photos (owner_id, status, file_type, filename, size_bytes, sha256, has_thumb, has_preview, thumb_bytes, preview_bytes)
  values (o, 'ready', 'jpeg', n, 1000, extensions.digest(n || o::text, 'sha256'), true, true, 100, 200) returning photos.id into id;
  update public.profiles set storage_bytes = storage_bytes + 1300 where profiles.id = o;
  return id;
end $$;

insert into auth.users (id, email, email_confirmed_at) values
  ('40000000-0000-0000-0000-000000000001', 'mei4@example.com', now()),
  ('40000000-0000-0000-0000-000000000002', 'wei4@example.com', now());
update public.profiles set plan_id = 'pro' where id = '40000000-0000-0000-0000-000000000002';
create temp table ids (k text primary key, id uuid);
grant all on ids to public;
insert into ids values
  ('mei', '40000000-0000-0000-0000-000000000001'),
  ('wei', '40000000-0000-0000-0000-000000000002');
insert into ids select 'p1', pg_temp.photo((select id from ids where k = 'mei'), 'a.jpg');
insert into ids select 'p2', pg_temp.photo((select id from ids where k = 'mei'), 'b.jpg');
insert into ids select 'p3', pg_temp.photo((select id from ids where k = 'mei'), 'c.jpg');
insert into ids select 'w1', pg_temp.photo((select id from ids where k = 'wei'), 'w.jpg');
create function pg_temp.i(k text) returns uuid language sql as $$ select id from ids where ids.k = $1 $$;

-- ---- Saving and versions ----------------------------------------------------------------------------
select pg_temp.ok(get_edit(pg_temp.i('mei'), pg_temp.i('p1')) = '{"edit": null}'::jsonb, 'get_edit: unedited photo → edit null');
select pg_temp.ok(get_edit(pg_temp.i('wei'), pg_temp.i('p1')) is null, 'get_edit: other owner → null');
select pg_temp.ok(save_edit(pg_temp.i('mei'), pg_temp.i('p1'), '{"v":1,"light":{"exposure":0.5}}', null) #>> '{edit,version}' = '1',
  'first save → version 1');
select pg_temp.ok((select v ->> 'status' = 'conflict' and v #>> '{edit,version}' = '1'
  from (select save_edit(pg_temp.i('mei'), pg_temp.i('p1'), '{"v":1}', null) v) x), 'a stale base (null) → conflict with the current edit');
select pg_temp.ok(save_edit(pg_temp.i('mei'), pg_temp.i('p1'), '{"v":1,"light":{"exposure":0.7}}', 1) #>> '{edit,version}' = '2',
  'saving on the current version → version 2');
select pg_temp.ok(save_edit(pg_temp.i('mei'), pg_temp.i('p1'), '{"v":1}', 1) ->> 'status' = 'conflict', 'an older base → conflict');
select pg_temp.ok(save_edit(pg_temp.i('wei'), pg_temp.i('p1'), '{"v":1}', 2) is null, 'save_edit: other owner → null');
select pg_temp.ok(save_edit(pg_temp.i('mei'), pg_temp.i('p1'), '{"v":2}', 2) ->> 'status' = 'invalid', 'a recipe that isn''t v1 → invalid');
select pg_temp.ok(save_edit(pg_temp.i('mei'), pg_temp.i('p1'), jsonb_build_object('v', 1, 'x', repeat('a', 5000)), 2) ->> 'status' = 'invalid',
  'a recipe over 4 KB → invalid');
do $$ begin
  begin
    insert into public.photo_edits (photo_id, owner_id, recipe, version)
    values ((select id from ids where k = 'w1'), (select id from ids where k = 'mei'), '{"v":1}', 1);
    raise exception 'FAILED: an edit row for someone else''s photo';
  exception when check_violation then raise notice 'ok - an edit row must belong to its photo''s owner';
  end;
end $$;

-- ---- Edited variants and usage ------------------------------------------------------------------------
select pg_temp.ok(pg_temp.rec(pg_temp.i('mei'), pg_temp.i('p1'), 1, 'thumb', 5000) ->> 'status' = 'gone',
  'record_edit_variant: an old version → gone');
select pg_temp.ok(pg_temp.rec(pg_temp.i('wei'), pg_temp.i('p1'), 2, 'thumb', 5000) ->> 'status' = 'gone',
  'record_edit_variant: other owner → gone');
select pg_temp.ok(pg_temp.rec(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'thumb', 400000) ->> 'status' = 'invalid'
  and pg_temp.rec(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'original', 10) ->> 'status' = 'invalid',
  'record_edit_variant: over the cap or an unknown kind → invalid');
select pg_temp.ok((select v ->> 'status' = 'ok' and v -> 'previousKey' = 'null'::jsonb
  from (select pg_temp.rec(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'thumb', 5000) v) x), 'records the current version''s thumb');
select pg_temp.ok((get_edit(pg_temp.i('mei'), pg_temp.i('p1')) #>> '{edit,rendered}')::boolean = false, 'not rendered until both kinds exist');
select pg_temp.rec(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'preview', 60000);
select pg_temp.ok((get_edit(pg_temp.i('mei'), pg_temp.i('p1')) #>> '{edit,rendered}')::boolean, 'rendered once both kinds exist');
select pg_temp.ok((select storage_bytes = 3 * 1300 + 65000 from public.profiles where id = pg_temp.i('mei')) and pg_temp.all_ok(),
  'edited variants count toward storage (no drift)');
select pg_temp.ok(record_edit_variant(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'thumb',
    'u/' || pg_temp.i('mei') || '/p/' || pg_temp.i('p1') || '/edit-2-thumb-' || md5('another request'), 4000) ->> 'status' = 'exists'
  and (select thumb_key = pg_temp.k(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'thumb') and thumb_bytes = 5000
         from public.photo_edits where photo_id = pg_temp.i('p1'))
  and pg_temp.all_ok(), 'a second object for an already recorded version is not recorded (exists): the first stays, bytes unchanged');
select pg_temp.ok(record_edit_variant(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'thumb', 'u/' || pg_temp.i('mei') || '/p/' || pg_temp.i('p1') || '/edit-2-thumb', 10) ->> 'status' = 'invalid'
  and record_edit_variant(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'thumb', pg_temp.k(pg_temp.i('mei'), pg_temp.i('p1'), 3, 'thumb'), 10) ->> 'status' = 'invalid'
  and record_edit_variant(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'thumb', upper(pg_temp.k(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'thumb')), 10) ->> 'status' = 'invalid'
  and record_edit_variant(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'thumb', pg_temp.k(pg_temp.i('wei'), pg_temp.i('p1'), 2, 'thumb'), 10) ->> 'status' = 'invalid'
  and record_edit_variant(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'thumb', pg_temp.k(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'preview'), 10) ->> 'status' = 'invalid'
  and record_edit_variant(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'thumb', pg_temp.k(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'thumb') || 'x', 10) ->> 'status' = 'invalid',
  'record_edit_variant only accepts this owner''s, photo''s, version''s and kind''s canonical key with a 32-hex nonce');
select pg_temp.ok(edit_variant_check(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'thumb') ->> 'status' = 'exists'
  and edit_variant_check(pg_temp.i('mei'), pg_temp.i('p1'), 1, 'thumb') ->> 'status' = 'stale'
  and edit_variant_check(pg_temp.i('wei'), pg_temp.i('p1'), 2, 'thumb') is null
  and edit_variant_check(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'original') is null,
  'edit_variant_check: exists / stale; another owner or a bad kind → null');
select save_edit(pg_temp.i('mei'), pg_temp.i('p1'), '{"v":1,"light":{"exposure":1}}', 2);
select pg_temp.ok((get_edit(pg_temp.i('mei'), pg_temp.i('p1')) #>> '{edit,rendered}')::boolean = false, 'a new save is not rendered yet');
select pg_temp.ok(edit_variant_check(pg_temp.i('mei'), pg_temp.i('p1'), 3, 'thumb') ->> 'status' = 'current',
  'edit_variant_check: the current version, not yet stored → current');
select pg_temp.ok(pg_temp.rec(pg_temp.i('mei'), pg_temp.i('p1'), 3, 'thumb', 3000) ->> 'previousKey'
  = pg_temp.k(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'thumb'), 'a new version''s variant names the replaced key');
select pg_temp.ok(pg_temp.all_ok(), 'no drift after replacing a variant');

-- ---- Library views ------------------------------------------------------------------------------------
select pg_temp.ok((select (v -> 'edit') = '{"version": 3, "rendered": false}'::jsonb
  from jsonb_array_elements(list_photos(pg_temp.i('mei')) -> 'items') v where v ->> 'id' = pg_temp.i('p1')::text),
  'PhotoItem.edit carries the version and whether it is rendered');
select save_edit(pg_temp.i('mei'), pg_temp.i('p2'), '{"v":1}', null);
select pg_temp.ok((select (v -> 'edit') = 'null'::jsonb
  from jsonb_array_elements(list_photos(pg_temp.i('mei')) -> 'items') v where v ->> 'id' = pg_temp.i('p2')::text),
  'a neutral edit shows as unedited');
select pg_temp.ok((select jsonb_agg(v ->> 'id') = jsonb_build_array(pg_temp.i('p1')::text)
  from jsonb_array_elements(list_photos(pg_temp.i('mei'), 'edited') -> 'items') v), 'the edited view lists only non-neutral edits');
select pg_temp.ok(get_photo(pg_temp.i('mei'), pg_temp.i('p1')) -> 'recipe' = '{"v":1,"light":{"exposure":1}}'::jsonb
  and get_photo(pg_temp.i('mei'), pg_temp.i('p3')) -> 'recipe' = 'null'::jsonb, 'photo detail carries the recipe');
select pg_temp.ok((select v ->> 'editThumbKey' = pg_temp.k(pg_temp.i('mei'), pg_temp.i('p1'), 3, 'thumb')
    and v -> 'editPreviewKey' = 'null'::jsonb and (v ->> 'editVersion')::int = 3
  from (select photo_file(pg_temp.i('mei'), pg_temp.i('p1')) v) x), 'photo_file names only the recorded objects rendered from the current edit');
select pg_temp.ok(_photo_keys(pg_temp.i('mei'), pg_temp.i('p1')) @> jsonb_build_array(
  pg_temp.k(pg_temp.i('mei'), pg_temp.i('p1'), 3, 'thumb'),
  pg_temp.k(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'preview')), 'a photo''s keys include its recorded edited variants');
select pg_temp.ok((select v ->> 'editThumbKey' = pg_temp.k(pg_temp.i('mei'), pg_temp.i('p1'), 3, 'thumb')
    and v ->> 'editPreviewKey' = pg_temp.k(pg_temp.i('mei'), pg_temp.i('p1'), 2, 'preview')
  from jsonb_array_elements(sweep_photo_rows(array[pg_temp.i('p1')])) v), 'sweep_photo_rows reports the recorded keys');

-- ---- Quota --------------------------------------------------------------------------------------------
-- Pad Mei's usage to 3,000 bytes under the free plan's 5 GB, check, then take the pad back off.
create temp table pad as select 5368709120 - 3000 - storage_bytes as n from public.profiles where id = '40000000-0000-0000-0000-000000000001';
update public.profiles set storage_bytes = storage_bytes + (select n from pad) where id = pg_temp.i('mei');
select pg_temp.ok(pg_temp.rec(pg_temp.i('mei'), pg_temp.i('p1'), 3, 'preview', 70000) ->> 'status' = 'storage_full',
  'a variant that would pass the plan''s storage → storage_full');
select pg_temp.ok(pg_temp.rec(pg_temp.i('mei'), pg_temp.i('p1'), 3, 'thumb', 2000) ->> 'status' = 'exists',
  'a repeat of a recorded variant is "exists" even when storage is full, never storage_full');
update public.profiles set storage_bytes = storage_bytes - (select n from pad) where id = pg_temp.i('mei');
select pg_temp.ok(pg_temp.all_ok(), 'no drift after the quota checks');

-- ---- Revert -------------------------------------------------------------------------------------------
select pg_temp.ok(delete_edit(pg_temp.i('wei'), pg_temp.i('p1')) is null, 'delete_edit: other owner → null');
select pg_temp.ok((select jsonb_array_length(v -> 'keys') = 2 from (select delete_edit(pg_temp.i('mei'), pg_temp.i('p1')) v) x),
  'revert returns the variant keys to delete');
select pg_temp.ok(get_edit(pg_temp.i('mei'), pg_temp.i('p1')) = '{"edit": null}'::jsonb and pg_temp.all_ok(), 'revert removes the edit and its bytes');
select pg_temp.ok(delete_edit(pg_temp.i('mei'), pg_temp.i('p1')) = '{"keys": []}'::jsonb, 'reverting again is a no-op');
select pg_temp.ok(save_edit(pg_temp.i('mei'), pg_temp.i('p1'), '{"v":1,"color":{"tint":4}}', null) #>> '{edit,version}' = '5',
  'versions never repeat after a revert');
select pg_temp.ok(pg_temp.rec(pg_temp.i('mei'), pg_temp.i('p1'), 3, 'thumb', 100) ->> 'status' = 'gone',
  'a variant rendered before the revert can''t be recorded');

-- ---- Trash --------------------------------------------------------------------------------------------
select pg_temp.rec(pg_temp.i('mei'), pg_temp.i('p1'), 5, 'thumb', 900);
select bulk_photos(pg_temp.i('mei'), array[pg_temp.i('p1')], 'trash');
select pg_temp.ok(save_edit(pg_temp.i('mei'), pg_temp.i('p1'), '{"v":1}', 5) is null and get_edit(pg_temp.i('mei'), pg_temp.i('p1')) is null
  and delete_edit(pg_temp.i('mei'), pg_temp.i('p1')) is null, 'a photo in the Trash can''t be edited');
select pg_temp.ok(pg_temp.rec(pg_temp.i('mei'), pg_temp.i('p1'), 5, 'preview', 900) ->> 'status' = 'gone', 'nor get variants');
select pg_temp.ok((get_usage(pg_temp.i('mei')) ->> 'trashBytes')::bigint = 1300 + 900, 'Trash bytes include edited variants');
select pg_temp.ok((select bool_or(x ? pg_temp.k(pg_temp.i('mei'), pg_temp.i('p1'), 5, 'thumb'))
  from (select jsonb_array_elements(bulk_photos(pg_temp.i('mei'), array[pg_temp.i('p1')], 'delete_forever') -> 'purge') -> 'keys' x) y),
  'purging a photo lists its edited variants');
select pg_temp.ok(confirm_photo_purges(array[pg_temp.i('p1')]) = 1, 'confirm the purge');
select pg_temp.ok(pg_temp.all_ok()
  and not exists (select 1 from public.photo_edits where photo_id = pg_temp.i('p1')), 'a purge removes the edit and its bytes');

-- ---- Bulk ---------------------------------------------------------------------------------------------
select pg_temp.ok((select (v ->> 'batchSize')::int = 25 and jsonb_array_length(v -> 'items') = 2
  from (select bulk_edit_state(pg_temp.i('mei'), array[pg_temp.i('p2'), pg_temp.i('p3'), pg_temp.i('w1')]) v) x),
  'bulk state: the plan''s batch size and only the caller''s ready photos');
select pg_temp.ok((select v -> 'conflicts' = jsonb_build_array(pg_temp.i('p2')) and jsonb_array_length(v -> 'applied') = 1
  from (select apply_bulk_edits(pg_temp.i('mei'), jsonb_build_array(
    jsonb_build_object('photoId', pg_temp.i('p2'), 'baseVersion', null, 'recipe', '{"v":1,"effects":{"vignette":-10}}'::jsonb),
    jsonb_build_object('photoId', pg_temp.i('p3'), 'baseVersion', null, 'recipe', '{"v":1,"effects":{"vignette":-10}}'::jsonb),
    jsonb_build_object('photoId', pg_temp.i('w1'), 'baseVersion', null, 'recipe', '{"v":1}'::jsonb))) v) x),
  'bulk apply: a photo whose edit moved on is a conflict; another member''s photo is ignored');
select pg_temp.ok(get_edit(pg_temp.i('wei'), pg_temp.i('w1')) = '{"edit": null}'::jsonb, 'the other member''s photo is untouched');
select pg_temp.rec(pg_temp.i('mei'), pg_temp.i('p3'), (get_edit(pg_temp.i('mei'), pg_temp.i('p3')) #>> '{edit,version}')::int, 'preview', 7000);
select pg_temp.ok((select jsonb_array_length(v -> 'keys') = 1 and v #> '{applied,0,edit}' = 'null'::jsonb
  from (select apply_bulk_edits(pg_temp.i('mei'), jsonb_build_array(
    jsonb_build_object('photoId', pg_temp.i('p3'), 'baseVersion', (get_edit(pg_temp.i('mei'), pg_temp.i('p3')) #>> '{edit,version}')::int, 'recipe', null))) v) x)
  and pg_temp.all_ok(), 'bulk revert returns variant keys and releases their bytes');
select pg_temp.ok(apply_bulk_edits(pg_temp.i('mei'), jsonb_build_array(jsonb_build_object('photoId', pg_temp.i('p2'), 'baseVersion', 1, 'recipe', '{"v":2}'::jsonb))) ->> 'error' = 'invalid',
  'bulk apply rejects a malformed recipe');

-- ---- Saved recipes ------------------------------------------------------------------------------------
select pg_temp.ok((select v ->> 'name' = 'Warm' from (select create_recipe(pg_temp.i('mei'), E'  Warm\u0007 ', '{"v":1,"color":{"temperature":20}}') v) x),
  'create_recipe cleans the name');
select pg_temp.ok(create_recipe(pg_temp.i('mei'), 'Crop', '{"v":1,"crop":{"angle":2}}') ->> 'error' = 'invalid', 'a saved recipe never carries a crop');
select pg_temp.ok(create_recipe(pg_temp.i('mei'), repeat('x', 61), '{"v":1}') ->> 'error' = 'invalid', 'names are at most 60 characters');
select pg_temp.ok(jsonb_array_length(list_recipes(pg_temp.i('mei'))) = 1 and list_recipes(pg_temp.i('wei')) = '[]'::jsonb, 'recipes are per member');
insert into ids select 'r1', (list_recipes(pg_temp.i('mei')) #>> '{0,id}')::uuid;
select pg_temp.ok(update_recipe(pg_temp.i('wei'), pg_temp.i('r1'), 'Mine', null) is null and delete_recipe(pg_temp.i('wei'), pg_temp.i('r1')) is null,
  'another member can''t change or delete it');
select pg_temp.ok(update_recipe(pg_temp.i('mei'), pg_temp.i('r1'), 'Warmer', null) ->> 'name' = 'Warmer', 'rename');
select pg_temp.ok(update_recipe(pg_temp.i('mei'), pg_temp.i('r1'), null, '{"v":1,"crop":{}}') ->> 'error' = 'invalid', 'an update can''t add a crop');
insert into public.recipes (owner_id, name, recipe) select pg_temp.i('mei'), 'r' || g, '{"v":1}' from generate_series(1, 199) g;
select pg_temp.ok(create_recipe(pg_temp.i('mei'), 'One more', '{"v":1}') ->> 'error' = 'limit', 'at most 200 saved recipes');
select pg_temp.ok(delete_recipe(pg_temp.i('mei'), pg_temp.i('r1')), 'delete');

-- ---- Privileges ---------------------------------------------------------------------------------------
select pg_temp.ok(not exists (
  select 1 from unnest(array['photo_edits', 'recipes']) t(n)
    cross join unnest(array['anon', 'authenticated']) r(role)
    cross join unnest(array['select', 'insert', 'update', 'delete']) pr(priv)
   where has_table_privilege(r.role, 'public.' || t.n, pr.priv)), 'browser roles hold no privileges on editor tables');
select pg_temp.ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.photo_edits'::regclass, 'public.recipes'::regclass)), 'RLS is on');
select pg_temp.ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '\_%' and has_function_privilege('service_role', p.oid, 'execute')),
  'service_role calls entry points, not helpers');
select pg_temp.ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('get_edit', 'save_edit', 'delete_edit', 'edit_variant_check', 'record_edit_variant', 'bulk_edit_state',
    'apply_bulk_edits', 'list_recipes', 'create_recipe', 'update_recipe', 'delete_recipe')), 'entry points are security definer with an empty search_path');
set local role authenticated;
do $$ begin
  begin
    perform count(*) from public.photo_edits;
    raise exception 'FAILED: a member could read photo_edits';
  exception when insufficient_privilege then raise notice 'ok - members cannot read photo_edits';
  end;
  begin
    perform public.save_edit('40000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '{"v":1}', null);
    raise exception 'FAILED: a member could call save_edit';
  exception when insufficient_privilege then raise notice 'ok - members cannot call editor functions';
  end;
end $$;
reset role;

rollback;
\echo 'All editor tests passed.'
