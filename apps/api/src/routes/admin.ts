import {
  type AdminInviteResult,
  type AdminSessionResponse,
  adminEmailStartSchema,
  adminInviteSchema,
  type DecideResult,
  decideSchema,
  emailVerifySchema,
  type InviteCodeRow,
  type InviteRequestRow,
  type InviteRow,
  inviteCodeCreateSchema,
  listQuerySchema,
  type Page,
  type PasskeyOptions,
  passkeyVerifySchema,
  type SignupSettings,
  type SignupsOverview,
  signupSettingsPatchSchema,
} from '@zephyr/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { accessEmail } from '../auth/access';
import { CODE_WINDOW, padReply, reserveCodeAttempt, resetCodeAttempts } from '../auth/code-limits';
import { type GoTrueSession, gotrue } from '../auth/gotrue';
import {
  adminSeenCookie,
  adminSeenIsFresh,
  appendCookies,
  endSession,
  recentlyAuthenticated,
  resolveSession,
  sessionCookies,
  signedInWithPasskey,
  verifyAccessToken,
} from '../auth/session';
import { ceremonyMatches } from '../auth/webauthn';
import { newInviteToken } from '../crypto';
import { notifyPasskeyChange } from '../email/notify';
import { list } from '../env';
import {
  background,
  burstOk,
  clientNetwork,
  emailHash,
  fail,
  guardWrite,
  limitHit,
  logError,
  networkHash,
  rateLimited,
  readBody,
} from '../http';
import { rpc, UpstreamError } from '../supabase';
import type { HonoEnv, StaffContext } from '../types';
import { registerAdminAiRoutes } from './admin-ai';
import { registerAdminBillingRoutes } from './admin-billing';
import { registerAdminStorageRoutes } from './admin-storage';
import { sendInvite } from './invites';

const WINDOW = 15 * 60;
const WRITERS = new Set(['owner', 'admin']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StaffRow {
  role: StaffContext['role'];
  email: string;
  displayName: string | null;
}
interface CreateResult {
  status: string;
  id?: string;
  expiresAt?: string;
}

/** /admin/api/v1/*: the admin console. Cloudflare Access → staff session → passkey. */
export const adminRoutes = new Hono<HonoEnv>();

// 1. Every admin request must carry a valid Cloudflare Access identity.
adminRoutes.use('*', async (c, next) => {
  const email = await accessEmail(c);
  if (!email) return c.json(fail('forbidden'), 403);
  c.set('accessEmail', email);
  await next();
});
// 2. Writes: same-origin JSON only.
adminRoutes.use(
  '*',
  guardWrite((env) => list(env.ADMIN_ORIGINS), 20 * 1024),
);

/**
 * 3. A staff session whose email matches the Access identity, active in the last 30 minutes.
 * enrolOnly sessions (email code, no passkey yet) may only enrol a passkey.
 */
export function requireStaff(
  opts: { allowEnrol?: boolean; write?: boolean } = {},
): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const s = await resolveSession(c, 'admin');
    if (!s) return c.json(fail('unauthenticated'), 401);
    if (!(await adminSeenIsFresh(c, s.userId))) {
      await endSession(c, 'admin', s.accessToken);
      return c.json(fail('unauthenticated'), 401);
    }
    let staff: StaffRow | null;
    try {
      staff = await rpc<StaffRow | null>(c.env, 'staff_lookup', { p_user_id: s.userId });
    } catch (err) {
      logError(c.get('requestId'), 'staff_lookup', err);
      return c.json(fail('server'), 500);
    }
    if (!staff || staff.email.toLowerCase() !== c.get('accessEmail')) {
      await endSession(c, 'admin', s.accessToken);
      return c.json(fail('forbidden'), 403);
    }
    const enrolOnly = !signedInWithPasskey(s.claims);
    if (enrolOnly && !opts.allowEnrol) return c.json(fail('passkey_required'), 403);
    if (opts.write && !WRITERS.has(staff.role)) return c.json(fail('forbidden'), 403);
    c.set('staff', {
      id: s.userId,
      email: staff.email.toLowerCase(),
      role: staff.role,
      displayName: staff.displayName ?? null,
      enrolOnly,
      accessToken: s.accessToken,
      recentPasskey: !enrolOnly && recentlyAuthenticated(s.claims),
    });
    appendCookies(c, [await adminSeenCookie(c.env, s.userId)]);
    await next();
  };
}

const sessionBody = (
  st: Pick<StaffContext, 'id' | 'email' | 'role' | 'displayName' | 'enrolOnly'>,
): AdminSessionResponse => ({
  ok: true,
  staff: { id: st.id, email: st.email, role: st.role, displayName: st.displayName },
  enrolOnly: st.enrolOnly,
});

/** Starts an admin session from a fresh GoTrue session, enforcing staff + Access identity. */
async function startStaffSession(
  c: Context<HonoEnv>,
  session: GoTrueSession,
  mode: 'email' | 'passkey',
): Promise<Response> {
  const claims = await verifyAccessToken(c.env, session.access_token);
  if (!claims) throw new UpstreamError('auth:token', 502, 'unverifiable');
  const staff = await rpc<StaffRow | null>(c.env, 'staff_lookup', { p_user_id: claims.sub });
  const deny = async (error: 'forbidden' | 'passkey_required') => {
    try {
      await gotrue.logout(c.env, session.access_token);
    } catch {
      /* ignore */
    }
    return c.json(fail(error), 403);
  };
  if (!staff || staff.email.toLowerCase() !== c.get('accessEmail')) return deny('forbidden');
  const passkeyAuth = signedInWithPasskey(claims);
  if (mode === 'passkey' && !passkeyAuth) return deny('forbidden');
  if (mode === 'email' && (await gotrue.adminListPasskeys(c.env, claims.sub)).length > 0)
    return deny('passkey_required');

  appendCookies(c, [...sessionCookies('admin', session), await adminSeenCookie(c.env, claims.sub)]);
  return c.json(
    sessionBody({
      id: claims.sub,
      email: staff.email.toLowerCase(),
      role: staff.role,
      displayName: staff.displayName ?? null,
      enrolOnly: !passkeyAuth,
    }),
  );
}

// ---- auth --------------------------------------------------------------------------------------------
/**
 * Email codes are for first sign-in only: staff with no passkey yet, signing in as their own Access
 * identity. Everyone else gets the same 202 and no email.
 */
adminRoutes.post('/v1/auth/email/start', async (c) => {
  if (!(await burstOk(c, 'admin_email'))) return rateLimited(c, 60);
  const body = await readBody(c, adminEmailStartSchema);
  if (!body) return c.json(fail('invalid'), 400);
  const requestId = c.get('requestId');
  try {
    if (!(await limitHit(c.env, 'admin_email_start', await networkHash(c), 5, WINDOW)))
      return rateLimited(c, WINDOW);
    if (!(await limitHit(c.env, 'admin_email_addr', await emailHash(c.env, body.email), 3, WINDOW))) {
      return rateLimited(c, WINDOW);
    }
    const accessIdentity = c.get('accessEmail');
    const network = clientNetwork(c);
    await background(c, async () => {
      try {
        if (body.email !== accessIdentity) return;
        const uid = await rpc<string | null>(c.env, 'user_id_by_email', { p_email: body.email });
        if (!uid || !(await rpc<boolean>(c.env, 'is_staff', { p_user_id: uid }))) return;
        if ((await gotrue.adminListPasskeys(c.env, uid)).length > 0) return;
        await gotrue.sendEmailCode(c.env, body.email);
        await resetCodeAttempts(c.env, 'admin', body.email, network);
      } catch (err) {
        logError(requestId, 'admin_email_send', err);
      }
    });
    return c.json({ ok: true }, 202);
  } catch (err) {
    logError(requestId, 'admin_email_start', err);
    return c.json(fail('server'), 500);
  }
});

/**
 * Only the Access identity's own address is checked, and only staff accounts reach Auth. Each attempt
 * is reserved before Auth sees it (see auth/code-limits.ts).
 */
adminRoutes.post('/v1/auth/email/verify', async (c) => {
  const startedAt = Date.now();
  if (!(await burstOk(c, 'admin_email'))) return rateLimited(c, 60);
  const body = await readBody(c, emailVerifySchema);
  if (!body) return c.json(fail('invalid'), 400);
  const requestId = c.get('requestId');
  const wrongCode = async () => {
    await padReply(startedAt);
    return c.json(fail('invalid_code'), 400);
  };
  try {
    // Someone else's address: nothing is counted against it (no locking colleagues out).
    if (body.email !== c.get('accessEmail')) return wrongCode();
    if (!(await reserveCodeAttempt(c, 'admin', body.email))) return rateLimited(c, CODE_WINDOW);
    if ((await rpc<string>(c.env, 'account_kind', { p_email: body.email })) !== 'staff') return wrongCode();
    let session: GoTrueSession;
    try {
      session = await gotrue.verifyEmailCode(c.env, body.email, body.code);
    } catch (err) {
      if (err instanceof UpstreamError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        return wrongCode();
      }
      throw err;
    }
    return await startStaffSession(c, session, 'email');
  } catch (err) {
    logError(requestId, 'admin_email_verify', err);
    return c.json(fail('server'), 500);
  }
});

adminRoutes.post('/v1/auth/passkey/options', async (c) => {
  if (!(await burstOk(c, 'admin_passkey'))) return rateLimited(c, 60);
  try {
    const ch = await gotrue.passkeyAuthOptions(c.env);
    return c.json({ challengeId: ch.challenge_id, options: ch.options } satisfies PasskeyOptions);
  } catch (err) {
    logError(c.get('requestId'), 'admin_passkey_options', err);
    return c.json(fail('server'), 500);
  }
});

adminRoutes.post('/v1/auth/passkey/verify', async (c) => {
  if (!(await burstOk(c, 'admin_passkey'))) return rateLimited(c, 60);
  const body = await readBody(c, passkeyVerifySchema);
  if (!body) return c.json(fail('invalid'), 400);
  if (!ceremonyMatches(c, body.credential, 'webauthn.get', list(c.env.ADMIN_ORIGINS))) {
    return c.json(fail('passkey_failed'), 400);
  }
  try {
    let session: GoTrueSession;
    try {
      session = await gotrue.passkeyAuthVerify(c.env, body.challengeId, body.credential);
    } catch (err) {
      if (err instanceof UpstreamError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        return c.json(fail('passkey_failed'), 400);
      }
      throw err;
    }
    return await startStaffSession(c, session, 'passkey');
  } catch (err) {
    logError(c.get('requestId'), 'admin_passkey_verify', err);
    return c.json(fail('server'), 500);
  }
});

adminRoutes.get('/v1/auth/session', requireStaff({ allowEnrol: true }), (c) =>
  c.json(sessionBody(c.get('staff'))),
);

adminRoutes.post('/v1/auth/sign-out', async (c) => {
  const s = await resolveSession(c, 'admin');
  await endSession(c, 'admin', s?.accessToken);
  c.header('Clear-Site-Data', '"cache"');
  return c.body(null, 204);
});

// ---- passkey enrolment -------------------------------------------------------------------------------
/**
 * An enrol-only session (email code) may add the *first* passkey only. Once a staff member has one,
 * more keys need a full (passkey) session, so an email code can never add a second key.
 */
const enrolAllowed: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const staff = c.get('staff');
  if (staff.enrolOnly) {
    try {
      if ((await gotrue.adminListPasskeys(c.env, staff.id)).length > 0) {
        return c.json(fail('passkey_required'), 403);
      }
    } catch (err) {
      logError(c.get('requestId'), 'admin_passkey_count', err);
      return c.json(fail('server'), 500);
    }
  }
  await next();
};

adminRoutes.post('/v1/me/passkeys/options', requireStaff({ allowEnrol: true }), enrolAllowed, async (c) => {
  try {
    const ch = await gotrue.passkeyRegisterOptions(c.env, c.get('staff').accessToken);
    return c.json({ challengeId: ch.challenge_id, options: ch.options } satisfies PasskeyOptions);
  } catch (err) {
    logError(c.get('requestId'), 'admin_passkey_reg_options', err);
    return c.json(fail('server'), 500);
  }
});

/**
 * Saves the passkey and emails the staff member about it. The current session stays enrol-only (it
 * was made with an email code); the console opens after the next sign-in with the new passkey.
 */
adminRoutes.post('/v1/me/passkeys/verify', requireStaff({ allowEnrol: true }), enrolAllowed, async (c) => {
  const body = await readBody(c, passkeyVerifySchema);
  if (!body) return c.json(fail('invalid'), 400);
  if (!ceremonyMatches(c, body.credential, 'webauthn.create', list(c.env.ADMIN_ORIGINS))) {
    return c.json(fail('passkey_failed'), 400);
  }
  const staff = c.get('staff');
  try {
    const pk = await gotrue.passkeyRegisterVerify(
      c.env,
      staff.accessToken,
      body.challengeId,
      body.credential,
    );
    await notifyPasskeyChange(c, staff.email, 'added', pk?.friendly_name ?? null, 'the Zephyr admin console');
    return c.json(sessionBody(staff), 201);
  } catch (err) {
    if (err instanceof UpstreamError && err.status >= 400 && err.status < 500 && err.status !== 429) {
      return c.json(fail('passkey_failed'), 400);
    }
    logError(c.get('requestId'), 'admin_passkey_reg_verify', err);
    return c.json(fail('server'), 500);
  }
});

// ---- Sign-ups & invites -------------------------------------------------------------------------------
adminRoutes.get('/v1/signups', requireStaff(), async (c) => {
  try {
    const out = await rpc<Omit<SignupsOverview, 'ok'>>(c.env, 'get_signup_overview');
    return c.json({ ok: true, ...out } satisfies SignupsOverview);
  } catch (err) {
    logError(c.get('requestId'), 'signups_overview', err);
    return c.json(fail('server'), 500);
  }
});

adminRoutes.patch('/v1/signups/settings', requireStaff({ write: true }), async (c) => {
  const body = await readBody(c, signupSettingsPatchSchema);
  if (!body) return c.json(fail('invalid'), 400);
  const staff = c.get('staff');
  // Only an Owner may switch the mode; an Admin may re-save it unchanged. The database decides.
  const { reason, ...patch } = body;
  try {
    const out = await rpc<{ status: string; settings?: SignupSettings }>(c.env, 'update_signup_settings', {
      p_actor: staff.id,
      p_patch: patch,
      p_reason: reason ?? null,
    });
    if (out.status === 'forbidden') return c.json(fail('forbidden'), 403);
    if (out.status !== 'ok' || !out.settings) return c.json(fail('server'), 500);
    return c.json({ ok: true, ...out.settings });
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 400) return c.json(fail('invalid'), 400);
    logError(c.get('requestId'), 'signups_settings', err);
    return c.json(fail('server'), 500);
  }
});

const listQuery = (c: Context<HonoEnv>) =>
  listQuerySchema.safeParse({
    status: c.req.query('status') || undefined,
    cursor: c.req.query('cursor') || undefined,
  });

adminRoutes.get('/v1/signups/invites', requireStaff(), async (c) => {
  const q = listQuery(c);
  if (!q.success) return c.json(fail('invalid'), 400);
  try {
    const out = await rpc<{ items: InviteRow[]; nextCursor: string | null }>(c.env, 'list_invites', {
      p_status: q.data.status ?? null,
      p_cursor: q.data.cursor ?? null,
      p_limit: 50,
    });
    return c.json({
      ok: true,
      items: out.items,
      nextCursor: out.nextCursor ?? null,
    } satisfies Page<InviteRow>);
  } catch (err) {
    logError(c.get('requestId'), 'invites_list', err);
    return c.json(fail('server'), 500);
  }
});

const emailField = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((e) => e.toLowerCase());

adminRoutes.post('/v1/signups/invites', requireStaff({ write: true }), async (c) => {
  const body = await readBody(c, adminInviteSchema);
  if (!body) return c.json(fail('invalid'), 400);
  const staff = c.get('staff');
  const requestId = c.get('requestId');
  const result: AdminInviteResult = { ok: true, sent: 0, skipped: [] };
  const seen = new Set<string>();
  for (const raw of body.emails) {
    const parsed = emailField.safeParse(raw);
    if (!parsed.success) {
      result.skipped.push({ email: raw.slice(0, 254), reason: 'invalid' });
      continue;
    }
    const email = parsed.data;
    if (seen.has(email)) continue;
    seen.add(email);
    try {
      const { token, hash } = await newInviteToken();
      const res = await rpc<CreateResult>(c.env, 'create_invite', {
        p_email: email,
        p_token_hash: hash,
        p_source: 'admin',
        p_invited_by: staff.id,
        p_code_id: null,
        p_note: body.note ?? null,
      });
      if (res.status === 'already_member' || res.status === 'already_invited' || res.status === 'invalid') {
        result.skipped.push({ email, reason: res.status });
        continue;
      }
      if (res.status === 'signups_paused') return c.json(fail('signups_paused'), 409);
      if (res.status !== 'created' || !res.id || !res.expiresAt) throw new Error('UnexpectedResult');
      try {
        await sendInvite(c.env, email, token, res.expiresAt, null, body.note ?? null, res.id);
        result.sent += 1;
      } catch (err) {
        logError(requestId, 'admin_invite_send', err);
        await rpc(c.env, 'revoke_invite', { p_actor: staff.id, p_id: res.id });
        result.skipped.push({ email, reason: 'send_failed' });
      }
    } catch (err) {
      logError(requestId, 'admin_invite', err);
      return c.json(fail('server'), 500);
    }
  }
  return c.json(result);
});

adminRoutes.post('/v1/signups/invites/:id/resend', requireStaff({ write: true }), async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('invalid'), 400);
  const staff = c.get('staff');
  try {
    const { token, hash } = await newInviteToken();
    const out = await rpc<{
      status: string;
      invite?: InviteRow;
      email?: string;
      inviterName?: string | null;
    }>(c.env, 'resend_invite', { p_actor: staff.id, p_id: id, p_token_hash: hash });
    if (out.status === 'forbidden') return c.json(fail('forbidden'), 403);
    if (out.status === 'signups_paused') return c.json(fail('signups_paused'), 409);
    if (out.status === 'already_member') return c.json(fail('already_member'), 409);
    if (out.status === 'superseded') return c.json(fail('conflict'), 409);
    if (out.status !== 'ok' || !out.invite || !out.email) return c.json(fail('not_found'), 404);
    await sendInvite(c.env, out.email, token, out.invite.expiresAt, out.inviterName ?? null, null);
    return c.json({ ok: true, invite: out.invite });
  } catch (err) {
    logError(c.get('requestId'), 'admin_invite_resend', err);
    return c.json(fail('server'), 500);
  }
});

adminRoutes.post('/v1/signups/invites/:id/revoke', requireStaff({ write: true }), async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('invalid'), 400);
  try {
    const out = await rpc<{ status: string; invite?: InviteRow }>(c.env, 'revoke_invite', {
      p_actor: c.get('staff').id,
      p_id: id,
    });
    if (out.status === 'forbidden') return c.json(fail('forbidden'), 403);
    if (out.status !== 'ok' || !out.invite) return c.json(fail('not_found'), 404);
    return c.json({ ok: true, invite: out.invite });
  } catch (err) {
    logError(c.get('requestId'), 'admin_invite_revoke', err);
    return c.json(fail('server'), 500);
  }
});

adminRoutes.post('/v1/signups/codes', requireStaff({ write: true }), async (c) => {
  const body = await readBody(c, inviteCodeCreateSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const out = await rpc<{ status: string; code?: InviteCodeRow }>(c.env, 'create_invite_code', {
      p_actor: c.get('staff').id,
      p_code: body.code,
      p_label: body.label ?? null,
      p_max_uses: body.maxUses,
      p_expires_at: body.expiresAt ?? null,
    });
    if (out.status === 'forbidden') return c.json(fail('forbidden'), 403);
    if (out.status === 'conflict') return c.json(fail('conflict'), 409);
    if (out.status !== 'ok' || !out.code) return c.json(fail('invalid'), 400);
    return c.json({ ok: true, code: out.code }, 201);
  } catch (err) {
    logError(c.get('requestId'), 'admin_code_create', err);
    return c.json(fail('server'), 500);
  }
});

adminRoutes.post('/v1/signups/codes/:id/revoke', requireStaff({ write: true }), async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('invalid'), 400);
  try {
    const out = await rpc<{ status: string; code?: InviteCodeRow }>(c.env, 'revoke_invite_code', {
      p_actor: c.get('staff').id,
      p_id: id,
    });
    if (out.status === 'forbidden') return c.json(fail('forbidden'), 403);
    if (out.status !== 'ok' || !out.code) return c.json(fail('not_found'), 404);
    return c.json({ ok: true, code: out.code });
  } catch (err) {
    logError(c.get('requestId'), 'admin_code_revoke', err);
    return c.json(fail('server'), 500);
  }
});

adminRoutes.get('/v1/signups/requests', requireStaff(), async (c) => {
  const q = listQuery(c);
  if (!q.success) return c.json(fail('invalid'), 400);
  try {
    const out = await rpc<{ items: InviteRequestRow[]; nextCursor: string | null }>(
      c.env,
      'list_invite_requests',
      {
        p_status: q.data.status ?? null,
        p_cursor: q.data.cursor ?? null,
        p_limit: 50,
      },
    );
    return c.json({
      ok: true,
      items: out.items,
      nextCursor: out.nextCursor ?? null,
    } satisfies Page<InviteRequestRow>);
  } catch (err) {
    logError(c.get('requestId'), 'requests_list', err);
    return c.json(fail('server'), 500);
  }
});

/**
 * Approving sends each person an invite. If an email can't be sent, its invite is revoked and the
 * request goes back to pending, so nothing is approved without an invite going out.
 */
adminRoutes.post('/v1/signups/requests/decide', requireStaff({ write: true }), async (c) => {
  const body = await readBody(c, decideSchema);
  if (!body) return c.json(fail('invalid'), 400);
  const staff = c.get('staff');
  const requestId = c.get('requestId');
  try {
    const out = await rpc<{ status: string; approved?: { id: string; email: string }[]; declined?: number }>(
      c.env,
      'decide_invite_requests',
      { p_actor: staff.id, p_ids: body.ids, p_decision: body.decision },
    );
    if (out.status === 'forbidden') return c.json(fail('forbidden'), 403);
    if (out.status !== 'ok') return c.json(fail('invalid'), 400);
    let approved = 0;
    for (const r of out.approved ?? []) {
      const { token, hash } = await newInviteToken();
      const res = await rpc<CreateResult>(c.env, 'create_invite', {
        p_email: r.email,
        p_token_hash: hash,
        p_source: 'request',
        p_invited_by: staff.id,
        p_code_id: null,
        p_note: null,
      });
      if (res.status === 'already_member' || res.status === 'already_invited') {
        approved += 1;
        continue;
      }
      if (res.status !== 'created' || !res.id || !res.expiresAt) {
        await rpc(c.env, 'reopen_invite_request', { p_actor: staff.id, p_id: r.id });
        continue;
      }
      try {
        await sendInvite(c.env, r.email, token, res.expiresAt, null, null, res.id);
        approved += 1;
      } catch (err) {
        logError(requestId, 'request_invite_send', err);
        await rpc(c.env, 'revoke_invite', { p_actor: staff.id, p_id: res.id });
        await rpc(c.env, 'reopen_invite_request', { p_actor: staff.id, p_id: r.id });
      }
    }
    return c.json({ ok: true, approved, declined: out.declined ?? 0 } satisfies DecideResult);
  } catch (err) {
    logError(requestId, 'requests_decide', err);
    return c.json(fail('server'), 500);
  }
});

// ---- Zephyr AI (phase 6) ---------------------------------------------------------------------------
registerAdminAiRoutes(adminRoutes, requireStaff);

// ---- Plans & billing (phase 7) ---------------------------------------------------------------------------
registerAdminBillingRoutes(adminRoutes, requireStaff);
// Phase 8: Admin › Storage.
registerAdminStorageRoutes(adminRoutes, requireStaff);
