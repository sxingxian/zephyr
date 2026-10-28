import type { CropRect } from '@zephyr/shared/client';
import { type PointerEvent, useRef } from 'react';
import { dragRect, type Size } from '../../lib/editor/geometry';

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * The crop rectangle over the straightened photo: drag inside to move, drag a corner or edge to resize
 * (keeping the chosen aspect). Arrow keys nudge it; the dimensions show underneath.
 */
export function CropOverlay({
  rect,
  aspect,
  t,
  label,
  onChange,
  onCommit,
}: {
  rect: CropRect;
  aspect: number | null;
  t: Size;
  label: string;
  onChange: (r: CropRect) => void;
  onCommit: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ h: Handle; x: number; y: number; start: CropRect } | null>(null);
  const down = (h: Handle) => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { h, x: e.clientX, y: e.clientY, start: rect };
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    const el = box.current;
    if (!d || !el) return;
    const b = el.getBoundingClientRect();
    onChange(dragRect(d.start, d.h, (e.clientX - d.x) / b.width, (e.clientY - d.y) / b.height, aspect, t));
  };
  const up = () => {
    if (!drag.current) return;
    drag.current = null;
    onCommit();
  };
  const style = {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.w * 100}%`,
    height: `${rect.h * 100}%`,
  };
  return (
    <div className="ecrop" ref={box} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <button
        type="button"
        className="ecrop__rect"
        style={style}
        aria-label={`Crop area, ${label}. Use the arrow keys to move it.`}
        onPointerDown={down('move')}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.05 : 0.01;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          if (!dx && !dy) return;
          e.preventDefault();
          onChange(dragRect(rect, 'move', dx, dy, aspect, t));
        }}
        onKeyUp={(e) => {
          if (e.key.startsWith('Arrow')) onCommit();
        }}
      >
        <span className="ecrop__grid" aria-hidden="true" />
        {HANDLES.map((h) => (
          <span key={h} className={`ecrop__h ecrop__h--${h}`} onPointerDown={down(h)} aria-hidden="true" />
        ))}
        <span className="ecrop__dims">{label}</span>
      </button>
    </div>
  );
}
