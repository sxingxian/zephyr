import {
  ADMIN8_API,
  type AdminSettingsPatch,
  type AdminSettingsResult,
  NOTICE_MESSAGE_MAX,
} from '@zephyr/shared/client';
import { Button, Card, CardHead, Chip, Field, Icon, type IconName, useToast } from '@zephyr/ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { PageState, ReasonDialog } from '../components/Kit8';
import { AdminShell } from '../components/Shell';
import { can, dateTime, fromLocalInput, toLocalInput, useAdminWrite } from '../lib/admin8';
import { api, errorMessage } from '../lib/api';
import { useAdminSession } from '../lib/session';

function Check({ ok, icon, label, value }: { ok: boolean; icon: IconName; label: string; value: ReactNode }) {
  return (
    <div className="a8-check">
      <Icon name={icon} size={17} className="a8-check__icon" />
      <span>{label}</span>
      <Chip tone={ok ? 'good' : 'warn'} dot>
        {value}
      </Chip>
    </div>
  );
}

export function Settings() {
  const { staff } = useAdminSession();
  const allowed = can(staff?.role, 'settings');
  const write = useAdminWrite();
  const toast = useToast();
  const [data, setData] = useState<AdminSettingsResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [roMsg, setRoMsg] = useState('');
  const [mMsg, setMMsg] = useState('');
  const [mFrom, setMFrom] = useState('');
  const [mTo, setMTo] = useState('');
  const [pending, setPending] = useState<{
    title: string;
    intro: string;
    label: string;
    danger?: boolean;
    patch: Omit<AdminSettingsPatch, 'reason'>;
  } | null>(null);
  const accept = useCallback((r: AdminSettingsResult) => {
    setData(r);
    setRoMsg(r.readOnly.message);
    setMMsg(r.maintenance.message);
    setMFrom(r.maintenance.startsAt ? toLocalInput(r.maintenance.startsAt) : '');
    setMTo(r.maintenance.endsAt ? toLocalInput(r.maintenance.endsAt) : '');
  }, []);
  const load = useCallback(async () => {
    try {
      accept(await api<AdminSettingsResult>(ADMIN8_API.settings));
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, [accept]);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);
  const mDatesBad = Boolean(mFrom && mTo && mFrom >= mTo);

  return (
    <AdminShell
      title="System settings"
      sub="Switches that affect everyone, and checks on how admin access is protected."
    >
      <PageState
        allowed={allowed}
        who="Owners and Admins"
        err={err}
        loading={!data}
        onRetry={() => void load()}
      >
        {data && (
          <>
            <Card aria-labelledby="ss-ro">
              <CardHead title={<span id="ss-ro">Read-only mode</span>}>
                <Chip tone={data.readOnly.on ? 'bad' : 'neutral'} dot={data.readOnly.on}>
                  {data.readOnly.on ? (data.readOnly.auto ? 'On · automatic' : 'On') : 'Off'}
                </Chip>
              </CardHead>
              <p className="z-hint">
                Pauses uploads, edits and Zephyr AI for everyone; viewing, downloads and shared galleries keep
                working. Turns on by itself if the photo store stops answering.
                {data.readOnly.on && data.readOnly.since ? ` On since ${dateTime(data.readOnly.since)}.` : ''}
              </p>
              <Field
                label="Notice shown in the app"
                size="md"
                maxLength={NOTICE_MESSAGE_MAX}
                value={roMsg}
                onChange={(e) => setRoMsg(e.target.value)}
              />
              <div className="btn-row">
                {data.readOnly.on ? (
                  <Button
                    onClick={() =>
                      setPending({
                        title: 'Turn read-only mode off',
                        intro:
                          'Uploads, edits and Zephyr AI start working again for everyone. If the store is still down, it turns back on by itself.',
                        label: 'Turn off',
                        patch: { readOnly: { on: false } },
                      })
                    }
                  >
                    Turn off
                  </Button>
                ) : (
                  <Button
                    kind="danger"
                    disabled={!roMsg.trim()}
                    onClick={() =>
                      setPending({
                        title: 'Turn read-only mode on',
                        intro:
                          'Uploads, edits and Zephyr AI pause for everyone at once, with your notice shown in the app.',
                        label: 'Turn on now',
                        danger: true,
                        patch: { readOnly: { on: true, message: roMsg.trim() } },
                      })
                    }
                  >
                    Turn on now
                  </Button>
                )}
                {data.readOnly.on && roMsg.trim() && roMsg !== data.readOnly.message && (
                  <Button
                    kind="ghost"
                    onClick={() =>
                      setPending({
                        title: 'Update the notice',
                        intro: 'Members see the new text on their next status check.',
                        label: 'Update',
                        patch: { readOnly: { on: true, message: roMsg.trim() } },
                      })
                    }
                  >
                    Update notice
                  </Button>
                )}
              </div>
            </Card>
            <Card aria-labelledby="ss-mn">
              <CardHead title={<span id="ss-mn">Maintenance notice</span>}>
                <Chip tone={data.maintenance.on ? 'acc' : 'neutral'} dot={data.maintenance.on}>
                  {data.maintenance.on ? 'On' : 'Off'}
                </Chip>
              </CardHead>
              <p className="z-hint">A calm banner in the app and on shared galleries, for planned work.</p>
              <Field
                label="Message"
                size="md"
                maxLength={NOTICE_MESSAGE_MAX}
                value={mMsg}
                onChange={(e) => setMMsg(e.target.value)}
              />
              <div className="a8-row2">
                <Field
                  label="Shows from"
                  size="md"
                  type="datetime-local"
                  value={mFrom}
                  onChange={(e) => setMFrom(e.target.value)}
                />
                <Field
                  label="Until"
                  size="md"
                  type="datetime-local"
                  value={mTo}
                  onChange={(e) => setMTo(e.target.value)}
                  error={mDatesBad ? 'After the start.' : null}
                />
              </div>
              <div className="btn-row">
                <Button
                  kind="primary"
                  disabled={!mMsg.trim() || mDatesBad}
                  onClick={() =>
                    setPending({
                      title: data.maintenance.on
                        ? 'Update the maintenance notice'
                        : 'Show the maintenance notice',
                      intro:
                        'Members and gallery guests see the banner during the times you set (or now, if no start is set).',
                      label: data.maintenance.on ? 'Update' : 'Show notice',
                      patch: {
                        maintenance: {
                          on: true,
                          message: mMsg.trim(),
                          startsAt: fromLocalInput(mFrom),
                          endsAt: fromLocalInput(mTo),
                        },
                      },
                    })
                  }
                >
                  {data.maintenance.on ? 'Update notice' : 'Show notice'}
                </Button>
                {data.maintenance.on && (
                  <Button
                    onClick={() =>
                      setPending({
                        title: 'Hide the maintenance notice',
                        intro: 'The banner goes away on the next status check.',
                        label: 'Hide',
                        patch: { maintenance: { on: false } },
                      })
                    }
                  >
                    Hide
                  </Button>
                )}
              </div>
            </Card>
            <div className="a8-split a8-split--even">
              <Card>
                <CardHead title="Admin access" />
                <Check
                  ok={data.access.accessConfigured}
                  icon="lock"
                  label="Cloudflare Access in front of /admin"
                  value={data.access.accessConfigured ? 'Checked' : 'Not set up'}
                />
                <Check
                  ok={data.access.staffWithPasskey === data.access.staffTotal}
                  icon="passkey"
                  label="Passkey required for staff"
                  value={
                    data.access.staffWithPasskey === data.access.staffTotal
                      ? `All ${data.access.staffTotal}`
                      : `${data.access.staffWithPasskey} of ${data.access.staffTotal}`
                  }
                />
                <Check ok icon="clock" label="Idle lock" value={`${data.access.idleMinutes} min`} />
              </Card>
              <Card>
                <CardHead title="Alerts" />
                <Check
                  ok={data.alerts.safetyAlertConfigured}
                  icon="shield"
                  label="Safety alerts"
                  value={data.alerts.safetyAlertConfigured ? 'Set' : 'Not set'}
                />
                <Check
                  ok={data.alerts.owners > 0}
                  icon="mail"
                  label="Owner emails for high-risk changes"
                  value={`${data.alerts.owners} ${data.alerts.owners === 1 ? 'Owner' : 'Owners'}`}
                />
                <p className="z-hint">
                  Alert addresses are set in the deployment so a compromised admin session can’t redirect
                  them.
                </p>
              </Card>
            </div>
            <ReasonDialog
              open={pending !== null}
              title={pending?.title ?? ''}
              intro={pending?.intro}
              confirmLabel={pending?.label ?? 'Save'}
              danger={pending?.danger}
              onClose={() => setPending(null)}
              onConfirm={async (reason) => {
                if (!pending) return;
                accept(
                  await write<AdminSettingsResult>(ADMIN8_API.settings, 'PATCH', {
                    ...pending.patch,
                    reason,
                  }),
                );
                toast.show('Saved', 'good');
              }}
            />
          </>
        )}
      </PageState>
    </AdminShell>
  );
}
