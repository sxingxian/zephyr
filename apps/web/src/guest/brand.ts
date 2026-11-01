import { BRAND_ACCENTS, type GuestBrand } from '@zephyr/shared/client';

/**
 * A member's accent is used only when it is one of the contrast-checked BRAND_ACCENTS (white text on it
 * passes WCAG AA). Anything else is ignored, so nothing a member types can ever reach CSS.
 */
export function safeAccent(accent: string | null | undefined): string | null {
  if (!accent) return null;
  const up = accent.toUpperCase();
  return (BRAND_ACCENTS as readonly string[]).find((a) => a.toUpperCase() === up) ?? null;
}

/** The member's branding is on when the gallery carries a logo or an accent; the mascot steps aside then. */
export function brandingOn(brand: GuestBrand): boolean {
  return Boolean(brand.logoUrl) || safeAccent(brand.accent) !== null;
}

/** Two-letter monogram for a studio without a logo ("Mei Lin Photography" → "ML"). */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : (words[0] ?? '').slice(0, 2);
  return [...letters].slice(0, 2).join('').toUpperCase() || 'Z';
}

/** Same-origin URLs only: a brand logo URL from the API must be a path on this host. */
export function sameOriginUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, window.location.origin);
    return u.origin === window.location.origin && u.pathname.startsWith('/api/')
      ? u.pathname + u.search
      : null;
  } catch {
    return null;
  }
}
