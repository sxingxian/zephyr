import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PhotoItem } from '@zephyr/shared/client';
import { ToastProvider } from '@zephyr/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoList } from '../../lib/photos';
import type { Selection } from '../../lib/selection';
import { endSession, setSessionUserId } from '../../lib/sessionGuard';
import { uploads } from '../../lib/uploads';

// Rendering is stood in for: each export waits until the test lets it finish.
let release: (b: Blob) => void = () => undefined;
const seen: { signal?: AbortSignal }[] = [];
vi.mock('../../lib/editor/exporter', () => ({
  renderExport: (_p: unknown, _r: unknown, o: { signal?: AbortSignal }) => {
    seen.push(o);
    return new Promise<Blob>((r) => {
      release = r;
    });
  },
  exportZip: vi.fn(),
  saveBlob: vi.fn(),
}));

const { useEditActions } = await import('./LibraryEdit');

const photo: PhotoItem = {
  id: 'p1',
  filename: 'IMG_1.JPG',
  fileType: 'jpeg',
  sizeBytes: 10,
  width: 400,
  height: 300,
  takenAt: null,
  createdAt: '',
  favourite: false,
  hasThumb: false,
  hasPreview: true,
  edit: null,
};
function Harness() {
  const list = { items: [photo] } as unknown as PhotoList;
  const sel = { selected: new Set(['p1']) } as unknown as Selection;
  const { actions, dialogs } = useEditActions(list, sel);
  const exp = actions.find((a) => a.label === 'Export');
  return (
    <>
      <button type="button" onClick={exp?.onClick}>
        open export
      </button>
      {dialogs}
    </>
  );
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"ok":false,"error":"not_found"}', { status: 404 })),
  );
  seen.length = 0;
  setSessionUserId('u1');
});
afterEach(() => {
  cleanup();
  uploads.reset({ server: false });
  vi.unstubAllGlobals();
  setSessionUserId(null);
});

async function startSaveAsCopy() {
  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByText('open export'));
  fireEvent.click(await screen.findByRole('button', { name: /Save as copy in library/ }));
  await waitFor(() => expect(seen).toHaveLength(1));
}

describe('Save as copy across a session change', () => {
  it('someone else signs in mid-export: nothing is queued for them', async () => {
    const add = vi.spyOn(uploads, 'add');
    await startSaveAsCopy();
    await endSession('switched', false);
    setSessionUserId('u2');
    release(new Blob(['jpeg'], { type: 'image/jpeg' }));
    await waitFor(() => expect(seen[0]?.signal?.aborted).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(add).not.toHaveBeenCalled();
    expect(uploads.getSnapshot().items).toHaveLength(0);
  });

  it('a 401 mid-export stops it', async () => {
    const add = vi.spyOn(uploads, 'add');
    await startSaveAsCopy();
    await endSession('unauthenticated', false);
    setSessionUserId(null);
    expect(seen[0]?.signal?.aborted).toBe(true);
    release(new Blob(['jpeg'], { type: 'image/jpeg' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(add).not.toHaveBeenCalled();
  });

  it('the same member gets the copy, bound to them', async () => {
    const add = vi.spyOn(uploads, 'add').mockResolvedValue('queued');
    await startSaveAsCopy();
    release(new Blob(['jpeg'], { type: 'image/jpeg' }));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add.mock.calls[0]?.[1]).toEqual({ expectedOwner: 'u1' });
    const files = (add.mock.calls[0]?.[0] ?? []) as File[];
    expect(files[0]?.name).toBe('IMG_1-edited.jpg');
  });
});
