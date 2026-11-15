/**
 * Phase 8 (review round 3): step-up codes for account-level changes.
 *
 * Google's AdSense script runs inside the app's page for Free members and acts with their session, so a recent
 * sign-in no longer proves the member asked for a change. While a member may be shown AdSense
 * (`step_up_needed`), adding or removing a passkey and deleting the account also need a one-time code emailed to
 * the account, sent in STEP_UP_HEADER, bound to that operation (supabase/migrations/20261115100200_step_up.sql).
 * Members who aren't shown AdSense keep the recent-sign-in check alone.
 *
 * Codes are 6 random digits, stored only as HMAC(SESSION_HMAC_SECRET, "stepup|member|op|code"): single use,
 * 10 minutes, burnt after 5 wrong tries, at most 5 an hour per operation (plus the per-network burst limit).
 */
import {
  STEP_UP_CODE_LENGTH,
  STEP_UP_CODE_MINUTES,
  STEP_UP_CODE_RE,
  STEP_UP_HEADER,
  type StepUpOp,
} from '@zephyr/shared';
import type { Context } from 'hono';
import { hmac, toPgBytea } from '../crypto';
import { sendEmail } from '../email/resend';
import { stepUpEmail } from '../email/templates';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';

type Ctx = Context<HonoEnv>;

/** Whether this member's account-level changes need a step-up code right now. Throws if it can't tell. */
export async function stepUpNeeded(c: Ctx): Promise<boolean> {
  return (await rpc<boolean | null>(c.env, 'step_up_needed', { p_user: c.get('session').userId })) === true;
}

const codeHash = async (c: Ctx, op: StepUpOp, code: string) =>
  toPgBytea(await hmac(`stepup|${c.get('session').userId}|${op}|${code}`, c.env.SESSION_HMAC_SECRET));
/** The hash a passkey_add grant is stored under: ties the verify call to the challenge its options carried. */
export const grantHash = async (c: Ctx, op: StepUpOp, challengeId: string) =>
  toPgBytea(
    await hmac(`stepup-grant|${c.get('session').userId}|${op}|${challengeId}`, c.env.SESSION_HMAC_SECRET),
  );

/** Uniform random digits (rejection sampling, so no digit is likelier than another). */
export function newStepUpCode(length = STEP_UP_CODE_LENGTH): string {
  const limit = 10 ** length;
  const ceiling = Math.floor(0x1_0000_0000 / limit) * limit;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const n = buf[0] ?? 0;
    if (n < ceiling) return String(n % limit).padStart(length, '0');
  }
}

/** Sends a fresh code for `op` to the member's account address. 'ok' or 'rate_limited'. Throws on other failures. */
export async function issueStepUp(c: Ctx, op: StepUpOp): Promise<'ok' | 'rate_limited'> {
  const code = newStepUpCode();
  const out = await rpc<string>(c.env, 'step_up_issue', {
    p_user: c.get('session').userId,
    p_op: op,
    p_hash: await codeHash(c, op, code),
  });
  if (out === 'rate_limited') return 'rate_limited';
  if (out !== 'ok') throw new Error(`step_up_issue: ${String(out)}`);
  const to = c.get('session').email;
  if (!to) throw new Error('step_up: no account email');
  await sendEmail(c.env, { to, ...stepUpEmail({ code, op, minutes: STEP_UP_CODE_MINUTES }) });
  return 'ok';
}

/**
 * Checks (and spends) the code in STEP_UP_HEADER for `op`. 'missing' when there's no code in the request,
 * 'invalid' when it's wrong, expired, used or for another operation. `grant`: on success, also record a grant
 * (passkey_add: the registration challenge id).
 */
export async function checkStepUp(
  c: Ctx,
  op: StepUpOp,
  grant?: string,
): Promise<'ok' | 'missing' | 'invalid'> {
  const code = c.req.header(STEP_UP_HEADER)?.trim();
  if (!code) return 'missing';
  if (!STEP_UP_CODE_RE.test(code)) return 'invalid';
  const out = await rpc<string>(c.env, 'step_up_check', {
    p_user: c.get('session').userId,
    p_op: op,
    p_hash: await codeHash(c, op, code),
    p_grant: grant ? await grantHash(c, op, grant) : null,
  });
  return out === 'ok' ? 'ok' : 'invalid';
}

/** Spends the grant a successful check left for this challenge. */
export async function useStepUpGrant(c: Ctx, op: StepUpOp, challengeId: string): Promise<boolean> {
  return (
    (await rpc<boolean | null>(c.env, 'step_up_grant_use', {
      p_user: c.get('session').userId,
      p_op: op,
      p_grant: await grantHash(c, op, challengeId),
    })) === true
  );
}
