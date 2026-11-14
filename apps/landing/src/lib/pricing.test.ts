import { describe, expect, it } from 'vitest';
import { formatPrice, PRICING_ENDPOINT, parsePricing, smallestPack, yearlyLabel } from './pricing';

const P = (plan: 'pro' | 'studio', interval: 'month' | 'year', amount: number) => ({
  plan,
  interval,
  amount,
});

describe('live pricing', () => {
  it('calls the same-origin endpoint the landing Worker forwards', () => {
    expect(PRICING_ENDPOINT).toBe('/api/v1/public/pricing');
  });
  it('formats cents like the build-time fallback', () => {
    expect(formatPrice(999)).toBe('$9.99');
    expect(formatPrice(9900)).toBe('$99');
    expect(formatPrice(1050)).toBe('$10.50');
    expect(formatPrice(100000)).toBe('$1,000');
  });
  it('drops anything malformed or out of bounds', () => {
    expect(parsePricing(null)).toBeNull();
    expect(parsePricing({ ok: false })).toBeNull();
    const r = parsePricing({
      ok: true,
      prices: [
        P('pro', 'month', 999),
        P('pro', 'month', 9.5),
        { plan: 'free', interval: 'month', amount: 500 },
        P('studio', 'year', 10_000_000),
      ],
      packs: [
        { lookupKey: 'zephyr_topup_500', credits: 500, amount: 500 },
        { lookupKey: 'x', credits: -1, amount: 500 },
      ],
    });
    expect(r?.prices).toEqual([P('pro', 'month', 999)]);
    expect(r?.packs).toHaveLength(1);
  });
  it('claims months free only when every plan earns it', () => {
    expect(
      yearlyLabel([
        P('pro', 'month', 999),
        P('pro', 'year', 9900),
        P('studio', 'month', 2499),
        P('studio', 'year', 24900),
      ]),
    ).toBe('Yearly · 2 months free');
    expect(yearlyLabel([P('pro', 'month', 1199), P('pro', 'year', 9900)])).toBe('Yearly · 3 months free');
    expect(yearlyLabel([P('pro', 'month', 999), P('pro', 'year', 10800)])).toBe('Yearly · 1 month free');
    expect(yearlyLabel([P('pro', 'month', 999), P('pro', 'year', 11988)])).toBe('Yearly');
    expect(yearlyLabel([P('pro', 'month', 999)])).toBe('Yearly');
  });
  it('picks the smallest pack on sale', () => {
    expect(
      smallestPack([
        { lookupKey: 'zephyr_topup_1000', credits: 1000, amount: 1000 },
        { lookupKey: 'zephyr_topup_500', credits: 500, amount: 500 },
      ])?.credits,
    ).toBe(500);
    expect(smallestPack([])).toBeNull();
  });
});
