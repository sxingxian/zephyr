const hasControlChars = (s: string) => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** Pages a successful sign-in should never bounce back to. */
const AUTH_PATHS = ['/sign-in', '/sign-up', '/join', '/welcome'];

/**
 * Returns a safe in-app path to go to after signing in, or '/' when the input is missing or unsafe.
 * Only same-origin relative paths are allowed: no schemes, no protocol-relative (//host) or backslash
 * tricks, no control characters, and nothing that would loop back to an auth page.
 */
export function safeReturnPath(
  input: string | null | undefined,
  origin = 'https://zephyrapp.midnightpoetry.studio',
): string {
  if (!input || input.length > 512) return '/';
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('\\') || hasControlChars(input))
    return '/';
  let url: URL;
  try {
    url = new URL(input, origin);
  } catch {
    return '/';
  }
  if (url.origin !== origin) return '/';
  // A path that resolves to `//host…` (e.g. `/.//evil.com`) would read as protocol-relative wherever it's used
  // as a URL later.
  if (url.pathname.startsWith('//')) return '/';
  if (AUTH_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return '/';
  if (url.pathname.startsWith('/api')) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}
