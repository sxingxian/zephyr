import {
  ADMIN_BILLING_API,
  type AdminBillingResult,
  type AdminPriceChange,
  type AdminPricePreviewResult,
  type AdminPriceRow,
  type AdminWebhookEvent,
  PRICE_NOTICE_DAYS,
  PRICE_REASON_MAX,
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
  Icon,
  type IconName,
  LinkButton,
  Note,
  Spinner,
  Table,
  useToast,
} from '@zephyr/ui';
import { useCallback, useEffect, useId, useState } from 'react';
import { ReadOnlyChip } from '../components/AiBits';
import { AdminShell } from '../components/Shell';
import { ago } from '../lib/ai';
import { ApiFailure, api, errorMessage } from '../lib/api';
import {
  billedLabel,
  canEditBilling,
  canSeeBilling,
  centsToInput,
  dollarsToCents,
  formatCents,
  isOpenChange,
  needsAttention,
  priceError,
  priceKind,
  priceName,
  shortDate,
} from '../lib/billing';
import { isCancelled } from '../lib/passkey';
import { reauthenticate, withReauth } from '../lib/reauth';
import { useAdminSession } from '../lib/session';

const STRIPE_DASHBOARD = 'https://dashboard.stripe.com/';
/** How long the preview waits after the last keystroke. */
export const PREVIEW_DEBOUNCE_MS = 350;

/** Message for a failed change on this page. */
export function billingSaveError(e: unknown): string {
  if (isCancelled(e)) return 'Not saved. Raising a price or turning a pack on needs your passkey.';
  if (e instanceof ApiFailure) {
    if (e.code === 'reauth_required') return 'Not saved. Sign in again with your passkey, then save.';
    if (e.code === 'forbidden') return 'Your role can’t change prices.';
    if (e.code === 'invalid') return 'That amount or reason wasn’t accepted. Check it and try again.';
    if (e.code === 'conflict') return 'Someone else changed this price. Reload to see the latest.';
    if (e.code === 'billing_unavailable')
      return 'Stripe didn’t answer, so nothing changed. Try again in a minute.';
  }
  return errorMessage(e);
}

/** Writes to Admin › Plans & billing; on 403 reauth_required asks for the passkey and tries once more. */
function useBillingWrite() {
  const { setSession } = useAdminSession();
  return useCallback(
    (path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) =>
      withReauth(
        () => api<AdminBillingResult>(path, { method, body: body ?? {} }),
        async () => setSession(await reauthenticate()),
      ),
    [setSession],
  );
}

function Kpi({
  label,
  value,
  note,
  tone,
  icon,
}: {
  label: string;
  value: string;
  note: string;
  tone: 'muted' | 'good' | 'warn';
  icon: IconName;
}) {
  return (
    <div className="ai-tile">
      <span className="ai-tile__head">
        <span className="bl-kpi__label">
          <Icon name={icon} size={16} />
          {label}
        </span>
      </span>
      <span className="ai-tile__value">{value}</span>
      <span className={`z-hint bl-kpi__note bl-kpi__note--${tone}`}>{note}</span>
    </div>
  );
}

const n = (x: number) => x.toLocaleString('en-GB');

function changeText(c: AdminPriceChange, name: string): string {
  const told = c.counts.notified + c.counts.moved;
  const parts = [
    `New sign-ups since ${shortDate(c.createdAt)} pay ${formatCents(c.to)}.`,
    told > 0
      ? `Notice emailed to ${n(told)} subscriber${told === 1 ? '' : 's'}${c.lastMoveAt ? `; the last moves on ${shortDate(c.lastMoveAt)}` : ''} (${n(c.counts.moved)} moved so far).`
      : c.counts.pending > 0
        ? `${n(c.counts.pending)} subscriber${c.counts.pending === 1 ? '' : 's'} will be emailed in the next daily run.`
        : 'No existing subscribers to move.',
  ];
  if (c.counts.reverting > 0)
    parts.push(
      `${n(c.counts.reverting)} subscriber${c.counts.reverting === 1 ? ' is' : 's are'} being put back on the old price (retried daily).`,
    );
  if (c.counts.revertFailed > 0)
    parts.push(
      `${n(c.counts.revertFailed)} renewed at the new price before the stop could put them back: check them in Stripe.`,
    );
  const head =
    c.status === 'stopped'
      ? `${name}: the change to ${formatCents(c.to)} was stopped.`
      : `${name}: ${formatCents(c.from)} → ${formatCents(c.to)}.`;
  if (c.status === 'stopped') return `${head} ${parts.slice(2).join(' ')}`;
  return `${head} ${parts.join(' ')}`;
}

function PriceDialog({
  row,
  onClose,
  onSaved,
}: {
  row: AdminPriceRow | null;
  onClose: () => void;
  onSaved: (r: AdminBillingResult) => void;
}) {
  const write = useBillingWrite();
  const toast = useToast();
  const reasonId = useId();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<AdminPricePreviewResult | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    setAmount(row ? centsToInput(row.amount) : '');
    setReason('');
    setPreview(null);
    setPreviewErr(null);
    setSaveErr(null);
  }, [row]);

  const cents = dollarsToCents(amount);
  const fieldErr = amount.trim() === '' ? null : priceError(cents);
  const unchanged = row !== null && cents === row.amount;
  const valid = row !== null && cents !== null && fieldErr === null && !unchanged;

  useEffect(() => {
    if (!row || !valid || cents === null) {
      setPreview(null);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api<AdminPricePreviewResult>(ADMIN_BILLING_API.pricePreview, {
        method: 'POST',
        body: { lookupKey: row.lookupKey, amount: cents },
        signal: ctl.signal,
      })
        .then((p) => {
          setPreview(p);
          setPreviewErr(null);
        })
        .catch((e) => {
          if ((e as Error).name === 'AbortError') return;
          setPreview(null);
          setPreviewErr(errorMessage(e));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [row, valid, cents]);

  const raise = row !== null && cents !== null && cents > row.amount;
  /** Only a preview for the amount now in the field counts (an older answer may still be on screen). */
  const pv = preview && preview.to === cents ? preview : null;
  const ready = valid && reason.trim().length >= 3 && pv !== null;

  const save = async () => {
    if (!row || cents === null || !ready) return;
    setBusy(true);
    setSaveErr(null);
    try {
      const r = await write(ADMIN_BILLING_API.prices, 'POST', {
        lookupKey: row.lookupKey,
        amount: cents,
        reason: reason.trim(),
      });
      onSaved(r);
      toast.show(`${priceName(row)} is now ${formatCents(cents)}`, 'good');
      onClose();
    } catch (e) {
      setSaveErr(billingSaveError(e));
    } finally {
      setBusy(false);
    }
  };

  const name = row ? priceName(row) : '';
  const isPlan = row?.plan != null;
  const moves =
    pv && pv.subscribers > 0
      ? pv.raise
        ? `Emailed today; each moves at their first renewal at least ${PRICE_NOTICE_DAYS} days from now${pv.firstMoveAt ? `, ${shortDate(pv.firstMoveAt)}${pv.lastMoveAt && pv.lastMoveAt !== pv.firstMoveAt ? ` to ${shortDate(pv.lastMoveAt)}` : ''}` : ''}`
        : `Emailed today; each moves at their next renewal${pv.lastMoveAt ? `, by ${shortDate(pv.lastMoveAt)}` : ''}`
      : 'Nobody to move';

  return (
    <Dialog
      open={row !== null}
      onClose={onClose}
      title={`Change ${name} price`}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            kind="primary"
            icon={raise ? 'passkey' : undefined}
            busy={busy}
            disabled={!ready}
            onClick={save}
          >
            {raise ? 'Confirm with passkey' : 'Save price'}
          </Button>
        </>
      }
    >
      <div className="bl-dialog">
        <div className="bl-dialog__pair">
          <Field
            label="Current price"
            mono
            size="md"
            value={row ? formatCents(row.amount) : ''}
            disabled
            readOnly
          />
          <Field
            label="New price (USD)"
            mono
            size="md"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            error={fieldErr ?? (unchanged ? 'That’s the current price.' : null)}
            onChange={(e) => {
              setAmount(e.target.value);
              setSaveErr(null);
            }}
          />
        </div>
        <div className="bl-impact" aria-live="polite">
          <div className="bl-impact__row">
            <span>{isPlan ? 'New sign-ups' : 'Anyone buying this pack'}</span>
            <span>{valid && cents !== null ? `Pay ${formatCents(cents)} from now` : '—'}</span>
          </div>
          {isPlan && (
            <div className="bl-impact__row">
              <span>
                {pv
                  ? `${n(pv.subscribers)} existing subscriber${pv.subscribers === 1 ? '' : 's'}`
                  : 'Existing subscribers'}
              </span>
              <span>
                {!valid ? (
                  '—'
                ) : pv ? (
                  moves
                ) : previewErr ? (
                  'Couldn’t load'
                ) : (
                  <Spinner size={14} label="Working out who moves" />
                )}
              </span>
            </div>
          )}
        </div>
        {previewErr && (
          <Note tone="bad" icon="alert" role="alert">
            {previewErr}
          </Note>
        )}
        <div className="z-field">
          <label htmlFor={reasonId}>
            Reason (goes in the audit log{raise ? ' and the Owners’ email' : ''})
          </label>
          <textarea
            id={reasonId}
            className="z-input"
            rows={2}
            maxLength={PRICE_REASON_MAX}
            value={reason}
            placeholder="e.g. Storage and GPU costs went up"
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <p className="bl-dialog__note">
          <Icon name={raise ? 'passkey' : 'info'} size={16} />
          <span>
            {raise
              ? 'A price increase needs your passkey. Every Owner is emailed. You can stop the change until each subscriber’s move date.'
              : 'Lowering a price saves at once and is recorded in the audit log.'}
          </span>
        </p>
        {saveErr && (
          <Note tone="bad" icon="alert" role="alert">
            {saveErr}
          </Note>
        )}
      </div>
    </Dialog>
  );
}

function StopDialog({
  change,
  name,
  onClose,
  onSaved,
}: {
  change: AdminPriceChange | null;
  name: string;
  onClose: () => void;
  onSaved: (r: AdminBillingResult) => void;
}) {
  const write = useBillingWrite();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const close = () => {
    setErr(null);
    onClose();
  };
  const stop = async () => {
    if (!change) return;
    setBusy(true);
    setErr(null);
    try {
      onSaved(await write(ADMIN_BILLING_API.priceChange(change.id), 'DELETE'));
      toast.show('Price change stopped', 'good');
      close();
    } catch (e) {
      setErr(billingSaveError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={change !== null}
      onClose={close}
      title="Stop this price change?"
      footer={
        <>
          <Button kind="ghost" onClick={close}>
            Keep it
          </Button>
          <Button kind="danger" busy={busy} onClick={stop}>
            Stop the change
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="z-muted">
          {change &&
            `${name}: subscribers who haven’t moved yet stay on ${formatCents(change.from)}. Anyone already moved whose renewal hasn’t happened goes back to ${formatCents(change.from)}. New sign-ups keep paying ${formatCents(change.to)} until you set another price.`}
        </p>
        {err && (
          <Note tone="bad" icon="alert" role="alert">
            {err}
          </Note>
        )}
      </div>
    </Dialog>
  );
}

const EVENT_STATUS: Record<AdminWebhookEvent['status'], { label: string; tone: ChipTone }> = {
  processed: { label: 'Processed', tone: 'good' },
  ignored: { label: 'Ignored', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'bad' },
};

function Body({
  data,
  editable,
  onData,
}: {
  data: AdminBillingResult;
  editable: boolean;
  onData: (r: AdminBillingResult) => void;
}) {
  const write = useBillingWrite();
  const toast = useToast();
  const [editing, setEditing] = useState<AdminPriceRow | null>(null);
  const [stopping, setStopping] = useState<AdminPriceChange | null>(null);
  const [packBusy, setPackBusy] = useState<string | null>(null);
  const [packErr, setPackErr] = useState<string | null>(null);
  const canAct = editable && data.configured;
  const open = data.changes.filter((c) => isOpenChange(c) || needsAttention(c));
  const changing = new Set(open.map((c) => c.lookupKey));
  const rowByKey = new Map(data.prices.map((p) => [p.lookupKey, p]));
  const nameOf = (key: string) => {
    const r = rowByKey.get(key);
    return r ? priceName(r) : key;
  };

  const togglePack = async (r: AdminPriceRow) => {
    setPackBusy(r.lookupKey);
    setPackErr(null);
    try {
      onData(await write(ADMIN_BILLING_API.pack(r.lookupKey), 'PATCH', { active: !r.active }));
      toast.show(`${priceName(r)} ${r.active ? 'taken off sale' : 'on sale'}`, 'good');
    } catch (e) {
      setPackErr(billingSaveError(e));
    } finally {
      setPackBusy(null);
    }
  };

  const status = (r: AdminPriceRow) => {
    if (changing.has(r.lookupKey))
      return (
        <Chip tone="warn" dot>
          Changing
        </Chip>
      );
    if (!r.plan && !r.active)
      return (
        <Chip tone="neutral" dot>
          Off
        </Chip>
      );
    return (
      <Chip tone="good" dot>
        On sale
      </Chip>
    );
  };

  const priceCols: Column<AdminPriceRow>[] = [
    { key: 'p', header: 'Plan', cell: (r) => <span className="cell-strong">{priceKind(r)}</span> },
    { key: 'b', header: 'Billed', cell: (r) => billedLabel(r) },
    {
      key: 'a',
      header: 'Price (USD)',
      cell: (r) => <span className="z-mono cell-strong">{formatCents(r.amount)}</span>,
    },
    {
      key: 'k',
      header: 'Stripe lookup key',
      cell: (r) => <span className="z-mono z-muted">{r.lookupKey}</span>,
    },
    {
      key: 's',
      header: 'Subscribers',
      cell: (r) => <span className="z-mono">{r.plan ? n(r.subscribers) : '—'}</span>,
    },
    { key: 'st', header: 'Status', cell: status },
    {
      key: 'x',
      header: <span className="z-sr">Actions</span>,
      cell: (r) =>
        canAct ? (
          <span className="btn-row bl-actions">
            {!r.plan && (
              <Button
                size="sm"
                kind="ghost"
                icon={r.active ? undefined : 'passkey'}
                busy={packBusy === r.lookupKey}
                onClick={() => void togglePack(r)}
                aria-label={`${r.active ? 'Take off sale' : 'Put on sale'}: ${priceName(r)}`}
              >
                {r.active ? 'Turn off' : 'Turn on'}
              </Button>
            )}
            <Button size="sm" onClick={() => setEditing(r)} aria-label={`Change price: ${priceName(r)}`}>
              Change price
            </Button>
          </span>
        ) : null,
    },
  ];

  const dueCols: Column<AdminBillingResult['paymentDue'][number]>[] = [
    { key: 'm', header: 'Member', cell: (r) => <span className="bl-email">{r.email}</span> },
    { key: 'p', header: 'Plan', cell: (r) => (r.plan === 'pro' ? 'Pro' : 'Studio') },
    {
      key: 'a',
      header: 'Amount',
      cell: (r) => <span className="z-mono cell-strong">{formatCents(r.amount)}</span>,
    },
    { key: 't', header: 'Attempts', cell: (r) => <span className="z-mono">{r.attempts}</span> },
    { key: 's', header: 'Due since', cell: (r) => <span className="z-muted">{shortDate(r.since)}</span> },
  ];

  const k = data.kpis;
  return (
    <>
      {!data.configured && (
        <Note tone="warn" icon="alert">
          <strong>Stripe isn’t connected yet, so nothing can be sold or changed.</strong> To connect it: set
          the Worker secrets <code>STRIPE_SECRET_KEY</code> (a restricted key) and{' '}
          <code>STRIPE_WEBHOOK_SECRET</code>, run <code>node scripts/stripe-setup.mjs --test</code> to create
          the products, prices, portal settings and the webhook endpoint (<code>/api/v1/stripe/webhook</code>
          ), then reload this page.
        </Note>
      )}
      <div className="ai-tiles">
        <Kpi
          label="Monthly recurring revenue"
          value={formatCents(k.mrr)}
          note="Yearly plans counted ÷ 12"
          tone="muted"
          icon="dollar"
        />
        <Kpi label="Paying libraries" value={n(k.paying)} note="Pro and Studio" tone="muted" icon="people" />
        <Kpi
          label="Payment due"
          value={n(k.pastDue)}
          note={k.pastDue > 0 ? 'Stripe retrying the card' : 'All paid'}
          tone={k.pastDue > 0 ? 'warn' : 'good'}
          icon="alert"
        />
        <Kpi
          label="Cancelling at renewal"
          value={n(k.cancelling)}
          note="Still on their plan until then"
          tone="muted"
          icon="clock"
        />
        <Kpi
          label="Top-up credits sold"
          value={n(k.topUpCreditsSold30d)}
          note="Last 30 days"
          tone="good"
          icon="breeze"
        />
      </div>

      <Card aria-labelledby="bl-prices-title">
        <CardHead title={<span id="bl-prices-title">Prices</span>}>
          <Chip tone="outline" icon="shieldCheck">
            Stripe Managed Payments · Link is the reseller
          </Chip>
        </CardHead>
        <p className="z-hint">
          A new price applies to new sign-ups at once. Existing subscribers get an email and move at their
          first renewal at least {PRICE_NOTICE_DAYS} days later (a lower price applies at their next renewal).
          Raising a price needs your passkey and emails every Owner.
        </p>
        <Table
          columns={priceCols}
          rows={data.prices}
          rowKey={(r) => r.lookupKey}
          caption="Prices"
          minWidth={860}
          empty="No prices yet. Run the Stripe setup script."
        />
        {packErr && (
          <Note tone="bad" icon="alert" role="alert">
            {packErr}
          </Note>
        )}
        {open.map((c) => (
          <div key={c.id} className="bl-change" role="status">
            <Icon name="clock" size={16} />
            <span className="bl-change__text">{changeText(c, nameOf(c.lookupKey))}</span>
            {canAct && isOpenChange(c) && (
              <Button
                size="sm"
                onClick={() => setStopping(c)}
                aria-label={`Stop the change: ${nameOf(c.lookupKey)}`}
              >
                Stop the change
              </Button>
            )}
          </div>
        ))}
      </Card>

      <div className="ai-pair">
        <Card aria-labelledby="bl-due-title">
          <CardHead title={<span id="bl-due-title">Payment due</span>}>
            <span className="z-hint">Stripe Smart Retries</span>
          </CardHead>
          <Table
            columns={dueCols}
            rows={data.paymentDue}
            rowKey={(r) => r.ownerId}
            caption="Payment due"
            minWidth={520}
            empty="No payments due."
          />
          <span className="z-hint">Members update their card in Stripe; admins never see card details.</span>
        </Card>
        <Card aria-labelledby="bl-events-title">
          <CardHead title={<span id="bl-events-title">Webhook events</span>}>
            <Chip tone="good" icon="shieldCheck">
              Signatures verified
            </Chip>
          </CardHead>
          {data.events.length === 0 ? (
            <p className="z-hint">No events yet.</p>
          ) : (
            <ul className="bl-events">
              {data.events.map((e) => (
                <li key={e.id} className="bl-events__row">
                  <span className="z-mono bl-events__type">{e.type}</span>
                  <span className="bl-events__spacer" />
                  <Chip tone={EVENT_STATUS[e.status].tone} dot>
                    {EVENT_STATUS[e.status].label}
                    {e.error ? ` · ${e.error}` : ''}
                  </Chip>
                  <span className="z-hint bl-events__at">{ago(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
          <span className="z-hint">
            Each event is applied once. Plans change only from verified events, re-read from Stripe.
          </span>
        </Card>
      </div>

      <PriceDialog row={editing} onClose={() => setEditing(null)} onSaved={onData} />
      <StopDialog
        change={stopping}
        name={stopping ? nameOf(stopping.lookupKey) : ''}
        onClose={() => setStopping(null)}
        onSaved={onData}
      />
    </>
  );
}

export function Billing() {
  const { staff } = useAdminSession();
  const allowed = canSeeBilling(staff?.role);
  const editable = canEditBilling(staff?.role);
  const [data, setData] = useState<AdminBillingResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<AdminBillingResult>(ADMIN_BILLING_API.overview));
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  return (
    <AdminShell
      title="Plans & billing"
      sub="Prices are set here and created in Stripe; plans change only from verified Stripe events."
      actions={
        allowed && (
          <span className="btn-row">
            {!editable && <ReadOnlyChip />}
            <LinkButton
              size="sm"
              iconRight="external"
              href={STRIPE_DASHBOARD}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Stripe dashboard
            </LinkButton>
          </span>
        )
      }
    >
      {!allowed ? (
        <Note tone="warn" icon="lock">
          Plans & billing is for Owners, Admins and Finance.
        </Note>
      ) : (
        <>
          {err && (
            <Note tone="bad" icon="alert" role="alert">
              {err}{' '}
              <button type="button" className="linkish" onClick={() => void load()}>
                Try again
              </button>
            </Note>
          )}
          {!data && !err && <Spinner size={22} label="Loading plans and billing" />}
          {data && <Body data={data} editable={editable} onData={setData} />}
        </>
      )}
    </AdminShell>
  );
}
