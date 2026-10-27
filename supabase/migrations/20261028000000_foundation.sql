-- Zephyr foundation schema: settings, profiles, staff, plans and versioned plan limits, invites,
-- invite codes, invite requests and an append-only audit log.
--
-- Security model
--   * Row Level Security is on for every table. Only the rules written here grant access.
--   * The browser never talks to these tables directly except a member reading/updating their own
--     profile. Everything else goes through the API Worker, which uses the service_role key
--     (service_role bypasses RLS) after its own checks.
--   * SECURITY DEFINER functions pin `search_path = ''` and schema-qualify every name. With an
--     empty search_path the citext `=` operator isn't found, so email matches use lower(email::text).

create extension if not exists citext with schema extensions;

-- Supabase grants broad default privileges to anon/authenticated on new objects in `public`.
-- Remove them so a table is unreachable from the browser until a policy and grant say otherwise.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
-- Postgres grants EXECUTE to PUBLIC on every new function. That built-in default is global, so a
-- per-schema revoke can't remove it; this one does (migrations run as postgres).
alter default privileges for role postgres revoke execute on functions from public;

-- ---------------------------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------------------------
create type public.signup_mode as enum ('open', 'invite_only');
create type public.staff_role as enum ('owner', 'admin', 'finance', 'safety', 'support');
create type public.invite_source as enum ('admin', 'member', 'code', 'request');
create type public.invite_request_status as enum ('pending', 'approved', 'declined');

-- ---------------------------------------------------------------------------------------------
-- App settings (one row). Invite only is the default sign-up mode.
-- ---------------------------------------------------------------------------------------------
create table public.app_settings (
  id smallint primary key default 1 check (id = 1),
  signup_mode public.signup_mode not null default 'invite_only',
  accept_invite_requests boolean not null default true,
  signups_paused boolean not null default false,
  member_invites_enabled boolean not null default true,
  member_invites_per_month integer not null default 3 check (member_invites_per_month between 0 and 50),
  invite_ttl_days integer not null default 7 check (invite_ttl_days between 1 and 90),
  deleted_account_retention_days integer not null default 30 check (deleted_account_retention_days between 1 and 90),
  lapsed_plan_retention_days integer not null default 365 check (lapsed_plan_retention_days between 30 and 730),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
insert into public.app_settings (id) values (1);
alter table public.app_settings enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Plans and versioned plan limits (Option 1: every limit is admin-editable, nothing hard-coded)
-- ---------------------------------------------------------------------------------------------
create table public.plans (
  id text primary key check (id in ('free', 'pro', 'studio')),
  name text not null,
  sort smallint not null,
  stripe_price_monthly text,
  stripe_price_yearly text
);
alter table public.plans enable row level security;

create table public.plan_limit_versions (
  id bigint generated always as identity primary key,
  version integer not null unique check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'approved', 'active', 'superseded')),
  reason text not null check (length(reason) between 3 and 1000),
  effective_mode text not null default 'next_renewal'
    check (effective_mode in ('new_signups', 'next_renewal', 'immediate')),
  -- Staff user ids, kept as a permanent record (no foreign key, like audit_log.actor) so that
  -- deleting a staff account can never null them out and weaken the rule below.
  created_by uuid,
  approved_by uuid,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  -- Two-person rule: anything past draft needs a known author and a different, known approver.
  -- Version 1 (the launch limits, seeded by migration) is the only exception.
  constraint plan_limit_versions_two_person check (
    status = 'draft'
    or version = 1
    or (created_by is not null and approved_by is not null and approved_by <> created_by)
  ),
  constraint plan_limit_versions_no_self_approval check (approved_by is null or approved_by is distinct from created_by)
);
create unique index plan_limit_versions_one_active on public.plan_limit_versions ((true)) where status = 'active';
alter table public.plan_limit_versions enable row level security;

create table public.plan_limits (
  version_id bigint not null references public.plan_limit_versions (id) on delete cascade,
  plan_id text not null references public.plans (id),
  storage_gb integer not null check (storage_gb between 0 and 100000),
  cloud_credits_month integer not null check (cloud_credits_month between 0 and 1000000),
  credits_rollover boolean not null default false,
  -- System ceiling set by the GPU queue; Admin can't exceed it.
  batch_size integer not null check (batch_size between 1 and 2000),
  -- Server allow-list. Types that can carry scripts (svg, html, pdf) are never allowed.
  file_types text[] not null
    check (cardinality(file_types) > 0 and file_types <@ array['jpeg', 'png', 'webp', 'heic', 'cr2', 'nef', 'arw', 'dng']),
  max_file_mb integer not null default 100 check (max_file_mb between 1 and 500),
  galleries integer check (galleries is null or galleries >= 0), -- null = unlimited
  max_link_days integer check (max_link_days is null or max_link_days between 1 and 3650), -- null = no cap
  guest_full_res boolean not null default false,
  branding boolean not null default false,
  people_grouping boolean not null default false,
  seats integer not null default 1 check (seats between 1 and 100),
  ads boolean not null default false,
  priority_queue boolean not null default false,
  primary key (version_id, plan_id)
);
alter table public.plan_limits enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Profiles and staff
-- ---------------------------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or length(display_name) <= 80),
  plan_id text not null default 'free' references public.plans (id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table public.profiles enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
grant select on public.profiles to authenticated;
-- Members may only change their display name; plan and deletion state are server-managed.
grant update (display_name) on public.profiles to authenticated;

create table public.staff (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.staff_role not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);
alter table public.staff enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Invites
-- ---------------------------------------------------------------------------------------------
create table public.invite_codes (
  id uuid primary key default gen_random_uuid(),
  code extensions.citext not null unique check (code::text ~ '^[A-Za-z0-9-]{4,32}$'),
  label text check (label is null or length(label) <= 120),
  max_uses integer not null check (max_uses between 1 and 100000),
  uses integer not null default 0 check (uses >= 0 and uses <= max_uses),
  expires_at timestamptz not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table public.invite_codes enable row level security;

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  email extensions.citext not null check (length(email::text) <= 254),
  -- SHA-256 of a >=128-bit random token. The raw token only ever exists in the invite email.
  token_hash bytea not null unique check (length(token_hash) = 32),
  source public.invite_source not null,
  invited_by uuid references auth.users (id) on delete set null,
  code_id uuid references public.invite_codes (id) on delete set null,
  note text check (note is null or length(note) <= 500),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);
create index invites_email_open on public.invites (lower(email::text)) where accepted_at is null and revoked_at is null;
alter table public.invites enable row level security;

create table public.invite_requests (
  id uuid primary key default gen_random_uuid(),
  email extensions.citext not null check (length(email::text) <= 254),
  use_case text check (use_case is null or use_case in ('weddings_events', 'portraits', 'real_estate', 'products', 'personal')),
  -- HMAC-SHA-256 of the requester's network (IPv4 address or IPv6 /64), keyed by a Worker secret.
  -- Raw IPs are never stored. Kept only while the request is pending, to help spot clusters.
  ip_hash bytea check (ip_hash is null or length(ip_hash) = 32),
  disposable boolean not null default false,
  status public.invite_request_status not null default 'pending',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null,
  constraint invite_requests_ip_hash_pending_only check (status = 'pending' or ip_hash is null)
);
create unique index invite_requests_one_pending on public.invite_requests (email) where status = 'pending';
create index invite_requests_created on public.invite_requests (created_at);
alter table public.invite_requests enable row level security;

-- Once a request is decided, its network hash has no further use: drop it.
create function public.invite_requests_forget_ip() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status <> 'pending' then
    new.ip_hash := null;
  end if;
  return new;
end;
$$;
create trigger invite_requests_forget_ip before insert or update of status on public.invite_requests
  for each row execute function public.invite_requests_forget_ip();

-- Every call to submit_invite_request that passes the limits, new email or not. Rate limits count
-- these rows, so a duplicate costs the same as a new request and the limit reveals nothing about
-- which emails are already on the list. Purged after 2 days.
create table public.invite_request_attempts (
  id bigint generated always as identity primary key,
  ip_hash bytea not null check (length(ip_hash) = 32),
  created_at timestamptz not null default now()
);
create index invite_request_attempts_ip on public.invite_request_attempts (ip_hash, created_at desc);
create index invite_request_attempts_created on public.invite_request_attempts (created_at);
alter table public.invite_request_attempts enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  actor uuid,
  action text not null check (length(action) between 1 and 120),
  target text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.audit_log enable row level security;

create function public.audit_log_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_log is append-only' using errcode = 'insufficient_privilege';
end;
$$;
create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function public.audit_log_immutable();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.audit_log_immutable();

-- ---------------------------------------------------------------------------------------------
-- Public config (read by the landing page through the API)
-- ---------------------------------------------------------------------------------------------
create function public.get_public_config() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'signupMode', s.signup_mode,
    'acceptingInviteRequests', s.accept_invite_requests and not s.signups_paused,
    'signupsPaused', s.signups_paused
  )
  from public.app_settings s where s.id = 1;
$$;
-- Only the API (service_role) calls this. Its values aren't secret, but keeping PostgREST's anon
-- surface empty means the anon key exposes nothing, and the API can cache and shape the response.
revoke execute on function public.get_public_config() from public, anon, authenticated;
grant execute on function public.get_public_config() to service_role;

-- ---------------------------------------------------------------------------------------------
-- Invite requests from the landing page
-- ---------------------------------------------------------------------------------------------
-- Returns 'accepted' | 'rate_limited' | 'not_accepting'. 'accepted' is identical for a new
-- request, a duplicate and an email that already has an account, so the result reveals nothing.
create function public.submit_invite_request(
  p_email text,
  p_use_case text,
  p_ip_hash bytea,
  p_disposable boolean
) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  -- Limits. The per-network burst matches INVITE_REQUEST_LIMITS in @zephyr/shared.
  c_per_network_15_min constant integer := 5;
  c_per_network_day constant integer := 20;
  -- Backstop against list stuffing from many networks at once.
  c_global_day constant integer := 500;
  s public.app_settings%rowtype;
  recent integer;
  today integer;
  everyone integer;
begin
  select * into s from public.app_settings where id = 1;
  if s.signups_paused or not s.accept_invite_requests then
    return 'not_accepting';
  end if;

  -- Serialise per network so concurrent requests can't slip past the per-network counts.
  perform pg_advisory_xact_lock(hashtextextended(encode(p_ip_hash, 'hex'), 0));

  select count(*) filter (where created_at > now() - interval '15 minutes'), count(*)
    into recent, today
    from public.invite_request_attempts
   where ip_hash = p_ip_hash and created_at > now() - interval '1 day';
  select count(*) into everyone
    from public.invite_request_attempts
   where created_at > now() - interval '1 day';
  if recent >= c_per_network_15_min or today >= c_per_network_day or everyone >= c_global_day then
    return 'rate_limited';
  end if;

  -- Count the attempt before the duplicate check, so duplicates and new emails cost the same.
  insert into public.invite_request_attempts (ip_hash) values (p_ip_hash);

  insert into public.invite_requests (email, use_case, ip_hash, disposable)
  values (lower(trim(p_email)), p_use_case, p_ip_hash, coalesce(p_disposable, false))
  on conflict (email) where status = 'pending' do nothing;

  return 'accepted';
end;
$$;
revoke execute on function public.submit_invite_request(text, text, bytea, boolean) from public, anon, authenticated;
grant execute on function public.submit_invite_request(text, text, bytea, boolean) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Auth hook: before a user is created, enforce the sign-up mode on the server.
-- Payload: { metadata: {...}, user: { email, ... } }. Return {} to allow, or
-- { error: { http_code, message } } to reject.
-- https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook
-- ---------------------------------------------------------------------------------------------
create function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  s public.app_settings%rowtype;
  v_email text := lower(trim(event -> 'user' ->> 'email'));
begin
  select * into s from public.app_settings where id = 1;

  if s.signups_paused then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Sign-ups are paused.'));
  end if;

  if s.signup_mode = 'invite_only' then
    if v_email is null or v_email = '' or not exists (
      select 1 from public.invites i
      where lower(i.email::text) = v_email
        and i.accepted_at is null
        and i.revoked_at is null
        and i.expires_at > now()
    ) then
      return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Zephyr is invite-only right now.'));
    end if;
  end if;

  return '{}'::jsonb;
end;
$$;
revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
grant usage on schema public to supabase_auth_admin;
grant usage on schema extensions to supabase_auth_admin;
grant select on public.app_settings, public.invites to supabase_auth_admin;
create policy app_settings_auth_admin_read on public.app_settings for select to supabase_auth_admin using (true);
create policy invites_auth_admin_read on public.invites for select to supabase_auth_admin using (true);

-- ---------------------------------------------------------------------------------------------
-- New user: create the profile. The invite is consumed only once the email address is confirmed
-- (handle_user_confirmed), so an unconfirmed sign-up by someone who merely knows an invited email
-- can't use up, or take over, that invite.
-- ---------------------------------------------------------------------------------------------
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.handle_user_confirmed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.invites
     set accepted_at = now()
   where id = (
     select i.id from public.invites i
      where lower(i.email::text) = lower(new.email)
        and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
      order by i.created_at desc
      limit 1
   );

  update public.invite_requests
     set status = 'approved', decided_at = coalesce(decided_at, now())
   where lower(email::text) = lower(new.email) and status = 'pending';

  return new;
end;
$$;
revoke execute on function public.handle_user_confirmed() from public, anon, authenticated;
create trigger on_auth_user_created_confirmed after insert on auth.users
  for each row when (new.email_confirmed_at is not null)
  execute function public.handle_user_confirmed();
create trigger on_auth_user_email_confirmed after update of email_confirmed_at on auth.users
  for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.handle_user_confirmed();

-- ---------------------------------------------------------------------------------------------
-- Retention: purge old unapproved invite requests (called daily by pg_cron, see next migration).
-- ---------------------------------------------------------------------------------------------
create function public.purge_invite_requests() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.invite_requests
   where status <> 'approved' and created_at < now() - interval '90 days';
  get diagnostics n = row_count;
  delete from public.invite_request_attempts where created_at < now() - interval '2 days';
  return n;
end;
$$;
revoke execute on function public.purge_invite_requests() from public, anon, authenticated;
grant execute on function public.purge_invite_requests() to service_role;
-- TODO(accounts phase): purge deleted accounts after app_settings.deleted_account_retention_days.

-- ---------------------------------------------------------------------------------------------
-- Least privilege for browser roles: nothing in public is reachable except the profile grants above.
-- ---------------------------------------------------------------------------------------------
revoke all on public.app_settings, public.plans, public.plan_limit_versions, public.plan_limits,
  public.staff, public.invite_codes, public.invites, public.invite_requests,
  public.invite_request_attempts, public.audit_log
  from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.get_public_config(), public.submit_invite_request(text, text, bytea, boolean),
  public.purge_invite_requests() to service_role;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
revoke insert, delete, truncate, references, trigger on public.profiles from anon, authenticated;
revoke all on public.profiles from anon;
