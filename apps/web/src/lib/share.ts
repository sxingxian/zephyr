import {
  type Branding,
  type BrandingAssetKind,
  type BrandingBody,
  type GalleryCreateBody,
  type GalleryCreated,
  type GalleryDetail,
  type GalleryEvent,
  type GalleryLinkResult,
  type GalleryPatchBody,
  type GalleryPhotoItem,
  type GalleryPhotosBody,
  type GalleryStats,
  type GallerySummary,
  type GuestSelection,
  MAX_LINK_DAYS_SYSTEM,
  MEMBER8_API,
  type Page,
  PLANS,
  type PlanId,
  SHARE_API,
  type SharingLimits,
  type Usage,
} from '@zephyr/shared/client';
import { ApiFailure, api } from './api';
import { expectedUser, putBytes } from './library';

/**
 * Member-side sharing calls. Writes name the member this tab believes is signed in (409 session_changed if
 * someone else has since signed in on another tab); long-running work passes the member it was started for.
 */
export const listGalleries = (signal?: AbortSignal) =>
  api<{ ok: true; galleries: GallerySummary[] }>(SHARE_API.galleries, { signal }).then(
    (r) => r.galleries ?? [],
  );
export const createGallery = (body: GalleryCreateBody) =>
  api<GalleryCreated>(SHARE_API.galleries, { body, headers: expectedUser() });
/** The gallery's full guest link (owner only). Passcodes are never retrievable; only the link is. */
export const getGalleryLink = (id: string, signal?: AbortSignal) =>
  api<{ ok: true; url: string }>(SHARE_API.galleryLink(id), { signal }).then((r) => r.url);
/**
 * Phase 8: a new link for a gallery whose link reached someone it shouldn't have. The old link stops at once;
 * the passcode, favourites and activity stay. The new link is returned once (copy it again later as usual).
 */
export const replaceGalleryLink = (id: string) =>
  api<GalleryLinkResult>(MEMBER8_API.galleryLinkReplace(id), {
    method: 'POST',
    body: {},
    headers: expectedUser(),
  }).then((r) => r.link);
export const getGallery = (id: string, signal?: AbortSignal) =>
  api<{ ok: true; gallery: GalleryDetail }>(SHARE_API.gallery(id), { signal }).then((r) => r.gallery);
export const patchGallery = (id: string, body: GalleryPatchBody) =>
  api<{ ok: true; gallery: GalleryDetail }>(SHARE_API.gallery(id), {
    method: 'PATCH',
    body,
    headers: expectedUser(),
  }).then((r) => r.gallery);
/** Revoke: the link stops working at once. Can't be undone. */
export const revokeGallery = (id: string) =>
  api<void>(SHARE_API.gallery(id), { method: 'DELETE', headers: expectedUser() });

export const listGalleryPhotos = (id: string, cursor?: string, signal?: AbortSignal) =>
  api<Page<GalleryPhotoItem>>(
    `${SHARE_API.galleryPhotos(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    { signal },
  );
export const changeGalleryPhotos = (id: string, body: GalleryPhotosBody) =>
  api<{ ok: true; count: number }>(SHARE_API.galleryPhotos(id), { body, headers: expectedUser() });

/** A new passcode, shown once. Every guest who unlocked with the old one has to enter the new one. */
export const newPasscode = (id: string) =>
  api<{ ok: true; passcode: string }>(SHARE_API.galleryPasscode(id), {
    body: {},
    headers: expectedUser(),
  }).then((r) => r.passcode);
export const removePasscode = (id: string) =>
  api<void>(SHARE_API.galleryPasscode(id), { method: 'DELETE', headers: expectedUser() });

export const getFavourites = (id: string, signal?: AbortSignal) =>
  api<{ ok: true; guests: GuestSelection[] }>(SHARE_API.galleryFavourites(id), { signal }).then(
    (r) => r.guests ?? [],
  );
export interface ActivityPage {
  stats: GalleryStats;
  events: GalleryEvent[];
  nextCursor: string | null;
}
export const getActivity = (id: string, cursor?: string, signal?: AbortSignal) =>
  api<{ ok: true } & ActivityPage>(
    `${SHARE_API.galleryActivity(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    { signal },
  );

export const getRenderQueue = (id: string, signal?: AbortSignal) =>
  api<{ ok: true; pending: { photoId: string; editVersion: number }[] }>(SHARE_API.galleryRenderQueue(id), {
    signal,
  }).then((r) => r.pending ?? []);
/** Upload a full-size JPEG rendered on this device, on behalf of the member who started the work. */
export const putFullRender = (
  galleryId: string,
  photoId: string,
  editVersion: number,
  jpeg: Blob,
  owner: string,
  signal?: AbortSignal,
) =>
  putBytes(SHARE_API.galleryFullRender(galleryId, photoId, editVersion), jpeg, {
    contentType: 'image/jpeg',
    signal,
    owner,
  });

export const getBranding = (signal?: AbortSignal) =>
  api<{ ok: true; branding: Branding }>(SHARE_API.branding, { signal }).then((r) => r.branding);
export const saveBranding = (body: BrandingBody) =>
  api<{ ok: true; branding: Branding }>(SHARE_API.branding, {
    method: 'PUT',
    body,
    headers: expectedUser(),
  }).then((r) => r.branding);
export const putBrandingAsset = (kind: BrandingAssetKind, image: Blob) =>
  putBytes(SHARE_API.brandingAsset(kind), image, { contentType: image.type || 'image/png' });
export const deleteBrandingAsset = (kind: BrandingAssetKind) =>
  api<{ ok: true; branding: Branding }>(SHARE_API.brandingAsset(kind), {
    method: 'DELETE',
    headers: expectedUser(),
  }).then((r) => r.branding);

// ---------------------------------------------------------------- readiness
/** Fields newer servers add (phase 5 review): optional, so older replies still work. */
export type BrandingState = Branding & { watermarkReady?: boolean };
export type GalleryState = GalleryDetail & {
  watermarkReady?: boolean;
  /** Some guest previews can't be prepared because the member's storage is full. */
  storageFull?: boolean;
};

/**
 * Whether guests can be given watermarked images: a logo watermark needs the logo, a text watermark needs its
 * drawn image. The server's own flag wins when it sends one.
 */
export function watermarkReady(b: BrandingState | null | undefined): boolean {
  if (!b) return false;
  if (typeof b.watermarkReady === 'boolean') return b.watermarkReady;
  return b.watermark.kind === 'logo' ? b.hasLogo : b.watermark.hasImage;
}

/** The reason a branding image can't be removed (the API answers 409 while live galleries use it). */
export function assetInUseMessage(e: unknown, kind: BrandingAssetKind): string | null {
  if (!(e instanceof ApiFailure) || e.status !== 409 || e.code === 'session_changed') return null;
  const what = kind === 'logo' ? 'logo' : 'watermark';
  return `Your ${what} is used by live galleries. Turn the watermark off in those galleries first, or replace the ${what} instead.`;
}

/**
 * Switching the watermark to a logo with no logo uploaded, while live galleries draw the watermark: the
 * server refuses (409 asset_in_use) rather than leave those galleries' previews stuck on "Preparing".
 */
export function watermarkKindInUseMessage(e: unknown): string | null {
  if (!(e instanceof ApiFailure) || e.status !== 409 || e.code === 'session_changed') return null;
  const n = Number((e.body as { galleries?: unknown } | undefined)?.galleries);
  const who =
    Number.isInteger(n) && n > 0
      ? `${n} live ${n === 1 ? 'gallery uses' : 'galleries use'}`
      : 'Live galleries use';
  return `${who} your watermark. Upload a logo first, or turn the watermark off in those galleries, before switching to a logo watermark.`;
}

/** The owner's preview of a gallery as guests see it (no passcode; served by the guest page). */
export const galleryPreviewPath = (id: string) => `/g/preview/${encodeURIComponent(id)}`;

// ---------------------------------------------------------------- limits
/**
 * Sharing limits for the member's plan. The server sends the live values (`Usage.sharing`); until it does
 * (older servers), the plan's starting values stand in. The server enforces them either way.
 */
export function sharingLimits(usage: Usage | null, planFallback: PlanId = 'free'): SharingLimits {
  if (usage?.sharing) return usage.sharing;
  const plan = PLANS.find((p) => p.id === (usage?.plan ?? planFallback)) ?? PLANS[0];
  const l = plan?.limits;
  return {
    galleries: l?.galleries ?? 3,
    liveGalleries: 0,
    maxLinkDays: l?.maxLinkDays ?? 7,
    guestFullRes: l?.guestFullRes ?? false,
    guestFavourites: l?.guestFavourites ?? false,
    watermark: l?.watermark ?? false,
    branding: l?.branding ?? false,
    accessLog: l?.accessLog ?? false,
  };
}
/** Longest link the plan allows, in days. */
export const maxLinkDays = (l: SharingLimits) =>
  Math.min(l.maxLinkDays ?? MAX_LINK_DAYS_SYSTEM, MAX_LINK_DAYS_SYSTEM);

/** YYYY-MM-DD for a date `days` from `from`, in the member's local calendar. */
export function isoDay(days: number, from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "30 days left", "Ends today", "Expired 20 Oct". */
export function expiryLabel(expiresAt: string, now = Date.now()): string {
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return '';
  const days = Math.ceil((t - now) / 86_400_000);
  if (t <= now) return `Ended ${new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
  if (days <= 1) return 'Ends today';
  return `${days} days left`;
}

/** A plan name for "on Pro" style hints. */
export const PLAN_NAME: Record<PlanId, string> = { free: 'Free', pro: 'Pro', studio: 'Studio' };
