import { ACCOUNT_DELETION_DAYS } from '@zephyr/shared/client';
import { Button, buttonClass, Chip, Note } from '@zephyr/ui';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { AuthLayout } from '../components/AuthLayout';
import { errorMessage } from '../lib/api';
import { shortDate } from '../lib/format';
import { restoreAccount } from '../lib/library';
import { useSession } from '../lib/session';

/** Shown instead of every signed-in page while the account is scheduled for deletion. */
export function AccountScheduled({ purgeAt }: { purgeAt: string }) {
  const { user, setUser, signOut } = useSession();
  const nav = useNavigate();
  const [busy, setBusy] = useState<'restore' | 'out' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = new Date(new Date(purgeAt).getTime() - ACCOUNT_DELETION_DAYS * 86_400_000).toISOString();

  const restore = async () => {
    setBusy('restore');
    setError(null);
    try {
      const r = await restoreAccount();
      setUser(r.user);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };
  const leave = async () => {
    setBusy('out');
    await signOut();
    nav('/sign-in', { replace: true });
  };

  return (
    <AuthLayout pose="ponder" line="Missed you already." tone="lilac" footer={false}>
      <Chip tone="warn" icon="clock" size="lg" className="self-start">
        Scheduled for deletion
      </Chip>
      <div className="auth__head">
        <h1>Restore your account?</h1>
        <p>
          You asked to delete <strong className="strong">{user?.email}</strong> on {shortDate(asked)}. Your
          photos are kept until <strong className="strong">{shortDate(purgeAt)}</strong>, then deleted for
          good.
        </p>
      </div>
      {error && (
        <Note tone="bad" icon="alert" role="alert">
          {error}
        </Note>
      )}
      <Button
        kind="primary"
        size="lg"
        full
        icon="undo"
        busy={busy === 'restore'}
        disabled={busy !== null}
        onClick={restore}
      >
        Restore my account
      </Button>
      <Button kind="ghost" size="lg" full busy={busy === 'out'} disabled={busy !== null} onClick={leave}>
        Keep it deleted and sign out
      </Button>
    </AuthLayout>
  );
}

/** After deleting: the member is signed out everywhere; say what happens next. */
export function AccountDeleted() {
  const { setUser } = useSession();
  const loc = useLocation();
  const deleted = (loc.state as { deleted?: boolean } | null)?.deleted === true;
  useEffect(() => {
    if (deleted) setUser(null);
  }, [deleted, setUser]);
  const purgeAt = (() => {
    try {
      return sessionStorage.getItem('zephyr.purgeAt');
    } catch {
      return null;
    }
  })();
  return (
    <AuthLayout pose="wave" line="Thanks for flying with us." tone="sky" footer={false}>
      <div className="auth__head">
        <h1>Your account is closed</h1>
        <p>
          You’re signed out everywhere.
          {purgeAt
            ? ` Your photos are kept until ${shortDate(purgeAt)}, then deleted for good.`
            : ` Your photos are kept for ${ACCOUNT_DELETION_DAYS} days, then deleted for good.`}{' '}
          Changed your mind? Sign in before then and choose Restore.
        </p>
      </div>
      <Link className={buttonClass({ kind: 'secondary', size: 'lg', full: true })} to="/sign-in">
        Sign in to restore
      </Link>
    </AuthLayout>
  );
}
