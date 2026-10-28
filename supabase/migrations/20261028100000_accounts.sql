-- Phase 2: accounts, invites, invite codes, member invites, the admin Sign-ups page and rate limits
-- for sign-in. See docs/phase-2.md.
--
-- Every function here is SECURITY DEFINER with `search_path = ''`, schema-qualifies every name and is
-- executable only by service_role (the API Worker). Emails are compared as lower(email::text): with
-- an empty search_path the citext `=` operator isn't found. Admin writes take the acting staff user's
-- id, re-check their role here (defence in depth; the API checks it first) and write to audit_log.

-- ---------------------------------------------------------------------------------------------
-- Rate limits for sign-in, invite codes and invite links
-- ---------------------------------------------------------------------------------------------
-- One row per counted attempt. Keys are HMAC-SHA-256 hashes made by the API (of a network or an
-- email address), never raw values. Kept in Postgres rather than the Workers rate-limit binding
-- because the binding counts per Cloudflare location and only supports 10 s / 60 s windows, while
-- these limits must hold globally over 15 minutes. Purged after 2 days.
create table public.rate_limit_attempts (
  id bigint generated always as identity primary key,
  kind text not null check (kind ~ '^[a-z_]{1,40}$'),
  key_hash bytea not null check (length(key_hash) = 32),
  created_at timestamptz not null default now()
);
create index rate_limit_attempts_lookup on public.rate_limit_attempts (kind, key_hash, created_at desc);
create index rate_limit_attempts_created on public.rate_limit_attempts (created_at);
alter table public.rate_limit_attempts enable row level security;

-- Counts this attempt and says whether it's allowed. Over the limit → false, and nothing is
-- recorded (so a client hammering an exhausted limit can't push the window forward).
create function public.rate_limit_hit(p_kind text, p_key bytea, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare n integer;
begin
  if p_limit < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'bad rate limit' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_kind || ':' || encode(p_key, 'hex'), 0));
  select count(*) into n from public.rate_limit_attempts
   where kind = p_kind and key_hash = p_key and created_at > now() - make_interval(secs => p_window_seconds);
  if n >= p_limit then
    return false;
  end if;
  insert into public.rate_limit_attempts (kind, key_hash) values (p_kind, p_key);
  return true;
end;
$$;

-- For limits on failures (e.g. wrong email codes): read without recording, record separately.
create function public.rate_limit_count(p_kind text, p_key bytea, p_window_seconds integer) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from public.rate_limit_attempts
   where kind = p_kind and key_hash = p_key and created_at > now() - make_interval(secs => p_window_seconds);
$$;
create function public.rate_limit_record(p_kind text, p_key bytea) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.rate_limit_attempts (kind, key_hash) values (p_kind, p_key);
$$;

-- The existing daily purge (scheduled by the cron migration) now clears these attempts too.
create or replace function public.purge_invite_requests() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.invite_requests
   where status <> 'approved' and created_at < now() - interval '90 days';
  get diagnostics n = row_count;
  delete from public.invite_request_attempts where created_at < now() - interval '2 days';
  delete from public.rate_limit_attempts where created_at < now() - interval '2 days';
  return n;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Internal helpers (not granted to anyone; called by the functions below as their owner)
-- ---------------------------------------------------------------------------------------------
create function public._invite_status(i public.invites) returns text
language sql stable set search_path = '' as $$
  select case
    when i.accepted_at is not null then 'accepted'
    when i.revoked_at is not null then 'revoked'
    when i.expires_at <= now() then 'expired'
    else 'pending'
  end;
$$;

-- "Jason L. · Owner", "Mei Lin", "Code WEDDING-EXPO", "Invite request".
create function public._invite_by_label(i public.invites) returns text
language sql stable set search_path = '' as $$
  select case i.source
    when 'admin' then coalesce(
      (select coalesce(p.display_name, split_part(u.email, '@', 1)) || ' · ' || initcap(s.role::text)
         from public.staff s
         join auth.users u on u.id = s.user_id
         left join public.profiles p on p.id = s.user_id
        where s.user_id = i.invited_by),
      'Zephyr team')
    when 'member' then coalesce((select p.display_name from public.profiles p where p.id = i.invited_by), 'A member')
    when 'code' then 'Code ' || coalesce((select c.code::text from public.invite_codes c where c.id = i.code_id), '—')
    else 'Invite request'
  end;
$$;

create function public._invite_json(i public.invites) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', i.id,
    'email', i.email::text,
    'status', public._invite_status(i),
    'source', i.source,
    'invitedBy', public._invite_by_label(i),
    'createdAt', i.created_at,
    'expiresAt', i.expires_at
  );
$$;

create function public._code_json(c public.invite_codes) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'code', c.code::text, 'label', c.label, 'maxUses', c.max_uses, 'uses', c.uses,
    'expiresAt', c.expires_at, 'revokedAt', c.revoked_at, 'createdAt', c.created_at
  );
$$;

create function public._settings_json() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'signupMode', s.signup_mode,
    'acceptInviteRequests', s.accept_invite_requests,
    'signupsPaused', s.signups_paused,
    'memberInvitesEnabled', s.member_invites_enabled,
    'memberInvitesPerMonth', s.member_invites_per_month,
    'inviteTtlDays', s.invite_ttl_days
  ) from public.app_settings s where s.id = 1;
$$;

-- Role of a staff member who may change sign-up settings (owner or admin), else null.
create function public._writer_role(p_actor uuid) returns public.staff_role
language sql stable set search_path = '' as $$
  select s.role from public.staff s where s.user_id = p_actor and s.role in ('owner', 'admin');
$$;

create function public._audit(p_actor uuid, p_action text, p_target text, p_details jsonb default '{}'::jsonb)
returns void
language sql volatile set search_path = '' as $$
  insert into public.audit_log (actor, action, target, details) values (p_actor, p_action, p_target, coalesce(p_details, '{}'::jsonb));
$$;

-- Keyset cursor "<created_at>|<uuid>" → (timestamptz, uuid); null if absent or malformed.
create function public._parse_cursor(p_cursor text, out at timestamptz, out id uuid)
language plpgsql stable set search_path = '' as $$
begin
  if p_cursor is null or p_cursor = '' then return; end if;
  begin
    at := split_part(p_cursor, '|', 1)::timestamptz;
    id := split_part(p_cursor, '|', 2)::uuid;
  exception when others then
    at := null; id := null;
  end;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------------------------
create function public.user_id_by_email(p_email text) returns uuid
language sql stable security definer set search_path = '' as $$
  select u.id from auth.users u where lower(u.email) = lower(trim(p_email)) order by u.id limit 1;
$$;

-- 'none' | 'member' | 'staff'. Lets the API decide whether to send an email code without telling
-- the caller anything (its reply is the same either way).
create function public.account_kind(p_email text) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when u.id is null then 'none'
    when exists (select 1 from public.staff s where s.user_id = u.id) then 'staff'
    else 'member'
  end
  from (select public.user_id_by_email(p_email) as id) u;
$$;

create function public.is_staff(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff s where s.user_id = p_user_id);
$$;

-- {role, email, displayName} for a staff member, or null.
create function public.staff_lookup(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('role', s.role, 'email', u.email, 'displayName', p.display_name)
    from public.staff s
    join auth.users u on u.id = s.user_id
    left join public.profiles p on p.id = s.user_id
   where s.user_id = p_user_id;
$$;

-- What the app session needs about a member: {isStaff, displayName, plan, createdAt, deleted}.
create function public.get_session_profile(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'isStaff', exists (select 1 from public.staff s where s.user_id = p_user_id),
    'displayName', p.display_name,
    'plan', coalesce(p.plan_id, 'free'),
    'createdAt', p.created_at,
    'deleted', p.deleted_at is not null
  )
  from public.profiles p where p.id = p_user_id;
$$;

create function public.update_display_name(p_user_id uuid, p_name text) returns void
language sql volatile security definer set search_path = '' as $$
  update public.profiles set display_name = nullif(trim(p_name), '') where id = p_user_id;
$$;

-- ---------------------------------------------------------------------------------------------
-- Invites
-- ---------------------------------------------------------------------------------------------
-- Returns {status, id?, expiresAt?}. status:
--   created | already_member | already_invited | signups_paused | member_invites_disabled |
--   quota_exceeded | invalid
-- Member invites that don't create a live invite still record a revoked row, so every attempt
-- counts towards the monthly quota and a member can't probe more than a few addresses a month.
create function public.create_invite(
  p_email text,
  p_token_hash bytea,
  p_source public.invite_source,
  p_invited_by uuid,
  p_code_id uuid,
  p_note text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.app_settings%rowtype;
  v_email text := lower(trim(p_email));
  v_status text := 'created';
  v_used integer;
  v_id uuid;
  v_expires timestamptz;
begin
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' or length(v_email) > 254 then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_source = 'code' then
    raise exception 'use redeem_invite_code for code invites' using errcode = 'invalid_parameter_value';
  end if;
  select * into s from public.app_settings where id = 1;
  if s.signups_paused then
    return jsonb_build_object('status', 'signups_paused');
  end if;

  if p_source = 'member' then
    if p_invited_by is null then
      raise exception 'member invite needs an inviter' using errcode = 'invalid_parameter_value';
    end if;
    if not s.member_invites_enabled then
      return jsonb_build_object('status', 'member_invites_disabled');
    end if;
    perform pg_advisory_xact_lock(hashtextextended('member-invite:' || p_invited_by::text, 0));
    select count(*) into v_used from public.invites i
     where i.source = 'member' and i.invited_by = p_invited_by
       and i.created_at >= date_trunc('month', now());
    if v_used >= s.member_invites_per_month then
      return jsonb_build_object('status', 'quota_exceeded');
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('invite-email:' || v_email, 0));
  if exists (select 1 from auth.users u where lower(u.email) = v_email) then
    v_status := 'already_member';
  elsif exists (
    select 1 from public.invites i
     where lower(i.email::text) = v_email and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
  ) then
    v_status := 'already_invited';
  end if;

  if v_status <> 'created' and p_source <> 'member' then
    return jsonb_build_object('status', v_status);
  end if;

  v_expires := now() + make_interval(days => s.invite_ttl_days);
  insert into public.invites (email, token_hash, source, invited_by, code_id, note, expires_at, revoked_at)
  values (v_email, p_token_hash, p_source, p_invited_by, p_code_id, nullif(trim(p_note), ''), v_expires,
          case when v_status = 'created' then null else now() end)
  returning id into v_id;

  if v_status <> 'created' then
    return jsonb_build_object('status', v_status);
  end if;
  if p_source in ('admin', 'request') then
    perform public._audit(p_invited_by, 'invites.create', v_id::text, jsonb_build_object('source', p_source));
  end if;
  return jsonb_build_object('status', 'created', 'id', v_id, 'expiresAt', v_expires);
end;
$$;

-- A live invite for this token, or null. Unknown, expired, revoked and used tokens, and any token
-- while sign-ups are paused, all look the same.
create function public.preview_invite(p_token_hash bytea) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', i.id,
    'email', i.email::text,
    'inviterName', case when i.source = 'member' then (select p.display_name from public.profiles p where p.id = i.invited_by) end,
    'expiresAt', i.expires_at
  )
  from public.invites i, public.app_settings s
  where i.token_hash = p_token_hash
    and s.id = 1 and not s.signups_paused
    and i.accepted_at is null and i.revoked_at is null and i.expires_at > now();
$$;

-- Marks a live invite used. True only if this call did it (so a link works once).
create function public.mark_invite_accepted(p_invite_id uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.invites set accepted_at = now()
   where id = p_invite_id and accepted_at is null and revoked_at is null and expires_at > now();
  return found;
end;
$$;

-- Invite codes: one use creates an invite tied to the given email. Returns {status, id?, expiresAt?}
-- with status created | already_member | invalid. The API replies the same way to all three.
-- If that email already has a live invite, its link is rotated instead of using up another code use.
create function public.redeem_invite_code(p_code text, p_email text, p_token_hash bytea) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.app_settings%rowtype;
  c public.invite_codes%rowtype;
  v_email text := lower(trim(p_email));
  v_id uuid;
  v_expires timestamptz;
  v_rotated_expires timestamptz;
begin
  select * into s from public.app_settings where id = 1;
  if s.signups_paused or v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into c from public.invite_codes
   where lower(code::text) = lower(trim(p_code))
   for update;
  if not found or c.revoked_at is not null or c.expires_at <= now() or c.uses >= c.max_uses then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('invite-email:' || v_email, 0));
  if exists (select 1 from auth.users u where lower(u.email) = v_email) then
    return jsonb_build_object('status', 'already_member');
  end if;

  v_expires := now() + make_interval(days => s.invite_ttl_days);
  update public.invites set token_hash = p_token_hash, expires_at = greatest(expires_at, v_expires)
   where id = (
     select i.id from public.invites i
      where lower(i.email::text) = v_email and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
      order by i.created_at desc limit 1
   )
  returning id, expires_at into v_id, v_rotated_expires;
  if v_id is not null then
    return jsonb_build_object('status', 'created', 'id', v_id, 'expiresAt', v_rotated_expires);
  end if;

  update public.invite_codes set uses = uses + 1 where id = c.id;
  insert into public.invites (email, token_hash, source, code_id, expires_at)
  values (v_email, p_token_hash, 'code', c.id, v_expires)
  returning id into v_id;
  return jsonb_build_object('status', 'created', 'id', v_id, 'expiresAt', v_expires);
end;
$$;

-- Member's own invites and remaining quota for this calendar month.
create function public.list_member_invites(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'enabled', s.member_invites_enabled and not s.signups_paused,
    'perMonth', s.member_invites_per_month,
    'remaining', greatest(0, s.member_invites_per_month - (
      select count(*) from public.invites i
       where i.source = 'member' and i.invited_by = p_user_id and i.created_at >= date_trunc('month', now()))),
    'invites', coalesce((
      select jsonb_agg(public._invite_json(i) order by i.created_at desc)
        from (select * from public.invites i
               where i.source = 'member' and i.invited_by = p_user_id
               order by i.created_at desc limit 50) i), '[]'::jsonb)
  )
  from public.app_settings s where s.id = 1;
$$;

-- ---------------------------------------------------------------------------------------------
-- Admin: Sign-ups & invites
-- ---------------------------------------------------------------------------------------------
create function public.get_signup_overview() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'settings', public._settings_json(),
    'pendingRequests', (select count(*) from public.invite_requests r where r.status = 'pending'),
    'pendingInvites', (select count(*) from public.invites i
                        where i.accepted_at is null and i.revoked_at is null and i.expires_at > now()),
    'codes', coalesce((select jsonb_agg(public._code_json(c) order by c.created_at desc)
                         from (select * from public.invite_codes order by created_at desc limit 50) c), '[]'::jsonb)
  );
$$;

-- Returns {status: ok|forbidden, settings?}. Owner or Admin may change settings; only an Owner may
-- switch the sign-up mode.
create function public.update_signup_settings(p_actor uuid, p_patch jsonb, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role public.staff_role := public._writer_role(p_actor);
  cur public.app_settings%rowtype;
  v_changes jsonb := coalesce(p_patch, '{}'::jsonb) - 'reason';
begin
  if v_role is null then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select * into cur from public.app_settings where id = 1 for update;
  if v_changes ? 'signupMode' and (v_changes ->> 'signupMode') is distinct from cur.signup_mode::text and v_role <> 'owner' then
    return jsonb_build_object('status', 'forbidden');
  end if;

  update public.app_settings set
    signup_mode = coalesce((v_changes ->> 'signupMode')::public.signup_mode, signup_mode),
    accept_invite_requests = coalesce((v_changes ->> 'acceptInviteRequests')::boolean, accept_invite_requests),
    signups_paused = coalesce((v_changes ->> 'signupsPaused')::boolean, signups_paused),
    member_invites_enabled = coalesce((v_changes ->> 'memberInvitesEnabled')::boolean, member_invites_enabled),
    member_invites_per_month = coalesce((v_changes ->> 'memberInvitesPerMonth')::integer, member_invites_per_month),
    invite_ttl_days = coalesce((v_changes ->> 'inviteTtlDays')::integer, invite_ttl_days),
    updated_at = now(),
    updated_by = p_actor
  where id = 1;

  perform public._audit(p_actor, 'signups.settings.update', 'app_settings',
    jsonb_build_object('changes', v_changes, 'reason', nullif(trim(p_reason), '')));
  return jsonb_build_object('status', 'ok', 'settings', public._settings_json());
end;
$$;

-- Revoke an unaccepted invite. Returns {status: ok|forbidden|not_found, invite?}.
create function public.revoke_invite(p_actor uuid, p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare i public.invites%rowtype;
begin
  if public._writer_role(p_actor) is null then
    return jsonb_build_object('status', 'forbidden');
  end if;
  update public.invites set revoked_at = now()
   where id = p_id and accepted_at is null and revoked_at is null
  returning * into i;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  perform public._audit(p_actor, 'invites.revoke', p_id::text);
  return jsonb_build_object('status', 'ok', 'invite', public._invite_json(i));
end;
$$;

-- Send an unaccepted, unrevoked invite again: new token (the old link stops working) and a fresh
-- expiry. Returns {status, invite?, email?, inviterName?}.
create function public.resend_invite(p_actor uuid, p_id uuid, p_token_hash bytea) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  i public.invites%rowtype;
  s public.app_settings%rowtype;
begin
  if public._writer_role(p_actor) is null then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select * into s from public.app_settings where id = 1;
  if s.signups_paused then
    return jsonb_build_object('status', 'signups_paused');
  end if;
  update public.invites
     set token_hash = p_token_hash, expires_at = now() + make_interval(days => s.invite_ttl_days)
   where id = p_id and accepted_at is null and revoked_at is null
  returning * into i;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  perform public._audit(p_actor, 'invites.resend', p_id::text);
  return jsonb_build_object(
    'status', 'ok',
    'invite', public._invite_json(i),
    'email', i.email::text,
    'inviterName', case when i.source = 'member' then (select p.display_name from public.profiles p where p.id = i.invited_by) end
  );
end;
$$;

-- Returns {status: ok|forbidden|conflict|invalid, code?}. No expiry given → 90 days.
create function public.create_invite_code(p_actor uuid, p_code text, p_label text, p_max_uses integer, p_expires_at timestamptz)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.invite_codes%rowtype;
begin
  if public._writer_role(p_actor) is null then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    return jsonb_build_object('status', 'invalid');
  end if;
  begin
    insert into public.invite_codes (code, label, max_uses, expires_at, created_by)
    values (upper(trim(p_code)), nullif(trim(p_label), ''), p_max_uses, coalesce(p_expires_at, now() + interval '90 days'), p_actor)
    returning * into c;
  exception
    when unique_violation then return jsonb_build_object('status', 'conflict');
    when check_violation then return jsonb_build_object('status', 'invalid');
  end;
  perform public._audit(p_actor, 'codes.create', c.id::text, jsonb_build_object('code', c.code::text, 'maxUses', c.max_uses));
  return jsonb_build_object('status', 'ok', 'code', public._code_json(c));
end;
$$;

create function public.revoke_invite_code(p_actor uuid, p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.invite_codes%rowtype;
begin
  if public._writer_role(p_actor) is null then
    return jsonb_build_object('status', 'forbidden');
  end if;
  update public.invite_codes set revoked_at = now() where id = p_id and revoked_at is null returning * into c;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  perform public._audit(p_actor, 'codes.revoke', p_id::text);
  return jsonb_build_object('status', 'ok', 'code', public._code_json(c));
end;
$$;

-- Approve or decline pending requests. Returns {status, approved: [{id, email}], declined}. The API
-- then creates and emails an invite for each approved email, and calls reopen_invite_request if
-- that fails, so a request is never approved without an invite going out.
create function public.decide_invite_requests(p_actor uuid, p_ids uuid[], p_decision text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_approved jsonb := '[]'::jsonb;
  v_declined integer := 0;
  r record;
begin
  if public._writer_role(p_actor) is null then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_decision not in ('approve', 'decline') then
    return jsonb_build_object('status', 'invalid');
  end if;
  for r in
    update public.invite_requests
       set status = case when p_decision = 'approve' then 'approved' else 'declined' end::public.invite_request_status,
           decided_at = now(), decided_by = p_actor
     where id = any (p_ids) and status = 'pending'
    returning id, email::text as email
  loop
    perform public._audit(p_actor, 'requests.' || p_decision, r.id::text);
    if p_decision = 'approve' then
      v_approved := v_approved || jsonb_build_object('id', r.id, 'email', r.email);
    else
      v_declined := v_declined + 1;
    end if;
  end loop;
  return jsonb_build_object('status', 'ok', 'approved', v_approved, 'declined', v_declined);
end;
$$;

create function public.reopen_invite_request(p_actor uuid, p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.invite_requests set status = 'pending', decided_at = null, decided_by = null
   where id = p_id and status = 'approved';
  if found then
    perform public._audit(p_actor, 'requests.reopen', p_id::text, jsonb_build_object('why', 'invite email failed'));
  end if;
end;
$$;

-- Newest first, keyset-paginated. p_status: pending | accepted | expired | revoked | null (all).
-- Returns {items, nextCursor}.
create function public.list_invites(p_status text, p_cursor text, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_at timestamptz;
  v_id uuid;
  n integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  items jsonb := '[]'::jsonb;
  k integer := 0;
  last_key text;
  r public.invites%rowtype;
begin
  select c.at, c.id into v_at, v_id from public._parse_cursor(p_cursor) c;
  for r in
    select i.* from public.invites i
     where (p_status is null or p_status = '' or public._invite_status(i) = p_status)
       and (v_at is null or (i.created_at, i.id) < (v_at, v_id))
     order by i.created_at desc, i.id desc
     limit n + 1
  loop
    k := k + 1;
    exit when k > n;
    items := items || jsonb_build_array(public._invite_json(r));
    last_key := r.created_at::text || '|' || r.id::text;
  end loop;
  return jsonb_build_object('items', items, 'nextCursor', case when k > n then last_key end);
end;
$$;

-- Newest first, keyset-paginated. p_status: pending | approved | declined | null (all).
create function public.list_invite_requests(p_status text, p_cursor text, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_at timestamptz;
  v_id uuid;
  n integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  items jsonb := '[]'::jsonb;
  k integer := 0;
  last_key text;
  r public.invite_requests%rowtype;
begin
  select c.at, c.id into v_at, v_id from public._parse_cursor(p_cursor) c;
  for r in
    select q.* from public.invite_requests q
     where (p_status is null or p_status = '' or q.status::text = p_status)
       and (v_at is null or (q.created_at, q.id) < (v_at, v_id))
     order by q.created_at desc, q.id desc
     limit n + 1
  loop
    k := k + 1;
    exit when k > n;
    items := items || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'email', r.email::text, 'useCase', r.use_case, 'disposable', r.disposable,
      'status', r.status, 'createdAt', r.created_at));
    last_key := r.created_at::text || '|' || r.id::text;
  end loop;
  return jsonb_build_object('items', items, 'nextCursor', case when k > n then last_key end);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: nothing here is reachable from the browser; the API (service_role) calls the public
-- entry points. Internal helpers (_*) are callable by no role but their owner.
-- ---------------------------------------------------------------------------------------------
revoke all on public.rate_limit_attempts from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on function
  public._invite_status(public.invites),
  public._invite_by_label(public.invites),
  public._invite_json(public.invites),
  public._code_json(public.invite_codes),
  public._settings_json(),
  public._writer_role(uuid),
  public._audit(uuid, text, text, jsonb),
  public._parse_cursor(text)
from service_role;
grant execute on function
  public.rate_limit_hit(text, bytea, integer, integer),
  public.rate_limit_count(text, bytea, integer),
  public.rate_limit_record(text, bytea),
  public.purge_invite_requests(),
  public.user_id_by_email(text),
  public.account_kind(text),
  public.is_staff(uuid),
  public.staff_lookup(uuid),
  public.get_session_profile(uuid),
  public.update_display_name(uuid, text),
  public.create_invite(text, bytea, public.invite_source, uuid, uuid, text),
  public.preview_invite(bytea),
  public.mark_invite_accepted(uuid),
  public.redeem_invite_code(text, text, bytea),
  public.list_member_invites(uuid),
  public.get_signup_overview(),
  public.update_signup_settings(uuid, jsonb, text),
  public.revoke_invite(uuid, uuid),
  public.resend_invite(uuid, uuid, bytea),
  public.create_invite_code(uuid, text, text, integer, timestamptz),
  public.revoke_invite_code(uuid, uuid),
  public.decide_invite_requests(uuid, uuid[], text),
  public.reopen_invite_request(uuid, uuid),
  public.list_invites(text, text, integer),
  public.list_invite_requests(text, text, integer)
to service_role;
