/**
 * The database side of billing as the API calls it (docs/phase-7.md, Functions). Shapes the API expects
 * from each function are declared here; every value read is checked before use.
 */
import type {
  BillingInterval,
  BillingStatus,
  PaidPlanId,
  PlanId,
  SubscriptionStatus,
  TopUpLookupKey,
} from '@zephyr/shared';
import type { Env } from '../env';
import { rpc } from '../supabase';

/** billing_prices_current() → one row per lookup key. */
export interface CurrentPrice {
  lookupKey: string;
  stripePriceId: string;
  amount: number;
  plan: PaidPlanId | null;
  interval: BillingInterval | null;
  credits: number | null;
  /** Packs can be off; subscription prices are always on sale. */
  active: boolean;
}

/** billing_subscription(p_owner) → the stored subscription row with its Stripe ids, or null. */
export interface StoredSubscription {
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  itemId: string | null;
  status: SubscriptionStatus;
  plan: PaidPlanId;
  interval: BillingInterval;
  stripePriceId: string;
  scheduleId: string | null;
  currentPeriodEnd: string;
}

/** The subscription as `billing_apply` stores it (snake_case = the `subscriptions` columns). */
export interface SubscriptionSnapshot {
  stripe_subscription_id: string;
  stripe_customer_id: string;
  status: SubscriptionStatus;
  plan_id: PaidPlanId | null;
  interval: BillingInterval | null;
  stripe_price_id: string | null;
  lookup_key: string | null;
  item_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  schedule_id: string | null;
  scheduled_plan: PaidPlanId | null;
  scheduled_interval: BillingInterval | null;
  scheduled_at: string | null;
  /** The next phase's price (a scheduled downgrade), so the DB can map prices it has seen. */
  scheduled_price_id: string | null;
  /** The current price's unit amount (cents), for a price the DB hasn't seen. */
  amount: number | null;
}

/** billing_apply → what changed (for emails). `email` is the owner's account email when the DB has it. */
export interface ApplyResult {
  planBefore: PlanId;
  planAfter: PlanId;
  /** True when the write was older than the stored read and ignored. */
  stale?: boolean;
  email?: string | null;
}

/** price_moves_due(p_limit) → moves needing a notice (pending) or due within 48 h (notified). */
export interface DueMove {
  id: string;
  ownerId: string;
  email: string | null;
  stripeSubscriptionId: string;
  fromPriceId: string;
  toPriceId: string;
  fromAmount: number;
  toAmount: number;
  moveAt: string;
  status: 'pending' | 'notified';
  plan: PaidPlanId | null;
  interval: BillingInterval | null;
}

/** admin_price_change_stop → moves applied in Stripe but not yet renewed, to put back. */
export interface StopResult {
  error?: string;
  lookupKey?: string;
  from?: number;
  to?: number;
  reverts?: { moveId: string; stripeSubscriptionId: string; fromPriceId: string; toPriceId?: string }[];
}

export const billingDb = {
  status: (env: Env, owner: string) =>
    rpc<Omit<BillingStatus, 'ok'> | null>(env, 'billing_status', { p_owner: owner }),
  subscription: (env: Env, owner: string) =>
    rpc<StoredSubscription | null>(env, 'billing_subscription', { p_owner: owner }),
  async customer(env: Env, owner: string): Promise<string | null> {
    const v = await rpc<string | { stripeCustomerId?: string | null } | null>(env, 'billing_customer_get', {
      p_owner: owner,
    });
    const id = typeof v === 'string' ? v : (v?.stripeCustomerId ?? null);
    return id && /^cus_[A-Za-z0-9]+$/.test(id) ? id : null;
  },
  setCustomer: (env: Env, owner: string, customer: string) =>
    rpc<unknown>(env, 'billing_customer_set', { p_owner: owner, p_customer: customer }),
  pricesCurrent: async (env: Env) => (await rpc<CurrentPrice[] | null>(env, 'billing_prices_current')) ?? [],
  checkoutRecord: (env: Env, owner: string, session: string, kind: string, lookupKey: string) =>
    rpc<unknown>(env, 'billing_checkout_record', {
      p_owner: owner,
      p_session: session,
      p_kind: kind,
      p_lookup_key: lookupKey,
    }),
  checkoutStatus: (env: Env, owner: string, session: string) =>
    rpc<{
      state: 'pending' | 'done' | 'failed';
      kind: 'subscription' | 'topup';
      plan?: PlanId;
      credits?: number;
      createdAt?: string;
    } | null>(env, 'billing_checkout_status', { p_owner: owner, p_session: session }),
  checkoutMark: (env: Env, session: string, state: 'done' | 'failed') =>
    rpc<unknown>(env, 'billing_checkout_mark', { p_session: session, p_state: state }),
  apply: (env: Env, owner: string, sub: SubscriptionSnapshot, syncedAt: Date) =>
    rpc<ApplyResult | null>(env, 'billing_apply', {
      p_owner: owner,
      p_sub: sub,
      p_synced_at: syncedAt.toISOString(),
    }),
  topupGrant: (
    env: Env,
    owner: string,
    session: string,
    paymentIntent: string | null,
    lookupKey: TopUpLookupKey,
  ) =>
    rpc<{ credits?: number; granted?: boolean; error?: string } | null>(env, 'billing_topup_grant', {
      p_owner: owner,
      p_session: session,
      p_payment_intent: paymentIntent,
      p_lookup_key: lookupKey,
    }),
  topupRefund: (env: Env, paymentIntent: string) =>
    rpc<unknown>(env, 'billing_topup_refund', { p_payment_intent: paymentIntent }),
  eventBegin: (env: Env, id: string, type: string, created: number) =>
    rpc<'new' | 'retry' | 'done'>(env, 'billing_event_begin', {
      p_id: id,
      p_type: type,
      p_created: new Date(created * 1000).toISOString(),
    }),
  eventFinish: (
    env: Env,
    id: string,
    status: 'processed' | 'ignored' | 'failed',
    error: string | null,
    owner: string | null,
  ) =>
    rpc<unknown>(env, 'billing_event_finish', { p_id: id, p_status: status, p_error: error, p_owner: owner }),
  movesDue: async (env: Env, limit: number) =>
    (await rpc<DueMove[] | null>(env, 'price_moves_due', { p_limit: limit })) ?? [],
  moveMark: (env: Env, id: string, status: 'notified' | 'moved' | 'skipped' | 'reverted') =>
    rpc<unknown>(env, 'price_move_mark', { p_id: id, p_status: status }),
};
