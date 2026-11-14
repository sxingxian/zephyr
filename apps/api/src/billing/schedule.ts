/**
 * Scheduled downgrades (subscription schedules) and the upgrade-while-scheduled case (docs/phase-7.md, Billing
 * API › Change). Stripe won't update a subscription a schedule manages, so an upgrade releases the schedule
 * first. If the upgrade then waits for payment (3-D Secure), the downgrade isn't recreated at once: a
 * schedule's phases would later override the paid upgrade. Instead the target is kept on the subscription's
 * metadata, and the webhook recreates the schedule only if the pending update expires unpaid
 * (`customer.subscription.pending_update_expired`), or just clears the note once it's paid
 * (`customer.subscription.pending_update_applied`).
 */
import type { BillingInterval, PaidPlanId } from '@zephyr/shared';
import type { Env } from '../env';
import { logError } from '../http';
import { idOf, type Stripe } from './stripe';
import { planOfPrice, resolveOwner, SUBSCRIPTION_EXPAND } from './sync';

/** Subscription metadata: the downgrade to restore if the pending upgrade expires (`<plan>:<interval>`). */
export const PENDING_DOWNGRADE = 'zephyr_pending_downgrade';
/** …and the exact price it pointed at (a grandfathered price, not necessarily the key's current one). */
export const PENDING_DOWNGRADE_PRICE = 'zephyr_pending_downgrade_price';

const PRICE_ID = /^price_[A-Za-z0-9_]{1,200}$/;

export interface ScheduledTarget {
  price: string;
  interval: BillingInterval;
  plan: PaidPlanId | null;
}

/** The price a schedule moves to next (a scheduled downgrade), or null. */
export async function scheduledTarget(stripe: Stripe, scheduleId: string): Promise<ScheduledTarget | null> {
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId, {
    expand: ['phases.items.price'],
  });
  if (schedule.status !== 'active' && schedule.status !== 'not_started') return null;
  const now = Math.floor(Date.now() / 1000);
  const next = schedule.phases.find((p) => p.start_date > now);
  const p = next?.items[0]?.price;
  if (!p) return null;
  const price = typeof p === 'string' ? p : p.id;
  const known = typeof p === 'string' ? null : planOfPrice(p as Stripe.Price);
  const interval =
    known?.interval ??
    (typeof p !== 'string' && 'recurring' in p && p.recurring?.interval === 'year' ? 'year' : 'month');
  return { price, interval, plan: known?.plan ?? null };
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

/** Notes the released downgrade on the subscription, before the upgrade is attempted. */
export async function notePendingDowngrade(
  stripe: Stripe,
  subId: string,
  target: ScheduledTarget,
  idempotencyKey: string,
) {
  await stripe.subscriptions.update(
    subId,
    {
      metadata: {
        [PENDING_DOWNGRADE]: `${target.plan ?? 'unknown'}:${target.interval}`,
        [PENDING_DOWNGRADE_PRICE]: target.price,
      },
    },
    { idempotencyKey },
  );
}

/** Clears the note (the upgrade went through, or the downgrade is back on a schedule). */
export async function clearPendingDowngrade(stripe: Stripe, subId: string, idempotencyKey: string) {
  await stripe.subscriptions.update(
    subId,
    { metadata: { [PENDING_DOWNGRADE]: '', [PENDING_DOWNGRADE_PRICE]: '' } },
    { idempotencyKey },
  );
}

/** The noted downgrade, or null. */
export function pendingDowngradeOf(sub: Stripe.Subscription): ScheduledTarget | null {
  const note = sub.metadata?.[PENDING_DOWNGRADE];
  const price = sub.metadata?.[PENDING_DOWNGRADE_PRICE];
  if (!note || !price || !PRICE_ID.test(price)) return null;
  const [plan, interval] = note.split(':');
  if (interval !== 'month' && interval !== 'year') return null;
  return { price, interval, plan: plan === 'pro' || plan === 'studio' ? plan : null };
}

/**
 * Webhook: a pending upgrade ended. Expired unpaid → the noted downgrade goes back on a schedule, then the note
 * is cleared. Applied (paid) → the note is cleared and nothing is scheduled. Idempotent per event.
 */
export async function settlePendingDowngrade(
  env: Env,
  stripe: Stripe,
  subscriptionId: string,
  outcome: 'applied' | 'expired',
  eventId: string,
  requestId: string,
): Promise<void> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: SUBSCRIPTION_EXPAND });
  await resolveOwner(env, stripe, idOf(sub.customer), sub.metadata);
  const target = pendingDowngradeOf(sub);
  if (!target) return;
  const item = sub.items.data[0];
  const live = sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
  if (outcome === 'expired' && item && live && !idOf(sub.schedule) && sub.items.data.length === 1) {
    const currentPrice = typeof item.price === 'string' ? item.price : item.price.id;
    try {
      await scheduleChange(stripe, sub, item, currentPrice, null, {
        price: target.price,
        interval: target.interval,
        key: `restore:${sub.id}:${eventId}`,
        scheduleKey: `restore-schedule:${sub.id}:${eventId}`,
      });
    } catch (err) {
      logError(requestId, 'billing_schedule_restore', err);
      throw err;
    }
  }
  await clearPendingDowngrade(stripe, sub.id, `pending-clear:${sub.id}:${eventId}`);
}
