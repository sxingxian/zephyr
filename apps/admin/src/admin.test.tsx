import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from './App';
import { parseEmailList, parseEmailsCsv } from './lib/csv';
import { diffSettings } from './routes/Signups';

const SETTINGS = {
  signupMode: 'invite_only',
  acceptInviteRequests: true,
  signupsPaused: false,
  memberInvitesEnabled: true,
  memberInvitesPerMonth: 3,
  inviteTtlDays: 7,
} as const;
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
      if (url.endsWith('/signups'))
        return json(200, { ok: true, settings: SETTINGS, pendingRequests: 2, pendingInvites: 1, codes: [] });
      if (url.includes('/signups/requests?'))
        return json(200, {
          ok: true,
          nextCursor: null,
          items: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              email: 'aisha.r@example.com',
              useCase: 'weddings_events',
              disposable: false,
              status: 'pending',
              createdAt: '2026-10-28T00:41:00Z',
            },
            {
              id: '22222222-2222-4222-8222-222222222222',
              email: 'x9q2@mailinator.example',
              useCase: null,
              disposable: true,
              status: 'pending',
              createdAt: '2026-10-27T16:55:00Z',
            },
          ],
        });
      if (url.includes('/signups/invites')) return json(200, { ok: true, nextCursor: null, items: [] });
      if (url.endsWith('/signups/settings')) return json(200, { ...SETTINGS, ...(c.body as object) });
      if (url.endsWith('/requests/decide')) return json(200, { ok: true, approved: 1, declined: 0 });
      return json(404, { ok: false, error: 'not_found' });
    }),
  );
}
const renderAt = (path: string) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CSV import', () => {
  it('uses the email column when there is a header', () => {
    const r = parseEmailsCsv(
      'Name,Email\n"Tan, Wei",WEI@example.com\nMei,mei@example.com\nBad,not-an-email\n',
    );
    expect(r.emails).toEqual(['wei@example.com', 'mei@example.com']);
    expect(r.invalid).toEqual(['not-an-email']);
  });
  it('falls back to the first column, de-duplicates and caps at 50', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `u${i}@example.com`).join('\n');
    const r = parseEmailsCsv(`a@example.com\na@example.com\n${rows}`);
    expect(r.emails).toHaveLength(50);
    expect(r.overflow).toBe(11);
  });
  it('parses pasted lists', () => {
    expect(parseEmailList('a@x.co, b@x.co\nc@x.co ; nope').emails).toEqual(['a@x.co', 'b@x.co', 'c@x.co']);
  });
});

describe('diffSettings', () => {
  it('returns only changed fields', () => {
    expect(diffSettings(SETTINGS, { ...SETTINGS, inviteTtlDays: 14 })).toEqual({ inviteTtlDays: 14 });
    expect(diffSettings(SETTINGS, SETTINGS)).toEqual({});
  });
});

describe('Sign-ups page', () => {
  it('shows invite-only as the default and saves only what changed', async () => {
    mock('owner');
    renderAt('/signups');
    expect(await screen.findByText('Default', {}, { timeout: 4000 })).toBeTruthy();
    const ttl = (await screen.findByLabelText(/Invites expire after/)) as HTMLInputElement;
    fireEvent.change(ttl, { target: { value: '14' } });
    await act(async () => screen.getByRole('button', { name: 'Save' }).click());
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ inviteTtlDays: 14 }));
  });
  it('asks Owners for a reason before switching the sign-up mode', async () => {
    mock('owner');
    renderAt('/signups');
    await screen.findByText('Default');
    await act(async () => (screen.getByRole('radio', { name: /Open/ }) as HTMLInputElement).click());
    await act(async () => screen.getByRole('button', { name: 'Save' }).click());
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Launch day' } });
    await act(async () => screen.getByRole('button', { name: 'Save change', hidden: true }).click());
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        signupMode: 'open',
        reason: 'Launch day',
      }),
    );
  });
  it('lets only Owners change the mode', async () => {
    mock('admin');
    renderAt('/signups');
    await screen.findByText('Default');
    expect((screen.getByRole('radio', { name: /Open/ }) as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole('switch', { name: /Pause all new sign-ups/ }) as HTMLInputElement).disabled,
    ).toBe(false);
  });
  it('is read-only for support staff', async () => {
    mock('support');
    renderAt('/signups');
    expect(await screen.findByText('Read-only for your role')).toBeTruthy();
    expect(
      ((await screen.findByRole('switch', { name: /Pause all new sign-ups/ })) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
  it('approves the selected requests in one call', async () => {
    mock('owner');
    renderAt('/signups');
    const box = await screen.findByRole('checkbox', { name: 'Select aisha.r@example.com' });
    await act(async () => (box as HTMLInputElement).click());
    await act(async () => screen.getByRole('button', { name: /Approve selected/ }).click());
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/requests/decide'))?.body).toEqual({
        ids: ['11111111-1111-4111-8111-111111111111'],
        decision: 'approve',
      }),
    );
    expect(screen.getByText('Disposable email')).toBeTruthy();
  });
  it('sends staff without a session to sign-in, and enrol-only sessions to enrolment', async () => {
    mock('owner', (c) =>
      c.url.endsWith('/auth/session') ? json(401, { ok: false, error: 'unauthenticated' }) : undefined,
    );
    const r = renderAt('/signups');
    await waitFor(() => expect(r.state.location.pathname).toBe('/sign-in'));
    cleanup();
    mock('owner', (c) =>
      c.url.endsWith('/auth/session')
        ? json(200, {
            ok: true,
            staff: { id: 's1', email: 'j@m.studio', role: 'owner', displayName: null },
            enrolOnly: true,
          })
        : undefined,
    );
    const r2 = renderAt('/signups');
    await waitFor(() => expect(r2.state.location.pathname).toBe('/enrol'));
    expect(await screen.findByText('Save your passkey')).toBeTruthy();
  });
});
