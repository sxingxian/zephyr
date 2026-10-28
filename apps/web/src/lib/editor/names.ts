/** "IMG_2041.CR2" → "IMG_2041-edited.jpg", with anything unsafe for a file name removed. */
export function exportName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '') || 'photo';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters
  const safe = base.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').slice(0, 120);
  return `${safe}-edited.jpg`;
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
