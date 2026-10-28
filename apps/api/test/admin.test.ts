import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import {
  APP,
  accessToken,
  call,
  credential,
  env,
  initKeys,
  installFetch,
  type Jar,
  jar,
  LANDING,
  must,
  read,
  resetWorld,
  sbToken,
  world,
} from './helpers';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

beforeAll(initKeys);
beforeEach(() => {
  resetWorld();
  installFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const user = (email: string) => must(world.users.find((u) => u.email === email));
const gotrue = (path: string) => world.calls.filter((c) => c.url.includes(`/auth/v1${path}`));
const rpcCalls = (fn: string) => world.calls.filter((c) => c.url.endsWith(`/rpc/${fn}`));

/** Signs a staff member in with a passkey, as their own Access identity. */
async function staffSession(email = 'owner@zephyr.test'): Promise<{ j: Jar; access: string }> {
  const access = await accessToken(email);
  world.passkeyUser = user(email);
  const j = jar();
  const res = await call('/admin/api/v1/auth/passkey/verify', {
    body: { challengeId: 'ch-auth', credential: credential('webauthn.get', LANDING) },
    jar: j,
    access,
  });
  expect(res.status).toBe(200);
  return { j, access };
}

describe('Cloudflare Access', () => {
  it('blocks every admin route without a valid Access token', async () => {
    for (const path of ['/admin/api/v1/auth/session', '/admin/api/v1/signups']) {
      const res = await call(path);
      expect(res.status).toBe(403);
    }
    const res = await call('/admin/api/v1/auth/email/start', { body: { email: 'owner@zephyr.test' } });
    expect(res.status).toBe(403);
    expect(gotrue('/otp')).toHaveLength(0);
  });

  it('rejects a wrong audience, a wrong issuer and a token signed by someone else', async () => {
    for (const access of [
      await accessToken('owner@zephyr.test', { aud: 'other-app' }),
      await accessToken('owner@zephyr.test', { iss: 'https://evil.cloudflareaccess.com' }),
      // An unsigned token (alg: none), built at runtime.
      `${b64url({ alg: 'none' })}.${b64url({ email: 'owner@zephyr.test' })}.`,
    ]) {
      expect((await call('/admin/api/v1/signups', { access })).status).toBe(403);
    }
  });

  it('the staff session must belong to the Access identity', async () => {
    const { j } = await staffSession('owner@zephyr.test');
    const res = await call('/admin/api/v1/signups', {
      jar: j,
      access: await accessToken('admin@zephyr.test'),
    });
    expect(res.status).toBe(403);
    expect(j.cookies.size).toBe(0);
  });

  it('the dev bypass works only in development on localhost', async () => {
    const dev = { ...env, ENVIRONMENT: 'development', CF_ACCESS_DEV_EMAIL: 'owner@zephyr.test' };
    const local = await app.request('http://localhost/admin/api/v1/auth/session', {}, dev);
    expect(local.status).toBe(401); // got past Access: now needs a session
    const prod = await app.request('https://zephyr.midnightpoetry.studio/admin/api/v1/auth/session', {}, dev);
    expect(prod.status).toBe(403);
    const notDev = await app.request(
      'http://localhost/admin/api/v1/auth/session',
      {},
      { ...dev, ENVIRONMENT: 'production' },
    );
    expect(notDev.status).toBe(403);
  });
});

describe('admin sign-in', () => {
  it('a passkey sign-in opens the console with Strict __Host- cookies', async () => {
    const access = await accessToken('owner@zephyr.test');
    world.passkeyUser = user('owner@zephyr.test');
    const j = jar();
    const res = await call('/admin/api/v1/auth/passkey/verify', {
      body: { challengeId: 'ch-auth', credential: credential('webauthn.get', LANDING) },
      jar: j,
      access,
    });
    expect(await read(res)).toMatchObject({
      ok: true,
      staff: { email: 'owner@zephyr.test', role: 'owner' },
      enrolOnly: false,
    });
    const cookies = res.headers.getSetCookie();
    expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual([
      '__Host-za-at',
      '__Host-za-rt',
      '__Host-za-seen',
    ]);
    for (const c of cookies) {
      expect(c).toMatch(/; Path=\/;/);
      expect(c).not.toMatch(/Domain=/i);
      expect(c).toContain('SameSite=Strict');
      expect(c).toContain('HttpOnly');
      expect(c).toContain('Secure');
    }
    expect(cookies.find((c) => c.startsWith('__Host-za-seen'))).toContain('Max-Age=1800');
    expect((await call('/admin/api/v1/signups', { jar: j, access })).status).toBe(200);
  });

  it('members cannot sign in to admin, even through Access', async () => {
    const access = await accessToken('mei@example.com');
    world.passkeyUser = user('mei@example.com');
    const res = await call('/admin/api/v1/auth/passkey/verify', {
      body: { challengeId: 'ch-auth', credential: credential('webauthn.get', LANDING) },
      access,
    });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(gotrue('/logout')).toHaveLength(1);
  });

  it('a passkey for a different staff member than the Access identity is refused', async () => {
    const access = await accessToken('owner@zephyr.test');
    world.passkeyUser = user('admin@zephyr.test');
    expect(
      (
        await call('/admin/api/v1/auth/passkey/verify', {
          body: { challengeId: 'ch-auth', credential: credential('webauthn.get', LANDING) },
          access,
        })
      ).status,
    ).toBe(403);
  });

  it('locks after 30 idle minutes', async () => {
    const { j, access } = await staffSession();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    j.cookies.set(
      '__Host-za-at',
      await sbToken({ sub: user('owner@zephyr.test').id, email: 'owner@zephyr.test', amr: ['passkey'] }),
    );
    const res = await call('/admin/api/v1/signups', { jar: j, access });
    expect(res.status).toBe(401);
    expect(j.cookies.size).toBe(0);
  });

  it('a forged or missing idle cookie ends the session', async () => {
    const { j, access } = await staffSession();
    j.cookies.set(
      '__Host-za-seen',
      `${user('owner@zephyr.test').id}:${Math.floor(Date.now() / 1000)}.forged`,
    );
    expect((await call('/admin/api/v1/signups', { jar: j, access })).status).toBe(401);
  });

  it('an app session cookie means nothing to admin', async () => {
    const access = await accessToken('owner@zephyr.test');
    const j = jar();
    j.cookies.set(
      '__Host-zs-at',
      await sbToken({ sub: user('owner@zephyr.test').id, email: 'owner@zephyr.test', amr: ['passkey'] }),
    );
    expect((await call('/admin/api/v1/signups', { jar: j, access })).status).toBe(401);
  });
});

describe('first sign-in: email code, then enrol a passkey', () => {
  const NEW = 'new.staff@zephyr.test';

  it('sends a code only to staff without a passkey, as their own Access identity', async () => {
    const access = await accessToken(NEW);
    const send = (email: string, a = access) =>
      call('/admin/api/v1/auth/email/start', { body: { email }, access: a });
    expect((await send(NEW)).status).toBe(202);
    expect(gotrue('/otp')).toHaveLength(1);
    // Someone else's address, a staff member who has a passkey, and a member: same reply, no email.
    expect((await send('owner@zephyr.test')).status).toBe(202);
    expect((await send('owner@zephyr.test', await accessToken('owner@zephyr.test'))).status).toBe(202);
    expect((await send('mei@example.com', await accessToken('mei@example.com'))).status).toBe(202);
    expect(gotrue('/otp')).toHaveLength(1);
  });

  it('an email-code session is enrol-only until a passkey is used', async () => {
    const access = await accessToken(NEW);
    const j = jar();
    const v = await call('/admin/api/v1/auth/email/verify', {
      body: { email: NEW, code: '123456' },
      jar: j,
      access,
    });
    expect(v.status).toBe(200);
    expect(await read(v)).toMatchObject({ enrolOnly: true, staff: { email: NEW, role: 'admin' } });

    const blocked = await call('/admin/api/v1/signups', { jar: j, access });
    expect(blocked.status).toBe(403);
    expect(await read(blocked)).toEqual({ ok: false, error: 'passkey_required' });
    expect(
      (
        await call('/admin/api/v1/signups/settings', {
          method: 'PATCH',
          body: { signupsPaused: true },
          jar: j,
          access,
        })
      ).status,
    ).toBe(403);
    expect((await call('/admin/api/v1/auth/session', { jar: j, access })).status).toBe(200);

    const opt = await call('/admin/api/v1/me/passkeys/options', { body: {}, jar: j, access });
    expect((await read(opt)).challengeId).toBe('ch-reg');
    const reg = await call('/admin/api/v1/me/passkeys/verify', {
      body: { challengeId: 'ch-reg', credential: credential('webauthn.create', LANDING) },
      jar: j,
      access,
    });
    expect(reg.status).toBe(201);
    expect((await read(reg)).enrolOnly).toBe(true);
    // Now a passkey sign-in opens the console, and email codes stop working for this account.
    world.passkeyUser = user(NEW);
    const k = jar();
    const pk = await call('/admin/api/v1/auth/passkey/verify', {
      body: { challengeId: 'ch-auth', credential: credential('webauthn.get', LANDING) },
      jar: k,
      access,
    });
    expect((await read(pk)).enrolOnly).toBe(false);
    expect((await call('/admin/api/v1/signups', { jar: k, access })).status).toBe(200);
    const again = await call('/admin/api/v1/auth/email/verify', {
      body: { email: NEW, code: '123456' },
      access,
    });
    expect(again.status).toBe(403);
    expect(await read(again)).toEqual({ ok: false, error: 'passkey_required' });
  });

  it('a code for an address other than the Access identity is invalid', async () => {
    const res = await call('/admin/api/v1/auth/email/verify', {
      body: { email: 'owner@zephyr.test', code: '123456' },
      access: await accessToken(NEW),
    });
    expect(res.status).toBe(400);
    expect(gotrue('/verify')).toHaveLength(0);
  });
});

describe('security review fixes (admin)', () => {
  const NEW = 'new.staff@zephyr.test';

  it('H1: parallel wrong codes reach Auth at most the per-address cap', async () => {
    const access = await accessToken(NEW);
    world.code = '999999';
    const res = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        call('/admin/api/v1/auth/email/verify', {
          body: { email: NEW, code: String(100000 + i) },
          access,
          ip: `2001:db8:${i.toString(16)}::1`,
        }),
      ),
    );
    expect(gotrue('/verify').length).toBeLessThanOrEqual(25);
    expect(res.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(25);
  });

  it('M1: another address is never counted, and a new code clears the address counter', async () => {
    const access = await accessToken(NEW);
    // Someone (even a colleague, through their own Access identity) can't burn this address.
    for (let i = 0; i < 30; i++) {
      await call('/admin/api/v1/auth/email/verify', {
        body: { email: NEW, code: '000000' },
        access: await accessToken('owner@zephyr.test'),
      });
    }
    expect(rpcCalls('rate_limit_hit')).toHaveLength(0);
    // From one network: 5 attempts, then locked out there.
    const tries = [];
    for (let i = 0; i < 6; i++) {
      tries.push(
        (await call('/admin/api/v1/auth/email/verify', { body: { email: NEW, code: '000000' }, access }))
          .status,
      );
    }
    expect(tries).toEqual([400, 400, 400, 400, 400, 429]);
    // A new code (sent to this network) unlocks it.
    expect((await call('/admin/api/v1/auth/email/start', { body: { email: NEW }, access })).status).toBe(202);
    expect(rpcCalls('rate_limit_reset').length).toBeGreaterThan(0);
    const ok = await call('/admin/api/v1/auth/email/verify', {
      body: { email: NEW, code: '123456' },
      access,
    });
    expect(ok.status).toBe(200);
  });

  it('L4: a non-staff account never reaches Auth', async () => {
    const access = await accessToken('mei@example.com');
    const res = await call('/admin/api/v1/auth/email/verify', {
      body: { email: 'mei@example.com', code: '123456' },
      access,
    });
    expect(await read(res)).toEqual({ ok: false, error: 'invalid_code' });
    expect(gotrue('/verify')).toHaveLength(0);
  });

  it('L1: an assertion made on the app origin, or a registration response, is refused', async () => {
    const access = await accessToken('owner@zephyr.test');
    world.passkeyUser = user('owner@zephyr.test');
    for (const cred of [
      credential('webauthn.get', APP),
      credential('webauthn.create', LANDING),
      credential('webauthn.get', LANDING, { crossOrigin: true }),
      { id: 'x', response: { clientDataJSON: 'not base64 json!' } },
      { id: 'x' },
    ]) {
      const res = await call('/admin/api/v1/auth/passkey/verify', {
        body: { challengeId: 'ch-auth', credential: cred },
        access,
      });
      expect(await read(res)).toEqual({ ok: false, error: 'passkey_failed' });
    }
    expect(gotrue('/passkeys/authentication/verify')).toHaveLength(0);
  });

  it('L1/L2: enrolment checks the origin, emails the staff member, and an enrol-only session adds one key only', async () => {
    const access = await accessToken(NEW);
    const j = jar();
    await call('/admin/api/v1/auth/email/verify', { body: { email: NEW, code: '123456' }, jar: j, access });
    const wrong = await call('/admin/api/v1/me/passkeys/verify', {
      body: { challengeId: 'ch-reg', credential: credential('webauthn.create', APP) },
      jar: j,
      access,
    });
    expect(await read(wrong)).toEqual({ ok: false, error: 'passkey_failed' });
    const reg = await call('/admin/api/v1/me/passkeys/verify', {
      body: { challengeId: 'ch-reg', credential: credential('webauthn.create', LANDING) },
      jar: j,
      access,
    });
    expect(reg.status).toBe(201);
    expect(world.emails).toHaveLength(1);
    expect(world.emails[0]?.to).toBe(NEW);
    expect(world.emails[0]?.subject).toBe('A passkey was added to your Zephyr account');
    // The same email-code session can't add a second key.
    for (const path of ['/admin/api/v1/me/passkeys/options', '/admin/api/v1/me/passkeys/verify']) {
      const res = await call(path, {
        body: { challengeId: 'ch-reg', credential: credential('webauthn.create', LANDING) },
        jar: j,
        access,
      });
      expect(await read(res)).toEqual({ ok: false, error: 'passkey_required' });
    }
    expect(user(NEW).passkeys).toBe(1);
  });

  it('L3: resend is refused for an account that exists or a superseded invite', async () => {
    const { j, access } = await staffSession();
    const id = '30000000-0000-0000-0000-000000000009';
    world.rpc.resend_invite = () => ({ status: 'already_member' });
    const a = await call(`/admin/api/v1/signups/invites/${id}/resend`, { body: {}, jar: j, access });
    expect(a.status).toBe(409);
    expect(await read(a)).toEqual({ ok: false, error: 'already_member' });
    world.rpc.resend_invite = () => ({ status: 'superseded' });
    const b = await call(`/admin/api/v1/signups/invites/${id}/resend`, { body: {}, jar: j, access });
    expect(b.status).toBe(409);
    expect(await read(b)).toEqual({ ok: false, error: 'conflict' });
    expect(world.emails).toHaveLength(0);
  });

  it('M2: duplicate admin session cookies are refused and cleared', async () => {
    const { access } = await staffSession();
    const res = await app.request(
      'https://zephyr.midnightpoetry.studio/admin/api/v1/auth/session',
      { headers: { Cookie: '__Host-za-at=a; __Host-za-at=b', 'Cf-Access-Jwt-Assertion': access } },
      env,
    );
    expect(res.status).toBe(401);
    expect(
      res.headers
        .getSetCookie()
        .map((c) => c.split('=')[0])
        .sort(),
    ).toEqual(['__Host-za-at', '__Host-za-rt', '__Host-za-seen']);
  });
});

describe('Sign-ups & invites', () => {
  it('returns the overview', async () => {
    world.rpc.get_signup_overview = () => ({
      settings: { signupMode: 'invite_only' },
      pendingRequests: 3,
      pendingInvites: 2,
      codes: [],
    });
    const { j, access } = await staffSession('support@zephyr.test');
    const res = await call('/admin/api/v1/signups', { jar: j, access });
    expect(await read(res)).toMatchObject({ ok: true, pendingRequests: 3 });
  });

  it('support staff are read-only', async () => {
    const { j, access } = await staffSession('support@zephyr.test');
    const res = await call('/admin/api/v1/signups/settings', {
      method: 'PATCH',
      body: { signupsPaused: true },
      jar: j,
      access,
    });
    expect(res.status).toBe(403);
    expect(rpcCalls('update_signup_settings')).toHaveLength(0);
    expect(
      (await call('/admin/api/v1/signups/invites', { body: { emails: ['a@example.com'] }, jar: j, access }))
        .status,
    ).toBe(403);
  });

  it('settings changes go to the database with the actor and reason; its refusal is a 403', async () => {
    const { j, access } = await staffSession('admin@zephyr.test');
    world.rpc.update_signup_settings = (a) => {
      expect(a.p_actor).toBe(user('admin@zephyr.test').id);
      expect(a.p_patch).toEqual({ signupMode: 'open' });
      expect(a.p_reason).toBe('Launch');
      return { status: 'forbidden' };
    };
    const res = await call('/admin/api/v1/signups/settings', {
      method: 'PATCH',
      body: { signupMode: 'open', reason: 'Launch' },
      jar: j,
      access,
    });
    expect(res.status).toBe(403);
    world.rpc.update_signup_settings = () => ({
      status: 'ok',
      settings: { signupMode: 'invite_only', inviteTtlDays: 14 },
    });
    const ok = await call('/admin/api/v1/signups/settings', {
      method: 'PATCH',
      body: { inviteTtlDays: 14 },
      jar: j,
      access,
    });
    expect(await read(ok)).toEqual({ ok: true, signupMode: 'invite_only', inviteTtlDays: 14 });
    expect(
      (
        await call('/admin/api/v1/signups/settings', {
          method: 'PATCH',
          body: { reason: 'nothing' },
          jar: j,
          access,
        })
      ).status,
    ).toBe(400);
  });

  it('admin writes need the admin origin', async () => {
    const { j, access } = await staffSession();
    const res = await call('/admin/api/v1/signups/settings', {
      method: 'PATCH',
      body: { signupsPaused: true },
      jar: j,
      access,
      origin: APP,
    });
    expect(res.status).toBe(403);
  });

  it('invites people: sends, skips duplicates and members, and revokes on a failed email', async () => {
    const { j, access } = await staffSession();
    world.rpc.create_invite = (a) => {
      if (a.p_email === 'mei@example.com') return { status: 'already_member' };
      if (a.p_email === 'dup@example.com') return { status: 'already_invited' };
      return { status: 'created', id: crypto.randomUUID(), expiresAt: '2026-11-04T00:00:00Z' };
    };
    world.rpc.revoke_invite = () => ({ status: 'ok' });
    const res = await call('/admin/api/v1/signups/invites', {
      body: {
        emails: ['New@Example.com', 'new@example.com', 'mei@example.com', 'dup@example.com', 'not-an-email'],
        note: 'Hi',
      },
      jar: j,
      access,
    });
    expect(await read(res)).toEqual({
      ok: true,
      sent: 1,
      skipped: [
        { email: 'mei@example.com', reason: 'already_member' },
        { email: 'dup@example.com', reason: 'already_invited' },
        { email: 'not-an-email', reason: 'invalid' },
      ],
    });
    expect(world.emails.map((e) => e.to)).toEqual(['new@example.com']);
    expect(world.emails[0]?.subject).toBe('You’re invited to Zephyr');

    world.resendStatus = 500;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await call('/admin/api/v1/signups/invites', {
      body: { emails: ['x@example.com'] },
      jar: j,
      access,
    });
    expect(await read(failed)).toEqual({
      ok: true,
      sent: 0,
      skipped: [{ email: 'x@example.com', reason: 'send_failed' }],
    });
    expect(rpcCalls('revoke_invite')).toHaveLength(1);
  });

  it('resends with a fresh token and revokes', async () => {
    const { j, access } = await staffSession();
    const id = '30000000-0000-0000-0000-000000000009';
    world.rpc.resend_invite = (a) => {
      expect(String(a.p_token_hash)).toMatch(/^\\x[0-9a-f]{64}$/);
      return {
        status: 'ok',
        invite: { id, expiresAt: '2026-11-05T00:00:00Z', status: 'pending' },
        email: 'w@example.com',
        inviterName: null,
      };
    };
    expect(
      (await call(`/admin/api/v1/signups/invites/${id}/resend`, { body: {}, jar: j, access })).status,
    ).toBe(200);
    expect(world.emails).toHaveLength(1);
    world.rpc.revoke_invite = () => ({ status: 'not_found' });
    expect(
      (await call(`/admin/api/v1/signups/invites/${id}/revoke`, { body: {}, jar: j, access })).status,
    ).toBe(404);
    expect(
      (await call('/admin/api/v1/signups/invites/not-a-uuid/revoke', { body: {}, jar: j, access })).status,
    ).toBe(400);
  });

  it('creates and revokes codes', async () => {
    const { j, access } = await staffSession();
    world.rpc.create_invite_code = (a) =>
      a.p_code === 'TAKEN' ? { status: 'conflict' } : { status: 'ok', code: { id: 'c1', code: a.p_code } };
    const ok = await call('/admin/api/v1/signups/codes', {
      body: { code: 'wedding-expo', maxUses: 50 },
      jar: j,
      access,
    });
    expect(ok.status).toBe(201);
    expect((await read(ok)).code.code).toBe('WEDDING-EXPO');
    expect(
      (await call('/admin/api/v1/signups/codes', { body: { code: 'TAKEN', maxUses: 5 }, jar: j, access }))
        .status,
    ).toBe(409);
    expect(
      (await call('/admin/api/v1/signups/codes', { body: { code: 'no spaces', maxUses: 5 }, jar: j, access }))
        .status,
    ).toBe(400);
  });

  it('approving requests sends invites; a failed email reopens the request', async () => {
    const { j, access } = await staffSession();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    world.rpc.decide_invite_requests = () => ({
      status: 'ok',
      approved: [
        { id: ids[0], email: 'r1@example.com' },
        { id: ids[1], email: 'r2@example.com' },
      ],
      declined: 0,
    });
    world.rpc.create_invite = () => ({
      status: 'created',
      id: crypto.randomUUID(),
      expiresAt: '2026-11-04T00:00:00Z',
    });
    world.rpc.revoke_invite = () => ({ status: 'ok' });
    world.rpc.reopen_invite_request = () => null;
    let n = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const origFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://api.resend.com/') && ++n === 2)
        return new Response('{}', { status: 500 });
      return origFetch(input, init);
    });
    const res = await call('/admin/api/v1/signups/requests/decide', {
      body: { ids, decision: 'approve' },
      jar: j,
      access,
    });
    expect(await read(res)).toEqual({ ok: true, approved: 1, declined: 0 });
    expect(rpcCalls('reopen_invite_request')).toHaveLength(1);
    expect((rpcCalls('reopen_invite_request')[0]?.body as { p_id: string } | undefined)?.p_id).toBe(ids[1]);
  });

  it('lists invites and requests with a cursor', async () => {
    const { j, access } = await staffSession('support@zephyr.test');
    world.rpc.list_invites = (a) => ({ items: [], nextCursor: a.p_cursor ? null : 'next' });
    world.rpc.list_invite_requests = () => ({ items: [{ id: 'r' }], nextCursor: null });
    const a = await call('/admin/api/v1/signups/invites?status=pending', { jar: j, access });
    expect(await read(a)).toEqual({ ok: true, items: [], nextCursor: 'next' });
    expect((rpcCalls('list_invites')[0]?.body as { p_status: string } | undefined)?.p_status).toBe('pending');
    const b = await call('/admin/api/v1/signups/requests', { jar: j, access });
    expect((await read(b)).items).toHaveLength(1);
  });
});
