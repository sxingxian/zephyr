import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  AiJobItem,
  AiJobSummary,
  AiStatus,
  CleanupPhoto,
  EditRecipe,
  PhotoDetail,
  PhotoEdit,
} from '@zephyr/shared/client';
import { ToastProvider } from '@zephyr/ui';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './App';
import { ConsentDialog } from './components/ai/AiBits';
import { aboutTime, BatchDialog, deviceSeconds } from './components/ai/BatchDialog';
import { CutoutPanel, EditorAiPanel } from './components/ai/EditorAi';
import { ToolTabs } from './components/editor/Panels';
import { editorAi, isAiStatus, resetAiStatus, setAiStatus } from './lib/aiClient';
import { EditSession } from './lib/editor/session';
import { setSessionUserId } from './lib/sessionGuard';
import { defaultTrash } from './routes/Cleanup';

vi.mock('./lib/editor/cutout', () => ({
  activeCutout: (r: EditRecipe | null) => (r?.cutout && r.cutout.bg !== 'original' ? r.cutout : null),
  isTransparentCutout: (r: EditRecipe | null) => r?.cutout?.bg === 'transparent',
  getMask: () => null,
  loadMask: vi.fn(() => Promise.reject(new Error('no masks in tests'))),
  ensureMaskFor: vi.fn(),
  onMaskLoaded: () => () => {},
  clearMasks: vi.fn(),
}));

const MASK = '0b9f4a1e-0f1a-4c4e-9d1f-0e8b7a6c5d4e';
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';
const USER = {
  id: 'u1',
  email: 'mei@example.com',
  displayName: 'Mei Lin',
  plan: 'pro',
  passkeyCount: 1,
  createdAt: '2026-10-28T00:00:00Z',
};

function status(over: Partial<AiStatus> = {}): AiStatus {
  return {
    enabled: true,
    features: {
      auto_enhance: 'on',
      hdr: 'on',
      color_match: 'on',
      cleanup: 'on',
      face_grouping: 'on',
      scene_tags: 'on',
      bg_removal: 'on',
    },
    cloudPaused: null,
    member: { faceGrouping: true, faceConsentAt: '2026-11-01T00:00:00Z', sceneTags: true, cleanup: true },
    credits: {
      balance: 640,
      monthly: 1000,
      periodStart: '2026-11-01',
      periodEnd: '2026-12-01',
      rollover: false,
      bgCreditsPerPhoto: 1,
    },
    batchSize: 500,
    ...over,
  };
}
const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });

type Handler = (url: string, method: string, body: unknown) => Response | undefined;
let calls: { url: string; method: string; body: unknown }[] = [];
function mockApi(handler: Handler, st: AiStatus = status()) {
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
      if (url === '/api/v1/ai') return json(200, { ok: true, ...st });
      if (url.startsWith('/api/v1/ai/jobs?'))
        return json(200, {
          ok: true,
          jobs: [],
          nextCursor: null,
          counts: { running: 0, finished: 0, failed: 0 },
        });
      if (url.endsWith('/me/usage'))
        return json(200, {
          ok: true,
          usedBytes: 1,
          reservedBytes: 0,
          limitBytes: 1e11,
          trashBytes: 0,
          photoCount: 3,
          plan: 'pro',
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
function inRouter(ui: React.ReactNode) {
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
  window.history.replaceState(null, '', '/');
  setSessionUserId('u1');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetAiStatus();
  setSessionUserId(null);
});

// ---------------------------------------------------------------- status gating
describe('AI status gating', () => {
  it('accepts only a real status', () => {
    expect(isAiStatus(status())).toBe(true);
    expect(isAiStatus({ ok: true, user: USER })).toBe(false);
    expect(isAiStatus(null)).toBe(false);
  });
  it('shows the editor AI tab only when an editor tool is available', () => {
    expect(editorAi(status())).toBe(true);
    expect(editorAi(status({ enabled: false }))).toBe(false);
    expect(
      editorAi(
        status({
          features: {
            ...status().features,
            auto_enhance: 'off_admin',
            hdr: 'off_admin',
            color_match: 'off_admin',
            bg_removal: 'off_plan',
          },
        }),
      ),
    ).toBe(false);
    render(<ToolTabs tool="adjust" onChange={() => {}} ai />);
    expect(screen.getByRole('tab', { name: 'Zephyr AI' })).toBeTruthy();
    cleanup();
    render(<ToolTabs tool="adjust" onChange={() => {}} />);
    expect(screen.queryByRole('tab', { name: 'Zephyr AI' })).toBeNull();
  });
  it('hides Zephyr AI pages from the nav and shows a quiet note when the admin turns it off', async () => {
    mockApi(() => undefined, status({ enabled: false }));
    renderAt('/scenes');
    expect(
      await screen.findAllByText('Zephyr AI is paused right now. Manual editing keeps working.'),
    ).toBeTruthy();
    const nav = screen.getAllByRole('navigation', { name: 'Main' })[0] as HTMLElement;
    expect(within(nav).queryByRole('link', { name: /People/ })).toBeNull();
    expect(within(nav).getByText('Zephyr AI is paused')).toBeTruthy();
  });
  it('shows the paused banner when cloud work is waiting', async () => {
    mockApi(() => undefined, status({ cloudPaused: { reason: 'cap', until: '2026-11-02T00:00:00Z' } }));
    renderAt('/settings/ai');
    expect(await screen.findByText(/Cloud AI is paused/)).toBeTruthy();
    expect(screen.getByText(/daily limit for cloud work/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------- consent
describe('face-grouping consent', () => {
  it('keeps Turn on disabled until the box is ticked and sends the consent version', async () => {
    const onConfirm = vi.fn(async () => {});
    inRouter(<ConsentDialog open onClose={() => {}} onConfirm={onConfirm} />);
    expect(screen.getByText(/the law treats it as biometric data/)).toBeTruthy();
    const box = screen.getByRole('checkbox');
    expect((box as HTMLInputElement).checked).toBe(false);
    const turnOn = screen.getByRole('button', { name: 'Turn on' }) as HTMLButtonElement;
    expect(turnOn.disabled).toBe(true);
    fireEvent.click(box);
    expect(turnOn.disabled).toBe(false);
    fireEvent.click(turnOn);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ version: 1, rightsConfirmed: true }));
  });
  it('turning it on from People posts the consent with the setting', async () => {
    const off = status({
      features: { ...status().features, face_grouping: 'off_member' },
      member: { ...status().member, faceGrouping: false, faceConsentAt: null },
    });
    mockApi(
      (url, method) =>
        url === '/api/v1/ai/settings' && method === 'PATCH'
          ? json(200, { ok: true, ...status() })
          : url.startsWith('/api/v1/ai/people')
            ? json(200, { ok: true, people: [] })
            : undefined,
      off,
    );
    renderAt('/people');
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on face grouping' }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/v1/ai/settings')?.body).toEqual({
        faceGrouping: true,
        faceConsent: { version: 1, rightsConfirmed: true },
      }),
    );
  });
  it('shows the upgrade hint on Free', async () => {
    mockApi(() => undefined, status({ features: { ...status().features, face_grouping: 'off_plan' } }));
    renderAt('/people');
    expect(await screen.findByText('Face grouping comes with Pro and Studio.')).toBeTruthy();
  });
});

// ---------------------------------------------------------------- batch dialog
describe('Zephyr AI for a selection', () => {
  it('estimates device time', () => {
    expect(deviceSeconds(12, 1)).toBe(14);
    expect(aboutTime(deviceSeconds(12, 1))).toBe('about 15 s');
    expect(aboutTime(deviceSeconds(500, 2))).toBe('about 13 min');
  });
  it('does the credit maths, then starts a cloud job and a device job', async () => {
    mockApi((url, method, body) => {
      if (url === '/api/v1/ai/jobs' && method === 'POST') {
        const b = body as { kind: string };
        return json(201, {
          ok: true,
          job: {
            id: b.kind === 'device' ? 'dj' : 'cj',
            kind: b.kind,
            params: b.kind === 'device' ? { steps: ['auto_enhance'] } : null,
          },
          skipped: [],
        });
      }
      if (url.includes('/claim'))
        return json(200, { ok: true, job: { id: 'dj', params: { steps: ['auto_enhance'] } }, remaining: [] });
      return undefined;
    });
    setAiStatus(status());
    const ids = Array.from({ length: 12 }, (_, i) => `${P1.slice(0, -2)}${String(i).padStart(2, '0')}`);
    inRouter(<BatchDialog open photoIds={ids} onClose={() => {}} />);
    expect(screen.getByText('Zephyr AI for 12 photos')).toBeTruthy();
    expect(screen.getByTestId('batch-credits').textContent).toBe('0 credits');
    fireEvent.click(screen.getByRole('checkbox', { name: /Studio background removal/ }));
    expect(screen.getByTestId('batch-credits').textContent).toBe('12 credits');
    expect(screen.getByText(/640 → 628 left/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start · 12 credits' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.url === '/api/v1/ai/jobs' && c.method === 'POST')).toHaveLength(2),
    );
    const posts = calls
      .filter((c) => c.url === '/api/v1/ai/jobs' && c.method === 'POST')
      .map((c) => c.body as Record<string, unknown>);
    expect(posts[0]).toMatchObject({
      kind: 'bg_removal',
      photoIds: ids,
      apply: { bg: 'white', shadow: 'soft', shadowStrength: 40 },
    });
    expect(posts[1]).toMatchObject({
      kind: 'device',
      photoIds: ids,
      params: { steps: ['auto_enhance'], strength: 70, skin: true },
    });
    expect(typeof posts[1]?.device).toBe('string');
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/ai/jobs/dj/claim')).toBe(true));
  });
  it('caps the selection at the plan batch size and blocks a run the credits can’t cover', () => {
    setAiStatus(status({ batchSize: 25, credits: { ...status().credits, balance: 3 } }));
    inRouter(
      <BatchDialog open photoIds={Array.from({ length: 30 }, (_, i) => `p${i}`)} onClose={() => {}} />,
    );
    expect(screen.getByText('Select up to 25 photos at a time on your plan.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    inRouter(<BatchDialog open photoIds={['a', 'b', 'c', 'd']} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Studio background removal/ }));
    expect(screen.getByText('That needs 4 credits and you have 3.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start · 4 credits' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------- editor
const PHOTO: PhotoDetail = {
  id: P1,
  filename: 'SKU-118-front.jpg',
  fileType: 'jpeg',
  sizeBytes: 1000,
  width: 4000,
  height: 3000,
  takenAt: null,
  createdAt: '2026-11-01T00:00:00Z',
  favourite: false,
  hasThumb: true,
  hasPreview: true,
} as unknown as PhotoDetail;
const edit = (version: number, recipe: EditRecipe): PhotoEdit => ({
  photoId: P1,
  recipe,
  version,
  rendered: false,
  updatedAt: '',
});

function EditorHarness({ session }: { session: EditSession }) {
  const [recipe, setRecipe] = useState(session.getSnapshot().recipe);
  session.subscribe(() => setRecipe(session.getSnapshot().recipe));
  const e = {
    recipe,
    preview: (r: EditRecipe) => session.preview(r),
    commit: (r?: EditRecipe) => session.commit(r),
  };
  return <EditorAiPanel photo={PHOTO} session={session} edit={e} onToast={() => {}} />;
}

describe('editor background removal', () => {
  it('creates a job for the photo, polls it, then loads the new edit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const item: AiJobItem = {
      id: 'i1',
      photoId: P1,
      filename: PHOTO.filename,
      status: 'processing',
      error: null,
      credits: 1,
      maskId: null,
      retryable: false,
    };
    let polls = 0;
    mockApi((url, method) => {
      if (url === '/api/v1/ai/jobs' && method === 'POST')
        return json(201, { ok: true, job: { id: 'j1', counts: { total: 1 } }, skipped: [] });
      if (url.startsWith('/api/v1/ai/jobs/j1')) {
        polls += 1;
        const done = polls >= 2;
        return json(200, {
          ok: true,
          job: { id: 'j1', status: done ? 'done' : 'running' },
          items: [{ ...item, status: done ? 'completed' : 'processing', maskId: done ? MASK : null }],
          nextCursor: null,
        });
      }
      if (url === `/api/v1/photos/${P1}/edit`)
        return json(200, {
          ok: true,
          edit: edit(2, {
            v: 1,
            light: { exposure: 0.2 },
            cutout: { mask: MASK, bg: 'white', shadow: 'soft', shadowStrength: 40 },
          }),
        });
      return undefined;
    });
    setAiStatus(status());
    const session = new EditSession(
      P1,
      edit(1, { v: 1, light: { exposure: 0.2 } }),
      { save: vi.fn(), remove: vi.fn() },
      'u1',
    );
    inRouter(<EditorHarness session={session} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove background · 1 credit' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/ai/jobs' && c.method === 'POST')).toBe(true),
    );
    expect(calls.find((c) => c.url === '/api/v1/ai/jobs')?.body).toEqual({
      kind: 'bg_removal',
      photoIds: [P1],
      apply: { bg: 'white', shadow: 'soft', shadowStrength: 40 },
      title: PHOTO.filename,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    await waitFor(() => expect(session.getSnapshot().recipe.cutout?.mask).toBe(MASK));
    expect(session.getSnapshot().version).toBe(2);
    expect(session.getSnapshot().recipe.light).toEqual({ exposure: 0.2 });
    expect(await screen.findByRole('region', { name: 'Background removed' })).toBeTruthy();
  });
  it('says when credits are short', () => {
    mockApi(() => undefined);
    setAiStatus(status({ credits: { ...status().credits, balance: 0 } }));
    const session = new EditSession(P1, null, { save: vi.fn(), remove: vi.fn() }, 'u1');
    inRouter(<EditorHarness session={session} />);
    expect(
      (screen.getByRole('button', { name: 'Remove background · 1 credit' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/You have 0 credits left/)).toBeTruthy();
  });
});

describe('cut-out panel', () => {
  it('changes the background, shadow and edges through the recipe', () => {
    const commit = vi.fn();
    const cutout = { mask: MASK, bg: 'white' as const, shadow: 'soft' as const, shadowStrength: 40 };
    const e = { recipe: { v: 1 as const, light: { exposure: 0.3 }, cutout }, preview: vi.fn(), commit };
    inRouter(<CutoutPanel cutout={cutout} edit={e} credits={1} busy={false} onRunAgain={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Transparent' }));
    expect(commit).toHaveBeenLastCalledWith({
      v: 1,
      light: { exposure: 0.3 },
      cutout: { ...cutout, bg: 'transparent' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Background colour #DCE6EE' }));
    expect(commit).toHaveBeenLastCalledWith({
      v: 1,
      light: { exposure: 0.3 },
      cutout: { ...cutout, bg: 'color', color: '#dce6ee' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Hex colour' }), { target: { value: '#123456' } });
    expect(commit).toHaveBeenLastCalledWith({
      v: 1,
      light: { exposure: 0.3 },
      cutout: { ...cutout, bg: 'color', color: '#123456' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'None' }));
    expect(commit).toHaveBeenLastCalledWith({
      v: 1,
      light: { exposure: 0.3 },
      cutout: { mask: MASK, bg: 'white', shadow: undefined, shadowStrength: undefined },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove cut-out' }));
    expect(commit).toHaveBeenLastCalledWith({ v: 1, light: { exposure: 0.3 } });
  });
});

// ---------------------------------------------------------------- queue
const JOB: AiJobSummary = {
  id: 'cj',
  kind: 'bg_removal',
  title: 'Product shoot · 12 Oct',
  status: 'running',
  createdAt: '2026-11-01T01:00:00Z',
  updatedAt: '2026-11-01T01:02:00Z',
  finishedAt: null,
  counts: { total: 3, pending: 1, processing: 0, completed: 1, failed: 1, canceled: 0 },
  credits: { charged: 3, refunded: 1 },
  apply: { bg: 'white' },
  params: null,
  holder: null,
  coverPhotoId: P1,
};
describe('AI queue', () => {
  it('lists jobs with their photos and retries a failed one', async () => {
    mockApi((url, method) => {
      if (url.startsWith('/api/v1/ai/jobs?'))
        return json(200, {
          ok: true,
          jobs: [JOB],
          nextCursor: null,
          counts: { running: 1, finished: 4, failed: 1 },
        });
      if (url.startsWith('/api/v1/ai/jobs/cj/retry') && method === 'POST')
        return json(200, { ok: true, job: JOB });
      if (url.startsWith('/api/v1/ai/jobs/cj'))
        return json(200, {
          ok: true,
          job: JOB,
          items: [
            {
              id: 'i1',
              photoId: P1,
              filename: 'SKU-118-front.jpg',
              status: 'completed',
              error: null,
              credits: 1,
              maskId: MASK,
              retryable: false,
            },
            {
              id: 'i2',
              photoId: P2,
              filename: 'SKU-121-front.jpg',
              status: 'failed',
              error: 'provider_timeout',
              credits: 0,
              maskId: null,
              retryable: true,
            },
            {
              id: 'i3',
              photoId: P3,
              filename: 'SKU-122-front.jpg',
              status: 'pending',
              error: null,
              credits: 1,
              maskId: null,
              retryable: false,
            },
          ],
          nextCursor: null,
        });
      return undefined;
    });
    renderAt('/ai/queue');
    expect(await screen.findByRole('heading', { name: 'Product shoot · 12 Oct' })).toBeTruthy();
    expect(screen.getByText('Running · 1')).toBeTruthy();
    expect(await screen.findByText('SKU-121-front.jpg')).toBeTruthy();
    expect(screen.getByText('The cutting service timed out twice')).toBeTruthy();
    expect(screen.getByText('Refunded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry · 1 credit' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/v1/ai/jobs/cj/retry')?.body).toEqual({ itemIds: ['i2'] }),
    );
  });
  it('offers Continue here for a device job no device is running', async () => {
    const dj: AiJobSummary = {
      ...JOB,
      id: 'dj',
      kind: 'device',
      title: 'Tan & Wei',
      status: 'waiting',
      params: { steps: ['color_match'] },
      credits: { charged: 0, refunded: 0 },
      apply: null,
    };
    mockApi((url) =>
      url.startsWith('/api/v1/ai/jobs?')
        ? json(200, {
            ok: true,
            jobs: [dj],
            nextCursor: null,
            counts: { running: 1, finished: 0, failed: 0 },
          })
        : undefined,
    );
    renderAt('/ai/queue');
    expect(await screen.findByText('Waiting for this device')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue here' })).toBeTruthy();
  });
});

// ---------------------------------------------------------------- cleanup
const cp = (id: string, phash: string, sharpness: number, size = 1000): CleanupPhoto => ({
  id,
  phash,
  sharpness,
  takenAt: '2026-09-07T10:00:00Z',
  createdAt: '2026-09-07T10:00:00Z',
  sizeBytes: size,
  width: 4000,
  height: 3000,
  dupIgnored: false,
  blurIgnored: false,
});
describe('cleanup', () => {
  it('ticks everything but the best of each group', () => {
    const t = defaultTrash({
      duplicates: [{ photos: [cp('a', '0', 1), cp('b', '0', 1)], keep: 'a', savings: 1 }],
      bursts: [],
      blurry: [cp('z', '0', 1)],
    });
    expect([...t].sort()).toEqual(['b', 'z']);
  });
  it('moves the others to the Trash and remembers “Not duplicates”', async () => {
    mockApi((url) =>
      url.startsWith('/api/v1/ai/cleanup?') || url === '/api/v1/ai/cleanup'
        ? json(200, {
            ok: true,
            photos: [
              cp(P1, 'ffff0000ffff0000', 500, 3000),
              cp(P2, 'ffff0000ffff0001', 300, 2000),
              cp(P3, '0000ffff0000ffff', 400),
            ],
            nextCursor: null,
          })
        : url === '/api/v1/photos/bulk'
          ? json(200, { ok: true, affected: 1 })
          : undefined,
    );
    renderAt('/cleanup');
    const btn = await screen.findByRole('button', { name: 'Keep best, move 1 other to Trash' });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/v1/photos/bulk')?.body).toEqual({
        ids: [P2],
        action: 'trash',
      }),
    );
    cleanup();
    mockApi((url) =>
      url.startsWith('/api/v1/ai/cleanup')
        ? json(200, {
            ok: true,
            photos: [cp(P1, 'ffff0000ffff0000', 500), cp(P2, 'ffff0000ffff0001', 300)],
            nextCursor: null,
          })
        : undefined,
    );
    renderAt('/cleanup');
    fireEvent.click(await screen.findByRole('button', { name: 'Not duplicates' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/v1/ai/cleanup/ignore')?.body).toEqual({
        kind: 'duplicates',
        photoIds: [P1, P2],
      }),
    );
  });
});

// ---------------------------------------------------------------- person
describe('a person', () => {
  const PERSON = {
    id: 'pp1',
    name: 'Mei Lin',
    faceCount: 10,
    photoCount: 2,
    hidden: false,
    cover: { photoId: P1, box: [0.4, 0.2, 0.1, 0.15] },
    firstAt: '2019-01-01T00:00:00Z',
    lastAt: '2026-01-01T00:00:00Z',
  };
  const items = [P1, P2].map((id) => ({
    id,
    filename: `${id}.jpg`,
    fileType: 'jpeg',
    sizeBytes: 1,
    width: 4,
    height: 3,
    takenAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    favourite: false,
    hasThumb: true,
    hasPreview: true,
  }));
  function api() {
    mockApi((url, method) => {
      if (url === '/api/v1/ai/people/pp1' && method === 'GET') return json(200, { ok: true, person: PERSON });
      if (url === '/api/v1/ai/people/pp1' && method === 'PATCH')
        return json(200, { ok: true, person: { ...PERSON, name: 'Mei' } });
      if (url === '/api/v1/ai/people/pp1/faces')
        return json(200, { ok: true, person: { ...PERSON, photoCount: 1 } });
      if (url.startsWith('/api/v1/photos?')) return json(200, { ok: true, items, nextCursor: null });
      return undefined;
    });
  }
  it('renames on blur and lists the person’s photos by ?person=', async () => {
    api();
    renderAt('/people/pp1');
    const name = (await screen.findByRole('textbox', { name: 'Name' })) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Mei Lin'));
    expect(calls.some((c) => c.url.startsWith('/api/v1/photos?') && c.url.includes('person=pp1'))).toBe(true);
    fireEvent.change(name, { target: { value: 'Mei' } });
    fireEvent.blur(name);
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/v1/ai/people/pp1' && c.method === 'PATCH')?.body).toEqual({
        name: 'Mei',
      }),
    );
  });
  it('“Not Mei Lin” removes the selected photos from the person', async () => {
    api();
    renderAt('/people/pp1');
    await screen.findByText('2 photos · 2019 to 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    const tiles = await screen.findAllByRole('button', { pressed: false });
    fireEvent.click(tiles[0] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Not Mei Lin' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/v1/ai/people/pp1/faces')?.body).toEqual({
        action: 'remove',
        photoIds: [P1],
      }),
    );
  });
});

// ---------------------------------------------------------------- settings
describe('Settings › Zephyr AI', () => {
  it('turns scene tags off, and deletes face data after confirming', async () => {
    mockApi((url, method) => {
      if (url === '/api/v1/ai/settings' && method === 'PATCH')
        return json(200, { ok: true, ...status({ member: { ...status().member, sceneTags: false } }) });
      if (url === '/api/v1/ai/faces' && method === 'DELETE') return new Response(null, { status: 204 });
      if (url.startsWith('/api/v1/ai/credits'))
        return json(200, {
          ok: true,
          balance: status().credits,
          entries: [
            {
              id: 'e1',
              at: '2026-11-01T00:00:00Z',
              delta: 1000,
              reason: 'monthly_grant',
              label: 'Pro',
              jobId: null,
            },
          ],
          nextCursor: null,
        });
      return undefined;
    });
    renderAt('/settings/ai');
    fireEvent.click(await screen.findByRole('switch', { name: 'Scene tags' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/v1/ai/settings')?.body).toEqual({ sceneTags: false }),
    );
    expect(await screen.findByText(/Monthly credits · Pro/)).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Face grouping' }));
    expect(screen.getByText('Turn off face grouping?')).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/v1/ai/faces')).toBe(false);
    const dlg = screen.getByText('Turn off face grouping?').closest('dialog') as HTMLElement;
    fireEvent.click(within(dlg).getByRole('button', { name: 'Turn off and delete' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/ai/faces')?.method).toBe('DELETE'));
  });
});
