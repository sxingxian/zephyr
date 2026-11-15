import { GALLERY_NAME_MAX, MAX_GALLERY_PHOTOS } from '@zephyr/shared/client';
import { browser, sessionUserId } from './sessionGuard';

/**
 * Phase 8: Share from a page holding Google's AdSense script. The new gallery's link and passcode must never be
 * shown in that document, so the selection is handed to /share/new (a page without ads, opened with a full page
 * load, so the script is gone) through this tab's sessionStorage, and the create flow runs there.
 *
 * The hand-off is bound to the member who started it, lives ten minutes, is read once, and everything in it is
 * checked again on the way out: page script can write sessionStorage too, but the worst it could do is pick
 * which of the member's own photos the dialog offers to share, which the member still confirms.
 */
export const SHARE_HANDOFF_KEY = 'zephyr.shareHandoff';
export const SHARE_HANDOFF_PATH = '/share/new';
export const SHARE_HANDOFF_MAX_AGE_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ShareHandoff {
  ids: string[];
  name: string;
}

/** Saves the selection and opens /share/new with a full page load. */
export function startShareHandoff(ids: string[], name = ''): void {
  try {
    sessionStorage.setItem(
      SHARE_HANDOFF_KEY,
      JSON.stringify({ user: sessionUserId(), ids, name, at: Date.now() }),
    );
  } catch {
    // No storage (private mode): /share/new then explains there's nothing to share.
  }
  // The same member goes on in the next document: no storage clean-up (it would drop the hand-off).
  browser.assign(SHARE_HANDOFF_PATH, { keepStorage: true });
}

/** Reads (once) and checks the hand-off for the member signed in now; null when missing, stale or malformed. */
export function takeShareHandoff(now = Date.now()): ShareHandoff | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(SHARE_HANDOFF_KEY);
    sessionStorage.removeItem(SHARE_HANDOFF_KEY);
  } catch {
    return null;
  }
  if (!raw || raw.length > 200_000) return null;
  try {
    const v = JSON.parse(raw) as { user?: unknown; ids?: unknown; name?: unknown; at?: unknown } | null;
    const me = sessionUserId();
    if (!v || !me || v.user !== me) return null;
    if (typeof v.at !== 'number' || !(now - v.at >= 0 && now - v.at <= SHARE_HANDOFF_MAX_AGE_MS)) return null;
    if (!Array.isArray(v.ids) || v.ids.length < 1 || v.ids.length > MAX_GALLERY_PHOTOS) return null;
    if (!v.ids.every((id) => typeof id === 'string' && UUID.test(id))) return null;
    const ids = [...new Set((v.ids as string[]).map((id) => id.toLowerCase()))];
    const name =
      typeof v.name === 'string'
        ? [...v.name]
            .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
            .join('')
            .slice(0, GALLERY_NAME_MAX)
        : '';
    return { ids, name };
  } catch {
    return null;
  }
}
