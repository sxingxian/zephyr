import { handleAiBatch } from './ai/consumer';
import { runAiCron } from './ai/cron';
import { app } from './app';
import type { AiMessage, Env } from './env';
import { logError } from './http';
import { runCleanup } from './jobs';

export default {
  fetch: app.fetch,
  /** Cron Trigger (wrangler.jsonc): the library clean-up jobs and Zephyr AI's queue upkeep, every 15 minutes. */
  scheduled(_controller, env, ctx) {
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
  },
  /** The zephyr-ai queue (phase 6): background removal and scene tags. */
  async queue(batch, env) {
    await handleAiBatch(batch as MessageBatch<AiMessage>, env);
  },
} satisfies ExportedHandler<Env, AiMessage>;
