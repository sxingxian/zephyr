import type { CropRect, CropSettings } from '@zephyr/shared/client';

/**
 * Crop and transform maths, shared by the live view, thumbnails and export.
 *
 * Spaces (all normalised to 0–1 over their own width and height):
 *   S  the decoded source (EXIF orientation already applied)
 *   O  after quarter turns and flips (size W′ × H′)
 *   C  after perspective correction (same size as O)
 *   T  after straightening, auto-zoomed so no empty corners show (same size as O)
 *   out the crop rectangle of T
 * `outputToSource` composes the whole chain into one projective 3×3 matrix, so the shader does a single
 * matrix multiply and divide per pixel.
 */
export type Mat3 = [number, number, number, number, number, number, number, number, number]; // row-major

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += (a[i * 3 + k] as number) * (b[k * 3 + j] as number);
      r[i * 3 + j] = s;
    }
  return r;
}
export function apply(m: Mat3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}
export function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return IDENTITY;
  const inv = 1 / det;
  return [
    A * inv,
    -(b * i - c * h) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * i - c * g) * inv,
    -(a * f - c * d) * inv,
    C * inv,
    -(a * h - b * g) * inv,
    (a * e - b * d) * inv,
  ];
}
const translate = (x: number, y: number): Mat3 => [1, 0, x, 0, 1, y, 0, 0, 1];
const scale = (x: number, y: number): Mat3 => [x, 0, 0, 0, y, 0, 0, 0, 1];

/** Homography mapping the unit square's corners (0,0),(1,0),(1,1),(0,1) to the quad p0..p3. */
export function squareToQuad(q: [number, number][]): Mat3 {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q as [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {
    return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1];
  }
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

export interface Size {
  width: number;
  height: number;
}

/** Size of the image after quarter turns (flips don't change it). */
export function orientedSize(src: Size, crop: CropSettings | undefined): Size {
  const q = crop?.quarterTurns ?? 0;
  return q % 2 ? { width: src.height, height: src.width } : { width: src.width, height: src.height };
}

/** O → S: undo flips, then quarter turns. */
function orientToSource(crop: CropSettings | undefined): Mat3 {
  let m: Mat3 = IDENTITY;
  // Flips happen after turns, so undo them first (O space).
  if (crop?.flipH) m = mul(m, [-1, 0, 1, 0, 1, 0, 0, 0, 1]);
  if (crop?.flipV) m = mul(m, [1, 0, 0, 0, -1, 1, 0, 0, 1]);
  const q = crop?.quarterTurns ?? 0;
  // A clockwise turn maps source (x, y) to oriented (1 − y, x); its inverse maps oriented (u, v) to (v, 1 − u).
  const turn: Mat3 = [0, 1, 0, -1, 0, 1, 0, 0, 1];
  let t: Mat3 = IDENTITY;
  for (let i = 0; i < q; i++) t = mul(t, turn);
  // m maps O→O(unflipped); then t maps O(unflipped)→S. Apply m first: S = t · m · p.
  return mul(t, m);
}

/** Largest scale-down of the frame that fits inside itself rotated by `deg` (no empty corners). */
export function straightenZoom(deg: number, size: Size): number {
  const a = Math.abs((deg * Math.PI) / 180);
  if (a < 1e-9) return 1;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const { width: w, height: h } = size;
  return Math.min(w / (w * c + h * s), h / (w * s + h * c));
}

/** C → O: the trapezoid the perspective correction samples from. ±100 insets one edge by 30 %. */
function perspectiveToOriented(crop: CropSettings | undefined): Mat3 {
  const v = (crop?.perspectiveV ?? 0) / 100;
  const h = (crop?.perspectiveH ?? 0) / 100;
  if (!v && !h) return IDENTITY;
  const k = 0.15;
  // Positive vertical straightens walls that lean in at the top (shot looking up): sample a narrower top.
  const top = Math.max(0, v) * k;
  const bottom = Math.max(0, -v) * k;
  const left = Math.max(0, -h) * k;
  const right = Math.max(0, h) * k;
  return squareToQuad([
    [top, left],
    [1 - top, right],
    [1 - bottom, 1 - right],
    [bottom, 1 - left],
  ]);
}

/** T → C: rotate by −angle about the centre and zoom out by the straighten factor, in pixel units. */
function straightenToPerspective(crop: CropSettings | undefined, size: Size): Mat3 {
  const deg = crop?.angle ?? 0;
  if (!deg) return IDENTITY;
  const s = straightenZoom(deg, size);
  const r = (-deg * Math.PI) / 180;
  const c = Math.cos(r);
  const n = Math.sin(r);
  const { width: w, height: h } = size;
  // normalised → pixels → centre → rotate·scale → back → normalised
  return mul(
    scale(1 / w, 1 / h),
    mul(
      translate(w / 2, h / 2),
      mul([c * s, -n * s, 0, n * s, c * s, 0, 0, 0, 1], mul(translate(-w / 2, -h / 2), scale(w, h))),
    ),
  );
}

export const FULL: CropRect = { x: 0, y: 0, w: 1, h: 1 };

/** out → T for a rectangle of T (normalised). */
const rectToT = (r: CropRect): Mat3 => [r.w, 0, r.x, 0, r.h, r.y, 0, 0, 1];

/** T → S: everything except the crop rectangle (used by the crop tool, which shows all of T). */
export function transformedToSource(crop: CropSettings | undefined, src: Size): Mat3 {
  const o = orientedSize(src, crop);
  return mul(orientToSource(crop), mul(perspectiveToOriented(crop), straightenToPerspective(crop, o)));
}

/** Output (0–1 over the crop) → source (0–1). `region` picks a sub-rectangle of the output (tiles). */
export function outputToSource(
  crop: CropSettings | undefined,
  src: Size,
  opts: { ignoreRect?: boolean; region?: CropRect } = {},
): Mat3 {
  const rect = opts.ignoreRect ? FULL : (crop?.rect ?? FULL);
  let m = mul(transformedToSource(crop, src), rectToT(rect));
  if (opts.region) m = mul(m, rectToT(opts.region));
  return m;
}

/** Pixel size of the cropped output at full resolution. */
export function outputSize(crop: CropSettings | undefined, src: Size, ignoreRect = false): Size {
  const o = orientedSize(src, crop);
  const r = ignoreRect ? FULL : (crop?.rect ?? FULL);
  return { width: Math.max(1, Math.round(o.width * r.w)), height: Math.max(1, Math.round(o.height * r.h)) };
}

/** Fit a size inside a long edge, keeping its aspect. */
export function fitLongEdge(s: Size, longEdge: number): Size {
  const k = Math.min(1, longEdge / Math.max(s.width, s.height));
  return { width: Math.max(1, Math.round(s.width * k)), height: Math.max(1, Math.round(s.height * k)) };
}

export const ASPECT_RATIOS: Record<string, number | null> = {
  original: null,
  free: null,
  '1:1': 1,
  '4:5': 4 / 5,
  '5:4': 5 / 4,
  '3:2': 3 / 2,
  '2:3': 2 / 3,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
};

/** The pixel aspect a crop preset asks for, given the transformed image size (null: unconstrained). */
export function aspectFor(aspect: CropSettings['aspect'], t: Size): number | null {
  if (!aspect || aspect === 'original') return t.width / t.height;
  return ASPECT_RATIOS[aspect] ?? null;
}

/** Largest centred rectangle of T with the given pixel aspect. */
export function centredRect(aspect: number | null, t: Size): CropRect {
  if (!aspect) return FULL;
  const ta = t.width / t.height;
  if (aspect >= ta) {
    const h = ta / aspect;
    return { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  const w = aspect / ta;
  return { x: (1 - w) / 2, y: 0, w, h: 1 };
}

/**
 * Moves or resizes a crop rectangle by a drag, keeping it inside T, at least 3 % on each side, and at the
 * locked aspect (pixel aspect, in T's pixel size) when there is one.
 */
export function dragRect(
  start: CropRect,
  handle: 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw',
  dx: number,
  dy: number,
  aspect: number | null,
  t: Size,
): CropRect {
  const MIN = 0.03;
  if (handle === 'move') {
    return {
      ...start,
      x: Math.min(1 - start.w, Math.max(0, start.x + dx)),
      y: Math.min(1 - start.h, Math.max(0, start.y + dy)),
    };
  }
  let x0 = start.x;
  let y0 = start.y;
  let x1 = start.x + start.w;
  let y1 = start.y + start.h;
  if (handle.includes('w')) x0 = Math.min(x1 - MIN, Math.max(0, x0 + dx));
  if (handle.includes('e')) x1 = Math.max(x0 + MIN, Math.min(1, x1 + dx));
  if (handle.includes('n')) y0 = Math.min(y1 - MIN, Math.max(0, y0 + dy));
  if (handle.includes('s')) y1 = Math.max(y0 + MIN, Math.min(1, y1 + dy));
  if (aspect) {
    // Convert the pixel aspect to T's normalised units, then fit, anchored at the fixed corner.
    const na = aspect / (t.width / t.height);
    let w = x1 - x0;
    let h = y1 - y0;
    if (handle === 'n' || handle === 's') w = h * na;
    else if (handle === 'e' || handle === 'w') h = w / na;
    else if (w / h > na) w = h * na;
    else h = w / na;
    const ax = handle.includes('w') ? x1 : handle.includes('e') ? x0 : (x0 + x1) / 2;
    const ay = handle.includes('n') ? y1 : handle.includes('s') ? y0 : (y0 + y1) / 2;
    // Shrink to fit inside T from the anchor.
    const maxW = handle.includes('w') ? ax : handle.includes('e') ? 1 - ax : 2 * Math.min(ax, 1 - ax);
    const maxH = handle.includes('n') ? ay : handle.includes('s') ? 1 - ay : 2 * Math.min(ay, 1 - ay);
    const k = Math.min(1, maxW / w, maxH / h);
    w *= k;
    h *= k;
    x0 = handle.includes('w') ? ax - w : handle.includes('e') ? ax : ax - w / 2;
    y0 = handle.includes('n') ? ay - h : handle.includes('s') ? ay : ay - h / 2;
    x1 = x0 + w;
    y1 = y0 + h;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
