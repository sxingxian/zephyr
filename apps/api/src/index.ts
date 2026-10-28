import { app } from './app';
import type { Env } from './env';
import { logError } from './http';
import { runCleanup } from './jobs';

export default {
  fetch: app.fetch,
  /** Cron Trigger (wrangler.jsonc): the library clean-up jobs, every 15 minutes. */
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runCleanup(env).then(
        () => undefined,
        (err) => logError('cron', 'cleanup', err),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
