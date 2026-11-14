/**
 * The daily billing job (02:10 UTC): price moves. Subscribers on an older price of their lookup key get a
 * notice, then move at their renewal (docs/phase-7.md, Billing API › Cron).
 */
import { PLAN_KEEPING_STATUSES, type SubscriptionStatus } from '@zephyr/shared';
import { priceNoticeEmail } from '../email/billing-templates';
import { sendEmail } from '../email/resend';
import type { Env } from '../env';
import { logError } from '../http';
import { billingDb, type DueMove } from './db';
import { isMissing, type Stripe, stripeClient } from './stripe';
import { syncSubscription } from './sync';

export const BILLING_CRON = '10 2 * * *';
export const BILLING_CRON_LIMITS = { moves: 200 } as const;
/** Moves are applied this long before the renewal, so the renewal invoice uses the new price. */
export const MOVE_LEAD_MS = 48 * 3600 * 1000;

export interface BillingCronCounts {
  notified: number;
  moved: number;
  skipped: number;
  failed: number;
}

/** Puts a subscription's item on `price` without proration. Returns false when the item isn't on `from`. */
export async function swapPrice(
  stripe: Stripe,
  subscriptionId: string,
  from: string,
  to: string,
  idempotencyKey: string,
): Promise<'swapped' | 'changed' | 'gone'> {
  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    if (isMissing(err)) return 'gone';
    throw err;
  }
  if (!PLAN_KEEPING_STATUSES.includes(sub.status as SubscriptionStatus)) return 'gone';
  const item = sub.items.data[0];
  const current = item ? (typeof item.price === 'string' ? item.price : item.price.id) : null;
  if (!item || current !== from || sub.items.data.length !== 1) return 'changed';
  await stripe.subscriptions.update(
    subscriptionId,
    { items: [{ id: item.id, price: to }], proration_behavior: 'none' },
    { idempotencyKey },
  );
  return 'swapped';
}

async function notify(env: Env, m: DueMove, requestId: string): Promise<boolean> {
  if (!m.email) return true; // nothing to send to; the move still waits for its date
  try {
    await sendEmail(env, {
      to: m.email,
      idempotencyKey: `price-notice:${m.id}`,
      ...priceNoticeEmail({
        plan: m.plan,
        interval: m.interval,
        from: m.fromAmount,
        to: m.toAmount,
        moveAt: m.moveAt,
        appUrl: env.APP_URL,
      }),
    });
    return true;
  } catch (err) {
    logError(requestId, 'price_notice_email', err);
    return false;
  }
}

export async function runBillingCron(
  env: Env,
  requestId = 'cron-billing',
  now = Date.now(),
): Promise<BillingCronCounts> {
  const counts: BillingCronCounts = { notified: 0, moved: 0, skipped: 0, failed: 0 };
  const stripe = stripeClient(env);
  if (!stripe) return counts;
  let due: DueMove[];
  try {
    due = await billingDb.movesDue(env, BILLING_CRON_LIMITS.moves);
  } catch (err) {
    logError(requestId, 'price_moves_due', err);
    return counts;
  }
  for (const m of due) {
    try {
      if (m.status === 'pending') {
        // A notice first, always: a move is never applied without one, even when it's already close.
        if (await notify(env, m, requestId)) {
          await billingDb.moveMark(env, m.id, 'notified');
          counts.notified += 1;
        } else counts.failed += 1;
        continue;
      }
      if (new Date(m.moveAt).getTime() - now > MOVE_LEAD_MS) continue;
      const r = await swapPrice(stripe, m.stripeSubscriptionId, m.fromPriceId, m.toPriceId, `move:${m.id}`);
      if (r === 'swapped') {
        await billingDb.moveMark(env, m.id, 'moved');
        counts.moved += 1;
        await syncSubscription(env, stripe, m.stripeSubscriptionId, requestId, m.ownerId).catch((err) =>
          logError(requestId, 'price_move_sync', err),
        );
      } else {
        // Plan, interval or status changed since the notice: the sweep re-checks it from scratch.
        await billingDb.moveMark(env, m.id, 'skipped');
        counts.skipped += 1;
      }
    } catch (err) {
      counts.failed += 1;
      logError(requestId, 'price_move', err);
    }
  }
  return counts;
}
