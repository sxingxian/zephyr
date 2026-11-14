import { describe, expect, it } from 'vitest';
import {
  adminPriceSchema,
  checkoutSchema,
  checkoutSessionIdSchema,
  planChangeSchema,
  teamInviteSchema,
  teamInviteTokenSchema,
  teamNamePatchSchema,
} from './billing-schemas';
import { isSafeLabel, LOOKUP_KEYS, normalizeLabel, roleCan } from './billing-types';

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

describe('safe labels', () => {
  it('agrees with the SQL rule on the shared list (supabase/tests/safe_label_cases.txt)', async () => {
    const { default: text } = await import('../../../supabase/tests/safe_label_cases.txt?raw');
    const cases = text
      .split('\n')
      .map((l) => /^(ok|link|policy)\|(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ kind: m[1], name: m[2] as string }));
    expect(cases.filter((c) => c.kind === 'ok').length).toBeGreaterThanOrEqual(10);
    expect(cases.filter((c) => c.kind === 'link').length).toBeGreaterThanOrEqual(10);
    // The full policy: only `ok` names pass; links and characters outside the policy are refused.
    for (const c of cases) expect([c.name, isSafeLabel(c.name)]).toEqual([c.name, c.kind === 'ok']);
  });
  it('refuses digits other than 0-9 and allows letters’ combining marks', () => {
    expect(isSafeLabel('Studio ٣')).toBe(false);
    expect(isSafeLabel('Studio ३')).toBe(false);
    // Combining marks (Devanagari, after NFKC) are letters' parts, not punctuation.
    expect(isSafeLabel('फ़ोटो स्टूडियो')).toBe(true);
  });
  it('stores the NFKC form', () => {
    const r = teamNamePatchSchema.parse({ name: 'Studio Ⅻ' });
    expect(r.name).toBe('Studio XII');
    expect(teamNamePatchSchema.safeParse({ name: 'evil.ⅽⅽ' }).success).toBe(false);
    expect(normalizeLabel('ｍｅｉ＠x')).toBe('mei@x');
  });
});
