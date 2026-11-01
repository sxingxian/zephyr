-- Assertions for the Zephyr AI migration (phase 6): credits, jobs and refunds, spend caps, masks and the
-- cut-out guard, signals, scenes, faces and people, admin settings, cron helpers and privileges.
-- Run with supabase/tests/run-local.sh.
\set ON_ERROR_STOP on
begin;

create function pg_temp.ok(cond boolean, what text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok - %', what;
end $$;
grant execute on function pg_temp.ok(boolean, text) to public;
create function pg_temp.photo(o uuid, n text, preview boolean default true) returns uuid language plpgsql as $$
declare id uuid;
begin
  insert into public.photos (owner_id, status, file_type, filename, size_bytes, sha256, width, height, has_thumb, has_preview, thumb_bytes, preview_bytes)
  values (o, 'ready', 'jpeg', n, 1000, extensions.digest(n || o::text, 'sha256'), 4000, 3000, true, preview, 100, case when preview then 200 else 0 end)
  returning photos.id into id;
  update public.profiles set storage_bytes = storage_bytes + 1100 + case when preview then 200 else 0 end where profiles.id = o;
  return id;
end $$;
-- A unit vector of 128 floats pointing mostly along axis i (with a little of axis j).
create function pg_temp.vec(i integer, j integer default 0, w real default 0) returns text language sql as $$
  select '[' || string_agg(case when k = i then (sqrt(1 - w * w))::text when k = j and w <> 0 then w::text else '0' end, ',' order by k) || ']'
    from generate_series(1, 128) k
$$;
create function pg_temp.balance(o uuid) returns integer language sql as $$
  select balance from public.credit_balances where owner_id = o
$$;
create function pg_temp.ledger_ok(o uuid) returns boolean language sql as $$
  -- Within the current period the balance is the period's ledger sum (no rollover on these plans).
  select pg_temp.balance(o) = (select coalesce(sum(delta), 0) from public.credit_ledger
                                where owner_id = o and period_start = public._ai_period())
$$;
-- Usage invariant from phases 3–5: masks never touch storage_bytes.
create function pg_temp.no_drift(o uuid) returns boolean language sql as $$
  select pr.storage_bytes =
           (select coalesce(sum(p.size_bytes + p.thumb_bytes + p.preview_bytes), 0) from public.photos p
             where p.owner_id = o and p.status in ('ready', 'trashed', 'purging'))
         + (select coalesce(sum(e.thumb_bytes + e.preview_bytes), 0) from public.photo_edits e
              join public.photos p on p.id = e.photo_id where p.owner_id = o and p.status in ('ready', 'trashed', 'purging'))
  from public.profiles pr where pr.id = o
$$;

insert into auth.users (id, email, email_confirmed_at) values
  ('a6000000-0000-0000-0000-000000000001', 'mei.ai@example.com', now()),
  ('a6000000-0000-0000-0000-000000000002', 'wei.ai@example.com', now()),
  ('a6000000-0000-0000-0000-0000000000f1', 'owner.ai@zephyr.test', now()),
  ('a6000000-0000-0000-0000-0000000000f2', 'finance.ai@zephyr.test', now()),
  ('a6000000-0000-0000-0000-0000000000f3', 'support.ai@zephyr.test', now());
update public.profiles set plan_id = 'pro' where id = 'a6000000-0000-0000-0000-000000000001';
insert into public.staff (user_id, role) values
  ('a6000000-0000-0000-0000-0000000000f1', 'owner'),
  ('a6000000-0000-0000-0000-0000000000f2', 'finance'),
  ('a6000000-0000-0000-0000-0000000000f3', 'support');

\set mei '\'a6000000-0000-0000-0000-000000000001\''
\set wei '\'a6000000-0000-0000-0000-000000000002\''

-- ---- Settings and plan limits --------------------------------------------------------------------
select pg_temp.ok((select quality_cleanup from public.plan_limits pl join public.plan_limit_versions v on v.id = pl.version_id
                    where v.status = 'active' and pl.plan_id = 'pro'), 'Cleanup is on the Pro plan');
select pg_temp.ok(not (select quality_cleanup from public.plan_limits pl join public.plan_limit_versions v on v.id = pl.version_id
                        where v.status = 'active' and pl.plan_id = 'free'), 'Cleanup is not on Free');
select pg_temp.ok((public.ai_settings_get() ->> 'bgProvider') = 'runware' and (public.ai_settings_get() ->> 'bgFallback') = 'fal_bria',
  'Runware is the default provider, fal the fallback');
select pg_temp.ok((public.ai_settings_get() #>> '{caps,total}')::numeric = 10, 'the daily cap starts at US$10');

-- ---- Status and credits ---------------------------------------------------------------------------
select pg_temp.ok((public.ai_status(:mei) #>> '{credits,balance}')::integer = 1000, 'a Pro member starts the month with 1,000 credits');
select pg_temp.ok((public.ai_status(:mei) #>> '{credits,balance}')::integer = 1000, 'reading status twice grants once');
select pg_temp.ok((public.ai_status(:wei) #>> '{credits,balance}')::integer = 30, 'a Free member gets 30');
select pg_temp.ok((public.ai_status(:wei) #>> '{features,face_grouping}') = 'off_plan', 'face grouping is off_plan on Free');
select pg_temp.ok((public.ai_status(:mei) #>> '{features,face_grouping}') = 'off_member', 'face grouping is off until the member opts in');
select pg_temp.ok((public.ai_status(:mei) #>> '{features,bg_removal}') = 'on', 'background removal is on');
select pg_temp.ok((public.ai_status(:wei) #>> '{features,cleanup}') = 'off_plan', 'cleanup is off_plan on Free');

-- A new period: unused credits expire, the new grant arrives, once.
update public.credit_balances set period_start = (public._ai_period() - interval '1 month')::date, balance = 12 where owner_id = :wei;
update public.credit_ledger set period_start = (public._ai_period() - interval '1 month')::date, created_at = now() - interval '1 month' where owner_id = :wei;
select pg_temp.ok((public.ai_status(:wei) #>> '{credits,balance}')::integer = 30, 'a new month: 12 unused expire and 30 are granted');
select pg_temp.ok((select count(*) = 1 from public.credit_ledger where owner_id = :wei and reason = 'period_expiry' and delta = -12),
  'the expiry is in the history');
select pg_temp.ok((public.ai_status(:wei) #>> '{credits,balance}')::integer = 30, 'rolling again changes nothing');
do $$ begin
  begin
    update public.credit_balances set balance = -1 where owner_id = 'a6000000-0000-0000-0000-000000000002';
    raise exception 'FAILED: negative balance accepted';
  exception when check_violation then raise notice 'ok - a balance can never go below 0';
  end;
end $$;

-- ---- Background-removal jobs ---------------------------------------------------------------------
create temp table t (k text primary key, v uuid);
insert into t values ('p1', pg_temp.photo(:mei, 'SKU-1.jpg')), ('p2', pg_temp.photo(:mei, 'SKU-2.jpg')),
  ('p3', pg_temp.photo(:mei, 'SKU-3.jpg')), ('nopreview', pg_temp.photo(:mei, 'raw.jpg', false)),
  ('w1', pg_temp.photo(:wei, 'wei.jpg'));
create temp table r (k text primary key, v jsonb);
insert into r values ('job', public.ai_bg_job_create(:mei,
  array[(select v from t where k = 'p1'), (select v from t where k = 'p2'), (select v from t where k = 'p1'),
        (select v from t where k = 'nopreview'), (select v from t where k = 'w1')],
  '{"bg": "white", "shadow": "soft", "shadowStrength": 40}', 'Product shoot', false));
select pg_temp.ok((select jsonb_array_length(v -> 'items') = 2 from r where k = 'job'), 'two photos queued (duplicates dropped)');
select pg_temp.ok((select v -> 'skipped' @> '[{"reason": "no_preview"}, {"reason": "not_found"}]' from r where k = 'job'),
  'a photo with no preview and another member''s photo are skipped');
select pg_temp.ok(pg_temp.balance(:mei) = 998, 'two credits charged at once');
select pg_temp.ok(pg_temp.ledger_ok(:mei), 'balance equals the period''s ledger');
select pg_temp.ok((select v #>> '{job,status}' = 'queued' and (v #>> '{job,credits,charged}')::integer = 2 from r where k = 'job'),
  'the job is queued with 2 credits charged');
select pg_temp.ok((public.ai_bg_job_create(:mei, array[(select v from t where k = 'p1')], '{"bg": "white"}', null, false) ->> 'error') = 'no_photos',
  'a photo already in the queue isn''t charged twice');
select pg_temp.ok((public.ai_bg_job_create(:wei, array[(select v from t where k = 'w1')], '{"bg": "nope"}', null, false) ->> 'error') = 'invalid',
  'an unknown background is refused');

-- Not enough credits: nothing queued, nothing charged.
update public.credit_balances set balance = 0 where owner_id = :wei;
select pg_temp.ok((public.ai_bg_job_create(:wei, array[(select v from t where k = 'w1')], '{"bg": "white"}', null, false)
                   @> '{"error": "insufficient_credits", "needed": 1, "balance": 0}'), 'insufficient credits refuses the whole job');
select pg_temp.ok(not exists (select 1 from public.ai_jobs where owner_id = :wei), 'no job was created');

-- Consumer: begin → complete attaches the mask as a new, unrendered edit version.
insert into r values ('i1', to_jsonb((select (v -> 'items' ->> 0)::uuid from r where k = 'job'))),
                     ('i2', to_jsonb((select (v -> 'items' ->> 1)::uuid from r where k = 'job')));
insert into r values ('b1', public.ai_item_begin((select (v #>> '{}')::uuid from r where k = 'i1'), 2000));
select pg_temp.ok((select v ->> 'status' = 'go' from r where k = 'b1'), 'begin: go');
select pg_temp.ok((select reserved_micros from public.ai_spend_daily where day = public._ai_today() and feature = 'bg_removal') = 2000,
  'the estimate is reserved');
select pg_temp.ok((public.ai_item_begin((select (v #>> '{}')::uuid from r where k = 'i1'), 2000) ->> 'status') = 'skip',
  'a second consumer skips an item that is processing');
insert into public.photo_edits (photo_id, owner_id, recipe, version)
values ((select v from t where k = 'p1'), :mei, '{"v": 1, "light": {"exposure": 0.3}}', 1);
update public.photos set edit_version = 1 where id = (select v from t where k = 'p1');
insert into r values ('c1', public.ai_item_complete((select (v #>> '{}')::uuid from r where k = 'i1'), 'b6000000-0000-0000-0000-000000000001',
  public._mask_key(:mei, (select v from t where k = 'p1'), 'b6000000-0000-0000-0000-000000000001'), 54321, 2048, 1536, 'runware', 600, 1200,
  '[{"provider": "runware", "role": "primary", "ok": true, "ms": 1200}]'));
select pg_temp.ok((select v ->> 'status' = 'ok' and (v ->> 'version')::integer = 2 from r where k = 'c1'), 'complete: a new edit version');
select pg_temp.ok((select recipe #>> '{cutout,mask}' = 'b6000000-0000-0000-0000-000000000001'
                          and recipe #>> '{cutout,bg}' = 'white' and recipe #>> '{light,exposure}' = '0.3'
                     from public.photo_edits where photo_id = (select v from t where k = 'p1')),
  'the cut-out is merged into the existing recipe');
select pg_temp.ok((select thumb_version is null from public.photo_edits where photo_id = (select v from t where k = 'p1')),
  'the edit is unrendered');
select pg_temp.ok((select spent_micros = 600 and reserved_micros = 0 from public.ai_spend_daily
                    where day = public._ai_today() and feature = 'bg_removal'), 'the reservation settles to the real cost');
select pg_temp.ok((select count(*) = 1 from public.ai_calls where provider = 'runware' and ok), 'the provider call is logged');
select pg_temp.ok(pg_temp.no_drift(:mei), 'masks don''t count toward storage');
select pg_temp.ok(public._photo_keys(:mei, (select v from t where k = 'p1'))
                  ? public._mask_key(:mei, (select v from t where k = 'p1'), 'b6000000-0000-0000-0000-000000000001'),
  'the photo''s purge keys include its mask');
select pg_temp.ok((public.sweep_photo_rows(array[(select v from t where k = 'p1')]) -> 0 -> 'maskKeys') ?
                  public._mask_key(:mei, (select v from t where k = 'p1'), 'b6000000-0000-0000-0000-000000000001'),
  'the orphan sweep knows the mask key');
select pg_temp.ok(public.ai_mask_key(:mei, (select v from t where k = 'p1'), 'b6000000-0000-0000-0000-000000000001') is not null
                  and public.ai_mask_key(:wei, (select v from t where k = 'p1'), 'b6000000-0000-0000-0000-000000000001') is null,
  'only the owner can read the mask');

-- Cut-out guard: a save can keep or drop the mask, never point at another photo's.
select pg_temp.ok((public.save_edit(:mei, (select v from t where k = 'p2'),
                   '{"v": 1, "cutout": {"mask": "b6000000-0000-0000-0000-000000000001", "bg": "white"}}', null) ->> 'status') = 'invalid',
  'save_edit refuses a mask of another photo');
select pg_temp.ok((public.save_edit(:mei, (select v from t where k = 'p1'),
                   '{"v": 1, "cutout": {"mask": "b6000000-0000-0000-0000-000000000001", "bg": "transparent"}}', 2) ->> 'status') = 'ok',
  'save_edit keeps the photo''s own mask');
do $$ begin
  begin
    update public.photo_edits set recipe = '{"v": 1, "cutout": {"mask": "b6000000-0000-0000-0000-0000000000ff", "bg": "white"}}'
     where photo_id = (select v from t where k = 'p1');
    raise exception 'FAILED: unknown mask accepted';
  exception when check_violation then raise notice 'ok - no writer can point a recipe at an unknown mask';
  end;
end $$;

-- Failure: refunded once.
insert into r values ('b2', public.ai_item_begin((select (v #>> '{}')::uuid from r where k = 'i2'), 2000));
select pg_temp.ok((public.ai_item_failed((select (v #>> '{}')::uuid from r where k = 'i2'), 'provider_timeout', 0,
                   '[{"provider": "runware", "ok": false, "ms": 30000, "error": "timeout"}]') ->> 'status') = 'failed', 'failed');
select pg_temp.ok(pg_temp.balance(:mei) = 999, 'the failed photo''s credit is refunded');
select pg_temp.ok((public.ai_item_failed((select (v #>> '{}')::uuid from r where k = 'i2'), 'provider_timeout', 0, '[]') ->> 'status') = 'skip'
                  and pg_temp.balance(:mei) = 999, 'a second failure report refunds nothing');
select pg_temp.ok((select count(*) = 1 from public.credit_ledger where reason = 'job_refund' and item_id = (select (v #>> '{}')::uuid from r where k = 'i2')),
  'one refund per charge');
select pg_temp.ok((public.ai_job_get(:mei, (select (v #>> '{job,id}')::uuid from r where k = 'job')) #>> '{job,status}') = 'done',
  'the job is done');
select pg_temp.ok((public.ai_job_get(:mei, (select (v #>> '{job,id}')::uuid from r where k = 'job')) -> 'items' -> 1 ->> 'retryable')::boolean,
  'a provider failure is retryable');
select pg_temp.ok(public.ai_job_get(:wei, (select (v #>> '{job,id}')::uuid from r where k = 'job')) is null, 'another member can''t see the job');

-- Retry charges again; a second failure is refunded again.
select pg_temp.ok((public.ai_job_retry(:mei, (select (v #>> '{job,id}')::uuid from r where k = 'job'), null) -> 'items') is not null
                  and pg_temp.balance(:mei) = 998, 'retry charges again');
select pg_temp.ok((public.ai_item_begin((select (v #>> '{}')::uuid from r where k = 'i2'), 2000) ->> 'status') = 'go', 'retried item goes');
select pg_temp.ok((public.ai_item_failed((select (v #>> '{}')::uuid from r where k = 'i2'), 'bad_output', 600, '[]') ->> 'status') = 'failed'
                  and pg_temp.balance(:mei) = 999, 'the retry''s failure is refunded too');
select pg_temp.ok(pg_temp.ledger_ok(:mei), 'balance still equals the ledger');

-- Cancel refunds pending items.
insert into r values ('job2', public.ai_bg_job_create(:mei, array[(select v from t where k = 'p3'), (select v from t where k = 'p2')],
  '{"bg": "transparent"}', null, false));
select pg_temp.ok(pg_temp.balance(:mei) = 997, 'job 2 charged');
select pg_temp.ok((public.ai_job_cancel(:mei, (select (v #>> '{job,id}')::uuid from r where k = 'job2')) #>> '{job,status}') = 'canceled'
                  and pg_temp.balance(:mei) = 999, 'cancel refunds every pending item');

-- Deleted photo: refunded, not retryable.
insert into r values ('job3', public.ai_bg_job_create(:mei, array[(select v from t where k = 'p3')], '{"bg": "white"}', null, false));
update public.photos set status = 'trashed', trashed_at = now(), purge_after = now() + interval '30 days' where id = (select v from t where k = 'p3');
select pg_temp.ok((public.ai_item_begin((select (v -> 'items' ->> 0)::uuid from r where k = 'job3'), 2000) ->> 'status') = 'failed'
                  and pg_temp.balance(:mei) = 999, 'a trashed photo fails its item and refunds it');
select pg_temp.ok(not (public.ai_job_get(:mei, (select (v #>> '{job,id}')::uuid from r where k = 'job3')) -> 'items' -> 0 ->> 'retryable')::boolean,
  'a deleted photo is not retryable');
update public.photos set status = 'ready', trashed_at = null, purge_after = null where id = (select v from t where k = 'p3');

-- Feature switched off in Admin while queued: refunded.
insert into r values ('job4', public.ai_bg_job_create(:mei, array[(select v from t where k = 'p3')], '{"bg": "white"}', null, false));
update public.ai_settings set f_bg_removal = false;
select pg_temp.ok((public.ai_item_begin((select (v -> 'items' ->> 0)::uuid from r where k = 'job4'), 2000) ->> 'status') = 'failed'
                  and pg_temp.balance(:mei) = 999, 'switched off: failed and refunded');
select pg_temp.ok((public.ai_bg_job_create(:mei, array[(select v from t where k = 'p3')], '{"bg": "white"}', null, false) ->> 'error') = 'feature_off',
  'no new jobs while switched off');
update public.ai_settings set f_bg_removal = true;

-- Admin pause: items wait, nothing refunded.
insert into r values ('job5', public.ai_bg_job_create(:mei, array[(select v from t where k = 'p3')], '{"bg": "white"}', null, true));
update public.ai_settings set cloud_paused = true;
select pg_temp.ok((public.ai_item_begin((select (v -> 'items' ->> 0)::uuid from r where k = 'job5'), 2000) ->> 'status') = 'wait'
                  and pg_temp.balance(:mei) = 998, 'paused: the item waits and keeps its charge');
select pg_temp.ok((public.ai_status(:mei) #>> '{cloudPaused,reason}') = 'admin', 'status says cloud work is paused by an admin');
select pg_temp.ok(public.ai_due_items(100) = '[]'::jsonb, 'nothing is re-enqueued while paused');
update public.ai_settings set cloud_paused = false;
update public.ai_job_items set wait_until = now() - interval '1 second' where job_id = (select (v #>> '{job,id}')::uuid from r where k = 'job5');
select pg_temp.ok(jsonb_array_length(public.ai_due_items(100)) = 1, 'resumed: the cron re-enqueues it');
select pg_temp.ok(jsonb_array_length(public.ai_due_items(100)) = 0, 'and doesn''t enqueue it twice within 10 minutes');

-- ---- Spend caps ---------------------------------------------------------------------------------
delete from public.ai_spend_daily; delete from public.ai_user_spend_daily; delete from public.ai_spend_alerts;
update public.ai_settings set cap_user_micros = 100000000, cap_bg_micros = 5000, cap_total_micros = 9000;
select pg_temp.ok((public._ai_spend_reserve('bg_removal', :wei, 3000) ->> 'ok')::boolean, 'reserve under the cap');
select pg_temp.ok((public._ai_spend_reserve('bg_removal', :wei, 3000) ->> 'capped') = 'feature', 'the feature cap holds');
select pg_temp.ok((public._ai_spend_reserve('scene_tags', :wei, 7000) ->> 'capped') = 'total', 'the total cap holds');
select pg_temp.ok((select count(*) >= 2 from public.ai_spend_alerts where day = public._ai_today() and threshold = 100), '100% alerts recorded');
select pg_temp.ok((select (public._ai_spend_reserve('scene_tags', :wei, 0) -> 'alerts') = '[]'::jsonb), 'each alert is reported once');
select pg_temp.ok((public.ai_status(:mei) #>> '{features,bg_removal}') = 'paused', 'at the cap, cloud features show paused');
update public.ai_settings set at_cap = 'alert_only';
delete from public.ai_spend_capped;
select pg_temp.ok((public._ai_spend_reserve('bg_removal', :wei, 3000) ->> 'ok')::boolean, 'alert_only lets work continue past the cap');
update public.ai_settings set cap_user_micros = 1000;
select pg_temp.ok((public._ai_spend_reserve('bg_removal', :mei, 2000) ->> 'capped') = 'user', 'the per-member cap holds even with alert_only');
update public.ai_settings set at_cap = 'pause', cap_user_micros = 500000, cap_bg_micros = 8000000, cap_total_micros = 10000000;
delete from public.ai_spend_daily; delete from public.ai_user_spend_daily; delete from public.ai_spend_alerts; delete from public.ai_spend_capped;

-- ---- Device jobs --------------------------------------------------------------------------------
insert into r values ('dj', public.ai_device_job_create(:mei, array[(select v from t where k = 'p2'), (select v from t where k = 'p3')],
  '{"steps": ["auto_enhance", "hdr"], "strength": 70}', 'Listing', 'Chrome on Mac', 'session-a'));
select pg_temp.ok((select v #>> '{job,holder,self}' = 'true' and jsonb_array_length(v -> 'remaining') = 2 from r where k = 'dj'),
  'the creating device holds the job');
select pg_temp.ok((public.ai_device_claim(:mei, (select (v #>> '{job,id}')::uuid from r where k = 'dj'), 'iPad', 'session-b') ->> 'error') = 'held',
  'another device can''t claim a live lease');
select pg_temp.ok((public.ai_device_progress(:mei, (select (v #>> '{job,id}')::uuid from r where k = 'dj'), 'session-b',
                   array[(select v from t where k = 'p2')], null) ->> 'error') = 'lost', 'a device without the lease can''t report');
select pg_temp.ok((public.ai_device_progress(:mei, (select (v #>> '{job,id}')::uuid from r where k = 'dj'), 'session-a',
                   array[(select v from t where k = 'p2')], null) #>> '{job,counts,completed}')::integer = 1, 'progress recorded');
update public.ai_jobs set lease_until = now() - interval '1 second' where id = (select (v #>> '{job,id}')::uuid from r where k = 'dj');
select pg_temp.ok((public.ai_job_get(:mei, (select (v #>> '{job,id}')::uuid from r where k = 'dj')) #>> '{job,status}') = 'waiting',
  'a lapsed lease shows waiting');
select pg_temp.ok((select jsonb_array_length(x -> 'remaining') = 1 from (select public.ai_device_claim(:mei,
                    (select (v #>> '{job,id}')::uuid from r where k = 'dj'), 'iPad', 'session-b') x) y),
  'another device continues where it stopped');
select pg_temp.ok((public.ai_device_progress(:mei, (select (v #>> '{job,id}')::uuid from r where k = 'dj'), 'session-b',
                   null, array[(select v from t where k = 'p3')]) #>> '{job,status}') = 'done', 'the job finishes');
select pg_temp.ok((public.ai_device_job_create(:mei, array[(select v from t where k = 'p2')], '{"steps": ["color_match"], "reference": "a6000000-0000-0000-0000-00000000dead"}',
                   null, 'Mac', 's') ->> 'error') = 'invalid', 'a reference that isn''t the member''s is refused');
select pg_temp.ok((public.ai_jobs_list(:mei, 'finished') #>> '{counts,finished}')::integer >= 1, 'the jobs list counts finished jobs');

-- ---- Signals, cleanup and scenes ----------------------------------------------------------------
select pg_temp.ok((public.ai_signals_pending(:mei, 1) ->> 'remaining')::integer = 4, 'four photos need signals');
select pg_temp.ok((public.ai_signals_pending(:mei, 1) -> 'photos' -> 0) ? 'takenAt', 'pending signals carry takenAt for the night rule');
select pg_temp.ok(public.ai_signals_save(:mei, 1, jsonb_build_array(
  jsonb_build_object('id', (select v from t where k = 'p1'), 'phash', 'ffff0000aaaa5555', 'sharpness', 120.5, 'brightness', 0.1, 'night', true),
  jsonb_build_object('id', (select v from t where k = 'w1'), 'phash', '0000000000000000', 'sharpness', 1, 'brightness', 0.5, 'night', false))) = 1,
  'only the member''s own photos are saved');
select pg_temp.ok(public.ai_signals_save(:mei, 1, '[{"id": "x", "phash": "zz"}]') = 0, 'malformed signals are refused');
select pg_temp.ok((public.ai_cleanup_page(:mei) -> 'photos' -> 0 ->> 'phash') = 'ffff0000aaaa5555', 'cleanup returns the hash as hex');
select pg_temp.ok((public.ai_cleanup_page(:wei) ->> 'error') = 'plan', 'cleanup needs Pro or Studio');
select pg_temp.ok(public.ai_cleanup_ignore(:mei, 'blurry', array[(select v from t where k = 'p1')]) = 1, 'keep a blurry photo');
select pg_temp.ok((public.ai_scene_begin(:mei, (select v from t where k = 'p2'), 20) ->> 'status') = 'go', 'scene tagging goes');
select pg_temp.ok((public.ai_scene_done(:mei, (select v from t where k = 'p2'), '[{"scene": "food", "score": 0.8}, {"scene": "nope", "score": 1}]',
                   20, 20, '[{"provider": "workers_ai", "ok": true, "ms": 300}]') ->> 'status') = 'ok', 'scene tags recorded');
select pg_temp.ok((select count(*) = 1 from public.photo_scenes where photo_id = (select v from t where k = 'p2')), 'unknown scenes are dropped');
select pg_temp.ok(public.ai_scenes(:mei) @> '[{"scene": "food", "count": 1}, {"scene": "night", "count": 1}]', 'scenes include Night from signals');
select pg_temp.ok(jsonb_array_length(public.list_photos(:mei, 'library', null, null, null, null, 'taken', null, 60, 'food') -> 'items') = 1,
  'list_photos filters by scene');
select pg_temp.ok(jsonb_array_length(public.list_photos(:mei, 'library', null, null, null, null, 'taken', null, 60, 'night') -> 'items') = 1,
  'list_photos filters by Night');
select pg_temp.ok(jsonb_array_length(public.list_photos(:mei) -> 'items') = 4, 'list_photos without filters is unchanged');
select pg_temp.ok(jsonb_array_length(public.ai_scene_backfill(100)) >= 1, 'the backfill finds untagged photos');
select (public.ai_member_settings_update(:mei, '{"sceneTags": false}')) is not null;
select pg_temp.ok(not exists (select 1 from public.photo_scenes where owner_id = :mei), 'turning scene tags off deletes them');
select public.ai_member_settings_update(:mei, '{"sceneTags": true}');

-- ---- Faces and people ---------------------------------------------------------------------------
select pg_temp.ok((public.ai_faces_pending(:mei, 1) ->> 'error') = 'off', 'face grouping needs opt-in');
select pg_temp.ok((public.ai_member_settings_update(:mei, '{"faceGrouping": true}') ->> 'error') = 'consent', 'opt-in needs consent');
select pg_temp.ok((public.ai_member_settings_update(:wei, '{"faceGrouping": true, "faceConsent": {"version": 1, "rightsConfirmed": true}}') ->> 'error') = 'plan',
  'Free can''t turn it on');
select pg_temp.ok((public.ai_member_settings_update(:mei, '{"faceGrouping": true, "faceConsent": {"version": 1, "rightsConfirmed": true}}')
                   #>> '{features,face_grouping}') = 'on', 'consent turns it on');
select pg_temp.ok(exists (select 1 from public.audit_log where action = 'ai.face_grouping.on' and actor = :mei), 'opt-in is audited');
select pg_temp.ok((public.ai_faces_pending(:mei, 1) ->> 'remaining')::integer = 3, 'three photos with previews to scan');
select pg_temp.ok((public.ai_faces_add(:mei, 1, 0.42, jsonb_build_array(
  jsonb_build_object('id', (select v from t where k = 'p1'), 'faces', jsonb_build_array(
    jsonb_build_object('box', '[0.1, 0.1, 0.2, 0.2]'::jsonb, 'score', 0.95, 'embedding', pg_temp.vec(1)),
    jsonb_build_object('box', '[0.5, 0.1, 0.2, 0.2]'::jsonb, 'score', 0.9, 'embedding', pg_temp.vec(2)))),
  jsonb_build_object('id', (select v from t where k = 'p2'), 'faces', jsonb_build_array(
    jsonb_build_object('box', '[0.1, 0.1, 0.2, 0.2]'::jsonb, 'score', 0.95, 'embedding', pg_temp.vec(1, 3, 0.3)))),
  jsonb_build_object('id', (select v from t where k = 'p3'), 'faces', jsonb_build_array(
    jsonb_build_object('box', '[0.1, 0.1, 0.2, 0.2]'::jsonb, 'score', 0.95, 'embedding', pg_temp.vec(1, 3, 0.5)))),
  jsonb_build_object('id', (select v from t where k = 'w1'), 'faces', jsonb_build_array(
    jsonb_build_object('box', '[0.1, 0.1, 0.2, 0.2]'::jsonb, 'score', 0.95, 'embedding', pg_temp.vec(1)))))) ->> 'saved')::integer = 4,
  'faces saved for the member''s own photos only');
select pg_temp.ok((select count(*) = 2 from public.people where owner_id = :mei), 'similar faces join one person; a different one starts another');
select pg_temp.ok((select face_count = 3 from public.people where owner_id = :mei order by face_count desc limit 1), 'three faces in the first person');
select pg_temp.ok(jsonb_array_length(public.ai_people_list(:mei, false, 3) -> 'people') = 1, 'unnamed people show from 3 faces');
create temp table pp as select id from public.people where owner_id = :mei order by face_count desc limit 1;
select pg_temp.ok((public.ai_person_patch(:mei, (select id from pp), '{"name": "Mei Lin"}') #>> '{person,name}') = 'Mei Lin', 'rename');
select pg_temp.ok((public.ai_person_patch(:wei, (select id from pp), '{"name": "x"}') -> 'person') is null and (select name from public.people where id = (select id from pp)) = 'Mei Lin', 'another member can''t rename');
select pg_temp.ok(jsonb_array_length(public.ai_face_suggestions(:mei, 0.95) -> 'suggestions') >= 1, 'unsure matches to named people are suggested');
select pg_temp.ok(jsonb_array_length(public.list_photos(:mei, 'library', null, null, null, null, 'taken', null, 60, null, (select id from pp)) -> 'items') = 3,
  'list_photos filters by person');
select pg_temp.ok(public.list_photos(:wei, 'library', null, null, null, null, 'taken', null, 60, null, (select id from pp)) is null,
  'another member''s person is not found');
select pg_temp.ok((public.ai_person_faces(:mei, (select id from pp), 'remove', array[(select v from t where k = 'p3')], null)
                   #>> '{person,faceCount}')::integer = 2, 'not this person removes the face');
select pg_temp.ok(exists (select 1 from public.face_rejections where person_id = (select id from pp)), 'the rejection is remembered');
select pg_temp.ok((public.ai_person_faces(:mei, (select id from pp), 'move', array[(select v from t where k = 'p2')], null, 'new') ->> 'to') is not null,
  'move to a new person');
select pg_temp.ok((select face_count = 1 from public.people where id = (select id from pp)), 'the count follows');
select pg_temp.ok((public.ai_person_merge(:mei, (select id from pp),
                     array(select id from public.people where owner_id = :mei and id <> (select id from pp))) #>> '{person,faceCount}')::integer = 3,
  'merge brings every face back');
select pg_temp.ok(not exists (select 1 from public.people where owner_id = :mei and id <> (select id from pp)), 'merged people are gone');
select pg_temp.ok(public.ai_faces_delete_all(:mei) = 4, 'turn off and delete removes every face (assigned or not)');
select pg_temp.ok(not exists (select 1 from public.people where owner_id = :mei) and not exists (select 1 from public.faces where owner_id = :mei),
  'no face data is left');
select pg_temp.ok((public.ai_status(:mei) #>> '{member,faceGrouping}') = 'false', 'face grouping is off again');
select pg_temp.ok((select face_consent_at is null from public.ai_member_settings where owner_id = :mei), 'consent cleared');

-- Plan lapse: stopped, warned, deleted after 30 days.
select public.ai_member_settings_update(:mei, '{"faceGrouping": true, "faceConsent": {"version": 1, "rightsConfirmed": true}}');
select public.ai_faces_add(:mei, 1, 0.42, jsonb_build_array(jsonb_build_object('id', (select v from t where k = 'p1'), 'faces',
  jsonb_build_array(jsonb_build_object('box', '[0.1, 0.1, 0.2, 0.2]'::jsonb, 'score', 0.95, 'embedding', pg_temp.vec(4))))));
update public.profiles set plan_id = 'free' where id = :mei;
select pg_temp.ok(public.ai_face_lapses(10) @> '[{"kind": "stopped"}]', 'a lapsed plan stops grouping and says so');
select pg_temp.ok(public.ai_face_lapses(10) = '[]'::jsonb, 'once');
update public.ai_member_settings set face_plan_lapsed_at = now() - interval '28 days' where owner_id = :mei;
select pg_temp.ok(public.ai_face_lapses(10) @> '[{"kind": "warning"}]', 'warned 3 days before');
update public.ai_member_settings set face_plan_lapsed_at = now() - interval '31 days' where owner_id = :mei;
select pg_temp.ok(public.ai_face_lapses(10) @> '[{"kind": "deleted"}]', 'deleted after 30 days');
select pg_temp.ok(not exists (select 1 from public.faces where owner_id = :mei), 'no faces left');
update public.profiles set plan_id = 'pro' where id = :mei;

-- ---- Admin --------------------------------------------------------------------------------------
select pg_temp.ok((public.admin_ai_settings_update('a6000000-0000-0000-0000-0000000000f2', '{"enabled": false}') ->> 'error') = 'forbidden',
  'finance can''t change AI settings');
select pg_temp.ok(public.admin_ai_settings('a6000000-0000-0000-0000-0000000000f2') is not null, 'finance can read them');
select pg_temp.ok(public.admin_ai_settings(:mei) is null, 'members can''t');
select pg_temp.ok((public.admin_ai_settings_update('a6000000-0000-0000-0000-0000000000f1',
                   '{"caps": {"total": 12.5}, "features": {"hdr": false}, "alerts": [80, 50]}') #>> '{settings,caps,total}')::numeric = 12.5,
  'owner updates caps');
select pg_temp.ok((public.ai_settings_get() -> 'alerts') = '[50, 80]'::jsonb and not (public.ai_settings_get() #>> '{features,hdr}')::boolean,
  'alerts and features saved');
select pg_temp.ok(exists (select 1 from public.audit_log where action = 'ai.settings.update' and details ? 'changes'), 'audited with the changes');
select pg_temp.ok((public.admin_ai_settings_update('a6000000-0000-0000-0000-0000000000f1', '{"bgFallback": "runware"}') ->> 'error') = 'invalid',
  'the fallback can''t be the primary');
select pg_temp.ok((public.admin_ai_settings_update('a6000000-0000-0000-0000-0000000000f1', '{"runwareModel": "http://evil"}') ->> 'error') = 'invalid',
  'model ids are checked');
select pg_temp.ok(public.ai_alert_recipients('owners_finance') ? 'finance.ai@zephyr.test'
                  and not public.ai_alert_recipients('owners') ? 'finance.ai@zephyr.test'
                  and not public.ai_alert_recipients('owners_finance') ? 'support.ai@zephyr.test', 'alert recipients');
select pg_temp.ok(public.admin_ai_jobs('a6000000-0000-0000-0000-0000000000f3') ? 'providers', 'any staff can read AI jobs');
select pg_temp.ok(public.admin_ai_jobs(:mei) is null, 'members can''t');
select pg_temp.ok((public.ai_prune() ? 'calls'), 'prune runs');

-- ---- Privileges ---------------------------------------------------------------------------------
select pg_temp.ok(not has_function_privilege('anon', 'public.ai_status(uuid)', 'execute')
                  and not has_function_privilege('authenticated', 'public.ai_bg_job_create(uuid, uuid[], jsonb, text, boolean)', 'execute'),
  'API roles can''t call AI functions');
select pg_temp.ok(not has_function_privilege('service_role', 'public._credits_roll(uuid)', 'execute'),
  'internal helpers aren''t callable');
select pg_temp.ok(not has_table_privilege('authenticated', 'public.faces', 'select')
                  and not has_table_privilege('anon', 'public.credit_ledger', 'select'), 'no direct table access');

rollback;
\echo 'All AI tests passed.'
