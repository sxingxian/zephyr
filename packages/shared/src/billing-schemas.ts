import { z } from 'zod';
import {
  BILLING_INTERVALS,
  isSafeLabel,
  LOOKUP_KEYS,
  PAID_PLANS,
  PRICE_BOUNDS,
  PRICE_REASON_MAX,
  TEAM_NAME_MAX,
  TEAM_ROLES,
  TOPUP_PACKS,
} from './billing-types';

/** Server-side request schemas for phase 7 billing and teams (docs/phase-7.md). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').trim();
const text = (max: number) => z.string().transform(clean).pipe(z.string().min(1).max(max));
const uuid = z
  .string()
  .uuid()
  .transform((s) => s.toLowerCase());

const plan = z.enum(PAID_PLANS as unknown as [string, ...string[]]) as z.ZodType<'pro' | 'studio'>;
const interval = z.enum(BILLING_INTERVALS);
const packKeys = TOPUP_PACKS.map((p) => p.lookupKey) as [string, ...string[]];

export const checkoutSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('subscription'), plan, interval }).strict(),
  z.object({ kind: z.literal('topup'), pack: z.enum(packKeys) }).strict(),
]);

export const planChangeSchema = z.object({ plan, interval }).strict();

/** Stripe Checkout Session ids: cs_test_… / cs_live_… */
export const checkoutSessionIdSchema = z.string().regex(/^cs_(test|live)_[A-Za-z0-9]{10,200}$/);

/** Lower-cased, trimmed, ≤ 254, one @ with a dot in the domain. Never logged. */
const email = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(
    z
      .string()
      .max(254)
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  );

export const teamInviteSchema = z.object({ email, role: z.enum(TEAM_ROLES) }).strict();
export const teamMemberPatchSchema = z.object({ role: z.enum(TEAM_ROLES) }).strict();
export const teamNamePatchSchema = z
  .object({ name: text(TEAM_NAME_MAX).refine(isSafeLabel, "letters, numbers, spaces and . , ' & - only") })
  .strict();
/** Team invite tokens: 32 random bytes, base64url (43 chars). */
export const teamInviteTokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
/** X-Zephyr-Library header value. */
export const libraryHeaderSchema = uuid;

const lookupKey = z.enum(LOOKUP_KEYS as unknown as [string, ...string[]]);
const amount = z.number().int().min(PRICE_BOUNDS.min).max(PRICE_BOUNDS.max);
export const adminPriceSchema = z.object({ lookupKey, amount, reason: text(PRICE_REASON_MAX) }).strict();
export const adminPricePreviewSchema = z.object({ lookupKey, amount }).strict();
export const adminPackPatchSchema = z.object({ active: z.boolean() }).strict();
export const adminLookupKeySchema = lookupKey;
