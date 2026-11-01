-- Phase 5: sharing. Private gallery links with an optional 6-digit passcode, guest renditions made on the
-- server, guest favourites, members' branding and the access log. See docs/phase-5.md.
--
-- Every entry point is security definer and callable only by service_role (the API Worker). Member
-- functions take the owner id the API read from the verified session and filter by it. Guest functions
-- take the SHA-256 of the link token (the token itself is never stored) or a gallery id the Worker got from
-- that lookup, and check the gallery's state in the same statement.
--
-- Objects:
--   zephyr-shared (R2, served only through the API Worker via the media host):
--     o/<owner>/g/<gallery>/<photo>/<size>-<32 hex>   guest renditions (grid, view, full)
--     o/<owner>/b/<logo|watermark>-<32 hex>            branding assets
--   zephyr-photos:
--     u/<owner>/g/<gallery>/<photo>/full-<version>-<32 hex>   full-size JPEGs rendered on the member's device
-- Every row that records one of these objects queues the object for deletion when the row goes or its key
-- changes (share_object_deletions, drained by the clean-up job), so no path (revoke, removal, photo purge,
-- account purge, cascade) can leave an object nothing deletes.
--
-- Usage invariant (extends the editor one; tested in supabase/tests/50_sharing_test.sql):
--   profiles.storage_bytes = … (photos and edits, as before)
--                          + Σ gallery_renditions.bytes + Σ gallery_renders.bytes
--                          + branding.logo_bytes + branding.wm_bytes
-- Share bytes are kept in step by triggers on those tables (insert, update, delete, cascades included);
-- functions that add bytes take the owner's storage lock first and check the plan's storage there.

-- ---------------------------------------------------------------------------------------------
-- Plan limits (Admin-editable, Option 1) and new columns on existing tables
-- ---------------------------------------------------------------------------------------------
alter table public.plan_limits
  add column guest_favourites boolean not null default false,
  add column watermark boolean not null default false,
  add column access_log boolean not null default false;
-- Values match packages/shared/src/plans.ts: the Studio extras.
update public.plan_limits set guest_favourites = true, watermark = true, access_log = true where plan_id = 'studio';

-- A photo Cloudflare's CSAM Scanning Tool matched: held (never served, shared, trashed or purged) until
-- staff review it. The account's sharing is suspended at the same time.
alter table public.photos add column safety_hold_at timestamptz;
alter table public.profiles add column sharing_suspended_at timestamptz;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table public.galleries (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  message text check (message is null or length(message) <= 500),
  -- SHA-256 of the 256-bit link token. The token itself is shown once and never stored.
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  link_hint text not null check (length(link_hint) between 1 and 16),
  -- The token encrypted with AES-256-GCM (Worker secret GALLERY_LINK_KEY, gallery id as AAD), so the owner
  -- can copy the link again. A database leak alone reveals neither links nor tokens.
  link_ciphertext bytea not null check (octet_length(link_ciphertext) between 16 and 256),
  link_iv bytea not null check (octet_length(link_iv) = 12),
  -- HMAC-SHA256(GALLERY_PEPPER, id|generation|code); null = no passcode.
  passcode_hmac bytea check (passcode_hmac is null or octet_length(passcode_hmac) = 32),
  -- Bumped by every passcode change: ends every unlocked guest session and every signed media URL.
  passcode_generation integer not null default 1 check (passcode_generation >= 1),
  downloads text not null check (downloads in ('none', 'web', 'full')),
  x_favourites boolean not null default false,
  x_watermark boolean not null default false,
  x_branding boolean not null default false,
  x_access_log boolean not null default false,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  paused_until timestamptz,
  views integer not null default 0 check (views >= 0),
  download_count integer not null default 0 check (download_count >= 0),
  reminder_sent_at timestamptz,
  favourites_notified_at timestamptz,
  -- Set once the job removed an ended gallery's renditions (a day after it ended).
  renditions_purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.galleries enable row level security;
create index galleries_owner on public.galleries (owner_id, created_at desc);
create index galleries_expiry on public.galleries (expires_at) where revoked_at is null;

create table public.gallery_photos (
  gallery_id uuid not null references public.galleries (id) on delete cascade,
  photo_id uuid not null references public.photos (id) on delete cascade,
  position integer not null check (position >= 0),
  primary key (gallery_id, photo_id)
);
alter table public.gallery_photos enable row level security;
create index gallery_photos_order on public.gallery_photos (gallery_id, position, photo_id);
create index gallery_photos_photo on public.gallery_photos (photo_id);

-- A guest rendition stored in zephyr-shared: the source's edit version and the watermark version it was
-- made from (0 = unedited / no watermark), and its measured size.
create table public.gallery_renditions (
  gallery_id uuid not null references public.galleries (id) on delete cascade,
  photo_id uuid not null references public.photos (id) on delete cascade,
  size text not null check (size in ('grid', 'view', 'full')),
  owner_id uuid not null,
  key text not null unique,
  bytes bigint not null check (bytes between 1 and 104857600),
  edit_version integer not null check (edit_version >= 0),
  wm_version integer not null check (wm_version >= 0),
  created_at timestamptz not null default now(),
  primary key (gallery_id, photo_id, size)
);
alter table public.gallery_renditions enable row level security;

-- A full-size JPEG the member's device rendered for an edited or RAW photo (zephyr-photos).
create table public.gallery_renders (
  gallery_id uuid not null references public.galleries (id) on delete cascade,
  photo_id uuid not null references public.photos (id) on delete cascade,
  owner_id uuid not null,
  edit_version integer not null check (edit_version >= 0),
  key text not null unique,
  bytes bigint not null check (bytes between 1 and 67108864),
  created_at timestamptz not null default now(),
  primary key (gallery_id, photo_id)
);
alter table public.gallery_renders enable row level security;

-- A browser that favourited photos (random cookie; only its HMAC is stored).
create table public.gallery_guests (
  id uuid primary key default gen_random_uuid(),
  gallery_id uuid not null references public.galleries (id) on delete cascade,
  cookie_hash bytea not null check (octet_length(cookie_hash) = 32),
  name text check (name is null or length(name) between 1 and 60),
  note text check (note is null or length(note) <= 1000),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (gallery_id, cookie_hash)
);
alter table public.gallery_guests enable row level security;

create table public.gallery_favourites (
  guest_id uuid not null references public.gallery_guests (id) on delete cascade,
  gallery_id uuid not null,
  photo_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (guest_id, photo_id),
  foreign key (gallery_id, photo_id) references public.gallery_photos (gallery_id, photo_id) on delete cascade
);
alter table public.gallery_favourites enable row level security;
create index gallery_favourites_gallery on public.gallery_favourites (gallery_id, photo_id);

-- Passcode attempts not (yet) confirmed correct. The network is an HMAC (never an IP), deleted after 2 days.
create table public.gallery_attempts (
  id bigint generated always as identity primary key,
  gallery_id uuid not null references public.galleries (id) on delete cascade,
  network_hash bytea not null check (octet_length(network_hash) = 32),
  created_at timestamptz not null default now()
);
alter table public.gallery_attempts enable row level security;
create index gallery_attempts_window on public.gallery_attempts (gallery_id, created_at);

-- The access log (Studio) and the counters every plan sees. Place and device are coarse (no IPs).
create table public.gallery_events (
  id bigint generated always as identity primary key,
  gallery_id uuid not null references public.galleries (id) on delete cascade,
  kind text not null check (kind in ('opened', 'unlocked', 'downloaded', 'favourites_sent', 'wrong_passcode',
                                     'paused', 'passcode_changed', 'created', 'revoked')),
  place text check (place is null or length(place) <= 120),
  device text check (device is null or length(device) <= 60),
  count integer not null default 1 check (count between 1 and 10000),
  created_at timestamptz not null default now()
);
alter table public.gallery_events enable row level security;
create index gallery_events_gallery on public.gallery_events (gallery_id, id desc);

create table public.branding (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  studio_name text check (studio_name is null or length(studio_name) between 1 and 60),
  accent text check (accent is null or accent in ('#2D5FD3', '#1F7A4D', '#A0461C', '#7A3940', '#0D1117', '#6B4FC8', '#0E6B78', '#8A5A00')),
  logo_key text unique,
  logo_bytes bigint not null default 0 check (logo_bytes between 0 and 2097152),
  wm_kind text not null default 'text' check (wm_kind in ('text', 'logo')),
  wm_text text check (wm_text is null or length(wm_text) between 1 and 60),
  wm_position text not null default 'bottom-right' check (wm_position in ('bottom-right', 'bottom-left', 'centre', 'tiled')),
  wm_opacity integer not null default 70 check (wm_opacity between 10 and 90),
  wm_key text unique,
  wm_bytes bigint not null default 0 check (wm_bytes between 0 and 2097152),
  -- Bumped whenever the watermark changes, so renditions made with the old one are replaced.
  wm_version integer not null default 1 check (wm_version >= 1),
  updated_at timestamptz not null default now(),
  constraint branding_logo_pair check ((logo_key is null) = (logo_bytes = 0)),
  constraint branding_wm_pair check ((wm_key is null) = (wm_bytes = 0))
);
alter table public.branding enable row level security;

-- Guests' abuse reports (Admin › Safety reviews them in phase 8). The network is an HMAC, never an IP.
create table public.gallery_reports (
  id uuid primary key default gen_random_uuid(),
  gallery_id uuid references public.galleries (id) on delete set null,
  owner_id uuid,
  photo_id uuid,
  reason text not null check (reason in ('csam', 'violence', 'copyright', 'privacy', 'other')),
  details text check (details is null or length(details) <= 1000),
  network_hash bytea not null check (octet_length(network_hash) = 32),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
alter table public.gallery_reports enable row level security;
create index gallery_reports_open on public.gallery_reports (created_at) where reviewed_at is null;
create index gallery_reports_network on public.gallery_reports (network_hash, created_at);

-- R2 objects (or prefixes) to delete, queued by the triggers below and drained by the clean-up job.
create table public.share_object_deletions (
  id bigint generated always as identity primary key,
  bucket text not null check (bucket in ('shared', 'photos')),
  key text not null check (length(key) between 1 and 512),
  is_prefix boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.share_object_deletions enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------------------------
-- A gallery only ever holds its owner's photos.
create function public._gallery_photo_same_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.galleries g join public.photos p on p.owner_id = g.owner_id
                  where g.id = new.gallery_id and p.id = new.photo_id) then
    raise exception 'gallery and photo belong to different owners' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger gallery_photos_same_owner before insert or update on public.gallery_photos
  for each row execute function public._gallery_photo_same_owner();

-- A photo leaving a gallery (removed, held, purged, or the gallery deleted) takes its renditions and its
-- full-size render with it; their bytes and objects follow through the triggers below.
create function public._gallery_photo_removed() returns trigger
language plpgsql set search_path = '' as $$
begin
  delete from public.gallery_renditions where gallery_id = old.gallery_id and photo_id = old.photo_id;
  delete from public.gallery_renders where gallery_id = old.gallery_id and photo_id = old.photo_id;
  return old;
end;
$$;
create trigger gallery_photos_removed after delete on public.gallery_photos
  for each row execute function public._gallery_photo_removed();

-- Share bytes follow their rows, whatever deletes them (cascades from photo purges and account deletion
-- included), and a recorded object is queued for deletion when its row goes or its key is replaced.
create function public._share_bytes() returns trigger
language plpgsql set search_path = '' as $$
declare
  bucket text := case tg_table_name when 'gallery_renders' then 'photos' else 'shared' end;
begin
  if tg_op = 'INSERT' then
    update public.profiles set storage_bytes = storage_bytes + new.bytes where id = new.owner_id;
    return new;
  elsif tg_op = 'UPDATE' then
    if new.owner_id <> old.owner_id then
      raise exception 'share rows keep their owner' using errcode = 'check_violation';
    end if;
    update public.profiles set storage_bytes = storage_bytes + new.bytes - old.bytes where id = new.owner_id;
    if new.key <> old.key then
      insert into public.share_object_deletions (bucket, key) values (bucket, old.key);
    end if;
    return new;
  else
    update public.profiles set storage_bytes = storage_bytes - old.bytes where id = old.owner_id;
    insert into public.share_object_deletions (bucket, key) values (bucket, old.key);
    return old;
  end if;
end;
$$;
create trigger gallery_renditions_bytes after insert or update or delete on public.gallery_renditions
  for each row execute function public._share_bytes();
create trigger gallery_renders_bytes after insert or update or delete on public.gallery_renders
  for each row execute function public._share_bytes();

create function public._branding_bytes() returns trigger
language plpgsql set search_path = '' as $$
declare
  o uuid := coalesce(new.owner_id, old.owner_id);
  before_bytes bigint := case when tg_op = 'INSERT' then 0 else old.logo_bytes + old.wm_bytes end;
  after_bytes bigint := case when tg_op = 'DELETE' then 0 else new.logo_bytes + new.wm_bytes end;
begin
  update public.profiles set storage_bytes = storage_bytes + after_bytes - before_bytes where id = o;
  if tg_op <> 'INSERT' then
    if old.logo_key is not null and (tg_op = 'DELETE' or new.logo_key is distinct from old.logo_key) then
      insert into public.share_object_deletions (bucket, key) values ('shared', old.logo_key);
    end if;
    if old.wm_key is not null and (tg_op = 'DELETE' or new.wm_key is distinct from old.wm_key) then
      insert into public.share_object_deletions (bucket, key) values ('shared', old.wm_key);
    end if;
  end if;
  return coalesce(new, old);
end;
$$;
create trigger branding_bytes after insert or update or delete on public.branding
  for each row execute function public._branding_bytes();

-- A held photo can't be trashed, purged or deleted, by any path: the change is skipped for that row.
create function public._safety_hold_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.safety_hold_at is not null then
    if tg_op = 'DELETE' then return null; end if;
    if new.status is distinct from old.status and new.status in ('trashed', 'purging') then return null; end if;
    if new.safety_hold_at is null then
      raise exception 'a safety hold is lifted by staff review only' using errcode = 'check_violation';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;
create trigger photos_safety_hold before update or delete on public.photos
  for each row execute function public._safety_hold_guard();

-- ---------------------------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------------------------
-- The plan's sharing limits from the active plan-limits version.
create function public._share_rules(p_plan text,
  out galleries integer, out max_link_days integer, out guest_full_res boolean, out guest_favourites boolean,
  out watermark boolean, out branding boolean, out access_log boolean, out storage_bytes bigint)
language sql stable set search_path = '' as $$
  select pl.galleries, pl.max_link_days, pl.guest_full_res, pl.guest_favourites, pl.watermark, pl.branding,
         pl.access_log, pl.storage_gb::bigint * 1073741824
    from public.plan_limits pl
    join public.plan_limit_versions v on v.id = pl.version_id and v.status = 'active'
   where pl.plan_id = p_plan;
$$;

-- 'revoked' | 'expired' | 'paused' | 'live' (as the member sees it).
create function public._gallery_status(g public.galleries) returns text
language sql stable set search_path = '' as $$
  select case when g.revoked_at is not null then 'revoked'
              when g.expires_at <= now() then 'expired'
              when g.paused_until > now() then 'paused'
              else 'live' end;
$$;

-- True while guests may use the gallery: not revoked or expired, and the owner can share (not suspended,
-- not deleted or scheduled for deletion). Paused galleries still serve guests who already unlocked.
create function public._gallery_serving(g public.galleries) returns boolean
language sql stable set search_path = '' as $$
  select g.revoked_at is null and g.expires_at > now()
     and exists (select 1 from public.profiles pr where pr.id = g.owner_id and pr.sharing_suspended_at is null
                   and pr.deleted_at is null and pr.deletion_due is null);
$$;

-- The extras and downloads in force: the gallery's choice, limited by the owner's current plan (a
-- downgrade turns features off without touching the gallery).
create function public._gallery_effective(g public.galleries,
  out downloads text, out favourites boolean, out watermark boolean, out branding boolean, out access_log boolean)
language sql stable set search_path = '' as $$
  select case when g.downloads = 'full' and not r.guest_full_res then 'web' else g.downloads end,
         g.x_favourites and r.guest_favourites, g.x_watermark and r.watermark, g.x_branding and r.branding,
         g.x_access_log and r.access_log
    from public.profiles pr cross join lateral public._share_rules(pr.plan_id) r
   where pr.id = g.owner_id;
$$;

-- An edit that changes the photo (phase 4: a neutral recipe counts as unedited).
create function public._photo_edit_version(p_photo uuid) returns integer
language sql stable set search_path = '' as $$
  select e.version from public.photo_edits e where e.photo_id = p_photo and not public._recipe_empty(e.recipe);
$$;

-- Ready, not held: what a gallery may show.
create function public._photo_shareable(p public.photos) returns boolean
language sql immutable set search_path = '' as $$
  select p.status = 'ready' and p.safety_hold_at is null;
$$;

-- A key this database would accept for a share object: the canonical prefix (from the uuids' own text) and
-- a 32-hex nonce. p_kind: grid | view | full (renditions), render (device full render), logo | watermark.
create function public._share_key_ok(p_owner uuid, p_gallery uuid, p_photo uuid, p_kind text, p_version integer, p_key text)
returns boolean
language sql immutable set search_path = '' as $$
  select p_key is not null and p_key ~ (
    '^' || case p_kind
      when 'render' then 'u/' || p_owner::text || '/g/' || p_gallery::text || '/' || p_photo::text || '/full-' || p_version::text || '-'
      when 'logo' then 'o/' || p_owner::text || '/b/logo-'
      when 'watermark' then 'o/' || p_owner::text || '/b/watermark-'
      else 'o/' || p_owner::text || '/g/' || p_gallery::text || '/' || p_photo::text || '/' || p_kind || '-'
    end || '[0-9a-f]{32}$');
$$;

create function public._gallery_summary(g public.galleries) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', g.id,
    'name', g.name,
    'status', public._gallery_status(g),
    'photoCount', (select count(*) from public.gallery_photos gp join public.photos p on p.id = gp.photo_id
                    where gp.gallery_id = g.id and public._photo_shareable(p)),
    'coverPhotoId', (select gp.photo_id from public.gallery_photos gp join public.photos p on p.id = gp.photo_id
                      where gp.gallery_id = g.id and public._photo_shareable(p) order by gp.position, gp.photo_id limit 1),
    'passcode', g.passcode_hmac is not null,
    'downloads', g.downloads,
    'expiresAt', g.expires_at,
    'pausedUntil', case when g.paused_until > now() then g.paused_until end,
    'views', g.views,
    'favourites', (select count(*) from public.gallery_favourites f where f.gallery_id = g.id),
    'createdAt', g.created_at);
$$;

-- Photos waiting for a full-size render from the member's device: full downloads in force, and the photo
-- is edited or RAW, without a render of its current edit version.
create function public._pending_renders(g public.galleries) returns table (photo_id uuid, edit_version integer)
language sql stable set search_path = '' as $$
  select p.id, coalesce(public._photo_edit_version(p.id), 0)
    from public.gallery_photos gp join public.photos p on p.id = gp.photo_id
   where gp.gallery_id = g.id and public._photo_shareable(p)
     and (select e.downloads from public._gallery_effective(g) e) = 'full'
     and (public._photo_edit_version(p.id) is not null or p.file_type in ('cr2', 'nef', 'arw'))
     and not exists (select 1 from public.gallery_renders r where r.gallery_id = g.id and r.photo_id = p.id
                       and r.edit_version = coalesce(public._photo_edit_version(p.id), 0))
   order by gp.position, p.id;
$$;

create function public._gallery_detail(g public.galleries) returns jsonb
language sql stable set search_path = '' as $$
  select public._gallery_summary(g) || jsonb_build_object(
    'message', g.message,
    'extras', jsonb_build_object('favourites', g.x_favourites, 'watermark', g.x_watermark,
                                 'branding', g.x_branding, 'accessLog', g.x_access_log),
    'linkHint', g.link_hint,
    'pendingRenders', (select count(*) from public._pending_renders(g)),
    'revokedAt', g.revoked_at);
$$;

create function public._branding_json(b public.branding) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'studioName', b.studio_name,
    'accent', b.accent,
    'hasLogo', b.logo_key is not null,
    'watermark', jsonb_build_object('kind', coalesce(b.wm_kind, 'text'), 'text', b.wm_text,
                                    'position', coalesce(b.wm_position, 'bottom-right'),
                                    'opacity', coalesce(b.wm_opacity, 70), 'hasImage', b.wm_key is not null),
    'updatedAt', b.updated_at);
$$;

-- Validates and caps an expiry date: end of that day (UTC), not in the past, within the plan's
-- max_link_days and the 365-day system ceiling. Null when out of range.
create function public._gallery_expiry(p_plan text, p_on date) returns timestamptz
language sql stable set search_path = '' as $$
  select case when p_on is null or p_on < (now() at time zone 'utc')::date
                or p_on > (now() at time zone 'utc')::date + least(coalesce(r.max_link_days, 365), 365)
              then null
              else (p_on + 1)::timestamp at time zone 'utc' end
    from public._share_rules(p_plan) r;
$$;

-- An access-log row (only when the gallery's access log is in force) plus the counters every plan sees.
create function public._gallery_log(p_gallery uuid, p_kind text, p_place text, p_device text, p_count integer)
returns void
language plpgsql volatile set search_path = '' as $$
declare g public.galleries;
begin
  select * into g from public.galleries where id = p_gallery;
  if not found then return; end if;
  if p_kind = 'opened' then update public.galleries set views = views + 1 where id = p_gallery; end if;
  if p_kind = 'downloaded' then
    update public.galleries set download_count = download_count + greatest(coalesce(p_count, 1), 1) where id = p_gallery;
  end if;
  if (select e.access_log from public._gallery_effective(g) e) then
    insert into public.gallery_events (gallery_id, kind, place, device, count)
    values (p_gallery, p_kind, left(p_place, 120), left(p_device, 60), least(greatest(coalesce(p_count, 1), 1), 10000));
  end if;
end;
$$;

create function public._owner_email(p_owner uuid) returns text
language sql stable set search_path = '' as $$
  select u.email::text from auth.users u where u.id = p_owner;
$$;

-- ---------------------------------------------------------------------------------------------
-- Galleries (member)
-- ---------------------------------------------------------------------------------------------
-- Creates a gallery of the owner's shareable photos among p_photo_ids (others are ignored; order kept).
-- p_id and p_passcode_hmac come from the Worker (it needs the id to make the HMAC). Returns
-- {gallery: GalleryDetail} or {error: 'suspended' | 'limit' | 'plan' | 'expiry' | 'no_photos' | 'invalid'}.
create function public.create_gallery(p_owner uuid, p_id uuid, p_token_hash bytea, p_link_hint text,
  p_link_ciphertext bytea, p_link_iv bytea, p_passcode_hmac bytea, p_name text, p_message text, p_photo_ids uuid[], p_expires_on date, p_downloads text,
  p_extras jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  prof record;
  r record;
  live integer;
  exp timestamptz;
  g public.galleries;
  n integer;
begin
  if p_photo_ids is null or cardinality(p_photo_ids) > 2000 or p_downloads not in ('none', 'web', 'full')
     or p_name is null or length(p_name) not between 1 and 80 or coalesce(length(p_message), 0) > 500
     or p_token_hash is null or octet_length(p_token_hash) <> 32 then
    return jsonb_build_object('error', 'invalid');
  end if;
  -- One owner's gallery count changes one at a time.
  perform pg_advisory_xact_lock(hashtextextended('zephyr:galleries:' || p_owner::text, 0));
  select pr.plan_id, pr.sharing_suspended_at, pr.deletion_due, pr.deleted_at into prof
    from public.profiles pr where pr.id = p_owner;
  if not found or prof.deleted_at is not null or prof.deletion_due is not null then
    return jsonb_build_object('error', 'invalid');
  end if;
  if prof.sharing_suspended_at is not null then return jsonb_build_object('error', 'suspended'); end if;
  select * into r from public._share_rules(prof.plan_id);
  if (p_downloads = 'full' and not r.guest_full_res)
     or (coalesce((p_extras ->> 'favourites')::boolean, false) and not r.guest_favourites)
     or (coalesce((p_extras ->> 'watermark')::boolean, false) and not r.watermark)
     or (coalesce((p_extras ->> 'branding')::boolean, false) and not r.branding)
     or (coalesce((p_extras ->> 'accessLog')::boolean, false) and not r.access_log) then
    return jsonb_build_object('error', 'plan');
  end if;
  exp := public._gallery_expiry(prof.plan_id, p_expires_on);
  if exp is null then return jsonb_build_object('error', 'expiry'); end if;
  if r.galleries is not null then
    select count(*) into live from public.galleries g2
     where g2.owner_id = p_owner and g2.revoked_at is null and g2.expires_at > now();
    if live >= r.galleries then return jsonb_build_object('error', 'limit'); end if;
  end if;
  insert into public.galleries (id, owner_id, name, message, token_hash, link_hint, link_ciphertext, link_iv,
                                passcode_hmac, downloads, x_favourites, x_watermark, x_branding, x_access_log, expires_at)
  values (p_id, p_owner, p_name, nullif(p_message, ''), p_token_hash, p_link_hint, p_link_ciphertext, p_link_iv,
          p_passcode_hmac, p_downloads,
          coalesce((p_extras ->> 'favourites')::boolean, false), coalesce((p_extras ->> 'watermark')::boolean, false),
          coalesce((p_extras ->> 'branding')::boolean, false), coalesce((p_extras ->> 'accessLog')::boolean, false), exp)
  returning * into g;
  insert into public.gallery_photos (gallery_id, photo_id, position)
  select g.id, x.id, (row_number() over (order by x.ord) - 1)::integer
    from (select distinct on (u.id) u.id, u.ord from unnest(p_photo_ids) with ordinality u(id, ord) order by u.id, u.ord) x
    join public.photos p on p.id = x.id and p.owner_id = p_owner and public._photo_shareable(p);
  get diagnostics n = row_count;
  if n = 0 then
    delete from public.galleries where id = g.id;
    return jsonb_build_object('error', 'no_photos');
  end if;
  perform public._gallery_log(g.id, 'created', null, null, 1);
  return jsonb_build_object('gallery', public._gallery_detail(g));
end;
$$;

create function public.list_galleries(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public._gallery_summary(g) order by g.created_at desc, g.id), '[]'::jsonb)
    from public.galleries g where g.owner_id = p_owner;
$$;

create function public.get_gallery(p_owner uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public._gallery_detail(g) from public.galleries g where g.id = p_id and g.owner_id = p_owner;
$$;

-- p_patch: GalleryPatchBody (validated by the Worker). Returns {gallery} or {error: 'ended' | 'plan' |
-- 'expiry' | 'suspended'}, or null if not the owner's gallery. Revoked galleries can't change; an expired
-- one can be given a new expiry date.
create function public.patch_gallery(p_owner uuid, p_id uuid, p_patch jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  g public.galleries;
  prof record;
  r record;
  exp timestamptz;
  x jsonb := coalesce(p_patch -> 'extras', '{}'::jsonb);
begin
  perform public._lock_storage(p_owner);
  select * into g from public.galleries where id = p_id and owner_id = p_owner for update;
  if not found then return null; end if;
  if g.revoked_at is not null then return jsonb_build_object('error', 'ended'); end if;
  select pr.plan_id, pr.sharing_suspended_at into prof from public.profiles pr where pr.id = p_owner;
  if prof.sharing_suspended_at is not null then return jsonb_build_object('error', 'suspended'); end if;
  select * into r from public._share_rules(prof.plan_id);
  if (p_patch ->> 'downloads' = 'full' and not r.guest_full_res)
     or (coalesce((x ->> 'favourites')::boolean, false) and not r.guest_favourites)
     or (coalesce((x ->> 'watermark')::boolean, false) and not r.watermark)
     or (coalesce((x ->> 'branding')::boolean, false) and not r.branding)
     or (coalesce((x ->> 'accessLog')::boolean, false) and not r.access_log) then
    return jsonb_build_object('error', 'plan');
  end if;
  if p_patch ? 'expiresOn' then
    exp := public._gallery_expiry(prof.plan_id, (p_patch ->> 'expiresOn')::date);
    if exp is null then return jsonb_build_object('error', 'expiry'); end if;
    -- Reopening an expired gallery counts against the live-gallery limit.
    if g.expires_at <= now() and r.galleries is not null
       and (select count(*) from public.galleries g2 where g2.owner_id = p_owner and g2.revoked_at is null
              and g2.expires_at > now()) >= r.galleries then
      return jsonb_build_object('error', 'limit');
    end if;
  end if;
  update public.galleries set
    name = coalesce(p_patch ->> 'name', name),
    message = case when p_patch ? 'message' then nullif(p_patch ->> 'message', '') else message end,
    downloads = coalesce(p_patch ->> 'downloads', downloads),
    x_favourites = coalesce((x ->> 'favourites')::boolean, x_favourites),
    x_watermark = coalesce((x ->> 'watermark')::boolean, x_watermark),
    x_branding = coalesce((x ->> 'branding')::boolean, x_branding),
    x_access_log = coalesce((x ->> 'accessLog')::boolean, x_access_log),
    expires_at = coalesce(exp, expires_at),
    reminder_sent_at = case when exp is not null then null else reminder_sent_at end,
    renditions_purged_at = case when exp is not null then null else renditions_purged_at end,
    paused_until = case when (p_patch ->> 'unpause')::boolean then null else paused_until end,
    updated_at = now()
  where id = g.id returning * into g;
  if (p_patch ->> 'unpause')::boolean then
    delete from public.gallery_attempts where gallery_id = g.id;
  end if;
  -- Full-size copies only count while full-size downloads are on.
  if g.downloads <> 'full' then
    delete from public.gallery_renders where gallery_id = g.id;
    delete from public.gallery_renditions where gallery_id = g.id and size = 'full';
  end if;
  return jsonb_build_object('gallery', public._gallery_detail(g));
end;
$$;

-- Revokes a gallery for good: the link stops working, renditions and full-size renders go (their objects
-- are queued for deletion, their bytes released). True, or null if not the owner's gallery.
create function public.revoke_gallery(p_owner uuid, p_id uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._lock_storage(p_owner);
  update public.galleries set revoked_at = coalesce(revoked_at, now()), paused_until = null, updated_at = now()
   where id = p_id and owner_id = p_owner;
  if not found then return null; end if;
  delete from public.gallery_renditions where gallery_id = p_id;
  delete from public.gallery_renders where gallery_id = p_id;
  perform public._gallery_log(p_id, 'revoked', null, null, 1);
  return true;
end;
$$;

-- The encrypted link for the owner to copy again: {ciphertext, iv} (hex), or null (not the owner's, or
-- revoked: a revoked link never works again).
create function public.gallery_link(p_owner uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ciphertext', encode(g.link_ciphertext, 'hex'), 'iv', encode(g.link_iv, 'hex'))
    from public.galleries g where g.id = p_id and g.owner_id = p_owner and g.revoked_at is null;
$$;

-- {generation} (the Worker HMACs a new code with generation + 1), or null.
create function public.gallery_passcode_state(p_owner uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('generation', g.passcode_generation, 'ended', public._gallery_status(g) in ('revoked', 'expired'))
    from public.galleries g where g.id = p_id and g.owner_id = p_owner;
$$;

-- Sets (or with null, removes) the passcode, moving to p_generation (must be current + 1, else 'conflict':
-- read again and retry). Every unlock cookie and signed URL of the old generation stops working.
-- 'ok' | 'conflict' | 'ended', or null.
create function public.set_gallery_passcode(p_owner uuid, p_id uuid, p_generation integer, p_hmac bytea) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare g public.galleries;
begin
  if p_hmac is not null and octet_length(p_hmac) <> 32 then return 'conflict'; end if;
  select * into g from public.galleries where id = p_id and owner_id = p_owner for update;
  if not found then return null; end if;
  if g.revoked_at is not null then return 'ended'; end if;
  if p_generation is distinct from g.passcode_generation + 1 then return 'conflict'; end if;
  update public.galleries set passcode_hmac = p_hmac, passcode_generation = p_generation, paused_until = null,
         updated_at = now() where id = p_id;
  delete from public.gallery_attempts where gallery_id = p_id;
  perform public._gallery_log(p_id, 'passcode_changed', null, null, 1);
  return 'ok';
end;
$$;

-- Page<GalleryPhotoItem> (cursor: position), or null.
create function public.list_gallery_photos(p_owner uuid, p_id uuid, p_cursor integer, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  g public.galleries;
  lim integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  eff record;
  rows jsonb;
  last_pos integer;
  more boolean;
begin
  select * into g from public.galleries where id = p_id and owner_id = p_owner;
  if not found then return null; end if;
  select * into eff from public._gallery_effective(g);
  with page as (
    select gp.photo_id, gp.position, p.file_type from public.gallery_photos gp join public.photos p on p.id = gp.photo_id
     where gp.gallery_id = g.id and public._photo_shareable(p) and gp.position >= coalesce(p_cursor, 0)
     order by gp.position, gp.photo_id limit lim + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'photoId', x.photo_id, 'position', x.position,
           'favourites', (select count(*) from public.gallery_favourites f where f.gallery_id = g.id and f.photo_id = x.photo_id),
           'full', case when eff.downloads <> 'full' then 'n/a'
                        when public._photo_edit_version(x.photo_id) is null and x.file_type in ('jpeg', 'png', 'webp') then 'ready'
                        when exists (select 1 from public.gallery_renders r where r.gallery_id = g.id and r.photo_id = x.photo_id
                                       and r.edit_version = coalesce(public._photo_edit_version(x.photo_id), 0)) then 'ready'
                        else 'pending' end)
           order by x.position, x.photo_id) filter (where x.rn <= lim), '[]'::jsonb),
         max(x.position) filter (where x.rn <= lim), count(*) > lim
    into rows, last_pos, more
    from (select page.*, row_number() over (order by page.position, page.photo_id) rn from page) x;
  return jsonb_build_object('items', rows, 'nextCursor', case when more then (last_pos + 1)::text end);
end;
$$;

-- Adds the owner's shareable photos (at the end) and removes photos; removed photos take their renditions
-- and renders with them. {count} (photos now in the gallery) | {error: 'too_many' | 'ended'}, or null.
create function public.update_gallery_photos(p_owner uuid, p_id uuid, p_add uuid[], p_remove uuid[]) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  g public.galleries;
  base integer;
  total integer;
begin
  perform public._lock_storage(p_owner);
  select * into g from public.galleries where id = p_id and owner_id = p_owner for update;
  if not found then return null; end if;
  if g.revoked_at is not null then return jsonb_build_object('error', 'ended'); end if;
  if p_remove is not null then
    delete from public.gallery_photos where gallery_id = g.id and photo_id = any (p_remove);
  end if;
  if p_add is not null then
    select coalesce(max(position) + 1, 0) into base from public.gallery_photos where gallery_id = g.id;
    insert into public.gallery_photos (gallery_id, photo_id, position)
    select g.id, x.id, base + (row_number() over (order by x.ord) - 1)::integer
      from (select distinct on (u.id) u.id, u.ord from unnest(p_add) with ordinality u(id, ord) order by u.id, u.ord) x
      join public.photos p on p.id = x.id and p.owner_id = p_owner and public._photo_shareable(p)
     where not exists (select 1 from public.gallery_photos gp where gp.gallery_id = g.id and gp.photo_id = x.id);
  end if;
  select count(*) into total from public.gallery_photos where gallery_id = g.id;
  if total > 2000 then raise exception 'too many photos' using errcode = 'P0001', hint = 'too_many'; end if;
  update public.galleries set updated_at = now() where id = g.id;
  return jsonb_build_object('count', total);
exception when sqlstate 'P0001' then
  return jsonb_build_object('error', 'too_many');
end;
$$;

-- [GuestSelection], or null.
create function public.gallery_favourites(p_owner uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when g.id is null then null else coalesce((
    select jsonb_agg(jsonb_build_object(
             'guestId', gg.id, 'name', gg.name, 'note', gg.note, 'sentAt', gg.sent_at,
             'photoIds', (select coalesce(jsonb_agg(f.photo_id order by gp.position), '[]'::jsonb)
                            from public.gallery_favourites f
                            join public.gallery_photos gp on gp.gallery_id = f.gallery_id and gp.photo_id = f.photo_id
                           where f.guest_id = gg.id))
           order by gg.sent_at desc nulls last, gg.created_at desc)
      from public.gallery_guests gg
     where gg.gallery_id = g.id and exists (select 1 from public.gallery_favourites f where f.guest_id = gg.id)), '[]'::jsonb) end
    from (select null) dummy left join public.galleries g on g.id = p_id and g.owner_id = p_owner;
$$;

-- {stats: GalleryStats, events: GalleryEvent[], nextCursor}, or null. Cursor: the last event id seen.
create function public.gallery_activity(p_owner uuid, p_id uuid, p_before bigint, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  g public.galleries;
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  evs jsonb;
  last_id bigint;
  more boolean;
begin
  select * into g from public.galleries where id = p_id and owner_id = p_owner;
  if not found then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'at', x.created_at, 'place', x.place,
                                               'device', x.device, 'count', x.count) order by x.id desc)
                    filter (where x.rn <= lim), '[]'::jsonb),
         min(x.id) filter (where x.rn <= lim), count(*) > lim
    into evs, last_id, more
    from (select e.*, row_number() over (order by e.id desc) rn from public.gallery_events e
           where e.gallery_id = g.id and (p_before is null or e.id < p_before)
           order by e.id desc limit lim + 1) x;
  return jsonb_build_object(
    'stats', jsonb_build_object(
      'views', g.views,
      'downloads', g.download_count,
      'favourites', (select count(*) from public.gallery_favourites f where f.gallery_id = g.id),
      'wrongPasscodesWeek', (select coalesce(sum(e.count), 0) from public.gallery_events e
                              where e.gallery_id = g.id and e.kind = 'wrong_passcode' and e.created_at > now() - interval '7 days')),
    'events', evs,
    'nextCursor', case when more then last_id::text end);
end;
$$;

-- [{photoId, editVersion}] still needing a full-size render from the member's device, or null.
create function public.gallery_render_queue(p_owner uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when g.id is null then null
              when not public._gallery_serving(g) then '[]'::jsonb
              else coalesce((select jsonb_agg(jsonb_build_object('photoId', q.photo_id, 'editVersion', q.edit_version))
                               from public._pending_renders(g) q), '[]'::jsonb) end
    from (select null) dummy left join public.galleries g on g.id = p_id and g.owner_id = p_owner;
$$;

-- Before a full-size render PUT writes anything: {status: 'current' | 'exists' | 'stale' | 'not_needed'},
-- or null (not the owner's gallery or photo).
create function public.gallery_render_check(p_owner uuid, p_gallery uuid, p_photo uuid, p_version integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  g public.galleries;
  p public.photos;
  want integer;
begin
  select * into g from public.galleries where id = p_gallery and owner_id = p_owner;
  if not found then return null; end if;
  select * into p from public.photos ph where ph.id = p_photo and ph.owner_id = p_owner
     and exists (select 1 from public.gallery_photos gp where gp.gallery_id = g.id and gp.photo_id = ph.id);
  if not found or not public._photo_shareable(p) then return null; end if;
  if not public._gallery_serving(g) or (select e.downloads from public._gallery_effective(g) e) <> 'full'
     or (public._photo_edit_version(p.id) is null and p.file_type in ('jpeg', 'png', 'webp')) then
    return jsonb_build_object('status', 'not_needed');
  end if;
  want := coalesce(public._photo_edit_version(p.id), 0);
  if p_version is distinct from want then return jsonb_build_object('status', 'stale'); end if;
  if exists (select 1 from public.gallery_renders r where r.gallery_id = g.id and r.photo_id = p.id and r.edit_version = want) then
    return jsonb_build_object('status', 'exists');
  end if;
  return jsonb_build_object('status', 'current');
end;
$$;

-- Records a full-size render the Worker stored at p_key (its own key) and measured. Under the owner's
-- storage lock; counts toward storage. {status: 'ok' | 'exists' | 'gone' | 'storage_full' | 'invalid'}.
-- A replaced render's object is queued for deletion by the trigger.
create function public.record_gallery_render(p_owner uuid, p_gallery uuid, p_photo uuid, p_version integer,
  p_key text, p_bytes bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  chk jsonb;
  prof record;
  old_bytes bigint;
begin
  if p_bytes is null or p_bytes not between 1 and 67108864
     or not public._share_key_ok(p_owner, p_gallery, p_photo, 'render', p_version, p_key) then
    return jsonb_build_object('status', 'invalid');
  end if;
  perform public._lock_storage(p_owner);
  perform 1 from public.galleries where id = p_gallery and owner_id = p_owner for update;
  chk := public.gallery_render_check(p_owner, p_gallery, p_photo, p_version);
  if chk is null or chk ->> 'status' in ('stale', 'not_needed') then return jsonb_build_object('status', 'gone'); end if;
  if chk ->> 'status' = 'exists' then return jsonb_build_object('status', 'exists'); end if;
  select coalesce((select r.bytes from public.gallery_renders r where r.gallery_id = p_gallery and r.photo_id = p_photo), 0)
    into old_bytes;
  select pr.plan_id, pr.storage_bytes, pr.reserved_bytes into prof from public.profiles pr where pr.id = p_owner for update;
  if p_bytes > old_bytes
     and prof.storage_bytes + prof.reserved_bytes + p_bytes - old_bytes > (select r.storage_bytes from public._share_rules(prof.plan_id) r) then
    return jsonb_build_object('status', 'storage_full');
  end if;
  insert into public.gallery_renders (gallery_id, photo_id, owner_id, edit_version, key, bytes)
  values (p_gallery, p_photo, p_owner, p_version, p_key, p_bytes)
  on conflict (gallery_id, photo_id) do update set edit_version = excluded.edit_version, key = excluded.key,
    bytes = excluded.bytes, created_at = now();
  -- A full rendition made from the old render is now stale: remove it (its object is queued).
  delete from public.gallery_renditions where gallery_id = p_gallery and photo_id = p_photo and size = 'full';
  return jsonb_build_object('status', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Branding (member)
-- ---------------------------------------------------------------------------------------------
create function public.get_branding(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select public._branding_json(b) from public.branding b where b.owner_id = p_owner),
                  jsonb_build_object('studioName', null, 'accent', null, 'hasLogo', false,
                    'watermark', jsonb_build_object('kind', 'text', 'text', null, 'position', 'bottom-right',
                                                    'opacity', 70, 'hasImage', false),
                    'updatedAt', null));
$$;

-- p_patch: BrandingBody (validated by the Worker). Name and accent need the plan's branding; watermark
-- settings need its watermark. {branding} | {error: 'plan' | 'invalid'}.
create function public.update_branding(p_owner uuid, p_patch jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
  w jsonb := coalesce(p_patch -> 'watermark', '{}'::jsonb);
  b public.branding;
begin
  select rr.* into r from public.profiles pr cross join lateral public._share_rules(pr.plan_id) rr where pr.id = p_owner;
  if not found then return jsonb_build_object('error', 'invalid'); end if;
  if ((p_patch ? 'studioName' or p_patch ? 'accent') and not r.branding)
     or (w <> '{}'::jsonb and not r.watermark) then
    return jsonb_build_object('error', 'plan');
  end if;
  insert into public.branding (owner_id) values (p_owner) on conflict (owner_id) do nothing;
  update public.branding set
    studio_name = case when p_patch ? 'studioName' then nullif(p_patch ->> 'studioName', '') else studio_name end,
    accent = case when p_patch ? 'accent' then p_patch ->> 'accent' else accent end,
    wm_kind = coalesce(w ->> 'kind', wm_kind),
    wm_text = case when w ? 'text' then nullif(w ->> 'text', '') else wm_text end,
    wm_position = coalesce(w ->> 'position', wm_position),
    wm_opacity = coalesce((w ->> 'opacity')::integer, wm_opacity),
    wm_version = case when w <> '{}'::jsonb then wm_version + 1 else wm_version end,
    updated_at = now()
  where owner_id = p_owner returning * into b;
  return jsonb_build_object('branding', public._branding_json(b));
exception when check_violation or invalid_text_representation then
  return jsonb_build_object('error', 'invalid');
end;
$$;

-- Records a re-encoded logo or watermark image the Worker stored at p_key. Under the storage lock.
-- {status: 'ok', branding} | {status: 'storage_full' | 'plan' | 'invalid'}. The old object is queued.
create function public.record_branding_asset(p_owner uuid, p_kind text, p_key text, p_bytes bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  prof record;
  r record;
  old_bytes bigint;
  b public.branding;
begin
  if p_kind not in ('logo', 'watermark') or p_bytes is null or p_bytes not between 1 and 2097152
     or not public._share_key_ok(p_owner, null, null, p_kind, null, p_key) then
    return jsonb_build_object('status', 'invalid');
  end if;
  perform public._lock_storage(p_owner);
  select pr.plan_id, pr.storage_bytes, pr.reserved_bytes into prof from public.profiles pr where pr.id = p_owner for update;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  select * into r from public._share_rules(prof.plan_id);
  if (p_kind = 'logo' and not r.branding) or (p_kind = 'watermark' and not r.watermark) then
    return jsonb_build_object('status', 'plan');
  end if;
  insert into public.branding (owner_id) values (p_owner) on conflict (owner_id) do nothing;
  select case p_kind when 'logo' then bb.logo_bytes else bb.wm_bytes end into old_bytes
    from public.branding bb where bb.owner_id = p_owner for update;
  if p_bytes > old_bytes and prof.storage_bytes + prof.reserved_bytes + p_bytes - old_bytes > r.storage_bytes then
    return jsonb_build_object('status', 'storage_full');
  end if;
  if p_kind = 'logo' then
    update public.branding set logo_key = p_key, logo_bytes = p_bytes, wm_version = wm_version + 1, updated_at = now()
     where owner_id = p_owner returning * into b;
  else
    update public.branding set wm_key = p_key, wm_bytes = p_bytes, wm_version = wm_version + 1, updated_at = now()
     where owner_id = p_owner returning * into b;
  end if;
  return jsonb_build_object('status', 'ok', 'branding', public._branding_json(b));
end;
$$;

-- The member's own logo or watermark image key (for their settings preview), or null.
create function public.branding_asset_key(p_owner uuid, p_kind text) returns text
language sql stable security definer set search_path = '' as $$
  select case p_kind when 'logo' then b.logo_key when 'watermark' then b.wm_key end
    from public.branding b where b.owner_id = p_owner;
$$;

create function public.delete_branding_asset(p_owner uuid, p_kind text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare b public.branding;
begin
  perform public._lock_storage(p_owner);
  if p_kind = 'logo' then
    update public.branding set logo_key = null, logo_bytes = 0, wm_version = wm_version + 1, updated_at = now()
     where owner_id = p_owner;
  elsif p_kind = 'watermark' then
    update public.branding set wm_key = null, wm_bytes = 0, wm_version = wm_version + 1, updated_at = now()
     where owner_id = p_owner;
  end if;
  return jsonb_build_object('branding', public.get_branding(p_owner));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Guests
-- ---------------------------------------------------------------------------------------------
-- What the media and guest routes need about a link, cached by the Worker for 60 seconds:
-- {id, ownerId, generation, hasPasscode, serving, state, expiresAt}, or null for an unknown token or a
-- gallery whose data is gone (30 days after it ended).
create function public.guest_gallery_state(p_token_hash bytea) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', g.id, 'ownerId', g.owner_id, 'generation', g.passcode_generation, 'hasPasscode', g.passcode_hmac is not null,
    'serving', public._gallery_serving(g),
    'paused', g.paused_until > now(),
    'expiresAt', g.expires_at)
    from public.galleries g where g.token_hash = p_token_hash;
$$;

-- GuestGalleryInfo for the guest page (the Worker adds the signed logo URL and hides what a locked or
-- ended page mustn't show). The state: 'ended' when the gallery doesn't serve, 'open' without a passcode,
-- 'paused' while unlocking is paused, else 'locked' (the Worker turns it into 'open' for an unlocked guest).
-- turnstile: this network already got 2 wrong passcodes in the window.
create function public._guest_info(g public.galleries, p_network bytea) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', g.id,
    'ownerId', g.owner_id,
    'generation', g.passcode_generation,
    'state', case when not public._gallery_serving(g) then 'ended'
                  when g.passcode_hmac is null then 'open'
                  when g.paused_until > now() then 'paused'
                  else 'locked' end,
    'name', g.name,
    'message', g.message,
    'photoCount', (select count(*) from public.gallery_photos gp join public.photos p on p.id = gp.photo_id
                    where gp.gallery_id = g.id and public._photo_shareable(p)),
    'expiresAt', g.expires_at,
    'downloads', e.downloads,
    'favourites', e.favourites,
    'brand', case when e.branding and b.owner_id is not null
                  then jsonb_build_object('studioName', coalesce(b.studio_name, pr.display_name, 'Zephyr'),
                                          'accent', b.accent, 'hasLogo', b.logo_key is not null)
                  else jsonb_build_object('studioName', coalesce(pr.display_name, 'Zephyr'), 'accent', null, 'hasLogo', false) end,
    'turnstile', p_network is not null
                 and (select count(*) >= 2 from public.gallery_attempts a
                       where a.gallery_id = g.id and a.network_hash = p_network and a.created_at > now() - interval '15 minutes'),
    'pausedUntil', case when g.paused_until > now() then g.paused_until end)
  from public.profiles pr
  cross join lateral public._gallery_effective(g) e
  left join public.branding b on b.owner_id = g.owner_id
  where pr.id = g.owner_id;
$$;

create function public.guest_gallery_info(p_token_hash bytea, p_network bytea) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public._guest_info(g, p_network) from public.galleries g where g.token_hash = p_token_hash;
$$;

-- The owner's preview of their gallery as guests see it, or null.
create function public.gallery_preview_info(p_owner uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public._guest_info(g, null) from public.galleries g where g.id = p_id and g.owner_id = p_owner;
$$;

-- The logo key to show guests of a serving gallery (branding in force), or null.
create function public.guest_logo(p_gallery uuid) returns text
language sql stable security definer set search_path = '' as $$
  select b.logo_key from public.galleries g
    cross join lateral public._gallery_effective(g) e
    join public.branding b on b.owner_id = g.owner_id
   where g.id = p_gallery and e.branding and public._gallery_serving(g);
$$;

-- Reserves one passcode attempt before the Worker checks it (counted until confirmed correct), under the
-- gallery's row lock so parallel guesses can't slip past. Limits (PASSCODE_LIMITS): 5 per network per
-- 15 minutes; from the 3rd attempt in the window a Turnstile token is required (p_has_turnstile, checked
-- by the Worker); 25 from anywhere pause unlocking for 15 minutes. Returns
-- {status: 'ok', attemptId, hmac (hex), generation, pausedNow, ownerEmail?, name?} |
-- {status: 'turnstile'} | {status: 'limited', retryAfter} | {status: 'paused', pausedUntil} |
-- {status: 'open'} (no passcode) | {status: 'ended'}, or null.
create function public.gallery_unlock_reserve(p_gallery uuid, p_network bytea, p_has_turnstile boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  g public.galleries;
  n_net integer;
  n_all integer;
  oldest timestamptz;
  att bigint;
  paused_now boolean := false;
begin
  if p_network is null or octet_length(p_network) <> 32 then return null; end if;
  select * into g from public.galleries where id = p_gallery for update;
  if not found then return null; end if;
  if not public._gallery_serving(g) then return jsonb_build_object('status', 'ended'); end if;
  if g.passcode_hmac is null then return jsonb_build_object('status', 'open'); end if;
  if g.paused_until > now() then return jsonb_build_object('status', 'paused', 'pausedUntil', g.paused_until); end if;
  select count(*), min(a.created_at) into n_net, oldest from public.gallery_attempts a
   where a.gallery_id = g.id and a.network_hash = p_network and a.created_at > now() - interval '15 minutes';
  if n_net >= 5 then
    return jsonb_build_object('status', 'limited',
      'retryAfter', greatest(1, ceil(extract(epoch from oldest + interval '15 minutes' - now()))::integer));
  end if;
  if n_net >= 2 and not coalesce(p_has_turnstile, false) then return jsonb_build_object('status', 'turnstile'); end if;
  select count(*) into n_all from public.gallery_attempts a
   where a.gallery_id = g.id and a.created_at > now() - interval '15 minutes';
  insert into public.gallery_attempts (gallery_id, network_hash) values (g.id, p_network) returning id into att;
  if n_all + 1 >= 25 then
    update public.galleries set paused_until = now() + interval '15 minutes' where id = g.id;
    paused_now := true;
    perform public._gallery_log(g.id, 'paused', null, null, 1);
  end if;
  return jsonb_build_object('status', 'ok', 'attemptId', att, 'hmac', encode(g.passcode_hmac, 'hex'),
    'generation', g.passcode_generation, 'pausedNow', paused_now, 'networkAttempts', n_net + 1,
    'ownerEmail', case when paused_now then public._owner_email(g.owner_id) end,
    'name', case when paused_now then g.name end);
end;
$$;

-- The attempt was the right passcode: it stops counting.
create function public.gallery_unlock_succeeded(p_attempt bigint) returns void
language sql volatile security definer set search_path = '' as $$
  delete from public.gallery_attempts where id = p_attempt;
$$;

-- A page of the gallery's shareable photos for a guest who may see them (the Worker checked the unlock),
-- with this browser's favourites. {items: [{id, width, height, full: 'n/a' | 'pending' | 'ready',
-- favourite}], nextCursor, selection: {count, sentAt, name} | null}, or null if the gallery doesn't serve.
create function public.guest_photos(p_gallery uuid, p_cursor integer, p_limit integer, p_guest bytea) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  g public.galleries;
  eff record;
  lim integer := least(greatest(coalesce(p_limit, 60), 1), 120);
  guest public.gallery_guests;
  rows jsonb;
  last_pos integer;
  more boolean;
begin
  select * into g from public.galleries where id = p_gallery;
  if not found or not public._gallery_serving(g) then return null; end if;
  select * into eff from public._gallery_effective(g);
  if p_guest is not null then
    select * into guest from public.gallery_guests where gallery_id = g.id and cookie_hash = p_guest;
  end if;
  with page as (
    select p.id, p.width, p.height, p.file_type, gp.position from public.gallery_photos gp
      join public.photos p on p.id = gp.photo_id
     where gp.gallery_id = g.id and public._photo_shareable(p) and gp.position >= coalesce(p_cursor, 0)
     order by gp.position, p.id limit lim + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'width', coalesce(x.width, 0), 'height', coalesce(x.height, 0),
           'full', case when eff.downloads <> 'full' then 'n/a'
                        when public._photo_edit_version(x.id) is null and x.file_type in ('jpeg', 'png', 'webp') then 'ready'
                        when exists (select 1 from public.gallery_renders r where r.gallery_id = g.id and r.photo_id = x.id
                                       and r.edit_version = coalesce(public._photo_edit_version(x.id), 0)) then 'ready'
                        else 'pending' end,
           'favourite', guest.id is not null and exists (select 1 from public.gallery_favourites f
                                                        where f.guest_id = guest.id and f.photo_id = x.id))
           order by x.position, x.id) filter (where x.rn <= lim), '[]'::jsonb),
         max(x.position) filter (where x.rn <= lim), count(*) > lim
    into rows, last_pos, more
    from (select page.*, row_number() over (order by page.position, page.id) rn from page) x;
  return jsonb_build_object(
    'items', rows,
    'nextCursor', case when more then (last_pos + 1)::text end,
    'selection', case when eff.favourites then jsonb_build_object(
      'count', case when guest.id is null then 0
                    else (select count(*) from public.gallery_favourites f where f.guest_id = guest.id) end,
      'sentAt', guest.sent_at, 'name', guest.name) end);
end;
$$;

-- What the media route needs to serve one rendition of one photo: the stored rendition if it was made from
-- the current source and watermark, else the source to make it from. Null if the photo isn't shown in a
-- serving gallery. {ownerId, filename, rendition: {key} | null, unavailable?: 'pending' | 'not_allowed',
-- source: {key, editVersion}, watermark: {key, version, position, opacity} | null, wmVersion}.
create function public.guest_media(p_gallery uuid, p_photo uuid, p_size text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  g public.galleries;
  p public.photos;
  e public.photo_edits;
  eff record;
  b public.branding;
  ev integer;
  src text;
  wm jsonb;
  wv integer := 0;
  rk text;
begin
  if p_size not in ('grid', 'view', 'full') then return null; end if;
  select * into g from public.galleries where id = p_gallery;
  if not found or not public._gallery_serving(g) then return null; end if;
  select ph.* into p from public.photos ph join public.gallery_photos gp on gp.photo_id = ph.id and gp.gallery_id = g.id
   where ph.id = p_photo;
  if not found or not public._photo_shareable(p) then return null; end if;
  select * into eff from public._gallery_effective(g);
  select * into e from public.photo_edits pe where pe.photo_id = p.id and not public._recipe_empty(pe.recipe);
  if p_size = 'full' then
    if eff.downloads <> 'full' then return jsonb_build_object('unavailable', 'not_allowed'); end if;
    if e.photo_id is null and p.file_type in ('jpeg', 'png', 'webp') then
      ev := 0; src := public._r2_prefix(p.owner_id, p.id) || 'original';
    else
      ev := coalesce(e.version, 0);
      select r.key into src from public.gallery_renders r where r.gallery_id = g.id and r.photo_id = p.id and r.edit_version = ev;
      if src is null then return jsonb_build_object('unavailable', 'pending'); end if;
    end if;
  elsif e.photo_id is not null and e.preview_version = e.version and e.preview_key is not null then
    ev := e.version; src := e.preview_key;
  elsif p.has_preview then
    ev := 0; src := public._r2_prefix(p.owner_id, p.id) || 'preview';
  elsif p.file_type in ('jpeg', 'png', 'webp') then
    ev := 0; src := public._r2_prefix(p.owner_id, p.id) || 'original';
  else
    return jsonb_build_object('unavailable', 'pending');
  end if;
  if eff.watermark then
    select * into b from public.branding where owner_id = g.owner_id;
    -- A 'logo' watermark draws the logo; a 'text' one draws the PNG the member's device rendered.
    if found and (case b.wm_kind when 'logo' then b.logo_key else b.wm_key end) is not null then
      wv := b.wm_version;
      wm := jsonb_build_object('key', case b.wm_kind when 'logo' then b.logo_key else b.wm_key end,
                               'version', b.wm_version, 'position', b.wm_position, 'opacity', b.wm_opacity);
    end if;
  end if;
  select r.key into rk from public.gallery_renditions r
   where r.gallery_id = g.id and r.photo_id = p.id and r.size = p_size and r.edit_version = ev and r.wm_version = wv;
  return jsonb_build_object('ownerId', g.owner_id, 'filename', p.filename, 'width', p.width, 'height', p.height,
    'rendition', case when rk is not null then jsonb_build_object('key', rk) end,
    'source', jsonb_build_object('key', src, 'editVersion', ev),
    'watermark', wm, 'wmVersion', wv);
end;
$$;

-- Records a rendition the Worker made and stored at p_key, if it still matches the photo's current source
-- (p_edit_version) and watermark (p_wm_version). Under the owner's storage lock. Grid and view renditions
-- always count but are never refused (a full account mustn't break its galleries); full ones are refused
-- when storage is full. {status: 'ok'} | {status: 'exists', key} (another request recorded the same one:
-- the Worker deletes its own object and serves that) | {status: 'gone' | 'storage_full' | 'invalid'}.
create function public.record_rendition(p_gallery uuid, p_photo uuid, p_size text, p_key text, p_bytes bigint,
  p_edit_version integer, p_wm_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  g public.galleries;
  m jsonb;
  cur public.gallery_renditions;
  prof record;
begin
  select * into g from public.galleries where id = p_gallery;
  if not found or p_bytes is null or p_bytes not between 1 and 104857600
     or not public._share_key_ok(g.owner_id, p_gallery, p_photo, p_size, null, p_key) then
    return jsonb_build_object('status', 'invalid');
  end if;
  perform public._lock_storage(g.owner_id);
  m := public.guest_media(p_gallery, p_photo, p_size);
  if m is null or m ? 'unavailable' or (m -> 'source' ->> 'editVersion')::integer <> p_edit_version
     or (m ->> 'wmVersion')::integer <> p_wm_version then
    return jsonb_build_object('status', 'gone');
  end if;
  select * into cur from public.gallery_renditions where gallery_id = p_gallery and photo_id = p_photo and size = p_size for update;
  if found and cur.edit_version = p_edit_version and cur.wm_version = p_wm_version then
    return jsonb_build_object('status', 'exists', 'key', cur.key);
  end if;
  if p_size = 'full' then
    select pr.plan_id, pr.storage_bytes, pr.reserved_bytes into prof from public.profiles pr where pr.id = g.owner_id for update;
    if p_bytes > coalesce(cur.bytes, 0)
       and prof.storage_bytes + prof.reserved_bytes + p_bytes - coalesce(cur.bytes, 0) > (select r.storage_bytes from public._share_rules(prof.plan_id) r) then
      return jsonb_build_object('status', 'storage_full');
    end if;
  end if;
  insert into public.gallery_renditions (gallery_id, photo_id, size, owner_id, key, bytes, edit_version, wm_version)
  values (p_gallery, p_photo, p_size, g.owner_id, p_key, p_bytes, p_edit_version, p_wm_version)
  on conflict (gallery_id, photo_id, size) do update set key = excluded.key, bytes = excluded.bytes,
    edit_version = excluded.edit_version, wm_version = excluded.wm_version, created_at = now();
  return jsonb_build_object('status', 'ok');
end;
$$;

-- Counters and (when the access log is on) an event, for a serving gallery.
create function public.gallery_event(p_gallery uuid, p_kind text, p_place text, p_device text, p_count integer)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_kind not in ('opened', 'unlocked', 'downloaded', 'wrong_passcode') then return; end if;
  perform public._gallery_log(p_gallery, p_kind, p_place, p_device, p_count);
end;
$$;

-- Favourites a photo for this browser (or removes it). 'ok' | 'off' (favourites not in force) | 'limit'
-- (500 guests per gallery), or null (not a shareable photo of a serving gallery).
create function public.guest_set_favourite(p_gallery uuid, p_guest bytea, p_photo uuid, p_on boolean) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  g public.galleries;
  gid uuid;
begin
  if p_guest is null or octet_length(p_guest) <> 32 then return null; end if;
  select * into g from public.galleries where id = p_gallery for update;
  if not found or not public._gallery_serving(g) then return null; end if;
  if not exists (select 1 from public.gallery_photos gp join public.photos p on p.id = gp.photo_id
                  where gp.gallery_id = g.id and gp.photo_id = p_photo and public._photo_shareable(p)) then
    return null;
  end if;
  if not (select e.favourites from public._gallery_effective(g) e) then return 'off'; end if;
  select id into gid from public.gallery_guests where gallery_id = g.id and cookie_hash = p_guest;
  if gid is null then
    if not p_on then return 'ok'; end if;
    if (select count(*) from public.gallery_guests where gallery_id = g.id) >= 500 then return 'limit'; end if;
    insert into public.gallery_guests (gallery_id, cookie_hash) values (g.id, p_guest) returning id into gid;
  end if;
  if p_on then
    insert into public.gallery_favourites (guest_id, gallery_id, photo_id) values (gid, g.id, p_photo) on conflict do nothing;
  else
    delete from public.gallery_favourites where guest_id = gid and photo_id = p_photo;
  end if;
  return 'ok';
end;
$$;

-- Sends this browser's favourites to the owner: stores the name and note. At most one email per gallery an
-- hour (notify true when this one should email). {status: 'ok', count, notify, ownerEmail?, name?} |
-- {status: 'off' | 'empty'}, or null.
create function public.guest_send_favourites(p_gallery uuid, p_guest bytea, p_name text, p_note text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  g public.galleries;
  gid uuid;
  n integer;
  notify boolean := false;
begin
  if p_guest is null or octet_length(p_guest) <> 32 or p_name is null or length(p_name) not between 1 and 60
     or coalesce(length(p_note), 0) > 1000 then
    return null;
  end if;
  select * into g from public.galleries where id = p_gallery for update;
  if not found or not public._gallery_serving(g) then return null; end if;
  if not (select e.favourites from public._gallery_effective(g) e) then return jsonb_build_object('status', 'off'); end if;
  select id into gid from public.gallery_guests where gallery_id = g.id and cookie_hash = p_guest;
  select count(*) into n from public.gallery_favourites where guest_id = gid;
  if gid is null or n = 0 then return jsonb_build_object('status', 'empty'); end if;
  update public.gallery_guests set name = p_name, note = nullif(p_note, ''), sent_at = now() where id = gid;
  if g.favourites_notified_at is null or g.favourites_notified_at <= now() - interval '1 hour' then
    update public.galleries set favourites_notified_at = now() where id = g.id;
    notify := true;
  end if;
  perform public._gallery_log(g.id, 'favourites_sent', null, null, n);
  return jsonb_build_object('status', 'ok', 'count', n, 'notify', notify,
    'ownerEmail', case when notify then public._owner_email(g.owner_id) end,
    'galleryName', case when notify then g.name end);
end;
$$;

-- A guest reports a gallery (and optionally one photo in it). Needs only the link: it works on locked and
-- ended galleries too. At most 10 reports per network a day. {status: 'ok', reportId, ownerId} |
-- {status: 'limited'}, or null for an unknown gallery. Reports outlive the gallery (gallery_id set null).
create function public.guest_report(p_gallery uuid, p_photo uuid, p_reason text, p_details text, p_network bytea)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  g public.galleries;
  rid uuid;
  ph uuid;
begin
  if p_network is null or octet_length(p_network) <> 32 or p_reason not in ('csam', 'violence', 'copyright', 'privacy', 'other')
     or coalesce(length(p_details), 0) > 1000 then
    return null;
  end if;
  select * into g from public.galleries where id = p_gallery;
  if not found then return null; end if;
  if (select count(*) from public.gallery_reports r where r.network_hash = p_network
        and r.created_at > now() - interval '1 day') >= 10 then
    return jsonb_build_object('status', 'limited');
  end if;
  select gp.photo_id into ph from public.gallery_photos gp where gp.gallery_id = g.id and gp.photo_id = p_photo;
  insert into public.gallery_reports (gallery_id, owner_id, photo_id, reason, details, network_hash)
  values (g.id, g.owner_id, ph, p_reason, nullif(p_details, ''), p_network) returning id into rid;
  perform public._audit(null, 'safety.report', rid::text,
                        jsonb_build_object('galleryId', g.id, 'ownerId', g.owner_id, 'photoId', ph, 'reason', p_reason));
  return jsonb_build_object('status', 'ok', 'reportId', rid, 'ownerId', g.owner_id);
end;
$$;

-- Cloudflare blocked a rendition of this photo (a CSAM Scanning Tool match). Holds the photo (never served,
-- shared, trashed or purged), removes it from every gallery, suspends the owner's sharing and records it.
-- Idempotent. {ownerId, alreadyHeld}.
create function public.apply_safety_hold(p_gallery uuid, p_photo uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  o uuid;
  was timestamptz;
begin
  select p.owner_id, p.safety_hold_at into o, was from public.photos p
    join public.gallery_photos gp on gp.photo_id = p.id and gp.gallery_id = p_gallery where p.id = p_photo;
  if o is null then
    select p.owner_id, p.safety_hold_at into o, was from public.photos p where p.id = p_photo;
  end if;
  if o is null then return null; end if;
  perform public._lock_storage(o);
  update public.photos set safety_hold_at = coalesce(safety_hold_at, now()) where id = p_photo;
  update public.profiles set sharing_suspended_at = coalesce(sharing_suspended_at, now()) where id = o;
  delete from public.gallery_photos where photo_id = p_photo;
  if was is null then
    perform public._audit(null, 'safety.csam_match', p_photo::text,
                          jsonb_build_object('ownerId', o, 'galleryId', p_gallery));
  end if;
  return jsonb_build_object('ownerId', o, 'alreadyHeld', was is not null);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Existing functions that learn about safety holds and sharing
-- ---------------------------------------------------------------------------------------------
-- Held photos are never served, even to their owner.
create or replace function public.photo_file(p_owner uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('fileType', p.file_type, 'filename', p.filename, 'sizeBytes', p.size_bytes,
                            'hasThumb', p.has_thumb, 'hasPreview', p.has_preview,
                            'editVersion', e.version,
                            'editThumbKey', case when e.thumb_version = e.version and not public._recipe_empty(e.recipe) then e.thumb_key end,
                            'editPreviewKey', case when e.preview_version = e.version and not public._recipe_empty(e.recipe) then e.preview_key end)
  from public.photos p left join public.photo_edits e on e.photo_id = p.id
  where p.id = p_id and p.owner_id = p_owner and p.status in ('ready', 'trashed') and p.safety_hold_at is null;
$$;

-- Accounts holding a held photo aren't purged (the bytes are preserved for legal requests); purges also
-- empty the shared bucket's o/<owner>/ prefix.
create or replace function public.due_account_purges(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  picked uuid[];
  r record;
begin
  select array_agg(x.id order by x.deletion_due) into picked
    from (select p.id, p.deletion_due from public.profiles p
           where p.deletion_due <= now()
             and (p.purge_attempted_at is null or p.purge_attempted_at <= now() - interval '1 hour')
             and not exists (select 1 from public.staff s where s.user_id = p.id)
             and not exists (select 1 from public.photos h where h.owner_id = p.id and h.safety_hold_at is not null)
           order by p.deletion_due limit least(greatest(coalesce(p_limit, 10), 1), 100)
           for update skip locked) x;
  if picked is null then return '[]'::jsonb; end if;
  for r in update public.profiles set purge_attempts = purge_attempts + 1, purge_attempted_at = now()
            where id = any (picked) returning id, purge_attempts loop
    if r.purge_attempts = 5 then
      perform public._audit(null, 'jobs.account_purge_failing', r.id::text, jsonb_build_object('attempts', r.purge_attempts));
    end if;
  end loop;
  return (select coalesce(jsonb_agg(jsonb_build_object(
           'ownerId', p.id,
           'prefix', 'u/' || p.id::text || '/',
           'stagingPrefix', 'staging/' || p.id::text || '/',
           'sharedPrefix', 'o/' || p.id::text || '/',
           'uploads', coalesce((select jsonb_agg(jsonb_build_object('r2Key', u.r2_key, 'r2UploadId', u.r2_upload_id))
                                  from public.uploads u where u.owner_id = p.id and u.r2_upload_id is not null), '[]'::jsonb))
         order by p.deletion_due), '[]'::jsonb)
    from public.profiles p where p.id = any (picked));
end;
$$;

-- Usage gains the plan's sharing limits (Usage.sharing: SharingLimits).
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
    'batchSize', r.batch_size,
    'sharing', jsonb_build_object(
      'galleries', s.galleries,
      'liveGalleries', (select count(*) from public.galleries g where g.owner_id = p_owner
                          and g.revoked_at is null and g.expires_at > now()),
      'maxLinkDays', s.max_link_days,
      'guestFullRes', s.guest_full_res,
      'guestFavourites', s.guest_favourites,
      'watermark', s.watermark,
      'branding', s.branding,
      'accessLog', s.access_log,
      'suspended', pr.sharing_suspended_at is not null))
  from public.profiles pr
  cross join lateral public._plan_rules(pr.plan_id) r
  cross join lateral public._share_rules(pr.plan_id) s
  where pr.id = p_owner;
$$;

-- ---------------------------------------------------------------------------------------------
-- Clean-up (the API's Cron Trigger, every 15 minutes)
-- ---------------------------------------------------------------------------------------------
-- Bounded work per run. Removes renditions and renders of galleries that ended over a day ago (bytes
-- released, objects queued), deletes gallery data 30 days after the end (queuing each gallery's prefixes
-- for leftovers), drops attempt rows after 2 days and events after 90, and picks expiry reminders
-- (3 days before, once). Returns {reminders: [{galleryId, ownerEmail, name, expiresAt}], purged, deleted}.
create function public.due_share_cleanup(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  g record;
  purged integer := 0;
  deleted integer := 0;
  reminders jsonb;
begin
  -- The storage lock comes before any row lock (as everywhere), so rows are picked without locking and
  -- re-checked under the lock.
  for g in select ga.id, ga.owner_id from public.galleries ga
            where ga.renditions_purged_at is null
              and least(coalesce(ga.revoked_at, ga.expires_at), ga.expires_at) <= now() - interval '1 day'
            order by least(coalesce(ga.revoked_at, ga.expires_at), ga.expires_at) limit lim loop
    perform public._lock_storage(g.owner_id);
    update public.galleries ga set renditions_purged_at = now()
     where ga.id = g.id and ga.renditions_purged_at is null
       and least(coalesce(ga.revoked_at, ga.expires_at), ga.expires_at) <= now() - interval '1 day';
    if found then
      delete from public.gallery_renditions where gallery_id = g.id;
      delete from public.gallery_renders where gallery_id = g.id;
      purged := purged + 1;
    end if;
  end loop;
  for g in select ga.id, ga.owner_id from public.galleries ga
            where ga.renditions_purged_at is not null
              and least(coalesce(ga.revoked_at, ga.expires_at), ga.expires_at) <= now() - interval '30 days'
            order by ga.expires_at limit lim loop
    perform public._lock_storage(g.owner_id);
    delete from public.galleries ga where ga.id = g.id and ga.renditions_purged_at is not null
       and least(coalesce(ga.revoked_at, ga.expires_at), ga.expires_at) <= now() - interval '30 days';
    if found then
      -- Anything a failed request left under the gallery's prefixes goes too.
      insert into public.share_object_deletions (bucket, key, is_prefix) values
        ('shared', 'o/' || g.owner_id::text || '/g/' || g.id::text || '/', true),
        ('photos', 'u/' || g.owner_id::text || '/g/' || g.id::text || '/', true);
      deleted := deleted + 1;
    end if;
  end loop;
  delete from public.gallery_attempts where created_at < now() - interval '2 days';
  delete from public.gallery_events where created_at < now() - interval '90 days';
  with due as (
    update public.galleries ga set reminder_sent_at = now()
     where ga.id in (select x.id from public.galleries x
                      where x.revoked_at is null and x.reminder_sent_at is null
                        and x.expires_at > now() and x.expires_at <= now() + interval '3 days'
                        and x.created_at <= now() - interval '1 day'
                      order by x.expires_at limit lim for update skip locked)
    returning ga.id, ga.owner_id, ga.name, ga.expires_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('galleryId', d.id, 'ownerEmail', public._owner_email(d.owner_id),
                                               'name', d.name, 'expiresAt', d.expires_at)), '[]'::jsonb)
    into reminders from due d;
  return jsonb_build_object('reminders', reminders, 'purged', purged, 'deleted', deleted);
end;
$$;

-- The next queued object deletions: [{id, bucket, key, prefix}].
create function public.due_share_deletions(p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'bucket', d.bucket, 'key', d.key, 'prefix', d.is_prefix) order by d.id), '[]'::jsonb)
    from (select * from public.share_object_deletions order by id limit least(greatest(coalesce(p_limit, 500), 1), 1000)) d;
$$;

-- The Worker deleted these objects (or prefixes): forget them. Returns how many.
create function public.confirm_share_deletions(p_ids bigint[]) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.share_object_deletions where id = any (p_ids);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: service_role only. Internal helpers (_*) are callable by no role but their owner.
-- ---------------------------------------------------------------------------------------------
revoke all on public.galleries, public.gallery_photos, public.gallery_renditions, public.gallery_renders,
  public.gallery_guests, public.gallery_favourites, public.gallery_attempts, public.gallery_events, public.branding,
  public.share_object_deletions, public.gallery_reports
from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on function
  public._gallery_photo_same_owner(),
  public._gallery_photo_removed(),
  public._share_bytes(),
  public._branding_bytes(),
  public._safety_hold_guard(),
  public._share_rules(text),
  public._gallery_status(public.galleries),
  public._gallery_serving(public.galleries),
  public._gallery_effective(public.galleries),
  public._photo_edit_version(uuid),
  public._photo_shareable(public.photos),
  public._share_key_ok(uuid, uuid, uuid, text, integer, text),
  public._gallery_summary(public.galleries),
  public._pending_renders(public.galleries),
  public._gallery_detail(public.galleries),
  public._branding_json(public.branding),
  public._gallery_expiry(text, date),
  public._gallery_log(uuid, text, text, text, integer),
  public._owner_email(uuid),
  public._guest_info(public.galleries, bytea)
from service_role;
grant execute on function
  public.create_gallery(uuid, uuid, bytea, text, bytea, bytea, bytea, text, text, uuid[], date, text, jsonb),
  public.gallery_link(uuid, uuid),
  public.list_galleries(uuid),
  public.get_gallery(uuid, uuid),
  public.patch_gallery(uuid, uuid, jsonb),
  public.revoke_gallery(uuid, uuid),
  public.gallery_passcode_state(uuid, uuid),
  public.set_gallery_passcode(uuid, uuid, integer, bytea),
  public.list_gallery_photos(uuid, uuid, integer, integer),
  public.update_gallery_photos(uuid, uuid, uuid[], uuid[]),
  public.gallery_favourites(uuid, uuid),
  public.gallery_activity(uuid, uuid, bigint, integer),
  public.gallery_render_queue(uuid, uuid),
  public.gallery_render_check(uuid, uuid, uuid, integer),
  public.record_gallery_render(uuid, uuid, uuid, integer, text, bigint),
  public.get_branding(uuid),
  public.update_branding(uuid, jsonb),
  public.record_branding_asset(uuid, text, text, bigint),
  public.delete_branding_asset(uuid, text),
  public.branding_asset_key(uuid, text),
  public.guest_gallery_state(bytea),
  public.guest_gallery_info(bytea, bytea),
  public.gallery_preview_info(uuid, uuid),
  public.guest_logo(uuid),
  public.guest_report(uuid, uuid, text, text, bytea),
  public.gallery_unlock_reserve(uuid, bytea, boolean),
  public.gallery_unlock_succeeded(bigint),
  public.guest_photos(uuid, integer, integer, bytea),
  public.guest_media(uuid, uuid, text),
  public.record_rendition(uuid, uuid, text, text, bigint, integer, integer),
  public.gallery_event(uuid, text, text, text, integer),
  public.guest_set_favourite(uuid, bytea, uuid, boolean),
  public.guest_send_favourites(uuid, bytea, text, text),
  public.apply_safety_hold(uuid, uuid),
  public.photo_file(uuid, uuid),
  public.get_usage(uuid),
  public.due_account_purges(integer),
  public.due_share_cleanup(integer),
  public.due_share_deletions(integer),
  public.confirm_share_deletions(bigint[])
to service_role;
