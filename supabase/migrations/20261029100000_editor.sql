-- Phase 4: the editor. One saved edit per photo (a sparse JSON recipe on top of the untouched original),
-- the edited thumbnail and preview the browser renders from it, and members' saved recipes.
-- See docs/phase-4.md.
--
-- Every entry point is security definer, takes the owner id the API read from the verified session, and
-- filters by it. Only service_role (the API Worker) may call them. The Worker validates and normalises
-- recipes (packages/shared normalizeRecipe); the database only bounds their size and shape.
--
-- Versions: photos.edit_version only ever grows. Each save and each revert takes the next number, so an
-- edited variant rendered for an older version (or for an edit that was reverted and redone) can never be
-- recorded against the current one. Each edited-variant PUT writes its own object,
-- u/<owner>/p/<photo>/edit-<version>-<kind>-<nonce> (128-bit random hex), so no request can overwrite or
-- delete an object another request stored; photo_edits records the one key per kind that counts, the
-- version it was rendered from and its measured size.
--
-- Usage invariant (extends the library one; tested in supabase/tests/40_editor_test.sql):
--   profiles.storage_bytes = Σ photos (size + thumb + preview) over ready, trashed, purging
--                          + Σ photo_edits (thumb_bytes + preview_bytes) of those photos
-- Edit variant bytes change only under the owner's storage lock (public._lock_storage).

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
alter table public.photos add column edit_version integer not null default 0 check (edit_version >= 0);

create table public.photo_edits (
  photo_id uuid primary key references public.photos (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  recipe jsonb not null check (jsonb_typeof(recipe) = 'object' and recipe ->> 'v' = '1' and octet_length(recipe::text) <= 4096),
  version integer not null check (version >= 1),
  -- The version each stored edited variant was rendered from (null: none stored) and its measured size.
  thumb_version integer check (thumb_version >= 1),
  thumb_key text,
  thumb_bytes integer not null default 0 check (thumb_bytes between 0 and 307200),
  preview_version integer check (preview_version >= 1),
  preview_key text,
  preview_bytes integer not null default 0 check (preview_bytes between 0 and 1572864),
  -- The stored edited preview's pixel size (read from its header by the Worker): its aspect is the edited
  -- photo's, crop and quarter turns included, so galleries never lay it out with the original's.
  preview_width integer check (preview_width between 1 and 8192),
  preview_height integer check (preview_height between 1 and 8192),
  updated_at timestamptz not null default now(),
  constraint photo_edits_thumb_pair check ((thumb_version is null) = (thumb_bytes = 0) and (thumb_version is null) = (thumb_key is null)),
  constraint photo_edits_preview_pair check ((preview_version is null) = (preview_bytes = 0) and (preview_version is null) = (preview_key is null)),
  constraint photo_edits_preview_size check ((preview_width is null) = (preview_height is null)
                                              and (preview_version is not null or preview_width is null))
);
alter table public.photo_edits enable row level security;
create index photo_edits_owner on public.photo_edits (owner_id);

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(name) between 1 and 60),
  -- Saved recipes never carry a crop: photos are framed differently.
  recipe jsonb not null check (jsonb_typeof(recipe) = 'object' and recipe ->> 'v' = '1'
                               and not (recipe ? 'crop') and octet_length(recipe::text) <= 4096),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.recipes enable row level security;
create index recipes_owner on public.recipes (owner_id, updated_at desc);

-- An edit row always belongs to its photo's owner, whoever writes it.
create function public._edit_same_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.photos p where p.id = new.photo_id and p.owner_id = new.owner_id) then
    raise exception 'edit and photo belong to different owners' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger photo_edits_same_owner before insert or update of photo_id, owner_id on public.photo_edits
  for each row execute function public._edit_same_owner();

-- ---------------------------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------------------------
-- True when p_key is a well-formed edited-variant key for this owner, photo, version and kind:
-- <canonical prefix>edit-<version>-<kind>-<32 lower-case hex>. The prefix comes from the uuids' own text
-- form (always lower case), so a key built from a differently spelled id can never be recorded.
create function public._edit_key_ok(p_owner uuid, p_photo uuid, p_version integer, p_kind text, p_key text) returns boolean
language sql immutable set search_path = '' as $$
  select p_key is not null
     and left(p_key, length(public._r2_prefix(p_owner, p_photo) || 'edit-' || p_version::text || '-' || p_kind || '-'))
         = public._r2_prefix(p_owner, p_photo) || 'edit-' || p_version::text || '-' || p_kind || '-'
     and substr(p_key, length(public._r2_prefix(p_owner, p_photo) || 'edit-' || p_version::text || '-' || p_kind || '-') + 1) ~ '^[0-9a-f]{32}$';
$$;

-- An edit that changes nothing (the photo looks like its original).
create function public._recipe_empty(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p is null or p = '{"v": 1}'::jsonb;
$$;

-- PhotoEdit.
create function public._edit_json(e public.photo_edits) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'photoId', e.photo_id,
    'recipe', e.recipe,
    'version', e.version,
    'rendered', e.thumb_version is not distinct from e.version and e.preview_version is not distinct from e.version,
    'updatedAt', e.updated_at);
$$;

-- Keys of the edited variants an edit row records.
create function public._edit_keys(e public.photo_edits) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(k), '[]'::jsonb) from (
    select e.thumb_key k where e.thumb_key is not null
    union all
    select e.preview_key where e.preview_key is not null
  ) x;
$$;

-- original, thumb, preview, the two staging keys, then any recorded edited variants (so every purge path
-- removes them with the photo).
create or replace function public._photo_keys(p_owner uuid, p_photo uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_array(
    public._r2_prefix(p_owner, p_photo) || 'original',
    public._r2_prefix(p_owner, p_photo) || 'thumb',
    public._r2_prefix(p_owner, p_photo) || 'preview',
    public._staging_prefix(p_owner, p_photo) || 'thumb',
    public._staging_prefix(p_owner, p_photo) || 'preview')
  || coalesce((select public._edit_keys(e) from public.photo_edits e where e.photo_id = p_photo and e.owner_id = p_owner),
              '[]'::jsonb);
$$;

-- PhotoItem now says whether the photo is edited (a neutral recipe counts as unedited).
create or replace function public._photo_json(p public.photos) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id,
    'filename', p.filename,
    'fileType', p.file_type,
    'sizeBytes', p.size_bytes,
    'width', p.width,
    'height', p.height,
    'takenAt', p.taken_at,
    'createdAt', p.created_at,
    'favourite', p.favourite,
    'hasThumb', p.has_thumb,
    'hasPreview', p.has_preview,
    'edit', (select jsonb_build_object(
                      'version', e.version,
                      'rendered', e.thumb_version is not distinct from e.version
                                  and e.preview_version is not distinct from e.version)
               from public.photo_edits e
              where e.photo_id = p.id and not public._recipe_empty(e.recipe))
  ) || case when p.status = 'trashed'
            then jsonb_build_object('trashedAt', p.trashed_at, 'purgeAt', p.purge_after)
            else '{}'::jsonb end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Library functions that now know about edits
-- ---------------------------------------------------------------------------------------------
-- view adds 'edited' (ready photos with a non-neutral edit).
create or replace function public.list_photos(
  p_owner uuid,
  p_view text default 'library',
  p_album uuid default null,
  p_q text default null,
  p_from date default null,
  p_to date default null,
  p_sort text default 'taken',
  p_cursor text default null,
  p_limit integer default 60
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 60), 1), 200);
  col text;
  pattern text;
  c_at timestamptz;
  c_id uuid;
  items jsonb;
  total integer;
  last_at timestamptz;
  last_id uuid;
begin
  if p_album is not null and not exists (select 1 from public.albums a where a.id = p_album and a.owner_id = p_owner) then
    return null;
  end if;
  col := case when p_view = 'trash' then 'trashed_at' when p_sort = 'added' then 'created_at' else 'sort_at' end;
  if nullif(btrim(p_q), '') is not null then
    pattern := '%' || replace(replace(replace(lower(btrim(p_q)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  select c.at, c.id into c_at, c_id from public._parse_cursor(p_cursor) c;

  execute format($sql$
    select coalesce(jsonb_agg(public._photo_json(x.ph) order by x.k desc, x.id desc) filter (where x.rn <= $10), '[]'::jsonb),
           count(*)::integer,
           max(x.k) filter (where x.rn = $10),
           (array_agg(x.id) filter (where x.rn = $10))[1]
      from (
        select p as ph, p.%1$I as k, p.id, row_number() over (order by p.%1$I desc, p.id desc) as rn
          from public.photos p
         where p.owner_id = $1
           and p.status = $2
           and ($3 <> 'favourites' or p.favourite)
           and ($3 <> 'raw' or p.file_type in ('cr2', 'nef', 'arw'))
           and ($3 <> 'edited' or exists (select 1 from public.photo_edits e
                                           where e.photo_id = p.id and not public._recipe_empty(e.recipe)))
           and ($4::uuid is null or exists (select 1 from public.album_photos ap where ap.album_id = $4 and ap.photo_id = p.id))
           and ($5::text is null or p.search_text like $5)
           and ($6::date is null or p.sort_at >= ($6::date::timestamp at time zone 'UTC'))
           and ($7::date is null or p.sort_at < (($7::date + 1)::timestamp at time zone 'UTC'))
           and ($8::timestamptz is null or (p.%1$I, p.id) < ($8, $9))
         order by p.%1$I desc, p.id desc
         limit $10 + 1
      ) x
  $sql$, col)
  into items, total, last_at, last_id
  using p_owner, case when p_view = 'trash' then 'trashed' else 'ready' end, coalesce(p_view, 'library'),
        p_album, pattern, p_from, p_to, c_at, c_id, lim;

  return jsonb_build_object(
    'items', items,
    'nextCursor', case when total > lim then public._cursor(last_at, last_id) end);
end;
$$;

-- PhotoDetail adds the recipe (null when unedited).
create or replace function public.get_photo(p_owner uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public._photo_json(p) || jsonb_build_object(
    'metadata', p.metadata,
    'albums', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) order by a.name, a.id)
                          from public.album_photos ap join public.albums a on a.id = ap.album_id
                         where ap.photo_id = p.id and a.owner_id = p_owner), '[]'::jsonb),
    'recipe', (select e.recipe from public.photo_edits e where e.photo_id = p.id and not public._recipe_empty(e.recipe)))
  from public.photos p
  where p.id = p_id and p.owner_id = p_owner and p.status in ('ready', 'trashed');
$$;

-- The media route also learns which edited variants are current: editThumbKey / editPreviewKey (the
-- recorded object) are set only when that kind was rendered from the current, non-neutral edit.
create or replace function public.photo_file(p_owner uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('fileType', p.file_type, 'filename', p.filename, 'sizeBytes', p.size_bytes,
                            'hasThumb', p.has_thumb, 'hasPreview', p.has_preview,
                            'editVersion', e.version,
                            'editThumbKey', case when e.thumb_version = e.version and not public._recipe_empty(e.recipe) then e.thumb_key end,
                            'editPreviewKey', case when e.preview_version = e.version and not public._recipe_empty(e.recipe) then e.preview_key end)
  from public.photos p left join public.photo_edits e on e.photo_id = p.id
  where p.id = p_id and p.owner_id = p_owner and p.status in ('ready', 'trashed');
$$;

-- Trash bytes include the trashed photos' edited variants.
create or replace function public.get_usage(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'usedBytes', pr.storage_bytes,
    'reservedBytes', pr.reserved_bytes,
    'limitBytes', r.storage_bytes,
    'trashBytes', (select coalesce(sum(p.size_bytes + p.thumb_bytes + p.preview_bytes
                                       + coalesce(e.thumb_bytes + e.preview_bytes, 0)), 0)
                     from public.photos p left join public.photo_edits e on e.photo_id = p.id
                    where p.owner_id = p_owner and p.status in ('trashed', 'purging')),
    'photoCount', (select count(*) from public.photos p where p.owner_id = p_owner and p.status = 'ready'),
    'plan', pr.plan_id,
    'fileTypes', to_jsonb(r.file_types),
    'maxFileBytes', r.max_file_bytes,
    'batchSize', r.batch_size)
  from public.profiles pr cross join lateral public._plan_rules(pr.plan_id) r
  where pr.id = p_owner;
$$;

-- Purged photos take their edited variants' bytes with them (the edit rows cascade).
create or replace function public.confirm_photo_purges(p_ids uuid[]) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  o uuid;
  freed bigint;
  edits bigint;
  k integer;
  n integer := 0;
begin
  for o in select distinct p.owner_id from public.photos p where p.id = any (p_ids) order by 1 loop
    perform public._lock_storage(o);
    select coalesce(sum(e.thumb_bytes + e.preview_bytes), 0) into edits
      from public.photo_edits e join public.photos p on p.id = e.photo_id
     where p.id = any (p_ids) and p.owner_id = o and p.status = 'purging';
    with d as (
      delete from public.photos p where p.id = any (p_ids) and p.owner_id = o and p.status = 'purging'
      returning p.size_bytes + p.thumb_bytes + p.preview_bytes as bytes
    )
    select coalesce(sum(d.bytes), 0), count(*) into freed, k from d;
    update public.profiles set storage_bytes = storage_bytes - freed - edits where id = o;
    n := n + k;
  end loop;
  return n;
end;
$$;

-- Orphan sweep: rows now also say which edited variant versions are recorded.
create or replace function public.sweep_photo_rows(p_ids uuid[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'ownerId', p.owner_id, 'status', p.status,
           'activeUpload', exists (select 1 from public.uploads u where u.photo_id = p.id),
           'editThumbKey', e.thumb_key,
           'editPreviewKey', e.preview_key)), '[]'::jsonb)
    from public.photos p left join public.photo_edits e on e.photo_id = p.id
   where p.id = any (p_ids[1:1000]);
$$;

-- ---------------------------------------------------------------------------------------------
-- Edits
-- ---------------------------------------------------------------------------------------------
-- {edit: PhotoEdit | null} for a ready photo of this owner, or null (not theirs, not found, in Trash).
create function public.get_edit(p_owner uuid, p_photo uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('edit', (select public._edit_json(e) from public.photo_edits e where e.photo_id = p.id))
    from public.photos p
   where p.id = p_photo and p.owner_id = p_owner and p.status = 'ready';
$$;

-- Saves the photo's edit if p_base_version is still current (null: the photo had no edit). Returns
-- {status: 'ok', edit} | {status: 'conflict', edit: <current edit or null>}, or null if the photo isn't a
-- ready photo of this owner. Stored variants stay (counted) until the new version's replace them.
create function public.save_edit(p_owner uuid, p_photo uuid, p_recipe jsonb, p_base_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.photos;
  e public.photo_edits;
  v integer;
begin
  if p_recipe is null or jsonb_typeof(p_recipe) <> 'object' or p_recipe ->> 'v' is distinct from '1'
     or octet_length(p_recipe::text) > 4096 then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into p from public.photos where id = p_photo and owner_id = p_owner and status = 'ready' for update;
  if not found then return null; end if;
  select * into e from public.photo_edits where photo_id = p_photo for update;
  if (case when found then e.version else null end) is distinct from p_base_version then
    return jsonb_build_object('status', 'conflict', 'edit', case when e.photo_id is not null then public._edit_json(e) end);
  end if;
  v := p.edit_version + 1;
  update public.photos set edit_version = v where id = p_photo;
  insert into public.photo_edits (photo_id, owner_id, recipe, version)
  values (p_photo, p_owner, p_recipe, v)
  on conflict (photo_id) do update set recipe = excluded.recipe, version = excluded.version, updated_at = now()
  returning * into e;
  return jsonb_build_object('status', 'ok', 'edit', public._edit_json(e));
end;
$$;

-- Reverts a ready photo to its original: removes the edit, releases its variants' bytes under the storage
-- lock and returns {keys} for the Worker to delete (empty if there was no edit). Null if the photo isn't
-- a ready photo of this owner. Bumps edit_version so in-flight variant PUTs can't be recorded.
create function public.delete_edit(p_owner uuid, p_photo uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  e public.photo_edits;
begin
  perform public._lock_storage(p_owner);
  perform 1 from public.photos where id = p_photo and owner_id = p_owner and status = 'ready' for update;
  if not found then return null; end if;
  delete from public.photo_edits where photo_id = p_photo returning * into e;
  if not found then return jsonb_build_object('keys', '[]'::jsonb); end if;
  update public.photos set edit_version = edit_version + 1 where id = p_photo;
  update public.profiles set storage_bytes = storage_bytes - e.thumb_bytes - e.preview_bytes where id = p_owner;
  return jsonb_build_object('keys', public._edit_keys(e));
end;
$$;

-- Before a variant PUT writes anything: {status: 'current'} (store it) | {status: 'exists'} (this version
-- of this kind is already recorded: nothing to do) | {status: 'stale'} (not the current edit version), or
-- null if the photo isn't a ready photo of this owner.
create function public.edit_variant_check(p_owner uuid, p_photo uuid, p_version integer, p_kind text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('status',
           case when e.photo_id is null or e.version <> p_version then 'stale'
                when (case p_kind when 'thumb' then e.thumb_version else e.preview_version end) = p_version then 'exists'
                else 'current' end)
    from public.photos p left join public.photo_edits e on e.photo_id = p.id
   where p.id = p_photo and p.owner_id = p_owner and p.status = 'ready' and p_kind in ('thumb', 'preview');
$$;

-- Records an edited variant the Worker stored at p_key (its own, never-reused key; see _edit_key_ok) and
-- measured in R2. Under the owner's storage lock, and only while p_version is the photo's current edit
-- version. Returns {status: 'ok', previousKey} (the replaced object to delete, or null) |
-- {status: 'exists'} (the same version of this kind was recorded meanwhile: the Worker deletes its own
-- object and succeeds) | {status: 'gone'} (the edit changed, was reverted, or the photo isn't ready: the
-- Worker deletes its own object) | {status: 'storage_full'} | {status: 'invalid'}.
create function public.record_edit_variant(p_owner uuid, p_photo uuid, p_version integer, p_kind text, p_key text, p_bytes integer,
  p_width integer default null, p_height integer default null)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  e public.photo_edits;
  prof record;
  rules record;
  old_v integer;
  old_key text;
  old_bytes integer;
  delta bigint;
begin
  if p_kind not in ('thumb', 'preview') or p_bytes is null or p_version is null
     or p_bytes not between 1 and (case p_kind when 'thumb' then 307200 else 1572864 end)
     or (p_width is null) <> (p_height is null) or p_width not between 1 and 8192 or p_height not between 1 and 8192
     or not public._edit_key_ok(p_owner, p_photo, p_version, p_kind, p_key) then
    return jsonb_build_object('status', 'invalid');
  end if;
  perform public._lock_storage(p_owner);
  perform 1 from public.photos where id = p_photo and owner_id = p_owner and status = 'ready' for update;
  if not found then return jsonb_build_object('status', 'gone'); end if;
  select * into e from public.photo_edits where photo_id = p_photo for update;
  if not found or e.version <> p_version then return jsonb_build_object('status', 'gone'); end if;
  if p_kind = 'thumb' then
    old_v := e.thumb_version; old_key := e.thumb_key; old_bytes := e.thumb_bytes;
  else
    old_v := e.preview_version; old_key := e.preview_key; old_bytes := e.preview_bytes;
  end if;
  -- Checked before the quota, so a duplicate PUT never reports storage_full for a variant that's stored.
  if old_v = p_version then return jsonb_build_object('status', 'exists'); end if;
  delta := p_bytes - old_bytes;
  select p.plan_id, p.storage_bytes, p.reserved_bytes into prof from public.profiles p where p.id = p_owner for update;
  select * into rules from public._plan_rules(prof.plan_id);
  if delta > 0 and prof.storage_bytes + prof.reserved_bytes + delta > rules.storage_bytes then
    return jsonb_build_object('status', 'storage_full');
  end if;
  if p_kind = 'thumb' then
    update public.photo_edits set thumb_version = p_version, thumb_key = p_key, thumb_bytes = p_bytes where photo_id = p_photo;
  else
    update public.photo_edits set preview_version = p_version, preview_key = p_key, preview_bytes = p_bytes,
           preview_width = p_width, preview_height = p_height
     where photo_id = p_photo;
  end if;
  update public.profiles set storage_bytes = storage_bytes + delta where id = p_owner;
  return jsonb_build_object('status', 'ok', 'previousKey', old_key);
end;
$$;

-- Bulk paste / apply / revert, step 1: the current state of the owner's ready photos among p_ids, for the
-- Worker to merge (packages/shared mergeRecipe): {batchSize, items: [{photoId, version, recipe}]}
-- (version and recipe null for unedited photos). Other ids are left out.
create function public.bulk_edit_state(p_owner uuid, p_ids uuid[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'batchSize', (select r.batch_size from public.profiles pr cross join lateral public._plan_rules(pr.plan_id) r where pr.id = p_owner),
    'items', coalesce((select jsonb_agg(jsonb_build_object('photoId', p.id, 'version', e.version, 'recipe', e.recipe) order by p.id)
                         from public.photos p left join public.photo_edits e on e.photo_id = p.id
                        where p.owner_id = p_owner and p.status = 'ready' and p.id = any (p_ids[1:500])), '[]'::jsonb));
$$;

-- Step 2: applies p_items [{photoId, baseVersion, recipe (null: revert)}] where each photo's edit is still
-- at baseVersion (null: unedited), under the owner's storage lock. Photos changed meanwhile are reported
-- in `conflicts` for the Worker to re-read and retry; nothing is overwritten from a stale merge.
-- Returns {applied: [{photoId, edit | null}], conflicts: [photoId], keys: [edited variant objects of
-- reverted photos, to delete]}.
create function public.apply_bulk_edits(p_owner uuid, p_items jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  it jsonb;
  pid uuid;
  base integer;
  rec jsonb;
  p public.photos;
  e public.photo_edits;
  have boolean;
  v integer;
  applied jsonb := '[]'::jsonb;
  conflicts jsonb := '[]'::jsonb;
  keys jsonb := '[]'::jsonb;
  freed bigint := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then
    return jsonb_build_object('error', 'invalid');
  end if;
  -- Validate everything before changing anything.
  if exists (select 1 from jsonb_array_elements(p_items) x
              where jsonb_typeof(x.value) <> 'object'
                 or coalesce(x.value ->> 'photoId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                 or jsonb_typeof(coalesce(x.value -> 'baseVersion', 'null')) not in ('null', 'number')
                 or jsonb_typeof(coalesce(x.value -> 'recipe', 'null')) not in ('null', 'object')
                 or (jsonb_typeof(x.value -> 'recipe') = 'object'
                     and (x.value #>> '{recipe,v}' is distinct from '1' or octet_length((x.value -> 'recipe')::text) > 4096))) then
    return jsonb_build_object('error', 'invalid');
  end if;
  perform public._lock_storage(p_owner);
  for it in select x.value from jsonb_array_elements(p_items) x loop
    pid := (it ->> 'photoId')::uuid;
    base := (it ->> 'baseVersion')::integer;
    rec := case when jsonb_typeof(it -> 'recipe') = 'object' then it -> 'recipe' end;
    select * into p from public.photos where id = pid and owner_id = p_owner and status = 'ready' for update;
    continue when not found;
    select * into e from public.photo_edits where photo_id = pid for update;
    have := found;
    if (case when have then e.version end) is distinct from base then
      conflicts := conflicts || to_jsonb(pid);
      continue;
    end if;
    if rec is null then
      continue when not have;
      delete from public.photo_edits where photo_id = pid;
      update public.photos set edit_version = edit_version + 1 where id = pid;
      freed := freed + e.thumb_bytes + e.preview_bytes;
      keys := keys || public._edit_keys(e);
      applied := applied || jsonb_build_array(jsonb_build_object('photoId', pid, 'edit', null));
    else
      v := p.edit_version + 1;
      update public.photos set edit_version = v where id = pid;
      insert into public.photo_edits (photo_id, owner_id, recipe, version)
      values (pid, p_owner, rec, v)
      on conflict (photo_id) do update set recipe = excluded.recipe, version = excluded.version, updated_at = now()
      returning * into e;
      applied := applied || jsonb_build_array(jsonb_build_object('photoId', pid, 'edit', public._edit_json(e)));
    end if;
  end loop;
  if freed > 0 then
    update public.profiles set storage_bytes = storage_bytes - freed where id = p_owner;
  end if;
  return jsonb_build_object('applied', applied, 'conflicts', conflicts, 'keys', keys);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Saved recipes (at most 200 per member)
-- ---------------------------------------------------------------------------------------------
create function public._recipe_json(r public.recipes) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', r.id, 'name', r.name, 'recipe', r.recipe, 'createdAt', r.created_at, 'updatedAt', r.updated_at);
$$;

create function public._recipe_ok(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and jsonb_typeof(p) = 'object' and p ->> 'v' = '1' and not (p ? 'crop') and octet_length(p::text) <= 4096;
$$;

create function public._recipe_name(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(btrim(regexp_replace(coalesce(p, ''), '[[:cntrl:]]', '', 'g')), '');
$$;

create function public.list_recipes(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public._recipe_json(r) order by r.updated_at desc, r.id desc), '[]'::jsonb)
    from public.recipes r where r.owner_id = p_owner;
$$;

-- SavedRecipe, or {error: 'invalid' | 'limit'}.
create function public.create_recipe(p_owner uuid, p_name text, p_recipe jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.recipes;
  nm text := public._recipe_name(p_name);
begin
  if nm is null or length(nm) > 60 or not public._recipe_ok(p_recipe) then
    return jsonb_build_object('error', 'invalid');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('zephyr:recipes:' || p_owner::text, 0));
  if (select count(*) from public.recipes where owner_id = p_owner) >= 200 then
    return jsonb_build_object('error', 'limit');
  end if;
  insert into public.recipes (owner_id, name, recipe) values (p_owner, nm, p_recipe) returning * into r;
  return public._recipe_json(r);
end;
$$;

-- Renames and/or replaces the recipe (null leaves it). SavedRecipe, null if not found, or {error: 'invalid'}.
create function public.update_recipe(p_owner uuid, p_id uuid, p_name text, p_recipe jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.recipes;
  nm text := public._recipe_name(p_name);
begin
  if (p_name is not null and (nm is null or length(nm) > 60))
     or (p_recipe is not null and not public._recipe_ok(p_recipe)) then
    return jsonb_build_object('error', 'invalid');
  end if;
  update public.recipes
     set name = coalesce(nm, name), recipe = coalesce(p_recipe, recipe), updated_at = now()
   where id = p_id and owner_id = p_owner
  returning * into r;
  if not found then return null; end if;
  return public._recipe_json(r);
end;
$$;

create function public.delete_recipe(p_owner uuid, p_id uuid) returns boolean
language sql volatile security definer set search_path = '' as $$
  delete from public.recipes where id = p_id and owner_id = p_owner returning true;
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: service_role only. Internal helpers (_*) are callable by no role but their owner.
-- ---------------------------------------------------------------------------------------------
revoke all on public.photo_edits, public.recipes from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on function
  public._edit_same_owner(),
  public._edit_key_ok(uuid, uuid, integer, text, text),
  public._recipe_empty(jsonb),
  public._edit_json(public.photo_edits),
  public._edit_keys(public.photo_edits),
  public._photo_keys(uuid, uuid),
  public._photo_json(public.photos),
  public._recipe_json(public.recipes),
  public._recipe_ok(jsonb),
  public._recipe_name(text)
from service_role;
grant execute on function
  public.list_photos(uuid, text, uuid, text, date, date, text, text, integer),
  public.get_photo(uuid, uuid),
  public.photo_file(uuid, uuid),
  public.get_usage(uuid),
  public.confirm_photo_purges(uuid[]),
  public.sweep_photo_rows(uuid[]),
  public.get_edit(uuid, uuid),
  public.save_edit(uuid, uuid, jsonb, integer),
  public.delete_edit(uuid, uuid),
  public.edit_variant_check(uuid, uuid, integer, text),
  public.record_edit_variant(uuid, uuid, integer, text, text, integer, integer, integer),
  public.bulk_edit_state(uuid, uuid[]),
  public.apply_bulk_edits(uuid, jsonb),
  public.list_recipes(uuid),
  public.create_recipe(uuid, text, jsonb),
  public.update_recipe(uuid, uuid, text, jsonb),
  public.delete_recipe(uuid, uuid)
to service_role;
