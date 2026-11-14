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
  /** Keeps the paid plan now (active, trialing, or past_due within the grace period). */
  keepsPlan?: boolean;
  cancelAtPeriodEnd?: boolean;
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
  /** cancel_at_period_end came from an account-deletion request (metadata zephyr_deletion_cancel). */
  deletion_cancel: boolean;
  /** The current price's unit amount (cents), for a price the DB hasn't seen. */
  amount: number | null;
}

/** billing_apply → what changed (for emails). `email` is the owner's account email when the DB has it. */
export interface ApplyResult {
  planBefore: PlanId;
  planAfter: PlanId;
  /** True when the write was older than the stored read and ignored. */
  stale?: boolean;
  /**
   * A second plan-keeping subscription for an owner whose stored one still keeps the plan: not applied. The API
   * checks the stored one in Stripe, then cancels and refunds the newer one.
   */
  duplicate?: boolean;
  storedSubscriptionId?: string;
  /** A duplicate already recorded in billing_duplicates: settle it (never apply), skipping what's done. */
  recorded?: boolean;
  refunded?: boolean;
  canceled?: boolean;
  /** Not applied: an ended subscription that never replaces a live one, or another customer's. */
  ignored?: 'older_subscription' | 'customer_mismatch';
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
  /** moving: a claim older than an hour (a worker died mid-swap); it can be claimed again. */
  status: 'pending' | 'notified' | 'moving';
  plan: PaidPlanId | null;
  interval: BillingInterval | null;
}

/** A move to put back on its old price (Stop, or a claimed move finished after Stop). */
export interface RevertMove {
  moveId: string;
  stripeSubscriptionId: string;
  fromPriceId: string;
  toPriceId?: string;
}

/** admin_price_change_stop → moves applied in Stripe but not yet renewed, to put back. */
export interface StopResult {
  error?: string;
  lookupKey?: string;
  from?: number;
  to?: number;
  reverts?: RevertMove[];
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
  checkoutRecord: (env: Env, owner: string, session: string, kind: string, lookupKey: string, idem: string) =>
    rpc<unknown>(env, 'billing_checkout_record', {
      p_owner: owner,
      p_session: session,
      p_kind: kind,
      p_lookup_key: lookupKey,
      p_idem: idem,
    }),
  /** The owner's other open Checkout sessions of a kind (not the one this idempotency key returns). */
  checkoutOpen: async (env: Env, owner: string, kind: 'subscription' | 'topup', idem: string) =>
    (await rpc<string[] | null>(env, 'billing_checkout_open', {
      p_owner: owner,
      p_kind: kind,
      p_idem: idem,
    })) ?? [],
  /** True at most once per 10 s per session: the return page may make the API ask Stripe itself. */
  checkoutPoll: async (env: Env, owner: string, session: string) =>
    (await rpc<boolean | null>(env, 'billing_checkout_poll', { p_owner: owner, p_session: session })) ===
    true,
  checkoutStatus: (env: Env, owner: string, session: string) =>
    rpc<{
      state: 'pending' | 'done' | 'failed' | 'refunded';
      kind: 'subscription' | 'topup';
      plan?: PlanId;
      credits?: number;
      createdAt?: string;
    } | null>(env, 'billing_checkout_status', { p_owner: owner, p_session: session }),
  checkoutMark: (env: Env, session: string, state: 'done' | 'failed' | 'refunded') =>
    rpc<unknown>(env, 'billing_checkout_mark', { p_session: session, p_state: state }),
  apply: (env: Env, owner: string, sub: SubscriptionSnapshot, syncedAt: Date) =>
    rpc<ApplyResult | null>(env, 'billing_apply', {
      p_owner: owner,
      p_sub: sub,
      p_synced_at: syncedAt.toISOString(),
    }),
  duplicateRecord: (env: Env, owner: string, subscription: string) =>
    rpc<{ recorded?: boolean; refunded?: boolean; canceled?: boolean; error?: string } | null>(
      env,
      'billing_duplicate_record',
      { p_owner: owner, p_subscription: subscription },
    ),
  duplicateMark: (env: Env, subscription: string, what: 'refunded' | 'canceled') =>
    rpc<boolean>(env, 'billing_duplicate_mark', { p_subscription: subscription, p_what: what }),
  duplicatesUnsettled: async (env: Env, limit: number) =>
    (await rpc<
      { stripeSubscriptionId: string; ownerId: string; refunded: boolean; canceled: boolean }[] | null
    >(env, 'billing_duplicates_unsettled', { p_limit: limit })) ?? [],
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
  /** `refunded` / `amount`: the charge's refunded total so far and its amount (credits come off in proportion). */
  topupRefund: (env: Env, paymentIntent: string, refunded: number | null, amount: number | null) =>
    rpc<{ ownerId: string; removed: number } | null>(env, 'billing_topup_refund', {
      p_payment_intent: paymentIntent,
      p_refunded: refunded,
      p_amount: amount,
    }),
  topupRefundBySession: (env: Env, session: string, refunded: number | null, amount: number | null) =>
    rpc<{ ownerId: string; removed: number } | null>(env, 'billing_topup_refund_by_session', {
      p_session: session,
      p_refunded: refunded,
      p_amount: amount,
    }),
  /** Plans ended because past_due outlasted the grace period: [{ownerId, email}]. */
  pastDueExpire: async (env: Env, limit: number) =>
    (await rpc<{ ownerId: string; email: string | null }[] | null>(env, 'billing_past_due_expire', {
      p_limit: limit,
    })) ?? [],
  /** Accounts pending deletion whose subscription still renews. */
  deletionResumesDue: async (env: Env, limit: number) =>
    (await rpc<{ ownerId: string; stripeSubscriptionId: string }[] | null>(
      env,
      'billing_deletion_resumes_due',
      {
        p_limit: limit,
      },
    )) ?? [],
  deletionPending: async (env: Env, owner: string) =>
    Boolean(await rpc<boolean>(env, 'billing_deletion_pending', { p_owner: owner })),
  deletionCancelsDue: async (env: Env, limit: number) =>
    (await rpc<{ ownerId: string; stripeSubscriptionId: string }[] | null>(
      env,
      'billing_deletion_cancels_due',
      { p_limit: limit },
    )) ?? [],
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
  /** `notified` also releases a claim (the swap didn't happen). `moved` answers status revert_pending when the
   * change was stopped while the swap ran: the caller puts it back. */
  moveMark: (env: Env, id: string, status: 'notified' | 'moved' | 'skipped' | 'reverted' | 'revert_failed') =>
    rpc<{ status?: string } | null>(env, 'price_move_mark', { p_id: id, p_status: status }),
  /** Claims a notified move for the Stripe swap (null: stopped, already moved, or claimed by another run). */
  moveClaim: (env: Env, id: string) => rpc<DueMove | null>(env, 'price_move_claim', { p_id: id }),
  /** Reverts Stop still owes; those past their renewal are marked failed (counted). */
  revertsDue: async (env: Env, limit: number, fail = true) =>
    (await rpc<{ failed: number; reverts: RevertMove[] } | null>(env, 'price_move_reverts_due', {
      p_limit: limit,
      p_fail: fail,
    })) ?? { failed: 0, reverts: [] },
};
