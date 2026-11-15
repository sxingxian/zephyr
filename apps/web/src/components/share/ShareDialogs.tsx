import {
  type Branding,
  GALLERY_MESSAGE_MAX,
  GALLERY_NAME_MAX,
  type GalleryCreated,
  type GalleryDownloads,
  type GalleryExtras,
  type SharingLimits,
} from '@zephyr/shared/client';
import { Button, Dialog, Field, Icon, Note, Switch } from '@zephyr/ui';
import {
  type FormEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { Link, useNavigate } from 'react-router';
import { adsenseLoaded, holdAdsense } from '../../lib/ads';
import { ApiFailure, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { browser, sessionUserId } from '../../lib/sessionGuard';
import {
  createGallery,
  galleryPreviewPath,
  getBranding,
  getRenderQueue,
  isoDay,
  maxLinkDays,
  PLAN_NAME,
  sharingLimits,
  watermarkReady,
} from '../../lib/share';
import { startShareHandoff } from '../../lib/shareHandoff';
import { shareRenders } from '../../lib/shareRenders';
import { useUsage } from '../../lib/usage';
import { useSecretsAllowed } from '../ads/NoAdsSurface';
import { CopyButton, PasscodeReveal, PlanBadge, photosLabel, ShNote } from './ShareBits';

export const EXTRA_ROWS: {
  key: keyof GalleryExtras;
  limit: keyof SharingLimits;
  label: string;
  hint: string;
}[] = [
  {
    key: 'favourites',
    limit: 'guestFavourites',
    label: 'Let guests pick favourites',
    hint: 'They can send you their selection',
  },
  {
    key: 'watermark',
    limit: 'watermark',
    label: 'Watermark photos',
    hint: 'Your watermark from Settings › Sharing & branding',
  },
  {
    key: 'branding',
    limit: 'branding',
    label: 'Show your branding',
    hint: 'Logo, name and colour on the guest pages',
  },
  {
    key: 'accessLog',
    limit: 'accessLog',
    label: 'Keep an access log',
    hint: 'Views, downloads and passcode attempts',
  },
];

/** Plan-aware choices for a gallery's downloads and extras, shared by the create dialog and Settings. */
export function DownloadChoice({
  value,
  onChange,
  limits,
  name,
}: {
  value: GalleryDownloads;
  onChange: (v: GalleryDownloads) => void;
  limits: SharingLimits;
  name?: string;
}) {
  const auto = useId();
  const opts: [GalleryDownloads, string, string, boolean][] = [
    ['none', 'View only', 'No download buttons', true],
    ['web', 'Web size', 'Up to 2048 px', true],
    ['full', 'Full size', 'Original resolution', limits.guestFullRes],
  ];
  return (
    <fieldset className="esize sh-choice">
      <legend>Guest downloads</legend>
      {opts.map(([v, a, b, ok]) => (
        <label
          key={v}
          className={`esize__opt${ok ? '' : ' is-locked'}`}
          title={ok ? undefined : 'Available on Pro and Studio'}
        >
          <span className="esize__title">
            <input
              type="radio"
              name={name ?? auto}
              checked={value === v}
              disabled={!ok}
              onChange={() => onChange(v)}
            />
            {a}
            {v === 'full' && <PlanBadge plan="Pro" />}
          </span>
          <span className="esize__hint">{b}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function ExtrasSwitches({
  value,
  onChange,
  limits,
  branding,
}: {
  value: GalleryExtras;
  onChange: (v: GalleryExtras) => void;
  limits: SharingLimits;
  branding: Branding | null;
}) {
  return (
    <div className="sh-extras">
      {EXTRA_ROWS.map((r) => {
        const allowed = Boolean(limits[r.limit]);
        // The watermark can only be turned on once one is set up; a gallery that has it on can always turn it off.
        const needsWatermark = r.key === 'watermark' && allowed && !watermarkReady(branding);
        const on = allowed && value[r.key];
        return (
          <Switch
            key={r.key}
            checked={on}
            disabled={!allowed || (needsWatermark && !on)}
            onChange={(on) => onChange({ ...value, [r.key]: on })}
            label={
              <span className="sh-switch-label">
                {r.label}
                <PlanBadge plan="Studio" />
              </span>
            }
            hint={
              needsWatermark ? (
                on ? (
                  <>
                    Your watermark isn’t set up, so guests see “Preparing” until it is. Fix it in{' '}
                    <Link to="/settings/sharing">Settings › Sharing &amp; branding</Link>
                  </>
                ) : (
                  <>
                    Set one up first in <Link to="/settings/sharing">Settings › Sharing &amp; branding</Link>
                  </>
                )
              ) : allowed ? (
                r.hint
              ) : (
                `${r.hint}. Available on Studio.`
              )
            }
          />
        );
      })}
    </div>
  );
}

function defaultExtras(limits: SharingLimits, branding: Branding | null): GalleryExtras {
  return {
    favourites: limits.guestFavourites,
    watermark: limits.watermark && watermarkReady(branding),
    branding: limits.branding,
    accessLog: limits.accessLog,
  };
}

/** Member's branding, loaded only when their plan has a branding feature. */
export function useBranding(limits: SharingLimits): Branding | null {
  const [b, setB] = useState<Branding | null>(null);
  const want = limits.watermark || limits.branding;
  useEffect(() => {
    if (!want) return;
    const c = new AbortController();
    getBranding(c.signal)
      .then(setB)
      .catch(() => setB(null));
    return () => c.abort();
  }, [want]);
  return b;
}

/**
 * Create a gallery from photos. On success the gallery-live dialog takes over; the link and passcode exist
 * only there, once. Phase 8: never rendered in a document holding Google's AdSense script (Share from an ad page
 * continues on /share/new instead).
 */
export function CreateGalleryDialog(props: Parameters<typeof CreateGalleryDialogInner>[0]) {
  return useSecretsAllowed() ? <CreateGalleryDialogInner {...props} /> : null;
}
/**
 * Phase 8: no Google script may be added to this document while `active` (a link or passcode may show). A layout
 * effect, so the hold is in place before any ad unit's (passive) effect in the same commit tries to load it.
 */
function useHoldAdsense(active: boolean): void {
  useLayoutEffect(() => (active ? holdAdsense() : undefined), [active]);
}

function CreateGalleryDialogInner({
  open,
  photoIds,
  defaultName = '',
  onClose,
  onCreated,
}: {
  open: boolean;
  photoIds: string[];
  defaultName?: string;
  onClose: () => void;
  onCreated: (r: GalleryCreated) => void;
}) {
  useHoldAdsense(open);
  const usage = useUsage();
  const limits = sharingLimits(usage);
  const branding = useBranding(limits);
  const maxDays = maxLinkDays(limits);
  const [name, setName] = useState(defaultName);
  const [passcode, setPasscode] = useState(true);
  const [expires, setExpires] = useState(() => isoDay(Math.min(30, maxDays)));
  const [downloads, setDownloads] = useState<GalleryDownloads>('web');
  const [extras, setExtras] = useState<GalleryExtras>(() => defaultExtras(limits, branding));
  const [touchedExtras, setTouchedExtras] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();

  // Each time it opens: a fresh form (with the album's name, when sharing an album).
  useEffect(() => {
    if (!open) return;
    setName(defaultName);
    setPasscode(true);
    setExpires(isoDay(Math.min(30, maxDays)));
    setDownloads('web');
    setTouchedExtras(false);
    setMessage('');
    setError(null);
  }, [open, defaultName, maxDays]);
  // Defaults follow the plan and whether a watermark exists, until the member changes a switch.
  const sharingKey = JSON.stringify(limits);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute when limits or branding change
  useEffect(() => {
    if (!touchedExtras) setExtras(defaultExtras(limits, branding));
  }, [sharingKey, branding, touchedExtras]);

  const atCap = limits.galleries !== null && limits.liveGalleries >= limits.galleries;
  const suspended = limits.suspended === true;
  const SUSPENDED_MSG = 'Sharing is paused on your account while we review a report. Contact support.';
  const plan = usage?.plan ?? 'free';
  const capMsg = `You have ${limits.liveGalleries} live galleries, the most on ${PLAN_NAME[plan]}. Revoke one, or upgrade to Pro for unlimited galleries.`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || atCap || suspended) return;
    const owner = sessionUserId();
    if (!owner) return;
    setBusy(true);
    setError(null);
    try {
      const r = await createGallery({
        name: name.trim(),
        photoIds,
        passcode,
        expiresOn: expires,
        downloads,
        extras: {
          favourites: limits.guestFavourites && extras.favourites,
          watermark: limits.watermark && extras.watermark,
          branding: limits.branding && extras.branding,
          accessLog: limits.accessLog && extras.accessLog,
        },
        message: message.trim() || undefined,
      });
      // Someone else signed in while this was in flight: don't show them this member's link and passcode.
      if (sessionUserId() !== owner) return;
      // Phase 8: Google's script got into this document anyway (it was added before the dialog opened): never
      // show the link or passcode here. The gallery page (no ads, a full page load) can copy the link and set a
      // new passcode.
      if (adsenseLoaded()) {
        browser.assign(`/shared/${encodeURIComponent(r.gallery.id)}`, { keepStorage: true });
        return;
      }
      onCreated(r);
      if (r.gallery.downloads === 'full') {
        // Full-size downloads of edited or RAW photos are prepared on this device, for this member only.
        void getRenderQueue(r.gallery.id)
          .then((pending) => shareRenders.add(r.gallery.id, r.gallery.name, pending, owner))
          .catch(() => undefined);
      }
    } catch (err) {
      setError(err instanceof ApiFailure && err.code === 'quota_exceeded' ? capMsg : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={
        <span className="edlg-title">
          <span className="sh-dlg-icon" aria-hidden="true">
            <Icon name="link" size={20} />
          </span>
          <span>
            Share {photosLabel(photoIds.length)}
            <span className="edlg-title__sub">
              Creates a private gallery link. Your originals stay where they are.
            </span>
          </span>
        </span>
      }
      footer={
        <>
          <span className="edlg-foot__note sh-grow sh-dlg-foot-note">
            {PLAN_NAME[plan]}
            {limits.galleries !== null
              ? ` · ${limits.liveGalleries} of ${limits.galleries} live galleries`
              : ` · ${limits.liveGalleries} live ${limits.liveGalleries === 1 ? 'gallery' : 'galleries'}`}
          </span>
          <Button kind="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            kind="primary"
            icon="link"
            type="submit"
            form={formId}
            busy={busy}
            disabled={atCap || suspended || !name.trim()}
          >
            Create link
          </Button>
        </>
      }
    >
      <form id={formId} className="stack sh-form" onSubmit={submit}>
        {suspended ? (
          <Note tone="bad" icon="alert">
            {SUSPENDED_MSG}
          </Note>
        ) : (
          atCap && (
            <Note tone="warn" icon="alert">
              {capMsg}
            </Note>
          )
        )}
        <Field
          label="Gallery name"
          value={name}
          maxLength={GALLERY_NAME_MAX}
          required
          onChange={(e) => setName(e.target.value)}
          size="md"
        />
        <div className="sh-field">
          <Switch
            checked={passcode}
            onChange={setPasscode}
            label="Require a 6-digit passcode"
            hint="Guests need the link and the passcode"
          />
          {!passcode && (
            <ShNote icon="alert" tone="warn">
              Without a passcode, anyone who gets the link can see these photos. Fine for a family album; keep
              it on for client work.
            </ShNote>
          )}
        </div>
        <div className="sh-two">
          <Field
            label="Link expires"
            type="date"
            value={expires}
            min={isoDay(0)}
            max={isoDay(maxDays)}
            required
            onChange={(e) => setExpires(e.target.value)}
            hint={
              limits.maxLinkDays === null
                ? `Up to 1 year on ${PLAN_NAME[plan]}`
                : `Up to ${maxDays} days on ${PLAN_NAME[plan]}`
            }
            size="md"
          />
          <Field
            label="Photos"
            value={`${photoIds.length.toLocaleString('en')} selected`}
            readOnly
            size="md"
          />
        </div>
        <DownloadChoice value={downloads} onChange={setDownloads} limits={limits} />
        <ExtrasSwitches
          value={extras}
          onChange={(v) => {
            setTouchedExtras(true);
            setExtras(v);
          }}
          limits={limits}
          branding={branding}
        />
        <label className="sh-field">
          <span className="sh-label">Message for guests (optional)</span>
          <textarea
            className="z-input sh-textarea"
            rows={2}
            maxLength={GALLERY_MESSAGE_MAX}
            value={message}
            placeholder="Tap the heart on the shots you love…"
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        {downloads === 'full' && (
          <ShNote>
            Full-size downloads of edited or RAW photos are prepared on this device after you create the link,
            and count toward storage while the gallery is live.
          </ShNote>
        )}
        {error && (
          <Note tone="bad" icon="alert" role="alert">
            {error}
          </Note>
        )}
      </form>
    </Dialog>
  );
}

/** "Preparing full-size downloads on this device · 5 of 8" for one gallery. */
export function GalleryRenderProgress({ galleryId }: { galleryId: string }) {
  const s = useSyncExternalStore(shareRenders.subscribe, shareRenders.getSnapshot, shareRenders.getSnapshot);
  const items = s.items.filter((i) => i.galleryId === galleryId);
  if (!items.length) return null;
  const done = items.filter((i) => i.state === 'completed').length;
  const failed = items.filter((i) => i.state === 'failed').length;
  const pct = Math.round((done / items.length) * 100);
  return (
    <div className="sh-prep">
      <div className="sh-prep__row">
        <span>Preparing full-size downloads on this device</span>
        <span className="mono">
          {done} of {items.length}
        </span>
      </div>
      <div
        className="eprog"
        role="progressbar"
        aria-label="Preparing full-size downloads"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="sh-hint">
        {s.storageFull
          ? 'Your storage is full, so the rest are waiting. Free up space, then retry from the tray.'
          : failed
            ? `${failed} couldn’t be prepared. Retry from the tray.`
            : 'The gallery is already live. Guests see “Preparing” on the download button until each photo is ready. Keep Zephyr open.'}
      </span>
    </div>
  );
}

/**
 * Shown after creating: the link (copyable again later from the gallery page) and the one-time passcode. Phase 8:
 * never rendered in a document holding Google's AdSense script.
 */
export function GalleryLiveDialog(props: Parameters<typeof GalleryLiveDialogInner>[0]) {
  return useSecretsAllowed() ? <GalleryLiveDialogInner {...props} /> : null;
}
function GalleryLiveDialogInner({
  created,
  onClose,
}: {
  created: GalleryCreated | null;
  onClose: () => void;
}) {
  useHoldAdsense(Boolean(created));
  const nav = useNavigate();
  const g = created?.gallery;
  const expires = g
    ? new Date(g.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';
  return (
    <Dialog
      open={Boolean(created)}
      onClose={onClose}
      title={
        <span className="edlg-title">
          <span className="sh-dlg-icon sh-dlg-icon--good" aria-hidden="true">
            <Icon name="check" size={20} />
          </span>
          <span>
            Your gallery is live
            {g && (
              <span className="edlg-title__sub">
                {g.name} · {photosLabel(g.photoCount)} · expires {expires}
              </span>
            )}
          </span>
        </span>
      }
      footer={
        g && (
          <>
            <Button icon="eye" onClick={() => window.open(galleryPreviewPath(g.id), '_blank', 'noopener')}>
              Open as a guest
            </Button>
            <span className="sh-grow" />
            <Button
              kind="ghost"
              onClick={() => {
                onClose();
                nav(`/shared/${encodeURIComponent(g.id)}`);
              }}
            >
              Manage gallery
            </Button>
            <Button kind="primary" onClick={onClose}>
              Done
            </Button>
          </>
        )
      }
    >
      {created && g && (
        <div className="stack sh-form">
          <Field
            label="Private link"
            value={created.url}
            readOnly
            mono
            size="md"
            onFocus={(e) => e.currentTarget.select()}
            trailing={<CopyButton text={created.url} what="Link" />}
          />
          {created.passcode ? (
            <PasscodeReveal code={created.passcode} />
          ) : (
            <ShNote icon="alert" tone="warn">
              No passcode: anyone with this link can see the gallery.
            </ShNote>
          )}
          <ShNote icon="lock">
            You can copy the link again from the gallery page. The passcode is shown only now.
          </ShNote>
          <GalleryRenderProgress galleryId={g.id} />
        </div>
      )}
    </Dialog>
  );
}

/**
 * The Share action for a selection or an album: create dialog, then the one-time live dialog. Phase 8: while
 * Google's AdSense script is in the page, Share hands the selection to /share/new instead (a full page load to a
 * page without ads), so the link and passcode are never shown in a document holding the script.
 */
export function useShareGallery(o: { onDone?: () => void } = {}) {
  const { onDone } = o;
  const owner = useSession().user?.id ?? null;
  const [req, setReq] = useState<{ ids: string[]; name: string } | null>(null);
  const [created, setCreated] = useState<GalleryCreated | null>(null);
  // A session change drops anything on screen (the passcode belongs to the member who created it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on member change only
  useEffect(() => {
    setReq(null);
    setCreated(null);
  }, [owner]);
  const dialogs = useMemo(
    () => (
      <>
        <CreateGalleryDialog
          open={Boolean(req)}
          photoIds={req?.ids ?? []}
          defaultName={req?.name ?? ''}
          onClose={() => {
            setReq(null);
            onDone?.();
          }}
          onCreated={(r) => {
            setReq(null);
            setCreated(r);
          }}
        />
        <GalleryLiveDialog
          created={created}
          onClose={() => {
            setCreated(null);
            onDone?.();
          }}
        />
      </>
    ),
    [req, created, onDone],
  );
  const open = (ids: string[], name = '') => {
    if (adsenseLoaded()) startShareHandoff(ids, name);
    else setReq({ ids, name });
  };
  return { open, dialogs };
}
