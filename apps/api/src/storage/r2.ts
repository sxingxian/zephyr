import type { ObjectStore, StoredObject } from './types';

const meta = (o: R2Object): StoredObject => ({
  key: o.key,
  size: o.size,
  uploaded: o.uploaded instanceof Date ? o.uploaded : new Date(),
  contentType: o.httpMetadata?.contentType ?? null,
  etag: o.etag ?? '',
});

/** A stream with its exact length, as R2 needs for streamed puts (FixedLengthStream errors on a mismatch). */
function fixed(body: ReadableStream<Uint8Array>, length: number | undefined): ReadableStream<Uint8Array> {
  if (length === undefined || typeof FixedLengthStream === 'undefined') return body;
  const f = new FixedLengthStream(length);
  body.pipeTo(f.writable).catch(() => undefined);
  return f.readable as ReadableStream<Uint8Array>;
}

/** Cloudflare R2 through a Worker binding. */
export function r2Store(bucket: R2Bucket, id = 'r2'): ObjectStore {
  return {
    id,
    async put(key, body, opts) {
      const value = body instanceof ReadableStream ? fixed(body, opts.length) : body;
      const o = await bucket.put(key, value, {
        httpMetadata: {
          contentType: opts.contentType,
          ...(opts.cacheControl ? { cacheControl: opts.cacheControl } : {}),
        },
      });
      if (!o) throw new Error('object store: put refused');
      return meta(o);
    },
    async get(key, opts = {}) {
      const o = await bucket.get(key, opts.range ? { range: opts.range } : {});
      if (!o || !('body' in o)) return null;
      return { ...meta(o), body: o.body, bytes: async () => new Uint8Array(await o.arrayBuffer()) };
    },
    async head(key) {
      const o = await bucket.head(key);
      return o ? meta(o) : null;
    },
    async delete(keys) {
      if (keys.length) await bucket.delete(keys);
    },
    async list(prefix, opts = {}) {
      const r = await bucket.list({
        prefix,
        limit: opts.limit ?? 1000,
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
      });
      return { objects: r.objects.map(meta), cursor: r.truncated ? (r.cursor ?? null) : null };
    },
    async createMultipart(key, contentType) {
      const mp = await bucket.createMultipartUpload(key, { httpMetadata: { contentType } });
      return mp.uploadId;
    },
    async uploadPart(key, uploadId, n, body, length) {
      const value = body instanceof ReadableStream ? fixed(body, length) : body;
      const part = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(n, value);
      return part.etag;
    },
    async completeMultipart(key, uploadId, parts) {
      await bucket.resumeMultipartUpload(key, uploadId).complete(parts);
    },
    async abortMultipart(key, uploadId) {
      try {
        await bucket.resumeMultipartUpload(key, uploadId).abort();
      } catch {
        /* already aborted or completed */
      }
    },
  };
}
