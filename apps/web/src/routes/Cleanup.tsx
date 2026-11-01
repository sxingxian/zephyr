import type { CleanupPhoto } from '@zephyr/shared/client';
import { Button, Chip, Note, Spinner, useToast } from '@zephyr/ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AiPausedNote, plural, UpgradeHint } from '../components/ai/AiBits';
import { Segmented } from '../components/LibraryBits';
import { Shell } from '../components/Shell';
import type { CleanupGroup, CleanupResult } from '../lib/ai/cleanup';
import { fetchCleanup, ignoreCleanup, useAiStatus } from '../lib/aiClient';
import { errorMessage } from '../lib/api';
import { emitLibrary } from '../lib/bus';
import { bulk, thumbUrl } from '../lib/library';
import { formatBytes, refreshUsage } from '../lib/usage';
import { useScanner } from '../lib/useScanner';
import { EmptyHint, GridSkeleton } from './Library';

/**
 * Cleanup (phase 6, Pro and Studio): duplicates, blurry photos and similar bursts, grouped on this device from
 * every photo's quality signals. Nothing is deleted until the member confirms; Trash keeps photos 30 days.
 */
type Tab = 'duplicates' | 'blurry' | 'bursts';

/** Pages every photo's signals and groups them (grouping lives in the engine). */
async function loadCleanup(signal: AbortSignal): Promise<CleanupResult> {
  const photos: CleanupPhoto[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 200; i++) {
    const page = await fetchCleanup(cursor, signal);
    photos.push(...page.photos);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  const { groupCleanup } = await import('../lib/ai/cleanup');
  return groupCleanup(photos);
}

/** Everything but each group's best photo is ticked for the Trash, and every blurry photo. */
export function defaultTrash(r: CleanupResult): Set<string> {
  const t = new Set<string>();
  for (const g of [...r.duplicates, ...r.bursts]) for (const p of g.photos) if (p.id !== g.keep) t.add(p.id);
  for (const p of r.blurry) t.add(p.id);
  return t;
}

const when = (p: CleanupPhoto) =>
  new Date(p.takenAt ?? p.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function Tile({
  p,
  keep,
  checked,
  onToggle,
  blurry,
}: {
  p: CleanupPhoto;
  keep: boolean;
  checked: boolean;
  onToggle: (v: boolean) => void;
  blurry?: boolean;
}) {
  return (
    <label className={`ai-clean__tile${keep ? ' is-keep' : ''}`}>
      <img src={thumbUrl(p.id)} alt="" loading="lazy" className={blurry ? 'is-blurry' : undefined} />
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label={`${checked ? 'Move to Trash' : 'Keep'}: photo from ${when(p)}`}
      />
      {keep && (
        <span className="ai-clean__keep">
          <Chip tone="good" size="sm">
            Keep · sharpest
          </Chip>
        </span>
      )}
    </label>
  );
}

export function CleanupPage() {
  const status = useAiStatus();
  const toast = useToast();
  const { progress } = useScanner();
  const [tab, setTab] = useState<Tab>('duplicates');
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Photos ticked for the Trash. */
  const [trash, setTrash] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const state = status?.features.cleanup;
  const on = Boolean(status?.enabled && state === 'on');

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const r = await loadCleanup(signal);
      if (signal.aborted) return;
      setResult(r);
      setTrash(defaultTrash(r));
      setError(null);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    if (!on) return;
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [on, load]);

  const groups: CleanupGroup[] = result
    ? tab === 'duplicates'
      ? result.duplicates
      : tab === 'bursts'
        ? result.bursts
        : []
    : [];
  const shown: CleanupPhoto[] = result
    ? tab === 'blurry'
      ? result.blurry
      : groups.flatMap((g) => g.photos)
    : [];
  const picked = shown.filter((p) => trash.has(p.id));
  const savings = picked.reduce((n, p) => n + p.sizeBytes, 0);
  const toggle = (id: string, v: boolean) =>
    setTrash((t) => {
      const n = new Set(t);
      if (v) n.add(id);
      else n.delete(id);
      return n;
    });

  /** Drop photos from the lists once they're handled. */
  const drop = (ids: string[]) => {
    const gone = new Set(ids);
    setResult((r) => {
      if (!r) return r;
      const g = (gs: CleanupGroup[]) =>
        gs
          .map((x) => ({ ...x, photos: x.photos.filter((p) => !gone.has(p.id)) }))
          .filter((x) => x.photos.length > 1);
      return {
        duplicates: g(r.duplicates),
        bursts: g(r.bursts),
        blurry: r.blurry.filter((p) => !gone.has(p.id)),
      };
    });
  };

  const moveToTrash = async () => {
    const ids = picked.map((p) => p.id);
    if (!ids.length) return;
    setBusy('trash');
    try {
      await bulk(ids, 'trash');
      emitLibrary({ type: 'removed', ids });
      void refreshUsage();
      drop(ids);
      toast.show(`Moved ${plural(ids.length, 'photo')} to Trash. You can restore them for 30 days.`, 'good');
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const ignore = async (kind: 'duplicates' | 'blurry', ids: string[], key: string) => {
    setBusy(key);
    try {
      await ignoreCleanup({ kind, photoIds: ids });
      drop(ids);
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };

  const checking = progress?.phase === 'signals' && (progress.signals.remaining ?? 0) > 0;
  let body: ReactNode;
  if (!status) body = <GridSkeleton />;
  else if (!status.enabled) body = <AiPausedNote />;
  else if (state === 'off_plan') body = <UpgradeHint what="Cleanup" icon="sparkGrid" />;
  else if (state === 'off_member')
    body = (
      <Note tone="neutral" icon="info">
        Cleanup is off.{' '}
        <Link to="/settings/ai" className="text-link">
          Turn it on in Settings › Zephyr AI
        </Link>
      </Note>
    );
  else if (!on)
    body = (
      <Note tone="neutral" icon="info">
        Cleanup is switched off right now.
      </Note>
    );
  else if (error)
    body = (
      <Note tone="bad" icon="alert" role="alert">
        {error}
      </Note>
    );
  else if (!result) body = <Spinner size={20} label="Grouping your photos on this device" />;
  else
    body = (
      <>
        <div className="lib-toolbar">
          <Segmented
            label="Cleanup type"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'duplicates', label: `Duplicates · ${plural(result.duplicates.length, 'set')}` },
              { value: 'blurry', label: `Blurry · ${result.blurry.length}` },
              { value: 'bursts', label: `Similar bursts · ${result.bursts.length}` },
            ]}
          />
          <span className="lib-toolbar__spacer" />
          {picked.length > 0 && <span className="z-muted">Saves {formatBytes(savings)}</span>}
          <Button
            kind="primary"
            icon="sparkGrid"
            busy={busy === 'trash'}
            disabled={!picked.length}
            onClick={moveToTrash}
          >
            {tab === 'blurry'
              ? `Move ${plural(picked.length, 'photo')} to Trash`
              : `Keep best, move ${picked.length.toLocaleString('en')} other${picked.length === 1 ? '' : 's'} to Trash`}
          </Button>
        </div>
        {checking && (
          <Note tone="neutral" icon="info" role="status">
            Still checking {plural(progress?.signals.remaining ?? 0, 'photo')} on this device. They’ll appear
            here when it’s done.
          </Note>
        )}
        {tab === 'blurry' ? (
          result.blurry.length === 0 ? (
            <EmptyHint title="No blurry photos found" />
          ) : (
            <div className="ai-clean__grid">
              {result.blurry.map((p) => (
                <div key={p.id} className="ai-clean__cell">
                  <Tile
                    p={p}
                    keep={false}
                    blurry
                    checked={trash.has(p.id)}
                    onToggle={(v) => toggle(p.id, v)}
                  />
                  <Button
                    size="sm"
                    kind="ghost"
                    busy={busy === `keep:${p.id}`}
                    onClick={() => void ignore('blurry', [p.id], `keep:${p.id}`)}
                  >
                    Keep
                  </Button>
                </div>
              ))}
            </div>
          )
        ) : groups.length === 0 ? (
          <EmptyHint title={tab === 'duplicates' ? 'No duplicates found' : 'No similar bursts found'} />
        ) : (
          <div className="ai-clean__sets">
            {groups.map((g) => {
              const first = g.photos[0];
              return (
                <article key={g.keep} className="ai-clean__set">
                  <div className="ai-clean__head">
                    <strong>{plural(g.photos.length, 'photo')}</strong>
                    <span className="z-muted">
                      {first ? when(first) : ''} · saves {formatBytes(g.savings)}
                    </span>
                    <span className="lib-toolbar__spacer" />
                    <Button
                      size="sm"
                      kind="ghost"
                      busy={busy === `ign:${g.keep}`}
                      onClick={() =>
                        void ignore(
                          'duplicates',
                          g.photos.map((p) => p.id),
                          `ign:${g.keep}`,
                        )
                      }
                    >
                      Not duplicates
                    </Button>
                  </div>
                  <div
                    className="ai-clean__row"
                    style={{ gridTemplateColumns: `repeat(${Math.min(g.photos.length, 6)}, minmax(0, 1fr))` }}
                  >
                    {g.photos.map((p) => (
                      <Tile
                        key={p.id}
                        p={p}
                        keep={p.id === g.keep}
                        checked={trash.has(p.id)}
                        onToggle={(v) => toggle(p.id, v)}
                      />
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        )}
        <Note tone="neutral" icon="monitor">
          Duplicates and blurry photos are found on your devices from the previews. Nothing about them leaves
          Zephyr.
        </Note>
      </>
    );

  return (
    <Shell title="Cleanup">
      <div className="ai-section-head">
        <h2>Cleanup</h2>
        <span className="z-muted">Nothing is deleted until you confirm · Trash empties after 30 days</span>
      </div>
      {body}
    </Shell>
  );
}
