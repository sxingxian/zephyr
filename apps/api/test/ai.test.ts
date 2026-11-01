import {
  ADMIN_AI_API,
  AI_API,
  AI_FAILURE_BUDGET,
  type AiSettings,
  FACE_CONSENT_VERSION,
  MAX_PEOPLE,
} from '@zephyr/shared';
import { Unzlib, zlibSync } from 'fflate';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import migration from '../../../supabase/migrations/20261103100000_ai.sql?raw';
import { bgWorstCase, handleAiBatch, processBgItem, processScene } from '../src/ai/consumer';
import { runAiCron } from '../src/ai/cron';
import {
  encodeMask,
  encodePng,
  INFLATE_SLICE,
  MaskError,
  readMask,
  resizeMask,
  sameAspect,
} from '../src/ai/png';
import { falCutout, ProviderFailure, runwareCutout } from '../src/ai/providers';
import { clearAiSettingsCache } from '../src/ai/settings';
import type { AiMessage } from '../src/env';
import { embeddingLiteral } from '../src/routes/ai';
import {
  accessToken,
  aiLimiter,
  aiQueue,
  aiReadLimiter,
  type Call,
  call,
  credential,
  env,
  facesLimiter,
  initKeys,
  installFetch,
  type Jar,
  jar,
  LANDING,
  must,
  r2,
  read,
  resetWorld,
  sbToken,
  type User,
  workersAi,
  world,
} from './helpers';

const MEI: User = { id: '20000000-0000-0000-0000-000000000001', email: 'mei@example.com', passkeys: 1 };
const PHOTO = '30000000-0000-4000-8000-000000000001';
const ITEM = '40000000-0000-4000-8000-000000000001';
const JOB = '50000000-0000-4000-8000-000000000001';
const GW = 'https://gateway.ai.cloudflare.com/v1/acct123/zephyr-test';

const SETTINGS: AiSettings = {
  enabled: true,
  cloudPaused: false,
  features: {
    auto_enhance: true,
    hdr: true,
    color_match: true,
    cleanup: true,
    face_grouping: true,
    scene_tags: true,
    bg_removal: true,
  },
  bgProvider: 'runware',
  bgFallback: 'fal_bria',
  runwareModel: 'runware:112@5',
  falModel: 'fal-ai/bria/background/remove',
  sceneModel: '@cf/microsoft/resnet-50',
  bgCreditsPerPhoto: 1,
  costs: { runwareMicros: 600, falMicros: 18000, sceneMicros: 20 },
  caps: { total: 10, bgRemoval: 8, sceneTags: 2, perUser: 0.5 },
  alerts: [50, 80, 100],
  atCap: 'pause',
  alertTo: 'owners_finance',
  memberJobsPerMinute: 60,
  updatedAt: '2026-11-01T00:00:00Z',
  updatedBy: null,
};

beforeAll(initKeys);
beforeEach(() => {
  resetWorld();
  installFetch();
  clearAiSettingsCache();
  world.rpc.ai_settings_get = () => SETTINGS;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- fixtures -----------------------------------------------------------------------------------------
const rpcCalls = (fn: string) => world.calls.filter((c) => c.url.endsWith(`/rpc/${fn}`));
const rpcArgs = (fn: string) => rpcCalls(fn).map((c) => c.body as Record<string, unknown>);
function jpeg(w: number, h: number, size = 600): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0], 0);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03], 20);
  return b;
}
/** An RGBA cut-out: a filled rectangle in the middle, transparent around it. */
function cutoutPng(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const inside = x >= w / 4 && x < (3 * w) / 4 && y >= h / 4 && y < (3 * h) / 4;
      px.set([200, 10, 10, inside ? 255 : 0], (y * w + x) * 4);
    }
  return encodePng(w, h, 6, px);
}
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function storePreview(w = 40, h = 30) {
  await r2.put(`u/${MEI.id}/p/${PHOTO}/preview`, jpeg(w, h), { httpMetadata: { contentType: 'image/jpeg' } });
}
async function signedIn(u: User): Promise<Jar> {
  const j = jar();
  j.cookies.set('__Host-zs-at', await sbToken({ sub: u.id, email: u.email }));
  return j;
}
type Provider = (c: Call) => Response | undefined;
const runwareOk: Provider = (c) =>
  c.url === `${GW}/custom-runware/v1`
    ? json({
        data: [{ taskType: 'imageBackgroundRemoval', imageBase64Data: b64(cutoutPng(40, 30)), cost: 0.0006 }],
      })
    : undefined;
const falOk: Provider = (c) =>
  c.url === `${GW}/fal/fal-ai/bria/background/remove`
    ? json({ image: { url: `data:image/png;base64,${b64(cutoutPng(20, 15))}` } })
    : undefined;
const down: Provider = (c) => (c.url.startsWith(GW) ? json({ error: 'x' }, 500) : undefined);

// ---- PNG ----------------------------------------------------------------------------------------------
describe('mask PNG reader', () => {
  it('keeps the alpha of RGBA, grey+alpha, and the grey of greyscale', () => {
    const rgba = readMask(cutoutPng(8, 4), 1e6);
    expect(rgba.width).toBe(8);
    expect([...rgba.data.slice(8, 16)]).toEqual([0, 0, 255, 255, 255, 255, 0, 0]);
    const ga = readMask(encodePng(2, 1, 4, new Uint8Array([9, 100, 9, 200])), 1e6);
    expect([...ga.data]).toEqual([100, 200]);
    const g = readMask(encodePng(3, 1, 0, new Uint8Array([1, 2, 3])), 1e6);
    expect([...g.data]).toEqual([1, 2, 3]);
  });

  it('round-trips its own greyscale encoding (Up filter)', () => {
    const m = { width: 5, height: 3, data: new Uint8Array(15).map((_, i) => (i * 37) % 256) };
    expect([...readMask(encodeMask(m), 1e6).data]).toEqual([...m.data]);
  });

  it('refuses other formats, oversize input and huge dimensions', () => {
    const rgb = encodePng(2, 2, 0, new Uint8Array(4));
    rgb[25] = 2; // colour type RGB
    expect(() => readMask(rgb, 1e6)).toThrowError(MaskError);
    expect(() => readMask(cutoutPng(8, 8), 10)).toThrow(/too_large/);
    const big = encodePng(1, 1, 0, new Uint8Array(1));
    new DataView(big.buffer).setUint32(16, 5000); // width 5000
    expect(() => readMask(big, 1e6)).toThrow(/size/);
    expect(() => readMask(new TextEncoder().encode('<svg></svg>'.repeat(5)), 1e6)).toThrow(/not_png/);
  });

  it('stops a decompression bomb before it fills memory', () => {
    // IHDR says 4×4 grey; the IDAT inflates to 1 MB.
    const small = encodePng(4, 4, 0, new Uint8Array(16));
    const idat = zlibSync(new Uint8Array(1024 * 1024));
    const head = small.subarray(0, 33);
    const chunk = new Uint8Array(12 + idat.length);
    new DataView(chunk.buffer).setUint32(0, idat.length);
    chunk.set([0x49, 0x44, 0x41, 0x54], 4);
    chunk.set(idat, 8);
    const end = small.subarray(small.length - 12);
    const bomb = new Uint8Array([...head, ...chunk, ...end]);
    expect(() => readMask(bomb, 1e7)).toThrow(/bomb/);
  });

  it('bounds the decoded size by the preview, checked before inflating', () => {
    const bounds = { width: 40, height: 30, aspectTolerance: 0.02 };
    expect(readMask(cutoutPng(40, 30), 1e6, bounds).width).toBe(40);
    expect(readMask(cutoutPng(20, 15), 1e6, bounds).width).toBe(20);
    expect(() => readMask(cutoutPng(80, 60), 1e6, bounds)).toThrow(/size/);
    expect(() => readMask(cutoutPng(30, 30), 1e6, bounds)).toThrow(/aspect/);
  });

  it('inflates in small slices, so a real bomb is stopped after a few MB', () => {
    // A raw zlib stream with one fixed-Huffman block: a literal 0, then length-258/distance-1 copies. 1 MB of
    // it inflates to ~160 MB; IHDR claims 1024×1024 grey (≈1 MB). fflate inflates a whole push before its
    // callback runs, so pushing this in one piece would build the 160 MB buffer first.
    const bits: number[] = [];
    const put = (v: number, n: number) => {
      for (let i = 0; i < n; i++) bits.push((v >> i) & 1);
    };
    const code = (v: number, n: number) => {
      for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1);
    };
    put(1, 1); // BFINAL
    put(1, 2); // fixed Huffman
    code(0x30, 8); // literal 0
    const pairs = Math.floor((1024 * 1024 * 8) / 13);
    for (let k = 0; k < pairs; k++) {
      code(0b11000101, 8); // length 258 (symbol 285)
      code(0, 5); // distance 1
    }
    code(0, 7); // end of block
    const body = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i++)
      if (bits[i]) body[i >> 3] = (body[i >> 3] as number) | (1 << (i & 7));
    const idat = new Uint8Array([0x78, 0x01, ...body, 0, 0, 0, 1]);
    const small = encodePng(1024, 1024, 0, new Uint8Array(1024 * 1024));
    const head = small.subarray(0, 33);
    const chunkBytes = new Uint8Array(12 + idat.length);
    new DataView(chunkBytes.buffer).setUint32(0, idat.length);
    chunkBytes.set([0x49, 0x44, 0x41, 0x54], 4);
    chunkBytes.set(idat, 8);
    const bomb = new Uint8Array([...head, ...chunkBytes, ...small.subarray(small.length - 12)]);
    const push = vi.spyOn(Unzlib.prototype, 'push');
    const t0 = performance.now();
    expect(() => readMask(bomb, 8 * 1024 * 1024)).toThrow(/bomb/);
    expect(performance.now() - t0).toBeLessThan(2000);
    const sizes = push.mock.calls.map(([chunk]) => (chunk as Uint8Array).byteLength);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(INFLATE_SLICE);
    // ~1 MB of output allowed, ~630 KB per slice at most: it stops within a few slices.
    expect(sizes.length).toBeLessThan(10);
  });

  it('checks aspect and resizes', () => {
    expect(sameAspect({ width: 40, height: 30 }, { width: 80, height: 60 }, 0.02)).toBe(true);
    expect(sameAspect({ width: 40, height: 40 }, { width: 80, height: 60 }, 0.02)).toBe(false);
    const r = resizeMask({ width: 2, height: 1, data: new Uint8Array([0, 255]) }, 4, 2);
    expect(r.data.length).toBe(8);
    expect(r.data[0]).toBe(0);
    expect(r.data[3]).toBe(255);
  });
});

// ---- providers ----------------------------------------------------------------------------------------
describe('providers', () => {
  it('calls Runware through the gateway with the inline preview and reads the cost', async () => {
    world.external = runwareOk;
    const r = await runwareCutout(env, SETTINGS, jpeg(40, 30), 'image/jpeg');
    expect(r.costMicros).toBe(600);
    const c = must(world.calls.find((x) => x.url.startsWith(GW)));
    expect(c.url).toBe(`${GW}/custom-runware/v1`);
    expect(c.headers.get('Authorization')).toBe('Bearer runware-key');
    expect(c.headers.get('cf-aig-authorization')).toBe('Bearer gateway-token');
    const [task] = c.body as Record<string, unknown>[];
    expect(task).toMatchObject({
      taskType: 'removeBackground',
      model: 'runware:112@5',
      outputType: 'base64Data',
      outputFormat: 'PNG',
      includeCost: true,
    });
    expect(String((must(task).inputs as { image: string }).image)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('calls fal through the gateway with storage off, and accepts only an inline result', async () => {
    world.external = falOk;
    const r = await falCutout(env, SETTINGS, jpeg(40, 30), 'image/jpeg');
    expect(r.png.byteLength).toBeGreaterThan(0);
    const c = must(world.calls.find((x) => x.url.startsWith(GW)));
    expect(c.headers.get('Authorization')).toBe('Key fal-key');
    expect(c.headers.get('X-Fal-Store-IO')).toBe('0');
    expect(c.body).toMatchObject({ sync_mode: true });
    world.external = (x) =>
      x.url.startsWith(GW) ? json({ image: { url: 'https://v3.fal.media/files/x.png' } }) : undefined;
    await expect(falCutout(env, SETTINGS, jpeg(40, 30), 'image/jpeg')).rejects.toMatchObject({
      reason: 'bad_output',
    });
  });

  it('never calls a provider directly in production, and refuses odd model ids', async () => {
    const prod = { ...env, ENVIRONMENT: 'production', AI_GATEWAY_ID: undefined };
    await expect(runwareCutout(prod, SETTINGS, jpeg(4, 3), 'image/jpeg')).rejects.toMatchObject({
      code: 'no_gateway',
    });
    await expect(
      falCutout(env, { falModel: 'fal-ai/../../evil' }, jpeg(4, 3), 'image/jpeg'),
    ).rejects.toBeInstanceOf(ProviderFailure);
    world.external = (c) =>
      c.url === 'https://api.runware.ai/v1' ? runwareOk({ ...c, url: `${GW}/custom-runware/v1` }) : undefined;
    const dev = { ...env, AI_GATEWAY_ID: undefined };
    expect((await runwareCutout(dev, SETTINGS, jpeg(40, 30), 'image/jpeg')).png.byteLength).toBeGreaterThan(
      0,
    );
  });
});

// ---- consumer -----------------------------------------------------------------------------------------
describe('background-removal consumer', () => {
  const go = () => ({ status: 'go', ownerId: MEI.id, photoId: PHOTO, attempts: 1, alerts: [] });
  beforeEach(() => {
    world.rpc.ai_item_begin = go;
    world.rpc.ai_item_complete = () => ({
      status: 'ok',
      version: 3,
      deleteKeys: [`u/${MEI.id}/p/${PHOTO}/m/old.png`],
    });
    world.rpc.ai_item_failed = () => ({ status: 'failed' });
    world.rpc.ai_alert_recipients = () => ['owner@zephyr.test'];
  });

  it('stores a greyscale mask at the preview size and attaches it', async () => {
    await storePreview(40, 30);
    await r2.put(`u/${MEI.id}/p/${PHOTO}/m/old.png`, new Uint8Array(3));
    world.external = runwareOk;
    expect(await processBgItem(env, ITEM)).toBe('completed');
    const [args] = rpcArgs('ai_item_complete');
    const key = String(args?.p_key);
    expect(key).toMatch(new RegExp(`^u/${MEI.id}/p/${PHOTO}/m/[0-9a-f-]{36}\\.png$`));
    expect(args).toMatchObject({
      p_item: ITEM,
      p_provider: 'runware',
      p_width: 40,
      p_height: 30,
      p_cost: 600,
    });
    const stored = must(await r2.get(key));
    const mask = readMask(new Uint8Array(await (stored as unknown as R2ObjectBody).arrayBuffer()), 1e6);
    expect(mask.width).toBe(40);
    expect(mask.data[0]).toBe(0);
    expect(mask.data[15 * 40 + 20]).toBe(255);
    expect(await r2.get(`u/${MEI.id}/p/${PHOTO}/m/old.png`)).toBeNull();
    // The provider saw the preview, never the original.
    expect(world.calls.some((c) => c.url.includes('/original'))).toBe(false);
  });

  it('reserves the worst case of an item before the first call', async () => {
    await storePreview(40, 30);
    world.external = runwareOk;
    await processBgItem(env, ITEM);
    expect(bgWorstCase(SETTINGS)).toBe(2 * 600 + 18000);
    expect(rpcArgs('ai_item_begin')[0]?.p_estimate).toBe(19200);
    expect(bgWorstCase({ ...SETTINGS, bgFallback: 'none' })).toBe(1200);
  });

  it('never asks a provider again after rejecting its output', async () => {
    await storePreview(40, 30);
    let runware = 0;
    world.external = (c) => {
      if (c.url.endsWith('/custom-runware/v1')) {
        runware += 1;
        return json({ data: [{ imageBase64Data: b64(cutoutPng(30, 30)) }] });
      }
      return falOk(c);
    };
    expect(await processBgItem(env, ITEM)).toBe('completed');
    expect(runware).toBe(1);
    expect(rpcArgs('ai_item_complete')[0]?.p_provider).toBe('fal_bria');
  });

  it('keeps the stored mask when recording it fails (the sweep removes it if no row does)', async () => {
    await storePreview(40, 30);
    world.external = runwareOk;
    world.rpc.ai_item_complete = () => new Response('down', { status: 503 });
    await expect(processBgItem(env, ITEM)).rejects.toBeTruthy();
    expect([...r2.objects.keys()].some((k) => k.startsWith(`u/${MEI.id}/p/${PHOTO}/m/`))).toBe(true);
  });

  it('tries the primary twice, then the fallback', async () => {
    await storePreview(40, 30);
    let runware = 0;
    world.external = (c) => {
      if (c.url.endsWith('/custom-runware/v1')) {
        runware += 1;
        return json({}, 503);
      }
      return falOk(c);
    };
    expect(await processBgItem(env, ITEM)).toBe('completed');
    expect(runware).toBe(2);
    const [args] = rpcArgs('ai_item_complete');
    expect(args?.p_provider).toBe('fal_bria');
    expect((must(args).p_calls as { ok: boolean; role: string }[]).map((c) => [c.role, c.ok])).toEqual([
      ['primary', false],
      ['primary', false],
      ['fallback', true],
    ]);
  });

  it('fails (and the database refunds) when every provider fails', async () => {
    await storePreview();
    world.external = down;
    expect(await processBgItem(env, ITEM)).toBe('failed');
    expect(rpcArgs('ai_item_failed')[0]).toMatchObject({ p_item: ITEM, p_error: 'provider_error' });
    expect(rpcCalls('ai_item_complete')).toHaveLength(0);
  });

  it('treats a mask of the wrong shape as bad output', async () => {
    await storePreview(40, 30);
    world.external = (c) =>
      c.url.startsWith(GW)
        ? json({
            data: [{ imageBase64Data: b64(cutoutPng(30, 30)) }],
            image: { url: `data:image/png;base64,${b64(cutoutPng(30, 30))}` },
          })
        : undefined;
    expect(await processBgItem(env, ITEM)).toBe('failed');
    expect(rpcArgs('ai_item_failed')[0]).toMatchObject({ p_error: 'bad_output' });
  });

  it('waits at a cap or an admin pause without calling a provider, and emails new alerts', async () => {
    world.rpc.ai_item_begin = () => ({
      status: 'wait',
      until: '2026-11-02T00:00:00Z',
      alerts: [{ scope: 'total', threshold: 100, usedUsd: 10, capUsd: 10 }],
    });
    world.external = () => {
      throw new Error('no provider call expected');
    };
    expect(await processBgItem(env, ITEM)).toBe('waiting');
    expect(world.emails).toHaveLength(1);
    expect(world.emails[0]?.subject).toMatch(/100%/);
    world.rpc.ai_item_begin = () => ({ status: 'wait', until: '2026-11-01T01:00:00Z', alerts: [] });
    expect(await processBgItem(env, ITEM)).toBe('waiting');
    expect(world.calls.some((c) => c.url.startsWith(GW))).toBe(false);
  });

  it('skips a deleted photo (the database already failed and refunded it)', async () => {
    world.rpc.ai_item_begin = () => ({ status: 'failed' });
    expect(await processBgItem(env, ITEM)).toBe('failed');
    expect(world.calls.some((c) => c.url.startsWith(GW))).toBe(false);
  });

  it('retries the message when the database is down', async () => {
    world.rpc.ai_item_begin = () => new Response('down', { status: 503 });
    const msg = { body: { t: 'bg', item: ITEM }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await handleAiBatch({ messages: [msg] } as unknown as MessageBatch<AiMessage>, env);
    expect(msg.retry).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
  });
});

describe('scene tags consumer', () => {
  it('maps classifier labels to scenes through the gateway', async () => {
    world.rpc.ai_scene_begin = () => ({ status: 'go', alerts: [] });
    world.rpc.ai_scene_done = () => ({ status: 'ok' });
    await r2.put(`u/${MEI.id}/p/${PHOTO}/thumb`, jpeg(16, 12));
    workersAi.result = [
      { label: 'SEASHORE', score: 0.6 },
      { label: 'sandbar', score: 0.2 },
      { label: 'PIZZA', score: 0.05 },
    ];
    expect(await processScene(env, PHOTO, MEI.id)).toBe('done');
    expect(workersAi.calls[0]).toMatchObject({
      model: '@cf/microsoft/resnet-50',
      options: { gateway: { id: 'zephyr-test' } },
    });
    const [args] = rpcArgs('ai_scene_done');
    expect(args?.p_scenes).toEqual([expect.objectContaining({ scene: 'beach' })]);
  });

  it('settles on the day the reservation was made', async () => {
    world.rpc.ai_scene_begin = () => ({ status: 'go', day: '2026-10-31', alerts: [] });
    world.rpc.ai_scene_done = () => ({ status: 'ok' });
    await r2.put(`u/${MEI.id}/p/${PHOTO}/thumb`, jpeg(16, 12));
    workersAi.result = [{ label: 'SEASHORE', score: 0.6 }];
    await processScene(env, PHOTO, MEI.id);
    expect(rpcArgs('ai_scene_done')[0]?.p_day).toBe('2026-10-31');
  });

  it('settles and retries later when the run breaks after the reservation', async () => {
    world.rpc.ai_scene_begin = () => ({ status: 'go', day: '2026-11-01', alerts: [] });
    world.rpc.ai_scene_done = () => ({ status: 'retry' });
    vi.spyOn(env.PHOTOS, 'get').mockRejectedValueOnce(new Error('r2 down'));
    await expect(processScene(env, PHOTO, MEI.id)).rejects.toThrow('r2 down');
    expect(rpcArgs('ai_scene_done')[0]).toMatchObject({
      p_scenes: 'retry',
      p_reserved: 20,
      p_day: '2026-11-01',
    });
  });

  it('records a failure when Workers AI fails', async () => {
    world.rpc.ai_scene_begin = () => ({ status: 'go', alerts: [] });
    world.rpc.ai_scene_done = () => ({ status: 'failed' });
    await r2.put(`u/${MEI.id}/p/${PHOTO}/thumb`, jpeg(16, 12));
    workersAi.fail = true;
    expect(await processScene(env, PHOTO, MEI.id)).toBe('failed');
    expect(rpcArgs('ai_scene_done')[0]?.p_scenes).toBeNull();
  });
});

describe('cron', () => {
  it('re-enqueues due items, backfills scenes and sends face-data notices', async () => {
    world.rpc.ai_due_items = () => [ITEM];
    world.rpc.ai_scene_backfill = () => [{ photo: PHOTO, owner: MEI.id }];
    world.rpc.ai_face_lapses = () => [
      { ownerId: MEI.id, email: 'mei@example.com', kind: 'stopped', deleteOn: '2026-12-01' },
    ];
    world.rpc.ai_prune = () => ({ calls: 0, jobs: 0 });
    const counts = await runAiCron(env);
    expect(counts).toEqual({ itemsEnqueued: 1, scenesEnqueued: 1, faceNotices: 1 });
    expect(aiQueue.sent).toEqual([
      { t: 'bg', item: ITEM },
      { t: 'scene', photo: PHOTO, owner: MEI.id },
    ]);
    expect(world.emails[0]?.subject).toMatch(/Face grouping has stopped/);
    expect(world.emails[0]?.text).toContain('2026-12-01');
  });
});

// ---- member routes ------------------------------------------------------------------------------------
describe('member AI routes', () => {
  it('refuses a background-removal job without enough credits (402)', async () => {
    const j = await signedIn(MEI);
    world.rpc.ai_bg_job_create = () => ({ error: 'insufficient_credits', needed: 12, balance: 3 });
    const res = await call(AI_API.jobs, { jar: j, body: { kind: 'bg_removal', photoIds: [PHOTO] } });
    expect(res.status).toBe(402);
    expect(await read(res)).toEqual({ ok: false, error: 'insufficient_credits', needed: 12, balance: 3 });
    expect(aiQueue.sent).toHaveLength(0);
  });

  it('creates a job with the default cut-out and enqueues its items', async () => {
    const j = await signedIn(MEI);
    const job = { id: JOB, kind: 'bg_removal' };
    world.rpc.ai_bg_job_create = () => ({ job, items: [ITEM], skipped: [] });
    world.rpc.ai_items_enqueued = () => null;
    const res = await call(AI_API.jobs, {
      jar: j,
      body: {
        kind: 'bg_removal',
        photoIds: [PHOTO.toUpperCase()],
        apply: { bg: 'transparent', shadow: 'soft', shadowStrength: 40 },
      },
      headers: { 'X-Zephyr-Expected-User': MEI.id },
    });
    expect(res.status).toBe(201);
    expect(rpcArgs('ai_bg_job_create')[0]).toMatchObject({
      p_owner: MEI.id,
      p_photo_ids: [PHOTO],
      p_apply: { bg: 'transparent' },
    });
    expect(rpcArgs('ai_bg_job_create')[0]?.p_apply).toEqual({ bg: 'transparent' });
    expect(aiQueue.sent).toEqual([{ t: 'bg', item: ITEM }]);
    expect(aiLimiter.keys).toEqual([`ai:${MEI.id}`]);
  });

  it('refuses writes for a different expected member (shared device)', async () => {
    const j = await signedIn(MEI);
    const res = await call(AI_API.jobs, {
      jar: j,
      body: { kind: 'bg_removal', photoIds: [PHOTO] },
      headers: { 'X-Zephyr-Expected-User': '20000000-0000-0000-0000-000000000099' },
    });
    expect(res.status).toBe(409);
    expect(rpcCalls('ai_bg_job_create')).toHaveLength(0);
  });

  it('answers 409 with the holder when another device holds a device job', async () => {
    const j = await signedIn(MEI);
    world.rpc.ai_device_claim = () => ({ error: 'held', holder: 'Safari on iPad' });
    const res = await call(AI_API.jobClaim(JOB), { jar: j, body: { device: 'Chrome on Mac' } });
    expect(res.status).toBe(409);
    expect(await read(res)).toMatchObject({ error: 'conflict', holder: 'Safari on iPad' });
    const tag = rpcArgs('ai_device_claim')[0]?.p_session;
    expect(String(tag)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('passes the tab runner token on claims and progress, and refuses a malformed one', async () => {
    const j = await signedIn(MEI);
    const runner = 'AbCdEfGhIjKlMnOpQrStUv';
    world.rpc.ai_device_claim = () => ({ error: 'held', holder: 'Chrome on Mac' });
    await call(AI_API.jobClaim(JOB), { jar: j, body: { device: 'Chrome on Mac', runner } });
    expect(rpcArgs('ai_device_claim')[0]?.p_runner).toBe(runner);
    world.rpc.ai_device_progress = () => ({ error: 'lost' });
    const lost = await call(AI_API.jobProgress(JOB), { jar: j, body: { done: [], runner } });
    expect(lost.status).toBe(409);
    expect(rpcArgs('ai_device_progress')[0]?.p_runner).toBe(runner);
    const bad = await call(AI_API.jobClaim(JOB), {
      jar: j,
      body: { device: 'Chrome on Mac', runner: 'short' },
    });
    expect(bad.status).toBe(400);
  });

  it('normalises face codes and drops unusable ones', async () => {
    const j = await signedIn(MEI);
    world.rpc.ai_faces_add = () => ({ saved: 1 });
    const good = new Float32Array(128).fill(0);
    good[0] = 3;
    good[1] = 4;
    const zero = new Float32Array(128);
    const enc = (f: Float32Array) => Buffer.from(f.buffer).toString('base64');
    const res = await call(AI_API.faces, {
      jar: j,
      body: {
        v: 1,
        photos: [
          {
            id: PHOTO,
            faces: [
              { box: [0.1, 0.1, 0.2, 0.2], score: 0.9, embedding: enc(good) },
              { box: [0.5, 0.5, 0.1, 0.1], score: 0.95, embedding: enc(zero) },
            ],
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const items = rpcArgs('ai_faces_add')[0]?.p_items as { faces: { embedding: string }[] }[];
    expect(items[0]?.faces).toHaveLength(1);
    expect(items[0]?.faces[0]?.embedding.startsWith('[0.6000000,0.8000000,0.000000')).toBe(true);
    expect(embeddingLiteral('AAAA')).toBeNull();
  });

  it('serves a mask to its owner only, revalidated on every use', async () => {
    const j = await signedIn(MEI);
    const mask = '60000000-0000-4000-8000-000000000001';
    const key = `u/${MEI.id}/p/${PHOTO}/m/${mask}.png`;
    await r2.put(key, encodeMask({ width: 2, height: 2, data: new Uint8Array(4) }));
    world.rpc.ai_mask_key = (a) => (a.p_owner === MEI.id && a.p_mask === mask ? key : null);
    const res = await call(AI_API.mask(PHOTO, mask), { jar: j });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
    const etag = must(res.headers.get('ETag'));
    expect(etag).toBe(`"m-${mask}"`);
    const again = await call(AI_API.mask(PHOTO, mask), { jar: j, headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    // The ownership check comes first: a cached ETag never answers for a mask the member can't read.
    world.rpc.ai_mask_key = () => null;
    expect(
      (await call(AI_API.mask(PHOTO, mask), { jar: j, headers: { 'If-None-Match': etag } })).status,
    ).toBe(404);
    expect((await call(AI_API.mask(PHOTO, '60000000-0000-4000-8000-000000000002'), { jar: j })).status).toBe(
      404,
    );
  });

  it('limits face batches and reads separately, and answers busy with a short retry', async () => {
    const j = await signedIn(MEI);
    const enc = Buffer.from(new Float32Array(128).fill(0.1).buffer).toString('base64');
    const body = {
      v: 1,
      photos: [{ id: PHOTO, faces: [{ box: [0.1, 0.1, 0.2, 0.2], score: 0.9, embedding: enc }] }],
    };
    world.rpc.ai_faces_add = () => ({ error: 'busy' });
    const busy = await call(AI_API.faces, { jar: j, body });
    expect(busy.status).toBe(429);
    expect(busy.headers.get('Retry-After')).toBe('5');
    facesLimiter.ok = false;
    expect((await call(AI_API.faces, { jar: j, body })).status).toBe(429);
    expect(facesLimiter.keys).toContain(`faces:${MEI.id}`);
    world.rpc.ai_cleanup_ignore = () => 1;
    expect(
      (await call(AI_API.cleanupIgnore, { jar: j, body: { kind: 'blurry', photoIds: [PHOTO] } })).status,
    ).toBe(200);
    world.rpc.ai_status = () => ({ enabled: true });
    expect((await call(AI_API.status, { jar: j })).status).toBe(200);
    aiReadLimiter.ok = false;
    expect((await call(AI_API.status, { jar: j })).status).toBe(429);
  });

  it('accepts consent only to the current wording', async () => {
    const j = await signedIn(MEI);
    world.rpc.ai_member_settings_update = () => ({ enabled: true });
    const res = await call(AI_API.settings, {
      jar: j,
      method: 'PATCH',
      body: { faceGrouping: true, faceConsent: { version: 2, rightsConfirmed: true } },
    });
    expect(res.status).toBe(400);
    expect(rpcCalls('ai_member_settings_update')).toHaveLength(0);
  });

  it('maps plan and switch refusals', async () => {
    const j = await signedIn(MEI);
    world.rpc.ai_cleanup_page = () => ({ error: 'plan' });
    expect((await call(AI_API.cleanup, { jar: j })).status).toBe(403);
    world.rpc.ai_member_settings_update = () => ({ error: 'consent' });
    expect(
      (
        await call(AI_API.settings, {
          jar: j,
          method: 'PATCH',
          body: { faceGrouping: true, faceConsent: { version: 1, rightsConfirmed: true } },
        })
      ).status,
    ).toBe(400);
    // Consent is required by the schema before the database is asked.
    expect(
      (await call(AI_API.settings, { jar: j, method: 'PATCH', body: { faceGrouping: true } })).status,
    ).toBe(400);
  });
});

// ---- admin --------------------------------------------------------------------------------------------
describe('admin Zephyr AI', () => {
  const owner = () => must(world.users.find((u) => u.email === 'owner@zephyr.test'));
  async function staffSession(o: { authAgo?: number } = {}): Promise<{ j: Jar; access: string }> {
    const access = await accessToken('owner@zephyr.test');
    world.passkeyUser = owner();
    const j = jar();
    const res = await call('/admin/api/v1/auth/passkey/verify', {
      body: { challengeId: 'ch-auth', credential: credential('webauthn.get', LANDING) },
      jar: j,
      access,
    });
    expect(res.status).toBe(200);
    if (o.authAgo) {
      j.cookies.set(
        '__Host-za-at',
        await sbToken({ sub: owner().id, email: owner().email, amr: ['passkey'], authAgo: o.authAgo }),
      );
    }
    return { j, access };
  }
  const spend = {
    day: '2026-11-01',
    totalUsd: 1,
    bgRemovalUsd: 1,
    sceneTagsUsd: 0,
    capped: false,
    credits: 3,
    photos: 3,
  };
  beforeEach(() => {
    world.rpc.admin_ai_settings = () => ({ settings: SETTINGS, spend });
    world.rpc.admin_ai_settings_update = (a) => ({
      settings: { ...SETTINGS, ...(a.p_patch as object) },
      spend,
      before: SETTINGS,
      changes: Object.fromEntries(Object.keys(a.p_patch as object).map((k) => [k, {}])),
    });
    world.rpc.ai_alert_recipients = () => ['owner@zephyr.test'];
  });

  it('saves a risk-lowering change without a fresh passkey', async () => {
    const { j, access } = await staffSession({ authAgo: 3600 });
    const res = await call(ADMIN_AI_API.settings, {
      jar: j,
      access,
      method: 'PATCH',
      body: { caps: { total: 5 } },
    });
    expect(res.status).toBe(200);
    expect(world.emails).toHaveLength(0);
  });

  it('asks for the passkey again before a risk-raising change, then emails the Owners', async () => {
    const stale = await staffSession({ authAgo: 3600 });
    const res = await call(ADMIN_AI_API.settings, {
      jar: stale.j,
      access: stale.access,
      method: 'PATCH',
      body: { caps: { total: 50 } },
    });
    expect(res.status).toBe(403);
    expect(await read(res)).toMatchObject({ error: 'reauth_required' });
    expect(rpcCalls('admin_ai_settings_update')).toHaveLength(0);

    const fresh = await staffSession();
    const ok = await call(ADMIN_AI_API.settings, {
      jar: fresh.j,
      access: fresh.access,
      method: 'PATCH',
      body: { caps: { total: 50 } },
    });
    expect(ok.status).toBe(200);
    expect((await read(ok)).settings.caps.total).toBe(50);
    expect(world.emails.map((e) => e.subject)).toEqual(['[Zephyr AI] Settings changed']);
    expect(world.emails[0]?.text).toContain('daily caps');
    expect(world.emails[0]?.text).not.toContain('50');
  });

  it('rejects a fallback equal to the provider and unknown fields', async () => {
    const { j, access } = await staffSession();
    for (const body of [
      { bgProvider: 'fal_bria', bgFallback: 'fal_bria' },
      { secret: 1 },
      { runwareModel: 'https://evil' },
    ]) {
      expect((await call(ADMIN_AI_API.settings, { jar: j, access, method: 'PATCH', body })).status).toBe(400);
    }
  });

  it('lets any staff role read the jobs page', async () => {
    const { j, access } = await staffSession();
    world.rpc.admin_ai_jobs = () => ({
      counts: { pending: 1, processing: 0, completedToday: 2, failedToday: 0 },
      latency: null,
      providers: [],
      failures: [],
      spend,
    });
    const res = await call(ADMIN_AI_API.jobs, { jar: j, access });
    expect(res.status).toBe(200);
    expect(await read(res)).toMatchObject({ ok: true, latency: [], counts: { pending: 1 } });
  });
});

describe('AI constants match the migration', () => {
  it('failure budget, people cap and consent version', () => {
    expect(migration).toContain(
      `_ai_failure_budget() returns integer\nlanguage sql immutable set search_path = '' as $$ select ${AI_FAILURE_BUDGET} $$;`,
    );
    expect(migration).toContain(
      `_ai_people_max() returns integer\nlanguage sql immutable set search_path = '' as $$ select ${MAX_PEOPLE} $$;`,
    );
    expect(migration).toContain(
      `_ai_face_consent_version() returns integer\nlanguage sql immutable set search_path = '' as $$ select ${FACE_CONSENT_VERSION} $$;`,
    );
  });
});
