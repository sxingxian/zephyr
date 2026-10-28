import { TURNSTILE_ACTIONS } from '@zephyr/shared';
import type { Env } from './env';
import { list } from './env';

interface SiteverifyResponse {
  success: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
}

/** One Turnstile action per form, so a token solved for one form can't be replayed on another. */
export { TURNSTILE_ACTIONS };
export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];
/** @deprecated use TURNSTILE_ACTIONS.inviteRequest */
export const TURNSTILE_ACTION = TURNSTILE_ACTIONS.inviteRequest;

/**
 * Verifies a Turnstile token server-side. A token is valid only once, only for our hostnames and only
 * for the expected action. Returns false on any failure, including network errors.
 */
export async function verifyTurnstile(
  env: Env,
  token: string,
  ip: string | null,
  action: TurnstileAction = TURNSTILE_ACTIONS.inviteRequest,
): Promise<boolean> {
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  body.append('idempotency_key', crypto.randomUUID());
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const out = (await res.json()) as SiteverifyResponse;
    if (!out.success) return false;
    const hosts = list(env.TURNSTILE_EXPECTED_HOSTNAMES);
    if (!out.hostname || !hosts.includes(out.hostname)) return false;
    return out.action === action;
  } catch {
    return false;
  }
}
