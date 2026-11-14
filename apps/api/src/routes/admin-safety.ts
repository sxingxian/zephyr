/**
 * /admin/api/v1/safety/* (docs/phase-8.md › Safety). Staff never get photo bytes except through a reveal grant:
 * one staff member, 10 minutes, a re-encoded preview of at most 1600 px, `no-store`, never a held photo, logged
 * with a reason by the database.
 *
 *   GET  /safety?state=                     safetyView
 *   GET  /safety/reports/:id                safetyView
 *   POST /safety/reports/:id/reveal         safetyAct · passkey (a reveal is the one way to see member photos)
 *   POST /safety/reports/:id/resolve        safetyAct (lowers risk: saves at once)
 *   GET  /safety/reveal/:grant/:photo?t=    safetyAct, and only the grant's own staff member (checked in SQL)
 *   POST /safety/holds/:id/report           holdsRecord          (:id is the held photo's id)
 *   POST /safety/holds/:id/release          holdsRelease · passkey · Owners emailed
 */
import {
  type AdminReportResult,
  type AdminRevealResult,
  type AdminSafetyResult,
  adminHoldReportSchema,
  adminReasonSchema,
  adminResolveSchema,
  adminSafetyQuerySchema,
  revealTokenSchema,
} from '@zephyr/shared';
import { base64url, sha256, toPgBytea } from '../crypto';
import { fail, logError, readBody } from '../http';
import { stores } from '../library/objects';
import { mediaHeaders } from '../share/media';
import { rpc } from '../supabase';
import {
  type AdminRouter,
  adminWriteLimit,
  type Ctx,
  can,
  dbError,
  idParam,
  isDbError,
  needsReauth,
  type RequireStaff,
  reauth,
  serverError,
  staffId,
  tellOwners,
} from './admin-common';

export const REVEAL_MAX_EDGE = 1600;
const REVEAL_SOURCE_MAX_BYTES = 40 * 1024 * 1024;

interface RevealGrant {
  grantId: string;
  expiresAt: string;
  photoIds: string[];
}

/** 32 random bytes, base64url (43 characters). Only its SHA-256 reaches the database. */
export function newRevealToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
const tokenHash = async (token: string) => toPgBytea(await sha256(token));

async function overview(c: Ctx, state: 'open' | 'resolved' = 'open') {
  const out = await rpc<Omit<AdminSafetyResult, 'ok'>>(c.env, 'admin_safety', {
    p_staff: staffId(c),
    p_state: state,
  });
  if (isDbError(out)) return dbError(c, out);
  return c.json({ ok: true, ...out } satisfies AdminSafetyResult);
}

export function registerAdminSafetyRoutes(router: AdminRouter, requireStaff: RequireStaff) {
  router.use('/v1/safety/*', requireStaff(), adminWriteLimit);

  router.get('/v1/safety', can('safetyView'), async (c) => {
    const q = adminSafetyQuerySchema.safeParse(c.req.query());
    if (!q.success) return c.json(fail('invalid'), 400);
    try {
      return await overview(c, q.data.state);
    } catch (err) {
      return serverError(c, 'admin_safety', err);
    }
  });

  router.get('/v1/safety/reports/:id', can('safetyView'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    try {
      const report = await rpc<AdminReportResult['report'] | null>(c.env, 'admin_report', {
        p_staff: staffId(c),
        p_id: id,
      });
      if (isDbError(report)) return dbError(c, report);
      if (!report) return c.json(fail('not_found'), 404);
      return c.json({ ok: true, report } satisfies AdminReportResult);
    } catch (err) {
      return serverError(c, 'admin_report', err);
    }
  });

  router.post('/v1/safety/reports/:id/reveal', can('safetyAct'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminReasonSchema);
    if (!body) return c.json(fail('invalid'), 400);
    if (needsReauth(c)) return reauth(c);
    const token = newRevealToken();
    try {
      const grant = await rpc<RevealGrant | null>(c.env, 'admin_reveal', {
        p_staff: staffId(c),
        p_report: id,
        p_reason: body.reason,
        p_token_hash: await tokenHash(token),
      });
      if (isDbError(grant)) return dbError(c, grant);
      if (!grant) return c.json(fail('not_found'), 404);
      const base = `/admin/api/v1/safety/reveal/${encodeURIComponent(grant.grantId)}`;
      const res = c.json({
        ok: true,
        grantId: grant.grantId,
        expiresAt: grant.expiresAt,
        photos: grant.photoIds.map((p) => ({
          id: p,
          url: `${base}/${encodeURIComponent(p)}?t=${encodeURIComponent(token)}`,
        })),
        token,
      } satisfies AdminRevealResult);
      res.headers.set('Cache-Control', 'no-store');
      return res;
    } catch (err) {
      return serverError(c, 'admin_reveal', err);
    }
  });

  router.get('/v1/safety/reveal/:grant/:photo', can('safetyAct'), async (c) => {
    const grant = idParam(c, 'grant');
    const photo = idParam(c, 'photo');
    const t = revealTokenSchema.safeParse(c.req.query('t') ?? '');
    // Same 404 for every refusal: wrong token, someone else's grant, expired, held, not in the grant.
    if (!grant || !photo || !t.success) return c.json(fail('not_found'), 404);
    try {
      const ok = await rpc<{ key: string } | null>(c.env, 'reveal_grant_check', {
        p_grant: grant,
        p_token_hash: await tokenHash(t.data),
        p_staff: staffId(c),
        p_photo: photo,
      });
      if (!ok || isDbError(ok) || typeof ok.key !== 'string') return c.json(fail('not_found'), 404);
      const obj = await stores(c.env).photos.get(ok.key);
      if (!obj) return c.json(fail('not_found'), 404);
      if (obj.size > REVEAL_SOURCE_MAX_BYTES) {
        await obj.body.cancel().catch(() => undefined);
        return c.json(fail('not_found'), 404);
      }
      let jpeg: Response;
      try {
        // Re-encoding drops the metadata (EXIF, GPS) and caps the size.
        const out = await c.env.IMAGES.input(obj.body)
          .transform({ width: REVEAL_MAX_EDGE, height: REVEAL_MAX_EDGE, fit: 'scale-down' })
          .output({ format: 'image/jpeg', quality: 85 });
        jpeg = out.response();
      } catch (err) {
        logError(c.get('requestId'), 'reveal_transform', err);
        return c.json(fail('server'), 502);
      }
      if (!jpeg.body) return c.json(fail('server'), 502);
      const h = new Headers();
      mediaHeaders(h, 'image/jpeg', jpeg.headers.get('Content-Length'), true);
      h.set('Referrer-Policy', 'no-referrer');
      h.set('Expires', '0');
      return c.body(jpeg.body, 200, Object.fromEntries(h));
    } catch (err) {
      return serverError(c, 'reveal_media', err);
    }
  });

  router.post('/v1/safety/reports/:id/resolve', can('safetyAct'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminResolveSchema);
    if (!body) return c.json(fail('invalid'), 400);
    try {
      const out = await rpc<unknown>(c.env, 'admin_report_resolve', {
        p_staff: staffId(c),
        p_report: id,
        p_actions: body.actions,
        p_note: body.note,
      });
      if (isDbError(out)) return dbError(c, out);
      if (out === null || out === false) return c.json(fail('not_found'), 404);
      return await overview(c);
    } catch (err) {
      return serverError(c, 'admin_report_resolve', err);
    }
  });

  router.post('/v1/safety/holds/:id/report', can('holdsRecord'), async (c) => {
    const photo = idParam(c);
    if (!photo) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminHoldReportSchema);
    if (!body) return c.json(fail('invalid'), 400);
    try {
      const out = await rpc<unknown>(c.env, 'admin_hold_report', {
        p_staff: staffId(c),
        p_photo: photo,
        p_authority: body.authority,
        p_reference: body.reference,
      });
      if (isDbError(out)) return dbError(c, out);
      if (out === null || out === false) return c.json(fail('not_found'), 404);
      return await overview(c);
    } catch (err) {
      return serverError(c, 'admin_hold_report', err);
    }
  });

  router.post('/v1/safety/holds/:id/release', can('holdsRelease'), async (c) => {
    const photo = idParam(c);
    if (!photo) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminReasonSchema);
    if (!body) return c.json(fail('invalid'), 400);
    if (needsReauth(c)) return reauth(c);
    try {
      const out = await rpc<unknown>(c.env, 'admin_hold_release', {
        p_staff: staffId(c),
        p_photo: photo,
        p_reason: body.reason,
      });
      if (isDbError(out)) return dbError(c, out);
      if (out === null || out === false) return c.json(fail('not_found'), 404);
      await tellOwners(c, { kind: 'hold_released', photoId: photo }, body.reason);
      return await overview(c);
    } catch (err) {
      return serverError(c, 'admin_hold_release', err);
    }
  });
}
