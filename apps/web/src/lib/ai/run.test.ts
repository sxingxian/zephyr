import type { EditRecipe, PhotoEdit } from '@zephyr/shared/client';
import { describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../api';
import { type LinearImage, proxyFromLinear } from './proxy';
import { applySteps, type Photo, type RunDeps, runDeviceSteps } from './run';

const photo: Photo = {
  id: '11111111-1111-4111-8111-111111111111',
  filename: 'a.jpg',
  fileType: 'jpeg',
  hasPreview: true,
};
function darkImage(): LinearImage {
  const w = 120;
  const h = 80;
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const t = (i % w) / w;
    rgb.set([0.02 + 0.03 * t, 0.02 + 0.025 * t, 0.03 + 0.02 * t], i * 3);
  }
  return { w, h, rgb };
}
const proxy = proxyFromLinear(darkImage(), { width: 120, height: 80 }, undefined, 128, 0, false);
const edit = (recipe: EditRecipe, version = 3): PhotoEdit => ({
  photoId: photo.id,
  recipe,
  version,
  rendered: true,
  updatedAt: '2026-11-01T00:00:00Z',
});

function deps(over: Partial<RunDeps> = {}): Partial<RunDeps> & { saveEdit: ReturnType<typeof vi.fn> } {
  const saveEdit = vi.fn(async (_id: string, recipe: EditRecipe, base: number | null) =>
    edit(recipe, (base ?? 0) + 1),
  );
  return {
    getEdit: async () => edit({ v: 1, detail: { sharpening: 30 }, crop: { angle: 2 } }),
    saveEdit,
    loadProxy: async () => proxy,
    faces: async () => [],
    saved: vi.fn(),
    owner: () => 'me',
    ...over,
  } as Partial<RunDeps> & { saveEdit: ReturnType<typeof vi.fn> };
}

describe('device steps', () => {
  it('auto-enhances, keeps the crop and detail, and saves against the base version', async () => {
    const d = deps();
    const res = await runDeviceSteps(photo, { steps: ['auto_enhance'] }, { owner: 'me', deps: d });
    expect(res.status).toBe('done');
    const [, recipe, base, owner] = d.saveEdit.mock.calls[0] as [string, EditRecipe, number, string];
    expect(base).toBe(3);
    expect(owner).toBe('me');
    expect(recipe.light?.exposure ?? 0).toBeGreaterThan(0.5);
    expect(recipe.detail?.sharpening).toBe(30);
    expect(recipe.crop?.angle).toBe(2);
    expect(d.saved).toHaveBeenCalledOnce();
    if (res.status === 'done') expect(res.changed).toBeGreaterThan(0);
  });

  it('fails the photo on a conflict instead of applying the steps again on top (client review #2)', async () => {
    const saveEdit = vi.fn(async () => {
      throw new ApiFailure('conflict', 409);
    });
    const d = deps({ saveEdit });
    const res = await runDeviceSteps(photo, { steps: ['hdr'] }, { owner: 'me', deps: d });
    expect(saveEdit).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ status: 'failed', error: 'conflict' });
  });

  it('leaves alone a photo edited since the job started, so HDR never stacks (client review #2)', async () => {
    const d = deps();
    const res = await runDeviceSteps(
      photo,
      { steps: ['hdr'] },
      { owner: 'me', deps: d, since: '2026-10-31T23:00:00Z' }, // the photo's edit is from 1 Nov 00:00
    );
    expect(res).toEqual({ status: 'unchanged' });
    expect(d.saveEdit).not.toHaveBeenCalled();
    const ok = await runDeviceSteps(
      photo,
      { steps: ['hdr'] },
      { owner: 'me', deps: deps(), since: '2026-11-01T01:00:00Z' },
    );
    expect(ok.status).toBe('done');
  });

  it('stops the whole job when someone else is signed in or the session ended', async () => {
    await expect(
      runDeviceSteps(photo, { steps: ['hdr'] }, { owner: 'me', deps: deps({ owner: () => 'other' }) }),
    ).rejects.toThrow(/someone else/);
    const saveEdit = vi.fn(async () => {
      throw new ApiFailure('session_changed', 409);
    });
    await expect(
      runDeviceSteps(photo, { steps: ['hdr'] }, { owner: 'me', deps: deps({ saveEdit }) }),
    ).rejects.toBeInstanceOf(ApiFailure);
    const ac = new AbortController();
    ac.abort();
    await expect(
      runDeviceSteps(photo, { steps: ['hdr'] }, { owner: 'me', signal: ac.signal, deps: deps() }),
    ).rejects.toThrow();
  });

  it('reports an undecodable photo as failed without stopping', async () => {
    const res = await runDeviceSteps(
      photo,
      { steps: ['auto_enhance'] },
      {
        owner: 'me',
        deps: deps({
          loadProxy: async () => {
            throw new Error('decode');
          },
        }),
      },
    );
    expect(res).toEqual({ status: 'failed', error: 'decode' });
  });

  it('skips the save when nothing changes, and needs the reference for colour match', async () => {
    const same = await applySteps(proxy, { v: 1 }, { steps: ['color_match'] }, [], {
      proxy,
      recipe: null,
    }).then((r) => r);
    expect(same.v).toBe(1);
    await expect(applySteps(proxy, { v: 1 }, { steps: ['color_match'] }, [])).rejects.toThrow(/reference/);
    const d = deps({ getEdit: async () => null });
    const res = await runDeviceSteps(
      photo,
      { steps: ['color_match'] },
      { owner: 'me', reference: { proxy, recipe: null }, deps: d },
    );
    expect(res.status).toBe('unchanged');
    expect(d.saveEdit).not.toHaveBeenCalled();
  });
});
