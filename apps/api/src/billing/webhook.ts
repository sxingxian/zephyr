/**
 * POST /api/v1/stripe/webhook (docs/phase-7.md, Billing API › Webhook). Outside the Origin, JSON and session
 * middleware: the signature is the only authentication. The raw body is read once with a size cap, verified,
 * recorded for idempotency, then dispatched. Nothing from the payload is stored or logged.
 */
import type { Context } from 'hono';
import { fail, logError } from '../http';
import type { HonoEnv } from '../types';
import { billingDb } from './db';
import { idOf, isMissing, type Stripe, stripeClient, verifyWebhook } from './stripe';
import { applyCheckoutSession, OwnerMismatch, syncSubscription } from './sync';

export const WEBHOOK_MAX_BYTES = 512 * 1024;

/** Events whose subscription is re-read and applied. */
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.pending_update_applied',
  'customer.subscription.pending_update_expired',
  'subscription_schedule.created',
  'subscription_schedule.updated',
  'subscription_schedule.released',
  'subscription_schedule.canceled',
  'subscription_schedule.completed',
  'subscription_schedule.aborted',
  'invoice.paid',
  'invoice.payment_failed',
]);

/** Every event type the endpoint subscribes to (scripts/stripe-setup.mjs registers this list). */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  ...SUBSCRIPTION_EVENTS,
  'charge.refunded',
  'charge.dispute.created',
] as const;

type Outcome = { status: 'processed' | 'ignored'; owner: string | null };

/** The subscription an event is about, if any. */
function subscriptionOf(event: Stripe.Event): string | null {
  const o = event.data.object as unknown as Record<string, unknown>;
  if (event.type.startsWith('customer.subscription.')) return typeof o.id === 'string' ? o.id : null;
  if (event.type.startsWith('subscription_schedule.'))
    return idOf(o.subscription as string | { id: string } | null);
  if (event.type.startsWith('invoice.')) {
    const inv = event.data.object as Stripe.Invoice;
    return idOf(inv.parent?.subscription_details?.subscription ?? null);
  }
  return null;
}

export async function dispatch(
  env: HonoEnv['Bindings'],
  stripe: Stripe,
  event: Stripe.Event,
  requestId: string,
): Promise<Outcome> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as Stripe.Checkout.Session;
      const owner = await applyCheckoutSession(env, stripe, session, requestId);
      return { status: 'processed', owner };
    }
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired': {
      const session = event.data.object as Stripe.Checkout.Session;
      await billingDb.checkoutMark(env, session.id, 'failed');
      return { status: 'processed', owner: null };
    }
    case 'charge.refunded':
    case 'charge.dispute.created': {
      const o = event.data.object as Stripe.Charge | Stripe.Dispute;
      const pi = idOf(o.payment_intent);
      // Only top-up payment intents have a bucket; anything else is a no-op in the database.
      if (pi) await billingDb.topupRefund(env, pi);
      return { status: pi ? 'processed' : 'ignored', owner: null };
    }
  }
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const sub = subscriptionOf(event);
    if (!sub) return { status: 'ignored', owner: null };
    try {
      const owner = await syncSubscription(env, stripe, sub, requestId);
      return { status: 'processed', owner };
    } catch (err) {
      // A subscription Stripe no longer has: nothing to apply.
      if (isMissing(err)) return { status: 'ignored', owner: null };
      throw err;
    }
  }
  return { status: 'ignored', owner: null };
}

export async function handleWebhook(c: Context<HonoEnv>) {
  const requestId = c.get('requestId');
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  const stripe = stripeClient(c.env);
  if (!secret || !stripe) return c.json(fail('billing_unavailable'), 503);

  const declared = Number(c.req.header('Content-Length') ?? '0');
  if (declared > WEBHOOK_MAX_BYTES) return c.json(fail('too_large'), 413);
  const signature = c.req.header('Stripe-Signature');
  if (!signature) return c.json(fail('invalid'), 400);
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > WEBHOOK_MAX_BYTES) return c.json(fail('too_large'), 413);
  const raw = new TextDecoder().decode(buf);

  let event: Stripe.Event;
  try {
    event = await verifyWebhook(raw, signature, secret);
  } catch {
    return c.json(fail('invalid'), 400);
  }

  let begin: 'new' | 'retry' | 'done';
  try {
    begin = await billingDb.eventBegin(c.env, event.id, event.type, event.created);
  } catch (err) {
    logError(requestId, 'stripe_event_begin', err);
    return c.json(fail('server'), 500);
  }
  if (begin === 'done') return c.json({ ok: true, duplicate: true });

  try {
    const out = await dispatch(c.env, stripe, event, requestId);
    await billingDb.eventFinish(c.env, event.id, out.status, null, out.owner);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof OwnerMismatch) {
      // Not retryable: Stripe retrying won't make the owners agree. Recorded and alerted, answered 200.
      logError(requestId, `stripe_${err.reason}`, err);
      await billingDb.eventFinish(c.env, event.id, 'failed', err.reason, null).catch(() => undefined);
      return c.json({ ok: true });
    }
    logError(requestId, 'stripe_event', err);
    const code = err instanceof Error ? err.name.slice(0, 60) : 'error';
    await billingDb.eventFinish(c.env, event.id, 'failed', code, null).catch(() => undefined);
    return c.json(fail('server'), 500);
  }
}
