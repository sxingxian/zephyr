/**
 * Shared pieces of the phase 8 admin routes (docs/phase-8.md › API): the role gate (STAFF_CAN, the same table
 * the database re-checks), the passkey re-check for high-risk writes, the per-staff write limit, the Owners'
 * email, and the mapping of database `{ error }` answers to HTTP.
 */
import { type StaffAction, staffCan } from '@zephyr/shared';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { type OwnerChange, ownerChangeEmail } from '../email/admin-templates';
import { sendEmail } from '../email/resend';
import { list } from '../env';
import { background, fail, logError, rateLimited } from '../http';
import { rpc, UpstreamError } from '../supabase';
import type { HonoEnv } from '../types';

export type Ctx = Context<HonoEnv>;
export type RequireStaff = (opts?: { allowEnrol?: boolean; write?: boolean }) => MiddlewareHandler<HonoEnv>;
export type AdminRouter = Hono<HonoEnv>;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 403 unless the staff member's role allows `action`. */
export const can =
  (action: StaffAction): MiddlewareHandler<HonoEnv> =>
  async (c, next) => {
    if (!staffCan(c.get('staff').role, action)) return c.json(fail('forbidden'), 403);
    await next();
  };

/** High-risk writes: a passkey sign-in in the last 10 minutes, or 403 `reauth_required` (the app re-prompts). */
export const needsReauth = (c: Ctx) => !c.get('staff').recentPasskey;
export const reauth = (c: Ctx) => c.json(fail('reauth_required'), 403);

/** Admin writes: 60 a minute per staff member (ADMIN_LIMITER). Reads aren't limited here. */
export const adminWriteLimit: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  const staff = c.get('staff');
  if (!(await c.env.ADMIN_LIMITER.limit({ key: `admin:${staff.id}` })).success) return rateLimited(c, 60);
  await next();
};

export const staffId = (c: Ctx) => c.get('staff').id;
export const actorName = (c: Ctx) => c.get('staff').displayName?.trim() || c.get('staff').email;
export const adminOrigin = (c: Ctx) => (list(c.env.ADMIN_ORIGINS)[0] ?? '').replace(/\/$/, '');

/** Emails every Owner about a high-risk change (after the response; a failure is logged, never shown). */
export async function tellOwners(c: Ctx, change: OwnerChange, reason: string) {
  const env = c.env;
  const requestId = c.get('requestId');
  const actor = actorName(c);
  const adminUrl = adminOrigin(c);
  await background(c, async () => {
    try {
      const owners = await rpc<string[]>(env, 'ai_alert_recipients', { p_who: 'owners' });
      const mail = ownerChangeEmail({ actor, change, reason, adminUrl });
      for (const to of owners ?? []) await sendEmail(env, { to, ...mail });
    } catch (err) {
      logError(requestId, 'admin_owners_email', err);
    }
  });
}

/** A database answer that refused the change. */
export interface DbError {
  error: string;
}
export const isDbError = (v: unknown): v is DbError =>
  typeof v === 'object' && v !== null && typeof (v as DbError).error === 'string';

const STATUS: Record<string, [number, string]> = {
  forbidden: [403, 'forbidden'],
  not_found: [404, 'not_found'],
  last_owner: [409, 'last_owner'],
  conflict: [409, 'conflict'],
  already_exists: [409, 'conflict'],
  already_staff: [409, 'conflict'],
  member_account: [409, 'conflict'],
  unchanged: [409, 'conflict'],
  held: [409, 'conflict'],
  notice: [400, 'invalid'],
  invalid: [400, 'invalid'],
};
/** Maps a database `{ error }` to its HTTP answer (unknown codes are a 400, never echoed). */
export function dbError(c: Ctx, e: DbError) {
  const [status, code] = STATUS[e.error] ?? [400, 'invalid'];
  return c.json(fail(code as Parameters<typeof fail>[0]), status as 400);
}

export function serverError(c: Ctx, where: string, err: unknown) {
  logError(c.get('requestId'), where, err);
  if (err instanceof UpstreamError && err.status === 400) return c.json(fail('invalid'), 400);
  return c.json(fail('server'), 500);
}

/** A path id, lower-cased, or null. */
export const idParam = (c: Ctx, name = 'id') => {
  const v = (c.req.param(name) ?? '').toLowerCase();
  return UUID.test(v) ? v : null;
};
