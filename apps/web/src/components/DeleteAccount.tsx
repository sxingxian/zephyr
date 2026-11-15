import { ACCOUNT_DELETION_DAYS } from '@zephyr/shared/client';
import { Button, Card, Field, Icon, useToast } from '@zephyr/ui';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ApiFailure, errorMessage } from '../lib/api';
import { deleteAccount } from '../lib/library';
import { browser, endSession } from '../lib/sessionGuard';
import { useUsage } from '../lib/usage';
import { useStepUp } from './StepUp';

const RETURN = '/settings/security?delete=1';

/** Settings › Delete account: a danger card and a type-DELETE confirmation. */
export function DeleteAccountCard() {
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
  // Phase 8: while the member may be shown ads, deleting the account also needs an emailed code.
  const stepUp = useStepUp();

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
      // When a code is needed, the step-up dialog opens on top of this one.
      const r = await stepUp.run('account_delete', (headers) => deleteAccount(headers));
      if (!r) return;
      try {
        sessionStorage.setItem('zephyr.purgeAt', r.purgeAt);
      } catch {
        // storage unavailable: the confirmation page falls back to "30 days"
      }
      // The server has already signed out every session: stop this member's uploads (nothing is sent),
      // then load the confirmation page afresh so no photo data stays in memory.
      await endSession('deleted', false);
      setOpen(false);
      // The confirmation page forgets the session once it's showing, so the sign-in guard on this page
      // doesn't redirect first.
      nav('/account-deleted', { replace: true, state: { deleted: true } });
      browser.assign('/account-deleted');
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
        <form className="del-dialog__body" onSubmit={submit}>
          <span className="del-dialog__icon">
            <Icon name="alert" size={24} />
          </span>
          <h2 id={titleId} className="del-dialog__title">
            Delete your Zephyr account?
          </h2>
          <p className="del-dialog__text">
            Your account is closed straight away and you’re signed out everywhere. For{' '}
            <strong>{ACCOUNT_DELETION_DAYS} days</strong> you can sign in and restore everything. After that,
            {photos ? ` all ${photos} photos,` : ' all your photos,'} your albums and edits are deleted for
            good.
          </p>
          <p className="z-hint">
            Want copies first? Open any photo and choose Download to save the original.
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
            <Button kind="danger" type="submit" icon="trash" busy={busy} disabled={typed !== 'DELETE'}>
              Delete account
            </Button>
          </div>
        </form>
      </dialog>
      {stepUp.dialog}
    </>
  );
}
