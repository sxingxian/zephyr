/// <reference lib="webworker" />
import type { CleanupPhoto } from '@zephyr/shared/client';
import { groupCleanup } from './cleanup';

/** Groups a library's quality signals off the main thread (client review #9). */
self.onmessage = (e: MessageEvent<{ n: number; photos: CleanupPhoto[] }>) => {
  const { n, photos } = e.data;
  try {
    (self as unknown as Worker).postMessage({ n, result: groupCleanup(photos) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ n, error: String((err as Error)?.message ?? err) });
  }
};
