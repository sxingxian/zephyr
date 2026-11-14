import { describe, expect, it } from 'vitest';
import {
  adminPriceSchema,
  checkoutSchema,
  checkoutSessionIdSchema,
  planChangeSchema,
  teamInviteSchema,
  teamInviteTokenSchema,
} from './billing-schemas';
import { LOOKUP_KEYS, roleCan } from './billing-types';

describe('billing schemas', () => {
  it('accepts subscription and top-up checkouts only with known values', () => {
    expect(checkoutSchema.safeParse({ kind: 'subscription', plan: 'pro', interval: 'year' }).success).toBe(
      true,
    );
    expect(checkoutSchema.safeParse({ kind: 'topup', pack: 'zephyr_topup_500' }).success).toBe(true);
    expect(checkoutSchema.safeParse({ kind: 'subscription', plan: 'free', interval: 'month' }).success).toBe(
      false,
    );
    expect(checkoutSchema.safeParse({ kind: 'topup', pack: 'zephyr_topup_9' }).success).toBe(false);
    expect(
      checkoutSchema.safeParse({ kind: 'topup', pack: 'zephyr_topup_500', price: 'price_x' }).success,
    ).toBe(false);
  });
  it('validates plan changes and session ids', () => {
    expect(planChangeSchema.safeParse({ plan: 'studio', interval: 'month' }).success).toBe(true);
    expect(planChangeSchema.safeParse({ plan: 'studio' }).success).toBe(false);
    expect(checkoutSessionIdSchema.safeParse('cs_test_a1B2c3D4e5F6g7').success).toBe(true);
    expect(checkoutSessionIdSchema.safeParse('cs_test_../x').success).toBe(false);
  });
  it('normalises invite emails and checks tokens', () => {
    const r = teamInviteSchema.parse({ email: '  Jun@Example.COM ', role: 'editor' });
    expect(r.email).toBe('jun@example.com');
    expect(teamInviteSchema.safeParse({ email: 'x@y.z', role: 'owner' }).success).toBe(false);
    expect(teamInviteTokenSchema.safeParse({ token: 'a'.repeat(43) }).success).toBe(true);
    expect(teamInviteTokenSchema.safeParse({ token: 'a'.repeat(42) }).success).toBe(false);
  });
  it('bounds admin prices', () => {
    expect(
      adminPriceSchema.safeParse({ lookupKey: 'zephyr_pro_monthly', amount: 1099, reason: 'Costs' }).success,
    ).toBe(true);
    expect(
      adminPriceSchema.safeParse({ lookupKey: 'zephyr_pro_monthly', amount: 99, reason: 'x' }).success,
    ).toBe(false);
    expect(adminPriceSchema.safeParse({ lookupKey: 'other', amount: 1099, reason: 'x' }).success).toBe(false);
    expect(LOOKUP_KEYS).toHaveLength(7);
  });
});

describe('roles', () => {
  it('matches the agreed role table', () => {
    expect(roleCan('viewer', 'download')).toBe(true);
    expect(roleCan('viewer', 'upload')).toBe(false);
    expect(roleCan('editor', 'ai')).toBe(true);
    expect(roleCan('editor', 'trash')).toBe(true);
    expect(roleCan('editor', 'purge')).toBe(false);
    expect(roleCan('editor', 'aiSettings')).toBe(false);
    expect(roleCan('owner', 'billing')).toBe(true);
  });
});
