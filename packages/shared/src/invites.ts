import { z } from 'zod';
import { INVITE_REQUEST_LIMITS, USE_CASES, type UseCase } from './invite-constants';

export * from './invite-constants';

const USE_CASE_IDS = USE_CASES.map((u) => u.id) as [UseCase, ...UseCase[]];

/** Body of POST /api/v1/invite-requests. */
export const inviteRequestSchema = z.object({
  email: z
    .string()
    .trim()
    .max(INVITE_REQUEST_LIMITS.maxEmailLength)
    .pipe(z.email())
    .transform((e) => e.toLowerCase()),
  useCase: z.enum(USE_CASE_IDS).optional(),
  turnstileToken: z.string().min(1).max(2048),
});
export type InviteRequestInput = z.input<typeof inviteRequestSchema>;
export type InviteRequest = z.output<typeof inviteRequestSchema>;
