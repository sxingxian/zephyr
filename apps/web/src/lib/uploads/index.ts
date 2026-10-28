import type { PhotoMetadata } from '@zephyr/shared/client';
import { useEffect, useSyncExternalStore } from 'react';
import { emitLibrary } from '../bus';
import { abortUpload, completeUpload, createUploads, putPart, putVariant, uploadStatus } from '../library';
import { onSessionEnd, sessionUserId } from '../sessionGuard';
import { getUsage, refreshUsage } from '../usage';
import { readMetadata } from './exif';
import { hashFile, stopHashing } from './hash';
import { type Prepared, UploadManager, type UploadSnapshot } from './manager';
import { rawPreview } from './raw';
import { makeVariants } from './variants';

/** Metadata, thumbnail and preview for one file. RAW files use the camera's embedded JPEG preview. */
export async function prepareFile(file: File, raw: boolean): Promise<Prepared> {
  const metadata: PhotoMetadata = await readMetadata(file);
  const rotate = raw ? (metadata.orientation ?? 1) : 1;
  const source = raw ? await rawPreview(file).catch(() => null) : file;
  const v = source ? await makeVariants(source, rotate) : {};
  if (raw) {
    // Sensor size from EXIF, turned to match how the photo is displayed.
    if (metadata.width && metadata.height && rotate >= 5) {
      [metadata.width, metadata.height] = [metadata.height, metadata.width];
    }
    if (!metadata.width && v.width && v.height) {
      metadata.width = v.width;
      metadata.height = v.height;
    }
  } else if (v.width && v.height) {
    metadata.width = v.width;
    metadata.height = v.height;
  }
  return { metadata, thumb: v.thumb, preview: v.preview };
}

/**
 * The app's one upload queue. It outlives route changes; the tray reads it from anywhere. Each file is bound
 * to the member who added it, and the whole queue is reset when the session ends or changes.
 */
export const uploads = new UploadManager({
  owner: sessionUserId,
  rules: async () => {
    if (!getUsage()) await refreshUsage();
    const u = getUsage();
    return u ? { fileTypes: u.fileTypes, maxFileBytes: u.maxFileBytes, batchSize: u.batchSize } : null;
  },
  hash: (file) => hashFile(file),
  prepare: prepareFile,
  create: (files) => createUploads({ files }).then((r) => r.results),
  putVariant: (id, kind, blob, signal) => putVariant(id, kind, blob, signal),
  putPart: (id, n, blob, signal, onProgress) => putPart(id, n, blob, signal, onProgress),
  complete: (id, metadata) => completeUpload(id, { metadata }),
  status: uploadStatus,
  abort: abortUpload,
  onPhoto: (photo) => emitLibrary({ type: 'added', photo }),
  onSettled: () => void refreshUsage(),
  objectUrl: (b) => URL.createObjectURL(b),
  revokeUrl: (u) => URL.revokeObjectURL(u),
  stopHashing,
});

// Signing out (or any change of member) empties the queue. On a deliberate sign-out the session is still
// valid, so the server is told to drop the uploads it holds; otherwise they expire on their own.
onSessionEnd(({ server }) => uploads.reset({ server }));

export function useUploads(): UploadSnapshot {
  return useSyncExternalStore(uploads.subscribe, uploads.getSnapshot, uploads.getSnapshot);
}

/** Warns before closing the tab while files are still uploading. */
export function useLeaveWarning(busy: boolean): void {
  useEffect(() => {
    if (!busy) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [busy]);
}

export type { UploadItem, UploadSnapshot, UploadState } from './manager';
