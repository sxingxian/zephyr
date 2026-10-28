import { z } from 'zod';
import { INVITE_REQUEST_LIMITS } from './invite-constants';

/** Request body schemas for the phase 2 API. Unknown keys are stripped. Server-side only (zod). */
const email = z
  .string()
  .trim()
  .max(INVITE_REQUEST_LIMITS.maxEmailLength)
  .pipe(z.email())
  .transform((e) => e.toLowerCase());
const turnstileToken = z.string().min(1).max(2048);
const id = z.string().uuid();
/** Invite tokens: 32 random bytes, base64url (43 chars). */
export const inviteToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const inviteCodeValue = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{4,32}$/);
const displayName = z.string().trim().min(1).max(80);

export const emailStartSchema = z.object({ email, turnstileToken });
export const adminEmailStartSchema = z.object({ email });
export const emailVerifySchema = z.object({ email, code: z.string().regex(/^\d{6}$/) });
export const passkeyVerifySchema = z.object({
  challengeId: z.string().min(1).max(200),
  credential: z
    .record(z.string(), z.unknown())
    .refine((c) => JSON.stringify(c).length <= 16_000, 'too large'),
});
export const profilePatchSchema = z.object({ displayName: displayName.nullable() });
export const passkeyRenameSchema = z.object({ friendlyName: z.string().trim().min(1).max(120) });
export const invitePreviewSchema = z.object({ token: inviteToken });
export const inviteRedeemSchema = z.object({ token: inviteToken, displayName: displayName.optional() });
export const inviteCodeSchema = z.object({ code: inviteCodeValue, email, turnstileToken });
export const memberInviteSchema = z.object({ email, note: z.string().trim().max(500).optional() });

export const signupSettingsPatchSchema = z
  .object({
    signupMode: z.enum(['open', 'invite_only']),
    acceptInviteRequests: z.boolean(),
    signupsPaused: z.boolean(),
    memberInvitesEnabled: z.boolean(),
    memberInvitesPerMonth: z.number().int().min(0).max(50),
    inviteTtlDays: z.number().int().min(1).max(90),
    reason: z.string().trim().max(500),
  })
  .partial()
  .refine((p) => Object.keys(p).some((k) => k !== 'reason'), 'no changes');
export const adminInviteSchema = z.object({
  emails: z.array(z.string().trim().max(INVITE_REQUEST_LIMITS.maxEmailLength)).min(1).max(50),
  note: z.string().trim().max(500).optional(),
});
export const inviteCodeCreateSchema = z.object({
  code: inviteCodeValue,
  label: z.string().trim().max(80).optional(),
  maxUses: z.number().int().min(1).max(10_000),
  expiresAt: z.iso.datetime().optional(),
});
export const decideSchema = z.object({
  ids: z.array(id).min(1).max(100),
  decision: z.enum(['approve', 'decline']),
});
export const listQuerySchema = z.object({
  status: z.string().max(20).optional(),
  cursor: z.string().max(200).optional(),
});
