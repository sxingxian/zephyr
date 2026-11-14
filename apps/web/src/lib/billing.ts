import {
  BILLING_API,
  type BillingInterval,
  type BillingStatusResult,
  type CheckoutBody,
  type CheckoutStatusResult,
  type LibrariesResult,
  type PaidPlanId,
  PLANS,
  type PlanChangeBody,
  type PlanChangePreviewResult,
  type PlanChangeResult,
  type PublicPricingResult,
  TEAM_API,
  type TeamInviteBody,
  type TeamInvitePreviewResult,
  type TeamMemberPatch,
  type TeamResult,
  TOPUP_PACKS,
  type TopUpLookupKey,
} from '@zephyr/shared/client';
import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { expectedUser } from './library';

/**
 * Phase 7 client: billing (personal: always the signed-in member's own plan) and the owner's team. Writes name
 * the member this tab believes is signed in (409 session_changed otherwise).
 */
const write = <T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) =>
  api<T>(path, { method, body: method === 'DELETE' ? undefined : (body ?? {}), headers: expectedUser() });

// ---------------------------------------------------------------- billing
export const fetchBilling = (signal?: AbortSignal) =>
  api<BillingStatusResult>(BILLING_API.status, { signal });
export const startCheckout = (body: CheckoutBody) =>
  write<{ ok: true; url: string }>(BILLING_API.checkout, 'POST', body);
export const checkoutStatus = (sessionId: string, signal?: AbortSignal) =>
  api<CheckoutStatusResult>(BILLING_API.checkoutStatus(sessionId), { signal });
export const openPortal = () => write<{ ok: true; url: string }>(BILLING_API.portal, 'POST', {});
export const previewChange = (body: PlanChangeBody) =>
  write<PlanChangePreviewResult>(BILLING_API.changePreview, 'POST', body);
export const changePlan = (body: PlanChangeBody) => write<PlanChangeResult>(BILLING_API.change, 'POST', body);
export const undoScheduledChange = () => write<BillingStatusResult>(BILLING_API.change, 'DELETE');

/**
 * Leaves the app for a Stripe page. Only Stripe's own hosts are followed, so a tampered response can never
 * send the member somewhere else.
 */
const STRIPE_HOSTS = ['checkout.stripe.com', 'billing.stripe.com', 'invoice.stripe.com', 'pay.stripe.com'];
export function isStripeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && STRIPE_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}
export const leave = {
  to(url: string): void {
    if (!isStripeUrl(url)) throw new Error('unexpected redirect');
    window.location.assign(url);
  },
};

// ---------------------------------------------------------------- public prices (shared store)
export interface Prices {
  plans: Record<PaidPlanId, Record<BillingInterval, number>>;
  packs: { lookupKey: TopUpLookupKey; credits: number; amount: number }[];
  /** False while showing the build-time fallback. */
  live: boolean;
}
const cents = (s: string | null) => {
  const n = Number(String(s ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
function fallbackPrices(): Prices {
  const by = (id: PaidPlanId) => PLANS.find((p) => p.id === id);
  const pro = by('pro');
  const studio = by('studio');
  return {
    plans: {
      pro: { month: cents(pro?.priceMonthly ?? null), year: cents(pro?.priceYearly ?? null) },
      studio: { month: cents(studio?.priceMonthly ?? null), year: cents(studio?.priceYearly ?? null) },
    },
    // Only the 500 pack is known without the server; the others appear once live prices arrive.
    packs: [{ lookupKey: TOPUP_PACKS[0].lookupKey, credits: TOPUP_PACKS[0].credits, amount: 500 }],
    live: false,
  };
}
export function pricesFrom(r: PublicPricingResult): Prices {
  const p = fallbackPrices();
  for (const x of r.prices ?? []) {
    if ((x.plan === 'pro' || x.plan === 'studio') && (x.interval === 'month' || x.interval === 'year'))
      p.plans[x.plan][x.interval] = x.amount;
  }
  return { plans: p.plans, packs: Array.isArray(r.packs) ? r.packs : p.packs, live: true };
}

let prices: Prices = fallbackPrices();
let pricesLoaded = false;
let pricesInflight: Promise<void> | null = null;
const priceSubs = new Set<() => void>();
export function refreshPrices(): Promise<void> {
  pricesInflight ??= api<PublicPricingResult>(BILLING_API.pricing, { quiet401: true })
    .then((r) => {
      prices = pricesFrom(r);
      pricesLoaded = true;
      for (const s of priceSubs) s();
    })
    .catch(() => {
      // Keep the fallback.
    })
    .finally(() => {
      pricesInflight = null;
    });
  return pricesInflight;
}
export function usePrices(): Prices {
  const v = useSyncExternalStore(
    (cb) => {
      priceSubs.add(cb);
      return () => priceSubs.delete(cb);
    },
    () => prices,
    () => prices,
  );
  useEffect(() => {
    if (!pricesLoaded) void refreshPrices();
  }, []);
  return v;
}
/** Test helper. */
export function resetPrices(): void {
  prices = fallbackPrices();
  pricesLoaded = false;
}

// ---------------------------------------------------------------- team (owner's own library)
export const fetchTeam = (signal?: AbortSignal) => api<TeamResult>(TEAM_API.team, { signal });
export const renameTeam = (name: string) => write<TeamResult>(TEAM_API.team, 'PATCH', { name });
export const inviteTeammate = (body: TeamInviteBody) => write<TeamResult>(TEAM_API.invites, 'POST', body);
export const revokeTeamInvite = (id: string) => write<TeamResult>(TEAM_API.invite(id), 'DELETE');
export const resendTeamInvite = (id: string) => write<TeamResult>(TEAM_API.invite(id), 'POST', {});
export const setTeammateRole = (memberId: string, body: TeamMemberPatch) =>
  write<TeamResult>(TEAM_API.member(memberId), 'PATCH', body);
export const removeTeammate = (memberId: string) => write<TeamResult>(TEAM_API.member(memberId), 'DELETE');
export const previewTeamInvite = (token: string) =>
  api<TeamInvitePreviewResult>(TEAM_API.invitePreview, { body: { token }, quiet401: true });
export const acceptTeamInvite = (token: string) =>
  write<LibrariesResult>(TEAM_API.inviteAccept, 'POST', { token });
export const leaveTeam = (ownerId: string) => write<LibrariesResult>(TEAM_API.leave(ownerId), 'DELETE');

// ---------------------------------------------------------------- formatting
/** "US$9.99", "US$99" (whole dollars without cents). */
export function usd(amountCents: number, opts: { plain?: boolean } = {}): string {
  const v = amountCents / 100;
  const s = Number.isInteger(v)
    ? v.toLocaleString('en')
    : v.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const neg = amountCents < 0;
  const abs = neg ? s.slice(1) : s;
  return `${neg ? '−' : ''}${opts.plain ? '$' : 'US$'}${abs}`;
}
/** "14 Dec 2026". */
export function longDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export const PLAN_NAME = { free: 'Free', pro: 'Pro', studio: 'Studio' } as const;
