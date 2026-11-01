import type { PhotoItem } from '@zephyr/shared/client';
import { Button, Dialog, Spinner } from '@zephyr/ui';
import { thumbUrl } from '../../lib/library';
import { usePhotoList } from '../../lib/photos';

/** Picks a reference photo from the member's library. */
export function ReferencePicker({
  open,
  onClose,
  onPick,
  exclude,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (p: PhotoItem) => void;
  exclude?: string;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Pick a reference photo">
      {open && (
        <ReferenceGrid
          onPick={(p) => {
            onPick(p);
            onClose();
          }}
          exclude={exclude}
        />
      )}
    </Dialog>
  );
}
function ReferenceGrid({ onPick, exclude }: { onPick: (p: PhotoItem) => void; exclude?: string }) {
  const list = usePhotoList({ view: 'library', sort: 'taken' });
  const items = list.items.filter((p) => p.id !== exclude && p.hasThumb);
  return (
    <div className="ai-refgrid-wrap">
      <p className="edlg-note">Every photo you match is moved toward this one’s colour and tone.</p>
      {list.initial ? (
        <Spinner size={18} label="Loading photos" />
      ) : (
        <div className="ai-refgrid">
          {items.map((p) => (
            <button key={p.id} type="button" className="ai-refgrid__item" onClick={() => onPick(p)}>
              <img src={thumbUrl(p.id)} alt={p.filename} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {list.hasMore && (
        <Button size="sm" kind="ghost" busy={list.loading} onClick={list.loadMore}>
          Show more
        </Button>
      )}
    </div>
  );
}
