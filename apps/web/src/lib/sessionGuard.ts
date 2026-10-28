/**
 * Who the session belongs to, readable outside React, and the clean-up that runs when it ends.
 *
 * Some state outlives pages (the upload queue). It binds its work to the member who started it and is
 * reset through `endSession` whenever that member signs out, is signed out, deletes the account or is
 * replaced by someone else, in this tab or another one. On a shared device nothing queued by one member
 * is ever sent with the next member's cookie.
 */

export type EndReason = 'sign-out' | 'unauthenticated' | 'switched' | 'deleted';
/** `server`: the session is still valid, so a hook may tell the server to drop work in progress. */
export type EndHook = (o: { reason: EndReason; server: boolean }) => void | Promise<void>;

let currentId: string | null = null;
const hooks = new Set<EndHook>();

/** The signed-in member's id, or null. */
export const sessionUserId = (): string | null => currentId;

/** Called by the session layer whenever it learns who is signed in (null: nobody). */
export function setSessionUserId(id: string | null): void {
  if (id === currentId) return;
  currentId = id;
  announce(id);
}

export function onSessionEnd(fn: EndHook): () => void {
  hooks.add(fn);
  return () => {
    hooks.delete(fn);
  };
}

/**
 * Runs every clean-up hook. Each hook stops its work synchronously; the promise covers any server clean-up
 * and settles after at most `waitMs`, so a slow network never holds up signing out.
 */
export function endSession(reason: EndReason, server: boolean, waitMs = 3000): Promise<void> {
  const runs: Promise<unknown>[] = [];
  for (const h of hooks) {
    try {
      runs.push(Promise.resolve(h({ reason, server })).catch(() => {}));
    } catch {
      // A failing hook mustn't stop the others.
    }
  }
  if (!runs.length) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.all(runs).then(() => undefined),
    new Promise<void>((r) => {
      timer = setTimeout(r, waitMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Full page load: drops every bit of in-memory state (photo data, queues, caches) for good. */
export const browser = {
  assign(path: string): void {
    window.location.assign(path);
  },
};

// ------------------------------------------------------------ other tabs
// The session cookie is shared by every tab. When another tab signs out or signs in as someone else, this
// tab's queue must stop too: its next request would carry the new cookie.
const CHANNEL = 'zephyr-session';
let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  try {
    channel = new BroadcastChannel(CHANNEL);
    // Node (tests) keeps the process alive for an open channel; browsers don't have unref.
    (channel as unknown as { unref?: () => void }).unref?.();
  } catch {
    channel = null;
  }
  return channel;
}
function announce(id: string | null) {
  try {
    getChannel()?.postMessage({ type: 'session-user', id });
  } catch {
    // Best effort.
  }
}

/** Calls `fn` when another tab reports a different signed-in member (or none) than this tab has. */
export function onOtherTabSession(fn: (id: string | null) => void): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const h = (e: MessageEvent) => {
    const d = e.data as { type?: unknown; id?: unknown } | null;
    if (d?.type !== 'session-user' || (d.id !== null && typeof d.id !== 'string')) return;
    if (currentId !== null && d.id !== currentId) fn(d.id as string | null);
  };
  ch.addEventListener('message', h);
  return () => ch.removeEventListener('message', h);
}
