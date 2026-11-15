import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AdminAiJobsResult, AiSettings, AiSettingsPatch, AiSpendToday } from '@zephyr/shared/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from './App';
import { diffAiSettings, parseForm, toForm } from './lib/ai';

vi.mock('./lib/passkey', async (orig) => ({
  ...(await orig<typeof import('./lib/passkey')>()),
  getPasskeyAssertion: vi.fn(async () => ({ id: 'cred', type: 'public-key' })),
}));

const SETTINGS: AiSettings = {
  enabled: true,
  cloudPaused: false,
  features: {
    auto_enhance: true,
    hdr: true,
    color_match: true,
    cleanup: true,
    face_grouping: true,
    scene_tags: true,
    bg_removal: true,
  },
  bgProvider: 'runware',
  bgFallback: 'fal_bria',
  runwareModel: 'runware:112@5',
  falModel: 'fal-ai/bria/background/remove',
  sceneModel: '@cf/microsoft/resnet-50',
  bgCreditsPerPhoto: 1,
  costs: { runwareMicros: 600, falMicros: 18000, sceneMicros: 20 },
  caps: { total: 10, bgRemoval: 8, sceneTags: 2, perUser: 0.5 },
  alerts: [50, 80, 100],
  atCap: 'pause',
  alertTo: 'owners_finance',
  memberJobsPerMinute: 60,
  updatedAt: '2026-11-01T04:00:00Z',
  updatedBy: null,
};
const SPEND: AiSpendToday = {
  day: '2026-11-01',
  totalUsd: 4.1,
  bgRemovalUsd: 3.86,
  sceneTagsUsd: 0.24,
  capped: false,
  credits: 6433,
  photos: 6433,
};
const JOBS: AdminAiJobsResult = {
  ok: true,
  counts: { pending: 1842, processing: 38, completedToday: 21148, failedToday: 19 },
  latency: [
    { label: 'Background removal', p50: 0.9, p95: 1.4 },
    { label: 'Fallback (Bria)', p50: 1.3, p95: 2.1 },
  ],
  providers: [
    {
      provider: 'runware',
      feature: 'bg_removal',
      role: 'primary',
      calls: 6433,
      successRate: 0.997,
      p95: 1.4,
    },
    { provider: 'fal_bria', feature: 'bg_removal', role: 'fallback', calls: 0, successRate: null, p95: null },
    {
      provider: 'workers_ai',
      feature: 'scene_tags',
      role: 'primary',
      calls: 900,
      successRate: 0.999,
      p95: 0.3,
    },
  ],
  failures: [
    {
      jobId: 'aaaaaaaa-1111-4111-8111-111111111111',
      itemId: 'bbbbbbbb-1111-4111-8111-111111111111',
      member: '5mz0c1d2',
      feature: 'bg_removal',
      error: 'provider_timeout',
      at: new Date(Date.now() - 6 * 60_000).toISOString(),
    },
  ],
  spend: SPEND,
};

/** Like the API: a patch's nested objects (caps, costs, features) merge into the current settings. */
const patched = (p: AiSettingsPatch): AiSettings => ({
  ...SETTINGS,
  ...p,
  features: { ...SETTINGS.features, ...p.features },
  costs: { ...SETTINGS.costs, ...p.costs },
  caps: { ...SETTINGS.caps, ...p.caps },
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
function mock(role: string, extra?: (c: Call) => Response | undefined) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const c = {
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(c);
      const r = extra?.(c);
      if (r) return r;
      if (url.endsWith('/auth/session'))
        return json(200, {
          ok: true,
          staff: { id: 's1', email: 'jason@midnightpoetry.studio', role, displayName: 'Jason L.' },
          enrolOnly: false,
        });
      if (url.endsWith('/ai/settings') && c.method === 'GET')
        return json(200, { ok: true, settings: SETTINGS, spend: SPEND });
      if (url.endsWith('/ai/settings') && c.method === 'PATCH')
        return json(200, { ok: true, settings: patched(c.body as AiSettingsPatch), spend: SPEND });
      if (url.endsWith('/ai/jobs')) return json(200, JOBS);
      if (url.endsWith('/auth/passkey/options'))
        return json(200, { ok: true, challengeId: 'ch1', options: { challenge: 'x', allowCredentials: [] } });
      if (url.endsWith('/auth/passkey/verify'))
        return json(200, {
          ok: true,
          staff: { id: 's1', email: 'jason@midnightpoetry.studio', role, displayName: 'Jason L.' },
          enrolOnly: false,
        });
      return json(404, { ok: false, error: 'not_found' });
    }),
  );
}
const renderAt = (path: string) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
};
const patches = () => calls.filter((c) => c.method === 'PATCH');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('AI settings form', () => {
  it('builds a patch with only the changed fields', () => {
    const f = toForm(SETTINGS);
    f.features.bg_removal = false;
    f.caps.total = '7.5';
    f.costs.scene = '0.00003';
    f.alerts = [80, 100];
    const p = parseForm(f, SETTINGS);
    if (!p.settings) throw new Error('should parse');
    expect(diffAiSettings(SETTINGS, p.settings)).toEqual({
      features: { bg_removal: false },
      caps: { total: 7.5 },
      costs: { sceneMicros: 30 },
      alerts: [80, 100],
    });
    expect(diffAiSettings(SETTINGS, parseForm(toForm(SETTINGS), SETTINGS).settings as AiSettings)).toEqual(
      {},
    );
  });
  it('rejects values the API would refuse', () => {
    const f = toForm(SETTINGS);
    f.bgFallback = 'runware';
    f.caps.perUser = '-1';
    f.bgCreditsPerPhoto = '21';
    f.runwareModel = 'https://evil.example';
    f.costs.fal = '2';
    const p = parseForm(f, SETTINGS);
    expect(p.settings).toBeNull();
    expect(Object.keys(p.errors ?? {}).sort()).toEqual([
      'bgCreditsPerPhoto',
      'bgFallback',
      'caps.perUser',
      'costs.fal',
      'runwareModel',
    ]);
  });
});

describe('Zephyr AI controls', () => {
  it('saves risk-lowering changes straight away with only what changed', async () => {
    mock('owner');
    renderAt('/ai');
    await screen.findByRole('switch', { name: /Studio background removal/ }, { timeout: 4000 });
    // Query fresh and wait for each step to land: on a busy CI runner a held element reference can go stale.
    const sw = () => screen.getByRole('switch', { name: /Studio background removal/ }) as HTMLInputElement;
    await act(async () => sw().click());
    await waitFor(() => expect(sw().checked).toBe(false), { timeout: 4000 });
    await waitFor(
      () => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false),
      {
        timeout: 4000,
      },
    );
    await act(async () => screen.getByRole('button', { name: 'Save' }).click());
    await waitFor(() => expect(patches()[0]?.body).toEqual({ features: { bg_removal: false } }), {
      timeout: 4000,
    });
    expect(calls.some((c) => c.url.endsWith('/passkey/options'))).toBe(false);
  });
  it('labels risk-raising changes and confirms with the passkey on reauth_required, then retries once', async () => {
    let first = true;
    mock('owner', (c) => {
      if (c.method === 'PATCH' && first) {
        first = false;
        return json(403, { ok: false, error: 'reauth_required' });
      }
      return undefined;
    });
    renderAt('/ai');
    const total = await screen.findByLabelText(/All cloud AI/, {}, { timeout: 4000 });
    fireEvent.change(total, { target: { value: '25' } });
    const save = screen.getByRole('button', { name: /Save · confirm with passkey/ });
    await act(async () => save.click());
    await waitFor(() => expect(patches()).toHaveLength(2), { timeout: 4000 });
    expect(patches()[1]?.body).toEqual({ caps: { total: 25 } });
    expect(calls.some((c) => c.url.endsWith('/auth/passkey/verify'))).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('shows field errors and blocks saving invalid values', async () => {
    mock('owner');
    renderAt('/ai');
    const total = await screen.findByLabelText(/All cloud AI/, {}, { timeout: 4000 });
    fireEvent.change(total, { target: { value: 'ten' } });
    expect(await screen.findByText('US$0 to US$10,000.', {}, { timeout: 4000 })).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('is read-only for finance', async () => {
    mock('finance');
    renderAt('/ai');
    expect(await screen.findByText('Read-only for your role', {}, { timeout: 4000 })).toBeTruthy();
    expect(
      (
        (await screen.findByRole(
          'switch',
          { name: /Zephyr AI for everyone/ },
          { timeout: 4000 },
        )) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull();
  });
  it('shows today’s spend against the caps', async () => {
    mock('admin');
    renderAt('/ai');
    const bar = await screen.findByRole(
      'progressbar',
      { name: 'All providers spend today' },
      { timeout: 4000 },
    );
    expect(bar.getAttribute('aria-valuenow')).toBe('41');
  });
});

describe('AI jobs', () => {
  it('renders the queue, providers and failures', async () => {
    mock('owner');
    renderAt('/ai/jobs');
    expect(await screen.findByText('21,148', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText('Runware · BiRefNet')).toBeTruthy();
    expect(screen.getByText('Standing by')).toBeTruthy();
    expect(screen.getByText('Provider timed out twice · refunded')).toBeTruthy();
    expect(screen.getByText('6 min ago')).toBeTruthy();
    expect(screen.getByText('aaaaaaaa')).toBeTruthy();
  });
  it('pauses cloud jobs without a passkey, and resuming asks for one', async () => {
    let paused = false;
    let reauthed = false;
    mock('owner', (c) => {
      if (c.url.endsWith('/auth/passkey/verify')) reauthed = true;
      if (c.url.endsWith('/ai/settings') && c.method === 'GET')
        return json(200, { ok: true, settings: { ...SETTINGS, cloudPaused: paused }, spend: SPEND });
      if (c.url.endsWith('/ai/settings') && c.method === 'PATCH') {
        const want = (c.body as { cloudPaused: boolean }).cloudPaused;
        if (want === false && !reauthed) return json(403, { ok: false, error: 'reauth_required' });
        paused = want;
        return json(200, { ok: true, settings: { ...SETTINGS, cloudPaused: paused }, spend: SPEND });
      }
      return undefined;
    });
    renderAt('/ai/jobs');
    const pause = await screen.findByRole('button', { name: 'Pause new cloud jobs' }, { timeout: 4000 });
    await act(async () => pause.click());
    const resume = await screen.findByRole('button', { name: 'Resume cloud jobs' }, { timeout: 4000 });
    expect(calls.some((c) => c.url.endsWith('/passkey/options'))).toBe(false);
    await act(async () => resume.click());
    await screen.findByRole('button', { name: 'Pause new cloud jobs' }, { timeout: 4000 });
    expect(reauthed).toBe(true);
    expect(patches().map((c) => c.body)).toEqual([
      { cloudPaused: true },
      { cloudPaused: false },
      { cloudPaused: false },
    ]);
  });
  it('is read-only for support and polls every 30 seconds while visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mock('support');
    renderAt('/ai/jobs');
    expect(await screen.findByText('Read-only for your role', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /cloud jobs/ })).toBeNull();
    await screen.findByText('21,148', {}, { timeout: 4000 });
    const before = calls.filter((c) => c.url.endsWith('/ai/jobs')).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(calls.filter((c) => c.url.endsWith('/ai/jobs')).length).toBe(before + 1);
  });
});
