/**
 * The object-storage seam (phase 5, extended in phase 8). Every photo-library byte goes through an ObjectStore:
 * Cloudflare R2 through its Worker binding, or an S3-compatible service (cloud over HTTPS, or on premises
 * through Workers VPC or a Tunnel hostname). Nothing outside src/storage/ touches a bucket binding directly.
 */

export interface StoredObject {
  key: string;
  size: number;
  uploaded: Date;
  contentType: string | null;
  /** The store's entity tag, without quotes. */
  etag: string;
}
export interface ObjectBody extends StoredObject {
  body: ReadableStream<Uint8Array>;
  bytes(): Promise<Uint8Array>;
}
export interface PutOptions {
  contentType: string;
  cacheControl?: string;
  /** Required for streams: the exact byte length (providers need it up front). */
  length?: number;
}
export interface ByteRange {
  offset: number;
  length: number;
}
export interface CompletedPart {
  partNumber: number;
  etag: string;
}
export interface ObjectStore {
  /** The store id from the deployment config ('r2' for the PHOTOS binding). */
  readonly id: string;
  put(key: string, body: Uint8Array | ReadableStream<Uint8Array>, opts: PutOptions): Promise<StoredObject>;
  get(key: string, opts?: { range?: ByteRange }): Promise<ObjectBody | null>;
  head(key: string): Promise<StoredObject | null>;
  /** Deletes up to 1,000 keys. Deleting a missing key is not an error. */
  delete(keys: string[]): Promise<void>;
  list(
    prefix: string,
    opts?: { cursor?: string | null; limit?: number },
  ): Promise<{ objects: StoredObject[]; cursor: string | null }>;
  /** Multipart uploads (16 MB parts from the upload route). Returns the store's upload id. */
  createMultipart(key: string, contentType: string): Promise<string>;
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array | ReadableStream<Uint8Array>,
    length: number,
  ): Promise<string>;
  completeMultipart(key: string, uploadId: string, parts: CompletedPart[]): Promise<void>;
  /** Aborting an upload that's already gone is not an error. */
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

/**
 * A store error with a short, safe code (an S3 error code or an HTTP status), never a response body,
 * endpoint or key: safe to log and to show in Admin.
 */
export class StoreError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
  ) {
    super(`store: ${code}`);
    this.name = 'StoreError';
  }
}

/** Codes are kept to letters, digits, dots, underscores and dashes, ≤ 40 characters. */
export const safeCode = (s: string | null | undefined, fallback: string): string => {
  const c = (s ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  return c || fallback;
};
