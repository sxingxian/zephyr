/**
 * Text watermarks are drawn on this device as a transparent PNG and uploaded like a logo: the server's image
 * service can overlay an image but can't draw text. The image is sized for guest renditions (2048 px on the
 * long edge), white with a soft shadow so it reads on light and dark photos.
 */
export const WATERMARK_FONT_PX = 56;
export const WATERMARK_MAX_WIDTH = 1600;

type Ctx = Pick<
  CanvasRenderingContext2D,
  | 'font'
  | 'fillStyle'
  | 'textBaseline'
  | 'shadowColor'
  | 'shadowBlur'
  | 'shadowOffsetY'
  | 'measureText'
  | 'fillText'
>;
export interface WatermarkCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): Ctx | null;
}
export interface WatermarkDeps {
  canvas(w: number, h: number): WatermarkCanvas;
  toPng(c: WatermarkCanvas): Promise<Blob>;
}

const FONT = (px: number) => `600 ${px}px "Geist Variable", "Geist", system-ui, sans-serif`;

export async function drawTextWatermark(text: string, deps: WatermarkDeps = browserCanvas): Promise<Blob> {
  const t = text.trim();
  if (!t) throw new Error('Type the text for your watermark.');
  // Measure first, then size the canvas to the text (with room for the shadow).
  const probe = deps.canvas(1, 1).getContext('2d');
  if (!probe) throw new Error('This browser can’t draw the watermark.');
  let px = WATERMARK_FONT_PX;
  probe.font = FONT(px);
  let w = probe.measureText(t).width;
  if (w > WATERMARK_MAX_WIDTH - 48) {
    px = Math.max(20, Math.floor((px * (WATERMARK_MAX_WIDTH - 48)) / w));
    probe.font = FONT(px);
    w = probe.measureText(t).width;
  }
  const pad = Math.ceil(px * 0.5);
  const c = deps.canvas(Math.ceil(w) + pad * 2, Math.ceil(px * 1.4) + pad * 2);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('This browser can’t draw the watermark.');
  ctx.font = FONT(px);
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = Math.round(px / 8);
  ctx.shadowOffsetY = Math.max(1, Math.round(px / 28));
  ctx.fillStyle = '#ffffff';
  ctx.fillText(t, pad, c.height / 2);
  return deps.toPng(c);
}

const browserCanvas: WatermarkDeps = {
  canvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined')
      return new OffscreenCanvas(w, h) as unknown as WatermarkCanvas;
    const el = document.createElement('canvas');
    el.width = w;
    el.height = h;
    return el as unknown as WatermarkCanvas;
  },
  toPng(c) {
    const any = c as unknown as {
      convertToBlob?: (o: { type: string }) => Promise<Blob>;
    } & HTMLCanvasElement;
    if (typeof any.convertToBlob === 'function') return any.convertToBlob({ type: 'image/png' });
    return new Promise((res, rej) =>
      any.toBlob((b) => (b ? res(b) : rej(new Error('Couldn’t make the watermark image.'))), 'image/png'),
    );
  },
};
