/**
 * Characters never allowed in a download name: path separators and characters Windows forbids, control
 * characters, and invisible bidirectional or zero-width marks (which can make "photo[RLO]gpj.exe" look like a
 * JPEG).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters
const UNSAFE = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g;
const MAX_BASE = 120;
function cleanBase(s: string): string {
  return s
    .normalize('NFC')
    .replace(UNSAFE, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, MAX_BASE)
    .replace(/[\s.]+$/, '');
}

/** "IMG_2041.CR2" → "IMG_2041-edited.jpg", with anything unsafe for a file name removed. */
export function exportName(filename: string): string {
  const base = cleanBase(filename.replace(/\.[^.]+$/, '')) || 'photo';
  return `${base}-edited.jpg`;
}

/**
 * A name the member typed for an export, made safe: unsafe characters replaced, trimmed, at most 120
 * characters before the extension, and always ending in .jpg (or .jpeg if they typed that). Falls back to
 * the photo's own export name when nothing usable is left.
 */
export function cleanExportName(typed: string, sourceFilename: string): string {
  const t = typed.trim();
  const m = /\.(jpe?g)$/i.exec(t);
  const ext = m ? `.${(m[1] as string).toLowerCase()}` : '.jpg';
  const base = cleanBase(m ? t.slice(0, -m[0].length) : t);
  return base ? `${base}${ext}` : exportName(sourceFilename);
}

/** A problem with an export the member can act on; its message is shown as it is. */
export class ExportProblem extends Error {
  override name = 'ExportProblem';
}

/**
 * Batch downloads build a .zip. Without a way to stream it to disk, the whole file is held in memory, so it
 * is capped: at most 1.5 GB estimated, and at most 200 photos at full size.
 */
export const ZIP_MEMORY_LIMIT = 1_500_000_000;
export const ZIP_FULL_SIZE_LIMIT = 200;
export function zipTooBig(estimatedBytes: number, count: number, fullSize: boolean): string | null {
  if (estimatedBytes > ZIP_MEMORY_LIMIT || (fullSize && count > ZIP_FULL_SIZE_LIMIT))
    return 'That’s too much to zip in this browser. Choose “Long edge 2048”, or export fewer photos at a time.';
  return null;
}

/** Unique names inside a zip. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = n.toLowerCase();
    const c = seen.get(k) ?? 0;
    seen.set(k, c + 1);
    return c ? n.replace(/\.jpg$/i, ` (${c + 1}).jpg`) : n;
  });
}

/** Rough JPEG size estimate for the export dialog (bytes). */
export function estimateJpegBytes(pixels: number, quality: number): number {
  const bpp = 0.35 + 2.8 * Math.max(0, quality - 0.5) ** 1.6;
  return Math.round((pixels * bpp) / 8 + 20_000);
}
