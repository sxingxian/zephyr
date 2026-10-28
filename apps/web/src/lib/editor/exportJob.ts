import { ApiFailure } from '../api';
import { onSessionEnd, sessionUserId } from '../sessionGuard';

/**
 * A running export or Save as copy. It belongs to the member who started it: the end of that member's
 * session (sign-out, a 401, someone else signing in) aborts it, and its result is only ever saved or
 * uploaded for that member. Rendering a big RAW can take a while, and on a shared device someone else may
 * have signed in by the time it finishes.
 */
export interface ExportJob {
  owner: string;
  signal: AbortSignal;
  /** Throws AbortError if the job was stopped or someone else is signed in now. */
  check(): void;
  finish(): void;
}

const running = new Set<AbortController>();

export function startExportJob(): ExportJob {
  const owner = sessionUserId();
  if (!owner) throw new ApiFailure('unauthenticated', 401);
  const c = new AbortController();
  running.add(c);
  return {
    owner,
    signal: c.signal,
    check() {
      if (c.signal.aborted || sessionUserId() !== owner) {
        c.abort();
        throw new DOMException('The export was stopped.', 'AbortError');
      }
    },
    finish() {
      running.delete(c);
    },
  };
}

/** Stops every running export (fetches, the RAW decode and rendering stop at their next step). */
export function abortExportJobs(): void {
  for (const c of running) c.abort();
  running.clear();
}

/** How many exports are running (tests). */
export const runningExports = () => running.size;

onSessionEnd(() => abortExportJobs());
