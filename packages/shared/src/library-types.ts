/**
 * Phase 3 HTTP contract: uploads, photos, albums, trash, usage and account deletion. Types and constants only
 * (browser-safe). See docs/phase-3.md.
 */
export const LIBRARY_API = {
  uploads: '/api/v1/uploads', // POST UploadCreateBody → 200 UploadCreateResult
  uploadPart: (uploadId: string, n: number) => `/api/v1/uploads/${encodeURIComponent(uploadId)}/parts/${n}`, // PUT bytes → 200 { ok, part }
  uploadVariant: (uploadId: string, kind: VariantKind) =>
    `/api/v1/uploads/${encodeURIComponent(uploadId)}/variants/${kind}`, // PUT image bytes → 200 { ok }
  uploadComplete: (uploadId: string) => `/api/v1/uploads/${encodeURIComponent(uploadId)}/complete`, // POST UploadCompleteBody → 200 { ok, photo: PhotoItem }
  upload: (uploadId: string) => `/api/v1/uploads/${encodeURIComponent(uploadId)}`, // GET → UploadStatus | DELETE → 204
  photos: '/api/v1/photos', // GET ?PhotoListQuery → 200 Page<PhotoItem>
  photo: (id: string) => `/api/v1/photos/${encodeURIComponent(id)}`, // GET → PhotoDetail | PATCH PhotoPatchBody → PhotoItem
  photoFile: (id: string, kind: VariantKind | 'original') =>
    `/api/v1/photos/${encodeURIComponent(id)}/${kind}`, // GET → image bytes (owner only)
  photosBulk: '/api/v1/photos/bulk', // POST BulkBody → 200 BulkResult
  albums: '/api/v1/albums', // GET → { ok, albums: AlbumItem[] } | POST AlbumCreateBody → 201 { ok, album }
  album: (id: string) => `/api/v1/albums/${encodeURIComponent(id)}`, // GET → { ok, album } | PATCH AlbumPatchBody | DELETE → 204
  trashEmpty: '/api/v1/trash/empty', // POST {} → 200 { ok, deleted: number }
  usage: '/api/v1/me/usage', // GET → Usage
  deleteAccount: '/api/v1/me/delete', // POST DeleteAccountBody → 200 DeleteAccountResult (signs out everywhere)
  restoreAccount: '/api/v1/me/restore', // POST {} → 200 SessionResponse
} as const;

export type VariantKind = 'thumb' | 'preview';
/** Upload part size: 16 MiB (R2 multipart: every part but the last must be ≥ 5 MiB). */
export const UPLOAD_PART_SIZE = 16 * 1024 * 1024;
export const VARIANT_LIMITS = {
  thumb: { maxEdge: 512, maxBytes: 300 * 1024 },
  preview: { maxEdge: 2048, maxBytes: 1536 * 1024 },
} as const;
export const MAX_UPLOAD_BATCH = 500;
export const TRASH_DAYS = 30;
export const ACCOUNT_DELETION_DAYS = 30;

/** File types the server knows how to check. Each plan allows a subset (plan_limits.file_types). */
export const FILE_TYPES = {
  jpeg: { label: 'JPEG', exts: ['jpg', 'jpeg'], mime: 'image/jpeg', raw: false },
  png: { label: 'PNG', exts: ['png'], mime: 'image/png', raw: false },
  webp: { label: 'WEBP', exts: ['webp'], mime: 'image/webp', raw: false },
  cr2: { label: 'Canon RAW (CR2)', exts: ['cr2'], mime: 'image/x-canon-cr2', raw: true },
  nef: { label: 'Nikon RAW (NEF)', exts: ['nef'], mime: 'image/x-nikon-nef', raw: true },
  arw: { label: 'Sony RAW (ARW)', exts: ['arw'], mime: 'image/x-sony-arw', raw: true },
} as const;
export type FileTypeId = keyof typeof FILE_TYPES;

// ---------------------------------------------------------------- uploads
export interface UploadFileSpec {
  name: string;
  size: number;
  /** Lowercase hex SHA-256 of the whole file (computed in the browser; only used to skip the owner's own duplicates). */
  sha256: string;
  lastModified?: number;
}
export interface UploadCreateBody {
  files: UploadFileSpec[];
}
export type UploadDecision =
  | {
      status: 'ready';
      uploadId: string;
      photoId: string;
      partSize: number;
      partCount: number;
      fileType: FileTypeId;
    }
  | { status: 'duplicate'; photoId: string }
  | { status: 'rejected'; reason: 'type' | 'too_large' | 'quota' | 'invalid' };
export interface UploadCreateResult {
  ok: true;
  /** Same order as the request. */
  results: UploadDecision[];
}
export interface UploadStatus {
  ok: true;
  uploadId: string;
  partsDone: number[];
  variantsDone: VariantKind[];
  expiresAt: string;
}
export interface PhotoMetadata {
  width?: number;
  height?: number;
  takenAt?: string; // ISO 8601 with offset
  cameraMake?: string;
  cameraModel?: string;
  lens?: string;
  focalLengthMm?: number;
  aperture?: number; // f-number
  exposureSeconds?: number;
  iso?: number;
  orientation?: number; // EXIF 1–8
}
export interface UploadCompleteBody {
  metadata: PhotoMetadata;
}

// ---------------------------------------------------------------- photos
export interface PhotoItem {
  id: string;
  filename: string;
  fileType: FileTypeId;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  takenAt: string | null;
  createdAt: string;
  favourite: boolean;
  hasThumb: boolean;
  hasPreview: boolean;
  /** Only set for items in the Trash. */
  trashedAt?: string | null;
  purgeAt?: string | null;
}
export interface PhotoDetail extends PhotoItem {
  metadata: PhotoMetadata;
  albums: { id: string; name: string }[];
}
export interface PhotoListQuery {
  view?: 'library' | 'favourites' | 'raw' | 'trash';
  albumId?: string;
  q?: string;
  from?: string; // ISO date
  to?: string;
  sort?: 'taken' | 'added';
  cursor?: string;
  limit?: number; // ≤ 200
}
export interface PhotoPatchBody {
  favourite?: boolean;
  filename?: string;
}
export type BulkAction =
  | 'favourite'
  | 'unfavourite'
  | 'trash'
  | 'restore'
  | 'delete_forever'
  | 'add_to_album'
  | 'remove_from_album';
export interface BulkBody {
  ids: string[]; // ≤ 500
  action: BulkAction;
  albumId?: string;
}
export interface BulkResult {
  ok: true;
  /** Number of the caller's own photos the action applied to; other ids are ignored. */
  affected: number;
}

// ---------------------------------------------------------------- albums
export interface AlbumItem {
  id: string;
  name: string;
  photoCount: number;
  coverPhotoIds: string[]; // up to 3, for the mosaic cover
  createdAt: string;
  updatedAt: string;
}
export interface AlbumCreateBody {
  name: string;
  photoIds?: string[];
}
export interface AlbumPatchBody {
  name?: string;
  coverPhotoId?: string | null;
}

// ---------------------------------------------------------------- usage & account
export interface Usage {
  ok: true;
  usedBytes: number;
  reservedBytes: number;
  limitBytes: number;
  trashBytes: number;
  photoCount: number;
  plan: 'free' | 'pro' | 'studio';
  fileTypes: FileTypeId[];
  maxFileBytes: number;
  batchSize: number;
}
export interface DeleteAccountBody {
  confirm: 'DELETE';
}
export interface DeleteAccountResult {
  ok: true;
  purgeAt: string;
}
