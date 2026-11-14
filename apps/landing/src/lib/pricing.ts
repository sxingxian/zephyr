import { BILLING_API, PRICE_BOUNDS, type PublicPricingResult } from '@zephyr/shared/client';

/** Same-origin: the landing Worker forwards /api/* to the API unchanged (worker/index.ts). */
export const PRICING_ENDPOINT = BILLING_API.pricing;

/** Integer cents → "$9.99", or "$99" for whole dollars (matches the build-time fallback). */
export function formatPrice(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString('en');
  const rest = cents % 100;
  return rest === 0 ? `$${whole}` : `$${whole}.${String(rest).padStart(2, '0')}`;
}

const okAmount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= PRICE_BOUNDS.min && n <= PRICE_BOUNDS.max;

/** Checks the response shape before touching the page; anything odd keeps the fallback prices. */
export function parsePricing(body: unknown): PublicPricingResult | null {
  const b = body as Partial<PublicPricingResult> | null;
  if (b?.ok !== true || !Array.isArray(b.prices) || !Array.isArray(b.packs)) return null;
  const prices = b.prices.filter(
    (p) =>
      (p?.plan === 'pro' || p?.plan === 'studio') &&
      (p.interval === 'month' || p.interval === 'year') &&
      okAmount(p.amount),
  );
  const packs = b.packs.filter(
    (p) =>
      typeof p?.lookupKey === 'string' && Number.isInteger(p.credits) && p.credits > 0 && okAmount(p.amount),
  );
  return { ok: true, prices, packs };
}

/**
 * Label for the yearly toggle. "N months free" is only claimed when every paid plan's yearly price is at
 * most (12 − N) × its monthly price; otherwise just "Yearly".
 */
export function yearlyLabel(prices: PublicPricingResult['prices']): string {
  const plans = new Set(prices.map((p) => p.plan));
  let months = Number.POSITIVE_INFINITY;
  for (const plan of plans) {
    const m = prices.find((p) => p.plan === plan && p.interval === 'month')?.amount;
    const y = prices.find((p) => p.plan === plan && p.interval === 'year')?.amount;
    if (!m || !y) return 'Yearly';
    months = Math.min(months, Math.floor((12 * m - y) / m));
  }
  if (!Number.isFinite(months) || months < 1) return 'Yearly';
  return `Yearly · ${months} month${months === 1 ? '' : 's'} free`;
}

/** The smallest pack on sale, for the top-up note. */
export function smallestPack(packs: PublicPricingResult['packs']) {
  return [...packs].sort((a, b) => a.credits - b.credits)[0] ?? null;
}
