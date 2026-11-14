/**
 * Account deletion and the subscription (docs/phase-7.md, Account deletion):
 * - scheduling a deletion sets cancel_at_period_end (marked, so a restore only undoes our own change);
 * - restoring undoes it;
 * - the purge cancels at once, before the account is deleted.
 */
import type { Env } from '../env';
import { billingDb } from './db';
import { isMissing, stripeClient } from './stripe';

/** Subscription metadata flag: cancel_at_period_end was set by a deletion request, not by the member. */
const FLAG = 'zephyr_deletion_cancel';
const SUB = /^sub_[A-Za-z0-9]+$/;

/** The subscription id: from the deletion function's answer when it gives one, else the stored row. */
export async function subscriptionIdFor(env: Env, owner: string, fromDb?: unknown): Promise<string | null> {
  const given =
    fromDb && typeof fromDb === 'object'
      ? (fromDb as { stripeSubscriptionId?: unknown }).stripeSubscriptionId
      : null;
  if (typeof given === 'string' && SUB.test(given)) return given;
  if (given === null && fromDb && typeof fromDb === 'object' && 'stripeSubscriptionId' in fromDb) return null;
  const row = await billingDb.subscription(env, owner);
  return row?.stripeSubscriptionId && SUB.test(row.stripeSubscriptionId) ? row.stripeSubscriptionId : null;
}

/** Deletion scheduled: stop renewing. No-op without Stripe or a live subscription. */
export async function cancelForDeletion(env: Env, owner: string, fromDb?: unknown): Promise<void> {
  const stripe = stripeClient(env);
  if (!stripe) return;
  const id = await subscriptionIdFor(env, owner, fromDb);
  if (!id) return;
  try {
    const sub = await stripe.subscriptions.retrieve(id);
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired' || sub.cancel_at_period_end) return;
    await stripe.subscriptions.update(
      id,
      { cancel_at_period_end: true, metadata: { [FLAG]: '1' } },
      { idempotencyKey: `deletion-cancel:${id}:${new Date().toISOString().slice(0, 10)}` },
    );
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
}

/** Deletion restored: renew again, but only if our deletion request was what stopped it. */
export async function undoCancelForDeletion(env: Env, owner: string, fromDb?: unknown): Promise<void> {
  const stripe = stripeClient(env);
  if (!stripe) return;
  const id = await subscriptionIdFor(env, owner, fromDb);
  if (!id) return;
  try {
    const sub = await stripe.subscriptions.retrieve(id);
    if (sub.metadata?.[FLAG] !== '1' || !sub.cancel_at_period_end) return;
    await stripe.subscriptions.update(id, { cancel_at_period_end: false, metadata: { [FLAG]: '' } });
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
}

/**
 * Purge: cancel at once. Throws when Stripe can't be reached, so the purge job keeps the account for its
 * next run instead of deleting it while it's still billed.
 */
export async function cancelForPurge(env: Env, owner: string, fromDb?: unknown): Promise<void> {
  const stripe = stripeClient(env);
  if (!stripe) return;
  const id = await subscriptionIdFor(env, owner, fromDb);
  if (!id) return;
  try {
    const sub = await stripe.subscriptions.retrieve(id);
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return;
    await stripe.subscriptions.cancel(id, {}, { idempotencyKey: `purge-cancel:${id}` });
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
}
