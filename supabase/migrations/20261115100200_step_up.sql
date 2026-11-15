-- Phase 8 (review round 3): step-up codes for account-level changes while a member may be shown AdSense.
--
-- Google's AdSense script runs inside the app's own page for Free members (the Owner accepted that risk; see
-- docs/security.md item 18). It acts with the member's session, so "signed in within 10 minutes" isn't proof that
-- the member asked for something. Adding or removing a passkey, or deleting the account, therefore also needs a
-- one-time code emailed to the account (the script can't read the member's email), bound to that one operation.
--
-- The API computes every hash with a server-side secret (HMAC over member, operation and code), so the table holds
-- nothing a reader could turn back into a code. One row per member and operation:
--   code_hash / expires_at / attempts: the current code (10 minutes, single use, burnt after 5 wrong tries);
--   sends / window_start: at most 5 codes per operation an hour;
--   grant_hash / grant_expires_at: passkey_add only: the code was spent on the options call, and this grant ties
--   the verify call to the very challenge those options carried.

create table public.step_up_codes (
  user_id uuid not null references auth.users (id) on delete cascade,
  op text not null check (op in ('passkey_add', 'passkey_remove', 'account_delete')),
  code_hash bytea check (code_hash is null or length(code_hash) = 32),
  expires_at timestamptz,
  attempts smallint not null default 0 check (attempts >= 0),
  sends smallint not null default 0 check (sends >= 0),
  window_start timestamptz not null default now(),
  grant_hash bytea check (grant_hash is null or length(grant_hash) = 32),
  grant_expires_at timestamptz,
  primary key (user_id, op)
);
alter table public.step_up_codes enable row level security;
revoke all on public.step_up_codes from public, anon, authenticated;

-- Whether this member's account-level changes need a step-up code right now: their plan shows ads, and AdSense is
-- on or was switched in the last 30 minutes (a page that loaded Google's script before it was turned off keeps it
-- until it reloads). Deliberately wider than ads_for_member: team membership, suspension or the open library don't
-- matter here, so the script can't lift the requirement by changing them first.
create function public.step_up_needed(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles pr
                   join public.plan_limits pl on pl.plan_id = pr.plan_id
                   join public.plan_limit_versions v on v.id = pl.version_id and v.status = 'active'
                  where pr.id = p_user and pl.ads)
     and (coalesce((select (s.adsense ->> 'enabled')::boolean and s.adsense ->> 'publisherId' is not null
                      from public.app_settings s where s.id = 1), false)
          or coalesce((select a.created_at > now() - interval '30 minutes'
                         from public.audit_log a
                        where a.target = 'adsense' and a.action = 'ads.adsense'
                        order by a.id desc limit 1), false));
$$;

create function public._step_up_row(p_user uuid, p_op text) returns public.step_up_codes
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.step_up_codes;
begin
  insert into public.step_up_codes (user_id, op) values (p_user, p_op) on conflict do nothing;
  select * into r from public.step_up_codes where user_id = p_user and op = p_op for update;
  return r;
end;
$$;

-- Stores a new code for (member, operation), replacing any earlier one. 'ok', 'rate_limited' (5 an hour) or
-- 'invalid' (unknown operation, malformed hash or no such member).
create function public.step_up_issue(p_user uuid, p_op text, p_hash bytea) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.step_up_codes;
begin
  if p_op not in ('passkey_add', 'passkey_remove', 'account_delete') or p_hash is null or length(p_hash) <> 32
     or not exists (select 1 from auth.users u where u.id = p_user) then
    return 'invalid';
  end if;
  r := public._step_up_row(p_user, p_op);
  if r.window_start < now() - interval '1 hour' then
    r.sends := 0;
    r.window_start := now();
  end if;
  if r.sends >= 5 then
    update public.step_up_codes set sends = r.sends, window_start = r.window_start where user_id = p_user and op = p_op;
    return 'rate_limited';
  end if;
  update public.step_up_codes
     set code_hash = p_hash, expires_at = now() + interval '10 minutes', attempts = 0,
         sends = r.sends + 1, window_start = r.window_start
   where user_id = p_user and op = p_op;
  return 'ok';
end;
$$;

-- Spends the code for (member, operation): 'ok' once, for a matching, unexpired code; otherwise 'invalid' (wrong,
-- expired, already used, or never sent). A wrong code counts a try; the fifth burns the code. With p_grant, a
-- successful check also records a 10-minute grant (passkey_add: the hash of the registration challenge).
create function public.step_up_check(p_user uuid, p_op text, p_hash bytea, p_grant bytea default null) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.step_up_codes;
begin
  if p_op not in ('passkey_add', 'passkey_remove', 'account_delete') or p_hash is null or length(p_hash) <> 32
     or (p_grant is not null and length(p_grant) <> 32) then
    return 'invalid';
  end if;
  select * into r from public.step_up_codes where user_id = p_user and op = p_op for update;
  if not found or r.code_hash is null then return 'invalid'; end if;
  if r.expires_at is null or r.expires_at <= now() then
    update public.step_up_codes set code_hash = null, expires_at = null where user_id = p_user and op = p_op;
    return 'invalid';
  end if;
  if r.code_hash <> p_hash then
    update public.step_up_codes
       set attempts = r.attempts + 1,
           code_hash = case when r.attempts + 1 >= 5 then null else r.code_hash end,
           expires_at = case when r.attempts + 1 >= 5 then null else r.expires_at end
     where user_id = p_user and op = p_op;
    return 'invalid';
  end if;
  update public.step_up_codes
     set code_hash = null, expires_at = null, attempts = 0,
         grant_hash = p_grant, grant_expires_at = case when p_grant is null then null else now() + interval '10 minutes' end
   where user_id = p_user and op = p_op;
  return 'ok';
end;
$$;

-- Spends the grant a step_up_check left (once, within 10 minutes, for the same hash).
create function public.step_up_grant_use(p_user uuid, p_op text, p_grant bytea) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.step_up_codes;
begin
  if p_grant is null or length(p_grant) <> 32 then return false; end if;
  select * into r from public.step_up_codes where user_id = p_user and op = p_op for update;
  if not found or r.grant_hash is null or r.grant_hash <> p_grant or r.grant_expires_at is null
     or r.grant_expires_at <= now() then
    return false;
  end if;
  update public.step_up_codes set grant_hash = null, grant_expires_at = null where user_id = p_user and op = p_op;
  return true;
end;
$$;

revoke execute on function public.step_up_needed(uuid), public._step_up_row(uuid, text),
  public.step_up_issue(uuid, text, bytea), public.step_up_check(uuid, text, bytea, bytea),
  public.step_up_grant_use(uuid, text, bytea) from public, anon, authenticated;
revoke execute on function public._step_up_row(uuid, text) from service_role;
grant execute on function public.step_up_needed(uuid), public.step_up_issue(uuid, text, bytea),
  public.step_up_check(uuid, text, bytea, bytea), public.step_up_grant_use(uuid, text, bytea) to service_role;
