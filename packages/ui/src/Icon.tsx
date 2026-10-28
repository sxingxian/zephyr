import { ICONS, type IconName } from '@zephyr/brand';

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  /** Give the icon an accessible name only when it carries meaning on its own. */
  label?: string;
}

/** 24px-grid line icon from the brand kit. Decorative (aria-hidden) unless `label` is set. */
export function Icon({ name, size = 18, className, label }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      // ICONS are static, build-time strings from @zephyr/brand (never user input), so injecting them is safe.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted static brand markup
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
export type { IconName };
