-- Assertions for the teams migration (phase 7): team invites and seats, accepting (signed in, and by signing up),
-- library access per role, suspension, removal and leaving, the owner's deletion, and privileges.
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
  ('c8000000-0000-0000-0000-000000000001', 'mei.team@example.com', now()),
  ('c8000000-0000-0000-0000-000000000002', 'jun.team@example.com', now()),
  ('c8000000-0000-0000-0000-000000000003', 'aisha.team@example.com', now()),
  ('c8000000-0000-0000-0000-000000000004', 'free.team@example.com', now()),
  ('c8000000-0000-0000-0000-000000000005', 'busy.team@example.com', now());
update public.profiles set plan_id = 'studio', display_name = 'Mei Lin' where id = 'c8000000-0000-0000-0000-000000000001';
update public.profiles set display_name = 'Jun Hao' where id = 'c8000000-0000-0000-0000-000000000002';
\set mei '\'c8000000-0000-0000-0000-000000000001\''
\set jun '\'c8000000-0000-0000-0000-000000000002\''
\set aisha '\'c8000000-0000-0000-0000-000000000003\''
\set free '\'c8000000-0000-0000-0000-000000000004\''
\set busy '\'c8000000-0000-0000-0000-000000000005\''

-- ---- Team and invites --------------------------------------------------------------------------------
select pg_temp.ok(public.team_get(:mei) ->> 'name' = 'Mei Lin''s Studio' and (public.team_get(:mei) ->> 'seats')::int = 3
  and (public.team_get(:mei) ->> 'used')::int = 1 and (public.team_get(:mei) ->> 'available')::boolean, 'a Studio team starts with 3 seats, 1 used');
select pg_temp.ok(public.team_set_name(:mei, '  Tan Studio ') ->> 'name' = 'Tan Studio', 'the owner names the team');
select pg_temp.ok(public.team_set_name(:mei, '') ->> 'error' = 'invalid', 'an empty name is refused');
-- Team names go into invite emails sent to any address: no links, addresses or markup.
select pg_temp.ok(public.team_set_name(:mei, 'Claim it at evil.com') ->> 'error' = 'invalid'
  and public.team_set_name(:mei, 'www Studio') ->> 'name' = 'www Studio'
  and public.team_set_name(:mei, 'Go www.evil') ->> 'error' = 'invalid'
  and public.team_set_name(:mei, 'mail me@evil') ->> 'error' = 'invalid'
  and public.team_set_name(:mei, 'http://evil') ->> 'error' = 'invalid'
  and public.team_set_name(:mei, 'Tan <b>') ->> 'error' = 'invalid',
  'team names that read as links or addresses are refused');
select pg_temp.ok(public.team_set_name(:mei, 'St. John''s & Sons - Co.') ->> 'name' = 'St. John''s & Sons - Co.'
  and public._safe_label('Tân Studio 54'), 'letters (any script), numbers, spaces and . , '' & - are fine');
-- The shared list (supabase/tests/safe_label_cases.txt), also checked against isSafeLabel in packages/shared.
\set casefile :testdir '/safe_label_cases.txt'
create temp table label_cases as
  select line from regexp_split_to_table(pg_read_file(:'casefile'), E'\n') as line;
do $$
declare r record; n integer := 0;
begin
  for r in select split_part(line, '|', 1) as want, substr(line, position('|' in line) + 1) as name
             from label_cases where line ~ '^(ok|no)\|' loop
    if public._safe_label(normalize(r.name, NFKC)) is distinct from (r.want = 'ok') then
      raise exception 'FAILED: _safe_label(%) should be %', r.name, r.want;
    end if;
    n := n + 1;
  end loop;
  if n < 20 then raise exception 'FAILED: only % label cases read', n; end if;
  raise notice 'ok - % shared name cases agree with the SQL rule', n;
end $$;
select pg_temp.ok(public.team_set_name(:mei, 'Studio Ⅻ') ->> 'name' = 'Studio XII'
  and not public._safe_label('Studio Ⅻ'),
  'names are stored NFKC-normalised, and an unnormalised name never passes the table check');
select pg_temp.ok(public.team_set_name(:mei, 'evil.ⅽⅽ') ->> 'error' = 'invalid', 'a Roman-numeral domain is refused');
select pg_temp.ok(public.team_set_name(:mei, 'Tan Studio') ->> 'name' = 'Tan Studio', 'back to Tan Studio');
do $$ begin
  begin
    update public.teams set name = 'x.com' where owner_id = 'c8000000-0000-0000-0000-000000000001';
    if not found then raise exception 'FAILED: no team row to test'; end if;
    raise exception 'FAILED: the table accepted a link-like team name';
  exception when check_violation then raise notice 'ok - the table itself refuses link-like team names';
  end;
end $$;
select pg_temp.ok(public.team_invite_create(:free, 'x@example.com', 'editor', pg_temp.h('t-free')) ->> 'error' = 'plan_required'
  and not (public.team_get(:free) ->> 'available')::boolean, 'a Free member can''t invite (the Team page shows the upsell)');
select pg_temp.ok(public.team_invite_create(:mei, 'mei.team@example.com', 'editor', pg_temp.h('t-self')) ->> 'error' = 'already_member',
  'the owner can''t invite themselves');
select pg_temp.ok(public.team_invite_create(:mei, 'not-an-email', 'editor', pg_temp.h('t-bad')) ->> 'error' = 'not_found'
  and public.team_invite_create(:mei, 'x@example.com', 'owner', pg_temp.h('t-bad2')) ->> 'error' = 'not_found', 'bad email or role is refused');

select public.team_invite_create(:mei, 'Jun.Team@Example.com', 'editor', pg_temp.h('t-jun')) as ij \gset
select pg_temp.ok(:'ij'::jsonb ->> 'error' is null and (:'ij'::jsonb ->> 'existingAccount')::boolean
  and :'ij'::jsonb #>> '{invite,email}' = 'jun.team@example.com' and :'ij'::jsonb #>> '{invite,role}' = 'editor'
  and :'ij'::jsonb #>> '{invite,expiresAt}' is not null and :'ij'::jsonb ->> 'teamName' = 'Tan Studio', 'inviting an existing account (email normalised)');
select pg_temp.ok((public.team_get(:mei) ->> 'used')::int = 2, 'the invite takes a seat');
select pg_temp.ok(public.team_invite_create(:mei, 'jun.team@example.com', 'viewer', pg_temp.h('t-jun2')) ->> 'error' = 'already_member',
  'a second invite to the same address is refused');
select public.team_invite_create(:mei, 'new.person@example.com', 'viewer', pg_temp.h('t-new')) as inew \gset
select pg_temp.ok(not (:'inew'::jsonb ->> 'existingAccount')::boolean, 'inviting someone without an account');
select pg_temp.ok((public.team_get(:mei) ->> 'used')::int = 3, 'takes the last seat');
select pg_temp.ok(public.team_invite_create(:mei, 'aisha.team@example.com', 'viewer', pg_temp.h('t-aisha')) ->> 'error' = 'limit_reached',
  'no free seat → limit_reached');
select pg_temp.ok((select source::text from public.invites where token_hash = pg_temp.h('t-jun')) = 'team'
  and (select public._invite_json(i) ->> 'invitedBy' from public.invites i where token_hash = pg_temp.h('t-jun')) = 'Tan Studio · Team',
  'a team invite is an invite (source team) and shows its team in the admin list');

-- ---- Preview and accept ------------------------------------------------------------------------------
select pg_temp.ok(public.team_invite_preview(pg_temp.h('t-jun')) ->> 'emailHint' = 'j•••@example.com'
  and not (public.team_invite_preview(pg_temp.h('t-jun')) ->> 'needsAccount')::boolean
  and (public.team_invite_preview(pg_temp.h('t-new')) ->> 'needsAccount')::boolean
  and public.team_invite_preview(pg_temp.h('t-jun')) ->> 'role' = 'editor', 'the preview masks the address and says whether to sign up');
select pg_temp.ok(public.team_invite_preview(pg_temp.h('nope')) is null, 'an unknown token previews as nothing');
select pg_temp.ok(public.team_invite_accept(:aisha, 'aisha.team@example.com', pg_temp.h('t-jun')) ->> 'error' = 'invite_invalid',
  'someone else can''t accept the invite');
select pg_temp.ok(public.team_invite_accept(:jun, 'other@example.com', pg_temp.h('t-jun')) ->> 'error' = 'invite_invalid',
  'the signed-in email must match');
select pg_temp.ok(public.team_invite_accept(:jun, 'jun.team@example.com', pg_temp.h('t-jun')) @> '{"ownerId": "c8000000-0000-0000-0000-000000000001", "joined": true}', 'Jun accepts');
select pg_temp.ok(public.team_invite_accept(:jun, 'jun.team@example.com', pg_temp.h('t-jun')) @> '{"joined": false}', 'accepting twice is harmless');
select pg_temp.ok(public.team_invite_preview(pg_temp.h('t-jun')) is null, 'a used invite previews as nothing');
select pg_temp.ok((public.team_get(:mei) ->> 'used')::int = 3 and jsonb_array_length(public.team_get(:mei) -> 'members') = 2
  and public.team_get(:mei) #>> '{members,0,role}' = 'owner' and public.team_get(:mei) #>> '{members,1,email}' = 'jun.team@example.com',
  'the team lists the owner first, then Jun; the seat count is unchanged');

-- Signing up with an invited address joins the team.
insert into auth.users (id, email, email_confirmed_at) values ('c8000000-0000-0000-0000-000000000006', 'New.Person@example.com', now());
\set newp '\'c8000000-0000-0000-0000-000000000006\''
select pg_temp.ok(public.library_access(:newp, :mei) ->> 'role' = 'viewer'
  and (select accepted_at is not null from public.invites where token_hash = pg_temp.h('t-new')), 'a new account joins the team it was invited to');

-- ---- Library access ------------------------------------------------------------------------------------
select pg_temp.ok(public.library_access(:mei, :mei) ->> 'role' = 'owner' and (public.library_access(:mei, :mei) ->> 'self')::boolean,
  'the owner opens their own library');
select pg_temp.ok(public.library_access(:jun, :mei) ->> 'role' = 'editor' and not (public.library_access(:jun, :mei) ->> 'self')::boolean
  and public.library_access(:jun, :mei) ->> 'plan' = 'studio' and public.library_access(:jun, :mei) ->> 'ownerId' = :mei, 'Jun is an editor in Mei''s library');
select pg_temp.ok(public.library_access(:aisha, :mei) is null and public.library_access(:jun, :aisha) is null
  and public.library_access(:jun, 'c8000000-0000-0000-0000-0000000000ff') is null, 'no access without membership, or to unknown libraries');
select pg_temp.ok(jsonb_array_length(public.list_libraries(:jun)) = 2 and public.list_libraries(:jun) #>> '{0,ownerId}' = :jun
  and public.list_libraries(:jun) #>> '{1,name}' = 'Tan Studio' and public.list_libraries(:jun) #>> '{1,initials}' = 'TS'
  and public.list_libraries(:jun) #>> '{0,initials}' = 'JH', 'Jun''s switcher: his own library, then Tan Studio');

-- Roles, removal, leaving.
select pg_temp.ok(public.team_member_set_role(:mei, :jun, 'viewer'), 'the owner changes a role');
select pg_temp.ok(public.library_access(:jun, :mei) ->> 'role' = 'viewer', 'it applies at once');
select pg_temp.ok(not public.team_member_set_role(:mei, :aisha, 'viewer') and not public.team_member_set_role(:mei, :jun, 'owner'), 'a non-member or a bad role changes nothing');
select public.team_member_set_role(:mei, :jun, 'editor');

-- Suspension: the plan loses seats → no access, still listed.
update public.profiles set plan_id = 'pro' where id = :mei;
select pg_temp.ok(public.library_access(:jun, :mei) is null and jsonb_array_length(public.list_libraries(:jun)) = 1
  and (public.team_get(:mei) #>> '{members,1,suspended}')::boolean, 'without Studio, teammates are suspended (still listed)');
update public.profiles set plan_id = 'studio' where id = :mei;
select pg_temp.ok(public.library_access(:jun, :mei) ->> 'role' = 'editor', 'back on Studio, access returns');
-- Fewer seats than members: the newest is suspended.
update public.plan_limits set seats = 2 where plan_id = 'studio';
select pg_temp.ok(public.library_access(:jun, :mei) is not null and public.library_access(:newp, :mei) is null,
  'with fewer seats, the newest member is suspended first');
update public.plan_limits set seats = 3 where plan_id = 'studio';

-- Read-only state carries through.
update public.profiles set storage_bytes = 2000::bigint * 1073741824 where id = :mei;
select pg_temp.ok(public.library_access(:jun, :mei) ->> 'state' = 'read_only', 'a library over its storage is read-only for teammates too');
update public.profiles set storage_bytes = 0 where id = :mei;

-- Revoke and resend.
select pg_temp.ok(public.team_member_remove(:mei, :newp), 'the owner removes a member');
select pg_temp.ok(public.library_access(:newp, :mei) is null, 'removing a member ends their access at once');
select public.team_invite_create(:mei, 'aisha.team@example.com', 'viewer', pg_temp.h('t-aisha')) as ia \gset
select pg_temp.ok(:'ia'::jsonb -> 'invite' is not null, 'a freed seat can be used again');
select pg_temp.ok(public.team_invite_resend(:mei, (:'ia'::jsonb #>> '{invite,id}')::uuid, pg_temp.h('t-aisha2')) ->> 'email' = 'aisha.team@example.com', 'the owner resends');
select pg_temp.ok(public.team_invite_preview(pg_temp.h('t-aisha')) is null and public.team_invite_preview(pg_temp.h('t-aisha2')) is not null,
  'resending rotates the token');
select pg_temp.ok(public.team_invite_resend(:jun, (:'ia'::jsonb #>> '{invite,id}')::uuid, pg_temp.h('t-x')) ->> 'error' = 'not_found', 'only the owner can resend');
select pg_temp.ok(public.team_invite_revoke(:mei, (:'ia'::jsonb #>> '{invite,id}')::uuid), 'the owner revokes');
select pg_temp.ok(public.team_invite_preview(pg_temp.h('t-aisha2')) is null, 'a revoked invite is gone');
select pg_temp.ok(not public.team_invite_revoke(:mei, (:'ia'::jsonb #>> '{invite,id}')::uuid), 'revoking twice finds nothing');
-- An expired invite frees its seat; reopening it needs a seat.
select public.team_invite_create(:mei, 'aisha.team@example.com', 'viewer', pg_temp.h('t-aisha3')) as ia3 \gset
update public.invites set expires_at = now() - interval '1 minute', created_at = now() - interval '8 days' where token_hash = pg_temp.h('t-aisha3');
select pg_temp.ok((public.team_get(:mei) ->> 'used')::int = 2 and public.team_invite_preview(pg_temp.h('t-aisha3')) is null
  and public.team_invite_accept(:aisha, 'aisha.team@example.com', pg_temp.h('t-aisha3')) ->> 'error' = 'invite_invalid', 'an expired invite frees its seat and can''t be used');
select pg_temp.ok(public.team_invite_resend(:mei, (:'ia3'::jsonb #>> '{invite,id}')::uuid, pg_temp.h('t-aisha4')) -> 'invite' is not null, 'resending reopens it');
select pg_temp.ok(public.team_invite_accept(:aisha, 'aisha.team@example.com', pg_temp.h('t-aisha4')) ->> 'ownerId' = :mei, 'Aisha accepts');
select pg_temp.ok(public.library_access(:aisha, :mei) ->> 'role' = 'viewer', 'Aisha joins as a viewer');
select pg_temp.ok(public.team_leave(:aisha, :mei) and not public.team_leave(:aisha, :mei), 'a teammate can leave, once');
select pg_temp.ok(public.library_access(:aisha, :mei) is null, 'and loses access');

-- At most 10 team libraries per member.
insert into auth.users (id, email, email_confirmed_at)
select ('c8100000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'owner' || n || '.team@example.com', now() from generate_series(1, 10) n;
update public.profiles set plan_id = 'studio' where id::text like 'c8100000-%';
insert into public.library_members (owner_id, member_id, role)
select ('c8100000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, :busy, 'viewer' from generate_series(1, 10) n;
select pg_temp.ok(public.team_invite_create(:mei, 'busy.team@example.com', 'viewer', pg_temp.h('t-busy')) ->> 'error' = 'limit_reached',
  'a member in 10 teams can''t be invited to an eleventh');

-- The owner's deletion makes the team unavailable.
update public.profiles set deletion_requested_at = now(), deletion_due = now() + interval '30 days' where id = :mei;
select pg_temp.ok(public.library_access(:jun, :mei) is null and jsonb_array_length(public.list_libraries(:jun)) = 1
  and public.library_access(:mei, :mei) is not null, 'an owner scheduled for deletion: teammates lose access');
select pg_temp.ok(public.team_invite_create(:mei, 'z@example.com', 'viewer', pg_temp.h('t-z')) ->> 'error' = 'not_found', 'and no invites');
update public.profiles set deletion_requested_at = null, deletion_due = null where id = :mei;
delete from auth.users where id = :jun;
select pg_temp.ok(not exists (select 1 from public.library_members where member_id = :jun), 'deleting a member''s account removes their memberships');

-- ---- Security review fixes -----------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('c8200000-0000-0000-0000-000000000001', 'anon.owner@example.com', now()),
  ('c8200000-0000-0000-0000-000000000002', 'ed.member@example.com', now());
update public.profiles set plan_id = 'studio' where id = 'c8200000-0000-0000-0000-000000000001';
\set ao '\'c8200000-0000-0000-0000-000000000001\''
\set ed '\'c8200000-0000-0000-0000-000000000002\''

-- Names never show any part of an email address to teammates or invitees.
select public.team_invite_create(:ao, 'someone.new@example.com', 'editor', pg_temp.h('r-new')) as rnew \gset
select pg_temp.ok(:'rnew'::jsonb ->> 'ownerName' = 'Studio owner' and :'rnew'::jsonb ->> 'teamName' = 'Studio team'
  and public.team_invite_preview(pg_temp.h('r-new')) ->> 'ownerName' = 'Studio owner'
  and public.team_invite_preview(pg_temp.h('r-new')) ->> 'teamName' = 'Studio team',
  'an owner without a display name is "Studio owner" of "Studio team", never their address');
select pg_temp.ok(public.list_libraries(:free) #>> '{0,name}' = 'free.team', 'a member''s own library can still use their own address');
select pg_temp.ok(public.preview_invite(pg_temp.h('r-new')) ->> 'emailHint' = 's•••@example.com'
  and public.preview_invite(pg_temp.h('r-new')) ->> 'source' = 'team'
  and public.preview_invite(pg_temp.h('r-new')) ->> 'inviterName' = 'Studio team',
  'the sign-up page preview of a team link carries a masked hint and the team name');

-- A team that stops being usable: its invites don't work anywhere, even before they are revoked.
select signup_mode::text as saved_mode from public.app_settings where id = 1 \gset
update public.app_settings set signup_mode = 'invite_only' where id = 1;
select pg_temp.ok(public.hook_before_user_created(jsonb_build_object('user', jsonb_build_object('email', 'someone.new@example.com'))) = '{}'::jsonb,
  'a live team invite allows an invite-only sign-up');
alter table public.profiles disable trigger profiles_team_guard;
update public.profiles set plan_id = 'pro' where id = :ao;
select pg_temp.ok(public.preview_invite(pg_temp.h('r-new')) is null and public.team_invite_preview(pg_temp.h('r-new')) is null,
  'a downgraded owner''s invite previews as nothing (sign-up page and team page)');
select pg_temp.ok(public.hook_before_user_created(jsonb_build_object('user', jsonb_build_object('email', 'someone.new@example.com'))) ? 'error',
  'and no longer allows an invite-only sign-up');
select pg_temp.ok(public.team_invite_resend(:ao, (:'rnew'::jsonb #>> '{invite,id}')::uuid, pg_temp.h('r-new2')) ->> 'error' = 'plan_required',
  'resending needs team seats');
insert into auth.users (id, email, email_confirmed_at) values ('c8200000-0000-0000-0000-000000000003', 'someone.new@example.com', now());
select pg_temp.ok(not exists (select 1 from public.library_members where member_id = 'c8200000-0000-0000-0000-000000000003'),
  'confirming an account doesn''t join a team that is no longer usable');
alter table public.profiles enable trigger profiles_team_guard;
update public.profiles set plan_id = 'studio' where id = :ao;
update public.app_settings set signup_mode = :'saved_mode' where id = 1;

-- Open invites are revoked when the team stops being usable.
select public.team_invite_create(:ao, 'later.one@example.com', 'viewer', pg_temp.h('r-later')) as rlater \gset
select pg_temp.ok(:'rlater'::jsonb ->> 'error' is null, 'a Studio owner can invite again');
update public.profiles set plan_id = 'pro' where id = :ao;
select pg_temp.ok((select revoked_at is not null from public.invites where token_hash = pg_temp.h('r-later')),
  'dropping to a plan with one seat revokes open team invites');
update public.profiles set plan_id = 'studio' where id = :ao;
select public.team_invite_create(:ao, 'later.two@example.com', 'viewer', pg_temp.h('r-later2')) as rl2 \gset
select public.request_account_deletion(:ao) is not null as scheduled \gset
select pg_temp.ok(:'scheduled' and (select revoked_at is not null from public.invites where token_hash = pg_temp.h('r-later2')),
  'scheduling the owner''s deletion revokes open team invites');
select public.restore_account(:ao) as restored \gset
select public.team_invite_create(:ao, 'later.three@example.com', 'viewer', pg_temp.h('r-later3')) as rl3 \gset
delete from auth.users where id = :ao;
select pg_temp.ok((select revoked_at is not null from public.invites where token_hash = pg_temp.h('r-later3'))
  and public.preview_invite(pg_temp.h('r-later3')) is null, 'purging the owner''s account leaves no live invite behind');

-- At most 30 team invites a month per owner.
insert into auth.users (id, email, email_confirmed_at) values ('c8200000-0000-0000-0000-000000000004', 'cap.owner@example.com', now());
update public.profiles set plan_id = 'studio', display_name = 'Cap' where id = 'c8200000-0000-0000-0000-000000000004';
with inv as (
  insert into public.invites (email, token_hash, source, invited_by, expires_at, revoked_at)
  select 'cap' || n || '@example.com', pg_temp.h('cap-' || n), 'team', 'c8200000-0000-0000-0000-000000000004', now() + interval '7 days', now()
    from generate_series(1, 30) n returning id)
insert into public.team_invites (owner_id, invite_id, role) select 'c8200000-0000-0000-0000-000000000004', id, 'viewer' from inv;
select pg_temp.ok(public.team_invite_create('c8200000-0000-0000-0000-000000000004', 'cap31@example.com', 'viewer', pg_temp.h('cap-31')) ->> 'error' = 'limit_reached',
  'the 31st team invite in a month is refused, even with free seats');

-- Members who had Editor access carry the live-gallery count for the removal warning.
insert into auth.users (id, email, email_confirmed_at) values ('c8200000-0000-0000-0000-000000000005', 'gal.owner@example.com', now());
update public.profiles set plan_id = 'studio', display_name = 'Gal' where id = 'c8200000-0000-0000-0000-000000000005';
insert into public.library_members (owner_id, member_id, role, had_editor) values
  ('c8200000-0000-0000-0000-000000000005', :ed, 'viewer', false);
insert into public.galleries (id, owner_id, name, token_hash, link_hint, link_ciphertext, link_iv, downloads, expires_at)
values (gen_random_uuid(), 'c8200000-0000-0000-0000-000000000005', 'Live', pg_temp.h('g-live'), 'abcd', decode(repeat('00', 32), 'hex'), decode(repeat('00', 12), 'hex'), 'web', now() + interval '7 days'),
       (gen_random_uuid(), 'c8200000-0000-0000-0000-000000000005', 'Ended', pg_temp.h('g-ended'), 'efgh', decode(repeat('00', 32), 'hex'), decode(repeat('00', 12), 'hex'), 'web', now() - interval '1 day');
select pg_temp.ok((public.team_get('c8200000-0000-0000-0000-000000000005') #>> '{members,1,liveGalleries}')::int = 0,
  'a Viewer who never edited could open no gallery links');
select public.team_member_set_role('c8200000-0000-0000-0000-000000000005', :ed, 'editor') as r1 \gset
select public.team_member_set_role('c8200000-0000-0000-0000-000000000005', :ed, 'viewer') as r2 \gset
select pg_temp.ok(:'r1' and :'r2'
  and (public.team_get('c8200000-0000-0000-0000-000000000005') #>> '{members,1,liveGalleries}')::int = 1,
  'once an Editor, always counted: 1 live gallery (ended ones don''t count)');

-- ---- Privileges ----------------------------------------------------------------------------------------
select pg_temp.ok(not exists (
  select 1 from unnest(array['teams', 'library_members', 'team_invites']) t
   where has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')
      or has_table_privilege('authenticated', 'public.' || t, 'insert')),
  'browser roles can''t read or write team tables');
select pg_temp.ok((select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname in ('teams', 'library_members', 'team_invites')), 'RLS is on for every team table');
select pg_temp.ok(not has_function_privilege('authenticated', 'public.library_access(uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.library_access(uuid, uuid)', 'execute')
  and not has_function_privilege('service_role', 'public._team_join(uuid, uuid, text, uuid, boolean)', 'execute'),
  'only the API checks library access; helpers aren''t callable');
select pg_temp.ok(has_function_privilege('supabase_auth_admin', 'public._team_invite_usable(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._team_invite_usable(uuid)', 'execute')
  and not has_function_privilege('anon', 'public._team_invite_usable(uuid)', 'execute'),
  'the sign-up hook can check team invites; browsers can''t');

rollback;
\echo 'All teams tests passed.'
