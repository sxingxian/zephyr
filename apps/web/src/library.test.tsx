import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PhotoItem } from '@zephyr/shared/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './App';
import { viewerKey } from './components/Viewer';
import { dayLabel, daysLeft, exposure } from './lib/format';
import { gridMove, rangeSelect } from './lib/selection';
import { resetUsage } from './lib/usage';

const USER = {
  id: 'u1',
  email: 'mei.ong@example.com',
  displayName: 'Mei Ong',
  plan: 'free',
  passkeyCount: 1,
  createdAt: '2026-10-01T00:00:00Z',
};
const USAGE = {
  ok: true,
  usedBytes: 3_100_000_000,
  reservedBytes: 0,
  limitBytes: 5_000_000_000,
  trashBytes: 0,
  photoCount: 3,
  plan: 'free',
  fileTypes: ['jpeg', 'png', 'webp'],
  maxFileBytes: 50_000_000,
  batchSize: 50,
};
const photo = (id: string, takenAt: string, extra: Partial<PhotoItem> = {}): PhotoItem => ({
  id,
  filename: `IMG_${id}.JPG`,
  fileType: 'jpeg',
  sizeBytes: 8_100_000,
  width: 6000,
  height: 4000,
  takenAt,
  createdAt: '2026-10-28T01:00:00Z',
  favourite: false,
  hasThumb: true,
  hasPreview: true,
  ...extra,
});
const PHOTOS = [
  photo('p1', '2026-10-24T15:42:00+08:00'),
  photo('p2', '2026-10-24T15:40:00+08:00', { favourite: true }),
  photo('p3', '2026-10-11T09:00:00+08:00'),
];
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: string, method: string, body: unknown) => Response | undefined;
let calls: { url: string; method: string; body: unknown }[] = [];
function mockApi(handler: Handler) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const r = handler(url, method, body);
      if (r) return r;
      if (url.endsWith('/auth/session')) return json(200, { ok: true, user: USER });
      if (url.endsWith('/me/usage')) return json(200, USAGE);
      if (url.startsWith('/api/v1/photos?')) return json(200, { ok: true, items: PHOTOS, nextCursor: null });
      const m = url.match(/^\/api\/v1\/photos\/([^/?]+)$/);
      if (m) {
        const p = PHOTOS.find((x) => x.id === m[1]);
        return p
          ? json(200, {
              ok: true,
              photo: { ...p, metadata: { cameraMake: 'Canon', cameraModel: 'EOS R6' }, albums: [] },
            })
          : json(404, { ok: false, error: 'not_found' });
      }
      return json(200, { ok: true });
    }),
  );
}
function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  resetUsage();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('selection', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  it('shift-click selects the range from the anchor, in either direction', () => {
    expect([...rangeSelect(ids, 1, 4, new Set())]).toEqual(['b', 'c', 'd', 'e']);
    expect([...rangeSelect(ids, 4, 1, new Set())].sort()).toEqual(['b', 'c', 'd', 'e']);
  });
  it('keeps what was already selected outside the range', () => {
    const r = rangeSelect(ids, 3, 4, new Set(['a']));
    expect([...r].sort()).toEqual(['a', 'd', 'e']);
  });
  it('clamps to the list', () => {
    expect([...rangeSelect(ids, 4, 99, new Set())]).toEqual(['e', 'f']);
  });
});

describe('grid keyboard', () => {
  // Two days: 5 photos in rows of 3, then 2 photos.
  const layout = [
    [0, 1, 2],
    [3, 4],
    [5, 6],
  ];
  it('moves left and right through the whole list', () => {
    expect(gridMove(layout, 2, 'ArrowRight')).toBe(3);
    expect(gridMove(layout, 3, 'ArrowLeft')).toBe(2);
    expect(gridMove(layout, 0, 'ArrowLeft')).toBe(0);
    expect(gridMove(layout, 6, 'ArrowRight')).toBe(6);
  });
  it('moves up and down by visual row, landing on the last tile of a short row', () => {
    expect(gridMove(layout, 1, 'ArrowDown')).toBe(4);
    expect(gridMove(layout, 2, 'ArrowDown')).toBe(4);
    expect(gridMove(layout, 4, 'ArrowDown')).toBe(6);
    expect(gridMove(layout, 6, 'ArrowUp')).toBe(4);
    expect(gridMove(layout, 0, 'ArrowUp')).toBe(0);
    expect(gridMove(layout, 4, 'Home')).toBe(0);
    expect(gridMove(layout, 0, 'End')).toBe(6);
  });
});

describe('viewer keyboard', () => {
  it('maps arrows, I and Escape', () => {
    expect(viewerKey('ArrowRight', 0, 3)).toEqual({ type: 'go', to: 1 });
    expect(viewerKey('ArrowRight', 2, 3)).toBeNull();
    expect(viewerKey('ArrowLeft', 0, 3)).toBeNull();
    expect(viewerKey('ArrowLeft', 2, 3)).toEqual({ type: 'go', to: 1 });
    expect(viewerKey('i', 1, 3)).toEqual({ type: 'info' });
    expect(viewerKey('I', 1, 3)).toEqual({ type: 'info' });
    expect(viewerKey('Escape', 1, 3)).toEqual({ type: 'close' });
    expect(viewerKey('x', 1, 3)).toBeNull();
  });

  it('opens from the grid in place, steps with the arrow keys, toggles info and closes with Back', async () => {
    mockApi(() => undefined);
    const router = renderAt('/');
    const tile = await screen.findByRole('button', { name: /Open IMG_p1\.JPG/ });
    fireEvent.click(tile);
    await waitFor(() => expect(router.state.location.pathname).toBe('/photo/p1'));
    // The grid stays mounted underneath.
    expect(document.querySelector('.pgrid .tile[data-index="1"]')).toBeTruthy();
    const dialog = document.querySelector('dialog.viewer') as HTMLElement;
    expect(dialog).toBeTruthy();
    await screen.findByText('1 of 3 · Sat 24 Oct, 15:42');

    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/photo/p2'));
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/photo/p3'));
    fireEvent.keyDown(dialog, { key: 'ArrowRight' }); // last photo: stays
    expect(router.state.location.pathname).toBe('/photo/p3');
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/photo/p2'));

    const infoOpen = Boolean(document.querySelector('.viewer__info'));
    fireEvent.keyDown(dialog, { key: 'i' });
    expect(Boolean(document.querySelector('.viewer__info'))).toBe(!infoOpen);

    // Steps replaced the history entry, so Back returns to the grid.
    fireEvent.click(screen.getByRole('button', { name: 'Library', hidden: true }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(document.querySelector('dialog.viewer')).toBeNull();
  });

  it('never shows location: the info panel says it is not read', async () => {
    mockApi(() => undefined);
    renderAt('/photo/p1');
    const dialog = (await screen.findByText('IMG_p1.JPG', { selector: '.viewer__name' })).closest(
      'dialog',
    ) as HTMLElement;
    if (!document.querySelector('.viewer__info')) fireEvent.keyDown(dialog, { key: 'i' });
    expect(await screen.findByText(/Zephyr doesn’t read or show it/)).toBeTruthy();
    expect(screen.queryByText(/latitude|GPS/i)).toBeNull();
  });
});

describe('pending deletion', () => {
  const PENDING = { ...USER, pendingDeletion: { purgeAt: '2026-11-27T00:00:00Z' } };

  it('routes every signed-in page to the restore screen, and Restore brings the library back', async () => {
    let restored = false;
    mockApi((url, method) => {
      if (url.endsWith('/auth/session')) return json(200, { ok: true, user: restored ? USER : PENDING });
      if (url.endsWith('/me/restore') && method === 'POST') {
        restored = true;
        return json(200, { ok: true, user: USER });
      }
      if (!restored && url.startsWith('/api/v1/') && !url.endsWith('/auth/session'))
        return json(403, { ok: false, error: 'account_pending_deletion' });
      return undefined;
    });
    const router = renderAt('/albums');
    expect(await screen.findByText('Restore your account?')).toBeTruthy();
    expect(screen.getByText(/Your photos are kept until/)).toBeTruthy();
    expect(screen.getByText('27 Nov')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/albums');
    // No library requests while the account is scheduled for deletion.
    expect(calls.some((c) => c.url.startsWith('/api/v1/photos'))).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore my account' }));
    });
    await waitFor(() => expect(screen.queryByText('Restore your account?')).toBeNull());
    expect(calls.some((c) => c.url.endsWith('/me/restore') && c.method === 'POST')).toBe(true);
    expect(await screen.findAllByText('Albums')).toBeTruthy();
  });

  it('signs out from "Keep it deleted"', async () => {
    mockApi((url) => (url.endsWith('/auth/session') ? json(200, { ok: true, user: PENDING }) : undefined));
    const router = renderAt('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Keep it deleted and sign out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(calls.some((c) => c.url.endsWith('/auth/sign-out') && c.method === 'POST')).toBe(true);
  });

  it('re-checks the session when any call answers account_pending_deletion', async () => {
    let pending = false;
    mockApi((url) => {
      if (url.endsWith('/auth/session')) return json(200, { ok: true, user: pending ? PENDING : USER });
      if (url.startsWith('/api/v1/photos?')) {
        pending = true;
        return json(403, { ok: false, error: 'account_pending_deletion' });
      }
      return undefined;
    });
    renderAt('/');
    expect(await screen.findByText('Restore your account?')).toBeTruthy();
  });
});

describe('delete account', () => {
  it('needs DELETE typed, then signs out to the confirmation', async () => {
    mockApi((url, method) => {
      if (url.endsWith('/me/passkeys')) return json(200, { passkeys: [] });
      if (url.endsWith('/me/delete') && method === 'POST')
        return json(200, { ok: true, purgeAt: '2026-11-27T00:00:00Z' });
      return undefined;
    });
    const router = renderAt('/settings/security');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete account' }));
    const confirm = screen
      .getAllByRole('button', { name: 'Delete account', hidden: true })
      .at(-1) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'delete' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/account-deleted'));
    expect(calls.find((c) => c.url.endsWith('/me/delete'))?.body).toEqual({ confirm: 'DELETE' });
    expect(await screen.findByText('Your account is closed')).toBeTruthy();
  });

  it('sends a stale sign-in to sign in again and back to this dialog', async () => {
    mockApi((url) => {
      if (url.endsWith('/me/passkeys')) return json(200, { passkeys: [] });
      if (url.endsWith('/me/delete')) return json(403, { ok: false, error: 'reauth_required' });
      return undefined;
    });
    const router = renderAt('/settings/security');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete account' }));
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
    const confirm = screen
      .getAllByRole('button', { name: 'Delete account', hidden: true })
      .at(-1) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(router.state.location.search).toBe(
      `?reauth=1&next=${encodeURIComponent('/settings/security?delete=1')}`,
    );
    // The sign-in form shows even though there's still a session.
    expect(await screen.findByText('Sign in to Zephyr')).toBeTruthy();
  });
});

describe('formatting', () => {
  it('labels days and exposure like the mockups', () => {
    const now = new Date(2026, 9, 28, 12);
    expect(dayLabel('2026-10-28', now)).toBe('Today');
    expect(dayLabel('2026-10-27', now)).toBe('Yesterday');
    expect(dayLabel('2026-10-24', now)).toBe('Saturday, 24 Oct');
    expect(dayLabel('2025-10-24', now)).toBe('Friday, 24 Oct 2025');
    expect(exposure(0.002)).toBe('1/500 s');
    expect(exposure(2)).toBe('2 s');
    expect(daysLeft('2026-10-29T12:00:00Z', Date.parse('2026-10-28T12:00:00Z'))).toBe(1);
  });
});
