import {
  ACCOUNT_ACTION_MINUTES,
  ACCOUNT_DELETION_DAYS,
  type AccountActionPeek,
  APP_API,
  type Passkey,
  type PasskeyOptions,
} from '@zephyr/shared/client';
import { Button, Note, Spinner } from '@zephyr/ui';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AuthHead, AuthLayout } from '../components/AuthLayout';
import { NoAdsSurface } from '../components/ads/NoAdsSurface';
import {
  accountActionHeaders,
  forgetAccountActionToken,
  peekAccountAction,
  takeAccountActionToken,
} from '../lib/accountActions';
import { ApiFailure, api, errorMessage } from '../lib/api';
import { deleteAccount } from '../lib/library';
import { createPasskey, isCancelled, passkeysSupported } from '../lib/passkey';
import { useSession } from '../lib/session';
import { browser, endSession } from '../lib/sessionGuard';

type State =
  | { kind: 'missing' }
  | { kind: 'signed_out' }
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'wrong_member' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; action: AccountActionPeek; passkeyName: string | null }
  | { kind: 'done'; op: AccountActionPeek['op'] };

const AGAIN = 'Ask again from Settings › Security.';

/**
 * /account-action: the page an emailed account action link opens (phase 8, review round 4). Adding or removing a
 * passkey and deleting the account are made here and nowhere else: the link's token (from the URL fragment,
 * stripped at once) goes with the change, so Google's AdSense script, which runs in Free members' library pages,
 * can't make these changes even though it acts with their session. Never an ad page; the strict CSP; the token
 * is kept in memory only and forgotten once spent or when the page is left.
 */
export function AccountActionPage() {
  const { user } = useSession();
  const nav = useNavigate();
  const token = useRef<string | null | undefined>(undefined);
  if (token.current === undefined) token.current = takeAccountActionToken();
  const [state, setState] = useState<State>(() =>
    !token.current ? { kind: 'missing' } : user ? { kind: 'loading' } : { kind: 'signed_out' },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => forgetAccountActionToken(), []);

  useEffect(() => {
    const t = token.current;
    if (!t) return;
    if (!user) {
      setState({ kind: 'signed_out' });
      return;
    }
    let live = true;
    setState({ kind: 'loading' });
    (async () => {
      try {
        const action = await peekAccountAction(t);
        let passkeyName: string | null = null;
        if (action.op === 'passkey_remove' && action.passkeyId) {
          const r = await api<{ passkeys: Passkey[] }>(APP_API.myPasskeys);
          passkeyName = r.passkeys.find((p) => p.id === action.passkeyId)?.friendlyName ?? null;
        }
        if (live) setState({ kind: 'ready', action, passkeyName });
      } catch (e) {
        if (!live) return;
        if (e instanceof ApiFailure && e.code === 'account_action_wrong_member')
          setState({ kind: 'wrong_member' });
        else if (e instanceof ApiFailure && e.code === 'account_action_invalid')
          setState({ kind: 'invalid' });
        else setState({ kind: 'error', message: errorMessage(e) });
      }
    })();
    return () => {
      live = false;
    };
  }, [user]);

  const spent = (e: unknown): boolean => {
    if (
      e instanceof ApiFailure &&
      (e.code === 'account_action_invalid' || e.code === 'account_action_required')
    ) {
      forgetAccountActionToken();
      setState({ kind: 'invalid' });
      return true;
    }
    return false;
  };

  const addPasskey = async () => {
    const t = token.current;
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The link is spent on the options call; only this challenge can then be completed.
      const opts = await api<PasskeyOptions>(APP_API.myPasskeyOptions, {
        method: 'POST',
        body: {},
        headers: accountActionHeaders(t),
      });
      forgetAccountActionToken();
      token.current = null;
      const credential = await createPasskey(opts);
      await api(APP_API.myPasskeyVerify, {
        method: 'POST',
        body: { challengeId: opts.challengeId, credential },
      });
      setState({ kind: 'done', op: 'passkey_add' });
    } catch (e) {
      if (spent(e)) return;
      setError(
        isCancelled(e)
          ? `The passkey wasn’t saved, and this link is now used. ${AGAIN}`
          : e instanceof ApiFailure
            ? errorMessage(e)
            : `Your device couldn’t save the passkey. ${AGAIN}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const removePasskey = async (id: string) => {
    const t = token.current;
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(APP_API.myPasskey(id), { method: 'DELETE', headers: accountActionHeaders(t) });
      forgetAccountActionToken();
      token.current = null;
      setState({ kind: 'done', op: 'passkey_remove' });
    } catch (e) {
      if (!spent(e)) setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteNow = async () => {
    const t = token.current;
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await deleteAccount(accountActionHeaders(t));
      forgetAccountActionToken();
      token.current = null;
      try {
        sessionStorage.setItem('zephyr.purgeAt', r.purgeAt);
      } catch {
        // storage unavailable: the confirmation page falls back to "30 days"
      }
      // The server has already signed out every session: stop this member's uploads (nothing is sent), then load
      // the confirmation page afresh so no photo data stays in memory.
      await endSession('deleted', false);
      nav('/account-deleted', { replace: true, state: { deleted: true } });
      browser.assign('/account-deleted');
    } catch (e) {
      if (!spent(e)) setError(errorMessage(e));
      setBusy(false);
    }
  };

  if (state.kind === 'loading') {
    return (
      <AuthLayout pose="hop" line="Checking your link…" footer={false}>
        <div className="center-block">
          <Spinner size={24} label="Checking your link" />
        </div>
      </AuthLayout>
    );
  }
  if (state.kind === 'done') {
    const title =
      state.op === 'passkey_add'
        ? 'Passkey added'
        : state.op === 'passkey_remove'
          ? 'Passkey removed'
          : 'Done';
    return (
      <AuthLayout pose="wave" line="All set." footer={false}>
        <AuthHead title={title}>
          {state.op === 'passkey_add'
            ? 'You can now sign in with it. We’ve emailed you a note about the change.'
            : 'It no longer signs you in. We’ve emailed you a note about the change.'}
        </AuthHead>
        <Link to="/settings/security" className="z-btn z-btn--primary z-btn--lg z-btn--full">
          Back to Settings
        </Link>
      </AuthLayout>
    );
  }
  if (state.kind !== 'ready') {
    const [title, body] =
      state.kind === 'signed_out'
        ? [
            'Sign in to continue',
            'This link only works while you’re signed in to the account it was sent to. Sign in, then open the link from the email again.',
          ]
        : state.kind === 'wrong_member'
          ? [
              'This link is for another account',
              'Sign out, sign in as the account the email was sent to, then open the link again.',
            ]
          : state.kind === 'invalid'
            ? [
                'This link doesn’t work any more',
                `It may have expired (links last ${ACCOUNT_ACTION_MINUTES} minutes), been used, or been replaced by a newer one. ${AGAIN}`,
              ]
            : state.kind === 'missing'
              ? ['This link looks incomplete', `Open it straight from the email. ${AGAIN}`]
              : ['We couldn’t open this link', state.message];
    return (
      <AuthLayout pose="ponder" line="That link blew away." footer={false}>
        <AuthHead title={title}>{body}</AuthHead>
        <Link
          to={user ? '/settings/security' : '/sign-in'}
          className="z-btn z-btn--primary z-btn--lg z-btn--full"
        >
          {user ? 'Go to Settings' : 'Sign in'}
        </Link>
      </AuthLayout>
    );
  }

  const { action, passkeyName } = state;
  return (
    <AuthLayout pose="wave" line="One more step." footer={false}>
      <NoAdsSurface>
        {action.op === 'passkey_add' ? (
          <>
            <AuthHead title="Add a passkey">
              Save a passkey on <strong>this device</strong>, signed in as <strong>{user?.email}</strong>.
              You’ll then sign in with Face ID, Touch ID, Windows Hello or a security key.
            </AuthHead>
            {passkeysSupported() ? (
              <Button kind="primary" size="lg" full icon="passkey" busy={busy} onClick={addPasskey}>
                Add a passkey
              </Button>
            ) : (
              <Note tone="neutral">
                This browser can’t save passkeys. Open the link on the device you want to use, or ask for a
                new link there.
              </Note>
            )}
          </>
        ) : action.op === 'passkey_remove' ? (
          <>
            <AuthHead title="Remove this passkey?">
              <strong>{passkeyName || 'This passkey'}</strong> will no longer sign you in to{' '}
              <strong>{user?.email}</strong>. Email codes still work.
            </AuthHead>
            <Button
              kind="danger"
              size="lg"
              full
              busy={busy}
              onClick={() => action.passkeyId && removePasskey(action.passkeyId)}
            >
              Remove passkey
            </Button>
          </>
        ) : (
          <>
            <AuthHead title="Delete your Zephyr account?">
              <strong>{user?.email}</strong> is closed straight away and signed out everywhere. For{' '}
              {ACCOUNT_DELETION_DAYS} days you can sign in and restore everything; after that your photos,
              albums and edits are deleted for good.
            </AuthHead>
            <Button kind="danger" size="lg" full icon="trash" busy={busy} onClick={deleteNow}>
              Delete my account
            </Button>
          </>
        )}
        {error && (
          <Note tone="warn" icon="alert" role="alert">
            {error}
          </Note>
        )}
        <Link to="/settings/security" className="z-btn z-btn--ghost z-btn--lg z-btn--full">
          Cancel
        </Link>
      </NoAdsSurface>
    </AuthLayout>
  );
}
