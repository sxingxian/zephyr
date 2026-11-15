-- Assertions for account action links (phase 8, review round 4): issuing (binding, replacement, rate limits),
-- peeking, spending (single use, bound to member, change and passkey, expiry), the passkey grant, and privileges.
-- Run with supabase/tests/run-local.sh.
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

-- ---- Issuing ----------------------------------------------------------------------------------------------
select pg_temp.ok(public.account_action_issue(:fre, 'passkey_add', null, pg_temp.h('t1')) = 'ok', 'a link is stored');
select pg_temp.ok(public.account_action_issue(:pro, 'account_delete', null, pg_temp.h('p1')) = 'ok',
  'for every member, whatever their plan');
select pg_temp.ok(public.account_action_issue(:fre, 'export', null, pg_temp.h('x')) = 'invalid'
  and public.account_action_issue(:fre, 'passkey_add', null, substr(pg_temp.h('x'), 1, 16)) = 'invalid'
  and public.account_action_issue(:fre, 'passkey_add', 'pk-1', pg_temp.h('x')) = 'invalid'
  and public.account_action_issue(:fre, 'passkey_remove', null, pg_temp.h('x')) = 'invalid'
  and public.account_action_issue(:fre, 'passkey_remove', '../admin', pg_temp.h('x')) = 'invalid'
  and public.account_action_issue('97000000-0000-0000-0000-0000000000ff', 'passkey_add', null, pg_temp.h('x')) = 'invalid',
  'unknown changes, misplaced or malformed passkey ids, malformed hashes and unknown members are refused');
select pg_temp.ok((select token_hash = pg_temp.h('t1') and expires_at > now() + interval '14 minutes'
                     and expires_at <= now() + interval '15 minutes' and used_at is null
                     from public.account_actions where user_id = :fre and op = 'passkey_add'),
  'only the hash is kept, for 15 minutes');

-- ---- Peeking ----------------------------------------------------------------------------------------------
select pg_temp.ok(public.account_action_peek(:fre, pg_temp.h('t1')) ->> 'op' = 'passkey_add'
  and public.account_action_peek(:fre, pg_temp.h('t1')) -> 'passkeyId' = 'null'::jsonb,
  'peeking shows what the link will do');
select pg_temp.ok(public.account_action_peek(:pro, pg_temp.h('t1')) ->> 'error' = 'wrong_member',
  'peeking someone else''s link says so, and nothing more');
select pg_temp.ok(public.account_action_peek(:fre, pg_temp.h('nope')) is null
  and public.account_action_peek(:fre, null) is null, 'unknown links show nothing');

-- ---- Spending ---------------------------------------------------------------------------------------------
select pg_temp.ok(public.account_action_use(:pro, 'passkey_add', null, pg_temp.h('t1'), null) = 'wrong_member',
  'a link is bound to its member');
select pg_temp.ok(public.account_action_use(:fre, 'account_delete', null, pg_temp.h('t1'), null) = 'invalid',
  'and to its change');
select pg_temp.ok(public.account_action_use(:fre, 'passkey_add', null, pg_temp.h('t1'), pg_temp.h('challenge-1')) = 'ok',
  'the right link works (the wrong tries above didn''t spend it)');
select pg_temp.ok(public.account_action_use(:fre, 'passkey_add', null, pg_temp.h('t1'), null) = 'invalid'
  and public.account_action_peek(:fre, pg_temp.h('t1')) is null, 'once');
select pg_temp.ok(not public.account_action_grant_use(:fre, pg_temp.h('challenge-2'))
  and not public.account_action_grant_use(:pro, pg_temp.h('challenge-1')),
  'the grant only covers the challenge and member it was given for');
select pg_temp.ok(public.account_action_grant_use(:fre, pg_temp.h('challenge-1'))
  and not public.account_action_grant_use(:fre, pg_temp.h('challenge-1')), 'and works once');

select public.account_action_issue(:fre, 'passkey_remove', 'pk-1', pg_temp.h('r1'));
select pg_temp.ok(public.account_action_use(:fre, 'passkey_remove', 'pk-2', pg_temp.h('r1'), null) = 'invalid',
  'a removal link is bound to its passkey');
select pg_temp.ok(public.account_action_use(:fre, 'passkey_remove', 'pk-1', pg_temp.h('r1'), null) = 'ok',
  'and works for it');

select public.account_action_issue(:fre, 'account_delete', null, pg_temp.h('d1'));
update public.account_actions set expires_at = now() - interval '1 second' where token_hash = pg_temp.h('d1');
select pg_temp.ok(public.account_action_use(:fre, 'account_delete', null, pg_temp.h('d1'), null) = 'invalid'
  and public.account_action_peek(:fre, pg_temp.h('d1')) is null, 'an expired link is refused');

select public.account_action_issue(:fre, 'account_delete', null, pg_temp.h('d2'));
select public.account_action_issue(:fre, 'account_delete', null, pg_temp.h('d3'));
select pg_temp.ok(public.account_action_use(:fre, 'account_delete', null, pg_temp.h('d2'), null) = 'invalid',
  'a newer link replaces an older one for the same change');
select pg_temp.ok(public.account_action_use(:fre, 'account_delete', null, pg_temp.h('d3'), null) = 'ok',
  'and the newest works');

-- ---- Rate limits ------------------------------------------------------------------------------------------
delete from public.account_actions where user_id = :fre and op = 'passkey_remove';
select public.account_action_issue(:fre, 'passkey_remove', 'pk-1', pg_temp.h('q' || g)) from generate_series(1, 5) g;
select pg_temp.ok(public.account_action_issue(:fre, 'passkey_remove', 'pk-1', pg_temp.h('q6')) = 'rate_limited',
  'five links an hour per change');
select pg_temp.ok(public.account_action_issue(:fre, 'passkey_add', null, pg_temp.h('other')) = 'ok',
  'counted per change');
update public.account_actions set created_at = now() - interval '61 minutes'
 where user_id = :fre and op = 'passkey_remove';
select public.account_action_issue(:fre, 'passkey_remove', 'pk-1', pg_temp.h('w' || g)) from generate_series(1, 5) g;
select pg_temp.ok(public.account_action_issue(:fre, 'passkey_remove', 'pk-1', pg_temp.h('w6')) = 'rate_limited'
  and (select count(*) from public.account_actions where user_id = :fre and op = 'passkey_remove') = 10,
  'ten a day per change, even across hours');
update public.account_actions set created_at = now() - interval '3 days' where user_id = :fre and op = 'passkey_remove';
select public.account_action_issue(:fre, 'passkey_remove', 'pk-1', pg_temp.h('z1')) as z1 \gset
select count(*) as zc from public.account_actions where user_id = :fre and op = 'passkey_remove' \gset
select pg_temp.ok(:'z1' = 'ok' and :zc = 1,
  'old links are forgotten after two days');

-- ---- Privileges -------------------------------------------------------------------------------------------
select pg_temp.ok(not has_table_privilege('anon', 'public.account_actions', 'select')
  and not has_table_privilege('authenticated', 'public.account_actions', 'select')
  and not has_table_privilege('authenticated', 'public.account_actions', 'insert')
  and not has_table_privilege('authenticated', 'public.account_actions', 'update')
  and (select c.relrowsecurity from pg_class c where c.oid = 'public.account_actions'::regclass),
  'anon and authenticated can''t read or write account action links; RLS is on');
set local role authenticated;
do $$ begin
  begin
    perform 1 from public.account_actions;
    raise exception 'FAILED: authenticated read account_actions';
  exception when insufficient_privilege then raise notice 'ok - reading the table as authenticated is refused';
  end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform 1 from public.account_actions;
    raise exception 'FAILED: anon read account_actions';
  exception when insufficient_privilege then raise notice 'ok - reading the table as anon is refused';
  end;
end $$;
reset role;
select pg_temp.ok(not has_function_privilege('anon', 'public.account_action_issue(uuid, text, text, bytea)', 'execute')
  and not has_function_privilege('authenticated', 'public.account_action_peek(uuid, bytea)', 'execute')
  and not has_function_privilege('authenticated', 'public.account_action_use(uuid, text, text, bytea, bytea)', 'execute')
  and not has_function_privilege('anon', 'public.account_action_grant_use(uuid, bytea)', 'execute')
  and has_function_privilege('service_role', 'public.account_action_use(uuid, text, text, bytea, bytea)', 'execute'),
  'only the API (service role) calls the account action functions');
select pg_temp.ok(not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                                and p.proname like 'step_up%'),
  'the step-up code functions are gone');

rollback;
