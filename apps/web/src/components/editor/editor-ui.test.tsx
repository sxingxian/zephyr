import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EditBulkBody, PhotoEdit } from '@zephyr/shared/client';
import { ToastProvider } from '@zephyr/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyToPhotos } from '../../lib/editor/batch';
import { copyEdits, getCopied } from '../../lib/editor/clipboard';
import '../../lib/editor';
import { renderQueue } from '../../lib/editor/queue';
import { endSession, setSessionUserId } from '../../lib/sessionGuard';
import { PasteDialog } from './Dialogs';
import { type CropActions, CropPanel, cropOrientation } from './Panels';
import { PhoneCrop } from './Phone';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
function mockFetch(handler: (url: string, method: string, body: unknown) => Response | undefined) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return handler(url, method, body) ?? json(404, { ok: false, error: 'not_found' });
    }),
  );
}
const edit = (id: string, version: number, recipe = { v: 1 as const }): PhotoEdit => ({
  photoId: id,
  recipe,
  version,
  rendered: false,
  updatedAt: '',
});

beforeEach(() => {
  // jsdom has no dialog modality; make showModal/close toggle `open`.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  setSessionUserId('u1');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  renderQueue.reset();
  setSessionUserId(null);
});

describe('paste dialog', () => {
  it('ticks everything but the crop, and pastes the chosen sections', async () => {
    const onPaste = vi.fn();
    mockFetch(() => undefined);
    render(
      <ToastProvider>
        <PasteDialog open count={12} fromName="IMG_2041.CR2" onClose={() => {}} onPaste={onPaste} />
      </ToastProvider>,
    );
    expect(screen.getByText('Paste edits to 12 photos')).toBeTruthy();
    const crop = screen.getByRole('checkbox', { name: /Crop & straighten/ }) as HTMLInputElement;
    const light = screen.getByRole('checkbox', { name: /Light/ }) as HTMLInputElement;
    expect(crop.checked).toBe(false);
    expect(light.checked).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Effects/ }));
    fireEvent.click(crop);
    fireEvent.click(screen.getByRole('button', { name: 'Paste to 12 photos' }));
    await waitFor(() => expect(onPaste).toHaveBeenCalled());
    expect(onPaste.mock.calls[0]?.[0]).toEqual(['light', 'color', 'mixer', 'detail', 'crop']);
  });
});

describe('batch paste', () => {
  it('pastes in one request, queues thumbnails, and undo puts each photo back', async () => {
    vi.spyOn(renderQueue, 'enqueue').mockImplementation(() => {});
    const bulkBodies: EditBulkBody[] = [];
    mockFetch((url, method, body) => {
      if (url.endsWith('/photos/a/edit') && method === 'GET')
        return json(200, { ok: true, edit: edit('a', 4, { v: 1, light: { exposure: 1 } } as never) });
      if (url.endsWith('/photos/edits/bulk')) {
        bulkBodies.push(body as EditBulkBody);
        const b = body as EditBulkBody;
        return json(200, {
          ok: true,
          affected: b.ids.length,
          edits: b.ids.map((id, i) => ({
            photoId: id,
            edit: b.recipe ? edit(id, 10 + i, b.recipe as never) : null,
          })),
        });
      }
      if (url.endsWith('/photos/a/edit') && method === 'PUT')
        return json(200, { ok: true, edit: edit('a', 20, (body as { recipe: never }).recipe) });
      return undefined;
    });
    const n = await applyToPhotos(
      [
        { id: 'a', filename: 'a.jpg', edit: { version: 4, rendered: true } },
        { id: 'b', filename: 'b.jpg', edit: null },
      ],
      { v: 1, color: { tint: 5 } },
      ['color'],
      'Pasting',
    );
    expect(n).toBe(2);
    expect(bulkBodies[0]).toEqual({
      ids: ['a', 'b'],
      recipe: { v: 1, color: { tint: 5 } },
      sections: ['color'],
    });
    // Only the edited photo's previous recipe was fetched.
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.url)).toEqual(['/api/v1/photos/a/edit']);
    // Writes name the expected member.
    expect(calls.find((c) => c.url.endsWith('/bulk'))?.headers['x-zephyr-expected-user']).toBe('u1');
    const job = renderQueue.getSnapshot().job;
    expect(job?.label).toBe('Pasting');
    await job?.undo?.();
    // b had no edit: reverted in bulk; a gets its previous recipe back over the new version.
    expect(bulkBodies[1]).toEqual({ ids: ['b'], recipe: null, sections: [] });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ recipe: { v: 1, light: { exposure: 1 } }, baseVersion: 10 });
  });
});

describe('session end', () => {
  it('clears copied edits and the thumbnail queue', async () => {
    copyEdits({ v: 1, light: { exposure: 1 } }, 'p', 'p.jpg');
    renderQueue.startJob('Pasting');
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    renderQueue.enqueue([{ photoId: 'x', name: 'x', version: 1 }], true);
    expect(getCopied()).not.toBeNull();
    await endSession('sign-out', false);
    expect(getCopied()).toBeNull();
    expect(renderQueue.getSnapshot().items).toEqual([]);
    expect(renderQueue.getSnapshot().job).toBeNull();
  });
});

describe('crop aspect chips', () => {
  const actions = (orientation: 'portrait' | 'landscape'): CropActions => ({
    orientation,
    setAspect: vi.fn(),
    setOrientation: vi.fn(),
    rotate: vi.fn(),
    flip: vi.fn(),
  });
  const edit = (aspect?: '5:4' | '4:5') => ({
    recipe: { v: 1 as const, ...(aspect ? { crop: { aspect } } : {}) },
    preview: vi.fn(),
    commit: vi.fn(),
  });
  const radios = (name: string) =>
    [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => ({
      label: i.getAttribute('aria-label'),
      checked: i.checked,
      text: i.parentElement?.textContent,
    }));

  it('shows the ratio for the current orientation, with matching labels (desktop and phone)', () => {
    render(
      <CropPanel edit={edit('5:4')} actions={actions(cropOrientation('5:4', { width: 3, height: 2 }))} />,
    );
    let r = radios('crop-aspect');
    expect(r.map((x) => x.text)).toEqual(['Original', 'Free', '1:1', '5:4', '3:2', '16:9']);
    expect(r.map((x) => x.label)).toEqual(r.map((x) => x.text));
    expect(r.find((x) => x.checked)?.label).toBe('5:4');
    cleanup();
    render(
      <PhoneCrop edit={edit('4:5')} actions={actions(cropOrientation('4:5', { width: 3, height: 2 }))} />,
    );
    r = radios('crop-aspect-phone');
    expect(r.map((x) => x.text)).toEqual(['Original', 'Free', '1:1', '4:5', '2:3', '9:16']);
    expect(r.find((x) => x.checked)?.label).toBe('4:5');
  });

  it('without a paired crop, follows the photo orientation', () => {
    expect(cropOrientation(undefined, { width: 4000, height: 3000 })).toBe('landscape');
    expect(cropOrientation('original', { width: 3000, height: 4000 })).toBe('portrait');
    expect(cropOrientation('4:5', { width: 4000, height: 3000 })).toBe('portrait');
  });
});
