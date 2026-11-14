/**
 * Account deletion and the subscription (docs/phase-7.md, Account deletion):
 * - scheduling a deletion sets cancel_at_period_end (marked, so a restore only undoes our own change). A
 *   scheduled downgrade is released first: Stripe won't set cancel_at_period_end on a subscription a schedule
 *   manages. If it fails, the daily billing cron tries again;
 * - restoring undoes it (a released downgrade isn't put back: the member can schedule it again);
 * - the purge cancels every live subscription of the customer at once and deletes the Stripe customer, before
 *   the account is deleted.
 */
import type { Env } from '../env';
import { billingDb } from './db';
import { idOf, isMissing, type Stripe, stripeClient } from './stripe';
import { DELETION_CANCEL_FLAG as FLAG, DELETION_CANCEL_AT as FLAG_AT, isDeletionCancel } from './sync';

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
    // Restored meanwhile (delete and restore seconds apart both run in the background): nothing to stop.
    if (!(await billingDb.deletionPending(env, owner))) return;
    const sub = await stripe.subscriptions.retrieve(id);
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired' || sub.cancel_at_period_end) return;
    // A fresh key per request: a deletion requested, restored and requested again on one day must reach Stripe
    // again (a day-based key would replay the first answer). cancel_at_period_end is idempotent on its own.
    const nonce = crypto.randomUUID();
    const schedule = idOf(sub.schedule);
    if (schedule) {
      await stripe.subscriptionSchedules.release(schedule, {}, { idempotencyKey: `release:${schedule}` });
    }
    await stripe.subscriptions.update(
      id,
      {
        cancel_at_period_end: true,
        metadata: { [FLAG]: '1', [FLAG_AT]: String(Math.floor(Date.now() / 1000)) },
      },
      { idempotencyKey: `deletion-cancel:${id}:${nonce}` },
    );
    // A restore that landed while we were cancelling: put it back now (the daily cron also reconciles).
    if (!(await billingDb.deletionPending(env, owner))) await resume(stripe, id);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
}

/** Renews again if our deletion request was what stopped it. */
async function resume(stripe: Stripe, id: string) {
  const sub = await stripe.subscriptions.retrieve(id);
  // Only a cancel our deletion request made (never one the member made later in the portal).
  if (!isDeletionCancel(sub)) return;
  await stripe.subscriptions.update(
    id,
    { cancel_at_period_end: false, metadata: { [FLAG]: '', [FLAG_AT]: '' } },
    { idempotencyKey: `deletion-resume:${id}:${crypto.randomUUID()}` },
  );
}

/** Deletion restored: renew again, but only if our deletion request was what stopped it. */
export async function undoCancelForDeletion(env: Env, owner: string, fromDb?: unknown): Promise<void> {
  const stripe = stripeClient(env);
  if (!stripe) return;
  const id = await subscriptionIdFor(env, owner, fromDb);
  if (!id) return;
  try {
    // Deletion requested again meanwhile: leave the cancel in place.
    if (await billingDb.deletionPending(env, owner)) return;
    await resume(stripe, id);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
}

const ENDED = new Set(['canceled', 'incomplete_expired']);

/**
 * Purge: cancel at once every subscription the customer still has in Stripe (not only the one we track: a
 * duplicate or a stray one must not keep billing a deleted account), then delete the Stripe customer (email,
 * address). Throws when Stripe can't be reached, so the purge job keeps the account for its next run instead
 * of deleting it while it's still billed. Our billing rows go with the account (on delete cascade).
 */
export async function cancelForPurge(env: Env, owner: string, fromDb?: unknown): Promise<void> {
  const stripe = stripeClient(env);
  if (!stripe) return;
  const customer = await billingDb.customer(env, owner);
  const ids = new Set<string>();
  const tracked = await subscriptionIdFor(env, owner, fromDb);
  if (tracked) ids.add(tracked);
  if (customer) {
    try {
      for await (const sub of stripe.subscriptions.list({ customer, status: 'all', limit: 100 })) {
        if (!ENDED.has(sub.status)) ids.add(sub.id);
      }
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  for (const id of ids) {
    try {
      const sub = await stripe.subscriptions.retrieve(id);
      if (ENDED.has(sub.status)) continue;
      await stripe.subscriptions.cancel(id, {}, { idempotencyKey: `purge-cancel:${id}` });
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  if (customer) {
    try {
      // DELETE is idempotent in Stripe (idempotency keys apply to POSTs); a second delete is resource_missing.
      await stripe.customers.del(customer);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
}
