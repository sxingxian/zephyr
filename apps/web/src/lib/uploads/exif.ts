import type { PhotoMetadata } from '@zephyr/shared/client';

/**
 * Tags Zephyr reads. Location is never read: the GPS block is switched off and no GPS tag is picked, so the
 * coordinates stay inside the original file only (docs/phase-3.md).
 */
export const EXIF_PICK = [
  'Make',
  'Model',
  'LensModel',
  'Lens',
  'DateTimeOriginal',
  'CreateDate',
  'OffsetTimeOriginal',
  'OffsetTime',
  'FNumber',
  'ExposureTime',
  'ISO',
  'ISOSpeedRatings',
  'FocalLength',
  'Orientation',
  'ExifImageWidth',
  'ExifImageHeight',
  'ImageWidth',
  'ImageHeight',
] as const;

export const EXIF_OPTIONS = {
  gps: false,
  interop: false,
  ifd1: false,
  xmp: false,
  icc: false,
  iptc: false,
  jfif: false,
  ihdr: false,
  makerNote: false,
  userComment: false,
  translateValues: false,
  reviveValues: false,
  sanitize: true,
  mergeOutput: true,
  pick: [...EXIF_PICK],
} as const;

type Raw = Record<string, unknown>;
const str = (v: unknown, max = 120): string | undefined => {
  if (typeof v !== 'string') return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from camera strings
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s ? s.slice(0, max) : undefined;
};
const num = (v: unknown): number | undefined => {
  const n = Array.isArray(v) ? Number(v[0]) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const int = (v: unknown, max: number): number | undefined => {
  const n = num(v);
  return n !== undefined && n <= max ? Math.round(n) : undefined;
};

/** Local offset ("+08:00") the browser would use at that wall-clock time (fallback when the camera saved none). */
function localOffset(y: number, mo: number, d: number, h: number, mi: number): string {
  const mins = -new Date(y, mo - 1, d, h, mi).getTimezoneOffset();
  const sign = mins >= 0 ? '+' : '-';
  const a = Math.abs(mins);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** EXIF "2026:10:24 15:42:10" plus an optional "+08:00" offset → ISO 8601 with offset, or undefined. */
export function exifDateToIso(value: unknown, offset?: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value !== 'string') return undefined;
  const m = value.trim().match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s = '00'] = m.slice(1).map((x) => x ?? '00');
  const Y = Number(y);
  if (Y < 1900 || Y > 2100 || Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31)
    return undefined;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return undefined;
  const off =
    typeof offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(offset.trim())
      ? offset.trim()
      : localOffset(Y, Number(mo), Number(d), Number(h), Number(mi));
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${off}`;
}

/** Maps exifr output to the contract's metadata, dropping anything malformed. */
export function toMetadata(t: Raw | null | undefined): PhotoMetadata {
  if (!t) return {};
  const md: PhotoMetadata = {};
  const make = str(t.Make, 80);
  const model = str(t.Model, 120);
  if (make) md.cameraMake = make;
  if (model) md.cameraModel = model;
  const lens = str(t.LensModel) ?? str(t.Lens);
  if (lens) md.lens = lens;
  const taken = exifDateToIso(t.DateTimeOriginal ?? t.CreateDate, t.OffsetTimeOriginal ?? t.OffsetTime);
  if (taken) md.takenAt = taken;
  const f = num(t.FNumber);
  if (f && f <= 128) md.aperture = Math.round(f * 10) / 10;
  const exp = num(t.ExposureTime);
  if (exp && exp <= 3600) md.exposureSeconds = exp;
  const iso = int(t.ISO ?? t.ISOSpeedRatings, 1_000_000);
  if (iso) md.iso = iso;
  const focal = num(t.FocalLength);
  if (focal && focal <= 5000) md.focalLengthMm = Math.round(focal * 10) / 10;
  const o = int(t.Orientation, 8);
  if (o && o >= 1) md.orientation = o;
  const w = int(t.ExifImageWidth ?? t.ImageWidth, 100_000);
  const h = int(t.ExifImageHeight ?? t.ImageHeight, 100_000);
  if (w && h) {
    md.width = w;
    md.height = h;
  }
  return md;
}

/** Reads camera metadata (never location) from the start of the file. Failures just mean no metadata. */
export async function readMetadata(file: Blob): Promise<PhotoMetadata> {
  try {
    const { default: exifr } = await import('exifr');
    const tags = (await exifr.parse(file, { ...EXIF_OPTIONS, pick: [...EXIF_PICK] })) as Raw | undefined;
    return toMetadata(tags);
  } catch {
    return {};
  }
}
