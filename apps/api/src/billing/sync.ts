/**
 * Applying Stripe's state to ours. Webhooks never trust event order: every subscription event re-reads the
 * subscription and stores it with the time the read started, and `billing_apply` ignores a read older than
 * the stored one (docs/phase-7.md, Professional notes).
 */
import {
  type BillingInterval,
  PAID_PLANS,
  type PaidPlanId,
  PLAN_KEEPING_STATUSES,
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
import { idOf, isMissing, isStripeError, type Stripe } from './stripe';

/** The event's object belongs to no owner we know, or to a different one than its customer: never applied. */
export class OwnerMismatch extends Error {
  constructor(readonly reason: 'no_owner' | 'owner_mismatch') {
    super(reason);
    this.name = 'OwnerMismatch';
  }
}

/** Subscription metadata flag: cancel_at_period_end was set by an account-deletion request, not by the member. */
export const DELETION_CANCEL_FLAG = 'zephyr_deletion_cancel';

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
    deletion_cancel: sub.metadata?.[DELETION_CANCEL_FLAG] === '1',
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

export interface SyncResult {
  owner: string;
  /** The subscription was a duplicate purchase: canceled and refunded (its Checkout shows "refunded"). */
  duplicate: boolean;
}

/** Re-reads a subscription from Stripe and applies it. */
export async function syncSubscription(
  env: Env,
  stripe: Stripe,
  subscriptionId: string,
  requestId: string,
  knownOwner?: string,
): Promise<SyncResult> {
  const syncedAt = new Date();
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: SUBSCRIPTION_EXPAND });
  const customerId = idOf(sub.customer);
  const owner = await resolveOwner(env, stripe, customerId, sub.metadata);
  if (knownOwner && knownOwner !== owner) throw new OwnerMismatch('owner_mismatch');
  let out = await billingDb.apply(env, owner, snapshot(sub), syncedAt);
  if (out?.duplicate && out.recorded) {
    // Recorded earlier (billing_duplicates): never applied, whatever happened to the stored one since. Finish
    // whatever an earlier try left undone.
    await settleDuplicate(env, stripe, sub, {
      refunded: Boolean(out.refunded),
      canceled: Boolean(out.canceled),
    });
  } else if (out?.duplicate && out.storedSubscriptionId) {
    out = await resolveDuplicate(env, stripe, owner, sub, syncedAt, out.storedSubscriptionId, requestId);
  }
  if (out && !out.stale && !out.duplicate && out.planBefore !== 'free' && out.planAfter === 'free') {
    await notifyPlanEnded(env, stripe, out.email ?? null, customerId, requestId);
  }
  return { owner, duplicate: Boolean(out?.duplicate) };
}

const keepsPlan = (sub: Stripe.Subscription) =>
  PLAN_KEEPING_STATUSES.includes(sub.status as SubscriptionStatus);

/**
 * A second live subscription for an owner whose stored one still keeps the plan (two Checkouts paid, e.g. two
 * tabs). First the stored one is checked in Stripe: if it has in fact ended, that is applied and the newer one
 * takes its place. Otherwise the newer one is recorded as a duplicate (billing_duplicates, so it can never be
 * adopted later), its paid invoices are refunded in full and it is canceled. Returns the final apply result.
 */
async function resolveDuplicate(
  env: Env,
  stripe: Stripe,
  owner: string,
  newer: Stripe.Subscription,
  newerSyncedAt: Date,
  storedId: string,
  requestId: string,
): Promise<Awaited<ReturnType<typeof billingDb.apply>>> {
  let stored: Stripe.Subscription | null = null;
  const storedAt = new Date();
  try {
    stored = await stripe.subscriptions.retrieve(storedId, { expand: SUBSCRIPTION_EXPAND });
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  if (!stored || !keepsPlan(stored)) {
    // The stored subscription ended and we hadn't heard yet: record that, then apply the newer one.
    if (stored) await billingDb.apply(env, owner, snapshot(stored), storedAt);
    // The newer read keeps the time it was taken: a read made since then must still win.
    return billingDb.apply(env, owner, snapshot(newer), newerSyncedAt);
  }
  logError(requestId, 'billing_duplicate_subscription', new Error('duplicate'));
  const rec = await billingDb.duplicateRecord(env, owner, newer.id);
  // The stored subscription itself is never treated as a duplicate.
  if (!rec || rec.error) throw new Error('duplicate_record_refused');
  await settleDuplicate(env, stripe, newer, {
    refunded: Boolean(rec.refunded),
    canceled: Boolean(rec.canceled),
  });
  return { planBefore: 'free', planAfter: 'free', duplicate: true };
}

/**
 * Settles a recorded duplicate: refund first, then cancel, each recorded once done. If the refund fails, the
 * webhook answers 500 (and the daily cron retries), and the cancel waits, so the duplicate is still live to
 * retry against. Only ever called for a subscription with a billing_duplicates row.
 */
export async function settleDuplicate(
  env: Env,
  stripe: Stripe,
  sub: Stripe.Subscription,
  done: { refunded: boolean; canceled: boolean },
) {
  if (!done.refunded) {
    await refundPaidInvoices(stripe, sub.id);
    await billingDb.duplicateMark(env, sub.id, 'refunded');
  }
  if (!done.canceled) {
    if (keepsPlan(sub) || sub.status === 'incomplete' || sub.status === 'paused') {
      await stripe.subscriptions.cancel(
        sub.id,
        { prorate: false, invoice_now: false },
        { idempotencyKey: `dup-cancel:${sub.id}` },
      );
    }
    await billingDb.duplicateMark(env, sub.id, 'canceled');
  }
}

/** Refund errors that mean the charge needs nothing more from us. */
const SETTLED_REFUND_CODES = new Set(['charge_already_refunded', 'charge_disputed']);

/** Refunds every paid payment of every paid invoice of a duplicate subscription, in full. */
async function refundPaidInvoices(stripe: Stripe, subscriptionId: string) {
  const invoices = await stripe.invoices.list({ subscription: subscriptionId, status: 'paid', limit: 24 });
  for (const inv of invoices.data) {
    if (!inv.id) continue;
    const payments = await stripe.invoicePayments.list({ invoice: inv.id, status: 'paid', limit: 10 });
    for (const p of payments.data) {
      const pi = idOf(p.payment?.payment_intent as string | { id: string } | null | undefined);
      if (!pi) continue;
      try {
        await stripe.refunds.create(
          { payment_intent: pi, reason: 'duplicate', metadata: { zephyr: 'duplicate_subscription' } },
          { idempotencyKey: `dup-refund:${pi}` },
        );
      } catch (err) {
        // Refunded already (an earlier try, past the 24 h idempotency window) or disputed (the dispute returns
        // the money): nothing more to do for this charge.
        if (!(isStripeError(err) && SETTLED_REFUND_CODES.has(err.code ?? ''))) throw err;
      }
    }
  }
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
    const r = subId ? await syncSubscription(env, stripe, subId, requestId, owner) : null;
    // A duplicate purchase never shows "Welcome": the return page says it was refunded.
    if (r?.duplicate) await billingDb.checkoutMark(env, session.id, 'refunded');
    else if (session.status === 'complete') await billingDb.checkoutMark(env, session.id, 'done');
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
