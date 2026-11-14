-- Assertions for the foundation schema. Run with supabase/tests/run-local.sh (local Postgres) or
-- paste into the SQL editor of a scratch Supabase project. Any failed check raises an exception.
\set ON_ERROR_STOP on
begin;

create function pg_temp.ok(cond boolean, what text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok - %', what;
end $$;
-- New functions aren't executable by PUBLIC (see the migration), so let the test roles use this helper.
grant execute on function pg_temp.ok(boolean, text) to public;

-- ---- Defaults ----------------------------------------------------------------------------------
select pg_temp.ok((select signup_mode = 'invite_only' from public.app_settings), 'Invite only is the default sign-up mode');
select pg_temp.ok((select count(*) = 3 from public.plan_limits pl join public.plan_limit_versions v on v.id = pl.version_id where v.status = 'active'), 'one active plan-limits version covering 3 plans');
select pg_temp.ok((select (get_public_config()->>'signupMode') = 'invite_only'), 'public config reports invite_only');

-- ---- RLS: every public table has RLS on ---------------------------------------------------------
select pg_temp.ok(
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
  'RLS is enabled on every public table');

-- ---- plan_limits guards -------------------------------------------------------------------------
do $$ begin
  begin
    insert into public.plan_limits (version_id, plan_id, storage_gb, cloud_credits_month, batch_size, file_types)
    values ((select id from public.plan_limit_versions where version = 1), 'free', 1, 1, 10, array['jpeg', 'svg']);
    raise exception 'FAILED: svg was accepted';
  exception when check_violation then raise notice 'ok - plan_limits rejects svg';
  end;
  begin
    update public.plan_limits set batch_size = 2001 where plan_id = 'pro';
    raise exception 'FAILED: batch 2001 accepted';
  exception when check_violation then raise notice 'ok - plan_limits rejects batch_size 2001';
  end;
end $$;

-- ---- Plan-limits versions (phase 8: the two-person rule became passkey + Owner emails) ---------
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'owner@zephyr.test');
do $$ begin
  begin
    insert into public.plan_limit_versions (version, status, reason) values (2, 'scheduled', 'No date');
    raise exception 'FAILED: scheduled without a date accepted';
  exception when check_violation then raise notice 'ok - a scheduled version needs an effective date';
  end;
  begin
    insert into public.plan_limit_versions (version, status, reason) values (2, 'pending', 'Unknown status');
    raise exception 'FAILED: unknown status accepted';
  exception when check_violation then raise notice 'ok - unknown version status rejected';
  end;
end $$;
insert into public.plan_limit_versions (version, status, reason, created_by)
  values (3, 'draft', 'Raise Pro storage', '00000000-0000-0000-0000-0000000000a1');
do $$ begin
  begin
    insert into public.plan_limit_versions (version, status, reason) values (4, 'draft', 'Second draft');
    raise exception 'FAILED: two drafts accepted';
  exception when unique_violation then raise notice 'ok - one draft at a time';
  end;
end $$;
delete from public.plan_limit_versions where version = 3;

-- ---- audit_log is append-only -------------------------------------------------------------------
insert into public.audit_log (actor, action, target) values (null, 'test.event', 'x');
do $$ begin
  begin
    update public.audit_log set action = 'tampered';
    raise exception 'FAILED: audit_log update allowed';
  exception when insufficient_privilege then raise notice 'ok - audit_log rejects UPDATE';
  end;
  begin
    delete from public.audit_log;
    raise exception 'FAILED: audit_log delete allowed';
  exception when insufficient_privilege then raise notice 'ok - audit_log rejects DELETE';
  end;
end $$;

-- ---- submit_invite_request ---------------------------------------------------------------------
select pg_temp.ok(submit_invite_request('a@example.com', 'portraits', extensions.digest('ip-1', 'sha256'), false) = 'accepted', 'first request accepted');
select pg_temp.ok(submit_invite_request('A@Example.com', null, extensions.digest('ip-2', 'sha256'), false) = 'accepted', 'duplicate (case-insensitive) returns the same accepted');
select pg_temp.ok((select count(*) = 1 from public.invite_requests where email = 'a@example.com'), 'duplicate did not create a second pending row');
select pg_temp.ok(submit_invite_request('owner@zephyr.test', null, extensions.digest('ip-3', 'sha256'), false) = 'accepted', 'an existing account email still gets accepted (no enumeration)');
select submit_invite_request('r' || g || '@example.com', null, extensions.digest('ip-rl', 'sha256'), false) from generate_series(1, 5) g;
select pg_temp.ok(submit_invite_request('r6@example.com', null, extensions.digest('ip-rl', 'sha256'), false) = 'rate_limited', '6th request from one network in 15 minutes is rate limited');
-- Duplicates count like new emails, so the limit can't reveal who is already on the list.
select submit_invite_request('a@example.com', null, extensions.digest('ip-dup', 'sha256'), false) from generate_series(1, 5) g;
select pg_temp.ok(submit_invite_request('fresh@example.com', null, extensions.digest('ip-dup', 'sha256'), false) = 'rate_limited', '5 duplicate requests still use up the limit (6th is rate limited)');
create function pg_temp.probe(target text, net text) returns text language plpgsql as $$
begin
  for i in 1..4 loop perform public.submit_invite_request(net || '-filler' || i || '@attacker.test', null, extensions.digest(net, 'sha256'), false); end loop;
  perform public.submit_invite_request(target, null, extensions.digest(net, 'sha256'), false);
  return public.submit_invite_request(net || '-check@attacker.test', null, extensions.digest(net, 'sha256'), false);
end $$;
select pg_temp.ok(pg_temp.probe('a@example.com', 'net-a') = pg_temp.probe('nobody@example.com', 'net-b'), 'the limit behaves the same for listed and unlisted emails');
select pg_temp.ok(submit_invite_request('other@example.com', null, extensions.digest('ip-4', 'sha256'), false) = 'accepted', 'another network is unaffected');
-- Daily cap: 20 per network per day, even spread over time.
insert into public.invite_request_attempts (ip_hash, created_at)
  select extensions.digest('ip-day', 'sha256'), now() - interval '2 hours' from generate_series(1, 20) g;
select pg_temp.ok(submit_invite_request('d21@example.com', null, extensions.digest('ip-day', 'sha256'), false) = 'rate_limited', '21st request from one network in a day is rate limited');
-- Global backstop: 500 attempts across all networks in a day.
insert into public.invite_request_attempts (ip_hash, created_at)
  select extensions.digest('net-' || g, 'sha256'), now() - interval '3 hours' from generate_series(1, 500) g;
select pg_temp.ok(submit_invite_request('late@example.com', null, extensions.digest('ip-new', 'sha256'), false) = 'rate_limited', 'over 500 attempts a day in total → rate limited for everyone');
delete from public.invite_request_attempts where created_at < now() - interval '150 minutes';
select pg_temp.ok(submit_invite_request('late@example.com', null, extensions.digest('ip-new', 'sha256'), false) = 'accepted', 'below the global cap again → accepted');
update public.app_settings set accept_invite_requests = false;
select pg_temp.ok(submit_invite_request('b@example.com', null, extensions.digest('ip-5', 'sha256'), false) = 'not_accepting', 'requests off → not_accepting');
select pg_temp.ok((get_public_config()->>'acceptingInviteRequests')::boolean = false, 'public config reflects requests off');
update public.app_settings set accept_invite_requests = true, signups_paused = true;
select pg_temp.ok(submit_invite_request('b@example.com', null, extensions.digest('ip-5', 'sha256'), false) = 'not_accepting', 'sign-ups paused → not_accepting');
update public.app_settings set signups_paused = false;
do $$ begin
  begin
    perform submit_invite_request('c@example.com', 'hacking', extensions.digest('ip-6', 'sha256'), false);
    raise exception 'FAILED: unknown use case accepted';
  exception when check_violation then raise notice 'ok - unknown use case rejected';
  end;
end $$;

set local role service_role;
select pg_temp.ok(public.submit_invite_request('svc@example.com', 'products', extensions.digest('ip-svc', 'sha256'), true) = 'accepted', 'service_role (the API) can submit a request');
select pg_temp.ok((public.get_public_config() ->> 'signupMode') = 'invite_only', 'service_role can read the public config');
reset role;
select pg_temp.ok((select disposable from public.invite_requests where email = 'svc@example.com'), 'disposable flag is stored');

-- ---- Retention purge
insert into public.invite_request_attempts (ip_hash, created_at) values (extensions.digest('ip-old', 'sha256'), now() - interval '3 days'); ------------------------------------------------------------------------------
insert into public.invite_requests (email, ip_hash, created_at) values ('old@example.com', extensions.digest('ip-old', 'sha256'), now() - interval '91 days');
select pg_temp.ok(purge_invite_requests() >= 1, 'purge removes old requests');
select pg_temp.ok(not exists (select 1 from public.invite_requests where email = 'old@example.com'), 'requests older than 90 days are gone');
select pg_temp.ok(exists (select 1 from public.invite_requests where email = 'a@example.com'), 'recent requests are kept');
select pg_temp.ok(not exists (select 1 from public.invite_request_attempts where created_at < now() - interval '2 days'), 'attempts older than 2 days are purged');

-- ---- Auth hook --------------------------------------------------------------------------------------
set local role supabase_auth_admin;
select pg_temp.ok(hook_before_user_created('{"user":{"email":"stranger@example.com"}}') -> 'error' ->> 'http_code' = '403', 'invite only: no invite → 403');
reset role;
insert into public.invites (email, token_hash, source, expires_at)
  values ('Invited@Example.com', extensions.digest('tok-1', 'sha256'), 'admin', now() + interval '7 days'),
         ('expired@example.com', extensions.digest('tok-2', 'sha256'), 'admin', now() + interval '1 second'),
         ('revoked@example.com', extensions.digest('tok-3', 'sha256'), 'admin', now() + interval '7 days');
update public.invites set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where email = 'expired@example.com';
update public.invites set revoked_at = now() where email = 'revoked@example.com';
set local role supabase_auth_admin;
select pg_temp.ok(hook_before_user_created('{"metadata":{"name":"before-user-created"},"user":{"email":"invited@example.com"}}') = '{}'::jsonb, 'invite only: valid invite (case-insensitive) → allowed');
select pg_temp.ok(hook_before_user_created('{"user":{"email":"expired@example.com"}}') ? 'error', 'expired invite → rejected');
select pg_temp.ok(hook_before_user_created('{"user":{"email":"revoked@example.com"}}') ? 'error', 'revoked invite → rejected');
select pg_temp.ok(hook_before_user_created('{"user":{}}') ? 'error', 'missing email → rejected');
reset role;
update public.app_settings set signup_mode = 'open';
set local role supabase_auth_admin;
select pg_temp.ok(hook_before_user_created('{"user":{"email":"stranger@example.com"}}') = '{}'::jsonb, 'open mode → anyone allowed');
reset role;
update public.app_settings set signups_paused = true;
set local role supabase_auth_admin;
select pg_temp.ok(hook_before_user_created('{"user":{"email":"invited@example.com"}}') -> 'error' ->> 'message' = 'Sign-ups are paused.', 'paused → rejected even with an invite');
reset role;
update public.app_settings set signups_paused = false, signup_mode = 'invite_only';

-- ---- New user trigger --------------------------------------------------------------------------------
select submit_invite_request('invited@example.com', 'personal', extensions.digest('ip-inv', 'sha256'), false);
-- An unconfirmed account (e.g. someone who only knows the invited address) must not use up the invite.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b1', 'Invited@example.com');
select pg_temp.ok(exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-0000000000b1' and plan_id = 'free'), 'new user gets a Free profile');
select pg_temp.ok((select accepted_at is null from public.invites where lower(email::text) = 'invited@example.com'), 'an unconfirmed user does not consume the invite');
select pg_temp.ok((select status = 'pending' from public.invite_requests where email = 'invited@example.com'), 'an unconfirmed user does not settle their invite request');
update auth.users set email_confirmed_at = now() where id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok((select accepted_at is not null from public.invites where lower(email::text) = 'invited@example.com'), 'confirming the email consumes the invite');
select pg_temp.ok((select status = 'approved' and ip_hash is null from public.invite_requests where email = 'invited@example.com'), 'their request is approved and its network hash dropped');
-- A user created already confirmed (admin invite accepted in one step) consumes it at insert.
insert into public.invites (email, token_hash, source, expires_at)
  values ('direct@example.com', extensions.digest('tok-4', 'sha256'), 'admin', now() + interval '7 days');
insert into auth.users (email, email_confirmed_at) values ('direct@example.com', now());
select pg_temp.ok((select accepted_at is not null from public.invites where lower(email::text) = 'direct@example.com'), 'a user inserted as confirmed consumes the invite');
update public.invite_requests set status = 'declined', decided_at = now() where email = 'r1@example.com';
select pg_temp.ok((select ip_hash is null from public.invite_requests where email = 'r1@example.com'), 'a declined request drops its network hash');

-- ---- Browser roles ------------------------------------------------------------------------------------
-- No function in public may be executable by the browser roles. Allow-list (empty for now):
select pg_temp.ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname <> all (array[]::text[])
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
), 'no public function is executable by anon or authenticated');
create function public.zz_future_fn() returns integer language sql as 'select 1';
select pg_temp.ok(not has_function_privilege('anon', 'public.zz_future_fn()', 'execute')
  and not has_function_privilege('authenticated', 'public.zz_future_fn()', 'execute'), 'a function added later is not executable by browser roles by default');
create table public.zz_future_tbl (x integer);
select pg_temp.ok(not has_table_privilege('anon', 'public.zz_future_tbl', 'select')
  and not has_table_privilege('authenticated', 'public.zz_future_tbl', 'select'), 'a table added later is not readable by browser roles by default');
drop function public.zz_future_fn();
drop table public.zz_future_tbl;
-- Table privileges: only authenticated SELECT on profiles (plus the display_name column update).
select pg_temp.ok(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['anon', 'authenticated']) r(role)
    cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate']) pr(priv)
   where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')
     and has_table_privilege(r.role, c.oid, pr.priv)
     and not (c.relname = 'profiles' and r.role = 'authenticated' and pr.priv = 'select')
), 'browser roles hold no table privileges except reading profiles');
select pg_temp.ok(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'S'
     and (has_sequence_privilege('anon', c.oid, 'usage') or has_sequence_privilege('authenticated', c.oid, 'usage'))
), 'browser roles cannot use any sequence');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c1', 'other@zephyr.test');
set local role anon;
do $$
declare t text;
begin
  foreach t in array array['app_settings','plans','plan_limit_versions','plan_limits','profiles','staff','invite_codes','invites','invite_requests','invite_request_attempts','audit_log'] loop
    begin
      execute format('select count(*) from public.%I', t);
      raise exception 'FAILED: anon could read %', t;
    exception when insufficient_privilege then null;
    end;
  end loop;
  raise notice 'ok - anon cannot read any public table';
  begin
    perform public.submit_invite_request('x@example.com', null, extensions.digest('ip-x', 'sha256'), false);
    raise exception 'FAILED: anon could call submit_invite_request';
  exception when insufficient_privilege then raise notice 'ok - anon cannot call submit_invite_request';
  end;
  begin
    perform public.hook_before_user_created('{}');
    raise exception 'FAILED: anon could call the auth hook';
  exception when insufficient_privilege then raise notice 'ok - anon cannot call the auth hook';
  end;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok((select count(*) = 1 from public.profiles), 'a member sees only their own profile');
update public.profiles set display_name = 'Mei' where id = '00000000-0000-0000-0000-0000000000c1';
reset role;
select pg_temp.ok((select display_name is null from public.profiles where id = '00000000-0000-0000-0000-0000000000c1'), 'a member cannot rename someone else');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
update public.profiles set display_name = 'Wei' where id = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  begin
    update public.profiles set plan_id = 'studio';
    raise exception 'FAILED: member changed their own plan';
  exception when insufficient_privilege then raise notice 'ok - a member cannot change their plan';
  end;
  begin
    perform count(*) from public.invites;
    raise exception 'FAILED: member could read invites';
  exception when insufficient_privilege then raise notice 'ok - a member cannot read invites';
  end;
end $$;
reset role;
select pg_temp.ok((select display_name = 'Wei' from public.profiles where id = '00000000-0000-0000-0000-0000000000b1'), 'a member can rename themselves');

rollback;
\echo 'All schema tests passed.'
