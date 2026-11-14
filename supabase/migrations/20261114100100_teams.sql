-- Phase 7: Studio team libraries. A teammate keeps their own library and switches into the owner's. All library
-- data stays keyed by owner_id (the library owner); the API resolves the acting library per request with
-- library_access and passes the owner's id to the existing functions. See docs/phase-7.md.
--
-- Seats: used = owner + members + open invites (not expired). A member is suspended (no access, still listed)
-- when their place by added_at is beyond the plan's seats − 1, or the owner's plan has 1 seat, or the owner's
-- account is deleted or scheduled for deletion.
-- Lock order: team lock (zephyr:team:<owner>) → team-member lock (zephyr:team-member:<member>) → invite email lock.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
-- A team name goes into invite emails sent to any address, so it's held to a strict pattern: letters, the digits
-- 0-9, spaces and . , ' & - only, and nothing that reads as an address or a link: no "://", no "www.", and a dot
-- only before a space, one of those marks or the end. Stored names are NFKC-normalised (lookalikes such as
-- fullwidth "@" or Roman-numeral letters are judged as what they become). isSafeLabel in packages/shared is
-- the same rule; supabase/tests/80_teams_test.sql and the shared tests check one list of names against both.
create function public._safe_label(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and p = normalize(p, NFKC) and length(p) between 1 and 60
     and p ~ '^[[:alpha:]0-9 .,''&-]+$'
     and p !~* '(www\.|://|\.[^[:space:].,''&-])';
$$;

create table public.teams (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  name text not null check (public._safe_label(name)),
  updated_at timestamptz not null default now()
);
alter table public.teams enable row level security;

create table public.library_members (
  owner_id uuid not null references auth.users (id) on delete cascade,
  member_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('editor', 'viewer')),
  -- Ever had Editor access in this library (so could open gallery links): the Team page warns on removal.
  had_editor boolean not null default false,
  added_at timestamptz not null default now(),
  added_by uuid references auth.users (id) on delete set null,
  primary key (owner_id, member_id),
  check (owner_id <> member_id)
);
create index library_members_member on public.library_members (member_id);
alter table public.library_members enable row level security;

create table public.team_invites (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  invite_id uuid not null unique references public.invites (id) on delete cascade,
  role text not null check (role in ('editor', 'viewer')),
  created_at timestamptz not null default now()
);
create index team_invites_owner on public.team_invites (owner_id, created_at desc);
alter table public.team_invites enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------------------------
create function public._lock_team(p_owner uuid) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('zephyr:team:' || p_owner::text, 0));
$$;

create function public._lock_team_member(p_member uuid) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('zephyr:team-member:' || p_member::text, 0));
$$;

-- A library owner's name as teammates and invitees see it: the display name, never any part of the email
-- address (members, Viewers and anyone holding an invite link see it). 'Studio owner' when there's none.
create function public._owner_name(p_user uuid) returns text
language sql stable set search_path = '' as $$
  select coalesce((select nullif(btrim(p.display_name), '') from public.profiles p where p.id = p_user), 'Studio owner');
$$;

-- The member's own name for their own library (their own address is theirs to see).
create function public._self_name(p_user uuid) returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(btrim(p.display_name), ''), nullif(split_part(u.email, '@', 1), ''), 'My library')
    from auth.users u left join public.profiles p on p.id = u.id where u.id = p_user;
$$;

-- The team's name: set by the owner, else "<display name>'s Studio", else 'Studio team'.
create function public._team_name(p_owner uuid) returns text
language sql stable set search_path = '' as $$
  select coalesce((select t.name from public.teams t where t.owner_id = p_owner),
                  (select left(nullif(btrim(p.display_name), '') || '''s Studio', 60) from public.profiles p where p.id = p_owner),
                  'Studio team');
$$;

-- "Tan Studio" → "TS"; "mei" → "M".
create function public._initials(p_name text) returns text
language sql immutable set search_path = '' as $$
  select upper(coalesce(string_agg(left(w, 1), '' order by n), '?'))
    from (select w, n from regexp_split_to_table(btrim(coalesce(p_name, '')), '\s+') with ordinality x(w, n)
           where w <> '' and w ~ '^[[:alnum:]]' order by n limit 2) words;
$$;

-- True while the owner's team can be used: account live, not scheduled for deletion.
create function public._team_owner_ok(p_owner uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = p_owner and p.deleted_at is null and p.deletion_due is null);
$$;

-- True while a team invite can still be used: the owner's team is usable and the plan has team seats.
-- SECURITY DEFINER so the sign-up hook (supabase_auth_admin) can call it without reading team tables.
create function public._team_invite_usable(p_invite uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.team_invites ti join public.profiles pr on pr.id = ti.owner_id
                  where ti.invite_id = p_invite and public._team_owner_ok(ti.owner_id) and public._plan_seats(pr.plan_id) > 1);
$$;

-- Revokes every open team invite of the owner (team no longer usable: deletion scheduled, purge, seats gone).
create function public._team_revoke_open_invites(p_owner uuid) returns integer
language plpgsql volatile set search_path = '' as $$
declare n integer;
begin
  update public.invites i set revoked_at = now()
    from public.team_invites ti
   where ti.owner_id = p_owner and i.id = ti.invite_id and i.accepted_at is null and i.revoked_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Live galleries in the owner's library (links an Editor could have opened and copied).
create function public._live_galleries(p_owner uuid) returns integer
language sql stable set search_path = '' as $$
  select count(*)::integer from public.galleries g
   where g.owner_id = p_owner and public._gallery_status(g) in ('live', 'paused');
$$;

-- Each member with their place and whether they're suspended.
create function public._team_members(p_owner uuid,
  out member_id uuid, out role text, out added_at timestamptz, out suspended boolean)
returns setof record
language sql stable set search_path = '' as $$
  select m.member_id, m.role, m.added_at,
         not public._team_owner_ok(p_owner)
           or row_number() over (order by m.added_at, m.member_id) > public._plan_seats(pr.plan_id) - 1
    from public.library_members m join public.profiles pr on pr.id = m.owner_id
   where m.owner_id = p_owner;
$$;

create function public._team_open_invites(p_owner uuid) returns integer
language sql stable set search_path = '' as $$
  select count(*)::integer from public.team_invites ti join public.invites i on i.id = ti.invite_id
   where ti.owner_id = p_owner and i.accepted_at is null and i.revoked_at is null and i.expires_at > now();
$$;

create function public._team_used(p_owner uuid) returns integer
language sql stable set search_path = '' as $$
  select 1 + (select count(*)::integer from public.library_members m where m.owner_id = p_owner) + public._team_open_invites(p_owner);
$$;

create function public._team_invite_json(ti public.team_invites) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', ti.id, 'email', i.email::text, 'role', ti.role, 'createdAt', i.created_at, 'expiresAt', i.expires_at)
    from public.invites i where i.id = ti.invite_id;
$$;

-- Team (TS type), or null for an unknown owner.
create function public._team_json(p_owner uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'name', public._team_name(p_owner),
    'seats', public._plan_seats(pr.plan_id),
    'used', public._team_used(p_owner),
    'members', jsonb_build_array(jsonb_build_object('userId', pr.id, 'email', u.email, 'displayName', pr.display_name,
                                                    'role', 'owner', 'addedAt', pr.created_at, 'suspended', false,
                                                    'liveGalleries', 0))
               || coalesce((select jsonb_agg(jsonb_build_object('userId', tm.member_id, 'email', mu.email, 'displayName', mp.display_name,
                                                               'role', tm.role, 'addedAt', tm.added_at, 'suspended', tm.suspended,
                                                               'liveGalleries', case when lm.had_editor then lg.n else 0 end)
                                             order by tm.added_at, tm.member_id)
                              from public._team_members(p_owner) tm
                              join public.library_members lm on lm.owner_id = p_owner and lm.member_id = tm.member_id
                              join auth.users mu on mu.id = tm.member_id
                              left join public.profiles mp on mp.id = tm.member_id
                              cross join (select public._live_galleries(p_owner) as n) lg), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(public._team_invite_json(ti) order by ti.created_at)
                           from public.team_invites ti join public.invites i on i.id = ti.invite_id
                          where ti.owner_id = p_owner and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()), '[]'::jsonb),
    'available', public._plan_seats(pr.plan_id) > 1)
  from public.profiles pr join auth.users u on u.id = pr.id
  where pr.id = p_owner;
$$;

-- Adds a member under the team lock (taken by the caller). 'added' | 'already' | 'limit_reached' | 'too_many_teams'.
-- p_invite_counted: the invite being accepted already holds a seat.
create function public._team_join(p_owner uuid, p_member uuid, p_role text, p_by uuid, p_invite_counted boolean) returns text
language plpgsql volatile set search_path = '' as $$
declare
  seats integer := public._plan_seats((select p.plan_id from public.profiles p where p.id = p_owner));
  extra integer := (not coalesce(p_invite_counted, false))::integer;
begin
  perform public._lock_team_member(p_member);
  if exists (select 1 from public.library_members where owner_id = p_owner and member_id = p_member) then return 'already'; end if;
  if public._team_used(p_owner) + extra > seats or seats <= 1 then
    return 'limit_reached';
  end if;
  if (select count(*) from public.library_members where member_id = p_member) >= 10 then return 'too_many_teams'; end if;
  insert into public.library_members (owner_id, member_id, role, added_by, had_editor)
  values (p_owner, p_member, p_role, p_by, p_role = 'editor');
  return 'added';
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Library context
-- ---------------------------------------------------------------------------------------------
-- What p_member may do in p_owner's library: {ownerId, role, plan, state, self}, or null (unknown, removed,
-- suspended, or the owner's account deleted or scheduled for deletion). Called on every library-scoped request.
create function public.library_access(p_member uuid, p_owner uuid) returns jsonb
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
  select * into tm from public._team_members(p_owner) x where x.member_id = p_member;
  if not found or tm.suspended then return null; end if;
  return jsonb_build_object('ownerId', p_owner, 'role', tm.role, 'plan', pr.plan_id,
                            'state', public._library_state(p_owner), 'self', false);
end;
$$;

-- LibrariesResult.libraries: the member's own library first, then usable team libraries by name.
create function public.list_libraries(p_member uuid) returns jsonb
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
               where m.member_id = p_member
                 and not coalesce((select tm.suspended from public._team_members(m.owner_id) tm where tm.member_id = p_member), true)
            ) x), '[]'::jsonb)
  from public.profiles pr where pr.id = p_member and pr.deleted_at is null), '[]'::jsonb);
$$;

-- ---------------------------------------------------------------------------------------------
-- Team (owner)
-- ---------------------------------------------------------------------------------------------
create function public.team_get(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$ select public._team_json(p_owner) $$;

create function public.team_set_name(p_owner uuid, p_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare n text := nullif(btrim(normalize(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g'), NFKC)), '');
begin
  if n is null or not public._safe_label(n) then return jsonb_build_object('error', 'invalid'); end if;
  if not exists (select 1 from public.profiles where id = p_owner and deleted_at is null) then return null; end if;
  insert into public.teams (owner_id, name) values (p_owner, n)
  on conflict (owner_id) do update set name = excluded.name, updated_at = now();
  return public._team_json(p_owner);
end;
$$;

-- Invites p_email to the owner's team. p_token_hash: SHA-256 of a 256-bit token (the raw token is only in the email).
-- {invite: TeamInvite, existingAccount, teamName, ownerName}
-- | {error: 'plan_required' | 'limit_reached' (no seat, or the invitee is in 10 teams) | 'already_member' (a member, an open
--    invite, or the owner's own address) | 'not_found' (bad input, or the owner can't invite: deleted or pending deletion)}.
create function public.team_invite_create(p_owner uuid, p_email text, p_role text, p_token_hash bytea) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  pr public.profiles;
  existing uuid;
  inv uuid;
  ti public.team_invites;
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email) > 254
     or p_role not in ('editor', 'viewer') or p_token_hash is null or length(p_token_hash) <> 32 then
    return jsonb_build_object('error', 'not_found');
  end if;
  perform public._lock_team(p_owner);
  select * into pr from public.profiles where id = p_owner and deleted_at is null and deletion_due is null;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if public._plan_seats(pr.plan_id) <= 1 then return jsonb_build_object('error', 'plan_required'); end if;
  if lower((select u.email from auth.users u where u.id = p_owner)) = v_email then
    return jsonb_build_object('error', 'already_member');
  end if;
  select u.id into existing from auth.users u where lower(u.email) = v_email;
  if (existing is not null and exists (select 1 from public.library_members m where m.owner_id = p_owner and m.member_id = existing))
     or exists (select 1 from public.team_invites t join public.invites i on i.id = t.invite_id
                 where t.owner_id = p_owner and lower(i.email::text) = v_email
                   and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()) then
    return jsonb_build_object('error', 'already_member');
  end if;
  if public._team_used(p_owner) >= public._plan_seats(pr.plan_id) then
    return jsonb_build_object('error', 'limit_reached');
  end if;
  -- At most 30 team invites a calendar month (UTC): stops invite → sign up → remove cycles minting accounts
  -- while sign-ups are invite-only.
  if (select count(*) from public.team_invites t
       where t.owner_id = p_owner and t.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc') >= 30 then
    return jsonb_build_object('error', 'limit_reached');
  end if;
  if existing is not null and (select count(*) from public.library_members m where m.member_id = existing) >= 10 then
    return jsonb_build_object('error', 'limit_reached');
  end if;
  insert into public.invites (email, token_hash, source, invited_by, expires_at)
  values (v_email, p_token_hash, 'team', p_owner, now() + interval '7 days') returning id into inv;
  insert into public.team_invites (owner_id, invite_id, role) values (p_owner, inv, p_role) returning * into ti;
  perform public._audit(p_owner, 'team.invite_created', ti.id::text, jsonb_build_object('role', p_role));
  return jsonb_build_object('invite', public._team_invite_json(ti), 'existingAccount', existing is not null,
                            'teamName', public._team_name(p_owner), 'ownerName', public._owner_name(p_owner));
end;
$$;

-- Revokes a pending team invite. True, or false when there's no such pending invite.
create function public.team_invite_revoke(p_owner uuid, p_id uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._lock_team(p_owner);
  update public.invites i set revoked_at = now()
    from public.team_invites ti
   where ti.id = p_id and ti.owner_id = p_owner and i.id = ti.invite_id and i.accepted_at is null and i.revoked_at is null;
  return found;
end;
$$;

-- Resends: a new token and 7 more days (a lapsed invite needs a free seat again).
-- {invite, email, existingAccount, teamName, ownerName} | {error: 'not_found' | 'plan_required' | 'limit_reached'}.
create function public.team_invite_resend(p_owner uuid, p_id uuid, p_token_hash bytea) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  ti public.team_invites;
  i public.invites;
begin
  if p_token_hash is null or length(p_token_hash) <> 32 then return jsonb_build_object('error', 'not_found'); end if;
  perform public._lock_team(p_owner);
  select * into ti from public.team_invites where id = p_id and owner_id = p_owner;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  select * into i from public.invites where id = ti.invite_id and accepted_at is null and revoked_at is null for update;
  if not found or not public._team_owner_ok(p_owner) then return jsonb_build_object('error', 'not_found'); end if;
  if public._plan_seats((select p.plan_id from public.profiles p where p.id = p_owner)) <= 1 then
    return jsonb_build_object('error', 'plan_required');
  end if;
  if i.expires_at <= now() and public._team_used(p_owner) >= public._plan_seats((select p.plan_id from public.profiles p where p.id = p_owner)) then
    return jsonb_build_object('error', 'limit_reached');
  end if;
  update public.invites set token_hash = p_token_hash, expires_at = now() + interval '7 days' where id = i.id returning * into i;
  return jsonb_build_object('invite', public._team_invite_json(ti), 'email', i.email::text,
                            'existingAccount', exists (select 1 from auth.users u where lower(u.email) = lower(i.email::text)),
                            'teamName', public._team_name(p_owner), 'ownerName', public._owner_name(p_owner));
end;
$$;

-- TeamInvitePreview for a usable invite, or null (never says why).
create function public.team_invite_preview(p_token_hash bytea) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'teamName', public._team_name(ti.owner_id),
    'ownerName', public._owner_name(ti.owner_id),
    'role', ti.role,
    'emailHint', left(split_part(i.email::text, '@', 1), 1) || '•••@' || split_part(i.email::text, '@', 2),
    'needsAccount', not exists (select 1 from auth.users u where lower(u.email) = lower(i.email::text)))
  from public.invites i join public.team_invites ti on ti.invite_id = i.id
  where i.token_hash = p_token_hash and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
    and public._team_invite_usable(i.id)
    and (exists (select 1 from auth.users u where lower(u.email) = lower(i.email::text))
         or not (select s.signups_paused from public.app_settings s where s.id = 1));
$$;

-- A signed-in member accepts an invite sent to their address.
-- {ownerId, joined (false when already a member)} | {error: 'invite_invalid' | 'limit_reached' (no seat, or already in 10 teams)}.
create function public.team_invite_accept(p_member uuid, p_email text, p_token_hash bytea) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  i public.invites;
  ti public.team_invites;
  res text;
begin
  select * into i from public.invites where token_hash = p_token_hash;
  if not found then return jsonb_build_object('error', 'invite_invalid'); end if;
  select * into ti from public.team_invites where invite_id = i.id;
  if not found or lower(i.email::text) <> lower(btrim(coalesce(p_email, ''))) or ti.owner_id = p_member
     or not exists (select 1 from auth.users u where u.id = p_member and lower(u.email) = lower(i.email::text)) then
    return jsonb_build_object('error', 'invite_invalid');
  end if;
  perform public._lock_team(ti.owner_id);
  select * into i from public.invites where id = i.id for update;
  if i.revoked_at is not null or not public._team_invite_usable(i.id) then return jsonb_build_object('error', 'invite_invalid'); end if;
  if exists (select 1 from public.library_members m where m.owner_id = ti.owner_id and m.member_id = p_member) then
    update public.invites set accepted_at = coalesce(accepted_at, now()) where id = i.id;
    return jsonb_build_object('ownerId', ti.owner_id, 'joined', false);
  end if;
  if i.accepted_at is not null or i.expires_at <= now() then return jsonb_build_object('error', 'invite_invalid'); end if;
  res := public._team_join(ti.owner_id, p_member, ti.role, ti.owner_id, true);
  if res not in ('added', 'already') then return jsonb_build_object('error', 'limit_reached'); end if;
  update public.invites set accepted_at = now() where id = i.id;
  perform public._audit(p_member, 'team.joined', ti.owner_id::text, jsonb_build_object('role', ti.role));
  return jsonb_build_object('ownerId', ti.owner_id, 'joined', res = 'added');
end;
$$;

-- True, or false when they aren't a member (or the role is bad).
create function public.team_member_set_role(p_owner uuid, p_member uuid, p_role text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_role is null or p_role not in ('editor', 'viewer') then return false; end if;
  perform public._lock_team(p_owner);
  update public.library_members set role = p_role, had_editor = had_editor or p_role = 'editor'
   where owner_id = p_owner and member_id = p_member;
  if not found then return false; end if;
  perform public._audit(p_owner, 'team.role_changed', p_member::text, jsonb_build_object('role', p_role));
  return true;
end;
$$;

-- Removes a member (their access ends at once). True, or false when they weren't a member.
create function public.team_member_remove(p_owner uuid, p_member uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._lock_team(p_owner);
  delete from public.library_members where owner_id = p_owner and member_id = p_member;
  if not found then return false; end if;
  perform public._audit(p_owner, 'team.member_removed', p_member::text, '{}'::jsonb);
  return true;
end;
$$;

-- A teammate leaves a team library. True, or false when they weren't a member.
create function public.team_leave(p_member uuid, p_owner uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._lock_team(p_owner);
  delete from public.library_members where owner_id = p_owner and member_id = p_member;
  if not found then return false; end if;
  perform public._audit(p_member, 'team.left', p_owner::text, '{}'::jsonb);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Invites (phase 1/2 functions): team invites in the admin list, and new accounts joining their teams.
-- ---------------------------------------------------------------------------------------------
create or replace function public._invite_by_label(i public.invites) returns text
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
    when 'team' then coalesce(public._team_name(i.invited_by), 'A Studio team') || ' · Team'
    else 'Invite request'
  end;
$$;

-- Confirming an account consumes every live invite for its email (phase 2); live team invites first add the
-- new account to those teams (when a seat is still free).
create or replace function public.handle_user_confirmed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t record;
  live public.invites;
begin
  for t in select ti.owner_id, ti.role, ti.invite_id from public.team_invites ti join public.invites i on i.id = ti.invite_id
            where lower(i.email::text) = lower(new.email) and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
            -- One lock order everywhere (by owner id): two accounts confirming at once can't deadlock.
            order by ti.owner_id loop
    perform public._lock_team(t.owner_id);
    -- Read again under the team lock: the owner may have revoked it (or the team stopped being usable) meanwhile.
    select * into live from public.invites
     where id = t.invite_id and accepted_at is null and revoked_at is null and expires_at > now() for update;
    if found and public._team_invite_usable(t.invite_id) then
      perform public._team_join(t.owner_id, new.id, t.role, t.owner_id, true);
    end if;
  end loop;

  update public.invites
     set accepted_at = now()
   where lower(email::text) = lower(new.email)
     and accepted_at is null and revoked_at is null and expires_at > now();

  update public.invite_requests
     set status = 'approved', decided_at = coalesce(decided_at, now())
   where lower(email::text) = lower(new.email) and status = 'pending';

  return new;
end;
$$;
revoke execute on function public.handle_user_confirmed() from public, anon, authenticated;

-- A team invite link opened on the phase-1 sign-up page (/join): only while the team is usable, and never with
-- the full address (the link may have been forwarded). The API keeps `email` for redeem and shows `emailHint`.
create or replace function public.preview_invite(p_token_hash bytea) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', i.id,
    'email', i.email::text,
    'emailHint', left(split_part(i.email::text, '@', 1), 1) || '•••@' || split_part(i.email::text, '@', 2),
    'source', i.source,
    'inviterName', case i.source
                     when 'member' then (select p.display_name from public.profiles p where p.id = i.invited_by)
                     when 'team' then public._team_name(i.invited_by)
                   end,
    'expiresAt', i.expires_at
  )
  from public.invites i, public.app_settings s
  where i.token_hash = p_token_hash
    and s.id = 1 and not s.signups_paused
    and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
    and (i.source <> 'team' or public._team_invite_usable(i.id));
$$;

-- Invite-only sign-ups: a team invite only counts while its team is usable.
create or replace function public.hook_before_user_created(event jsonb) returns jsonb
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
        and (i.source <> 'team' or public._team_invite_usable(i.id))
    ) then
      return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Zephyr is invite-only right now.'));
    end if;
  end if;

  return '{}'::jsonb;
end;
$$;

-- Open team invites die with the team: when the owner's deletion is scheduled, the account is deleted, or the
-- plan no longer has team seats (any writer of profiles: billing_apply, admin overrides, deletion).
create function public._team_profile_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not public._team_owner_ok(new.id) or public._plan_seats(new.plan_id) <= 1 then
    perform public._team_revoke_open_invites(new.id);
  end if;
  return null;
end;
$$;
create trigger profiles_team_guard after update of plan_id, deletion_due, deleted_at on public.profiles
  for each row when (new.plan_id is distinct from old.plan_id or new.deletion_due is distinct from old.deletion_due
                     or new.deleted_at is distinct from old.deleted_at)
  execute function public._team_profile_guard();

-- The owner's account purged (team_invites cascade): the phase-1 invites row must not stay live.
create function public._team_invite_gone() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.invites set revoked_at = now() where id = old.invite_id and accepted_at is null and revoked_at is null;
  return old;
end;
$$;
create trigger team_invites_revoke_on_delete before delete on public.team_invites
  for each row execute function public._team_invite_gone();

-- ---------------------------------------------------------------------------------------------
-- Privileges: service_role only. Internal helpers (_*) are callable by no role but their owner.
-- ---------------------------------------------------------------------------------------------
revoke all on public.teams, public.library_members, public.team_invites from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on function
  public._lock_team(uuid),
  public._lock_team_member(uuid),
  public._safe_label(text),
  public._owner_name(uuid),
  public._self_name(uuid),
  public._team_name(uuid),
  public._team_revoke_open_invites(uuid),
  public._live_galleries(uuid),
  public._team_profile_guard(),
  public._team_invite_gone(),
  public._initials(text),
  public._team_owner_ok(uuid),
  public._team_members(uuid),
  public._team_open_invites(uuid),
  public._team_used(uuid),
  public._team_invite_json(public.team_invites),
  public._team_json(uuid),
  public._team_join(uuid, uuid, text, uuid, boolean)
from service_role;
grant execute on function
  public.library_access(uuid, uuid),
  public.list_libraries(uuid),
  public.team_get(uuid),
  public.team_set_name(uuid, text),
  public.team_invite_create(uuid, text, text, bytea),
  public.team_invite_revoke(uuid, uuid),
  public.team_invite_resend(uuid, uuid, bytea),
  public.team_invite_preview(bytea),
  public.team_invite_accept(uuid, text, bytea),
  public.team_member_set_role(uuid, uuid, text),
  public.team_member_remove(uuid, uuid),
  public.team_leave(uuid, uuid)
to service_role;
-- The sign-up hook (supabase_auth_admin) checks team invites through this one function.
revoke execute on function public._team_invite_usable(uuid) from service_role;
grant execute on function public._team_invite_usable(uuid) to supabase_auth_admin;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
