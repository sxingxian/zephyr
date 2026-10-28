-- Phase 3: the photo library. Photos, resumable uploads, albums, Trash, storage usage and account
-- deletion. See docs/phase-3.md.
--
-- Every entry point is security definer, takes the owner id the API read from the verified session,
-- and filters by it. Only service_role (the API Worker) may call them.
--
-- Usage invariant (tested in supabase/tests/30_library_test.sql), kept under a per-owner advisory lock:
--   profiles.storage_bytes  = Σ size_bytes + thumb_bytes + preview_bytes over photos in ready, trashed, purging
--   profiles.reserved_bytes = Σ uploads.reserved_bytes
-- R2 objects are deleted before the rows that account for them: the job and bulk paths move photos to
-- 'purging' (hidden everywhere, still counted, can't be restored), the Worker deletes the objects, then a
-- confirm_* function removes the rows and the usage.

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
alter table public.profiles
  add column storage_bytes bigint not null default 0 check (storage_bytes >= 0),
  add column reserved_bytes bigint not null default 0 check (reserved_bytes >= 0),
  add column deletion_requested_at timestamptz,
  add column deletion_due timestamptz,
  add constraint profiles_deletion_pair check ((deletion_requested_at is null) = (deletion_due is null));

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- uploading → ready ⇄ trashed → purging → (row deleted once the R2 objects are gone)
  status text not null default 'uploading' check (status in ('uploading', 'ready', 'trashed', 'purging')),
  file_type text not null check (file_type in ('jpeg', 'png', 'webp', 'cr2', 'nef', 'arw')),
  filename text not null check (length(filename) between 1 and 255),
  size_bytes bigint not null check (size_bytes > 0),
  sha256 bytea not null check (length(sha256) = 32),
  width integer check (width between 1 and 100000),
  height integer check (height between 1 and 100000),
  taken_at timestamptz,
  -- Only the keys public._clean_metadata keeps. No GPS, ever.
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  favourite boolean not null default false,
  has_thumb boolean not null default false,
  has_preview boolean not null default false,
  thumb_bytes integer not null default 0 check (thumb_bytes between 0 and 307200),
  preview_bytes integer not null default 0 check (preview_bytes between 0 and 1572864),
  created_at timestamptz not null default now(),
  trashed_at timestamptz,
  purge_after timestamptz,
  sort_at timestamptz generated always as (coalesce(taken_at, created_at)) stored,
  search_text text generated always as (
    lower(filename || ' ' || coalesce(metadata ->> 'cameraMake', '') || ' ' || coalesce(metadata ->> 'cameraModel', ''))
  ) stored,
  constraint photos_trash_dates check (
    (status in ('trashed', 'purging')) = (trashed_at is not null and purge_after is not null)
  )
);
alter table public.photos enable row level security;
-- One copy of a file per owner. A trashed copy still counts: uploading it again answers 'duplicate'
-- with the trashed photo's id, and the app offers to restore it instead.
create unique index photos_owner_content on public.photos (owner_id, sha256, size_bytes)
  where status in ('ready', 'trashed');
create index photos_owner_taken on public.photos (owner_id, sort_at desc, id desc) where status = 'ready';
create index photos_owner_added on public.photos (owner_id, created_at desc, id desc) where status = 'ready';
create index photos_owner_trash on public.photos (owner_id, trashed_at desc, id desc) where status = 'trashed';
create index photos_purge_due on public.photos (purge_after) where status in ('trashed', 'purging');
create index photos_search on public.photos using gin (search_text extensions.gin_trgm_ops);

create table public.uploads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  photo_id uuid not null unique references public.photos (id) on delete cascade,
  -- Created lazily by the first part PUT (see set_upload_r2), so a 500-file batch costs no R2 calls.
  r2_upload_id text check (length(r2_upload_id) between 1 and 1024),
  r2_key text not null,
  file_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  part_size integer not null check (part_size >= 5242880),
  part_count integer not null check (part_count between 1 and 10000),
  parts jsonb not null default '{}'::jsonb,    -- {"<n>": "<etag from R2>"}
  variants jsonb not null default '{}'::jsonb, -- {"thumb": <bytes>, "preview": <bytes>}
  reserved_bytes bigint not null check (reserved_bytes > 0),
  expires_at timestamptz not null default now() + interval '24 hours',
  created_at timestamptz not null default now()
);
alter table public.uploads enable row level security;
create index uploads_owner on public.uploads (owner_id);
create index uploads_expiry on public.uploads (expires_at);

create table public.albums (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  cover_photo_id uuid references public.photos (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.albums enable row level security;
create index albums_owner on public.albums (owner_id, updated_at desc);

create table public.album_photos (
  album_id uuid not null references public.albums (id) on delete cascade,
  photo_id uuid not null references public.photos (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (album_id, photo_id)
);
alter table public.album_photos enable row level security;
create index album_photos_photo on public.album_photos (photo_id);

-- An album only ever holds (and shows as its cover) its owner's photos, whoever writes the row.
create function public._album_photo_same_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from public.albums a join public.photos p on p.owner_id = a.owner_id
     where a.id = new.album_id and p.id = new.photo_id
  ) then
    raise exception 'album and photo belong to different owners' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger album_photos_same_owner before insert or update on public.album_photos
  for each row execute function public._album_photo_same_owner();

create function public._album_cover_same_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.cover_photo_id is not null and not exists (
    select 1 from public.photos p where p.id = new.cover_photo_id and p.owner_id = new.owner_id
  ) then
    raise exception 'cover photo belongs to a different owner' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger albums_cover_same_owner before insert or update of cover_photo_id, owner_id on public.albums
  for each row execute function public._album_cover_same_owner();

-- ---------------------------------------------------------------------------------------------
-- Internal helpers (callable by no role but their owner)
-- ---------------------------------------------------------------------------------------------
-- Serialises every change to one owner's usage. Always taken before any row lock.
create function public._lock_storage(p_owner uuid) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('zephyr:storage:' || p_owner::text, 0));
$$;

-- The owner's plan rules from the active plan-limits version.
create function public._plan_rules(p_plan text,
  out storage_bytes bigint, out batch_size integer, out file_types text[], out max_file_bytes bigint)
language sql stable set search_path = '' as $$
  select pl.storage_gb::bigint * 1073741824, pl.batch_size, pl.file_types, pl.max_file_mb::bigint * 1048576
    from public.plan_limits pl
    join public.plan_limit_versions v on v.id = pl.version_id and v.status = 'active'
   where pl.plan_id = p_plan;
$$;

create function public._r2_prefix(p_owner uuid, p_photo uuid) returns text
language sql immutable set search_path = '' as $$
  select 'u/' || p_owner::text || '/p/' || p_photo::text || '/';
$$;

create function public._photo_keys(p_owner uuid, p_photo uuid) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_array(public._r2_prefix(p_owner, p_photo) || 'original',
                           public._r2_prefix(p_owner, p_photo) || 'thumb',
                           public._r2_prefix(p_owner, p_photo) || 'preview');
$$;

-- Keeps only known EXIF keys with sane types and ranges (mirrors photoMetadataSchema). Never GPS.
create function public._clean_metadata(p jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  result jsonb := '{}'::jsonb;
  k text;
  v jsonb;
  n numeric;
  s text;
  t timestamptz;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return result; end if;
  for k, v in select e.key, e.value from jsonb_each(p) e loop
    if k in ('width', 'height', 'focalLengthMm', 'aperture', 'exposureSeconds', 'iso', 'orientation') then
      continue when jsonb_typeof(v) <> 'number';
      n := (v #>> '{}')::numeric;
      continue when not case k
        when 'width' then n between 1 and 100000 and n = trunc(n)
        when 'height' then n between 1 and 100000 and n = trunc(n)
        when 'focalLengthMm' then n between 0 and 5000
        when 'aperture' then n between 0 and 128
        when 'exposureSeconds' then n between 0 and 3600
        when 'iso' then n between 0 and 10000000 and n = trunc(n)
        else n between 1 and 8 and n = trunc(n) -- orientation
      end;
      result := result || jsonb_build_object(k, n);
    elsif k in ('cameraMake', 'cameraModel', 'lens') then
      continue when jsonb_typeof(v) <> 'string';
      s := btrim(regexp_replace(v #>> '{}', '[[:cntrl:]]', '', 'g'));
      continue when s = '' or length(s) > case k when 'lens' then 96 else 64 end;
      result := result || jsonb_build_object(k, s);
    elsif k = 'takenAt' then
      continue when jsonb_typeof(v) <> 'string';
      s := v #>> '{}';
      continue when length(s) > 40
        or s !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$';
      begin
        t := s::timestamptz;
      exception when others then
        continue;
      end;
      continue when t < '1826-01-01T00:00:00Z' or t > now() + interval '2 days';
      result := result || jsonb_build_object(k, s);
    end if;
  end loop;
  return result;
end;
$$;

create function public._photo_json(p public.photos) returns jsonb
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
    'hasPreview', p.has_preview
  ) || case when p.status = 'trashed'
            then jsonb_build_object('trashedAt', p.trashed_at, 'purgeAt', p.purge_after)
            else '{}'::jsonb end;
$$;

create function public._album_json(a public.albums) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', a.id,
    'name', a.name,
    'photoCount', (select count(*) from public.album_photos ap join public.photos p on p.id = ap.photo_id
                    where ap.album_id = a.id and p.status = 'ready'),
    'coverPhotoIds', coalesce((
      select jsonb_agg(x.id order by x.is_cover desc, x.added_at desc, x.id desc)
        from (select p.id, p.id = a.cover_photo_id as is_cover, ap.added_at
                from public.album_photos ap join public.photos p on p.id = ap.photo_id
               where ap.album_id = a.id and p.status = 'ready'
               order by is_cover desc, ap.added_at desc, p.id desc
               limit 3) x), '[]'::jsonb),
    'createdAt', a.created_at,
    'updatedAt', a.updated_at
  );
$$;

create function public._cursor(p_at timestamptz, p_id uuid) returns text
language sql immutable set search_path = '' as $$
  select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || p_id::text;
$$;

-- Moves the owner's photos (ready or trashed, filtered by p_ids or all trashed) to 'purging' and returns
-- [{photoId, keys}] for up to p_return of them. The rest are picked up by due_photo_purges.
create function public._start_purge(p_owner uuid, p_ids uuid[], p_return integer,
  out affected integer, out purge jsonb)
language plpgsql volatile set search_path = '' as $$
begin
  with moved as (
    update public.photos p set status = 'purging', purge_after = now()
     where p.owner_id = p_owner and p.status = 'trashed' and (p_ids is null or p.id = any (p_ids))
    returning p.id, p.owner_id, p.trashed_at
  ), numbered as (
    select m.*, row_number() over (order by m.trashed_at, m.id) rn from moved m
  )
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object('photoId', n.id, 'keys', public._photo_keys(n.owner_id, n.id)))
                    filter (where n.rn <= p_return), '[]'::jsonb)
    into affected, purge
    from numbered n;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Uploads
-- ---------------------------------------------------------------------------------------------
-- p_files: [{name, size, sha256 (hex), type (FileTypeId, from the extension)}], in request order.
-- Returns {results: UploadDecision[]} (ready decisions also carry r2Key for the Worker), or
-- {error: 'account_pending_deletion' | 'forbidden' | 'batch_too_large' | 'invalid'}.
-- Each accepted file reserves its size plus room for both variants until it completes or is aborted.
create function public.create_uploads(p_owner uuid, p_files jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c_part constant integer := 16777216;         -- UPLOAD_PART_SIZE
  c_variants constant bigint := 307200 + 1572864; -- VARIANT_LIMITS thumb + preview maxBytes
  prof record;
  rules record;
  avail bigint;
  f jsonb;
  nm text;
  ft text;
  sz bigint;
  sha bytea;
  dedupe text;
  existing uuid;
  seen jsonb := '{}'::jsonb;
  results jsonb := '[]'::jsonb;
  total bigint := 0;
  need bigint;
  v_photo uuid;
  v_upload uuid;
  v_key text;
  v_parts integer;
begin
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 then
    return jsonb_build_object('error', 'invalid');
  end if;
  perform public._lock_storage(p_owner);
  select p.plan_id, p.deleted_at, p.deletion_due, p.storage_bytes, p.reserved_bytes into prof
    from public.profiles p where p.id = p_owner for update;
  if not found or prof.deleted_at is not null then return jsonb_build_object('error', 'forbidden'); end if;
  if prof.deletion_due is not null then return jsonb_build_object('error', 'account_pending_deletion'); end if;
  select * into rules from public._plan_rules(prof.plan_id);
  if rules.batch_size is null then raise exception 'no active plan limits for %', prof.plan_id; end if;
  if jsonb_array_length(p_files) > rules.batch_size then return jsonb_build_object('error', 'batch_too_large'); end if;
  avail := rules.storage_bytes - prof.storage_bytes - prof.reserved_bytes;

  for f in select e.value from jsonb_array_elements(p_files) with ordinality e(value, i) order by e.i loop
    nm := btrim(regexp_replace(coalesce(f ->> 'name', ''), '[[:cntrl:]]', '', 'g'));
    ft := f ->> 'type';
    sz := case when jsonb_typeof(f -> 'size') = 'number' and (f ->> 'size') ~ '^\d{1,15}$'
               then (f ->> 'size')::bigint end;
    sha := case when (f ->> 'sha256') ~ '^[0-9a-f]{64}$' then decode(f ->> 'sha256', 'hex') end;
    if length(nm) not between 1 and 255 or sz is null or sz < 1 or sha is null or ft is null then
      results := results || jsonb_build_array(jsonb_build_object('status', 'rejected', 'reason', 'invalid'));
      continue;
    end if;
    if ft not in ('jpeg', 'png', 'webp', 'cr2', 'nef', 'arw') or not (ft = any (rules.file_types)) then
      results := results || jsonb_build_array(jsonb_build_object('status', 'rejected', 'reason', 'type'));
      continue;
    end if;
    if sz > rules.max_file_bytes then
      results := results || jsonb_build_array(jsonb_build_object('status', 'rejected', 'reason', 'too_large'));
      continue;
    end if;
    dedupe := encode(sha, 'hex') || ':' || sz::text;
    if seen ? dedupe then
      results := results || jsonb_build_array(jsonb_build_object('status', 'duplicate', 'photoId', seen ->> dedupe));
      continue;
    end if;
    select p.id into existing from public.photos p
     where p.owner_id = p_owner and p.sha256 = sha and p.size_bytes = sz and p.status in ('ready', 'trashed')
     limit 1;
    if found then
      seen := seen || jsonb_build_object(dedupe, existing);
      results := results || jsonb_build_array(jsonb_build_object('status', 'duplicate', 'photoId', existing));
      continue;
    end if;
    need := sz + c_variants;
    if need > avail then
      results := results || jsonb_build_array(jsonb_build_object('status', 'rejected', 'reason', 'quota'));
      continue;
    end if;
    insert into public.photos (owner_id, status, file_type, filename, size_bytes, sha256)
    values (p_owner, 'uploading', ft, nm, sz, sha) returning id into v_photo;
    v_key := public._r2_prefix(p_owner, v_photo) || 'original';
    v_parts := ((sz + c_part - 1) / c_part)::integer;
    insert into public.uploads (owner_id, photo_id, r2_key, file_type, size_bytes, part_size, part_count, reserved_bytes)
    values (p_owner, v_photo, v_key, ft, sz, c_part, v_parts, need) returning id into v_upload;
    avail := avail - need;
    total := total + need;
    seen := seen || jsonb_build_object(dedupe, v_photo);
    results := results || jsonb_build_array(jsonb_build_object(
      'status', 'ready', 'uploadId', v_upload, 'photoId', v_photo, 'partSize', c_part,
      'partCount', v_parts, 'fileType', ft, 'r2Key', v_key));
  end loop;

  update public.profiles set reserved_bytes = reserved_bytes + total where id = p_owner;
  return jsonb_build_object('results', results);
end;
$$;

-- The upload as the Worker needs it (parts, variants, R2 ids), or null if it isn't this owner's.
create function public.get_upload(p_owner uuid, p_upload uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'uploadId', u.id, 'photoId', u.photo_id, 'r2Key', u.r2_key, 'r2UploadId', u.r2_upload_id,
    'fileType', u.file_type, 'sizeBytes', u.size_bytes, 'partSize', u.part_size, 'partCount', u.part_count,
    'parts', u.parts, 'variants', u.variants, 'expiresAt', u.expires_at, 'expired', u.expires_at <= now())
  from public.uploads u where u.id = p_upload and u.owner_id = p_owner;
$$;

-- Records the R2 multipart upload id once; returns the stored id (the first writer wins, so a Worker
-- that loses the race aborts its own). Null if the upload is gone, expired or not this owner's.
create function public.set_upload_r2(p_owner uuid, p_upload uuid, p_r2_upload_id text) returns text
language sql volatile security definer set search_path = '' as $$
  update public.uploads set r2_upload_id = coalesce(r2_upload_id, p_r2_upload_id)
   where id = p_upload and owner_id = p_owner and expires_at > now()
  returning r2_upload_id;
$$;

-- Records the ETag R2 returned for part n. Null unless the upload is live, this owner's and n is in range.
create function public.record_part(p_owner uuid, p_upload uuid, p_n integer, p_etag text) returns boolean
language sql volatile security definer set search_path = '' as $$
  update public.uploads set parts = parts || jsonb_build_object(p_n::text, p_etag)
   where id = p_upload and owner_id = p_owner and expires_at > now()
     and p_n between 1 and part_count and length(p_etag) between 1 and 256
  returning true;
$$;

-- Records a stored variant's size (within VARIANT_LIMITS, which the reservation covers).
create function public.record_variant(p_owner uuid, p_upload uuid, p_kind text, p_bytes integer) returns boolean
language sql volatile security definer set search_path = '' as $$
  update public.uploads set variants = variants || jsonb_build_object(p_kind, p_bytes)
   where id = p_upload and owner_id = p_owner and expires_at > now()
     and p_kind in ('thumb', 'preview')
     and p_bytes between 1 and case p_kind when 'thumb' then 307200 else 1572864 end
  returning true;
$$;

-- Finishes an upload after the Worker completed the R2 object and checked its size. Returns
-- {status: 'ready', photo} | {status: 'duplicate', photoId} (the same file finished first in another
-- upload: this one is removed and the Worker deletes its objects) | {status: 'expired' | 'incomplete'},
-- or null if it isn't this owner's upload.
create function public.complete_upload(p_owner uuid, p_upload uuid, p_metadata jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  u public.uploads;
  p public.photos;
  md jsonb;
  existing uuid;
  v_thumb integer;
  v_preview integer;
begin
  perform public._lock_storage(p_owner);
  select * into u from public.uploads where id = p_upload and owner_id = p_owner for update;
  if not found then return null; end if;
  if u.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;
  if (select count(*) from jsonb_object_keys(u.parts)) <> u.part_count then
    return jsonb_build_object('status', 'incomplete');
  end if;
  select * into p from public.photos where id = u.photo_id for update;
  select x.id into existing from public.photos x
   where x.owner_id = p_owner and x.sha256 = p.sha256 and x.size_bytes = p.size_bytes
     and x.status in ('ready', 'trashed') and x.id <> p.id
   limit 1;
  if found then
    delete from public.photos where id = p.id; -- cascades to the upload
    update public.profiles set reserved_bytes = reserved_bytes - u.reserved_bytes where id = p_owner;
    return jsonb_build_object('status', 'duplicate', 'photoId', existing);
  end if;
  md := public._clean_metadata(p_metadata);
  v_thumb := coalesce((u.variants ->> 'thumb')::integer, 0);
  v_preview := coalesce((u.variants ->> 'preview')::integer, 0);
  update public.photos
     set status = 'ready',
         metadata = md,
         width = (md ->> 'width')::integer,
         height = (md ->> 'height')::integer,
         taken_at = (md ->> 'takenAt')::timestamptz,
         has_thumb = v_thumb > 0, thumb_bytes = v_thumb,
         has_preview = v_preview > 0, preview_bytes = v_preview
   where id = p.id
  returning * into p;
  delete from public.uploads where id = u.id;
  update public.profiles
     set reserved_bytes = reserved_bytes - u.reserved_bytes,
         storage_bytes = storage_bytes + p.size_bytes + v_thumb + v_preview
   where id = p_owner;
  return jsonb_build_object('status', 'ready', 'photo', public._photo_json(p));
end;
$$;

-- Removes an unfinished upload and releases its reservation, after the Worker aborted the R2 upload and
-- deleted any variants. Returns true, or null if it isn't this owner's upload.
create function public.abort_upload(p_owner uuid, p_upload uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare u public.uploads;
begin
  perform public._lock_storage(p_owner);
  select * into u from public.uploads where id = p_upload and owner_id = p_owner for update;
  if not found then return null; end if;
  delete from public.photos where id = u.photo_id and status = 'uploading'; -- cascades to the upload
  delete from public.uploads where id = u.id;
  update public.profiles set reserved_bytes = reserved_bytes - u.reserved_bytes where id = p_owner;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Photos
-- ---------------------------------------------------------------------------------------------
-- Keyset-paginated list: {items: PhotoItem[], nextCursor}. Null if p_album isn't this owner's.
-- view: library | favourites | raw | trash (newest trashed first). sort: taken (falls back to added) | added.
create function public.list_photos(
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

-- PhotoDetail (with metadata and albums), or null.
create function public.get_photo(p_owner uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public._photo_json(p) || jsonb_build_object(
    'metadata', p.metadata,
    'albums', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) order by a.name, a.id)
                          from public.album_photos ap join public.albums a on a.id = ap.album_id
                         where ap.photo_id = p.id and a.owner_id = p_owner), '[]'::jsonb))
  from public.photos p
  where p.id = p_id and p.owner_id = p_owner and p.status in ('ready', 'trashed');
$$;

-- What the media route needs to serve a file: {fileType, filename, hasThumb, hasPreview}, or null.
create function public.photo_file(p_owner uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('fileType', p.file_type, 'filename', p.filename, 'sizeBytes', p.size_bytes,
                            'hasThumb', p.has_thumb, 'hasPreview', p.has_preview)
  from public.photos p
  where p.id = p_id and p.owner_id = p_owner and p.status in ('ready', 'trashed');
$$;

-- Changes favourite and/or filename (null leaves it). Returns PhotoItem, or null.
create function public.patch_photo(p_owner uuid, p_id uuid, p_favourite boolean, p_filename text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.photos;
  nm text := nullif(btrim(regexp_replace(coalesce(p_filename, ''), '[[:cntrl:]]', '', 'g')), '');
begin
  if p_filename is not null and (nm is null or length(nm) > 255) then
    return jsonb_build_object('error', 'invalid');
  end if;
  update public.photos
     set favourite = coalesce(p_favourite, favourite), filename = coalesce(nm, filename)
   where id = p_id and owner_id = p_owner and status in ('ready', 'trashed')
  returning * into p;
  if not found then return null; end if;
  return public._photo_json(p);
end;
$$;

-- Bulk actions on the owner's own photos (other ids are ignored). Returns {affected} plus, for
-- delete_forever, {purge: [{photoId, keys}]}: the Worker deletes those objects, then calls
-- confirm_photo_purges. Null if p_album isn't this owner's (album actions).
create function public.bulk_photos(p_owner uuid, p_ids uuid[], p_action text, p_album uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  n integer := 0;
  r record;
begin
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 500 then
    return jsonb_build_object('error', 'invalid');
  end if;
  if p_action in ('add_to_album', 'remove_from_album')
     and not exists (select 1 from public.albums a where a.id = p_album and a.owner_id = p_owner) then
    return null;
  end if;
  case p_action
    when 'favourite', 'unfavourite' then
      update public.photos set favourite = (p_action = 'favourite')
       where owner_id = p_owner and id = any (p_ids) and status = 'ready';
      get diagnostics n = row_count;
    when 'trash' then
      update public.photos set status = 'trashed', trashed_at = now(), purge_after = now() + interval '30 days'
       where owner_id = p_owner and id = any (p_ids) and status = 'ready';
      get diagnostics n = row_count;
    when 'restore' then
      update public.photos set status = 'ready', trashed_at = null, purge_after = null
       where owner_id = p_owner and id = any (p_ids) and status = 'trashed';
      get diagnostics n = row_count;
    when 'delete_forever' then
      select * into r from public._start_purge(p_owner, p_ids, 500);
      return jsonb_build_object('affected', r.affected, 'purge', r.purge);
    when 'add_to_album' then
      insert into public.album_photos (album_id, photo_id)
      select p_album, p.id from public.photos p
       where p.owner_id = p_owner and p.id = any (p_ids) and p.status = 'ready'
      on conflict do nothing;
      get diagnostics n = row_count;
      update public.albums set updated_at = now() where id = p_album;
    when 'remove_from_album' then
      delete from public.album_photos ap
       using public.photos p
       where ap.album_id = p_album and ap.photo_id = p.id and p.owner_id = p_owner and p.id = any (p_ids);
      get diagnostics n = row_count;
      update public.albums set updated_at = now() where id = p_album;
    else
      return jsonb_build_object('error', 'invalid');
  end case;
  return jsonb_build_object('affected', n);
end;
$$;

-- Empties the owner's Trash: {deleted, purge: [{photoId, keys}] (up to 500; the clean-up job does the rest)}.
create function public.empty_trash(p_owner uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare r record;
begin
  select * into r from public._start_purge(p_owner, null, 500);
  return jsonb_build_object('deleted', r.affected, 'purge', r.purge);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Albums
-- ---------------------------------------------------------------------------------------------
create function public.list_albums(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public._album_json(a) order by a.updated_at desc, a.id desc), '[]'::jsonb)
    from public.albums a where a.owner_id = p_owner;
$$;

create function public.get_album(p_owner uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public._album_json(a) from public.albums a where a.id = p_id and a.owner_id = p_owner;
$$;

-- AlbumItem, or {error: 'invalid' | 'limit'} (1,000 albums per owner).
create function public.create_album(p_owner uuid, p_name text, p_photo_ids uuid[] default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  a public.albums;
  nm text := btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g'));
begin
  if length(nm) not between 1 and 80 or cardinality(coalesce(p_photo_ids, '{}')) > 500 then
    return jsonb_build_object('error', 'invalid');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('zephyr:albums:' || p_owner::text, 0));
  if (select count(*) from public.albums where owner_id = p_owner) >= 1000 then
    return jsonb_build_object('error', 'limit');
  end if;
  insert into public.albums (owner_id, name) values (p_owner, nm) returning * into a;
  insert into public.album_photos (album_id, photo_id)
  select a.id, p.id from public.photos p
   where p.owner_id = p_owner and p.id = any (coalesce(p_photo_ids, '{}')) and p.status = 'ready'
  on conflict do nothing;
  return public._album_json(a);
end;
$$;

-- Renames and/or sets the cover (p_cover_set: whether p_cover was sent; null clears it). The cover must
-- be a ready photo in the album. Returns AlbumItem, null if not found, or {error: 'invalid'}.
create function public.patch_album(p_owner uuid, p_id uuid, p_name text, p_cover_set boolean, p_cover uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  a public.albums;
  nm text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), '');
begin
  select * into a from public.albums where id = p_id and owner_id = p_owner for update;
  if not found then return null; end if;
  if (p_name is not null and (nm is null or length(nm) > 80))
     or (p_cover_set and p_cover is not null and not exists (
           select 1 from public.album_photos ap join public.photos p on p.id = ap.photo_id
            where ap.album_id = p_id and p.id = p_cover and p.owner_id = p_owner and p.status = 'ready')) then
    return jsonb_build_object('error', 'invalid');
  end if;
  update public.albums
     set name = coalesce(nm, name),
         cover_photo_id = case when p_cover_set then p_cover else cover_photo_id end,
         updated_at = now()
   where id = p_id
  returning * into a;
  return public._album_json(a);
end;
$$;

-- Deletes the album only (never its photos). True, or null if not found.
create function public.delete_album(p_owner uuid, p_id uuid) returns boolean
language sql volatile security definer set search_path = '' as $$
  delete from public.albums where id = p_id and owner_id = p_owner returning true;
$$;

-- ---------------------------------------------------------------------------------------------
-- Usage and account deletion
-- ---------------------------------------------------------------------------------------------
create function public.get_usage(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'usedBytes', pr.storage_bytes,
    'reservedBytes', pr.reserved_bytes,
    'limitBytes', r.storage_bytes,
    'trashBytes', (select coalesce(sum(p.size_bytes + p.thumb_bytes + p.preview_bytes), 0) from public.photos p
                    where p.owner_id = p_owner and p.status in ('trashed', 'purging')),
    'photoCount', (select count(*) from public.photos p where p.owner_id = p_owner and p.status = 'ready'),
    'plan', pr.plan_id,
    'fileTypes', to_jsonb(r.file_types),
    'maxFileBytes', r.max_file_bytes,
    'batchSize', r.batch_size)
  from public.profiles pr cross join lateral public._plan_rules(pr.plan_id) r
  where pr.id = p_owner;
$$;

-- Schedules the account's deletion (idempotent: a second request keeps the first date). Returns the
-- purge time, or null if there's no live profile.
create function public.request_account_deletion(p_owner uuid) returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare due timestamptz;
begin
  update public.profiles
     set deletion_requested_at = coalesce(deletion_requested_at, now()),
         deletion_due = coalesce(deletion_due, now() + interval '30 days')
   where id = p_owner and deleted_at is null
  returning deletion_due into due;
  if due is not null then
    perform public._audit(p_owner, 'account.deletion_requested', null, '{}'::jsonb);
  end if;
  return due;
end;
$$;

-- Cancels a scheduled deletion that hasn't run yet. True, or null if there's nothing to restore.
create function public.restore_account(p_owner uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.profiles set deletion_requested_at = null, deletion_due = null
   where id = p_owner and deletion_due > now();
  if not found then return null; end if;
  perform public._audit(p_owner, 'account.restored', null, '{}'::jsonb);
  return true;
end;
$$;

-- The session profile now also says whether the account is scheduled for deletion.
create or replace function public.get_session_profile(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'isStaff', exists (select 1 from public.staff s where s.user_id = p_user_id),
    'displayName', p.display_name,
    'plan', coalesce(p.plan_id, 'free'),
    'createdAt', p.created_at,
    'deleted', p.deleted_at is not null,
    'deletionDue', p.deletion_due
  )
  from public.profiles p where p.id = p_user_id;
$$;

-- ---------------------------------------------------------------------------------------------
-- Clean-up jobs (the Worker's Cron Trigger). Each due_* returns bounded work; the matching confirm_*
-- runs only after the R2 deletes succeeded.
-- ---------------------------------------------------------------------------------------------
-- Uploads past expires_at: [{uploadId, r2Key, r2UploadId, keys}] (keys: original and variants).
create function public.due_expired_uploads(p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'uploadId', x.id, 'r2Key', x.r2_key, 'r2UploadId', x.r2_upload_id,
           'keys', public._photo_keys(x.owner_id, x.photo_id)) order by x.expires_at), '[]'::jsonb)
    from (select u.* from public.uploads u where u.expires_at <= now()
           order by u.expires_at limit least(greatest(coalesce(p_limit, 100), 1), 500)) x;
$$;

create function public.confirm_expired_uploads(p_ids uuid[]) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  o uuid;
  released bigint;
  k integer;
  n integer := 0;
begin
  for o in select distinct u.owner_id from public.uploads u where u.id = any (p_ids) order by 1 loop
    perform public._lock_storage(o);
    with d as (
      delete from public.uploads u where u.id = any (p_ids) and u.owner_id = o and u.expires_at <= now()
      returning u.photo_id, u.reserved_bytes
    ), gone as (
      delete from public.photos p where p.id in (select d.photo_id from d) and p.status = 'uploading'
    )
    select coalesce(sum(d.reserved_bytes), 0), count(*) into released, k from d;
    update public.profiles set reserved_bytes = reserved_bytes - released where id = o;
    n := n + k;
  end loop;
  return n;
end;
$$;

-- Photos to purge: moves Trash items past purge_after to 'purging' (so they can no longer be restored)
-- and returns up to p_limit purging photos as [{photoId, keys}].
create function public.due_photo_purges(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare lim integer := least(greatest(coalesce(p_limit, 100), 1), 1000);
begin
  update public.photos set status = 'purging'
   where id in (select p.id from public.photos p where p.status = 'trashed' and p.purge_after <= now()
                 order by p.purge_after limit lim);
  return (select coalesce(jsonb_agg(jsonb_build_object('photoId', x.id, 'keys', public._photo_keys(x.owner_id, x.id))
                                    order by x.purge_after), '[]'::jsonb)
            from (select p.id, p.owner_id, p.purge_after from public.photos p where p.status = 'purging'
                   order by p.purge_after limit lim) x);
end;
$$;

-- Removes purged photos (their objects are gone) and their usage. Returns how many.
create function public.confirm_photo_purges(p_ids uuid[]) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  o uuid;
  freed bigint;
  k integer;
  n integer := 0;
begin
  for o in select distinct p.owner_id from public.photos p where p.id = any (p_ids) order by 1 loop
    perform public._lock_storage(o);
    with d as (
      delete from public.photos p where p.id = any (p_ids) and p.owner_id = o and p.status = 'purging'
      returning p.size_bytes + p.thumb_bytes + p.preview_bytes as bytes
    )
    select coalesce(sum(d.bytes), 0), count(*) into freed, k from d;
    update public.profiles set storage_bytes = storage_bytes - freed where id = o;
    n := n + k;
  end loop;
  return n;
end;
$$;

-- Accounts whose deletion is due: [{ownerId, prefix, uploads: [{r2Key, r2UploadId}]}]. The Worker aborts
-- the open multipart uploads, deletes every object under the prefix (over several runs if needed), then
-- the Auth user, which cascades to the profile, photos, uploads and albums.
create function public.due_account_purges(p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'ownerId', x.id,
           'prefix', 'u/' || x.id::text || '/',
           'uploads', coalesce((select jsonb_agg(jsonb_build_object('r2Key', u.r2_key, 'r2UploadId', u.r2_upload_id))
                                  from public.uploads u where u.owner_id = x.id and u.r2_upload_id is not null), '[]'::jsonb))
         order by x.deletion_due), '[]'::jsonb)
    from (select p.id, p.deletion_due from public.profiles p
           where p.deletion_due <= now()
             and not exists (select 1 from public.staff s where s.user_id = p.id)
           order by p.deletion_due limit least(greatest(coalesce(p_limit, 10), 1), 100)) x;
$$;

-- Old rate-limit rows (pg_cron's daily purge does the same; this is idempotent).
create function public.purge_rate_limits() returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.rate_limit_attempts where created_at < now() - interval '2 days';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- One audit row per clean-up run that did something. Counts only: no ids, emails or keys.
create function public.record_cleanup(p_details jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare k text;
begin
  if p_details is null or jsonb_typeof(p_details) <> 'object' then return; end if;
  for k in select jsonb_object_keys(p_details) loop
    if k not in ('uploadsAborted', 'photosPurged', 'accountsPurged', 'objectsDeleted', 'rateLimitRows')
       or jsonb_typeof(p_details -> k) <> 'number' then
      raise exception 'bad cleanup details' using errcode = 'invalid_parameter_value';
    end if;
  end loop;
  perform public._audit(null, 'jobs.cleanup', null, p_details);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: service_role only. Internal helpers (_*) are callable by no role but their owner.
-- ---------------------------------------------------------------------------------------------
revoke all on public.photos, public.uploads, public.albums, public.album_photos from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on function
  public._album_photo_same_owner(),
  public._album_cover_same_owner(),
  public._lock_storage(uuid),
  public._plan_rules(text),
  public._r2_prefix(uuid, uuid),
  public._photo_keys(uuid, uuid),
  public._clean_metadata(jsonb),
  public._photo_json(public.photos),
  public._album_json(public.albums),
  public._cursor(timestamptz, uuid),
  public._start_purge(uuid, uuid[], integer)
from service_role;
grant execute on function
  public.create_uploads(uuid, jsonb),
  public.get_upload(uuid, uuid),
  public.set_upload_r2(uuid, uuid, text),
  public.record_part(uuid, uuid, integer, text),
  public.record_variant(uuid, uuid, text, integer),
  public.complete_upload(uuid, uuid, jsonb),
  public.abort_upload(uuid, uuid),
  public.list_photos(uuid, text, uuid, text, date, date, text, text, integer),
  public.get_photo(uuid, uuid),
  public.photo_file(uuid, uuid),
  public.patch_photo(uuid, uuid, boolean, text),
  public.bulk_photos(uuid, uuid[], text, uuid),
  public.empty_trash(uuid),
  public.list_albums(uuid),
  public.get_album(uuid, uuid),
  public.create_album(uuid, text, uuid[]),
  public.patch_album(uuid, uuid, text, boolean, uuid),
  public.delete_album(uuid, uuid),
  public.get_usage(uuid),
  public.request_account_deletion(uuid),
  public.restore_account(uuid),
  public.get_session_profile(uuid),
  public.due_expired_uploads(integer),
  public.confirm_expired_uploads(uuid[]),
  public.due_photo_purges(integer),
  public.confirm_photo_purges(uuid[]),
  public.due_account_purges(integer),
  public.purge_rate_limits(),
  public.record_cleanup(jsonb)
to service_role;
