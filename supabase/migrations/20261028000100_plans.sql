-- Plans and the first active plan-limits version. Values match packages/shared/src/plans.ts.
-- Later changes are made in Admin › Plan limits as new versions (draft → approved → active).

insert into public.plans (id, name, sort) values
  ('free', 'Free', 1),
  ('pro', 'Pro', 2),
  ('studio', 'Studio', 3);

with v as (
  insert into public.plan_limit_versions (version, status, reason, effective_mode, activated_at)
  values (1, 'active', 'Launch limits', 'new_signups', now())
  returning id
)
insert into public.plan_limits (
  version_id, plan_id, storage_gb, cloud_credits_month, credits_rollover, batch_size, file_types,
  max_file_mb, galleries, max_link_days, guest_full_res, branding, people_grouping, seats, ads, priority_queue
)
select v.id, x.*
from v,
  (values
    ('free',     5,   30, false,  25, array['jpeg', 'png', 'webp'],                       50,    3,    7, false, false, false, 1, true,  false),
    ('pro',    250, 1000, false, 500, array['jpeg', 'png', 'webp', 'cr2', 'nef', 'arw'], 200, null, null, true,  false, true,  1, false, false),
    ('studio', 1000, 5000, false, 500, array['jpeg', 'png', 'webp', 'cr2', 'nef', 'arw'], 200, null, null, true,  true,  true,  3, false, true)
  ) as x (plan_id, storage_gb, cloud_credits_month, credits_rollover, batch_size, file_types,
          max_file_mb, galleries, max_link_days, guest_full_res, branding, people_grouping, seats, ads, priority_queue);
