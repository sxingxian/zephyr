import type { AiItemError, AiJobItem, AiJobPage, AiJobSummary } from '@zephyr/shared/client';
import { Button, Chip, Icon, Note, Spinner, useToast } from '@zephyr/ui';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AiPausedNote, CloudPausedBanner, ConfirmDialog, CreditStrip, plural } from '../components/ai/AiBits';
import { Segmented } from '../components/LibraryBits';
import { Shell } from '../components/Shell';
import {
  cancelJob,
  getJob,
  type JobState,
  listJobs,
  refreshAiStatus,
  retryJob,
  setRunningJobs,
  useAiStatus,
} from '../lib/aiClient';
import { errorMessage } from '../lib/api';
import { deviceRunner, type LocalJob, useDeviceRunner } from '../lib/deviceRunner';
import { thumbUrl } from '../lib/library';
import { useCan } from '../lib/libraryContext';
import { EmptyHint } from './Library';
import '../ai.css';

/** The AI queue (phase 6): cloud background-removal jobs and on-device batches, across devices. */

const ITEM_ERRORS: Record<AiItemError, string> = {
  provider_timeout: 'The cutting service timed out twice',
  provider_error: 'The cutting service failed',
  bad_output: 'The cut-out didn’t pass our checks',
  no_preview: 'No preview yet',
  photo_deleted: 'The photo was deleted',
  feature_off: 'Switched off while waiting',
  device_failed: 'Couldn’t be processed on the device',
};
const POLL_MS = 3000;

function ItemStatus({ item }: { item: AiJobItem }) {
  const map = {
    completed: ['Completed', 'good'],
    processing: ['Processing', 'acc'],
    pending: ['Pending', 'neutral'],
    failed: ['Failed', 'bad'],
    canceled: ['Canceled', 'neutral'],
  } as const;
  const [label, tone] = map[item.status];
  return (
    <span className="aiq-status">
      <Chip tone={tone} dot size="sm">
        {label}
      </Chip>
      {item.error && <span className="z-muted aiq-status__why">{ITEM_ERRORS[item.error]}</span>}
    </span>
  );
}

function Progress({ job }: { job: AiJobSummary }) {
  const c = job.counts;
  const pct = c.total ? Math.round(((c.completed + c.failed + c.canceled) / c.total) * 100) : 0;
  const fail = c.total ? Math.round((c.failed / c.total) * 100) : 0;
  return (
    <div
      className="aiq-bar"
      role="progressbar"
      aria-label={`${job.title} progress`}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="aiq-bar__done" style={{ width: `${Math.max(0, pct - fail)}%` }} />
      {fail > 0 && <span className="aiq-bar__fail" style={{ width: `${fail}%` }} />}
    </div>
  );
}

function CloudItems({ job, per, onChanged }: { job: AiJobSummary; per: number; onChanged: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<AiJobItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(
    async (after: string | null, signal?: AbortSignal) => {
      const d = await getJob(job.id, after, signal);
      setItems((prev) => (after && prev ? [...prev, ...d.items] : d.items));
      setCursor(d.nextCursor);
    },
    [job.id],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the job's counts move
  useEffect(() => {
    const c = new AbortController();
    load(null, c.signal).catch(() => {});
    return () => c.abort();
  }, [load, job.updatedAt]);
  const retry = async (itemId: string) => {
    setBusy(itemId);
    try {
      await retryJob(job.id, [itemId]);
      void refreshAiStatus();
      onChanged();
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  if (!items) return <Spinner size={16} label="Loading photos" />;
  return (
    <div className="aiq-table-wrap">
      <table className="aiq-table">
        <thead>
          <tr>
            <th scope="col">Photo</th>
            <th scope="col">Status</th>
            <th scope="col">Credits</th>
            <th scope="col">
              <span className="z-sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td>
                <span className="aiq-photo">
                  <img src={thumbUrl(it.photoId)} alt="" loading="lazy" />
                  <span>{it.filename}</span>
                </span>
              </td>
              <td>
                <ItemStatus item={it} />
              </td>
              <td className="mono z-muted">
                {it.status === 'failed' || it.status === 'canceled'
                  ? it.credits
                    ? plural(it.credits, 'credit')
                    : 'Refunded'
                  : it.credits
                    ? plural(it.credits, 'credit')
                    : '—'}
              </td>
              <td className="aiq-act">
                {it.status === 'failed' && it.retryable && (
                  <Button
                    size="sm"
                    busy={busy === it.id}
                    disabled={busy !== null}
                    onClick={() => void retry(it.id)}
                  >
                    Retry · {plural(per, 'credit')}
                  </Button>
                )}
                {it.status === 'completed' && (
                  <Link
                    className="z-btn z-btn--ghost z-btn--sm"
                    to={`/edit/${encodeURIComponent(it.photoId)}`}
                  >
                    Open
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {cursor && (
        <Button size="sm" kind="ghost" onClick={() => void load(cursor)}>
          Show more
        </Button>
      )}
    </div>
  );
}

function JobCard({
  job,
  local,
  per,
  onChanged,
}: {
  job: AiJobSummary;
  local?: LocalJob;
  per: number;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRetry, setConfirmRetry] = useState(false);
  const [showItems, setShowItems] = useState(job.kind === 'bg_removal' && job.status !== 'done');
  const c = job.counts;
  const cloud = job.kind === 'bg_removal';
  const live =
    job.status === 'queued' ||
    job.status === 'running' ||
    job.status === 'waiting' ||
    job.status === 'paused';
  const here = Boolean(local && local.state === 'running');
  const elsewhere = !here && job.holder && !job.holder.self;
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      void refreshAiStatus();
      onChanged();
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const where = cloud ? (
    <Chip tone="acc" icon="cpu">
      Cloud
    </Chip>
  ) : here || job.holder?.self ? (
    <Chip tone="good" icon="monitor">
      This device
    </Chip>
  ) : job.holder ? (
    <Chip icon="phone">{job.holder.device}</Chip>
  ) : null;
  const counts = cloud
    ? [
        `${c.completed} completed`,
        c.processing ? `${c.processing} processing` : '',
        c.pending ? `${c.pending} pending` : '',
        c.failed
          ? `${plural(c.failed, 'failed', 'failed')} · ${job.credits.refunded ? 'credits refunded' : 'not charged'}`
          : '',
        live ? 'Keeps going if you close Zephyr' : '',
      ]
    : [
        `${c.completed} completed`,
        c.failed ? `${c.failed} couldn’t be done` : '',
        c.pending ? `${c.pending} ${here || job.holder ? 'pending' : 'waiting'}` : '',
      ];
  return (
    <article className="aiq-card" aria-labelledby={`job-${job.id}`}>
      <div className="aiq-card__head">
        <span className="aiq-card__thumb">
          {job.coverPhotoId ? (
            <img src={thumbUrl(job.coverPhotoId)} alt="" />
          ) : (
            <Icon name="breeze" size={18} />
          )}
        </span>
        <div className="aiq-card__title">
          <h2 id={`job-${job.id}`}>{job.title}</h2>
          <span className="z-muted">
            {cloud
              ? `Background removal · ${plural(c.total, 'photo')}`
              : `${(job.params?.steps ?? []).map((s) => (s === 'auto_enhance' ? 'Auto-enhance' : s === 'hdr' ? 'HDR' : 'Colour match')).join(' + ')} · ${plural(c.total, 'photo')} · free`}
            {' · '}
            {new Date(job.createdAt).toLocaleString(undefined, {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
        {where}
        <div className="aiq-card__actions">
          {!cloud && live && here && (
            <Button
              size="sm"
              icon="pause"
              busy={busy === 'pause'}
              onClick={() => void run('pause', () => deviceRunner.pause(job.id))}
            >
              Pause
            </Button>
          )}
          {!cloud && live && !here && !elsewhere && (
            <Button
              size="sm"
              icon="play"
              busy={busy === 'claim'}
              onClick={() => void run('claim', async () => void deviceRunner.start(job))}
            >
              Continue here
            </Button>
          )}
          {cloud && c.failed > 0 && (
            <Button
              size="sm"
              icon="refresh"
              disabled={busy !== null || confirmRetry}
              onClick={() => setConfirmRetry(true)}
            >
              {`Retry all failed · ${plural(c.failed * per, 'credit')}`}
            </Button>
          )}
          {live && (
            <Button
              size="sm"
              kind="ghost"
              busy={busy === 'cancel'}
              onClick={() =>
                void run('cancel', async () => {
                  deviceRunner.stopLocal(job.id);
                  await cancelJob(job.id);
                })
              }
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmRetry}
        title={`Retry ${plural(c.failed, 'failed photo')}?`}
        confirm={`Retry · up to ${plural(c.failed * per, 'credit')}`}
        onClose={() => setConfirmRetry(false)}
        onConfirm={async () => {
          setBusy('retry');
          try {
            await retryJob(job.id);
            void refreshAiStatus();
            onChanged();
          } finally {
            setBusy(null);
          }
        }}
      >
        Each photo is charged again ({plural(per, 'credit')} a photo). Photos that fail again are refunded,
        and photos that can’t be retried (deleted ones) aren’t charged.
      </ConfirmDialog>
      <Progress job={job} />
      <div className="aiq-counts">
        {counts.filter(Boolean).map((t) => (
          <span key={t}>{t}</span>
        ))}
        {job.credits.charged > 0 && (
          <span className="mono">{plural(job.credits.charged - job.credits.refunded, 'credit')} spent</span>
        )}
      </div>
      {!cloud && live && !here && (
        <div className="aiq-wait">
          <Chip tone="warn" dot size="sm">
            {elsewhere
              ? `Running on ${job.holder?.device}`
              : job.status === 'paused'
                ? 'Paused'
                : 'Waiting for this device'}
          </Chip>
          <span className="z-muted">
            {elsewhere
              ? 'It carries on there while that device is awake.'
              : 'On-device jobs run while a Zephyr tab is open. It carries on from where it stopped.'}
          </span>
        </div>
      )}
      {!cloud && here && (
        <Note tone="neutral" icon="info">
          On-device jobs run while a Zephyr tab is open. If you close it, the job waits here and carries on
          next time, from where it stopped.
        </Note>
      )}
      {local?.state === 'lost' && (
        <Note tone="warn" icon="alert">
          Another device took over this job.
        </Note>
      )}
      {local?.state === 'error' && (
        <Note tone="bad" icon="alert" role="alert">
          This device stopped working on the job. Try “Continue here” again.
        </Note>
      )}
      {cloud && (
        <>
          <button
            type="button"
            className="text-link aiq-toggle"
            aria-expanded={showItems}
            onClick={() => setShowItems((v) => !v)}
          >
            {showItems ? 'Hide photos' : 'Show photos'}
          </button>
          {showItems && <CloudItems job={job} per={per} onChanged={onChanged} />}
        </>
      )}
    </article>
  );
}

export function AiQueuePage() {
  // The queue (and the credits it spends) is for the library's Owner and Editors.
  if (!useCanAi()) {
    return (
      <Shell title="AI queue">
        <Note tone="neutral" icon="lock">
          The AI queue is for this library’s Owner and Editors.
        </Note>
      </Shell>
    );
  }
  return <AiQueueContent />;
}

const useCanAi = () => useCan('ai');

function AiQueueContent() {
  const status = useAiStatus();
  const local = useDeviceRunner();
  const [state, setState] = useState<JobState>('running');
  const [page, setPage] = useState<AiJobPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const p = await listJobs(state, null, signal);
        setPage(p);
        setRunningJobs(p.counts.running);
        setError(null);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError(errorMessage(e));
      }
    },
    [state],
  );
  useEffect(() => {
    const c = new AbortController();
    setPage(null);
    void load(c.signal);
    return () => c.abort();
  }, [load]);
  // Poll while anything is running (and the tab is visible).
  useEffect(() => {
    const live = page?.jobs.some((j) => j.status !== 'done' && j.status !== 'canceled');
    if (!live) return;
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [page, load]);

  const loadMore = async () => {
    if (!page?.nextCursor) return;
    setMore(true);
    try {
      const p = await listJobs(state, page.nextCursor);
      setPage({ ...p, jobs: [...page.jobs, ...p.jobs] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setMore(false);
    }
  };

  const counts = page?.counts;
  return (
    <Shell title="AI queue">
      {status && !status.enabled && <AiPausedNote />}
      <div className="lib-toolbar">
        <Segmented
          label="Jobs"
          value={state}
          onChange={setState}
          options={[
            { value: 'running', label: `Running${counts ? ` · ${counts.running}` : ''}` },
            { value: 'finished', label: `Finished${counts ? ` · ${counts.finished}` : ''}` },
            { value: 'failed', label: `Failed${counts ? ` · ${counts.failed}` : ''}` },
          ]}
        />
        <span className="lib-toolbar__spacer" />
        {status?.enabled && <CreditStrip status={status} />}
      </div>
      <CloudPausedBanner status={status} />
      {error && (
        <Note tone="bad" icon="alert" role="alert">
          {error}
        </Note>
      )}
      {!page ? (
        <Spinner size={20} label="Loading jobs" />
      ) : page.jobs.length === 0 ? (
        <EmptyHint
          title={
            state === 'running'
              ? 'Nothing running'
              : state === 'failed'
                ? 'No failed jobs'
                : 'No finished jobs yet'
          }
        >
          Select photos in your library and choose Zephyr AI to start a batch.
        </EmptyHint>
      ) : (
        <div className="aiq-list">
          {page.jobs.map((j) => (
            <JobCard
              key={j.id}
              job={j}
              local={local.find((l) => l.id === j.id)}
              per={status?.credits.bgCreditsPerPhoto ?? 1}
              onChanged={() => void load()}
            />
          ))}
          {page.nextCursor && (
            <Button kind="ghost" busy={more} onClick={loadMore}>
              Show more
            </Button>
          )}
        </div>
      )}
    </Shell>
  );
}
