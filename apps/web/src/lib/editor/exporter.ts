import type { EditRecipe, PhotoItem } from '@zephyr/shared/client';
import { getEdit } from '../edits';
import { withRenderer } from './background';
import { encodeJpeg } from './encode';
import { fitLongEdge, outputSize } from './geometry';
import { exportName, uniqueNames } from './names';
import { loadOriginal, releaseSource } from './sources';

export { exportName };

/** Export size: the crop at full resolution, or scaled to a long edge. Capped at 64 MP. */
export type ExportSize = { kind: 'full' } | { kind: 'long'; edge: number };
export const MAX_EXPORT_PIXELS = 64_000_000;

export interface ExportOptions {
  size: ExportSize;
  /** JPEG quality 0.3–1. */
  quality: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** Renders one photo's original through its recipe, at the chosen size, as a metadata-free JPEG. */
export async function renderExport(
  photo: Pick<PhotoItem, 'id' | 'fileType' | 'filename'>,
  recipe: EditRecipe | null,
  o: ExportOptions,
): Promise<Blob> {
  const r = recipe ?? (await getEdit(photo.id, o.signal))?.recipe ?? null;
  return withRenderer(async (gl) => {
    const loaded = await loadOriginal(photo, { full: true, maxEdge: gl.maxTexture, signal: o.signal });
    try {
      gl.setSource(loaded.source);
      const full = outputSize(r?.crop, gl.sourceSize);
      let s = o.size.kind === 'full' ? full : fitLongEdge(full, o.size.edge);
      if (s.width * s.height > MAX_EXPORT_PIXELS) {
        const k = Math.sqrt(MAX_EXPORT_PIXELS / (s.width * s.height));
        s = { width: Math.floor(s.width * k), height: Math.floor(s.height * k) };
      }
      const px = gl.renderPixels({
        recipe: r,
        width: s.width,
        height: s.height,
        baselineEv: loaded.baselineEv,
      });
      return encodeJpeg(px, s.width, s.height, o.quality);
    } finally {
      releaseSource(loaded.source);
    }
  });
}

/** Several photos as one .zip (stored, not recompressed: JPEGs don't shrink). */
export async function exportZip(
  photos: Pick<PhotoItem, 'id' | 'fileType' | 'filename'>[],
  o: ExportOptions,
): Promise<Blob> {
  const { Zip, ZipPassThrough } = await import('fflate');
  const names = uniqueNames(photos.map((p) => exportName(p.filename)));
  const parts: Uint8Array[] = [];
  const zip = new Zip((err, chunk) => {
    if (err) throw err;
    parts.push(chunk);
  });
  for (let i = 0; i < photos.length; i++) {
    if (o.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const blob = await renderExport(photos[i] as PhotoItem, null, o);
    const f = new ZipPassThrough(names[i] as string);
    zip.add(f);
    f.push(new Uint8Array(await blob.arrayBuffer()), true);
    o.onProgress?.(i + 1, photos.length);
  }
  zip.end();
  return new Blob(parts as BlobPart[], { type: 'application/zip' });
}

/** Saves a blob through the browser (a download), or the share sheet on phones that support it. */
export async function saveBlob(blob: Blob, name: string, preferShare = false): Promise<void> {
  if (preferShare && typeof navigator.canShare === 'function') {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
