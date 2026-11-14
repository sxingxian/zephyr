import {
  ADMIN8_API,
  type AdminStaffResult,
  STAFF_CAN,
  STAFF_INVITE_HOURS,
  type StaffAction,
  type StaffInvite,
  type StaffMember,
  type StaffRole,
} from '@zephyr/shared/client';
import {
  Button,
  Card,
  CardHead,
  Chip,
  type Column,
  Field,
  Icon,
  SelectField,
  Table,
  useToast,
} from '@zephyr/ui';
import { useCallback, useEffect, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { Effects, PageState, ReasonDialog } from '../components/Kit8';
import { AdminShell } from '../components/Shell';
import { can, dateTime, useAdminWrite } from '../lib/admin8';
import { api, errorMessage } from '../lib/api';
import { ROLE_LABEL, useAdminSession } from '../lib/session';

const ROLES: StaffRole[] = ['owner', 'admin', 'finance', 'safety', 'support'];
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MATRIX: [string, StaffAction][] = [
  ['Users: view', 'usersView'],
  ['Users: sign out, grant credits', 'usersAct'],
  ['Override plan', 'planOverride'],
  ['Suspend account', 'suspend'],
  ['Safety queue', 'safetyView'],
  ['Reveal reported photos', 'safetyAct'],
  ['Plan limits', 'limits'],
  ['Ads', 'ads'],
  ['AdSense switch', 'adsense'],
  ['Storage switch', 'storage'],
  ['Retention approvals', 'retention'],
  ['Staff and roles', 'staff'],
  ['Audit log', 'auditView'],
  ['Audit export', 'auditExport'],
  ['System settings', 'settings'],
];

const ago = (iso: string | null) => {
  if (!iso) return '—';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 2
    ? 'now'
    : m < 60
      ? `${m} min ago`
      : m < 48 * 60
        ? `${Math.round(m / 60)} h ago`
        : `${Math.round(m / 1440)} d ago`;
};
const initials = (s: string) =>
  s
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

type Row = { kind: 'member'; m: StaffMember } | { kind: 'invite'; i: StaffInvite };

export function Staff() {
  const { staff } = useAdminSession();
  const allowed = can(staff?.role, 'staff');
  const write = useAdminWrite();
  const toast = useToast();
  const [data, setData] = useState<AdminStaffResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StaffRole>('support');
  const [changing, setChanging] = useState<StaffMember | null>(null);
  const [newRole, setNewRole] = useState<StaffRole>('admin');
  const [removing, setRemoving] = useState<StaffMember | null>(null);
  const [revoking, setRevoking] = useState<StaffInvite | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<AdminStaffResult>(ADMIN8_API.staff));
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);
  const rows: Row[] = data
    ? [
        ...data.staff.map((m) => ({ kind: 'member' as const, m })),
        ...data.invites.map((i) => ({ kind: 'invite' as const, i })),
      ]
    : [];
  const cols: Column<Row>[] = [
    {
      key: 'p',
      header: 'Person',
      cell: (r) => {
        const name = r.kind === 'member' ? r.m.displayName || r.m.email : r.i.email;
        const mail = r.kind === 'member' ? r.m.email : r.i.email;
        const seed = r.kind === 'member' ? r.m.userId : r.i.id;
        return (
          <span className="a8-person">
            <Avatar text={initials(name)} seed={seed} />
            <span className="a8-cell2">
              <strong>
                {name}
                {r.kind === 'member' && r.m.userId === staff?.id && <span className="z-hint"> · You</span>}
              </strong>
              {r.kind === 'member' && r.m.displayName && <span className="z-hint">{mail}</span>}
            </span>
          </span>
        );
      },
    },
    {
      key: 'r',
      header: 'Role',
      cell: (r) =>
        r.kind === 'member' ? (
          <Chip tone={r.m.role === 'owner' ? 'ink' : 'neutral'}>{ROLE_LABEL[r.m.role]}</Chip>
        ) : (
          <span className="btn-row btn-row--tight">
            <Chip tone="neutral">{ROLE_LABEL[r.i.role]}</Chip>
            <Chip tone="outline">Invited</Chip>
          </span>
        ),
    },
    {
      key: 'k',
      header: 'Passkeys',
      cell: (r) => <span className="z-mono">{r.kind === 'member' ? r.m.passkeys : 0}</span>,
    },
    {
      key: 'l',
      header: 'Last active',
      cell: (r) => (
        <span className="z-hint">
          {r.kind === 'member' ? ago(r.m.lastActiveAt) : `Expires ${dateTime(r.i.expiresAt)}`}
        </span>
      ),
    },
    {
      key: 'a',
      header: <span className="z-sr">Actions</span>,
      cell: (r) =>
        r.kind === 'member' ? (
          <span className="btn-row btn-row--tight">
            <Button
              size="sm"
              kind="ghost"
              aria-label={`Change role of ${r.m.displayName || 'staff member'}`}
              onClick={() => {
                setNewRole(r.m.role === 'owner' ? 'admin' : 'owner');
                setChanging(r.m);
              }}
            >
              Role
            </Button>
            {r.m.userId !== staff?.id && (
              <Button
                size="sm"
                kind="ghost"
                aria-label={`Remove ${r.m.displayName || 'staff member'}`}
                onClick={() => setRemoving(r.m)}
              >
                Remove
              </Button>
            )}
          </span>
        ) : (
          <Button
            size="sm"
            kind="ghost"
            aria-label={`Revoke invite for ${r.i.email}`}
            onClick={() => setRevoking(r.i)}
          >
            Revoke
          </Button>
        ),
    },
  ];
  const emailOk = EMAIL_RE.test(email.trim()) && email.trim().length <= 254;
  return (
    <AdminShell
      title="Staff & roles"
      sub="Who can use /admin and what they can do. Staff accounts are separate from member accounts."
    >
      <PageState allowed={allowed} who="Owners" err={err} loading={!data} onRetry={() => void load()}>
        {data && (
          <>
            <Card>
              <CardHead title="Staff">
                <Button
                  size="sm"
                  kind="primary"
                  icon="plus"
                  onClick={() => {
                    setEmail('');
                    setRole('support');
                    setInviting(true);
                  }}
                >
                  Invite staff
                </Button>
              </CardHead>
              <Table
                columns={cols}
                rows={rows}
                rowKey={(r) => (r.kind === 'member' ? r.m.userId : `inv-${r.i.id}`)}
                caption="Staff and invites"
                minWidth={760}
              />
              <p className="z-hint">
                Adding staff, changing a role or removing someone needs your passkey and emails every Owner.
                The last Owner can’t be removed or demoted.
              </p>
            </Card>
            <Card>
              <CardHead title="What each role can do" />
              <div className="z-table-wrap">
                <table className="z-table a8-matrix" style={{ minWidth: 640 }}>
                  <caption className="z-sr">Role permissions</caption>
                  <thead>
                    <tr>
                      <th scope="col">Action</th>
                      {ROLES.map((r) => (
                        <th key={r} scope="col">
                          {ROLE_LABEL[r]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {MATRIX.map(([label, action]) => (
                      <tr key={action}>
                        <th scope="row">{label}</th>
                        {ROLES.map((r) => (
                          <td key={r}>
                            {(STAFF_CAN[action] as readonly StaffRole[]).includes(r) ? (
                              <Icon name="check" size={16} label="Yes" />
                            ) : (
                              <span className="z-sr">No</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <ReasonDialog
              open={inviting}
              title="Invite staff"
              confirmLabel="Send invite with passkey"
              passkey
              canConfirm={emailOk}
              onClose={() => setInviting(false)}
              onConfirm={async (reason) => {
                setData(
                  await write<AdminStaffResult>(ADMIN8_API.staffInvites, 'POST', {
                    email: email.trim().toLowerCase(),
                    role,
                    reason,
                  }),
                );
                toast.show('Invite sent', 'good');
              }}
            >
              <Field
                label="Work email"
                size="md"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <SelectField
                label="Role"
                options={ROLE_OPTIONS}
                value={role}
                onChange={(e) => setRole(e.target.value as StaffRole)}
              />
              <Effects
                items={[
                  ['lock', 'They also need access in Cloudflare Access (the /admin gate) for that email.'],
                  [
                    'passkey',
                    'First sign-in uses an email code that can only add a passkey; after that, passkey only.',
                  ],
                  ['clock', `The invite lasts ${STAFF_INVITE_HOURS} hours.`],
                ]}
              />
            </ReasonDialog>
            <ReasonDialog
              open={changing !== null}
              title={`Change role${changing ? ` · ${changing.displayName || changing.email}` : ''}`}
              confirmLabel="Change role with passkey"
              passkey
              canConfirm={Boolean(changing && newRole !== changing.role)}
              onClose={() => setChanging(null)}
              onConfirm={async (reason) => {
                if (!changing) return;
                setData(
                  await write<AdminStaffResult>(ADMIN8_API.staffMember(changing.userId), 'PATCH', {
                    role: newRole,
                    reason,
                  }),
                );
                toast.show('Role changed', 'good');
              }}
            >
              <SelectField
                label="New role"
                options={ROLE_OPTIONS}
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as StaffRole)}
              />
            </ReasonDialog>
            <ReasonDialog
              open={removing !== null}
              title={`Remove ${removing ? removing.displayName || removing.email : 'staff member'}`}
              intro="Their admin sessions end at once and their passkeys stop working for /admin. Remove their email from Cloudflare Access too."
              confirmLabel="Remove with passkey"
              passkey
              danger
              onClose={() => setRemoving(null)}
              onConfirm={async (reason) => {
                if (!removing) return;
                setData(
                  await write<AdminStaffResult>(ADMIN8_API.staffMember(removing.userId), 'DELETE', {
                    reason,
                  }),
                );
                toast.show('Removed', 'good');
              }}
            />
            <ReasonDialog
              open={revoking !== null}
              title="Revoke invite"
              intro={revoking ? `The link sent to ${revoking.email} stops working.` : undefined}
              confirmLabel="Revoke"
              danger
              withReason={false}
              onClose={() => setRevoking(null)}
              onConfirm={async () => {
                if (!revoking) return;
                setData(await write<AdminStaffResult>(ADMIN8_API.staffInvite(revoking.id), 'DELETE'));
              }}
            />
          </>
        )}
      </PageState>
    </AdminShell>
  );
}
