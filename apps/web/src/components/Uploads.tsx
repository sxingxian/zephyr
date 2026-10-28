import { Button, Icon, IconButton, Mascot } from '@zephyr/ui';
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { etaText } from '../lib/format';
import { type UploadItem, uploads, useLeaveWarning, useUploads } from '../lib/uploads';
import { acceptFor, formatBytes, formatOf, uploadRulesLine, useUsage } from '../lib/usage';

// ---------------------------------------------------------------- picker
const Picker = createContext<() => void>(() => {});
/** Opens the file picker (Upload buttons anywhere in the signed-in app). */
export const useUploadPicker = () => useContext(Picker);

/** Hidden file input plus drag & drop anywhere in the page. */
export function UploadProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const pick = useCallback(() => input.current?.click(), []);
  const [dragging, setDragging] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const add = useCallback((files: File[]) => {
    if (!files.length) return;
    void uploads.add(files);
    setSheetOpen(true);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'));
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      add([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [add, enabled]);

  return (
    <Picker.Provider value={pick}>
      {children}
      {enabled && (
        <UploadChrome
          input={input}
          add={add}
          dragging={dragging}
          sheetOpen={sheetOpen}
          setSheetOpen={setSheetOpen}
        />
      )}
    </Picker.Provider>
  );
}

function UploadChrome({
  input,
  add,
  dragging,
  sheetOpen,
  setSheetOpen,
}: {
  input: RefObject<HTMLInputElement | null>;
  add: (f: File[]) => void;
  dragging: boolean;
  sheetOpen: boolean;
  setSheetOpen: (v: boolean) => void;
}) {
  const usage = useUsage();
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={usage ? acceptFor(usage.fileTypes) : undefined}
        onChange={(e) => {
          add([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      {dragging && <DropOverlay />}
      <UploadTray sheetOpen={sheetOpen} setSheetOpen={setSheetOpen} />
    </>
  );
}

export function DropOverlay() {
  const usage = useUsage();
  return (
    <div className="drop" aria-hidden="true">
      <div className="drop__art">
        <Mascot pose="hold" width={150} />
      </div>
      <strong className="drop__title">Drop to upload</strong>
      <span className="drop__sub">{uploadRulesLine(usage)}</span>
    </div>
  );
}

// ---------------------------------------------------------------- tray
function rowStatus(it: UploadItem): { text: string; tone: 'good' | 'bad' | 'muted' } | null {
  switch (it.state) {
    case 'done':
      return { text: 'Uploaded', tone: 'good' };
    case 'duplicate':
    case 'rejected':
      return { text: it.message ?? 'Skipped', tone: it.state === 'rejected' ? 'bad' : 'muted' };
    case 'failed':
      return { text: it.message ?? 'Didn’t upload', tone: 'bad' };
    case 'hashing':
      return { text: 'Preparing', tone: 'muted' };
    case 'queued':
    case 'waiting':
      return { text: 'Waiting', tone: 'muted' };
    case 'paused':
      return { text: 'Paused', tone: 'muted' };
    default:
      return null;
  }
}

function TrayRow({ it }: { it: UploadItem }) {
  const st = rowStatus(it);
  const pct = it.size ? Math.round((it.sent / it.size) * 100) : 0;
  const cancellable = ['hashing', 'queued', 'waiting', 'uploading', 'paused', 'failed'].includes(it.state);
  return (
    <li className="tray__row">
      <span className="tray__thumb">
        {it.thumbUrl ? <img src={it.thumbUrl} alt="" /> : <Icon name="image" size={16} />}
      </span>
      <span className="tray__info">
        <span className="tray__line">
          <span className="tray__name">{it.name}</span>
          <span className="tray__size">{formatBytes(it.size)}</span>
        </span>
        {st ? (
          <span className={`tray__status tray__status--${st.tone}`}>{st.text}</span>
        ) : (
          <span
            className="tray__bar"
            role="progressbar"
            aria-label={`${it.name} upload progress`}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
      {it.state === 'failed' && it.retryable ? (
        <Button size="sm" kind="ghost" onClick={() => uploads.retry(it.key)}>
          Retry
        </Button>
      ) : cancellable ? (
        <IconButton icon="x" size="sm" label={`Cancel ${it.name}`} onClick={() => uploads.cancel(it.key)} />
      ) : null}
    </li>
  );
}

/** Upload progress: a floating card on wide screens, a bottom sheet on phones. */
export function UploadTray({
  sheetOpen,
  setSheetOpen,
}: {
  sheetOpen: boolean;
  setSheetOpen: (v: boolean) => void;
}) {
  const s = useUploads();
  const usage = useUsage();
  const [min, setMin] = useState(false);
  useLeaveWarning(s.busy);
  if (!s.total) return null;

  const active = s.items.filter((i) => i.state !== 'duplicate' && i.state !== 'rejected').length;
  const current = Math.min(active, s.done + 1);
  const title = s.busy
    ? s.paused
      ? `Paused · ${s.done} of ${active} uploaded`
      : `Uploading ${current} of ${active}`
    : s.failed
      ? `${s.failed} didn’t upload`
      : `Uploaded ${s.done} photo${s.done === 1 ? '' : 's'}`;
  const eta = etaText(s.etaSeconds);
  const sub = s.busy
    ? `${formatBytes(s.bytesSent)} of ${formatBytes(s.bytesTotal)}${eta ? ` · ${eta}` : ''}`
    : s.items.some((i) => i.state === 'duplicate' || i.state === 'rejected')
      ? 'Some files were skipped'
      : 'All done';
  const pct = s.bytesTotal ? Math.round((s.bytesSent / s.bytesTotal) * 100) : 0;
  const head = (
    <div className="tray__head">
      <span className="tray__icon">
        <Icon name="upload" size={17} />
      </span>
      <div className="tray__titles">
        <strong>{title}</strong>
        <span>{sub}</span>
      </div>
      {s.busy &&
        (s.paused ? (
          <IconButton icon="play" size="sm" label="Resume uploads" onClick={() => uploads.resumeAll()} />
        ) : (
          <IconButton icon="pause" size="sm" label="Pause uploads" onClick={() => uploads.pauseAll()} />
        ))}
      {!s.busy && s.failed > 0 && (
        <Button size="sm" kind="ghost" onClick={() => uploads.retryAll()}>
          Retry all
        </Button>
      )}
      {!s.busy && (
        <IconButton icon="x" size="sm" label="Close uploads" onClick={() => uploads.clearFinished()} />
      )}
    </div>
  );
  const bar = (
    <div className="tray__total" aria-hidden="true">
      <span style={{ width: `${pct}%` }} />
    </div>
  );
  const foot = (
    <div className="tray__foot">
      <span>{s.busy ? 'Keep this tab open until uploads finish' : 'New photos are in your library'}</span>
      {usage && (
        <span className="mono">{formatOf(usage.usedBytes + usage.reservedBytes, usage.limitBytes)} used</span>
      )}
    </div>
  );
  const list = (
    <ul className="tray__list">
      {s.items.map((it) => (
        <TrayRow key={it.key} it={it} />
      ))}
    </ul>
  );

  return (
    <>
      <section className={`tray${min ? ' tray--min' : ''}`} aria-label="Uploads">
        <div className="tray__headrow">
          {head}
          <IconButton
            icon={min ? 'chevU' : 'chevD'}
            size="sm"
            label={min ? 'Show uploads' : 'Minimise uploads'}
            onClick={() => setMin(!min)}
            aria-expanded={!min}
          />
        </div>
        {bar}
        {!min && list}
        {!min && foot}
      </section>
      {/* Phone: a pill above the tab bar that opens the sheet. */}
      <button
        type="button"
        className="tray-pill"
        onClick={() => setSheetOpen(true)}
        aria-label={`${title}. Show uploads`}
      >
        <Icon name="upload" size={16} />
        <span>{title}</span>
        <span className="tray-pill__bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
      </button>
      {sheetOpen && (
        <div className="sheet-wrap">
          <button
            type="button"
            className="sheet-scrim"
            aria-label="Close uploads"
            onClick={() => setSheetOpen(false)}
          />
          <section className="sheet" role="dialog" aria-modal="false" aria-label="Uploads">
            <span className="sheet__handle" aria-hidden="true" />
            {head}
            {bar}
            {list}
            {foot}
            <Button kind="secondary" full onClick={() => setSheetOpen(false)}>
              Hide
            </Button>
          </section>
        </div>
      )}
    </>
  );
}
