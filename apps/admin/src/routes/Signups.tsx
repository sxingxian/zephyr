import {
  ADMIN_API,
  type AdminInviteResult,
  type DecideResult,
  type InviteCodeRow,
  type InviteRequestRow,
  type InviteRow,
  type InviteStatus,
  type Page,
  type SignupSettings,
  type SignupsOverview,
  USE_CASES,
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
  Note,
  Spinner,
  Switch,
  Table,
  useToast,
} from '@zephyr/ui';
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AdminShell } from '../components/Shell';
import { api, errorMessage } from '../lib/api';
import { MAX_PER_SEND, parseEmailList, parseEmailsCsv } from '../lib/csv';
import { canChangeMode, canWrite, useAdminSession } from '../lib/session';

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
const USE_LABEL: Record<string, string> = Object.fromEntries(USE_CASES.map((u) => [u.id, u.label]));
const STATUS_TONE: Record<InviteStatus, ChipTone> = {
  pending: 'acc',
  accepted: 'good',
  expired: 'neutral',
  revoked: 'bad',
};
const cap = (s: string) => (s[0]?.toUpperCase() ?? '') + s.slice(1);

/** Returns only the fields that changed (the API takes a partial patch). */
export function diffSettings(base: SignupSettings, next: SignupSettings): Partial<SignupSettings> {
  const out: Partial<SignupSettings> = {};
  for (const k of Object.keys(next) as (keyof SignupSettings)[]) {
    if (next[k] !== base[k]) (out as Record<string, unknown>)[k] = next[k];
  }
  return out;
}

// ---------------------------------------------------------------- settings
function ModeCard({
  value,
  current,
  title,
  desc,
  icon,
  isDefault,
  disabled,
  onPick,
}: {
  value: SignupSettings['signupMode'];
  current: SignupSettings['signupMode'];
  title: string;
  desc: string;
  icon: 'globe' | 'mail';
  isDefault?: boolean;
  disabled?: boolean;
  onPick: (v: SignupSettings['signupMode']) => void;
}) {
  const id = useId();
  const on = value === current;
  return (
    <label
      htmlFor={id}
      className={`mode-card${on ? ' mode-card--on' : ''}${disabled ? ' mode-card--off' : ''}`}
    >
      <input
        id={id}
        type="radio"
        name="signup-mode"
        value={value}
        checked={on}
        disabled={disabled}
        onChange={() => onPick(value)}
      />
      <span className="mode-card__text">
        <span className="mode-card__title">
          <Icon name={icon} size={18} />
          {title}
          {isDefault && (
            <Chip tone="ink" size="sm">
              Default
            </Chip>
          )}
        </span>
        <span className="mode-card__desc">{desc}</span>
      </span>
    </label>
  );
}

function NumberRow({
  label,
  hint,
  unit,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (n: number) => void;
}) {
  const id = useId();
  return (
    <div className="num-row">
      <label htmlFor={id} className="num-row__text">
        <span>{label}</span>
        <span className="z-hint">{hint}</span>
      </label>
      <span className="num-row__input">
        <input
          id={id}
          className="z-input z-input--md z-mono"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Math.max(min, Math.min(max, Math.round(Number(e.target.value) || 0))))}
        />
        <span className="z-muted">{unit}</span>
      </span>
    </div>
  );
}

function SettingsPanel({
  base,
  onSaved,
  readOnly,
  ownerOnlyMode,
}: {
  base: SignupSettings;
  onSaved: (s: SignupSettings) => void;
  readOnly: boolean;
  ownerOnlyMode: boolean;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState(base);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // Follow the server's settings only when they really change, never because the parent re-fetched the same
  // values, and never while a change is waiting for its reason: that would drop the change and save only the reason.
  // Not on mount either: the draft already starts from them, and a reset there would wipe a click made before the
  // effect ran.
  const baseKey = JSON.stringify(base);
  const shownKey = useRef(baseKey);
  const [pending, setPending] = useState<Partial<SignupSettings> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the settings' content, not the object identity.
  useEffect(() => {
    if (shownKey.current === baseKey || pending) return;
    shownKey.current = baseKey;
    setDraft(base);
  }, [baseKey]);
  const changes = useMemo(() => diffSettings(base, draft), [base, draft]);
  const dirty = Object.keys(changes).length > 0;
  const set = <K extends keyof SignupSettings>(k: K, v: SignupSettings[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  // Switching who can sign up, or pausing all sign-ups, is significant: ask for a reason for the audit log.
  const needsReason = 'signupMode' in changes || changes.signupsPaused === true;

  const save = async (withReason?: string) => {
    setBusy(true);
    try {
      const saved = await api<SignupSettings>(ADMIN_API.settings, {
        method: 'PATCH',
        body: withReason ? { ...(pending ?? changes), reason: withReason } : changes,
      });
      onSaved(saved);
      setReasonOpen(false);
      setPending(null);
      setReason('');
      toast.show('Sign-up settings saved', 'good');
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card aria-labelledby="who-title">
      <CardHead title={<span id="who-title">Who can create an account</span>}>
        <Chip tone="outline" icon="clock">
          Changes apply within 30 seconds
        </Chip>
        {!readOnly && (
          <>
            <Button kind="ghost" size="sm" disabled={!dirty || busy} onClick={() => setDraft(base)}>
              Discard
            </Button>
            <Button
              kind="primary"
              size="sm"
              disabled={!dirty}
              busy={busy}
              onClick={() => {
                if (!needsReason) return void save();
                setPending(changes);
                setReasonOpen(true);
              }}
            >
              Save
            </Button>
          </>
        )}
      </CardHead>
      <fieldset className="mode-cards">
        <legend className="z-sr">Sign-up mode</legend>
        <ModeCard
          value="open"
          current={draft.signupMode}
          title="Open"
          icon="globe"
          desc="Anyone can sign up from the landing page or the app. Turnstile and email verification still apply."
          disabled={readOnly || ownerOnlyMode}
          onPick={(v) => set('signupMode', v)}
        />
        <ModeCard
          value="invite_only"
          current={draft.signupMode}
          title="Invite only"
          icon="mail"
          isDefault
          desc="New accounts need an invite. The landing page shows “Request an invite” and “I have an invite” instead of “Start free”, and sign-up asks for an invite."
          disabled={readOnly || ownerOnlyMode}
          onPick={(v) => set('signupMode', v)}
        />
      </fieldset>
      {ownerOnlyMode && !readOnly && <p className="z-hint">Only Owners can change the sign-up mode.</p>}
      <div>
        <Switch
          label="Members can invite others"
          hint="Each member gets a few invites to share with clients or colleagues"
          checked={draft.memberInvitesEnabled}
          disabled={readOnly}
          onChange={(v) => set('memberInvitesEnabled', v)}
        />
        <NumberRow
          label="Invites per member"
          hint="Owners and Admins are not limited"
          unit="a month"
          value={draft.memberInvitesPerMonth}
          min={0}
          max={50}
          disabled={readOnly || !draft.memberInvitesEnabled}
          onChange={(n) => set('memberInvitesPerMonth', n)}
        />
        <NumberRow
          label="Invites expire after"
          hint="Unused invites stop working after this"
          unit="days"
          value={draft.inviteTtlDays}
          min={1}
          max={90}
          disabled={readOnly}
          onChange={(n) => set('inviteTtlDays', n)}
        />
        <Switch
          label="Accept invite requests from the landing page"
          hint="Shows a request form on the landing page. Requests wait below for approval; nothing is sent automatically"
          checked={draft.acceptInviteRequests}
          disabled={readOnly}
          onChange={(v) => set('acceptInviteRequests', v)}
        />
        <Switch
          label="Email invites are tied to one address"
          hint="Always on: the account must use the invited address, so a forwarded link can’t be reused"
          checked
          disabled
        />
        <Switch
          label="Pause all new sign-ups"
          hint="For incidents. Blocks invites too; existing members are not affected"
          checked={draft.signupsPaused}
          disabled={readOnly}
          onChange={(v) => set('signupsPaused', v)}
        />
      </div>
      <Dialog
        open={reasonOpen}
        onClose={() => {
          setReasonOpen(false);
          setPending(null);
        }}
        title="Why are you making this change?"
        footer={
          <>
            <Button
              kind="ghost"
              onClick={() => {
                setReasonOpen(false);
                setPending(null);
              }}
            >
              Cancel
            </Button>
            <Button
              kind="primary"
              busy={busy}
              disabled={reason.trim().length < 3}
              onClick={() => save(reason.trim())}
            >
              Save change
            </Button>
          </>
        }
      >
        <p className="z-muted">
          {pending && 'signupMode' in pending
            ? `Switching to ${pending.signupMode === 'open' ? 'Open: anyone will be able to create an account' : 'Invite only: new accounts will need an invite'}.`
            : 'Pausing stops every new account, including invites, until you turn it back on.'}{' '}
          Your reason is saved to the audit log.
        </p>
        <Field
          label="Reason"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Opening up for the launch on 1 Dec"
        />
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------- invite people
function InvitePeople({ disabled, onSent }: { disabled: boolean; onSent: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'warn' | 'good'; text: string } | null>(null);
  const fileId = useId();
  const parsed = useMemo(() => parseEmailList(text), [text]);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 512 * 1024) {
      setMsg({ tone: 'warn', text: 'That file is too large. Use a CSV under 512 KB.' });
      return;
    }
    const r = parseEmailsCsv(await f.text());
    setText(r.emails.join(', '));
    const bits = [`${r.emails.length} address${r.emails.length === 1 ? '' : 'es'} added from ${f.name}.`];
    if (r.overflow) bits.push(`${r.overflow} more skipped: send up to ${MAX_PER_SEND} at a time.`);
    if (r.invalid.length)
      bits.push(`${r.invalid.length} row${r.invalid.length === 1 ? '' : 's'} didn’t look like an email.`);
    setMsg({ tone: r.overflow || r.invalid.length ? 'warn' : 'good', text: bits.join(' ') });
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!parsed.emails.length) {
      setMsg({ tone: 'warn', text: 'Add at least one email address.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<AdminInviteResult>(ADMIN_API.invites, {
        method: 'POST',
        body: note.trim() ? { emails: parsed.emails, note: note.trim() } : { emails: parsed.emails },
      });
      const skipped = r.skipped.length
        ? ` ${r.skipped.length} skipped (${r.skipped.map((s) => `${s.email}: ${s.reason.replace('_', ' ')}`).join(', ')}).`
        : '';
      setMsg({
        tone: r.skipped.length ? 'warn' : 'good',
        text: `${r.sent} invite${r.sent === 1 ? '' : 's'} sent.${skipped}`,
      });
      toast.show(`${r.sent} invite${r.sent === 1 ? '' : 's'} sent`, 'good');
      setText('');
      setNote('');
      onSent();
    } catch (err) {
      setMsg({ tone: 'warn', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex-half">
      <CardHead title="Invite people" />
      <form className="stack" onSubmit={send}>
        <div className="z-field">
          <label htmlFor="invite-emails">Email addresses</label>
          <textarea
            id="invite-emails"
            className="z-input"
            rows={3}
            placeholder="name@example.com, another@example.com"
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            aria-describedby="invite-emails-hint"
          />
          <span id="invite-emails-hint" className="z-hint">
            Separate with commas or new lines, up to {MAX_PER_SEND} at a time. Each person gets a single-use
            link.
            {parsed.emails.length > 0 && ` ${parsed.emails.length} ready.`}
            {parsed.invalid.length > 0 && ` ${parsed.invalid.length} not valid.`}
          </span>
        </div>
        <Field
          label="Personal note (optional)"
          size="md"
          maxLength={500}
          placeholder="Welcome to the Zephyr beta"
          value={note}
          disabled={disabled}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="btn-row">
          <Button type="submit" kind="primary" icon="mail" busy={busy} disabled={disabled}>
            Send invites
          </Button>
          <label
            htmlFor={fileId}
            className={`z-btn z-btn--secondary z-btn--md${disabled ? ' is-disabled' : ''}`}
          >
            <Icon name="upload" size={17} />
            <span>Import CSV</span>
          </label>
          <input
            id={fileId}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="z-sr"
            disabled={disabled}
            onChange={onFile}
          />
        </div>
      </form>
      {msg && (
        <Note tone={msg.tone} icon={msg.tone === 'good' ? 'check' : 'alert'} role="status">
          {msg.text}
        </Note>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- codes
function Codes({
  codes,
  disabled,
  onChange,
}: {
  codes: InviteCodeRow[];
  disabled: boolean;
  onChange: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', label: '', maxUses: 50, expiresAt: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const code = form.code.trim().toUpperCase();
    if (!/^[A-Z0-9-]{4,32}$/.test(code)) {
      setErr('4–32 letters, numbers or dashes, like WEDDING-EXPO.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { code, maxUses: form.maxUses };
      if (form.label.trim()) body.label = form.label.trim();
      if (form.expiresAt) body.expiresAt = new Date(`${form.expiresAt}T23:59:59`).toISOString();
      await api(ADMIN_API.codes, { method: 'POST', body });
      toast.show(`Code ${code} created`, 'good');
      setOpen(false);
      setForm({ code: '', label: '', maxUses: 50, expiresAt: '' });
      onChange();
    } catch (e2) {
      setErr(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (c: InviteCodeRow) => {
    try {
      await api(ADMIN_API.codeRevoke(c.id), { method: 'POST', body: {} });
      toast.show(`Code ${c.code} revoked`, 'good');
      onChange();
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    }
  };

  const state = (c: InviteCodeRow): [string, ChipTone] => {
    if (c.revokedAt) return ['Revoked', 'bad'];
    if (c.expiresAt && new Date(c.expiresAt) < new Date()) return [`Expired ${fmt(c.expiresAt)}`, 'neutral'];
    if (c.uses >= c.maxUses) return ['Used up', 'neutral'];
    return [c.expiresAt ? `Ends ${fmt(c.expiresAt)}` : 'No end date', 'good'];
  };

  return (
    <Card className="flex-half">
      <CardHead title="Invite codes">
        {!disabled && (
          <Button size="sm" icon="plus" onClick={() => setOpen(true)}>
            New code
          </Button>
        )}
      </CardHead>
      <Note>
        For events and launches. A code works for many people but each still verifies their own email, and
        Turnstile blocks scripted sign-ups.
      </Note>
      {codes.length === 0 ? (
        <p className="z-hint">No codes yet.</p>
      ) : (
        <ul className="code-list">
          {codes.map((c) => {
            const [label, tone] = state(c);
            return (
              <li key={c.id}>
                <span className="z-mono code-list__code">{c.code}</span>
                <span className="z-hint">
                  {c.uses} of {c.maxUses} used{c.label ? ` · ${c.label}` : ''}
                </span>
                <span className="code-list__end">
                  <Chip tone={tone}>{label}</Chip>
                  {!disabled && !c.revokedAt && (
                    <Button
                      kind="ghost"
                      size="sm"
                      onClick={() => revoke(c)}
                      aria-label={`Revoke code ${c.code}`}
                    >
                      Revoke
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New invite code"
        footer={
          <>
            <Button kind="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button kind="primary" type="submit" form="code-form" busy={busy}>
              Create code
            </Button>
          </>
        }
      >
        <form id="code-form" className="stack" onSubmit={create}>
          <Field
            label="Code"
            mono
            autoCapitalize="characters"
            maxLength={32}
            placeholder="WEDDING-EXPO"
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            error={err}
          />
          <Field
            label="Label (optional)"
            size="md"
            maxLength={80}
            placeholder="Wedding expo, Singapore"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
          <div className="two-col">
            <Field
              label="Max uses"
              size="md"
              type="number"
              min={1}
              max={10000}
              value={form.maxUses}
              onChange={(e) =>
                setForm({ ...form, maxUses: Math.max(1, Math.min(10000, Number(e.target.value) || 1)) })
              }
            />
            <Field
              label="Ends on (optional)"
              size="md"
              type="date"
              value={form.expiresAt}
              onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
            />
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------- requests
function Requests({
  pending,
  disabled,
  onDecided,
}: {
  pending: number;
  disabled: boolean;
  onDecided: () => void;
}) {
  const toast = useToast();
  const [page, setPage] = useState<Page<InviteRequestRow> | null>(null);
  const [items, setItems] = useState<InviteRequestRow[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    try {
      const q = new URLSearchParams({ status: 'pending' });
      if (cursor) q.set('cursor', cursor);
      const p = await api<Page<InviteRequestRow>>(`${ADMIN_API.requests}?${q}`);
      setPage(p);
      setItems((xs) => (cursor ? [...xs, ...p.items] : p.items));
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (ids: string[], decision: 'approve' | 'decline') => {
    if (!ids.length) return;
    setBusy(true);
    try {
      const r = await api<DecideResult>(ADMIN_API.requestsDecide, {
        method: 'POST',
        body: { ids, decision },
      });
      toast.show(
        decision === 'approve' ? `${r.approved} approved, invites sent` : `${r.declined} declined`,
        'good',
      );
      setSel(new Set());
      await load();
      onDecided();
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const allOn = items.length > 0 && items.every((i) => sel.has(i.id));
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const cols: Column<InviteRequestRow>[] = [
    {
      key: 'sel',
      header: (
        <input
          type="checkbox"
          aria-label="Select all requests"
          checked={allOn}
          disabled={disabled || !items.length}
          onChange={() => setSel(allOn ? new Set() : new Set(items.map((i) => i.id)))}
        />
      ),
      cell: (r) => (
        <input
          type="checkbox"
          aria-label={`Select ${r.email}`}
          checked={sel.has(r.id)}
          disabled={disabled}
          onChange={() => toggle(r.id)}
        />
      ),
      className: 'col-check',
    },
    { key: 'email', header: 'Email', cell: (r) => <span className="z-mono cell-strong">{r.email}</span> },
    {
      key: 'use',
      header: 'Using Zephyr for',
      cell: (r) => (r.useCase ? (USE_LABEL[r.useCase] ?? r.useCase) : <span className="z-muted">—</span>),
    },
    { key: 'at', header: 'Requested', cell: (r) => <span className="z-mono">{fmtTime(r.createdAt)}</span> },
    {
      key: 'sig',
      header: 'Signals',
      cell: (r) =>
        r.disposable ? <Chip tone="warn">Disposable email</Chip> : <Chip tone="good">Turnstile passed</Chip>,
    },
    {
      key: 'act',
      header: <span className="z-sr">Actions</span>,
      cell: (r) =>
        disabled ? null : (
          <span className="btn-row btn-row--tight">
            <Button
              kind="ghost"
              size="sm"
              disabled={busy}
              onClick={() => decide([r.id], 'decline')}
              aria-label={`Decline ${r.email}`}
            >
              Decline
            </Button>
            <Button
              kind="tint"
              size="sm"
              disabled={busy}
              onClick={() => decide([r.id], 'approve')}
              aria-label={`Approve ${r.email}`}
            >
              Approve
            </Button>
          </span>
        ),
    },
  ];

  return (
    <Card>
      <CardHead
        title={
          <>
            Invite requests <Chip tone="acc">{pending} waiting</Chip>
          </>
        }
      >
        {!disabled && (
          <>
            <Button
              kind="ghost"
              size="sm"
              disabled={!sel.size || busy}
              onClick={() => decide([...sel], 'decline')}
            >
              Decline selected
            </Button>
            <Button
              kind="primary"
              size="sm"
              icon="check"
              disabled={!sel.size || busy}
              onClick={() => decide([...sel], 'approve')}
            >
              Approve selected{sel.size ? ` (${sel.size})` : ''}
            </Button>
          </>
        )}
      </CardHead>
      <Note>
        From the landing page form. Approving sends a normal single-use email invite. Requests not approved
        within 90 days are deleted, and the email is only used to send the invite.
      </Note>
      {err && (
        <Note tone="warn" icon="alert" role="alert">
          {err}
        </Note>
      )}
      {page === null && !err ? (
        <Spinner size={18} label="Loading requests" />
      ) : (
        <Table
          caption="Pending invite requests"
          columns={cols}
          rows={items}
          rowKey={(r) => r.id}
          empty="No requests waiting."
          minWidth={860}
        />
      )}
      {page?.nextCursor && (
        <Button
          kind="ghost"
          size="sm"
          className="self-start"
          onClick={() => load(page.nextCursor ?? undefined)}
        >
          Load more
        </Button>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- invites
function Invites({ disabled, reloadKey }: { disabled: boolean; reloadKey: number }) {
  const toast = useToast();
  const [status, setStatus] = useState<'all' | InviteStatus>('all');
  const [items, setItems] = useState<InviteRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const selId = useId();

  const load = useCallback(
    async (next?: string) => {
      setLoading(true);
      try {
        const q = new URLSearchParams();
        if (status !== 'all') q.set('status', status);
        if (next) q.set('cursor', next);
        const p = await api<Page<InviteRow>>(`${ADMIN_API.invites}${q.size ? `?${q}` : ''}`);
        setItems((xs) => (next ? [...xs, ...p.items] : p.items));
        setCursor(p.nextCursor);
        setErr(null);
      } catch (e) {
        setErr(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [status],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-fetches after other panels change data
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const act = async (row: InviteRow, kind: 'resend' | 'revoke') => {
    try {
      await api(kind === 'resend' ? ADMIN_API.inviteResend(row.id) : ADMIN_API.inviteRevoke(row.id), {
        method: 'POST',
        body: {},
      });
      toast.show(
        kind === 'resend' ? `Invite re-sent to ${row.email}` : `Invite for ${row.email} revoked`,
        'good',
      );
      await load();
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    }
  };

  const cols: Column<InviteRow>[] = [
    { key: 'email', header: 'Email', cell: (r) => <span className="z-mono cell-strong">{r.email}</span> },
    {
      key: 'by',
      header: 'Invited by',
      cell: (r) => r.invitedBy ?? <span className="z-muted">{cap(r.source)}</span>,
    },
    { key: 'sent', header: 'Sent', cell: (r) => <span className="z-mono">{fmt(r.createdAt)}</span> },
    { key: 'exp', header: 'Expires', cell: (r) => <span className="z-mono">{fmt(r.expiresAt)}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <Chip tone={STATUS_TONE[r.status]} dot>
          {cap(r.status)}
        </Chip>
      ),
    },
    {
      key: 'act',
      header: <span className="z-sr">Actions</span>,
      cell: (r) =>
        r.status === 'pending' && !disabled ? (
          <span className="btn-row btn-row--tight">
            <Button
              kind="ghost"
              size="sm"
              onClick={() => act(r, 'resend')}
              aria-label={`Resend invite to ${r.email}`}
            >
              Resend
            </Button>
            <Button
              kind="danger"
              size="sm"
              onClick={() => act(r, 'revoke')}
              aria-label={`Revoke invite for ${r.email}`}
            >
              Revoke
            </Button>
          </span>
        ) : (
          <span className="z-muted">—</span>
        ),
    },
  ];

  return (
    <Card>
      <CardHead title="Invites">
        <div className="z-field filter">
          <label htmlFor={selId}>Status</label>
          <select
            id={selId}
            className="z-input z-input--md z-select"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="accepted">Accepted</option>
            <option value="expired">Expired</option>
            <option value="revoked">Revoked</option>
          </select>
        </div>
      </CardHead>
      {err && (
        <Note tone="warn" icon="alert" role="alert">
          {err}
        </Note>
      )}
      <Table
        caption="Invites"
        columns={cols}
        rows={items}
        rowKey={(r) => r.id}
        empty={loading ? 'Loading…' : 'No invites match.'}
        minWidth={860}
      />
      {cursor && (
        <Button kind="ghost" size="sm" className="self-start" onClick={() => load(cursor)} disabled={loading}>
          Load more
        </Button>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- page
export function Signups() {
  const { staff } = useAdminSession();
  const [data, setData] = useState<SignupsOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const writable = canWrite(staff?.role);

  const load = useCallback(async () => {
    try {
      setData(await api<SignupsOverview>(ADMIN_API.signups));
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const changed = () => {
    setReloadKey((k) => k + 1);
    void load();
  };

  return (
    <AdminShell
      title="Sign-ups & invites"
      sub="Choose who can create a Zephyr account. Existing members can always sign in, and guests never need an account to open a passcode gallery."
      actions={
        !writable && (
          <Chip tone="outline" icon="eye">
            Read-only for your role
          </Chip>
        )
      }
    >
      {err && (
        <Note tone="bad" icon="alert" role="alert">
          {err}
        </Note>
      )}
      {!data && !err && <Spinner size={22} label="Loading sign-up settings" />}
      {data && (
        <>
          <SettingsPanel
            base={data.settings}
            readOnly={!writable}
            ownerOnlyMode={!canChangeMode(staff?.role)}
            onSaved={(s) => setData((d) => (d ? { ...d, settings: s } : d))}
          />
          <div className="two-panels">
            <InvitePeople disabled={!writable || data.settings.signupsPaused} onSent={changed} />
            <Codes codes={data.codes} disabled={!writable} onChange={changed} />
          </div>
          {data.settings.signupsPaused && (
            <Note tone="warn" icon="pause">
              New sign-ups are paused, so invites can’t be sent until you turn sign-ups back on.
            </Note>
          )}
          <Requests
            pending={data.pendingRequests}
            disabled={!writable || data.settings.signupsPaused}
            onDecided={changed}
          />
          <Invites disabled={!writable} reloadKey={reloadKey} />
        </>
      )}
    </AdminShell>
  );
}
