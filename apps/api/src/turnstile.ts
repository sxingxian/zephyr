import type { Env } from './env';
import { list } from './env';

interface SiteverifyResponse {
  success: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
}

export const TURNSTILE_ACTION = 'invite_request';

/**
 * Verifies a Turnstile token server-side. A token is valid only once, only for our hostnames and only
 * for the invite-request action. Returns false on any failure, including network errors.
 */
export async function verifyTurnstile(env: Env, token: string, ip: string | null): Promise<boolean> {
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
    return out.action === TURNSTILE_ACTION;
  } catch {
    return false;
  }
}
