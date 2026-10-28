import { type ReactNode, useEffect, useId, useRef } from 'react';
import { IconButton } from './Button';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

/** Modal built on the native <dialog>: focus trapping, Escape and the backdrop come from the browser. */
export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="z-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="z-dialog__head">
        <h2 id={titleId} className="z-card__title">
          {title}
        </h2>
        <IconButton icon="x" label="Close" size="sm" onClick={onClose} />
      </div>
      <div className="z-dialog__body">{children}</div>
      {footer && <div className="z-dialog__foot">{footer}</div>}
    </dialog>
  );
}
