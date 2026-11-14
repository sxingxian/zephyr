import {
  ADMIN8_API,
  type AdminAuditEntry,
  type AdminAuditResult,
  AUDIT_KINDS,
  type AuditKind,
} from '@zephyr/shared/client';
import { Button, Card, CardHead, type Column, Field, Note, SelectField, Table, useToast } from '@zephyr/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { PageState } from '../components/Kit8';
import { AdminShell } from '../components/Shell';
import { can, downloadBlob, shortDate, timeOnly } from '../lib/admin8';
import { api, apiRaw, errorMessage } from '../lib/api';
import { ROLE_LABEL, useAdminSession } from '../lib/session';

const KIND_LABEL: Record<AuditKind, string> = {
  users: 'Users',
  safety: 'Safety',
  billing: 'Billing',
  limits: 'Plan limits',
  storage: 'Storage',
  staff: 'Staff',
  ads: 'Ads',
  settings: 'Settings',
  ai: 'Zephyr AI',
  signups: 'Sign-ups',
};
type When = 'all' | 'today' | '7d' | '30d' | 'custom';
export interface AuditFilters {
  actor: string;
  kind: AuditKind | '';
  target: string;
  when: When;
  from: string; // yyyy-mm-dd (custom)
  to: string;
}
const START: AuditFilters = { actor: '', kind: '', target: '', when: '7d', from: '', to: '' };

/** Query string for the audit list and the CSV export (same filters). */
export function auditQuery(f: AuditFilters, now = new Date(), cursor?: string): string {
  const p = new URLSearchParams();
  if (f.actor) p.set('actor', f.actor);
  if (f.kind) p.set('kind', f.kind);
  if (f.target.trim()) p.set('target', f.target.trim().slice(0, 120));
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (f.when === 'today') p.set('from', day(now).toISOString());
  if (f.when === '7d') p.set('from', new Date(now.getTime() - 7 * 86_400_000).toISOString());
  if (f.when === '30d') p.set('from', new Date(now.getTime() - 30 * 86_400_000).toISOString());
  if (f.when === 'custom') {
    if (f.from) p.set('from', new Date(`${f.from}T00:00:00`).toISOString());
    if (f.to) p.set('to', new Date(`${f.to}T23:59:59.999`).toISOString());
  }
  if (cursor) p.set('cursor', cursor);
  const s = p.toString();
  return s ? `?${s}` : '';
}

const initials = (s: string) =>
  s
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

export function Audit() {
  const { staff } = useAdminSession();
  const allowed = can(staff?.role, 'auditView');
  const canExport = can(staff?.role, 'auditExport');
  const toast = useToast();
  const [f, setF] = useState<AuditFilters>(START);
  const [applied, setApplied] = useState<AuditFilters>(START);
  const [stack, setStack] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState<AdminAuditResult['page'] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [actors, setActors] = useState<Map<string, string>>(new Map());
  const cursor = stack[stack.length - 1];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<AdminAuditResult>(`${ADMIN8_API.audit}${auditQuery(applied, new Date(), cursor)}`);
      setPage(r.page);
      setErr(null);
      // Remember who appeared, to offer them in the "Who" filter.
      setActors((m) => {
        const x = new Map(m);
        for (const e of r.page.items) if (e.actor.id) x.set(e.actor.id, e.actor.name);
        return x;
      });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [applied, cursor]);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  const set = (patch: Partial<AuditFilters>) => setF((x) => ({ ...x, ...patch }));
  const apply = () => {
    setApplied(f);
    setStack([undefined]);
  };
  const customBad = f.when === 'custom' && Boolean(f.from && f.to && f.from > f.to);
  const exportCsv = async () => {
    setExporting(true);
    setExportErr(null);
    try {
      const res = await apiRaw(`${ADMIN8_API.auditExport}${auditQuery(applied)}`);
      const blob = await res.blob();
      downloadBlob(
        new Blob([blob], { type: 'text/csv' }),
        `zephyr-audit-${new Date().toISOString().slice(0, 10)}.csv`,
      );
      toast.show('Export downloaded (logged)', 'good');
    } catch (e) {
      setExportErr(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };
  const actorOptions = useMemo(
    () => [{ value: '', label: 'Anyone' }, ...[...actors].map(([value, label]) => ({ value, label }))],
    [actors],
  );
  const cols: Column<AdminAuditEntry>[] = [
    {
      key: 't',
      header: 'Time',
      cell: (e) => (
        <span className="a8-cell2">
          <span className="z-mono">{timeOnly(e.at)}</span>
          <span className="z-hint">{shortDate(e.at)}</span>
        </span>
      ),
    },
    {
      key: 'w',
      header: 'Who',
      cell: (e) => (
        <span className="a8-person">
          <Avatar text={initials(e.actor.name)} seed={e.actor.id ?? 'system'} size={26} />
          <span className="a8-cell2">
            <strong>{e.actor.name}</strong>
            <span className="z-hint">{e.actor.role === 'system' ? 'System' : ROLE_LABEL[e.actor.role]}</span>
          </span>
        </span>
      ),
    },
    { key: 'a', header: 'Action', cell: (e) => e.action },
    { key: 'g', header: 'Target', cell: (e) => <span className="z-mono">{e.target ?? '—'}</span> },
    { key: 'r', header: 'Reason', cell: (e) => <span className="a8-reason">{e.reason ?? '—'}</span> },
  ];
  return (
    <AdminShell title="Audit log" sub="Every staff action and every automatic safety or storage action.">
      <PageState
        allowed={allowed}
        who="Owners, Admins, Finance and Safety"
        err={err}
        loading={!page && !err}
        onRetry={() => void load()}
      >
        <Card>
          <form
            className="a8-filters"
            onSubmit={(e) => {
              e.preventDefault();
              if (!customBad) apply();
            }}
          >
            <SelectField
              label="Who"
              options={actorOptions}
              value={f.actor}
              onChange={(e) => set({ actor: e.target.value })}
            />
            <SelectField
              label="What"
              options={[
                { value: '', label: 'Everything' },
                ...AUDIT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })),
              ]}
              value={f.kind}
              onChange={(e) => set({ kind: e.target.value as AuditKind | '' })}
            />
            <SelectField
              label="When"
              options={[
                { value: 'today', label: 'Today' },
                { value: '7d', label: 'Last 7 days' },
                { value: '30d', label: 'Last 30 days' },
                { value: 'all', label: 'Any time' },
                { value: 'custom', label: 'Custom…' },
              ]}
              value={f.when}
              onChange={(e) => set({ when: e.target.value as When })}
            />
            {f.when === 'custom' && (
              <>
                <Field
                  label="From"
                  size="md"
                  type="date"
                  value={f.from}
                  onChange={(e) => set({ from: e.target.value })}
                />
                <Field
                  label="To"
                  size="md"
                  type="date"
                  value={f.to}
                  onChange={(e) => set({ to: e.target.value })}
                  error={customBad ? 'After the start date.' : null}
                />
              </>
            )}
            <Field
              label="Target"
              size="md"
              mono
              maxLength={120}
              placeholder="usr_…, rep_…"
              value={f.target}
              onChange={(e) => set({ target: e.target.value })}
            />
            <span className="btn-row a8-filters__go">
              <Button type="submit" kind="primary" icon="filter" disabled={customBad}>
                Apply
              </Button>
              {canExport && (
                <Button icon="download" busy={exporting} onClick={exportCsv}>
                  Export CSV
                </Button>
              )}
            </span>
          </form>
          {exportErr && (
            <Note tone="bad" icon="alert" role="alert">
              {exportErr}
            </Note>
          )}
        </Card>
        {page && (
          <Card>
            <CardHead title="Entries">{loading && <span className="z-hint">Loading…</span>}</CardHead>
            <Table
              columns={cols}
              rows={page.items}
              rowKey={(e) => e.id}
              caption="Audit log entries"
              minWidth={860}
              empty="Nothing matches these filters."
            />
            <div className="btn-row a8-pager">
              <Button
                size="sm"
                disabled={stack.length <= 1 || loading}
                onClick={() => setStack((s) => s.slice(0, -1))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                disabled={!page.nextCursor || loading}
                onClick={() => {
                  const next = page.nextCursor;
                  if (next) setStack((s) => [...s, next]);
                }}
              >
                Next
              </Button>
            </div>
            <p className="z-hint">
              The audit log is append-only: nobody, including Owners, can edit or delete entries. Kept
              indefinitely. It never contains photos, file names, passcodes, tokens or full emails.
            </p>
          </Card>
        )}
      </PageState>
    </AdminShell>
  );
}
