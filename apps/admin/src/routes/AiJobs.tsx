import {
  ADMIN_AI_API,
  type AdminAiJobsResult,
  type AdminAiSettingsResult,
  type AiItemError,
  type AiSettings,
} from '@zephyr/shared/client';
import {
  Button,
  Card,
  CardHead,
  Chip,
  type ChipTone,
  type Column,
  Note,
  Spinner,
  Table,
  useToast,
} from '@zephyr/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ReadOnlyChip, ResetsChip, SpendToday } from '../components/AiBits';
import { AdminShell } from '../components/Shell';
import { ago, PROVIDER_LABEL } from '../lib/ai';
import { api, errorMessage } from '../lib/api';
import { canWrite, useAdminSession } from '../lib/session';
import { useAiSettingsPatch } from '../lib/useAiSettings';
import { aiSaveError } from './AiControls';

/** How often the page refreshes while it's visible. */
export const JOBS_POLL_MS = 30_000;
/** NFR-PERF-03: seconds per 12 MP photo in the cloud. */
const TARGET_S = 1.5;

const ERROR_LABEL: Record<AiItemError, string> = {
  provider_timeout: 'Provider timed out twice · refunded',
  provider_error: 'Provider failed · refunded',
  bad_output: 'Mask didn’t pass our checks · refunded',
  no_preview: 'Photo had no preview yet · refunded',
  photo_deleted: 'Photo deleted by its owner',
  feature_off: 'Feature switched off while queued · refunded',
  device_failed: 'Couldn’t be processed on the device',
};
const FEATURE_LABEL = { bg_removal: 'Background removal', scene_tags: 'Scene tags' } as const;

type Rows = AdminAiJobsResult['providers'][number];
type Failure = AdminAiJobsResult['failures'][number];

function Tile({ label, tone, value, note }: { label: string; tone: ChipTone; value: number; note: string }) {
  return (
    <div className="ai-tile">
      <span className="ai-tile__head">
        <Chip tone={tone} dot>
          {label}
        </Chip>
        <span className="z-hint">{note}</span>
      </span>
      <span className="ai-tile__value">{value.toLocaleString('en-GB')}</span>
    </div>
  );
}

function Latency({ rows }: { rows: AdminAiJobsResult['latency'] }) {
  const max = Math.max(2.5, ...rows.map((r) => (r.p95 ?? 0) * 1.1));
  const pct = (s: number) => `${Math.min(100, (s / max) * 100).toFixed(1)}%`;
  if (!rows.length) return <p className="z-hint">No cloud photos in the last hour.</p>;
  return (
    <div className="stack">
      <ul className="lat">
        {rows.map((r) => {
          const slow = (r.p95 ?? 0) > TARGET_S;
          const text =
            r.p50 === null || r.p95 === null ? 'No data' : `${r.p50.toFixed(1)} / ${r.p95.toFixed(1)} s`;
          return (
            <li key={r.label} className="lat__row">
              <span className="lat__label">{r.label}</span>
              <span
                className="lat__track"
                role="img"
                aria-label={`${r.label}: p50 ${r.p50 ?? 'none'} s, p95 ${r.p95 ?? 'none'} s`}
              >
                {r.p95 !== null && (
                  <span
                    className={`lat__p95${slow ? ' lat__p95--slow' : ''}`}
                    style={{ width: pct(r.p95) }}
                  />
                )}
                {r.p50 !== null && <span className="lat__p50" style={{ width: pct(r.p50) }} />}
                <span className="lat__target" style={{ left: pct(TARGET_S) }} aria-hidden="true" />
              </span>
              <span className={`z-mono lat__value${slow ? ' lat__value--slow' : ''}`}>{text}</span>
            </li>
          );
        })}
      </ul>
      <div className="lat__legend z-hint">
        <span>
          <span className="lat__key lat__key--p50" aria-hidden="true" />
          p50
        </span>
        <span>
          <span className="lat__key lat__key--p95" aria-hidden="true" />
          p95
        </span>
        <span>
          <span className="lat__key lat__key--target" aria-hidden="true" />
          {TARGET_S} s target per 12 MP photo (NFR-PERF-03)
        </span>
      </div>
    </div>
  );
}

const pctText = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);
const providerCols: Column<Rows>[] = [
  {
    key: 'p',
    header: 'Provider',
    cell: (r) => <span className="cell-strong">{PROVIDER_LABEL[r.provider]}</span>,
  },
  { key: 'f', header: 'Used for', cell: (r) => FEATURE_LABEL[r.feature] },
  {
    key: 'r',
    header: 'Role',
    cell: (r) => (
      <Chip tone={r.role === 'primary' ? 'acc' : 'neutral'}>
        {r.role === 'primary' ? 'Primary' : 'Fallback'}
      </Chip>
    ),
  },
  {
    key: 'c',
    header: 'Calls (24 h)',
    cell: (r) => <span className="z-mono">{r.calls.toLocaleString('en-GB')}</span>,
  },
  { key: 's', header: 'Success', cell: (r) => <span className="z-mono">{pctText(r.successRate)}</span> },
  {
    key: 'l',
    header: 'p95',
    cell: (r) => <span className="z-mono">{r.p95 === null ? '—' : `${r.p95.toFixed(1)} s`}</span>,
  },
  {
    key: 'st',
    header: 'Status',
    cell: (r) =>
      r.calls === 0 ? (
        <Chip tone="neutral" dot>
          {r.role === 'fallback' ? 'Standing by' : 'Idle'}
        </Chip>
      ) : r.successRate !== null && r.successRate < 0.95 ? (
        <Chip tone="warn" dot>
          Degraded
        </Chip>
      ) : (
        <Chip tone="good" dot>
          Healthy
        </Chip>
      ),
  },
];
const failureCols: Column<Failure>[] = [
  { key: 'j', header: 'Job', cell: (r) => <span className="z-mono">{r.jobId.slice(0, 8)}</span> },
  { key: 'm', header: 'Member', cell: (r) => <span className="z-mono">{r.member}…</span> },
  { key: 'f', header: 'Feature', cell: (r) => FEATURE_LABEL[r.feature] },
  {
    key: 'e',
    header: 'Error',
    cell: (r) => <span className="z-muted">{ERROR_LABEL[r.error] ?? r.error}</span>,
  },
  { key: 'w', header: 'When', cell: (r) => <span className="z-muted">{ago(r.at)}</span> },
];

export function AiJobs() {
  const { staff } = useAdminSession();
  const writable = canWrite(staff?.role);
  const toast = useToast();
  const patchSettings = useAiSettingsPatch();
  const [jobs, setJobs] = useState<AdminAiJobsResult | null>(null);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);

  const load = useCallback(async () => {
    try {
      const [j, s] = await Promise.all([
        api<AdminAiJobsResult>(ADMIN_AI_API.jobs),
        api<AdminAiSettingsResult>(ADMIN_AI_API.settings),
      ]);
      if (!live.current) return;
      setJobs(j);
      setSettings(s.settings);
      setErr(null);
    } catch (e) {
      if (live.current) setErr(errorMessage(e));
    }
  }, []);

  // Load now, then every 30 s while the tab is visible (and straight away when it becomes visible again).
  useEffect(() => {
    live.current = true;
    void load();
    const tick = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const t = setInterval(tick, JOBS_POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      live.current = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  const togglePause = async () => {
    if (!settings) return;
    const next = !settings.cloudPaused;
    setBusy(true);
    try {
      const r = await patchSettings({ cloudPaused: next });
      setSettings(r.settings);
      toast.show(next ? 'New cloud jobs paused' : 'Cloud jobs resumed', 'good');
    } catch (e) {
      toast.show(aiSaveError(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const paused = settings?.cloudPaused ?? false;
  return (
    <AdminShell
      title="AI jobs"
      sub="Cloud Zephyr AI work: the queue, each provider’s speed and errors, and today’s spend. On-device features run in members’ browsers and aren’t tracked here."
      actions={
        writable ? (
          settings && (
            <Button
              size="sm"
              kind={paused ? 'primary' : 'secondary'}
              icon={paused ? 'play' : 'pause'}
              busy={busy}
              onClick={togglePause}
            >
              {paused ? 'Resume cloud jobs' : 'Pause new cloud jobs'}
            </Button>
          )
        ) : (
          <ReadOnlyChip />
        )
      }
    >
      {err && (
        <Note tone="bad" icon="alert" role="alert">
          {err}
        </Note>
      )}
      {paused && (
        <Note tone="warn" icon="pause">
          New cloud jobs are paused. Queued work waits; nothing is refunded.
          {writable && ' Resuming needs your passkey.'}
        </Note>
      )}
      {!jobs && !err && <Spinner size={22} label="Loading AI jobs" />}
      {jobs && (
        <>
          <div className="ai-tiles">
            <Tile label="Pending" tone="neutral" value={jobs.counts.pending} note="in the queue" />
            <Tile label="Processing" tone="acc" value={jobs.counts.processing} note="now" />
            <Tile label="Completed" tone="good" value={jobs.counts.completedToday} note="today" />
            <Tile label="Failed" tone="bad" value={jobs.counts.failedToday} note="today · credits refunded" />
          </div>
          <div className="ai-pair">
            <Card aria-labelledby="lat-title">
              <CardHead title={<span id="lat-title">Seconds per photo</span>}>
                <span className="z-hint">p50 / p95, last hour</span>
              </CardHead>
              <Latency rows={jobs.latency} />
            </Card>
            <Card aria-labelledby="spend-title">
              <CardHead title={<span id="spend-title">Today’s spend</span>}>
                <ResetsChip />
              </CardHead>
              <SpendToday spend={jobs.spend} caps={settings?.caps ?? null} />
              <Link to="/ai" className="z-hint">
                Change caps in Zephyr AI controls
              </Link>
            </Card>
          </div>
          <Card aria-labelledby="prov-title">
            <CardHead title={<span id="prov-title">Providers</span>}>
              <Chip tone="outline" icon="shieldCheck">
                Through Cloudflare AI Gateway
              </Chip>
            </CardHead>
            <Table
              caption="Providers"
              columns={providerCols}
              rows={jobs.providers}
              rowKey={(r) => `${r.provider}:${r.feature}`}
              minWidth={760}
              empty="No provider calls yet."
            />
          </Card>
          <Card aria-labelledby="fail-title">
            <CardHead title={<span id="fail-title">Recent failures</span>} />
            <Table
              caption="Recent failures"
              columns={failureCols}
              rows={jobs.failures}
              rowKey={(r) => r.itemId}
              minWidth={720}
              empty="No failures. Nice."
            />
            <p className="z-hint">Admins see job ids and member ids, never the photos.</p>
          </Card>
        </>
      )}
    </AdminShell>
  );
}
