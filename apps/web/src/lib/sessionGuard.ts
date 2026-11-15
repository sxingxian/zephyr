/**
 * Who the session belongs to, readable outside React, and the clean-up that runs when it ends.
 *
 * Some state outlives pages (the upload queue). It binds its work to the member who started it and is
 * reset through `endSession` whenever that member signs out, is signed out, deletes the account or is
 * replaced by someone else, in this tab or another one. On a shared device nothing queued by one member
 * is ever sent with the next member's cookie.
 */

/** `library`: the member switched library in this tab (phase 7); the session itself goes on. */
export type EndReason = 'sign-out' | 'unauthenticated' | 'switched' | 'deleted' | 'library';
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

/**
 * Phase 8: something to do before a full page load that ends what this document was doing for the member (a
 * sign-out, a session that ended, another member, losing ads). The ads module uses it, while Google's AdSense
 * script is in the page, to have the server answer `Clear-Site-Data: "cache", "storage"` first, so nothing the
 * script wrote to this origin survives; and, when a session ends in a document without the script
 * (`sessionEnd`), to ask the same only if this browser may have run it (the server knows from a cookie).
 * Returns null when there's nothing to do (then the load starts at once).
 */
type BeforeFullLoad = (o: { sessionEnd: boolean }) => Promise<void> | null;
let beforeFullLoad: BeforeFullLoad | null = null;
export function setBeforeFullLoad(fn: BeforeFullLoad | null): void {
  beforeFullLoad = fn;
}
/** The most a full page load waits for that clean-up. */
export const BEFORE_FULL_LOAD_MAX_MS = 1500;
/**
 * A full page load that hasn't happened this long after it started was cancelled (the "Leave site?" prompt
 * answered Stay): the latch comes off, so a later reload (a plan change, AdSense dropped) still works.
 */
export const LEAVING_RESET_MS = 5000;

/** Full page load: drops every bit of in-memory state (photo data, queues, caches) for good. */
let leaving = false;
let latchTimer: ReturnType<typeof setTimeout> | null = null;
function armLatchReset(): void {
  if (latchTimer) clearTimeout(latchTimer);
  latchTimer = setTimeout(() => {
    latchTimer = null;
    const release = () => {
      leaving = false;
    };
    // Still here and in front: the load was cancelled. In the background, wait until the tab is shown again.
    if (typeof document === 'undefined' || document.visibilityState === 'visible') release();
    else
      document.addEventListener('visibilitychange', function once() {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', once);
        release();
      });
  }, LEAVING_RESET_MS);
}
function go(load: () => void, o: { keepStorage?: boolean; sessionEnd?: boolean }): void {
  leaving = true;
  const pending = o.keepStorage ? null : (beforeFullLoad?.({ sessionEnd: o.sessionEnd === true }) ?? null);
  if (!pending) {
    load();
    armLatchReset();
    return;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    load();
    armLatchReset();
  };
  setTimeout(finish, BEFORE_FULL_LOAD_MAX_MS);
  void pending.catch(() => undefined).then(finish);
}
export const browser = {
  /**
   * `keepStorage`: the same member goes on in the next document (AdsRouteGate leaving the ad pages), so the
   * storage clean-up isn't needed. `sessionEnd`: this load ends the member's session here (signed out, session
   * ended, another member, suspended), so the clean-up runs even without the script in this document, when the
   * server says this browser may have run it.
   */
  assign(path: string, o: { keepStorage?: boolean; sessionEnd?: boolean } = {}): void {
    go(() => window.location.assign(path), o);
  },
  /**
   * Reloads the current page (phase 8: drops a loaded AdSense script after a plan or account change). Skipped
   * when a full navigation is already under way, so it can't cancel that navigation.
   */
  reload(): void {
    if (leaving) return;
    go(() => window.location.reload(), {});
  },
};
/** True once a full page load has been started (nothing else should navigate). */
export const isLeaving = (): boolean => leaving;
/** Test helper. */
export function __resetLeavingForTest(): void {
  leaving = false;
  if (latchTimer) clearTimeout(latchTimer);
  latchTimer = null;
  beforeFullLoad = null;
}

/**
 * Phase 8: a page restored from the back/forward cache could hold another member's state (or Google's script
 * loaded for them) while the cookie now belongs to someone else: load it fresh instead. App pages are also sent
 * `no-store`, which keeps most browsers from keeping them there at all.
 */
export function reloadWhenRestored(): () => void {
  if (typeof window === 'undefined') return () => {};
  const h = (e: PageTransitionEvent) => {
    if (!e.persisted) return;
    leaving = true;
    window.location.reload();
  };
  window.addEventListener('pageshow', h);
  return () => window.removeEventListener('pageshow', h);
}

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

/** Phase 8: this tab saw the member's plan change (upgrade, downgrade, staff override): other tabs re-read it. */
export function announcePlanChange(): void {
  try {
    getChannel()?.postMessage({ type: 'plan-changed', id: currentId });
  } catch {
    // Best effort.
  }
}
/** Calls `fn` when another tab reports a plan change for the member signed in here. */
export function onOtherTabPlanChange(fn: () => void): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const h = (e: MessageEvent) => {
    const d = e.data as { type?: unknown; id?: unknown } | null;
    if (d?.type === 'plan-changed' && currentId !== null && d.id === currentId) fn();
  };
  ch.addEventListener('message', h);
  return () => ch.removeEventListener('message', h);
}

/** Phase 8: this tab saw the member's libraries change (joined or left a team): other tabs re-read them. */
export function announceLibrariesChange(): void {
  try {
    getChannel()?.postMessage({ type: 'libraries-changed', id: currentId });
  } catch {
    // Best effort.
  }
}
/** Calls `fn` when another tab reports a library change for the member signed in here. */
export function onOtherTabLibrariesChange(fn: () => void): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const h = (e: MessageEvent) => {
    const d = e.data as { type?: unknown; id?: unknown } | null;
    if (d?.type === 'libraries-changed' && currentId !== null && d.id === currentId) fn();
  };
  ch.addEventListener('message', h);
  return () => ch.removeEventListener('message', h);
}

/** Calls `fn` when another tab reports a different signed-in member (or none) than this tab has. */
/**
 * Phase 8 (review round 5): while the account-action page holds an unspent emailed link, it ignores other tabs'
 * session broadcasts. Any same-origin page can post on the channel (Google's AdSense script in a library tab
 * included), so a forged "signed out" must not bounce the member off the page and waste the link. The API stays
 * the source of truth: if the session really ended or changed, the link's calls are refused.
 */
let holdOtherTabSession = false;
export function setHoldOtherTabSession(hold: boolean): void {
  holdOtherTabSession = hold;
}

export function onOtherTabSession(fn: (id: string | null) => void): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const h = (e: MessageEvent) => {
    const d = e.data as { type?: unknown; id?: unknown } | null;
    if (d?.type !== 'session-user' || (d.id !== null && typeof d.id !== 'string')) return;
    if (holdOtherTabSession) return;
    if (currentId !== null && d.id !== currentId) fn(d.id as string | null);
  };
  ch.addEventListener('message', h);
  return () => ch.removeEventListener('message', h);
}
