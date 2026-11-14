import { ADMIN_BILLING_API, BILLING_API, type StaffRole } from '@zephyr/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import setupScript from '../../../scripts/stripe-setup.mjs?raw';
import { app } from '../src/app';
import { runBillingCron } from '../src/billing/cron';
import type { CurrentPrice, DueMove, StoredSubscription } from '../src/billing/db';
import { cancelForDeletion, cancelForPurge, undoCancelForDeletion } from '../src/billing/deletion';
import { Stripe, setStripeFactory } from '../src/billing/stripe';
import { planOfPrice, snapshot } from '../src/billing/sync';
import { WEBHOOK_EVENTS } from '../src/billing/webhook';
import { changeKind } from '../src/routes/billing';
import {
  accessToken,
  billingLimiter,
  call,
  credential,
  env,
  initKeys,
  installFetch,
  type Jar,
  jar,
  LANDING,
  must,
  read,
  resetWorld,
  sbToken,
  type User,
  world,
} from './helpers';

const MEI: User = { id: '20000000-0000-0000-0000-000000000001', email: 'mei@example.com', passkeys: 1 };
const CUS = 'cus_Mei123';
const SUB = 'sub_Mei123';
const WHSEC = 'whsec_test_secret';
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

const PRICES: CurrentPrice[] = [
  {
    lookupKey: 'zephyr_pro_monthly',
    stripePriceId: 'price_pro_m2',
    amount: 999,
    plan: 'pro',
    interval: 'month',
    credits: null,
    active: true,
  },
  {
    lookupKey: 'zephyr_pro_yearly',
    stripePriceId: 'price_pro_y',
    amount: 9900,
    plan: 'pro',
    interval: 'year',
    credits: null,
    active: true,
  },
  {
    lookupKey: 'zephyr_studio_monthly',
    stripePriceId: 'price_studio_m',
    amount: 2499,
    plan: 'studio',
    interval: 'month',
    credits: null,
    active: true,
  },
  {
    lookupKey: 'zephyr_studio_yearly',
    stripePriceId: 'price_seed_studio_y',
    amount: 24900,
    plan: 'studio',
    interval: 'year',
    credits: null,
    active: true,
  },
  {
    lookupKey: 'zephyr_topup_500',
    stripePriceId: 'price_tu500',
    amount: 500,
    plan: null,
    interval: null,
    credits: 500,
    active: true,
  },
  {
    lookupKey: 'zephyr_topup_1000',
    stripePriceId: 'price_tu1000',
    amount: 1000,
    plan: null,
    interval: null,
    credits: 1000,
    active: true,
  },
  {
    lookupKey: 'zephyr_topup_2500',
    stripePriceId: 'price_tu2500',
    amount: 2500,
    plan: null,
    interval: null,
    credits: 2500,
    active: false,
  },
];
const STORED: StoredSubscription = {
  stripeSubscriptionId: SUB,
  stripeCustomerId: CUS,
  itemId: 'si_1',
  status: 'active',
  plan: 'pro',
  interval: 'month',
  stripePriceId: 'price_pro_m2',
  scheduleId: null,
  currentPeriodEnd: new Date((NOW + 20 * DAY) * 1000).toISOString(),
};

// ---- a fake Stripe ------------------------------------------------------------------------------------------
type Fn = ReturnType<typeof vi.fn>;
interface FakeStripe {
  customers: { create: Fn; retrieve: Fn; del: Fn };
  checkout: { sessions: { create: Fn; retrieve: Fn; expire: Fn; list: Fn } };
  subscriptions: { retrieve: Fn; update: Fn; cancel: Fn; list: Fn };
  invoicePayments: { list: Fn };
  refunds: { create: Fn };
  subscriptionSchedules: { create: Fn; retrieve: Fn; update: Fn; release: Fn };
  invoices: { createPreview: Fn };
  billingPortal: { sessions: { create: Fn } };
  prices: { retrieve: Fn; list: Fn; create: Fn };
}
let stripe: FakeStripe;

/** A Stripe list call: awaitable ({data}) and async-iterable (auto-pagination). */
function listOf<T>(items: T[]) {
  return Object.assign(Promise.resolve({ data: items, has_more: false }), {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  });
}

function price(id: string, plan: 'pro' | 'studio', interval: 'month' | 'year', lookup: string | null = null) {
  return { id, object: 'price', lookup_key: lookup, metadata: { plan, interval }, recurring: { interval } };
}
function subscription(
  o: Partial<{
    status: string;
    price: unknown;
    schedule: unknown;
    cancel: boolean;
    meta: Record<string, string>;
  }> = {},
) {
  return {
    id: SUB,
    object: 'subscription',
    customer: CUS,
    status: o.status ?? 'active',
    cancel_at_period_end: o.cancel ?? false,
    metadata: o.meta ?? { owner_id: MEI.id },
    schedule: o.schedule ?? null,
    pending_update: null,
    items: {
      data: [
        {
          id: 'si_1',
          price: o.price ?? price('price_pro_m2', 'pro', 'month', 'zephyr_pro_monthly'),
          current_period_start: NOW - 10 * DAY,
          current_period_end: NOW + 20 * DAY,
        },
      ],
    },
  };
}

beforeAll(initKeys);
beforeEach(() => {
  resetWorld();
  installFetch();
  env.STRIPE_SECRET_KEY = 'rk_test_123';
  env.STRIPE_WEBHOOK_SECRET = WHSEC;
  stripe = {
    customers: {
      create: vi.fn(async () => ({ id: CUS })),
      retrieve: vi.fn(async () => ({ id: CUS, email: MEI.email, metadata: { owner_id: MEI.id } })),
      del: vi.fn(async () => ({ id: CUS, deleted: true })),
    },
    checkout: {
      sessions: {
        create: vi.fn(async () => ({
          id: 'cs_test_abcdefghij123',
          url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
        })),
        retrieve: vi.fn(),
        expire: vi.fn(async (id: string) => ({ id, status: 'expired' })),
        list: vi.fn(async () => ({ data: [] })),
      },
    },
    subscriptions: {
      retrieve: vi.fn(async () => subscription()),
      update: vi.fn(async () => subscription()),
      cancel: vi.fn(async () => ({})),
      list: vi.fn(() => listOf([])),
    },
    invoicePayments: { list: vi.fn(async () => ({ data: [] })) },
    refunds: { create: vi.fn(async () => ({ id: 're_1' })) },
    subscriptionSchedules: {
      create: vi.fn(async () => ({
        id: 'sub_sched_1',
        status: 'active',
        current_phase: { start_date: NOW - 10 * DAY },
        phases: [],
      })),
      retrieve: vi.fn(),
      update: vi.fn(async () => ({})),
      release: vi.fn(async () => ({})),
    },
    invoices: {
      createPreview: vi.fn(async () => ({
        amount_due: 954,
        currency: 'usd',
        lines: {
          data: [
            { description: 'Remaining time on Studio', amount: 1620 },
            { description: 'Unused time on Pro', amount: -666 },
          ],
        },
      })),
    },
    billingPortal: {
      sessions: { create: vi.fn(async () => ({ url: 'https://billing.stripe.com/p/session/x' })) },
    },
    prices: {
      retrieve: vi.fn(async () => ({ id: 'price_pro_m2', product: 'prod_pro' })),
      list: vi.fn(async () => ({ data: [] })),
      create: vi.fn(
        async (p: {
          lookup_key: string;
          recurring?: { interval: string };
          metadata: Record<string, string>;
        }) => ({
          id: 'price_new',
          lookup_key: p.lookup_key,
          recurring: p.recurring ?? null,
          metadata: p.metadata,
        }),
      ),
    },
  };
  setStripeFactory(() => stripe as unknown as Stripe);
  world.rpc.billing_prices_current = () => PRICES;
  world.rpc.billing_customer_get = (a) => (a.p_owner === MEI.id ? CUS : null);
  world.rpc.billing_customer_set = (a) => a.p_customer;
  world.rpc.billing_checkout_open = () => [];
  world.rpc.billing_checkout_poll = () => true;
  world.rpc.billing_topup_refund_by_session = () => null;
  world.rpc.billing_past_due_expire = () => [];
  world.rpc.billing_deletion_cancels_due = () => [];
  world.rpc.price_move_reverts_due = () => ({ failed: 0, reverts: [] });
  world.rpc.price_move_claim = (a) => ({ id: a.p_id });
  world.rpc.billing_subscription = () => null;
  world.rpc.billing_checkout_record = () => null;
  world.rpc.billing_checkout_mark = () => null;
  world.rpc.billing_event_begin = () => 'new';
  world.rpc.billing_event_finish = () => null;
  world.rpc.billing_apply = () => ({ planBefore: 'free', planAfter: 'pro' });
  world.rpc.billing_topup_grant = () => ({ credits: 500, granted: true });
  world.rpc.billing_topup_refund = () => null;
  world.rpc.billing_status = () => ({
    plan: 'pro',
    subscription: null,
    state: 'active',
    storage: { usedBytes: 300 * 1024 ** 3, limitBytes: 250 * 1024 ** 3 },
    packs: [],
    hasCustomer: true,
  });
});
afterEach(() => {
  setStripeFactory(null);
  delete env.STRIPE_SECRET_KEY;
  delete env.STRIPE_WEBHOOK_SECRET;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rpcArgs = (fn: string) =>
  world.calls.filter((c) => c.url.endsWith(`/rpc/${fn}`)).map((c) => c.body as Record<string, unknown>);
async function signedIn(u: User = MEI): Promise<Jar> {
  const j = jar();
  j.cookies.set('__Host-zs-at', await sbToken({ sub: u.id, email: u.email }));
  return j;
}

// ---- webhook ------------------------------------------------------------------------------------------------
function stripeEvent(type: string, object: unknown, id = `evt_${crypto.randomUUID().slice(0, 8)}`) {
  return JSON.stringify({
    id,
    object: 'event',
    type,
    created: NOW,
    api_version: Stripe.API_VERSION,
    data: { object },
  });
}
async function deliver(
  payload: string,
  o: { secret?: string; timestamp?: number; signature?: string | null } = {},
) {
  const sig =
    o.signature === undefined
      ? await Stripe.webhooks.generateTestHeaderStringAsync({
          payload,
          secret: o.secret ?? WHSEC,
          ...(o.timestamp ? { timestamp: o.timestamp } : {}),
          cryptoProvider: Stripe.createSubtleCryptoProvider(),
        })
      : o.signature;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sig) headers['Stripe-Signature'] = sig;
  return app.request(
    `https://zephyrapp.midnightpoetry.studio${BILLING_API.webhook}`,
    { method: 'POST', headers, body: payload },
    env,
  );
}

describe('Stripe webhook', () => {
  it('needs a valid, fresh signature from our endpoint secret', async () => {
    const payload = stripeEvent('customer.subscription.updated', { id: SUB });
    expect((await deliver(payload, { signature: null })).status).toBe(400);
    expect((await deliver(payload, { secret: 'whsec_other' })).status).toBe(400);
    expect((await deliver(payload, { timestamp: NOW - 600 })).status).toBe(400);
    expect(rpcArgs('billing_event_begin')).toHaveLength(0);
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('is unavailable until configured, and refuses oversized bodies before reading', async () => {
    delete env.STRIPE_WEBHOOK_SECRET;
    expect((await deliver(stripeEvent('invoice.paid', {}))).status).toBe(503);
    env.STRIPE_WEBHOOK_SECRET = WHSEC;
    const big = stripeEvent('invoice.paid', { pad: 'x'.repeat(600 * 1024) });
    expect((await deliver(big)).status).toBe(413);
  });

  it('re-reads the subscription and applies what Stripe says now, not the event payload', async () => {
    // The event carries an old state; the re-read says active on Studio.
    stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({ price: price('price_studio_m', 'studio', 'month') }),
    );
    const before = Date.now();
    const res = await deliver(
      stripeEvent('customer.subscription.updated', { id: SUB, status: 'past_due' }, 'evt_1'),
    );
    expect(res.status).toBe(200);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith(SUB, {
      expand: ['items.data.price', 'schedule.phases.items.price'],
    });
    const [apply] = rpcArgs('billing_apply');
    expect(apply).toMatchObject({
      p_owner: MEI.id,
      p_sub: {
        stripe_subscription_id: SUB,
        status: 'active',
        plan_id: 'studio',
        interval: 'month',
        item_id: 'si_1',
      },
    });
    expect(new Date(String(apply?.p_synced_at)).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(rpcArgs('billing_event_finish')).toEqual([
      { p_id: 'evt_1', p_status: 'processed', p_error: null, p_owner: MEI.id },
    ]);
  });

  it('applies out-of-order events by re-reading each time (the database keeps the newest read)', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue(subscription({ status: 'active' }));
    await deliver(
      stripeEvent('invoice.paid', { parent: { subscription_details: { subscription: SUB } } }, 'evt_b'),
    );
    await deliver(stripeEvent('customer.subscription.created', { id: SUB, status: 'incomplete' }, 'evt_a'));
    const applies = rpcArgs('billing_apply');
    expect(applies.map((a) => (a.p_sub as { status: string }).status)).toEqual(['active', 'active']);
    expect(new Date(String(applies[1]?.p_synced_at)) >= new Date(String(applies[0]?.p_synced_at))).toBe(true);
  });

  it('answers a duplicate without doing the work again', async () => {
    world.rpc.billing_event_begin = () => 'done';
    const res = await deliver(stripeEvent('customer.subscription.updated', { id: SUB }));
    expect(res.status).toBe(200);
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(rpcArgs('billing_apply')).toHaveLength(0);
  });

  it('never applies a subscription whose owner disagrees with its customer', async () => {
    world.rpc.billing_customer_get = () => 'cus_someone_else';
    const res = await deliver(stripeEvent('customer.subscription.updated', { id: SUB }, 'evt_x'));
    expect(res.status).toBe(200);
    expect(rpcArgs('billing_apply')).toHaveLength(0);
    expect(rpcArgs('billing_event_finish')[0]).toMatchObject({
      p_status: 'failed',
      p_error: 'owner_mismatch',
    });
  });

  it('asks Stripe to retry when applying fails', async () => {
    world.rpc.billing_apply = () => new Response('{}', { status: 500 });
    const res = await deliver(stripeEvent('customer.subscription.updated', { id: SUB }));
    expect(res.status).toBe(500);
    expect(rpcArgs('billing_event_finish')[0]).toMatchObject({ p_status: 'failed' });
  });

  it('grants a paid top-up once, by our lookup key', async () => {
    const session = {
      id: 'cs_test_topup123456',
      object: 'checkout.session',
      mode: 'payment',
      status: 'complete',
      payment_status: 'paid',
      customer: CUS,
      client_reference_id: MEI.id,
      payment_intent: 'pi_1',
      metadata: { owner_id: MEI.id, kind: 'topup', lookup_key: 'zephyr_topup_1000' },
    };
    expect((await deliver(stripeEvent('checkout.session.completed', session))).status).toBe(200);
    expect(rpcArgs('billing_topup_grant')).toEqual([
      {
        p_owner: MEI.id,
        p_session: 'cs_test_topup123456',
        p_payment_intent: 'pi_1',
        p_lookup_key: 'zephyr_topup_1000',
      },
    ]);
    // Not paid yet (delayed method): nothing granted.
    await deliver(stripeEvent('checkout.session.completed', { ...session, payment_status: 'unpaid' }));
    expect(rpcArgs('billing_topup_grant')).toHaveLength(1);
  });

  it('removes a refunded top-up and ignores events it does not handle', async () => {
    await deliver(
      stripeEvent('charge.refunded', {
        id: 'ch_1',
        object: 'charge',
        payment_intent: 'pi_9',
        amount: 1000,
        amount_refunded: 250,
      }),
    );
    // The charge's refunded total so far and its amount: credits come off in proportion.
    expect(rpcArgs('billing_topup_refund')).toEqual([
      { p_payment_intent: 'pi_9', p_refunded: 250, p_amount: 1000 },
    ]);
    await deliver(stripeEvent('customer.created', { id: CUS }, 'evt_ign'));
    expect(rpcArgs('billing_event_finish').at(-1)).toMatchObject({ p_id: 'evt_ign', p_status: 'ignored' });
  });

  it('finds a refunded top-up by its Checkout session when the payment intent wasn’t recorded', async () => {
    stripe.checkout.sessions.list.mockResolvedValue({
      data: [{ id: 'cs_test_topup123456', mode: 'payment' }],
    });
    world.rpc.billing_topup_refund_by_session = () => ({ ownerId: MEI.id, removed: 400 });
    await deliver(
      stripeEvent('charge.dispute.created', { id: 'dp_1', object: 'dispute', payment_intent: 'pi_7' }),
    );
    expect(stripe.checkout.sessions.list).toHaveBeenCalledWith({ payment_intent: 'pi_7', limit: 1 });
    // A dispute counts as a full refund.
    expect(rpcArgs('billing_topup_refund_by_session')).toEqual([
      { p_session: 'cs_test_topup123456', p_refunded: null, p_amount: null },
    ]);
    expect(rpcArgs('billing_event_finish').at(-1)).toMatchObject({ p_status: 'processed', p_owner: MEI.id });
  });

  it('cancels and refunds a second live subscription instead of tracking two', async () => {
    const SUB2 = 'sub_Second2';
    world.rpc.billing_apply = (a) =>
      (a.p_sub as { stripe_subscription_id: string }).stripe_subscription_id === SUB2
        ? { applied: false, duplicate: true, storedSubscriptionId: SUB, planBefore: 'pro', planAfter: 'pro' }
        : { applied: true, planBefore: 'pro', planAfter: 'pro' };
    stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({
      ...subscription(),
      id,
      latest_invoice: id === SUB2 ? 'in_2' : 'in_1',
    }));
    stripe.invoicePayments.list.mockResolvedValue({
      data: [
        { id: 'inpay_1', status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_dup' } },
      ],
    });
    const res = await deliver(stripeEvent('customer.subscription.created', { id: SUB2 }));
    expect(res.status).toBe(200);
    // Flagged first, refunded, then canceled: a retry after a failed refund still finds a live duplicate.
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      SUB2,
      { metadata: { zephyr_duplicate: '1' } },
      { idempotencyKey: `dup-flag:${SUB2}` },
    );
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith(
      SUB2,
      { prorate: false, invoice_now: false },
      { idempotencyKey: `dup-cancel:${SUB2}` },
    );
    expect(stripe.refunds.create.mock.invocationCallOrder[0]).toBeLessThan(
      stripe.subscriptions.cancel.mock.invocationCallOrder[0] as number,
    );
    expect(stripe.invoicePayments.list).toHaveBeenCalledWith({ invoice: 'in_2', status: 'paid', limit: 10 });
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_dup', reason: 'duplicate', metadata: { zephyr: 'duplicate_subscription' } },
      { idempotencyKey: 'dup-refund:pi_dup' },
    );
    expect(world.emails).toHaveLength(0);
  });

  it('lets the newer subscription take over when the stored one has in fact ended', async () => {
    const SUB2 = 'sub_Second2';
    let calls = 0;
    world.rpc.billing_apply = (a) => {
      calls += 1;
      const id = (a.p_sub as { stripe_subscription_id: string }).stripe_subscription_id;
      return id === SUB2 && calls === 1
        ? { applied: false, duplicate: true, storedSubscriptionId: SUB, planBefore: 'pro', planAfter: 'pro' }
        : { applied: true, planBefore: 'pro', planAfter: 'pro' };
    };
    stripe.subscriptions.retrieve.mockImplementation(async (id: string) =>
      id === SUB ? { ...subscription({ status: 'canceled' }), id } : { ...subscription(), id },
    );
    await deliver(stripeEvent('customer.subscription.created', { id: SUB2 }));
    const applied = rpcArgs('billing_apply').map(
      (a) => (a.p_sub as { stripe_subscription_id: string }).stripe_subscription_id,
    );
    expect(applied).toEqual([SUB2, SUB, SUB2]);
    // The newer subscription is stored with the time it was read, not a later one.
    const at = rpcArgs('billing_apply').map((a) => a.p_synced_at);
    expect(at[2]).toBe(at[0]);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it('finishes a flagged duplicate’s refund when an earlier try failed after the cancel', async () => {
    const SUB2 = 'sub_Second2';
    world.rpc.billing_apply = () => ({
      applied: false,
      ignored: 'older_subscription',
      planBefore: 'pro',
      planAfter: 'pro',
    });
    stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({
      ...subscription({ status: 'canceled', meta: { owner_id: MEI.id, zephyr_duplicate: '1' } }),
      id,
      latest_invoice: 'in_2',
    }));
    stripe.invoicePayments.list.mockResolvedValue({
      data: [
        { id: 'inpay_1', status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_dup' } },
      ],
    });
    const res = await deliver(stripeEvent('customer.subscription.deleted', { id: SUB2 }));
    expect(res.status).toBe(200);
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_dup' }),
      {
        idempotencyKey: 'dup-refund:pi_dup',
      },
    );
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    // A refund made earlier (past Stripe's 24 h key window) is done, not an error to retry forever.
    stripe.refunds.create.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        message: 'already refunded',
        type: 'invalid_request_error',
        code: 'charge_already_refunded',
      }),
    );
    expect((await deliver(stripeEvent('customer.subscription.updated', { id: SUB2 }))).status).toBe(200);
    // An unflagged ended subscription is just ignored: nothing refunded.
    stripe.refunds.create.mockClear();
    stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({
      ...subscription({ status: 'canceled' }),
      id,
    }));
    await deliver(stripeEvent('customer.subscription.updated', { id: SUB2 }));
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it('marks a Checkout that bought a duplicate as refunded, never done', async () => {
    world.rpc.billing_apply = () => ({
      applied: false,
      duplicate: true,
      storedSubscriptionId: SUB,
      planBefore: 'pro',
      planAfter: 'pro',
    });
    stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({ ...subscription(), id }));
    await deliver(
      stripeEvent('checkout.session.completed', {
        id: 'cs_test_dupdupdup12345',
        object: 'checkout.session',
        mode: 'subscription',
        status: 'complete',
        customer: CUS,
        subscription: 'sub_Second2',
        client_reference_id: MEI.id,
        metadata: { owner_id: MEI.id },
      }),
    );
    expect(rpcArgs('billing_checkout_mark')).toEqual([
      { p_session: 'cs_test_dupdupdup12345', p_state: 'refunded' },
    ]);
  });

  it('puts a noted downgrade back on a schedule when a pending upgrade expires unpaid', async () => {
    const noted = {
      owner_id: MEI.id,
      zephyr_pending_downgrade: 'pro:year',
      zephyr_pending_downgrade_price: 'price_pro_y',
    };
    stripe.subscriptions.retrieve.mockResolvedValue(subscription({ meta: noted }));
    const res = await deliver(
      stripeEvent('customer.subscription.pending_update_expired', { id: SUB }, 'evt_expired1'),
    );
    expect(res.status).toBe(200);
    expect(stripe.subscriptionSchedules.create).toHaveBeenCalledWith(
      { from_subscription: SUB },
      { idempotencyKey: `restore-schedule:${SUB}:evt_expired1` },
    );
    expect(stripe.subscriptionSchedules.update.mock.calls[0]?.[1]).toMatchObject({
      phases: [
        { items: [{ price: 'price_pro_m2', quantity: 1 }], end_date: NOW + 20 * DAY },
        { items: [{ price: 'price_pro_y', quantity: 1 }], duration: { interval: 'year', interval_count: 1 } },
      ],
    });
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      SUB,
      { metadata: { zephyr_pending_downgrade: '', zephyr_pending_downgrade_price: '' } },
      { idempotencyKey: `pending-clear:${SUB}:evt_expired1` },
    );
  });

  it('only clears the note when a pending upgrade is paid (no schedule to override it)', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({
        meta: {
          owner_id: MEI.id,
          zephyr_pending_downgrade: 'pro:year',
          zephyr_pending_downgrade_price: 'price_pro_y',
        },
      }),
    );
    await deliver(stripeEvent('customer.subscription.pending_update_applied', { id: SUB }, 'evt_applied1'));
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      SUB,
      { metadata: { zephyr_pending_downgrade: '', zephyr_pending_downgrade_price: '' } },
      { idempotencyKey: `pending-clear:${SUB}:evt_applied1` },
    );
    // No note: nothing to do.
    stripe.subscriptions.update.mockClear();
    stripe.subscriptions.retrieve.mockResolvedValue(subscription());
    await deliver(stripeEvent('customer.subscription.pending_update_expired', { id: SUB }));
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('stops reading a body without Content-Length once it passes 512 KB', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        sent += 1;
        if (sent > 100) ctrl.close();
        else ctrl.enqueue(chunk);
      },
    });
    const res = await app.request(
      `https://zephyrapp.midnightpoetry.studio${BILLING_API.webhook}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=x' },
        body,
        duplex: 'half',
      } as RequestInit,
      env,
    );
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(20);
    expect(rpcArgs('billing_event_begin')).toHaveLength(0);
  });

  it('emails the owner when a paid plan ends', async () => {
    world.rpc.billing_apply = () => ({ planBefore: 'pro', planAfter: 'free', email: MEI.email });
    stripe.subscriptions.retrieve.mockResolvedValue(subscription({ status: 'canceled' }));
    await deliver(stripeEvent('customer.subscription.deleted', { id: SUB }));
    expect(world.emails.map((e) => e.subject)).toEqual(['Your Zephyr plan has ended']);
  });
});

describe('stripe-setup.mjs', () => {
  it('registers exactly the events the webhook handles, and never prints the key or secret', () => {
    const block = setupScript.slice(
      setupScript.indexOf('const WEBHOOK_EVENTS = ['),
      setupScript.indexOf('];', setupScript.indexOf('const WEBHOOK_EVENTS = [')),
    );
    const listed = [...block.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...WEBHOOK_EVENTS].sort());
    expect(listed).toContain('customer.subscription.pending_update_expired');
    expect(listed).toContain('customer.subscription.pending_update_applied');
    expect(setupScript).not.toMatch(/(log|console\.\w+)\([^)]*\b(KEY|created\.secret)\b[^)]*\)/);
  });
});

describe('mapping', () => {
  it('reads plan and interval from price metadata, falling back to the lookup key', () => {
    expect(planOfPrice(price('p', 'studio', 'year') as never)).toEqual({ plan: 'studio', interval: 'year' });
    expect(
      planOfPrice({
        id: 'p',
        lookup_key: 'zephyr_pro_yearly',
        metadata: {},
        recurring: { interval: 'year' },
      } as never),
    ).toEqual({
      plan: 'pro',
      interval: 'year',
    });
    expect(planOfPrice({ id: 'p', lookup_key: null, metadata: {}, recurring: null } as never)).toBeNull();
  });

  it('records a scheduled downgrade from the next phase', () => {
    const s = snapshot(
      subscription({
        schedule: {
          id: 'sub_sched_1',
          status: 'active',
          phases: [
            { start_date: NOW - 10 * DAY, items: [{ price: price('price_studio_m', 'studio', 'month') }] },
            { start_date: NOW + 20 * DAY, items: [{ price: price('price_pro_m2', 'pro', 'month') }] },
          ],
        },
      }) as never,
    );
    expect(s).toMatchObject({
      schedule_id: 'sub_sched_1',
      scheduled_plan: 'pro',
      scheduled_interval: 'month',
    });
    expect(s.scheduled_at).toBe(new Date((NOW + 20 * DAY) * 1000).toISOString());
  });

  it('classifies plan changes', () => {
    expect(changeKind({ plan: 'pro', interval: 'month' }, { plan: 'studio', interval: 'month' })).toBe(
      'upgrade',
    );
    expect(changeKind({ plan: 'pro', interval: 'month' }, { plan: 'pro', interval: 'year' })).toBe('upgrade');
    expect(changeKind({ plan: 'studio', interval: 'year' }, { plan: 'pro', interval: 'year' })).toBe(
      'downgrade',
    );
    expect(changeKind({ plan: 'pro', interval: 'year' }, { plan: 'pro', interval: 'month' })).toBe(
      'downgrade',
    );
    expect(changeKind({ plan: 'pro', interval: 'year' }, { plan: 'studio', interval: 'month' })).toBe(
      'upgrade',
    );
    expect(changeKind({ plan: 'pro', interval: 'month' }, { plan: 'pro', interval: 'month' })).toBeNull();
  });
});

// ---- checkout -----------------------------------------------------------------------------------------------
describe('checkout', () => {
  it('needs a member session and a JSON body from the app', async () => {
    expect(
      (await call(BILLING_API.checkout, { body: { kind: 'topup', pack: 'zephyr_topup_500' } })).status,
    ).toBe(401);
    const j = await signedIn();
    expect(
      (
        await call(BILLING_API.checkout, {
          jar: j,
          body: { kind: 'topup', pack: 'zephyr_topup_500' },
          origin: 'https://evil.test',
        })
      ).status,
    ).toBe(403);
  });

  it('opens a Managed Payments Checkout at our price, with our owner id', async () => {
    world.rpc.billing_customer_get = () => null;
    const j = await signedIn();
    const res = await call(BILLING_API.checkout, {
      jar: j,
      body: { kind: 'subscription', plan: 'pro', interval: 'month' },
    });
    expect(res.status).toBe(201);
    expect(await read(res)).toEqual({ ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test_abc' });
    expect(stripe.customers.create).toHaveBeenCalledWith(
      { email: MEI.email, metadata: { owner_id: MEI.id } },
      { idempotencyKey: `customer:${MEI.id}` },
    );
    expect(rpcArgs('billing_customer_set')).toEqual([{ p_owner: MEI.id, p_customer: CUS }]);
    const [params, opts] = stripe.checkout.sessions.create.mock.calls[0] as [
      Record<string, unknown>,
      { idempotencyKey: string },
    ];
    expect(params).toMatchObject({
      mode: 'subscription',
      managed_payments: { enabled: true },
      customer: CUS,
      line_items: [{ price: 'price_pro_m2', quantity: 1 }],
      client_reference_id: MEI.id,
      metadata: { owner_id: MEI.id, kind: 'subscription', lookup_key: 'zephyr_pro_monthly' },
      subscription_data: { metadata: { owner_id: MEI.id } },
      success_url: 'https://zephyrapp.midnightpoetry.studio/billing/return?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://zephyrapp.midnightpoetry.studio/settings/billing',
    });
    expect(Number(params.expires_at)).toBeGreaterThanOrEqual(NOW + 30 * 60);
    expect(opts.idempotencyKey).toMatch(
      new RegExp(`^checkout:${MEI.id}:subscription:zephyr_pro_monthly:\\d+$`),
    );
    expect(rpcArgs('billing_checkout_record')).toEqual([
      {
        p_owner: MEI.id,
        p_session: 'cs_test_abcdefghij123',
        p_kind: 'subscription',
        p_lookup_key: 'zephyr_pro_monthly',
        p_idem: opts.idempotencyKey,
      },
    ]);
    expect(billingLimiter.keys).toEqual([`billing:${MEI.id}`]);
  });

  it('expires the member’s other open subscription Checkouts first (two tabs can’t buy two plans)', async () => {
    world.rpc.billing_checkout_open = (a) => {
      expect(a).toMatchObject({ p_owner: MEI.id, p_kind: 'subscription' });
      expect(String(a.p_idem)).toMatch(/^checkout:/);
      return ['cs_test_othertab00001'];
    };
    const marks: unknown[] = [];
    world.rpc.billing_checkout_mark = (a) => {
      marks.push(a);
      return null;
    };
    const j = await signedIn();
    const res = await call(BILLING_API.checkout, {
      jar: j,
      body: { kind: 'subscription', plan: 'studio', interval: 'month' },
    });
    expect(res.status).toBe(201);
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      'cs_test_othertab00001',
      {},
      { idempotencyKey: 'expire:cs_test_othertab00001' },
    );
    expect(marks).toEqual([{ p_session: 'cs_test_othertab00001', p_state: 'failed' }]);

    // The other tab was already paid: apply it and refuse a second plan.
    stripe.checkout.sessions.expire.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({ message: 'not open', type: 'invalid_request_error' }),
    );
    stripe.checkout.sessions.retrieve.mockResolvedValueOnce({
      id: 'cs_test_othertab00001',
      mode: 'subscription',
      status: 'complete',
      customer: CUS,
      client_reference_id: MEI.id,
      subscription: SUB,
      metadata: { owner_id: MEI.id },
    });
    const created = stripe.checkout.sessions.create.mock.calls.length;
    const again = await call(BILLING_API.checkout, {
      jar: j,
      body: { kind: 'subscription', plan: 'studio', interval: 'month' },
    });
    expect(again.status).toBe(409);
    expect(rpcArgs('billing_apply')).toHaveLength(1);
    expect(stripe.checkout.sessions.create.mock.calls.length).toBe(created);
  });

  it('never opens Checkout on a customer we didn’t store', async () => {
    world.rpc.billing_customer_get = () => null;
    world.rpc.billing_customer_set = () => null; // that customer id belongs to someone else
    const j = await signedIn();
    const res = await call(BILLING_API.checkout, {
      jar: j,
      body: { kind: 'topup', pack: 'zephyr_topup_500' },
    });
    expect(res.status).toBe(409);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('refuses a second subscription, unknown prices, packs off sale, and works only when configured', async () => {
    const j = await signedIn();
    world.rpc.billing_subscription = () => STORED;
    expect(
      (
        await call(BILLING_API.checkout, {
          jar: j,
          body: { kind: 'subscription', plan: 'studio', interval: 'month' },
        })
      ).status,
    ).toBe(409);
    world.rpc.billing_subscription = () => ({ ...STORED, status: 'canceled' });
    // Seeded placeholder (stripe-setup.mjs not run): nothing to sell yet.
    expect(
      (
        await call(BILLING_API.checkout, {
          jar: j,
          body: { kind: 'subscription', plan: 'studio', interval: 'year' },
        })
      ).status,
    ).toBe(503);
    expect(
      (await call(BILLING_API.checkout, { jar: j, body: { kind: 'topup', pack: 'zephyr_topup_2500' } }))
        .status,
    ).toBe(404);
    expect(
      (
        await call(BILLING_API.checkout, {
          jar: j,
          body: { kind: 'topup', pack: 'zephyr_topup_500', price: 'price_x' },
        })
      ).status,
    ).toBe(400);
    const top = await call(BILLING_API.checkout, {
      jar: j,
      body: { kind: 'topup', pack: 'zephyr_topup_500' },
    });
    expect(top.status).toBe(201);
    expect(stripe.checkout.sessions.create.mock.calls.at(-1)?.[0]).toMatchObject({
      mode: 'payment',
      payment_intent_data: { metadata: { owner_id: MEI.id, kind: 'topup', lookup_key: 'zephyr_topup_500' } },
    });
    delete env.STRIPE_SECRET_KEY;
    const off = await call(BILLING_API.checkout, {
      jar: j,
      body: { kind: 'topup', pack: 'zephyr_topup_500' },
    });
    expect(off.status).toBe(503);
    expect(await read(off)).toMatchObject({ error: 'billing_unavailable' });
  });

  it('applies a slow webhook itself when the return page has waited 10 seconds', async () => {
    let state: 'pending' | 'done' = 'pending';
    world.rpc.billing_checkout_status = () => ({
      state,
      kind: 'subscription',
      plan: 'pro',
      createdAt: new Date(Date.now() - 15_000).toISOString(),
    });
    world.rpc.billing_checkout_mark = (a) => {
      state = a.p_state as 'done';
      return null;
    };
    stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_test_abcdefghij123',
      mode: 'subscription',
      status: 'complete',
      customer: CUS,
      client_reference_id: MEI.id,
      subscription: SUB,
      metadata: { owner_id: MEI.id },
    });
    const j = await signedIn();
    const res = await call(BILLING_API.checkoutStatus('cs_test_abcdefghij123'), { jar: j });
    expect(await read(res)).toEqual({ ok: true, state: 'done', kind: 'subscription', plan: 'pro' });
    expect(rpcArgs('billing_apply')).toHaveLength(1);
    expect((await call(BILLING_API.checkoutStatus('cs_live_../x'), { jar: j })).status).toBe(404);
  });

  it('asks Stripe itself at most once per 10 seconds per session', async () => {
    world.rpc.billing_checkout_status = () => ({
      state: 'pending',
      kind: 'subscription',
      createdAt: new Date(Date.now() - 15_000).toISOString(),
    });
    world.rpc.billing_checkout_poll = () => false;
    const j = await signedIn();
    const res = await call(BILLING_API.checkoutStatus('cs_test_abcdefghij123'), { jar: j });
    expect(await read(res)).toEqual({ ok: true, state: 'pending', kind: 'subscription' });
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(rpcArgs('billing_checkout_poll')).toEqual([
      { p_owner: MEI.id, p_session: 'cs_test_abcdefghij123' },
    ]);
  });

  it('opens the customer portal only for an existing customer', async () => {
    const j = await signedIn();
    const res = await call(BILLING_API.portal, { jar: j, body: {} });
    expect(res.status).toBe(201);
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      { customer: CUS, return_url: 'https://zephyrapp.midnightpoetry.studio/settings/billing' },
      { idempotencyKey: expect.stringMatching(new RegExp(`^portal:${MEI.id}:\\d+$`)) },
    );
    world.rpc.billing_customer_get = () => null;
    expect((await call(BILLING_API.portal, { jar: j, body: {} })).status).toBe(409);
  });
});

// ---- plan changes -------------------------------------------------------------------------------------------
describe('plan changes', () => {
  beforeEach(() => {
    world.rpc.billing_subscription = () => STORED;
    world.rpc.team_get = () => ({ members: [] });
  });

  it('previews an upgrade with Stripe’s proration lines', async () => {
    const j = await signedIn();
    const res = await call(BILLING_API.changePreview, {
      jar: j,
      body: { plan: 'studio', interval: 'month' },
    });
    const out = await read(res);
    expect(out).toMatchObject({
      kind: 'upgrade',
      dueNow: { amount: 954, currency: 'usd' },
      lines: [{ amount: 1620 }, { amount: -666 }],
      effects: { storageGb: { from: 250, to: 1000 }, seats: { from: 1, to: 3 }, lost: [] },
    });
    expect(stripe.invoices.createPreview.mock.calls[0]?.[0]).toMatchObject({
      customer: CUS,
      subscription: SUB,
      subscription_details: {
        items: [{ id: 'si_1', price: 'price_studio_m' }],
        proration_behavior: 'always_invoice',
      },
    });
  });

  it('previews a downgrade from Studio: teammates and storage', async () => {
    world.rpc.billing_subscription = () => ({ ...STORED, plan: 'studio', stripePriceId: 'price_studio_m' });
    world.rpc.team_get = () => ({
      members: [
        { role: 'owner', suspended: false },
        { role: 'editor', suspended: false },
        { role: 'viewer', suspended: false },
      ],
    });
    const j = await signedIn();
    const out = await read(
      await call(BILLING_API.changePreview, { jar: j, body: { plan: 'pro', interval: 'month' } }),
    );
    expect(out).toMatchObject({
      kind: 'downgrade',
      dueNow: null,
      effects: { teammatesLosingAccess: 2, overStorage: true },
    });
    expect(out.effects.lost).toContain('Team library');
    expect(stripe.invoices.createPreview).not.toHaveBeenCalled();
  });

  /** A schedule moving Pro monthly to Pro yearly at the period end. */
  const scheduledToYearly = () => ({
    id: 'sub_sched_1',
    status: 'active',
    phases: [
      { start_date: NOW - 10 * DAY, items: [{ price: price('price_pro_m2', 'pro', 'month') }] },
      { start_date: NOW + 20 * DAY, items: [{ price: price('price_pro_y', 'pro', 'year') }] },
    ],
  });

  it('upgrades now, only if paid; a scheduled change comes back while the upgrade waits for payment', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue(subscription({ schedule: 'sub_sched_1' }));
    stripe.subscriptionSchedules.retrieve.mockResolvedValue(scheduledToYearly());
    stripe.subscriptions.update.mockResolvedValue({
      ...subscription(),
      pending_update: { expires_at: NOW + DAY },
      latest_invoice: { id: 'in_1', hosted_invoice_url: 'https://invoice.stripe.com/i/x' },
    });
    const j = await signedIn();
    const res = await call(BILLING_API.change, { jar: j, body: { plan: 'studio', interval: 'month' } });
    expect(res.status).toBe(200);
    expect((await read(res)).actionUrl).toBe('https://invoice.stripe.com/i/x');
    expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith(
      'sub_sched_1',
      {},
      { idempotencyKey: 'release:sub_sched_1' },
    );
    // Not recreated while the upgrade waits for payment (a schedule would override it once paid): the target
    // is noted on the subscription instead, for the webhook to restore only if the payment never comes.
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(stripe.subscriptions.update.mock.calls[0]?.[1]).toEqual({
      metadata: { zephyr_pending_downgrade: 'pro:year', zephyr_pending_downgrade_price: 'price_pro_y' },
    });
    const [id, params, opts] = stripe.subscriptions.update.mock.calls[1] as [
      string,
      Record<string, unknown>,
      { idempotencyKey: string },
    ];
    expect(id).toBe(SUB);
    expect(params).toEqual({
      items: [{ id: 'si_1', price: 'price_studio_m' }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'pending_if_incomplete',
      expand: ['latest_invoice'],
    });
    expect(opts.idempotencyKey).toMatch(/^change:/);
  });

  it('puts a scheduled change back when the upgrade fails, and doesn’t touch it when the upgrade is paid', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue(subscription({ schedule: 'sub_sched_1' }));
    stripe.subscriptionSchedules.retrieve.mockResolvedValue(scheduledToYearly());
    const j = await signedIn();
    // The note goes on first; the upgrade itself is refused.
    stripe.subscriptions.update
      .mockResolvedValueOnce(subscription())
      .mockRejectedValueOnce(new Stripe.errors.StripeCardError({ message: 'declined', type: 'card_error' }));
    const failed = await call(BILLING_API.change, { jar: j, body: { plan: 'studio', interval: 'month' } });
    expect(failed.status).toBe(503);
    expect(stripe.subscriptionSchedules.create).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptionSchedules.update.mock.calls[0]?.[1]).toMatchObject({
      phases: [{}, { items: [{ price: 'price_pro_y', quantity: 1 }] }],
    });
    // …and the note is cleared once the downgrade is back on a schedule.
    expect(stripe.subscriptions.update.mock.calls.at(-1)?.[1]).toEqual({
      metadata: { zephyr_pending_downgrade: '', zephyr_pending_downgrade_price: '' },
    });
    // Paid at once: the upgrade replaces the scheduled change, nothing is put back, the note is cleared.
    stripe.subscriptionSchedules.create.mockClear();
    stripe.subscriptions.update.mockClear();
    const paid = await call(BILLING_API.change, { jar: j, body: { plan: 'studio', interval: 'month' } });
    expect(paid.status).toBe(200);
    expect((await read(paid)).actionUrl).toBeNull();
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(stripe.subscriptions.update.mock.calls.at(-1)?.[1]).toEqual({
      metadata: { zephyr_pending_downgrade: '', zephyr_pending_downgrade_price: '' },
    });
  });

  it('schedules a downgrade for the period end', async () => {
    world.rpc.billing_subscription = () => ({ ...STORED, plan: 'studio', stripePriceId: 'price_studio_m' });
    stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({ price: price('price_studio_m', 'studio', 'month') }),
    );
    const j = await signedIn();
    const res = await call(BILLING_API.change, { jar: j, body: { plan: 'pro', interval: 'month' } });
    expect(res.status).toBe(200);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(stripe.subscriptionSchedules.create.mock.calls[0]?.[0]).toEqual({ from_subscription: SUB });
    expect(stripe.subscriptionSchedules.update.mock.calls[0]?.[1]).toEqual({
      end_behavior: 'release',
      phases: [
        {
          items: [{ price: 'price_studio_m', quantity: 1 }],
          start_date: NOW - 10 * DAY,
          end_date: NOW + 20 * DAY,
          proration_behavior: 'none',
        },
        {
          items: [{ price: 'price_pro_m2', quantity: 1 }],
          duration: { interval: 'month', interval_count: 1 },
          proration_behavior: 'none',
        },
      ],
    });
  });

  it('undoes a scheduled downgrade, and refuses changes without a subscription', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue(subscription({ schedule: 'sub_sched_1' }));
    const j = await signedIn();
    expect((await call(BILLING_API.change, { jar: j, method: 'DELETE' })).status).toBe(200);
    expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith(
      'sub_sched_1',
      {},
      { idempotencyKey: 'release:sub_sched_1' },
    );
    world.rpc.billing_subscription = () => null;
    expect(
      (await call(BILLING_API.change, { jar: j, body: { plan: 'studio', interval: 'month' } })).status,
    ).toBe(409);
    world.rpc.billing_subscription = () => STORED;
    expect(
      (await call(BILLING_API.change, { jar: j, body: { plan: 'pro', interval: 'month' } })).status,
    ).toBe(400);
  });
});

// ---- public pricing -----------------------------------------------------------------------------------------
describe('public pricing', () => {
  it('serves current prices and on-sale packs, cacheable', async () => {
    const res = await call(BILLING_API.pricing);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    const out = await read(res);
    expect(out.prices).toContainEqual({ plan: 'pro', interval: 'month', amount: 999 });
    expect(out.packs.map((p: { lookupKey: string }) => p.lookupKey)).toEqual([
      'zephyr_topup_500',
      'zephyr_topup_1000',
    ]);
  });
});

// ---- price moves --------------------------------------------------------------------------------------------
describe('price-move cron', () => {
  const move = (o: Partial<DueMove>): DueMove => ({
    id: 'mv_1',
    ownerId: MEI.id,
    email: MEI.email,
    stripeSubscriptionId: SUB,
    fromPriceId: 'price_pro_m1',
    toPriceId: 'price_pro_m2',
    fromAmount: 999,
    toAmount: 1099,
    moveAt: new Date((NOW + 35 * DAY) * 1000).toISOString(),
    status: 'pending',
    plan: 'pro',
    interval: 'month',
    ...o,
  });

  it('sends the notice first, then moves within 48 hours of the renewal without proration', async () => {
    const marks: unknown[] = [];
    world.rpc.price_move_mark = (a) => {
      marks.push(a);
      return { status: a.p_status };
    };
    world.rpc.price_moves_due = () => [
      move({}),
      move({ id: 'mv_2', status: 'notified', moveAt: new Date((NOW + DAY) * 1000).toISOString() }),
      move({ id: 'mv_3', status: 'notified', moveAt: new Date((NOW + 10 * DAY) * 1000).toISOString() }),
    ];
    stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({ price: price('price_pro_m1', 'pro', 'month') }),
    );
    const counts = await runBillingCron(env);
    expect(counts).toMatchObject({ notified: 1, moved: 1, skipped: 0 });
    expect(world.emails[0]?.subject).toContain('Pro’s price is changing');
    expect(world.emails[0]?.text).toContain('US$10.99');
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      SUB,
      { items: [{ id: 'si_1', price: 'price_pro_m2' }], proration_behavior: 'none' },
      { idempotencyKey: 'move:mv_2' },
    );
    expect(marks).toEqual([
      { p_id: 'mv_1', p_status: 'notified' },
      { p_id: 'mv_2', p_status: 'moved' },
    ]);
    // Claimed under the move's lock before the swap; mv_3 is too far from its renewal to be claimed.
    expect(rpcArgs('price_move_claim')).toEqual([{ p_id: 'mv_2' }]);
  });

  it('never swaps a move it couldn’t claim (stopped meanwhile, or taken by another run)', async () => {
    world.rpc.price_move_claim = () => null;
    world.rpc.price_move_mark = () => null;
    world.rpc.price_moves_due = () => [
      move({ status: 'notified', moveAt: new Date((NOW + DAY) * 1000).toISOString() }),
    ];
    expect(await runBillingCron(env)).toMatchObject({ moved: 0 });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('puts a move back at once when Stop came while it was being swapped', async () => {
    const marks: unknown[] = [];
    world.rpc.price_move_mark = (a) => {
      marks.push(a);
      return { status: a.p_status === 'moved' ? 'revert_pending' : 'stopped' };
    };
    world.rpc.price_moves_due = () => [
      move({ status: 'notified', moveAt: new Date((NOW + DAY) * 1000).toISOString() }),
    ];
    let onPrice = 'price_pro_m1';
    stripe.subscriptions.retrieve.mockImplementation(async () =>
      subscription({ price: price(onPrice, 'pro', 'month') }),
    );
    stripe.subscriptions.update.mockImplementation(async (_id: string, p: { items: { price: string }[] }) => {
      onPrice = p.items[0]?.price ?? onPrice;
      return subscription();
    });
    const counts = await runBillingCron(env);
    expect(counts).toMatchObject({ moved: 0, reverted: 1 });
    expect(stripe.subscriptions.update.mock.calls.map((c) => c[2])).toEqual([
      { idempotencyKey: 'move:mv_1' },
      { idempotencyKey: 'revert:mv_1' },
    ]);
    expect(marks).toEqual([
      { p_id: 'mv_1', p_status: 'moved' },
      { p_id: 'mv_1', p_status: 'reverted' },
    ]);
  });

  it('releases the claim when the swap fails, so the next run tries again', async () => {
    const marks: unknown[] = [];
    world.rpc.price_move_mark = (a) => {
      marks.push(a);
      return null;
    };
    world.rpc.price_moves_due = () => [
      move({ status: 'notified', moveAt: new Date((NOW + DAY) * 1000).toISOString() }),
    ];
    stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({ price: price('price_pro_m1', 'pro', 'month') }),
    );
    stripe.subscriptions.update.mockRejectedValue(
      new Stripe.errors.StripeAPIError({ message: 'down', type: 'api_error' }),
    );
    expect(await runBillingCron(env)).toMatchObject({ moved: 0, failed: 1 });
    expect(marks).toEqual([{ p_id: 'mv_1', p_status: 'notified' }]);
  });

  it('retries reverts Stop still owes, and alerts on ones the renewal reached first', async () => {
    const marks: unknown[] = [];
    world.rpc.price_move_mark = (a) => {
      marks.push(a);
      return null;
    };
    world.rpc.price_moves_due = () => [];
    world.rpc.price_move_reverts_due = () => ({
      failed: 2,
      reverts: [
        { moveId: 'mv_9', stripeSubscriptionId: SUB, fromPriceId: 'price_pro_m1', toPriceId: 'price_pro_m2' },
      ],
    });
    stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({ price: price('price_pro_m2', 'pro', 'month') }),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const counts = await runBillingCron(env);
    expect(counts).toMatchObject({ reverted: 1, revertFailed: 2 });
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      SUB,
      { items: [{ id: 'si_1', price: 'price_pro_m1' }], proration_behavior: 'none' },
      { idempotencyKey: 'revert:mv_9' },
    );
    expect(marks).toEqual([{ p_id: 'mv_9', p_status: 'reverted' }]);
    expect(JSON.stringify(errors.mock.calls)).toContain('price_revert_failed');
  });

  it('skips a move when the plan changed since the notice', async () => {
    world.rpc.price_move_mark = () => null;
    world.rpc.price_moves_due = () => [
      move({ status: 'notified', moveAt: new Date(NOW * 1000).toISOString() }),
    ];
    stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({ price: price('price_studio_m', 'studio', 'month') }),
    );
    expect(await runBillingCron(env)).toMatchObject({ moved: 0, skipped: 1 });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('never marks a notice sent without an address (the move waits, and is skipped at its date)', async () => {
    const marks: unknown[] = [];
    world.rpc.price_move_mark = (a) => {
      marks.push(a);
      return null;
    };
    world.rpc.price_moves_due = () => [move({ email: null })];
    expect(await runBillingCron(env)).toMatchObject({ notified: 0, unsent: 1 });
    expect(marks).toEqual([]);
    expect(world.emails).toHaveLength(0);
  });

  it('ends plans past due beyond the grace period, and asks again to stop renewals of deleted accounts', async () => {
    world.rpc.price_moves_due = () => [];
    world.rpc.billing_past_due_expire = () => [{ ownerId: MEI.id, email: MEI.email }];
    world.rpc.billing_deletion_cancels_due = () => [{ ownerId: MEI.id, stripeSubscriptionId: SUB }];
    const counts = await runBillingCron(env);
    expect(counts).toMatchObject({ plansEnded: 1, deletionCancels: 1 });
    expect(world.emails.map((e) => e.subject)).toEqual(['Your Zephyr plan has ended']);
    expect(stripe.subscriptions.update.mock.calls[0]?.[1]).toEqual({
      cancel_at_period_end: true,
      metadata: { zephyr_deletion_cancel: '1' },
    });
  });

  it('only ends past-due plans without Stripe', async () => {
    delete env.STRIPE_SECRET_KEY;
    world.rpc.price_moves_due = () => {
      throw new Error('should not be called');
    };
    expect(await runBillingCron(env)).toEqual({
      notified: 0,
      moved: 0,
      skipped: 0,
      failed: 0,
      unsent: 0,
      plansEnded: 0,
      deletionCancels: 0,
      reverted: 0,
      revertFailed: 0,
    });
    expect(rpcArgs('billing_past_due_expire')).toHaveLength(1);
  });
});

// ---- account deletion ---------------------------------------------------------------------------------------
describe('account deletion and the subscription', () => {
  beforeEach(() => {
    world.rpc.billing_subscription = () => STORED;
  });
  it('asks Stripe again on a second deletion request the same day (no day-based idempotency key)', async () => {
    await cancelForDeletion(env, MEI.id, '2026-12-14T00:00:00Z');
    await cancelForDeletion(env, MEI.id, '2026-12-14T00:00:00Z');
    const keys = stripe.subscriptions.update.mock.calls.map(
      (c) => (c[2] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^deletion-cancel:sub_Mei123:/);
    expect(keys[0]).not.toBe(keys[1]);
  });
  it('stops renewing while deletion is pending, and resumes only what it stopped', async () => {
    await cancelForDeletion(env, MEI.id, '2026-12-14T00:00:00Z');
    expect(stripe.subscriptions.update.mock.calls[0]?.[1]).toEqual({
      cancel_at_period_end: true,
      metadata: { zephyr_deletion_cancel: '1' },
    });
    stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({ cancel: true, meta: { owner_id: MEI.id } }),
    );
    await undoCancelForDeletion(env, MEI.id, true);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1); // the member had cancelled themselves
    stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({ cancel: true, meta: { zephyr_deletion_cancel: '1' } }),
    );
    await undoCancelForDeletion(env, MEI.id, { restored: true, stripeSubscriptionId: SUB });
    expect(stripe.subscriptions.update.mock.calls[1]?.[1]).toEqual({
      cancel_at_period_end: false,
      metadata: { zephyr_deletion_cancel: '' },
    });
    expect(stripe.subscriptions.update.mock.calls[1]?.[2]).toMatchObject({
      idempotencyKey: expect.stringMatching(/^deletion-resume:/),
    });
  });

  it('releases a scheduled downgrade before stopping renewal (Stripe refuses it on a scheduled subscription)', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue(subscription({ schedule: 'sub_sched_1' }));
    await cancelForDeletion(env, MEI.id, { stripeSubscriptionId: SUB });
    expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith(
      'sub_sched_1',
      {},
      { idempotencyKey: 'release:sub_sched_1' },
    );
    expect(stripe.subscriptionSchedules.release.mock.invocationCallOrder[0]).toBeLessThan(
      stripe.subscriptions.update.mock.invocationCallOrder[0] as number,
    );
  });

  it('cancels every live subscription at once before a purge, deletes the customer, and blocks the purge when Stripe fails', async () => {
    const stray = { ...subscription(), id: 'sub_Stray1' };
    stripe.subscriptions.list.mockReturnValue(
      listOf([stray, { ...subscription({ status: 'canceled' }), id: 'sub_Old1' }]),
    );
    stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({ ...subscription(), id }));
    await cancelForPurge(env, MEI.id, { stripeSubscriptionId: SUB });
    expect(stripe.subscriptions.list).toHaveBeenCalledWith({ customer: CUS, status: 'all', limit: 100 });
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith(
      SUB,
      {},
      { idempotencyKey: `purge-cancel:${SUB}` },
    );
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith(
      'sub_Stray1',
      {},
      { idempotencyKey: 'purge-cancel:sub_Stray1' },
    );
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(2);
    expect(stripe.customers.del).toHaveBeenCalledWith(CUS);
    stripe.subscriptions.list.mockReturnValue(listOf([]));
    stripe.subscriptions.retrieve.mockRejectedValue(
      new Stripe.errors.StripeAPIError({ message: 'down', type: 'api_error' }),
    );
    await expect(cancelForPurge(env, MEI.id, { stripeSubscriptionId: SUB })).rejects.toThrow();
    // A subscription Stripe no longer has is already gone.
    stripe.subscriptions.retrieve.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        message: 'No such subscription',
        type: 'invalid_request_error',
        code: 'resource_missing',
      }),
    );
    await expect(cancelForPurge(env, MEI.id, { stripeSubscriptionId: SUB })).resolves.toBeUndefined();
  });
});

// ---- admin --------------------------------------------------------------------------------------------------
describe('admin Plans & billing', () => {
  const OVERVIEW = {
    kpis: { mrr: 0, paying: 0, pastDue: 0, cancelling: 0, topUpCreditsSold30d: 0 },
    prices: [],
    changes: [],
    paymentDue: [],
    events: [],
  };
  async function staff(email: string, role: StaffRole, o: { authAgo?: number } = {}) {
    if (!world.users.some((u) => u.email === email))
      world.users.push({ id: '10000000-0000-0000-0000-000000000009', email, staff: role, passkeys: 1 });
    const u = must(world.users.find((x) => x.email === email));
    const access = await accessToken(email);
    world.passkeyUser = u;
    const j = jar();
    const res = await call('/admin/api/v1/auth/passkey/verify', {
      body: { challengeId: 'ch-auth', credential: credential('webauthn.get', LANDING) },
      jar: j,
      access,
    });
    expect(res.status).toBe(200);
    if (o.authAgo)
      j.cookies.set(
        '__Host-za-at',
        await sbToken({ sub: u.id, email: u.email, amr: ['passkey'], authAgo: o.authAgo }),
      );
    return { j, access };
  }
  beforeEach(() => {
    world.rpc.admin_billing_overview = () => OVERVIEW;
    world.rpc.admin_price_set = () => ({ ok: true });
    world.rpc.admin_pack_set = () => ({ ok: true });
    world.rpc.admin_price_preview = () => ({ raise: false });
    world.rpc.ai_alert_recipients = () => ['owner@zephyr.test'];
  });

  it('lets Owner, Admin and Finance read, and says when Stripe is not configured', async () => {
    const s = await staff('admin@zephyr.test', 'admin');
    const res = await call(ADMIN_BILLING_API.overview, { jar: s.j, access: s.access });
    expect(await read(res)).toMatchObject({ ok: true, configured: true });
    const sup = await staff('support@zephyr.test', 'support');
    expect((await call(ADMIN_BILLING_API.overview, { jar: sup.j, access: sup.access })).status).toBe(403);
    // Admins read but don't set prices.
    expect(
      (
        await call(ADMIN_BILLING_API.prices, {
          jar: s.j,
          access: s.access,
          body: { lookupKey: 'zephyr_pro_monthly', amount: 899, reason: 'x' },
        })
      ).status,
    ).toBe(403);
  });

  it('asks for the passkey again before a rise, then creates the Stripe price and emails the Owners', async () => {
    const stale = await staff('finance@zephyr.test', 'finance', { authAgo: 3600 });
    const body = { lookupKey: 'zephyr_pro_monthly', amount: 1099, reason: 'Storage costs' };
    const r1 = await call(ADMIN_BILLING_API.prices, { jar: stale.j, access: stale.access, body });
    expect(r1.status).toBe(403);
    expect(await read(r1)).toMatchObject({ error: 'reauth_required' });
    expect(stripe.prices.create).not.toHaveBeenCalled();

    const fresh = await staff('finance@zephyr.test', 'finance');
    const r2 = await call(ADMIN_BILLING_API.prices, { jar: fresh.j, access: fresh.access, body });
    expect(r2.status).toBe(200);
    const [params, opts] = stripe.prices.create.mock.calls[0] as [
      Record<string, unknown>,
      { idempotencyKey: string },
    ];
    expect(params).toEqual({
      product: 'prod_pro',
      currency: 'usd',
      unit_amount: 1099,
      lookup_key: 'zephyr_pro_monthly',
      transfer_lookup_key: true,
      tax_behavior: 'exclusive',
      recurring: { interval: 'month' },
      metadata: { plan: 'pro', interval: 'month' },
    });
    expect(opts.idempotencyKey).toMatch(/^price:zephyr_pro_monthly:1099:/);
    expect(rpcArgs('admin_price_set')[0]).toMatchObject({
      p_lookup_key: 'zephyr_pro_monthly',
      p_stripe_price_id: 'price_new',
      p_amount: 1099,
      p_seed: false,
    });
    expect(world.emails.map((e) => e.subject)).toEqual(['[Zephyr billing] Price changed']);
  });

  it('saves a cut and turning a pack off without reauth; turning a pack on needs it', async () => {
    const stale = await staff('owner@zephyr.test', 'owner', { authAgo: 3600 });
    const cut = await call(ADMIN_BILLING_API.prices, {
      jar: stale.j,
      access: stale.access,
      body: { lookupKey: 'zephyr_pro_monthly', amount: 899, reason: 'Promo' },
    });
    expect(cut.status).toBe(200);
    expect(world.emails).toHaveLength(0);
    const off = await call(ADMIN_BILLING_API.pack('zephyr_topup_1000'), {
      jar: stale.j,
      access: stale.access,
      method: 'PATCH',
      body: { active: false },
    });
    expect(off.status).toBe(200);
    const on = await call(ADMIN_BILLING_API.pack('zephyr_topup_2500'), {
      jar: stale.j,
      access: stale.access,
      method: 'PATCH',
      body: { active: true },
    });
    expect(on.status).toBe(403);
    expect(
      (
        await call(ADMIN_BILLING_API.pack('zephyr_pro_monthly'), {
          jar: stale.j,
          access: stale.access,
          method: 'PATCH',
          body: { active: true },
        })
      ).status,
    ).toBe(404);
  });

  it('treats a "cut" that is still above what grandfathered subscribers pay as a rise', async () => {
    // Current 999 → 899 looks like a cut, but subscribers on an older 799 price would pay more.
    world.rpc.admin_price_preview = () => ({ from: 999, to: 899, raise: true });
    const body = { lookupKey: 'zephyr_pro_monthly', amount: 899, reason: 'Simplify' };
    const stale = await staff('finance@zephyr.test', 'finance', { authAgo: 3600 });
    const r1 = await call(ADMIN_BILLING_API.prices, { jar: stale.j, access: stale.access, body });
    expect(r1.status).toBe(403);
    expect(await read(r1)).toMatchObject({ error: 'reauth_required' });
    expect(stripe.prices.create).not.toHaveBeenCalled();
    const fresh = await staff('finance@zephyr.test', 'finance');
    const r2 = await call(ADMIN_BILLING_API.prices, { jar: fresh.j, access: fresh.access, body });
    expect(r2.status).toBe(200);
    expect(world.emails.map((e) => e.subject)).toEqual(['[Zephyr billing] Price changed']);
    expect(world.emails[0]?.text).toContain('still a rise for subscribers paying less');
    // The preview says the same.
    const p = await call(ADMIN_BILLING_API.pricePreview, {
      jar: fresh.j,
      access: fresh.access,
      body: { lookupKey: 'zephyr_pro_monthly', amount: 899 },
    });
    expect(await read(p)).toMatchObject({ raise: true });
  });

  it('stops a change and puts applied moves back on the old price', async () => {
    world.rpc.admin_price_change_stop = () => ({
      lookupKey: 'zephyr_pro_monthly',
      reverts: [
        { moveId: 'mv_1', stripeSubscriptionId: SUB, fromPriceId: 'price_pro_m1', toPriceId: 'price_pro_m2' },
      ],
    });
    const s = await staff('owner@zephyr.test', 'owner');
    const res = await call(ADMIN_BILLING_API.priceChange('6d0c1d3e-1111-4222-8333-444455556666'), {
      jar: s.j,
      access: s.access,
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      SUB,
      { items: [{ id: 'si_1', price: 'price_pro_m1' }], proration_behavior: 'none' },
      { idempotencyKey: 'revert:mv_1' },
    );
    expect(rpcArgs('price_move_mark')).toEqual([{ p_id: 'mv_1', p_status: 'reverted' }]);
    expect(world.emails.map((e) => e.subject)).toEqual(['[Zephyr billing] Price change stopped']);
  });
});
