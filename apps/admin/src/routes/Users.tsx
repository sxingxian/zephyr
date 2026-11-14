import {
  ADMIN8_API,
  type AdminUserDetail,
  type AdminUserResult,
  type AdminUserRow,
  type AdminUsersResult,
  type MemberStatus,
  type PlanId,
  SUPPORT_CREDIT_GRANT_MAX,
  SUSPEND_CATEGORIES,
  type SuspendCategory,
} from '@zephyr/shared/client';
import {
  Button,
  Card,
  CardHead,
  Chip,
  type ChipTone,
  type Column,
  Field,
  Icon,
  IconButton,
  LinkButton,
  Note,
  SelectField,
  Spinner,
  Switch,
  Table,
  useToast,
} from '@zephyr/ui';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { Effects, PageState, ReasonDialog } from '../components/Kit8';
import { AdminShell } from '../components/Shell';
import { can, formatBytes, fromLocalInput, n, PLAN_LABEL, shortDate, useAdminWrite } from '../lib/admin8';
import { ago } from '../lib/ai';
import { api, errorMessage } from '../lib/api';
import { useAdminSession } from '../lib/session';

const STATUS: Record<MemberStatus, [string, ChipTone]> = {
  active: ['Active', 'good'],
  read_only: ['Read-only', 'warn'],
  suspended: ['Suspended', 'bad'],
  deletion_scheduled: ['Deletion scheduled', 'neutral'],
};
const CATEGORY: Record<SuspendCategory, string> = {
  abuse: 'Abuse or spam',
  safety: 'Safety report',
  fraud: 'Payment fraud',
  legal: 'Legal request',
  other: 'Other',
};
const planTone = (p: PlanId): ChipTone => (p === 'studio' ? 'ink' : p === 'pro' ? 'acc' : 'neutral');
const nameOf = (u: Pick<AdminUserRow, 'displayName' | 'email'>) => u.displayName || u.email;
const initials = (s: string) =>
  s
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

type Dlg =
  | 'override'
  | 'endOverride'
  | 'credits'
  | 'signOut'
  | 'suspend'
  | 'unsuspend'
  | 'sharing'
  | 'delete'
  | 'undelete'
  | null;

function Drawer({
  user,
  onClose,
  onUser,
}: {
  user: AdminUserDetail;
  onClose: () => void;
  onUser: (u: AdminUserDetail) => void;
}) {
  const { staff } = useAdminSession();
  const role = staff?.role;
  const write = useAdminWrite();
  const toast = useToast();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [plan, setPlan] = useState<PlanId>('pro');
  const [until, setUntil] = useState('');
  const [amount, setAmount] = useState('200');
  const [category, setCategory] = useState<SuspendCategory>('abuse');
  const [notify, setNotify] = useState(true);
  const id = user.id;
  const run = async (path: string, method: 'POST' | 'PUT' | 'DELETE', body: unknown, done: string) => {
    const r = await write<AdminUserResult>(path, method, body);
    onUser(r.user);
    toast.show(done, 'good');
  };
  const amountN = Number(amount);
  const amountOk =
    Number.isInteger(amountN) && amountN >= 1 && (role !== 'support' || amountN <= SUPPORT_CREDIT_GRANT_MAX);
  const name = nameOf(user);
  const u = user.usage;
  return (
    <aside className="a8-drawer" aria-label={`User details: ${name}`}>
      <div className="a8-drawer__head">
        <Avatar text={initials(name)} seed={user.id} size={44} />
        <div className="a8-drawer__who">
          <span className="a8-drawer__name">{name}</span>
          <span className="z-hint">
            {user.email} · <span className="z-mono">{user.id.slice(0, 8)}</span>
          </span>
        </div>
        <IconButton icon="x" label="Close user details" onClick={onClose} />
      </div>
      <div className="a8-drawer__body">
        <section className="a8-sect">
          <span className="a8-eyebrow">Plan</span>
          <div className="btn-row">
            <Chip tone={planTone(user.plan)}>{PLAN_LABEL[user.plan]}</Chip>
            {user.override ? (
              <Chip tone="outline">
                Comped{user.override.until ? ` until ${shortDate(user.override.until)}` : ''}
              </Chip>
            ) : user.subscription ? (
              <Chip tone="outline">
                Stripe · {user.subscription.interval === 'year' ? 'yearly' : 'monthly'}
              </Chip>
            ) : null}
            <Chip tone={STATUS[user.status][1]} dot>
              {STATUS[user.status][0]}
            </Chip>
            {user.subscription?.stripeCustomerUrl && (
              <LinkButton
                size="sm"
                kind="ghost"
                iconRight="external"
                href={user.subscription.stripeCustomerUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in Stripe
              </LinkButton>
            )}
          </div>
          {user.override && (
            <span className="z-hint">
              Override by {user.override.by}: “{user.override.reason}”
            </span>
          )}
          <div className="a8-kv">
            <div>
              <span>Storage</span>
              <strong>
                {formatBytes(u.storageBytes)} of {formatBytes(u.storageLimitBytes)}
              </strong>
            </div>
            <div>
              <span>AI credits</span>
              <strong>
                {n(u.credits)}
                {u.topUpCredits ? ` + ${n(u.topUpCredits)} top-up` : ''}
              </strong>
            </div>
            <div>
              <span>Galleries</span>
              <strong>{n(u.liveGalleries)} live</strong>
            </div>
            <div>
              <span>Teams</span>
              <strong>
                {user.teams.length
                  ? user.teams
                      .map((t) => `${t.role === 'editor' ? 'Editor' : 'Viewer'} in ${t.name}`)
                      .join(', ')
                  : 'None'}
              </strong>
            </div>
          </div>
        </section>
        <section className="a8-sect">
          <span className="a8-eyebrow">Sign-in</span>
          <span className="a8-line">
            <Icon name="passkey" size={16} />
            {n(user.signIn.passkeys)} passkey{user.signIn.passkeys === 1 ? '' : 's'}
            {user.signIn.lastPasskeyAt && (
              <span className="z-hint"> · last used {ago(user.signIn.lastPasskeyAt)}</span>
            )}
          </span>
          <span className="a8-line">
            <Icon name="monitor" size={16} />
            {n(user.signIn.activeSessions)} active session{user.signIn.activeSessions === 1 ? '' : 's'}
          </span>
          {user.suspension && (
            <Note tone="bad" icon="ban">
              Suspended {shortDate(user.suspension.at)} by {user.suspension.by} ·{' '}
              {CATEGORY[user.suspension.category]}
            </Note>
          )}
          {user.sharingSuspendedAt && !user.suspension && (
            <Note tone="warn" icon="link">
              Sharing suspended since {shortDate(user.sharingSuspendedAt)}
            </Note>
          )}
          {user.deletionDueAt && (
            <Note tone="warn" icon="trash">
              Deletion scheduled for {shortDate(user.deletionDueAt)}
            </Note>
          )}
        </section>
        <Note tone="acc" icon="eyeOff">
          Staff never see photos, file names or faces here: counts, sizes and plan only.
        </Note>
        <section className="a8-sect">
          <span className="a8-eyebrow">Actions</span>
          <div className="a8-actions">
            {can(role, 'planOverride') &&
              (user.override ? (
                <Button size="sm" icon="sliders" onClick={() => setDlg('endOverride')}>
                  End override…
                </Button>
              ) : (
                <Button size="sm" icon="sliders" onClick={() => setDlg('override')}>
                  Override plan…
                </Button>
              ))}
            {can(role, 'usersAct') && (
              <>
                <Button size="sm" icon="breeze" onClick={() => setDlg('credits')}>
                  Grant credits…
                </Button>
                <Button size="sm" icon="logout" onClick={() => setDlg('signOut')}>
                  Sign out all
                </Button>
              </>
            )}
            {can(role, 'suspend') &&
              (user.suspension ? (
                <Button size="sm" icon="unlock" onClick={() => setDlg('unsuspend')}>
                  Unsuspend…
                </Button>
              ) : (
                <Button size="sm" kind="danger" icon="ban" onClick={() => setDlg('suspend')}>
                  Suspend…
                </Button>
              ))}
            {can(role, 'suspend') && user.sharingSuspendedAt && !user.suspension && (
              <Button size="sm" icon="link" onClick={() => setDlg('sharing')}>
                Lift sharing suspension…
              </Button>
            )}
          </div>
          {can(role, 'deleteAccount') &&
            (user.deletionDueAt ? (
              <Button size="sm" kind="ghost" icon="undo" full onClick={() => setDlg('undelete')}>
                Cancel account deletion…
              </Button>
            ) : (
              <Button size="sm" kind="ghost" icon="trash" full onClick={() => setDlg('delete')}>
                Schedule account deletion…
              </Button>
            ))}
          {!can(role, 'usersAct') && !can(role, 'planOverride') && (
            <span className="z-hint">Your role can view members but not change them.</span>
          )}
        </section>
        {user.recent.length > 0 && (
          <section className="a8-sect">
            <span className="a8-eyebrow">Recent staff actions</span>
            <ul className="a8-recent">
              {user.recent.map((e) => (
                <li key={e.id}>
                  <span className="a8-recent__top">
                    <strong>{e.actor.name}</strong>
                    <span className="z-hint">{shortDate(e.at)}</span>
                  </span>
                  <span className="z-hint">
                    {e.action}
                    {e.reason ? ` · “${e.reason}”` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <ReasonDialog
        open={dlg === 'override'}
        title={`Override plan for ${name}`}
        intro="Comp a plan without Stripe, for example for a partner or a support case."
        confirmLabel="Confirm with passkey"
        passkey
        canConfirm={!until || fromLocalInput(until) !== null}
        onClose={() => setDlg(null)}
        onConfirm={(reason) =>
          run(
            ADMIN8_API.userPlan(id),
            'PUT',
            { plan, until: until ? fromLocalInput(until) : null, reason },
            'Plan overridden',
          )
        }
      >
        <div className="bl-dialog__pair">
          <SelectField
            label="Plan"
            value={plan}
            onChange={(e) => setPlan(e.target.value as PlanId)}
            options={(['pro', 'studio', 'free'] as const).map((p) => ({ value: p, label: PLAN_LABEL[p] }))}
          />
          <Field
            label="Ends (leave empty for no end)"
            size="md"
            type="datetime-local"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
        </div>
        <Effects
          items={[
            ['check', `${PLAN_LABEL[plan]} limits apply at once.`, 'good'],
            ['lock', 'Stripe can’t change this plan while the override is on.'],
            [
              'calendar',
              'When it ends, the plan goes back to what Stripe says; over-limit libraries become read-only.',
            ],
          ]}
        />
      </ReasonDialog>
      <ReasonDialog
        open={dlg === 'endOverride'}
        title={`End the override for ${name}`}
        intro="The plan goes back to what Stripe says at once. This saves straight away."
        confirmLabel="End override"
        onClose={() => setDlg(null)}
        onConfirm={(reason) => run(ADMIN8_API.userPlan(id), 'DELETE', { reason }, 'Override ended')}
      />
      <ReasonDialog
        open={dlg === 'credits'}
        title={`Grant credits to ${name}`}
        confirmLabel="Grant credits"
        canConfirm={amountOk}
        onClose={() => setDlg(null)}
        onConfirm={(reason) =>
          run(
            ADMIN8_API.userCredits(id),
            'POST',
            { amount: amountN, reason },
            `${n(amountN)} credits granted`,
          )
        }
      >
        <Field
          label="Credits"
          size="md"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
          error={
            amount && !amountOk
              ? role === 'support'
                ? `Support can grant up to ${n(SUPPORT_CREDIT_GRANT_MAX)} at a time.`
                : 'Enter a whole number.'
              : null
          }
          hint="Added to this month’s credits."
        />
      </ReasonDialog>
      <ReasonDialog
        open={dlg === 'signOut'}
        title={`Sign ${name} out everywhere`}
        intro="Ends every session on every device. They can sign in again straight away."
        confirmLabel="Sign out all"
        onClose={() => setDlg(null)}
        onConfirm={(reason) => run(ADMIN8_API.userSignOut(id), 'POST', { reason }, 'Signed out everywhere')}
      />
      <ReasonDialog
        open={dlg === 'suspend'}
        title={`Suspend ${name}`}
        intro="Stops the account at once. Photos are kept."
        confirmLabel="Suspend account"
        danger
        reasonLabel="Note (audit log only)"
        onClose={() => setDlg(null)}
        onConfirm={(note) =>
          run(ADMIN8_API.userSuspend(id), 'POST', { category, note, notify }, 'Account suspended')
        }
      >
        <SelectField
          label="Reason"
          value={category}
          onChange={(e) => {
            const c = e.target.value as SuspendCategory;
            setCategory(c);
            setNotify(c !== 'safety' && c !== 'legal');
          }}
          options={SUSPEND_CATEGORIES.map((c) => ({ value: c, label: CATEGORY[c] }))}
        />
        <Effects
          items={[
            [
              'logout',
              'Signs them out on every device; signing in shows that the account is suspended.',
              'bad',
            ],
            ['link', 'Their shared galleries go offline for guests.', 'bad'],
            ['people', 'Teammates lose access to their team library while it’s suspended.'],
            ['card', 'Their Stripe subscription isn’t touched; Finance decides on refunds.'],
          ]}
        />
        <Switch
          checked={notify}
          onChange={setNotify}
          label="Email them that their account is suspended"
          hint="Turn off for safety or legal cases where telling them could cause harm"
        />
      </ReasonDialog>
      <ReasonDialog
        open={dlg === 'unsuspend'}
        title={`Unsuspend ${name}`}
        intro="They can sign in again and their galleries come back."
        confirmLabel="Unsuspend with passkey"
        passkey
        onClose={() => setDlg(null)}
        onConfirm={(reason) => run(ADMIN8_API.userSuspend(id), 'DELETE', { reason }, 'Account unsuspended')}
      />
      <ReasonDialog
        open={dlg === 'sharing'}
        title={`Lift ${name}’s sharing suspension`}
        intro="Their galleries come back for guests and they can share again."
        confirmLabel="Lift with passkey"
        passkey
        onClose={() => setDlg(null)}
        onConfirm={(reason) => run(ADMIN8_API.userSharing(id), 'DELETE', { reason }, 'Sharing restored')}
      />
      <ReasonDialog
        open={dlg === 'delete'}
        title={`Schedule deletion of ${name}’s account`}
        intro="Signs them out and deletes everything after 30 days. Only an Owner can cancel it; they can’t restore it themselves."
        confirmLabel="Schedule with passkey"
        danger
        passkey
        onClose={() => setDlg(null)}
        onConfirm={(reason) => run(ADMIN8_API.userDeletion(id), 'POST', { reason }, 'Deletion scheduled')}
      />
      <ReasonDialog
        open={dlg === 'undelete'}
        title={`Cancel deletion of ${name}’s account`}
        confirmLabel="Cancel deletion"
        onClose={() => setDlg(null)}
        onConfirm={(reason) => run(ADMIN8_API.userDeletion(id), 'DELETE', { reason }, 'Deletion cancelled')}
      />
    </aside>
  );
}

export function Users() {
  const { staff } = useAdminSession();
  const allowed = can(staff?.role, 'usersView');
  const [q, setQ] = useState('');
  const [plan, setPlan] = useState('');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  /** Cursors of the pages before the current one (for Previous). */
  const [stack, setStack] = useState<(string | null)[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [data, setData] = useState<AdminUsersResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminUserDetail | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (query) p.set('q', query);
    if (plan) p.set('plan', plan);
    if (source) p.set('source', source);
    if (status) p.set('status', status);
    if (cursor) p.set('cursor', cursor);
    try {
      setData(await api<AdminUsersResult>(`${ADMIN8_API.users}${p.size ? `?${p}` : ''}`));
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, [query, plan, source, status, cursor]);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  const resetPaging = () => {
    setStack([]);
    setCursor(null);
  };
  const search = (e: FormEvent) => {
    e.preventDefault();
    resetPaging();
    setQuery(q.trim());
  };
  const open = async (id: string) => {
    setOpening(id);
    try {
      setSelected((await api<AdminUserResult>(ADMIN8_API.user(id))).user);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setOpening(null);
    }
  };
  const onUser = (u: AdminUserDetail) => {
    setSelected(u);
    void load();
  };

  const cols: Column<AdminUserRow>[] = [
    {
      key: 'user',
      header: 'User',
      cell: (u) => (
        <button
          type="button"
          className="a8-rowbtn"
          onClick={() => void open(u.id)}
          aria-label={`Open ${nameOf(u)}`}
          aria-current={selected?.id === u.id ? 'true' : undefined}
        >
          <Avatar text={initials(nameOf(u))} seed={u.id} size={28} />
          <span className="a8-rowbtn__text">
            <span className="strong">{nameOf(u)}</span>
            <span className="z-hint z-mono">{u.id.slice(0, 8)}</span>
          </span>
          {opening === u.id && <Spinner size={14} label="Opening" />}
        </button>
      ),
    },
    { key: 'email', header: 'Email', cell: (u) => <span className="z-hint">{u.email}</span> },
    {
      key: 'plan',
      header: 'Plan',
      cell: (u) => (
        <span className="btn-row btn-row--tight">
          <Chip tone={planTone(u.plan)}>{PLAN_LABEL[u.plan]}</Chip>
          {u.planSource === 'admin' && (
            <Chip tone="outline" size="sm">
              Comped
            </Chip>
          )}
        </span>
      ),
    },
    {
      key: 'storage',
      header: 'Storage',
      cell: (u) => <span className="z-mono">{formatBytes(u.storageBytes)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (u) => (
        <Chip tone={STATUS[u.status][1]} dot>
          {STATUS[u.status][0]}
        </Chip>
      ),
    },
    {
      key: 'seen',
      header: 'Last seen',
      cell: (u) => <span className="z-hint">{u.lastSeenAt ? ago(u.lastSeenAt) : '—'}</span>,
    },
  ];

  return (
    <AdminShell
      title="Users"
      sub={
        data
          ? `${n(data.total)} accounts · plan, usage and status, never photo content.`
          : 'Plan, usage and status, never photo content.'
      }
    >
      <PageState
        allowed={allowed}
        who="Owners, Admins, Finance, Safety and Support"
        err={err}
        loading={!data}
        onRetry={() => void load()}
      >
        <form className="a8-filters" onSubmit={search}>
          <Field
            label="Search"
            size="md"
            icon="search"
            value={q}
            placeholder="Exact email, user id, or name"
            onChange={(e) => setQ(e.target.value)}
          />
          <SelectField
            label="Plan"
            value={plan}
            onChange={(e) => {
              setPlan(e.target.value);
              resetPaging();
            }}
            options={[
              { value: '', label: 'All plans' },
              ...(['free', 'pro', 'studio'] as const).map((p) => ({ value: p, label: PLAN_LABEL[p] })),
            ]}
          />
          <SelectField
            label="Plan source"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              resetPaging();
            }}
            options={[
              { value: '', label: 'Any' },
              { value: 'stripe', label: 'Stripe' },
              { value: 'admin', label: 'Comped' },
            ]}
          />
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              resetPaging();
            }}
            options={[
              { value: '', label: 'Any status' },
              ...Object.entries(STATUS).map(([v, [l]]) => ({ value: v, label: l })),
            ]}
          />
          <Button type="submit" icon="search">
            Search
          </Button>
        </form>
        <div className="a8-split">
          <Card className="a8-split__main">
            <CardHead title="Members" />
            {data && (
              <Table
                columns={cols}
                rows={data.page.items}
                rowKey={(u) => u.id}
                caption="Members"
                minWidth={760}
                empty="No members match."
              />
            )}
            <div className="a8-pager">
              <span className="z-hint">Emails are masked until you open a member (opening is logged).</span>
              <span className="btn-row btn-row--tight">
                <IconButton
                  icon="chevL"
                  label="Previous page"
                  disabled={stack.length === 0}
                  onClick={() => {
                    const prev = stack.slice(0, -1);
                    setCursor(stack[stack.length - 1] ?? null);
                    setStack(prev);
                  }}
                />
                <IconButton
                  icon="chevR"
                  label="Next page"
                  disabled={!data?.page.nextCursor}
                  onClick={() => {
                    if (!data?.page.nextCursor) return;
                    setStack([...stack, cursor]);
                    setCursor(data.page.nextCursor);
                  }}
                />
              </span>
            </div>
          </Card>
          {selected && <Drawer user={selected} onClose={() => setSelected(null)} onUser={onUser} />}
        </div>
      </PageState>
    </AdminShell>
  );
}
