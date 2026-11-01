/// <reference lib="webworker" />
import { computeSignals } from './signalsCore';

/** Decodes a thumbnail (untouched, ≤ 512 px) and measures its quality signals. */
self.onmessage = async (e: MessageEvent<{ n: number; id: string; blob: Blob; takenAt: string | null }>) => {
  const { n, id, blob, takenAt } = e.data;
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const w = Math.min(512, bmp.width);
    const h = Math.max(1, Math.round((bmp.height * w) / bmp.width));
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('canvas');
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const img = ctx.getImageData(0, 0, w, h);
    (self as unknown as Worker).postMessage({ n, signals: computeSignals(id, img, takenAt) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ n, error: String((err as Error)?.message ?? err) });
  }
};
