/**
 * Limits on guessing email sign-in codes (6 digits, 10-minute life).
 *
 * Every attempt is *reserved* atomically in Postgres (rate_limit_hit, under an advisory lock) before
 * Auth is asked to check the code, so parallel requests can't all slip past a read-then-record check.
 * Attempts are counted, not failures.
 *
 *   per (address, network)  5 per 15 min   locks out the guesser's network for that address
 *   per address            25 per 15 min   the global cap, whatever the number of networks
 *
 * The per-address counters are cleared when a new code is sent, so someone burning a victim's
 * attempts can't lock them out of a fresh code. Guesses are still bounded per code, and codes are
 * bounded per address (3 per 15 min and 10 a day for the app), so the odds of guessing stay tiny.
 *
 * App only: the first attempt for an address in a window may skip Turnstile; any further attempt needs
 * a token. That makes burning an address's 25 attempts (to grief, or to guess) cost a solved
 * challenge each, without adding friction to someone who types their code right the first time.
 */
import type { Context } from 'hono';
import { hmac, toPgBytea } from '../crypto';
import type { Env } from '../env';
import { clientNetwork, emailHash, limitHit } from '../http';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';

export const CODE_WINDOW = 15 * 60;
export const CODE_LIMITS = {
  perAddressAndNetwork: 5,
  perAddress: 25,
  /** App: attempts per address per window allowed without a Turnstile token. */
  withoutTurnstile: 1,
} as const;

/** Replies to wrong codes take at least this long, so skipping Auth (no account) isn't visible. */
export const CODE_TIMING = { floorMs: 400 };

export type CodeRealm = 'app' | 'admin';
const KINDS = {
  app: { pair: 'code_pair', addr: 'code_addr', free: 'code_free' },
  admin: { pair: 'admin_code_pair', addr: 'admin_code_addr', free: 'admin_code_free' },
} as const;

const pairHash = async (env: Env, email: string, network: string) =>
  toPgBytea(await hmac(`code:${email.trim().toLowerCase()}|${network}`, env.IP_HASH_SECRET));

/** Uses up one Turnstile-free attempt for the address; false when it's already been used. */
export async function takeFreeAttempt(c: Context<HonoEnv>, realm: CodeRealm, email: string) {
  return limitHit(
    c.env,
    KINDS[realm].free,
    await emailHash(c.env, email),
    CODE_LIMITS.withoutTurnstile,
    CODE_WINDOW,
  );
}

/** Reserves one code attempt for this address from this network. False → over a limit (429). */
export async function reserveCodeAttempt(c: Context<HonoEnv>, realm: CodeRealm, email: string) {
  const k = KINDS[realm];
  if (
    !(await limitHit(
      c.env,
      k.pair,
      await pairHash(c.env, email, clientNetwork(c)),
      CODE_LIMITS.perAddressAndNetwork,
      CODE_WINDOW,
    ))
  ) {
    return false;
  }
  return limitHit(c.env, k.addr, await emailHash(c.env, email), CODE_LIMITS.perAddress, CODE_WINDOW);
}

/**
 * A new code was sent: attempts against the old one stop counting for the address, and for the
 * (address, network) pair that asked for it.
 */
export async function resetCodeAttempts(env: Env, realm: CodeRealm, email: string, network: string) {
  const k = KINDS[realm];
  const addr = await emailHash(env, email);
  await rpc(env, 'rate_limit_reset', { p_kind: k.addr, p_key: addr });
  await rpc(env, 'rate_limit_reset', { p_kind: k.free, p_key: addr });
  await rpc(env, 'rate_limit_reset', { p_kind: k.pair, p_key: await pairHash(env, email, network) });
}

/** Waits until at least CODE_TIMING.floorMs have passed since `startedAt`. */
export async function padReply(startedAt: number) {
  const wait = CODE_TIMING.floorMs - (Date.now() - startedAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
