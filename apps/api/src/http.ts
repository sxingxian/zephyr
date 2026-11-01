import type { ApiError, ApiErrorCode } from '@zephyr/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import { hashIp, hmac, toPgBytea } from './crypto';
import type { Env } from './env';
import { networkKey } from './ip';
import { rpc, UpstreamError } from './supabase';
import type { HonoEnv } from './types';

export type Vars = { requestId: string };
export type AppCtx = Context<{ Bindings: Env; Variables: Vars & Record<string, unknown> }>;

export const fail = (
  error: ApiErrorCode | 'not_accepting' | 'method_not_allowed',
  extra: Partial<ApiError> = {},
) => ({ ok: false, error, ...extra }) as ApiError;

/** Logs without personal data: never emails, IPs, tokens or request bodies. */
export function logError(requestId: string, where: string, err: unknown) {
  const detail =
    err instanceof UpstreamError
      ? `${err.where} ${err.status}${err.code ? ` ${err.code}` : ''}`
      : err instanceof Error
        ? err.name
        : 'unknown';
  console.error(JSON.stringify({ level: 'error', requestId, where, detail }));
}

/**
 * CSRF and abuse guard for state-changing requests: the Origin must be on the allow-list and the
 * body must be JSON (a cross-site form can't send either). GET/HEAD pass through.
 */
export function guardWrite(allowed: (env: Env) => string[], maxBytes = 4 * 1024): MiddlewareHandler {
  const limit = bodyLimit({ maxSize: maxBytes, onError: (c) => c.json(fail('invalid'), 413) });
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    const origin = c.req.header('Origin');
    if (!origin || !allowed(c.env as Env).includes(origin)) return c.json(fail('forbidden'), 403);
    const hasBody = c.req.method !== 'DELETE' || (c.req.header('Content-Length') ?? '0') !== '0';
    if (hasBody && !(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json(fail('invalid'), 415);
    }
    return limit(c, next);
  };
}

/** Parses the JSON body with a zod schema. Null on malformed JSON or failed validation. */
export async function readBody<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.output<S> | null> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export const clientIp = (c: Context) => c.req.header('CF-Connecting-IP') ?? null;
/** The client's network (IPv4 address or IPv6 /64), the unit every per-client limit counts. */
export const clientNetwork = (c: Context) => networkKey(clientIp(c)) ?? 'unknown';

/** Cheap first line: the per-location burst limiter (10 per minute per network). */
export async function burstOk(c: Context<HonoEnv>, scope: string): Promise<boolean> {
  const res = await c.env.BURST_LIMITER.limit({ key: `${scope}:${clientNetwork(c)}` });
  return res.success;
}

export const networkHash = async (c: Context<HonoEnv>) =>
  toPgBytea(await hashIp(clientNetwork(c), c.env.IP_HASH_SECRET));
/**
 * The hash of the client's customer network: the same as `networkHash` for IPv4, the /48 for IPv6.
 * Used where a limit aims to stop one person minting identities or flooding a queue:
 * - the new-guest cap per gallery (20 guest identities a day): a collision needs two guests of the same
 *   gallery inside one /48, and the cap is generous;
 * - the guest report limit (10 a day): one person mustn't flood Safety and owners from a /48 of /64s; a
 *   collision only defers a report with a "try later".
 * Passcode attempts stay per /64 (`networkHash`): the gallery-wide cap (25 per 15 minutes, then a pause)
 * already bounds guessing however many networks are used, and a /48 key would push a whole carrier pool
 * to the Turnstile check after one guest's typos.
 */
export const customerNetworkHash = async (c: Context<HonoEnv>) =>
  toPgBytea(await hashIp(networkKey(clientIp(c), 48) ?? 'unknown', c.env.IP_HASH_SECRET));
export const emailHash = async (env: Env, email: string) =>
  toPgBytea(await hmac(`email:${email.trim().toLowerCase()}`, env.IP_HASH_SECRET));

/** Durable, global limit (Postgres). True if this attempt is allowed (and it's counted). */
export const limitHit = (env: Env, kind: string, keyHash: string, limit: number, windowSeconds: number) =>
  rpc<boolean>(env, 'rate_limit_hit', {
    p_kind: kind,
    p_key: keyHash,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });

export function rateLimited(c: Context, seconds: number) {
  c.header('Retry-After', String(seconds));
  return c.json(fail('rate_limited', { retryAfter: seconds }), 429);
}

/**
 * Runs work after the response when the runtime allows it (Workers' waitUntil), so replies take the
 * same time whether or not an email was sent. Falls back to awaiting it (tests, local scripts).
 */
export async function background(c: Context, work: () => Promise<void>): Promise<void> {
  const p = work().catch(() => undefined);
  let ctx: ExecutionContext | undefined;
  try {
    ctx = c.executionCtx as ExecutionContext;
  } catch {
    ctx = undefined;
  }
  if (ctx) ctx.waitUntil(p);
  else await p;
}
