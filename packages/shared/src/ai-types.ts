/**
 * Phase 6 contract: Zephyr AI. Types, constants and pure helpers only (browser-safe; no zod). See docs/phase-6.md.
 *
 * Where each feature runs:
 * - On the member's device (free, unlimited on every plan): auto-enhance (with skin tones), HDR & interior
 *   balance, colour match, quality signals for cleanup and Night, face grouping (opt-in, Pro and Studio).
 *   Auto-enhance, HDR and colour match only ever write normal recipe sliders (edit-types.ts).
 * - In the cloud (through Cloudflare AI Gateway, capped daily in Admin › Zephyr AI): studio background removal
 *   (costs credits; returns a mask stored next to the photo) and scene tags (free to members).
 */

export const AI_API = {
  // ---- member: status, settings, credits ---------------------------------------------------------------
  /** GET → AiStatusResult. Read on app start and every few minutes; the app hides what's off. */
  status: '/api/v1/ai',
  /** PATCH AiMemberSettingsPatch → AiStatusResult. Turning face grouping off deletes all face data. */
  settings: '/api/v1/ai/settings',
  /** GET ?cursor → CreditHistoryPage (newest first). */
  credits: '/api/v1/ai/credits',

  // ---- member: AI queue (cloud and device jobs) -------------------------------------------------------
  /** GET ?state=running|finished|failed&cursor → AiJobPage · POST AiJobCreateBody → 201 AiJobCreateResult */
  jobs: '/api/v1/ai/jobs',
  /** GET ?cursor → AiJobDetail (items page) · DELETE → { ok, job } (cancel: pending items refunded) */
  job: (id: string) => `/api/v1/ai/jobs/${encodeURIComponent(id)}`,
  /** POST AiJobRetryBody → { ok, job } (cloud jobs: failed items are charged again) */
  jobRetry: (id: string) => `/api/v1/ai/jobs/${encodeURIComponent(id)}/retry`,
  /** Device jobs. POST DeviceClaimBody → DeviceClaimResult · 409 conflict { holder } while another device holds it */
  jobClaim: (id: string) => `/api/v1/ai/jobs/${encodeURIComponent(id)}/claim`,
  /** Device jobs. POST DeviceProgressBody → { ok, job } (renews the lease) · 409 conflict when the lease was lost */
  jobProgress: (id: string) => `/api/v1/ai/jobs/${encodeURIComponent(id)}/progress`,
  /** Device jobs. POST {} → { ok, job } (status paused, lease released) */
  jobPause: (id: string) => `/api/v1/ai/jobs/${encodeURIComponent(id)}/pause`,

  /** GET → the photo's background mask: 8-bit greyscale PNG at the preview's size (owner only, private cache). */
  mask: (photoId: string, maskId: string) =>
    `/api/v1/photos/${encodeURIComponent(photoId)}/masks/${encodeURIComponent(maskId)}`,

  // ---- member: device-computed quality signals (cleanup, Night) ---------------------------------------
  /** GET ?cursor → SignalsPendingPage: photos whose signals are missing or from an older SIGNALS_VERSION. */
  signalsPending: '/api/v1/ai/signals/pending',
  /** POST AiSignalsBody → { ok, saved } */
  signals: '/api/v1/ai/signals',
  /** GET ?cursor → CleanupPage (Pro and Studio): every photo's signals, for grouping on the device. */
  cleanup: '/api/v1/ai/cleanup',
  /** POST CleanupIgnoreBody → { ok } ("Not duplicates" / "Keep" on a blurry photo) */
  cleanupIgnore: '/api/v1/ai/cleanup/ignore',

  // ---- member: scenes ----------------------------------------------------------------------------------
  /** GET → { ok, scenes: SceneSummary[] }. Photos of one scene: LIBRARY_API.photos with ?scene=<SceneId>. */
  scenes: '/api/v1/ai/scenes',

  // ---- member: faces and people (opt-in, Pro and Studio) -----------------------------------------------
  /** GET ?cursor → FacesPendingPage: photos not yet scanned with the current FACE_MODEL_VERSION. */
  facesPending: '/api/v1/ai/faces/pending',
  /** POST FacesBody → { ok, saved } · DELETE → 204 (turn face grouping off and delete all face data) */
  faces: '/api/v1/ai/faces',
  /** GET ?hidden=1 → { ok, people: PersonSummary[] } (named people, and unnamed ones with ≥ MIN_PERSON_FACES) */
  people: '/api/v1/ai/people',
  /** GET → { ok, person } · PATCH PersonPatchBody → { ok, person }. Photos: LIBRARY_API.photos with ?person=<id>. */
  person: (id: string) => `/api/v1/ai/people/${encodeURIComponent(id)}`,
  /** POST PersonMergeBody → { ok, person } (the listed people move into this one and are deleted) */
  personMerge: (id: string) => `/api/v1/ai/people/${encodeURIComponent(id)}/merge`,
  /** POST PersonFacesBody → { ok, person } (not this person, move to another, confirm suggestions) */
  personFaces: (id: string) => `/api/v1/ai/people/${encodeURIComponent(id)}/faces`,
  /** GET → { ok, suggestions: FaceSuggestion[] } (auto-matches to named people, least sure first) */
  suggestions: '/api/v1/ai/people/suggestions',
} as const;

export const ADMIN_AI_API = {
  /** GET → AdminAiSettingsResult · PATCH AiSettingsPatch → AdminAiSettingsResult (403 reauth_required, see isRiskLowering) */
  settings: '/admin/api/v1/ai/settings',
  /** GET → AdminAiJobsResult */
  jobs: '/admin/api/v1/ai/jobs',
} as const;

// ---------------------------------------------------------------- features
export const AI_FEATURES = [
  'auto_enhance',
  'hdr',
  'color_match',
  'cleanup',
  'face_grouping',
  'scene_tags',
  'bg_removal',
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];
export const DEVICE_FEATURES: readonly AiFeature[] = [
  'auto_enhance',
  'hdr',
  'color_match',
  'cleanup',
  'face_grouping',
];
export const CLOUD_FEATURES: readonly AiFeature[] = ['scene_tags', 'bg_removal'];
/** Device steps a batch (device job) can run, in this order. */
export const DEVICE_STEPS = ['auto_enhance', 'hdr', 'color_match'] as const;
export type DeviceStep = (typeof DEVICE_STEPS)[number];

/**
 * Why a feature is or isn't available to this member, most decisive first:
 * admin (switched off in Admin, or the master switch), plan (not on the member's plan),
 * member (the member turned it off / never opted in), paused (cloud: daily cap or admin pause; jobs wait).
 */
export type AiFeatureState = 'on' | 'off_admin' | 'off_plan' | 'off_member' | 'paused';

export interface AiMemberSettings {
  /** Opt-in (Pro and Studio). Off by default. */
  faceGrouping: boolean;
  /** When the member last gave face-grouping consent (null when off). */
  faceConsentAt: string | null;
  /** Scene tags send each new upload's 512 px thumbnail to Workers AI. On by default. */
  sceneTags: boolean;
  /** Device-side duplicate and blur checks. On by default. */
  cleanup: boolean;
}

export interface CreditBalance {
  balance: number;
  /** Credits the plan grants each month. */
  monthly: number;
  /** Credit periods are calendar months in UTC until billing (phase 7) brings subscription periods. */
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD, exclusive
  /** Unused credits carry into the next period (plan_limits.credits_rollover). */
  rollover: boolean;
  /** Credits per background removal right now (Admin › Zephyr AI). */
  bgCreditsPerPhoto: number;
}

export interface AiStatus {
  /** Master switch. Off: every AI control is hidden and the app shows "Zephyr AI is paused". */
  enabled: boolean;
  features: Record<AiFeature, AiFeatureState>;
  /** Cloud work is waiting: the daily cap was reached (until 00:00 UTC) or an admin paused it. */
  cloudPaused: { reason: 'cap' | 'admin'; until: string | null } | null;
  member: AiMemberSettings;
  credits: CreditBalance;
  /** Plan batch size (also caps device jobs and AiJobCreateBody.photoIds). */
  batchSize: number;
}
export interface AiStatusResult extends AiStatus {
  ok: true;
}

/** Version of the face-grouping consent text. Bump when the wording changes materially. */
export const FACE_CONSENT_VERSION = 1;
export interface AiMemberSettingsPatch {
  /** Turning on requires `faceConsent`. Turning off deletes every face, person and name at once. */
  faceGrouping?: boolean;
  faceConsent?: { version: number; rightsConfirmed: true };
  sceneTags?: boolean;
  cleanup?: boolean;
}

// ---------------------------------------------------------------- credits
export const CREDIT_REASONS = [
  'monthly_grant',
  'period_expiry',
  'job_charge',
  'job_refund',
  'admin_adjust',
  'top_up',
] as const;
export type CreditReason = (typeof CREDIT_REASONS)[number];
export interface CreditEntry {
  id: string;
  at: string;
  delta: number;
  reason: CreditReason;
  /** Short description: the job title and photo count, or the photo's file name for a refund. */
  label: string | null;
  jobId: string | null;
}
export interface CreditHistoryPage {
  ok: true;
  balance: CreditBalance;
  entries: CreditEntry[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------- background removal (the recipe side lives in edit-types.ts: CutoutSettings)
export const CUTOUT_BACKGROUNDS = ['transparent', 'white', 'color', 'original'] as const;
export type CutoutBackground = (typeof CUTOUT_BACKGROUNDS)[number];
export const CUTOUT_SHADOWS = ['none', 'soft', 'contact'] as const;
export type CutoutShadow = (typeof CUTOUT_SHADOWS)[number];
/** Background swatches offered in the editor (any #rrggbb is accepted). */
export const CUTOUT_SWATCHES = ['#FFFFFF', '#F4F1EC', '#E9E1D3', '#DCE6EE', '#0D1117'] as const;
/** What a background removal applies once its mask arrives (the mask id is filled in by the server). */
export interface CutoutApply {
  bg: CutoutBackground;
  color?: string; // #rrggbb, only with bg 'color'
  shadow?: CutoutShadow;
  shadowStrength?: number; // 0–100
}
export const DEFAULT_CUTOUT_APPLY: CutoutApply = { bg: 'white', shadow: 'soft', shadowStrength: 40 };
/** The provider sees the photo's untouched preview (≤ 2048 px on the long edge), never the original file. */
export const CUTOUT_SOURCE_EDGE = 2048;
/** Mask PNG limits checked on what a provider returns. */
export const MASK_LIMITS = {
  maxEdge: 2048,
  maxBytes: 2 * 1024 * 1024,
  /** A provider's PNG for a ≤ 2048 px source is well under this (decoded size is bounded by the source too). */
  providerMaxBytes: 8 * 1024 * 1024,
  aspectTolerance: 0.02,
} as const;

// ---------------------------------------------------------------- jobs
export type AiJobKind = 'bg_removal' | 'device';
export type AiJobStatus = 'queued' | 'running' | 'waiting' | 'paused' | 'done' | 'canceled';
export type AiItemStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'canceled';
export type AiItemError =
  | 'provider_timeout' // the provider didn't answer in time, twice (refunded)
  | 'provider_error' // the provider failed (refunded)
  | 'bad_output' // the provider's mask didn't pass our checks (refunded)
  | 'no_preview' // the photo has no preview yet (refunded)
  | 'photo_deleted' // trashed or deleted while queued (refunded; not retryable)
  | 'feature_off' // switched off in Admin while queued (refunded)
  | 'device_failed'; // device job: this photo couldn't be processed on the device

export interface DeviceJobParams {
  steps: DeviceStep[];
  /** Auto-enhance strength 0–100 (default 70) and skin tones on/off (default on). */
  strength?: number;
  skin?: boolean;
  /** HDR strength 0–100 (default 50). */
  hdrStrength?: number;
  /** Colour match: the reference photo (one of the member's) and strength 0–100 (default 80). */
  reference?: string;
  matchStrength?: number;
}

export interface AiJobSummary {
  id: string;
  kind: AiJobKind;
  title: string;
  status: AiJobStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  counts: {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    canceled: number;
  };
  /** Cloud jobs: credits charged so far and refunded. Device jobs: zeros. */
  credits: { charged: number; refunded: number };
  /** bg_removal: what is applied when each mask arrives. */
  apply: CutoutApply | null;
  /** device: the steps and parameters. */
  params: DeviceJobParams | null;
  /** device: which device holds the job right now (label like "Chrome on Mac"), if its lease is live. */
  holder: { device: string; until: string; self: boolean } | null;
  /** First few photo ids, for the card's thumbnail. */
  coverPhotoId: string | null;
}
export interface AiJobItem {
  id: string;
  photoId: string;
  filename: string;
  status: AiItemStatus;
  error: AiItemError | null;
  /** Credits this photo currently costs the member (0 once refunded). */
  credits: number;
  maskId: string | null;
  retryable: boolean;
}
export interface AiJobPage {
  ok: true;
  jobs: AiJobSummary[];
  nextCursor: string | null;
  /** Counts for the tabs. */
  counts: { running: number; finished: number; failed: number };
}
export interface AiJobDetail {
  ok: true;
  job: AiJobSummary;
  items: AiJobItem[];
  nextCursor: string | null;
}
export type AiJobCreateBody =
  | {
      kind: 'bg_removal';
      photoIds: string[];
      apply?: CutoutApply;
      title?: string;
      /** Run again on photos that already have a mask (charged again). */
      force?: boolean;
    }
  | {
      kind: 'device';
      photoIds: string[];
      params: DeviceJobParams;
      title?: string;
      /** This device's label; it claims the job straight away. */
      device: string;
      /** This tab's runner token (RUNNER_TOKEN_RE): the job's first lease is this tab's, so it claims at once. */
      runner?: string;
    };
export type AiSkipReason = 'already_cut_out' | 'not_found' | 'no_preview';
export interface AiJobCreateResult {
  ok: true;
  job: AiJobSummary;
  skipped: { photoId: string; reason: AiSkipReason }[];
}
/** 402 insufficient_credits carries these. */
export interface InsufficientCredits {
  ok: false;
  error: 'insufficient_credits';
  needed: number;
  balance: number;
}
export interface AiJobRetryBody {
  /** Failed items to retry; all retryable failed items when left out. */
  itemIds?: string[];
}
export interface DeviceClaimBody {
  device: string;
  /**
   * This tab's runner token (RUNNER_TOKEN_RE): with it, another tab of the same sign-in can't claim or report
   * on a job this tab holds (409 conflict).
   */
  runner?: string;
}
/** A runner token: 16 random bytes, base64url (22 characters). */
export const RUNNER_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
export interface DeviceClaimResult {
  ok: true;
  job: AiJobSummary;
  /** Photo ids still to process, in order. */
  remaining: string[];
}
export interface DeviceProgressBody {
  done?: string[];
  failed?: string[];
  /** The token the job was claimed with (DeviceClaimBody.runner). */
  runner?: string;
}
/** A device lease lasts this long without progress; then the job shows "Waiting for this device". */
export const DEVICE_LEASE_SECONDS = 120;
/**
 * Refunded provider failures (timeouts, errors, rejected output) a member can have in one UTC day; after
 * that their background removals wait until tomorrow. Mirrors public._ai_failure_budget().
 */
export const AI_FAILURE_BUDGET = 50;
export const DEVICE_LABEL_MAX = 40;
export const JOB_TITLE_MAX = 80;

// ---------------------------------------------------------------- quality signals (device)
/** Bump when the signal maths change, so every photo is measured again. */
export const SIGNALS_VERSION = 1;
export interface PhotoSignals {
  id: string;
  /** 64-bit DCT perceptual hash of the 512 px thumbnail, 16 lowercase hex characters. */
  phash: string;
  /** Variance of the Laplacian on the 512 px thumbnail's luminance (0–65025). Low = blurry. */
  sharpness: number;
  /** Mean luminance of the thumbnail, 0–1. */
  brightness: number;
  /** Device's Night verdict (dark overall with bright points, or dark and taken at night). */
  night: boolean;
}
export interface AiSignalsBody {
  v: number; // SIGNALS_VERSION
  photos: PhotoSignals[]; // ≤ 100
}
export interface SignalsPendingPage {
  ok: true;
  /** takenAt feeds the device's Night rule (dark and taken at night). */
  photos: { id: string; takenAt: string | null }[];
  nextCursor: string | null;
  remaining: number;
}
export interface CleanupPhoto {
  id: string;
  phash: string;
  sharpness: number;
  takenAt: string | null;
  createdAt: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  dupIgnored: boolean;
  blurIgnored: boolean;
}
export interface CleanupPage {
  ok: true;
  photos: CleanupPhoto[];
  nextCursor: string | null;
}
export interface CleanupIgnoreBody {
  kind: 'duplicates' | 'blurry';
  photoIds: string[]; // ≤ 500
}
/** Grouping thresholds used on the device. */
export const CLEANUP = {
  duplicateBits: 4, // pHash Hamming distance for duplicates, any time apart
  burstBits: 10, // and for similar bursts…
  burstSeconds: 60, // …taken this close together
  blurSharpness: 60, // Laplacian variance below this counts as blurry
} as const;

// ---------------------------------------------------------------- scenes
export const SCENES = [
  'beach',
  'mountains',
  'forest',
  'water',
  'snow',
  'flowers',
  'food',
  'pets',
  'animals',
  'architecture',
  'interiors',
  'vehicles',
  'documents',
  'night',
] as const;
export type SceneId = (typeof SCENES)[number];
export const SCENE_LABELS: Record<SceneId, string> = {
  beach: 'Beach',
  mountains: 'Mountains',
  forest: 'Forest',
  water: 'Water & boats',
  snow: 'Snow',
  flowers: 'Flowers',
  food: 'Food',
  pets: 'Pets',
  animals: 'Animals',
  architecture: 'Architecture',
  interiors: 'Interiors',
  vehicles: 'Vehicles',
  documents: 'Documents',
  night: 'Night',
};
export interface SceneSummary {
  scene: SceneId;
  count: number;
  coverPhotoId: string;
}
/** Minimum classifier score for a scene tag (summed over the labels that map to the scene). */
export const SCENE_MIN_SCORE = 0.25;

// ---------------------------------------------------------------- faces and people
/** YuNet 2023mar (detection, MIT) + SFace 2021dec int8 (embedding, Apache 2.0), both from OpenCV Zoo. */
export const FACE_MODEL_VERSION = 1;
export const FACE_EMBEDDING_DIMS = 128;
export interface FaceInput {
  /** Normalised [x, y, w, h] in the photo's preview (0–1). */
  box: [number, number, number, number];
  /** Detector confidence 0–1 (faces under FACE_LIMITS.minScore are dropped on the device). */
  score: number;
  /** 128 float32 values, little-endian, base64 (684 characters: 683 + one '='). L2-normalised by the server. */
  embedding: string;
}
export interface FacesBody {
  v: number; // FACE_MODEL_VERSION
  photos: { id: string; faces: FaceInput[] }[]; // ≤ 20 photos, ≤ FACE_LIMITS.perPhoto faces each
}
export const FACE_LIMITS = {
  perPhoto: 30,
  minScore: 0.8,
  /** Smallest face kept, in pixels of the 2048 px preview. */
  minPixels: 40,
  /** Cosine similarity for an automatic match to a person. */
  match: 0.42,
  /** Matches below this (but ≥ match) to a named person are shown as suggestions. */
  sure: 0.55,
} as const;
/** Unnamed groups appear once they have this many faces. */
export const MIN_PERSON_FACES = 3;
/**
 * People (groups) a member can have. Beyond it the oldest unnamed one-face groups are pruned (their faces
 * stay, unassigned), which bounds the work of matching each new face. Mirrors public._ai_people_max().
 */
export const MAX_PEOPLE = 3000;
export const PERSON_NAME_MAX = 60;
export interface FacesPendingPage {
  ok: true;
  photos: { id: string }[];
  nextCursor: string | null;
  remaining: number;
  total: number;
}
export interface PersonSummary {
  id: string;
  name: string | null;
  faceCount: number;
  photoCount: number;
  hidden: boolean;
  cover: { photoId: string; box: [number, number, number, number] } | null;
  /** Earliest and latest takenAt among the person's photos. */
  firstAt: string | null;
  lastAt: string | null;
}
export interface PersonPatchBody {
  name?: string | null;
  hidden?: boolean;
  coverFaceId?: string;
}
export interface PersonMergeBody {
  from: string[]; // ≤ 50
}
/** Exactly one of photoIds (all of this person's faces in those photos) or faceIds. */
export type PersonFacesBody =
  | { action: 'remove'; photoIds?: string[]; faceIds?: string[] }
  | { action: 'confirm'; photoIds?: string[]; faceIds?: string[] }
  | { action: 'move'; to: string | 'new'; photoIds?: string[]; faceIds?: string[] };
export interface FaceSuggestion {
  faceId: string;
  photoId: string;
  box: [number, number, number, number];
  personId: string;
  personName: string;
  similarity: number;
}

// ---------------------------------------------------------------- admin
export const BG_PROVIDERS = ['runware', 'fal_bria'] as const;
export type BgProvider = (typeof BG_PROVIDERS)[number];
export const CAP_ALERTS = [50, 80, 100] as const;
export type CapAlert = (typeof CAP_ALERTS)[number];
export interface AiSettings {
  enabled: boolean;
  /** Admin "Pause new cloud jobs": queued cloud work waits; nothing is refunded. */
  cloudPaused: boolean;
  features: Record<AiFeature, boolean>;
  bgProvider: BgProvider;
  bgFallback: BgProvider | 'none';
  /** Runware model AIR id, e.g. runware:112@5 (BiRefNet General). */
  runwareModel: string;
  /** fal endpoint path, e.g. fal-ai/bria/background/remove. */
  falModel: string;
  /** Workers AI model id for scene tags, e.g. @cf/microsoft/resnet-50. */
  sceneModel: string;
  bgCreditsPerPhoto: number; // 1–20
  /** Estimated USD per call, in micro-dollars, used for caps when a provider doesn't report its cost. */
  costs: { runwareMicros: number; falMicros: number; sceneMicros: number };
  /** Daily caps in USD (UTC day). */
  caps: { total: number; bgRemoval: number; sceneTags: number; perUser: number };
  alerts: CapAlert[];
  atCap: 'pause' | 'alert_only';
  alertTo: 'owners' | 'owners_finance';
  /** Cloud job requests per member per minute (AI_LIMITER is the coarse guard). */
  memberJobsPerMinute: number;
  updatedAt: string;
  updatedBy: string | null;
}
export type AiSettingsPatch = Partial<
  Omit<AiSettings, 'updatedAt' | 'updatedBy' | 'features' | 'costs' | 'caps'>
> & {
  features?: Partial<Record<AiFeature, boolean>>;
  costs?: Partial<AiSettings['costs']>;
  caps?: Partial<AiSettings['caps']>;
};
export interface AiSpendToday {
  day: string; // YYYY-MM-DD (UTC)
  totalUsd: number;
  bgRemovalUsd: number;
  sceneTagsUsd: number;
  /** Cloud work is waiting because a cap was reached. */
  capped: boolean;
  /** Credits members spent today. */
  credits: number;
  photos: number;
}
export interface AdminAiSettingsResult {
  ok: true;
  settings: AiSettings;
  spend: AiSpendToday;
}
export interface AdminAiJobsResult {
  ok: true;
  counts: { pending: number; processing: number; completedToday: number; failedToday: number };
  /** Seconds per photo over the last hour. */
  latency: { label: string; p50: number | null; p95: number | null }[];
  providers: {
    provider: BgProvider | 'workers_ai';
    feature: 'bg_removal' | 'scene_tags';
    role: 'primary' | 'fallback';
    calls: number; // last 24 h
    successRate: number | null; // 0–1
    p95: number | null;
  }[];
  failures: {
    jobId: string;
    itemId: string;
    /** First 8 characters of the member id; admins never see photos here. */
    member: string;
    feature: 'bg_removal' | 'scene_tags';
    error: AiItemError;
    at: string;
  }[];
  spend: AiSpendToday;
}

/**
 * True when every change in `patch` can only reduce risk or spend: switching things off, pausing, lowering a
 * cap or the per-member rate, or adding an alert. Such changes save straight away; anything else needs a
 * passkey sign-in in the last 10 minutes (403 reauth_required) and emails every Owner.
 */
export function isRiskLowering(prev: AiSettings, patch: AiSettingsPatch): boolean {
  for (const [k, v] of Object.entries(patch) as [keyof AiSettingsPatch, unknown][]) {
    if (v === undefined) continue;
    switch (k) {
      case 'enabled':
        if (v !== false && prev.enabled !== v) return false;
        break;
      case 'cloudPaused':
        if (v !== true && prev.cloudPaused !== v) return false;
        break;
      case 'features':
        for (const [f, on] of Object.entries(v as Record<string, boolean | undefined>)) {
          if (on === true && !prev.features[f as AiFeature]) return false;
        }
        break;
      case 'caps':
        for (const [c, n] of Object.entries(v as Record<string, number | undefined>)) {
          if (typeof n === 'number' && n > prev.caps[c as keyof AiSettings['caps']]) return false;
        }
        break;
      case 'alerts':
        if (!prev.alerts.every((a) => (v as CapAlert[]).includes(a))) return false;
        break;
      case 'costs':
        for (const [c, n] of Object.entries(v as Record<string, number | undefined>)) {
          if (typeof n === 'number' && n !== prev.costs[c as keyof AiSettings['costs']]) return false;
        }
        break;
      case 'memberJobsPerMinute':
        if ((v as number) > prev.memberJobsPerMinute) return false;
        break;
      default: {
        // Providers, models, cost estimates, credits per photo, the at-cap action and alert recipients.
        const before = (prev as unknown as Record<string, unknown>)[k];
        if (JSON.stringify(before) !== JSON.stringify(v)) return false;
      }
    }
  }
  return true;
}
