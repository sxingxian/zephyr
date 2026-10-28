import { type ReactNode, useId } from 'react';
import { cx } from './cx';

export interface SwitchProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** A labelled on/off switch (a checkbox with role="switch"). */
export function Switch({ checked, onChange, label, hint, disabled, className }: SwitchProps) {
  const id = useId();
  return (
    <div className={cx('z-switch-row', className)}>
      <label htmlFor={id} className="z-switch-row__text">
        <span>{label}</span>
        {hint && <span className="z-hint">{hint}</span>}
      </label>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="z-switch"
        checked={checked}
        aria-checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
      />
    </div>
  );
}
