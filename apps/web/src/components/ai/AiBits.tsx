import { type AiStatus, FACE_CONSENT_VERSION } from '@zephyr/shared/client';
import { Button, Chip, Dialog, Icon, type IconName, Note } from '@zephyr/ui';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { pausedUntil, useAiStatus } from '../../lib/aiClient';
import { errorMessage } from '../../lib/api';
import { originalPreviewUrl, originalThumbUrl } from '../../lib/edits';

/** Plural helper: "1 credit", "12 credits". */
export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/** "Free · on device" / "1 credit · cloud" chip. */
export function WhereChip({ cloud, text }: { cloud?: boolean; text?: string }) {
  return (
    <Chip tone={cloud ? 'acc' : 'good'} icon={cloud ? 'cpu' : 'phone'} size="sm">
      {text ?? (cloud ? '1 credit · cloud' : 'Free · on device')}
    </Chip>
  );
}

/** "Cloud credits 640 / 1,000 · On-device tools are free and unlimited". */
export function CreditStrip({ status, compact }: { status: AiStatus; compact?: boolean }) {
  const { balance, monthly } = status.credits;
  return (
    <div className={`ai-credits${compact ? ' ai-credits--compact' : ''}`}>
      <Icon name="breeze" size={17} className="ai-credits__icon" />
      <span className="ai-credits__text">
        Cloud credits
        {!compact && <span className="ai-credits__sub">On-device tools are free and unlimited</span>}
      </span>
      <span className="ai-credits__num">
        <span className="z-sr">{`${balance} of ${monthly} cloud credits left`}</span>
        <span aria-hidden="true">{balance.toLocaleString('en')}</span>
        <span className="ai-credits__of" aria-hidden="true">
          {' '}
          / {monthly.toLocaleString('en')}
        </span>
      </span>
    </div>
  );
}

/** Sidebar meter for cloud credits (replaces "Coming soon"). */
export function CreditsMeter() {
  const s = useAiStatus();
  if (!s?.enabled) return null;
  const { balance, monthly } = s.credits;
  const pct = monthly ? Math.max(0, Math.min(100, Math.round((balance / monthly) * 100))) : 0;
  return (
    <div className="meter">
      <div className="meter__row">
        <span>Cloud AI credits</span>
        <span className="meter__val">
          {balance.toLocaleString('en')} of {monthly.toLocaleString('en')} left
        </span>
      </div>
      <div
        className="meter__bar meter__bar--good"
        role="progressbar"
        aria-label="Cloud AI credits left"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** "Cloud AI is paused until 08:00" when cloud work is waiting. */
export function CloudPausedBanner({ status }: { status: AiStatus | null }) {
  if (!status?.enabled || !status.cloudPaused) return null;
  const until = pausedUntil(status);
  return (
    <Note tone="warn" icon="alert" role="status">
      <strong>Cloud AI is paused{until ? ` until ${until} (your time)` : ''}.</strong>{' '}
      {status.cloudPaused.reason === 'cap'
        ? 'Zephyr reached its daily limit for cloud work. Queued background removals will start then.'
        : 'Queued background removals will start once it’s back.'}{' '}
      On-device tools still work.
    </Note>
  );
}

/** Quiet note when the admin switched Zephyr AI off for everyone. */
export function AiPausedNote() {
  return (
    <Note tone="neutral" icon="breeze" role="status">
      Zephyr AI is paused right now. Manual editing keeps working.
    </Note>
  );
}

/** "Available on Pro and Studio" with a pointer to plans. */
export function UpgradeHint({ what, icon = 'lock' }: { what: string; icon?: IconName }) {
  return (
    <div className="ai-upgrade">
      <span className="ai-upgrade__icon">
        <Icon name={icon} size={20} />
      </span>
      <div>
        <strong>{what} comes with Pro and Studio.</strong>
        <span className="z-muted"> Upgrades arrive with billing; your plan stays as it is for now.</span>
      </div>
      <Chip tone="ink" size="sm">
        Pro
      </Chip>
    </div>
  );
}

/** A face cropped out of the photo's preview with CSS (no face image is ever stored or sent). */
export function FaceCrop({
  photoId,
  box,
  size,
  label,
  original,
}: {
  photoId: string;
  box: [number, number, number, number];
  size: number;
  label: string;
  /** Use the thumbnail (small faces lists). */
  original?: 'thumb';
}) {
  // Pad the box by 25 % so the crop shows the whole head.
  const [bx, by, bw, bh] = box;
  const pad = 0.25;
  const w = Math.min(1, bw * (1 + pad * 2));
  const h = Math.min(1, bh * (1 + pad * 2));
  const x = Math.max(0, Math.min(1 - w, bx - bw * pad));
  const y = Math.max(0, Math.min(1 - h, by - bh * pad));
  const style: CSSProperties = {
    width: size,
    height: size,
    // Face boxes are measured on the untouched preview, so the crop uses the untouched images too (an edit
    // may crop, rotate or cut the photo out). The 512 px thumbnail is enough unless the face is small in it.
    backgroundImage: `url("${original === 'thumb' || bw * 512 * (1 + pad * 2) >= size * 0.6 ? originalThumbUrl(photoId) : originalPreviewUrl(photoId)}")`,
    backgroundSize: `${100 / w}% ${100 / h}%`,
    backgroundPosition: `${w >= 1 ? 0 : (x / (1 - w)) * 100}% ${h >= 1 ? 0 : (y / (1 - h)) * 100}%`,
  };
  return <span className="ai-face" role="img" aria-label={label} style={style} />;
}

/** The biometric consent dialog for face grouping. "Turn on" stays disabled until the box is ticked. */
export function ConsentDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (consent: { version: number; rightsConfirmed: true }) => Promise<void>;
}) {
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setTicked(false);
      setError(null);
    }
  }, [open]);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ version: FACE_CONSENT_VERSION, rightsConfirmed: true });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        <span className="edlg-title">
          <span className="ai-dlg-icon">
            <Icon name="people" size={20} />
          </span>
          Turn on face grouping?
        </span>
      }
      footer={
        <>
          {!ticked && <span className="edlg-foot__note">Tick the box to continue</span>}
          <Button kind="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button kind="primary" disabled={!ticked} busy={busy} onClick={go}>
            Turn on
          </Button>
        </>
      }
    >
      <div className="ai-consent">
        <p>
          Face grouping creates a face code for each face it finds. A face code can identify a person, so the
          law treats it as biometric data.
        </p>
        <ul>
          <li>
            Faces are found on this device. Only the codes and the face’s position in the photo are saved, in
            your account.
          </li>
          <li>Codes are never shared, sold, used for ads or training, or compared with other accounts.</li>
          <li>Turn it off at any time in Settings › Zephyr AI. All face data is deleted at once.</li>
        </ul>
        <label className="ai-consent__tick">
          <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
          <span>
            I’ll only use this on photos I have the right to process, such as my own, my family’s, or clients
            who agreed to it.
          </span>
        </label>
        <Link to="/settings/ai" className="text-link" onClick={onClose}>
          How Zephyr handles face data
        </Link>
        {error && (
          <Note tone="bad" icon="alert" role="alert">
            {error}
          </Note>
        )}
      </div>
    </Dialog>
  );
}

/** Small confirm dialog. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirm,
  danger,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirm: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
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
          <Button kind={danger ? 'danger' : 'primary'} busy={busy} onClick={go}>
            {confirm}
          </Button>
        </>
      }
    >
      <div className="ai-consent">
        {children}
        {error && (
          <Note tone="bad" icon="alert" role="alert">
            {error}
          </Note>
        )}
      </div>
    </Dialog>
  );
}
