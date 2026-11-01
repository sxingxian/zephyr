import type { GuestGalleryInfo } from '@zephyr/shared/client';
import { Mascot } from '@zephyr/ui';
import { brandingOn } from './brand';
import { accentStyle, CardScreen, formatDate, StudioBadge } from './Chrome';

/** An expired or revoked gallery. The server may send no name or studio for an ended link, so neither is assumed. */
export function Ended({ info }: { info: GuestGalleryInfo }) {
  const brand = info.brand ?? { studioName: '', accent: null, logoUrl: null };
  const branded = brandingOn(brand);
  const name = info.name?.trim();
  const studio = brand.studioName?.trim();
  const when = info.expiresAt ? formatDate(info.expiresAt) : null;
  const past = info.expiresAt ? Date.parse(info.expiresAt) <= Date.now() : false;
  const what = name ? `The link to “${name}”` : 'This link';
  const ending = past && when ? `${what} stopped working on ${when}.` : `${what} has been turned off.`;
  return (
    <CardScreen style={accentStyle(brand)}>
      {branded ? (
        <StudioBadge brand={brand} size={88} />
      ) : (
        <Mascot
          pose="nap"
          width={170}
          tile={{ background: 'var(--m-mist, #E9EDF3)', height: 180, radius: 40 }}
        />
      )}
      <h1 className="g-card__title">This gallery has ended</h1>
      <p className="g-lede">
        {ending} If you still need the photos, ask {studio || 'the person who shared it'} for a new link.
      </p>
    </CardScreen>
  );
}

/** Unknown, mistyped or malformed links. Says nothing about whether a gallery ever existed. */
export function BadLink() {
  return (
    <CardScreen>
      <Mascot
        pose="ponder"
        width={170}
        tile={{ background: 'var(--m-mist, #E9EDF3)', height: 180, radius: 40 }}
      />
      <h1 className="g-card__title">This link doesn’t work</h1>
      <p className="g-lede">
        It may have been typed incorrectly, or the photographer turned it off. Ask them for a new link.
      </p>
    </CardScreen>
  );
}

/** Something went wrong loading the page (offline, server error). */
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <CardScreen>
      <Mascot
        pose="ponder"
        width={150}
        tile={{ background: 'var(--m-mist, #E9EDF3)', height: 160, radius: 36 }}
      />
      <h1 className="g-card__title">The gallery didn’t load</h1>
      <p className="g-lede">Check your connection, then try again.</p>
      <button type="button" className="z-btn z-btn--primary z-btn--lg g-acc-btn" onClick={onRetry}>
        <span>Try again</span>
      </button>
    </CardScreen>
  );
}
