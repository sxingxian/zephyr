import {
  type BillingInterval,
  type BillingStatusResult,
  type CheckoutStatusResult,
  checkoutSchema,
  checkoutSessionIdSchema,
  PAID_PLANS,
  type PaidPlanId,
  PLAN_KEEPING_STATUSES,
  PLANS,
  type PlanChangeKind,
  type PlanChangePreviewResult,
  type PlanChangeResult,
  type PlanLimits,
  type PublicPricingResult,
  planChangeSchema,
  SUBSCRIPTION_LOOKUP_KEYS,
  type Team,
  TOPUP_PACKS,
  type TopUpLookupKey,
} from '@zephyr/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { billingDb, type CurrentPrice, type StoredSubscription } from '../billing/db';
import { releaseSchedule, scheduleChange, scheduleOf, scheduleStateOf } from '../billing/schedule';
import { idOf, isStripeError, type Stripe, stripeClient } from '../billing/stripe';
import { applyCheckoutSession, OwnerMismatch, SUBSCRIPTION_EXPAND, syncSubscription } from '../billing/sync';
import { handleWebhook } from '../billing/webhook';
import { list } from '../env';
import { fail, guardWrite, logError, rateLimited, readBody } from '../http';
import { expectedUser } from '../library/storage';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';
import { requireMember } from './session-helpers';

/**
 * /api/v1/billing/*: the signed-in member's own plan (docs/phase-7.md, Billing API). Billing is personal:
 * the open library (X-Zephyr-Library) is ignored here; only the member pays for their own plan and team.
 * Prices always come from our table by lookup key; the client never sends a price id or an amount.
 */
export const billingRoutes = new Hono<HonoEnv>();
type Ctx = Context<HonoEnv>;
const ownerOf = (c: Ctx) => c.get('session').userId;

billingRoutes.use(
  '*',
  guardWrite((env) => list(env.APP_ORIGINS), 4 * 1024),
);
billingRoutes.use('*', requireMember);
const writes: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  if (!(await c.env.BILLING_LIMITER.limit({ key: `billing:${ownerOf(c)}` })).success)
    return rateLimited(c, 60);
  return expectedUser(c, next);
};
billingRoutes.use('*', writes);

/** Seconds a Checkout return waits for the webhook before asking Stripe itself. */
export const CHECKOUT_SELF_FETCH_AFTER_MS = 10_000;
const PLAN_RANK: Record<PaidPlanId, number> = { pro: 1, studio: 2 };
const appUrl = (c: Ctx) => c.env.APP_URL.replace(/\/$/, '');

const unavailable = (c: Ctx) => c.json(fail('billing_unavailable'), 503);
function upstream(c: Ctx, where: string, err: unknown) {
  logError(c.get('requestId'), where, err);
  // Stripe refused or didn't answer: nothing was charged by this request.
  if (isStripeError(err)) return unavailable(c);
  return c.json(fail('server'), 500);
}
/** Keeps the paid plan now (the database also caps past_due at its grace period). */
const keeping = (s: StoredSubscription | null): s is StoredSubscription =>
  !!s && (s.keepsPlan ?? PLAN_KEEPING_STATUSES.includes(s.status));

/** Our stored customer and Stripe's disagree (a lost race): no Checkout on a customer we don't own. */
class CustomerConflict extends Error {
  constructor() {
    super('customer_conflict');
    this.name = 'CustomerConflict';
  }
}
const priceFor = (prices: CurrentPrice[], key: string) => prices.find((p) => p.lookupKey === key) ?? null;

async function statusResult(c: Ctx): Promise<BillingStatusResult | null> {
  const s = await billingDb.status(c.env, ownerOf(c));
  return s ? { ok: true, ...s } : null;
}

// ---- status ----------------------------------------------------------------------------------------------
billingRoutes.get('/', async (c) => {
  try {
    const out = await statusResult(c);
    return out ? c.json(out) : c.json(fail('not_found'), 404);
  } catch (err) {
    return upstream(c, 'billing_status', err);
  }
});

// ---- checkout ----------------------------------------------------------------------------------------------
/** The member's Stripe customer, created (with our owner id in metadata) the first time. */
async function ensureCustomer(c: Ctx, stripe: Stripe): Promise<string> {
  const owner = ownerOf(c);
  const existing = await billingDb.customer(c.env, owner);
  if (existing) return existing;
  const customer = await stripe.customers.create(
    { email: c.get('session').email, metadata: { owner_id: owner } },
    { idempotencyKey: `customer:${owner}` },
  );
  // Insert-only: the answer is whatever is stored for this owner (a parallel request may have won), or null
  // when this customer id already belongs to someone else.
  let stored: unknown;
  try {
    stored = await billingDb.setCustomer(c.env, owner, customer.id);
  } catch (err) {
    stored = await billingDb.customer(c.env, owner);
    if (!stored) throw err;
  }
  if (typeof stored !== 'string' || !/^cus_[A-Za-z0-9]+$/.test(stored)) throw new CustomerConflict();
  return stored;
}

/**
 * Expires the owner's other open subscription Checkouts, so two tabs can't end in two paid subscriptions.
 * Returns true when one had already completed (then the caller answers 409: the member has a plan now).
 */
async function expireOtherCheckouts(c: Ctx, stripe: Stripe, owner: string, idem: string): Promise<boolean> {
  let completed = false;
  for (const id of await billingDb.checkoutOpen(c.env, owner, 'subscription', idem)) {
    try {
      await stripe.checkout.sessions.expire(id, {}, { idempotencyKey: `expire:${id}` });
      await billingDb.checkoutMark(c.env, id, 'failed');
    } catch (err) {
      // Not open any more: see what happened to it.
      if (!isStripeError(err)) throw err;
      const session = await stripe.checkout.sessions.retrieve(id);
      if (session.status === 'complete') {
        await applyCheckoutSession(c.env, stripe, session, c.get('requestId'));
        completed = true;
      } else if (session.status === 'expired') {
        await billingDb.checkoutMark(c.env, id, 'failed');
      } else throw err;
    }
  }
  return completed;
}

billingRoutes.post('/checkout', async (c) => {
  const body = await readBody(c, checkoutSchema);
  if (!body) return c.json(fail('invalid'), 400);
  const stripe = stripeClient(c.env);
  if (!stripe) return unavailable(c);
  const owner = ownerOf(c);
  try {
    const prices = await billingDb.pricesCurrent(c.env);
    let lookupKey: string;
    if (body.kind === 'subscription') {
      if (keeping(await billingDb.subscription(c.env, owner))) return c.json(fail('conflict'), 409);
      lookupKey = SUBSCRIPTION_LOOKUP_KEYS[body.plan as PaidPlanId][body.interval as BillingInterval];
    } else {
      lookupKey = body.pack;
    }
    const price = priceFor(prices, lookupKey);
    if (!price || !/^price_/.test(price.stripePriceId) || price.stripePriceId.startsWith('price_seed_')) {
      return unavailable(c);
    }
    if (body.kind === 'topup' && !price.active) return c.json(fail('not_found'), 404);
    const customer = await ensureCustomer(c, stripe);

    // Retries in the same window return the same session (a double click opens one Checkout). Subscriptions:
    // 10-minute windows; top-ups: 1 minute, so buying a second pack soon after is a new session.
    const windowSec = body.kind === 'subscription' ? 600 : 60;
    const bucket = Math.floor(Date.now() / 1000 / windowSec);
    const idem = `checkout:${owner}:${body.kind}:${lookupKey}:${bucket}`;
    if (body.kind === 'subscription') {
      if (await expireOtherCheckouts(c, stripe, owner, idem)) return c.json(fail('conflict'), 409);
      if (keeping(await billingDb.subscription(c.env, owner))) return c.json(fail('conflict'), 409);
    }
    // Derived from the window, so the idempotent retry sends identical parameters; always ≥ 30 min ahead.
    const expiresAt = (bucket + 1) * windowSec + 31 * 60;
    const metadata = { owner_id: owner, kind: body.kind, lookup_key: lookupKey };
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: body.kind === 'subscription' ? 'subscription' : 'payment',
      managed_payments: { enabled: true },
      customer,
      line_items: [{ price: price.stripePriceId, quantity: 1 }],
      client_reference_id: owner,
      metadata,
      success_url: `${appUrl(c)}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl(c)}/settings/billing`,
      expires_at: expiresAt,
      ...(body.kind === 'subscription'
        ? { subscription_data: { metadata: { owner_id: owner } } }
        : { payment_intent_data: { metadata } }),
    };
    const session = await stripe.checkout.sessions.create(params, { idempotencyKey: idem });
    if (!session.url) return unavailable(c);
    await billingDb.checkoutRecord(c.env, owner, session.id, body.kind, lookupKey, idem);
    return c.json({ ok: true, url: session.url }, 201);
  } catch (err) {
    if (err instanceof CustomerConflict) return c.json(fail('conflict'), 409);
    return upstream(c, 'billing_checkout', err);
  }
});

billingRoutes.get('/checkout/:id', async (c) => {
  const id = checkoutSessionIdSchema.safeParse(c.req.param('id'));
  if (!id.success) return c.json(fail('not_found'), 404);
  const owner = ownerOf(c);
  try {
    let row = await billingDb.checkoutStatus(c.env, owner, id.data);
    if (!row) return c.json(fail('not_found'), 404);
    const age = row.createdAt ? Date.now() - new Date(row.createdAt).getTime() : 0;
    const stripe = stripeClient(c.env);
    if (
      row.state === 'pending' &&
      stripe &&
      age >= CHECKOUT_SELF_FETCH_AFTER_MS &&
      // At most once per 10 s per session, however fast the page (or a script) polls.
      (await billingDb.checkoutPoll(c.env, owner, id.data))
    ) {
      // The webhook is slow: apply the session through the same path the webhook uses.
      try {
        const session = await stripe.checkout.sessions.retrieve(id.data);
        if (session.status === 'complete')
          await applyCheckoutSession(c.env, stripe, session, c.get('requestId'));
        else if (session.status === 'expired') await billingDb.checkoutMark(c.env, id.data, 'failed');
        row = (await billingDb.checkoutStatus(c.env, owner, id.data)) ?? row;
      } catch (err) {
        if (err instanceof OwnerMismatch) return c.json(fail('not_found'), 404);
        // Keep answering "pending"; the webhook will still arrive.
        logError(c.get('requestId'), 'billing_checkout_self_fetch', err);
      }
    }
    const out: CheckoutStatusResult = {
      ok: true,
      state: row.state,
      kind: row.kind,
      ...(row.plan ? { plan: row.plan } : {}),
      ...(row.credits ? { credits: row.credits } : {}),
    };
    return c.json(out);
  } catch (err) {
    return upstream(c, 'billing_checkout_status', err);
  }
});

// ---- portal ------------------------------------------------------------------------------------------------
billingRoutes.post('/portal', async (c) => {
  const stripe = stripeClient(c.env);
  if (!stripe) return unavailable(c);
  try {
    const customer = await billingDb.customer(c.env, ownerOf(c));
    if (!customer) return c.json(fail('conflict'), 409);
    const session = await stripe.billingPortal.sessions.create(
      { customer, return_url: `${appUrl(c)}/settings/billing` },
      { idempotencyKey: `portal:${ownerOf(c)}:${Math.floor(Date.now() / 60_000)}` },
    );
    return c.json({ ok: true, url: session.url }, 201);
  } catch (err) {
    return upstream(c, 'billing_portal', err);
  }
});

// ---- plan changes ------------------------------------------------------------------------------------------
/** Higher plan or monthly → yearly: now. Lower plan or yearly → monthly: at the period end. */
export function changeKind(
  from: { plan: PaidPlanId; interval: BillingInterval },
  to: { plan: PaidPlanId; interval: BillingInterval },
): PlanChangeKind | null {
  if (from.plan === to.plan && from.interval === to.interval) return null;
  if (PLAN_RANK[to.plan] !== PLAN_RANK[from.plan])
    return PLAN_RANK[to.plan] > PLAN_RANK[from.plan] ? 'upgrade' : 'downgrade';
  return to.interval === 'year' ? 'upgrade' : 'downgrade';
}

const FEATURE_LABELS: Partial<Record<keyof PlanLimits, string>> = {
  peopleGrouping: 'People (face grouping)',
  qualityCleanup: 'Cleanup',
  guestFullRes: 'Full-size guest downloads',
  branding: 'Gallery branding',
  guestFavourites: 'Guest favourites',
  watermark: 'Watermarks on new galleries',
  accessLog: 'Gallery access log',
};
const limitsOf = (plan: PaidPlanId) => (PLANS.find((p) => p.id === plan) as (typeof PLANS)[number]).limits;

interface ChangeContext {
  stripe: Stripe;
  owner: string;
  stored: StoredSubscription;
  sub: Stripe.Subscription;
  item: Stripe.SubscriptionItem;
  kind: PlanChangeKind;
  target: CurrentPrice;
  to: { plan: PaidPlanId; interval: BillingInterval };
  /** The live schedule with a change still to come (a downgrade or switch to monthly), or null. */
  scheduleId: string | null;
}

/** Loads and checks everything a change needs, or answers the request. */
async function loadChange(
  c: Ctx,
  to: { plan: PaidPlanId; interval: BillingInterval },
  /** POST /change: a finished schedule is released first. The preview changes nothing in Stripe. */
  apply = false,
): Promise<ChangeContext | Response> {
  const stripe = stripeClient(c.env);
  if (!stripe) return unavailable(c);
  const owner = ownerOf(c);
  const stored = await billingDb.subscription(c.env, owner);
  if (!keeping(stored)) return c.json(fail('conflict'), 409);
  const kind = changeKind({ plan: stored.plan, interval: stored.interval }, to);
  if (!kind) return c.json(fail('invalid'), 400);
  const target = priceFor(
    await billingDb.pricesCurrent(c.env),
    SUBSCRIPTION_LOOKUP_KEYS[to.plan][to.interval],
  );
  if (!target || target.stripePriceId.startsWith('price_seed_')) return unavailable(c);
  const sub = await stripe.subscriptions.retrieve(stored.stripeSubscriptionId, {
    expand: SUBSCRIPTION_EXPAND,
  });
  const item = sub.items.data[0];
  if (!item || sub.items.data.length !== 1 || !PLAN_KEEPING_STATUSES.includes(sub.status as never)) {
    return c.json(fail('conflict'), 409);
  }
  // An upgrade while a downgrade (or switch to monthly) is scheduled: the member undoes the scheduled change
  // first. Releasing it here and putting it back if the upgrade fails or waits for payment proved fragile
  // (docs/phase-7.md, Billing API › Change), so nothing is touched in Stripe.
  // A schedule whose last phase has started is a change that already happened, not a scheduled one.
  const state = scheduleStateOf(await scheduleOf(stripe, sub));
  if (state?.kind === 'pending' && kind === 'upgrade') {
    return c.json(fail('conflict', { reason: 'scheduled_change', scheduledAt: state.at }), 409);
  }
  if (state?.kind === 'finished' && apply) await releaseSchedule(stripe, state.id);
  const scheduleId = state?.kind === 'pending' ? idOf(sub.schedule) : null;
  return { stripe, owner, stored, sub, item, kind, target, to, scheduleId };
}

billingRoutes.post('/change/preview', async (c) => {
  const body = await readBody(c, planChangeSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const ctx = await loadChange(c, body);
    if (ctx instanceof Response) return ctx;
    const { stripe, stored, sub, item, kind, target, to } = ctx;
    const fromLimits = limitsOf(stored.plan);
    const toLimits = limitsOf(to.plan);
    let lines: { description: string; amount: number }[] = [];
    let dueNow: { amount: number; currency: string } | null = null;
    if (kind === 'upgrade') {
      const inv = await stripe.invoices.createPreview({
        customer: idOf(sub.customer) as string,
        subscription: sub.id,
        subscription_details: {
          items: [{ id: item.id, price: target.stripePriceId }],
          proration_behavior: 'always_invoice',
          proration_date: Math.floor(Date.now() / 1000),
        },
      });
      lines = inv.lines.data.map((l) => ({ description: l.description ?? '', amount: l.amount }));
      dueNow = { amount: inv.amount_due, currency: inv.currency };
    }
    let teammatesLosingAccess = 0;
    if (fromLimits.seats > 1 && toLimits.seats < fromLimits.seats) {
      const team = await rpc<Team | null>(c.env, 'team_get', { p_owner: ctx.owner });
      const active = (team?.members ?? []).filter((m) => m.role !== 'owner' && !m.suspended);
      teammatesLosingAccess = Math.max(0, active.length - (toLimits.seats - 1));
    }
    const status = await billingDb.status(c.env, ctx.owner);
    const out: PlanChangePreviewResult = {
      ok: true,
      kind,
      lines,
      dueNow,
      effectiveAt:
        kind === 'upgrade'
          ? new Date().toISOString()
          : new Date(item.current_period_end * 1000).toISOString(),
      effects: {
        storageGb: { from: fromLimits.storageGb, to: toLimits.storageGb },
        seats: { from: fromLimits.seats, to: toLimits.seats },
        lost: Object.entries(FEATURE_LABELS)
          .filter(
            ([k]) => fromLimits[k as keyof PlanLimits] === true && toLimits[k as keyof PlanLimits] === false,
          )
          .map(([, label]) => label as string)
          .concat(fromLimits.seats > 1 && toLimits.seats === 1 ? ['Team library'] : []),
        teammatesLosingAccess,
        overStorage: (status?.storage.usedBytes ?? 0) > toLimits.storageGb * 1024 ** 3,
      },
    };
    return c.json(out);
  } catch (err) {
    return upstream(c, 'billing_change_preview', err);
  }
});

billingRoutes.post('/change', async (c) => {
  const body = await readBody(c, planChangeSchema);
  if (!body) return c.json(fail('invalid'), 400);
  const requestId = c.get('requestId');
  try {
    const ctx = await loadChange(c, body, true);
    if (ctx instanceof Response) return ctx;
    const { stripe, owner, sub, item, kind, target, to, scheduleId } = ctx;
    const minute = Math.floor(Date.now() / 60_000);
    let actionUrl: string | null = null;
    const currentPrice = typeof item.price === 'string' ? item.price : item.price.id;
    if (kind === 'upgrade') {
      // loadChange refused an upgrade while a change is scheduled and released a finished schedule, so no
      // schedule manages this subscription.
      const updated = await stripe.subscriptions.update(
        sub.id,
        {
          items: [{ id: item.id, price: target.stripePriceId }],
          proration_behavior: 'always_invoice',
          // Nothing changes unless the proration is paid: an unpaid upgrade never unlocks the higher plan.
          payment_behavior: 'pending_if_incomplete',
          expand: ['latest_invoice'],
        },
        { idempotencyKey: `change:${owner}:${sub.id}:${target.lookupKey}:${minute}` },
      );
      if (updated.pending_update) {
        const inv = updated.latest_invoice;
        actionUrl = inv && typeof inv !== 'string' ? (inv.hosted_invoice_url ?? null) : null;
      }
    } else {
      await scheduleChange(stripe, sub, item, currentPrice, scheduleId, {
        price: target.stripePriceId,
        interval: to.interval,
        key: `change:${owner}:${sub.id}:${target.lookupKey}:${minute}`,
        scheduleKey: `schedule:${owner}:${sub.id}:${minute}`,
      });
    }
    await syncSubscription(c.env, stripe, sub.id, requestId, owner);
    const status = await statusResult(c);
    if (!status) return c.json(fail('server'), 500);
    return c.json({ ...status, actionUrl } satisfies PlanChangeResult);
  } catch (err) {
    return upstream(c, 'billing_change', err);
  }
});

/** Undo a scheduled downgrade (release the schedule; the subscription stays as it is). */
billingRoutes.delete('/change', async (c) => {
  const stripe = stripeClient(c.env);
  if (!stripe) return unavailable(c);
  const owner = ownerOf(c);
  try {
    const stored = await billingDb.subscription(c.env, owner);
    if (!keeping(stored)) return c.json(fail('conflict'), 409);
    const sub = await stripe.subscriptions.retrieve(stored.stripeSubscriptionId);
    const scheduleId = idOf(sub.schedule);
    if (!scheduleId) return c.json(fail('conflict'), 409);
    await releaseSchedule(stripe, scheduleId);
    await syncSubscription(c.env, stripe, sub.id, c.get('requestId'), owner);
    const status = await statusResult(c);
    return status ? c.json(status) : c.json(fail('server'), 500);
  } catch (err) {
    return upstream(c, 'billing_change_undo', err);
  }
});

// ---- public pricing (no session) --------------------------------------------------------------------------
export const pricingRoutes = new Hono<HonoEnv>();
pricingRoutes.get('/', async (c) => {
  try {
    const rows = await billingDb.pricesCurrent(c.env);
    const out: PublicPricingResult = {
      ok: true,
      prices: PAID_PLANS.flatMap((plan) =>
        (['month', 'year'] as const).flatMap((interval) => {
          const p = priceFor(rows, SUBSCRIPTION_LOOKUP_KEYS[plan][interval]);
          return p ? [{ plan, interval, amount: p.amount }] : [];
        }),
      ),
      packs: TOPUP_PACKS.flatMap((pack) => {
        const p = priceFor(rows, pack.lookupKey);
        return p?.active
          ? [{ lookupKey: pack.lookupKey as TopUpLookupKey, credits: pack.credits, amount: p.amount }]
          : [];
      }),
    };
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(out);
  } catch (err) {
    // Fail closed: the landing page keeps its build-time prices.
    logError(c.get('requestId'), 'public_pricing', err);
    return c.json(fail('server'), 503);
  }
});

// ---- Stripe webhook (no session, no Origin, raw body) ------------------------------------------------------
export const stripeWebhookRoutes = new Hono<HonoEnv>();
stripeWebhookRoutes.post('/webhook', handleWebhook);
