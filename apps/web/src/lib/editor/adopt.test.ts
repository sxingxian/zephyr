import type { EditRecipe, PhotoEdit } from '@zephyr/shared/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditSession } from './session';

vi.mock('./cutout', () => ({ activeCutout: () => null, getMask: () => null, loadMask: vi.fn() }));

const edit = (version: number, recipe: EditRecipe): PhotoEdit => ({
  photoId: 'p1',
  recipe,
  version,
  rendered: false,
  updatedAt: '',
});
const MASK = '0b9f4a1e-0f1a-4c4e-9d1f-0e8b7a6c5d4e';

describe('EditSession.adoptServer (phase 6)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('takes the server edit as one undo step when nothing is unsaved', async () => {
    const onSaved = vi.fn();
    const s = new EditSession('p1', edit(2, { v: 1, light: { exposure: 0.5 } }), {
      save: vi.fn(),
      remove: vi.fn(),
      onSaved,
    });
    const server = edit(3, { v: 1, light: { exposure: 0.5 }, cutout: { mask: MASK, bg: 'white' } });
    await s.adoptServer(server);
    const snap = s.getSnapshot();
    expect(snap.version).toBe(3);
    expect(snap.recipe.cutout?.mask).toBe(MASK);
    expect(snap.status).toBe('saved');
    expect(onSaved).toHaveBeenCalledWith('p1', server, expect.objectContaining({ v: 1 }));
    s.undo();
    expect(s.getSnapshot().recipe.cutout).toBeUndefined();
  });

  it('keeps unsaved local changes and saves them on top of the new version', async () => {
    const save = vi.fn(async (_id: string, r: EditRecipe, base: number | null) => edit((base ?? 0) + 1, r));
    const s = new EditSession('p1', edit(2, { v: 1 }), { save, remove: vi.fn() });
    s.commit({ v: 1, color: { tint: 8 } });
    await s.adoptServer(edit(3, { v: 1, cutout: { mask: MASK, bg: 'transparent' } }));
    expect(s.getSnapshot().recipe).toEqual({
      v: 1,
      color: { tint: 8 },
      cutout: { mask: MASK, bg: 'transparent' },
    });
    await vi.advanceTimersByTimeAsync(900);
    expect(save).toHaveBeenCalledWith(
      'p1',
      { v: 1, color: { tint: 8 }, cutout: { mask: MASK, bg: 'transparent' } },
      3,
      expect.any(AbortSignal),
    );
  });

  it('ignores an edit that is not newer', async () => {
    const s = new EditSession('p1', edit(5, { v: 1, light: { exposure: 1 } }), {
      save: vi.fn(),
      remove: vi.fn(),
    });
    await s.adoptServer(edit(4, { v: 1 }));
    expect(s.getSnapshot().recipe).toEqual({ v: 1, light: { exposure: 1 } });
    expect(s.getSnapshot().canUndo).toBe(false);
  });
});
