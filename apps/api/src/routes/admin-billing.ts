import {
  type AdminBillingResult,
  type AdminPricePreviewResult,
  adminLookupKeySchema,
  adminPackPatchSchema,
  adminPricePreviewSchema,
  adminPriceSchema,
  type StaffRole,
  SUBSCRIPTION_LOOKUP_KEYS,
  TOPUP_PACKS,
} from '@zephyr/shared';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { billingDb, type StopResult } from '../billing/db';
import { isMissing, isStripeError, type Stripe, stripeClient } from '../billing/stripe';
import { planOfPrice, syncSubscription } from '../billing/sync';
import { priceChangeOwnersEmail } from '../email/billing-templates';
import { sendEmail } from '../email/resend';
import { background, fail, logError, readBody } from '../http';
import { rpc, UpstreamError } from '../supabase';
import type { HonoEnv } from '../types';

type RequireStaff = (opts?: { allowEnrol?: boolean; write?: boolean }) => MiddlewareHandler<HonoEnv>;
type Ctx = Context<HonoEnv>;

/** Plans & billing: Owner, Admin and Finance may read; Owner and Finance may change prices and packs. */
export const BILLING_VIEWERS: ReadonlySet<StaffRole> = new Set(['owner', 'admin', 'finance']);
export const BILLING_EDITORS: ReadonlySet<StaffRole> = new Set(['owner', 'finance']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PACK_KEYS = new Set<string>(TOPUP_PACKS.map((p) => p.lookupKey));
const PLAN_OF_KEY = new Map<string, { plan: 'pro' | 'studio'; interval: 'month' | 'year' }>(
  (['pro', 'studio'] as const).flatMap((plan) =>
    (['month', 'year'] as const).map((interval) => [
      SUBSCRIPTION_LOOKUP_KEYS[plan][interval],
      { plan, interval },
    ]),
  ),
);

const role =
  (allowed: ReadonlySet<StaffRole>): MiddlewareHandler<HonoEnv> =>
  async (c, next) => {
    if (!allowed.has(c.get('staff').role)) return c.json(fail('forbidden'), 403);
    await next();
  };

async function overview(c: Ctx): Promise<AdminBillingResult> {
  const out = await rpc<Omit<AdminBillingResult, 'ok' | 'configured'> | null>(
    c.env,
    'admin_billing_overview',
    {
      p_actor: c.get('staff').id,
    },
  );
  // The role middleware already checked; null means the staff row changed in between.
  if (!out) throw new UpstreamError('admin_billing_overview', 403);
  return { ok: true, ...out, configured: Boolean(c.env.STRIPE_SECRET_KEY) };
}

function failed(c: Ctx, where: string, err: unknown) {
  logError(c.get('requestId'), where, err);
  if (isStripeError(err)) return c.json(fail('billing_unavailable'), 503);
  if (err instanceof UpstreamError && err.status === 400) return c.json(fail('invalid'), 400);
  return c.json(fail('server'), 500);
}

/** Emails every Owner (after the response). */
async function tellOwners(c: Ctx, mail: Parameters<typeof priceChangeOwnersEmail>[0]) {
  await background(c, async () => {
    try {
      const owners = await rpc<string[]>(c.env, 'ai_alert_recipients', { p_who: 'owners' });
      const m = priceChangeOwnersEmail(mail);
      for (const to of owners) await sendEmail(c.env, { to, ...m });
    } catch (err) {
      logError(c.get('requestId'), 'admin_billing_notify', err);
    }
  });
}
const actorOf = (c: Ctx) => c.get('staff').displayName?.trim() || c.get('staff').email;
const adminUrl = (c: Ctx) => `${(c.env.ADMIN_ORIGINS.split(',')[0] ?? '').trim()}/admin/billing`;

/** The Stripe product a lookup key's prices belong to (from its current price, or by key for seeded rows). */
async function productFor(
  stripe: Stripe,
  lookupKey: string,
  currentPriceId: string | null,
): Promise<string | null> {
  if (currentPriceId && !currentPriceId.startsWith('price_seed_')) {
    const p = await stripe.prices.retrieve(currentPriceId);
    return typeof p.product === 'string' ? p.product : p.product.id;
  }
  const found = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  const p = found.data[0];
  return p ? (typeof p.product === 'string' ? p.product : p.product.id) : null;
}

/** Puts a stopped move back on its old price (no proration), unless the subscription has moved on since. */
async function revertMove(
  stripe: Stripe,
  r: { moveId: string; stripeSubscriptionId: string; fromPriceId: string; toPriceId?: string },
): Promise<boolean> {
  try {
    const sub = await stripe.subscriptions.retrieve(r.stripeSubscriptionId);
    const item = sub.items.data[0];
    if (!item || sub.items.data.length !== 1) return false;
    const current = typeof item.price === 'string' ? item.price : item.price.id;
    if (current === r.fromPriceId) return true;
    if (r.toPriceId && current !== r.toPriceId) return false;
    // A plan change since the move (planOfPrice differs) is the member's own choice: leave it.
    await stripe.subscriptions.update(
      r.stripeSubscriptionId,
      { items: [{ id: item.id, price: r.fromPriceId }], proration_behavior: 'none' },
      { idempotencyKey: `revert:${r.moveId}` },
    );
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

/**
 * /admin/api/v1/billing/*: Admin › Plans & billing (docs/phase-7.md, Admin). A price rise or turning a pack on
 * needs a passkey sign-in in the last 10 minutes and emails every Owner; a cut or turning a pack off saves at
 * once. Every change is audited by its database function.
 */
export function registerAdminBillingRoutes(router: Hono<HonoEnv>, requireStaff: RequireStaff) {
  router.get('/v1/billing', requireStaff(), role(BILLING_VIEWERS), async (c) => {
    try {
      return c.json(await overview(c));
    } catch (err) {
      return failed(c, 'admin_billing_overview', err);
    }
  });

  router.post('/v1/billing/prices/preview', requireStaff(), role(BILLING_EDITORS), async (c) => {
    const body = await readBody(c, adminPricePreviewSchema);
    if (!body) return c.json(fail('invalid'), 400);
    try {
      const p = await rpc<Omit<AdminPricePreviewResult, 'ok'> | null>(c.env, 'admin_price_preview', {
        p_lookup_key: body.lookupKey,
        p_amount: body.amount,
      });
      if (!p) return c.json(fail('not_found'), 404);
      return c.json({ ok: true, ...p, raise: p.to > p.from } satisfies AdminPricePreviewResult);
    } catch (err) {
      return failed(c, 'admin_price_preview', err);
    }
  });

  router.post('/v1/billing/prices', requireStaff(), role(BILLING_EDITORS), async (c) => {
    const body = await readBody(c, adminPriceSchema);
    if (!body) return c.json(fail('invalid'), 400);
    const staff = c.get('staff');
    try {
      const current =
        (await billingDb.pricesCurrent(c.env)).find((p) => p.lookupKey === body.lookupKey) ?? null;
      if (!current) return c.json(fail('not_found'), 404);
      if (current.amount === body.amount) return c.json(fail('conflict'), 409);
      const raise = body.amount > current.amount;
      if (raise && !staff.recentPasskey) return c.json(fail('reauth_required'), 403);
      const stripe = stripeClient(c.env);
      if (!stripe) return c.json(fail('billing_unavailable'), 503);

      const product = await productFor(stripe, body.lookupKey, current.stripePriceId);
      // No product yet: scripts/stripe-setup.mjs hasn't been run for this mode.
      if (!product) return c.json(fail('billing_unavailable'), 503);
      const plan = PLAN_OF_KEY.get(body.lookupKey) ?? null;
      const pack = TOPUP_PACKS.find((p) => p.lookupKey === body.lookupKey) ?? null;
      const minute = Math.floor(Date.now() / 60_000);
      const price = await stripe.prices.create(
        {
          product,
          currency: 'usd',
          unit_amount: body.amount,
          lookup_key: body.lookupKey,
          transfer_lookup_key: true,
          tax_behavior: 'exclusive',
          ...(plan ? { recurring: { interval: plan.interval } } : {}),
          metadata: plan
            ? { plan: plan.plan, interval: plan.interval }
            : { credits: String(pack?.credits ?? '') },
        },
        { idempotencyKey: `price:${body.lookupKey}:${body.amount}:${staff.id}:${minute}` },
      );
      // Sanity: what Stripe created is the plan we meant (metadata round-trip).
      if (plan && planOfPrice(price)?.plan !== plan.plan) throw new Error('PriceMismatch');
      const out = await rpc<{ error?: string } | null>(c.env, 'admin_price_set', {
        p_staff: staff.id,
        p_lookup_key: body.lookupKey,
        p_stripe_price_id: price.id,
        p_amount: body.amount,
        p_reason: body.reason,
        p_seed: false,
      });
      if (out?.error)
        return c.json(
          fail(out.error === 'forbidden' ? 'forbidden' : 'invalid'),
          out.error === 'forbidden' ? 403 : 400,
        );
      if (raise) {
        await tellOwners(c, {
          kind: 'raise',
          actor: actorOf(c),
          lookupKey: body.lookupKey,
          from: current.amount,
          to: body.amount,
          reason: body.reason,
          adminUrl: adminUrl(c),
        });
      }
      return c.json(await overview(c));
    } catch (err) {
      return failed(c, 'admin_price_set', err);
    }
  });

  router.patch('/v1/billing/packs/:key', requireStaff(), role(BILLING_EDITORS), async (c) => {
    const key = adminLookupKeySchema.safeParse(c.req.param('key'));
    if (!key.success || !PACK_KEYS.has(key.data)) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminPackPatchSchema);
    if (!body) return c.json(fail('invalid'), 400);
    const staff = c.get('staff');
    if (body.active && !staff.recentPasskey) return c.json(fail('reauth_required'), 403);
    try {
      const out = await rpc<{ error?: string } | null>(c.env, 'admin_pack_set', {
        p_staff: staff.id,
        p_lookup_key: key.data,
        p_active: body.active,
      });
      if (out?.error)
        return c.json(
          fail(out.error === 'forbidden' ? 'forbidden' : 'invalid'),
          out.error === 'forbidden' ? 403 : 400,
        );
      if (body.active) {
        await tellOwners(c, {
          kind: 'pack_on',
          actor: actorOf(c),
          lookupKey: key.data,
          adminUrl: adminUrl(c),
        });
      }
      return c.json(await overview(c));
    } catch (err) {
      return failed(c, 'admin_pack_set', err);
    }
  });

  router.delete('/v1/billing/price-changes/:id', requireStaff(), role(BILLING_EDITORS), async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) return c.json(fail('not_found'), 404);
    const stripe = stripeClient(c.env);
    if (!stripe) return c.json(fail('billing_unavailable'), 503);
    const staff = c.get('staff');
    try {
      const out = await rpc<StopResult | null>(c.env, 'admin_price_change_stop', {
        p_staff: staff.id,
        p_id: id.toLowerCase(),
      });
      if (!out || out.error === 'not_found') return c.json(fail('not_found'), 404);
      if (out.error)
        return c.json(
          fail(out.error === 'forbidden' ? 'forbidden' : 'conflict'),
          out.error === 'forbidden' ? 403 : 409,
        );
      let unreverted = 0;
      for (const r of out.reverts ?? []) {
        try {
          if (await revertMove(stripe, r)) {
            await rpc(c.env, 'price_move_mark', { p_id: r.moveId, p_status: 'reverted' });
            await syncSubscription(c.env, stripe, r.stripeSubscriptionId, c.get('requestId')).catch((err) =>
              logError(c.get('requestId'), 'price_revert_sync', err),
            );
          } else unreverted += 1;
        } catch (err) {
          unreverted += 1;
          logError(c.get('requestId'), 'price_revert', err);
        }
      }
      if (unreverted) logError(c.get('requestId'), 'price_revert_incomplete', new Error(`${unreverted}`));
      await tellOwners(c, {
        kind: 'stopped',
        actor: actorOf(c),
        lookupKey: out.lookupKey ?? 'a price',
        adminUrl: adminUrl(c),
      });
      return c.json(await overview(c));
    } catch (err) {
      return failed(c, 'admin_price_change_stop', err);
    }
  });
}
