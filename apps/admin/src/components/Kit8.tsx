import { ADMIN_REASON_MAX } from '@zephyr/shared/client';
import { Button, Dialog, Icon, type IconName, Note, Spinner } from '@zephyr/ui';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { reasonOk, writeError } from '../lib/admin8';

/** A KPI tile (same look as Admin › Zephyr AI and Plans & billing). */
export function Kpi({
  label,
  value,
  note,
  tone = 'muted',
  icon,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: 'muted' | 'good' | 'warn' | 'bad';
  icon: IconName;
}) {
  return (
    <div className="ai-tile">
      <span className="ai-tile__head">
        <span className="bl-kpi__label">
          <Icon name={icon} size={16} />
          {label}
        </span>
      </span>
      <span className="ai-tile__value">{value}</span>
      {note && <span className={`z-hint bl-kpi__note bl-kpi__note--${tone}`}>{note}</span>}
    </div>
  );
}

export function ReasonField({
  value,
  onChange,
  label = 'Reason (goes in the audit log)',
  placeholder = 'Why you’re doing this',
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="z-field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className="z-input"
        rows={2}
        maxLength={ADMIN_REASON_MAX}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * A dialog that asks for a reason (required, ≥ 3 characters) plus any extra fields, then runs `onConfirm`.
 * `passkey` only changes the button and the note: the API decides when a passkey is needed (withReauth).
 */
export function ReasonDialog({
  open,
  title,
  intro,
  children,
  confirmLabel,
  danger,
  passkey,
  canConfirm = true,
  reasonLabel,
  withReason = true,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  intro?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  passkey?: boolean;
  canConfirm?: boolean;
  reasonLabel?: string;
  /** False for writes whose body has no reason (the action itself is the record). */
  withReason?: boolean;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setReason('');
      setErr(null);
      setBusy(false);
    }
  }, [open]);
  const ready = (!withReason || reasonOk(reason)) && canConfirm;
  const go = async () => {
    if (!ready) return;
    setBusy(true);
    setErr(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e) {
      setErr(writeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            kind={danger ? 'danger' : 'primary'}
            icon={passkey ? 'passkey' : undefined}
            busy={busy}
            disabled={!ready}
            onClick={go}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="bl-dialog">
        {intro && <div className="a8-intro">{intro}</div>}
        {children}
        {withReason && (
          <ReasonField
            value={reason}
            onChange={setReason}
            label={reasonLabel ?? (passkey ? 'Reason (audit log and the Owners’ email)' : undefined)}
          />
        )}
        {passkey && (
          <p className="bl-dialog__note">
            <Icon name="passkey" size={16} />
            <span>Asks for your passkey again and emails every Owner.</span>
          </p>
        )}
        {err && (
          <Note tone="bad" icon="alert" role="alert">
            {err}
          </Note>
        )}
      </div>
    </Dialog>
  );
}

/** Loading / error / no-access frame for a page body. */
export function PageState({
  allowed,
  who,
  err,
  loading,
  onRetry,
  children,
}: {
  allowed: boolean;
  who: string;
  err: string | null;
  loading: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (!allowed)
    return (
      <Note tone="warn" icon="lock">
        This page is for {who}.
      </Note>
    );
  return (
    <>
      {err && (
        <Note tone="bad" icon="alert" role="alert">
          {err}{' '}
          <button type="button" className="linkish" onClick={onRetry}>
            Try again
          </button>
        </Note>
      )}
      {loading && !err && <Spinner size={22} label="Loading" />}
      {!loading && children}
    </>
  );
}

/** A bulleted list of what a change will do. */
export function Effects({ items }: { items: [IconName, ReactNode, ('good' | 'bad' | 'warn')?][] }) {
  return (
    <ul className="a8-effects">
      {items.map(([ic, t, tone], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static list
        <li key={i} className={tone ? `a8-effects--${tone}` : undefined}>
          <Icon name={ic} size={16} />
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

export function Progress({ pct, label, tone = 'acc' }: { pct: number; label: string; tone?: string }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div
      className="a8-bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v}
    >
      <span className={`a8-bar__fill a8-bar__fill--${tone}`} style={{ width: `${v}%` }} />
    </div>
  );
}
