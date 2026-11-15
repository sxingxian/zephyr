/**
 * Phase 8 (review round 4): account-level changes complete only from a link emailed to the account.
 *
 * Google's AdSense script runs inside Free members' library pages with their session, so neither a recent sign-in
 * nor a code typed into the app proves the member asked for a change. Adding or removing a passkey and deleting the
 * account are therefore only requested in Settings (`issueAccountAction`): the member's account address gets a
 * single-use link to `/account-action/<nonce>#t=<token>`, and the change is made on that page, which sends the token in
 * ACCOUNT_ACTION_HEADER (`useAccountAction`). A passkey created there comes from the member's own authenticator,
 * so a link the script asked for gives it nothing (supabase/migrations/20261115100200_account_actions.sql).
 *
 * Tokens are 32 random bytes (base64url), stored only as HMAC(SESSION_HMAC_SECRET, "acct-action|token"): bound to
 * the member, the change and (passkey_remove) the passkey; 15 minutes; single use; never retired by a newer link;
 * 5 an hour and 10 a day per change, plus the per-network burst limit. Never logged, never in a response.
 */
import {
  ACCOUNT_ACTION_HEADER,
  ACCOUNT_ACTION_MINUTES,
  ACCOUNT_ACTION_TOKEN_RE,
  type AccountActionOp,
  accountActionLink,
} from '@zephyr/shared';
import type { Context } from 'hono';
import { base64url, hmac, toPgBytea } from '../crypto';
import { sendEmail } from '../email/resend';
import { accountActionEmail } from '../email/templates';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';

type Ctx = Context<HonoEnv>;

const tokenHash = async (c: Ctx, token: string) =>
  toPgBytea(await hmac(`acct-action|${token}`, c.env.SESSION_HMAC_SECRET));
/** The hash a passkey_add grant is stored under: ties the verify call to the challenge its options carried. */
const grantHash = async (c: Ctx, challengeId: string) =>
  toPgBytea(
    await hmac(`acct-action-grant|${c.get('session').userId}|${challengeId}`, c.env.SESSION_HMAC_SECRET),
  );

/**
 * Emails a fresh link for `op` (and, for passkey_remove, `passkeyId`) to the member's account address.
 * 'ok' or 'rate_limited'. Throws on other failures.
 */
export async function issueAccountAction(
  c: Ctx,
  op: AccountActionOp,
  passkeyId: string | null,
  passkeyName: string | null,
): Promise<'ok' | 'rate_limited'> {
  const to = c.get('session').email;
  if (!to) throw new Error('account_action: no account email');
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const out = await rpc<string>(c.env, 'account_action_issue', {
    p_user: c.get('session').userId,
    p_op: op,
    p_passkey: passkeyId,
    p_hash: await tokenHash(c, token),
  });
  if (out === 'rate_limited') return 'rate_limited';
  if (out !== 'ok') throw new Error(`account_action_issue: ${String(out)}`);
  // A fresh, non-secret nonce in the path (review round 5): the link's address then always differs from any page
  // the AdSense script could have set with history.replaceState, so opening it is a new document, never a
  // same-document fragment change the script's page would see.
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const link = accountActionLink(c.env.APP_URL, nonce, token);
  await sendEmail(c.env, {
    to,
    ...accountActionEmail({ op, link, minutes: ACCOUNT_ACTION_MINUTES, passkeyName }),
  });
  return 'ok';
}

/** What a link will do, without spending it. */
export async function peekAccountAction(
  c: Ctx,
  token: string,
): Promise<
  | { kind: 'ok'; op: AccountActionOp; passkeyId: string | null; expiresAt: string }
  | { kind: 'wrong_member' }
  | { kind: 'invalid' }
> {
  const out = await rpc<{
    op?: AccountActionOp;
    passkeyId?: string | null;
    expiresAt?: string;
    error?: string;
  } | null>(c.env, 'account_action_peek', {
    p_user: c.get('session').userId,
    p_hash: await tokenHash(c, token),
  });
  if (!out) return { kind: 'invalid' };
  if (out.error === 'wrong_member') return { kind: 'wrong_member' };
  if (!out.op || !out.expiresAt) return { kind: 'invalid' };
  return { kind: 'ok', op: out.op, passkeyId: out.passkeyId ?? null, expiresAt: out.expiresAt };
}

/**
 * Checks the link in ACCOUNT_ACTION_HEADER is open, this member's and for `op`, without spending it. Used before
 * any upstream call (GoTrue), so a bogus or someone else's header never creates anything there (review round 5).
 */
export async function checkAccountAction(
  c: Ctx,
  op: AccountActionOp,
): Promise<'ok' | 'missing' | 'wrong_member' | 'invalid'> {
  const token = c.req.header(ACCOUNT_ACTION_HEADER)?.trim();
  if (!token) return 'missing';
  if (!ACCOUNT_ACTION_TOKEN_RE.test(token)) return 'invalid';
  const p = await peekAccountAction(c, token);
  if (p.kind !== 'ok') return p.kind;
  return p.op === op ? 'ok' : 'invalid';
}

/**
 * Spends the link in ACCOUNT_ACTION_HEADER for `op` (and passkey). 'missing' when the request carries none;
 * 'wrong_member' when it was sent to another account; 'invalid' when it's malformed, unknown, expired, used,
 * replaced, or for another change or passkey. `challengeId` (passkey_add): on success, also record a grant that
 * only the verify call for that very challenge can use.
 */
export async function useAccountAction(
  c: Ctx,
  op: AccountActionOp,
  opts: { passkeyId?: string; challengeId?: string } = {},
): Promise<'ok' | 'missing' | 'wrong_member' | 'invalid'> {
  const token = c.req.header(ACCOUNT_ACTION_HEADER)?.trim();
  if (!token) return 'missing';
  if (!ACCOUNT_ACTION_TOKEN_RE.test(token)) return 'invalid';
  const out = await rpc<string>(c.env, 'account_action_use', {
    p_user: c.get('session').userId,
    p_op: op,
    p_passkey: opts.passkeyId ?? null,
    p_hash: await tokenHash(c, token),
    p_grant: opts.challengeId ? await grantHash(c, opts.challengeId) : null,
  });
  return out === 'ok' ? 'ok' : out === 'wrong_member' ? 'wrong_member' : 'invalid';
}

/** Spends the grant a passkey_add link left for this challenge. */
export async function useAccountActionGrant(c: Ctx, challengeId: string): Promise<boolean> {
  return (
    (await rpc<boolean | null>(c.env, 'account_action_grant_use', {
      p_user: c.get('session').userId,
      p_grant: await grantHash(c, challengeId),
    })) === true
  );
}
