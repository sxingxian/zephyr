import { APP_API, type InviteRow, type MemberInvites } from '@zephyr/shared/client';
import { Button, Card, CardHead, Chip, Field, Note, Spinner, useToast } from '@zephyr/ui';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { SettingsNav } from '../components/SettingsNav';
import { Shell } from '../components/Shell';
import { ApiFailure, api, errorMessage } from '../lib/api';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STATUS_TONE = { pending: 'acc', accepted: 'good', expired: 'neutral', revoked: 'bad' } as const;
const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** Members can invite a few people a month, when admins allow it. */
export function InviteFriends() {
  const toast = useToast();
  const [data, setData] = useState<MemberInvites | null>(null);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<MemberInvites>(APP_API.myInvites));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const m = email.trim().toLowerCase();
    if (!EMAIL_RE.test(m)) {
      setError('Enter an email address like name@example.com.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await api<{ invite: InviteRow }>(APP_API.memberInvite, {
        method: 'POST',
        body: { email: m },
      });
      setEmail('');
      toast.show(`Invite sent to ${m}`, 'good');
      await load();
    } catch (err) {
      setError(
        err instanceof ApiFailure && err.code === 'conflict'
          ? 'You’ve already invited that address.'
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Settings">
      <div className="settings">
        <SettingsNav />
        <div className="settings__body">
          <Card>
            <CardHead title="Invite friends">
              {data?.enabled && (
                <Chip tone="acc">
                  {data.remaining} of {data.perMonth} left this month
                </Chip>
              )}
            </CardHead>
            {data === null && !error && <Spinner size={18} label="Loading" />}
            {data && !data.enabled && <Note tone="neutral">Member invites are turned off right now.</Note>}
            {data?.enabled && (
              <form className="stack" onSubmit={send} noValidate>
                <p className="z-hint">
                  They get a single-use link that works only for their address and expires after 7 days.
                </p>
                <Field
                  label="Their email"
                  type="email"
                  icon="mail"
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="friend@example.com"
                />
                <Button
                  type="submit"
                  kind="primary"
                  icon="mail"
                  busy={busy}
                  disabled={data.remaining <= 0}
                  className="self-start"
                >
                  Send invite
                </Button>
              </form>
            )}
            {error && (
              <Note tone="warn" icon="alert" role="alert">
                {error}
              </Note>
            )}
          </Card>
          {data && data.invites.length > 0 && (
            <Card>
              <CardHead title="Your invites" />
              <ul className="plain-list">
                {data.invites.map((i) => (
                  <li key={i.id} className="row">
                    <div className="row__text">
                      <span className="row__title z-mono">{i.email}</span>
                      <span className="row__sub">
                        Sent {fmt(i.createdAt)} · expires {fmt(i.expiresAt)}
                      </span>
                    </div>
                    <Chip tone={STATUS_TONE[i.status]} dot>
                      {i.status[0]?.toUpperCase() + i.status.slice(1)}
                    </Chip>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </Shell>
  );
}
