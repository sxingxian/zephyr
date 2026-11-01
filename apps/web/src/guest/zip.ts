import type { GuestPhoto } from '@zephyr/shared/client';
import { cleanExportName, estimateJpegBytes, uniqueNames, zipTooBig } from '../lib/editor/names';
import type { ZipSink } from '../lib/editor/zipSink';

export type ZipSize = 'web' | 'full';

/** A problem the guest can act on; its message is shown as written. */
export class ZipProblem extends Error {
  override name = 'ZipProblem';
}

const WEB_EDGE = 2048;
function pixels(p: GuestPhoto, size: ZipSize): number {
  const w = p.width || 6000;
  const h = p.height || 4000;
  if (size === 'full') return w * h;
  const k = Math.min(1, WEB_EDGE / Math.max(w, h));
  return Math.round(w * k) * Math.round(h * k);
}

/** Which photos can go in the zip at this size: full-size renders still being prepared are left out. */
export function zipPlan(photos: GuestPhoto[], size: ZipSize): { included: GuestPhoto[]; preparing: number } {
  const included: GuestPhoto[] = [];
  let preparing = 0;
  for (const p of photos) {
    if (!p.download) continue;
    if (size === 'full' && !p.download.full) preparing++;
    else included.push(p);
  }
  return { included, preparing };
}

/** Names inside the zip: the gallery name and a running number. Members' own file names never leave Zephyr. */
export function zipEntryNames(galleryName: string, count: number): string[] {
  const width = Math.max(3, String(count).length);
  return uniqueNames(
    Array.from({ length: count }, (_, i) =>
      cleanExportName(`${galleryName} ${String(i + 1).padStart(width, '0')}`, 'photo'),
    ),
  );
}

/** Refuses an in-memory zip that would be too big for the browser (a streamed one has no such limit). */
export function checkZipSize(photos: GuestPhoto[], size: ZipSize, streaming: boolean): void {
  if (streaming) return;
  const estimate = photos.reduce(
    (t, p) => t + estimateJpegBytes(pixels(p, size), size === 'full' ? 0.92 : 0.86),
    0,
  );
  if (zipTooBig(estimate, photos.length, size === 'full'))
    throw new ZipProblem(
      size === 'full'
        ? 'That’s too much to zip in this browser. Download at web size, or save photos one at a time from the viewer.'
        : 'That’s too much to zip in this browser. Save photos one at a time from the viewer instead.',
    );
}

export interface ZipOptions {
  size: ZipSize;
  galleryName: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Called when a signed URL has expired; returns the photo with fresh URLs (or null if it's gone). */
  fresh?: (id: string) => Promise<GuestPhoto | null>;
}

async function fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  const res = await fetch(url, { credentials: 'same-origin', referrerPolicy: 'no-referrer', signal });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The gallery as one .zip, built in this browser (stored, not recompressed: JPEGs don't shrink). With a
 * sink the zip streams to disk one photo at a time and the result is null; without one it is held in memory
 * and returned, which `checkZipSize` caps up front.
 */
export async function buildZip(
  photos: GuestPhoto[],
  o: ZipOptions,
  sink?: ZipSink | null,
): Promise<Blob | null> {
  checkZipSize(photos, o.size, Boolean(sink));
  const { Zip, ZipPassThrough } = await import('fflate');
  const names = zipEntryNames(o.galleryName, photos.length);
  const parts: Uint8Array[] = [];
  let writing: Promise<void> = Promise.resolve();
  let failed: unknown = null;
  const zip = new Zip((err, chunk) => {
    if (err) {
      failed = err;
      return;
    }
    if (sink) writing = writing.then(() => sink.write(chunk));
    else parts.push(chunk);
  });
  try {
    for (let i = 0; i < photos.length; i++) {
      if (o.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      let p = photos[i] as GuestPhoto;
      const pick = (q: GuestPhoto) => (o.size === 'full' ? q.download?.full : q.download?.web) ?? null;
      let url = pick(p);
      let bytes = url ? await fetchBytes(url, o.signal) : null;
      if (!bytes && o.fresh) {
        // Signed URLs last an hour; a long download can outlive them.
        const again = await o.fresh(p.id);
        if (again) {
          p = again;
          url = pick(p);
          bytes = url ? await fetchBytes(url, o.signal) : null;
        }
      }
      if (!bytes)
        throw new ZipProblem('A photo couldn’t be downloaded. Check your connection and try again.');
      const entry = new ZipPassThrough(names[i] as string);
      zip.add(entry);
      entry.push(bytes, true);
      if (failed) throw failed;
      await writing;
      o.onProgress?.(i + 1, photos.length);
    }
    zip.end();
    await writing;
    if (failed) throw failed;
    if (sink) {
      await sink.close();
      return null;
    }
    return new Blob(parts as BlobPart[], { type: 'application/zip' });
  } catch (e) {
    if (sink) await sink.abort().catch(() => undefined);
    throw e;
  }
}

/** Saves a blob through a temporary same-origin object URL. */
export function saveBlob(blob: Blob, name: string): void {
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
