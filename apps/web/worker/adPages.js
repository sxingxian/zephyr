// The member app's pages that may show ads (phase 8). One list, used by the app (where ad units mount, and
// where a page with Google's AdSense script loaded may stay without a full page load), the app Worker (the only
// documents that can get the AdSense CSP variant) and scripts/csp.mjs (which checks the list stays narrow).
// Plain JS so the Worker, the Node build script and the app can all import it as is.

/** Library browsing pages only. Everything else (editor, viewer, sharing, billing, settings, sign-in…) has none. */
export const AD_PAGE_PATTERNS = Object.freeze([
  /^\/$/,
  /^\/favourites$/,
  /^\/albums(\/[^/]+)?$/,
  /^\/people(\/[^/]+)?$/,
  /^\/scenes(\/[^/]+)?$/,
  /^\/ai\/queue$/,
]);

/** True for a page (URL pathname, no query) where ads may show. */
export function adsAllowedOn(pathname) {
  return typeof pathname === 'string' && AD_PAGE_PATTERNS.some((re) => re.test(pathname));
}

/**
 * The AdSense cookie (packages/shared ADS_DOC_COOKIE): set by the API's GET /api/v1/ads only for a member shown
 * AdSense (HttpOnly, 15 minutes). The Worker widens a document's CSP only when the request carries it.
 */
export const ADS_DOC_COOKIE = '__Host-zads';
/**
 * Server-Timing entry the Worker adds to a document it served with the AdSense CSP. The app reads it from its own
 * navigation entry (`performance.getEntriesByType('navigation')[0].serverTiming`) to know whether Google's script
 * may load in this document.
 */
export const ADS_DOC_TIMING = 'zads';
