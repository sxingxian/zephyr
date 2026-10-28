import { APP_API, type Passkey, type PasskeyOptions, type SessionResponse } from '@zephyr/shared/client';
import { Button, Card, CardHead, Chip, Dialog, Field, Icon, Note, Spinner, useToast } from '@zephyr/ui';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { SettingsNav } from '../components/SettingsNav';
import { Shell } from '../components/Shell';
import { ApiFailure, api, errorMessage } from '../lib/api';
import { createPasskey, isCancelled, passkeysSupported } from '../lib/passkey';
import { useSession } from '../lib/session';

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;

function Row({
  icon,
  title,
  sub,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  title: string;
  sub?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="row">
      <span className="row__icon">
        <Icon name={icon} size={18} />
      </span>
      <div className="row__text">
        <span className="row__title">{title}</span>
        {sub && <span className="row__sub">{sub}</span>}
      </div>
      {children}
    </div>
  );
}

export function Security() {
  const { user, setUser, refresh, signOut } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Passkey | null>(null);
  const [newName, setNewName] = useState('');
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [name, setName] = useState(user?.displayName ?? '');
  const [savingName, setSavingName] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ passkeys: Passkey[] }>(APP_API.myPasskeys);
      setPasskeys(r.passkeys);
    } catch (e) {
      setError(errorMessage(e));
      setPasskeys([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const navigate = useNavigate();
  /** Changing passkeys needs a recent sign-in; send the member to sign in and bring them back here. */
  const reauth = (e: unknown) => {
    if (e instanceof ApiFailure && e.code === 'reauth_required') {
      toast.show(errorMessage(e), 'bad');
      navigate(`/sign-in?next=${encodeURIComponent('/settings/security')}`);
      return true;
    }
    return false;
  };

  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      const opts = await api<PasskeyOptions>(APP_API.myPasskeyOptions, { method: 'POST', body: {} });
      const credential = await createPasskey(opts);
      await api(APP_API.myPasskeyVerify, {
        method: 'POST',
        body: { challengeId: opts.challengeId, credential },
      });
      toast.show('Passkey added', 'good');
      await Promise.all([load(), refresh()]);
    } catch (e) {
      if (reauth(e)) return;
      if (!isCancelled(e))
        setError(e instanceof ApiFailure ? errorMessage(e) : 'Your device couldn’t save the passkey.');
    } finally {
      setAdding(false);
    }
  };

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (!renaming || !newName.trim()) return;
    try {
      await api(APP_API.myPasskey(renaming.id), { method: 'PATCH', body: { friendlyName: newName.trim() } });
      setRenaming(null);
      toast.show('Passkey renamed', 'good');
      await load();
    } catch (err) {
      toast.show(errorMessage(err), 'bad');
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await api(APP_API.myPasskey(removing.id), { method: 'DELETE' });
      setRemoving(null);
      toast.show('Passkey removed', 'good');
      await Promise.all([load(), refresh()]);
    } catch (err) {
      setRemoving(null);
      if (reauth(err)) return;
      toast.show(errorMessage(err), 'bad');
    }
  };

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    setSavingName(true);
    try {
      const r = await api<SessionResponse>(APP_API.me, {
        method: 'PATCH',
        body: { displayName: name.trim() || null },
      });
      setUser(r.user);
      toast.show('Name saved', 'good');
    } catch (err) {
      toast.show(errorMessage(err), 'bad');
    } finally {
      setSavingName(false);
    }
  };

  const doSignOut = async () => {
    await signOut();
    nav('/sign-in', { replace: true });
  };

  return (
    <Shell title="Settings">
      <div className="settings">
        <SettingsNav />
        <div className="settings__body">
          <Card>
            <CardHead title="Profile" />
            <form className="inline-form" onSubmit={saveName}>
              <Field
                label="Name"
                name="name"
                autoComplete="name"
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
              <Button type="submit" busy={savingName} disabled={(user?.displayName ?? '') === name.trim()}>
                Save
              </Button>
            </form>
          </Card>
          <Card>
            <CardHead title="Sign-in methods" />
            <p className="z-hint">Passkeys first; a one-time email code always works as the fallback.</p>
            <Row icon="mail" title="Email code" sub={user ? `${user.email} · verified` : null}>
              <Chip tone="good" icon="check">
                Always on
              </Chip>
            </Row>
          </Card>
          <Card>
            <CardHead title="Passkeys">
              {passkeysSupported() && (
                <Button kind="primary" size="sm" icon="plus" busy={adding} onClick={add}>
                  Add a passkey
                </Button>
              )}
            </CardHead>
            <p className="z-hint">
              Sign in with Face ID, Touch ID, Windows Hello or a security key. Nothing to type or phish.
            </p>
            {error && (
              <Note tone="warn" icon="alert" role="alert">
                {error}
              </Note>
            )}
            {passkeys === null ? (
              <Spinner size={18} label="Loading passkeys" />
            ) : passkeys.length === 0 ? (
              <Note tone="neutral" icon="passkey">
                No passkeys yet. Add one to stop waiting for email codes.
              </Note>
            ) : (
              <div>
                {passkeys.map((p) => (
                  <Row
                    key={p.id}
                    icon="passkey"
                    title={p.friendlyName || 'Passkey'}
                    sub={`Added ${fmt(p.createdAt)}${p.lastUsedAt ? ` · last used ${fmt(p.lastUsedAt)}` : ''}`}
                  >
                    <span className="row__actions">
                      <Button
                        kind="ghost"
                        size="sm"
                        onClick={() => {
                          setRenaming(p);
                          setNewName(p.friendlyName ?? '');
                        }}
                      >
                        Rename
                      </Button>
                      <Button kind="ghost" size="sm" onClick={() => setRemoving(p)}>
                        Remove
                      </Button>
                    </span>
                  </Row>
                ))}
              </div>
            )}
          </Card>
          <Card>
            <Row icon="logout" title="Sign out" sub="Signs out of Zephyr on this device.">
              <Button kind="danger" size="sm" icon="logout" onClick={doSignOut}>
                Sign out
              </Button>
            </Row>
          </Card>
        </div>
      </div>

      <Dialog
        open={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        title="Rename passkey"
        footer={
          <>
            <Button kind="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button kind="primary" type="submit" form="rename-form">
              Save
            </Button>
          </>
        }
      >
        <form id="rename-form" onSubmit={rename}>
          <Field
            label="Name"
            maxLength={120}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Work laptop"
          />
        </form>
      </Dialog>
      <Dialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title="Remove this passkey?"
        footer={
          <>
            <Button kind="ghost" onClick={() => setRemoving(null)}>
              Keep it
            </Button>
            <Button kind="danger" onClick={remove}>
              Remove
            </Button>
          </>
        }
      >
        <p>
          You won’t be able to sign in with <strong>{removing?.friendlyName || 'this passkey'}</strong> any
          more. Email codes still work.
        </p>
      </Dialog>
    </Shell>
  );
}
