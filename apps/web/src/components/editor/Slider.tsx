import { type CSSProperties, type KeyboardEvent, useId } from 'react';
import { ariaValue, formatValue } from '../../lib/editor/controls';

/**
 * A labelled range slider. Dragging shows the change live (`onInput`) and records one undo step on release
 * (`onCommit`). Double-click resets; arrow keys step, Shift+arrow steps ×10.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  bipolar = true,
  track,
  suffix = '',
  onInput,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  bipolar?: boolean;
  track?: string;
  suffix?: string;
  onInput: (v: number) => void;
  onCommit: (v?: number) => void;
}) {
  const id = useId();
  const pos = ((value - min) / (max - min)) * 100;
  const zero = bipolar ? ((0 - min) / (max - min)) * 100 : 0;
  const changed = value !== 0;
  const style = {
    '--pos': `${pos}%`,
    '--fl': `${Math.min(pos, zero)}%`,
    '--fw': `${Math.abs(pos - zero)}%`,
    '--zero': `${zero}%`,
    ...(track ? { '--track': track } : {}),
  } as CSSProperties;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!e.shiftKey) return;
    const dir =
      e.key === 'ArrowRight' || e.key === 'ArrowUp'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
          ? -1
          : 0;
    if (!dir) return;
    e.preventDefault();
    const v = Math.min(max, Math.max(min, value + dir * step * 10));
    onInput(v);
  };
  return (
    <div className={`eslider${changed ? ' is-changed' : ''}${bipolar ? ' is-bipolar' : ''}`} style={style}>
      <div className="eslider__head">
        <label htmlFor={id} title="Double-click to reset">
          {label}
        </label>
        <output htmlFor={id}>{formatValue(value, step, suffix)}</output>
      </div>
      <div className="eslider__rail">
        <span className="eslider__track" aria-hidden="true" />
        {changed && <span className="eslider__fill" aria-hidden="true" />}
        {bipolar && <span className="eslider__zero" aria-hidden="true" />}
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={ariaValue({ label }, value, step, suffix)}
          onChange={(e) => onInput(Number(e.target.value))}
          onPointerUp={() => onCommit()}
          onKeyUp={(e) => {
            if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key.startsWith('Page'))
              onCommit();
          }}
          onKeyDown={onKeyDown}
          onBlur={() => onCommit()}
          onDoubleClick={() => {
            onInput(0);
            onCommit(0);
          }}
        />
      </div>
    </div>
  );
}
