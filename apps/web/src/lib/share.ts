import {
  type Branding,
  type BrandingAssetKind,
  type BrandingBody,
  type GalleryCreateBody,
  type GalleryCreated,
  type GalleryDetail,
  type GalleryEvent,
  type GalleryPatchBody,
  type GalleryPhotoItem,
  type GalleryPhotosBody,
  type GalleryStats,
  type GallerySummary,
  type GuestSelection,
  MAX_LINK_DAYS_SYSTEM,
  type Page,
  PLANS,
  type PlanId,
  SHARE_API,
  type SharingLimits,
  type Usage,
} from '@zephyr/shared/client';
import { api } from './api';
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
