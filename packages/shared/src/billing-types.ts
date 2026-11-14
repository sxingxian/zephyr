/**
 * Phase 7 contract: billing (Stripe, Managed Payments) and Studio team libraries. Types and constants only,
 * so browser bundles can import them. Request schemas live in ./billing-schemas.ts (zod, API only).
 * Design: docs/phase-7.md.
 */
import type { PlanId } from './plans';

// ================================================================ routes
export const BILLING_API = {
  /** GET → BillingStatusResult. Personal: always the signed-in member's own plan, whatever library is open. */
  status: '/api/v1/billing',
  /** POST CheckoutBody → 201 { ok, url } (Stripe Checkout). 409 conflict when a subscription already exists. */
  checkout: '/api/v1/billing/checkout',
  /** GET → CheckoutStatusResult. The return page polls this until the webhook has been processed. */
  checkoutStatus: (sessionId: string) => `/api/v1/billing/checkout/${encodeURIComponent(sessionId)}`,
  /** POST {} → 201 { ok, url } (Stripe customer portal: payment method, invoices, address, cancel or resume). */
  portal: '/api/v1/billing/portal',
  /** POST PlanChangeBody → PlanChangePreviewResult (amount due now for an upgrade; the date for a downgrade). */
  changePreview: '/api/v1/billing/change/preview',
  /** POST PlanChangeBody → PlanChangeResult · DELETE → BillingStatusResult (undo a scheduled downgrade). */
  change: '/api/v1/billing/change',
  /** GET → PublicPricingResult (no session; cached 5 minutes). The landing page and the Plans screen read it. */
  pricing: '/api/v1/public/pricing',
  /** POST raw Stripe event (Stripe-Signature) → 200. No session, no Origin check, no JSON content-type rule. */
  webhook: '/api/v1/stripe/webhook',
} as const;

export const TEAM_API = {
  /** GET → LibrariesResult: the member's own library plus every team library they belong to. */
  libraries: '/api/v1/libraries',
  /** Owner's team (own library only). GET → TeamResult */
  team: '/api/v1/team',
  /** POST TeamInviteBody → 201 TeamResult. 403 plan_required (not Studio) · 409 limit_reached (no free seat) · 409 already_member */
  invites: '/api/v1/team/invites',
  /** DELETE → TeamResult (revoke a pending invite) · POST {} (resend) → TeamResult */
  invite: (id: string) => `/api/v1/team/invites/${encodeURIComponent(id)}`,
  /** PATCH TeamMemberPatch → TeamResult · DELETE → TeamResult (remove; their access ends at once) */
  member: (memberId: string) => `/api/v1/team/members/${encodeURIComponent(memberId)}`,
  /** POST { token } → TeamInvitePreviewResult (no session needed; never says why an invite is unusable) */
  invitePreview: '/api/v1/team/invite/preview',
  /** POST { token } → LibrariesResult (signed in with the invited email) · 404 invite_invalid */
  inviteAccept: '/api/v1/team/invite/accept',
  /** DELETE → LibrariesResult (a teammate leaves a team library) */
  leave: (ownerId: string) => `/api/v1/libraries/${encodeURIComponent(ownerId)}`,
} as const;

export const ADMIN_BILLING_API = {
  /** GET → AdminBillingResult (KPIs, prices, price changes, payment due, recent webhook events) */
  overview: '/admin/api/v1/billing',
  /** POST AdminPriceBody → AdminBillingResult (new Stripe Price, lookup key moved; 403 reauth_required) */
  prices: '/admin/api/v1/billing/prices',
  /** POST AdminPricePreviewBody → AdminPricePreviewResult (who moves, and when) */
  pricePreview: '/admin/api/v1/billing/prices/preview',
  /** PATCH AdminPackPatch → AdminBillingResult (turn a top-up pack on or off; turning off is risk-lowering) */
  pack: (lookupKey: string) => `/admin/api/v1/billing/packs/${encodeURIComponent(lookupKey)}`,
  /** DELETE → AdminBillingResult (stop a price change: subscribers not yet moved stay on the old price) */
  priceChange: (id: string) => `/admin/api/v1/billing/price-changes/${encodeURIComponent(id)}`,
} as const;

// ================================================================ library context (teams)
/**
 * Every library-scoped request (photos, uploads, albums, edits, recipes, trash, galleries, branding, AI) may
 * carry this header naming the library owner's user id. Absent, or equal to the member's own id, means their
 * own library. The API checks membership on every request; a stale or removed membership gets
 * 403 `library_unavailable` and the app switches back to the member's own library.
 */
export const LIBRARY_HEADER = 'X-Zephyr-Library';
export const LIBRARY_ROLES = ['owner', 'editor', 'viewer'] as const;
export type LibraryRole = (typeof LIBRARY_ROLES)[number];
/** Roles an owner can give a teammate. */
export const TEAM_ROLES = ['editor', 'viewer'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** What each role may do (the API enforces it; the app hides what's not allowed). */
export const ROLE_CAN = {
  view: ['owner', 'editor', 'viewer'],
  download: ['owner', 'editor', 'viewer'],
  upload: ['owner', 'editor'],
  edit: ['owner', 'editor'],
  ai: ['owner', 'editor'],
  galleries: ['owner', 'editor'],
  trash: ['owner', 'editor'],
  /** Delete forever, empty Trash. */
  purge: ['owner'],
  /** Face grouping on/off, scene tags, cleanup (AiMemberSettingsPatch). */
  aiSettings: ['owner'],
  team: ['owner'],
  billing: ['owner'],
} as const satisfies Record<string, readonly LibraryRole[]>;
export type LibraryAction = keyof typeof ROLE_CAN;
export const roleCan = (role: LibraryRole, action: LibraryAction): boolean =>
  (ROLE_CAN[action] as readonly LibraryRole[]).includes(role);

export type LibraryState =
  /** Normal. */
  | 'active'
  /** Over the plan's storage (after a lapse or downgrade): view, download, Trash and delete only. */
  | 'read_only';

export interface LibrarySummary {
  ownerId: string;
  /** "Tan Studio" for a team library (the owner's team name), or the member's own name for their own. */
  name: string;
  role: LibraryRole;
  /** The library owner's display name ("Mei Lin"), for "managed by" copy. */
  ownerName: string;
  /** The owner's plan (a team library is always Studio while it's usable). */
  plan: PlanId;
  state: LibraryState;
  /** Initials for the switcher avatar. */
  initials: string;
}
export interface LibrariesResult {
  ok: true;
  /** The member's own library first, then team libraries by name. */
  libraries: LibrarySummary[];
}
/** A member can belong to at most this many team libraries. */
export const MAX_TEAM_LIBRARIES = 10;

// ---------------------------------------------------------------- team (owner's view)
export const TEAM_NAME_MAX = 60;
/**
 * Names that go into emails sent to any address (team names, inviter names): checked after NFKC normalisation,
 * so lookalikes (fullwidth "@", Roman-numeral letters, ideographic dots) are judged as what they become.
 * The full character policy, enforced by the API: letters (with their combining marks, for scripts such as Thai
 * or Devanagari), the digits 0-9, spaces and . , ' & - only; a dot may only be followed by a space, one of those
 * marks or the end, so nothing reads as a domain. public._safe_label in SQL is the security floor beneath it
 * (NFKC, no control characters, nothing address- or link-like) and accepts every name this accepts; stored names
 * are already NFKC (`normalizeLabel`). supabase/tests/safe_label_cases.txt is checked against both.
 */
export const SAFE_LABEL = /^[\p{L}\p{M}0-9 .,'&-]{1,60}$/u;
const LINK_LIKE = /(www\.|:\/\/|\.[^\s.,'&-])/iu;
export const normalizeLabel = (s: string): string => s.normalize('NFKC');
export const isSafeLabel = (s: string): boolean => {
  const n = normalizeLabel(s);
  return SAFE_LABEL.test(n) && !LINK_LIKE.test(n);
};
export const TEAM_INVITE_DAYS = 7;
export interface TeamMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: LibraryRole;
  addedAt: string;
  /** Beyond the plan's seats (Admin lowered seats, or the plan changed): no access until someone is removed. */
  suspended: boolean;
  /**
   * Live gallery links this member could have opened (they have had Editor access here); 0 otherwise. Removing
   * them doesn't change those links, so the Team page warns and points to Shared galleries.
   */
  liveGalleries: number;
}
export interface TeamInvite {
  id: string;
  email: string;
  role: TeamRole;
  createdAt: string;
  expiresAt: string;
}
export interface Team {
  name: string;
  /** Plan seats, owner included (Studio: 3). */
  seats: number;
  /** Owner + members + pending invites. */
  used: number;
  /** The owner first. */
  members: TeamMember[];
  invites: TeamInvite[];
  /** False when the plan has 1 seat: the Team page shows the Studio upsell. */
  available: boolean;
}
export interface TeamResult {
  ok: true;
  team: Team;
}
export interface TeamInviteBody {
  email: string;
  role: TeamRole;
}
export interface TeamMemberPatch {
  role: TeamRole;
}
export interface TeamNamePatch {
  name: string;
}
export interface TeamInvitePreview {
  teamName: string;
  ownerName: string;
  role: TeamRole;
  /** The invited address, masked (m•••@example.com), so the right account signs in. */
  emailHint: string;
  /** True when that address has no Zephyr account yet: the page offers sign-up (allowed even when sign-ups are invite-only). */
  needsAccount: boolean;
}
export interface TeamInvitePreviewResult {
  ok: true;
  invite: TeamInvitePreview;
}

// ================================================================ billing (member)
export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];
export type PaidPlanId = Exclude<PlanId, 'free'>;
export const PAID_PLANS: readonly PaidPlanId[] = ['pro', 'studio'];

/** Stripe lookup keys. A new price in Admin creates a new Stripe Price and moves the key to it. */
export const SUBSCRIPTION_LOOKUP_KEYS = {
  pro: { month: 'zephyr_pro_monthly', year: 'zephyr_pro_yearly' },
  studio: { month: 'zephyr_studio_monthly', year: 'zephyr_studio_yearly' },
} as const satisfies Record<PaidPlanId, Record<BillingInterval, string>>;
export const TOPUP_PACKS = [
  { lookupKey: 'zephyr_topup_500', credits: 500 },
  { lookupKey: 'zephyr_topup_1000', credits: 1000 },
  { lookupKey: 'zephyr_topup_2500', credits: 2500 },
] as const;
export type TopUpLookupKey = (typeof TOPUP_PACKS)[number]['lookupKey'];
export const LOOKUP_KEYS = [
  ...Object.values(SUBSCRIPTION_LOOKUP_KEYS).flatMap((p) => [p.month, p.year]),
  ...TOPUP_PACKS.map((p) => p.lookupKey),
] as readonly string[];
/** Top-up credits last this long and are spent after the month's credits. */
export const TOPUP_VALID_MONTHS = 12;
/** Existing subscribers move to a new price at their first renewal at least this many days after the notice. */
export const PRICE_NOTICE_DAYS = 30;
/** All amounts are US dollars in cents. Stripe's Adaptive Pricing shows local currency at Checkout. */
export const BILLING_CURRENCY = 'usd';
/** Admin price bounds (cents), a guard against typos. */
export const PRICE_BOUNDS = { min: 100, max: 100_000 } as const;

/** Mirrors Stripe's subscription status. */
export type SubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused';
/** Statuses that keep the paid plan. past_due keeps it while Stripe retries the card. */
export const PLAN_KEEPING_STATUSES: readonly SubscriptionStatus[] = ['active', 'trialing', 'past_due'];

export interface Money {
  /** Cents. */
  amount: number;
  currency: string;
}
export interface PriceInfo {
  lookupKey: string;
  amount: number; // cents, USD
  interval: BillingInterval | null; // null for top-up packs
}
export interface BillingSubscription {
  plan: PaidPlanId;
  interval: BillingInterval;
  status: SubscriptionStatus;
  price: PriceInfo;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  /** A downgrade or switch to monthly, taking effect at `at` (the period end). */
  scheduledChange: { plan: PaidPlanId; interval: BillingInterval; at: string } | null;
  /** An announced price change: moves at `at` (a renewal date). */
  priceChange: { amount: number; at: string } | null;
  /** past_due: when Stripe gives up retrying (best estimate), after which the plan ends. */
  paymentDueSince: string | null;
}
export interface BillingStatus {
  /** The effective plan. */
  plan: PlanId;
  subscription: BillingSubscription | null;
  state: LibraryState;
  /** Storage used vs. the plan's storage, for the read-only banner. */
  storage: { usedBytes: number; limitBytes: number };
  /** Top-up packs on sale now. */
  packs: { lookupKey: TopUpLookupKey; credits: number; amount: number }[];
  /** False until a Stripe customer exists: the portal button is hidden. */
  hasCustomer: boolean;
}
export interface BillingStatusResult extends BillingStatus {
  ok: true;
}

export type CheckoutBody =
  | { kind: 'subscription'; plan: PaidPlanId; interval: BillingInterval }
  | { kind: 'topup'; pack: TopUpLookupKey };
export interface CheckoutStatusResult {
  ok: true;
  /**
   * pending: Stripe hasn't confirmed yet (keep polling, ≤ 60 s) · done: applied · failed: payment not completed ·
   * refunded: a second plan bought while one was already live (e.g. two tabs): canceled and refunded in full.
   */
  state: 'pending' | 'done' | 'failed' | 'refunded';
  kind: 'subscription' | 'topup';
  plan?: PlanId;
  credits?: number;
}

export interface PlanChangeBody {
  plan: PaidPlanId;
  interval: BillingInterval;
}
export type PlanChangeKind =
  /** Higher plan, or monthly → yearly: now, prorated, charged at once. */
  | 'upgrade'
  /** Lower plan, or yearly → monthly: at the period end, nothing charged now. */
  | 'downgrade';
export interface PlanChangePreview {
  kind: PlanChangeKind;
  /** upgrade: invoice lines (prorations) and the total due now. */
  lines: { description: string; amount: number }[];
  dueNow: Money | null;
  /** downgrade: when it takes effect. */
  effectiveAt: string;
  /** What changes: storage and seats before/after, and features lost. */
  effects: {
    storageGb: { from: number; to: number };
    seats: { from: number; to: number };
    lost: string[];
    /** Teammates who lose access (downgrade from Studio). */
    teammatesLosingAccess: number;
    /** The library will be over the new plan's storage: uploads pause. */
    overStorage: boolean;
  };
}
export interface PlanChangePreviewResult extends PlanChangePreview {
  ok: true;
}

export interface PlanChangeResult extends BillingStatusResult {
  /**
   * Upgrade only: the card needs confirming (3-D Secure) or was declined. The change applies only once the
   * invoice is paid (payment_behavior pending_if_incomplete); the app opens this Stripe-hosted invoice page.
   */
  actionUrl: string | null;
}

export interface PublicPrice {
  plan: PaidPlanId;
  interval: BillingInterval;
  amount: number;
}
export interface PublicPricingResult {
  ok: true;
  prices: PublicPrice[];
  packs: { lookupKey: TopUpLookupKey; credits: number; amount: number }[];
}

// ---------------------------------------------------------------- credits (extends phase 6 CreditBalance)
export interface TopUpBucket {
  credits: number; // remaining
  expiresAt: string;
}

// ================================================================ admin
export interface AdminPriceRow {
  lookupKey: string;
  plan: PaidPlanId | null;
  interval: BillingInterval | null;
  credits: number | null; // packs
  amount: number;
  active: boolean; // packs can be turned off; subscription prices are always on sale
  subscribers: number; // subscription prices: subscriptions on any older price of this key are counted in priceChange
  updatedAt: string;
}
export type PriceChangeStatus = 'notifying' | 'moving' | 'done' | 'stopped';
export interface AdminPriceChange {
  id: string;
  lookupKey: string;
  from: number;
  to: number;
  status: PriceChangeStatus;
  createdAt: string;
  createdBy: string;
  reason: string;
  counts: {
    pending: number;
    /** Notice sent (includes moves the cron is swapping right now). */
    notified: number;
    moved: number;
    skipped: number;
    /** Stopped after they were applied: waiting to be put back on the old price (the daily cron retries). */
    reverting: number;
    /** Stopped, but the renewal came before the revert succeeded: billed at the new price. Needs a person. */
    revertFailed: number;
  };
  /** The last move date across subscribers. */
  lastMoveAt: string | null;
}
export interface AdminPaymentDue {
  ownerId: string;
  email: string;
  plan: PaidPlanId;
  amount: number;
  since: string;
  attempts: number;
}
export interface AdminWebhookEvent {
  id: string; // evt_…
  type: string;
  at: string;
  status: 'processed' | 'ignored' | 'failed';
  error: string | null;
}
export interface AdminBillingResult {
  ok: true;
  kpis: {
    mrr: number; // cents, yearly counted /12
    paying: number;
    pastDue: number;
    cancelling: number;
    topUpCreditsSold30d: number;
  };
  prices: AdminPriceRow[];
  changes: AdminPriceChange[];
  paymentDue: AdminPaymentDue[];
  events: AdminWebhookEvent[];
  /** False until STRIPE_SECRET_KEY is set: the page shows setup steps and no buttons. */
  configured: boolean;
}
export interface AdminPriceBody {
  lookupKey: string;
  amount: number;
  /** Shown in the audit log and the Owners' email. */
  reason: string;
}
export interface AdminPricePreviewBody {
  lookupKey: string;
  amount: number;
}
export interface AdminPricePreviewResult {
  ok: true;
  from: number;
  to: number;
  /** New sign-ups pay the new price at once. */
  subscribers: number;
  /** Earliest and latest move dates (first renewal ≥ PRICE_NOTICE_DAYS after the notice). */
  firstMoveAt: string | null;
  lastMoveAt: string | null;
  /** True for a rise: needs a passkey sign-in in the last 10 minutes and emails every Owner. */
  raise: boolean;
}
export interface AdminPackPatch {
  active: boolean;
}
export const PRICE_REASON_MAX = 300;
