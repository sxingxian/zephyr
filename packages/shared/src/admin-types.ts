/**
 * Phase 8 contract: the admin portal (users, safety, plan limits, ads, storage switch, retention, staff, audit,
 * settings) and the member-side pieces it needs (status, ads, gallery link replacement). Types and constants only,
 * so browser bundles can import them. Request schemas: ./admin-schemas.ts (zod, API only). Design: docs/phase-8.md.
 *
 * High-risk changes need a passkey sign-in in the last 10 minutes (403 `reauth_required`) and email every Owner
 * (decided 15 Nov 2026; replaces the two-person rule). Changes that only lower risk save at once. Everything is
 * written to the append-only audit log with a reason.
 */
import type { StaffRole } from './api-types';
import type { PaidPlanId } from './billing-types';
import type { PlanId, PlanLimits } from './plans';
import type { ReportReason } from './share-types';

// ================================================================ roles
/** What each staff role may do (the API enforces it; the admin app hides what's not allowed). */
export const STAFF_CAN = {
  usersView: ['owner', 'admin', 'finance', 'safety', 'support'],
  /** Sign out everywhere, grant credits (Support up to SUPPORT_CREDIT_GRANT_MAX). */
  usersAct: ['owner', 'admin', 'safety', 'support'],
  planOverride: ['owner', 'admin', 'finance'],
  suspend: ['owner', 'admin', 'safety'],
  /** Schedule or cancel an account deletion. */
  deleteAccount: ['owner'],
  safetyView: ['owner', 'admin', 'safety'],
  /** Reveal reported photos (never hash-match holds), resolve reports. */
  safetyAct: ['safety'],
  /** Record the report made for a hash-match hold, release a hold (Owner, reauth). */
  holdsRecord: ['owner', 'safety'],
  holdsRelease: ['owner'],
  limits: ['owner', 'finance'],
  limitsView: ['owner', 'admin', 'finance'],
  ads: ['owner', 'admin'],
  adsense: ['owner'],
  storage: ['owner', 'admin'],
  retention: ['owner', 'admin'],
  staff: ['owner'],
  auditView: ['owner', 'admin', 'finance', 'safety'],
  auditExport: ['owner', 'admin'],
  settings: ['owner', 'admin'],
} as const satisfies Record<string, readonly StaffRole[]>;
export type StaffAction = keyof typeof STAFF_CAN;
export const staffCan = (role: StaffRole, action: StaffAction): boolean =>
  (STAFF_CAN[action] as readonly StaffRole[]).includes(role);

export const ADMIN_REASON_MAX = 300;
/** Support may grant at most this many credits per action; more needs Owner or Admin with a passkey. */
export const SUPPORT_CREDIT_GRANT_MAX = 1000;
/**
 * Rolling 24-hour credit limits (mirrored in admin_user_grant_credits). Support and Safety: at most this much in
 * total across all members, and at most SUPPORT_CREDIT_MEMBER_DAILY_MAX to one member (from Support and Safety
 * together). An Owner or Admin passing SUPPORT_CREDIT_DAILY_MAX of their own needs a passkey and emails the Owners.
 */
export const SUPPORT_CREDIT_DAILY_MAX = 5000;
export const SUPPORT_CREDIT_MEMBER_DAILY_MAX = 1000;
export const CREDIT_GRANT_MAX = 50_000;

// ================================================================ routes
export const ADMIN8_API = {
  // users
  /** GET ?q=&plan=&source=&status=&cursor= → AdminUsersResult. q: an exact email, a usr_… / uuid id, or a name prefix. */
  users: '/admin/api/v1/users',
  /** GET → AdminUserResult */
  user: (id: string) => `/admin/api/v1/users/${encodeURIComponent(id)}`,
  /** PUT AdminPlanOverrideBody → AdminUserResult (reauth) · DELETE AdminReasonBody → AdminUserResult (ends it) */
  userPlan: (id: string) => `/admin/api/v1/users/${encodeURIComponent(id)}/plan`,
  /** POST AdminCreditGrantBody → AdminUserResult */
  userCredits: (id: string) => `/admin/api/v1/users/${encodeURIComponent(id)}/credits`,
  /** POST AdminReasonBody → AdminUserResult */
  userSignOut: (id: string) => `/admin/api/v1/users/${encodeURIComponent(id)}/sign-out`,
  /** POST AdminSuspendBody → AdminUserResult · DELETE AdminReasonBody → AdminUserResult (unsuspend, reauth) */
  userSuspend: (id: string) => `/admin/api/v1/users/${encodeURIComponent(id)}/suspension`,
  /** DELETE AdminReasonBody → AdminUserResult (lift a sharing suspension, reauth) */
  userSharing: (id: string) => `/admin/api/v1/users/${encodeURIComponent(id)}/sharing-suspension`,
  /** POST AdminReasonBody → AdminUserResult (schedule deletion, Owner, reauth) · DELETE → cancel */
  userDeletion: (id: string) => `/admin/api/v1/users/${encodeURIComponent(id)}/deletion`,

  // safety
  /** GET ?state=open|resolved → AdminSafetyResult */
  safety: '/admin/api/v1/safety',
  /** GET → AdminReportResult */
  report: (id: string) => `/admin/api/v1/safety/reports/${encodeURIComponent(id)}`,
  /** POST AdminReasonBody → AdminRevealResult (Safety, reauth; refused for held photos) */
  reportReveal: (id: string) => `/admin/api/v1/safety/reports/${encodeURIComponent(id)}/reveal`,
  /** POST AdminResolveBody → AdminSafetyResult */
  reportResolve: (id: string) => `/admin/api/v1/safety/reports/${encodeURIComponent(id)}/resolve`,
  /** GET ?t=<grant token> → image (no-store). Only during an active reveal grant, only for that staff member. */
  revealMedia: (grantId: string, photoId: string) =>
    `/admin/api/v1/safety/reveal/${encodeURIComponent(grantId)}/${encodeURIComponent(photoId)}`,
  /** POST AdminHoldReportBody → AdminSafetyResult (record the report made to the authorities) */
  holdReport: (id: string) => `/admin/api/v1/safety/holds/${encodeURIComponent(id)}/report`,
  /** POST AdminReasonBody → AdminSafetyResult (release a hold: Owner, reauth) */
  holdRelease: (id: string) => `/admin/api/v1/safety/holds/${encodeURIComponent(id)}/release`,

  // plan limits
  /** GET → AdminLimitsResult */
  limits: '/admin/api/v1/limits',
  /** POST { fromVersion } → AdminLimitsResult (one draft at a time) · PUT AdminLimitsDraftBody · DELETE */
  limitsDraft: '/admin/api/v1/limits/draft',
  /** POST { effectiveAt } → AdminLimitsPreviewResult */
  limitsPreview: '/admin/api/v1/limits/draft/preview',
  /** POST AdminLimitsScheduleBody → AdminLimitsResult (reauth; emails affected members for decreases) */
  limitsSchedule: '/admin/api/v1/limits/draft/schedule',
  /** DELETE AdminReasonBody → AdminLimitsResult (cancel a scheduled version; saves at once) */
  limitsScheduled: '/admin/api/v1/limits/scheduled',

  // ads
  /** GET → AdminAdsResult */
  ads: '/admin/api/v1/ads',
  /** POST AdminAdCardBody → AdminAdsResult */
  adCards: '/admin/api/v1/ads/cards',
  /** PATCH Partial<AdminAdCardBody> & { status? } → AdminAdsResult · DELETE → AdminAdsResult */
  adCard: (id: string) => `/admin/api/v1/ads/cards/${encodeURIComponent(id)}`,
  /** PUT image/jpeg|png|webp body (≤ 5 MB) → AdminAdsResult (re-encoded to 1200 × 628 JPEG) */
  adCardImage: (id: string) => `/admin/api/v1/ads/cards/${encodeURIComponent(id)}/image`,
  /** PATCH AdminAdsensePatch → AdminAdsResult (turning on: Owner, reauth) */
  adsense: '/admin/api/v1/ads/adsense',

  // storage
  /** GET → AdminStorageResult */
  storage: '/admin/api/v1/storage',
  /** POST {} → AdminStorageResult (runs the health check for that store now) */
  storageCheck: (storeId: string) => `/admin/api/v1/storage/stores/${encodeURIComponent(storeId)}/check`,
  /** POST AdminStorageSwitchBody → AdminStorageResult (reauth) */
  storageSwitch: '/admin/api/v1/storage/switch',
  /** POST { action: 'pause' | 'resume' | 'rollback', reason } → AdminStorageResult (rollback: reauth) */
  storageMigration: '/admin/api/v1/storage/migration',
  /** POST AdminStorageAbandonBody → AdminStorageResult (Owner only, reauth; the store must be unreachable or gone) */
  storageAbandon: '/admin/api/v1/storage/abandon',

  // retention
  /** GET → AdminRetentionResult */
  retention: '/admin/api/v1/retention',
  /** POST AdminRetentionApproveBody → AdminRetentionResult (reauth) */
  retentionApprove: '/admin/api/v1/retention/approve',

  // staff
  /** GET → AdminStaffResult */
  staff: '/admin/api/v1/staff',
  /** POST AdminStaffInviteBody → AdminStaffResult (Owner, reauth) */
  staffInvites: '/admin/api/v1/staff/invites',
  /** DELETE → AdminStaffResult (revoke) */
  staffInvite: (id: string) => `/admin/api/v1/staff/invites/${encodeURIComponent(id)}`,
  /** PATCH { role, reason } · DELETE AdminReasonBody → AdminStaffResult (Owner, reauth; 409 last_owner) */
  staffMember: (userId: string) => `/admin/api/v1/staff/${encodeURIComponent(userId)}`,
  /** POST { token } (no session; the staff invite link) → { ok, email } then the normal admin email-code sign-in */
  staffInviteAccept: '/admin/api/v1/staff/invite/accept',

  // audit
  /** GET ?actor=&kind=&target=&from=&to=&cursor= → AdminAuditResult */
  audit: '/admin/api/v1/audit',
  /** GET same filters → text/csv (Owner, Admin; ≤ 50,000 rows) */
  auditExport: '/admin/api/v1/audit/export',

  // settings
  /** GET → AdminSettingsResult · PATCH AdminSettingsPatch → AdminSettingsResult */
  settings: '/admin/api/v1/settings',
} as const;

export const MEMBER8_API = {
  /** GET → AppStatusResult (no session; cached 30 s). Read-only mode and the maintenance notice. */
  status: '/api/v1/status',
  /** GET → AdsResult (session; empty for plans without ads) */
  ads: '/api/v1/ads',
  /** POST AdEventBody → 204 (counted, never tied to the member) */
  adEvent: '/api/v1/ads/events',
  /**
   * POST {} → 204 (no session needed; same-origin only). Sent before the page reloads off Google's AdSense script
   * (the member it was loaded for is gone or lost ads): answers `Clear-Site-Data: "cache", "storage"` and clears
   * the AdSense cookie, so nothing the script could have written survives.
   */
  adReset: '/api/v1/ads/reset',
  /**
   * POST StepUpBody → 202 { ok, needed: true } (a one-time code was emailed) | 200 { ok, needed: false } (this
   * member doesn't need one right now) | 429. Phase 8: account-level changes (adding or removing a passkey,
   * deleting the account) by a member who may be shown AdSense need that code in STEP_UP_HEADER, as well as a
   * recent sign-in: Google's script runs with the member's session, but can't read their email.
   */
  stepUp: '/api/v1/me/step-up',
  /** GET → image (public, immutable; the URL carries the image version) */
  adImage: (cardId: string, version: number) =>
    `/api/v1/ads/cards/${encodeURIComponent(cardId)}/image?v=${version}`,
  /** POST {} → GalleryLinkResult (galleries role in the library; the old link stops at once) */
  galleryLinkReplace: (galleryId: string) =>
    `/api/v1/galleries/${encodeURIComponent(galleryId)}/link/replace`,
} as const;
/**
 * Phase 8: set by GET /api/v1/ads (HttpOnly, Secure, SameSite=Strict, host-only, 15 minutes) only when the member
 * is shown AdSense, and cleared otherwise and on sign-out. The app Worker sends the AdSense CSP variant only for
 * documents whose request carries it (and only on ad pages, while AdSense is on), so a visitor who isn't shown
 * AdSense never gets the wider policy. Mirrored in apps/web/worker/adPages.js.
 */
export const ADS_DOC_COOKIE = '__Host-zads';
export const ADS_DOC_COOKIE_MAX_AGE = 15 * 60;
/**
 * Phase 8: set by GET /api/v1/ads (HttpOnly, 30 days) whenever it returns AdSense: this browser may have run
 * Google's script. A session that ends in a document without the script asks POST /ads/reset with
 * `{ ifSeen: true }`, which clears the site's storage only when this cookie is present (then clears it).
 */
export const ADS_SEEN_COOKIE = '__Host-zseen';
export const ADS_SEEN_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
/** Account-level changes that need a step-up code while the member may be shown AdSense. */
export const STEP_UP_OPS = ['passkey_add', 'passkey_remove', 'account_delete'] as const;
export type StepUpOp = (typeof STEP_UP_OPS)[number];
/** Request header carrying the emailed step-up code (6 digits). */
export const STEP_UP_HEADER = 'X-Zephyr-Step-Up';
export const STEP_UP_CODE_LENGTH = 6;
/** A code works once, for this long, for one operation; 5 wrong tries burn it; 5 codes per operation an hour. */
export const STEP_UP_CODE_MINUTES = 10;
export const STEP_UP_MAX_ATTEMPTS = 5;
export const STEP_UP_SENDS_PER_HOUR = 5;
export interface StepUpBody {
  op: StepUpOp;
}
export interface StepUpResult {
  ok: true;
  needed: boolean;
}
/** TEAM_API.member DELETE accepts ?replaceLinks=1: replaces the links of every live gallery in that library. */
export const TEAM_REMOVE_REPLACE_LINKS_PARAM = 'replaceLinks';
/** Most links `gallery_links_replace` rotates in one call (one transaction); the API pages through more. */
export const GALLERY_LINKS_REPLACE_MAX = 500;

// ================================================================ common
export interface AdminReasonBody {
  reason: string;
}
export interface Cursor<T> {
  items: T[];
  nextCursor: string | null;
}

// ================================================================ users
export type MemberStatus = 'active' | 'read_only' | 'suspended' | 'deletion_scheduled';
export type PlanSource = 'stripe' | 'admin';
export interface AdminUserRow {
  id: string;
  displayName: string | null;
  /** Masked (m•••@example.com) in lists; full only in AdminUserDetail. */
  email: string;
  plan: PlanId;
  planSource: PlanSource;
  storageBytes: number;
  status: MemberStatus;
  createdAt: string;
  lastSeenAt: string | null;
}
export interface AdminUsersResult {
  ok: true;
  total: number;
  page: Cursor<AdminUserRow>;
}
export interface AdminUserDetail extends AdminUserRow {
  /** Full address, shown only in the detail view (audit-logged as "viewed user"). */
  email: string;
  subscription: {
    plan: PaidPlanId;
    interval: 'month' | 'year';
    status: string;
    renewsAt: string | null;
    stripeCustomerUrl: string | null;
  } | null;
  override: { plan: PlanId; until: string | null; by: string; reason: string } | null;
  usage: {
    storageBytes: number;
    storageLimitBytes: number;
    credits: number;
    topUpCredits: number;
    liveGalleries: number;
  };
  teams: { ownerId: string; name: string; role: 'editor' | 'viewer' }[];
  signIn: { passkeys: number; activeSessions: number; lastPasskeyAt: string | null };
  suspension: { at: string; category: SuspendCategory; by: string } | null;
  sharingSuspendedAt: string | null;
  deletionDueAt: string | null;
  /** The latest 10 staff actions on this member. */
  recent: AdminAuditEntry[];
}
export interface AdminUserResult {
  ok: true;
  user: AdminUserDetail;
}
export interface AdminPlanOverrideBody {
  plan: PlanId;
  /** ISO date-time, ≤ 2 years ahead; null = no end. */
  until: string | null;
  reason: string;
}
export interface AdminCreditGrantBody {
  amount: number;
  reason: string;
}
export const SUSPEND_CATEGORIES = ['abuse', 'safety', 'fraud', 'legal', 'other'] as const;
export type SuspendCategory = (typeof SUSPEND_CATEGORIES)[number];
export interface AdminSuspendBody {
  category: SuspendCategory;
  note: string;
  /** Email the member that the account is suspended (off for safety or legal cases where it could cause harm). */
  notify: boolean;
}

// ================================================================ safety
export interface AdminReportRow {
  id: string;
  reason: ReportReason;
  /** Reports about the same gallery or photo from different networks, grouped. */
  count: number;
  galleryId: string | null;
  galleryName: string | null;
  galleryState: 'live' | 'paused' | 'expired' | 'ended' | null;
  ownerId: string | null;
  photoIds: string[];
  createdAt: string;
  resolvedAt: string | null;
  resolution: { actions: ResolveAction[]; note: string; by: string } | null;
}
export interface AdminReportDetail extends AdminReportRow {
  /** Reporters' own words (≤ 1,000 chars each), never their network or identity. */
  details: string[];
  ownerPlan: PlanId | null;
  /** Photos currently on hold (never revealable). */
  heldPhotoIds: string[];
}
export interface AdminHold {
  id: string;
  photoId: string;
  ownerId: string;
  source: 'csam_scan' | 'staff';
  heldAt: string;
  reportedAt: string | null;
  reportReference: string | null;
}
export interface AdminSafetyResult {
  ok: true;
  kpis: {
    open: number;
    olderThan24h: number;
    holds: number;
    sharingSuspended: number;
    medianHoursToAction: number | null;
  };
  reports: AdminReportRow[];
  holds: AdminHold[];
}
export interface AdminReportResult {
  ok: true;
  report: AdminReportDetail;
}
export const REVEAL_MINUTES = 10;
export interface AdminRevealResult {
  ok: true;
  grantId: string;
  expiresAt: string;
  /** One URL per revealable photo (held photos are left out). Each needs the grant token below. */
  photos: { id: string; url: string }[];
  /** Sent as ?t= on each URL; bound to this staff member and grant; valid until expiresAt. */
  token: string;
}
export const RESOLVE_ACTIONS = [
  'remove_photos',
  'end_gallery',
  'suspend_sharing',
  'suspend_account',
  'hold_photos',
] as const;
export type ResolveAction = (typeof RESOLVE_ACTIONS)[number];
export interface AdminResolveBody {
  /** Empty = dismiss with no action. */
  actions: ResolveAction[];
  note: string;
}
export interface AdminHoldReportBody {
  /** Who the report went to, e.g. "NCMEC CyberTipline". */
  authority: string;
  /** Their reference number. */
  reference: string;
}

// ================================================================ plan limits
export type LimitsVersionStatus = 'draft' | 'scheduled' | 'active' | 'superseded' | 'cancelled';
export interface LimitsVersion {
  version: number;
  status: LimitsVersionStatus;
  effectiveAt: string | null;
  reason: string;
  createdBy: string | null;
  createdAt: string;
  limits: Record<PlanId, PlanLimits>;
}
export interface AdminLimitsResult {
  ok: true;
  active: LimitsVersion;
  scheduled: LimitsVersion | null;
  draft: LimitsVersion | null;
  history: Omit<LimitsVersion, 'limits'>[];
}
export interface AdminLimitsDraftBody {
  limits: Record<PlanId, PlanLimits>;
}
export interface LimitChange {
  plan: PlanId;
  field: keyof PlanLimits;
  from: unknown;
  to: unknown;
  direction: 'up' | 'down' | 'same';
}
export interface AdminLimitsPreviewResult {
  ok: true;
  changes: LimitChange[];
  /** True when any change lowers a limit: the version needs an effective date ≥ LIMITS_NOTICE_DAYS ahead. */
  decreases: boolean;
  earliestEffectiveAt: string;
  /** Members on a plan with a lower limit; they're emailed when it's scheduled. */
  membersEmailed: number;
  /** Members already over a new limit (storage, seats): their libraries become read-only, or extra seats suspended. */
  membersOver: number;
}
export const LIMITS_NOTICE_DAYS = 30;
export interface AdminLimitsScheduleBody {
  /** null = now (allowed only without decreases). */
  effectiveAt: string | null;
  reason: string;
}

// ================================================================ ads
export const AD_PLACEMENTS = ['library', 'sidebar', 'batch'] as const;
export type AdPlacement = (typeof AD_PLACEMENTS)[number];
export type AdCardStatus = 'draft' | 'scheduled' | 'live' | 'ended';
export const AD_LIMITS = {
  advertiser: 40,
  headline: 40,
  body: 90,
  url: 500,
  imageBytes: 5 * 1024 * 1024,
} as const;
export interface AdCard {
  id: string;
  advertiser: string;
  headline: string;
  body: string;
  /** https only, no credentials in the URL. */
  url: string;
  placements: AdPlacement[];
  startsAt: string | null;
  endsAt: string | null;
  /** 1–100, relative share among live cards in a placement. */
  weight: number;
  imageVersion: number | null;
  status: AdCardStatus;
  stats7d: { impressions: number; clicks: number };
}
export interface AdminAdCardBody {
  advertiser: string;
  headline: string;
  body: string;
  url: string;
  placements: AdPlacement[];
  startsAt: string | null;
  endsAt: string | null;
  weight: number;
}
export interface AdsenseConfig {
  enabled: boolean;
  /** ca-pub-<16 digits> */
  publisherId: string | null;
  /** Ad unit (slot) ids per placement: 10 digits. */
  slots: Partial<Record<AdPlacement, string>>;
  /** When and by whom the risk was accepted (shown in Admin). */
  enabledAt: string | null;
  enabledBy: string | null;
}
export interface AdminAdsensePatch {
  enabled?: boolean;
  publisherId?: string | null;
  slots?: Partial<Record<AdPlacement, string | null>>;
  reason: string;
}
export interface AdminAdsResult {
  ok: true;
  kpis: { freeMembers: number; impressions7d: number; clicks7d: number };
  cards: AdCard[];
  adsense: AdsenseConfig;
}
/** Member side. */
export interface AdsResult {
  ok: true;
  /** Cards live now for the member's placements (empty when the plan has no ads). */
  cards: {
    id: string;
    advertiser: string;
    headline: string;
    body: string;
    url: string;
    imageUrl: string | null;
    placements: AdPlacement[];
    weight: number;
  }[];
  /** Present only when AdSense is on and the plan has ads. */
  adsense: { publisherId: string; slots: Partial<Record<AdPlacement, string>> } | null;
}
export interface AdEventBody {
  cardId: string;
  kind: 'impression' | 'click';
  placement: AdPlacement;
}

// ================================================================ storage
export type StoreKind = 'r2' | 's3';
/** binding: R2 Worker binding · https: public S3 endpoint · vpc: Workers VPC service binding · tunnel: Tunnel hostname behind a Cloudflare Access service token. */
export type StoreConnection = 'binding' | 'https' | 'vpc' | 'tunnel';
export type StoreHealth = 'healthy' | 'degraded' | 'unreachable' | 'unknown';
export interface StoreCheck {
  at: string;
  reachable: boolean;
  latencyMs: number | null;
  roundTrip: boolean; // signed write, read and delete of a test object
  uploadMBps: number | null;
  freeBytes: number | null; // when the deployment declares capacity, or the store reports it
  capacityBytes: number | null;
  error: string | null; // short code, never a response body
}
export interface StoreStatus {
  id: string;
  name: string;
  kind: StoreKind;
  connection: StoreConnection;
  /** Declared in the deployment config (docs/setup.md §3.8): used for the cost estimate. */
  costPerTbMonthUsd: number | null;
  egressNote: string | null;
  /** The deployment confirms encryption at rest (NFR-SEC-02); Zephyr can't check it from outside. */
  encryptionAtRest: boolean;
  health: StoreHealth;
  lastCheck: StoreCheck | null;
  objects: number;
  bytes: number;
  current: boolean;
}
export type MigrationState =
  | 'copying'
  | 'paused'
  | 'verifying'
  | 'holding'
  | 'done'
  | 'rolling_back'
  | 'rolled_back'
  | 'failed';
export interface StorageMigration {
  id: string;
  from: string;
  to: string;
  state: MigrationState;
  /** forward: from → to; back: a rollback (to → from), which keeps its direction when paused or failed. */
  direction: 'forward' | 'back';
  /** False once it's a rollback or an old copy's deletion has started. */
  canRollBack: boolean;
  startedAt: string;
  startedBy: string;
  /** waiting: queued photos still uploading or publishing their variants (copied once they're done; the
   *  migration can't finish before). */
  photos: { total: number; copied: number; verified: number; failed: number; waiting?: number };
  /** total is approximate while photos move: photos not copied yet count their original and variants only. */
  bytes: { total: number; copied: number };
  /** Old copies are deleted only after every photo is verified and this hold has passed. */
  deleteOldAfter: string | null;
  lastError: string | null;
}
export interface AdminStorageResult {
  ok: true;
  /** Where new uploads go. */
  writeStore: string;
  stores: StoreStatus[];
  migration: StorageMigration | null;
  totals: { photos: number; bytes: number };
  /** Read-only mode turned on automatically because the write store stopped answering. */
  autoReadOnly: boolean;
  /** Old copies still waiting for deletion, per store (an Owner can abandon them on a store that's gone). */
  oldCopies?: { storeId: string; copies: number }[];
  /** Follow-up copies outstanding, and how many were dropped after 7 days in the last 30 days. */
  followups?: { pending: number; dropped30d: number };
}
export interface AdminStorageSwitchBody {
  to: string;
  reason: string;
}
/** Give up on the old copies waiting on a store that's unreachable or no longer configured (bytes may remain). */
export interface AdminStorageAbandonBody {
  store: string;
  reason: string;
}
/** Follow-up copies older than this are dropped (audited, counted in Admin › Storage). */
export const STORAGE_FOLLOWUP_MAX_DAYS = 7;
export const STORAGE_HOLD_DAYS = 7;
export const STORAGE_FREE_ALERT = 0.15;

// ================================================================ retention
export const RETENTION_DAYS = 365;
export const RETENTION_NOTICE_DAYS = [30, 7] as const;
export type RetentionState = 'waiting' | 'ready' | 'approved' | 'trashed' | 'resolved';
export interface RetentionItem {
  ownerId: string;
  displayName: string | null;
  lapsedAt: string;
  dueAt: string;
  overBytes: number;
  /** Oldest photos beyond the Free storage, excluding held photos and photos in live galleries. */
  photosToTrash: number;
  notices: { d30: string | null; d7: string | null };
  state: RetentionState;
}
export interface AdminRetentionResult {
  ok: true;
  kpis: { readOnly: number; dueIn30Days: number; ready: number; resolvedThisMonth: number };
  items: RetentionItem[];
}
export interface AdminRetentionApproveBody {
  ownerIds: string[];
  reason: string;
}

// ================================================================ staff
export interface StaffMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: StaffRole;
  passkeys: number;
  lastActiveAt: string | null;
  createdAt: string;
}
export interface StaffInvite {
  id: string;
  email: string;
  role: StaffRole;
  createdAt: string;
  expiresAt: string;
  createdBy: string;
}
export interface AdminStaffResult {
  ok: true;
  staff: StaffMember[];
  invites: StaffInvite[];
}
export interface AdminStaffInviteBody {
  email: string;
  role: StaffRole;
  reason: string;
}
export const STAFF_INVITE_HOURS = 72;

// ================================================================ audit
export interface AdminAuditEntry {
  id: string;
  at: string;
  actor: { id: string | null; name: string; role: StaffRole | 'system' };
  action: string;
  target: string | null;
  reason: string | null;
}
export const AUDIT_KINDS = [
  'users',
  'safety',
  'billing',
  'limits',
  'storage',
  'staff',
  'ads',
  'settings',
  'ai',
  'signups',
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
export interface AdminAuditResult {
  ok: true;
  page: Cursor<AdminAuditEntry>;
}

// ================================================================ settings / app status
export interface AppNotice {
  on: boolean;
  message: string;
  startsAt: string | null;
  endsAt: string | null;
}
export interface AdminSettings {
  readOnly: { on: boolean; auto: boolean; message: string; since: string | null };
  maintenance: AppNotice;
  access: { accessConfigured: boolean; staffWithPasskey: number; staffTotal: number; idleMinutes: number };
  alerts: { safetyAlertConfigured: boolean; owners: number };
}
export interface AdminSettingsResult extends AdminSettings {
  ok: true;
}
export interface AdminSettingsPatch {
  readOnly?: { on: boolean; message?: string };
  maintenance?: Partial<AppNotice>;
  reason: string;
}
export const NOTICE_MESSAGE_MAX = 200;
export interface AppStatusResult {
  ok: true;
  readOnly: { on: boolean; message: string } | null;
  maintenance: { message: string; startsAt: string | null; endsAt: string | null } | null;
}

// ================================================================ member side: gallery links
export interface GalleryLinkResult {
  ok: true;
  /** The new full link, shown once (stored encrypted, like phase 5). */
  link: string;
}
