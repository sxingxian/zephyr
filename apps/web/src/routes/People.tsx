import type { FaceSuggestion, PersonSummary } from '@zephyr/shared/client';
import { Button, Dialog, Field, Icon, IconButton, Mascot, Note, Spinner, useToast } from '@zephyr/ui';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { AiPausedNote, ConsentDialog, FaceCrop, plural, UpgradeHint } from '../components/ai/AiBits';
import { SelectionBar, useShareWithViewer, useViewerHost } from '../components/LibraryBits';
import { PhotoGrid } from '../components/PhotoGrid';
import { Shell } from '../components/Shell';
import { useShareGallery } from '../components/share/ShareDialogs';
import {
  fetchPeople,
  fetchPerson,
  fetchSuggestions,
  mergePeople,
  patchAiSettings,
  patchPerson,
  personFaces,
  setAiStatus,
  useAiStatus,
} from '../lib/aiClient';
import { errorMessage } from '../lib/api';
import { allPhotoIds } from '../lib/library';
import { useCan } from '../lib/libraryContext';
import { usePhotoList } from '../lib/photos';
import { useSelection } from '../lib/selection';
import { useScanner } from '../lib/useScanner';
import { EmptyHint, GridSkeleton } from './Library';
import '../ai.css';

/** People (phase 6): opt-in face grouping, found on the device and kept in the account. */

export const personName = (p: Pick<PersonSummary, 'name'>) => p.name || 'Unnamed';

function ScanBar() {
  const { progress, scanner } = useScanner();
  if (!progress || !scanner) return null;
  const f = progress.faces;
  const active = progress.phase === 'faces' || (progress.phase === 'paused' && f.total !== null);
  if (!active || f.total === null || f.remaining === null || f.remaining === 0) return null;
  const done = Math.max(0, f.total - f.remaining);
  const pct = f.total ? Math.round((done / f.total) * 100) : 0;
  const paused = progress.phase === 'paused';
  return (
    <div className="ai-scan" role="status" aria-live="polite">
      {paused ? <Icon name="pause" size={18} /> : <Spinner size={18} />}
      <div className="ai-scan__main">
        <span className="ai-scan__title">
          {paused ? 'Paused · ' : 'Finding faces on this device · '}
          {done.toLocaleString('en')} of {f.total.toLocaleString('en')} photos
        </span>
        <div
          className="ai-scan__bar"
          role="progressbar"
          aria-label="Faces found"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span className="ai-scan__fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className="z-muted ai-scan__hint">Pauses when you close Zephyr</span>
      <Button
        size="sm"
        icon={paused ? 'play' : 'pause'}
        onClick={() => (paused ? scanner.resume() : scanner.pause())}
      >
        {paused ? 'Resume' : 'Pause'}
      </Button>
    </div>
  );
}

function PeopleIntro({ onTurnOn }: { onTurnOn: () => void }) {
  const owner = useCan('aiSettings');
  const points: [Parameters<typeof Icon>[0]['name'], string, string][] = [
    [
      'monitor',
      'Runs on your device',
      'Faces are found in the browser. Photos aren’t sent anywhere for this.',
    ],
    [
      'lock',
      'Kept in your account',
      'Only a number code per face is saved, never shared or matched with other accounts.',
    ],
    ['trash', 'Delete any time', 'Turning it off deletes all face data straight away.'],
  ];
  return (
    <section className="ai-intro" aria-labelledby="people-intro">
      <Mascot
        pose="wave"
        width={140}
        tile={{ background: 'var(--m-mist)', height: 150 }}
        className="ai-intro__art"
      />
      <h2 id="people-intro" className="ai-intro__title">
        Find the same people across your photos
      </h2>
      <p className="ai-intro__text">
        Zephyr can group photos by face, so you can find every photo of a client or family member. It’s off
        until you turn it on.
      </p>
      <ul className="ai-intro__points">
        {points.map(([icon, a, b]) => (
          <li key={a}>
            <Icon name={icon} size={20} />
            <span>
              <strong>{a}</strong>
              <span className="z-muted">{b}</span>
            </span>
          </li>
        ))}
      </ul>
      {owner ? (
        <Button kind="primary" size="lg" icon="people" onClick={onTurnOn}>
          Turn on face grouping
        </Button>
      ) : (
        <span className="z-hint">Only the library’s owner can turn on face grouping.</span>
      )}
    </section>
  );
}

function Suggestions({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [list, setList] = useState<FaceSuggestion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const c = new AbortController();
    setList(null);
    fetchSuggestions(c.signal)
      .then((r) => setList(r.suggestions))
      .catch((e) => (e as Error).name !== 'AbortError' && setList([]));
    return () => c.abort();
  }, [open]);
  const act = async (s: FaceSuggestion, action: 'confirm' | 'remove') => {
    setBusy(s.faceId);
    try {
      await personFaces(s.personId, { action, faceIds: [s.faceId] });
      setList((l) => l?.filter((x) => x.faceId !== s.faceId) ?? null);
      onDone();
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Review suggestions">
      {!list ? (
        <Spinner size={18} label="Loading suggestions" />
      ) : list.length === 0 ? (
        <p className="edlg-note">Nothing to review right now.</p>
      ) : (
        <ul className="ai-sugg">
          {list.map((s) => (
            <li key={s.faceId}>
              <FaceCrop
                photoId={s.photoId}
                box={s.box}
                size={64}
                label={`Face that may be ${s.personName}`}
              />
              <span className="ai-sugg__text">
                Is this <strong>{s.personName}</strong>?
              </span>
              <Button size="sm" busy={busy === s.faceId} onClick={() => void act(s, 'confirm')}>
                Yes
              </Button>
              <Button
                size="sm"
                kind="ghost"
                disabled={busy === s.faceId}
                onClick={() => void act(s, 'remove')}
              >
                No
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function PersonTile({ p }: { p: PersonSummary }) {
  return (
    <Link to={`/people/${encodeURIComponent(p.id)}`} className="ai-person">
      {p.cover ? (
        <FaceCrop photoId={p.cover.photoId} box={p.cover.box} size={112} label="" />
      ) : (
        <span className="ai-face ai-face--empty" style={{ width: 112, height: 112 }}>
          <Icon name="user" size={28} />
        </span>
      )}
      <span className={`ai-person__name${p.name ? '' : ' is-unnamed'}`}>{p.name || 'Add a name'}</span>
      <span className="ai-person__count mono">{plural(p.photoCount, 'photo')}</span>
    </Link>
  );
}

export function PeoplePage() {
  const status = useAiStatus();
  const toast = useToast();
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [sugg, setSugg] = useState(false);
  const state = status?.features.face_grouping;
  const on = Boolean(status?.enabled && state === 'on');
  const canEdit = useCan('edit');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const r = await fetchPeople(hidden, signal);
        setPeople(r.people);
        setError(null);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError(errorMessage(e));
      }
    },
    [hidden],
  );
  useEffect(() => {
    if (!on) return;
    const c = new AbortController();
    void load(c.signal);
    // New faces arrive from the scanner: refresh every 20 s while the page is open.
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), 20_000);
    return () => {
      c.abort();
      clearInterval(t);
    };
  }, [on, load]);

  const turnOn = async (faceConsent: { version: number; rightsConfirmed: true }) => {
    const s = await patchAiSettings({ faceGrouping: true, faceConsent });
    setAiStatus(s);
    toast.show('Face grouping is on. Faces are found on this device while Zephyr is open.', 'good');
  };

  let body: ReactNode;
  if (!status) body = <GridSkeleton />;
  else if (!status.enabled) body = <AiPausedNote />;
  else if (state === 'off_plan') body = <UpgradeHint what="Face grouping" icon="people" />;
  else if (state === 'off_admin')
    body = (
      <Note tone="neutral" icon="info">
        Face grouping is switched off right now.
      </Note>
    );
  else if (!on) body = <PeopleIntro onTurnOn={() => setConsent(true)} />;
  else
    body = (
      <>
        <Note tone="good" icon="shieldCheck">
          Face grouping is on. Face data stays in your account, is never shared or used for ads or training.{' '}
          <Link to="/settings/ai" className="text-link">
            Turn off and delete face data
          </Link>
        </Note>
        <ScanBar />
        <section className="ai-people" aria-labelledby="people-h">
          <div className="ai-section-head">
            <h2 id="people-h">People</h2>
            <span className="z-muted">Found on your devices, kept in your account</span>
            <span className="lib-toolbar__spacer" />
            {canEdit && (
              <Button size="sm" kind="tint" iconRight="chevR" onClick={() => setSugg(true)}>
                Review suggestions
              </Button>
            )}
            <Button size="sm" kind="ghost" onClick={() => setHidden((h) => !h)} aria-pressed={hidden}>
              {hidden ? 'Hide hidden' : 'Show hidden'}
            </Button>
          </div>
          {error && (
            <Note tone="bad" icon="alert" role="alert">
              {error}
            </Note>
          )}
          {!people ? (
            <GridSkeleton />
          ) : people.length === 0 ? (
            <EmptyHint title="No people yet">
              Faces appear here as this device finds them. People with at least three photos show up first.
            </EmptyHint>
          ) : (
            <div className="ai-people__grid">
              {people.map((p) => (
                <PersonTile key={p.id} p={p} />
              ))}
            </div>
          )}
        </section>
        <Suggestions open={sugg} onClose={() => setSugg(false)} onDone={() => void load()} />
      </>
    );

  return (
    <Shell title="People">
      {body}
      <ConsentDialog open={consent} onClose={() => setConsent(false)} onConfirm={turnOn} />
    </Shell>
  );
}

// ---------------------------------------------------------------- one person
function PeoplePicker({
  open,
  title,
  exclude,
  allowNew,
  onClose,
  onPick,
}: {
  open: boolean;
  title: string;
  exclude: string;
  allowNew?: boolean;
  onClose: () => void;
  onPick: (id: string | 'new') => Promise<void>;
}) {
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const c = new AbortController();
    setError(null);
    fetchPeople(false, c.signal)
      .then((r) => setPeople(r.people.filter((p) => p.id !== exclude)))
      .catch((e) => (e as Error).name !== 'AbortError' && setError(errorMessage(e)));
    return () => c.abort();
  }, [open, exclude]);
  const pick = async (id: string | 'new') => {
    setBusy(id);
    setError(null);
    try {
      await onPick(id);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      {error && (
        <Note tone="bad" icon="alert" role="alert">
          {error}
        </Note>
      )}
      {!people ? (
        <Spinner size={18} label="Loading people" />
      ) : (
        <ul className="ai-pick">
          {allowNew && (
            <li>
              <button
                type="button"
                className="ai-pick__row"
                disabled={Boolean(busy)}
                onClick={() => void pick('new')}
              >
                <span className="ai-face ai-face--empty" style={{ width: 40, height: 40 }}>
                  <Icon name="plus" size={18} />
                </span>
                <span>New person</span>
              </button>
            </li>
          )}
          {people.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="ai-pick__row"
                disabled={Boolean(busy)}
                onClick={() => void pick(p.id)}
              >
                {p.cover ? (
                  <FaceCrop photoId={p.cover.photoId} box={p.cover.box} size={40} label="" original="thumb" />
                ) : (
                  <span className="ai-face ai-face--empty" style={{ width: 40, height: 40 }} />
                )}
                <span>{personName(p)}</span>
                <span className="z-muted mono">{plural(p.photoCount, 'photo')}</span>
                {busy === p.id && <Spinner size={14} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export function PersonPage({ personId }: { personId: string }) {
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const { returnId } = useViewerHost();
  const [person, setPerson] = useState<PersonSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState<null | 'merge' | 'move'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Viewers see people and their photos; naming, merging and sorting faces is for the Owner and Editors.
  const canEdit = useCan('edit');
  const canShare = useCan('galleries');
  const query = useMemo(() => ({ person: personId, sort: 'taken' as const }), [personId]);
  const list = usePhotoList(query);
  const sel = useSelection();
  const sharing = useShareGallery();
  const label = person ? personName(person) : 'Person';

  const loadPerson = useCallback(async () => {
    try {
      const r = await fetchPerson(personId);
      setPerson(r.person);
      setName(r.person.name ?? '');
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [personId]);
  useEffect(() => {
    void loadPerson();
  }, [loadPerson]);

  useShareWithViewer({ items: list.items, hasMore: list.hasMore, loadMore: list.loadMore, backLabel: label });
  const open = useCallback(
    (i: number) => {
      const p = list.items[i];
      if (p) nav(`/photo/${encodeURIComponent(p.id)}`, { state: { bg: loc.pathname } });
    },
    [list.items, nav, loc.pathname],
  );

  const run = async (key: string, fn: () => Promise<void>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.show(ok, 'good');
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const rename = () => {
    const next = name.trim();
    if (!person || next === (person.name ?? '')) return;
    void run('rename', async () => {
      const r = await patchPerson(person.id, { name: next || null });
      setPerson(r.person);
    });
  };
  const ids = [...sel.selected];
  const removeSelected = () =>
    run(
      'remove',
      async () => {
        const r = await personFaces(personId, { action: 'remove', photoIds: ids });
        setPerson(r.person);
        list.remove(ids);
        sel.clear();
      },
      `Removed ${plural(ids.length, 'photo')} from ${label}. They stay in your library.`,
    );

  return (
    <Shell title="People">
      <div className="ai-person-head">
        <Button kind="ghost" size="sm" icon="chevL" onClick={() => nav('/people')}>
          People
        </Button>
        {person?.cover ? (
          <FaceCrop photoId={person.cover.photoId} box={person.cover.box} size={72} label="" />
        ) : (
          <span className="ai-face ai-face--empty" style={{ width: 72, height: 72 }}>
            <Icon name="user" size={24} />
          </span>
        )}
        <div className="ai-person-head__main">
          <Field
            ariaLabel="Name"
            size="md"
            value={name}
            placeholder="Add a name"
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onBlur={rename}
            readOnly={!canEdit}
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
          />
          {person && (
            <span className="z-muted">
              {plural(person.photoCount, 'photo')}
              {person.firstAt && person.lastAt
                ? ` · ${new Date(person.firstAt).getFullYear()} to ${new Date(person.lastAt).getFullYear()}`
                : ''}
              {person.hidden ? ' · Hidden' : ''}
            </span>
          )}
        </div>
        {canEdit && (
          <Button size="sm" icon="people" onClick={() => setPicker('merge')}>
            Merge with…
          </Button>
        )}
        {canShare && (
          <Button
            size="sm"
            icon="share"
            busy={busy === 'share'}
            onClick={() => void run('share', async () => sharing.open(await allPhotoIds(query)))}
          >
            Share these photos
          </Button>
        )}
        {canEdit && (
          <span className="ai-more">
            <IconButton icon="more" label="More" aria-expanded={menu} onClick={() => setMenu((m) => !m)} />
            {menu && person && (
              <div className="ai-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    void run(
                      'hide',
                      async () => {
                        const r = await patchPerson(person.id, { hidden: !person.hidden });
                        setPerson(r.person);
                      },
                      person.hidden ? 'Shown in People again' : 'Hidden from People',
                    );
                  }}
                >
                  {person.hidden ? 'Show in People' : 'Hide this person'}
                </button>
                {person.name && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      void run('unname', async () => {
                        const r = await patchPerson(person.id, { name: null });
                        setPerson(r.person);
                        setName('');
                      });
                    }}
                  >
                    Remove name
                  </button>
                )}
              </div>
            )}
          </span>
        )}
      </div>
      {error && (
        <Note tone="bad" icon="alert" role="alert">
          {error}
        </Note>
      )}
      <div className="lib-toolbar">
        <span className="lib-toolbar__spacer" />
        {canEdit && list.items.length > 0 && (
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
      {sel.selecting && (
        <SelectionBar
          count={sel.count}
          onClear={sel.clear}
          actions={[
            {
              icon: 'x',
              label: `Not ${label}`,
              onClick: () => void removeSelected(),
              busy: busy === 'remove',
            },
            { icon: 'people', label: 'Move to another person', onClick: () => setPicker('move') },
          ]}
        />
      )}
      {list.initial ? (
        <GridSkeleton />
      ) : list.items.length === 0 ? (
        <EmptyHint title="No photos">This person’s photos appear here.</EmptyHint>
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
          label={`Photos of ${label}`}
        />
      )}
      <Note tone="neutral" icon="info">
        “Not {label}” teaches the grouping for next time. The photos stay in your library.
      </Note>
      <PeoplePicker
        open={picker !== null}
        title={picker === 'merge' ? `Merge someone into ${label}` : `Move ${plural(ids.length, 'photo')} to…`}
        exclude={personId}
        allowNew={picker === 'move'}
        onClose={() => setPicker(null)}
        onPick={async (id) => {
          if (picker === 'merge') {
            const r = await mergePeople(personId, [id as string]);
            setPerson(r.person);
            list.reload();
            toast.show('Merged', 'good');
          } else {
            await personFaces(personId, { action: 'move', to: id, photoIds: ids });
            list.remove(ids);
            sel.clear();
            void loadPerson();
            toast.show(`Moved ${plural(ids.length, 'photo')}`, 'good');
          }
        }}
      />
      {sharing.dialogs}
    </Shell>
  );
}
