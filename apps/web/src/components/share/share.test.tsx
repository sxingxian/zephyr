import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Branding, GalleryCreated, SharingLimits } from '@zephyr/shared/client';
import { ToastProvider } from '@zephyr/ui';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../../lib/api';
import { csvCell, toCsv } from '../../lib/csv';
import { setSessionUserId } from '../../lib/sessionGuard';
import { assetInUseMessage, isoDay, watermarkKindInUseMessage, watermarkReady } from '../../lib/share';
import { ShareRenderQueue } from '../../lib/shareRenders';
import { refreshUsage, resetUsage } from '../../lib/usage';
import { drawTextWatermark, WATERMARK_FONT_PX } from '../../lib/watermark';
import { favouritesCsv, galleryNotices } from '../../routes/Gallery';
import { CreateGalleryDialog, ExtrasSwitches, GalleryLiveDialog, useShareGallery } from './ShareDialogs';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const FREE: SharingLimits = {
  galleries: 3,
  liveGalleries: 1,
  maxLinkDays: 7,
  guestFullRes: false,
  guestFavourites: false,
  watermark: false,
  branding: false,
  accessLog: false,
};
const STUDIO: SharingLimits = {
  galleries: null,
  liveGalleries: 6,
  maxLinkDays: null,
  guestFullRes: true,
  guestFavourites: true,
  watermark: true,
  branding: true,
  accessLog: true,
};
const usage = (plan: string, sharing: SharingLimits) => ({
  ok: true,
  usedBytes: 1,
  reservedBytes: 0,
  limitBytes: 5_000_000_000,
  trashBytes: 0,
  photoCount: 3,
  plan,
  fileTypes: ['jpeg'],
  maxFileBytes: 50_000_000,
  batchSize: 25,
  sharing,
});
const BRANDING = {
  studioName: 'Mei Lin Photography',
  accent: '#7A3940',
  hasLogo: false,
  watermark: { kind: 'text', text: null, position: 'bottom-right', opacity: 70, hasImage: false },
  updatedAt: null,
};
const CREATED: GalleryCreated = {
  ok: true,
  url: 'https://zephyrapp.midnightpoetry.studio/g/k7Qx2mVb9RtL4wNp8sZcJ3dF6hYq1aE0-_abcdefghi',
  passcode: '042719',
  gallery: {
    id: '7d3f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
    name: 'Tan & Wei',
    status: 'live',
    photoCount: 12,
    coverPhotoId: null,
    passcode: true,
    downloads: 'web',
    expiresAt: '2026-12-01T23:59:59Z',
    pausedUntil: null,
    views: 0,
    favourites: 0,
    createdAt: '2026-11-01T00:00:00Z',
    message: null,
    extras: { favourites: false, watermark: false, branding: false, accessLog: false },
    linkHint: '/g/k7Qx2m…',
    pendingRenders: 0,
    revokedAt: null,
  },
};

let calls: { url: string; method: string; body: unknown }[] = [];
function mockApi(u: unknown, extra?: (url: string, method: string) => Response | undefined) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const r = extra?.(url, method);
      if (r) return r;
      if (url.endsWith('/me/usage')) return json(200, u);
      if (url.endsWith('/me/branding')) return json(200, { ok: true, branding: BRANDING });
      if (url === '/api/v1/galleries' && method === 'POST') return json(201, CREATED);
      return json(200, { ok: true });
    }),
  );
}
function renderIn(ui: React.ReactNode) {
  const router = createMemoryRouter([{ path: '*', element: <ToastProvider>{ui}</ToastProvider> }]);
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  resetUsage();
  setSessionUserId('u1');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSessionUserId(null);
});

async function openCreate(u: unknown) {
  mockApi(u);
  await refreshUsage();
  renderIn(
    <CreateGalleryDialog
      open
      photoIds={['a', 'b']}
      defaultName="Bintan"
      onClose={() => {}}
      onCreated={() => {}}
    />,
  );
  return screen.getByRole('dialog');
}

describe('create gallery dialog', () => {
  it('Free: full size and the Studio extras are locked, and the link lasts at most 7 days', async () => {
    const d = await openCreate(usage('free', FREE));
    const full = within(d).getByRole('radio', { name: /Full size/ });
    expect((full as HTMLInputElement).disabled).toBe(true);
    expect(within(d).getByText('Pro')).toBeTruthy();
    for (const name of [/pick favourites/, /Watermark photos/, /Show your branding/, /access log/])
      expect((within(d).getByRole('switch', { name }) as HTMLInputElement).disabled).toBe(true);
    expect(within(d).getAllByText('Studio')).toHaveLength(4);
    const date = within(d).getByLabelText('Link expires') as HTMLInputElement;
    expect(date.max).toBe(isoDay(7));
    expect(date.value).toBe(isoDay(7));
    expect(within(d).getByText(/1 of 3 live galleries/)).toBeTruthy();
  });

  it('Studio: everything is available; the watermark waits until one is set up', async () => {
    const d = await openCreate(usage('studio', STUDIO));
    expect((within(d).getByRole('radio', { name: /Full size/ }) as HTMLInputElement).disabled).toBe(false);
    await waitFor(() => expect(within(d).getByText(/Set one up first/)).toBeTruthy());
    expect((within(d).getByRole('switch', { name: /Watermark photos/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((within(d).getByRole('switch', { name: /pick favourites/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((within(d).getByRole('switch', { name: /access log/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(d).getByLabelText('Link expires') as HTMLInputElement).max).toBe(isoDay(365));
  });

  it('warns when the passcode is turned off, and sends passcode: false', async () => {
    const d = await openCreate(usage('free', FREE));
    expect(within(d).queryByText(/anyone who gets the link/)).toBeNull();
    fireEvent.click(within(d).getByRole('switch', { name: /Require a 6-digit passcode/ }));
    expect(within(d).getByText(/anyone who gets the link can see these photos/)).toBeTruthy();
    fireEvent.click(within(d).getByRole('button', { name: /Create link/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/galleries' && c.method === 'POST')).toBe(true),
    );
    const sent = calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>;
    expect(sent).toMatchObject({ name: 'Bintan', photoIds: ['a', 'b'], passcode: false, downloads: 'web' });
    // A Free plan never asks for extras it doesn't have.
    expect(sent.extras).toEqual({ favourites: false, watermark: false, branding: false, accessLog: false });
  });

  it('at the Free gallery limit, explains why and doesn’t offer Create', async () => {
    const d = await openCreate(usage('free', { ...FREE, liveGalleries: 3 }));
    expect(within(d).getByText(/the most on Free/)).toBeTruthy();
    expect((within(d).getByRole('button', { name: /Create link/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it('uses the live limits from usage, and explains a suspended account', async () => {
    const d = await openCreate(
      usage('pro', { ...STUDIO, guestFavourites: false, liveGalleries: 9, suspended: true }),
    );
    expect(within(d).getByText(/9 live galleries/)).toBeTruthy();
    expect(within(d).getByText(/Sharing is paused on your account while we review a report/)).toBeTruthy();
    expect((within(d).getByRole('button', { name: /Create link/ }) as HTMLInputElement).disabled).toBe(true);
    expect((within(d).getByRole('switch', { name: /pick favourites/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
  });
});

let api: ReturnType<typeof useShareGallery> | null = null;
function Harness() {
  api = useShareGallery();
  return api.dialogs;
}

describe('the one-time link and passcode', () => {
  it('shows the link and passcode digits once, with the advice to send them separately', () => {
    mockApi(usage('free', FREE));
    renderIn(<GalleryLiveDialog created={CREATED} onClose={() => {}} />);
    const d = screen.getByRole('dialog');
    expect((within(d).getByLabelText('Private link') as HTMLInputElement).value).toBe(CREATED.url);
    expect(within(d).getByRole('img', { name: 'Passcode 0 4 2 7 1 9' })).toBeTruthy();
    expect(within(d).getByText(/Send it separately from the link/)).toBeTruthy();
    expect(within(d).getByText(/copy the link again from the gallery page/)).toBeTruthy();
  });

  it('forgets them once closed', async () => {
    mockApi(usage('free', FREE));
    await refreshUsage();
    const { SessionProvider } = await import('../../lib/session');
    const router = createMemoryRouter([
      {
        path: '*',
        element: (
          <SessionProvider onUnauthenticated={() => {}}>
            <ToastProvider>
              <Harness />
            </ToastProvider>
          </SessionProvider>
        ),
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/auth/session'))
          return json(200, {
            ok: true,
            user: { id: 'u1', email: 'a@x', displayName: null, plan: 'free', passkeyCount: 0, createdAt: '' },
          });
        if (url.endsWith('/me/usage')) return json(200, usage('free', FREE));
        if (url === '/api/v1/galleries' && init?.method === 'POST') return json(201, CREATED);
        return json(200, { ok: true });
      }),
    );
    render(<RouterProvider router={router} />);
    act(() => api?.open(['a'], 'X'));
    fireEvent.click(await screen.findByRole('button', { name: /Create link/ }));
    expect(await screen.findByRole('img', { name: /Passcode 0 4 2 7 1 9/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('img', { name: /Passcode/ })).toBeNull();
  });
});

describe('full-size render queue', () => {
  const photo = { id: 'p1', fileType: 'cr2' as const, filename: 'IMG_1.CR2' };
  function queue(over: Partial<ConstructorParameters<typeof ShareRenderQueue>[0]> = {}) {
    let owner: string | null = 'u1';
    const put = vi.fn(async () => undefined);
    const q = new ShareRenderQueue({
      owner: () => owner,
      pending: async () => [{ photoId: 'p1', editVersion: 3 }],
      photo: async () => photo,
      render: async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
      put,
      ...over,
    });
    return { q, put, setOwner: (o: string | null) => (owner = o) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('renders and uploads for the member who queued it', async () => {
    const { q, put } = queue();
    q.add('g1', 'Tan & Wei', [{ photoId: 'p1', editVersion: 3 }], 'u1');
    await waitFor(() => expect(q.getSnapshot().done).toBe(1));
    expect(put).toHaveBeenCalledWith('g1', 'p1', 3, expect.any(Blob), 'u1', expect.any(AbortSignal));
  });

  it('queues nothing for someone other than the member signed in', async () => {
    const { q, put } = queue();
    q.add('g1', 'G', [{ photoId: 'p1', editVersion: 3 }], 'someone-else');
    await settle();
    expect(q.getSnapshot().total).toBe(0);
    expect(put).not.toHaveBeenCalled();
  });

  it('never sends a render if the member changes while it renders', async () => {
    let release: (b: Blob) => void = () => {};
    const { q, put, setOwner } = queue({ render: () => new Promise<Blob>((r) => (release = r)) });
    q.add('g1', 'G', [{ photoId: 'p1', editVersion: 3 }], 'u1');
    await settle();
    setOwner('u2');
    release(new Blob(['x']));
    await settle();
    expect(put).not.toHaveBeenCalled();
  });

  it('resume picks up unfinished renders for live galleries with full-size downloads only', async () => {
    const pending = vi.fn(async () => [{ photoId: 'p1', editVersion: 3 }]);
    const { q, put } = queue({ pending });
    await q.resume([
      { id: 'g1', name: 'A', downloads: 'full', status: 'live' },
      { id: 'g2', name: 'B', downloads: 'web', status: 'live' },
      { id: 'g3', name: 'C', downloads: 'full', status: 'revoked' },
    ]);
    expect(pending).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  });

  it('reset stops the render in progress and drops everything (session end)', async () => {
    let seen: AbortSignal | undefined;
    const { q, put } = queue({
      render: (_p, signal) => {
        seen = signal;
        return new Promise<Blob>(() => {});
      },
    });
    q.add('g1', 'G', [{ photoId: 'p1', editVersion: 3 }], 'u1');
    await settle();
    q.reset();
    expect(seen?.aborted).toBe(true);
    expect(q.getSnapshot().total).toBe(0);
    expect(put).not.toHaveBeenCalled();
  });

  it('skips stale versions quietly and stops on a full storage', async () => {
    const stale = queue({ put: vi.fn(async () => Promise.reject(new ApiFailure('conflict', 410))) });
    stale.q.add('g1', 'G', [{ photoId: 'p1', editVersion: 3 }], 'u1');
    await waitFor(() => expect(stale.q.getSnapshot().done).toBe(1));
    expect(stale.q.getSnapshot().failed).toBe(0);

    const full = queue({ put: vi.fn(async () => Promise.reject(new ApiFailure('storage_full', 413))) });
    full.q.add(
      'g1',
      'G',
      [
        { photoId: 'p1', editVersion: 3 },
        { photoId: 'p2', editVersion: 1 },
      ],
      'u1',
    );
    await waitFor(() => expect(full.q.getSnapshot().storageFull).toBe(true));
    const s = full.q.getSnapshot();
    expect(s.failed).toBe(1);
    expect(s.items.find((i) => i.photoId === 'p2')?.state).toBe('pending');
  });

  it('skips photos gone from the gallery, explains too-large and non-JPEG renders, and stops when the plan changes', async () => {
    const two = [
      { photoId: 'p1', editVersion: 3 },
      { photoId: 'p2', editVersion: 1 },
    ];
    const gone = queue({ put: vi.fn(async () => Promise.reject(new ApiFailure('not_found', 404))) });
    gone.q.add('g1', 'G', two.slice(0, 1), 'u1');
    await waitFor(() => expect(gone.q.getSnapshot().done).toBe(1));
    expect(gone.q.getSnapshot().failed).toBe(0);

    const big = queue({ put: vi.fn(async () => Promise.reject(new ApiFailure('too_large', 413))) });
    big.q.add('g1', 'G', two, 'u1');
    await waitFor(() => expect(big.q.getSnapshot().failed).toBe(2));
    expect(big.q.getSnapshot().storageFull).toBe(false);
    expect(big.q.getSnapshot().items[0]?.message).toMatch(/web size/);

    const notJpeg = queue({ put: vi.fn(async () => Promise.reject(new ApiFailure('invalid', 415))) });
    notJpeg.q.add('g1', 'G', two.slice(0, 1), 'u1');
    await waitFor(() => expect(notJpeg.q.getSnapshot().failed).toBe(1));
    expect(notJpeg.q.getSnapshot().items[0]?.message).toMatch(/JPEG/);

    const planPut = vi.fn(async () => Promise.reject(new ApiFailure('plan_required', 403)));
    const plan = queue({ put: planPut });
    plan.q.add('g1', 'G', two, 'u1');
    await waitFor(() => expect(plan.q.getSnapshot().failed).toBe(1));
    await settle();
    expect(planPut).toHaveBeenCalledTimes(1);
    expect(plan.q.getSnapshot().items.find((i) => i.photoId === 'p2')?.state).toBe('pending');
    expect(plan.q.getSnapshot().storageFull).toBe(false);
  });
});

describe('favourites CSV', () => {
  it('quotes every cell and defuses spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    for (const s of ['+1', '-2', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(s).startsWith(`"'`)).toBe(true);
    expect(csvCell('Tan, Li "Ying"')).toBe('"Tan, Li ""Ying"""');
    expect(csvCell(null)).toBe('""');
    expect(toCsv([['a', 'b']])).toBe('﻿"a","b"\r\n');
  });
  it('has one row per favourite with guest, note and file name', () => {
    const csv = favouritesCsv(
      'Wedding',
      [
        {
          guestId: 'x',
          name: '=cmd',
          note: 'Lighter please',
          sentAt: '2026-11-01T10:00:00Z',
          photoIds: ['p1', 'p2'],
        },
      ],
      new Map([['p1', 'IMG_1.CR2']]),
    );
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('"Wedding","\'=cmd","2026-11-01T10:00:00Z","Lighter please","IMG_1.CR2","p1"');
    expect(lines[2]).toContain('"","p2"');
  });
});

describe('text watermark', () => {
  function fakeCanvas() {
    const drawn: { text: string; x: number; y: number }[] = [];
    const ctx = {
      font: '',
      fillStyle: '',
      textBaseline: '',
      shadowColor: '',
      shadowBlur: 0,
      shadowOffsetY: 0,
      measureText: (t: string) => ({ width: t.length * 30 }),
      fillText: (text: string, x: number, y: number) => drawn.push({ text, x, y }),
    };
    const made: { width: number; height: number }[] = [];
    return {
      drawn,
      made,
      ctx,
      deps: {
        canvas: (w: number, h: number) => {
          const c = { width: w, height: h, getContext: () => ctx as never };
          made.push(c);
          return c;
        },
        toPng: async () => new Blob(['png'], { type: 'image/png' }),
      },
    };
  }
  it('draws white text with a soft shadow on a canvas sized to it', async () => {
    const f = fakeCanvas();
    const png = await drawTextWatermark('  © Mei Lin  ', f.deps);
    expect(png.type).toBe('image/png');
    expect(f.drawn).toEqual([{ text: '© Mei Lin', x: 28, y: expect.any(Number) }]);
    expect(f.ctx.fillStyle).toBe('#ffffff');
    expect(f.ctx.shadowColor).toMatch(/rgba\(0, 0, 0/);
    expect(f.ctx.font).toContain(`${WATERMARK_FONT_PX}px`);
    expect(f.made[1]?.width).toBe(9 * 30 + 56);
  });
  it('shrinks long text to fit and refuses empty text', async () => {
    const f = fakeCanvas();
    await drawTextWatermark('x'.repeat(200), f.deps);
    expect(Number(/(\d+)px/.exec(f.ctx.font)?.[1])).toBeLessThan(WATERMARK_FONT_PX);
    await expect(drawTextWatermark('   ', f.deps)).rejects.toThrow(/Type the text/);
  });
});

describe('gallery page: copy link', () => {
  const GID = CREATED.gallery.id;
  async function openGallery(status: 'live' | 'revoked') {
    const { SessionProvider } = await import('../../lib/session');
    const { GalleryPage } = await import('../../routes/Gallery');
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const linkCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/session'))
          return json(200, {
            ok: true,
            user: {
              id: 'u1',
              email: 'a@x',
              displayName: null,
              plan: 'studio',
              passkeyCount: 0,
              createdAt: '',
            },
          });
        if (url.endsWith('/me/usage')) return json(200, usage('studio', STUDIO));
        if (url.endsWith(`/galleries/${GID}/link`)) {
          linkCalls.push(url);
          return status === 'revoked'
            ? json(404, { ok: false, error: 'not_found' })
            : json(200, { ok: true, url: CREATED.url });
        }
        if (url.endsWith(`/galleries/${GID}`))
          return json(200, {
            ok: true,
            gallery: {
              ...CREATED.gallery,
              status,
              revokedAt: status === 'revoked' ? '2026-11-01T00:00:00Z' : null,
            },
          });
        if (url.includes(`/galleries/${GID}/photos`))
          return json(200, { ok: true, items: [], nextCursor: null });
        return json(200, { ok: true });
      }),
    );
    const router = createMemoryRouter(
      [
        {
          path: '/shared/:galleryId',
          element: (
            <SessionProvider onUnauthenticated={() => {}}>
              <ToastProvider>
                <GalleryPage />
              </ToastProvider>
            </SessionProvider>
          ),
        },
      ],
      { initialEntries: [`/shared/${GID}`] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByRole('heading', { name: 'Tan & Wei' });
    return { writeText, linkCalls };
  }

  it('fetches the link from the owner-only route and copies it', async () => {
    const { writeText, linkCalls } = await openGallery('live');
    fireEvent.click(screen.getByRole('button', { name: /Copy link/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CREATED.url));
    expect(linkCalls).toHaveLength(1);
    expect(await screen.findByText(/Link copied/)).toBeTruthy();
  });

  it('offers no copy for a revoked gallery', async () => {
    const { linkCalls } = await openGallery('revoked');
    expect(screen.queryByRole('button', { name: /Copy link/ })).toBeNull();
    expect(linkCalls).toHaveLength(0);
  });
});

// ------------------------------------------------------------ review follow-ups
describe('watermark readiness and gallery notices', () => {
  const withRouter = (el: React.ReactElement) => {
    const router = createMemoryRouter([{ path: '/', element: el }]);
    return render(<RouterProvider router={router} />);
  };
  const extras = { favourites: false, watermark: false, branding: false, accessLog: false };
  const b = (o: Partial<typeof BRANDING> & { watermarkReady?: boolean } = {}) =>
    ({ ...BRANDING, ...o }) as unknown as Branding;
  it('a logo watermark needs a logo, a text watermark its image; the server’s flag wins', () => {
    expect(watermarkReady(null)).toBe(false);
    expect(watermarkReady(b({ watermark: { ...BRANDING.watermark, kind: 'logo', hasImage: true } }))).toBe(
      false,
    );
    expect(watermarkReady(b({ hasLogo: true, watermark: { ...BRANDING.watermark, kind: 'logo' } }))).toBe(
      true,
    );
    expect(watermarkReady(b({ watermark: { ...BRANDING.watermark, hasImage: true } }))).toBe(true);
    expect(
      watermarkReady(b({ watermark: { ...BRANDING.watermark, hasImage: true }, watermarkReady: false })),
    ).toBe(false);
  });
  it('can’t turn the watermark on until it’s ready, but can always turn it off', () => {
    const onChange = vi.fn();
    const notReady = b({ watermark: { ...BRANDING.watermark, kind: 'logo', hasImage: true } });
    const { unmount } = withRouter(
      <ExtrasSwitches value={extras} onChange={onChange} limits={STUDIO} branding={notReady} />,
    );
    expect((screen.getByRole('switch', { name: /Watermark photos/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole('link', { name: /Sharing & branding/ }).getAttribute('href')).toBe(
      '/settings/sharing',
    );
    unmount();
    withRouter(
      <ExtrasSwitches
        value={{ ...extras, watermark: true }}
        onChange={onChange}
        limits={STUDIO}
        branding={notReady}
      />,
    );
    const sw = screen.getByRole('switch', { name: /Watermark photos/ }) as HTMLInputElement;
    expect(sw.disabled).toBe(false);
    expect(screen.getByText(/guests see “Preparing” until it is/)).toBeTruthy();
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith({ ...extras, watermark: false });
  });
  it('the gallery page warns about a missing watermark and full storage', () => {
    const g = {
      ...CREATED.gallery,
      extras: { ...extras, watermark: true },
      watermarkReady: false,
      storageFull: true,
    };
    withRouter(galleryNotices(g));
    expect(screen.getByText(/Your watermark isn’t set up/)).toBeTruthy();
    expect(screen.getByText(/Storage full — some gallery previews can’t be prepared/)).toBeTruthy();
    cleanup();
    withRouter(galleryNotices(CREATED.gallery));
    expect(screen.queryByText(/watermark isn’t set up|Storage full/)).toBeNull();
  });
  it('explains a 409 when removing a logo that live galleries use', () => {
    expect(assetInUseMessage(new ApiFailure('conflict', 409), 'logo')).toMatch(
      /logo is used by live galleries/,
    );
    expect(assetInUseMessage(new ApiFailure('session_changed', 409), 'logo')).toBeNull();
    expect(assetInUseMessage(new ApiFailure('server', 500), 'logo')).toBeNull();
  });
  it('explains a 409 when switching the watermark to a logo that isn’t uploaded while galleries use it', () => {
    expect(
      watermarkKindInUseMessage(
        new ApiFailure('asset_in_use', 409, undefined, { error: 'asset_in_use', galleries: 2 }),
      ),
    ).toMatch(/^2 live galleries use your watermark\. Upload a logo first/);
    expect(
      watermarkKindInUseMessage(new ApiFailure('asset_in_use', 409, undefined, { galleries: 1 })),
    ).toMatch(/^1 live gallery uses/);
    expect(watermarkKindInUseMessage(new ApiFailure('conflict', 409))).toMatch(/^Live galleries use/);
    expect(watermarkKindInUseMessage(new ApiFailure('session_changed', 409))).toBeNull();
    expect(watermarkKindInUseMessage(new ApiFailure('server', 500))).toBeNull();
  });
});
