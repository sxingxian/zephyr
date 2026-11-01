/**
 * Guest download file names. Never the member's own file name (it can carry private details): the gallery
 * name and the photo's position, cleaned with the same rules as the editor's export names (phase 4,
 * apps/web/src/lib/editor/names.ts cleanExportName): no path, control, bidirectional or invisible format
 * characters, Windows device names prefixed, at most 120 code points before the extension.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters
const UNSAFE = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*؜​-‏‪-‮⁦-⁩﻿]+/g;
const MAX_BASE = 120;
/** Invisible format characters, line and paragraph separators, and Hangul fillers. */
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}ᅟᅠㅤﾠ]+/gu;
/** Half of a surrogate pair with no partner (not valid text; matched without the u flag on purpose). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** Names Windows reserves for devices, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

/** A file-name stem made safe, cut to `max` code points (never splitting a character). */
export function cleanBase(s: string, max = MAX_BASE): string {
  const cleaned = s
    .replace(LONE_SURROGATE, '')
    .normalize('NFC')
    .replace(UNSAFE, '_')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  const cut = [...cleaned]
    .slice(0, Math.max(1, max))
    .join('')
    .replace(/[\s.]+$/, '');
  return RESERVED.test(cut) ? `_${cut}` : cut;
}

/**
 * "Smith Wedding 007-web.jpg": the gallery's name and the photo's 1-based position (zero-padded to 3
 * digits), `-web` or `-full`. The whole stem stays within 120 code points; the position is never cut off.
 */
export function guestDownloadName(galleryName: string, position: number, size: 'web' | 'full'): string {
  const n = String(Math.max(0, Math.floor(position)) + 1).padStart(3, '0');
  const suffix = ` ${n}-${size}`;
  const base = cleanBase(galleryName, MAX_BASE - [...suffix].length) || 'Photo';
  const stem = `${base}${suffix}`;
  return `${RESERVED.test(stem) ? `_${stem}` : stem}.jpg`;
}
