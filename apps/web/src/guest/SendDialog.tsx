import { GUEST_NAME_MAX, GUEST_NOTE_MAX, type GuestPhoto } from '@zephyr/shared/client';
import { Button, Dialog, Field, Note } from '@zephyr/ui';
import { type FormEvent, useId, useState } from 'react';

export interface SendDialogProps {
  open: boolean;
  onClose: () => void;
  studioName: string;
  favourites: GuestPhoto[];
  count: number;
  initialName: string;
  onSend: (name: string, note: string) => Promise<void>;
}

export function SendDialog({
  open,
  onClose,
  studioName,
  favourites,
  count,
  initialName,
  onSend,
}: SendDialogProps) {
  const [name, setName] = useState(initialName);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteId = useId();
  const formId = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      setError('Add your name so they know whose picks these are.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSend(n, note.trim());
    } catch {
      setError('That didn’t send. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };
  const shown = favourites.slice(0, 5);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Send ${count} ${count === 1 ? 'favourite' : 'favourites'}`}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" type="submit" form={formId} icon="heart" busy={busy} className="g-acc-btn">
            Send favourites
          </Button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit} noValidate>
        <p className="g-muted g-small">To {studioName}</p>
        <div className="g-send__thumbs" aria-hidden="true">
          {shown.map((p) => (
            <img key={p.id} src={p.grid} alt="" referrerPolicy="no-referrer" />
          ))}
          {count > shown.length && <span className="g-send__more">+{count - shown.length}</span>}
        </div>
        <Field
          label="Your name"
          value={name}
          maxLength={GUEST_NAME_MAX}
          autoComplete="name"
          onChange={(e) => setName(e.target.value)}
          hint={`So ${studioName} knows whose picks these are`}
          error={error && !name.trim() ? error : null}
          required
        />
        <div className="z-field">
          <label htmlFor={noteId}>Note (optional)</label>
          <textarea
            id={noteId}
            className="z-input g-textarea"
            rows={3}
            maxLength={GUEST_NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {error && name.trim() && (
          <Note tone="bad" icon="alert" role="alert">
            {error}
          </Note>
        )}
        <p className="g-muted g-small">
          You can keep changing your favourites and send again; they see the latest.
        </p>
      </form>
    </Dialog>
  );
}
