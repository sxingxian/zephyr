import { ACCOUNT_ACTION_MINUTES, ACCOUNT_DELETION_DAYS } from '@zephyr/shared/client';
import { Button, Card, Field, Icon, useToast } from '@zephyr/ui';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { requestAccountAction } from '../lib/accountActions';
import { ApiFailure, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import { useUsage } from '../lib/usage';

const RETURN = '/settings/security?delete=1';

/**
 * Settings › Delete account: a danger card and a type-DELETE confirmation. Phase 8: confirming emails the member a
 * link; the account is deleted on the page that link opens (routes/AccountAction.tsx), never from here.
 */
export function DeleteAccountCard() {
  const { user } = useSession();
  const usage = useUsage();
  const toast = useToast();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [sent, setSent] = useState(false);

  // Back from the security sign-in: reopen the dialog.
  useEffect(() => {
    if (params.get('delete') === '1') {
      setOpen(true);
      params.delete('delete');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setTyped('');
      setError(null);
      setSent(false);
      d.showModal?.();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const photos = usage ? usage.photoCount.toLocaleString('en') : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (typed !== 'DELETE') return;
    setBusy(true);
    setError(null);
    try {
      await requestAccountAction('account_delete');
      setSent(true);
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'reauth_required') {
        toast.show('For your security, sign in again to delete your account.', 'bad');
        nav(`/sign-in?reauth=1&next=${encodeURIComponent(RETURN)}`);
        return;
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card className="danger-card">
        <div className="row">
          <span className="row__icon row__icon--bad">
            <Icon name="trash" size={18} />
          </span>
          <div className="row__text">
            <span className="row__title">Delete account</span>
            <span className="row__sub">
              Closes your account and signs you out everywhere. You can restore it for {ACCOUNT_DELETION_DAYS}{' '}
              days.
            </span>
          </div>
          <Button kind="danger" size="sm" icon="trash" onClick={() => setOpen(true)}>
            Delete account
          </Button>
        </div>
      </Card>
      <dialog
        ref={ref}
        className="z-dialog del-dialog"
        aria-labelledby={titleId}
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) setOpen(false);
        }}
      >
        {sent ? (
          <div className="del-dialog__body">
            <span className="del-dialog__icon">
              <Icon name="mail" size={24} />
            </span>
            <h2 id={titleId} className="del-dialog__title">
              Check your email
            </h2>
            <p className="del-dialog__text">
              We emailed {user?.email ?? 'you'} a link that deletes your account. Open it to finish; it works
              for {ACCOUNT_ACTION_MINUTES} minutes. Nothing changes until you do.
            </p>
            <div className="del-dialog__foot">
              <Button kind="ghost" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <form className="del-dialog__body" onSubmit={submit}>
            <span className="del-dialog__icon">
              <Icon name="alert" size={24} />
            </span>
            <h2 id={titleId} className="del-dialog__title">
              Delete your Zephyr account?
            </h2>
            <p className="del-dialog__text">
              Your account is closed straight away and you’re signed out everywhere. For{' '}
              <strong>{ACCOUNT_DELETION_DAYS} days</strong> you can sign in and restore everything. After
              that,
              {photos ? ` all ${photos} photos,` : ' all your photos,'} your albums and edits are deleted for
              good.
            </p>
            <p className="z-hint">
              Want copies first? Open any photo and choose Download to save the original. To keep your account
              safe, we email you a link that makes the deletion.
            </p>
            <Field
              label="Type DELETE to confirm"
              placeholder="DELETE"
              mono
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              error={error}
            />
            <div className="del-dialog__foot">
              <Button kind="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button kind="danger" type="submit" icon="mail" busy={busy} disabled={typed !== 'DELETE'}>
                Email me the link
              </Button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
