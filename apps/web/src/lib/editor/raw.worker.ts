/// <reference lib="webworker" />
/**
 * RAW decoding with LibRaw (WebAssembly), off the main thread. LibRaw is LGPL-2.1; its binary is a separate
 * same-origin file (libraw.wasm) so it can be swapped, as the licence requires.
 *
 * Input:  { id, buf: ArrayBuffer, half: boolean }
 * Output: { id, ok: true, width, height, data: Uint16Array (linear RGBA half floats), baselineEv }
 *       | { id, ok: false, error }
 */
import { LibRaw } from '@colorhythm/libraw-wasm';
import wasmUrl from '@colorhythm/libraw-wasm/libraw.wasm?url';
import { largestEmbeddedJpeg, RAW_SCAN_BYTES } from '../uploads/raw';
import { fullDecodeFits, halfLut, isTiff, MAX_RAW_PIXELS, rawBaselineEv, srgb8ToLinear } from './rawCommon';

/** Linear luminances of the camera's embedded JPEG (downscaled), or null if there isn't a usable one. */
async function cameraLuma(buf: ArrayBuffer): Promise<number[] | null> {
  try {
    const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, RAW_SCAN_BYTES));
    const loc = largestEmbeddedJpeg(head);
    if (!loc || loc.end - loc.start < 8 * 1024) return null;
    const bmp = await createImageBitmap(new Blob([head.slice(loc.start, loc.end)], { type: 'image/jpeg' }), {
      resizeWidth: 256,
      resizeQuality: 'medium',
    });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    if (!g) return null;
    g.drawImage(bmp, 0, 0);
    bmp.close();
    const px = g.getImageData(0, 0, c.width, c.height).data;
    const out: number[] = [];
    for (let i = 0; i < px.length; i += 4)
      out.push(
        0.2126 * srgb8ToLinear(px[i] as number) +
          0.7152 * srgb8ToLinear(px[i + 1] as number) +
          0.0722 * srgb8ToLinear(px[i + 2] as number),
      );
    return out;
  } catch {
    return null;
  }
}

let ready: Promise<unknown> | null = null;
function init() {
  ready ??= LibRaw.initialize(
    fetch(wasmUrl, { credentials: 'same-origin' }).then((r) => {
      if (!r.ok) throw new Error('decoder unavailable');
      return r.arrayBuffer();
    }),
  );
  return ready;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = async (e: MessageEvent<{ id: number; buf: ArrayBuffer; half: boolean }>) => {
  const { id, buf, half } = e.data;
  let d: LibRaw | null = null;
  try {
    if (!isTiff(new Uint8Array(buf, 0, Math.min(16, buf.byteLength)))) throw new Error('not a RAW file');
    const jpegLuma = await cameraLuma(buf);
    await init();
    d = new LibRaw();
    await d.waitUntilReady();
    d.open(buf);
    const rw = d.getRawWidth();
    const rh = d.getRawHeight();
    if (rw * rh > MAX_RAW_PIXELS) throw new Error('too large');
    if (!half && !fullDecodeFits(rw, rh, buf.byteLength)) throw new Error('memory');
    d.setUseCameraWb(1);
    d.setOutputColor(1); // sRGB primaries
    d.setOutputBps(16);
    d.setGamma(0, 1);
    d.setGamma(1, 1); // linear
    d.setNoAutoBright(1);
    d.setHighlight(0);
    d.setHalfSize(half ? 1 : 0);
    d.setDemosaic(half ? 0 : 3); // AHD for full size
    d.unpack();
    d.dcrawProcess();
    const img = d.dcrawMakeMemImage();
    if (img.bits !== 16 || img.colors !== 3) throw new Error('unexpected decoder output');
    const { width, height } = img;
    const src = new Uint16Array(img.data.buffer, img.data.byteOffset, width * height * 3);
    const lut = halfLut();
    const out = new Uint16Array(width * height * 4);
    const ONE = 0x3c00;
    // Luminance over a sparse grid (about 40 000 samples), for the RAW baseline exposure.
    const rawLuma: number[] = [];
    const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 40_000)));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const r = src[i * 3] as number;
        const g = src[i * 3 + 1] as number;
        const b = src[i * 3 + 2] as number;
        out[i * 4] = lut[r] as number;
        out[i * 4 + 1] = lut[g] as number;
        out[i * 4 + 2] = lut[b] as number;
        out[i * 4 + 3] = ONE;
        if (y % stride === 0 && x % stride === 0)
          rawLuma.push((0.2126 * r + 0.7152 * g + 0.0722 * b) / 65535);
      }
    }
    const baselineEv = rawBaselineEv(rawLuma, jpegLuma);
    ctx.postMessage({ id, ok: true, width, height, data: out, baselineEv }, [out.buffer]);
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : 'decode failed' });
  } finally {
    try {
      d?.dispose();
    } catch {
      // ignore
    }
  }
};
