import { FILE_TYPES, type PhotoItem } from '@zephyr/shared/client';
import { ApiFailure } from '../api';
import { originalPreviewUrl } from '../edits';
import { originalUrl } from '../library';
import type { Source } from './gl';
import { decodeRaw, RawTooLargeForFull } from './raw';
import { onEditorReset } from './resets';

export interface LoadedSource {
  source: Source;
  baselineEv: number;
  /** 'preview' (≤ 2048 px stored preview), 'half' (RAW half size) or 'full'. */
  quality: 'preview' | 'half' | 'full';
  /** A full size decode was asked for but the RAW is too big for this device: this is the half-size one. */
  limited?: boolean;
}

async function fetchBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!res.ok) throw new ApiFailure(res.status === 404 ? 'not_found' : 'server', res.status);
  return res.blob();
}

/** Decodes an image blob upright, scaled down if it's bigger than the GPU can hold. */
async function bitmapSource(blob: Blob, maxEdge: number): Promise<Source> {
  let bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  if (Math.max(bmp.width, bmp.height) > maxEdge) {
    const k = maxEdge / Math.max(bmp.width, bmp.height);
    const resized = await createImageBitmap(blob, {
      imageOrientation: 'from-image',
      resizeWidth: Math.round(bmp.width * k),
      resizeHeight: Math.round(bmp.height * k),
      resizeQuality: 'high',
    });
    bmp.close();
    bmp = resized;
  }
  return { kind: 'bitmap', bitmap: bmp, width: bmp.width, height: bmp.height };
}

export const isRaw = (p: Pick<PhotoItem, 'fileType'>) => FILE_TYPES[p.fileType]?.raw === true;

/** The stored (unedited) preview: fast, always available for photos with a preview. */
export async function loadPreview(
  photoId: string,
  maxEdge: number,
  signal?: AbortSignal,
): Promise<LoadedSource> {
  const blob = await fetchBlob(originalPreviewUrl(photoId), signal);
  return { source: await bitmapSource(blob, maxEdge), baselineEv: 0, quality: 'preview' };
}

/**
 * RAW baseline exposure per photo and file. A RAW's linear data gets an automatic exposure lift (0–2 EV from
 * its log-average brightness). It is always measured on the half-size decode, the one used for editing, and
 * reused for full-size exports, so an export is exactly as bright as what the member edited.
 */
const baselines = new Map<string, number>();
const baselineKey = (photoId: string, size: number) => `${photoId}:${size}`;
/** Forgets every measured baseline (session end). */
export function clearRawBaselines(): void {
  baselines.clear();
}

/**
 * The original, decoded on this device. RAW files go through LibRaw (half size while editing, full size for
 * export); other files through the browser's decoder.
 */
export async function loadOriginal(
  photo: Pick<PhotoItem, 'id' | 'fileType'>,
  opts: { full: boolean; maxEdge: number; signal?: AbortSignal },
): Promise<LoadedSource> {
  const blob = await fetchBlob(originalUrl(photo.id), opts.signal);
  if (isRaw(photo)) {
    const buf = await blob.arrayBuffer();
    const key = baselineKey(photo.id, blob.size);
    let baselineEv = baselines.get(key);
    if (opts.full && baselineEv === undefined) {
      // No editing session measured it yet: run the half-size pass first, for the same number.
      baselineEv = (await decodeRaw(buf.slice(0), true, opts.signal)).baselineEv;
      baselines.set(key, baselineEv);
    }
    let raw: Awaited<ReturnType<typeof decodeRaw>>;
    let limited = false;
    try {
      raw = await decodeRaw(opts.full ? buf.slice(0) : buf, !opts.full, opts.signal);
    } catch (e) {
      if (!(opts.full && e instanceof RawTooLargeForFull)) throw e;
      // Too big to develop at full size in this browser's memory: the half-size decode still works.
      raw = await decodeRaw(buf, true, opts.signal);
      limited = true;
    }
    if (!opts.full) {
      baselineEv = raw.baselineEv;
      baselines.set(key, baselineEv);
    }
    if (Math.max(raw.width, raw.height) > opts.maxEdge)
      throw new Error('This RAW is larger than this device can edit.');
    return {
      source: { kind: 'half', data: raw.data, width: raw.width, height: raw.height },
      baselineEv: baselineEv ?? raw.baselineEv,
      quality: opts.full && !limited ? 'full' : 'half',
      limited,
    };
  }
  return { source: await bitmapSource(blob, opts.maxEdge), baselineEv: 0, quality: 'full' };
}

export function releaseSource(s: Source | null | undefined): void {
  if (s?.kind === 'bitmap' && 'close' in s.bitmap) (s.bitmap as ImageBitmap).close();
}

onEditorReset(clearRawBaselines);
