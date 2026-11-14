#!/usr/bin/env bash
# Concurrency checks for the billing and teams migrations (phase 7), run by run-local.sh against its throwaway
# database (two real sessions; the SQL tests run in one transaction and can't race). Expects PSQL_ARGS.
# - Seats: two invites racing for the last seat: exactly one is created.
# - Webhooks: two applies of the same subscription racing keep the newest read, whichever commits first.
# - Top-ups: two grants of one Checkout session racing grant once.
set -euo pipefail
read -r -a psql <<<"$PSQL_ARGS"
P() { "${psql[@]}" -At "$@"; }
owner=75000000-0000-0000-0000-000000000001
P <<SQL >/dev/null
insert into auth.users (id, email, email_confirmed_at) values ('$owner', 'race75@example.com', now());
update public.profiles set plan_id = 'studio' where id = '$owner';
select public.team_invite_create('$owner', 'first75@example.com', 'editor', extensions.digest('r75-0', 'sha256'));
select public.billing_customer_set('$owner', 'cus_Race75');
select public.billing_checkout_record('$owner', 'cs_test_race75top01', 'topup', 'zephyr_topup_500');
create function public.race_invite(n text) returns text language sql as \$\$
  select coalesce(public.team_invite_create('$owner', n || '@example.com', 'viewer', extensions.digest('r75-' || n, 'sha256')) ->> 'error', 'ok') \$\$;
create function public.race_apply(price text, synced timestamptz) returns text language sql as \$\$
  select coalesce(public.billing_apply('$owner', jsonb_build_object('stripe_subscription_id', 'sub_Race75', 'stripe_customer_id', 'cus_Race75',
    'status', 'active', 'stripe_price_id', price, 'item_id', 'si_Race75', 'current_period_start', now() - interval '1 day',
    'current_period_end', now() + interval '29 days', 'cancel_at_period_end', false), synced) ->> 'planAfter', 'null') \$\$;
create function public.race_topup() returns text language sql as \$\$
  select public.billing_topup_grant('$owner', 'cs_test_race75top01', 'pi_Race75', 'zephyr_topup_500') ->> 'granted' \$\$;
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

r="$(run_pair "public.race_invite('a75')" "public.race_invite('b75')")"
[ "$r" = "ok limit_reached" ] || fail "two invites for the last seat: got '$r', want 'ok limit_reached'"
[ "$(P -c "select (public.team_get('$owner') ->> 'used')")" = 3 ] || fail "seats used after the race"
echo "ok - two invites racing for the last seat: exactly one is created"

seed_ids="$(P -c "select string_agg(stripe_price_id, ',' order by lookup_key) from public.billing_prices where lookup_key in ('zephyr_pro_monthly', 'zephyr_studio_monthly') and current")"
pro="${seed_ids%%,*}"; studio="${seed_ids##*,}"
r="$(run_pair "public.race_apply('$studio', now())" "public.race_apply('$pro', now() - interval '1 minute')")"
[ "$(P -c "select plan_id from public.profiles where id = '$owner'")" = studio ] || fail "newer read first: plan should stay studio (got '$r')"
r="$(run_pair "public.race_apply('$pro', now() + interval '1 minute')" "public.race_apply('$studio', now() + interval '2 minutes')")"
[ "$(P -c "select plan_id from public.profiles where id = '$owner'")" = studio ] || fail "older read first: the newer read should win (got '$r')"
echo "ok - racing webhook applies keep the newest read, whichever commits first"

r="$(run_pair "public.race_topup()" "public.race_topup()")"
[ "$r" = "true false" ] || fail "two grants of one session: got '$r', want 'true false'"
[ "$(P -c "select count(*) from public.credit_topups where checkout_session_id = 'cs_test_race75top01'")" = 1 ] || fail "top-up rows after the race"
echo "ok - two grants of one Checkout session racing grant once"

P <<SQL >/dev/null
drop function public.race_invite(text);
drop function public.race_apply(text, timestamptz);
drop function public.race_topup();
SQL
echo "All billing race tests passed."
