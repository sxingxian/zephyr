/// <reference lib="webworker" />
import { sha256Blob } from './sha256';

interface Job {
  id: number;
  file: Blob;
}
type Reply = { id: number; progress: number } | { id: number; hash: string } | { id: number; error: string };

// Hashing runs off the main thread so scrolling and the upload tray stay smooth.
const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = async (e: MessageEvent<Job>) => {
  const { id, file } = e.data;
  const post = (r: Reply) => ctx.postMessage(r);
  try {
    let last = 0;
    const hash = await sha256Blob(file, (done) => {
      if (done - last >= 32 * 1024 * 1024) {
        last = done;
        post({ id, progress: done });
      }
    });
    post({ id, hash });
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : 'hash failed' });
  }
};
