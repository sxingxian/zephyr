import { ADMIN_DAILY_CRON, runAdminCron, runAdminDailyCron } from './admin/cron';
import { handleAiBatch } from './ai/consumer';
import { runAiCron } from './ai/cron';
import { app } from './app';
import { BILLING_CRON, runBillingCron } from './billing/cron';
import type { AiMessage, Env, StorageMessage } from './env';
import { logError } from './http';
import { runCleanup } from './jobs';
import { runStorageCron, STORAGE_CRON } from './storage/cron';
import { handleStorageBatch, STORAGE_QUEUE_NAME } from './storage/migrate';

export default {
  fetch: app.fetch,
  /**
   * Cron Triggers (wrangler.jsonc): the library clean-up jobs and Zephyr AI's queue upkeep every 15 minutes;
   * billing's price moves once a day (phase 7). Phase 8: plan limits, override expiries and approved retention
   * batches every 15 minutes; the retention sweep, its notices and the sponsored cards' status daily at 02:20;
   * storage health and migration upkeep every 5 minutes.
   */
  scheduled(controller, env, ctx) {
    if (controller.cron === STORAGE_CRON) {
      ctx.waitUntil(
        runStorageCron(env).then(
          () => undefined,
          (err) => logError('cron', 'storage', err),
        ),
      );
      return;
    }
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
  /** zephyr-ai (phase 6): background removal and scene tags. zephyr-storage (phase 8): migration batches. */
  async queue(batch, env) {
    if (batch.queue === STORAGE_QUEUE_NAME) {
      await handleStorageBatch(batch as MessageBatch<StorageMessage>, env);
      return;
    }
    await handleAiBatch(batch as MessageBatch<AiMessage>, env);
  },
} satisfies ExportedHandler<Env, AiMessage | StorageMessage>;
