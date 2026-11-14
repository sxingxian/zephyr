/**
 * The daily billing job (02:10 UTC) (docs/phase-7.md, Billing API › Cron):
 * - price moves: subscribers on an older price of their lookup key get a notice, then move at their renewal;
 * - plans past due beyond the grace period end (Stripe's dunning should have canceled them);
 * - accounts pending deletion whose subscription still renews are asked again to stop, and restored accounts
 *   still set to cancel by a late deletion request renew again;
 * - duplicate subscriptions an earlier try didn't finish are refunded and canceled.
 */
import { PLAN_KEEPING_STATUSES, type SubscriptionStatus } from '@zephyr/shared';
import { planEndedEmail, priceNoticeEmail } from '../email/billing-templates';
import { sendEmail } from '../email/resend';
import type { Env } from '../env';
import { logError } from '../http';
import { billingDb, type DueMove, type RevertMove } from './db';
import { cancelForDeletion, undoCancelForDeletion } from './deletion';
import { releaseSchedule, scheduleOf, scheduleStateOf } from './schedule';
import { isMissing, isStripeError, type Stripe, stripeClient } from './stripe';
import { settleDuplicate, syncSubscription } from './sync';

export const BILLING_CRON = '10 2 * * *';
export const BILLING_CRON_LIMITS = {
  moves: 200,
  pastDue: 200,
  deletions: 100,
  reverts: 100,
  duplicates: 50,
} as const;
/** Moves are applied this long before the renewal, so the renewal invoice uses the new price. */
export const MOVE_LEAD_MS = 48 * 3600 * 1000;

export interface BillingCronCounts {
  notified: number;
  moved: number;
  skipped: number;
  failed: number;
  /** Notices that couldn't be sent (no address): the move waits, and is skipped at its date. */
  unsent: number;
  plansEnded: number;
  deletionCancels: number;
  /** Stopped moves put back on their old price (Stop's own try failed, or the swap finished after Stop). */
  reverted: number;
  /** Stopped moves the renewal reached before a revert succeeded (an alert: billed at the new price). */
  revertFailed: number;
  /** Restored accounts whose subscription a late deletion request still had set to cancel: renewing again. */
  deletionResumes: number;
  /** Duplicate subscriptions finished (refund and cancel) after an earlier try failed. */
  duplicatesSettled: number;
}

/**
 * Puts a stopped move back on its old price (no proration). 'moot' when there is nothing to put back: the
 * subscription is gone, already on the old price, or moved on to another price by the member's own change.
 * Throws on a Stripe error, so the move stays revert_pending and the next run tries again.
 */
export async function revertMove(stripe: Stripe, r: RevertMove): Promise<'reverted' | 'moot'> {
  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(r.stripeSubscriptionId, { expand: ['schedule'] });
  } catch (err) {
    if (isMissing(err)) return 'moot';
    throw err;
  }
  if (!PLAN_KEEPING_STATUSES.includes(sub.status as SubscriptionStatus)) return 'moot';
  await releaseIfFinished(stripe, sub);
  const item = sub.items.data[0];
  if (!item || sub.items.data.length !== 1) return 'moot';
  const current = typeof item.price === 'string' ? item.price : item.price.id;
  if (current === r.fromPriceId) return 'moot';
  if (r.toPriceId && current !== r.toPriceId) return 'moot';
  await stripe.subscriptions.update(
    r.stripeSubscriptionId,
    { items: [{ id: item.id, price: r.fromPriceId }], proration_behavior: 'none' },
    { idempotencyKey: `revert:${r.moveId}` },
  );
  return 'reverted';
}

/** Reverts one move and records it. False when Stripe failed (the move stays revert_pending). */
export async function revertAndMark(
  env: Env,
  stripe: Stripe,
  r: RevertMove,
  requestId: string,
): Promise<boolean> {
  try {
    const out = await revertMove(stripe, r);
    await billingDb.moveMark(env, r.moveId, 'reverted');
    if (out === 'reverted') {
      await syncSubscription(env, stripe, r.stripeSubscriptionId, requestId).catch((err) =>
        logError(requestId, 'price_revert_sync', err),
      );
    }
    return true;
  } catch (err) {
    logError(requestId, 'price_revert', err);
    return false;
  }
}

/**
 * The Stripe update was sent and its outcome is unknown (timeout, network error, 5xx): the move stays claimed
 * ('moving'), so the next run retakes it (the swap is idempotent: already on `to` counts as swapped) or, if the
 * change was stopped meanwhile, reverts it.
 */
export class UnknownSwapOutcome extends Error {
  constructor(cause: unknown) {
    super('unknown_swap_outcome', { cause });
    this.name = 'UnknownSwapOutcome';
  }
}

/**
 * Puts a subscription's item on `to` without proration. 'swapped' also when it's already on `to` (an earlier
 * try went through but its answer was lost); 'changed' when it's on any other price; 'gone' when it ended.
 */
export async function swapPrice(
  stripe: Stripe,
  subscriptionId: string,
  from: string,
  to: string,
  idempotencyKey: string,
): Promise<'swapped' | 'changed' | 'gone'> {
  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['schedule'] });
  } catch (err) {
    if (isMissing(err)) return 'gone';
    throw err;
  }
  if (!PLAN_KEEPING_STATUSES.includes(sub.status as SubscriptionStatus)) return 'gone';
  const item = sub.items.data[0];
  const current = item ? (typeof item.price === 'string' ? item.price : item.price.id) : null;
  if (item && current === to && sub.items.data.length === 1) return 'swapped';
  if (!item || current !== from || sub.items.data.length !== 1) return 'changed';
  // A downgrade or switch still to come: its phases would undo the swap, so the sweep plans again after it runs.
  const state = scheduleStateOf(await scheduleOf(stripe, sub));
  // A schedule made outside Zephyr is never touched: the move is skipped (logged by the caller as changed).
  if (state?.kind === 'pending' || state?.kind === 'foreign') return 'changed';
  // Stripe won't change the price of a subscription a schedule manages: release one whose change already happened.
  if (state?.kind === 'finished') await releaseSchedule(stripe, state.id);
  try {
    await stripe.subscriptions.update(
      subscriptionId,
      { items: [{ id: item.id, price: to }], proration_behavior: 'none' },
      { idempotencyKey },
    );
  } catch (err) {
    // A clear refusal (4xx from Stripe: bad request, card or permission) means nothing changed; anything else
    // may have gone through.
    if (isStripeRefusal(err)) throw err;
    throw new UnknownSwapOutcome(err);
  }
  return 'swapped';
}

/** Releases the subscription's schedule if its change already happened (before a price update). */
async function releaseIfFinished(stripe: Stripe, sub: Stripe.Subscription) {
  const state = scheduleStateOf(await scheduleOf(stripe, sub));
  if (state?.kind === 'finished') await releaseSchedule(stripe, state.id);
}

/** A Stripe 4xx (other than 409 and 429): the request was refused and nothing changed. */
function isStripeRefusal(err: unknown): boolean {
  if (!isStripeError(err)) return false;
  const status = (err as { statusCode?: number }).statusCode ?? 0;
  return status >= 400 && status < 500 && status !== 409 && status !== 429;
}

async function notify(env: Env, m: DueMove, requestId: string): Promise<boolean> {
  // Never "notified" without a notice: with no address the move stays pending, and the database skips it at
  // its date (a rise is never applied without a notice).
  if (!m.email) return false;
  try {
    await sendEmail(env, {
      to: m.email,
      idempotencyKey: `price-notice:${m.id}`,
      ...priceNoticeEmail({
        plan: m.plan,
        interval: m.interval,
        from: m.fromAmount,
        to: m.toAmount,
        moveAt: m.moveAt,
        appUrl: env.APP_URL,
      }),
    });
    return true;
  } catch (err) {
    logError(requestId, 'price_notice_email', err);
    return false;
  }
}

export async function runBillingCron(
  env: Env,
  requestId = 'cron-billing',
  now = Date.now(),
): Promise<BillingCronCounts> {
  const counts: BillingCronCounts = {
    notified: 0,
    moved: 0,
    skipped: 0,
    failed: 0,
    unsent: 0,
    plansEnded: 0,
    deletionCancels: 0,
    reverted: 0,
    revertFailed: 0,
    deletionResumes: 0,
    duplicatesSettled: 0,
  };
  // Past-due plans end without Stripe (the database's own cap), so this runs even when Stripe isn't set up.
  await endPastDuePlans(env, requestId, counts);
  const stripe = stripeClient(env);
  if (!stripe) return counts;
  await retryDeletionCancels(env, requestId, counts);
  await retryDeletionResumes(env, requestId, counts);
  await retryDuplicates(env, stripe, requestId, counts);
  await retryReverts(env, stripe, requestId, counts);
  let due: DueMove[];
  try {
    due = await billingDb.movesDue(env, BILLING_CRON_LIMITS.moves);
  } catch (err) {
    logError(requestId, 'price_moves_due', err);
    return counts;
  }
  for (const m of due) {
    try {
      if (m.status === 'pending') {
        // A notice first, always: a move is never applied without one, even when it's already close.
        if (await notify(env, m, requestId)) {
          await billingDb.moveMark(env, m.id, 'notified');
          counts.notified += 1;
        } else if (!m.email) counts.unsent += 1;
        else counts.failed += 1;
        continue;
      }
      if (new Date(m.moveAt).getTime() - now > MOVE_LEAD_MS) continue;
      // Claimed under the move's row lock first, so a Stop meanwhile can't be lost: Stop leaves claimed moves
      // alone, and marking one moved after Stop sends it to revert_pending.
      if (!(await billingDb.moveClaim(env, m.id))) continue;
      let r: Awaited<ReturnType<typeof swapPrice>>;
      try {
        r = await swapPrice(stripe, m.stripeSubscriptionId, m.fromPriceId, m.toPriceId, `move:${m.id}`);
      } catch (err) {
        // Certainly not swapped: release the claim for the next run. Unknown: keep the claim (see
        // UnknownSwapOutcome); the next run retakes it after an hour, or reverts it if the change was stopped.
        if (!(err instanceof UnknownSwapOutcome))
          await billingDb.moveMark(env, m.id, 'notified').catch(() => undefined);
        throw err;
      }
      if (r === 'swapped') {
        const after = await billingDb.moveMark(env, m.id, 'moved');
        if (after?.status === 'revert_pending') {
          // Stopped while we swapped: put it back now (the next run retries if this fails).
          const back = {
            moveId: m.id,
            stripeSubscriptionId: m.stripeSubscriptionId,
            fromPriceId: m.fromPriceId,
          };
          if (await revertAndMark(env, stripe, { ...back, toPriceId: m.toPriceId }, requestId))
            counts.reverted += 1;
          continue;
        }
        counts.moved += 1;
        await syncSubscription(env, stripe, m.stripeSubscriptionId, requestId, m.ownerId).catch((err) =>
          logError(requestId, 'price_move_sync', err),
        );
      } else {
        // Plan, interval or status changed since the notice: the sweep re-checks it from scratch.
        await billingDb.moveMark(env, m.id, 'skipped');
        counts.skipped += 1;
      }
    } catch (err) {
      counts.failed += 1;
      logError(requestId, 'price_move', err);
    }
  }
  // Reverts owed since the first pass (a stale claim whose target was replaced, or one finished after Stop) get a
  // try now, before tomorrow's first pass could count them as failed.
  await retryReverts(env, stripe, requestId, counts, false);
  return counts;
}

/** Plans whose past_due outlasted the grace period: the database ends them; the owners get the usual email. */
async function endPastDuePlans(env: Env, requestId: string, counts: BillingCronCounts) {
  try {
    for (const r of await billingDb.pastDueExpire(env, BILLING_CRON_LIMITS.pastDue)) {
      counts.plansEnded += 1;
      if (!r.email) continue;
      await sendEmail(env, {
        to: r.email,
        idempotencyKey: `plan-ended:${r.ownerId}:${new Date().toISOString().slice(0, 10)}`,
        ...planEndedEmail({ appUrl: env.APP_URL }),
      }).catch((err) => logError(requestId, 'billing_plan_ended_email', err));
    }
  } catch (err) {
    logError(requestId, 'billing_past_due_expire', err);
  }
}

/** Reverts Stop still owes. Any that the renewal reached first are counted and alerted (billed at the new price). */
async function retryReverts(
  env: Env,
  stripe: Stripe,
  requestId: string,
  counts: BillingCronCounts,
  fail = true,
) {
  try {
    const due = await billingDb.revertsDue(env, BILLING_CRON_LIMITS.reverts, fail);
    if (due.failed > 0) {
      counts.revertFailed += due.failed;
      logError(requestId, 'price_revert_failed', new Error(String(due.failed)));
    }
    for (const r of due.reverts) {
      if (await revertAndMark(env, stripe, r, requestId)) counts.reverted += 1;
      else counts.failed += 1;
    }
  } catch (err) {
    logError(requestId, 'price_move_reverts_due', err);
  }
}

/** Accounts pending deletion whose subscription still renews: ask Stripe again (release, then cancel). */
async function retryDeletionCancels(env: Env, requestId: string, counts: BillingCronCounts) {
  try {
    for (const r of await billingDb.deletionCancelsDue(env, BILLING_CRON_LIMITS.deletions)) {
      try {
        await cancelForDeletion(env, r.ownerId, { stripeSubscriptionId: r.stripeSubscriptionId });
        counts.deletionCancels += 1;
      } catch (err) {
        counts.failed += 1;
        logError(requestId, 'deletion_billing_cancel_retry', err);
      }
    }
  } catch (err) {
    logError(requestId, 'billing_deletion_cancels_due', err);
  }
}

/** Restored accounts still set to cancel by a deletion request (a late cancel, or a failed resume): renew again. */
async function retryDeletionResumes(env: Env, requestId: string, counts: BillingCronCounts) {
  try {
    for (const r of await billingDb.deletionResumesDue(env, BILLING_CRON_LIMITS.deletions)) {
      try {
        await undoCancelForDeletion(env, r.ownerId, { stripeSubscriptionId: r.stripeSubscriptionId });
        counts.deletionResumes += 1;
      } catch (err) {
        counts.failed += 1;
        logError(requestId, 'deletion_billing_resume_retry', err);
      }
    }
  } catch (err) {
    logError(requestId, 'billing_deletion_resumes_due', err);
  }
}

/** Recorded duplicates an earlier try didn't finish: cancel, void open invoices, then refund (only these rows). */
async function retryDuplicates(env: Env, stripe: Stripe, requestId: string, counts: BillingCronCounts) {
  try {
    for (const d of await billingDb.duplicatesUnsettled(env, BILLING_CRON_LIMITS.duplicates)) {
      try {
        let sub: Stripe.Subscription;
        try {
          sub = await stripe.subscriptions.retrieve(d.stripeSubscriptionId);
        } catch (err) {
          if (!isMissing(err)) throw err;
          // Gone in Stripe: nothing left to cancel or refund.
          await billingDb.duplicateMark(env, d.stripeSubscriptionId, 'refunded');
          await billingDb.duplicateMark(env, d.stripeSubscriptionId, 'canceled');
          continue;
        }
        await settleDuplicate(env, stripe, sub, { refunded: d.refunded, canceled: d.canceled });
        counts.duplicatesSettled += 1;
      } catch (err) {
        counts.failed += 1;
        logError(requestId, 'billing_duplicate_retry', err);
      }
    }
  } catch (err) {
    logError(requestId, 'billing_duplicates_unsettled', err);
  }
}
