import {
  type AlbumCreateBody,
  type AlbumItem,
  type AlbumPatchBody,
  type BulkBody,
  type BulkResult,
  type DeleteAccountResult,
  LIBRARY_API,
  type Page,
  type PhotoDetail,
  type PhotoItem,
  type PhotoListQuery,
  type PhotoPatchBody,
  type SessionResponse,
  type UploadCompleteBody,
  type UploadCompleteResult,
  type UploadCreateBody,
  type UploadCreateResult,
  type UploadStatus,
  type Usage,
  type VariantKind,
} from '@zephyr/shared/client';
import { ApiFailure, api, notifyFailure, toFailure } from './api';
import { libraryHeaders, withLibrary } from './libraryContext';
import { sessionUserId } from './sessionGuard';

/** Builds the query string for GET /photos, leaving out empty values. */
export function photoQuery(q: PhotoListQuery): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const listPhotos = (q: PhotoListQuery, signal?: AbortSignal) =>
  api<Page<PhotoItem>>(`${LIBRARY_API.photos}${photoQuery(q)}`, { signal });
/** The contract names the photo routes' bodies loosely; accept `{ ok, photo }` or the bare object. */
function unwrapPhoto<T extends PhotoItem>(r: T | { photo: T }): T {
  return 'photo' in r && r.photo && typeof r.photo === 'object' ? r.photo : (r as T);
}
export const getPhoto = (id: string, signal?: AbortSignal) =>
  api<PhotoDetail | { photo: PhotoDetail }>(LIBRARY_API.photo(id), { signal }).then(unwrapPhoto);
export const patchPhoto = (id: string, body: PhotoPatchBody) =>
  api<PhotoItem | { photo: PhotoItem }>(LIBRARY_API.photo(id), { method: 'PATCH', body }).then(unwrapPhoto);

const BULK_MAX = 500;
/**
 * POST /photos/bulk, split into requests of at most 500 ids. Returns the total affected. Every chunk names the
 * member signed in when the action began (X-Zephyr-Expected-User), so a long multi-chunk action never carries
 * on under someone who signed in meanwhile (409 session_changed).
 */
export async function bulk(
  ids: string[],
  action: BulkBody['action'],
  albumId?: string,
  owner: string | null = sessionUserId(),
): Promise<number> {
  let affected = 0;
  for (let i = 0; i < ids.length; i += BULK_MAX) {
    const body: BulkBody = { ids: ids.slice(i, i + BULK_MAX), action, ...(albumId ? { albumId } : {}) };
    const r = await api<BulkResult>(LIBRARY_API.photosBulk, { body, headers: ownerHeader(owner) });
    affected += r.affected;
  }
  return affected;
}

/** Every id matching a query (pages through the list; used by "Restore all"). */
export async function allPhotoIds(q: PhotoListQuery): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard++) {
    const page = await listPhotos({ ...q, cursor, limit: 200 });
    ids.push(...page.items.map((p) => p.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return ids;
}

export const listAlbums = (signal?: AbortSignal) =>
  api<{ ok: true; albums: AlbumItem[] }>(LIBRARY_API.albums, { signal }).then((r) => r.albums);
export const getAlbum = (id: string, signal?: AbortSignal) =>
  api<{ ok: true; album: AlbumItem }>(LIBRARY_API.album(id), { signal }).then((r) => r.album);
export const createAlbum = (body: AlbumCreateBody) =>
  api<{ ok: true; album: AlbumItem }>(LIBRARY_API.albums, { body }).then((r) => r.album);
export const patchAlbum = (id: string, body: AlbumPatchBody) =>
  api<{ ok: true; album: AlbumItem }>(LIBRARY_API.album(id), { method: 'PATCH', body }).then((r) => r.album);
export const deleteAlbum = (id: string) => api<void>(LIBRARY_API.album(id), { method: 'DELETE' });

export const emptyTrash = () =>
  api<{ ok: true; deleted: number }>(LIBRARY_API.trashEmpty, { body: {} }).then((r) => r.deleted);
export const fetchUsage = (signal?: AbortSignal) => api<Usage>(LIBRARY_API.usage, { signal });
export const deleteAccount = () =>
  api<DeleteAccountResult>(LIBRARY_API.deleteAccount, { body: { confirm: 'DELETE' } });
export const restoreAccount = () => api<SessionResponse>(LIBRARY_API.restoreAccount, { body: {} });

// ---------------------------------------------------------------- uploads
/**
 * Upload calls name the member this tab believes is signed in. The cookie is shared by every tab, so if
 * another tab has since signed in as someone else, the API answers 409 session_changed instead of acting
 * for the wrong account.
 */
export const EXPECTED_USER_HEADER = 'x-zephyr-expected-user';
export function expectedUser(): Record<string, string> {
  return ownerHeader(sessionUserId());
}
/**
 * The header for work that belongs to a given member (captured when the work began). Long-running work, like
 * an autosave or a background render, sends the member it was started for rather than whoever is signed in
 * when the request finally goes out.
 */
export function ownerHeader(owner: string | null | undefined): Record<string, string> {
  return owner ? { [EXPECTED_USER_HEADER]: owner } : {};
}
export const createUploads = (body: UploadCreateBody) =>
  api<UploadCreateResult>(LIBRARY_API.uploads, { body, headers: expectedUser() });
export const uploadStatus = (uploadId: string) =>
  api<UploadStatus>(LIBRARY_API.upload(uploadId), { headers: expectedUser() });
export const abortUpload = (uploadId: string) =>
  api<void>(LIBRARY_API.upload(uploadId), { method: 'DELETE', headers: expectedUser() });
export const completeUpload = (uploadId: string, body: UploadCompleteBody) =>
  api<UploadCompleteResult>(LIBRARY_API.uploadComplete(uploadId), { body, headers: expectedUser() });

/**
 * PUT raw bytes to our own API with upload progress. XHR rather than fetch because fetch can't report
 * upload progress. Same origin, so the session cookie goes along and CSP connect-src 'self' covers it.
 */
export function putBytes(
  path: string,
  body: Blob,
  opts: {
    contentType: string;
    signal?: AbortSignal;
    onProgress?: (sent: number) => void;
    /** Send for this member (default: whoever is signed in now). */
    owner?: string;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    opts.signal?.addEventListener('abort', abort, { once: true });
    const done = () => opts.signal?.removeEventListener('abort', abort);
    xhr.open('PUT', path);
    xhr.setRequestHeader('content-type', opts.contentType);
    xhr.setRequestHeader('accept', 'application/json');
    const who = opts.owner !== undefined ? ownerHeader(opts.owner) : expectedUser();
    for (const [k, v] of Object.entries({ ...libraryHeaders(), ...who })) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => opts.onProgress?.(e.loaded);
    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        parsed = null;
      }
      const failure = toFailure(xhr.status, parsed, xhr.getResponseHeader('retry-after'));
      notifyFailure(failure);
      reject(failure);
    };
    xhr.onerror = () => {
      done();
      reject(new ApiFailure('network', 0));
    };
    xhr.onabort = () => {
      done();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    xhr.send(body);
  });
}

export const putPart = (
  uploadId: string,
  n: number,
  bytes: Blob,
  signal?: AbortSignal,
  onProgress?: (sent: number) => void,
) =>
  putBytes(LIBRARY_API.uploadPart(uploadId, n), bytes, {
    contentType: 'application/octet-stream',
    signal,
    onProgress,
  });
export const putVariant = (uploadId: string, kind: VariantKind, bytes: Blob, signal?: AbortSignal) =>
  putBytes(LIBRARY_API.uploadVariant(uploadId, kind), bytes, { contentType: bytes.type, signal });

/** Same-origin media URLs (the session cookie authorises them). */
/** `editVersion` busts the browser's memory cache once an edited thumbnail exists (the server revalidates anyway). */
const bust = (v?: number | null) => (v ? `?e=${v}` : '');
export const thumbUrl = (id: string, editVersion?: number | null) =>
  withLibrary(`${LIBRARY_API.photoFile(id, 'thumb')}${bust(editVersion)}`);
export const previewUrl = (id: string, editVersion?: number | null) =>
  withLibrary(`${LIBRARY_API.photoFile(id, 'preview')}${bust(editVersion)}`);
/** Cache key of a photo's current edited variants (0 when unedited or not rendered yet). */
export const editKey = (p: Pick<PhotoItem, 'edit'>) => (p.edit?.rendered ? p.edit.version : 0);
export const originalUrl = (id: string) => withLibrary(LIBRARY_API.photoFile(id, 'original'));
