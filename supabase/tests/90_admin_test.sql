-- Assertions for the admin migration (phase 8): staff roles (STAFF_CAN), audit kinds, users (overrides,
-- credits, sign-out, suspension, deletion), safety (reports, reveal grants, holds), plan limits on a set date,
-- ads, retention, staff invites and roles, audit, settings and app status, gallery link replacement, privileges.
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
create function pg_temp.photo(o uuid, n text, sz bigint default 1000, taken timestamptz default null) returns uuid language plpgsql as $$
declare id uuid;
begin
  insert into public.photos (owner_id, status, file_type, filename, size_bytes, sha256, width, height, has_thumb, has_preview, thumb_bytes, preview_bytes, taken_at)
  values (o, 'ready', 'jpeg', n, sz, extensions.digest(n || o::text, 'sha256'), 4000, 3000, true, true, 0, 0, taken)
  returning photos.id into id;
  update public.profiles set storage_bytes = storage_bytes + sz where profiles.id = o;
  return id;
end $$;
create function pg_temp.gallery(o uuid, id uuid, tok text, photos uuid[]) returns jsonb language sql as $$
  select public.create_gallery(o, id, pg_temp.h(tok), left(tok, 8), pg_temp.h('ct:' || tok), substr(pg_temp.h('iv'), 1, 12),
    null, 'Shoot', null, photos, (now() at time zone 'utc')::date + 5, 'web', '{}'::jsonb)
$$;

insert into auth.users (id, email, email_confirmed_at) values
  ('a9000000-0000-0000-0000-000000000001', 'owner9@zephyr.test', now()),
  ('a9000000-0000-0000-0000-000000000002', 'admin9@zephyr.test', now()),
  ('a9000000-0000-0000-0000-000000000003', 'finance9@zephyr.test', now()),
  ('a9000000-0000-0000-0000-000000000004', 'safety9@zephyr.test', now()),
  ('a9000000-0000-0000-0000-000000000005', 'support9@zephyr.test', now()),
  ('a9000000-0000-0000-0000-000000000011', 'mei9@example.com', now()),
  ('a9000000-0000-0000-0000-000000000012', 'jun9@example.com', now()),
  ('a9000000-0000-0000-0000-000000000013', 'ret9@example.com', now()),
  ('a9000000-0000-0000-0000-000000000014', 'ads9@example.com', now());
insert into public.staff (user_id, role) values
  ('a9000000-0000-0000-0000-000000000001', 'owner'),
  ('a9000000-0000-0000-0000-000000000002', 'admin'),
  ('a9000000-0000-0000-0000-000000000003', 'finance'),
  ('a9000000-0000-0000-0000-000000000004', 'safety'),
  ('a9000000-0000-0000-0000-000000000005', 'support');
update public.profiles set display_name = 'Olivia Owner' where id = 'a9000000-0000-0000-0000-000000000001';
update public.profiles set plan_id = 'studio', display_name = 'Mei Lin' where id = 'a9000000-0000-0000-0000-000000000011';
update public.profiles set display_name = 'Jun Hao' where id = 'a9000000-0000-0000-0000-000000000012';
\set own '\'a9000000-0000-0000-0000-000000000001\''
\set adm '\'a9000000-0000-0000-0000-000000000002\''
\set fin '\'a9000000-0000-0000-0000-000000000003\''
\set saf '\'a9000000-0000-0000-0000-000000000004\''
\set sup '\'a9000000-0000-0000-0000-000000000005\''
\set mei '\'a9000000-0000-0000-0000-000000000011\''
\set jun '\'a9000000-0000-0000-0000-000000000012\''
\set ret '\'a9000000-0000-0000-0000-000000000013\''
\set adsu '\'a9000000-0000-0000-0000-000000000014\''

-- ---- STAFF_CAN, mirrored exactly ---------------------------------------------------------------------
create temp table can (action text, roles text[]);
insert into can values
  ('usersView', '{owner,admin,finance,safety,support}'), ('usersAct', '{owner,admin,safety,support}'),
  ('planOverride', '{owner,admin,finance}'), ('suspend', '{owner,admin,safety}'), ('deleteAccount', '{owner}'),
  ('safetyView', '{owner,admin,safety}'), ('safetyAct', '{safety}'), ('holdsRecord', '{owner,safety}'),
  ('holdsRelease', '{owner}'), ('limits', '{owner,finance}'), ('limitsView', '{owner,admin,finance}'),
  ('ads', '{owner,admin}'), ('adsense', '{owner}'), ('storage', '{owner,admin}'), ('retention', '{owner,admin}'),
  ('staff', '{owner}'), ('auditView', '{owner,admin,finance,safety}'), ('auditExport', '{owner,admin}'),
  ('settings', '{owner,admin}');
select pg_temp.ok((select bool_and(public._staff_can(s.user_id, c.action) = (s.role::text = any (c.roles)))
                     from can c cross join public.staff s where s.user_id::text like 'a9000000-%'),
  '_staff_can matches STAFF_CAN for every role and action');
select pg_temp.ok(not public._staff_can(:mei, 'usersView') and not public._staff_can(:own, 'nope')
  and not public._staff_can(null, 'usersView'), 'members, unknown actions and null are refused');

-- ---- Audit kinds -------------------------------------------------------------------------------------
insert into public.audit_log (actor, action) values (null, 'prices.changed'), (null, 'invites.sent'), (null, 'ai.cap'), (null, 'weird');
select pg_temp.ok((select array_agg(kind order by id) from public.audit_log where action in ('prices.changed', 'invites.sent', 'ai.cap', 'weird'))
  = array['billing', 'signups', 'ai', null], 'audit kind comes from the action prefix (prices → billing, invites → signups)');
do $$ begin
  begin
    update public.audit_log set action = 'x' where action = 'weird';
    raise exception 'FAILED: audit_log update allowed';
  exception when insufficient_privilege then raise notice 'ok - audit_log is still append-only';
  end;
end $$;

-- ---- Users -------------------------------------------------------------------------------------------
select pg_temp.ok(public.admin_users(:mei, null, null, null, null, null) ->> 'error' = 'forbidden', 'members can''t list users');
select pg_temp.ok((select bool_and(e ->> 'email' like '%•••@%') from jsonb_array_elements(public.admin_users(:sup, null, null, null, null, null) -> 'page' -> 'items') e),
  'the user list masks emails');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.admin_users(:own, null, null, null, null, null) -> 'page' -> 'items') e
                               where e ->> 'id' = 'a9000000-0000-0000-0000-000000000002'), 'staff accounts aren''t listed as members');
select pg_temp.ok(public.admin_users(:sup, 'MEI9@example.com', null, null, null, null) -> 'page' -> 'items' -> 0 ->> 'id' = 'a9000000-0000-0000-0000-000000000011'
  and (public.admin_users(:sup, 'MEI9@example.com', null, null, null, null) ->> 'total')::int = 1, 'search by exact email');
select pg_temp.ok(public.admin_users(:sup, 'jun', null, null, null, null) -> 'page' -> 'items' -> 0 ->> 'id' = 'a9000000-0000-0000-0000-000000000012',
  'search by name prefix');
select pg_temp.ok(public.admin_users(:sup, '100%_', null, null, null, null) -> 'page' -> 'items' = '[]'::jsonb, 'LIKE wildcards in the query are literal');
select pg_temp.ok(public.admin_users(:sup, null, 'studio', null, null, null) -> 'page' -> 'items' -> 0 ->> 'id' = 'a9000000-0000-0000-0000-000000000011',
  'filter by plan');
-- Paging: 50 per page with a cursor.
insert into auth.users (id, email) select ('a9100000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'pg' || g || '@example.com' from generate_series(1, 55) g;
update public.profiles set plan_id = 'pro', created_at = now() - make_interval(secs => 1000 + (id::text ~ '0055$')::int)
 where id::text like 'a9100000-%';
select pg_temp.ok(jsonb_array_length(public.admin_users(:sup, null, 'pro', null, null, null) -> 'page' -> 'items') = 50
  and public.admin_users(:sup, null, 'pro', null, null, null) -> 'page' ->> 'nextCursor' is not null
  and jsonb_array_length(public.admin_users(:sup, null, 'pro', null, null, public.admin_users(:sup, null, 'pro', null, null, null) -> 'page' ->> 'nextCursor') -> 'page' -> 'items') = 5
  and public.admin_users(:sup, null, 'pro', null, null, public.admin_users(:sup, null, 'pro', null, null, null) -> 'page' ->> 'nextCursor') -> 'page' ->> 'nextCursor' is null,
  'users page 50 at a time with a cursor');

select pg_temp.ok(public.admin_user(:sup, :mei) ->> 'email' = 'mei9@example.com'
  and public.admin_user(:sup, :mei) -> 'usage' ->> 'storageLimitBytes' = (1000::bigint * 1073741824)::text, 'the detail shows the full address');
select pg_temp.ok(exists (select 1 from public.audit_log where action = 'users.viewed' and target = 'a9000000-0000-0000-0000-000000000011'
                           and actor = 'a9000000-0000-0000-0000-000000000005'), 'viewing the detail is logged');
select pg_temp.ok(public.admin_user(:sup, :adm) is null, 'staff accounts have no member detail');

-- Overrides
select pg_temp.ok(public.admin_user_override(:sup, :jun, 'pro', null, 'Comp for a photographer') ->> 'error' = 'forbidden', 'Support can''t override plans');
select pg_temp.ok(public.admin_user_override(:fin, :jun, 'pro', now() + interval '3 years', 'Too long') ->> 'error' = 'invalid', 'an override over 2 years is refused');
select pg_temp.ok(public.admin_user_override(:fin, :jun, 'pro', null, 'x') ->> 'error' = 'invalid', 'a reason is required');
select pg_temp.ok(public.admin_user_override(:fin, :jun, 'pro', now() + interval '30 days', 'Comp for a photographer') -> 'override' ->> 'plan' = 'pro', 'Finance overrides a plan');
select pg_temp.ok((select plan_id = 'pro' and plan_source = 'admin' from public.profiles where id = :jun) and public._plan_effective(:jun) = 'pro'
  and public._stripe_plan(:jun) = 'free', 'the override sets an admin-sourced plan; Stripe still says free');
select pg_temp.ok(exists (select 1 from public.credit_ledger where owner_id = :jun and reason = 'plan_change'), 'the upgrade adds the monthly credit difference');
select pg_temp.ok(exists (select 1 from public.audit_log where action = 'users.override' and target = 'a9000000-0000-0000-0000-000000000012' and kind = 'users'
                           and details ->> 'reason' = 'Comp for a photographer'), 'the override is audited with its reason');
update public.profiles set plan_override_until = now() - interval '1 minute' where id = :jun;
select pg_temp.ok(public._plan_effective(:jun) = 'free', 'an expired override no longer counts');
select public.admin_overrides_expire() as n \gset
select pg_temp.ok(:n = 1 and (select plan_id = 'free' and plan_source = 'stripe' and plan_override_plan is null from public.profiles where id = :jun),
  'the cron ends expired overrides and the plan goes back to what Stripe says');
select public.admin_user_override(:adm, :jun, 'studio', null, 'Partner account');
select public.admin_user_override_end(:adm, :jun, 'Partnership ended') as r \gset
select pg_temp.ok(:'r'::jsonb -> 'override' = 'null'::jsonb
  and (select plan_id = 'free' and plan_source = 'stripe' from public.profiles where id = :jun), 'ending an override returns to the Stripe plan');
select pg_temp.ok((select lapsed_at is not null from public.profiles where id = :jun), 'a paid plan ending starts the retention clock (lapsed_at)');

-- Credits
select pg_temp.ok(public.admin_user_grant_credits(:sup, :jun, 1001, 'Refund for a failed batch') ->> 'error' = 'forbidden', 'Support can grant at most 1,000 credits');
select pg_temp.ok(public.admin_user_grant_credits(:fin, :jun, 10, 'Refund for a failed batch') ->> 'error' = 'forbidden', 'Finance can''t grant credits');
select public.admin_user_grant_credits(:sup, :jun, 500, 'Refund for a failed batch') as r \gset
select pg_temp.ok((:'r'::jsonb -> 'usage' ->> 'credits')::int >= 500
  and exists (select 1 from public.credit_ledger where owner_id = :jun and reason = 'admin_adjust' and delta = 500), 'Support grants credits (admin_adjust)');
select pg_temp.ok(public.admin_user_grant_credits(:own, :jun, 50001, 'Too many') ->> 'error' = 'invalid', 'more than 50,000 is refused');

-- Sign out everywhere
insert into auth.sessions (id, user_id) values ('a9500000-0000-0000-0000-000000000001', :jun), ('a9500000-0000-0000-0000-000000000002', :jun);
insert into auth.refresh_tokens (user_id, session_id) values ('a9000000-0000-0000-0000-000000000012', 'a9500000-0000-0000-0000-000000000001');
select pg_temp.ok((public.admin_user(:sup, :jun) -> 'signIn' ->> 'activeSessions')::int = 2, 'the detail counts active sessions');
select public.admin_user_sign_out(:sup, :jun, 'Lost phone') as r \gset
select pg_temp.ok((:'r'::jsonb -> 'signIn' ->> 'activeSessions')::int = 0
  and not exists (select 1 from auth.refresh_tokens where user_id = 'a9000000-0000-0000-0000-000000000012'), 'sign out everywhere ends every session in Auth');

-- Suspension
select public.team_invite_create(:mei, 'invitee9@example.com', 'viewer', pg_temp.h('inv9'));
insert into public.library_members (owner_id, member_id, role) values (:mei, :jun, 'editor');
select pg_temp.ok(public.library_access(:jun, :mei) ->> 'role' = 'editor', 'Jun is on Mei''s team');
insert into auth.sessions (user_id) values (:mei);
select pg_temp.ok(public.admin_user_suspend(:sup, :mei, 'abuse', 'Spam galleries') ->> 'error' = 'forbidden', 'Support can''t suspend');
select pg_temp.ok(public.admin_user_suspend(:saf, :mei, 'bogus', 'Spam galleries') ->> 'error' = 'invalid', 'unknown categories are refused');
select public.admin_user_suspend(:saf, :mei, 'abuse', 'Spam galleries') as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'status' = 'suspended' and :'r'::jsonb -> 'suspension' ->> 'category' = 'abuse'
  and :'r'::jsonb ->> 'email' = 'mei9@example.com', 'Safety suspends an account (the detail has the address for the notice)');
select pg_temp.ok(public.member_suspended(:mei) and not public.member_suspended(:jun)
  and (public.get_session_profile(:mei) ->> 'suspended')::boolean and public.get_session_profile(:jun) -> 'retention' = 'null'::jsonb,
  'member_suspended and the session profile report it');
select pg_temp.ok(not exists (select 1 from auth.sessions where user_id = :mei), 'suspension ends every session');
select pg_temp.ok((select sharing_suspended_at is not null from public.profiles where id = :mei), 'suspension takes shared galleries offline');
select pg_temp.ok(public.library_access(:jun, :mei) is null and public.library_access(:mei, :mei) is not null
  and not exists (select 1 from jsonb_array_elements(public.list_libraries(:jun)) e where e ->> 'ownerId' = 'a9000000-0000-0000-0000-000000000011'),
  'teammates lose access to a suspended owner''s library');
select pg_temp.ok((select i.revoked_at is not null from public.invites i join public.team_invites t on t.invite_id = i.id where t.owner_id = :mei),
  'a suspended owner''s open team invites are revoked');
select pg_temp.ok(public.admin_user_sharing_lift(:saf, :mei, 'Reviewed') ->> 'error' = 'conflict', 'sharing can''t be lifted while the account is suspended');
select public.admin_user_unsuspend(:saf, :mei, 'Appeal accepted') as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'status' = 'active'
  and not public.member_suspended(:mei) and (select sharing_suspended_at is null from public.profiles where id = :mei)
  and public.library_access(:jun, :mei) is not null, 'unsuspending restores the account, its sharing and the team');

-- Deletion by staff
select pg_temp.ok(public.admin_user_deletion_schedule(:adm, :jun, 'Legal request') ->> 'error' = 'forbidden', 'only an Owner schedules a deletion');
select public.admin_user_deletion_schedule(:own, :jun, 'Legal request') as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'deletionDueAt' is not null and :'r'::jsonb ? 'stripeSubscriptionId'
  and (select deletion_by_staff = :own from public.profiles where id = :jun), 'an Owner schedules a deletion');
select coalesce(public.restore_account(:jun)::text, 'null') as r \gset
select pg_temp.ok(:'r' = 'null' and (select deletion_due is not null from public.profiles where id = :jun),
  'the member can''t undo a deletion staff scheduled');
select pg_temp.ok(public.admin_user_deletion_cancel(:own, :jun, 'Request withdrawn') ->> 'deletionDueAt' is null, 'an Owner can cancel it');
select public.request_account_deletion(:jun);
select coalesce(public.restore_account(:jun)::text, 'null') as r \gset
select pg_temp.ok(:'r' = 'true' and (select deletion_due is null from public.profiles where id = :jun), 'a member''s own deletion request is still restorable');

-- ---- Safety ------------------------------------------------------------------------------------------
select pg_temp.photo(:mei, 's1.jpg') as s1 \gset
select pg_temp.photo(:mei, 's2.jpg') as s2 \gset
select pg_temp.photo(:mei, 's3.jpg') as s3 \gset
select pg_temp.ok(pg_temp.gallery(:mei, 'a9600000-0000-0000-0000-000000000001', 'tok-safety-9', array[:'s1', :'s2', :'s3']::uuid[]) ->> 'error' is null, 'a gallery to report');
insert into public.gallery_reports (id, gallery_id, owner_id, photo_id, reason, details, network_hash, created_at) values
  ('a9700000-0000-0000-0000-000000000001', 'a9600000-0000-0000-0000-000000000001', :mei, :'s1', 'violence', 'Graphic photo', pg_temp.h('n1'), now() - interval '30 hours'),
  ('a9700000-0000-0000-0000-000000000002', 'a9600000-0000-0000-0000-000000000001', :mei, :'s2', 'violence', null, pg_temp.h('n2'), now() - interval '2 hours'),
  ('a9700000-0000-0000-0000-000000000003', null, :jun, null, 'privacy', 'My face', pg_temp.h('n3'), now() - interval '1 hour');
update public.photos set safety_hold_at = now(), safety_hold_source = 'csam_scan' where id = :'s2';
select pg_temp.ok(public.admin_safety(:sup, 'open') ->> 'error' = 'forbidden', 'Support can''t see Safety');
select pg_temp.ok((public.admin_safety(:adm, 'open') -> 'kpis' ->> 'open')::int = 2 and (public.admin_safety(:adm, 'open') -> 'kpis' ->> 'olderThan24h')::int = 1
  and (public.admin_safety(:adm, 'open') -> 'kpis' ->> 'holds')::int = 1, 'reports are grouped by gallery; KPIs count groups and holds');
select pg_temp.ok((select (e ->> 'count')::int = 2 and e ->> 'id' = 'a9700000-0000-0000-0000-000000000001' and e ->> 'galleryState' = 'live'
                     and jsonb_array_length(e -> 'photoIds') = 2
                     from jsonb_array_elements(public.admin_safety(:adm, 'open') -> 'reports') e where e ->> 'galleryId' is not null),
  'a gallery''s reports form one row (id = earliest, photos merged)');
select pg_temp.ok(public.admin_report(:adm, 'a9700000-0000-0000-0000-000000000002') -> 'details' = '["Graphic photo"]'::jsonb
  and public.admin_report(:adm, 'a9700000-0000-0000-0000-000000000001') -> 'heldPhotoIds' = jsonb_build_array(:'s2')
  and public.admin_report(:adm, 'a9700000-0000-0000-0000-000000000001') ->> 'ownerPlan' = 'studio', 'the report detail: reporters'' words, held photos, plan');
select pg_temp.ok((select e ->> 'source' = 'csam_scan' and e ->> 'reportedAt' is null from jsonb_array_elements(public.admin_safety(:adm, 'open') -> 'holds') e),
  'holds are listed with their source');

-- Reveal
select pg_temp.ok(public.admin_reveal(:adm, 'a9700000-0000-0000-0000-000000000001', 'Review graphic report', pg_temp.h('g1')) ->> 'error' = 'forbidden',
  'only Safety reveals');
select public.admin_reveal(:saf, 'a9700000-0000-0000-0000-000000000001', 'Review graphic report', pg_temp.h('g1')) as rv \gset
select pg_temp.ok((:'rv'::jsonb -> 'photoIds') = jsonb_build_array(:'s1')
  and (:'rv'::jsonb ->> 'expiresAt')::timestamptz between now() + interval '9 minutes' and now() + interval '11 minutes',
  'a reveal grant lasts 10 minutes and never includes a held photo');
select pg_temp.ok(public.reveal_grant_check((:'rv'::jsonb ->> 'grantId')::uuid, pg_temp.h('g1'), :saf, :'s1')
  = jsonb_build_object('key', 'u/' || :mei || '/p/' || :'s1' || '/preview', 'storeId', 'r2'),
  'the grant opens its photo''s preview (key and store) for its staff member');
select pg_temp.ok(public.reveal_grant_check((:'rv'::jsonb ->> 'grantId')::uuid, pg_temp.h('g1'), :own, :'s1') is null
  and public.reveal_grant_check((:'rv'::jsonb ->> 'grantId')::uuid, pg_temp.h('other'), :saf, :'s1') is null
  and public.reveal_grant_check((:'rv'::jsonb ->> 'grantId')::uuid, pg_temp.h('g1'), :saf, :'s2') is null
  and public.reveal_grant_check((:'rv'::jsonb ->> 'grantId')::uuid, pg_temp.h('g1'), :saf, :'s3') is null,
  'the grant is bound to one staff member, its token and its photos');
update public.photos set safety_hold_at = now(), safety_hold_source = 'staff' where id = :'s1';
select pg_temp.ok(public.reveal_grant_check((:'rv'::jsonb ->> 'grantId')::uuid, pg_temp.h('g1'), :saf, :'s1') is null, 'a photo put on hold after the grant is no longer revealable');
set local zephyr.safety_release = 'on';
update public.photos set safety_hold_at = null, safety_hold_source = null where id = :'s1';
reset zephyr.safety_release;
update public.reveal_grants set expires_at = now() - interval '1 second';
select pg_temp.ok(public.reveal_grant_check((:'rv'::jsonb ->> 'grantId')::uuid, pg_temp.h('g1'), :saf, :'s1') is null, 'an expired grant opens nothing');
select pg_temp.ok(exists (select 1 from public.audit_log where action = 'safety.reveal' and kind = 'safety' and details ->> 'reason' = 'Review graphic report'),
  'reveals are audited with a reason');
update public.photos set safety_hold_at = now() where id = :'s1';
select pg_temp.ok(public.admin_reveal(:saf, 'a9700000-0000-0000-0000-000000000002', 'Review again', pg_temp.h('g2')) ->> 'error' = 'nothing_to_reveal',
  'nothing to reveal when every reported photo is held');
set local zephyr.safety_release = 'on';
update public.photos set safety_hold_at = null where id = :'s1';
reset zephyr.safety_release;

-- Resolve
select pg_temp.ok(public.admin_report_resolve(:saf, 'a9700000-0000-0000-0000-000000000002', array['nuke'], 'Bad') ->> 'error' = 'invalid', 'unknown actions are refused');
select pg_temp.ok(public.admin_report_resolve(:adm, 'a9700000-0000-0000-0000-000000000002', array['remove_photos'], 'Removed') ->> 'error' = 'forbidden',
  'only Safety resolves');
select public.admin_report_resolve(:saf, 'a9700000-0000-0000-0000-000000000002', array['remove_photos', 'hold_photos'], 'Graphic content') as r \gset
select pg_temp.ok((:'r'::jsonb -> 'kpis' ->> 'open')::int = 1,
  'resolving one report resolves its gallery group');
select pg_temp.ok(not exists (select 1 from public.gallery_photos where photo_id = :'s1')
  and (select safety_hold_at is not null and safety_hold_source = 'staff' from public.photos where id = :'s1')
  and exists (select 1 from public.gallery_photos where photo_id = :'s3'), 'the actions ran: photos removed and held, others untouched');
select pg_temp.ok((select (e -> 'resolution' ->> 'by') = 'safety9@zephyr.test' and e -> 'resolution' -> 'actions' = '["remove_photos", "hold_photos"]'::jsonb
                     from jsonb_array_elements(public.admin_safety(:saf, 'resolved') -> 'reports') e where e ->> 'galleryId' is not null),
  'the resolution is shown with who did it');
select pg_temp.ok(public.admin_report_resolve(:saf, 'a9700000-0000-0000-0000-000000000001', '{}', 'Again') ->> 'error' = 'conflict', 'a resolved report can''t be resolved again');
select pg_temp.ok((public.admin_report_resolve(:saf, 'a9700000-0000-0000-0000-000000000003', '{}', 'Not a violation') -> 'kpis' ->> 'open')::int = 0, 'an empty action list dismisses');
insert into public.gallery_reports (id, gallery_id, owner_id, reason, network_hash) values
  ('a9700000-0000-0000-0000-000000000004', 'a9600000-0000-0000-0000-000000000001', :mei, 'other', pg_temp.h('n4'));
select public.admin_report_resolve(:saf, 'a9700000-0000-0000-0000-000000000004', array['end_gallery', 'suspend_account'], 'Repeat offender');
select pg_temp.ok((select revoked_at is not null from public.galleries where id = 'a9600000-0000-0000-0000-000000000001') and public.member_suspended(:mei),
  'end_gallery and suspend_account go through the existing functions');
select public.admin_user_unsuspend(:own, :mei, 'Restored after review');

-- Holds
select pg_temp.ok(public.admin_hold_report(:adm, :'s2', 'NCMEC CyberTipline', '12345') ->> 'error' = 'forbidden', 'Admin can''t record hold reports');
select pg_temp.ok((select e ->> 'reportReference' = 'TIP-12345' from jsonb_array_elements(public.admin_hold_report(:saf, :'s2', 'NCMEC CyberTipline', 'TIP-12345') -> 'holds') e
                    where e ->> 'photoId' = :'s2'), 'Safety records the report made for a hold');
do $$ begin
  begin
    update public.photos set safety_hold_at = null where id = (select photo_id from public.safety_hold_reports limit 1);
    raise exception 'FAILED: hold lifted directly';
  exception when check_violation then raise notice 'ok - a hold still can''t be lifted outside admin_hold_release';
  end;
end $$;
select pg_temp.ok(public.admin_hold_release(:saf, :'s2', 'False positive') ->> 'error' = 'forbidden', 'only an Owner releases a hold');
select public.admin_hold_release(:own, :'s2', 'Confirmed false positive') as r \gset
select pg_temp.ok(:'r' <> ''
  and (select safety_hold_at is null from public.photos where id = :'s2') and coalesce(current_setting('zephyr.safety_release', true), '') = '',
  'an Owner releases a hold (and the release flag doesn''t linger)');

-- ---- Plan limits --------------------------------------------------------------------------------------
select pg_temp.ok(public.admin_limits(:sup) ->> 'error' = 'forbidden' and public.admin_limits(:adm) -> 'active' ->> 'version' = '1'
  and public.admin_limits(:adm) -> 'active' -> 'limits' -> 'free' ->> 'storageGb' = '5'
  and public.admin_limits(:adm) -> 'active' -> 'limits' -> 'studio' ->> 'guestFavourites' = 'true', 'Admin sees the limits (camelCase PlanLimits)');
select pg_temp.ok(public.admin_limits_draft_create(:adm, 1) ->> 'error' = 'forbidden', 'Admin can''t edit limits');
select pg_temp.ok(public.admin_limits_draft_create(:fin, 1) -> 'draft' ->> 'status' = 'draft', 'Finance starts a draft from version 1');
select pg_temp.ok(public.admin_limits_draft_create(:fin, 1) ->> 'error' = 'conflict', 'one draft at a time');
select public.admin_limits(:fin) -> 'active' -> 'limits' as lim \gset
select pg_temp.ok(public.admin_limits_draft_save(:fin, jsonb_set(:'lim'::jsonb, '{free,batchSize}', '5000')) ->> 'error' = 'invalid', 'table checks still apply to drafts');
select pg_temp.ok(public.admin_limits_draft_save(:fin, jsonb_set(jsonb_set(:'lim'::jsonb, '{free,storageGb}', '4'), '{pro,storageGb}', '300'))
  -> 'draft' -> 'limits' -> 'free' ->> 'storageGb' = '4', 'Finance saves the draft');
select public.admin_limits_preview(:fin, null) as pv \gset
select pg_temp.ok((:'pv'::jsonb ->> 'decreases')::boolean and jsonb_array_length(:'pv'::jsonb -> 'changes') = 2
  and (select e ->> 'direction' = 'down' and e ->> 'from' = '5' and e ->> 'to' = '4' from jsonb_array_elements(:'pv'::jsonb -> 'changes') e where e ->> 'plan' = 'free')
  and (select e ->> 'direction' = 'up' from jsonb_array_elements(:'pv'::jsonb -> 'changes') e where e ->> 'plan' = 'pro')
  and (:'pv'::jsonb ->> 'earliestEffectiveAt')::timestamptz > now() + interval '29 days', 'the preview lists changes and finds the decrease');
select pg_temp.ok(public._limits_changes(1, 1) = '[]'::jsonb, 'no changes between a version and itself');
select pg_temp.ok(public.admin_limits_schedule(:fin, null, 'Cut free storage') ->> 'error' = 'too_soon'
  and public.admin_limits_schedule(:fin, now() + interval '10 days', 'Cut free storage') ->> 'error' = 'too_soon',
  'a decrease needs a date at least 30 days ahead');
select pg_temp.ok(public.admin_limits_schedule(:fin, now() + interval '31 days', 'Cut free storage') -> 'scheduled' ->> 'status' = 'scheduled', 'scheduled 31 days ahead');
select pg_temp.ok(public.admin_limits(:fin) -> 'active' ->> 'version' = '1' and public.admin_limits(:fin) -> 'draft' = 'null'::jsonb, 'version 1 stays active until the date');
select public.limits_notices_due(1000) as nd \gset
select pg_temp.ok(exists (select 1 from jsonb_array_elements(:'nd'::jsonb) e where e ->> 'userId' = 'a9000000-0000-0000-0000-000000000012'
                           and e ->> 'email' = 'jun9@example.com' and e -> 'changes' = '[{"label": "Storage (GB)", "from": 5, "to": 4}]'::jsonb
                           and e ? 'version' and e ? 'effectiveAt')
  and not exists (select 1 from jsonb_array_elements(:'nd'::jsonb) e where e ->> 'userId' in ('a9000000-0000-0000-0000-000000000011', 'a9000000-0000-0000-0000-000000000001')),
  'members on a plan with a decrease get a notice with their plan''s changes; others and staff don''t');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.limits_notices_due(1000)) e where e ->> 'userId' = 'a9000000-0000-0000-0000-000000000012'),
  'notices are claimed: never handed out twice');
select pg_temp.ok(public.limits_activate_due() = 0, 'nothing activates before the date');
select public.admin_limits_cancel(:fin, 'Changed our mind') as r \gset
select pg_temp.ok(:'r'::jsonb -> 'scheduled' = 'null'::jsonb
  and public.admin_limits(:fin) -> 'history' -> 0 ->> 'status' = 'cancelled', 'cancelling saves at once and stays in history');
select public.admin_limits_draft_create(:own, 1);
select public.admin_limits_draft_save(:own, jsonb_set(:'lim'::jsonb, '{pro,storageGb}', '300'));
select public.admin_limits_schedule(:own, null, 'More Pro storage') as r \gset
select pg_temp.ok(:'r'::jsonb -> 'active' -> 'limits' -> 'pro' ->> 'storageGb' = '300'
  and (select storage_bytes from public._plan_rules('pro')) = 300::bigint * 1073741824, 'an increase can apply now');
select public.admin_limits_draft_create(:own, (public.admin_limits(:own) -> 'active' ->> 'version')::int);
select public.admin_limits_draft_save(:own, jsonb_set(public.admin_limits(:own) -> 'active' -> 'limits', '{pro,seats}', '2'));
select public.admin_limits_schedule(:own, now() + interval '30 days', 'Pro gets a seat') as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'decreases' = 'false' and (:'r'::jsonb ->> 'version')::int > 1 and :'r'::jsonb ? 'effectiveAt',
  'scheduling returns the version, date and whether it decreases anything');
update public.plan_limit_versions set effective_at = now() - interval '1 second' where status = 'scheduled';
select public.limits_activate_due() as r \gset
select pg_temp.ok(:r = 1 and public._plan_seats('pro') = 2
  and (select count(*) = 1 from public.plan_limit_versions where status = 'active'), 'the cron activates a scheduled version on its date');
select pg_temp.ok(exists (select 1 from public.audit_log where action = 'limits.schedule' and kind = 'limits'), 'scheduling is audited');

-- ---- Ads ---------------------------------------------------------------------------------------------
select pg_temp.ok(public.admin_ads(:fin) ->> 'error' = 'forbidden', 'Finance can''t manage ads');
select pg_temp.ok(public.admin_ad_card_save(:adm, null, '{"advertiser":"Lens Co","headline":"Primes","body":"Sharp","url":"http://lens.example","placements":["library"]}') ->> 'error' = 'invalid'
  and public.admin_ad_card_save(:adm, null, '{"advertiser":"Lens Co","headline":"Primes","body":"Sharp","url":"https://u:p@lens.example","placements":["library"]}') ->> 'error' = 'invalid'
  and public.admin_ad_card_save(:adm, null, '{"advertiser":"Lens Co","headline":"Primes","body":"Sharp","url":"https://lens.example","placements":["popup"]}') ->> 'error' = 'invalid',
  'cards need an https URL without credentials and known placements');
select public.admin_ad_card_save(:adm, null, '{"advertiser":"Lens Co","headline":"Primes","body":"Sharp primes","url":"https://lens.example/primes","placements":["library","sidebar"],"weight":60}') ->> 'cardId' as card \gset
select pg_temp.ok((select e ->> 'status' = 'draft' from jsonb_array_elements(public.admin_ads(:adm) -> 'cards') e where e ->> 'id' = :'card'), 'a new card is a draft');
select pg_temp.ok(public.ads_for_member(:jun) -> 'cards' = '[]'::jsonb, 'drafts aren''t shown');
select public.admin_ad_card_save(:adm, :'card', jsonb_build_object('status', 'scheduled', 'startsAt', now() - interval '1 hour', 'endsAt', now() + interval '7 days'));
select pg_temp.ok((select e ->> 'status' = 'live' from jsonb_array_elements(public.admin_ads(:adm) -> 'cards') e where e ->> 'id' = :'card')
  and public.ads_for_member(:jun) -> 'cards' -> 0 ->> 'id' = :'card' and public.ads_for_member(:jun) -> 'adsense' = 'null'::jsonb,
  'a card in its window is live for Free members');
select pg_temp.ok(public.ads_for_member(:mei) -> 'cards' = '[]'::jsonb, 'plans without ads see none');
select pg_temp.ok(public.ad_event(:adsu, pg_temp.h('seen-i'), :'card', 'impression', 'library')
  and public.ad_event(:adsu, pg_temp.h('seen-c'), :'card', 'click', 'library')
  and not public.ad_event(:adsu, pg_temp.h('seen-b'), :'card', 'impression', 'batch')
  and not public.ad_event(:adsu, pg_temp.h('seen-v'), :'card', 'view', 'library'),
  'events count only for a live card''s placements');
select pg_temp.ok(not public.ad_event(:adsu, pg_temp.h('seen-i'), :'card', 'impression', 'library')
  and not public.ad_event(:adsu, pg_temp.h('seen-c'), :'card', 'click', 'library'),
  'one impression and one click per member, card and day (the same key counts once)');
select pg_temp.ok(not public.ad_event(:mei, pg_temp.h('seen-mei'), :'card', 'impression', 'library')
  and not public.ad_event(:adsu, substr(pg_temp.h('short'), 1, 16), :'card', 'impression', 'library')
  and not public.ad_event('a9000000-0000-0000-0000-0000000000ff', pg_temp.h('seen-nobody'), :'card', 'impression', 'library'),
  'members without ads (and unknown members or malformed keys) can''t count events');
select pg_temp.ok((select count(*) = 2 from public.ad_event_seen) and not exists (
    select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ad_event_seen' and column_name not in ('h', 'day')),
  'the dedup table holds only keyed hashes and a day, never a member id');
select pg_temp.ok((select e -> 'stats7d' = '{"impressions": 1, "clicks": 1}'::jsonb from jsonb_array_elements(public.admin_ads(:adm) -> 'cards') e where e ->> 'id' = :'card'),
  'seven-day stats per card');
select pg_temp.ok(public.ad_image_key(:'card', 1) is null, 'no image key before an image is set');
select pg_temp.ok(public.admin_ad_image_set(:adm, :'card', 'ads/a9000000-0000-0000-0000-000000000000/x.jpg') ->> 'error' = 'invalid', 'an image key must be under the card''s prefix');
select public.admin_ad_image_set(:adm, :'card', 'ads/' || :'card' || '/a1.jpg') as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'version' = '1' and :'r'::jsonb -> 'oldKey' = 'null'::jsonb, 'the first image is version 1');
select public.admin_ad_image_set(:adm, :'card', 'ads/' || :'card' || '/b2.jpg') as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'version' = '2' and :'r'::jsonb ->> 'oldKey' = 'ads/' || :'card' || '/a1.jpg'
  and public.ad_image_key(:'card', 2) = 'ads/' || :'card' || '/b2.jpg' and public.ad_image_key(:'card', 1) is null,
  'a new image bumps the version and returns the old key to delete');
select pg_temp.ok(public.admin_adsense_set(:adm, '{"enabled": true}', 'Turn on AdSense') ->> 'error' = 'forbidden', 'only an Owner turns on AdSense');
select pg_temp.ok(public.admin_adsense_set(:own, '{"enabled": true}', 'Turn on AdSense') ->> 'error' = 'invalid', 'AdSense needs a publisher id first');
select pg_temp.ok(public.admin_adsense_set(:adm, '{"publisherId": "ca-pub-12"}', 'Set id') ->> 'error' = 'invalid'
  and public.admin_adsense_set(:adm, '{"slots": {"library": "abc"}}', 'Set slot') ->> 'error' = 'invalid', 'publisher and slot ids are checked');
select public.admin_adsense_set(:adm, '{"publisherId": "ca-pub-1234567890123456", "slots": {"library": "1234567890"}}', 'Prepare AdSense');
select public.admin_adsense_set(:own, '{"enabled": true}', 'Risk accepted') as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'enabled' = 'true'
  and public.admin_ads(:own) -> 'adsense' ->> 'enabledBy' = 'Olivia Owner'
  and public.ads_for_member(:adsu) -> 'adsense' = '{"publisherId": "ca-pub-1234567890123456", "slots": {"library": "1234567890"}}'::jsonb
  and (public.adsense_public() ->> 'enabled')::boolean, 'an Owner turns AdSense on; Free members get it');
select pg_temp.ok(public.ads_for_member(:jun) -> 'adsense' = 'null'::jsonb and jsonb_array_length(public.ads_for_member(:jun) -> 'cards') = 1,
  'a Free member of any team library gets sponsored cards but never AdSense');
select pg_temp.ok((public.admin_adsense_set(:adm, '{"enabled": false}', 'Pause AdSense') -> 'adsense' ->> 'enabled')::boolean = false, 'turning it off saves at once (Admin)');
select pg_temp.ok(exists (select 1 from public.audit_log where action = 'ads.adsense' and kind = 'ads'), 'AdSense changes are audited');
update public.ad_cards set ends_at = now() - interval '1 second' where id = :'card';
insert into public.ad_event_seen (h, day) values (pg_temp.h('old-day'), (now() at time zone 'utc')::date - 2),
  (pg_temp.h('yesterday'), (now() at time zone 'utc')::date - 1);
select public.ad_status_tick() as n \gset
select pg_temp.ok(not exists (select 1 from public.ad_event_seen where h = pg_temp.h('old-day'))
  and exists (select 1 from public.ad_event_seen where h = pg_temp.h('yesterday')), 'the daily tick forgets dedup keys after two days');
select pg_temp.ok(:n = 1 and public.ads_for_member(:jun) -> 'cards' = '[]'::jsonb, 'ended cards stop showing');
select pg_temp.ok(public.admin_ad_card_delete(:adm, :'card') ->> 'imageKey' = 'ads/' || :'card' || '/b2.jpg', 'deleting a card returns its image key for clean-up');

-- ---- Retention ---------------------------------------------------------------------------------------
update public.profiles set plan_id = 'pro' where id = :ret;
update public.profiles set plan_id = 'free' where id = :ret;
select pg_temp.ok((select lapsed_at is not null from public.profiles where id = :ret), 'the lapse date is set when a paid plan ends');
update public.profiles set lapsed_at = now() - interval '400 days' where id = :ret;
select pg_temp.photo(:ret, 'r1.jpg', 2147483648, '2020-01-01') as r1 \gset
select pg_temp.photo(:ret, 'r2.jpg', 2147483648, '2021-01-01') as r2 \gset
select pg_temp.photo(:ret, 'r3.jpg', 2147483648, '2022-01-01') as r3 \gset
select pg_temp.photo(:ret, 'r4.jpg', 2147483648, '2023-01-01') as r4 \gset
select pg_temp.photo(:ret, 'r5.jpg', 1073741824, '2024-01-01') as r5 \gset
update public.photos set safety_hold_at = now(), safety_hold_source = 'csam_scan' where id = :'r2';
update public.profiles set sharing_suspended_at = null where id = :ret;
select pg_temp.ok(pg_temp.gallery(:ret, 'a9600000-0000-0000-0000-000000000002', 'tok-ret-9', array[:'r3']::uuid[]) ->> 'error' is null, 'a live gallery on the lapsed library');
select pg_temp.ok(public._retention_over(:ret) = 4::bigint * 1073741824, '4 GB over the Free storage');
select pg_temp.ok((select array_agg(photo_id order by photo_id) from public._retention_pick(:ret)) = (select array_agg(x order by x) from unnest(array[:'r1', :'r4']::uuid[]) x),
  'the oldest photos covering the excess are picked, skipping held and live-gallery photos');
select public.retention_sweep();
select pg_temp.ok((select state = 'waiting' and photos_to_trash = 2 from public.retention_items where owner_id = :ret), 'the sweep tracks the library');
select pg_temp.ok(public.admin_retention(:fin) ->> 'error' = 'forbidden'
  and (select e ->> 'state' = 'waiting' and (e ->> 'photosToTrash')::int = 2 from jsonb_array_elements(public.admin_retention(:adm) -> 'items') e where e ->> 'ownerId' = :ret),
  'Admin sees the retention list');
select public.retention_notices_due(100) as rn \gset
select pg_temp.ok((select e ->> 'notice' = 'd30' and e ->> 'email' = 'ret9@example.com' and (e ->> 'photos')::int = 2
                     and (e ->> 'dueAt')::timestamptz > now() + interval '29 days'
                     from jsonb_array_elements(:'rn'::jsonb) e where e ->> 'ownerId' = :ret),
  'the 30-day notice goes first, and a late one pushes the due date so the member gets 30 days');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.retention_notices_due(100)) e where e ->> 'ownerId' = :ret),
  'notices are claimed; the 7-day one isn''t due yet');
select public.retention_sweep();
select pg_temp.ok((select state = 'waiting' from public.retention_items where owner_id = :ret), 'not ready while the notice period runs');
update public.retention_items set due_at = now() + interval '6 days', notice_30_at = now() - interval '24 days' where owner_id = :ret;
select public.retention_notices_due(100) as rn \gset
select pg_temp.ok((select e ->> 'notice' = 'd7' from jsonb_array_elements(:'rn'::jsonb) e where e ->> 'ownerId' = :ret)
  and (select notice_7_at is not null and due_at > now() + interval '6 days' from public.retention_items where owner_id = :ret), 'then the 7-day notice');
update public.retention_items set due_at = now() - interval '1 minute' where owner_id = :ret;
select public.retention_sweep();
select pg_temp.ok((select state = 'ready' from public.retention_items where owner_id = :ret), 'ready once due with both notices sent');
select pg_temp.ok(public.retention_trash_batch(:ret, 100) is null, 'nothing is trashed without approval');
select pg_temp.ok(public.admin_retention_approve(:sup, array[:ret]::uuid[], 'Approve batch') ->> 'error' = 'forbidden', 'Support can''t approve');
select pg_temp.ok((public.admin_retention_approve(:adm, array[:ret]::uuid[], 'Approve batch') ->> 'approved')::int = 1
  and (public.admin_retention_approve(:adm, array[:ret]::uuid[], 'Approve batch') ->> 'approved')::int = 0, 'Admin approves once');
select pg_temp.ok(:ret::uuid = any (public.retention_approved_due(10)), 'approved items are due for trashing');
select public.retention_trash_batch(:ret, 1) as rb \gset
select pg_temp.ok((:'rb'::jsonb ->> 'trashed')::int = 1 and not (:'rb'::jsonb ->> 'done')::boolean, 'trashing runs in batches');
select public.retention_trash_batch(:ret, 100) as rb \gset
select pg_temp.ok((:'rb'::jsonb ->> 'done')::boolean and :'rb'::jsonb ->> 'email' = 'ret9@example.com', 'the last batch reports done (and the address for the email)');
select pg_temp.ok(public.retention_trash_batch(:ret, 100) is null, 'trashing again does nothing');
select pg_temp.ok((select array_agg(status order by taken_at) from public.photos where owner_id = :ret) = array['trashed', 'ready', 'ready', 'trashed', 'ready'],
  'the oldest eligible photos are in Trash; held and gallery photos stay');
select pg_temp.ok((select purge_after > now() + interval '29 days' from public.photos where id = :'r1'), 'the usual 30-day Trash undo applies');
select pg_temp.ok(public.retention_notice(:ret) ->> 'photos' = '2' and (public.retention_notice(:ret) ->> 'restoreBy')::timestamptz > now() + interval '29 days'
  and public.retention_notice(:jun) is null and public.get_session_profile(:ret) -> 'retention' ->> 'photos' = '2',
  'the member''s own retention batch for /me');
select public.retention_sweep();
select pg_temp.ok((select state = 'trashed' from public.retention_items where owner_id = :ret), 'a trashed batch stays trashed during its undo window');
update public.profiles set plan_id = 'pro' where id = :ret;
select pg_temp.ok((select lapsed_at is null from public.profiles where id = :ret), 'a paid plan again clears the lapse date');

-- ---- Staff -------------------------------------------------------------------------------------------
select pg_temp.ok(public.admin_staff(:adm) ->> 'error' = 'forbidden', 'only an Owner manages staff');
select pg_temp.ok(jsonb_array_length(public.admin_staff(:own) -> 'staff') = 5 and public.admin_staff(:own) -> 'staff' -> 0 ->> 'role' = 'owner', 'the staff list, Owners first');
select pg_temp.ok(public.admin_staff_invite(:own, 'mei9@example.com', 'support', pg_temp.h('si0'), 'New support hire') ->> 'error' = 'member_account'
  and public.admin_staff_invite(:own, 'admin9@zephyr.test', 'support', pg_temp.h('si0'), 'New support hire') ->> 'error' = 'already_staff'
  and public.admin_staff_invite(:own, 'not-an-email', 'support', pg_temp.h('si0'), 'New support hire') ->> 'error' = 'invalid',
  'member accounts, existing staff and bad addresses can''t be invited');
select public.admin_staff_invite(:own, 'New.Staff9@Zephyr.test', 'safety', pg_temp.h('si1'), 'New safety reviewer') as r \gset
select pg_temp.ok(:'r'::jsonb -> 'invites' -> 0 ->> 'email' = 'new.staff9@zephyr.test' and :'r'::jsonb ->> 'id' = :'r'::jsonb -> 'invites' -> 0 ->> 'id'
  and (:'r'::jsonb ->> 'expiresAt')::timestamptz between now() + interval '71 hours' and now() + interval '73 hours', 'an Owner invites staff (72 hours)');
select pg_temp.ok(not exists (select 1 from public.audit_log where action = 'staff.invite' and target like '%new.staff9%'), 'the audit target masks the address');
select pg_temp.ok(public.hook_before_user_created('{"user": {"email": "new.staff9@zephyr.test"}}'::jsonb) = '{}'::jsonb
  and public.hook_before_user_created('{"user": {"email": "random9@zephyr.test"}}'::jsonb) ? 'error', 'the sign-up hook lets a live staff invite through, nobody else');
select public.staff_invite_accept(pg_temp.h('si1')) as acc \gset
select pg_temp.ok(:'acc'::jsonb ->> 'role' = 'safety' and :'acc'::jsonb ->> 'email' = 'new.staff9@zephyr.test' and public.staff_invite_accept(pg_temp.h('nope')) is null,
  'the invite link resolves (checks only)');
select pg_temp.ok(public.staff_invite_accept(pg_temp.h('si1')) ->> 'inviteId' = :'acc'::jsonb ->> 'inviteId', 'checking doesn''t use the invite up');
insert into auth.users (id, email) values ('a9000000-0000-0000-0000-000000000006', 'new.staff9@zephyr.test');
select pg_temp.ok(public.staff_invite_accept(pg_temp.h('si1')) ->> 'error' = 'account_exists', 'an address that already has an account is refused at the link');
select pg_temp.ok(public.staff_invite_complete((:'acc'::jsonb ->> 'inviteId')::uuid, :mei) is null, 'the invite is bound to its address');
select public.staff_invite_complete((:'acc'::jsonb ->> 'inviteId')::uuid, 'a9000000-0000-0000-0000-000000000006') as r \gset
select pg_temp.ok(:'r'::jsonb ->> 'role' = 'safety'
  and public._staff_role_of('a9000000-0000-0000-0000-000000000006') = 'safety', 'completing the invite makes them staff');
select pg_temp.ok(public.staff_invite_complete((:'acc'::jsonb ->> 'inviteId')::uuid, 'a9000000-0000-0000-0000-000000000006') is null
  and public.staff_invite_accept(pg_temp.h('si1')) is null, 'an invite is used once');
select public.admin_staff_invite(:own, 'expired9@zephyr.test', 'support', pg_temp.h('si2'), 'Temp');
update public.staff_invites set expires_at = now() - interval '1 second' where email = 'expired9@zephyr.test';
select pg_temp.ok(public.staff_invite_accept(pg_temp.h('si2')) is null and not (public.hook_before_user_created('{"user": {"email": "expired9@zephyr.test"}}'::jsonb) = '{}'::jsonb),
  'expired invites open nothing');
select public.admin_staff_invite(:own, 'revoked9@zephyr.test', 'support', pg_temp.h('si3'), 'Temp');
select public.admin_staff_invite_revoke(:own, (select id from public.staff_invites where email = 'revoked9@zephyr.test')) as r \gset
select pg_temp.ok(:'r' <> ''
  and public.staff_invite_accept(pg_temp.h('si3')) is null, 'revoked invites open nothing');
select pg_temp.ok(public.admin_staff_set_role(:own, :own, 'admin', 'Step down') ->> 'error' = 'last_owner'
  and public.admin_staff_remove(:own, :own, 'Leaving') ->> 'error' = 'last_owner', 'the last Owner can''t be demoted or removed');
select public.admin_staff_set_role(:own, :adm, 'owner', 'Second owner');
select public.admin_staff_set_role(:adm, :own, 'admin', 'Swap roles') as r \gset
select pg_temp.ok(:'r'::jsonb -> 'staff' is not null and public._staff_role_of(:own) = 'admin', 'with two Owners, one can step down');
select pg_temp.ok(public.admin_staff_set_role(:own, :adm, 'admin', 'Nope') ->> 'error' = 'forbidden', 'an Admin can''t change roles');
insert into auth.sessions (user_id) values (:sup);
select public.admin_staff_remove(:adm, :sup, 'Contract ended') as r \gset
select pg_temp.ok(:'r'::jsonb -> 'staff' is not null and public._staff_role_of(:sup) is null
  and public.staff_lookup(:sup) is null and not exists (select 1 from auth.sessions where user_id = :sup), 'removing staff ends their sessions and access');
select public.admin_staff_set_role(:adm, :own, 'owner', 'Back to owner');

-- ---- Audit -------------------------------------------------------------------------------------------
select pg_temp.ok(public.admin_audit(:sup, null, null, null, null, null, null) ->> 'error' = 'forbidden', 'removed staff can''t read the audit log');
select pg_temp.ok(public.admin_audit('a9000000-0000-0000-0000-000000000006', null, null, null, null, null, null) -> 'items' is not null
  and public.admin_audit(:fin, null, null, null, null, null, null) -> 'items' is not null, 'Safety and Finance read the audit log');
select pg_temp.ok((select bool_and(e ->> 'action' like 'safety.%') from jsonb_array_elements(public.admin_audit(:fin, null, 'safety', null, null, null, null) -> 'items') e),
  'filter by kind');
select pg_temp.ok((select bool_and(e -> 'actor' ->> 'role' = 'safety' and e -> 'actor' ->> 'name' = 'safety9@zephyr.test')
                     from jsonb_array_elements(public.admin_audit(:own, :saf, null, null, null, null, null) -> 'items') e), 'filter by actor, with name and role');
select pg_temp.ok((select e -> 'actor' ->> 'role' = 'system' from jsonb_array_elements(public.admin_audit(:own, null, null, null, null, null, null) -> 'items') e
                    where e ->> 'action' = 'retention.trashed' limit 1), 'jobs show as system');
select public.admin_audit(:own, null, null, null, null, null, null) as ap \gset
select pg_temp.ok(jsonb_array_length(:'ap'::jsonb -> 'items') = 50 and :'ap'::jsonb ->> 'nextCursor' is not null
  and (public.admin_audit(:own, null, null, null, null, null, :'ap'::jsonb ->> 'nextCursor') -> 'items' -> 0 ->> 'id')::bigint
      < (:'ap'::jsonb -> 'items' -> 49 ->> 'id')::bigint, 'the audit log pages by id, newest first');
select jsonb_array_length(public.admin_audit_export(:adm, null, 'users', null, null, null)) as n \gset
select pg_temp.ok(public.admin_audit_export(:fin, null, null, null, null, null) ->> 'error' = 'forbidden'
  and :n > 0
  and exists (select 1 from public.audit_log where action = 'audit.exported' and actor = :adm), 'Admin exports (and the export is logged); Finance can''t');

-- ---- Settings and app status ----------------------------------------------------------------------------
select pg_temp.ok(public.app_status() = '{"readOnly": null, "maintenance": null}'::jsonb, 'app status is empty normally');
select pg_temp.ok(public.admin_settings(:fin) ->> 'error' = 'forbidden' and (public.admin_settings(:adm) -> 'access' ->> 'staffTotal')::int = 5, 'Admin reads settings');
select public.admin_settings_set(:adm, '{"readOnly": {"on": true, "message": "Back soon"}}', 'Storage maintenance') as r \gset
select pg_temp.ok(:'r'::jsonb -> 'readOnly' ->> 'on' = 'true'
  and public.app_status() -> 'readOnly' = '{"on": true, "message": "Back soon"}'::jsonb, 'read-only mode on, shown in app status');
select public.read_only_auto(false, 'Store healthy') as r \gset
select pg_temp.ok(not (:'r'::jsonb ->> 'changed')::boolean and (public.app_status() -> 'readOnly' ->> 'on')::boolean,
  'the health check never turns off a manual read-only');
select public.admin_settings_set(:adm, '{"readOnly": {"on": false}}', 'Done');
select public.read_only_auto(true, 'Write store unreachable') as r \gset
select pg_temp.ok((:'r'::jsonb ->> 'changed')::boolean and public.admin_settings(:adm) -> 'readOnly' ->> 'auto' = 'true', 'automatic read-only turns on by itself');
select public.read_only_auto(false, 'Store healthy') as r \gset
select pg_temp.ok((:'r'::jsonb ->> 'changed')::boolean and public.app_status() -> 'readOnly' = 'null'::jsonb, 'and off again (auto only)');
select pg_temp.ok(public.admin_settings_set(:adm, jsonb_build_object('maintenance', jsonb_build_object('on', true, 'message', repeat('x', 201))), 'Too long') ->> 'error' = 'invalid'
  and public.admin_settings_set(:adm, jsonb_build_object('maintenance', jsonb_build_object('startsAt', now() + interval '2 hours', 'endsAt', now() + interval '1 hour')), 'Backwards') ->> 'error' = 'invalid',
  'notices are checked');
select public.admin_settings_set(:adm, jsonb_build_object('maintenance', jsonb_build_object('on', true, 'message', 'Upgrade tonight', 'startsAt', now() + interval '1 hour', 'endsAt', now() + interval '2 hours')), 'Planned upgrade');
select pg_temp.ok(public.app_status() -> 'maintenance' ->> 'message' = 'Upgrade tonight', 'the maintenance notice is public');
select pg_temp.ok(exists (select 1 from public.audit_log where action = 'settings.read_only' and kind = 'settings')
  and exists (select 1 from public.audit_log where action = 'settings.maintenance'), 'settings changes are audited');

-- ---- Gallery link replacement ---------------------------------------------------------------------------
-- (Mei's sharing is still suspended: a photo is on hold since the Safety review. Lifted here to share again.)
update public.profiles set sharing_suspended_at = null where id = :mei;
select pg_temp.gallery(:mei, 'a9600000-0000-0000-0000-000000000003', 'tok-link-old', array[:'s3']::uuid[]);
select pg_temp.gallery(:mei, 'a9600000-0000-0000-0000-000000000004', 'tok-link-old2', array[:'s3']::uuid[]);
update public.galleries set passcode_hmac = pg_temp.h('code'), passcode_generation = 3 where id = 'a9600000-0000-0000-0000-000000000003';
select pg_temp.ok(public.gallery_link_replace(:jun, :jun, 'a9600000-0000-0000-0000-000000000003', pg_temp.h('tok-link-new'), 'tok-link', pg_temp.h('ct:new'), substr(pg_temp.h('iv'), 1, 12)) is null,
  'only the owner''s library can replace its links');
select pg_temp.ok(public.live_gallery_ids(:mei) @> array['a9600000-0000-0000-0000-000000000003', 'a9600000-0000-0000-0000-000000000004']::uuid[]
  and not (public.live_gallery_ids(:mei) @> array['a9600000-0000-0000-0000-000000000001'::uuid]), 'live gallery ids for the team removal flow (ended ones left out)');
select public.gallery_link_replace(:mei, :jun, 'a9600000-0000-0000-0000-000000000003', pg_temp.h('tok-link-new'), 'tok-link', pg_temp.h('ct:new'), substr(pg_temp.h('iv'), 1, 12)) as r \gset
select pg_temp.ok(:'r' = 't' and public.guest_gallery_state(pg_temp.h('tok-link-old')) is null
  and public.guest_gallery_state(pg_temp.h('tok-link-new')) ->> 'id' = 'a9600000-0000-0000-0000-000000000003', 'the old link stops at once');
select pg_temp.ok((select passcode_hmac = pg_temp.h('code') and passcode_generation = 3 from public.galleries where id = 'a9600000-0000-0000-0000-000000000003')
  and exists (select 1 from public.audit_log where action = 'gallery.link_replaced' and actor = :jun), 'the passcode stays; the replacement is audited with who did it');
select pg_temp.ok(public.gallery_link_replace(:mei, :mei, 'a9600000-0000-0000-0000-000000000001', pg_temp.h('tok-x'), 'tok-x', pg_temp.h('ct:x'), substr(pg_temp.h('iv'), 1, 12)) is null,
  'an ended gallery''s link isn''t replaced');
select public.gallery_links_replace(:mei, :mei, jsonb_build_array(
  jsonb_build_object('id', 'a9600000-0000-0000-0000-000000000003', 'tokenHash', '\x' || encode(pg_temp.h('tok-b1'), 'hex'), 'linkHint', 'tok-b1',
                     'ciphertext', '\x' || encode(pg_temp.h('ct:b1'), 'hex'), 'iv', '\x' || encode(substr(pg_temp.h('iv'), 1, 12), 'hex')),
  jsonb_build_object('id', 'a9600000-0000-0000-0000-000000000004', 'tokenHash', encode(pg_temp.h('tok-b2'), 'hex'), 'linkHint', 'tok-b2',
                     'ciphertext', encode(pg_temp.h('ct:b2'), 'hex'), 'iv', encode(substr(pg_temp.h('iv'), 1, 12), 'hex')),
  jsonb_build_object('id', 'a9600000-0000-0000-0000-000000000001', 'tokenHash', encode(pg_temp.h('tok-b3'), 'hex'), 'linkHint', 'tok-b3',
                     'ciphertext', encode(pg_temp.h('ct:b3'), 'hex'), 'iv', encode(substr(pg_temp.h('iv'), 1, 12), 'hex')))) as n \gset
select pg_temp.ok(:n = 2 and public.guest_gallery_state(pg_temp.h('tok-link-new')) is null and public.guest_gallery_state(pg_temp.h('tok-link-old2')) is null
  and public.guest_gallery_state(pg_temp.h('tok-b2')) is not null and public.guest_gallery_state(pg_temp.h('tok-b3')) is null,
  'replacing several links rotates the live ones and skips ended ones');
do $$ begin
  begin
    perform public.gallery_links_replace('a9000000-0000-0000-0000-000000000011', null, '[{"id": "a9600000-0000-0000-0000-000000000004", "tokenHash": "zz"}]');
    raise exception 'FAILED: malformed links accepted';
  exception when invalid_parameter_value then raise notice 'ok - a malformed entry rotates nothing';
  end;
end $$;

-- ---- Privileges --------------------------------------------------------------------------------------------
select pg_temp.ok(not exists (
  select 1 from unnest(array['safety_hold_reports', 'reveal_grants', 'limits_notices', 'ad_cards', 'ad_stats_daily', 'ad_event_seen', 'retention_items', 'staff_invites']) t
   where has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')
      or has_table_privilege('authenticated', 'public.' || t, 'insert')), 'anon and authenticated can''t read or write the new tables');
select pg_temp.ok((select bool_and(c.relrowsecurity) from pg_class c where c.relnamespace = 'public'::regnamespace
                    and c.relname in ('safety_hold_reports', 'reveal_grants', 'limits_notices', 'ad_cards', 'ad_stats_daily', 'ad_event_seen', 'retention_items', 'staff_invites')),
  'RLS is on for every new table');
select pg_temp.ok(not has_function_privilege('authenticated', 'public.admin_users(uuid, text, text, text, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.app_status()', 'execute')
  and not has_function_privilege('service_role', 'public._staff_can(uuid, text)', 'execute')
  and not has_function_privilege('service_role', 'public._set_plan(uuid, text, text, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.admin_user_suspend(uuid, uuid, text, text)', 'execute')
  and has_function_privilege('supabase_auth_admin', 'public._staff_invite_open(text)', 'execute')
  and has_function_privilege('supabase_auth_admin', 'public.hook_before_user_created(jsonb)', 'execute'),
  'service_role only; helpers for nobody; the sign-up hook keeps its grants');
set local role authenticated;
do $$ begin
  begin
    perform 1 from public.staff_invites;
    raise exception 'FAILED: authenticated read staff_invites';
  exception when insufficient_privilege then raise notice 'ok - authenticated can''t select staff_invites';
  end;
end $$;
do $$ begin
  begin
    perform 1 from public.ad_event_seen;
    raise exception 'FAILED: authenticated read ad_event_seen';
  exception when insufficient_privilege then raise notice 'ok - authenticated can''t select ad_event_seen';
  end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform 1 from public.ad_event_seen;
    raise exception 'FAILED: anon read ad_event_seen';
  exception when insufficient_privilege then raise notice 'ok - anon can''t select ad_event_seen';
  end;
end $$;
reset role;

rollback;
