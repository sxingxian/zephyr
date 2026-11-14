import {
  type AdEventBody,
  type AdPlacement,
  type AdsResult,
  MEMBER8_API,
  PLANS,
  type PlanId,
} from '@zephyr/shared/client';
import { useSyncExternalStore } from 'react';
import { api } from './api';

/**
 * Phase 8: ads for Free members, in their own library only (a team library never shows ads).
 *
 * - Sponsored cards come from `/api/v1/ads` and are rendered by the app (first-party, same-origin images).
 * - Google AdSense loads only when the API says so (`adsense` present), and only once a unit is actually shown
 *   on a page where ads are allowed. The AdSense tag brings Google's own consent message (Privacy & messaging);
 *   no other consent script is loaded. The app Worker widens the CSP for Google's hosts only while AdSense is on.
 * - Ads are never shown in the editor, the photo viewer, sharing, billing, settings, team or sign-in pages.
 *   Navigating there unmounts every ad unit; the script itself stays loaded for that page view, so a plan
 *   upgrade (or an account or library change) does a full reload to drop it.
 */
export type SponsoredCard = AdsResult['cards'][number];
export interface Ads {
  cards: SponsoredCard[];
  adsense: AdsResult['adsense'];
}

/** Pages that browse the library. Everything else (editor, viewer, sharing, billing, settings…) has no ads. */
const ALLOWED: readonly RegExp[] = [
  /^\/$/,
  /^\/favourites$/,
  /^\/albums(\/[^/]+)?$/,
  /^\/people(\/[^/]+)?$/,
  /^\/scenes(\/[^/]+)?$/,
  /^\/ai\/queue$/,
];
export function adsAllowedOn(pathname: string): boolean {
  return ALLOWED.some((re) => re.test(pathname));
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

/** Loads the member's ads (once per member and page load). */
export async function loadAds(userId: string): Promise<void> {
  if (loadedFor === userId) return;
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
/**
 * Adds Google's AdSense tag once per page load. The tag shows Google's consent message (Privacy & messaging)
 * before any personalised ad; nothing else from Google is loaded by the app.
 */
export function loadAdsense(publisherId: string): boolean {
  if (scriptFor) return scriptFor === publisherId;
  if (!PUBLISHER.test(publisherId) || typeof document === 'undefined') return false;
  const s = document.createElement('script');
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.src = `${ADSENSE_SRC}?client=${encodeURIComponent(publisherId)}`;
  s.dataset.zephyr = 'adsense';
  document.head.appendChild(s);
  scriptFor = publisherId;
  return true;
}
export const adsenseLoaded = (): boolean => scriptFor !== null;

/** Test helper. */
export function __resetAdsForTest(): void {
  ads = null;
  loadedFor = null;
  scriptFor = null;
  newAdPageView();
  for (const el of document.querySelectorAll('script[data-zephyr="adsense"]')) el.remove();
  emit();
}
