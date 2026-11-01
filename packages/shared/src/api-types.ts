/**
 * Phase 2 HTTP contract shared by the API Worker, the app (PWA) and /admin. Types and constants only, so
 * browser bundles can import it from '@zephyr/shared/client'. Request validation schemas live in
 * ./api-schemas.ts (zod).
 *
 * Sessions are httpOnly cookies set by the API; the browser never sees a token. __Host- cookies (Secure,
 * Path=/, no Domain) so no sibling *.midnightpoetry.studio host can set or shadow them; a request that
 * carries any of these names twice is refused with 401 and the cookies are cleared.
 *   app:   __Host-zs-at, __Host-zs-rt                  Path=/  SameSite=Lax     (zephyrapp.midnightpoetry.studio)
 *   admin: __Host-za-at, __Host-za-rt, __Host-za-seen  Path=/  SameSite=Strict  (zephyr.midnightpoetry.studio)
 * Every non-GET request must be JSON (content-type: application/json) and carry an allowed Origin.
 */

// ---------------------------------------------------------------- routes
export const APP_API = {
  emailStart: '/api/v1/auth/email/start', // POST EmailStartBody → 202 Accepted (same reply for every email)
  emailVerify: '/api/v1/auth/email/verify', // POST EmailVerifyBody → 200 SessionResponse | 400 invalid_code | 403 verification_failed | 429
  passkeyOptions: '/api/v1/auth/passkey/options', // POST {} → 200 PasskeyOptions (authentication)
  passkeyVerify: '/api/v1/auth/passkey/verify', // POST PasskeyVerifyBody → 200 SessionResponse
  session: '/api/v1/auth/session', // GET → 200 SessionResponse | 401
  signOut: '/api/v1/auth/sign-out', // POST {} → 204
  me: '/api/v1/me', // PATCH ProfilePatchBody → 200 SessionResponse
  myPasskeys: '/api/v1/me/passkeys', // GET → 200 { passkeys: Passkey[] }
  myPasskeyOptions: '/api/v1/me/passkeys/options', // POST {} → 200 PasskeyOptions (registration) | 403 reauth_required
  myPasskeyVerify: '/api/v1/me/passkeys/verify', // POST PasskeyVerifyBody → 201 { passkey: Passkey } | 403 reauth_required
  myPasskey: (id: string) => `/api/v1/me/passkeys/${encodeURIComponent(id)}`, // PATCH {friendlyName} | DELETE → 204 (DELETE: 403 reauth_required)
  invitePreview: '/api/v1/invites/preview', // POST { token } → 200 InvitePreview | 404 invite_invalid
  inviteRedeem: '/api/v1/invites/redeem', // POST InviteRedeemBody → 200 SessionResponse | 404 invite_invalid
  inviteCode: '/api/v1/invites/code', // POST InviteCodeBody → 202 Accepted (same reply whether or not the code is valid)
  myInvites: '/api/v1/invites/mine', // GET → 200 MemberInvites
  memberInvite: '/api/v1/invites', // POST MemberInviteBody → 201 { invite: InviteRow } | 403 | 409 | 429 | 500 (email not sent; invite revoked)
} as const;

export const ADMIN_API = {
  emailStart: '/admin/api/v1/auth/email/start', // POST { email } → 202 (staff with no passkey yet: enrolment only)
  emailVerify: '/admin/api/v1/auth/email/verify', // POST EmailVerifyBody → 200 AdminSessionResponse (enrolOnly: true)
  passkeyOptions: '/admin/api/v1/auth/passkey/options', // POST {} → 200 PasskeyOptions
  passkeyVerify: '/admin/api/v1/auth/passkey/verify', // POST PasskeyVerifyBody → 200 AdminSessionResponse
  session: '/admin/api/v1/auth/session', // GET → 200 AdminSessionResponse | 401
  signOut: '/admin/api/v1/auth/sign-out', // POST {} → 204
  passkeyEnrolOptions: '/admin/api/v1/me/passkeys/options', // POST {} → 200 PasskeyOptions (registration) | 403 passkey_required (enrol-only session, already has a passkey)
  passkeyEnrolVerify: '/admin/api/v1/me/passkeys/verify', // POST PasskeyVerifyBody → 201 AdminSessionResponse
  signups: '/admin/api/v1/signups', // GET → 200 SignupsOverview
  settings: '/admin/api/v1/signups/settings', // PATCH SignupSettingsPatch → 200 SignupSettings
  invites: '/admin/api/v1/signups/invites', // GET ?status&cursor → 200 Page<InviteRow>; POST AdminInviteBody → 200 AdminInviteResult
  inviteResend: (id: string) => `/admin/api/v1/signups/invites/${encodeURIComponent(id)}/resend`, // POST {} → 200 { invite } | 404 | 409 already_member | 409 conflict (expired and superseded by a newer invite)
  inviteRevoke: (id: string) => `/admin/api/v1/signups/invites/${encodeURIComponent(id)}/revoke`, // POST {} → 200 { invite }
  codes: '/admin/api/v1/signups/codes', // POST InviteCodeCreateBody → 201 { code: InviteCodeRow }
  codeRevoke: (id: string) => `/admin/api/v1/signups/codes/${encodeURIComponent(id)}/revoke`, // POST {} → 200 { code }
  requests: '/admin/api/v1/signups/requests', // GET ?status&cursor → 200 Page<InviteRequestRow>
  requestsDecide: '/admin/api/v1/signups/requests/decide', // POST DecideBody → 200 DecideResult
} as const;

// ---------------------------------------------------------------- errors
export type ApiErrorCode =
  | 'invalid' // body failed validation
  | 'unauthenticated' // no or expired session
  | 'forbidden' // signed in but not allowed (role, staff vs member, Access)
  | 'verification_failed' // Turnstile failed
  | 'rate_limited'
  | 'invalid_code' // wrong or expired email code
  | 'invite_invalid' // unknown, expired, revoked or used invite token (never says which)
  | 'signups_paused'
  | 'member_invites_disabled'
  | 'quota_exceeded' // member invite quota for this month
  | 'already_member' // inviting someone who already has an account
  | 'passkey_failed' // WebAuthn ceremony rejected
  | 'passkey_required' // admin: enrolment session can only add a passkey
  | 'reauth_required' // adding or removing a passkey needs a sign-in in the last 10 minutes
  | 'not_found'
  | 'conflict'
  | 'account_pending_deletion' // scheduled for deletion: only restore, session and sign-out work
  | 'upload_expired'
  | 'too_large'
  | 'storage_full'
  | 'session_changed' // uploads: X-Zephyr-Expected-User names a different user than the session (shared device)
  | 'wrong_passcode' // guest gallery unlock (phase 5): see `remaining` and `turnstile`
  | 'gallery_paused' // too many wrong passcodes from anywhere: unlocking paused until `pausedUntil`
  | 'sharing_suspended' // the account's sharing is suspended pending a safety review
  | 'plan_required' // the member's plan doesn't include this (e.g. full-size downloads, Studio extras)
  | 'limit_reached' // a plan count is used up (e.g. live galleries)
  | 'pending' // guest media (425): that image is still being prepared (edit not rendered, watermark not ready, storage full); retry later
  | 'asset_in_use' // branding (409): the image is drawn by the watermark of a live gallery
  | 'server';

export interface ApiError {
  ok: false;
  error: ApiErrorCode;
  /** Seconds before retrying (rate_limited). */
  retryAfter?: number;
  /** wrong_passcode: attempts left for this network in the current window. */
  remaining?: number;
  /** wrong_passcode: the next attempt needs a Turnstile token. */
  turnstile?: boolean;
  /** gallery_paused: when unlocking reopens (ISO). */
  pausedUntil?: string;
  /** asset_in_use: how many live galleries' watermark uses the branding image. */
  galleries?: number;
}
export interface Accepted {
  ok: true;
}

// ---------------------------------------------------------------- app auth
export interface EmailStartBody {
  email: string;
  turnstileToken: string;
}
export interface EmailVerifyBody {
  email: string;
  /** 6 digits. */
  code: string;
  /**
   * App only. Turnstile token for the 'email_verify' action. The first attempt for an address may omit
   * it; every later attempt (in a 15-minute window, or after a new code) needs one, else 403
   * verification_failed. Send one whenever the widget has produced it; tokens are single-use.
   */
  turnstileToken?: string;
}
/** Turnstile action names, one per form (the server checks the token's action). */
export const TURNSTILE_ACTIONS = {
  inviteRequest: 'invite_request',
  emailStart: 'email_start',
  emailVerify: 'email_verify',
  inviteCode: 'invite_code',
  /** Guest gallery passcode (phase 5). */
  galleryUnlock: 'gallery_unlock',
  /** Guest abuse report (phase 5). */
  galleryReport: 'gallery_report',
} as const;
export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  plan: 'free' | 'pro' | 'studio';
  passkeyCount: number;
  createdAt: string;
  /** Set while the account is scheduled for deletion: the app shows the Restore screen. */
  pendingDeletion?: { purgeAt: string };
}
export interface SessionResponse {
  ok: true;
  user: SessionUser;
  /** True right after an invite is redeemed: the app shows "Sign in faster next time". */
  isNew?: boolean;
}
/** WebAuthn options as JSON (base64url), ready for @simplewebauthn/browser `optionsJSON`. */
export interface PasskeyOptions {
  challengeId: string;
  options: Record<string, unknown>;
}
export interface PasskeyVerifyBody {
  challengeId: string;
  /** JSON-serialised PublicKeyCredential (RegistrationResponseJSON / AuthenticationResponseJSON). */
  credential: Record<string, unknown>;
}
export interface Passkey {
  id: string;
  friendlyName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}
export interface ProfilePatchBody {
  displayName: string | null;
}

// ---------------------------------------------------------------- invites (app)
/** Invite links look like https://zephyrapp.midnightpoetry.studio/join#t=<token>; the fragment never reaches a server log. */
export const INVITE_LINK_PATH = '/join';
export interface InvitePreview {
  ok: true;
  email: string;
  inviterName: string | null;
  expiresAt: string;
}
export interface InviteRedeemBody {
  token: string;
  displayName?: string;
}
export interface InviteCodeBody {
  code: string;
  email: string;
  turnstileToken: string;
}
/** Members can't add a note (admin invites can): the email is Zephyr's wording only. */
export interface MemberInviteBody {
  email: string;
}
export type InviteStatus = 'pending' | 'accepted' | 'expired' | 'revoked';
export interface InviteRow {
  id: string;
  email: string;
  status: InviteStatus;
  source: 'admin' | 'member' | 'code' | 'request';
  invitedBy: string | null; // display label, e.g. "Jason L. · Owner", "Mei Lin", "Code WEDDING-EXPO"
  createdAt: string;
  expiresAt: string;
}
export interface MemberInvites {
  ok: true;
  enabled: boolean;
  perMonth: number;
  remaining: number;
  invites: InviteRow[];
}

// ---------------------------------------------------------------- admin
export type StaffRole = 'owner' | 'admin' | 'finance' | 'safety' | 'support';
export interface AdminSessionResponse {
  ok: true;
  staff: { id: string; email: string; role: StaffRole; displayName: string | null };
  /** Signed in with an email code and has no passkey yet: only passkey enrolment is allowed. */
  enrolOnly: boolean;
}
export interface SignupSettings {
  signupMode: 'open' | 'invite_only';
  acceptInviteRequests: boolean;
  signupsPaused: boolean;
  memberInvitesEnabled: boolean;
  memberInvitesPerMonth: number;
  inviteTtlDays: number;
}
export type SignupSettingsPatch = Partial<SignupSettings> & { reason?: string };
export interface InviteCodeRow {
  id: string;
  code: string;
  label: string | null;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
export interface InviteRequestRow {
  id: string;
  email: string;
  useCase: string | null;
  disposable: boolean;
  status: 'pending' | 'approved' | 'declined';
  createdAt: string;
}
export interface Page<T> {
  ok: true;
  items: T[];
  nextCursor: string | null;
}
export interface SignupsOverview {
  ok: true;
  settings: SignupSettings;
  pendingRequests: number;
  pendingInvites: number;
  codes: InviteCodeRow[];
}
export interface AdminInviteBody {
  /** Up to 50 addresses per call. */
  emails: string[];
  note?: string;
}
export interface AdminInviteResult {
  ok: true;
  sent: number;
  /** Addresses skipped because they already have an account or a pending invite (shown to staff only). */
  skipped: { email: string; reason: 'already_member' | 'already_invited' | 'invalid' | 'send_failed' }[];
}
export interface InviteCodeCreateBody {
  code: string;
  label?: string;
  maxUses: number;
  expiresAt?: string;
}
export interface DecideBody {
  ids: string[];
  decision: 'approve' | 'decline';
}
export interface DecideResult {
  ok: true;
  approved: number;
  declined: number;
}
