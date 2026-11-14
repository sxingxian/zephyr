import { ADMIN_DAILY_CRON, runAdminCron, runAdminDailyCron } from './admin/cron';
import { handleAiBatch } from './ai/consumer';
import { runAiCron } from './ai/cron';
import { app } from './app';
import { BILLING_CRON, runBillingCron } from './billing/cron';
import type { AiMessage, Env } from './env';
import { logError } from './http';
import { runCleanup } from './jobs';

export default {
  fetch: app.fetch,
  /**
   * Cron Triggers (wrangler.jsonc): the library clean-up jobs and Zephyr AI's queue upkeep every 15 minutes;
   * billing's price moves once a day (phase 7). Phase 8: plan limits, override expiries and approved retention
   * batches every 15 minutes; the retention sweep, its notices and the sponsored cards' status daily at 02:20.
   */
  scheduled(controller, env, ctx) {
    if (controller.cron === ADMIN_DAILY_CRON) {
      ctx.waitUntil(
        runAdminDailyCron(env).then(
          () => undefined,
          (err) => logError('cron', 'admin_daily', err),
        ),
      );
      return;
    }
    if (controller.cron === BILLING_CRON) {
      ctx.waitUntil(
        runBillingCron(env).then(
          () => undefined,
          (err) => logError('cron', 'billing', err),
        ),
      );
      return;
    }
    ctx.waitUntil(
      runCleanup(env).then(
        () => undefined,
        (err) => logError('cron', 'cleanup', err),
      ),
    );
    ctx.waitUntil(
      runAiCron(env).then(
        () => undefined,
        (err) => logError('cron', 'ai', err),
      ),
    );
    ctx.waitUntil(
      runAdminCron(env).then(
        () => undefined,
        (err) => logError('cron', 'admin', err),
      ),
    );
  },
  /** The zephyr-ai queue (phase 6): background removal and scene tags. */
  async queue(batch, env) {
    await handleAiBatch(batch as MessageBatch<AiMessage>, env);
  },
} satisfies ExportedHandler<Env, AiMessage>;
