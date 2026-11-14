import type { AdPlacement } from '@zephyr/shared/client';
import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router';
import {
  type Ads,
  adsAllowedOn,
  adsenseLoaded,
  clearAds,
  countImpression,
  hasAdsFor,
  loadAds,
  loadAdsense,
  newAdPageView,
  planHasAds,
  type SponsoredCard,
  sendAdEvent,
  slotContent,
  useAdsData,
} from '../../lib/ads';
import { useActiveLibrary } from '../../lib/libraryContext';
import { useSession } from '../../lib/session';
import { browser } from '../../lib/sessionGuard';

/** Free member in their own library (not a team library, not pending deletion). */
function useAdsAccount(): boolean {
  const { user } = useSession();
  const lib = useActiveLibrary();
  return Boolean(user && !user.pendingDeletion && planHasAds(user.plan) && lib.self);
}

/** The member's ads when this page may show them, else null (unmounts every unit on other pages). */
export function useAds(): Ads | null {
  const account = useAdsAccount();
  const { pathname } = useLocation();
  const ads = useAdsData();
  return account && adsAllowedOn(pathname) ? ads : null;
}
/** True when the member has ads for this placement, whatever the page (keeps grid layout stable). */
export function useAdsReady(placement: AdPlacement): boolean {
  const account = useAdsAccount();
  const ads = useAdsData();
  return account && hasAdsFor(ads, placement);
}

/**
 * Mounted once under the session: loads ads for a Free member's own library, starts a new "page view" on each
 * navigation (impressions count again), and reloads the page when the member is no longer eligible after the
 * AdSense script was loaded (an upgrade to a paid plan), so Google's script doesn't stay in the page.
 * Sign-out, an account change and a library switch already reload (sessionGuard / switchLibrary).
 */
export function AdsBoot() {
  const { user } = useSession();
  const account = useAdsAccount();
  const { pathname } = useLocation();
  const userId = user?.id ?? null;
  useEffect(() => {
    if (account && userId) void loadAds(userId);
    else clearAds();
  }, [account, userId]);
  // Only while still signed in: sign-out and suspension navigate away themselves.
  const signedIn = Boolean(user);
  useEffect(() => {
    if (signedIn && !account && adsenseLoaded()) browser.reload();
  }, [signedIn, account]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page view on every navigation
  useEffect(() => {
    newAdPageView();
  }, [pathname]);
  return null;
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
