import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LibrarySummary } from '@zephyr/shared/client';
import { ToastProvider } from '@zephyr/ui';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './App';
import { ChangePlanDialog } from './components/billing/BillingDialogs';
import { resetAiStatus } from './lib/aiClient';
import { api } from './lib/api';
import { isStripeUrl, leave, pricesFrom, resetPrices } from './lib/billing';
import { thumbUrl } from './lib/library';
import {
  __setActiveForTest,
  activeOwner,
  libraryHeaders,
  resetLibraryContext,
  setLibraries,
  switchLibrary,
  takeLibraryNotice,
  withLibrary,
} from './lib/libraryContext';
import { browser, onSessionEnd, setSessionUserId } from './lib/sessionGuard';
import { uploads } from './lib/uploads';
import { forgetTeamInviteToken } from './routes/TeamAccept';

const ME = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const USER = {
  id: ME,
  email: 'jun@example.com',
  displayName: 'Jun Hao',
  plan: 'free',
  passkeyCount: 1,
  createdAt: '2026-10-28T00:00:00Z',
};
const OWN: LibrarySummary = {
  ownerId: ME,
  name: 'Jun Hao',
  ownerName: 'Jun Hao',
  role: 'owner',
  plan: 'free',
  state: 'active',
  initials: 'JH',
};
const TEAM = (role: LibrarySummary['role']): LibrarySummary => ({
  ownerId: OWNER,
  name: 'Tan Studio',
  ownerName: 'Mei Lin',
  role,
  plan: 'studio',
  state: 'active',
  initials: 'TS',
});

const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
let calls: Call[] = [];
type Handler = (url: string, method: string, body: unknown) => Response | undefined;
function mockApi(handler: Handler = () => undefined, libraries: LibrarySummary[] = [OWN]) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body, headers: (init?.headers ?? {}) as Record<string, string> });
      const r = handler(url, method, body);
      if (r) return r;
      if (url.endsWith('/auth/session')) return json(200, { ok: true, user: USER });
      if (url === '/api/v1/libraries') return json(200, { ok: true, libraries });
      if (url === '/api/v1/ai') return json(404, { ok: false, error: 'not_found' });
      if (url.endsWith('/me/usage'))
        return json(200, {
          ok: true,
          usedBytes: 1,
          reservedBytes: 0,
          limitBytes: 1e12,
          trashBytes: 0,
          photoCount: 0,
          plan: 'studio',
          fileTypes: ['jpeg'],
          maxFileBytes: 1e8,
          batchSize: 500,
        });
      if (url.startsWith('/api/v1/photos?')) return json(200, { ok: true, items: [], nextCursor: null });
      return json(200, { ok: true });
    }),
  );
}
function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

let assign: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  window.history.replaceState(null, '', '/');
  sessionStorage.clear();
  setSessionUserId(ME);
  assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetAiStatus();
  resetPrices();
  resetLibraryContext();
  __setActiveForTest(null, null);
  forgetTeamInviteToken();
  setSessionUserId(null);
});

// ---------------------------------------------------------------- library context
describe('library context', () => {
  it('names the team library on API calls and media URLs, and nothing in the own library', async () => {
    expect(activeOwner()).toBeNull();
    expect(libraryHeaders()).toEqual({});
    expect(thumbUrl('p1')).toBe('/api/v1/photos/p1/thumb');
    __setActiveForTest(ME, OWNER);
    expect(activeOwner()).toBe(OWNER);
    expect(libraryHeaders()).toEqual({ 'X-Zephyr-Library': OWNER });
    expect(thumbUrl('p1', 3)).toBe(`/api/v1/photos/p1/thumb?e=3&library=${OWNER}`);
    expect(withLibrary('/x')).toBe(`/x?library=${OWNER}`);
    mockApi();
    await api('/api/v1/albums');
    expect(calls[0]?.headers['X-Zephyr-Library']).toBe(OWNER);
  });

  it('is bound to the member who chose it', () => {
    __setActiveForTest('someone-else', OWNER);
    expect(activeOwner()).toBeNull();
  });

  it('switching clears the upload queue and every session-bound cache, then reloads', async () => {
    const reset = vi.spyOn(uploads, 'reset');
    const hook = vi.fn();
    const off = onSessionEnd(hook);
    await switchLibrary(OWNER);
    off();
    expect(hook).toHaveBeenCalledWith({ reason: 'library', server: true });
    expect(reset).toHaveBeenCalledWith({ server: true });
    expect(activeOwner()).toBe(OWNER);
    expect(assign).toHaveBeenCalledWith('/');
  });

  it('a 403 library_unavailable falls back to the own library with a notice', async () => {
    __setActiveForTest(ME, OWNER);
    mockApi((url) =>
      url === '/api/v1/albums' ? json(403, { ok: false, error: 'library_unavailable' }) : undefined,
    );
    await expect(api('/api/v1/albums')).rejects.toMatchObject({ code: 'library_unavailable' });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    expect(activeOwner()).toBeNull();
    expect(takeLibraryNotice()).toBe('unavailable');
    expect(takeLibraryNotice()).toBeNull();
  });

  it('signing out forgets the team library', async () => {
    __setActiveForTest(ME, OWNER);
    const { endSession } = await import('./lib/sessionGuard');
    await endSession('sign-out', false);
    expect(activeOwner()).toBeNull();
  });
});

// ---------------------------------------------------------------- plans and pricing
describe('plans', () => {
  it('shows live prices from the server', async () => {
    mockApi((url) => {
      if (url === '/api/v1/public/pricing')
        return json(200, {
          ok: true,
          prices: [
            { plan: 'pro', interval: 'month', amount: 1299 },
            { plan: 'pro', interval: 'year', amount: 12900 },
            { plan: 'studio', interval: 'month', amount: 2999 },
            { plan: 'studio', interval: 'year', amount: 29900 },
          ],
          packs: [{ lookupKey: 'zephyr_topup_500', credits: 500, amount: 600 }],
        });
      if (url === '/api/v1/billing')
        return json(200, {
          ok: true,
          plan: 'free',
          subscription: null,
          state: 'active',
          storage: { usedBytes: 1, limitBytes: 5e9 },
          packs: [],
          hasCustomer: false,
        });
      return undefined;
    });
    renderAt('/plans');
    expect(await screen.findByText('$12.99')).toBeTruthy();
    expect(screen.getByText('$29.99')).toBeTruthy();
    expect(screen.getByText(/\$6 · 500 credits/)).toBeTruthy();
    // Yearly: 12 × 12.99 − 129 ≈ 2 months free.
    expect(screen.getByText('Yearly · 2 months free')).toBeTruthy();
  });

  it('falls back to built-in prices and merges partial live data', () => {
    const p = pricesFrom({
      ok: true,
      prices: [{ plan: 'studio', interval: 'year', amount: 25900 }],
      packs: [],
    });
    expect(p.plans.studio.year).toBe(25900);
    expect(p.plans.pro.month).toBe(999);
    expect(p.live).toBe(true);
  });

  it('only ever leaves for Stripe', () => {
    expect(isStripeUrl('https://checkout.stripe.com/c/pay/cs_test_x')).toBe(true);
    expect(isStripeUrl('https://invoice.stripe.com/i/acct/x')).toBe(true);
    expect(isStripeUrl('https://evil.example/checkout.stripe.com')).toBe(false);
    expect(isStripeUrl('http://checkout.stripe.com/x')).toBe(false);
    expect(() => leave.to('https://evil.example')).toThrow();
  });
});

describe('upgrade dialog', () => {
  it('shows the preview, then opens the Stripe invoice when the card needs confirming', async () => {
    const to = vi.spyOn(leave, 'to').mockImplementation(() => {});
    mockApi((url) => {
      if (url === '/api/v1/billing/change/preview')
        return json(200, {
          ok: true,
          kind: 'upgrade',
          lines: [
            { description: 'Studio · rest of this month', amount: 1620 },
            { description: 'Unused Pro time', amount: -666 },
          ],
          dueNow: { amount: 954, currency: 'usd' },
          effectiveAt: '2026-11-14T00:00:00Z',
          effects: {
            storageGb: { from: 250, to: 1000 },
            seats: { from: 1, to: 3 },
            lost: [],
            teammatesLosingAccess: 0,
            overStorage: false,
          },
        });
      if (url === '/api/v1/billing/change')
        return json(200, {
          ok: true,
          plan: 'pro',
          subscription: null,
          state: 'active',
          storage: { usedBytes: 1, limitBytes: 1 },
          packs: [],
          hasCustomer: true,
          actionUrl: 'https://invoice.stripe.com/i/acct_1/test',
        });
      return undefined;
    });
    const onDone = vi.fn();
    const target = { plan: 'studio' as const, interval: 'month' as const };
    render(
      <ToastProvider>
        <ChangePlanDialog
          open
          target={target}
          current={{ plan: 'pro', interval: 'month' }}
          onClose={() => {}}
          onDone={onDone}
        />
      </ToastProvider>,
    );
    expect(await screen.findByText('Studio · rest of this month')).toBeTruthy();
    expect(screen.getByText('−US$6.66')).toBeTruthy();
    const pay = screen.getByRole('button', { name: 'Pay US$9.54 and upgrade' });
    await act(async () => {
      fireEvent.click(pay);
    });
    await waitFor(() => expect(to).toHaveBeenCalledWith('https://invoice.stripe.com/i/acct_1/test'));
    expect(calls.find((c) => c.url === '/api/v1/billing/change')?.body).toEqual(target);
    expect(onDone).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- roles
describe('viewer in a team library', () => {
  it('hides write actions and shows the view-only notice', async () => {
    __setActiveForTest(ME, OWNER);
    mockApi(undefined, [OWN, TEAM('viewer')]);
    setLibraries([OWN, TEAM('viewer')]);
    renderAt('/trash');
    expect(await screen.findByText('You’re viewing Tan Studio')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Empty Trash' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore all' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Uploading isn’t available in this library' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('an editor restores but cannot empty Trash', async () => {
    __setActiveForTest(ME, OWNER);
    mockApi(undefined, [OWN, TEAM('editor')]);
    setLibraries([OWN, TEAM('editor')]);
    renderAt('/trash');
    expect(await screen.findByRole('button', { name: 'Restore all' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Empty Trash' })).toBeNull();
  });
});

// ---------------------------------------------------------------- invite accept
describe('team invite accept', () => {
  it('takes the token out of the address bar, previews, accepts and opens the team library', async () => {
    const token = 'A'.repeat(43);
    window.history.replaceState(null, '', `/team/accept#token=${token}`);
    mockApi((url, method) => {
      if (url === '/api/v1/team/invite/preview')
        return json(200, {
          ok: true,
          invite: {
            teamName: 'Tan Studio',
            ownerName: 'Mei Lin',
            role: 'editor',
            emailHint: 'j•••@example.com',
            needsAccount: false,
          },
        });
      if (url === '/api/v1/team/invite/accept' && method === 'POST')
        return json(200, { ok: true, libraries: [OWN, TEAM('editor')] });
      return undefined;
    });
    renderAt('/team/accept');
    const accept = await screen.findByRole('button', { name: 'Accept and open Tan Studio' });
    expect(window.location.hash).toBe('');
    await act(async () => {
      fireEvent.click(accept);
    });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    expect(calls.find((c) => c.url === '/api/v1/team/invite/preview')?.body).toEqual({ token });
    expect(calls.find((c) => c.url === '/api/v1/team/invite/accept')?.body).toEqual({ token });
    expect(activeOwner()).toBe(OWNER);
  });

  it('says so when the invite is unusable', async () => {
    window.history.replaceState(null, '', `/team/accept#token=${'B'.repeat(43)}`);
    mockApi((url) =>
      url === '/api/v1/team/invite/preview' ? json(404, { ok: false, error: 'invite_invalid' }) : undefined,
    );
    renderAt('/team/accept');
    expect(await screen.findByText('This invite link doesn’t work')).toBeTruthy();
  });
});
