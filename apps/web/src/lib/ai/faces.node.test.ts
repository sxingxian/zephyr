// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { describe, expect, it } from 'vitest';
import { MODELS } from './faceModels';
import {
  alignFace,
  base64ToEmbedding,
  cosine,
  createFaceEngine,
  decodeYunet,
  embeddingToBase64,
  nms,
  type Rgba,
  similarity,
  TEMPLATE,
  YUNET_SIZE,
} from './facesCore';

const model = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../public/models/${name}`, import.meta.url))));

/**
 * A drawn face: skin oval, eyes, brows, nose, mouth. `look` changes the person (proportions and colours);
 * `at`/`size` place it in a w × h image. Returns the image and its five landmarks in pixels.
 */
function drawFace(w: number, h: number, at: [number, number], size: number, look: 0 | 1) {
  const data = new Uint8ClampedArray(w * h * 4);
  const bg = look ? [70, 90, 120] : [200, 205, 190];
  for (let i = 0; i < w * h; i++) data.set([...bg, 255], i * 4);
  const [cx, cy] = at;
  const skin: [number, number, number] = look ? [140, 95, 70] : [235, 190, 165];
  const eyeDx = look ? 0.24 : 0.17;
  const eyeY = look ? -0.12 : -0.05;
  const mouthW = look ? 0.12 : 0.22;
  const mouthY = look ? 0.3 : 0.24;
  const set = (x: number, y: number, c: number[]) => {
    if (x >= 0 && y >= 0 && x < w && y < h) data.set([...c, 255], (y * w + x) * 4);
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / (size * (look ? 0.5 : 0.42));
      const dy = (y - cy) / (size * 0.55);
      if (dx * dx + dy * dy <= 1) set(x, y, skin);
      const ex = Math.abs(x - cx) - eyeDx * size;
      const ey = y - (cy + eyeY * size);
      if (ex * ex + ey * ey * 3 <= (0.05 * size) ** 2) set(x, y, [30, 25, 20]);
      if (Math.abs(ex) < 0.08 * size && ey > -0.1 * size && ey < -0.07 * size)
        set(x, y, look ? [20, 15, 10] : [120, 80, 60]);
      if (Math.abs(x - cx) < 0.03 * size && y > cy && y < cy + 0.14 * size)
        set(x, y, [skin[0] - 40, skin[1] - 40, skin[2] - 40]);
      if (Math.abs(x - cx) < mouthW * size && Math.abs(y - (cy + mouthY * size)) < 0.025 * size)
        set(x, y, [150, 40, 50]);
      if (look && dy > 0.55 && dx * dx + dy * dy <= 1) set(x, y, [60, 40, 30]); // beard
    }
  const lm: [number, number][] = [
    [cx - eyeDx * size, cy + eyeY * size],
    [cx + eyeDx * size, cy + eyeY * size],
    [cx, cy + 0.12 * size],
    [cx - mouthW * 0.8 * size, cy + mouthY * size],
    [cx + mouthW * 0.8 * size, cy + mouthY * size],
  ];
  return { img: { width: w, height: h, data } as Rgba, lm };
}

describe('face models', () => {
  it('ship with the pinned hashes', () => {
    for (const m of Object.values(MODELS)) {
      const hash = createHash('sha256').update(model(m.file)).digest('hex');
      expect(hash).toBe(m.sha256);
    }
  });

  it('SFace int8 runs in onnxruntime-web, and the same face embeds closer than a different one', async () => {
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';
    const engine = await createFaceEngine(
      ort as unknown as Parameters<typeof createFaceEngine>[0],
      model(MODELS.yunet.file),
      model(MODELS.sface.file),
    );
    const a1 = drawFace(400, 300, [200, 150], 160, 0);
    const a2 = drawFace(500, 420, [230, 220], 200, 0); // same person, bigger, elsewhere
    const b = drawFace(400, 300, [200, 150], 160, 1);
    const toFace = (f: ReturnType<typeof drawFace>) => ({
      box: [0, 0, 1, 1] as [number, number, number, number],
      score: 1,
      landmarks: f.lm.map(([x, y]) => [x / f.img.width, y / f.img.height] as [number, number]),
    });
    const [ea1] = await engine.embed(a1.img, [toFace(a1)]);
    const [ea2] = await engine.embed(a2.img, [toFace(a2)]);
    const [eb] = await engine.embed(b.img, [toFace(b)]);
    if (!ea1 || !ea2 || !eb) throw new Error('no embeddings');
    expect(ea1.length).toBe(128);
    expect(Math.hypot(...ea1)).toBeCloseTo(1, 4);
    const same = cosine(ea1, ea2);
    const diff = cosine(ea1, eb);
    expect(same).toBeGreaterThan(diff + 0.05);
    // The base64 wire format round-trips exactly. 512 bytes are 684 characters with one '=' of padding.
    const b64 = embeddingToBase64(ea1);
    expect(b64).toMatch(/^[A-Za-z0-9+/]{683}=$/);
    expect(Array.from(base64ToEmbedding(b64))).toEqual(Array.from(ea1));
    // YuNet runs on the same image without error and returns sane detections, if any.
    const found = await engine.detect(a1.img, 0.5);
    for (const f of found) {
      expect(f.box.every((v) => v >= 0 && v <= 1)).toBe(true);
      expect(f.landmarks).toHaveLength(5);
    }
  }, 60_000);
});

describe('face maths', () => {
  it('fits the template exactly when the points are a rotated, scaled copy', () => {
    const ang = 0.3;
    const k = 2.5;
    const src = TEMPLATE.map(
      ([x, y]) =>
        [
          k * (Math.cos(ang) * x - Math.sin(ang) * y) + 40,
          k * (Math.sin(ang) * x + Math.cos(ang) * y) + 10,
        ] as [number, number],
    );
    const [c, s, tx, ty] = similarity(src, TEMPLATE);
    src.forEach(([x, y], i) => {
      const t = TEMPLATE[i] as [number, number];
      expect(c * x - s * y + tx).toBeCloseTo(t[0], 6);
      expect(s * x + c * y + ty).toBeCloseTo(t[1], 6);
    });
  });

  it('aligns into a 3 × 112 × 112 tensor with black outside the image', () => {
    const img: Rgba = { width: 10, height: 10, data: new Uint8ClampedArray(10 * 10 * 4).fill(200) };
    const t = alignFace(
      img,
      TEMPLATE.map(([x, y]) => [x / 10, y / 10] as [number, number]),
    );
    expect(t.length).toBe(3 * 112 * 112);
    expect(t.every(Number.isFinite)).toBe(true);
    expect(Math.max(...t)).toBeLessThanOrEqual(200);
    expect(t[50 * 112 + 50]).toBe(200); // the middle is inside
    expect(t[111 * 112 + 111]).toBe(0); // far corner maps outside
  });

  it('decodes YuNet outputs and suppresses overlaps', () => {
    const out: Record<string, { data: Float32Array }> = {};
    for (const s of [8, 16, 32]) {
      const n = (YUNET_SIZE / s) ** 2;
      out[`cls_${s}`] = { data: new Float32Array(n) };
      out[`obj_${s}`] = { data: new Float32Array(n) };
      out[`bbox_${s}`] = { data: new Float32Array(n * 4) };
      out[`kps_${s}`] = { data: new Float32Array(n * 10) };
    }
    // Two strong overlapping cells on stride 32 at (col 5, row 4), one weaker beside it.
    const cols = YUNET_SIZE / 32;
    const put = (i: number, score: number) => {
      (out.cls_32 as { data: Float32Array }).data[i] = score;
      (out.obj_32 as { data: Float32Array }).data[i] = score;
      (out.bbox_32 as { data: Float32Array }).data.set([0.5, 0.5, Math.log(3), Math.log(4)], i * 4);
    };
    put(4 * cols + 5, 0.95);
    put(4 * cols + 6, 0.9);
    const d = decodeYunet(out, 0.5, 0.8);
    expect(d).toHaveLength(2);
    expect(d[0]?.box[0]).toBeCloseTo((5.5 * 32 - 48) / 0.5, 4);
    expect(d[0]?.box[2]).toBeCloseTo(96 / 0.5, 4);
    expect(nms(d, 0.3)).toHaveLength(1);
  });
});
