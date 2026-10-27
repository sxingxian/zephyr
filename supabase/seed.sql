-- Local development data only (run by `supabase db reset`). Never applied to production.
-- An open invite for dev@zephyr.local, so you can sign up locally while Invite only is on.
-- The raw token for this hash is "dev-invite-token-do-not-use-in-prod".
insert into public.invites (email, token_hash, source, expires_at, note)
values (
  'dev@zephyr.local',
  extensions.digest('dev-invite-token-do-not-use-in-prod', 'sha256'),
  'admin',
  now() + interval '30 days',
  'Local development invite'
);
