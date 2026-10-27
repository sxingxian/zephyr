import { ICONS, type IconName } from './generated/icons';

export type { MascotPose, SampleKind } from './generated/brand';
export { MARK_SVG, MASCOT, MASCOT_PALETTE, SAMPLE_KINDS } from './generated/brand';
export type { IconName };
export { ICONS };

/** Inline SVG for an icon on the 24px grid (1.75 stroke). Decorative by default. */
export function iconSvg(name: IconName, size = 18): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}
