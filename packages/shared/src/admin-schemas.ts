import { z } from 'zod';
import {
  AD_LIMITS,
  AD_PLACEMENTS,
  ADMIN_REASON_MAX,
  AUDIT_KINDS,
  CREDIT_GRANT_MAX,
  NOTICE_MESSAGE_MAX,
  RESOLVE_ACTIONS,
  STEP_UP_CODE_LENGTH,
  STEP_UP_OPS,
  SUSPEND_CATEGORIES,
} from './admin-types';
import { SYSTEM_MAX_BATCH } from './plans';

const PLAN_IDS = ['free', 'pro', 'studio'] as const;

/** Server-side request schemas for the phase 8 admin portal (docs/phase-8.md). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').trim();
const text = (max: number, min = 1) => z.string().transform(clean).pipe(z.string().min(min).max(max));
const reason = text(ADMIN_REASON_MAX, 3);
const uuid = z
  .string()
  .uuid()
  .transform((s) => s.toLowerCase());
const isoFuture = z.string().datetime({ offset: true });

export const adminReasonSchema = z.object({ reason }).strict();
export const adminIdSchema = uuid;

const planId = z.enum(PLAN_IDS);
export const adminUsersQuerySchema = z
  .object({
    q: z.string().trim().max(254).optional(),
    plan: planId.optional(),
    source: z.enum(['stripe', 'admin']).optional(),
    status: z.enum(['active', 'read_only', 'suspended', 'deletion_scheduled']).optional(),
    cursor: z.string().max(200).optional(),
  })
  .strict();
export const adminPlanOverrideSchema = z
  .object({ plan: planId, until: isoFuture.nullable(), reason })
  .strict();
export const adminCreditGrantSchema = z
  .object({ amount: z.number().int().min(1).max(CREDIT_GRANT_MAX), reason })
  .strict();
export const adminSuspendSchema = z
  .object({ category: z.enum(SUSPEND_CATEGORIES), note: reason, notify: z.boolean() })
  .strict();

export const adminSafetyQuerySchema = z
  .object({ state: z.enum(['open', 'resolved']).default('open') })
  .strict();
export const adminResolveSchema = z
  .object({
    actions: z
      .array(z.enum(RESOLVE_ACTIONS))
      .max(RESOLVE_ACTIONS.length)
      .refine((a) => new Set(a).size === a.length, 'duplicate'),
    note: reason,
  })
  .strict();
export const adminHoldReportSchema = z.object({ authority: text(120, 2), reference: text(120, 2) }).strict();
/** Reveal grant tokens: 32 random bytes, base64url. */
export const revealTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const nonNeg = z.number().int().min(0);
const planLimitsSchema = z
  .object({
    storageGb: z.number().int().min(0).max(100_000),
    cloudCreditsPerMonth: nonNeg.max(1_000_000),
    batchSize: z.number().int().min(1).max(SYSTEM_MAX_BATCH),
    fileTypes: z
      .array(z.enum(['jpeg', 'png', 'webp', 'heic', 'cr2', 'nef', 'arw', 'dng']))
      .min(1)
      .max(8)
      .refine((a) => new Set(a).size === a.length, 'duplicate'),
    galleries: nonNeg.max(100_000).nullable(),
    maxLinkDays: z.number().int().min(1).max(3650).nullable(),
    guestFullRes: z.boolean(),
    peopleGrouping: z.boolean(),
    qualityCleanup: z.boolean(),
    branding: z.boolean(),
    guestFavourites: z.boolean(),
    watermark: z.boolean(),
    accessLog: z.boolean(),
    seats: z.number().int().min(1).max(100),
    ads: z.boolean(),
    priorityQueue: z.boolean(),
  })
  .strict();
export const adminLimitsDraftSchema = z
  .object({
    limits: z.object({ free: planLimitsSchema, pro: planLimitsSchema, studio: planLimitsSchema }).strict(),
  })
  .strict();
export const adminLimitsFromSchema = z.object({ fromVersion: z.number().int().min(1) }).strict();
export const adminLimitsPreviewSchema = z.object({ effectiveAt: isoFuture.nullable() }).strict();
export const adminLimitsScheduleSchema = z.object({ effectiveAt: isoFuture.nullable(), reason }).strict();

/** https only, no credentials, no IP-literal or localhost hosts, ≤ 500 chars. */
export const adUrlSchema = z
  .string()
  .trim()
  .max(AD_LIMITS.url)
  .refine((u) => {
    try {
      const x = new URL(u);
      if (x.protocol !== 'https:' || x.username || x.password) return false;
      const h = x.hostname;
      return h.includes('.') && !/^[\d.]+$/.test(h) && !h.startsWith('[') && h !== 'localhost';
    } catch {
      return false;
    }
  }, 'https_only');
const placements = z
  .array(z.enum(AD_PLACEMENTS))
  .min(1)
  .max(AD_PLACEMENTS.length)
  .refine((a) => new Set(a).size === a.length, 'duplicate');
const adCardBase = z.object({
  advertiser: text(AD_LIMITS.advertiser),
  headline: text(AD_LIMITS.headline),
  body: text(AD_LIMITS.body),
  url: adUrlSchema,
  placements,
  startsAt: isoFuture.nullable(),
  endsAt: isoFuture.nullable(),
  weight: z.number().int().min(1).max(100),
});
export const adminAdCardSchema = adCardBase
  .strict()
  .refine((c) => !c.startsAt || !c.endsAt || c.startsAt < c.endsAt, 'dates');
export const adminAdCardPatchSchema = adCardBase
  .partial()
  .extend({ status: z.enum(['draft', 'scheduled', 'ended']).optional() })
  .strict();
export const adminAdsensePatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    publisherId: z
      .string()
      .regex(/^ca-pub-\d{16}$/)
      .nullable()
      .optional(),
    slots: z
      .object(
        Object.fromEntries(
          AD_PLACEMENTS.map((p) => [
            p,
            z
              .string()
              .regex(/^\d{10}$/)
              .nullable()
              .optional(),
          ]),
        ),
      )
      .strict()
      .optional(),
    reason,
  })
  .strict();
export const adEventSchema = z
  .object({ cardId: uuid, kind: z.enum(['impression', 'click']), placement: z.enum(AD_PLACEMENTS) })
  .strict();
/** POST /api/v1/me/step-up. */
export const stepUpSchema = z.object({ op: z.enum(STEP_UP_OPS) }).strict();
/** The code in STEP_UP_HEADER: exactly the emailed digits. */
export const STEP_UP_CODE_RE = new RegExp(`^\\d{${STEP_UP_CODE_LENGTH}}$`);
/** POST /api/v1/ads/reset: `ifSeen` clears the site's storage only if this browser may have run AdSense. */
export const adResetSchema = z.object({ ifSeen: z.boolean().optional() }).strict();

/** Store ids come from the deployment config: lower-case slug. */
/** Store ids: the same rule as public._store_id_ok (the API tests compare them); secrets map dashes to underscores. */
export const STORE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const storeIdSchema = z.string().regex(STORE_ID_RE);
export const adminStorageSwitchSchema = z.object({ to: storeIdSchema, reason }).strict();
export const adminStorageMigrationSchema = z
  .object({ action: z.enum(['pause', 'resume', 'rollback']), reason })
  .strict();
export const adminStorageAbandonSchema = z
  .object({ store: storeIdSchema, reason, acknowledgeRollbackEnds: z.boolean().optional() })
  .strict();
export const adminStorageGiveUpSchema = z.object({ reason }).strict();

export const adminRetentionApproveSchema = z
  .object({ ownerIds: z.array(uuid).min(1).max(100), reason })
  .strict();

const staffRole = z.enum(['owner', 'admin', 'finance', 'safety', 'support']);
const email = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(
    z
      .string()
      .max(254)
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  );
export const adminStaffInviteSchema = z.object({ email, role: staffRole, reason }).strict();
export const adminStaffPatchSchema = z.object({ role: staffRole, reason }).strict();
export const staffInviteTokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

export const adminAuditQuerySchema = z
  .object({
    actor: uuid.optional(),
    kind: z.enum(AUDIT_KINDS).optional(),
    target: z.string().trim().max(120).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    cursor: z.string().max(200).optional(),
  })
  .strict();

const notice = text(NOTICE_MESSAGE_MAX);
export const adminSettingsPatchSchema = z
  .object({
    readOnly: z.object({ on: z.boolean(), message: notice.optional() }).strict().optional(),
    maintenance: z
      .object({
        on: z.boolean().optional(),
        message: notice.optional(),
        startsAt: z.string().datetime({ offset: true }).nullable().optional(),
        endsAt: z.string().datetime({ offset: true }).nullable().optional(),
      })
      .strict()
      .optional(),
    reason,
  })
  .strict();
