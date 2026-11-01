import {
  type AdminAiJobsResult,
  type AdminAiSettingsResult,
  type AiSettings,
  aiSettingsPatchSchema,
  isRiskLowering,
} from '@zephyr/shared';
import type { Hono, MiddlewareHandler } from 'hono';
import { clearAiSettingsCache } from '../ai/settings';
import { aiSettingsChangedEmail } from '../email/ai-templates';
import { sendEmail } from '../email/resend';
import { background, fail, logError, readBody } from '../http';
import { rpc, UpstreamError } from '../supabase';
import type { HonoEnv } from '../types';

type RequireStaff = (opts?: { allowEnrol?: boolean; write?: boolean }) => MiddlewareHandler<HonoEnv>;

/** Labels for the Owner email (field names only, never values). */
const FIELD_LABELS: Record<string, string> = {
  enabled: 'Zephyr AI for everyone',
  cloudPaused: 'cloud pause',
  features: 'features',
  bgProvider: 'background-removal provider',
  bgFallback: 'fallback provider',
  runwareModel: 'Runware model',
  falModel: 'fal model',
  sceneModel: 'scene-tag model',
  bgCreditsPerPhoto: 'credits per photo',
  costs: 'cost estimates',
  caps: 'daily caps',
  alerts: 'alerts',
  atCap: 'action at the cap',
  alertTo: 'alert recipients',
  memberJobsPerMinute: 'jobs per member per minute',
};

/**
 * /admin/api/v1/ai/*: Admin › Zephyr AI and AI jobs (docs/phase-6.md, Admin). Any staff role may read;
 * Owners and Admins may change settings. A change that can raise risk or spend (see isRiskLowering) needs a
 * passkey sign-in in the last 10 minutes and emails every Owner; one that can only lower it saves at once.
 */
export function registerAdminAiRoutes(router: Hono<HonoEnv>, requireStaff: RequireStaff) {
  router.get('/v1/ai/settings', requireStaff(), async (c) => {
    try {
      const out = await rpc<Omit<AdminAiSettingsResult, 'ok'> | null>(c.env, 'admin_ai_settings', {
        p_actor: c.get('staff').id,
      });
      if (!out) return c.json(fail('forbidden'), 403);
      return c.json({ ok: true, settings: out.settings, spend: out.spend } satisfies AdminAiSettingsResult);
    } catch (err) {
      logError(c.get('requestId'), 'admin_ai_settings', err);
      return c.json(fail('server'), 500);
    }
  });

  router.patch('/v1/ai/settings', requireStaff({ write: true }), async (c) => {
    const patch = await readBody(c, aiSettingsPatchSchema);
    if (!patch) return c.json(fail('invalid'), 400);
    const staff = c.get('staff');
    try {
      const current = await rpc<Omit<AdminAiSettingsResult, 'ok'> | null>(c.env, 'admin_ai_settings', {
        p_actor: staff.id,
      });
      if (!current) return c.json(fail('forbidden'), 403);
      const lowering = isRiskLowering(current.settings, patch);
      if (!lowering && !staff.recentPasskey) return c.json(fail('reauth_required'), 403);
      const out = await rpc<
        | (Omit<AdminAiSettingsResult, 'ok'> & { before: AiSettings; changes: Record<string, unknown> })
        | { error: string }
      >(c.env, 'admin_ai_settings_update', { p_actor: staff.id, p_patch: patch });
      if ('error' in out)
        return c.json(
          fail(out.error === 'forbidden' ? 'forbidden' : 'invalid'),
          out.error === 'forbidden' ? 403 : 400,
        );
      clearAiSettingsCache();
      const fields = Object.keys(out.changes ?? {});
      if (!lowering && fields.length) {
        const actor = staff.displayName?.trim() || staff.email;
        await background(c, async () => {
          try {
            const owners = await rpc<string[]>(c.env, 'ai_alert_recipients', { p_who: 'owners' });
            const mail = aiSettingsChangedEmail({
              actor,
              fields: fields.map((f) => FIELD_LABELS[f] ?? f),
              adminUrl: `${(c.env.ADMIN_ORIGINS.split(',')[0] ?? '').trim()}/admin/ai`,
            });
            for (const to of owners) await sendEmail(c.env, { to, ...mail });
          } catch (err) {
            logError(c.get('requestId'), 'admin_ai_notify', err);
          }
        });
      }
      return c.json({ ok: true, settings: out.settings, spend: out.spend } satisfies AdminAiSettingsResult);
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 400) return c.json(fail('invalid'), 400);
      logError(c.get('requestId'), 'admin_ai_settings_update', err);
      return c.json(fail('server'), 500);
    }
  });

  router.get('/v1/ai/jobs', requireStaff(), async (c) => {
    try {
      const out = await rpc<Omit<AdminAiJobsResult, 'ok'> | null>(c.env, 'admin_ai_jobs', {
        p_actor: c.get('staff').id,
      });
      if (!out) return c.json(fail('forbidden'), 403);
      return c.json({
        ok: true,
        counts: out.counts,
        latency: out.latency ?? [],
        providers: out.providers ?? [],
        failures: out.failures ?? [],
        spend: out.spend,
      } satisfies AdminAiJobsResult);
    } catch (err) {
      logError(c.get('requestId'), 'admin_ai_jobs', err);
      return c.json(fail('server'), 500);
    }
  });
}
