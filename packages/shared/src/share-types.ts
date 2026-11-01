/**
 * Phase 5 contract: shared galleries (member side), guest access, renditions, favourites, branding and the
 * access log. Types and constants only (browser-safe). See docs/phase-5.md.
 */

export const SHARE_API = {
  // ---- member (session cookie) -------------------------------------------------------------------------
  galleries: '/api/v1/galleries', // GET → { ok, galleries: GallerySummary[] } · POST GalleryCreateBody → 201 GalleryCreated
  gallery: (id: string) => `/api/v1/galleries/${encodeURIComponent(id)}`, // GET → { ok, gallery: GalleryDetail } · PATCH GalleryPatchBody → { ok, gallery } · DELETE → 204 (revoke; can't be undone)
  galleryPhotos: (id: string) => `/api/v1/galleries/${encodeURIComponent(id)}/photos`, // GET ?cursor → Page<GalleryPhotoItem> · POST GalleryPhotosBody → { ok, count }
  galleryPasscode: (id: string) => `/api/v1/galleries/${encodeURIComponent(id)}/passcode`, // POST {} → { ok, passcode } (new code, shown once; old one stops working) · DELETE → 204 (passcode off)
  galleryFavourites: (id: string) => `/api/v1/galleries/${encodeURIComponent(id)}/favourites`, // GET → { ok, guests: GuestSelection[] }
  galleryActivity: (id: string) => `/api/v1/galleries/${encodeURIComponent(id)}/activity`, // GET ?cursor → { ok, stats: GalleryStats, events: GalleryEvent[], nextCursor }
  /** PUT a full-size JPEG rendered on the member's device for an edited or RAW photo (Pro+, full-size downloads on). */
  galleryFullRender: (id: string, photoId: string, editVersion: number) =>
    `/api/v1/galleries/${encodeURIComponent(id)}/renders/${encodeURIComponent(photoId)}?v=${editVersion}`,
  /** Photos in this gallery that still need a full-size render from the member's device. */
  galleryRenderQueue: (id: string) => `/api/v1/galleries/${encodeURIComponent(id)}/renders`, // GET → { ok, pending: { photoId, editVersion }[] }
  /** The gallery's guest link again (owner only; 404 once revoked). */
  galleryLink: (id: string) => `/api/v1/galleries/${encodeURIComponent(id)}/link`, // GET → { ok, url }
  /** Owner preview: the guest page's data without a passcode (no events, no favourites or downloads). */
  galleryPreview: (id: string) => `/api/v1/galleries/${encodeURIComponent(id)}/preview`, // GET → GuestGalleryInfo
  galleryPreviewPhotos: (id: string) => `/api/v1/galleries/${encodeURIComponent(id)}/preview/photos`, // GET ?cursor → GuestPhotoPage
  branding: '/api/v1/me/branding', // GET → { ok, branding: Branding } · PUT BrandingBody → { ok, branding }
  brandingAsset: (kind: BrandingAssetKind) => `/api/v1/me/branding/${kind}`, // PUT image bytes (PNG/JPEG/WEBP) → { ok, branding } · DELETE → { ok, branding }

  // ---- guest (no account; gallery link token in the path) ---------------------------------------------
  guest: (token: string) => `/api/v1/g/${token}`, // GET → GuestGalleryInfo (always; never lists photos)
  guestUnlock: (token: string) => `/api/v1/g/${token}/unlock`, // POST GuestUnlockBody → 200 { ok } + guest cookie · 401 wrong_passcode { ok:false, error, turnstile?: true } · 429 rate_limited · 423 gallery_paused
  guestPhotos: (token: string) => `/api/v1/g/${token}/photos`, // GET ?cursor → GuestPhotoPage (needs the guest cookie when a passcode is set)
  guestFavourite: (token: string, photoId: string) =>
    `/api/v1/g/${token}/favourites/${encodeURIComponent(photoId)}`, // PUT → 204 · DELETE → 204
  guestSend: (token: string) => `/api/v1/g/${token}/favourites/send`, // POST GuestSendBody → { ok }
  /** Works with the link alone (no unlock). 202 { ok } · 400 verification_failed (Turnstile) · 429 rate_limited. */
  guestReport: (token: string) => `/api/v1/g/${token}/report`, // POST GuestReportBody
} as const;

/** Where guests open a gallery (on the app host). The token never appears anywhere else. */
export const GUEST_PATH = (token: string) => `/g/${token}`;

/** Bytes of randomness in a gallery link token (base64url, 43 characters). */
export const GALLERY_TOKEN_BYTES = 32;
export const GALLERY_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const PASSCODE_RE = /^[0-9]{6}$/;
export const MAX_GALLERY_PHOTOS = 2000;
export const GALLERY_NAME_MAX = 80;
export const GALLERY_MESSAGE_MAX = 500;
export const GUEST_NAME_MAX = 60;
export const GUEST_NOTE_MAX = 1000;
/** System ceiling for link lifetime, whatever the plan says. */
export const MAX_LINK_DAYS_SYSTEM = 365;
/** How long an unlocked guest stays unlocked in one browser. */
export const GUEST_UNLOCK_HOURS = 12;
/** Passcode guessing limits (SRS NFR-SEC-01 and docs/phase-5.md). */
export const PASSCODE_LIMITS = {
  perNetworkFailures: 5, // per gallery, per network (/64 for IPv6), per window
  windowMinutes: 15,
  turnstileAfter: 2, // failures from one network before Turnstile is required
  galleryPauseFailures: 25, // from anywhere, per window → gallery paused for one window, owner emailed
} as const;

/** Rendition sizes guests receive. Long edge in pixels; `full` keeps the source size. */
export const RENDITIONS = {
  grid: { longEdge: 640, quality: 82 },
  view: { longEdge: 2048, quality: 86 },
  full: { longEdge: null, quality: 92 },
} as const;
export type RenditionSize = keyof typeof RENDITIONS;

export type GalleryDownloads = 'none' | 'web' | 'full';
export type GalleryStatus = 'live' | 'paused' | 'expired' | 'revoked';

/** Studio extras (each is its own plan limit, editable in Admin › Plan limits). */
export interface GalleryExtras {
  favourites: boolean;
  watermark: boolean;
  branding: boolean;
  accessLog: boolean;
}

/**
 * The member's sharing limits, from their plan's live `plan_limits` row. Returned by GET /api/v1/me/usage as
 * `Usage.sharing` so the app can show what's possible before the server enforces it.
 */
export interface SharingLimits {
  /** Live galleries allowed (null = unlimited) and how many are live now. */
  galleries: number | null;
  liveGalleries: number;
  /** Longest link in days (null = the system ceiling, MAX_LINK_DAYS_SYSTEM). */
  maxLinkDays: number | null;
  guestFullRes: boolean;
  guestFavourites: boolean;
  watermark: boolean;
  branding: boolean;
  accessLog: boolean;
  /** Sharing suspended pending a safety review: new galleries are refused and existing ones show as ended. */
  suspended?: boolean;
  /**
   * Storage is past the plan plus the preview allowance (10% of the plan's storage, at most 5 GB) and a guest
   * preview was refused: "Storage full — some gallery previews can't be prepared". Clears once there's room.
   */
  previewsBlocked?: boolean;
}

// ---------------------------------------------------------------- member side
export interface GalleryCreateBody {
  name: string;
  photoIds: string[];
  /** Default true. */
  passcode: boolean;
  /** ISO date (YYYY-MM-DD); end of that day in UTC. Capped by the plan's max_link_days and MAX_LINK_DAYS_SYSTEM. */
  expiresOn: string;
  downloads: GalleryDownloads;
  extras: Partial<GalleryExtras>;
  /** Optional message shown to guests (plain text). */
  message?: string;
}
export interface GalleryCreated {
  ok: true;
  gallery: GalleryDetail;
  /** The full guest URL, returned once at creation (the server keeps only a hash of the token). */
  url: string;
  /** Shown once; null when the gallery has no passcode. */
  passcode: string | null;
}
export interface GallerySummary {
  id: string;
  name: string;
  status: GalleryStatus;
  photoCount: number;
  coverPhotoId: string | null;
  passcode: boolean;
  downloads: GalleryDownloads;
  expiresAt: string;
  pausedUntil: string | null;
  views: number;
  favourites: number;
  createdAt: string;
}
export interface GalleryDetail extends GallerySummary {
  message: string | null;
  extras: GalleryExtras;
  /** Prefix of the link for display (`/g/k7Qx2m…`); the full link was shown at creation. */
  linkHint: string;
  /** Full-size renders still to make on the member's device. */
  pendingRenders: number;
  /**
   * The owner's watermark has an image to draw (a text watermark's rendered image, or the logo for a logo
   * watermark). While the watermark is on and this is false, guests see "Preparing" instead of photos.
   */
  watermarkReady?: boolean;
  /**
   * The owner's storage is past the plan plus the preview allowance and guest previews are being refused:
   * "Storage full — some gallery previews can't be prepared".
   */
  storageFull?: boolean;
  revokedAt: string | null;
}
export interface GalleryPatchBody {
  name?: string;
  expiresOn?: string;
  downloads?: GalleryDownloads;
  extras?: Partial<GalleryExtras>;
  message?: string | null;
  /** Reopen a gallery paused after wrong passcodes. */
  unpause?: true;
}
export interface GalleryPhotosBody {
  add?: string[];
  remove?: string[];
}
export interface GalleryPhotoItem {
  photoId: string;
  position: number;
  favourites: number;
  /** Full-size download state for this photo. */
  full: 'n/a' | 'pending' | 'ready';
}
export interface GuestSelection {
  guestId: string;
  name: string | null;
  note: string | null;
  sentAt: string | null;
  photoIds: string[];
}
export interface GalleryStats {
  views: number;
  downloads: number;
  favourites: number;
  wrongPasscodesWeek: number;
}
export type GalleryEventKind =
  | 'opened'
  | 'unlocked'
  | 'downloaded'
  | 'favourites_sent'
  | 'wrong_passcode'
  | 'paused'
  | 'passcode_changed'
  | 'created'
  | 'revoked';
export interface GalleryEvent {
  kind: GalleryEventKind;
  at: string;
  /** Approximate place from the network ("Singapore", "Johor Bahru, Malaysia"); never an IP address. */
  place: string | null;
  /** Browser and OS family ("Safari on iPhone"). */
  device: string | null;
  count?: number;
}

export type BrandingAssetKind = 'logo' | 'watermark';
/** Accent colours guests' buttons can use (contrast-checked against white text). */
export const BRAND_ACCENTS = [
  '#2D5FD3',
  '#1F7A4D',
  '#A0461C',
  '#7A3940',
  '#0D1117',
  '#6B4FC8',
  '#0E6B78',
  '#8A5A00',
] as const;
export interface Branding {
  studioName: string | null;
  accent: (typeof BRAND_ACCENTS)[number] | null;
  hasLogo: boolean;
  watermark: {
    kind: 'text' | 'logo';
    /** Text watermarks are drawn on the member's device and uploaded as an image; this is the text it shows. */
    text: string | null;
    position: 'bottom-right' | 'bottom-left' | 'centre' | 'tiled';
    opacity: number; // 10–90
    hasImage: boolean;
  };
  /** The watermark can be drawn (text: its image is uploaded; logo: a logo is uploaded). */
  watermarkReady?: boolean;
  updatedAt: string | null;
}
export interface BrandingBody {
  studioName?: string | null;
  accent?: Branding['accent'];
  watermark?: Partial<Omit<Branding['watermark'], 'hasImage'>>;
}

// ---------------------------------------------------------------- guest side
export interface GuestBrand {
  /** Empty on an ended gallery (an old link names neither the gallery nor its owner). */
  studioName: string;
  accent: string | null;
  /** Same-origin, signed. */
  logoUrl: string | null;
}
export interface GuestGalleryInfo {
  ok: true;
  /** 'ended' covers expired and revoked; unknown tokens get 404 instead. */
  state: 'locked' | 'open' | 'paused' | 'ended';
  name: string;
  brand: GuestBrand;
  photoCount: number;
  expiresAt: string;
  downloads: GalleryDownloads;
  favourites: boolean;
  message: string | null;
  /** Shown on the passcode screen after repeated failures from this network. */
  turnstile: boolean;
  pausedUntil?: string;
}
export interface GuestUnlockBody {
  passcode: string;
  turnstileToken?: string;
}
export interface GuestPhoto {
  id: string;
  width: number;
  height: number;
  /** Same-origin signed URLs, valid for an hour. */
  grid: string;
  view: string;
  /** Present when downloads are on. `full` is null while a full-size render is still being prepared. */
  download?: { web: string; full: string | null };
  favourite?: boolean;
}
export interface GuestPhotoPage {
  ok: true;
  items: GuestPhoto[];
  nextCursor: string | null;
  /** This browser's favourites in the gallery and whether they were sent. */
  selection?: { count: number; sentAt: string | null; name: string | null };
}
export interface GuestSendBody {
  name: string;
  note?: string;
}

/** Why a guest reports a gallery. */
export const REPORT_REASONS = ['csam', 'violence', 'copyright', 'privacy', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_DETAILS_MAX = 1000;
export interface GuestReportBody {
  reason: ReportReason;
  /** Optional: the photo being reported (ignored unless it's in the gallery). */
  photoId?: string;
  details?: string;
  turnstileToken: string;
}
