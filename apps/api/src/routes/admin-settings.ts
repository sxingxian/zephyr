/**
 * /admin/api/v1/settings (docs/phase-8.md › Settings): read-only mode, the maintenance notice, and a read-only view
 * of the access and alert set-up.
 *
 *   GET   /settings    settings
 *   PATCH /settings    settings (read-only mode and the notice are operational switches, not high-risk changes)
 */
import { type AdminSettings, type AdminSettingsResult, adminSettingsPatchSchema } from '@zephyr/shared';
import { resetAppStatusCache } from '../admin/app-status';
import { fail, readBody } from '../http';
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

export const STAFF_IDLE_MINUTES = 30;

async function settingsView(c: Ctx) {
  const s = await rpc<AdminSettings>(c.env, 'admin_settings', { p_staff: staffId(c) });
  if (isDbError(s)) return dbError(c, s);
  const env = c.env;
  return c.json({
    ok: true,
    ...s,
    // What only the API knows: whether Access verification is configured, and the safety alert address.
    access: {
      ...s.access,
      accessConfigured: Boolean(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD),
      idleMinutes: STAFF_IDLE_MINUTES,
    },
    alerts: { ...s.alerts, safetyAlertConfigured: Boolean(env.SAFETY_ALERT_EMAIL) },
  } satisfies AdminSettingsResult);
}

export function registerAdminSettingsRoutes(router: AdminRouter, requireStaff: RequireStaff) {
  router.use('/v1/settings/*', requireStaff(), adminWriteLimit);

  router.get('/v1/settings', can('settings'), async (c) => {
    try {
      return await settingsView(c);
    } catch (err) {
      return serverError(c, 'admin_settings', err);
    }
  });

  router.patch('/v1/settings', can('settings'), async (c) => {
    const body = await readBody(c, adminSettingsPatchSchema);
    if (!body) return c.json(fail('invalid'), 400);
    const { reason, ...patch } = body;
    if (!patch.readOnly && !patch.maintenance) return c.json(fail('invalid'), 400);
    const m = patch.maintenance;
    if (m?.startsAt && m.endsAt && Date.parse(m.startsAt) >= Date.parse(m.endsAt)) {
      return c.json(fail('invalid'), 400);
    }
    try {
      const out = await rpc<unknown>(c.env, 'admin_settings_set', {
        p_staff: staffId(c),
        p_patch: patch,
        p_reason: reason,
      });
      if (isDbError(out)) return dbError(c, out);
      resetAppStatusCache();
      return await settingsView(c);
    } catch (err) {
      return serverError(c, 'admin_settings_set', err);
    }
  });
}
