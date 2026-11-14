import { TEAM_API, type Team } from '@zephyr/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { teamInviteEmail } from '../src/email/team-templates';
import {
  billingLimiter,
  call,
  initKeys,
  installFetch,
  type Jar,
  jar,
  read,
  resetWorld,
  sbToken,
  teamInviteLimiter,
  type User,
  world,
} from './helpers';

/** Phase 7: Studio team routes (TEAM_API). */
const MEI: User = {
  id: '20000000-0000-0000-0000-000000000001',
  email: 'mei@example.com',
  displayName: 'Mei Lin',
};
const JUN: User = {
  id: '20000000-0000-0000-0000-000000000002',
  email: 'jun@example.com',
  displayName: 'Jun Hao',
};
const INVITE = '70000000-0000-4000-8000-000000000001';
const TOKEN = 'A'.repeat(43);

async function signedIn(u: User): Promise<Jar> {
  const j = jar();
  j.cookies.set('__Host-zs-at', await sbToken({ sub: u.id, email: u.email }));
  return j;
}
const rpcCalls = (fn: string) =>
  world.calls
    .filter((c) => c.url.endsWith(`/rest/v1/rpc/${fn}`))
    .map((c) => c.body as Record<string, unknown>);

const TEAM: Team = {
  name: 'Tan Studio',
  seats: 3,
  used: 2,
  members: [
    {
      userId: MEI.id,
      email: MEI.email,
      displayName: 'Mei Lin',
      role: 'owner',
      addedAt: '2026-11-01T00:00:00Z',
      suspended: false,
      liveGalleries: 0,
    },
    {
      userId: JUN.id,
      email: JUN.email,
      displayName: 'Jun Hao',
      role: 'editor',
      addedAt: '2026-11-02T00:00:00Z',
      suspended: false,
      liveGalleries: 0,
    },
  ],
  invites: [],
  available: true,
};

beforeAll(initKeys);
beforeEach(() => {
  resetWorld();
  installFetch();
  world.users = [{ ...MEI, passkeys: 1 }, JUN];
  world.rpc.team_get = () => TEAM;
  world.rpc.list_libraries = (a) => [
    {
      ownerId: String(a.p_member),
      name: 'Mine',
      role: 'owner',
      plan: 'free',
      state: 'active',
      initials: 'JH',
    },
  ];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('libraries', () => {
  it('lists the member’s libraries', async () => {
    const r = await call(TEAM_API.libraries, { jar: await signedIn(JUN) });
    expect(r.status).toBe(200);
    expect((await read(r)).libraries).toHaveLength(1);
    expect(rpcCalls('list_libraries')[0]).toEqual({ p_member: JUN.id });
  });

  it('leaves a team library (never one’s own)', async () => {
    world.rpc.team_leave = () => true;
    const j = await signedIn(JUN);
    expect((await call(TEAM_API.leave(MEI.id), { jar: j, method: 'DELETE' })).status).toBe(200);
    expect(rpcCalls('team_leave')[0]).toEqual({ p_member: JUN.id, p_owner: MEI.id });
    expect((await call(TEAM_API.leave(JUN.id), { jar: j, method: 'DELETE' })).status).toBe(404);
    expect((await call(TEAM_API.leave('nope'), { jar: j, method: 'DELETE' })).status).toBe(404);
  });

  it('needs a session and an allowed Origin', async () => {
    expect((await call(TEAM_API.libraries)).status).toBe(401);
    const r = await call(TEAM_API.leave(MEI.id), {
      jar: await signedIn(JUN),
      method: 'DELETE',
      origin: 'https://evil.test',
    });
    expect(r.status).toBe(403);
  });
});

describe('team (owner)', () => {
  it('always acts on the signed-in member’s own library, whatever library header is sent', async () => {
    const r = await call(TEAM_API.team, {
      jar: await signedIn(JUN),
      headers: { 'X-Zephyr-Library': MEI.id },
    });
    expect(r.status).toBe(200);
    expect(rpcCalls('team_get')[0]).toEqual({ p_owner: JUN.id });
  });

  it('invites by email, sends the email with the token in the fragment, and stores only the hash', async () => {
    world.rpc.team_invite_create = (a) => ({
      invite: { id: INVITE, email: a.p_email, role: a.p_role, expiresAt: '2026-11-21T00:00:00Z' },
      existingAccount: false,
    });
    const r = await call(TEAM_API.invites, {
      jar: await signedIn(MEI),
      body: { email: ' Aisha@Example.com ', role: 'viewer' },
    });
    expect(r.status).toBe(201);
    expect((await read(r)).team.name).toBe('Tan Studio');
    const args = rpcCalls('team_invite_create')[0];
    expect(args?.p_owner).toBe(MEI.id);
    expect(args?.p_email).toBe('aisha@example.com');
    expect(String(args?.p_token_hash)).toMatch(/^\\x[0-9a-f]{64}$/);
    expect(world.emails).toHaveLength(1);
    const mail = world.emails[0];
    expect(mail?.to).toBe('aisha@example.com');
    const link = mail?.text.match(/https:\/\/\S+\/team\/accept#token=([A-Za-z0-9_-]{43})/);
    expect(link).toBeTruthy();
    expect(mail?.text).toContain('Create my account');
    expect(mail?.subject).toContain('Tan Studio');
    // The raw token is never sent to the database.
    expect(JSON.stringify(world.calls.filter((c) => c.url.includes('/rpc/')))).not.toContain(link?.[1]);
    expect(billingLimiter.keys).toContain(`team:${MEI.id}`);
    expect(teamInviteLimiter.keys).toContain(`team-invite:${MEI.id}`);
  });

  it('maps the database refusals', async () => {
    const j = await signedIn(MEI);
    const cases: [string, number, string][] = [
      ['plan_required', 403, 'plan_required'],
      ['limit_reached', 409, 'limit_reached'],
      ['already_member', 409, 'already_member'],
    ];
    for (const [error, status, code] of cases) {
      world.rpc.team_invite_create = () => ({ error });
      const r = await call(TEAM_API.invites, {
        jar: j,
        body: { email: 'aisha@example.com', role: 'editor' },
      });
      expect(r.status).toBe(status);
      expect((await read(r)).error).toBe(code);
    }
    expect(world.emails).toHaveLength(0);
  });

  it('refuses the owner’s own address and bad bodies without a database call', async () => {
    const j = await signedIn(MEI);
    expect(
      (await call(TEAM_API.invites, { jar: j, body: { email: 'MEI@example.com', role: 'editor' } })).status,
    ).toBe(409);
    expect((await call(TEAM_API.invites, { jar: j, body: { email: 'x@y.z', role: 'owner' } })).status).toBe(
      400,
    );
    expect(rpcCalls('team_invite_create')).toHaveLength(0);
  });

  it('revokes the invite when the email can’t be sent', async () => {
    world.rpc.team_invite_create = (a) => ({
      invite: { id: INVITE, email: a.p_email, role: a.p_role, expiresAt: '2026-11-21T00:00:00Z' },
      existingAccount: true,
    });
    world.rpc.team_invite_revoke = () => true;
    world.resendStatus = 500;
    const r = await call(TEAM_API.invites, {
      jar: await signedIn(MEI),
      body: { email: 'jun@example.com', role: 'editor' },
    });
    expect(r.status).toBe(500);
    expect(rpcCalls('team_invite_revoke')[0]).toEqual({ p_owner: MEI.id, p_id: INVITE });
  });

  it('rate-limits invite sends', async () => {
    teamInviteLimiter.ok = false;
    const r = await call(TEAM_API.invites, {
      jar: await signedIn(MEI),
      body: { email: 'a@b.co', role: 'editor' },
    });
    expect(r.status).toBe(429);
  });

  it('resends with a new token, revokes, changes roles and removes members', async () => {
    const j = await signedIn(MEI);
    world.rpc.team_invite_resend = () => ({
      invite: { id: INVITE, email: 'aisha@example.com', role: 'viewer', expiresAt: '2026-11-21T00:00:00Z' },
      existingAccount: true,
    });
    expect((await call(TEAM_API.invite(INVITE), { jar: j, body: {} })).status).toBe(200);
    expect(world.emails[0]?.text).toContain('Join the team');
    world.rpc.team_invite_revoke = () => true;
    expect((await call(TEAM_API.invite(INVITE), { jar: j, method: 'DELETE' })).status).toBe(200);
    world.rpc.team_member_set_role = () => true;
    expect(
      (await call(TEAM_API.member(JUN.id), { jar: j, method: 'PATCH', body: { role: 'viewer' } })).status,
    ).toBe(200);
    expect(rpcCalls('team_member_set_role')[0]).toEqual({
      p_owner: MEI.id,
      p_member: JUN.id,
      p_role: 'viewer',
    });
    world.rpc.team_member_remove = () => true;
    expect((await call(TEAM_API.member(JUN.id), { jar: j, method: 'DELETE' })).status).toBe(200);
    // Not their own row, not an unknown id.
    expect((await call(TEAM_API.member(MEI.id), { jar: j, method: 'DELETE' })).status).toBe(404);
    world.rpc.team_member_remove = () => false;
    expect((await call(TEAM_API.member(JUN.id), { jar: j, method: 'DELETE' })).status).toBe(404);
    // Owner is never a role you can give.
    expect(
      (await call(TEAM_API.member(JUN.id), { jar: j, method: 'PATCH', body: { role: 'owner' } })).status,
    ).toBe(400);
  });

  it('renames the team', async () => {
    world.rpc.team_set_name = () => null;
    const r = await call(TEAM_API.team, {
      jar: await signedIn(MEI),
      method: 'PATCH',
      body: { name: ' Tan  Studio ' },
    });
    expect(r.status).toBe(200);
    expect(rpcCalls('team_set_name')[0]?.p_name).toBe('Tan  Studio');
  });
});

describe('invite links', () => {
  it('previews without a session and hides why a link is unusable', async () => {
    world.rpc.team_invite_preview = () => ({
      teamName: 'Tan Studio',
      ownerName: 'Mei Lin',
      role: 'editor',
      emailHint: 'j•••@example.com',
      needsAccount: true,
    });
    const r = await call(TEAM_API.invitePreview, { body: { token: TOKEN } });
    expect(r.status).toBe(200);
    expect((await read(r)).invite).toEqual({
      teamName: 'Tan Studio',
      ownerName: 'Mei Lin',
      role: 'editor',
      emailHint: 'j•••@example.com',
      needsAccount: true,
    });
    world.rpc.team_invite_preview = () => null;
    const bad = await call(TEAM_API.invitePreview, { body: { token: TOKEN } });
    expect(bad.status).toBe(404);
    expect((await read(bad)).error).toBe('invite_invalid');
    const malformed = await call(TEAM_API.invitePreview, { body: { token: 'short' } });
    expect(malformed.status).toBe(404);
  });

  it('accepts only for the signed-in email; a full team says so', async () => {
    world.rpc.team_invite_accept = (a) => (a.p_email === JUN.email ? { ownerId: MEI.id } : null);
    const ok = await call(TEAM_API.inviteAccept, { jar: await signedIn(JUN), body: { token: TOKEN } });
    expect(ok.status).toBe(200);
    expect(rpcCalls('team_invite_accept')[0]?.p_member).toBe(JUN.id);
    expect((await read(ok)).libraries).toBeTruthy();
    world.rpc.team_invite_accept = () => ({ error: 'limit_reached' });
    const full = await call(TEAM_API.inviteAccept, { jar: await signedIn(JUN), body: { token: TOKEN } });
    expect(full.status).toBe(409);
    world.rpc.team_invite_accept = () => ({ error: 'email_mismatch' });
    const wrong = await call(TEAM_API.inviteAccept, { jar: await signedIn(JUN), body: { token: TOKEN } });
    expect(wrong.status).toBe(404);
    expect((await call(TEAM_API.inviteAccept, { body: { token: TOKEN } })).status).toBe(401);
  });
});

describe('team invite email', () => {
  it('escapes names and keeps the token link intact', () => {
    const m = teamInviteEmail({
      teamName: '<b>Tan</b> Studio',
      inviterName: 'Mei "Lin"',
      role: 'viewer',
      link: 'https://zephyrapp.midnightpoetry.studio/team/accept#token=abc',
      expiresAt: '2026-11-21T00:00:00Z',
      needsAccount: false,
    });
    expect(m.html).not.toContain('<b>Tan</b>');
    expect(m.html).toContain('&lt;b&gt;Tan&lt;/b&gt;');
    expect(m.html).toContain('Mei &quot;Lin&quot;');
    expect(m.text).toContain('#token=abc');
    expect(m.text).toContain('browse and download');
    expect(m.html).toContain('21 November 2026');
  });
});
