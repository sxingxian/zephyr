-- Daily retention jobs. Needs the pg_cron extension (enable it in the Supabase dashboard under
-- Database › Extensions, or this statement enables it). Local test runs skip this file when
-- pg_cron isn't installed; see supabase/README.md.

create extension if not exists pg_cron;

select cron.schedule(
  'zephyr-purge-invite-requests',
  '17 3 * * *', -- 03:17 UTC daily
  $$ select public.purge_invite_requests(); $$
);
-- TODO(accounts phase): schedule the deleted-account purge (app_settings.deleted_account_retention_days).
