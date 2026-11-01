import type { GuestBrand } from '@zephyr/shared/client';
import { Wordmark } from '@zephyr/ui';
import type { CSSProperties, ReactNode } from 'react';
import { monogram, safeAccent, sameOriginUrl } from './brand';
import { ReportLink } from './Report';

/** CSS variables for the member's accent (only ever one of BRAND_ACCENTS). */
export function accentStyle(brand: GuestBrand | null): CSSProperties | undefined {
  const acc = safeAccent(brand?.accent);
  return acc ? ({ '--g-acc': acc, '--g-on': '#FFFFFF' } as CSSProperties) : undefined;
}

/** The studio's logo, or a monogram tile in their accent. */
export function StudioBadge({ brand, size = 40 }: { brand: GuestBrand; size?: number }) {
  const logo = sameOriginUrl(brand.logoUrl);
  if (logo)
    return (
      <img
        className="g-badge g-badge--logo"
        src={logo}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
      />
    );
  return (
    <span
      className="g-badge"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      aria-hidden="true"
    >
      {monogram(brand.studioName)}
    </span>
  );
}

export function GuestFooter() {
  return (
    <footer className="g-footer">
      <span>
        Shared privately with <Wordmark size={14} />
      </span>
      <ReportLink />
    </footer>
  );
}

/** Centred card layout for the passcode and "ended" screens. */
export function CardScreen({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="g-screen" style={style}>
      <main className="g-screen__main" id="main">
        <div className="g-card">{children}</div>
      </main>
      <GuestFooter />
    </div>
  );
}

const DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : DATE.format(d);
}

/** "14:32" for a countdown in seconds. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
