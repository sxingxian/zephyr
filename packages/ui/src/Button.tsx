import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';
import { Spinner } from './Spinner';

export type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger' | 'tint' | 'accent';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonStyleProps {
  kind?: ButtonKind;
  size?: ButtonSize;
  full?: boolean;
}

/** Class names for anything that should look like a button (also used for router links). */
export function buttonClass(
  { kind = 'secondary', size = 'md', full }: ButtonStyleProps,
  extra?: string,
): string {
  return cx('z-btn', `z-btn--${kind}`, `z-btn--${size}`, full && 'z-btn--full', extra);
}

interface Content {
  icon?: IconName;
  iconRight?: IconName;
  children?: ReactNode;
}
function inner({ icon, iconRight, children }: Content, size: ButtonSize, busy?: boolean) {
  const s = size === 'sm' ? 15 : 17;
  return (
    <>
      {busy ? <Spinner size={s} /> : icon && <Icon name={icon} size={s} />}
      {children !== undefined && <span>{children}</span>}
      {iconRight && <Icon name={iconRight} size={s} />}
    </>
  );
}

export interface ButtonProps
  extends ButtonStyleProps,
    Content,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  busy?: boolean;
}

export function Button({
  kind,
  size = 'md',
  full,
  icon,
  iconRight,
  children,
  busy,
  className,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass({ kind, size, full }, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {inner({ icon, iconRight, children }, size, busy)}
    </button>
  );
}

export interface LinkButtonProps
  extends ButtonStyleProps,
    Content,
    Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> {}

/** A plain <a> styled as a button (for external links; apps wrap router links with buttonClass). */
export function LinkButton({
  kind,
  size = 'md',
  full,
  icon,
  iconRight,
  children,
  className,
  ...rest
}: LinkButtonProps) {
  return (
    <a className={buttonClass({ kind, size, full }, className)} {...rest}>
      {inner({ icon, iconRight, children }, size)}
    </a>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName;
  /** Accessible name; required because the button has no text. */
  label: string;
  size?: ButtonSize;
  kind?: ButtonKind;
}

export function IconButton({
  icon,
  label,
  size = 'md',
  kind = 'ghost',
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={buttonClass({ kind, size }, cx('z-btn--icon', className))}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 16 : 20} />
    </button>
  );
}
