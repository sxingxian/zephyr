import { describe, expect, it } from 'vitest';
import { inviteRequestSchema } from './invites';

describe('inviteRequestSchema', () => {
  it('normalises the email', () => {
    const r = inviteRequestSchema.parse({ email: '  Aisha.R@Example.com ', turnstileToken: 't' });
    expect(r.email).toBe('aisha.r@example.com');
  });
  it('rejects a bad email, an unknown use case and a missing token', () => {
    expect(inviteRequestSchema.safeParse({ email: 'nope', turnstileToken: 't' }).success).toBe(false);
    expect(
      inviteRequestSchema.safeParse({ email: 'a@b.co', useCase: 'x', turnstileToken: 't' }).success,
    ).toBe(false);
    expect(inviteRequestSchema.safeParse({ email: 'a@b.co' }).success).toBe(false);
  });
  it('rejects unknown fields silently by stripping them', () => {
    const r = inviteRequestSchema.parse({ email: 'a@b.co', turnstileToken: 't', isAdmin: true });
    expect('isAdmin' in r).toBe(false);
  });
  it('rejects an over-long email', () => {
    const long = `${'a'.repeat(250)}@b.co`;
    expect(inviteRequestSchema.safeParse({ email: long, turnstileToken: 't' }).success).toBe(false);
  });
});
