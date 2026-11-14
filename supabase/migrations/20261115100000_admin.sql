-- Phase 8: the admin portal (users, safety, plan limits, ads, retention, staff, audit, settings) and the member-side
-- pieces it needs (app status, ads, gallery link replacement, retention notice). Design: docs/phase-8.md.
--
-- Every staff function takes p_staff, re-checks the role in SQL with public._staff_can (the same table as
-- STAFF_CAN in packages/shared/src/admin-types.ts) and writes audit_log with a reason. High-risk changes also need
-- a recent passkey, which the API checks (it can't be seen from here). Functions return the JSON shapes of
-- admin-types.ts without `ok`; refusals are { error: '<code>' }, unknown targets null.

-- ---------------------------------------------------------------------------------------------
-- Staff roles
-- ---------------------------------------------------------------------------------------------
create function public._staff_role_of(p_staff uuid) returns public.staff_role
language sql stable set search_path = '' as $$
  select s.role from public.staff s where s.user_id = p_staff;
$$;

-- STAFF_CAN, mirrored exactly. Unknown actions and non-staff are refused.
create function public._staff_can(p_staff uuid, p_action text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(public._staff_role_of(p_staff)::text = any (case p_action
    when 'usersView' then array['owner', 'admin', 'finance', 'safety', 'support']
    when 'usersAct' then array['owner', 'admin', 'safety', 'support']
    when 'planOverride' then array['owner', 'admin', 'finance']
    when 'suspend' then array['owner', 'admin', 'safety']
    when 'deleteAccount' then array['owner']
    when 'safetyView' then array['owner', 'admin', 'safety']
    when 'safetyAct' then array['safety']
    when 'holdsRecord' then array['owner', 'safety']
    when 'holdsRelease' then array['owner']
    when 'limits' then array['owner', 'finance']
    when 'limitsView' then array['owner', 'admin', 'finance']
    when 'ads' then array['owner', 'admin']
    when 'adsense' then array['owner']
    when 'storage' then array['owner', 'admin']
    when 'retention' then array['owner', 'admin']
    when 'staff' then array['owner']
    when 'auditView' then array['owner', 'admin', 'finance', 'safety']
    when 'auditExport' then array['owner', 'admin']
    when 'settings' then array['owner', 'admin']
    else array[]::text[] end), false);
$$;

-- A staff member's display name for the admin screens: display name, else the address (staff see each other).
create function public._staff_name(p_staff uuid) returns text
language sql stable set search_path = '' as $$
  select coalesce((select nullif(btrim(p.display_name), '') from public.profiles p where p.id = p_staff),
                  (select u.email::text from auth.users u where u.id = p_staff), 'Staff');
$$;

-- m•••@example.com
create function public._mask_email(p_email text) returns text
language sql immutable set search_path = '' as $$
  select case when p_email is null or position('@' in p_email) = 0 then null
              else left(split_part(p_email, '@', 1), 1) || '•••@' || split_part(p_email, '@', 2) end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Audit log: a kind for filtering (still append-only; adding a generated column is not an UPDATE)
-- ---------------------------------------------------------------------------------------------
create function public._audit_kind(p_action text) returns text
language sql immutable set search_path = '' as $$
  select case split_part(p_action, '.', 1)
    when 'users' then 'users' when 'account' then 'users'
    when 'safety' then 'safety'
    when 'billing' then 'billing' when 'prices' then 'billing'
    when 'limits' then 'limits'
    when 'storage' then 'storage'
    when 'staff' then 'staff'
    when 'ads' then 'ads'
    when 'settings' then 'settings'
    when 'ai' then 'ai'
    when 'signups' then 'signups' when 'invites' then 'signups' when 'invite' then 'signups'
    when 'retention' then 'users'
    when 'audit' then 'staff'
    else null end;
$$;
alter table public.audit_log add column kind text generated always as (public._audit_kind(action)) stored;
create index audit_log_kind on public.audit_log (kind, id desc);
create index audit_log_actor on public.audit_log (actor, id desc);
create index audit_log_target on public.audit_log (target, id desc);

-- ---------------------------------------------------------------------------------------------
-- Settings: read-only mode, maintenance notice, AdSense (one row, phase 1's app_settings)
-- ---------------------------------------------------------------------------------------------
alter table public.app_settings
  add column read_only jsonb not null default '{"on": false, "auto": false, "message": "", "since": null}'::jsonb,
  add column maintenance jsonb not null default '{"on": false, "message": "", "startsAt": null, "endsAt": null}'::jsonb,
  add column adsense jsonb not null default '{"enabled": false, "publisherId": null, "slots": {}, "enabledAt": null, "enabledBy": null}'::jsonb;

-- ---------------------------------------------------------------------------------------------
-- Profiles: plan overrides, suspension, lapse date, staff-scheduled deletion
-- ---------------------------------------------------------------------------------------------
alter table public.profiles
  add column plan_override_plan text references public.plans (id),
  add column plan_override_until timestamptz,
  add column plan_override_by uuid,
  add column plan_override_reason text check (plan_override_reason is null or length(plan_override_reason) <= 300),
  add column suspended_at timestamptz,
  add column suspended_category text check (suspended_category is null or suspended_category in ('abuse', 'safety', 'fraud', 'legal', 'other')),
  add column suspended_by uuid,
  add column lapsed_at timestamptz,
  add column deletion_by_staff uuid,
  add constraint profiles_override_shape check ((plan_override_plan is null) = (plan_override_by is null)),
  add constraint profiles_suspend_shape check ((suspended_at is null) = (suspended_category is null));
create index profiles_override_due on public.profiles (plan_override_until) where plan_override_plan is not null;
create index profiles_lapsed on public.profiles (lapsed_at) where lapsed_at is not null;

-- When a paid plan ends (Stripe, the past-due expiry, an override ending), the retention year starts; a paid
-- plan again clears it. Any writer of profiles.plan_id goes through this.
create function public._profile_lapse() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.plan_id = 'free' and old.plan_id <> 'free' then
    new.lapsed_at := coalesce(new.lapsed_at, now());
  elsif new.plan_id <> 'free' then
    new.lapsed_at := null;
  end if;
  return new;
end;
$$;
create trigger profiles_lapse before update of plan_id on public.profiles
  for each row when (new.plan_id is distinct from old.plan_id) execute function public._profile_lapse();

-- A suspended owner's team library is unusable (teammates lose access; invites can't be used).
create or replace function public._team_owner_ok(p_owner uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = p_owner and p.deleted_at is null and p.deletion_due is null
                  and p.suspended_at is null);
$$;

-- A deletion staff scheduled can't be undone by the member (only by an Owner).
create or replace function public.restore_account(p_owner uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.profiles set deletion_requested_at = null, deletion_due = null
   where id = p_owner and deletion_due > now() and deletion_by_staff is null;
  if not found then return null; end if;
  perform public._audit(p_owner, 'account.restored', null, '{}'::jsonb);
  return true;
end;
$$;

-- A suspended owner's team library: teammates lose access until the suspension ends (the owner's own sessions
-- are ended and requireMember refuses them).
create or replace function public.library_access(p_member uuid, p_owner uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  pr public.profiles;
  tm record;
begin
  select * into pr from public.profiles where id = p_owner and deleted_at is null;
  if not found then return null; end if;
  if p_member = p_owner then
    return jsonb_build_object('ownerId', p_owner, 'role', 'owner', 'plan', pr.plan_id,
                              'state', public._library_state(p_owner), 'self', true);
  end if;
  if pr.suspended_at is not null then return null; end if;
  select * into tm from public._team_members(p_owner) x where x.member_id = p_member;
  if not found or tm.suspended then return null; end if;
  return jsonb_build_object('ownerId', p_owner, 'role', tm.role, 'plan', pr.plan_id,
                            'state', public._library_state(p_owner), 'self', false);
end;
$$;

create or replace function public.list_libraries(p_member uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_array(jsonb_build_object(
           'ownerId', pr.id, 'name', public._self_name(pr.id), 'ownerName', public._self_name(pr.id), 'role', 'owner', 'plan', pr.plan_id,
           'state', public._library_state(pr.id), 'initials', public._initials(public._self_name(pr.id))))
         || coalesce((select jsonb_agg(x.j order by x.name, x.owner_id) from (
              select m.owner_id, public._team_name(m.owner_id) as name,
                     jsonb_build_object('ownerId', m.owner_id, 'name', public._team_name(m.owner_id),
                                        'ownerName', public._owner_name(m.owner_id), 'role', m.role,
                                        'plan', op.plan_id, 'state', public._library_state(m.owner_id),
                                        'initials', public._initials(public._team_name(m.owner_id))) as j
                from public.library_members m join public.profiles op on op.id = m.owner_id
               where m.member_id = p_member and op.suspended_at is null
                 and not coalesce((select tm.suspended from public._team_members(m.owner_id) tm where tm.member_id = p_member), true)
            ) x), '[]'::jsonb)
  from public.profiles pr where pr.id = p_member and pr.deleted_at is null), '[]'::jsonb);
$$;

-- Suspension also kills the owner's open team invites (the phase 7 guard only watches plan and deletion).
create function public._suspend_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public._team_revoke_open_invites(new.id);
  return null;
end;
$$;
create trigger profiles_suspend_guard after update of suspended_at on public.profiles
  for each row when (new.suspended_at is not null and old.suspended_at is null) execute function public._suspend_guard();

-- ---------------------------------------------------------------------------------------------
-- Safety
-- ---------------------------------------------------------------------------------------------
alter table public.photos add column safety_hold_source text check (safety_hold_source is null or safety_hold_source in ('csam_scan', 'staff'));
update public.photos set safety_hold_source = 'csam_scan' where safety_hold_at is not null;
create index photos_held on public.photos (safety_hold_at) where safety_hold_at is not null;

alter table public.gallery_reports
  add column resolved_by uuid,
  add column resolution jsonb,
  add column resolution_note text check (resolution_note is null or length(resolution_note) <= 300);

create table public.safety_hold_reports (
  photo_id uuid primary key references public.photos (id) on delete cascade,
  authority text not null check (length(authority) between 2 and 120),
  reference text not null check (length(reference) between 2 and 120),
  recorded_by uuid not null,
  recorded_at timestamptz not null default now()
);
alter table public.safety_hold_reports enable row level security;

create table public.reveal_grants (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null,
  report_id uuid not null,
  photo_ids uuid[] not null check (cardinality(photo_ids) between 1 and 50),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  reason text not null check (length(reason) between 3 and 300),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.reveal_grants enable row level security;
create index reveal_grants_staff on public.reveal_grants (staff_id, expires_at);

-- Holds are lifted only through admin_hold_release (which sets this flag for its own transaction).
create or replace function public._safety_hold_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.safety_hold_at is not null then
    if tg_op = 'DELETE' then return null; end if;
    if new.status is distinct from old.status and new.status in ('trashed', 'purging') then return null; end if;
    if new.safety_hold_at is null and coalesce(current_setting('zephyr.safety_release', true), '') <> 'on' then
      raise exception 'a safety hold is lifted by staff review only' using errcode = 'check_violation';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

-- Scanner matches record their source (the phase 5 function, unchanged otherwise).
create or replace function public.apply_safety_hold(p_gallery uuid, p_photo uuid) returns jsonb
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
  update public.photos set safety_hold_at = coalesce(safety_hold_at, now()),
                           safety_hold_source = coalesce(safety_hold_source, 'csam_scan') where id = p_photo;
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
-- Plan limits: one version for everyone on a set date (replaces the two-person rule)
-- ---------------------------------------------------------------------------------------------
alter table public.plan_limit_versions drop constraint plan_limit_versions_two_person;
alter table public.plan_limit_versions drop constraint plan_limit_versions_no_self_approval;
alter table public.plan_limit_versions drop constraint plan_limit_versions_status_check;
alter table public.plan_limit_versions
  add constraint plan_limit_versions_status_check check (status in ('draft', 'approved', 'scheduled', 'active', 'superseded', 'cancelled')),
  add column effective_at timestamptz,
  add constraint plan_limit_versions_scheduled_at check (status <> 'scheduled' or effective_at is not null);
create unique index plan_limit_versions_one_draft on public.plan_limit_versions ((true)) where status = 'draft';
create unique index plan_limit_versions_one_scheduled on public.plan_limit_versions ((true)) where status = 'scheduled';

create table public.limits_notices (
  version_id bigint not null references public.plan_limit_versions (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  sent_at timestamptz,
  primary key (version_id, owner_id)
);
alter table public.limits_notices enable row level security;
create index limits_notices_due on public.limits_notices (version_id) where sent_at is null;

-- ---------------------------------------------------------------------------------------------
-- Ads
-- ---------------------------------------------------------------------------------------------
create table public.ad_cards (
  id uuid primary key default gen_random_uuid(),
  advertiser text not null check (length(advertiser) between 1 and 40),
  headline text not null check (length(headline) between 1 and 40),
  body text not null check (length(body) between 1 and 90),
  url text not null check (url ~ '^https://[^/@\s]+(/[^\s]*)?$' and length(url) <= 500),
  placements text[] not null check (cardinality(placements) between 1 and 3 and placements <@ array['library', 'sidebar', 'batch']),
  starts_at timestamptz,
  ends_at timestamptz,
  weight integer not null default 50 check (weight between 1 and 100),
  image_key text check (image_key is null or image_key ~ '^ads/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$'),
  image_version integer check (image_version is null or image_version >= 1),
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'ended')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ad_cards_dates check (starts_at is null or ends_at is null or starts_at < ends_at)
);
alter table public.ad_cards enable row level security;

create table public.ad_stats_daily (
  card_id uuid not null references public.ad_cards (id) on delete cascade,
  day date not null,
  placement text not null check (placement in ('library', 'sidebar', 'batch')),
  impressions integer not null default 0 check (impressions >= 0),
  clicks integer not null default 0 check (clicks >= 0),
  primary key (card_id, day, placement)
);
alter table public.ad_stats_daily enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------------------------
create table public.retention_items (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  lapsed_at timestamptz not null,
  due_at timestamptz not null,
  over_bytes bigint not null default 0 check (over_bytes >= 0),
  photos_to_trash integer not null default 0 check (photos_to_trash >= 0),
  notice_30_at timestamptz,
  notice_7_at timestamptz,
  state text not null default 'waiting' check (state in ('waiting', 'ready', 'approved', 'trashed', 'resolved')),
  approved_by uuid,
  approved_at timestamptz,
  trashed_at timestamptz,
  trashed_photos integer not null default 0 check (trashed_photos >= 0),
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.retention_items enable row level security;
create index retention_items_state on public.retention_items (state, due_at);

-- ---------------------------------------------------------------------------------------------
-- Staff invites
-- ---------------------------------------------------------------------------------------------
create table public.staff_invites (
  id uuid primary key default gen_random_uuid(),
  email extensions.citext not null check (length(email::text) between 3 and 254),
  role public.staff_role not null,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_user uuid,
  revoked_at timestamptz
);
alter table public.staff_invites enable row level security;
create unique index staff_invites_open on public.staff_invites (email) where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------------------------
-- The plan Stripe says (phase 7 rules), ignoring any override.
create function public._stripe_plan(p_owner uuid) returns text
language sql stable set search_path = '' as $$
  select coalesce((select s.plan_id from public.subscriptions s
                    where s.owner_id = p_owner and public._sub_keeps(s.status, s.past_due_since)), 'free');
$$;

-- The effective plan: a live override, else Stripe.
create function public._plan_effective(p_owner uuid) returns text
language sql stable set search_path = '' as $$
  select case when p.plan_override_plan is not null and (p.plan_override_until is null or p.plan_override_until > now())
              then p.plan_override_plan else public._stripe_plan(p_owner) end
    from public.profiles p where p.id = p_owner;
$$;

-- Writes profiles.plan_id/plan_source and adds the difference in monthly credits within the same period (the
-- phase 7 billing_apply rule). Call under _lock_billing(owner).
create function public._set_plan(p_owner uuid, p_plan text, p_source text, p_actor uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  before text;
  b0 public.credit_balances;
  b1 public.credit_balances;
  m0 integer;
  m1 integer;
begin
  select plan_id into before from public.profiles where id = p_owner for update;
  perform public._credits_lock(p_owner);
  b0 := public._credits_roll(p_owner);
  m0 := public._plan_monthly_credits(before);
  update public.profiles set plan_id = p_plan, plan_source = p_source where id = p_owner;
  if p_plan <> before then
    b1 := public._credits_roll(p_owner);
    m1 := public._plan_monthly_credits(p_plan);
    if b1.period_start = b0.period_start and m1 > m0 then
      insert into public.credit_ledger (owner_id, delta, reason, label, period_start)
      values (p_owner, m1 - m0, 'plan_change', 'Upgrade to ' || initcap(p_plan), b1.period_start)
      on conflict do nothing;
      if found then
        update public.credit_balances set balance = balance + (m1 - m0), updated_at = now() where owner_id = p_owner;
      end if;
    end if;
    perform public._audit(p_actor, 'billing.plan_changed', p_owner::text,
                          jsonb_build_object('from', before, 'to', p_plan, 'source', p_source));
  end if;
end;
$$;

-- Ends every session in Auth (the cookies alone aren't enough). The tables exist in Supabase; the local test
-- stub mirrors them.
create function public._auth_sign_out_all(p_user uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if to_regclass('auth.refresh_tokens') is not null then
    execute 'delete from auth.refresh_tokens where user_id = $1' using p_user::text;
  end if;
  if to_regclass('auth.sessions') is not null then
    execute 'delete from auth.sessions where user_id = $1' using p_user;
  end if;
end;
$$;

create function public._auth_session_count(p_user uuid) returns integer
language plpgsql stable security definer set search_path = '' as $$
declare n integer := 0;
begin
  if to_regclass('auth.sessions') is not null then
    execute 'select count(*)::integer from auth.sessions where user_id = $1' using p_user into n;
  end if;
  return n;
end;
$$;

create function public._member_status(pr public.profiles) returns text
language sql stable set search_path = '' as $$
  select case when pr.deletion_due is not null then 'deletion_scheduled'
              when pr.suspended_at is not null then 'suspended'
              when public._library_state(pr.id) = 'read_only' then 'read_only'
              else 'active' end;
$$;

create function public._audit_entry(a public.audit_log) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', a.id::text, 'at', a.created_at,
    'actor', case when a.actor is null then jsonb_build_object('id', null, 'name', 'System', 'role', 'system')
                  when st.user_id is not null then jsonb_build_object('id', a.actor, 'name', public._staff_name(a.actor), 'role', st.role)
                  else jsonb_build_object('id', a.actor, 'name', 'Member', 'role', 'system') end,
    'action', a.action, 'target', a.target, 'reason', a.details ->> 'reason')
    from (select 1) x left join public.staff st on st.user_id = a.actor;
$$;

-- ---------------------------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------------------------
create function public._user_row(pr public.profiles, p_full boolean) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', pr.id, 'displayName', pr.display_name,
    'email', case when p_full then u.email::text else public._mask_email(u.email::text) end,
    'plan', pr.plan_id, 'planSource', pr.plan_source, 'storageBytes', pr.storage_bytes,
    'status', public._member_status(pr), 'createdAt', pr.created_at,
    'lastSeenAt', to_jsonb(u) -> 'last_sign_in_at')
    from auth.users u where u.id = pr.id;
$$;

-- AdminUsersResult without ok. Members only (staff accounts are separate). Keyset by created_at desc, id desc.
-- q: an exact email, a uuid, or a name prefix.
create function public.admin_users(p_staff uuid, p_q text, p_plan text, p_source text, p_status text, p_cursor text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c record;
  q text := nullif(btrim(coalesce(p_q, '')), '');
  q_id uuid;
  q_like text;
  res jsonb;
begin
  if not public._staff_can(p_staff, 'usersView') then return jsonb_build_object('error', 'forbidden'); end if;
  c := public._parse_cursor(p_cursor);
  if q is not null then
    if q ~* '^(usr_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then q_id := regexp_replace(q, '^usr_', '')::uuid;
    elsif position('@' in q) > 0 then q_id := coalesce(public.user_id_by_email(q), '00000000-0000-0000-0000-000000000000'::uuid);
    else q_like := replace(replace(replace(lower(q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    end if;
  end if;
  with sel as (
    select pr.* from public.profiles pr
     where pr.deleted_at is null
       and not exists (select 1 from public.staff s where s.user_id = pr.id)
       and (q_id is null or pr.id = q_id)
       and (q_like is null or lower(coalesce(pr.display_name, '')) like q_like)
       and (p_plan is null or pr.plan_id = p_plan)
       and (p_source is null or pr.plan_source = p_source)
       and (p_status is null or public._member_status(pr) = p_status)
  ), pg as (
    select s.*, row_number() over (order by s.created_at desc, s.id desc) as rn from sel s
     where c.at is null or (s.created_at, s.id) < (c.at, c.id)
     order by s.created_at desc, s.id desc limit 51
  )
  select jsonb_build_object('total', (select count(*) from sel),
    'page', jsonb_build_object(
      'items', coalesce((select jsonb_agg(public._user_row(pr, false) order by x.rn)
                           from pg x join public.profiles pr on pr.id = x.id where x.rn <= 50), '[]'::jsonb),
      'nextCursor', (select public._cursor(x.created_at, x.id) from pg x where x.rn = 50 and exists (select 1 from pg y where y.rn = 51))))
    into res;
  return res;
end;
$$;

create function public._user_detail(p_user uuid) returns jsonb
language sql stable set search_path = '' as $$
  select public._user_row(pr, true) || jsonb_build_object(
    'subscription', (select jsonb_build_object('plan', s.plan_id, 'interval', s.billing_interval, 'status', s.status,
                       'renewsAt', case when public._sub_keeps(s.status, s.past_due_since) and not s.cancel_at_period_end then s.current_period_end end,
                       'stripeCustomerUrl', null, 'stripeCustomerId', s.stripe_customer_id)
                       from public.subscriptions s where s.owner_id = pr.id),
    'override', case when pr.plan_override_plan is not null then jsonb_build_object(
                  'plan', pr.plan_override_plan, 'until', pr.plan_override_until,
                  'by', public._staff_name(pr.plan_override_by), 'reason', pr.plan_override_reason) end,
    'usage', jsonb_build_object(
      'storageBytes', pr.storage_bytes,
      'storageLimitBytes', (select r.storage_bytes from public._plan_rules(pr.plan_id) r),
      'credits', coalesce((select b.balance from public.credit_balances b where b.owner_id = pr.id), 0),
      'topUpCredits', public._topup_balance(pr.id),
      'liveGalleries', public._live_galleries(pr.id)),
    'teams', coalesce((select jsonb_agg(jsonb_build_object('ownerId', m.owner_id, 'name', public._team_name(m.owner_id), 'role', m.role)
                                        order by m.added_at)
                         from public.library_members m where m.member_id = pr.id), '[]'::jsonb),
    'signIn', jsonb_build_object('passkeys', null, 'activeSessions', public._auth_session_count(pr.id), 'lastPasskeyAt', null),
    'suspension', case when pr.suspended_at is not null then jsonb_build_object(
                    'at', pr.suspended_at, 'category', pr.suspended_category, 'by', public._staff_name(pr.suspended_by)) end,
    'sharingSuspendedAt', pr.sharing_suspended_at,
    'deletionDueAt', pr.deletion_due,
    'recent', coalesce((select jsonb_agg(public._audit_entry(a) order by a.id desc)
                          from (select * from public.audit_log a where a.target = pr.id::text and a.actor is distinct from pr.id
                                 order by a.id desc limit 10) a), '[]'::jsonb))
    from public.profiles pr where pr.id = p_user;
$$;

-- AdminUserDetail (logs users.viewed: the full address is shown).
create function public.admin_user(p_staff uuid, p_user uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare j jsonb;
begin
  if not public._staff_can(p_staff, 'usersView') then return jsonb_build_object('error', 'forbidden'); end if;
  if exists (select 1 from public.staff s where s.user_id = p_user) then return null; end if;
  j := public._user_detail(p_user);
  if j is null then return null; end if;
  perform public._audit(p_staff, 'users.viewed', p_user::text, '{}'::jsonb);
  return j;
end;
$$;

-- Common guard for staff actions on a member: role, target is a live member (not staff), reason length.
create function public._user_target_ok(p_staff uuid, p_user uuid, p_action text, p_reason text) returns text
language sql stable set search_path = '' as $$
  select case
    when not public._staff_can(p_staff, p_action) then 'forbidden'
    when p_reason is null or length(btrim(p_reason)) not between 3 and 300 then 'invalid'
    when exists (select 1 from public.staff s where s.user_id = p_user) then 'not_found'
    when not exists (select 1 from public.profiles p where p.id = p_user and p.deleted_at is null) then 'not_found'
    else null end;
$$;

-- Override (comp) a plan. The API checks the passkey. Returns AdminUserDetail.
create function public.admin_user_override(p_staff uuid, p_user uuid, p_plan text, p_until timestamptz, p_reason text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare err text := public._user_target_ok(p_staff, p_user, 'planOverride', p_reason);
begin
  if err is not null then return case when err = 'not_found' then null else jsonb_build_object('error', err) end; end if;
  if p_plan not in ('free', 'pro', 'studio') or (p_until is not null and (p_until <= now() or p_until > now() + interval '2 years 1 day')) then
    return jsonb_build_object('error', 'invalid');
  end if;
  perform public._lock_billing(p_user);
  update public.profiles set plan_override_plan = p_plan, plan_override_until = p_until, plan_override_by = p_staff,
                             plan_override_reason = btrim(p_reason)
   where id = p_user;
  perform public._set_plan(p_user, p_plan, 'admin', p_staff);
  perform public._audit(p_staff, 'users.override', p_user::text,
                        jsonb_build_object('plan', p_plan, 'until', p_until, 'reason', btrim(p_reason)));
  return public._user_detail(p_user);
end;
$$;

-- Ends an override: the plan goes back to what Stripe says. Saves at once (lowers risk). Returns AdminUserDetail.
create function public._override_end(p_user uuid, p_actor uuid, p_reason text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  perform public._lock_billing(p_user);
  update public.profiles set plan_override_plan = null, plan_override_until = null, plan_override_by = null,
                             plan_override_reason = null
   where id = p_user and plan_override_plan is not null;
  if not found then return; end if;
  perform public._set_plan(p_user, public._stripe_plan(p_user), 'stripe', p_actor);
  perform public._audit(p_actor, 'users.override_end', p_user::text, jsonb_build_object('reason', p_reason));
end;
$$;

create function public.admin_user_override_end(p_staff uuid, p_user uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare err text := public._user_target_ok(p_staff, p_user, 'planOverride', p_reason);
begin
  if err is not null then return case when err = 'not_found' then null else jsonb_build_object('error', err) end; end if;
  perform public._override_end(p_user, p_staff, btrim(p_reason));
  return public._user_detail(p_user);
end;
$$;

-- Cron: overrides past their end date (up to 1,000 a run). Returns the number ended.
create function public.admin_overrides_expire() returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare r record; n integer := 0;
begin
  for r in select id from public.profiles where plan_override_plan is not null and plan_override_until <= now()
           order by plan_override_until limit 1000 loop
    perform public._override_end(r.id, null, 'Override ended');
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Grants credits (phase 6 'admin_adjust'). Support: at most 1,000 per action. Returns AdminUserDetail.
create function public.admin_user_grant_credits(p_staff uuid, p_user uuid, p_amount integer, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  err text := public._user_target_ok(p_staff, p_user, 'usersAct', p_reason);
  b public.credit_balances;
begin
  if err is not null then return case when err = 'not_found' then null else jsonb_build_object('error', err) end; end if;
  if p_amount is null or p_amount < 1 or p_amount > 50000 then return jsonb_build_object('error', 'invalid'); end if;
  if public._staff_role_of(p_staff) not in ('owner', 'admin') and p_amount > 1000 then return jsonb_build_object('error', 'forbidden'); end if;
  perform public._credits_lock(p_user);
  b := public._credits_roll(p_user);
  insert into public.credit_ledger (owner_id, delta, reason, label, period_start)
  values (p_user, p_amount, 'admin_adjust', left('Added by Zephyr support', 160), b.period_start);
  update public.credit_balances set balance = balance + p_amount, updated_at = now() where owner_id = p_user;
  perform public._audit(p_staff, 'users.credits', p_user::text, jsonb_build_object('amount', p_amount, 'reason', btrim(p_reason)));
  return public._user_detail(p_user);
end;
$$;

create function public.admin_user_sign_out(p_staff uuid, p_user uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare err text := public._user_target_ok(p_staff, p_user, 'usersAct', p_reason);
begin
  if err is not null then return case when err = 'not_found' then null else jsonb_build_object('error', err) end; end if;
  perform public._auth_sign_out_all(p_user);
  perform public._audit(p_staff, 'users.sign_out', p_user::text, jsonb_build_object('reason', btrim(p_reason)));
  return public._user_detail(p_user);
end;
$$;

-- Suspends: ends every session, takes shared galleries offline (sharing suspended), teammates lose access
-- (_team_owner_ok). Saves at once. Returns AdminUserDetail (its `email` is the full address, for the notice).
create function public.admin_user_suspend(p_staff uuid, p_user uuid, p_category text, p_note text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare err text := public._user_target_ok(p_staff, p_user, 'suspend', p_note);
begin
  if err is not null then return case when err = 'not_found' then null else jsonb_build_object('error', err) end; end if;
  if p_category not in ('abuse', 'safety', 'fraud', 'legal', 'other') then return jsonb_build_object('error', 'invalid'); end if;
  update public.profiles set suspended_at = coalesce(suspended_at, now()), suspended_category = p_category, suspended_by = p_staff,
                             sharing_suspended_at = coalesce(sharing_suspended_at, now())
   where id = p_user;
  perform public._auth_sign_out_all(p_user);
  perform public._audit(p_staff, 'users.suspend', p_user::text, jsonb_build_object('category', p_category, 'reason', btrim(p_note)));
  return public._user_detail(p_user);
end;
$$;

-- Unsuspends (the API checks the passkey). Sharing stays suspended if a safety hold or a separate sharing
-- suspension is still in place: only a suspension this set is lifted with it.
create function public.admin_user_unsuspend(p_staff uuid, p_user uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  err text := public._user_target_ok(p_staff, p_user, 'suspend', p_reason);
  pr public.profiles;
begin
  if err is not null then return case when err = 'not_found' then null else jsonb_build_object('error', err) end; end if;
  select * into pr from public.profiles where id = p_user for update;
  if pr.suspended_at is null then return public._user_detail(p_user); end if;
  update public.profiles set suspended_at = null, suspended_category = null, suspended_by = null,
         sharing_suspended_at = case when sharing_suspended_at >= pr.suspended_at
                                          and not exists (select 1 from public.photos p where p.owner_id = p_user and p.safety_hold_at is not null)
                                     then null else sharing_suspended_at end
   where id = p_user;
  perform public._audit(p_staff, 'users.unsuspend', p_user::text, jsonb_build_object('reason', btrim(p_reason)));
  return public._user_detail(p_user);
end;
$$;

-- Lifts a sharing suspension (API checks the passkey). Refused while a photo is on hold or the account is suspended.
create function public.admin_user_sharing_lift(p_staff uuid, p_user uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare err text := public._user_target_ok(p_staff, p_user, 'suspend', p_reason);
begin
  if err is not null then return case when err = 'not_found' then null else jsonb_build_object('error', err) end; end if;
  if exists (select 1 from public.photos p where p.owner_id = p_user and p.safety_hold_at is not null)
     or exists (select 1 from public.profiles p where p.id = p_user and p.suspended_at is not null) then
    return jsonb_build_object('error', 'conflict');
  end if;
  update public.profiles set sharing_suspended_at = null where id = p_user;
  perform public._audit(p_staff, 'users.sharing_lift', p_user::text, jsonb_build_object('reason', btrim(p_reason)));
  return public._user_detail(p_user);
end;
$$;

-- Schedules deletion (Owner; the API checks the passkey and cancels Stripe as for a member's own request). The
-- member can't restore it. Returns AdminUserDetail plus { stripeSubscriptionId } (null without a live one).
create function public.admin_user_deletion_schedule(p_staff uuid, p_user uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare err text := public._user_target_ok(p_staff, p_user, 'deleteAccount', p_reason);
begin
  if err is not null then return case when err = 'not_found' then null else jsonb_build_object('error', err) end; end if;
  update public.profiles
     set deletion_requested_at = coalesce(deletion_requested_at, now()),
         deletion_due = coalesce(deletion_due, now() + make_interval(days => (select s.deleted_account_retention_days from public.app_settings s where s.id = 1))),
         deletion_by_staff = p_staff
   where id = p_user and deleted_at is null;
  perform public._auth_sign_out_all(p_user);
  perform public._audit(p_staff, 'users.deletion_scheduled', p_user::text, jsonb_build_object('reason', btrim(p_reason)));
  -- The live subscription the API cancels at period end, as for a member's own request.
  return public._user_detail(p_user) || jsonb_build_object('stripeSubscriptionId',
    (select s.stripe_subscription_id from public.subscriptions s where s.owner_id = p_user and public._sub_keeps(s.status, s.past_due_since)));
end;
$$;

create function public.admin_user_deletion_cancel(p_staff uuid, p_user uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare err text := public._user_target_ok(p_staff, p_user, 'deleteAccount', p_reason);
begin
  if err is not null then return case when err = 'not_found' then null else jsonb_build_object('error', err) end; end if;
  update public.profiles set deletion_requested_at = null, deletion_due = null, deletion_by_staff = null
   where id = p_user and deletion_due > now();
  if not found then return jsonb_build_object('error', 'conflict'); end if;
  perform public._audit(p_staff, 'users.deletion_cancelled', p_user::text, jsonb_build_object('reason', btrim(p_reason)));
  -- The subscription the API resumes (cancel_at_period_end set by the deletion request).
  return public._user_detail(p_user) || jsonb_build_object('stripeSubscriptionId',
    (select s.stripe_subscription_id from public.subscriptions s where s.owner_id = p_user and public._sub_keeps(s.status, s.past_due_since)));
end;
$$;

-- requireMember: true while the account is suspended.
create function public.member_suspended(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.suspended_at is not null from public.profiles p where p.id = p_user), false);
$$;

-- ---------------------------------------------------------------------------------------------
-- Safety
-- ---------------------------------------------------------------------------------------------
-- Reports are grouped by gallery (a report without a gallery stands alone); the group's id is its earliest
-- report's id.
create function public._report_group(p_report uuid) returns setof public.gallery_reports
language sql stable set search_path = '' as $$
  select r.* from public.gallery_reports r, public.gallery_reports x
   where x.id = p_report
     and (r.id = x.id or (x.gallery_id is not null and r.gallery_id = x.gallery_id
                          and (r.reviewed_at is null) = (x.reviewed_at is null)));
$$;

create function public._report_json(p_key uuid, p_open boolean) returns jsonb
language sql stable set search_path = '' as $$
  with grp as (
    select r.* from public.gallery_reports r
     where (r.reviewed_at is null) = p_open
       and (r.id = p_key or (r.gallery_id is not null and r.gallery_id = (select k.gallery_id from public.gallery_reports k where k.id = p_key)))
  ), head as (select * from grp order by created_at, id limit 1)
  select jsonb_build_object(
    'id', h.id, 'reason', h.reason, 'count', (select count(*) from grp),
    'galleryId', h.gallery_id, 'galleryName', g.name,
    'galleryState', case when g.id is null then null when public._gallery_status(g) = 'revoked' then 'ended' else public._gallery_status(g) end,
    'ownerId', coalesce(h.owner_id, g.owner_id),
    'photoIds', coalesce((select jsonb_agg(distinct x.photo_id) from grp x where x.photo_id is not null), '[]'::jsonb),
    'createdAt', h.created_at, 'resolvedAt', h.reviewed_at,
    'resolution', case when h.reviewed_at is not null then jsonb_build_object(
      'actions', coalesce(h.resolution -> 'actions', '[]'::jsonb), 'note', coalesce(h.resolution_note, ''),
      'by', public._staff_name(h.resolved_by)) end)
    from head h left join public.galleries g on g.id = h.gallery_id;
$$;

create function public._hold_json(p public.photos) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'photoId', p.id, 'ownerId', p.owner_id,
    'source', coalesce(p.safety_hold_source, 'csam_scan'), 'heldAt', p.safety_hold_at,
    'reportedAt', hr.recorded_at, 'reportReference', hr.reference)
    from (select 1) x left join public.safety_hold_reports hr on hr.photo_id = p.id;
$$;

-- AdminSafetyResult without ok.
create function public.admin_safety(p_staff uuid, p_state text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare open_ boolean := coalesce(p_state, 'open') = 'open';
begin
  if not public._staff_can(p_staff, 'safetyView') then return jsonb_build_object('error', 'forbidden'); end if;
  return jsonb_build_object(
    'kpis', jsonb_build_object(
      'open', (select count(distinct coalesce(r.gallery_id, r.id)) from public.gallery_reports r where r.reviewed_at is null),
      'olderThan24h', (select count(distinct coalesce(r.gallery_id, r.id)) from public.gallery_reports r
                        where r.reviewed_at is null and r.created_at < now() - interval '24 hours'),
      'holds', (select count(*) from public.photos p where p.safety_hold_at is not null),
      'sharingSuspended', (select count(*) from public.profiles p where p.sharing_suspended_at is not null and p.deleted_at is null),
      'medianHoursToAction', (select round((percentile_cont(0.5) within group (order by extract(epoch from r.reviewed_at - r.created_at)) / 3600)::numeric, 1)
                               from public.gallery_reports r where r.reviewed_at > now() - interval '30 days')),
    'reports', coalesce((select jsonb_agg(public._report_json(k.id, open_) order by k.created_at)
                           from (select distinct on (coalesce(r.gallery_id, r.id)) r.id, r.created_at
                                   from public.gallery_reports r where (r.reviewed_at is null) = open_
                                  order by coalesce(r.gallery_id, r.id), r.created_at, r.id) k
                          where open_ or k.created_at > now() - interval '90 days'), '[]'::jsonb),
    'holds', coalesce((select jsonb_agg(public._hold_json(p) order by p.safety_hold_at desc)
                         from public.photos p where p.safety_hold_at is not null), '[]'::jsonb));
end;
$$;

-- AdminReportDetail without ok.
create function public.admin_report(p_staff uuid, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.gallery_reports;
  j jsonb;
begin
  if not public._staff_can(p_staff, 'safetyView') then return jsonb_build_object('error', 'forbidden'); end if;
  select * into r from public.gallery_reports where id = p_id;
  if not found then return null; end if;
  j := public._report_json(p_id, r.reviewed_at is null);
  return j || jsonb_build_object(
    'details', coalesce((select jsonb_agg(x.details order by x.created_at) from public._report_group(p_id) x where x.details is not null), '[]'::jsonb),
    'ownerPlan', (select p.plan_id from public.profiles p where p.id = (j ->> 'ownerId')::uuid),
    'heldPhotoIds', coalesce((select jsonb_agg(p.id) from public.photos p
                               where p.id in (select (e)::uuid from jsonb_array_elements_text(j -> 'photoIds') e) and p.safety_hold_at is not null), '[]'::jsonb));
end;
$$;

-- The original's preview (or the original itself for a web format without one): the API re-encodes it.
create function public._reveal_key(p public.photos) returns text
language sql immutable set search_path = '' as $$
  select public._r2_prefix(p.owner_id, p.id) || case when p.has_preview or p.file_type not in ('jpeg', 'png', 'webp') then 'preview' else 'original' end;
$$;

-- Reveal grant: Safety only, 10 minutes, the report group's photos minus any on hold (a gallery report without a
-- photo: the gallery's photos, at most 50). Returns { grantId, expiresAt, photoIds } (the API builds the URLs and
-- keeps the token), or { error: forbidden | invalid | nothing_to_reveal }, null for an unknown report.
create function public.admin_reveal(p_staff uuid, p_report uuid, p_reason text, p_token_hash bytea) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  ids uuid[];
  g public.reveal_grants;
begin
  if not public._staff_can(p_staff, 'safetyAct') then return jsonb_build_object('error', 'forbidden'); end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 300 or octet_length(p_token_hash) is distinct from 32 then
    return jsonb_build_object('error', 'invalid');
  end if;
  if not exists (select 1 from public.gallery_reports r where r.id = p_report) then return null; end if;
  select array_agg(distinct p.id) into ids
    from public._report_group(p_report) x
    join public.photos p on p.id = x.photo_id
   where p.safety_hold_at is null and p.status in ('ready', 'trashed');
  if ids is null and not exists (select 1 from public._report_group(p_report) x where x.photo_id is not null) then
    select array_agg(y.id) into ids from (
      select p.id from public._report_group(p_report) x
        join public.gallery_photos gp on gp.gallery_id = x.gallery_id
        join public.photos p on p.id = gp.photo_id
       where p.safety_hold_at is null and p.status = 'ready'
       group by p.id order by min(gp.position) limit 50) y;
  end if;
  if ids is null or cardinality(ids) = 0 then return jsonb_build_object('error', 'nothing_to_reveal'); end if;
  insert into public.reveal_grants (staff_id, report_id, photo_ids, token_hash, reason, expires_at)
  values (p_staff, p_report, ids[1:50], p_token_hash, btrim(p_reason), now() + interval '10 minutes')
  returning * into g;
  perform public._audit(p_staff, 'safety.reveal', p_report::text,
                        jsonb_build_object('reason', btrim(p_reason), 'photoIds', to_jsonb(g.photo_ids), 'grantId', g.id));
  return jsonb_build_object('grantId', g.id, 'expiresAt', g.expires_at, 'photoIds', to_jsonb(g.photo_ids));
end;
$$;

-- The reveal media route: the grant is live, belongs to this staff member, matches the token and lists the photo,
-- and the photo isn't on hold (now). Returns { key, storeId } or null. (plpgsql: photos.store_id comes with the
-- storage migration.)
create function public.reveal_grant_check(p_grant uuid, p_token_hash bytea, p_staff uuid, p_photo uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.photos;
begin
  if not public._staff_can(p_staff, 'safetyAct') or not exists (
       select 1 from public.reveal_grants g
        where g.id = p_grant and g.staff_id = p_staff and g.token_hash = p_token_hash and g.expires_at > now()
          and p_photo = any (g.photo_ids)) then
    return null;
  end if;
  select * into p from public.photos where id = p_photo and safety_hold_at is null and status in ('ready', 'trashed');
  if not found then return null; end if;
  return jsonb_build_object('key', public._reveal_key(p), 'storeId', coalesce(to_jsonb(p) ->> 'store_id', 'r2'));
end;
$$;

-- Resolves a report group with actions (each through the phase 5 functions). Empty = dismiss. Returns
-- AdminSafetyResult (open), plus { suspendedEmail } when the account was suspended.
create function public.admin_report_resolve(p_staff uuid, p_report uuid, p_actions text[], p_note text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.gallery_reports;
  owner uuid;
  v_photos uuid[];
  a text;
begin
  if not public._staff_can(p_staff, 'safetyAct') then return jsonb_build_object('error', 'forbidden'); end if;
  if p_note is null or length(btrim(p_note)) not between 3 and 300
     or exists (select 1 from unnest(coalesce(p_actions, '{}')) x where x not in ('remove_photos', 'end_gallery', 'suspend_sharing', 'suspend_account', 'hold_photos'))
  then return jsonb_build_object('error', 'invalid'); end if;
  select * into r from public.gallery_reports where id = p_report for update;
  if not found then return null; end if;
  if r.reviewed_at is not null then return jsonb_build_object('error', 'conflict'); end if;
  owner := coalesce(r.owner_id, (select g.owner_id from public.galleries g where g.id = r.gallery_id));
  select array_agg(distinct x.photo_id) into v_photos from public._report_group(p_report) x where x.photo_id is not null;
  foreach a in array coalesce(p_actions, '{}') loop
    if a = 'remove_photos' and v_photos is not null then
      delete from public.gallery_photos gp using public._report_group(p_report) x
       where gp.gallery_id = x.gallery_id and gp.photo_id = any (v_photos);
    elsif a = 'end_gallery' and r.gallery_id is not null and owner is not null then
      perform public.revoke_gallery(owner, r.gallery_id);
    elsif a = 'suspend_sharing' and owner is not null then
      update public.profiles set sharing_suspended_at = coalesce(sharing_suspended_at, now()) where id = owner;
    elsif a = 'hold_photos' and v_photos is not null then
      update public.photos set safety_hold_at = coalesce(safety_hold_at, now()), safety_hold_source = coalesce(safety_hold_source, 'staff')
       where id = any (v_photos);
      delete from public.gallery_photos where photo_id = any (v_photos);
    elsif a = 'suspend_account' and owner is not null then
      update public.profiles set suspended_at = coalesce(suspended_at, now()), suspended_category = coalesce(suspended_category, 'safety'),
                                 suspended_by = coalesce(suspended_by, p_staff), sharing_suspended_at = coalesce(sharing_suspended_at, now())
       where id = owner;
      perform public._auth_sign_out_all(owner);
      perform public._audit(p_staff, 'users.suspend', owner::text, jsonb_build_object('category', 'safety', 'reason', btrim(p_note), 'report', p_report));
    end if;
  end loop;
  update public.gallery_reports x set reviewed_at = now(), resolved_by = p_staff,
         resolution = jsonb_build_object('actions', to_jsonb(coalesce(p_actions, '{}'::text[]))), resolution_note = btrim(p_note)
    from public._report_group(p_report) g where x.id = g.id and x.reviewed_at is null;
  perform public._audit(p_staff, 'safety.resolve', p_report::text,
                        jsonb_build_object('actions', to_jsonb(coalesce(p_actions, '{}'::text[])), 'reason', btrim(p_note), 'ownerId', owner));
  return public.admin_safety(p_staff, 'open');
end;
$$;

-- Records the report made to the authorities for a held photo. AdminSafetyResult.
create function public.admin_hold_report(p_staff uuid, p_photo uuid, p_authority text, p_reference text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public._staff_can(p_staff, 'holdsRecord') then return jsonb_build_object('error', 'forbidden'); end if;
  if not exists (select 1 from public.photos p where p.id = p_photo and p.safety_hold_at is not null) then return null; end if;
  if length(btrim(coalesce(p_authority, ''))) not between 2 and 120 or length(btrim(coalesce(p_reference, ''))) not between 2 and 120 then
    return jsonb_build_object('error', 'invalid');
  end if;
  insert into public.safety_hold_reports (photo_id, authority, reference, recorded_by)
  values (p_photo, btrim(p_authority), btrim(p_reference), p_staff)
  on conflict (photo_id) do update set authority = excluded.authority, reference = excluded.reference,
                                      recorded_by = excluded.recorded_by, recorded_at = now();
  perform public._audit(p_staff, 'safety.hold_reported', p_photo::text,
                        jsonb_build_object('authority', btrim(p_authority), 'reference', btrim(p_reference)));
  return public.admin_safety(p_staff, 'open');
end;
$$;

-- Releases a hold (Owner; the API checks the passkey). The account's sharing stays suspended until lifted
-- separately. AdminSafetyResult.
create function public.admin_hold_release(p_staff uuid, p_photo uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public._staff_can(p_staff, 'holdsRelease') then return jsonb_build_object('error', 'forbidden'); end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 300 then return jsonb_build_object('error', 'invalid'); end if;
  perform set_config('zephyr.safety_release', 'on', true);
  update public.photos set safety_hold_at = null, safety_hold_source = null where id = p_photo and safety_hold_at is not null;
  perform set_config('zephyr.safety_release', '', true);
  if not found then return null; end if;
  perform public._audit(p_staff, 'safety.hold_released', p_photo::text, jsonb_build_object('reason', btrim(p_reason)));
  return public.admin_safety(p_staff, 'open');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Plan limits
-- ---------------------------------------------------------------------------------------------
create function public._limits_plan_json(pl public.plan_limits) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'storageGb', pl.storage_gb, 'cloudCreditsPerMonth', pl.cloud_credits_month, 'batchSize', pl.batch_size,
    'fileTypes', to_jsonb(pl.file_types), 'galleries', pl.galleries, 'maxLinkDays', pl.max_link_days,
    'guestFullRes', pl.guest_full_res, 'peopleGrouping', pl.people_grouping, 'qualityCleanup', pl.quality_cleanup,
    'branding', pl.branding, 'guestFavourites', pl.guest_favourites, 'watermark', pl.watermark, 'accessLog', pl.access_log,
    'seats', pl.seats, 'ads', pl.ads, 'priorityQueue', pl.priority_queue);
$$;

create function public._limits_version_json(v public.plan_limit_versions, p_with_limits boolean) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('version', v.version, 'status', v.status,
           'effectiveAt', coalesce(v.effective_at, case when v.status in ('active', 'superseded') then v.activated_at end),
           'reason', v.reason, 'createdBy', case when v.created_by is not null then public._staff_name(v.created_by) end,
           'createdAt', v.created_at)
      || case when p_with_limits then jsonb_build_object('limits',
           (select jsonb_object_agg(pl.plan_id, public._limits_plan_json(pl)) from public.plan_limits pl where pl.version_id = v.id))
         else '{}'::jsonb end;
$$;

-- AdminLimitsResult without ok.
create function public.admin_limits(p_staff uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public._staff_can(p_staff, 'limitsView') then return jsonb_build_object('error', 'forbidden'); end if;
  return jsonb_build_object(
    'active', (select public._limits_version_json(v, true) from public.plan_limit_versions v where v.status = 'active'),
    'scheduled', (select public._limits_version_json(v, true) from public.plan_limit_versions v where v.status = 'scheduled'),
    'draft', (select public._limits_version_json(v, true) from public.plan_limit_versions v where v.status = 'draft'),
    'history', coalesce((select jsonb_agg(public._limits_version_json(v, false) order by v.version desc)
                           from public.plan_limit_versions v where v.status <> 'draft'), '[]'::jsonb));
end;
$$;

create function public._limits_lock() returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('zephyr:limits', 0));
$$;

-- Starts the (single) draft as a copy of an existing version. AdminLimitsResult, or { error: forbidden | conflict | not_found }.
create function public.admin_limits_draft_create(p_staff uuid, p_from integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  src public.plan_limit_versions;
  vid bigint;
begin
  if not public._staff_can(p_staff, 'limits') then return jsonb_build_object('error', 'forbidden'); end if;
  perform public._limits_lock();
  if exists (select 1 from public.plan_limit_versions where status = 'draft') then return jsonb_build_object('error', 'conflict'); end if;
  select * into src from public.plan_limit_versions where version = p_from;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  insert into public.plan_limit_versions (version, status, reason, created_by)
  values ((select max(version) + 1 from public.plan_limit_versions), 'draft', 'Draft', p_staff)
  returning id into vid;
  insert into public.plan_limits (version_id, plan_id, storage_gb, cloud_credits_month, credits_rollover, batch_size, file_types,
    max_file_mb, galleries, max_link_days, guest_full_res, branding, people_grouping, seats, ads, priority_queue,
    guest_favourites, watermark, access_log, quality_cleanup)
  select vid, plan_id, storage_gb, cloud_credits_month, credits_rollover, batch_size, file_types,
    max_file_mb, galleries, max_link_days, guest_full_res, branding, people_grouping, seats, ads, priority_queue,
    guest_favourites, watermark, access_log, quality_cleanup
    from public.plan_limits where version_id = src.id;
  perform public._audit(p_staff, 'limits.draft', 'limits_v' || (select version from public.plan_limit_versions where id = vid),
                        jsonb_build_object('from', p_from));
  return public.admin_limits(p_staff);
end;
$$;

-- Saves the draft's limits (Record<PlanId, PlanLimits>, validated by the API; table checks still apply).
create function public.admin_limits_draft_save(p_staff uuid, p_limits jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  vid bigint;
  plan text;
  l jsonb;
begin
  if not public._staff_can(p_staff, 'limits') then return jsonb_build_object('error', 'forbidden'); end if;
  perform public._limits_lock();
  select id into vid from public.plan_limit_versions where status = 'draft';
  if vid is null then return jsonb_build_object('error', 'not_found'); end if;
  if p_limits is null or jsonb_typeof(p_limits) <> 'object' or (select count(*) from jsonb_object_keys(p_limits)) <> 3 then
    return jsonb_build_object('error', 'invalid');
  end if;
  begin
    foreach plan in array array['free', 'pro', 'studio'] loop
      l := p_limits -> plan;
      if l is null then return jsonb_build_object('error', 'invalid'); end if;
      update public.plan_limits set
        storage_gb = (l ->> 'storageGb')::integer,
        cloud_credits_month = (l ->> 'cloudCreditsPerMonth')::integer,
        batch_size = (l ->> 'batchSize')::integer,
        file_types = array(select jsonb_array_elements_text(l -> 'fileTypes')),
        galleries = (l ->> 'galleries')::integer,
        max_link_days = (l ->> 'maxLinkDays')::integer,
        guest_full_res = (l ->> 'guestFullRes')::boolean,
        people_grouping = (l ->> 'peopleGrouping')::boolean,
        quality_cleanup = (l ->> 'qualityCleanup')::boolean,
        branding = (l ->> 'branding')::boolean,
        guest_favourites = (l ->> 'guestFavourites')::boolean,
        watermark = (l ->> 'watermark')::boolean,
        access_log = (l ->> 'accessLog')::boolean,
        seats = (l ->> 'seats')::integer,
        ads = (l ->> 'ads')::boolean,
        priority_queue = (l ->> 'priorityQueue')::boolean
       where version_id = vid and plan_id = plan;
    end loop;
  exception when others then
    return jsonb_build_object('error', 'invalid');
  end;
  perform public._audit(p_staff, 'limits.draft_saved', 'limits_v' || (select version from public.plan_limit_versions where id = vid), '{}'::jsonb);
  return public.admin_limits(p_staff);
end;
$$;

create function public.admin_limits_draft_delete(p_staff uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v integer;
begin
  if not public._staff_can(p_staff, 'limits') then return jsonb_build_object('error', 'forbidden'); end if;
  perform public._limits_lock();
  delete from public.plan_limit_versions where status = 'draft' returning version into v;
  if v is not null then perform public._audit(p_staff, 'limits.draft_deleted', 'limits_v' || v, '{}'::jsonb); end if;
  return public.admin_limits(p_staff);
end;
$$;

-- Field-by-field comparison of two versions: [{ plan, field, from, to, direction }] for every field that differs.
-- "down" means less for the member: a lower number (null = unlimited), a feature switched off, a file type
-- removed, ads switched on.
create function public._limits_changes(p_from bigint, p_to bigint) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('plan', c.plan, 'field', c.field, 'from', c.a, 'to', c.b, 'direction', c.dir)
                            order by c.plan_sort, c.field), '[]'::jsonb)
    from (
      select a.key as field, f.plan_id as plan, p.sort as plan_sort, a.value as a, b.value as b,
        case
          when a.key = 'ads' then case when (b.value)::text = 'true' then 'down' else 'up' end
          when a.key = 'fileTypes' then
            case when exists (select 1 from jsonb_array_elements_text(a.value) x where not (b.value ? x)) then 'down' else 'up' end
          when jsonb_typeof(a.value) = 'boolean' or jsonb_typeof(b.value) = 'boolean' then
            case when (b.value)::text = 'true' then 'up' else 'down' end
          when jsonb_typeof(a.value) = 'null' then 'down'          -- unlimited → a number
          when jsonb_typeof(b.value) = 'null' then 'up'            -- a number → unlimited
          when (b.value)::text::numeric < (a.value)::text::numeric then 'down'
          else 'up' end as dir
        from public.plan_limits f
        join public.plan_limits t on t.version_id = p_to and t.plan_id = f.plan_id
        join public.plans p on p.id = f.plan_id
        cross join lateral jsonb_each(public._limits_plan_json(f)) a
        cross join lateral (select public._limits_plan_json(t) -> a.key as value) b
       where f.version_id = p_from and a.value is distinct from b.value
    ) c;
$$;

create function public._limits_preview(p_draft bigint) returns jsonb
language sql stable set search_path = '' as $$
  with ch as (select public._limits_changes((select id from public.plan_limit_versions where status = 'active'), p_draft) as c),
  downs as (select distinct e ->> 'plan' as plan from ch, jsonb_array_elements(ch.c) e where e ->> 'direction' = 'down'),
  newl as (select * from public.plan_limits where version_id = p_draft)
  select jsonb_build_object(
    'changes', ch.c,
    'decreases', exists (select 1 from downs),
    'earliestEffectiveAt', case when exists (select 1 from downs) then now() + interval '30 days' else now() end,
    'membersEmailed', (select count(*) from public.profiles pr
                        where pr.deleted_at is null and pr.plan_id in (select plan from downs)
                          and not exists (select 1 from public.staff s where s.user_id = pr.id)),
    'membersOver', (select count(*) from public.profiles pr join newl on newl.plan_id = pr.plan_id
                     where pr.deleted_at is null
                       and (pr.storage_bytes > newl.storage_gb::bigint * 1073741824
                            or 1 + (select count(*) from public.library_members m where m.owner_id = pr.id) > newl.seats)))
    from ch;
$$;

-- AdminLimitsPreviewResult without ok (p_effective_at is accepted for symmetry; the rules don't depend on it).
create function public.admin_limits_preview(p_staff uuid, p_effective_at timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare vid bigint;
begin
  if not public._staff_can(p_staff, 'limits') then return jsonb_build_object('error', 'forbidden'); end if;
  select id into vid from public.plan_limit_versions where status = 'draft';
  if vid is null then return jsonb_build_object('error', 'not_found'); end if;
  return public._limits_preview(vid);
end;
$$;

create function public._limits_activate(p_vid bigint) returns void
language plpgsql volatile set search_path = '' as $$
begin
  update public.plan_limit_versions set status = 'superseded' where status = 'active' and id <> p_vid;
  update public.plan_limit_versions set status = 'active', activated_at = now(), effective_at = coalesce(effective_at, now())
   where id = p_vid;
end;
$$;

-- Schedules the draft (the API checks the passkey and emails the Owners). null = now, only without decreases;
-- a version with decreases needs a date ≥ 30 days ahead and queues a notice per affected member
-- (limits_notices_due). AdminLimitsResult plus { version, effectiveAt, decreases }, or
-- { error: forbidden | not_found | conflict | invalid | too_soon | no_changes }.
create function public.admin_limits_schedule(p_staff uuid, p_effective_at timestamptz, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  vid bigint;
  pv jsonb;
  ver integer;
begin
  if not public._staff_can(p_staff, 'limits') then return jsonb_build_object('error', 'forbidden'); end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 300 then return jsonb_build_object('error', 'invalid'); end if;
  perform public._limits_lock();
  select id, version into vid, ver from public.plan_limit_versions where status = 'draft';
  if vid is null then return jsonb_build_object('error', 'not_found'); end if;
  if exists (select 1 from public.plan_limit_versions where status = 'scheduled') then return jsonb_build_object('error', 'conflict'); end if;
  pv := public._limits_preview(vid);
  if jsonb_array_length(pv -> 'changes') = 0 then return jsonb_build_object('error', 'no_changes'); end if;
  if (pv ->> 'decreases')::boolean and (p_effective_at is null or p_effective_at < now() + interval '30 days' - interval '5 minutes') then
    return jsonb_build_object('error', 'too_soon');
  end if;
  if p_effective_at is not null and (p_effective_at < now() - interval '5 minutes' or p_effective_at > now() + interval '1 year') then
    return jsonb_build_object('error', 'invalid');
  end if;
  update public.plan_limit_versions set reason = btrim(p_reason), effective_at = coalesce(p_effective_at, now()),
                                        status = case when p_effective_at is null then 'draft' else 'scheduled' end
   where id = vid;
  if p_effective_at is null then
    perform public._limits_activate(vid);
  elsif (pv ->> 'decreases')::boolean then
    insert into public.limits_notices (version_id, owner_id)
    select vid, pr.id from public.profiles pr
     where pr.deleted_at is null
       and pr.plan_id in (select e ->> 'plan' from jsonb_array_elements(pv -> 'changes') e where e ->> 'direction' = 'down')
       and not exists (select 1 from public.staff s where s.user_id = pr.id)
    on conflict do nothing;
  end if;
  perform public._audit(p_staff, 'limits.schedule', 'limits_v' || ver,
    jsonb_build_object('reason', btrim(p_reason), 'effectiveAt', coalesce(p_effective_at, now()), 'changes', pv -> 'changes'));
  return public.admin_limits(p_staff) || jsonb_build_object('version', ver, 'effectiveAt', coalesce(p_effective_at, now()),
                                                            'decreases', (pv ->> 'decreases')::boolean);
end;
$$;

-- Cancels the scheduled version (saves at once). Unsent notices are dropped. AdminLimitsResult.
create function public.admin_limits_cancel(p_staff uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare vid bigint; ver integer;
begin
  if not public._staff_can(p_staff, 'limits') then return jsonb_build_object('error', 'forbidden'); end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 300 then return jsonb_build_object('error', 'invalid'); end if;
  perform public._limits_lock();
  update public.plan_limit_versions set status = 'cancelled' where status = 'scheduled' returning id, version into vid, ver;
  if vid is null then return jsonb_build_object('error', 'not_found'); end if;
  delete from public.limits_notices where version_id = vid and sent_at is null;
  perform public._audit(p_staff, 'limits.cancel', 'limits_v' || ver, jsonb_build_object('reason', btrim(p_reason)));
  return public.admin_limits(p_staff);
end;
$$;

-- Cron: activates a scheduled version whose date has come. Returns how many were activated (0 or 1).
create function public.limits_activate_due() returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare vid bigint; ver integer;
begin
  perform public._limits_lock();
  select id, version into vid, ver from public.plan_limit_versions where status = 'scheduled' and effective_at <= now();
  if vid is null then return 0; end if;
  perform public._limits_activate(vid);
  perform public._audit(null, 'limits.activated', 'limits_v' || ver, '{}'::jsonb);
  return 1;
end;
$$;

create function public._limit_label(p_field text) returns text
language sql immutable set search_path = '' as $$
  select case p_field
    when 'storageGb' then 'Storage (GB)' when 'cloudCreditsPerMonth' then 'Cloud credits per month'
    when 'batchSize' then 'Photos per batch' when 'fileTypes' then 'File types' when 'galleries' then 'Shared galleries'
    when 'maxLinkDays' then 'Longest gallery link (days)' when 'guestFullRes' then 'Full-resolution guest downloads'
    when 'peopleGrouping' then 'People grouping' when 'qualityCleanup' then 'Cleanup' when 'branding' then 'Gallery branding'
    when 'guestFavourites' then 'Guest favourites' when 'watermark' then 'Watermarks' when 'accessLog' then 'Gallery access log'
    when 'seats' then 'Team seats' when 'ads' then 'Ads' when 'priorityQueue' then 'Priority processing'
    else p_field end;
$$;

-- Claims up to p_limit notices for the scheduled version (marked sent before returning, so two runs never email
-- twice) and returns [{ userId, email, version, effectiveAt, changes: [{ label, from, to }] }]: the member's own
-- plan's changes. A failed send is not retried (the API logs it); members of a cancelled version are never mailed.
create function public.limits_notices_due(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.plan_limit_versions;
  ch jsonb;
  res jsonb;
begin
  select * into v from public.plan_limit_versions where status = 'scheduled';
  if not found then return '[]'::jsonb; end if;
  ch := public._limits_changes((select a.id from public.plan_limit_versions a where a.status = 'active'), v.id);
  with c as (
    select n.owner_id from public.limits_notices n
     where n.version_id = v.id and n.sent_at is null
     order by n.owner_id limit least(greatest(coalesce(p_limit, 100), 1), 1000)
     for update skip locked
  ), u as (
    update public.limits_notices n set sent_at = now() from c
     where n.version_id = v.id and n.owner_id = c.owner_id
    returning n.owner_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('userId', u.owner_id, 'email', au.email::text, 'version', v.version,
           'effectiveAt', v.effective_at,
           'changes', (select coalesce(jsonb_agg(jsonb_build_object('label', public._limit_label(e ->> 'field'), 'from', e -> 'from', 'to', e -> 'to')), '[]'::jsonb)
                         from jsonb_array_elements(ch) e where e ->> 'plan' = pr.plan_id))), '[]'::jsonb)
    into res
    from u join auth.users au on au.id = u.owner_id join public.profiles pr on pr.id = u.owner_id
   where au.email is not null and pr.deleted_at is null;
  return res;
end;
$$;


-- ---------------------------------------------------------------------------------------------
-- Ads
-- ---------------------------------------------------------------------------------------------
create function public._ad_status(c public.ad_cards) returns text
language sql stable set search_path = '' as $$
  select case when c.status = 'draft' then 'draft'
              when c.status = 'ended' or c.ends_at <= now() then 'ended'
              when c.starts_at is null or c.starts_at <= now() then 'live'
              else 'scheduled' end;
$$;

create function public._ad_json(c public.ad_cards) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'advertiser', c.advertiser, 'headline', c.headline, 'body', c.body, 'url', c.url,
    'placements', to_jsonb(c.placements), 'startsAt', c.starts_at, 'endsAt', c.ends_at, 'weight', c.weight,
    'imageVersion', c.image_version, 'status', public._ad_status(c),
    'stats7d', jsonb_build_object(
      'impressions', coalesce((select sum(s.impressions) from public.ad_stats_daily s where s.card_id = c.id and s.day > current_date - 7), 0),
      'clicks', coalesce((select sum(s.clicks) from public.ad_stats_daily s where s.card_id = c.id and s.day > current_date - 7), 0)));
$$;

create function public._adsense_json() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('enabled', coalesce((s.adsense ->> 'enabled')::boolean, false),
    'publisherId', s.adsense -> 'publisherId', 'slots', coalesce(s.adsense -> 'slots', '{}'::jsonb),
    'enabledAt', s.adsense -> 'enabledAt',
    'enabledBy', case when s.adsense ->> 'enabledBy' is not null then to_jsonb(public._staff_name((s.adsense ->> 'enabledBy')::uuid)) end)
    from public.app_settings s where s.id = 1;
$$;

-- AdminAdsResult without ok.
create function public.admin_ads(p_staff uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public._staff_can(p_staff, 'ads') then return jsonb_build_object('error', 'forbidden'); end if;
  return jsonb_build_object(
    'kpis', jsonb_build_object(
      'freeMembers', (select count(*) from public.profiles pr
                       join public.plan_limits pl on pl.plan_id = pr.plan_id
                       join public.plan_limit_versions v on v.id = pl.version_id and v.status = 'active'
                      where pr.deleted_at is null and pl.ads and not exists (select 1 from public.staff s where s.user_id = pr.id)),
      'impressions7d', coalesce((select sum(impressions) from public.ad_stats_daily where day > current_date - 7), 0),
      'clicks7d', coalesce((select sum(clicks) from public.ad_stats_daily where day > current_date - 7), 0)),
    'cards', coalesce((select jsonb_agg(public._ad_json(c) order by c.created_at desc) from public.ad_cards c), '[]'::jsonb),
    'adsense', public._adsense_json());
end;
$$;

-- Creates (p_id null) or updates a card. p_card: AdminAdCardBody keys (partial on update) plus optional status
-- ('draft' | 'scheduled' | 'ended'). AdminAdsResult plus { cardId }, or { error }.
create function public.admin_ad_card_save(p_staff uuid, p_id uuid, p_card jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.ad_cards;
begin
  if not public._staff_can(p_staff, 'ads') then return jsonb_build_object('error', 'forbidden'); end if;
  if p_card is null or jsonb_typeof(p_card) <> 'object' then return jsonb_build_object('error', 'invalid'); end if;
  begin
    if p_id is null then
      insert into public.ad_cards (advertiser, headline, body, url, placements, starts_at, ends_at, weight, status, created_by)
      values (p_card ->> 'advertiser', p_card ->> 'headline', p_card ->> 'body', p_card ->> 'url',
              array(select jsonb_array_elements_text(p_card -> 'placements')),
              (p_card ->> 'startsAt')::timestamptz, (p_card ->> 'endsAt')::timestamptz,
              coalesce((p_card ->> 'weight')::integer, 50), coalesce(p_card ->> 'status', 'draft'), p_staff)
      returning * into c;
    else
      update public.ad_cards set
        advertiser = coalesce(p_card ->> 'advertiser', advertiser),
        headline = coalesce(p_card ->> 'headline', headline),
        body = coalesce(p_card ->> 'body', body),
        url = coalesce(p_card ->> 'url', url),
        placements = case when p_card ? 'placements' then array(select jsonb_array_elements_text(p_card -> 'placements')) else placements end,
        starts_at = case when p_card ? 'startsAt' then (p_card ->> 'startsAt')::timestamptz else starts_at end,
        ends_at = case when p_card ? 'endsAt' then (p_card ->> 'endsAt')::timestamptz else ends_at end,
        weight = coalesce((p_card ->> 'weight')::integer, weight),
        status = coalesce(p_card ->> 'status', status),
        updated_at = now()
       where id = p_id returning * into c;
      if not found then return null; end if;
    end if;
  exception when check_violation or invalid_text_representation or invalid_datetime_format or not_null_violation or datetime_field_overflow then
    return jsonb_build_object('error', 'invalid');
  end;
  perform public._audit(p_staff, case when p_id is null then 'ads.card_created' else 'ads.card_updated' end, c.id::text,
                        jsonb_build_object('advertiser', c.advertiser, 'status', c.status));
  return public.admin_ads(p_staff) || jsonb_build_object('cardId', c.id);
end;
$$;

create function public.admin_ad_card_delete(p_staff uuid, p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare k text;
begin
  if not public._staff_can(p_staff, 'ads') then return jsonb_build_object('error', 'forbidden'); end if;
  delete from public.ad_cards where id = p_id returning image_key into k;
  if not found then return null; end if;
  perform public._audit(p_staff, 'ads.card_deleted', p_id::text, '{}'::jsonb);
  return public.admin_ads(p_staff) || jsonb_build_object('imageKey', k);
end;
$$;

-- Records a new image the API stored at p_key (ads/<card id>/…): the version goes up by one, which changes the
-- public image URL. Returns AdminAdsResult plus { version, oldKey } (the replaced object to delete).
create function public.admin_ad_image_set(p_staff uuid, p_id uuid, p_key text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  old text;
  v integer;
begin
  if not public._staff_can(p_staff, 'ads') then return jsonb_build_object('error', 'forbidden'); end if;
  if p_key is null or p_key !~ ('^ads/' || p_id::text || '/[A-Za-z0-9._-]{1,100}$') then return jsonb_build_object('error', 'invalid'); end if;
  select image_key into old from public.ad_cards where id = p_id for update;
  if not found then return null; end if;
  update public.ad_cards set image_version = coalesce(image_version, 0) + 1, image_key = p_key, updated_at = now()
   where id = p_id returning image_version into v;
  perform public._audit(p_staff, 'ads.card_image', p_id::text, jsonb_build_object('version', v));
  return public.admin_ads(p_staff) || jsonb_build_object('version', v, 'oldKey', old);
end;
$$;

-- The image key of a live card (public image route). null otherwise.
create function public.ad_image_key(p_card uuid, p_version integer) returns text
language sql stable security definer set search_path = '' as $$
  select c.image_key from public.ad_cards c where c.id = p_card and c.image_version = p_version and public._ad_status(c) in ('live', 'scheduled');
$$;

-- AdSense settings. Turning on: Owner (the API checks the passkey) and a publisher id set. Edits: Owner or Admin.
-- p_patch: { enabled?, publisherId?, slots? }. AdminAdsResult plus { enabled }, or { error }.
create function public.admin_adsense_set(p_staff uuid, p_patch jsonb, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  cur jsonb;
  nxt jsonb;
  k text;
begin
  if not public._staff_can(p_staff, 'ads') then return jsonb_build_object('error', 'forbidden'); end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 300 or p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    return jsonb_build_object('error', 'invalid');
  end if;
  select adsense into cur from public.app_settings where id = 1 for update;
  nxt := cur;
  if p_patch ? 'publisherId' then
    if jsonb_typeof(p_patch -> 'publisherId') <> 'null' and (p_patch ->> 'publisherId') !~ '^ca-pub-[0-9]{16}$' then
      return jsonb_build_object('error', 'invalid');
    end if;
    nxt := jsonb_set(nxt, '{publisherId}', p_patch -> 'publisherId');
  end if;
  if p_patch ? 'slots' then
    for k in select jsonb_object_keys(p_patch -> 'slots') loop
      if k not in ('library', 'sidebar', 'batch') then return jsonb_build_object('error', 'invalid'); end if;
      if jsonb_typeof(p_patch -> 'slots' -> k) = 'null' then
        nxt := jsonb_set(nxt, '{slots}', coalesce(nxt -> 'slots', '{}'::jsonb) - k);
      elsif (p_patch -> 'slots' ->> k) ~ '^[0-9]{10}$' then
        nxt := jsonb_set(nxt, '{slots}', coalesce(nxt -> 'slots', '{}'::jsonb) || jsonb_build_object(k, p_patch -> 'slots' ->> k));
      else
        return jsonb_build_object('error', 'invalid');
      end if;
    end loop;
  end if;
  if p_patch ? 'enabled' then
    if (p_patch ->> 'enabled')::boolean then
      if not public._staff_can(p_staff, 'adsense') then return jsonb_build_object('error', 'forbidden'); end if;
      if nxt ->> 'publisherId' is null then return jsonb_build_object('error', 'invalid'); end if;
      if not coalesce((cur ->> 'enabled')::boolean, false) then
        nxt := nxt || jsonb_build_object('enabled', true, 'enabledAt', now(), 'enabledBy', p_staff);
      end if;
    else
      nxt := nxt || jsonb_build_object('enabled', false);
    end if;
  end if;
  update public.app_settings set adsense = nxt, updated_at = now(), updated_by = p_staff where id = 1;
  perform public._audit(p_staff, 'ads.adsense', 'adsense',
    jsonb_build_object('reason', btrim(p_reason), 'enabled', nxt -> 'enabled', 'was', cur -> 'enabled'));
  return public.admin_ads(p_staff) || jsonb_build_object('enabled', coalesce((nxt ->> 'enabled')::boolean, false));
end;
$$;

-- AdsResult without ok: live cards and AdSense, only when the member's effective plan has ads and the account
-- isn't suspended. Cards carry imageVersion (the API builds imageUrl).
create function public.ads_for_member(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with ok as (
    select exists (select 1 from public.profiles pr
                    join public.plan_limits pl on pl.plan_id = pr.plan_id
                    join public.plan_limit_versions v on v.id = pl.version_id and v.status = 'active'
                   where pr.id = p_user and pr.deleted_at is null and pr.suspended_at is null and pl.ads) as yes
  )
  select case when not ok.yes then jsonb_build_object('cards', '[]'::jsonb, 'adsense', null)
    else jsonb_build_object(
      'cards', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'advertiser', c.advertiser, 'headline', c.headline,
                                  'body', c.body, 'url', c.url, 'imageVersion', c.image_version,
                                  'placements', to_jsonb(c.placements), 'weight', c.weight) order by c.created_at)
                           from public.ad_cards c where public._ad_status(c) = 'live'), '[]'::jsonb),
      'adsense', (select case when coalesce((s.adsense ->> 'enabled')::boolean, false) and s.adsense ->> 'publisherId' is not null
                              then jsonb_build_object('publisherId', s.adsense ->> 'publisherId', 'slots', coalesce(s.adsense -> 'slots', '{}'::jsonb)) end
                    from public.app_settings s where s.id = 1)) end
    from ok;
$$;

-- AdSense config for the app Worker (CSP variant and ads.txt): { enabled, publisherId }.
create function public.adsense_public() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('enabled', coalesce((s.adsense ->> 'enabled')::boolean, false) and s.adsense ->> 'publisherId' is not null,
                            'publisherId', s.adsense ->> 'publisherId')
    from public.app_settings s where s.id = 1;
$$;

-- Counts an impression or click on a live card. Counts only, never who.
create function public.ad_event(p_card uuid, p_kind text, p_placement text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_kind not in ('impression', 'click') or p_placement not in ('library', 'sidebar', 'batch') then return false; end if;
  if not exists (select 1 from public.ad_cards c where c.id = p_card and public._ad_status(c) = 'live' and p_placement = any (c.placements)) then
    return false;
  end if;
  insert into public.ad_stats_daily (card_id, day, placement, impressions, clicks)
  values (p_card, (now() at time zone 'utc')::date, p_placement, (p_kind = 'impression')::integer, (p_kind = 'click')::integer)
  on conflict (card_id, day, placement) do update
    set impressions = public.ad_stats_daily.impressions + excluded.impressions,
        clicks = public.ad_stats_daily.clicks + excluded.clicks;
  return true;
end;
$$;

-- Cron: cards past their end date become 'ended'. Returns how many.
create function public.ad_status_tick() returns integer
language sql volatile security definer set search_path = '' as $$
  with u as (update public.ad_cards set status = 'ended', updated_at = now() where status = 'scheduled' and ends_at <= now() returning 1)
  select count(*)::integer from u;
$$;

-- ---------------------------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------------------------
-- Bytes a photo frees once purged (original, variants, edit renders).
create function public._photo_total_bytes(p public.photos) returns bigint
language sql stable set search_path = '' as $$
  select p.size_bytes + p.thumb_bytes + p.preview_bytes
         + coalesce((select e.thumb_bytes + e.preview_bytes from public.photo_edits e where e.photo_id = p.id), 0);
$$;

-- Bytes over the Free storage once what's already in Trash is purged.
create function public._retention_over(p_owner uuid) returns bigint
language sql stable set search_path = '' as $$
  select greatest(pr.storage_bytes
                  - coalesce((select sum(public._photo_total_bytes(p)) from public.photos p
                               where p.owner_id = p_owner and p.status in ('trashed', 'purging')), 0)
                  - coalesce((select r.storage_bytes from public._plan_rules('free') r), 0), 0)::bigint
    from public.profiles pr where pr.id = p_owner;
$$;

-- The oldest eligible photos (not held, not in a live or paused gallery) whose bytes cover the excess.
create function public._retention_pick(p_owner uuid) returns table (photo_id uuid)
language sql stable set search_path = '' as $$
  with over as (select public._retention_over(p_owner) as b),
  cand as (
    select p.id, sum(public._photo_total_bytes(p)) over (order by p.sort_at, p.created_at, p.id) as run,
           public._photo_total_bytes(p) as own
      from public.photos p
     where p.owner_id = p_owner and p.status = 'ready' and p.safety_hold_at is null
       and not exists (select 1 from public.gallery_photos gp join public.galleries g on g.id = gp.gallery_id
                        where gp.photo_id = p.id and public._gallery_status(g) in ('live', 'paused'))
  )
  select cand.id from cand, over where over.b > 0 and cand.run - cand.own < over.b;
$$;

-- Daily: refreshes retention_items. A lapsed library on Free that's over the Free storage enters at lapsed_at
-- (due a year later); renewing or getting under the limit resolves it. Returns { tracked, ready, resolved }.
create function public.retention_sweep() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  days integer := (select s.lapsed_plan_retention_days from public.app_settings s where s.id = 1);
  n_res integer;
begin
  insert into public.retention_items as ri (owner_id, lapsed_at, due_at)
  select pr.id, pr.lapsed_at, pr.lapsed_at + make_interval(days => days)
    from public.profiles pr
   where pr.lapsed_at is not null and pr.plan_id = 'free' and pr.deleted_at is null and pr.deletion_due is null
     and public._retention_over(pr.id) > 0
  on conflict (owner_id) do update set
    lapsed_at = excluded.lapsed_at, due_at = excluded.due_at, state = 'waiting', approved_by = null, approved_at = null,
    trashed_at = null, trashed_photos = 0, notice_30_at = null, notice_7_at = null, resolved_at = null, updated_at = now()
   where ri.state = 'resolved' or ri.lapsed_at <> excluded.lapsed_at;
  -- Resolved: renewed, overridden, deleted, or under the limit (not counting a batch already trashed).
  with r as (
    update public.retention_items ri set state = 'resolved', resolved_at = now(), updated_at = now()
      from public.profiles pr
     where pr.id = ri.owner_id
       and ((ri.state in ('waiting', 'ready', 'approved')
             and (pr.plan_id <> 'free' or pr.lapsed_at is null or pr.deleted_at is not null or pr.deletion_due is not null
                  or public._retention_over(pr.id) = 0))
            -- A trashed batch stays 'trashed' for its 30-day undo window (the /me notice reads it).
            or (ri.state = 'trashed' and ri.trashed_at < now() - interval '30 days'
                and (pr.plan_id <> 'free' or pr.deleted_at is not null or public._retention_over(pr.id) = 0)))
    returning 1)
  select count(*) into n_res from r;
  -- A batch trashed more than 30 days ago (purged by now) and the library still over (photos restored from
  -- Trash, new uploads blocked anyway): back to staff review. Notices were already sent.
  update public.retention_items set state = 'ready', approved_by = null, approved_at = null, updated_at = now()
   where state = 'trashed' and trashed_at < now() - interval '30 days';
  update public.retention_items ri set
    over_bytes = public._retention_over(ri.owner_id),
    photos_to_trash = (select count(*) from public._retention_pick(ri.owner_id)),
    state = case when ri.state = 'waiting' and ri.due_at <= now() and ri.notice_30_at is not null and ri.notice_7_at is not null
                 then 'ready' else ri.state end,
    updated_at = now()
   where ri.state in ('waiting', 'ready');
  return jsonb_build_object('tracked', (select count(*) from public.retention_items where state in ('waiting', 'ready', 'approved')),
                            'ready', (select count(*) from public.retention_items where state = 'ready'),
                            'resolved', n_res);
end;
$$;

-- Claims the notices due (30 and 7 days before; marked sent before returning, so two runs never email twice) and
-- returns [{ ownerId, email, dueAt, photos, notice: 'd30' | 'd7' }]. The 7-day notice never goes before the
-- 30-day one or on the same day; a late notice pushes the due date so the member always gets the full 30 (and 7)
-- days. dueAt is the date after that push.
create function public.retention_notices_due(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare res jsonb;
begin
  with c as (
    select ri.owner_id, case when ri.notice_30_at is null then 'd30' else 'd7' end as which
      from public.retention_items ri
     where ri.state in ('waiting', 'ready')
       and ((ri.notice_30_at is null and ri.due_at - interval '30 days' <= now())
            or (ri.notice_30_at is not null and ri.notice_7_at is null and ri.due_at - interval '7 days' <= now()
                and ri.notice_30_at <= now() - interval '1 day'))
     order by ri.due_at limit least(greatest(coalesce(p_limit, 100), 1), 1000)
     for update of ri skip locked
  ), u as (
    update public.retention_items ri set
      notice_30_at = case when c.which = 'd30' then now() else ri.notice_30_at end,
      notice_7_at = case when c.which = 'd7' then now() else ri.notice_7_at end,
      due_at = greatest(ri.due_at, now() + case when c.which = 'd30' then interval '30 days' else interval '7 days' end),
      updated_at = now()
      from c where ri.owner_id = c.owner_id
    returning ri.owner_id, ri.due_at, ri.photos_to_trash, c.which
  )
  select coalesce(jsonb_agg(jsonb_build_object('ownerId', u.owner_id, 'email', au.email::text, 'dueAt', u.due_at,
                                               'photos', u.photos_to_trash, 'notice', u.which) order by u.due_at), '[]'::jsonb)
    into res
    from u join auth.users au on au.id = u.owner_id where au.email is not null;
  return res;
end;
$$;


create function public._retention_json(ri public.retention_items) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('ownerId', ri.owner_id,
    'displayName', (select p.display_name from public.profiles p where p.id = ri.owner_id),
    'lapsedAt', ri.lapsed_at, 'dueAt', ri.due_at, 'overBytes', ri.over_bytes, 'photosToTrash', ri.photos_to_trash,
    'notices', jsonb_build_object('d30', ri.notice_30_at, 'd7', ri.notice_7_at), 'state', ri.state);
$$;

-- AdminRetentionResult without ok.
create function public.admin_retention(p_staff uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public._staff_can(p_staff, 'retention') then return jsonb_build_object('error', 'forbidden'); end if;
  return jsonb_build_object(
    'kpis', jsonb_build_object(
      'readOnly', (select count(*) from public.profiles pr where pr.deleted_at is null and public._library_state(pr.id) = 'read_only'
                    and not exists (select 1 from public.staff s where s.user_id = pr.id)),
      'dueIn30Days', (select count(*) from public.retention_items where state = 'waiting' and due_at <= now() + interval '30 days'),
      'ready', (select count(*) from public.retention_items where state = 'ready'),
      'resolvedThisMonth', (select count(*) from public.retention_items where state = 'resolved'
                             and resolved_at >= date_trunc('month', now()))),
    'items', coalesce((select jsonb_agg(public._retention_json(ri) order by
                                        case ri.state when 'ready' then 0 when 'approved' then 1 when 'waiting' then 2 else 3 end, ri.due_at)
                         from public.retention_items ri
                        where ri.state <> 'resolved' or ri.resolved_at > now() - interval '30 days'), '[]'::jsonb));
end;
$$;

-- Approves ready items (the API checks the passkey). Approved items are trashed by retention_trash_batch.
-- AdminRetentionResult plus { approved: n }.
create function public.admin_retention_approve(p_staff uuid, p_owner_ids uuid[], p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare n integer;
begin
  if not public._staff_can(p_staff, 'retention') then return jsonb_build_object('error', 'forbidden'); end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 300 or p_owner_ids is null
     or cardinality(p_owner_ids) not between 1 and 100 then
    return jsonb_build_object('error', 'invalid');
  end if;
  update public.retention_items set state = 'approved', approved_by = p_staff, approved_at = now(), updated_at = now()
   where owner_id = any (p_owner_ids) and state = 'ready';
  get diagnostics n = row_count;
  if n > 0 then
    perform public._audit(p_staff, 'retention.approve', null,
      jsonb_build_object('reason', btrim(p_reason), 'ownerIds', (select to_jsonb(array_agg(owner_id)) from public.retention_items
                                                                   where owner_id = any (p_owner_ids) and approved_by = p_staff and state = 'approved')));
  end if;
  return public.admin_retention(p_staff) || jsonb_build_object('approved', n);
end;
$$;

-- Approved items to process: [ownerId] (uuid[]).
create function public.retention_approved_due(p_limit integer) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(x.owner_id order by x.approved_at), '{}') from (
    select owner_id, approved_at from public.retention_items where state = 'approved' order by approved_at
     limit least(greatest(coalesce(p_limit, 20), 1), 100)) x;
$$;

-- Moves up to p_limit of the oldest photos beyond the Free storage to Trash (the usual 30-day undo). Skips held
-- photos and photos in live galleries. Idempotent: when nothing is left to move the item becomes 'trashed'.
-- Returns { trashed, done, email } or null when the item isn't approved.
create function public.retention_trash_batch(p_owner uuid, p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  ri public.retention_items;
  n integer;
  more boolean;
begin
  perform public._lock_storage(p_owner);
  select * into ri from public.retention_items where owner_id = p_owner for update;
  if not found or ri.state <> 'approved' then return null; end if;
  -- Renewed or under the limit since approval: nothing to do.
  if (select pr.plan_id <> 'free' or pr.deleted_at is not null from public.profiles pr where pr.id = p_owner) then
    update public.retention_items set state = 'resolved', resolved_at = now(), updated_at = now() where owner_id = p_owner;
    return jsonb_build_object('trashed', 0, 'done', true, 'email', null);
  end if;
  with pick as (select photo_id from public._retention_pick(p_owner) limit least(greatest(coalesce(p_limit, 500), 1), 2000)),
  u as (update public.photos p set status = 'trashed', trashed_at = now(), purge_after = now() + interval '30 days'
          from pick where p.id = pick.photo_id and p.status = 'ready' returning 1)
  select count(*) into n from u;
  more := exists (select 1 from public._retention_pick(p_owner));
  update public.retention_items set trashed_photos = trashed_photos + n,
         state = case when more then 'approved' else 'trashed' end,
         trashed_at = case when more then trashed_at else now() end, updated_at = now()
   where owner_id = p_owner;
  if n > 0 then
    perform public._audit(null, 'retention.trashed', p_owner::text, jsonb_build_object('photos', n));
  end if;
  return jsonb_build_object('trashed', n, 'done', not more,
                            'email', case when not more then (select u.email::text from auth.users u where u.id = p_owner) end);
end;
$$;

-- /me: the member's own retention batch in the last 30 days: { trashedAt, photos, restoreBy } or null.
create function public.retention_notice(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('trashedAt', ri.trashed_at, 'photos', ri.trashed_photos, 'restoreBy', ri.trashed_at + interval '30 days')
    from public.retention_items ri
   where ri.owner_id = p_owner and ri.state = 'trashed' and ri.trashed_at > now() - interval '30 days' and ri.trashed_photos > 0;
$$;

-- /me and requireMember: phase 2's profile plus `suspended` and the member's own retention batch.
create or replace function public.get_session_profile(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'isStaff', exists (select 1 from public.staff s where s.user_id = p_user_id),
    'displayName', p.display_name,
    'plan', coalesce(p.plan_id, 'free'),
    'createdAt', p.created_at,
    'deleted', p.deleted_at is not null,
    'deletionDue', p.deletion_due,
    'suspended', p.suspended_at is not null,
    'retention', public.retention_notice(p_user_id)
  )
  from public.profiles p where p.id = p_user_id;
$$;

-- ---------------------------------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------------------------------
create function public._staff_lock() returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('zephyr:staff', 0));
$$;

-- AdminStaffResult without ok. passkeys/lastActiveAt come from Auth (the API fills them; null here).
create function public.admin_staff(p_staff uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public._staff_can(p_staff, 'staff') then return jsonb_build_object('error', 'forbidden'); end if;
  return jsonb_build_object(
    'staff', coalesce((select jsonb_agg(jsonb_build_object('userId', s.user_id, 'email', u.email::text,
                         'displayName', p.display_name, 'role', s.role, 'passkeys', null,
                         'lastActiveAt', to_jsonb(u) -> 'last_sign_in_at', 'createdAt', s.created_at)
                         order by array_position(array['owner', 'admin', 'finance', 'safety', 'support'], s.role::text), s.created_at)
                         from public.staff s join auth.users u on u.id = s.user_id left join public.profiles p on p.id = s.user_id), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email::text, 'role', i.role,
                           'createdAt', i.created_at, 'expiresAt', i.expires_at, 'createdBy', public._staff_name(i.created_by))
                           order by i.created_at desc)
                           from public.staff_invites i
                          where i.accepted_at is null and i.revoked_at is null and i.expires_at > now()), '[]'::jsonb));
end;
$$;

-- Invites a staff member (Owner; the API checks the passkey and sends the link). 72 hours; a new invite for the
-- same address replaces the open one. AdminStaffResult plus { id, expiresAt }, or
-- { error: forbidden | invalid | already_staff | member_account }.
create function public.admin_staff_invite(p_staff uuid, p_email text, p_role text, p_token_hash bytea, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
  kind text;
  inv public.staff_invites;
begin
  if not public._staff_can(p_staff, 'staff') then return jsonb_build_object('error', 'forbidden'); end if;
  if e !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(e) > 254 or p_role not in ('owner', 'admin', 'finance', 'safety', 'support')
     or octet_length(p_token_hash) <> 32 or p_reason is null or length(btrim(p_reason)) not between 3 and 300 then
    return jsonb_build_object('error', 'invalid');
  end if;
  perform public._staff_lock();
  -- Re-checked under the lock: a role change that just committed (this caller demoted) wins.
  if not public._staff_can(p_staff, 'staff') then return jsonb_build_object('error', 'forbidden'); end if;
  kind := public.account_kind(e);
  if kind = 'staff' then return jsonb_build_object('error', 'already_staff'); end if;
  if kind = 'member' then return jsonb_build_object('error', 'member_account'); end if;
  update public.staff_invites set revoked_at = now() where email = e and accepted_at is null and revoked_at is null;
  insert into public.staff_invites (email, role, token_hash, created_by, expires_at)
  values (e, p_role::public.staff_role, p_token_hash, p_staff, now() + interval '72 hours') returning * into inv;
  perform public._audit(p_staff, 'staff.invite', public._mask_email(e), jsonb_build_object('role', p_role, 'reason', btrim(p_reason)));
  return public.admin_staff(p_staff) || jsonb_build_object('id', inv.id, 'expiresAt', inv.expires_at);
end;
$$;

create function public.admin_staff_invite_revoke(p_staff uuid, p_invite uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public._staff_can(p_staff, 'staff') then return jsonb_build_object('error', 'forbidden'); end if;
  update public.staff_invites set revoked_at = now() where id = p_invite and accepted_at is null and revoked_at is null;
  if not found then return null; end if;
  perform public._audit(p_staff, 'staff.invite_revoked', p_invite::text, '{}'::jsonb);
  return public.admin_staff(p_staff);
end;
$$;

-- The invite link (checks only, doesn't use it up): { inviteId, email, role }, { error: 'account_exists' } when the
-- address already has an account (staff accounts are created fresh by the API), or null for an unknown, used,
-- revoked or expired link.
create function public.staff_invite_accept(p_token_hash bytea) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public.user_id_by_email(i.email::text) is not null then jsonb_build_object('error', 'account_exists')
              else jsonb_build_object('inviteId', i.id, 'email', i.email::text, 'role', i.role) end
    from public.staff_invites i
   where i.token_hash = p_token_hash and i.accepted_at is null and i.revoked_at is null and i.expires_at > now();
$$;

-- The sign-up hook lets a live staff invite through (invite-only mode and paused sign-ups are for members).
create function public._staff_invite_open(p_email text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff_invites i
                  where i.email = lower(btrim(p_email)) and i.accepted_at is null and i.revoked_at is null and i.expires_at > now());
$$;

create or replace function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  s public.app_settings%rowtype;
  v_email text := lower(trim(event -> 'user' ->> 'email'));
begin
  if v_email is not null and v_email <> '' and public._staff_invite_open(v_email) then
    return '{}'::jsonb;
  end if;

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
        and (i.source <> 'team' or public._team_invite_usable(i.id))
    ) then
      return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Zephyr is invite-only right now.'));
    end if;
  end if;

  return '{}'::jsonb;
end;
$$;

-- After the API created the staff auth user for an invite: uses the invite up and inserts the staff row in one
-- transaction. The user must have the invited address and nothing else (no library, subscription or team).
-- { userId, role } or null (unknown/used/expired invite, wrong user).
create function public.staff_invite_complete(p_invite_id uuid, p_user_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare i public.staff_invites;
begin
  perform public._staff_lock();
  select * into i from public.staff_invites
   where id = p_invite_id and accepted_at is null and revoked_at is null and expires_at > now() for update;
  if not found then return null; end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id and lower(u.email::text) = lower(i.email::text)) then return null; end if;
  if exists (select 1 from public.photos p where p.owner_id = p_user_id) or exists (select 1 from public.subscriptions s where s.owner_id = p_user_id)
     or exists (select 1 from public.library_members m where m.member_id = p_user_id) then
    return null;
  end if;
  insert into public.staff (user_id, role, created_by) values (p_user_id, i.role, i.created_by)
  on conflict (user_id) do nothing;
  if not found then return null; end if;
  update public.staff_invites set accepted_at = now(), accepted_user = p_user_id where id = i.id;
  perform public._audit(p_user_id, 'staff.joined', p_user_id::text, jsonb_build_object('role', i.role, 'invite', i.id));
  return jsonb_build_object('userId', p_user_id, 'role', i.role);
end;
$$;

-- Changes a role (Owner; the API checks the passkey). Refuses to leave no Owner. AdminStaffResult or
-- { error: forbidden | invalid | last_owner }, null for unknown staff.
create function public.admin_staff_set_role(p_staff uuid, p_user uuid, p_role text, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare old public.staff_role;
begin
  if not public._staff_can(p_staff, 'staff') then return jsonb_build_object('error', 'forbidden'); end if;
  if p_role not in ('owner', 'admin', 'finance', 'safety', 'support') or p_reason is null or length(btrim(p_reason)) not between 3 and 300 then
    return jsonb_build_object('error', 'invalid');
  end if;
  perform public._staff_lock();
  -- Re-checked under the lock: a role change that just committed (this caller demoted) wins.
  if not public._staff_can(p_staff, 'staff') then return jsonb_build_object('error', 'forbidden'); end if;
  select role into old from public.staff where user_id = p_user for update;
  if not found then return null; end if;
  if old = 'owner' and p_role <> 'owner' and (select count(*) from public.staff where role = 'owner') <= 1 then
    return jsonb_build_object('error', 'last_owner');
  end if;
  update public.staff set role = p_role::public.staff_role where user_id = p_user;
  perform public._audit(p_staff, 'staff.role', p_user::text, jsonb_build_object('from', old, 'to', p_role, 'reason', btrim(p_reason)));
  return public.admin_staff(p_staff);
end;
$$;

-- Removes a staff member (Owner; passkey). Their admin sessions end. AdminStaffResult or { error }.
create function public.admin_staff_remove(p_staff uuid, p_user uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare old public.staff_role;
begin
  if not public._staff_can(p_staff, 'staff') then return jsonb_build_object('error', 'forbidden'); end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 300 then return jsonb_build_object('error', 'invalid'); end if;
  perform public._staff_lock();
  -- Re-checked under the lock: a role change that just committed (this caller demoted) wins.
  if not public._staff_can(p_staff, 'staff') then return jsonb_build_object('error', 'forbidden'); end if;
  select role into old from public.staff where user_id = p_user for update;
  if not found then return null; end if;
  if old = 'owner' and (select count(*) from public.staff where role = 'owner') <= 1 then
    return jsonb_build_object('error', 'last_owner');
  end if;
  delete from public.staff where user_id = p_user;
  perform public._auth_sign_out_all(p_user);
  perform public._audit(p_staff, 'staff.removed', p_user::text, jsonb_build_object('role', old, 'reason', btrim(p_reason)));
  return public.admin_staff(p_staff);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------------------------
-- AdminAuditResult.page: { items, nextCursor }, 50 per page, newest first, cursor = the last id.
create function public.admin_audit(p_staff uuid, p_actor uuid, p_kind text, p_target text, p_from timestamptz,
                                   p_to timestamptz, p_cursor text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  before bigint;
  items jsonb;
  n integer;
  last bigint;
begin
  if not public._staff_can(p_staff, 'auditView') then return jsonb_build_object('error', 'forbidden'); end if;
  begin before := nullif(p_cursor, '')::bigint; exception when others then before := null; end;
  select coalesce(jsonb_agg(public._audit_entry(a) order by a.id desc), '[]'::jsonb), count(*), min(a.id)
    into items, n, last
    from (select * from public.audit_log a
           where (before is null or a.id < before)
             and (p_actor is null or a.actor = p_actor)
             and (p_kind is null or a.kind = p_kind)
             and (p_target is null or a.target = p_target)
             and (p_from is null or a.created_at >= p_from)
             and (p_to is null or a.created_at < p_to)
           order by a.id desc limit 51) a;
  if n > 50 then
    items := items - 50;
    select min(x.id) into last from (select a.id from public.audit_log a
           where (before is null or a.id < before) and (p_actor is null or a.actor = p_actor)
             and (p_kind is null or a.kind = p_kind) and (p_target is null or a.target = p_target)
             and (p_from is null or a.created_at >= p_from) and (p_to is null or a.created_at < p_to)
           order by a.id desc limit 50) x;
  end if;
  return jsonb_build_object('items', items, 'nextCursor', case when n > 50 then last::text end);
end;
$$;

-- Export (Owner, Admin): up to 50,000 entries, newest first (the export itself is logged). [AdminAuditEntry].
create function public.admin_audit_export(p_staff uuid, p_actor uuid, p_kind text, p_target text, p_from timestamptz,
                                          p_to timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare rows jsonb;
begin
  if not public._staff_can(p_staff, 'auditExport') then return jsonb_build_object('error', 'forbidden'); end if;
  select coalesce(jsonb_agg(public._audit_entry(a) order by a.id desc), '[]'::jsonb) into rows
    from (select * from public.audit_log a
           where (p_actor is null or a.actor = p_actor) and (p_kind is null or a.kind = p_kind)
             and (p_target is null or a.target = p_target) and (p_from is null or a.created_at >= p_from)
             and (p_to is null or a.created_at < p_to)
           order by a.id desc limit 50000) a;
  perform public._audit(p_staff, 'audit.exported', null,
    jsonb_build_object('rows', jsonb_array_length(rows), 'kind', p_kind, 'actor', p_actor, 'target', p_target));
  return rows;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Settings and app status
-- ---------------------------------------------------------------------------------------------
-- AdminSettings without ok. access.accessConfigured is filled by the API (it knows the Access config); staff
-- passkey counts come from Auth (null here).
create function public.admin_settings(p_staff uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public._staff_can(p_staff, 'settings') then return jsonb_build_object('error', 'forbidden'); end if;
  return (select jsonb_build_object(
    'readOnly', jsonb_build_object('on', coalesce((s.read_only ->> 'on')::boolean, false), 'auto', coalesce((s.read_only ->> 'auto')::boolean, false),
                                   'message', coalesce(s.read_only ->> 'message', ''), 'since', s.read_only -> 'since'),
    'maintenance', jsonb_build_object('on', coalesce((s.maintenance ->> 'on')::boolean, false), 'message', coalesce(s.maintenance ->> 'message', ''),
                                      'startsAt', s.maintenance -> 'startsAt', 'endsAt', s.maintenance -> 'endsAt'),
    'access', jsonb_build_object('accessConfigured', null, 'staffWithPasskey', null,
                                 'staffTotal', (select count(*) from public.staff), 'idleMinutes', 30),
    'alerts', jsonb_build_object('safetyAlertConfigured', null, 'owners', (select count(*) from public.staff where role = 'owner')))
    from public.app_settings s where s.id = 1);
end;
$$;

-- p_patch: AdminSettingsPatch without reason. AdminSettings or { error }.
create function public.admin_settings_set(p_staff uuid, p_patch jsonb, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.app_settings;
  ro jsonb;
  mt jsonb;
begin
  if not public._staff_can(p_staff, 'settings') then return jsonb_build_object('error', 'forbidden'); end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 300 or p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    return jsonb_build_object('error', 'invalid');
  end if;
  select * into s from public.app_settings where id = 1 for update;
  ro := s.read_only;
  mt := s.maintenance;
  begin
    if p_patch ? 'readOnly' then
      if (p_patch -> 'readOnly' ->> 'on')::boolean then
        ro := ro || jsonb_build_object('on', true, 'auto', false,
                    'since', coalesce(case when (ro ->> 'on')::boolean then ro -> 'since' end, to_jsonb(now())));
      else
        ro := ro || jsonb_build_object('on', false, 'auto', false, 'since', null);
      end if;
      if p_patch -> 'readOnly' ? 'message' then
        if length(p_patch -> 'readOnly' ->> 'message') > 200 then return jsonb_build_object('error', 'invalid'); end if;
        ro := ro || jsonb_build_object('message', p_patch -> 'readOnly' ->> 'message');
      end if;
    end if;
    if p_patch ? 'maintenance' then
      if p_patch -> 'maintenance' ? 'message' and length(p_patch -> 'maintenance' ->> 'message') > 200 then
        return jsonb_build_object('error', 'invalid');
      end if;
      mt := mt || (p_patch -> 'maintenance');
      if (mt ->> 'startsAt') is not null and (mt ->> 'endsAt') is not null and (mt ->> 'startsAt')::timestamptz >= (mt ->> 'endsAt')::timestamptz then
        return jsonb_build_object('error', 'invalid');
      end if;
    end if;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    return jsonb_build_object('error', 'invalid');
  end;
  update public.app_settings set read_only = ro, maintenance = mt, updated_at = now(), updated_by = p_staff where id = 1;
  if ro is distinct from s.read_only then
    perform public._audit(p_staff, 'settings.read_only', 'read_only', jsonb_build_object('on', ro -> 'on', 'reason', btrim(p_reason)));
  end if;
  if mt is distinct from s.maintenance then
    perform public._audit(p_staff, 'settings.maintenance', 'maintenance', jsonb_build_object('on', mt -> 'on', 'reason', btrim(p_reason)));
  end if;
  return public.admin_settings(p_staff);
end;
$$;

-- The storage health check turns read-only mode on and off by itself, but never turns off a manual one.
-- Returns { on, auto, changed }.
create function public.read_only_auto(p_on boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  ro jsonb;
  changed boolean := false;
begin
  select read_only into ro from public.app_settings where id = 1 for update;
  if p_on and not coalesce((ro ->> 'on')::boolean, false) then
    ro := ro || jsonb_build_object('on', true, 'auto', true, 'since', now(),
                                   'message', coalesce(nullif(ro ->> 'message', ''), 'Uploads are paused while we check our storage. Your photos are safe.'));
    changed := true;
  elsif not p_on and coalesce((ro ->> 'on')::boolean, false) and coalesce((ro ->> 'auto')::boolean, false) then
    ro := ro || jsonb_build_object('on', false, 'auto', false, 'since', null);
    changed := true;
  end if;
  if changed then
    update public.app_settings set read_only = ro, updated_at = now() where id = 1;
    perform public._audit(null, 'settings.read_only', 'read_only', jsonb_build_object('on', p_on, 'auto', true, 'reason', left(coalesce(p_reason, ''), 300)));
  end if;
  return jsonb_build_object('on', coalesce((ro ->> 'on')::boolean, false), 'auto', coalesce((ro ->> 'auto')::boolean, false), 'changed', changed);
end;
$$;

-- AppStatusResult without ok: public data only (/api/v1/status).
create function public.app_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'readOnly', case when coalesce((s.read_only ->> 'on')::boolean, false)
                     then jsonb_build_object('on', true, 'message', coalesce(s.read_only ->> 'message', '')) end,
    'maintenance', case when coalesce((s.maintenance ->> 'on')::boolean, false)
                          and (s.maintenance ->> 'endsAt' is null or (s.maintenance ->> 'endsAt')::timestamptz > now())
                        then jsonb_build_object('message', coalesce(s.maintenance ->> 'message', ''),
                                                'startsAt', s.maintenance -> 'startsAt', 'endsAt', s.maintenance -> 'endsAt') end)
    from public.app_settings s where s.id = 1;
$$;

-- '\x…' (as the API's toPgBytea writes it) or plain hex → bytea; null if malformed.
create function public._hex_bytea(p text) returns bytea
language plpgsql immutable set search_path = '' as $$
begin
  return decode(regexp_replace(p, '^\\x', ''), 'hex');
exception when others then
  return null;
end;
$$;

-- Rotates one gallery's link under the owner's storage lock (the API made the new token, its hint and its
-- encrypted copy). Every guest route carries the token, so the old link, and with it every guest session and signed
-- URL made for it, stops at once (the Worker caches link state for up to 60 s). The passcode, unlock generation and
-- guests' favourites are kept. Live and paused galleries only.
create function public._gallery_link_rotate(p_owner uuid, p_actor uuid, p_id uuid, p_token_hash bytea, p_link_hint text,
                                            p_link_ciphertext bytea, p_link_iv bytea) returns boolean
language plpgsql volatile set search_path = '' as $$
declare g public.galleries;
begin
  select * into g from public.galleries where id = p_id and owner_id = p_owner for update;
  if not found or public._gallery_status(g) not in ('live', 'paused') then return null; end if;
  update public.galleries set token_hash = p_token_hash, link_hint = p_link_hint, link_ciphertext = p_link_ciphertext,
                              link_iv = p_link_iv, updated_at = now()
   where id = p_id;
  delete from public.gallery_attempts where gallery_id = p_id;
  perform public._audit(p_actor, 'gallery.link_replaced', p_id::text, jsonb_build_object('ownerId', p_owner));
  return true;
end;
$$;

-- POST /galleries/:id/link/replace (the API checked the actor's galleries role in the library). true, or null
-- for an unknown, other library's or ended gallery. Bad values (hash length, hint) raise check_violation.
create function public.gallery_link_replace(p_owner uuid, p_actor uuid, p_id uuid, p_token_hash bytea, p_link_hint text,
                                            p_link_ciphertext bytea, p_link_iv bytea) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._lock_storage(p_owner);
  return public._gallery_link_rotate(p_owner, p_actor, p_id, p_token_hash, p_link_hint, p_link_ciphertext, p_link_iv);
end;
$$;

-- Team removal with ?replaceLinks=1: rotates several galleries in one transaction. p_links:
-- [{ id, tokenHash, linkHint, ciphertext, iv }] (bytea values as '\x…' hex). Returns how many were rotated
-- (ended or unknown galleries are skipped); a malformed entry raises invalid_parameter_value and rotates none.
create function public.gallery_links_replace(p_owner uuid, p_actor uuid, p_links jsonb) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  e jsonb;
  n integer := 0;
begin
  if p_links is null or jsonb_typeof(p_links) <> 'array' or jsonb_array_length(p_links) > 500 then
    raise exception 'bad links' using errcode = 'invalid_parameter_value';
  end if;
  perform public._lock_storage(p_owner);
  for e in select value from jsonb_array_elements(p_links) loop
    if public._hex_bytea(e ->> 'tokenHash') is null or public._hex_bytea(e ->> 'ciphertext') is null
       or public._hex_bytea(e ->> 'iv') is null or e ->> 'linkHint' is null or (e ->> 'id') !~* '^[0-9a-f-]{36}$' then
      raise exception 'bad link entry' using errcode = 'invalid_parameter_value';
    end if;
    if public._gallery_link_rotate(p_owner, p_actor, (e ->> 'id')::uuid, public._hex_bytea(e ->> 'tokenHash'), e ->> 'linkHint',
                                   public._hex_bytea(e ->> 'ciphertext'), public._hex_bytea(e ->> 'iv')) then
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

-- The owner's live and paused galleries (for "replace the links of N galleries" on team removal).
create function public.live_gallery_ids(p_owner uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(g.id order by g.created_at), '{}') from public.galleries g
   where g.owner_id = p_owner and public._gallery_status(g) in ('live', 'paused');
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: service_role only; internal helpers (_*) for their owner only.
-- ---------------------------------------------------------------------------------------------
revoke all on public.safety_hold_reports, public.reveal_grants, public.limits_notices, public.ad_cards,
  public.ad_stats_daily, public.retention_items, public.staff_invites from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on function
  public._staff_role_of(uuid), public._staff_can(uuid, text), public._staff_name(uuid), public._mask_email(text),
  public._audit_kind(text), public._profile_lapse(), public._stripe_plan(uuid), public._plan_effective(uuid),
  public._set_plan(uuid, text, text, uuid), public._auth_sign_out_all(uuid), public._auth_session_count(uuid),
  public._member_status(public.profiles), public._audit_entry(public.audit_log), public._user_row(public.profiles, boolean),
  public._user_detail(uuid), public._user_target_ok(uuid, uuid, text, text), public._override_end(uuid, uuid, text),
  public._report_group(uuid), public._report_json(uuid, boolean), public._hold_json(public.photos), public._reveal_key(public.photos),
  public._limits_plan_json(public.plan_limits), public._limits_version_json(public.plan_limit_versions, boolean),
  public._limits_lock(), public._limits_changes(bigint, bigint), public._limit_label(text), public._limits_preview(bigint), public._limits_activate(bigint),
  public._ad_status(public.ad_cards), public._ad_json(public.ad_cards), public._adsense_json(),
  public._photo_total_bytes(public.photos), public._retention_over(uuid), public._retention_pick(uuid),
  public._retention_json(public.retention_items), public._staff_lock(), public._hex_bytea(text),
  public._gallery_link_rotate(uuid, uuid, uuid, bytea, text, bytea, bytea), public._suspend_guard(),
  public._staff_invite_open(text)
from service_role;
grant execute on function
  public.restore_account(uuid),
  public.apply_safety_hold(uuid, uuid),
  public.library_access(uuid, uuid),
  public.list_libraries(uuid),
  public.admin_users(uuid, text, text, text, text, text),
  public.admin_user(uuid, uuid),
  public.admin_user_override(uuid, uuid, text, timestamptz, text),
  public.admin_user_override_end(uuid, uuid, text),
  public.admin_overrides_expire(),
  public.admin_user_grant_credits(uuid, uuid, integer, text),
  public.admin_user_sign_out(uuid, uuid, text),
  public.admin_user_suspend(uuid, uuid, text, text),
  public.admin_user_unsuspend(uuid, uuid, text),
  public.admin_user_sharing_lift(uuid, uuid, text),
  public.admin_user_deletion_schedule(uuid, uuid, text),
  public.admin_user_deletion_cancel(uuid, uuid, text),
  public.member_suspended(uuid),
  public.admin_safety(uuid, text),
  public.admin_report(uuid, uuid),
  public.admin_reveal(uuid, uuid, text, bytea),
  public.reveal_grant_check(uuid, bytea, uuid, uuid),
  public.admin_report_resolve(uuid, uuid, text[], text),
  public.admin_hold_report(uuid, uuid, text, text),
  public.admin_hold_release(uuid, uuid, text),
  public.admin_limits(uuid),
  public.admin_limits_draft_create(uuid, integer),
  public.admin_limits_draft_save(uuid, jsonb),
  public.admin_limits_draft_delete(uuid),
  public.admin_limits_preview(uuid, timestamptz),
  public.admin_limits_schedule(uuid, timestamptz, text),
  public.admin_limits_cancel(uuid, text),
  public.limits_activate_due(),
  public.limits_notices_due(integer),
  public.admin_ads(uuid),
  public.admin_ad_card_save(uuid, uuid, jsonb),
  public.admin_ad_card_delete(uuid, uuid),
  public.admin_ad_image_set(uuid, uuid, text),
  public.ad_image_key(uuid, integer),
  public.admin_adsense_set(uuid, jsonb, text),
  public.ads_for_member(uuid),
  public.adsense_public(),
  public.ad_event(uuid, text, text),
  public.ad_status_tick(),
  public.retention_sweep(),
  public.retention_notices_due(integer),
  public.admin_retention(uuid),
  public.admin_retention_approve(uuid, uuid[], text),
  public.retention_approved_due(integer),
  public.retention_trash_batch(uuid, integer),
  public.retention_notice(uuid),
  public.get_session_profile(uuid),
  public.admin_staff(uuid),
  public.admin_staff_invite(uuid, text, text, bytea, text),
  public.admin_staff_invite_revoke(uuid, uuid),
  public.staff_invite_accept(bytea),
  public.staff_invite_complete(uuid, uuid),
  public.admin_staff_set_role(uuid, uuid, text, text),
  public.admin_staff_remove(uuid, uuid, text),
  public.admin_audit(uuid, uuid, text, text, timestamptz, timestamptz, text),
  public.admin_audit_export(uuid, uuid, text, text, timestamptz, timestamptz),
  public.admin_settings(uuid),
  public.admin_settings_set(uuid, jsonb, text),
  public.read_only_auto(boolean, text),
  public.app_status(),
  public.gallery_link_replace(uuid, uuid, uuid, bytea, text, bytea, bytea),
  public.gallery_links_replace(uuid, uuid, jsonb),
  public.live_gallery_ids(uuid)
to service_role;
-- The sign-up hook and team checks still run as before.
grant execute on function public._team_invite_usable(uuid), public._staff_invite_open(text) to supabase_auth_admin;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
