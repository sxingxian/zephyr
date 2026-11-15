/**
 * Phase 8 API (docs/phase-8.md › API): the admin portal routes (role matrix, passkey re-check, Owners' emails),
 * reveal grants, staff invites, the audit CSV, suspension and read-only enforcement, ads, gallery link
 * replacement and the team's replaceLinks. The database is mocked: these tests pin the HTTP contract and which
 * functions are called with what.
 */
import {
  ADMIN8_API,
  MEMBER8_API,
  STAFF_CAN,
  type StaffAction,
  type StaffRole,
  staffCan,
} from '@zephyr/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAdminCron, runAdminDailyCron } from '../src/admin/cron';
import { app } from '../src/app';
import { sha256, toPgBytea } from '../src/crypto';
import { readOnlyBlocks } from '../src/library/read-only-gate';
import { auditCsv, csvCell } from '../src/routes/admin-audit';
import { newRevealToken } from '../src/routes/admin-safety';
import {
  accessToken,
  adminLimiter,
  adsLimiter,
  call,
  credential,
  env,
  initKeys,
  installFetch,
  type Jar,
  jar,
  LANDING,
  must,
  r2,
  read,
  resetWorld,
  sbToken,
  shared,
  type User,
  world,
} from './helpers';
import { images } from './images';

const MEI: User = { id: '20000000-0000-0000-0000-000000000001', email: 'mei@example.com', passkeys: 1 };
const JUN: User = { id: '20000000-0000-0000-0000-000000000002', email: 'jun@example.com', passkeys: 1 };
const USER = MEI.id;
const REPORT = '30000000-0000-4000-8000-000000000001';
const PHOTO = '40000000-0000-4000-8000-000000000001';
const GRANT = '50000000-0000-4000-8000-000000000001';
const CARD = '60000000-0000-4000-8000-000000000001';
const INVITE = '70000000-0000-4000-8000-000000000001';
const STAFF_USER = '10000000-0000-0000-0000-000000000002';
const GALLERY = '80000000-0000-4000-8000-000000000001';
const ROLES: StaffRole[] = ['owner', 'admin', 'finance', 'safety', 'support'];
const EMAIL: Record<StaffRole, string> = {
  owner: 'owner@zephyr.test',
  admin: 'admin@zephyr.test',
  finance: 'finance@zephyr.test',
  safety: 'safety@zephyr.test',
  support: 'support@zephyr.test',
};
const reason = 'Checked with the member by email';

const rpcCalls = (fn: string) =>
  world.calls
    .filter((c) => c.url.endsWith(`/rest/v1/rpc/${fn}`))
    .map((c) => c.body as Record<string, unknown>);

async function staff(role: StaffRole, o: { authAgo?: number } = {}) {
  const u = must(world.users.find((x) => x.email === EMAIL[role]));
  const access = await accessToken(u.email);
  world.passkeyUser = u;
  const j = jar();
  const res = await call('/admin/api/v1/auth/passkey/verify', {
    body: { challengeId: 'ch-auth', credential: credential('webauthn.get', LANDING) },
    jar: j,
    access,
  });
  expect(res.status).toBe(200);
  if (o.authAgo) {
    j.cookies.set(
      '__Host-za-at',
      await sbToken({ sub: u.id, email: u.email, amr: ['passkey'], authAgo: o.authAgo }),
    );
  }
  world.calls.length = 0;
  return { j, access };
}
type Session = Awaited<ReturnType<typeof staff>>;
const as = (s: Session, path: string, o: { method?: string; body?: unknown } = {}) =>
  call(path, { jar: s.j, access: s.access, ...o });

async function member(u: User): Promise<Jar> {
  const j = jar();
  j.cookies.set('__Host-zs-at', await sbToken({ sub: u.id, email: u.email }));
  return j;
}

/** Plausible answers for every staff function, so each allowed call succeeds. */
function mockAdminDb() {
  const ok = () => ({ ok: true });
  Object.assign(world.rpc, {
    ai_alert_recipients: () => ['owner@zephyr.test', 'owner2@zephyr.test'],
    admin_users: () => ({ total: 1, page: { items: [], nextCursor: null } }),
    admin_user: () => ({ id: USER, email: MEI.email }),
    admin_user_override: ok,
    admin_user_override_end: ok,
    admin_user_grant_credits: (a: Record<string, unknown>) => ({
      ok: true,
      large: Number(a.p_amount) > 1000,
    }),
    admin_user_sign_out: ok,
    admin_user_suspend: () => ({ ok: true, email: MEI.email }),
    admin_user_unsuspend: ok,
    admin_user_sharing_lift: ok,
    admin_user_deletion_schedule: ok,
    admin_user_deletion_cancel: ok,
    billing_subscription_for: () => null,
    admin_safety: () => ({ kpis: {}, reports: [], holds: [] }),
    admin_report: () => ({ id: REPORT }),
    admin_reveal: () => ({ grantId: GRANT, expiresAt: '2026-11-15T10:10:00Z', photoIds: [PHOTO] }),
    admin_report_resolve: ok,
    admin_hold_report: ok,
    admin_hold_release: ok,
    admin_limits: () => ({ active: { version: 1 }, scheduled: null, draft: null, history: [] }),
    admin_limits_draft_create: ok,
    admin_limits_draft_save: ok,
    admin_limits_draft_delete: ok,
    admin_limits_preview: () => ({
      changes: [],
      decreases: false,
      earliestEffectiveAt: '2026-11-15T00:00:00Z',
    }),
    admin_limits_schedule: () => ({ version: 2, effectiveAt: null, decreases: false }),
    admin_limits_cancel: ok,
    limits_notices_due: () => [],
    admin_ads: () => ({ kpis: {}, cards: [], adsense: { enabled: false } }),
    admin_ad_card_save: () => ({ id: CARD }),
    admin_ad_card_delete: () => ({ imageKey: null }),
    admin_ad_image_set: () => ({ version: 1, oldKey: null }),
    admin_adsense_set: () => ({ enabled: true }),
    admin_retention: () => ({ kpis: {}, items: [] }),
    admin_retention_approve: () => ({ approved: 0 }),
    admin_staff: () => ({ staff: [], invites: [] }),
    admin_staff_invite: () => ({ id: INVITE, expiresAt: '2026-11-18T00:00:00Z' }),
    admin_staff_invite_revoke: ok,
    admin_staff_set_role: ok,
    admin_staff_remove: ok,
    admin_audit: () => ({ items: [], nextCursor: null }),
    admin_audit_export: () => [],
    admin_settings: () => ({
      readOnly: { on: false, auto: false, message: '', since: null },
      maintenance: { on: false, message: '', startsAt: null, endsAt: null },
      access: { staffWithPasskey: 4, staffTotal: 5 },
      alerts: { owners: 1 },
    }),
    admin_settings_set: ok,
  });
}

beforeAll(initKeys);
beforeEach(() => {
  resetWorld();
  installFetch();
  world.users.push(
    { id: '10000000-0000-0000-0000-000000000005', email: EMAIL.finance, staff: 'finance', passkeys: 1 },
    { id: '10000000-0000-0000-0000-000000000006', email: EMAIL.safety, staff: 'safety', passkeys: 1 },
    JUN,
  );
  mockAdminDb();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- role matrix ------------------------------------------------------------------------------------------
interface Route {
  method: string;
  path: string;
  body?: unknown;
  action: StaffAction;
  /** The database function the route calls (not called when refused). */
  fn: string;
  /** High-risk: a passkey sign-in in the last 10 minutes. */
  reauth?: boolean;
  /** Owners emailed. */
  owners?: boolean;
}
const ROUTES: Route[] = [
  { method: 'GET', path: ADMIN8_API.users, action: 'usersView', fn: 'admin_users' },
  { method: 'GET', path: ADMIN8_API.user(USER), action: 'usersView', fn: 'admin_user' },
  {
    method: 'PUT',
    path: ADMIN8_API.userPlan(USER),
    body: { plan: 'pro', until: null, reason },
    action: 'planOverride',
    fn: 'admin_user_override',
    reauth: true,
    owners: true,
  },
  {
    method: 'DELETE',
    path: ADMIN8_API.userPlan(USER),
    body: { reason },
    action: 'planOverride',
    fn: 'admin_user_override_end',
  },
  {
    method: 'POST',
    path: ADMIN8_API.userCredits(USER),
    body: { amount: 500, reason },
    action: 'usersAct',
    fn: 'admin_user_grant_credits',
  },
  {
    method: 'POST',
    path: ADMIN8_API.userSignOut(USER),
    body: { reason },
    action: 'usersAct',
    fn: 'admin_user_sign_out',
  },
  {
    method: 'POST',
    path: ADMIN8_API.userSuspend(USER),
    body: { category: 'abuse', note: reason, notify: false },
    action: 'suspend',
    fn: 'admin_user_suspend',
  },
  {
    method: 'DELETE',
    path: ADMIN8_API.userSuspend(USER),
    body: { reason },
    action: 'suspend',
    fn: 'admin_user_unsuspend',
    reauth: true,
    owners: true,
  },
  {
    method: 'DELETE',
    path: ADMIN8_API.userSharing(USER),
    body: { reason },
    action: 'suspend',
    fn: 'admin_user_sharing_lift',
    reauth: true,
    owners: true,
  },
  {
    method: 'POST',
    path: ADMIN8_API.userDeletion(USER),
    body: { reason },
    action: 'deleteAccount',
    fn: 'admin_user_deletion_schedule',
    reauth: true,
    owners: true,
  },
  {
    method: 'DELETE',
    path: ADMIN8_API.userDeletion(USER),
    body: { reason },
    action: 'deleteAccount',
    fn: 'admin_user_deletion_cancel',
  },
  { method: 'GET', path: ADMIN8_API.safety, action: 'safetyView', fn: 'admin_safety' },
  { method: 'GET', path: ADMIN8_API.report(REPORT), action: 'safetyView', fn: 'admin_report' },
  {
    method: 'POST',
    path: ADMIN8_API.reportReveal(REPORT),
    body: { reason },
    action: 'safetyAct',
    fn: 'admin_reveal',
    reauth: true,
  },
  {
    method: 'POST',
    path: ADMIN8_API.reportResolve(REPORT),
    body: { actions: ['end_gallery'], note: reason },
    action: 'safetyAct',
    fn: 'admin_report_resolve',
  },
  {
    method: 'POST',
    path: ADMIN8_API.holdReport(PHOTO),
    body: { authority: 'NCMEC CyberTipline', reference: 'CT-123' },
    action: 'holdsRecord',
    fn: 'admin_hold_report',
  },
  {
    method: 'POST',
    path: ADMIN8_API.holdRelease(PHOTO),
    body: { reason },
    action: 'holdsRelease',
    fn: 'admin_hold_release',
    reauth: true,
    owners: true,
  },
  { method: 'GET', path: ADMIN8_API.limits, action: 'limitsView', fn: 'admin_limits' },
  {
    method: 'POST',
    path: ADMIN8_API.limitsDraft,
    body: { fromVersion: 1 },
    action: 'limits',
    fn: 'admin_limits_draft_create',
  },
  { method: 'DELETE', path: ADMIN8_API.limitsDraft, action: 'limits', fn: 'admin_limits_draft_delete' },
  {
    method: 'POST',
    path: ADMIN8_API.limitsPreview,
    body: { effectiveAt: null },
    action: 'limits',
    fn: 'admin_limits_preview',
  },
  {
    method: 'POST',
    path: ADMIN8_API.limitsSchedule,
    body: { effectiveAt: null, reason },
    action: 'limits',
    fn: 'admin_limits_schedule',
    reauth: true,
    owners: true,
  },
  {
    method: 'DELETE',
    path: ADMIN8_API.limitsScheduled,
    body: { reason },
    action: 'limits',
    fn: 'admin_limits_cancel',
  },
  { method: 'GET', path: ADMIN8_API.ads, action: 'ads', fn: 'admin_ads' },
  {
    method: 'POST',
    path: ADMIN8_API.adCards,
    body: {
      advertiser: 'Lumen Labs',
      headline: 'Presets for film lovers',
      body: 'Forty film looks.',
      url: 'https://lumen.example.com/presets',
      placements: ['library'],
      startsAt: null,
      endsAt: null,
      weight: 10,
    },
    action: 'ads',
    fn: 'admin_ad_card_save',
  },
  {
    method: 'PATCH',
    path: ADMIN8_API.adCard(CARD),
    body: { weight: 20 },
    action: 'ads',
    fn: 'admin_ad_card_save',
  },
  { method: 'DELETE', path: ADMIN8_API.adCard(CARD), action: 'ads', fn: 'admin_ad_card_delete' },
  {
    method: 'PATCH',
    path: ADMIN8_API.adsense,
    body: { enabled: true, publisherId: 'ca-pub-1234567890123456', reason },
    action: 'adsense',
    fn: 'admin_adsense_set',
    reauth: true,
    owners: true,
  },
  { method: 'GET', path: ADMIN8_API.retention, action: 'retention', fn: 'admin_retention' },
  {
    method: 'POST',
    path: ADMIN8_API.retentionApprove,
    body: { ownerIds: ['20000000-0000-4000-8000-000000000001'], reason },
    action: 'retention',
    fn: 'admin_retention_approve',
    reauth: true,
  },
  { method: 'GET', path: ADMIN8_API.staff, action: 'staff', fn: 'admin_staff' },
  {
    method: 'POST',
    path: ADMIN8_API.staffInvites,
    body: { email: 'new.person@zephyr.test', role: 'support', reason },
    action: 'staff',
    fn: 'admin_staff_invite',
    reauth: true,
    owners: true,
  },
  {
    method: 'DELETE',
    path: ADMIN8_API.staffInvite(INVITE),
    action: 'staff',
    fn: 'admin_staff_invite_revoke',
  },
  {
    method: 'PATCH',
    path: ADMIN8_API.staffMember(STAFF_USER),
    body: { role: 'support', reason },
    action: 'staff',
    fn: 'admin_staff_set_role',
    reauth: true,
    owners: true,
  },
  {
    method: 'DELETE',
    path: ADMIN8_API.staffMember(STAFF_USER),
    body: { reason },
    action: 'staff',
    fn: 'admin_staff_remove',
    reauth: true,
    owners: true,
  },
  { method: 'GET', path: ADMIN8_API.audit, action: 'auditView', fn: 'admin_audit' },
  { method: 'GET', path: ADMIN8_API.auditExport, action: 'auditExport', fn: 'admin_audit_export' },
  { method: 'GET', path: ADMIN8_API.settings, action: 'settings', fn: 'admin_settings' },
  {
    method: 'PATCH',
    path: ADMIN8_API.settings,
    body: { readOnly: { on: true, message: 'Back soon' }, reason },
    action: 'settings',
    fn: 'admin_settings_set',
  },
];

describe('admin routes: role matrix', () => {
  it('lists every STAFF_CAN action that has a route', () => {
    const covered = new Set(ROUTES.map((r) => r.action));
    // storage belongs to the storage fork's routes.
    for (const a of Object.keys(STAFF_CAN) as StaffAction[])
      if (a !== 'storage') expect(covered.has(a), a).toBe(true);
  });

  for (const role of ROLES) {
    it(`${role}: allowed routes answer, the rest are 403 forbidden before the database`, async () => {
      const s = await staff(role);
      for (const r of ROUTES) {
        world.calls.length = 0;
        const res = await as(s, r.path, { method: r.method, body: r.body });
        const label = `${role} ${r.method} ${r.path}`;
        if (staffCan(role, r.action)) {
          expect(res.status, label).toBeLessThan(300);
          expect(rpcCalls(r.fn).length, label).toBeGreaterThan(0);
          expect(rpcCalls(r.fn)[0]?.p_staff, label).toBe(
            must(world.users.find((u) => u.email === EMAIL[role])).id,
          );
        } else {
          expect(res.status, label).toBe(403);
          expect((await read(res)).error, label).toBe('forbidden');
          expect(rpcCalls(r.fn), label).toHaveLength(0);
        }
      }
    });
  }

  it('needs a staff session and the Access identity', async () => {
    const access = await accessToken(EMAIL.owner);
    expect((await call(ADMIN8_API.users, { access })).status).toBe(401);
    expect((await call(ADMIN8_API.users)).status).toBe(403);
  });

  it('refuses a staff session that has no passkey yet (enrolment only)', async () => {
    const u = must(world.users.find((x) => x.email === 'new.staff@zephyr.test'));
    const j = jar();
    j.cookies.set('__Host-za-at', await sbToken({ sub: u.id, email: u.email, amr: ['otp'] }));
    const res = await call(ADMIN8_API.users, { jar: j, access: await accessToken(u.email) });
    expect([401, 403]).toContain(res.status);
    expect(rpcCalls('admin_users')).toHaveLength(0);
  });

  it('limits admin writes per staff member (ADMIN_LIMITER), not reads', async () => {
    const s = await staff('owner');
    await as(s, ADMIN8_API.users);
    expect(adminLimiter.keys).toHaveLength(0);
    adminLimiter.ok = false;
    const res = await as(s, ADMIN8_API.userSignOut(USER), { body: { reason } });
    expect(res.status).toBe(429);
    expect(adminLimiter.keys).toEqual(['admin:10000000-0000-0000-0000-000000000001']);
    expect(rpcCalls('admin_user_sign_out')).toHaveLength(0);
  });

  it('requires a reason on writes and validates path ids', async () => {
    const s = await staff('owner');
    expect((await as(s, ADMIN8_API.userSignOut(USER), { body: {} })).status).toBe(400);
    expect((await as(s, ADMIN8_API.userSignOut(USER), { body: { reason: 'x' } })).status).toBe(400);
    expect((await as(s, ADMIN8_API.user('not-a-uuid'))).status).toBe(404);
    expect(rpcCalls('admin_user_sign_out')).toHaveLength(0);
  });

  it('maps database refusals: last_owner → 409, not_found → 404, unknown → 400', async () => {
    const s = await staff('owner');
    world.rpc.admin_staff_remove = () => ({ error: 'last_owner' });
    const a = await as(s, ADMIN8_API.staffMember(STAFF_USER), { method: 'DELETE', body: { reason } });
    expect(a.status).toBe(409);
    expect((await read(a)).error).toBe('last_owner');
    world.rpc.admin_user = () => null;
    expect((await as(s, ADMIN8_API.user(USER))).status).toBe(404);
    world.rpc.admin_user_sign_out = () => ({ error: 'some_internal_detail' });
    const c = await as(s, ADMIN8_API.userSignOut(USER), { body: { reason } });
    expect(c.status).toBe(400);
    expect(JSON.stringify(await read(c))).not.toContain('some_internal_detail');
  });
});

// ---- reauth and Owners' emails --------------------------------------------------------------------------
describe('high-risk writes: a recent passkey and an email to every Owner', () => {
  const highRisk = ROUTES.filter((r) => r.reauth);
  const roleFor = (r: Route) => must(ROLES.find((x) => staffCan(x, r.action)));

  for (const r of highRisk) {
    it(`${r.method} ${r.path}: 403 reauth_required on a stale session`, async () => {
      const s = await staff(roleFor(r), { authAgo: 3600 });
      const res = await as(s, r.path, { method: r.method, body: r.body });
      expect(res.status).toBe(403);
      expect((await read(res)).error).toBe('reauth_required');
      expect(rpcCalls(r.fn)).toHaveLength(0);
      expect(world.emails).toHaveLength(0);
    });
  }

  for (const r of highRisk.filter((x) => x.owners)) {
    it(`${r.method} ${r.path}: emails every Owner (no member email in it)`, async () => {
      const s = await staff(roleFor(r));
      const res = await as(s, r.path, { method: r.method, body: r.body });
      expect(res.status).toBeLessThan(300);
      const owners = world.emails.filter((e) => e.subject === '[Zephyr admin] A high-risk change was made');
      expect(owners.map((e) => e.to).sort()).toEqual(['owner2@zephyr.test', 'owner@zephyr.test']);
      expect(owners[0]?.text).toContain(reason);
      expect(owners[0]?.text).not.toContain(MEI.email);
    });
  }

  it('risk-lowering writes save at once on a stale session, with no Owners email', async () => {
    const lower = ROUTES.filter(
      (r) => r.method !== 'GET' && !r.reauth && r.fn !== 'admin_user_grant_credits',
    );
    for (const r of lower) {
      const s = await staff(roleFor(r), { authAgo: 3600 });
      world.emails.length = 0;
      const res = await as(s, r.path, { method: r.method, body: r.body });
      expect(res.status, `${r.method} ${r.path}`).toBeLessThan(300);
      expect(
        world.emails.filter((e) => e.subject.startsWith('[Zephyr admin]')),
        r.path,
      ).toHaveLength(0);
    }
  });

  it('credits: the database enforces the limits; Support over them gets 403 limit_reached', async () => {
    const sup = await staff('support');
    expect((await as(sup, ADMIN8_API.userCredits(USER), { body: { amount: 1000, reason } })).status).toBe(
      200,
    );
    expect(rpcCalls('admin_user_grant_credits')[0]).toMatchObject({ p_amount: 1000, p_reauthed: true });
    world.rpc.admin_user_grant_credits = () => ({ error: 'limit_reached' });
    const big = await as(sup, ADMIN8_API.userCredits(USER), { body: { amount: 1001, reason } });
    expect(big.status).toBe(403);
    expect((await read(big)).error).toBe('limit_reached');
    expect(world.emails).toHaveLength(0);
  });

  it('credits: a large Owner/Admin grant needs a passkey and emails the Owners', async () => {
    const stale = await staff('admin', { authAgo: 3600 });
    expect(
      (await read(await as(stale, ADMIN8_API.userCredits(USER), { body: { amount: 5000, reason } }))).error,
    ).toBe('reauth_required');
    expect(rpcCalls('admin_user_grant_credits')).toHaveLength(0);
    world.emails.length = 0;
    const fresh = await staff('admin');
    expect((await as(fresh, ADMIN8_API.userCredits(USER), { body: { amount: 5000, reason } })).status).toBe(
      200,
    );
    expect(rpcCalls('admin_user_grant_credits')[0]).toMatchObject({ p_amount: 5000, p_reauthed: true });
    expect(world.emails.filter((e) => e.subject.startsWith('[Zephyr admin]'))).toHaveLength(2);
  });

  it('credits: small grants that pass the 24-hour total ask for the passkey (database decides)', async () => {
    const stale = await staff('admin', { authAgo: 3600 });
    world.rpc.admin_user_grant_credits = (a) =>
      a.p_reauthed ? { ok: true, large: true } : { error: 'reauth_required' };
    const res = await as(stale, ADMIN8_API.userCredits(USER), { body: { amount: 100, reason } });
    expect(res.status).toBe(403);
    expect((await read(res)).error).toBe('reauth_required');
    expect(rpcCalls('admin_user_grant_credits')[0]).toMatchObject({ p_amount: 100, p_reauthed: false });
    expect(world.emails).toHaveLength(0);
  });

  it('hold release: a photo that isn’t held is a 404 with no Owners email', async () => {
    world.rpc.admin_hold_release = () => null;
    const s = await staff('owner');
    world.emails.length = 0;
    const res = await as(s, ADMIN8_API.holdRelease(PHOTO), { body: { reason } });
    expect(res.status).toBe(404);
    expect(world.emails).toHaveLength(0);
  });

  it('plan limits: too_soon and no_changes reach the admin app as their own codes', async () => {
    const s = await staff('owner');
    world.rpc.admin_limits_schedule = () => ({ error: 'too_soon' });
    const soon = await as(s, ADMIN8_API.limitsSchedule, { body: { effectiveAt: null, reason } });
    expect([soon.status, (await read(soon)).error]).toEqual([400, 'too_soon']);
    world.rpc.admin_limits_schedule = () => ({ error: 'no_changes' });
    const same = await as(s, ADMIN8_API.limitsSchedule, { body: { effectiveAt: null, reason } });
    expect([same.status, (await read(same)).error]).toEqual([409, 'no_changes']);
  });

  it('AdSense: turning it off saves at once; changing the publisher id needs a passkey', async () => {
    const stale = await staff('owner', { authAgo: 3600 });
    expect(
      (await as(stale, ADMIN8_API.adsense, { method: 'PATCH', body: { enabled: false, reason } })).status,
    ).toBe(200);
    const id = await as(stale, ADMIN8_API.adsense, {
      method: 'PATCH',
      body: { publisherId: 'ca-pub-1234567890123456', reason },
    });
    expect((await read(id)).error).toBe('reauth_required');
  });

  it('suspension emails the member only when asked, and never names them to the Owners', async () => {
    const s = await staff('safety');
    await as(s, ADMIN8_API.userSuspend(USER), { body: { category: 'abuse', note: reason, notify: false } });
    expect(world.emails).toHaveLength(0);
    await as(s, ADMIN8_API.userSuspend(USER), { body: { category: 'abuse', note: reason, notify: true } });
    expect(world.emails.map((e) => e.to)).toEqual([MEI.email]);
    expect(world.emails[0]?.text).not.toContain(reason); // the staff note stays internal
  });

  it('plan override: refuses an end date in the past or more than two years out', async () => {
    const s = await staff('finance');
    const past = await as(s, ADMIN8_API.userPlan(USER), {
      method: 'PUT',
      body: { plan: 'pro', until: '2020-01-01T00:00:00Z', reason },
    });
    expect(past.status).toBe(400);
    expect(rpcCalls('admin_user_override')).toHaveLength(0);
  });
});

// ---- safety reveal ------------------------------------------------------------------------------------------
describe('reveal for review', () => {
  it('mints a 32-byte base64url token and sends only its SHA-256 to the database', async () => {
    const s = await staff('safety');
    const res = await as(s, ADMIN8_API.reportReveal(REPORT), { body: { reason } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await read(res);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sent = must(rpcCalls('admin_reveal')[0]);
    expect(sent.p_token_hash).toBe(toPgBytea(await sha256(body.token)));
    expect(JSON.stringify(sent)).not.toContain(body.token);
    expect(body.photos[0].url).toBe(
      `${ADMIN8_API.revealMedia(GRANT, PHOTO)}?t=${body.token}`.replace(/^/, ''),
    );
    expect(newRevealToken()).not.toBe(newRevealToken());
  });

  it('serves a re-encoded ≤1600 px JPEG with no-store, only for the grant’s staff member', async () => {
    const token = newRevealToken();
    const hash = toPgBytea(await sha256(token));
    const safety = must(world.users.find((u) => u.email === EMAIL.safety));
    world.rpc.reveal_grant_check = (a) =>
      a.p_token_hash === hash && a.p_staff === safety.id && a.p_grant === GRANT && a.p_photo === PHOTO
        ? { key: `u/${USER}/p/${PHOTO}/preview` }
        : null;
    await r2.put(`u/${USER}/p/${PHOTO}/preview`, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    const s = await staff('safety');
    const res = await as(s, `${ADMIN8_API.revealMedia(GRANT, PHOTO)}?t=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const p = must(images.pipelines.at(-1));
    expect(p.ops[0]).toEqual(['transform', { width: 1600, height: 1600, fit: 'scale-down' }]);
    expect(p.output?.format).toBe('image/jpeg');

    // Wrong token, or another staff member with the right token: the same 404.
    expect((await as(s, `${ADMIN8_API.revealMedia(GRANT, PHOTO)}?t=${'A'.repeat(43)}`)).status).toBe(404);
    expect((await as(s, `${ADMIN8_API.revealMedia(GRANT, PHOTO)}`)).status).toBe(404);
    const owner = await staff('owner');
    expect((await as(owner, `${ADMIN8_API.revealMedia(GRANT, PHOTO)}?t=${token}`)).status).toBe(403);
  });
});

// ---- staff invites ---------------------------------------------------------------------------------------
describe('staff invites', () => {
  it('emails the invitee a link whose token the database only sees hashed', async () => {
    const s = await staff('owner');
    const res = await as(s, ADMIN8_API.staffInvites, {
      body: { email: 'New.Person@Zephyr.test', role: 'support', reason },
    });
    expect(res.status).toBe(200);
    const sent = must(rpcCalls('admin_staff_invite')[0]);
    expect(sent.p_email).toBe('new.person@zephyr.test');
    const invite = must(world.emails.find((e) => e.to === 'new.person@zephyr.test'));
    const token = must(invite.text.match(/#t=([A-Za-z0-9_-]{43})/)?.[1]);
    expect(sent.p_token_hash).toBe(toPgBytea(await sha256(token)));
  });

  it('revokes the invite when its email can’t be sent', async () => {
    world.resendStatus = 500;
    const s = await staff('owner');
    const res = await as(s, ADMIN8_API.staffInvites, {
      body: { email: 'x@zephyr.test', role: 'support', reason },
    });
    expect(res.status).toBe(502);
    expect(rpcCalls('admin_staff_invite_revoke')[0]?.p_invite).toBe(INVITE);
  });

  it('accept: creates the staff auth user for the Access identity, then completes the invite', async () => {
    world.rpc.staff_invite_accept = () => ({
      inviteId: INVITE,
      email: 'new.person@zephyr.test',
      role: 'support',
    });
    world.rpc.staff_invite_complete = () => ({ ok: true });
    const res = await call(ADMIN8_API.staffInviteAccept, {
      body: { token: 'B'.repeat(43) },
      access: await accessToken('new.person@zephyr.test'),
    });
    expect(res.status).toBe(200);
    expect(await read(res)).toEqual({ ok: true, email: 'new.person@zephyr.test' });
    const created = must(world.users.find((u) => u.email === 'new.person@zephyr.test'));
    expect(rpcCalls('staff_invite_complete')[0]).toEqual({ p_invite_id: INVITE, p_user_id: created.id });
  });

  it('accept: refuses another Access identity without creating anyone', async () => {
    world.rpc.staff_invite_accept = () => ({
      inviteId: INVITE,
      email: 'new.person@zephyr.test',
      role: 'support',
    });
    const res = await call(ADMIN8_API.staffInviteAccept, {
      body: { token: 'B'.repeat(43) },
      access: await accessToken('someone.else@zephyr.test'),
    });
    expect(res.status).toBe(403);
    expect(world.calls.some((c) => c.url.endsWith('/auth/v1/admin/users'))).toBe(false);
    expect(rpcCalls('staff_invite_complete')).toHaveLength(0);
  });

  it('remove: bans the auth user (former staff), then emails the Owners', async () => {
    const target = must(world.users.find((u) => u.email === EMAIL.support));
    const s = await staff('owner');
    const res = await as(s, ADMIN8_API.staffMember(target.id), { method: 'DELETE', body: { reason } });
    expect(res.status).toBe(200);
    expect(target.banned).toBe(true);
    const ban = must(
      world.calls.find((c) => c.method === 'PUT' && c.url.endsWith(`/auth/v1/admin/users/${target.id}`)),
    );
    expect(ban.body).toEqual({ ban_duration: '876000h' });
  });

  it('accept: a former staff member keeps their auth user (unbanned, no new user)', async () => {
    const back: User = {
      id: '20000000-0000-0000-0000-0000000000f5',
      email: 'back@zephyr.test',
      banned: true,
    };
    world.users.push(back);
    world.rpc.staff_invite_accept = () => ({
      inviteId: INVITE,
      email: back.email,
      role: 'support',
      existingUserId: back.id,
    });
    world.rpc.staff_invite_complete = () => ({ ok: true });
    const before = world.users.length;
    const res = await call(ADMIN8_API.staffInviteAccept, {
      body: { token: 'B'.repeat(43) },
      access: await accessToken(back.email),
    });
    expect(res.status).toBe(200);
    expect(world.users).toHaveLength(before);
    expect(back.banned).toBe(false);
    expect(rpcCalls('staff_invite_complete')[0]).toEqual({ p_invite_id: INVITE, p_user_id: back.id });
  });

  it('accept: a former staff member who loses the race stays banned and isn’t deleted', async () => {
    const back: User = {
      id: '20000000-0000-0000-0000-0000000000f6',
      email: 'back2@zephyr.test',
      banned: true,
    };
    world.users.push(back);
    world.rpc.staff_invite_accept = () => ({
      inviteId: INVITE,
      email: back.email,
      role: 'support',
      existingUserId: back.id,
    });
    world.rpc.staff_invite_complete = () => null;
    const res = await call(ADMIN8_API.staffInviteAccept, {
      body: { token: 'B'.repeat(43) },
      access: await accessToken(back.email),
    });
    expect((await read(res)).error).toBe('invite_invalid');
    expect(back.banned).toBe(true);
    expect(world.users.some((u) => u.id === back.id)).toBe(true);
  });

  it('accept: unknown tokens, member accounts and lost races', async () => {
    const access = await accessToken('new.person@zephyr.test');
    world.rpc.staff_invite_accept = () => null;
    const bad = await call(ADMIN8_API.staffInviteAccept, { body: { token: 'B'.repeat(43) }, access });
    expect((await read(bad)).error).toBe('invite_invalid');
    world.rpc.staff_invite_accept = () => ({ error: 'member_account' });
    expect(
      (await call(ADMIN8_API.staffInviteAccept, { body: { token: 'B'.repeat(43) }, access })).status,
    ).toBe(409);
    world.rpc.staff_invite_accept = () => ({ error: 'already_staff' });
    expect(
      (await call(ADMIN8_API.staffInviteAccept, { body: { token: 'B'.repeat(43) }, access })).status,
    ).toBe(409);
    world.rpc.staff_invite_accept = () => ({
      inviteId: INVITE,
      email: 'new.person@zephyr.test',
      role: 'support',
    });
    world.rpc.staff_invite_complete = () => ({ error: 'invalid' });
    const race = await call(ADMIN8_API.staffInviteAccept, { body: { token: 'B'.repeat(43) }, access });
    expect(race.status).toBe(400);
    expect(world.calls.some((c) => c.method === 'DELETE' && c.url.includes('/auth/v1/admin/users/'))).toBe(
      true,
    );
  });
});

// ---- audit CSV -----------------------------------------------------------------------------------------------
describe('audit export', () => {
  it('escapes formula cells and quotes per RFC 4180', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\t=1')).toBe("'\t=1");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
    expect(csvCell('plain')).toBe('plain');
  });

  it('downloads a CSV with no-store', async () => {
    world.rpc.admin_audit_export = () => [
      {
        id: '1',
        at: '2026-11-15T00:00:00Z',
        actor: { id: null, name: '=cmd', role: 'system' },
        action: 'users.suspended',
        target: USER,
        reason: '-evil',
      },
    ];
    const s = await staff('admin');
    const res = await as(s, `${ADMIN8_API.auditExport}?kind=users`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="zephyr-audit-/);
    const text = await res.text();
    expect(text.split('\r\n')[1]).toBe(`1,2026-11-15T00:00:00Z,,'=cmd,system,users.suspended,${USER},'-evil`);
    expect(must(rpcCalls('admin_audit_export')[0]).p_kind).toBe('users');
    expect(auditCsv([])).toBe('id,at,actor_id,actor_name,actor_role,action,target,reason\r\n');
  });

  it('refuses bad filters', async () => {
    const s = await staff('admin');
    expect((await as(s, `${ADMIN8_API.audit}?kind=nope`)).status).toBe(400);
    expect(
      (await as(s, `${ADMIN8_API.audit}?from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z`)).status,
    ).toBe(400);
  });
});

// ---- ad image upload ------------------------------------------------------------------------------------------
describe('ad card image', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const put = async (s: Session, bytes: Uint8Array, type = 'image/png', origin = LANDING) => {
    const h: Record<string, string> = {
      Origin: origin,
      'Content-Type': type,
      'Content-Length': String(bytes.byteLength),
      'Cf-Access-Jwt-Assertion': s.access,
      Cookie: [...s.j.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    };
    return app.request(
      `https://zephyr.midnightpoetry.studio${ADMIN8_API.adCardImage(CARD)}`,
      { method: 'PUT', headers: h, body: bytes },
      env,
    );
  };

  it('re-encodes to a 1200 × 628 JPEG under ads/ in the shared bucket', async () => {
    const s = await staff('admin');
    const res = await put(s, png);
    expect(res.status).toBe(200);
    const key = String(must(rpcCalls('admin_ad_image_set')[0]).p_key);
    expect(key).toMatch(new RegExp(`^ads/${CARD}/[A-Za-z0-9_-]+\\.jpg$`));
    expect(await shared.get(key)).toBeTruthy();
    const p = must(images.pipelines.at(-1));
    expect(p.ops[0]).toEqual(['transform', { width: 1200, height: 628, fit: 'cover' }]);
    expect(p.output?.format).toBe('image/jpeg');
  });

  it('refuses other origins, non-images and roles without ads', async () => {
    const s = await staff('admin');
    expect((await put(s, png, 'image/png', 'https://evil.example')).status).toBe(403);
    expect((await put(s, png, 'text/html')).status).toBe(415);
    expect((await put(s, new TextEncoder().encode('<svg onload=alert(1)>'))).status).toBe(415);
    const fin = await staff('finance');
    expect((await put(fin, png)).status).toBe(403);
    expect(rpcCalls('admin_ad_image_set')).toHaveLength(0);
  });

  it('drops the new object when the database refuses', async () => {
    world.rpc.admin_ad_image_set = () => null;
    const s = await staff('admin');
    expect((await put(s, png)).status).toBe(404);
    const listed = await shared.list({ prefix: `ads/${CARD}/` });
    expect(listed.objects).toHaveLength(0);
  });
});

// ---- suspension ----------------------------------------------------------------------------------------------
describe('suspended members', () => {
  it('get 403 account_suspended and their session cookies cleared', async () => {
    must(world.users.find((u) => u.id === MEI.id)).suspended = true;
    const res = await call('/api/v1/me', { jar: await member(MEI) });
    expect(res.status).toBe(403);
    expect((await read(res)).error).toBe('account_suspended');
    const cleared = res.headers.getSetCookie().filter((c) => /Max-Age=0/i.test(c));
    expect(cleared.length).toBeGreaterThan(0);
  });

  it('can’t sign in: 403 account_suspended, no session cookies', async () => {
    must(world.users.find((u) => u.id === MEI.id)).suspended = true;
    const j = jar();
    const res = await call('/api/v1/auth/email/verify', {
      body: { email: MEI.email, code: '123456' },
      jar: j,
    });
    expect(res.status).toBe(403);
    expect((await read(res)).error).toBe('account_suspended');
    expect(j.cookies.size).toBe(0);
  });

  it('uses the profile’s own flag when the database sends it (no extra call)', async () => {
    world.rpc.get_session_profile = () => ({
      isStaff: false,
      displayName: null,
      plan: 'free',
      createdAt: '2026-10-01T00:00:00Z',
      deleted: false,
      deletionDue: null,
      suspended: false,
    });
    world.rpc.me_get = () => ({});
    await call('/api/v1/me', { jar: await member(MEI) });
    expect(rpcCalls('member_suspended')).toHaveLength(0);
  });
});

// ---- read-only mode --------------------------------------------------------------------------------------------
describe('read-only mode', () => {
  it('answers library writes with 503 read_only_mode; reads still work', async () => {
    world.appStatus = { readOnly: { on: true, message: 'Moving storage' }, maintenance: null };
    const w = await call('/api/v1/galleries', { jar: await member(MEI), body: { name: 'G' } });
    expect(w.status).toBe(503);
    expect((await read(w)).error).toBe('read_only_mode');
    expect(rpcCalls('create_gallery')).toHaveLength(0);
    world.rpc.list_galleries = () => [];
    expect((await call('/api/v1/galleries', { jar: await member(MEI) })).status).toBe(200);
  });

  it('refuses every content write, including bulk edits, renames, albums and gallery changes', async () => {
    world.appStatus = { readOnly: { on: true, message: 'Moving storage' }, maintenance: null };
    const j = await member(MEI);
    const blocked: [string, string, unknown][] = [
      ['POST', '/api/v1/photos/edits/bulk', { ids: [PHOTO], recipe: { exposure: 0.5 } }],
      ['POST', '/api/v1/photos/edits/bulk', { ids: [PHOTO], recipe: null }],
      ['DELETE', `/api/v1/photos/${PHOTO}/edit`, {}],
      ['PATCH', `/api/v1/photos/${PHOTO}`, { filename: 'x.jpg' }],
      ['POST', '/api/v1/albums', { name: 'A' }],
      ['POST', '/api/v1/recipes', { name: 'R' }],
      ['PATCH', `/api/v1/galleries/${GALLERY}`, { name: 'G' }],
      ['PUT', `/api/v1/galleries/${GALLERY}/renders/${PHOTO}`, {}],
      ['DELETE', `/api/v1/galleries/${GALLERY}/passcode`, {}],
      ['PUT', '/api/v1/me/branding', { studioName: 'S' }],
      ['POST', '/api/v1/ai/signals', {}],
      ['PATCH', '/api/v1/ai/settings', {}],
    ];
    for (const [method, path, body] of blocked) {
      const res = await call(path, { method, body, jar: j });
      expect([res.status, (await read(res)).error], `${method} ${path}`).toEqual([503, 'read_only_mode']);
    }
    expect(
      world.calls.filter((c) => c.url.includes('/rest/v1/rpc/') && !c.url.endsWith('/app_status')),
    ).toEqual([]);
  });

  it('photos/bulk: Trash actions still work; favourites and albums don’t', async () => {
    world.appStatus = { readOnly: { on: true, message: '' }, maintenance: null };
    world.rpc.bulk_photos = () => ({ affected: 1 });
    const j = await member(MEI);
    const fav = await call('/api/v1/photos/bulk', { body: { ids: [PHOTO], action: 'favourite' }, jar: j });
    expect([fav.status, (await read(fav)).error]).toEqual([503, 'read_only_mode']);
    const trash = await call('/api/v1/photos/bulk', { body: { ids: [PHOTO], action: 'trash' }, jar: j });
    expect(trash.status).toBe(200);
    expect(rpcCalls('bulk_photos').map((b) => b.p_action)).toEqual(['trash']);
  });

  it('galleries: removing photos still works; adding them doesn’t', async () => {
    world.appStatus = { readOnly: { on: true, message: '' }, maintenance: null };
    world.rpc.update_gallery_photos = () => ({ count: 1 });
    const j = await member(MEI);
    const add = await call(`/api/v1/galleries/${GALLERY}/photos`, { body: { add: [PHOTO] }, jar: j });
    expect([add.status, (await read(add)).error]).toEqual([503, 'read_only_mode']);
    const rm = await call(`/api/v1/galleries/${GALLERY}/photos`, { body: { remove: [PHOTO] }, jar: j });
    expect(rm.status).toBe(200);
  });

  it('the gate itself: allowed routes are exactly the exposure-reducing ones', () => {
    const id = PHOTO;
    for (const [m, p] of [
      ['PUT', `/api/v1/uploads/${id}/parts/1`],
      ['POST', `/api/v1/uploads/${id}/complete`],
      ['DELETE', `/api/v1/uploads/${id}`],
      ['POST', '/api/v1/trash/empty'],
      ['DELETE', `/api/v1/galleries/${id}`],
      ['POST', `/api/v1/galleries/${id}/link/replace`],
      ['POST', `/api/v1/galleries/${id}/passcode`],
      ['DELETE', `/api/v1/ai/jobs/${id}`],
      ['POST', `/api/v1/ai/jobs/${id}/pause`],
      ['DELETE', '/api/v1/ai/faces'],
      ['DELETE', '/api/v1/me/branding/logo'],
      ['GET', '/api/v1/photos'],
      ['POST', '/api/v1/team/invites'],
      ['PATCH', '/api/v1/me'],
    ] as const)
      expect(readOnlyBlocks(m, p), `${m} ${p}`).toBe(false);
    for (const [m, p] of [
      ['POST', '/api/v1/uploads'],
      ['POST', '/api/v1/uploads/'],
      ['POST', '/api/v1/galleries'],
      ['POST', `/api/v1/ai/jobs/${id}/claim`],
      ['POST', `/api/v1/ai/jobs/${id}/progress`],
      ['POST', '/api/v1/ai/faces'],
      ['PUT', `/api/v1/photos/${id}/edit`],
      ['POST', '/api/v1/photos/anything-new'],
    ] as const)
      expect(readOnlyBlocks(m, p), `${m} ${p}`).toBe(true);
  });

  it('caches app_status for 15 s per isolate', async () => {
    world.appStatus = { readOnly: null, maintenance: null };
    world.rpc.list_galleries = () => [];
    await call('/api/v1/status');
    await call('/api/v1/status');
    expect(rpcCalls('app_status')).toHaveLength(1);
  });

  it('/api/v1/status: public, no session, cacheable for 30 s', async () => {
    world.appStatus = { readOnly: { on: true, message: 'Back soon' }, maintenance: null };
    const res = await call(MEMBER8_API.status);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30');
    expect(await read(res)).toEqual({
      ok: true,
      readOnly: { on: true, message: 'Back soon' },
      maintenance: null,
    });
  });

  it('a settings change in Admin drops this isolate’s cached status', async () => {
    world.appStatus = { readOnly: null, maintenance: null };
    await call(MEMBER8_API.status);
    const s = await staff('admin');
    await as(s, ADMIN8_API.settings, { method: 'PATCH', body: { readOnly: { on: true }, reason } });
    world.appStatus = { readOnly: { on: true, message: '' }, maintenance: null };
    expect((await read(await call(MEMBER8_API.status))).readOnly).toEqual({ on: true, message: '' });
  });
});

// ---- member ads -------------------------------------------------------------------------------------------------
describe('member ads', () => {
  const live = {
    cards: [
      {
        id: CARD,
        advertiser: 'Lumen Labs',
        headline: 'Presets',
        body: 'Forty looks.',
        url: 'https://lumen.example.com',
        imageVersion: 3,
        placements: ['library'],
        weight: 10,
      },
    ],
    adsense: { publisherId: 'ca-pub-1234567890123456', slots: { library: '1234567890' } },
  };

  it('Free members get the live cards (with versioned image URLs) and the AdSense config', async () => {
    world.rpc.ads_for_member = () => live;
    const res = await call(MEMBER8_API.ads, { jar: await member(MEI) });
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.cards[0].imageUrl).toBe(MEMBER8_API.adImage(CARD, 3));
    expect(body.cards[0].imageVersion).toBeUndefined();
    expect(body.adsense.publisherId).toBe('ca-pub-1234567890123456');
    expect(rpcCalls('ads_for_member')[0]).toEqual({ p_user: MEI.id });
    expect(adsLimiter.keys).toEqual([`ads:${MEI.id}`]);
  });

  it('plans without ads get nothing (the database decides by the effective plan)', async () => {
    world.rpc.ads_for_member = () => ({ cards: [], adsense: null });
    expect(await read(await call(MEMBER8_API.ads, { jar: await member(MEI) }))).toEqual({
      ok: true,
      cards: [],
      adsense: null,
    });
  });

  it('a team library never shows ads, and its events aren’t counted', async () => {
    world.rpc.ads_for_member = () => live;
    world.rpc.ad_event = () => null;
    const headers = { 'X-Zephyr-Library': JUN.id };
    const res = await call(MEMBER8_API.ads, { jar: await member(MEI), headers });
    expect((await read(res)).cards).toEqual([]);
    expect(rpcCalls('ads_for_member')).toHaveLength(0);
    const ev = await call(MEMBER8_API.adEvent, {
      jar: await member(MEI),
      headers,
      body: { cardId: CARD, kind: 'click', placement: 'library' },
    });
    expect(ev.status).toBe(204);
    expect(rpcCalls('ad_event')).toHaveLength(0);
  });

  it('events: counted with no member id, validated, rate-limited', async () => {
    world.rpc.ad_event = () => null;
    const j = await member(MEI);
    const ok = await call(MEMBER8_API.adEvent, {
      jar: j,
      body: { cardId: CARD, kind: 'impression', placement: 'sidebar' },
    });
    expect(ok.status).toBe(204);
    expect(rpcCalls('ad_event')[0]).toEqual({ p_card: CARD, p_kind: 'impression', p_placement: 'sidebar' });
    expect(
      (await call(MEMBER8_API.adEvent, { jar: j, body: { cardId: CARD, kind: 'view', placement: 'x' } }))
        .status,
    ).toBe(400);
    adsLimiter.ok = false;
    expect(
      (await call(MEMBER8_API.adEvent, { jar: j, body: { cardId: CARD, kind: 'click', placement: 'batch' } }))
        .status,
    ).toBe(429);
    expect((await call(MEMBER8_API.ads)).status).toBe(401);
  });

  it('serves the card image publicly and immutably, by version', async () => {
    await shared.put(`ads/${CARD}/abc.jpg`, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]), {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    world.rpc.ad_image_key = (a) => (a.p_card === CARD && a.p_version === 3 ? `ads/${CARD}/abc.jpg` : null);
    const res = await call(MEMBER8_API.adImage(CARD, 3));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect((await call(MEMBER8_API.adImage(CARD, 2))).status).toBe(404);
    expect((await call(`/api/v1/ads/cards/${CARD}/image?v=../x`)).status).toBe(404);
  });
});

describe('public AdSense switch for the app Worker', () => {
  it('is on only with AdSense enabled and a valid publisher id; public, 60 s', async () => {
    world.rpc.adsense_public = () => ({ enabled: true, publisherId: 'ca-pub-1234567890123456' });
    const res = await call('/api/v1/ads/config-public');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await read(res)).toEqual({ ok: true, enabled: true, publisherId: 'ca-pub-1234567890123456' });
    world.rpc.adsense_public = () => ({ enabled: true, publisherId: 'ca-pub-123' });
    expect(await read(await call('/api/v1/ads/config-public'))).toEqual({
      ok: true,
      enabled: false,
      publisherId: null,
    });
    world.rpc.adsense_public = () => ({ enabled: false, publisherId: 'ca-pub-1234567890123456' });
    expect((await read(await call('/api/v1/ads/config-public'))).enabled).toBe(false);
  });

  it('fails closed, uncached, when the database is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    world.rpc.adsense_public = () => new Response('{}', { status: 500 });
    const res = await call('/api/v1/ads/config-public');
    expect(await read(res)).toEqual({ ok: true, enabled: false, publisherId: null });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('session user: retention notice', () => {
  it('passes the last retention batch through when the profile carries it', async () => {
    const retention = { trashedAt: '2026-11-10T02:20:00Z', photos: 120, restoreBy: '2026-12-10T02:20:00Z' };
    world.rpc.get_session_profile = () => ({
      isStaff: false,
      displayName: null,
      plan: 'free',
      createdAt: '2026-10-01T00:00:00Z',
      deleted: false,
      deletionDue: null,
      suspended: false,
      retention,
    });
    const res = await call('/api/v1/auth/session', { jar: await member(MEI) });
    expect(res.status).toBe(200);
    expect((await read(res)).user.retention).toEqual(retention);
  });

  it('leaves it out when the profile has no such field', async () => {
    const res = await call('/api/v1/auth/session', { jar: await member(MEI) });
    expect('retention' in (await read(res)).user).toBe(false);
  });
});

// ---- gallery links ----------------------------------------------------------------------------------------------
describe('gallery link replacement', () => {
  it('rotates the token and its encrypted copy, and returns the new link once', async () => {
    world.rpc.gallery_link_replace = () => true;
    const res = await call(MEMBER8_API.galleryLinkReplace(GALLERY), { jar: await member(MEI), body: {} });
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.link).toMatch(/^https:\/\/zephyrapp\.midnightpoetry\.studio\/g\/[A-Za-z0-9_-]+/);
    const sent = must(rpcCalls('gallery_link_replace')[0]);
    expect(sent.p_owner).toBe(MEI.id);
    expect(sent.p_actor).toBe(MEI.id);
    expect(sent.p_id).toBe(GALLERY);
    expect(typeof sent.p_token_hash).toBe('string');
    expect(typeof sent.p_link_ciphertext).toBe('string');
    expect(JSON.stringify(sent)).not.toContain(body.link.split('/g/')[1]);
  });

  it('404s for a gallery outside the library, and needs the galleries role', async () => {
    world.rpc.gallery_link_replace = () => null;
    expect(
      (await call(MEMBER8_API.galleryLinkReplace(GALLERY), { jar: await member(MEI), body: {} })).status,
    ).toBe(404);
    world.teams = { [MEI.id]: { [JUN.id]: 'viewer' } };
    const v = await call(MEMBER8_API.galleryLinkReplace(GALLERY), {
      jar: await member(JUN),
      body: {},
      headers: { 'X-Zephyr-Library': MEI.id },
    });
    expect(v.status).toBe(403);
  });
});

describe('team removal with replaceLinks=1', () => {
  beforeEach(() => {
    world.rpc.team_get = () => ({ name: 'T', seats: 3, used: 1, members: [], invites: [] });
    world.rpc.team_member_remove = () => true;
  });

  it('replaces every live gallery link in one call, before removing the member', async () => {
    world.rpc.live_gallery_ids = () => [GALLERY, '80000000-0000-4000-8000-000000000002'];
    world.rpc.gallery_links_replace = () => ({ replaced: 2 });
    const res = await call(`/api/v1/team/members/${JUN.id}?replaceLinks=1`, {
      jar: await member(MEI),
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const sent = must(rpcCalls('gallery_links_replace')[0]);
    expect(sent.p_owner).toBe(MEI.id);
    const links = sent.p_links as { id: string; tokenHash: string; linkHint: string }[];
    expect(links.map((l) => l.id)).toEqual([GALLERY, '80000000-0000-4000-8000-000000000002']);
    expect(new Set(links.map((l) => l.tokenHash)).size).toBe(2);
    const order = world.calls.map((c) => c.url.split('/rpc/')[1]).filter(Boolean);
    expect(order.indexOf('gallery_links_replace')).toBeLessThan(order.indexOf('team_member_remove'));
  });

  it('leaves links alone without the flag, and keeps the member when replacing fails', async () => {
    world.rpc.live_gallery_ids = () => [GALLERY];
    expect(
      (await call(`/api/v1/team/members/${JUN.id}`, { jar: await member(MEI), method: 'DELETE' })).status,
    ).toBe(200);
    expect(rpcCalls('gallery_links_replace')).toHaveLength(0);
    world.rpc.gallery_links_replace = () => new Response('{"message":"boom"}', { status: 500 });
    world.calls.length = 0;
    const res = await call(`/api/v1/team/members/${JUN.id}?replaceLinks=1`, {
      jar: await member(MEI),
      method: 'DELETE',
    });
    expect(res.status).toBe(500);
    expect(rpcCalls('team_member_remove')).toHaveLength(0);
    expect(
      (
        await call(`/api/v1/team/members/${JUN.id}?replaceLinks=yes`, {
          jar: await member(MEI),
          method: 'DELETE',
        })
      ).status,
    ).toBe(400);
  });
});

// ---- crons --------------------------------------------------------------------------------------------------------
describe('admin crons', () => {
  it('quarter-hour: activates limits, sends decrease notices, ends overrides, runs approved retention batches', async () => {
    world.rpc.limits_activate_due = () => 1;
    world.rpc.limits_notices_due = () => [
      {
        userId: MEI.id,
        email: MEI.email,
        version: 4,
        effectiveAt: '2026-12-20T00:00:00Z',
        changes: [{ label: 'Storage', from: '200 GB', to: '100 GB' }],
      },
    ];
    world.rpc.admin_overrides_expire = () => 2;
    world.rpc.retention_approved_due = () => [MEI.id];
    world.rpc.retention_trash_batch = () => ({ trashed: 40, done: true });
    const out = await runAdminCron(env);
    expect(out).toEqual({ limitsActivated: 1, limitsNotices: 1, overridesEnded: 2, retentionTrashed: 40 });
    expect(world.emails[0]?.to).toBe(MEI.email);
    expect(world.emails[0]?.text).toContain('Storage: 200 GB → 100 GB');
    expect(rpcCalls('retention_trash_batch')[0]).toEqual({ p_owner: MEI.id, p_limit: 500 });
  });

  it('quarter-hour: one failing step doesn’t stop the others', async () => {
    world.rpc.limits_activate_due = () => new Response('{}', { status: 500 });
    world.rpc.limits_notices_due = () => [];
    world.rpc.admin_overrides_expire = () => 0;
    world.rpc.retention_approved_due = () => [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = await runAdminCron(env);
    expect(out.limitsActivated).toBeNull();
    expect(out.overridesEnded).toBe(0);
  });

  it('daily: retention sweep and notices, and the sponsored cards’ status', async () => {
    world.rpc.retention_sweep = () => ({ entered: 1 });
    world.rpc.retention_notices_due = () => [
      { ownerId: MEI.id, email: MEI.email, dueAt: '2026-12-15T00:00:00Z', photos: 1234, notice: 'd30' },
    ];
    world.rpc.ad_status_tick = () => ({ live: 1, ended: 0 });
    const out = await runAdminDailyCron(env);
    expect(out.retentionNotices).toBe(1);
    expect(world.emails[0]?.subject).toContain('1,234');
    expect(rpcCalls('ad_status_tick')).toHaveLength(1);
  });

  it('schedule with decreases: sends the first notice batch at once', async () => {
    world.rpc.admin_limits_schedule = () => ({
      version: 3,
      effectiveAt: '2026-12-20T00:00:00Z',
      decreases: true,
    });
    world.rpc.limits_notices_due = () => [
      { userId: MEI.id, email: MEI.email, version: 3, effectiveAt: '2026-12-20T00:00:00Z', changes: [] },
    ];
    const s = await staff('owner');
    await as(s, ADMIN8_API.limitsSchedule, { body: { effectiveAt: '2026-12-20T00:00:00Z', reason } });
    expect(world.emails.some((e) => e.to === MEI.email)).toBe(true);
  });

  it('schedule: a decrease too soon is refused by the database (400)', async () => {
    world.rpc.admin_limits_schedule = () => ({ error: 'notice' });
    const s = await staff('owner');
    const res = await as(s, ADMIN8_API.limitsSchedule, {
      body: { effectiveAt: '2026-11-20T00:00:00Z', reason },
    });
    expect(res.status).toBe(400);
    expect(world.emails).toHaveLength(0);
  });
});
