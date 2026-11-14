import {
  ADMIN8_API,
  type AdminLimitsPreviewResult,
  type AdminLimitsResult,
  LIMITS_NOTICE_DAYS,
  type LimitChange,
  type LimitsVersion,
  type PlanId,
  type PlanLimits,
  SYSTEM_MAX_BATCH,
} from '@zephyr/shared/client';
import {
  Button,
  Card,
  CardHead,
  Chip,
  type ChipTone,
  type Column,
  Field,
  Note,
  Table,
  useToast,
} from '@zephyr/ui';
import { useCallback, useEffect, useId, useState } from 'react';
import { Kpi, PageState, ReasonDialog, ReasonField } from '../components/Kit8';
import { AdminShell } from '../components/Shell';
import {
  can,
  dateTime,
  fromLocalInput,
  n,
  PLAN_LABEL,
  reasonOk,
  shortDate,
  toLocalInput,
  useAdminWrite,
  writeError,
} from '../lib/admin8';
import { api, errorMessage } from '../lib/api';
import { useAdminSession } from '../lib/session';

const PLANS: PlanId[] = ['free', 'pro', 'studio'];
const FILE_TYPES = ['jpeg', 'png', 'webp', 'heic', 'cr2', 'nef', 'arw', 'dng'] as const;
type NumKey = 'storageGb' | 'cloudCreditsPerMonth' | 'batchSize' | 'seats';
type NullKey = 'galleries' | 'maxLinkDays';
type BoolKey =
  | 'guestFullRes'
  | 'peopleGrouping'
  | 'qualityCleanup'
  | 'branding'
  | 'guestFavourites'
  | 'watermark'
  | 'accessLog'
  | 'ads'
  | 'priorityQueue';
const NUMS: [NumKey, string, number, number, string][] = [
  ['storageGb', 'Storage (GB)', 0, 100_000, 'Uploads stop at the limit; nothing is ever deleted'],
  ['cloudCreditsPerMonth', 'Cloud AI credits / month', 0, 1_000_000, ''],
  ['batchSize', 'Batch size', 1, SYSTEM_MAX_BATCH, `System ceiling ${n(SYSTEM_MAX_BATCH)}`],
  ['seats', 'Seats (owner included)', 1, 100, ''],
];
const NULLS: [NullKey, string, number, number, string][] = [
  ['galleries', 'Live galleries', 0, 100_000, 'Empty = unlimited'],
  ['maxLinkDays', 'Longest link (days)', 1, 3650, 'Empty = no cap'],
];
const BOOLS: [BoolKey, string][] = [
  ['guestFullRes', 'Full-size guest downloads'],
  ['peopleGrouping', 'People grouping'],
  ['qualityCleanup', 'Cleanup'],
  ['branding', 'Gallery branding'],
  ['guestFavourites', 'Guest favourites'],
  ['watermark', 'Watermarks'],
  ['accessLog', 'Gallery access log'],
  ['ads', 'Ads shown'],
  ['priorityQueue', 'Priority queue'],
];
const LABEL: Record<keyof PlanLimits, string> = {
  ...Object.fromEntries([...NUMS, ...NULLS].map(([k, l]) => [k, l])),
  ...Object.fromEntries(BOOLS),
  fileTypes: 'File types',
} as Record<keyof PlanLimits, string>;
const STATUS: Record<LimitsVersion['status'], [string, ChipTone]> = {
  draft: ['Draft', 'neutral'],
  scheduled: ['Scheduled', 'acc'],
  active: ['Active', 'good'],
  superseded: ['Superseded', 'outline'],
  cancelled: ['Cancelled', 'outline'],
};

const show = (v: unknown) =>
  v === null
    ? 'Unlimited'
    : typeof v === 'boolean'
      ? v
        ? 'On'
        : 'Off'
      : Array.isArray(v)
        ? v.join(', ')
        : typeof v === 'number'
          ? n(v)
          : String(v);

/** Validation of one plan's limits, matching the API's ceilings. */
export function limitsError(l: PlanLimits): string | null {
  for (const [k, label, min, max] of NUMS) {
    const v = l[k];
    if (!Number.isInteger(v) || v < min || v > max) return `${label}: between ${n(min)} and ${n(max)}.`;
  }
  for (const [k, label, min, max] of NULLS) {
    const v = l[k];
    if (v !== null && (!Number.isInteger(v) || v < min || v > max))
      return `${label}: between ${n(min)} and ${n(max)}, or empty.`;
  }
  if (l.fileTypes.length === 0) return 'Allow at least one file type.';
  return null;
}

function Editor({
  limits,
  base,
  onChange,
}: {
  limits: Record<PlanId, PlanLimits>;
  base: Record<PlanId, PlanLimits>;
  onChange: (l: Record<PlanId, PlanLimits>) => void;
}) {
  const set = (p: PlanId, patch: Partial<PlanLimits>) =>
    onChange({ ...limits, [p]: { ...limits[p], ...patch } });
  const was = (p: PlanId, k: keyof PlanLimits) =>
    JSON.stringify(base[p][k]) !== JSON.stringify(limits[p][k]) ? (
      <span className="a8-was">was {show(base[p][k])}</span>
    ) : null;
  return (
    <div className="z-table-wrap">
      <table className="z-table a8-limits" style={{ minWidth: 760 }}>
        <caption className="z-sr">Plan limits draft</caption>
        <thead>
          <tr>
            <th scope="col">Limit</th>
            {PLANS.map((p) => (
              <th key={p} scope="col">
                {PLAN_LABEL[p]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {NUMS.map(([k, label, min, max, hint]) => (
            <tr key={k}>
              <th scope="row">
                {label}
                {hint && <span className="z-hint a8-rowhint">{hint}</span>}
              </th>
              {PLANS.map((p) => (
                <td key={p}>
                  <input
                    className="z-input z-input--md z-input--mono a8-num"
                    inputMode="numeric"
                    aria-label={`${label}, ${PLAN_LABEL[p]}`}
                    value={String(limits[p][k])}
                    min={min}
                    max={max}
                    onChange={(e) => set(p, { [k]: Number(e.target.value.replace(/[^\d]/g, '') || '0') })}
                  />
                  {was(p, k)}
                </td>
              ))}
            </tr>
          ))}
          {NULLS.map(([k, label, , , hint]) => (
            <tr key={k}>
              <th scope="row">
                {label}
                <span className="z-hint a8-rowhint">{hint}</span>
              </th>
              {PLANS.map((p) => (
                <td key={p}>
                  <input
                    className="z-input z-input--md z-input--mono a8-num"
                    inputMode="numeric"
                    aria-label={`${label}, ${PLAN_LABEL[p]}`}
                    value={limits[p][k] === null ? '' : String(limits[p][k])}
                    placeholder="∞"
                    onChange={(e) => {
                      const d = e.target.value.replace(/[^\d]/g, '');
                      set(p, { [k]: d === '' ? null : Number(d) });
                    }}
                  />
                  {was(p, k)}
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <th scope="row">File types</th>
            {PLANS.map((p) => (
              <td key={p}>
                <fieldset className="a8-types">
                  <legend className="z-sr">File types on {PLAN_LABEL[p]}</legend>
                  {FILE_TYPES.map((t) => (
                    <label key={t} className="a8-type">
                      <input
                        type="checkbox"
                        checked={limits[p].fileTypes.includes(t)}
                        onChange={(e) =>
                          set(p, {
                            fileTypes: e.target.checked
                              ? [...limits[p].fileTypes, t]
                              : limits[p].fileTypes.filter((x) => x !== t),
                          })
                        }
                      />
                      {t.toUpperCase()}
                    </label>
                  ))}
                </fieldset>
                {was(p, 'fileTypes')}
              </td>
            ))}
          </tr>
          {BOOLS.map(([k, label]) => (
            <tr key={k}>
              <th scope="row">{label}</th>
              {PLANS.map((p) => (
                <td key={p}>
                  <input
                    type="checkbox"
                    role="switch"
                    className="z-switch"
                    aria-label={`${label}, ${PLAN_LABEL[p]}`}
                    aria-checked={limits[p][k]}
                    checked={limits[p][k]}
                    onChange={(e) => set(p, { [k]: e.target.checked })}
                  />
                  {was(p, k)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Schedule({
  preview,
  onScheduled,
}: {
  preview: AdminLimitsPreviewResult;
  onScheduled: (r: AdminLimitsResult) => void;
}) {
  const write = useAdminWrite();
  const toast = useToast();
  const name = useId();
  const [when, setWhen] = useState<'now' | 'date'>(preview.decreases ? 'date' : 'now');
  const [at, setAt] = useState(toLocalInput(preview.earliestEffectiveAt));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (preview.decreases) setWhen('date');
  }, [preview.decreases]);
  const iso = when === 'date' ? fromLocalInput(at) : null;
  const tooSoon =
    when === 'date' && (!iso || new Date(iso).getTime() < new Date(preview.earliestEffectiveAt).getTime());
  const ready = reasonOk(reason) && !tooSoon && preview.changes.some((c) => c.direction !== 'same');
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await write<AdminLimitsResult>(ADMIN8_API.limitsSchedule, 'POST', {
        effectiveAt: iso,
        reason: reason.trim(),
      });
      onScheduled(r);
      toast.show(iso ? `Scheduled for ${shortDate(iso)}` : 'New limits apply now', 'good');
    } catch (e) {
      setErr(writeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card aria-labelledby="lm-sched">
      <CardHead title={<span id="lm-sched">Schedule</span>} />
      <fieldset className="a8-radios">
        <legend>When it applies to everyone</legend>
        <label className={`a8-radio${preview.decreases ? ' is-off' : ''}${when === 'now' ? ' is-on' : ''}`}>
          <input
            type="radio"
            name={name}
            checked={when === 'now'}
            disabled={preview.decreases}
            onChange={() => setWhen('now')}
          />
          <span className="a8-radio__text">
            <strong>Now</strong>
            <span className="z-hint">
              {preview.decreases
                ? 'Only when every change is an increase. This draft lowers a limit.'
                : 'Every change is an increase.'}
            </span>
          </span>
        </label>
        <label className={`a8-radio${when === 'date' ? ' is-on' : ''}`}>
          <input type="radio" name={name} checked={when === 'date'} onChange={() => setWhen('date')} />
          <span className="a8-radio__text">
            <strong>On a date</strong>
            <span className="z-hint">
              {preview.decreases
                ? `At least ${LIMITS_NOTICE_DAYS} days after the emails go out: ${dateTime(preview.earliestEffectiveAt)} or later.`
                : 'Any time from now.'}
            </span>
          </span>
        </label>
      </fieldset>
      {when === 'date' && (
        <Field
          label="Applies from"
          size="md"
          type="datetime-local"
          min={toLocalInput(preview.earliestEffectiveAt)}
          value={at}
          onChange={(e) => setAt(e.target.value)}
          error={tooSoon ? `Pick ${dateTime(preview.earliestEffectiveAt)} or later.` : null}
        />
      )}
      <div className="a8-kv">
        <div>
          <span>Members emailed</span>
          <strong>{n(preview.membersEmailed)}</strong>
        </div>
        <div>
          <span>Over a new limit</span>
          <strong>{preview.membersOver ? n(preview.membersOver) : 'None'}</strong>
        </div>
      </div>
      <ReasonField value={reason} onChange={setReason} label="Reason (audit log and emails to Owners)" />
      {err && (
        <Note tone="bad" icon="alert" role="alert">
          {err}
        </Note>
      )}
      <Button kind="primary" icon="passkey" full busy={busy} disabled={!ready} onClick={go}>
        Schedule with passkey
      </Button>
    </Card>
  );
}

export function Limits() {
  const { staff } = useAdminSession();
  const allowed = can(staff?.role, 'limitsView');
  const editable = can(staff?.role, 'limits');
  const write = useAdminWrite();
  const toast = useToast();
  const [data, setData] = useState<AdminLimitsResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<Record<PlanId, PlanLimits> | null>(null);
  const [preview, setPreview] = useState<AdminLimitsPreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const accept = useCallback((r: AdminLimitsResult) => {
    setData(r);
    setEdit(r.draft ? structuredClone(r.draft.limits) : null);
    setPreview(null);
  }, []);
  const load = useCallback(async () => {
    try {
      accept(await api<AdminLimitsResult>(ADMIN8_API.limits));
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, [accept]);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  const dirty = Boolean(data?.draft && edit && JSON.stringify(edit) !== JSON.stringify(data.draft.limits));
  const invalid = edit ? (PLANS.map((p) => limitsError(edit[p])).find(Boolean) ?? null) : null;
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setActErr(null);
    try {
      await fn();
    } catch (e) {
      setActErr(writeError(e));
    } finally {
      setBusy(false);
    }
  };
  const startDraft = () =>
    act(async () => {
      if (!data) return;
      accept(
        await write<AdminLimitsResult>(ADMIN8_API.limitsDraft, 'POST', { fromVersion: data.active.version }),
      );
    });
  const saveDraft = () =>
    act(async () => {
      if (!edit) return;
      accept(await write<AdminLimitsResult>(ADMIN8_API.limitsDraft, 'PUT', { limits: edit }));
      toast.show('Draft saved', 'good');
    });
  const deleteDraft = () =>
    act(async () => {
      accept(await write<AdminLimitsResult>(ADMIN8_API.limitsDraft, 'DELETE'));
    });
  const runPreview = () =>
    act(async () => {
      setPreview(
        await api<AdminLimitsPreviewResult>(ADMIN8_API.limitsPreview, {
          method: 'POST',
          body: { effectiveAt: null },
        }),
      );
    });

  const historyCols: Column<Omit<LimitsVersion, 'limits'>>[] = [
    { key: 'v', header: 'Version', cell: (v) => <span className="z-mono">v{v.version}</span> },
    {
      key: 's',
      header: 'Status',
      cell: (v) => (
        <Chip tone={STATUS[v.status][1]} dot={v.status === 'active'}>
          {STATUS[v.status][0]}
        </Chip>
      ),
    },
    {
      key: 'a',
      header: 'Applies',
      cell: (v) => <span className="z-hint">{v.effectiveAt ? shortDate(v.effectiveAt) : '—'}</span>,
    },
    { key: 'r', header: 'Reason', cell: (v) => v.reason },
    { key: 'b', header: 'By', cell: (v) => <span className="z-hint">{v.createdBy ?? 'Seeded'}</span> },
  ];
  const changes = (preview?.changes ?? []).filter((c: LimitChange) => c.direction !== 'same');

  return (
    <AdminShell
      title="Plan limits"
      sub={`One version applies to everyone. Increases can apply now; decreases need ${LIMITS_NOTICE_DAYS} days’ notice by email.`}
    >
      <PageState
        allowed={allowed}
        who="Owners, Admins and Finance"
        err={err}
        loading={!data}
        onRetry={() => void load()}
      >
        {data && (
          <>
            <div className="ai-tiles">
              <Kpi
                label="Active"
                value={`v${data.active.version}`}
                note={
                  data.active.effectiveAt ? `Since ${shortDate(data.active.effectiveAt)}` : 'Launch limits'
                }
                tone="good"
                icon="check"
              />
              <Kpi
                label="Scheduled"
                value={data.scheduled ? `v${data.scheduled.version}` : 'None'}
                note={
                  data.scheduled?.effectiveAt
                    ? `Applies ${dateTime(data.scheduled.effectiveAt)}`
                    : 'Nothing waiting'
                }
                tone={data.scheduled ? 'warn' : 'muted'}
                icon="calendar"
              />
            </div>
            {data.scheduled && (
              <Note tone="acc" icon="calendar">
                v{data.scheduled.version} applies to everyone on{' '}
                {data.scheduled.effectiveAt ? dateTime(data.scheduled.effectiveAt) : 'its date'}: “
                {data.scheduled.reason}”.{' '}
                {editable && (
                  <button type="button" className="linkish" onClick={() => setCancelling(true)}>
                    Cancel it
                  </button>
                )}
              </Note>
            )}
            {actErr && (
              <Note tone="bad" icon="alert" role="alert">
                {actErr}
              </Note>
            )}
            {!data.draft || !edit ? (
              <Card>
                <CardHead title={`Active limits · v${data.active.version}`}>
                  {editable && (
                    <Button
                      size="sm"
                      kind="primary"
                      icon="sliders"
                      busy={busy}
                      disabled={Boolean(data.scheduled)}
                      onClick={startDraft}
                    >
                      Start a draft
                    </Button>
                  )}
                </CardHead>
                {data.scheduled && editable && (
                  <p className="z-hint">Cancel the scheduled version before starting another.</p>
                )}
                <Editor limits={data.active.limits} base={data.active.limits} onChange={() => undefined} />
              </Card>
            ) : (
              <div className="a8-split">
                <Card className="a8-split__main">
                  <CardHead title={`Draft · version ${data.draft.version}`}>
                    {editable && (
                      <span className="btn-row btn-row--tight">
                        <Button size="sm" kind="ghost" busy={busy} onClick={deleteDraft}>
                          Delete draft
                        </Button>
                        <Button
                          size="sm"
                          kind="primary"
                          busy={busy}
                          disabled={!dirty || Boolean(invalid)}
                          onClick={saveDraft}
                        >
                          Save draft
                        </Button>
                      </span>
                    )}
                  </CardHead>
                  <Editor
                    limits={edit}
                    base={data.active.limits}
                    onChange={editable ? setEdit : () => undefined}
                  />
                  {invalid && (
                    <Note tone="bad" icon="alert" role="alert">
                      {invalid}
                    </Note>
                  )}
                  <Note tone="acc" icon="info">
                    The server enforces these on every request. System ceilings (batch size ≤{' '}
                    {n(SYSTEM_MAX_BATCH)}, file types on the allow-list) can’t be exceeded here.
                  </Note>
                  {editable && (
                    <div className="btn-row">
                      <Button
                        icon="refresh"
                        busy={busy}
                        disabled={dirty || Boolean(invalid)}
                        onClick={runPreview}
                      >
                        Review changes
                      </Button>
                      {dirty && <span className="z-hint">Save the draft to review it.</span>}
                    </div>
                  )}
                  {preview && (
                    <div className="bl-impact" aria-live="polite">
                      {changes.length === 0 ? (
                        <div className="bl-impact__row">
                          <span>No changes from the active version.</span>
                        </div>
                      ) : (
                        changes.map((c) => (
                          <div key={`${c.plan}.${c.field}`} className="bl-impact__row">
                            <span>
                              {PLAN_LABEL[c.plan]} · {LABEL[c.field]}
                            </span>
                            <span className={`z-mono a8-${c.direction}`}>
                              {show(c.from)} → {show(c.to)}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </Card>
                {preview && editable && (
                  <div className="a8-split__side">
                    <Schedule preview={preview} onScheduled={accept} />
                  </div>
                )}
              </div>
            )}
            <Card>
              <CardHead title="Versions" />
              <Table
                columns={historyCols}
                rows={data.history}
                rowKey={(v) => String(v.version)}
                caption="Plan limit versions"
                minWidth={700}
              />
            </Card>
            <ReasonDialog
              open={cancelling}
              title="Cancel the scheduled limits"
              intro="The active limits stay. Members who were emailed about a decrease get a short follow-up."
              confirmLabel="Cancel scheduled version"
              onClose={() => setCancelling(false)}
              onConfirm={async (reason) =>
                accept(await write<AdminLimitsResult>(ADMIN8_API.limitsScheduled, 'DELETE', { reason }))
              }
            />
          </>
        )}
      </PageState>
    </AdminShell>
  );
}
