import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './App';
import { forgetInviteToken, takeInviteToken } from './routes/Join';

const USER = {
  id: 'u1',
  email: 'wei.tan@example.com',
  displayName: 'Wei Tan',
  plan: 'free',
  passkeyCount: 0,
  createdAt: '2026-10-28T00:00:00Z',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let calls: { url: string; body: unknown }[] = [];
function mockApi(handler: (url: string, body: unknown) => Response) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      return handler(url, body);
    }),
  );
}
function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  forgetInviteToken();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('route guards', () => {
  it('sends signed-out visitors to sign-in with a return path', async () => {
    mockApi(() => json(401, { ok: false, error: 'unauthenticated' }));
    const router = renderAt('/settings/security');
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(router.state.location.search).toBe('?next=%2Fsettings%2Fsecurity');
  });
  it('sends signed-in members away from sign-in to a safe next path', async () => {
    mockApi((url) =>
      url.endsWith('/auth/session') ? json(200, { ok: true, user: USER }) : json(200, { passkeys: [] }),
    );
    const router = renderAt('/sign-in?next=%2F%2Fevil.example');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
  it('shows the library to members', async () => {
    mockApi(() => json(200, { ok: true, user: USER }));
    renderAt('/');
    expect(await screen.findByText('Your library is ready for its first shoot')).toBeTruthy();
  });
});

describe('/join', () => {
  const TOKEN = `${'A'.repeat(20) + 'b'.repeat(20)}_-9`;
  it('takes the token from the fragment and strips it from the address bar', () => {
    window.history.replaceState(null, '', `/join#t=${TOKEN}`);
    expect(takeInviteToken()).toBe(TOKEN);
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
    // Calling again (React's double render) still returns it.
    expect(takeInviteToken()).toBe(TOKEN);
  });
  it('sends the token only in the preview body, never in a URL', async () => {
    window.history.replaceState(null, '', `/join#t=${TOKEN}`);
    mockApi((url) =>
      url.endsWith('/invites/preview')
        ? json(200, {
            ok: true,
            email: 'wei.tan@example.com',
            inviterName: 'Mei Lin',
            expiresAt: '2026-11-03T00:00:00Z',
          })
        : json(401, { ok: false, error: 'unauthenticated' }),
    );
    renderAt('/join');
    expect(await screen.findByText('Mei Lin invited you to Zephyr')).toBeTruthy();
    expect((screen.getByLabelText('Your email') as HTMLInputElement).value).toBe('wei.tan@example.com');
    const preview = calls.find((c) => c.url.endsWith('/invites/preview'));
    expect(preview?.body).toEqual({ token: TOKEN });
    for (const c of calls) expect(c.url).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
  });
  it('explains an expired or used invite without saying which', async () => {
    window.history.replaceState(null, '', `/join#t=${TOKEN}`);
    mockApi(() => json(404, { ok: false, error: 'invite_invalid' }));
    renderAt('/join');
    expect(await screen.findByText('This invite link doesn’t work')).toBeTruthy();
  });
  it('handles a link without a token', async () => {
    mockApi(() => json(401, { ok: false, error: 'unauthenticated' }));
    renderAt('/join');
    expect(await screen.findByText(/looks incomplete/)).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/invites/'))).toBe(false);
  });
  it('redeems and continues to passkey setup', async () => {
    window.history.replaceState(null, '', `/join#t=${TOKEN}`);
    mockApi((url) => {
      if (url.endsWith('/invites/preview'))
        return json(200, {
          ok: true,
          email: 'wei.tan@example.com',
          inviterName: null,
          expiresAt: '2026-11-03T00:00:00Z',
        });
      if (url.endsWith('/invites/redeem')) return json(200, { ok: true, user: USER, isNew: true });
      if (url.endsWith('/auth/session')) return json(401, { ok: false, error: 'unauthenticated' });
      return json(200, {});
    });
    const router = renderAt('/join');
    const btn = await screen.findByRole('button', { name: 'Create my account' });
    await act(async () => btn.click());
    await waitFor(() => expect(router.state.location.pathname).toBe('/welcome/passkey'));
    expect(calls.find((c) => c.url.endsWith('/invites/redeem'))?.body).toEqual({ token: TOKEN });
  });
});
