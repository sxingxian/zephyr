import type { AlbumItem } from '@zephyr/shared/client';
import { Button, Dialog, Field, Icon, Spinner, useToast } from '@zephyr/ui';
import { type FormEvent, useEffect, useState } from 'react';
import { errorMessage } from '../lib/api';
import { emitLibrary } from '../lib/bus';
import { bulk, createAlbum, listAlbums, thumbUrl } from '../lib/library';

/** "Add to album": pick an existing album or make a new one with the chosen photos. */
export function AlbumPicker({
  open,
  photoIds,
  onClose,
  onDone,
}: {
  open: boolean;
  photoIds: string[];
  onClose: () => void;
  onDone?: (album: { id: string; name: string }) => void;
}) {
  const toast = useToast();
  const [albums, setAlbums] = useState<AlbumItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const c = new AbortController();
    setAlbums(null);
    setError(null);
    setName('');
    listAlbums(c.signal)
      .then(setAlbums)
      .catch((e) => {
        if (!c.signal.aborted) setError(errorMessage(e));
      });
    return () => c.abort();
  }, [open]);

  const n = photoIds.length;
  const photos = `${n} photo${n === 1 ? '' : 's'}`;
  const finish = (a: { id: string; name: string }) => {
    emitLibrary({ type: 'albums' });
    toast.show(`Added ${photos} to ${a.name}`, 'good');
    onDone?.(a);
    onClose();
  };
  const addTo = async (a: AlbumItem) => {
    setBusy(a.id);
    try {
      await bulk(photoIds, 'add_to_album', a.id);
      finish(a);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy('new');
    try {
      const a = await createAlbum({ name: trimmed, photoIds });
      finish(a);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Add to album">
      <p className="z-muted">Adding {photos}. Photos stay in your library too.</p>
      {error && (
        <p className="z-hint z-hint--error" role="alert">
          {error}
        </p>
      )}
      <form className="picker__new" onSubmit={create}>
        <Field
          label="New album"
          size="md"
          placeholder="Album name"
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          type="submit"
          kind="primary"
          icon="plus"
          busy={busy === 'new'}
          disabled={!name.trim() || busy !== null}
        >
          Create
        </Button>
      </form>
      {albums === null && !error ? (
        <div className="picker__loading">
          <Spinner size={18} label="Loading albums" />
        </div>
      ) : (
        albums &&
        albums.length > 0 && (
          <ul className="picker__list" aria-label="Your albums">
            {albums.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="picker__item"
                  onClick={() => addTo(a)}
                  disabled={busy !== null}
                  aria-busy={busy === a.id || undefined}
                >
                  <span className="picker__cover">
                    {a.coverPhotoIds[0] ? (
                      <img src={thumbUrl(a.coverPhotoIds[0])} alt="" loading="lazy" />
                    ) : (
                      <Icon name="folder" size={18} />
                    )}
                  </span>
                  <span className="picker__text">
                    <strong>{a.name}</strong>
                    <span>
                      {a.photoCount} photo{a.photoCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  {busy === a.id ? <Spinner size={16} /> : <Icon name="plus" size={16} />}
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </Dialog>
  );
}
