import { SCENE_LABELS, SCENES, type SceneId, type SceneSummary } from '@zephyr/shared/client';
import { Button, Note } from '@zephyr/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { AiPausedNote } from '../components/ai/AiBits';
import { SelectionBar, useShareWithViewer, useViewerHost } from '../components/LibraryBits';
import { PhotoGrid } from '../components/PhotoGrid';
import { Shell } from '../components/Shell';
import { fetchScenes, useAiStatus } from '../lib/aiClient';
import { errorMessage } from '../lib/api';
import { thumbUrl } from '../lib/library';
import { usePhotoList } from '../lib/photos';
import { useSelection } from '../lib/selection';
import { EmptyHint, GridSkeleton, useLibraryActions } from './Library';

/** Scenes (phase 6): tags from Workers AI on each photo's small preview, plus Night from the device. */

function PrivacyNote() {
  return (
    <Note tone="neutral" icon="shield">
      To tag scenes, a 512 px preview of each new photo goes to Cloudflare’s image recogniser, which doesn’t
      keep it. Night is worked out on your device. You can turn scene tags off in{' '}
      <Link to="/settings/ai" className="text-link">
        Settings › Zephyr AI
      </Link>
      .
    </Note>
  );
}

export function ScenesPage() {
  const status = useAiStatus();
  const [scenes, setScenes] = useState<SceneSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = status?.features.scene_tags;
  const visible = Boolean(status?.enabled && (state === 'on' || state === 'paused'));
  useEffect(() => {
    if (!visible) return;
    const c = new AbortController();
    fetchScenes(c.signal)
      .then((r) =>
        setScenes(r.scenes.filter((s) => (SCENES as readonly string[]).includes(s.scene) && s.count > 0)),
      )
      .catch((e) => (e as Error).name !== 'AbortError' && setError(errorMessage(e)));
    return () => c.abort();
  }, [visible]);

  return (
    <Shell title="Scenes">
      <div className="ai-section-head">
        <h2>Scenes</h2>
        <span className="z-muted">Recognised automatically from a small preview of each photo</span>
        <span className="lib-toolbar__spacer" />
        <Link to="/settings/ai" className="z-btn z-btn--ghost z-btn--sm">
          Settings
        </Link>
      </div>
      {!status ? (
        <GridSkeleton />
      ) : !status.enabled ? (
        <AiPausedNote />
      ) : state === 'off_member' ? (
        <Note tone="neutral" icon="info">
          Scene tags are off.{' '}
          <Link to="/settings/ai" className="text-link">
            Turn them on in Settings › Zephyr AI
          </Link>
        </Note>
      ) : !visible ? (
        <Note tone="neutral" icon="info">
          Scene tags are switched off right now.
        </Note>
      ) : error ? (
        <Note tone="bad" icon="alert" role="alert">
          {error}
        </Note>
      ) : !scenes ? (
        <GridSkeleton />
      ) : scenes.length === 0 ? (
        <EmptyHint title="No scenes yet">New photos are tagged a few seconds after they upload.</EmptyHint>
      ) : (
        <div className="ai-scenes">
          {scenes.map((s) => (
            <Link key={s.scene} to={`/scenes/${s.scene}`} className="ai-scene">
              <img src={thumbUrl(s.coverPhotoId)} alt="" loading="lazy" />
              <span className="ai-scene__label">
                <span className="ai-scene__name">{SCENE_LABELS[s.scene]}</span>
                <span className="ai-scene__count mono">{s.count.toLocaleString('en')}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
      {visible && <PrivacyNote />}
    </Shell>
  );
}

/** One scene's photos ("/scenes/:scene"), hosted with the viewer like the library. */
export function ScenePhotosPage({ scene }: { scene: SceneId }) {
  const nav = useNavigate();
  const loc = useLocation();
  const { returnId } = useViewerHost();
  const query = useMemo(() => ({ scene, sort: 'taken' as const }), [scene]);
  const list = usePhotoList(query);
  const sel = useSelection();
  const { actions, pickerEl } = useLibraryActions(list, sel);
  const label = SCENE_LABELS[scene];
  useShareWithViewer({ items: list.items, hasMore: list.hasMore, loadMore: list.loadMore, backLabel: label });
  const open = useCallback(
    (i: number) => {
      const p = list.items[i];
      if (p) nav(`/photo/${encodeURIComponent(p.id)}`, { state: { bg: loc.pathname } });
    },
    [list.items, nav, loc.pathname],
  );
  return (
    <Shell title={label}>
      <div className="lib-toolbar">
        <Button kind="ghost" size="sm" icon="chevL" onClick={() => nav('/scenes')}>
          Scenes
        </Button>
        <span className="lib-toolbar__spacer" />
        {list.items.length > 0 && (
          <Button
            size="sm"
            kind={sel.selecting ? 'primary' : 'secondary'}
            icon={sel.selecting ? undefined : 'check'}
            onClick={() => sel.setSelecting(!sel.selecting)}
          >
            {sel.selecting ? 'Done' : 'Select'}
          </Button>
        )}
      </div>
      {sel.selecting && <SelectionBar count={sel.count} actions={actions} onClear={sel.clear} />}
      {list.error && (
        <Note tone="bad" icon="alert" role="alert">
          {list.error}
        </Note>
      )}
      {list.initial ? (
        <GridSkeleton />
      ) : list.items.length === 0 ? (
        <EmptyHint title={`No ${label.toLowerCase()} photos yet`} />
      ) : (
        <PhotoGrid
          items={list.items}
          sort="taken"
          hasMore={list.hasMore}
          loading={list.loading}
          loadMore={list.loadMore}
          selection={sel}
          onOpen={open}
          focusId={returnId}
          label={`${label} photos`}
        />
      )}
      {pickerEl}
    </Shell>
  );
}
