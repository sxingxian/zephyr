import {
  type AiJobCreateResult,
  type AiJobDetail,
  type AiJobPage,
  type AiJobSummary,
  type AiStatusResult,
  aiJobCreateSchema,
  aiJobRetrySchema,
  aiMemberSettingsSchema,
  aiSignalsSchema,
  type CleanupPage,
  type CreditHistoryPage,
  type CutoutApply,
  cleanupIgnoreSchema,
  DEFAULT_CUTOUT_APPLY,
  deviceClaimSchema,
  deviceProgressSchema,
  FACE_EMBEDDING_DIMS,
  FACE_LIMITS,
  FACE_MODEL_VERSION,
  type FaceSuggestion,
  type FacesPendingPage,
  facesSchema,
  jobListQuerySchema,
  MIN_PERSON_FACES,
  type PersonSummary,
  personFacesSchema,
  personMergeSchema,
  personPatchSchema,
  type SceneSummary,
  SIGNALS_VERSION,
  type SignalsPendingPage,
} from '@zephyr/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { enqueue } from '../ai/consumer';
import { hmac } from '../crypto';
import { list } from '../env';
import { fail, guardWrite, logError, rateLimited, readBody } from '../http';
import { expectedUser, UUID } from '../library/storage';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';
import { requireMember } from './session-helpers';

/**
 * /api/v1/ai/*: Zephyr AI for members (docs/phase-6.md, API). Everything is scoped to the session's member
 * by the database functions, which take the owner id from here, never from the request.
 */
export const aiRoutes = new Hono<HonoEnv>();

type Ctx = Context<HonoEnv>;
const ownerOf = (c: Ctx) => c.get('session').userId;

/** Bodies are small except the faces batch (20 photos × 30 faces × ~700 bytes). */
const FACES_BODY_BYTES = 640 * 1024;
const JSON_BODY_BYTES = 128 * 1024;
const facesGuard = guardWrite((env) => list(env.APP_ORIGINS), FACES_BODY_BYTES);
const jsonGuard = guardWrite((env) => list(env.APP_ORIGINS), JSON_BODY_BYTES);
aiRoutes.use('*', async (c, next) =>
  c.req.path.endsWith('/ai/faces') ? facesGuard(c, next) : jsonGuard(c, next),
);
aiRoutes.use('*', requireMember);
/** Writes: the shared-device check (X-Zephyr-Expected-User) and the per-member AI write limit. */
const writes: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    // Reads have their own, roomier limit: the people list and cleanup pages are the heavier queries.
    if (!(await c.env.AI_READ_LIMITER.limit({ key: `ai-read:${ownerOf(c)}` })).success)
      return rateLimited(c, 60);
    return next();
  }
  if (!(await c.env.AI_LIMITER.limit({ key: `ai:${ownerOf(c)}` })).success) return rateLimited(c, 60);
  // Face batches are matched in Postgres against all of the member's people: kept to 10 a minute.
  if (c.req.method === 'POST' && c.req.path.endsWith('/ai/faces')) {
    if (!(await c.env.FACES_LIMITER.limit({ key: `faces:${ownerOf(c)}` })).success) return rateLimited(c, 60);
  }
  return expectedUser(c, next);
};
aiRoutes.use('*', writes);

/** A stable, non-reversible tag of this sign-in session: device-job leases belong to a session, not a member. */
async function sessionTag(c: Ctx): Promise<string> {
  const s = c.get('session');
  const raw = s.claims.session_id ?? `${s.userId}:${s.claims.iat ?? ''}`;
  const h = await hmac(`ai-session:${raw}`, c.env.IP_HASH_SECRET);
  return [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const serverError = (c: Ctx, where: string, err: unknown) => {
  logError(c.get('requestId'), where, err);
  return c.json(fail('server'), 500);
};
/** Maps the database's {error} codes to HTTP answers. */
function blocked(c: Ctx, error: string | undefined) {
  switch (error) {
    case 'plan':
      return c.json(fail('plan_required'), 403);
    case 'feature_off':
    case 'off':
      return c.json(fail('feature_off'), 403);
    case 'rate_limited':
      return rateLimited(c, 60);
    case 'busy':
      // Another face request of this member holds the faces lock: try again in a few seconds.
      return rateLimited(c, 5);
    case 'held':
    case 'finished':
    case 'lost':
      return c.json(fail('conflict'), 409);
    default:
      return c.json(fail('invalid'), 400);
  }
}

// ---- status, settings, credits -------------------------------------------------------------------------
aiRoutes.get('/', async (c) => {
  try {
    const s = await rpc<Omit<AiStatusResult, 'ok'> | null>(c.env, 'ai_status', { p_owner: ownerOf(c) });
    if (!s) return c.json(fail('not_found'), 404);
    return c.json({ ok: true, ...s } satisfies AiStatusResult);
  } catch (err) {
    return serverError(c, 'ai_status', err);
  }
});

aiRoutes.patch('/settings', async (c) => {
  const body = await readBody(c, aiMemberSettingsSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const s = await rpc<(Omit<AiStatusResult, 'ok'> & { error?: string }) | null>(
      c.env,
      'ai_member_settings_update',
      {
        p_owner: ownerOf(c),
        p_patch: body,
      },
    );
    if (!s) return c.json(fail('not_found'), 404);
    if (s.error) return blocked(c, s.error);
    return c.json({ ok: true, ...s } satisfies AiStatusResult);
  } catch (err) {
    return serverError(c, 'ai_settings', err);
  }
});

aiRoutes.get('/credits', async (c) => {
  const cursor = c.req.query('cursor');
  if (cursor && cursor.length > 200) return c.json(fail('invalid'), 400);
  try {
    const out = await rpc<Omit<CreditHistoryPage, 'ok'> | null>(c.env, 'ai_credit_history', {
      p_owner: ownerOf(c),
      p_cursor: cursor ?? null,
    });
    if (!out) return c.json(fail('not_found'), 404);
    return c.json({ ok: true, ...out } satisfies CreditHistoryPage);
  } catch (err) {
    return serverError(c, 'ai_credits', err);
  }
});

// ---- jobs ------------------------------------------------------------------------------------------------
/** The CutoutApply a job stores: only the fields its background uses. */
function normalApply(a: CutoutApply | undefined): CutoutApply {
  const src = a ?? DEFAULT_CUTOUT_APPLY;
  const out: CutoutApply = { bg: src.bg };
  if (src.bg === 'color') out.color = src.color ?? '#ffffff';
  if ((src.bg === 'white' || src.bg === 'color') && src.shadow && src.shadow !== 'none') {
    out.shadow = src.shadow;
    out.shadowStrength = src.shadowStrength ?? 40;
  }
  return out;
}

async function enqueueItems(c: Ctx, items: string[] | undefined) {
  if (!items?.length) return;
  try {
    await enqueue(
      c.env,
      items.map((item) => ({ t: 'bg', item })),
    );
    await rpc(c.env, 'ai_items_enqueued', { p_ids: items });
  } catch (err) {
    // Left un-enqueued: the 15-minute cron picks them up.
    logError(c.get('requestId'), 'ai_enqueue', err);
  }
}

aiRoutes.get('/jobs', async (c) => {
  const q = jobListQuerySchema.safeParse({
    state: c.req.query('state') || undefined,
    cursor: c.req.query('cursor') || undefined,
  });
  if (!q.success) return c.json(fail('invalid'), 400);
  try {
    const out = await rpc<Omit<AiJobPage, 'ok'>>(c.env, 'ai_jobs_list', {
      p_owner: ownerOf(c),
      p_state: q.data.state,
      p_cursor: q.data.cursor ?? null,
      p_session: await sessionTag(c),
    });
    return c.json({ ok: true, ...out } satisfies AiJobPage);
  } catch (err) {
    return serverError(c, 'ai_jobs_list', err);
  }
});

aiRoutes.post('/jobs', async (c) => {
  const body = await readBody(c, aiJobCreateSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    if (body.kind === 'bg_removal') {
      const out = await rpc<{
        job?: AiJobSummary;
        items?: string[];
        skipped?: AiJobCreateResult['skipped'];
        error?: string;
        needed?: number;
        balance?: number;
      } | null>(c.env, 'ai_bg_job_create', {
        p_owner: ownerOf(c),
        p_photo_ids: body.photoIds,
        p_apply: normalApply(body.apply),
        p_title: body.title ?? null,
        p_force: body.force ?? false,
      });
      if (!out) return c.json(fail('not_found'), 404);
      if (out.error === 'insufficient_credits') {
        return c.json(
          fail('insufficient_credits', { needed: out.needed ?? 0, balance: out.balance ?? 0 }),
          402,
        );
      }
      if (out.error === 'no_photos') return c.json({ ...fail('invalid'), skipped: out.skipped ?? [] }, 400);
      if (out.error || !out.job) return blocked(c, out.error);
      await enqueueItems(c, out.items);
      return c.json({ ok: true, job: out.job, skipped: out.skipped ?? [] } satisfies AiJobCreateResult, 201);
    }
    const out = await rpc<{
      job?: AiJobSummary;
      skipped?: AiJobCreateResult['skipped'];
      error?: string;
    } | null>(c.env, 'ai_device_job_create', {
      p_owner: ownerOf(c),
      p_photo_ids: body.photoIds,
      p_params: body.params,
      p_title: body.title ?? null,
      p_device: body.device,
      p_session: await sessionTag(c),
    });
    if (!out) return c.json(fail('not_found'), 404);
    if (out.error === 'no_photos') return c.json({ ...fail('invalid'), skipped: out.skipped ?? [] }, 400);
    if (out.error || !out.job) return blocked(c, out.error);
    return c.json({ ok: true, job: out.job, skipped: out.skipped ?? [] } satisfies AiJobCreateResult, 201);
  } catch (err) {
    return serverError(c, 'ai_job_create', err);
  }
});

aiRoutes.get('/jobs/:id', async (c) => {
  const id = c.req.param('id');
  const cursor = c.req.query('cursor');
  if (!UUID.test(id) || (cursor !== undefined && !/^\d{1,6}$/.test(cursor)))
    return c.json(fail('not_found'), 404);
  try {
    const out = await rpc<Omit<AiJobDetail, 'ok'> | null>(c.env, 'ai_job_get', {
      p_owner: ownerOf(c),
      p_job: id,
      p_after: cursor === undefined ? null : Number(cursor),
      p_session: await sessionTag(c),
    });
    if (!out) return c.json(fail('not_found'), 404);
    return c.json({ ok: true, ...out } satisfies AiJobDetail);
  } catch (err) {
    return serverError(c, 'ai_job_get', err);
  }
});

aiRoutes.delete('/jobs/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  try {
    const out = await rpc<{ job: AiJobSummary } | null>(c.env, 'ai_job_cancel', {
      p_owner: ownerOf(c),
      p_job: id,
      p_session: await sessionTag(c),
    });
    if (!out) return c.json(fail('not_found'), 404);
    return c.json({ ok: true, job: out.job });
  } catch (err) {
    return serverError(c, 'ai_job_cancel', err);
  }
});

aiRoutes.post('/jobs/:id/retry', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  const body = await readBody(c, aiJobRetrySchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const out = await rpc<{
      job?: AiJobSummary;
      items?: string[];
      error?: string;
      needed?: number;
      balance?: number;
    } | null>(c.env, 'ai_job_retry', {
      p_owner: ownerOf(c),
      p_job: id,
      p_items: body.itemIds ?? null,
      p_session: await sessionTag(c),
    });
    if (!out) return c.json(fail('not_found'), 404);
    if (out.error === 'insufficient_credits') {
      return c.json(
        fail('insufficient_credits', { needed: out.needed ?? 0, balance: out.balance ?? 0 }),
        402,
      );
    }
    if (out.error || !out.job) return blocked(c, out.error);
    await enqueueItems(c, out.items);
    return c.json({ ok: true, job: out.job });
  } catch (err) {
    return serverError(c, 'ai_job_retry', err);
  }
});

aiRoutes.post('/jobs/:id/claim', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  const body = await readBody(c, deviceClaimSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const out = await rpc<{
      job?: AiJobSummary;
      remaining?: string[];
      error?: string;
      holder?: string;
    } | null>(c.env, 'ai_device_claim', {
      p_owner: ownerOf(c),
      p_job: id,
      p_device: body.device,
      p_session: await sessionTag(c),
    });
    if (!out) return c.json(fail('not_found'), 404);
    if (out.error === 'held') return c.json(fail('conflict', { holder: out.holder ?? '' }), 409);
    if (out.error || !out.job) return blocked(c, out.error);
    return c.json({ ok: true, job: out.job, remaining: out.remaining ?? [] });
  } catch (err) {
    return serverError(c, 'ai_device_claim', err);
  }
});

aiRoutes.post('/jobs/:id/progress', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  const body = await readBody(c, deviceProgressSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const out = await rpc<{ job?: AiJobSummary; error?: string } | null>(c.env, 'ai_device_progress', {
      p_owner: ownerOf(c),
      p_job: id,
      p_session: await sessionTag(c),
      p_done: body.done ?? [],
      p_failed: body.failed ?? [],
    });
    if (!out) return c.json(fail('not_found'), 404);
    if (out.error || !out.job) return blocked(c, out.error);
    return c.json({ ok: true, job: out.job });
  } catch (err) {
    return serverError(c, 'ai_device_progress', err);
  }
});

aiRoutes.post('/jobs/:id/pause', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  try {
    const out = await rpc<{ job: AiJobSummary } | null>(c.env, 'ai_device_pause', {
      p_owner: ownerOf(c),
      p_job: id,
      p_session: await sessionTag(c),
    });
    if (!out) return c.json(fail('not_found'), 404);
    return c.json({ ok: true, job: out.job });
  } catch (err) {
    return serverError(c, 'ai_device_pause', err);
  }
});

// ---- signals and cleanup ---------------------------------------------------------------------------------
const cursorOf = (c: Ctx) => {
  const v = c.req.query('cursor');
  return v && v.length <= 200 ? v : null;
};

aiRoutes.get('/signals/pending', async (c) => {
  try {
    const out = await rpc<Omit<SignalsPendingPage, 'ok'>>(c.env, 'ai_signals_pending', {
      p_owner: ownerOf(c),
      p_version: SIGNALS_VERSION,
      p_cursor: cursorOf(c),
    });
    return c.json({ ok: true, ...out } satisfies SignalsPendingPage);
  } catch (err) {
    return serverError(c, 'ai_signals_pending', err);
  }
});

aiRoutes.post('/signals', async (c) => {
  const body = await readBody(c, aiSignalsSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const saved = await rpc<number>(c.env, 'ai_signals_save', {
      p_owner: ownerOf(c),
      p_version: body.v,
      p_items: body.photos,
    });
    return c.json({ ok: true, saved });
  } catch (err) {
    return serverError(c, 'ai_signals_save', err);
  }
});

aiRoutes.get('/cleanup', async (c) => {
  try {
    const out = await rpc<Omit<CleanupPage, 'ok'> & { error?: string }>(c.env, 'ai_cleanup_page', {
      p_owner: ownerOf(c),
      p_cursor: cursorOf(c),
    });
    if (out.error) return blocked(c, out.error);
    return c.json({ ok: true, photos: out.photos, nextCursor: out.nextCursor } satisfies CleanupPage);
  } catch (err) {
    return serverError(c, 'ai_cleanup', err);
  }
});

aiRoutes.post('/cleanup/ignore', async (c) => {
  const body = await readBody(c, cleanupIgnoreSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    await rpc(c.env, 'ai_cleanup_ignore', { p_owner: ownerOf(c), p_kind: body.kind, p_ids: body.photoIds });
    return c.json({ ok: true });
  } catch (err) {
    return serverError(c, 'ai_cleanup_ignore', err);
  }
});

// ---- scenes ----------------------------------------------------------------------------------------------
aiRoutes.get('/scenes', async (c) => {
  try {
    const scenes = await rpc<SceneSummary[]>(c.env, 'ai_scenes', { p_owner: ownerOf(c) });
    return c.json({ ok: true, scenes });
  } catch (err) {
    return serverError(c, 'ai_scenes', err);
  }
});

// ---- faces and people ------------------------------------------------------------------------------------
aiRoutes.get('/faces/pending', async (c) => {
  try {
    const out = await rpc<Omit<FacesPendingPage, 'ok'> & { error?: string }>(c.env, 'ai_faces_pending', {
      p_owner: ownerOf(c),
      p_version: FACE_MODEL_VERSION,
      p_cursor: cursorOf(c),
    });
    if (out.error) return blocked(c, out.error);
    return c.json({ ok: true, ...out } satisfies FacesPendingPage);
  } catch (err) {
    return serverError(c, 'ai_faces_pending', err);
  }
});

/**
 * Decodes a face code (128 little-endian float32, base64) and L2-normalises it into a pgvector literal.
 * Null for anything that isn't 128 finite numbers with a real length.
 */
export function embeddingLiteral(b64: string): string | null {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  if (bin.length !== FACE_EMBEDDING_DIMS * 4) return null;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const v = new Array<number>(FACE_EMBEDDING_DIMS);
  let norm = 0;
  for (let i = 0; i < FACE_EMBEDDING_DIMS; i++) {
    const x = view.getFloat32(i * 4, true);
    if (!Number.isFinite(x) || Math.abs(x) > 1e6) return null;
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm);
  if (!(norm > 1e-6)) return null;
  return `[${v.map((x) => (x / norm).toPrecision(7)).join(',')}]`;
}

aiRoutes.post('/faces', async (c) => {
  const body = await readBody(c, facesSchema);
  if (!body) return c.json(fail('invalid'), 400);
  const items = body.photos.map((p) => ({
    id: p.id,
    faces: p.faces.flatMap((f) => {
      const embedding = embeddingLiteral(f.embedding);
      return embedding ? [{ box: f.box, score: f.score, embedding }] : [];
    }),
  }));
  try {
    const out = await rpc<{ saved?: number; error?: string }>(c.env, 'ai_faces_add', {
      p_owner: ownerOf(c),
      p_version: body.v,
      p_match: FACE_LIMITS.match,
      p_items: items,
    });
    if (out.error) return blocked(c, out.error);
    return c.json({ ok: true, saved: out.saved ?? 0 });
  } catch (err) {
    return serverError(c, 'ai_faces_add', err);
  }
});

aiRoutes.delete('/faces', async (c) => {
  try {
    await rpc(c.env, 'ai_faces_delete_all', { p_owner: ownerOf(c) });
    return c.body(null, 204);
  } catch (err) {
    return serverError(c, 'ai_faces_delete', err);
  }
});

aiRoutes.get('/people', async (c) => {
  try {
    const out = await rpc<{ people?: PersonSummary[]; error?: string }>(c.env, 'ai_people_list', {
      p_owner: ownerOf(c),
      p_hidden: c.req.query('hidden') === '1',
      p_min: MIN_PERSON_FACES,
    });
    if (out.error) return blocked(c, out.error);
    return c.json({ ok: true, people: out.people ?? [] });
  } catch (err) {
    return serverError(c, 'ai_people', err);
  }
});

aiRoutes.get('/people/suggestions', async (c) => {
  try {
    const out = await rpc<{ suggestions?: FaceSuggestion[]; error?: string }>(c.env, 'ai_face_suggestions', {
      p_owner: ownerOf(c),
      p_sure: FACE_LIMITS.sure,
    });
    if (out.error) return blocked(c, out.error);
    return c.json({ ok: true, suggestions: out.suggestions ?? [] });
  } catch (err) {
    return serverError(c, 'ai_suggestions', err);
  }
});

type PersonOut = { person?: PersonSummary | null; error?: string; to?: string | null } | null;
const personReply = (c: Ctx, out: PersonOut) => {
  if (!out) return c.json(fail('not_found'), 404);
  if (out.error) return blocked(c, out.error);
  return c.json({ ok: true, person: out.person ?? null, ...(out.to ? { to: out.to } : {}) });
};

aiRoutes.get('/people/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  try {
    const out = await rpc<PersonOut>(c.env, 'ai_person_get', { p_owner: ownerOf(c), p_person: id });
    if (out && !out.error && !out.person) return c.json(fail('not_found'), 404);
    return personReply(c, out);
  } catch (err) {
    return serverError(c, 'ai_person_get', err);
  }
});

aiRoutes.patch('/people/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  const body = await readBody(c, personPatchSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    return personReply(
      c,
      await rpc<PersonOut>(c.env, 'ai_person_patch', { p_owner: ownerOf(c), p_person: id, p_patch: body }),
    );
  } catch (err) {
    return serverError(c, 'ai_person_patch', err);
  }
});

aiRoutes.post('/people/:id/merge', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  const body = await readBody(c, personMergeSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    return personReply(
      c,
      await rpc<PersonOut>(c.env, 'ai_person_merge', {
        p_owner: ownerOf(c),
        p_person: id,
        p_from: body.from,
      }),
    );
  } catch (err) {
    return serverError(c, 'ai_person_merge', err);
  }
});

aiRoutes.post('/people/:id/faces', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  const body = await readBody(c, personFacesSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    return personReply(
      c,
      await rpc<PersonOut>(c.env, 'ai_person_faces', {
        p_owner: ownerOf(c),
        p_person: id,
        p_action: body.action,
        p_photo_ids: body.photoIds ?? null,
        p_face_ids: body.faceIds ?? null,
        p_to: body.action === 'move' ? body.to : null,
      }),
    );
  } catch (err) {
    return serverError(c, 'ai_person_faces', err);
  }
});
