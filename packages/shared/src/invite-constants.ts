/** Optional "what will you use Zephyr for?" answers on the invite-request form. */
export const USE_CASES = [
  { id: 'weddings_events', label: 'Weddings & events' },
  { id: 'portraits', label: 'Portraits' },
  { id: 'real_estate', label: 'Real estate' },
  { id: 'products', label: 'Products' },
  { id: 'personal', label: 'Personal albums' },
] as const;
export type UseCase = (typeof USE_CASES)[number]['id'];

/** Limits shared by the form, the API and the database. */
export const INVITE_REQUEST_LIMITS = {
  /** Requests allowed per network (hashed IP) per window. */
  perNetwork: 5,
  windowMinutes: 15,
  /** Unapproved requests are deleted after this many days. */
  retentionDays: 90,
  maxEmailLength: 254,
} as const;

/**
 * The API gives the same answer for every accepted request, whether or not the email already has an
 * account or a pending request, so the form can't be used to find out who uses Zephyr.
 */
export const INVITE_REQUEST_ACCEPTED = { ok: true } as const;

export type InviteRequestError =
  | 'invalid'
  | 'verification_failed'
  | 'rate_limited'
  | 'not_accepting'
  | 'server';
export interface InviteRequestErrorBody {
  ok: false;
  error: InviteRequestError;
  /** Seconds until the client may retry (rate limited only). */
  retryAfter?: number;
}
