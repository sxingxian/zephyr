#!/usr/bin/env bash
# Concurrency checks for the admin and storage migrations (phase 8), run by run-local.sh against its throwaway
# database (two real sessions; the SQL tests run in one transaction and can't race). Expects PSQL_ARGS.
# - Staff: two Owners demoting each other at once never leave zero Owners.
# - Storage: two consumers claiming items at once never get the same photo; abandoning old copies while the cron
#   reports one deleted never deadlocks (both take the migration row before the items).
# - Retention: approving twice at once approves once; two trash batches at once trash each photo once.
# - Notices: two runs claiming limit and retention notices at once never hand out the same notice.
set -euo pipefail
read -r -a psql <<<"$PSQL_ARGS"
P() { "${psql[@]}" -At "$@"; }
o1=92000000-0000-0000-0000-000000000001
o2=92000000-0000-0000-0000-000000000002
adm=92000000-0000-0000-0000-000000000003
ret=92000000-0000-0000-0000-000000000011
P <<SQL >/dev/null
insert into auth.users (id, email, email_confirmed_at) values
  ('$o1', 'o1.92@zephyr.test', now()), ('$o2', 'o2.92@zephyr.test', now()), ('$adm', 'adm.92@zephyr.test', now()),
  ('$ret', 'ret92@example.com', now());
insert into public.staff (user_id, role) values ('$o1', 'owner'), ('$o2', 'owner'), ('$adm', 'admin');
-- Photos to move: 40 on R2.
insert into public.photos (owner_id, status, file_type, filename, size_bytes, sha256, width, height)
  select '$ret', 'ready', 'jpeg', 'r' || g || '.jpg', 1000, extensions.digest('r92-' || g, 'sha256'), 10, 10 from generate_series(1, 40) g;
-- A lapsed library 1 GB over the Free storage, ready for retention (both notices sent, due).
update public.profiles set storage_bytes = 5368709120 + 1073741824 + 40000, lapsed_at = now() - interval '400 days' where id = '$ret';
insert into public.photos (owner_id, status, file_type, filename, size_bytes, sha256, width, height, taken_at)
  select '$ret', 'ready', 'jpeg', 'big' || g || '.jpg', 268435456, extensions.digest('big92-' || g, 'sha256'), 10, 10, '2019-01-01'::timestamptz + make_interval(days => g)
    from generate_series(1, 25) g;
insert into public.retention_items (owner_id, lapsed_at, due_at, notice_30_at, notice_7_at, state)
  select '$ret', lapsed_at, now() - interval '1 minute', now() - interval '40 days', now() - interval '8 days', 'waiting' from public.profiles where id = '$ret';
create function public.race_role(who uuid, target uuid) returns text language sql as \$\$
  select coalesce(public.admin_staff_set_role(who, target, 'admin', 'Race demote') ->> 'error', 'ok') \$\$;
create function public.race_claim(m uuid) returns text language sql as \$\$
  select coalesce(string_agg(e ->> 'photoId', ',' order by e ->> 'photoId'), '') from jsonb_array_elements(public.storage_migration_batch(m, 25)) e \$\$;
create function public.race_approve() returns text language sql as \$\$
  select public.admin_retention_approve('$adm', array['$ret']::uuid[], 'Race approve') ->> 'approved' \$\$;
create function public.race_trash() returns text language sql as \$\$
  select coalesce(public.retention_trash_batch('$ret', 2) ->> 'trashed', 'null') \$\$;
create function public.race_rnotices() returns text language sql as \$\$
  select jsonb_array_length(public.retention_notices_due(100))::text \$\$;
create function public.race_lnotices() returns text language sql as \$\$
  select jsonb_array_length(public.limits_notices_due(1000))::text \$\$;
SQL
fail() { echo "FAILED: $1" >&2; exit 1; }

run_pair() { # $1: first (held open) statement, $2: second statement
  local out1 out2
  out1="$(mktemp)"
  ( P -c "begin;" -c "select $1;" -c "select pg_sleep(1.5);" -c "commit;" >"$out1" ) &
  sleep 0.5
  out2="$(P -c "select $2;")"
  wait
  printf '%s %s\n' "$(grep -vE '^(BEGIN|COMMIT|)$' "$out1" | head -1)" "$out2"
  rm -f "$out1"
}

r="$(run_pair "public.race_role('$o1', '$o2')" "public.race_role('$o2', '$o1')")"
[ "$r" = "ok forbidden" ] || fail "two Owners demoting each other: got '$r'"
[ "$(P -c "select count(*) from public.staff where role = 'owner'")" = 1 ] || fail "owners left after the race"
echo "ok - two Owners demoting each other at once leave one Owner"

mig="$(P -c "select public.storage_switch('$o1', 'nas', 'Race move') ->> 'migrationId'")"
r="$(run_pair "public.race_claim('$mig')" "public.race_claim('$mig')")"
a="${r%% *}"; b="${r##* }"
[ -n "$a" ] && [ -n "$b" ] || fail "both consumers should get work: '$r'"
dupes="$(comm -12 <(tr ',' '\n' <<<"$a" | sort) <(tr ',' '\n' <<<"$b" | sort) | wc -l)"
[ "$dupes" = 0 ] || fail "two consumers got the same photo ($dupes in common)"
[ "$(P -c "select count(*) from public.storage_migration_items where migration_id = '$mig' and lease_until > now()")" = 50 ] || fail "50 items should be leased"
echo "ok - two consumers claiming at once never get the same photo"
P -c "select public.storage_migration_action('$o1', 'pause', 'Done racing')" >/dev/null

P -c "select public.retention_sweep()" >/dev/null
[ "$(P -c "select state from public.retention_items where owner_id = '$ret'")" = ready ] || fail "retention item should be ready"
r="$(run_pair "public.race_approve()" "public.race_approve()")"
[ "$r" = "1 0" ] || fail "approving twice at once: got '$r', want '1 0'"
echo "ok - approving twice at once approves once"

want="$(P -c "select count(*) from public._retention_pick('$ret')")"
[ "$want" -gt 2 ] || fail "expected more than 2 photos to trash, got $want"
r="$(run_pair "public.race_trash()" "public.race_trash()")"
[ "$r" = "2 2" ] || fail "two trash batches at once: got '$r', want '2 2'"
while [ "$(P -c "select public.race_trash()")" != null ]; do :; done
[ "$(P -c "select count(*) from public.photos where owner_id = '$ret' and status = 'trashed'")" = "$want" ] || fail "trashed count should be $want"
[ "$(P -c "select trashed_photos from public.retention_items where owner_id = '$ret'")" = "$want" ] || fail "item should count $want trashed"
echo "ok - two trash batches at once trash each photo once"

P <<SQL >/dev/null
insert into public.retention_items (owner_id, lapsed_at, due_at, state)
  select u.id, now() - interval '400 days', now() + interval '10 days', 'waiting' from auth.users u
   where u.id in ('$o1', '$o2', '$adm');
SQL
r="$(run_pair "public.race_rnotices()" "public.race_rnotices()")"
[ "$r" = "3 0" ] || fail "retention notices claimed twice: got '$r', want '3 0'"
echo "ok - two runs claiming retention notices at once hand each out once"

P <<SQL >/dev/null
insert into auth.users (id, email) select ('92100000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'n' || g || '.92@example.com' from generate_series(1, 30) g;
select public.admin_limits_draft_create('$o1', (select version from public.plan_limit_versions where status = 'active'));
select public.admin_limits_draft_save('$o1', jsonb_set(public.admin_limits('$o1') -> 'active' -> 'limits', '{free,batchSize}', '20'));
select public.admin_limits_schedule('$o1', now() + interval '31 days', 'Race cut');
SQL
total="$(P -c "select count(*) from public.limits_notices n join public.plan_limit_versions v on v.id = n.version_id where v.status = 'scheduled'")"
[ "$total" -ge 30 ] || fail "expected at least 30 notices, got $total"
r="$(run_pair "public.race_lnotices()" "public.race_lnotices()")"
[ "$r" = "$total 0" ] || fail "limit notices claimed twice: got '$r', want '$total 0'"
echo "ok - two runs claiming limit notices at once hand each out once"

# Abandon vs the cron's deleted report: a held move with two old copies on R2 (photos now on the NAS). The cron
# session holds the migration row, then reports one copy deleted; the Owner abandons meanwhile.
P <<SQL >/dev/null
update public.storage_migrations set state = 'done', finished_at = now() where id = '$mig';
insert into public.storage_migrations (id, from_store, to_store, state, started_by, reason, delete_old_after)
  values ('92200000-0000-0000-0000-000000000001', 'r2', 'nas', 'holding', '$o1', 'Race hold', now() - interval '1 minute');
with two as (select id, owner_id from public.photos where owner_id = '$ret' and filename like 'r%' order by id limit 2)
insert into public.storage_migration_items (migration_id, photo_id, owner_id, src, dst, state, bytes, cleanup_store, deleting_at)
  select '92200000-0000-0000-0000-000000000001', id, owner_id, 'r2', 'nas', 'verified', 1000, 'r2', now() from two;
update public.photos set store_id = 'nas'
 where id in (select photo_id from public.storage_migration_items where migration_id = '92200000-0000-0000-0000-000000000001');
SQL
hm=92200000-0000-0000-0000-000000000001
first="$(P -c "select photo_id from public.storage_migration_items where migration_id = '$hm' order by photo_id limit 1")"
out1="$(mktemp)"
( P -c "begin;" -c "select 1 from public.storage_migrations where id = '$hm' for update;" -c "select pg_sleep(1.5);" \
    -c "select public.storage_item_mark('$hm', '$first', 'deleted', 0, null, null, null, 'r2') ->> 'state';" -c "commit;" \
    >"$out1" 2>&1 ) &
sleep 0.5
ab="$(P -c "select public.storage_abandon_old_copies('$o1', 'r2', 'Race abandon', true)::text" 2>&1)"
wait
grep -qi deadlock "$out1" && fail "the cron's report deadlocked"
grep -q '^deleted$' "$out1" || fail "the cron's report should have deleted its copy: $(cat "$out1")"
rm -f "$out1"
case "$ab" in *deadlock*) fail "abandon deadlocked" ;; esac
[ "$(P -c "select ('$ab'::jsonb ->> 'copies')")" = 1 ] || fail "abandon should take the one copy left: $ab"
[ "$(P -c "select state from public.storage_migrations where id = '$hm'")" = done ] || fail "the held move should be done"
echo "ok - abandoning old copies while the cron reports one deleted never deadlocks"

echo "All admin race tests passed."
