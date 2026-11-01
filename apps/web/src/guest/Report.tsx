import { REPORT_DETAILS_MAX, REPORT_REASONS, type ReportReason } from '@zephyr/shared/client';
import { Button, Dialog, Note, Turnstile, type TurnstileHandle } from '@zephyr/ui';
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
} from 'react';
import { TURNSTILE_SITE_KEY } from '../lib/config';
import { GUEST_REPORT_ACTION, GuestApiError, reportGallery } from './api';

const REASON_LABEL: Record<ReportReason, { title: string; hint: string }> = {
  csam: { title: 'Child sexual abuse material', hint: 'Sent to our safety team straight away' },
  violence: { title: 'Violence or threats', hint: 'Graphic violence, threats or harassment' },
  copyright: { title: 'Copyright', hint: 'Photos used without the owner’s permission' },
  privacy: { title: 'Privacy', hint: 'Someone shared without consent, or personal details' },
  other: { title: 'Something else', hint: 'Tell us what’s wrong below' },
};

/** Opens the report dialog, for the whole gallery or one photo. Absent where reporting isn't offered. */
type OpenReport = (photoId?: string) => void;
const ReportCtx = createContext<OpenReport | null>(null);
export function useReport(): OpenReport | null {
  return useContext(ReportCtx);
}

/**
 * Lets any part of the guest page offer "Report". The dialog (and the Turnstile script) is only mounted
 * while it is open.
 */
export function ReportProvider({ token, children }: { token: string | null; children: ReactNode }) {
  const [target, setTarget] = useState<{ photoId?: string } | null>(null);
  const open = useCallback<OpenReport>((photoId) => setTarget(photoId ? { photoId } : {}), []);
  if (!token) return <>{children}</>;
  return (
    <ReportCtx.Provider value={open}>
      {children}
      {target && <ReportDialog token={token} photoId={target.photoId} onClose={() => setTarget(null)} />}
    </ReportCtx.Provider>
  );
}

type Problem = 'reason' | 'turnstile' | 'rate' | 'network' | null;

export function ReportDialog({
  token,
  photoId,
  onClose,
}: {
  token: string;
  photoId?: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [tsToken, setTsToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const ts = useRef<TurnstileHandle>(null);
  const formId = useId();
  const detailsId = useId();
  const name = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reason) return setProblem('reason');
    if (TURNSTILE_SITE_KEY && !tsToken) return setProblem('turnstile');
    setBusy(true);
    setProblem(null);
    const used = tsToken;
    try {
      const trimmed = details.trim();
      await reportGallery(token, {
        reason,
        turnstileToken: used ?? '',
        ...(photoId ? { photoId } : {}),
        ...(trimmed ? { details: trimmed } : {}),
      });
      setDone(true);
    } catch (err) {
      // Turnstile tokens are single-use.
      setTsToken(null);
      ts.current?.reset();
      if (err instanceof GuestApiError && err.status === 429) setProblem('rate');
      else if (err instanceof GuestApiError && err.status === 400) setProblem('turnstile');
      else setProblem('network');
    } finally {
      setBusy(false);
    }
  };

  const title = photoId ? 'Report this photo' : 'Report this gallery';
  if (done)
    return (
      <Dialog
        open
        onClose={onClose}
        title="Thanks for telling us"
        footer={
          <Button kind="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <p className="g-lede g-lede--left" role="status">
          Our safety team will look at it. We don’t tell the person who shared the gallery who reported it.
        </p>
      </Dialog>
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="danger" type="submit" form={formId} icon="flag" busy={busy}>
            Send report
          </Button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit} noValidate>
        <fieldset className="g-report__reasons">
          <legend className="g-report__legend">What’s wrong?</legend>
          {REPORT_REASONS.map((r) => (
            <label key={r} className={`g-report__reason${reason === r ? ' g-report__reason--on' : ''}`}>
              <input
                type="radio"
                name={name}
                value={r}
                checked={reason === r}
                onChange={() => {
                  setReason(r);
                  if (problem === 'reason') setProblem(null);
                }}
              />
              <span className="g-report__text">
                <span className="g-report__title">{REASON_LABEL[r].title}</span>
                <span className="g-muted g-small">{REASON_LABEL[r].hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="z-field">
          <label htmlFor={detailsId}>Details (optional)</label>
          <textarea
            id={detailsId}
            className="z-input g-textarea"
            rows={3}
            maxLength={REPORT_DETAILS_MAX}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
          />
        </div>
        {TURNSTILE_SITE_KEY && (
          <Turnstile
            ref={ts}
            siteKey={TURNSTILE_SITE_KEY}
            action={GUEST_REPORT_ACTION}
            onToken={(t) => {
              setTsToken(t);
              if (problem === 'turnstile') setProblem(null);
            }}
            onExpire={() => setTsToken(null)}
          />
        )}
        {problem && (
          <Note tone="bad" icon="alert" role="alert">
            {problem === 'reason'
              ? 'Choose what’s wrong.'
              : problem === 'turnstile'
                ? 'Complete the security check, then send again.'
                : problem === 'rate'
                  ? 'Too many reports from this network today. Try again tomorrow.'
                  : 'That didn’t send. Check your connection and try again.'}
          </Note>
        )}
        <p className="g-muted g-small">
          Reports are private. If you think someone is in danger, contact your local police too.
        </p>
      </form>
    </Dialog>
  );
}

/** Small "Report this gallery" link for footers. Renders nothing where reporting isn't offered. */
export function ReportLink() {
  const open = useReport();
  if (!open) return null;
  return (
    <button type="button" className="g-report-link" onClick={() => open()}>
      Report this gallery
    </button>
  );
}
