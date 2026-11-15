import {
  AD_LIMITS,
  AD_PLACEMENTS,
  ADMIN8_API,
  type AdCard,
  type AdCardStatus,
  type AdminAdCardBody,
  type AdminAdsResult,
  type AdPlacement,
} from '@zephyr/shared/client';
import {
  Button,
  Card,
  CardHead,
  Chip,
  type ChipTone,
  type Column,
  Dialog,
  Field,
  Note,
  Table,
  useToast,
} from '@zephyr/ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Effects, Kpi, PageState, ReasonDialog } from '../components/Kit8';
import { AdminShell } from '../components/Shell';
import { can, fromLocalInput, n, shortDate, toLocalInput, useAdminWrite, writeError } from '../lib/admin8';
import { api, apiRaw, errorMessage } from '../lib/api';
import { useAdminSession } from '../lib/session';

const PLACEMENT_LABEL: Record<AdPlacement, string> = {
  library: 'Library grid',
  sidebar: 'Sidebar',
  batch: 'Batch queue',
};
const STATUS: Record<AdCardStatus, [string, ChipTone]> = {
  draft: ['Draft', 'neutral'],
  scheduled: ['Scheduled', 'acc'],
  live: ['Live', 'good'],
  ended: ['Ended', 'outline'],
};
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PUB_RE = /^ca-pub-\d{16}$/;
const SLOT_RE = /^\d{10}$/;

/** Same rule as the API: https only, no credentials, a real host name (no IP literals or localhost). */
export function adUrlOk(u: string): boolean {
  if (u.trim().length === 0 || u.length > AD_LIMITS.url) return false;
  try {
    const x = new URL(u.trim());
    if (x.protocol !== 'https:' || x.username || x.password) return false;
    const h = x.hostname;
    return h.includes('.') && !/^[\d.]+$/.test(h) && !h.startsWith('[') && h !== 'localhost';
  } catch {
    return false;
  }
}

const compact = (x: number) =>
  x >= 1_000_000 ? `${(x / 1_000_000).toFixed(1)}M` : x >= 10_000 ? `${Math.round(x / 1000)}k` : n(x);
const ctr = (c: { impressions: number; clicks: number }) =>
  c.impressions ? `${((c.clicks / c.impressions) * 100).toFixed(c.impressions >= 10_000 ? 2 : 1)}%` : '—';

type Draft = AdminAdCardBody;
const EMPTY: Draft = {
  advertiser: '',
  headline: '',
  body: '',
  url: 'https://',
  placements: ['library'],
  startsAt: null,
  endsAt: null,
  weight: 50,
};

function cardError(d: Draft): string | null {
  if (!d.advertiser.trim() || !d.headline.trim() || !d.body.trim())
    return 'Fill in the advertiser, headline and text.';
  if (!adUrlOk(d.url)) return 'The link must be https, with a real host name and no user name or password.';
  if (d.placements.length === 0) return 'Pick at least one placement.';
  if (!Number.isInteger(d.weight) || d.weight < 1 || d.weight > 100) return 'Weight is 1 to 100.';
  const now = Date.now();
  if (d.startsAt && new Date(d.startsAt).getTime() <= now)
    return 'The start must be in the future (or empty for “when scheduled”).';
  if (d.endsAt && new Date(d.endsAt).getTime() <= now) return 'The end must be in the future.';
  if (d.startsAt && d.endsAt && d.startsAt >= d.endsAt) return 'The end must be after the start.';
  return null;
}

function CardDialog({
  card,
  knownIds,
  open,
  onClose,
  onSaved,
}: {
  card: AdCard | null;
  /** Card ids before saving, to find the one a POST created (the response is the whole list). */
  knownIds: string[];
  open: boolean;
  onClose: () => void;
  onSaved: (r: AdminAdsResult) => void;
}) {
  const write = useAdminWrite();
  const toast = useToast();
  const fileId = useId();
  const [d, setD] = useState<Draft>(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setD(
      card
        ? {
            advertiser: card.advertiser,
            headline: card.headline,
            body: card.body,
            url: card.url,
            placements: [...card.placements],
            startsAt: card.startsAt,
            endsAt: card.endsAt,
            weight: card.weight,
          }
        : EMPTY,
    );
    setFile(null);
    setFileErr(null);
    setErr(null);
  }, [open, card]);
  // Local preview only; revoked when the file changes or the dialog closes.
  useEffect(() => {
    if (!file || !open) {
      setPreview(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file, open]);

  const pick = (f: File | undefined) => {
    setFileErr(null);
    if (!f) return setFile(null);
    if (!IMAGE_TYPES.includes(f.type)) return setFileErr('Use a JPEG, PNG or WebP image.');
    if (f.size > AD_LIMITS.imageBytes) return setFileErr('The image must be 5 MB or less.');
    setFile(f);
  };
  const problem = cardError(d);
  const save = async (schedule: boolean) => {
    if (problem) return;
    setBusy(true);
    setErr(null);
    try {
      const body: Draft = {
        ...d,
        advertiser: d.advertiser.trim(),
        headline: d.headline.trim(),
        body: d.body.trim(),
        url: d.url.trim(),
      };
      let r: AdminAdsResult;
      let id = card?.id;
      if (card) {
        r = await write<AdminAdsResult>(ADMIN8_API.adCard(card.id), 'PATCH', body);
      } else {
        const before = new Set(knownIds);
        r = await write<AdminAdsResult>(ADMIN8_API.adCards, 'POST', body);
        id = r.cards.find((c) => !before.has(c.id))?.id;
      }
      if (file && id) {
        await apiRaw(ADMIN8_API.adCardImage(id), { method: 'PUT', body: file, contentType: file.type });
        r = await api<AdminAdsResult>(ADMIN8_API.ads);
      }
      if (schedule && id && (card?.status ?? 'draft') === 'draft') {
        r = await write<AdminAdsResult>(ADMIN8_API.adCard(id), 'PATCH', { status: 'scheduled' });
      }
      onSaved(r);
      toast.show(schedule ? 'Card scheduled' : 'Card saved', 'good');
      onClose();
    } catch (e) {
      setErr(writeError(e));
    } finally {
      setBusy(false);
    }
  };
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={card ? 'Edit sponsored card' : 'New sponsored card'}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={busy} disabled={Boolean(problem) || Boolean(fileErr)} onClick={() => save(false)}>
            {card ? 'Save' : 'Save draft'}
          </Button>
          {(!card || card.status === 'draft') && (
            <Button
              kind="primary"
              busy={busy}
              disabled={Boolean(problem) || Boolean(fileErr)}
              onClick={() => save(true)}
            >
              Schedule
            </Button>
          )}
        </>
      }
    >
      <div className="bl-dialog a8-adform">
        <p className="z-hint">Shown to Free members, labelled “Sponsored”.</p>
        <Field
          label="Advertiser"
          size="md"
          maxLength={AD_LIMITS.advertiser}
          value={d.advertiser}
          onChange={(e) => set({ advertiser: e.target.value })}
        />
        <Field
          label={`Headline (${AD_LIMITS.headline})`}
          size="md"
          maxLength={AD_LIMITS.headline}
          value={d.headline}
          onChange={(e) => set({ headline: e.target.value })}
        />
        <Field
          label={`Text (${AD_LIMITS.body})`}
          size="md"
          maxLength={AD_LIMITS.body}
          value={d.body}
          onChange={(e) => set({ body: e.target.value })}
        />
        <Field
          label="Link (https only)"
          size="md"
          type="url"
          mono
          maxLength={AD_LIMITS.url}
          value={d.url}
          onChange={(e) => set({ url: e.target.value })}
          error={
            d.url.length > 8 && !adUrlOk(d.url)
              ? 'https only, no user name or password, no IP addresses.'
              : null
          }
        />
        <div className="z-field">
          <label htmlFor={fileId}>Image (re-encoded to 1200 × 628 JPEG)</label>
          <input
            id={fileId}
            type="file"
            accept={IMAGE_TYPES.join(',')}
            className="z-input z-input--md"
            onChange={(e) => pick(e.target.files?.[0])}
          />
          {fileErr ? (
            <span className="z-hint z-hint--error" role="alert">
              {fileErr}
            </span>
          ) : (
            card?.imageVersion != null &&
            !file && <span className="z-hint">An image is uploaded. Pick a file to replace it.</span>
          )}
        </div>
        <figure className="a8-adpreview">
          <figcaption className="z-sr">Preview</figcaption>
          {preview ? <img src={preview} alt="" /> : <span className="a8-adpreview__ph" />}
          <span className="a8-adpreview__text">
            <span className="a8-adpreview__tag">Sponsored · {d.advertiser || 'Advertiser'}</span>
            <strong>{d.headline || 'Headline'}</strong>
            <span>{d.body || 'One line of text.'}</span>
          </span>
        </figure>
        <fieldset className="a8-checks">
          <legend>Placements</legend>
          {AD_PLACEMENTS.map((p) => (
            <label key={p}>
              <input
                type="checkbox"
                checked={d.placements.includes(p)}
                onChange={(e) =>
                  set({
                    placements: e.target.checked ? [...d.placements, p] : d.placements.filter((x) => x !== p),
                  })
                }
              />
              {PLACEMENT_LABEL[p]}
            </label>
          ))}
        </fieldset>
        <div className="a8-row2">
          <Field
            label="Starts"
            size="md"
            type="datetime-local"
            value={d.startsAt ? toLocalInput(d.startsAt) : ''}
            onChange={(e) => set({ startsAt: fromLocalInput(e.target.value) })}
          />
          <Field
            label="Ends"
            size="md"
            type="datetime-local"
            value={d.endsAt ? toLocalInput(d.endsAt) : ''}
            onChange={(e) => set({ endsAt: fromLocalInput(e.target.value) })}
          />
        </div>
        <Field
          label="Weight (1–100)"
          size="md"
          inputMode="numeric"
          hint="Relative share among live cards in a placement."
          value={String(d.weight)}
          onChange={(e) => set({ weight: Number(e.target.value.replace(/[^\d]/g, '') || '0') })}
        />
        {problem && d.advertiser && <p className="z-hint">{problem}</p>}
        {err && (
          <Note tone="bad" icon="alert" role="alert">
            {err}
          </Note>
        )}
        <p className="z-hint">Goes live on its start date · logged · Owner and Admin</p>
      </div>
    </Dialog>
  );
}

function AdsensePanel({ data, onSaved }: { data: AdminAdsResult; onSaved: (r: AdminAdsResult) => void }) {
  const { staff } = useAdminSession();
  const owner = can(staff?.role, 'adsense');
  const write = useAdminWrite();
  const a = data.adsense;
  const [pub, setPub] = useState(a.publisherId ?? '');
  const [slots, setSlots] = useState<Record<AdPlacement, string>>({
    library: a.slots.library ?? '',
    sidebar: a.slots.sidebar ?? '',
    batch: a.slots.batch ?? '',
  });
  const [accept, setAccept] = useState(false);
  const [dialog, setDialog] = useState<'save' | 'on' | 'off' | null>(null);
  // Follow the saved values only when they change: not on mount (that would wipe typing done before the effect ran)
  // and not when the parent re-fetches the same values.
  const aKey = JSON.stringify([a.publisherId ?? '', a.slots]);
  const shownKey = useRef(aKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the saved values, not the object identity.
  useEffect(() => {
    if (shownKey.current === aKey) return;
    shownKey.current = aKey;
    setPub(a.publisherId ?? '');
    setSlots({ library: a.slots.library ?? '', sidebar: a.slots.sidebar ?? '', batch: a.slots.batch ?? '' });
  }, [aKey]);
  const pubOk = pub === '' || PUB_RE.test(pub);
  const slotsOk = AD_PLACEMENTS.every((p) => slots[p] === '' || SLOT_RE.test(slots[p]));
  const dirty = (a.publisherId ?? '') !== pub || AD_PLACEMENTS.some((p) => (a.slots[p] ?? '') !== slots[p]);
  const configured = Boolean(a.publisherId) && AD_PLACEMENTS.some((p) => a.slots[p]);
  const patchConfig = () => ({
    publisherId: pub || null,
    slots: Object.fromEntries(AD_PLACEMENTS.map((p) => [p, slots[p] || null])),
  });
  return (
    <Card aria-labelledby="ads-gs">
      <CardHead title={<span id="ads-gs">Google AdSense</span>}>
        <Chip tone={a.enabled ? 'warn' : 'neutral'} dot={a.enabled}>
          {a.enabled ? 'On' : 'Off'}
        </Chip>
      </CardHead>
      <Note tone="warn" icon="alert">
        <strong>
          Accepted risk
          {a.enabledAt ? ` (${shortDate(a.enabledAt)}${a.enabledBy ? `, ${a.enabledBy}` : ''})` : ''}:
        </strong>{' '}
        AdSense doesn’t allow its ads in a frame, so Google’s script runs inside the app for Free members. It
        can see what they see, including their private photos and file names, and could act as them. Turning
        it on needs your passkey and emails every Owner.
      </Note>
      <div className="a8-adsense">
        <Field
          label="Publisher ID"
          size="md"
          mono
          placeholder="ca-pub-0000000000000000"
          value={pub}
          disabled={!owner}
          onChange={(e) => setPub(e.target.value.trim())}
          error={pubOk ? null : 'ca-pub- then 16 digits.'}
        />
        {AD_PLACEMENTS.map((p) => (
          <Field
            key={p}
            label={`${PLACEMENT_LABEL[p]} ad unit`}
            size="md"
            mono
            inputMode="numeric"
            placeholder="10 digits"
            value={slots[p]}
            disabled={!owner}
            onChange={(e) =>
              setSlots((s) => ({ ...s, [p]: e.target.value.replace(/[^\d]/g, '').slice(0, 10) }))
            }
            error={slots[p] === '' || SLOT_RE.test(slots[p]) ? null : '10 digits.'}
          />
        ))}
      </div>
      <Effects
        items={[
          [
            'lock',
            'Only for Free members, only on Library, the sidebar and the batch queue. Never on sign-in, the editor, sharing, billing, settings or guest galleries.',
          ],
          [
            'shield',
            'Loads only after Google’s consent message (a Google-certified CMP) where the law needs it: EEA, UK, Switzerland.',
          ],
          ['globe', 'ads.txt is served on the app host. The script is limited by CSP to Google’s ad hosts.'],
          [
            'refresh',
            'Upgrading, signing out or switching account reloads the page, so the script never carries over.',
          ],
        ]}
      />
      {owner ? (
        <div className="btn-row">
          <Button size="sm" disabled={!dirty || !pubOk || !slotsOk} onClick={() => setDialog('save')}>
            Save settings
          </Button>
          {a.enabled ? (
            <Button size="sm" kind="danger" onClick={() => setDialog('off')}>
              Turn AdSense off
            </Button>
          ) : (
            <>
              <label className="a8-accept">
                <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />I
                accept the risk above
              </label>
              <Button
                size="sm"
                kind="primary"
                icon="passkey"
                disabled={!accept || !configured || dirty}
                onClick={() => setDialog('on')}
              >
                Turn AdSense on
              </Button>
            </>
          )}
          {!a.enabled && !configured && (
            <span className="z-hint">Save a publisher ID and at least one ad unit first.</span>
          )}
        </div>
      ) : (
        <p className="z-hint">Only an Owner can change AdSense.</p>
      )}
      <ReasonDialog
        open={dialog === 'save'}
        title="Save AdSense settings"
        confirmLabel="Save"
        onClose={() => setDialog(null)}
        onConfirm={async (reason) =>
          onSaved(await write<AdminAdsResult>(ADMIN8_API.adsense, 'PATCH', { ...patchConfig(), reason }))
        }
      />
      <ReasonDialog
        open={dialog === 'on'}
        title="Turn AdSense on"
        intro="Google’s script will load inside the app for Free members, on the allowed pages, after the consent message where required."
        confirmLabel="Turn on with passkey"
        passkey
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          onSaved(await write<AdminAdsResult>(ADMIN8_API.adsense, 'PATCH', { enabled: true, reason }));
          setAccept(false);
        }}
      />
      <ReasonDialog
        open={dialog === 'off'}
        title="Turn AdSense off"
        intro="Saves at once. Free members see only sponsored cards from their next page load."
        confirmLabel="Turn off"
        danger
        onClose={() => setDialog(null)}
        onConfirm={async (reason) =>
          onSaved(await write<AdminAdsResult>(ADMIN8_API.adsense, 'PATCH', { enabled: false, reason }))
        }
      />
    </Card>
  );
}

export function Ads() {
  const { staff } = useAdminSession();
  const allowed = can(staff?.role, 'ads');
  const write = useAdminWrite();
  const toast = useToast();
  const [data, setData] = useState<AdminAdsResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdCard | null | 'new'>(null);
  const [ending, setEnding] = useState<AdCard | null>(null);
  const [deleting, setDeleting] = useState<AdCard | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<AdminAdsResult>(ADMIN8_API.ads));
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);
  const cols: Column<AdCard>[] = [
    {
      key: 'c',
      header: 'Card',
      cell: (c) => (
        <span className="a8-cell2">
          <strong>{c.headline}</strong>
          <span className="z-hint">{c.advertiser}</span>
        </span>
      ),
    },
    {
      key: 's',
      header: 'Status',
      cell: (c) => (
        <Chip tone={STATUS[c.status][1]} dot={c.status === 'live'}>
          {STATUS[c.status][0]}
          {c.status === 'scheduled' && c.startsAt ? ` · ${shortDate(c.startsAt)}` : ''}
        </Chip>
      ),
    },
    { key: 'p', header: 'Placements', cell: (c) => c.placements.map((p) => PLACEMENT_LABEL[p]).join(', ') },
    {
      key: 'i',
      header: 'Impressions (7 d)',
      cell: (c) => (
        <span className="z-mono">{c.stats7d.impressions ? compact(c.stats7d.impressions) : '—'}</span>
      ),
    },
    { key: 'r', header: 'CTR', cell: (c) => <span className="z-mono">{ctr(c.stats7d)}</span> },
    {
      key: 'a',
      header: <span className="z-sr">Actions</span>,
      cell: (c) => (
        <span className="btn-row btn-row--tight">
          {c.status !== 'ended' && (
            <Button size="sm" kind="ghost" onClick={() => setEditing(c)} aria-label={`Edit ${c.headline}`}>
              Edit
            </Button>
          )}
          {(c.status === 'live' || c.status === 'scheduled') && (
            <Button size="sm" kind="ghost" onClick={() => setEnding(c)} aria-label={`End ${c.headline}`}>
              End
            </Button>
          )}
          {c.status !== 'live' && (
            <Button
              size="sm"
              kind="ghost"
              icon="trash"
              onClick={() => setDeleting(c)}
              aria-label={`Delete ${c.headline}`}
            />
          )}
        </span>
      ),
    },
  ];
  return (
    <AdminShell title="Ads" sub="Free plan only. Sponsored cards first; AdSense fills the rest when it’s on.">
      <PageState
        allowed={allowed}
        who="Owners and Admins"
        err={err}
        loading={!data}
        onRetry={() => void load()}
      >
        {data && (
          <>
            <div className="ai-tiles">
              <Kpi label="Free members" value={n(data.kpis.freeMembers)} note="See ads" icon="people" />
              <Kpi
                label="Sponsored impressions (7 d)"
                value={compact(data.kpis.impressions7d)}
                note="Counted on our side"
                icon="eye"
              />
              <Kpi
                label="Sponsored clicks (7 d)"
                value={n(data.kpis.clicks7d)}
                note={`${ctr({ impressions: data.kpis.impressions7d, clicks: data.kpis.clicks7d })} CTR`}
                icon="chart"
              />
              <Kpi
                label="AdSense"
                value={data.adsense.enabled ? 'On' : 'Off'}
                note="Owner switch"
                icon="megaphone"
                tone={data.adsense.enabled ? 'warn' : 'muted'}
              />
            </div>
            <Card>
              <CardHead title="Sponsored cards">
                <Button size="sm" kind="primary" icon="plus" onClick={() => setEditing('new')}>
                  New card
                </Button>
              </CardHead>
              <Table
                columns={cols}
                rows={data.cards}
                rowKey={(c) => c.id}
                caption="Sponsored cards"
                minWidth={760}
                empty="No sponsored cards yet."
              />
              <p className="z-hint">
                Sponsored cards are served by Zephyr: images re-encoded, links https only, no trackers.
                Impressions and clicks are counted without storing who saw them.
              </p>
            </Card>
            <AdsensePanel data={data} onSaved={setData} />
            <CardDialog
              open={editing !== null}
              card={editing === 'new' ? null : editing}
              knownIds={data.cards.map((c) => c.id)}
              onClose={() => setEditing(null)}
              onSaved={setData}
            />
            <ReasonDialog
              open={ending !== null}
              title="End this card"
              intro={ending ? `“${ending.headline}” stops showing at once.` : undefined}
              confirmLabel="End card"
              danger
              withReason={false}
              onClose={() => setEnding(null)}
              onConfirm={async () => {
                if (!ending) return;
                setData(
                  await write<AdminAdsResult>(ADMIN8_API.adCard(ending.id), 'PATCH', { status: 'ended' }),
                );
                toast.show('Card ended', 'good');
              }}
            />
            <ReasonDialog
              open={deleting !== null}
              title="Delete this card"
              intro={
                deleting
                  ? `“${deleting.headline}” and its image are deleted. Its counts stay in the totals.`
                  : undefined
              }
              confirmLabel="Delete"
              danger
              withReason={false}
              onClose={() => setDeleting(null)}
              onConfirm={async () => {
                if (!deleting) return;
                setData(await write<AdminAdsResult>(ADMIN8_API.adCard(deleting.id), 'DELETE'));
              }}
            />
          </>
        )}
      </PageState>
    </AdminShell>
  );
}
