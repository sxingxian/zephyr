/**
 * Applying Stripe's state to ours. Webhooks never trust event order: every subscription event re-reads the
 * subscription and stores it with the time the read started, and `billing_apply` ignores a read older than
 * the stored one (docs/phase-7.md, Professional notes).
 */
import {
  type BillingInterval,
  PAID_PLANS,
  type PaidPlanId,
  SUBSCRIPTION_LOOKUP_KEYS,
  type SubscriptionStatus,
  TOPUP_PACKS,
  type TopUpLookupKey,
} from '@zephyr/shared';
import { planEndedEmail } from '../email/billing-templates';
import { sendEmail } from '../email/resend';
import type { Env } from '../env';
import { logError } from '../http';
import { billingDb, type SubscriptionSnapshot } from './db';
import { idOf, type Stripe } from './stripe';

/** The event's object belongs to no owner we know, or to a different one than its customer: never applied. */
export class OwnerMismatch extends Error {
  constructor(readonly reason: 'no_owner' | 'owner_mismatch') {
    super(reason);
    this.name = 'OwnerMismatch';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (t: number | null | undefined) => (t ? new Date(t * 1000).toISOString() : null);

/** Lookup key → plan and interval, for prices that still carry a key. */
const BY_LOOKUP = new Map<string, { plan: PaidPlanId; interval: BillingInterval }>(
  PAID_PLANS.flatMap((plan) =>
    (['month', 'year'] as const).map((interval) => [
      SUBSCRIPTION_LOOKUP_KEYS[plan][interval],
      { plan, interval },
    ]),
  ),
);
const isPlan = (v: unknown): v is PaidPlanId => typeof v === 'string' && (PAID_PLANS as string[]).includes(v);
const isInterval = (v: unknown): v is BillingInterval => v === 'month' || v === 'year';

/**
 * A price's plan and interval. An older price loses its lookup key when Admin moves the key, so prices
 * carry `metadata.plan` (set by stripe-setup.mjs and Admin); the lookup key is the fallback.
 */
export function planOfPrice(
  price: Stripe.Price | string | null | undefined,
): { plan: PaidPlanId; interval: BillingInterval } | null {
  if (!price || typeof price === 'string') return null;
  const meta = price.metadata?.plan;
  const interval = price.recurring?.interval;
  if (isPlan(meta) && isInterval(interval)) return { plan: meta, interval };
  return (price.lookup_key && BY_LOOKUP.get(price.lookup_key)) || null;
}

export const isPackKey = (k: unknown): k is TopUpLookupKey =>
  typeof k === 'string' && TOPUP_PACKS.some((p) => p.lookupKey === k);

/** What `subscriptions.retrieve` expands so one read is enough. */
export const SUBSCRIPTION_EXPAND = ['items.data.price', 'schedule.phases.items.price'];

/** Maps a retrieved subscription to the row `billing_apply` stores. */
export function snapshot(sub: Stripe.Subscription): SubscriptionSnapshot {
  const item = sub.items.data[0];
  const price = item?.price ?? null;
  const current = planOfPrice(price);
  let scheduled: { plan: PaidPlanId; interval: BillingInterval; at: string } | null = null;
  let scheduledPriceId: string | null = null;
  const schedule = sub.schedule && typeof sub.schedule !== 'string' ? sub.schedule : null;
  if (schedule && (schedule.status === 'active' || schedule.status === 'not_started')) {
    const now = Math.floor(Date.now() / 1000);
    const next = schedule.phases.find((p) => p.start_date > now);
    const nextPrice = next?.items[0]?.price;
    const target = planOfPrice(
      typeof nextPrice === 'string' ? null : (nextPrice as Stripe.Price | undefined),
    );
    if (next && target) scheduled = { ...target, at: iso(next.start_date) as string };
    if (next && nextPrice) scheduledPriceId = typeof nextPrice === 'string' ? nextPrice : nextPrice.id;
  }
  return {
    stripe_subscription_id: sub.id,
    stripe_customer_id: idOf(sub.customer) as string,
    status: sub.status as SubscriptionStatus,
    plan_id: current?.plan ?? null,
    interval: current?.interval ?? null,
    stripe_price_id: price?.id ?? null,
    lookup_key: price?.lookup_key ?? null,
    item_id: item?.id ?? null,
    current_period_start: iso(item?.current_period_start),
    current_period_end: iso(item?.current_period_end),
    cancel_at_period_end: sub.cancel_at_period_end,
    schedule_id: idOf(sub.schedule),
    scheduled_plan: scheduled?.plan ?? null,
    scheduled_interval: scheduled?.interval ?? null,
    scheduled_at: scheduled?.at ?? null,
    scheduled_price_id: scheduledPriceId,
    amount: price?.unit_amount ?? null,
  };
}

/**
 * The owner an object belongs to: our `metadata.owner_id`, else the customer's. It must agree with the
 * `billing_customers` row for that customer, or nothing is applied.
 */
export async function resolveOwner(
  env: Env,
  stripe: Stripe,
  customerId: string | null,
  metadata: Stripe.Metadata | null | undefined,
): Promise<string> {
  if (!customerId) throw new OwnerMismatch('no_owner');
  let owner = metadata?.owner_id ?? null;
  if (!owner) {
    const customer = await stripe.customers.retrieve(customerId);
    owner =
      'deleted' in customer && customer.deleted
        ? null
        : ((customer as Stripe.Customer).metadata?.owner_id ?? null);
  }
  if (!owner || !UUID.test(owner)) throw new OwnerMismatch('no_owner');
  owner = owner.toLowerCase();
  if ((await billingDb.customer(env, owner)) !== customerId) throw new OwnerMismatch('owner_mismatch');
  return owner;
}

/** Re-reads a subscription from Stripe and applies it. Returns the owner. */
export async function syncSubscription(
  env: Env,
  stripe: Stripe,
  subscriptionId: string,
  requestId: string,
  knownOwner?: string,
): Promise<string> {
  const syncedAt = new Date();
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: SUBSCRIPTION_EXPAND });
  const customerId = idOf(sub.customer);
  const owner = await resolveOwner(env, stripe, customerId, sub.metadata);
  if (knownOwner && knownOwner !== owner) throw new OwnerMismatch('owner_mismatch');
  const out = await billingDb.apply(env, owner, snapshot(sub), syncedAt);
  if (out && !out.stale && out.planBefore !== 'free' && out.planAfter === 'free') {
    await notifyPlanEnded(env, stripe, out.email ?? null, customerId, requestId);
  }
  return owner;
}

async function notifyPlanEnded(
  env: Env,
  stripe: Stripe,
  email: string | null,
  customerId: string | null,
  requestId: string,
) {
  try {
    let to = email;
    if (!to && customerId) {
      const c = await stripe.customers.retrieve(customerId);
      to = 'deleted' in c && c.deleted ? null : ((c as Stripe.Customer).email ?? null);
    }
    if (!to) return;
    await sendEmail(env, { to, ...planEndedEmail({ appUrl: env.APP_URL }) });
  } catch (err) {
    logError(requestId, 'billing_plan_ended_email', err);
  }
}

/** A completed Checkout Session: subscription → re-read and apply; top-up → grant once when paid. */
export async function applyCheckoutSession(
  env: Env,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  requestId: string,
): Promise<string> {
  const owner = await resolveOwner(env, stripe, idOf(session.customer), session.metadata);
  if (session.client_reference_id && session.client_reference_id.toLowerCase() !== owner) {
    throw new OwnerMismatch('owner_mismatch');
  }
  if (session.mode === 'subscription') {
    const subId = idOf(session.subscription);
    if (subId) await syncSubscription(env, stripe, subId, requestId, owner);
    if (session.status === 'complete') await billingDb.checkoutMark(env, session.id, 'done');
    return owner;
  }
  if (session.mode === 'payment') {
    const key = session.metadata?.lookup_key;
    if (session.payment_status === 'paid' && isPackKey(key)) {
      // The credits come from our price table by lookup key, never from the event.
      const out = await billingDb.topupGrant(env, owner, session.id, idOf(session.payment_intent), key);
      // Not recorded by our Checkout, or recorded for another owner or pack: never grant, never retry.
      if (!out || out.error) throw new OwnerMismatch('owner_mismatch');
      await billingDb.checkoutMark(env, session.id, 'done');
    }
  }
  return owner;
}
