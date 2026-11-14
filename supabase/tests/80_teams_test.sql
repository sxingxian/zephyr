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

rollback;
\echo 'All teams tests passed.'
