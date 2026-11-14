import { ROLE_CAN, TEAM_NAME_MAX, type Team, type TeamMember, type TeamRole } from '@zephyr/shared/client';
import { Button, Chip, Field, Icon, Note, Spinner, useToast } from '@zephyr/ui';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { Avatar } from '../components/Avatar';
import { ConfirmDialog } from '../components/ai/AiBits';
import { SettingsNav } from '../components/SettingsNav';
import { Shell } from '../components/Shell';
import { ApiFailure, errorMessage } from '../lib/api';
import {
  fetchTeam,
  inviteTeammate,
  leaveTeam,
  longDate,
  removeTeammate,
  renameTeam,
  resendTeamInvite,
  revokeTeamInvite,
  setTeammateRole,
} from '../lib/billing';
import { setLibraries, switchLibrary, useActiveLibrary, useLibraries } from '../lib/libraryContext';
import { initials, useSession } from '../lib/session';
import { Meter } from './Billing';
import '../billing.css';

const ROLE_NAME = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' } as const;
const ROLE_TONE = { owner: 'ink', editor: 'acc', viewer: 'neutral' } as const;

/** What each role can do: the same table the API enforces (ROLE_CAN). */
const ROLE_ROWS: [string, keyof typeof ROLE_CAN][] = [
  ['View and download photos', 'download'],
  ['Upload, edit, use Zephyr AI and credits', 'upload'],
  ['Create and manage shared galleries', 'galleries'],
  ['Move photos to Trash', 'trash'],
  ['Empty Trash, delete permanently', 'purge'],
  ['Face grouping on or off', 'aiSettings'],
  ['Seats, plan and billing', 'billing'],
];
export function RolesTable() {
  return (
    <section className="z-card" aria-labelledby="roles-h">
      <h2 id="roles-h" className="bl-h3">
        What each role can do
      </h2>
      <div className="bl-table-wrap">
        <table className="bl-roles">
          <thead>
            <tr>
              <td />
              {(['owner', 'editor', 'viewer'] as const).map((r) => (
                <th key={r} scope="col">
                  {ROLE_NAME[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROLE_ROWS.map(([label, action]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {(['owner', 'editor', 'viewer'] as const).map((r) => {
                  const yes = (ROLE_CAN[action] as readonly string[]).includes(r);
                  return (
                    <td key={r} className={yes ? 'is-yes' : 'is-no'}>
                      <Icon name={yes ? 'check' : 'x'} size={16} />
                      <span className="z-sr">{yes ? 'Yes' : 'No'}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RoleSelect({
  value,
  label,
  onChange,
  disabled,
  tall,
}: {
  value: TeamRole;
  label: string;
  onChange: (r: TeamRole) => void;
  disabled?: boolean;
  tall?: boolean;
}) {
  return (
    <select
      className={`z-input z-select bl-role-select${tall ? ' bl-role-select--tall' : ''}`}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as TeamRole)}
    >
      <option value="editor">Editor</option>
      <option value="viewer">Viewer</option>
    </select>
  );
}

/** Teams the member belongs to (other people's Studio libraries), each with Leave. */
function TeamsImIn() {
  const libs = useLibraries();
  const lib = useActiveLibrary();
  const toast = useToast();
  const [leaving, setLeaving] = useState<{ ownerId: string; name: string } | null>(null);
  const others = (libs ?? []).slice(1);
  if (!others.length) return null;
  return (
    <section className="z-card" aria-labelledby="teams-in-h">
      <h2 id="teams-in-h" className="bl-h3">
        Teams you’re in
      </h2>
      <div>
        {others.map((l) => (
          <div key={l.ownerId} className="bl-member">
            <span
              className="libsw__mono libsw__mono--team"
              style={{ width: 38, height: 38 }}
              aria-hidden="true"
            >
              {l.initials.slice(0, 2)}
            </span>
            <div className="bl-member__text">
              <span className="bl-member__name">{l.name}</span>
              <span className="z-muted">
                {ROLE_NAME[l.role]}
                {l.state === 'read_only' ? ' · read-only' : ''}
              </span>
            </div>
            {lib.ownerId !== l.ownerId && (
              <Button size="sm" onClick={() => void switchLibrary(l.ownerId)}>
                Open
              </Button>
            )}
            <Button size="sm" kind="ghost" onClick={() => setLeaving({ ownerId: l.ownerId, name: l.name })}>
              Leave
            </Button>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={leaving !== null}
        title={`Leave ${leaving?.name ?? 'this team'}?`}
        confirm="Leave team"
        danger
        onClose={() => setLeaving(null)}
        onConfirm={async () => {
          if (!leaving) return;
          const r = await leaveTeam(leaving.ownerId);
          setLibraries(r.libraries);
          toast.show(`You left ${leaving.name}.`, 'good');
          // Leaving the library open in this tab: back to the member's own.
          if (lib.ownerId === leaving.ownerId && r.libraries[0]) void switchLibrary(r.libraries[0].ownerId);
        }}
      >
        <p>You’ll lose access to its photos straight away. Your own library isn’t affected.</p>
      </ConfirmDialog>
    </section>
  );
}

function Upsell() {
  return (
    <section className="z-card bl-upsell">
      <span className="bl-tile">
        <Icon name="people" size={20} />
      </span>
      <div className="bl-row-card__text">
        <h2 className="bl-h3">Teams come with Studio</h2>
        <span className="z-muted">
          Studio includes 3 seats: you and 2 teammates share your library as Editors or Viewers. Each teammate
          keeps their own library too.
        </span>
      </div>
      <Link to="/plans" className="z-btn z-btn--primary z-btn--sm">
        <span>See plans</span>
      </Link>
    </section>
  );
}

function MemberRow({
  m,
  self,
  busy,
  onRole,
  onRemove,
}: {
  m: TeamMember;
  self: boolean;
  busy: boolean;
  onRole: (r: TeamRole) => void;
  onRemove: () => void;
}) {
  const name = m.displayName || m.email.split('@')[0] || m.email;
  const sub =
    m.role === 'owner'
      ? 'billing, seats, permanent deletes'
      : m.suspended
        ? 'no access · over your seats'
        : `joined ${longDate(m.addedAt)}`;
  return (
    <div className="bl-member">
      <Avatar text={initials({ displayName: m.displayName, email: m.email })} seed={m.userId} size={38} />
      <div className="bl-member__text">
        <span className="bl-member__name">
          {name}
          {self ? ' (you)' : ''}
        </span>
        <span className="z-muted">
          {m.email} · {sub}
        </span>
      </div>
      {m.role === 'owner' ? (
        <Chip tone="ink">Owner</Chip>
      ) : (
        <div className="bl-member__ctl">
          {m.suspended && (
            <Chip tone="warn" dot>
              No access
            </Chip>
          )}
          <RoleSelect value={m.role} label={`Role for ${name}`} disabled={busy} onChange={onRole} />
          <Button
            size="sm"
            kind="ghost"
            disabled={busy}
            onClick={onRemove}
            aria-label={`Remove ${name} from the team`}
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}

/** The owner's team (own library, Studio). */
function OwnerTeam() {
  const { user } = useSession();
  const toast = useToast();
  const [team, setTeam] = useState<Team | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('editor');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const formId = useId();

  useEffect(() => {
    const c = new AbortController();
    fetchTeam(c.signal)
      .then((r) => setTeam(r.team))
      .catch((e) => (e as Error).name !== 'AbortError' && setError(errorMessage(e)));
    return () => c.abort();
  }, []);

  const run = async (key: string, fn: () => Promise<{ team: Team }>, ok: string) => {
    setBusy(key);
    try {
      setTeam((await fn()).team);
      toast.show(ok, 'good');
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setInviteError(null);
    const to = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      setInviteError('Enter an email address.');
      return;
    }
    setBusy('invite');
    try {
      setTeam((await inviteTeammate({ email: to, role })).team);
      setEmail('');
      toast.show(`Invite sent to ${to}.`, 'good');
    } catch (err) {
      setInviteError(
        err instanceof ApiFailure && err.code === 'already_member'
          ? 'That person is already in your team or has an invite.'
          : err instanceof ApiFailure && err.code === 'limit_reached'
            ? 'All seats are in use. Remove someone or revoke an invite first.'
            : errorMessage(err),
      );
    } finally {
      setBusy(null);
    }
  };

  if (error)
    return (
      <Note tone="bad" icon="alert" role="alert">
        {error}
      </Note>
    );
  if (!team) return <Spinner size={20} label="Loading your team" />;
  if (!team.available)
    return (
      <>
        <Upsell />
        <TeamsImIn />
        <RolesTable />
      </>
    );
  const full = team.used >= team.seats;
  return (
    <>
      <section className="z-card">
        <div className="bl-plan-head">
          <div className="bl-col">
            {renaming === null ? (
              <span className="bl-plan-head__title">
                <h2 className="bl-h2">{team.name}</h2>
                <Button size="sm" kind="ghost" icon="settings" onClick={() => setRenaming(team.name)}>
                  Rename
                </Button>
              </span>
            ) : (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = renaming.trim();
                  if (!name) return;
                  void run('rename', () => renameTeam(name), 'Team renamed.').then(() => setRenaming(null));
                }}
              >
                <Field
                  label="Team name"
                  value={renaming}
                  maxLength={TEAM_NAME_MAX}
                  onChange={(e) => setRenaming(e.target.value)}
                  size="md"
                />
                <Button type="submit" kind="primary" busy={busy === 'rename'}>
                  Save
                </Button>
                <Button kind="ghost" onClick={() => setRenaming(null)}>
                  Cancel
                </Button>
              </form>
            )}
            <span className="z-muted">
              Your Studio library, shared with your team. Teammates switch into it from the top of the
              sidebar.
            </span>
          </div>
          <Chip tone="ink">Studio · {team.seats} seats</Chip>
        </div>
        <Meter
          label="Seats"
          value={`${team.used} of ${team.seats} used`}
          pct={(team.used / team.seats) * 100}
        />
        <div>
          {team.members.map((m) => (
            <MemberRow
              key={m.userId}
              m={m}
              self={m.userId === user?.id}
              busy={busy !== null}
              onRole={(r) =>
                void run(`role:${m.userId}`, () => setTeammateRole(m.userId, { role: r }), 'Role updated.')
              }
              onRemove={() => setRemoving(m)}
            />
          ))}
          {team.invites.map((i) => (
            <div key={i.id} className="bl-member">
              <span className="bl-member__pending" aria-hidden="true">
                <Icon name="mail" size={17} />
              </span>
              <div className="bl-member__text">
                <span className="bl-member__name">{i.email}</span>
                <span className="z-muted">
                  {ROLE_NAME[i.role]} · invited {longDate(i.createdAt)} · waiting
                </span>
              </div>
              <div className="bl-member__ctl">
                <Chip tone="warn" dot>
                  Invite sent
                </Chip>
                <Button
                  size="sm"
                  kind="ghost"
                  busy={busy === `resend:${i.id}`}
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`resend:${i.id}`, () => resendTeamInvite(i.id), `Invite resent to ${i.email}.`)
                  }
                >
                  Resend
                </Button>
                <Button
                  size="sm"
                  kind="ghost"
                  busy={busy === `revoke:${i.id}`}
                  disabled={busy !== null}
                  onClick={() => void run(`revoke:${i.id}`, () => revokeTeamInvite(i.id), 'Invite revoked.')}
                >
                  Revoke
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="z-card" aria-labelledby={`${formId}-h`}>
        <h2 id={`${formId}-h`} className="bl-h3">
          Invite a teammate
        </h2>
        <form className="bl-invite" onSubmit={invite} noValidate>
          <Field
            label="Email"
            type="email"
            autoComplete="off"
            placeholder="name@studio.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={inviteError}
            disabled={full}
            size="lg"
          />
          <div className="bl-invite__role">
            <label htmlFor={`${formId}-role`}>Role</label>
            <select
              id={`${formId}-role`}
              className="z-input z-select bl-role-select bl-role-select--tall"
              value={role}
              disabled={full}
              onChange={(e) => setRole(e.target.value as TeamRole)}
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          <Button
            type="submit"
            kind="primary"
            size="lg"
            busy={busy === 'invite'}
            disabled={full || !email.trim()}
          >
            Send invite
          </Button>
        </form>
        <span className="z-hint">
          {full
            ? `All ${team.seats} seats are in use. Remove someone or revoke an invite to add another.`
            : 'Invites last 7 days and only work for the email you enter.'}
        </span>
      </section>
      <RolesTable />
      <TeamsImIn />
      <Note tone="neutral" icon="info">
        Uploads and cloud credits used by teammates count toward {team.name}’s storage and credits.
      </Note>
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.displayName || removing?.email || 'this teammate'}?`}
        confirm="Remove from team"
        danger
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          setTeam((await removeTeammate(removing.userId)).team);
          toast.show('Removed from the team.', 'good');
        }}
      >
        <p>They lose access to your library straight away. Edits they made stay in your library.</p>
      </ConfirmDialog>
    </>
  );
}

/** A teammate looking at Team while working in someone else's library. */
function MemberView() {
  const lib = useActiveLibrary();
  const libs = useLibraries();
  const own = libs?.[0];
  const name = lib.summary?.name ?? 'This team';
  return (
    <>
      <section className="z-card">
        <div className="bl-col">
          <span className="bl-plan-head__title">
            <h2 className="bl-h2">{name}</h2>
            <Chip tone={ROLE_TONE[lib.role]}>{ROLE_NAME[lib.role]}</Chip>
          </span>
          <span className="z-muted">
            You’re a{lib.role === 'editor' ? 'n' : ''} {ROLE_NAME[lib.role]} in this team library. Its owner
            manages seats and roles.
          </span>
        </div>
        {own && (
          <div className="bl-actions">
            <Button size="sm" onClick={() => void switchLibrary(own.ownerId)}>
              Switch to your library
            </Button>
          </div>
        )}
      </section>
      <TeamsImIn />
      <RolesTable />
    </>
  );
}

/** Settings › Team (phase 7). */
export function TeamPage() {
  const lib = useActiveLibrary();
  return (
    <Shell title="Settings">
      <div className="settings">
        <SettingsNav />
        <div className="settings__body">{lib.self ? <OwnerTeam /> : <MemberView />}</div>
      </div>
    </Shell>
  );
}
