import type { ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export type ChipTone = 'neutral' | 'acc' | 'good' | 'warn' | 'bad' | 'ink' | 'outline';

export function Chip({
  tone = 'neutral',
  icon,
  dot,
  children,
  size = 'md',
  className,
}: {
  tone?: ChipTone;
  icon?: IconName;
  dot?: boolean;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <span className={cx('z-chip', `z-chip--${tone}`, `z-chip--${size}`, className)}>
      {icon && <Icon name={icon} size={13} />}
      {dot && <span className="z-chip__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
