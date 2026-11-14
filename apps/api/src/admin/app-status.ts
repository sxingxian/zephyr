/**
 * Read-only mode and the maintenance notice (docs/phase-8.md › Settings). `app_status()` returns public data only.
 * Each isolate caches it for 15 seconds, so a switch in Admin reaches every isolate within that time (the isolate
 * that made the change drops its copy at once).
 */
import type { AppStatusResult } from '@zephyr/shared';
import type { Env } from '../env';
import { logError } from '../http';
import { rpc } from '../supabase';

export const APP_STATUS_TTL_MS = 15_000;
export type AppStatus = Omit<AppStatusResult, 'ok'>;

const EMPTY: AppStatus = { readOnly: null, maintenance: null };
let cached: { at: number; value: AppStatus } | null = null;

/** The current status (cached). If the database can't be read, the last known value, else "not read-only". */
export async function appStatus(env: Env): Promise<AppStatus> {
  const now = Date.now();
  if (cached && now - cached.at < APP_STATUS_TTL_MS) return cached.value;
  try {
    const v = await rpc<AppStatus | null>(env, 'app_status', {});
    const value: AppStatus = { readOnly: v?.readOnly ?? null, maintenance: v?.maintenance ?? null };
    cached = { at: now, value };
    return value;
  } catch (err) {
    logError('app_status', 'app_status', err);
    // Fail open for reads of the flag: a database outage already stops writes on its own.
    return cached?.value ?? EMPTY;
  }
}

export const isReadOnly = async (env: Env) => (await appStatus(env)).readOnly?.on === true;

/** After a change in Admin, and for tests. */
export function resetAppStatusCache() {
  cached = null;
}
