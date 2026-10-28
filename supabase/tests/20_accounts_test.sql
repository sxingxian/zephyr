-- Assertions for the accounts migration (phase 2): invites, codes, member quota, admin functions,
-- rate limits. Run with supabase/tests/run-local.sh.
\set ON_ERROR_STOP on
begin;

create function pg_temp.ok(cond boolean, what text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok - %', what;
end $$;
grant execute on function pg_temp.ok(boolean, text) to public;
create function pg_temp.h(t text) returns bytea language sql as $$ select extensions.digest(t, 'sha256') $$;
grant execute on function pg_temp.h(text) to public;

-- People: an owner, an admin, a support agent, and two members.
insert into auth.users (id, email, email_confirmed_at) values
  ('10000000-0000-0000-0000-000000000001', 'owner@zephyr.test', now()),
  ('10000000-0000-0000-0000-000000000002', 'admin@zephyr.test', now()),
  ('10000000-0000-0000-0000-000000000003', 'support@zephyr.test', now()),
  ('20000000-0000-0000-0000-000000000001', 'mei@example.com', now()),
  ('20000000-0000-0000-0000-000000000002', 'wei@example.com', now());
insert into public.staff (user_id, role) values
  ('10000000-0000-0000-0000-000000000001', 'owner'),
  ('10000000-0000-0000-0000-000000000002', 'admin'),
  ('10000000-0000-0000-0000-000000000003', 'support');
update public.profiles set display_name = 'Jason L.' where id = '10000000-0000-0000-0000-000000000001';
update public.profiles set display_name = 'Mei Lin' where id = '20000000-0000-0000-0000-000000000001';

-- ---- Accounts --------------------------------------------------------------------------------------
select pg_temp.ok(account_kind('Mei@Example.com') = 'member', 'account_kind: member (case-insensitive)');
select pg_temp.ok(account_kind('owner@zephyr.test') = 'staff', 'account_kind: staff');
select pg_temp.ok(account_kind('nobody@example.com') = 'none', 'account_kind: none');
select pg_temp.ok(is_staff('10000000-0000-0000-0000-000000000003') and not is_staff('20000000-0000-0000-0000-000000000001'), 'is_staff');
select pg_temp.ok(staff_lookup('10000000-0000-0000-0000-000000000001') ->> 'role' = 'owner', 'staff_lookup returns the role');
select pg_temp.ok(staff_lookup('20000000-0000-0000-0000-000000000001') is null, 'staff_lookup: members are not staff');
select pg_temp.ok((get_session_profile('20000000-0000-0000-0000-000000000001') ->> 'isStaff')::boolean = false
  and get_session_profile('20000000-0000-0000-0000-000000000001') ->> 'plan' = 'free', 'session profile for a member');
select update_display_name('20000000-0000-0000-0000-000000000002', '  Wei Tan  ');
select pg_temp.ok((select display_name = 'Wei Tan' from public.profiles where id = '20000000-0000-0000-0000-000000000002'), 'display name trimmed and saved');

-- ---- Admin invites ---------------------------------------------------------------------------------
select pg_temp.ok(create_invite('New.Person@Example.com', pg_temp.h('t-admin-1'), 'admin', '10000000-0000-0000-0000-000000000001', null, 'Welcome') ->> 'status' = 'created', 'admin invite created');
select pg_temp.ok(exists (select 1 from public.audit_log where action = 'invites.create' and actor = '10000000-0000-0000-0000-000000000001'), 'admin invite is audited');
select pg_temp.ok((select expires_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 minute' from public.invites where token_hash = pg_temp.h('t-admin-1')), 'invite expiry follows invite_ttl_days');
select pg_temp.ok(create_invite('new.person@example.com', pg_temp.h('t-admin-2'), 'admin', '10000000-0000-0000-0000-000000000001', null, null) ->> 'status' = 'already_invited', 'second invite for the same email → already_invited');
select pg_temp.ok(create_invite('mei@example.com', pg_temp.h('t-admin-3'), 'admin', '10000000-0000-0000-0000-000000000001', null, null) ->> 'status' = 'already_member', 'inviting a member → already_member');
select pg_temp.ok(create_invite('not an email', pg_temp.h('t-admin-4'), 'admin', '10000000-0000-0000-0000-000000000001', null, null) ->> 'status' = 'invalid', 'invalid email → invalid');

-- ---- Preview and accept ------------------------------------------------------------------------------
select pg_temp.ok(preview_invite(pg_temp.h('t-admin-1')) ->> 'email' = 'new.person@example.com', 'preview shows the invited email');
select pg_temp.ok(preview_invite(pg_temp.h('t-admin-1')) ->> 'inviterName' is null, 'admin invites show the Zephyr team (no inviter name)');
select pg_temp.ok(preview_invite(pg_temp.h('unknown')) is null, 'unknown token → null');
update public.app_settings set signups_paused = true;
select pg_temp.ok(preview_invite(pg_temp.h('t-admin-1')) is null, 'paused → preview looks invalid');
update public.app_settings set signups_paused = false;
select pg_temp.ok(mark_invite_accepted((select id from public.invites where token_hash = pg_temp.h('t-admin-1'))), 'first accept succeeds');
select pg_temp.ok(not mark_invite_accepted((select id from public.invites where token_hash = pg_temp.h('t-admin-1'))), 'second accept fails (single use)');
select pg_temp.ok(preview_invite(pg_temp.h('t-admin-1')) is null, 'used invite → preview null');

-- ---- Member invites and quota ----------------------------------------------------------------------
select pg_temp.ok(create_invite('f1@example.com', pg_temp.h('m1'), 'member', '20000000-0000-0000-0000-000000000001', null, null) ->> 'status' = 'created', 'member invite 1');
select pg_temp.ok(preview_invite(pg_temp.h('m1')) ->> 'inviterName' = 'Mei Lin', 'member invite shows the inviter''s name');
select pg_temp.ok(create_invite('wei@example.com', pg_temp.h('m2'), 'member', '20000000-0000-0000-0000-000000000001', null, null) ->> 'status' = 'already_member', 'member inviting a member → already_member');
select pg_temp.ok((list_member_invites('20000000-0000-0000-0000-000000000001') ->> 'remaining')::int = 1, 'that attempt still used quota (1 left)');
select pg_temp.ok(preview_invite(pg_temp.h('m2')) is null, 'the quota-only row is not a live invite');
select pg_temp.ok(create_invite('f3@example.com', pg_temp.h('m3'), 'member', '20000000-0000-0000-0000-000000000001', null, null) ->> 'status' = 'created', 'member invite 3');
select pg_temp.ok(create_invite('f4@example.com', pg_temp.h('m4'), 'member', '20000000-0000-0000-0000-000000000001', null, null) ->> 'status' = 'quota_exceeded', '4th member invite this month → quota_exceeded');
select pg_temp.ok(jsonb_array_length(list_member_invites('20000000-0000-0000-0000-000000000001') -> 'invites') = 3, 'member sees their 3 invites');
update public.app_settings set member_invites_enabled = false;
select pg_temp.ok(create_invite('f5@example.com', pg_temp.h('m5'), 'member', '20000000-0000-0000-0000-000000000002', null, null) ->> 'status' = 'member_invites_disabled', 'member invites off → member_invites_disabled');
select pg_temp.ok(not (list_member_invites('20000000-0000-0000-0000-000000000002') ->> 'enabled')::boolean, 'list reports invites disabled');
update public.app_settings set member_invites_enabled = true, signups_paused = true;
select pg_temp.ok(create_invite('f6@example.com', pg_temp.h('m6'), 'member', '20000000-0000-0000-0000-000000000002', null, null) ->> 'status' = 'signups_paused', 'paused → signups_paused');
update public.app_settings set signups_paused = false;

-- ---- Invite codes ----------------------------------------------------------------------------------
select pg_temp.ok(create_invite_code('10000000-0000-0000-0000-000000000003', 'NOPE-CODE', null, 5, null) ->> 'status' = 'forbidden', 'support cannot create codes');
select pg_temp.ok(create_invite_code('10000000-0000-0000-0000-000000000002', 'wedding-expo', 'Expo', 2, null) ->> 'status' = 'ok', 'admin creates a code (stored upper-case)');
select pg_temp.ok(create_invite_code('10000000-0000-0000-0000-000000000002', 'WEDDING-EXPO', null, 2, null) ->> 'status' = 'conflict', 'duplicate code → conflict');
select pg_temp.ok(create_invite_code('10000000-0000-0000-0000-000000000002', 'PAST', null, 2, now() - interval '1 day') ->> 'status' = 'invalid', 'expiry in the past → invalid');
select pg_temp.ok(redeem_invite_code('wedding-expo', 'Guest1@Example.com', pg_temp.h('c1')) ->> 'status' = 'created', 'code redeemed (case-insensitive)');
select pg_temp.ok(redeem_invite_code('WEDDING-EXPO', 'guest1@example.com', pg_temp.h('c1b')) ->> 'status' = 'created', 'same email again → link rotated');
select pg_temp.ok(preview_invite(pg_temp.h('c1')) is null and preview_invite(pg_temp.h('c1b')) ->> 'email' = 'guest1@example.com', 'rotation retires the old link');
select pg_temp.ok((select uses = 1 from public.invite_codes where code = 'WEDDING-EXPO'), 'rotation did not use another code use');
select pg_temp.ok(redeem_invite_code('WEDDING-EXPO', 'mei@example.com', pg_temp.h('c2')) ->> 'status' = 'already_member', 'member email → already_member (no use consumed)');
select pg_temp.ok(redeem_invite_code('WEDDING-EXPO', 'guest2@example.com', pg_temp.h('c3')) ->> 'status' = 'created', 'second use');
select pg_temp.ok(redeem_invite_code('WEDDING-EXPO', 'guest3@example.com', pg_temp.h('c4')) ->> 'status' = 'invalid', 'code used up → invalid');
select pg_temp.ok(redeem_invite_code('NO-SUCH-CODE', 'guest4@example.com', pg_temp.h('c5')) ->> 'status' = 'invalid', 'unknown code → invalid');
select pg_temp.ok(revoke_invite_code('10000000-0000-0000-0000-000000000002', (select id from public.invite_codes where code = 'WEDDING-EXPO')) ->> 'status' = 'ok', 'code revoked');
select pg_temp.ok(jsonb_array_length(get_signup_overview() -> 'codes') = 1, 'overview lists the code');

-- ---- Revoke and resend -----------------------------------------------------------------------------
select pg_temp.ok(revoke_invite('10000000-0000-0000-0000-000000000003', (select id from public.invites where token_hash = pg_temp.h('m1'))) ->> 'status' = 'forbidden', 'support cannot revoke');
select pg_temp.ok(resend_invite('10000000-0000-0000-0000-000000000002', (select id from public.invites where token_hash = pg_temp.h('m1')), pg_temp.h('m1-new')) ->> 'status' = 'ok', 'admin resends with a new token');
select pg_temp.ok(preview_invite(pg_temp.h('m1')) is null and preview_invite(pg_temp.h('m1-new')) is not null, 'resend retires the old link');
select pg_temp.ok(revoke_invite('10000000-0000-0000-0000-000000000002', (select id from public.invites where token_hash = pg_temp.h('m1-new'))) -> 'invite' ->> 'status' = 'revoked', 'admin revokes');
select pg_temp.ok(revoke_invite('10000000-0000-0000-0000-000000000002', (select id from public.invites where token_hash = pg_temp.h('m1-new'))) ->> 'status' = 'not_found', 'revoking twice → not_found');
select pg_temp.ok(preview_invite(pg_temp.h('m1-new')) is null, 'revoked invite → preview null');

-- ---- Settings --------------------------------------------------------------------------------------
select pg_temp.ok(update_signup_settings('10000000-0000-0000-0000-000000000002', '{"signupMode":"open"}', 'try') ->> 'status' = 'forbidden', 'an admin cannot switch the sign-up mode');
select pg_temp.ok(update_signup_settings('10000000-0000-0000-0000-000000000003', '{"signupsPaused":true}', 'try') ->> 'status' = 'forbidden', 'support cannot change settings');
select pg_temp.ok(update_signup_settings('20000000-0000-0000-0000-000000000001', '{"signupsPaused":true}', 'try') ->> 'status' = 'forbidden', 'a member cannot change settings');
select pg_temp.ok(update_signup_settings('10000000-0000-0000-0000-000000000002', '{"signupMode":"invite_only","inviteTtlDays":14,"reason":"x"}', 'Longer invites') -> 'settings' ->> 'inviteTtlDays' = '14', 'admin changes other settings (unchanged mode is fine)');
select pg_temp.ok(update_signup_settings('10000000-0000-0000-0000-000000000001', '{"signupMode":"open"}', 'Launch') -> 'settings' ->> 'signupMode' = 'open', 'the owner switches to open');
select pg_temp.ok((select details -> 'changes' ->> 'signupMode' = 'open' and details ->> 'reason' = 'Launch' from public.audit_log where action = 'signups.settings.update' order by id desc limit 1), 'settings change audited with the reason');
select pg_temp.ok((select updated_by = '10000000-0000-0000-0000-000000000001' from public.app_settings), 'settings record who changed them');
do $$ begin
  begin
    perform public.update_signup_settings('10000000-0000-0000-0000-000000000001', '{"inviteTtlDays":500}', null);
    raise exception 'FAILED: ttl 500 accepted';
  exception when check_violation then raise notice 'ok - out-of-range settings rejected';
  end;
end $$;
select update_signup_settings('10000000-0000-0000-0000-000000000001', '{"signupMode":"invite_only","inviteTtlDays":7}', 'Back');

-- ---- Invite requests -------------------------------------------------------------------------------
insert into public.invite_requests (email, ip_hash) values ('req1@example.com', pg_temp.h('n1')), ('req2@example.com', pg_temp.h('n2')), ('req3@example.com', pg_temp.h('n3'));
select pg_temp.ok(decide_invite_requests('10000000-0000-0000-0000-000000000003', array(select id from public.invite_requests where email = 'req1@example.com'), 'approve') ->> 'status' = 'forbidden', 'support cannot decide');
select pg_temp.ok(jsonb_array_length(decide_invite_requests('10000000-0000-0000-0000-000000000002',
  array(select id from public.invite_requests where email in ('req1@example.com', 'req2@example.com')), 'approve') -> 'approved') = 2, 'admin approves two');
select pg_temp.ok((decide_invite_requests('10000000-0000-0000-0000-000000000002',
  array(select id from public.invite_requests where email in ('req1@example.com', 'req3@example.com')), 'decline') ->> 'declined')::int = 1, 'decline skips already-decided rows');
select pg_temp.ok((select count(*) = 3 from public.audit_log where action in ('requests.approve', 'requests.decline')), 'decisions audited');
select reopen_invite_request('10000000-0000-0000-0000-000000000002', (select id from public.invite_requests where email = 'req2@example.com'));
select pg_temp.ok((select status = 'pending' from public.invite_requests where email = 'req2@example.com'), 'a failed invite email reopens the request');
select pg_temp.ok(create_invite('req1@example.com', pg_temp.h('r1'), 'request', '10000000-0000-0000-0000-000000000002', null, null) ->> 'status' = 'created', 'approved request → invite');

-- ---- Lists -----------------------------------------------------------------------------------------
select pg_temp.ok(jsonb_array_length(list_invites(null, null, 3) -> 'items') = 3 and list_invites(null, null, 3) ->> 'nextCursor' is not null, 'list_invites pages with a cursor');
select pg_temp.ok((
  select count(distinct x ->> 'id') = (select count(*) from public.invites)
    from (
      select jsonb_array_elements(list_invites(null, null, 3) -> 'items') x
      union all select jsonb_array_elements(list_invites(null, list_invites(null, null, 3) ->> 'nextCursor', 3) -> 'items')
      union all select jsonb_array_elements(list_invites(null, list_invites(null, list_invites(null, null, 3) ->> 'nextCursor', 3) ->> 'nextCursor', 3) -> 'items')
      union all select jsonb_array_elements(list_invites(null, list_invites(null, list_invites(null, list_invites(null, null, 3) ->> 'nextCursor', 3) ->> 'nextCursor', 3) ->> 'nextCursor', 50) -> 'items')
    ) t), 'paging visits every invite exactly once');
select pg_temp.ok((select bool_and(x ->> 'status' = 'revoked') from jsonb_array_elements(list_invites('revoked', null, 50) -> 'items') x), 'status filter');
select pg_temp.ok(list_invites(null, 'garbage', 50) ->> 'nextCursor' is null, 'a malformed cursor is ignored');
select pg_temp.ok(exists (select 1 from jsonb_array_elements(list_invites(null, null, 50) -> 'items') x where x ->> 'invitedBy' = 'Jason L. · Owner'), 'admin invites are labelled with name and role');
select pg_temp.ok(jsonb_array_length(list_invite_requests('pending', null, 50) -> 'items') = 1, 'list_invite_requests filters by status');

-- ---- Rate limits -----------------------------------------------------------------------------------
select pg_temp.ok((select bool_and(rate_limit_hit('email_start', pg_temp.h('net'), 5, 900)) from generate_series(1, 5)), '5 attempts allowed');
select pg_temp.ok(not rate_limit_hit('email_start', pg_temp.h('net'), 5, 900), '6th attempt refused');
select pg_temp.ok((select count(*) = 5 from public.rate_limit_attempts where kind = 'email_start'), 'refused attempts are not recorded');
select pg_temp.ok(rate_limit_hit('email_start', pg_temp.h('other'), 5, 900), 'another key is unaffected');
select pg_temp.ok(rate_limit_hit('invite_code', pg_temp.h('net'), 5, 900), 'another kind is unaffected');
select rate_limit_record('email_verify_fail', pg_temp.h('mail')) from generate_series(1, 3);
select pg_temp.ok(rate_limit_count('email_verify_fail', pg_temp.h('mail'), 900) = 3, 'failures are counted');
insert into public.rate_limit_attempts (kind, key_hash, created_at) values ('email_start', pg_temp.h('old'), now() - interval '3 days');
select purge_invite_requests();
select pg_temp.ok(not exists (select 1 from public.rate_limit_attempts where created_at < now() - interval '2 days'), 'old attempts purged');

-- ---- Privileges ------------------------------------------------------------------------------------
set local role service_role;
select pg_temp.ok(account_kind('mei@example.com') = 'member', 'service_role can call the account functions');
select pg_temp.ok(get_signup_overview() ? 'settings', 'service_role can read the overview');
reset role;
set local role anon;
do $$ begin
  begin
    perform public.create_invite('x@example.com', extensions.digest('x', 'sha256'), 'admin', null, null, null);
    raise exception 'FAILED: anon could create an invite';
  exception when insufficient_privilege then raise notice 'ok - anon cannot create invites';
  end;
  begin
    perform public.preview_invite(extensions.digest('x', 'sha256'));
    raise exception 'FAILED: anon could preview';
  exception when insufficient_privilege then raise notice 'ok - anon cannot preview invites';
  end;
  begin
    perform count(*) from public.rate_limit_attempts;
    raise exception 'FAILED: anon read attempts';
  exception when insufficient_privilege then raise notice 'ok - anon cannot read rate-limit attempts';
  end;
end $$;
reset role;
set local role authenticated;
do $$ begin
  begin
    perform public.update_signup_settings('10000000-0000-0000-0000-000000000001', '{"signupMode":"open"}', null);
    raise exception 'FAILED: authenticated could change settings';
  exception when insufficient_privilege then raise notice 'ok - members cannot call admin functions directly';
  end;
end $$;
reset role;
select pg_temp.ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '\_%' and has_function_privilege('service_role', p.oid, 'execute')
), 'internal helpers are not callable by service_role either');

rollback;
\echo 'All accounts tests passed.'
