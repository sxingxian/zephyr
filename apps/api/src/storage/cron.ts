/** The 5-minute storage cron (wrangler.jsonc): write-store health check, then migration upkeep. */
import type { Env } from '../env';
import { runHealthCron } from './health';
import { runMigrationCron } from './migrate';

export const STORAGE_CRON = '*/5 * * * *';

export async function runStorageCron(env: Env) {
  const health = await runHealthCron(env);
  const migration = await runMigrationCron(env);
  return { health, migration };
}
