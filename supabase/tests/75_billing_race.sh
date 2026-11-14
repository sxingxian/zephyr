#!/usr/bin/env bash
# Concurrency checks for the billing and teams migrations (phase 7), run by run-local.sh against its throwaway
# database (two real sessions; the SQL tests run in one transaction and can't race). Expects PSQL_ARGS.
# - Seats: two invites racing for the last seat: exactly one is created.
# - Webhooks: two applies of the same subscription racing keep the newest read, whichever commits first.
# - Top-ups: two grants of one Checkout session racing grant once.
# - Duplicates: two different live subscriptions racing for one member: one is stored, the other is a duplicate.
# - Past due: the daily expiry racing a card retry that succeeded never ends the plan of a member who just paid.
set -euo pipefail
read -r -a psql <<<"$PSQL_ARGS"
P() { "${psql[@]}" -At "$@"; }
owner=75000000-0000-0000-0000-000000000001
owner2=75000000-0000-0000-0000-000000000002
owner3=75000000-0000-0000-0000-000000000003
P <<SQL >/dev/null
insert into auth.users (id, email, email_confirmed_at) values ('$owner', 'race75@example.com', now());
update public.profiles set plan_id = 'studio' where id = '$owner';
select public.team_invite_create('$owner', 'first75@example.com', 'editor', extensions.digest('r75-0', 'sha256'));
select public.billing_customer_set('$owner', 'cus_Race75');
select public.billing_checkout_record('$owner', 'cs_test_race75top01', 'topup', 'zephyr_topup_500');
insert into auth.users (id, email, email_confirmed_at) values ('$owner2', 'race75b@example.com', now());
select public.billing_customer_set('$owner2', 'cus_Race75b');
create function public.race_invite(n text) returns text language sql as \$\$
  select coalesce(public.team_invite_create('$owner', n || '@example.com', 'viewer', extensions.digest('r75-' || n, 'sha256')) ->> 'error', 'ok') \$\$;
create function public.race_apply(price text, synced timestamptz) returns text language sql as \$\$
  select coalesce(public.billing_apply('$owner', jsonb_build_object('stripe_subscription_id', 'sub_Race75', 'stripe_customer_id', 'cus_Race75',
    'status', 'active', 'stripe_price_id', price, 'item_id', 'si_Race75', 'current_period_start', now() - interval '1 day',
    'current_period_end', now() + interval '29 days', 'cancel_at_period_end', false), synced) ->> 'planAfter', 'null') \$\$;
create function public.race_sub(id text) returns text language sql as \$\$
  select case when r ->> 'duplicate' = 'true' then 'duplicate' else r ->> 'planAfter' end
    from (select public.billing_apply('$owner2', jsonb_build_object('stripe_subscription_id', id, 'stripe_customer_id', 'cus_Race75b',
      'status', 'active', 'stripe_price_id', (select stripe_price_id from public.billing_prices where lookup_key = 'zephyr_pro_monthly' and current),
      'item_id', 'si_' || replace(id, 'sub_', ''), 'current_period_start', now() - interval '1 day', 'current_period_end', now() + interval '29 days',
      'cancel_at_period_end', false), now()) as r) x \$\$;
insert into auth.users (id, email, email_confirmed_at) values ('$owner3', 'race75c@example.com', now());
select public.billing_customer_set('$owner3', 'cus_Race75c');
select public.billing_apply('$owner3', jsonb_build_object('stripe_subscription_id', 'sub_Race75c', 'stripe_customer_id', 'cus_Race75c',
  'status', 'past_due', 'stripe_price_id', (select stripe_price_id from public.billing_prices where lookup_key = 'zephyr_pro_monthly' and current),
  'item_id', 'si_Race75c', 'current_period_start', now() - interval '25 days', 'current_period_end', now() + interval '5 days',
  'cancel_at_period_end', false), now());
update public.subscriptions set past_due_since = now() - interval '22 days' where owner_id = '$owner3';
-- The card retry succeeded: billing_apply records active under the billing lock (simulated directly here).
create function public.race_recover() returns text language plpgsql as \$\$
begin
  perform public._lock_billing('$owner3');
  update public.subscriptions set status = 'active', past_due_since = null where owner_id = '$owner3';
  return 'recovered';
end \$\$;
create function public.race_expire() returns text language sql as \$\$
  select jsonb_array_length(public.billing_past_due_expire(100))::text \$\$;
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

r="$(run_pair "public.race_sub('sub_Race75a')" "public.race_sub('sub_Race75b')")"
[ "$r" = "pro duplicate" ] || fail "two live subscriptions racing: got '$r', want 'pro duplicate'"
[ "$(P -c "select stripe_subscription_id from public.subscriptions where owner_id = '$owner2'")" = sub_Race75a ] || fail "the first subscription should be stored"
echo "ok - two live subscriptions racing: one is stored, the other is reported as a duplicate"

[ "$(P -c "select plan_id from public.profiles where id = '$owner3'")" = pro ] || fail "past-due member should start on Pro"
r="$(run_pair "public.race_recover()" "public.race_expire()")"
[ "$r" = "recovered 0" ] || fail "past-due expiry racing a recovery: got '$r', want 'recovered 0'"
[ "$(P -c "select plan_id from public.profiles where id = '$owner3'")" = pro ] || fail "the member who just paid must keep Pro"
echo "ok - the past-due expiry racing a successful card retry keeps the plan"

P <<SQL >/dev/null
drop function public.race_recover();
drop function public.race_expire();
drop function public.race_sub(text);
drop function public.race_invite(text);
drop function public.race_apply(text, timestamptz);
drop function public.race_topup();
SQL
echo "All billing race tests passed."
