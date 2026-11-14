import {
  ADMIN8_API,
  type AdminRetentionResult,
  RETENTION_DAYS,
  type RetentionItem,
  type RetentionState,
} from '@zephyr/shared/client';
import { Button, Card, CardHead, Chip, type ChipTone, type Column, Table, useToast } from '@zephyr/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Effects, Kpi, PageState, ReasonDialog } from '../components/Kit8';
import { AdminShell } from '../components/Shell';
import { can, formatBytes, n, shortDate, useAdminWrite } from '../lib/admin8';
import { api, errorMessage } from '../lib/api';
import { useAdminSession } from '../lib/session';

const STATE: Record<RetentionState, [string, ChipTone]> = {
  waiting: ['Waiting', 'neutral'],
  ready: ['Ready', 'warn'],
  approved: ['Approved', 'acc'],
  trashed: ['Moved to Trash', 'outline'],
  resolved: ['Resolved', 'good'],
};
/** The API takes at most this many owners per approval. */
export const RETENTION_BATCH_MAX = 100;

export function Retention() {
  const { staff } = useAdminSession();
  const allowed = can(staff?.role, 'retention');
  const write = useAdminWrite();
  const toast = useToast();
  const [data, setData] = useState<AdminRetentionResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [approving, setApproving] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api<AdminRetentionResult>(ADMIN8_API.retention));
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);
  const ready = useMemo(() => (data?.items ?? []).filter((i) => i.state === 'ready'), [data]);
  // Drop picks that are no longer ready after a reload.
  useEffect(() => {
    setPicked((p) => new Set([...p].filter((id) => ready.some((r) => r.ownerId === id))));
  }, [ready]);
  const toggle = (id: string, on: boolean) =>
    setPicked((p) => {
      const x = new Set(p);
      if (on) x.add(id);
      else x.delete(id);
      return x;
    });
  const allOn = ready.length > 0 && ready.every((r) => picked.has(r.ownerId));
  const sel = ready.filter((r) => picked.has(r.ownerId));
  const photos = sel.reduce((a, r) => a + r.photosToTrash, 0);
  const bytes = sel.reduce((a, r) => a + r.overBytes, 0);

  const cols: Column<RetentionItem>[] = [
    {
      key: 'x',
      header: (
        <input
          type="checkbox"
          aria-label="Select all ready libraries"
          checked={allOn}
          disabled={ready.length === 0}
          onChange={(e) =>
            setPicked(
              e.target.checked
                ? new Set(ready.slice(0, RETENTION_BATCH_MAX).map((r) => r.ownerId))
                : new Set(),
            )
          }
        />
      ),
      cell: (i) =>
        i.state === 'ready' ? (
          <input
            type="checkbox"
            aria-label={`Select ${i.displayName ?? 'library'}`}
            checked={picked.has(i.ownerId)}
            disabled={!picked.has(i.ownerId) && picked.size >= RETENTION_BATCH_MAX}
            onChange={(e) => toggle(i.ownerId, e.target.checked)}
          />
        ) : null,
    },
    { key: 'l', header: 'Library', cell: (i) => <strong>{i.displayName ?? 'Unnamed member'}</strong> },
    { key: 'p', header: 'Plan lapsed', cell: (i) => shortDate(i.lapsedAt) },
    {
      key: 'o',
      header: 'Over Free by',
      cell: (i) => <span className="z-mono">{i.overBytes ? formatBytes(i.overBytes) : '—'}</span>,
    },
    {
      key: 't',
      header: 'Photos to Trash',
      cell: (i) => (i.photosToTrash ? `${n(i.photosToTrash)} oldest` : '—'),
    },
    {
      key: 'e',
      header: 'Emails',
      cell: (i) => (
        <span className="btn-row btn-row--tight">
          <Chip size="sm" tone={i.notices.d30 ? 'good' : 'outline'}>
            30 d
          </Chip>
          <Chip size="sm" tone={i.notices.d7 ? 'good' : 'outline'}>
            7 d
          </Chip>
        </span>
      ),
    },
    { key: 'd', header: 'Due', cell: (i) => (i.state === 'resolved' ? '—' : shortDate(i.dueAt)) },
    {
      key: 's',
      header: 'Status',
      cell: (i) => (
        <Chip tone={STATE[i.state][1]} dot={i.state === 'ready'}>
          {STATE[i.state][0]}
        </Chip>
      ),
    },
  ];
  return (
    <AdminShell
      title="Retention"
      sub={`Paid libraries keep ${RETENTION_DAYS / 365 === 1 ? '1 year' : `${RETENTION_DAYS} days`} of read-only storage after the plan ends. Staff approve every clean-up.`}
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
            <div className="ai-tiles">
              <Kpi
                label="Read-only libraries"
                value={n(data.kpis.readOnly)}
                note="Over their plan’s storage"
                icon="lock"
              />
              <Kpi
                label="Reach 1 year in 30 days"
                value={n(data.kpis.dueIn30Days)}
                note="Emailed at 30 and 7 days"
                icon="calendar"
              />
              <Kpi
                label="Ready for approval"
                value={n(data.kpis.ready)}
                note="Past 1 year, emails sent"
                tone={data.kpis.ready ? 'warn' : 'muted'}
                icon="alert"
              />
              <Kpi
                label="Resolved this month"
                value={n(data.kpis.resolvedThisMonth)}
                note="Renewed or made room"
                tone="good"
                icon="check"
              />
            </div>
            <Card>
              <CardHead title="Past 1 year read-only">
                <Button
                  size="sm"
                  kind="primary"
                  icon="trash"
                  disabled={sel.length === 0}
                  onClick={() => setApproving(true)}
                >
                  {sel.length
                    ? `Approve ${sel.length}: move the excess to Trash…`
                    : 'Select libraries to approve'}
                </Button>
              </CardHead>
              <Table
                columns={cols}
                rows={data.items}
                rowKey={(i) => i.ownerId}
                caption="Libraries past their read-only year"
                minWidth={900}
                empty="No libraries are near the end of their read-only year."
              />
              <p className="z-hint">
                Nothing within the Free plan’s storage is ever touched. The oldest photos beyond it go to the
                member’s Trash, where they can restore them for 30 days (they still count until deleted). Held
                photos and photos in live galleries are skipped.
              </p>
            </Card>
            <ReasonDialog
              open={approving}
              title={`Approve ${sel.length} ${sel.length === 1 ? 'library' : 'libraries'}`}
              intro={
                <Effects
                  items={[
                    [
                      'trash',
                      `About ${n(photos)} of the oldest photos (${formatBytes(bytes)}) move to the members’ Trash.`,
                    ],
                    ['undo', 'Members can restore them for 30 days, and get an email saying so.'],
                    [
                      'shield',
                      'Held photos, photos in live galleries and anything within the Free storage are skipped.',
                    ],
                  ]}
                />
              }
              confirmLabel="Approve with passkey"
              passkey
              onClose={() => setApproving(false)}
              onConfirm={async (reason) => {
                const r = await write<AdminRetentionResult>(ADMIN8_API.retentionApprove, 'POST', {
                  ownerIds: sel.map((s) => s.ownerId),
                  reason,
                });
                setData(r);
                setPicked(new Set());
                toast.show('Approved. Photos move to Trash shortly.', 'good');
              }}
            />
          </>
        )}
      </PageState>
    </AdminShell>
  );
}
