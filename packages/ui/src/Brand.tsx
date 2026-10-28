import { MARK_SVG, MASCOT, type MascotPose } from '@zephyr/brand';
import { cx } from './cx';

/*
 * MARK_SVG and MASCOT are static, build-time SVG strings exported from the design kit (@zephyr/brand); they
 * never contain user input, so rendering them as markup is safe.
 */

export function Mark({ size = 24 }: { size?: number }) {
  const svg = MARK_SVG.replace('<svg ', `<svg width="${size}" height="${size}" `);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted static brand markup
  return <span className="z-mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Wordmark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <span className={cx('z-wordmark', className)} style={{ fontSize: size, gap: Math.round(size * 0.36) }}>
      <Mark size={Math.round(size * 1.25)} />
      <span className="z-wordmark__text">zephyr</span>
    </span>
  );
}

export interface MascotProps {
  pose: MascotPose;
  /** Width in px; height follows the 220×250 artwork. */
  width: number;
  /** Background tile. Omit for a bare mascot. */
  tile?: { background: string; height: number; radius?: number };
  className?: string;
}

/** Zephyr the rabbit. Decorative. */
export function Mascot({ pose, width, tile, className }: MascotProps) {
  const h = Math.round((width * 250) / 220);
  const svg = MASCOT[pose].replace('<svg ', `<svg width="${width}" height="${h}" `);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted static brand markup
  const art = <span className="z-mascot__art" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
  if (!tile) return <span className={cx('z-mascot', className)}>{art}</span>;
  return (
    <div
      className={cx('z-mascot z-mascot--tile', className)}
      style={{ background: tile.background, height: tile.height, borderRadius: tile.radius ?? 28 }}
    >
      {art}
    </div>
  );
}
