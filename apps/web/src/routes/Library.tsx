import { Button, Chip, Mascot } from '@zephyr/ui';
import { Shell } from '../components/Shell';
import { useSession } from '../lib/session';

/** Signed-in home. The library itself (uploads, grid, editing) arrives in phase 3. */
export function Library() {
  const { user } = useSession();
  const first = user?.displayName?.split(' ')[0];
  return (
    <Shell
      title="Library"
      actions={
        <Button kind="primary" icon="upload" disabled title="Uploads arrive in the next update">
          Upload
        </Button>
      }
    >
      <section className="empty" aria-labelledby="empty-title">
        <Mascot
          pose="nap"
          width={230}
          tile={{ background: 'var(--m-dusk)', height: 250 }}
          className="empty__art"
        />
        {first && <p className="z-eyebrow">Welcome, {first}</p>}
        <h2 id="empty-title" className="empty__title">
          Your library is ready for its first shoot
        </h2>
        <p className="empty__text">
          Uploading arrives in the next update. Every edit will be a recipe on top, so your originals stay
          exactly as they were.
        </p>
        <div className="empty__actions">
          <Button kind="primary" size="lg" icon="upload" disabled>
            Upload photos
          </Button>
          <Chip tone="outline" icon="clock">
            Coming soon
          </Chip>
        </div>
        <span className="z-hint">JPEG, PNG, WEBP · RAW (CR2, NEF, ARW) on Pro</span>
      </section>
    </Shell>
  );
}
