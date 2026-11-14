import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AdsResult, LibrarySummary, PhotoItem } from '@zephyr/shared/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './App';
import { AD_EVERY, AD_FIRST, buildRows } from './components/PhotoGrid';
import { __resetAdsForTest, ADSENSE_SRC, adsAllowedOn, safeAdUrl } from './lib/ads';
import { resetAiStatus } from './lib/aiClient';
import { api } from './lib/api';
import { resetAppStatus, STATUS_POLL_MS, useAppStatusPolling } from './lib/appStatus';
import { resetPrices } from './lib/billing';
import { __setActiveForTest, resetLibraryContext } from './lib/libraryContext';
import { browser, setSessionUserId } from './lib/sessionGuard';
import { resetUsage } from './lib/usage';

const ME = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const GID = '7d3f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const PUB = 'ca-pub-1234567890123456';
const user = (plan: 'free' | 'pro' | 'studio' = 'free', extra: Record<string, unknown> = {}) => ({
  id: ME,
  email: 'jun@example.com',
  displayName: 'Jun Hao',
  plan,
  passkeyCount: 1,
  createdAt: '2026-10-28T00:00:00Z',
  ...extra,
});
const OWN: LibrarySummary = {
  ownerId: ME,
  name: 'Jun Hao',
  ownerName: 'Jun Hao',
  role: 'owner',
  plan: 'free',
  state: 'active',
  initials: 'JH',
};
const TEAM_LIB: LibrarySummary = {
  ownerId: OWNER,
  name: 'Tan Studio',
  ownerName: 'Mei Lin',
  role: 'editor',
  plan: 'studio',
  state: 'active',
  initials: 'TS',
};
const CARD = {
  id: 'card-1',
  advertiser: 'Lumen Prints',
  headline: 'Fine-art prints of your photos',
  body: 'Archival paper, framed or unframed.',
  url: 'https://lumen.example/prints',
  imageUrl: '/api/v1/ads/cards/card-1/image?v=2',
  placements: ['sidebar', 'library', 'batch'] as AdsResult['cards'][number]['placements'],
  weight: 10,
};

const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
type Handler = (url: string, method: string, body: unknown) => Response | undefined;
let currentUser: ReturnType<typeof user> = user();
function mockApi(handler: Handler = () => undefined, libraries: LibrarySummary[] = [OWN]) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const r = handler(url, method, body);
      if (r) return r;
      if (url.endsWith('/auth/session')) return json(200, { ok: true, user: currentUser });
      if (url === '/api/v1/libraries') return json(200, { ok: true, libraries });
      if (url === '/api/v1/status') return json(200, { ok: true, readOnly: null, maintenance: null });
      if (url === '/api/v1/ads') return json(200, { ok: true, cards: [], adsense: null });
      if (url === '/api/v1/ai') return json(404, { ok: false, error: 'not_found' });
      if (url.endsWith('/me/usage'))
        return json(200, {
          ok: true,
          usedBytes: 1,
          reservedBytes: 0,
          limitBytes: 5e9,
          trashBytes: 0,
          photoCount: 0,
          plan: currentUser.plan,
          fileTypes: ['jpeg'],
          maxFileBytes: 1e8,
          batchSize: 25,
        });
      if (url.startsWith('/api/v1/photos?')) return json(200, { ok: true, items: [], nextCursor: null });
      return json(200, { ok: true });
    }),
  );
}
const adsResponse = (adsense: AdsResult['adsense'], cards = [CARD]) =>
  json(200, { ok: true, cards, adsense } satisfies AdsResult);
function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

// IntersectionObserver stand-in: tests decide when a card is visible.
let observers: { cb: IntersectionObserverCallback; el: Element | null; io: IntersectionObserver }[] = [];
class FakeIO {
  cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    observers.push({ cb: this.cb, el, io: this as unknown as IntersectionObserver });
  }
  disconnect() {
    observers = observers.filter((o) => o.io !== (this as unknown as IntersectionObserver));
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}
function setVisible(ratio: number) {
  for (const o of [...observers])
    o.cb(
      [{ isIntersecting: ratio > 0, intersectionRatio: ratio, target: o.el } as IntersectionObserverEntry],
      o.io,
    );
}

function Poller() {
  useAppStatusPolling();
  return null;
}

let assign: ReturnType<typeof vi.spyOn>;
let reload: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  window.history.replaceState(null, '', '/');
  sessionStorage.clear();
  currentUser = user();
  observers = [];
  vi.stubGlobal('IntersectionObserver', FakeIO);
  setSessionUserId(ME);
  assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
  reload = vi.spyOn(browser, 'reload').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetAiStatus();
  resetPrices();
  resetUsage();
  resetLibraryContext();
  __setActiveForTest(null, null);
  setSessionUserId(null);
  resetAppStatus();
  __resetAdsForTest();
  delete window.adsbygoogle;
});

// ---------------------------------------------------------------- status banner and read-only mode
describe('status banner', () => {
  it('shows read-only mode and takes the write entry points away', async () => {
    mockApi((url) =>
      url === '/api/v1/status'
        ? json(200, { ok: true, readOnly: { on: true, message: 'Storage maintenance.' }, maintenance: null })
        : undefined,
    );
    renderAt('/');
    expect(await screen.findByText('Zephyr is read-only right now')).toBeTruthy();
    expect(screen.getByText(/Storage maintenance\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
    const plus = screen.getByRole('button', { name: /Uploading isn’t available/ });
    expect((plus as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the maintenance notice', async () => {
    mockApi((url) =>
      url === '/api/v1/status'
        ? json(200, {
            ok: true,
            readOnly: null,
            maintenance: { message: 'Short upgrade on Sunday.', startsAt: null, endsAt: null },
          })
        : undefined,
    );
    renderAt('/');
    expect(await screen.findByText('Planned maintenance')).toBeTruthy();
    expect(screen.getByText('Short upgrade on Sunday.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeTruthy();
  });

  it('turns read-only on at once when a call answers 503 read_only_mode, with a friendly message', async () => {
    let readOnly = false;
    mockApi((url) => {
      if (url === '/api/v1/status')
        return json(200, {
          ok: true,
          readOnly: readOnly ? { on: true, message: '' } : null,
          maintenance: null,
        });
      if (url === '/api/v1/albums') return json(503, { ok: false, error: 'read_only_mode' });
      return undefined;
    });
    renderAt('/');
    await screen.findByRole('button', { name: 'Upload' });
    readOnly = true;
    const err = await act(() => api('/api/v1/albums', { body: { name: 'x' } }).catch((e: Error) => e));
    expect((err as Error & { code: string }).code).toBe('read_only_mode');
    const { errorMessage } = await import('./lib/api');
    expect(errorMessage(err)).toMatch(/read-only for a little while/);
    expect(await screen.findByText('Zephyr is read-only right now')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull());
  });

  it('polls every 2 minutes', async () => {
    vi.useFakeTimers();
    mockApi();
    render(<Poller />);
    const statusCalls = () => calls.filter((c) => c.url === '/api/v1/status').length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(statusCalls()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    });
    expect(statusCalls()).toBe(2);
  });
});

// ---------------------------------------------------------------- suspended
describe('suspended account', () => {
  it('ends the session and shows the suspended screen when the session probe answers account_suspended', async () => {
    mockApi((url) =>
      url.endsWith('/auth/session') ? json(403, { ok: false, error: 'account_suspended' }) : undefined,
    );
    renderAt('/');
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/suspended'));
  });

  it('does the same for any other call (sign-in included)', async () => {
    mockApi((url) =>
      url === '/api/v1/auth/passkey/verify'
        ? json(403, { ok: false, error: 'account_suspended' })
        : undefined,
    );
    renderAt('/sign-in');
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/auth/session'))).toBe(true));
    await act(() => api('/api/v1/auth/passkey/verify', { body: {} }).catch(() => undefined));
    expect(assign).toHaveBeenCalledWith('/suspended');
  });

  it('the suspended screen offers support and another account, and never loops', async () => {
    mockApi((url) =>
      url.endsWith('/auth/session') ? json(403, { ok: false, error: 'account_suspended' }) : undefined,
    );
    window.history.replaceState(null, '', '/suspended');
    renderAt('/suspended');
    expect(await screen.findByRole('heading', { name: 'This account is suspended' })).toBeTruthy();
    const mail = screen.getByRole('link', { name: 'Email support' });
    expect(mail.getAttribute('href')).toMatch(/^mailto:support@midnightpoetry\.studio/);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/auth/session'))).toBe(true));
    expect(assign).not.toHaveBeenCalledWith('/suspended');
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));
    expect(assign).toHaveBeenCalledWith('/sign-in');
  });
});

// ---------------------------------------------------------------- retention banner
describe('retention notice', () => {
  const retention = { trashedAt: '2026-11-07T02:20:00Z', photos: 2914, restoreBy: '2099-12-07T02:20:00Z' };
  it('tells the member how many of their oldest photos went to Trash and until when', async () => {
    currentUser = user('free', { retention });
    mockApi();
    renderAt('/');
    expect(await screen.findByText('2,914 of your oldest photos were moved to Trash')).toBeTruthy();
    expect(screen.getByText(/Restore anything by 7 Dec 2099/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Trash' }).getAttribute('href')).toBe('/trash');
    expect(screen.getByRole('link', { name: 'Upgrade to Pro' }).getAttribute('href')).toBe('/plans');
  });
  it('says nothing without a batch, after the restore window, or in a team library', async () => {
    currentUser = user('free', { retention: null });
    mockApi();
    renderAt('/');
    await screen.findByRole('heading', { name: 'Library' });
    expect(screen.queryByText(/moved to Trash/)).toBeNull();
    cleanup();
    currentUser = user('free', { retention: { ...retention, restoreBy: '2020-01-01T00:00:00Z' } });
    renderAt('/');
    await screen.findByRole('heading', { name: 'Library' });
    expect(screen.queryByText(/moved to Trash/)).toBeNull();
    cleanup();
    currentUser = user('free', { retention });
    __setActiveForTest(ME, OWNER);
    mockApi(undefined, [OWN, TEAM_LIB]);
    renderAt('/');
    await screen.findByRole('heading', { name: 'Library' });
    expect(screen.queryByText(/moved to Trash/)).toBeNull();
  });
});

// ---------------------------------------------------------------- sponsored cards
describe('sponsored cards', () => {
  it('renders a labelled card with a safe new-tab link, and counts one impression and each click', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi((url) => (url === '/api/v1/ads' ? adsResponse(null) : undefined));
    renderAt('/');
    const card = await screen.findByRole('complementary', { name: 'Sponsored' });
    expect(within(card).getByText('Sponsored')).toBeTruthy();
    expect(within(card).getByText('Fine-art prints of your photos')).toBeTruthy();
    const link = within(card).getByRole('link', { name: /Lumen Prints/ });
    expect(link.getAttribute('href')).toBe('https://lumen.example/prints');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer sponsored');
    expect(card.querySelector('img')?.getAttribute('src')).toBe('/api/v1/ads/cards/card-1/image?v=2');

    const events = () => calls.filter((c) => c.url === '/api/v1/ads/events');
    // Less than half visible, or not for a full second: nothing.
    act(() => setVisible(0.3));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    act(() => setVisible(0.6));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    act(() => setVisible(0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(events()).toHaveLength(0);
    act(() => setVisible(0.6));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(events()).toEqual([
      {
        url: '/api/v1/ads/events',
        method: 'POST',
        body: { cardId: 'card-1', kind: 'impression', placement: 'sidebar' },
      },
    ]);
    // Once per card per page view.
    act(() => setVisible(0.6));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(events()).toHaveLength(1);
    link.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(link);
    expect(events()[1]?.body).toEqual({ cardId: 'card-1', kind: 'click', placement: 'sidebar' });
  });

  it('drops cards whose link isn’t plain https', () => {
    expect(safeAdUrl('https://ok.example/a')).toBe('https://ok.example/a');
    expect(safeAdUrl('http://ok.example/a')).toBeNull();
    expect(safeAdUrl('javascript:alert(1)')).toBeNull();
    expect(safeAdUrl('https://user:pw@ok.example/')).toBeNull();
  });

  it('only on pages that browse the library', () => {
    for (const p of ['/', '/favourites', '/albums', '/albums/a1', '/people/p1', '/scenes/beach', '/ai/queue'])
      expect(adsAllowedOn(p)).toBe(true);
    for (const p of [
      '/edit/p1',
      '/photo/p1',
      '/shared',
      '/shared/g1/settings',
      '/plans',
      '/billing/return',
      '/settings/billing',
      '/settings/team',
      '/settings/security',
      '/sign-in',
      '/g/token',
      '/you',
    ])
      expect(adsAllowedOn(p)).toBe(false);
  });
});

// ---------------------------------------------------------------- AdSense gating
describe('AdSense', () => {
  const adsenseScript = () => document.querySelector<HTMLScriptElement>(`script[src^="${ADSENSE_SRC}"]`);
  const config = { publisherId: PUB, slots: { sidebar: '1234567890', library: '2345678901' } };

  it('loads Google’s tag (with its consent message) for a Free member when the API turns it on', async () => {
    mockApi((url) => (url === '/api/v1/ads' ? adsResponse(config, []) : undefined));
    renderAt('/');
    const ins = await waitFor(() => {
      const el = document.querySelector('ins.adsbygoogle');
      if (!el) throw new Error('no unit');
      return el;
    });
    expect(ins.getAttribute('data-ad-client')).toBe(PUB);
    expect(ins.getAttribute('data-ad-slot')).toBe('1234567890');
    expect(adsenseScript()?.src).toBe(`${ADSENSE_SRC}?client=${PUB}`);
    expect(adsenseScript()?.crossOrigin).toBe('anonymous');
    expect(document.querySelectorAll('script[src*="google"]')).toHaveLength(1);
    expect(window.adsbygoogle).toHaveLength(1);
  });

  it('never loads without the API’s config', async () => {
    mockApi((url) => (url === '/api/v1/ads' ? adsResponse(null, []) : undefined));
    renderAt('/');
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/ads')).toBe(true));
    await screen.findByRole('heading', { name: 'Library' });
    expect(adsenseScript()).toBeNull();
    expect(document.querySelector('ins.adsbygoogle')).toBeNull();
  });

  it('never for paid plans or in a team library (the ads aren’t even asked for)', async () => {
    currentUser = user('pro');
    mockApi((url) => (url === '/api/v1/ads' ? adsResponse(config) : undefined));
    renderAt('/');
    await screen.findByRole('heading', { name: 'Library' });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.url === '/api/v1/ads')).toBe(false);
    expect(adsenseScript()).toBeNull();
    cleanup();
    currentUser = user('free');
    __setActiveForTest(ME, OWNER);
    mockApi((url) => (url === '/api/v1/ads' ? adsResponse(config) : undefined), [OWN, TEAM_LIB]);
    renderAt('/');
    await screen.findByRole('heading', { name: 'Library' });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.url === '/api/v1/ads')).toBe(false);
    expect(adsenseScript()).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Sponsored' })).toBeNull();
  });

  it('unmounts every ad unit on pages where ads aren’t allowed', async () => {
    mockApi((url) => (url === '/api/v1/ads' ? adsResponse(config) : undefined));
    const router = renderAt('/');
    await waitFor(() => expect(document.querySelector('ins.adsbygoogle, [data-ad-card]')).not.toBeNull());
    for (const path of ['/settings/billing', '/settings/team', '/shared', '/plans', '/settings/security']) {
      await act(() => router.navigate(path));
      await waitFor(() => expect(document.querySelector('ins.adsbygoogle, [data-ad-card]')).toBeNull());
    }
    await act(() => router.navigate('/'));
    await waitFor(() => expect(document.querySelector('ins.adsbygoogle, [data-ad-card]')).not.toBeNull());
  });

  it('reloads the page after an upgrade once Google’s script was loaded', async () => {
    const SID = 'cs_test_abcdefghij1234';
    mockApi((url) => {
      if (url === '/api/v1/ads') return adsResponse(config, []);
      if (url === `/api/v1/billing/checkout/${SID}`)
        return json(200, { ok: true, state: 'done', plan: 'pro' });
      return undefined;
    });
    const router = renderAt('/');
    await waitFor(() => expect(adsenseScript()).not.toBeNull());
    expect(reload).not.toHaveBeenCalled();
    // Back from Stripe: the payment is confirmed and the session now says Pro.
    currentUser = user('pro');
    await act(() => router.navigate(`/billing/return?session_id=${SID}`));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });
});

// ---------------------------------------------------------------- library grid ad rows
describe('library grid ad rows', () => {
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      takenAt: null,
      createdAt: '2026-11-01T00:00:00Z',
    })) as unknown as PhotoItem[];
  it('after the first 24 tiles, then every 48, never at the very end', () => {
    const rows = buildRows(items(130), 'added', 6, false, true);
    let tiles = 0;
    const at: number[] = [];
    for (const r of rows) {
      if (r.kind === 'tiles') tiles += r.indexes.length;
      if (r.kind === 'ad') at.push(tiles);
    }
    expect(at).toEqual([AD_FIRST, AD_FIRST + AD_EVERY, AD_FIRST + 2 * AD_EVERY]);
    expect(buildRows(items(24), 'added', 6, false, true).some((r) => r.kind === 'ad')).toBe(false);
    expect(buildRows(items(130), 'added', 6, false, false).some((r) => r.kind === 'ad')).toBe(false);
  });
});

// ---------------------------------------------------------------- replace a gallery link
describe('gallery settings: replace link', () => {
  const NEW_LINK = `https://zephyrapp.midnightpoetry.studio/g/${'Nw'.repeat(20)}x-_`;
  const gallery = {
    id: GID,
    name: 'Sunday shoot',
    status: 'live',
    photoCount: 12,
    coverPhotoId: null,
    passcode: true,
    downloads: 'web',
    expiresAt: '2099-12-01T23:59:59Z',
    pausedUntil: null,
    views: 0,
    favourites: 0,
    createdAt: '2026-11-01T00:00:00Z',
    message: null,
    extras: { favourites: false, watermark: false, branding: false, accessLog: false },
    linkHint: '/g/k7Qx2m…',
    pendingRenders: 0,
    revokedAt: null,
  };
  it('confirms, replaces the link and shows the new one once', async () => {
    currentUser = user('studio');
    mockApi((url, method) => {
      if (url === `/api/v1/galleries/${GID}/link/replace` && method === 'POST')
        return json(200, { ok: true, link: NEW_LINK });
      if (url === `/api/v1/galleries/${GID}`) return json(200, { ok: true, gallery });
      if (url.endsWith('/me/branding')) return json(404, { ok: false, error: 'not_found' });
      return undefined;
    });
    renderAt(`/shared/${GID}/settings`);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace link…' }));
    expect(await screen.findByText(/The current link stops working at once, for everyone/)).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/link/replace'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Replace link' }));
    const field = (await screen.findByDisplayValue(NEW_LINK)) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(calls.filter((c) => c.url.endsWith('/link/replace'))).toHaveLength(1);
    expect(screen.getByText(/The old link no longer works/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByDisplayValue(NEW_LINK)).toBeNull());
  });
});

// ---------------------------------------------------------------- team removal replaces links
describe('team removal: replace links', () => {
  const member = (liveGalleries: number) => ({
    userId: '33333333-3333-4333-8333-333333333333',
    email: 'aisha@example.com',
    displayName: 'Aisha M.',
    role: 'editor' as const,
    addedAt: '2026-11-01T00:00:00Z',
    suspended: false,
    liveGalleries,
  });
  const team = (liveGalleries: number) => ({
    name: 'Jun’s Studio',
    seats: 3,
    used: 2,
    available: true,
    invites: [],
    members: [
      {
        userId: ME,
        email: 'jun@example.com',
        displayName: 'Jun Hao',
        role: 'owner' as const,
        addedAt: '2026-10-28T00:00:00Z',
        suspended: false,
        liveGalleries: 0,
      },
      member(liveGalleries),
    ],
  });
  const removeCalls = () => calls.filter((c) => c.method === 'DELETE' && c.url.includes('/team/members/'));

  it('replaces the links of their live galleries by default', async () => {
    currentUser = user('studio');
    mockApi((url) => (url === '/api/v1/team' ? json(200, { ok: true, team: team(6) }) : undefined));
    renderAt('/settings/team');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Aisha M. from the team' }));
    const toggle = (await screen.findByRole('switch', {
      name: /Replace the links of those 6 galleries now/,
    })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove and replace 6 links' }));
    await waitFor(() => expect(removeCalls()).toHaveLength(1));
    expect(removeCalls()[0]?.url).toMatch(
      /\/team\/members\/33333333-3333-4333-8333-333333333333\?replaceLinks=1$/,
    );
  });

  it('keeps the links when the switch is turned off', async () => {
    currentUser = user('studio');
    mockApi((url) => (url === '/api/v1/team' ? json(200, { ok: true, team: team(2) }) : undefined));
    renderAt('/settings/team');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Aisha M. from the team' }));
    fireEvent.click(await screen.findByRole('switch', { name: /Replace the links of those 2 galleries/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from team' }));
    await waitFor(() => expect(removeCalls()).toHaveLength(1));
    expect(removeCalls()[0]?.url).not.toContain('replaceLinks');
  });

  it('no switch when they couldn’t open any live gallery', async () => {
    currentUser = user('studio');
    mockApi((url) => (url === '/api/v1/team' ? json(200, { ok: true, team: team(0) }) : undefined));
    renderAt('/settings/team');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Aisha M. from the team' }));
    await screen.findByText(/lose access to your library straight away/);
    expect(screen.queryByRole('switch', { name: /Replace the links/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from team' }));
    await waitFor(() => expect(removeCalls()).toHaveLength(1));
    expect(removeCalls()[0]?.url).not.toContain('replaceLinks');
  });
});
