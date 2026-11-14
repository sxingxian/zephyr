import {
  type AdminPriceChange,
  type AdminPriceRow,
  type AdminSessionResponse,
  PRICE_BOUNDS,
} from '@zephyr/shared/client';

type Role = AdminSessionResponse['staff']['role'] | undefined;
/** Who sees Admin › Plans & billing (the API enforces the same). */
export const canSeeBilling = (role: Role) => role === 'owner' || role === 'admin' || role === 'finance';
/** Who can change prices and packs. */
export const canEditBilling = (role: Role) => role === 'owner' || role === 'finance';

/**
 * Parses a dollar amount typed by an admin ("10.99", "$10", "1,000.5") into integer cents without floating
 * point: the whole and fractional parts are read as digits. Returns null for anything else.
 */
export function dollarsToCents(input: string): number | null {
  const s = input
    .trim()
    .replace(/^(US)?\$/i, '')
    .replace(/,/g, '');
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  return whole * 100 + frac;
}

export function priceError(cents: number | null): string | null {
  if (cents === null) return 'Enter an amount like 10.99.';
  if (cents < PRICE_BOUNDS.min || cents > PRICE_BOUNDS.max)
    return `Between ${formatCents(PRICE_BOUNDS.min)} and ${formatCents(PRICE_BOUNDS.max)}.`;
  return null;
}

/** Integer cents → "US$1,234.50" (no floating point). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  const a = Math.abs(Math.round(cents));
  const whole = Math.floor(a / 100).toLocaleString('en-GB');
  return `${sign}US$${whole}.${String(a % 100).padStart(2, '0')}`;
}
/** Integer cents → "10.99" for an input. */
export const centsToInput = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

const PLAN_NAME = { pro: 'Pro', studio: 'Studio' } as const;
export function priceName(r: Pick<AdminPriceRow, 'plan' | 'interval' | 'credits'>): string {
  if (r.plan) return `${PLAN_NAME[r.plan]} ${r.interval === 'year' ? 'yearly' : 'monthly'}`;
  return `${(r.credits ?? 0).toLocaleString('en-GB')} top-up credits`;
}
export function priceKind(r: Pick<AdminPriceRow, 'plan'>): string {
  return r.plan ? PLAN_NAME[r.plan] : 'Top-up';
}
export function billedLabel(r: Pick<AdminPriceRow, 'interval' | 'credits'>): string {
  if (r.interval === 'year') return 'Yearly';
  if (r.interval === 'month') return 'Monthly';
  return `${(r.credits ?? 0).toLocaleString('en-GB')} credits, once`;
}

/** Changes still in progress (subscribers can still be stopped). */
export const isOpenChange = (c: AdminPriceChange) => c.status === 'notifying' || c.status === 'moving';
/** A stopped change with moves still being put back, or ones the renewal reached first: shown until resolved. */
export const needsAttention = (c: AdminPriceChange) =>
  c.status === 'stopped' && (c.counts.reverting > 0 || c.counts.revertFailed > 0);

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
