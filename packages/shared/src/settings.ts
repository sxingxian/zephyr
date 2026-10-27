/** Who can create an account. Stored in `app_settings.signup_mode`; Invite only is the default. */
export const SIGNUP_MODES = ['open', 'invite_only'] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];
export const DEFAULT_SIGNUP_MODE: SignupMode = 'invite_only';

/** What the landing page needs to know at runtime. Served by GET /api/v1/public/config. */
export interface PublicConfig {
  signupMode: SignupMode;
  /** False when admins turn off the request form or pause all sign-ups. */
  acceptingInviteRequests: boolean;
  signupsPaused: boolean;
}
