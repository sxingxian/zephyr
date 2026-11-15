-- Phase 8 (review round 4): account-level changes complete only from a link emailed to the account.
--
-- Google's AdSense script runs inside Free members' library pages (the Owner accepted that risk; see
-- docs/security.md item 18) and acts with the member's session. So neither "signed in within 10 minutes" nor a
-- code typed into the app proves the member asked for a change: the script can call the API itself, and it can
-- draw a convincing code prompt on the real domain. Adding or removing a passkey, and deleting the account, are
-- therefore only *requested* from Settings. The API emails a single-use link to the account; the change is made on
-- the page that link opens (a fresh document the script isn't in), carrying the link's token. A passkey created
-- there comes from the member's own authenticator, so even a link the script asked for gives it nothing.
--
-- The API stores only HMAC(server secret, token): the table holds nothing a reader could turn back into a link.
-- One row per link: bound to one member, one change and (passkey_remove) one passkey; 15 minutes; single use; a
-- newer link for the same member and change replaces older ones. passkey_add spends the link on the options call
-- and leaves a grant tied to that registration challenge, which the verify call must present.

create table public.account_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  op text not null check (op in ('passkey_add', 'passkey_remove', 'account_delete')),
  passkey_id text check (passkey_id is null or passkey_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  token_hash bytea not null unique check (length(token_hash) = 32),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  grant_hash bytea check (grant_hash is null or length(grant_hash) = 32),
  grant_expires_at timestamptz,
  check ((op = 'passkey_remove') = (passkey_id is not null))
);
create index account_actions_user_op on public.account_actions (user_id, op, created_at);
alter table public.account_actions enable row level security;
revoke all on public.account_actions from public, anon, authenticated;

-- Stores a new link for (member, change[, passkey]) and retires the member's earlier open links for that change.
-- 'ok', 'rate_limited' (5 an hour or 10 a day per change) or 'invalid' (unknown change, a passkey id with the wrong
-- change or a malformed one, a malformed hash, or no such member). Rows older than two days are forgotten here, so
-- the table stays small without a job.
create function public.account_action_issue(p_user uuid, p_op text, p_passkey text, p_hash bytea) returns text
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_op is null or p_op not in ('passkey_add', 'passkey_remove', 'account_delete')
     or (p_op = 'passkey_remove') is distinct from (p_passkey is not null)
     or (p_passkey is not null and p_passkey !~ '^[A-Za-z0-9_-]{1,100}$')
     or p_hash is null or length(p_hash) <> 32
     or not exists (select 1 from auth.users u where u.id = p_user) then
    return 'invalid';
  end if;
  -- One member's links are issued one at a time, so the counts below can't be raced past.
  perform pg_advisory_xact_lock(hashtextextended('zephyr:account_action:' || p_user::text, 0));
  delete from public.account_actions where user_id = p_user and created_at < now() - interval '2 days';
  if (select count(*) from public.account_actions
       where user_id = p_user and op = p_op and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.account_actions
          where user_id = p_user and op = p_op and created_at > now() - interval '1 day') >= 10 then
    return 'rate_limited';
  end if;
  update public.account_actions set expires_at = least(expires_at, now())
   where user_id = p_user and op = p_op and used_at is null and expires_at > now();
  insert into public.account_actions (user_id, op, passkey_id, token_hash, expires_at)
  values (p_user, p_op, p_passkey, p_hash, now() + interval '15 minutes');
  return 'ok';
end;
$$;

-- What a link will do, without spending it: { op, passkeyId, expiresAt } for an open link of this member,
-- { error: 'wrong_member' } for an open link of someone else, null otherwise (unknown, expired, used, replaced).
create function public.account_action_peek(p_user uuid, p_hash bytea) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when a.user_id = p_user
              then jsonb_build_object('op', a.op, 'passkeyId', a.passkey_id, 'expiresAt', a.expires_at)
              else jsonb_build_object('error', 'wrong_member') end
    from public.account_actions a
   where p_hash is not null and length(p_hash) = 32 and a.token_hash = p_hash
     and a.used_at is null and a.expires_at > now();
$$;

-- Spends a link: 'ok' once, for an open link of this member, for this change and (passkey_remove) this passkey;
-- 'wrong_member' for someone else's open link (not spent); otherwise 'invalid'. With p_grant (passkey_add), a
-- successful spend also records a 10-minute grant: the hash of the registration challenge.
create function public.account_action_use(p_user uuid, p_op text, p_passkey text, p_hash bytea, p_grant bytea)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.account_actions;
begin
  if p_hash is null or length(p_hash) <> 32 or (p_grant is not null and length(p_grant) <> 32) then
    return 'invalid';
  end if;
  select * into r from public.account_actions where token_hash = p_hash for update;
  if not found or r.used_at is not null or r.expires_at <= now() then return 'invalid'; end if;
  if r.user_id <> p_user then return 'wrong_member'; end if;
  if r.op is distinct from p_op or r.passkey_id is distinct from p_passkey then return 'invalid'; end if;
  update public.account_actions
     set used_at = now(), grant_hash = p_grant,
         grant_expires_at = case when p_grant is null then null else now() + interval '10 minutes' end
   where id = r.id;
  return 'ok';
end;
$$;

-- Spends the grant a passkey_add link left for this challenge (once, within 10 minutes, this member).
create function public.account_action_grant_use(p_user uuid, p_grant bytea) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_grant is null or length(p_grant) <> 32 then return false; end if;
  select id into v_id from public.account_actions
   where user_id = p_user and op = 'passkey_add' and grant_hash = p_grant and grant_expires_at > now()
   for update;
  if v_id is null then return false; end if;
  update public.account_actions set grant_hash = null, grant_expires_at = null where id = v_id;
  return true;
end;
$$;

revoke execute on function public.account_action_issue(uuid, text, text, bytea),
  public.account_action_peek(uuid, bytea), public.account_action_use(uuid, text, text, bytea, bytea),
  public.account_action_grant_use(uuid, bytea) from public, anon, authenticated;
grant execute on function public.account_action_issue(uuid, text, text, bytea),
  public.account_action_peek(uuid, bytea), public.account_action_use(uuid, text, text, bytea, bytea),
  public.account_action_grant_use(uuid, bytea) to service_role;
