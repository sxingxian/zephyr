import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_TIMING } from '../src/auth/code-limits';
import {
  APP,
  accountActionToken,
  call,
  credential,
  initKeys,
  installFetch,
  jar,
  LANDING,
  must,
  read,
  resetWorld,
  sbToken,
  setLimiter,
  world,
} from './helpers';

beforeAll(initKeys);
beforeEach(() => {
  resetWorld();
  installFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MEI = () => must(world.users.find((u) => u.email === 'mei@example.com'));
const AH = 'X-Zephyr-Account-Action';
const start = (email: string, extra: Record<string, unknown> = {}) =>
  call('/api/v1/auth/email/start', { body: { email, turnstileToken: 'tok', ...extra } });
const gotrueCalls = (path: string) => world.calls.filter((c) => c.url.includes(`/auth/v1${path}`));

async function signIn(email = 'mei@example.com') {
  const j = jar();
  const res = await call('/api/v1/auth/email/verify', { body: { email, code: '123456' }, jar: j });
  return { j, res };
}

describe('email code: start', () => {
  it('sends a code to a member and replies 202', async () => {
    const res = await start('Mei@Example.com');
    expect(res.status).toBe(202);
    expect(await read(res)).toEqual({ ok: true });
    const otp = gotrueCalls('/otp');
    expect(otp).toHaveLength(1);
    expect(otp[0]?.body).toEqual({ email: 'mei@example.com', create_user: false });
    expect(otp[0]?.headers.get('apikey')).toBe('sb_publishable_test');
  });

  it('gives unknown emails and staff the identical reply, and sends them nothing', async () => {
    const a = await start('mei@example.com');
    const b = await start('nobody@example.com');
    const c = await start('owner@zephyr.test');
    expect([a.status, b.status, c.status]).toEqual([202, 202, 202]);
    const [ta, tb, tc] = await Promise.all([a.text(), b.text(), c.text()]);
    expect(tb).toBe(ta);
    expect(tc).toBe(ta);
    expect(gotrueCalls('/otp')).toHaveLength(1);
  });

  it('requires Turnstile with the email_start action', async () => {
    world.turnstile = {
      success: true,
      hostname: 'zephyrapp.midnightpoetry.studio',
      action: 'invite_request',
    };
    const res = await start('mei@example.com');
    expect(res.status).toBe(403);
    expect(await read(res)).toEqual({ ok: false, error: 'verification_failed' });
    expect(gotrueCalls('/otp')).toHaveLength(0);
  });

  it('rate-limits per network and per address', async () => {
    world.rpc.rate_limit_hit = (a) => a.p_kind !== 'email_start';
    const res = await start('mei@example.com');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('900');
    world.rpc.rate_limit_hit = (a) => a.p_kind !== 'email_start_addr';
    expect((await start('mei@example.com')).status).toBe(429);
    expect(gotrueCalls('/otp')).toHaveLength(0);
  });

  it('hashes the network and the address for limits (no raw values)', async () => {
    await start('mei@example.com');
    const limits = world.calls
      .filter((c) => /\/rpc\/rate_limit_(hit|reset)$/.test(c.url))
      .map((c) => JSON.stringify(c.body));
    expect(limits).toHaveLength(6); // 3 limits checked, then 3 counters reset for the new code
    for (const l of limits) {
      expect(l).not.toContain('203.0.113.7');
      expect(l).not.toContain('mei@example.com');
      expect(l).toMatch(/\\\\x[0-9a-f]{64}/);
    }
  });

  it('rejects a foreign Origin (CSRF) and the landing origin', async () => {
    expect(
      (
        await call('/api/v1/auth/email/start', {
          body: { email: 'mei@example.com', turnstileToken: 't' },
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('/api/v1/auth/email/start', {
          body: { email: 'mei@example.com', turnstileToken: 't' },
          origin: LANDING,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('/api/v1/auth/email/start', {
          body: { email: 'mei@example.com', turnstileToken: 't' },
          origin: null,
        })
      ).status,
    ).toBe(403);
    expect(gotrueCalls('/otp')).toHaveLength(0);
  });

  it('trips the burst limiter before doing anything', async () => {
    setLimiter(false);
    expect((await start('mei@example.com')).status).toBe(429);
    expect(world.calls).toHaveLength(0);
  });
});

describe('email code: verify and the session cookies', () => {
  it('signs a member in with httpOnly, Secure, __Host- cookies', async () => {
    const j = jar();
    const res = await call('/api/v1/auth/email/verify', {
      body: { email: 'mei@example.com', code: '123456' },
      jar: j,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      user: { email: 'mei@example.com', displayName: 'Mei Lin', plan: 'free', passkeyCount: 1 },
    });
    expect(JSON.stringify(body)).not.toMatch(/access_token|refresh_token|eyJ/);
    const all = res.headers.getSetCookie();
    // Phase 8: a new sign-in also clears any AdSense cookie (GET /ads sets a fresh one for this member if any).
    const ads = all.filter((ck) => ck.startsWith('__Host-zads='));
    expect(ads).toHaveLength(1);
    expect(ads[0]).toContain('Max-Age=0');
    const cookies = all.filter((ck) => !ck.startsWith('__Host-zads='));
    expect(cookies).toHaveLength(2);
    for (const ck of cookies) {
      expect(ck).toMatch(/^__Host-zs-(at|rt)=/);
      expect(ck).toMatch(/; Path=\/;/);
      expect(ck).toContain('HttpOnly');
      expect(ck).toContain('Secure');
      expect(ck).toContain('SameSite=Lax');
      expect(ck).not.toMatch(/Domain=/i);
    }
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const session = await call('/api/v1/auth/session', { jar: j });
    expect(session.status).toBe(200);
    expect((await read(session)).user.id).toBe(MEI().id);
  });

  it('a wrong code is 400 invalid_code, and the attempt was reserved before Auth saw it', async () => {
    const res = await call('/api/v1/auth/email/verify', {
      body: { email: 'mei@example.com', code: '000000' },
    });
    expect(res.status).toBe(400);
    expect(await read(res)).toEqual({ ok: false, error: 'invalid_code' });
    const order = world.calls
      .map((c) => c.url)
      .filter((u) => u.endsWith('/rpc/rate_limit_hit') || u.endsWith('/auth/v1/verify'));
    expect(order.at(-1)).toMatch(/\/auth\/v1\/verify$/);
    expect(order.filter((u) => u.endsWith('/rate_limit_hit'))).toHaveLength(4); // network, free, pair, address
  });

  it('staff and unknown addresses never reach Auth (same invalid_code)', async () => {
    world.turnstile.action = 'email_verify';
    for (const email of ['owner@zephyr.test', 'nobody@example.com']) {
      const res = await call('/api/v1/auth/email/verify', {
        body: { email, code: '123456', turnstileToken: 'tok' },
      });
      expect(await read(res)).toEqual({ ok: false, error: 'invalid_code' });
    }
    expect(gotrueCalls('/verify')).toHaveLength(0);
  });

  it('wrong-code replies take the same minimum time whether or not Auth was asked', async () => {
    CODE_TIMING.floorMs = 60;
    world.turnstile.action = 'email_verify';
    for (const email of ['nobody@example.com', 'mei@example.com']) {
      const t = Date.now();
      await call('/api/v1/auth/email/verify', { body: { email, code: '000000', turnstileToken: 'tok' } });
      expect(Date.now() - t).toBeGreaterThanOrEqual(55);
    }
  });

  it('rejects a malformed code without calling Auth', async () => {
    const res = await call('/api/v1/auth/email/verify', {
      body: { email: 'mei@example.com', code: '12ab56' },
    });
    expect(res.status).toBe(400);
    expect(gotrueCalls('/verify')).toHaveLength(0);
  });
});

describe('session handling', () => {
  it('is 401 without cookies', async () => {
    const res = await call('/api/v1/auth/session');
    expect(res.status).toBe(401);
    expect(await read(res)).toEqual({ ok: false, error: 'unauthenticated' });
  });

  it('refreshes a token that is about to expire and rotates the cookies', async () => {
    const { j } = await signIn();
    j.cookies.set('__Host-zs-at', await sbToken({ sub: MEI().id, email: MEI().email, expIn: 120 }));
    const oldRt = j.cookies.get('__Host-zs-rt');
    const res = await call('/api/v1/auth/session', { jar: j });
    expect(res.status).toBe(200);
    expect(gotrueCalls('/token')).toHaveLength(1);
    expect(j.cookies.get('__Host-zs-rt')).not.toBe(oldRt);
  });

  it('refreshes an expired token, and clears cookies when the refresh token is dead', async () => {
    const { j } = await signIn();
    j.cookies.set('__Host-zs-at', await sbToken({ sub: MEI().id, email: MEI().email, expIn: -60 }));
    expect((await call('/api/v1/auth/session', { jar: j })).status).toBe(200);
    j.cookies.set('__Host-zs-at', await sbToken({ sub: MEI().id, email: MEI().email, expIn: -60 }));
    j.cookies.set('__Host-zs-rt', 'rt-revoked');
    const res = await call('/api/v1/auth/session', { jar: j });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().every((c) => c.includes('Max-Age=0'))).toBe(true);
    expect(j.cookies.size).toBe(0);
  });

  it('rejects a forged token (wrong signing key) and a wrong audience', async () => {
    const j = jar();
    j.cookies.set('__Host-zs-at', await sbToken({ sub: MEI().id, email: MEI().email, forged: true }));
    expect((await call('/api/v1/auth/session', { jar: j })).status).toBe(401);
    const k = jar();
    k.cookies.set('__Host-zs-at', await sbToken({ sub: MEI().id, email: MEI().email, aud: 'service_role' }));
    expect((await call('/api/v1/auth/session', { jar: k })).status).toBe(401);
  });

  it('ends a staff session found in the app cookies', async () => {
    const owner = must(world.users.find((u) => u.staff === 'owner'));
    const j = jar();
    j.cookies.set('__Host-zs-at', await sbToken({ sub: owner.id, email: owner.email }));
    const res = await call('/api/v1/auth/session', { jar: j });
    expect(res.status).toBe(403);
    expect(gotrueCalls('/logout')).toHaveLength(1);
  });

  it('signs out: revokes upstream and clears cookies', async () => {
    const { j } = await signIn();
    const res = await call('/api/v1/auth/sign-out', { body: {}, jar: j });
    expect(res.status).toBe(204);
    expect(gotrueCalls('/logout')).toHaveLength(1);
    expect(j.cookies.size).toBe(0);
    expect((await call('/api/v1/auth/session', { jar: j })).status).toBe(401);
  });

  it('a session cookie alone cannot make a cross-site write', async () => {
    const { j } = await signIn();
    const res = await call('/api/v1/me', {
      method: 'PATCH',
      body: { displayName: 'Hacked' },
      jar: j,
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect(MEI().displayName).toBe('Mei Lin');
  });
});

describe('passkeys', () => {
  it('signs a member in with a passkey', async () => {
    world.passkeyUser = MEI();
    const opt = await call('/api/v1/auth/passkey/options', { body: {} });
    expect(await read(opt)).toEqual({
      challengeId: 'ch-auth',
      options: { challenge: 'abc', rpId: 'midnightpoetry.studio' },
    });
    const j = jar();
    const res = await call('/api/v1/auth/passkey/verify', {
      body: { challengeId: 'ch-auth', credential: credential('webauthn.get', APP) },
      jar: j,
    });
    expect(res.status).toBe(200);
    expect(j.cookies.has('__Host-zs-at')).toBe(true);
  });

  it('a failed assertion is passkey_failed', async () => {
    const res = await call('/api/v1/auth/passkey/verify', {
      body: { challengeId: 'ch-auth', credential: credential('webauthn.get', APP) },
    });
    expect(res.status).toBe(400);
    expect(await read(res)).toEqual({ ok: false, error: 'passkey_failed' });
  });

  it('a staff passkey cannot open an app session', async () => {
    world.passkeyUser = must(world.users.find((u) => u.staff === 'owner'));
    const res = await call('/api/v1/auth/passkey/verify', {
      body: { challengeId: 'ch-auth', credential: credential('webauthn.get', APP) },
    });
    expect(res.status).toBe(403);
  });

  it('a member registers, lists, renames and deletes passkeys', async () => {
    const { j } = await signIn();
    const add = await accountActionToken(j, 'passkey_add');
    const opt = await call('/api/v1/me/passkeys/options', { body: {}, jar: j, headers: { [AH]: add } });
    expect((await read(opt)).challengeId).toBe('ch-reg');
    const reg = await call('/api/v1/me/passkeys/verify', {
      body: { challengeId: 'ch-reg', credential: credential('webauthn.create', APP) },
      jar: j,
    });
    expect(reg.status).toBe(201);
    expect((await read(reg)).passkey).toMatchObject({ id: 'pk-new', friendlyName: 'iCloud Keychain' });
    const listed = await call('/api/v1/me/passkeys', { jar: j });
    expect((await read(listed)).passkeys).toHaveLength(2);
    const ren = await call('/api/v1/me/passkeys/pk-0', {
      method: 'PATCH',
      body: { friendlyName: 'Work laptop' },
      jar: j,
    });
    expect((await read(ren)).passkey.friendlyName).toBe('Work laptop');
    const remove = await accountActionToken(j, 'passkey_remove', 'pk-0');
    const del = await call('/api/v1/me/passkeys/pk-0', {
      method: 'DELETE',
      jar: j,
      headers: { 'Content-Length': '0', [AH]: remove },
    });
    expect(del.status).toBe(204);
    expect((await call('/api/v1/me/passkeys/..%2Fadmin', { method: 'DELETE', jar: j })).status).toBe(400);
  });

  it('passkey routes need a session', async () => {
    expect((await call('/api/v1/me/passkeys/options', { body: {} })).status).toBe(401);
  });
});

describe('account action links (phase 8: account changes only from a link emailed to the account)', () => {
  const linkIn = (text: string | undefined) =>
    /\/account-action\/[A-Za-z0-9_-]{22}#t=([A-Za-z0-9_-]{43})(?:\s|$)/.exec(text ?? '')?.[1];
  const ask = (j: ReturnType<typeof jar>, body: Record<string, unknown>) =>
    call('/api/v1/me/account-actions', { body, jar: j });
  const del = (j: ReturnType<typeof jar>, token?: string, id = 'pk-0') =>
    call(`/api/v1/me/passkeys/${id}`, {
      method: 'DELETE',
      jar: j,
      headers: { 'Content-Length': '0', ...(token ? { [AH]: token } : {}) },
    });

  it('every member needs the link: no link, no change', async () => {
    const { j } = await signIn();
    const none = await del(j);
    expect(none.status).toBe(403);
    expect((await read(none)).error).toBe('account_action_required');
    const opt = await call('/api/v1/me/passkeys/options', { body: {}, jar: j });
    expect((await read(opt)).error).toBe('account_action_required');
    const gone = await call('/api/v1/me/delete', { body: { confirm: 'DELETE' }, jar: j });
    expect((await read(gone)).error).toBe('account_action_required');
    expect(gotrueCalls('/passkeys/registration')).toHaveLength(0);
    expect(world.emails).toHaveLength(0);
  });

  it('a bogus, foreign or used link on the options call never reaches GoTrue', async () => {
    const { j } = await signIn();
    const bogus = await call('/api/v1/me/passkeys/options', { body: {}, jar: j, headers: { [AH]: 'nope' } });
    expect((await read(bogus)).error).toBe('account_action_invalid');
    const unknown = await call('/api/v1/me/passkeys/options', {
      body: {},
      jar: j,
      headers: { [AH]: 'A'.repeat(43) },
    });
    expect((await read(unknown)).error).toBe('account_action_invalid');
    // A real link for another change isn't spent and creates nothing upstream.
    const remove = await accountActionToken(j, 'passkey_remove', 'pk-0');
    const wrongOp = await call('/api/v1/me/passkeys/options', {
      body: {},
      jar: j,
      headers: { [AH]: remove },
    });
    expect((await read(wrongOp)).error).toBe('account_action_invalid');
    world.users.push({ id: '20000000-0000-0000-0000-000000000009', email: 'sam@example.com', passkeys: 1 });
    const { j: k } = await signIn('sam@example.com');
    const add = await accountActionToken(j, 'passkey_add');
    const foreign = await call('/api/v1/me/passkeys/options', { body: {}, jar: k, headers: { [AH]: add } });
    expect((await read(foreign)).error).toBe('account_action_wrong_member');
    expect(gotrueCalls('/passkeys/registration')).toHaveLength(0);
    expect((await del(j, remove)).status).toBe(204);
  });

  it('asking again doesn’t cancel a link already sent: up to three stay open, then the oldest goes', async () => {
    const { j } = await signIn();
    const first = await accountActionToken(j, 'account_delete');
    const second = await accountActionToken(j, 'account_delete');
    const third = await accountActionToken(j, 'account_delete');
    const peekOf = async (t: string) =>
      read(await call('/api/v1/me/account-actions/peek', { body: { token: t }, jar: j }));
    for (const t of [first, second, third]) expect((await peekOf(t)).op).toBe('account_delete');
    const fourth = await accountActionToken(j, 'account_delete');
    expect((await peekOf(first)).error).toBe('account_action_invalid');
    expect((await peekOf(second)).op).toBe('account_delete');
    expect((await peekOf(fourth)).op).toBe('account_delete');
  });

  it('asking emails a link to the account address and returns nothing secret', async () => {
    const { j } = await signIn();
    const spy = vi.spyOn(console, 'error');
    const logSpy = vi.spyOn(console, 'log');
    const res = await ask(j, { op: 'passkey_remove', passkeyId: 'pk-0' });
    expect(res.status).toBe(202);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ ok: true });
    const email = must(world.emails.at(-1));
    expect(email.to).toBe('mei@example.com');
    expect(email.subject).toBe('Remove a passkey from your Zephyr account');
    const token = must(linkIn(email.text));
    // A fresh path nonce per link: opening it is always a new document (review round 5).
    const nonce = must(/\/account-action\/([A-Za-z0-9_-]{22})#t=/.exec(email.text)?.[1]);
    expect(email.text).toContain(`${APP}/account-action/${nonce}#t=${token}`);
    expect(email.html).toContain(`/account-action/${nonce}#t=${token}`);
    expect(email.text).toContain('never paste it into Zephyr');
    await ask(j, { op: 'passkey_remove', passkeyId: 'pk-0' });
    expect(must(world.emails.at(-1)).text).not.toContain(`/account-action/${nonce}#`);
    expect(email.subject).not.toContain(token);
    expect(email.text).toContain('never inside your library');
    // The token is in the email only: not in the response, not stored, not logged.
    expect(body).not.toContain(token);
    expect(world.actions.some((r) => r.hash.includes(token))).toBe(false);
    for (const c of [...spy.mock.calls, ...logSpy.mock.calls]) expect(JSON.stringify(c)).not.toContain(token);
  });

  it('a link works once, only for its change, passkey and member', async () => {
    const { j } = await signIn();
    const token = await accountActionToken(j, 'passkey_remove', 'pk-0');
    // Not for another change or passkey; malformed tokens are refused without a lookup.
    const wrongOp = await call('/api/v1/me/delete', {
      body: { confirm: 'DELETE' },
      jar: j,
      headers: { [AH]: token },
    });
    expect((await read(wrongOp)).error).toBe('account_action_invalid');
    expect((await read(await del(j, token, 'pk-1'))).error).toBe('account_action_invalid');
    expect((await read(await del(j, 'short'))).error).toBe('account_action_invalid');
    // Another member's session can't use it (and doesn't spend it).
    world.users.push({ id: '20000000-0000-0000-0000-000000000009', email: 'sam@example.com', passkeys: 1 });
    const { j: sam } = await signIn('sam@example.com');
    expect((await read(await del(sam, token))).error).toBe('account_action_wrong_member');
    expect((await del(j, token)).status).toBe(204);
    expect((await read(await del(j, token))).error).toBe('account_action_invalid');
  });

  it('expired and retired links are refused', async () => {
    const { j } = await signIn();
    const old = await accountActionToken(j, 'passkey_remove', 'pk-0');
    for (const r of world.actions) r.expires = Date.now() - 1;
    expect((await read(await del(j, old))).error).toBe('account_action_invalid');
    // Three may be open at once; a fourth retires the oldest.
    const first = await accountActionToken(j, 'passkey_remove', 'pk-0');
    await accountActionToken(j, 'passkey_remove', 'pk-0');
    await accountActionToken(j, 'passkey_remove', 'pk-0');
    const fourth = await accountActionToken(j, 'passkey_remove', 'pk-0');
    expect((await read(await del(j, first))).error).toBe('account_action_invalid');
    expect((await del(j, fourth)).status).toBe(204);
  });

  it('asking checks the body and the passkey, and is rate limited', async () => {
    const { j } = await signIn();
    expect((await ask(j, { op: 'nope' })).status).toBe(400);
    expect((await ask(j, { op: 'passkey_remove' })).status).toBe(400);
    expect((await ask(j, { op: 'passkey_add', passkeyId: 'pk-0' })).status).toBe(400);
    expect((await ask(j, { op: 'passkey_remove', passkeyId: '../admin' })).status).toBe(400);
    expect((await ask(j, { op: 'passkey_remove', passkeyId: 'pk-404' })).status).toBe(404);
    expect(world.emails).toHaveLength(0);
    for (let i = 0; i < 5; i++) expect((await ask(j, { op: 'account_delete' })).status).toBe(202);
    const sixth = await ask(j, { op: 'account_delete' });
    expect(sixth.status).toBe(429);
    expect(world.emails).toHaveLength(5);
    expect((await ask(j, { op: 'passkey_add' })).status).toBe(202);
    const limited = jar();
    for (const [k, v] of j.cookies) limited.cookies.set(k, v);
    setLimiter(false);
    expect((await ask(limited, { op: 'passkey_add' })).status).toBe(429);
  });

  it('asking needs a recent sign-in; making the change needs the link, not a fresh session', async () => {
    const { j } = await signIn();
    const token = await accountActionToken(j, 'passkey_remove', 'pk-0');
    j.cookies.set('__Host-zs-at', await sbToken({ sub: MEI().id, email: MEI().email, authAgo: 11 * 60 }));
    expect(await read(await ask(j, { op: 'account_delete' }))).toEqual({
      ok: false,
      error: 'reauth_required',
    });
    expect((await del(j, token)).status).toBe(204);
  });

  it('peeking shows the change without spending the link', async () => {
    const { j } = await signIn();
    const token = await accountActionToken(j, 'passkey_remove', 'pk-0');
    const peek = (k: ReturnType<typeof jar>, t: unknown) =>
      call('/api/v1/me/account-actions/peek', { body: { token: t }, jar: k });
    const r = await read(await peek(j, token));
    expect(r).toMatchObject({ ok: true, op: 'passkey_remove', passkeyId: 'pk-0' });
    expect(Date.parse(r.expiresAt)).toBeGreaterThan(Date.now());
    expect((await read(await peek(j, 'x'.repeat(43)))).error).toBe('account_action_invalid');
    expect((await peek(j, 'short')).status).toBe(400);
    world.users.push({ id: '20000000-0000-0000-0000-000000000009', email: 'sam@example.com', passkeys: 1 });
    const { j: sam } = await signIn('sam@example.com');
    expect((await read(await peek(sam, token))).error).toBe('account_action_wrong_member');
    expect((await call('/api/v1/me/account-actions/peek', { body: { token } })).status).toBe(401);
    expect((await del(j, token)).status).toBe(204);
    expect((await read(await peek(j, token))).error).toBe('account_action_invalid');
  });

  it('adding a passkey: the link is spent on the options, and only that challenge can be completed', async () => {
    const { j } = await signIn();
    const sneaky = await call('/api/v1/me/passkeys/verify', {
      body: { challengeId: 'ch-reg', credential: credential('webauthn.create', APP) },
      jar: j,
    });
    expect((await read(sneaky)).error).toBe('account_action_required');
    const token = await accountActionToken(j, 'passkey_add');
    const opt = await call('/api/v1/me/passkeys/options', { body: {}, jar: j, headers: { [AH]: token } });
    expect((await read(opt)).challengeId).toBe('ch-reg');
    const twice = await call('/api/v1/me/passkeys/options', { body: {}, jar: j, headers: { [AH]: token } });
    expect((await read(twice)).error).toBe('account_action_invalid');
    const other = await call('/api/v1/me/passkeys/verify', {
      body: { challengeId: 'ch-other', credential: credential('webauthn.create', APP) },
      jar: j,
    });
    expect((await read(other)).error).toBe('account_action_required');
    const reg = await call('/api/v1/me/passkeys/verify', {
      body: { challengeId: 'ch-reg', credential: credential('webauthn.create', APP) },
      jar: j,
    });
    expect(reg.status).toBe(201);
    const replay = await call('/api/v1/me/passkeys/verify', {
      body: { challengeId: 'ch-reg', credential: credential('webauthn.create', APP) },
      jar: j,
    });
    expect((await read(replay)).error).toBe('account_action_required');
  });

  it('the database failing closes the door', async () => {
    const { j } = await signIn();
    const token = await accountActionToken(j, 'passkey_remove', 'pk-0');
    world.rpc.account_action_use = () => new Response('{}', { status: 500 });
    world.rpc.account_action_issue = () => new Response('{}', { status: 500 });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await del(j, token)).status).toBe(500);
    expect((await ask(j, { op: 'passkey_add' })).status).toBe(500);
    for (const c of spy.mock.calls) expect(JSON.stringify(c)).not.toContain(token);
    spy.mockRestore();
  });
});

describe('profile', () => {
  it('updates the display name', async () => {
    const { j } = await signIn();
    const res = await call('/api/v1/me', { method: 'PATCH', body: { displayName: '  Mei  ' }, jar: j });
    expect(res.status).toBe(200);
    expect((await read(res)).user.displayName).toBe('Mei');
  });
});

describe('logging', () => {
  it('never logs emails, codes, IPs or tokens', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    world.rpc.account_kind = () => new Response('{"message":"mei@example.com broke"}', { status: 500 });
    world.rpc.get_session_profile = () => new Response('{}', { status: 500 });
    await start('mei@example.com');
    await call('/api/v1/auth/email/verify', { body: { email: 'mei@example.com', code: '123456' } });
    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('mei@example.com');
    expect(logged).not.toContain('123456');
    expect(logged).not.toContain('203.0.113.7');
    expect(logged).not.toMatch(/eyJ|rt-/);
    expect(logged).toContain('rpc:account_kind 500');
  });

  it('origin constants line up with the app host', () => {
    expect(APP).toBe('https://zephyrapp.midnightpoetry.studio');
  });
});

describe('security review fixes (app)', () => {
  const verify = (body: Record<string, unknown>, ip?: string) =>
    call('/api/v1/auth/email/verify', { body: { email: 'mei@example.com', ...body }, ip });

  it('H1: 50 parallel wrong codes from 50 networks reach Auth at most 25 times', async () => {
    world.turnstile.action = 'email_verify';
    // Auth answers slowly, like a real round trip, so every request is in flight at once.
    const inner = globalThis.fetch;
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.endsWith('/auth/v1/verify')) return inner(input, init);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return inner(input, init);
    });
    const res = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        verify({ code: String(100000 + i), turnstileToken: 'tok' }, `2001:db8:${i.toString(16)}::1`),
      ),
    );
    const verifies = gotrueCalls('/verify').length;
    expect(verifies).toBeLessThanOrEqual(25);
    expect(maxInFlight).toBeGreaterThan(1); // they really were concurrent
    expect(res.filter((r) => r.status === 429)).toHaveLength(50 - verifies);
  });

  it('H1: without Turnstile tokens, only one attempt per address gets through', async () => {
    const res = await Promise.all(
      Array.from({ length: 20 }, (_, i) => verify({ code: String(100000 + i) }, `2001:db8:${i}::1`)),
    );
    expect(gotrueCalls('/verify')).toHaveLength(1);
    expect(res.filter((r) => r.status === 403)).toHaveLength(19);
  });

  it('M1: Turnstile is needed after the first attempt, and it must be the email_verify action', async () => {
    expect((await verify({ code: '000000' })).status).toBe(400);
    const second = await verify({ code: '123456' });
    expect(await read(second)).toEqual({ ok: false, error: 'verification_failed' });
    // email_start's token can't be replayed here.
    expect((await verify({ code: '123456', turnstileToken: 'tok' })).status).toBe(403);
    world.turnstile.action = 'email_verify';
    expect((await verify({ code: '123456', turnstileToken: 'tok' })).status).toBe(200);
  });

  it('M1: 5 attempts per address per network, then that network is locked out but others are not', async () => {
    world.turnstile.action = 'email_verify';
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await verify({ code: '000000', turnstileToken: 't' })).status);
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
    expect((await verify({ code: '123456', turnstileToken: 't' }, '198.51.100.9')).status).toBe(200);
  });

  it('M1: after the address cap is burnt, a new code unlocks it for the owner', async () => {
    world.turnstile.action = 'email_verify';
    for (let n = 0; n < 5; n++) {
      for (let i = 0; i < 5; i++) await verify({ code: '000000', turnstileToken: 't' }, `2001:db8:${n}::1`);
    }
    expect((await verify({ code: '123456', turnstileToken: 't' }, '198.51.100.9')).status).toBe(429);
    world.turnstile.action = 'email_start';
    expect((await start('mei@example.com')).status).toBe(202);
    world.turnstile.action = 'email_verify';
    expect((await verify({ code: '123456', turnstileToken: 't' }, '198.51.100.9')).status).toBe(200);
  });

  it('M1: an address gets at most 10 codes a day', async () => {
    for (let i = 0; i < 10; i++) {
      world.limits.forEach((_, k) => {
        if (!k.startsWith('email_start_day|')) world.limits.delete(k);
      });
      expect((await start('mei@example.com', {})).status).toBe(202);
    }
    world.limits.forEach((_, k) => {
      if (!k.startsWith('email_start_day|')) world.limits.delete(k);
    });
    expect((await start('mei@example.com')).status).toBe(429);
    expect(gotrueCalls('/otp')).toHaveLength(10);
  });

  it('M2: a request carrying a session cookie twice is refused and the cookies cleared', async () => {
    const { j } = await signIn();
    const at = must(j.cookies.get('__Host-zs-at'));
    const res = await call('/api/v1/auth/session', {
      headers: { Cookie: `__Host-zs-at=planted; __Host-zs-at=${at}` },
    });
    expect(res.status).toBe(401);
    const cleared = res.headers.getSetCookie();
    expect(cleared.map((c) => c.split('=')[0]).sort()).toEqual([
      '__Host-zads',
      '__Host-zs-at',
      '__Host-zs-rt',
    ]);
    for (const c of cleared) expect(c).toContain('Max-Age=0');
    // Writes too (sign-out with a planted refresh cookie).
    const out = await call('/api/v1/auth/sign-out', {
      body: {},
      headers: { Cookie: '__Host-zs-rt=a; __Host-zs-rt=b' },
    });
    expect(out.status).toBe(401);
  });

  it('L1: a passkey assertion from another origin or of the wrong type never reaches Auth', async () => {
    world.passkeyUser = MEI();
    for (const cred of [
      credential('webauthn.get', LANDING),
      credential('webauthn.create', APP),
      credential('webauthn.get', 'https://evil.midnightpoetry.studio'),
    ]) {
      const res = await call('/api/v1/auth/passkey/verify', {
        body: { challengeId: 'ch-auth', credential: cred },
      });
      expect(await read(res)).toEqual({ ok: false, error: 'passkey_failed' });
    }
    expect(gotrueCalls('/passkeys/authentication/verify')).toHaveLength(0);
  });

  it('L1: registering checks the ceremony type and the app origin', async () => {
    const { j } = await signIn();
    for (const cred of [credential('webauthn.get', APP), credential('webauthn.create', LANDING)]) {
      const res = await call('/api/v1/me/passkeys/verify', {
        body: { challengeId: 'ch-reg', credential: cred },
        jar: j,
      });
      expect(await read(res)).toEqual({ ok: false, error: 'passkey_failed' });
    }
    expect(gotrueCalls('/passkeys/registration/verify')).toHaveLength(0);
  });

  it('L2: asking to add or remove a passkey needs a sign-in in the last 10 minutes', async () => {
    const { j } = await signIn();
    j.cookies.set('__Host-zs-at', await sbToken({ sub: MEI().id, email: MEI().email, authAgo: 11 * 60 }));
    for (const body of [
      { op: 'passkey_add' },
      { op: 'passkey_remove', passkeyId: 'pk-0' },
      { op: 'account_delete' },
    ]) {
      const res = await call('/api/v1/me/account-actions', { body, jar: j });
      expect(res.status).toBe(403);
      expect(await read(res)).toEqual({ ok: false, error: 'reauth_required' });
    }
    // Renaming and listing don't need it.
    expect((await call('/api/v1/me/passkeys', { jar: j })).status).toBe(200);
    expect(gotrueCalls('/passkeys/registration')).toHaveLength(0);
    expect(world.emails).toHaveLength(0);
  });

  it('asking again doesn’t cancel a link already sent: up to three stay open, then the oldest goes', async () => {
    const { j } = await signIn();
    const first = await accountActionToken(j, 'account_delete');
    const second = await accountActionToken(j, 'account_delete');
    const third = await accountActionToken(j, 'account_delete');
    const peekOf = async (t: string) =>
      read(await call('/api/v1/me/account-actions/peek', { body: { token: t }, jar: j }));
    for (const t of [first, second, third]) expect((await peekOf(t)).op).toBe('account_delete');
    const fourth = await accountActionToken(j, 'account_delete');
    expect((await peekOf(first)).error).toBe('account_action_invalid');
    expect((await peekOf(second)).op).toBe('account_delete');
    expect((await peekOf(fourth)).op).toBe('account_delete');
  });

  it('L2: the account is emailed when a passkey is added or removed', async () => {
    const { j } = await signIn();
    const add = await accountActionToken(j, 'passkey_add');
    await call('/api/v1/me/passkeys/options', { body: {}, jar: j, headers: { [AH]: add } });
    await call('/api/v1/me/passkeys/verify', {
      body: { challengeId: 'ch-reg', credential: credential('webauthn.create', APP) },
      jar: j,
    });
    const remove = await accountActionToken(j, 'passkey_remove', 'pk-0');
    await call('/api/v1/me/passkeys/pk-0', {
      method: 'DELETE',
      jar: j,
      headers: { 'Content-Length': '0', [AH]: remove },
    });
    expect(world.emails.map((e) => [e.to, e.subject])).toEqual([
      ['mei@example.com', 'Add a passkey to your Zephyr account'],
      ['mei@example.com', 'A passkey was added to your Zephyr account'],
      ['mei@example.com', 'Remove a passkey from your Zephyr account'],
      ['mei@example.com', 'A passkey was removed from your Zephyr account'],
    ]);
    expect(world.emails[1]?.html).toContain('iCloud Keychain');
  });
});
