import {
  type AdEventBody,
  type AdPlacement,
  type AdsResult,
  MEMBER8_API,
  PLANS,
  type PlanId,
} from '@zephyr/shared/client';
import { useSyncExternalStore } from 'react';
import { ADS_DOC_META, adsAllowedOn } from '../../worker/adPages.js';
import { api } from './api';
import { sessionUserId, setBeforeFullLoad } from './sessionGuard';

/**
 * Phase 8: ads for Free members, in their own library only (a team library never shows ads).
 *
 * - Sponsored cards come from `/api/v1/ads` and are rendered by the app (first-party, same-origin images).
 * - Google AdSense loads only when the API says so (`adsense` present), and only once a unit is actually shown
 *   on a page where ads are allowed. The AdSense tag brings Google's own consent message (Privacy & messaging);
 *   no other consent script is loaded. The app Worker widens the CSP for Google's hosts only while AdSense is on.
 * - Ads are never shown in the editor, the photo viewer, sharing, billing, settings, team or sign-in pages
 *   (`worker/adPages.js`, shared with the app Worker). Once Google's script is in the page, leaving the ad pages
 *   is a full page load (AdsRouteGate), so the script never sees those pages; the Worker sends the AdSense CSP
 *   only for documents on ad pages, and only to members the API shows AdSense (its cookie). A plan upgrade (here,
 *   in another tab or by staff), joining a team, a sign-out, an account change or a library change also
 *   reloads, after the server clears the site's storage; a member of any team library never gets AdSense.
 * - Nothing secret (a new gallery's link and passcode, invite links) is ever shown in a document holding the
 *   script (NoAdsSurface); Share from an ad page continues on /share/new with a full page load.
 */
export type SponsoredCard = AdsResult['cards'][number];
export interface Ads {
  cards: SponsoredCard[];
  adsense: AdsResult['adsense'];
}

export { adsAllowedOn };

/**
 * Whether the Worker served this document with the AdSense CSP: it puts a `<meta name="zephyr-ads">` at the top
 * of <head> (worker/index.ts markAdsDocument), read once when this module loads. AdSense units mount only in such
 * documents (elsewhere the CSP would block Google's script anyway); other page loads show sponsored cards only.
 */
export function documentMarker(): { wide: boolean } {
  try {
    return { wide: document.querySelector(`meta[name="${ADS_DOC_META}"]`)?.getAttribute('content') === '1' };
  } catch {
    return { wide: false };
  }
}
let docPath = typeof window === 'undefined' ? '' : window.location.pathname;
let docMarker = typeof document === 'undefined' ? { wide: false } : documentMarker();
export const documentAllowsAdsense = (): boolean => adsAllowedOn(docPath) && docMarker.wide;
/**
 * This document got the strict policy (loaded on a page without ads, or before the AdSense cookie was set) and
 * the member is now on an ad page with AdSense to show: it may reload once to get the AdSense policy. At most once
 * a minute per tab, so a cookie that doesn't stick can't cause a reload loop.
 */
const RELOAD_KEY = 'zephyr.adsReload';
export function mayReloadForAdsense(now = Date.now()): boolean {
  if (documentAllowsAdsense()) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < 60_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

export function planHasAds(plan: PlanId | undefined): boolean {
  return Boolean(plan && PLANS.find((p) => p.id === plan)?.limits.ads);
}

// ---------------------------------------------------------------- validation
const PUBLISHER = /^ca-pub-\d{16}$/;
const SLOT = /^\d{10}$/;
const IMAGE_PATH = /^\/api\/v1\/ads\/cards\/[A-Za-z0-9_-]+\/image\?v=\d+$/;

/** https only, no credentials (the API enforces the same; checked again before it becomes a link). */
export function safeAdUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function clean(r: AdsResult | null | undefined): Ads {
  const cards: SponsoredCard[] = [];
  for (const c of Array.isArray(r?.cards) ? r.cards : []) {
    const url = typeof c?.url === 'string' ? safeAdUrl(c.url) : null;
    if (!url || typeof c.id !== 'string' || !Array.isArray(c.placements)) continue;
    cards.push({
      ...c,
      url,
      imageUrl: typeof c.imageUrl === 'string' && IMAGE_PATH.test(c.imageUrl) ? c.imageUrl : null,
      weight: Math.min(100, Math.max(1, Number(c.weight) || 1)),
    });
  }
  let adsense: Ads['adsense'] = null;
  const a = r?.adsense;
  if (a && typeof a.publisherId === 'string' && PUBLISHER.test(a.publisherId)) {
    const slots: Partial<Record<AdPlacement, string>> = {};
    for (const [k, v] of Object.entries(a.slots ?? {}))
      if (typeof v === 'string' && SLOT.test(v)) slots[k as AdPlacement] = v;
    adsense = { publisherId: a.publisherId, slots };
  }
  return { cards, adsense };
}

// ---------------------------------------------------------------- store
let ads: Ads | null = null;
let loadedFor: string | null = null;
const subs = new Set<() => void>();
const emit = () => {
  for (const s of subs) s();
};

/** Loads the member's ads (once per member and page load; `force`: again, for the re-check). */
export async function loadAds(userId: string, force = false): Promise<void> {
  if (loadedFor === userId && !force) return;
  loadedFor = userId;
  try {
    const r = await api<AdsResult>(MEMBER8_API.ads);
    if (loadedFor !== userId) return;
    ads = clean(r);
  } catch {
    if (loadedFor !== userId) return;
    ads = null;
  }
  emit();
}
export function clearAds(): void {
  loadedFor = null;
  if (ads === null) return;
  ads = null;
  emit();
}
export function useAdsData(): Ads | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => ads,
  );
}

// ---------------------------------------------------------------- page views and slot picking
let seen = new Set<string>();
let order = new Map<AdPlacement, SponsoredCard[]>();
/** A new page view: impressions may be counted again, and cards are drawn again. */
export function newAdPageView(): void {
  seen = new Set();
  order = new Map();
}

/** Weighted shuffle (each card drawn with probability proportional to its weight), stable for the page view. */
function orderFor(placement: AdPlacement, cards: SponsoredCard[]): SponsoredCard[] {
  const known = order.get(placement);
  if (known) return known;
  const list = cards
    .filter((c) => c.placements.includes(placement))
    .map((c) => ({ c, k: Math.random() ** (1 / c.weight) }))
    .sort((a, b) => b.k - a.k)
    .map((x) => x.c);
  order.set(placement, list);
  return list;
}
export function cardFor(a: Ads, placement: AdPlacement, slot: number): SponsoredCard | null {
  const list = orderFor(placement, a.cards);
  return list.length ? (list[slot % list.length] ?? null) : null;
}
/** What a slot shows: a sponsored card, an AdSense unit (alternating when both exist), or nothing. */
export function slotContent(
  a: Ads,
  placement: AdPlacement,
  slot: number,
): { card: SponsoredCard } | { adsense: { publisherId: string; slot: string } } | null {
  const card = cardFor(a, placement, slot);
  const unit = a.adsense?.slots[placement];
  if (unit && a.adsense && (!card || slot % 2 === 1))
    return { adsense: { publisherId: a.adsense.publisherId, slot: unit } };
  return card ? { card } : null;
}
export function hasAdsFor(a: Ads | null, placement: AdPlacement): boolean {
  return Boolean(a && (a.cards.some((c) => c.placements.includes(placement)) || a.adsense?.slots[placement]));
}

// ---------------------------------------------------------------- events
/** Counted by the API without any member identity. Best effort; never blocks the page. */
export function sendAdEvent(cardId: string, kind: AdEventBody['kind'], placement: AdPlacement): void {
  const body: AdEventBody = { cardId, kind, placement };
  try {
    void fetch(MEMBER8_API.adEvent, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  } catch {
    // Ignore.
  }
}
/** One impression per card per page view. */
export function countImpression(cardId: string, placement: AdPlacement): void {
  if (seen.has(cardId)) return;
  seen.add(cardId);
  sendAdEvent(cardId, 'impression', placement);
}

// ---------------------------------------------------------------- AdSense script
export const ADSENSE_SRC = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
let scriptFor: string | null = null;
/** The member signed in when Google's script was added (it acts with that member's session). */
let scriptUser: string | null = null;
const scriptSubs = new Set<() => void>();
/**
 * Adds Google's AdSense tag once per page load. The tag shows Google's consent message (Privacy & messaging)
 * before any personalised ad; nothing else from Google is loaded by the app.
 */
export function loadAdsense(publisherId: string): boolean {
  if (scriptFor) return scriptFor === publisherId;
  if (holds > 0) return false;
  if (!PUBLISHER.test(publisherId) || typeof document === 'undefined' || !documentAllowsAdsense())
    return false;
  const s = document.createElement('script');
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.src = `${ADSENSE_SRC}?client=${encodeURIComponent(publisherId)}`;
  s.dataset.zephyr = 'adsense';
  document.head.appendChild(s);
  scriptFor = publisherId;
  scriptUser = sessionUserId();
  for (const cb of scriptSubs) cb();
  return true;
}
export const adsenseLoaded = (): boolean => scriptFor !== null;

/**
 * Phase 8: while something secret may appear in this document (a gallery being created, its one-time passcode),
 * Google's script must not be added: `holdAdsense()` until the returned release runs. Units waiting to load try
 * again on release.
 */
let holds = 0;
const holdSubs = new Set<() => void>();
export function holdAdsense(): () => void {
  holds += 1;
  for (const cb of holdSubs) cb();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    for (const cb of holdSubs) cb();
  };
}
export const adsenseHeld = (): boolean => holds > 0;
export function useAdsenseHeld(): boolean {
  return useSyncExternalStore(
    (cb) => {
      holdSubs.add(cb);
      return () => holdSubs.delete(cb);
    },
    adsenseHeld,
    adsenseHeld,
  );
}

/**
 * Before any full page load that ends this document's session while Google's script is in it: ask the server to
 * clear the site's storage (`Clear-Site-Data: "cache", "storage"`) and the AdSense cookies, so nothing the script
 * wrote (Cache Storage, local or session storage, IndexedDB) survives. When a session ends in a document without
 * the script (`sessionEnd`), ask the same with `ifSeen`: the server clears only if this browser may have run the
 * script (its HttpOnly cookie says so), since an earlier document may have. Same-origin POST; best effort, and
 * the page load goes ahead after at most a second and a half either way.
 */
export function resetSiteForAdsense(
  o: { sessionEnd: boolean } = { sessionEnd: false },
): Promise<void> | null {
  if (typeof fetch === 'undefined') return null;
  const loaded = adsenseLoaded();
  if (!loaded && !o.sessionEnd) return null;
  try {
    return fetch(MEMBER8_API.adReset, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: loaded ? '{}' : '{"ifSeen":true}',
    }).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return null;
  }
}
setBeforeFullLoad(resetSiteForAdsense);
/** The member Google's script was loaded for (null if not loaded). */
export const adsenseUser = (): string | null => scriptUser;
export function useAdsenseLoaded(): boolean {
  return useSyncExternalStore(
    (cb) => {
      scriptSubs.add(cb);
      return () => scriptSubs.delete(cb);
    },
    adsenseLoaded,
    adsenseLoaded,
  );
}

/** Test helper. `wide`: whether this document got the AdSense CSP (its marker). */
export function __resetAdsForTest(path = '/', wide = true): void {
  ads = null;
  loadedFor = null;
  scriptFor = null;
  scriptUser = null;
  holds = 0;
  docPath = path;
  docMarker = { wide };
  setBeforeFullLoad(resetSiteForAdsense);
  for (const cb of scriptSubs) cb();
  newAdPageView();
  for (const el of document.querySelectorAll('script[data-zephyr="adsense"]')) el.remove();
  emit();
}
