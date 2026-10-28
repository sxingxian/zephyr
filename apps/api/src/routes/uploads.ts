import {
  FILE_TYPES,
  type FileTypeId,
  type PhotoDetail,
  type PhotoItem,
  type UploadCompleteResult,
  type UploadCreateResult,
  type UploadDecision,
  type UploadStatus,
  uploadCompleteSchema,
  uploadCreateSchema,
  VARIANT_LIMITS,
  type VariantKind,
} from '@zephyr/shared';
import { type Context, Hono } from 'hono';
import { fail, limitHit, logError, rateLimited, readBody } from '../http';
import { fileTypeFromName, imageInfo, SIGNATURE_BYTES, signatureMatches } from '../library/files';
import {
  contentLength,
  deleteKeys,
  exactLength,
  LIBRARY_LIMITS,
  libraryGuard,
  memberHash,
  peek,
  photoKeys,
  readExact,
  UUID,
} from '../library/storage';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';
import { requireMember } from './session-helpers';

/** /api/v1/uploads/*: resumable uploads through the Worker into R2 multipart (docs/phase-3.md). */
export const uploadRoutes = new Hono<HonoEnv>();
uploadRoutes.use('*', libraryGuard(LIBRARY_LIMITS.uploadCreateBodyBytes));
uploadRoutes.use('*', requireMember);

interface UploadRow {
  uploadId: string;
  photoId: string;
  r2Key: string;
  r2UploadId: string | null;
  fileType: FileTypeId;
  sizeBytes: number;
  partSize: number;
  partCount: number;
  parts: Record<string, string>;
  variants: Partial<Record<VariantKind, number>>;
  expiresAt: string;
  expired: boolean;
}
type Ctx = Context<HonoEnv>;

/** The caller's upload, or the response to send (404 not theirs / unknown, 410 expired). */
async function loadUpload(c: Ctx, id: string): Promise<UploadRow | Response> {
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  const up = await rpc<UploadRow | null>(c.env, 'get_upload', {
    p_owner: c.get('session').userId,
    p_upload: id,
  });
  if (!up) return c.json(fail('not_found'), 404);
  if (up.expired) return c.json(fail('upload_expired'), 410);
  return up;
}

const ownerOf = (c: Ctx) => c.get('session').userId;
const keysOf = (c: Ctx, up: UploadRow) => photoKeys(ownerOf(c), up.photoId);

/** Aborts the R2 upload, deletes any objects, then removes the row and its reservation. */
async function discardUpload(c: Ctx, up: UploadRow) {
  if (up.r2UploadId) {
    try {
      await c.env.PHOTOS.resumeMultipartUpload(up.r2Key, up.r2UploadId).abort();
    } catch {
      /* already aborted or completed; the original key is deleted below either way */
    }
  }
  await deleteKeys(c.env.PHOTOS, keysOf(c, up));
  await rpc(c.env, 'abort_upload', { p_owner: ownerOf(c), p_upload: up.uploadId });
}

/** Per-member limit on part and variant PUTs (the UPLOAD_LIMITER binding). */
const putAllowed = async (c: Ctx) => (await c.env.UPLOAD_LIMITER.limit({ key: `put:${ownerOf(c)}` })).success;

uploadRoutes.post('/', async (c) => {
  const body = await readBody(c, uploadCreateSchema);
  if (!body) return c.json(fail('invalid'), 400);
  const owner = ownerOf(c);
  try {
    const key = await memberHash(c.env, owner);
    if (!(await limitHit(c.env, 'upload_create', key, LIBRARY_LIMITS.uploadCreatesPerHour, 3600))) {
      return rateLimited(c, 3600);
    }
    const files = body.files.map((f) => ({
      name: f.name,
      size: f.size,
      sha256: f.sha256,
      // The extension declares the type; part 1's signature must agree with it.
      type: fileTypeFromName(f.name) ?? 'unknown',
    }));
    const res = await rpc<{ results?: (UploadDecision & { r2Key?: string })[]; error?: string }>(
      c.env,
      'create_uploads',
      { p_owner: owner, p_files: files },
    );
    if (res.error === 'account_pending_deletion') return c.json(fail('account_pending_deletion'), 403);
    if (res.error === 'forbidden') return c.json(fail('forbidden'), 403);
    if (res.error || !res.results) return c.json(fail('invalid'), 400);
    const results = res.results.map((d) => {
      const { r2Key: _internal, ...decision } = d;
      return decision as UploadDecision;
    });
    return c.json({ ok: true, results } satisfies UploadCreateResult);
  } catch (err) {
    logError(c.get('requestId'), 'upload_create', err);
    return c.json(fail('server'), 500);
  }
});

uploadRoutes.get('/:id', async (c) => {
  try {
    const up = await loadUpload(c, c.req.param('id'));
    if (up instanceof Response) return up;
    const body: UploadStatus = {
      ok: true,
      uploadId: up.uploadId,
      partsDone: Object.keys(up.parts)
        .map(Number)
        .sort((a, b) => a - b),
      variantsDone: (['thumb', 'preview'] as const).filter((k) => (up.variants[k] ?? 0) > 0),
      expiresAt: up.expiresAt,
    };
    return c.json(body);
  } catch (err) {
    logError(c.get('requestId'), 'upload_status', err);
    return c.json(fail('server'), 500);
  }
});

uploadRoutes.delete('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    if (!UUID.test(id)) return c.json(fail('not_found'), 404);
    const up = await rpc<UploadRow | null>(c.env, 'get_upload', { p_owner: ownerOf(c), p_upload: id });
    if (!up) return c.json(fail('not_found'), 404);
    await discardUpload(c, up);
    return c.body(null, 204);
  } catch (err) {
    logError(c.get('requestId'), 'upload_abort', err);
    return c.json(fail('server'), 500);
  }
});

uploadRoutes.put('/:id/parts/:n', async (c) => {
  const rawN = c.req.param('n');
  if (!/^\d{1,5}$/.test(rawN)) return c.json(fail('not_found'), 404);
  const n = Number(rawN);
  try {
    if (!(await putAllowed(c))) return rateLimited(c, 60);
    const len = contentLength(c.req.header('Content-Length'));
    if (len === null) return c.json(fail('invalid'), 411);
    const up = await loadUpload(c, c.req.param('id'));
    if (up instanceof Response) return up;
    if (n < 1 || n > up.partCount) return c.json(fail('invalid'), 400);
    const expected = n < up.partCount ? up.partSize : up.sizeBytes - up.partSize * (up.partCount - 1);
    if (len > expected) return c.json(fail('too_large'), 413);
    if (len !== expected) return c.json(fail('invalid'), 400);
    let body = c.req.raw.body;
    if (!body) return c.json(fail('invalid'), 400);

    // Part 1: the file must start with its type's signature, checked before anything is stored.
    if (n === 1) {
      const { head, rest } = await peek(body, SIGNATURE_BYTES);
      if (!signatureMatches(up.fileType, head)) {
        await rest.cancel().catch(() => undefined);
        await discardUpload(c, up);
        return c.json(fail('invalid'), 415);
      }
      body = rest;
    }

    let r2UploadId = up.r2UploadId;
    if (!r2UploadId) {
      const mp = await c.env.PHOTOS.createMultipartUpload(up.r2Key, {
        httpMetadata: { contentType: FILE_TYPES[up.fileType].mime },
      });
      r2UploadId = await rpc<string | null>(c.env, 'set_upload_r2', {
        p_owner: ownerOf(c),
        p_upload: up.uploadId,
        p_r2_upload_id: mp.uploadId,
      });
      // A parallel part created the upload first: use theirs and drop ours.
      if (r2UploadId !== mp.uploadId) await mp.abort().catch(() => undefined);
      if (!r2UploadId) return c.json(fail('upload_expired'), 410);
    }

    const limited = exactLength(body, expected);
    let etag: string;
    try {
      const part = await c.env.PHOTOS.resumeMultipartUpload(up.r2Key, r2UploadId).uploadPart(
        n,
        limited.stream,
      );
      etag = part.etag;
    } catch (err) {
      if (limited.state.error) {
        return limited.state.error.tooLong ? c.json(fail('too_large'), 413) : c.json(fail('invalid'), 400);
      }
      throw err;
    }
    const recorded = await rpc<boolean | null>(c.env, 'record_part', {
      p_owner: ownerOf(c),
      p_upload: up.uploadId,
      p_n: n,
      p_etag: etag,
    });
    if (!recorded) return c.json(fail('upload_expired'), 410);
    return c.json({ ok: true, part: n });
  } catch (err) {
    logError(c.get('requestId'), 'upload_part', err);
    return c.json(fail('server'), 500);
  }
});

uploadRoutes.put('/:id/variants/:kind', async (c) => {
  const kind = c.req.param('kind');
  if (kind !== 'thumb' && kind !== 'preview') return c.json(fail('not_found'), 404);
  const limits = VARIANT_LIMITS[kind];
  try {
    if (!(await putAllowed(c))) return rateLimited(c, 60);
    const len = contentLength(c.req.header('Content-Length'));
    if (len === null) return c.json(fail('invalid'), 411);
    if (len > limits.maxBytes) return c.json(fail('too_large'), 413);
    if (len < 1) return c.json(fail('invalid'), 400);
    const up = await loadUpload(c, c.req.param('id'));
    if (up instanceof Response) return up;
    const bytes = await readExact(c.req.raw.body, len);
    if (!bytes) return c.json(fail('invalid'), 400);
    const info = imageInfo(bytes);
    if (!info) return c.json(fail('invalid'), 415);
    if (info.width > limits.maxEdge || info.height > limits.maxEdge) return c.json(fail('invalid'), 400);
    const [, thumbKey, previewKey] = keysOf(c, up);
    await c.env.PHOTOS.put(kind === 'thumb' ? (thumbKey as string) : (previewKey as string), bytes, {
      httpMetadata: { contentType: info.format === 'jpeg' ? 'image/jpeg' : 'image/webp' },
    });
    const recorded = await rpc<boolean | null>(c.env, 'record_variant', {
      p_owner: ownerOf(c),
      p_upload: up.uploadId,
      p_kind: kind,
      p_bytes: bytes.byteLength,
    });
    if (!recorded) return c.json(fail('upload_expired'), 410);
    return c.json({ ok: true });
  } catch (err) {
    logError(c.get('requestId'), 'upload_variant', err);
    return c.json(fail('server'), 500);
  }
});

type CompleteResult =
  | { status: 'ready'; photo: PhotoItem }
  | { status: 'duplicate'; photoId: string }
  | { status: 'expired' | 'incomplete' };

uploadRoutes.post('/:id/complete', async (c) => {
  const body = await readBody(c, uploadCompleteSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const up = await loadUpload(c, c.req.param('id'));
    if (up instanceof Response) return up;
    if (!up.r2UploadId || Object.keys(up.parts).length !== up.partCount) {
      return c.json(fail('conflict'), 409);
    }
    const parts = Object.entries(up.parts)
      .map(([n, etag]) => ({ partNumber: Number(n), etag }))
      .sort((a, b) => a.partNumber - b.partNumber);
    let completed = true;
    try {
      await c.env.PHOTOS.resumeMultipartUpload(up.r2Key, up.r2UploadId).complete(parts);
    } catch (err) {
      // Possibly completed by an earlier attempt that died before the database step: the HEAD decides.
      completed = false;
      logError(c.get('requestId'), 'upload_complete_r2', err);
    }
    const head = await c.env.PHOTOS.head(up.r2Key);
    if (!head) {
      return completed ? c.json(fail('server'), 500) : c.json(fail('server'), 502);
    }
    if (head.size !== up.sizeBytes) {
      await discardUpload(c, up);
      return c.json(fail('invalid'), 400);
    }
    const res = await rpc<CompleteResult | null>(c.env, 'complete_upload', {
      p_owner: ownerOf(c),
      p_upload: up.uploadId,
      p_metadata: body.metadata,
    });
    if (!res) return c.json(fail('not_found'), 404);
    switch (res.status) {
      case 'ready':
        return c.json({ ok: true, photo: res.photo } satisfies UploadCompleteResult);
      case 'duplicate': {
        // The same file finished first elsewhere: this copy's objects go; answer with the kept one.
        await deleteKeys(c.env.PHOTOS, keysOf(c, up));
        const kept = await rpc<PhotoDetail | null>(c.env, 'get_photo', {
          p_owner: ownerOf(c),
          p_id: res.photoId,
        });
        if (!kept) return c.json(fail('conflict'), 409);
        const { metadata: _m, albums: _a, ...photo } = kept;
        return c.json({ ok: true, photo, duplicate: true } satisfies UploadCompleteResult);
      }
      case 'expired':
        return c.json(fail('upload_expired'), 410);
      default:
        return c.json(fail('conflict'), 409);
    }
  } catch (err) {
    logError(c.get('requestId'), 'upload_complete', err);
    return c.json(fail('server'), 500);
  }
});
