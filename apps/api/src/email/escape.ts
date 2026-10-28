/** Escapes text for HTML element content and quoted attribute values. */
export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Strips line breaks and control characters (for subjects and one-line plain text). */
export const oneLine = (s: string): string => s.replace(/\p{Cc}+/gu, ' ').trim();
