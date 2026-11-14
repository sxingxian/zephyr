import {
  ADMIN8_API,
  type AdminHold,
  type AdminReportDetail,
  type AdminReportResult,
  type AdminReportRow,
  type AdminRevealResult,
  type AdminSafetyResult,
  RESOLVE_ACTIONS,
  type ReportReason,
  type ResolveAction,
} from '@zephyr/shared/client';
import {
  Button,
  Card,
  CardHead,
  Chip,
  type ChipTone,
  Field,
  Icon,
  Note,
  SelectField,
  Spinner,
  useToast,
} from '@zephyr/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Effects, Kpi, PageState, ReasonDialog } from '../components/Kit8';
import { AdminShell } from '../components/Shell';
import { can, n, shortDate, timeOnly, useAdminWrite } from '../lib/admin8';
import { ago } from '../lib/ai';
import { api, apiRaw, errorMessage } from '../lib/api';
import { useAdminSession } from '../lib/session';

const REASON: Record<ReportReason, [string, ChipTone]> = {
  csam: ['Child safety', 'bad'],
  violence: ['Violence', 'bad'],
  copyright: ['Copyright', 'warn'],
  privacy: ['Privacy', 'bad'],
  other: ['Other', 'neutral'],
};
const ACTION_LABEL: Record<ResolveAction, string> = {
  remove_photos: 'Remove the reported photos from the gallery',
  end_gallery: 'End the gallery',
  suspend_sharing: 'Suspend the owner’s sharing',
  suspend_account: 'Suspend the owner’s account',
  hold_photos: 'Put the photos on hold (never shown, never purged)',
};

/** A photo revealed under a grant: an object URL that is revoked when the grant ends. */
interface Revealed {
  id: string;
  src: string | null;
  shown: boolean;
  failed: boolean;
}

/**
 * Fetches each photo with the grant token (never cached), shows it blurred until clicked, and drops every image
 * and object URL when the grant expires or the reviewer leaves.
 */
function useReveal() {
  const [grant, setGrant] = useState<{ expiresAt: string; photos: Revealed[] } | null>(null);
  const urls = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    for (const u of urls.current) URL.revokeObjectURL(u);
    urls.current = [];
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setGrant(null);
  }, []);
  useEffect(() => clear, [clear]);
  const start = useCallback(
    async (r: AdminRevealResult) => {
      clear();
      const ms = new Date(r.expiresAt).getTime() - Date.now();
      if (ms <= 0) return;
      setGrant({
        expiresAt: r.expiresAt,
        photos: r.photos.map((p) => ({ id: p.id, src: null, shown: false, failed: false })),
      });
      timer.current = setTimeout(clear, ms);
      await Promise.all(
        r.photos.map(async (p) => {
          try {
            const u = new URL(p.url, window.location.origin);
            u.searchParams.set('t', r.token);
            const res = await apiRaw(`${u.pathname}${u.search}`);
            const src = URL.createObjectURL(await res.blob());
            if (!timer.current) {
              URL.revokeObjectURL(src);
              return;
            }
            urls.current.push(src);
            setGrant((g) => g && { ...g, photos: g.photos.map((x) => (x.id === p.id ? { ...x, src } : x)) });
          } catch {
            setGrant(
              (g) => g && { ...g, photos: g.photos.map((x) => (x.id === p.id ? { ...x, failed: true } : x)) },
            );
          }
        }),
      );
    },
    [clear],
  );
  const show = (id: string) =>
    setGrant((g) => g && { ...g, photos: g.photos.map((x) => (x.id === id ? { ...x, shown: true } : x)) });
  return { grant, start, show, clear };
}

function ReportDetail({
  report,
  onResolved,
}: {
  report: AdminReportDetail;
  onResolved: (r: AdminSafetyResult) => void;
}) {
  const { staff } = useAdminSession();
  const write = useAdminWrite();
  const toast = useToast();
  const { grant, start, show, clear } = useReveal();
  const [dlg, setDlg] = useState<'reveal' | 'resolve' | null>(null);
  const [actions, setActions] = useState<ResolveAction[]>([]);
  const act = can(staff?.role, 'safetyAct');
  const revealable = report.photoIds.filter((p) => !report.heldPhotoIds.includes(p));
  // A different report: anything revealed for the previous one goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on report change only
  useEffect(() => {
    clear();
    setActions([]);
  }, [report.id]);
  const name = staff?.displayName || staff?.email || '';
  return (
    <Card aria-labelledby="sf-detail">
      <CardHead
        title={
          <span id="sf-detail">{report.galleryName ? `“${report.galleryName}”` : 'Reported photo'}</span>
        }
      >
        <Chip tone={report.resolvedAt ? 'good' : 'warn'} dot>
          {report.resolvedAt ? 'Resolved' : 'Open'}
        </Chip>
      </CardHead>
      <div className="a8-kv">
        <div>
          <span>Owner</span>
          <strong className="z-mono">{report.ownerId ? report.ownerId.slice(0, 8) : '—'}</strong>
        </div>
        <div>
          <span>Gallery</span>
          <strong>{report.galleryState ?? '—'}</strong>
        </div>
        <div>
          <span>Reason</span>
          <strong>{REASON[report.reason][0]}</strong>
        </div>
        <div>
          <span>Reports</span>
          <strong>{n(report.count)} from different networks</strong>
        </div>
      </div>
      {report.details.length > 0 && (
        <ul className="a8-quotes">
          {report.details.map((d, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: reporters' notes have no ids
            <li key={i}>“{d}”</li>
          ))}
        </ul>
      )}
      {report.heldPhotoIds.length > 0 && (
        <Note tone="warn" icon="lock">
          {n(report.heldPhotoIds.length)} photo{report.heldPhotoIds.length === 1 ? ' is' : 's are'} on hold
          and can never be revealed.
        </Note>
      )}
      {grant ? (
        <div className="a8-reveal" aria-live="polite">
          <Note tone="warn" icon="eye">
            Revealed to you until {timeOnly(grant.expiresAt)}, with your name over it. Nothing is saved on
            this device.
          </Note>
          <div className="a8-reveal__grid">
            {grant.photos.map((p) => (
              <figure key={p.id} className="a8-reveal__item">
                {p.failed ? (
                  <span className="z-hint">Couldn’t load</span>
                ) : !p.src ? (
                  <Spinner size={18} label="Loading photo" />
                ) : (
                  <button
                    type="button"
                    className={`a8-reveal__btn${p.shown ? ' is-shown' : ''}`}
                    onClick={() => show(p.id)}
                    aria-label={p.shown ? 'Revealed photo' : 'Click to show this photo'}
                  >
                    <img src={p.src} alt="" draggable={false} />
                    <span className="a8-reveal__mark" aria-hidden="true">
                      {name} · until {timeOnly(grant.expiresAt)}
                    </span>
                    {!p.shown && (
                      <span className="a8-reveal__hide">
                        <Icon name="eyeOff" size={20} />
                        Click to show
                      </span>
                    )}
                  </button>
                )}
              </figure>
            ))}
          </div>
          <Button size="sm" kind="ghost" icon="eyeOff" onClick={clear}>
            Hide now
          </Button>
        </div>
      ) : (
        act &&
        revealable.length > 0 &&
        !report.resolvedAt && (
          <div className="btn-row">
            <Button size="sm" icon="eye" onClick={() => setDlg('reveal')}>
              Reveal for review…
            </Button>
            <span className="z-hint">Safety role · reason and passkey · 10 minutes, to you only</span>
          </div>
        )
      )}
      {report.resolution ? (
        <Note tone="good" icon="check">
          Resolved by {report.resolution.by}
          {report.resolution.actions.length
            ? `: ${report.resolution.actions.map((a) => ACTION_LABEL[a]).join('; ')}`
            : ': no action'}
          . “{report.resolution.note}”
        </Note>
      ) : act ? (
        <div className="btn-row">
          <Button size="sm" kind="primary" icon="check" onClick={() => setDlg('resolve')}>
            Resolve…
          </Button>
        </div>
      ) : (
        <span className="z-hint">Only the Safety role resolves reports.</span>
      )}

      <ReasonDialog
        open={dlg === 'reveal'}
        title={`Reveal ${n(revealable.length)} photo${revealable.length === 1 ? '' : 's'} for review`}
        confirmLabel="Reveal with passkey"
        passkey
        reasonLabel="Why you need to see them (audit log)"
        onClose={() => setDlg(null)}
        onConfirm={async (reason) => {
          const r = await write<AdminRevealResult>(ADMIN8_API.reportReveal(report.id), 'POST', { reason });
          void start(r);
        }}
      >
        <Effects
          items={[
            ['clock', 'Shown for 10 minutes, to you only, then hidden again.'],
            ['watermark', 'Shown with your name and the time over it; never cached, no download.'],
            ['file', 'The reveal, your reason and the photo ids go to the audit log.'],
            ['ban', 'Not possible for photos on a hash-match hold.', 'bad'],
          ]}
        />
      </ReasonDialog>
      <ReasonDialog
        open={dlg === 'resolve'}
        title="Resolve this report"
        confirmLabel={actions.length ? 'Resolve' : 'Dismiss · no action'}
        danger={actions.includes('suspend_account')}
        reasonLabel="Resolution note (required, audit log)"
        onClose={() => setDlg(null)}
        onConfirm={async (note) => {
          const r = await write<AdminSafetyResult>(ADMIN8_API.reportResolve(report.id), 'POST', {
            actions,
            note,
          });
          clear();
          onResolved(r);
          toast.show('Report resolved', 'good');
        }}
      >
        <fieldset className="a8-checks">
          <legend>What to do (leave all unticked to dismiss)</legend>
          {RESOLVE_ACTIONS.map((a) => (
            <label key={a} className="a8-check">
              <input
                type="checkbox"
                checked={actions.includes(a)}
                onChange={(e) =>
                  setActions(e.target.checked ? [...actions, a] : actions.filter((x) => x !== a))
                }
              />
              {ACTION_LABEL[a]}
            </label>
          ))}
        </fieldset>
      </ReasonDialog>
    </Card>
  );
}

function Holds({ holds, onData }: { holds: AdminHold[]; onData: (r: AdminSafetyResult) => void }) {
  const { staff } = useAdminSession();
  const write = useAdminWrite();
  const toast = useToast();
  const [reporting, setReporting] = useState<AdminHold | null>(null);
  const [releasing, setReleasing] = useState<AdminHold | null>(null);
  const [authority, setAuthority] = useState('');
  const [reference, setReference] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear the fields whenever another hold is picked
  useEffect(() => {
    setAuthority('');
    setReference('');
  }, [reporting]);
  if (holds.length === 0) return null;
  return (
    <Card aria-labelledby="sf-holds">
      <CardHead title={<span id="sf-holds">Photos on hold</span>}>
        <Chip tone="bad" dot>
          {n(holds.length)}
        </Chip>
      </CardHead>
      <ul className="a8-holds">
        {holds.map((h) => (
          <li key={h.id} className="a8-hold">
            <span className="a8-hold__swatch" aria-hidden="true" />
            <span className="a8-hold__text">
              <strong>
                {h.source === 'csam_scan' ? 'A photo matched the known-content list' : 'Held by staff'}
              </strong>
              <span className="z-hint">
                Never served to anyone, never shared, trashed or purged · owner{' '}
                <span className="z-mono">{h.ownerId.slice(0, 8)}</span> · {ago(h.heldAt)}
              </span>
              {h.reportedAt && (
                <span className="z-hint">
                  Reported {shortDate(h.reportedAt)} · reference{' '}
                  <span className="z-mono">{h.reportReference}</span>
                </span>
              )}
            </span>
            <span className="btn-row btn-row--tight">
              {can(staff?.role, 'holdsRecord') && !h.reportedAt && (
                <Button size="sm" kind="primary" icon="file" onClick={() => setReporting(h)}>
                  Record the report you made…
                </Button>
              )}
              {can(staff?.role, 'holdsRelease') && (
                <Button size="sm" kind="ghost" onClick={() => setReleasing(h)}>
                  Release…
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <Note tone="warn" icon="alert">
        Held photos can never be revealed or downloaded in Zephyr, by anyone. Follow the reporting process
        your counsel approved and record the reference here.
      </Note>
      <ReasonDialog
        open={reporting !== null}
        title="Record the report you made"
        confirmLabel="Save"
        withReason={false}
        canConfirm={authority.trim().length >= 2 && reference.trim().length >= 2}
        onClose={() => setReporting(null)}
        onConfirm={async () => {
          if (!reporting) return;
          onData(
            await write<AdminSafetyResult>(ADMIN8_API.holdReport(reporting.id), 'POST', {
              authority: authority.trim(),
              reference: reference.trim(),
            }),
          );
          toast.show('Report recorded', 'good');
        }}
      >
        <Field
          label="Reported to"
          size="md"
          value={authority}
          placeholder="e.g. NCMEC CyberTipline"
          onChange={(e) => setAuthority(e.target.value)}
        />
        <Field
          label="Their reference number"
          size="md"
          mono
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </ReasonDialog>
      <ReasonDialog
        open={releasing !== null}
        title="Release this hold"
        intro="Only for a confirmed false match. The photo becomes visible to its owner again."
        confirmLabel="Release with passkey"
        danger
        passkey
        onClose={() => setReleasing(null)}
        onConfirm={async (reason) => {
          if (!releasing) return;
          onData(await write<AdminSafetyResult>(ADMIN8_API.holdRelease(releasing.id), 'POST', { reason }));
          toast.show('Hold released', 'good');
        }}
      />
    </Card>
  );
}

export function Safety() {
  const { staff } = useAdminSession();
  const allowed = can(staff?.role, 'safetyView');
  const [state, setState] = useState<'open' | 'resolved'>('open');
  const [data, setData] = useState<AdminSafetyResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<AdminReportDetail | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<AdminSafetyResult>(`${ADMIN8_API.safety}?state=${state}`));
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, [state]);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);
  const open = async (r: AdminReportRow) => {
    try {
      setReport((await api<AdminReportResult>(ADMIN8_API.report(r.id))).report);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  const k = data?.kpis;
  return (
    <AdminShell
      title="Safety & reports"
      sub="Reports from guests and automated matches. Photos stay hidden until a Safety admin reveals them; every reveal is logged."
      actions={
        <Chip tone="outline" icon="shield">
          Safety role required to reveal
        </Chip>
      }
    >
      <PageState
        allowed={allowed}
        who="Owners, Admins and Safety"
        err={err}
        loading={!data}
        onRetry={() => void load()}
      >
        {k && (
          <div className="ai-tiles">
            <Kpi
              label="Open reports"
              value={n(k.open)}
              note={`${n(k.olderThan24h)} older than 24 h`}
              tone={k.olderThan24h ? 'warn' : 'muted'}
              icon="flag"
            />
            <Kpi
              label="Photos on hold"
              value={n(k.holds)}
              note="Never shown, never purged"
              tone={k.holds ? 'bad' : 'muted'}
              icon="lock"
            />
            <Kpi label="Sharing suspended" value={n(k.sharingSuspended)} note="Accounts" icon="link" />
            <Kpi
              label="Median time to action"
              value={k.medianHoursToAction === null ? '—' : `${k.medianHoursToAction.toFixed(1)} h`}
              note="Target under 12 h"
              tone={k.medianHoursToAction !== null && k.medianHoursToAction > 12 ? 'warn' : 'good'}
              icon="clock"
            />
          </div>
        )}
        {data && <Holds holds={data.holds} onData={setData} />}
        <div className="a8-split">
          <Card className="a8-split__side" aria-labelledby="sf-list">
            <CardHead title={<span id="sf-list">Reports</span>}>
              <SelectField
                label="Show"
                value={state}
                onChange={(e) => {
                  setState(e.target.value as 'open' | 'resolved');
                  setReport(null);
                }}
                options={[
                  { value: 'open', label: 'Open' },
                  { value: 'resolved', label: 'Resolved' },
                ]}
              />
            </CardHead>
            {data && data.reports.length === 0 && <p className="z-hint">Nothing here.</p>}
            <ul className="a8-reports">
              {data?.reports.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className={`a8-report${report?.id === r.id ? ' is-on' : ''}`}
                    aria-current={report?.id === r.id ? 'true' : undefined}
                    onClick={() => void open(r)}
                  >
                    <span className="a8-report__thumb" aria-hidden="true">
                      <Icon name="eyeOff" size={18} />
                    </span>
                    <span className="a8-report__text">
                      <strong>
                        {r.galleryName ? `“${r.galleryName}”` : 'Photo'} · {n(r.photoIds.length)} photo
                        {r.photoIds.length === 1 ? '' : 's'}
                      </strong>
                      <span className="btn-row btn-row--tight">
                        <Chip tone={REASON[r.reason][1]} size="sm">
                          {REASON[r.reason][0]}
                        </Chip>
                        <Chip tone="outline" size="sm" icon="clock">
                          {ago(r.createdAt)}
                        </Chip>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <div className="a8-split__main">
            {report ? (
              <ReportDetail
                report={report}
                onResolved={(r) => {
                  setData(r);
                  setReport(null);
                }}
              />
            ) : (
              <p className="z-hint">Choose a report to review it.</p>
            )}
          </div>
        </div>
      </PageState>
    </AdminShell>
  );
}
