import { type ClipboardEvent, type KeyboardEvent, useEffect, useRef } from 'react';
import { cx } from './cx';

export interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Called once all digits are filled. */
  onComplete?: (value: string) => void;
  length?: number;
  label?: string;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
}

/**
 * One-time code entry as separate boxes. Accepts typing, paste and the browser's one-time-code autofill
 * (into the first box), moves focus forward and back, and only ever holds digits.
 */
export function CodeInput({
  value,
  onChange,
  onComplete,
  length = 6,
  label = 'Code',
  disabled,
  invalid,
  autoFocus,
}: CodeInputProps) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.replace(/\D/g, '').slice(0, length);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once, on mount only
  useEffect(() => {
    if (autoFocus) refs.current[Math.min(digits.length, length - 1)]?.focus();
  }, []);

  const set = (next: string, focusAt?: number) => {
    const clean = next.replace(/\D/g, '').slice(0, length);
    onChange(clean);
    if (focusAt !== undefined) refs.current[Math.min(focusAt, length - 1)]?.focus();
    if (clean.length === length) onComplete?.(clean);
  };

  // When a box already holds a digit, the new keystroke lands before or after it; keep only the new one.
  const withoutOld = (v: string, old: string | undefined) =>
    old && v.length === 2 ? (v.startsWith(old) ? v.slice(1) : v.slice(0, 1)) : v;
  const onInput = (i: number, raw: string) => {
    const typed = raw.replace(/\D/g, '');
    if (!typed) return;
    // Several digits arrive at once from autofill or a mobile keyboard suggestion.
    const next = (digits.slice(0, i) + typed + digits.slice(i + typed.length)).slice(0, length);
    set(next, i + typed.length);
  };
  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (digits[i]) set(digits.slice(0, i) + digits.slice(i + 1), i);
      else if (i > 0) set(digits.slice(0, i - 1) + digits.slice(i), i - 1);
    } else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && i < length - 1) refs.current[i + 1]?.focus();
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '');
    if (!text) return;
    e.preventDefault();
    set(text, text.length);
  };

  return (
    <fieldset className={cx('z-code', invalid && 'z-code--invalid')} disabled={disabled}>
      <legend className="z-sr">{label}</legend>
      {Array.from({ length }, (_, i) => (
        <input
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed number of positional boxes
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="z-code__box"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={i === 0 ? length : 1}
          aria-label={`Digit ${i + 1} of ${length}`}
          aria-invalid={invalid || undefined}
          value={digits[i] ?? ''}
          onChange={(e) => onInput(i, withoutOld(e.target.value, digits[i]))}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={onPaste}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </fieldset>
  );
}
