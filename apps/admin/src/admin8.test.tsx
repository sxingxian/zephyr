import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  type AdminLimitsPreviewResult,
  type AdminLimitsResult,
  type AdminRetentionResult,
  type AdminSafetyResult,
  type AdminStaffResult,
  type AdminStorageResult,
  PLANS,
  type PlanId,
  type PlanLimits,
  type StaffRole,
} from '@zephyr/shared/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './App';
import { navFor } from './components/Shell';
import { toLocalInput, writeError } from './lib/admin8';
import { ApiFailure } from './lib/api';
import { adUrlOk } from './routes/Ads';
import { auditQuery } from './routes/Audit';
import { limitsError } from './routes/Limits';
import { monthlyCost, STORAGE_POLL_MS } from './routes/Storage';

vi.mock('./lib/passkey', async (orig) => ({
  ...(await orig<typeof import('./lib/passkey')>()),
  getPasskeyAssertion: vi.fn(async () => ({ id: 'cred', type: 'public-key' })),
}));

// ---------------------------------------------------------------- harness
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: string; method: string; body: unknown; init?: RequestInit };
let calls: Call[] = [];
type Handler = (c: Call) => Response | Promise<Response> | undefined;

function mock(role: StaffRole | null, handler: Handler = () => undefined) {
  calls = [];
  const staff = role && { id: 's1', email: 'jason@midnightpoetry.studio', role, displayName: 'Jason L.' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const isJson = typeof init?.body === 'string';
      const c: Call = {
        url,
        method: init?.method ?? 'GET',
        body: isJson ? JSON.parse(String(init?.body)) : init?.body,
        init,
      };
      calls.push(c);
      const r = await handler(c);
      if (r) return r;
      if (url.endsWith('/auth/session'))
        return staff
          ? json(200, { ok: true, staff, enrolOnly: false })
          : json(401, { ok: false, error: 'unauthenticated' });
      if (url.endsWith('/auth/passkey/options'))
        return json(200, { ok: true, challengeId: 'ch1', options: { challenge: 'x', allowCredentials: [] } });
      if (url.endsWith('/auth/passkey/verify')) return json(200, { ok: true, staff, enrolOnly: false });
      return json(404, { ok: false, error: 'not_found' });
    }),
  );
}
const renderAt = (path: string) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
};
const writes = (part: string) => calls.filter((c) => c.method !== 'GET' && c.url.includes(part));
const gets = (part: string) => calls.filter((c) => c.method === 'GET' && c.url.includes(part));
const T = { timeout: 4000 };
const dialog = (name: RegExp | string) => screen.getByRole('dialog', { name, hidden: true });
const btn = (scope: HTMLElement, name: RegExp | string) =>
  within(scope).getByRole('button', { name, hidden: true }) as HTMLButtonElement;
const reasonIn = (scope: HTMLElement) => within(scope).getByLabelText(/^Reason/) as HTMLTextAreaElement;

beforeEach(() => {
  // jsdom has no <dialog> modal API.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const limitsOf = (id: PlanId): PlanLimits => {
  const p = PLANS.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return structuredClone(p.limits);
};
const LIMITS = { free: limitsOf('free'), pro: limitsOf('pro'), studio: limitsOf('studio') };

// ---------------------------------------------------------------- helpers
describe('phase 8 helpers', () => {
  it('validates plan limits against the API ceilings', () => {
    expect(limitsError(LIMITS.pro)).toBeNull();
    expect(limitsError({ ...LIMITS.pro, batchSize: 2001 })).toMatch(/Batch size/);
    expect(limitsError({ ...LIMITS.pro, seats: 0 })).toMatch(/Seats/);
    expect(limitsError({ ...LIMITS.pro, galleries: null })).toBeNull();
    expect(limitsError({ ...LIMITS.pro, fileTypes: [] })).toMatch(/file type/);
  });
  it('explains too_soon, no_changes and the credit limit in plain words', () => {
    expect(writeError(new ApiFailure('too_soon', 400))).toMatch(/at least 30 days from now/);
    expect(writeError(new ApiFailure('no_changes', 409))).toMatch(/same as the live limits/);
    expect(writeError(new ApiFailure('limit_reached', 403))).toMatch(
      /1,000 a grant, 1,000 per member and 5,000/,
    );
  });
  it('accepts only https ad links with a real host and no credentials', () => {
    expect(adUrlOk('https://lumen.example/rent?x=1')).toBe(true);
    for (const bad of [
      'http://lumen.example',
      'https://u:p@lumen.example',
      'https://127.0.0.1/',
      'https://localhost/',
      'javascript:alert(1)',
      'https://[::1]/',
    ])
      expect(adUrlOk(bad), bad).toBe(false);
  });
  it('builds the audit query from filters', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    const q = new URLSearchParams(
      auditQuery(
        { actor: '', kind: 'storage', target: ' store_b2 ', when: '7d', from: '', to: '' },
        now,
        'c2',
      ),
    );
    expect(q.get('kind')).toBe('storage');
    expect(q.get('target')).toBe('store_b2');
    expect(q.get('from')).toBe('2026-11-08T12:00:00.000Z');
    expect(q.get('cursor')).toBe('c2');
    expect(auditQuery({ actor: '', kind: '', target: '', when: 'all', from: '', to: '' })).toBe('');
  });
});

// ---------------------------------------------------------------- navigation
describe('role-based navigation', () => {
  const labels = (r: StaffRole) => navFor(r).map((n) => n.label);
  it('shows each page only to roles that can view it', () => {
    expect(labels('owner')).toEqual(
      expect.arrayContaining([
        'Users',
        'Safety & reports',
        'Plan limits',
        'Ads',
        'Storage',
        'Retention',
        'Audit log',
        'Staff & roles',
        'System settings',
      ]),
    );
    expect(labels('admin')).not.toContain('Staff & roles');
    expect(labels('admin')).toEqual(
      expect.arrayContaining(['Ads', 'Storage', 'Retention', 'System settings', 'Plan limits']),
    );
    expect(labels('finance')).toEqual(
      expect.arrayContaining(['Users', 'Plan limits', 'Audit log', 'Plans & billing']),
    );
    for (const no of ['Safety & reports', 'Ads', 'Storage', 'Retention', 'Staff & roles', 'System settings'])
      expect(labels('finance')).not.toContain(no);
    expect(labels('safety')).toEqual(expect.arrayContaining(['Users', 'Safety & reports', 'Audit log']));
    for (const no of ['Plan limits', 'Ads', 'Storage', 'Plans & billing', 'Staff & roles'])
      expect(labels('safety')).not.toContain(no);
    expect(labels('support')).toContain('Users');
    for (const no of [
      'Safety & reports',
      'Plan limits',
      'Ads',
      'Storage',
      'Retention',
      'Audit log',
      'Staff & roles',
      'System settings',
    ])
      expect(labels('support')).not.toContain(no);
    expect(navFor(undefined)).toEqual([]);
  });

  it('Users is open to every staff role', async () => {
    mock('support', (c) =>
      c.url.includes('/admin/api/v1/users')
        ? json(200, { ok: true, total: 0, page: { items: [], nextCursor: null } })
        : undefined,
    );
    renderAt('/users');
    await waitFor(() => expect(gets('/admin/api/v1/users').length).toBeGreaterThan(0), T);
    expect(screen.queryByText(/^This page is for/)).toBeNull();
  });

  it.each([
    ['/safety', 'finance', '/admin/api/v1/safety', 'safety'],
    ['/limits', 'safety', '/admin/api/v1/limits', 'finance'],
    ['/ads', 'finance', '/admin/api/v1/ads', 'admin'],
    ['/storage', 'support', '/admin/api/v1/storage', 'admin'],
    ['/retention', 'safety', '/admin/api/v1/retention', 'owner'],
    ['/audit', 'support', '/admin/api/v1/audit', 'finance'],
    ['/staff', 'admin', '/admin/api/v1/staff', 'owner'],
    ['/settings', 'finance', '/admin/api/v1/settings', 'admin'],
  ] as const)('%s: hidden from %s (no request), loads for %s', async (path, denied, endpoint, allowed) => {
    mock(denied);
    renderAt(path);
    expect(await screen.findByText(/^This page is for/, {}, T)).toBeTruthy();
    expect(gets(endpoint).filter((c) => !c.url.includes('/auth/'))).toHaveLength(0);
    cleanup();
    mock(allowed);
    renderAt(path);
    await waitFor(() => expect(gets(endpoint).length).toBeGreaterThan(0), T);
    expect(screen.queryByText(/^This page is for/)).toBeNull();
  });
});

// ---------------------------------------------------------------- retention: reason required
const RETENTION: AdminRetentionResult = {
  ok: true,
  kpis: { readOnly: 312, dueIn30Days: 14, ready: 1, resolvedThisMonth: 9 },
  items: [
    {
      ownerId: '11111111-1111-4111-8111-111111111111',
      displayName: 'Kai Lim',
      lapsedAt: '2025-11-07T00:00:00Z',
      dueAt: '2026-11-07T00:00:00Z',
      overBytes: 36e9,
      photosToTrash: 2914,
      notices: { d30: '2026-10-08T00:00:00Z', d7: '2026-10-31T00:00:00Z' },
      state: 'ready',
    },
    {
      ownerId: '22222222-2222-4222-8222-222222222222',
      displayName: 'Jun W.',
      lapsedAt: '2025-11-21T00:00:00Z',
      dueAt: '2026-11-21T00:00:00Z',
      overBytes: 18e9,
      photosToTrash: 1402,
      notices: { d30: '2026-10-22T00:00:00Z', d7: null },
      state: 'waiting',
    },
  ],
};

describe('Retention', () => {
  it('needs a reason before approving, then sends the selected owners', async () => {
    mock('admin', (c) => {
      if (c.url.endsWith('/retention')) return json(200, RETENTION);
      if (c.url.endsWith('/retention/approve')) return json(200, { ...RETENTION, items: [] });
      return undefined;
    });
    renderAt('/retention');
    const box = await screen.findByLabelText('Select Kai Lim', {}, T);
    expect(screen.queryByLabelText('Select Jun W.')).toBeNull(); // only ready rows are selectable
    await act(async () => fireEvent.click(box));
    await act(async () => screen.getByRole('button', { name: /Approve 1: move the excess/ }).click());
    const d = dialog(/Approve 1 library/);
    const confirm = btn(d, /Approve with passkey/);
    expect(confirm.disabled).toBe(true);
    fireEvent.change(reasonIn(d), { target: { value: 'ab' } });
    expect(confirm.disabled).toBe(true); // at least 3 characters
    fireEvent.change(reasonIn(d), { target: { value: 'Emails sent, past 1 year' } });
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    await waitFor(() => expect(writes('/retention/approve')).toHaveLength(1), T);
    expect(writes('/retention/approve')[0]?.body).toEqual({
      ownerIds: ['11111111-1111-4111-8111-111111111111'],
      reason: 'Emails sent, past 1 year',
    });
  });
});

// ---------------------------------------------------------------- storage
const STORE_BASE = {
  encryptionAtRest: true,
  objects: 0,
  bytes: 0,
  egressNote: null,
  lastCheck: {
    at: new Date(Date.now() - 120_000).toISOString(),
    reachable: true,
    latencyMs: 41,
    roundTrip: true,
    uploadMBps: 38,
    freeBytes: null,
    capacityBytes: null,
    error: null,
  },
};
const STORAGE: AdminStorageResult = {
  ok: true,
  writeStore: 'r2',
  totals: { photos: 9_800_000, bytes: 41.6e12 },
  autoReadOnly: false,
  migration: null,
  stores: [
    {
      ...STORE_BASE,
      id: 'r2',
      name: 'Cloudflare R2',
      kind: 'r2',
      connection: 'binding',
      costPerTbMonthUsd: 15,
      health: 'healthy',
      current: true,
    },
    {
      ...STORE_BASE,
      id: 'b2',
      name: 'Backblaze B2',
      kind: 's3',
      connection: 'https',
      costPerTbMonthUsd: 7,
      health: 'healthy',
      current: false,
    },
    {
      ...STORE_BASE,
      id: 'nas2',
      name: 'Studio NAS · hostname',
      kind: 's3',
      connection: 'tunnel',
      costPerTbMonthUsd: null,
      health: 'unreachable',
      current: false,
    },
  ],
};
const MOVING: AdminStorageResult = {
  ...STORAGE,
  writeStore: 'b2',
  migration: {
    id: 'mig1',
    from: 'r2',
    to: 'b2',
    state: 'copying',
    direction: 'forward',
    canRollBack: true,
    startedAt: '2026-11-14T01:12:00Z',
    startedBy: 'Jason L.',
    photos: { total: 9_800_000, copied: 6_100_000, verified: 6_000_000, failed: 12 },
    bytes: { total: 41.6e12, copied: 25.8e12 },
    deleteOldAfter: null,
    lastError: null,
  },
};

describe('Storage', () => {
  it('estimates monthly cost from the declared price', () => {
    expect(monthlyCost(STORAGE.stores[0] as never, 41.6e12)).toBeCloseTo(624);
    expect(monthlyCost(STORAGE.stores[2] as never, 41.6e12)).toBeNull();
  });

  it('switches with a cost comparison, a reason and the passkey (reauth_required → retry once)', async () => {
    let first = true;
    mock('owner', (c) => {
      if (c.url.endsWith('/storage') && c.method === 'GET') return json(200, STORAGE);
      if (c.url.endsWith('/storage/switch')) {
        if (first) {
          first = false;
          return json(403, { ok: false, error: 'reauth_required' });
        }
        return json(200, MOVING);
      }
      return undefined;
    });
    renderAt('/storage');
    await screen.findByText('Stores set up for this deployment', {}, T);
    const switches = screen.getAllByRole('button', { name: 'Switch to this…' }) as HTMLButtonElement[];
    expect(switches).toHaveLength(2);
    expect(switches[1]?.disabled).toBe(true); // unreachable store
    await act(async () => switches[0]?.click());
    const d = dialog('Switch storage to Backblaze B2');
    expect(within(d).getByText('~US$624 / month → ~US$291 / month')).toBeTruthy();
    const confirm = btn(d, /Switch with passkey/);
    expect(confirm.disabled).toBe(true);
    fireEvent.change(reasonIn(d), { target: { value: 'Storage cost' } });
    await act(async () => confirm.click());
    await waitFor(() => expect(writes('/storage/switch')).toHaveLength(2), T);
    expect(writes('/storage/switch')[1]?.body).toEqual({ to: 'b2', reason: 'Storage cost' });
    expect(calls.some((c) => c.url.endsWith('/auth/passkey/verify'))).toBe(true);
    expect(await screen.findByText(/Moving photos: Cloudflare R2 → Backblaze B2/, {}, T)).toBeTruthy();
  });

  it('shows migration progress, pauses with a reason and polls while copying', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mock('admin', (c) => {
      if (c.url.endsWith('/storage') && c.method === 'GET') return json(200, MOVING);
      if (c.url.endsWith('/storage/migration'))
        return json(200, { ...MOVING, migration: { ...MOVING.migration, state: 'paused' } });
      return undefined;
    });
    renderAt('/storage');
    const bar = await screen.findByRole('progressbar', { name: 'Photos copied' }, T);
    expect(bar.getAttribute('aria-valuenow')).toBe('62');
    expect(screen.getByRole('button', { name: /Roll back to Cloudflare R2/ })).toBeTruthy();
    const before = gets('/admin/api/v1/storage').length;
    await act(async () => undefined); // let the polling effect start
    await act(async () => {
      vi.advanceTimersByTime(STORAGE_POLL_MS + 50);
    });
    await waitFor(() => expect(gets('/admin/api/v1/storage').length).toBeGreaterThan(before), T);
    await act(async () => screen.getByRole('button', { name: 'Pause copying' }).click());
    const d = dialog('Pause copying');
    fireEvent.change(reasonIn(d), { target: { value: 'Peak hours' } });
    await act(async () => btn(d, 'Pause').click());
    await waitFor(
      () => expect(writes('/storage/migration')[0]?.body).toEqual({ action: 'pause', reason: 'Peak hours' }),
      T,
    );
    expect(await screen.findByRole('button', { name: 'Resume copying' }, T)).toBeTruthy();
  });

  it('hides rollback once old copies are being deleted, and offers a retry when photos failed', async () => {
    mock('admin', (c) => {
      if (c.url.endsWith('/storage') && c.method === 'GET')
        return json(200, {
          ...MOVING,
          migration: { ...MOVING.migration, state: 'failed', canRollBack: false },
        });
      return undefined;
    });
    renderAt('/storage');
    expect(await screen.findByRole('button', { name: 'Retry failed photos' }, T)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Roll back/ })).toBeNull();
    expect(screen.getByText(/can no longer be rolled back/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------- plan limits
const v = (version: number, status: 'active' | 'draft') => ({
  version,
  status,
  effectiveAt: status === 'active' ? '2026-06-01T00:00:00Z' : null,
  reason: status === 'active' ? 'Launch' : '',
  createdBy: 'Jason L.',
  createdAt: '2026-11-01T00:00:00Z',
  limits: structuredClone(LIMITS),
});
const LIMITS_DATA: AdminLimitsResult = {
  ok: true,
  active: v(2, 'active'),
  scheduled: null,
  draft: v(3, 'draft'),
  history: [{ ...v(2, 'active'), limits: undefined } as never],
};
const preview = (decreases: boolean): AdminLimitsPreviewResult => ({
  ok: true,
  changes: [
    decreases
      ? { plan: 'free', field: 'storageGb', from: 15, to: 10, direction: 'down' }
      : { plan: 'pro', field: 'storageGb', from: 200, to: 250, direction: 'up' },
  ],
  decreases,
  earliestEffectiveAt: decreases
    ? new Date(Date.now() + 31 * 86_400_000).toISOString()
    : new Date(Date.now() + 60_000).toISOString(),
  membersEmailed: decreases ? 18_322 : 0,
  membersOver: decreases ? 42 : 0,
});

describe('Plan limits', () => {
  const setup = (decreases: boolean) =>
    mock('owner', (c) => {
      if (c.url.endsWith('/limits') && c.method === 'GET') return json(200, LIMITS_DATA);
      if (c.url.endsWith('/limits/draft/preview')) return json(200, preview(decreases));
      if (c.url.endsWith('/limits/draft/schedule')) return json(200, { ...LIMITS_DATA, draft: null });
      return undefined;
    });

  it('decreases: "Now" is disabled, the date can’t be before the notice period, and a reason is required', async () => {
    setup(true);
    renderAt('/limits');
    const el1 = await screen.findByRole('button', { name: 'Review changes' }, T);
    await act(async () => el1.click());
    expect(await screen.findByText('10', { exact: false, selector: '.a8-down' }, T)).toBeTruthy();
    const now = screen.getByRole('radio', { name: /^Now/ }) as HTMLInputElement;
    expect(now.disabled).toBe(true);
    expect((screen.getByRole('radio', { name: /^On a date/ }) as HTMLInputElement).checked).toBe(true);
    const p = preview(true);
    const date = screen.getByLabelText('Applies from') as HTMLInputElement;
    expect(date.min).toBe(toLocalInput(p.earliestEffectiveAt));
    const go = screen.getByRole('button', { name: /Schedule with passkey/ }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText('Reason (audit log and emails to Owners)'), {
      target: { value: 'Storage costs' },
    });
    fireEvent.change(date, {
      target: { value: toLocalInput(new Date(Date.now() + 5 * 86_400_000).toISOString()) },
    });
    expect(screen.getByText(/or later\.$/, { selector: '.z-hint--error' })).toBeTruthy();
    expect(go.disabled).toBe(true);
    const ok = toLocalInput(new Date(Date.now() + 40 * 86_400_000).toISOString());
    fireEvent.change(date, { target: { value: ok } });
    expect(go.disabled).toBe(false);
    await act(async () => go.click());
    await waitFor(() => expect(writes('/limits/draft/schedule')).toHaveLength(1), T);
    expect(writes('/limits/draft/schedule')[0]?.body).toEqual({
      effectiveAt: new Date(ok).toISOString(),
      reason: 'Storage costs',
    });
  });

  it('increases only: can apply now (effectiveAt null)', async () => {
    setup(false);
    renderAt('/limits');
    const el2 = await screen.findByRole('button', { name: 'Review changes' }, T);
    await act(async () => el2.click());
    const now = (await screen.findByRole('radio', { name: /^Now/ }, T)) as HTMLInputElement;
    expect(now.disabled).toBe(false);
    expect(now.checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason (audit log and emails to Owners)'), {
      target: { value: 'More room on Pro' },
    });
    await act(async () => screen.getByRole('button', { name: /Schedule with passkey/ }).click());
    await waitFor(
      () =>
        expect(writes('/limits/draft/schedule')[0]?.body).toEqual({
          effectiveAt: null,
          reason: 'More room on Pro',
        }),
      T,
    );
  });

  it('saves the draft before it can be reviewed', async () => {
    mock('finance', (c) => {
      if (c.url.endsWith('/limits') && c.method === 'GET') return json(200, LIMITS_DATA);
      if (c.url.endsWith('/limits/draft') && c.method === 'PUT') return json(200, LIMITS_DATA);
      return undefined;
    });
    renderAt('/limits');
    const input = (await screen.findByLabelText('Storage (GB), Pro', {}, T)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '321' } });
    expect((screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => screen.getByRole('button', { name: 'Save draft' }).click());
    await waitFor(() => expect(writes('/limits/draft')[0]?.method).toBe('PUT'), T);
    expect(
      (writes('/limits/draft')[0]?.body as { limits: Record<PlanId, PlanLimits> } | undefined)?.limits.pro
        .storageGb,
    ).toBe(321);
  });
});

// ---------------------------------------------------------------- safety reveal
const SAFETY: AdminSafetyResult = {
  ok: true,
  kpis: { open: 1, olderThan24h: 0, holds: 0, sharingSuspended: 0, medianHoursToAction: 3 },
  holds: [],
  reports: [
    {
      id: 'rep_1',
      reason: 'privacy',
      count: 2,
      galleryId: 'g1',
      galleryName: 'Wedding',
      galleryState: 'live',
      ownerId: 'o1aaaaaa-0000-4000-8000-000000000000',
      photoIds: ['p1', 'p2'],
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      resolvedAt: null,
      resolution: null,
    },
  ],
};

describe('Safety reveal', () => {
  it('fetches each photo with the grant token, never cached, and drops every image at expiry', {
    timeout: 15_000,
  }, async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => {
          const u = `blob:x/${created.length}`;
          created.push(u);
          return u;
        }),
        revokeObjectURL: vi.fn((u: string) => revoked.push(u)),
      }),
    );
    const expiresAt = new Date(Date.now() + 3000).toISOString();
    mock('safety', (c) => {
      if (c.url.includes('/safety?') || c.url.endsWith('/safety')) return json(200, SAFETY);
      if (c.url.endsWith('/safety/reports/rep_1'))
        return json(200, {
          ok: true,
          report: {
            ...SAFETY.reports[0],
            details: ['Not consented'],
            ownerPlan: 'pro',
            heldPhotoIds: ['p2'],
          },
        });
      if (c.url.endsWith('/reveal'))
        return json(200, {
          ok: true,
          grantId: 'gr1',
          expiresAt,
          token: 'T'.repeat(43),
          photos: [{ id: 'p1', url: '/admin/api/v1/safety/reveal/gr1/p1' }],
        });
      if (c.url.includes('/safety/reveal/gr1/p1'))
        return new Response('img', { status: 200, headers: { 'content-type': 'image/jpeg' } });
      return undefined;
    });
    renderAt('/safety');
    const el3 = await screen.findByRole('button', { name: /“Wedding”/ }, T);
    await act(async () => el3.click());
    expect(await screen.findByText(/1 photo is on hold/, {}, T)).toBeTruthy();
    await act(async () => screen.getByRole('button', { name: 'Reveal for review…' }).click());
    const d = dialog('Reveal 1 photo for review');
    fireEvent.change(within(d).getByLabelText(/Why you need to see them/), {
      target: { value: 'Checking consent' },
    });
    await act(async () => btn(d, /Reveal with passkey/).click());
    await waitFor(() => expect(writes('/reveal')[0]?.body).toEqual({ reason: 'Checking consent' }), T);
    const media = await waitFor(() => {
      const m = calls.find((c) => c.url.includes('/safety/reveal/gr1/p1'));
      expect(m).toBeTruthy();
      return m as Call;
    }, T);
    expect(media.url).toBe(`/admin/api/v1/safety/reveal/gr1/p1?t=${'T'.repeat(43)}`);
    expect(media.init?.cache).toBe('no-store');
    const shown = await screen.findByRole('button', { name: 'Click to show this photo' }, T);
    expect(shown.querySelector('img')?.getAttribute('src')).toBe('blob:x/0');
    expect(screen.getByText(/Jason L\. · until/)).toBeTruthy();
    await act(async () => shown.click());
    expect(screen.getByRole('button', { name: 'Revealed photo' })).toBeTruthy();
    // At expiry the images leave the DOM and their object URLs are revoked.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revealed photo' })).toBeNull(), {
      timeout: 6000,
    });
    expect(document.querySelector('img[src^="blob:"]')).toBeNull();
    expect(revoked).toContain('blob:x/0');
  });
});

// ---------------------------------------------------------------- staff
const STAFF: AdminStaffResult = {
  ok: true,
  staff: [
    {
      userId: 's1',
      email: 'jason@midnightpoetry.studio',
      displayName: 'Jason L.',
      role: 'owner',
      passkeys: 2,
      lastActiveAt: new Date().toISOString(),
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      userId: 's2',
      email: 'farah@midnightpoetry.studio',
      displayName: 'Farah K.',
      role: 'finance',
      passkeys: 1,
      lastActiveAt: null,
      createdAt: '2026-01-01T00:00:00Z',
    },
  ],
  invites: [
    {
      id: 'inv1',
      email: 'ravi@midnightpoetry.studio',
      role: 'admin',
      createdAt: '2026-11-14T00:00:00Z',
      expiresAt: '2026-11-17T00:00:00Z',
      createdBy: 'Jason L.',
    },
  ],
};

describe('Staff & roles', () => {
  it('shows the last-Owner message when the API refuses a demotion', async () => {
    mock('owner', (c) => {
      if (c.url.endsWith('/staff') && c.method === 'GET') return json(200, STAFF);
      if (c.url.endsWith('/staff/s1') && c.method === 'PATCH')
        return json(409, { ok: false, error: 'last_owner' });
      return undefined;
    });
    renderAt('/staff');
    const el4 = await screen.findByRole('button', { name: 'Change role of Jason L.' }, T);
    await act(async () => el4.click());
    const d = dialog(/Change role/);
    fireEvent.change(reasonIn(d), { target: { value: 'Stepping back' } });
    await act(async () => btn(d, /Change role with passkey/).click());
    expect(
      await within(d).findByText(
        'There must always be at least one Owner. Make someone else an Owner first.',
        {},
        T,
      ),
    ).toBeTruthy();
    expect(writes('/staff/s1')[0]?.body).toEqual({ role: 'admin', reason: 'Stepping back' });
  });

  it('invites with a role and a reason, and revokes an invite', async () => {
    mock('owner', (c) => {
      if (c.url.endsWith('/staff') && c.method === 'GET') return json(200, STAFF);
      if (c.url.endsWith('/staff/invites') || c.url.endsWith('/staff/invites/inv1')) return json(200, STAFF);
      return undefined;
    });
    renderAt('/staff');
    const el5 = await screen.findByRole('button', { name: 'Invite staff' }, T);
    await act(async () => el5.click());
    const d = dialog('Invite staff');
    fireEvent.change(within(d).getByLabelText('Work email'), {
      target: { value: ' Mei@Midnightpoetry.Studio ' },
    });
    fireEvent.change(within(d).getByLabelText('Role'), { target: { value: 'safety' } });
    expect(btn(d, /Send invite/).disabled).toBe(true);
    fireEvent.change(reasonIn(d), { target: { value: 'New safety lead' } });
    await act(async () => btn(d, /Send invite/).click());
    await waitFor(
      () =>
        expect(writes('/staff/invites')[0]?.body).toEqual({
          email: 'mei@midnightpoetry.studio',
          role: 'safety',
          reason: 'New safety lead',
        }),
      T,
    );
    await act(async () =>
      screen.getByRole('button', { name: 'Revoke invite for ravi@midnightpoetry.studio' }).click(),
    );
    await act(async () => btn(dialog('Revoke invite'), 'Revoke').click());
    await waitFor(() => expect(writes('/staff/invites/inv1')[0]?.method).toBe('DELETE'), T);
  });
});

// ---------------------------------------------------------------- audit export
describe('Audit log', () => {
  it('exports CSV with the current filters as a download', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:csv'), revokeObjectURL: vi.fn() }),
    );
    mock('admin', (c) => {
      if (c.url.includes('/audit/export'))
        return new Response('at,actor\n', { status: 200, headers: { 'content-type': 'text/csv' } });
      if (c.url.includes('/audit'))
        return json(200, {
          ok: true,
          page: {
            items: [
              {
                id: 'a1',
                at: '2026-11-15T06:21:00Z',
                actor: { id: 'aaaaaaaa-0000-4000-8000-000000000000', name: 'Jason L.', role: 'owner' },
                action: 'Scheduled plan limits v3',
                target: 'limits_v3',
                reason: 'Cloud AI costs',
              },
            ],
            nextCursor: 'next1',
          },
        });
      return undefined;
    });
    renderAt('/audit');
    expect(await screen.findByText('Scheduled plan limits v3', {}, T)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('What'), { target: { value: 'limits' } });
    await act(async () => screen.getByRole('button', { name: 'Apply' }).click());
    await waitFor(() => expect(gets('kind=limits').length).toBeGreaterThan(0), T);
    await act(async () => screen.getByRole('button', { name: 'Next' }).click());
    await waitFor(() => expect(gets('cursor=next1').length).toBe(1), T);
    await act(async () => screen.getByRole('button', { name: 'Export CSV' }).click());
    await waitFor(() => expect(click).toHaveBeenCalled(), T);
    const exp = calls.find((c) => c.url.includes('/audit/export'));
    expect(exp?.url).toMatch(/^\/admin\/api\/v1\/audit\/export\?/);
    expect(exp?.url).toContain('kind=limits');
    expect(exp?.url).not.toContain('cursor=');
    expect(exp?.init?.cache).toBe('no-store');
  });

  it('hides the export from roles without it', async () => {
    mock('finance', (c) =>
      c.url.includes('/audit') ? json(200, { ok: true, page: { items: [], nextCursor: null } }) : undefined,
    );
    renderAt('/audit');
    await screen.findByText('Nothing matches these filters.', {}, T);
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });
});

// ---------------------------------------------------------------- staff invite accept
describe('Staff invite link', () => {
  it('strips the fragment, accepts the token and continues to enrolment with the email prefilled', async () => {
    const token = 'a'.repeat(43);
    window.history.replaceState(null, '', `/admin/staff-invite#t=${token}`);
    mock(null, (c) =>
      c.url.endsWith('/staff/invite/accept')
        ? json(200, { ok: true, email: 'ravi@midnightpoetry.studio' })
        : undefined,
    );
    renderAt('/staff-invite');
    const email = (await screen.findByLabelText('Staff email', {}, T)) as HTMLInputElement;
    expect(email.value).toBe('ravi@midnightpoetry.studio');
    expect(window.location.hash).toBe('');
    expect(writes('/staff/invite/accept')).toHaveLength(1);
    expect(writes('/staff/invite/accept')[0]?.body).toEqual({ token });
  });

  it('also accepts #token= and explains an invite for a different Access identity', async () => {
    const token = 'b'.repeat(43);
    window.history.replaceState(null, '', `/admin/staff-invite#token=${token}`);
    mock(null, (c) =>
      c.url.endsWith('/staff/invite/accept') ? json(403, { ok: false, error: 'forbidden' }) : undefined,
    );
    renderAt('/staff-invite');
    expect(
      await screen.findByText(/different email than the one you signed in to Cloudflare Access/, {}, T),
    ).toBeTruthy();
    expect(writes('/staff/invite/accept')[0]?.body).toEqual({ token });
    expect(window.location.hash).toBe('');
  });

  it('explains a used or expired invite (invite_invalid)', async () => {
    window.history.replaceState(null, '', `/admin/staff-invite#t=${'c'.repeat(43)}`);
    mock(null, (c) =>
      c.url.endsWith('/staff/invite/accept') ? json(400, { ok: false, error: 'invite_invalid' }) : undefined,
    );
    renderAt('/staff-invite');
    expect(await screen.findByText(/expired or was already used/, {}, T)).toBeTruthy();
  });

  it('explains an address that already has an account (409 conflict)', async () => {
    window.history.replaceState(null, '', `/admin/staff-invite#t=${'d'.repeat(43)}`);
    mock(null, (c) =>
      c.url.endsWith('/staff/invite/accept') ? json(409, { ok: false, error: 'conflict' }) : undefined,
    );
    renderAt('/staff-invite');
    expect(await screen.findByText(/already has a Zephyr account/, {}, T)).toBeTruthy();
  });

  it('explains a missing or malformed token without calling the API', async () => {
    window.history.replaceState(null, '', '/admin/staff-invite#t=short');
    mock(null);
    renderAt('/staff-invite');
    expect(await screen.findByText(/isn’t complete/, {}, T)).toBeTruthy();
    expect(window.location.hash).toBe('');
    expect(writes('/staff/invite/accept')).toHaveLength(0);
  });
});
