import type { EditRecipe, PhotoItem } from '@zephyr/shared/client';
import { getEdit } from '../edits';
import { withRenderer } from './background';
import { encodeJpeg } from './encode';
import { fitLongEdge, outputSize } from './geometry';
import {
  ExportProblem,
  estimateJpegBytes,
  exportName,
  uniqueNames,
  ZIP_MEMORY_LIMIT,
  zipTooBig,
} from './names';
import { loadOriginal, releaseSource } from './sources';
import type { ZipSink } from './zipSink';

export { exportName };

const aborted = () => new DOMException('The export was stopped.', 'AbortError');
const stopIf = (signal?: AbortSignal) => {
  if (signal?.aborted) throw aborted();
};

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

/**
 * Renders one photo's original through its recipe, at the chosen size, as a metadata-free JPEG. The signal
 * stops it between steps: fetching, decoding, rendering and encoding.
 */
export async function renderExport(
  photo: Pick<PhotoItem, 'id' | 'fileType' | 'filename'>,
  recipe: EditRecipe | null,
  o: ExportOptions,
): Promise<Blob> {
  const r = recipe ?? (await getEdit(photo.id, o.signal))?.recipe ?? null;
  stopIf(o.signal);
  return withRenderer(async (gl) => {
    stopIf(o.signal);
    const loaded = await loadOriginal(photo, { full: true, maxEdge: gl.maxTexture, signal: o.signal });
    try {
      stopIf(o.signal);
      if (loaded.limited && o.size.kind === 'full')
        throw new ExportProblem(
          `${photo.filename} is too large to develop at full size in this browser. Choose “Long edge 2048” or a custom size.`,
        );
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
      const jpeg = await encodeJpeg(px, s.width, s.height, o.quality);
      stopIf(o.signal);
      return jpeg;
    } finally {
      releaseSource(loaded.source);
    }
  });
}

type ZipPhoto = Pick<PhotoItem, 'id' | 'fileType' | 'filename'> &
  Partial<Pick<PhotoItem, 'width' | 'height'>>;

/** Estimated size of a batch export, for the memory cap (unknown sizes count as 24 MP). */
export function estimateExport(photos: ZipPhoto[], size: ExportSize, quality: number): number {
  let total = 0;
  for (const p of photos) {
    const d = p.width && p.height ? { width: p.width, height: p.height } : { width: 6000, height: 4000 };
    const s = size.kind === 'full' ? d : fitLongEdge(d, size.edge);
    total += estimateJpegBytes(Math.min(MAX_EXPORT_PIXELS, s.width * s.height), quality);
  }
  return total;
}

/**
 * Several photos as one .zip (stored, not recompressed: JPEGs don't shrink).
 *
 * With a sink, each photo is written to disk as soon as it's rendered, so memory holds one photo at a time;
 * the result is null. Without one, the zip is built in memory and returned, which is capped by
 * `zipTooBig` (checked up front from estimates, and again against the real size as it grows).
 */
export async function exportZip(
  photos: ZipPhoto[],
  o: ExportOptions,
  sink?: ZipSink | null,
): Promise<Blob | null> {
  if (!sink) {
    const problem = zipTooBig(
      estimateExport(photos, o.size, o.quality),
      photos.length,
      o.size.kind === 'full',
    );
    if (problem) throw new ExportProblem(problem);
  }
  const { Zip, ZipPassThrough } = await import('fflate');
  const names = uniqueNames(photos.map((p) => exportName(p.filename)));
  const parts: Uint8Array[] = [];
  let held = 0;
  let writing: Promise<void> = Promise.resolve();
  let failed: unknown = null;
  const zip = new Zip((err, chunk) => {
    if (err) {
      failed = err;
      return;
    }
    if (sink) writing = writing.then(() => sink.write(chunk));
    else {
      parts.push(chunk);
      held += chunk.byteLength;
    }
  });
  try {
    for (let i = 0; i < photos.length; i++) {
      stopIf(o.signal);
      const blob = await renderExport(photos[i] as PhotoItem, null, o);
      const f = new ZipPassThrough(names[i] as string);
      zip.add(f);
      f.push(new Uint8Array(await blob.arrayBuffer()), true);
      if (failed) throw failed;
      if (sink)
        await writing; // one photo in memory at a time
      else if (held > ZIP_MEMORY_LIMIT)
        throw new ExportProblem(zipTooBig(held, photos.length, o.size.kind === 'full') ?? 'Too large.');
      o.onProgress?.(i + 1, photos.length);
    }
    zip.end();
    if (failed) throw failed;
    if (sink) {
      await writing;
      await sink.close();
      return null;
    }
    return new Blob(parts as BlobPart[], { type: 'application/zip' });
  } catch (e) {
    parts.length = 0;
    if (sink) await sink.abort().catch(() => undefined);
    throw e;
  }
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
