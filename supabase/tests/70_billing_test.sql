-- Assertions for the billing migration (phase 7): prices, customers, Checkout sessions, subscriptions and plans,
-- credit periods, top-ups (grant, spend order, refunds, expiry), price changes, webhook events, admin, privileges.
-- Run with supabase/tests/run-local.sh.
\set ON_ERROR_STOP on
begin;

create function pg_temp.ok(cond boolean, what text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok - %', what;
end $$;
grant execute on function pg_temp.ok(boolean, text) to public;
create function pg_temp.photo(o uuid, n text) returns uuid language plpgsql as $$
declare id uuid;
begin
  insert into public.photos (owner_id, status, file_type, filename, size_bytes, sha256, width, height, has_thumb, has_preview, thumb_bytes, preview_bytes)
  values (o, 'ready', 'jpeg', n, 1000, extensions.digest(n || o::text, 'sha256'), 4000, 3000, true, true, 100, 200)
  returning photos.id into id;
  update public.profiles set storage_bytes = storage_bytes + 1300 where profiles.id = o;
  return id;
end $$;
create function pg_temp.sub(id text, cus text, status text, price text, cps timestamptz, cpe timestamptz,
  extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('stripe_subscription_id', id, 'stripe_customer_id', cus, 'status', status, 'stripe_price_id', price,
                            'item_id', 'si_' || substr(id, 5), 'current_period_start', cps, 'current_period_end', cpe,
                            'cancel_at_period_end', false) || extra
$$;
create function pg_temp.bal(o uuid) returns jsonb language sql as $$ select public.ai_status(o) -> 'credits' $$;

insert into auth.users (id, email, email_confirmed_at) values
  ('b7000000-0000-0000-0000-000000000001', 'mei.bill@example.com', now()),
  ('b7000000-0000-0000-0000-000000000002', 'wei.bill@example.com', now()),
  ('b7000000-0000-0000-0000-000000000003', 'comp.bill@example.com', now()),
  ('b7000000-0000-0000-0000-000000000004', 'year.bill@example.com', now()),
  ('b7000000-0000-0000-0000-000000000005', 'sub2.bill@example.com', now()),
  ('b7000000-0000-0000-0000-0000000000f1', 'owner.bill@zephyr.test', now()),
  ('b7000000-0000-0000-0000-0000000000f2', 'finance.bill@zephyr.test', now()),
  ('b7000000-0000-0000-0000-0000000000f3', 'support.bill@zephyr.test', now());
insert into public.staff (user_id, role) values
  ('b7000000-0000-0000-0000-0000000000f1', 'owner'),
  ('b7000000-0000-0000-0000-0000000000f2', 'finance'),
  ('b7000000-0000-0000-0000-0000000000f3', 'support');
\set mei '\'b7000000-0000-0000-0000-000000000001\''
\set wei '\'b7000000-0000-0000-0000-000000000002\''
\set comp '\'b7000000-0000-0000-0000-000000000003\''
\set yr '\'b7000000-0000-0000-0000-000000000004\''
\set sub2 '\'b7000000-0000-0000-0000-000000000005\''
\set fin '\'b7000000-0000-0000-0000-0000000000f2\''
\set sup '\'b7000000-0000-0000-0000-0000000000f3\''

-- ---- Prices ---------------------------------------------------------------------------------------
select pg_temp.ok(jsonb_array_length(public.billing_prices_current()) = 7, 'seven current prices, one per lookup key');
select pg_temp.ok((select (x ->> 'amount')::int = 999 from jsonb_array_elements(public.billing_prices_current()) x
                    where x ->> 'lookupKey' = 'zephyr_pro_monthly'), 'Pro monthly seeds at US$9.99');
select pg_temp.ok((select not (x ->> 'active')::boolean from jsonb_array_elements(public.billing_prices_current()) x
                    where x ->> 'lookupKey' = 'zephyr_topup_2500'), 'the 2,500 pack is off at launch');
select pg_temp.ok(public.admin_price_set(null, 'zephyr_pro_monthly', 'price_ProM1', 999, null, true) ->> 'priceChangeId' is null, 'seeding opens no price change');
select pg_temp.ok((select stripe_price_id from public.billing_prices where lookup_key = 'zephyr_pro_monthly' and current) = 'price_ProM1',
  'the setup script swaps a seed price for the real Stripe price');
select pg_temp.ok(public.admin_price_set(null, 'zephyr_pro_monthly', 'price_Other', 999, null, true) ->> 'error' = 'invalid',
  'a real price can''t be re-seeded');
select public.admin_price_set(null, 'zephyr_studio_monthly', 'price_StuM1', 2499, null, true);
select public.admin_price_set(null, 'zephyr_pro_yearly', 'price_ProY1', 9900, null, true);
select public.admin_price_set(null, 'zephyr_topup_500', 'price_Top500', 500, null, true);
select pg_temp.ok(public.admin_pack_set(:sup, 'zephyr_topup_2500', true) ->> 'error' = 'forbidden'
  and public.admin_pack_set(:fin, 'zephyr_topup_2500', true) ->> 'active' = 'true', 'finance can turn a pack on, support can''t');
select public.admin_pack_set(:fin, 'zephyr_topup_2500', false);

-- ---- Customers and Checkout ---------------------------------------------------------------------
select pg_temp.ok(public.billing_customer_set(:mei, 'cus_Mei') = 'cus_Mei'
  and public.billing_customer_set(:mei, 'cus_Other') = 'cus_Mei', 'a customer is set once; later calls return the stored one');
select pg_temp.ok(public.billing_customer_set(:wei, 'cus_Mei') is null, 'a customer id can''t be claimed by a second member');
select public.billing_customer_set(:wei, 'cus_Wei');
select pg_temp.ok(public.billing_owner_by_customer('cus_Mei') = :mei, 'the webhook finds the owner by customer id');
select public.billing_checkout_record(:mei, 'cs_test_meisub0001', 'subscription', 'zephyr_pro_monthly');
select pg_temp.ok(public.billing_checkout_status(:mei, 'cs_test_meisub0001') ->> 'state' = 'pending'
  and public.billing_checkout_status(:mei, 'cs_test_meisub0001') ->> 'createdAt' is not null
  and public.billing_checkout_status(:wei, 'cs_test_meisub0001') is null, 'only the session''s owner can read its status');

-- ---- Subscriptions and plans --------------------------------------------------------------------
select pg_temp.ok((pg_temp.bal(:mei) ->> 'balance')::int = 30, 'Free: 30 credits');
select pg_temp.ok(public.billing_apply(:mei, pg_temp.sub('sub_Mei1', 'cus_Wei', 'active', 'price_ProM1', now() - interval '2 days', now() + interval '28 days'), now())
  ->> 'ignored' = 'customer_mismatch', 'a subscription for someone else''s customer is ignored');
select pg_temp.ok(public.billing_apply(:mei, pg_temp.sub('sub_Mei1', 'cus_Mei', 'active', 'price_ProM1', now() - interval '2 days', now() + interval '28 days'), now())
  @> '{"planAfter": "pro", "planBefore": "free", "email": "mei.bill@example.com"}', 'an active Pro subscription reports Pro and the email');
select pg_temp.ok((select plan_id from public.profiles where id = :mei) = 'pro', 'and makes the member Pro');
select pg_temp.ok((pg_temp.bal(:mei) ->> 'balance')::int = 1000 and (pg_temp.bal(:mei) ->> 'monthly')::int = 1000,
  'upgrading from Free gives Pro''s 1,000 credits for the period');
select pg_temp.ok((public._credit_period(:mei)).period_start = ((now() - interval '2 days') at time zone 'utc')::date,
  'a paid member''s credit period starts on the subscription''s period start');
select pg_temp.ok(public.billing_checkout_mark('cs_test_meisub0001', 'done') ->> 'state' = 'done'
  and public.billing_checkout_mark('cs_test_meisub0001', 'failed') ->> 'state' = 'done', 'a done session stays done');
select pg_temp.ok(public.billing_apply(:mei, pg_temp.sub('sub_Mei1', 'cus_Mei', 'active', 'price_StuM1', now() - interval '2 days', now() + interval '28 days'), now() - interval '1 minute')
  ->> 'stale' = 'true' and (select plan_id from public.profiles where id = :mei) = 'pro', 'an older read never overwrites a newer one');

-- Upgrade mid-period: the difference arrives once.
select public.billing_apply(:mei, pg_temp.sub('sub_Mei1', 'cus_Mei', 'active', 'price_StuM1', now() - interval '2 days', now() + interval '28 days'), now() + interval '1 second');
select pg_temp.ok((select plan_id from public.profiles where id = :mei) = 'studio' and (pg_temp.bal(:mei) ->> 'balance')::int = 5000,
  'Pro → Studio mid-period adds 4,000 credits (5,000 in all)');
select public.billing_apply(:mei, pg_temp.sub('sub_Mei1', 'cus_Mei', 'active', 'price_ProM1', now() - interval '2 days', now() + interval '28 days'), now() + interval '2 seconds');
select public.billing_apply(:mei, pg_temp.sub('sub_Mei1', 'cus_Mei', 'active', 'price_StuM1', now() - interval '2 days', now() + interval '28 days'), now() + interval '3 seconds');
select pg_temp.ok((pg_temp.bal(:mei) ->> 'balance')::int = 5000
  and (select count(*) from public.credit_ledger where owner_id = :mei and reason = 'plan_change' and label = 'Upgrade to Studio') = 1,
  'going back and forth in one period doesn''t grant the upgrade twice');

-- Payment due keeps the plan; the date it started stays put.
select public.billing_apply(:mei, pg_temp.sub('sub_Mei1', 'cus_Mei', 'past_due', 'price_StuM1', now() - interval '2 days', now() + interval '28 days', '{"payment_attempts": 2}'), now() + interval '4 seconds');
select pg_temp.ok((select plan_id from public.profiles where id = :mei) = 'studio'
  and (select past_due_since is not null and payment_attempts = 2 from public.subscriptions where owner_id = :mei), 'past_due keeps the plan and records since when');
update public.subscriptions set past_due_since = now() - interval '3 days' where owner_id = :mei;
select public.billing_apply(:mei, pg_temp.sub('sub_Mei1', 'cus_Mei', 'past_due', 'price_StuM1', now() - interval '2 days', now() + interval '28 days'), now() + interval '5 seconds');
select pg_temp.ok((select past_due_since < now() - interval '2 days' from public.subscriptions where owner_id = :mei), 'past_due_since doesn''t move on later events');
select pg_temp.ok((public.billing_status(:mei) #>> '{subscription,paymentDueSince}') is not null
  and public.billing_status(:mei) #>> '{subscription,plan}' = 'studio' and (public.billing_status(:mei) ->> 'hasCustomer')::boolean
  and public.billing_status(:mei) ->> 'state' = 'active', 'billing status shows the subscription, payment due and library state');

-- A scheduled downgrade is reported.
select public.billing_apply(:mei, pg_temp.sub('sub_Mei1', 'cus_Mei', 'active', 'price_StuM1', now() - interval '2 days', now() + interval '28 days',
  jsonb_build_object('schedule_id', 'sub_sched_Mei', 'scheduled_price_id', 'price_ProM1', 'scheduled_at', now() + interval '28 days')), now() + interval '6 seconds');
select pg_temp.ok(public.billing_status(:mei) #>> '{subscription,scheduledChange,plan}' = 'pro', 'a scheduled downgrade shows in billing status');

-- Ending: Free, unless a newer plan-keeping subscription exists.
select public.billing_apply(:mei, pg_temp.sub('sub_Mei2', 'cus_Mei', 'canceled', 'price_ProM1', now() - interval '40 days', now() - interval '10 days'), now() + interval '7 seconds');
select pg_temp.ok((select plan_id from public.profiles where id = :mei) = 'studio'
  and (select stripe_subscription_id from public.subscriptions where owner_id = :mei) = 'sub_Mei1', 'an older, ended subscription doesn''t replace the live one');
select public.billing_apply(:mei, pg_temp.sub('sub_Mei1', 'cus_Mei', 'canceled', 'price_StuM1', now() - interval '2 days', now() + interval '28 days'), now() + interval '8 seconds');
select pg_temp.ok((select plan_id from public.profiles where id = :mei) = 'free' and public.billing_status(:mei) -> 'subscription' = 'null'::jsonb,
  'a canceled subscription returns the member to Free');
select pg_temp.ok((public.billing_subscription(:mei) ->> 'keepsPlan')::boolean = false, 'the API sees it no longer keeps the plan');

-- Staff-set plans are never overwritten by Stripe.
update public.profiles set plan_id = 'studio', plan_source = 'admin' where id = :comp;
select public.billing_customer_set(:comp, 'cus_Comp');
select pg_temp.ok(public.billing_apply(:comp, pg_temp.sub('sub_Comp', 'cus_Comp', 'active', 'price_ProM1', now(), now() + interval '30 days'), now()) ->> 'planAfter' = 'studio'
  and (select plan_id from public.profiles where id = :comp) = 'studio', 'a comped (admin) plan stays when a subscription arrives');
select pg_temp.ok((public._credit_period(:comp)).period_start = public._ai_period(), 'a comped member keeps calendar-month credit periods');

-- A price made in the Stripe dashboard is recorded (not current).
select public.billing_customer_set(:sub2, 'cus_Sub2');
select pg_temp.ok(public.billing_apply(:sub2, pg_temp.sub('sub_Sub2', 'cus_Sub2', 'active', 'price_Dash1', now() - interval '1 day', now() + interval '29 days',
  '{"lookup_key": "zephyr_pro_monthly", "amount": 899}'), now()) ->> 'planAfter' = 'pro', 'a dashboard price on a known key still sets the plan');
select pg_temp.ok((select not current and amount = 899 from public.billing_prices where stripe_price_id = 'price_Dash1'), 'an unknown price on a known key is recorded, not current');

-- ---- Credit periods: yearly plans get monthly slices ---------------------------------------------
select public.billing_customer_set(:yr, 'cus_Year');
select public.billing_apply(:yr, pg_temp.sub('sub_Year', 'cus_Year', 'active', 'price_ProY1', now() - interval '40 days', now() + interval '325 days'), now());
select pg_temp.ok((public._credit_period(:yr)).period_start = ((((now() - interval '40 days') at time zone 'utc')::date)
                    + make_interval(months => (extract(year from age((now() at time zone 'utc')::date, ((now() - interval '40 days') at time zone 'utc')::date)) * 12
                                              + extract(month from age((now() at time zone 'utc')::date, ((now() - interval '40 days') at time zone 'utc')::date)))::int))::date
  and (public._credit_period(:yr)).period_end - (public._credit_period(:yr)).period_start between 28 and 31,
  'a yearly plan''s credit period is the monthly slice from its renewal date');
select pg_temp.ok((pg_temp.bal(:yr) ->> 'balance')::int = 1000, 'a yearly Pro member gets the month''s 1,000');

-- ---- Top-ups ---------------------------------------------------------------------------------------
update public.profiles set plan_id = 'free' where id = :wei;
select pg_temp.ok(public.billing_topup_grant(:wei, 'cs_test_weitop0001', 'pi_Wei1', 'zephyr_topup_500') ->> 'error' = 'unknown_session',
  'a top-up needs a Checkout session we created');
select public.billing_checkout_record(:wei, 'cs_test_weitop0001', 'topup', 'zephyr_topup_500');
select pg_temp.ok(public.billing_topup_grant(:wei, 'cs_test_weitop0001', 'pi_Wei1', 'zephyr_topup_1000') ->> 'error' = 'mismatch',
  'the event''s pack must match the session''s');
select pg_temp.ok(public.billing_topup_grant(:wei, 'cs_test_weitop0001', 'pi_Wei1', 'zephyr_topup_500') ->> 'granted' = 'true'
  and public.billing_topup_grant(:wei, 'cs_test_weitop0001', 'pi_Wei1', 'zephyr_topup_500') ->> 'granted' = 'false',
  'a top-up is granted once per session');
select pg_temp.ok((pg_temp.bal(:wei) ->> 'balance')::int = 530 and (pg_temp.bal(:wei) ->> 'monthlyBalance')::int = 30
  and (pg_temp.bal(:wei) #>> '{topUps,0,credits}')::int = 500
  and (pg_temp.bal(:wei) #>> '{topUps,0,expiresAt}')::timestamptz > now() + interval '364 days',
  'top-up credits sit beside the month''s and last 12 months');
select pg_temp.ok(public.billing_checkout_status(:wei, 'cs_test_weitop0001') ->> 'state' = 'done'
  and (public.billing_checkout_status(:wei, 'cs_test_weitop0001') ->> 'credits')::int = 500, 'the return page sees the top-up done');

-- Spend order: the month first, then top-ups; refunds go back to the top-up first.
update public.credit_balances set balance = 1 where owner_id = :wei;
select pg_temp.photo(:wei, 'a.jpg') as pa \gset
select pg_temp.photo(:wei, 'b.jpg') as pb \gset
select public.ai_bg_job_create(:wei, array[:'pa', :'pb']::uuid[], '{"bg": "white"}', null, false) as job \gset
select pg_temp.ok((select balance from public.credit_balances where owner_id = :wei) = 0
  and (select remaining from public.credit_topups where owner_id = :wei) = 499
  and (select (topup_drawn ->> (select id::text from public.credit_topups where owner_id = :wei))::int from public.ai_jobs where id = (:'job'::jsonb #>> '{job,id}')::uuid) = 1,
  'a 2-credit job takes 1 from the month and 1 from the top-up, and records the draw');
select public._ai_refund_item((select id from public.ai_job_items where job_id = (:'job'::jsonb #>> '{job,id}')::uuid order by seq limit 1));
select pg_temp.ok((select remaining from public.credit_topups where owner_id = :wei) = 500
  and (select balance from public.credit_balances where owner_id = :wei) = 0, 'the first refund goes back to the top-up');
select public._ai_refund_item((select id from public.ai_job_items where job_id = (:'job'::jsonb #>> '{job,id}')::uuid order by seq offset 1 limit 1));
select pg_temp.ok((select balance from public.credit_balances where owner_id = :wei) = 1, 'the next refund goes back to the month');
select pg_temp.ok(public._ai_refund_item((select id from public.ai_job_items where job_id = (:'job'::jsonb #>> '{job,id}')::uuid order by seq limit 1)) = 0
  and (select count(*) from public.credit_ledger where owner_id = :wei and reason = 'job_refund') = 2, 'an item is refunded once');
update public.ai_job_items set status = 'failed', error = 'provider_error' where job_id = (:'job'::jsonb #>> '{job,id}')::uuid;
update public.credit_balances set balance = 0 where owner_id = :wei;
select pg_temp.ok((public.ai_bg_job_create(:wei, array[:'pa']::uuid[], '{"bg": "white"}', null, false) ->> 'error') is null, 'top-up credits count toward the balance check');
select pg_temp.ok((select remaining from public.credit_topups where owner_id = :wei) = 499, 'and are spent when the month is empty');
update public.credit_topups set remaining = 0 where owner_id = :wei;
update public.credit_balances set balance = 0 where owner_id = :wei;
select pg_temp.ok((select (r ->> 'error') = 'insufficient_credits' and (r ->> 'balance')::int = 0
                     from (select public.ai_bg_job_create(:wei, array[pg_temp.photo(:wei, 'c.jpg')], '{"bg": "white"}', null, false) r) x),
  'no credits anywhere → insufficient_credits');

-- Refund removal and expiry.
update public.credit_topups set remaining = 300 where owner_id = :wei;
select pg_temp.ok((public.billing_topup_refund('pi_Wei1') ->> 'removed')::int = 300
  and (public.billing_topup_refund('pi_Wei1') ->> 'removed')::int = 0, 'a refunded top-up loses its unused credits, once');
select pg_temp.ok((select count(*) from public.credit_ledger where owner_id = :wei and reason = 'top_up_refund') = 1, 'one top_up_refund entry');
select public.billing_checkout_record(:wei, 'cs_test_weitop0002', 'topup', 'zephyr_topup_500');
select public.billing_topup_grant(:wei, 'cs_test_weitop0002', 'pi_Wei2', 'zephyr_topup_500');
update public.credit_topups set expires_at = now() - interval '1 minute' where payment_intent_id = 'pi_Wei2';
select pg_temp.ok((pg_temp.bal(:wei) ->> 'balance')::int = (pg_temp.bal(:wei) ->> 'monthlyBalance')::int, 'expired top-ups leave the balance');
select pg_temp.ok((select remaining from public.credit_topups where payment_intent_id = 'pi_Wei2') = 0
  and (select count(*) from public.credit_ledger where owner_id = :wei and reason = 'top_up_expiry') = 1, 'expired top-up credits are written off');
select public.billing_checkout_record(:wei, 'cs_test_weitop0003', 'topup', 'zephyr_topup_500');
select public.billing_topup_grant(:wei, 'cs_test_weitop0003', 'pi_Wei3', 'zephyr_topup_500');
update public.credit_topups set expires_at = now() - interval '1 minute' where payment_intent_id = 'pi_Wei3';
select pg_temp.ok((public.ai_prune() #>> '{billing,expiredCredits}')::int = 500, 'the 15-minute prune expires top-ups of idle members');

-- ---- Price changes ------------------------------------------------------------------------------
-- Mei back on Pro monthly, renewing in 10 days; Wei on Studio monthly, renewing in 5 days.
select public.billing_apply(:mei, pg_temp.sub('sub_Mei3', 'cus_Mei', 'active', 'price_ProM1', now() - interval '20 days', now() + interval '10 days'), now() + interval '9 seconds');
select public.billing_apply(:wei, pg_temp.sub('sub_Wei1', 'cus_Wei', 'active', 'price_StuM1', now() - interval '25 days', now() + interval '5 days'), now());
select pg_temp.ok((public.admin_price_preview('zephyr_pro_monthly', 1099) ->> 'subscribers')::int = 3
  and (public.admin_price_preview('zephyr_pro_monthly', 1099) ->> 'raise')::boolean, 'the preview counts who moves (Mei, the comped subscriber, the dashboard price)');
select pg_temp.ok(public.admin_price_set(:sup, 'zephyr_pro_monthly', 'price_ProM2', 1099, 'Costs', false) ->> 'error' = 'forbidden',
  'support can''t change prices');
select public.admin_price_set(:fin, 'zephyr_pro_monthly', 'price_ProM2', 1099, 'Costs went up', false) as ch \gset
select pg_temp.ok((:'ch'::jsonb ->> 'raise')::boolean and :'ch'::jsonb ->> 'priceChangeId' is not null
  and (select stripe_price_id from public.billing_prices where lookup_key = 'zephyr_pro_monthly' and current) = 'price_ProM2',
  'a new price becomes current and opens a price change');
select public.price_moves_due(100) as due \gset
select pg_temp.ok((select count(*) from jsonb_array_elements(:'due'::jsonb) x where x ->> 'ownerId' = :mei and x ->> 'status' = 'pending') = 1
  and not exists (select 1 from jsonb_array_elements(:'due'::jsonb) x where x ->> 'status' = 'notified'), 'the sweep asks for a notice to Mei, and moves nothing yet');
select pg_temp.ok((select (x ->> 'moveAt')::timestamptz = (now() + interval '10 days') + interval '1 month'
                     from jsonb_array_elements(:'due'::jsonb) x where x ->> 'ownerId' = :mei and x ->> 'status' = 'pending'),
  'a rise moves at the first renewal at least 30 days after the notice');
select public.price_move_mark((select (x ->> 'id')::uuid from jsonb_array_elements(:'due'::jsonb) x where x ->> 'ownerId' = :mei and x ->> 'status' = 'pending'), 'notified');
select pg_temp.ok((public.billing_status(:mei) #>> '{subscription,priceChange,amount}')::int = 1099, 'the member sees the announced price');
select pg_temp.ok((select count(*) from jsonb_array_elements(public.price_moves_due(100)) x where x ->> 'ownerId' = :mei and x ->> 'status' = 'pending') = 0,
  'a notified subscriber isn''t noticed again');
update public.price_moves set move_at = now() + interval '1 day' where owner_id = :mei and status = 'notified';
select pg_temp.ok((select count(*) from jsonb_array_elements(public.price_moves_due(100)) x where x ->> 'ownerId' = :mei and x ->> 'status' = 'notified') = 1,
  'within 48 hours of the renewal the move is due');

-- A drop moves at the next renewal.
select public.admin_price_set(:fin, 'zephyr_studio_monthly', 'price_StuM2', 1999, 'Launch offer', false);
select pg_temp.ok((select (x ->> 'moveAt')::timestamptz = now() + interval '5 days'
                     from jsonb_array_elements(public.price_moves_due(100)) x where x ->> 'ownerId' = :wei and x ->> 'status' = 'pending'),
  'a drop moves at the next renewal');

-- Stop: nothing more moves, and nobody is noticed again for that price.
select pg_temp.ok(jsonb_array_length(public.admin_price_change_stop(:fin, (:'ch'::jsonb ->> 'priceChangeId')::uuid) -> 'reverts') = 0, 'nothing to revert yet');
select pg_temp.ok((select status from public.price_moves where owner_id = :mei and change_id = (:'ch'::jsonb ->> 'priceChangeId')::uuid) = 'stopped',
  'stopping a change stops moves not yet applied');
select pg_temp.ok((select count(*) from jsonb_array_elements(public.price_moves_due(100)) x where x ->> 'ownerId' = :mei and x ->> 'status' = 'pending') = 0,
  'after a stop the subscriber isn''t noticed again for that price');
-- Back to the old amount: subscribers already paying it don't move.
select public.admin_price_set(:fin, 'zephyr_pro_monthly', 'price_ProM3', 999, 'Back to launch price', false);
select pg_temp.ok((select count(*) from jsonb_array_elements(public.price_moves_due(100)) x where x ->> 'ownerId' = :mei and x ->> 'status' = 'pending') = 0,
  'a subscriber already paying the current amount isn''t moved');
-- A moved subscriber whose renewal hasn't come is reverted on stop.
select public.admin_price_set(:fin, 'zephyr_pro_monthly', 'price_ProM4', 1199, 'Costs again', false) as ch2 \gset
select public.price_moves_due(100) as due2 \gset
select public.price_move_mark((select (x ->> 'id')::uuid from jsonb_array_elements(:'due2'::jsonb) x where x ->> 'ownerId' = :mei and x ->> 'status' = 'pending'), 'notified');
update public.price_moves set move_at = now() + interval '1 day' where owner_id = :mei and status = 'notified';
select public.price_move_mark((select id from public.price_moves where owner_id = :mei and status = 'notified'), 'moved');
select public.admin_price_change_stop(:fin, (:'ch2'::jsonb ->> 'priceChangeId')::uuid) as stop2 \gset
select pg_temp.ok((select x ->> 'fromPriceId' = 'price_ProM1' and x ->> 'toPriceId' = 'price_ProM4' and x ->> 'stripeSubscriptionId' = 'sub_Mei3'
                     from jsonb_array_elements(:'stop2'::jsonb -> 'reverts') x where x ->> 'ownerId' = :mei)
  and :'stop2'::jsonb ->> 'lookupKey' = 'zephyr_pro_monthly', 'stopping returns applied moves before their renewal for reverting');
select pg_temp.ok(public.price_move_mark((:'stop2'::jsonb #>> '{reverts,0,moveId}')::uuid, 'reverted') ->> 'status' = 'stopped', 'a reverted move is recorded');
select pg_temp.ok((public.admin_billing_overview(:fin) -> 'kpis' ->> 'paying')::int >= 2
  and jsonb_array_length(public.admin_billing_overview(:fin) -> 'changes') >= 3
  and public.admin_billing_overview(:sup) is null, 'the admin overview is for owner, admin and finance');

-- ---- Webhook events ------------------------------------------------------------------------------
select pg_temp.ok(public.billing_event_begin('evt_1', 'invoice.paid', now()) = 'new'
  and public.billing_event_begin('evt_1', 'invoice.paid', now()) = 'retry', 'an unfinished event is retried');
select public.billing_event_finish('evt_1', 'processed', null, :mei);
select pg_temp.ok(public.billing_event_begin('evt_1', 'invoice.paid', now()) = 'done', 'a processed event is done');
select public.billing_event_begin('evt_2', 'charge.refunded', now());
select public.billing_event_finish('evt_2', 'failed', 'Payload with spaces & secrets', null);
select pg_temp.ok((select error from public.billing_events where id = 'evt_2') = 'error', 'only short error codes are stored');

-- ---- Library state and galleries ------------------------------------------------------------------
update public.profiles set storage_bytes = 6::bigint * 1073741824 where id = :wei;
update public.profiles set plan_id = 'free' where id = :wei;
select pg_temp.ok(public._library_state(:wei) = 'read_only' and public.billing_status(:wei) ->> 'state' = 'read_only',
  'over the plan''s storage the library is read-only');

-- ---- Account deletion ----------------------------------------------------------------------------
update public.profiles set deletion_requested_at = now() - interval '31 days', deletion_due = now() - interval '1 day' where id = :yr;
select pg_temp.ok((select x ->> 'stripeSubscriptionId' from jsonb_array_elements(public.due_account_purges(100)) x where x ->> 'ownerId' = :yr) = 'sub_Year',
  'purge work carries the subscription to cancel');

-- ---- Security review fixes ------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('b7000000-0000-0000-0000-000000000006', 'dup.bill@example.com', now()),
  ('b7000000-0000-0000-0000-000000000007', 'grace.bill@example.com', now()),
  ('b7000000-0000-0000-0000-000000000008', 'del.bill@example.com', now()),
  ('b7000000-0000-0000-0000-000000000009', 'raise.bill@example.com', now()),
  ('b7000000-0000-0000-0000-00000000000a', 'nomail.bill@example.com', now());
\set dup '\'b7000000-0000-0000-0000-000000000006\''
\set grace '\'b7000000-0000-0000-0000-000000000007\''
\set del '\'b7000000-0000-0000-0000-000000000008\''
\set rz '\'b7000000-0000-0000-0000-000000000009\''

-- Two live subscriptions (two Checkouts paid): the second never replaces the first.
select public.billing_customer_set(:dup, 'cus_Dup');
select public.billing_apply(:dup, pg_temp.sub('sub_DupA', 'cus_Dup', 'active', 'price_ProM1', now() - interval '1 day', now() + interval '29 days'), now());
select public.billing_apply(:dup, pg_temp.sub('sub_DupB', 'cus_Dup', 'active', 'price_StuM1', now(), now() + interval '30 days'), now() + interval '1 second') as dupr \gset
select pg_temp.ok((:'dupr'::jsonb ->> 'duplicate')::boolean and :'dupr'::jsonb ->> 'storedSubscriptionId' = 'sub_DupA'
  and (select plan_id from public.profiles where id = :dup) = 'pro'
  and (select stripe_subscription_id from public.subscriptions where owner_id = :dup) = 'sub_DupA',
  'a second live subscription is reported as a duplicate and changes nothing');
select public.billing_apply(:dup, pg_temp.sub('sub_DupA', 'cus_Dup', 'canceled', 'price_ProM1', now() - interval '1 day', now() + interval '29 days'), now() + interval '2 seconds');
select public.billing_apply(:dup, pg_temp.sub('sub_DupB', 'cus_Dup', 'active', 'price_StuM1', now(), now() + interval '30 days'), now() + interval '3 seconds');
select pg_temp.ok((select plan_id from public.profiles where id = :dup) = 'studio'
  and (select stripe_subscription_id from public.subscriptions where owner_id = :dup) = 'sub_DupB',
  'once the stored subscription has ended, the newer one takes over');

-- Open Checkouts and the return page's own look at Stripe.
select public.billing_checkout_record(:dup, 'cs_test_duptab00001', 'subscription', 'zephyr_pro_monthly', 'checkout:k1');
select public.billing_checkout_record(:dup, 'cs_test_duptab00002', 'subscription', 'zephyr_studio_monthly', 'checkout:k2');
select public.billing_checkout_record(:dup, 'cs_test_duptop00001', 'topup', 'zephyr_topup_500', 'checkout:k3');
select pg_temp.ok(public.billing_checkout_open(:dup, 'subscription', 'checkout:k2') = '["cs_test_duptab00001"]'::jsonb
  and public.billing_checkout_open(:mei, 'subscription', 'checkout:k2') = '[]'::jsonb,
  'the other open subscription Checkouts are listed, never the one this retry returns, never another member''s');
select pg_temp.ok(public.billing_checkout_poll(:dup, 'cs_test_duptab00001') and not public.billing_checkout_poll(:dup, 'cs_test_duptab00001')
  and not public.billing_checkout_poll(:mei, 'cs_test_duptab00002'), 'the return page asks Stripe at most once per 10 seconds, and only for its own session');
update public.checkout_sessions set fetched_at = now() - interval '11 seconds' where id = 'cs_test_duptab00001';
select pg_temp.ok(public.billing_checkout_poll(:dup, 'cs_test_duptab00001'), '10 seconds later it may ask again');

-- A refunded top-up found by its session (no payment intent recorded).
select public.billing_topup_grant(:dup, 'cs_test_duptop00001', null, 'zephyr_topup_500');
select pg_temp.ok((public.billing_topup_refund_by_session('cs_test_duptop00001') ->> 'removed')::int = 500
  and (public.billing_topup_refund_by_session('cs_test_duptop00001') ->> 'removed')::int = 0
  and public.billing_topup_refund_by_session('cs_test_nosuch00001') is null, 'a refund by session removes the unused credits once');

-- Past due keeps the plan for 21 days at most.
select public.billing_customer_set(:grace, 'cus_Grace');
select public.billing_apply(:grace, pg_temp.sub('sub_Grace', 'cus_Grace', 'past_due', 'price_ProM1', now() - interval '25 days', now() + interval '5 days'), now());
select pg_temp.ok((select plan_id from public.profiles where id = :grace) = 'pro', 'newly past due keeps the plan');
update public.subscriptions set past_due_since = now() - interval '22 days' where owner_id = :grace;
select public.billing_past_due_expire(100) as pde \gset
select pg_temp.ok((select count(*) from jsonb_array_elements(:'pde'::jsonb) x where x ->> 'ownerId' = :grace and x ->> 'email' = 'grace.bill@example.com') = 1
  and (select plan_id from public.profiles where id = :grace) = 'free'
  and jsonb_array_length(public.billing_past_due_expire(100)) = 0, 'past the grace period the daily job ends the plan, once');
select pg_temp.ok((public._credit_period(:grace)).period_start = public._ai_period()
  and (public.billing_subscription(:grace) ->> 'keepsPlan')::boolean = false, 'and credits go back to calendar months; the API may sell a new plan');
select public.billing_apply(:grace, pg_temp.sub('sub_Grace', 'cus_Grace', 'past_due', 'price_ProM1', now() - interval '25 days', now() + interval '5 days'), now() + interval '1 second');
select pg_temp.ok((select plan_id from public.profiles where id = :grace) = 'free', 'a later past_due event doesn''t bring the plan back');
select public.billing_apply(:grace, pg_temp.sub('sub_Grace2', 'cus_Grace', 'active', 'price_ProM1', now(), now() + interval '30 days'), now() + interval '2 seconds');
select pg_temp.ok((select plan_id from public.profiles where id = :grace) = 'pro'
  and (select stripe_subscription_id from public.subscriptions where owner_id = :grace) = 'sub_Grace2', 'a new subscription replaces one past its grace');

-- Pending deletion with a subscription that still renews: the cron asks Stripe again.
select public.billing_customer_set(:del, 'cus_Del');
select public.billing_apply(:del, pg_temp.sub('sub_Del', 'cus_Del', 'active', 'price_ProM1', now() - interval '1 day', now() + interval '29 days'), now());
select public.request_account_deletion(:del);
select pg_temp.ok((select count(*) from jsonb_array_elements(public.billing_deletion_cancels_due(100)) x
                    where x ->> 'ownerId' = :del and x ->> 'stripeSubscriptionId' = 'sub_Del') = 1, 'pending deletion with a renewing subscription is listed');
select public.billing_apply(:del, pg_temp.sub('sub_Del', 'cus_Del', 'active', 'price_ProM1', now() - interval '1 day', now() + interval '29 days',
  '{"cancel_at_period_end": true}'), now() + interval '1 second');
select pg_temp.ok((select count(*) from jsonb_array_elements(public.billing_deletion_cancels_due(100)) x where x ->> 'ownerId' = :del) = 0,
  'once it stops renewing it isn''t');

-- A rise is judged per subscriber; a stopped rise leaves subscribers grandfathered until a later rise for them.
select public.admin_price_set(null, 'zephyr_studio_yearly', 'price_StuY1', 24900, null, true);
select public.billing_customer_set(:rz, 'cus_Raise');
select public.billing_apply(:rz, pg_temp.sub('sub_Raise', 'cus_Raise', 'active', 'price_StuY1', now() - interval '100 days', now() + interval '265 days'), now());
select public.admin_price_set(:fin, 'zephyr_studio_yearly', 'price_StuY2', 29900, 'Costs', false) as y2 \gset
select public.price_moves_due(500);
select public.admin_price_change_stop(:fin, (:'y2'::jsonb ->> 'priceChangeId')::uuid);
select pg_temp.ok((public.admin_price_preview('zephyr_studio_yearly', 27900) ->> 'raise')::boolean
  and not (public.admin_price_preview('zephyr_studio_yearly', 19900) ->> 'raise')::boolean,
  'a "cut" still above what a grandfathered subscriber pays is a rise; below it isn''t');
select public.admin_price_set(:fin, 'zephyr_studio_yearly', 'price_StuY3', 27900, 'Simplify', false) as y3 \gset
select pg_temp.ok((:'y3'::jsonb ->> 'raise')::boolean, 'and setting it says so (passkey and the Owners'' email)');
select public.price_moves_due(500) as dy3 \gset
select pg_temp.ok((select count(*) from jsonb_array_elements(:'dy3'::jsonb) x where x ->> 'ownerId' = :rz and x ->> 'toPriceId' = 'price_StuY3' and x ->> 'status' = 'pending') = 1,
  'the grandfathered subscriber gets a notice for the new rise');
select public.price_move_mark((select id from public.price_moves where owner_id = :rz and to_price_id = 'price_StuY3'), 'notified');
update public.price_moves set move_at = now() + interval '1 day' where owner_id = :rz and to_price_id = 'price_StuY3';
select public.price_move_mark((select id from public.price_moves where owner_id = :rz and to_price_id = 'price_StuY3'), 'moved');
select public.admin_price_set(:fin, 'zephyr_studio_yearly', 'price_StuY4', 25900, 'Again', false);
select pg_temp.ok((select status from public.price_changes where id = (:'y3'::jsonb ->> 'priceChangeId')::uuid) = 'moving'
  and jsonb_array_length(public.admin_price_change_stop(:fin, (:'y3'::jsonb ->> 'priceChangeId')::uuid) -> 'reverts') = 1,
  'a later price doesn''t close a change with applied moves; Stop can still revert them');

-- A notice that never went out by the move date: the move is skipped, never applied.
select public.price_moves_due(500);
update public.price_moves set move_at = now() - interval '1 minute' where owner_id = :rz and to_price_id = 'price_StuY4' and status = 'pending';
select public.price_moves_due(500) as dnm \gset
select pg_temp.ok((select status = 'skipped' and skip_reason = 'no_email' from public.price_moves where owner_id = :rz and to_price_id = 'price_StuY4')
  and (select count(*) from jsonb_array_elements(:'dnm'::jsonb) x where x ->> 'ownerId' = :rz and x ->> 'toPriceId' = 'price_StuY4') = 0,
  'an unsent notice past its date skips the move');

select pg_temp.ok(has_function_privilege('service_role', 'public.billing_checkout_open(uuid, text, text)', 'execute')
  and has_function_privilege('service_role', 'public.billing_past_due_expire(integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.billing_topup_refund_by_session(text)', 'execute')
  and not has_function_privilege('service_role', 'public._topup_refund(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public._key_floor(text)', 'execute'), 'new functions are for the API only; helpers for nobody');

-- ---- Privileges -----------------------------------------------------------------------------------
select pg_temp.ok(not exists (
  select 1 from unnest(array['billing_customers', 'billing_prices', 'subscriptions', 'billing_events', 'checkout_sessions',
                             'credit_topups', 'price_changes', 'price_moves']) t
   where has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')
      or has_table_privilege('authenticated', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'update')),
  'browser roles can''t read or write any billing table');
select pg_temp.ok((select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname in ('billing_customers', 'billing_prices', 'subscriptions', 'billing_events',
                                                                  'checkout_sessions', 'credit_topups', 'price_changes', 'price_moves')),
  'RLS is on for every billing table');
set local role authenticated;
select pg_temp.ok((select count(*) from public.profiles) = 0, 'authenticated without a session sees no profiles');
reset role;
select pg_temp.ok(not has_function_privilege('anon', 'public.billing_apply(uuid, jsonb, timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.billing_topup_grant(uuid, text, text, text)', 'execute')
  and has_function_privilege('service_role', 'public.billing_apply(uuid, jsonb, timestamptz)', 'execute'), 'only the API can call billing functions');
select pg_temp.ok(not has_function_privilege('service_role', 'public._credits_charge(uuid, uuid, integer, text, date)', 'execute')
  and not has_function_privilege('service_role', 'public._credit_period(uuid)', 'execute'), 'internal billing helpers aren''t callable');

rollback;
\echo 'All billing tests passed.'
