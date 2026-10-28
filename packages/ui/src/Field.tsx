import { forwardRef, type InputHTMLAttributes, type ReactNode, useId } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode;
  /** Accessible name when there's no visible label. */
  ariaLabel?: string;
  icon?: IconName;
  hint?: ReactNode;
  error?: string | null;
  mono?: boolean;
  size?: 'md' | 'lg';
  trailing?: ReactNode;
}

/** Labelled text input with an optional leading icon, hint and error. */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, ariaLabel, icon, hint, error, mono, size = 'lg', trailing, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  const hintId = hint || error ? `${inputId}-hint` : undefined;
  return (
    <div className={cx('z-field', className)}>
      {label && <label htmlFor={inputId}>{label}</label>}
      <div className="z-field__wrap">
        {icon && (
          <span className="z-field__icon">
            <Icon name={icon} size={17} />
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-label={label ? undefined : ariaLabel}
          aria-invalid={error ? true : undefined}
          aria-describedby={hintId}
          className={cx(
            'z-input',
            `z-input--${size}`,
            icon ? 'z-input--icon' : false,
            mono && 'z-input--mono',
            trailing ? 'z-input--trail' : false,
          )}
          {...rest}
        />
        {trailing && <span className="z-field__trail">{trailing}</span>}
      </div>
      {(error || hint) && (
        <span
          id={hintId}
          className={cx('z-hint', error && 'z-hint--error')}
          role={error ? 'alert' : undefined}
        >
          {error || hint}
        </span>
      )}
    </div>
  );
});

export interface SelectFieldProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label: ReactNode;
  options: { value: string; label: string }[];
}

export function SelectField({ label, options, id, className, ...rest }: SelectFieldProps) {
  const auto = useId();
  const sid = id ?? auto;
  return (
    <div className={cx('z-field', className)}>
      <label htmlFor={sid}>{label}</label>
      <select id={sid} className="z-input z-input--md z-select" {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
