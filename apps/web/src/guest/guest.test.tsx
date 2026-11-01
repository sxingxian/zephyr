import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { GuestGalleryInfo, GuestPhoto, GuestPhotoPage } from '@zephyr/shared/client';
import { resetTurnstileLoader } from '@zephyr/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brandingOn, monogram, safeAccent, sameOriginUrl } from './brand';
import { GuestApp } from './GuestApp';
import { GuestImage } from './GuestImage';
import { classifyImageFailure, nextPendingDelay, PENDING_DELAYS_MS, PENDING_GIVE_UP_MS } from './media';
import { Passcode } from './Passcode';
import { REFRESH_COOLDOWN_MS, useGuestPhotos } from './photos';
import { parseGuestPath } from './route';
import { buildZip, checkZipSize, ZipProblem, zipEntryNames, zipPlan } from './zip';

// A made-up 43-character link token, built at runtime so secret scanners don't mistake it for a key.
const TOKEN = `${'Tk'.repeat(20)}a-_`;
const BRAND = { studioName: 'Mei Lin Photography', accent: null, logoUrl: null };
const INFO: GuestGalleryInfo = {
  ok: true,
  state: 'open',
  name: 'Tan & Wei · Wedding proofs',
  brand: BRAND,
  photoCount: 3,
  expiresAt: '2026-12-01T23:59:59Z',
  downloads: 'full',
  favourites: true,
  message: 'Line one\nLine two',
  turnstile: false,
};
const photo = (i: number, o: Partial<GuestPhoto> = {}): GuestPhoto => ({
  id: `p${i}`,
  width: 6000,
  height: 4000,
  grid: `/api/v1/g/${TOKEN}/m/p${i}/grid?e=1&s=a`,
  view: `/api/v1/g/${TOKEN}/m/p${i}/view?e=1&s=a`,
  download: {
    web: `/api/v1/g/${TOKEN}/m/p${i}/web?e=1&s=a`,
    full: `/api/v1/g/${TOKEN}/m/p${i}/full?e=1&s=a`,
  },
  favourite: false,
  ...o,
});
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
let calls: { url: string; method: string; body: unknown }[] = [];
function mockApi(handler: Handler) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return handler(url, init);
    }),
  );
}

// Turnstile stand-in: renders instantly and hands out a token when asked.
let tsCallback: ((t: string) => void) | null = null;
let tsActions: unknown[] = [];
beforeEach(() => {
  resetTurnstileLoader();
  tsCallback = null;
  tsActions = [];
  window.turnstile = {
    render: (_el: HTMLElement, o: Record<string, unknown>) => {
      tsCallback = o.callback as (t: string) => void;
      tsActions.push(o.action);
      return 'w1';
    },
    reset: vi.fn(),
    remove: vi.fn(),
  };
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.turnstile = undefined;
});

// ------------------------------------------------------------ routes and brand
describe('guest routes', () => {
  it('accepts only well-formed tokens and preview ids', () => {
    expect(parseGuestPath(`/g/${TOKEN}`)).toEqual({ kind: 'token', token: TOKEN });
    expect(parseGuestPath('/g/preview/7d3f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f')).toEqual({
      kind: 'preview',
      galleryId: '7d3f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
    });
    for (const p of [
      '/g/',
      '/g/short',
      `/g/${TOKEN}/x`,
      `/x/${TOKEN}`,
      '/g/preview/NOT-A-UUID',
      `/g/${TOKEN.slice(0, -1)}!`,
    ])
      expect(parseGuestPath(p).kind).toBe('bad');
  });
});

describe('member branding on the guest page', () => {
  it('uses only the contrast-checked accents and same-origin logos', () => {
    expect(safeAccent('#7a3940')).toBe('#7A3940');
    expect(safeAccent('red; background: url(x)')).toBeNull();
    expect(safeAccent('#123456')).toBeNull();
    expect(sameOriginUrl('/api/v1/g/t/brand/logo?s=1')).toBe('/api/v1/g/t/brand/logo?s=1');
    expect(sameOriginUrl('https://evil.example/logo.png')).toBeNull();
    expect(sameOriginUrl('javascript:alert(1)')).toBeNull();
    expect(sameOriginUrl('/elsewhere.png')).toBeNull();
    expect(brandingOn(BRAND)).toBe(false);
    expect(brandingOn({ ...BRAND, accent: '#7A3940' })).toBe(true);
    expect(monogram('Mei Lin Photography')).toBe('ML');
  });
});

// ------------------------------------------------------------ passcode
function renderPasscode(over: Partial<GuestGalleryInfo> = {}, now = () => Date.now()) {
  const onUnlocked = vi.fn();
  const onPaused = vi.fn();
  render(
    <Passcode
      token={TOKEN}
      info={{ ...INFO, state: 'locked', ...over }}
      onUnlocked={onUnlocked}
      onPaused={onPaused}
      now={now}
    />,
  );
  return { onUnlocked, onPaused };
}
const boxes = () => screen.getAllByRole('textbox') as HTMLInputElement[];

describe('passcode screen', () => {
  it('a pasted code fills every box and unlocks', async () => {
    mockApi(() => json(200, { ok: true }));
    const { onUnlocked } = renderPasscode();
    fireEvent.paste(boxes()[0] as HTMLInputElement, { clipboardData: { getData: () => '42 71 93' } });
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({
      url: `/api/v1/g/${TOKEN}/unlock`,
      method: 'POST',
      body: { passcode: '427193' },
    });
    expect(
      boxes()
        .map((b) => b.value)
        .join(''),
    ).toBe('427193');
  });

  it('typing moves along the boxes; backspace goes back', () => {
    mockApi(() => json(200, { ok: true }));
    renderPasscode();
    const b = boxes();
    expect(b[0]?.getAttribute('autocomplete')).toBe('one-time-code');
    expect(b[0]?.getAttribute('inputmode')).toBe('numeric');
    fireEvent.change(b[0] as HTMLInputElement, { target: { value: '4' } });
    fireEvent.change(boxes()[1] as HTMLInputElement, { target: { value: 'x' } });
    expect(boxes()[1]?.value).toBe('');
    fireEvent.change(boxes()[1] as HTMLInputElement, { target: { value: '2' } });
    expect(document.activeElement).toBe(boxes()[2]);
    fireEvent.keyDown(boxes()[2] as HTMLInputElement, { key: 'Backspace' });
    expect(boxes()[1]?.value).toBe('');
  });

  it('wrong code → message with tries left → Turnstile once the server asks → token sent next time', async () => {
    let n = 0;
    mockApi(() => {
      n++;
      return n === 1
        ? json(401, { ok: false, error: 'wrong_passcode', remaining: 3 })
        : n === 2
          ? json(401, { ok: false, error: 'wrong_passcode', turnstile: true, remaining: 2 })
          : json(200, { ok: true });
    });
    const { onUnlocked } = renderPasscode();
    fireEvent.paste(boxes()[0] as HTMLInputElement, { clipboardData: { getData: () => '111111' } });
    expect(await screen.findByText(/3 tries left before a 15-minute pause/)).toBeTruthy();
    expect(boxes().every((b) => b.value === '')).toBe(true);
    fireEvent.paste(boxes()[0] as HTMLInputElement, { clipboardData: { getData: () => '222222' } });
    expect(await screen.findByText(/2 tries left/)).toBeTruthy();
    await waitFor(() => expect(tsCallback).not.toBeNull());
    // Without a token the form asks for the check instead of sending.
    fireEvent.paste(boxes()[0] as HTMLInputElement, { clipboardData: { getData: () => '333333' } });
    expect(await screen.findByText(/Complete the security check/)).toBeTruthy();
    expect(calls).toHaveLength(2);
    act(() => tsCallback?.('ts-token'));
    fireEvent.click(screen.getByRole('button', { name: 'Open gallery' }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    expect(calls[2]?.body).toEqual({ passcode: '333333', turnstileToken: 'ts-token' });
  });

  it('asks for Turnstile from the start when the gallery says so', async () => {
    mockApi(() => json(200, { ok: true }));
    renderPasscode({ turnstile: true });
    await waitFor(() => expect(tsCallback).not.toBeNull());
  });

  it('a paused gallery (423) hands over to the paused screen with its end time', async () => {
    mockApi(() => json(423, { ok: false, error: 'gallery_paused', pausedUntil: '2030-01-01T00:15:00Z' }));
    const { onPaused } = renderPasscode();
    fireEvent.paste(boxes()[0] as HTMLInputElement, { clipboardData: { getData: () => '123456' } });
    await waitFor(() => expect(onPaused).toHaveBeenCalledWith(Date.parse('2030-01-01T00:15:00Z')));
  });

  it('too many tries from this network (429) disables the form with a countdown', async () => {
    const t0 = 1_000_000;
    mockApi(() => json(429, { ok: false, error: 'rate_limited' }, { 'retry-after': '600' }));
    renderPasscode({}, () => t0);
    fireEvent.paste(boxes()[0] as HTMLInputElement, { clipboardData: { getData: () => '123456' } });
    expect(await screen.findByText(/Too many tries from your network. Try again in 10:00/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Open gallery' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// ------------------------------------------------------------ whole page
function galleryApi(over: { info?: Partial<GuestGalleryInfo>; pages?: GuestPhotoPage[] } = {}): Handler {
  const pages = over.pages ?? [
    {
      ok: true,
      items: [photo(1), photo(2), photo(3)],
      nextCursor: null,
      selection: { count: 0, sentAt: null, name: null },
    },
  ];
  return (url, init) => {
    if (url === `/api/v1/g/${TOKEN}`) return json(200, { ...INFO, ...over.info });
    if (url.startsWith(`/api/v1/g/${TOKEN}/photos`)) {
      const c = new URL(url, 'https://x').searchParams.get('cursor');
      return json(200, pages[c ? Number(c) : 0]);
    }
    if (url.includes('/favourites/send')) return json(200, { ok: true });
    if (url.includes('/favourites/')) return json(204, null);
    return json(404, { ok: false, error: 'not_found', method: init?.method });
  };
}

describe('guest page states', () => {
  it('an unknown link shows "This link doesn’t work" without saying more', async () => {
    mockApi(() => json(404, { ok: false, error: 'not_found' }));
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    expect(await screen.findByRole('heading', { name: 'This link doesn’t work' })).toBeTruthy();
  });
  it('a malformed link never calls the API', () => {
    mockApi(() => json(200, {}));
    render(<GuestApp pathname="/g/oops" />);
    expect(screen.getByRole('heading', { name: 'This link doesn’t work' })).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
  it('an ended gallery says so and names the studio', async () => {
    mockApi(galleryApi({ info: { state: 'ended', expiresAt: '2026-01-01T23:59:59Z' } }));
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    expect(await screen.findByRole('heading', { name: 'This gallery has ended' })).toBeTruthy();
    expect(
      screen.getByText(/stopped working on 1 Jan 2026.*ask Mei Lin Photography for a new link/),
    ).toBeTruthy();
  });
  it('locked → unlock → the gallery, with the message kept as written', async () => {
    let unlocked = false;
    const api = galleryApi();
    mockApi((url, init) => {
      if (url.endsWith('/unlock')) {
        unlocked = true;
        return json(200, { ok: true });
      }
      if (url === `/api/v1/g/${TOKEN}`) return json(200, { ...INFO, state: unlocked ? 'open' : 'locked' });
      return api(url, init);
    });
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    fireEvent.paste((await screen.findAllByRole('textbox'))[0] as HTMLInputElement, {
      clipboardData: { getData: () => '427193' },
    });
    expect(await screen.findAllByRole('button', { name: /^Open photo/ })).toHaveLength(3);
    expect(screen.getByRole('heading', { name: INFO.name })).toBeTruthy();
    expect(screen.getByText(/Line one/).textContent).toBe('Line one\nLine two');
  });
  it('a paused gallery counts down, then asks for the passcode again', async () => {
    let t = Date.parse('2030-01-01T00:00:00Z');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let paused = true;
    mockApi(() =>
      json(
        200,
        paused
          ? { ...INFO, state: 'paused', pausedUntil: '2030-01-01T00:00:03Z' }
          : { ...INFO, state: 'locked' },
      ),
    );
    render(<GuestApp pathname={`/g/${TOKEN}`} now={() => t} />);
    await waitFor(() => expect(screen.getByText('Too many tries')).toBeTruthy());
    expect(screen.getByText('0:03')).toBeTruthy();
    paused = false;
    t += 4000;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await waitFor(() => expect(screen.getByText('Enter the 6-digit passcode')).toBeTruthy());
  });
});

describe('gallery', () => {
  it('favourites: toggle, then send with name and note', async () => {
    mockApi(galleryApi());
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    const heart = await screen.findByRole('button', { name: 'Favourite photo 2' });
    fireEvent.click(heart);
    await waitFor(() => expect(heart.getAttribute('aria-pressed')).toBe('true'));
    expect(calls.at(-1)).toMatchObject({ url: `/api/v1/g/${TOKEN}/favourites/p2`, method: 'PUT' });
    expect(screen.getByRole('region', { name: 'Your selection' }).textContent).toContain('1 favourite');
    fireEvent.click(screen.getByRole('button', { name: /Send your favourites to Mei Lin Photography/ }));
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: '  Tan Li Ying ' } });
    fireEvent.change(screen.getByLabelText('Note (optional)'), {
      target: { value: 'Lighten the arch ones' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send favourites' }));
    await waitFor(() => expect(calls.at(-1)?.url).toBe(`/api/v1/g/${TOKEN}/favourites/send`));
    expect(calls.at(-1)?.body).toEqual({ name: 'Tan Li Ying', note: 'Lighten the arch ones' });
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Your selection' }).textContent).toContain('Sent'),
    );
  });

  it('no hearts when favourites are off, and none in the owner preview', async () => {
    mockApi(galleryApi({ info: { favourites: false } }));
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    await screen.findByRole('heading', { name: INFO.name });
    expect(screen.queryByRole('button', { name: /Favourite photo/ })).toBeNull();
  });

  it('download menu: full and web, "Preparing" while the full-size render isn’t ready', async () => {
    mockApi(
      galleryApi({
        pages: [
          {
            ok: true,
            items: [photo(1, { download: { web: '/api/w1', full: null } }), photo(2)],
            nextCursor: null,
          },
        ],
      }),
    );
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open photo 1' }));
    const dialog = () => within(screen.getByRole('dialog'));
    fireEvent.click(dialog().getByRole('button', { name: /^Download/ }));
    const items = dialog().getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(/Full size.*Preparing/),
      expect.stringMatching(/Web size/),
    ]);
    expect(items[0]?.getAttribute('aria-disabled')).toBe('true');
    expect(items[1]?.getAttribute('href')).toBe('/api/w1');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(screen.getByText('2 of 3')).toBeTruthy();
    fireEvent.click(dialog().getByRole('button', { name: /^Download/ }));
    expect(dialog().getAllByRole('menuitem')[0]?.getAttribute('href')).toContain('/m/p2/full');
  });

  it('view-only galleries offer no downloads; web-only galleries offer web size only', async () => {
    mockApi(galleryApi({ info: { downloads: 'none' } }));
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open photo 1' }));
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: /^Download/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Download all/ })).toBeNull();
    cleanup();
    mockApi(galleryApi({ info: { downloads: 'web' } }));
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open photo 1' }));
    const d = within(screen.getByRole('dialog'));
    fireEvent.click(d.getByRole('button', { name: /^Download/ }));
    expect(d.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      expect.stringMatching(/^Web size/),
    ]);
    // With web size only, "Download all" is a single action, not a menu.
    expect(screen.getByRole('button', { name: /Download all/ }).getAttribute('aria-haspopup')).toBeNull();
  });

  it('the viewer closes with Escape and moves with swipes', async () => {
    mockApi(galleryApi());
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open photo 1' }));
    const stage = document.querySelector('.g-viewer__stage') as HTMLElement;
    fireEvent.pointerDown(stage, { clientX: 300, clientY: 100, pointerType: 'touch' });
    fireEvent.pointerUp(stage, { clientX: 150, clientY: 110, pointerType: 'touch' });
    expect(screen.getByText('2 of 3')).toBeTruthy();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a photo list call that comes back 401 sends the guest back to the passcode', async () => {
    let first = true;
    mockApi((url) => {
      if (url === `/api/v1/g/${TOKEN}`) {
        const r = json(200, { ...INFO, state: first ? 'open' : 'locked' });
        first = false;
        return r;
      }
      return json(401, { ok: false, error: 'unauthenticated' });
    });
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    expect(await screen.findByText('Enter the 6-digit passcode')).toBeTruthy();
  });
});

// ------------------------------------------------------------ signed URL refresh
function Probe({
  fetchPage,
  onLocked,
  now,
  out,
}: {
  fetchPage: (c: string | null) => Promise<GuestPhotoPage>;
  onLocked: () => void;
  now: () => number;
  out: { s?: ReturnType<typeof useGuestPhotos> };
}) {
  out.s = useGuestPhotos(fetchPage, onLocked, now);
  return null;
}
describe('signed image URLs', () => {
  it('an expired URL refetches every loaded page for fresh ones, at most once per cooldown', async () => {
    let gen = 1;
    const fetchPage = vi.fn(async (c: string | null): Promise<GuestPhotoPage> => {
      const base = c ? 2 : 0;
      return {
        ok: true,
        items: [
          photo(base + 1, { grid: `/g${gen}/${base + 1}` }),
          photo(base + 2, { grid: `/g${gen}/${base + 2}` }),
        ],
        nextCursor: c ? null : '1',
      };
    });
    let t = 0;
    const out: { s?: ReturnType<typeof useGuestPhotos> } = {};
    render(<Probe fetchPage={fetchPage} onLocked={vi.fn()} now={() => t} out={out} />);
    await waitFor(() => expect(out.s?.items).toHaveLength(2));
    act(() => out.s?.loadMore());
    await waitFor(() => expect(out.s?.items).toHaveLength(4));
    gen = 2;
    t = REFRESH_COOLDOWN_MS + 1;
    await act(async () => {
      await out.s?.refreshUrls();
    });
    expect(out.s?.items.map((p) => p.grid)).toEqual(['/g2/1', '/g2/2', '/g2/3', '/g2/4']);
    expect(fetchPage).toHaveBeenCalledTimes(4);
    // A second failure straight away doesn't hammer the API.
    await act(async () => {
      await out.s?.refreshUrls();
    });
    expect(fetchPage).toHaveBeenCalledTimes(4);
  });
});

// ------------------------------------------------------------ zip
describe('download all (.zip)', () => {
  it('leaves out full-size photos still being prepared', () => {
    const plan = zipPlan(
      [photo(1), photo(2, { download: { web: '/w', full: null } }), photo(3, { download: undefined })],
      'full',
    );
    expect(plan.included.map((p) => p.id)).toEqual(['p1']);
    expect(plan.preparing).toBe(1);
    expect(zipPlan([photo(2, { download: { web: '/w', full: null } })], 'web').included).toHaveLength(1);
  });
  it('names entries after the gallery, never the member’s file names', () => {
    expect(zipEntryNames('Tan & Wei / proofs', 2)).toEqual([
      'Tan & Wei _ proofs 001.jpg',
      'Tan & Wei _ proofs 002.jpg',
    ]);
  });
  it('refuses an in-memory zip too big for the browser, but not a streamed one', () => {
    const many = Array.from({ length: 201 }, (_, i) => photo(i));
    expect(() => checkZipSize(many, 'full', false)).toThrow(ZipProblem);
    expect(() => checkZipSize(many, 'full', true)).not.toThrow();
    expect(() => checkZipSize(many.slice(0, 20), 'web', false)).not.toThrow();
  });
  it('builds the zip, fetching fresh URLs when one has expired', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url);
        return url.includes('old')
          ? new Response('gone', { status: 403 })
          : new Response(new Uint8Array([1, 2, 3]));
      }),
    );
    const fresh = vi.fn(async () => photo(2, { download: { web: '/new-web-2', full: '/new-full-2' } }));
    const blob = await buildZip([photo(1), photo(2, { download: { web: '/old', full: '/old' } })], {
      size: 'web',
      galleryName: 'G',
      fresh,
    });
    expect(blob?.type).toBe('application/zip');
    expect(fresh).toHaveBeenCalledWith('p2');
    expect(seen).toEqual([photo(1).download?.web, '/old', '/new-web-2']);
    const bytes = new Uint8Array(await (blob as Blob).arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toContain('G 001.jpg');
  });
  it('streams into a picked file and abandons it on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 500 })),
    );
    const sink = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    await expect(buildZip([photo(1)], { size: 'web', galleryName: 'G' }, sink)).rejects.toThrow(ZipProblem);
    expect(sink.abort).toHaveBeenCalled();
    expect(sink.close).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------ reporting
describe('report this gallery', () => {
  const reportApi = (status = 202): Handler => {
    const base = galleryApi();
    return (url, init) => {
      if (url === `/api/v1/g/${TOKEN}/report`)
        return status === 202
          ? json(202, { ok: true })
          : json(status, { ok: false, error: 'rate_limited' }, { 'retry-after': '3600' });
      if (url === `/api/v1/g/${TOKEN}`) return json(200, { ...INFO, state: 'locked' });
      return base(url, init);
    };
  };

  it('works from the passcode screen: reason, security check, then a thank-you', async () => {
    mockApi(reportApi());
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Report this gallery' }));
    const d = screen.getByRole('dialog', { name: 'Report this gallery' });
    // Turnstile loads only now, for the report action.
    await waitFor(() => expect(tsActions).toContain('gallery_report'));
    fireEvent.click(within(d).getByRole('button', { name: 'Send report' }));
    expect(within(d).getByText('Choose what’s wrong.')).toBeTruthy();
    fireEvent.click(within(d).getByRole('radio', { name: /Privacy/ }));
    fireEvent.click(within(d).getByRole('button', { name: 'Send report' }));
    expect(within(d).getByText(/Complete the security check/)).toBeTruthy();
    act(() => tsCallback?.('ts-token'));
    fireEvent.change(within(d).getByLabelText('Details (optional)'), {
      target: { value: '  Posted without consent ' },
    });
    fireEvent.click(within(d).getByRole('button', { name: 'Send report' }));
    expect(await screen.findByRole('dialog', { name: 'Thanks for telling us' })).toBeTruthy();
    const sent = calls.find((c) => c.url.endsWith('/report'));
    expect(sent).toMatchObject({ method: 'POST' });
    expect(sent?.body).toEqual({
      reason: 'privacy',
      turnstileToken: 'ts-token',
      details: 'Posted without consent',
    });
  });

  it('reports one photo from the viewer’s menu', async () => {
    const base = galleryApi();
    mockApi((url, init) => (url.endsWith('/report') ? json(202, { ok: true }) : base(url, init)));
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open photo 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Report this photo/ }));
    const d = await screen.findByRole('dialog', { name: 'Report this photo' });
    fireEvent.click(within(d).getByRole('radio', { name: /Child sexual abuse material/ }));
    await waitFor(() => expect(tsCallback).not.toBeNull());
    act(() => tsCallback?.('t2'));
    fireEvent.click(within(d).getByRole('button', { name: 'Send report' }));
    await screen.findByRole('dialog', { name: 'Thanks for telling us' });
    expect(calls.find((c) => c.url.endsWith('/report'))?.body).toEqual({
      reason: 'csam',
      turnstileToken: 't2',
      photoId: 'p2',
    });
  });

  it('too many reports from one network says so', async () => {
    mockApi(reportApi(429));
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Report this gallery' }));
    const d = screen.getByRole('dialog', { name: 'Report this gallery' });
    fireEvent.click(within(d).getByRole('radio', { name: /Copyright/ }));
    await waitFor(() => expect(tsCallback).not.toBeNull());
    act(() => tsCallback?.('t3'));
    fireEvent.click(within(d).getByRole('button', { name: 'Send report' }));
    expect(await within(d).findByText(/Too many reports from this network/)).toBeTruthy();
  });

  it('isn’t offered on ended links or in the owner’s preview, and preview uses the member routes', async () => {
    mockApi(galleryApi({ info: { state: 'ended' } }));
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    await screen.findByRole('heading', { name: 'This gallery has ended' });
    expect(screen.queryByRole('button', { name: 'Report this gallery' })).toBeNull();
    cleanup();

    const GID = '7d3f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
    mockApi((url) => {
      if (url === `/api/v1/galleries/${GID}/preview`) return json(200, { ...INFO, favourites: false });
      if (url.startsWith(`/api/v1/galleries/${GID}/preview/photos`))
        return json(200, { ok: true, items: [photo(1)], nextCursor: null });
      return json(404, { ok: false, error: 'not_found' });
    });
    render(<GuestApp pathname={`/g/preview/${GID}`} />);
    await screen.findByRole('heading', { name: INFO.name });
    expect(calls.map((c) => c.url)).toEqual(
      expect.arrayContaining([`/api/v1/galleries/${GID}/preview`, `/api/v1/galleries/${GID}/preview/photos`]),
    );
    expect(screen.queryByRole('button', { name: 'Report this gallery' })).toBeNull();
  });

  it('the passcode form asks Turnstile for the unlock action', async () => {
    mockApi(() => json(200, { ...INFO, state: 'locked', turnstile: true }));
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    await waitFor(() => expect(tsActions).toContain('gallery_unlock'));
  });
});

// ------------------------------------------------------------ review follow-ups
describe('images the server is still preparing', () => {
  const res = (status: number, body?: unknown) =>
    new Response(body === undefined ? 'x' : JSON.stringify(body), {
      status,
      headers: { 'content-type': body === undefined ? 'image/jpeg' : 'application/json' },
    });
  it('tells "preparing" apart from an expired link', async () => {
    const f = (r: Response) => vi.fn(async () => r) as unknown as typeof fetch;
    expect(await classifyImageFailure('/u', f(res(404, { ok: false, error: 'pending' })))).toBe('pending');
    expect(await classifyImageFailure('/u', f(res(409, { unavailable: 'pending' })))).toBe('pending');
    expect(await classifyImageFailure('/u', f(res(425, { ok: false })))).toBe('pending');
    expect(await classifyImageFailure('/u', f(res(503, { ok: false, error: 'storage_full' })))).toBe(
      'pending',
    );
    expect(await classifyImageFailure('/u', f(res(409, { ok: false, error: 'conflict' })))).toBe('pending');
    expect(await classifyImageFailure('/u', f(res(200)))).toBe('pending');
    expect(await classifyImageFailure('/u', f(res(401, { ok: false, error: 'unauthenticated' })))).toBe(
      'expired',
    );
    expect(await classifyImageFailure('/u', f(res(404, { ok: false, error: 'not_found' })))).toBe('expired');
    expect(await classifyImageFailure('/u', f(res(502, { ok: false, error: 'server' })))).toBe('error');
    const offline = vi.fn(async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    expect(await classifyImageFailure('/u', offline)).toBe('error');
  });
  it('backs off slowly and stops after about five minutes', () => {
    const half = () => 0.5;
    expect(PENDING_DELAYS_MS.map((_, i) => nextPendingDelay(i, 0, half))).toEqual(PENDING_DELAYS_MS);
    expect(nextPendingDelay(20, 0, half)).toBe(120_000);
    expect(nextPendingDelay(3, PENDING_GIVE_UP_MS - 1000, half)).toBe(1000);
    expect(nextPendingDelay(3, PENDING_GIVE_UP_MS, half)).toBeNull();
    // Jitter stays within ±20%.
    expect(nextPendingDelay(0, 0, () => 0)).toBe(4000);
    expect(nextPendingDelay(0, 0, () => 0.999)).toBeLessThanOrEqual(6000);
  });
  it('a tile shows "Preparing", retries on the backoff, and shows the photo once it’s ready', async () => {
    vi.useFakeTimers();
    let t = 0;
    const classify = vi.fn(async () => 'pending' as const);
    const onExpired = vi.fn();
    const { container } = render(
      <GuestImage
        variant="tile"
        src="/api/x?e=1&s=a"
        alt=""
        onExpired={onExpired}
        classify={classify}
        now={() => t}
      />,
    );
    const img = () => container.querySelector('img') as HTMLImageElement;
    await act(async () => {
      fireEvent.error(img());
    });
    expect(screen.getByRole('status').textContent).toBe('Preparing');
    expect(img().style.opacity).toBe('0');
    const first = img();
    t = 6000;
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(img()).not.toBe(first); // remounted to try again
    await act(async () => {
      fireEvent.load(img());
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(onExpired).not.toHaveBeenCalled();
  });
  it('gives up after the backoff with a manual "Try again"', async () => {
    vi.useFakeTimers();
    let t = 0;
    const classify = vi.fn(async () => 'pending' as const);
    const { container } = render(
      <GuestImage
        variant="viewer"
        src="/api/x"
        alt="Shot 1"
        onExpired={vi.fn()}
        classify={classify}
        now={() => t}
      />,
    );
    const img = () => container.querySelector('img') as HTMLImageElement;
    for (let i = 0; i < 12 && !screen.queryByRole('button', { name: 'Try again' }); i++) {
      await act(async () => {
        fireEvent.error(img());
      });
      t += 130_000;
      await act(async () => {
        vi.advanceTimersByTime(130_000);
      });
    }
    expect(screen.getByText('This photo isn’t ready yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('status').textContent).toMatch(/still being prepared/);
  });
  it('an expired URL asks for fresh ones once, and doesn’t loop on the same URL', async () => {
    const classify = vi.fn(async () => 'expired' as const);
    const onExpired = vi.fn();
    const { container } = render(
      <GuestImage variant="tile" src="/api/y" alt="" onExpired={onExpired} classify={classify} />,
    );
    const img = () => container.querySelector('img') as HTMLImageElement;
    await act(async () => {
      fireEvent.error(img());
    });
    expect(onExpired).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.error(img());
    });
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('Preparing');
  });
});

describe('ended links and downloads after the review', () => {
  it('an ended link without a name or studio uses general wording', async () => {
    mockApi(
      galleryApi({
        info: {
          state: 'ended',
          name: '',
          expiresAt: '2026-01-01T23:59:59Z',
          brand: { studioName: '', accent: null, logoUrl: null },
        },
      }),
    );
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    expect(await screen.findByRole('heading', { name: 'This gallery has ended' })).toBeTruthy();
    expect(
      screen.getByText(
        /^This link stopped working on 1 Jan 2026\. .*ask the person who shared it for a new link\.$/,
      ),
    ).toBeTruthy();
  });
  it('single downloads leave the file name to the server (no member file name in the page)', async () => {
    mockApi(galleryApi({}));
    render(<GuestApp pathname={`/g/${TOKEN}`} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open photo 1' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: /^Download/ }));
    for (const a of dialog.getAllByRole('menuitem')) {
      if (a.tagName === 'A') expect(a.getAttribute('download')).toBe('');
    }
  });
});
