import { type EditRecipe, EMPTY_RECIPE, type PhotoEdit } from '@zephyr/shared/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../api';
import { setSessionUserId } from '../sessionGuard';
import { clearCopied, copyEdits, getCopied } from './clipboard';
import { formatValue, getValue, resetSection, setMixer, setValue } from './controls';
import {
  bandWeights,
  developParams,
  developPixel,
  developSrgb8,
  NEUTRAL,
  tone,
  whiteBalance,
} from './develop';
import {
  apply,
  centredRect,
  dragRect,
  invert,
  mul,
  outputSize,
  outputToSource,
  squareToQuad,
  straightenZoom,
} from './geometry';
import { exportName, uniqueNames } from './names';
import { RenderQueue } from './queue';
import {
  halfLut,
  isTiff,
  rawBase,
  rawBaselineEv,
  rawCurve,
  rawCurveInverse,
  srgb8ToLinear,
  toHalf,
} from './rawCommon';
import { EditSession, HISTORY_LIMIT } from './session';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('develop maths', () => {
  it('leaves pixels alone with a neutral recipe', () => {
    for (const px of [
      [0, 0, 0],
      [12, 200, 90],
      [255, 255, 255],
      [128, 128, 128],
    ] as [number, number, number][]) {
      expect(developSrgb8(px, developParams(null))).toEqual(px);
    }
  });
  it('exposure +1 doubles linear light', () => {
    const p = developParams({ v: 1, light: { exposure: 1 } });
    close(p.gain, 2);
    const out = developPixel([0.1, 0.1, 0.1], 0.1, 0.5, 0.5, p);
    close(out[0], 0.2, 1e-4);
  });
  it('white balance keeps luminance and warms with positive temperature', () => {
    const [r, g, b] = whiteBalance(50, 0);
    close(0.2126 * r + 0.7152 * g + 0.0722 * b, 1);
    expect(r).toBeGreaterThan(1);
    expect(b).toBeLessThan(1);
  });
  it('highlights pull bright areas down and leave shadows', () => {
    const p = { ...NEUTRAL, highlights: -1 };
    expect(tone(0.9, 0.9, p)).toBeLessThan(0.9);
    close(tone(0.1, 0.1, p), 0.1, 1e-3);
  });
  it('contrast pivots around middle grey', () => {
    const p = { ...NEUTRAL, contrast: 0.5 };
    close(tone(0.4587, 0.4587, p), 0.4587, 1e-6);
    expect(tone(0.8, 0.8, p)).toBeGreaterThan(0.8);
    expect(tone(0.2, 0.2, p)).toBeLessThan(0.2);
  });
  it('saturation −100 is greyscale', () => {
    const out = developSrgb8([200, 60, 30], developParams({ v: 1, color: { saturation: -100 } }));
    expect(Math.max(...out) - Math.min(...out)).toBeLessThanOrEqual(1);
  });
  it('band weights crossfade and sum to one', () => {
    for (const h of [0, 15, 45, 90, 150, 210, 255, 285, 330, 359]) {
      close(
        bandWeights(h).reduce((a, b) => a + b, 0),
        1,
        1e-9,
      );
    }
    expect(bandWeights(30)[1]).toBe(1);
  });
  it('vignette darkens corners, not the centre', () => {
    const p = developParams({ v: 1, effects: { vignette: -100 } });
    const c = developPixel([0.5, 0.5, 0.5], 0.5, 0.5, 0.5, p);
    const k = developPixel([0.5, 0.5, 0.5], 0.5, 0, 0, p);
    close(c[0], 0.5, 1e-9);
    expect(k[0]).toBeLessThan(0.2);
  });
});

describe('geometry', () => {
  const src = { width: 600, height: 400 };
  it('identity maps output to source', () => {
    const m = outputToSource(undefined, src);
    expect(apply(m, 0.25, 0.75)).toEqual([0.25, 0.75]);
  });
  it('quarter turns and flips land on the right source corners', () => {
    // Clockwise turn: the output's top-left shows the source's bottom-left.
    const m = outputToSource({ quarterTurns: 1 }, src);
    const [x, y] = apply(m, 0, 0);
    close(x, 0);
    close(y, 1);
    expect(outputSize({ quarterTurns: 1 }, src)).toEqual({ width: 400, height: 600 });
    const f = outputToSource({ flipH: true }, src);
    close(apply(f, 0, 0)[0], 1);
  });
  it('crop rectangle selects part of the image', () => {
    const m = outputToSource({ rect: { x: 0.5, y: 0.25, w: 0.5, h: 0.5 } }, src);
    expect(apply(m, 0, 0)).toEqual([0.5, 0.25]);
    expect(apply(m, 1, 1)).toEqual([1, 0.75]);
    expect(outputSize({ rect: { x: 0.5, y: 0.25, w: 0.5, h: 0.5 } }, src)).toEqual({
      width: 300,
      height: 200,
    });
  });
  it('straighten zooms in so no empty corners show', () => {
    const s = straightenZoom(10, src);
    expect(s).toBeLessThan(1);
    const m = outputToSource({ angle: 10 }, src);
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]) {
      const [x, y] = apply(m, u as number, v as number);
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(1 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
  it('perspective samples a trapezoid inside the image', () => {
    const m = outputToSource({ perspectiveV: 100 }, src);
    const [x0] = apply(m, 0, 0);
    const [x1] = apply(m, 0, 1);
    expect(x0).toBeGreaterThan(0.1);
    close(x1, 0);
  });
  it('square-to-quad and invert agree', () => {
    const q = squareToQuad([
      [0.1, 0.2],
      [0.9, 0.1],
      [1, 1],
      [0, 0.8],
    ]);
    const [x, y] = apply(mul(invert(q), q), 0.3, 0.6);
    close(x, 0.3, 1e-9);
    close(y, 0.6, 1e-9);
  });
  it('centred rect and drag keep the aspect inside the image', () => {
    const t = { width: 600, height: 400 };
    const r = centredRect(4 / 5, t);
    close((r.w * 600) / (r.h * 400), 0.8, 1e-9);
    const d = dragRect(r, 'se', 0.5, 0.5, 4 / 5, t);
    expect(d.x + d.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(d.y + d.h).toBeLessThanOrEqual(1 + 1e-9);
    close((d.w * 600) / (d.h * 400), 0.8, 1e-6);
    const m = dragRect(r, 'move', 5, 0, null, t);
    close(m.x + m.w, 1);
  });
});

describe('controls', () => {
  it('formats values with a real minus sign', () => {
    expect(formatValue(0.35, 0.01)).toBe('+0.35');
    expect(formatValue(-42, 1)).toBe('−42');
    expect(formatValue(0, 1)).toBe('0');
    expect(formatValue(-2.4, 0.1, '°')).toBe('−2.4°');
  });
  it('sets, reads and resets sections', () => {
    let r: EditRecipe = setValue(EMPTY_RECIPE, { section: 'light', key: 'exposure' }, 0.5);
    r = setMixer(r, 'blue', 'hue', -20);
    expect(getValue(r, { section: 'light', key: 'exposure' })).toBe(0.5);
    expect(resetSection(r, 'light')).toEqual({ v: 1, mixer: { blue: { hue: -20 } } });
  });
});

describe('RAW helpers', () => {
  it('recognises TIFF containers only', () => {
    expect(isTiff(new Uint8Array([0x49, 0x49, 0x2a, 0x00]))).toBe(true);
    expect(isTiff(new Uint8Array([0x4d, 0x4d, 0x00, 0x2a]))).toBe(true);
    expect(isTiff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
  });
  it('encodes half floats', () => {
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(0.5)).toBe(0x3800);
    expect(toHalf(0)).toBe(0);
    expect(halfLut()[65535]).toBe(0x3c00);
  });
});

describe('RAW base curve', () => {
  it('keeps middle grey, rises steadily and never reaches white', () => {
    expect(rawCurve(0.18)).toBeCloseTo(0.18, 6);
    let prev = 0;
    for (let ev = -14; ev <= 8; ev += 0.25) {
      const y = rawCurve(0.18 * 2 ** ev);
      expect(y).toBeGreaterThan(prev);
      expect(y).toBeLessThan(1);
      prev = y;
    }
  });
  it('adds midtone contrast and rolls highlights off instead of clipping them', () => {
    // One stop above grey comes out more than one stop up; scene white and far above stay below 1.
    expect(Math.log2(rawCurve(0.36) / 0.18)).toBeGreaterThan(1.3);
    expect(Math.log2(0.18 / rawCurve(0.09))).toBeGreaterThan(1.2);
    expect(rawCurve(1)).toBeGreaterThan(0.8);
    expect(rawCurve(16)).toBeLessThan(1);
  });
  it('inverts', () => {
    for (const y of [0.001, 0.02, 0.18, 0.5, 0.9]) expect(rawCurve(rawCurveInverse(y))).toBeCloseTo(y, 6);
  });
  it('keeps hue and fits bright colours into gamut', () => {
    const [r, g, b] = rawBase([0.3, 0.15, 0.05]);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    const hot = rawBase([12, 3, 0.5]);
    expect(Math.max(...hot)).toBeLessThanOrEqual(1 + 1e-9);
    expect(hot[0]).toBeGreaterThan(hot[2]); // still red, not white
  });
  it('applies only to RAW sources, before the recipe', () => {
    const p = developParams({ v: 1, light: { exposure: 1 } }, 1.5, 0.5, true);
    close(p.baseGain, 2 ** 0.5);
    close(p.gain, 2);
    expect(p.raw).toBe(true);
    expect(developParams(null).raw).toBe(false);
    // Neutral RAW = baseline then curve; neutral non-RAW = unchanged.
    const raw = developPixel([0.09, 0.09, 0.09], 0.09, 0.5, 0.5, developParams(null, 1.5, 1, true));
    close(raw[1], rawCurve(0.18), 1e-6);
    const jpeg = developPixel([0.09, 0.09, 0.09], 0.09, 0.5, 0.5, developParams(null));
    close(jpeg[1], 0.09, 1e-6);
  });
});

describe('RAW baseline exposure', () => {
  const fill = (v: number, n = 400) => Array.from({ length: n }, (_, i) => v * (0.5 + (i % 10) / 10));
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1] as number;
  it('puts the RAW median, after the base curve, where the camera JPEG has it', () => {
    const raw = fill(0.04);
    for (const j of [0.02, 0.05, 0.12]) {
      const ev = rawBaselineEv(raw, fill(j));
      expect(rawCurve(median(raw) * 2 ** ev)).toBeCloseTo(median(fill(j)), 2);
    }
  });
  it('clamps to −1…+3 EV, so night stays night', () => {
    expect(rawBaselineEv(fill(0.04), fill(0.0005))).toBe(-1);
    expect(rawBaselineEv(fill(0.0005), fill(0.5))).toBe(3);
  });
  it('falls back to the log-average without a usable JPEG', () => {
    const ev = rawBaselineEv(fill(0.05), null);
    expect(ev).toBeGreaterThan(0);
    expect(ev).toBeLessThan(2);
    expect(rawBaselineEv(fill(0.0001), null)).toBe(2);
    expect(rawBaselineEv(fill(0.04), fill(0.04).slice(0, 10))).toBe(rawBaselineEv(fill(0.04), null));
  });
  it('decodes sRGB', () => {
    expect(srgb8ToLinear(255)).toBeCloseTo(1);
    expect(srgb8ToLinear(119)).toBeCloseTo(0.184, 2);
  });
});

describe('export names', () => {
  it('makes safe, unique file names', () => {
    expect(exportName('IMG_2041.CR2')).toBe('IMG_2041-edited.jpg');
    expect(exportName('a/b:c?.jpg')).toBe('a_b_c_-edited.jpg');
    expect(uniqueNames(['a.jpg', 'A.jpg', 'b.jpg'])).toEqual(['a.jpg', 'A (2).jpg', 'b.jpg']);
  });
});

// ------------------------------------------------------------ session (undo, autosave, conflict)
const edit = (version: number, recipe: EditRecipe = { v: 1 }): PhotoEdit => ({
  photoId: 'p1',
  recipe,
  version,
  rendered: false,
  updatedAt: '',
});
describe('EditSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('records one undo step per commit, not per preview', () => {
    const s = new EditSession('p1', null, { save: vi.fn(), remove: vi.fn() });
    s.preview({ v: 1, light: { exposure: 0.1 } });
    s.preview({ v: 1, light: { exposure: 0.2 } });
    s.commit();
    s.commit({ v: 1, light: { exposure: 0.5 } });
    expect(s.getSnapshot().canUndo).toBe(true);
    s.undo();
    expect(s.getSnapshot().recipe).toEqual({ v: 1, light: { exposure: 0.2 } });
    s.undo();
    expect(s.getSnapshot().recipe).toEqual({ v: 1 });
    expect(s.getSnapshot().canUndo).toBe(false);
    s.redo();
    expect(s.getSnapshot().recipe).toEqual({ v: 1, light: { exposure: 0.2 } });
  });

  it('caps history at 100 steps', () => {
    const s = new EditSession('p1', null, { save: vi.fn(), remove: vi.fn() });
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) s.commit({ v: 1, light: { contrast: i % 100 || 1 } });
    let n = 0;
    while (s.getSnapshot().canUndo) {
      s.undo();
      n++;
    }
    expect(n).toBe(HISTORY_LIMIT);
  });

  it('autosaves 800 ms after the last change, with the base version', async () => {
    const save = vi.fn(async (_id: string, r: EditRecipe, base: number | null) => edit((base ?? 0) + 1, r));
    const onSaved = vi.fn();
    const s = new EditSession('p1', edit(3, { v: 1, color: { tint: 4 } }), {
      save,
      remove: vi.fn(),
      onSaved,
    });
    s.commit({ v: 1, color: { tint: 10 } });
    await vi.advanceTimersByTimeAsync(500);
    s.commit({ v: 1, color: { tint: 12 } });
    await vi.advanceTimersByTimeAsync(700);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('p1', { v: 1, color: { tint: 12 } }, 3);
    expect(s.getSnapshot().status).toBe('saved');
    expect(s.getSnapshot().version).toBe(4);
    expect(onSaved).toHaveBeenCalledWith('p1', expect.objectContaining({ version: 4 }), {
      v: 1,
      color: { tint: 12 },
    });
  });

  it('reverting to the original deletes the edit', async () => {
    const remove = vi.fn(async () => {});
    const s = new EditSession('p1', edit(2, { v: 1, light: { exposure: 1 } }), { save: vi.fn(), remove });
    s.revert();
    await s.flush();
    expect(remove).toHaveBeenCalledWith('p1');
    expect(s.getSnapshot().version).toBeNull();
    s.undo();
    expect(s.getSnapshot().recipe).toEqual({ v: 1, light: { exposure: 1 } });
  });

  it('a 409 conflict offers the newer edit or keeping mine', async () => {
    const theirs = edit(9, { v: 1, light: { contrast: 50 } });
    const save = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiFailure('conflict', 409, undefined, { ok: false, error: 'conflict', edit: theirs }),
      )
      .mockImplementation(async (_id: string, r: EditRecipe, base: number) => edit(base + 1, r));
    const s = new EditSession('p1', edit(3, { v: 1 }), { save, remove: vi.fn() });
    s.commit({ v: 1, light: { exposure: 1 } });
    await s.flush();
    expect(s.getSnapshot().status).toBe('conflict');
    expect(s.getSnapshot().conflict?.version).toBe(9);
    // Keep mine: saves over version 9.
    s.keepMine();
    await vi.runAllTimersAsync();
    await s.flush();
    expect(save).toHaveBeenLastCalledWith('p1', { v: 1, light: { exposure: 1 } }, 9);
    expect(s.getSnapshot().version).toBe(10);
  });

  it('loading the newer edit replaces the recipe as an undoable step', async () => {
    const theirs = edit(9, { v: 1, light: { contrast: 50 } });
    const save = vi.fn().mockRejectedValueOnce(new ApiFailure('conflict', 409, undefined, { edit: theirs }));
    const s = new EditSession('p1', edit(3), { save, remove: vi.fn() });
    s.commit({ v: 1, light: { exposure: 1 } });
    await s.flush();
    s.takeTheirs();
    expect(s.getSnapshot().recipe).toEqual({ v: 1, light: { contrast: 50 } });
    expect(s.getSnapshot().status).toBe('saved');
    expect(s.getSnapshot().version).toBe(9);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('other errors can be retried', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new ApiFailure('network', 0))
      .mockResolvedValue(edit(4, { v: 1, light: { exposure: 1 } }));
    const s = new EditSession('p1', edit(3), { save, remove: vi.fn() });
    s.commit({ v: 1, light: { exposure: 1 } });
    await s.flush();
    expect(s.getSnapshot().status).toBe('error');
    s.retry();
    await vi.runAllTimersAsync();
    expect(s.getSnapshot().status).toBe('saved');
  });
});

// ------------------------------------------------------------ queue (resume, owner, reset)
describe('RenderQueue', () => {
  const blob = new Blob(['x'], { type: 'image/webp' });
  const deps = (owner: () => string | null = () => 'u1') => ({
    owner,
    render: vi.fn(async () => ({ thumb: blob, preview: blob })),
    getEdit: vi.fn(async (id: string) => edit(id === 'stale' ? 99 : 5, { v: 1, light: { exposure: 1 } })),
    put: vi.fn(async () => {}),
    onRendered: vi.fn(),
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('resumes edits whose thumbnails were never rendered', async () => {
    const d = deps();
    const q = new RenderQueue(d);
    q.resume([
      { id: 'a', filename: 'a.jpg', edit: { version: 5, rendered: false } },
      { id: 'b', filename: 'b.jpg', edit: { version: 2, rendered: true } },
      { id: 'c', filename: 'c.jpg', edit: null },
    ]);
    for (let i = 0; i < 5; i++) await settle();
    expect(d.render).toHaveBeenCalledTimes(1);
    expect(d.put).toHaveBeenCalledWith('a', 'thumb', 5, blob);
    expect(d.put).toHaveBeenCalledWith('a', 'preview', 5, blob);
    expect(d.onRendered).toHaveBeenCalledWith('a', 5);
  });

  it('uses variants the editor already rendered, and renders from the preview on retry', async () => {
    const d = deps();
    const q = new RenderQueue(d);
    const own = new Blob(['raw'], { type: 'image/webp' });
    q.enqueue(
      [
        {
          photoId: 'r',
          name: 'r.nef',
          version: 5,
          recipe: { v: 1 },
          rendered: Promise.resolve({ thumb: own, preview: own }),
        },
      ],
      false,
    );
    for (let i = 0; i < 5; i++) await settle();
    expect(d.render).not.toHaveBeenCalled();
    expect(d.put).toHaveBeenCalledWith('r', 'thumb', 5, own);
    // A failed editor render falls back to the stored preview.
    q.enqueue(
      [
        {
          photoId: 'f',
          name: 'f.nef',
          version: 6,
          recipe: { v: 1 },
          rendered: Promise.reject(new Error('lost')),
        },
      ],
      false,
    );
    for (let i = 0; i < 5; i++) await settle();
    expect(d.render).toHaveBeenCalledWith('f', { v: 1 });
  });

  it('skips a version that has since changed', async () => {
    const d = deps();
    const q = new RenderQueue(d);
    q.enqueue([{ photoId: 'stale', name: 's', version: 5 }], true);
    for (let i = 0; i < 5; i++) await settle();
    expect(d.render).not.toHaveBeenCalled();
    expect(q.getSnapshot().items[0]?.state).toBe('completed');
  });

  it('treats 410 as stale and storage_full as done, other errors as failed', async () => {
    const d = deps();
    d.put
      .mockRejectedValueOnce(new ApiFailure('conflict', 410))
      .mockRejectedValueOnce(new ApiFailure('storage_full', 413))
      .mockRejectedValueOnce(new ApiFailure('server', 500));
    const q = new RenderQueue(d);
    const r: EditRecipe = { v: 1 };
    q.startJob('Pasting');
    q.enqueue(
      [
        { photoId: 'a', name: 'a', version: 1, recipe: r },
        { photoId: 'b', name: 'b', version: 1, recipe: r },
        { photoId: 'c', name: 'c', version: 1, recipe: r },
      ],
      true,
    );
    for (let i = 0; i < 20; i++) await settle();
    const st = Object.fromEntries(q.getSnapshot().items.map((i) => [i.photoId, i.state]));
    expect(st).toEqual({ a: 'completed', b: 'completed', c: 'failed' });
    expect(q.getSnapshot().failed).toBe(1);
  });

  it('sends nothing once someone else is signed in, and reset drops everything', async () => {
    let who: string | null = 'u1';
    const d = deps(() => who);
    let release!: () => void;
    d.render.mockImplementationOnce(
      () => new Promise((res) => (release = () => res({ thumb: blob, preview: blob }))),
    );
    const q = new RenderQueue(d);
    q.enqueue([{ photoId: 'a', name: 'a', version: 1, recipe: { v: 1 } }], true);
    await settle();
    who = 'u2';
    release();
    for (let i = 0; i < 5; i++) await settle();
    expect(d.put).not.toHaveBeenCalled();
    q.reset();
    expect(q.getSnapshot().items).toEqual([]);
    expect(q.getSnapshot().job).toBeNull();
  });
});

// ------------------------------------------------------------ clipboard
describe('copied edits', () => {
  afterEach(() => {
    clearCopied();
    setSessionUserId(null);
  });
  it('belong to the member who copied them', () => {
    setSessionUserId('u1');
    copyEdits({ v: 1, light: { exposure: 1 } }, 'p', 'p.jpg');
    expect(getCopied()?.recipe).toEqual({ v: 1, light: { exposure: 1 } });
    setSessionUserId('u2');
    expect(getCopied()).toBeNull();
  });
  it('need someone signed in', () => {
    copyEdits({ v: 1 }, 'p', 'p.jpg');
    expect(getCopied()).toBeNull();
  });
});
