import type { AiSettings } from '@zephyr/shared';
import type { Env } from '../env';
import { rpc } from '../supabase';

/** Admin › Zephyr AI settings, cached per isolate for 30 seconds (a change reaches every Worker within ~30 s). */
export const SETTINGS_TTL_MS = 30_000;
let cache: { at: number; value: AiSettings } | null = null;

export async function aiSettings(env: Env, now = Date.now()): Promise<AiSettings> {
  if (cache && now - cache.at < SETTINGS_TTL_MS) return cache.value;
  const value = await rpc<AiSettings>(env, 'ai_settings_get');
  if (!value || typeof value !== 'object') throw new Error('ai settings missing');
  cache = { at: now, value };
  return value;
}

/** After an admin change (this isolate sees it at once) and in tests. */
export function clearAiSettingsCache() {
  cache = null;
}
