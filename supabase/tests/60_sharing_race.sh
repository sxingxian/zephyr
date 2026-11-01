#!/usr/bin/env bash
# Concurrency checks for the sharing migration (phase 5), run by run-local.sh against its throwaway database
# (two real sessions; the SQL tests run in one transaction and can't race). Expects PSQL_ARGS.
# Live-gallery cap: a create and a reopen racing at the cap must not both succeed, in either order.
set -euo pipefail
read -r -a psql <<<"$PSQL_ARGS"
P() { "${psql[@]}" -At "$@"; }
owner=60000000-0000-0000-0000-000000000001
P <<SQL >/dev/null
insert into auth.users (id, email, email_confirmed_at) values ('$owner', 'race6@example.com', now());
insert into public.photos (id, owner_id, status, file_type, filename, size_bytes, sha256, width, height, has_thumb, has_preview, thumb_bytes, preview_bytes)
values ('61000000-0000-0000-0000-000000000001', '$owner', 'ready', 'jpeg', 'a.jpg', 1000, extensions.digest('race6', 'sha256'), 10, 10, true, true, 1, 1);
create function public.race_mk(gid uuid) returns text language sql as \$\$
  select coalesce(public.create_gallery('$owner', gid, extensions.digest(gid::text, 'sha256'), 'hint',
    extensions.digest('c' || gid::text, 'sha256'), substr(extensions.digest('iv', 'sha256'), 1, 12), null, 'G', null,
    array['61000000-0000-0000-0000-000000000001'::uuid], (now() at time zone 'utc')::date + 3, 'web', '{}'::jsonb) ->> 'error', 'ok') \$\$;
create function public.race_reopen(gid uuid) returns text language sql as \$\$
  select coalesce(public.patch_gallery('$owner', gid, jsonb_build_object('expiresOn',
    ((now() at time zone 'utc')::date + 3)::text)) ->> 'error', 'ok') \$\$;
create function public.race_live() returns bigint language sql as \$\$
  select count(*) from public.galleries where owner_id = '$owner' and revoked_at is null and expires_at > now() \$\$;
SQL
fail() { echo "FAILED: $1" >&2; exit 1; }
# Free plan: 3 live galleries. Two live, one expired.
P -c "select public.race_mk('62000000-0000-0000-0000-000000000001'), public.race_mk('62000000-0000-0000-0000-000000000002'), public.race_mk('62000000-0000-0000-0000-000000000003');" >/dev/null
P -c "update public.galleries set expires_at = now() - interval '1 hour' where id = '62000000-0000-0000-0000-000000000003';"

run_pair() { # $1: first (held open) statement, $2: second statement
  local out1 out2
  out1="$(mktemp)"
  ( P -c "begin;" -c "select $1;" -c "select pg_sleep(1.5);" -c "commit;" >"$out1" ) &
  sleep 0.5
  out2="$(P -c "select $2;")"
  wait
  printf '%s %s\n' "$(grep -E '^(ok|limit)$' "$out1")" "$out2"
  rm -f "$out1"
}

r="$(run_pair "public.race_mk('62000000-0000-0000-0000-000000000004')" "public.race_reopen('62000000-0000-0000-0000-000000000003')")"
[ "$r" = "ok limit" ] || fail "create then reopen at the cap: got '$r', want 'ok limit'"
[ "$(P -c 'select public.race_live()')" = 3 ] || fail "create then reopen: more than 3 live galleries"
echo "ok - create and reopen racing at the cap: exactly one succeeds"

# Reset: expire two, so one slot is free again (2 live + 1 expired to reopen... make it 2 live).
P -c "update public.galleries set expires_at = now() - interval '1 hour' where id in ('62000000-0000-0000-0000-000000000003', '62000000-0000-0000-0000-000000000004');"
r="$(run_pair "public.race_reopen('62000000-0000-0000-0000-000000000003')" "public.race_mk('62000000-0000-0000-0000-000000000005')")"
[ "$r" = "ok limit" ] || fail "reopen then create at the cap: got '$r', want 'ok limit'"
[ "$(P -c 'select public.race_live()')" = 3 ] || fail "reopen then create: more than 3 live galleries"
echo "ok - reopen and create racing at the cap: exactly one succeeds"

r="$(run_pair "public.race_reopen('62000000-0000-0000-0000-000000000004')" "public.race_reopen('62000000-0000-0000-0000-000000000004')")"
[ "$(P -c 'select public.race_live()')" = 3 ] || fail "two reopens: more than 3 live galleries"
echo "ok - reopens racing at the cap stay within it"
echo "All sharing race tests passed."
