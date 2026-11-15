import type { AdPlacement } from '@zephyr/shared/client';
import { type ReactNode, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router';
import {
  type Ads,
  adsAllowedOn,
  adsenseUser,
  clearAds,
  countImpression,
  documentAllowsAdsense,
  hasAdsFor,
  loadAds,
  loadAdsense,
  mayReloadForAdsense,
  newAdPageView,
  planHasAds,
  type SponsoredCard,
  sendAdEvent,
  slotContent,
  useAdsData,
  useAdsenseLoaded,
} from '../../lib/ads';
import { STATUS_POLL_MS } from '../../lib/appStatus';
import { refreshLibraries, useActiveLibrary, useLibraries } from '../../lib/libraryContext';
import { useSession } from '../../lib/session';
import { browser, onOtherTabLibrariesChange } from '../../lib/sessionGuard';

/** Free member in their own library (not a team library, not pending deletion). */
function useAdsAccount(): boolean {
  const { user } = useSession();
  const lib = useActiveLibrary();
  return Boolean(user && !user.pendingDeletion && planHasAds(user.plan) && lib.self);
}

/**
 * The ads this member may see in this document. AdSense is dropped unless the member belongs to no team library
 * (their session reaches every library they're in; the API already leaves it out, this mirrors it) and this
 * document was loaded on an ad page (the only documents the Worker gives the AdSense CSP).
 */
function useSoloLibrary(): boolean {
  const libs = useLibraries();
  return libs !== null && libs.length === 1;
}
function useVisibleAds(): Ads | null {
  const ads = useAdsData();
  const solo = useSoloLibrary();
  if (!ads?.adsense) return ads;
  return solo && documentAllowsAdsense() ? ads : { ...ads, adsense: null };
}

/** The member's ads when this page may show them, else null (unmounts every unit on other pages). */
export function useAds(): Ads | null {
  const account = useAdsAccount();
  const { pathname } = useLocation();
  const ads = useVisibleAds();
  return account && adsAllowedOn(pathname) ? ads : null;
}
/** True when the member has ads for this placement, whatever the page (keeps grid layout stable). */
export function useAdsReady(placement: AdPlacement): boolean {
  const account = useAdsAccount();
  const ads = useVisibleAds();
  return account && hasAdsFor(ads, placement);
}

/**
 * Mounted once under the session: loads ads for a Free member's own library and starts a new "page view" on
 * each navigation (impressions count again). Once Google's AdSense script is in the page it reloads the page as
 * soon as the member it was loaded for is gone (signed out, session ended, another member) or no longer gets ads
 * (an upgrade here, in another tab or by staff, or a team library), so the script never carries over; the reload
 * first has the server clear the site's storage (sessionGuard's before-full-load hook). While the script is
 * loaded it also re-reads the session, the member's libraries and their ads every 2 minutes, when the tab comes
 * back and when another tab reports a team change, to notice a plan change or a team joined elsewhere.
 */
export function AdsBoot() {
  const { user, refresh } = useSession();
  const account = useAdsAccount();
  const ads = useVisibleAds();
  const raw = useAdsData();
  const solo = useSoloLibrary();
  const loaded = useAdsenseLoaded();
  const { pathname } = useLocation();
  const userId = user?.id ?? null;
  useEffect(() => {
    if (account && userId) void loadAds(userId);
    else clearAds();
  }, [account, userId]);
  // undefined: the first session check is still in flight.
  const known = user !== undefined;
  useEffect(() => {
    if (!loaded || !known) return;
    if (!account || userId === null || userId !== adsenseUser()) browser.reload();
  }, [loaded, known, account, userId]);
  // The script was dropped from the page for any reason (AdSense turned off for this member, a team joined).
  useEffect(() => {
    if (loaded && ads && !ads.adsense) browser.reload();
  }, [loaded, ads]);
  // A plan change or a team joined elsewhere (another tab or device, staff): while the script is loaded, re-read
  // the session, the libraries and the ads (fresh, not the copy loaded with the page). Any of them can drop
  // AdSense, which reloads the page above.
  useEffect(() => {
    if (!loaded || !userId) return;
    const recheck = () => {
      void refresh();
      void refreshLibraries();
      void loadAds(userId, true);
    };
    const t = setInterval(recheck, STATUS_POLL_MS);
    const vis = () => {
      if (document.visibilityState === 'visible') recheck();
    };
    document.addEventListener('visibilitychange', vis);
    const off = onOtherTabLibrariesChange(recheck);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
      off();
    };
  }, [loaded, userId, refresh]);
  // This document was loaded on an ad page with the strict policy (the AdSense cookie came with this page's first
  // ads request), and there's AdSense to show: load the page fresh once, so the Worker can send the AdSense policy.
  const adsenseHere = Boolean(account && solo && raw?.adsense && adsAllowedOn(pathname));
  useEffect(() => {
    if (!loaded && adsenseHere && !documentAllowsAdsense() && mayReloadForAdsense()) browser.reload();
  }, [loaded, adsenseHere]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page view on every navigation
  useEffect(() => {
    newAdPageView();
  }, [pathname]);
  return null;
}

/**
 * Wraps the routed pages. While Google's AdSense script is in the page, a page without ads (editor, viewer,
 * sharing, billing, settings, sign-in…) is never rendered in this document: it's opened with a full page load
 * instead, which drops the script, and the Worker serves it with the strict CSP.
 */
export function AdsRouteGate({ children }: { children: ReactNode }) {
  const loaded = useAdsenseLoaded();
  const loc = useLocation();
  const leave = loaded && !adsAllowedOn(loc.pathname);
  const to = `${loc.pathname}${loc.search}${loc.hash}`;
  // The same member goes on in the next document, so the site's storage isn't cleared for this one.
  useEffect(() => {
    if (leave) browser.assign(to, { keepStorage: true });
  }, [leave, to]);
  if (leave) return <div className="page-loading" aria-busy="true" />;
  return <>{children}</>;
}

/** Sends one impression per card per page view once at least half of it has been visible for a second. */
function useImpression(cardId: string, placement: AdPlacement) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        if (e?.isIntersecting && e.intersectionRatio >= 0.5) {
          if (!timer)
            timer = setTimeout(() => {
              timer = null;
              countImpression(cardId, placement);
              io.disconnect();
            }, 1000);
        } else stop();
      },
      { threshold: [0, 0.5, 1] },
    );
    io.observe(el);
    return () => {
      stop();
      io.disconnect();
    };
  }, [cardId, placement]);
  return ref;
}

export function SponsoredCardView({
  card,
  placement,
  layout = 'column',
}: {
  card: SponsoredCard;
  placement: AdPlacement;
  layout?: 'row' | 'column';
}) {
  const ref = useImpression(card.id, placement);
  const click = () => sendAdEvent(card.id, 'click', placement);
  return (
    <aside
      ref={ref}
      className={`sponsored sponsored--${layout}`}
      aria-label="Sponsored"
      data-ad-card={card.id}
    >
      <a
        className="sponsored__main"
        href={card.url}
        target="_blank"
        rel="noopener noreferrer sponsored"
        onClick={click}
        onAuxClick={(e) => {
          if (e.button === 1) click();
        }}
      >
        {card.imageUrl && (
          <span className="sponsored__media">
            <img src={card.imageUrl} alt="" loading="lazy" decoding="async" />
          </span>
        )}
        <span className="sponsored__text">
          <span className="sponsored__label">Sponsored</span>
          <span className="sponsored__advertiser">{card.advertiser}</span>
          <strong className="sponsored__headline">{card.headline}</strong>
          {card.body && <span className="sponsored__body">{card.body}</span>}
        </span>
      </a>
      <Link to="/plans" className="sponsored__upsell">
        Go ad-free with Pro
      </Link>
    </aside>
  );
}

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

/** One AdSense unit. Loads Google's tag (with its consent message) the first time a unit is shown. */
export function AdsenseUnit({ publisherId, slot }: { publisherId: string; slot: string }) {
  const ins = useRef<HTMLModElement>(null);
  useEffect(() => {
    if (!loadAdsense(publisherId) || !ins.current) return;
    try {
      window.adsbygoogle = window.adsbygoogle ?? [];
      window.adsbygoogle.push({});
    } catch {
      // Blocked or not ready: the unit stays empty.
    }
  }, [publisherId]);
  return (
    <aside className="adsense" aria-label="Advertisement">
      <span className="adsense__head">
        <span className="adsense__label">Ad</span>
        <Link to="/plans" className="adsense__upsell">
          Remove ads
        </Link>
      </span>
      <ins
        ref={ins}
        className="adsbygoogle adsense__unit"
        data-ad-client={publisherId}
        data-ad-slot={slot}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </aside>
  );
}

/** One ad position: a sponsored card or an AdSense unit, or nothing on pages and plans without ads. */
export function AdSlot({
  placement,
  slot = 0,
  layout,
}: {
  placement: AdPlacement;
  slot?: number;
  layout?: 'row' | 'column';
}) {
  const ads = useAds();
  if (!ads) return null;
  const content = slotContent(ads, placement, slot);
  if (!content) return null;
  if ('card' in content)
    return <SponsoredCardView card={content.card} placement={placement} layout={layout} />;
  return <AdsenseUnit publisherId={content.adsense.publisherId} slot={content.adsense.slot} />;
}
