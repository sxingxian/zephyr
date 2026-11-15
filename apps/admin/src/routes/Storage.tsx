import {
  ADMIN8_API,
  type AdminStorageResult,
  type MigrationState,
  STORAGE_FOLLOWUP_MAX_DAYS,
  STORAGE_FREE_ALERT,
  STORAGE_HOLD_DAYS,
  type StoreConnection,
  type StoreHealth,
  type StoreStatus,
} from '@zephyr/shared/client';
import {
  Button,
  Card,
  CardHead,
  Chip,
  type ChipTone,
  type Column,
  type IconName,
  Note,
  Table,
  useToast,
} from '@zephyr/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Effects, Kpi, PageState, Progress, ReasonDialog } from '../components/Kit8';
import { AdminShell } from '../components/Shell';
import { can, dateTime, formatBytes, n, useAdminWrite, writeError } from '../lib/admin8';
import { api, errorMessage } from '../lib/api';
import { useAdminSession } from '../lib/session';

/** How often the page refreshes while photos are moving. */
export const STORAGE_POLL_MS = 10_000;
const ACTIVE: MigrationState[] = ['copying', 'verifying', 'holding', 'rolling_back', 'paused', 'failed'];
const MOVING: MigrationState[] = ['copying', 'verifying', 'rolling_back'];
const HEALTH: Record<StoreHealth, [string, ChipTone]> = {
  healthy: ['Healthy', 'good'],
  degraded: ['Degraded', 'warn'],
  unreachable: ['Unreachable', 'bad'],
  unknown: ['Not checked', 'neutral'],
};
const CONNECTION: Record<StoreConnection, string> = {
  binding: 'Worker binding',
  https: 'HTTPS · keys in Worker secrets',
  vpc: 'Workers VPC · Tunnel, no public hostname',
  tunnel: 'Tunnel hostname + Access service token',
};
const STATE: Record<MigrationState, [string, ChipTone]> = {
  copying: ['Copying', 'acc'],
  paused: ['Paused', 'warn'],
  verifying: ['Checking copies', 'acc'],
  holding: [`Holding old copies`, 'acc'],
  done: ['Done', 'good'],
  rolling_back: ['Rolling back', 'warn'],
  rolled_back: ['Rolled back', 'neutral'],
  failed: ['Failed', 'bad'],
};
/** Plain words for the migration's last error codes that need a person (anything else shows as its code). */
export const MIGRATION_ERROR_TEXT: Record<string, string> = {
  publish_stuck:
    'A photo has been publishing its thumbnails for more than a day. The clean-up job gives up on them after 3 days; retry after that.',
  upload_stuck:
    'A photo has been uploading for more than a day. Expired uploads are removed by the clean-up job; retry once it has run.',
  busy: 'A photo kept changing while it was being copied (it was edited non-stop). Retry when it’s quieter, or turn on read-only mode briefly.',
  abandoned: 'Old copies on a store that can’t be reached were abandoned by an Owner.',
  rollback_abandoned: 'An Owner gave up this rollback; photos not copied back stayed where they were.',
};
const kindLabel = (s: StoreStatus) =>
  s.kind === 'r2'
    ? 'Cloudflare'
    : s.connection === 'vpc' || s.connection === 'tunnel'
      ? 'On premises'
      : 'S3-compatible cloud';

/** Monthly cost of `bytes` on a store (decimal TB, like the deployment config). */
export function monthlyCost(s: StoreStatus, bytes: number): number | null {
  return s.costPerTbMonthUsd == null ? null : (bytes / 1e12) * s.costPerTbMonthUsd;
}
const usd = (v: number | null) =>
  v == null ? 'Not declared' : `~US$${Math.round(v).toLocaleString('en-GB')} / month`;
const freeShare = (s: StoreStatus) =>
  s.lastCheck?.freeBytes != null && s.lastCheck.capacityBytes
    ? s.lastCheck.freeBytes / s.lastCheck.capacityBytes
    : null;
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 1
    ? 'just now'
    : m < 60
      ? `${m} min ago`
      : m < 48 * 60
        ? `${Math.round(m / 60)} h ago`
        : dateTime(iso);
};

function CheckPanel({ s }: { s: StoreStatus }) {
  const c = s.lastCheck;
  const free = freeShare(s);
  return (
    <Card aria-labelledby="st-check">
      <CardHead title={<span id="st-check">Health check · {s.name}</span>}>
        {c && (
          <Chip tone={c.reachable && c.roundTrip ? 'good' : 'bad'}>
            {c.reachable && c.roundTrip ? `Passed ${ago(c.at)}` : `Failed ${ago(c.at)}`}
          </Chip>
        )}
      </CardHead>
      {!c ? (
        <p className="z-hint">Not checked yet. Run a health check before switching to this store.</p>
      ) : (
        <div className="a8-kv a8-kv--rows">
          <div>
            <span>Reachable through {CONNECTION[s.connection]}</span>
            <strong>{c.reachable ? (c.latencyMs != null ? `${c.latencyMs} ms` : 'Yes') : 'No'}</strong>
          </div>
          <div>
            <span>Signed write, read and delete of a test object</span>
            <strong>{c.roundTrip ? 'Passed' : 'Failed'}</strong>
          </div>
          <div>
            <span>Upload speed</span>
            <strong>{c.uploadMBps != null ? `${c.uploadMBps} MB/s` : '—'}</strong>
          </div>
          <div>
            <span>Encryption at rest</span>
            <strong>{s.encryptionAtRest ? 'Confirmed by you' : 'Not confirmed'}</strong>
          </div>
          {free != null && (
            <div>
              <span>Free space</span>
              <strong className={free < STORAGE_FREE_ALERT ? 'a8-down' : undefined}>
                {Math.round(free * 100)}% · alert below {Math.round(STORAGE_FREE_ALERT * 100)}%
              </strong>
            </div>
          )}
          {c.error && (
            <div>
              <span>Error</span>
              <strong className="z-mono">{c.error}</strong>
            </div>
          )}
        </div>
      )}
      {(s.connection === 'vpc' || s.connection === 'tunnel') && (
        <p className="z-hint">
          On premises, you look after redundancy, backups, monitoring and space. If the store stops answering,
          Zephyr turns uploads off and shows a notice; photos still in the Cloudflare cache keep loading.
        </p>
      )}
    </Card>
  );
}

export function Storage() {
  const { staff } = useAdminSession();
  const allowed = can(staff?.role, 'storage');
  const write = useAdminWrite();
  const toast = useToast();
  const [data, setData] = useState<AdminStorageResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const [switching, setSwitching] = useState<StoreStatus | null>(null);
  const [migAction, setMigAction] = useState<'pause' | 'resume' | 'rollback' | null>(null);
  const [abandoning, setAbandoning] = useState<{
    storeId: string;
    copies: number;
    endsRollback?: boolean;
    /** The unreachable stores the copies' photos are on, when the store itself answers. */
    via?: string[];
  } | null>(null);
  const [givingUp, setGivingUp] = useState(false);
  const isOwner = staff?.role === 'owner';
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<AdminStorageResult>(ADMIN8_API.storage));
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);
  // Poll while a migration is under way; stop when it settles or the page goes away.
  const state = data?.migration?.state;
  useEffect(() => {
    if (!state || !ACTIVE.includes(state)) return;
    timer.current = setInterval(() => void load(), STORAGE_POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [state, load]);

  const mig = data?.migration ?? null;
  const migActive = Boolean(mig && ACTIVE.includes(mig.state));
  const byId = (id: string) => data?.stores.find((s) => s.id === id);
  // A store that's no longer set up, or whose last check didn't answer or couldn't do a round trip.
  const isGone = (id: string) => {
    const st = byId(id);
    return !st || st.health === 'unreachable' || (st.lastCheck != null && !st.lastCheck.roundTrip);
  };
  const current = data ? byId(data.writeStore) : undefined;
  const runCheck = async (s: StoreStatus) => {
    setChecking(s.id);
    setActErr(null);
    try {
      setData(await write<AdminStorageResult>(ADMIN8_API.storageCheck(s.id), 'POST'));
      setSelected(s.id);
    } catch (e) {
      setActErr(writeError(e));
    } finally {
      setChecking(null);
    }
  };
  const latestCheck = data?.stores
    .map((s) => s.lastCheck?.at)
    .filter((x): x is string => Boolean(x))
    .sort()
    .at(-1);
  const allOk = data?.stores.every((s) => s.health === 'healthy');

  const cols: Column<StoreStatus>[] = [
    {
      key: 's',
      header: 'Store',
      cell: (s) => (
        <span className="a8-cell2">
          <strong>{s.name}</strong>
          <span className="z-hint">{kindLabel(s)}</span>
        </span>
      ),
    },
    {
      key: 'c',
      header: 'Connection',
      cell: (s) => <span className="z-hint">{CONNECTION[s.connection]}</span>,
    },
    {
      key: 'h',
      header: 'Health',
      cell: (s) => (
        <span className="a8-cell2">
          <Chip tone={HEALTH[s.health][1]} dot>
            {HEALTH[s.health][0]}
          </Chip>
          {s.health === 'unreachable' && s.lastCheck && (
            <span className="z-hint">Last checked {ago(s.lastCheck.at)}</span>
          )}
        </span>
      ),
    },
    {
      key: 'x',
      header: 'Space and cost',
      cell: (s) => {
        const free = freeShare(s);
        return (
          <span className="a8-cell2">
            <span>
              {free != null && s.lastCheck?.freeBytes != null && s.lastCheck.capacityBytes
                ? `${formatBytes(s.lastCheck.freeBytes)} of ${formatBytes(s.lastCheck.capacityBytes)} free`
                : usd(monthlyCost(s, data?.totals.bytes ?? 0))}
            </span>
            <span className={`z-hint${free != null && free < STORAGE_FREE_ALERT ? ' a8-down' : ''}`}>
              {free != null
                ? `${Math.round(free * 100)}% free · alert below ${Math.round(STORAGE_FREE_ALERT * 100)}%`
                : (s.egressNote ?? '')}
            </span>
          </span>
        );
      },
    },
    {
      key: 'a',
      header: <span className="z-sr">Actions</span>,
      cell: (s) => {
        if (mig && migActive && s.id === mig.from) return <Chip tone="outline">Copying from</Chip>;
        if (mig && migActive && s.id === mig.to) return <Chip tone="acc">Copying to</Chip>;
        return (
          <span className="btn-row btn-row--tight">
            {s.id === data?.writeStore && <Chip tone="ink">Current</Chip>}
            <Button
              size="sm"
              kind="ghost"
              icon="refresh"
              busy={checking === s.id}
              onClick={() => runCheck(s)}
              aria-label={`Run health check on ${s.name}`}
            >
              Check
            </Button>
            {s.id !== data?.writeStore && (
              <Button
                size="sm"
                disabled={migActive || s.health !== 'healthy' || !s.encryptionAtRest}
                title={
                  s.health !== 'healthy'
                    ? 'Run a passing health check first'
                    : !s.encryptionAtRest
                      ? 'Encryption at rest isn’t confirmed'
                      : undefined
                }
                onClick={() => setSwitching(s)}
              >
                Switch to this…
              </Button>
            )}
          </span>
        );
      },
    },
  ];
  const sel = (selected && byId(selected)) || data?.stores.find((s) => s.lastCheck) || null;
  const to = switching;
  const nowCost = current ? monthlyCost(current, data?.totals.bytes ?? 0) : null;
  const newCost = to ? monthlyCost(to, data?.totals.bytes ?? 0) : null;

  return (
    <AdminShell
      title="Storage"
      sub="Where photos are kept. Switching moves everything in the background and can be paused or rolled back."
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
            {data.autoReadOnly && (
              <Note tone="bad" icon="alert" role="alert">
                The current store stopped answering, so uploads are off and members see a notice. Reads from
                the Cloudflare cache keep working. Check the store, then turn read-only off in System
                settings.
              </Note>
            )}
            <div className="ai-tiles">
              <Kpi
                label="Photos stored"
                value={formatBytes(data.totals.bytes)}
                note={`${n(data.totals.photos)} photos`}
                icon="database"
              />
              <Kpi
                label={migActive ? 'New uploads go to' : 'Current store'}
                value={current?.name ?? data.writeStore}
                note={current ? kindLabel(current) : undefined}
                icon="server"
              />
              <Kpi
                label="Guest images"
                value="Cloudflare cache"
                note="CSAM scanning still applies"
                icon="shield"
              />
              <Kpi
                label="Last health check"
                value={latestCheck ? ago(latestCheck) : 'Never'}
                note={allOk ? 'All stores reachable' : 'A store needs attention'}
                tone={allOk ? 'good' : 'warn'}
                icon="check"
              />
            </div>
            {actErr && (
              <Note tone="bad" icon="alert" role="alert">
                {actErr}
              </Note>
            )}
            {mig && mig.state !== 'done' && mig.state !== 'rolled_back' && (
              <Card aria-labelledby="st-mig">
                <CardHead
                  title={
                    <span id="st-mig">
                      Moving photos: {byId(mig.from)?.name ?? mig.from} → {byId(mig.to)?.name ?? mig.to}
                    </span>
                  }
                >
                  <Chip tone={STATE[mig.state][1]} dot={MOVING.includes(mig.state)}>
                    {STATE[mig.state][0]}
                    {mig.photos.total
                      ? ` · ${Math.floor((mig.photos.copied / mig.photos.total) * 100)}%`
                      : ''}
                  </Chip>
                </CardHead>
                <div className="a8-steps">
                  <div>
                    <strong>New uploads go to {byId(mig.to)?.name ?? mig.to}</strong>
                    <span className="z-hint">
                      Since {dateTime(mig.startedAt)}. Each object records which store holds it.
                    </span>
                  </div>
                  <div>
                    <strong>Copying existing photos</strong>
                    <Progress
                      pct={mig.photos.total ? (mig.photos.copied / mig.photos.total) * 100 : 0}
                      label="Photos copied"
                    />
                    <span className="z-hint">
                      {n(mig.photos.copied)} of {n(mig.photos.total)} photos · {formatBytes(mig.bytes.copied)}{' '}
                      of about {formatBytes(mig.bytes.total)}
                      {mig.photos.failed ? ` · ${n(mig.photos.failed)} need retry` : ''}
                      {mig.photos.waiting
                        ? ` · ${n(mig.photos.waiting)} waiting for uploads in progress to finish`
                        : ''}
                    </span>
                  </div>
                  <div>
                    <strong>Checking every copy</strong>
                    <Progress
                      pct={mig.photos.total ? (mig.photos.verified / mig.photos.total) * 100 : 0}
                      label="Copies verified"
                      tone="good"
                    />
                    <span className="z-hint">
                      Each copy’s checksum is compared with the original before it counts as moved ·{' '}
                      {n(mig.photos.verified)} verified
                    </span>
                  </div>
                  <div>
                    <strong>Removing the old copies</strong>
                    <span className="z-hint">
                      {mig.deleteOldAfter
                        ? `Not before ${dateTime(mig.deleteOldAfter)}.`
                        : `Only after everything is verified, plus ${STORAGE_HOLD_DAYS} days in case you roll back.`}
                    </span>
                  </div>
                </div>
                {mig.lastError && (
                  <Note tone="warn" icon="alert">
                    Last error: <span className="z-mono">{mig.lastError}</span>
                    {MIGRATION_ERROR_TEXT[mig.lastError] ? ` · ${MIGRATION_ERROR_TEXT[mig.lastError]}` : ''}
                  </Note>
                )}
                {migActive && (
                  <div className="btn-row">
                    {mig.state === 'paused' || mig.state === 'failed' ? (
                      <Button icon="play" onClick={() => setMigAction('resume')}>
                        {mig.state === 'failed' ? 'Retry failed photos' : 'Resume copying'}
                      </Button>
                    ) : (
                      (mig.state === 'copying' || mig.state === 'rolling_back') && (
                        <Button icon="pause" onClick={() => setMigAction('pause')}>
                          Pause copying
                        </Button>
                      )
                    )}
                    {mig.canRollBack && (
                      <Button kind="danger" icon="undo" onClick={() => setMigAction('rollback')}>
                        Roll back to {byId(mig.from)?.name ?? mig.from}…
                      </Button>
                    )}
                    {isOwner && mig.direction === 'back' && mig.state === 'failed' && (
                      <Button kind="danger" icon="alert" onClick={() => setGivingUp(true)}>
                        Give up rollback…
                      </Button>
                    )}
                  </div>
                )}
                <p className="z-hint">
                  {mig.direction === 'back'
                    ? `Rolling back: new uploads go to ${byId(mig.from)?.name ?? mig.from}, and photos stored on ${byId(mig.to)?.name ?? mig.to} are copied back. A rollback can't itself be rolled back.`
                    : mig.canRollBack
                      ? `Rolling back sends new uploads to ${byId(mig.from)?.name ?? mig.from} again and copies anything stored only on ${byId(mig.to)?.name ?? mig.to} back first.`
                      : `Old copies on ${byId(mig.from)?.name ?? mig.from} are being deleted, so this move can no longer be rolled back.`}{' '}
                  Photos keep working during every step: each one is read from whichever store holds it.
                </p>
              </Card>
            )}
            {(data.oldCopies ?? []).length > 0 && (
              <Card aria-labelledby="st-old">
                <CardHead title={<span id="st-old">Old copies waiting for deletion</span>} />
                <div className="a8-kv a8-kv--rows">
                  {(data.oldCopies ?? []).map((o) => {
                    const st = byId(o.storeId);
                    const gone = isGone(o.storeId);
                    const via = gone ? [] : (o.targets ?? []).filter(isGone);
                    return (
                      <div key={o.storeId}>
                        <span>
                          {st?.name ?? o.storeId}
                          {!st
                            ? ' · no longer set up'
                            : gone
                              ? ` · last check failed${st.lastCheck ? ` (${dateTime(st.lastCheck.at)})` : ''}`
                              : via.length
                                ? ` · waiting on ${via.map((t) => byId(t)?.name ?? t).join(', ')}, which can’t be reached`
                                : ''}
                        </span>
                        <strong className="btn-row btn-row--tight">
                          {n(o.copies)} {o.copies === 1 ? 'copy' : 'copies'}
                          {isOwner && (gone || via.length > 0) && (
                            <Button size="sm" kind="danger" onClick={() => setAbandoning({ ...o, via })}>
                              Abandon…
                            </Button>
                          )}
                        </strong>
                      </div>
                    );
                  })}
                </div>
                <p className="z-hint">
                  The clean-up job deletes these after the hold, first copying anything missing to the store
                  each photo is on now. If either store can’t be reached it never can, and no new switch can
                  start until they’re gone: an Owner can abandon them. Zephyr checks the stores again first
                  and refuses if they answer. Nothing is deleted there.
                </p>
              </Card>
            )}
            {(data.stranded ?? [])
              .filter((x) => x.photos > 0 && isGone(x.storeId))
              .map((x) => (
                <Note key={`stranded-${x.storeId}`} tone="bad" icon="alert">
                  {n(x.photos)} {x.photos === 1 ? 'photo is' : 'photos are'} still read from{' '}
                  {byId(x.storeId)?.name ?? x.storeId}, so {x.photos === 1 ? 'it' : 'they'} can’t be shown
                  while it’s unreachable (left there when a rollback was given up). Any copy elsewhere is
                  kept, and {x.photos === 1 ? 'it comes' : 'they come'} back if the store does.
                </Note>
              ))}
            {(data.followups?.dropped30d ?? 0) > 0 && (
              <Note tone="warn" icon="alert">
                {n(data.followups?.dropped30d ?? 0)} follow-up{' '}
                {data.followups?.dropped30d === 1 ? 'copy was' : 'copies were'} dropped in the last 30 days
                after {STORAGE_FOLLOWUP_MAX_DAYS} days of retries: an edited variant or mask written during a
                move may be missing on its photo’s store. The audit log lists the stores.
              </Note>
            )}
            {(data.followups?.pending ?? 0) > 0 && (
              <p className="z-hint">
                {n(data.followups?.pending ?? 0)} follow-up{' '}
                {data.followups?.pending === 1 ? 'copy' : 'copies'} (objects written while photos moved)
                waiting to reach their photo’s store.
              </p>
            )}
            <Card>
              <CardHead title="Stores set up for this deployment" />
              <Table
                columns={cols}
                rows={data.stores}
                rowKey={(s) => s.id}
                caption="Storage stores"
                minWidth={860}
              />
              <p className="z-hint">
                Stores and their keys are set up in the deployment (docs/setup.md §3.8), never typed into this
                screen. Here you check them, compare costs and switch.
              </p>
            </Card>
            {sel && <CheckPanel s={sel} />}
            <ReasonDialog
              open={to !== null}
              title={to ? `Switch storage to ${to.name}` : 'Switch storage'}
              intro={
                to && (
                  <>
                    <div className="a8-kv">
                      <div>
                        <span>Moves</span>
                        <strong>
                          {formatBytes(data.totals.bytes)} · {n(data.totals.photos)} photos
                        </strong>
                      </div>
                      <div>
                        <span>Storage cost</span>
                        <strong>
                          {usd(nowCost)} → {usd(newCost)}
                        </strong>
                      </div>
                      <div>
                        <span>Guest views</span>
                        <strong>Through Cloudflare cache{to.egressNote ? ` · ${to.egressNote}` : ''}</strong>
                      </div>
                    </div>
                    <Effects
                      items={[
                        ['upload', `New uploads go to ${to.name} as soon as you confirm.`],
                        [
                          'refresh',
                          'Existing photos are copied and checked one by one; each keeps working the whole time.',
                        ],
                        [
                          'undo',
                          `You can pause or roll back at any step. Old copies are deleted only after everything is verified, plus ${STORAGE_HOLD_DAYS} days.`,
                        ],
                        [
                          'file',
                          'Every step goes to the audit log; every Owner gets an email now and when it finishes.',
                        ],
                      ]}
                    />
                  </>
                )
              }
              confirmLabel="Switch with passkey"
              passkey
              onClose={() => setSwitching(null)}
              onConfirm={async (reason) => {
                if (!to) return;
                setData(
                  await write<AdminStorageResult>(ADMIN8_API.storageSwitch, 'POST', { to: to.id, reason }),
                );
                toast.show(`New uploads now go to ${to.name}`, 'good');
              }}
            />
            <ReasonDialog
              open={migAction !== null}
              title={
                migAction === 'rollback'
                  ? `Roll back to ${mig ? (byId(mig.from)?.name ?? mig.from) : ''}`
                  : migAction === 'pause'
                    ? 'Pause copying'
                    : 'Resume copying'
              }
              intro={
                migAction === 'rollback'
                  ? 'New uploads go back to the old store, and anything stored only on the new one is copied back first.'
                  : migAction === 'pause'
                    ? 'New uploads keep going to the new store. Copying stops until you resume.'
                    : 'Copying carries on from where it stopped.'
              }
              confirmLabel={
                migAction === 'rollback'
                  ? 'Roll back with passkey'
                  : migAction === 'pause'
                    ? 'Pause'
                    : 'Resume'
              }
              passkey={migAction === 'rollback'}
              danger={migAction === 'rollback'}
              onClose={() => setMigAction(null)}
              onConfirm={async (reason) => {
                if (!migAction) return;
                setData(
                  await write<AdminStorageResult>(ADMIN8_API.storageMigration, 'POST', {
                    action: migAction,
                    reason,
                  }),
                );
              }}
            />
            <ReasonDialog
              open={abandoning !== null}
              title={
                abandoning
                  ? `Abandon old copies on ${byId(abandoning.storeId)?.name ?? abandoning.storeId}`
                  : ''
              }
              intro={
                abandoning && (
                  <Effects
                    items={[
                      [
                        'refresh',
                        abandoning.via?.length
                          ? `Only the copies whose photos are on ${abandoning.via.map((t) => byId(t)?.name ?? t).join(', ')} are abandoned. Zephyr checks the stores again first. If they answer, nothing is abandoned: the clean-up job deletes the copies itself.`
                          : 'Zephyr checks the store again first. If it answers, nothing is abandoned: the clean-up job deletes the copies itself.',
                      ],
                      [
                        'alert',
                        `${n(abandoning.copies)} old ${abandoning.copies === 1 ? 'copy stays' : 'copies stay'} on that store: nothing is deleted there. Don’t delete them by hand: some may be the only copy of an edit made while photos moved. If the store comes back, keep it set up; the orphan sweep copies anything a photo’s own store is missing before deleting the rest.`,
                      ],
                      ...(abandoning.endsRollback
                        ? [
                            [
                              'undo',
                              'This ends the move: it can no longer be rolled back.',
                              'warn',
                            ] satisfies [IconName, string, 'warn'],
                          ]
                        : []),
                      [
                        'file',
                        'The migration finishes, so a new switch can start. Recorded in the audit log; every Owner gets an email.',
                      ],
                    ]}
                  />
                )
              }
              confirmLabel="Abandon with passkey"
              passkey
              danger
              onClose={() => setAbandoning(null)}
              onConfirm={async (reason) => {
                if (!abandoning) return;
                setData(
                  await write<AdminStorageResult>(ADMIN8_API.storageAbandon, 'POST', {
                    store: abandoning.storeId,
                    reason,
                    ...(abandoning.endsRollback ? { acknowledgeRollbackEnds: true } : {}),
                  }),
                );
                toast.show('Old copies abandoned', 'good');
              }}
            />
            <ReasonDialog
              open={givingUp}
              title="Give up the rollback"
              intro={
                mig && (
                  <Effects
                    items={[
                      ['upload', `New uploads go to ${byId(mig.to)?.name ?? mig.to} again.`],
                      [
                        'alert',
                        `Photos still waiting to be copied back stay on ${byId(mig.to)?.name ?? mig.to}. Photos already copied back stay on ${byId(mig.from)?.name ?? mig.from} while it’s set up.`,
                      ],
                      ['file', 'Recorded in the audit log; every Owner gets an email.'],
                    ]}
                  />
                )
              }
              confirmLabel="Give up with passkey"
              passkey
              danger
              onClose={() => setGivingUp(false)}
              onConfirm={async (reason) => {
                setData(await write<AdminStorageResult>(ADMIN8_API.storageGiveUp, 'POST', { reason }));
                toast.show('Rollback given up', 'good');
              }}
            />
          </>
        )}
      </PageState>
    </AdminShell>
  );
}
