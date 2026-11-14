/**
 * /admin/api/v1/audit/* (docs/phase-8.md › Audit). The log is append-only (a database trigger) and kept
 * indefinitely. Exports are at most 50,000 rows and are themselves logged by the database.
 *
 *   GET /audit?actor=&kind=&target=&from=&to=&cursor=     auditView
 *   GET /audit/export?(same filters)                      auditExport → text/csv (ADMIN_LIMITER counts it)
 */
import { type AdminAuditEntry, type AdminAuditResult, adminAuditQuerySchema } from '@zephyr/shared';
import { fail, rateLimited } from '../http';
import { rpc } from '../supabase';
import {
  type AdminRouter,
  adminWriteLimit,
  type Ctx,
  can,
  dbError,
  isDbError,
  type RequireStaff,
  serverError,
  staffId,
} from './admin-common';

export const AUDIT_EXPORT_MAX = 50_000;

/**
 * One CSV cell. Spreadsheet apps run cells that start with = + - @ (or a tab/CR before one) as formulas, so those
 * get a leading apostrophe (OWASP "CSV injection"); then the usual RFC 4180 quoting.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function auditCsv(rows: AdminAuditEntry[]): string {
  const head = ['id', 'at', 'actor_id', 'actor_name', 'actor_role', 'action', 'target', 'reason'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push(
      [r.id, r.at, r.actor?.id, r.actor?.name, r.actor?.role, r.action, r.target, r.reason]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

function filters(c: Ctx) {
  const q = adminAuditQuerySchema.safeParse(c.req.query());
  if (!q.success) return null;
  const f = q.data;
  if (f.from && f.to && Date.parse(f.from) > Date.parse(f.to)) return null;
  return {
    cursor: f.cursor ?? null,
    args: {
      p_actor: f.actor ?? null,
      p_kind: f.kind ?? null,
      p_target: f.target || null,
      p_from: f.from ?? null,
      p_to: f.to ?? null,
    },
  };
}

export function registerAdminAuditRoutes(router: AdminRouter, requireStaff: RequireStaff) {
  router.use('/v1/audit/*', requireStaff(), adminWriteLimit);

  router.get('/v1/audit', can('auditView'), async (c) => {
    const f = filters(c);
    if (!f) return c.json(fail('invalid'), 400);
    try {
      const page = await rpc<AdminAuditResult['page']>(c.env, 'admin_audit', {
        p_staff: staffId(c),
        ...f.args,
        p_cursor: f.cursor,
      });
      if (isDbError(page)) return dbError(c, page);
      return c.json({ ok: true, page } satisfies AdminAuditResult);
    } catch (err) {
      return serverError(c, 'admin_audit', err);
    }
  });

  router.get('/v1/audit/export', can('auditExport'), async (c) => {
    const f = filters(c);
    if (!f) return c.json(fail('invalid'), 400);
    if (!(await c.env.ADMIN_LIMITER.limit({ key: `admin:${staffId(c)}` })).success) return rateLimited(c, 60);
    try {
      const rows = await rpc<AdminAuditEntry[]>(c.env, 'admin_audit_export', {
        p_staff: staffId(c),
        ...f.args,
      });
      if (isDbError(rows)) return dbError(c, rows);
      const csv = auditCsv((rows ?? []).slice(0, AUDIT_EXPORT_MAX));
      const day = new Date().toISOString().slice(0, 10);
      return c.body(csv, 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="zephyr-audit-${day}.csv"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
    } catch (err) {
      return serverError(c, 'admin_audit_export', err);
    }
  });
}
