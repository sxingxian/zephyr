import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AdsResult, LibrarySummary, PhotoItem } from '@zephyr/shared/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './App';
import { NoAdsSurface } from './components/ads/NoAdsSurface';
import { AD_EVERY, AD_FIRST, buildRows } from './components/PhotoGrid';
import { CopyButton, PasscodeReveal } from './components/share/ShareBits';
import { useShareGallery } from './components/share/ShareDialogs';
import {
  __resetAdsForTest,
  ADSENSE_SRC,
  adsAllowedOn,
  adsenseHeld,
  documentMarker,
  holdAdsense,
  loadAdsense,
  resetSiteForAdsense,
  safeAdUrl,
} from './lib/ads';
import { resetAiStatus } from './lib/aiClient';
import { api } from './lib/api';
import { resetAppStatus, STATUS_POLL_MS, useAppStatusPolling } from './lib/appStatus';
import { resetPrices } from './lib/billing';
import { __setActiveForTest, resetLibraryContext } from './lib/libraryContext';
import { browser, setSessionUserId } from './lib/sessionGuard';
import { SHARE_HANDOFF_KEY, SHARE_HANDOFF_PATH, takeShareHandoff } from './lib/shareHandoff';
import { resetUsage } from './lib/usage';
import { __resetShareNewForTest } from './routes/ShareNew';

// The browser passkey prompt (WebAuthn) doesn't exist in jsdom: stand in for it.
const passkeyMock = vi.hoisted(() => ({ create: vi.fn(async () => ({ id: 'cred' })) }));
vi.mock('./lib/passkey', () => ({
  passkeysSupported: () => true,
  createPasskey: passkeyMock.create,
  getPasskeyAssertion: vi.fn(),
  isCancelled: () => false,
}));

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
type Call = { url: string; method: string; body: unknown; headers: Headers };
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
      calls.push({ url, method, body, headers: new Headers(init?.headers) });
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
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/suspended', { sessionEnd: true }));
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
    expect(assign).toHaveBeenCalledWith('/suspended', { sessionEnd: true });
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
    expect(assign.mock.calls.map((c: unknown[]) => c[0])).not.toContain('/suspended');
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));
    expect(assign).toHaveBeenCalledWith('/sign-in', { sessionEnd: true });
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

    const events = () =>
      calls.filter((c) => c.url === '/api/v1/ads/events').map(({ headers: _h, ...rest }) => rest);
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
/** Share and secret-bearing bits on an ad page (phase 8 test). */
function SecretProbe() {
  const sharing = useShareGallery();
  return (
    <div>
      <h1>Probe</h1>
      <button type="button" onClick={() => sharing.open([GID], 'Beach day')}>
        Share now
      </button>
      <PasscodeReveal code="482915" />
      <CopyButton text="https://zephyrapp.midnightpoetry.studio/g/secret" what="Link" />
      <NoAdsSurface>
        <p>Secret surface</p>
      </NoAdsSurface>
      {sharing.dialogs}
    </div>
  );
}

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
    // Only sponsored cards here (Google's script never loaded): no full page loads needed.
    expect(assign).not.toHaveBeenCalled();
    await act(() => router.navigate('/'));
    await waitFor(() => expect(document.querySelector('ins.adsbygoogle, [data-ad-card]')).not.toBeNull());
  });

  it('never renders a page without ads in a document holding Google’s script: a full page load instead', async () => {
    const SID = 'cs_test_abcdefghij1234';
    mockApi((url) => (url === '/api/v1/ads' ? adsResponse(config, []) : undefined));
    const router = renderAt('/');
    await waitFor(() => expect(adsenseScript()).not.toBeNull());
    calls = [];
    await act(() => router.navigate(`/billing/return?session_id=${SID}#x`));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(`/billing/return?session_id=${SID}#x`, { keepStorage: true }),
    );
    // The page never mounted, so it asked the API for nothing.
    expect(calls.some((c) => c.url.includes('/billing/'))).toBe(false);
    expect(screen.queryByRole('heading', { name: /payment|billing/i })).toBeNull();
  });

  it('reloads once Google’s script was loaded and the plan changes elsewhere (tab focus, another tab)', async () => {
    mockApi((url) => (url === '/api/v1/ads' ? adsResponse(config, []) : undefined));
    renderAt('/');
    await waitFor(() => expect(adsenseScript()).not.toBeNull());
    expect(reload).not.toHaveBeenCalled();
    // Upgraded on another device: the tab comes back into view and re-reads the session.
    currentUser = user('pro');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('re-reads the session when another tab reports a plan change', async () => {
    mockApi((url) => (url === '/api/v1/ads' ? adsResponse(config, []) : undefined));
    renderAt('/');
    await waitFor(() => expect(adsenseScript()).not.toBeNull());
    const before = calls.filter((c) => c.url.endsWith('/auth/session')).length;
    currentUser = user('pro');
    const other = new BroadcastChannel('zephyr-session');
    other.postMessage({ type: 'plan-changed', id: ME });
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith('/auth/session')).length).toBeGreaterThan(before),
    );
    await waitFor(() => expect(reload).toHaveBeenCalled());
    other.close();
  });

  it('a session that ends while Google’s script is loaded leaves with a full page load to sign-in', async () => {
    mockApi((url) => {
      if (url === '/api/v1/ads') return adsResponse(config, []);
      if (url.startsWith('/api/v1/photos?')) return json(401, { ok: false, error: 'unauthenticated' });
      return undefined;
    });
    renderAt('/favourites');
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('/sign-in?next=%2Ffavourites', { sessionEnd: true }),
    );
  });

  it('reloads when the member the script was loaded for is replaced', async () => {
    mockApi((url) => (url === '/api/v1/ads' ? adsResponse(config, []) : undefined));
    renderAt('/');
    await waitFor(() => expect(adsenseScript()).not.toBeNull());
    expect(reload).not.toHaveBeenCalled();
    const other = '33333333-3333-4333-8333-333333333333';
    currentUser = { ...user('free'), id: other };
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('never for a member of any team library, even in their own library (cards still show)', async () => {
    mockApi((url) => (url === '/api/v1/ads' ? adsResponse(config) : undefined), [OWN, TEAM_LIB]);
    renderAt('/');
    expect(await screen.findAllByRole('complementary', { name: 'Sponsored' })).not.toHaveLength(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(adsenseScript()).toBeNull();
    expect(document.querySelector('ins.adsbygoogle')).toBeNull();
  });

  it('a document first loaded on a page without ads reloads on arriving at an ad page, instead of loading the script', async () => {
    __resetAdsForTest('/settings/security');
    mockApi((url) => (url === '/api/v1/ads' ? adsResponse(config, []) : undefined));
    renderAt('/');
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(adsenseScript()).toBeNull();
  });

  it('a document the Worker served with the strict policy never loads the script, and reloads for it once at most', async () => {
    __resetAdsForTest('/', false);
    mockApi((url) => (url === '/api/v1/ads' ? adsResponse(config, []) : undefined));
    renderAt('/');
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(adsenseScript()).toBeNull();
    expect(document.querySelector('ins.adsbygoogle')).toBeNull();
    // The cookie didn't stick (the reload brought the strict policy again): no second reload, no loop.
    cleanup();
    renderAt('/');
    await screen.findByRole('heading', { name: 'Library' });
    await new Promise((r) => setTimeout(r, 20));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(adsenseScript()).toBeNull();
  });

  it('re-reads the libraries and ads while the script is loaded: a team joined elsewhere reloads the page', async () => {
    let libs: LibrarySummary[] = [OWN];
    mockApi((url) => {
      if (url === '/api/v1/ads') return adsResponse(config, []);
      if (url === '/api/v1/libraries') return json(200, { ok: true, libraries: libs });
      return undefined;
    });
    renderAt('/');
    await waitFor(() => expect(adsenseScript()).not.toBeNull());
    const adsCalls = () => calls.filter((c) => c.url === '/api/v1/ads').length;
    const before = adsCalls();
    // Joined a team on the phone: the plan is the same, the libraries aren't.
    libs = [OWN, TEAM_LIB];
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(adsCalls()).toBeGreaterThan(before);
  });

  it('re-checks when another tab reports a team change, and reloads when AdSense is dropped for the member', async () => {
    let adsense: AdsResult['adsense'] = config;
    mockApi((url) => (url === '/api/v1/ads' ? adsResponse(adsense, []) : undefined));
    renderAt('/');
    await waitFor(() => expect(adsenseScript()).not.toBeNull());
    adsense = null;
    const other = new BroadcastChannel('zephyr-session');
    other.postMessage({ type: 'libraries-changed', id: ME });
    await waitFor(() => expect(reload).toHaveBeenCalled());
    other.close();
  });

  it('never shows a secret in a document holding the script: Share continues on /share/new with a full page load', async () => {
    mockApi((url) => (url === '/api/v1/ads' ? adsResponse(config, []) : undefined));
    const router = createMemoryRouter(
      [{ element: routes[0]?.element, children: [{ path: '/', element: <SecretProbe /> }] }],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByRole('heading', { name: 'Probe' });
    expect(screen.getByLabelText(/Passcode 4 8 2 9 1 5/)).toBeTruthy();
    expect(screen.getByText('Secret surface')).toBeTruthy();
    act(() => {
      loadAdsense(PUB);
    });
    await waitFor(() => expect(screen.queryByLabelText(/Passcode/)).toBeNull());
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.queryByText('Secret surface')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Share now' }));
    expect(assign).toHaveBeenCalledWith(SHARE_HANDOFF_PATH, { keepStorage: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    const saved = JSON.parse(sessionStorage.getItem(SHARE_HANDOFF_KEY) ?? 'null');
    expect(saved).toMatchObject({ user: ME, ids: [GID], name: 'Beach day' });
    // /share/new is never an ad page, so the Worker gives it the strict policy.
    expect(adsAllowedOn(SHARE_HANDOFF_PATH)).toBe(false);
  });

  it('/share/new runs the create flow for a fresh hand-off, and nothing for a stale or another member’s', async () => {
    mockApi();
    __resetShareNewForTest();
    sessionStorage.setItem(
      SHARE_HANDOFF_KEY,
      JSON.stringify({ user: ME, ids: [GID.toUpperCase()], name: 'Beach\u0007 day', at: Date.now() }),
    );
    renderAt(SHARE_HANDOFF_PATH);
    expect(await screen.findByText('Share 1 photo')).toBeTruthy();
    expect(sessionStorage.getItem(SHARE_HANDOFF_KEY)).toBeNull();
    cleanup();
    for (const bad of [
      { user: OWNER, ids: [GID], name: '', at: Date.now() },
      { user: ME, ids: [GID], name: '', at: Date.now() - 11 * 60_000 },
      { user: ME, ids: ['../../x'], name: '', at: Date.now() },
      { user: ME, ids: [], name: '', at: Date.now() },
    ]) {
      __resetShareNewForTest();
      sessionStorage.setItem(SHARE_HANDOFF_KEY, JSON.stringify(bad));
      renderAt(SHARE_HANDOFF_PATH);
      expect(await screen.findByText(/nothing to share here/)).toBeTruthy();
      expect(screen.queryByText('Share 1 photo')).toBeNull();
      cleanup();
    }
  });

  it('takeShareHandoff cleans the name and lower-cases ids', () => {
    sessionStorage.setItem(
      SHARE_HANDOFF_KEY,
      JSON.stringify({ user: ME, ids: [GID.toUpperCase(), GID], name: 'A\u0000B', at: 1000 }),
    );
    expect(takeShareHandoff(2000)).toEqual({ ids: [GID], name: 'AB' });
    expect(takeShareHandoff(2000)).toBeNull();
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

// ---------------------------------------------------------------- review round 4: account action links
describe('account action links (passkeys and deletion are made from an emailed link)', () => {
  const PK = { id: 'pk_1', friendlyName: 'Work laptop', createdAt: '2026-10-28T00:00:00Z', lastUsedAt: null };
  const TOKEN = 'T'.repeat(43);
  const peekWith = (op: string, passkeyId: string | null = null) =>
    json(200, { ok: true, op, passkeyId, expiresAt: '2026-11-15T12:00:00Z' });
  const NONCE = 'N'.repeat(22);
  const openLink = (hash = `#t=${TOKEN}`, path = `/account-action/${NONCE}`) => {
    window.history.replaceState(null, '', `${path}${hash}`);
    return renderAt(path);
  };
  beforeEach(() => {
    passkeyMock.create.mockClear();
  });

  it('Settings only asks for the email to remove a passkey; nothing is removed there', async () => {
    mockApi((url, method) => {
      if (url === '/api/v1/me/passkeys' && method === 'GET') return json(200, { ok: true, passkeys: [PK] });
      if (url === '/api/v1/me/account-actions') return json(202, { ok: true });
      return undefined;
    });
    renderAt('/settings/security');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Remove this passkey?' })).getByRole('button', {
        name: 'Email me a link',
      }),
    );
    expect(await screen.findByText(/a link to remove “Work laptop”/)).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/v1/me/account-actions')?.body).toEqual({
      op: 'passkey_remove',
      passkeyId: 'pk_1',
    });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('Settings asks for the email to add a passkey, and never starts the browser prompt', async () => {
    mockApi((url, method) => {
      if (url === '/api/v1/me/passkeys' && method === 'GET') return json(200, { ok: true, passkeys: [PK] });
      if (url === '/api/v1/me/account-actions') return json(202, { ok: true });
      return undefined;
    });
    renderAt('/settings/security');
    fireEvent.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    expect(await screen.findByText(/a link to add a passkey/)).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/v1/me/account-actions')?.body).toEqual({ op: 'passkey_add' });
    expect(calls.some((c) => c.url.includes('/passkeys/options'))).toBe(false);
    expect(passkeyMock.create).not.toHaveBeenCalled();
  });

  it('the link’s page strips the token, shows the change, and removes the passkey with the token', async () => {
    mockApi((url, method) => {
      if (url === '/api/v1/me/account-actions/peek') return peekWith('passkey_remove', 'pk_1');
      if (url === '/api/v1/me/passkeys' && method === 'GET') return json(200, { ok: true, passkeys: [PK] });
      if (url === '/api/v1/me/passkeys/pk_1' && method === 'DELETE')
        return new Response(null, { status: 204 });
      return undefined;
    });
    openLink();
    // The nonce and the token both leave the address bar at once.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/account-action');
    expect(await screen.findByText('Work laptop')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove passkey' }));
    expect(await screen.findByText('Passkey removed')).toBeTruthy();
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.headers.get('X-Zephyr-Account-Action')).toBe(TOKEN);
    expect(calls.find((c) => c.url.endsWith('/peek'))?.body).toEqual({ token: TOKEN });
  });

  it('adding a passkey happens on the link’s page: the token goes with the options, then the device saves it', async () => {
    mockApi((url) => {
      if (url === '/api/v1/me/account-actions/peek') return peekWith('passkey_add');
      if (url === '/api/v1/me/passkeys/options')
        return json(200, { challengeId: 'ch-1', options: { challenge: 'abc' } });
      if (url === '/api/v1/me/passkeys/verify') return json(201, { ok: true, passkey: PK });
      return undefined;
    });
    openLink();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    expect(await screen.findByText('Passkey added')).toBeTruthy();
    const opt = calls.find((c) => c.url === '/api/v1/me/passkeys/options');
    expect(opt?.headers.get('X-Zephyr-Account-Action')).toBe(TOKEN);
    expect(passkeyMock.create).toHaveBeenCalledTimes(1);
    expect(calls.find((c) => c.url === '/api/v1/me/passkeys/verify')?.body).toEqual({
      challengeId: 'ch-1',
      credential: { id: 'cred' },
    });
  });

  it('a link for another account, a used link and a broken link each say what to do', async () => {
    mockApi((url) =>
      url === '/api/v1/me/account-actions/peek'
        ? json(403, { ok: false, error: 'account_action_wrong_member' })
        : undefined,
    );
    openLink();
    expect(await screen.findByText('This link is for another account')).toBeTruthy();
    cleanup();
    mockApi((url) =>
      url === '/api/v1/me/account-actions/peek'
        ? json(400, { ok: false, error: 'account_action_invalid' })
        : undefined,
    );
    openLink();
    expect(await screen.findByText('This link doesn’t work any more')).toBeTruthy();
    cleanup();
    mockApi();
    openLink('#t=<script>');
    expect(await screen.findByText('Open the link from your email')).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/peek'))).toBe(false);
  });

  it('a token on the bare path (no nonce) is never taken: a page could have set that address itself', async () => {
    mockApi((url) => (url.endsWith('/peek') ? peekWith('passkey_add') : undefined));
    openLink(`#t=${TOKEN}`, '/account-action');
    expect(await screen.findByText('Open the link from your email')).toBeTruthy();
    expect(window.location.hash).toBe('');
    expect(calls.some((c) => c.url.endsWith('/peek'))).toBe(false);
    cleanup();
    mockApi((url) => (url.endsWith('/peek') ? peekWith('passkey_add') : undefined));
    openLink(`#t=${TOKEN}`, '/account-action/short');
    expect(await screen.findByText('Open the link from your email')).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/peek'))).toBe(false);
  });

  it('while holding an unspent link, a forged "signed out" broadcast from another tab is ignored', async () => {
    mockApi((url) => (url.endsWith('/peek') ? peekWith('account_delete') : undefined));
    openLink();
    await screen.findByRole('button', { name: 'Delete my account' });
    const other = new BroadcastChannel('zephyr-session');
    other.postMessage({ type: 'session-user', id: null });
    await new Promise((r) => setTimeout(r, 50));
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete my account' })).toBeTruthy();
    // Control: once the page is left (the hold released), the same broadcast ends the session here as usual.
    cleanup();
    mockApi((url, method) =>
      url === '/api/v1/me/passkeys' && method === 'GET' ? json(200, { ok: true, passkeys: [PK] }) : undefined,
    );
    renderAt('/settings/security');
    await screen.findByText('Work laptop');
    other.postMessage({ type: 'session-user', id: null });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/', { sessionEnd: true }));
    other.close();
  });

  it('signed out: asks to sign in as that account, without checking the link', async () => {
    mockApi((url) =>
      url.endsWith('/auth/session') ? json(401, { ok: false, error: 'unauthenticated' }) : undefined,
    );
    openLink();
    expect(await screen.findByText('Sign in to continue')).toBeTruthy();
    expect(window.location.hash).toBe('');
    expect(calls.some((c) => c.url.endsWith('/peek'))).toBe(false);
  });
});

describe('AdSense: holds, the document marker and the storage reset', () => {
  it('reads the Worker’s marker from <head>', () => {
    expect(documentMarker().wide).toBe(false);
    const meta = document.createElement('meta');
    meta.name = 'zephyr-ads';
    meta.content = '1';
    document.head.prepend(meta);
    try {
      expect(documentMarker().wide).toBe(true);
    } finally {
      meta.remove();
    }
  });

  it('never adds Google’s script while something holds it (a gallery being created or just created)', () => {
    __resetAdsForTest('/', true);
    const release = holdAdsense();
    const second = holdAdsense();
    expect(adsenseHeld()).toBe(true);
    expect(loadAdsense(PUB)).toBe(false);
    release();
    release();
    expect(loadAdsense(PUB)).toBe(false);
    second();
    expect(adsenseHeld()).toBe(false);
    expect(loadAdsense(PUB)).toBe(true);
  });

  it('holds the script while the create dialog is open', async () => {
    mockApi();
    const router = createMemoryRouter(
      [{ element: routes[0]?.element, children: [{ path: '/', element: <SecretProbe /> }] }],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByRole('heading', { name: 'Probe' });
    fireEvent.click(screen.getByRole('button', { name: 'Share now' }));
    await screen.findByRole('dialog');
    expect(adsenseHeld()).toBe(true);
    expect(loadAdsense(PUB)).toBe(false);
    cleanup();
    expect(adsenseHeld()).toBe(false);
  });

  it('asks the server to clear the site’s storage: always with the script, and on a session end only if it ever ran', async () => {
    mockApi((url) => (url === '/api/v1/ads/reset' ? new Response(null, { status: 204 }) : undefined));
    __resetAdsForTest('/', true);
    expect(resetSiteForAdsense({ sessionEnd: false })).toBeNull();
    await resetSiteForAdsense({ sessionEnd: true });
    expect(calls.at(-1)).toMatchObject({ url: '/api/v1/ads/reset', method: 'POST', body: { ifSeen: true } });
    loadAdsense(PUB);
    await resetSiteForAdsense({ sessionEnd: false });
    expect(calls.at(-1)).toMatchObject({ url: '/api/v1/ads/reset', method: 'POST', body: {} });
  });
});
