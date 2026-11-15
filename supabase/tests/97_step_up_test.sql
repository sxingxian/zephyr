-- Assertions for step-up codes (phase 8, review round 3): when a member needs one, issuing (rate limit), spending
-- (single use, bound to the operation, expiry, five tries), the passkey grant, and privileges. Run with
-- supabase/tests/run-local.sh.
\set ON_ERROR_STOP on
begin;

create function pg_temp.ok(cond boolean, what text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok - %', what;
end $$;
grant execute on function pg_temp.ok(boolean, text) to public;
create function pg_temp.h(t text) returns bytea language sql as $$ select extensions.digest(t, 'sha256') $$;

insert into auth.users (id, email, email_confirmed_at) values
  ('97000000-0000-0000-0000-000000000001', 'free97@example.com', now()),
  ('97000000-0000-0000-0000-000000000002', 'pro97@example.com', now());
update public.profiles set plan_id = 'pro' where id = '97000000-0000-0000-0000-000000000002';
\set fre '\'97000000-0000-0000-0000-000000000001\''
\set pro '\'97000000-0000-0000-0000-000000000002\''

-- ---- When a step-up is needed ----------------------------------------------------------------------------
update public.app_settings set adsense = '{"enabled": false, "publisherId": null, "slots": {}}'::jsonb where id = 1;
select pg_temp.ok(not public.step_up_needed(:fre), 'AdSense never on: nobody needs a step-up code');
update public.app_settings set adsense = '{"enabled": true, "publisherId": "ca-pub-1234567890123456", "slots": {}}'::jsonb where id = 1;
select pg_temp.ok(public.step_up_needed(:fre) and not public.step_up_needed(:pro),
  'AdSense on: a Free member needs one, a paid member doesn''t');
insert into public.library_members (owner_id, member_id, role) values (:pro, :fre, 'viewer');
select pg_temp.ok(public.step_up_needed(:fre), 'joining a team (no AdSense from then on) doesn''t lift the requirement');
delete from public.library_members where owner_id = :pro and member_id = :fre;
update public.app_settings set adsense = '{"enabled": false, "publisherId": "ca-pub-1234567890123456", "slots": {}}'::jsonb where id = 1;
insert into public.audit_log (actor, action, target, details) values (null, 'ads.adsense', 'adsense', '{}'::jsonb);
select pg_temp.ok(public.step_up_needed(:fre), 'just switched off: still needed for 30 minutes (pages may still hold the script)');
update public.app_settings set adsense = '{"enabled": true, "publisherId": "ca-pub-1234567890123456", "slots": {}}'::jsonb where id = 1;

-- ---- Issuing ----------------------------------------------------------------------------------------------
select pg_temp.ok(public.step_up_issue(:fre, 'passkey_add', pg_temp.h('111111')) = 'ok', 'a code is stored');
select pg_temp.ok(public.step_up_issue(:fre, 'export', pg_temp.h('x')) = 'invalid'
  and public.step_up_issue(:fre, 'passkey_add', substr(pg_temp.h('x'), 1, 16)) = 'invalid'
  and public.step_up_issue('97000000-0000-0000-0000-0000000000ff', 'passkey_add', pg_temp.h('x')) = 'invalid',
  'unknown operations, malformed hashes and unknown members are refused');
select pg_temp.ok((select code_hash = pg_temp.h('111111') and expires_at > now() + interval '9 minutes'
                     and expires_at <= now() + interval '10 minutes' from public.step_up_codes
                    where user_id = :fre and op = 'passkey_add'), 'only the hash is kept, for 10 minutes');

-- ---- Spending ---------------------------------------------------------------------------------------------
select pg_temp.ok(public.step_up_check(:fre, 'passkey_remove', pg_temp.h('111111')) = 'invalid',
  'a code is bound to its operation');
select pg_temp.ok(public.step_up_check(:pro, 'passkey_add', pg_temp.h('111111')) = 'invalid', 'and to its member');
select pg_temp.ok(public.step_up_check(:fre, 'passkey_add', pg_temp.h('111111'), pg_temp.h('challenge-1')) = 'ok',
  'the right code works');
select pg_temp.ok(public.step_up_check(:fre, 'passkey_add', pg_temp.h('111111')) = 'invalid', 'once');
select pg_temp.ok(not public.step_up_grant_use(:fre, 'passkey_add', pg_temp.h('challenge-2'))
  and not public.step_up_grant_use(:fre, 'passkey_remove', pg_temp.h('challenge-1')),
  'the grant only covers the challenge it was given for');
select pg_temp.ok(public.step_up_grant_use(:fre, 'passkey_add', pg_temp.h('challenge-1'))
  and not public.step_up_grant_use(:fre, 'passkey_add', pg_temp.h('challenge-1')), 'and works once');

select public.step_up_issue(:fre, 'account_delete', pg_temp.h('222222'));
update public.step_up_codes set expires_at = now() - interval '1 second' where user_id = :fre and op = 'account_delete';
select pg_temp.ok(public.step_up_check(:fre, 'account_delete', pg_temp.h('222222')) = 'invalid', 'an expired code is refused');
select pg_temp.ok((select code_hash is null from public.step_up_codes where user_id = :fre and op = 'account_delete'),
  'and forgotten');

select public.step_up_issue(:fre, 'account_delete', pg_temp.h('333333'));
select public.step_up_check(:fre, 'account_delete', pg_temp.h('000001')) from generate_series(1, 4);
select pg_temp.ok(public.step_up_check(:fre, 'account_delete', pg_temp.h('333333')) = 'ok', 'four wrong tries leave the code usable');
select public.step_up_issue(:fre, 'account_delete', pg_temp.h('444444'));
select public.step_up_check(:fre, 'account_delete', pg_temp.h('000001')) from generate_series(1, 5);
select pg_temp.ok(public.step_up_check(:fre, 'account_delete', pg_temp.h('444444')) = 'invalid', 'the fifth wrong try burns it');

-- ---- Rate limit -------------------------------------------------------------------------------------------
update public.step_up_codes set sends = 0, window_start = now() where user_id = :fre and op = 'passkey_remove';
select public.step_up_issue(:fre, 'passkey_remove', pg_temp.h('r' || g)) from generate_series(1, 5) g;
select pg_temp.ok(public.step_up_issue(:fre, 'passkey_remove', pg_temp.h('r6')) = 'rate_limited', 'five codes an hour per operation');
select pg_temp.ok(public.step_up_check(:fre, 'passkey_remove', pg_temp.h('r5')) = 'ok', 'the last code sent still works');
update public.step_up_codes set window_start = now() - interval '61 minutes' where user_id = :fre and op = 'passkey_remove';
select pg_temp.ok(public.step_up_issue(:fre, 'passkey_remove', pg_temp.h('r7')) = 'ok', 'and the hour rolls over');

-- ---- Privileges -------------------------------------------------------------------------------------------
select pg_temp.ok(not has_table_privilege('anon', 'public.step_up_codes', 'select')
  and not has_table_privilege('authenticated', 'public.step_up_codes', 'select')
  and not has_table_privilege('authenticated', 'public.step_up_codes', 'insert')
  and not has_table_privilege('authenticated', 'public.step_up_codes', 'update')
  and (select c.relrowsecurity from pg_class c where c.oid = 'public.step_up_codes'::regclass),
  'anon and authenticated can''t read or write step-up codes; RLS is on');
set local role authenticated;
do $$ begin
  begin
    perform 1 from public.step_up_codes;
    raise exception 'FAILED: authenticated read step_up_codes';
  exception when insufficient_privilege then raise notice 'ok - reading the table as authenticated is refused';
  end;
end $$;
reset role;
select pg_temp.ok(not has_function_privilege('anon', 'public.step_up_needed(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.step_up_issue(uuid, text, bytea)', 'execute')
  and not has_function_privilege('authenticated', 'public.step_up_check(uuid, text, bytea, bytea)', 'execute')
  and not has_function_privilege('anon', 'public.step_up_grant_use(uuid, text, bytea)', 'execute')
  and not has_function_privilege('service_role', 'public._step_up_row(uuid, text)', 'execute')
  and has_function_privilege('service_role', 'public.step_up_check(uuid, text, bytea, bytea)', 'execute'),
  'only the API (service role) calls the step-up functions');

rollback;
