import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, initKeys, installFetch, jar, must, read, resetWorld, world } from './helpers';

beforeAll(initKeys);
beforeEach(() => {
  resetWorld();
  installFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TOKEN = 'A'.repeat(43);
const live = {
  id: '30000000-0000-0000-0000-000000000001',
  email: 'wei@example.com',
  inviterName: 'Mei Lin',
  expiresAt: '2026-11-04T00:00:00Z',
};
const gotrue = (path: string) => world.calls.filter((c) => c.url.includes(`/auth/v1${path}`));
const rpcCalls = (fn: string) => world.calls.filter((c) => c.url.endsWith(`/rpc/${fn}`));

describe('invite links', () => {
  it('previews a live invite (token sent as a hash, never raw)', async () => {
    world.rpc.preview_invite = () => live;
    const res = await call('/api/v1/invites/preview', { body: { token: TOKEN } });
    expect(res.status).toBe(200);
    expect(await read(res)).toEqual({
      ok: true,
      email: 'wei@example.com',
      inviterName: 'Mei Lin',
      expiresAt: live.expiresAt,
    });
    const args = JSON.stringify(rpcCalls('preview_invite')[0]?.body);
    expect(args).not.toContain(TOKEN);
    expect(args).toMatch(/\\\\x[0-9a-f]{64}/);
  });

  it('unknown, malformed and dead tokens all look the same', async () => {
    world.rpc.preview_invite = () => null;
    const a = await call('/api/v1/invites/preview', { body: { token: TOKEN } });
    const b = await call('/api/v1/invites/preview', { body: { token: 'short' } });
    const c = await call('/api/v1/invites/redeem', { body: { token: TOKEN } });
    for (const r of [a, b, c]) expect(r.status).toBe(404);
    const texts = await Promise.all([a.text(), b.text(), c.text()]);
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toBe('{"ok":false,"error":"invite_invalid"}');
  });

  it('redeeming creates a confirmed account, signs in, and marks the user new', async () => {
    world.rpc.preview_invite = () => live;
    world.rpc.mark_invite_accepted = () => false; // the confirm trigger already consumed it
    const j = jar();
    const res = await call('/api/v1/invites/redeem', {
      body: { token: TOKEN, displayName: 'Wei Tan' },
      jar: j,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      isNew: true,
      user: { email: 'wei@example.com', displayName: 'Wei Tan' },
    });
    const created = gotrue('/admin/users')[0];
    expect(created?.body).toMatchObject({ email: 'wei@example.com', email_confirm: true });
    expect(created?.headers.get('apikey')).toBe('sb_secret_test');
    expect(gotrue('/admin/generate_link')).toHaveLength(1);
    expect(j.cookies.has('__Secure-zs-at')).toBe(true);
  });

  it('an existing member redeeming an invite just signs in, once', async () => {
    world.rpc.preview_invite = () => ({ ...live, email: 'mei@example.com' });
    world.rpc.mark_invite_accepted = () => true;
    const res = await call('/api/v1/invites/redeem', { body: { token: TOKEN } });
    expect(res.status).toBe(200);
    expect((await read(res)).isNew).toBe(false);
    expect(gotrue('/admin/users')).toHaveLength(0);
    world.rpc.mark_invite_accepted = () => false; // a concurrent redemption won
    expect((await call('/api/v1/invites/redeem', { body: { token: TOKEN } })).status).toBe(404);
  });

  it('never redeems into a staff account', async () => {
    world.rpc.preview_invite = () => ({ ...live, email: 'owner@zephyr.test' });
    const res = await call('/api/v1/invites/redeem', { body: { token: TOKEN } });
    expect(res.status).toBe(404);
    expect(gotrue('/admin/generate_link')).toHaveLength(0);
  });

  it('when the sign-up hook refuses (paused), the link looks invalid', async () => {
    world.rpc.preview_invite = () => live;
    world.createUserStatus = 403;
    const res = await call('/api/v1/invites/redeem', { body: { token: TOKEN } });
    expect(res.status).toBe(404);
    expect(gotrue('/admin/generate_link')).toHaveLength(0);
  });

  it('rate-limits link attempts per network', async () => {
    world.rpc.rate_limit_hit = () => false;
    expect((await call('/api/v1/invites/preview', { body: { token: TOKEN } })).status).toBe(429);
    expect(rpcCalls('preview_invite')).toHaveLength(0);
  });
});

describe('invite codes', () => {
  const redeem = (code = 'wedding-expo', email = 'Guest@Example.com') =>
    call('/api/v1/invites/code', { body: { code, email, turnstileToken: 'tok' } });
  beforeEach(() => {
    world.turnstile = { success: true, hostname: 'zephyrapp.midnightpoetry.studio', action: 'invite_code' };
  });

  it('a valid code emails a sign-up link to that address', async () => {
    world.rpc.redeem_invite_code = (a) => {
      expect(a.p_code).toBe('WEDDING-EXPO');
      expect(a.p_email).toBe('guest@example.com');
      return { status: 'created', id: 'i1', expiresAt: '2026-11-04T00:00:00Z' };
    };
    const res = await redeem();
    expect(res.status).toBe(202);
    expect(world.emails).toHaveLength(1);
    const mail = must(world.emails[0]);
    expect(mail.to).toBe('guest@example.com');
    const link = mail.text.match(/https:\/\/zephyrapp\.midnightpoetry\.studio\/join#t=([A-Za-z0-9_-]{43})/);
    expect(link).toBeTruthy();
    // The hash stored is the SHA-256 of exactly the token that was emailed.
    const stored = (rpcCalls('redeem_invite_code')[0]?.body as { p_token_hash: string } | undefined)
      ?.p_token_hash;
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(link?.[1] ?? '')),
    );
    expect(stored).toBe(`\\x${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`);
  });

  it('invalid, used-up codes and existing members get the identical reply and no email', async () => {
    const replies: string[] = [];
    for (const status of ['created', 'invalid', 'already_member']) {
      world.rpc.redeem_invite_code = () => ({ status, id: 'i1', expiresAt: '2026-11-04T00:00:00Z' });
      const res = await redeem();
      expect(res.status).toBe(202);
      replies.push(await res.text());
    }
    expect(new Set(replies).size).toBe(1);
    expect(world.emails).toHaveLength(1);
  });

  it('needs Turnstile with the invite_code action, and is rate-limited', async () => {
    world.turnstile.action = 'email_start';
    expect((await redeem()).status).toBe(403);
    world.turnstile.action = 'invite_code';
    world.rpc.rate_limit_hit = () => false;
    expect((await redeem()).status).toBe(429);
    expect(rpcCalls('redeem_invite_code')).toHaveLength(0);
  });

  it('rejects malformed codes before touching the database', async () => {
    expect((await redeem('bad code!')).status).toBe(400);
    expect(rpcCalls('redeem_invite_code')).toHaveLength(0);
  });

  it('still replies 202 when the email provider fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    world.resendStatus = 500;
    world.rpc.redeem_invite_code = () => ({ status: 'created', id: 'i1', expiresAt: '2026-11-04T00:00:00Z' });
    expect((await redeem()).status).toBe(202);
  });
});

describe('member invites', () => {
  async function member() {
    const j = jar();
    await call('/api/v1/auth/email/verify', { body: { email: 'mei@example.com', code: '123456' }, jar: j });
    return j;
  }

  it('lists my invites and quota', async () => {
    world.rpc.list_member_invites = () => ({ enabled: true, perMonth: 3, remaining: 2, invites: [] });
    const j = await member();
    const res = await call('/api/v1/invites/mine', { jar: j });
    expect(await read(res)).toEqual({ ok: true, enabled: true, perMonth: 3, remaining: 2, invites: [] });
  });

  it('sends an invite with my name and an escaped note', async () => {
    world.rpc.create_invite = (a) => {
      expect(a.p_source).toBe('member');
      return { status: 'created', id: 'inv-1', expiresAt: '2026-11-04T00:00:00Z' };
    };
    const j = await member();
    const res = await call('/api/v1/invites', {
      body: { email: 'friend@example.com', note: '<b>Hi</b> & welcome' },
      jar: j,
    });
    expect(res.status).toBe(201);
    expect((await read(res)).invite).toMatchObject({
      email: 'friend@example.com',
      status: 'pending',
      invitedBy: 'Mei Lin',
    });
    const mail = must(world.emails[0]);
    expect(mail.subject).toBe('Mei Lin invited you to Zephyr');
    expect(mail.html).toContain('&lt;b&gt;Hi&lt;/b&gt; &amp; welcome');
    expect(mail.html).not.toContain('<b>Hi</b>');
  });

  it('maps quota, disabled, paused and duplicate outcomes', async () => {
    const j = await member();
    const cases: [string, number, string][] = [
      ['quota_exceeded', 429, 'quota_exceeded'],
      ['member_invites_disabled', 403, 'member_invites_disabled'],
      ['signups_paused', 403, 'signups_paused'],
      ['already_member', 409, 'already_member'],
      ['already_invited', 409, 'conflict'],
    ];
    for (const [status, code, error] of cases) {
      world.rpc.create_invite = () => ({ status });
      const res = await call('/api/v1/invites', { body: { email: 'friend@example.com' }, jar: j });
      expect(res.status).toBe(code);
      expect((await read(res)).error).toBe(error);
    }
    expect(world.emails).toHaveLength(0);
  });

  it('needs a member session', async () => {
    expect((await call('/api/v1/invites', { body: { email: 'friend@example.com' } })).status).toBe(401);
    expect((await call('/api/v1/invites/mine')).status).toBe(401);
  });
});
