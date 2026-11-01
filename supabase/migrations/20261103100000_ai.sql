-- Phase 6: Zephyr AI. Admin AI settings and daily spend caps, cloud credits, the AI queue (cloud background
-- removal and device jobs), background masks, device quality signals, scene tags, and face grouping.
-- See docs/phase-6.md.
--
-- Every entry point is security definer, takes the owner (or staff) id the API read from the verified session,
-- and filters by it. Only service_role (the API Worker) may call them.
--
-- Lock order (always in this order, never the reverse):
--   credits lock (zephyr:credits:<owner>) → job and item rows → spend lock (zephyr:ai-spend:<day>)
--   faces lock (zephyr:faces:<owner>) is taken alone.
-- Credits:  credit_balances.balance = the last period's carry + Σ credit_ledger.delta of the current period;
--           it can never go below 0, a refund is written at most once per charge of an item.
-- Spend:    ai_spend_daily / ai_user_spend_daily hold micro-dollars spent and reserved per UTC day. A provider
--           call happens only after its estimate was reserved under the day's lock, so parallel consumers can't
--           pass a cap; the reservation is settled to the real cost afterwards.
-- Masks don't count toward storage (phases 3–5's usage invariant is unchanged).

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------------------------
-- Plan limits: Cleanup (Pro and Studio). Values match packages/shared/src/plans.ts.
-- ---------------------------------------------------------------------------------------------
alter table public.plan_limits add column quality_cleanup boolean not null default false;
update public.plan_limits set quality_cleanup = true where plan_id in ('pro', 'studio');

-- ---------------------------------------------------------------------------------------------
-- Admin settings (one row) and spend
-- ---------------------------------------------------------------------------------------------
create table public.ai_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  cloud_paused boolean not null default false,
  f_auto_enhance boolean not null default true,
  f_hdr boolean not null default true,
  f_color_match boolean not null default true,
  f_cleanup boolean not null default true,
  f_face_grouping boolean not null default true,
  f_scene_tags boolean not null default true,
  f_bg_removal boolean not null default true,
  bg_provider text not null default 'runware' check (bg_provider in ('runware', 'fal_bria')),
  bg_fallback text not null default 'fal_bria' check (bg_fallback in ('runware', 'fal_bria', 'none')),
  runware_model text not null default 'runware:112@5' check (runware_model ~ '^runware:[0-9]{1,6}@[0-9]{1,4}$'),
  fal_model text not null default 'fal-ai/bria/background/remove'
    check (fal_model ~ '^fal-ai/[a-z0-9][a-z0-9/_.-]{1,100}$' and fal_model !~ '\.\.'),
  scene_model text not null default '@cf/microsoft/resnet-50'
    check (scene_model ~* '^@cf/[a-z0-9][a-z0-9/_.-]{1,100}$' and scene_model !~ '\.\.'),
  bg_credits_per_photo integer not null default 1 check (bg_credits_per_photo between 1 and 20),
  cost_runware_micros integer not null default 600 check (cost_runware_micros between 0 and 1000000),
  cost_fal_micros integer not null default 18000 check (cost_fal_micros between 0 and 1000000),
  cost_scene_micros integer not null default 20 check (cost_scene_micros between 0 and 1000000),
  cap_total_micros bigint not null default 10000000 check (cap_total_micros between 0 and 10000000000),
  cap_bg_micros bigint not null default 8000000 check (cap_bg_micros between 0 and 10000000000),
  cap_scene_micros bigint not null default 2000000 check (cap_scene_micros between 0 and 10000000000),
  cap_user_micros bigint not null default 500000 check (cap_user_micros between 0 and 10000000000),
  alerts integer[] not null default array[50, 80, 100] check (alerts <@ array[50, 80, 100]),
  at_cap text not null default 'pause' check (at_cap in ('pause', 'alert_only')),
  alert_to text not null default 'owners_finance' check (alert_to in ('owners', 'owners_finance')),
  member_jobs_per_minute integer not null default 60 check (member_jobs_per_minute between 1 and 600),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint ai_settings_fallback check (bg_fallback <> bg_provider)
);
insert into public.ai_settings (id) values (1);
alter table public.ai_settings enable row level security;

create table public.ai_spend_daily (
  day date not null,
  feature text not null check (feature in ('bg_removal', 'scene_tags')),
  spent_micros bigint not null default 0 check (spent_micros >= 0),
  reserved_micros bigint not null default 0 check (reserved_micros >= 0),
  calls integer not null default 0 check (calls >= 0),
  photos integer not null default 0 check (photos >= 0),
  credits integer not null default 0 check (credits >= 0),
  primary key (day, feature)
);
alter table public.ai_spend_daily enable row level security;

create table public.ai_user_spend_daily (
  day date not null,
  owner_id uuid not null references auth.users (id) on delete cascade,
  spent_micros bigint not null default 0 check (spent_micros >= 0),
  reserved_micros bigint not null default 0 check (reserved_micros >= 0),
  primary key (day, owner_id)
);
alter table public.ai_user_spend_daily enable row level security;

-- One email per (day, scope, threshold).
create table public.ai_spend_alerts (
  day date not null,
  scope text not null check (scope in ('total', 'bg_removal', 'scene_tags')),
  threshold integer not null check (threshold in (50, 80, 100)),
  created_at timestamptz not null default now(),
  primary key (day, scope, threshold)
);
alter table public.ai_spend_alerts enable row level security;

-- A global cap refused work today (scope 'total' or a feature). Cleared when an admin changes the caps.
create table public.ai_spend_capped (
  day date not null,
  scope text not null check (scope in ('total', 'bg_removal', 'scene_tags')),
  created_at timestamptz not null default now(),
  primary key (day, scope)
);
alter table public.ai_spend_capped enable row level security;

-- Every provider call (no image, no member data beyond the job): AI jobs latency and provider health.
create table public.ai_calls (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  feature text not null check (feature in ('bg_removal', 'scene_tags')),
  provider text not null check (provider in ('runware', 'fal_bria', 'workers_ai')),
  role text not null check (role in ('primary', 'fallback')),
  ok boolean not null,
  ms integer not null check (ms between 0 and 600000),
  error text check (error is null or length(error) <= 40)
);
alter table public.ai_calls enable row level security;
create index ai_calls_at on public.ai_calls (at);

-- ---------------------------------------------------------------------------------------------
-- Members' AI settings and credits
-- ---------------------------------------------------------------------------------------------
create table public.ai_member_settings (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  face_grouping boolean not null default false,
  face_consent_at timestamptz,
  face_consent_version integer check (face_consent_version >= 1),
  scene_tags boolean not null default true,
  cleanup boolean not null default true,
  -- Set when the member has face data but their plan no longer has people grouping; data goes 30 days later.
  face_plan_lapsed_at timestamptz,
  face_lapse_warned_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint ai_member_consent check (not face_grouping or (face_consent_at is not null and face_consent_version is not null))
);
alter table public.ai_member_settings enable row level security;

create table public.credit_balances (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  period_start date not null,
  updated_at timestamptz not null default now()
);
alter table public.credit_balances enable row level security;

create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('bg_removal', 'device')),
  title text not null check (length(title) between 1 and 80),
  -- active → paused (device) | canceled. done / running / waiting are derived from the items.
  state text not null default 'active' check (state in ('active', 'paused', 'canceled')),
  apply jsonb check (apply is null or (jsonb_typeof(apply) = 'object' and octet_length(apply::text) <= 512)),
  params jsonb check (params is null or (jsonb_typeof(params) = 'object' and octet_length(params::text) <= 1024)),
  credits_charged integer not null default 0 check (credits_charged >= 0),
  credits_refunded integer not null default 0 check (credits_refunded >= 0),
  lease_device text check (lease_device is null or length(lease_device) between 1 and 40),
  lease_session text check (lease_session is null or length(lease_session) <= 64),
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint ai_jobs_kind_shape check ((kind = 'bg_removal') = (apply is not null) and (kind = 'device') = (params is not null))
);
alter table public.ai_jobs enable row level security;
create index ai_jobs_owner on public.ai_jobs (owner_id, created_at desc, id desc);
create index ai_jobs_finished on public.ai_jobs (finished_at) where finished_at is not null;

create table public.ai_job_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ai_jobs (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- Null once the photo is deleted for good (the item keeps its file name for the queue).
  photo_id uuid references public.photos (id) on delete set null,
  seq integer not null check (seq >= 0),
  filename text not null check (length(filename) between 1 and 255),
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed', 'canceled')),
  error text check (error in ('provider_timeout', 'provider_error', 'bad_output', 'no_preview', 'photo_deleted', 'feature_off', 'device_failed')),
  attempts integer not null default 0 check (attempts >= 0),
  provider text check (provider in ('runware', 'fal_bria')),
  -- Credits this item currently costs (0 once refunded) and which charge of it that is (retries charge again).
  credits integer not null default 0 check (credits >= 0),
  charge_seq integer not null default 0 check (charge_seq >= 0),
  reserved_micros bigint not null default 0 check (reserved_micros >= 0),
  reserved_day date,
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  latency_ms integer check (latency_ms between 0 and 3600000),
  mask_id uuid,
  wait_until timestamptz,
  enqueued_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (job_id, seq)
);
alter table public.ai_job_items enable row level security;
create index ai_job_items_due on public.ai_job_items (wait_until nulls first) where status = 'pending';
create index ai_job_items_processing on public.ai_job_items (started_at) where status = 'processing';
create index ai_job_items_photo on public.ai_job_items (photo_id) where status in ('pending', 'processing');
create index ai_job_items_failed on public.ai_job_items (finished_at) where status = 'failed';

create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  delta integer not null check (delta <> 0),
  reason text not null check (reason in ('monthly_grant', 'period_expiry', 'job_charge', 'job_refund', 'admin_adjust', 'top_up')),
  label text check (label is null or length(label) <= 160),
  job_id uuid references public.ai_jobs (id) on delete set null,
  item_id uuid,
  item_charge integer,
  period_start date not null,
  created_at timestamptz not null default now()
);
alter table public.credit_ledger enable row level security;
create index credit_ledger_owner on public.credit_ledger (owner_id, created_at desc, id desc);
create unique index credit_ledger_grant_once on public.credit_ledger (owner_id, period_start) where reason = 'monthly_grant';
create unique index credit_ledger_expiry_once on public.credit_ledger (owner_id, period_start) where reason = 'period_expiry';
create unique index credit_ledger_refund_once on public.credit_ledger (item_id, item_charge) where reason = 'job_refund';

-- ---------------------------------------------------------------------------------------------
-- Masks, signals, scenes
-- ---------------------------------------------------------------------------------------------
create table public.photo_masks (
  id uuid primary key,
  photo_id uuid not null references public.photos (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  key text not null unique,
  bytes integer not null check (bytes between 1 and 2097152),
  width integer not null check (width between 1 and 4096),
  height integer not null check (height between 1 and 4096),
  provider text not null check (provider in ('runware', 'fal_bria')),
  created_at timestamptz not null default now()
);
alter table public.photo_masks enable row level security;
create index photo_masks_photo on public.photo_masks (photo_id, created_at desc);

create table public.photo_signals (
  photo_id uuid primary key references public.photos (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  version integer not null check (version >= 1),
  phash bigint not null,
  sharpness real not null check (sharpness between 0 and 65025),
  brightness real not null check (brightness between 0 and 1),
  night boolean not null,
  dup_ignored boolean not null default false,
  blur_ignored boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.photo_signals enable row level security;
create index photo_signals_owner on public.photo_signals (owner_id);

alter table public.photos
  add column scene_state text check (scene_state in ('pending', 'done', 'failed', 'skipped')),
  add column scene_queued_at timestamptz,
  add column faces_version integer not null default 0 check (faces_version >= 0);
create index photos_scene_due on public.photos (created_at desc) where status = 'ready' and scene_state is null;

create table public.photo_scenes (
  photo_id uuid not null references public.photos (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  scene text not null check (scene in ('beach', 'mountains', 'forest', 'water', 'snow', 'flowers', 'food', 'pets',
                                       'animals', 'architecture', 'interiors', 'vehicles', 'documents')),
  score real not null check (score between 0 and 1),
  primary key (photo_id, scene)
);
alter table public.photo_scenes enable row level security;
create index photo_scenes_owner on public.photo_scenes (owner_id, scene);

-- ---------------------------------------------------------------------------------------------
-- Faces and people (opt-in). Embeddings never leave the database: no function returns them.
-- ---------------------------------------------------------------------------------------------
create table public.people (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text check (name is null or length(name) between 1 and 60),
  hidden boolean not null default false,
  -- Sum of the (unit-length) embeddings of its faces: cosine distance is scale-free, so this is its centroid.
  embedding_sum extensions.vector(128),
  face_count integer not null default 0 check (face_count >= 0),
  cover_face_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.people enable row level security;
create index people_owner on public.people (owner_id);

create table public.faces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  photo_id uuid not null references public.photos (id) on delete cascade,
  person_id uuid references public.people (id) on delete set null,
  box real[] not null check (array_length(box, 1) = 4 and 0 <= all (box) and 1.0001 >= all (box)),
  score real not null check (score between 0 and 1),
  embedding extensions.vector(128) not null,
  similarity real check (similarity between -1 and 1),
  assigned_by text not null default 'auto' check (assigned_by in ('auto', 'user')),
  confirmed boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.faces enable row level security;
create index faces_owner_person on public.faces (owner_id, person_id);
create index faces_photo on public.faces (photo_id);

create table public.face_rejections (
  face_id uuid not null references public.faces (id) on delete cascade,
  person_id uuid not null references public.people (id) on delete cascade,
  primary key (face_id, person_id)
);
alter table public.face_rejections enable row level security;

-- Masks, faces, scenes and signals always belong to their photo's owner, whoever writes them.
create function public._ai_same_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.photos p where p.id = new.photo_id and p.owner_id = new.owner_id) then
    raise exception 'row and photo belong to different owners' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger photo_masks_same_owner before insert or update of photo_id, owner_id on public.photo_masks
  for each row execute function public._ai_same_owner();
create trigger photo_signals_same_owner before insert or update of photo_id, owner_id on public.photo_signals
  for each row execute function public._ai_same_owner();
create trigger photo_scenes_same_owner before insert or update of photo_id, owner_id on public.photo_scenes
  for each row execute function public._ai_same_owner();
create trigger faces_same_owner before insert or update of photo_id, owner_id on public.faces
  for each row execute function public._ai_same_owner();

create function public._face_person_same_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.person_id is not null
     and not exists (select 1 from public.people p where p.id = new.person_id and p.owner_id = new.owner_id) then
    raise exception 'face and person belong to different owners' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger faces_person_same_owner before insert or update of person_id, owner_id on public.faces
  for each row execute function public._face_person_same_owner();

create function public._job_item_same_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.ai_jobs j where j.id = new.job_id and j.owner_id = new.owner_id)
     or (new.photo_id is not null
         and not exists (select 1 from public.photos p where p.id = new.photo_id and p.owner_id = new.owner_id)) then
    raise exception 'job item belongs to a different owner' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger ai_job_items_same_owner before insert or update of job_id, owner_id, photo_id on public.ai_job_items
  for each row execute function public._job_item_same_owner();

-- A saved edit may keep or drop its cut-out, but only ever point at a mask of the same photo.
create function public._edit_cutout_ok(p_photo uuid, p_owner uuid, p_recipe jsonb) returns boolean
language sql stable set search_path = '' as $$
  select p_recipe is null or not (p_recipe ? 'cutout')
      or (jsonb_typeof(p_recipe -> 'cutout') = 'object'
          and coalesce(p_recipe #>> '{cutout,mask}', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and exists (select 1 from public.photo_masks m
                       where m.id = (p_recipe #>> '{cutout,mask}')::uuid and m.photo_id = p_photo and m.owner_id = p_owner));
$$;
create function public._edit_cutout_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not public._edit_cutout_ok(new.photo_id, new.owner_id, new.recipe) then
    raise exception 'cut-out mask belongs to another photo' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger photo_edits_cutout before insert or update of recipe, photo_id, owner_id on public.photo_edits
  for each row execute function public._edit_cutout_guard();

-- ---------------------------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------------------------
create function public._ai_today() returns date
language sql stable set search_path = '' as $$ select (now() at time zone 'utc')::date $$;

create function public._ai_next_midnight() returns timestamptz
language sql stable set search_path = '' as $$ select ((now() at time zone 'utc')::date + 1)::timestamp at time zone 'utc' $$;

create function public._ai_period(p_at timestamptz default now()) returns date
language sql stable set search_path = '' as $$ select date_trunc('month', p_at at time zone 'utc')::date $$;

create function public._ai_rules(p_plan text,
  out cloud_credits_month integer, out credits_rollover boolean, out batch_size integer,
  out people_grouping boolean, out quality_cleanup boolean)
language sql stable set search_path = '' as $$
  select pl.cloud_credits_month, pl.credits_rollover, pl.batch_size, pl.people_grouping, pl.quality_cleanup
    from public.plan_limits pl
    join public.plan_limit_versions v on v.id = pl.version_id and v.status = 'active'
   where pl.plan_id = p_plan;
$$;

create function public._ai_plan(p_owner uuid) returns text
language sql stable set search_path = '' as $$
  select coalesce((select p.plan_id from public.profiles p where p.id = p_owner), 'free');
$$;

create function public._ai_settings() returns public.ai_settings
language sql stable set search_path = '' as $$ select * from public.ai_settings where id = 1 $$;

create function public._ai_feature(s public.ai_settings, p_feature text) returns boolean
language sql immutable set search_path = '' as $$
  select s.enabled and case p_feature
    when 'auto_enhance' then s.f_auto_enhance when 'hdr' then s.f_hdr when 'color_match' then s.f_color_match
    when 'cleanup' then s.f_cleanup when 'face_grouping' then s.f_face_grouping
    when 'scene_tags' then s.f_scene_tags when 'bg_removal' then s.f_bg_removal else false end;
$$;

-- The member's settings, with defaults when they never changed any.
create function public._ai_member(p_owner uuid,
  out face_grouping boolean, out face_consent_at timestamptz, out scene_tags boolean, out cleanup boolean)
language sql stable set search_path = '' as $$
  select coalesce(m.face_grouping, false), m.face_consent_at, coalesce(m.scene_tags, true), coalesce(m.cleanup, true)
    from (select 1) one left join public.ai_member_settings m on m.owner_id = p_owner;
$$;

create function public._ai_settings_json(s public.ai_settings) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'enabled', s.enabled,
    'cloudPaused', s.cloud_paused,
    'features', jsonb_build_object('auto_enhance', s.f_auto_enhance, 'hdr', s.f_hdr, 'color_match', s.f_color_match,
                                   'cleanup', s.f_cleanup, 'face_grouping', s.f_face_grouping,
                                   'scene_tags', s.f_scene_tags, 'bg_removal', s.f_bg_removal),
    'bgProvider', s.bg_provider,
    'bgFallback', s.bg_fallback,
    'runwareModel', s.runware_model,
    'falModel', s.fal_model,
    'sceneModel', s.scene_model,
    'bgCreditsPerPhoto', s.bg_credits_per_photo,
    'costs', jsonb_build_object('runwareMicros', s.cost_runware_micros, 'falMicros', s.cost_fal_micros,
                                'sceneMicros', s.cost_scene_micros),
    'caps', jsonb_build_object('total', s.cap_total_micros / 1000000.0, 'bgRemoval', s.cap_bg_micros / 1000000.0,
                               'sceneTags', s.cap_scene_micros / 1000000.0, 'perUser', s.cap_user_micros / 1000000.0),
    'alerts', to_jsonb(s.alerts),
    'atCap', s.at_cap,
    'alertTo', s.alert_to,
    'memberJobsPerMinute', s.member_jobs_per_minute,
    'updatedAt', s.updated_at,
    'updatedBy', s.updated_by);
$$;

-- Today's spend, in USD (spent + reserved), and whether a cap holds cloud work.
create function public._ai_spend_json() returns jsonb
language sql stable set search_path = '' as $$
  with d as (
    select coalesce(sum(spent_micros + reserved_micros) filter (where feature = 'bg_removal'), 0) as bg,
           coalesce(sum(spent_micros + reserved_micros) filter (where feature = 'scene_tags'), 0) as sc,
           coalesce(sum(credits), 0) as credits,
           coalesce(sum(photos) filter (where feature = 'bg_removal'), 0) as photos
      from public.ai_spend_daily where day = public._ai_today()
  )
  select jsonb_build_object(
    'day', public._ai_today(),
    'totalUsd', round((d.bg + d.sc) / 1000000.0, 4),
    'bgRemovalUsd', round(d.bg / 1000000.0, 4),
    'sceneTagsUsd', round(d.sc / 1000000.0, 4),
    'capped', s.at_cap = 'pause' and (d.bg + d.sc >= s.cap_total_micros or d.bg >= s.cap_bg_micros or d.sc >= s.cap_scene_micros
                                      or exists (select 1 from public.ai_spend_capped c where c.day = public._ai_today())),
    'credits', d.credits,
    'photos', d.photos)
  from d cross join public.ai_settings s where s.id = 1;
$$;

-- Null, or why cloud work waits: {reason: 'admin' | 'cap', until}.
create function public._ai_cloud_paused() returns jsonb
language sql stable set search_path = '' as $$
  select case when s.cloud_paused then jsonb_build_object('reason', 'admin', 'until', null)
              when (public._ai_spend_json() ->> 'capped')::boolean
                then jsonb_build_object('reason', 'cap', 'until', public._ai_next_midnight())
         end
    from public.ai_settings s where s.id = 1;
$$;

-- Reserves p_micros of today's spend for one call. Under the day's lock, so parallel callers can't pass a cap.
-- Returns {ok: true, alerts: [...]} | {ok: false, capped: 'total' | 'feature' | 'user', alerts: [...]}.
-- Alerts are each (day, scope, threshold) newly crossed; they're returned once, for the Worker to email.
create function public._ai_spend_reserve(p_feature text, p_owner uuid, p_micros bigint) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  s public.ai_settings := public._ai_settings();
  d date := public._ai_today();
  tot bigint;
  feat bigint;
  usr bigint;
  cap_f bigint;
  capped text;
  alerts jsonb := '[]'::jsonb;
  scope text;
  used bigint;
  cap bigint;
  thr integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('zephyr:ai-spend:' || d::text, 0));
  select coalesce(sum(spent_micros + reserved_micros), 0),
         coalesce(sum(spent_micros + reserved_micros) filter (where feature = p_feature), 0)
    into tot, feat from public.ai_spend_daily where day = d;
  select coalesce(sum(spent_micros + reserved_micros), 0) into usr
    from public.ai_user_spend_daily where day = d and owner_id = p_owner;
  cap_f := case p_feature when 'bg_removal' then s.cap_bg_micros else s.cap_scene_micros end;
  -- The per-member cap always holds; the global caps pause only with at_cap 'pause'.
  if usr + p_micros > s.cap_user_micros then
    capped := 'user';
  elsif s.at_cap = 'pause' and tot + p_micros > s.cap_total_micros then
    capped := 'total';
  elsif s.at_cap = 'pause' and feat + p_micros > cap_f then
    capped := 'feature';
  end if;
  if capped in ('total', 'feature') then
    insert into public.ai_spend_capped (day, scope) values (d, case capped when 'total' then 'total' else p_feature end)
    on conflict do nothing;
  end if;
  if capped is null then
    insert into public.ai_spend_daily (day, feature, reserved_micros) values (d, p_feature, p_micros)
    on conflict (day, feature) do update set reserved_micros = public.ai_spend_daily.reserved_micros + excluded.reserved_micros;
    insert into public.ai_user_spend_daily (day, owner_id, reserved_micros) values (d, p_owner, p_micros)
    on conflict (day, owner_id) do update set reserved_micros = public.ai_user_spend_daily.reserved_micros + excluded.reserved_micros;
    tot := tot + p_micros;
    feat := feat + p_micros;
  end if;
  -- Thresholds crossed (a global cap that holds work counts as 100%).
  foreach scope in array array['total', p_feature] loop
    used := case scope when 'total' then tot else feat end;
    cap := case scope when 'total' then s.cap_total_micros else cap_f end;
    if capped = (case scope when 'total' then 'total' else 'feature' end) then used := greatest(used, cap); end if;
    foreach thr in array s.alerts loop
      continue when not (cap = 0 or used * 100 >= cap * thr::bigint);
      insert into public.ai_spend_alerts (day, scope, threshold) values (d, scope, thr) on conflict do nothing;
      if found then
        alerts := alerts || jsonb_build_array(jsonb_build_object('scope', scope, 'threshold', thr,
          'usedUsd', round(used / 1000000.0, 2), 'capUsd', round(cap / 1000000.0, 2)));
      end if;
    end loop;
  end loop;
  return jsonb_build_object('ok', capped is null, 'capped', capped, 'alerts', alerts);
end;
$$;

-- Settles a reservation made on p_day: the reserved amount goes, the real cost is counted.
create function public._ai_spend_settle(p_feature text, p_owner uuid, p_day date, p_reserved bigint, p_spent bigint,
  p_photos integer default 0, p_credits integer default 0) returns void
language plpgsql volatile set search_path = '' as $$
declare
  d date := coalesce(p_day, public._ai_today());
begin
  perform pg_advisory_xact_lock(hashtextextended('zephyr:ai-spend:' || d::text, 0));
  insert into public.ai_spend_daily (day, feature) values (d, p_feature) on conflict do nothing;
  update public.ai_spend_daily
     set reserved_micros = greatest(0, reserved_micros - greatest(coalesce(p_reserved, 0), 0)),
         spent_micros = spent_micros + greatest(coalesce(p_spent, 0), 0),
         calls = calls + 1,
         photos = photos + greatest(p_photos, 0),
         credits = credits + greatest(p_credits, 0)
   where day = d and feature = p_feature;
  insert into public.ai_user_spend_daily (day, owner_id) values (d, p_owner) on conflict do nothing;
  update public.ai_user_spend_daily
     set reserved_micros = greatest(0, reserved_micros - greatest(coalesce(p_reserved, 0), 0)),
         spent_micros = spent_micros + greatest(coalesce(p_spent, 0), 0)
   where day = d and owner_id = p_owner;
end;
$$;

-- Provider calls for the AI jobs page. p_calls: [{provider, role, ok, ms, error}] (at most 5 kept).
create function public._ai_log_calls(p_feature text, p_calls jsonb) returns void
language sql volatile set search_path = '' as $$
  insert into public.ai_calls (feature, provider, role, ok, ms, error)
  select p_feature, c.value ->> 'provider', coalesce(c.value ->> 'role', 'primary'), coalesce((c.value ->> 'ok')::boolean, false),
         least(greatest(coalesce((c.value ->> 'ms')::integer, 0), 0), 600000), left(c.value ->> 'error', 40)
    from jsonb_array_elements(case when jsonb_typeof(p_calls) = 'array' then p_calls else '[]'::jsonb end) with ordinality c(value, n)
   where c.n <= 5 and c.value ->> 'provider' in ('runware', 'fal_bria', 'workers_ai')
     and coalesce(c.value ->> 'role', 'primary') in ('primary', 'fallback');
$$;

-- ---- credits ---------------------------------------------------------------------------------
create function public._credits_lock(p_owner uuid) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('zephyr:credits:' || p_owner::text, 0));
$$;

-- Brings the member's balance into the current period (call under the credits lock): unused credits of a
-- past period expire unless the plan rolls them over, then the plan's monthly credits are granted. Idempotent.
create function public._credits_roll(p_owner uuid) returns public.credit_balances
language plpgsql volatile set search_path = '' as $$
declare
  cur date := public._ai_period();
  b public.credit_balances;
  r record;
begin
  select * into r from public._ai_rules(public._ai_plan(p_owner));
  select * into b from public.credit_balances where owner_id = p_owner for update;
  if not found then
    insert into public.credit_balances (owner_id, balance, period_start) values (p_owner, 0, cur) returning * into b;
  elsif b.period_start >= cur then
    return b;
  else
    if not coalesce(r.credits_rollover, false) and b.balance > 0 then
      insert into public.credit_ledger (owner_id, delta, reason, label, period_start)
      values (p_owner, -b.balance, 'period_expiry', 'Unused credits from ' || to_char(b.period_start, 'FMMonth YYYY') || ' expired', b.period_start)
      on conflict do nothing;
      if found then b.balance := 0; end if;
    end if;
    b.period_start := cur;
  end if;
  if coalesce(r.cloud_credits_month, 0) > 0 then
    insert into public.credit_ledger (owner_id, delta, reason, label, period_start)
    values (p_owner, r.cloud_credits_month, 'monthly_grant', 'Monthly credits', cur)
    on conflict do nothing;
    if found then b.balance := b.balance + r.cloud_credits_month; end if;
  end if;
  update public.credit_balances set balance = b.balance, period_start = b.period_start, updated_at = now()
   where owner_id = p_owner returning * into b;
  return b;
end;
$$;

create function public._credits_json(b public.credit_balances) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'balance', b.balance,
    'monthly', coalesce(r.cloud_credits_month, 0),
    'periodStart', b.period_start,
    'periodEnd', (b.period_start + interval '1 month')::date,
    'rollover', coalesce(r.credits_rollover, false),
    'bgCreditsPerPhoto', (select s.bg_credits_per_photo from public.ai_settings s where s.id = 1))
  from public._ai_rules(public._ai_plan(b.owner_id)) r;
$$;

-- Refunds an item's current charge once (call under the owner's credits lock, with the item row locked).
create function public._ai_refund_item(p_item uuid) returns integer
language plpgsql volatile set search_path = '' as $$
declare
  it public.ai_job_items;
  b public.credit_balances;
begin
  select * into it from public.ai_job_items where id = p_item;
  if not found or it.credits <= 0 then return 0; end if;
  b := public._credits_roll(it.owner_id);
  insert into public.credit_ledger (owner_id, delta, reason, label, job_id, item_id, item_charge, period_start)
  values (it.owner_id, it.credits, 'job_refund', 'Refund · ' || left(it.filename, 140), it.job_id, it.id, it.charge_seq, b.period_start)
  on conflict do nothing;
  if not found then
    update public.ai_job_items set credits = 0 where id = p_item;
    return 0;
  end if;
  update public.credit_balances set balance = balance + it.credits, updated_at = now() where owner_id = it.owner_id;
  update public.ai_jobs set credits_refunded = credits_refunded + it.credits, updated_at = now() where id = it.job_id;
  update public.ai_job_items set credits = 0 where id = p_item;
  return it.credits;
end;
$$;

-- ---- jobs ------------------------------------------------------------------------------------
create function public._ai_job_json(j public.ai_jobs, p_session text default null) returns jsonb
language sql stable set search_path = '' as $$
  with c as (
    select count(*)::integer as total,
           count(*) filter (where status = 'pending')::integer as pending,
           count(*) filter (where status = 'processing')::integer as processing,
           count(*) filter (where status = 'completed')::integer as completed,
           count(*) filter (where status = 'failed')::integer as failed,
           count(*) filter (where status = 'canceled')::integer as canceled,
           count(*) filter (where status = 'pending' and wait_until > now())::integer as waiting,
           (array_agg(photo_id order by seq) filter (where photo_id is not null))[1] as cover
      from public.ai_job_items where job_id = j.id
  )
  select jsonb_build_object(
    'id', j.id,
    'kind', j.kind,
    'title', j.title,
    'status', case
       when j.state = 'canceled' then 'canceled'
       when c.pending + c.processing = 0 then 'done'
       when j.state = 'paused' then 'paused'
       when c.processing > 0 then 'running'
       when j.kind = 'device' and j.lease_until > now() then 'running'
       when j.kind = 'device' then 'waiting'
       when c.waiting = c.pending then 'waiting'
       else 'queued' end,
    'createdAt', j.created_at,
    'updatedAt', j.updated_at,
    'finishedAt', j.finished_at,
    'counts', jsonb_build_object('total', c.total, 'pending', c.pending, 'processing', c.processing,
                                 'completed', c.completed, 'failed', c.failed, 'canceled', c.canceled),
    'credits', jsonb_build_object('charged', j.credits_charged, 'refunded', j.credits_refunded),
    'apply', j.apply,
    'params', j.params,
    'holder', case when j.kind = 'device' and j.lease_until > now() and j.state = 'active'
                   then jsonb_build_object('device', j.lease_device, 'until', j.lease_until,
                                           'self', p_session is not null and j.lease_session = p_session) end,
    'coverPhotoId', c.cover)
  from c;
$$;

create function public._ai_item_json(i public.ai_job_items) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', i.id,
    'photoId', i.photo_id,
    'filename', i.filename,
    'status', i.status,
    'error', i.error,
    'credits', i.credits,
    'maskId', i.mask_id,
    'retryable', i.status = 'failed' and i.photo_id is not null
                 and coalesce(i.error, '') not in ('photo_deleted', 'device_failed'));
$$;

-- Marks the job finished once nothing is left to do.
create function public._ai_job_touch(p_job uuid) returns void
language sql volatile set search_path = '' as $$
  update public.ai_jobs j
     set updated_at = now(),
         finished_at = case when not exists (select 1 from public.ai_job_items i
                                              where i.job_id = j.id and i.status in ('pending', 'processing'))
                            then coalesce(j.finished_at, now()) end,
         lease_device = case when exists (select 1 from public.ai_job_items i
                                           where i.job_id = j.id and i.status in ('pending', 'processing'))
                             then j.lease_device end,
         lease_session = case when exists (select 1 from public.ai_job_items i
                                            where i.job_id = j.id and i.status in ('pending', 'processing'))
                              then j.lease_session end,
         lease_until = case when exists (select 1 from public.ai_job_items i
                                          where i.job_id = j.id and i.status in ('pending', 'processing'))
                            then j.lease_until end
   where j.id = p_job;
$$;

-- Fails an item (row locked, owner's credits lock held) and refunds it.
create function public._ai_item_fail(p_item uuid, p_error text) returns void
language plpgsql volatile set search_path = '' as $$
declare
  it public.ai_job_items;
begin
  select * into it from public.ai_job_items where id = p_item;
  if it.status in ('completed', 'failed', 'canceled') then return; end if;
  if it.reserved_micros > 0 then
    perform public._ai_spend_settle('bg_removal', it.owner_id, it.reserved_day, it.reserved_micros, 0);
  end if;
  update public.ai_job_items
     set status = 'failed', error = p_error, finished_at = now(), reserved_micros = 0, wait_until = null
   where id = p_item;
  perform public._ai_refund_item(p_item);
  perform public._ai_job_touch(it.job_id);
end;
$$;

-- The R2 key of a mask (built from the uuids' own text form, so always canonical).
create function public._mask_key(p_owner uuid, p_photo uuid, p_mask uuid) returns text
language sql immutable set search_path = '' as $$
  select public._r2_prefix(p_owner, p_photo) || 'm/' || p_mask::text || '.png';
$$;

-- original, thumb, preview, the two staging keys, edited variants, then the photo's masks.
create or replace function public._photo_keys(p_owner uuid, p_photo uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_array(
    public._r2_prefix(p_owner, p_photo) || 'original',
    public._r2_prefix(p_owner, p_photo) || 'thumb',
    public._r2_prefix(p_owner, p_photo) || 'preview',
    public._staging_prefix(p_owner, p_photo) || 'thumb',
    public._staging_prefix(p_owner, p_photo) || 'preview')
  || coalesce((select public._edit_keys(e) from public.photo_edits e where e.photo_id = p_photo and e.owner_id = p_owner),
              '[]'::jsonb)
  || coalesce((select jsonb_agg(m.key order by m.created_at) from public.photo_masks m
                where m.photo_id = p_photo and m.owner_id = p_owner), '[]'::jsonb);
$$;

-- Orphan sweep: rows also list their recorded masks.
create or replace function public.sweep_photo_rows(p_ids uuid[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'ownerId', p.owner_id, 'status', p.status,
           'activeUpload', exists (select 1 from public.uploads u where u.photo_id = p.id),
           'editThumbKey', e.thumb_key,
           'editPreviewKey', e.preview_key,
           'maskKeys', coalesce((select jsonb_agg(m.key) from public.photo_masks m where m.photo_id = p.id), '[]'::jsonb))), '[]'::jsonb)
    from public.photos p left join public.photo_edits e on e.photo_id = p.id
   where p.id = any (p_ids[1:1000]);
$$;

-- save_edit (phase 4) refuses a cut-out that points at a mask the photo doesn't own: {status: 'invalid'}.
create or replace function public.save_edit(p_owner uuid, p_photo uuid, p_recipe jsonb, p_base_version integer) returns jsonb
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
  if not public._edit_cutout_ok(p_photo, p_owner, p_recipe) then
    return jsonb_build_object('status', 'invalid');
  end if;
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

-- ---------------------------------------------------------------------------------------------
-- list_photos gains the scene and person filters (phase 6); everything else is as in phase 4.
-- ---------------------------------------------------------------------------------------------
drop function public.list_photos(uuid, text, uuid, text, date, date, text, text, integer);
create function public.list_photos(
  p_owner uuid,
  p_view text default 'library',
  p_album uuid default null,
  p_q text default null,
  p_from date default null,
  p_to date default null,
  p_sort text default 'taken',
  p_cursor text default null,
  p_limit integer default 60,
  p_scene text default null,
  p_person uuid default null
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
  if p_person is not null and not exists (select 1 from public.people pe where pe.id = p_person and pe.owner_id = p_owner) then
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
           and ($11::text is null
                or ($11 = 'night' and exists (select 1 from public.photo_signals s where s.photo_id = p.id and s.night))
                or ($11 <> 'night' and exists (select 1 from public.photo_scenes sc
                                                where sc.photo_id = p.id and sc.owner_id = $1 and sc.scene = $11)))
           and ($12::uuid is null or exists (select 1 from public.faces f
                                              where f.photo_id = p.id and f.owner_id = $1 and f.person_id = $12))
         order by p.%1$I desc, p.id desc
         limit $10 + 1
      ) x
  $sql$, col)
  into items, total, last_at, last_id
  using p_owner, case when p_view = 'trash' then 'trashed' else 'ready' end, coalesce(p_view, 'library'),
        p_album, pattern, p_from, p_to, c_at, c_id, lim, p_scene, p_person;

  return jsonb_build_object(
    'items', items,
    'nextCursor', case when total > lim then public._cursor(last_at, last_id) end);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Member: status, settings, credits
-- ---------------------------------------------------------------------------------------------
-- AiStatus for the member (rolls their credits into the current period first).
create function public.ai_status(p_owner uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.ai_settings := public._ai_settings();
  r record;
  m record;
  b public.credit_balances;
  paused jsonb := public._ai_cloud_paused();
  f text;
  st text;
  states jsonb := '{}'::jsonb;
begin
  if not exists (select 1 from public.profiles where id = p_owner) then return null; end if;
  select * into r from public._ai_rules(public._ai_plan(p_owner));
  select * into m from public._ai_member(p_owner);
  perform public._credits_lock(p_owner);
  b := public._credits_roll(p_owner);
  foreach f in array array['auto_enhance', 'hdr', 'color_match', 'cleanup', 'face_grouping', 'scene_tags', 'bg_removal'] loop
    st := case
      when not public._ai_feature(s, f) then 'off_admin'
      when f = 'face_grouping' and not coalesce(r.people_grouping, false) then 'off_plan'
      when f = 'cleanup' and not coalesce(r.quality_cleanup, false) then 'off_plan'
      when f = 'face_grouping' and not m.face_grouping then 'off_member'
      when f = 'scene_tags' and not m.scene_tags then 'off_member'
      when f = 'cleanup' and not m.cleanup then 'off_member'
      when f in ('scene_tags', 'bg_removal') and paused is not null then 'paused'
      else 'on' end;
    states := states || jsonb_build_object(f, st);
  end loop;
  return jsonb_build_object(
    'enabled', s.enabled,
    'features', states,
    'cloudPaused', paused,
    'member', jsonb_build_object('faceGrouping', m.face_grouping, 'faceConsentAt', m.face_consent_at,
                                 'sceneTags', m.scene_tags, 'cleanup', m.cleanup),
    'credits', public._credits_json(b),
    'batchSize', coalesce(r.batch_size, 25));
end;
$$;

-- Deletes all of the owner's face data and turns face grouping off. Returns the number of faces deleted.
create function public._ai_faces_delete(p_owner uuid) returns integer
language plpgsql volatile set search_path = '' as $$
declare
  n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('zephyr:faces:' || p_owner::text, 0));
  delete from public.faces where owner_id = p_owner;
  get diagnostics n = row_count;
  delete from public.people where owner_id = p_owner;
  update public.photos set faces_version = 0 where owner_id = p_owner and faces_version <> 0;
  update public.ai_member_settings
     set face_grouping = false, face_consent_at = null, face_consent_version = null,
         face_plan_lapsed_at = null, face_lapse_warned_at = null, updated_at = now()
   where owner_id = p_owner;
  return n;
end;
$$;

-- Applies AiMemberSettingsPatch (validated by the Worker). Returns AiStatus, or {error: 'plan' | 'consent' | 'feature_off'}.
create function public.ai_member_settings_update(p_owner uuid, p_patch jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.ai_settings := public._ai_settings();
  r record;
  m record;
  want_faces boolean := (p_patch ->> 'faceGrouping')::boolean;
  want_scenes boolean := (p_patch ->> 'sceneTags')::boolean;
  want_cleanup boolean := (p_patch ->> 'cleanup')::boolean;
  consent_v integer := (p_patch #>> '{faceConsent,version}')::integer;
  n integer;
begin
  if not exists (select 1 from public.profiles where id = p_owner) then return null; end if;
  select * into r from public._ai_rules(public._ai_plan(p_owner));
  select * into m from public._ai_member(p_owner);
  insert into public.ai_member_settings (owner_id) values (p_owner) on conflict do nothing;
  if want_faces is true and not m.face_grouping then
    if not public._ai_feature(s, 'face_grouping') then return jsonb_build_object('error', 'feature_off'); end if;
    if not coalesce(r.people_grouping, false) then return jsonb_build_object('error', 'plan'); end if;
    if consent_v is null or consent_v < 1 or (p_patch #>> '{faceConsent,rightsConfirmed}') is distinct from 'true' then
      return jsonb_build_object('error', 'consent');
    end if;
    update public.ai_member_settings
       set face_grouping = true, face_consent_at = now(), face_consent_version = consent_v,
           face_plan_lapsed_at = null, face_lapse_warned_at = null, updated_at = now()
     where owner_id = p_owner;
    perform public._audit(p_owner, 'ai.face_grouping.on', p_owner::text, jsonb_build_object('consentVersion', consent_v));
  elsif want_faces is false then
    n := public._ai_faces_delete(p_owner);
    if m.face_grouping or n > 0 then
      perform public._audit(p_owner, 'ai.face_grouping.off', p_owner::text, jsonb_build_object('faces', n));
    end if;
  end if;
  if want_scenes is not null then
    update public.ai_member_settings set scene_tags = want_scenes, updated_at = now() where owner_id = p_owner;
    if not want_scenes then
      delete from public.photo_scenes where owner_id = p_owner;
      update public.photos set scene_state = null, scene_queued_at = null
       where owner_id = p_owner and scene_state is not null;
    end if;
  end if;
  if want_cleanup is not null then
    update public.ai_member_settings set cleanup = want_cleanup, updated_at = now() where owner_id = p_owner;
  end if;
  return public.ai_status(p_owner);
end;
$$;

-- CreditHistoryPage: {balance, entries, nextCursor}, newest first.
create function public.ai_credit_history(p_owner uuid, p_cursor text default null, p_limit integer default 50) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  b public.credit_balances;
  c_at timestamptz;
  c_id uuid;
  rows jsonb;
  n integer;
  last_at timestamptz;
  last_id uuid;
begin
  if not exists (select 1 from public.profiles where id = p_owner) then return null; end if;
  perform public._credits_lock(p_owner);
  b := public._credits_roll(p_owner);
  select c.at, c.id into c_at, c_id from public._parse_cursor(p_cursor) c;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'at', x.created_at, 'delta', x.delta, 'reason', x.reason,
                                               'label', x.label, 'jobId', x.job_id) order by x.created_at desc, x.id desc)
                    filter (where x.rn <= lim), '[]'::jsonb),
         count(*)::integer,
         max(x.created_at) filter (where x.rn = lim),
         (array_agg(x.id) filter (where x.rn = lim))[1]
    into rows, n, last_at, last_id
    from (select l.*, row_number() over (order by l.created_at desc, l.id desc) rn
            from public.credit_ledger l
           where l.owner_id = p_owner and (c_at is null or (l.created_at, l.id) < (c_at, c_id))
           order by l.created_at desc, l.id desc limit lim + 1) x;
  return jsonb_build_object('balance', public._credits_json(b), 'entries', rows,
                            'nextCursor', case when n > lim then public._cursor(last_at, last_id) end);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Member: jobs
-- ---------------------------------------------------------------------------------------------
-- Creates a background-removal job and charges for it in one go. p_apply is the normalised CutoutApply.
-- Returns {job, items: [itemId], skipped} | {error: 'feature_off' | 'batch' | 'rate_limited' | 'no_photos',
-- skipped?} | {error: 'insufficient_credits', needed, balance}.
create function public.ai_bg_job_create(p_owner uuid, p_photo_ids uuid[], p_apply jsonb, p_title text, p_force boolean)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.ai_settings := public._ai_settings();
  r record;
  b public.credit_balances;
  ids uuid[];
  skipped jsonb := '[]'::jsonb;
  ok_ids uuid[] := '{}';
  pid uuid;
  ph public.photos;
  needed integer;
  j public.ai_jobs;
  title text := nullif(btrim(regexp_replace(coalesce(p_title, ''), '[[:cntrl:]]', '', 'g')), '');
  n integer := 0;
begin
  if not exists (select 1 from public.profiles where id = p_owner) then return null; end if;
  if not public._ai_feature(s, 'bg_removal') then return jsonb_build_object('error', 'feature_off'); end if;
  if p_apply is null or jsonb_typeof(p_apply) <> 'object' or octet_length(p_apply::text) > 512
     or p_apply ->> 'bg' not in ('transparent', 'white', 'color', 'original') then
    return jsonb_build_object('error', 'invalid');
  end if;
  select * into r from public._ai_rules(public._ai_plan(p_owner));
  -- Distinct ids in the order given.
  select array_agg(x.id order by x.n) into ids
    from (select distinct on (u.id) u.id, u.n from unnest(p_photo_ids) with ordinality u(id, n) order by u.id, u.n) x;
  if ids is null or cardinality(ids) = 0 then return jsonb_build_object('error', 'no_photos', 'skipped', skipped); end if;
  if cardinality(ids) > coalesce(r.batch_size, 25) then return jsonb_build_object('error', 'batch'); end if;

  perform public._credits_lock(p_owner);
  if (select count(*) from public.ai_jobs where owner_id = p_owner and created_at > now() - interval '1 minute')
     >= s.member_jobs_per_minute then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  foreach pid in array ids loop
    select * into ph from public.photos where id = pid and owner_id = p_owner and status = 'ready';
    if not found or ph.safety_hold_at is not null then
      skipped := skipped || jsonb_build_array(jsonb_build_object('photoId', pid, 'reason', 'not_found'));
    elsif not ph.has_preview then
      skipped := skipped || jsonb_build_array(jsonb_build_object('photoId', pid, 'reason', 'no_preview'));
    elsif exists (select 1 from public.ai_job_items i join public.ai_jobs jj on jj.id = i.job_id
                   where i.photo_id = pid and i.status in ('pending', 'processing') and jj.kind = 'bg_removal')
       or (not coalesce(p_force, false)
           and exists (select 1 from public.photo_edits e where e.photo_id = pid and e.recipe ? 'cutout')) then
      skipped := skipped || jsonb_build_array(jsonb_build_object('photoId', pid, 'reason', 'already_cut_out'));
    else
      ok_ids := ok_ids || pid;
    end if;
  end loop;
  if cardinality(ok_ids) = 0 then return jsonb_build_object('error', 'no_photos', 'skipped', skipped); end if;

  b := public._credits_roll(p_owner);
  needed := cardinality(ok_ids) * s.bg_credits_per_photo;
  if b.balance < needed then
    return jsonb_build_object('error', 'insufficient_credits', 'needed', needed, 'balance', b.balance);
  end if;
  insert into public.ai_jobs (owner_id, kind, title, apply, credits_charged)
  values (p_owner, 'bg_removal',
          left(coalesce(title, 'Background removal · ' || cardinality(ok_ids) || case when cardinality(ok_ids) = 1 then ' photo' else ' photos' end), 80),
          p_apply, needed)
  returning * into j;
  insert into public.ai_job_items (job_id, owner_id, photo_id, seq, filename, credits, charge_seq)
  select j.id, p_owner, u.id, (u.n - 1)::integer, p.filename, s.bg_credits_per_photo, 1
    from unnest(ok_ids) with ordinality u(id, n) join public.photos p on p.id = u.id;
  insert into public.credit_ledger (owner_id, delta, reason, label, job_id, period_start)
  values (p_owner, -needed, 'job_charge', left(j.title, 120) || case when j.title like '%photo%' then '' else ' · ' || cardinality(ok_ids) || ' photos' end,
          j.id, b.period_start);
  update public.credit_balances set balance = balance - needed, updated_at = now() where owner_id = p_owner;
  return jsonb_build_object('job', public._ai_job_json(j),
                            'items', (select jsonb_agg(i.id order by i.seq) from public.ai_job_items i where i.job_id = j.id),
                            'skipped', skipped);
end;
$$;

-- Creates a device job, held by the creating session. Returns {job, remaining, skipped} | {error}.
create function public.ai_device_job_create(p_owner uuid, p_photo_ids uuid[], p_params jsonb, p_title text,
  p_device text, p_session text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.ai_settings := public._ai_settings();
  r record;
  ids uuid[];
  ok_ids uuid[] := '{}';
  skipped jsonb := '[]'::jsonb;
  pid uuid;
  step text;
  j public.ai_jobs;
  title text := nullif(btrim(regexp_replace(coalesce(p_title, ''), '[[:cntrl:]]', '', 'g')), '');
  device text := left(nullif(btrim(regexp_replace(coalesce(p_device, ''), '[[:cntrl:]]', '', 'g')), ''), 40);
begin
  if not exists (select 1 from public.profiles where id = p_owner) then return null; end if;
  if p_params is null or jsonb_typeof(p_params) <> 'object' or jsonb_typeof(p_params -> 'steps') <> 'array'
     or jsonb_array_length(p_params -> 'steps') = 0 or device is null then
    return jsonb_build_object('error', 'invalid');
  end if;
  for step in select jsonb_array_elements_text(p_params -> 'steps') loop
    if step not in ('auto_enhance', 'hdr', 'color_match') then return jsonb_build_object('error', 'invalid'); end if;
    if not public._ai_feature(s, step) then return jsonb_build_object('error', 'feature_off'); end if;
  end loop;
  if p_params ? 'reference' and not exists (select 1 from public.photos p where p.id = (p_params ->> 'reference')::uuid
                                             and p.owner_id = p_owner and p.status = 'ready') then
    return jsonb_build_object('error', 'invalid');
  end if;
  select * into r from public._ai_rules(public._ai_plan(p_owner));
  select array_agg(x.id order by x.n) into ids
    from (select distinct on (u.id) u.id, u.n from unnest(p_photo_ids) with ordinality u(id, n) order by u.id, u.n) x;
  if ids is null or cardinality(ids) = 0 then return jsonb_build_object('error', 'no_photos', 'skipped', skipped); end if;
  if cardinality(ids) > coalesce(r.batch_size, 25) then return jsonb_build_object('error', 'batch'); end if;
  perform public._credits_lock(p_owner);
  if (select count(*) from public.ai_jobs where owner_id = p_owner and created_at > now() - interval '1 minute')
     >= s.member_jobs_per_minute then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  foreach pid in array ids loop
    if exists (select 1 from public.photos p where p.id = pid and p.owner_id = p_owner and p.status = 'ready') then
      ok_ids := ok_ids || pid;
    else
      skipped := skipped || jsonb_build_array(jsonb_build_object('photoId', pid, 'reason', 'not_found'));
    end if;
  end loop;
  if cardinality(ok_ids) = 0 then return jsonb_build_object('error', 'no_photos', 'skipped', skipped); end if;
  insert into public.ai_jobs (owner_id, kind, title, params, lease_device, lease_session, lease_until)
  values (p_owner, 'device',
          left(coalesce(title, 'Zephyr AI · ' || cardinality(ok_ids) || case when cardinality(ok_ids) = 1 then ' photo' else ' photos' end), 80),
          p_params, device, left(p_session, 64), now() + interval '120 seconds')
  returning * into j;
  insert into public.ai_job_items (job_id, owner_id, photo_id, seq, filename)
  select j.id, p_owner, u.id, (u.n - 1)::integer, p.filename
    from unnest(ok_ids) with ordinality u(id, n) join public.photos p on p.id = u.id;
  return jsonb_build_object('job', public._ai_job_json(j, p_session), 'remaining', to_jsonb(ok_ids), 'skipped', skipped);
end;
$$;

-- AiJobPage: jobs of one tab ('running' | 'finished' | 'failed'), newest first, plus the tab counts.
create function public.ai_jobs_list(p_owner uuid, p_state text, p_cursor text default null, p_session text default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  lim integer := 30;
  c_at timestamptz;
  c_id uuid;
  rows jsonb;
  n integer;
  last_at timestamptz;
  last_id uuid;
begin
  select c.at, c.id into c_at, c_id from public._parse_cursor(p_cursor) c;
  with t as (
    select j.*,
           j.finished_at is null and j.state <> 'canceled' as running,
           exists (select 1 from public.ai_job_items i where i.job_id = j.id and i.status = 'failed') as has_failed
      from public.ai_jobs j where j.owner_id = p_owner
  ), f as (
    select t.*, row_number() over (order by t.created_at desc, t.id desc) rn
      from t
     where case p_state when 'running' then t.running
                        when 'finished' then not t.running
                        when 'failed' then t.has_failed else false end
       and (c_at is null or (t.created_at, t.id) < (c_at, c_id))
     order by t.created_at desc, t.id desc
     limit lim + 1
  )
  select coalesce(jsonb_agg(public._ai_job_json(j, p_session) order by f.created_at desc, f.id desc) filter (where f.rn <= lim), '[]'::jsonb),
         count(*)::integer, max(f.created_at) filter (where f.rn = lim), (array_agg(f.id) filter (where f.rn = lim))[1]
    into rows, n, last_at, last_id
    from f join public.ai_jobs j on j.id = f.id;
  return jsonb_build_object(
    'jobs', rows,
    'nextCursor', case when n > lim then public._cursor(last_at, last_id) end,
    'counts', (select jsonb_build_object(
                 'running', count(*) filter (where j.finished_at is null and j.state <> 'canceled'),
                 'finished', count(*) filter (where not (j.finished_at is null and j.state <> 'canceled')),
                 'failed', count(*) filter (where exists (select 1 from public.ai_job_items i where i.job_id = j.id and i.status = 'failed')))
                 from public.ai_jobs j where j.owner_id = p_owner));
end;
$$;

-- AiJobDetail (items 200 at a time, by position), or null.
create function public.ai_job_get(p_owner uuid, p_job uuid, p_after integer default null, p_session text default null)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'job', public._ai_job_json(j, p_session),
    'items', coalesce((select jsonb_agg(public._ai_item_json(i) order by i.seq)
                         from (select * from public.ai_job_items i where i.job_id = j.id and i.seq > coalesce(p_after, -1)
                                order by i.seq limit 200) i), '[]'::jsonb),
    'nextCursor', (select case when count(*) > 200 then (min(i.seq) + 199)::text end
                     from (select i.seq from public.ai_job_items i where i.job_id = j.id and i.seq > coalesce(p_after, -1)
                            order by i.seq limit 201) i))
  from public.ai_jobs j where j.id = p_job and j.owner_id = p_owner;
$$;

-- Cancels a job: pending items are canceled and refunded; items already with a provider finish. {job} or null.
create function public.ai_job_cancel(p_owner uuid, p_job uuid, p_session text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  j public.ai_jobs;
  it public.ai_job_items;
begin
  perform public._credits_lock(p_owner);
  select * into j from public.ai_jobs where id = p_job and owner_id = p_owner for update;
  if not found then return null; end if;
  for it in select * from public.ai_job_items where job_id = p_job and status = 'pending' order by seq for update loop
    if it.reserved_micros > 0 then
      perform public._ai_spend_settle('bg_removal', p_owner, it.reserved_day, it.reserved_micros, 0);
    end if;
    update public.ai_job_items set status = 'canceled', finished_at = now(), reserved_micros = 0, wait_until = null where id = it.id;
    perform public._ai_refund_item(it.id);
  end loop;
  update public.ai_jobs set state = 'canceled', lease_device = null, lease_session = null, lease_until = null, updated_at = now()
   where id = p_job;
  perform public._ai_job_touch(p_job);
  select * into j from public.ai_jobs where id = p_job;
  return jsonb_build_object('job', public._ai_job_json(j, p_session));
end;
$$;

-- Retries failed background-removal items (all retryable ones when p_items is null), charging again.
-- {job, items: [itemId]} | {error: 'insufficient_credits', needed, balance} | {error: 'nothing' | 'feature_off'} | null.
create function public.ai_job_retry(p_owner uuid, p_job uuid, p_items uuid[], p_session text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.ai_settings := public._ai_settings();
  j public.ai_jobs;
  b public.credit_balances;
  ids uuid[];
  needed integer;
begin
  perform public._credits_lock(p_owner);
  select * into j from public.ai_jobs where id = p_job and owner_id = p_owner for update;
  if not found then return null; end if;
  if j.kind <> 'bg_removal' then return jsonb_build_object('error', 'nothing'); end if;
  if not public._ai_feature(s, 'bg_removal') then return jsonb_build_object('error', 'feature_off'); end if;
  select array_agg(i.id order by i.seq) into ids
    from public.ai_job_items i join public.photos p on p.id = i.photo_id
   where i.job_id = p_job and i.status = 'failed' and coalesce(i.error, '') not in ('photo_deleted', 'device_failed')
     and p.status = 'ready' and p.has_preview and p.safety_hold_at is null
     and (p_items is null or i.id = any (p_items));
  if ids is null then return jsonb_build_object('error', 'nothing'); end if;
  b := public._credits_roll(p_owner);
  needed := cardinality(ids) * s.bg_credits_per_photo;
  if b.balance < needed then
    return jsonb_build_object('error', 'insufficient_credits', 'needed', needed, 'balance', b.balance);
  end if;
  update public.ai_job_items
     set status = 'pending', error = null, attempts = 0, credits = s.bg_credits_per_photo, charge_seq = charge_seq + 1,
         finished_at = null, started_at = null, wait_until = null, enqueued_at = null, provider = null
   where id = any (ids);
  insert into public.credit_ledger (owner_id, delta, reason, label, job_id, period_start)
  values (p_owner, -needed, 'job_charge', 'Retry · ' || left(j.title, 100) || ' · ' || cardinality(ids)
          || case when cardinality(ids) = 1 then ' photo' else ' photos' end, p_job, b.period_start);
  update public.credit_balances set balance = balance - needed, updated_at = now() where owner_id = p_owner;
  update public.ai_jobs set credits_charged = credits_charged + needed, state = 'active', finished_at = null, updated_at = now()
   where id = p_job returning * into j;
  return jsonb_build_object('job', public._ai_job_json(j, p_session), 'items', to_jsonb(ids));
end;
$$;

-- Device jobs: claim (any of the owner's sessions, unless another one holds a live lease).
-- {job, remaining} | {error: 'held', holder} | {error: 'finished'} | null.
create function public.ai_device_claim(p_owner uuid, p_job uuid, p_device text, p_session text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  j public.ai_jobs;
  device text := left(nullif(btrim(regexp_replace(coalesce(p_device, ''), '[[:cntrl:]]', '', 'g')), ''), 40);
begin
  if device is null or nullif(p_session, '') is null then return jsonb_build_object('error', 'invalid'); end if;
  select * into j from public.ai_jobs where id = p_job and owner_id = p_owner and kind = 'device' for update;
  if not found then return null; end if;
  if j.state = 'canceled' or j.finished_at is not null then return jsonb_build_object('error', 'finished'); end if;
  if j.lease_until > now() and j.lease_session is distinct from left(p_session, 64) and j.state = 'active' then
    return jsonb_build_object('error', 'held', 'holder', j.lease_device);
  end if;
  update public.ai_jobs
     set state = 'active', lease_device = device, lease_session = left(p_session, 64), lease_until = now() + interval '120 seconds',
         updated_at = now()
   where id = p_job returning * into j;
  return jsonb_build_object('job', public._ai_job_json(j, p_session),
    'remaining', coalesce((select jsonb_agg(i.photo_id order by i.seq) from public.ai_job_items i
                            where i.job_id = p_job and i.status = 'pending' and i.photo_id is not null), '[]'::jsonb));
end;
$$;

-- Device progress: only the session holding the lease. Renews the lease. {job} | {error: 'lost'} | null.
create function public.ai_device_progress(p_owner uuid, p_job uuid, p_session text, p_done uuid[], p_failed uuid[]) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  j public.ai_jobs;
begin
  select * into j from public.ai_jobs where id = p_job and owner_id = p_owner and kind = 'device' for update;
  if not found then return null; end if;
  if j.state <> 'active' or j.lease_session is distinct from left(p_session, 64) or j.lease_until is null then
    return jsonb_build_object('error', 'lost');
  end if;
  update public.ai_job_items set status = 'completed', finished_at = now()
   where job_id = p_job and status = 'pending' and photo_id = any (coalesce(p_done, '{}'));
  update public.ai_job_items set status = 'failed', error = 'device_failed', finished_at = now()
   where job_id = p_job and status = 'pending' and photo_id = any (coalesce(p_failed, '{}'));
  -- Photos deleted meanwhile can't be processed.
  update public.ai_job_items set status = 'failed', error = 'photo_deleted', finished_at = now()
   where job_id = p_job and status = 'pending' and photo_id is null;
  update public.ai_jobs set lease_until = now() + interval '120 seconds', updated_at = now() where id = p_job;
  perform public._ai_job_touch(p_job);
  select * into j from public.ai_jobs where id = p_job;
  return jsonb_build_object('job', public._ai_job_json(j, p_session));
end;
$$;

-- Device pause: releases the lease (from any of the owner's sessions). {job} | null.
create function public.ai_device_pause(p_owner uuid, p_job uuid, p_session text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  j public.ai_jobs;
begin
  update public.ai_jobs set state = 'paused', lease_device = null, lease_session = null, lease_until = null, updated_at = now()
   where id = p_job and owner_id = p_owner and kind = 'device' and state <> 'canceled'
  returning * into j;
  if not found then
    select * into j from public.ai_jobs where id = p_job and owner_id = p_owner and kind = 'device';
    if not found then return null; end if;
  end if;
  return jsonb_build_object('job', public._ai_job_json(j, p_session));
end;
$$;

-- The R2 key of one of the owner's masks (ready or trashed photo), or null.
create function public.ai_mask_key(p_owner uuid, p_photo uuid, p_mask uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.key from public.photo_masks m join public.photos p on p.id = m.photo_id
   where m.id = p_mask and m.photo_id = p_photo and m.owner_id = p_owner and p.owner_id = p_owner
     and p.status in ('ready', 'trashed');
$$;

-- ---------------------------------------------------------------------------------------------
-- Queue consumer: background removal
-- ---------------------------------------------------------------------------------------------
-- Claims an item for a provider call and reserves p_estimate of today's spend.
-- {status: 'go', ownerId, photoId, attempts, alerts} | {status: 'wait', until, alerts} | {status: 'skip'} | {status: 'failed'}.
create function public.ai_item_begin(p_item uuid, p_estimate bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  o uuid;
  it public.ai_job_items;
  j public.ai_jobs;
  ph public.photos;
  s public.ai_settings := public._ai_settings();
  res jsonb;
  until timestamptz;
begin
  select i.owner_id into o from public.ai_job_items i where i.id = p_item;
  if o is null then return jsonb_build_object('status', 'skip'); end if;
  perform public._credits_lock(o);
  select * into it from public.ai_job_items where id = p_item for update;
  if it.status not in ('pending', 'processing') then return jsonb_build_object('status', 'skip'); end if;
  if it.status = 'processing' and it.started_at > now() - interval '10 minutes' then return jsonb_build_object('status', 'skip'); end if;
  if it.status = 'pending' and it.wait_until > now() then return jsonb_build_object('status', 'wait', 'until', it.wait_until, 'alerts', '[]'::jsonb); end if;
  select * into j from public.ai_jobs where id = it.job_id;
  if j.kind <> 'bg_removal' then return jsonb_build_object('status', 'skip'); end if;
  if j.state = 'canceled' then
    update public.ai_job_items set status = 'canceled', finished_at = now() where id = p_item;
    perform public._ai_refund_item(p_item);
    perform public._ai_job_touch(j.id);
    return jsonb_build_object('status', 'skip');
  end if;
  if it.status = 'processing' and it.attempts >= 2 then
    -- Stuck twice with a provider: give up and refund.
    perform public._ai_item_fail(p_item, 'provider_timeout');
    return jsonb_build_object('status', 'failed');
  end if;
  select * into ph from public.photos where id = it.photo_id and owner_id = o;
  if not found or ph.status <> 'ready' or ph.safety_hold_at is not null then
    perform public._ai_item_fail(p_item, 'photo_deleted');
    return jsonb_build_object('status', 'failed');
  end if;
  if not ph.has_preview then
    perform public._ai_item_fail(p_item, 'no_preview');
    return jsonb_build_object('status', 'failed');
  end if;
  if not public._ai_feature(s, 'bg_removal') then
    perform public._ai_item_fail(p_item, 'feature_off');
    return jsonb_build_object('status', 'failed');
  end if;
  if s.cloud_paused then
    until := now() + interval '15 minutes';
    update public.ai_job_items set status = 'pending', wait_until = until, enqueued_at = null where id = p_item;
    return jsonb_build_object('status', 'wait', 'until', until, 'alerts', '[]'::jsonb);
  end if;
  -- A stuck reservation from a lost run is settled as spent (the provider may have charged).
  if it.reserved_micros > 0 then
    perform public._ai_spend_settle('bg_removal', o, it.reserved_day, it.reserved_micros, it.reserved_micros);
    update public.ai_job_items set reserved_micros = 0 where id = p_item;
  end if;
  res := public._ai_spend_reserve('bg_removal', o, greatest(coalesce(p_estimate, 0), 0));
  if not (res ->> 'ok')::boolean then
    until := public._ai_next_midnight();
    update public.ai_job_items set status = 'pending', wait_until = until, enqueued_at = null where id = p_item;
    return jsonb_build_object('status', 'wait', 'until', until, 'capped', res ->> 'capped', 'alerts', res -> 'alerts');
  end if;
  update public.ai_job_items
     set status = 'processing', attempts = attempts + 1, started_at = now(), wait_until = null,
         reserved_micros = greatest(coalesce(p_estimate, 0), 0), reserved_day = public._ai_today()
   where id = p_item;
  return jsonb_build_object('status', 'go', 'ownerId', o, 'photoId', ph.id, 'attempts', it.attempts + 1,
                            'alerts', res -> 'alerts');
end;
$$;

-- Records a finished mask (stored by the Worker at p_key), attaches it to the photo's recipe as a new edit
-- version (unrendered) and keeps at most 2 masks per photo.
-- {status: 'ok', version, deleteKeys} | {status: 'gone', deleteKeys} (the Worker deletes those objects).
create function public.ai_item_complete(p_item uuid, p_mask uuid, p_key text, p_bytes integer, p_width integer,
  p_height integer, p_provider text, p_cost bigint, p_latency_ms integer, p_calls jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  o uuid;
  it public.ai_job_items;
  j public.ai_jobs;
  ph public.photos;
  e public.photo_edits;
  rec jsonb;
  v integer;
  dropped jsonb;
begin
  select i.owner_id into o from public.ai_job_items i where i.id = p_item;
  if o is null then return jsonb_build_object('status', 'gone', 'deleteKeys', jsonb_build_array(p_key)); end if;
  perform public._credits_lock(o);
  select * into it from public.ai_job_items where id = p_item for update;
  perform public._ai_log_calls('bg_removal', p_calls);
  if it.status <> 'processing' then
    return jsonb_build_object('status', 'gone', 'deleteKeys', jsonb_build_array(p_key));
  end if;
  -- Photo row before the spend lock (the same order as every other path).
  select * into ph from public.photos where id = it.photo_id and owner_id = o for update;
  perform public._ai_spend_settle('bg_removal', o, it.reserved_day, it.reserved_micros, coalesce(p_cost, 0), 1, it.credits);
  update public.ai_job_items set reserved_micros = 0, cost_micros = coalesce(p_cost, 0), provider = p_provider,
         latency_ms = least(greatest(coalesce(p_latency_ms, 0), 0), 3600000)
   where id = p_item;
  if ph.id is null or ph.status <> 'ready' or p_key is distinct from public._mask_key(o, ph.id, p_mask)
     or p_provider not in ('runware', 'fal_bria') then
    perform public._ai_item_fail(p_item, case when ph.id is null or ph.status <> 'ready' then 'photo_deleted' else 'bad_output' end);
    return jsonb_build_object('status', 'gone', 'deleteKeys', jsonb_build_array(p_key));
  end if;
  insert into public.photo_masks (id, photo_id, owner_id, key, bytes, width, height, provider)
  values (p_mask, ph.id, o, p_key, p_bytes, p_width, p_height, p_provider);
  select * into j from public.ai_jobs where id = it.job_id;
  select * into e from public.photo_edits where photo_id = ph.id for update;
  rec := coalesce(e.recipe, '{"v": 1}'::jsonb)
         || jsonb_build_object('cutout', coalesce(j.apply, '{"bg": "white"}'::jsonb) || jsonb_build_object('mask', p_mask));
  v := null;
  if octet_length(rec::text) <= 4096 then
    v := ph.edit_version + 1;
    update public.photos set edit_version = v where id = ph.id;
    insert into public.photo_edits (photo_id, owner_id, recipe, version)
    values (ph.id, o, rec, v)
    on conflict (photo_id) do update set recipe = excluded.recipe, version = excluded.version, updated_at = now();
  end if;
  -- Keep the two newest masks (the new one, which the recipe uses, and the one before it for undo).
  with gone as (
    delete from public.photo_masks m
     where m.photo_id = ph.id
       and m.id not in (select m2.id from public.photo_masks m2 where m2.photo_id = ph.id order by m2.created_at desc, m2.id limit 2)
       and m.id is distinct from (select (pe.recipe #>> '{cutout,mask}')::uuid from public.photo_edits pe where pe.photo_id = ph.id)
    returning m.key
  )
  select coalesce(jsonb_agg(key), '[]'::jsonb) into dropped from gone;
  update public.ai_job_items set status = 'completed', mask_id = p_mask, finished_at = now() where id = p_item;
  perform public._ai_job_touch(it.job_id);
  return jsonb_build_object('status', 'ok', 'version', v, 'deleteKeys', dropped);
end;
$$;

-- A provider attempt that ended without a mask: fails the item (refunded) and settles its spend.
create function public.ai_item_failed(p_item uuid, p_error text, p_cost bigint, p_calls jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  o uuid;
  it public.ai_job_items;
begin
  if p_error not in ('provider_timeout', 'provider_error', 'bad_output', 'no_preview', 'photo_deleted', 'feature_off') then
    return jsonb_build_object('status', 'invalid');
  end if;
  select i.owner_id into o from public.ai_job_items i where i.id = p_item;
  if o is null then return jsonb_build_object('status', 'skip'); end if;
  perform public._credits_lock(o);
  select * into it from public.ai_job_items where id = p_item for update;
  perform public._ai_log_calls('bg_removal', p_calls);
  if it.status <> 'processing' then return jsonb_build_object('status', 'skip'); end if;
  perform public._ai_spend_settle('bg_removal', o, it.reserved_day, it.reserved_micros, coalesce(p_cost, 0));
  update public.ai_job_items set reserved_micros = 0, cost_micros = coalesce(p_cost, 0) where id = p_item;
  perform public._ai_item_fail(p_item, p_error);
  return jsonb_build_object('status', 'failed');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Queue consumer: scene tags
-- ---------------------------------------------------------------------------------------------
-- {status: 'go', alerts} | {status: 'skip'} | {status: 'wait', alerts}. Reserves p_estimate when it goes.
create function public.ai_scene_begin(p_owner uuid, p_photo uuid, p_estimate bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.ai_settings := public._ai_settings();
  ph public.photos;
  m record;
  res jsonb;
begin
  select * into ph from public.photos where id = p_photo and owner_id = p_owner for update;
  if not found or ph.status <> 'ready' or not ph.has_thumb or ph.safety_hold_at is not null or ph.scene_state = 'done' then
    return jsonb_build_object('status', 'skip');
  end if;
  select * into m from public._ai_member(p_owner);
  if not public._ai_feature(s, 'scene_tags') or not m.scene_tags then
    update public.photos set scene_state = null, scene_queued_at = null where id = p_photo;
    return jsonb_build_object('status', 'skip');
  end if;
  if s.cloud_paused then
    update public.photos set scene_state = null, scene_queued_at = null where id = p_photo;
    return jsonb_build_object('status', 'wait', 'alerts', '[]'::jsonb);
  end if;
  res := public._ai_spend_reserve('scene_tags', p_owner, greatest(coalesce(p_estimate, 0), 0));
  if not (res ->> 'ok')::boolean then
    update public.photos set scene_state = null, scene_queued_at = null where id = p_photo;
    return jsonb_build_object('status', 'wait', 'alerts', res -> 'alerts');
  end if;
  update public.photos set scene_state = 'pending', scene_queued_at = coalesce(scene_queued_at, now()) where id = p_photo;
  return jsonb_build_object('status', 'go', 'alerts', res -> 'alerts');
end;
$$;

-- Records scene tags ([{scene, score}]), a failure (p_scenes null) or 'retry' (tag it again later), settling the
-- reservation of p_reserved.
create function public.ai_scene_done(p_owner uuid, p_photo uuid, p_scenes jsonb, p_reserved bigint, p_cost bigint,
  p_calls jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  ready boolean;
begin
  -- Photo row before the spend lock.
  select p.status = 'ready' into ready from public.photos p where p.id = p_photo and p.owner_id = p_owner for update;
  perform public._ai_spend_settle('scene_tags', p_owner, public._ai_today(), p_reserved, coalesce(p_cost, 0));
  perform public._ai_log_calls('scene_tags', p_calls);
  if not coalesce(ready, false) then return jsonb_build_object('status', 'skip'); end if;
  if p_scenes = '"retry"'::jsonb then
    -- The thumbnail wasn't there yet: the backfill tries again later.
    update public.photos set scene_state = null, scene_queued_at = null where id = p_photo;
    return jsonb_build_object('status', 'retry');
  end if;
  delete from public.photo_scenes where photo_id = p_photo;
  if p_scenes is null or jsonb_typeof(p_scenes) <> 'array' then
    update public.photos set scene_state = 'failed' where id = p_photo;
    return jsonb_build_object('status', 'failed');
  end if;
  insert into public.photo_scenes (photo_id, owner_id, scene, score)
  select p_photo, p_owner, x.value ->> 'scene', least(greatest((x.value ->> 'score')::real, 0), 1)
    from jsonb_array_elements(p_scenes) with ordinality x(value, n)
   where x.n <= 5
     and x.value ->> 'scene' in ('beach', 'mountains', 'forest', 'water', 'snow', 'flowers', 'food', 'pets',
                                 'animals', 'architecture', 'interiors', 'vehicles', 'documents')
     and jsonb_typeof(x.value -> 'score') = 'number'
  on conflict do nothing;
  update public.photos set scene_state = 'done' where id = p_photo;
  return jsonb_build_object('status', 'ok');
end;
$$;

-- SceneSummary list: scenes with at least one ready photo, with the newest as cover.
create function public.ai_scenes(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('scene', x.scene, 'count', x.n, 'coverPhotoId', x.cover)
                            order by x.n desc, x.scene), '[]'::jsonb)
    from (
      select sc.scene, count(*)::integer n, (array_agg(p.id order by p.sort_at desc, p.id desc))[1] cover
        from public.photo_scenes sc join public.photos p on p.id = sc.photo_id
       where sc.owner_id = p_owner and p.owner_id = p_owner and p.status = 'ready'
       group by sc.scene
      union all
      select 'night', count(*)::integer, (array_agg(p.id order by p.sort_at desc, p.id desc))[1]
        from public.photo_signals s join public.photos p on p.id = s.photo_id
       where s.owner_id = p_owner and p.owner_id = p_owner and p.status = 'ready' and s.night
      having count(*) > 0
    ) x;
$$;

-- ---------------------------------------------------------------------------------------------
-- Device quality signals and Cleanup
-- ---------------------------------------------------------------------------------------------
-- SignalsPendingPage: ready photos with a thumbnail whose signals are missing or older than p_version.
create function public.ai_signals_pending(p_owner uuid, p_version integer, p_cursor text default null, p_limit integer default 100)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  c_at timestamptz;
  c_id uuid;
  rows jsonb;
  n integer;
  last_at timestamptz;
  last_id uuid;
begin
  select c.at, c.id into c_at, c_id from public._parse_cursor(p_cursor) c;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'takenAt', x.taken_at) order by x.created_at desc, x.id desc)
                    filter (where x.rn <= lim), '[]'::jsonb),
         count(*)::integer, max(x.created_at) filter (where x.rn = lim), (array_agg(x.id) filter (where x.rn = lim))[1]
    into rows, n, last_at, last_id
    from (select p.id, p.created_at, p.taken_at, row_number() over (order by p.created_at desc, p.id desc) rn
            from public.photos p left join public.photo_signals s on s.photo_id = p.id
           where p.owner_id = p_owner and p.status = 'ready' and p.has_thumb
             and (s.photo_id is null or s.version < p_version)
             and (c_at is null or (p.created_at, p.id) < (c_at, c_id))
           order by p.created_at desc, p.id desc limit lim + 1) x;
  return jsonb_build_object('photos', rows,
    'nextCursor', case when n > lim then public._cursor(last_at, last_id) end,
    'remaining', (select count(*) from public.photos p left join public.photo_signals s on s.photo_id = p.id
                   where p.owner_id = p_owner and p.status = 'ready' and p.has_thumb
                     and (s.photo_id is null or s.version < p_version)));
end;
$$;

-- Saves PhotoSignals for the owner's ready photos (others are ignored). Returns the number saved.
create function public.ai_signals_save(p_owner uuid, p_version integer, p_items jsonb) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  n integer;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 or p_version < 1 then
    return 0;
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) x
              where coalesce(x.value ->> 'phash', '') !~ '^[0-9a-f]{16}$'
                 or jsonb_typeof(x.value -> 'sharpness') <> 'number' or jsonb_typeof(x.value -> 'brightness') <> 'number'
                 or jsonb_typeof(x.value -> 'night') <> 'boolean'
                 or coalesce(x.value ->> 'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    return 0;
  end if;
  insert into public.photo_signals (photo_id, owner_id, version, phash, sharpness, brightness, night)
  select p.id, p_owner, p_version, ('x' || (x.value ->> 'phash'))::bit(64)::bigint,
         least(greatest((x.value ->> 'sharpness')::real, 0), 65025), least(greatest((x.value ->> 'brightness')::real, 0), 1),
         (x.value ->> 'night')::boolean
    from jsonb_array_elements(p_items) x
    join public.photos p on p.id = (x.value ->> 'id')::uuid and p.owner_id = p_owner and p.status = 'ready'
  on conflict (photo_id) do update
    set version = excluded.version, phash = excluded.phash, sharpness = excluded.sharpness,
        brightness = excluded.brightness, night = excluded.night, updated_at = now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- CleanupPage (Pro and Studio): every ready photo with signals, 1,000 at a time. {error: 'plan'} otherwise.
create function public.ai_cleanup_page(p_owner uuid, p_cursor text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r record;
  lim integer := 1000;
  c_at timestamptz;
  c_id uuid;
  rows jsonb;
  n integer;
  last_at timestamptz;
  last_id uuid;
begin
  select * into r from public._ai_rules(public._ai_plan(p_owner));
  if not coalesce(r.quality_cleanup, false) then return jsonb_build_object('error', 'plan'); end if;
  if not public._ai_feature(public._ai_settings(), 'cleanup') then return jsonb_build_object('error', 'feature_off'); end if;
  select c.at, c.id into c_at, c_id from public._parse_cursor(p_cursor) c;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'phash', lpad(to_hex(x.phash), 16, '0'), 'sharpness', x.sharpness, 'takenAt', x.taken_at,
           'createdAt', x.created_at, 'sizeBytes', x.size_bytes, 'width', x.width, 'height', x.height,
           'dupIgnored', x.dup_ignored, 'blurIgnored', x.blur_ignored) order by x.created_at desc, x.id desc)
           filter (where x.rn <= lim), '[]'::jsonb),
         count(*)::integer, max(x.created_at) filter (where x.rn = lim), (array_agg(x.id) filter (where x.rn = lim))[1]
    into rows, n, last_at, last_id
    from (select p.id, p.created_at, p.taken_at, p.size_bytes, p.width, p.height, s.phash, s.sharpness, s.dup_ignored, s.blur_ignored,
                 row_number() over (order by p.created_at desc, p.id desc) rn
            from public.photos p join public.photo_signals s on s.photo_id = p.id
           where p.owner_id = p_owner and p.status = 'ready'
             and (c_at is null or (p.created_at, p.id) < (c_at, c_id))
           order by p.created_at desc, p.id desc limit lim + 1) x;
  return jsonb_build_object('photos', rows, 'nextCursor', case when n > lim then public._cursor(last_at, last_id) end);
end;
$$;

create function public.ai_cleanup_ignore(p_owner uuid, p_kind text, p_ids uuid[]) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  n integer;
begin
  update public.photo_signals
     set dup_ignored = dup_ignored or p_kind = 'duplicates', blur_ignored = blur_ignored or p_kind = 'blurry', updated_at = now()
   where owner_id = p_owner and photo_id = any (p_ids[1:500]) and p_kind in ('duplicates', 'blurry');
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Faces and people
-- ---------------------------------------------------------------------------------------------
-- Null when the member can use face grouping, otherwise the reason ('plan' | 'off' | 'feature_off').
create function public._ai_faces_block(p_owner uuid) returns text
language sql stable set search_path = '' as $$
  select case when not public._ai_feature(public._ai_settings(), 'face_grouping') then 'feature_off'
              when not coalesce((select r.people_grouping from public._ai_rules(public._ai_plan(p_owner)) r), false) then 'plan'
              when not (select m.face_grouping from public._ai_member(p_owner) m) then 'off' end;
$$;

create function public._ai_person_recount(p_person uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  n integer;
  sm extensions.vector;
begin
  select count(*)::integer, extensions.sum(f.embedding) into n, sm from public.faces f where f.person_id = p_person;
  if n = 0 then
    delete from public.people where id = p_person and name is null;
    update public.people set face_count = 0, embedding_sum = null, cover_face_id = null, updated_at = now() where id = p_person;
  else
    update public.people
       set face_count = n, embedding_sum = sm, updated_at = now(),
           cover_face_id = case when exists (select 1 from public.faces f where f.id = cover_face_id and f.person_id = p_person)
                                then cover_face_id end
     where id = p_person;
  end if;
end;
$$;

-- FacesPendingPage, or {error: 'plan' | 'off' | 'feature_off'}.
create function public.ai_faces_pending(p_owner uuid, p_version integer, p_cursor text default null, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  blk text := public._ai_faces_block(p_owner);
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  c_at timestamptz;
  c_id uuid;
  rows jsonb;
  n integer;
  last_at timestamptz;
  last_id uuid;
begin
  if blk is not null then return jsonb_build_object('error', blk); end if;
  select c.at, c.id into c_at, c_id from public._parse_cursor(p_cursor) c;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id) order by x.created_at desc, x.id desc) filter (where x.rn <= lim), '[]'::jsonb),
         count(*)::integer, max(x.created_at) filter (where x.rn = lim), (array_agg(x.id) filter (where x.rn = lim))[1]
    into rows, n, last_at, last_id
    from (select p.id, p.created_at, row_number() over (order by p.created_at desc, p.id desc) rn
            from public.photos p
           where p.owner_id = p_owner and p.status = 'ready' and p.has_preview and p.faces_version < p_version
             and (c_at is null or (p.created_at, p.id) < (c_at, c_id))
           order by p.created_at desc, p.id desc limit lim + 1) x;
  return jsonb_build_object('photos', rows,
    'nextCursor', case when n > lim then public._cursor(last_at, last_id) end,
    'remaining', (select count(*) from public.photos p
                   where p.owner_id = p_owner and p.status = 'ready' and p.has_preview and p.faces_version < p_version),
    'total', (select count(*) from public.photos p where p.owner_id = p_owner and p.status = 'ready' and p.has_preview));
end;
$$;

-- Stores the faces found on the device for up to 20 of the owner's ready photos (replacing any earlier scan),
-- matching each to the owner's people by centroid cosine similarity ≥ p_match, or starting a new person.
-- p_items: [{id, faces: [{box: [x,y,w,h], score, embedding: '[…128 floats…]'}]}]. {saved} | {error}.
create function public.ai_faces_add(p_owner uuid, p_version integer, p_match real, p_items jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  blk text := public._ai_faces_block(p_owner);
  item jsonb;
  f jsonb;
  pid uuid;
  emb extensions.vector(128);
  best uuid;
  sim real;
  touched uuid[] := '{}';
  person uuid;
  saved integer := 0;
begin
  if blk is not null then return jsonb_build_object('error', blk); end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 20 or p_version < 1
     or p_match is null or p_match not between 0 and 1 then
    return jsonb_build_object('error', 'invalid');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('zephyr:faces:' || p_owner::text, 0));
  for item in select x.value from jsonb_array_elements(p_items) x loop
    continue when coalesce(item ->> 'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               or jsonb_typeof(item -> 'faces') <> 'array' or jsonb_array_length(item -> 'faces') > 30;
    pid := (item ->> 'id')::uuid;
    perform 1 from public.photos where id = pid and owner_id = p_owner and status = 'ready' for update;
    continue when not found;
    -- A rescan replaces the photo's faces.
    touched := touched || coalesce((select array_agg(distinct person_id) from public.faces
                                     where photo_id = pid and person_id is not null), '{}');
    delete from public.faces where photo_id = pid and owner_id = p_owner;
    for f in select x.value from jsonb_array_elements(item -> 'faces') x loop
      continue when jsonb_typeof(f -> 'box') <> 'array' or jsonb_array_length(f -> 'box') <> 4
                 or jsonb_typeof(f -> 'score') <> 'number' or jsonb_typeof(f -> 'embedding') <> 'string';
      begin
        emb := (f ->> 'embedding')::extensions.vector(128);
      exception when others then
        continue;
      end;
      select p.id, (1 - (p.embedding_sum operator(extensions.<=>) emb))::real into best, sim
        from public.people p
       where p.owner_id = p_owner and p.face_count > 0 and p.embedding_sum is not null
       order by p.embedding_sum operator(extensions.<=>) emb
       limit 1;
      if best is not null and sim >= p_match and sim <= 1.001 then
        person := best;
        update public.people set embedding_sum = embedding_sum operator(extensions.+) emb, face_count = face_count + 1,
                                 updated_at = now()
         where id = person;
      else
        insert into public.people (owner_id, embedding_sum, face_count) values (p_owner, emb, 1) returning id into person;
        sim := 1;
      end if;
      insert into public.faces (owner_id, photo_id, person_id, box, score, embedding, similarity)
      select p_owner, pid, person, array(select least(greatest(b.value::real, 0), 1) from jsonb_array_elements_text(f -> 'box') with ordinality b(value, n) order by b.n),
             least(greatest((f ->> 'score')::real, 0), 1), emb, sim;
      saved := saved + 1;
      best := null;
    end loop;
    update public.photos set faces_version = p_version where id = pid;
  end loop;
  -- People that lost faces to a rescan: recount (unnamed ones with none left go).
  perform public._ai_person_recount(t) from unnest(touched) t;
  return jsonb_build_object('saved', saved);
end;
$$;

create function public._ai_person_json(pe public.people) returns jsonb
language sql stable set search_path = '' as $$
  with ph as (
    select distinct p.id, p.taken_at from public.faces f join public.photos p on p.id = f.photo_id
     where f.person_id = pe.id and p.status = 'ready'
  ), cover as (
    select f.photo_id, f.box from public.faces f join public.photos p on p.id = f.photo_id
     where f.person_id = pe.id and p.status = 'ready'
     order by (f.id = pe.cover_face_id) desc, f.score desc, f.id limit 1
  )
  select jsonb_build_object(
    'id', pe.id,
    'name', pe.name,
    'faceCount', pe.face_count,
    'photoCount', (select count(*) from ph),
    'hidden', pe.hidden,
    'cover', (select jsonb_build_object('photoId', cover.photo_id, 'box', to_jsonb(cover.box)) from cover),
    'firstAt', (select min(ph.taken_at) from ph),
    'lastAt', (select max(ph.taken_at) from ph));
$$;

-- PersonSummary list: named people and unnamed ones with at least p_min faces. {error} when blocked.
create function public.ai_people_list(p_owner uuid, p_hidden boolean, p_min integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  blk text := public._ai_faces_block(p_owner);
begin
  if blk is not null then return jsonb_build_object('error', blk); end if;
  return jsonb_build_object('people', coalesce((
    select jsonb_agg(public._ai_person_json(pe) order by (pe.name is null), pe.face_count desc, pe.id)
      from public.people pe
     where pe.owner_id = p_owner and pe.hidden = coalesce(p_hidden, false)
       and (pe.name is not null or pe.face_count >= greatest(coalesce(p_min, 3), 1))
     limit 2000), '[]'::jsonb));
end;
$$;

create function public.ai_person_get(p_owner uuid, p_person uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public._ai_faces_block(p_owner) is not null then jsonb_build_object('error', public._ai_faces_block(p_owner))
              else (select jsonb_build_object('person', public._ai_person_json(pe)) from public.people pe
                     where pe.id = p_person and pe.owner_id = p_owner) end;
$$;

-- PersonPatchBody (keys present are applied; name null clears). {person} | {error} | null.
create function public.ai_person_patch(p_owner uuid, p_person uuid, p_patch jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  blk text := public._ai_faces_block(p_owner);
  pe public.people;
  nm text;
begin
  if blk is not null then return jsonb_build_object('error', blk); end if;
  select * into pe from public.people where id = p_person and owner_id = p_owner for update;
  if not found then return null; end if;
  if p_patch ? 'name' then
    nm := nullif(btrim(regexp_replace(coalesce(p_patch ->> 'name', ''), '[[:cntrl:]]', '', 'g')), '');
    if length(nm) > 60 then return jsonb_build_object('error', 'invalid'); end if;
    pe.name := nm;
  end if;
  if p_patch ? 'hidden' then pe.hidden := coalesce((p_patch ->> 'hidden')::boolean, pe.hidden); end if;
  if p_patch ? 'coverFaceId' then
    if not exists (select 1 from public.faces f where f.id = (p_patch ->> 'coverFaceId')::uuid and f.person_id = p_person
                                                   and f.owner_id = p_owner) then
      return jsonb_build_object('error', 'invalid');
    end if;
    pe.cover_face_id := (p_patch ->> 'coverFaceId')::uuid;
  end if;
  update public.people set name = pe.name, hidden = pe.hidden, cover_face_id = pe.cover_face_id, updated_at = now()
   where id = p_person returning * into pe;
  -- An unnamed person with no faces left has nothing to show.
  if pe.name is null and pe.face_count = 0 then
    delete from public.people where id = p_person;
    return jsonb_build_object('person', null);
  end if;
  return jsonb_build_object('person', public._ai_person_json(pe));
end;
$$;

-- Moves every face of p_from into p_person and deletes them. {person} | {error} | null.
create function public.ai_person_merge(p_owner uuid, p_person uuid, p_from uuid[]) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  blk text := public._ai_faces_block(p_owner);
  pe public.people;
  ids uuid[];
begin
  if blk is not null then return jsonb_build_object('error', blk); end if;
  perform pg_advisory_xact_lock(hashtextextended('zephyr:faces:' || p_owner::text, 0));
  select * into pe from public.people where id = p_person and owner_id = p_owner for update;
  if not found then return null; end if;
  select array_agg(id) into ids from public.people where owner_id = p_owner and id = any (p_from[1:50]) and id <> p_person;
  if ids is null then return jsonb_build_object('error', 'invalid'); end if;
  delete from public.face_rejections r using public.faces f where r.face_id = f.id and f.person_id = any (ids) and r.person_id = p_person;
  update public.faces set person_id = p_person where owner_id = p_owner and person_id = any (ids);
  delete from public.people where id = any (ids) and owner_id = p_owner;
  perform public._ai_person_recount(p_person);
  select * into pe from public.people where id = p_person;
  return jsonb_build_object('person', public._ai_person_json(pe));
end;
$$;

-- Not this person ('remove'), confirm ('confirm'), or move to another person / a new one ('move').
-- p_photo_ids: all of this person's faces in those photos; p_face_ids: those faces of this person.
-- {person (null if it went), to?} | {error} | null.
create function public.ai_person_faces(p_owner uuid, p_person uuid, p_action text, p_photo_ids uuid[], p_face_ids uuid[],
  p_to text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  blk text := public._ai_faces_block(p_owner);
  pe public.people;
  ids uuid[];
  target uuid;
begin
  if blk is not null then return jsonb_build_object('error', blk); end if;
  if p_action not in ('remove', 'confirm', 'move') or ((p_photo_ids is null) = (p_face_ids is null)) then
    return jsonb_build_object('error', 'invalid');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('zephyr:faces:' || p_owner::text, 0));
  select * into pe from public.people where id = p_person and owner_id = p_owner for update;
  if not found then return null; end if;
  select array_agg(f.id) into ids from public.faces f
   where f.owner_id = p_owner and f.person_id = p_person
     and (f.photo_id = any (coalesce(p_photo_ids[1:500], '{}')) or f.id = any (coalesce(p_face_ids[1:500], '{}')));
  if ids is null then return jsonb_build_object('error', 'invalid'); end if;
  if p_action = 'confirm' then
    update public.faces set confirmed = true, assigned_by = 'user' where id = any (ids);
  elsif p_action = 'remove' then
    insert into public.face_rejections (face_id, person_id) select unnest(ids), p_person on conflict do nothing;
    update public.faces set person_id = null, assigned_by = 'user', confirmed = false where id = any (ids);
  else
    if p_to = 'new' then
      insert into public.people (owner_id) values (p_owner) returning id into target;
    elsif coalesce(p_to, '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select id into target from public.people where id = p_to::uuid and owner_id = p_owner and id <> p_person;
    end if;
    if target is null then return jsonb_build_object('error', 'invalid'); end if;
    insert into public.face_rejections (face_id, person_id) select unnest(ids), p_person on conflict do nothing;
    delete from public.face_rejections where face_id = any (ids) and person_id = target;
    update public.faces set person_id = target, assigned_by = 'user', confirmed = true where id = any (ids);
    perform public._ai_person_recount(target);
  end if;
  perform public._ai_person_recount(p_person);
  select * into pe from public.people where id = p_person;
  return jsonb_build_object('person', case when found then public._ai_person_json(pe) end, 'to', target);
end;
$$;

-- FaceSuggestion list: automatic matches to named people that aren't sure (similarity < p_sure), least sure first.
create function public.ai_face_suggestions(p_owner uuid, p_sure real) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  blk text := public._ai_faces_block(p_owner);
begin
  if blk is not null then return jsonb_build_object('error', blk); end if;
  return jsonb_build_object('suggestions', coalesce((
    select jsonb_agg(jsonb_build_object('faceId', x.id, 'photoId', x.photo_id, 'box', to_jsonb(x.box), 'personId', x.person_id,
                                        'personName', x.name, 'similarity', round(x.similarity::numeric, 3)) order by x.similarity, x.id)
      from (select f.id, f.photo_id, f.box, f.person_id, pe.name, f.similarity
              from public.faces f join public.people pe on pe.id = f.person_id
              join public.photos p on p.id = f.photo_id
             where f.owner_id = p_owner and pe.owner_id = p_owner and pe.name is not null and not pe.hidden
               and f.assigned_by = 'auto' and not f.confirmed and f.similarity < p_sure and p.status = 'ready'
             order by f.similarity, f.id limit 50) x), '[]'::jsonb));
end;
$$;

-- "Turn off and delete face data". Returns the number of faces deleted.
create function public.ai_faces_delete_all(p_owner uuid) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  n integer;
  was boolean;
begin
  select coalesce(m.face_grouping, false) into was from public._ai_member(p_owner) m;
  n := public._ai_faces_delete(p_owner);
  if was or n > 0 then
    perform public._audit(p_owner, 'ai.face_grouping.off', p_owner::text, jsonb_build_object('faces', n));
  end if;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------------------------
create function public.admin_ai_settings(p_actor uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when exists (select 1 from public.staff st where st.user_id = p_actor)
              then jsonb_build_object('settings', public._ai_settings_json(s), 'spend', public._ai_spend_json()) end
    from public.ai_settings s where s.id = 1;
$$;

-- Applies an AiSettingsPatch (validated by the Worker, which also decides whether it needed a recent passkey).
-- Owner and admin only. Audited with the changed fields. {settings, spend, before} | {error: 'forbidden' | 'invalid'}.
create function public.admin_ai_settings_update(p_actor uuid, p_patch jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.ai_settings;
  before jsonb;
  after jsonb;
  changes jsonb := '{}'::jsonb;
  k text;
begin
  if public._writer_role(p_actor) is null then return jsonb_build_object('error', 'forbidden'); end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then return jsonb_build_object('error', 'invalid'); end if;
  select * into s from public.ai_settings where id = 1 for update;
  before := public._ai_settings_json(s);
  begin
    update public.ai_settings set
      enabled = coalesce((p_patch ->> 'enabled')::boolean, enabled),
      cloud_paused = coalesce((p_patch ->> 'cloudPaused')::boolean, cloud_paused),
      f_auto_enhance = coalesce((p_patch #>> '{features,auto_enhance}')::boolean, f_auto_enhance),
      f_hdr = coalesce((p_patch #>> '{features,hdr}')::boolean, f_hdr),
      f_color_match = coalesce((p_patch #>> '{features,color_match}')::boolean, f_color_match),
      f_cleanup = coalesce((p_patch #>> '{features,cleanup}')::boolean, f_cleanup),
      f_face_grouping = coalesce((p_patch #>> '{features,face_grouping}')::boolean, f_face_grouping),
      f_scene_tags = coalesce((p_patch #>> '{features,scene_tags}')::boolean, f_scene_tags),
      f_bg_removal = coalesce((p_patch #>> '{features,bg_removal}')::boolean, f_bg_removal),
      bg_provider = coalesce(p_patch ->> 'bgProvider', bg_provider),
      bg_fallback = coalesce(p_patch ->> 'bgFallback', bg_fallback),
      runware_model = coalesce(p_patch ->> 'runwareModel', runware_model),
      fal_model = coalesce(p_patch ->> 'falModel', fal_model),
      scene_model = coalesce(p_patch ->> 'sceneModel', scene_model),
      bg_credits_per_photo = coalesce((p_patch ->> 'bgCreditsPerPhoto')::integer, bg_credits_per_photo),
      cost_runware_micros = coalesce((p_patch #>> '{costs,runwareMicros}')::integer, cost_runware_micros),
      cost_fal_micros = coalesce((p_patch #>> '{costs,falMicros}')::integer, cost_fal_micros),
      cost_scene_micros = coalesce((p_patch #>> '{costs,sceneMicros}')::integer, cost_scene_micros),
      cap_total_micros = coalesce(round((p_patch #>> '{caps,total}')::numeric * 1000000)::bigint, cap_total_micros),
      cap_bg_micros = coalesce(round((p_patch #>> '{caps,bgRemoval}')::numeric * 1000000)::bigint, cap_bg_micros),
      cap_scene_micros = coalesce(round((p_patch #>> '{caps,sceneTags}')::numeric * 1000000)::bigint, cap_scene_micros),
      cap_user_micros = coalesce(round((p_patch #>> '{caps,perUser}')::numeric * 1000000)::bigint, cap_user_micros),
      alerts = coalesce((select array_agg(distinct a::integer order by a::integer)
                           from jsonb_array_elements_text(case when jsonb_typeof(p_patch -> 'alerts') = 'array' then p_patch -> 'alerts' end) a),
                        case when jsonb_typeof(p_patch -> 'alerts') = 'array' then '{}'::integer[] end, alerts),
      at_cap = coalesce(p_patch ->> 'atCap', at_cap),
      alert_to = coalesce(p_patch ->> 'alertTo', alert_to),
      member_jobs_per_minute = coalesce((p_patch ->> 'memberJobsPerMinute')::integer, member_jobs_per_minute),
      updated_at = now(),
      updated_by = p_actor
    where id = 1 returning * into s;
  exception when check_violation or invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then
    return jsonb_build_object('error', 'invalid');
  end;
  after := public._ai_settings_json(s);
  -- New caps or a new at-cap action: today's holds are decided again from the new values.
  if after -> 'caps' is distinct from before -> 'caps' or after -> 'atCap' is distinct from before -> 'atCap' then
    delete from public.ai_spend_capped where day = public._ai_today();
  end if;
  for k in select jsonb_object_keys(after) loop
    continue when k in ('updatedAt', 'updatedBy');
    if after -> k is distinct from before -> k then
      changes := changes || jsonb_build_object(k, jsonb_build_object('from', before -> k, 'to', after -> k));
    end if;
  end loop;
  if changes <> '{}'::jsonb then
    perform public._audit(p_actor, 'ai.settings.update', 'ai_settings', jsonb_build_object('changes', changes));
  end if;
  return jsonb_build_object('settings', after, 'spend', public._ai_spend_json(), 'before', before, 'changes', changes);
end;
$$;

-- Emails of the people who get spend alerts and settings notices ('owners' or 'owners_finance').
create function public.ai_alert_recipients(p_who text default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(distinct u.email::text), '[]'::jsonb)
    from public.staff st join auth.users u on u.id = st.user_id
   where u.email is not null
     and (st.role = 'owner'
          or (st.role = 'finance' and coalesce(p_who, (select s.alert_to from public.ai_settings s where s.id = 1)) = 'owners_finance'));
$$;

-- AdminAiJobsResult (any staff role).
create function public.admin_ai_jobs(p_actor uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.ai_settings := public._ai_settings();
begin
  if not exists (select 1 from public.staff st where st.user_id = p_actor) then return null; end if;
  return jsonb_build_object(
    'counts', jsonb_build_object(
      'pending', (select count(*) from public.ai_job_items i join public.ai_jobs j on j.id = i.job_id
                   where i.status = 'pending' and j.kind = 'bg_removal'),
      'processing', (select count(*) from public.ai_job_items i where i.status = 'processing'),
      'completedToday', (select count(*) from public.ai_job_items i join public.ai_jobs j on j.id = i.job_id
                          where i.status = 'completed' and j.kind = 'bg_removal' and i.finished_at >= public._ai_today()::timestamp at time zone 'utc'),
      'failedToday', (select count(*) from public.ai_job_items i join public.ai_jobs j on j.id = i.job_id
                       where i.status = 'failed' and j.kind = 'bg_removal' and i.finished_at >= public._ai_today()::timestamp at time zone 'utc')),
    'latency', (select jsonb_agg(jsonb_build_object('label', x.label, 'p50', x.p50, 'p95', x.p95) order by x.ord)
                  from (select l.label, l.ord,
                               (select round((percentile_cont(0.5) within group (order by c.ms) / 1000.0)::numeric, 2)
                                  from public.ai_calls c where c.at > now() - interval '1 hour' and c.ok
                                   and c.feature = l.feature and c.role = l.role) p50,
                               (select round((percentile_cont(0.95) within group (order by c.ms) / 1000.0)::numeric, 2)
                                  from public.ai_calls c where c.at > now() - interval '1 hour' and c.ok
                                   and c.feature = l.feature and c.role = l.role) p95
                          from (values ('Background removal', 'bg_removal', 'primary', 1),
                                       ('Fallback', 'bg_removal', 'fallback', 2),
                                       ('Scene tags', 'scene_tags', 'primary', 3)) l(label, feature, role, ord)) x),
    'providers', (select jsonb_agg(jsonb_build_object('provider', x.provider, 'feature', x.feature, 'role', x.role,
                                                      'calls', x.calls, 'successRate', x.rate, 'p95', x.p95) order by x.ord)
                    from (select v.provider, v.feature, v.role, v.ord,
                                 (select count(*) from public.ai_calls c where c.at > now() - interval '24 hours'
                                   and c.provider = v.provider and c.feature = v.feature) calls,
                                 (select round(avg(case when c.ok then 1.0 else 0.0 end), 4) from public.ai_calls c
                                   where c.at > now() - interval '24 hours' and c.provider = v.provider and c.feature = v.feature) rate,
                                 (select round((percentile_cont(0.95) within group (order by c.ms) / 1000.0)::numeric, 2)
                                    from public.ai_calls c where c.at > now() - interval '24 hours' and c.ok
                                     and c.provider = v.provider and c.feature = v.feature) p95
                            from (values (s.bg_provider, 'bg_removal', 'primary', 1),
                                         (s.bg_fallback, 'bg_removal', 'fallback', 2),
                                         ('workers_ai', 'scene_tags', 'primary', 3)) v(provider, feature, role, ord)
                           where v.provider <> 'none') x),
    'failures', coalesce((select jsonb_agg(jsonb_build_object('jobId', x.job_id, 'itemId', x.id, 'member', left(x.owner_id::text, 8),
                                                              'feature', 'bg_removal', 'error', x.error, 'at', x.finished_at)
                                           order by x.finished_at desc)
                            from (select i.job_id, i.id, i.owner_id, i.error, i.finished_at from public.ai_job_items i
                                   join public.ai_jobs j on j.id = i.job_id
                                  where i.status = 'failed' and j.kind = 'bg_removal' and i.finished_at > now() - interval '24 hours'
                                  order by i.finished_at desc limit 20) x), '[]'::jsonb),
    'spend', public._ai_spend_json());
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Cron (the Worker's 15-minute run)
-- ---------------------------------------------------------------------------------------------
-- Background-removal items to (re-)enqueue: pending ones due and not enqueued in the last 10 minutes, and
-- ones stuck processing for more than 10 minutes (each is retried once by ai_item_begin, then failed).
-- Returns item ids, marking them enqueued. Nothing when cloud work is paused or capped.
create function public.ai_due_items(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  ids jsonb;
begin
  if public._ai_cloud_paused() is not null or not public._ai_feature(public._ai_settings(), 'bg_removal') then
    -- Still fail items whose photos went or whose feature is off, so nobody waits forever: ai_item_begin does that.
    if public._ai_feature(public._ai_settings(), 'bg_removal') then return '[]'::jsonb; end if;
  end if;
  with due as (
    select i.id from public.ai_job_items i join public.ai_jobs j on j.id = i.job_id
     where j.kind = 'bg_removal' and j.state = 'active'
       and ((i.status = 'pending' and (i.wait_until is null or i.wait_until <= now())
             and (i.enqueued_at is null or i.enqueued_at < now() - interval '10 minutes'))
            or (i.status = 'processing' and i.started_at < now() - interval '10 minutes'
                and (i.enqueued_at is null or i.enqueued_at < now() - interval '10 minutes')))
     order by i.created_at, i.seq
     limit least(greatest(coalesce(p_limit, 500), 1), 2000)
     for update of i skip locked
  ), marked as (
    update public.ai_job_items i set enqueued_at = now() from due where i.id = due.id returning i.id
  )
  select coalesce(jsonb_agg(id), '[]'::jsonb) into ids from marked;
  return ids;
end;
$$;

-- Marks items enqueued (the API enqueued them right after creating or retrying a job).
create function public.ai_items_enqueued(p_ids uuid[]) returns void
language sql volatile security definer set search_path = '' as $$
  update public.ai_job_items set enqueued_at = now() where id = any (p_ids[1:2000]) and status = 'pending';
$$;

-- Photos to tag: ready, with a thumbnail, never tagged (or queued more than a day ago), of members with scene
-- tags on. Marks them pending. Nothing when scene tags are off or cloud work is paused or capped.
create function public.ai_scene_backfill(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  out jsonb;
begin
  if public._ai_cloud_paused() is not null or not public._ai_feature(public._ai_settings(), 'scene_tags') then
    return '[]'::jsonb;
  end if;
  with due as (
    select p.id from public.photos p
      left join public.ai_member_settings m on m.owner_id = p.owner_id
     where p.status = 'ready' and p.has_thumb and p.safety_hold_at is null and coalesce(m.scene_tags, true)
       and (p.scene_state is null or (p.scene_state = 'pending' and p.scene_queued_at < now() - interval '1 day'))
     order by p.created_at desc
     limit least(greatest(coalesce(p_limit, 500), 1), 2000)
     for update of p skip locked
  ), marked as (
    update public.photos p set scene_state = 'pending', scene_queued_at = now() from due where p.id = due.id
    returning p.id, p.owner_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('photo', id, 'owner', owner_id)), '[]'::jsonb) into out from marked;
  return out;
end;
$$;

-- Members with face data whose plan lost people grouping: grouping stops at once (they're told), a warning
-- goes 3 days before, and the data is deleted 30 days after. Members who regain it are cleared.
-- Returns [{ownerId, email, kind: 'stopped' | 'warning' | 'deleted', deleteOn}].
create function public.ai_face_lapses(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
  out jsonb := '[]'::jsonb;
  n integer;
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 500);
begin
  update public.ai_member_settings m set face_plan_lapsed_at = null, face_lapse_warned_at = null
   where m.face_plan_lapsed_at is not null
     and coalesce((select ru.people_grouping from public._ai_rules(public._ai_plan(m.owner_id)) ru), false);
  for r in
    select m.owner_id, m.face_plan_lapsed_at, m.face_lapse_warned_at from public.ai_member_settings m
     where (m.face_grouping or exists (select 1 from public.people pe where pe.owner_id = m.owner_id))
       and not coalesce((select ru.people_grouping from public._ai_rules(public._ai_plan(m.owner_id)) ru), false)
       and (m.face_plan_lapsed_at is null
            or (m.face_lapse_warned_at is null and m.face_plan_lapsed_at < now() - interval '27 days')
            or m.face_plan_lapsed_at < now() - interval '30 days')
     order by m.owner_id limit lim
     for update of m skip locked
  loop
    if r.face_plan_lapsed_at is null then
      update public.ai_member_settings set face_plan_lapsed_at = now() where owner_id = r.owner_id;
      out := out || jsonb_build_array(jsonb_build_object('ownerId', r.owner_id, 'email', public._owner_email(r.owner_id),
        'kind', 'stopped', 'deleteOn', ((now() + interval '30 days') at time zone 'utc')::date));
    elsif r.face_plan_lapsed_at < now() - interval '30 days' then
      n := public._ai_faces_delete(r.owner_id);
      perform public._audit(null, 'ai.face_grouping.lapsed', r.owner_id::text, jsonb_build_object('faces', n));
      out := out || jsonb_build_array(jsonb_build_object('ownerId', r.owner_id, 'email', public._owner_email(r.owner_id),
        'kind', 'deleted', 'deleteOn', null));
    else
      update public.ai_member_settings set face_lapse_warned_at = now() where owner_id = r.owner_id;
      out := out || jsonb_build_array(jsonb_build_object('ownerId', r.owner_id, 'email', public._owner_email(r.owner_id),
        'kind', 'warning', 'deleteOn', ((r.face_plan_lapsed_at + interval '30 days') at time zone 'utc')::date));
    end if;
  end loop;
  return out;
end;
$$;

-- Housekeeping: provider call log (7 days), finished jobs (90 days; the credit history keeps its labels),
-- spend rows and alerts (400 days).
create function public.ai_prune() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  calls integer;
  jobs integer;
begin
  delete from public.ai_calls where at < now() - interval '7 days';
  get diagnostics calls = row_count;
  delete from public.ai_jobs where finished_at < now() - interval '90 days';
  get diagnostics jobs = row_count;
  delete from public.ai_spend_daily where day < public._ai_today() - 400;
  delete from public.ai_user_spend_daily where day < public._ai_today() - 400;
  delete from public.ai_spend_alerts where day < public._ai_today() - 400;
  delete from public.ai_spend_capped where day < public._ai_today() - 400;
  return jsonb_build_object('calls', calls, 'jobs', jobs);
end;
$$;

-- The Worker's settings cache (service role).
create function public.ai_settings_get() returns jsonb
language sql stable security definer set search_path = '' as $$
  select public._ai_settings_json(s) from public.ai_settings s where s.id = 1;
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: service_role only. Internal helpers (_*) are callable by no role but their owner.
-- ---------------------------------------------------------------------------------------------
revoke all on public.ai_settings, public.ai_spend_daily, public.ai_user_spend_daily, public.ai_spend_alerts, public.ai_spend_capped, public.ai_calls,
  public.ai_member_settings, public.credit_balances, public.credit_ledger, public.ai_jobs, public.ai_job_items,
  public.photo_masks, public.photo_signals, public.photo_scenes, public.people, public.faces, public.face_rejections
from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on function
  public._ai_same_owner(),
  public._face_person_same_owner(),
  public._job_item_same_owner(),
  public._edit_cutout_ok(uuid, uuid, jsonb),
  public._edit_cutout_guard(),
  public._ai_today(),
  public._ai_next_midnight(),
  public._ai_period(timestamptz),
  public._ai_rules(text),
  public._ai_plan(uuid),
  public._ai_settings(),
  public._ai_feature(public.ai_settings, text),
  public._ai_member(uuid),
  public._ai_settings_json(public.ai_settings),
  public._ai_spend_json(),
  public._ai_cloud_paused(),
  public._ai_spend_reserve(text, uuid, bigint),
  public._ai_spend_settle(text, uuid, date, bigint, bigint, integer, integer),
  public._ai_log_calls(text, jsonb),
  public._credits_lock(uuid),
  public._credits_roll(uuid),
  public._credits_json(public.credit_balances),
  public._ai_refund_item(uuid),
  public._ai_job_json(public.ai_jobs, text),
  public._ai_item_json(public.ai_job_items),
  public._ai_job_touch(uuid),
  public._ai_item_fail(uuid, text),
  public._mask_key(uuid, uuid, uuid),
  public._photo_keys(uuid, uuid),
  public._ai_faces_delete(uuid),
  public._ai_faces_block(uuid),
  public._ai_person_recount(uuid),
  public._ai_person_json(public.people)
from service_role;
grant execute on function
  public.list_photos(uuid, text, uuid, text, date, date, text, text, integer, text, uuid),
  public.sweep_photo_rows(uuid[]),
  public.save_edit(uuid, uuid, jsonb, integer),
  public.ai_status(uuid),
  public.ai_member_settings_update(uuid, jsonb),
  public.ai_credit_history(uuid, text, integer),
  public.ai_bg_job_create(uuid, uuid[], jsonb, text, boolean),
  public.ai_device_job_create(uuid, uuid[], jsonb, text, text, text),
  public.ai_jobs_list(uuid, text, text, text),
  public.ai_job_get(uuid, uuid, integer, text),
  public.ai_job_cancel(uuid, uuid, text),
  public.ai_job_retry(uuid, uuid, uuid[], text),
  public.ai_device_claim(uuid, uuid, text, text),
  public.ai_device_progress(uuid, uuid, text, uuid[], uuid[]),
  public.ai_device_pause(uuid, uuid, text),
  public.ai_mask_key(uuid, uuid, uuid),
  public.ai_item_begin(uuid, bigint),
  public.ai_item_complete(uuid, uuid, text, integer, integer, integer, text, bigint, integer, jsonb),
  public.ai_item_failed(uuid, text, bigint, jsonb),
  public.ai_scene_begin(uuid, uuid, bigint),
  public.ai_scene_done(uuid, uuid, jsonb, bigint, bigint, jsonb),
  public.ai_scenes(uuid),
  public.ai_signals_pending(uuid, integer, text, integer),
  public.ai_signals_save(uuid, integer, jsonb),
  public.ai_cleanup_page(uuid, text),
  public.ai_cleanup_ignore(uuid, text, uuid[]),
  public.ai_faces_pending(uuid, integer, text, integer),
  public.ai_faces_add(uuid, integer, real, jsonb),
  public.ai_people_list(uuid, boolean, integer),
  public.ai_person_get(uuid, uuid),
  public.ai_person_patch(uuid, uuid, jsonb),
  public.ai_person_merge(uuid, uuid, uuid[]),
  public.ai_person_faces(uuid, uuid, text, uuid[], uuid[], text),
  public.ai_face_suggestions(uuid, real),
  public.ai_faces_delete_all(uuid),
  public.admin_ai_settings(uuid),
  public.admin_ai_settings_update(uuid, jsonb),
  public.ai_alert_recipients(text),
  public.admin_ai_jobs(uuid),
  public.ai_due_items(integer),
  public.ai_items_enqueued(uuid[]),
  public.ai_scene_backfill(integer),
  public.ai_face_lapses(integer),
  public.ai_prune(),
  public.ai_settings_get()
to service_role;
