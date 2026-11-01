#!/usr/bin/env bash
# Concurrency checks for the Zephyr AI migration (phase 6), run by run-local.sh against its throwaway database
# (two real sessions; the SQL tests run in one transaction and can't race). Expects PSQL_ARGS.
# - Credits: two jobs racing for the last credit can't both be charged.
# - Spend caps: two consumers reserving at the cap can't both pass it.
# - Refunds: two failure reports for one item refund it once.
set -euo pipefail
read -r -a psql <<<"$PSQL_ARGS"
P() { "${psql[@]}" -At "$@"; }
owner=70000000-0000-0000-0000-000000000001
P <<SQL >/dev/null
insert into auth.users (id, email, email_confirmed_at) values ('$owner', 'race7@example.com', now());
insert into public.photos (id, owner_id, status, file_type, filename, size_bytes, sha256, width, height, has_thumb, has_preview, thumb_bytes, preview_bytes)
values ('71000000-0000-0000-0000-000000000001', '$owner', 'ready', 'jpeg', 'a.jpg', 1000, extensions.digest('race7a', 'sha256'), 10, 10, true, true, 1, 1),
       ('71000000-0000-0000-0000-000000000002', '$owner', 'ready', 'jpeg', 'b.jpg', 1000, extensions.digest('race7b', 'sha256'), 10, 10, true, true, 1, 1);
select public.ai_status('$owner');
update public.credit_balances set balance = 1 where owner_id = '$owner';
create function public.race_job(pid uuid) returns text language sql as \$\$
  select coalesce(public.ai_bg_job_create('$owner', array[pid], '{"bg": "white"}', null, false) ->> 'error', 'ok') \$\$;
create function public.race_reserve() returns text language sql as \$\$
  select case when (public._ai_spend_reserve('bg_removal', '$owner', 3000) ->> 'ok')::boolean then 'ok' else 'capped' end \$\$;
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

r="$(run_pair "public.race_job('71000000-0000-0000-0000-000000000001')" "public.race_job('71000000-0000-0000-0000-000000000002')")"
[ "$r" = "ok insufficient_credits" ] || fail "two jobs for the last credit: got '$r', want 'ok insufficient_credits'"
[ "$(P -c "select balance from public.credit_balances where owner_id = '$owner'")" = 0 ] || fail "balance after the race"
echo "ok - two jobs racing for the last credit: exactly one is charged"

P -c "update public.ai_settings set cap_bg_micros = 5000, cap_total_micros = 100000, cap_user_micros = 100000;" >/dev/null
r="$(run_pair "public.race_reserve()" "public.race_reserve()")"
[ "$r" = "ok capped" ] || fail "two reserves at the cap: got '$r', want 'ok capped'"
[ "$(P -c "select reserved_micros from public.ai_spend_daily where feature = 'bg_removal' and day = (now() at time zone 'utc')::date")" = 3000 ] \
  || fail "reserved past the cap"
echo "ok - two consumers reserving at the cap: only one passes"

item="$(P -c "select id from public.ai_job_items where owner_id = '$owner' limit 1")"
P -c "select public.ai_item_begin('$item', 0);" >/dev/null
r="$(run_pair "public.ai_item_failed('$item', 'provider_error', 0, '[]') ->> 'status'" "public.ai_item_failed('$item', 'provider_error', 0, '[]') ->> 'status'")"
[ "$r" = "failed skip" ] || fail "two failure reports: got '$r', want 'failed skip'"
[ "$(P -c "select balance from public.credit_balances where owner_id = '$owner'")" = 1 ] || fail "refunded twice"
echo "ok - two failure reports for one item refund it once"

P -c "update public.ai_settings set cap_bg_micros = 8000000, cap_total_micros = 10000000, cap_user_micros = 500000;" >/dev/null
echo "All AI race tests passed."
