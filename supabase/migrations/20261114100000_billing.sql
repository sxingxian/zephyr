-- Phase 7: billing (Stripe, Managed Payments). Customers, prices and lookup keys, subscriptions mirrored from
-- Stripe, webhook events, Checkout sessions, top-up credits, and price changes for existing subscribers.
-- See docs/phase-7.md.
--
-- Every entry point is security definer, takes ids the API read from the verified session (or from a verified
-- Stripe event), and only service_role (the API Worker) may call it.
--
-- Lock order (always in this order, never the reverse):
--   billing lock (zephyr:billing:<owner>) → credits lock (zephyr:credits:<owner>) → job and item rows.
-- Credits:  credit_balances.balance is now the current period's plan credits only. Top-up credits live in
--           credit_topups (remaining, expires_at). Spendable = month + unexpired top-ups. Charges draw from the
--           month first, then top-ups by soonest expiry; ai_jobs.topup_drawn records the draws so refunds go
--           back to those top-ups first.
-- Periods:  Free (and comped plans): calendar months in UTC, as in phase 6. A Stripe subscription: monthly
--           slices counted from the subscription's current period start (a monthly plan's slice is its period).

-- ---------------------------------------------------------------------------------------------
-- Invites: a source for Studio team invites (used by the teams migration; a new enum value can't be used in
-- the transaction that adds it).
-- ---------------------------------------------------------------------------------------------
alter type public.invite_source add value if not exists 'team';

-- ---------------------------------------------------------------------------------------------
-- Profiles: who set the plan. A Stripe update never overwrites a plan set by staff (comped accounts).
-- ---------------------------------------------------------------------------------------------
alter table public.profiles
  add column plan_source text not null default 'stripe' check (plan_source in ('stripe', 'admin'));

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table public.billing_customers (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text not null unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
  created_at timestamptz not null default now()
);
alter table public.billing_customers enable row level security;

-- One row per Stripe Price we've used. Exactly one current row per lookup key.
create table public.billing_prices (
  stripe_price_id text primary key check (stripe_price_id ~ '^price_[A-Za-z0-9_]{1,250}$'),
  lookup_key text not null check (lookup_key in ('zephyr_pro_monthly', 'zephyr_pro_yearly', 'zephyr_studio_monthly',
                                                  'zephyr_studio_yearly', 'zephyr_topup_500', 'zephyr_topup_1000',
                                                  'zephyr_topup_2500')),
  plan_id text references public.plans (id),
  billing_interval text check (billing_interval in ('month', 'year')),
  credits integer check (credits is null or credits > 0),
  amount integer not null check (amount between 1 and 10000000),
  currency text not null default 'usd' check (currency = 'usd'),
  active boolean not null default true,
  current boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  constraint billing_prices_shape check (
    (plan_id is not null and plan_id <> 'free' and billing_interval is not null and credits is null)
    or (plan_id is null and billing_interval is null and credits is not null))
);
create unique index billing_prices_one_current on public.billing_prices (lookup_key) where current;
create index billing_prices_key on public.billing_prices (lookup_key, created_at desc);
alter table public.billing_prices enable row level security;

create table public.subscriptions (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  stripe_subscription_id text not null unique check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,250}$'),
  stripe_customer_id text not null check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
  status text not null check (status in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due',
                                         'canceled', 'unpaid', 'paused')),
  plan_id text not null check (plan_id in ('pro', 'studio')) references public.plans (id),
  billing_interval text not null check (billing_interval in ('month', 'year')),
  stripe_price_id text not null,
  item_id text check (item_id is null or item_id ~ '^si_[A-Za-z0-9]{1,250}$'),
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  schedule_id text check (schedule_id is null or schedule_id ~ '^sub_sched_[A-Za-z0-9]{1,250}$'),
  scheduled_price_id text,
  scheduled_plan text check (scheduled_plan is null or scheduled_plan in ('pro', 'studio')),
  scheduled_interval text check (scheduled_interval is null or scheduled_interval in ('month', 'year')),
  scheduled_at timestamptz,
  past_due_since timestamptz,
  payment_attempts integer not null default 0 check (payment_attempts between 0 and 1000),
  synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (current_period_end > current_period_start)
);
create index subscriptions_price on public.subscriptions (stripe_price_id);
alter table public.subscriptions enable row level security;

-- Webhook events: idempotency and the admin's recent-events list. Never the payload.
create table public.billing_events (
  id text primary key check (id ~ '^evt_[A-Za-z0-9]{1,250}$'),
  type text not null check (length(type) between 1 and 100),
  stripe_created timestamptz,
  received_at timestamptz not null default now(),
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  error text check (error is null or error ~ '^[a-z0-9_]{1,60}$'),
  owner_id uuid references auth.users (id) on delete set null
);
create index billing_events_recent on public.billing_events (received_at desc);
alter table public.billing_events enable row level security;

create table public.checkout_sessions (
  id text primary key check (id ~ '^cs_(test|live)_[A-Za-z0-9]{10,200}$'),
  owner_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('subscription', 'topup')),
  lookup_key text not null,
  -- refunded: paid, but it was a second live subscription (two tabs): canceled and refunded in full.
  state text not null default 'pending' check (state in ('pending', 'done', 'failed', 'refunded')),
  -- The Checkout idempotency key: an idempotent retry returns this same session, so it's never expired by its
  -- own retry (see billing_checkout_open).
  idem_key text check (idem_key is null or length(idem_key) <= 200),
  -- Last time the return page made the API ask Stripe itself (at most once per 10 s per session).
  fetched_at timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index checkout_sessions_owner on public.checkout_sessions (owner_id, created_at desc);
alter table public.checkout_sessions enable row level security;

create table public.credit_topups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  lookup_key text not null,
  credits integer not null check (credits > 0),
  remaining integer not null check (remaining >= 0 and remaining <= credits),
  expires_at timestamptz not null,
  checkout_session_id text not null unique,
  payment_intent_id text unique check (payment_intent_id is null or payment_intent_id ~ '^pi_[A-Za-z0-9]{1,250}$'),
  -- Fully refunded or disputed. A partial refund removes credits in proportion (refund_removed tracks how many
  -- credits refunds have already removed), never more than are left.
  refunded_at timestamptz,
  refund_removed integer not null default 0 check (refund_removed >= 0),
  created_at timestamptz not null default now()
);
create index credit_topups_owner on public.credit_topups (owner_id, expires_at) where remaining > 0;
alter table public.credit_topups enable row level security;

create table public.price_changes (
  id uuid primary key default gen_random_uuid(),
  lookup_key text not null,
  from_amount integer not null,
  to_amount integer not null,
  to_price_id text not null references public.billing_prices (stripe_price_id),
  status text not null default 'notifying' check (status in ('notifying', 'moving', 'done', 'stopped')),
  reason text not null check (length(reason) between 1 and 300),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  stopped_at timestamptz
);
create index price_changes_recent on public.price_changes (created_at desc);
alter table public.price_changes enable row level security;

create table public.price_moves (
  id uuid primary key default gen_random_uuid(),
  change_id uuid not null references public.price_changes (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  stripe_subscription_id text not null,
  from_price_id text not null,
  to_price_id text not null,
  notice_at timestamptz,
  move_at timestamptz not null,
  -- pending → notified (notice sent) → moving (claimed by the cron for the Stripe swap) → moved.
  -- Stop: pending/notified → stopped; moved (not yet renewed) → revert_pending → stopped (reverted_at set), or
  -- revert_failed when the renewal came first. A claimed move finished after Stop goes to revert_pending.
  status text not null default 'pending'
    check (status in ('pending', 'notified', 'moving', 'moved', 'skipped', 'stopped', 'revert_pending', 'revert_failed')),
  claimed_at timestamptz,
  moved_at timestamptz,
  reverted_at timestamptz,
  -- Why a move was skipped: changed (plan, price or status moved on), superseded (a later price), no_email
  -- (no notice could be sent before the move date: a rise is never applied without one).
  skip_reason text check (skip_reason is null or skip_reason in ('changed', 'superseded', 'no_email')),
  created_at timestamptz not null default now(),
  unique (change_id, owner_id)
);
create index price_moves_open on public.price_moves (status, move_at)
  where status in ('pending', 'notified', 'moving', 'moved', 'revert_pending');
create index price_moves_owner on public.price_moves (owner_id, created_at desc);
alter table public.price_moves enable row level security;

-- Credits (phase 6 tables): new reasons, which top-ups a job drew from.
alter table public.credit_ledger drop constraint credit_ledger_reason_check;
alter table public.credit_ledger add constraint credit_ledger_reason_check
  check (reason in ('monthly_grant', 'period_expiry', 'job_charge', 'job_refund', 'admin_adjust', 'top_up',
                    'plan_change', 'top_up_expiry', 'top_up_refund'));
create unique index credit_ledger_plan_change_once on public.credit_ledger (owner_id, period_start, label) where reason = 'plan_change';
alter table public.ai_jobs add column topup_drawn jsonb not null default '{}'::jsonb
  check (jsonb_typeof(topup_drawn) = 'object');

-- Seed prices (placeholder Stripe ids; scripts/stripe-setup.mjs swaps in the real ones via admin_price_set p_seed).
insert into public.billing_prices (stripe_price_id, lookup_key, plan_id, billing_interval, credits, amount, active, current) values
  ('price_seed_zephyr_pro_monthly',    'zephyr_pro_monthly',    'pro',    'month', null,   999, true,  true),
  ('price_seed_zephyr_pro_yearly',     'zephyr_pro_yearly',     'pro',    'year',  null,  9900, true,  true),
  ('price_seed_zephyr_studio_monthly', 'zephyr_studio_monthly', 'studio', 'month', null,  2499, true,  true),
  ('price_seed_zephyr_studio_yearly',  'zephyr_studio_yearly',  'studio', 'year',  null, 24900, true,  true),
  ('price_seed_zephyr_topup_500',      'zephyr_topup_500',      null,     null,     500,   500, true,  true),
  ('price_seed_zephyr_topup_1000',     'zephyr_topup_1000',     null,     null,    1000,  1000, true,  true),
  ('price_seed_zephyr_topup_2500',     'zephyr_topup_2500',     null,     null,    2500,  2500, false, true);

-- ---------------------------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------------------------
create function public._lock_billing(p_owner uuid) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('zephyr:billing:' || p_owner::text, 0));
$$;

create function public._sub_keeps_plan(p_status text) returns boolean
language sql immutable set search_path = '' as $$ select p_status in ('active', 'trialing', 'past_due') $$;

-- How long a past_due subscription keeps its plan while Stripe retries the card (docs/phase-7.md). Stripe's
-- dunning must end in "cancel the subscription"; this cap holds even if it doesn't.
create function public._past_due_grace() returns interval
language sql immutable set search_path = '' as $$ select interval '21 days' $$;

-- Keeps the paid plan: active or trialing, or past_due for at most the grace period.
create function public._sub_keeps(p_status text, p_past_due_since timestamptz) returns boolean
language sql stable set search_path = '' as $$
  select p_status in ('active', 'trialing')
      or (p_status = 'past_due' and (p_past_due_since is null or p_past_due_since > now() - public._past_due_grace()));
$$;

-- The subscription that sets the member's plan right now (Stripe-sourced plan matching a plan-keeping
-- subscription), or no row.
create function public._live_subscription(p_owner uuid) returns setof public.subscriptions
language sql stable set search_path = '' as $$
  select s.* from public.subscriptions s join public.profiles p on p.id = s.owner_id
   where s.owner_id = p_owner and public._sub_keeps(s.status, s.past_due_since) and p.plan_source = 'stripe' and p.plan_id = s.plan_id;
$$;

-- The credit period containing now(): (start, end), dates in UTC, end exclusive.
create function public._credit_period(p_owner uuid, out period_start date, out period_end date)
language plpgsql stable set search_path = '' as $$
declare
  s public.subscriptions;
  base date;
  today date := (now() at time zone 'utc')::date;
  k integer;
  cpe date;
begin
  select * into s from public._live_subscription(p_owner);
  if not found then
    period_start := public._ai_period();
    period_end := (period_start + interval '1 month')::date;
    return;
  end if;
  base := (s.current_period_start at time zone 'utc')::date;
  cpe := (s.current_period_end at time zone 'utc')::date;
  if today < base then
    period_start := base;
  else
    k := (extract(year from age(today, base)) * 12 + extract(month from age(today, base)))::integer;
    period_start := (base + make_interval(months => k))::date;
  end if;
  period_end := (base + make_interval(months => coalesce(k, 0) + 1))::date;
  if cpe > period_start and cpe < period_end then period_end := cpe; end if;
end;
$$;

create function public._plan_monthly_credits(p_plan text) returns integer
language sql stable set search_path = '' as $$
  select coalesce((select r.cloud_credits_month from public._ai_rules(p_plan) r), 0);
$$;

create function public._plan_seats(p_plan text) returns integer
language sql stable set search_path = '' as $$
  select coalesce((select pl.seats from public.plan_limits pl
                     join public.plan_limit_versions v on v.id = pl.version_id and v.status = 'active'
                    where pl.plan_id = p_plan), 1);
$$;

-- Unexpired top-up credits (not refunded).
create function public._topup_balance(p_owner uuid) returns integer
language sql stable set search_path = '' as $$
  select coalesce(sum(t.remaining), 0)::integer from public.credit_topups t
   where t.owner_id = p_owner and t.remaining > 0 and t.expires_at > now() and t.refunded_at is null;
$$;

-- Writes off expired top-up credits (call under the owner's credits lock).
create function public._topups_expire(p_owner uuid) returns integer
language plpgsql volatile set search_path = '' as $$
declare
  t record;
  n integer := 0;
  cur date := (public._credit_period(p_owner)).period_start;
begin
  for t in select * from public.credit_topups
            where owner_id = p_owner and remaining > 0 and expires_at <= now() and refunded_at is null
            order by expires_at for update loop
    insert into public.credit_ledger (owner_id, delta, reason, label, period_start)
    values (p_owner, -t.remaining, 'top_up_expiry', 'Top-up credits from ' || to_char(t.created_at at time zone 'utc', 'FMDD Mon YYYY') || ' expired', cur);
    update public.credit_topups set remaining = 0 where id = t.id;
    n := n + t.remaining;
  end loop;
  return n;
end;
$$;

-- Spendable credits now: the month's plus unexpired top-ups (call under the credits lock, after _credits_roll).
create function public._credits_available(p_owner uuid) returns integer
language sql stable set search_path = '' as $$
  select coalesce((select b.balance from public.credit_balances b where b.owner_id = p_owner), 0) + public._topup_balance(p_owner);
$$;

-- Charges p_amount for a job: the month's credits first, then top-ups by soonest expiry. Writes one job_charge
-- ledger entry. Call under the credits lock, after _credits_roll and a balance check.
create function public._credits_charge(p_owner uuid, p_job uuid, p_amount integer, p_label text, p_period date)
returns void
language plpgsql volatile set search_path = '' as $$
declare
  monthly integer;
  take integer;
  left_ integer := p_amount;
  t record;
  drawn jsonb := '{}'::jsonb;
begin
  if p_amount <= 0 then return; end if;
  if public._credits_available(p_owner) < p_amount then
    raise exception 'insufficient credits' using errcode = 'check_violation';
  end if;
  select balance into monthly from public.credit_balances where owner_id = p_owner for update;
  take := least(coalesce(monthly, 0), left_);
  if take > 0 then
    update public.credit_balances set balance = balance - take, updated_at = now() where owner_id = p_owner;
    left_ := left_ - take;
  end if;
  for t in select id, remaining from public.credit_topups
            where owner_id = p_owner and remaining > 0 and expires_at > now() and refunded_at is null
            order by expires_at, id for update loop
    exit when left_ <= 0;
    take := least(t.remaining, left_);
    update public.credit_topups set remaining = remaining - take where id = t.id;
    drawn := drawn || jsonb_build_object(t.id::text, take);
    left_ := left_ - take;
  end loop;
  insert into public.credit_ledger (owner_id, delta, reason, label, job_id, period_start)
  values (p_owner, -p_amount, 'job_charge', p_label, p_job, p_period);
  if drawn <> '{}'::jsonb then
    update public.ai_jobs j
       set topup_drawn = (select coalesce(jsonb_object_agg(k, to_jsonb(coalesce((j.topup_drawn ->> k)::integer, 0)
                                                                          + coalesce((drawn ->> k)::integer, 0))), '{}'::jsonb)
                            from (select jsonb_object_keys(j.topup_drawn) k union select jsonb_object_keys(drawn)) keys)
     where j.id = p_job;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Credits (phase 6 functions, reworked)
-- ---------------------------------------------------------------------------------------------
-- Brings the member's credits into the current period (call under the credits lock): expired top-ups are
-- written off; in a new period unused plan credits expire unless the plan rolls them over, then the plan's
-- monthly credits are granted. Idempotent.
create or replace function public._credits_roll(p_owner uuid) returns public.credit_balances
language plpgsql volatile set search_path = '' as $$
declare
  cur date := (public._credit_period(p_owner)).period_start;
  b public.credit_balances;
  r record;
begin
  perform public._topups_expire(p_owner);
  select * into r from public._ai_rules(public._ai_plan(p_owner));
  select * into b from public.credit_balances where owner_id = p_owner for update;
  if not found then
    insert into public.credit_balances (owner_id, balance, period_start) values (p_owner, 0, cur) returning * into b;
  elsif b.period_start >= cur then
    return b;
  else
    if not coalesce(r.credits_rollover, false) and b.balance > 0 then
      insert into public.credit_ledger (owner_id, delta, reason, label, period_start)
      values (p_owner, -b.balance, 'period_expiry', 'Unused credits from ' || to_char(b.period_start, case when extract(day from b.period_start) = 1 then 'FMMonth YYYY' else 'FMDD Mon YYYY' end) || ' expired', b.period_start)
      on conflict do nothing;
      if found then b.balance := 0; end if;
    end if;
    b.period_start := cur;
  end if;
  if coalesce(r.cloud_credits_month, 0) > 0 then
    insert into public.credit_ledger (owner_id, delta, reason, label, period_start)
    values (p_owner, r.cloud_credits_month, 'monthly_grant', 'Monthly credits', cur)
    on conflict do nothing;
    if found then b.balance := b.balance + r.cloud_credits_month; end if;
  end if;
  update public.credit_balances set balance = b.balance, period_start = b.period_start, updated_at = now()
   where owner_id = p_owner returning * into b;
  return b;
end;
$$;

create or replace function public._credits_json(b public.credit_balances) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'balance', b.balance + public._topup_balance(b.owner_id),
    'monthlyBalance', b.balance,
    'topUps', coalesce((select jsonb_agg(jsonb_build_object('credits', t.remaining, 'expiresAt', t.expires_at) order by t.expires_at, t.id)
                          from public.credit_topups t
                         where t.owner_id = b.owner_id and t.remaining > 0 and t.expires_at > now() and t.refunded_at is null), '[]'::jsonb),
    'monthly', coalesce(r.cloud_credits_month, 0),
    'periodStart', b.period_start,
    'periodEnd', case when (public._credit_period(b.owner_id)).period_start = b.period_start
                      then (public._credit_period(b.owner_id)).period_end
                      else (b.period_start + interval '1 month')::date end,
    'rollover', coalesce(r.credits_rollover, false),
    'bgCreditsPerPhoto', (select s.bg_credits_per_photo from public.ai_settings s where s.id = 1))
  from public._ai_rules(public._ai_plan(b.owner_id)) r;
$$;

-- Refunds an item's current charge once (call under the owner's credits lock, with the item row locked).
-- The credits go back to the unexpired, unrefunded top-ups the job drew from first, then to the month. A part
-- drawn from a top-up that has since been refunded to the customer is not returned.
create or replace function public._ai_refund_item(p_item uuid) returns integer
language plpgsql volatile set search_path = '' as $$
declare
  it public.ai_job_items;
  b public.credit_balances;
  j public.ai_jobs;
  left_ integer;
  back integer := 0;
  lost integer := 0;
  t record;
  give integer;
  drawn jsonb;
begin
  select * into it from public.ai_job_items where id = p_item;
  if not found or it.credits <= 0 then return 0; end if;
  b := public._credits_roll(it.owner_id);
  if exists (select 1 from public.credit_ledger l
              where l.item_id = it.id and l.item_charge = it.charge_seq and l.reason = 'job_refund') then
    update public.ai_job_items set credits = 0 where id = p_item;
    return 0;
  end if;
  select * into j from public.ai_jobs where id = it.job_id for update;
  drawn := coalesce(j.topup_drawn, '{}'::jsonb);
  left_ := it.credits;
  for t in select ct.*, (drawn ->> ct.id::text)::integer as d from public.credit_topups ct
            where ct.id::text in (select jsonb_object_keys(drawn)) and (drawn ->> ct.id::text)::integer > 0
            order by ct.expires_at desc, ct.id for update of ct loop
    exit when left_ <= 0;
    -- Never above what refunds left of the top-up (credits a refund removed don't come back).
    give := least(t.d, left_, t.credits - t.refund_removed - t.remaining);
    if give <= 0 then continue; end if;
    if t.refunded_at is null and t.expires_at > now() then
      update public.credit_topups set remaining = remaining + give where id = t.id;
      back := back + give;
    else
      lost := lost + give;
    end if;
    drawn := drawn || jsonb_build_object(t.id::text, t.d - give);
    left_ := left_ - give;
  end loop;
  if left_ > 0 then
    update public.credit_balances set balance = balance + left_, updated_at = now() where owner_id = it.owner_id;
    back := back + left_;
  end if;
  update public.ai_jobs set topup_drawn = drawn, credits_refunded = credits_refunded + it.credits, updated_at = now() where id = it.job_id;
  update public.ai_job_items set credits = 0 where id = p_item;
  if back > 0 then
    insert into public.credit_ledger (owner_id, delta, reason, label, job_id, item_id, item_charge, period_start)
    values (it.owner_id, back, 'job_refund', 'Refund · ' || left(it.filename, 140), it.job_id, it.id, it.charge_seq, b.period_start)
    on conflict do nothing;
  end if;
  return back;
end;
$$;

-- Phase 6 job creation and retry, now charging through _credits_charge (month first, then top-ups).
create or replace function public.ai_bg_job_create(p_owner uuid, p_photo_ids uuid[], p_apply jsonb, p_title text, p_force boolean)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.ai_settings := public._ai_settings();
  r record;
  b public.credit_balances;
  ids uuid[];
  skipped jsonb := '[]'::jsonb;
  ok_ids uuid[] := '{}';
  pid uuid;
  ph public.photos;
  needed integer;
  avail integer;
  j public.ai_jobs;
  title text := nullif(btrim(regexp_replace(coalesce(p_title, ''), '[[:cntrl:]]', '', 'g')), '');
begin
  if not exists (select 1 from public.profiles where id = p_owner) then return null; end if;
  if not public._ai_feature(s, 'bg_removal') then return jsonb_build_object('error', 'feature_off'); end if;
  if p_apply is null or jsonb_typeof(p_apply) <> 'object' or octet_length(p_apply::text) > 512
     or p_apply ->> 'bg' not in ('transparent', 'white', 'color', 'original') then
    return jsonb_build_object('error', 'invalid');
  end if;
  select * into r from public._ai_rules(public._ai_plan(p_owner));
  select array_agg(x.id order by x.n) into ids
    from (select distinct on (u.id) u.id, u.n from unnest(p_photo_ids) with ordinality u(id, n) order by u.id, u.n) x;
  if ids is null or cardinality(ids) = 0 then return jsonb_build_object('error', 'no_photos', 'skipped', skipped); end if;
  if cardinality(ids) > coalesce(r.batch_size, 25) then return jsonb_build_object('error', 'batch'); end if;

  perform public._credits_lock(p_owner);
  if not public._ai_job_request(p_owner, s.member_jobs_per_minute) then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  foreach pid in array ids loop
    select * into ph from public.photos where id = pid and owner_id = p_owner and status = 'ready';
    if not found or ph.safety_hold_at is not null then
      skipped := skipped || jsonb_build_array(jsonb_build_object('photoId', pid, 'reason', 'not_found'));
    elsif not ph.has_preview then
      skipped := skipped || jsonb_build_array(jsonb_build_object('photoId', pid, 'reason', 'no_preview'));
    elsif exists (select 1 from public.ai_job_items i join public.ai_jobs jj on jj.id = i.job_id
                   where i.photo_id = pid and i.status in ('pending', 'processing') and jj.kind = 'bg_removal')
       or (not coalesce(p_force, false)
           and exists (select 1 from public.photo_edits e where e.photo_id = pid and e.recipe ? 'cutout')) then
      skipped := skipped || jsonb_build_array(jsonb_build_object('photoId', pid, 'reason', 'already_cut_out'));
    else
      ok_ids := ok_ids || pid;
    end if;
  end loop;
  if cardinality(ok_ids) = 0 then return jsonb_build_object('error', 'no_photos', 'skipped', skipped); end if;

  b := public._credits_roll(p_owner);
  needed := cardinality(ok_ids) * s.bg_credits_per_photo;
  avail := public._credits_available(p_owner);
  if avail < needed then
    return jsonb_build_object('error', 'insufficient_credits', 'needed', needed, 'balance', avail);
  end if;
  insert into public.ai_jobs (owner_id, kind, title, apply, credits_charged)
  values (p_owner, 'bg_removal',
          left(coalesce(title, 'Background removal · ' || cardinality(ok_ids) || case when cardinality(ok_ids) = 1 then ' photo' else ' photos' end), 80),
          p_apply, needed)
  returning * into j;
  insert into public.ai_job_items (job_id, owner_id, photo_id, seq, filename, credits, charge_seq)
  select j.id, p_owner, u.id, (u.n - 1)::integer, p.filename, s.bg_credits_per_photo, 1
    from unnest(ok_ids) with ordinality u(id, n) join public.photos p on p.id = u.id;
  perform public._credits_charge(p_owner, j.id, needed,
    left(j.title, 120) || case when j.title like '%photo%' then '' else ' · ' || cardinality(ok_ids) || ' photos' end, b.period_start);
  select * into j from public.ai_jobs where id = j.id;
  return jsonb_build_object('job', public._ai_job_json(j),
                            'items', (select jsonb_agg(i.id order by i.seq) from public.ai_job_items i where i.job_id = j.id),
                            'skipped', skipped);
end;
$$;

create or replace function public.ai_job_retry(p_owner uuid, p_job uuid, p_items uuid[], p_session text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.ai_settings := public._ai_settings();
  j public.ai_jobs;
  b public.credit_balances;
  ids uuid[];
  needed integer;
  avail integer;
begin
  perform public._credits_lock(p_owner);
  select * into j from public.ai_jobs where id = p_job and owner_id = p_owner for update;
  if not found then return null; end if;
  if j.kind <> 'bg_removal' then return jsonb_build_object('error', 'nothing'); end if;
  if not public._ai_feature(s, 'bg_removal') then return jsonb_build_object('error', 'feature_off'); end if;
  select array_agg(i.id order by i.seq) into ids
    from public.ai_job_items i join public.photos p on p.id = i.photo_id
   where i.job_id = p_job and i.status = 'failed' and coalesce(i.error, '') not in ('photo_deleted', 'device_failed')
     and p.status = 'ready' and p.has_preview and p.safety_hold_at is null
     and (p_items is null or i.id = any (p_items));
  if ids is null then return jsonb_build_object('error', 'nothing'); end if;
  if not public._ai_job_request(p_owner, s.member_jobs_per_minute) then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  b := public._credits_roll(p_owner);
  needed := cardinality(ids) * s.bg_credits_per_photo;
  avail := public._credits_available(p_owner);
  if avail < needed then
    return jsonb_build_object('error', 'insufficient_credits', 'needed', needed, 'balance', avail);
  end if;
  update public.ai_job_items
     set status = 'pending', error = null, attempts = 0, credits = s.bg_credits_per_photo, charge_seq = charge_seq + 1,
         finished_at = null, started_at = null, wait_until = null, enqueued_at = null, provider = null
   where id = any (ids);
  perform public._credits_charge(p_owner, p_job, needed, 'Retry · ' || left(j.title, 100) || ' · ' || cardinality(ids)
          || case when cardinality(ids) = 1 then ' photo' else ' photos' end, b.period_start);
  update public.ai_jobs set credits_charged = credits_charged + needed, state = 'active', finished_at = null, updated_at = now()
   where id = p_job returning * into j;
  return jsonb_build_object('job', public._ai_job_json(j, p_session), 'items', to_jsonb(ids));
end;
$$;

-- Old billing rows (called from the existing 15-minute ai_prune).
create function public._billing_prune() returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  ev integer;
  cs integer;
  tp integer := 0;
  o uuid;
begin
  delete from public.billing_events where received_at < now() - interval '90 days';
  get diagnostics ev = row_count;
  delete from public.checkout_sessions where created_at < now() - interval '90 days';
  get diagnostics cs = row_count;
  -- Expired top-ups of members who haven't touched their credits (bounded per run).
  for o in select distinct t.owner_id from public.credit_topups t
            where t.remaining > 0 and t.expires_at <= now() and t.refunded_at is null limit 200 loop
    perform public._credits_lock(o);
    tp := tp + public._topups_expire(o);
  end loop;
  return jsonb_build_object('events', ev, 'sessions', cs, 'expiredCredits', tp);
end;
$$;

create or replace function public.ai_prune() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  calls integer;
  jobs integer;
  billing jsonb;
begin
  delete from public.ai_calls where at < now() - interval '7 days';
  get diagnostics calls = row_count;
  delete from public.ai_job_requests where at < now() - interval '1 day';
  delete from public.ai_jobs where finished_at < now() - interval '90 days';
  get diagnostics jobs = row_count;
  delete from public.ai_spend_daily where day < public._ai_today() - 400;
  delete from public.ai_user_spend_daily where day < public._ai_today() - 400;
  delete from public.ai_spend_alerts where day < public._ai_today() - 400;
  delete from public.ai_spend_capped where day < public._ai_today() - 400;
  billing := public._billing_prune();
  return jsonb_build_object('calls', calls, 'jobs', jobs, 'billing', billing);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Library state (also used by teams): read-only when over the plan's storage.
-- ---------------------------------------------------------------------------------------------
create function public._library_state(p_owner uuid) returns text
language sql stable set search_path = '' as $$
  select case when pr.storage_bytes > coalesce(r.storage_bytes, 0) then 'read_only' else 'active' end
    from public.profiles pr cross join lateral public._plan_rules(pr.plan_id) r
   where pr.id = p_owner;
$$;

-- ---------------------------------------------------------------------------------------------
-- Prices
-- ---------------------------------------------------------------------------------------------
create function public._price_json(p public.billing_prices) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('lookupKey', p.lookup_key, 'stripePriceId', p.stripe_price_id, 'plan', p.plan_id,
                            'interval', p.billing_interval, 'credits', p.credits, 'amount', p.amount, 'active', p.active);
$$;

-- Current price per lookup key: [{lookupKey, stripePriceId, plan, interval, credits, amount, active}].
create function public.billing_prices_current() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public._price_json(p) order by p.lookup_key), '[]'::jsonb)
    from public.billing_prices p where p.current;
$$;

-- ---------------------------------------------------------------------------------------------
-- Customers and Checkout
-- ---------------------------------------------------------------------------------------------
create function public.billing_customer_get(p_owner uuid) returns text
language sql stable security definer set search_path = '' as $$
  select c.stripe_customer_id from public.billing_customers c where c.owner_id = p_owner;
$$;

-- Insert-only. Returns the stored customer id (the existing one if already set), or null if that customer id
-- already belongs to someone else.
create function public.billing_customer_set(p_owner uuid, p_customer text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare cur text;
begin
  perform public._lock_billing(p_owner);
  select stripe_customer_id into cur from public.billing_customers where owner_id = p_owner;
  if found then return cur; end if;
  if exists (select 1 from public.billing_customers where stripe_customer_id = p_customer) then return null; end if;
  insert into public.billing_customers (owner_id, stripe_customer_id) values (p_owner, p_customer);
  return p_customer;
end;
$$;

-- The owner of a Stripe customer, or null.
create function public.billing_owner_by_customer(p_customer text) returns uuid
language sql stable security definer set search_path = '' as $$
  select c.owner_id from public.billing_customers c where c.stripe_customer_id = p_customer;
$$;

create function public.billing_checkout_record(p_owner uuid, p_session text, p_kind text, p_lookup_key text,
  p_idem text default null) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.checkout_sessions (id, owner_id, kind, lookup_key, idem_key)
  values (p_session, p_owner, p_kind, p_lookup_key, left(p_idem, 200))
  on conflict (id) do nothing;
$$;

-- The owner's other open Checkout sessions of a kind (pending, younger than a day), so the API can expire them
-- before opening a new one: two paid subscription Checkouts would mean two subscriptions. Sessions created with
-- p_idem are left alone (an idempotent retry returns that same session). [session id, …]
create function public.billing_checkout_open(p_owner uuid, p_kind text, p_idem text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(c.id order by c.created_at), '[]'::jsonb)
    from public.checkout_sessions c
   where c.owner_id = p_owner and c.kind = p_kind and c.state = 'pending' and c.created_at > now() - interval '1 day'
     and c.idem_key is distinct from p_idem;
$$;

-- The return page's own look at Stripe: true at most once per 10 seconds per session (and only its owner's).
create function public.billing_checkout_poll(p_owner uuid, p_session text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.checkout_sessions set fetched_at = now()
   where id = p_session and owner_id = p_owner and state = 'pending'
     and (fetched_at is null or fetched_at <= now() - interval '10 seconds');
  return found;
end;
$$;

-- {state, kind, lookupKey, createdAt, plan, credits} for the session's owner only, or null.
create function public.billing_checkout_status(p_owner uuid, p_session text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('state', c.state, 'kind', c.kind, 'lookupKey', c.lookup_key, 'createdAt', c.created_at,
                            'plan', (select p.plan_id from public.profiles p where p.id = c.owner_id),
                            'credits', (select bp.credits from public.billing_prices bp where bp.lookup_key = c.lookup_key limit 1))
    from public.checkout_sessions c where c.id = p_session and c.owner_id = p_owner;
$$;

-- Marks a session done, failed or refunded. A refunded session stays refunded; a done one only becomes refunded
-- (the duplicate was found after it was marked done). {ownerId, kind, lookupKey, state} or null.
create function public.billing_checkout_mark(p_session text, p_state text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.checkout_sessions;
begin
  if p_state not in ('done', 'failed', 'refunded') then raise exception 'bad state' using errcode = 'invalid_parameter_value'; end if;
  update public.checkout_sessions set state = p_state, finished_at = now()
   where id = p_session and state <> 'refunded' and (state <> 'done' or p_state = 'refunded') returning * into c;
  if not found then select * into c from public.checkout_sessions where id = p_session; end if;
  if not found then return null; end if;
  return jsonb_build_object('ownerId', c.owner_id, 'kind', c.kind, 'lookupKey', c.lookup_key, 'state', c.state);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------------------------
-- Upserts the subscription read from Stripe and works out the member's plan. p_sub (normalised by the API, keys
-- named after the subscriptions columns):
--   {stripe_subscription_id, stripe_customer_id, status, stripe_price_id, lookup_key, item_id, current_period_start,
--    current_period_end, cancel_at_period_end, schedule_id, scheduled_price_id | (scheduled_plan, scheduled_interval),
--    scheduled_at, payment_attempts, amount (cents; only needed for a price we haven't seen)}
-- p_synced_at: when the API read it. An older read never overwrites a newer one. An ended subscription never
-- replaces a different, plan-keeping one.
-- Returns {applied, stale?, ignored?, planBefore, planAfter, subscriptionId, email}.
create function public.billing_apply(p_owner uuid, p_sub jsonb, p_synced_at timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  cur public.subscriptions;
  pr public.profiles;
  price public.billing_prices;
  sched public.billing_prices;
  st text := p_sub ->> 'status';
  plan_before text;
  plan_after text;
  b0 public.credit_balances;
  b1 public.credit_balances;
  m0 integer;
  m1 integer;
  since timestamptz;
begin
  if p_sub is null or jsonb_typeof(p_sub) <> 'object' or p_synced_at is null then
    raise exception 'bad subscription' using errcode = 'invalid_parameter_value';
  end if;
  perform public._lock_billing(p_owner);
  select * into pr from public.profiles where id = p_owner for update;
  if not found then return null; end if;
  if (select c.stripe_customer_id from public.billing_customers c where c.owner_id = p_owner) is distinct from p_sub ->> 'stripe_customer_id' then
    return jsonb_build_object('applied', false, 'ignored', 'customer_mismatch');
  end if;
  select * into cur from public.subscriptions where owner_id = p_owner;
  -- When this subscription went past due (kept across reads of the same past_due subscription).
  since := case when st = 'past_due' then
             case when cur.owner_id is not null and cur.status = 'past_due' and cur.stripe_subscription_id = p_sub ->> 'stripe_subscription_id'
                  then coalesce(cur.past_due_since, now()) else now() end end;
  if cur.owner_id is not null then
    if cur.stripe_subscription_id = p_sub ->> 'stripe_subscription_id' and p_synced_at < cur.synced_at then
      return jsonb_build_object('applied', false, 'stale', true, 'planBefore', pr.plan_id, 'planAfter', pr.plan_id);
    end if;
    if cur.stripe_subscription_id <> p_sub ->> 'stripe_subscription_id' and public._sub_keeps(cur.status, cur.past_due_since) then
      -- A different subscription while the stored one still keeps the plan: an ended one is ignored; a second
      -- live one (two Checkouts paid) never replaces the first. The API cancels and refunds the newer one.
      if public._sub_keeps(st, since) then
        return jsonb_build_object('applied', false, 'duplicate', true, 'planBefore', pr.plan_id, 'planAfter', pr.plan_id,
                                  'storedSubscriptionId', cur.stripe_subscription_id);
      end if;
      return jsonb_build_object('applied', false, 'ignored', 'older_subscription', 'planBefore', pr.plan_id, 'planAfter', pr.plan_id);
    end if;
  end if;

  -- The price: ours, or one made in the Stripe dashboard (recorded, not current).
  select * into price from public.billing_prices where stripe_price_id = p_sub ->> 'stripe_price_id';
  if not found then
    insert into public.billing_prices (stripe_price_id, lookup_key, plan_id, billing_interval, amount, current)
    select p_sub ->> 'stripe_price_id', k.lookup_key, k.plan_id, k.billing_interval,
           coalesce((p_sub ->> 'amount')::integer,
                    (select c.amount from public.billing_prices c where c.lookup_key = k.lookup_key and c.current)), false
      from (select distinct on (lookup_key) lookup_key, plan_id, billing_interval from public.billing_prices
             where lookup_key = p_sub ->> 'lookup_key' and plan_id is not null) k
    returning * into price;
    if not found then raise exception 'unknown price' using errcode = 'invalid_parameter_value'; end if;
  end if;
  if price.plan_id is null then raise exception 'not a plan price' using errcode = 'invalid_parameter_value'; end if;
  if p_sub ->> 'scheduled_price_id' is not null then
    select * into sched from public.billing_prices where stripe_price_id = p_sub ->> 'scheduled_price_id';
  end if;

  perform public._credits_lock(p_owner);
  b0 := public._credits_roll(p_owner);
  plan_before := pr.plan_id;
  m0 := public._plan_monthly_credits(plan_before);

  insert into public.subscriptions as s (owner_id, stripe_subscription_id, stripe_customer_id, status, plan_id, billing_interval,
    stripe_price_id, item_id, current_period_start, current_period_end, cancel_at_period_end, schedule_id, scheduled_price_id,
    scheduled_plan, scheduled_interval, scheduled_at, past_due_since, payment_attempts, synced_at, updated_at)
  values (p_owner, p_sub ->> 'stripe_subscription_id', p_sub ->> 'stripe_customer_id', st, price.plan_id, price.billing_interval, price.stripe_price_id,
    p_sub ->> 'item_id', (p_sub ->> 'current_period_start')::timestamptz, (p_sub ->> 'current_period_end')::timestamptz,
    coalesce((p_sub ->> 'cancel_at_period_end')::boolean, false), p_sub ->> 'schedule_id', sched.stripe_price_id,
    coalesce(sched.plan_id, p_sub ->> 'scheduled_plan'), coalesce(sched.billing_interval, p_sub ->> 'scheduled_interval'),
    case when coalesce(sched.plan_id, p_sub ->> 'scheduled_plan') is not null then (p_sub ->> 'scheduled_at')::timestamptz end,
    since, coalesce((p_sub ->> 'payment_attempts')::integer, 0), p_synced_at, now())
  on conflict (owner_id) do update set
    stripe_subscription_id = excluded.stripe_subscription_id, stripe_customer_id = excluded.stripe_customer_id,
    status = excluded.status, plan_id = excluded.plan_id, billing_interval = excluded.billing_interval,
    stripe_price_id = excluded.stripe_price_id, item_id = excluded.item_id,
    current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end, schedule_id = excluded.schedule_id,
    scheduled_price_id = excluded.scheduled_price_id, scheduled_plan = excluded.scheduled_plan,
    scheduled_interval = excluded.scheduled_interval, scheduled_at = excluded.scheduled_at,
    past_due_since = excluded.past_due_since,
    payment_attempts = excluded.payment_attempts, synced_at = excluded.synced_at, updated_at = now();

  plan_after := case when public._sub_keeps(st, since) then price.plan_id else 'free' end;
  if pr.plan_source = 'stripe' and pr.plan_id <> plan_after then
    update public.profiles set plan_id = plan_after where id = p_owner;
  else
    plan_after := pr.plan_id;
  end if;

  if plan_after <> plan_before then
    b1 := public._credits_roll(p_owner);
    m1 := public._plan_monthly_credits(plan_after);
    -- Same period, more monthly credits: add the difference now (once per period and target plan).
    if b1.period_start = b0.period_start and m1 > m0 then
      insert into public.credit_ledger (owner_id, delta, reason, label, period_start)
      values (p_owner, m1 - m0, 'plan_change', 'Upgrade to ' || initcap(plan_after), b1.period_start)
      on conflict do nothing;
      if found then
        update public.credit_balances set balance = balance + (m1 - m0), updated_at = now() where owner_id = p_owner;
      end if;
    end if;
    perform public._audit(null, 'billing.plan_changed', p_owner::text,
      jsonb_build_object('from', plan_before, 'to', plan_after, 'status', st));
  end if;
  return jsonb_build_object('applied', true, 'planBefore', plan_before, 'planAfter', plan_after,
                            'subscriptionId', p_sub ->> 'stripe_subscription_id',
                            'email', (select u.email from auth.users u where u.id = p_owner));
end;
$$;

-- The stored subscription, for changing or cancelling it (also on account deletion), or null:
-- {stripeSubscriptionId, stripeCustomerId, itemId, status, stripePriceId, lookupKey, plan, interval, amount, scheduleId,
--  scheduledPlan, scheduledInterval, scheduledAt, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, keepsPlan, syncedAt}.
create function public.billing_subscription(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('stripeSubscriptionId', s.stripe_subscription_id, 'stripeCustomerId', s.stripe_customer_id, 'itemId', s.item_id,
                            'status', s.status, 'stripePriceId', s.stripe_price_id, 'plan', s.plan_id, 'interval', s.billing_interval,
                            'lookupKey', (select p.lookup_key from public.billing_prices p where p.stripe_price_id = s.stripe_price_id),
                            'amount', (select p.amount from public.billing_prices p where p.stripe_price_id = s.stripe_price_id),
                            'scheduledPlan', s.scheduled_plan, 'scheduledInterval', s.scheduled_interval, 'scheduledAt', s.scheduled_at,
                            'syncedAt', s.synced_at,
                            'scheduleId', s.schedule_id, 'currentPeriodStart', s.current_period_start,
                            'currentPeriodEnd', s.current_period_end, 'cancelAtPeriodEnd', s.cancel_at_period_end,
                            'keepsPlan', public._sub_keeps(s.status, s.past_due_since))
    from public.subscriptions s where s.owner_id = p_owner;
$$;

-- BillingStatus (without ok) for the member's own account, or null.
create function public.billing_status(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'plan', pr.plan_id,
    'subscription', (
      select jsonb_build_object(
        'plan', s.plan_id, 'interval', s.billing_interval, 'status', s.status,
        'price', jsonb_build_object('lookupKey', bp.lookup_key, 'amount', bp.amount, 'interval', bp.billing_interval),
        'currentPeriodStart', s.current_period_start, 'currentPeriodEnd', s.current_period_end,
        'cancelAtPeriodEnd', s.cancel_at_period_end,
        'scheduledChange', case when s.scheduled_plan is not null
                                then jsonb_build_object('plan', s.scheduled_plan, 'interval', s.scheduled_interval, 'at', s.scheduled_at) end,
        'priceChange', (select jsonb_build_object('amount', tp.amount, 'at', m.move_at)
                          from public.price_moves m join public.billing_prices tp on tp.stripe_price_id = m.to_price_id
                         where m.owner_id = s.owner_id and m.stripe_subscription_id = s.stripe_subscription_id
                           and m.from_price_id = s.stripe_price_id and m.status = 'notified'
                         order by m.created_at desc limit 1),
        'paymentDueSince', s.past_due_since)
        from public.subscriptions s join public.billing_prices bp on bp.stripe_price_id = s.stripe_price_id
       where s.owner_id = pr.id and s.status not in ('canceled', 'incomplete_expired')),
    'state', public._library_state(pr.id),
    'storage', jsonb_build_object('usedBytes', pr.storage_bytes, 'limitBytes', r.storage_bytes),
    'packs', coalesce((select jsonb_agg(jsonb_build_object('lookupKey', p.lookup_key, 'credits', p.credits, 'amount', p.amount)
                                        order by p.credits)
                         from public.billing_prices p where p.current and p.credits is not null and p.active), '[]'::jsonb),
    'hasCustomer', exists (select 1 from public.billing_customers c where c.owner_id = pr.id))
  from public.profiles pr cross join lateral public._plan_rules(pr.plan_id) r
  where pr.id = p_owner and pr.deleted_at is null;
$$;

-- ---------------------------------------------------------------------------------------------
-- Top-ups
-- ---------------------------------------------------------------------------------------------
-- Grants a paid top-up once per Checkout session. The pack comes from our record of the session (and must match
-- the event's lookup key); credits come from our price table, never from the event.
-- {granted: true|false, credits, expiresAt} | {error: 'unknown_session' | 'mismatch'}.
create function public.billing_topup_grant(p_owner uuid, p_session text, p_payment_intent text, p_lookup_key text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  cs public.checkout_sessions;
  n integer;
  t public.credit_topups;
  b public.credit_balances;
begin
  select * into cs from public.checkout_sessions where id = p_session and owner_id = p_owner and kind = 'topup';
  if not found then return jsonb_build_object('error', 'unknown_session'); end if;
  if cs.lookup_key is distinct from p_lookup_key then return jsonb_build_object('error', 'mismatch'); end if;
  select bp.credits into n from public.billing_prices bp where bp.lookup_key = cs.lookup_key and bp.credits is not null limit 1;
  if n is null then return jsonb_build_object('error', 'mismatch'); end if;
  perform public._lock_billing(p_owner);
  perform public._credits_lock(p_owner);
  select * into t from public.credit_topups where checkout_session_id = p_session;
  if found then
    update public.checkout_sessions set state = 'done', finished_at = coalesce(finished_at, now()) where id = p_session;
    return jsonb_build_object('granted', false, 'credits', t.credits, 'expiresAt', t.expires_at);
  end if;
  b := public._credits_roll(p_owner);
  insert into public.credit_topups (owner_id, lookup_key, credits, remaining, expires_at, checkout_session_id, payment_intent_id)
  values (p_owner, cs.lookup_key, n, n, now() + interval '12 months', p_session, p_payment_intent)
  returning * into t;
  insert into public.credit_ledger (owner_id, delta, reason, label, period_start)
  values (p_owner, n, 'top_up', 'Top-up · ' || to_char(n, 'FM999,999') || ' credits', b.period_start);
  update public.checkout_sessions set state = 'done', finished_at = now() where id = p_session;
  return jsonb_build_object('granted', true, 'credits', n, 'expiresAt', t.expires_at);
end;
$$;

-- A refunded or disputed top-up. p_refunded / p_amount: the charge's refunded total so far and its amount (cents;
-- a dispute passes its amount twice, a full refund). Credits removed = credits × refunded ÷ amount, rounded up,
-- less what earlier refunds already removed, and never more than are left: credits already spent are never
-- clawed back. Without amounts the refund counts as full. {ownerId, removed} or null.
create function public.billing_topup_refund(p_payment_intent text, p_refunded integer default null,
  p_amount integer default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare t public.credit_topups;
begin
  select * into t from public.credit_topups where payment_intent_id = p_payment_intent;
  if not found then return null; end if;
  return public._topup_refund(t.id, p_refunded, p_amount);
end;
$$;

-- The same, found by its Checkout session (when the refund or dispute carries no payment intent we recorded).
create function public.billing_topup_refund_by_session(p_session text, p_refunded integer default null,
  p_amount integer default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare t public.credit_topups;
begin
  select * into t from public.credit_topups where checkout_session_id = p_session;
  if not found then return null; end if;
  return public._topup_refund(t.id, p_refunded, p_amount);
end;
$$;

create function public._topup_refund(p_id uuid, p_refunded integer, p_amount integer) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  t public.credit_topups;
  b public.credit_balances;
  full_refund boolean := p_amount is null or p_amount <= 0 or p_refunded is null or p_refunded >= p_amount;
  target integer;
  n integer;
begin
  select * into t from public.credit_topups where id = p_id;
  if not found then return null; end if;
  perform public._credits_lock(t.owner_id);
  select * into t from public.credit_topups where id = t.id for update;
  if t.refunded_at is not null then return jsonb_build_object('ownerId', t.owner_id, 'removed', 0); end if;
  -- Refunded totals are cumulative, so a repeated or out-of-order event never removes credits twice.
  target := case when full_refund then t.credits
                 else least(t.credits, ceil(t.credits::numeric * greatest(p_refunded, 0) / p_amount)::integer) end;
  n := least(t.remaining, greatest(target - t.refund_removed, 0));
  b := public._credits_roll(t.owner_id);
  if n > 0 then
    insert into public.credit_ledger (owner_id, delta, reason, label, period_start)
    values (t.owner_id, -n, 'top_up_refund', case when full_refund then 'Top-up refunded' else 'Top-up partly refunded' end,
            b.period_start);
  end if;
  update public.credit_topups
     set remaining = remaining - n, refund_removed = refund_removed + n,
         refunded_at = case when full_refund then now() else null end
   where id = t.id;
  return jsonb_build_object('ownerId', t.owner_id, 'removed', n);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Webhook events
-- ---------------------------------------------------------------------------------------------
-- 'new' (first time), 'retry' (seen before but not finished, or failed) or 'done' (processed or ignored).
create function public.billing_event_begin(p_id text, p_type text, p_created timestamptz) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare st text;
begin
  insert into public.billing_events (id, type, stripe_created) values (p_id, left(p_type, 100), p_created)
  on conflict (id) do nothing;
  if found then return 'new'; end if;
  select status into st from public.billing_events where id = p_id;
  return case when st in ('processed', 'ignored') then 'done' else 'retry' end;
end;
$$;

create function public.billing_event_finish(p_id text, p_status text, p_error text, p_owner uuid) returns void
language sql volatile security definer set search_path = '' as $$
  update public.billing_events
     set status = p_status,
         error = case when p_error ~ '^[a-z0-9_]{1,60}$' then p_error when p_error is null then null else 'error' end,
         owner_id = coalesce(p_owner, owner_id)
   where id = p_id;
$$;

-- ---------------------------------------------------------------------------------------------
-- Price changes for existing subscribers
-- ---------------------------------------------------------------------------------------------
-- The first renewal (period end) of the subscription at or after p_at.
create function public._renewal_on_or_after(s public.subscriptions, p_at timestamptz) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  step interval := case when s.billing_interval = 'year' then interval '1 year' else interval '1 month' end;
  t timestamptz := s.current_period_end;
  k integer := 0;
begin
  while t < p_at and k < 1000 loop
    k := k + 1;
    t := s.current_period_end + step * k;
  end loop;
  return t;
end;
$$;

create function public._move_at(s public.subscriptions, p_from integer, p_to integer, p_notice timestamptz) returns timestamptz
language sql stable set search_path = '' as $$
  select case when p_to > p_from then public._renewal_on_or_after(s, p_notice + interval '30 days')
              else public._renewal_on_or_after(s, now()) end;
$$;

create function public._staff_can(p_actor uuid, p_roles text[]) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.staff st where st.user_id = p_actor and st.role::text = any (p_roles));
$$;

-- Sets the current price of a lookup key (a Stripe Price the API just created, transfer_lookup_key). Owner and
-- finance only; p_seed (setup script, p_staff may be null) replaces a placeholder seed price without a price
-- change. Creates a price change when subscribers pay a different amount on this key.
-- {lookupKey, previousAmount, amount, raise, priceChangeId} | {error: 'forbidden' | 'invalid' | 'unchanged'}.
create function public.admin_price_set(p_staff uuid, p_lookup_key text, p_stripe_price_id text, p_amount integer,
  p_reason text, p_seed boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  old public.billing_prices;
  ch uuid;
  n integer;
  floor_amount integer;
  is_raise boolean;
  reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]', '', 'g')), '');
begin
  if not coalesce(p_seed, false) and not public._staff_can(p_staff, array['owner', 'finance']) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_stripe_price_id !~ '^price_[A-Za-z0-9_]{1,250}$' or p_amount is null or p_amount < 1 or p_amount > 10000000 then
    return jsonb_build_object('error', 'invalid');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('zephyr:prices:' || p_lookup_key, 0));
  select * into old from public.billing_prices where lookup_key = p_lookup_key and current for update;
  if not found then return jsonb_build_object('error', 'invalid'); end if;

  if coalesce(p_seed, false) then
    if old.stripe_price_id not like 'price_seed_%' and old.stripe_price_id <> p_stripe_price_id then
      return jsonb_build_object('error', 'invalid');
    end if;
    update public.billing_prices set stripe_price_id = p_stripe_price_id, amount = p_amount
     where stripe_price_id = old.stripe_price_id;
    perform public._audit(p_staff, 'billing.price_seeded', p_lookup_key, jsonb_build_object('amount', p_amount));
    return jsonb_build_object('lookupKey', p_lookup_key, 'previousAmount', old.amount, 'amount', p_amount,
                              'raise', false, 'priceChangeId', null);
  end if;

  if reason is null or length(reason) > 300 then return jsonb_build_object('error', 'invalid'); end if;
  if old.stripe_price_id = p_stripe_price_id or exists (select 1 from public.billing_prices where stripe_price_id = p_stripe_price_id) then
    return jsonb_build_object('error', 'unchanged');
  end if;
  -- A rise for anyone: above the current price, or above what any plan-keeping subscriber on this key pays
  -- (a subscriber left on an older, lower price by a stopped change).
  floor_amount := public._key_floor(p_lookup_key);
  is_raise := p_amount > least(old.amount, coalesce(floor_amount, old.amount));
  update public.billing_prices set current = false where stripe_price_id = old.stripe_price_id;
  insert into public.billing_prices (stripe_price_id, lookup_key, plan_id, billing_interval, credits, amount, active, current, created_by)
  values (p_stripe_price_id, p_lookup_key, old.plan_id, old.billing_interval, old.credits, p_amount, old.active, true, p_staff);

  if old.plan_id is not null then
    select count(*) into n from public.subscriptions s join public.billing_prices bp on bp.stripe_price_id = s.stripe_price_id
     where bp.lookup_key = p_lookup_key and bp.amount <> p_amount and public._sub_keeps(s.status, s.past_due_since);
    -- Moves of earlier changes on this key that haven't happened are superseded by this one. An earlier change
    -- with moves applied but not yet renewed stays 'moving', so Stop can still put those back.
    update public.price_moves m set status = 'skipped', skip_reason = 'superseded'
      from public.price_changes c
     where c.id = m.change_id and c.lookup_key = p_lookup_key and m.status in ('pending', 'notified');
    update public.price_changes c
       set status = case when exists (select 1 from public.price_moves m
                                       where m.change_id = c.id
                                         and (m.status = 'moving' or (m.status = 'moved' and m.move_at > now())))
                         then 'moving' else 'done' end
     where c.lookup_key = p_lookup_key and c.status in ('notifying', 'moving');
    if n > 0 then
      insert into public.price_changes (lookup_key, from_amount, to_amount, to_price_id, reason, created_by)
      values (p_lookup_key, old.amount, p_amount, p_stripe_price_id, reason, p_staff) returning id into ch;
    end if;
  end if;
  perform public._audit(p_staff, 'billing.price_set', p_lookup_key,
    jsonb_build_object('from', old.amount, 'to', p_amount, 'reason', reason, 'priceChangeId', ch, 'raise', is_raise));
  return jsonb_build_object('lookupKey', p_lookup_key, 'previousAmount', old.amount, 'amount', p_amount,
                            'raise', is_raise, 'priceChangeId', ch);
end;
$$;

-- The lowest amount any plan-keeping subscriber pays on a lookup key (any of its prices), or null.
create function public._key_floor(p_lookup_key text) returns integer
language sql stable set search_path = '' as $$
  select min(bp.amount) from public.subscriptions s join public.billing_prices bp on bp.stripe_price_id = s.stripe_price_id
   where bp.lookup_key = p_lookup_key and public._sub_keeps(s.status, s.past_due_since);
$$;

-- AdminPricePreviewResult (without ok), or null for an unknown key. raise: above the current price or above what
-- any plan-keeping subscriber on the key pays (needs a passkey and emails the Owners).
create function public.admin_price_preview(p_lookup_key text, p_amount integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'from', cur.amount, 'to', p_amount,
    'subscribers', count(s.owner_id) filter (where bp.amount <> p_amount),
    'firstMoveAt', min(public._move_at(s, bp.amount, p_amount, now())) filter (where bp.amount <> p_amount),
    'lastMoveAt', max(public._move_at(s, bp.amount, p_amount, now())) filter (where bp.amount <> p_amount),
    'raise', p_amount > least(cur.amount, coalesce(min(bp.amount) filter (where s.owner_id is not null), cur.amount)))
  from public.billing_prices cur
  left join public.billing_prices bp on bp.lookup_key = cur.lookup_key
  left join public.subscriptions s on s.stripe_price_id = bp.stripe_price_id and public._sub_keeps(s.status, s.past_due_since)
  where cur.lookup_key = p_lookup_key and cur.current
  group by cur.amount;
$$;

-- Turns a top-up pack on or off (owner and finance). {lookupKey, active} | {error}.
create function public.admin_pack_set(p_staff uuid, p_lookup_key text, p_active boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public._staff_can(p_staff, array['owner', 'finance']) then return jsonb_build_object('error', 'forbidden'); end if;
  update public.billing_prices set active = p_active where lookup_key = p_lookup_key and credits is not null;
  if not found then return jsonb_build_object('error', 'invalid'); end if;
  perform public._audit(p_staff, 'billing.pack_set', p_lookup_key, jsonb_build_object('active', p_active));
  return jsonb_build_object('lookupKey', p_lookup_key, 'active', p_active);
end;
$$;

-- Stops a price change: moves not yet notified or applied stop; moves applied in Stripe whose renewal hasn't come
-- are returned for the API to revert (then price_move_mark(id, 'reverted')).
-- {lookupKey, reverts: [{moveId, ownerId, stripeSubscriptionId, itemId, fromPriceId, toPriceId}]} | {error: 'forbidden' | 'not_found'}.
create function public.admin_price_change_stop(p_staff uuid, p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.price_changes;
begin
  if not public._staff_can(p_staff, array['owner', 'finance']) then return jsonb_build_object('error', 'forbidden'); end if;
  select * into c from public.price_changes where id = p_id for update;
  if not found or c.status in ('done', 'stopped') then return jsonb_build_object('error', 'not_found'); end if;
  update public.price_changes set status = 'stopped', stopped_at = now() where id = p_id;
  -- Moves the cron has claimed (moving) are left alone here: when the cron finishes one, price_move_mark sees the
  -- change stopped and sends it to revert_pending, so it's put back too.
  update public.price_moves set status = 'stopped' where change_id = p_id and status in ('pending', 'notified');
  -- Applied but not yet renewed: to be put back. They wait in revert_pending until a revert succeeds (the API
  -- tries now; the daily cron retries), or the renewal comes first (revert_failed).
  update public.price_moves set status = 'revert_pending'
   where change_id = p_id and status = 'moved' and move_at > now();
  perform public._audit(p_staff, 'billing.price_change_stopped', c.lookup_key, jsonb_build_object('priceChangeId', p_id));
  return jsonb_build_object('lookupKey', c.lookup_key, 'reverts', coalesce((
    select jsonb_agg(jsonb_build_object('moveId', m.id, 'ownerId', m.owner_id, 'stripeSubscriptionId', m.stripe_subscription_id,
                                        'itemId', s.item_id, 'fromPriceId', m.from_price_id, 'toPriceId', m.to_price_id))
      from public.price_moves m left join public.subscriptions s on s.stripe_subscription_id = m.stripe_subscription_id
     where m.change_id = p_id and m.status = 'revert_pending'), '[]'::jsonb));
end;
$$;

-- Reverts still owed (Stop's Stripe call failed): those whose renewal has come are marked revert_failed (the
-- subscriber renewed at the new price; an alert for the team), the rest are returned for the cron to try again.
-- {failed: <count newly failed>, reverts: [{moveId, ownerId, stripeSubscriptionId, fromPriceId, toPriceId}]}
create function public.price_move_reverts_due(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare n integer;
begin
  update public.price_moves set status = 'revert_failed' where status = 'revert_pending' and move_at <= now();
  get diagnostics n = row_count;
  return jsonb_build_object('failed', n, 'reverts', coalesce((
    select jsonb_agg(jsonb_build_object('moveId', m.id, 'ownerId', m.owner_id, 'stripeSubscriptionId', m.stripe_subscription_id,
                                        'fromPriceId', m.from_price_id, 'toPriceId', m.to_price_id) order by m.move_at)
      from (select * from public.price_moves where status = 'revert_pending' order by move_at
             limit least(greatest(coalesce(p_limit, 100), 1), 500)) m), '[]'::jsonb));
end;
$$;

-- The cron claims a notified move (under its row lock) before the Stripe swap, so Stop can't race it. A claim
-- older than an hour (a worker that died mid-swap) can be taken again: the swap is idempotent. The move, or null.
create function public.price_move_claim(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare m public.price_moves;
begin
  update public.price_moves set status = 'moving', claimed_at = now()
   where id = p_id
     and (status = 'notified' or (status = 'moving' and claimed_at < now() - interval '1 hour'))
     and exists (select 1 from public.price_changes c where c.id = change_id and c.status <> 'stopped')
  returning * into m;
  if not found then return null; end if;
  return public._move_json(m);
end;
$$;

create function public._move_json(m public.price_moves) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', m.id, 'changeId', m.change_id, 'ownerId', m.owner_id,
    'email', (select u.email from auth.users u where u.id = m.owner_id),
    'stripeSubscriptionId', m.stripe_subscription_id, 'itemId', s.item_id, 'status', m.status,
    'fromPriceId', m.from_price_id, 'toPriceId', m.to_price_id,
    'fromAmount', fp.amount, 'toAmount', tp.amount, 'plan', tp.plan_id, 'interval', tp.billing_interval,
    'moveAt', m.move_at, 'noticeAt', m.notice_at)
  from public.billing_prices fp, public.billing_prices tp
  left join public.subscriptions s on s.stripe_subscription_id = m.stripe_subscription_id
  where fp.stripe_price_id = m.from_price_id and tp.stripe_price_id = m.to_price_id;
$$;

-- The daily sweep. Creates moves for plan-keeping subscriptions paying a different amount from their key's
-- current price (none while a schedule is pending, none after a stopped move to that price), skips moves whose
-- subscription changed, pushes missed moves to the next renewal, and returns the work as one array of
-- Move = {id, changeId, ownerId, email, stripeSubscriptionId, itemId, status, fromPriceId, toPriceId, fromAmount,
-- toAmount, plan, interval, moveAt, noticeAt}:
--   status 'pending'  → send the notice email, then price_move_mark(id, 'notified');
--   status 'notified' → due within 48 h of moveAt: swap the price in Stripe (proration none), then
--                        price_move_mark(id, 'moved') (or 'skipped' if Stripe refused because the subscription changed).
-- Notices come first.
create function public.price_moves_due(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  r record;
  ch uuid;
begin
  -- A notice that never went out by the move date (no address, or sending kept failing): never moved. A rise
  -- is never applied without a notice.
  update public.price_moves set status = 'skipped', skip_reason = 'no_email'
   where status = 'pending' and move_at <= now();
  -- Subscription changed plan, price, status or id since the move was planned.
  update public.price_moves m set status = 'skipped', skip_reason = 'changed'
   where m.status in ('pending', 'notified')
     and not exists (select 1 from public.subscriptions s
                      where s.owner_id = m.owner_id and s.stripe_subscription_id = m.stripe_subscription_id
                        and s.stripe_price_id = m.from_price_id and public._sub_keeps(s.status, s.past_due_since));
  -- A missed move (the cron didn't run in the window): the notice still stands; move at the next renewal.
  update public.price_moves m set move_at = public._renewal_on_or_after(s, now())
    from public.subscriptions s
   where s.stripe_subscription_id = m.stripe_subscription_id and m.status = 'notified' and m.move_at <= now();

  for r in
    select s as sub, s.owner_id, s.stripe_subscription_id, s.stripe_price_id, bp.amount as cur_amount, bp.lookup_key as key,
           nowp.amount as new_amount, nowp.stripe_price_id as new_price
      from public.subscriptions s
      join public.billing_prices bp on bp.stripe_price_id = s.stripe_price_id
      join public.billing_prices nowp on nowp.lookup_key = bp.lookup_key and nowp.current
     where public._sub_keeps(s.status, s.past_due_since) and bp.amount <> nowp.amount and s.schedule_id is null
       and not exists (select 1 from public.price_moves m where m.owner_id = s.owner_id
                         and (m.status in ('pending', 'notified', 'moving', 'revert_pending')
                              or (m.status = 'stopped' and m.to_price_id = nowp.stripe_price_id)
                              or (m.status = 'moved' and m.to_price_id = nowp.stripe_price_id and m.move_at > now())))
     order by s.current_period_end limit lim
  loop
    select c.id into ch from public.price_changes c
     where c.lookup_key = r.key and c.to_price_id = r.new_price and c.status in ('notifying', 'moving')
     order by c.created_at desc limit 1;
    if ch is null then
      -- A subscriber who landed on an old price later (e.g. a scheduled downgrade ran): a change of its own.
      insert into public.price_changes (lookup_key, from_amount, to_amount, to_price_id, reason, status)
      values (r.key, r.cur_amount, r.new_amount, r.new_price, 'Moved to the current price', 'notifying') returning id into ch;
    end if;
    insert into public.price_moves (change_id, owner_id, stripe_subscription_id, from_price_id, to_price_id, move_at)
    values (ch, r.owner_id, r.stripe_subscription_id, r.stripe_price_id, r.new_price,
            public._move_at(r.sub, r.cur_amount, r.new_amount, now()))
    on conflict (change_id, owner_id) do nothing;
  end loop;

  update public.price_changes c set status = case
      when exists (select 1 from public.price_moves m where m.change_id = c.id and m.status = 'pending') then 'notifying'
      when exists (select 1 from public.price_moves m where m.change_id = c.id
                     and (m.status in ('notified', 'moving') or (m.status = 'moved' and m.move_at > now()))) then 'moving'
      else 'done' end
   where c.status in ('notifying', 'moving');

  return coalesce((select jsonb_agg(public._move_json(m) order by m.status = 'notified', m.move_at)
                     from ((select * from public.price_moves where status = 'pending' order by move_at limit lim)
                           union all
                           (select * from public.price_moves
                             where (status = 'notified' or (status = 'moving' and claimed_at < now() - interval '1 hour'))
                               and move_at <= now() + interval '48 hours' and notice_at is not null
                             order by move_at limit lim)) m), '[]'::jsonb);
end;
$$;

-- Records the outcome of a notice, move or revert. A rise's move date is re-worked from the time the notice
-- actually went out (first renewal ≥ 30 days later). Returns the move, or null.
create function public.price_move_mark(p_id uuid, p_status text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  m public.price_moves;
  s public.subscriptions;
  fa integer;
  ta integer;
begin
  select * into m from public.price_moves where id = p_id for update;
  if not found then return null; end if;
  if p_status = 'notified' and m.status = 'pending' then
    select * into s from public.subscriptions where stripe_subscription_id = m.stripe_subscription_id;
    select amount into fa from public.billing_prices where stripe_price_id = m.from_price_id;
    select amount into ta from public.billing_prices where stripe_price_id = m.to_price_id;
    update public.price_moves set status = 'notified', notice_at = now(),
           move_at = case when s.owner_id is not null then public._move_at(s, fa, ta, now()) else move_at end
     where id = p_id returning * into m;
  elsif p_status = 'notified' and m.status = 'moving' then
    -- The swap didn't happen (a transient Stripe error): release the claim for the next run.
    update public.price_moves set status = 'notified', claimed_at = null where id = p_id returning * into m;
  elsif p_status = 'moved' and m.status in ('notified', 'moving') then
    -- Stopped while the cron was swapping: Stripe now has the new price, so it goes straight to revert_pending
    -- (the caller reverts it; the cron retries if that fails).
    update public.price_moves
       set status = case when exists (select 1 from public.price_changes c where c.id = m.change_id and c.status = 'stopped')
                         then 'revert_pending' else 'moved' end,
           moved_at = now()
     where id = p_id returning * into m;
  elsif p_status = 'skipped' and m.status in ('pending', 'notified', 'moving') then
    update public.price_moves set status = 'skipped', skip_reason = 'changed' where id = p_id returning * into m;
  elsif p_status = 'reverted' and m.status in ('moved', 'revert_pending') then
    update public.price_moves set status = 'stopped', reverted_at = now() where id = p_id returning * into m;
  elsif p_status = 'revert_failed' and m.status = 'revert_pending' then
    update public.price_moves set status = 'revert_failed' where id = p_id returning * into m;
  elsif p_status not in ('notified', 'moved', 'skipped', 'reverted', 'revert_failed') then
    raise exception 'bad status' using errcode = 'invalid_parameter_value';
  end if;
  return public._move_json(m);
end;
$$;

-- AdminBillingResult (without ok and configured) for owner, admin and finance staff; null for anyone else.
create function public.admin_billing_overview(p_actor uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public._staff_can(p_actor, array['owner', 'admin', 'finance']) then jsonb_build_object(
    'kpis', jsonb_build_object(
      'mrr', coalesce((select sum(case when bp.billing_interval = 'year' then round(bp.amount / 12.0) else bp.amount end)
                         from public.subscriptions s join public.billing_prices bp on bp.stripe_price_id = s.stripe_price_id
                        where s.status in ('active', 'trialing', 'past_due')), 0)::bigint,
      'paying', (select count(*) from public.subscriptions s where s.status in ('active', 'past_due')),
      'pastDue', (select count(*) from public.subscriptions s where s.status = 'past_due'),
      'cancelling', (select count(*) from public.subscriptions s where s.cancel_at_period_end and public._sub_keeps(s.status, s.past_due_since)),
      'topUpCreditsSold30d', (select coalesce(sum(t.credits), 0) from public.credit_topups t
                               where t.created_at > now() - interval '30 days' and t.refunded_at is null)),
    'prices', coalesce((select jsonb_agg(jsonb_build_object(
        'lookupKey', p.lookup_key, 'plan', p.plan_id, 'interval', p.billing_interval, 'credits', p.credits,
        'amount', p.amount, 'active', p.active,
        'subscribers', (select count(*) from public.subscriptions s where s.stripe_price_id = p.stripe_price_id and public._sub_keeps(s.status, s.past_due_since)),
        'updatedAt', p.created_at) order by p.plan_id nulls last, p.billing_interval, p.credits)
      from public.billing_prices p where p.current), '[]'::jsonb),
    'changes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'lookupKey', c.lookup_key, 'from', c.from_amount, 'to', c.to_amount, 'status', c.status,
        'createdAt', c.created_at,
        'createdBy', coalesce((select coalesce(pr.display_name, split_part(u.email, '@', 1)) from auth.users u
                                 left join public.profiles pr on pr.id = u.id where u.id = c.created_by), 'Zephyr'),
        'reason', c.reason,
        'counts', jsonb_build_object(
          'pending', (select count(*) from public.price_moves m where m.change_id = c.id and m.status = 'pending'),
          'notified', (select count(*) from public.price_moves m where m.change_id = c.id and m.status in ('notified', 'moving')),
          'moved', (select count(*) from public.price_moves m where m.change_id = c.id and m.status = 'moved'),
          'skipped', (select count(*) from public.price_moves m where m.change_id = c.id and m.status in ('skipped', 'stopped')),
          'reverting', (select count(*) from public.price_moves m where m.change_id = c.id and m.status = 'revert_pending'),
          'revertFailed', (select count(*) from public.price_moves m where m.change_id = c.id and m.status = 'revert_failed')),
        'lastMoveAt', (select max(m.move_at) from public.price_moves m where m.change_id = c.id
                         and m.status in ('pending', 'notified', 'moving', 'moved', 'revert_pending')))
        order by c.created_at desc)
      from (select * from public.price_changes order by created_at desc limit 20) c), '[]'::jsonb),
    'paymentDue', coalesce((select jsonb_agg(jsonb_build_object(
        'ownerId', s.owner_id, 'email', u.email, 'plan', s.plan_id, 'amount', bp.amount,
        'since', coalesce(s.past_due_since, s.updated_at), 'attempts', s.payment_attempts) order by s.past_due_since)
      from public.subscriptions s join auth.users u on u.id = s.owner_id
      join public.billing_prices bp on bp.stripe_price_id = s.stripe_price_id
      where s.status = 'past_due'), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'type', e.type, 'at', e.received_at,
        'status', case when e.status = 'received' then 'failed' else e.status end, 'error', e.error) order by e.received_at desc)
      from (select * from public.billing_events order by received_at desc limit 50) e), '[]'::jsonb)) end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Daily billing cron helpers
-- ---------------------------------------------------------------------------------------------
-- Past due beyond the grace period with no word from Stripe: the plan ends (Stripe's dunning should have
-- canceled by now). [{ownerId, email}] of plans ended, for the plan-ended email.
create function public.billing_past_due_expire(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
  out jsonb := '[]'::jsonb;
begin
  for r in select s.owner_id, s.plan_id from public.subscriptions s join public.profiles p on p.id = s.owner_id
            where s.status = 'past_due' and s.past_due_since <= now() - public._past_due_grace()
              and p.plan_source = 'stripe' and p.plan_id = s.plan_id
            order by s.past_due_since limit least(greatest(coalesce(p_limit, 100), 1), 500) loop
    perform public._lock_billing(r.owner_id);
    -- Read again under the lock: a card retry may have succeeded (billing_apply recorded active) since the select.
    if not exists (select 1 from public.subscriptions s
                    where s.owner_id = r.owner_id and s.status = 'past_due'
                      and s.past_due_since <= now() - public._past_due_grace()) then
      continue;
    end if;
    update public.profiles set plan_id = 'free'
     where id = r.owner_id and plan_source = 'stripe' and plan_id = r.plan_id;
    if found then
      perform public._audit(null, 'billing.plan_changed', r.owner_id::text,
        jsonb_build_object('from', r.plan_id, 'to', 'free', 'status', 'past_due', 'reason', 'past_due_grace'));
      out := out || jsonb_build_array(jsonb_build_object('ownerId', r.owner_id,
               'email', (select u.email from auth.users u where u.id = r.owner_id)));
    end if;
  end loop;
  return out;
end;
$$;

-- Accounts pending deletion whose plan-keeping subscription still renews (setting cancel_at_period_end failed
-- or hasn't been seen yet): the cron asks Stripe again. [{ownerId, stripeSubscriptionId}]
create function public.billing_deletion_cancels_due(p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('ownerId', x.owner_id, 'stripeSubscriptionId', x.stripe_subscription_id)), '[]'::jsonb)
    from (select s.owner_id, s.stripe_subscription_id from public.subscriptions s join public.profiles p on p.id = s.owner_id
           where p.deletion_due is not null and p.deleted_at is null and not s.cancel_at_period_end
             and public._sub_keeps_plan(s.status)
           order by p.deletion_due limit least(greatest(coalesce(p_limit, 100), 1), 500)) x;
$$;

-- ---------------------------------------------------------------------------------------------
-- Account deletion: the API cancels the subscription (at period end when scheduled, at once on purge).
-- Purge work now carries the Stripe subscription id.
-- ---------------------------------------------------------------------------------------------
create or replace function public.due_account_purges(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  picked uuid[];
  r record;
begin
  select array_agg(x.id order by x.deletion_due) into picked
    from (select p.id, p.deletion_due from public.profiles p
           where p.deletion_due <= now()
             and (p.purge_attempted_at is null or p.purge_attempted_at <= now() - interval '1 hour')
             and not exists (select 1 from public.staff s where s.user_id = p.id)
             and not exists (select 1 from public.photos h where h.owner_id = p.id and h.safety_hold_at is not null)
           order by p.deletion_due limit least(greatest(coalesce(p_limit, 10), 1), 100)
           for update skip locked) x;
  if picked is null then return '[]'::jsonb; end if;
  for r in update public.profiles set purge_attempts = purge_attempts + 1, purge_attempted_at = now()
            where id = any (picked) returning id, purge_attempts loop
    if r.purge_attempts = 5 then
      perform public._audit(null, 'jobs.account_purge_failing', r.id::text, jsonb_build_object('attempts', r.purge_attempts));
    end if;
  end loop;
  return (select coalesce(jsonb_agg(jsonb_build_object(
           'ownerId', p.id,
           'prefix', 'u/' || p.id::text || '/',
           'stagingPrefix', 'staging/' || p.id::text || '/',
           'sharedPrefix', 'o/' || p.id::text || '/',
           'stripeSubscriptionId', (select s.stripe_subscription_id from public.subscriptions s
                                     where s.owner_id = p.id and s.status not in ('canceled', 'incomplete_expired')),
           'uploads', coalesce((select jsonb_agg(jsonb_build_object('r2Key', u.r2_key, 'r2UploadId', u.r2_upload_id))
                                  from public.uploads u where u.owner_id = p.id and u.r2_upload_id is not null), '[]'::jsonb))
         order by p.deletion_due), '[]'::jsonb)
    from public.profiles p where p.id = any (picked));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Galleries: a lapse never removes a gallery's watermark (client proofs stay protected until the gallery ends).
-- Full-size downloads, favourites, branding and the access log still follow the owner's plan.
-- ---------------------------------------------------------------------------------------------
create or replace function public._gallery_effective(g public.galleries,
  out downloads text, out favourites boolean, out watermark boolean, out branding boolean, out access_log boolean)
language sql stable set search_path = '' as $$
  select case when g.downloads = 'full' and not r.guest_full_res then 'web' else g.downloads end,
         g.x_favourites and r.guest_favourites, g.x_watermark, g.x_branding and r.branding,
         g.x_access_log and r.access_log
    from public.profiles pr cross join lateral public._share_rules(pr.plan_id) r
   where pr.id = g.owner_id;
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: service_role only. Internal helpers (_*) are callable by no role but their owner.
-- ---------------------------------------------------------------------------------------------
revoke all on public.billing_customers, public.billing_prices, public.subscriptions, public.billing_events,
  public.checkout_sessions, public.credit_topups, public.price_changes, public.price_moves
from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on function
  public._lock_billing(uuid),
  public._sub_keeps_plan(text),
  public._past_due_grace(),
  public._sub_keeps(text, timestamptz),
  public._live_subscription(uuid),
  public._credit_period(uuid),
  public._plan_monthly_credits(text),
  public._plan_seats(text),
  public._topup_balance(uuid),
  public._topups_expire(uuid),
  public._credits_available(uuid),
  public._credits_charge(uuid, uuid, integer, text, date),
  public._billing_prune(),
  public._library_state(uuid),
  public._price_json(public.billing_prices),
  public._renewal_on_or_after(public.subscriptions, timestamptz),
  public._move_at(public.subscriptions, integer, integer, timestamptz),
  public._staff_can(uuid, text[]),
  public._move_json(public.price_moves),
  public._key_floor(text),
  public._topup_refund(uuid, integer, integer)
from service_role;
grant execute on function
  public.billing_prices_current(),
  public.billing_customer_get(uuid),
  public.billing_customer_set(uuid, text),
  public.billing_owner_by_customer(text),
  public.billing_checkout_record(uuid, text, text, text, text),
  public.billing_checkout_open(uuid, text, text),
  public.billing_checkout_poll(uuid, text),
  public.billing_topup_refund_by_session(text, integer, integer),
  public.billing_past_due_expire(integer),
  public.billing_deletion_cancels_due(integer),
  public.billing_checkout_status(uuid, text),
  public.billing_checkout_mark(text, text),
  public.billing_apply(uuid, jsonb, timestamptz),
  public.billing_subscription(uuid),
  public.billing_status(uuid),
  public.billing_topup_grant(uuid, text, text, text),
  public.billing_topup_refund(text, integer, integer),
  public.billing_event_begin(text, text, timestamptz),
  public.billing_event_finish(text, text, text, uuid),
  public.admin_price_set(uuid, text, text, integer, text, boolean),
  public.admin_price_preview(text, integer),
  public.admin_pack_set(uuid, text, boolean),
  public.admin_price_change_stop(uuid, uuid),
  public.price_moves_due(integer),
  public.price_move_mark(uuid, text),
  public.price_move_claim(uuid),
  public.price_move_reverts_due(integer),
  public.admin_billing_overview(uuid)
to service_role;
