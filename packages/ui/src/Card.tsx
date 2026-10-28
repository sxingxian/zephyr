import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <section className={cx('z-card', className)} {...rest}>
      {children}
    </section>
  );
}

export function CardHead({
  title,
  children,
  level = 2,
}: {
  title: ReactNode;
  children?: ReactNode;
  level?: 2 | 3;
}) {
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <div className="z-card__head">
      <H className="z-card__title">{title}</H>
      {children && <div className="z-card__actions">{children}</div>}
    </div>
  );
}

export type NoteTone = 'acc' | 'warn' | 'bad' | 'good' | 'neutral';

export function Note({
  tone = 'acc',
  icon = 'info',
  children,
  role,
}: {
  tone?: NoteTone;
  icon?: IconName;
  children: ReactNode;
  role?: 'alert' | 'status';
}) {
  return (
    <div className={cx('z-note', `z-note--${tone}`)} role={role}>
      <Icon name={icon} size={16} />
      <span>{children}</span>
    </div>
  );
}
