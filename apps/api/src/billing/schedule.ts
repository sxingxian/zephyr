/**
 * Scheduled downgrades (subscription schedules), docs/phase-7.md, Billing API › Change. A downgrade or switch
 * to monthly puts the subscription on a schedule: the current price until the period end, then the target.
 * While one is scheduled, upgrades are refused (409 conflict, reason `scheduled_change`) until the member
 * undoes it, so nothing here ever has to release a schedule and put it back.
 */
import type { BillingInterval } from '@zephyr/shared';
import type { Stripe } from './stripe';

/**
 * What a subscription's schedule means now:
 * - 'pending': a phase still starts in the future (a downgrade or switch to monthly is scheduled, at `at`);
 * - 'finished': live, but its last phase has started (the change already happened; Stripe releases it only when
 *   that phase ends, up to a year later). Not a scheduled change: the API releases it;
 * - null: no live schedule.
 */
export function scheduleStateOf(
  schedule: Stripe.SubscriptionSchedule | null,
  now = Math.floor(Date.now() / 1000),
): { kind: 'pending'; at: string } | { kind: 'finished'; id: string } | null {
  if (!schedule || (schedule.status !== 'active' && schedule.status !== 'not_started')) return null;
  const next = schedule.phases.find((p) => p.start_date > now);
  if (next) return { kind: 'pending', at: new Date(next.start_date * 1000).toISOString() };
  return { kind: 'finished', id: schedule.id };
}

/** The subscription's schedule as an object (retrieved when only its id is known), or null. */
export async function scheduleOf(
  stripe: Stripe,
  sub: Stripe.Subscription,
): Promise<Stripe.SubscriptionSchedule | null> {
  if (!sub.schedule) return null;
  if (typeof sub.schedule !== 'string') return sub.schedule;
  return stripe.subscriptionSchedules.retrieve(sub.schedule);
}

/** Releases a schedule whose change already happened (the subscription stays as it is). Idempotent. */
export async function releaseSchedule(stripe: Stripe, scheduleId: string) {
  await stripe.subscriptionSchedules.release(scheduleId, {}, { idempotencyKey: `release:${scheduleId}` });
}

/** Puts the subscription on a schedule: the current price until the period end, then `next` for an interval. */
export async function scheduleChange(
  stripe: Stripe,
  sub: Stripe.Subscription,
  item: Stripe.SubscriptionItem,
  currentPrice: string,
  scheduleId: string | null,
  next: { price: string; interval: BillingInterval; key: string; scheduleKey: string },
) {
  let schedule: Stripe.SubscriptionSchedule | null = null;
  if (scheduleId) {
    schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    if (schedule.status !== 'active' && schedule.status !== 'not_started') schedule = null;
  }
  if (!schedule) {
    schedule = await stripe.subscriptionSchedules.create(
      { from_subscription: sub.id },
      { idempotencyKey: next.scheduleKey },
    );
  }
  const start =
    schedule.current_phase?.start_date ?? schedule.phases[0]?.start_date ?? item.current_period_start;
  await stripe.subscriptionSchedules.update(
    schedule.id,
    {
      end_behavior: 'release',
      phases: [
        {
          items: [{ price: currentPrice, quantity: 1 }],
          start_date: start,
          end_date: item.current_period_end,
          proration_behavior: 'none',
        },
        {
          items: [{ price: next.price, quantity: 1 }],
          duration: { interval: next.interval, interval_count: 1 },
          proration_behavior: 'none',
        },
      ],
    },
    { idempotencyKey: next.key },
  );
}
